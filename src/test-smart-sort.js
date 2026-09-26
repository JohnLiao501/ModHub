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
            { name: 'ModHub', version: '1.0.1' }
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

    suiteComplete = true;
    console.log('ModHub v1.0.1 all tests PASSED!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
