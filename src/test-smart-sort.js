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
    assert.equal(bootJson.version, '1.0.2', 'boot.json 版本号必须为 1.0.2');

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

    suiteComplete = true;
    console.log('ModHub v1.0.2 all tests PASSED!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
