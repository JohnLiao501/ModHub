/** ModHub 时间点还原：真实包体快照、事务恢复与加载期救援。 */
(function () {
    'use strict';
    if (window.modHubRestore) return;

    const MODHUB_POINTS_KEY = 'modhub_restore_points_v1';
    const MODHUB_BLOB_PREFIX = 'modhub_restore_blob_v1:';
    const MODHUB_JOURNAL_KEY = 'modhub_restore_journal_v1';
    const MODHUB_SUCCESS_KEY = 'modhub_restore_success_v1';
    const MODHUB_STARTUP_KEY = 'modhub_restore_startup_v1';
    const MODHUB_CONFIG_PREFIX = 'modhub_restore_config_v1:';
    const MODHUB_SETTINGS = ['modhub_sideload_mod_order', 'modhub_auto_enable_sideload_beauty'];
    const MODHUB_POINT_LIMITS = [5, 10, 20, 50];
    let policyConfig = { autoCreate: true, maxPoints: 20 };
    let policyStartup = null;
    let policyJournal = null;
    const MODHUB_TIMEOUT = 60000;
    const contexts = new WeakSet();
    const operationPackages = new WeakMap();
    const startupLogs = [];
    let owner = null;
    let restoring = false;
    let startupGate = Promise.resolve();
    let decisionGate = null;
    let startupFinished = false;
    let startupPrompted = false;
    let bootRound = `round-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let roundFirstId = null;
    let roundHasChanges = false;
    let startupMarker = null;
    let successNotice = null;
    let successNoticeBusy = false;
    let successNoticeClosed = false;
    let startupVerified = false;
    const busy = message => Object.assign(new Error(message), { code: 'MODHUB_BUSY' });

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sameState = (a, b) => same({ ...a, beauty: { ...a.beauty, exists: undefined } }, { ...b, beauty: { ...b.beauty, exists: undefined } });
    const fail = message => { throw new Error(message); };
    const validNames = value => Array.isArray(value) && value.every(name => typeof name === 'string' && name.length > 0) && new Set(value).size === value.length;
    const parseNames = raw => {
        if (raw === undefined || raw === null) return [];
        const names = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!validNames(names)) fail('模组列表格式未知，已停止还原写入');
        return names;
    };

    function environment() {
        const utils = window.modUtils || window.modHubGetGui?.()?.gModUtils;
        const modLoader = utils?.getModLoader?.();
        const loader = modLoader?.getIndexDBLoader?.();
        const schema = loader?.constructor;
        if (typeof loader?.customStore !== 'function' || typeof schema?.calcModNameKey !== 'function') fail('当前 ModLoader 不支持真实模组存储事务');
        const enabledKey = schema.modDataIndexDBZipList;
        const disabledKey = schema.modDataIndexDBZipListHidden;
        const prefix = schema.calcModNameKey('');
        if (![enabledKey, disabledKey, prefix, schema.dbName, schema.storeName].every(value => typeof value === 'string' && value.length > 0) || enabledKey === disabledKey || MODHUB_POINTS_KEY.startsWith(prefix) || MODHUB_CONFIG_PREFIX.startsWith(prefix)) fail('ModLoader 存储结构未知，已停止还原写入');
        return { utils, modLoader, loader, enabledKey, disabledKey, prefix, dbName: schema.dbName, storeName: schema.storeName };
    }

    function transaction(env, mode, action) {
        return env.loader.customStore(mode, store => new Promise((resolve, reject) => {
            const tx = store.transaction;
            if (!tx || store.name !== env.storeName || tx.db?.name !== env.dbName) {
                try { tx?.abort(); } catch (_) {}
                reject(new Error('模组存储位置未知，未写入数据'));
                return;
            }
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('模组存储事务失败'));
            const setResult = value => { result = value; };
            setResult.fail = error => { try { tx.abort(); } catch (_) {} reject(error); };
            try { action(store, setResult); } catch (error) {
                try { tx.abort(); } catch (_) {}
                reject(error);
            }
        }));
    }

    function entries(env, packageRows) {
        return transaction(env, 'readonly', (store, done) => {
            const rows = [];
            const metadataKeys = new Set([env.enabledKey, env.disabledKey, MODHUB_POINTS_KEY, MODHUB_JOURNAL_KEY,
                MODHUB_STARTUP_KEY, MODHUB_SUCCESS_KEY, configKey(env)]);
            const request = typeof store.openKeyCursor === 'function' ? store.openKeyCursor() : store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const row = [cursor.key, undefined];
                    rows.push(row);
                    // 纯配置收尾复用本操作的原包体，最终写事务仍逐字节核对真实仓库。
                    if (packageRows?.has(cursor.key) && typeof cursor.key === 'string' && cursor.key.startsWith(env.prefix)) {
                        row[1] = packageRows.get(cursor.key);
                    } else if (metadataKeys.has(cursor.key) || typeof cursor.key === 'string' && cursor.key.startsWith(env.prefix)) {
                        const value = store.get(cursor.key);
                        value.onsuccess = () => { row[1] = value.result; };
                    }
                    cursor.continue();
                }
                else done(new Map(rows));
            };
        });
    }

    async function loadBlobs(env, target, rows) {
        await transaction(env, 'readonly', store => {
            target.packages.forEach(item => {
                const key = MODHUB_BLOB_PREFIX + item.hash;
                const request = store.get(key);
                request.onsuccess = () => { rows.set(key, request.result); };
            });
        });
    }

    function putValues(env, values, deletes = []) {
        return transaction(env, 'readwrite', store => {
            values.forEach(([key, value]) => store.put(value, key));
            deletes.forEach(key => store.delete(key));
        });
    }

    async function bytes(value) {
        if (typeof value === 'string') {
            const encoded = value.replace(/[\t\n\f\r ]/g, '');
            const padding = encoded.indexOf('=');
            // 分块前核验全局填充位置，避免中途的填充被误当作合法块尾。
            if (encoded.length % 4 === 1 || padding !== -1 && (encoded.length % 4 !== 0 || padding < encoded.length - 2)) {
                fail('模组包体的 Base64 编码无效，已停止还原写入');
            }
            const data = new Uint8Array(Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
            const chunkSize = 256 * 1024;
            let written = 0;
            for (let offset = 0; offset < encoded.length; offset += chunkSize) {
                const binary = window.atob(encoded.slice(offset, offset + chunkSize));
                for (let index = 0; index < binary.length; index++) data[written++] = binary.charCodeAt(index);
                if (offset + chunkSize < encoded.length) {
                    if (typeof window.scheduler?.yield === 'function') await window.scheduler.yield();
                    else await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            return data;
        }
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
        if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
        fail('发现无法识别的模组包体，已停止还原写入');
    }

    async function digest(value) {
        if (!window.crypto?.subtle?.digest) fail('浏览器不支持包体完整性校验，无法建立还原点');
        const data = await bytes(value);
        const hash = await window.crypto.subtle.digest('SHA-256', data);
        return { hash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), size: data.byteLength, data };
    }

    function readSettings() {
        const settings = {};
        for (const key of MODHUB_SETTINGS) settings[key] = window.localStorage.getItem(key) ?? window.localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_'));
        return settings;
    }

    function writeSettings(settings) {
        if (!settings || !same(Object.keys(settings).sort(), [...MODHUB_SETTINGS].sort())) fail('还原点设置范围未知');
        for (const key of MODHUB_SETTINGS) {
            const value = settings[key];
            if (value !== null && typeof value !== 'string') fail('还原点设置格式未知');
            if (value === null) window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, value);
            // 不改写历史键；空值也必须覆盖旧版回退，避免旧配置重新生效。
            if (value === null && window.localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_')) !== null) window.localStorage.setItem(key, key.endsWith('mod_order') ? '[]' : 'true');
        }
        for (const key of MODHUB_SETTINGS) {
            const actual = window.localStorage.getItem(key) ?? window.localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_'));
            const expected = settings[key] === null && window.localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_')) !== null ? (key.endsWith('mod_order') ? '[]' : 'true') : settings[key];
            if (actual !== expected) fail('设置保存后回读不一致，恢复尚未完成');
        }
    }

    function beautyDescriptor(env) {
        const addon = window.addonBeautySelectorAddon;
        const config = env.modLoader.getLoaderKeyConfig?.();
        const resolve = value => typeof config?.getLoaderKey === 'function' ? config.getLoaderKey(value, value) : value;
        const resolved = typeof addon?.customStore === 'function';
        const dbName = resolved ? addon.BeautySelectorAddon_dbName : resolve(addon?.BeautySelectorAddon_dbName || 'BeautySelectorAddon');
        const storeName = resolved ? addon.BeautySelectorAddon_storeName : resolve(addon?.BeautySelectorAddon_storeName || 'BeautySelectorAddon');
        const key = resolved ? addon.BeautySelectorAddon_OrderSaveKey : resolve(addon?.BeautySelectorAddon_OrderSaveKey || 'BeautySelectorAddon_OrderSaveKey');
        if (![dbName, storeName, key].every(value => typeof value === 'string' && value.length > 0)) fail('美化存储位置未知');
        return { dbName, storeName, key };
    }

    function openBeauty(descriptor) {
        return new Promise((resolve, reject) => {
            const request = window.indexedDB.open(descriptor.dbName);
            let missing = false;
            request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
            request.onerror = () => missing ? resolve(null) : reject(request.error || new Error('美化存储无法打开'));
            request.onblocked = () => reject(new Error('美化存储正被其他页面占用'));
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(descriptor.storeName)) { db.close(); reject(new Error('美化仓库结构未知，未写入数据')); }
                else resolve(db);
            };
        });
    }

    async function beautyValue(descriptor, write) {
        const db = await openBeauty(descriptor);
        if (!db) {
            if (write?.exists || write?.hasValue) fail('原美化数据库不存在，恢复尚未完成');
            return { ...descriptor, exists: false, hasValue: false, value: null };
        }
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(descriptor.storeName, write ? 'readwrite' : 'readonly');
                const store = tx.objectStore(descriptor.storeName);
                let value;
                tx.onabort = tx.onerror = () => reject(tx.error || new Error('美化配置事务失败'));
                tx.oncomplete = () => resolve({ ...descriptor, exists: true, hasValue: value !== undefined, value: value ?? null });
                if (write) {
                    if (write.hasValue) store.put(write.value, descriptor.key);
                    else store.delete(descriptor.key);
                }
                const request = store.get(descriptor.key);
                request.onsuccess = () => { value = request.result; };
            });
        } finally { db.close(); }
    }

    function validateBeauty(beauty) {
        if (!beauty || typeof beauty.exists !== 'boolean' || typeof beauty.hasValue !== 'boolean') fail('还原点美化配置格式未知');
        if (beauty.hasValue) {
            if (typeof beauty.value !== 'string') fail('美化顺序应为原始 JSON 字符串');
            parseNames(beauty.value);
        } else if (beauty.value !== null) fail('空美化配置格式未知');
    }

    async function snapshot(env = environment(), knownRows, packageMetadata) {
        const rows = knownRows || await entries(env);
        const enabled = parseNames(rows.get(env.enabledKey));
        const disabled = parseNames(rows.get(env.disabledKey));
        if (enabled.some(name => disabled.includes(name))) fail('模组启用与禁用列表重复，无法建立完整还原点');
        const packages = [];
        const blobs = new Map();
        let lastYield = Date.now();
        for (const [key, value] of rows) {
            if (typeof key !== 'string' || !key.startsWith(env.prefix)) continue;
            const name = key.slice(env.prefix.length);
            if (!name || env.loader.constructor.calcModNameKey(name) !== key) fail('模组包体键格式未知');
            const known = packageMetadata?.get(name);
            if (known) packages.push(known);
            else {
                const blob = await digest(value);
                packages.push({ name, hash: blob.hash, size: blob.size });
                blobs.set(blob.hash, blob.data);
                if (Date.now() - lastYield >= 12) {
                    if (typeof window.scheduler?.yield === 'function') await window.scheduler.yield();
                    else await new Promise(resolve => setTimeout(resolve, 0));
                    lastYield = Date.now();
                }
            }
        }
        packages.sort((a, b) => a.name.localeCompare(b.name));
        // 启禁记录可能残留已缺失的包名；分别保存原始列表与真实仓库包体，不虚构安装包。
        const beauty = await beautyValue(beautyDescriptor(env));
        validateBeauty(beauty);
        return { state: { schema: { dbName: env.dbName, storeName: env.storeName, enabledKey: env.enabledKey, disabledKey: env.disabledKey, prefix: env.prefix }, enabled, disabled, packages, beauty, settings: readSettings() }, blobs, rows };
    }

    function configKey(env = environment()) {
        return MODHUB_CONFIG_PREFIX + JSON.stringify([env.dbName, env.storeName, env.enabledKey, env.disabledKey, env.prefix]);
    }

    function normalizeConfig(config) {
        if (!config || typeof config.autoCreate !== 'boolean' || !MODHUB_POINT_LIMITS.includes(config.maxPoints)) fail('还原点设置格式未知，仅支持 5、10、20 或 50 个还原点');
        return { autoCreate: config.autoCreate, maxPoints: config.maxPoints };
    }

    function readConfig(rows, env = environment()) {
        const stored = rows.get(configKey(env));
        return stored === undefined ? { autoCreate: true, maxPoints: 20 } : normalizeConfig(stored);
    }

    function pointKind(point) {
        return point.kind || (point.id.startsWith('before-restore-') ? 'preRestore' : 'auto');
    }

    function displayPointKind(point) {
        const summary = point.summary;
        if (point.kind === 'manual' && !point.operation && Array.isArray(summary?.updated) && summary.updated.length === 1
            && typeof summary.updated[0] === 'string' && point.label === `AI 修复前：${summary.updated[0]}`
            && ['installed', 'removed', 'enabled', 'disabled'].every(field => Array.isArray(summary[field]) && !summary[field].length)
            && ['orderChanged', 'beautyChanged', 'settingsChanged'].every(field => summary[field] === false)) return 'auto';
        return pointKind(point);
    }

    function parsePoints(value) {
        const points = value ?? [];
        if (!Array.isArray(points) || points.some(point => !point || typeof point.id !== 'string' || !point.state || point.version !== 1 || Object.prototype.hasOwnProperty.call(point, 'userProtected') && typeof point.userProtected !== 'boolean')) fail('还原点目录损坏，未写入数据');
        return points;
    }

    function readPoints(rows) {
        policyConfig = readConfig(rows);
        policyStartup = rows.get(MODHUB_STARTUP_KEY) || null;
        policyJournal = rows.get(MODHUB_JOURNAL_KEY) || null;
        return parsePoints(rows.get(MODHUB_POINTS_KEY));
    }

    function protectionReasons(points, startup = policyStartup, journal = policyJournal) {
        const reasons = new Map();
        const add = (id, reason) => {
            if (!points.some(point => point.id === id)) return;
            const current = reasons.get(id) || [];
            if (!current.includes(reason)) current.push(reason);
            reasons.set(id, current);
        };
        points.filter(point => point.userProtected).forEach(point => add(point.id, '手动保护'));
        const pending = startup?.changesPending || startup?.pending;
        const firstId = pending && startup.firstPointId || roundHasChanges && roundFirstId;
        const round = pending && startup.roundId || roundHasChanges && bootRound;
        const first = points.find(point => point.id === firstId) || (round ? points.filter(point => point.roundId === round && pointKind(point) !== 'manual').at(-1) : null);
        if (first) add(first.id, '本轮首次操作前状态待启动验证');
        if (journal) {
            if (journal.pointId) add(journal.pointId, '未完成还原引用的状态');
            if (journal.safetyPointId) add(journal.safetyPointId, '未完成还原引用的状态');
            if (!journal.safetyPointId && journal.source) points.filter(point => pointKind(point) === 'preRestore' && sameState(point.state, journal.source)).forEach(point => add(point.id, '未完成还原引用的状态'));
        }
        return reasons;
    }

    function protectedPointIds(points, startup = policyStartup, journal = policyJournal) {
        return new Set(protectionReasons(points, startup, journal).keys());
    }

    function retainPoints(points, config = policyConfig, protectedIds = protectedPointIds(points)) {
        const retained = new Set(protectedIds);
        let ordinaryCount = 0;
        for (const point of points) {
            if (protectedIds.has(point.id)) continue;
            if (ordinaryCount >= config.maxPoints) break;
            retained.add(point.id);
            ordinaryCount++;
        }
        return points.filter(point => retained.has(point.id));
    }

    function describeChanges(before, after) {
        const prior = new Map(before.packages.map(item => [item.name, item.hash]));
        const next = new Map(after.packages.map(item => [item.name, item.hash]));
        return {
            installed: [...next.keys()].filter(name => !prior.has(name)),
            updated: [...next.keys()].filter(name => prior.has(name) && next.get(name) !== prior.get(name)),
            removed: [...prior.keys()].filter(name => !next.has(name)),
            enabled: after.enabled.filter(name => !before.enabled.includes(name)),
            disabled: after.disabled.filter(name => !before.disabled.includes(name)),
            orderChanged: !same(before.enabled, after.enabled),
            beautyChanged: !same(before.beauty.value, after.beauty.value),
            settingsChanged: !same(before.settings, after.settings),
        };
    }

    function sourceMetadata(env) {
        const read = env.modLoader.getModReadCache?.()?.get_Array?.() || env.modLoader.getModCacheArray?.();
        const entries = Array.isArray(read) ? read : [];
        const info = item => item.mod || item.zip?.getModInfo?.() || item.zip?.modInfo;
        const game = entries.find(item => String(info(item)?.bootJson?.name || item.name || '').trim().toLowerCase() === 'gameversion');
        return { html: String(window.location?.href || '').split(/[?#]/)[0], gameVersion: String(window.StartConfig?.version || info(game || {})?.bootJson?.version || window.modHubMarketVersions?.getGameVersion?.() || ''), builtinKnown: Array.isArray(read), builtinMods: entries.filter(item => item.from && item.from !== 'IndexDB').map(item => ({ name: String(item.name || info(item)?.name || ''), version: String(info(item)?.version || info(item)?.bootJson?.version || '') })).filter(item => item.name) };
    }

    function embeddedRecovery(env) {
        // inject_early 与 earlyload 时普通档案可能尚未构建；读取上游已解析的原始包档案。
        const read = env.modLoader.getModReadCache?.()?.get_Array?.();
        const cache = env.modLoader.getModCacheArray?.();
        const entries = [...(Array.isArray(read) ? read : []), ...(Array.isArray(cache) ? cache : [])];
        for (const item of entries) {
            if (item?.from !== 'Local' || String(item.name || '').trim().toLowerCase() !== 'modhub') continue;
            const mod = item.mod || item.zip?.getModInfo?.() || item.zip?.modInfo;
            const boot = mod?.bootJson;
            if (String(boot?.name || '').trim().toLowerCase() !== 'modhub') continue;
            if (!Array.isArray(boot.scriptFileList_inject_early) || !boot.scriptFileList_inject_early.includes('javascript/modhub-restore.js')) continue;
            return mod;
        }
        // 兼容旧接口环境，但不把别名档案或已知 IndexDB 来源误认为 HTML 内嵌包。
        if (Array.isArray(read) || Array.isArray(cache)) return null;
        const resolved = env.utils.getAnyModByNameNoAlias?.('ModHub') || env.utils.getMod?.('ModHub');
        return String(resolved?.bootJson?.name || '').trim().toLowerCase() === 'modhub' ? resolved : null;
    }

    function garbage(rows, points, journal) {
        const used = new Set(points.flatMap(point => point.state.packages.map(item => item.hash)));
        journal?.target?.packages?.forEach(item => used.add(item.hash));
        return [...rows.keys()].filter(key => typeof key === 'string' && key.startsWith(MODHUB_BLOB_PREFIX) && !used.has(key.slice(MODHUB_BLOB_PREFIX.length)));
    }

    const createOperation = (meta = {}) => {
        const context = { id: `point-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`, label: typeof meta.label === 'string' ? meta.label.slice(0, 200) : '模组配置操作', kind: ['manual', 'aiRepair', 'remoteRepair'].includes(meta.kind) ? meta.kind : 'auto', packagesUnchanged: meta.packagesUnchanged === true, roundId: bootRound, prepared: false, pointId: null, finished: false, withoutPoint: false, cancelled: false };
        contexts.add(context);
        return context;
    };
    const claim = context => {
        if (!contexts.has(context) || context.finished || restoring || (owner && owner !== context)) return false;
        owner = context;
        return true;
    };
    const release = context => { context?.releaseStorageLock?.(); if (owner === context) owner = null; };
    const isOperationBlocked = context => restoring || !!(owner && owner !== context);

    async function storageLock(env, context) {
        if (context.releaseStorageLock) return;
        // 独占整个异步操作；事务前置比对不能替代操作间的互斥。
        if (!window.navigator?.locks?.request) throw busy('浏览器不支持跨页面模组操作锁，请使用支持 Web Locks 的浏览器');
        await new Promise((resolve, reject) => {
            window.navigator.locks.request(`modhub:${env.dbName}:${env.storeName}`, { mode: 'exclusive', ifAvailable: true }, lock => {
                if (!lock) { reject(Object.assign(new Error('另一个游戏页面正在修改模组，请先完成或关闭该页面'), { code: 'MODHUB_BUSY' })); return; }
                return new Promise(done => { context.releaseStorageLock = done; resolve(); });
            }).catch(reject);
        });
    }

    async function prepare(context) {
        if (context?.cancelled) return false;
        await startupGate;
        if (gameReady()) await markStartupSuccess();
        if (!claim(context)) return false;
        if (context.prepared) return true;
        try {
            const env = environment();
            await storageLock(env, context);
            const rows = await entries(env);
            if (rows.get(MODHUB_JOURNAL_KEY)) throw busy('上次恢复尚未完成，请先完成恢复');
            const points = readPoints(rows);
            const active = rows.get(MODHUB_STARTUP_KEY);
            if (active?.changesPending && active.roundId) {
                bootRound = active.roundId;
                roundFirstId = active.firstPointId;
                roundHasChanges = true;
            }
            context.roundId = bootRound;
            if (context.kind === 'auto' && !policyConfig.autoCreate) {
                context.prepared = true;
                context.withoutPoint = true;
                return true;
            }
            const before = await snapshot(env, rows);
            const repair = ['aiRepair', 'remoteRepair'].includes(context.kind);
            const point = { version: 1, id: context.id, label: context.label, kind: repair ? 'auto' : context.kind,
                ...(repair ? { operation: context.kind } : {}), userProtected: context.kind === 'remoteRepair', roundId: context.roundId, at: Date.now(), pending: context.kind === 'auto', source: sourceMetadata(env), state: before.state };
            // 先保留原历史；无变化时撤销本点，不让空操作挤掉最旧的有效点。
            const next = [point, ...points];
            const values = [...before.blobs].filter(([hash]) => !before.rows.has(MODHUB_BLOB_PREFIX + hash)).map(([hash, data]) => [MODHUB_BLOB_PREFIX + hash, data]);
            values.push([MODHUB_POINTS_KEY, next]);
            try { await guardedValues(env, before.rows, values, garbage(before.rows, next, null)); }
            catch (error) {
                if (error?.name !== 'QuotaExceededError') throw error;
                const unused = garbage(before.rows, points, null);
                if (unused.length) {
                    await guardedValues(env, before.rows, [], unused);
                    unused.forEach(key => before.rows.delete(key));
                }
                let retained = [...points];
                const protectedIds = protectedPointIds(points);
                const candidates = points.filter(item => !protectedIds.has(item.id)).reverse();
                let saved = false;
                while (!saved) {
                    const pending = [point, ...retained];
                    try {
                        await guardedValues(env, before.rows, values.filter(([key]) => key !== MODHUB_POINTS_KEY).concat([[MODHUB_POINTS_KEY, pending]]), garbage(before.rows, pending, null));
                        saved = true;
                    } catch (retryError) {
                        if (retryError?.name !== 'QuotaExceededError' || !candidates.length) throw retryError;
                        const dropped = candidates.shift();
                        retained = retained.filter(item => item.id !== dropped.id);
                        const remove = garbage(before.rows, [point, ...retained], null);
                        await guardedValues(env, before.rows, [[MODHUB_POINTS_KEY, retained]], remove);
                        before.rows.set(MODHUB_POINTS_KEY, retained);
                        remove.forEach(key => before.rows.delete(key));
                    }
                }
            }
            context.before = before.state;
            context.pointId = point.id;
            context.prepared = true;
            if (context.packagesUnchanged) operationPackages.set(context, {
                rows: before.rows, packages: new Map(before.state.packages.map(item => [item.name, { ...item }])),
                schema: { ...before.state.schema }
            });
            return true;
        } catch (error) {
            context.prepareError = error;
            if (context.kind !== 'auto') {
                context.cancelled = true;
                release(context);
                throw error;
            }
            if (error.code === 'MODHUB_BUSY') {
                context.cancelled = true;
                release(context);
                await window.modHubConfirm?.({ title: '模组操作正被占用', message: error.message, cancelText: '' });
                return false;
            }
            const proceed = await window.modHubConfirm?.({ title: '未能建立还原点', message: `无法进行自动备份，备份尚未执行。\n\n继续进行将跳过本次备份。如果后续出现问题，可能无法恢复到本次操作前的状态。\n\n建议取消操作然后重试。如果问题持续存在，请提供以下错误详情以便排查。\n\n错误详情：${error.message}`, confirmText: '不建立还原点，继续操作', cancelText: '取消操作', confirmType: 'danger' });
            if (!proceed) { context.cancelled = true; release(context); return false; }
            context.prepared = true;
            context.withoutPoint = true;
            return true;
        }
    }

    async function finish(context) {
        if (!contexts.has(context) || context.finished) return;
        try {
            if (context.pointId) {
                const env = environment();
                const known = operationPackages.get(context);
                if (known && !same(known.schema, { dbName: env.dbName, storeName: env.storeName,
                    enabledKey: env.enabledKey, disabledKey: env.disabledKey, prefix: env.prefix })) {
                    fail('操作期间模组存储位置已变化，未能确认操作结果');
                }
                const rows = known ? await entries(env, known.rows) : undefined;
                const after = await snapshot(env, rows, known?.packages);
                const changed = !sameState(after.state, context.before);
                const all = readPoints(after.rows).map(point => ({ ...point }));
                const point = all.find(item => item.id === context.pointId);
                if (!point) fail('操作前还原点已被外部删除，未能确认操作结果');
                point.pending = false;
                point.summary = describeChanges(context.before, after.state);
                const values = [];
                let marker = policyStartup;
                if (changed) {
                    roundHasChanges = true;
                    roundFirstId = roundFirstId || all.filter(item => item.roundId === context.roundId && pointKind(item) !== 'manual').at(-1)?.id || point.id;
                    marker = { pending: !startupFinished, at: Date.now(), roundId: context.roundId, firstPointId: roundFirstId, changesPending: true };
                    values.push([MODHUB_STARTUP_KEY, marker]);
                }
                const keep = changed || context.kind !== 'auto' ? all : all.filter(item => item.id !== context.pointId);
                const next = retainPoints(keep, policyConfig, protectedPointIds(keep, marker, policyJournal));
                values.push([MODHUB_POINTS_KEY, next]);
                await guardedValues(env, after.rows, values, garbage(after.rows, next, policyJournal));
            }
        } catch (error) {
            context.finishError = error;
            console.warn('[ModHub] 操作回读失败，已保留操作前还原点', error);
        } finally { operationPackages.delete(context); context.finished = true; release(context); }
    }

    async function withOperation(meta, action) {
        const context = createOperation(meta);
        if (!claim(context)) fail('另一项模组操作或恢复仍在进行');
        try { return await action(context); } finally { await finish(context); }
    }

    async function list() {
        return (await getPanelState()).points;
    }

    async function getPanelState() {
        const rows = await entries(environment());
        const points = readPoints(rows);
        const reasons = protectionReasons(points);
        const protectedIds = new Set(reasons.keys());
        const firstId = (policyStartup?.changesPending || policyStartup?.pending) && policyStartup.firstPointId || roundHasChanges && roundFirstId;
        const sizes = new Map();
        const archives = [...points.map(point => point.state), policyJournal?.source, policyJournal?.target].filter(Boolean);
        archives.forEach(state => state.packages.forEach(item => {
            if (rows.has(MODHUB_BLOB_PREFIX + item.hash)) sizes.set(item.hash, item.size);
        }));
        return {
            config: { ...policyConfig },
            points: points.map(({ id, label, roundId, at, state, summary, source, kind, operation, userProtected }) => ({ id, label, roundId, at, modCount: state.packages.length, summary, source, operation, kind: displayPointKind({ id, label, kind, operation, summary }), protected: protectedIds.has(id), userProtected: userProtected === true, systemProtected: (reasons.get(id) || []).some(reason => reason !== '手动保护'), protectionReasons: reasons.get(id) || [] })),
            usageBytes: [...sizes.values()].reduce((total, size) => total + size, 0),
            protectedIds: [...protectedIds],
            recommendedId: points.find(point => point.id === firstId)?.id || points.filter(point => point.roundId === points[0]?.roundId).at(-1)?.id || null,
            restoring: restoring || !!policyJournal,
        };
    }

    async function archiveAction(action) {
        await startupGate;
        if (window._modHubManagerBusy) fail('模组配置正在保存，请稍后再管理还原点');
        const context = createOperation();
        if (!claim(context)) throw busy('另一项模组操作或恢复仍在进行');
        try {
            const env = environment();
            await storageLock(env, context);
            const rows = await entries(env);
            if (rows.get(MODHUB_JOURNAL_KEY)) throw busy('上次恢复尚未完成，请先完成恢复');
            const points = readPoints(rows);
            return await action(env, rows, points);
        } finally { context.finished = true; release(context); }
    }

    const escapeHtml = value => window.modHubEscapeHtml(value);

    function pointDate(at) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return '时间未记录';
        const date = new Date(at);
        if (Number.isNaN(date.getTime())) return '时间未记录';
        if (window.modHubFormatDate) return window.modHubFormatDate(at, { hour12: false });
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function historyRemovalHtml(points) {
        if (!points.length) return '<p class="green">没有需要删除的还原点。</p>';
        return `<section class="modhub-restore-notice-section"><p>将删除 <strong class="red">${points.length} 个还原点</strong>：</p><ul class="modhub-restore-notice-list" tabindex="0" aria-label="将删除的还原点">${points.map(point => `<li><strong class="gold" data-modhub-no-translate>${escapeHtml(point.label)}</strong><br><span class="grey">${escapeHtml(pointDate(point.at))}</span></li>`).join('')}</ul></section><p><strong class="red">删除后无法通过这些还原点恢复。</strong></p><p>只有<strong class="gold">不再被其他还原点或恢复记录引用的包体</strong>才会清理。</p>`;
    }

    function packageVersionText(versions) {
        const translate = value => window.modHubT?.(value) || value;
        const display = value => value === null ? translate('未安装') : value || translate('未识别');
        const current = display(versions.current), target = display(versions.target);
        return window.modHubT?.('当前版本：{current}；还原后版本：{target}', { current, target }) || `当前版本：${current}；还原后版本：${target}`;
    }

    function orderChangeText(item) {
        const message = item.kind === 'added' ? '加入启用序列：还原后第 {target} 位'
            : item.kind === 'removed' ? '移出启用序列：当前位置第 {current} 位' : '当前位置：第 {current} 位；还原后：第 {target} 位';
        return window.modHubT?.(message, { current: item.currentIndex, target: item.targetIndex })
            || message.replace('{current}', item.currentIndex).replace('{target}', item.targetIndex);
    }

    function restoreConfirmationHtml(point, change, riskMessages, packageVersions, orderChanges) {
        const items = [];
        [['installed', '恢复已删除模组'], ['updated', '回退包体'], ['removed', '将移除的模组'], ['enabled', '恢复启用'], ['disabled', '恢复禁用']].forEach(([key, label]) => {
            if (!change[key].length) return;
            const color = key === 'removed' || key === 'disabled' ? 'red' : 'gold';
            items.push(`<li><strong class="${color}">${key === 'removed' ? `将移除 ${change[key].length} 个模组` : `${label}（${change[key].length} 个）`}</strong><br>${change[key].map(name => `<strong class="gold" data-modhub-no-translate>${escapeHtml(name)}</strong>${['installed', 'updated', 'removed'].includes(key) ? `<br><span class="grey">${escapeHtml(packageVersionText(packageVersions[name]))}</span>` : ''}`).join('<br>')}</li>`);
        });
        [['orderChanged', '恢复加载顺序'], ['beautyChanged', '恢复美化配置'], ['settingsChanged', '恢复管理配置']].forEach(([key, label]) => { if (change[key]) items.push(`<li><strong class="gold">${label}</strong></li>`); });
        if (orderChanges.length) {
            const translate = value => window.modHubT?.(value) || value;
            items.push(`<li><strong class="gold">${escapeHtml(translate('启用模组加载顺序对比'))}</strong><p class="grey">${escapeHtml(translate('仅列出加入、移出或相对顺序改变的模组；序号按完整启用列表计算。'))}</p><ul>${orderChanges.map(item => `<li><strong class="${item.kind === 'added' ? 'green' : item.kind === 'removed' ? 'red' : 'gold'}" data-modhub-no-translate>${escapeHtml(item.name)}</strong><br><span class="grey">${escapeHtml(orderChangeText(item))}</span></li>`).join('')}</ul></li>`);
        }
        const list = items.length ? `<ul class="modhub-restore-notice-list" tabindex="0" aria-label="还原变更">${items.join('')}</ul>` : '<p class="grey">目标与当前模组状态一致。</p>';
        return `<p class="modhub-restore-notice-target">将还原到 <strong class="gold" data-modhub-no-translate>${escapeHtml(point.label)}</strong> 对应的模组状态。<br>时间：<strong class="gold">${escapeHtml(pointDate(point.at))}</strong></p>${list}<p><strong class="gold">还原前会保存当前模组状态</strong>，方便需要时撤销此次还原。</p><p class="modhub-restore-notice-summary"><strong class="green">当前 ModHub 恢复工具与游戏存档保留</strong>；完成后<strong class="gold">游戏将重新加载</strong>。</p>${riskMessages.length ? `<p class="red">${riskMessages.map(escapeHtml).join('<br>')}</p>` : ''}`;
    }

    async function saveConfig(config) {
        const nextConfig = normalizeConfig(config);
        return archiveAction(async (env, rows, points) => {
            const protectedIds = protectedPointIds(points);
            const next = retainPoints(points, nextConfig, protectedIds);
            const removed = points.filter(point => !next.some(item => item.id === point.id));
            if (nextConfig.maxPoints < policyConfig.maxPoints || removed.length) {
                const reduced = nextConfig.maxPoints < policyConfig.maxPoints;
                const quotaMessage = reduced ? `普通历史保留上限将从 ${policyConfig.maxPoints} 改为 ${nextConfig.maxPoints} 个。` : `普通历史保留上限为 ${nextConfig.maxPoints} 个。`;
                const protection = '手动保护、未成功启动的首点与恢复记录引用的还原点额外保留，不占普通历史数量。';
                const ok = await window.modHubConfirm?.({ title: reduced ? '减少还原点保留数量' : '整理超出上限的还原点', message: `${quotaMessage}\n将删除 ${removed.length} 个旧还原点${removed.length ? '：\n' + removed.map(point => `${point.label}（${pointDate(point.at)}）`).join('\n') : '。'}\n${protection}${removed.length ? '\n删除后无法通过这些还原点恢复。只有不再被其他还原点或恢复记录引用的包体才会清理。' : ''}`, trustedMessageHtml: `<p>${escapeHtml(quotaMessage)}</p>${historyRemovalHtml(removed)}<p class="green">${escapeHtml(protection)}</p>`, dialogClass: 'modhub-restore-notice', confirmText: '确认调整', cancelText: '保留原设置', confirmType: removed.length ? 'danger' : 'primary' });
                if (!ok) return false;
            }
            await guardedValues(env, rows, [[configKey(env), nextConfig], [MODHUB_POINTS_KEY, next]], garbage(rows, next, policyJournal));
            policyConfig = nextConfig;
            return true;
        });
    }

    async function createPoint(label) {
        const name = Array.from(typeof label === 'string' ? label.trim() : '').slice(0, 80).join('') || '手动还原点';
        const context = createOperation({ kind: 'manual', label: name });
        try {
            if (!await prepare(context)) throw context.prepareError || busy('另一项模组操作或恢复仍在进行');
            await finish(context);
            if (context.finishError) throw context.finishError;
            if (!context.pointId) fail('手动还原点没有保存，未建立空记录');
            return context.pointId;
        } finally {
            if (!context.finished) await finish(context);
            release(context);
        }
    }

    async function deletePoints(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) fail('请选择要删除的还原点');
        const selected = new Set(ids);
        return archiveAction(async (env, rows, points) => {
            const removed = points.filter(point => selected.has(point.id));
            if (removed.length !== selected.size) fail('所选还原点已不存在，请刷新列表');
            const protectedIds = protectedPointIds(points);
            if (removed.some(point => protectedIds.has(point.id))) fail('所选还原点已手动保护，或正在保护未成功启动的首点或恢复记录，不能删除');
            const ok = await window.modHubConfirm?.({ title: '删除还原点', message: `将删除 ${removed.length} 个还原点：\n${removed.map(point => `${point.label}（${pointDate(point.at)}）`).join('\n')}\n\n删除后无法通过这些还原点恢复。只有不再被其他还原点或恢复记录引用的包体才会清理。`, trustedMessageHtml: historyRemovalHtml(removed), dialogClass: 'modhub-restore-notice', confirmText: '删除还原点', cancelText: '保留还原点', confirmType: 'danger' });
            if (!ok) return false;
            const next = points.filter(point => !selected.has(point.id));
            await guardedValues(env, rows, [[MODHUB_POINTS_KEY, next]], garbage(rows, next, policyJournal));
            return true;
        });
    }

    async function setPointProtection(id, enabled) {
        if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') fail('还原点保护设置格式未知');
        return archiveAction(async (env, rows, points) => {
            const point = points.find(item => item.id === id);
            if (!point) fail('所选还原点已不存在，请刷新列表');
            if ((point.userProtected === true) === enabled) return true;
            const next = points.map(item => item.id === id ? { ...item, userProtected: enabled } : item);
            await guardedValues(env, rows, [[MODHUB_POINTS_KEY, next]]);
            return true;
        });
    }

    function checkTarget(env, state) {
        if (!same(state?.schema, { dbName: env.dbName, storeName: env.storeName, enabledKey: env.enabledKey, disabledKey: env.disabledKey, prefix: env.prefix })) fail('还原点来自不同存储位置，未写入数据');
        if (!validNames(state.enabled) || !validNames(state.disabled) || state.enabled.some(name => state.disabled.includes(name)) || !Array.isArray(state.packages)) fail('还原点模组列表损坏');
        const names = state.packages.map(item => item.name);
        if (!validNames(names) || state.packages.some(item => !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isSafeInteger(item.size) || item.size < 0)) fail('还原点包体清单损坏');
        validateBeauty(state.beauty);
        if (!same(beautyDescriptor(env), { dbName: state.beauty.dbName, storeName: state.beauty.storeName, key: state.beauty.key })) fail('美化存储位置已改变，未写入数据');
        if (!state.settings || !same(Object.keys(state.settings).sort(), [...MODHUB_SETTINGS].sort()) || MODHUB_SETTINGS.some(key => state.settings[key] !== null && typeof state.settings[key] !== 'string')) fail('还原点设置格式未知');
    }

    async function validateBlobs(target, rows) {
        for (const item of target.packages) {
            const data = rows.get(MODHUB_BLOB_PREFIX + item.hash);
            if (data === undefined) fail(`还原包体缺失：${item.name}`);
            const actual = await digest(data);
            if (actual.hash !== item.hash || actual.size !== item.size) fail(`还原包体校验失败：${item.name}`);
        }
    }

    function sameMods(a, b) { return same([a.enabled, a.disabled, a.packages], [b.enabled, b.disabled, b.packages]); }
    function checkReplaySource(journal, current) {
        const conflict = message => { throw Object.assign(new Error(message), { code: 'MODHUB_RESTORE_CONFLICT' }); };
        if (journal.version !== 1 || !journal.source || !sameMods(current, journal.source) && !sameMods(current, journal.target)) conflict('恢复期间模组状态被其他页面修改，已停止覆盖');
        const beautyMatches = state => current.beauty.hasValue === state.beauty.hasValue && current.beauty.value === state.beauty.value;
        if (!beautyMatches(journal.source) && !beautyMatches(journal.target)) conflict('恢复期间美化配置被其他页面修改，已停止覆盖');
        if (MODHUB_SETTINGS.some(key => current.settings[key] !== journal.source.settings[key] && current.settings[key] !== journal.target.settings[key])) conflict('恢复期间设置被其他页面修改，已停止覆盖');
    }

    function equalPackage(a, b) {
        if (typeof a === 'string' && a === b) return true;
        const unpack = value => {
            if (typeof value === 'string') return Uint8Array.from(window.atob(value), character => character.charCodeAt(0));
            if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
            fail('存储包体类型无法在事务内确认，已停止覆盖');
        };
        const left = unpack(a), right = unpack(b);
        if (left.length !== right.length) return false;
        let index = 0;
        if (left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0) {
            const length = Math.floor(left.length / 4);
            const leftWords = new Uint32Array(left.buffer, left.byteOffset, length);
            const rightWords = new Uint32Array(right.buffer, right.byteOffset, length);
            for (let word = 0; word < length; word++) {
                if (leftWords[word] !== rightWords[word]) return false;
            }
            index = length * 4;
        }
        for (; index < left.length; index++) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    /** 限定安装只增改本次包体，并与两份启禁列表在真实仓库中一起提交。 */
    async function commitPackageChanges({ context, packages, guardedPackages = [], expectedEnabled, expectedDisabled, enabled, disabled } = {}) {
        if (!contexts.has(context) || owner !== context || !context.prepared || context.finished || context.cancelled || restoring) {
            throw busy('安装保护及操作锁尚未就绪，已停止写入');
        }
        const names = value => {
            if (!validNames(value) || value.some(name => name !== name.trim())
                || new Set(value.map(name => name.toLowerCase())).size !== value.length) fail('安装启禁列表包含无效或重复技术名');
            return [...value];
        };
        const beforeEnabled = names(expectedEnabled), beforeDisabled = names(expectedDisabled);
        const nextEnabled = names(enabled), nextDisabled = names(disabled);
        const beforeNames = names([...beforeEnabled, ...beforeDisabled]);
        const nextNames = names([...nextEnabled, ...nextDisabled]);
        const nameKeys = new Set(nextNames.map(name => name.toLowerCase()));
        if (beforeNames.some(name => !nextNames.includes(name))) fail('限定安装不能移除或更名已登记的模组');
        if (!Array.isArray(packages)) fail('安装包变更清单无效');
        names(packages.map(item => item?.name));
        if (!Array.isArray(guardedPackages)) fail('保留包体核验清单无效');
        names(guardedPackages.map(item => item?.name));
        const copyPackage = value => {
            if (value === undefined) return undefined;
            equalPackage(value, value);
            if (typeof value === 'string') return value;
            if (ArrayBuffer.isView(value)) return new value.constructor(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
            return value.slice(0);
        };
        const changes = packages.map(item => ({ name: item.name, data: copyPackage(item.data), expectedData: copyPackage(item.expectedData) }));
        const guards = guardedPackages.map(item => ({ name: item.name, expectedData: copyPackage(item.expectedData) }));
        for (const item of guards) {
            if (item.expectedData === undefined || !(await bytes(item.expectedData)).byteLength || !beforeNames.includes(item.name)) fail('保留包体缺少已登记的有效快照');
        }
        for (const item of changes) {
            if (!item.data || !(await bytes(item.data)).byteLength || !nextNames.includes(item.name)) fail('安装包为空或未登记到目标启禁列表');
        }
        const previousKeys = new Set(beforeNames.map(name => name.toLowerCase()));
        const changedKeys = new Set(changes.map(item => item.name.toLowerCase()));
        if (nextNames.some(name => !previousKeys.has(name.toLowerCase()) && !changedKeys.has(name.toLowerCase()))) fail('目标列表包含未提供安装包的新模组');
        if (!same(recoveryOrder(nextEnabled), nextEnabled)) fail('目标列表不符合恢复工具及必要前置的加载顺序');
        const env = environment();
        const packageKeys = changes.map(item => env.loader.constructor.calcModNameKey(item.name));
        const guardKeys = guards.map(item => env.loader.constructor.calcModNameKey(item.name));
        const checkedNames = [...new Set([...changes, ...guards].map(item => item.name))];
        const checkedKeys = checkedNames.map(name => env.loader.constructor.calcModNameKey(name));
        if (checkedKeys.some(key => typeof key !== 'string' || !key.startsWith(env.prefix))
            || new Set([env.enabledKey, env.disabledKey, ...checkedKeys]).size !== checkedKeys.length + 2) fail('安装包存储键冲突，已停止写入');
        const transact = write => transaction(env, write ? 'readwrite' : 'readonly', (store, done) => {
            const rows = new Map();
            const keys = [env.enabledKey, env.disabledKey, ...checkedKeys];
            for (const key of keys) {
                const request = store.get(key);
                request.onsuccess = () => {
                    try {
                        rows.set(key, request.result);
                        if (rows.size !== keys.length) return;
                        if (!same(parseNames(rows.get(env.enabledKey)), write ? beforeEnabled : nextEnabled)
                            || !same(parseNames(rows.get(env.disabledKey)), write ? beforeDisabled : nextDisabled)) {
                            fail(write ? '安装前启禁配置已被其他操作更改，已停止覆盖' : '安装提交后的启禁配置回读不一致');
                        }
                        changes.forEach((item, index) => {
                            const actual = rows.get(packageKeys[index]), expected = write ? item.expectedData : item.data;
                            if (expected === undefined ? actual !== undefined : actual === undefined || !equalPackage(actual, expected)) {
                                fail(write ? `模组【${item.name}】包体已被其他操作更改，已停止覆盖` : `模组【${item.name}】安装包提交后回读不一致`);
                            }
                        });
                        guards.forEach((item, index) => {
                            if (!write && changedKeys.has(item.name.toLowerCase())) return;
                            const actual = rows.get(guardKeys[index]);
                            if (actual === undefined || !equalPackage(actual, item.expectedData)) {
                                fail(write ? `保留模组【${item.name}】包体已被其他操作更改，已停止切换` : `保留模组【${item.name}】提交后包体回读不一致`);
                            }
                        });
                        if (write) {
                            if (owner !== context || context.finished || context.cancelled || restoring) throw busy('安装已取消或操作锁已改变，未写入数据');
                            changes.forEach((item, index) => store.put(item.data, packageKeys[index]));
                            store.put(JSON.stringify(nextEnabled), env.enabledKey);
                            store.put(JSON.stringify(nextDisabled), env.disabledKey);
                        }
                        done(true);
                    } catch (error) { done.fail(error); }
                };
            }
        });
        await transact(true);
        try { await transact(false); }
        catch (cause) {
            const error = new Error(`安装已经提交，但回读核验未完成：${cause.message}。请刷新列表核实配置；需要撤销时使用操作前还原点。`);
            error.code = 'PACKAGE_COMMIT_VERIFY_FAILED';
            error.committed = true;
            throw error;
        }
        return { committed: true };
    }

    function guardedValues(env, expected, values, deletes = []) {
        return transaction(env, 'readwrite', (store, done) => {
            const packageKeys = new Set([...expected.keys()].filter(key => typeof key === 'string' && key.startsWith(env.prefix)));
            const seen = new Set();
            const checkedKeys = [env.enabledKey, env.disabledKey, MODHUB_POINTS_KEY, MODHUB_JOURNAL_KEY, MODHUB_STARTUP_KEY, configKey(env)];
            if (values.some(([key]) => key === MODHUB_SUCCESS_KEY) || deletes.includes(MODHUB_SUCCESS_KEY)) checkedKeys.push(MODHUB_SUCCESS_KEY);
            for (const key of checkedKeys) {
                const request = store.get(key);
                request.onsuccess = () => {
                    if (!same(request.result, expected.get(key))) done.fail(busy('建立还原点前存储被其他页面修改，已停止操作'));
                };
            }
            const request = typeof store.openKeyCursor === 'function' ? store.openKeyCursor() : store.openCursor();
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (cursor) {
                        if (typeof cursor.key === 'string' && cursor.key.startsWith(env.prefix)) {
                            if (!packageKeys.has(cursor.key)) throw busy('建立还原点前出现其他页面安装的模组，已停止操作');
                            seen.add(cursor.key);
                            const key = cursor.key;
                            const value = store.get(key);
                            value.onsuccess = () => {
                                try { if (!equalPackage(value.result, expected.get(key))) throw busy('建立还原点前包体被其他页面修改，已停止操作'); }
                                catch (error) { done.fail(error); }
                            };
                        }
                        cursor.continue();
                    } else {
                        if (seen.size !== packageKeys.size) throw busy('建立还原点前包体被其他页面删除，已停止操作');
                        values.forEach(([key, value]) => store.put(value, key));
                        deletes.forEach(key => store.delete(key));
                    }
                } catch (error) { done.fail(error); }
            };
        });
    }

    function guardedModWrite(env, expected, journal, blobs) {
        return transaction(env, 'readwrite', (store, done) => {
            const names = new Set([...expected.keys()].filter(key => typeof key === 'string' && key.startsWith(env.prefix)));
            const seen = new Set();
            const listsSeen = new Set();
            const request = store.openCursor();
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (cursor) {
                        const key = cursor.key;
                        if (typeof key === 'string' && key.startsWith(env.prefix)) {
                            if (!names.has(key) || !equalPackage(cursor.value, expected.get(key))) fail('恢复提交前模组包体被外部修改，已停止覆盖');
                            seen.add(key);
                        } else if (key === env.enabledKey || key === env.disabledKey) {
                            if (!same(parseNames(cursor.value), parseNames(expected.get(key)))) fail('恢复提交前模组列表被外部修改，已停止覆盖');
                            listsSeen.add(key);
                        }
                        cursor.continue();
                        return;
                    }
                    if (seen.size !== names.size) fail('恢复提交前模组包体被外部删除，已停止覆盖');
                    if ([env.enabledKey, env.disabledKey].some(key => expected.has(key) && !listsSeen.has(key))) fail('恢复提交前模组列表被外部删除，已停止覆盖');
                    journal.target.packages.forEach(item => store.put(blobs.get(MODHUB_BLOB_PREFIX + item.hash), env.loader.constructor.calcModNameKey(item.name)));
                    const wanted = new Set(journal.target.packages.map(item => env.loader.constructor.calcModNameKey(item.name)));
                    for (const key of names) if (!wanted.has(key)) store.delete(key);
                    store.put(JSON.stringify(journal.target.enabled), env.enabledKey);
                    store.put(JSON.stringify(journal.target.disabled), env.disabledKey);
                    store.put({ ...journal, phase: 'mod-written' }, MODHUB_JOURNAL_KEY);
                } catch (error) { done.fail(error); }
            };
        });
    }

    function getRecoveryInfo(names, profiles = []) {
        const normalize = name => String(name || '').trim().toLowerCase();
        const utils = window.modUtils || window.modSC2DataManager?.getModUtils?.();
        const loader = utils?.getModLoader?.();
        const raw = loader?.getModReadCache?.()?.get_Array?.() || loader?.getModCacheArray?.();
        const entries = Array.isArray(raw) ? raw : [];
        const embedded = entries.filter(item => item.from === 'Local').map(item => {
            const mod = item.mod || item.zip?.getModInfo?.() || item.zip?.modInfo;
            return { name: item.name || mod?.name, bootJson: mod?.bootJson || {} };
        });
        const bootOf = name => profiles.find(item => normalize(item.name) === normalize(name))?.bootJson ||
            (!profiles.length && names.includes(name) ? window._modHubDisabledModInfo?.get(normalize(name))?.bootJson : null) ||
            embedded.find(item => normalize(item.name) === normalize(name))?.bootJson ||
            (!profiles.length ? window.modHubGetModInfo?.(name)?.bootJson : null) ||
            (!Array.isArray(raw) ? utils?.getMod?.(name)?.bootJson : null) || {};
        // 恢复时以包体档案为准，只有启用记录的名字不能充当恢复工具的必要前置。
        const available = [...new Set([...names.filter(name => !profiles.length || profiles.some(item => normalize(item.name) === normalize(name))), ...embedded.map(item => item.name).filter(Boolean)])];
        // 当前页面仍在运行的旁加载档案，不代表玩家选择在下一次启动时启用它。
        const self = available.find(name => normalize(name) === 'modhub');
        if (!self) return { order: names.slice(), protectedNames: [], issues: [] };
        const resolve = value => available.find(name => normalize(name) === normalize(value)) || available.find(name =>
            Array.isArray(bootOf(name).alias) && bootOf(name).alias.some(alias => normalize(alias) === normalize(value)));
        const selected = new Set(), visiting = new Set(), first = [], issues = [];
        const api = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.();
        const visit = name => {
            if (selected.has(name)) return;
            if (visiting.has(name)) fail('恢复工具前置存在循环依赖，无法保证合法加载顺序');
            visiting.add(name);
            const boot = bootOf(name);
            const requirements = [...(Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []), ...(Array.isArray(boot.addonPlugin) ? boot.addonPlugin : [])];
            if (name === self && !requirements.length) requirements.push({ modName: 'TweeReplacer' });
            for (const item of requirements) {
                if (!item.modName) continue;
                const runtime = ['modloader', 'gameversion'].includes(normalize(item.modName));
                const required = runtime ? item.modName : resolve(item.modName);
                if (!required) {
                    issues.push({ blocking: true, message: `恢复工具必要前置【${item.modName}】缺失或未启用，请核对安装包与启用状态。` });
                    continue;
                }
                const range = item.version || item.modVersion;
                if (range && range !== '*') {
                    try {
                        const actualVersion = normalize(required) === 'modloader' ? utils?.version : normalize(required) === 'gameversion' ? window.StartConfig?.version || bootOf(required).version : bootOf(required).version;
                        const version = api?.parseVersion(actualVersion)?.version;
                        const parsedRange = api?.parseRange(range);
                        if (!version || !parsedRange) throw new Error('版本信息无法核验');
                        if (!api.satisfies(version, parsedRange, true)) issues.push({ blocking: true, message: `恢复工具必要前置【${required}】版本不匹配，需要 ${range}。` });
                    } catch (_) {
                        issues.push({ blocking: false, message: `恢复工具必要前置【${required}】的版本兼容性暂无法核验，需要 ${range}，请自行核对。` });
                    }
                }
                if (!runtime) visit(required);
            }
            visiting.delete(name);
            selected.add(name);
            if (names.includes(name)) first.push(name);
        };
        visit(self);
        return { order: [...first, ...names.filter(name => !selected.has(name))], protectedNames: [...selected], issues };
    }

    function recoveryOrder(names, profiles = []) {
        return getRecoveryInfo(names, profiles).order;
    }

    async function targetProfiles(env, target, current, allowUnreadable = false) {
        const controller = window.modModLoadController || env.utils.getModLoadController?.();
        if (typeof controller?.checkModZipFileIndexDB !== 'function') fail('当前 ModLoader 无法校验还原包体的真实档案');
        const profiles = [];
        for (const item of target.packages) {
            const data = current.blobs.get(item.hash) || current.rows.get(MODHUB_BLOB_PREFIX + item.hash);
            let boot;
            try {
                boot = await controller.checkModZipFileIndexDB(data);
                if (!boot || typeof boot !== 'object' || String(boot.name || '').toLowerCase() !== item.name.toLowerCase()) fail(`还原包体档案不一致：${item.name}`);
            } catch (error) {
                if (!allowUnreadable) throw error;
                // 当前故障包仍允许被正常归档恢复；读取失败仅表示其版本未识别。
                boot = {};
            }
            profiles.push({ name: item.name, bootJson: boot });
        }
        return profiles;
    }

    async function buildTarget(env, current, point) {
        const source = sourceMetadata(env);
        const prior = point.source;
        const builtinKnown = metadata => metadata?.builtinKnown !== false && Array.isArray(metadata?.builtinMods) && (metadata.builtinKnown === true || metadata.builtinMods.length > 0);
        const priorBuiltin = new Map((prior?.builtinMods || []).map(item => [item.name, item.version]));
        const nextBuiltin = new Map(source.builtinMods.map(item => [item.name, item.version]));
        const builtinChanged = builtinKnown(prior) && builtinKnown(source) && (!same([...priorBuiltin.keys()].sort(), [...nextBuiltin.keys()].sort()) || [...priorBuiltin].some(([name, version]) => version && nextBuiltin.get(name) && version !== nextBuiltin.get(name)));
        const sourceChanged = !!prior && (prior.html && source.html && prior.html !== source.html || prior.gameVersion && source.gameVersion && prior.gameVersion !== source.gameVersion || builtinChanged);
        const riskMessages = [];
        if (sourceChanged) riskMessages.push('游戏环境已变化：游戏文件、版本或内置模组与建点时不同。无法恢复游戏 HTML 和内置包，不能保证与旧模组兼容。');
        if (!prior?.gameVersion || !source.gameVersion) riskMessages.push('部分游戏版本信息未识别，未能核验游戏版本兼容性。');
        if (!builtinKnown(prior) || !builtinKnown(source)) riskMessages.push('部分内置模组档案未识别，未能核验内置模组兼容性。');
        const target = JSON.parse(JSON.stringify(point.state));
        checkTarget(env, target);
        const self = current.state.packages.find(item => item.name.toLowerCase() === 'modhub');
        const embedded = embeddedRecovery(env);
        if (!self && !embedded) fail('未找到当前 ModHub 恢复入口，已停止恢复');
        if (self && !current.state.enabled.includes(self.name)) fail('当前 ModHub 恢复入口没有启用，已停止恢复');
        if (self) {
            target.packages = target.packages.filter(item => item.name.toLowerCase() !== 'modhub');
            target.packages.push(self);
            target.packages.sort((a, b) => a.name.localeCompare(b.name));
            target.enabled = target.enabled.filter(name => name.toLowerCase() !== 'modhub');
            target.enabled.push(self.name);
            target.disabled = target.disabled.filter(name => name.toLowerCase() !== 'modhub');
        }
        const names = new Set(target.packages.map(item => item.name));
        const missing = [...target.enabled, ...target.disabled].filter(name => !names.has(name));
        if (missing.length) riskMessages.push(`以下模组只有启禁记录，没有备份包体：${missing.join('、')}。将还原这些记录的原始状态，无法恢复缺失的安装包；需要时请重新导入。`);
        // 当前工具由本次快照与真实包档案核验，旧点的工具归档不参与最终恢复。
        const archived = { ...target, packages: target.packages.filter(item => item.name !== self?.name) };
        await loadBlobs(env, archived, current.rows);
        await validateBlobs(archived, current.rows);
        const profiles = await targetProfiles(env, target, current);
        const recovery = window.modHubRestore?.getRecoveryInfo?.(target.enabled, profiles) || { order: recoveryOrder(target.enabled, profiles), issues: [] };
        const blockers = recovery.issues.filter(issue => issue.blocking);
        if (blockers.length) fail(blockers.map(issue => issue.message).join('\n'));
        recovery.issues.filter(issue => !issue.blocking).forEach(issue => riskMessages.push(issue.message));
        target.enabled = recovery.order;
        if (!validNames(target.enabled)) fail('恢复工具加载顺序无效');
        if (self && target.settings.modhub_sideload_mod_order !== null) {
            const oldOrder = parseNames(target.settings.modhub_sideload_mod_order);
            const order = oldOrder.filter(name => name.toLowerCase() !== 'modhub');
            order.push(self.name);
            target.settings.modhub_sideload_mod_order = JSON.stringify(recoveryOrder(order, profiles));
        }
        for (const key of MODHUB_SETTINGS) {
            if (target.settings[key] === null && window.localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_')) !== null) target.settings[key] = key.endsWith('mod_order') ? '[]' : 'true';
        }
        const changes = describeChanges(current.state, target);
        const changedNames = new Set([...changes.installed, ...changes.updated, ...changes.removed]);
        const currentProfiles = await targetProfiles(env, { packages: current.state.packages.filter(item => changedNames.has(item.name)) }, current, true);
        const versionOf = (list, name) => {
            const profile = list.find(item => item.name === name);
            return profile ? (typeof profile.bootJson.version === 'string' ? profile.bootJson.version : '') : null;
        };
        const packageVersions = Object.fromEntries([...changedNames].map(name => [name, { current: versionOf(currentProfiles, name), target: versionOf(profiles, name) }]));
        const orderChanges = window.modHubDescribeOrderChanges(current.state.enabled, target.enabled);
        return { target, changes, riskMessages, packageVersions, orderChanges };
    }

    async function preview(id) {
        const result = { id, label: '', at: null, changes: { installed: [], updated: [], removed: [], enabled: [], disabled: [], orderChanged: false, beautyChanged: false, settingsChanged: false }, riskMessages: [], packageVersions: {}, orderChanges: [], canRestore: false };
        try {
            const env = environment();
            const current = await snapshot(env);
            const point = readPoints(current.rows).find(item => item.id === id);
            if (!point) fail('还原点不存在或已过保留期限');
            result.label = point.label;
            result.at = point.at;
            if (restoring || owner || window._modHubManagerBusy || current.rows.get(MODHUB_JOURNAL_KEY)) fail('另一项模组操作或恢复仍在进行');
            const built = await buildTarget(env, current, point);
            return { ...result, changes: built.changes, riskMessages: built.riskMessages, packageVersions: built.packageVersions, orderChanges: built.orderChanges, canRestore: true };
        } catch (error) {
            return { ...result, reason: error.message || String(error) };
        }
    }

    async function runJournal(env, journal) {
        checkTarget(env, journal.target);
        checkTarget(env, journal.source);
        const baseline = await snapshot(env);
        checkReplaySource(journal, baseline.state);
        const rows = baseline.rows;
        await loadBlobs(env, journal.target, rows);
        await validateBlobs(journal.target, rows);
        const actualBeauty = await beautyValue(journal.target.beauty);
        if (journal.target.beauty.exists && !actualBeauty.exists) fail('原美化数据库不存在，恢复暂停');
        const expectedBeauty = journal.target.beauty;
        if (actualBeauty.hasValue !== expectedBeauty.hasValue || actualBeauty.value !== expectedBeauty.value) await beautyValue(expectedBeauty, expectedBeauty);
        const beautyCheck = await beautyValue(expectedBeauty);
        if (beautyCheck.hasValue !== expectedBeauty.hasValue || beautyCheck.value !== expectedBeauty.value) fail('美化配置回读不一致，恢复尚未完成');
        writeSettings(journal.target.settings);
        // 前置库与本地设置完成后，再原子替换全部模组；刷新中断可重放同一目标。
        await guardedModWrite(env, baseline.rows, journal, rows);
        const after = await snapshot(env);
        if (!sameState(after.state, journal.target)) fail('恢复后真实状态回读不一致，已保留恢复记录');
        const point = readPoints(after.rows).find(item => item.id === journal.pointId);
        const success = { id: `restored-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, pointId: journal.pointId, label: journal.pointLabel || point?.label || '所选还原点', at: journal.pointAt ?? point?.at ?? null, safetyPointId: journal.safetyPointId || null };
        // 成功通知与恢复记录清除原子提交，任何一步失败都保留可继续重放的记录。
        await guardedValues(env, after.rows, [[MODHUB_SUCCESS_KEY, success], [MODHUB_STARTUP_KEY, { pending: false, at: Date.now(), changesPending: false, roundId: null, firstPointId: null }]], [MODHUB_JOURNAL_KEY]);
        // 已读入的旧模组仍在内存，必须重新加载，不能放行旧加载循环。
        window.location.reload();
        return true;
    }

    async function restore(id) {
        if (restoring || owner || window._modHubManagerBusy) fail('另一项模组操作或恢复仍在进行');
        restoring = true;
        const recoveryContext = {};
        try {
            const env = environment();
            await storageLock(env, recoveryContext);
            const current = await snapshot(env);
            if (current.rows.get(MODHUB_JOURNAL_KEY)) return await runJournal(env, current.rows.get(MODHUB_JOURNAL_KEY));
            const point = readPoints(current.rows).find(item => item.id === id);
            if (!point) fail('还原点不存在或已过保留期限');
            // 每次提交从真实当前状态重新构建目标，不使用界面预览缓存。
            const { target, changes: change, riskMessages, packageVersions, orderChanges } = await buildTarget(env, current, point);
            const changes = [['installed', '恢复已删除模组'], ['updated', '回退包体'], ['removed', '将移除的模组'], ['enabled', '恢复启用'], ['disabled', '恢复禁用']].filter(([key]) => change[key].length).map(([key, label]) => `${label}：${change[key].map(name => `${name}${['installed', 'updated', 'removed'].includes(key) ? `（${packageVersionText(packageVersions[name])}）` : ''}`).join('、')}`);
            if (change.orderChanged) changes.push('恢复加载顺序');
            if (change.beautyChanged) changes.push('恢复美化配置');
            if (change.settingsChanged) changes.push('恢复管理配置');
            const orderDetail = orderChanges.length ? '\n\n' + (window.modHubT?.('启用模组加载顺序对比') || '启用模组加载顺序对比')
                + '\n' + orderChanges.map(item => item.name + '：' + orderChangeText(item)).join('\n') : '';
            const confirmed = await window.modHubConfirm?.({ title: '确认时间点还原', message: `将还原到“${point.label}”对应的模组状态。\n时间：${pointDate(point.at)}\n\n${changes.join('\n') || '目标与当前模组状态一致'}${orderDetail}\n\n还原前会保存当前模组状态。当前 ModHub 恢复工具与游戏存档保留；还原完成后重新加载。${riskMessages.length ? '\n\n' + riskMessages.join('\n') : ''}`, trustedMessageHtml: restoreConfirmationHtml(point, change, riskMessages, packageVersions, orderChanges), dialogClass: 'modhub-restore-notice', confirmText: '确认还原并重新加载', cancelText: '取消还原', confirmType: 'danger', onRender: dialog => mountDialog(dialog, !startupFinished) });
            if (!confirmed) { restoring = false; recoveryContext.releaseStorageLock?.(); return false; }
            const safety = { version: 1, id: `before-restore-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, label: '还原前状态', kind: 'preRestore', userProtected: false, roundId: bootRound, at: Date.now(), source: sourceMetadata(env), state: current.state };
            const journal = { version: 1, pointId: id, pointLabel: point.label, pointAt: point.at, safetyPointId: safety.id, phase: 'prepared', source: current.state, target };
            const allPoints = [safety, ...readPoints(current.rows)];
            const nextPoints = retainPoints(allPoints, policyConfig, protectedPointIds(allPoints, policyStartup, journal));
            const selfHash = current.state.packages.find(item => item.name.toLowerCase() === 'modhub')?.hash;
            const values = [...current.blobs].filter(([hash]) => hash === selfHash || !current.rows.has(MODHUB_BLOB_PREFIX + hash)).map(([hash, data]) => [MODHUB_BLOB_PREFIX + hash, data]);
            values.push([MODHUB_POINTS_KEY, nextPoints], [MODHUB_JOURNAL_KEY, journal]);
            await guardedValues(env, current.rows, values, garbage(current.rows, nextPoints, journal));
            return await runJournal(env, journal);
        } catch (error) {
            try { restoring = !!(await entries(environment())).get(MODHUB_JOURNAL_KEY); } catch (_) { restoring = true; }
            if (!restoring) recoveryContext.releaseStorageLock?.();
            throw error;
        }
    }

    function loadingElementVisible(element) {
        if (!element) return false;
        for (let node = element; node && node !== document; node = node.parentElement || node.parentNode) {
            if (node.hidden) return false;
            if (typeof window.getComputedStyle === 'function') {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
            }
        }
        return true;
    }

    function startupContainer() {
        const log = document.getElementById('LoadingProgressLog');
        if (loadingElementVisible(log)) return log;
        const screen = document.getElementById('init-screen');
        return loadingElementVisible(screen) ? screen : null;
    }

    function syncStartupHost() {
        const host = document.getElementById('modHubRestoreStartupHost');
        if (startupFinished) return;
        const parent = startupContainer() || document.body;
        if (host && host.parentNode !== parent) {
            host.parentNode?.removeChild(host);
            parent.appendChild(host);
        }
        const button = document.getElementById('modHubRestoreStartupButton');
        if (button && button.parentNode !== parent) {
            button.parentNode?.removeChild(button);
            parent.appendChild(button);
        }
        if (button) button.style.display = gameReady() ? 'none' : '';
    }

    function mountDialog(dialog, startup) {
        if (!startup || !dialog?.parentNode) return;
        const container = startupContainer() || document.body;
        let host = document.getElementById('modHubRestoreStartupHost');
        if (!host) { host = document.createElement('section'); host.id = 'modHubRestoreStartupHost'; container.appendChild(host); }
        else syncStartupHost();
        dialog.parentNode.parentNode?.removeChild(dialog.parentNode);
        host.appendChild(dialog.parentNode);
    }

    async function showHistory(options = {}) {
        return window.modHubShowRestorePanel(options);
    }

    function addStartupStyle() {
        if (!document.head || document.getElementById('modHubRestoreStartupStyle')) return;
        const style = document.createElement('style');
        style.id = 'modHubRestoreStartupStyle';
        style.textContent = '#modHubRestoreStartupHost{font:16px/1.6 sans-serif;text-align:left;white-space:normal;pointer-events:auto}#modHubRestoreStartupHost .modhub-modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(2px);padding:16px;box-sizing:border-box}#modHubRestoreStartupHost .modhub-modal-dialog{width:100%;max-width:440px;max-height:calc(100dvh - 92px);overflow:auto;background:var(--850,#222);border:1px solid var(--600,#666);box-shadow:0 10px 30px rgba(0,0,0,.85);color:var(--100,#eee);padding:16px;box-sizing:border-box}#modHubRestoreStartupHost .modhub-modal-header,#modHubRestoreStartupHost .modhub-modal-footer{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}#modHubRestoreStartupHost .modhub-modal-title{color:#d6b365}#modHubRestoreStartupHost .modhub-modal-message{margin:12px 0;overflow-wrap:anywhere}#modHubRestoreStartupHost .modhub-modal-select-wrap{display:block}#modHubRestoreStartupHost select{width:100%;min-width:0;min-height:32px;background:#333;color:#eee}#modHubRestoreStartupHost button{min-height:32px;flex-shrink:0;background:#333;color:#eee;border:1px solid #777;padding:6px 10px}#modHubRestoreStartupHost .modhub-modal-footer{margin-top:16px}#modHubRestoreStartupHost .modhub-modal-btn-confirm{border-color:#d6b365}#modHubRestoreStartupHost .modhub-modal-close{margin-left:auto}#modHubRestoreStartupHost .modhub-modal-body{padding-bottom:60px}';
        style.textContent += '#modHubRestoreStartupHost .modhub-modal-footer>button{flex:1 1 0;box-sizing:border-box;min-width:0!important;max-width:100%;height:auto!important;min-height:32px;white-space:normal!important;overflow-wrap:anywhere;line-height:1.4!important}';
        style.textContent += '#modHubRestoreStartupHost .modhub-modal-backdrop:has(>.modhub-restore-notice){padding:16px 16px calc(60px + env(safe-area-inset-bottom))}#modHubRestoreStartupHost .modhub-modal-dialog.modhub-restore-notice{max-width:560px;max-height:calc(100dvh - 76px - env(safe-area-inset-bottom));display:flex;flex-direction:column;min-height:0;overflow:hidden}#modHubRestoreStartupHost .modhub-restore-notice .modhub-modal-header,#modHubRestoreStartupHost .modhub-restore-notice .modhub-modal-footer{flex-shrink:0}#modHubRestoreStartupHost .modhub-restore-notice .modhub-modal-body,#modHubRestoreStartupHost .modhub-restore-notice .modhub-modal-message{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding-bottom:0}#modHubRestoreStartupHost .modhub-restore-notice p{margin:0 0 12px;flex-shrink:0}#modHubRestoreStartupHost .modhub-restore-notice-section{min-height:0;display:flex;flex-direction:column}#modHubRestoreStartupHost .modhub-restore-notice-list{min-height:0;max-height:min(260px,30dvh);overflow:auto;overscroll-behavior:contain;padding:0 0 0 24px;margin:0 0 12px;scrollbar-gutter:stable;-webkit-overflow-scrolling:touch}#modHubRestoreStartupHost .modhub-restore-notice-list li{padding:4px 0;overflow-wrap:anywhere}#modHubRestoreStartupHost .modhub-restore-notice .gold{color:var(--gold,#d6b365)}#modHubRestoreStartupHost .modhub-restore-notice .red{color:var(--red,#ed7878)}#modHubRestoreStartupHost .modhub-restore-notice .green{color:var(--green,#88bd86)}#modHubRestoreStartupHost .modhub-restore-notice .grey{color:var(--400,#aaa)}';
        document.head.appendChild(style);
    }

    let startupReason = '';
    let startupStage = '';
    const startupNow = () => typeof window.performance?.now === 'function' ? window.performance.now() : Date.now();
    let startupProgressAt = startupNow();

    function syncStartupUi() {
        syncStartupHost();
        const button = document.getElementById('modHubRestoreStartupButton');
        if (button) {
            button.style.display = startupReason && !startupFinished && !gameReady() ? '' : 'none';
            const reasonText = window.modHubT?.(startupReason) || startupReason;
            const buttonText = window.modHubT?.('加载遇到问题？尝试时间点恢复') || '加载遇到问题？尝试时间点恢复';
            button.title = reasonText;
            button.setAttribute('aria-label', reasonText ? `${reasonText} ${buttonText}` : buttonText);
            button.textContent = buttonText;
        }
        const reason = document.getElementById('modHubRestoreStartupReason');
        if (reason) {
            if (button?.parentNode && reason.parentNode !== button.parentNode) { reason.parentNode?.removeChild(reason); button.parentNode.appendChild(reason); }
            reason.textContent = window.modHubT?.(startupReason) || startupReason;
            reason.style.display = button?.style.display === '' ? '' : 'none';
        }
    }

    function askStartup(reason) {
        if (startupFinished || restoring) return;
        startupReason = reason;
        syncStartupUi();
    }

    function openStartupPanel() {
        if (decisionGate && startupPrompted || restoring) return decisionGate;
        startupPrompted = true;
        decisionGate = Promise.resolve().then(() => window.modHubShowRestorePanel({ startup: true, reason: startupReason }))
            .catch(error => console.warn('[ModHub] 启动还原面板无法打开', error))
            .finally(() => { startupPrompted = false; startupProgressAt = startupNow(); });
        return decisionGate;
    }

    async function guard(stage, modName, fileName) {
        const progress = `${stage || ''}:${modName || ''}:${fileName || ''}`;
        if (progress !== startupStage) { startupStage = progress; startupProgressAt = startupNow(); }
        syncStartupUi();
        await startupGate;
        if (decisionGate) await decisionGate;
        if (restoring) await new Promise(() => {});
    }

    function recordStartup(level, message, controller) {
        syncStartupUi();
        const text = String(message || '');
        if (!text) return;
        const record = { level, message: text, time: Date.now() };
        startupLogs.push(record);
        if (startupLogs.length > 500) startupLogs.shift();
        // 上游有日志 hook 时停止缓存对应日志，需继续写入供旧诊断入口读取。
        controller?.logRecordBeforeAnyLogHookRegister?.push({ type: level, message: text, time: new Date(record.time) });
        if (level === 'error' && !startupFinished && !/ResizeObserver|modlist\.json|duplicate name/i.test(text)) askStartup('模组加载出现错误，可以尝试还原或继续等待。');
    }

    async function initStartup() {
        const env = environment();
        const startupContext = {};
        try { await storageLock(env, startupContext); }
        catch (error) {
            if ((await entries(env)).get(MODHUB_JOURNAL_KEY)) {
                restoring = true;
                await window.modHubConfirm?.({ title: '恢复操作被其他页面占用', message: `${error.message}\n游戏加载已暂停，请关闭其他游戏页面后重新进入。`, cancelText: '', onRender: dialog => mountDialog(dialog, true) });
                return;
            }
            throw error;
        }
        let shouldPrompt = false;
        try {
            const rows = await entries(env);
            const journal = rows.get(MODHUB_JOURNAL_KEY);
            if (journal) {
                restoring = true;
                try { await runJournal(env, journal); } catch (error) {
                    if (error.code === 'MODHUB_RESTORE_CONFLICT') {
                        const stop = await window.modHubConfirm?.({ title: '正在恢复的操作未完成', message: `${error.message}\n\n当前保存的配置与本次恢复记录不一致，重新打开游戏不会自动解除此冲突。\n\n可停止本次恢复并重新加载，保留当前已保存的模组和配置。原还原点和还原前状态将设为手动保护，便于重新选择或撤销本次还原；确认不再需要后，可在时间点还原中取消保护。已完成的部分恢复不会撤销。选择保留恢复记录或关闭窗口时，游戏加载仍将暂停。`, confirmText: '停止本次恢复', cancelText: '保留恢复记录', confirmType: 'danger', onRender: dialog => mountDialog(dialog, true) });
                        if (stop !== true) return;
                        try {
                            const current = await entries(env);
                            if (!same(current.get(MODHUB_JOURNAL_KEY), journal)) throw busy('恢复记录已被其他页面修改，未停止恢复');
                            const points = parsePoints(current.get(MODHUB_POINTS_KEY)).map(point =>
                                point.id === journal.pointId || point.id === journal.safetyPointId
                                    || !journal.safetyPointId && pointKind(point) === 'preRestore' && sameState(point.state, journal.source)
                                    ? { ...point, userProtected: true } : point);
                            // 用户确认后保留两个引用点，防止解除日志保护后立即被历史配额清理。
                            await guardedValues(env, current, [[MODHUB_POINTS_KEY, points]], [MODHUB_JOURNAL_KEY, MODHUB_SUCCESS_KEY]);
                            await transaction(env, 'readonly', (store, done) => {
                                for (const [key, expected] of [[MODHUB_JOURNAL_KEY, undefined], [MODHUB_SUCCESS_KEY, undefined], [MODHUB_POINTS_KEY, points]]) {
                                    const request = store.get(key);
                                    request.onsuccess = () => { if (!same(request.result, expected)) done.fail(new Error('停止恢复后记录回读不一致')); };
                                }
                            });
                            window.location.reload();
                        } catch (cause) {
                            await window.modHubConfirm?.({ title: '停止恢复未完成', message: `${cause.message}\n\n停止操作尚未核验完成，游戏加载仍将暂停。请重新打开游戏后核对。`, cancelText: '', onRender: dialog => mountDialog(dialog, true) });
                        }
                        return;
                    }
                    await window.modHubConfirm?.({ title: '正在恢复的操作未完成', message: `${error.message}\n\n游戏加载已暂停。关闭其他游戏页面、释放空间后重新进入，将继续同一恢复操作。`, cancelText: '', onRender: dialog => mountDialog(dialog, true) });
                }
                return;
            }
            const previous = rows.get(MODHUB_STARTUP_KEY);
            // 仅下一次启动读取既有成功记录，旧首屏不能提前宣告这次还原已启动成功。
            successNotice = rows.get(MODHUB_SUCCESS_KEY) || null;
            let points = readPoints(rows);
            if (previous?.roundId && (previous.changesPending || previous.pending) && points.some(point => point.roundId === previous.roundId)) {
                bootRound = previous.roundId;
                roundFirstId = previous.firstPointId || points.filter(point => point.roundId === bootRound).at(-1)?.id;
                roundHasChanges = !!previous.changesPending;
            }
            if (points.some(point => point.pending)) {
                const current = await snapshot(env);
                points = points.filter(point => {
                    if (!point.pending) return true;
                    if (sameState(point.state, current.state)) return false;
                    point.pending = false;
                    point.summary = describeChanges(point.state, current.state);
                    bootRound = point.roundId;
                    roundHasChanges = true;
                    return true;
                });
                roundFirstId = points.filter(point => point.roundId === bootRound).at(-1)?.id || null;
            }
            points = retainPoints(points);
            startupMarker = { pending: true, at: Date.now(), roundId: bootRound, firstPointId: roundFirstId, changesPending: roundHasChanges };
            await putValues(env, [[MODHUB_POINTS_KEY, points], [MODHUB_STARTUP_KEY, startupMarker]], garbage(rows, points, null));
            shouldPrompt = !!previous?.pending;
        } finally {
            if (!restoring) startupContext.releaseStorageLock?.();
        }
        if (shouldPrompt) askStartup('上次游戏启动未完成，可以尝试时间点恢复。');
    }

    function gameReady() {
        if (!window.SugarCube?.State?.passage) return false;
        return !['init-screen', 'LoadingProgressLog'].some(id => loadingElementVisible(document.getElementById(id)));
    }

    async function markStartupSuccess() {
        if (startupFinished || restoring || !gameReady()) return;
        if (!startupMarker) return;
        const startupContext = {};
        try { await storageLock(environment(), startupContext); }
        catch (error) { console.warn('[ModHub] 当前页面无法写入启动完成标记', error); return; }
        try {
            await transaction(environment(), 'readwrite', (store, done) => {
                const request = store.get(MODHUB_STARTUP_KEY);
                request.onsuccess = () => {
                    // 已显示的旧首屏不能替其他页面后来安装的配置作启动验证。
                    if (same(request.result, startupMarker)) {
                        store.put({ pending: false, at: Date.now(), roundId: null, firstPointId: null, changesPending: false }, MODHUB_STARTUP_KEY);
                        done(true);
                    }
                };
            }).then(verified => { startupVerified = verified === true; });
            startupFinished = true;
            document.getElementById('modHubRestoreStartupButton')?.remove();
            document.getElementById('modHubRestoreStartupReason')?.remove();
            bootRound = `round-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            roundFirstId = null;
            roundHasChanges = false;
        }
        catch (error) { console.warn('[ModHub] 启动完成标记无法保存', error); }
        finally { startupContext.releaseStorageLock?.(); }
    }

    async function showRestoreSuccess() {
        if (!successNotice || startupFinished && !startupVerified) return true;
        if (!startupFinished || !gameReady() || restoring || owner || window._modHubManagerBusy || successNoticeBusy || typeof window.modHubConfirm !== 'function' || document.querySelector?.('.modhub-modal-backdrop,.modhub-restore-panel-overlay')) return false;
        const env = environment();
        successNoticeBusy = true;
        try {
            // 提示使用独立页面锁，不阻塞正常加载或模组管理；关闭后只消费同一条记录。
            await window.navigator.locks.request(`modhub-restore-notice:${env.dbName}:${env.storeName}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
                if (!lock) return;
                const rows = await entries(env);
                if (!same(rows.get(MODHUB_SUCCESS_KEY), successNotice)) { successNotice = null; return; }
                if (rows.get(MODHUB_JOURNAL_KEY) || rows.get(MODHUB_STARTUP_KEY)?.pending || rows.get(MODHUB_STARTUP_KEY)?.changesPending) return;
                if (!successNoticeClosed) {
                    const safetyExists = parsePoints(rows.get(MODHUB_POINTS_KEY)).some(point => point.id === successNotice.safetyPointId);
                    const time = pointDate(successNotice.at);
                    const target = `${successNotice.label || '所选还原点'}${time === '时间未记录' ? '' : `（${time}）`}`;
                    const undo = safetyExists ? '还原前的模组状态已保存为“还原前状态”，需要时可选择该点撤销此次还原。' : '';
                    await window.modHubConfirm?.({ title: '时间点还原已成功完成', message: `模组状态已还原到 ${target}。\n游戏已重新加载，游戏存档未受影响。${undo ? '\n\n' + undo : ''}`, trustedMessageHtml: `<p><strong class="green">时间点还原已成功完成。</strong></p><p>模组状态已还原到 <strong class="gold" data-modhub-no-translate>${escapeHtml(successNotice.label || '所选还原点')}</strong>${time === '时间未记录' ? '' : `<br>时间：<strong class="gold">${escapeHtml(time)}</strong>`}。</p><p><strong class="green">游戏存档未受影响。</strong>游戏已重新加载。</p>${undo ? '<p>还原前的模组状态已保存为<strong class="gold">“还原前状态”</strong>，需要时可选择该点<strong class="gold">撤销此次还原</strong>。</p>' : ''}`, dialogClass: 'modhub-restore-notice', confirmText: '关闭', cancelText: '' });
                    successNoticeClosed = true;
                }
                await transaction(env, 'readwrite', store => {
                    const request = store.get(MODHUB_SUCCESS_KEY);
                    request.onsuccess = () => { if (same(request.result, successNotice)) store.delete(MODHUB_SUCCESS_KEY); };
                });
                successNotice = null;
            });
        } catch (error) { console.warn('[ModHub] 还原完成提示尚未处理，将在稍后重试', error); }
        finally { successNoticeBusy = false; }
        return !successNotice;
    }

    window.modHubRestore = { createOperation, prepare, finish, withOperation, claim, release, isOperationBlocked, list, showHistory, restore, commitPackageChanges, keepRecoveryOrder: recoveryOrder, isRestoring: () => restoring, getStartupLogs: () => [...startupLogs] };
    Object.assign(window.modHubRestore, { getPanelState, saveConfig, createPoint, deletePoints, setPointProtection, preview, getRecoveryInfo, mountDialog,
        readBeautyOrder: async () => {
            const value = await beautyValue(beautyDescriptor(environment()));
            validateBeauty(value);
            return value.hasValue ? parseNames(value.value) : null;
        },
        getStorageIdentity: () => { const { dbName, storeName } = environment(); return { dbName, storeName }; } });
    window.modHubKeepRecoveryOrder = window.modHubKeepRecoveryOrder || recoveryOrder;
    window.addEventListener?.('modhub:languagechange', syncStartupUi);
    if (!window.indexedDB || typeof window.modUtils?.getModLoader !== 'function') return;
    try {
        const env = environment();
        const controller = window.modModLoadController || env.utils.getModLoadController?.();
        if (typeof controller?.addLifeTimeCircleHook !== 'function') return;
        addStartupStyle();
        const cached = [...(controller.logRecordBeforeAnyLogHookRegister || [])];
        const hook = {};
        ['InjectEarlyLoad_start', 'InjectEarlyLoad_end', 'EarlyLoad_start', 'EarlyLoad_end', 'Load_start', 'Load_end', 'PatchModToGame_start', 'PatchModToGame_end', 'ModLoaderLoadEnd'].forEach(stage => { hook[stage] = (modName, fileName) => guard(stage, modName, fileName); });
        ['logInfo', 'logWarning', 'logError'].forEach((name, index) => { hook[name] = message => recordStartup(['info', 'warning', 'error'][index], message, controller); });
        controller.addLifeTimeCircleHook('modHubRestore', hook);
        cached.slice(-500).forEach(record => {
            startupLogs.push({ level: record.type || 'info', message: String(record.message || ''), time: Number(record.time?.valueOf?.()) || Date.now() });
        });
        if (cached.some(record => record.type === 'error' && !/ResizeObserver|modlist\.json|duplicate name/i.test(record.message || ''))) askStartup('模组加载已有错误记录，可以尝试还原或继续等待。');
        window.addEventListener?.('error', event => { if (event.message) recordStartup('error', event.message, controller); });
        window.addEventListener?.('unhandledrejection', event => recordStartup('error', event.reason?.message || event.reason, controller));
        startupGate = initStartup().catch(error => { console.warn('[ModHub] 启动恢复守卫初始化失败', error); askStartup(`启动恢复检查未完成：${error.message}`); });
        window.modHubRestore.startupReady = startupGate;
        window.jQuery?.(document).one?.(':storyready.modHubRestore', () => { startupGate.then(markStartupSuccess); });
        const timer = setInterval(async () => {
            syncStartupUi();
            if (restoring) return;
            if (gameReady()) {
                await startupGate;
                await markStartupSuccess();
                if (await showRestoreSuccess()) clearInterval(timer);
            } else if (startupNow() - startupProgressAt >= MODHUB_TIMEOUT) askStartup('加载已超过 60 秒没有阶段进展，可以继续等待或尝试时间点恢复。');
        }, 1000);
        if (screenVisible()) {
            const screen = document.getElementById('init-screen');
            const button = document.createElement('button');
            button.id = 'modHubRestoreStartupButton';
            button.textContent = '加载遇到问题？尝试时间点恢复';
            button.style.cssText = 'position:fixed;bottom:calc(60px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);min-height:32px;background:#333;color:#eee;border:1px solid #d6b365;padding:8px 16px;max-width:calc(100% - 32px);pointer-events:auto;';
            button.style.display = 'none';
            button.onclick = openStartupPanel;
            (startupContainer() || screen).appendChild(button);
            const reason = document.createElement('p');
            reason.id = 'modHubRestoreStartupReason';
            reason.style.cssText = 'position:fixed;bottom:calc(112px + env(safe-area-inset-bottom));left:16px;right:16px;color:#ddd;text-align:center;white-space:normal;font:14px/1.5 sans-serif;pointer-events:none;';
            reason.style.display = 'none';
            (startupContainer() || screen).appendChild(reason);
            syncStartupUi();
        }
    } catch (error) { console.warn('[ModHub] 当前环境无法启用加载期还原', error); }

    function screenVisible() { return !!document.getElementById('init-screen'); }
})();
