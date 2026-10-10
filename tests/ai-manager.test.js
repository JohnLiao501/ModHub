// AI 单包替换使用真实事务协议，保持配置并防止覆盖其他操作。
const { assert, loadScripts } = require('./helpers');
const { harness } = require('./restore.test');

const pack = text => new Uint8Array(Buffer.from(text));
const text = value => typeof value === 'string' ? Buffer.from(value, 'base64').toString() : Buffer.from(value).toString();
const enabledKey = 'enabled-custom', disabledKey = 'disabled-custom', packageKey = 'package-custom:A';

async function setup(options = {}) {
    const h = harness(options);
    await h.api.startupReady;
    const sb = h.sandbox, controller = sb.modModLoadController;
    controller.listModIndexDB = async () => JSON.parse(h.mod.data.get(enabledKey));
    controller.loadHiddenModList = async () => JSON.parse(h.mod.data.get(disabledKey));
    sb.modUtils.getIdbKeyValRef = () => ({ get: async key => structuredClone(h.mod.data.get(key)) });
    sb.modUtils.getModListNameNoAlias = () => [];
    sb.btoa = btoa;
    loadScripts(sb, ['javascript/modhub-manager.js']);
    sb.modHubGetGui = () => ({ gModUtils: sb.modUtils });
    sb.modHubGetController = () => controller;
    sb.modHubLoadModManageState = async () => {
        const enabled = await controller.listModIndexDB(), disabled = await controller.loadHiddenModList();
        sb._modHubModState = { sideEnabled: enabled, sideDisabled: disabled, sideMods: [...enabled.map(name => ({ name, enabled: true })), ...disabled.map(name => ({ name, enabled: false }))], builtInMods: [] };
        return sb._modHubModState;
    };
    await sb.modHubLoadModManageState();
    sb.modHubLoadBeautyState = async () => {};
    sb.modHubRenderModManageUI = sb.modHubUpdateManagerStatus = () => {};
    sb.modHubShowToast = () => {};
    const originalCheck = controller.checkModZipFileIndexDB;
    controller.checkModZipFileIndexDB = async data => originalCheck(pack(text(data)));
    const plan = { name: 'A', baselineData: pack('A 旧包'), data: pack('A 修复包'), enabled: ['前置', 'ModHub', 'A'], disabled: ['B'] };
    const invalidations = [];
    sb.modHubMarket = { invalidateLocalPackageProfiles: () => invalidations.push(text(h.mod.data.get(packageKey))) };
    return { ...h, sb, controller, plan, invalidations };
}

module.exports = async function() {
    {
        const h = await setup();
        const raw = await h.sb.modHubReadInstalledModPackage('A');
        assert.equal(text(raw.data), 'A 旧包');
        const boot = await h.sb.modHubReadInstalledModBoot('A');
        assert.equal(boot.bootJson.name, 'A');
        assert.equal(Object.hasOwn(boot, 'data'), false, '原只读声明接口不得泄露包体');
        const beforeEnabled = h.mod.data.get(enabledKey), beforeDisabled = h.mod.data.get(disabledKey);
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, true, result.reason);
        assert.ok(result.pointId);
        assert.equal(text(h.mod.data.get(packageKey)), 'A 修复包');
        assert.equal(h.mod.data.get(enabledKey), beforeEnabled);
        assert.equal(h.mod.data.get(disabledKey), beforeDisabled);
        assert.deepEqual(h.mod.data.get('unrelated-game-save'), { keep: true });
        const point = h.mod.data.get('modhub_restore_points_v1').find(item => item.id === result.pointId);
        assert.equal(point.kind, 'auto');
        assert.equal(point.operation, 'aiRepair', 'AI 前置还原点以明确操作来源区分，不能依赖标题前缀');
        assert.equal(point.summary.updated[0], 'A');
        assert.equal(h.sb.modHubIsReloadBusy(), false, '返回时所有操作锁必须已释放');
        assert.equal(h.sb._modHubReloadRevision, 1);
        assert.equal(h.reloads(), 0, '单包保存不自动重载');
        assert.deepEqual(h.invalidations, ['A 修复包'], '真实包体事务提交后立即使市场档案缓存失效');
        assert.equal(await h.api.restore(result.pointId), true, '使用现有还原流程可撤销 AI 包体替换');
        assert.equal(text(h.mod.data.get(packageKey)), 'A 旧包');
    }
    {
        const h = await setup();
        await h.api.saveConfig({ autoCreate: false, maxPoints: 5 });
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, true, result.reason);
        const point = h.mod.data.get('modhub_restore_points_v1').find(item => item.id === result.pointId);
        assert.equal(point.kind, 'auto', '关闭普通自动建点后，AI 修复仍强制创建自动还原点');
        assert.equal(point.operation, 'aiRepair');
        assert.equal((await h.api.getPanelState()).points.find(item => item.id === point.id).systemProtected, true, '修复前首点仍按原保护规则保留');
    }
    {
        const h = await setup({ confirm: () => true });
        await h.api.saveConfig({ autoCreate: false, maxPoints: 5 });
        h.mod.failPut = key => key === 'modhub_restore_points_v1' ? new Error('模拟强制还原点失败') : null;
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false);
        assert.equal(text(h.mod.data.get(packageKey)), 'A 旧包');
        assert.equal(h.invalidations.length, 0, '前置还原点失败、尚未写入时不使市场档案缓存失效');
        assert.ok(!h.dialogs.some(dialog => dialog.title === '未能建立还原点'), 'AI 前置保护失败不能提供跳过备份入口');
    }
    {
        const h = await setup();
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, true, result.reason);
        const legacy = structuredClone(h.mod.data.get('modhub_restore_points_v1').find(item => item.id === result.pointId));
        legacy.kind = 'manual';
        delete legacy.operation;
        h.mod.data.set('modhub_restore_points_v1', [legacy]);
        const writes = h.mod.writes;
        assert.equal((await h.api.getPanelState()).points[0].kind, 'auto', '旧 AI 修复前记录以完整单包更新摘要兼容显示为自动创建');
        assert.equal(h.mod.writes, writes, '兼容显示不改写历史和保护元数据');
        assert.equal(h.mod.data.get('modhub_restore_points_v1')[0].kind, 'manual');
        const manualId = await h.api.createPoint('AI 修复前：A');
        assert.equal((await h.api.getPanelState()).points.find(item => item.id === manualId).kind, 'manual', '玩家手动创建的同名点保持手动类型');
        for (const change of [
            point => { point.label += '其他说明'; },
            point => { point.summary.updated.push('B'); },
            point => { point.summary.orderChanged = true; },
            point => { delete point.summary.settingsChanged; },
            point => { point.operation = 'manual'; },
        ]) {
            const point = structuredClone(legacy);
            change(point);
            h.mod.data.set('modhub_restore_points_v1', [point]);
            assert.equal((await h.api.getPanelState()).points[0].kind, 'manual', '缺少确切旧 AI 操作证据的记录不按标题猜测类型');
        }
    }
    {
        const h = await setup();
        h.mod.data.set(packageKey, Buffer.from('A 旧包').toString('base64'));
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, true, result.reason);
        assert.equal(typeof h.mod.data.get(packageKey), 'string', '保留仓库原 base64 类型');
        assert.equal(text(h.mod.data.get(packageKey)), 'A 修复包');
    }
    for (const optionalMarket of [undefined, {}]) {
        const h = await setup();
        h.sb.modHubMarket = optionalMarket;
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, true, '市场或缓存失效接口未就绪时仍可保存 AI 修复包体');
        assert.equal(text(h.mod.data.get(packageKey)), 'A 修复包');
    }
    for (const change of ['baseline', 'lists', 'manifest', 'protected', 'backup']) {
        const h = await setup();
        if (change === 'baseline') h.plan.baselineData = pack('A 过期原包');
        if (change === 'lists') h.plan.enabled = ['ModHub', '前置', 'A'];
        if (change === 'manifest') h.controller.checkModZipFileIndexDB = async data => ({ name: text(data).startsWith('A') ? 'A' : text(data).startsWith('ModHub') ? 'ModHub' : '前置', version: text(data).includes('修复') ? '2.0.0' : '1.0.0' });
        if (change === 'protected') { h.plan.name = '前置'; h.plan.baselineData = pack('前置包'); h.plan.data = pack('前置修改包'); }
        if (change === 'backup') h.mod.failPut = key => key === 'modhub_restore_points_v1' ? new Error('模拟强制还原点失败') : null;
        const original = text(h.mod.data.get(packageKey));
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false, change);
        assert.equal(text(h.mod.data.get(packageKey)), original, `${change}失败不得写入包体`);
        assert.equal(h.invalidations.length, 0, `${change}失败未写入，不调用缓存失效接口`);
        assert.equal(h.sb.modHubIsReloadBusy(), false, `${change}失败必须释放锁`);
    }
    for (const change of ['anchor', 'version', 'path', 'dependency']) {
        const h = await setup();
        h.sb.TextEncoder = TextEncoder;
        loadScripts(h.sb, ['javascript/modhub-ai-package.js']);
        const oldBoot = { name: 'A', version: '1.0.0', dependenceInfo: [], addonPlugin: [
            { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ passage: 'Ocean Breeze', findString: '旧查找串', replaceFile: 'patch.txt' }] },
        ] };
        const nextBoot = structuredClone(oldBoot);
        nextBoot.addonPlugin[0].params[0].findString = '已核验的新查找串';
        if (change === 'version') nextBoot.version = '2.0.0';
        if (change === 'path') nextBoot.addonPlugin[0].params[0].replaceFile = 'new.txt';
        if (change === 'dependency') nextBoot.dependenceInfo = [{ modName: '新前置', version: '*' }];
        const check = h.controller.checkModZipFileIndexDB;
        h.controller.checkModZipFileIndexDB = async data => text(data).startsWith('A') ? structuredClone(text(data).includes('修复') ? nextBoot : oldBoot) : check(data);
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, change === 'anchor', result.reason);
        assert.equal(text(h.mod.data.get(packageKey)), change === 'anchor' ? 'A 修复包' : 'A 旧包', '仅补丁查找串可通过保存边界，其余清单修改禁止');
        if (change === 'anchor') {
            assert.ok(result.pointId);
            assert.equal(await h.api.restore(result.pointId), true);
            assert.equal(text(h.mod.data.get(packageKey)), 'A 旧包', '查找串修复也可由修复前还原点撤销');
        }
    }
    {
        const h = await setup();
        h.mod.failPut = key => key === packageKey ? new Error('模拟包体写入失败') : null;
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false);
        assert.equal(text(h.mod.data.get(packageKey)), 'A 旧包');
        assert.equal(h.invalidations.length, 0, '包体事务未提交时不调用缓存失效接口');
        assert.ok(result.pointId, '写入失败仍保留修复前还原点');
    }
    {
        const h = await setup();
        h.mod.failPut = key => key === 'modhub_restore_points_v1' && text(h.mod.data.get(packageKey)) === 'A 修复包' ? new Error('模拟还原点整理失败') : null;
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false);
        assert.match(result.reason, /包体已经写入/);
        assert.match(result.reason, /模拟还原点整理失败/);
        assert.equal(text(h.mod.data.get(packageKey)), 'A 修复包', '还原点整理失败不能谎称包体已经撤销');
        assert.deepEqual(h.invalidations, ['A 修复包'], '写后还原点整理失败也必须使市场档案缓存失效');
        assert.equal(h.sb._modHubReloadRevision, 0, '缓存失效不能依赖成功收尾才增长的重载版本');
        assert.ok(result.pointId);
        assert.equal(h.sb.modHubIsReloadBusy(), false);
    }
    {
        const h = await setup();
        const useStore = h.loader.customStore;
        let changed = false;
        h.loader.customStore = (mode, callback) => {
            if (mode === 'readwrite' && !changed && text(h.mod.data.get(packageKey)) === 'A 旧包' && h.mod.data.get('modhub_restore_points_v1')?.some(point => point.label.startsWith('AI 修复前'))) {
                changed = true;
                h.mod.data.set(packageKey, pack('A 其他页面新包'));
            }
            return useStore(mode, callback);
        };
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false);
        assert.equal(text(h.mod.data.get(packageKey)), 'A 其他页面新包', '提交前发生并发改包时保留对方数据');
        assert.equal(h.invalidations.length, 0, '并发保护拒绝本次写入时不调用缓存失效接口');
    }
    for (const externalWrite of [false, true]) {
        const h = await setup();
        const useStore = h.loader.customStore;
        let triggered = false;
        h.loader.customStore = (mode, callback) => {
            if (mode === 'readonly' && !triggered && text(h.mod.data.get(packageKey)) === 'A 修复包') {
                triggered = true;
                assert.deepEqual(h.invalidations, ['A 修复包'], '写后第一次回读之前就必须使市场档案缓存失效');
                if (externalWrite) h.mod.data.set(packageKey, pack('A 外部再次修改'));
                else return Promise.reject(new Error('模拟写后回读失败'));
            }
            return useStore(mode, callback);
        };
        const result = await h.sb.modHubApplyAiPackage(h.plan);
        assert.equal(result.ok, false);
        assert.equal(text(h.mod.data.get(packageKey)), externalWrite ? 'A 外部再次修改' : 'A 旧包', '撤销只允许覆盖本次提交的包体');
        assert.deepEqual(h.invalidations, ['A 修复包'], '写后回读失败或安全撤销不能恢复旧的市场档案缓存');
        assert.ok(result.pointId);
    }
    console.log('AI 单包事务、强制保护、配置保留与安全撤销测试通过');
};

if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
