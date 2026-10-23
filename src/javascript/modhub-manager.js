const modHubTranslateManagerHtml = html => window.modHubTranslateHtml?.(html) ?? html;
/**
 * ModHub - 模组管理与公共入口
 * 提供模组导入、状态持久化、排序与操作协调，连接美化、说明及日志模块
 */

// 全局启动错误与控制台异常捕获器（捕获 ModLoader 未录入文本的严重依赖或运行时异常）
window._modHubStartupErrors = window._modHubStartupErrors || [];

if (typeof window !== 'undefined' && !window._modHubGlobalErrorHooked) {
    window._modHubGlobalErrorHooked = true;

    // 资源事件的字段通常不可枚举，逐项读取并防止失效对象的 getter 抛错。
    const modHubReadErrorField = (value, key) => {
        try { return value == null ? undefined : value[key]; } catch (_) { return undefined; }
    };
    const modHubGetResourceEvent = value => {
        const type = modHubReadErrorField(value, 'type');
        if (type !== 'error') return null;
        const targets = [modHubReadErrorField(value, 'target'), modHubReadErrorField(value, 'currentTarget')];
        for (const target of targets) {
            const rawTag = modHubReadErrorField(target, 'tagName');
            const tag = typeof rawTag === 'string' ? rawTag.toUpperCase() : '';
            if (!['IMG', 'SCRIPT', 'LINK'].includes(tag)) continue;
            const source = tag === 'LINK' ? modHubReadErrorField(target, 'href') :
                (tag === 'IMG' && modHubReadErrorField(target, 'currentSrc')) || modHubReadErrorField(target, 'src');
            let resourcePath = typeof source === 'string' ? source : '';
            if (/^data:/i.test(resourcePath)) {
                const mime = resourcePath.match(/^data:([a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64})(?:[;,]|$)/i)?.[1] || '';
                resourcePath = `data:${mime}（内联资源）`;
            } else if (/^blob:/i.test(resourcePath)) {
                resourcePath = 'blob:（临时资源）';
            }
            return { type, tag, source: resourcePath };
        }
        return null;
    };

    // 三种错误入口共用格式化，保留异常类型、调用堆栈及资源事件的目标路径。
    const modHubFormatError = value => {
        if (typeof value === 'string') return value;
        const resource = modHubGetResourceEvent(value);
        if (resource) return `资源加载失败: ${resource.tag} ${resource.type} ${resource.source || '（未提供资源路径）'}`;
        const message = modHubReadErrorField(value, 'message');
        if (typeof message === 'string') {
            const name = modHubReadErrorField(value, 'name');
            const summary = `${typeof name === 'string' && name ? name : 'Error'}: ${message}`;
            const rawStack = modHubReadErrorField(value, 'stack');
            const stack = typeof rawStack === 'string' ? rawStack : '';
            return stack.startsWith(summary) ? stack : [summary, stack].filter(Boolean).join('\n');
        }
        const type = modHubReadErrorField(value, 'type');
        if (typeof type === 'string' && (modHubReadErrorField(value, 'target') !== undefined ||
            typeof modHubReadErrorField(value, 'preventDefault') === 'function')) return `Event: ${type}`;
        try {
            return JSON.stringify(value) || '';
        } catch (_) {
            try { return String(value); } catch (_) { return '无法格式化的异常对象'; }
        }
    };

    // 1. 监听全局脚本未捕获错误
    window.addEventListener?.('error', (event) => {
        const msg = modHubReadErrorField(event, 'message');
        if (typeof msg === 'string' && msg && !msg.includes('ResizeObserver loop')) {
            const error = modHubReadErrorField(event, 'error');
            const stack = modHubReadErrorField(error, 'stack');
            const detail = typeof stack === 'string' && stack ? modHubFormatError(error) :
                `${msg} (${modHubReadErrorField(event, 'filename') || ''}:${modHubReadErrorField(event, 'lineno') || 0}:${modHubReadErrorField(event, 'colno') || 0})`;
            window._modHubStartupErrors.push(`[脚本异常] ${detail}`);
            window._modHubHasDetectedStartupError = true;
            window._modHubPendingAutoOpenErrorLog = true;
            if (typeof window.modHubCheckAndAutoOpenErrorLog === 'function' && typeof window.modHubIsGameStartupReady === 'function' && window.modHubIsGameStartupReady()) {
                window.modHubCheckAndAutoOpenErrorLog();
            }
        }
    });

    // 2. 监听未捕获的 Promise 拒绝
    window.addEventListener?.('unhandledrejection', (event) => {
        const reason = modHubFormatError(event?.reason ?? '');
        if (reason) {
            window._modHubStartupErrors.push(`[异步异常] ${reason}`);
            window._modHubHasDetectedStartupError = true;
            window._modHubPendingAutoOpenErrorLog = true;
            if (typeof window.modHubCheckAndAutoOpenErrorLog === 'function' && typeof window.modHubIsGameStartupReady === 'function' && window.modHubIsGameStartupReady()) {
                window.modHubCheckAndAutoOpenErrorLog();
            }
        }
    });

    // 3. 监控控制台 error 中的启动与依赖报错
    if (typeof console !== 'undefined' && console.error) {
        const origConsoleError = console.error;
        console.error = function(...args) {
            try {
                // 仅用消息和异常判断级别，模组档案中的 logError 等字段不是报错。
                const text = args.filter(value => typeof value === 'string' || typeof value?.message === 'string')
                    .map(modHubFormatError).join(' ');
                const textLower = text.toLowerCase();
                // 忽略预期内良性降级或无害提示，避免无错误时误报弹窗
                const isBenign = !text ||
                    textLower.includes('modlist.json') ||
                    textLower.includes('resizeobserver') ||
                    textLower.includes('webpack:') ||
                    textLower.includes('content security policy') ||
                    textLower.includes('duplicate name');

                if (!isBenign && (
                    text.includes('not satisfies') ||
                    text.includes('cannot find') ||
                    text.includes('ERR_') ||
                    text.includes('Error') ||
                    text.includes('Exception')
                )) {
                    window._modHubStartupErrors.push(`[控制台报错] ${args.map(modHubFormatError).join(' ')}`);
                    window._modHubHasDetectedStartupError = true;
                    window._modHubPendingAutoOpenErrorLog = true;
                    if (typeof window.modHubCheckAndAutoOpenErrorLog === 'function' && typeof window.modHubIsGameStartupReady === 'function' && window.modHubIsGameStartupReady()) {
                        setTimeout(() => window.modHubCheckAndAutoOpenErrorLog(), 50);
                    }
                }
            } catch (_) {}
            return origConsoleError.apply(this, args);
        };
    }
}

// 工具函数：获取 ModLoader Gui 实例
// 不同发行包可能保留 GUI 实例，也可能仅通过 modModLoadController 与 modUtils 暴露底层接口。
// 优先复用 GUI；缺少 GUI 时提供最小兼容代理，统一上层调用。
window.modHubGetGui = function() {
    const legacyGui = window.modLoaderGui || window.modLoaderGuiInstance || null;
    if (legacyGui) return legacyGui;

    // 仅有底层接口时构造最小化 GUI 代理对象
    const controller = window.modModLoadController ||
        (window.modSC2DataManager && typeof window.modSC2DataManager.getModLoadController === 'function'
            ? window.modSC2DataManager.getModLoadController() : null);
    const modUtils = window.modUtils ||
        (window.modSC2DataManager && typeof window.modSC2DataManager.getModUtils === 'function'
            ? window.modSC2DataManager.getModUtils() : null);
    if (!controller && !modUtils) return null;

    return {
        // 旁加载列表映射到 ModLoadController IndexedDB 直读接口
        listSideLoadModNameOnly: controller
            ? () => controller.listModIndexDB()
            : () => Promise.resolve([]),
        listSideLoadHiddenModNameOnly: controller
            ? () => controller.loadHiddenModList()
            : () => Promise.resolve([]),
        // gModUtils 直接映射到全局 modUtils
        gModUtils: modUtils,
        // modModLoadController 保留引用
        modModLoadController: controller,
        // modLoadSwitch 安全模式开关（兼容旧版操作逻辑）
        modLoadSwitch: modUtils?.getModLoadSwitch ? modUtils.getModLoadSwitch() : null,
        // 代理不提供 GUI 说明接口，由调用方的守卫选择包体读取路径
        getModTReadMe: null,
        // 模组导入由 modHubHandleAddMod 统一使用原生控制器处理
        loadAndAddMod: null,
    };
};

// 工具函数：获取 ModLoadController 实例（管理 IndexDB 旁加载模组增删改存）
window.modHubGetController = function() {
    const gui = window.modHubGetGui();
    return window.modModLoadController ||
           (window.modSC2DataManager && typeof window.modSC2DataManager.getModLoadController === 'function' ? window.modSC2DataManager.getModLoadController() : null) ||
           (gui && gui.modModLoadController) ||
           gui;
};

// 统一按模组技术名去重，保留首次出现的加载顺序
window.modHubUniqueModNames = function(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter(name => {
        if (typeof name !== 'string') return false;
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

window._modHubDisabledModInfo = window._modHubDisabledModInfo || new Map();
window._modHubBatchMode = false;
window._modHubSelectedMods = window._modHubSelectedMods || new Set();

const MODHUB_TABS = { manager: '模组管理', market: '模组市场', readme: '模组说明', log: '加载日志', help: '帮助中心' };
window.modHubGetTabId = function(value) {
    if (value?.dataset?.modhubTab) return value.dataset.modhubTab;
    const text = String(typeof value === 'string' ? value : value?.textContent || '').trim();
    return Object.keys(MODHUB_TABS).find(id => text === id || text.startsWith(MODHUB_TABS[id]) || text.startsWith(window.modHubT?.(MODHUB_TABS[id]) || MODHUB_TABS[id])) || '';
};
window.modHubIsManagerTabLabel = function(text) {
    const label = String(text || '').trim();
    return !!window.modHubGetTabId(label);
};

window.modHubIsCloseButton = function(elementOrText) {
    if (!elementOrText) return false;
    let text = '';
    let onclick = '';
    if (typeof elementOrText === 'string') {
        text = elementOrText.trim();
    } else if (elementOrText && (elementOrText.jquery || elementOrText.nodeType || elementOrText.textContent !== undefined)) {
        const el = elementOrText.jquery ? elementOrText[0] : elementOrText;
        text = String(el?.textContent || '').trim();
        onclick = String(el?.getAttribute?.('onclick') || el?.onclick || '');
    }
    if (['close', '关闭', '關閉'].includes(text.toLowerCase())) return true;
    if (onclick.includes('closeOverlay')) return true;
    return false;
};

// 模组管理器顶栏初始化，保留原生移动关闭选项对应的页签索引。
window.modHubInitOverlayTabs = function() {
    window.modHubEnsureStyles?.({ active: true });
    window.modHubBindReloadReminder();
    const tabRoot = document.querySelector?.('#overlayTabs.modhub-modloader-tabs');
    for (const button of tabRoot?.querySelectorAll('button') || []) {
        const id = window.modHubGetTabId(button);
        if (id) button.setAttribute('data-modhub-tab', id);
    }
    const title = document.getElementById?.('customOverlayTitle');
    window.modHubLocalizeOwned?.(title || tabRoot);
    window.modHubRefreshLanguageSelectors?.();
    window.modHubUpdateMarketTabBadge();
    if (typeof $ === 'undefined') return;
    var tabs = $("#overlayTabs.modhub-modloader-tabs");
    if (!tabs.length) return;
    var isClose = function($el) {
        if ($el.hasClass("customOverlayClose")) return true;
        if (typeof window.modHubIsCloseButton === 'function') {
            return window.modHubIsCloseButton($el);
        }
        var txt = $el.text().trim();
        return txt === 'Close' || txt === '关闭' || txt === '關閉' || ($el.attr('onclick') || '').indexOf('closeOverlay') !== -1;
    };
    var core = tabs.children("button").filter(function() {
        var $this = $(this);
        if (isClose($this)) {
            $this.addClass("modhub-mobile-close-tab");
            tabs.addClass("modhub-has-mobile-close");
            return true;
        }
        return typeof window.modHubIsManagerTabLabel === 'function' && window.modHubIsManagerTabLabel($this.text());
    });
    core.addClass("modhub-core-tab");
    if (core.not(".customOverlayClose, .modhub-mobile-close-tab").length >= 5) {
        tabs.addClass("modhub-tabs-ready");
    }
};

// 只取真实同名档案；getMod() 可能把兼容别名重定向到另一模组。
window.modHubGetModInfo = function(modName) {
    const gui = window.modHubGetGui();
    const utils = gui?.gModUtils;
    const key = String(modName || '').trim().toLowerCase();
    if (!key) return null;
    const isExact = mod => String(mod?.bootJson?.name || mod?.name || '').trim().toLowerCase() === key;
    let hasCache = false;
    try {
        const cache = utils?.getModLoader?.()?.getModCacheArray?.() ||
            window.modSC2DataManager?.getModLoader?.()?.getModCacheArray?.();
        hasCache = Array.isArray(cache);
        if (hasCache) {
            for (let i = cache.length - 1; i >= 0; i--) {
                const mod = cache[i]?.mod || cache[i];
                if (isExact(mod)) return mod;
            }
        }
    } catch (_) { hasCache = false; }
    const storedMod = window._modHubDisabledModInfo.get(key);
    if (isExact(storedMod)) return storedMod;
    // 现代缓存已包含全部运行时档案；未命中是正常可选查询，不再调用会记录错误的旧接口。
    if (hasCache) return null;
    try {
        const exactMod = utils?.getAnyModByNameNoAlias?.(modName);
        if (isExact(exactMod)) return exactMod;
    } catch (_) {}
    try {
        const legacyMod = utils?.getMod?.(modName);
        return isExact(legacyMod) ? legacyMod : null;
    } catch (_) { return null; }
};

// 只读真实旁加载仓库，不用运行档案或缓存代替已安装包。
window.modHubReadInstalledModPackage = async function(modName) {
    const name = typeof modName === 'string' ? modName : '';
    const result = { name, bootJson: null, data: null, error: null, missing: false };
    try {
        if (!name.trim()) throw new Error('模组技术名为空');
        const utils = window.modHubGetGui()?.gModUtils;
        const loader = utils?.getModLoader?.()?.getIndexDBLoader?.();
        const keyval = utils?.getIdbKeyValRef?.();
        const controller = window.modHubGetController();
        if (!loader?.customStore || typeof loader.constructor?.calcModNameKey !== 'function' ||
            typeof keyval?.get !== 'function' || typeof controller?.checkModZipFileIndexDB !== 'function') {
            throw new Error('当前 ModLoader 未提供已安装模组包读取接口');
        }
        const data = await keyval.get(loader.constructor.calcModNameKey(name), loader.customStore);
        if (!data) return { ...result, missing: true };
        const bootJson = await controller.checkModZipFileIndexDB(data);
        if (!bootJson || typeof bootJson !== 'object' || Array.isArray(bootJson)) {
            throw new Error('安装包未提供有效的 boot.json');
        }
        if (typeof bootJson.name !== 'string' || bootJson.name !== name) {
            throw new Error(`安装包技术名与登记名称【${name}】不一致`);
        }
        return { ...result, bootJson, data };
    } catch (error) {
        return { ...result, error: error instanceof Error ? error : new Error(String(error)) };
    }
};

window.modHubReadInstalledModBoot = async function(modName) {
    const { data, ...result } = await window.modHubReadInstalledModPackage(modName);
    return result;
};

// 禁用或刚安装尚未加载的模组，直接从 IndexedDB 安装包读取真实 boot.json。
window.modHubLoadDisabledModInfo = async function(modNames, refresh = false) {
    const gui = window.modHubGetGui();
    const names = window.modHubUniqueModNames(Array.isArray(modNames)
        ? modNames
        : (gui?.listSideLoadHiddenModNameOnly ? await gui.listSideLoadHiddenModNameOnly() : []));
    if (!names.length) return 0;

    const utils = gui?.gModUtils;
    const loader = utils?.getModLoader?.()?.getIndexDBLoader?.();
    const keyval = utils?.getIdbKeyValRef?.();
    const controller = window.modHubGetController();
    if (!loader?.customStore || typeof loader.constructor?.calcModNameKey !== 'function' ||
        typeof keyval?.get !== 'function' || typeof controller?.checkModZipFileIndexDB !== 'function') return 0;

    let loaded = 0;
    for (const name of names) {
        const key = name.trim().toLowerCase();
        const cached = window._modHubDisabledModInfo.get(key);
        if (!refresh && String(cached?.bootJson?.name || '').trim().toLowerCase() === key) continue;
        await window.modHubYieldToBrowser();
        const { bootJson, error } = await window.modHubReadInstalledModBoot(name);
        if (bootJson) {
            window._modHubDisabledModInfo.set(key, {
                name: bootJson.name || name,
                bootJson
            });
            loaded++;
        } else if (error) {
            console.warn(`[ModHub] 读取已禁用模组【${name}】档案失败`, error);
        }
    }
    return loaded;
};

// 工具函数：读取 ModLoader 在 IndexedDB 中持久化的启用 / 禁用列表真实记录
// 内存状态可能因并发操作或陈旧快照与存储不一致，所有合并与校验都必须以这里读到的记录为准。
window.modHubReadIndexDBModLists = async function() {
    const controller = window.modHubGetController();
    if (!controller) {
        return { ok: false, enabled: [], disabled: [], error: new Error('未找到 ModLoadController 实例') };
    }
    try {
        const enabled = typeof controller.listModIndexDB === 'function' ? await controller.listModIndexDB() : null;
        const disabled = typeof controller.loadHiddenModList === 'function' ? await controller.loadHiddenModList() : null;
        // 缺少读取接口时视为「无法校验」，交由调用方降级处理，绝不做出假阳性判断
        if (!Array.isArray(enabled) || !Array.isArray(disabled)) {
            return { ok: false, enabled: [], disabled: [], error: new Error('当前 ModLoader 未提供模组列表读取接口') };
        }
        return {
            ok: true,
            enabled: enabled.filter(name => typeof name === 'string'),
            disabled: disabled.filter(name => typeof name === 'string')
        };
    } catch (error) {
        console.warn('[ModHub] 读取模组列表失败', error);
        return { ok: false, enabled: [], disabled: [], error };
    }
};

// 工具函数：统一安全调用 overwriteModIndexDBModList / overwriteModIndexDBHiddenModList
// options.dropNames：本次操作中被明确移除、不允许被「已安装保留」逻辑复活的模组名（如删除模组）
// options.skipVerify：跳过写入后回读校验（仅供内部极端场景使用）
window.modHubSaveIndexDBModList = async function(enabledList, disabledList, options = {}) {
    let targetEnabled = window.modHubUniqueModNames(enabledList);
    const enabledNames = new Set(targetEnabled.map(name => name.trim().toLowerCase()));
    let targetDisabled = window.modHubUniqueModNames(disabledList)
        .filter(name => !enabledNames.has(name.trim().toLowerCase()));
    const dropNames = new Set((Array.isArray(options.dropNames) ? options.dropNames : [])
        .map(name => String(name || '').trim().toLowerCase())
        .filter(Boolean));

    // 写入前与存储中的真实记录合并：
    // 一旦内存状态来自陈旧快照，直接覆盖会把已安装模组挤出启用列表，
    // 造成「包体仍在库中、ModLoader 却不再加载它」的假删除，故此处自动保留。
    const current = await window.modHubReadIndexDBModLists();
    if (current.ok) {
        const known = new Set([...targetEnabled, ...targetDisabled].map(name => name.trim().toLowerCase()));
        const rescued = current.enabled.filter(name => {
            const key = name.trim().toLowerCase();
            return key && !known.has(key) && !dropNames.has(key);
        });
        if (rescued.length) {
            console.warn('[ModHub] 检测到已安装但未登记的模组，保存时自动保留:', rescued);
            targetEnabled = window.modHubUniqueModNames([...targetEnabled, ...rescued]);
        }
    }

    targetEnabled = window.modHubKeepRecoveryOrder(targetEnabled);
    const gui = window.modHubGetGui();
    const controller = [window.modHubGetController(), gui, gui?.modModLoadController].find(target =>
        typeof target?.overwriteModIndexDBModList === 'function' &&
        typeof target?.overwriteModIndexDBHiddenModList === 'function');
    if (!controller) throw new Error('未找到完整的 ModLoadController 模组列表存储接口');
    if (await controller.overwriteModIndexDBModList(targetEnabled) === false) throw new Error('启用列表保存失败');
    if (await controller.overwriteModIndexDBHiddenModList(targetDisabled) === false) throw new Error('禁用列表保存失败');

    // 写入后回读校验：ModLoader 对重复项 / 非字符串列表会静默跳过写入且不返回 false，
    // 只有回读比对才能真正确认配置已经落盘，杜绝「提示已保存但实际没生效」。
    if (current.ok && options.skipVerify !== true) {
        const after = await window.modHubReadIndexDBModLists();
        if (after.ok) {
            const sameOrder = (a, b) => a.length === b.length && a.every((name, index) => name === b[index]);
            if (!sameOrder(targetEnabled, after.enabled) || !sameOrder(targetDisabled, after.disabled)) {
                throw new Error('模组列表写入校验失败，存储中的启禁状态或精确顺序与预期不一致');
            }
        } else throw new Error('模组列表保存后无法回读，不能确认启禁状态与顺序');
    }
    return true;
};

// 工具函数：确保指定模组名已登记进 ModLoader 启用列表
// 用于安装完成后立即校验落盘结果，杜绝「包体已写入、模组却未启用」的假成功
window.modHubEnsureModInEnabledList = async function(modName, options = {}) {
    const name = String(modName || '').trim();
    if (!name) return { ok: false, reason: '模组名为空' };
    const read = await window.modHubReadIndexDBModLists();
    if (!read.ok) {
        return { ok: false, skipped: true, reason: read.error?.message || '无法读取模组列表' };
    }
    const key = name.toLowerCase();
    const nextEnabled = window.modHubKeepRecoveryOrder(window.modHubUniqueModNames([...read.enabled, name, ...(options.extraEnabled || [])]));
    if (JSON.stringify(read.enabled) === JSON.stringify(nextEnabled) && !read.disabled.some(item => item.trim().toLowerCase() === key)) return { ok: true };
    try {
        await window.modHubSaveIndexDBModList(nextEnabled, read.disabled);
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
    const after = await window.modHubReadIndexDBModLists();
    const ok = after.ok && JSON.stringify(after.enabled) === JSON.stringify(nextEnabled) && !after.disabled.some(item => item.trim().toLowerCase() === key);
    return ok ? { ok: true } : { ok: false, reason: '写入后回读仍未包含该模组' };
};

// 自愈：扫描 IndexedDB 中「有包体、却没有登记进启用 / 禁用列表」的孤儿模组
// 历史上某些保存动作会用陈旧的内存快照覆盖启用列表，把已安装模组挤出去，
// 包体仍在库中但 ModLoader 启动时不再加载它（表现为市场反复显示未安装 / 可更新）。
window.modHubRepairOrphanModZips = async function(options = {}) {
    if (window.modHubRestore?.isRestoring()) return { repaired: [] };
    const result = { ok: false, scanned: 0, repaired: [], skipped: [] };
    const gui = window.modHubGetGui();
    const keyval = gui?.gModUtils?.getIdbKeyValRef ? gui.gModUtils.getIdbKeyValRef() : null;
    const loader = gui?.gModUtils?.getModLoader ? gui.gModUtils.getModLoader()?.getIndexDBLoader?.() : null;
    const store = loader?.customStore;
    const calcModNameKey = loader?.constructor?.calcModNameKey;
    if (!keyval || typeof keyval.keys !== 'function' || typeof keyval.get !== 'function' ||
        !store || typeof calcModNameKey !== 'function') {
        result.reason = '当前 ModLoader 版本不支持包体枚举，跳过自愈';
        return result;
    }
    const prefix = String(loader.constructor.calcModNameKey('') || '');
    if (!prefix) {
        result.reason = '无法解析存储键前缀，跳过自愈';
        return result;
    }

    const lists = await window.modHubReadIndexDBModLists();
    if (!lists.ok) {
        result.reason = lists.error?.message || '无法读取模组列表';
        return result;
    }

    let keys = [];
    try {
        keys = await keyval.keys(store) || [];
    } catch (error) {
        result.reason = error?.message || '读取存储键失败';
        return result;
    }
    result.ok = true;

    const known = new Set([...lists.enabled, ...lists.disabled].map(name => name.trim().toLowerCase()));
    const orphans = [];
    for (const key of keys) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        result.scanned++;
        const name = key.slice(prefix.length).trim();
        if (!name || known.has(name.toLowerCase())) continue;
        // 尊重玩家移除恢复工具的选择，未登记的自身包体不自动启用。
        if (name.toLowerCase() === 'modhub') { result.skipped.push(name); continue; }
        orphans.push(name);
    }
    if (!orphans.length) return result;

    // 逐个校验包体确实是合法模组，避免把异常残留写进启用列表
    const controller = window.modHubGetController();
    const confirmed = [];
    for (const name of orphans) {
        try {
            const data = await keyval.get(prefix + name, store);
            if (!data) {
                result.skipped.push(name);
                continue;
            }
            const bootJson = typeof controller?.checkModZipFileIndexDB === 'function'
                ? await controller.checkModZipFileIndexDB(data)
                : true;
            if (bootJson && (typeof bootJson === 'object' || bootJson === true)) confirmed.push(name);
            else result.skipped.push(name);
        } catch (error) {
            console.warn(`[ModHub] 孤儿包体【${name}】校验失败，跳过:`, error);
            result.skipped.push(name);
        }
    }
    if (!confirmed.length) return result;

    try {
        await window.modHubSaveIndexDBModList([...lists.enabled, ...confirmed], lists.disabled);
        result.repaired = confirmed;
        console.warn('[ModHub] 已自动修复未登记生效的已安装模组:', confirmed);
        if (options.notify !== false && confirmed.length) {
            window.modHubShowToast(`已恢复 ${confirmed.length} 个未登记生效的已安装模组，重新载入游戏后生效`, 'success');
        }
    } catch (error) {
        console.warn('[ModHub] 修复已安装未登记模组失败:', error);
        result.ok = false;
        result.reason = error?.message || String(error);
    }
    return result;
};

// 工具函数：等待模组管理器空闲（保存中 / 列表读取中 / 配置状态待核实都视为忙碌）
window.modHubWaitManagerIdle = async function(timeoutMs = 6000, maxChecks = 60) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const isBusy = () => Boolean(window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerInit || window._modHubManagerStateUncertain);
    for (let i = 0; i < maxChecks; i++) {
        if (!isBusy()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    return !isBusy();
};

window.modHubHasReadmeContent = function(readme) {
    const text = typeof readme === 'string' ? readme.trim() : '';
    return Boolean(text) && !/^<<\s*(?:没有|无|no)\s*readme\s*>>$/i.test(text);
};

// 常见常用模组友好对照表（针对作者未在 boot.json 声明中文别名的主流 Mod）
const MODHUB_KNOWN_MOD_ALIASES = {
    'ModHub': '模组管理器与市场套件',
    'ModHub模组管理中心': '模组管理器与市场套件',
    'SimpleFramework': '简易框架',
    'Simple Frameworks': '简易框架',
    'SimpleFrameworks': '简易框架',
    'Simple Framework': '简易框架',
    'SCMLSimpleFramework': '简易框架',
    'GuideToMe': '控制NPC嘴部',
    'DoLSims': '模拟人生',
    'Wraith\'sReflection': '怨灵的倒影',
    'WraithsReflection': '怨灵的倒影',
    'NoBusHarassmentMod': '公交车防骚扰',
    'NoBusHarassment': '公交车防骚扰',
    'ModI18N': '游戏中文汉化补丁',
    'AutoClean': '自动清洁身体污垢',
    'AutoClothesRepair': '衣物破损自动修补',
    'AutoSchool': '自动上课与学校日常辅助',
    'cummilk': '产奶与母乳扩展',
    'MoreFarmUpgrade': '农田深度升级扩展',
    'Bailey\'s Office E': '贝利办公室剧情扩展',
    'DomRobin': '强势罗宾扩展',
    'GameOriginalImagePack': '原版高清图像资源包',
    'WardrobeIncrementalExpansion': '大大大衣柜容量扩展',
    'Sydney.Bare.Study.Mod': '悉尼无拘自习扩展',
    'Sydney Bare Study Mod': '悉尼无拘自习扩展',
    'WhitneyExpansion': '惠特尼剧情扩充',
    'WhitneyExpansion_': '惠特尼剧情扩充',
    'ExtraRecipeStudy': '额外菜谱研习',
    'BabyHawk': '小鹰育雏扩展',
    'More Love Interests Mod': '更多恋爱对象扩展',
    'NPC Avatars Mod': 'NPC 头像增强模组',
    'HonestMarkets': '诚实市场模组',
    '原版优化': '原版优化与管理套件',
    'Dol-Optimization': '原版优化与管理套件',
    'SmartPhone Alpha': '万能的智能手机',
    'SmartPhone': '万能的智能手机',
    'SmartPhone Omega': '万能的智能手机 Omega',
    'Dynamicest': '极致动态数值提醒',
    'maplebirch': '秋枫白桦框架',
    'WovenRealmCookingAddon': '织境空间-料理扩展',
    'DOLI': '智能 Agent 与 AI 剧情',
    'DOLArcadeExpansion': '游戏厅游玩扩充',
    'DoLQuestAssistant': '任务与指引助手',
    'AIStoryGen': 'AI 剧情辅助生成',
    'SimpleModManager': '简易模组管理器',
    'FeatsUnlocker': '成就快速解锁工具',
    'SafeSaves': '存档防损坏保护',
    'Cattery': '猫咖出租屋',
    'Degrees-of-Lewdity-Cattery': '猫咖出租屋',
    'FishingLife': '钓鱼人生',
    'DOLMOD-FishingLife': '钓鱼人生',
    'In-The-Eden-After-Sunset': '日落伊甸园',
    'Eden-Visuals-Mod': '伊甸互动头像',
    'Evil-Cockroach-Mod': '邪恶蟑螂（桌宠）',
    'EvilCockroach': '邪恶蟑螂（桌宠）',
    'CombatStatusDisplay': '战斗状态显示',
    'ARedSecret': '赤红的秘密',
    'Chimera-s-Blessing': '奇美拉的祝福',
    'Free-Speech-Attitudes': '自由对话态度',
    'NeoUIPatch': 'NeoUI 界面补丁',
    'dol-neoui-patch': 'NeoUI 界面补丁',
    'Degrees-of-Lewdity_strangeGarden': '万物皆可种农场',
    'Degrees-of-Lewdity_Bailey_rent_mod': '贝利疯狂爆PC金币',
    'Degrees-of-Lewdity_Cheat_Extended': '作弊拓展',
    'Remy_love_mod': '雷米恋爱',
    'LongerCombat': '更长遭遇战/言灵作弊集',
    'Sena-s-Sydney-Dialogue-Events-Expansion': '悉尼对话&剧情拓展',
    'DOL-Terra-Expanding-Modd': '泰拉瑞亚拓展',
    'Bunny-TransformationCN': '变身兔兔',
    'Degrees-of-Lewdity-Eden-Fence-Rescue-Fixed': '农场救援恢复'
};

// 内置核心系统模组的中文职能说明
const MODHUB_BUILTIN_MOD_ALIASES = {
    'ModLoader': 'Mod 加载器核心引擎',
    'ModLoaderGui': 'Mod 管理器界面核心',
    'ConflictChecker': '模组冲突检测引擎',
    'BeautySelectorAddon': '美化图像包选择器',
    'TweeReplacer': 'Twee 文本动态替换插件',
    'ReplacePatcher': '脚本代码替换补丁插件',
    'CheckGameVersion': '游戏版本兼容校验插件',
};

// 辅助归一化查找别名（不区分大小写、下划线、标点与单双引号）
window.modHubFindKnownAlias = function(name, isBuiltin = false) {
    if (!name) return '';
    const dict = isBuiltin ? MODHUB_BUILTIN_MOD_ALIASES : MODHUB_KNOWN_MOD_ALIASES;
    if (dict[name]) return dict[name];
    const norm = String(name).toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    if (!norm) return '';
    for (const [k, v] of Object.entries(dict)) {
        const kNorm = String(k).toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
        if (kNorm === norm) return v;
    }
    return '';
};

let _modHubSubtextLock = false;

// 提取模组智能友好副标题（别名 / 简介 / 职能）
window.modHubGetModSubtext = function(modName, modInfo, isBuiltin = false, skipMarket = false) {
    const boot = modInfo?.bootJson;
    let nick = '';

    if (boot) {
        // 1. 优先提取 boot.json 中的 nickName（支持多语言对象或直接字符串）
        if (boot.nickName) {
            if (typeof boot.nickName === 'object') {
                const language = window.modHubGetLanguage?.() || 'zh-CN';
                const keys = language === 'en' ? ['en', 'en-US', 'en-GB'] : language === 'zh-TW' ? ['zh-TW', 'zh-Hant', 'zh-HK', 'tw', 'cht', 'hant', 'zh'] : ['zh-CN', 'zh-Hans', 'zh', 'cn', 'chs', 'hans'];
                nick = keys.map(key => boot.nickName[key]).find(value => typeof value === 'string' && value.trim()) || '';
                if (!nick) {
                    const firstVal = Object.values(boot.nickName).find(v => typeof v === 'string' && v.trim());
                    if (firstVal) nick = firstVal;
                }
            } else if (typeof boot.nickName === 'string') {
                nick = boot.nickName.trim();
            }
        }

        // 2. 若无有效别名（或别名与 modName 重复），尝试提取 description 或 desc
        if (!nick || nick === modName) {
            const desc = boot.description || boot.desc;
            if (desc && typeof desc === 'string') {
                let cleanDesc = desc.replace(/[\r\n\t]+/g, ' ').trim();
                if (cleanDesc.length > 28) cleanDesc = cleanDesc.slice(0, 26) + '...';
                nick = cleanDesc;
            }
        }
    }

    // 3. 查阅内置已知模组库（支持大小写与标点容错，O(1) 绝对安全无副作用）
    if (!nick || nick === modName) {
        const known = window.modHubFindKnownAlias(modName, isBuiltin);
        if (known) nick = known;
    }

    // 4. 若仍无有效副标题且非内置模组，尝试从模组市场只读缓存中安全获取（严格防重入与递归阻断）
    if ((!nick || nick === modName) && !isBuiltin && !skipMarket && !_modHubSubtextLock && window.modHubMarket) {
        _modHubSubtextLock = true;
        try {
            if (typeof window.modHubMarket.getStaticMarketModSubtext === 'function') {
                const marketText = window.modHubMarket.getStaticMarketModSubtext(modName);
                if (marketText) nick = marketText;
            }
            if ((!nick || nick === modName) && typeof window.modHubMarket.findMarketModByLocalName === 'function') {
                const marketMod = window.modHubMarket.findMarketModByLocalName(modName);
                if (marketMod) {
                    if (marketMod.name && marketMod.name !== modName && /[\u4e00-\u9fa5]/.test(marketMod.name)) {
                        nick = marketMod.name;
                    } else if (marketMod.desc || marketMod.description) {
                        let d = String(marketMod.desc || marketMod.description).replace(/[\r\n\t]+/g, ' ').trim();
                        d = d.replace(/^(?:包含|提供|支持|增加|新增|用于)[：:]\s*/, '');
                        if (d.length > 28) d = d.slice(0, 26) + '...';
                        if (d) nick = d;
                    }
                }
            }
        } catch (_) {
        } finally {
            _modHubSubtextLock = false;
        }
    }

    // 5. 若为内置核心模组仍无名称，兜底为“系统核心”
    if (!nick && isBuiltin) {
        nick = '系统核心';
    }

    return nick && nick !== modName ? nick : '';
};

// 移动文件提供器可能将 ModPack 标为二进制类型；实际格式仍由原生接口校验。
const MODHUB_IMPORT_ACCEPT = '.zip,.modpack,.modpack.crypt,application/zip,application/octet-stream';
const MODHUB_PACKAGE_EXTENSION = /(?:(?:\.mod)?\.zip|\.modpack(?:\.crypt)?)$/i;
const MODHUB_NATIVE_PACKAGE_EXTENSION = /\.modpack(?:\.crypt)?$/i;
const MODHUB_ZIP_PACKAGE_EXTENSION = /\.zip$/i;

window.modHubResolveImportedModName = function(fileName, modNames, preferredName = '') {
    const normalize = value => String(value || '')
        .replace(MODHUB_PACKAGE_EXTENSION, '')
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
    const names = window.modHubUniqueModNames(modNames);
    const preferredKey = normalize(preferredName);
    const direct = names.find(name => normalize(name) === preferredKey);
    if (direct) return direct;

    const sources = [fileName, preferredName].map(normalize).filter(Boolean);
    let bestName = null;
    let bestScore = 0;
    names.forEach(name => {
        const boot = window.modHubGetModInfo(name)?.bootJson || {};
        const nickNames = typeof boot.nickName === 'object' ? Object.values(boot.nickName) : [boot.nickName];
        const friendlyName = window.modHubGetModSubtext(name, { bootJson: boot });
        const aliases = new Set([name, boot.name, friendlyName, ...nickNames].filter(Boolean));
        Object.entries(MODHUB_KNOWN_MOD_ALIASES).forEach(([alias, friendly]) => {
            const knownKeys = [alias, friendly].map(normalize);
            const candidateKeys = [...aliases].map(normalize);
            if (knownKeys.some(key => candidateKeys.includes(key))) {
                aliases.add(alias);
                aliases.add(friendly);
            }
        });
        aliases.forEach(alias => {
            const aliasKey = normalize(alias);
            const isUseful = /[\u3400-\u9fff]/.test(aliasKey) ? aliasKey.length >= 2 : aliasKey.length >= 4;
            if (!isUseful) return;
            sources.forEach(source => {
                if (source === aliasKey || source.includes(aliasKey) || aliasKey.includes(source)) {
                    const score = aliasKey.length + (source === aliasKey ? 10000 : 0);
                    if (score > bestScore) {
                        bestName = name;
                        bestScore = score;
                    }
                }
            });
        });
    });
    return bestName;
};

/* =========================================================================
 * 1. 通用模块 (General)
 * ========================================================================= */
// 全局重新载入游戏方法
window.modHubRestartGame = function() {
    if (window.modHubIsReloadBlocked()) {
        window.modHubShowToast('请等待操作完成；保存失败时请先刷新列表核实配置。', 'warning');
        return false;
    }
    window.modHubShowToast('正在重新载入游戏...', 'warning');
    location.reload();
    return true;
};

window.modHubToggleSafeMode = function(checked) {
    return window.modHubRunManagerAction(async () => {
        const modSwitch = window.modHubGetGui()?.modLoadSwitch;
        if (!modSwitch) throw new Error('无法获取安全模式设置');
        if (checked) await modSwitch.enableSafeMode();
        else await modSwitch.disableSafeMode();
        window.modHubShowToast(checked ? '安全模式已开启，重新载入后生效' : '安全模式已关闭，重新载入后生效', 'success');
    });
};

window.initGeneral = function() {
    const gui = window.modHubGetGui();

    // 重新载入按钮
    const btnRestart = document.getElementById('btnRestart');
    if (btnRestart) {
        btnRestart.onclick = window.modHubRestartGame;
    }

    // 安全模式切换
    const toggleSafeMode = document.getElementById('toggleSafeMode');
    if (toggleSafeMode && gui && gui.modLoadSwitch) {
        toggleSafeMode.checked = gui.modLoadSwitch.isSafeModeOn();

        toggleSafeMode.onchange = () => window.modHubToggleSafeMode(toggleSafeMode.checked);
    }

    // 拖放及文件选择上传模组
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    if (dropZone && fileInput) {
        dropZone.ondragover = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        };
        dropZone.ondragleave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        };
        dropZone.ondrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                await window.modHubHandleAddMod(fileInput, { askRestart: true });
            }
        };
        dropZone.onclick = (e) => {
            if (e.target === fileInput) return;
            fileInput.click();
        };
        fileInput.onchange = async () => {
            await window.modHubHandleAddMod(fileInput, { askRestart: true });
        };
    }

    // 加载环境统计信息
    window.modHubUpdateGeneralInfo();
};

// 市场页签与侧栏入口共用更新数量。
window.modHubUpdateMarketTabBadge = function(count = window._modHubUpdatableCount || 0) {
    window._modHubUpdatableCount = count;
    if (typeof document === 'undefined') return;
    const buttons = [...document.querySelectorAll('#overlayTabs button')]
        .filter(btn => window.modHubGetTabId(btn) === 'market');
    buttons.push(...document.querySelectorAll('.modhub-sidebar-entry > button:not(.modhub-assist-entry-badge)'));
    for (const btn of buttons) {
        let badge = btn.querySelector('.modhub-tab-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'modhub-tab-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count;
            badge.title = window.modHubT?.('{count} 个模组有新版本可用', { count }) || `${count} 个模组有新版本可用`;
            badge.setAttribute('aria-label', badge.title);
        } else if (badge) {
            badge.remove();
        }
    }
};

window.jQuery?.(document).on?.(':storyready.modHubUpdateBadge :passagedisplay.modHubUpdateBadge', () => {
    window.modHubUpdateMarketTabBadge();
});

// 响应市场更新状态同步通知
window.modHubNotifyUpdateState = function(count, list) {
    window._modHubUpdatableCount = typeof count === 'number' ? count : (list ? list.length : 0);
    window._modHubUpdatableMods = list || [];
    const map = new Map();
    if (list) {
        list.forEach(item => {
            if (item.localProfile?.name) map.set(item.localProfile.name, item);
            if (item.name) map.set(item.name, item);
            if (item.localName) map.set(item.localName, item);
        });
    }
    window._modHubUpdatableMap = map;

    // 逐行同步已有节点，保留滚动位置与正在进行的拖拽。
    const manager = document.getElementById('modHubModManageContainer');
    for (const row of manager?.querySelectorAll('li[data-mod-name]') || []) {
        const modName = row.dataset.modName;
        const update = map.get(modName) || map.get(modName.toLowerCase());
        const version = update?.newVersion ? (window.modHubFormatVersion ? window.modHubFormatVersion(update.newVersion) : update.newVersion) : '';
        const tag = row.querySelector('.modhub-update-tag');
        const button = row.querySelector('.btn-inline-update');
        if (tag) {
            if (version && window.modHubBindText) window.modHubBindText(tag, ' | [可更新 -> {p0}]', { p0: version });
            else tag.textContent = version ? ` | [可更新 -> ${version}]` : '';
            tag.style.display = version ? '' : 'none';
        }
        if (button) {
            button.title = version ? (window.modHubT?.('立即升级至 {p0}', { p0: version }) || `立即升级至 ${version}`) : '';
            button.style.display = version ? '' : 'none';
        }
    }

    // 1. 同步市场页签与侧栏角标
    window.modHubUpdateMarketTabBadge(window._modHubUpdatableCount);

    // 2. 如果当前在模组管理页，局部刷新置顶横幅与第 4 张卡片
    const bannerEl = document.getElementById('modHubUpdateBanner');
    if (bannerEl) {
        if (window._modHubUpdatableCount > 0) {
            bannerEl.innerHTML = modHubTranslateManagerHtml(`
                <div class="modhub-update-banner modhub-clickable" onclick="window.modHubGoToMarketUpdates()" title="点击前往模组市场一键更新">
                    <div class="modhub-update-banner-main">
                        <div class="modhub-update-banner-title">发现 ${window._modHubUpdatableCount} 个模组有新版本可用！</div>
                        <div class="modhub-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                    </div>
                    <button type="button" class="macro-button modhub-btn-primary" onclick="event.stopPropagation(); window.modHubGoToMarketUpdates();">查看更新</button>
                </div>
            `);
            bannerEl.style.display = 'block';
        } else {
            bannerEl.innerHTML = '';
            bannerEl.style.display = 'none';
        }
    }

    const fourthCard = document.getElementById('modHubEnvInfoCardFourth');
    if (fourthCard) {
        if (window._modHubUpdatableCount > 0) {
            fourthCard.className = 'childItem modhub-stat-card modhub-clickable';
            fourthCard.title = '点击前往模组市场查看并升级';
            fourthCard.onclick = () => window.modHubGoToMarketUpdates && window.modHubGoToMarketUpdates();
            fourthCard.style.borderColor = 'var(--gold, #d4af37)';
            fourthCard.innerHTML = modHubTranslateManagerHtml(`
                <div class="modhub-stat-num gold modhub-pulse-gold">${window._modHubUpdatableCount}</div>
                <div class="gold modhub-stat-label">发现新版</div>
            `);
        } else {
            const mlVersion = window.modHubGetGui()?.gModUtils?.version || window.modUtils?.version || '2.x';
            fourthCard.className = 'childItem modhub-stat-card';
            fourthCard.title = '';
            fourthCard.onclick = null;
            fourthCard.style.borderColor = '';
            fourthCard.innerHTML = modHubTranslateManagerHtml(`
                <div class="modhub-stat-num">${window.modHubEscapeHtml(mlVersion)}</div>
                <div class="grey modhub-stat-label">加载器版本</div>
            `);
        }
    }
};

window.modHubUpdateGeneralInfo = async function() {
    const gui = window.modHubGetGui();
    const infoEl = document.getElementById('modHubEnvInfo');
    if (!infoEl) return;

    try {
        const mlVersion = gui?.gModUtils?.version || window.modUtils?.version || '2.x';
        const allMods = window.modHubUniqueModNames(gui?.gModUtils?.getModListNameNoAlias() || []);
        const state = window._modHubModState || await window.modHubLoadModManageState();
        const sideLoadMods = window.modHubUniqueModNames(state.sideEnabled);
        const enabledNames = new Set(sideLoadMods.map(name => name.trim().toLowerCase()));
        const hiddenSideMods = window.modHubUniqueModNames(state.sideDisabled)
            .filter(name => !enabledNames.has(name.trim().toLowerCase()));

        // 尝试从模组市场接口直接检测可更新项
        let updatables = null;
        if (window.modHubMarket?.getUpdatableMods) {
            try {
                updatables = window.modHubMarket.getUpdatableMods() || [];
            } catch (_) {}
        }
        const updatableCount = updatables ? updatables.length : (window._modHubUpdatableCount || 0);

        const fourthCardHtml = updatableCount > 0
            ? `<div id="modHubEnvInfoCardFourth" class="childItem modhub-stat-card modhub-clickable" onclick="window.modHubGoToMarketUpdates()" title="点击前往模组市场查看并升级" style="border-color: var(--gold, #d4af37);">
                <div class="modhub-stat-num gold modhub-pulse-gold">${updatableCount}</div>
                <div class="gold modhub-stat-label">发现新版</div>
               </div>`
            : `<div id="modHubEnvInfoCardFourth" class="childItem modhub-stat-card">
                <div class="modhub-stat-num">${window.modHubEscapeHtml(mlVersion)}</div>
                <div class="grey modhub-stat-label">加载器版本</div>
               </div>`;

        infoEl.innerHTML = modHubTranslateManagerHtml(`
            <div class="childItem modhub-stat-card">
                <div class="modhub-stat-num gold">${allMods.length}</div>
                <div class="grey modhub-stat-label">已加载模组</div>
            </div>
            <div class="childItem modhub-stat-card">
                <div class="modhub-stat-num green">${sideLoadMods.length}</div>
                <div class="grey modhub-stat-label">已启用模组</div>
            </div>
            <div class="childItem modhub-stat-card">
                <div class="modhub-stat-num">${hiddenSideMods.length}</div>
                <div class="grey modhub-stat-label">已禁用模组</div>
            </div>
            ${fourthCardHtml}
        `);

        // 渲染置顶横幅
        const bannerEl = document.getElementById('modHubUpdateBanner');
        if (bannerEl) {
            if (updatableCount > 0) {
                bannerEl.innerHTML = modHubTranslateManagerHtml(`
                    <div class="modhub-update-banner modhub-clickable" onclick="window.modHubGoToMarketUpdates()" title="点击前往模组市场一键更新">
                        <div class="modhub-update-banner-main">
                            <div class="modhub-update-banner-title">发现 ${updatableCount} 个模组有新版本可用！</div>
                            <div class="modhub-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                        </div>
                        <button type="button" class="macro-button modhub-btn-primary" onclick="event.stopPropagation(); window.modHubGoToMarketUpdates();">查看更新</button>
                    </div>
                `);
                bannerEl.style.display = 'block';
            } else {
                bannerEl.innerHTML = '';
                bannerEl.style.display = 'none';
            }
        }

        // 同步更新 Tab 角标
        if (typeof window.modHubUpdateMarketTabBadge === 'function') {
            window.modHubUpdateMarketTabBadge(updatableCount);
        }
    } catch (e) {
        console.error('[ModHub] 获取统计信息失败', e);
    }
};

// 通用 Tab 切换接口
window.modHubSwitchTab = function(tabName, options = {}) {
    if (typeof document === 'undefined') return false;
    const tabs = document.querySelectorAll('#overlayTabs button');
    for (const btn of tabs) {
        if (window.modHubGetTabId(btn) === window.modHubGetTabId(tabName) && window.modHubGetTabId(tabName)) {
            if (options.skipReloadPrompt) window._modHubSkipReloadPrompt = (window._modHubSkipReloadPrompt || 0) + 1;
            try { btn.click(); }
            finally { if (options.skipReloadPrompt) window._modHubSkipReloadPrompt--; }
            return true;
        }
    }
    return false;
};

// 通用模组管理器弹窗安全呼出接口（支持直达任意 Tab，如“加载日志”）
window.modHubOpenManager = function(tabName = '模组管理', options = {}) {
    tabName = MODHUB_TABS[window.modHubGetTabId(tabName)] || tabName;
    const navigation = (window._modHubManagerNavigationRevision || 0) + 1;
    window._modHubManagerNavigationRevision = navigation;
    window._modHubPendingLogSearch = null;
    window._modHubPendingScrollToFirstError = false;
    try {
        // 1. 防御初始化 State.temporary / T.buttons，消除原版 overlayReplace 报 Cannot read properties of undefined (reading 'activeTab')
        if (typeof State !== 'undefined' && State.temporary) {
            if (!State.temporary.buttons) {
                State.temporary.buttons = {
                    activeTab: -1,
                    toggle: () => {},
                    reset: () => {},
                    setupTabs: () => {},
                    setActive: () => {}
                };
            }
            State.temporary.currentOverlay = 'modloader';
        }
        if (typeof V !== 'undefined') {
            V.currentOverlay = 'modloader';
        }

        // 2. 检查 DOM 层面 customOverlay 容器是否已挂载
        const overlay = (typeof document !== 'undefined') ?
            ((document.getElementById ? document.getElementById('customOverlay') : null) ||
             (document.querySelector ? document.querySelector('.customOverlay') : null)) : null;

        // 3. 决定目标 Tab 的渲染宏与索引
        const tabIndexMap = {
            '模组管理': 0,
            '模组市场': 1,
            '模组说明': 2,
            '加载日志': 3,
            '帮助中心': 4
        };
        const tabIdx = tabIndexMap[tabName] !== undefined ? tabIndexMap[tabName] : 0;

        let contentMacro = '<<modloadermodmanage>>';
        if (tabName === '加载日志') {
            contentMacro = '<<modloaderlog>>';
        } else if (tabName === '模组市场') {
            contentMacro = '<<modloadermarket>>';
        } else if (tabName === '模组说明') {
            contentMacro = '<<modloaderreadme>>';
        } else if (tabName === '帮助中心') {
            contentMacro = '<<modloaderhelp>>';
        }

        const logSearch = tabName === '加载日志' && typeof options.logSearch === 'string' ? options.logSearch.trim() : '';
        if (tabName === '加载日志') window._modHubPendingLogSearch = logSearch || null;
        if (logSearch) {
            window._modHubPendingScrollToFirstError = false;
        } else if (tabName === '加载日志' || options.scrollToError) {
            window._modHubPendingScrollToFirstError = true;
        }

        // 4. 调用原生 DOM 显示并使用 Wikifier 渲染窗口标题与指定 Tab 内容
        let rendered = false;
        if (overlay) {
            if (overlay.classList?.remove) overlay.classList.remove('hidden');
            const parent = (typeof overlay.closest === 'function' ? overlay.closest('.customOverlayContainer') : null) || overlay.parentElement;
            if (parent?.classList?.remove) {
                parent.classList.remove('hidden');
            }
            if (overlay.setAttribute) overlay.setAttribute('data-overlay', 'modloader');
        }

        if (typeof Wikifier !== 'undefined' && typeof Wikifier.wikifyEval === 'function') {
            try {
                // 直接精准渲染标题与指定 Tab 内容，向 titleModloader 透传目标 Tab 索引以激活正确的 tab-selected
                Wikifier.wikifyEval(`<<replace #customOverlayTitle>><<titleModloader ${tabIdx}>><</replace>><<replace #customOverlayContent>>${contentMacro}<</replace>>`);
                rendered = true;
            } catch (errEval) {
                console.warn('[ModHub] 直连渲染模组管理器面板失败，尝试降级呼出', errEval);
            }
        }

        if (!rendered && typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
            // 降级：优先使用入口标记，兼容旧版入口的精确名称。
            const buttons = Array.from(document.querySelectorAll('button'));
            const label = button => String(button.textContent || '').replace(/\s+/g, '').trim();
            const btn = document.querySelector?.('.modhub-sidebar-entry button')
                || buttons.find(button => label(button) === 'ModHub')
                || buttons.find(button => label(button) === 'Mod管理器');
            if (btn && typeof btn.click === 'function') {
                btn.click();
                rendered = true;
                if (tabName !== '模组管理' && typeof Wikifier !== 'undefined' && typeof Wikifier.wikifyEval === 'function') {
                    setTimeout(() => {
                        if (navigation !== window._modHubManagerNavigationRevision) return;
                        Wikifier.wikifyEval(`<<replace #customOverlayContent>>${contentMacro}<</replace>>`);
                    }, 50);
                }
            }
        }

        // 5. 确保 Tab 高亮（tab-selected）并联动定位首处错误
        setTimeout(() => {
            if (navigation !== window._modHubManagerNavigationRevision) return;
            if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
                const tabs = document.querySelectorAll('#overlayTabs button');
                tabs.forEach(btn => {
                    const match = btn.textContent?.trim().includes(tabName);
                    if (btn.classList) {
                        btn.classList.toggle('tab-selected', !!match);
                        btn.classList.toggle('active', !!match);
                        btn.classList.toggle('macro-button-selected', !!match);
                    }
                });
            }

            if (typeof State !== 'undefined' && State.temporary?.tab && typeof State.temporary.tab.setActive === 'function') {
                const offset = (typeof V !== 'undefined' && V.options?.closeButtonMobile) ? 1 : 0;
                State.temporary.tab.setActive(tabIdx + offset);
            }

            if (!logSearch && (tabName === '加载日志' || options.scrollToError)) {
                setTimeout(() => {
                    if (navigation !== window._modHubManagerNavigationRevision) return;
                    if (typeof window.modHubScrollToFirstError === 'function') {
                        window.modHubScrollToFirstError();
                    }
                }, 100);
            }
        }, 50);

        if (!rendered && navigation === window._modHubManagerNavigationRevision) {
            window._modHubPendingLogSearch = null;
            window._modHubPendingScrollToFirstError = false;
        }
        return rendered;
    } catch (e) {
        if (navigation === window._modHubManagerNavigationRevision) {
            window._modHubPendingLogSearch = null;
            window._modHubPendingScrollToFirstError = false;
        }
        console.error('[ModHub] 呼出模组管理器失败', e);
        return false;
    }
};

// 窗口级全局文件拖拽安全拦截器（彻底拦截浏览器默认导航与二次下载行为，防止页面跳转或挂起）
window.modHubInitGlobalDragDrop = function() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    if (window._modHubGlobalDragDropInitialized) return;
    window._modHubGlobalDragDropInitialized = true;

    // 1. 阻止浏览器原生的 dragenter / dragover 默认动作
    ['dragenter', 'dragover'].forEach(eventType => {
        window.addEventListener(eventType, (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    e.dataTransfer.dropEffect = 'none';
                } catch (_) {}
            }
        }, false);
    });

    // 2. 拦截 dragleave 默认行为
    window.addEventListener('dragleave', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, false);

    // 3. 全局拦截 drop，坚决阻止浏览器“打开文件 / 再次下载 / 页面导航”
    window.addEventListener('drop', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, false);
};

// 立即在顶层启动全局拖拽安全拦截器
window.modHubInitGlobalDragDrop();

// 单模组安装核心方法：通过原生校验接口识别 Zip / ModPack，原样写入 IndexedDB。
// 返回 { modName, bootJson, version, verified }；任一步骤无法确认落盘都会抛出可读异常。
window.modHubInstallModZip = async function(fileOrBlob, preferredFileName = '') {
    const controller = window.modHubGetController();
    if (!controller || typeof controller.addModIndexDB !== 'function') {
        throw new Error('未找到 ModLoadController 存储接口');
    }

    const arrayBuffer = typeof fileOrBlob.arrayBuffer === 'function'
        ? await fileOrBlob.arrayBuffer()
        : fileOrBlob;
    const u8Data = new Uint8Array(arrayBuffer);
    const fileName = preferredFileName || fileOrBlob.name || '';
    const isNativePackage = MODHUB_NATIVE_PACKAGE_EXTENSION.test(fileName);
    if (!MODHUB_ZIP_PACKAGE_EXTENSION.test(fileName) && typeof controller.checkModZipFileIndexDB !== 'function') {
        throw new Error('当前 ModLoader 未提供 ModPack 校验接口，无法核验此二进制安装包；请使用支持该格式的加载器或作者提供的 Zip 包。');
    }

    // 官方接口先尝试 ModPack 适配器，再回退 Zip；不转换格式或自行解码。
    let modName = null;
    let bootJson = null;
    let checkFailed = '';
    if (typeof controller.checkModZipFileIndexDB === 'function') {
        try {
            const checkResult = await controller.checkModZipFileIndexDB(u8Data);
            if (checkResult && typeof checkResult === 'object' && !Array.isArray(checkResult)) {
                bootJson = checkResult;
                modName = typeof checkResult.name === 'string' ? checkResult.name.trim() || null : null;
                if (!modName) checkFailed = '模组清单缺少有效名称';
            } else {
                checkFailed = typeof checkResult === 'string' && checkResult ? checkResult : '未读取到有效模组清单';
            }
        } catch (err) {
            checkFailed = err?.message || '当前加载器无法读取此安装包';
        }
    }

    // 安装包缺少合法 boot.json 时，ModLoader 重启后绝不会加载它，
    // 此处必须直接失败并给出原因，避免留下永远无法生效的幽灵安装包。
    if (checkFailed) {
        const hint = /\.modpack\.crypt$/i.test(fileName)
            ? '当前导入接口不提供密码输入，请使用作者提供的无需密码安装包。'
            : isNativePackage ? '请核对文件完整性及 ModLoader 是否支持此 ModPack。' : '该文件不是可用的模组安装包。';
        throw new Error(`安装包校验失败（${checkFailed}）。${hint}`);
    }

    // 旧加载器缺少校验接口时仅保留原有 Zip 名称回退，其余格式必须经过原生校验。
    if (!modName) {
        modName = fileName.replace(MODHUB_PACKAGE_EXTENSION, '') || 'UnknownMod';
    }

    // 3. 写入 IndexedDB（addModIndexDB 同时将模组追加到启用列表）
    await controller.addModIndexDB(modName, u8Data);
    window.modHubMarket?.invalidateLocalPackageProfiles?.();

    // 4. 从禁用列表中移除（若此前被禁用），确保新安装模组处于启用状态
    try {
        const hiddenList = await controller.loadHiddenModList() || [];
        const key = modName.trim().toLowerCase();
        if (hiddenList.some(name => String(name).trim().toLowerCase() === key)) {
            const newHidden = hiddenList.filter(name => String(name).trim().toLowerCase() !== key);
            await controller.overwriteModIndexDBHiddenModList(newHidden);
        }
    } catch (_) {}

    // 5. 落盘强校验：确认包体已登记进启用列表
    // 这是「点击安装、重启后却显示未安装」的直接防线：
    // 只要启用列表里缺少这个名字，ModLoader 启动时就完全不会加载该包体。
    if (bootJson) window._modHubDisabledModInfo.set(modName.trim().toLowerCase(), { name: modName, bootJson });
    const ensured = await window.modHubEnsureModInEnabledList(modName);
    if (!ensured.ok && !ensured.skipped) {
        throw new Error(`模组【${modName}】包体已写入，但未能登记到启用列表：${ensured.reason || '未知原因'}`);
    }
    if (ensured.skipped) {
        console.warn('[ModHub] 当前环境无法回读模组列表，跳过安装落盘校验:', ensured.reason);
    }

    return {
        modName,
        bootJson,
        version: bootJson?.version ? String(bootJson.version) : '',
        verified: ensured.ok === true
    };
};

// 批量安装文件流至 IndexedDB
window.modHubInstallFilesViaIndexDB = async function(fileInputOrFiles) {
    const files = Array.isArray(fileInputOrFiles)
        ? fileInputOrFiles
        : Array.from(fileInputOrFiles?.files || []);
    if (!files.length) return [];

    const results = [];
    for (const file of files) {
        const res = await window.modHubInstallModZip(file, file.name);
        results.push(res);
    }
    return results;
};

// 触发顶部导入模组选择
window.modHubTriggerImport = function() {
    let input = document.getElementById('modHubImportFileInput');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'modHubImportFileInput';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
    }
    input.accept = MODHUB_IMPORT_ACCEPT;
    input.onchange = async () => {
        await window.modHubHandleAddMod(input, { askRestart: true });
    };
    input.click();
};

window.modHubFormatReloadMessage = function(message) {
    return window.modHubEscapeHtml(message)
        .replace(/((?:模组|核心框架)【)([^】]+)】/g, '$1<strong class="gold">$2</strong>】')
        .replace('重新载入可能丢失尚未存档的游戏进度，请先存档。', '重新载入<strong class="red">可能丢失尚未存档的游戏进度</strong>，<strong class="gold" style="white-space: nowrap;">请先存档</strong>。')
        .replace(/\n/g, '<br>');
};

async function modHubCommitImportedPackages(files, options, context) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('原子安装选项无效');
    const restore = window.modHubRestore, controller = window.modHubGetController();
    if (typeof restore?.commitPackageChanges !== 'function' || typeof controller?.checkModZipFileIndexDB !== 'function') {
        throw new Error('当前环境无法原子提交所选安装包与启禁配置，已停止安装');
    }
    const readNames = (value = []) => {
        if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())
            || new Set(value.map(name => name.toLowerCase())).size !== value.length) throw new Error('安装配置包含无效或重复技术名');
        return [...value];
    };
    const lists = await window.modHubReadIndexDBModLists();
    if (!lists.ok) throw lists.error || new Error('无法核验安装前启禁配置');
    const enabled = readNames(lists.enabled), disabled = readNames(lists.disabled);
    readNames([...enabled, ...disabled]);
    const key = name => name.toLowerCase();
    const preserveDisabled = readNames(options.preserveDisabledNames);
    if (preserveDisabled.some(name => !disabled.some(item => key(item) === key(name)))) throw new Error('附加项的禁用状态已改变，请重新生成安装计划');
    const switchGroup = options.switchGroup;
    const guardedPackages = [];
    let targetName = '', disabledNames = [];
    if (switchGroup) {
        [targetName] = readNames([switchGroup.targetName]);
        disabledNames = readNames(switchGroup.disabledNames);
        if (disabledNames.some(name => key(name) === key(targetName)) || preserveDisabled.some(name => key(name) === key(targetName))) {
            throw new Error('分支切换不能同时启用和禁用所选主包');
        }
        if (!Array.isArray(switchGroup.snapshot)) throw new Error('分支切换缺少确认时的状态快照');
        readNames(switchGroup.snapshot.map(item => item?.name));
        for (const item of switchGroup.snapshot) {
            const isEnabled = enabled.some(name => key(name) === key(item.name));
            const exists = isEnabled || disabled.some(name => key(name) === key(item.name));
            const installed = await window.modHubReadInstalledModPackage(item.name);
            if (!exists || typeof item.enabled !== 'boolean' || item.enabled !== isEnabled || installed.error || installed.missing
                || String(installed.bootJson?.version || '') !== item.version) throw new Error('分支安装状态已改变，请重新生成安装计划');
            const data = installed.data;
            guardedPackages.push({ name: item.name, expectedData: typeof data === 'string' ? data
                : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : data.slice(0) });
        }
        if (disabledNames.some(name => !switchGroup.snapshot.some(item => key(item.name) === key(name)))) throw new Error('待停用分支不在确认快照中');
        const registeredTarget = [...enabled, ...disabled].find(name => key(name) === key(targetName));
        if (registeredTarget && !switchGroup.snapshot.some(item => key(item.name) === key(targetName))) throw new Error('所选分支安装状态已改变，请重新生成安装计划');
    }
    const packages = [], boots = [];
    for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        const boot = await controller.checkModZipFileIndexDB(data);
        const name = typeof boot?.name === 'string' ? boot.name.trim() : '';
        if (!name || typeof boot !== 'object' || Array.isArray(boot)) throw new Error(`【${file.name || '所选文件'}】未提供有效模组清单，已停止安装`);
        if (boots.some(item => key(item.name) === key(name))) throw new Error(`所选安装包重复提供【${name}】`);
        const previous = await window.modHubReadInstalledModPackage(name);
        if (previous.error) throw previous.error;
        // 原生 IndexDBLoader.addMod 将新包保存为 Uint8Array，不经过自动启用接口。
        packages.push({ name, data, ...(previous.missing ? {} : { expectedData: previous.data }) });
        boots.push(boot);
    }
    if (targetName && !packages.some(item => key(item.name) === key(targetName))) {
        const target = await window.modHubReadInstalledModPackage(targetName);
        if (target.error || target.missing || ![...enabled, ...disabled].some(name => key(name) === key(targetName))) {
            throw new Error('所选切换分支没有已核验的安装包');
        }
    }
    const toDisable = new Set([...preserveDisabled, ...disabledNames].map(key));
    const nextEnabled = window.modHubKeepRecoveryOrder(window.modHubUniqueModNames([
        ...enabled.filter(name => !toDisable.has(key(name))),
        ...packages.map(item => item.name).filter(name => !toDisable.has(key(name))),
        ...(targetName ? [targetName] : [])
    ]), boots.map(bootJson => ({ name: bootJson.name, bootJson })));
    const enabledKeys = new Set(nextEnabled.map(key));
    const nextDisabled = window.modHubUniqueModNames([...disabled, ...disabledNames, ...preserveDisabled])
        .filter(name => !enabledKeys.has(key(name)));
    try {
        await restore.commitPackageChanges({ context, packages, guardedPackages, expectedEnabled: enabled, expectedDisabled: disabled,
            enabled: nextEnabled, disabled: nextDisabled });
    } catch (error) {
        if (error.committed) window.modHubMarket?.invalidateLocalPackageProfiles?.();
        throw error;
    }
    boots.forEach(bootJson => window._modHubDisabledModInfo.set(key(bootJson.name), { name: bootJson.name, bootJson }));
    window.modHubMarket?.invalidateLocalPackageProfiles?.();
    return window.modHubUniqueModNames([...packages.map(item => item.name), ...(targetName ? [targetName] : [])]);
}

window.modHubHandleAddMod = async function(fileInput, options = {}) {
    const gui = window.modHubGetGui();
    if (!gui) {
        window.modHubShowToast('未找到模组管理器实例', 'warning');
        return;
    }
    const files = Array.isArray(fileInput)
        ? fileInput
        : Array.from(fileInput?.files || (Array.isArray(fileInput?.files) ? fileInput.files : []));
    if ((!files || files.length === 0) && !options.atomicPackageChanges?.switchGroup) return;

    const fileCount = files.length;
    const isBatch = fileCount > 1;

    let atomicContext = options.restoreContext;
    if (options.atomicPackageChanges) window._modHubLastInstallError = '';
    window.modHubShowToast(!fileCount ? '正在应用模组配置...' : isBatch ? `正在解析并批量导入 ${fileCount} 个模组文件...` : '正在解析并导入模组文件...', 'warning');
    try {
        const imported = await window.modHubRunManagerAction(async () => {
            let installedNames = [];
            const beforeSide = new Set([
                ...(gui.listSideLoadModNameOnly ? await gui.listSideLoadModNameOnly() : []),
                ...(gui.listSideLoadHiddenModNameOnly ? await gui.listSideLoadHiddenModNameOnly() : [])
            ]);
            // 旧 GUI 可能仅支持 Zip；ModPack 及移动端 BIN 等文件统一走原生校验接口。
            const needsNativeCheck = files.some(file => !MODHUB_ZIP_PACKAGE_EXTENSION.test(file.name || ''));
            if (needsNativeCheck && typeof window.modHubGetController()?.checkModZipFileIndexDB !== 'function') {
                throw new Error('当前 ModLoader 未提供 ModPack 校验接口，无法核验此二进制安装包；请使用支持该格式的加载器或作者提供的 Zip 包。');
            }
            // 市场前置状态在统一操作锁内再次核验，检查失败不能写入包体。
            if (typeof options.beforeImport === 'function') await options.beforeImport();
            if (options.atomicPackageChanges) {
                installedNames = await modHubCommitImportedPackages(files, options.atomicPackageChanges, atomicContext);
            } else if (fileCount === 1 && !needsNativeCheck && typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(fileInput);
                window.modHubMarket?.invalidateLocalPackageProfiles?.();
                const lists = await window.modHubReadIndexDBModLists();
                if (!lists.ok) throw new Error('导入后无法核验模组加载顺序');
                await window.modHubLoadDisabledModInfo(lists.enabled);
                if (JSON.stringify(lists.enabled) !== JSON.stringify(window.modHubKeepRecoveryOrder(lists.enabled))) {
                    await window.modHubSaveIndexDBModList(lists.enabled, lists.disabled);
                }
            } else if (typeof window.modHubInstallFilesViaIndexDB === 'function') {
                const installed = await window.modHubInstallFilesViaIndexDB(files);
                installedNames = (installed || []).map(result => result.modName).filter(Boolean);
            } else {
                throw new Error('未找到可用的模组安装接口');
            }
            // 安装已经落盘，后续状态刷新与美化扫描属于「尽力而为」，
            // 绝不允许它们的异常把一次成功的安装回判成失败（否则市场会给出误导性结论并跳过版本确权）。
            let state = null;
            try {
                state = await window.modHubLoadModManageState(true);
            } catch (error) {
                if (options.atomicPackageChanges) throw Object.assign(new Error(`安装已经提交，但管理配置回读未完成：${error.message}`), { committed: true });
                console.warn('[ModHub] 安装后刷新模组列表失败，可稍后手动刷新:', error);
            }
            try {
                await window.modHubLoadBeautyState();
            } catch (error) {
                console.warn('[ModHub] 安装后刷新美化配置失败，可稍后手动刷新:', error);
            }
            return {
                beforeSide,
                installedNames,
                afterEnabled: state?.sideEnabled || [],
                afterDisabled: state?.sideDisabled || []
            };
        }, '正在导入模组，请稍候...', { busyKey: 'modHubImportModBtn', restoreContext: options.restoreContext, restoreLabel: isBatch ? '批量导入模组' : '导入模组',
            onRestoreContext: context => { atomicContext = context; },
            onError: error => { if (options.atomicPackageChanges) window._modHubLastInstallError = error.message || String(error); }
        });
        if (!imported) {
            // 记录可读原因供市场端展示，避免只抛出含糊的「安装未完成」
            window._modHubLastInstallError = window._modHubLastInstallError || window._modHubManagerStatus || '模组管理器正忙或配置状态待核实';
            return false;
        }
        window._modHubLastInstallError = '';
        const { beforeSide, installedNames, afterEnabled, afterDisabled } = imported;
        const afterAll = [...afterEnabled, ...afterDisabled];
        const newlyAdded = afterAll.filter(name => !beforeSide.has(name));
        const verifiedNames = (installedNames || []).filter(name => afterAll.some(item => item.toLowerCase() === name.toLowerCase()));
        const affectedNames = window.modHubUniqueModNames([...verifiedNames, ...newlyAdded]);

        // 确定目标模组名称：仅采用可验证来源，禁止误取启用列表末项。
        const expectedName = String(options.targetModName || '').trim();
        const exactExpected = expectedName
            ? afterAll.find(name => name.toLowerCase() === expectedName.toLowerCase())
            : null;
        const sourceFileName = files[0]?.name || '';
        const targetModName = exactExpected || verifiedNames[verifiedNames.length - 1] || newlyAdded[newlyAdded.length - 1] ||
            window.modHubResolveImportedModName(sourceFileName, afterAll, options.displayName || expectedName);
        const targetDisplayName = String(options.displayName || '').trim() || targetModName;

        if (fileInput && typeof fileInput === 'object' && 'value' in fileInput) {
            fileInput.value = '';
        }
        if (typeof window.modHubUpdateGeneralInfo === 'function') {
            window.modHubUpdateGeneralInfo();
        }

        // ===== 快捷添加模式：导入后询问是否立即重启游戏生效 =====
        if (options && (options.askRestart || options.promptReload) && !options.skipReloadOffer) {
            const isFramework = (affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : [])).some(name => window.modHubIsFrameworkMod(name)) || window.modHubIsFrameworkMod(targetDisplayName);
            const label = isBatch ? `${fileCount} 个模组` : (targetDisplayName ? `模组【${targetDisplayName}】` : '模组');
            if (options.restoreContext) {
                window.modHubRegisterOperationReload(options.restoreContext, `${label}已成功添加并完成配置。`, { isFramework });
                window._modHubHighlightMods = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
                return true;
            }
            if (window.modHubIsReloadBlocked()) return true;
            if (isFramework) {
                await window.modHubOfferReload(`${label}已成功添加并完成配置。`, { isFramework: true });
                if (options.keepCurrentTab) {
                    window._modHubHighlightMods = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
                } else {
                    window._modHubHighlightMods = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
                    const switched = window.modHubSwitchTab ? window.modHubSwitchTab('模组管理', { skipReloadPrompt: true }) : false;
                    if (!switched || document.getElementById('modHubModManageContainer')) {
                        if (typeof window.initModManage === 'function') {
                            await window.initModManage();
                        }
                    }
                }
                return true;
            }

            const reloadRevision = window._modHubReloadRevision;
            const message = `${label}已成功添加并完成配置！\n\n是否立即重新载入游戏以使模组生效？\n\n重新载入可能丢失尚未存档的游戏进度，请先存档。`;
            const ok = await window.modHubConfirm({
                title: '重新载入游戏',
                message,
                trustedMessageHtml: window.modHubFormatReloadMessage(message),
                confirmText: '立即重载',
                cancelText: '稍后重载',
                confirmType: 'primary'
            });
            window.modHubAcknowledgeReloadPrompt(reloadRevision);
            if (ok) {
                window.modHubShowToast('正在重新载入游戏...', 'warning');
                window.modHubRestartGame();
            } else if (options.keepCurrentTab) {
                // 模组市场安装场景：玩家通常需要连续安装多个模组，
                // 「稍后重载」后必须停留在市场页签，绝不切走打断浏览。
                window._modHubHighlightMods = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
                window.modHubShowToast(`${label}已添加完成。全部安装完成后可手动点击【重新载入游戏】生效。`, 'info');
            } else {
                window._modHubHighlightMods = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
                window.modHubShowToast(`${label}已添加完成，已在列表中标出。全部操作完成后可手动点击【重新载入游戏】生效。`, 'info');
                const switched = window.modHubSwitchTab ? window.modHubSwitchTab('模组管理', { skipReloadPrompt: true }) : false;
                if (!switched || document.getElementById('modHubModManageContainer')) {
                    if (typeof window.initModManage === 'function') {
                        await window.initModManage();
                    }
                }
            }
            return true;
        }

        // 兼容原有的静默直接重启参数
        if (options && options.autoRestart) {
            const label = isBatch ? `${fileCount} 个模组` : (targetDisplayName ? `模组【${targetDisplayName}】` : '模组');
            window.modHubShowToast(`${label}快捷添加成功，正在自动重新载入游戏...`, 'success');
            window.modHubRestartGame();
            return true;
        }

        if (isBatch) {
            // ===== 批量导入场景：坚决不强行切页面，全量高亮保留在模组管理界面 =====
            const highlightSet = new Set(affectedNames.length > 0 ? affectedNames : (targetModName ? [targetModName] : []));
            window._modHubHighlightMods = highlightSet;

            // 统计包含 ReadMe 的模组数量
            let readmeCount = 0;
            if (typeof window.modHubReadLocalReadme === 'function') {
                for (const name of highlightSet) {
                    try {
                        const r = await window.modHubReadLocalReadme(name);
                        if (window.modHubHasReadmeContent(r)) {
                            readmeCount++;
                        }
                    } catch (_) {}
                }
            }

            const readmeNote = readmeCount > 0 ? `（其中 ${readmeCount} 个包含说明文档）` : '';
            window.modHubShowToast(`已成功导入 ${highlightSet.size || fileCount} 个模组${readmeNote}，已在列表中高亮标出。`, 'success');

            if (!options?.keepCurrentTab) {
                const switched = window.modHubSwitchTab('模组管理', { skipReloadPrompt: true });
                if (!switched || document.getElementById('modHubModManageContainer')) {
                    if (typeof window.initModManage === 'function') {
                        await window.initModManage();
                    }
                }
            }
            const shouldOfferReload = (!options || !options.skipReloadOffer) && options?.askRestart !== false && !options?.keepCurrentTab;
            const hasFramework = Array.from(highlightSet).some(name => window.modHubIsFrameworkMod(name));
            if (hasFramework && shouldOfferReload) {
                await window.modHubOfferReload(`已成功导入 ${highlightSet.size || fileCount} 个模组（含核心框架）。`, { isFramework: true });
            }
        } else {
            // ===== 单模组导入场景：依是否有 ReadMe 智能分流 =====
            let hasReadme = false;
            if (targetModName && typeof window.modHubReadLocalReadme === 'function') {
                try {
                    const readme = await window.modHubReadLocalReadme(targetModName);
                    if (window.modHubHasReadmeContent(readme)) {
                        hasReadme = true;
                    }
                } catch (err) {
                    console.warn('[ModHub] 检测 ReadMe 异常', err);
                }
            }

            if (options?.keepCurrentTab) {
                window._modHubHighlightMods = new Set(targetModName ? [targetModName] : []);
            } else if (hasReadme) {
                window._modHubSelectedMod = targetModName;
                window.modHubShowToast(`模组【${targetDisplayName || targetModName}】导入成功，已为您打开说明文档。`, 'success');
                window.modHubSwitchTab('模组说明', { skipReloadPrompt: true });
                if (typeof window.modHubSelectReadmeMod === 'function') {
                    window.modHubSelectReadmeMod(targetModName);
                }
            } else {
                window._modHubHighlightMods = new Set(targetModName ? [targetModName] : []);
                const label = targetDisplayName ? `模组【${targetDisplayName}】` : '模组';
                window.modHubShowToast(`${label}导入成功，已在列表中高亮定位。`, 'success');
                const switched = window.modHubSwitchTab('模组管理', { skipReloadPrompt: true });
                if (!switched || document.getElementById('modHubModManageContainer')) {
                    if (typeof window.initModManage === 'function') {
                        await window.initModManage();
                    }
                }
            }

            const shouldOfferReload = (!options || !options.skipReloadOffer) && options?.askRestart !== false && !options?.keepCurrentTab;
            if (shouldOfferReload && window.modHubIsFrameworkMod(targetModName || targetDisplayName)) {
                await window.modHubOfferReload(`核心框架【${targetDisplayName || targetModName}】已成功导入。`, { isFramework: true });
            }
        }
        return true;
    } catch (e) {
        console.error('[ModHub] 添加模组失败', e);
        window._modHubLastInstallError = e?.message || String(e);
        window.modHubShowToast('添加模组失败: ' + (e.message || e), 'warning');
        return false;
    }
};


// 重新排列列表项并持久化保存
window.modHubReorderList = async function(listType, fromIndex, targetIndex, isAfter) {
    let moved, toIndex;
    return window.modHubRunManagerAction(async () => {
        if (listType === 'side') {
            if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
            window.modHubShowToast(`已将【${moved.name}】排序调整至第 ${toIndex + 1} 位`, 'success');
        } else {
            if (!await window.modHubSaveBeautyState(false)) throw new Error('美化配置保存失败');
            window.modHubShowToast(`已将美化包【${moved.type}】覆盖优先级调整至第 ${toIndex + 1} 位`, 'success');
        }
    }, undefined, { trackReload: true, updateState: () => {
        if (!['side', 'beauty'].includes(listType) || !Number.isInteger(fromIndex) || !Number.isInteger(targetIndex)) return false;
        toIndex = isAfter ? targetIndex + 1 : targetIndex;
        if (fromIndex < toIndex) toIndex--;
        if (fromIndex === toIndex) return false;
        const state = listType === 'side' ? window._modHubModState : window._modHubBeautyState;
        if (listType === 'side') window.modHubEnsureModStateSync(state);
        const list = listType === 'side' ? state?.sideMods : state?.enabledList;
        if (!list || fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return false;
        [moved] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, moved);
        if (listType === 'side') window.modHubEnsureModStateSync(state);
    } });
};

// 保证模组状态中 sideMods 与 sideEnabled/sideDisabled 双向同步
window.modHubEnsureModStateSync = function(state) {
    if (!state) return;
    const enabled = window.modHubUniqueModNames(state.sideEnabled);
    const enabledNames = new Set(enabled.map(name => name.trim().toLowerCase()));
    const disabled = window.modHubUniqueModNames(state.sideDisabled)
        .filter(name => !enabledNames.has(name.trim().toLowerCase()));

    if (!state.sideMods || !Array.isArray(state.sideMods)) {
        state.sideMods = [
            ...enabled.map(name => ({ name, enabled: true })),
            ...disabled.map(name => ({ name, enabled: false }))
        ];
    } else {
        const seen = new Set();
        state.sideMods = state.sideMods.filter(item => {
            const key = String(item?.name || '').trim().toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const currentNames = new Set(state.sideMods.map(m => m.name.trim().toLowerCase()));
        const hasNewExternalMods = enabled.some(n => !currentNames.has(n.trim().toLowerCase())) ||
            disabled.some(n => !currentNames.has(n.trim().toLowerCase()));
        if (hasNewExternalMods) {
            state.sideMods = [
                ...enabled.map(name => ({ name, enabled: true })),
                ...disabled.map(name => ({ name, enabled: false }))
            ];
        }
    }

    state.sideEnabled = state.sideMods.filter(m => m.enabled).map(m => m.name);
    state.sideDisabled = state.sideMods.filter(m => !m.enabled).map(m => m.name);
};

/* =========================================================================
 * 2. 模组管理模块 (Mod Manager)
 * ========================================================================= */
// 数据读取与界面挂载分开；重复打开共用内存和正在进行的读取。
window.modHubLoadModManageState = function(refresh = false, options = {}) {
    if (window._modHubModLoading) return window._modHubModLoading;
    if (!refresh && window._modHubModState) return Promise.resolve(window._modHubModState);
    const gui = window.modHubGetGui();
    if (!gui) return Promise.reject(new Error('无法获取 ModLoader 实例'));
    window._modHubModLoading = (async () => {
        const [enabled, disabled] = await Promise.all([gui.listSideLoadModNameOnly(), gui.listSideLoadHiddenModNameOnly()]);
        const sideEnabled = window.modHubUniqueModNames(enabled);
        const enabledNames = new Set(sideEnabled.map(name => name.trim().toLowerCase()));
        const sideDisabled = window.modHubUniqueModNames(disabled)
            .filter(name => !enabledNames.has(name.trim().toLowerCase()));
        const allLoaded = window.modHubUniqueModNames(gui.gModUtils?.getModListNameNoAlias ? gui.gModUtils.getModListNameNoAlias() : []);

        // 读取本地存储中持久化的全量统一顺序缓存
        let savedOrder = [];
        try {
            if (typeof localStorage !== 'undefined') {
                // 优先读取 ModHub 设置，兼容旧版键；后续保存只写新键。
                const raw = localStorage.getItem('modhub_sideload_mod_order') ?? localStorage.getItem('dol_opt_sideload_mod_order');
                if (raw) savedOrder = JSON.parse(raw);
            }
        } catch (_) {}

        const enabledSet = new Set(sideEnabled);
        const allSideSet = new Set([...sideEnabled, ...sideDisabled]);
        // 本次刚启用的模组尚未进入运行时，仍需保留它的安装包资料。
        const installedKeys = new Set([...allSideSet].map(name => name.trim().toLowerCase()));
        for (const key of window._modHubDisabledModInfo.keys()) {
            if (!installedKeys.has(key)) window._modHubDisabledModInfo.delete(key);
        }

        // 按照 savedOrder 还原交错顺序，新出现的模组追加在末尾
        const orderedNames = [];
        const seen = new Set();
        if (Array.isArray(savedOrder)) {
            for (const name of savedOrder) {
                if (allSideSet.has(name) && !seen.has(name)) {
                    orderedNames.push(name);
                    seen.add(name);
                }
            }
        }
        for (const name of sideEnabled) {
            if (!seen.has(name)) {
                orderedNames.push(name);
                seen.add(name);
            }
        }
        for (const name of sideDisabled) {
            if (!seen.has(name)) {
                orderedNames.push(name);
                seen.add(name);
            }
        }

        // 保留启用与禁用的交错位置，同时尊重原版管理器写入的新顺序。
        let enabledIndex = 0, disabledIndex = 0;
        const sideMods = orderedNames.map(name => {
            const enabled = enabledSet.has(name);
            return { name: enabled ? sideEnabled[enabledIndex++] : sideDisabled[disabledIndex++], enabled };
        });

        // 区分内置核心模组
        const builtInMods = (window._modHubModState?.builtInMods || allLoaded).filter(name => !allSideSet.has(name));

        window._modHubModState = {
            sideMods,
            sideEnabled: sideMods.filter(m => m.enabled).map(m => m.name),
            sideDisabled: sideMods.filter(m => !m.enabled).map(m => m.name),
            builtInMods: [...builtInMods]
        };

        // 先显示已读到的列表；包体资料、自愈和美化同步仍由初始化锁保护。
        window.modHubRenderModManageUI();
        await window.modHubYieldToBrowser();
        const pendingInfo = sideEnabled.filter(name => !window.modHubGetModInfo(name));
        await window.modHubLoadDisabledModInfo([...sideDisabled, ...pendingInfo], refresh);
        return window._modHubModState;
    })().finally(() => {
        window._modHubModLoading = null;
        if (window._modHubReloadExitPending && !options.deferReloadPrompt) window.modHubPromptPendingReload();
    });
    return window._modHubModLoading;
};

window.modHubUpdateManagerStatus = function() {
    window.modHubRefreshLanguageSelectors?.();
    const busy = !!(window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerInit);
    const controls = document.getElementById('modHubManagerControls');
    if (controls) {
        controls.disabled = busy;
        controls.setAttribute('aria-busy', String(busy));
        controls.querySelectorAll('button[data-modhub-busy-key]').forEach(button => {
            window.modHubSetButtonBusy(button, busy && button.dataset.modhubBusyKey === window._modHubManagerBusyKey);
        });
    }
    const toolsMenu = document.getElementById('modHubManagerToolsMenu');
    toolsMenu?.querySelectorAll('button').forEach(button => {
        if (button.dataset.modhubBusyKey) window.modHubSetButtonBusy(button, busy && button.dataset.modhubBusyKey === window._modHubManagerBusyKey);
        button.disabled = busy;
    });
    const status = document.getElementById('modHubManagerStatus');
    if (status) {
        const message = window._modHubManagerStatus || (busy ? '正在读取配置，请稍候...' : '配置自动保存；模组重新载入后生效，美化即时应用');
        status.innerHTML = modHubTranslateManagerHtml('<span>' + window.modHubEscapeHtml(message) + '</span>');
        status.className = window._modHubManagerSaveFailed ? 'red' : 'grey';
        status.hidden = !window._modHubManagerStatus && !busy && !window._modHubManagerSaveFailed;
    }
};

// ponytail: 共用一把操作锁；确有并行操作需求时再按存储资源拆分。
window.modHubRunManagerAction = async function(action, message = '正在保存，请稍候...', options = {}) {
    const restore = window.modHubRestore;
    const restoreContext = options.restoreContext || restore?.createOperation({ label: options.restoreLabel || '调整模组与美化配置', kind: options.restoreKind,
        packagesUnchanged: options.packagesUnchanged === true });
    const ownRestoreContext = !options.restoreContext;
    if (window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerStateUncertain ||
        window._modHubManagerInit && !options.allowInitializing ||
        restore?.isRestoring() || restore?.isOperationBlocked(restoreContext)) {
        window.modHubShowToast(window._modHubManagerStateUncertain ? '请先刷新列表核实配置，再进行修改。' : '上一项操作尚未完成，请稍候。', 'warning');
        return false;
    }
    const modState = window._modHubModState;
    const beforeMod = modState && {
        ...modState,
        sideMods: modState.sideMods?.map(item => ({ ...item })),
        sideEnabled: [...(modState.sideEnabled || [])], sideDisabled: [...(modState.sideDisabled || [])]
    };
    const beauty = window._modHubBeautyState;
    const beforeBeauty = beauty && { ...beauty, enabledList: [...beauty.enabledList], disabledList: [...beauty.disabledList] };
    const beforeReload = modHubReloadConfigSnapshot(beforeMod, beforeBeauty);
    const previousStatus = window._modHubManagerStatus;
    const reportError = error => {
        // 错误收集不能阻止原有失败恢复及锁释放。
        try { options.onError?.(error); } catch (_) {}
    };
    window._modHubManagerBusy = true;
    window._modHubManagerBusyKey = options.busyKey;
    window._modHubManagerStatus = message;
    window.modHubUpdateManagerStatus();
    const resetState = () => {
        window._modHubModState = beforeMod;
        window._modHubBeautyState = beforeBeauty;
    };
    try {
        if (ownRestoreContext && restore?.claim && !restore.claim(restoreContext)) return false;
        // 先显示待保存配置；还原点仍读取旧的真实存储，取消时撤销预览。
        if (options.updateState) {
            if (await options.updateState() === false) {
                resetState();
                window._modHubManagerStatus = previousStatus;
                return false;
            }
            if (window._modHubModState && beforeReload !== modHubReloadConfigSnapshot(window._modHubModState)) {
                modHubKeepManagerRecoveryOrder(window._modHubModState);
            }
            window.modHubRenderModManageUI();
        }
        await window.modHubYieldToBrowser();
        if (restore && !await restore.prepare(restoreContext)) {
            resetState();
            window._modHubManagerStatus = '已取消操作，配置保持不变';
            return false;
        }
        await options.onRestoreContext?.(restoreContext);
        const result = await action();
        const modChanged = beforeReload !== modHubReloadConfigSnapshot(window._modHubModState);
        window._modHubManagerStatus = result === false ? previousStatus : (modChanged ? '模组配置已保存，重新载入后生效；美化配置即时应用' : '配置已保存，美化配置即时应用');
        if (result !== false) window._modHubManagerSaveFailed = false;
        if (result !== false && options.trackReload) modHubRecordReloadChange(beforeReload);
        return result === undefined ? true : result;
    } catch (error) {
        reportError(error);
        window._modHubModState = beforeMod;
        window._modHubBeautyState = beforeBeauty;
        // 两份模组列表可能只写入了一份，以重新读到的实际记录为准。
        try {
            await window.modHubLoadModManageState(true);
            await window.modHubLoadBeautyState(false);
            window._modHubManagerStateUncertain = error.committed === true;
            if (options.trackReload) modHubRecordReloadChange(beforeReload);
        } catch (_) {
            window._modHubModState = beforeMod;
            window._modHubManagerStateUncertain = true;
        }
        window._modHubManagerSaveFailed = true;
        window._modHubManagerStatus = window._modHubManagerStateUncertain
            ? '操作失败，配置状态待核实，请刷新列表后重试'
            : '操作失败，已重新读取配置，请检查后重试';
        console.error('[ModHub] 管理器操作失败', error);
        window.modHubShowToast(window._modHubManagerStatus + '：' + (error.message || error), 'warning');
        return false;
    } finally {
        if (ownRestoreContext && restore) {
            try { await restore.finish(restoreContext); }
            catch (error) { restoreContext.finishError = error; console.warn('[ModHub] 还原点整理未完成', error); }
            finally { restore.release?.(restoreContext); }
            if (restoreContext.finishError) {
                reportError(restoreContext.finishError);
                window._modHubManagerSaveFailed = true;
                window._modHubManagerStateUncertain = true;
                window._modHubManagerStatus = '还原点整理失败，请刷新列表核验配置后再重载';
            }
        }
        window._modHubManagerBusy = false;
        window._modHubManagerBusyKey = null;
        window.modHubRenderModManageUI();
        window.modHubUpdateManagerStatus();
        if (window._modHubReloadExitPending && !options.immediateReload) window.modHubPromptPendingReload();
    }
};

window.initModManage = async function(refresh = false) {
    window.modHubBindReloadReminder();
    const container = document.getElementById('modHubModManageContainer');
    if (!container) return;
    if (window._modHubModState) window.modHubRenderModManageUI();
    else container.innerHTML = modHubTranslateManagerHtml(window.modHubLoadingHtml('正在读取模组列表...'));
    if (window._modHubManagerInit) return window._modHubManagerInit;
    if (window._modHubManagerBusy) return;
    if (!refresh && window._modHubModState && window._modHubBeautyLoaded && !window._modHubModLoading) return;
    window._modHubManagerBusyKey = 'modHubRefreshListBtn';
    window._modHubManagerBusy = true;
    window._modHubManagerInit = (async () => {
        try {
            window.modHubUpdateManagerStatus();
            await window.modHubYieldToBrowser();
            const loading = window.modHubLoadModManageState(refresh);
            window._modHubManagerBusy = false;
            window.modHubUpdateManagerStatus();
            await loading;
            await window.modHubEnsureRecoveryPlacement(true);
            // 自愈：修复「包体已安装、却未登记进启用列表」的历史遗留模组，
            // 这类模组重启后不会被加载，是市场反复显示未安装 / 可更新的根源之一。
            try {
                if (!window._modHubOrphanRepairDone && typeof window.modHubRepairOrphanModZips === 'function') {
                    window._modHubOrphanRepairDone = true;
                    window._modHubOrphanRepairRequest = (async () => {
                        const repair = await window.modHubRepairOrphanModZips();
                        if (repair?.repaired?.length) await window.modHubLoadModManageState(true);
                    })().finally(() => { window._modHubOrphanRepairRequest = null; });
                }
                if (window._modHubOrphanRepairRequest) await window._modHubOrphanRepairRequest;
            } catch (repairError) {
                console.warn('[ModHub] 已安装未登记模组自愈失败', repairError);
            }
            // 美化自动启用也可能写入配置，初始化期间同样禁止交错操作。
            window._modHubManagerBusy = true;
            await window.modHubLoadBeautyState();
            window._modHubManagerStateUncertain = false;
            if (refresh) {
                window._modHubManagerSaveFailed = false;
                window._modHubManagerStatus = '已同步配置，修改在重新载入后生效';
            }
        } catch (error) {
            window._modHubManagerSaveFailed = true;
            window._modHubManagerStateUncertain = true;
            window._modHubManagerStatus = '读取配置失败，请刷新列表重试';
            console.error('[ModHub] 读取模组列表异常', error);
            if (!window._modHubModState) container.innerHTML = '<div class="mod-empty red">读取模组列表失败，请重新打开管理器重试。</div>';
        } finally {
            window._modHubManagerBusy = false;
            window.modHubRenderModManageUI();
            window.modHubUpdateManagerStatus();
            if (window._modHubReloadExitPending) window.modHubPromptPendingReload();
        }
    })().finally(() => {
        window._modHubManagerInit = null;
        window._modHubManagerBusyKey = null;
        window.modHubUpdateManagerStatus();
        if (window._modHubReloadExitPending) window.modHubPromptPendingReload();
    });
    return window._modHubManagerInit;
};

const MODHUB_MANAGER_TOOLS = [
    { id: 'modHubCompatibilityBtn', label: '兼容性检查', title: '检查已安装模组的依赖和兼容性', action: "window.modHubCompatibility?.show?.() || window.modHubAlert('兼容性检查尚未就绪，请等待模组加载完成后重试。')" },
    { id: 'modHubRestorePointsBtn', label: '时间点还原', title: '查看和还原已保存的模组状态', action: 'window.modHubRestore.showHistory()' }
];

function modHubReadPinnedManagerTools() {
    try {
        const stored = JSON.parse(localStorage.getItem('modhub_manager_pinned_tools') || '[]');
        return Array.isArray(stored) ? [...new Set(stored)].filter(id => MODHUB_MANAGER_TOOLS.some(tool => tool.id === id)) : [];
    } catch (_) { return []; }
}

function modHubManagerToolHtml(tool, pinned = false) {
    return `<button id="${tool.id}${pinned ? 'Pinned' : ''}" ${tool.busy ? `data-modhub-busy-key="${tool.id}"` : ''} ${pinned ? 'class="macro-button modhub-btn-primary modhub-manager-pinned-tool"' : 'class="modhub-manager-tool-action" role="menuitem" tabindex="-1"'} type="button" title="${tool.title}" onclick="${tool.action}">${tool.label}</button>`;
}

function modHubPinnedManagerToolsHtml(pinned) {
    return pinned.map(id => modHubManagerToolHtml(MODHUB_MANAGER_TOOLS.find(tool => tool.id === id), true)).join('');
}

function modHubManagerToolsMenuHtml(pinned) {
    return MODHUB_MANAGER_TOOLS.map(tool => {
        const active = pinned.includes(tool.id), label = `${active ? '取消固定' : '固定'}${tool.label}${active ? '' : '到操作栏'}`;
        return `<div class="modhub-manager-tool-row" role="none">${modHubManagerToolHtml(tool)}<button class="modhub-manager-tool-pin" type="button" tabindex="-1" data-modhub-pin-tool="${tool.id}" aria-label="${label}" title="${label}" aria-pressed="${active}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3h8M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v6"/></svg></button></div>`;
    }).join('');
}

// 工具菜单临时移到页面顶层，避开管理器滚动区域的裁剪。
function modHubBindManagerTools(container) {
    const trigger = container.querySelector?.('#modHubManagerToolsBtn');
    const menu = container.querySelector?.('#modHubManagerToolsMenu');
    if (!trigger || !menu) return;
    const holder = menu.parentNode;
    const open = (last = false) => {
        if (trigger.disabled || trigger.closest?.('fieldset')?.disabled) return;
        if (window.modHubCloseManagerTools) { window.modHubCloseManagerTools(); return; }
        menu.hidden = false;
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        const rect = trigger.getBoundingClientRect();
        const width = document.documentElement.clientWidth || window.innerWidth;
        const height = document.documentElement.clientHeight || window.innerHeight;
        menu.style.maxHeight = Math.max(0, height - 76) + 'px';
        const bounds = menu.getBoundingClientRect();
        const below = height - 68 - rect.bottom;
        const top = below >= bounds.height || below >= rect.top - 8 ? rect.bottom + 6 : rect.top - bounds.height - 6;
        menu.style.left = Math.max(8, Math.min(rect.right - bounds.width, width - bounds.width - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(top, height - 68 - bounds.height)) + 'px';
        menu.style.visibility = '';
        trigger.setAttribute('aria-expanded', 'true');
        const items = () => [...menu.querySelectorAll('button')].filter(button => !button.disabled);
        const close = (restoreFocus = true) => {
            menu.hidden = true;
            holder?.appendChild(menu);
            trigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', keydown, true);
            document.removeEventListener('scroll', scrolled, true);
            window.removeEventListener('resize', resized);
            observer?.disconnect();
            window.modHubCloseManagerTools = null;
            if (restoreFocus && trigger.isConnected !== false) trigger.focus();
        };
        const outside = event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(false); };
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
            if (event.key === 'Tab') { close(); return; }
            if (!menu.contains(event.target) || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const pinColumn = Boolean(document.activeElement?.dataset.modhubPinTool);
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const rowButtons = [...(document.activeElement?.parentNode?.querySelectorAll('button') || [])].filter(button => !button.disabled);
                rowButtons[event.key === 'ArrowLeft' ? 0 : rowButtons.length - 1]?.focus(); return;
            }
            const buttons = items().filter(button => Boolean(button.dataset.modhubPinTool) === pinColumn), index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
        };
        const scrolled = event => { if (!menu.contains(event.target)) close(false); };
        const resized = () => close(false);
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
            if (!trigger.isConnected || !trigger.getClientRects().length) close(false);
        }) : null;
        observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        window.modHubCloseManagerTools = close;
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('scroll', scrolled, true);
        window.addEventListener('resize', resized);
        const buttons = items().filter(button => !button.dataset.modhubPinTool);
        buttons[last ? buttons.length - 1 : 0]?.focus();
    };
    trigger.onclick = () => open();
    trigger.onkeydown = event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault(); open(event.key === 'ArrowUp');
    };
    menu.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (button?.dataset.modhubPinTool) {
            if (button.disabled || trigger.disabled || trigger.closest?.('fieldset')?.disabled) return;
            event.preventDefault(); event.stopPropagation();
            const id = button.dataset.modhubPinTool;
            if (!MODHUB_MANAGER_TOOLS.some(tool => tool.id === id)) return;
            const pinned = modHubReadPinnedManagerTools(), next = pinned.includes(id) ? pinned.filter(value => value !== id) : [...pinned, id];
            try { localStorage.setItem('modhub_manager_pinned_tools', JSON.stringify(next)); }
            catch (_) { window.modHubShowToast('无法保存固定工具设置，请检查浏览器存储权限。', 'warning'); return; }
            const pinnedTools = container.querySelector('#modHubManagerPinnedTools');
            if (pinnedTools) pinnedTools.innerHTML = modHubTranslateManagerHtml(modHubPinnedManagerToolsHtml(next));
            const active = next.includes(id), label = `${active ? '取消固定' : '固定'}${MODHUB_MANAGER_TOOLS.find(tool => tool.id === id).label}${active ? '' : '到操作栏'}`;
            button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-label', label); button.setAttribute('title', label);
            window.modHubUpdateManagerStatus();
            window.modHubCloseManagerTools?.();
            return;
        }
        if (button && !button.disabled) window.modHubCloseManagerTools?.();
    }, true);
}

window.modHubRenderModManageUI = function() {
    window.modHubCloseManagerTools?.(false);
    const container = document.getElementById('modHubModManageContainer');
    if (!container || !window._modHubModState) return;

    window.modHubEnsureModStateSync(window._modHubModState);
    const sectionStates = new Map([...container.querySelectorAll('details[data-section]')].map(detail => [detail.dataset.section, detail.open]));
    const isSectionOpen = (name, defaultOpen = false) => sectionStates.has(name) ? sectionStates.get(name) : defaultOpen;
    const languageControl = container.querySelector('[data-modhub-language-control]');
    const gui = window.modHubGetGui();
    const { sideMods, builtInMods } = window._modHubModState;
    const recoveryNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const totalSideCount = sideMods ? sideMods.length : 0;
    const beautyCount = (window._modHubBeautyState?.enabledList.length || 0) + (window._modHubBeautyState?.disabledList.length || 0);
    const pinnedTools = modHubReadPinnedManagerTools();

    let html = '<fieldset id="modHubManagerControls" class="modhub-manager-controls">';

    // 1. 保留统计与更新入口，使用紧凑总览。
    html += '<div id="modHubEnvInfo" class="modhub-manager-overview"></div>';
    html += '<div id="modHubUpdateBanner" style="display:none;"></div>';

    // 2. 界面偏好与常用操作随页面自然滚动。
    html += `
        <div class="modhub-manager-preferences">
                <div class="modhub-manager-language"><span>界面语言</span><div id="modHubManagerLanguageControl"></div></div>
                <label class="modhub-safemode-label" title="开启后仅加载签名模组，可用于排查异常 Mod">
                    <input type="checkbox" id="toggleSafeMode" class="macro-checkbox" />
                    <span class="gold">安全模式</span>
                </label>
        </div>
        <div class="modhub-sticky-toolbar">
            <div id="modHubManagerStatus" class="grey" role="status" aria-live="polite"></div>
            <div class="modhub-group-header modhub-manager-actionbar">
                <div class="modhub-header-actions">
                    <button id="modHubImportModBtn" data-modhub-busy-key="modHubImportModBtn" class="macro-button modhub-btn-primary" type="button" title="从本地选择或直接拖拽 Zip / ModPack 模组文件导入" onclick="window.modHubTriggerImport()">导入模组</button>
                    <button id="modHubRestartGameBtn" class="macro-button modhub-btn-primary" type="button" title="重新载入游戏以使最新模组配置生效，美化调整即时应用" onclick="window.modHubRestartGame()">重新载入游戏</button>
                    <button id="modHubSmartSortAllBtn" data-modhub-busy-key="modHubSmartSortAllBtn" class="macro-button modhub-btn-primary" type="button" title="根据依赖整理模组的加载顺序和美化包的覆盖顺序" onclick="window.modHubSmartSortAll()">智能排序</button>
                    <div id="modHubManagerPinnedTools" class="modhub-manager-pinned-tools">${modHubPinnedManagerToolsHtml(pinnedTools)}</div>
                    <div class="modhub-manager-secondary-actions">
                    <button id="modHubRefreshListBtn" data-modhub-busy-key="modHubRefreshListBtn" class="macro-button modhub-btn-secondary modhub-manager-refresh" type="button" aria-label="刷新" title="在原版管理器修改后，重新读取列表与模组资料" onclick="window.initModManage(true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.8L21 8M21 3v5h-5"/></svg></button>
                    <div class="modhub-manager-tools">
                        <button id="modHubManagerToolsBtn" class="macro-button modhub-manager-tools-toggle" type="button" aria-haspopup="menu" aria-controls="modHubManagerToolsMenu" aria-expanded="false">更多工具</button>
                        <div id="modHubManagerToolsMenu" class="modhub-manager-tools-menu" role="menu" aria-label="更多工具" hidden>
                            ${modHubManagerToolsMenuHtml(pinnedTools)}
                        </div>
                    </div>
                    </div>
                </div>
            </div>
            <details class="modhub-manager-help grey" data-section="manager-help"${isSectionOpen('manager-help') ? ' open' : ''}>
                <summary>排序操作说明</summary>
                <p>智能整理会按依赖调整模组与美化顺序；也可拖拽手动排序，长按上下按钮可置顶或置底。</p>
                <p>配置自动保存；模组重新载入后生效，美化即时应用</p>
            </details>
            ${totalSideCount > 0 && window._modHubBatchMode ? `
                <div id="modHubBatchToolbar" class="modhub-batch-toolbar">
                    <div class="modhub-batch-info">
                        已选择 <span id="modHubBatchCount" class="gold">${window._modHubSelectedMods ? window._modHubSelectedMods.size : 0}</span> 个模组
                    </div>
                    <div class="modhub-batch-actions">
                        <button class="macro-button modhub-btn-primary modhub-batch-btn" type="button" onclick="window.modHubBatchSelectAll()">全选</button>
                        <button class="macro-button modhub-btn-primary modhub-batch-btn" type="button" onclick="window.modHubBatchInvertSelect()">反选</button>
                        <button class="macro-button modhub-btn-primary modhub-batch-btn" data-batch-action="enable" data-modhub-busy-key="batch:enable" type="button" onclick="window.modHubBatchEnable()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}>批量启用</button>
                        <button class="macro-button modhub-btn-primary modhub-batch-btn" data-batch-action="disable" data-modhub-busy-key="batch:disable" type="button" onclick="window.modHubBatchDisable()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}>批量禁用</button>
                        <button class="macro-button modhub-btn-delete modhub-batch-btn" data-batch-action="delete" data-modhub-busy-key="batch:delete" type="button" onclick="window.modHubBatchDelete()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}><span class="red">批量删除</span></button>
                        <button id="modHubBatchToggleBtn" class="macro-button modhub-btn-cancel modhub-batch-btn" type="button" onclick="window.modHubToggleBatchMode(false)">退出多选</button>
                    </div>
                </div>
            ` : ''}
        </div>
        <input type="file" id="modHubImportFileInput" accept="${MODHUB_IMPORT_ACCEPT}" multiple style="display:none;" />
        <details class="modhub-collapsible-section" data-section="side"${isSectionOpen('side', true) ? ' open' : ''}>
            <summary class="modhub-section-summary">已安装模组 - 共 ${totalSideCount} 个</summary>
            <div class="modhub-section-content">
                ${totalSideCount > 0 && !window._modHubBatchMode ? `
                    <div class="modhub-list-toolbar">
                        <button id="modHubBatchToggleBtn" class="macro-button modhub-btn-primary" type="button" title="进入批量多选模式，支持批量启用、禁用与删除" onclick="window.modHubToggleBatchMode(true)">多选操作</button>
                    </div>
                ` : ''}
    `;

    // 旁加载模组（启用与禁用归入同排序组，全量参与排序）
    if (!sideMods || sideMods.length === 0) {
        html += '<div class="mod-empty grey">当前暂无已安装模组，可点击上方【导入模组】添加 Zip / ModPack 文件。</div>';
    } else {
        const updatableMap = window._modHubUpdatableMap;
        html += '<ul class="modhub-list">';
        sideMods.forEach((item, index) => {
            const modName = item.name;
            const isEnabled = item.enabled;
            const isRecovery = recoveryNames.has(modName.toLowerCase());
            const modInfo = window.modHubGetModInfo(modName);
            const version = modInfo?.bootJson?.version || '';
            const subText = window.modHubGetModSubtext(modName, modInfo, false);
            const versionText = version ? (window.modHubFormatVersion ? window.modHubFormatVersion(version) : (/^v/i.test(version.trim()) ? version.trim() : 'v' + version.trim())) : '';

            // 检查是否有可升级新版本
            const updateInfo = updatableMap ? (updatableMap.get(modName) || updatableMap.get(modName.toLowerCase())) : null;
            const newVerText = updateInfo?.newVersion ? (window.modHubFormatVersion ? window.modHubFormatVersion(updateInfo.newVersion) : updateInfo.newVersion) : '';
            const updateTagHtml = `<span class="gold modhub-update-tag" style="font-weight:bold;${newVerText ? '' : 'display:none;'}">${newVerText ? ` | [可更新 -&gt; ${window.modHubEscapeHtml(newVerText)}]` : ''}</span>`;
            const updateBtnHtml = `<button class="macro-button modhub-btn-primary btn-inline-update" data-mod-action="update" title="${newVerText ? `立即升级至 ${window.modHubEscapeHtml(newVerText)}` : ''}"${newVerText ? '' : ' style="display:none;"'}>更新</button>`;

            const descParts = [];
            if (isRecovery) descParts.push('<span class="gold">为确保时间点还原正常运行，不可调整顺序</span>');
            if (isEnabled) {
                if (versionText) descParts.push(window.modHubEscapeHtml(versionText));
                if (subText) descParts.push(`<span class="modhub-mod-alias" data-modhub-no-translate>${window.modHubEscapeHtml(subText)}</span>`);
            } else {
                descParts.push('<span>已禁用</span>');
                if (subText) descParts.push(`<span class="modhub-mod-alias" data-modhub-no-translate>${window.modHubEscapeHtml(subText)}</span>`);
            }
            const descHtml = descParts.join(' | ') || '<span class="grey">外部模组</span>';
            const isHighlight = window._modHubHighlightMods && window._modHubHighlightMods.has(modName);
            const isBatchMode = !!window._modHubBatchMode;
            const isSelected = isBatchMode && window._modHubSelectedMods && window._modHubSelectedMods.has(modName);

            html += `
                <li class="modhub-item ${isEnabled ? '' : 'item-disabled'} ${isHighlight ? 'modhub-item-highlight' : ''} ${isBatchMode ? 'modhub-batch-active' : ''} ${isSelected ? 'modhub-item-selected' : ''}" data-mod-name="${window.modHubEscapeHtml(modName)}" data-index="${index}" data-drag-type="side" draggable="${!isRecovery && !isBatchMode}">
                    <div class="modhub-item-info">
                        ${isBatchMode ? `
                            <label class="modhub-batch-check-wrap" onclick="event.stopPropagation();">
                                <input type="checkbox" class="macro-checkbox modhub-batch-checkbox" data-mod-name="${window.modHubEscapeHtml(modName)}" ${isSelected ? 'checked' : ''} ${isRecovery ? 'disabled title="系统保护模组，不可批量操作"' : ''} />
                            </label>
                        ` : (isRecovery ? '<span class="gold modhub-status-tag">[固定]</span>' : '<span class="modhub-drag-handle grey" title="按住拖拽调整加载顺序" aria-label="拖拽手柄">⋮⋮</span>')}
                        <div class="modhub-item-main">
                            <div class="modhub-item-title ${isEnabled ? '' : 'grey'}" data-modhub-no-translate>${window.modHubEscapeHtml(modName)}</div>
                            <div class="grey modhub-item-desc">${descHtml}${updateTagHtml}</div>
                        </div>
                    </div>
                    <div class="modhub-btn-group">
                        ${updateBtnHtml}
                        <button data-modhub-busy-key="${window.modHubEscapeHtml('side:up:' + modName)}" class="macro-button modhub-btn-move modhub-side-move-up" data-index="${index}" title="上移一位（长按直接置顶）" aria-label="上移或置顶" ${isRecovery ? 'disabled' : ''}>▲</button>
                        <button data-modhub-busy-key="${window.modHubEscapeHtml('side:down:' + modName)}" class="macro-button modhub-btn-move modhub-side-move-down" data-index="${index}" title="下移一位（长按直接置底）" aria-label="下移或置底" ${isRecovery ? 'disabled' : ''}>▼</button>
                        <button class="macro-button modhub-btn-toggle ${isEnabled ? '' : 'btn-enable'}" data-mod-action="toggle" data-modhub-busy-key="${window.modHubEscapeHtml('side:toggle:' + modName)}" title="${isEnabled ? '禁用该模组' : '启用该模组'}">${isEnabled ? '禁用' : '启用'}</button>
                        <button class="macro-button modhub-btn-delete btn-delete" data-mod-action="delete" data-modhub-busy-key="${window.modHubEscapeHtml('side:delete:' + modName)}" title="永久删除该模组"><span class="red">删除</span></button>
                    </div>
                </li>
            `;
        });
        html += '</ul>';
    }
    html += '</div></details>';

    // 分组 2: 美化图像包（来自旁加载模组，可独立控制覆盖顺序）
    html += `
        <details class="modhub-collapsible-section" data-section="beauty"${isSectionOpen('beauty') ? ' open' : ''}>
            <summary class="modhub-section-summary">美化图像包 - 共 ${beautyCount} 个</summary>
            <div id="modHubBeautyContainer" class="modhub-section-content"></div>
        </details>
    `;

    const builtInList = Array.isArray(builtInMods) ? builtInMods : [];
    const renderCore = () => {
        let content = '<ul class="modhub-list">';
        builtInList.forEach(modName => {
            const modInfo = window.modHubGetModInfo(modName);
            const version = modInfo?.bootJson?.version || '';
            const subText = window.modHubGetModSubtext(modName, modInfo, true);
            const versionText = version ? (window.modHubFormatVersion ? window.modHubFormatVersion(version) : (/^v/i.test(version.trim()) ? version.trim() : 'v' + version.trim())) : '';
            const descHtml = [window.modHubEscapeHtml(versionText), subText ? `<span class="modhub-mod-alias" data-modhub-no-translate>${window.modHubEscapeHtml(subText)}</span>` : '']
                .filter(Boolean)
                .join(' | ') || '系统核心组件';
            content += `
                <li class="modhub-item item-readonly">
                    <div class="modhub-item-info">
                        <span class="gold modhub-status-tag">[核心]</span>
                        <div class="modhub-item-main">
                            <div class="modhub-item-title" data-modhub-no-translate>${window.modHubEscapeHtml(modName)}</div>
                            <div class="grey modhub-item-desc">${descHtml}</div>
                        </div>
                    </div>
                </li>
            `;
        });
        return content + '</ul>';
    };
    let coreRendered = isSectionOpen('core'), beautyRendered = isSectionOpen('beauty');

    // 分组 3: 内置模组列表（只读展示）
    html += `
        <details class="modhub-collapsible-section" data-section="core"${coreRendered ? ' open' : ''}>
            <summary class="modhub-section-summary">内置与核心模组 - 共 ${builtInList.length} 个</summary>
            <div id="modHubCoreContainer" class="modhub-section-content">${coreRendered ? renderCore() : ''}</div>
        </details>
    `;

    container.innerHTML = modHubTranslateManagerHtml(html + '</fieldset>');
    const languageSlot = container.querySelector('#modHubManagerLanguageControl');
    if (languageSlot) {
        const control = languageControl || window.modHubCreateLanguageSelector?.();
        if (control) {
            control.open = false;
            languageSlot.appendChild(control);
        }
    }
    modHubBindManagerTools(container);
    window.modHubUpdateManagerStatus();
    container.onclick = async event => {
        const button = event.target?.closest?.('[data-mod-action]');
        const modName = button?.closest?.('li[data-mod-name]')?.dataset.modName;
        if (button && modName) {
            if (button.dataset.modAction === 'update') await window.modHubUpdateModDirectly(modName);
            else if (button.dataset.modAction === 'toggle') await window.modHubToggleSideMod(modName);
            else if (button.dataset.modAction === 'delete') await window.modHubDeleteSideMod(modName);
            return;
        }

        // 批量多选模式下，点击条目空白或文本区域可直接切换选中状态
        if (window._modHubBatchMode) {
            if (event.target?.closest?.('.modhub-batch-check-wrap') || event.target?.closest?.('button')) {
                return;
            }
            const li = event.target?.closest?.('li[data-mod-name][data-drag-type="side"]');
            if (li && li.dataset.modName) {
                const targetMod = li.dataset.modName;
                const recoveryNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
                if (recoveryNames.has(targetMod.toLowerCase())) return;
                const cb = li.querySelector('.modhub-batch-checkbox');
                if (cb && !cb.disabled) {
                    cb.checked = !cb.checked;
                    window.modHubToggleSelectMod(targetMod, cb.checked);
                }
            }
        }
    };

    container.onchange = event => {
        const cb = event.target?.closest?.('.modhub-batch-checkbox');
        if (cb && cb.dataset.modName) {
            window.modHubToggleSelectMod(cb.dataset.modName, cb.checked);
        }
    };
    if (beautyRendered) window.modHubRenderBeautyUI();
    const beautySection = container.querySelector('details[data-section="beauty"]');
    if (beautySection) beautySection.ontoggle = () => {
        if (beautySection.isConnected === false || !beautySection.open || beautyRendered) return;
        beautyRendered = true;
        window.modHubRenderBeautyUI();
        window.modHubUpdateManagerStatus();
    };
    const coreSection = container.querySelector('details[data-section="core"]');
    if (coreSection) coreSection.ontoggle = () => {
        if (coreSection.isConnected === false || !coreSection.open || coreRendered) return;
        coreRendered = true;
        const core = container.querySelector('#modHubCoreContainer');
        if (core) core.innerHTML = modHubTranslateManagerHtml(renderCore());
    };
    window.modHubUpdateManagerStatus();

    // 1. 刷新环境统计看板（原通用页面数据）
    if (typeof window.modHubUpdateGeneralInfo === 'function') {
        window.modHubUpdateGeneralInfo();
    }

    // 2. 绑定安全模式切换开关
    const toggleSafeMode = container.querySelector ? container.querySelector('#toggleSafeMode') : null;
    if (toggleSafeMode && gui && gui.modLoadSwitch) {
        toggleSafeMode.checked = gui.modLoadSwitch.isSafeModeOn();
        toggleSafeMode.onchange = () => window.modHubToggleSafeMode(toggleSafeMode.checked);
    }

    // 3. 为模组管理容器绑定全区域文件拖拽直接导入
    container.ondragover = (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.add('drag-over');
    };
    container.ondragleave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove('drag-over');
    };
    container.ondrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            let input = document.getElementById('modHubImportFileInput');
            if (input) {
                input.files = e.dataTransfer.files;
                await window.modHubHandleAddMod(input, { askRestart: true });
            }
        }
    };

    // 绑定旁加载模组拖拽排序
    const sideUl = container.querySelector ? container.querySelector('.modhub-collapsible-section[data-section="side"] ul.modhub-list') : null;
    if (sideUl && !window._modHubBatchMode && typeof window.modHubBindDragSort === 'function') {
        window.modHubBindDragSort(sideUl, 'side');
    }

    // 批量绑定移动按钮长按手势（上移置顶 / 下移置底）
    if (typeof window.modHubBindAllMoveButtons === 'function') {
        window.modHubBindAllMoveButtons(container);
    }

    // 模组高亮与自动平滑滚动定位
    const highlightSet = window._modHubHighlightMods;
    if (highlightSet && highlightSet.size > 0 && container.querySelectorAll) {
        let firstScrolled = false;
        container.querySelectorAll('li[data-mod-name]').forEach(li => {
            const modName = li.dataset.modName;
            if (highlightSet.has(modName)) {
                li.classList.add('modhub-item-highlight');
                if (!firstScrolled && typeof li.scrollIntoView === 'function') {
                    firstScrolled = true;
                    setTimeout(() => {
                        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 60);
                }
            }
        });
        setTimeout(() => {
            window._modHubHighlightMods = null;
        }, 3000);
    }
};

const MODHUB_FRAMEWORK_IDENTITY_GROUPS = [
    { key: 'maplebirch', aliases: ['maplebirch', '秋枫白桦', '秋枫白桦框架', '枫叶框架', 'maplebirchframework', 'scml-dol-maplebirchframework', 'scmldolmaplebirchframework'] },
    { key: 'simpleframework', aliases: ['simpleframework', '简易框架', 'scmlsimpleframework', 'simpleframeworks', 'Simple Frameworks', 'SimpleFrameworks'] }
];

// 判断模组是否属于核心框架。
window.modHubIsFrameworkMod = function(modName) {
    if (!modName) return false;
    const raw = String(modName).trim();
    if (!raw) return false;
    const normalize = str => String(str || '').toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    const norm = normalize(raw);
    if (!norm) return false;

    // 1. 优先比对框架身份。
    for (const group of MODHUB_FRAMEWORK_IDENTITY_GROUPS) {
        const keys = [group.key, ...(group.aliases || [])].map(normalize);
        if (keys.some(k => norm === k || (k.length >= 3 && norm.includes(k)) || (norm.length >= 3 && k.includes(norm)))) return true;
    }

    // 2. 检查名称字面是否包含 framework 或 框架
    if (norm.toLowerCase().includes('framework') || raw.includes('框架')) {
        return true;
    }

    // 3. 检查 boot.json 信息
    try {
        const info = typeof window.modHubGetModInfo === 'function' ? window.modHubGetModInfo(modName) : null;
        const boot = info?.bootJson || window._modHubDisabledModInfo?.get(norm)?.bootJson;
        if (boot) {
            const bootName = normalize(boot.name);
            if (bootName.includes('framework') || String(boot.name || '').includes('框架')) return true;
            if (Array.isArray(boot.alias)) {
                for (const a of boot.alias) {
                    const normA = normalize(a);
                    if (normA.includes('framework') || String(a || '').includes('框架')) return true;
                }
            }
        }
    } catch (_) {}

    return false;
};

// ponytail: 按成功操作记录提醒批次；需要识别整轮操作改回原状时，再保存会话基准配置。
window._modHubReloadRevision = window._modHubReloadRevision || 0;
window._modHubReloadPromptedRevision = window._modHubReloadPromptedRevision || 0;

function modHubReloadConfigSnapshot(modState) {
    return JSON.stringify([
        modState?.sideMods?.map(item => [item.name, item.enabled]) || [],
        modState?.sideEnabled || [], modState?.sideDisabled || []
    ]);
}

function modHubRecordReloadChange(before) {
    if (before !== modHubReloadConfigSnapshot(window._modHubModState, window._modHubBeautyState)) {
        window._modHubReloadRevision++;
    }
}

window.modHubIsReloadBusy = function() {
    return !!(window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerInit || window.modHubMarket?.isInstallBusy?.() ||
        window.modHubRestore?.isRestoring?.() || window.modHubRestore?.isOperationBlocked?.());
};

window.modHubIsReloadBlocked = function() {
    return window.modHubIsReloadBusy() || !!(window._modHubManagerSaveFailed || window._modHubManagerStateUncertain);
};

window.modHubAcknowledgeReloadPrompt = function(revision) {
    if (window._modHubManagerSaveFailed || window._modHubManagerStateUncertain) return false;
    window._modHubReloadPromptedRevision = Math.max(window._modHubReloadPromptedRevision, revision);
    window._modHubReloadExitPending = false;
    return true;
};

window.modHubPromptPendingReload = function() {
    if (window._modHubReloadPromptPromise) return window._modHubReloadPromptPromise;
    if (window.modHubIsReloadBusy() || window._modHubReloadDialogPending) {
        window._modHubReloadExitPending = true;
        return false;
    }
    if (window.modHubIsReloadBlocked()) return false;
    window._modHubReloadExitPending = false;
    if (window._modHubReloadRevision <= window._modHubReloadPromptedRevision) return false;
    window._modHubReloadPromptPromise = Promise.resolve().then(() =>
        window.modHubOfferReload('模组配置已保存，重新载入后生效。美化配置已即时应用。')
    ).finally(() => { window._modHubReloadPromptPromise = null; });
    return window._modHubReloadPromptPromise;
};

window.modHubBindReloadReminder = function() {
    if (!window._modHubReloadClickBound && document?.addEventListener) {
        window._modHubReloadClickBound = true;
        const isManageVisible = () => {
            const overlay = document.getElementById('customOverlay');
            return overlay?.dataset?.overlay === 'modloader' && !overlay.classList.contains('hidden') &&
                !overlay.parentElement?.classList.contains('hidden') && !!document.getElementById('modHubModManageContainer');
        };
        document.addEventListener('click', event => {
            if (window._modHubSkipReloadPrompt || event.target?.closest?.('.modhub-modal-backdrop') || !isManageVisible()) return;
            queueMicrotask(() => { if (!isManageVisible()) window.modHubPromptPendingReload(); });
        }, true);
    }
    if (!window._modHubReloadCloseBound && typeof $ === 'function') {
        window._modHubReloadCloseBound = true;
        $(document).on(':oncloseoverlay', (_event, key) => {
            if (key === 'modloader' && !window._modHubSkipReloadPrompt) window.modHubPromptPendingReload();
        });
    }
};

// 共享安装操作仅登记一次提示，由拥有上下文的最外层在整理与解锁后展示。
window.modHubRegisterOperationReload = function(context, message = '配置已更新。', options = {}) {
    if (!context || context.reloadOfferConsumed) return false;
    context.reloadOffer = { message, isFramework: Boolean(options.isFramework || context.reloadOffer?.isFramework) };
    return true;
};

window.modHubCompleteOperationReload = async function(context) {
    if (!context?.finished || context.reloadOfferConsumed || !context.reloadOffer) return false;
    if (context.finishError) {
        window._modHubManagerSaveFailed = true;
        window._modHubManagerStateUncertain = true;
        window._modHubManagerStatus = '还原点整理失败，请刷新列表核验配置后再重载';
        window.modHubUpdateManagerStatus?.();
    }
    if (context.finishError || window._modHubManagerSaveFailed || window._modHubManagerStateUncertain) {
        context.reloadOfferConsumed = true;
        window._modHubReloadExitPending = false;
        return false;
    }
    if (window.modHubIsReloadBusy()) return false;
    context.reloadOfferConsumed = true;
    window._modHubReloadExitPending = false;
    return window.modHubOfferReload(context.reloadOffer.message, { isFramework: context.reloadOffer.isFramework });
};

window.modHubOfferReload = async function(message = '配置已更新。', options = {}) {
    if (options.restoreContext) return window.modHubRegisterOperationReload(options.restoreContext, message, options);
    if (window.modHubIsReloadBlocked()) return false;
    const revision = window._modHubReloadRevision;
    const isFramework = Boolean(options.isFramework);
    const title = isFramework ? '重新载入游戏（强烈建议）' : '重新载入游戏';
    const confirmText = isFramework ? '立即重新载入' : '立即重载';
    const cancelText = isFramework ? '稍后重载' : '稍后重载';

    let promptMsg = '';
    let trustedMessageHtml = '';

    if (isFramework) {
        promptMsg = `${message}\n\n【强烈建议】：检测到底层核心框架状态发生变更。\n核心框架的加载与 ModLoader 运行时状态强相关，强烈建议立即重新载入游戏以刷新系统状态，确保后续模组冲突检测与正常运行！\n\n是否立即重新载入游戏？`;
        trustedMessageHtml = `
            <div style="line-height: 1.5;">${window.modHubFormatReloadMessage(message)}</div>
            <div class="modhub-modal-framework-alert" style="margin-top: 10px; padding: 10px 14px; background: rgba(255, 170, 0, 0.12); border: 1px solid rgba(255, 170, 0, 0.4); border-radius: 4px;">
                <div class="gold" style="font-weight: bold; margin-bottom: 4px;">强烈建议立即重新载入</div>
                <div class="grey" style="font-size: 0.9em; line-height: 1.45;">
                    检测到底层核心框架状态发生变更。核心框架的加载与 ModLoader 运行时状态强相关，立即重启可刷新系统状态，确保后续模组依赖分析与冲突检测功能准确无误。
                </div>
            </div>
            <div class="grey" style="margin-top: 10px; font-size: 0.9em;">是否立即重新载入游戏？</div>
        `;
    } else {
        promptMsg = `${message}\n\n是否立即重新载入游戏以使配置生效？`;
    }
    const saveNotice = '重新载入可能丢失尚未存档的游戏进度，请先存档。';
    promptMsg += `\n\n${saveNotice}`;
    if (trustedMessageHtml) trustedMessageHtml += `<div class="grey" style="margin-top: 10px;">${window.modHubFormatReloadMessage(saveNotice)}</div>`;

    window._modHubReloadDialogPending = true;
    let ok;
    try { ok = await window.modHubConfirm({
        title,
        message: promptMsg,
        trustedMessageHtml: trustedMessageHtml || window.modHubFormatReloadMessage(promptMsg),
        confirmText,
        cancelText,
        confirmType: isFramework ? 'danger' : 'primary'
    }); } finally { window._modHubReloadDialogPending = false; }
    if (!window.modHubAcknowledgeReloadPrompt(revision)) return false;
    if (!ok) return false;
    window.modHubShowToast('正在重新载入游戏...', 'warning');
    setTimeout(() => {
        window.modHubRestartGame();
    }, 300);
    return true;
};

// 恢复工具及实际前置保持在最早合法位置，其余模组保留玩家的相对顺序。
window.modHubKeepRecoveryOrder = function(names, profiles = []) {
    return window.modHubRestore.keepRecoveryOrder(names, profiles);
};

window.modHubProtectedRecoveryNames = function() {
    const state = window._modHubModState;
    return window.modHubRestore.getRecoveryInfo?.(state?.sideEnabled || [])?.protectedNames || [];
};

window.modHubEnsureRecoveryPlacement = async function(initializing = false) {
    if (!window._modHubModState || window._modHubManagerBusy || window.modHubRestore?.isRestoring()) return false;
    const lists = await window.modHubReadIndexDBModLists();
    if (!lists.ok) return false;
    const info = window.modHubRestore.getRecoveryInfo?.(lists.enabled);
    if (!info) return false;
    if (info.issues.length && !window._modHubRecoveryWarningShown) {
        window._modHubRecoveryWarningShown = true;
        window.modHubShowToast(info.issues.map(item => item.message).join('\n'), 'warning');
    }
    if (JSON.stringify(info.order) === JSON.stringify(lists.enabled)) return true;
    return window.modHubRunManagerAction(async () => {
        if (!await window.modHubSaveModManageState(false)) throw new Error('恢复工具加载顺序保存失败');
        window.modHubShowToast('恢复工具已固定在必要前置之后，下次启动生效。', 'info');
    }, '正在保护并固定恢复工具加载顺序...', { trackReload: true, restoreLabel: '固定恢复工具加载顺序', allowInitializing: initializing });
};

window.modHubBuildSmartOrder = async function(nodes, gui, dependentsFirst = false) {
    const keys = nodes.map(node => node.key);
    const positions = new Map(keys.map((key, index) => [key, index]));
    const dependencies = new Map(keys.map(key => [key, new Set()]));
    const nodesByMod = new Map();
    nodes.forEach(node => {
        if (!node.modName) return;
        if (!nodesByMod.has(node.modName)) nodesByMod.set(node.modName, []);
        nodesByMod.get(node.modName).push(node);
    });

    const bootByMod = new Map();
    const aliases = [];
    nodesByMod.forEach((modNodes, modName) => {
        const boot = modNodes.find(node => node.boot)?.boot || window.modHubGetModInfo(modName)?.bootJson || {};
        bootByMod.set(modName, boot);
        const nickNames = boot.nickName && typeof boot.nickName === 'object' ? Object.values(boot.nickName) : [];
        [modName, ...nickNames].filter(Boolean).forEach(alias => aliases.push([String(alias).trim().toLowerCase(), modName]));
    });

    const resolveModName = value => aliases.find(([alias]) => alias === String(value || '').trim().toLowerCase())?.[1];
    const relations = new Set();
    const addModDependency = (modName, dependencyName) => {
        if (!dependencyName || dependencyName === modName || !nodesByMod.has(dependencyName)) return;
        const relation = `${modName}\u0000${dependencyName}`;
        if (relations.has(relation)) return;
        relations.add(relation);
        nodesByMod.get(modName).forEach(node => nodesByMod.get(dependencyName).forEach(required => {
            if (dependentsFirst) dependencies.get(required.key).add(node.key);
            else dependencies.get(node.key).add(required.key);
        }));
    };

    nodesByMod.forEach((_, modName) => {
        const boot = bootByMod.get(modName);
        [...(boot.dependenceInfo || []), ...(boot.addonPlugin || [])].forEach(item => addModDependency(modName, resolveModName(item.modName)));
    });

    const followers = new Map(keys.map(key => [key, []]));
    const indegree = new Map(keys.map(key => [key, dependencies.get(key).size]));
    dependencies.forEach((required, key) => required.forEach(requiredKey => followers.get(requiredKey).push(key)));
    const ready = keys.filter(key => indegree.get(key) === 0);
    const sortedKeys = [];
    while (ready.length) {
        ready.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
        const current = ready.shift();
        sortedKeys.push(current);
        (followers.get(current) || []).forEach(follower => {
            const nextDegree = (indegree.get(follower) || 0) - 1;
            indegree.set(follower, nextDegree);
            if (nextDegree === 0) ready.push(follower);
        });
    }

    if (sortedKeys.length !== keys.length) {
        console.warn('[ModHub] 检测到循环依赖，保持原有相对顺序');
        return keys;
    }
    return sortedKeys;
};

window.modHubSmartSortAll = async function() {
    let sideChanged = false, beautyChanged = false;
    return window.modHubRunManagerAction(async () => {
        if (sideChanged && !await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
        if (beautyChanged && !await window.modHubSaveBeautyState(false)) throw new Error('美化配置保存失败');

        const details = [];
        if (sideChanged) details.push('旁加载加载顺序');
        if (beautyChanged) details.push('美化覆盖顺序');
        const message = `已按依赖关系智能整理【${details.join(' 与 ')}】`;
        window.modHubShowToast(message, 'success');
        return message;
    }, '正在整理模组与美化顺序，请稍候...', {
        trackReload: true, busyKey: 'modHubSmartSortAllBtn',
        updateState: async () => {
            const gui = window.modHubGetGui();
            if (!gui) {
                window.modHubShowToast('未找到模组管理器实例', 'warning');
                return false;
            }
            if (window._modHubModState) {
                window.modHubEnsureModStateSync(window._modHubModState);
                const sideMods = window._modHubModState.sideMods;
                const sideNodes = sideMods.map(item => ({ key: item.name, modName: item.name }));
                const sortedSideKeys = await window.modHubBuildSmartOrder(sideNodes, gui, false);
                sideChanged = sortedSideKeys.some((name, index) => name !== sideMods[index].name);
                if (sideChanged) {
                    const map = new Map(sideMods.map(m => [m.name, m]));
                    window._modHubModState.sideMods = sortedSideKeys.map(key => map.get(key)).filter(Boolean);
                    window.modHubEnsureModStateSync(window._modHubModState);
                }
            }

            if (window._modHubBeautyState?.enabledList?.length) {
                const beautyNodes = window._modHubBeautyState.enabledList.map(item => ({
                    key: item.type,
                    modName: item.modRef?.name || item.modName || item.type,
                    boot: item.modRef?.bootJson
                }));
                const sortedBeautyKeys = await window.modHubBuildSmartOrder(beautyNodes, gui, true);
                beautyChanged = sortedBeautyKeys.some((type, index) => type !== window._modHubBeautyState.enabledList[index].type);
                if (beautyChanged) {
                    const beautyMap = new Map(window._modHubBeautyState.enabledList.map(item => [item.type, item]));
                    window._modHubBeautyState.enabledList = sortedBeautyKeys.map(key => beautyMap.get(key)).filter(Boolean);
                }
            }

            if (!sideChanged && !beautyChanged) {
                window.modHubShowToast('智能整理完成，暂时无需调整', 'success');
                return false;
            }
        }
    });
};

// 帮助中心只应用已经预览的启用或加载顺序调整，保护与保存仍由管理器协调。
window.modHubApplyHelpConfiguration = async function(plan, { source, onPrepared } = {}) {
    let failureReason = '';
    let pointId = null, restoreContext = null, committed = false, writeAttempted = false;
    const sameNames = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const fail = message => { throw new Error(message); };
    const readNames = (names, label) => {
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim())) fail(`${label}格式无效，请重新检查。`);
        const keys = names.map(name => name.trim().toLowerCase());
        if (new Set(keys).size !== keys.length) fail(`${label}存在名称重复或大小写、空格冲突，请先核实配置。`);
        return [...names];
    };
    const sameMembers = (left, right) => left.length === right.length && left.every(name => right.includes(name));
    try {
        if (source !== undefined && source !== 'remoteRepair') fail('配置修复来源无效，请重新预览。');
        const restore = window.modHubRestore;
        if (!restore || ['createOperation', 'claim', 'release', 'prepare', 'finish', 'isRestoring', 'isOperationBlocked', 'keepRecoveryOrder']
            .some(name => typeof restore[name] !== 'function')) fail('时间点还原尚未就绪，无法保护修复前配置。请重新载入后重试。');
        if (!plan || !['enable', 'order'].includes(plan.type)) fail('修复计划无效，请重新检查。');
        const type = plan.type;
        const enableName = plan.enableName;
        const beforeEnabled = readNames(plan.before?.enabled, '原启用列表');
        const beforeDisabled = readNames(plan.before?.disabled, '原禁用列表');
        const beforeNames = readNames([...beforeEnabled, ...beforeDisabled], '原模组列表');
        const enabled = readNames(plan.enabled, '目标启用列表');
        const disabled = readNames(plan.disabled, '目标禁用列表');
        const targetNames = readNames([...enabled, ...disabled], '目标模组列表');
        if (!sameMembers(beforeNames, targetNames)) fail('修复计划包含安装、移除或更名操作，请重新检查。');
        if (type === 'order') {
            if (!sameMembers(beforeEnabled, enabled) || !sameNames(beforeDisabled, disabled)) fail('加载顺序修复不能更改模组的启用状态或禁用顺序。');
            if (sameNames(beforeEnabled, enabled)) fail('当前加载顺序无需调整。');
        } else {
            if (typeof enableName !== 'string' || !beforeDisabled.includes(enableName)
                || !sameMembers([...beforeEnabled, enableName], enabled)
                || !sameNames(beforeDisabled.filter(name => name !== enableName), disabled)) fail('启用修复只能启用计划中指定的一个已禁用模组。');
            if (typeof window.modHubLoadBeautyState !== 'function') fail('美化配置模块尚未就绪，无法同步模组启用状态。');
        }
        if (!Array.isArray(plan.packages) || plan.packages.length !== beforeNames.length) fail('修复计划缺少完整包体资料，请重新检查。');
        const packageNames = readNames(plan.packages.map(item => item?.name), '包体列表');
        if (!sameMembers(beforeNames, packageNames)) fail('修复计划的包体列表与原配置不一致，请重新检查。');
        const packages = plan.packages.map(item => {
            if (!item.bootJson || typeof item.bootJson !== 'object' || Array.isArray(item.bootJson)) fail(`模组【${item.name}】缺少有效包体声明，请重新检查。`);
            return { name: item.name, bootJson: JSON.stringify(item.bootJson) };
        });
        const profiles = packages.map(item => ({ name: item.name, bootJson: JSON.parse(item.bootJson) }));
        if (source === 'remoteRepair' && type === 'enable') {
            if (typeof restore.getRecoveryInfo !== 'function') fail('恢复工具保护接口尚未就绪，无法继续远程修复。');
            const protectedNames = restore.getRecoveryInfo(beforeNames, profiles).protectedNames || [];
            if (['modhub', 'tweereplacer', ...protectedNames.map(name => name.toLowerCase())].includes(enableName.toLowerCase())) fail('远程修复不能更改恢复工具或必要前置的启用状态，请在模组管理中自行处理。');
        }
        if (!sameNames(window.modHubKeepRecoveryOrder(enabled, profiles), enabled)) fail('修复计划不符合恢复工具及其必要前置的加载顺序，请重新检查。');
        if (typeof window.modHubReadInstalledModBoot !== 'function') fail('包体读取接口尚未就绪，请重新载入后重试。');
        if (window._modHubManagerBusy || window._modHubModLoading || restore.isRestoring() || restore.isOperationBlocked()) fail('已有模组操作尚未完成，请稍候再试。');
        if (window._modHubManagerStateUncertain) fail('当前配置状态待核实，请先刷新列表后重试。');
        await window.modHubLoadModManageState(true, { deferReloadPrompt: true });
        const saved = await window.modHubRunManagerAction(async () => {
            try {
                const current = await window.modHubReadIndexDBModLists();
                if (!current.ok) throw current.error || new Error('无法读取当前模组配置。');
                if (!sameNames(current.enabled, beforeEnabled) || !sameNames(current.disabled, beforeDisabled)) fail('模组配置已改变，请重新检查后再确认修复。');
                for (const item of packages) {
                    const actual = await window.modHubReadInstalledModBoot(item.name);
                    if (actual.error) throw actual.error;
                    if (actual.missing || !actual.bootJson) fail(`模组【${item.name}】的安装包已缺失，请重新检查。`);
                    if (JSON.stringify(actual.bootJson) !== item.bootJson) fail(`模组【${item.name}】的包体声明已改变，请重新检查后再确认修复。`);
                }
                const latest = await window.modHubReadIndexDBModLists();
                if (!latest.ok) throw latest.error || new Error('无法再次核验当前模组配置。');
                if (!sameNames(latest.enabled, beforeEnabled) || !sameNames(latest.disabled, beforeDisabled)) fail('读取包体期间模组配置已改变，请重新检查后再确认修复。');
                const state = window._modHubModState;
                const items = state?.sideMods;
                if (!Array.isArray(items) || !sameMembers(items.map(item => item.name), beforeNames)
                    || !sameNames(items.filter(item => item.enabled).map(item => item.name), beforeEnabled)
                    || !sameNames(items.filter(item => !item.enabled).map(item => item.name), beforeDisabled)) fail('管理器中的配置已改变，请重新检查后再确认修复。');
                if (!sameNames(window.modHubKeepRecoveryOrder(enabled), enabled)) fail('管理器识别的恢复工具顺序与预览不同，请重新检查或重新载入后重试。');
                const byName = new Map(items.map(item => [item.name, item]));
                const enabledNames = new Set(enabled);
                let enabledIndex = 0;
                state.sideMods = items.map(item => enabledNames.has(item.name)
                    ? { ...byName.get(enabled[enabledIndex++]), enabled: true }
                    : { ...item, enabled: false });
                window.modHubEnsureModStateSync(state);
                writeAttempted = true;
                if (!await window.modHubSaveModManageState(false)) fail('模组配置保存失败。');
                committed = true;
                if (type === 'enable') await window.modHubLoadBeautyState();
                const after = await window.modHubReadIndexDBModLists();
                if (!after.ok) throw after.error || new Error('无法回读修复后的模组配置。');
                if (!sameNames(after.enabled, enabled) || !sameNames(after.disabled, disabled)) fail('修复后的实际配置与预览不一致，请刷新列表核验配置。');
                return true;
            } catch (error) {
                failureReason = error?.message || String(error);
                throw error;
            }
        }, '正在保护并保存帮助中心修复...', {
            trackReload: true, immediateReload: true, restoreLabel: source === 'remoteRepair' ? '远程协助修复前' : '帮助中心修复前', restoreKind: source || 'manual',
            onRestoreContext: context => {
                restoreContext = context;
                pointId = context?.pointId || null;
                if (source === 'remoteRepair' && !pointId) fail('未建立远程修复前还原点，已停止写入。');
                return onPrepared?.(pointId);
            },
            onError: error => {
                const reason = error?.message || String(error);
                if (!failureReason) failureReason = reason;
                else if (failureReason !== reason) failureReason += '；' + reason;
            }
        });
        if (writeAttempted && !committed && !window._modHubManagerStateUncertain) {
            const actual = window._modHubModState;
            committed = Boolean(actual && (!sameNames(actual.sideEnabled, beforeEnabled) || !sameNames(actual.sideDisabled, beforeDisabled)));
        }
        if (saved !== true || window._modHubManagerSaveFailed || window._modHubManagerStateUncertain) {
            return { ok: false, pointId, committed, ...(committed || restoreContext?.finishError || window._modHubManagerStateUncertain ? { uncertain: true } : {}), reason: failureReason || window._modHubManagerStatus || '修复未完成，请核实配置后重试。' };
        }
        return { ok: true, pointId, committed };
    } catch (error) {
        return { ok: false, pointId, committed, ...(committed || restoreContext?.finishError ? { uncertain: true } : {}), reason: error?.message || String(error) };
    }
};

// 代码修复只能替换已确认的单个旁加载包，事务不修改启禁配置。
window.modHubApplyAiPackage = async function(plan, { onPrepared } = {}) {
    let pointId = null, restoreContext = null, reason = '', committed = false;
    const fail = message => { throw new Error(message); };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const bytes = value => {
        if (typeof value === 'string') return Uint8Array.from(window.atob(value), character => character.charCodeAt(0));
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
        fail('当前包体存储类型无法在事务内核验，请重新导入普通 Zip 安装包后重试。');
    };
    const equalBytes = (left, right) => {
        const a = bytes(left), b = bytes(right);
        return a.length === b.length && a.every((value, index) => value === b[index]);
    };
    const names = (value, label) => {
        if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim()) ||
            new Set(value.map(name => name.trim().toLowerCase())).size !== value.length) fail(`${label}无效，请重新读取修复材料。`);
        return [...value];
    };
    try {
        const source = plan?.source === undefined ? 'aiRepair' : plan.source;
        if (!['aiRepair', 'remoteRepair'].includes(source)) fail('代码修复来源无效，请重新预览。');
        const repairLabel = source === 'remoteRepair' ? '远程协助' : 'AI';
        const name = plan?.name;
        if (typeof name !== 'string' || !name.trim() || name !== name.trim()) fail('修复模组技术名无效。');
        const enabled = names(plan.enabled, '启用列表'), disabled = names(plan.disabled, '禁用列表');
        names([...enabled, ...disabled], '模组列表');
        if (![...enabled, ...disabled].includes(name)) fail('修复目标不在已保存的旁加载模组列表中。');
        const baseline = bytes(plan.baselineData).slice(), nextBytes = bytes(plan.data).slice();
        if (!baseline.length || !nextBytes.length || equalBytes(baseline, nextBytes)) fail('修复包体为空或没有实际变化。');
        const restore = window.modHubRestore;
        if (!restore || ['createOperation', 'prepare', 'finish', 'claim', 'release', 'getRecoveryInfo', 'isRestoring', 'isOperationBlocked']
            .some(key => typeof restore[key] !== 'function')) fail('时间点还原尚未就绪，无法保护修复前包体。');
        if (['modhub', 'tweereplacer'].includes(name.toLowerCase())) fail(`不能通过 ${repairLabel} 改写 ModHub 或必要恢复前置，请使用作者提供的安装包。`);
        const utils = window.modHubGetGui()?.gModUtils;
        const loader = utils?.getModLoader?.()?.getIndexDBLoader?.(), schema = loader?.constructor;
        if (typeof loader?.customStore !== 'function' || typeof schema?.calcModNameKey !== 'function' ||
            ![schema.dbName, schema.storeName, schema.modDataIndexDBZipList, schema.modDataIndexDBZipListHidden].every(value => typeof value === 'string' && value)) fail('当前 ModLoader 不支持包体替换的真实存储事务。');
        const packageKey = schema.calcModNameKey(name), enabledKey = schema.modDataIndexDBZipList, disabledKey = schema.modDataIndexDBZipListHidden;
        if (new Set([packageKey, enabledKey, disabledKey]).size !== 3) fail('模组存储键冲突，已停止写入。');
        const controller = window.modHubGetController();
        if (typeof controller?.checkModZipFileIndexDB !== 'function') fail('当前 ModLoader 无法校验修复后的安装包。');
        const parseList = raw => raw === undefined || raw === null ? [] : names(typeof raw === 'string' ? JSON.parse(raw) : raw, '仓库启禁列表');
        const transaction = (expected, replacement) => loader.customStore(expected ? 'readwrite' : 'readonly', store => new Promise((resolve, reject) => {
            const tx = store.transaction;
            let error, result, count = 0;
            const abort = cause => { error = cause; try { tx?.abort(); } catch (_) {} reject(cause); };
            if (!tx || store.name !== schema.storeName || tx.db?.name !== schema.dbName) return abort(new Error('模组存储位置已变化，未写入数据。'));
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(error || tx.error || new Error('包体替换事务失败。'));
            const row = {};
            for (const [key, field] of [[packageKey, 'data'], [enabledKey, 'enabledRaw'], [disabledKey, 'disabledRaw']]) {
                const request = store.get(key);
                request.onsuccess = () => {
                    try {
                        row[field] = request.result;
                        if (++count !== 3) return;
                        if (expected && (!equalBytes(row.data, expected.data) || !same(row.enabledRaw, expected.enabledRaw) || !same(row.disabledRaw, expected.disabledRaw))) fail('包体或启禁配置已被其他操作更改，已停止覆盖。');
                        if (expected) store.put(replacement, packageKey);
                        result = row;
                    } catch (cause) { abort(cause); }
                };
            }
        }));
        const saved = await window.modHubRunManagerAction(async () => {
            const original = await transaction();
            if (!same(parseList(original.enabledRaw), enabled) || !same(parseList(original.disabledRaw), disabled)) fail('启禁配置已变化，请重新读取修复材料。');
            if (!equalBytes(original.data, baseline)) fail('修复目标包体已变化，请重新读取源码后分析。');
            const profiles = [];
            for (const item of [...enabled, ...disabled]) {
                const profile = await window.modHubReadInstalledModBoot(item);
                if (profile.error || profile.missing || !profile.bootJson) fail(`无法核验模组【${item}】的包体声明，请先修复安装状态。`);
                profiles.push(profile);
            }
            const protectedNames = restore.getRecoveryInfo([...enabled, ...disabled], profiles).protectedNames || [];
            if (protectedNames.some(value => value.toLowerCase() === name.toLowerCase())) fail(`修复目标属于恢复工具的必要前置，不能通过 ${repairLabel} 改写，请使用作者提供的安装包。`);
            const originalBoot = await controller.checkModZipFileIndexDB(original.data), newBoot = await controller.checkModZipFileIndexDB(nextBytes);
            if (!originalBoot || originalBoot.name !== name || !newBoot || newBoot.name !== name) fail('修复包体更改了模组清单或技术名，已停止写入。');
            if (!same(originalBoot, newBoot)) {
                if (source === 'remoteRepair') fail('远程修复不能修改 boot.json 包体声明。');
                if (!window.modHubAiPackage?.validatePatchBoot) fail('无法核验补丁查找串修改，已停止写入。');
                window.modHubAiPackage.validatePatchBoot(originalBoot, newBoot);
            }
            let replacement;
            if (typeof original.data === 'string') {
                const chunks = [];
                for (let offset = 0; offset < nextBytes.length; offset += 32768) chunks.push(String.fromCharCode(...nextBytes.subarray(offset, offset + 32768)));
                replacement = window.btoa(chunks.join(''));
            } else if (Object.prototype.toString.call(original.data) === '[object ArrayBuffer]') replacement = nextBytes.buffer;
            else replacement = new original.data.constructor(nextBytes.buffer);
            await transaction(original, replacement);
            committed = true;
            window.modHubMarket?.invalidateLocalPackageProfiles?.();
            try {
                const after = await transaction();
                if (!equalBytes(after.data, replacement) || !same(after.enabledRaw, original.enabledRaw) || !same(after.disabledRaw, original.disabledRaw)) fail('修复保存后的实际包体或启禁配置与预览不一致。');
            } catch (error) {
                try {
                    await transaction({ ...original, data: replacement }, original.data);
                    const reverted = await transaction();
                    if (!equalBytes(reverted.data, original.data) || !same(reverted.enabledRaw, original.enabledRaw) || !same(reverted.disabledRaw, original.disabledRaw)) fail('撤销后回读不一致。');
                    committed = false;
                    throw new Error(`${error.message} 本次包体替换已撤销。`);
                } catch (rollbackError) {
                    if (!committed) throw rollbackError;
                    throw new Error(`${error.message} 无法安全撤销：${rollbackError.message} 请使用修复前还原点核对并恢复。`);
                }
            }
            return true;
        }, `正在保护并保存 ${repairLabel} 修复包体...`, {
            restoreLabel: `${source === 'remoteRepair' ? '远程协助' : 'AI '}修复前：${name}`, restoreKind: source, immediateReload: true,
            onRestoreContext: context => {
                restoreContext = context;
                pointId = context?.pointId || null;
                if (!pointId) fail('未建立修复前还原点，已停止写入。');
                return onPrepared?.(pointId);
            },
            onError: error => {
                const detail = error?.message || String(error);
                if (!reason) reason = detail;
                else if (reason !== detail) reason += '；' + detail;
            }
        });
        if (saved !== true || window._modHubManagerSaveFailed || window._modHubManagerStateUncertain) {
            return { ok: false, pointId, committed, ...(committed || restoreContext?.finishError || window._modHubManagerStateUncertain ? { uncertain: true } : {}), reason: committed ? `包体已经写入，但后续核验或还原点整理未完成。${reason ? ` 具体原因：${reason}` : ''} 请使用修复前还原点核对并恢复。` : reason || window._modHubManagerStatus || '修复未完成。' };
        }
        window._modHubReloadRevision++;
        return { ok: true, pointId, committed, reason: '' };
    } catch (error) {
        return { ok: false, pointId, committed, ...(committed || restoreContext?.finishError ? { uncertain: true } : {}), reason: error?.message || String(error) };
    }
};

// 旁加载模组移动（支持短按步进与长按置顶/置底）
window.modHubMoveSideMod = async function(index, deltaOrPosition) {
    let movedName;
    return window.modHubRunManagerAction(async () => {
        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
        if (deltaOrPosition === 'top') window.modHubShowToast(`已将【${movedName}】置顶`, 'success');
        else if (deltaOrPosition === 'bottom') window.modHubShowToast(`已将【${movedName}】置底`, 'success');
    }, undefined, { trackReload: true,
        busyKey: `side:${deltaOrPosition === 'top' || deltaOrPosition < 0 ? 'up' : 'down'}:${window._modHubModState?.sideMods?.[index]?.name}`,
        updateState: () => {
            const state = window._modHubModState;
            if (!state) return false;
            window.modHubEnsureModStateSync(state);
            const list = state.sideMods;
            if (!list || index < 0 || index >= list.length) return false;

            let targetIndex = index;
            if (deltaOrPosition === 'top') {
                targetIndex = 0;
            } else if (deltaOrPosition === 'bottom') {
                targetIndex = list.length - 1;
            } else if (typeof deltaOrPosition === 'number') {
                targetIndex = index + deltaOrPosition;
            }

            if (targetIndex < 0 || targetIndex >= list.length || targetIndex === index) return false;

            const [item] = list.splice(index, 1);
            list.splice(targetIndex, 0, item);
            movedName = item.name;
            window.modHubEnsureModStateSync(state);
        }
    });
};

// 查找本地依赖于指定模组的其它模组列表（用于删除模组或禁用框架时的影响评估）
window.modHubFindDependentMods = async function(targetModName) {
    if (!targetModName) return [];
    const state = window._modHubModState;
    const allMods = state?.sideMods || [];

    const normalize = str => String(str || '').toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    const stripPrefix = str => String(str || '').replace(/^(?:degrees[-_\s]?of[-_\s]?lewdity[-_\s]?|dol[-_\s]?)/i, '');

    // 尝试获取目标模组自身的 bootJson
    const targetModInfo = window.modHubGetModInfo(targetModName);
    const targetBoot = targetModInfo?.bootJson || window._modHubDisabledModInfo?.get(normalize(targetModName))?.bootJson;

    // 1. 判定目标模组匹配到的身份组与其他框架组
    const isNameMatchingGroup = (name, grp) => {
        if (!name) return false;
        const norm = normalize(name);
        const stripped = normalize(stripPrefix(name));
        const grpKeys = [grp.key, ...(grp.aliases || [])].map(normalize);
        return grpKeys.some(k => norm === k || stripped === k || (k.length >= 4 && (norm.includes(k) || (stripped && stripped.includes(k)))));
    };

    const matchingGroup = MODHUB_FRAMEWORK_IDENTITY_GROUPS.find(group =>
        isNameMatchingGroup(targetModName, group) || targetBoot?.name && isNameMatchingGroup(targetBoot.name, group));

    // 其他框架的名称不用于推断本包的依赖。
    const opponentKeySet = new Set(matchingGroup ? MODHUB_FRAMEWORK_IDENTITY_GROUPS.filter(group => group !== matchingGroup)
        .flatMap(group => [group.key, ...(group.aliases || [])].map(normalize)) : []);

    const isOpponentKey = (norm) => {
        if (!norm) return false;
        if (opponentKeySet.has(norm)) return true;
        for (const opp of opponentKeySet) {
            if (opp.length >= 4 && (norm === opp || norm.includes(opp) || opp.includes(norm))) return true;
        }
        return false;
    };

    // 3. 构建目标键集合（排除其他框架标识）
    const targetKeySet = new Set();
    const addKey = (name) => {
        if (!name) return;
        const norm = normalize(name);
        if (!norm || isOpponentKey(norm)) return;
        targetKeySet.add(norm);
        const stripped = normalize(stripPrefix(name));
        if (stripped && stripped.length >= 3 && !isOpponentKey(stripped)) {
            targetKeySet.add(stripped);
        }
    };

    addKey(targetModName);

    if (targetBoot) {
        if (targetBoot.name) addKey(targetBoot.name);
        if (Array.isArray(targetBoot.alias)) targetBoot.alias.forEach(addKey);
        if (typeof targetBoot.nickName === 'string') addKey(targetBoot.nickName);
        else if (typeof targetBoot.nickName === 'object' && targetBoot.nickName) {
            Object.values(targetBoot.nickName).forEach(addKey);
        }
    }

    // 尝试从内置别名字典补充
    const normTarget = normalize(targetModName);
    for (const [k, v] of Object.entries(MODHUB_KNOWN_MOD_ALIASES)) {
        if (normalize(k) === normTarget || normalize(v) === normTarget) {
            addKey(k);
            addKey(v);
        }
    }

    // 若已识别框架身份，仅追加其自身别名
    if (matchingGroup) {
        [matchingGroup.key, ...(matchingGroup.aliases || [])].forEach(addKey);
    }

    const matchesTarget = (name) => {
        if (!name) return false;
        const norm = normalize(name);
        const stripped = normalize(stripPrefix(name));

        // 关键防线：依赖项明确指向其他框架时，不视为依赖本目标模组
        if (isOpponentKey(norm) || (stripped && isOpponentKey(stripped))) {
            return false;
        }

        if (targetKeySet.has(norm) || (stripped && targetKeySet.has(stripped))) return true;
        for (const t of targetKeySet) {
            const isAscii = !/[^\x00-\x7F]/.test(t);
            if (isAscii) {
                if (norm === t || stripped === t) return true;
                if (t.length >= 8 && norm.length >= t.length && (norm.includes(t) || (stripped && stripped.includes(t)))) {
                    const ratio = t.length / norm.length;
                    if (ratio >= 0.8) return true;
                }
                continue;
            }
            if (t.length >= 4 && (norm.includes(t) || (stripped && stripped.includes(t)))) return true;
        }
        return false;
    };

    const isSelf = (name, boot) => {
        if (matchesTarget(name)) return true;
        if (boot?.name && matchesTarget(boot.name)) return true;
        return false;
    };

    const affected = [];
    const seen = new Set();

    for (const item of allMods) {
        const modInfo = window.modHubGetModInfo(item.name);
        const boot = modInfo?.bootJson || window._modHubDisabledModInfo.get(item.name.toLowerCase())?.bootJson || {};
        if (isSelf(item.name, boot)) continue;

        const deps = [
            ...(Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []),
            ...(Array.isArray(boot.addonPlugin) ? boot.addonPlugin : []),
            ...(Array.isArray(boot.dependencies) ? boot.dependencies : []),
            ...(Array.isArray(boot.depends) ? boot.depends : [])
        ];

        let hasDep = false;
        for (const dep of deps) {
            const depName = typeof dep === 'string' ? dep : (dep.modName || dep.name || dep.id);
            if (matchesTarget(depName)) {
                hasDep = true;
                break;
            }
        }

        if (hasDep) {
            const normKey = normalize(item.name);
            if (!seen.has(normKey)) {
                seen.add(normKey);
                const subtext = window.modHubGetModSubtext(item.name, { bootJson: boot }, false, true);
                const displayName = subtext || boot.name || item.name;
                affected.push({
                    name: displayName,
                    rawName: item.name,
                    version: boot.version || '',
                    isEnabled: !!item.enabled
                });
            }
        }
    }

    return affected;
};

// 禁用与卸载共用重点说明，纯文本提示仍保留给调用方。
function modHubSelfRemovalNoticeHtml(uninstall) {
    const recovery = uninstall
        ? '<strong class="gold">重新导入 ModHub</strong> 后可继续使用。'
        : '可通过<strong class="gold">加载器原生管理界面</strong>重新启用 ModHub。';
    return `<div class="modhub-self-removal-notice">
        <section><h3 class="red">重新载入后停用</h3><p>ModHub 的<strong>模组管理、模组市场、时间点还原和加载页救援</strong>将<strong class="red">停用</strong>。</p></section>
        <section><h3 class="green">保留内容</h3><p><strong class="green">游戏存档和已有还原点保留</strong>。</p></section>
        <section><h3 class="gold">恢复使用</h3><p>${recovery}</p></section>
    </div>`;
}

// 旁加载模组启用/禁用就地切换（保持原有排序位置绝对不变）
window.modHubToggleSideMod = async function(modName, enable, options = {}) {
    const state = window._modHubModState;
    if (!state) return false;
    window.modHubEnsureModStateSync(state);

    const item = state.sideMods.find(m => m.name === modName);
    if (!item) return false;

    const targetEnable = enable !== undefined ? !!enable : !item.enabled;
    const isModHub = String(modName).trim().toLowerCase() === 'modhub';
    const selfNotice = isModHub ? '重新载入后，ModHub 的模组管理、模组市场、时间点还原和加载页救援将停用。可通过加载器原生管理界面重新启用 ModHub。游戏存档和已有还原点保留。' : '';
    const selfNoticeHtml = isModHub ? modHubSelfRemovalNoticeHtml(false) : '';
    if (item.enabled === targetEnable) return false;

    // 当即将禁用模组时，进行下游依赖影响排查
    if (!targetEnable && !options.skipConfirm) {
        const affectedMods = typeof window.modHubFindDependentMods === 'function'
            ? await window.modHubFindDependentMods(modName)
            : [];
        if (affectedMods.length > 0) {
            const modInfo = window.modHubGetModInfo(modName);
            const subtext = window.modHubGetModSubtext(modName, modInfo, false, true);
            const displayName = subtext || modName;
            const isFramework = typeof window.modHubIsFrameworkMod === 'function' && window.modHubIsFrameworkMod(modName);
            const targetTypeLabel = isFramework ? '框架' : '模组';

            const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');
            const modItemsHtml = affectedMods.map(m => `
                <div class="modhub-modal-affected-item">
                    · <span class="gold" data-modhub-no-translate>【${escape(m.name)}】</span>${m.version ? ` <span class="grey">(${escape(m.version)})</span>` : ''}${m.isEnabled ? '' : ' <span class="grey">[已禁用]</span>'}
                </div>
            `).join('');
            const modLinesText = affectedMods.map(m => `· 【${m.name}】${m.version ? ` (${m.version})` : ''}${m.isEnabled ? '' : ' [已禁用]'}`).join('\n');

            const confirmProceed = await window.modHubConfirm({
                title: `确认禁用【${displayName}】？`,
                message: `禁用【${displayName}】后，以下依赖该${targetTypeLabel}的模组可能会受到影响或无法正常运行：\n\n${modLinesText}\n\n${selfNotice ? selfNotice + '\n\n' : ''}是否仍然确认禁用？`,
                trustedMessageHtml: `
                    <div class="modhub-modal-intro">禁用 <span class="gold" data-modhub-no-translate>【${escape(displayName)}】</span> 后，以下依赖该${targetTypeLabel}的模组可能会受到影响或无法正常运行：</div>
                    <div class="modhub-modal-affected-box">
                        ${modItemsHtml}
                    </div>
                    ${selfNoticeHtml}
                    <div class="grey modhub-modal-question" style="margin-top:10px;">是否仍然确认禁用该${targetTypeLabel}？</div>
                `,
                confirmText: '确认禁用',
                cancelText: '暂不禁用',
                dialogClass: isModHub ? 'modhub-self-removal-dialog' : '',
                confirmType: 'danger'
            });

            if (!confirmProceed) return false;
        } else if (isModHub && !await window.modHubConfirm({ title: '确认禁用 ModHub', message: selfNotice, trustedMessageHtml: selfNoticeHtml, dialogClass: 'modhub-self-removal-dialog', confirmText: '确认禁用', cancelText: '取消', confirmType: 'danger' })) {
            return false;
        }
    }

    const isFramework = window.modHubIsFrameworkMod(modName);
    const immediateReload = !options.silentOfferReload && (isFramework || isModHub);
    const saved = await window.modHubRunManagerAction(async () => {
        await options.beforeSave?.();
        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');

        // 禁用时始终同步停用所属图包；自动启用开关只控制启用方向。
        await window.modHubLoadBeautyState();

        window.modHubShowToast(`模组【${modName}】已${targetEnable ? '启用' : '禁用'}，重新载入后生效`, 'success');
        return true;
    }, undefined, { trackReload: options.trackReload ?? !options.silentOfferReload, immediateReload,
        busyKey: `side:toggle:${modName}`, packagesUnchanged: true,
        updateState: () => {
            const state = window._modHubModState;
            const item = state?.sideMods?.find(m => m.name === modName);
            if (!item || item.enabled === targetEnable) return false;
            item.enabled = targetEnable;
            window.modHubEnsureModStateSync(state);
        },
        restoreContext: options.restoreContext, restoreLabel: `${targetEnable ? '启用' : '禁用'}模组【${modName}】` });
    if (saved && immediateReload) {
        const modInfo = window.modHubGetModInfo(modName);
        const subtext = window.modHubGetModSubtext(modName, modInfo, false, true);
        const modDisplayName = subtext ? `${modName}（${subtext}）` : modName;
        await window.modHubOfferReload(`${isModHub ? 'ModHub' : `核心框架【${modDisplayName}】`}已${targetEnable ? '启用' : '禁用'}。`, { isFramework });
    }
    return saved;
};

// 永久删除旁加载模组
window.modHubDeleteSideMod = async function(modName) {
    const isModHub = String(modName).trim().toLowerCase() === 'modhub';
    const selfNotice = isModHub ? '重新载入后，ModHub 的模组管理、模组市场、时间点还原和加载页救援将停用。游戏存档和已有还原点保留；重新导入 ModHub 后可继续使用。' : '';
    const selfNoticeHtml = isModHub ? modHubSelfRemovalNoticeHtml(true) : '';
    const isFramework = window.modHubIsFrameworkMod(modName);
    const affectedMods = await window.modHubFindDependentMods(modName);
    const modInfo = window.modHubGetModInfo(modName);
    const subtext = window.modHubGetModSubtext(modName, modInfo, false, true);
    const modDisplayName = subtext ? `${modName}（${subtext}）` : modName;

    let confirmed = false;
    if (affectedMods.length > 0) {
        const affectedListHtml = affectedMods.map(m => {
            const ver = m.version ? ` (${window.modHubEscapeHtml(m.version)})` : '';
            const status = m.isEnabled ? '' : ' <span class="grey">[已禁用]</span>';
            return `<div>· <span class="gold" data-modhub-no-translate>${window.modHubEscapeHtml(m.name)}</span>${ver}${status}</div>`;
        }).join('');
        const affectedListText = affectedMods.map(m => `· ${m.name}${m.version ? ` (${m.version})` : ''}${m.isEnabled ? '' : ' [已禁用]'}`).join('\n');

        const trustedMessageHtml = `
            <div class="modhub-delete-intro">确定要彻底删除模组【<strong class="gold modhub-delete-target" data-modhub-no-translate>${window.modHubEscapeHtml(modDisplayName)}</strong>】吗？</div>
            <div class="modhub-modal-conflict-alert-box" style="margin: 12px 0; padding: 10px 14px; background: rgba(220, 53, 69, 0.12); border: 1px solid rgba(220, 53, 69, 0.35); border-radius: 4px;">
                <div style="font-weight: bold; color: var(--red, #ff5555); margin-bottom: 6px;">
                    警告：检测到以下模组依赖于该模组/框架，删除后可能会受到严重影响或无法正常运行：
                </div>
                <div style="max-height: 140px; overflow-y: auto; font-size: 0.9em; line-height: 1.6;">
                    ${affectedListHtml}
                </div>
            </div>
            ${selfNoticeHtml}
            <div class="red modhub-delete-warning">删除后该模组将从浏览器存储中彻底移除。是否仍要删除？</div>
        `;

        confirmed = await window.modHubConfirm({
            title: isModHub ? '确认卸载 ModHub（存在依赖警告）' : '确认删除模组（存在依赖警告）',
            message: `确定要彻底删除模组【${modDisplayName}】吗？\n\n警告：以下模组依赖于该模组/框架，删除后可能无法正常运行：\n${affectedListText}\n\n${selfNotice ? selfNotice + '\n\n' : ''}删除后该模组将从浏览器存储中彻底移除。是否确认删除？`,
            trustedMessageHtml,
            confirmText: isModHub ? '确认卸载' : '确认删除',
            cancelText: '取消',
            dialogClass: isModHub ? 'modhub-self-removal-dialog' : '',
            confirmType: 'danger',
            confirmDelay: 5
        });
    } else {
        confirmed = await window.modHubConfirm({
            title: isModHub ? '确认卸载 ModHub' : '确认删除模组',
            message: `确定要删除模组【${modName}】吗？\n${selfNotice || '删除后该模组将从浏览器存储中彻底移除，不可恢复。'}`,
            trustedMessageHtml: `<p class="modhub-delete-intro">确定要删除模组【<strong class="gold modhub-delete-target" data-modhub-no-translate>${window.modHubEscapeHtml(modName)}</strong>】吗？</p>${isModHub ? selfNoticeHtml : '<p class="red modhub-delete-warning">删除后该模组将从浏览器存储中彻底移除，不可恢复。</p>'}`,
            dialogClass: isModHub ? 'modhub-self-removal-dialog' : '',
            confirmText: isModHub ? '确认卸载' : '确认删除',
            cancelText: '取消',
            confirmType: 'danger'
        });
    }
    if (!confirmed) return;

    const saved = await window.modHubRunManagerAction(async () => {
        const state = window._modHubModState;
        if (!state) throw new Error('模组列表尚未读取完成');
        const controller = window.modHubGetController();
        if (typeof controller?.removeModIndexDB !== 'function') throw new Error('当前加载器未提供模组包删除接口，已停止删除');
        window.modHubEnsureModStateSync(state);
        state.sideMods = state.sideMods.filter(item => item.name !== modName);
        state.sideEnabled = state.sideEnabled.filter(name => name !== modName);
        state.sideDisabled = state.sideDisabled.filter(name => name !== modName);
        // dropNames：明确告知保存层该模组已被删除，禁止被「已安装保留」逻辑复活
        if (!await window.modHubSaveModManageState(false, { dropNames: [modName] })) throw new Error('删除模组配置失败');
        await window.modHubLoadBeautyState(true, [modName]);
        window._modHubDisabledModInfo.delete(modName.trim().toLowerCase());
        // 真正删除浏览器存储中的安装包；
        // 只从列表移除而不删包体，会留下永远无法被加载的孤儿包体（占用空间且状态诡异）。
        if (await controller.removeModIndexDB(modName) === false) throw new Error('模组包删除失败');
        const gui = window.modHubGetGui();
        const loader = gui?.gModUtils?.getModLoader?.()?.getIndexDBLoader?.();
        const keyval = gui?.gModUtils?.getIdbKeyValRef?.();
        if (loader?.customStore && typeof loader.constructor?.calcModNameKey === 'function' && typeof keyval?.get === 'function' &&
            await keyval.get(loader.constructor.calcModNameKey(modName), loader.customStore)) {
            throw new Error('模组包删除后仍存在，未能确认卸载成功');
        }
    }, undefined, { trackReload: true, immediateReload: isFramework || isModHub, busyKey: `side:delete:${modName}`, restoreLabel: `删除模组【${modName}】` });
    if (saved) {
        window.modHubShowToast(`已删除模组【${modName}】，重新载入后生效`, 'warning');
        if (isFramework || isModHub) await window.modHubOfferReload(`模组【${modDisplayName || modName}】已从模组列表中删除。`, { isFramework });
    }
    return saved;
};

function modHubKeepManagerRecoveryOrder(state) {
    window.modHubEnsureModStateSync(state);
    const protectedNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const first = window.modHubKeepRecoveryOrder(state.sideEnabled).filter(name => protectedNames.has(name.toLowerCase()));
    const ordered = [...first, ...state.sideMods.map(item => item.name).filter(name => !first.includes(name))];
    state.sideMods = state.sideMods.slice().sort((a, b) => ordered.indexOf(a.name) - ordered.indexOf(b.name));
    window.modHubEnsureModStateSync(state);
}

// 保存模组管理状态
// options.dropNames：本次操作中明确移除、不允许被「已安装保留」逻辑复活的模组名
window.modHubSaveModManageState = async function(showSuccess = true, options = {}) {
    const state = window._modHubModState;
    if (!state) return false;
    modHubKeepManagerRecoveryOrder(state);

    window.modHubRenderModManageUI();
    try {
        await window.modHubSaveIndexDBModList(state.sideEnabled, state.sideDisabled, options);
        if (typeof localStorage !== 'undefined' && state.sideMods) {
            try {
                localStorage.setItem('modhub_sideload_mod_order', JSON.stringify(state.sideMods.map(m => m.name)));
            } catch (_) {}
        }

        if (showSuccess) window.modHubShowToast('模组配置已更新，重新载入后生效', 'success');
        return true;
    } catch (e) {
        if (window._modHubManagerBusy) throw e;
        console.error('[ModHub] 保存模组状态失败', e);
        window.modHubShowToast('保存模组状态失败: ' + (e.message || e), 'warning');
        return false;
    }
};


// ========== 模组管理板块多选批量操作接口 ==========

window.modHubToggleBatchMode = function(forceState) {
    window._modHubBatchMode = typeof forceState === 'boolean' ? forceState : !window._modHubBatchMode;
    if (!window._modHubBatchMode && window._modHubSelectedMods) {
        window._modHubSelectedMods.clear();
    }
    window.modHubRenderModManageUI();
};

window.modHubToggleSelectMod = function(modName, checked) {
    if (!modName) return;
    if (!window._modHubSelectedMods) window._modHubSelectedMods = new Set();
    if (checked) {
        window._modHubSelectedMods.add(modName);
    } else {
        window._modHubSelectedMods.delete(modName);
    }
    window.modHubUpdateBatchToolbar();
};

window.modHubUpdateBatchToolbar = function() {
    const selectedCount = window._modHubSelectedMods ? window._modHubSelectedMods.size : 0;
    const countEl = document.getElementById('modHubBatchCount');
    if (countEl) countEl.textContent = String(selectedCount);

    const toolbar = document.getElementById('modHubBatchToolbar');
    if (toolbar) {
        const hasSelected = selectedCount > 0;
        toolbar.querySelectorAll('button[data-batch-action]').forEach(btn => {
            btn.disabled = !hasSelected;
        });
    }

    const container = document.getElementById('modHubModManageContainer');
    if (container) {
        container.querySelectorAll('li[data-mod-name][data-drag-type="side"]').forEach(li => {
            const modName = li.dataset.modName;
            const isSelected = window._modHubSelectedMods && window._modHubSelectedMods.has(modName);
            li.classList.toggle('modhub-item-selected', !!isSelected);
            const cb = li.querySelector('.modhub-batch-checkbox');
            if (cb && !cb.disabled) cb.checked = !!isSelected;
        });
    }
};

window.modHubBatchSelectAll = function() {
    const recoveryNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const sideMods = window._modHubModState?.sideMods || [];
    if (!window._modHubSelectedMods) window._modHubSelectedMods = new Set();
    for (const item of sideMods) {
        if (!recoveryNames.has(item.name.toLowerCase())) {
            window._modHubSelectedMods.add(item.name);
        }
    }
    window.modHubUpdateBatchToolbar();
};

window.modHubBatchInvertSelect = function() {
    const recoveryNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const sideMods = window._modHubModState?.sideMods || [];
    if (!window._modHubSelectedMods) window._modHubSelectedMods = new Set();
    for (const item of sideMods) {
        if (recoveryNames.has(item.name.toLowerCase())) continue;
        if (window._modHubSelectedMods.has(item.name)) {
            window._modHubSelectedMods.delete(item.name);
        } else {
            window._modHubSelectedMods.add(item.name);
        }
    }
    window.modHubUpdateBatchToolbar();
};

window.modHubBatchEnable = async function() {
    const selected = Array.from(window._modHubSelectedMods || []);
    if (!selected.length) {
        window.modHubShowToast('请先选择要启用的模组', 'info');
        return false;
    }
    const state = window._modHubModState;
    if (!state) return false;
    const toEnable = selected.filter(name => {
        const item = state.sideMods?.find(m => m.name === name);
        return item && !item.enabled;
    });
    if (!toEnable.length) {
        window.modHubShowToast('所选模组已全部处于启用状态', 'info');
        return false;
    }

    const saved = await window.modHubRunManagerAction(async () => {
        const currentState = window._modHubModState;
        window.modHubEnsureModStateSync(currentState);
        for (const name of toEnable) {
            const item = currentState.sideMods?.find(m => m.name === name);
            if (item) item.enabled = true;
        }
        window.modHubEnsureModStateSync(currentState);
        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
        await window.modHubLoadBeautyState();
        return true;
    }, undefined, { trackReload: true, busyKey: 'batch:enable', restoreLabel: `批量启用 ${toEnable.length} 个模组` });

    if (saved) {
        window._modHubSelectedMods.clear();
        window.modHubShowToast(`已批量启用 ${toEnable.length} 个模组，重新载入后生效`, 'success');
        const hasFramework = toEnable.some(name => window.modHubIsFrameworkMod(name));
        if (hasFramework) {
            await window.modHubOfferReload(`已批量启用 ${toEnable.length} 个模组（包含核心框架）。`, { isFramework: true });
        }
    }
    return saved;
};

window.modHubBatchDisable = async function() {
    const selected = Array.from(window._modHubSelectedMods || []);
    if (!selected.length) {
        window.modHubShowToast('请先选择要禁用的模组', 'info');
        return false;
    }
    const state = window._modHubModState;
    if (!state) return false;
    const toDisable = selected.filter(name => {
        const item = state.sideMods?.find(m => m.name === name);
        return item && item.enabled;
    });
    if (!toDisable.length) {
        window.modHubShowToast('所选模组已全部处于禁用状态', 'info');
        return false;
    }

    const toDisableSet = new Set(toDisable.map(n => n.toLowerCase()));
    const affectedMap = new Map();
    for (const modName of toDisable) {
        const deps = await window.modHubFindDependentMods(modName);
        for (const d of deps) {
            if (!toDisableSet.has(d.rawName?.toLowerCase())) {
                if (!affectedMap.has(d.rawName)) {
                    affectedMap.set(d.rawName, { ...d, dependOn: [modName] });
                } else {
                    affectedMap.get(d.rawName).dependOn.push(modName);
                }
            }
        }
    }

    const isModHubIncluded = toDisable.some(name => name.toLowerCase() === 'modhub');
    const selfNotice = isModHubIncluded ? '重新载入后，ModHub 的模组管理、模组市场、时间点还原和加载页救援将停用。可通过加载器原生管理界面重新启用 ModHub。游戏存档和已有还原点保留。' : '';
    const selfNoticeHtml = isModHubIncluded ? modHubSelfRemovalNoticeHtml(false) : '';

    if (affectedMap.size > 0 || isModHubIncluded) {
        const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');
        const affectedList = Array.from(affectedMap.values());
        const modItemsHtml = affectedList.map(m => `
            <div class="modhub-modal-affected-item">
                · <span class="gold" data-modhub-no-translate>【${escape(m.name)}】</span>${m.version ? ` <span class="grey">(${escape(m.version)})</span>` : ''} <span class="grey">（依赖于 ${m.dependOn.map(escape).join('、')}）</span>
            </div>
        `).join('');
        const modLinesText = affectedList.map(m => `· 【${m.name}】（依赖于 ${m.dependOn.join('、')}）`).join('\n');

        const ok = await window.modHubConfirm({
            title: `确认批量禁用 ${toDisable.length} 个模组？`,
            message: `禁用选中的 ${toDisable.length} 个模组后，以下依赖它们的模组可能会受到影响或无法正常运行：\n\n${modLinesText}\n\n${selfNotice ? selfNotice + '\n\n' : ''}是否仍然确认禁用？`,
            trustedMessageHtml: `
                <div class="modhub-modal-intro">禁用选中的 <span class="gold">${toDisable.length}</span> 个模组后，以下依赖它们的模组可能会受到影响或无法正常运行：</div>
                <div class="modhub-modal-affected-box" style="max-height: 140px; overflow-y: auto;">
                    ${modItemsHtml}
                </div>
                ${selfNoticeHtml}
                <div class="grey modhub-modal-question" style="margin-top:10px;">是否仍然确认批量禁用？</div>
            `,
            confirmText: '确认禁用',
            cancelText: '取消',
            confirmType: 'danger'
        });
        if (!ok) return false;
    } else {
        const ok = await window.modHubConfirm({
            title: `确认批量禁用 ${toDisable.length} 个模组？`,
            message: `确定要禁用选中的 ${toDisable.length} 个模组吗？\n禁用后相关模组将在下次游戏启动时暂停加载。\n\n是否确认禁用？`,
            confirmText: '确认禁用',
            cancelText: '取消',
            confirmType: 'warning'
        });
        if (!ok) return false;
    }

    const saved = await window.modHubRunManagerAction(async () => {
        const currentState = window._modHubModState;
        window.modHubEnsureModStateSync(currentState);
        for (const name of toDisable) {
            const item = currentState.sideMods?.find(m => m.name === name);
            if (item) item.enabled = false;
        }
        window.modHubEnsureModStateSync(currentState);
        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
        await window.modHubLoadBeautyState();
        return true;
    }, undefined, { trackReload: true, busyKey: 'batch:disable', restoreLabel: `批量禁用 ${toDisable.length} 个模组` });

    if (saved) {
        window._modHubSelectedMods.clear();
        window.modHubShowToast(`已批量禁用 ${toDisable.length} 个模组，重新载入后生效`, 'success');
        const hasFramework = toDisable.some(name => window.modHubIsFrameworkMod(name));
        if (hasFramework || isModHubIncluded) {
            await window.modHubOfferReload(`已批量禁用 ${toDisable.length} 个模组。`, { isFramework: hasFramework });
        }
    }
    return saved;
};

window.modHubBatchDelete = async function() {
    const selected = Array.from(window._modHubSelectedMods || []);
    if (!selected.length) {
        window.modHubShowToast('请先选择要删除的模组', 'info');
        return false;
    }
    const state = window._modHubModState;
    if (!state) return false;
    const toDelete = selected.filter(name => state.sideMods?.some(m => m.name === name));
    if (!toDelete.length) return false;

    const toDeleteSet = new Set(toDelete.map(n => n.toLowerCase()));
    const affectedMap = new Map();
    for (const modName of toDelete) {
        const deps = await window.modHubFindDependentMods(modName);
        for (const d of deps) {
            if (!toDeleteSet.has(d.rawName?.toLowerCase())) {
                if (!affectedMap.has(d.rawName)) {
                    affectedMap.set(d.rawName, { ...d, dependOn: [modName] });
                } else {
                    affectedMap.get(d.rawName).dependOn.push(modName);
                }
            }
        }
    }

    const isModHubIncluded = toDelete.some(name => name.toLowerCase() === 'modhub');
    const selfNotice = isModHubIncluded ? '重新载入后，ModHub 的模组管理、模组市场、时间点还原和加载页救援将停用。游戏存档和已有还原点保留；重新导入 ModHub 后可继续使用。' : '';
    const selfNoticeHtml = isModHubIncluded ? modHubSelfRemovalNoticeHtml(true) : '';

    const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');
    const deleteListHtml = toDelete.map(name => {
        const modInfo = window.modHubGetModInfo(name);
        const subtext = window.modHubGetModSubtext(name, modInfo, false, true);
        const disp = subtext ? `${name}（${subtext}）` : name;
        return `<div>· <span class="gold" data-modhub-no-translate>${escape(disp)}</span></div>`;
    }).join('');

    let trustedMessageHtml = '';
    if (affectedMap.size > 0) {
        const affectedList = Array.from(affectedMap.values());
        const affectedListHtml = affectedList.map(m => `
            <div>· <span class="gold" data-modhub-no-translate>${escape(m.name)}</span>${m.version ? ` (${escape(m.version)})` : ''} <span class="grey">（依赖于 ${m.dependOn.map(escape).join('、')}）</span></div>
        `).join('');

        trustedMessageHtml = `
            <div class="modhub-modal-conflict-intro">确定要彻底删除选中的 <span class="gold">${toDelete.length}</span> 个模组吗？</div>
            <div class="modhub-modal-conflict-alert-box" style="margin: 10px 0; padding: 10px 14px; background: rgba(220, 53, 69, 0.12); border: 1px solid rgba(220, 53, 69, 0.35); border-radius: 4px;">
                <div style="font-weight: bold; color: var(--red, #ff5555); margin-bottom: 6px;">
                    警告：检测到以下模组依赖于即将删除的模组，删除后可能无法正常运行：
                </div>
                <div style="max-height: 120px; overflow-y: auto; font-size: 0.9em; line-height: 1.6;">
                    ${affectedListHtml}
                </div>
            </div>
            <div class="grey" style="font-size: 0.9em; margin: 8px 0 4px 0;">即将删除的模组列表：</div>
            <div style="max-height: 100px; overflow-y: auto; font-size: 0.88em; line-height: 1.5; padding: 6px 10px; background: rgba(0, 0, 0, 0.25); border-radius: 4px;">
                ${deleteListHtml}
            </div>
            ${selfNoticeHtml}
            <div class="grey" style="font-size: 0.9em; margin-top: 10px;">删除后这些模组将从浏览器存储中彻底移除，不可恢复。是否仍要删除？</div>
        `;
    } else {
        trustedMessageHtml = `
            <div class="modhub-modal-intro">确定要彻底删除选中的 <span class="gold">${toDelete.length}</span> 个模组吗？</div>
            <div style="max-height: 120px; overflow-y: auto; font-size: 0.9em; line-height: 1.6; margin: 10px 0; padding: 6px 10px; background: rgba(0, 0, 0, 0.25); border-radius: 4px;">
                ${deleteListHtml}
            </div>
            ${selfNoticeHtml}
            <div class="grey" style="font-size: 0.9em; margin-top: 8px;">删除后这些模组将从浏览器存储中彻底移除，不可恢复。是否确认删除？</div>
        `;
    }

    const ok = await window.modHubConfirm({
        title: isModHubIncluded ? `确认批量删除 ${toDelete.length} 个模组（含 ModHub 卸载）` : `确认批量删除 ${toDelete.length} 个模组`,
        message: `确定要批量删除选中的 ${toDelete.length} 个模组吗？\n${selfNotice ? selfNotice + '\n\n' : ''}删除后这些模组将从浏览器存储中彻底移除，不可恢复。\n\n是否确认删除？`,
        trustedMessageHtml,
        confirmText: isModHubIncluded ? '确认批量删除与卸载' : '确认批量删除',
        cancelText: '取消',
        confirmType: 'danger',
        confirmDelay: 3
    });
    if (!ok) return false;

    const saved = await window.modHubRunManagerAction(async () => {
        const state = window._modHubModState;
        if (!state) throw new Error('模组列表尚未读取完成');
        const controller = window.modHubGetController();
        if (typeof controller?.removeModIndexDB !== 'function') throw new Error('当前加载器未提供模组包删除接口，已停止删除');

        window.modHubEnsureModStateSync(state);
        state.sideMods = state.sideMods.filter(item => !toDeleteSet.has(item.name.toLowerCase()));
        state.sideEnabled = state.sideEnabled.filter(name => !toDeleteSet.has(name.toLowerCase()));
        state.sideDisabled = state.sideDisabled.filter(name => !toDeleteSet.has(name.toLowerCase()));

        if (!await window.modHubSaveModManageState(false, { dropNames: toDelete })) throw new Error('删除模组配置失败');

        for (const name of toDelete) {
            await window.modHubLoadBeautyState(true, [name]);
            window._modHubDisabledModInfo.delete(name.trim().toLowerCase());
            await controller.removeModIndexDB(name);
        }
        return true;
    }, undefined, { trackReload: true, busyKey: 'batch:delete', restoreLabel: `批量删除 ${toDelete.length} 个模组` });

    if (saved) {
        window._modHubSelectedMods.clear();
        window.modHubShowToast(`已批量删除 ${toDelete.length} 个模组，重新载入后生效`, 'warning');
        const hasFramework = toDelete.some(name => window.modHubIsFrameworkMod(name));
        if (hasFramework || isModHubIncluded) {
            await window.modHubOfferReload(`已批量删除 ${toDelete.length} 个模组。`, { isFramework: hasFramework });
        }
    }
    return saved;
};

// 游戏就绪后核验下一次启动的顺序；只有实际修正时才建立保护点。
window.addEventListener?.('modhub:languagechange', () => {
    const container = document.getElementById?.('modHubModManageContainer');
    window.modHubLocalizeOwned?.(container);
    window.modHubLocalizeOwned?.(document.getElementById?.('overlayTabs'));
    if (container) {
        for (const row of container.querySelectorAll?.('li[data-mod-name]') || []) {
            const alias = row.querySelector?.('.modhub-mod-alias');
            if (alias) alias.textContent = window.modHubGetModSubtext(row.dataset.modName, window.modHubGetModInfo(row.dataset.modName), false);
        }
        window.modHubNotifyUpdateState(window._modHubUpdatableCount || 0, window._modHubUpdatableMods || []);
    } else window.modHubUpdateMarketTabBadge();
});

window.jQuery?.(document).one?.(':storyready.modHubRecoveryPlacement', async () => {
    try {
        await window.modHubLoadModManageState();
        await window.modHubEnsureRecoveryPlacement();
    } catch (error) {
        console.warn('[ModHub] 恢复工具顺序核验未完成', error);
    }
});
