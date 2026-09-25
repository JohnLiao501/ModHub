// ModHub 核心单元测试
// 覆盖契约：boot.json 版本与清单、ModLoader v2.101.1+ 兼容层、智能依赖拓扑排序、
// 单/多模组导入分流、ModLoadController 持久化、模组禁用/启用切换、模组删除、
// 拖拽重排逻辑、原生模态框状态判定、统一索引契约（网站 <-> Mod 端同源消费）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let suiteComplete = false;
process.on('beforeExit', () => {
    if (!suiteComplete) {
        console.error('测试未完成：存在未结束的异步用例');
        process.exitCode = 1;
    }
});

/* =========================================================================
 * 沙箱工具：迷你 DOM 与 Manager/Market 脚本加载器
 * ========================================================================= */
function createStubElement(tag = 'div') {
    const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        className: '',
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        style: {},
        dataset: {},
        children: [],
        parentNode: null,
        _listeners: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, getAttribute: () => null, removeAttribute() {},
        appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
        removeChild(child) { el.children = el.children.filter(item => item !== child); child.parentNode = null; return child; },
        remove() { if (el.parentNode) el.parentNode.removeChild(el); },
        addEventListener(type, cb) { (el._listeners[type] = el._listeners[type] || []).push(cb); },
        removeEventListener() {},
        dispatch(type, event = {}) {
            (el._listeners[type] || []).forEach(cb => cb({ target: el, preventDefault() {}, ...event }));
        },
        querySelector(selector) {
            if (!el._queryCache) el._queryCache = {};
            if (!el._queryCache[selector]) el._queryCache[selector] = createStubElement('button');
            return el._queryCache[selector];
        },
        querySelectorAll: () => [],
        focus() {}, blur() {},
        click() { el.dispatch('click'); },
    };
    return el;
}

function createDocumentStub() {
    return {
        readyState: 'complete',
        body: createStubElement('body'),
        documentElement: createStubElement('html'),
        createElement: tag => createStubElement(tag),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
    };
}

function createBaseSandbox(overrides = {}) {
    const storage = new Map();
    const sandbox = {
        console,
        // 存根定时器：不执行回调，避免启动自检链路在测试进程中挂起
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        queueMicrotask: cb => cb(),
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: key => storage.delete(key),
        },
        document: createDocumentStub(),
        addEventListener() {},
        removeEventListener() {},
        fetch: async () => { throw new Error('测试环境禁止网络请求'); },
        ...overrides,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const jq = function () { return { on() {}, off() {}, length: 0 }; };
    jq.on = () => {};
    sandbox.$ = jq;
    sandbox.jQuery = jq;
    vm.createContext(sandbox);
    return sandbox;
}

function loadManager(overrides = {}) {
    const sandbox = createBaseSandbox(overrides);
    const code = fs.readFileSync(path.join(__dirname, 'javascript', 'modloader-optimization.js'), 'utf8');
    vm.runInContext(code, sandbox);
    // 测试环境屏蔽重型 UI 刷新与提示，聚焦状态变迁
    sandbox.dolOptRenderModManageUI = () => {};
    sandbox.dolOptUpdateManagerStatus = () => {};
    sandbox.dolOptOfferReload = async () => {};
    sandbox._toastLog = [];
    sandbox.dolOptShowToast = (message, type) => { sandbox._toastLog.push({ message, type }); };
    return sandbox;
}

function loadMarket() {
    const sandbox = createBaseSandbox();
    const code = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
    vm.runInContext(code, sandbox);
    return sandbox;
}

/** 构造内存版 ModLoadController（模拟 IndexedDB 持久层） */
function createMockController(initial = {}) {
    const store = {
        enabled: [...(initial.enabled || [])],
        disabled: [...(initial.disabled || [])],
        removed: [],
        zips: new Set(initial.zips || []),
    };
    return {
        store,
        async listModIndexDB() { return [...store.enabled]; },
        async loadHiddenModList() { return [...store.disabled]; },
        async overwriteModIndexDBModList(list) { store.enabled = [...list]; return true; },
        async overwriteModIndexDBHiddenModList(list) { store.disabled = [...list]; return true; },
        async removeModIndexDB(name) {
            store.removed.push(name);
            store.zips.delete(name);
            store.enabled = store.enabled.filter(item => item !== name);
            store.disabled = store.disabled.filter(item => item !== name);
            return true;
        },
    };
}

(async () => {
    /* =========================================================================
     * 1. boot.json 配置契约
     * ========================================================================= */
    const bootJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'boot.json'), 'utf8'));
    assert.equal(bootJson.name, 'ModHub', '模组名称必须为 ModHub');
    assert.equal(bootJson.version, '1.0.1', 'boot.json 版本号必须为 1.0.1');

    // 1.1 ModHub 必需文件完整注册且真实存在于磁盘
    for (const file of ['javascript/modloader-optimization.js', 'javascript/dol-mod-market.js']) {
        assert.ok(bootJson.scriptFileList.includes(file), `scriptFileList 必须包含 ${file}`);
        assert.ok(fs.existsSync(path.join(__dirname, file)), `${file} 必须存在于 src`);
    }
    assert.ok(bootJson.styleFileList.includes('stylesheet/modloader-optimization.css'), '必须注册管理器样式表');
    assert.ok(fs.existsSync(path.join(__dirname, 'stylesheet', 'modloader-optimization.css')), '样式表必须存在');
    assert.ok(bootJson.tweeFileList.includes('twee/modloader/modloader.twee'), '必须注册 modloader.twee');
    assert.ok(fs.existsSync(path.join(__dirname, 'twee', 'modloader', 'modloader.twee')), 'modloader.twee 必须存在');

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
        assert.ok(fs.existsSync(path.join(__dirname, patch.replaceFile)), `补丁文件必须存在: ${patch.replaceFile}`);
    }

    // 1.4 依赖契约：美化选择器与枫桦框架依赖由 ModHub 承接（原版优化侧已移除）
    assert.ok(bootJson.addonPlugin.some(p => p.modName === 'BeautySelectorAddon'), 'ModHub 必须承接 BeautySelectorAddon 插件');
    for (const dep of ['TweeReplacer', 'BeautySelectorAddon', 'maplebirch']) {
        assert.ok(bootJson.dependenceInfo.some(d => d.modName === dep), `dependenceInfo 必须包含 ${dep}`);
    }

    // 1.5 打包脚本契约
    const packPy = fs.readFileSync(path.join(__dirname, '..', 'pack.py'), 'utf8');
    assert.ok(packPy.includes("zip_name = f'ModHub-v{version}.zip'"), '打包文件名必须为 ModHub-v<version>.zip');

    /* =========================================================================
     * 2. ModLoader v2.101.1+ GUI 兼容层
     * ========================================================================= */
    // 2.1 旧版 GUI 存在时直接透传
    {
        const legacy = { listSideLoadModNameOnly: async () => ['legacy'] };
        const sb = loadManager({ modLoaderGui: legacy });
        assert.equal(sb.dolOptGetGui(), legacy, '旧版 modLoaderGui 必须优先透传');
    }
    // 2.2 v2.101.1+ 环境：由 controller + modUtils 构造代理
    {
        const controller = createMockController({ enabled: ['ModA'], disabled: ['ModB'] });
        const modUtils = { getModLoadSwitch: () => ({ safeMode: false }) };
        const sb = loadManager({ modModLoadController: controller, modUtils });
        const gui = sb.dolOptGetGui();
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
        assert.equal(sb.dolOptGetGui(), null, '无 ModLoader 接口时必须返回 null');
    }

    /* =========================================================================
     * 3. 智能依赖拓扑排序（dolOptBuildSmartOrder）
     * ========================================================================= */
    {
        const sb = loadManager();
        // 3.1 基本拓扑：ModA 依赖 ModB，ModB 必须排在 ModA 之前
        const order = await sb.dolOptBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: 'ModB' }] } },
            { key: 'k2', modName: 'ModB', boot: {} },
            { key: 'k3', modName: 'ModC', boot: {} },
        ], null);
        assert.ok(order.indexOf('k2') < order.indexOf('k1'), '被依赖模组必须排在依赖方之前');
        // 3.2 addonPlugin 声明同样构成依赖边
        const addonOrder = await sb.dolOptBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { addonPlugin: [{ modName: 'TweeReplacer' }] } },
            { key: 'k2', modName: 'TweeReplacer', boot: {} },
        ], null);
        assert.deepEqual([...addonOrder], ['k2', 'k1'], 'addonPlugin 依赖必须参与拓扑排序');
        // 3.3 nickName 别名可解析依赖
        const aliasOrder = await sb.dolOptBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: '枫桦框架' }] } },
            { key: 'k2', modName: 'maplebirch', boot: { nickName: { chs: '枫桦框架' } } },
        ], null);
        assert.deepEqual([...aliasOrder], ['k2', 'k1'], '依赖声明中的 nickName 别名必须正确解析');
        // 3.4 无依赖时保持原有相对顺序（稳定排序）
        const stable = await sb.dolOptBuildSmartOrder([
            { key: 'k3', modName: 'ModC', boot: {} },
            { key: 'k1', modName: 'ModA', boot: {} },
            { key: 'k2', modName: 'ModB', boot: {} },
        ], null);
        assert.deepEqual([...stable], ['k3', 'k1', 'k2'], '无依赖关系时必须保持原有相对顺序');
        // 3.5 循环依赖安全回退为原顺序
        const cyclic = await sb.dolOptBuildSmartOrder([
            { key: 'k1', modName: 'ModA', boot: { dependenceInfo: [{ modName: 'ModB' }] } },
            { key: 'k2', modName: 'ModB', boot: { dependenceInfo: [{ modName: 'ModA' }] } },
        ], null);
        assert.deepEqual([...cyclic], ['k1', 'k2'], '循环依赖必须保持原有相对顺序');
    }

    /* =========================================================================
     * 4. 单/多模组导入分流（dolOptResolveImportedModName）
     * ========================================================================= */
    {
        const sb = loadManager();
        sb.dolOptGetModInfo = name => ({
            SmartPhone: { bootJson: { name: 'SmartPhone', nickName: { chs: '万能的智能手机' } } },
        }[name] || null);
        // 4.1 文件名精确归一匹配
        assert.equal(
            sb.dolOptResolveImportedModName('SmartPhone-v0.3.85.zip', ['SmartPhone', 'OtherMod']),
            'SmartPhone', '带版本号的文件名必须归一匹配到已安装模组'
        );
        // 4.2 别名模糊匹配（中文昵称命中）
        assert.equal(
            sb.dolOptResolveImportedModName('万能的智能手机.mod.zip', ['SmartPhone', 'OtherMod']),
            'SmartPhone', '中文别名文件名必须匹配到对应模组'
        );
        // 4.3 无任何匹配时安全返回 null
        assert.equal(
            sb.dolOptResolveImportedModName('completely-unknown-pack.zip', ['SmartPhone']),
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
        await sb.dolOptSaveIndexDBModList(['ModA', 'ModB'], ['ModC']);
        assert.deepEqual(controller.store.enabled, ['ModA', 'ModB'], '启用列表必须完整落盘');
        assert.deepEqual(controller.store.disabled, ['ModC'], '禁用列表必须完整落盘');
        const readBack = await sb.dolOptReadIndexDBModLists();
        assert.ok(readBack.ok, '回读必须成功');
        assert.deepEqual(readBack.enabled, ['ModA', 'ModB']);
        assert.deepEqual(readBack.disabled, ['ModC']);

        // 5.2 启用/禁用交叉去重：启用优先
        await sb.dolOptSaveIndexDBModList(['ModA'], ['ModA', 'ModC']);
        assert.deepEqual(controller.store.disabled, ['ModC'], '同名模组同时出现时启用列表优先');

        // 5.3 已安装未登记模组自动保留（防假删除）
        const controller2 = createMockController({ enabled: ['ModA', 'LegacyMod'] });
        const sb2 = loadManager({ modModLoadController: controller2 });
        await sb2.dolOptSaveIndexDBModList(['ModA'], []);
        assert.ok(controller2.store.enabled.includes('LegacyMod'), '存储中已安装但未登记的模组必须被自动保留');

        // 5.4 dropNames 明确禁止复活（删除场景）
        const controller3 = createMockController({ enabled: ['ModA', 'DeadMod'] });
        const sb3 = loadManager({ modModLoadController: controller3 });
        await sb3.dolOptSaveIndexDBModList(['ModA'], [], { dropNames: ['DeadMod'] });
        assert.ok(!controller3.store.enabled.includes('DeadMod'), 'dropNames 中的模组必须被彻底移除');

        // 5.5 写入后回读不一致必须抛错（杜绝假成功）
        const controller4 = createMockController();
        const originalOverwrite = controller4.overwriteModIndexDBModList;
        controller4.overwriteModIndexDBModList = async list => { await originalOverwrite(list); controller4.store.enabled = []; return true; };
        const sb4 = loadManager({ modModLoadController: controller4 });
        await assert.rejects(() => sb4.dolOptSaveIndexDBModList(['ModA'], []), /校验失败|不一致/, '回读校验失败必须抛错');

        // 5.6 缺少读取接口时按「无法校验」降级而非误判
        const sb5 = loadManager({ modModLoadController: { overwriteModIndexDBModList: async () => true } });
        const degraded = await sb5.dolOptReadIndexDBModLists();
        assert.equal(degraded.ok, false, '缺失读取接口时必须返回 ok:false 降级');
    }

    /* =========================================================================
     * 6. 模组禁用/启用切换（dolOptToggleSideMod）
     * ========================================================================= */
    {
        const controller = createMockController({ enabled: ['ModA', 'ModB'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._dolOptModState = {
            sideMods: [{ name: 'ModA', enabled: true }, { name: 'ModB', enabled: true }],
            sideEnabled: ['ModA', 'ModB'],
            sideDisabled: [],
        };
        // 6.1 禁用模组：状态翻转并落盘
        await sb.dolOptToggleSideMod('ModA', false);
        const item = sb._dolOptModState.sideMods.find(m => m.name === 'ModA');
        assert.equal(item.enabled, false, '禁用后 enabled 必须为 false');
        assert.deepEqual(sb._dolOptModState.sideDisabled, ['ModA'], '禁用列表必须同步更新');
        assert.deepEqual(controller.store.disabled, ['ModA'], '禁用结果必须写入存储');
        assert.deepEqual(controller.store.enabled, ['ModB'], '启用存储必须同步移除被禁用模组');
        // 6.2 幂等：目标状态与当前一致时内部早退返回 false（无变更语义）
        const again = await sb.dolOptToggleSideMod('ModA', false);
        assert.equal(again, false, '重复禁用必须幂等早退（返回 false 表示无变更）');
        assert.deepEqual(controller.store.disabled, ['ModA'], '重复禁用不得改变存储');
        // 6.3 重新启用：模组回到其在统一顺序列表中的原始位置（排序不因开关而改变）
        await sb.dolOptToggleSideMod('ModA', true);
        assert.deepEqual(sb._dolOptModState.sideEnabled, ['ModA', 'ModB'], '重新启用后必须回到原始排序位置');
        assert.deepEqual(sb._dolOptModState.sideDisabled, [], '禁用列表必须清空');
    }

    /* =========================================================================
     * 7. 模组删除（dolOptDeleteSideMod 确认双分支）
     * ========================================================================= */
    {
        // 7.1 用户取消：不产生任何变更
        const controller = createMockController({ enabled: ['ModA'], zips: ['ModA'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._dolOptModState = {
            sideMods: [{ name: 'ModA', enabled: true }],
            sideEnabled: ['ModA'],
            sideDisabled: [],
        };
        sb.dolOptConfirm = async () => false;
        await sb.dolOptDeleteSideMod('ModA');
        assert.equal(sb._dolOptModState.sideMods.length, 1, '取消删除时列表必须保持不变');
        assert.equal(controller.store.removed.length, 0, '取消删除时不得调用包体移除');

        // 7.2 用户确认：列表移除 + dropNames 落盘 + 包体删除
        const controller2 = createMockController({ enabled: ['ModA'], zips: ['ModA'] });
        const sb2 = loadManager({ modModLoadController: controller2 });
        sb2._dolOptModState = {
            sideMods: [{ name: 'ModA', enabled: true }],
            sideEnabled: ['ModA'],
            sideDisabled: [],
        };
        let confirmOptions = null;
        sb2.dolOptConfirm = async options => { confirmOptions = options; return true; };
        await sb2.dolOptDeleteSideMod('ModA');
        assert.equal(confirmOptions.confirmType, 'danger', '删除确认必须为危险操作样式');
        assert.equal(sb2._dolOptModState.sideMods.length, 0, '确认后模组必须从列表移除');
        assert.deepEqual(controller2.store.removed, ['ModA'], '确认后必须删除浏览器存储中的包体');
        assert.deepEqual(controller2.store.enabled, [], '存储启用列表不得残留已删模组');
        assert.ok(!sb2._dolOptDisabledModInfo.has('moda'), '禁用档案缓存必须同步清除');
    }

    /* =========================================================================
     * 8. 拖拽重排逻辑（dolOptReorderList）
     * ========================================================================= */
    {
        const controller = createMockController({ enabled: ['ModA', 'ModB', 'ModC'] });
        const sb = loadManager({ modModLoadController: controller });
        sb._dolOptModState = {
            sideMods: [{ name: 'ModA', enabled: true }, { name: 'ModB', enabled: true }, { name: 'ModC', enabled: true }],
            sideEnabled: ['ModA', 'ModB', 'ModC'],
            sideDisabled: [],
        };
        // 8.1 拖到目标之后：ModA(0) -> ModC(2) 之后
        await sb.dolOptReorderList('side', 0, 2, true);
        assert.deepEqual(sb._dolOptModState.sideMods.map(m => m.name), ['ModB', 'ModC', 'ModA'], '拖拽至目标之后必须正确重排');
        assert.deepEqual(controller.store.enabled, ['ModB', 'ModC', 'ModA'], '重排结果必须写入存储');
        // 8.2 拖到目标之前：ModA(2) -> ModB(0) 之前
        await sb.dolOptReorderList('side', 2, 0, false);
        assert.deepEqual(sb._dolOptModState.sideMods.map(m => m.name), ['ModA', 'ModB', 'ModC'], '拖拽至目标之前必须正确重排');
        // 8.3 非法索引安全早退
        const before = JSON.stringify(sb._dolOptModState.sideMods);
        await sb.dolOptReorderList('side', 0, 0, false);
        await sb.dolOptReorderList('side', 9, 1, false);
        assert.equal(JSON.stringify(sb._dolOptModState.sideMods), before, '非法索引不得改变列表');
    }

    /* =========================================================================
     * 9. 原生模态框状态判定（0 原生弹窗红线）
     * ========================================================================= */
    {
        const sb = loadManager();
        assert.equal(typeof sb.dolOptConfirm, 'function', '必须封装游戏原生暗黑确认框');
        assert.equal(typeof sb.dolOptAlert, 'function', '必须封装游戏原生暗黑提示框');
        // 9.1 确认按钮交互：模拟用户点击确认
        const confirmPromise = sb.dolOptConfirm({ title: '测试', message: '确认吗', confirmType: 'danger' });
        const overlay = sb.document.body.children.find(el => el.id === 'dolOptConfirmOverlay');
        assert.ok(overlay, '确认框遮罩必须挂载到 body');
        const dialog = overlay.children[0];
        dialog.querySelector('.dol-opt-modal-btn-confirm').click();
        assert.equal(await confirmPromise, true, '点击确认必须回传 true');
        // 9.2 取消按钮交互
        const cancelPromise = sb.dolOptConfirm('再去吗');
        const overlay2 = sb.document.body.children[sb.document.body.children.length - 1];
        overlay2.children[0].querySelector('.dol-opt-modal-btn-cancel').click();
        assert.equal(await cancelPromise, false, '点击取消必须回传 false');
        // 9.3 红线静态扫描：源码不得调用浏览器原生 alert / window.confirm
        const managerSource = fs.readFileSync(path.join(__dirname, 'javascript', 'modloader-optimization.js'), 'utf8');
        assert.ok(!/[^.\w]alert\s*\(/.test(managerSource), '严禁调用浏览器原生 alert()');
        assert.ok(!/window\.confirm\s*\(/.test(managerSource), '严禁调用 window.confirm()');
        const marketSource = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
        assert.ok(!/[^.\w]alert\s*\(/.test(marketSource), '市场模块严禁调用浏览器原生 alert()');
        assert.ok(!/window\.confirm\s*\(/.test(marketSource), '市场模块严禁调用 window.confirm()');
    }

    /* =========================================================================
     * 10. 统一索引契约（网站 release-index / 身份目录 <-> Mod 端消费）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        assert.ok(market, '市场模块必须导出 window.dolModMarket');
        for (const member of ['normalizeReleaseIndex', 'applyIdentityCatalog', 'fetchReleaseIndex', 'MARKET_CATEGORIES', 'KNOWN_MOD_MARKET_ALIASES', 'IDENTITY_CATALOG_URL', 'RELEASE_WORKER_API_BASE']) {
            assert.ok(market[member] !== undefined, `市场导出必须包含 ${member}`);
        }
        // 10.1 schemaVersion 守卫
        assert.throws(() => market.normalizeReleaseIndex({ schemaVersion: 2, mods: [] }), /格式异常/, '非 v1 索引必须拒绝');
        const normalized = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [] });
        assert.ok(normalized && typeof normalized === 'object', '合法索引必须正常归一化');
        // 10.2 身份目录结构契约：schemaVersion=1、mods 数组、关键字段齐全
        const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod-identities.json'), 'utf8'));
        assert.equal(catalog.schemaVersion, 1, '身份目录 schemaVersion 必须为 1');
        assert.ok(Array.isArray(catalog.mods) && catalog.mods.length > 0, '身份目录 mods 必须为非空数组');
        for (const mod of catalog.mods) {
            assert.ok(mod.id && typeof mod.id === 'string', '身份条目必须包含 id');
            assert.ok(mod.name && typeof mod.name === 'string', `身份条目 ${mod.id} 必须包含 name`);
            assert.ok(Array.isArray(mod.bootNames), `身份条目 ${mod.id} 必须包含 bootNames 数组`);
            assert.ok(typeof mod.category === 'string', `身份条目 ${mod.id} 必须声明分类`);
            // 10.3 分类必须落在市场分类表内，否则 applyIdentityCatalog 会静默丢弃
            assert.ok(market.MARKET_CATEGORIES.includes(mod.category), `身份条目 ${mod.id} 的分类「${mod.category}」必须存在于 MARKET_CATEGORIES`);
        }
        // 10.4 身份目录可被 Mod 端正确消费（应用数量与别名注册）
        const applied = market.applyIdentityCatalog(JSON.parse(JSON.stringify(catalog)));
        assert.ok(applied >= catalog.mods.length, '身份目录必须全部被应用');
        const first = catalog.mods.find(m => m.bootNames.length > 0);
        // 与市场内部 normalizeKey 等效的键归一化
        const firstKey = String(first.bootNames[0]).toLowerCase().replace(/[()（）\[\]【】_—\-—.\s]/g, '').trim();
        assert.ok(market.KNOWN_MOD_MARKET_ALIASES[firstKey], `应用后必须能通过 bootName 键「${firstKey}」检索到别名映射`);
    }

    /* =========================================================================
     * 11. 模组安装分流：市场安装「稍后重载」不得切走页签
     * ========================================================================= */
    {
        // 11.1 市场安装路径必须声明 keepCurrentTab（防止回归）
        const marketSource = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
        const marketCall = marketSource.match(/dolOptHandleAddMod\([^)]*?\{[\s\S]*?\}\)/);
        assert.ok(marketCall && marketCall[0].includes('keepCurrentTab: true'), '市场安装调用必须传递 keepCurrentTab: true');
        // 11.2 管理页本地导入路径不得携带 keepCurrentTab（保持原有高亮跳转设计）
        const managerSource = fs.readFileSync(path.join(__dirname, 'javascript', 'modloader-optimization.js'), 'utf8');
        const importCalls = managerSource.match(/dolOptHandleAddMod\([^)]*?\{[^}]*?\}\)/g) || [];
        assert.ok(importCalls.length >= 4, '管理器本地导入调用点必须存在');
        for (const call of importCalls) {
            assert.ok(!call.includes('keepCurrentTab'), `本地导入不得携带 keepCurrentTab: ${call.slice(0, 80)}`);
        }
        // 11.3 分支结构断言：keepCurrentTab 分支只提示不跳页，本地导入分支保留原高亮跳转设计
        const keepBranch = managerSource.match(/else if \(options\.keepCurrentTab\) \{[\s\S]*?\} else \{/);
        assert.ok(keepBranch, '稍后重载分支必须包含 keepCurrentTab 专用处理');
        assert.ok(!keepBranch[0].includes("dolOptSwitchTab('模组管理')"), 'keepCurrentTab 分支严禁切换页签');
        const legacyBranch = managerSource.match(/\} else \{\s*window\._dolOptHighlightMods[\s\S]*?dolOptSwitchTab\('模组管理'\)/);
        assert.ok(legacyBranch, '本地导入分支必须保留「切换管理页并高亮」的原有设计');
    }

    suiteComplete = true;
    console.log('ModHub v1.0.1 all tests PASSED!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
