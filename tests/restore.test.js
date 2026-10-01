// 原生 IndexedDB 事务协议模拟：请求异步完成，失败时整个事务不提交。
const { assert, createBaseSandbox, createDocumentStub, createStubElement, loadScripts } = require('./helpers');
const { webcrypto } = require('node:crypto');

function database(name, storeName, initial = []) {
    const state = { name, storeName, data: new Map(initial), writes: 0, failPut: null };
    state.useStore = async (mode, callback) => {
        const staged = new Map([...state.data].map(([key, value]) => [key, structuredClone(value)]));
        let pending = 0;
        let closed = false;
        let checking = false;
        const tx = {
            db: { name }, error: null,
            abort() { if (closed) return; closed = true; setImmediate(() => tx.onabort?.({ target: tx })); },
        };
        const complete = () => {
            if (checking || closed || pending) return;
            checking = true;
            setImmediate(() => {
                checking = false;
                if (closed || pending) return;
                closed = true;
                if (mode === 'readwrite') { state.data = staged; state.writes++; }
                tx.oncomplete?.({ target: tx });
            });
        };
        const request = action => {
            if (closed) throw new Error('事务已关闭');
            const req = {};
            pending++;
            setImmediate(() => {
                if (closed) return;
                try { req.result = action(); req.onsuccess?.({ target: req }); }
                catch (error) { req.error = tx.error = error; req.onerror?.({ target: req }); tx.abort(); }
                pending--;
                complete();
            });
            return req;
        };
        const store = {
            name: storeName, transaction: tx,
            get(key) { return request(() => structuredClone(staged.get(key))); },
            put(value, key) {
                if (mode !== 'readwrite') throw new Error('只读事务不得写入');
                return request(() => {
                    const error = state.failPut?.(key, value);
                    if (error) throw error;
                    staged.set(key, structuredClone(value));
                    return key;
                });
            },
            delete(key) { return request(() => staged.delete(key)); },
            openCursor() {
                const rows = [...staged.entries()];
                let index = 0;
                const req = {};
                const advance = () => {
                    pending++;
                    setImmediate(() => {
                        if (closed) return;
                        req.result = index < rows.length ? { key: rows[index][0], value: structuredClone(rows[index++][1]), continue: advance } : null;
                        req.onsuccess?.({ target: req });
                        pending--;
                        complete();
                    });
                };
                advance();
                return req;
            },
        };
        const result = callback(store);
        complete();
        return result;
    };
    state.open = () => ({ name, objectStoreNames: { contains: key => key === storeName }, close() {}, transaction(key, mode) {
        const tx = { db: { name } };
        // useStore 的同步回调先提供 store，原生 open() 随后设置外层事务监听器。
        let store;
        state.useStore(mode, value => {
            store = value;
            value.transaction.oncomplete = event => tx.oncomplete?.(event);
            value.transaction.onabort = value.transaction.onerror = event => { tx.error = value.transaction.error; tx.onabort?.(event); };
        });
        tx.objectStore = () => store;
        return tx;
    } });
    return state;
}

const pack = value => new Uint8Array(Buffer.from(value));
const bootKey = 'modhub_restore_startup_v1';
const pointKey = 'modhub_restore_points_v1';
const journalKey = 'modhub_restore_journal_v1';
const blobPrefix = 'modhub_restore_blob_v1:';

function harness(options = {}) {
    const mod = options.mod || database('mods-custom', 'mods-custom', [
        ['enabled-custom', '["前置","ModHub","A"]'], ['disabled-custom', '["B"]'],
        ['package-custom:前置', pack('前置包')], ['package-custom:ModHub', pack('ModHub 当前包')],
        ['package-custom:A', pack('A 旧包')], ['package-custom:B', pack('B 旧包')],
        ['unrelated-game-save', { keep: true }],
    ]);
    const beauty = options.beauty || database('beauty-custom', 'beauty-custom', [['order-custom', '["美化甲","美化乙"]'], ['图片缓存', '保留']]);
    const databases = options.databases || new Map([[mod.name, mod], [beauty.name, beauty]]);
    const storage = options.storage || new Map([['modhub_sideload_mod_order', '["前置","ModHub","B","A"]'], ['dol_opt_auto_enable_sideload_beauty', 'false'], ['modhub_auto_open_log_on_error', 'true'], ['game-save', '不变']]);
    const hooks = new Map();
    const controller = { logRecordBeforeAnyLogHookRegister: options.cachedLogs || [], addLifeTimeCircleHook: (id, hook) => hooks.set(id, hook), async checkModZipFileIndexDB(data) {
        const text = Buffer.from(data).toString();
        if (text.startsWith('ModHub')) return { name: 'ModHub', version: '1.2.0', dependenceInfo: [{ modName: '前置', version: '^1.0.0' }] };
        if (text.startsWith('前置')) return { name: '前置', version: '1.0.0' };
        if (text.startsWith('A')) return { name: 'A', version: '1.0.0' };
        if (text.startsWith('B')) return { name: 'B', version: '1.0.0' };
        return '未知包体';
    } };
    const schema = { dbName: mod.name, storeName: mod.storeName, modDataIndexDBZipList: 'enabled-custom', modDataIndexDBZipListHidden: 'disabled-custom', calcModNameKey: name => `package-custom:${name}` };
    const loader = { constructor: schema, customStore: mod.useStore };
    const modLoader = { getIndexDBLoader: () => loader, getLoaderKeyConfig: () => ({ getLoaderKey: (key, fallback) => ({ BeautySelectorAddon: beauty.name, BeautySelectorAddon_OrderSaveKey: 'order-custom' })[key] || fallback }) };
    if (options.readCache) modLoader.getModReadCache = () => ({ get_Array: () => options.readCache });
    if (options.initializedCache) modLoader.getModCacheArray = () => options.initializedCache;
    const document = createDocumentStub();
    document.head = createStubElement('head');
    const screen = createStubElement('div');
    screen.id = 'init-screen';
    document.body.appendChild(screen);
    if (options.progressLog) {
        const log = createStubElement('div');
        log.id = 'LoadingProgressLog';
        log.style.zIndex = '500001';
        document.body.appendChild(log);
    }
    document.getElementById = id => {
        const find = element => element.id === id ? element : element.children.map(find).find(Boolean);
        return find(document.body) || find(document.head) || null;
    };
    let reloads = 0;
    const intervals = [];
    const dialogs = [];
    const events = new Map();
    const lockRegistry = mod.lockRegistry || (mod.lockRegistry = new Map());
    const heldLocks = new Set();
    const navigator = options.noLocks ? {} : { locks: { async request(name, config, callback) {
        if (lockRegistry.has(name)) return callback(null);
        const token = {};
        lockRegistry.set(name, token);
        heldLocks.add(name);
        try { return await callback({ name }); }
        finally { if (lockRegistry.get(name) === token) lockRegistry.delete(name); heldLocks.delete(name); }
    } } };
    const indexedDB = { open(name) {
        const request = {};
        setImmediate(() => {
            const db = databases.get(name);
            if (!db) {
                request.transaction = { abort() { request.error = new Error('不存在的数据库'); setImmediate(() => request.onerror?.()); } };
                request.onupgradeneeded?.();
            } else { request.result = db.open(); request.onsuccess?.(); }
        });
        return request;
    } };
    const sandbox = createBaseSandbox({
        Uint8Array, ArrayBuffer, Blob, crypto: webcrypto, atob, indexedDB, document, navigator, Date: options.Date || Date, performance: options.performance,
        modUtils: { getModLoader: () => modLoader, getModLoadController: () => controller }, modModLoadController: controller,
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        location: { href: 'file:///游戏/Degrees of Lewdity.html', reload() { reloads++; heldLocks.forEach(name => lockRegistry.delete(name)); } },
        StartConfig: { version: '0.5.11.9' },
        setInterval: callback => { intervals.push(callback); return intervals.length; },
        clearInterval() {},
        addEventListener: (name, callback) => events.set(name, callback),
        getComputedStyle: element => ({ display: element.style.display || 'block', visibility: element.style.visibility || 'visible' }),
        console: { warn() {}, error() {}, log() {} },
        modHubKeepRecoveryOrder: names => [...names],
        modHubConfirm: async opts => {
            dialogs.push(opts);
            if (options.renderDialogs) {
                const overlay = createStubElement('div');
                overlay.className = 'modhub-modal-backdrop';
                const dialog = createStubElement('div');
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);
                opts.onRender?.(dialog);
            }
            return options.confirm ? options.confirm(opts) : opts.title === '确认时间点还原';
        },
    });
    sandbox.modHubShowRestorePanel = async opts => {
        if (options.panel) return options.panel(opts);
        const state = await sandbox.modHubRestore.getPanelState();
        return sandbox.modHubConfirm({ title: '测试还原面板', reason: opts?.reason, points: state.points, recommendedId: state.recommendedId, onRender: dialog => sandbox.modHubRestore.mountDialog(dialog, opts?.startup) });
    };
    loadScripts(sandbox, ['javascript/modhub-restore.js']);
    return { sandbox, api: sandbox.modHubRestore, mod, beauty, storage, hooks, loader, intervals, dialogs, events, document, reloads: () => reloads };
}

async function prepareChange(h, label = '安装 A') {
    const context = h.api.createOperation({ label });
    assert.equal(await h.api.prepare(context), true);
    return context;
}

async function storageControls() {
    const h = harness({ confirm: () => true });
    await h.api.startupReady;
    h.sandbox.SugarCube = { State: { passage: 'Start' } };
    h.document.getElementById('init-screen').style.display = 'none';
    await h.intervals[0]();
    let panel = await h.api.getPanelState();
    assert.deepEqual(JSON.parse(JSON.stringify(panel.config)), { autoCreate: true, maxPoints: 20 });
    await assert.rejects(h.api.saveConfig({ autoCreate: true, maxPoints: 3 }), /仅支持/);
    await h.api.saveConfig({ autoCreate: false, maxPoints: 50 });
    const off = h.api.createOperation();
    assert.equal(await h.api.prepare(off), true);
    assert.equal(off.pointId, null, '关闭自动创建后不建立普通操作还原点');
    const sibling = harness({ mod: h.mod, beauty: h.beauty, storage: h.storage, confirm: () => true });
    await sibling.api.startupReady;
    assert.equal(await sibling.api.prepare(sibling.api.createOperation()), false, '不自动建点仍持有跨页面操作锁');
    await h.api.finish(off);
    const first = await h.api.createPoint('');
    const long = await h.api.createPoint('手'.repeat(100));
    const samePoint = await h.api.createPoint('相同状态');
    panel = await h.api.getPanelState();
    assert.equal(panel.points.length, 3, '手动相同状态也必须保留');
    assert.equal(panel.points.find(point => point.id === first).label, '手动还原点');
    assert.equal(Array.from(panel.points.find(point => point.id === long).label).length, 80);
    assert.ok(panel.points.every(point => point.kind === 'manual' && !point.protected));
    assert.equal(h.mod.data.get(pointKey).find(point => point.id === samePoint).pending, false);
    const expectedBytes = [...h.mod.data].filter(([key]) => key.startsWith('package-custom:')).reduce((sum, [, value]) => sum + value.byteLength, 0);
    assert.equal(panel.usageBytes, expectedBytes, '相同包体按唯一 hash 的原始 size 计量');
    assert.equal([...h.mod.data.keys()].filter(key => key.startsWith(blobPrefix)).length, 4);
    assert.equal(h.mod.data.get(pointKey).some(point => point.state.settings.modhub_restore_config), false, '还原设置不进入模组快照');
    const identity = harness({ mod: h.mod, beauty: h.beauty, storage: h.storage });
    await identity.api.startupReady;
    identity.loader.constructor.modDataIndexDBZipList = '其他启用列表';
    assert.deepEqual(JSON.parse(JSON.stringify((await identity.api.getPanelState()).config)), { autoCreate: true, maxPoints: 20 }, '不同加载器存储身份使用独立设置');
    assert.equal((await h.api.getPanelState()).config.maxPoints, 50);
    for (let i = 0; i < 5; i++) await h.api.createPoint(`手动点 ${i}`);
    const originalIds = (await h.api.getPanelState()).points.map(point => point.id);
    h.mod.failPut = key => key.startsWith('modhub_restore_config_v1:') ? new Error('模拟设置提交失败') : null;
    await assert.rejects(h.api.saveConfig({ autoCreate: false, maxPoints: 5 }), /模拟设置提交失败/);
    panel = await h.api.getPanelState();
    assert.equal(panel.config.maxPoints, 50, '设置与旧点删除必须原子提交');
    assert.deepEqual(panel.points.map(point => point.id), originalIds);
    h.mod.failPut = null;
    assert.equal(await h.api.saveConfig({ autoCreate: false, maxPoints: 5 }), true);
    panel = await h.api.getPanelState();
    assert.equal(panel.points.length, 5);
    assert.ok(h.dialogs.some(dialog => dialog.title === '减少还原点保留数量' && dialog.message.includes('删除 3 个旧还原点')));
    assert.equal(panel.usageBytes, expectedBytes, '降低上限不得清理仍被保留点引用的包体');
    const deleteOne = panel.points[0].id;
    assert.equal(await h.api.deletePoints([deleteOne]), true);
    panel = await h.api.getPanelState();
    assert.equal(panel.points.length, 4);
    assert.equal(panel.usageBytes, expectedBytes);
    h.mod.failPut = key => key === pointKey ? new Error('模拟目录提交失败') : null;
    await assert.rejects(h.api.deletePoints(panel.points.map(point => point.id)), /模拟目录提交失败/);
    assert.equal((await h.api.getPanelState()).points.length, 4);
    assert.equal([...h.mod.data.keys()].filter(key => key.startsWith(blobPrefix)).length, 4, '删点失败时无引用清理也不得提交');
    h.mod.failPut = null;
    await h.api.deletePoints(panel.points.map(point => point.id));
    assert.equal((await h.api.getPanelState()).usageBytes, 0);
    assert.equal([...h.mod.data.keys()].filter(key => key.startsWith(blobPrefix)).length, 0);
    assert.equal(h.storage.get('game-save'), '不变');
    assert.deepEqual(h.mod.data.get('unrelated-game-save'), { keep: true });
    assert.equal(h.sandbox._modHubReloadRevision, undefined, '归档设置与删点不增加模组重载提醒');

    const cancelled = harness();
    await cancelled.api.startupReady;
    for (let i = 0; i < 6; i++) await cancelled.api.createPoint(`保留点 ${i}`);
    assert.equal(await cancelled.api.saveConfig({ autoCreate: false, maxPoints: 5 }), false);
    assert.equal((await cancelled.api.getPanelState()).config.maxPoints, 20);
    assert.equal((await cancelled.api.getPanelState()).points.length, 6);
    assert.equal(await cancelled.api.deletePoints([(await cancelled.api.getPanelState()).points[0].id]), false);
    assert.equal((await cancelled.api.getPanelState()).points.length, 6);

    const guarded = harness({ confirm: () => true });
    await guarded.api.startupReady;
    await guarded.api.saveConfig({ autoCreate: true, maxPoints: 5 });
    let earliest;
    for (let i = 0; i < 8; i++) {
        const context = await prepareChange(guarded);
        earliest ||= context.id;
        guarded.mod.data.set('package-custom:A', pack(`A 上限保护 ${i}`));
        await guarded.api.finish(context);
    }
    panel = await guarded.api.getPanelState();
    assert.equal(panel.points.length, 5);
    assert.equal(panel.recommendedId, earliest);
    assert.ok(panel.protectedIds.includes(earliest));
    await assert.rejects(guarded.api.deletePoints([earliest]), /不能删除/);
    const other = panel.points.find(point => !point.protected);
    await guarded.api.deletePoints([other.id]);
    assert.ok((await guarded.api.getPanelState()).points.some(point => point.id === earliest));
    const old = guarded.mod.data.get(pointKey).find(point => point.id === earliest);
    const safety = { ...structuredClone(old), id: 'before-restore-引用保护', kind: 'preRestore' };
    guarded.mod.data.set(pointKey, [safety, ...guarded.mod.data.get(pointKey)]);
    guarded.mod.data.set(journalKey, { version: 1, pointId: old.id, safetyPointId: safety.id, source: safety.state, target: old.state });
    panel = await guarded.api.getPanelState();
    assert.ok(panel.protectedIds.includes(old.id) && panel.protectedIds.includes(safety.id), '恢复记录同时保护目标点与还原前安全点');
    assert.equal(panel.restoring, true);
    await assert.rejects(guarded.api.deletePoints([safety.id]), /恢复尚未完成/);
    await guarded.api.saveConfig({ autoCreate: false, maxPoints: 5 }).then(() => assert.fail('恢复记录不能被设置绕过'), error => assert.match(error.message, /恢复尚未完成/));

    const strict = harness({ confirm: () => true });
    await strict.api.startupReady;
    await strict.api.saveConfig({ autoCreate: false, maxPoints: 20 });
    strict.mod.failPut = key => key === pointKey ? Object.assign(new Error('手动点空间不足'), { name: 'QuotaExceededError' }) : null;
    await assert.rejects(strict.api.createPoint('必须成功保存'), /手动点空间不足/);
    assert.equal((await strict.api.getPanelState()).points.length, 0);
    assert.ok(!strict.dialogs.some(dialog => dialog.confirmText === '不建立还原点，继续操作'));
    strict.mod.failPut = null;
    const baseline = await strict.api.createPoint('手动基线');
    const untracked = strict.api.createOperation();
    await strict.api.prepare(untracked);
    strict.mod.data.set('package-custom:A', pack('A 待回滚'));
    strict.mod.data.set('package-custom:ModHub', pack('ModHub 保留当前工具'));
    await strict.api.finish(untracked);
    const previewed = await strict.api.preview(baseline);
    assert.equal(previewed.canRestore, true);
    assert.deepEqual([...previewed.changes.updated], ['A'], '预览须按最终目标保留当前 ModHub 包体');
    assert.equal((await strict.api.preview('已不存在的点')).canRestore, false);
    await strict.api.restore(baseline);
    panel = await strict.api.getPanelState();
    assert.ok(panel.points.some(point => point.kind === 'preRestore'), '关闭自动点仍强制保存还原前状态');
    assert.equal(panel.config.autoCreate, false, '回滚不改变独立还原设置');
    assert.equal(Buffer.from(strict.mod.data.get('package-custom:ModHub')).toString(), 'ModHub 保留当前工具');

    const keepCurrentSelf = harness({ confirm: () => true });
    await keepCurrentSelf.api.startupReady;
    const selfBaseline = await keepCurrentSelf.api.createPoint('保留当前恢复工具');
    const archivedSelf = keepCurrentSelf.mod.data.get(pointKey).find(point => point.id === selfBaseline).state.packages.find(item => item.name === 'ModHub');
    const currentSelf = pack('ModHub 更新后的恢复工具');
    keepCurrentSelf.mod.data.set('package-custom:ModHub', currentSelf);
    keepCurrentSelf.mod.data.set('package-custom:A', pack('A 待回退版本'));
    keepCurrentSelf.mod.data.delete(blobPrefix + archivedSelf.hash);
    const currentSelfHash = require('node:crypto').createHash('sha256').update(currentSelf).digest('hex');
    keepCurrentSelf.mod.data.set(blobPrefix + currentSelfHash, pack('工具归档损坏'));
    const selfPreview = await keepCurrentSelf.api.preview(selfBaseline);
    assert.equal(selfPreview.canRestore, true, '最终保留当前工具时，不要求已废弃的旧工具归档可用');
    assert.deepEqual([...selfPreview.changes.updated], ['A']);
    await keepCurrentSelf.api.restore(selfBaseline);
    assert.deepEqual([...keepCurrentSelf.mod.data.get('package-custom:ModHub')], [...currentSelf]);
    assert.deepEqual([...keepCurrentSelf.mod.data.get(blobPrefix + currentSelfHash)], [...currentSelf], '还原前安全点以真实当前工具包归档，修复已有同 hash 的损坏记录');
    assert.deepEqual([...keepCurrentSelf.mod.data.get('package-custom:A')], [...pack('A 旧包')]);
    assert.equal(keepCurrentSelf.reloads(), 1, '旧工具归档缺失时仍可完成无关模组恢复');

    const failedFinish = harness();
    await failedFinish.api.startupReady;
    const unfinished = await prepareChange(failedFinish);
    failedFinish.mod.data.set('package-custom:A', pack('A 修改后状态'));
    failedFinish.mod.failPut = key => key === pointKey ? new Error('收尾提交失败') : null;
    await failedFinish.api.finish(unfinished);
    assert.equal(unfinished.finished, true);
    assert.match(unfinished.finishError.message, /收尾提交失败/);
    assert.equal(failedFinish.mod.data.get(pointKey).find(point => point.id === unfinished.id).pending, true, '收尾失败保留操作前完整点');
    assert.equal(failedFinish.api.isOperationBlocked(failedFinish.api.createOperation()), false, '收尾失败仍释放操作锁');
    console.log('还原设置、手动点、删除保护与预览测试通过');
}

async function run() {
    await storageControls();
    const old = createBaseSandbox();
    loadScripts(old, ['javascript/modhub-restore.js']);
    assert.ok(old.modHubRestore, '旧沙箱暴露接口且不自动访问数据库');

    const h = harness();
    await h.api.startupReady;
    const noChange = await prepareChange(h, '空操作');
    await h.api.finish(noChange);
    assert.equal((await h.api.list()).length, 0, '无实际变化不留还原点');
    assert.equal(h.mod.data.has('unrelated-game-save'), true);

    const first = await prepareChange(h);
    h.mod.data.set('package-custom:A', pack('A 新包'));
    h.mod.data.set('package-custom:C', pack('C 新包'));
    h.mod.data.set('enabled-custom', '["ModHub","A","C"]');
    h.mod.data.set('disabled-custom', '["B","前置"]');
    h.beauty.data.set('order-custom', '["美化乙"]');
    h.storage.set('modhub_auto_enable_sideload_beauty', 'true');
    await h.api.finish(first);
    assert.equal((await h.api.list()).length, 1);
    const point = h.mod.data.get(pointKey)[0];
    assert.equal(point.state.beauty.value, '["美化甲","美化乙"]', '保存 BSA 原始 JSON 字符串');
    assert.equal(point.state.settings.modhub_auto_enable_sideload_beauty, 'false', '旧键只读得到有效值');
    assert.equal(Object.keys(point.state.settings).length, 2, '日志设置和存档不进入还原范围');
    assert.equal(point.source.gameVersion, '0.5.11.9');
    assert.ok(point.source.html.endsWith('Degrees of Lewdity.html'));
    assert.deepEqual(point.summary.updated, ['A']);
    assert.deepEqual(point.summary.installed, ['C']);

    h.mod.data.set('package-custom:ModHub', pack('ModHub 更新后的包'));
    await h.api.restore(first.id);
    assert.equal(h.reloads(), 1, '完成恢复必须重载以丢弃旧脚本');
    assert.equal(h.api.isRestoring(), true, '重载前不放行旧加载循环');
    assert.equal(h.mod.data.has(journalKey), false, '精确回读后清除恢复日志');
    assert.deepEqual([...h.mod.data.get('package-custom:A')], [...pack('A 旧包')]);
    assert.deepEqual([...h.mod.data.get('package-custom:ModHub')], [...pack('ModHub 更新后的包')], '保留当前恢复工具包');
    assert.equal(h.mod.data.has('package-custom:C'), false, '删除回滚的新包，避免孤儿自愈重新启用');
    assert.equal(h.mod.data.get('enabled-custom'), '["前置","ModHub","A"]');
    assert.equal(h.storage.get('modhub_sideload_mod_order'), '["前置","ModHub","B","A"]', '保留启停交错显示顺序');
    assert.equal(h.beauty.data.get('order-custom'), '["美化甲","美化乙"]');
    assert.equal(h.beauty.data.get('图片缓存'), '保留');
    assert.equal(h.storage.get('game-save'), '不变');
    assert.equal(h.storage.get('modhub_auto_open_log_on_error'), 'true');
    assert.deepEqual(h.mod.data.get('unrelated-game-save'), { keep: true });

    const retained = harness();
    await retained.api.startupReady;
    for (let i = 0; i < 22; i++) {
        const context = await prepareChange(retained, `顺序调整 ${i}`);
        retained.storage.set('modhub_sideload_mod_order', i % 2 ? '["前置","ModHub","B","A"]' : '["前置","ModHub","A","B"]');
        await retained.api.finish(context);
    }
    assert.equal((await retained.api.list()).length, 20, '最多保留 20 个有效点');
    assert.equal([...retained.mod.data.keys()].filter(key => key.startsWith(blobPrefix)).length, 4, '同一包体跨还原点只存一份');
    const ids = (await retained.api.list()).map(item => item.id);
    const retainedFirst = retained.mod.data.get(bootKey).firstPointId;
    assert.equal(ids.at(-1), retainedFirst, '20 点容量保留本轮首次操作前状态');
    const fullNoop = await prepareChange(retained, '容量已满时空操作');
    await retained.api.finish(fullNoop);
    assert.deepEqual((await retained.api.list()).map(item => item.id), ids, '空操作不挤掉旧点');
    const nextBoot = harness({ mod: retained.mod, beauty: retained.beauty, storage: retained.storage });
    await nextBoot.api.startupReady;
    assert.equal(nextBoot.mod.data.get(bootKey).firstPointId, retainedFirst, '失败重启继承待验证轮次首点');
    await nextBoot.api.showHistory();
    assert.equal(nextBoot.dialogs.at(-1).recommendedId, retainedFirst, '面板委托保留本轮首点推荐');

    const batch = harness();
    await batch.api.startupReady;
    await batch.api.withOperation({ label: '批量安装' }, async context => {
        assert.equal(await batch.api.prepare(context), true);
        const other = batch.api.createOperation({ label: '另一操作' });
        assert.equal(batch.api.claim(other), false, '批量上下文阻止无关操作插入');
        assert.equal(batch.api.isOperationBlocked(other), true);
        batch.mod.data.set('package-custom:A', pack('第一步'));
        assert.equal(await batch.api.prepare(context), true, '共享上下文不重建还原点');
        batch.mod.data.set('package-custom:B', pack('第二步'));
    });
    assert.equal((await batch.api.list()).length, 1, '整批安装一个点');

    const crash = harness();
    await crash.api.startupReady;
    const beforeCrash = await prepareChange(crash);
    crash.mod.data.set('package-custom:A', pack('故障安装包'));
    crash.beauty.data.set('order-custom', '["美化乙"]');
    await crash.api.finish(beforeCrash);
    crash.mod.failPut = key => key === 'package-custom:A' ? new Error('模拟恢复事务中断') : null;
    await assert.rejects(crash.api.restore(beforeCrash.id), /模拟恢复事务中断/);
    assert.deepEqual([...crash.mod.data.get('package-custom:A')], [...pack('故障安装包')], '事务失败不得部分覆盖模组');
    assert.equal(crash.mod.data.get(journalKey).phase, 'prepared');
    assert.equal(crash.api.isRestoring(), true);
    crash.mod.failPut = null;
    crash.mod.lockRegistry.clear(); // 模拟刷新时浏览器释放旧页面的 Web Lock。
    const resumed = harness({ mod: crash.mod, beauty: crash.beauty, storage: crash.storage });
    await resumed.api.startupReady;
    assert.equal(resumed.reloads(), 1, '恢复中刷新后先重放日志再重载');
    assert.deepEqual([...resumed.mod.data.get('package-custom:A')], [...pack('A 旧包')]);
    assert.equal(resumed.mod.data.has(journalKey), false);

    const damaged = harness();
    await damaged.api.startupReady;
    const damagePoint = await prepareChange(damaged);
    damaged.mod.data.set('package-custom:A', pack('变化'));
    await damaged.api.finish(damagePoint);
    const archived = damaged.mod.data.get(pointKey)[0].state.packages.find(item => item.name === 'A');
    damaged.mod.data.set(blobPrefix + archived.hash, pack('损坏'));
    const writes = damaged.mod.writes;
    await assert.rejects(damaged.api.restore(damagePoint.id), /校验失败/);
    assert.equal(damaged.mod.writes, writes, '校验失败在任何恢复写入之前拒绝');
    assert.equal(damaged.api.isRestoring(), false);

    const quota = harness();
    await quota.api.startupReady;
    quota.mod.failPut = key => key === pointKey ? Object.assign(new Error('存储已满'), { name: 'QuotaExceededError' }) : null;
    const unavailable = quota.api.createOperation({ label: '空间不足' });
    assert.equal(await quota.api.prepare(unavailable), false, '空间不足默认取消实际操作');
    assert.equal(quota.mod.data.get(pointKey).length, 0, '失败事务不留下半个还原点');
    assert.equal(quota.dialogs[0].cancelText, '取消操作');
    assert.equal(quota.api.isOperationBlocked(quota.api.createOperation()), false, '取消后释放操作所有权');
    assert.equal(unavailable.cancelled, true);
    const quotaDialogs = quota.dialogs.length;
    assert.equal(await quota.api.prepare(unavailable), false);
    assert.equal(quota.dialogs.length, quotaDialogs, '同批次取消不会重复弹窗');

    const quotaRace = harness({ confirm: () => true });
    await quotaRace.api.startupReady;
    let injectQuota = true;
    quotaRace.mod.failPut = key => {
        if (key !== pointKey || !injectQuota) return null;
        injectQuota = false;
        quotaRace.mod.data.set('package-custom:A', pack('A 外部修改'));
        return Object.assign(new Error('第一次容量不足'), { name: 'QuotaExceededError' });
    };
    assert.equal(await quotaRace.api.prepare(quotaRace.api.createOperation()), false, '容量重试仍拒绝来源竞争，不能无点继续');
    assert.equal(quotaRace.mod.data.get(pointKey).length, 0);

    const quotaPrune = harness();
    await quotaPrune.api.startupReady;
    for (let i = 0; i < 3; i++) {
        const context = await prepareChange(quotaPrune);
        quotaPrune.mod.data.set('package-custom:A', pack(`A 版本 ${i}`));
        await quotaPrune.api.finish(context);
    }
    const protectedQuotaFirst = quotaPrune.mod.data.get(bootKey).firstPointId;
    quotaPrune.mod.failPut = (key, value) => key === pointKey && value.length > 3 ? Object.assign(new Error('旧目录占满空间'), { name: 'QuotaExceededError' }) : null;
    const pruned = await prepareChange(quotaPrune);
    quotaPrune.mod.data.set('package-custom:A', pack('A 空间清理后版本'));
    await quotaPrune.api.finish(pruned);
    assert.equal((await quotaPrune.api.list()).length, 3, '容量不足淘汰可清理旧点后重试');
    assert.ok((await quotaPrune.api.list()).some(point => point.id === protectedQuotaFirst), '容量清理保留本轮首点');

    const skip = harness({ confirm: opts => opts.confirmText === '不建立还原点，继续操作' });
    await skip.api.startupReady;
    skip.mod.failPut = key => key === pointKey ? Object.assign(new Error('存储已满'), { name: 'QuotaExceededError' }) : null;
    const withoutPoint = skip.api.createOperation();
    assert.equal(await skip.api.prepare(withoutPoint), true);
    assert.equal(withoutPoint.withoutPoint, true, '显式确认允许不建点继续');
    skip.mod.data.set('package-custom:A', pack('A 无点修改'));
    await skip.api.finish(withoutPoint);
    assert.equal((await skip.api.list()).length, 0);

    const noLocks = harness({ noLocks: true, confirm: () => true });
    await noLocks.api.startupReady;
    const blockedWrites = noLocks.mod.writes;
    assert.equal(await noLocks.api.prepare(noLocks.api.createOperation()), false, '没有跨页面锁不能绕过保护');
    assert.equal(noLocks.mod.writes, blockedWrites);
    await assert.rejects(noLocks.api.restore('不存在'), /跨页面模组操作锁/);

    const windowA = harness();
    await windowA.api.startupReady;
    const windowB = harness({ mod: windowA.mod, beauty: windowA.beauty, storage: windowA.storage });
    await windowB.api.startupReady;
    const ctxA = windowA.api.createOperation(), ctxB = windowB.api.createOperation();
    const claims = await Promise.all([windowA.api.prepare(ctxA), windowB.api.prepare(ctxB)]);
    assert.equal(claims.filter(Boolean).length, 1, '同源两个页面只有一个能建点并修改');
    assert.equal(windowA.mod.data.get(pointKey).length, 1, '并发建点不覆盖目录');
    if (claims[0]) await windowA.api.finish(ctxA); else await windowB.api.finish(ctxB);

    const safetyQuota = harness({ confirm: () => true });
    await safetyQuota.api.startupReady;
    const safetyPoint = await prepareChange(safetyQuota);
    safetyQuota.mod.data.set('package-custom:A', pack('A 新状态'));
    await safetyQuota.api.finish(safetyPoint);
    safetyQuota.mod.failPut = key => key === pointKey ? Object.assign(new Error('无安全点空间'), { name: 'QuotaExceededError' }) : null;
    await assert.rejects(safetyQuota.api.restore(safetyPoint.id), /无安全点空间/);
    assert.equal(safetyQuota.mod.data.has(journalKey), false, '还原前安全点失败不能开始恢复');
    assert.equal(safetyQuota.api.isRestoring(), false);

    const legacyNull = harness();
    await legacyNull.api.startupReady;
    legacyNull.storage.delete('dol_opt_auto_enable_sideload_beauty');
    const nullPoint = await prepareChange(legacyNull);
    legacyNull.storage.set('modhub_auto_enable_sideload_beauty', 'false');
    await legacyNull.api.finish(nullPoint);
    legacyNull.storage.set('dol_opt_auto_enable_sideload_beauty', 'false');
    await legacyNull.api.restore(nullPoint.id);
    assert.equal(legacyNull.storage.get('modhub_auto_enable_sideload_beauty'), 'true', '归一化空配置避免旧回退重新生效');
    assert.equal(legacyNull.mod.data.has(journalKey), false);

    const unknown = harness();
    await unknown.api.startupReady;
    unknown.loader.constructor.storeName = '未知仓库';
    const previousWrites = unknown.mod.writes;
    assert.equal(await unknown.api.prepare(unknown.api.createOperation()), false);
    assert.equal(unknown.mod.writes, previousWrites, '未知仓库一律不写');

    const missingBeauty = harness({ databases: new Map() });
    await missingBeauty.api.startupReady;
    const absentPoint = await prepareChange(missingBeauty);
    missingBeauty.storage.set('modhub_auto_enable_sideload_beauty', 'true');
    await missingBeauty.api.finish(absentPoint);
    assert.equal(missingBeauty.mod.data.get(pointKey)[0].state.beauty.exists, false, '记录无美化库状态，读取不新建数据库');
    await missingBeauty.api.restore(absentPoint.id);
    assert.equal(missingBeauty.reloads(), 1, '原本无美化库时恢复不要求创建新库');

    const embedded = harness();
    await embedded.api.startupReady;
    embedded.mod.data.delete('package-custom:ModHub');
    embedded.mod.data.set('enabled-custom', '["前置","A"]');
    embedded.sandbox.modUtils.getMod = name => name === 'ModHub' ? { bootJson: { name: 'ModHub', version: '1.2.0', dependenceInfo: [{ modName: '前置', version: '^1.0.0' }] } } : undefined;
    const embeddedPoint = await prepareChange(embedded);
    embedded.mod.data.set('package-custom:A', pack('A 错误版本'));
    await embedded.api.finish(embeddedPoint);
    await embedded.api.restore(embeddedPoint.id);
    assert.equal(embedded.reloads(), 1, '当前恢复工具内嵌 HTML 时可恢复其他模组');
    assert.equal(embedded.mod.data.has('package-custom:ModHub'), false);

    const earlyBoot = { name: 'ModHub', version: '1.2.0', scriptFileList_inject_early: ['javascript/modhub-dialog.js', 'javascript/modhub-restore.js'], dependenceInfo: [{ modName: '前置', version: '^1.0.0' }] };
    const rawInfo = { name: 'ModHub', version: '1.2.0', bootJson: earlyBoot };
    const earlyEmbedded = harness({ readCache: [{ name: 'ModHub', from: 'Local', mod: rawInfo, zip: { modInfo: rawInfo } }], initializedCache: [] });
    await earlyEmbedded.api.startupReady;
    earlyEmbedded.mod.data.delete('package-custom:ModHub');
    earlyEmbedded.mod.data.set('enabled-custom', '["前置","A"]');
    assert.equal(earlyEmbedded.sandbox.modUtils.getMod, undefined, '早期尚无普通 ModInfo 查询接口');
    const earlyPoint = await prepareChange(earlyEmbedded);
    earlyEmbedded.mod.data.set('package-custom:A', pack('A 早期故障版本'));
    await earlyEmbedded.api.finish(earlyPoint);
    await earlyEmbedded.api.restore(earlyPoint.id);
    assert.equal(earlyEmbedded.reloads(), 1, '早期内嵌 ModHub 从原始 Local 包档案识别并成功恢复');
    assert.equal(earlyEmbedded.mod.data.has('package-custom:ModHub'), false);

    const zipEmbedded = harness({ readCache: [{ name: 'ModHub', from: 'Local', zip: { getModInfo: () => rawInfo } }], initializedCache: [] });
    await zipEmbedded.api.startupReady;
    zipEmbedded.mod.data.delete('package-custom:ModHub');
    zipEmbedded.mod.data.set('enabled-custom', '["前置","A"]');
    const zipPoint = await prepareChange(zipEmbedded);
    zipEmbedded.mod.data.set('package-custom:A', pack('A ZipReader故障版本'));
    await zipEmbedded.api.finish(zipPoint);
    await zipEmbedded.api.restore(zipPoint.id);
    assert.equal(zipEmbedded.reloads(), 1, '通过真实 ZipReader 已解析 boot 识别恢复工具');

    const lostSideSelf = harness({ readCache: [{ name: 'ModHub', from: 'IndexDB', mod: rawInfo }], initializedCache: [] });
    await lostSideSelf.api.startupReady;
    lostSideSelf.mod.data.delete('package-custom:ModHub');
    lostSideSelf.mod.data.set('enabled-custom', '["前置","A"]');
    const lostSelfPoint = await prepareChange(lostSideSelf);
    lostSideSelf.mod.data.set('package-custom:A', pack('A 新版本'));
    await lostSideSelf.api.finish(lostSelfPoint);
    await assert.rejects(lostSideSelf.api.restore(lostSelfPoint.id), /未找到当前 ModHub 恢复入口/);

    const rawVersion = harness({ readCache: [{ name: 'GameVersion', from: 'Local', mod: { name: 'GameVersion', bootJson: { name: 'GameVersion', version: '0.5.11.9' } } }] });
    delete rawVersion.sandbox.StartConfig;
    await rawVersion.api.startupReady;
    const rawVersionPoint = await prepareChange(rawVersion);
    rawVersion.mod.data.set('package-custom:A', pack('A 版本识别测试'));
    await rawVersion.api.finish(rawVersionPoint);
    assert.equal(rawVersion.mod.data.get(pointKey)[0].source.gameVersion, '0.5.11.9', '早期缺少 StartConfig 时读取真实 GameVersion boot');
    rawVersion.sandbox.StartConfig = { version: '0.5.11.9' };
    await rawVersion.api.restore(rawVersionPoint.id);
    assert.ok(!rawVersion.dialogs.at(-1).message.includes('游戏环境已变化'), '同一游戏版本从早期到普通阶段不会误报变化');

    const unknownVersion = harness();
    delete unknownVersion.sandbox.StartConfig;
    await unknownVersion.api.startupReady;
    const unknownVersionPoint = await prepareChange(unknownVersion);
    unknownVersion.mod.data.set('package-custom:A', pack('A 未知版本测试'));
    await unknownVersion.api.finish(unknownVersionPoint);
    unknownVersion.sandbox.StartConfig = { version: '0.5.11.9' };
    await unknownVersion.api.restore(unknownVersionPoint.id);
    assert.ok(unknownVersion.dialogs.at(-1).message.includes('未能核验游戏版本兼容性'));
    assert.ok(!unknownVersion.dialogs.at(-1).message.includes('游戏环境已变化'), '未知版本提示未核验，不断言版本变化');

    const foreign = harness();
    await foreign.api.startupReady;
    const foreignPoint = await prepareChange(foreign);
    foreign.mod.data.set('package-custom:A', pack('A 问题版本'));
    await foreign.api.finish(foreignPoint);
    const foreignState = structuredClone(foreign.mod.data.get(pointKey)[0].state);
    foreignState.beauty.dbName = '其他美化库';
    foreign.mod.data.set(journalKey, { version: 1, phase: 'prepared', source: foreignState, target: foreignState });
    const foreignBoot = harness({ mod: foreign.mod, beauty: foreign.beauty, storage: foreign.storage });
    await foreignBoot.api.startupReady;
    assert.equal(foreignBoot.reloads(), 0, '拒绝重放来自未知跨库位置的日志');
    assert.equal(foreignBoot.api.isRestoring(), true);
    assert.equal(foreign.mod.data.has(journalKey), true, '冲突日志保留供重新处理');

    const changedHtml = harness({ confirm: opts => !String(opts.message || '').includes('游戏环境已变化') });
    await changedHtml.api.startupReady;
    const environmentPoint = await prepareChange(changedHtml);
    changedHtml.mod.data.set('package-custom:A', pack('A 变化'));
    await changedHtml.api.finish(environmentPoint);
    changedHtml.sandbox.StartConfig.version = '0.6.0';
    const environmentWrites = changedHtml.mod.writes;
    assert.equal(await changedHtml.api.restore(environmentPoint.id), false, '游戏环境差异确认默认取消');
    assert.equal(changedHtml.mod.writes, environmentWrites);
    assert.ok(changedHtml.dialogs.some(opts => opts.title === '确认时间点还原' && opts.message.includes('游戏环境已变化')));

    let fakeNow = 1000;
    class TestDate extends Date { static now() { return fakeNow; } }
    const waiting = harness({ Date: TestDate });
    await waiting.api.startupReady;
    const waitHook = waiting.hooks.get('modHubRestore');
    waitHook.logError('首次使用没有还原点的错误');
    await waitHook.Load_start();
    assert.equal(waiting.dialogs.length, 0, '没有还原点不自动暂停并弹空历史');
    const waitPoint = await prepareChange(waiting);
    waiting.mod.data.set('package-custom:A', pack('A 超时版本'));
    await waiting.api.finish(waitPoint);
    fakeNow += 61000;
    await waiting.intervals[0]();
    await waitHook.Load_start();
    assert.equal(waiting.document.getElementById('modHubRestoreStartupButton').style.display, '', '停滞只显示异常入口');
    assert.equal(waiting.dialogs.length, 0, '停滞不自动弹窗暂停');
    assert.equal(waiting.reloads(), 0, '60 秒无进展可继续等待，不自动回滚');

    const successful = harness();
    await successful.api.startupReady;
    successful.sandbox.SugarCube = { State: { passage: '首界面' } };
    await successful.intervals[0]();
    assert.equal(successful.mod.data.get(bootKey).pending, true, '遮罩仍可见不能判定启动完成');
    successful.sandbox.getComputedStyle = () => ({ display: 'none' });
    await successful.intervals[0]();
    assert.equal(successful.mod.data.get(bootKey).pending, false);
    const afterSuccess = await prepareChange(successful);
    successful.mod.data.set('package-custom:A', pack('A 首界面后安装'));
    await successful.api.finish(afterSuccess);
    await successful.intervals[0]();
    assert.equal(successful.mod.data.get(bootKey).changesPending, true, '当前旧首界面不验证后来安装的新配置');
    assert.equal(successful.mod.data.get(bootKey).firstPointId, afterSuccess.id);

    const logLayer = harness({ progressLog: true, renderDialogs: true });
    await logLayer.api.startupReady;
    await logLayer.api.showHistory({ startup: true });
    assert.equal(logLayer.document.getElementById('modHubRestoreStartupHost').parentNode.id, 'LoadingProgressLog', '加载弹窗位于 z-index 更高的日志层之内');

    const lateLayer = harness({ renderDialogs: true });
    await lateLayer.api.startupReady;
    await lateLayer.api.showHistory({ startup: true });
    const lateHost = lateLayer.document.getElementById('modHubRestoreStartupHost');
    assert.equal(lateHost.parentNode.id, 'init-screen', '尚无加载日志层时使用加载遮罩');
    const lateLog = createStubElement('div');
    lateLog.id = 'LoadingProgressLog';
    lateLog.style.zIndex = '500001';
    lateLayer.document.body.appendChild(lateLog);
    lateLayer.hooks.get('modHubRestore').logInfo('日志层在弹窗后创建');
    assert.equal(lateHost.parentNode, lateLog, '日志回调将已有弹窗迁移至晚创建的日志层');
    assert.equal(lateLayer.document.getElementById('modHubRestoreStartupButton').parentNode, lateLog, '手动恢复入口同步迁移到上层');
    assert.equal(lateLayer.api.getStartupLogs().at(-1).message, '日志层在弹窗后创建');
    assert.equal(lateLayer.sandbox.modModLoadController.logRecordBeforeAnyLogHookRegister.at(-1).message, '日志层在弹窗后创建', '迁移保持原日志缓存');
    lateLog.style.display = 'none';
    await lateLayer.intervals[0]();
    assert.equal(lateHost.parentNode.id, 'init-screen', '隐藏的日志层不作为弹窗挂载位置');
    const normalDialog = harness({ progressLog: true, renderDialogs: true });
    await normalDialog.api.startupReady;
    await normalDialog.api.showHistory();
    assert.equal(normalDialog.document.getElementById('modHubRestoreStartupHost'), null, '普通界面弹窗仍挂在 body');

    const logs = harness();
    await logs.api.startupReady;
    const hook = logs.hooks.get('modHubRestore');
    hook.logWarning('普通警告');
    hook.logInfo('加载继续');
    assert.equal(logs.api.getStartupLogs().length, 2);
    assert.equal(logs.mod.data.get(bootKey).pending, true, 'ModLoader 结束不等于游戏启动成功');
    await hook.ModLoaderLoadEnd();
    assert.equal(logs.mod.data.get(bootKey).pending, true);
    assert.deepEqual(logs.sandbox.modModLoadController.logRecordBeforeAnyLogHookRegister.map(item => item.type), ['warning', 'info'], 'hook 不吃掉原日志缓存');

    const startupPoint = await prepareChange(logs);
    logs.mod.data.set('package-custom:A', pack('出错版本'));
    await logs.api.finish(startupPoint);
    hook.logError('测试启动 Error');
    await hook.Load_start('A', 'bad.js');
    assert.equal(logs.document.getElementById('modHubRestoreStartupButton').style.display, '', '启动错误显示手动恢复入口');
    assert.equal(logs.dialogs.length, 0, '启动错误不自动打开面板');
    assert.equal(logs.api.getStartupLogs().at(-1).level, 'error');
    assert.equal(logs.sandbox.modModLoadController.logRecordBeforeAnyLogHookRegister.at(-1).type, 'error');
    assert.ok(logs.document.getElementById('modHubRestoreStartupButton'), '加载页始终保留手动恢复入口');
    console.log('时间点还原事务、去重、失败恢复与早期守卫测试通过');
}

module.exports = run;
module.exports.harness = harness;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
