// ModHub 测试共用沙箱与源码读取工具。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const srcRoot = path.join(__dirname, '..', 'src');
const bootJson = JSON.parse(fs.readFileSync(path.join(srcRoot, 'boot.json'), 'utf8'));

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

function loadScripts(sandbox, files = bootJson.scriptFileList) {
    for (const file of files) {
        const code = fs.readFileSync(path.join(srcRoot, file), 'utf8');
        // 每个文件使用独立作用域，避免共享顶层变量掩盖跨模块依赖遗漏。
        vm.runInContext(`(function() {\n${code}\n}).call(window);`, sandbox, { filename: file });
    }
}

function loadManager(overrides = {}) {
    const sandbox = createBaseSandbox(overrides);
    loadScripts(sandbox, bootJson.scriptFileList.filter(file => file !== 'javascript/modhub-market.js'));
    // 测试环境屏蔽重型 UI 刷新与提示，聚焦状态变迁
    sandbox.modHubRenderModManageUI = () => {};
    sandbox.modHubUpdateManagerStatus = () => {};
    sandbox.modHubOfferReload = async () => {};
    sandbox._toastLog = [];
    sandbox.modHubShowToast = (message, type) => { sandbox._toastLog.push({ message, type }); };
    return sandbox;
}

function loadMarket() {
    const sandbox = createBaseSandbox();
    loadScripts(sandbox, ['javascript/modhub-market.js']);
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

// 按实际加载顺序读取样式，覆盖跨文件的选择器与覆盖规则。
function readStyles() {
    return bootJson.styleFileList.map(file => fs.readFileSync(path.join(srcRoot, file), 'utf8')).join('\n');
}

module.exports = {
    assert, fs, path, vm, srcRoot,
    bootJson, readStyles, createStubElement, createDocumentStub, createBaseSandbox,
    loadScripts, loadManager, loadMarket, createMockController,
};
