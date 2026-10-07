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

window.modHubIsManagerTabLabel = function(text) {
    const label = String(text || '').trim();
    return ['模组管理', '模组市场', '模组说明', '加载日志'].some(name => label.startsWith(name));
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

// 模组管理器顶栏标签初始化（过滤并保留管理 Tab 及移动端左侧关闭按钮）
window.modHubInitOverlayTabs = function() {
    window.modHubEnsureStyles?.({ active: true });
    window.modHubBindReloadReminder();
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
    if (core.not(".customOverlayClose, .modhub-mobile-close-tab").length >= 4) {
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
        try {
            const data = await keyval.get(loader.constructor.calcModNameKey(name), loader.customStore);
            if (!data) continue;
            const bootJson = await controller.checkModZipFileIndexDB(data);
            if (!bootJson || typeof bootJson !== 'object' || Array.isArray(bootJson)) continue;
            if (String(bootJson.name || '').trim().toLowerCase() !== key) continue;
            window._modHubDisabledModInfo.set(key, {
                name: bootJson.name || name,
                bootJson
            });
            loaded++;
        } catch (error) {
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
    const isBusy = () => Boolean(window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerStateUncertain);
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
                nick = boot.nickName['zh-CN'] || boot.nickName['zh'] || boot.nickName['cn'] || boot.nickName['chs'] || boot.nickName['hans'] || '';
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

// 更新模组市场顶部 Tab 胶囊徽标
window.modHubUpdateMarketTabBadge = function(count) {
    if (typeof document === 'undefined') return;
    const tabs = document.querySelectorAll('#overlayTabs button');
    for (const btn of tabs) {
        if (btn.textContent.includes('模组市场')) {
            let badge = btn.querySelector('.modhub-tab-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'modhub-tab-badge';
                    btn.appendChild(badge);
                }
                badge.textContent = count;
            } else if (badge) {
                badge.remove();
            }
            break;
        }
    }
};

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
            tag.textContent = version ? ` | [可更新 -> ${version}]` : '';
            tag.style.display = version ? '' : 'none';
        }
        if (button) {
            button.title = version ? `立即升级至 ${version}` : '';
            button.style.display = version ? '' : 'none';
        }
    }

    // 1. 同步顶部 Tab 徽标
    window.modHubUpdateMarketTabBadge(window._modHubUpdatableCount);

    // 2. 如果当前在模组管理页，局部刷新置顶横幅与第 4 张卡片
    const bannerEl = document.getElementById('modHubUpdateBanner');
    if (bannerEl) {
        if (window._modHubUpdatableCount > 0) {
            bannerEl.innerHTML = `
                <div class="modhub-update-banner modhub-clickable" onclick="window.modHubGoToMarketUpdates()" title="点击前往模组市场一键更新">
                    <div class="modhub-update-banner-main">
                        <div class="modhub-update-banner-title">发现 ${window._modHubUpdatableCount} 个模组有新版本可用！</div>
                        <div class="modhub-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                    </div>
                    <button type="button" class="macro-button modhub-btn-primary" onclick="event.stopPropagation(); window.modHubGoToMarketUpdates();">查看更新</button>
                </div>
            `;
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
            fourthCard.innerHTML = `
                <div class="modhub-stat-num gold modhub-pulse-gold">${window._modHubUpdatableCount}</div>
                <div class="gold modhub-stat-label">发现新版</div>
            `;
        } else {
            const mlVersion = window.modHubGetGui()?.gModUtils?.version || window.modUtils?.version || '2.x';
            fourthCard.className = 'childItem modhub-stat-card';
            fourthCard.title = '';
            fourthCard.onclick = null;
            fourthCard.style.borderColor = '';
            fourthCard.innerHTML = `
                <div class="modhub-stat-num">${window.modHubEscapeHtml(mlVersion)}</div>
                <div class="grey modhub-stat-label">加载器版本</div>
            `;
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

        infoEl.innerHTML = `
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
        `;

        // 渲染置顶横幅
        const bannerEl = document.getElementById('modHubUpdateBanner');
        if (bannerEl) {
            if (updatableCount > 0) {
                bannerEl.innerHTML = `
                    <div class="modhub-update-banner modhub-clickable" onclick="window.modHubGoToMarketUpdates()" title="点击前往模组市场一键更新">
                        <div class="modhub-update-banner-main">
                            <div class="modhub-update-banner-title">发现 ${updatableCount} 个模组有新版本可用！</div>
                            <div class="modhub-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                        </div>
                        <button type="button" class="macro-button modhub-btn-primary" onclick="event.stopPropagation(); window.modHubGoToMarketUpdates();">查看更新</button>
                    </div>
                `;
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
        if (btn.textContent.trim().includes(tabName)) {
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
            '加载日志': 3
        };
        const tabIdx = tabIndexMap[tabName] !== undefined ? tabIndexMap[tabName] : 0;

        let contentMacro = '<<modloadermodmanage>>';
        if (tabName === '加载日志') {
            contentMacro = '<<modloaderlog>>';
        } else if (tabName === '模组市场') {
            contentMacro = '<<modloadermarket>>';
        } else if (tabName === '模组说明') {
            contentMacro = '<<modloaderreadme>>';
        }

        if (tabName === '加载日志' || options.scrollToError) {
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
            // 降级：模拟点击侧边栏 Mod 管理器按钮
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Mod管理器'));
            if (btn && typeof btn.click === 'function') {
                btn.click();
                rendered = true;
                if (tabName !== '模组管理' && typeof Wikifier !== 'undefined' && typeof Wikifier.wikifyEval === 'function') {
                    setTimeout(() => {
                        Wikifier.wikifyEval(`<<replace #customOverlayContent>>${contentMacro}<</replace>>`);
                    }, 50);
                }
            }
        }

        // 5. 确保 Tab 高亮（tab-selected）并联动定位首处错误
        setTimeout(() => {
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

            if (tabName === '加载日志' || options.scrollToError) {
                setTimeout(() => {
                    if (typeof window.modHubScrollToFirstError === 'function') {
                        window.modHubScrollToFirstError();
                    }
                }, 100);
            }
        }, 50);

        return rendered;
    } catch (e) {
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

window.modHubHandleAddMod = async function(fileInput, options = {}) {
    const gui = window.modHubGetGui();
    if (!gui) {
        window.modHubShowToast('未找到模组管理器实例', 'warning');
        return;
    }
    const files = Array.isArray(fileInput)
        ? fileInput
        : Array.from(fileInput?.files || (Array.isArray(fileInput?.files) ? fileInput.files : []));
    if (!files || files.length === 0) return;

    const fileCount = files.length;
    const isBatch = fileCount > 1;

    window.modHubShowToast(isBatch ? `正在解析并批量导入 ${fileCount} 个模组文件...` : '正在解析并导入模组文件...', 'warning');
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
            if (fileCount === 1 && !needsNativeCheck && typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(fileInput);
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
        }, '正在导入模组，请稍候...', { restoreContext: options.restoreContext, restoreLabel: isBatch ? '批量导入模组' : '导入模组' });
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
    return window.modHubRunManagerAction(async () => {
        if (fromIndex === undefined || targetIndex === undefined || isNaN(fromIndex) || isNaN(targetIndex)) return false;
        let toIndex = isAfter ? targetIndex + 1 : targetIndex;
        if (fromIndex < toIndex) toIndex--;
        if (fromIndex === toIndex) return false;

        if (listType === 'side') {
            const state = window._modHubModState;
            if (!state) return false;
            window.modHubEnsureModStateSync(state);
            const list = state.sideMods;
            if (!list || fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return false;
            const [moved] = list.splice(fromIndex, 1);
            list.splice(toIndex, 0, moved);

            window.modHubEnsureModStateSync(state);
            if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');

            const movedName = typeof moved === 'object' ? moved.name : moved;
            window.modHubShowToast(`已将【${movedName}】排序调整至第 ${toIndex + 1} 位`, 'success');
        } else if (listType === 'beauty') {
            const state = window._modHubBeautyState;
            if (!state || !state.enabledList) return false;
            const list = state.enabledList;
            if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return false;
            const [moved] = list.splice(fromIndex, 1);
            list.splice(toIndex, 0, moved);

            if (!await window.modHubSaveBeautyState(false)) throw new Error('美化配置保存失败');

            window.modHubShowToast(`已将美化包【${moved.type}】覆盖优先级调整至第 ${toIndex + 1} 位`, 'success');
        }
    }, undefined, { trackReload: true });
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
window.modHubLoadModManageState = function(refresh = false) {
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

        const pendingInfo = sideEnabled.filter(name => !window.modHubGetModInfo(name));
        await window.modHubLoadDisabledModInfo([...sideDisabled, ...pendingInfo], refresh);
        return window._modHubModState;
    })().finally(() => {
        window._modHubModLoading = null;
        if (window._modHubReloadExitPending) window.modHubPromptPendingReload();
    });
    return window._modHubModLoading;
};

window.modHubUpdateManagerStatus = function() {
    const controls = document.getElementById('modHubManagerControls');
    if (controls) controls.disabled = !!(window._modHubManagerBusy || window._modHubModLoading);
    const status = document.getElementById('modHubManagerStatus');
    if (status) {
        status.textContent = window._modHubManagerStatus || '配置自动保存；模组重新载入后生效，美化即时应用';
        status.className = window._modHubManagerSaveFailed ? 'red' : 'grey';
    }
};

// ponytail: 共用一把操作锁；确有并行操作需求时再按存储资源拆分。
window.modHubRunManagerAction = async function(action, message = '正在保存，请稍候...', options = {}) {
    const restore = window.modHubRestore;
    const restoreContext = options.restoreContext || restore?.createOperation({ label: options.restoreLabel || '调整模组与美化配置' });
    const ownRestoreContext = !options.restoreContext;
    if (window._modHubManagerBusy || window._modHubModLoading || window._modHubManagerStateUncertain ||
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
    window._modHubManagerBusy = true;
    window._modHubManagerStatus = message;
    window.modHubUpdateManagerStatus();
    try {
        if (ownRestoreContext && restore?.claim && !restore.claim(restoreContext)) return false;
        if (restore && !await restore.prepare(restoreContext)) {
            window._modHubManagerStatus = '已取消操作，配置保持不变';
            return false;
        }
        const result = await action();
        const modChanged = beforeReload !== modHubReloadConfigSnapshot(window._modHubModState);
        window._modHubManagerStatus = result === false ? previousStatus : (modChanged ? '模组配置已保存，重新载入后生效；美化配置即时应用' : '配置已保存，美化配置即时应用');
        if (result !== false) window._modHubManagerSaveFailed = false;
        if (result !== false && options.trackReload) modHubRecordReloadChange(beforeReload);
        return result === undefined ? true : result;
    } catch (error) {
        window._modHubModState = beforeMod;
        window._modHubBeautyState = beforeBeauty;
        // 两份模组列表可能只写入了一份，以重新读到的实际记录为准。
        try {
            await window.modHubLoadModManageState(true);
            await window.modHubLoadBeautyState(false);
            window._modHubManagerStateUncertain = false;
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
                window._modHubManagerSaveFailed = true;
                window._modHubManagerStateUncertain = true;
                window._modHubManagerStatus = '还原点整理失败，请刷新列表核验配置后再重载';
            }
        }
        window._modHubManagerBusy = false;
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
    else container.innerHTML = '<div class="mod-empty grey">正在读取模组列表...</div>';
    if (window._modHubManagerInit) return window._modHubManagerInit;
    if (window._modHubManagerBusy) return;
    if (!refresh && window._modHubModState && window._modHubBeautyLoaded && !window._modHubModLoading) return;
    window._modHubManagerInit = (async () => {
        try {
            const loading = window.modHubLoadModManageState(refresh);
            window.modHubUpdateManagerStatus();
            await loading;
            await window.modHubEnsureRecoveryPlacement();
            // 自愈：修复「包体已安装、却未登记进启用列表」的历史遗留模组，
            // 这类模组重启后不会被加载，是市场反复显示未安装 / 可更新的根源之一。
            if (!window._modHubOrphanRepairDone && typeof window.modHubRepairOrphanModZips === 'function') {
                window._modHubOrphanRepairDone = true;
                try {
                    const repair = await window.modHubRepairOrphanModZips();
                    if (repair?.repaired?.length) await window.modHubLoadModManageState(true);
                } catch (repairError) {
                    console.warn('[ModHub] 已安装未登记模组自愈失败', repairError);
                }
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
    })().finally(() => { window._modHubManagerInit = null; });
    return window._modHubManagerInit;
};

window.modHubRenderModManageUI = function() {
    const container = document.getElementById('modHubModManageContainer');
    if (!container || !window._modHubModState) return;

    window.modHubEnsureModStateSync(window._modHubModState);
    const sectionStates = new Map([...container.querySelectorAll('details[data-section]')].map(detail => [detail.dataset.section, detail.open]));
    const isSectionOpen = (name, defaultOpen = false) => sectionStates.has(name) ? sectionStates.get(name) : defaultOpen;
    const isNarrowScreen = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    const gui = window.modHubGetGui();
    const { sideMods, builtInMods } = window._modHubModState;
    const recoveryNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const totalSideCount = sideMods ? sideMods.length : 0;
    const beautyCount = (window._modHubBeautyState?.enabledList.length || 0) + (window._modHubBeautyState?.disabledList.length || 0);

    let html = '<fieldset id="modHubManagerControls" class="modhub-manager-controls">';

    // 1. 环境统计看板（原通用页面核心信息）
    html += '<div id="modHubEnvInfo" class="settingsGridSmall modhub-stats-container"></div>';
    html += '<div id="modHubUpdateBanner" style="display:none;"></div>';

    // 2. 操作工具栏：窄屏说明默认收起，随列表滚动以留出阅读空间。
    html += `
        <div class="modhub-sticky-toolbar">
            <div class="modhub-manager-helpbar">
                <details class="modhub-manager-help grey" data-section="manager-help"${isSectionOpen('manager-help', !isNarrowScreen) ? ' open' : ''}>
                    <summary>排序操作说明</summary>
                    <p>智能整理会按依赖调整模组与美化顺序；也可拖拽手动排序，长按上下按钮可置顶或置底。</p>
                </details>
                <label class="modhub-safemode-label" title="开启后仅加载签名模组，可用于排查异常 Mod">
                    <input type="checkbox" id="toggleSafeMode" class="macro-checkbox" />
                    <span class="gold">安全模式</span>
                </label>
            </div>
            <div id="modHubManagerStatus" class="grey" role="status" aria-live="polite"></div>
            <div class="modhub-group-header">
                <span class="gold">模组与美化顺序管理</span>
                <div class="modhub-header-actions">
                    <button id="modHubImportModBtn" class="macro-button modhub-btn-primary" type="button" title="从本地选择或直接拖拽 Zip / ModPack 模组文件导入" onclick="window.modHubTriggerImport()">导入模组</button>
                    <button id="modHubRestartGameBtn" class="macro-button modhub-btn-primary" type="button" title="重新载入游戏以使最新模组配置生效，美化调整即时应用" onclick="window.modHubRestartGame()">重新载入游戏</button>
                    <button id="modHubSmartSortAllBtn" class="macro-button modhub-btn-primary" type="button" title="根据明确依赖，同时整理已安装模组的加载顺序和美化包的覆盖顺序" onclick="window.modHubSmartSortAll()">智能整理模组与美化顺序</button>
                    <button id="modHubRefreshListBtn" class="macro-button modhub-btn-primary" type="button" title="在原版管理器修改后，重新读取列表与模组资料" onclick="window.initModManage(true)">刷新列表</button>
                    <button id="modHubRestorePointsBtn" class="macro-button modhub-btn-primary" type="button" onclick="window.modHubRestore.showHistory()">时间点还原</button>
                </div>
            </div>
        </div>
        <input type="file" id="modHubImportFileInput" accept="${MODHUB_IMPORT_ACCEPT}" multiple style="display:none;" />
        <details class="modhub-collapsible-section" data-section="side"${isSectionOpen('side', true) ? ' open' : ''}>
            <summary class="modhub-section-summary">已安装模组 - 共 ${totalSideCount} 个</summary>
            <div class="modhub-section-content">
                ${totalSideCount > 0 ? `
                    <div class="modhub-list-toolbar">
                        ${window._modHubBatchMode ? `
                            <div id="modHubBatchToolbar" class="modhub-batch-toolbar">
                                <div class="modhub-batch-info">
                                    已选择 <span id="modHubBatchCount" class="gold">${window._modHubSelectedMods ? window._modHubSelectedMods.size : 0}</span> 个模组
                                </div>
                                <div class="modhub-batch-actions">
                                    <button class="macro-button modhub-btn-primary modhub-batch-btn" type="button" onclick="window.modHubBatchSelectAll()">全选</button>
                                    <button class="macro-button modhub-btn-primary modhub-batch-btn" type="button" onclick="window.modHubBatchInvertSelect()">反选</button>
                                    <button class="macro-button modhub-btn-primary modhub-batch-btn" data-batch-action="enable" type="button" onclick="window.modHubBatchEnable()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}>批量启用</button>
                                    <button class="macro-button modhub-btn-primary modhub-batch-btn" data-batch-action="disable" type="button" onclick="window.modHubBatchDisable()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}>批量禁用</button>
                                    <button class="macro-button modhub-btn-delete modhub-batch-btn" data-batch-action="delete" type="button" onclick="window.modHubBatchDelete()" ${(window._modHubSelectedMods && window._modHubSelectedMods.size > 0) ? '' : 'disabled'}><span class="red">批量删除</span></button>
                                    <button id="modHubBatchToggleBtn" class="macro-button modhub-btn-cancel modhub-batch-btn" type="button" onclick="window.modHubToggleBatchMode(false)">退出多选</button>
                                </div>
                            </div>
                        ` : `
                            <button id="modHubBatchToggleBtn" class="macro-button modhub-btn-primary" type="button" title="进入批量多选模式，支持批量启用、禁用与删除" onclick="window.modHubToggleBatchMode(true)">多选操作</button>
                        `}
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
                if (versionText) descParts.push(versionText);
                if (subText) descParts.push(`<span class="modhub-mod-alias">${window.modHubEscapeHtml(subText)}</span>`);
            } else {
                descParts.push('已禁用');
                if (subText) descParts.push(`<span class="modhub-mod-alias">${window.modHubEscapeHtml(subText)}</span>`);
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
                            <div class="modhub-item-title ${isEnabled ? '' : 'grey'}">${window.modHubEscapeHtml(modName)}</div>
                            <div class="grey modhub-item-desc">${descHtml}${updateTagHtml}</div>
                        </div>
                    </div>
                    <div class="modhub-btn-group">
                        ${updateBtnHtml}
                        <button class="macro-button modhub-btn-move modhub-side-move-up" data-index="${index}" title="上移一位（长按直接置顶）" aria-label="上移或置顶" ${isRecovery ? 'disabled' : ''}>▲</button>
                        <button class="macro-button modhub-btn-move modhub-side-move-down" data-index="${index}" title="下移一位（长按直接置底）" aria-label="下移或置底" ${isRecovery ? 'disabled' : ''}>▼</button>
                        <button class="macro-button modhub-btn-toggle ${isEnabled ? '' : 'btn-enable'}" data-mod-action="toggle" title="${isEnabled ? '禁用该模组' : '启用该模组'}">${isEnabled ? '禁用' : '启用'}</button>
                        <button class="macro-button modhub-btn-delete btn-delete" data-mod-action="delete" title="永久删除该模组"><span class="red">删除</span></button>
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

    // 分组 3: 内置模组列表（只读展示）
    html += `
        <details class="modhub-collapsible-section" data-section="core"${isSectionOpen('core') ? ' open' : ''}>
            <summary class="modhub-section-summary">内置与核心模组 - 共 ${builtInList.length} 个</summary>
            <div class="modhub-section-content">
                <ul class="modhub-list">
    `;

    builtInList.forEach(modName => {
        const modInfo = window.modHubGetModInfo(modName);
        const version = modInfo?.bootJson?.version || '';
        const subText = window.modHubGetModSubtext(modName, modInfo, true);
        const versionText = version ? (window.modHubFormatVersion ? window.modHubFormatVersion(version) : (/^v/i.test(version.trim()) ? version.trim() : 'v' + version.trim())) : '';
        const descHtml = [versionText, subText ? `<span class="modhub-mod-alias">${window.modHubEscapeHtml(subText)}</span>` : '']
            .filter(Boolean)
            .join(' | ') || '系统核心组件';
        html += `
            <li class="modhub-item item-readonly">
                <div class="modhub-item-info">
                    <span class="gold modhub-status-tag">[核心]</span>
                    <div class="modhub-item-main">
                        <div class="modhub-item-title">${window.modHubEscapeHtml(modName)}</div>
                        <div class="grey modhub-item-desc">${descHtml}</div>
                    </div>
                </div>
            </li>
        `;
    });
    html += '</ul></div></details>';

    container.innerHTML = html + '</fieldset>';
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
    window.modHubRenderBeautyUI();

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

// 判断模组是否属于核心框架（如秋枫白桦框架、简易框架等互斥或核心底层框架）
window.modHubIsFrameworkMod = function(modName) {
    if (!modName) return false;
    const raw = String(modName).trim();
    if (!raw) return false;
    const normalize = str => String(str || '').toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    const norm = normalize(raw);
    if (!norm) return false;

    // 1. 优先比对冲突规则组
    const conflictRules = window.modHubMarket?.KNOWN_MOD_CONFLICT_RULES || [
        {
            id: 'maplebirch-vs-simpleframework',
            conflictingGroups: [
                {
                    key: 'maplebirch',
                    aliases: ['maplebirch', '秋枫白桦', '秋枫白桦框架', '枫叶框架', 'maplebirchframework', 'scml-dol-maplebirchframework', 'scmldolmaplebirchframework']
                },
                {
                    key: 'simpleframework',
                    aliases: ['simpleframework', '简易框架', 'scmlsimpleframework', 'simpleframeworks', 'Simple Frameworks', 'SimpleFrameworks']
                }
            ]
        }
    ];

    for (const rule of conflictRules) {
        for (const grp of rule.conflictingGroups || []) {
            const keys = [grp.key, ...(grp.aliases || [])].map(normalize);
            if (keys.some(k => norm === k || (k.length >= 3 && norm.includes(k)) || (norm.length >= 3 && k.includes(norm)))) {
                return true;
            }
        }
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
    return !!(window._modHubManagerBusy || window._modHubModLoading || window.modHubMarket?.isInstallBusy?.() ||
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

window.modHubEnsureRecoveryPlacement = async function() {
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
    }, '正在保护并固定恢复工具加载顺序...', { trackReload: true, restoreLabel: '固定恢复工具加载顺序' });
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
    const saved = await window.modHubRunManagerAction(async () => {
        const gui = window.modHubGetGui();
        if (!gui) {
            window.modHubShowToast('未找到模组管理器实例', 'warning');
            return false;
        }

        const button = document.getElementById('modHubSmartSortAllBtn');
        if (button) {
            button.disabled = true;
            button.textContent = '正在整理...';
        }

        try {
            let sideChanged = false;
            let beautyChanged = false;

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

            if (sideChanged && !await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');
            if (beautyChanged && !await window.modHubSaveBeautyState(false)) throw new Error('美化配置保存失败');

            const details = [];
            if (sideChanged) details.push('旁加载加载顺序');
            if (beautyChanged) details.push('美化覆盖顺序');
            const message = `已按依赖关系智能整理【${details.join(' 与 ')}】`;
            window.modHubShowToast(message, 'success');
            return message;
        } catch (e) {
            console.error('[ModHub] 智能整理顺序失败', e);
            throw e;
        } finally {
            if (button?.isConnected) {
                button.disabled = false;
                button.textContent = '智能整理模组与美化顺序';
            }
        }
    }, undefined, { trackReload: true });
    return saved;
};

// 旁加载模组移动（支持短按步进与长按置顶/置底）
window.modHubMoveSideMod = async function(index, deltaOrPosition) {
    return window.modHubRunManagerAction(async () => {
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

        window.modHubEnsureModStateSync(state);
        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');


        const name = item.name;
        if (deltaOrPosition === 'top') {
            window.modHubShowToast(`已将【${name}】置顶`, 'success');
        } else if (deltaOrPosition === 'bottom') {
            window.modHubShowToast(`已将【${name}】置底`, 'success');
        }
    }, undefined, { trackReload: true });
};

// 两个框架共用真实包体声明；原生别名代供与两个包同时提供别名须区别展示。
window.modHubGetFrameworkPairRisk = function(maple, simple) {
    const mapleBoot = maple?.bootJson;
    const simpleBoot = simple?.bootJson;
    const canonical = value => String(value || '').trim().toLowerCase();
    if (mapleBoot?.name && simpleBoot?.name && canonical(mapleBoot.name) === canonical(simpleBoot.name)) return null;
    let providesSimple = Array.isArray(mapleBoot?.alias)
        && mapleBoot.alias.some(alias => canonical(alias) === 'simple frameworks');
    // 预检前仅允许已审计的精确发布预览，不能把目录最新版套到所选历史包。
    if (!mapleBoot) {
        const release = maple?.releaseInfo;
        const source = release?.githubUrl || maple?.githubUrl;
        const tag = String(release?.tag || release?.tagName || '');
        providesSimple = String(release?.version || '') === '5.1.3' && tag === 'maplebirch-release-v5.1.3'
            && /^https:\/\/github\.com\/MaplebirchLeaf\/SCML-DOL-maplebirchframework(?:\/|$)/i.test(String(source || ''));
    }
    return providesSimple ? {
        ruleId: 'framework-alias-provider-overlap', kind: 'alias-provider-overlap', level: 'warning',
        reason: '秋枫白桦框架通过原生 alias 声明提供 Simple Frameworks。两个独立框架包同时启用会重复提供这一技术名，ModLoader 的依赖解析可能选中不同提供者。',
        advice: '通常只需启用一个提供者。请按模组作者要求选择框架，并核对版本范围；原生别名代供不代表两个框架必须同时加载。'
    } : {
        ruleId: 'maplebirch-vs-simpleframework', kind: 'unverified-framework-pair', level: 'warning',
        reason: '当前秋枫白桦框架包没有可核验的 Simple Frameworks 原生别名声明，尚不能确认这两个框架同时加载的兼容性。',
        advice: '请核对这两个实际版本的作者说明；没有明确兼容依据时，建议先只启用模组要求的框架。'
    };
};

// 检测即将启用的框架与当前已启用提供者，保留原始技术名与包体边界。
window.modHubCheckEnableConflicts = function(targetModName, activeMods) {
    if (!targetModName || !Array.isArray(activeMods) || !activeMods.length) return null;

    const conflictRules = window.modHubMarket?.KNOWN_MOD_CONFLICT_RULES || [
        {
            id: 'maplebirch-vs-simpleframework',
            name: '秋枫白桦框架 与 简易框架 提供者检查',
            conflictingGroups: [
                {
                    key: 'maplebirch',
                    name: '秋枫白桦框架',
                    aliases: [
                        'maplebirch', '秋枫白桦', '秋枫白桦框架', '枫叶框架', 'maplebirchframework',
                        'scml-dol-maplebirchframework', 'scmldolmaplebirchframework',
                        'MaplebirchLeaf/SCML-DOL-maplebirchframework'
                    ]
                },
                {
                    key: 'simpleframework',
                    name: '简易框架',
                    aliases: [
                        'simpleframework', '简易框架', 'scmlsimpleframework',
                        'simpleframeworks', 'Simple Frameworks', 'SimpleFrameworks',
                        'emicoto/SCMLSimpleFramework'
                    ]
                }
            ],
            reason: '需要按实际包体核对框架提供者与兼容依据。',
            level: 'danger'
        }
    ];

    const normalize = str => String(str || '').toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    const stripPrefix = str => String(str || '').replace(/^(?:degrees[-_\s]?of[-_\s]?lewdity[-_\s]?|dol[-_\s]?)/i, '');

    // 核心识别引擎：判断模组名或模组对象归属于哪一个互斥冲突组
    const resolveModConflictGroup = (modOrName, rule) => {
        if (!modOrName || !Array.isArray(rule.conflictingGroups) || rule.conflictingGroups.length < 2) return null;
        const [groupA, groupB] = rule.conflictingGroups;
        const keysA = [groupA.key, ...(groupA.aliases || [])].map(normalize).filter(Boolean);
        const keysB = [groupB.key, ...(groupB.aliases || [])].map(normalize).filter(Boolean);

        const rawName = typeof modOrName === 'string' ? modOrName : (modOrName.name || '');
        const norm = normalize(rawName);
        const stripped = normalize(stripPrefix(rawName));

        // 1. 直接名称高精比对（Direct Literal Match）：最高优先级，杜绝跨组别名串门
        const directA = keysA.some(k => norm === k || stripped === k);
        const directB = keysB.some(k => norm === k || stripped === k);

        if (directA && !directB) return groupA;
        if (directB && !directA) return groupB;
        if (directA && directB) {
            // 若两方同时模糊包含，优先完全相等者
            if (keysA.some(k => norm === k || stripped === k)) return groupA;
            if (keysB.some(k => norm === k || stripped === k)) return groupB;
        }

        // 2. 回退检查 bootJson（严禁使用对手别名与 boot.alias）
        const info = window.modHubGetModInfo?.(rawName);
        const disabledInfo = window._modHubDisabledModInfo?.get(rawName.trim().toLowerCase()) || window._modHubDisabledModInfo?.get(norm);
        const boot = info?.bootJson || disabledInfo?.bootJson;
        if (boot) {
            const bootName = boot.name ? normalize(boot.name) : '';
            const bootStripped = boot.name ? normalize(stripPrefix(boot.name)) : '';
            const bootA = keysA.some(k => bootName === k || bootStripped === k);
            const bootB = keysB.some(k => bootName === k || bootStripped === k);
            if (bootA && !bootB) return groupA;
            if (bootB && !bootA) return groupB;
        }

        return null;
    };

    // 获取防污染的友好中文名称
    const getCleanDisplayName = (modName, group) => {
        if (!group) return modName;
        // 如果确定是简易框架组，强制统一展示其标准中文名，杜绝被 ModLoader 别名解析污染为秋枫白桦
        if (group.key === 'simpleframework') return group.name || '简易框架';
        if (group.key === 'maplebirch') return group.name || '秋枫白桦框架';

        const subtext = window.modHubGetModSubtext(modName, window.modHubGetModInfo?.(modName), false, true);
        return subtext || group.name || modName;
    };
    const profileFor = (name, item) => ({ name,
        bootJson: item?.bootJson || window._modHubDisabledModInfo?.get(String(name).toLowerCase())?.bootJson
            || window.modHubGetModInfo?.(name)?.bootJson });

    for (const rule of conflictRules) {
        if (!Array.isArray(rule.conflictingGroups) || rule.conflictingGroups.length < 2) continue;
        const [groupA, groupB] = rule.conflictingGroups;

        const targetGroup = resolveModConflictGroup(targetModName, rule);
        if (!targetGroup) continue;

        const opponentGroup = (targetGroup === groupA) ? groupB : groupA;

        for (const active of activeMods) {
            const activeName = typeof active === 'string' ? active : active?.name;
            if (!activeName || activeName === targetModName || active?.enabled === false) continue;

            const activeGroup = resolveModConflictGroup(activeName, rule);
            if (activeGroup === opponentGroup) {
                const target = profileFor(targetModName);
                const local = profileFor(activeName, active);
                const risk = window.modHubGetFrameworkPairRisk(targetGroup.key === 'maplebirch' ? target : local,
                    targetGroup.key === 'simpleframework' ? target : local);
                if (!risk) continue;
                return {
                    ...risk,
                    targetDisplayName: getCleanDisplayName(targetModName, targetGroup),
                    conflictDisplayName: getCleanDisplayName(activeName, opponentGroup),
                    targetModName,
                    conflictModName: activeName,
                    targetRawName: targetModName,
                    conflictRawName: activeName,
                };
            }
        }
    }

    return null;
};

// 查找本地依赖于指定模组的其它模组列表（用于删除模组或禁用框架时的影响评估）
window.modHubFindDependentMods = async function(targetModName) {
    if (!targetModName) return [];
    const state = window._modHubModState;
    const allMods = state?.sideMods || [];

    const normalize = str => String(str || '').toLowerCase().replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '').trim();
    const stripPrefix = str => String(str || '').replace(/^(?:degrees[-_\s]?of[-_\s]?lewdity[-_\s]?|dol[-_\s]?)/i, '');

    // 冲突规则定义
    const conflictRules = window.modHubMarket?.KNOWN_MOD_CONFLICT_RULES || [
        {
            id: 'maplebirch-vs-simpleframework',
            conflictingGroups: [
                {
                    key: 'maplebirch',
                    name: '秋枫白桦框架',
                    aliases: ['maplebirch', '秋枫白桦', '秋枫白桦框架', '枫叶框架', 'maplebirchframework', 'scml-dol-maplebirchframework', 'scmldolmaplebirchframework']
                },
                {
                    key: 'simpleframework',
                    name: '简易框架',
                    aliases: ['simpleframework', '简易框架', 'scmlsimpleframework', 'simpleframeworks', 'Simple Frameworks', 'SimpleFrameworks']
                }
            ]
        }
    ];

    // 尝试获取目标模组自身的 bootJson
    const targetModInfo = window.modHubGetModInfo(targetModName);
    const targetBoot = targetModInfo?.bootJson || window._modHubDisabledModInfo?.get(normalize(targetModName))?.bootJson;

    // 1. 判定目标模组匹配到的冲突组与对手冲突组
    const isNameMatchingGroup = (name, grp) => {
        if (!name) return false;
        const norm = normalize(name);
        const stripped = normalize(stripPrefix(name));
        const grpKeys = [grp.key, ...(grp.aliases || [])].map(normalize);
        return grpKeys.some(k => norm === k || stripped === k || (k.length >= 4 && (norm.includes(k) || (stripped && stripped.includes(k)))));
    };

    let matchingGroup = null;
    let matchedRule = null;
    for (const rule of conflictRules) {
        for (const grp of rule.conflictingGroups || []) {
            if (isNameMatchingGroup(targetModName, grp) || (targetBoot?.name && isNameMatchingGroup(targetBoot.name, grp))) {
                matchingGroup = grp;
                matchedRule = rule;
                break;
            }
        }
        if (matchingGroup) break;
    }

    // 2. 收集对手组别名，防止互斥组别名交叉污染导致误诊
    const opponentKeySet = new Set();
    if (matchedRule && matchingGroup) {
        for (const grp of matchedRule.conflictingGroups || []) {
            if (grp !== matchingGroup) {
                [grp.key, ...(grp.aliases || [])].map(normalize).forEach(k => opponentKeySet.add(k));
            }
        }
    }

    const isOpponentKey = (norm) => {
        if (!norm) return false;
        if (opponentKeySet.has(norm)) return true;
        for (const opp of opponentKeySet) {
            if (opp.length >= 4 && (norm === opp || norm.includes(opp) || opp.includes(norm))) return true;
        }
        return false;
    };

    // 3. 构建目标键集合（排除对手组所有标识）
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

    // 若属于冲突组，仅追加该同盟组的别名
    if (matchingGroup) {
        [matchingGroup.key, ...(matchingGroup.aliases || [])].forEach(addKey);
    }

    const matchesTarget = (name) => {
        if (!name) return false;
        const norm = normalize(name);
        const stripped = normalize(stripPrefix(name));

        // 关键防线：若依赖项明确指向对手冲突组，绝不视为依赖本目标模组
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

    // 当即将启用模组时，进行本地已知冲突检测
    if (targetEnable) {
        const conflict = window.modHubCheckEnableConflicts(modName, state.sideMods.filter(m => m.enabled && m.name !== modName));
        if (conflict) {
            const proceed = await window.modHubConfirm({
                title: '模组冲突风险确认',
                message: `检测到即将启用的框架与当前提供者需要进一步核对：\n\n· 即将启用：【${conflict.targetDisplayName}】\n· 当前已启用冲突模组：【${conflict.conflictDisplayName}】\n\n原因：${conflict.reason}\n\n请核对上述包体声明、版本要求与提供者选择。\n\n是否确认继续启用？`,
                trustedMessageHtml: `
                    <div class="modhub-modal-conflict-intro">检测到即将启用的框架与当前提供者需要进一步核对：</div>
                    <div class="modhub-modal-conflict-alert-box" style="margin: 12px 0; padding: 10px 14px; background: rgba(220, 53, 69, 0.12); border: 1px solid rgba(220, 53, 69, 0.35); border-radius: 4px;">
                        <div style="font-weight: bold; color: var(--red, #ff5555); margin-bottom: 6px;">
                            · 即将启用：【${window.modHubEscapeHtml(conflict.targetDisplayName)}】<br>
                            · 当前已启用冲突模组：【${window.modHubEscapeHtml(conflict.conflictDisplayName)}】
                        </div>
                        <div class="grey" style="font-size: 0.9em; line-height: 1.4;">
                            ${window.modHubEscapeHtml(conflict.reason)}
                        </div>
                        <div class="modhub-conflict-action-row" style="margin-top: 8px;">
                            <button type="button" class="macro-button modhub-conflict-disable-btn" id="modHubModalConflictDisableBtn" data-conflict-raw="${window.modHubEscapeHtml(conflict.conflictModName)}" data-conflict-name="${window.modHubEscapeHtml(conflict.conflictDisplayName)}">
                                快捷禁用【${window.modHubEscapeHtml(conflict.conflictDisplayName)}】
                            </button>
                        </div>
                    </div>
                    <div class="modhub-modal-conflict-question grey">请核对上述包体声明、版本要求与提供者选择。<br>是否确认继续启用？</div>
                `,
                confirmText: '继续启用',
                cancelText: '暂不启用',
                confirmType: 'danger',
                confirmDelay: 5,
                onRender: (dialog) => {
                    const disableBtn = dialog.querySelector('#modHubModalConflictDisableBtn');
                    if (!disableBtn) return;

                    disableBtn.onclick = async (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        const rawName = conflict.conflictModName;
                        const displayName = conflict.conflictDisplayName || rawName;
                        if (!rawName) return;

                        const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');
                        const affectedMods = typeof window.modHubFindDependentMods === 'function'
                            ? await window.modHubFindDependentMods(rawName)
                            : [];

                        let confirmProceed = false;
                        if (affectedMods.length > 0) {
                            const modItemsHtml = affectedMods.map(m => `
                                <div class="modhub-modal-affected-item">
                                    · <span class="gold">【${escape(m.name)}】</span>${m.version ? ` <span class="grey">(${escape(m.version)})</span>` : ''}
                                </div>
                            `).join('');
                            const modLinesText = affectedMods.map(m => `· 【${m.name}】${m.version ? ` (${m.version})` : ''}`).join('\n');

                            confirmProceed = await window.modHubConfirm({
                                title: `确认快捷禁用【${displayName}】？`,
                                message: `禁用【${displayName}】后，以下依赖该框架的模组可能会受到影响或无法正常运行：\n\n${modLinesText}\n\n是否仍然确认禁用？`,
                                trustedMessageHtml: `
                                    <div class="modhub-modal-intro">禁用 <span class="gold">【${escape(displayName)}】</span> 后，以下依赖该框架的模组可能会受到影响或无法正常运行：</div>
                                    <div class="modhub-modal-affected-box">
                                        ${modItemsHtml}
                                    </div>
                                    <div class="grey modhub-modal-question" style="margin-top:10px;">是否仍然确认禁用该冲突框架？</div>
                                `,
                                confirmText: '确认禁用',
                                cancelText: '暂不禁用',
                                confirmType: 'danger'
                            });
                        } else {
                            confirmProceed = await window.modHubConfirm({
                                title: `确认快捷禁用【${displayName}】？`,
                                message: `确定要禁用【${displayName}】吗？\n禁用后该框架将暂停加载，本次冲突风险将被排除。`,
                                trustedMessageHtml: `
                                    <div>确定要禁用 <span class="gold">【${escape(displayName)}】</span> 吗？</div>
                                    <div class="grey" style="margin-top:6px;">禁用后该框架将暂停加载，本次冲突风险将被排除。</div>
                                `,
                                confirmText: '确认禁用',
                                cancelText: '取消',
                                confirmType: 'warning'
                            });
                        }

                        if (!confirmProceed) return;

                        disableBtn.disabled = true;
                        disableBtn.textContent = '正在禁用...';

                        try {
                            if (!await window.modHubToggleSideMod(rawName, false, { skipConfirm: true, silentOfferReload: true, trackReload: true, restoreContext: options.restoreContext })) throw new Error('快捷禁用未完成');

                            if (typeof dialog.modHubClearDelay === 'function') {
                                dialog.modHubClearDelay();
                            }

                            const alertBox = dialog.querySelector('.modhub-modal-conflict-alert-box');
                            if (alertBox) {
                                alertBox.className = 'modhub-modal-conflict-alert-box is-resolved';
                                alertBox.style.background = '';
                                alertBox.style.border = '';
                                alertBox.innerHTML = `
                                    <div style="font-weight: bold; color: #4ade80; margin-bottom: 6px;">
                                        · 即将启用：【${escape(conflict.targetDisplayName)}】<br>
                                        · 冲突模组：【${escape(conflict.conflictDisplayName)}】<span style="color: #4ade80; font-size: 0.85em; font-weight: normal;">（已快捷禁用 · 风险已排除）</span>
                                    </div>
                                    <div class="grey" style="font-size: 0.9em; line-height: 1.4;">
                                        框架同时加载风险已排除，可继续启用【${escape(conflict.targetDisplayName)}】。
                                    </div>
                                `;
                            }

                            const titleEl = dialog.querySelector('.modhub-modal-title');
                            if (titleEl) {
                                titleEl.className = 'gold modhub-modal-title';
                                titleEl.textContent = '冲突已排除 · 确认启用';
                            }

                            const questionEl = dialog.querySelector('.modhub-modal-conflict-question');
                            if (questionEl) {
                                questionEl.className = 'modhub-modal-conflict-question green';
                                questionEl.textContent = '冲突模组已成功禁用，本次启用无冲突风险。点击下方按钮即可完成启用。';
                            }

                            const confirmBtn = dialog.querySelector('.modhub-modal-btn-confirm');
                            if (confirmBtn) {
                                confirmBtn.className = confirmBtn.className.replace(/\bmodhub-btn-danger\b/, 'modhub-btn-primary');
                                confirmBtn.disabled = false;
                                confirmBtn.textContent = '确认启用';
                            }
                        } catch (err) {
                            console.error('[modHubToggleSideMod] 快捷禁用冲突模组失败:', err);
                            disableBtn.disabled = false;
                            disableBtn.textContent = `快捷禁用【${escape(displayName)}】`;
                        }
                    };
                }
            });
            if (!proceed) return false;
        }
    }

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
                    · <span class="gold">【${escape(m.name)}】</span>${m.version ? ` <span class="grey">(${escape(m.version)})</span>` : ''}${m.isEnabled ? '' : ' <span class="grey">[已禁用]</span>'}
                </div>
            `).join('');
            const modLinesText = affectedMods.map(m => `· 【${m.name}】${m.version ? ` (${m.version})` : ''}${m.isEnabled ? '' : ' [已禁用]'}`).join('\n');

            const confirmProceed = await window.modHubConfirm({
                title: `确认禁用【${displayName}】？`,
                message: `禁用【${displayName}】后，以下依赖该${targetTypeLabel}的模组可能会受到影响或无法正常运行：\n\n${modLinesText}\n\n${selfNotice ? selfNotice + '\n\n' : ''}是否仍然确认禁用？`,
                trustedMessageHtml: `
                    <div class="modhub-modal-intro">禁用 <span class="gold">【${escape(displayName)}】</span> 后，以下依赖该${targetTypeLabel}的模组可能会受到影响或无法正常运行：</div>
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
        const currentState = window._modHubModState;
        const currentItem = currentState?.sideMods?.find(m => m.name === modName);
        if (!currentItem || currentItem.enabled === targetEnable) return false;
        currentItem.enabled = targetEnable;
        window.modHubEnsureModStateSync(currentState);

        if (!await window.modHubSaveModManageState(false)) throw new Error('模组配置保存失败');

        // 禁用时始终同步停用所属图包；自动启用开关只控制启用方向。
        await window.modHubLoadBeautyState();

        window.modHubShowToast(`模组【${modName}】已${targetEnable ? '启用' : '禁用'}，重新载入后生效`, 'success');
        return true;
    }, undefined, { trackReload: options.trackReload ?? !options.silentOfferReload, immediateReload,
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
            return `<div>· <span class="gold">${window.modHubEscapeHtml(m.name)}</span>${ver}${status}</div>`;
        }).join('');
        const affectedListText = affectedMods.map(m => `· ${m.name}${m.version ? ` (${m.version})` : ''}${m.isEnabled ? '' : ' [已禁用]'}`).join('\n');

        const trustedMessageHtml = `
            <div class="modhub-modal-conflict-intro">确定要彻底删除模组【<span class="gold">${window.modHubEscapeHtml(modDisplayName)}</span>】吗？</div>
            <div class="modhub-modal-conflict-alert-box" style="margin: 12px 0; padding: 10px 14px; background: rgba(220, 53, 69, 0.12); border: 1px solid rgba(220, 53, 69, 0.35); border-radius: 4px;">
                <div style="font-weight: bold; color: var(--red, #ff5555); margin-bottom: 6px;">
                    警告：检测到以下模组依赖于该模组/框架，删除后可能会受到严重影响或无法正常运行：
                </div>
                <div style="max-height: 140px; overflow-y: auto; font-size: 0.9em; line-height: 1.6;">
                    ${affectedListHtml}
                </div>
            </div>
            ${selfNoticeHtml}
            <div class="grey" style="font-size: 0.9em; margin-top: 8px;">删除后该模组将从浏览器存储中彻底移除。是否仍要删除？</div>
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
            trustedMessageHtml: isModHub ? `<p class="modhub-self-removal-intro">确定要删除模组【<strong class="gold">${window.modHubEscapeHtml(modName)}</strong>】吗？</p>${selfNoticeHtml}` : '',
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
    }, undefined, { trackReload: true, immediateReload: isFramework || isModHub, restoreLabel: `删除模组【${modName}】` });
    if (saved) {
        window.modHubShowToast(`已删除模组【${modName}】，重新载入后生效`, 'warning');
        if (isFramework || isModHub) await window.modHubOfferReload(`模组【${modDisplayName || modName}】已从模组列表中删除。`, { isFramework });
    }
    return saved;
};

// 保存模组管理状态
// options.dropNames：本次操作中明确移除、不允许被「已安装保留」逻辑复活的模组名
window.modHubSaveModManageState = async function(showSuccess = true, options = {}) {
    const state = window._modHubModState;
    if (!state) return false;
    window.modHubEnsureModStateSync(state);
    const protectedNames = new Set(window.modHubProtectedRecoveryNames().map(name => name.toLowerCase()));
    const first = window.modHubKeepRecoveryOrder(state.sideEnabled).filter(name => protectedNames.has(name.toLowerCase()));
    const ordered = [...first, ...state.sideMods.map(item => item.name).filter(name => !first.includes(name))];
    state.sideMods = state.sideMods.slice().sort((a, b) => ordered.indexOf(a.name) - ordered.indexOf(b.name));
    window.modHubEnsureModStateSync(state);

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

    const currentEnabled = state.sideMods.filter(m => m.enabled).map(m => m.name);
    for (const name of toEnable) {
        const otherToEnable = toEnable.filter(n => n !== name);
        const activeGroup = [...currentEnabled, ...otherToEnable];
        const conflict = window.modHubCheckEnableConflicts(name, activeGroup);
        if (conflict) {
            const proceed = await window.modHubConfirm({
                title: '模组冲突风险确认',
                message: `待启用的模组中包含互斥框架：【${conflict.targetDisplayName}】与【${conflict.conflictDisplayName}】。\n\n原因：${conflict.reason}\n\n是否确认继续批量启用？`,
                confirmText: '继续启用',
                cancelText: '取消',
                confirmType: 'danger'
            });
            if (!proceed) return false;
            break;
        }
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
    }, undefined, { trackReload: true, restoreLabel: `批量启用 ${toEnable.length} 个模组` });

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
                · <span class="gold">【${escape(m.name)}】</span>${m.version ? ` <span class="grey">(${escape(m.version)})</span>` : ''} <span class="grey">（依赖于 ${m.dependOn.map(escape).join('、')}）</span>
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
    }, undefined, { trackReload: true, restoreLabel: `批量禁用 ${toDisable.length} 个模组` });

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
        return `<div>· <span class="gold">${escape(disp)}</span></div>`;
    }).join('');

    let trustedMessageHtml = '';
    if (affectedMap.size > 0) {
        const affectedList = Array.from(affectedMap.values());
        const affectedListHtml = affectedList.map(m => `
            <div>· <span class="gold">${escape(m.name)}</span>${m.version ? ` (${escape(m.version)})` : ''} <span class="grey">（依赖于 ${m.dependOn.map(escape).join('、')}）</span></div>
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
    }, undefined, { trackReload: true, restoreLabel: `批量删除 ${toDelete.length} 个模组` });

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
window.jQuery?.(document).one?.(':storyready.modHubRecoveryPlacement', async () => {
    try {
        await window.modHubLoadModManageState();
        await window.modHubEnsureRecoveryPlacement();
    } catch (error) {
        console.warn('[ModHub] 恢复工具顺序核验未完成', error);
    }
});
