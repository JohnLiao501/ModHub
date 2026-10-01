// ModHub 加载契约、管理器状态与公共弹窗。
const {
    assert, fs, path, srcRoot, bootJson,
    createStubElement, createBaseSandbox, loadScripts, loadManager, createMockController,
} = require('./helpers');

module.exports = async function() {
    /* =========================================================================
     * 1. boot.json 配置契约
     * ========================================================================= */
    assert.equal(bootJson.name, 'ModHub', '模组名称必须为 ModHub');
    assert.equal(bootJson.version, '1.2.0', 'boot.json 版本号必须为 1.2.0');

    // 1.1 ModHub 必需文件完整注册且真实存在于磁盘
    assert.deepEqual(bootJson.scriptFileList, [
        'javascript/modhub-manager.js',
        'javascript/modhub-drag.js', 'javascript/modhub-beauty.js', 'javascript/modhub-readme.js',
        'javascript/modhub-log.js', 'javascript/modhub-market.js',
        'javascript/modhub-market-versions.js', 'javascript/modhub-market-install.js',
    ], '业务阶段必须先加载公共管理接口，再加载拖拽、美化、说明、日志与市场');
    assert.deepEqual(bootJson.scriptFileList_inject_early, ['javascript/modhub-dialog.js', 'javascript/modhub-restore-panel.js', 'javascript/modhub-restore.js'], '弹窗、面板与恢复引擎必须在业务脚本之前注入');
    for (const file of [...bootJson.scriptFileList_inject_early, ...bootJson.scriptFileList]) {
        assert.ok(fs.existsSync(path.join(srcRoot, file)), `${file} 必须存在于 src`);
    }
    assert.deepEqual(bootJson.styleFileList, [
        'stylesheet/modhub.css', 'stylesheet/modhub-market.css', 'stylesheet/modhub-overrides.css',
    ], '必须按基础、市场、覆盖规则的顺序加载样式');
    for (const file of bootJson.styleFileList) {
        assert.ok(fs.existsSync(path.join(srcRoot, file)), `${file} 样式表必须存在`);
    }
    assert.ok(bootJson.tweeFileList.includes('twee/modloader/modloader.twee'), '必须注册 modloader.twee');
    assert.ok(fs.existsSync(path.join(srcRoot, 'twee', 'modloader', 'modloader.twee')), 'modloader.twee 必须存在');

    // 1.2 解耦红线：不得残留原版优化模块的任何文件
    for (const forbidden of ['javascript/dol-optimization.js', 'javascript/AsAPI.js']) {
        assert.ok(!bootJson.scriptFileList.includes(forbidden), `ModHub 不应包含原版优化脚本 ${forbidden}`);
    }
    assert.ok(!bootJson.styleFileList.includes('stylesheet/dol-optimization.css'), 'ModHub 不应包含原版优化样式表');
    for (const forbidden of ['twee/settings.twee', 'twee/game.twee']) {
        assert.ok(!bootJson.tweeFileList.includes(forbidden), `ModHub 不应包含原版优化 Twee ${forbidden}`);
    }
    assert.deepEqual(bootJson.imgFileList, [], 'ModHub 不携带图像资源，imgFileList 必须为空');

    // 1.3 TweeReplacer 补丁：3 个模组管理器入口且 replaceFile 真实存在
    const tweeReplacer = bootJson.addonPlugin.find(p => p.modName === 'TweeReplacer');
    assert.ok(tweeReplacer, '必须声明 TweeReplacer 插件');
    const managerPatches = tweeReplacer.params.filter(p => p.replaceFile);
    assert.equal(managerPatches.length, 3, '模组管理器必须有且仅有 3 个入口补丁');
    for (const patch of managerPatches) {
        assert.ok(patch.tip.startsWith('【ModHub】'), `补丁 tip 必须以【ModHub】标识: ${patch.tip}`);
        assert.ok(fs.existsSync(path.join(srcRoot, patch.replaceFile)), `补丁文件必须存在: ${patch.replaceFile}`);
    }

    // 1.4 彻底解耦契约：杜绝占用 BeautySelectorAddon 图包槽位，移除无用依赖
    assert.ok(!bootJson.addonPlugin.some(p => p.modName === 'BeautySelectorAddon'), 'ModHub 不携带图包，绝不能在 addonPlugin 声明 BeautySelectorAddon，防止抢占原版优化图像包');
    assert.ok(!bootJson.dependenceInfo.some(d => d.modName === 'BeautySelectorAddon'), 'dependenceInfo 不得残留 BeautySelectorAddon 依赖');
    assert.ok(!bootJson.dependenceInfo.some(d => d.modName === 'maplebirch'), 'dependenceInfo 不得残留 maplebirch 依赖');
    assert.ok(bootJson.dependenceInfo.some(d => d.modName === 'TweeReplacer'), 'dependenceInfo 必须包含 TweeReplacer 核心补丁依赖');

    // 1.5 打包脚本契约
    const packPy = fs.readFileSync(path.join(srcRoot, '..', 'pack.py'), 'utf8');
    assert.ok(packPy.includes("zip_name = f'ModHub-v{version}.zip'"), '打包文件名必须为 ModHub-v<version>.zip');

    // 命名调整后按真实清单加载；旧设置可读取，新值优先且不改写旧键。
    {
        const controller = createMockController({ enabled: ['ModA'], disabled: ['ModB'] });
        const sb = createBaseSandbox({ modModLoadController: controller });
        loadScripts(sb);
        assert.equal(typeof sb.modHubConfirm, 'function', '新命名确认框必须可用');
        assert.ok(sb.modHubMarket, '市场必须通过真实加载清单注册');
        assert.ok(!Object.keys(sb).some(key => /^_?dolOpt/.test(key) || key === 'dolModMarket'), '不得继续注册旧命名接口');

        for (const [key, getter, setter] of [
            ['auto_enable_sideload_beauty', 'modHubIsAutoBeautyEnabled', 'modHubSetAutoBeautyEnabled'],
            ['auto_open_log_on_error', 'modHubIsAutoOpenErrorLogEnabled', 'modHubSetAutoOpenErrorLogEnabled'],
        ]) {
            sb.localStorage.setItem(`dol_opt_${key}`, 'false');
            assert.equal(sb[getter](), false, '必须保留旧版关闭设置');
            sb[setter](true);
            assert.equal(sb[getter](), true, '新设置必须优先于旧设置');
            assert.equal(sb.localStorage.getItem(`dol_opt_${key}`), 'false', '不得改写旧设置');
        }
        sb.localStorage.setItem('dol_opt_sideload_mod_order', '["ModB","ModA"]');
        assert.deepEqual(Array.from((await sb.modHubLoadModManageState()).sideMods, mod => mod.name), ['ModB', 'ModA'], '必须保留旧版启用与禁用模组的交错顺序');
        sb.localStorage.setItem('modhub_sideload_mod_order', '["ModA","ModB"]');
        assert.deepEqual(Array.from((await sb.modHubLoadModManageState(true)).sideMods, mod => mod.name), ['ModA', 'ModB'], '新排序必须优先于旧排序');

        sb.localStorage.setItem('dol_opt_market_ignored_updates_v1', '{"ModA":"1.0"}');
        assert.equal(sb.modHubMarket.getIgnoredUpdates().ModA, '1.0', '必须保留旧版忽略更新记录');
        sb.modHubMarket.setModUpdateIgnored('ModA', '1.0', false);
        assert.equal(sb.modHubMarket.getIgnoredUpdates().ModA, undefined, '取消忽略后不得重新读取旧记录');
        assert.equal(JSON.parse(sb.localStorage.getItem('dol_opt_market_ignored_updates_v1')).ModA, '1.0', '不得改写旧版忽略记录');

        sb.localStorage.setItem('dol_opt_market_wiki_v5', JSON.stringify({ data: [{ name: '旧版离线目录', version: '1.0' }], timestamp: Date.now() }));
        assert.equal((await sb.modHubMarket.loadMarketData())[0].name, '旧版离线目录', '更名后旧版离线目录仍必须可用');
        const original = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ name: '原版优化', githubUrl: 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolOptimization' }] })[0];
        assert.equal(original.githubUrl, 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolOptimization', '原版优化的第三方仓库不得随本项目更名');
    }

    // 主脚本先捕获启动错误，日志模块加载后等待游戏就绪并只打开一次。
    {
        const events = new Map(), timers = [], bindings = [], opened = [];
        const sb = createBaseSandbox({
            console: { error() {}, warn() {}, log() {} },
            addEventListener: (name, handler) => events.set(name, handler),
            setTimeout: (callback, delay) => timers.push({ callback, delay }),
            Wikifier: { wikifyEval: macro => opened.push(macro) },
        });
        sb.$ = sb.jQuery = () => ({ on: name => bindings.push(name) });
        const overlay = createStubElement(), initScreen = createStubElement();
        let ready = false;
        sb.document.getElementById = id => id === 'customOverlay' ? overlay : id === 'init-screen' && !ready ? initScreen : null;
        loadScripts(sb, [bootJson.scriptFileList[0]]);
        events.get('error')({ message: 'TypeError: 启动测试异常', filename: 'test.js', lineno: 1 });
        assert.equal(sb._modHubStartupErrors.length, 1, '日志模块尚未加载也必须捕获错误');
        assert.equal(sb.modHubAnalyzeLogs, undefined, '日志分析应由独立模块提供');
        assert.equal(typeof sb.modHubOpenManager, 'function', '通用窗口入口必须仍由主脚本提供');
        loadScripts(sb, bootJson.scriptFileList.slice(1));
        const timerCount = timers.length, bindingCount = bindings.length;
        sb.modHubInitStartupErrorCheck();
        assert.equal(timers.length, timerCount, '重复初始化不得增加启动轮询');
        assert.equal(bindings.length, bindingCount, '重复初始化不得增加事件监听');
        assert.equal(bindings.filter(name => name === ':storyready').length, 1, '故事就绪监听必须注册一次');
        timers.find(timer => timer.delay === 500).callback();
        assert.equal(opened.length, 0, '游戏仍在加载时不得打开日志');
        assert.equal(sb._modHubPendingAutoOpenErrorLog, true, '启动错误必须保留到游戏就绪');
        ready = true;
        timers.find(timer => timer.delay === 1500).callback();
        assert.equal(opened.length, 1, '游戏就绪后必须通过主模块入口打开日志');
        assert.ok(opened[0].includes('<<titleModloader 3>>') && opened[0].includes('<<modloaderlog>>'), '必须定位加载日志页签');
        timers.find(timer => timer.delay === 3000).callback();
        assert.equal(opened.length, 1, '后续轮询不得重复打开窗口');
    }

    /* =========================================================================
     * 2. ModLoader v2.101.1+ GUI 兼容层
     * ========================================================================= */
    // 2.1 旧版 GUI 存在时直接透传
    {
        const legacy = { listSideLoadModNameOnly: async () => ['legacy'] };
        const sb = loadManager({ modLoaderGui: legacy });
        assert.equal(sb.modHubGetGui(), legacy, '旧版 modLoaderGui 必须优先透传');
    }
    // 2.2 v2.101.1+ 环境：由 controller + modUtils 构造代理
    {
        const controller = createMockController({ enabled: ['ModA'], disabled: ['ModB'] });
        const modUtils = { getModLoadSwitch: () => ({ safeMode: false }) };
        const sb = loadManager({ modModLoadController: controller, modUtils });
        const gui = sb.modHubGetGui();
        assert.ok(gui, 'controller+modUtils 环境必须构造出 GUI 代理');
        assert.deepEqual(await gui.listSideLoadModNameOnly(), ['ModA'], '代理启用列表必须映射到 listModIndexDB');
        assert.deepEqual(await gui.listSideLoadHiddenModNameOnly(), ['ModB'], '代理禁用列表必须映射到 loadHiddenModList');
        assert.equal(gui.gModUtils, modUtils, 'gModUtils 必须映射到新版 modUtils');
        assert.equal(gui.getModTReadMe, null, 'v2.101.1 已移除的 getModTReadMe 必须置空以触发 typeof 守卫');
        assert.equal(gui.loadAndAddMod, null, 'v2.101.1 已移除的 loadAndAddMod 必须置空');
        assert.deepEqual(gui.modLoadSwitch, { safeMode: false }, '安全模式开关必须透传');
    }
    // 2.3 完全无接口环境返回 null
    {
        const sb = loadManager();
        assert.equal(sb.modHubGetGui(), null, '无 ModLoader 接口时必须返回 null');
    }

    // 已启用恢复工具及必要前置固定在普通模组之前，顺序保护不限制禁用或卸载。
    {
        const controller = createMockController({ enabled: ['用户甲', 'ModHub', 'TweeReplacer', '用户乙'], zips: ['用户甲', 'ModHub', 'TweeReplacer', '用户乙'] });
        const sb = loadManager({ modModLoadController: controller });
        await sb.modHubLoadModManageState();
        const profiles = [
            { name: 'ModHub', bootJson: { dependenceInfo: [{ modName: 'TweeReplacer' }] } },
            { name: 'TweeReplacer', bootJson: { dependenceInfo: [{ modName: '底层依赖' }] } },
            { name: '底层依赖', bootJson: {} },
        ];
        assert.deepEqual([...sb.modHubKeepRecoveryOrder(['用户甲', 'ModHub', 'TweeReplacer', '用户乙', '底层依赖'], profiles)],
            ['底层依赖', 'TweeReplacer', 'ModHub', '用户甲', '用户乙'], '递归前置先于恢复工具，普通模组相对顺序保持');
        sb._modHubDisabledModInfo.set('modhub', { bootJson: profiles[0].bootJson });
        assert.ok(sb.modHubProtectedRecoveryNames().includes('TweeReplacer'), '已启用工具的必要前置保持固定顺序');
        await sb.modHubEnsureModInEnabledList('用户甲');
        assert.deepEqual(controller.store.enabled, ['TweeReplacer', 'ModHub', '用户甲', '用户乙'], '原生安装已登记的包仍须修正工具顺序，不能提前返回');
        const shuffled = createMockController({ enabled: ['甲', '乙'] });
        const write = shuffled.overwriteModIndexDBModList;
        shuffled.overwriteModIndexDBModList = async list => { await write(list); shuffled.store.enabled.reverse(); return true; };
        await assert.rejects(() => loadManager({ modModLoadController: shuffled }).modHubSaveIndexDBModList(['甲', '乙'], []), /精确顺序/, '集合相同但顺序错误仍须拒绝');
        const embedded = loadManager({ modUtils: { getModLoader: () => ({ getModReadCache: () => ({ get_Array: () => [
            { name: 'ModHub', from: 'Local', mod: { bootJson: profiles[0].bootJson } }
        ] }) }) } });
        assert.deepEqual([...embedded.modHubKeepRecoveryOrder(['用户甲', 'TweeReplacer', '用户乙'])], ['TweeReplacer', '用户甲', '用户乙'], '内嵌 ModHub 也要把旁加载必要前置固定在普通模组之前');
        const missing = embedded.modHubRestore.getRecoveryInfo(['用户甲']);
        assert.ok(missing.issues.some(item => item.blocking && /缺失或未启用/.test(item.message)), '缺失或禁用前置须明确提示');
        const versioned = loadManager({ modSC2DataManager: { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: value => value ? { version: value } : null, parseRange: value => value, satisfies: () => false
        }) }) } });
        const incompatible = versioned.modHubRestore.getRecoveryInfo(['ModHub', 'TweeReplacer'], [
            { name: 'ModHub', bootJson: { dependenceInfo: [{ modName: 'TweeReplacer', version: '^1.0.0' }] } },
            { name: 'TweeReplacer', bootJson: { version: '0.1.0' } }
        ]);
        assert.ok(incompatible.issues.some(item => item.blocking && /版本不匹配/.test(item.message)), '已知不兼容前置须阻止恢复');
        sb.modHubGetModInfo = name => name === 'ModHub' ? { bootJson: profiles[0].bootJson } : null;
        sb._modHubDisabledModInfo.set('modhub', { bootJson: { dependenceInfo: [{ modName: '新前置' }] } });
        sb._modHubModState.sideMods.push({ name: '新前置', enabled: true });
        sb.modHubEnsureModStateSync(sb._modHubModState);
        assert.ok(sb.modHubProtectedRecoveryNames().includes('新前置'), '刚安装更新的工具按新包实际前置固定顺序，不能沿用运行时旧依赖');
        assert.equal(await sb.modHubToggleSideMod('新前置', false, { skipConfirm: true, silentOfferReload: true }), true, '实际前置也允许用户主动禁用');
    }

    // 主动停用和卸载后，普通保存、导入登记、刷新与孤儿自愈不得复活 ModHub。
    {
        const controller = createMockController({ enabled: ['用户甲', 'ModHub', 'TweeReplacer'], zips: ['用户甲', 'ModHub', 'TweeReplacer'] });
        const loader = { customStore: {}, constructor: { calcModNameKey: name => '包体:' + name } };
        const utils = {
            getMod: name => name === 'ModHub' ? { bootJson: { dependenceInfo: [{ modName: 'TweeReplacer' }] } } : null,
            getModLoader: () => ({ getIndexDBLoader: () => loader }),
            getIdbKeyValRef: () => ({ keys: async () => [...controller.store.zips].map(name => '包体:' + name), get: async key => controller.store.zips.has(key.slice(3)) ? '包体' : null }),
        };
        const sb = loadManager({ modModLoadController: controller, modUtils: utils });
        await sb.modHubLoadModManageState();
        let accepted = false;
        const prompts = [];
        sb.modHubConfirm = async options => { prompts.push(options); return accepted; };
        assert.equal(await sb.modHubToggleSideMod('ModHub', false), false, '取消自身禁用不写入');
        assert.deepEqual(controller.store.enabled, ['用户甲', 'ModHub', 'TweeReplacer']);
        accepted = true;
        assert.equal(await sb.modHubToggleSideMod('ModHub', false), true, '确认后允许禁用自身');
        assert.match(prompts.at(-1).message, /时间点还原和加载页救援将停用/);
        assert.deepEqual(controller.store.disabled, ['ModHub']);
        assert.ok(!controller.store.enabled.includes('ModHub'));
        assert.deepEqual([...sb.modHubProtectedRecoveryNames()], [], '本轮仍在运行的档案不再锁住必要前置');
        await sb.modHubSaveModManageState(false);
        await sb.modHubEnsureModInEnabledList('用户乙');
        await sb.modHubLoadModManageState(true);
        await sb.modHubEnsureRecoveryPlacement();
        await sb.modHubRepairOrphanModZips();
        assert.deepEqual(controller.store.disabled, ['ModHub'], '保存、单装登记、刷新及自愈保持禁用');
        assert.ok(!controller.store.enabled.includes('ModHub'));
        assert.equal(await sb.modHubToggleSideMod('ModHub', true), true, '用户可以重新启用自身');
        assert.deepEqual(controller.store.enabled.slice(0, 2), ['TweeReplacer', 'ModHub'], '重新启用恢复合法优先顺序');
        accepted = false;
        assert.equal(await sb.modHubDeleteSideMod('ModHub'), undefined, '取消卸载不写入');
        assert.ok(controller.store.zips.has('ModHub'));
        accepted = true;
        assert.equal(await sb.modHubDeleteSideMod('ModHub'), true, '确认后真正卸载自身');
        assert.match(prompts.at(-1).message, /重新导入 ModHub/);
        assert.ok(!controller.store.zips.has('ModHub'));
        await sb.modHubLoadModManageState(true);
        await sb.modHubSaveModManageState(false);
        await sb.modHubRepairOrphanModZips();
        assert.ok(![...controller.store.enabled, ...controller.store.disabled].includes('ModHub'), '卸载后保存刷新不会补回自身');
        controller.store.zips.add('ModHub');
        const repair = await sb.modHubRepairOrphanModZips();
        assert.ok(repair.skipped.includes('ModHub'), '残留的未登记自身包体不自动启用');
        assert.ok(!controller.store.enabled.includes('ModHub'));

        const failedController = createMockController({ enabled: ['ModHub'], zips: ['ModHub'] });
        const failed = loadManager({ modModLoadController: failedController });
        failed.modHubConfirm = async () => true;
        await failed.modHubLoadModManageState();
        failedController.removeModIndexDB = async () => false;
        assert.equal(await failed.modHubDeleteSideMod('ModHub'), false, '包体删除失败不能报告卸载成功');
        assert.equal(failed._modHubManagerSaveFailed, true, '失败保持重载保护');
        assert.ok(failedController.store.zips.has('ModHub'));
        delete failedController.removeModIndexDB;
        assert.equal(await failed.modHubDeleteSideMod('ModHub'), false, '缺少删除接口也不能报告成功');
        assert.ok(failedController.store.zips.has('ModHub'));

        const silentController = createMockController({ enabled: ['ModHub'], zips: ['ModHub'] });
        silentController.removeModIndexDB = async () => true;
        const silent = loadManager({ modModLoadController: silentController, modUtils: {
            getModLoader: () => ({ getIndexDBLoader: () => loader }),
            getIdbKeyValRef: () => ({ get: async () => '未删除的真实包体' }),
        } });
        silent.modHubConfirm = async () => true;
        await silent.modHubLoadModManageState();
        assert.equal(await silent.modHubDeleteSideMod('ModHub'), false, '加载器返回成功但包体仍在库中时仍须拒绝成功提示');
        assert.equal(silent._modHubManagerSaveFailed, true);
        assert.ok(silentController.store.zips.has('ModHub'));
    }

    // 固定只限制移动顺序，恢复工具的禁用与删除按钮可正常点击。
    {
        const sb = createBaseSandbox();
        loadScripts(sb);
        const container = createStubElement();
        sb.document.getElementById = id => id === 'modHubModManageContainer' ? container : null;
        sb._modHubModState = { sideMods: [{ name: 'ModHub', enabled: true }], sideEnabled: ['ModHub'], sideDisabled: [], builtInMods: [] };
        sb.modHubRenderBeautyUI = sb.modHubUpdateGeneralInfo = () => {};
        sb.modHubRenderModManageUI();
        const row = container.innerHTML.match(/<li[^>]*data-mod-name="ModHub"[\s\S]*?<\/li>/)?.[0];
        assert.ok(row, '管理页必须展示自身');
        for (const action of ['toggle', 'delete']) {
            const button = row.match(new RegExp('<button[^>]*data-mod-action="' + action + '"[^>]*>'))?.[0];
            assert.ok(button && !/\bdisabled\b/.test(button), '自身' + action + '按钮不得再被顺序保护禁用');
        }
    }

    // 批量调用显式共享上下文，只有批量外层负责结束还原点；恢复期间不得执行普通动作。
    {
        const sb = loadManager();
        const shared = { id: '批量上下文' }, prepared = [], finished = [];
        let actions = 0, restoring = false;
        sb.modHubRestore = {
            createOperation: () => ({ id: '独立上下文' }), isRestoring: () => restoring,
            isOperationBlocked: () => false, claim: () => true,
            prepare: async context => { prepared.push(context); return true; },
            finish: async context => finished.push(context), release() {},
        };
        await sb.modHubRunManagerAction(() => { actions++; }, '批量第一项', { restoreContext: shared });
        await sb.modHubRunManagerAction(() => { actions++; }, '批量第二项', { restoreContext: shared });
        assert.ok(prepared.length === 2 && prepared.every(context => context === shared));
        assert.equal(finished.length, 0, '内层管理动作不得结束批量共享上下文');
        await sb.modHubRunManagerAction(() => { actions++; });
        assert.equal(finished.length, 1, '独立动作必须结束自己的还原点');
        restoring = true;
        assert.equal(await sb.modHubRunManagerAction(() => { actions++; }), false);
        assert.equal(actions, 3, '恢复时动作函数不得执行');
        restoring = false;
        sb.modHubRestore.prepare = async () => false;
        assert.equal(await sb.modHubRunManagerAction(() => { actions++; }), false);
        assert.equal(actions, 3, '取消建立还原点时不得执行持久化动作');
    }

    /* =========================================================================
     * 3. 智能依赖拓扑排序（modHubBuildSmartOrder）
     * ========================================================================= */
    {
        const sb = loadManager();
        // 3.1 基本拓扑：ModA 依赖 ModB，ModB 必须排在 ModA 之前
        const order = await sb.modHubBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: 'ModB' }] } },
            { key: 'k2', modName: 'ModB', boot: {} },
            { key: 'k3', modName: 'ModC', boot: {} },
        ], null);
        assert.ok(order.indexOf('k2') < order.indexOf('k1'), '被依赖模组必须排在依赖方之前');
        // 3.2 addonPlugin 声明同样构成依赖边
        const addonOrder = await sb.modHubBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { addonPlugin: [{ modName: 'TweeReplacer' }] } },
            { key: 'k2', modName: 'TweeReplacer', boot: {} },
        ], null);
        assert.deepEqual([...addonOrder], ['k2', 'k1'], 'addonPlugin 依赖必须参与拓扑排序');
        // 3.3 nickName 别名可解析依赖
        const aliasOrder = await sb.modHubBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: '枫桦框架' }] } },
            { key: 'k2', modName: 'maplebirch', boot: { nickName: { chs: '枫桦框架' } } },
        ], null);
        assert.deepEqual([...aliasOrder], ['k2', 'k1'], '依赖声明中的 nickName 别名必须正确解析');
        // 3.4 无依赖时保持原有相对顺序（稳定排序）
        const stable = await sb.modHubBuildSmartOrder([
            { key: 'k3', modName: 'ModC', boot: {} },
            { key: 'k1', modName: 'ModA', boot: {} },
            { key: 'k2', modName: 'ModB', boot: {} },
        ], null);
        assert.deepEqual([...stable], ['k3', 'k1', 'k2'], '无依赖关系时必须保持原有相对顺序');
        // 3.5 循环依赖安全回退为原顺序
        const cyclic = await sb.modHubBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: 'ModB' }] } },
            { key: 'k2', modName: 'ModB', boot: { dependenceInfo: [{ modName: 'ModA' }] } },
        ], null);
        assert.deepEqual([...cyclic], ['k1', 'k2'], '循环依赖必须保持原有相对顺序');
    }

    /* =========================================================================
     * 4. 单/多模组导入分流（modHubResolveImportedModName）
     * ========================================================================= */
    {
        const sb = loadManager();
        sb.modHubGetModInfo = name => ({
            SmartPhone: { bootJson: { name: 'SmartPhone', nickName: { chs: '万能的智能手机' } } },
        }[name] || null);
        // 4.1 文件名精确归一匹配
        assert.equal(
            sb.modHubResolveImportedModName('SmartPhone-v0.3.85.zip', ['SmartPhone', 'OtherMod']),
            'SmartPhone', '带版本号的文件名必须归一匹配到已安装模组'
        );
        // 4.2 别名模糊匹配（中文昵称命中）
        assert.equal(
            sb.modHubResolveImportedModName('万能的智能手机.mod.zip', ['SmartPhone', 'OtherMod']),
            'SmartPhone', '中文别名文件名必须匹配到对应模组'
        );
        // 4.3 无任何匹配时安全返回 null
        assert.equal(
            sb.modHubResolveImportedModName('completely-unknown-pack.zip', ['SmartPhone']),
            null, '无法识别的文件名必须返回 null 而非误配'
        );
        for (const suffix of ['.modpack', '.MODPACK.CRYPT']) {
            assert.equal(sb.modHubResolveImportedModName(`ExactMod${suffix}`, ['ExactMod', 'ExactModModPackCrypt']),
                'ExactMod', '原生包后缀不得参与技术名匹配或误配到同前缀模组');
        }
    }

    // 原生 ModPack 与 Zip 共用官方校验、原样落盘及本地导入分流。
    {
        const createImporter = (legacy = false) => {
            const controller = createMockController({ disabled: ['NativePack'] });
            const stored = new Map(), checks = [], tabs = [];
            const bootByMarker = new Map([
                [1, { name: 'NativePack', version: '1.0' }],
                [2, { name: 'ZipPack', version: '2.0' }],
                [3, { name: 'EncryptedPack', version: '3.0' }]
            ]);
            controller.checkModZipFileIndexDB = async bytes => { checks.push(Array.from(bytes)); return bootByMarker.get(bytes[0]); };
            controller.addModIndexDB = async (name, bytes) => {
                stored.set(name, Array.from(bytes)); controller.store.zips.add(name);
                if (!controller.store.enabled.includes(name)) controller.store.enabled.push(name);
            };
            const utils = { getModListNameNoAlias: () => [] };
            const gui = legacy ? {
                gModUtils: utils, modModLoadController: controller,
                listSideLoadModNameOnly: () => controller.listModIndexDB(),
                listSideLoadHiddenModNameOnly: () => controller.loadHiddenModList(),
                loadAndAddMod: async () => { throw new Error('ModPack 不得交给仅支持 Zip 的旧 GUI'); }
            } : null;
            const sb = loadManager({ modModLoadController: controller, modUtils: utils, ...(gui ? { modLoaderGui: gui } : {}) });
            sb.modHubLoadBeautyState = async () => {};
            sb.modHubSwitchTab = name => { tabs.push(name); return true; };
            sb.initModManage = async () => {};
            sb.modHubSelectReadmeMod = () => {};
            return { sb, controller, stored, checks, tabs, gui };
        };
        const file = (name, marker) => ({ name, arrayBuffer: async () => new Uint8Array([marker, 42, 255, 0]).buffer });
        {
            const f = createImporter();
            f.sb.modHubReadLocalReadme = async () => '# 原生包说明';
            assert.equal(await f.sb.modHubHandleAddMod({ files: [file('显示名称.modpack', 1)] }, { askRestart: false }), true);
            assert.deepEqual(f.stored.get('NativePack'), [1, 42, 255, 0], '原生包必须保留已校验的原始字节，不能转成 Zip 或改名冒充');
            assert.deepEqual(f.checks, [[1, 42, 255, 0]], '原生包必须经过 ModLoader 官方清单校验');
            assert.deepEqual(f.controller.store.enabled, ['NativePack'], '持久化名称必须取自真实 boot，而非文件名');
            assert.deepEqual(f.controller.store.disabled, [], '已有禁用版本应在成功导入后启用');
            assert.deepEqual(f.tabs, ['模组说明'], '单个原生包包含说明时应保留本地导入分流');
        }
        {
            const f = createImporter(true);
            f.sb.modHubReadLocalReadme = async () => '';
            assert.equal(await f.sb.modHubHandleAddMod({ files: [file('plain.zip', 2), file('native.modpack', 1), file('native.modpack.crypt', 3)] }, { askRestart: false }), true);
            assert.deepEqual([...f.stored.keys()], ['ZipPack', 'NativePack', 'EncryptedPack'], '混合批次应统一走原生校验和持久化路径');
            assert.deepEqual([...f.stored.values()], [[2, 42, 255, 0], [1, 42, 255, 0], [3, 42, 255, 0]]);
            assert.deepEqual(f.tabs, ['模组管理'], '批量 Zip / ModPack 导入应保持管理页集中高亮');
            assert.deepEqual([...f.sb._modHubHighlightMods], ['ZipPack', 'NativePack', 'EncryptedPack']);
        }
        {
            const f = createImporter(true);
            f.sb.modHubReadLocalReadme = async () => '';
            const binary = { ...file('手机下载的模组.bin', 1), type: 'application/octet-stream' };
            assert.equal(await f.sb.modHubHandleAddMod({ files: [binary] }, { askRestart: false }), true);
            assert.deepEqual(f.stored.get('NativePack'), [1, 42, 255, 0], 'BIN 文件应以原始字节通过原生校验，不能交给旧 Zip GUI');
            assert.equal(f.checks.length, 1);
            await assert.rejects(() => f.sb.modHubInstallModZip(file('普通二进制.bin', 99)), /校验失败/, 'MIME 放宽不得让无效 BIN 绕过包体校验');
            assert.equal(f.stored.size, 1, '无效 BIN 不得新增写入');
        }
        {
            const f = createImporter(true);
            let called = 0;
            f.gui.loadAndAddMod = async () => { called++; f.controller.store.enabled.push('ZipPack'); };
            f.sb.modHubReadLocalReadme = async () => '';
            assert.equal(await f.sb.modHubHandleAddMod({ files: [file('plain.zip', 2)] }, { askRestart: false }), true);
            assert.equal(called, 1, '仅含 Zip 的旧 GUI 路径必须保留');
            assert.equal(f.checks.length, 0);
        }
        {
            const f = createImporter(true);
            let prepared = 0;
            f.sb.modHubRestore.prepare = async () => { prepared++; return true; };
            f.sb.modHubReadLocalReadme = async () => '';
            assert.equal(await f.sb.modHubHandleAddMod({ files: [file('first.zip', 2), file('second.zip', 1)] }, { askRestart: false }), true);
            assert.deepEqual([...f.stored.keys()], ['ZipPack', 'NativePack'], '双 Zip 导入不得调用只接受单文件的原生 GUI');
            assert.equal(prepared, 1, '批量导入必须在同一管理操作中只准备一次还原点');
        }
        for (const outcome of ['throw', 'message', 'empty', 'missingName']) {
            const f = createImporter();
            f.controller.checkModZipFileIndexDB = async () => {
                if (outcome === 'throw') throw new Error('原生格式或密码无法读取');
                return outcome === 'message' ? 'bootJson Invalid' : outcome === 'empty' ? null : { version: '1.0' };
            };
            await assert.rejects(() => f.sb.modHubInstallModZip(file('broken.modpack', 1)), /校验失败/, '原生校验失败不得退回文件名后继续落盘');
            assert.equal(f.stored.size, 0);
            assert.deepEqual(f.controller.store.enabled, []);
            assert.deepEqual(f.controller.store.disabled, ['NativePack']);
        }
        {
            const f = createImporter();
            f.controller.checkModZipFileIndexDB = async () => { throw new Error('password required'); };
            await assert.rejects(() => f.sb.modHubInstallModZip(file('locked.modpack.crypt', 3)), /不提供密码输入/, '需要密码的包必须给出可执行的失败说明');
            assert.equal(f.stored.size, 0);
        }
        {
            const f = createImporter(true);
            delete f.controller.checkModZipFileIndexDB;
            await assert.rejects(() => f.sb.modHubInstallModZip(file('native.modpack', 1)), /ModPack 校验接口/);
            await assert.rejects(() => f.sb.modHubInstallModZip(file('native.bin', 1)), /ModPack 校验接口/, '旧环境不能只凭 BIN 文件名落盘');
            assert.equal(await f.sb.modHubHandleAddMod({ files: [file('plain.zip', 2), file('native.modpack', 1)] }, { askRestart: false }), false);
            assert.equal(f.stored.size, 0, '缺少原生校验能力时必须在混合批次任何写入前中止');
        }
        {
            const f = createImporter();
            f.sb.modHubTriggerImport();
            const created = f.sb.document.body.children.find(item => item.id === 'modHubImportFileInput');
            const expectedAccept = '.zip,.modpack,.modpack.crypt,application/zip,application/octet-stream';
            assert.equal(created.accept, expectedAccept);
            created.accept = '.zip';
            f.sb.document.getElementById = id => id === created.id ? created : null;
            f.sb.modHubTriggerImport();
            assert.equal(created.accept, expectedAccept, '已有本地文件控件也应更新原生格式和移动 MIME 过滤');
        }
    }

    /* =========================================================================
     * 5. ModLoadController 持久化（写入合并 / dropNames / 回读校验）
     * ========================================================================= */
    {
        // 5.1 正常写入并回读一致
        const controller = createMockController();
        const sb = loadManager({ modModLoadController: controller });
        await sb.modHubSaveIndexDBModList(['ModA', 'ModB'], ['ModC']);
        assert.deepEqual(controller.store.enabled, ['ModA', 'ModB'], '启用列表必须完整落盘');
        assert.deepEqual(controller.store.disabled, ['ModC'], '禁用列表必须完整落盘');
        const readBack = await sb.modHubReadIndexDBModLists();
        assert.ok(readBack.ok, '回读必须成功');
        assert.deepEqual(readBack.enabled, ['ModA', 'ModB']);
        assert.deepEqual(readBack.disabled, ['ModC']);

        // 5.2 启用/禁用交叉去重：启用优先
        await sb.modHubSaveIndexDBModList(['ModA'], ['ModA', 'ModC']);
        assert.deepEqual(controller.store.disabled, ['ModC'], '同名模组同时出现时启用列表优先');

        // 5.3 已安装未登记模组自动保留（防假删除）
        const controller2 = createMockController({ enabled: ['ModA', 'LegacyMod'] });
        const sb2 = loadManager({ modModLoadController: controller2 });
        await sb2.modHubSaveIndexDBModList(['ModA'], []);
        assert.ok(controller2.store.enabled.includes('LegacyMod'), '存储中已安装但未登记的模组必须被自动保留');

        // 5.4 dropNames 明确禁止复活（删除场景）
        const controller3 = createMockController({ enabled: ['ModA', 'DeadMod'] });
        const sb3 = loadManager({ modModLoadController: controller3 });
        await sb3.modHubSaveIndexDBModList(['ModA'], [], { dropNames: ['DeadMod'] });
        assert.ok(!controller3.store.enabled.includes('DeadMod'), 'dropNames 中的模组必须被彻底移除');

        // 5.5 写入后回读不一致必须抛错（杜绝假成功）
        const controller4 = createMockController();
        const originalOverwrite = controller4.overwriteModIndexDBModList;
        controller4.overwriteModIndexDBModList = async list => { await originalOverwrite(list); controller4.store.enabled = []; return true; };
        const sb4 = loadManager({ modModLoadController: controller4 });
        await assert.rejects(() => sb4.modHubSaveIndexDBModList(['ModA'], []), /校验失败|不一致/, '回读校验失败必须抛错');

        // 5.6 缺少读取接口时按「无法校验」降级而非误判
        const sb5 = loadManager({ modModLoadController: { overwriteModIndexDBModList: async () => true } });
        const degraded = await sb5.modHubReadIndexDBModLists();
        assert.equal(degraded.ok, false, '缺失读取接口时必须返回 ok:false 降级');
    }

    /* =========================================================================
     * 6. 模组禁用/启用切换（modHubToggleSideMod）
     * ========================================================================= */
    {
        const controller = createMockController({ enabled: ['ModA', 'ModB'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._modHubModState = {
            sideMods: [{ name: 'ModA', enabled: true }, { name: 'ModB', enabled: true }],
            sideEnabled: ['ModA', 'ModB'],
            sideDisabled: [],
        };
        // 6.1 禁用模组：状态翻转并落盘
        await sb.modHubToggleSideMod('ModA', false);
        const item = sb._modHubModState.sideMods.find(m => m.name === 'ModA');
        assert.equal(item.enabled, false, '禁用后 enabled 必须为 false');
        assert.deepEqual(sb._modHubModState.sideDisabled, ['ModA'], '禁用列表必须同步更新');
        assert.deepEqual(controller.store.disabled, ['ModA'], '禁用结果必须写入存储');
        assert.deepEqual(controller.store.enabled, ['ModB'], '启用存储必须同步移除被禁用模组');
        // 6.2 幂等：目标状态与当前一致时内部早退返回 false（无变更语义）
        const again = await sb.modHubToggleSideMod('ModA', false);
        assert.equal(again, false, '重复禁用必须幂等早退（返回 false 表示无变更）');
        assert.deepEqual(controller.store.disabled, ['ModA'], '重复禁用不得改变存储');
        // 6.3 重新启用：模组回到其在统一顺序列表中的原始位置（排序不因开关而改变）
        await sb.modHubToggleSideMod('ModA', true);
        assert.deepEqual(sb._modHubModState.sideEnabled, ['ModA', 'ModB'], '重新启用后必须回到原始排序位置');
        assert.deepEqual(sb._modHubModState.sideDisabled, [], '禁用列表必须清空');
    }

    /* =========================================================================
     * 7. 模组删除（modHubDeleteSideMod 确认双分支）
     * ========================================================================= */
    {
        // 7.1 用户取消：不产生任何变更
        const controller = createMockController({ enabled: ['ModA'], zips: ['ModA'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._modHubModState = {
            sideMods: [{ name: 'ModA', enabled: true }],
            sideEnabled: ['ModA'],
            sideDisabled: [],
        };
        sb.modHubConfirm = async () => false;
        await sb.modHubDeleteSideMod('ModA');
        assert.equal(sb._modHubModState.sideMods.length, 1, '取消删除时列表必须保持不变');
        assert.equal(controller.store.removed.length, 0, '取消删除时不得调用包体移除');
        assert.equal(sb._modHubReloadRevision || 0, 0, '取消删除不得新增待重载批次');

        // 7.2 用户确认：列表移除 + dropNames 落盘 + 包体删除
        const controller2 = createMockController({ enabled: ['ModA'], zips: ['ModA'] });
        const sb2 = loadManager({ modModLoadController: controller2 });
        sb2._modHubModState = {
            sideMods: [{ name: 'ModA', enabled: true }],
            sideEnabled: ['ModA'],
            sideDisabled: [],
        };
        let confirmOptions = null;
        sb2.modHubConfirm = async options => { confirmOptions = options; return true; };
        await sb2.modHubDeleteSideMod('ModA');
        assert.equal(confirmOptions.confirmType, 'danger', '删除确认必须为危险操作样式');
        assert.equal(sb2._modHubModState.sideMods.length, 0, '确认后模组必须从列表移除');
        assert.deepEqual(controller2.store.removed, ['ModA'], '确认后必须删除浏览器存储中的包体');
        assert.deepEqual(controller2.store.enabled, [], '存储启用列表不得残留已删模组');
        assert.ok(!sb2._modHubDisabledModInfo.has('moda'), '禁用档案缓存必须同步清除');
    }

    /* =========================================================================
     * 8. 拖拽重排逻辑（modHubReorderList）
     * ========================================================================= */
    {
        const controller = createMockController({ enabled: ['ModA', 'ModB', 'ModC'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._modHubModState = {
            sideMods: [{ name: 'ModA', enabled: true }, { name: 'ModB', enabled: true }, { name: 'ModC', enabled: true }],
            sideEnabled: ['ModA', 'ModB', 'ModC'],
            sideDisabled: [],
        };
        // 8.1 拖到目标之后：ModA(0) -> ModC(2) 之后
        await sb.modHubReorderList('side', 0, 2, true);
        assert.deepEqual(sb._modHubModState.sideMods.map(m => m.name), ['ModB', 'ModC', 'ModA'], '拖拽至目标之后必须正确重排');
        assert.deepEqual(controller.store.enabled, ['ModB', 'ModC', 'ModA'], '重排结果必须写入存储');
        // 8.2 拖到目标之前：ModA(2) -> ModB(0) 之前
        await sb.modHubReorderList('side', 2, 0, false);
        assert.deepEqual(sb._modHubModState.sideMods.map(m => m.name), ['ModA', 'ModB', 'ModC'], '拖拽至目标之前必须正确重排');
        // 8.3 非法索引安全早退
        const before = JSON.stringify(sb._modHubModState.sideMods);
        await sb.modHubReorderList('side', 0, 0, false);
        await sb.modHubReorderList('side', 9, 1, false);
        assert.equal(JSON.stringify(sb._modHubModState.sideMods), before, '非法索引不得改变列表');
    }

    /* =========================================================================
     * 9. 原生模态框状态判定（0 原生弹窗红线）
     * ========================================================================= */
    {
        const sb = loadManager();
        assert.equal(typeof sb.modHubConfirm, 'function', '必须封装游戏原生暗黑确认框');
        assert.equal(typeof sb.modHubAlert, 'function', '必须封装游戏原生暗黑提示框');
        // 9.1 确认按钮交互：模拟用户点击确认
        const confirmPromise = sb.modHubConfirm({ title: '测试', message: '确认吗', confirmType: 'danger' });
        const overlay = sb.document.body.children.find(el => el.id === 'modHubConfirmOverlay');
        assert.ok(overlay, '确认框遮罩必须挂载到 body');
        const dialog = overlay.children[0];
        dialog.querySelector('.modhub-modal-btn-confirm').click();
        assert.equal(await confirmPromise, true, '点击确认必须回传 true');
        // 9.2 取消按钮交互
        const cancelPromise = sb.modHubConfirm('再去吗');
        const overlay2 = sb.document.body.children[sb.document.body.children.length - 1];
        overlay2.children[0].querySelector('.modhub-modal-btn-cancel').click();
        assert.equal(await cancelPromise, false, '点击取消必须回传 false');
        // 9.3 红线静态扫描：源码不得调用浏览器原生 alert / window.confirm
        for (const file of [...bootJson.scriptFileList_inject_early, ...bootJson.scriptFileList]) {
            const source = fs.readFileSync(path.join(srcRoot, file), 'utf8');
            assert.ok(!/[^.\w](?:alert|confirm)\s*\(/.test(source), `${file} 严禁调用浏览器原生 alert() 或 confirm()`);
            assert.ok(!/window\.confirm\s*\(/.test(source), `${file} 严禁调用 window.confirm()`);
        }
        // 界面尚不可用时安全取消，不能回退到原生确认框或自动批准。
        const headless = loadManager();
        let nativeConfirmCalls = 0;
        headless.confirm = () => { nativeConfirmCalls++; return true; };
        for (const document of [undefined, { createElement() {}, body: null }]) {
            headless.document = document;
            assert.equal(await headless.modHubConfirm({ message: '删除模组', confirmType: 'danger' }), false, '无法展示确认框时不得批准危险操作');
        }
        assert.equal(nativeConfirmCalls, 0, '无 DOM 回退不得调用浏览器原生确认框');
        // 9.4 模态框 customResult 与 onRender 扩展契约
        let renderedDialog = null;
        const customPromise = sb.modHubConfirm({
            title: '自定义测试',
            message: '测试信息',
            onRender: (dlg) => { renderedDialog = dlg; },
            customResult: () => ({ customValue: 'test1234', isCustom: true })
        });
        assert.ok(renderedDialog, 'onRender 回调必须被成功调用并传入 dialog DOM');
        const overlay3 = sb.document.body.children[sb.document.body.children.length - 1];
        overlay3.children[0].querySelector('.modhub-modal-btn-confirm').click();
        const customResult = await customPromise;
        assert.deepEqual(customResult, { customValue: 'test1234', isCustom: true }, '点击确认必须回传 customResult 提取的对象');

        // 9.5 多层模态弹窗栈堆叠契约（子弹窗严禁摧毁父弹窗 DOM）
        const parentPromise = sb.modHubConfirm({ title: '父弹窗', message: '主流程待处理' });
        const parentOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        assert.ok(parentOverlay, '父弹窗必须成功挂载');

        // 在父弹窗激活状态下打开子弹窗（如快捷禁用影响评估确认框）
        const childPromise = sb.modHubConfirm({ title: '子弹窗', message: '子操作确认' });
        const childOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        assert.notEqual(parentOverlay, childOverlay, '子弹窗必须创建独立遮罩');
        assert.ok(sb.document.body.children.includes(parentOverlay), '子弹窗打开时父弹窗遮罩严禁被提前删除');
        const parentZ = parseInt(parentOverlay.style.zIndex || '100000', 10);
        const childZ = parseInt(childOverlay.style.zIndex || '100000', 10);
        assert.ok(childZ > parentZ, '子弹窗 z-index 必须高于父弹窗');

        // 子弹窗点击取消，父弹窗依然完好无损保留在 DOM 中
        childOverlay.children[0].querySelector('.modhub-modal-btn-cancel').click();
        assert.equal(await childPromise, false, '子弹窗取消回传 false');
        assert.ok(sb.document.body.children.includes(parentOverlay), '子弹窗关闭后父弹窗必须完好存留');

        // 父弹窗继续完成正常确认
        parentOverlay.children[0].querySelector('.modhub-modal-btn-confirm').click();
        assert.equal(await parentPromise, true, '父弹窗必须正常回传 true');

        // 9.6 confirmDelay 倒计时禁用契约（用于冲突二次拦截）
        const delayPromise = sb.modHubConfirm({
            title: '倒计时测试',
            message: '请仔细核对',
            confirmText: '坚持执行',
            confirmDelay: 5
        });
        const delayOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        const delayConfirmBtn = delayOverlay.children[0].querySelector('.modhub-modal-btn-confirm');
        assert.equal(delayConfirmBtn.disabled, true, '带有 confirmDelay 的确认按钮初始必须为禁用状态');
        assert.ok(delayOverlay.children[0].innerHTML.includes('(5s)'), '确认按钮初始文本必须包含 5s 倒计时提示');
        assert.ok(delayOverlay.children[0].innerHTML.includes('disabled'), '确认按钮初始必须包含 disabled 属性');
        // 点击禁用状态的按钮不得触发提前 resolve
        delayConfirmBtn.click();
        // 模拟点击取消正常退出
        delayOverlay.children[0].querySelector('.modhub-modal-btn-cancel').click();
        assert.equal(await delayPromise, false, '取消关闭时能正常返回');
        // 未满足自定义选版条件时也须拦截 Enter，防止触发弹窗背后的入口。
        const keyboard = loadManager();
        let handleKeydown;
        keyboard.document.addEventListener = (type, handler) => { if (type === 'keydown') handleKeydown = handler; };
        let selected = false, prevented = 0;
        const selectionPromise = keyboard.modHubConfirm({ message: '请先选版', canConfirm: () => selected });
        const selectionDialog = keyboard.document.body.children.at(-1).children[0];
        assert.equal(selectionDialog.querySelector('.modhub-modal-btn-confirm').disabled, true);
        handleKeydown({ key: 'Enter', preventDefault: () => prevented++ });
        assert.equal(prevented, 1, '未选版的 Enter 也必须阻止默认操作');
        selected = true;
        selectionDialog.modHubSyncConfirmState();
        assert.equal(selectionDialog.querySelector('.modhub-modal-btn-confirm').disabled, false);
        handleKeydown({ key: 'Enter', preventDefault: () => prevented++ });
        assert.equal(await selectionPromise, true);
    }

    // 精确档案查询：已知缓存缺项属于正常探测，不调用会打印错误的旧接口。
    {
        let exactCalls = 0, legacyCalls = 0;
        const exact = { bootJson: { name: 'ModA' } };
        const utils = {
            getModLoader: () => ({ getModCacheArray: () => [] }),
            getAnyModByNameNoAlias: () => { exactCalls++; return exact; },
            getMod: () => { legacyCalls++; return exact; },
        };
        const sb = loadManager({ modLoaderGui: { gModUtils: utils } });
        assert.equal(sb.modHubGetModInfo('尚未安装'), null, '有效空缓存中的缺项必须安全返回');
        assert.equal(exactCalls + legacyCalls, 0, '已知缓存缺项不得触发旧接口的错误日志');
        sb._modHubDisabledModInfo.set('moda', exact);
        assert.equal(sb.modHubGetModInfo('ModA'), exact, '有效空缓存仍必须读取存储中的精确档案');
        assert.equal(exactCalls + legacyCalls, 0, '读取精确存储档案无需查询旧接口');
        utils.getModLoader = () => ({ getModCacheArray: () => [{ mod: exact }] });
        assert.equal(sb.modHubGetModInfo(' MODA '), exact, '缓存中的精确名称应支持大小写及空白归一');
        assert.equal(sb.modHubGetModInfo('兼容别名'), null, '缓存缺项不得被别名重定向到其他模组');

        sb._modHubDisabledModInfo.clear();
        for (const getModLoader of [undefined, () => ({ getModCacheArray() { throw new Error('旧版本缓存接口异常'); } })]) {
            utils.getModLoader = getModLoader;
            assert.equal(sb.modHubGetModInfo('ModA'), exact, '缓存接口缺失或抛错时仍必须兼容旧接口');
        }
        utils.getAnyModByNameNoAlias = () => { throw new Error('旧查询接口异常'); };
        assert.equal(sb.modHubGetModInfo('ModA'), exact, '新查询接口抛错时必须继续兼容旧版 getMod');
        assert.equal(sb.modHubGetModInfo('兼容别名'), null, '旧版别名查询返回其他模组时必须拒绝误配');
        delete utils.getAnyModByNameNoAlias;
        assert.equal(sb.modHubGetModInfo('ModA'), exact, '新查询接口缺失时必须兼容旧版 getMod');
        utils.getMod = () => { throw new Error('旧接口同样不可用'); };
        assert.equal(sb.modHubGetModInfo('ModA'), null, '全部档案查询接口抛错时应安全返回缺失');
    }

    // 管理页变更仅记录真实配置变化，失败时以回读到的实际配置为准。
    {
        const sb = loadManager({ console: { error() {}, warn() {}, log() {} } });
        sb._modHubModState = { sideMods: [{ name: 'ModA', enabled: true }], sideEnabled: ['ModA'], sideDisabled: [] };
        const tracked = action => sb.modHubRunManagerAction(action, '保存测试', { trackReload: true });
        await tracked(async () => true);
        assert.equal(sb._modHubReloadRevision || 0, 0, '无变化的成功操作不得标记待重载');
        await tracked(async () => false);
        assert.equal(sb._modHubReloadRevision || 0, 0, '取消或无变化操作不得标记待重载');
        await tracked(async () => { sb._modHubModState.sideMods[0].enabled = false; });
        assert.equal(sb._modHubReloadRevision, 1, '成功变更应新增一个待重载批次');
        await sb.modHubRunManagerAction(async () => { sb._modHubModState.sideMods[0].enabled = true; });
        assert.equal(sb._modHubReloadRevision, 1, '导入和市场等未请求追踪的操作不得加入管理页批次');
        sb._modHubBeautyState = { enabledList: [{ type: '美化甲' }, { type: '美化乙' }], disabledList: [] };
        await tracked(async () => { sb._modHubBeautyState.enabledList.reverse(); });
        assert.equal(sb._modHubReloadRevision, 1, '美化启用顺序即时生效，不得标记待重载');

        const unchanged = { sideMods: [{ name: 'ModA', enabled: true }], sideEnabled: ['ModA'], sideDisabled: [] };
        sb._modHubModState = unchanged;
        sb.modHubLoadModManageState = async () => { sb._modHubModState = unchanged; };
        sb.modHubLoadBeautyState = async () => true;
        await tracked(async () => { throw new Error('写入失败'); });
        assert.equal(sb._modHubReloadRevision, 1, '失败且配置未变时不得误记新批次');
        assert.equal(sb._modHubManagerSaveFailed, true, '失败状态必须保留，不能允许刷新');
        sb.modHubLoadModManageState = async () => {
            sb._modHubModState = { sideMods: [{ name: 'ModA', enabled: false }], sideEnabled: [], sideDisabled: ['ModA'] };
        };
        await tracked(async () => { throw new Error('部分写入失败'); });
        assert.equal(sb._modHubReloadRevision, 2, '失败后回读确认部分配置已变，也必须保留待重载批次');
        assert.equal(sb._modHubManagerSaveFailed, true, '部分写入失败不得被待重载标记当成保存成功');
    }

    // 使用真实重载询问，防止沙箱默认屏蔽提示而掩盖批次去重问题。
    function loadReloadManager(overrides = {}) {
        const sb = loadManager(overrides);
        loadScripts(sb, ['javascript/modhub-manager.js']);
        sb.modHubRenderModManageUI = () => {};
        sb.modHubUpdateManagerStatus = () => {};
        sb.modHubShowToast = () => {};
        return sb;
    }
    {
        const sb = loadReloadManager();
        let dialogs = 0, finishDialog;
        sb.modHubConfirm = options => {
            dialogs++;
            assert.equal(options.cancelText, '稍后重载', '集中提示必须保留稍后重载');
            return new Promise(resolve => { finishDialog = resolve; });
        };
        sb._modHubReloadRevision = 2;
        const first = sb.modHubPromptPendingReload(), duplicate = sb.modHubPromptPendingReload();
        await Promise.resolve();
        assert.equal(dialogs, 1, '同一时间多次离开信号只能创建一个提示');
        sb._modHubReloadRevision = 3;
        finishDialog(false);
        await Promise.all([first, duplicate]);
        assert.equal(sb._modHubReloadPromptedRevision, 2, '稍后重载只确认提示创建时的批次，不能吞掉后续变化');
        const next = sb.modHubPromptPendingReload();
        await Promise.resolve();
        assert.equal(dialogs, 2, '后续新变更必须再次集中提醒');
        finishDialog(false);
        await next;
        await sb.modHubPromptPendingReload();
        assert.equal(dialogs, 2, '已选择稍后重载的同一批变化不得重复弹窗');
    }

    // 原生关闭和真正切页才提示；内部切页、隐藏残留及重复绑定不产生干扰。
    {
        const clicks = [], bindings = [], microtasks = [];
        const sb = createBaseSandbox({ queueMicrotask: callback => microtasks.push(callback) });
        const overlay = createStubElement(), parent = createStubElement(), manager = createStubElement();
        let managing = true, hidden = false, parentHidden = false, dialogs = 0;
        overlay.dataset.overlay = 'modloader';
        overlay.parentElement = parent;
        overlay.classList.contains = name => name === 'hidden' && hidden;
        parent.classList.contains = name => name === 'hidden' && parentHidden;
        sb.document.getElementById = id => id === 'customOverlay' ? overlay : id === 'modHubModManageContainer' && managing ? manager : null;
        sb.document.addEventListener = (name, handler, capture) => { if (name === 'click') clicks.push({ handler, capture }); };
        sb.$ = sb.jQuery = () => ({ on: (name, handler) => bindings.push({ name, handler }) });
        loadScripts(sb, ['javascript/modhub-manager.js']);
        sb.modHubShowToast = () => {};
        sb.modHubBindReloadReminder();
        const clickCount = clicks.length, closeCount = bindings.length;
        sb.modHubBindReloadReminder();
        assert.equal(clicks.length, clickCount, '重复绑定不得增加点击监听');
        assert.equal(bindings.length, closeCount, '重复绑定不得增加原生关闭监听');
        assert.ok(clicks.some(listener => listener.capture === true), '切页观察必须在捕获阶段记录离开前的页面');
        const flush = async () => {
            while (microtasks.length) microtasks.shift()();
            if (sb._modHubReloadPromptPromise) await sb._modHubReloadPromptPromise;
        };
        const tab = createStubElement('button');
        tab.textContent = '模组市场';
        tab.closest = () => null;
        tab.click = () => { clicks.forEach(listener => listener.handler({ target: tab })); managing = false; };
        sb.document.querySelectorAll = () => [tab];
        sb.modHubConfirm = async () => { dialogs++; return false; };
        sb._modHubReloadRevision = 1;
        const modalTarget = { closest: selector => selector === '.modhub-modal-backdrop' ? {} : null };
        clicks.forEach(listener => listener.handler({ target: modalTarget }));
        assert.equal(microtasks.length, 0, '确认框内部点击不得被管理页离开观察捕获');
        clicks.forEach(listener => listener.handler({ target: tab }));
        await flush();
        assert.equal(dialogs, 0, '同页点击没有真正离开时不得提示');
        assert.equal(sb.modHubSwitchTab('模组市场', { skipReloadPrompt: true }), true);
        await flush();
        assert.equal(dialogs, 0, '导入程序切页必须显式绕过集中提示');
        managing = true;
        sb.modHubSwitchTab('模组市场');
        await flush();
        assert.equal(dialogs, 1, '玩家切出管理页必须集中提示');
        const close = bindings.find(binding => binding.name.startsWith(':oncloseoverlay'));
        assert.ok(close, '必须监听原生关闭事件');
        hidden = true;
        close.handler({}, 'modloader');
        await flush();
        assert.equal(dialogs, 1, '切页后关闭同一批变化不得重复提示');
        sb._modHubReloadRevision = 2;
        managing = true;
        clicks.forEach(listener => listener.handler({ target: tab }));
        managing = false;
        await flush();
        assert.equal(dialogs, 1, '隐藏覆盖层的残留管理 DOM 不得被当成正在离开');
        hidden = false;
        parentHidden = true;
        managing = true;
        clicks.forEach(listener => listener.handler({ target: tab }));
        managing = false;
        await flush();
        assert.equal(dialogs, 1, '父遮罩隐藏时同样不得误判离开');
        close.handler({}, 'saves');
        await flush();
        assert.equal(dialogs, 1, '关闭存档等其他覆盖层不得触发 ModHub 提示');
        close.handler({}, 'modloader');
        await flush();
        assert.equal(dialogs, 2, '原生关闭 ModHub 时必须提醒尚未确认的新批次');
    }

    // 玩家在首次保存中离开，等待保存结束再提示；失败或安装中严禁刷新。
    {
        const timers = [], sb = loadReloadManager({ setTimeout: (callback, delay) => timers.push({ callback, delay }) });
        sb._modHubModState = { sideMods: [{ name: 'ModA', enabled: true }], sideEnabled: ['ModA'], sideDisabled: [] };
        let finishSave, dialogs = 0, reloaded = 0, installing = false;
        let markStarted;
        const started = new Promise(resolve => { markStarted = resolve; });
        sb.modHubMarket = { isInstallBusy: () => installing };
        sb.location = { reload: () => { reloaded++; } };
        sb.modHubConfirm = async () => { dialogs++; return false; };
        const saving = sb.modHubRunManagerAction(async () => {
            await new Promise(resolve => { finishSave = resolve; markStarted(); });
            sb._modHubModState.sideMods[0].enabled = false;
        }, '等待保存', { trackReload: true });
        await started;
        await sb.modHubPromptPendingReload();
        assert.equal(dialogs, 0, '保存未完成时不得弹出重载选择');
        assert.equal(sb._modHubReloadExitPending, true, '首次保存尚未产生 revision 也必须记录离开请求');
        finishSave();
        await saving;
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(dialogs, 1, '保存解锁后必须处理延迟的离开提醒');
        sb._modHubReloadRevision++;
        for (const [flag, value] of [['_modHubManagerSaveFailed', true], ['_modHubManagerStateUncertain', true], ['_modHubModLoading', Promise.resolve()]]) {
            sb[flag] = value;
            await sb.modHubPromptPendingReload();
            sb.modHubRestartGame();
            assert.equal(dialogs, 1, `${flag} 状态不得弹出刷新选择`);
            assert.equal(sb._modHubReloadPromptedRevision, 1, `${flag} 状态不得确认掉未处理批次`);
            sb[flag] = false;
        }
        installing = true;
        sb.modHubRestartGame();
        assert.equal(reloaded, 0, '市场下载或安装中不得刷新页面');
        installing = false;
        sb.modHubRestartGame();
        assert.equal(reloaded, 1, '完成解锁后立即刷新，不以固定延时等待收尾');
        installing = true;
        sb.modHubRestartGame();
        assert.equal(reloaded, 1, '后续忙碌时刷新入口仍须阻止重载');
        assert.equal(timers.filter(timer => timer.delay === 450).length, 0, '重载不应安排固定延时计时器');
    }

    // 连续普通启禁、删除只累计管理页批次；框架强提醒必须在操作锁释放后创建。
    {
        const controller = createMockController({ enabled: ['ModA', 'ModB', 'SimpleFramework'], zips: ['ModA', 'ModB', 'SimpleFramework'] });
        const sb = loadReloadManager({ modModLoadController: controller });
        await sb.modHubLoadModManageState();
        sb.modHubFindDependentMods = async () => [];
        const prompts = [];
        sb.modHubConfirm = async options => {
            prompts.push({ options, busy: sb._modHubManagerBusy });
            return options.title.startsWith('确认删除');
        };
        await sb.modHubMoveSideMod(0, 'bottom');
        await sb.modHubReorderList('side', 2, 0, false);
        assert.equal(sb._modHubReloadRevision, 2, '步进排序和拖拽排序都必须加入管理页待重载批次');
        sb.addonBeautySelectorAddon = { saveOrder: async () => true };
        sb._modHubBeautyState = { enabledList: [{ type: '美化甲' }, { type: '美化乙' }], disabledList: [], allMap: new Map() };
        await sb.modHubMoveBeauty(0, 'bottom');
        assert.equal(sb._modHubReloadRevision, 2, '美化排序即时应用，不得加入待重载批次');
        const beauty = sb._modHubBeautyState.enabledList[0];
        sb._modHubBeautyState.allMap.set(beauty.type, beauty);
        await sb.modHubToggleBeauty(beauty.type, false);
        assert.equal(sb._modHubReloadRevision, 2, '美化启禁即时应用，不得加入待重载批次');
        sb.modHubLoadBeautyState = async () => true;
        await sb.modHubToggleSideMod('ModA', false, { skipConfirm: true });
        assert.equal(prompts.length, 0, '普通启禁不得逐次弹出重载提示');
        const revision = sb._modHubReloadRevision;
        await sb.modHubToggleSideMod('ModA', false, { skipConfirm: true });
        assert.equal(sb._modHubReloadRevision, revision, '重复启禁不得新增待重载批次');
        await sb.modHubDeleteSideMod('ModA');
        await sb.modHubDeleteSideMod('ModB');
        assert.equal(prompts.length, 2, '连续普通删除只保留删除本身的确认，不得逐次询问重载');
        await sb.modHubToggleSideMod('SimpleFramework', false, { skipConfirm: true });
        const framework = prompts.find(prompt => prompt.options.title === '重新载入游戏（强烈建议）');
        assert.ok(framework, '框架变更必须继续即时强提醒');
        assert.equal(framework.busy, false, '框架提示必须在共享保存锁释放后创建');
        assert.equal(sb._modHubReloadPromptedRevision, sb._modHubReloadRevision, '框架稍后重载后不得再重复提醒已确认批次');
    }

};
