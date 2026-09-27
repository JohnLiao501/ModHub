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
    assert.equal(bootJson.version, '1.0.5', 'boot.json 版本号必须为 1.0.5');

    // 1.1 ModHub 必需文件完整注册且真实存在于磁盘
    assert.deepEqual(bootJson.scriptFileList, [
        'javascript/modhub-manager.js', 'javascript/modhub-dialog.js',
        'javascript/modhub-drag.js', 'javascript/modhub-beauty.js', 'javascript/modhub-readme.js',
        'javascript/modhub-log.js', 'javascript/modhub-market.js',
    ], '必须先加载公共管理接口，再加载弹窗、拖拽、美化、说明、日志与市场');
    for (const file of bootJson.scriptFileList) {
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
        for (const file of bootJson.scriptFileList) {
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
    }

};
