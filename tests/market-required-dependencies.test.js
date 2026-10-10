// 目录强制前置必须覆盖直接导入与管理器锁内的最终写入。
const { assert, loadMarket, loadScripts, createMockController } = require('./helpers');

function fixture(providers = [], { required = true, range = '*', disabled = [] } = {}) {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-variants.js']);
    const targetBoot = { name: 'RequiredTargetFixture', version: '1.1.0', dependenceInfo: [] };
    const mod = { id: 'required-target-fixture', name: '目录前置直接导入测试', bootNames: [targetBoot.name],
        version: targetBoot.version, githubUrl: 'https://github.com/ModHubTests/RequiredTargetFixture',
        ...(required ? { requiredDependencies: [{ modName: 'ModI18N', version: range }] } : {}) };
    const releaseInfo = { tagName: 'v1.1.0', version: targetBoot.version, assets: [{ name: 'RequiredTargetFixture-v1.1.0.zip',
        downloadUrl: `${mod.githubUrl}/releases/download/v1.1.0/RequiredTargetFixture-v1.1.0.zip` }] };
    const boots = new Map(providers.map(boot => [boot.name, { ...boot }]));
    const controller = createMockController({ enabled: [...boots.keys()].filter(name => !disabled.includes(name)),
        disabled, zips: [...boots.keys()] });
    const state = { downloads: 0, reads: 0, imports: 0, beforeImports: 0, failures: [], alerts: [], toasts: [] };
    const syncState = () => sb._modHubModState = { sideEnabled: [...controller.store.enabled], sideDisabled: [...controller.store.disabled],
        sideMods: [...boots.keys()].map(name => ({ name, enabled: controller.store.enabled.includes(name) })), builtInMods: [] };
    const gui = {
        listSideLoadModNameOnly: async () => [...controller.store.enabled],
        listSideLoadHiddenModNameOnly: async () => [...controller.store.disabled],
        gModUtils: { getModLoader: () => ({ getModCacheArray: () => [...boots.values()].map(bootJson => ({
            name: bootJson.name, mod: { name: bootJson.name, version: bootJson.version, bootJson }
        })) }) },
        loadAndAddMod: async input => {
            const files = Array.isArray(input) ? input : Array.from(input.files || []);
            assert.equal(files.length, 1, '真实导入器仅收到所选目标包');
            state.imports++;
            boots.set(targetBoot.name, { ...targetBoot });
            controller.store.zips.add(targetBoot.name);
            controller.store.enabled.push(targetBoot.name);
            syncState();
        }
    };
    sb.Blob = Blob; sb.AbortController = AbortController;
    sb.modHubGetGui = () => gui;
    sb.modHubGetController = () => controller;
    sb.modHubGetModInfo = name => boots.has(name) ? { bootJson: boots.get(name) } : null;
    controller.checkModZipFileIndexDB = async () => { state.reads++; return { ...targetBoot }; };
    sb.modHubLoadModManageState = async () => syncState();
    sb.modHubLoadDisabledModInfo = async () => {};
    sb.modHubLoadBeautyState = async () => {};
    sb.modHubReadLocalReadme = async () => null;
    sb.modHubRenderModManageUI = () => {};
    sb.modHubUpdateManagerStatus = () => {};
    sb.modHubShowToast = message => state.toasts.push(message);
    sb.modHubAlert = async message => state.alerts.push(message);
    sb.modHubConfirm = async () => false;
    sb.modHubOfferReload = async () => {};
    sb.fetch = async url => {
        assert.equal(String(url).includes('/releases/download/'), true, '回归仅模拟安装包请求，不访问真实网络');
        state.downloads++;
        return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([7, 9, 11])]) };
    };
    syncState();
    const install = options => sb.modHubMarket.downloadAndInstallMod(mod, 'ddlc', { releaseInfo,
        askRestart: false, skipReloadOffer: true, batchMode: true,
        onFailure: (reason, code) => state.failures.push({ reason, code }), ...options });
    return { sb, mod, targetBoot, boots, controller, state, syncState, install };
}

module.exports = async function () {
    const blocked = [
        { label: '缺失', providers: [] },
        { label: '禁用', providers: [{ name: 'ModI18N', version: '1.0.0' }], options: { disabled: ['ModI18N'] } },
        { label: '只有展示昵称', providers: [{ name: 'NicknameOnlyProvider', version: '1.0.0', nickName: ['ModI18N'] }] },
        { label: '多个真实提供者', providers: [{ name: 'ModI18N', version: '1.0.0' }, { name: 'AlternativeI18N', alias: ['ModI18N'], version: '1.0.0' }] },
        { label: '版本不足', providers: [{ name: 'ModI18N', version: '1.0.0' }], options: { range: '>=2.0.0' } }
    ];
    for (const item of blocked) {
        const f = fixture(item.providers, item.options);
        const before = { enabled: [...f.controller.store.enabled], disabled: [...f.controller.store.disabled], zips: [...f.controller.store.zips] };
        assert.equal(await f.install(), false, `${item.label}不能绕过直接导入接口的目录前置`);
        assert.equal(f.state.imports, 0, `${item.label}必须在真实GUI导入前阻断`);
        assert.equal(f.boots.has(f.targetBoot.name), false);
        assert.deepEqual(f.controller.store.enabled, before.enabled);
        assert.deepEqual(f.controller.store.disabled, before.disabled, '直接接口不能静默启用前置');
        assert.deepEqual([...f.controller.store.zips], before.zips, '失败不得写入包体仓库');
        assert.ok(f.state.failures.some(item => item.code === 'INSTALL_PACKAGE_INVALID' && item.reason.includes('ModI18N')), `${item.label}：${JSON.stringify(f.state.failures)}`);
    }
    {
        const f = fixture([{ name: 'ModI18N', version: '2.1.0' }]);
        delete f.sb.modHubMarketVariants;
        assert.equal(await f.install(), false, '目录要求存在但正常化模块缺失时必须阻止写入');
        assert.equal(f.state.imports, 0);
        assert.equal(f.controller.store.zips.has(f.targetBoot.name), false);
        assert.equal(f.boots.has(f.targetBoot.name), false);
        assert.deepEqual(f.controller.store.enabled, ['ModI18N']);
        assert.deepEqual(f.controller.store.disabled, []);
        assert.ok(f.state.failures.some(item => item.code === 'INSTALL_PACKAGE_INVALID'), '辅助模块缺失应明确返回安装预检失败');
    }
    // 没有额外目录要求的英文类包仍可经原有真实GUI导入。
    {
        const f = fixture([], { required: false });
        assert.equal(await f.install(), true);
        assert.equal(f.state.imports, 1);
        assert.equal(f.controller.store.zips.has(f.targetBoot.name), true);
        assert.equal(f.boots.get(f.targetBoot.name).version, '1.1.0');
    }
    for (const provider of [{ name: 'ModI18N', version: '2.1.0' }, { name: 'NativeAliasProvider', alias: ['ModI18N'], version: '2.1.0' }]) {
        const f = fixture([provider], { range: '>=2.0.0' });
        const handle = f.sb.modHubHandleAddMod;
        f.sb.modHubHandleAddMod = (input, options) => {
            assert.equal(typeof options.beforeImport, 'function', '最终验证回调必须传入真实管理器');
            const validate = options.beforeImport;
            return handle(input, { ...options, beforeImport: async () => { f.state.beforeImports++; await validate(); } });
        };
        assert.equal(await f.install(), true, '唯一且已启用的真实技术名或原生别名提供者可安装');
        assert.equal(f.state.beforeImports, 1, '真实管理器写入动作调用最终验证');
        assert.equal(f.state.imports, 1);
        assert.equal(f.controller.store.zips.has(f.targetBoot.name), true);
        assert.deepEqual(f.controller.store.disabled, []);
    }
    {
        const f = fixture();
        const prepared = await f.install({ prepareOnly: true });
        assert.ok(prepared && Array.isArray(prepared.boots), '缺少目录前置仍允许下载与包体预检供计划展示');
        assert.equal(f.state.downloads, 1);
        assert.equal(f.state.imports, 0);
        assert.equal(f.controller.store.zips.has(f.targetBoot.name), false);
        assert.equal(await f.install({ preparedPackage: prepared }), false, '复用预检包仍须经过最终目录前置检查');
        assert.equal(f.state.downloads, 1, '复用同一预检包不重新下载');
        assert.equal(f.state.imports, 0);
    }
    // 初次验证后，在真实管理器锁内执行回调时前置变为禁用，必须零包体写入。
    {
        const f = fixture([{ name: 'ModI18N', version: '2.1.0' }], { range: '>=2.0.0' });
        const handle = f.sb.modHubHandleAddMod;
        f.sb.modHubHandleAddMod = (input, options) => {
            assert.equal(typeof options.beforeImport, 'function');
            const validate = options.beforeImport;
            return handle(input, { ...options, beforeImport: async () => {
                f.state.beforeImports++;
                assert.equal(f.sb._modHubManagerBusy, true, '最终前置验证必须在真实管理器写入锁内执行');
                f.controller.store.enabled = f.controller.store.enabled.filter(name => name !== 'ModI18N');
                f.controller.store.disabled = ['ModI18N']; f.syncState();
                await validate();
            } });
        };
        assert.equal(await f.install(), false);
        assert.equal(f.state.beforeImports, 1, '状态变化发生于实际管理器执行最终验证期间');
        assert.equal(f.state.imports, 0, '锁内验证失败不得调用GUI导入器');
        assert.equal(f.controller.store.zips.has(f.targetBoot.name), false);
        assert.equal(f.boots.has(f.targetBoot.name), false);
        assert.deepEqual(f.controller.store.disabled, ['ModI18N'], '不能为绕过验证而重新启用前置');
        assert.ok(f.state.toasts.some(message => String(message).includes('ModI18N')), '锁内阻断原因应明确提示缺少或禁用的前置');
    }
};
