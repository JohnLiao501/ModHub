/** ModHub 环境迁移：只保存清单，通过当前目录重新选版安装。 */
(function() {
    'use strict';
    const MODHUB_MIGRATION_KEY = 'modhub_migration_task_v1';
    const MODHUB_MIGRATION_LIMIT = 1024 * 1024;
    const MODHUB_MIGRATION_COUNT = 1000;
    const MODHUB_MIGRATION_PAGE = Date.now() + '-' + Math.random().toString(36).slice(2);
    const MODHUB_MIGRATION_PHASES = ['installing', 'partial', 'reload', 'beauty', 'complete'];
    const MODHUB_MIGRATION_SUMMARY = ['added', 'updated', 'reused', 'enabled', 'disabled', 'orderChanged', 'beautyApplied', 'missing', 'skipped', 'failed'];
    let pendingTask = null, taskError = null, storedTaskStamp, running = false;
    const t = (key, params) => window.modHubT?.(key, params) || key;
    const fail = message => { throw new Error(t(message)); };
    const key = value => String(value || '').toLowerCase();
    const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const market = () => window.modHubMarket || fail('模组市场尚未就绪，请重新载入后重试。');
    function object(value, fields) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(name => !fields.includes(name))) fail('迁移清单包含未知字段或无效对象。');
        return value;
    }
    function text(value, limit = 200, empty = true) {
        if (typeof value !== 'string' || value.length > limit || !empty && !value.trim()
            || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
            || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('迁移清单包含无效文字。');
        return value;
    }
    function list(value) {
        if (!Array.isArray(value) || value.length > MODHUB_MIGRATION_COUNT) fail('迁移清单条目过多或列表格式无效。');
        return value;
    }
    function names(value) {
        const result = list(value).map(name => text(name, 200, false));
        if (new Set(result.map(key)).size !== result.length) fail('迁移清单包含重复技术名。');
        return result;
    }
    function boolean(value) {
        if (typeof value !== 'boolean') fail('迁移清单启禁状态无效。');
        return value;
    }
    function variant(value) {
        if (value === null) return null;
        object(value, ['groupId', 'type', 'id']);
        if (!['language', 'edition'].includes(value.type)) fail('迁移清单发行选项无效。');
        return { groupId: text(value.groupId, 128, false), type: value.type, id: text(value.id, 48, false) };
    }
    function reference(value) {
        object(value, ['identityId', 'id', 'bootName', 'variant']);
        return { identityId: text(value.identityId || ''), id: text(value.id || ''), bootName: text(value.bootName, 200, false), variant: variant(value.variant ?? null) };
    }
    function normalize(value) {
        object(value, ['type', 'schemaVersion', 'createdAt', 'source', 'mods', 'beauty']);
        if (value.type !== 'modhub-migration' || value.schemaVersion !== 1) fail('不支持此迁移清单版本。');
        const createdAt = text(value.createdAt, 40, false);
        if (!Number.isFinite(Date.parse(createdAt))) fail('迁移清单创建时间无效。');
        object(value.source, ['modHubVersion', 'gameVersion', 'gameBranch', 'gameBranchVersion', 'loaderVersion']);
        const source = Object.fromEntries(['modHubVersion', 'gameVersion', 'gameBranch', 'loaderVersion'].map(name => [name, text(value.source[name], 100)]));
        source.gameBranchVersion = text(value.source.gameBranchVersion || '', 100);
        const mods = list(value.mods).map(item => {
            object(item, ['bootName', 'version', 'enabled', 'order', 'identityId', 'id', 'variant', 'packageEditionId', 'optionalBootNames', 'componentEnabled', 'componentOrder', 'componentVersions']);
            if (!Number.isSafeInteger(item.order) || item.order < 0 || item.order >= MODHUB_MIGRATION_COUNT) fail('迁移清单加载顺序无效。');
            const ref = reference({ identityId: item.identityId, id: item.id, bootName: item.bootName, variant: item.variant });
            const optionalBootNames = names(item.optionalBootNames);
            if (optionalBootNames.some(name => key(name) === key(ref.bootName))) fail('迁移清单包含重复技术名。');
            object(item.componentEnabled, [ref.bootName, ...optionalBootNames]);
            const componentEnabled = Object.fromEntries(Object.entries(item.componentEnabled).map(([name, enabled]) => [text(name, 200, false), boolean(enabled)]));
            const componentOrder = { [ref.bootName]: item.order }, componentVersions = { [ref.bootName]: text(item.version) };
            if (item.componentOrder !== undefined) {
                object(item.componentOrder, [ref.bootName, ...optionalBootNames]);
                for (const [name, position] of Object.entries(item.componentOrder)) {
                    if (!Number.isSafeInteger(position) || position < 0 || position >= MODHUB_MIGRATION_COUNT) fail('迁移清单加载顺序无效。');
                    componentOrder[name] = position;
                }
                if (componentOrder[ref.bootName] !== item.order) fail('迁移清单加载顺序无效。');
            }
            if (item.componentVersions !== undefined) {
                object(item.componentVersions, [ref.bootName, ...optionalBootNames]);
                for (const [name, version] of Object.entries(item.componentVersions)) componentVersions[name] = text(version);
                if (componentVersions[ref.bootName] !== item.version) fail('迁移清单包含无效文字。');
            }
            return { ...ref, version: text(item.version), enabled: boolean(item.enabled), order: item.order,
                packageEditionId: text(item.packageEditionId, 128), optionalBootNames, componentEnabled, componentOrder, componentVersions };
        });
        const allNames = mods.flatMap(item => [item.bootName, ...item.optionalBootNames]);
        const positions = mods.flatMap(item => Object.values(item.componentOrder));
        if (new Set(allNames.map(key)).size !== allNames.length || new Set(positions).size !== positions.length) fail('迁移清单包含重复技术名或加载位置。');
        object(value.beauty, ['enabled', 'disabled', 'autoEnable']);
        const beautyItems = items => list(items).map(item => {
            object(item, ['type', 'bootName']);
            return { type: text(item.type, 200, false), bootName: text(item.bootName, 200, false) };
        });
        const beauty = { enabled: beautyItems(value.beauty.enabled), disabled: beautyItems(value.beauty.disabled), autoEnable: boolean(value.beauty.autoEnable) };
        const beautyKeys = [...beauty.enabled, ...beauty.disabled].map(item => item.type);
        if (new Set(beautyKeys).size !== beautyKeys.length) fail('迁移清单包含重复美化项。');
        return { type: value.type, schemaVersion: 1, createdAt, source, mods: mods.sort((a, b) => a.order - b.order), beauty };
    }
    function parse(input) {
        const serialized = typeof input === 'string' ? input : JSON.stringify(input);
        if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > MODHUB_MIGRATION_LIMIT) fail('迁移清单超过 1 MiB。');
        let value;
        try { value = JSON.parse(serialized); } catch (_) { fail('迁移清单不是有效 JSON。'); }
        return normalize(value);
    }
    const descriptor = mod => ({ identityId: String(mod.identityId || ''), id: String(mod.id || ''),
        bootName: mod.bootNames?.[0] || mod.packageEditions?.[0]?.bootName || mod.name,
        variant: mod.variant ? { groupId: mod.variant.groupId, type: mod.variant.type, id: mod.variant.id } : null });
    function variantMatches(record, mod) {
        if (!record.variant) return true;
        return mod.variant && ['groupId', 'type', 'id'].every(name => key(record.variant[name]) === key(mod.variant[name]));
    }
    function candidates(record, catalog) {
        let matches;
        if (record.identityId) matches = catalog.filter(mod => key(mod.identityId) === key(record.identityId));
        else if (record.id) matches = catalog.filter(mod => key(mod.id) === key(record.id));
        else matches = catalog.filter(mod => (mod.bootNames || []).some(name => key(name) === key(record.bootName))
            || (mod.packageEditions || []).some(item => key(item.bootName) === key(record.bootName)));
        return matches.filter(mod => variantMatches(record, mod));
    }
    async function refresh(withCatalog = true) {
        if (typeof window.modHubLoadModManageState !== 'function') fail('模组管理尚未就绪，请重新载入后重试。');
        await window.modHubLoadModManageState(true);
        const api = market();
        if (withCatalog && !api.getMarketMods().length) await api.loadMarketData();
        if (withCatalog && api.isCatalogLoading?.()) fail('市场和本地模组资料正在核对，请稍后重试。');
        await api.refreshLocalPackageProfiles();
        return api.getMarketMods().filter(mod => mod.contentType !== 'spell' && !mod.isLanguageGroup);
    }
    async function readLists() {
        const lists = await window.modHubReadIndexDBModLists();
        if (!lists?.ok) throw lists?.error || new Error(t('无法读取真实模组列表。'));
        names([...lists.enabled, ...lists.disabled]);
        return lists;
    }
    const declaredNames = mod => [...(mod.bootNames || []), ...(mod.packageEditions || []).map(item => item.bootName)];
    const rowKey = row => row.localOnly ? 'local:' + key(row.record.bootName) : market().getMarketModKey(row.mod);
    async function buildManifest() {
        try { await market().loadMarketData(); }
        catch (error) { throw new Error(t('模组目录暂不可用，无法完整导出迁移清单。请联网加载市场后重试。') + '\n' + String(error.message || error)); }
        const catalog = await refresh(false), lists = await readLists();
        if (!catalog.length) fail('模组目录暂不可用，无法完整导出迁移清单。请联网加载市场后重试。');
        const registered = [...lists.enabled, ...lists.disabled];
        const configured = window._modHubModState?.sideMods?.map(item => item.name) || [];
        const ordered = configured.length === registered.length && new Set(configured).size === registered.length && configured.every(name => registered.includes(name))
            ? configured : registered;
        const installed = new Map();
        for (const name of ordered) {
            const item = await window.modHubReadInstalledModBoot(name);
            if (item?.error) throw item.error;
            if (!item?.bootJson || item.missing) fail('存在无法读取的模组，请刷新列表后重试导出。');
            installed.set(name, item.bootJson);
        }
        const records = [], folded = new Set();
        for (const name of ordered) {
            if (folded.has(key(name))) continue;
            const owners = catalog.filter(mod => declaredNames(mod).some(value => key(value) === key(name)));
            const mod = owners.length === 1 ? owners[0] : null;
            const optionalBootNames = (mod?.optionalResources || []).flatMap(item => ordered.filter(value => key(value) === key(item.bootName)));
            optionalBootNames.forEach(value => folded.add(key(value)));
            const boot = installed.get(name);
            const edition = mod && window.modHubMarketVariants?.getPackageEdition?.(mod, { name, version: boot.version, bootJson: boot });
            records.push({ bootName: name, version: String(boot.version || ''), enabled: lists.enabled.includes(name), order: ordered.indexOf(name),
                identityId: String(mod?.identityId || ''), id: String(mod?.id || ''), variant: mod?.variant ? { groupId: mod.variant.groupId, type: mod.variant.type, id: mod.variant.id } : null,
                packageEditionId: edition?.id || '', optionalBootNames,
                componentEnabled: Object.fromEntries([name, ...optionalBootNames].map(value => [value, lists.enabled.includes(value)])),
                componentOrder: Object.fromEntries([name, ...optionalBootNames].map(value => [value, ordered.indexOf(value)])),
                componentVersions: Object.fromEntries([name, ...optionalBootNames].map(value => [value, String(installed.get(value).version || '')])) });
        }
        // 资源可能排在主包之前，统一在建立完整父项后折入。
        const mods = records.filter(item => !folded.has(key(item.bootName)));
        const addon = window.addonBeautySelectorAddon;
        const all = typeof addon?.getTypeOrder === 'function' ? addon.getTypeOrder() : [];
        const enabled = new Set((addon?.typeOrderUsed || []).map(item => item.type));
        const beautyItem = item => ({ type: item.type, bootName: window.modHubGetBeautyModName?.(item) || item.modRef?.mod?.name || item.modRef?.name || '' });
        const beauty = { enabled: (addon?.typeOrderUsed || []).map(beautyItem).filter(item => item.bootName),
            disabled: all.filter(item => !enabled.has(item.type)).map(beautyItem).filter(item => item.bootName), autoEnable: window.modHubIsAutoBeautyEnabled?.() !== false };
        const game = window.modHubMarketVersions?.getGameIdentity?.() || {};
        const self = installed.get('ModHub');
        return parse({ type: 'modhub-migration', schemaVersion: 1, createdAt: new Date().toISOString(),
            source: { modHubVersion: String(self?.version || ''), gameVersion: String(game.version || ''), gameBranch: String(game.branch || ''), gameBranchVersion: String(game.branchVersion || ''),
                loaderVersion: String(window.modUtils?.version || window.modHubGetGui?.()?.gModUtils?.version || '') }, mods, beauty });
    }
    async function exportManifest() {
        const read = async () => {
            if (running || market().isInstallBusy?.() || window.modHubRestore?.isOperationBlocked?.()) fail('已有模组操作正在进行，请完成后再导出清单。');
            const before = await readLists(), manifest = await buildManifest(), after = await readLists();
            if (!equal(before.enabled, after.enabled) || !equal(before.disabled, after.disabled)) fail('导出期间模组配置已改变，请重新导出。');
            return manifest;
        };
        let identity;
        try { identity = window.modHubRestore?.getStorageIdentity?.(); } catch (_) {}
        if (!identity || !window.navigator?.locks?.request) return read();
        return window.navigator.locks.request('modhub:' + identity.dbName + ':' + identity.storeName,
            { mode: 'shared', ifAvailable: true }, lock => {
                if (!lock) fail('另一个页面正在修改模组，请完成后再导出清单。');
                return read();
            });
    }
    function autoAvailable(mod) {
        return mod.autoInstall !== false && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:[/?#]|$)/i.test(mod.githubUrl || '')
            && !market().isWithdrawn?.(mod) && !mod._isDeadRepo && !market().isDeadRepo?.(mod.githubUrl, mod)
            && (mod.catalogSource !== 'community' || market().hasCommunityReleaseSource?.(mod));
    }
    async function preview(input, { choices = {}, selectedNames, catalog: providedCatalog, taskId } = {}) {
        const manifest = parse(input), catalog = providedCatalog || await refresh();
        const task = taskId ? await loadTask({ strict: true }) : null;
        if (taskId && (!task || task.id !== taskId || !equal(task.manifest, manifest))) fail('迁移任务与本次清单不一致，请重新打开后继续。');
        choices = { ...(task?.choices || {}), ...choices };
        const lists = await readLists();
        const protectedNames = window.modHubRestore?.getRecoveryInfo?.(lists.enabled)?.protectedNames || [];
        const chosen = new Set(selectedNames || task?.selectedNames || manifest.mods.map(item => item.bootName));
        const rows = manifest.mods.map(record => {
            let matches = candidates(record, catalog);
            const choice = Object.prototype.hasOwnProperty.call(choices, record.bootName) ? choices[record.bootName] : undefined;
            if (choice) matches = typeof choice === 'string' ? catalog.filter(mod => market().getMarketModKey(mod) === choice) : candidates(reference(choice), catalog);
            let mod = matches.length === 1 ? matches[0] : null;
            const preserved = [record.bootName, ...record.optionalBootNames, ...(mod ? declaredNames(mod) : [])].some(candidate => key(candidate) === 'modhub'
                || protectedNames.some(name => key(name) === key(candidate)));
            let status = preserved ? 'preserved' : matches.length > 1 ? 'ambiguous' : !mod ? 'unmatched' : !autoAvailable(mod) ? 'manual' : 'ready';
            const reason = { preserved: '保留目标环境的恢复工具及必要前置。', ambiguous: '身份对应多个目录项目，请明确选择。',
                unmatched: '当前目录没有精确匹配，请手动导入或明确选择市场项目。', manual: '此项目没有可用的自动下载来源，请按作者说明手动导入。',
                ready: '将按当前游戏版本重新选版。' }[status];
            return { record, mod, status, reason, selected: status === 'ready' && chosen.has(record.bootName) };
        });
        for (const row of rows) {
            row.current = [];
            const targetNames = [...(row.mod ? declaredNames(row.mod) : []), row.record.bootName, ...row.record.optionalBootNames];
            for (const name of [...lists.enabled, ...lists.disabled].filter(name => targetNames.some(value => key(value) === key(name)))) {
                const installed = await window.modHubReadInstalledModBoot(name);
                if (installed.error || !installed.bootJson) continue;
                row.current.push({ bootName: name, version: String(installed.bootJson.version || ''), enabled: lists.enabled.includes(name) });
            }
            if (!['manual', 'unmatched'].includes(row.status)) continue;
            const localPackages = [];
            for (const name of [row.record.bootName, ...row.record.optionalBootNames]) {
                if (![...lists.enabled, ...lists.disabled].includes(name)) break;
                const installed = await window.modHubReadInstalledModPackage(name);
                if (installed?.error || installed?.missing || installed?.bootJson?.name !== name) break;
                const digest = await market().getPackageDigest(installed.data);
                if (!digest) break;
                localPackages.push({ name, version: String(installed.bootJson.version || ''), digest });
            }
            if (localPackages.length === 1 + row.record.optionalBootNames.length) {
                row.mod ||= { name: row.record.bootName, bootNames: [row.record.bootName] };
                for (const item of localPackages) {
                    const current = row.current.find(value => value.bootName === item.name);
                    if (current) current.version = item.version;
                    else row.current.push({ bootName: item.name, version: item.version, enabled: lists.enabled.includes(item.name) });
                }
                Object.assign(row, { status: 'local', reason: '已核验本地模组，仅迁移启禁与加载顺序。', localOnly: true,
                    localPackages, selected: chosen.has(row.record.bootName) });
            }
        }
        const used = new Map();
        for (const row of rows) if (row.selected) {
            const targetKey = rowKey(row);
            if (used.has(targetKey)) for (const item of [used.get(targetKey), row]) {
                item.status = 'ambiguous'; item.reason = '多个迁移条目对应同一市场项目，请明确选择。'; item.selected = false;
            }
            used.set(targetKey, row);
        }
        if (task?.verifiedItems.length) {
            const actual = await captureConfiguration(task.verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName)));
            const verified = matchingVerified(task.verifiedItems, actual);
            const selectedPackages = new Set(verified.flatMap(item => item.packages.map(pack => pack.bootName)));
            const orderMatches = equal(task.verifiedOrder.filter(name => selectedPackages.has(name)), actual.order.filter(name => selectedPackages.has(name)));
            for (const row of rows) {
                const item = orderMatches && verified.find(item => item.bootName === row.record.bootName
                    && row.mod && equal(item.choice, descriptor(row.mod)));
                row.verified = Boolean(item && ['ready', 'local'].includes(row.status));
                row.verifiedItem = row.verified ? item : null;
                if (row.verified && selectedNames === undefined) row.selected = false;
            }
        }
        return { manifest, rows, catalog, protectedNames, task, retainedNames: rows.filter(row => row.verified && !row.selected).map(row => row.record.bootName) };
    }
    function environment() {
        const utils = window.modUtils || window.modHubGetGui?.()?.gModUtils;
        const loader = utils?.getModLoader?.()?.getIndexDBLoader?.();
        const identity = window.modHubRestore?.getStorageIdentity?.();
        if (typeof loader?.customStore !== 'function' || !identity?.dbName || !identity?.storeName
            || MODHUB_MIGRATION_KEY.startsWith(loader.constructor?.calcModNameKey?.('') || MODHUB_MIGRATION_KEY)) fail('当前环境不支持迁移任务持久保存。');
        return { loader, ...identity };
    }
    function transaction(mode, action) {
        const env = environment();
        return env.loader.customStore(mode, store => new Promise((resolve, reject) => {
            const tx = store.transaction;
            if (!tx || tx.db?.name !== env.dbName || store.name !== env.storeName) { tx?.abort?.(); reject(new Error(t('迁移任务存储身份不一致。'))); return; }
            let value;
            tx.oncomplete = () => resolve(value);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error(t('迁移任务保存失败。')));
            try {
                const request = action(store);
                request.onsuccess = () => { value = request.result; };
            } catch (error) { tx.abort(); reject(error); }
        }));
    }
    function validateTask(value) {
        object(value, ['schemaVersion', 'id', 'manifest', 'selectedNames', 'choices', 'phase', 'reloadPage', 'error', 'summary', 'roundSummary', 'baseline',
            'verifiedItems', 'verifiedOrder', 'pendingItems', 'completionKind']);
        if (value.schemaVersion !== 1 || !MODHUB_MIGRATION_PHASES.includes(value.phase)) fail('本机迁移任务格式无效。');
        const manifest = parse(value.manifest), selectedNames = names(value.selectedNames);
        if (selectedNames.some(name => !manifest.mods.some(item => item.bootName === name))) fail('本机迁移任务包含未知选择。');
        object(value.choices, manifest.mods.map(item => item.bootName));
        const choices = Object.fromEntries(Object.entries(value.choices).map(([name, item]) => [name, reference(item)]));
        const verifiedItems = list(value.verifiedItems ?? []).map(item => {
            object(item, ['bootName', 'choice', 'packages']);
            const bootName = text(item.bootName, 200, false), choice = reference(item.choice);
            if (!selectedNames.includes(bootName) || !equal(choice, choices[bootName])) fail('本机迁移核验记录无效。');
            const packages = list(item.packages).map(pack => {
                object(pack, ['bootName', 'version', 'digest', 'enabled']);
                return { bootName: text(pack.bootName, 200, false), version: text(pack.version), digest: text(pack.digest, 80, false), enabled: boolean(pack.enabled) };
            });
            if (!packages.length) fail('本机迁移核验记录无效。');
            return { bootName, choice, packages };
        });
        names(verifiedItems.map(item => item.bootName));
        const verifiedPackages = names(verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName)));
        const verifiedOrder = names(value.verifiedOrder ?? []);
        if (verifiedOrder.length !== verifiedPackages.length || verifiedOrder.some(name => !verifiedPackages.includes(name))) fail('本机迁移核验记录无效。');
        const pendingItems = list(value.pendingItems ?? []).map(item => {
            object(item, ['bootName', 'status', 'reason', 'missingBootNames']);
            const bootName = text(item.bootName, 200, false);
            if (!manifest.mods.some(record => record.bootName === bootName) || !['manual', 'unmatched', 'ambiguous', 'failed', 'skipped'].includes(item.status)
                || typeof item.reason !== 'string' || item.reason.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.reason)) fail('本机迁移核验记录无效。');
            return { bootName, status: item.status, reason: item.reason, missingBootNames: names(item.missingBootNames) };
        });
        names(pendingItems.map(item => item.bootName));
        const completionKind = value.completionKind ?? 'unknown';
        if (!['unknown', 'success', 'ended'].includes(completionKind)) fail('本机迁移核验记录无效。');
        const summary = input => {
            object(input, MODHUB_MIGRATION_SUMMARY);
            return Object.fromEntries(MODHUB_MIGRATION_SUMMARY.map(name => [name, names(input[name])]));
        };
        let baseline = null;
        if (value.baseline !== null) {
            object(value.baseline, ['enabled', 'disabled', 'order', 'packages']);
            baseline = { enabled: names(value.baseline.enabled), disabled: names(value.baseline.disabled), order: names(value.baseline.order || [...value.baseline.enabled, ...value.baseline.disabled]), packages: list(value.baseline.packages).map(item => {
                object(item, ['bootName', 'version', 'digest']);
                return { bootName: text(item.bootName, 200, false), version: text(item.version), digest: text(item.digest, 80, false) };
            }) };
            names(baseline.packages.map(item => item.bootName));
        }
        if (typeof value.error !== 'string' || value.error.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.error)) fail('本机迁移错误详情格式无效。');
        return { schemaVersion: 1, id: text(value.id, 100, false), manifest, selectedNames, choices, phase: value.phase,
            reloadPage: text(value.reloadPage, 100), error: value.error, summary: summary(value.summary), roundSummary: summary(value.roundSummary), baseline,
            verifiedItems, verifiedOrder, pendingItems, completionKind };
    }
    async function loadTask({ strict = false } = {}) {
        try { environment(); }
        catch (error) {
            if (strict) throw error;
            pendingTask = null; taskError = null;
            return null;
        }
        try {
            const value = await transaction('readonly', store => store.get(MODHUB_MIGRATION_KEY));
            pendingTask = value === undefined ? null : validateTask(value);
            storedTaskStamp = JSON.stringify(value);
            taskError = null;
            return pendingTask;
        } catch (error) {
            taskError = error;
            if (strict) throw error;
            return null;
        }
    }
    async function saveTask(task) {
        const value = validateTask(task), expected = storedTaskStamp, env = environment();
        await env.loader.customStore('readwrite', store => new Promise((resolve, reject) => {
            const tx = store.transaction;
            if (!tx || tx.db?.name !== env.dbName || store.name !== env.storeName) { tx?.abort?.(); reject(new Error(t('迁移任务存储身份不一致。'))); return; }
            let failure;
            tx.oncomplete = resolve;
            tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error(t('迁移任务保存失败。')));
            const request = store.get(MODHUB_MIGRATION_KEY);
            request.onsuccess = () => {
                if (JSON.stringify(request.result) !== expected) {
                    failure = new Error(t('迁移任务已被其他页面更改，请重新打开后继续。')); tx.abort(); return;
                }
                store.put(value, MODHUB_MIGRATION_KEY);
            };
        }));
        const readback = await loadTask({ strict: true });
        if (!equal(value, readback)) fail('迁移任务保存后回读不一致。');
        return readback;
    }
    const isBeautyPending = () => Boolean(!taskError && pendingTask && pendingTask.phase !== 'complete'
        && (pendingTask.manifest.beauty.enabled.length || pendingTask.manifest.beauty.disabled.length));
    function mergeOrder(current, requested) {
        const wanted = requested.filter(name => current.includes(name));
        const selected = new Set(wanted), positions = current.map((name, index) => selected.has(name) ? index : -1).filter(index => index >= 0);
        const result = [...current];
        positions.forEach((position, index) => { result[position] = wanted[index]; });
        return result;
    }
    const emptySummary = () => Object.fromEntries(MODHUB_MIGRATION_SUMMARY.map(name => [name, []]));
    const combineSummary = (left, right) => Object.fromEntries(MODHUB_MIGRATION_SUMMARY.map(name => [name,
        [...new Set(['missing', 'skipped', 'failed'].includes(name) ? right?.[name] || [] : [...(left?.[name] || []), ...(right?.[name] || [])])]]));
    async function captureConfiguration(packageNames) {
        const lists = await readLists(), packages = [];
        for (const bootName of [...lists.enabled, ...lists.disabled].filter(name => !packageNames || packageNames.includes(name))) {
            const item = await window.modHubReadInstalledModPackage(bootName);
            if (item?.error || !item?.bootJson || item.missing) throw item?.error || new Error(t('无法核验迁移后的模组配置。'));
            const digest = await market().getPackageDigest(item.data);
            if (!digest) fail('当前环境不能核验实际包体摘要，已停止迁移。');
            packages.push({ bootName, version: String(item.bootJson.version || ''), digest });
        }
        const present = new Set([...lists.enabled, ...lists.disabled]);
        const order = [...new Set([...(window._modHubModState?.sideMods || []).map(item => item.name), ...present])].filter(name => present.has(name));
        return { enabled: [...lists.enabled], disabled: [...lists.disabled], order, packages };
    }
    function matchingVerified(items, actual) {
        const packages = new Map(actual.packages.map(item => [item.bootName, item]));
        return items.filter(item => item.packages.every(pack => {
            const current = packages.get(pack.bootName);
            return current && current.version === pack.version && current.digest === pack.digest && actual.enabled.includes(pack.bootName) === pack.enabled;
        }));
    }
    async function taskVerificationMatches(task) {
        if (!task.verifiedItems.length || task.verifiedItems.length !== task.selectedNames.length) return false;
        await window.modHubLoadModManageState(true);
        const packageNames = task.verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName));
        const actual = await captureConfiguration(packageNames);
        return matchingVerified(task.verifiedItems, actual).length === task.verifiedItems.length
            && equal(task.verifiedOrder, actual.order.filter(name => packageNames.includes(name)));
    }
    function rowPackageNames(row, outcome, actual) {
        if (row.retained) return row.verifiedItem.packages.map(item => item.bootName);
        if (row.localOnly) return row.localPackages.map(item => item.name);
        if (!row.mod) return [];
        const installed = new Set(actual.packages.map(item => item.bootName));
        const reported = outcome?.results?.get?.(rowKey(row))?.bootNames;
        if (Array.isArray(reported) && reported.length) return [...new Set([...reported, ...row.record.optionalBootNames])];
        const edition = row.mod?.packageEditions?.find(item => item.id === row.record.packageEditionId)?.bootName;
        const candidates = declaredNames(row.mod).filter(name => installed.has(name));
        const main = edition || (candidates.includes(row.record.bootName) ? row.record.bootName : candidates.length === 1 ? candidates[0] : null);
        return main ? [main, ...row.record.optionalBootNames] : [];
    }
    function recordRound(task, plan, outcome, actual) {
        const packages = new Map(actual.packages.map(item => [item.bootName, item]));
        task.verifiedItems = [];
        task.pendingItems = [];
        for (const row of plan.rows) {
            if (row.status === 'preserved') continue;
            const failed = task.roundSummary.failed.includes(row.record.bootName);
            const names = row.selected || row.retained ? rowPackageNames(row, outcome, actual) : [];
            if ((row.selected || row.retained) && !failed && names.length) {
                task.verifiedItems.push({ bootName: row.record.bootName, choice: task.choices[row.record.bootName],
                    packages: names.map(name => ({ ...packages.get(name), enabled: actual.enabled.includes(name) })) });
                continue;
            }
            const status = ['manual', 'unmatched', 'ambiguous'].includes(row.status) ? row.status : row.selected || row.retained ? 'failed' : 'skipped';
            const expected = names.length ? names : row.mod ? rowPackageNames(row, outcome, actual) : [];
            const missingBootNames = status === 'skipped' ? [] : [...new Set((expected.length ? expected : [row.record.bootName, ...row.record.optionalBootNames]).filter(name => !packages.has(name)))];
            const reason = status === 'skipped' ? '玩家本轮未选择此项目。' : status === 'failed'
                ? outcome?.results?.get?.(rowKey(row))?.reason || '已处理项目仍需重新核对。' : row.reason;
            task.pendingItems.push({ bootName: row.record.bootName, status, reason: String(reason).slice(0, 4000), missingBootNames });
        }
        const verifiedNames = new Set(task.verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName)));
        task.verifiedOrder = actual.order.filter(name => verifiedNames.has(name));
    }
    function actualSummary(before, after, plan, outcome = null) {
        const result = emptySummary(), previous = new Map(before.packages.map(item => [item.bootName, item]));
        const current = new Map(after.packages.map(item => [item.bootName, item]));
        for (const item of after.packages) {
            if (!previous.has(item.bootName)) result.added.push(item.bootName);
            else if (previous.get(item.bootName).digest !== item.digest) result.updated.push(item.bootName);
            if (previous.has(item.bootName) && before.disabled.includes(item.bootName) && after.enabled.includes(item.bootName)) result.enabled.push(item.bootName);
            if (previous.has(item.bootName) && before.enabled.includes(item.bootName) && after.disabled.includes(item.bootName)) result.disabled.push(item.bootName);
        }
        const beforeOrder = before.order || [...before.enabled, ...before.disabled], afterOrder = after.order || [...after.enabled, ...after.disabled];
        const oldOrder = beforeOrder.filter(name => afterOrder.includes(name)), newOrder = afterOrder.filter(name => beforeOrder.includes(name));
        result.orderChanged = newOrder.filter((name, index) => oldOrder[index] !== name);
        for (const row of plan.rows) {
            if (!row.selected && !row.retained) { if (['ready', 'local'].includes(row.status)) result.skipped.push(row.record.bootName); continue; }
            const expected = rowPackageNames(row, outcome, after), found = expected.filter(name => current.has(name));
            const missing = expected.length ? expected.filter(name => !current.has(name)) : [row.record.bootName];
            result.missing.push(...missing);
            const confirmed = row.retained ? matchingVerified([row.verifiedItem], after).length === 1 : outcome?.results?.get?.(rowKey(row))?.status === 'success';
            const main = expected[0];
            const stateMismatch = main && after.enabled.includes(main) !== row.record.enabled
                || Object.entries(row.record.componentEnabled).some(([name, enabled]) => name !== row.record.bootName && current.has(name) && after.enabled.includes(name) !== enabled);
            if (missing.length || stateMismatch || !confirmed) result.failed.push(row.record.bootName);
            else for (const name of found) {
                if (previous.get(name)?.digest === current.get(name)?.digest) result.reused.push(name);
            }
        }
        return Object.fromEntries(MODHUB_MIGRATION_SUMMARY.map(name => [name, [...new Set(result[name])]]));
    }
    async function showResult(task, { cumulative = false } = {}) {
        const summary = cumulative ? task.summary : task.roundSummary;
        const labels = { added: '新增安装', updated: '已更新或替换', reused: '复用已有模组', enabled: '已启用', disabled: '已禁用',
            orderChanged: '已调整加载顺序', beautyApplied: '已应用美化配置', missing: '未找到或未安装', skipped: '本次跳过', failed: '未完成' };
        const success = task.phase === 'complete' && task.completionKind === 'success';
        const pending = task.pendingItems || [], groups = [
            { label: '手动补充', statuses: ['manual', 'unmatched'] }, { label: '重新选择', statuses: ['ambiguous'] },
            { label: '处理失败', statuses: ['failed'] }, { label: '主动跳过', statuses: ['skipped'] }
        ];
        const pendingHtml = groups.map(group => {
            const items = pending.filter(item => group.statuses.includes(item.status));
            return items.length ? '<details open><summary class="' + (group.statuses.includes('failed') ? 'red' : 'gold') + '">'
                + escape(t(group.label)) + ' (' + items.length + ')</summary>' + items.map(item => {
                    const record = task.manifest.mods.find(mod => mod.bootName === item.bootName);
                    return '<div class="modhub-migration-row"><strong class="gold" data-modhub-i18n-ignore>' + escape(item.bootName)
                        + '</strong><p>' + escape(t('源版本')) + ': <span data-modhub-i18n-ignore>' + escape(record?.version || t('版本未知')) + '</span></p>'
                        + (item.missingBootNames.length ? '<p>' + escape(t('缺失包体')) + ': <span data-modhub-i18n-ignore>' + escape(item.missingBootNames.join(', ')) + '</span></p>' : '')
                        + '<p class="modhub-migration-detail" data-modhub-i18n-ignore>' + escape(t(item.reason)) + '</p></div>';
                }).join('') + '</details>' : '';
        }).join('');
        return window.modHubConfirm({ title: '迁移结果', confirmText: '关闭', cancelText: '', dialogClass: 'modhub-migration-dialog',
            trustedMessageHtml: '<p class="' + (success ? 'green' : 'gold') + '">' + escape(t(success ? '所选迁移操作已完成。'
                : task.phase === 'complete' ? task.completionKind === 'ended' ? '迁移任务已手动结束，已保存的操作和未完成原因会保留。' : '此迁移任务已结束，完成状态未核验。'
                    : task.phase === 'installing' ? '迁移尚在处理阶段，以下仅显示已记录的核验结果。'
                        : task.phase === 'partial' ? '迁移尚未完成，已成功保存的操作会保留。' : '模组配置已保存，等待重新载入后核对美化配置。')) + '</p><p class="grey">'
                + escape(t(cumulative ? '以下为本次迁移任务累计核验的操作。' : '以下为本轮通过真实配置回读核验的操作。')) + '</p>'
                + (success ? '<p class="grey">' + escape(t('自动启用旁加载模组美化：{state}', { state: t(task.manifest.beauty.autoEnable ? '已启用' : '已禁用') })) + '</p>' : '')
                + '<div class="modhub-migration-list" tabindex="0" role="region" aria-label="' + escape(t('迁移操作明细')) + '">'
                + MODHUB_MIGRATION_SUMMARY.filter(name => summary[name].length).map(name => '<details open><summary class="' + (['failed', 'missing'].includes(name) ? 'red' : 'gold') + '">'
                    + escape(t(labels[name])) + ' (' + summary[name].length + ')</summary><ul>' + summary[name].map(value => '<li data-modhub-i18n-ignore>' + escape(value) + '</li>').join('') + '</ul></details>').join('')
                + (pendingHtml ? '<strong class="gold">' + escape(t('待处理项目')) + '</strong>' + pendingHtml : '') + '</div>'
                + (pending.some(item => ['manual', 'unmatched'].includes(item.status)) ? '<p class="grey">'
                    + escape(t('请通过【模组管理 → 导入模组】补充包体。未结束的任务可返回【继续迁移】并选择【重新核对】；已结束的任务需重新导入迁移清单。')) + '</p>' : '')
                + (task.error ? '<details><summary>' + escape(t('错误详情')) + '</summary><pre class="modhub-migration-detail red" data-modhub-i18n-ignore>' + escape(task.error) + '</pre></details>' : '') });
    }
    async function mergeConfiguration(plan, context) {
        const lists = await readLists(), profiles = [], desired = [];
        const present = new Set([...lists.enabled, ...lists.disabled]);
        const currentOrder = [...new Set([...(window._modHubModState?.sideMods || []).map(item => item.name), ...present])].filter(name => present.has(name));
        for (const row of plan.rows.filter(item => item.selected)) {
            const candidates = row.retained ? row.verifiedItem.packages.map(item => item.bootName)
                : row.actualBootNames || (row.localOnly ? [row.record.bootName] : declaredNames(row.mod));
            const actual = candidates.map(candidate => [...lists.enabled, ...lists.disabled].find(name => key(candidate) === key(name))).filter(Boolean);
            for (const name of [...actual, ...row.record.optionalBootNames.filter(name => present.has(name))]) {
                desired.push({ name, position: row.record.componentOrder?.[name] ?? row.record.order });
            }
        }
        for (const name of lists.enabled) {
            const item = await window.modHubReadInstalledModBoot(name);
            if (item?.error || !item?.bootJson) throw item?.error || new Error(t('无法核验迁移后的模组配置。'));
            profiles.push({ name, bootJson: item.bootJson });
        }
        const requestedOrder = mergeOrder(currentOrder, [...new Set(desired.sort((a, b) => a.position - b.position).map(item => item.name))]);
        const requested = requestedOrder.filter(name => lists.enabled.includes(name));
        const nodes = requested.map(name => ({ key: name, modName: name, boot: profiles.find(item => item.name === name)?.bootJson }));
        const sorted = await window.modHubBuildSmartOrder(nodes, window.modHubGetGui?.(), false);
        const enabled = window.modHubKeepRecoveryOrder(sorted, profiles), disabled = requestedOrder.filter(name => lists.disabled.includes(name));
        let activeIndex = 0, disabledIndex = 0;
        const order = requestedOrder.map(name => lists.enabled.includes(name) ? enabled[activeIndex++] : disabled[disabledIndex++]);
        const protectedNames = new Set(window.modHubRestore.getRecoveryInfo?.(enabled, profiles)?.protectedNames || []);
        const first = enabled.filter(name => protectedNames.has(name));
        const finalOrder = [...first, ...order.filter(name => !protectedNames.has(name))];
        const listsChanged = !equal(enabled, lists.enabled) || !equal(disabled, lists.disabled);
        if (listsChanged || !equal(finalOrder, currentOrder)) {
            if (!await window.modHubRestore.prepare(context)) fail('迁移顺序调整已取消。');
            if (listsChanged) await window.modHubRestore.commitPackageChanges({ context, packages: [], expectedEnabled: lists.enabled, expectedDisabled: lists.disabled, enabled, disabled });
            // 此键只保存管理页交错顺序，失败时由持久迁移任务继续，不能宣称配置已完整迁入。
            const value = JSON.stringify(finalOrder);
            window.localStorage.setItem('modhub_sideload_mod_order', value);
            if (window.localStorage.getItem('modhub_sideload_mod_order') !== value) fail('迁移加载顺序保存后回读不一致。');
            await window.modHubLoadModManageState(true, { deferReloadPrompt: true });
            const readback = await readLists();
            if (!equal(enabled, readback.enabled) || !equal(disabled, readback.disabled)
                || !equal(finalOrder, window._modHubModState?.sideMods?.map(item => item.name))) fail('迁移加载顺序保存后回读不一致。');
            window.modHubRegisterOperationReload?.(context, t('迁移顺序已保存，重新载入后生效。'));
        }
        return { enabled, disabled, order: finalOrder };
    }
    const localBaseline = rows => rows.filter(row => row.selected && row.localOnly).map(row => ({ bootName: row.record.bootName,
        choice: descriptor(row.mod), packages: row.localPackages.map(item => ({ ...item })) }));
    async function assertLocalBaseline(baseline) {
        const lists = await readLists();
        for (const row of baseline) for (const item of row.packages) {
            const installed = await window.modHubReadInstalledModPackage(item.name);
            if (![...lists.enabled, ...lists.disabled].includes(item.name) || installed?.error || installed?.missing
                || installed?.bootJson?.name !== item.name || String(installed.bootJson.version || '') !== item.version
                || await market().getPackageDigest(installed.data) !== item.digest) fail('本地模组已改变，请重新预览后重试。');
        }
    }
    async function configureLocal(rows, context) {
        const results = new Map();
        if (!rows.length) return results;
        const lists = await readLists(), desiredEnabled = {};
        for (const row of rows) for (const item of row.localPackages) {
            const installed = await window.modHubReadInstalledModPackage(item.name);
            if (installed?.error || installed?.missing || installed?.bootJson?.name !== item.name || String(installed.bootJson.version || '') !== item.version
                || await market().getPackageDigest(installed.data) !== item.digest) fail('本地模组已改变，请重新预览后重试。');
            desiredEnabled[item.name] = item.name === row.record.bootName ? row.record.enabled
                : row.record.componentEnabled[item.name] ?? lists.enabled.includes(item.name);
        }
        const enabled = [...new Set([...lists.enabled.filter(name => desiredEnabled[name] !== false),
            ...Object.keys(desiredEnabled).filter(name => desiredEnabled[name])])];
        const disabled = [...new Set([...lists.disabled, ...Object.keys(desiredEnabled).filter(name => !desiredEnabled[name])])].filter(name => !enabled.includes(name));
        const compatibility = window.modHubCompatibility;
        if (!compatibility?.check || !compatibility?.assertCurrent) fail('本地环境检查尚未就绪，请重新载入后重试。');
        const snapshot = await compatibility.check({ enabledNames: enabled, disabledNames: disabled, allowBusy: true });
        try {
            if (snapshot.stale) fail('本地模组已改变，请重新预览后重试。');
            if (snapshot.compatibility?.findings?.length && !await window.modHubConfirm({ title: '确认迁移本地模组配置',
                trustedMessageHtml: compatibility.render(snapshot), confirmText: '应用配置', cancelText: '取消' })) {
                rows.forEach(row => results.set(rowKey(row), { status: 'skipped', reason: t('迁移启禁配置未能保存。') }));
                return results;
            }
            const saved = await window.modHubHandleAddMod([], { restoreContext: context, askRestart: false, skipReloadOffer: true, keepCurrentTab: true,
                atomicPackageChanges: { desiredEnabled }, beforeImport: async () => {
                    if (await compatibility.assertCurrent(snapshot, { allowBusy: true }) === false) fail('本地模组已改变，请重新预览后重试。');
                } });
            if (!saved) throw new Error(window._modHubLastInstallError || t('迁移启禁配置未能保存。'));
            rows.forEach(row => results.set(rowKey(row), { status: 'success' }));
            return results;
        } finally { compatibility.releaseCandidateData?.(snapshot); }
    }
    async function execute(input, options = {}) {
        if (running) fail('已有迁移任务正在运行，请稍候。');
        running = true;
        let task, context, plan, before, captured = false;
        try {
            plan = await preview(input, options);
            const selected = plan.rows.filter(row => row.selected);
            // 开始执行时不能用新包体悄悄替换玩家已看过的本地包基线。
            const expectedLocal = options.localBaseline ?? localBaseline(plan.rows);
            if (!equal(expectedLocal, localBaseline(plan.rows))) fail('本地模组已改变，请重新预览后重试。');
            const expectedRetained = names(options.retainedNames ?? plan.retainedNames);
            const retained = plan.rows.filter(row => row.verified && !row.selected);
            if (!equal([...expectedRetained].sort(), retained.map(row => row.record.bootName).sort())) fail('已完成项目的配置已改变，请重新预览后重试。');
            retained.forEach(row => { row.retained = true; });
            const considered = plan.rows.filter(row => row.selected || row.retained);
            if (!considered.length) fail('请选择至少一个可迁移的模组。');
            const downloads = selected.filter(row => !row.localOnly);
            const current = await loadTask({ strict: true });
            if (plan.task && !equal(plan.task, current)) fail('迁移任务已被其他页面更改，请重新打开后继续。');
            task = { schemaVersion: 1, id: options.taskId || Date.now() + '-' + Math.random().toString(36).slice(2), manifest: plan.manifest,
                selectedNames: considered.map(row => row.record.bootName), choices: { ...(plan.task?.choices || {}), ...Object.fromEntries(considered.map(row => [row.record.bootName, descriptor(row.mod)])) },
                phase: 'installing', reloadPage: '', error: '', summary: plan.task?.summary || emptySummary(), roundSummary: emptySummary(), baseline: null,
                verifiedItems: retained.map(row => row.verifiedItem), verifiedOrder: plan.task?.verifiedOrder.filter(name => retained.some(row => row.verifiedItem.packages.some(pack => pack.bootName === name))) || [],
                pendingItems: plan.task?.pendingItems || [], completionKind: 'unknown' };
            if (current && current.phase !== 'complete' && current.id !== options.taskId) fail('已有未完成的迁移任务，请先继续或结束该任务。');
            const defaults = Object.fromEntries(downloads.map(row => {
                const allowed = [...declaredNames(row.mod), ...(row.mod.optionalResources || []).map(item => item.bootName)];
                const edition = row.mod.packageEditions?.find(item => item.id === row.record.packageEditionId);
                const main = edition?.bootName || declaredNames(row.mod).find(name => key(name) === key(row.record.bootName)) || declaredNames(row.mod)[0];
                const componentEnabled = Object.fromEntries(Object.entries(row.record.componentEnabled).filter(([name]) => allowed.includes(name)));
                if (main) componentEnabled[main] = row.record.enabled;
                return [market().getMarketModKey(row.mod), { enabled: row.record.enabled, packageEditionId: edition?.id || '',
                    optionalBootNames: row.record.optionalBootNames.filter(name => allowed.includes(name)), componentEnabled }];
            }));
            const install = async activeContext => {
                context = activeContext;
                if (!await window.modHubRestore.prepare(context)) return false;
                await assertLocalBaseline(expectedLocal);
                before = await captureConfiguration();
                const retainedPackages = new Set(task.verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName)));
                if (matchingVerified(task.verifiedItems, before).length !== retained.length
                    || !equal(task.verifiedOrder, before.order.filter(name => retainedPackages.has(name)))) fail('已完成项目的配置已改变，请重新预览后重试。');
                task.baseline = before;
                await saveTask(task);
                let result;
                try {
                    result = downloads.length ? await window.modHubMarketInstaller.installBatch(downloads.map(row => row.mod), { restoreContext: context, migrationDefaults: defaults })
                        : { results: new Map() };
                    if (result && (!downloads.length || !market().batchInstallState?.stopRequested) && !context.cancelled) {
                        const localResults = await configureLocal(selected.filter(row => row.localOnly), context);
                        localResults.forEach((value, name) => result.results.set(name, value));
                    }
                    await refresh(false);
                    const actual = await captureConfiguration();
                    const installedNames = new Set(actual.packages.map(item => item.bootName));
                    const applicable = { ...plan, rows: plan.rows.map(row => {
                        row.actualBootNames = rowPackageNames(row, result, actual);
                        return { ...row, selected: row.retained ? matchingVerified([row.verifiedItem], actual).length === 1 : row.selected
                            && row.actualBootNames.some(name => installedNames.has(name)) && result?.results?.get?.(rowKey(row))?.status === 'success' };
                    }) };
                    await mergeConfiguration(applicable, context);
                    const final = await captureConfiguration();
                    task.roundSummary = actualSummary(before, final, plan, result);
                    captured = true;
                    recordRound(task, plan, result, final);
                    task.summary = combineSummary(task.summary, task.roundSummary);
                    task.phase = result === false || task.roundSummary.failed.length ? 'partial' : 'reload';
                    task.reloadPage = MODHUB_MIGRATION_PAGE;
                    task.error = task.phase === 'partial' ? [...(result?.results?.entries?.() || [])].filter(([, item]) => item.status !== 'success')
                        .map(([name, item]) => name + ': ' + (item.reason || t('未完成'))).join('\n').slice(0, 4000)
                        || t('部分项目尚未完成，已成功安装的模组会保留。继续时将重新核对实际配置。') : '';
                    task.baseline = null;
                    await saveTask(task);
                    return result;
                } catch (error) {
                    // 对比必须在同一跨页锁内完成，解锁后的其他页面操作不计入本轮。
                    try {
                        const actual = await captureConfiguration();
                        task.roundSummary = actualSummary(before, actual, plan, result);
                        task.roundSummary.failed = [...new Set([...task.roundSummary.failed, ...selected.map(row => row.record.bootName)])];
                        const verifiedOrder = task.verifiedOrder;
                        recordRound(task, plan, result, actual);
                        const remaining = new Set(task.verifiedItems.flatMap(item => item.packages.map(pack => pack.bootName)));
                        task.verifiedOrder = verifiedOrder.filter(name => remaining.has(name));
                        captured = true;
                        task.summary = combineSummary(task.summary, task.roundSummary);
                    } catch (_) { captured = false; }
                    throw error;
                }
            };
            const result = options.restoreContext ? await install(options.restoreContext)
                : await market().runInstallTask(install, { label: '迁移模组环境', names: considered.map(row => row.record.bootName), batchPreparation: true, deferReloadPrompt: true });
            if (!before) return { ok: false, task: pendingTask };
            if (context?.finishError) {
                task.phase = 'partial'; task.error = String(context.finishError.message || context.finishError).slice(0, 4000); await saveTask(task);
            }
            await showResult(pendingTask);
            await window.modHubCompleteOperationReload?.(context);
            return { ok: task.phase !== 'partial', task: pendingTask };
        } catch (error) {
            if (task && before) {
                task.phase = 'partial'; task.error = String(error.message || error).slice(0, 4000);
                try {
                    if (!captured) task.roundSummary = emptySummary();
                    await saveTask(task); await showResult(pendingTask);
                } catch (saveError) { console.warn('[ModHub] 迁移任务结果尚未保存', saveError); }
            }
            throw error;
        } finally { running = false; }
    }
    function beautyPreview(manifest) {
        const all = window._modHubBeautyState?.allMap, desired = manifest.beauty;
        const match = item => {
            const candidate = all?.get(item.type);
            return candidate && key(window.modHubGetBeautyModName?.(candidate) || candidate.modRef?.mod?.name || candidate.modRef?.name) === key(item.bootName) ? candidate : null;
        };
        const enabled = desired.enabled.map(match), disabled = desired.disabled.map(match);
        return { available: Boolean(all), enabled: enabled.filter(Boolean), disabled: disabled.filter(Boolean),
            missing: [...desired.enabled.filter((_, i) => !enabled[i]), ...desired.disabled.filter((_, i) => !disabled[i])] };
    }
    async function applyBeauty({ skipMissing = false } = {}) {
        const task = await loadTask({ strict: true });
        if (!task || !['reload', 'beauty'].includes(task.phase)) fail('当前没有待应用的美化迁移。');
        if (task.reloadPage === MODHUB_MIGRATION_PAGE) fail('请先重新载入游戏，再继续应用美化配置。');
        if (!await taskVerificationMatches(task)) fail('已完成项目的配置已改变，请重新预览后重试。');
        const hasEntries = Boolean(task.manifest.beauty.enabled.length || task.manifest.beauty.disabled.length);
        await window.modHubLoadBeautyState(false);
        const plan = beautyPreview(task.manifest);
        if (hasEntries && !plan.available) fail('美化管理尚未就绪，请在图包加载后继续迁移。');
        const previousBeauty = window._modHubBeautyState?.enabledList.map(item => item.type) || [];
        const storedBeauty = hasEntries ? await window.modHubRestore.readBeautyOrder() : null;
        if (storedBeauty !== null && !equal(storedBeauty, previousBeauty)) fail('美化配置已被其他页面更改，请重新载入游戏后重试。');
        const confirmed = await window.modHubConfirm({ title: '确认应用美化配置', message: '将应用已匹配美化项的启禁与覆盖顺序，目标环境的其他美化项会保留。',
            trustedMessageHtml: '<p>' + escape(t('将应用已匹配美化项的启禁与覆盖顺序，目标环境的其他美化项会保留。')) + '</p><p>'
                + escape(t('自动启用旁加载模组美化：{state}', { state: t(task.manifest.beauty.autoEnable ? '已启用' : '已禁用') })) + '</p>'
                + '<div class="modhub-migration-list" tabindex="0">' + [[plan.enabled, '迁移后启用'], [plan.disabled, '迁移后禁用'], [plan.missing, '未匹配']].map(([items, label]) => items.length
                    ? '<section><p class="' + (items === plan.missing ? 'red' : 'gold') + '">' + escape(t(label)) + '</p><ul>'
                        + items.map(item => '<li data-modhub-i18n-ignore>' + escape(item.type) + '</li>').join('') + '</ul></section>' : '').join('') + '</div>',
            confirmText: plan.missing.length ? '跳过缺失项并应用' : '应用美化配置', cancelText: '稍后处理', dialogClass: 'modhub-migration-dialog' });
        if (!confirmed) return false;
        task.phase = 'beauty'; await saveTask(task);
        let actionError, restoreContext;
        const saved = await window.modHubRunManagerAction(async () => {
            if (!await taskVerificationMatches(task)) fail('已完成项目的配置已改变，请重新预览后重试。');
            if (hasEntries) {
                if (!equal(storedBeauty, await window.modHubRestore.readBeautyOrder())
                    || !equal(previousBeauty, window._modHubBeautyState?.enabledList.map(item => item.type))) {
                    fail('美化配置已被其他页面更改，请重新载入游戏后重试。');
                }
                const state = window._modHubBeautyState, named = new Set([...plan.enabled, ...plan.disabled].map(item => item.type));
                state.enabledList = [...plan.enabled, ...state.enabledList.filter(item => !named.has(item.type))];
                state.disabledList = [...plan.disabled, ...state.disabledList.filter(item => !named.has(item.type))];
                if (!await window.modHubSaveBeautyState(false)) fail('美化配置保存失败。');
                const actual = await window.modHubRestore.readBeautyOrder();
                if (!equal(actual, state.enabledList.map(item => item.type))) fail('美化配置回读不一致。');
            }
            window.modHubSetAutoBeautyEnabled(task.manifest.beauty.autoEnable);
            if (window.localStorage.getItem('modhub_auto_enable_sideload_beauty') !== String(task.manifest.beauty.autoEnable)) fail('美化自动启用设置回读不一致。');
            return true;
        }, t('正在应用迁移的美化配置…'), { restoreLabel: '应用迁移美化配置', trackReload: false,
            onRestoreContext: context => { restoreContext = context; }, onError: error => { actionError = error; } });
        if (!saved || restoreContext?.finishError) {
            const error = actionError || restoreContext?.finishError || new Error(t('美化配置尚未完成，请保留迁移任务后重试。'));
            task.error = String(error.message || error).slice(0, 4000); await saveTask(task); throw error;
        }
        const nextBeauty = window._modHubBeautyState?.enabledList.map(item => item.type) || [];
        const applied = [...new Set([...previousBeauty, ...nextBeauty])].filter(type => previousBeauty.includes(type) !== nextBeauty.includes(type)
            || previousBeauty.filter(value => nextBeauty.includes(value)).indexOf(type) !== nextBeauty.filter(value => previousBeauty.includes(value)).indexOf(type));
        task.roundSummary = emptySummary(); task.roundSummary.beautyApplied = applied;
        task.roundSummary.skipped = plan.missing.map(item => item.type);
        task.summary = combineSummary(task.summary, { ...task.roundSummary,
            missing: task.summary.missing, failed: task.summary.failed,
            skipped: [...new Set([...task.summary.skipped, ...task.roundSummary.skipped])] });
        task.phase = 'complete'; task.completionKind = 'success'; task.error = ''; await saveTask(task); await showResult(pendingTask, { cumulative: true });
        return true;
    }
    function downloadManifest(manifest) {
        const blob = new Blob([JSON.stringify(parse(manifest), null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'ModHub-' + new Date().toISOString().slice(0, 10) + '.modhub-migration.json';
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    async function chooseManual(row, catalog) {
        const choices = catalog.filter(autoAvailable);
        const value = await window.modHubConfirm({ title: '选择市场项目', message: '请根据作者资料和真实技术名明确选择，选择后仍需通过正常安装检查。',
            selectOptions: [{ value: '', label: t('请选择市场项目') }, ...choices.map(mod => ({ value: market().getMarketModKey(mod), label: mod.name + ' (' + declaredNames(mod).join(', ') + ')' }))],
            selectValue: '', requireSelection: true, confirmText: '采用此项目', cancelText: '取消' });
        return value ? choices.find(mod => market().getMarketModKey(mod) === value) : null;
    }
    async function showPreview(input, options = {}) {
        let plan = await preview(input, options), choices = { ...(options.choices || {}) }, selectedNames = plan.rows.filter(row => row.selected).map(row => row.record.bootName);
        let search = '', filter = 'all', checking = false;
        const processable = row => ['ready', 'local'].includes(row.status);
        const visibleRows = () => plan.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
            (filter === 'all' || (filter === 'ready' ? processable(row) : filter === 'manual' ? ['manual', 'unmatched'].includes(row.status) : row.status === 'ambiguous'))
            && [row.record.bootName, row.mod?.name].some(value => key(value).includes(key(search.trim()))));
        const game = window.modHubMarketVersions?.getGameIdentity?.() || {};
        const sourceGame = plan.manifest.source.gameBranch === 'dolp' ? 'DoLP ' + plan.manifest.source.gameBranchVersion + ' (DoL ' + plan.manifest.source.gameVersion + ')'
            : plan.manifest.source.gameBranch === 'dolx' ? 'DoLX ' + plan.manifest.source.gameBranchVersion + ' (DoL ' + plan.manifest.source.gameVersion + ')'
            : plan.manifest.source.gameVersion ? 'DoL ' + plan.manifest.source.gameVersion : t('未识别');
        const targetGame = window.modHubMarketVersions?.getGameVersionLabel?.() || (game.version ? 'DoL ' + game.version : t('未识别'));
        const selection = await window.modHubConfirm({ title: '迁移预览', message: '清单仅记录模组环境，不含包体。将联网重新选版，目标环境的其他模组会保留。',
            dialogClass: 'modhub-migration-dialog modhub-migration-preview', confirmText: '开始迁移', cancelText: '取消',
            trustedMessageHtml: '<p>' + escape(t('清单仅记录模组环境，不含包体。将联网重新选版，目标环境的其他模组会保留。')) + '</p><div class="modhub-migration-meta"><span>'
                + escape(t('源游戏')) + ': <span data-modhub-i18n-ignore>' + escape(sourceGame) + '</span></span><span>' + escape(t('目标游戏')) + ': <span data-modhub-i18n-ignore>'
                + escape(targetGame) + '</span></span></div><div class="modhub-migration-toolbar">'
                + '<label><span>' + escape(t('搜索模组名称或技术名')) + '</span><input type="search" data-modhub-migration-search></label>'
                + '<label><span>' + escape(t('筛选迁移项目')) + '</span><select data-modhub-migration-filter>'
                + [['all', '全部'], ['ready', '可处理'], ['manual', '需补充'], ['ambiguous', '需重新选择']].map(([value, label]) => '<option value="' + value + '">' + escape(t(label)) + '</option>').join('') + '</select></label></div>'
                + '<div class="modhub-migration-actions"><button type="button" class="macro-button" data-modhub-migration-bulk="select">' + escape(t('全选可见项')) + '</button>'
                + '<button type="button" class="macro-button" data-modhub-migration-bulk="clear">' + escape(t('取消可见项')) + '</button>'
                + '<button type="button" class="macro-button" data-modhub-migration-recheck>' + escape(t('重新核对')) + '</button></div>'
                + '<p class="modhub-migration-detail grey" data-modhub-migration-count role="status" aria-live="polite"></p>'
                + '<div class="modhub-migration-list" tabindex="0" role="region" aria-label="' + escape(t('迁移模组清单')) + '"></div>',
            canConfirm: () => !checking && (selectedNames.length > 0 || plan.rows.some(row => row.verified)),
            onRender: dialog => {
                const syncSelection = () => {
                    selectedNames = plan.rows.filter(row => row.selected).map(row => row.record.bootName);
                    const count = dialog.querySelector('[data-modhub-migration-count]');
                    const label = checking ? '正在重新核对模组…' : '显示 {visible}/{total} 项，本轮已选 {selected} 项。';
                    const params = { visible: visibleRows().length, total: plan.rows.length, selected: selectedNames.length };
                    if (window.modHubBindText) window.modHubBindText(count, label, params);
                    else count.textContent = t(label, params);
                    dialog.modHubSyncConfirmState?.();
                };
                const render = () => {
                    dialog.setAttribute('aria-busy', String(checking));
                    const listNode = dialog.querySelector('.modhub-migration-list');
                    const visible = visibleRows();
                    listNode.innerHTML = visible.map(({ row, index }) => '<div class="modhub-migration-row"><label><input type="checkbox" data-modhub-migration-select="' + index + '" '
                        + (row.selected ? 'checked ' : '') + (!processable(row) || checking ? 'disabled' : '') + '><strong class="gold" data-modhub-i18n-ignore>' + escape(row.record.bootName)
                        + '</strong></label><div class="modhub-migration-detail ' + (row.verified && !row.selected ? 'green' : 'grey') + '">' + escape(t(row.verified && !row.selected ? '已核验，保留' : row.reason)) + '</div><div class="modhub-migration-meta"><span>' + escape(t('源版本')) + ': <span data-modhub-i18n-ignore>' + escape(row.record.version)
                        + '</span></span><span class="gold">' + escape(t(row.status === 'preserved' ? '保留目标当前状态' : row.record.enabled ? '迁移后启用' : '迁移后禁用')) + '</span>'
                        + (row.mod ? '<span data-modhub-i18n-ignore>' + escape(row.mod.name) + '</span>' : '')
                        + row.current.map(item => '<span>' + escape(t(item.enabled ? '当前已启用' : '当前已禁用')) + ': <span data-modhub-i18n-ignore>' + escape(item.bootName + ' ' + item.version) + '</span>'
                            + (row.localOnly && item.bootName !== row.record.bootName ? ' · ' + escape(t((row.record.componentEnabled[item.bootName] ?? item.enabled) ? '迁移后启用' : '迁移后禁用')) : '') + '</span>').join('')
                        + '</div>' + (!['ready', 'local', 'preserved'].includes(row.status) ? '<button type="button" class="macro-button" data-modhub-migration-map="' + index + '"' + (checking ? ' disabled' : '') + '>' + escape(t('选择市场项目')) + '</button>' : '') + '</div>').join('')
                        || '<p class="grey">' + escape(t('没有匹配的迁移项目。')) + '</p>';
                    listNode.querySelectorAll('[data-modhub-migration-select]').forEach(control => { control.onchange = () => {
                        const row = plan.rows[Number(control.dataset.modhubMigrationSelect)];
                        row.selected = control.checked;
                        const reason = control.closest('.modhub-migration-row').querySelector('.modhub-migration-detail');
                        reason.classList.toggle('green', row.verified && !row.selected);
                        reason.classList.toggle('grey', !(row.verified && !row.selected));
                        reason.textContent = t(row.verified && !row.selected ? '已核验，保留' : row.reason);
                        window.modHubLocalizeOwned?.(reason); syncSelection();
                    }; });
                    listNode.querySelectorAll('[data-modhub-migration-map]').forEach(control => { control.onclick = async () => {
                        try {
                            const row = plan.rows[Number(control.dataset.modhubMigrationMap)], mod = await chooseManual(row, plan.catalog);
                            if (!mod) return;
                            choices[row.record.bootName] = descriptor(mod);
                            selectedNames = [...new Set([...selectedNames, row.record.bootName])];
                            plan = await preview(plan.manifest, { choices, selectedNames, taskId: options.taskId, catalog: plan.catalog });
                            render();
                        } catch (error) { await window.modHubAlert(error.message, t('迁移未完成')); }
                    }; });
                    dialog.querySelectorAll('[data-modhub-migration-bulk]').forEach(control => {
                        control.disabled = checking || !visible.some(({ row }) => processable(row));
                    });
                    dialog.querySelector('[data-modhub-migration-recheck]').disabled = checking;
                    dialog.querySelector('[data-modhub-migration-search]').disabled = checking;
                    dialog.querySelector('[data-modhub-migration-filter]').disabled = checking;
                    syncSelection();
                    window.modHubLocalizeOwned?.(listNode);
                };
                dialog.querySelector('[data-modhub-migration-search]').oninput = event => { search = event.target.value; render(); };
                dialog.querySelector('[data-modhub-migration-filter]').onchange = event => { filter = event.target.value; render(); };
                dialog.querySelectorAll('[data-modhub-migration-bulk]').forEach(control => { control.onclick = () => {
                    for (const { row } of visibleRows()) if (processable(row)) row.selected = control.dataset.modhubMigrationBulk === 'select';
                    render();
                }; });
                dialog.querySelector('[data-modhub-migration-recheck]').onclick = async () => {
                    checking = true; render();
                    try { plan = await preview(plan.manifest, { choices, selectedNames, taskId: options.taskId }); }
                    catch (error) { await window.modHubAlert(error.message, t('迁移未完成')); }
                    finally { checking = false; render(); dialog.querySelector('[data-modhub-migration-recheck]').focus(); }
                };
                render();
            }, customResult: () => ({ selectedNames, choices, localBaseline: localBaseline(plan.rows),
                retainedNames: plan.rows.filter(row => row.verified && !row.selected).map(row => row.record.bootName) }) });
        return selection ? execute(plan.manifest, { ...selection, taskId: options.taskId }) : false;
    }
    function importFile(onComplete) {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.modhub-migration.json,application/json';
        input.onchange = async () => {
            try {
                const file = input.files?.[0];
                if (!file) return;
                if (file.size > MODHUB_MIGRATION_LIMIT) fail('迁移清单超过 1 MiB。');
                await showPreview(parse(await file.text()));
            } catch (error) { await window.modHubAlert(error.message, t('无法导入迁移清单')); }
            finally {
                try { await onComplete?.(); }
                catch (error) { await window.modHubAlert(error.message, t('迁移未完成')); }
            }
        };
        input.click();
    }
    async function continueTask() {
        const task = await loadTask({ strict: true });
        if (!task) fail('没有未完成的迁移任务。');
        if (['reload', 'beauty'].includes(task.phase) && await taskVerificationMatches(task)) return applyBeauty();
        if (task.phase === 'complete') return true;
        return showPreview(task.manifest, { choices: task.choices, taskId: task.id });
    }
    async function finishTask() {
        const task = await loadTask({ strict: true });
        if (!task || running) return false;
        if (!await window.modHubConfirm({ title: '结束迁移任务', message: '已安装的模组和当前配置会保留。未完成项目不再继续，可重新导入清单建立新任务。', confirmText: '结束任务', cancelText: '取消' })) return false;
        const finish = async () => {
            const current = await loadTask({ strict: true });
            if (!equal(current, task)) fail('迁移任务已被其他页面更改，请重新打开后继续。');
            task.phase = 'complete'; task.completionKind = 'ended'; await saveTask(task); return true;
        };
        if (!window.navigator?.locks?.request) return finish();
        const env = environment();
        return window.navigator.locks.request('modhub:' + env.dbName + ':' + env.storeName, { mode: 'exclusive', ifAvailable: true }, lock => {
            if (!lock) fail('另一个页面正在修改模组，请完成后再结束迁移任务。');
            return finish();
        });
    }
    async function open() {
        try {
            let task = await loadTask({ strict: true });
            const content = () => {
                const active = task && task.phase !== 'complete';
                return '<p>' + escape(t('导出当前模组清单，在新游戏中重新下载适配版本并恢复管理配置。')) + '</p><p class="grey">' + escape(t('仅包含模组身份、启禁、顺序和美化管理配置。')) + '</p>'
                    + (active ? '<p class="modhub-migration-status gold">' + escape(t(task.phase === 'partial' ? '部分项目尚未完成，可继续迁移。' : ['reload', 'beauty'].includes(task.phase) ? '模组已处理，等待重载后核对美化配置。' : '上次迁移尚未结束，请核对实际配置后继续。')) + '</p>'
                        + (task.error ? '<details><summary>' + escape(t('错误详情')) + '</summary><p class="red" data-modhub-i18n-ignore>' + escape(task.error) + '</p></details>' : '') : '')
                    + '<div class="modhub-migration-actions"><button type="button" class="macro-button modhub-btn-primary" data-modhub-migration-action="export">' + escape(t('导出迁移清单')) + '</button>'
                    + '<button type="button" class="macro-button" data-modhub-migration-action="import"' + (active ? ' disabled' : '') + '>' + escape(t('导入迁移清单')) + '</button>'
                    + (task ? '<button type="button" class="macro-button" data-modhub-migration-action="result">' + escape(t('查看迁移结果')) + '</button>' : '')
                    + (active ? '<button type="button" class="macro-button modhub-btn-primary" data-modhub-migration-action="continue">' + escape(t('继续迁移')) + '</button><button type="button" class="macro-button" data-modhub-migration-action="finish">' + escape(t('结束任务')) + '</button>' : '') + '</div>';
            };
            return await window.modHubConfirm({ title: '环境迁移', message: '导出当前模组清单，在新游戏中重新下载适配版本并恢复管理配置。',
                dialogClass: 'modhub-migration-dialog', confirmText: '关闭', cancelText: '', trustedMessageHtml: content(),
                onRender: dialog => {
                    const refresh = async () => {
                        task = await loadTask({ strict: true }); render();
                        dialog.querySelector('.modhub-modal-btn-confirm')?.focus();
                    };
                    const render = () => {
                        dialog.querySelector('.modhub-modal-message').innerHTML = content();
                        dialog.querySelectorAll('[data-modhub-migration-action]').forEach(button => { button.onclick = async () => {
                            const action = button.dataset.modhubMigrationAction;
                            button.disabled = true;
                            try {
                                if (action === 'export') { downloadManifest(await exportManifest()); window.modHubShowToast(t('迁移清单已生成，请确认浏览器下载结果。'), 'success'); }
                                if (action === 'import') importFile(refresh);
                                if (action === 'continue') await continueTask();
                                if (action === 'finish') await finishTask();
                                if (action === 'result') {
                                    task = await loadTask({ strict: true });
                                    if (task) await showResult(task, { cumulative: true });
                                }
                            } catch (error) { await window.modHubAlert(error.message, t('迁移未完成')); }
                            finally {
                                button.disabled = false;
                                if (action !== 'import') {
                                    try { await refresh(); }
                                    catch (error) { await window.modHubAlert(error.message, t('迁移未完成')); }
                                }
                            }
                        }; });
                        window.modHubLocalizeOwned?.(dialog);
                    };
                    render();
                } });
        } catch (error) { await window.modHubAlert(error.message, t('无法打开环境迁移')); return false; }
    }
    window.modHubMigration = { open, exportManifest, parse, preview, execute, showPreview, importFile, downloadManifest,
        loadTask, continueTask, finishTask, applyBeauty, beautyPreview, mergeOrder, mergeConfiguration, isBeautyPending, actualSummary, captureConfiguration, showResult,
        isRunning: () => running, storageKey: MODHUB_MIGRATION_KEY };
})();
