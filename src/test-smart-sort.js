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
        URL,
        URLSearchParams,
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
    assert.equal(bootJson.version, '1.0.4', 'boot.json 版本号必须为 1.0.4');

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

    // 1.4 彻底解耦契约：杜绝占用 BeautySelectorAddon 图包槽位，移除无用依赖
    assert.ok(!bootJson.addonPlugin.some(p => p.modName === 'BeautySelectorAddon'), 'ModHub 不携带图包，绝不能在 addonPlugin 声明 BeautySelectorAddon，防止抢占原版优化图像包');
    assert.ok(!bootJson.dependenceInfo.some(d => d.modName === 'BeautySelectorAddon'), 'dependenceInfo 不得残留 BeautySelectorAddon 依赖');
    assert.ok(!bootJson.dependenceInfo.some(d => d.modName === 'maplebirch'), 'dependenceInfo 不得残留 maplebirch 依赖');
    assert.ok(bootJson.dependenceInfo.some(d => d.modName === 'TweeReplacer'), 'dependenceInfo 必须包含 TweeReplacer 核心补丁依赖');

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
        // 9.4 模态框 customResult 与 onRender 扩展契约
        let renderedDialog = null;
        const customPromise = sb.dolOptConfirm({
            title: '自定义测试',
            message: '测试信息',
            onRender: (dlg) => { renderedDialog = dlg; },
            customResult: () => ({ customValue: 'test1234', isCustom: true })
        });
        assert.ok(renderedDialog, 'onRender 回调必须被成功调用并传入 dialog DOM');
        const overlay3 = sb.document.body.children[sb.document.body.children.length - 1];
        overlay3.children[0].querySelector('.dol-opt-modal-btn-confirm').click();
        const customResult = await customPromise;
        assert.deepEqual(customResult, { customValue: 'test1234', isCustom: true }, '点击确认必须回传 customResult 提取的对象');

        // 9.5 多层模态弹窗栈堆叠契约（子弹窗严禁摧毁父弹窗 DOM）
        const parentPromise = sb.dolOptConfirm({ title: '父弹窗', message: '主流程待处理' });
        const parentOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        assert.ok(parentOverlay, '父弹窗必须成功挂载');

        // 在父弹窗激活状态下打开子弹窗（如快捷禁用影响评估确认框）
        const childPromise = sb.dolOptConfirm({ title: '子弹窗', message: '子操作确认' });
        const childOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        assert.notEqual(parentOverlay, childOverlay, '子弹窗必须创建独立遮罩');
        assert.ok(sb.document.body.children.includes(parentOverlay), '子弹窗打开时父弹窗遮罩严禁被提前删除');
        const parentZ = parseInt(parentOverlay.style.zIndex || '100000', 10);
        const childZ = parseInt(childOverlay.style.zIndex || '100000', 10);
        assert.ok(childZ > parentZ, '子弹窗 z-index 必须高于父弹窗');

        // 子弹窗点击取消，父弹窗依然完好无损保留在 DOM 中
        childOverlay.children[0].querySelector('.dol-opt-modal-btn-cancel').click();
        assert.equal(await childPromise, false, '子弹窗取消回传 false');
        assert.ok(sb.document.body.children.includes(parentOverlay), '子弹窗关闭后父弹窗必须完好存留');

        // 父弹窗继续完成正常确认
        parentOverlay.children[0].querySelector('.dol-opt-modal-btn-confirm').click();
        assert.equal(await parentPromise, true, '父弹窗必须正常回传 true');

        // 9.6 confirmDelay 倒计时禁用契约（用于冲突二次拦截）
        const delayPromise = sb.dolOptConfirm({
            title: '倒计时测试',
            message: '请仔细核对',
            confirmText: '坚持执行',
            confirmDelay: 5
        });
        const delayOverlay = sb.document.body.children[sb.document.body.children.length - 1];
        const delayConfirmBtn = delayOverlay.children[0].querySelector('.dol-opt-modal-btn-confirm');
        assert.equal(delayConfirmBtn.disabled, true, '带有 confirmDelay 的确认按钮初始必须为禁用状态');
        assert.ok(delayOverlay.children[0].innerHTML.includes('(5s)'), '确认按钮初始文本必须包含 5s 倒计时提示');
        assert.ok(delayOverlay.children[0].innerHTML.includes('disabled'), '确认按钮初始必须包含 disabled 属性');
        // 点击禁用状态的按钮不得触发提前 resolve
        delayConfirmBtn.click();
        // 模拟点击取消正常退出
        delayOverlay.children[0].querySelector('.dol-opt-modal-btn-cancel').click();
        assert.equal(await delayPromise, false, '取消关闭时能正常返回');
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

        // 10.5 目录与版本独立刷新仍兼容 v1，且保留 Wiki 元数据与权威版本字段
        const indexedMod = {
            ...catalog.mods.find(mod => mod.id === 'modhub'),
            identityId: 'modhub', wikiName: 'ModHub模组管理中心',
            githubUrl: 'https://github.com/JohnLiao501/ModHub',
            githubUrls: ['https://github.com/JohnLiao501/ModHub', 'https://github.com/NEEDMEET/ModHub'],
            wikiVersion: '1.0.1', wikiDate: '2026-09-26',
            version: '1.0.2', versionSource: 'github', updateDate: '2026-09-27',
            releaseUrl: 'https://github.com/JohnLiao501/ModHub/releases/tag/v1.0.2'
        };
        const splitIndex = {
            schemaVersion: 1, catalogUpdatedAt: '2026-09-27T00:02:00.000Z',
            generatedAt: '2026-09-27T00:05:00.000Z', identities: catalog.mods, mods: [indexedMod]
        };
        const [normalizedMod] = market.normalizeReleaseIndex(splitIndex);
        for (const field of ['id', 'identityId', 'wikiVersion', 'wikiDate', 'version', 'versionSource', 'updateDate', 'releaseUrl', 'category']) {
            assert.equal(normalizedMod[field], indexedMod[field], `独立刷新索引必须保留 ${field}`);
        }
        assert.deepEqual(Array.from(normalizedMod.githubUrls), indexedMod.githubUrls, '必须保留 Wiki 原始仓库链接集合');
        assert.deepEqual(Array.from(normalizedMod.bootNames), indexedMod.bootNames, '独立刷新不得丢失模组身份名称');
        assert.equal(splitIndex.catalogUpdatedAt, '2026-09-27T00:02:00.000Z', '归一化不得改写目录刷新时间');

        // 10.6 手动刷新绕过列表缓存，并重新验证各镜像的 HTTP 缓存
        const oldMod = { name: 'ModHub', version: '1.0.1', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        sb.localStorage.setItem('dol_opt_market_wiki_v5', JSON.stringify({ data: [oldMod], timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '1.0.1', '普通加载应保留已有列表缓存');
        const requestedUrls = [];
        sb.fetch = async (url, options) => {
            requestedUrls.push(url);
            assert.equal(options.cache, 'no-cache', '索引请求必须重新验证 HTTP 缓存');
            if (url === market.RELEASE_INDEX_MIRRORS[0]) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: [{ ...oldMod, version: '1.0.2' }] }) };
        };
        assert.equal((await market.loadMarketData(true))[0].version, '1.0.2', '手动刷新必须取代内存和本地的旧版本列表');
        assert.deepEqual(requestedUrls, Array.from(market.RELEASE_INDEX_MIRRORS), '主镜像失效后必须继续尝试备用镜像');
    }

    // 统一索引已更新时，安装预检与下载共用的 Release 缓存不能选择旧安装包
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const mod = { name: 'ModHub', version: '1.0.2', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        const cacheKey = 'dol_opt_market_rel_v2_JohnLiao501_ModHub';
        let cache = {
            version: '1.0.1', assetPlanVersion: 2, assetPlanGameVersion: '',
            assets: [{ name: 'ModHub-v1.0.1.zip', downloadUrl: `${mod.githubUrl}/releases/download/v1.0.1/ModHub-v1.0.1.zip` }]
        };
        const writeCache = version => sb.localStorage.setItem(cacheKey, JSON.stringify({ data: { ...cache, version }, timestamp: Date.now() }));
        writeCache('1.0.1');
        let requestCount = 0;
        sb.fetch = async () => {
            requestCount++;
            return { ok: true, status: 200, json: async () => ({
                tag_name: 'v1.0.2', name: 'v1.0.2', assets: [{
                    name: 'ModHub-v1.0.2.zip',
                    browser_download_url: `${mod.githubUrl}/releases/download/v1.0.2/ModHub-v1.0.2.zip`
                }]
            }) };
        };
        const release = await market.fetchModRelease(mod);
        assert.equal(release.version, '1.0.2', '低于市场版本的 Release 缓存必须被重新获取');
        assert.equal(requestCount, 1, '跳过旧缓存后必须请求 GitHub');
        assert.ok(release.assetUrl.endsWith('/ModHub-v1.0.2.zip'), '安装包地址必须来自新 Release');
        assert.equal((await market.fetchModRelease(mod)).fromCache, true, '不低于市场版本的缓存仍可复用');
        assert.equal(requestCount, 1, '可用缓存不得产生额外请求');

        sb.fetch = async () => { throw new Error('模拟 GitHub 离线'); };
        writeCache('1.0.2');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, '旧资产选择规则缓存即使版本一致也不得离线复用');
        cache = { ...release };
        writeCache('1.0.1');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, 'GitHub 失败时也不得回退到低于市场版本的安装包');
        writeCache('1.0.2');
        assert.equal((await market.fetchModRelease(mod, { useCache: false })).isStale, true, '版本满足要求时必须保留网络失败后的缓存回退');
    }

    // 统一索引保留指定发布渠道，主包与同仓库扩展不得串包或共用旧缓存
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const repoUrl = 'https://github.com/AOKIUTAGE/UTAGEsDOL3.0';
        const index = { schemaVersion: 1, mods: [
            { name: 'AU美化', identityId: null, githubUrl: `${repoUrl}/releases/tag/mod`, releaseUrl: `${repoUrl}/releases/tag/facemod`, version: '99.0', versionSource: 'github', wikiVersion: '0.8.7' },
            { name: 'AU面部扩展', identityId: null, githubUrl: `${repoUrl}/releases/tag/facemod` }
        ] };
        const mods = market.normalizeReleaseIndex(index);
        assert.equal(mods[0].version, '0.8.7', '旧索引的跨渠道版本必须回退到本条目的Wiki版本');
        assert.equal(mods[0].releaseUrl, null, '旧索引的错配发布页不得继续展示');
        sb.localStorage.setItem('dol_opt_market_wiki_v5', JSON.stringify({ data: index.mods, timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '0.8.7', '本地列表缓存也必须经过渠道纠偏');
        assert.notEqual(market.getMarketModKey(mods[0]), market.getMarketModKey(mods[1]), '同仓库不同发布渠道必须保留独立的批量安装身份');
        sb.localStorage.setItem('dol_opt_market_rel_v2_AOKIUTAGE_UTAGEsDOL3.0', JSON.stringify({
            timestamp: Date.now(), data: { version: '99.0', assetPlanVersion: 2, assetPlanGameVersion: '', assets: [{ name: 'wrong.zip', downloadUrl: 'wrong' }] }
        }));
        const urls = [];
        sb.fetch = async url => {
            urls.push(url);
            const tag = decodeURIComponent(url.split('/tags/')[1] || 'latest');
            return { ok: true, status: 200, json: async () => ({ tag_name: tag, assets: [{
                name: `${tag}.zip`, browser_download_url: `${repoUrl}/releases/download/${tag}/${tag}.zip`
            }] }) };
        };
        assert.equal((await market.fetchModRelease(mods[0])).assetName, 'mod.zip', 'AU主包必须遵循 githubUrl 指定渠道，不得采用旧索引 releaseUrl 或缓存中的面部扩展');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '面部扩展必须使用自己的发布渠道');
        assert.deepEqual(urls, ['mod', 'facemod'].map(tag => `https://api.github.com/repos/AOKIUTAGE/UTAGEsDOL3.0/releases/tags/${tag}`));
        assert.equal((await market.fetchModRelease(mods[0])).fromCache, true, '指定标签成功后仍可复用本渠道缓存');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '两次缓存读取不得互相覆盖');
        assert.equal(urls.length, 2, '渠道缓存命中不得额外访问网络');
        assert.equal((await market.fetchRecentCompanionAssets(mods[0])).length, 0, '固定渠道不得跨发布渠道推荐附属包');
        assert.equal(urls.length, 2);

        const encodedMod = { githubUrl: `${repoUrl}/releases/tag/model%2Fstable?test=1#assets` };
        const encodedRelease = await market.fetchModRelease(encodedMod);
        assert.ok(urls.at(-1).endsWith('/releases/tags/model%2Fstable'), '标签须解码一次再作为单个 API 路径参数编码');
        assert.equal(encodedRelease.htmlUrl, `${repoUrl}/releases/tag/model%2Fstable`, '缺少发布页地址时必须回退到指定标签');
        const callsBeforeMissing = urls.length;
        sb.fetch = async url => { urls.push(url); return { ok: false, status: 404 }; };
        await assert.rejects(market.fetchModRelease(mods[0], { useCache: false }), error => error.code === 'RELEASE_NOT_FOUND', '指定标签404不得回退到 latest 或过期包');
        assert.equal(urls.length, callsBeforeMissing + 1, '指定标签失效不得继续查询其他发布渠道');
        assert.notEqual(mods[0]._isDeadRepo, true, '标签不存在不能误标整个仓库失效');
        sb.fetch = async () => { throw new Error('模拟渠道离线'); };
        assert.equal((await market.fetchModRelease(mods[0], { useCache: false })).assetName, 'mod.zip', '离线回退也必须保持渠道隔离');
    }

    // AU发布页包含多个独立模型系列，覆盖包不能被误当成直装包
    {
        const market = loadMarket().dolModMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const assets = Object.entries({ female: ['0.8.7', '0.9.3'], male: ['0.3.7', '0.4.2'], androgynous: ['0.0.7', '0.1.1'] })
            .flatMap(([model, versions]) => versions.flatMap(version => ['model', 'imgpack'].map(type => asset(`AU${model}.${type}_v${version}.zip`))));
        const plan = market.buildReleaseAssetPlan(assets);
        assert.equal(plan.needsChoice, true, '不同模型系列必须交由玩家选择');
        assert.equal(plan.assets.length, 0, '不得跨模型系列比较版本后自动安装女体');
        assert.deepEqual(Array.from(plan.candidates, item => item.name).sort(), [
            'AUfemale.model_v0.9.3.zip', 'AUmale.model_v0.4.2.zip', 'AUandrogynous.model_v0.1.1.zip'
        ].sort(), '必须保留每个模型系列的最新版直装包，排除配对覆盖包');
        const single = market.buildReleaseAssetPlan([asset('AUfemale.model_v0.9.3.zip'), asset('AUfemale.imgpack_v0.9.3.zip')]);
        assert.equal(single.needsChoice, false);
        assert.equal(single.assets.length, 1, '同一模型不得同时安装model与覆盖用imgpack');
        assert.equal(single.assets[0].name, 'AUfemale.model_v0.9.3.zip');
        assert.equal(market.buildReleaseAssetPlan([asset('Example-v1.0.zip'), asset('Example-v2.0.zip')]).assets[0].name, 'Example-v2.0.zip', '普通模组仍选最新版本');
        assert.equal(market.buildReleaseAssetPlan([asset('Only.imgpack_v1.0.zip')]).assets[0].name, 'Only.imgpack_v1.0.zip', '无配对model时不得凭扩展命名排除既有独立资源');
    }

    // Wiki 回退也必须只采用名称列来源，拆分独立项目并识别共享仓库。
    {
        const sb = loadMarket();
        const anchor = (textContent, href) => ({ textContent, getAttribute: () => href });
        const cell = (textContent, links = []) => ({ textContent, querySelectorAll: () => links });
        const cells = [
            [cell('主模组', [anchor('主模组', 'https://github.com/Owner/Shared')]), cell('介绍', [anchor('依赖', 'https://github.com/Other/Dependency')]), cell('作者'), cell('2026-09-27 (v1.0)')],
            [cell('扩展 / 独立工具', [anchor('扩展', 'https://github.com/Owner/Shared'), anchor('独立工具', 'https://github.com/Owner/Tool')]), cell('介绍'), cell('作者'), cell('2026-09-27')]
        ];
        const header = { querySelectorAll: () => ['名称', '简介', '作者', '更新'].map(text => cell(text)) };
        const rows = cells.map(tds => ({ querySelectorAll: () => tds, querySelector: () => null }));
        const table = { querySelector: () => header, querySelectorAll: () => rows };
        sb.Node = { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 };
        sb.DOMParser = class { parseFromString() { return {
            getElementById: id => id === '公开模组' ? { compareDocumentPosition: () => 4 } : null,
            querySelectorAll: () => [table]
        }; } };
        const mods = sb.dolModMarket.parseModsFromHtml('');
        assert.deepEqual(Array.from(mods, mod => mod.name), ['主模组', '扩展', '独立工具']);
        assert.deepEqual(Array.from(mods[0].githubUrls), ['https://github.com/Owner/Shared'], '不得采集介绍中的依赖仓库');
        assert.equal(mods[0].otherUrl, null);
        assert.deepEqual(Array.from(mods, mod => mod.sharedRepository), [true, true, false]);
        assert.notEqual(sb.dolModMarket.getMarketModKey(mods[0]), sb.dolModMarket.getMarketModKey(mods[1]), 'Wiki回退无ID时共享仓库多项不能被批量合并');
        const cached = sb.dolModMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: mods.map(mod => ({
            ...mod, sharedRepository: undefined, version: '99.0', versionSource: 'github', wikiVersion: '1.0',
            releaseUrl: 'https://github.com/Owner/Shared/releases/tag/Other'
        })) });
        assert.equal(cached[0].sharedRepository, true, '旧缓存未带字段时也必须重新识别共享仓库');
        assert.equal(cached[0].version, '1.0', '共享仓库的旧latest版本必须清除');
        assert.equal(cached[0].releaseUrl, null);
        assert.equal(cached[2].version, '99.0', '独立仓库版本仍可正常使用');
    }

    // 同名、子串和仓库尾名都不能跨模组建立身份。
    {
        const market = loadMarket().dolModMarket;
        const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod-identities.json'), 'utf8'));
        market.applyIdentityCatalog(catalog);
        const main = { ...catalog.mods.find(item => item.id === 'woven-realm'), githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm', sharedRepository: true };
        const child = { ...catalog.mods.find(item => item.id === 'woven-realm-cooking'), githubUrl: main.githubUrl, sharedRepository: true };
        for (const [target, other] of [[main, child], [child, main]]) {
            market.checkModInstallStatus(target, [{ name: target.bootNames[0] }]);
            assert.equal(target._matchedLocal?.name, target.bootNames[0]);
            market.checkModInstallStatus(other, [{ name: target.bootNames[0] }]);
            assert.equal(other._matchedLocal, null, '织境主包和料理扩展不得共享别名');
        }
        const unknown = { name: '美化扩展', githubUrl: 'https://github.com/Fixture/Unknown' };
        assert.equal(market.checkModInstallStatus(unknown, [{ name: '美化扩展修复' }]), 'not_installed');
        market.applyIdentityCatalog([{ identityId: null, id: 'wiki-a', name: '假条目', repositories: ['RealTech'] }]);
        assert.equal(market.checkModInstallStatus({ ...unknown, name: '假条目' }, [{ name: 'RealTech' }]), 'not_installed');
        const sameNames = ['A', 'B'].map(owner => ({ id: `fixture-${owner}`, name: '同名模组', bootNames: [`Tech${owner}`], repositoryKeys: [`${owner}/Same`], githubUrl: `https://github.com/${owner}/Same` }));
        market.applyIdentityCatalog(sameNames);
        for (const entry of sameNames) {
            for (const local of sameNames) {
                market.checkModInstallStatus(entry, [{ name: local.bootNames[0], repository: local.githubUrl }]);
                assert.equal(Boolean(entry._matchedLocal), entry.id === local.id, '同名不同作者必须按完整仓库隔离');
            }
        }
        const doli = { name: 'D.O.L.I', githubUrl: 'https://github.com/ArsNativa/DOLI' };
        market.checkModInstallStatus(doli, [{ name: 'DOLI', repository: 'https://github.com/Other/Different' }]);
        assert.equal(doli._matchedLocal, null, '显式来源与已知身份不同的本地包不得冒充官方版本');
        assert.equal(market.findMarketModByLocalName('无来源同名', ['A', 'B'].map(owner => ({ name: '无来源同名', githubUrl: `https://github.com/${owner}/Repo` }))), null, '反查同分不能取第一项');
        const tagged = tag => ({ identityId: 'one-id', name: '固定渠道', githubUrl: `https://github.com/Owner/Repo/releases/tag/${tag}` });
        assert.notEqual(market.getMarketModKey(tagged('main')), market.getMarketModKey(tagged('extra')));
        assert.notEqual(...['main.zip', 'extra.zip'].map(name => market.getMarketModKey({ identityId: 'one-id', githubUrl: `https://github.com/Owner/Repo/releases/download/v1/${name}` })), '同标签的指定附件也必须保留独立身份');
        const shared = { ...unknown, githubUrl: 'https://github.com/Owner/RealTech', sharedRepository: true };
        market.checkModInstallStatus(shared, [{ name: 'RealTech' }]);
        assert.equal(shared._matchedLocal, null, '共享仓库尾名不能证明当前产品已安装');
        const sidebar = { name: 'NPC侧边栏头像', githubUrl: 'https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL' };
        market.checkModInstallStatus(sidebar, [{ name: 'NPC侧边栏头像', repository: sidebar.githubUrl }]);
        assert.ok(sidebar._matchedLocal, '侧边栏头像本身的真实来源必须仍可识别');
        market.checkModInstallStatus(sidebar, [{ name: 'NPCAvatarsMod', repository: 'https://github.com/Eudemonism00/DOL-npcicon-mods' }]);
        assert.equal(sidebar._matchedLocal, null, '社交栏头像不能充当另一作者的侧边栏头像');
    }

    // 资产按产品系列选择，共享仓库查找当前条目的发布而非仓库latest。
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const frameworkAssets = ['Simple.Framework.ver2.0.5.build_2.zip', 'Simple.Inventory.ver1.0.0.build_18.zip', 'simple.new.content.ver0.0.1.zip'].map(asset);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets).needsChoice, true);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets, '', { bootNames: ['Simple Framework'] }).assets[0].name, frameworkAssets[0].name);
        assert.equal(market.buildReleaseAssetPlan(['Foo1.0.zip', 'Bar99.0.zip'].map(asset)).candidates.length, 2, '不能跨产品比较版本');
        assert.equal(market.buildReleaseAssetPlan([asset('ResourcePack.zip')]).assets.length, 1, '独立资源主包不能重复安装');
        const companions = market.buildReleaseAssetPlan(['Main1.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip'].map(asset));
        assert.deepEqual(Array.from(companions.assets, item => item.name), ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(market.buildReleaseAssetPlan(['source-code.zip', 'app.apk.zip', 'Other.7z', 'Other.rar'].map(asset)).assets.length, 0);
        assert.equal(market.buildReleaseAssetPlan([asset('Foo Mobile 1.0.zip'), asset('Foo Desktop 1.0.zip')]).assets[0].name, 'Foo Desktop 1.0.zip');
        const repo = 'https://github.com/Fixture/Shared';
        const urls = [];
        sb.fetch = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ['Other', 'Foo', 'Bar'].map((name, index) => ({
            tag_name: `product-${index}`, html_url: `${repo}/releases/tag/product-${index}`,
            assets: [{ name: `${name}1.0.zip`, browser_download_url: `${repo}/releases/download/product-${index}/${name}1.0.zip` }]
        })) }; };
        const mod = name => ({ name, bootNames: [name], githubUrl: repo, sharedRepository: true });
        assert.equal((await market.fetchModRelease(mod('Foo'))).assetName, 'Foo1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Bar'))).assetName, 'Bar1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Foo'))).fromCache, true);
        assert.equal(urls.length, 2, '同仓库不同条目缓存不能串包');
        assert.ok(urls.every(url => url.endsWith('/releases?per_page=100')));
        await assert.rejects(market.fetchModRelease(mod('Missing')), error => error.code === 'MANUAL_SOURCE');
        for (const suffix of ['/tree/main', '/blob/main/mod.zip', '/issues/1', '/releases/latest/extra']) {
            await assert.rejects(market.fetchModRelease({ githubUrl: repo + suffix }), error => error.code === 'MANUAL_SOURCE');
        }
        await assert.rejects(market.fetchModRelease({ githubUrl: 'https://fake.github.com/Fixture/Shared' }), /无法解析/);
        sb.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1', assets: ['Foo1.0.zip', 'Bar2.0.zip'].map(name => ({ name, browser_download_url: `${repo}/releases/download/v1/${name}` })) }) });
        assert.equal((await market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Foo1.0.zip` })).assetName, 'Foo1.0.zip');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Missing.zip` }), error => error.code === 'RELEASE_NOT_FOUND', '指定附件消失时不能改装其他文件');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/tag/another` }), error => error.code === 'RELEASE_NOT_FOUND', '返回标签与指定标签不同必须停止');
        sb.fetch = async () => { const error = new Error('取消'); error.name = 'AbortError'; throw error; };
        await assert.rejects(market.fetchModRelease(mod('Foo'), { useCache: false }), error => error.name === 'AbortError', '取消请求不能继续使用离线包');
    }

    // 手选仍保留匹配资源；需手动来源的条目直接解释原因，不进入自动导入。
    {
        const sb = loadMarket();
        sb.Blob = Blob;
        sb.dolOptGetGui = () => ({});
        sb.dolOptShowToast = () => {};
        sb.dolOptEscapeHtml = value => value;
        const installedFiles = [];
        sb.dolOptHandleAddMod = async input => { installedFiles.push(...Array.from(input.files || input, file => file.name)); return true; };
        sb.dolOptConfirm = async () => 'asset:0';
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob(['data']) });
        const availableAssets = ['Main1.0.zip', 'Bar2.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip']
            .map(name => ({ name, downloadUrl: `https://example.test/${name}` }));
        assert.equal(await sb.dolModMarket.downloadAndInstallMod({ name: '手选测试' }, 'ddlc', { askRestart: false, releaseInfo: {
            requiresManualSelection: true, version: '99.0', candidateAssets: availableAssets.slice(0, 2), availableAssets
        } }), true);
        assert.deepEqual(installedFiles, ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(JSON.parse(sb.localStorage.getItem('dol_opt_market_confirmed_updates_v1'))['手选测试'], '1.0', '手选低版本不能被记录为仓库最高版本');
        const dialogs = [];
        sb.dolOptConfirm = async dialog => { dialogs.push(dialog); return false; };
        sb.fetch = async () => { throw new Error('文件页不应访问API'); };
        const manual = { name: '分支模组', githubUrl: 'https://github.com/Fixture/Repo/tree/main' };
        assert.equal(await sb.dolModMarket.downloadAndInstallMod(manual), false);
        assert.equal(dialogs.at(-1).confirmText, '打开主页');
        assert.ok(dialogs.at(-1).message.includes('文件或分支'));
        assert.equal(installedFiles.length, 2, '手动来源不能调用安装接口');
        let batchFailure = '';
        assert.equal(await sb.dolModMarket.downloadAndInstallMod(manual, 'ddlc', { batchMode: true, onFailure: reason => { batchFailure = reason; } }), false);
        assert.ok(batchFailure.includes('文件或分支'));
        assert.equal(dialogs.length, 1, '批量应记录原因且不弹单装对话框');
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

    /* =========================================================================
     * 12. 模组市场已移除仓库（404）与无 Release 更新判定防护
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;

        // 12.1 作者已移除 GitHub 仓库（isDeadRepo）时，即使远程有更高版本，也绝不误报更新，返回 up_to_date
        const deadRepoMod = {
            name: '织境空间·料理扩展',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '0.4.19',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const profiles = [{
            name: 'WovenRealmCookingAddon',
            version: '0.1.626',
            displayNames: ['WovenRealmCookingAddon', '织境空间-料理扩展', '织境空间·料理扩展'],
            normalizedNames: ['wovenrealmcookingaddon', '织境空间料理扩展'],
            repos: ['wovenrealmcookingaddon'],
            repositoryKeys: ['kanna-hanabi/wovenrealm']
        }];
        const deadStatus = market.checkModInstallStatus(deadRepoMod, profiles);
        assert.equal(deadStatus, 'up_to_date', '作者已移除仓库的模组本地已安装时必须判定为已是最新（up_to_date），严禁误报更新');

        // 12.2 仓库失效且未安装时，无外部链接必须返回 unavailable，有外部链接返回 external_only
        const deadNotInstalled = {
            name: '某个已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadNotInstalled, []), 'unavailable', '已删库且无外部链接未安装模组必须返回 unavailable');
        const deadWithOtherUrl = {
            name: '带网盘的已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            otherUrl: 'https://example.com/pan',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadWithOtherUrl, []), 'external_only', '已删库但有外部链接未安装模组必须返回 external_only');

        // 12.3 无有效 Release 产物且版本来源为 Wiki 时，不误报更新
        const wikiOnlyMod = {
            name: '纯Wiki旧版本模组',
            githubUrl: 'https://github.com/some-author/no-release-mod',
            version: '2.0.0',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const localModProfiles = [{
            name: '纯Wiki旧版本模组',
            version: '1.0.0',
            displayNames: ['纯Wiki旧版本模组'],
            normalizedNames: ['纯wiki旧版本模组'],
            repos: ['no-release-mod'],
            repositoryKeys: ['some-author/no-release-mod']
        }];
        assert.equal(market.checkModInstallStatus(wikiOnlyMod, localModProfiles), 'up_to_date', '无可用 Release 的 Wiki 参考版本模组不得误报 update_available');

        // 12.4 正常具备 GitHub Release 且版本更高时，必须正确触发 update_available
        const validReleaseMod = {
            name: '正常可更新模组',
            githubUrl: 'https://github.com/normal-author/good-mod',
            version: '2.0.0',
            versionSource: 'github',
            releaseUrl: 'https://github.com/normal-author/good-mod/releases/tag/v2.0.0'
        };
        const validLocalProfiles = [{
            name: '正常可更新模组',
            version: '1.0.0',
            displayNames: ['正常可更新模组'],
            normalizedNames: ['正常可更新模组'],
            repos: ['good-mod'],
            repositoryKeys: ['normal-author/good-mod']
        }];
        assert.equal(market.checkModInstallStatus(validReleaseMod, validLocalProfiles), 'update_available', '具有真实 Release 的更高版本模组必须正常触发 update_available');

        // 12.5 同作者多个模组自动识别为失效（织境空间主模组与场景互动扩展）
        const uiMod = {
            name: '织境空间-场景互动扩展',
            author: '璐子',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealmUI',
            version: '0.8.7',
            versionSource: 'wiki',
            releaseUrl: null
        };
        assert.ok(market.isDeadRepo(uiMod.githubUrl, uiMod), '同作者扩展模组仓库 WovenRealmUI 必须被识别为已失效');
        assert.equal(market.checkModInstallStatus(uiMod, []), 'unavailable', '已失效的场景互动扩展未安装时必须返回 unavailable');

        // 12.6 样式表必须包含 .badge-dead-repo 红色标签样式
        const cssContent = fs.readFileSync(path.join(__dirname, 'stylesheet', 'modloader-optimization.css'), 'utf8');
        assert.ok(cssContent.includes('.badge-dead-repo'), 'CSS 必须定义 .badge-dead-repo 红色标签样式');

        // 12.7 市场脚本中必须导出并正确引用 badge-dead-repo
        const marketJs = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
        assert.ok(marketJs.includes('badge-dead-repo'), '市场卡片渲染必须应用 badge-dead-repo');

        // 12.8 消除误诊：单字符短横线合法仓库（如 dawalizhang/- 与 lingyu230514/-）严禁被误判为失效
        const ranchMod = {
            name: '牧场与你相识的故事',
            author: '海苔大福&达瓦里张&多玩',
            githubUrl: 'https://github.com/dawalizhang/-',
            version: '1.0.0'
        };
        const newSpaceMod = {
            name: '全新空间',
            author: '多玩',
            githubUrl: 'https://github.com/lingyu230514/-',
            version: '1.04'
        };
        assert.equal(market.isDeadRepo(ranchMod.githubUrl, ranchMod), false, '牧场与你相识的故事严禁被误判为源失效');
        assert.equal(market.isDeadRepo(newSpaceMod.githubUrl, newSpaceMod), false, '全新空间严禁被误判为源失效');
        assert.equal(market.checkModInstallStatus(ranchMod, []), 'not_installed', '牧场与你相识的故事未安装时必须为 not_installed 允许下载');
        assert.equal(market.checkModInstallStatus(newSpaceMod, []), 'not_installed', '全新空间未安装时必须为 not_installed 允许下载');

        // 12.9 历史存储误诊自愈清洗能力断言
        sb.localStorage.setItem('dol_opt_market_dead_repos_v1', JSON.stringify(['dawalizhang/-', 'kanna-hanabi/wovenrealm']));
        const cleanedList = market.getDeadRepos();
        assert.ok(!cleanedList.includes('dawalizhang/-'), '活跃白名单仓库必须自动从失效存储中清洗剔除');
        assert.ok(cleanedList.includes('kanna-hanabi/wovenrealm'), '真正失效的仓库必须继续保留');

        // 12.10 本地安装 GuideToMe 等模组被市场准确识别为已安装
        const mouthMod = {
            name: '控制NPC嘴部',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/DOL-GuideToMe',
            version: '1.1.0'
        };
        const simsMod = {
            name: '模拟人生',
            author: '丧心',
            githubUrl: 'https://github.com/MissedHeart/Degrees-of-Lewdity-DolSims',
            version: '0.8.1.7'
        };
        const wraithMod = {
            name: '怨灵的倒影',
            author: '水墨儿（悠飘过去了）',
            githubUrl: 'https://github.com/Water2311/WraithsReflection/',
            version: '1.3.0'
        };
        const busMod = {
            name: '公交车防骚扰',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/NoBusHarassmentMod',
            version: '1.0.3'
        };

        const testProfiles = [
            { name: 'GuideToMe', version: '1.1.0' },
            { name: 'DoLSims', version: '0.8.1.7' },
            { name: 'Wraith\'sReflection', version: '1.3.0' },
            { name: 'NoBusHarassmentMod', version: '1.0.3' },
            { name: 'ModHub', version: '1.0.2' }
        ];

        assert.equal(market.checkModInstallStatus(mouthMod, testProfiles), 'up_to_date', 'GuideToMe 本地已安装时，市场控制NPC嘴部必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(simsMod, testProfiles), 'up_to_date', 'DoLSims 本地已安装时，市场模拟人生必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(wraithMod, testProfiles), 'up_to_date', 'Wraith\'sReflection 本地已安装时，市场怨灵的倒影必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(busMod, testProfiles), 'up_to_date', 'NoBusHarassmentMod 本地已安装时，市场公交车防骚扰必须识别为 up_to_date');

        // 12.11 管理页 dolOptGetModSubtext 智能副标题与简介回填测试
        const fullSb = loadManager();
        const marketScript = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
        vm.runInContext(marketScript, fullSb);

        assert.equal(fullSb.window.dolOptGetModSubtext('GuideToMe', { bootJson: { version: '1.1.0' } }), '控制NPC嘴部', 'GuideToMe 必须能获取友好副标题');
        assert.equal(fullSb.window.dolOptGetModSubtext('DoLSims', { bootJson: { version: '0.8.1.7' } }), '模拟人生', 'DoLSims 必须能获取友好副标题');
        assert.equal(fullSb.window.dolOptGetModSubtext('Wraith\'sReflection', { bootJson: { version: '1.3.0' } }), '怨灵的倒影', 'Wraith\'sReflection 必须能获取友好副标题');
        assert.equal(fullSb.window.dolOptGetModSubtext('ModHub', { bootJson: bootJson }), '模组管理器与市场套件', 'ModHub 必须显示自身副标题');

        // 12.12 动态市场回填测试：未知本地模组通过市场条目自动回填中文名称或简介
        fullSb.window.dolModMarket.findMarketModByLocalName = (localName) => {
            if (localName === 'SomeUnknownMod') {
                return { name: '未知超强扩展', desc: '用于增强各种交互功能的拓展' };
            }
            return null;
        };
        assert.equal(fullSb.window.dolOptGetModSubtext('SomeUnknownMod', { bootJson: { version: '1.0.0' } }), '未知超强扩展', '未知模组必须能联动市场数据自动回填副标题');

        // 12.13 模组市场与本地模组防混淆测试（针对 ImageLoaderHook 与 D.O.L.I 字母拼合假阳性拦截）
        const doliMarketMod = {
            name: 'D.O.L.I',
            author: 'ArsNativa',
            githubUrl: 'https://github.com/ArsNativa/Degrees-of-Lewdity-Intelligence',
            repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence'],
            version: '0.2.3'
        };

        const imageHookProfiles = [
            {
                name: 'ModLoader DoL ImageLoaderHook',
                version: '2.101.0',
                displayNames: ['ModLoader DoL ImageLoaderHook'],
                normalizedNames: ['modloaderdolimageloaderhook'],
                repos: ['modloaderdolimageloaderhook'],
                repositoryKeys: []
            },
            {
                name: 'ModSubUiAngularJs',
                version: '1.0.0',
                displayNames: ['ModSubUiAngularJs'],
                normalizedNames: ['modsubuiangularjs'],
                repos: ['modsubuiangularjs'],
                repositoryKeys: []
            }
        ];

        // 仅安装 ImageLoaderHook 时，D.O.L.I 必须准确识别为 not_installed
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, imageHookProfiles),
            'not_installed',
            '本地仅安装 ImageLoaderHook 时，市场中的 D.O.L.I 必须为 not_installed，绝不能误判为 up_to_date'
        );

        // findMarketModByLocalName 反查时，ImageLoaderHook 绝不能反向匹配到 D.O.L.I
        const reversedMarketMod = market.findMarketModByLocalName('ModLoader DoL ImageLoaderHook', [doliMarketMod]);
        assert.equal(
            reversedMarketMod,
            null,
            'ImageLoaderHook 在模组市场反向检索中必须返回 null，不得误匹配到 D.O.L.I'
        );

        // 当本地真正安装了 DOLI 时，必须能准确匹配并判定为已是最新
        const realDoliProfiles = [
            {
                name: 'DOLI',
                version: '0.2.2',
                displayNames: ['DOLI', 'D.O.L.I', 'Degrees-of-Lewdity-Intelligence'],
                normalizedNames: ['doli', 'degreesoflewdityintelligence'],
                repos: ['doli', 'degreesoflewdityintelligence'],
                repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence']
            }
        ];
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, realDoliProfiles),
            'up_to_date',
            '本地真正安装 DOLI 时，市场中的 D.O.L.I 必须准确识别为 up_to_date'
        );
        const realMatchedMarket = market.findMarketModByLocalName('DOLI', [doliMarketMod]);
        assert.ok(
            realMatchedMarket && realMatchedMarket.name === 'D.O.L.I',
            '本地 DOLI 必须能准确反向找到市场中的 D.O.L.I'
        );
    }

    // 13. 日志分析引擎与快速诊断增强测试（TweeReplacer 补丁冲突精准诊断与段落提取）
    {
        const manager = loadManager();
        const rawLogLines = [
            '17:44:46.245 [错误] [TweeReplacer] do_patch() cannot find findString: [原版优化] findString: [ <<overlayReplace "startFeats">> <</button>> </div>] in: [Widgets Clothing Caption]',
            '17:44:46.250 [错误] [TweeReplacer] do_patch() done: [原版优化] okCount:[31] errorCount:[1]'
        ];

        const analysis = manager.dolOptAnalyzeLogs(rawLogLines);

        assert.equal(analysis.errorCount, 2, '两行包含错误标记的日志必须计为 2 处错误');
        assert.ok(analysis.errorMods.includes('原版优化'), '必须准确提取报错模组【原版优化】');
        assert.ok(analysis.errorFiles.includes('Widgets Clothing Caption'), '必须准确提取报错段落【Widgets Clothing Caption】');

        assert.equal(analysis.matchedIssues.length, 1, '两行补丁同源错误必须归纳为 1 项知识库命中');
        const issue = analysis.matchedIssues[0];
        assert.equal(issue.id, 'twee-patch-mismatch', '必须精准命中 twee-patch-mismatch 模式，绝不能退化为常规运行时异常');
        assert.ok(issue.desc.includes('原版优化'), '诊断描述中必须包含受影响模组名');
        assert.ok(issue.desc.includes('Widgets Clothing Caption'), '诊断描述中必须包含目标段落名');
        assert.ok(issue.solution.includes('智能整理模组与美化顺序'), '解决方案必须指导使用智能整理或调整次序');
        assert.ok(issue.solution.includes('核心剧情') && issue.solution.includes('可正常游玩'), '对于原版优化顶栏入口补丁冲突必须给出不影响核心游玩的安抚与分析');
    }

    // 13.2 怨灵的倒影神庙段落补丁冲突精准诊断与友好建议测试
    {
        const manager = loadManager();
        const rawLogLines = [
            "18:03:49.097 [错误] [TweeReplacer] do_patch() cannot find findString: [Wraith'sReflection] findString:[<<lockicon>><<link [[询问贞操带|Temple Chastity]]>><</link>>] in:[Temple Jordan]",
            "18:03:49.107 [错误] [TweeReplacer] do_patch() done: [Wraith'sReflection] okCount:[75] errorCount:[1]"
        ];

        const analysis = manager.dolOptAnalyzeLogs(rawLogLines);

        assert.equal(analysis.errorCount, 2, '两行错误日志必须计为 2 处错误');
        assert.ok(analysis.errorMods.includes("Wraith'sReflection"), '必须准确提取报错模组 Wraith\'sReflection');
        assert.ok(analysis.errorFiles.includes('Temple Jordan'), '必须准确提取报错段落 Temple Jordan');

        assert.equal(analysis.matchedIssues.length, 1, '同源错误必须归纳为 1 项知识库命中');
        const issue = analysis.matchedIssues[0];
        assert.equal(issue.id, 'twee-patch-mismatch', '必须精准命中 twee-patch-mismatch 模式');
        assert.ok(issue.desc.includes('怨灵的倒影'), '描述中必须包含友好中文别名【怨灵的倒影】');
        assert.ok(issue.desc.includes('Temple Jordan'), '描述中必须包含目标段落名 Temple Jordan');
        assert.ok(issue.desc.includes('汉化') || issue.desc.includes('银海螺'), '描述中必须说明汉化环境或分支选项原因');
        assert.ok(issue.solution.includes('不必担心') && issue.solution.includes('怨灵恋爱核心剧情'), '必须给出定心丸说明不影响恋爱核心剧情');
        assert.ok(issue.solution.includes('智能整理模组与美化顺序'), '解决方案必须指导使用智能整理模组与美化顺序');
    }

    // 13.3 启动错误对象不能因消息缺少 Error 字样而漏记，原版日志仍保持独立
    {
        const forwarded = [];
        const manager = loadManager({
            console: {
                error(...args) { forwarded.push({ context: this, args }); return '已转发'; }
            },
            modLoaderGui: {
                gLoadingProgress: { logList: [{ type: 'info', str: 'ModLoader startInit() start' }] }
            }
        });
        const firstError = vm.runInContext("new TypeError('ev.preventDefault is not a function')", manager, { filename: 'tw-user-script-0' });
        const detail = { source: '启动脚本' };
        const originalContext = {};
        assert.equal(manager.console.error.call(originalContext, firstError, detail), '已转发', '捕获器必须保留原 console.error 返回值');
        assert.equal(manager._dolOptStartupErrors.length, 1, '消息中不含 Error 字样的 TypeError 也必须捕获');
        assert.ok(manager._dolOptStartupErrors[0].includes('TypeError: ev.preventDefault is not a function'), '必须保留原始异常类型与消息');
        assert.ok(manager._dolOptStartupErrors[0].includes('tw-user-script-0:1:'), '必须保留异常堆栈中的脚本位置');
        assert.equal(manager._dolOptStartupErrors[0].split('TypeError: ev.preventDefault is not a function').length, 2, '堆栈已含异常摘要时不得重复添加摘要');
        assert.equal(forwarded[0].context, originalContext, '必须保留原 console.error 调用上下文');
        assert.equal(forwarded[0].args[0], firstError, '必须原样转发异常对象');
        assert.equal(forwarded[0].args[1], detail, '必须原样转发附加参数');

        manager.console.error(vm.runInContext(`new Error("0.5.11.9 Error (:: ): <<variablesStatic>>: TypeError: Cannot read properties of undefined (reading 'Init')")`, manager));
        manager.console.error('普通控制台提示');
        manager.console.error(new Error('modList.json 读取失败'));
        manager.console.error(new Error('ResizeObserver loop limit exceeded'));
        assert.equal(manager._dolOptStartupErrors.length, 2, '后续 StoryInit 异常必须保留，普通提示与良性降级不得误报');
        assert.equal(forwarded.length, 5, '捕获或过滤日志都必须原样转发且仅转发一次');

        const loaderLogs = manager.modLoaderGui.gLoadingProgress.logList;
        assert.equal(loaderLogs.filter(item => item.type === 'error').length, 0, '不得将运行时异常写入原版 ModLoader 日志');
        const analysis = manager.dolOptAnalyzeLogs(manager.dolOptGetRawModLoaderLogs());
        assert.equal(analysis.errorCount, 2, '原版日志无错误时，合并日志仍须显示两个运行时异常');
        assert.equal(analysis.infoCount, 1, '合并日志必须保留原版信息日志');

        const noStackError = new ReferenceError('启动变量未定义');
        delete noStackError.stack;
        manager.console.error(noStackError);
        assert.equal(manager._dolOptStartupErrors[2], '[控制台报错] ReferenceError: 启动变量未定义', '无堆栈的异常也必须保留类型并正常捕获');
        const firefoxError = new TypeError('启动对象不可用');
        firefoxError.stack = 'startup@file:///game.html:12:3';
        manager.console.error(firefoxError);
        assert.equal(manager._dolOptStartupErrors[3], '[控制台报错] TypeError: 启动对象不可用\nstartup@file:///game.html:12:3', '堆栈不含类型摘要时必须补充摘要并保留原堆栈');
        assert.equal(forwarded.length, 7, '不同堆栈格式不得影响原日志转发');
    }

    // 14. 顶部吸顶操作栏按钮顺序与样式契约测试
    {
        const managerScript = fs.readFileSync(path.join(__dirname, 'javascript', 'modloader-optimization.js'), 'utf8');
        const actionBlockMatch = managerScript.match(/<div class="dol-opt-header-actions">([\s\S]*?)<\/div>/);
        assert.ok(actionBlockMatch, 'modloader-optimization.js 必须包含 dol-opt-header-actions 操作按钮容器');
        const actionBlock = actionBlockMatch[1];

        // 提取按钮文本与顺序
        const buttonMatches = [...actionBlock.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)];
        assert.equal(buttonMatches.length, 4, '顶部操作栏必须有且仅有 4 个核心操作按钮');

        const buttonNames = buttonMatches.map(m => m[2].trim());
        assert.deepEqual(
            buttonNames,
            ['导入模组', '重新载入游戏', '智能整理模组与美化顺序', '刷新列表'],
            '顶部按钮顺序必须为：导入模组 -> 重新载入游戏 -> 智能整理模组与美化顺序 -> 刷新列表'
        );

        // 验证所有按钮均统一具备 dol-opt-btn-primary 类
        for (const m of buttonMatches) {
            const attrs = m[1];
            const name = m[2].trim();
            assert.ok(attrs.includes('dol-opt-btn-primary'), `按钮【${name}】必须具备 dol-opt-btn-primary 样式类`);
            assert.ok(attrs.includes('macro-button'), `按钮【${name}】必须具备 macro-button 基础类`);
        }
    }

    /* =========================================================================
     * 13. 前置依赖展示与可勾选契约（多色状态指示与可选安装）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        assert.equal(typeof market.formatDependencyListHtml, 'function', '必须导出 formatDependencyListHtml 函数');

        // 13.1 前置依赖全部满足场景
        const satisfiedPlan = {
            requirements: [
                { mod: { name: '秋枫白桦框架' }, dependency: { id: 'maplebirch', version: '^1.0.0' } }
            ],
            actions: []
        };
        const satisfiedHtml = market.formatDependencyListHtml(satisfiedPlan);
        assert.ok(satisfiedHtml.includes('dol-opt-dep-satisfied'), '已满足依赖必须带有 dol-opt-dep-satisfied 类');
        assert.ok(satisfiedHtml.includes('green'), '已满足依赖状态必须带有 green 绿色高亮');
        assert.ok(satisfiedHtml.includes('已满足'), '已满足依赖必须显示「已满足」标签');
        assert.ok(!satisfiedHtml.includes('type="checkbox"'), '已满足依赖不应展示勾选框');

        // 13.2 包含未安装、待更新、未启用多种状态的场景
        const modA = { name: '已安装模组' };
        const modB = { name: '未安装模组' };
        const modC = { name: '待更新模组' };
        const modD = { name: '未启用模组' };
        const mixedPlan = {
            requirements: [
                { mod: modA, dependency: { id: 'modA' } },
                { mod: modB, dependency: { id: 'modB', version: '^2.0.0' } },
                { mod: modC, dependency: { id: 'modC', version: '^1.5.0' } },
                { mod: modD, dependency: { id: 'modD' } }
            ],
            actions: [
                { type: 'install', mod: modB, requirement: '^2.0.0' },
                { type: 'update', mod: modC, local: { version: '1.0.0' }, requirement: '^1.5.0' },
                { type: 'enable', mod: modD }
            ]
        };
        const mixedHtml = market.formatDependencyListHtml(mixedPlan);
        // 未安装项：金色，可勾选
        assert.ok(mixedHtml.includes('未安装'), '必须包含「未安装」状态');
        assert.ok(mixedHtml.includes('data-active-color="gold"'), '未安装状态色彩必须为 gold');
        assert.ok(mixedHtml.includes('name="dolOptDepReq"'), '待处理项必须提供复选框');
        assert.ok(mixedHtml.includes('checked'), '复选框必须默认勾选');
        // 需更新项：金色
        assert.ok(mixedHtml.includes('需更新'), '必须包含「需更新」状态');
        // 未启用项：紫色
        assert.ok(mixedHtml.includes('未启用'), '必须包含「未启用」状态');
        assert.ok(mixedHtml.includes('data-active-color="purple"'), '未启用状态色彩必须为 purple');

        // 13.3 勾选与取消勾选时的 actions 过滤逻辑断言
        // 模拟用户仅勾选未安装模组 (reqIndex 1)，取消更新与启用
        const selectedReqIndices = new Set([1]);
        const filteredActions = mixedPlan.actions.filter(action =>
            mixedPlan.requirements.some((req, idx) => req.mod === action.mod && selectedReqIndices.has(idx))
        );
        assert.equal(filteredActions.length, 1, '取消勾选后只保留选中的 1 项 action');
        assert.equal(filteredActions[0].mod.name, '未安装模组', '保留的 action 必须对应选中的未安装模组');

        // 模拟用户全部取消勾选
        const emptyIndices = new Set();
        const noneActions = mixedPlan.actions.filter(action =>
            mixedPlan.requirements.some((req, idx) => req.mod === action.mod && emptyIndices.has(idx))
        );
        assert.equal(noneActions.length, 0, '全部取消勾选时 actions 必须为空');
    }

    /* =========================================================================
     * 14. 模组安装兼容性与冲突检测契约（枫叶框架 vs 简易框架等）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const cssContent = fs.readFileSync(path.join(__dirname, 'stylesheet', 'modloader-optimization.css'), 'utf8');
        assert.ok(Array.isArray(market.KNOWN_MOD_CONFLICT_RULES), '必须导出已知模组冲突规则库');
        assert.equal(typeof market.detectModInstallationConflicts, 'function', '必须导出 detectModInstallationConflicts');
        assert.equal(typeof market.formatConflictWarningHtml, 'function', '必须导出 formatConflictWarningHtml');

        // 14.1 场景 1：本地已安装且启用「秋枫白桦框架」，安装依赖「简易框架」的模组（如日落伊甸园）
        const localProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch', nickName: { chs: '秋枫白桦框架' } },
                displayNames: ['秋枫白桦框架', 'maplebirch']
            }
        ];
        const targetMod = { name: '日落伊甸园', id: 'InTheEdenAfterSunset' };
        const candidateActions = [
            { type: 'install', mod: { name: '简易框架', id: 'SimpleFramework' } }
        ];
        // 本地未禁用（即处于启用状态）
        const conflicts = market.detectModInstallationConflicts(targetMod, candidateActions, localProfiles, new Set());
        assert.equal(conflicts.length, 1, '必须准确识别 1 项已知互斥冲突');
        assert.equal(conflicts[0].incomingMod.name, '简易框架', '即将引入的冲突模组必须为简易框架');
        assert.equal(conflicts[0].localConflictMod.name, '秋枫白桦框架', '本地冲突模组必须识别为秋枫白桦框架');
        assert.equal(conflicts[0].localConflictMod.isEnabled, true, '本地模组必须识别为已启用状态');

        // 验证 HTML 渲染
        const conflictHtml = market.formatConflictWarningHtml(conflicts);
        assert.ok(conflictHtml.includes('dol-opt-install-conflict-card'), '必须包含冲突警告卡片容器');
        assert.ok(conflictHtml.includes('兼容性警告'), '必须包含兼容性警告标签');
        assert.ok(conflictHtml.includes('本地冲突已启用·高风险'), '启用冲突必须包含高风险警示');
        assert.ok(conflictHtml.includes('秋枫白桦框架'), '必须包含秋枫白桦框架名称');
        assert.ok(conflictHtml.includes('简易框架'), '必须包含简易框架名称');

        // 14.2 场景 2：玩家取消勾选冲突前置依赖「简易框架」
        const emptyActions = [];
        const clearedConflicts = market.detectModInstallationConflicts(targetMod, emptyActions, localProfiles, new Set());
        assert.equal(clearedConflicts.length, 0, '取消勾选冲突前置后，冲突数量必须归零');

        // 14.3 场景 3：本地存在冲突模组但处于禁用状态
        const disabledNames = new Set(['maplebirch']);
        const disabledConflicts = market.detectModInstallationConflicts(targetMod, candidateActions, localProfiles, disabledNames);
        assert.equal(disabledConflicts.length, 1, '禁用状态下依然需要提醒冲突存在');
        assert.equal(disabledConflicts[0].localConflictMod.isEnabled, false, '本地模组必须识别为未启用');
        const disabledHtml = market.formatConflictWarningHtml(disabledConflicts);
        assert.ok(disabledHtml.includes('本地已安装·当前禁用'), '未启用模组必须显示当前禁用标签');
        assert.ok(disabledHtml.includes('is-resolved'), '冲突已全部排除时卡片容器必须携带 is-resolved 类名');
        assert.ok(disabledHtml.includes('检查通过'), '冲突已全部排除时卡片徽章必须显示【检查通过】');
        assert.ok(disabledHtml.includes('冲突已排除 · 兼容性检查通过'), '冲突已全部排除时卡片标题必须切换为检查通过文本');
        assert.ok(!disabledHtml.includes('dol-opt-conflict-disable-btn'), '已禁用模组无需再渲染快捷禁用按钮');

        // 14.4 场景 4：目标模组自身直接为冲突模组（如本地有秋枫，直接安装简易框架）
        const directMod = { name: '简易框架', id: 'SimpleFramework' };
        const directConflicts = market.detectModInstallationConflicts(directMod, [], localProfiles, new Set());
        assert.equal(directConflicts.length, 1, '直接安装冲突模组必须触发冲突警告');
        assert.equal(directConflicts[0].incomingMod.role, '目标模组', '冲突角色必须为目标模组');

        // 同一作者的普通模组不能因仓库所有者含框架名称而误判互斥。
        const longerCombat = { id: 'longer-combat', name: '更长遭遇战/言灵作弊集', githubUrl: 'https://github.com/MaplebirchLeaf/LongerCombat' };
        const ordinaryActions = [{ type: 'install', mod: directMod }, { type: 'install', mod: longerCombat }];
        assert.equal(market.detectModInstallationConflicts(directMod, [ordinaryActions[1]], [], new Set()).length, 0, '单项安装中的普通同作者模组不能误判为秋枫框架');
        assert.equal(market.detectModInstallationConflicts(null, ordinaryActions, [], new Set()).length, 0, '简易框架与同作者普通模组批量安装不能误报内部互斥');
        assert.equal(market.detectModInstallationConflicts(longerCombat, [], [{ name: 'Simple Frameworks' }], new Set()).length, 0, '本地有简易框架时安装普通同作者模组也不能误报冲突');
        const realFrameworkConflicts = market.detectModInstallationConflicts(null, ordinaryActions, localProfiles, new Set());
        assert.equal(realFrameworkConflicts.length, 1, '同批次存在真实本地秋枫框架时必须保留框架互斥警告');
        assert.equal(realFrameworkConflicts[0].incomingMod.name, '简易框架', '冲突必须准确归因于简易框架，不能归因于同作者普通模组');
        assert.equal(realFrameworkConflicts[0].localConflictMod.rawName, 'maplebirch', '警告必须指向真实本地秋枫框架');
        const [mapleGroup, simpleGroup] = market.KNOWN_MOD_CONFLICT_RULES[0].conflictingGroups;
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' }, mapleGroup), true, '仅给出完整秋枫框架仓库时仍须匹配权威身份');
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework' }, simpleGroup), true, '仅给出完整简易框架仓库时仍须匹配权威身份');
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: longerCombat.githubUrl }, mapleGroup), false, '仓库回退必须匹配完整身份，不能只匹配作者名');

        // 14.5 场景 5：纯英文技术名模组（无中文 nickName）必须能自动映射为中文友好名称，且建议文本去除重复的“建议”
        const englishOnlyProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch' },
                displayNames: ['maplebirch']
            }
        ];
        const enConflicts = market.detectModInstallationConflicts(targetMod, candidateActions, englishOnlyProfiles, new Set());
        assert.equal(enConflicts.length, 1, '英文标识模组必须能正常匹配冲突');
        assert.equal(enConflicts[0].localConflictMod.name, '秋枫白桦框架', '无中文属性的英文技术模组必须回退映射为冲突组中文名称');
        assert.equal(enConflicts[0].localConflictMod.rawName, 'maplebirch', '底层原始名称必须保留为 maplebirch 用于接口调用');
        assert.ok(!enConflicts[0].advice.startsWith('建议'), '建议正文开头严禁带有重复的「建议」二字');

        // 14.6 场景 6：启用冲突卡片中必须渲染快捷禁用按钮
        const enHtml = market.formatConflictWarningHtml(enConflicts);
        assert.ok(enHtml.includes('dol-opt-conflict-disable-btn'), '启用的冲突模组卡片中必须包含快捷禁用按钮');
        assert.ok(enHtml.includes('data-conflict-raw="maplebirch"'), '快捷禁用按钮必须携带底层原始名称');
        assert.ok(enHtml.includes('快捷禁用【秋枫白桦框架】'), '快捷禁用按钮必须呈现中文友好名称');

        // 14.7 场景 7：findDependentModsForConflict 依赖影响深度评估
        const depTestProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch' }
            },
            {
                name: 'CustomStoryMod',
                bootJson: {
                    name: 'CustomStoryMod',
                    nickName: { chs: '自制剧情模组' },
                    version: '1.2.0',
                    dependenceInfo: [{ modName: 'maplebirch', version: '^1.0.0' }]
                }
            },
            {
                name: 'CustomClothMod',
                bootJson: {
                    name: 'CustomClothMod',
                    nickName: { chs: '自制服装模组' },
                    version: '2.0.1',
                    addonPlugin: [{ modName: 'scml-dol-maplebirchframework', addonName: 'cloth' }]
                }
            },
            {
                name: 'IndependentMod',
                bootJson: {
                    name: 'IndependentMod',
                    nickName: { chs: '独立无依赖模组' }
                }
            },
            {
                name: 'DisabledDependentMod',
                bootJson: {
                    name: 'DisabledDependentMod',
                    nickName: { chs: '已禁用的下游模组' },
                    dependenceInfo: [{ modName: 'maplebirch' }]
                }
            }
        ];
        const testDisabledNames = new Set(['disableddependentmod']);
        const affected = market.findDependentModsForConflict('maplebirch', depTestProfiles, testDisabledNames);
        assert.equal(affected.length, 2, '必须准确找出 2 个依赖于 maplebirch 的已启用模组');
        const affectedNames = affected.map(a => a.name);
        assert.ok(affectedNames.includes('自制剧情模组'), '必须包含自制剧情模组');
        assert.ok(affectedNames.includes('自制服装模组'), '必须包含自制服装模组');
        assert.ok(!affectedNames.includes('独立无依赖模组'), '绝不能包含无依赖的独立模组');
        assert.ok(!affectedNames.includes('已禁用的下游模组'), '已被禁用的模组不能作为受影响活跃项混淆提示');

        // 14.8 场景 8：样式表必须包含二次确认高亮警告框与快捷禁用按钮样式
        assert.ok(cssContent.includes('.dol-opt-modal-conflict-alert-box'), 'CSS 必须定义二次确认的高亮警示盒样式');
        assert.ok(cssContent.includes('.dol-opt-conflict-disable-btn'), 'CSS 必须定义冲突卡片快捷禁用按钮样式');
    }

    // -------------------------------------------------------------------------
    // 15. 模组管理页启用冲突检测、删除受影响模组评估与简易框架别名契约
    // -------------------------------------------------------------------------
    {
        const manager = loadManager();

        // 15.1 契约 1：Simple Frameworks 别名映射与副标题必须准确解析为【简易框架】，严禁误判为【秋枫白桦框架】
        const sfSubtext = manager.dolOptGetModSubtext('Simple Frameworks', {
            name: 'Simple Frameworks',
            bootJson: { name: 'Simple Frameworks', version: '2.0.5' }
        }, false);
        assert.equal(sfSubtext, '简易框架', 'Simple Frameworks 必须准确映射为【简易框架】');

        const sfWithS = manager.dolOptGetModSubtext('SimpleFrameworks', null, false);
        assert.equal(sfWithS, '简易框架', 'SimpleFrameworks 必须准确映射为【简易框架】');

        // 15.2 契约 2：市场端源码中二次确认弹窗的确认按钮文本必须为【继续安装】
        const marketJs = fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8');
        assert.ok(marketJs.includes("confirmText: '继续安装'"), '市场冲突二次确认弹窗的确认按钮文本必须为【继续安装】');

        // 15.3 契约 3：模组管理页启用冲突检测引擎 dolOptCheckEnableConflicts
        assert.equal(typeof manager.dolOptCheckEnableConflicts, 'function', '必须导出 dolOptCheckEnableConflicts');
        const activeMods = [
            { name: 'maplebirch', enabled: true },
            { name: 'IndependentMod', enabled: true }
        ];
        // 待启用简易框架
        const conflictDetected = manager.dolOptCheckEnableConflicts('Simple Frameworks', activeMods);
        assert.ok(conflictDetected, '当已启用秋枫白桦时，启用 Simple Frameworks 必须检出互斥冲突');
        assert.equal(conflictDetected.ruleId, 'maplebirch-vs-simpleframework');
        assert.ok(conflictDetected.targetDisplayName.includes('简易框架') || conflictDetected.targetDisplayName === 'Simple Frameworks');
        assert.ok(conflictDetected.conflictDisplayName.includes('秋枫白桦') || conflictDetected.conflictDisplayName === 'maplebirch');

        // 反向检测：当已启用简易框架时，启用秋枫白桦同样检出冲突
        const activeWithSF = [
            { name: 'Simple Frameworks', enabled: true }
        ];
        const reverseConflict = manager.dolOptCheckEnableConflicts('maplebirch', activeWithSF);
        assert.ok(reverseConflict, '当已启用简易框架时，启用秋枫白桦必须检出互斥冲突');

        // 无冲突场景：启用普通独立模组不触发冲突
        const noConflict = manager.dolOptCheckEnableConflicts('NormalMod', activeMods);
        assert.equal(noConflict, null, '普通独立模组启用时不应产生互斥冲突');

        // 15.4 契约 4：模组删除时的下游受影响模组评估 dolOptFindDependentMods
        assert.equal(typeof manager.dolOptFindDependentMods, 'function', '必须导出 dolOptFindDependentMods');
        manager._dolOptModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'StoryModA', enabled: true },
                { name: 'ClothModB', enabled: false },
                { name: 'StandaloneMod', enabled: true }
            ]
        };
        // 模拟 modInfo
        const mockModInfoMap = new Map([
            ['maplebirch', { name: 'maplebirch', bootJson: { name: 'maplebirch', version: '5.0.4', nickName: { chs: '秋枫白桦框架' } } }],
            ['storymoda', { name: 'StoryModA', bootJson: { name: 'StoryModA', version: '1.2.0', dependenceInfo: [{ modName: 'maplebirch' }] } }],
            ['clothmodb', { name: 'ClothModB', bootJson: { name: 'ClothModB', version: '1.0.0', dependenceInfo: [{ modName: 'Maplebirch' }] } }],
            ['standalonemod', { name: 'StandaloneMod', bootJson: { name: 'StandaloneMod', version: '1.0.0' } }]
        ]);
        const oldGetModInfo = manager.dolOptGetModInfo;
        manager.dolOptGetModInfo = name => mockModInfoMap.get(String(name).toLowerCase()) || null;

        const depResult = await manager.dolOptFindDependentMods('maplebirch');
        assert.equal(depResult.length, 2, '必须找出 2 个依赖 maplebirch 的下游模组');
        const depNames = depResult.map(d => d.rawName);
        assert.ok(depNames.includes('StoryModA'), '受影响列表必须包含 StoryModA');
        assert.ok(depNames.includes('ClothModB'), '受影响列表必须包含 ClothModB');
        assert.ok(!depNames.includes('StandaloneMod'), '受影响列表绝不能包含 StandaloneMod');

        // 15.5 契约 5：dolOptToggleSideMod 启用冲突拦截确认
        let confirmCallArgs = null;
        manager.dolOptConfirm = async (opts) => {
            confirmCallArgs = opts;
            return false; // 模拟玩家点击【暂不启用】
        };
        manager._dolOptModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'Simple Frameworks', enabled: false }
            ],
            sideEnabled: ['maplebirch'],
            sideDisabled: ['Simple Frameworks']
        };
        const toggleResult = await manager.dolOptToggleSideMod('Simple Frameworks', true);
        assert.equal(toggleResult, false, '玩家取消启用时必须返回 false 且中断启用流程');
        assert.ok(confirmCallArgs, '必须弹出冲突确认弹窗');
        assert.equal(confirmCallArgs.title, '模组冲突风险确认');
        assert.equal(confirmCallArgs.confirmText, '继续启用');
        assert.equal(confirmCallArgs.cancelText, '暂不启用');
        assert.equal(confirmCallArgs.confirmDelay, 5, '冲突启用弹窗必须设置 5 秒倒计时');
        assert.equal(manager._dolOptModState.sideMods.find(m => m.name === 'Simple Frameworks').enabled, false, '未确认前保持禁用状态');
        assert.ok(confirmCallArgs.trustedMessageHtml.includes('dol-opt-conflict-disable-btn'), '模组管理启用冲突弹窗必须包含快捷禁用按钮');
        assert.ok(confirmCallArgs.trustedMessageHtml.includes('快捷禁用【秋枫白桦框架】'), '模组管理启用冲突弹窗快捷禁用按钮必须呈现中文友好名称');
        assert.equal(typeof confirmCallArgs.onRender, 'function', '冲突启用弹窗必须提供 onRender 钩子以支持快捷禁用交互');

        // 15.6 契约 6：市场安装弹窗中前置依赖与主按钮文案必须统一为【一键安装】
        assert.ok(marketJs.includes('默认勾选一键安装，可取消勾选'), '市场前置依赖提示文案必须为默认勾选一键安装');
        assert.ok(marketJs.includes('一键安装（含'), '市场安装确认按钮文本必须包含一键安装');

        // 15.7 契约 7：dolOptDeleteSideMod 删除被依赖模组时的下游警示弹窗
        let deleteConfirmArgs = null;
        manager.dolOptConfirm = async (opts) => {
            deleteConfirmArgs = opts;
            return false; // 模拟取消删除
        };
        manager._dolOptModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'StoryModA', enabled: true }
            ],
            sideEnabled: ['maplebirch', 'StoryModA'],
            sideDisabled: []
        };
        manager.dolOptGetModInfo = name => mockModInfoMap.get(String(name).toLowerCase()) || null;
        const deleteResult = await manager.dolOptDeleteSideMod('maplebirch');
        assert.equal(deleteResult, undefined, '取消删除时必须中断流程');
        assert.ok(deleteConfirmArgs, '删除具有下游依赖的模组必须触发确认弹窗');
        assert.equal(deleteConfirmArgs.title, '确认删除模组（存在依赖警告）');
        assert.ok(deleteConfirmArgs.message.includes('StoryModA'), '删除提示文本中必须包含依赖它的下游模组');
        assert.equal(deleteConfirmArgs.confirmDelay, 5, '存在依赖警告的删除弹窗必须设置 5 秒倒计时');

        // 恢复 mock
        manager.dolOptGetModInfo = oldGetModInfo;
    }

    // 16. 需求回归与缺陷修复验证测试
    {
        const manager = loadManager();
        const market = loadMarket().dolModMarket;
        // 16.1 契约 1：前置依赖与冲突卡片标题去除 (1) 数字
        const testDepPlan = {
            requirements: [{ mod: { name: 'DepA' }, dependency: { id: 'DepA', version: '1.0.0' } }],
            actions: [{ type: 'install', mod: { name: 'DepA' } }]
        };
        const depHtml = market.formatDependencyListHtml(testDepPlan);
        assert.ok(depHtml.includes('<strong class="dol-opt-install-dependencies-title">前置依赖</strong>'), '前置依赖标题必须为干净的【前置依赖】');
        assert.ok(!depHtml.includes('前置依赖（'), '前置依赖标题绝不能包含括号数字标记');

        const testConflicts = [{
            incomingMod: { name: 'ModX' },
            localConflictMod: { name: 'ModY', rawName: 'ModY', isEnabled: true },
            reason: '测试冲突原因',
            advice: '测试冲突建议'
        }];
        const conflictHtml = market.formatConflictWarningHtml(testConflicts);
        assert.ok(conflictHtml.includes('<strong class="dol-opt-conflict-heading red">检测到已知模组冲突</strong>'), '冲突卡片标题必须为干净的【检测到已知模组冲突】');
        assert.ok(!conflictHtml.includes('已知模组冲突（'), '冲突卡片标题绝不能包含括号数字标记');

        // 16.2 契约 2：对手冲突组别名隔离与防误诊（解决 CustomHair 误归秋枫白桦）
        const oldGetModInfo = manager.dolOptGetModInfo;
        const testModInfoMap = new Map([
            ['maplebirch', {
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'], // 诱发误判的关键污染源
                    version: '5.0.4'
                }
            }],
            ['customhair', {
                bootJson: {
                    name: 'CustomHair',
                    dependenceInfo: [{ modName: 'Simple Frameworks' }],
                    version: '1.2.0'
                }
            }],
            ['maplemod', {
                bootJson: {
                    name: 'MapleMod',
                    dependenceInfo: [{ modName: 'maplebirch' }],
                    version: '1.0.0'
                }
            }],
            ['simpleframework', {
                bootJson: {
                    name: 'simpleframework',
                    version: '1.0.0'
                }
            }]
        ]);

        manager.dolOptGetModInfo = name => testModInfoMap.get(String(name).toLowerCase()) || null;
        manager._dolOptModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'CustomHair', enabled: true },
                { name: 'MapleMod', enabled: true },
                { name: 'simpleframework', enabled: false }
            ],
            sideEnabled: ['maplebirch', 'CustomHair', 'MapleMod'],
            sideDisabled: ['simpleframework']
        };

        const mapleDeps = await manager.dolOptFindDependentMods('maplebirch');
        const mapleDepNames = mapleDeps.map(m => m.name || m.rawName);
        assert.ok(mapleDepNames.includes('MapleMod'), '依赖 maplebirch 的 MapleMod 必须被识别出来');
        assert.ok(!mapleDepNames.includes('CustomHair'), '依赖 Simple Frameworks 的 CustomHair 绝不能被归入 maplebirch 的下游！');

        const simpleDeps = await manager.dolOptFindDependentMods('Simple Frameworks');
        const simpleDepNames = simpleDeps.map(m => m.name || m.rawName);
        assert.ok(simpleDepNames.includes('CustomHair'), '依赖 Simple Frameworks 的 CustomHair 必须属于 Simple Frameworks 的下游');
        assert.ok(!simpleDepNames.includes('MapleMod'), '依赖 maplebirch 的 MapleMod 绝不能属于 Simple Frameworks 的下游');

        // 测试 market 端的 findDependentModsForConflict 对手隔离
        const mockProfiles = [
            { name: 'maplebirch', rawName: 'maplebirch', bootJson: testModInfoMap.get('maplebirch').bootJson },
            { name: 'CustomHair', rawName: 'CustomHair', bootJson: testModInfoMap.get('customhair').bootJson },
            { name: 'MapleMod', rawName: 'MapleMod', bootJson: testModInfoMap.get('maplemod').bootJson }
        ];
        const marketAffected = market.findDependentModsForConflict('maplebirch', mockProfiles, new Set());
        const marketAffectedNames = marketAffected.map(m => m.name || m.rawName);
        assert.ok(marketAffectedNames.includes('MapleMod'), '市场端冲突检测中 MapleMod 属于 maplebirch 下游');
        assert.ok(!marketAffectedNames.includes('CustomHair'), '市场端冲突检测中 CustomHair 绝不能误归 maplebirch 下游');

        manager.dolOptGetModInfo = oldGetModInfo;

        // 16.3 契约 3：核心框架判断与重启建议强化
        assert.equal(manager.dolOptIsFrameworkMod('maplebirch'), true, 'maplebirch 必须被判定为核心框架');
        assert.equal(manager.dolOptIsFrameworkMod('秋枫白桦框架'), true, '秋枫白桦框架 必须被判定为核心框架');
        assert.equal(manager.dolOptIsFrameworkMod('Simple Frameworks'), true, 'Simple Frameworks 必须被判定为核心框架');
        assert.equal(manager.dolOptIsFrameworkMod('SomeCustomFrameworkMod'), true, '名称包含 framework 的模组必须被识别为框架');
        assert.equal(manager.dolOptIsFrameworkMod('普通发型美化'), false, '普通模组绝不能被识别为框架');

        let reloadConfirmArgs = null;
        manager.dolOptConfirm = async (opts) => {
            reloadConfirmArgs = opts;
            return false;
        };
        // 恢复真实 window.dolOptOfferReload 实现进行断言验证
        const optCode = fs.readFileSync(path.join(__dirname, 'javascript', 'modloader-optimization.js'), 'utf8');
        const offerReloadMatch = optCode.match(/window\.dolOptOfferReload = async function\([\s\S]*?\n\};/);
        assert.ok(offerReloadMatch, '源码中必须定义真实的 window.dolOptOfferReload');
        vm.runInContext(offerReloadMatch[0], manager);

        await manager.dolOptOfferReload('测试框架已更改', { isFramework: true });
        assert.ok(reloadConfirmArgs, '必须调用确认弹窗');
        assert.equal(reloadConfirmArgs.title, '重新载入游戏（强烈建议）', '核心框架变更必须使用【重新载入游戏（强烈建议）】标题');
        assert.equal(reloadConfirmArgs.confirmText, '立即重新载入', '核心框架变更确认按钮必须为【立即重新载入】');
        assert.equal(reloadConfirmArgs.cancelText, '稍后重载', '核心框架变更取消按钮必须为【稍后重载】');
        assert.equal(reloadConfirmArgs.confirmType, 'danger', '核心框架变更确认弹窗必须为高风险醒目类型');
        assert.ok(reloadConfirmArgs.trustedMessageHtml.includes('强烈建议立即重新载入'), '提示内容中必须包含强烈建议字样');

        // 16.4 契约 4：移动端左侧关闭按钮识别与样式支持
        assert.equal(manager.dolOptIsCloseButton('Close'), true, 'Close 必须被识别为移动端关闭按钮');
        assert.equal(manager.dolOptIsCloseButton('关闭'), true, '关闭 必须被识别为移动端关闭按钮');
        assert.equal(manager.dolOptIsCloseButton('關閉'), true, '關閉 必须被识别为移动端关闭按钮');
        assert.equal(manager.dolOptIsCloseButton('模组管理'), false, '普通 Tab 绝不能被识别为关闭按钮');
        assert.equal(manager.dolOptIsCloseButton({ textContent: 'Close' }), true, 'DOM 元素节点文本为 Close 时必须识别为关闭按钮');

        const tweeContent = fs.readFileSync(path.join(__dirname, 'twee/modloader/modloader.twee'), 'utf8');
        assert.ok(tweeContent.includes('dolOptInitOverlayTabs'), 'modloader.twee 必须通过外部函数 dolOptInitOverlayTabs 初始化顶栏');
        assert.ok(!tweeContent.includes('var isClose ='), 'modloader.twee 绝不能内联复杂函数，杜绝 SugarCube Unexpected token 报错');

        const managerJs = fs.readFileSync(path.join(__dirname, 'javascript/modloader-optimization.js'), 'utf8');
        assert.ok(managerJs.includes('dol-opt-mobile-close-tab'), 'modloader-optimization.js 必须赋予移动端关闭按钮专属类名');
        assert.ok(managerJs.includes('dol-opt-has-mobile-close'), 'modloader-optimization.js 必须为容器添加 dol-opt-has-mobile-close 类名');

        const cssContent = fs.readFileSync(path.join(__dirname, 'stylesheet/modloader-optimization.css'), 'utf8');
        assert.ok(cssContent.includes('.dol-opt-mobile-close-tab'), 'CSS 中必须包含移动端关闭按钮样式定义');
        assert.ok(cssContent.includes('.dol-opt-has-mobile-close'), 'CSS 中必须包含带有移动端关闭按钮时的容器留白样式');

        // 16.5 契约 5：连续安装/多步骤下载过程中不弹出重启提示打断，全部完成后统一弹窗
        const marketJs = fs.readFileSync(path.join(__dirname, 'javascript/dol-mod-market.js'), 'utf8');
        assert.ok(marketJs.includes('skipReloadOffer: options.skipReloadOffer'), 'downloadAndInstallMod 必须透传 skipReloadOffer 到底层');
        assert.ok(marketJs.includes('await window.dolOptToggleSideMod(action.local.name, true, { silentOfferReload: true })'), '多步骤计划中启用前置必须静默处理，严禁中途弹出重载提醒');
        assert.ok(marketJs.includes('skipReloadOffer: true'), '多步骤计划与批量更新中下载安装必须显式声明 skipReloadOffer: true');
        assert.ok(managerJs.includes('(!options || !options.skipReloadOffer)'), 'dolOptHandleAddMod 必须尊重 skipReloadOffer 守护，杜绝擅自提前弹窗');
        assert.ok(managerJs.includes('if (!options?.keepCurrentTab)'), 'dolOptHandleAddMod 必须在非 keepCurrentTab 模式下才允许跳转页签');

        // 16.6 契约 6：列表禁用模组必须执行下游依赖排查，且 Toast 不再包含冗余的原排序字样
        assert.ok(managerJs.includes('!targetEnable && !options.skipConfirm'), 'dolOptToggleSideMod 必须在禁用前检查是否需二次确认');
        assert.ok(managerJs.includes('window.dolOptFindDependentMods(modName)'), 'dolOptToggleSideMod 必须调用 dolOptFindDependentMods 排查下游受影响模组');
        assert.ok(!managerJs.includes('（原排序保持不变）'), 'Toast 提示中严禁残留（原排序保持不变）冗余文字');
        assert.ok(marketJs.includes('{ silentOfferReload: true, skipConfirm: true }'), '市场快捷禁用必须传入 skipConfirm: true 杜绝二次弹窗');

        // 16.7 契约 7：简易框架与秋枫白桦互斥组仲裁引擎与防别名污染
        // 模拟运行环境中 ModLoader 别名重定向导致 dolOptGetModInfo('Simple Frameworks') 返回 maplebirch 信息，
        // 且其 subtext 为【秋枫白桦框架】的极端污染场景
        const conflictModInfoMap = new Map([
            ['maplebirch', {
                name: 'maplebirch',
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'],
                    version: '5.0.4',
                    nickName: { chs: '秋枫白桦框架' }
                }
            }],
            ['simple frameworks', {
                name: 'maplebirch', // ModLoader 别名映射返回了 maplebirch
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'],
                    version: '5.0.4',
                    nickName: { chs: '秋枫白桦框架' }
                }
            }],
            ['simpleframework', {
                name: 'simpleframework',
                bootJson: {
                    name: 'simpleframework',
                    version: '1.0.0'
                }
            }]
        ]);
        manager.dolOptGetModInfo = name => conflictModInfoMap.get(String(name).toLowerCase()) || null;

        // 场景 A：当前已启用 maplebirch，准备启用 Simple Frameworks
        const activeMaplebirch = [
            { name: 'maplebirch', enabled: true },
            { name: 'SomeOtherMod', enabled: true }
        ];
        const sfConflict = manager.dolOptCheckEnableConflicts('Simple Frameworks', activeMaplebirch);
        assert.ok(sfConflict, '当已启用 maplebirch 时，启用 Simple Frameworks 必须检出互斥冲突');
        assert.equal(sfConflict.targetDisplayName, '简易框架', '待启用模组展示名称必须锁定为【简易框架】，绝不能被 maplebirch 别名污染为秋枫白桦！');
        assert.equal(sfConflict.conflictDisplayName, '秋枫白桦框架', '已启用冲突模组展示名称必须为【秋枫白桦框架】');
        assert.notEqual(sfConflict.targetDisplayName, sfConflict.conflictDisplayName, '待启用与已冲突模组展示名称绝不能相同！');
        assert.equal(sfConflict.targetRawName, 'Simple Frameworks', '待启用原始名称必须为 Simple Frameworks');
        assert.equal(sfConflict.conflictRawName, 'maplebirch', '已冲突原始名称必须为 maplebirch');

        // 场景 B：当前已启用 Simple Frameworks，准备启用 maplebirch
        const activeSimple = [
            { name: 'Simple Frameworks', enabled: true }
        ];
        const mbConflict = manager.dolOptCheckEnableConflicts('maplebirch', activeSimple);
        assert.ok(mbConflict, '当已启用 Simple Frameworks 时，启用 maplebirch 必须检出互斥冲突');
        assert.equal(mbConflict.targetDisplayName, '秋枫白桦框架', '待启用模组必须为秋枫白桦框架');
        assert.equal(mbConflict.conflictDisplayName, '简易框架', '冲突模组必须为简易框架');

        // 场景 C：同组内不产生虚假互斥冲突（同为简易框架组）
        const activeSameGroup = [
            { name: 'simpleframework', enabled: true }
        ];
        const sameGroupConflict = manager.dolOptCheckEnableConflicts('Simple Frameworks', activeSameGroup);
        assert.equal(sameGroupConflict, null, '同属于简易框架组的模组绝不能自身跟自身产生互斥冲突');

        // 恢复 getModInfo
        manager.dolOptGetModInfo = oldGetModInfo;

        // 16.8 契约 8：ModHub 市场分类归类为【界面与便利】与身份库契约
        const catalogData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod-identities.json'), 'utf8'));
        const modhubIdentity = catalogData.mods.find(m => m.id === 'modhub');
        assert.ok(modhubIdentity, 'mod-identities.json 必须收录 modhub 身份');
        assert.equal(modhubIdentity.category, '界面与便利', 'ModHub 在身份库中分类必须为【界面与便利】');
        assert.ok(Array.isArray(modhubIdentity.bootNames) && modhubIdentity.bootNames.includes('ModHub'), 'modhub 必须包含 bootNames: ModHub');

        // 测试市场端的分类自动推导逻辑
        assert.equal(typeof market.deriveClassification, 'function', '市场必须导出 deriveClassification');
        const hubClassified1 = market.deriveClassification('ModHub模组管理中心', '用于在游戏内管理、排序和更新模组的管理套件');
        assert.equal(hubClassified1.category, '界面与便利', 'ModHub模组管理中心 必须归入【界面与便利】分类');
        assert.ok(hubClassified1.tags.includes('管理'), 'ModHub 标签必须包含【管理】');

        const hubClassified2 = market.deriveClassification('ModHub', '游戏内模组中心');
        assert.equal(hubClassified2.category, '界面与便利', 'ModHub 必须归入【界面与便利】分类');

        const hubClassified3 = market.deriveClassification('dol-mod-hub', 'Mod Manager');
        assert.equal(hubClassified3.category, '界面与便利', '包含 mod-hub 的仓库模组必须归入【界面与便利】分类');
    }

    /* =========================================================================
     * 17. 批量计划与队列：使用真实公开接口验证依赖、版本与执行结果
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const makeMod = (id, dependencies = [], version = '1.0.0') => ({
            id, identityId: id, name: id, dependencies, version,
            githubUrl: `https://github.com/ModHubTests/${id}`
        });
        const key = mod => market.getMarketModKey(mod);
        const shared = makeMod('SharedFixture');
        const middle = makeMod('MiddleFixture', [{ id: shared.id }]);
        const alpha = makeMod('AlphaFixture', [{ id: middle.id }]);
        const beta = makeMod('BetaFixture', [{ id: shared.id }]);
        const independent = makeMod('IndependentFixture');
        const catalog = [alpha, beta, middle, shared, independent];
        const build = (targets, mods = catalog, profiles = [], disabled = new Set(), skipped = new Set(), releases = new Map(), excluded = new Map()) =>
            market.buildBatchInstallPlan(targets, mods, profiles, disabled, skipped, releases, excluded);
        const plainKeys = plan => Array.from(plan.actions, action => action.key);
        const plan = build([alpha, beta, independent]);
        assert.deepEqual(plainKeys(plan), [shared, middle, alpha, beta, independent].map(key), '共享前置只安装一次，递归前置必须先于使用它的目标');
        assert.equal(plan.blocked.size, 0, '完整依赖链不得被阻断');
        assert.ok(plan.dependencies.get(key(alpha)).has(key(middle)), '计划保留直接依赖边用于失败传播');
        assert.deepEqual(Array.from(plan.requirements.find(req => req.key === key(shared)).requiredBy).sort(), [alpha.name, beta.name].sort(), '共享前置说明必须列出全部受影响目标');

        const targetAndDependency = build([alpha, shared, shared], catalog, [], new Set(), new Set([key(shared)]));
        assert.equal(targetAndDependency.targets.length, 2, '重复目标按稳定身份合并');
        assert.equal(targetAndDependency.actions.filter(action => action.key === key(shared)).length, 1, '所选目标同时作为前置时只处理一次');
        assert.equal(targetAndDependency.requirements.find(req => req.key === key(shared)).skipped, false, '顶层目标不能通过取消前置间接跳过');

        const skippedPlan = build([alpha, beta], catalog, [], new Set(), new Set([key(shared)]));
        assert.deepEqual(plainKeys(skippedPlan), [middle, alpha, beta].map(key), '显式取消共享前置后仍保留使用它的目标');
        assert.ok(!skippedPlan.dependencies.get(key(middle)).has(key(shared)), '显式取消前置不得留下会传播执行失败的依赖边');
        assert.equal(skippedPlan.blocked.size, 0, '显式取消前置代表玩家自行处理');

        const incompatibleShared = makeMod('VersionFixture', [], '2.0.0');
        const oldConsumer = makeMod('OldConsumerFixture', [{ id: incompatibleShared.id, version: '^1.0.0' }]);
        const newConsumer = makeMod('NewConsumerFixture', [{ id: incompatibleShared.id, version: '^2.0.0' }]);
        const versionCatalog = [oldConsumer, newConsumer, incompatibleShared, independent];
        const versionPlan = build([oldConsumer, newConsumer, independent], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.ok(versionPlan.blocked.has(key(oldConsumer)) && versionPlan.blocked.has(key(newConsumer)), '共享前置的最终版本不能满足全部要求时，整组受影响目标必须跳过');
        assert.deepEqual(plainKeys(versionPlan), [key(independent)], '版本冲突不能阻止独立目标');
        assert.ok(versionPlan.allActions.some(action => action.key === key(newConsumer)), '版本冲突分支仍须预读实际发布信息，不能只凭市场摘要阻断');
        const structurallyBroken = makeMod('BrokenVersionFixture', [{ id: incompatibleShared.id, version: '^2.0.0' }, { id: 'MissingVersionDependency' }]);
        const viableVersionPlan = build([structurallyBroken, oldConsumer], [structurallyBroken, oldConsumer, incompatibleShared], [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.equal(viableVersionPlan.blocked.size, 1, '缺失前置的分支不得推动共享框架升级并连带阻断其他目标');
        assert.ok(viableVersionPlan.blocked.has(key(structurallyBroken)), '结构缺失分支仍需准确报告不可执行');
        assert.deepEqual(plainKeys(viableVersionPlan), [key(oldConsumer)], '独立目标应复用已满足的本地框架版本继续安装');
        const singleVersionPlan = build([newConsumer], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.equal(singleVersionPlan.actions[0].type, 'update', '本地版本不满足而新发布版本满足时必须更新前置');
        const actualVersionPlan = build([newConsumer], versionCatalog, [], new Set(), new Set(), new Map([[key(incompatibleShared), { version: '1.5.0' }]]));
        assert.ok(actualVersionPlan.blocked.has(key(newConsumer)), '版本校验必须采用实际选择的发布版本');

        const missing = makeMod('MissingConsumerFixture', [{ id: 'AbsentFixture' }]);
        const unavailable = { ...makeMod('ExternalFixture'), githubUrl: '', otherUrl: 'https://example.com/download' };
        const externalConsumer = makeMod('ExternalConsumerFixture', [{ id: unavailable.id }]);
        const cycleA = makeMod('CycleAlphaFixture', [{ id: 'CycleBetaFixture' }]);
        const cycleB = makeMod('CycleBetaFixture', [{ id: cycleA.id }]);
        const brokenPlan = build([missing, externalConsumer, cycleA, independent], [missing, unavailable, externalConsumer, cycleA, cycleB, independent]);
        assert.equal(brokenPlan.blocked.size, 3, '缺失、外部下载和循环依赖只阻断对应目标');
        assert.equal(brokenPlan.cycles.length, 2, '循环依赖报告必须包含循环上的各项');
        assert.deepEqual(plainKeys(brokenPlan), [key(independent)], '不可执行分支不得残留多余安装任务');
        const excludedPlan = build([alpha, beta, independent], catalog, [], new Set(), new Set(), new Map(), new Map([[key(shared), '已取消选择发布包']]));
        assert.equal(excludedPlan.blocked.size, 2, '取消共享前置选包必须跳过全部下游');

        const attempted = [];
        const executed = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {},
            confirm: async () => true,
            install: async action => { attempted.push(action.key); return action.key !== key(shared); }
        });
        assert.deepEqual(attempted, [key(shared), key(independent)], '前置失败必须阻断所有下游，同时继续独立分支');
        assert.equal(executed.results.get(key(shared)).status, 'failed', '实际失败必须记为失败');
        for (const mod of [middle, alpha, beta]) assert.equal(executed.results.get(key(mod)).status, 'skipped', '前置失败的后续模组必须记为跳过');
        assert.equal(executed.results.get(key(independent)).status, 'success', '独立项目必须成功完成');
        assert.deepEqual(Array.from(executed.changedMods), [independent.name], '只有成功产生的配置变更计入重载集合');

        const explicitSkipResult = await market.executeBatchInstallPlan(skippedPlan, { refresh: async () => {}, install: async () => true });
        assert.ok([alpha, beta].every(mod => explicitSkipResult.results.get(key(mod)).status === 'success'), '显式取消前置不会作为失败阻断目标');
        const duplicateCalls = [];
        await market.executeBatchInstallPlan(targetAndDependency, { refresh: async () => {}, install: async action => { duplicateCalls.push(action.key); return true; } });
        assert.equal(duplicateCalls.filter(value => value === key(shared)).length, 1, '目标兼前置在执行队列中只能导入一次');

        let stopped = false;
        const stopCalls = [];
        const stopResult = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {}, shouldStop: () => stopped,
            install: async action => { stopCalls.push(action.key); stopped = true; return true; }
        });
        assert.deepEqual(stopCalls, [key(shared)], '停止后续应保留当前安装成功并停止剩余队列');
        assert.equal(stopResult.results.get(key(shared)).status, 'success', '停止不撤销当前已完成安装');
        assert.ok([alpha, beta, independent].every(mod => stopResult.results.get(key(mod)).status === 'skipped'), '停止后的目标统一标记跳过');

        let refreshes = 0;
        let conflictInstalls = 0;
        const denied = await market.executeBatchInstallPlan(plan, {
            refresh: async () => { refreshes++; },
            confirm: async () => false,
            install: async () => { conflictInstalls++; return true; }
        });
        assert.equal(refreshes, 1, '执行前必须重新读取状态再进行冲突确认');
        assert.equal(conflictInstalls, 0, '取消冲突风险确认不得开始安装');
        assert.ok(Array.from(denied.results.values()).every(result => result.status === 'skipped'), '取消风险确认后剩余队列全部跳过');

        const enablePlan = build([beta], catalog, [{ name: shared.name, version: '1.0.0' }], new Set([shared.name]));
        assert.equal(enablePlan.actions[0].type, 'enable', '已安装但禁用的前置必须加入启用操作');
        sb._dolOptModState = { sideMods: [{ name: shared.name, enabled: false }], sideDisabled: [shared.name] };
        const failedEnable = await market.executeBatchInstallPlan(enablePlan, { refresh: async () => {}, enable: async () => false, install: async () => true });
        assert.equal(failedEnable.results.get(key(shared)).status, 'failed', '启用返回 false 且仍禁用时不能假报成功');
        assert.equal(failedEnable.results.get(key(beta)).status, 'skipped', '前置启用失败必须阻断目标');
        const unverifiedEnable = await market.executeBatchInstallPlan(enablePlan, { refresh: async () => {}, enable: async () => true, install: async () => true });
        assert.equal(unverifiedEnable.results.get(key(shared)).status, 'failed', '启用接口返回 true 但实际仍禁用时也不能假报成功');
        assert.equal(unverifiedEnable.results.get(key(beta)).status, 'skipped', '实际启用状态未确认前不能继续下游');
        const alreadyEnabled = await market.executeBatchInstallPlan(enablePlan, {
            refresh: async () => {}, install: async () => true,
            enable: async () => { sb._dolOptModState.sideMods[0].enabled = true; return false; }
        });
        assert.equal(alreadyEnabled.results.get(key(shared)).status, 'success', '接口返回 false 但实际已启用时不得误判前置失败');
        assert.equal(alreadyEnabled.results.get(key(beta)).status, 'success', '已核实前置启用后才能继续下游');
        assert.ok(!alreadyEnabled.changedMods.has(shared.name), '本次未执行的启用变更不能重复计数');

        const disabledUpdatePlan = build([newConsumer], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }], new Set([incompatibleShared.name]));
        const updateAction = disabledUpdatePlan.actions[0];
        assert.equal(updateAction.type, 'update', '禁用前置版本过低时仍需先更新');
        assert.equal(updateAction.enableAfter, true, '更新禁用前置必须标记更新后核实启用');
        sb._dolOptModState = { sideMods: [{ name: incompatibleShared.name, enabled: false }], sideDisabled: [incompatibleShared.name] };
        const updateSteps = [];
        const failedUpdateEnable = await market.executeBatchInstallPlan(disabledUpdatePlan, {
            refresh: async () => {},
            install: async action => { updateSteps.push(`安装:${action.key}`); return true; },
            enable: async action => { updateSteps.push(`启用:${action.key}`); return false; }
        });
        assert.deepEqual(updateSteps, [`安装:${key(incompatibleShared)}`, `启用:${key(incompatibleShared)}`], '更新成功但仍禁用时必须调用启用，失败后不能继续目标');
        assert.equal(failedUpdateEnable.results.get(key(incompatibleShared)).status, 'failed', '更新完成但启用失败的前置应整体记为未完成');
        assert.equal(failedUpdateEnable.results.get(key(newConsumer)).status, 'skipped', '前置更新后的启用失败也必须阻断下游');
        assert.ok(failedUpdateEnable.changedMods.has(incompatibleShared.name), '启用失败不能抹掉已完成更新，仍需汇总实际配置变更');
        const verifiedUpdateEnable = await market.executeBatchInstallPlan(disabledUpdatePlan, {
            refresh: async () => {}, install: async () => true,
            enable: async () => { sb._dolOptModState.sideMods[0].enabled = true; return true; }
        });
        assert.equal(verifiedUpdateEnable.results.get(key(newConsumer)).status, 'success', '更新并实际启用前置后才能安装目标');

        let unpreparedDownloads = 0;
        sb.dolOptGetGui = () => { unpreparedDownloads++; return {}; };
        const missingRelease = await market.executeBatchInstallPlan(build([independent]), { refresh: async () => {}, releaseInfos: new Map() });
        assert.equal(unpreparedDownloads, 0, '计划变化产生的未预读操作不得直接进入下载器');
        assert.equal(missingRelease.results.get(key(independent)).status, 'failed', '缺少已确认发布信息必须拒绝执行');
        assert.ok(missingRelease.results.get(key(independent)).reason.includes('重新核对安装包'), '缺少发布信息要提示重新确认安装包');

        for (const [dependent, prerequisite, testCatalog] of [[beta, shared, catalog], [newConsumer, incompatibleShared, versionCatalog]]) {
            const local = [{ name: prerequisite.name, version: '1.0.0' }];
            const disabledNames = new Set([prerequisite.name]);
            let currentPlan = build([dependent, independent], testCatalog, local, disabledNames);
            const originalPlan = currentPlan;
            const calls = [];
            const revised = await market.executeBatchInstallPlan(originalPlan, {
                refresh: async () => {}, getPlan: () => currentPlan,
                confirm: async (_plan, action) => {
                    if (action.key === key(prerequisite)) currentPlan = build([dependent, independent], testCatalog, local, disabledNames, new Set([key(prerequisite)]));
                    return true;
                },
                enable: async action => { calls.push(`启用:${action.key}`); return true; },
                install: async action => { calls.push(action.key); return true; }
            });
            assert.deepEqual(calls, [key(dependent), key(independent)], '确认期间移除旧启用或更新动作后不得继续执行，明确取消前置后的下游和独立项继续');
            assert.equal(revised.results.get(key(prerequisite)).status, 'skipped', '从当前计划移除的旧动作必须标记跳过');
            assert.equal(revised.results.get(key(dependent)).status, 'success', '更新后的依赖图不能仍用旧边阻断明确取消前置的目标');
            assert.ok(!revised.changedMods.has(prerequisite.name), '被取消的更新或启用不能被计入实际变更');
        }

        const exceptionResult = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {}, install: async action => { if (action.key === key(shared)) throw new Error('模拟校验失败'); return true; }
        });
        assert.equal(exceptionResult.results.get(key(shared)).reason, '模拟校验失败', '校验与下载异常必须保留真实原因');
        assert.equal(exceptionResult.results.get(key(independent)).status, 'success', '异常不能中断独立分支');
    }

    /* =========================================================================
     * 18. 批量选择：身份、准入、重绘、刷新与清空
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const available = { id: 'selection-alpha', name: '选择甲', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/SelectionAlpha' };
        const another = { id: 'selection-beta', name: '选择乙', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/SelectionBeta' };
        const external = { id: 'selection-external', name: '外部下载', otherUrl: 'https://example.com/mod' };
        const dead = { id: 'selection-dead', name: '失效来源', githubUrl: 'https://github.com/ModHubTests/DeadFixture', _isDeadRepo: true };
        assert.equal(market.isBatchInstallEligible(available, []), true, '未安装且支持页面内安装的模组可以多选');
        assert.equal(market.isBatchInstallEligible(available, [{ name: available.name, version: '1.0.0' }]), false, '已安装模组不可多选');
        assert.equal(market.isBatchInstallEligible(external, []), false, '仅外部下载项不可多选');
        assert.equal(market.isBatchInstallEligible(dead, []), false, '失效来源不可多选');
        assert.equal(market.getMarketModKey({ ...available, identityId: 'StableIdentity', name: '新名称' }), 'stableidentity', '身份优先于可变名称');
        let currentMods = [available, another, external];
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: currentMods }) });
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected(market.getMarketModKey(available), true);
        market.setBatchModSelected(market.getMarketModKey(external), true);
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-alpha'], '非法下载项不能通过公共选择入口加入');
        market.filterInstalledOnly();
        market.selectAllVisibleMods();
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-alpha'], '筛选与重绘不能丢失已选项，全选仅增加当前可选项');
        market.resetFilters();
        market.selectAllVisibleMods();
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected).sort(), ['selection-alpha', 'selection-beta'], '全选当前筛选仅加入自动安装项');
        currentMods = [another, external];
        await market.loadMarketData(true);
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-beta'], '刷新目录后清除已不存在的选择');
        market.clearBatchSelection();
        assert.equal(market.getBatchSelectionState().selected.length, 0, '清空选择必须移除全部勾选');
        market.setBatchModSelected('selection-beta', true);
        market.toggleBatchSelection(false);
        assert.equal(market.getBatchSelectionState().selecting, false, '退出多选恢复普通安装模式');
        assert.equal(market.getBatchSelectionState().selected.length, 0, '退出多选必须清空勾选');
        market.setBatchModSelected('selection-beta', true);
        assert.equal(market.getBatchSelectionState().selected.length, 0, '普通安装模式不能通过过期事件增加选择');
    }

    /* =========================================================================
     * 19. 批量冲突：目标、前置、本地及动态二次确认
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const maple = { id: 'maplebirch', name: '秋枫白桦框架' };
        const simple = { id: 'simple-framework', name: '简易框架' };
        const action = (mod, role = '目标模组', type = 'install') => ({ mod, role, type });
        for (const roles of [['目标模组', '目标模组'], ['目标模组', '前置依赖'], ['前置依赖', '前置依赖']]) {
            const conflicts = market.detectModInstallationConflicts(null, [action(maple, roles[0]), action(simple, roles[1])], [], new Set());
            assert.equal(conflicts.length, 1, '目标与前置的任意批次内部互斥组合都必须检出');
            assert.equal(conflicts[0].localConflictMod.isIncoming, true, '内部互斥不能伪装成本地项');
            const html = market.formatConflictWarningHtml(conflicts);
            assert.ok(html.includes('安装项间互斥'), '内部冲突必须明确标记安装项间互斥');
            assert.ok(!html.includes('dol-opt-conflict-disable-btn'), '批次内部项不能展示无效快捷禁用按钮');
        }
        const local = { name: 'maplebirch', version: '1.0.0', displayNames: ['maplebirch', '秋枫白桦框架'] };
        const enableAction = { ...action(maple, '前置依赖', 'enable'), local };
        const reenabled = market.detectModInstallationConflicts(null, [action(simple), enableAction], [local], new Set(['maplebirch']));
        assert.equal(reenabled.length, 1, '禁用项重新进入启用计划时只显示一次真实冲突');
        assert.equal(reenabled[0].localConflictMod.isIncoming, true, '本地禁用项即将重新启用时必须视为内部活跃冲突');
        assert.ok(!market.formatConflictWarningHtml(reenabled).includes('检查通过'), '快捷禁用不能掩盖计划内重新启用的冲突');
        const unchecked = market.detectModInstallationConflicts(null, [action(simple)], [local], new Set(['maplebirch']));
        assert.equal(unchecked[0].localConflictMod.isEnabled, false, '取消重新启用后才能识别为当前禁用');
        assert.ok(market.formatConflictWarningHtml(unchecked).includes('检查通过'), '取消冲突前置后实时恢复安全提示');
        const deduped = market.detectModInstallationConflicts(null, [action(simple), { ...enableAction, type: 'update' }, enableAction], [], new Set());
        assert.equal(deduped.length, 1, '同一模组的更新与启用不得重复显示互斥');

        let confirmations = 0;
        sb.dolOptConfirm = async options => {
            confirmations++;
            assert.equal(options.confirmDelay, 5, '批量与单装冲突必须共用 5 秒倒计时');
            assert.equal(options.confirmText, '继续安装', '风险按钮必须明确表示继续安装');
            assert.ok(options.trustedMessageHtml.includes('安装项间互斥'), '二次确认必须展示内部互斥明细');
            return false;
        };
        const activePlan = { targetMod: null, actions: [action(maple), action(simple)] };
        assert.equal(await market.confirmInstallConflicts(() => activePlan), false, '取消二次确认必须终止批量安装');
        assert.equal(confirmations, 1, '取消后不能重复弹出风险提示');
        sb.dolOptConfirm = async () => true;
        assert.equal(await market.confirmInstallConflicts(() => activePlan), true, '玩家明确确认后可继续处理冲突批次');
        sb.dolOptConfirm = async () => { throw new Error('无冲突时不应弹窗'); };
        assert.equal(await market.confirmInstallConflicts(() => ({ targetMod: null, actions: [action(simple)] })), true, '无活跃冲突不应要求额外确认');

        let dynamicActions = [action(maple), action(simple)];
        let dynamicConfirmations = 0;
        sb.dolOptConfirm = async options => {
            assert.equal(options.confirmDelay, 5, '新增风险同样需要完整倒计时');
            dynamicConfirmations++;
            if (dynamicConfirmations === 1) {
                dynamicActions = [...dynamicActions, action({ id: 'extra-maple', name: 'maplebirch' })];
                return true;
            }
            return false;
        };
        assert.equal(await market.confirmInstallConflicts(() => ({ targetMod: null, actions: dynamicActions })), false, '确认期间新增互斥不能沿用旧确认结果');
        assert.equal(dynamicConfirmations, 2, '新增冲突必须重新展示并等待确认');

        let riskVisible = true;
        let restoredRiskConfirmations = 0;
        let clearedDelays = 0;
        sb.dolOptConfirm = async options => {
            restoredRiskConfirmations++;
            assert.equal(options.confirmDelay, 5, '已解除倒计时的风险重新出现后必须重新等待 5 秒');
            if (restoredRiskConfirmations > 1) return false;
            riskVisible = false;
            const dialog = createStubElement();
            dialog.dolOptClearDelay = () => { clearedDelays++; };
            options.onRender(dialog);
            riskVisible = true;
            return true;
        };
        const restored = await market.confirmInstallConflicts(() => ({ targetMod: null, actions: riskVisible ? [action(maple), action(simple)] : [action(simple)] }));
        assert.equal(clearedDelays, 1, '冲突临时排除时会解除当前倒计时');
        assert.equal(restoredRiskConfirmations, 2, '同一冲突重新出现不能复用已经解锁的风险确认');
        assert.equal(restored, false, '重新出现的风险必须尊重第二次取消');
    }

    /* =========================================================================
     * 20. 批量下载的真实导入结果与浏览器线路限制
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const mod = { id: 'download-fixture', name: '下载检查项', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/DownloadFixture' };
        const releaseInfo = { version: '1.0.0', assetName: 'DownloadFixture.zip', assetUrl: `${mod.githubUrl}/releases/download/v1.0.0/DownloadFixture.zip` };
        sb.dolOptGetGui = () => ({});
        sb.dolOptShowToast = () => {};
        sb.dolOptConfirm = async () => { throw new Error('批量下载不得弹出逐项提示'); };
        let failureReason = '';
        const options = { releaseInfo, batchMode: true, askRestart: false, skipReloadOffer: true, onFailure: reason => { failureReason = reason; } };
        assert.equal(await market.downloadAndInstallMod(mod, 'github', options), false, '浏览器直连下载不能统计为批量安装成功');
        assert.ok(failureReason.includes('手动下载'), '不支持页面内导入的线路必须返回明确原因');
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { ...options, releaseInfo: { version: '1.0.0' } }), false, '无可用安装包必须返回失败');
        assert.ok(failureReason.includes('发布包'), '无包失败必须进入结果汇总');
        sb.Blob = Blob;
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob(['安装包测试数据']) });
        const importedOptions = [];
        sb.dolOptHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return false; };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), false, '导入器明确失败不能被下载成功覆盖');
        sb.dolOptHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return undefined; };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), false, '导入器无成功返回值不能算批量成功');
        sb.dolOptHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return true; };
        sb._dolOptModState = { sideMods: [{ name: mod.name, enabled: true }] };
        sb.dolOptGetModInfo = () => ({ bootJson: { name: mod.name, version: mod.version } });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), true, '下载并得到导入器确认后才统计成功');
        assert.equal(importedOptions.length, 3, '每项安装只应调用一次导入器');
        for (const installOptions of importedOptions) {
            assert.equal(installOptions.keepCurrentTab, true, '批量导入必须保持市场页签');
            assert.equal(installOptions.askRestart, false, '批量导入必须关闭逐项重载确认');
            assert.equal(installOptions.skipReloadOffer, true, '批量导入必须关闭框架逐项重载提示');
        }
    }

    /* =========================================================================
     * 21. 批量准备期间的重复提交与市场安装互斥锁
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const mod = { id: 'lock-fixture', name: '互斥锁检查项', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/LockFixture' };
        let releaseReads = 0;
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
            releaseReads++;
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'LockFixture.zip', browser_download_url: `${mod.githubUrl}/releases/download/v1.0.0/LockFixture.zip` }] }) };
        };
        const warnings = [];
        sb.dolOptShowToast = (message, type) => { if (type === 'warning') warnings.push(message); };
        sb.dolOptEscapeHtml = text => String(text);
        sb.dolOptConfirm = async () => false;
        sb.dolOptAlert = async () => {};
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected('lock-fixture', true);
        let releasePreparation;
        sb.dolOptLoadModManageState = async () => new Promise(resolve => { releasePreparation = resolve; });
        const pendingBatch = market.installSelectedMods();
        assert.equal(market.getBatchSelectionState().running, true, '读取安装清单前就必须锁定批量状态');
        assert.equal(await market.installSelectedMods(), false, '准备阶段重复点击不得发起第二个批次');
        assert.equal(await market.promptDownloadMirrorAndInstall(mod), false, '批量准备阶段不能并行启动单项安装');
        assert.equal(await market.updateAllMods(), false, '批量准备阶段不能并行启动全部更新');
        assert.equal(warnings.length, 3, '被拒绝的入口应明确提示已有任务');
        market.clearBatchSelection();
        market.toggleBatchSelection(false);
        assert.equal(market.getBatchSelectionState().selected.length, 1, '执行期间旧事件不能清空当前批次选择');
        releasePreparation();
        assert.equal(await pendingBatch, false, '取消总确认必须安全退出');
        assert.equal(releaseReads, 1, '重复提交不得重复读取发布信息');
        assert.equal(market.getBatchSelectionState().running, false, '取消后必须释放运行状态');
        assert.equal(market.getBatchSelectionState().selected.length, 1, '取消安装应保留未完成选择供重试');
        let externalOpened = '';
        sb.open = url => { externalOpened = url; };
        const external = { name: '单装回归项', otherUrl: 'https://example.com/manual' };
        assert.equal(await market.promptDownloadMirrorAndInstall(external), true, '取消批量后单项入口必须恢复，原外部下载流程保持兼容');
        assert.equal(externalOpened, external.otherUrl, '单装外部链接仍由原流程打开');
    }

    /* =========================================================================
     * 22. 取消问题前置恢复分支后，补读发布包并重新确认
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const broken = { id: 'replan-broken', name: '问题前置', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/ReplanBroken', dependencies: [{ id: 'absent-replan' }] };
        const target = { id: 'replan-target', name: '恢复安装目标', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/ReplanTarget', dependencies: [{ id: broken.id }] };
        const events = [];
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [target, broken] }) };
            events.push('预读发布包');
            assert.ok(String(url).includes('/ReplanTarget/releases/latest'), '取消问题前置后只需为恢复的目标补读发布信息');
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: ['Replan-branch-a.zip', 'Replan-branch-b.zip'].map(name => ({ name, browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/${name}` })) }) };
        };
        sb.dolOptEscapeHtml = value => String(value);
        sb.dolOptShowToast = () => {};
        sb.dolOptAlert = async () => {};
        sb.dolOptLoadModManageState = async () => {};
        let totalConfirmations = 0;
        sb.dolOptConfirm = async options => {
            if (options.title === '批量安装确认') {
                totalConfirmations++;
                events.push(`总确认${totalConfirmations}`);
                if (totalConfirmations > 1) return false;
                const checkbox = createStubElement('input');
                Object.assign(checkbox, { name: 'dolOptBatchDependency', checked: true, dataset: { key: 'replan-broken' } });
                const area = createStubElement();
                area.querySelectorAll = selector => selector.includes('dolOptBatchDependency') ? [checkbox] : [];
                const dialog = createStubElement();
                dialog.querySelector = () => area;
                options.onRender(dialog);
                checkbox.checked = false;
                checkbox.onchange();
                return true;
            }
            assert.equal(options.title, `选择【${target.name}】的安装包`, '重新规划后的多个发布包仍须由玩家选择');
            events.push('手选安装包');
            assert.equal(options.requireSelection, true, '兼容包不能绕过显式选择');
            return 'asset:1';
        };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected('replan-target', true);
        assert.equal(await market.installSelectedMods(), false, '补读后重新确认时仍可安全取消');
        assert.deepEqual(events, ['总确认1', '预读发布包', '手选安装包', '总确认2'], '恢复分支必须先补读真实发布、手选候选包，再重开总确认');
        assert.equal(market.getBatchSelectionState().selected.length, 1, '重规划后取消仍保留未完成目标');
    }

    /* =========================================================================
     * 23. 批量确认区分真正满足的前置，并优先展示冲突警告
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const makeMod = (id, version = '1.0.0', dependencies = []) => ({ id, name: id, version, dependencies, githubUrl: `https://github.com/ModHubTests/${id}` });
        const satisfied = makeMod('SatisfiedFixture');
        const disabled = makeMod('DisabledFixture');
        const outdated = makeMod('OutdatedFixture', '2.0.0');
        const absent = makeMod('AbsentFixture');
        const blockedOld = makeMod('BlockedOldFixture', '2.0.0');
        const target = makeMod('SatisfiedConsumerFixture', '1.0.0', [
            { id: satisfied.id, version: '^1.0.0' }, { id: disabled.id }, { id: outdated.id, version: '^2.0.0' }, { id: absent.id }
        ]);
        const blockedTarget = makeMod('BlockedSatisfiedConsumerFixture', '1.0.0', [{ id: blockedOld.id, version: '^2.0.0' }, { id: 'unknown-required-fixture' }]);
        const simple = { ...makeMod('simple-framework'), name: '简易框架' };
        const maple = { ...makeMod('maplebirch'), name: '秋枫白桦框架' };
        const mods = [target, blockedTarget, satisfied, disabled, outdated, absent, blockedOld, simple, maple];
        const profiles = [satisfied, disabled, outdated, blockedOld].map(mod => ({ name: mod.name, version: '1.0.0' }));
        const plan = market.buildBatchInstallPlan([target, blockedTarget], mods, profiles, new Set([disabled.name]));
        const requirement = mod => plan.requirements.find(item => item.key === market.getMarketModKey(mod));
        assert.equal(requirement(satisfied).satisfied, true, '已安装、启用且版本满足全部约束的前置应标记已满足');
        for (const mod of [disabled, outdated, absent, blockedOld]) {
            assert.equal(requirement(mod).satisfied, false, '禁用、版本不足、未安装或因分支阻塞移除操作的前置都不能误标已满足');
        }
        assert.ok(!plan.actions.some(action => action.key === market.getMarketModKey(blockedOld)), '本用例必须覆盖动作已移除但本地版本仍不满足的分支');

        sb._dolOptModState = { sideMods: profiles.map(profile => ({ name: profile.name, enabled: profile.name !== disabled.name })), sideDisabled: [disabled.name] };
        sb.dolOptGetModInfo = name => ({ bootJson: profiles.find(profile => profile.name === name) });
        sb.dolOptLoadModManageState = async () => {};
        sb.dolOptEscapeHtml = value => String(value);
        sb.dolOptShowToast = () => {};
        sb.dolOptAlert = async () => {};
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods }) };
            const mod = mods.find(item => String(url).includes(`/${item.id}/releases/latest`));
            assert.ok(mod, '确认页测试只能预读模拟目录中的发布包');
            return { ok: true, json: async () => ({ tag_name: `v${mod.version}`, assets: [{ name: `${mod.id}.zip`, browser_download_url: `${mod.githubUrl}/releases/download/v${mod.version}/${mod.id}.zip` }] }) };
        };
        let html = '';
        sb.dolOptConfirm = async options => { assert.equal(options.title, '批量安装确认'); html = options.trustedMessageHtml; return false; };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        for (const mod of [target, blockedTarget, simple, maple]) market.setBatchModSelected(market.getMarketModKey(mod), true);
        await market.installSelectedMods();
        assert.ok(html.includes('<div class="dol-opt-dep-item dol-opt-dep-satisfied">') && html.includes('<span class="green">已满足，无需下载</span>'), '真正满足的前置使用只读行和绿色的无需下载说明');
        const checkboxFor = mod => new RegExp(`<input\\b(?=[^>]*name="dolOptBatchDependency")(?=[^>]*data-key="${market.getMarketModKey(mod)}")[^>]*>`).test(html);
        assert.equal(checkboxFor(satisfied), false, '已满足前置不能出现需要勾选安装的控件');
        for (const mod of [disabled, outdated, absent, blockedOld]) assert.equal(checkboxFor(mod), true, '待启用、更新、安装与阻塞的前置仍保留处理复选框');
        assert.ok(html.indexOf('dol-opt-install-conflict-card') >= 0 && html.indexOf('dol-opt-install-conflict-card') < html.indexOf('所选目标'), '冲突警告必须位于所选目标列表之前');
        const targetListOffset = html.indexOf('dol-opt-batch-target-list');
        assert.ok(html.indexOf('dol-opt-install-conflict-card') < html.indexOf('前置依赖') && html.indexOf('前置依赖') < targetListOffset && targetListOffset < html.indexOf('dol-opt-batch-summary'), '确认页必须按冲突、前置、滚动目标列表、汇总的顺序展示');
        assert.ok(html.includes('dol-opt-batch-target-dependencies') && html.includes(`需要前置：${satisfied.name}（^1.0.0）`), '每项目标必须展示其直接前置名称与版本要求');
        assert.match(html, /<div>将串行处理 <strong class="gold">\d+ 项操作<\/strong>/, '操作数量必须明确高亮');
        assert.ok(html.includes('<div>下载线路：<strong class="gold">'), '下载线路必须独立成行并高亮');
    }

    /* =========================================================================
     * 24. 批量快捷禁用：实际成功才取消重新处理前置，取消与失败保持原计划
     * ========================================================================= */
    for (const mode of ['success', 'cancel', 'failed', 'unverified']) {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const maple = { id: 'maplebirch', name: '秋枫白桦框架', version: '1.0.0', githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' };
        const simple = { id: 'simple-framework', name: '简易框架', version: '1.0.0', githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework' };
        const target = { id: 'disable-consumer', name: '本批框架使用者', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/DisableConsumer', dependencies: [{ id: maple.id }] };
        const mods = [maple, simple, target];
        const localConsumerName = '本地框架使用者';
        sb._dolOptModState = { sideMods: [{ name: maple.id, enabled: true }, { name: localConsumerName, enabled: true }], sideDisabled: [] };
        sb.dolOptGetModInfo = name => ({ bootJson: { name, version: '1.0.0', ...(name === localConsumerName ? { dependenceInfo: [{ modName: maple.id }] } : {}) } });
        let refreshCount = 0;
        sb.dolOptLoadModManageState = async () => { refreshCount++; };
        sb.dolOptEscapeHtml = value => String(value);
        sb.dolOptShowToast = () => {};
        sb.dolOptAlert = async () => {};
        let reloadOffers = 0;
        sb.dolOptOfferReload = async () => { reloadOffers++; };
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods }) };
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'DisableConsumer.zip', browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/DisableConsumer.zip` }] }) };
        };
        let toggles = 0;
        sb.dolOptToggleSideMod = async (rawName, enabled) => {
            toggles++;
            assert.equal(rawName, maple.id, '快捷禁用必须使用真实本地名称');
            assert.equal(enabled, false, '快捷禁用不得意外启用框架');
            if (mode === 'success') {
                sb._dolOptModState.sideMods[0].enabled = false;
                sb._dolOptModState.sideDisabled = [maple.id];
            }
            return mode !== 'failed';
        };
        let refreshedHtml = '', impactHtml = '';
        sb.dolOptConfirm = async options => {
            if (options.title !== '批量安装确认') {
                assert.ok(options.title.includes('确认快捷禁用'), '快捷禁用应先提示其影响');
                assert.equal(options.confirmType, 'danger', '存在本地或本批依赖影响时必须使用危险确认');
                impactHtml = `${options.message || ''}${options.trustedMessageHtml || ''}`;
                return mode !== 'cancel';
            }
            const area = createStubElement();
            const button = createStubElement('button');
            button.dataset = { conflictRaw: maple.id, conflictName: maple.name };
            area.querySelectorAll = selector => selector === '.dol-opt-conflict-disable-btn' && area.innerHTML.includes('dol-opt-conflict-disable-btn') ? [button] : [];
            const dialog = createStubElement();
            dialog.querySelector = () => area;
            options.onRender(dialog);
            assert.equal(typeof button.onclick, 'function', '总确认中的实际快捷禁用按钮必须绑定处理流程');
            await button.onclick({ preventDefault() {}, stopPropagation() {} });
            refreshedHtml = area.innerHTML;
            return false;
        };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        for (const mod of [target, simple]) market.setBatchModSelected(market.getMarketModKey(mod), true);
        await market.installSelectedMods();
        assert.ok(impactHtml.includes(target.name) && impactHtml.includes(localConsumerName), '禁用确认必须同时说明本地与本批依赖该框架的模组');
        assert.ok(impactHtml.includes('dol-opt-modal-affected-box') && impactHtml.includes('本地受影响模组') && impactHtml.includes('本次安装受影响目标'), '本地与本批影响应分区突出呈现');
        assert.equal(toggles, mode === 'cancel' ? 0 : 1, '取消快捷禁用不得写入控制器，其余场景只尝试一次');
        assert.equal(refreshedHtml.includes('自行处理'), mode === 'success', '只有已核实禁用成功才把该前置改为自行处理，失败与取消不能偷改勾选');
        assert.equal(reloadOffers, mode === 'success' ? 1 : 0, '总确认取消后仍需为真实禁用变更提示一次重载，未变更不得提示');
        if (mode === 'success') assert.ok(refreshCount >= 2, '快捷禁用成功后必须重新读取持久化状态再宣告成功');
    }

    /* =========================================================================
     * 25. 单装确认不能越过仍在持久化的快捷禁用
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.dolModMarket;
        const framework = { id: 'maplebirch', name: '秋枫白桦框架', version: '1.0.0', githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' };
        const target = { id: 'simple-framework', name: '简易框架', version: '1.0.0', githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework', dependencies: [{ id: framework.id }] };
        sb._dolOptModState = { sideMods: [{ name: framework.id, enabled: true }], sideDisabled: [] };
        sb.dolOptGetModInfo = name => ({ bootJson: { name, version: '1.0.0' } });
        sb.dolOptLoadModManageState = async () => {};
        sb.dolOptEscapeHtml = value => String(value);
        sb.dolOptShowToast = () => {};
        sb.dolOptAlert = async () => {};
        sb.dolOptGetGui = () => ({});
        sb.Blob = Blob;
        let downloads = 0;
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [framework, target] }) };
            if (String(url).includes('/releases?')) return { ok: true, json: async () => [] };
            if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'SingleRace.zip', browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/SingleRace.zip` }] }) };
            downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () => new Blob(['单装测试包']) };
        };
        let finishPersistence, signalPersistenceStarted;
        const persistence = new Promise(resolve => { finishPersistence = resolve; });
        const persistenceStarted = new Promise(resolve => { signalPersistenceStarted = resolve; });
        const toggles = [];
        sb.dolOptToggleSideMod = async (name, enabled) => {
            toggles.push({ name, enabled });
            if (enabled) {
                sb._dolOptModState.sideMods[0].enabled = true;
                return true;
            }
            signalPersistenceStarted();
            await persistence;
            sb._dolOptModState.sideMods[0].enabled = false;
            sb._dolOptModState.sideDisabled = [framework.id];
            return true;
        };
        const installed = [];
        sb.dolOptHandleAddMod = async (_input, options) => {
            installed.push(options.displayName);
            sb._dolOptModState.sideMods.push({ name: 'SimpleFramework', enabled: true });
            return true;
        };
        let pendingDisable;
        sb.dolOptConfirm = async options => {
            if (options.title === `下载并安装【${target.name}】`) {
                const conflictArea = createStubElement();
                const button = createStubElement('button');
                button.dataset = { conflictRaw: framework.id, conflictName: framework.name };
                conflictArea.querySelectorAll = selector => selector === '.dol-opt-conflict-disable-btn' && conflictArea.innerHTML.includes('dol-opt-conflict-disable-btn') ? [button] : [];
                const dialog = createStubElement();
                const query = dialog.querySelector;
                dialog.querySelector = selector => selector === '#dolOptInstallConflictArea' ? conflictArea : query(selector);
                options.onRender(dialog);
                assert.equal(typeof button.onclick, 'function', '单装初次确认必须提供可执行的快捷禁用按钮');
                pendingDisable = button.onclick({ preventDefault() {}, stopPropagation() {} });
                // 模拟用户已确认禁用，在保存尚未结束时立即确认主安装弹窗。
                return { selectValue: '', selectedReqIndices: vm.runInContext('new Set([0])', sb) };
            }
            return true;
        };
        await market.loadMarketData(true);
        const pendingInstall = market.promptDownloadMirrorAndInstall(target);
        await persistenceStarted;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(downloads, 0, '快捷禁用尚未持久化时不能开始下载');
        assert.equal(installed.length, 0, '快捷禁用尚未持久化时不能开始导入');
        assert.equal(toggles.filter(item => item.enabled).length, 0, '保存期间不能执行旧计划中的启用操作');
        finishPersistence();
        await pendingDisable;
        assert.equal(await pendingInstall, true, '禁用核验完成后单装应继续安装目标');
        assert.deepEqual(installed, [target.name], '快捷禁用完成后只安装目标，不能重装已明确跳过的框架');
        assert.deepEqual(toggles, [{ name: framework.id, enabled: false }], '过期勾选快照不能覆盖禁用意图并重新启用框架');
        assert.equal(sb._dolOptModState.sideMods[0].enabled, false, '单装完成后被快捷禁用的框架必须保持禁用');
    }

    /* =========================================================================
     * 26. 尚未重载的新模组不得被运行时对手别名污染
     * ========================================================================= */
    {
        const createAliasFixture = (simpleInstalled = true) => {
            const maple = { name: 'maplebirch', bootJson: { name: 'maplebirch', version: '5.0.4', nickName: { chs: '秋枫白桦框架' }, alias: ['Simple Frameworks'], repository: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' } };
            const simpleBoot = { name: 'Simple Frameworks', version: '2.0.5', nickName: { chs: '简易框架' }, repository: 'https://github.com/emicoto/SCMLSimpleFramework' };
            const data = new Map([['maplebirch', new Uint8Array([1])], ...(simpleInstalled ? [['Simple Frameworks', new Uint8Array([2])]] : [])]);
            const controller = createMockController({ enabled: simpleInstalled ? ['Simple Frameworks'] : [], disabled: ['maplebirch'], zips: Array.from(data.keys()) });
            controller.checkModZipFileIndexDB = async bytes => bytes[0] === 2 ? simpleBoot : maple.bootJson;
            controller.addModIndexDB = async (name, bytes) => { data.set(name, bytes); controller.store.zips.add(name); if (!controller.store.enabled.includes(name)) controller.store.enabled.push(name); };
            const cache = [{ mod: maple }];
            const reads = [];
            const utils = {
                getModLoader: () => ({ getModCacheArray: () => cache, getIndexDBLoader: () => ({ customStore: {}, constructor: { calcModNameKey: name => name } }) }),
                getIdbKeyValRef: () => ({ get: async name => { reads.push(name); return data.get(name); } }),
                getAnyModByNameNoAlias: name => name === 'maplebirch' ? maple : null,
                getMod: name => ['maplebirch', 'Simple Frameworks'].includes(name) ? maple : null,
                getModList: () => [maple], getModListNameNoAlias: () => ['maplebirch']
            };
            const sb = loadManager({ modModLoadController: controller, modUtils: utils });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'javascript', 'dol-mod-market.js'), 'utf8'), sb);
            return { sb, controller, maple, simpleBoot, cache, reads, data, utils };
        };
        const fixture = createAliasFixture();
        const { sb, maple, simpleBoot, cache, reads, data, utils } = fixture;
        assert.equal(sb.dolOptGetModInfo('Simple Frameworks'), null, '尚未读取安装包时不得把运行时别名指向的秋枫当成简易框架');
        await sb.dolOptLoadModManageState(true);
        assert.ok(reads.includes('Simple Frameworks'), '已启用但尚未进入运行时的模组必须补读 IndexedDB 档案');
        const info = sb.dolOptGetModInfo('Simple Frameworks');
        assert.equal(info.bootJson.name, simpleBoot.name, '新安装模组必须返回其真实技术名');
        assert.equal(info.bootJson.version, '2.0.5', '管理页必须显示真实安装版本，不能借用秋枫的 5.0.4');
        assert.equal(sb.dolOptGetModSubtext('Simple Frameworks', info, false), '简易框架', '管理副标题必须来自真实简易框架档案');
        assert.equal(sb.dolOptGetModInfo(' simple frameworks ').bootJson.version, '2.0.5', '精确身份仍允许首尾空格与大小写差异');
        const profile = sb.dolModMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks');
        assert.equal(profile.version, '2.0.5', '市场本地版本不能被运行时对手别名污染');
        assert.ok(!profile.displayNames.includes('maplebirch') && !profile.displayNames.includes('秋枫白桦框架'), '简易框架的市场身份不能混入秋枫名称');
        assert.ok(!profile.repositoryKeys.includes('maplebirchleaf/scml-dol-maplebirchframework'), '简易框架不能携带秋枫仓库身份');
        const simpleMarket = { id: 'simple-framework', name: '简易框架', version: '2.0.6', githubUrl: simpleBoot.repository };
        assert.equal(sb.dolModMarket.checkModInstallStatus(simpleMarket, sb.dolModMarket.getLocalInstalledProfiles()), 'update_available', '市场必须依据真实 2.0.5 识别 2.0.6 更新，不能被错误 5.0.4 压住');
        assert.equal(sb.dolOptGetModInfo('maplebirch').bootJson.version, '5.0.4', '修复简易框架不能改写真实秋枫档案');

        const newer = { name: 'Simple Frameworks', bootJson: { ...simpleBoot, version: '2.0.7' } };
        cache.push({ mod: { name: 'Simple Frameworks', bootJson: simpleBoot } }, { mod: newer });
        assert.equal(sb.dolOptGetModInfo('Simple Frameworks'), newer, '最新的精确运行时档案仍优先于旧缓存与存储档案');
        cache.splice(1);
        const spoof = { name: 'Simple Frameworks', bootJson: maple.bootJson };
        cache.push({ mod: spoof });
        utils.getAnyModByNameNoAlias = () => spoof;
        assert.equal(sb.dolOptGetModInfo('Simple Frameworks').bootJson.name, simpleBoot.name, '即使包装层名称正确，也必须拒绝 boot.name 属于其他模组的缓存与无别名接口结果');
        cache.splice(1);
        utils.getAnyModByNameNoAlias = name => name === 'maplebirch' ? maple : null;
        data.set('WrongStorageKey', new Uint8Array([1]));
        assert.equal(await sb.dolOptLoadDisabledModInfo(['WrongStorageKey'], true), 0, '存储键与 boot.name 不一致时不能缓存错名档案');
        assert.equal(sb._dolOptDisabledModInfo.has('wrongstoragekey'), false, '错名安装包不能污染其他技术名的元数据缓存');
        sb._dolOptDisabledModInfo.set('simple frameworks', { name: 'Simple Frameworks', bootJson: maple.bootJson });
        assert.equal(sb.dolOptGetModInfo('Simple Frameworks'), null, '已有缓存也必须核验 boot.name，不能信任键名与外层 name');
        assert.equal(await sb.dolOptLoadDisabledModInfo(['Simple Frameworks'], false), 1, '非强制刷新也必须替换已有的错名缓存');
        assert.equal(sb.dolOptGetModInfo('Simple Frameworks').bootJson.version, '2.0.5', '错误缓存应通过精确存储档案恢复');
        sb._dolOptDisabledModInfo.delete('simple frameworks');
        const missingProfile = sb.dolModMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks');
        assert.equal(missingProfile.version, '', '精确档案暂缺时市场不得绕过校验再次 getMod 别名回退');
        assert.ok(!missingProfile.displayNames.includes('maplebirch'), '档案暂缺时保留未知状态，不能引入对手身份');

        const fresh = createAliasFixture(false);
        const installed = await fresh.sb.dolOptInstallModZip({ name: 'SimpleFramework.zip', arrayBuffer: async () => new Uint8Array([2]).buffer });
        assert.equal(installed.verified, true, '安装回退路径必须先确认真实落盘');
        assert.equal(fresh.sb.dolOptGetModInfo('Simple Frameworks').bootJson.version, '2.0.5', '直接安装完成后应立即缓存已核验 boot，无需等待重载或刷新');

        for (const mode of ['single', 'batch']) {
            const { sb: run, simpleBoot: boot } = createAliasFixture(false);
            const mod = { id: 'simple-framework', name: '简易框架', version: boot.version, githubUrl: boot.repository };
            run.Blob = Blob;
            run.dolOptConfirm = async () => true;
            run.dolOptAlert = async () => {};
            run.fetch = async url => {
                if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
                if (String(url).includes('/releases?')) return { ok: true, json: async () => [] };
                if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: `v${boot.version}`, assets: [{ name: 'SimpleFramework.zip', browser_download_url: `${mod.githubUrl}/releases/download/v${boot.version}/SimpleFramework.zip` }] }) };
                return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([2])]) };
            };
            run.dolOptHandleAddMod = async input => {
                for (const file of input.files || input) await run.dolOptInstallModZip(file);
                await run.dolOptLoadModManageState(true);
                return true;
            };
            await run.dolOptLoadModManageState(true);
            await run.dolModMarket.loadMarketData(true);
            if (mode === 'single') assert.equal(await run.dolModMarket.promptDownloadMirrorAndInstall(mod), true, '单装公开入口应完成真实存储写入');
            else {
                run.dolModMarket.toggleBatchSelection(true);
                run.dolModMarket.setBatchModSelected('simple-framework', true);
                const result = await run.dolModMarket.installSelectedMods();
                assert.equal(result.results.get('simple-framework').status, 'success', '批量公开入口应完成真实存储写入');
            }
            const installedInfo = run.dolOptGetModInfo('Simple Frameworks');
            assert.equal(installedInfo.bootJson.version, boot.version, '单装与批量安装在尚未重载时都必须展示真实版本');
            assert.equal(run.dolOptGetModSubtext('Simple Frameworks', installedInfo, false), '简易框架', '单装与批量都不能从旧运行时别名拿到秋枫副标题');
            assert.equal(run.dolModMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks').version, boot.version, '两条安装路径都必须向市场提供正确本地版本');
        }
    }

    // 市场导入前核对真实清单，任何包校验失败都不得调用写入接口。
    {
        const sb = loadMarket();
        sb.Blob = Blob;
        const mod = { name: '主模组显示名', bootNames: ['FixtureMain'], githubUrl: 'https://github.com/ModHubTests/PackageCheck' };
        const bootByByte = new Map([[1, { name: 'FixtureMain' }], [2, { name: 'FixtureResources' }]]);
        sb.dolOptGetGui = () => ({});
        sb.dolOptGetController = () => ({ checkModZipFileIndexDB: async data => bootByByte.get(data[0]) });
        sb.dolOptShowToast = () => {};
        const alerts = [];
        sb.dolOptAlert = async message => { alerts.push(message); };
        sb.dolOptConfirm = async () => { throw new Error('包内容校验失败不应弹出换线重试'); };
        let imports = 0;
        sb.dolOptHandleAddMod = async () => { imports++; return true; };
        sb._dolOptModState = { sideMods: [{ name: 'FixtureMain', enabled: true }] };
        sb.dolOptGetModInfo = () => ({ bootJson: { name: 'FixtureMain' } });
        let downloads = 0;
        sb.fetch = async url => {
            downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([String(url).includes('companion.zip') ? 2 : 1])]) };
        };
        let reason = '';
        const releaseInfo = { assets: ['main.zip', 'companion.zip'].map(name => ({ name, downloadUrl: `${mod.githubUrl}/releases/download/v1/${name}` })) };
        const options = { releaseInfo, batchMode: true, askRestart: false, onFailure: value => { reason = value; } };
        assert.equal(await sb.dolModMarket.downloadAndInstallMod(mod, 'ddlc', options), true, '可信主包与有效附属包应正常导入');
        assert.equal(imports, 1);

        bootByByte.set(1, { name: 'UnrelatedExtension' });
        assert.equal(await sb.dolModMarket.downloadAndInstallMod(mod, 'ddlc', { ...options, batchMode: false }), false, '主包身份错配必须在写入前阻止');
        assert.ok(reason.includes('UnrelatedExtension'));
        assert.equal(alerts.length, 1, '单项错误应直接说明实际包名');
        assert.equal(imports, 1, '不能写入不相关模组');
        assert.equal(downloads, 4, '内容错误不得触发换线反复下载');

        bootByByte.set(1, { name: 'FixtureMain' });
        bootByByte.set(2, false);
        assert.equal(await sb.dolModMarket.downloadAndInstallMod(mod, 'ddlc', options), false, '附属ZIP缺少清单也必须阻止整组导入');
        assert.ok(reason.includes('companion.zip'));
        assert.equal(imports, 1, '后续包无效时不能先写入主包');

        bootByByte.set(2, { name: 'FixtureResources' });
        bootByByte.set(1, { name: 'UnmappedTechnicalName' });
        assert.equal(await sb.dolModMarket.downloadAndInstallMod({ ...mod, bootNames: [], _matchedLocal: null }, 'ddlc', options), true, '未知中文显示名不得被猜测为技术名从而误拦有效包');
        assert.equal(imports, 2);
    }

    suiteComplete = true;
    console.log('ModHub v1.0.4 全部测试通过');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
