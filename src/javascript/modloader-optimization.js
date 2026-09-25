/**
 * ModHub - 模组加载器优化与增强模块
 * 提供基于游戏内置界面的模组管理、美化包排序、ReadMe 查看与通用运行设置
 */

// 全局启动错误与控制台异常捕获器（捕获 ModLoader 未录入文本的严重依赖或运行时异常）
window._dolOptStartupErrors = window._dolOptStartupErrors || [];

if (typeof window !== 'undefined' && !window._dolOptGlobalErrorHooked) {
    window._dolOptGlobalErrorHooked = true;

    // 1. 监听全局脚本未捕获错误
    window.addEventListener?.('error', (event) => {
        const msg = event?.message || '';
        if (msg && !msg.includes('ResizeObserver loop')) {
            window._dolOptStartupErrors.push(`[脚本异常] ${msg} (${event.filename || ''}:${event.lineno || 0})`);
            window._dolOptHasDetectedStartupError = true;
            window._dolOptPendingAutoOpenErrorLog = true;
            if (typeof window.dolOptCheckAndAutoOpenErrorLog === 'function' && typeof window.dolOptIsGameStartupReady === 'function' && window.dolOptIsGameStartupReady()) {
                window.dolOptCheckAndAutoOpenErrorLog();
            }
        }
    });

    // 2. 监听未捕获的 Promise 拒绝
    window.addEventListener?.('unhandledrejection', (event) => {
        const reason = event?.reason?.message || event?.reason || '';
        if (reason) {
            window._dolOptStartupErrors.push(`[异步异常] ${reason}`);
            window._dolOptHasDetectedStartupError = true;
            window._dolOptPendingAutoOpenErrorLog = true;
            if (typeof window.dolOptCheckAndAutoOpenErrorLog === 'function' && typeof window.dolOptIsGameStartupReady === 'function' && window.dolOptIsGameStartupReady()) {
                window.dolOptCheckAndAutoOpenErrorLog();
            }
        }
    });

    // 3. 监控控制台 error 中的启动与依赖报错
    if (typeof console !== 'undefined' && console.error) {
        const origConsoleError = console.error;
        console.error = function(...args) {
            try {
                const text = args.map(a => typeof a === 'string' ? a : (a?.message || JSON.stringify(a) || '')).join(' ');
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
                    window._dolOptStartupErrors.push(`[控制台报错] ${text}`);
                    window._dolOptHasDetectedStartupError = true;
                    window._dolOptPendingAutoOpenErrorLog = true;
                    if (typeof window.dolOptCheckAndAutoOpenErrorLog === 'function' && typeof window.dolOptIsGameStartupReady === 'function' && window.dolOptIsGameStartupReady()) {
                        setTimeout(() => window.dolOptCheckAndAutoOpenErrorLog(), 50);
                    }
                }
            } catch (_) {}
            return origConsoleError.apply(this, args);
        };
    }
}

// 统一 Toast 提示
window.dolOptShowToast = function(message, type = '', duration = 2500) {
    let toast = document.getElementById('dolOptToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'dolOptToast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast ' + type + ' show';
    if (window._dolOptToastTimer) clearTimeout(window._dolOptToastTimer);
    window._dolOptToastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, Math.max(1000, duration || 2500));
};

// 工具函数：获取 ModLoader Gui 实例
// ModLoader v2.101.1 起移除了 window.modLoaderGui，改用 window.modModLoadController + window.modUtils 直接暴露底层接口。
// 此处返回兼容层，将旧版 GUI 方法自动映射到新版 API，保证上层代码零感知平滑降级。
window.dolOptGetGui = function() {
    const legacyGui = window.modLoaderGui || window.modLoaderGuiInstance || null;
    if (legacyGui) return legacyGui;

    // ModLoader v2.101.1+ 兼容：构造最小化 GUI 代理对象
    const controller = window.modModLoadController ||
        (window.modSC2DataManager && typeof window.modSC2DataManager.getModLoadController === 'function'
            ? window.modSC2DataManager.getModLoadController() : null);
    const modUtils = window.modUtils ||
        (window.modSC2DataManager && typeof window.modSC2DataManager.getModUtils === 'function'
            ? window.modSC2DataManager.getModUtils() : null);
    if (!controller && !modUtils) return null;

    return {
        // listSideLoad* 已移除，映射到 ModLoadController IndexedDB 直读接口
        listSideLoadModNameOnly: controller
            ? () => controller.listModIndexDB()
            : () => Promise.resolve([]),
        listSideLoadHiddenModNameOnly: controller
            ? () => controller.loadHiddenModList()
            : () => Promise.resolve([]),
        // gModUtils 直接映射到新版全局 modUtils
        gModUtils: modUtils,
        // modModLoadController 保留引用
        modModLoadController: controller,
        // modLoadSwitch 安全模式开关（兼容旧版操作逻辑）
        modLoadSwitch: modUtils?.getModLoadSwitch ? modUtils.getModLoadSwitch() : null,
        // getModTReadMe 在 v2.101.1 中已移除，置为 null 让调用处的 typeof 守卫正确跳过
        getModTReadMe: null,
        // loadAndAddMod 在 v2.101.1 中已移除，dolOptHandleAddMod 内部已单独处理
        loadAndAddMod: null,
    };
};

// 工具函数：获取 ModLoadController 实例（管理 IndexDB 旁加载模组增删改存）
window.dolOptGetController = function() {
    const gui = window.dolOptGetGui();
    return window.modModLoadController ||
           (window.modSC2DataManager && typeof window.modSC2DataManager.getModLoadController === 'function' ? window.modSC2DataManager.getModLoadController() : null) ||
           (gui && gui.modModLoadController) ||
           gui;
};

// 统一按模组技术名去重，保留首次出现的加载顺序
window.dolOptUniqueModNames = function(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter(name => {
        if (typeof name !== 'string') return false;
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

window._dolOptDisabledModInfo = window._dolOptDisabledModInfo || new Map();

window.dolOptIsManagerTabLabel = function(text) {
    const label = String(text || '').trim();
    return ['模组管理', '模组市场', '模组说明', '加载日志'].some(name => label.startsWith(name));
};

// 重复导入后 getMod() 可能仍返回旧档案，优先取缓存中最后加载的同名模组
window.dolOptGetModInfo = function(modName) {
    const gui = window.dolOptGetGui();
    const utils = gui?.gModUtils;
    const key = String(modName || '').trim().toLowerCase();
    try {
        const cache = utils?.getModLoader?.()?.getModCacheArray?.() ||
            window.modSC2DataManager?.getModLoader?.()?.getModCacheArray?.() || [];
        for (let i = cache.length - 1; i >= 0; i--) {
            const mod = cache[i]?.mod || cache[i];
            if (String(mod?.name || '').trim().toLowerCase() === key) return mod;
        }
    } catch (_) {}
    return utils?.getAnyModByNameNoAlias?.(modName) ||
        utils?.getMod?.(modName) ||
        window._dolOptDisabledModInfo.get(key) || null;
};

// 禁用模组不会进入运行时缓存，直接从 ModLoader 的 IndexedDB 安装包读取 boot.json
window.dolOptLoadDisabledModInfo = async function(modNames, refresh = false) {
    const gui = window.dolOptGetGui();
    const names = window.dolOptUniqueModNames(Array.isArray(modNames)
        ? modNames
        : (gui?.listSideLoadHiddenModNameOnly ? await gui.listSideLoadHiddenModNameOnly() : []));
    if (!names.length) return 0;

    const utils = gui?.gModUtils;
    const loader = utils?.getModLoader?.()?.getIndexDBLoader?.();
    const keyval = utils?.getIdbKeyValRef?.();
    const controller = window.dolOptGetController();
    if (!loader?.customStore || typeof loader.constructor?.calcModNameKey !== 'function' ||
        typeof keyval?.get !== 'function' || typeof controller?.checkModZipFileIndexDB !== 'function') return 0;

    let loaded = 0;
    for (const name of names) {
        if (!refresh && window._dolOptDisabledModInfo.has(name.trim().toLowerCase())) continue;
        try {
            const data = await keyval.get(loader.constructor.calcModNameKey(name), loader.customStore);
            if (!data) continue;
            const bootJson = await controller.checkModZipFileIndexDB(data);
            if (!bootJson || typeof bootJson !== 'object' || Array.isArray(bootJson)) continue;
            window._dolOptDisabledModInfo.set(name.trim().toLowerCase(), {
                name: bootJson.name || name,
                bootJson
            });
            loaded++;
        } catch (error) {
            console.warn(`[DolOptimization] 读取已禁用模组【${name}】档案失败`, error);
        }
    }
    return loaded;
};

// 工具函数：读取 ModLoader 在 IndexedDB 中持久化的启用 / 禁用列表真实记录
// 内存状态可能因并发操作或陈旧快照与存储不一致，所有合并与校验都必须以这里读到的记录为准。
window.dolOptReadIndexDBModLists = async function() {
    const controller = window.dolOptGetController();
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
        console.warn('[DolOptimization] 读取模组列表失败', error);
        return { ok: false, enabled: [], disabled: [], error };
    }
};

// 工具函数：统一安全调用 overwriteModIndexDBModList / overwriteModIndexDBHiddenModList
// options.dropNames：本次操作中被明确移除、不允许被「已安装保留」逻辑复活的模组名（如删除模组）
// options.skipVerify：跳过写入后回读校验（仅供内部极端场景使用）
window.dolOptSaveIndexDBModList = async function(enabledList, disabledList, options = {}) {
    let targetEnabled = window.dolOptUniqueModNames(enabledList);
    const enabledNames = new Set(targetEnabled.map(name => name.trim().toLowerCase()));
    const targetDisabled = window.dolOptUniqueModNames(disabledList)
        .filter(name => !enabledNames.has(name.trim().toLowerCase()));
    const dropNames = new Set((Array.isArray(options.dropNames) ? options.dropNames : [])
        .map(name => String(name || '').trim().toLowerCase())
        .filter(Boolean));

    // 写入前与存储中的真实记录合并：
    // 一旦内存状态来自陈旧快照，直接覆盖会把已安装模组挤出启用列表，
    // 造成「包体仍在库中、ModLoader 却不再加载它」的假删除，故此处自动保留。
    const current = await window.dolOptReadIndexDBModLists();
    if (current.ok) {
        const known = new Set([...targetEnabled, ...targetDisabled].map(name => name.trim().toLowerCase()));
        const rescued = current.enabled.filter(name => {
            const key = name.trim().toLowerCase();
            return key && !known.has(key) && !dropNames.has(key);
        });
        if (rescued.length) {
            console.warn('[DolOptimization] 检测到已安装但未登记的模组，保存时自动保留:', rescued);
            targetEnabled = window.dolOptUniqueModNames([...targetEnabled, ...rescued]);
        }
    }

    const gui = window.dolOptGetGui();
    const controller = [window.dolOptGetController(), gui, gui?.modModLoadController].find(target =>
        typeof target?.overwriteModIndexDBModList === 'function' &&
        typeof target?.overwriteModIndexDBHiddenModList === 'function');
    if (!controller) throw new Error('未找到完整的 ModLoadController 模组列表存储接口');
    if (await controller.overwriteModIndexDBModList(targetEnabled) === false) throw new Error('启用列表保存失败');
    if (await controller.overwriteModIndexDBHiddenModList(targetDisabled) === false) throw new Error('禁用列表保存失败');

    // 写入后回读校验：ModLoader 对重复项 / 非字符串列表会静默跳过写入且不返回 false，
    // 只有回读比对才能真正确认配置已经落盘，杜绝「提示已保存但实际没生效」。
    if (current.ok && options.skipVerify !== true) {
        const after = await window.dolOptReadIndexDBModLists();
        if (after.ok) {
            const toSet = names => new Set(names.map(name => name.trim().toLowerCase()));
            const sameSet = (a, b) => a.size === b.size && [...a].every(name => b.has(name));
            const expectEnabled = toSet(targetEnabled);
            const expectDisabled = toSet(targetDisabled);
            const actualEnabled = toSet(after.enabled);
            const actualDisabled = toSet(after.disabled);
            if (!sameSet(expectEnabled, actualEnabled) || !sameSet(expectDisabled, actualDisabled)) {
                throw new Error('模组列表写入校验失败，存储中的记录与预期不一致');
            }
        }
    }
    return true;
};

// 工具函数：确保指定模组名已登记进 ModLoader 启用列表
// 用于安装完成后立即校验落盘结果，杜绝「包体已写入、模组却未启用」的假成功
window.dolOptEnsureModInEnabledList = async function(modName, options = {}) {
    const name = String(modName || '').trim();
    if (!name) return { ok: false, reason: '模组名为空' };
    const read = await window.dolOptReadIndexDBModLists();
    if (!read.ok) {
        return { ok: false, skipped: true, reason: read.error?.message || '无法读取模组列表' };
    }
    const key = name.toLowerCase();
    if (read.enabled.some(item => item.trim().toLowerCase() === key)) return { ok: true };

    const nextEnabled = window.dolOptUniqueModNames([...read.enabled, name, ...(options.extraEnabled || [])]);
    try {
        await window.dolOptSaveIndexDBModList(nextEnabled, read.disabled);
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
    const after = await window.dolOptReadIndexDBModLists();
    const ok = after.ok && after.enabled.some(item => item.trim().toLowerCase() === key);
    return ok ? { ok: true } : { ok: false, reason: '写入后回读仍未包含该模组' };
};

// 自愈：扫描 IndexedDB 中「有包体、却没有登记进启用 / 禁用列表」的孤儿模组
// 历史上某些保存动作会用陈旧的内存快照覆盖启用列表，把已安装模组挤出去，
// 包体仍在库中但 ModLoader 启动时不再加载它（表现为市场反复显示未安装 / 可更新）。
window.dolOptRepairOrphanModZips = async function(options = {}) {
    const result = { ok: false, scanned: 0, repaired: [], skipped: [] };
    const gui = window.dolOptGetGui();
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

    const lists = await window.dolOptReadIndexDBModLists();
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
        orphans.push(name);
    }
    if (!orphans.length) return result;

    // 逐个校验包体确实是合法模组，避免把异常残留写进启用列表
    const controller = window.dolOptGetController();
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
            console.warn(`[DolOptimization] 孤儿包体【${name}】校验失败，跳过:`, error);
            result.skipped.push(name);
        }
    }
    if (!confirmed.length) return result;

    try {
        await window.dolOptSaveIndexDBModList([...lists.enabled, ...confirmed], lists.disabled);
        result.repaired = confirmed;
        console.warn('[DolOptimization] 已自动修复未登记生效的已安装模组:', confirmed);
        if (options.notify !== false && confirmed.length) {
            window.dolOptShowToast(`已恢复 ${confirmed.length} 个未登记生效的已安装模组，重新载入游戏后生效`, 'success');
        }
    } catch (error) {
        console.warn('[DolOptimization] 修复已安装未登记模组失败:', error);
        result.ok = false;
        result.reason = error?.message || String(error);
    }
    return result;
};

// 工具函数：等待模组管理器空闲（保存中 / 列表读取中 / 配置状态待核实都视为忙碌）
window.dolOptWaitManagerIdle = async function(timeoutMs = 6000, maxChecks = 60) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const isBusy = () => Boolean(window._dolOptManagerBusy || window._dolOptModLoading || window._dolOptManagerStateUncertain);
    for (let i = 0; i < maxChecks; i++) {
        if (!isBusy()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    return !isBusy();
};

// 工具函数：转义 HTML
window.dolOptEscapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

window.dolOptHasReadmeContent = function(readme) {
    const text = typeof readme === 'string' ? readme.trim() : '';
    return Boolean(text) && !/^<<\s*(?:没有|无|no)\s*readme\s*>>$/i.test(text);
};

/**
 * 游戏原生暗黑风格确认模态框（替代浏览器原生突兀白底 confirm）
 * @param {Object|string} options 参数对象或提示文字
 * @returns {Promise<boolean>}
 */
window.dolOptConfirm = function(options) {
    let title = '提示';
    let message = '';
    let confirmText = '确定';
    let cancelText = '取消';
    let isDanger = false;
    let selectOptions = [];
    let selectValue = '';
    let selectLabel = '请选择';
    let trustedMessageHtml = '';
    let dialogClass = '';
    let requireSelection = false;

    if (typeof options === 'string') {
        message = options;
    } else if (options && typeof options === 'object') {
        title = options.title || '提示';
        message = options.message || '';
        confirmText = options.confirmText || '确定';
        cancelText = options.cancelText !== undefined ? options.cancelText : '取消';
        isDanger = options.confirmType === 'danger';
        selectOptions = Array.isArray(options.selectOptions) ? options.selectOptions : [];
        selectValue = options.selectValue !== undefined ? String(options.selectValue) : (selectOptions[0]?.value || '');
        selectLabel = options.selectLabel || '请选择';
        trustedMessageHtml = typeof options.trustedMessageHtml === 'string' ? options.trustedMessageHtml : '';
        dialogClass = String(options.dialogClass || '').split(/\s+/).filter(name => /^[a-z0-9_-]+$/i.test(name)).join(' ');
        requireSelection = options.requireSelection === true;
    }

    // 针对非 DOM / Node 单元测试环境的安全回退
    if (typeof document === 'undefined' || !document.createElement || !document.body) {
        if (typeof confirm === 'function') {
            return Promise.resolve(confirm(message));
        }
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        const old = document.getElementById('dolOptConfirmOverlay');
        if (old && typeof old.remove === 'function') old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'dolOptConfirmOverlay';
        overlay.className = 'dol-opt-modal-backdrop';

        const dialog = document.createElement('div');
        dialog.className = `dol-opt-modal-dialog${dialogClass ? ` ${dialogClass}` : ''}`;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const messageHtml = trustedMessageHtml || window.dolOptEscapeHtml(message).replace(/\n/g, '<br>');
        const selectHtml = selectOptions.length ? `
            <label class="dol-opt-modal-select-wrap">
                <span>${window.dolOptEscapeHtml(selectLabel)}</span>
                <select class="dol-opt-modal-select">
                    ${selectOptions.map(option => `<option value="${window.dolOptEscapeHtml(option.value)}" ${String(option.value) === selectValue ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${window.dolOptEscapeHtml(option.label)}</option>`).join('')}
                </select>
            </label>
        ` : '';

        dialog.innerHTML = `
            <div class="dol-opt-modal-header">
                <span class="${isDanger ? 'red' : 'gold'} dol-opt-modal-title">${window.dolOptEscapeHtml(title)}</span>
                <button type="button" class="dol-opt-modal-close" aria-label="关闭">&times;</button>
            </div>
            <div class="dol-opt-modal-body">
                <div class="dol-opt-modal-message">${messageHtml}</div>
                ${selectHtml}
            </div>
            <div class="dol-opt-modal-footer">
                <button type="button" class="macro-button ${isDanger ? 'dol-opt-btn-danger' : 'dol-opt-btn-primary'} dol-opt-modal-btn-confirm">${window.dolOptEscapeHtml(confirmText)}</button>
                ${cancelText ? `<button type="button" class="macro-button dol-opt-modal-btn-cancel">${window.dolOptEscapeHtml(cancelText)}</button>` : ''}
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        let resolved = false;
        const select = dialog.querySelector('.dol-opt-modal-select');
        const confirmBtn = dialog.querySelector('.dol-opt-modal-btn-confirm');
        const canConfirm = () => !requireSelection || Boolean(select?.value);
        const syncConfirmState = () => {
            if (confirmBtn) confirmBtn.disabled = !canConfirm();
        };
        const closeWith = (result) => {
            if (resolved) return;
            resolved = true;
            if (typeof document.removeEventListener === 'function') {
                document.removeEventListener('keydown', handleKeydown);
            }
            overlay.classList.add('dol-opt-modal-closing');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 180);
            resolve(result);
        };

        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeWith(false);
            } else if (e.key === 'Enter' && canConfirm()) {
                e.preventDefault();
                closeWith(selectOptions.length ? select?.value : true);
            }
        };

        if (typeof document.addEventListener === 'function') {
            document.addEventListener('keydown', handleKeydown);
        }

        dialog.querySelector('.dol-opt-modal-close')?.addEventListener('click', () => closeWith(false));
        dialog.querySelector('.dol-opt-modal-btn-cancel')?.addEventListener('click', () => closeWith(false));
        dialog.querySelector('.dol-opt-modal-btn-confirm')?.addEventListener('click', () => {
            if (canConfirm()) closeWith(selectOptions.length ? select?.value : true);
        });
        select?.addEventListener('change', syncConfirmState);
        syncConfirmState();

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeWith(false);
            }
        });

        if (confirmBtn && typeof confirmBtn.focus === 'function') {
            confirmBtn.focus();
        }
    });
};

// 游戏原生暗黑风格提示框（替代浏览器原生 alert）
window.dolOptAlert = function(message, title = '提示') {
    return window.dolOptConfirm({
        title,
        message,
        confirmText: '确定',
        cancelText: ''
    });
};

// 常见常用模组友好对照表（针对作者未在 boot.json 声明中文别名的主流 Mod）
const DOL_OPT_KNOWN_MOD_ALIASES = {
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
    'Dynamicest': '极致动态数值提醒',
    'maplebirch': '秋枫白桦框架',
    'WovenRealmCookingAddon': '织境空间-料理扩展',
    'Sydney Bare Study Mod': '悉尼无拘自习扩展',
    'DOLI': '智能 Agent 与 AI 剧情',
    'DOLArcadeExpansion': '游戏厅游玩扩充',
    'DoLQuestAssistant': '任务与指引助手',
    'AIStoryGen': 'AI 剧情辅助生成',
    'SimpleModManager': '简易模组管理器',
    'FeatsUnlocker': '成就快速解锁工具',
    'SafeSaves': '存档防损坏保护',
};

// 内置核心系统模组的中文职能说明
const DOL_OPT_BUILTIN_MOD_ALIASES = {
    'ModLoader': 'Mod 加载器核心引擎',
    'ModLoaderGui': 'Mod 管理器界面核心',
    'ConflictChecker': '模组冲突检测引擎',
    'BeautySelectorAddon': '美化图像包选择器',
    'TweeReplacer': 'Twee 文本动态替换插件',
    'ReplacePatcher': '脚本代码替换补丁插件',
    'CheckGameVersion': '游戏版本兼容校验插件',
};

// 提取模组智能友好副标题（别名 / 简介 / 职能）
window.dolOptGetModSubtext = function(modName, modInfo, isBuiltin = false) {
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

    // 3. 查阅内置已知模组库
    if (!nick || nick === modName) {
        if (isBuiltin && DOL_OPT_BUILTIN_MOD_ALIASES[modName]) {
            nick = DOL_OPT_BUILTIN_MOD_ALIASES[modName];
        } else if (DOL_OPT_KNOWN_MOD_ALIASES[modName]) {
            nick = DOL_OPT_KNOWN_MOD_ALIASES[modName];
        }
    }

    // 4. 若为内置核心模组仍无名称，兜底为“系统核心”
    if (!nick && isBuiltin) {
        nick = '系统核心';
    }

    return nick && nick !== modName ? nick : '';
};

window.dolOptResolveImportedModName = function(fileName, modNames, preferredName = '') {
    const normalize = value => String(value || '')
        .replace(/(?:\.mod)?\.zip$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
    const names = window.dolOptUniqueModNames(modNames);
    const preferredKey = normalize(preferredName);
    const direct = names.find(name => normalize(name) === preferredKey);
    if (direct) return direct;

    const sources = [fileName, preferredName].map(normalize).filter(Boolean);
    let bestName = null;
    let bestScore = 0;
    names.forEach(name => {
        const boot = window.dolOptGetModInfo(name)?.bootJson || {};
        const nickNames = typeof boot.nickName === 'object' ? Object.values(boot.nickName) : [boot.nickName];
        const friendlyName = window.dolOptGetModSubtext(name, { bootJson: boot });
        const aliases = new Set([name, boot.name, friendlyName, ...nickNames].filter(Boolean));
        Object.entries(DOL_OPT_KNOWN_MOD_ALIASES).forEach(([alias, friendly]) => {
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

// Shields.io 颜色映射表
const DOL_OPT_SHIELDS_COLORS = {
    brightgreen: '#4c1',
    green: '#97ca00',
    yellowgreen: '#a4a61d',
    yellow: '#dfb317',
    orange: '#fe7d37',
    red: '#e05d44',
    blue: '#007ec6',
    lightgrey: '#9f9f9f',
    lightgray: '#9f9f9f',
    grey: '#555555',
    gray: '#555555',
    purple: '#795298',
    violet: '#795298',
    black: '#24292e',
    informational: '#007ec6',
    success: '#4c1',
    critical: '#e05d44',
    important: '#fe7d37',
    inactive: '#9f9f9f'
};

// 预估字符渲染宽度（Verdana / 类似系统无衬线字体，字号 11px）
window.dolOptEstimateBadgeTextWidth = function(text) {
    if (!text) return 0;
    const str = String(text);
    let width = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code > 0x7f) {
            width += 12;
        } else if (/[ilj|!:',. ]/i.test(str[i])) {
            width += 4.5;
        } else if (/[mwWM@%]/i.test(str[i])) {
            width += 9.2;
        } else if (/[A-Z]/.test(str[i])) {
            width += 7.2;
        } else {
            width += 6.5;
        }
    }
    return Math.ceil(width);
};

// 构建标准 Shields.io 扁平矢量 SVG Data URL（离线即用，免网络请求）
window.dolOptBuildShieldsSvgDataUrl = function(label, message, colorKey) {
    const rawLabel = String(label || '').trim();
    const rawMsg = String(message || '').trim();
    const cleanColor = String(colorKey || 'blue').toLowerCase().trim();
    const colorHex = DOL_OPT_SHIELDS_COLORS[cleanColor] ||
        (/^[0-9a-f]{3,6}$/i.test(cleanColor) ? '#' + cleanColor : (cleanColor.startsWith('#') ? cleanColor : '#007ec6'));

    const labelW = rawLabel ? Math.max(16, window.dolOptEstimateBadgeTextWidth(rawLabel) + 12) : 0;
    const msgW = Math.max(16, window.dolOptEstimateBadgeTextWidth(rawMsg) + 12);
    const totalW = labelW + msgW;

    const labelX = Math.round((labelW / 2) * 10);
    const msgX = Math.round((labelW + msgW / 2) * 10);
    const labelLen = Math.max(10, Math.round((labelW - 10) * 10));
    const msgLen = Math.max(10, Math.round((msgW - 10) * 10));

    const escLabel = window.dolOptEscapeHtml(rawLabel);
    const escMsg = window.dolOptEscapeHtml(rawMsg);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escLabel ? escLabel + ': ' : ''}${escMsg}">` +
        `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
        `<clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>` +
        `<g clip-path="url(#r)">` +
            (labelW > 0 ? `<rect width="${labelW}" height="20" fill="#555"/>` : '') +
            `<rect x="${labelW}" width="${msgW}" height="20" fill="${colorHex}"/>` +
            `<rect width="${totalW}" height="20" fill="url(#s)"/>` +
        `</g>` +
        `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
            (labelW > 0 ? `<text aria-hidden="true" x="${labelX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelLen}">${escLabel}</text>` +
            `<text x="${labelX}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelLen}">${escLabel}</text>` : '') +
            `<text aria-hidden="true" x="${msgX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${msgLen}">${escMsg}</text>` +
            `<text x="${msgX}" y="140" transform="scale(.1)" fill="#fff" textLength="${msgLen}">${escMsg}</text>` +
        `</g>` +
    `</svg>`;

    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

// 解析 Shields.io 静态 Badge 链接并生成本地 SVG Data URL
window.dolOptGenerateShieldsSvg = function(url, fallbackAlt) {
    if (typeof url !== 'string' || !url.includes('img.shields.io/badge/')) return null;

    try {
        const cleanUrl = url.split('?')[0];
        const match = cleanUrl.match(/img\.shields\.io\/badge\/([^/?#]+)/i);
        if (!match) return null;

        let badgeStr = match[1];
        // 遵循 shields.io 转义规则：-- 代表 -, __ 代表 _
        badgeStr = badgeStr.replace(/--/g, '\u0001').replace(/__/g, '\u0002');
        const parts = badgeStr.split('-');
        if (parts.length < 2) return null;

        const color = parts.pop().replace(/\u0001/g, '-').replace(/\u0002/g, '_');
        const message = parts.pop().replace(/\u0001/g, '-').replace(/\u0002/g, '_').replace(/_/g, ' ');
        const label = parts.join('-').replace(/\u0001/g, '-').replace(/\u0002/g, '_').replace(/_/g, ' ');

        return window.dolOptBuildShieldsSvgDataUrl(
            decodeURIComponent(label || fallbackAlt || ''),
            decodeURIComponent(message || ''),
            decodeURIComponent(color || 'blue')
        );
    } catch (_) {
        return null;
    }
};

// 动态徽章（如 github release/stars/issues）网络加载失败时的降级离线 SVG
window.dolOptGenerateFallbackBadgeSvg = function(label, originalUrl) {
    let tag = label || 'badge';
    let status = 'latest';
    let color = 'blue';

    try {
        const urlObj = new URL(originalUrl, 'https://img.shields.io');
        const labelParam = urlObj.searchParams.get('label');
        if (labelParam) tag = labelParam;
        if (urlObj.pathname.includes('/downloads/')) {
            tag = tag || 'downloads';
            status = 'offline';
            color = 'lightgrey';
        } else if (urlObj.pathname.includes('/stars/')) {
            tag = tag || 'stars';
            status = 'star';
            color = 'orange';
        } else if (urlObj.pathname.includes('/issues')) {
            tag = tag || 'issues';
            status = 'open';
            color = 'green';
        } else if (urlObj.pathname.includes('/release/')) {
            tag = tag || 'release';
            status = 'latest';
            color = 'blue';
        }
    } catch (_) {}

    return window.dolOptBuildShieldsSvgDataUrl(tag, status, color);
};

// 增强 Markdown 解析器（用于 ReadMe 渲染）
window.dolOptRenderMarkdown = function(md, options = {}) {
    if (!md) return '';

    const placeholders = [];
    const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    const resolveRemoteUrl = (value, baseUrl) => {
        const raw = String(value || '').trim();
        if (!raw || !baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
        try {
            return new URL(raw, baseUrl).toString();
        } catch (_) {
            return raw;
        }
    };
    const renderImage = (source, alt, extraAttrs = '') => {
        const originalSrc = resolveRemoteUrl(source, options.remoteImageBaseUrl);
        if (!originalSrc || /^javascript:/i.test(originalSrc)) return '';

        let renderedSrc = originalSrc;
        let isBadge = false;
        if (originalSrc.includes('img.shields.io/badge/')) {
            const svg = window.dolOptGenerateShieldsSvg(originalSrc, alt);
            if (svg) {
                renderedSrc = svg;
                isBadge = true;
            }
        } else if (originalSrc.includes('img.shields.io/')) {
            isBadge = true;
        }

        const proxyUrl = /^https?:\/\//i.test(originalSrc)
            ? window.dolModMarket?.getReadmeImageProxyUrl?.(options.repositoryUrl, originalSrc) || ''
            : '';
        const isDataUrl = renderedSrc.startsWith('data:');
        const isLocal = !proxyUrl && !/^https?:\/\//i.test(renderedSrc) && !isDataUrl;
        const localAttr = isLocal ? ` data-local-mod-path="${window.dolOptEscapeHtml(originalSrc)}"` : '';
        const remoteUrl = proxyUrl || (/^https?:\/\//i.test(originalSrc) ? originalSrc : '');
        const remoteAttr = remoteUrl ? ` data-remote-image-url="${window.dolOptEscapeHtml(remoteUrl)}"` : '';
        const fallbackAttr = isBadge ? ' data-fallback="badge"' : (isLocal ? '' : ' data-fallback="image"');
        const imgClass = isBadge ? 'dol-opt-readme-image dol-opt-readme-badge' : 'dol-opt-readme-image';
        const initialSrc = isDataUrl ? renderedSrc : emptyImage;

        return `<img class="${imgClass}" src="${window.dolOptEscapeHtml(initialSrc)}" alt="${window.dolOptEscapeHtml(alt)}" loading="lazy"${fallbackAttr}${localAttr}${remoteAttr} data-original-src="${window.dolOptEscapeHtml(originalSrc)}"${extraAttrs}>`;
    };
    let text = String(md);

    // 1. 保护多行代码块
    text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
        const idx = placeholders.length;
        placeholders.push(`<pre class="dol-opt-code-block"><code>${window.dolOptEscapeHtml(code)}</code></pre>`);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 2. 保护单行行内代码
    text = text.replace(/`([^`\n]+)`/g, (match, inline) => {
        const idx = placeholders.length;
        placeholders.push(`<code class="dol-opt-inline-code">${window.dolOptEscapeHtml(inline)}</code>`);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 3. 安全放行合法 HTML <img> 标签（如头像或说明配图）
    text = text.replace(/<img\s+([^>]+)>/gi, (match, attrs) => {
        const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
        if (!srcMatch) return '';
        const src = srcMatch[1].trim();

        const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
        const alt = altMatch ? altMatch[1] : '';
        const widthMatch = attrs.match(/width=["']?(\d+[%a-z]*)["']?/i);
        const heightMatch = attrs.match(/height=["']?(\d+[%a-z]*)["']?/i);

        const widthAttr = widthMatch ? ` width="${window.dolOptEscapeHtml(widthMatch[1])}"` : '';
        const heightAttr = heightMatch ? ` height="${window.dolOptEscapeHtml(heightMatch[1])}"` : '';
        const tag = renderImage(src, alt, `${widthAttr}${heightAttr}`);
        if (!tag) return '';
        const idx = placeholders.length;
        placeholders.push(tag);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 远程 README 属于不可信输入，只保留上面已净化的图片标签。
    if (options.escapeRawHtml) {
        text = text.replace(/<[^>]*>/g, tag => window.dolOptEscapeHtml(tag));
    }

    // 4. 复合超链接图片解析：[![alt](imgUrl)](linkUrl)
    text = text.replace(/\[\s*!\[([^\]]*)\]\(([^)]+)\)\s*\]\(([^)]+)\)/g, (match, alt, imgUrl, linkUrl) => {
        const cleanImgUrl = imgUrl.trim();
        const cleanLinkUrl = resolveRemoteUrl(linkUrl, options.remoteLinkBaseUrl);
        const isSafeLink = /^(?:https?:\/\/|mailto:|#|\.\/|\/)/i.test(cleanLinkUrl) && !/^javascript:/i.test(cleanLinkUrl);
        const image = renderImage(cleanImgUrl, alt);
        if (!image) return '';

        return `<a class="dol-opt-readme-link dol-opt-readme-badge-link" href="${window.dolOptEscapeHtml(isSafeLink ? cleanLinkUrl : '#')}" target="_blank" rel="noopener noreferrer">${image}</a>`;
    });

    // 5. 独立图片解析：![alt](imgUrl)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imgUrl) => {
        return renderImage(imgUrl.trim(), alt);
    });

    // 6. 独立超链接解析：[text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, linkUrl) => {
        const cleanLink = resolveRemoteUrl(linkUrl, options.remoteLinkBaseUrl);
        const isSafe = /^(?:https?:\/\/|mailto:|#|\.\/|\/)/i.test(cleanLink) && !/^javascript:/i.test(cleanLink);
        if (!isSafe) {
            return window.dolOptEscapeHtml(label);
        }
        return `<a class="dol-opt-readme-link" href="${window.dolOptEscapeHtml(cleanLink)}" target="_blank" rel="noopener noreferrer">${window.dolOptEscapeHtml(label)}</a>`;
    });

    // 7. 聚合连续的徽章超链接（横向流式排列，避免被换行规则垂直切断）
    text = text.replace(/(?:<a class="dol-opt-readme-link dol-opt-readme-badge-link"[\s\S]*?<\/a>\s*){2,}/g, match => {
        const compacted = match.replace(/\r?\n\s*/g, ' ');
        return `<div class="dol-opt-readme-badge-row">${compacted}</div>\n`;
    });

    // 8. 标题解析
    text = text.replace(/^### (.*$)/gim, '<h4 class="dol-opt-h4 gold">$1</h4>');
    text = text.replace(/^## (.*$)/gim, '<h3 class="dol-opt-h3 gold">$1</h3>');
    text = text.replace(/^# (.*$)/gim, '<h2 class="dol-opt-h2 gold">$1</h2>');

    // 9. 水平分隔线
    text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gim, '<hr class="dol-opt-readme-rule">');

    // 10. 粗体与斜体
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 11. 无序列表
    text = text.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="dol-opt-li">$1</li>');
    text = text.replace(/(<li class="dol-opt-li">[\s\S]*?<\/li>)(?=(?:(?!<li class="dol-opt-li">)[\s\S])*?(?:<h|<div class="dol-opt|<p|<pre|$))/g, '<ul class="dol-opt-ul">$1</ul>');

    // 12. 换行与段落
    text = text.replace(/\n\n+/g, '<br><br>');
    text = text.replace(/\n/g, '<br>');

    // 消除块级元素闭合后紧贴的多余 <br>
    text = text.replace(/(<\/(?:div|h2|h3|h4|ul|pre)>)<br\s*\/?>/gi, '$1');
    text = text.replace(/<hr class="dol-opt-readme-rule"><br\s*\/?>/gi, '<hr class="dol-opt-readme-rule">');

    // 13. 还原代码块与受保护占位符
    text = text.replace(/%%DOL_HOLDER_(\d+)%%/g, (match, idx) => {
        return placeholders[Number(idx)] || '';
    });

    return text;
};

/* =========================================================================
 * 1. 通用模块 (General)
 * ========================================================================= */
// 全局重新载入游戏方法
window.dolOptRestartGame = function() {
    if (window._dolOptManagerBusy || window._dolOptModLoading || window._dolOptManagerSaveFailed) {
        window.dolOptShowToast('请等待操作完成；保存失败时请先刷新列表核实配置。', 'warning');
        return false;
    }
    window.dolOptShowToast('正在重新载入游戏...', 'warning');
    setTimeout(() => {
        if (!window._dolOptManagerBusy && !window._dolOptModLoading && !window._dolOptManagerSaveFailed) location.reload();
    }, 450);
};

window.dolOptToggleSafeMode = function(checked) {
    return window.dolOptRunManagerAction(async () => {
        const modSwitch = window.dolOptGetGui()?.modLoadSwitch;
        if (!modSwitch) throw new Error('无法获取安全模式设置');
        if (checked) await modSwitch.enableSafeMode();
        else await modSwitch.disableSafeMode();
        window.dolOptShowToast(checked ? '安全模式已开启，重新载入后生效' : '安全模式已关闭，重新载入后生效', 'success');
    });
};

window.initGeneral = function() {
    const gui = window.dolOptGetGui();

    // 重新载入按钮
    const btnRestart = document.getElementById('btnRestart');
    if (btnRestart) {
        btnRestart.onclick = window.dolOptRestartGame;
    }

    // 安全模式切换
    const toggleSafeMode = document.getElementById('toggleSafeMode');
    if (toggleSafeMode && gui && gui.modLoadSwitch) {
        toggleSafeMode.checked = gui.modLoadSwitch.isSafeModeOn();

        toggleSafeMode.onchange = () => window.dolOptToggleSafeMode(toggleSafeMode.checked);
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
                await window.dolOptHandleAddMod(fileInput, { askRestart: true });
            }
        };
        dropZone.onclick = (e) => {
            if (e.target === fileInput) return;
            fileInput.click();
        };
        fileInput.onchange = async () => {
            await window.dolOptHandleAddMod(fileInput, { askRestart: true });
        };
    }

    // 加载环境统计信息
    window.dolOptUpdateGeneralInfo();
};

// 更新模组市场顶部 Tab 胶囊徽标
window.dolOptUpdateMarketTabBadge = function(count) {
    if (typeof document === 'undefined') return;
    const tabs = document.querySelectorAll('#overlayTabs button');
    for (const btn of tabs) {
        if (btn.textContent.includes('模组市场')) {
            let badge = btn.querySelector('.dol-opt-tab-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'dol-opt-tab-badge';
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
window.dolOptNotifyUpdateState = function(count, list) {
    window._dolOptUpdatableCount = typeof count === 'number' ? count : (list ? list.length : 0);
    window._dolOptUpdatableMods = list || [];
    const map = new Map();
    if (list) {
        list.forEach(item => {
            if (item.localProfile?.name) map.set(item.localProfile.name, item);
            if (item.name) map.set(item.name, item);
            if (item.localName) map.set(item.localName, item);
        });
    }
    window._dolOptUpdatableMap = map;

    // 1. 同步顶部 Tab 徽标
    window.dolOptUpdateMarketTabBadge(window._dolOptUpdatableCount);

    // 2. 如果当前在模组管理页，局部刷新置顶横幅与第 4 张卡片
    const bannerEl = document.getElementById('dolOptUpdateBanner');
    if (bannerEl) {
        if (window._dolOptUpdatableCount > 0) {
            bannerEl.innerHTML = `
                <div class="dol-opt-update-banner dol-opt-clickable" onclick="window.dolOptGoToMarketUpdates()" title="点击前往模组市场一键更新">
                    <div class="dol-opt-update-banner-main">
                        <div class="dol-opt-update-banner-title">发现 ${window._dolOptUpdatableCount} 个模组有新版本可用！</div>
                        <div class="dol-opt-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                    </div>
                    <button type="button" class="macro-button dol-opt-btn-primary" onclick="event.stopPropagation(); window.dolOptGoToMarketUpdates();">查看更新</button>
                </div>
            `;
            bannerEl.style.display = 'block';
        } else {
            bannerEl.innerHTML = '';
            bannerEl.style.display = 'none';
        }
    }

    const fourthCard = document.getElementById('dolOptEnvInfoCardFourth');
    if (fourthCard) {
        if (window._dolOptUpdatableCount > 0) {
            fourthCard.className = 'childItem dol-opt-stat-card dol-opt-clickable';
            fourthCard.title = '点击前往模组市场查看并升级';
            fourthCard.onclick = () => window.dolOptGoToMarketUpdates && window.dolOptGoToMarketUpdates();
            fourthCard.style.borderColor = 'var(--gold, #d4af37)';
            fourthCard.innerHTML = `
                <div class="dol-opt-stat-num gold dol-opt-pulse-gold">${window._dolOptUpdatableCount}</div>
                <div class="gold dol-opt-stat-label">发现新版</div>
            `;
        }
    }
};

window.dolOptUpdateGeneralInfo = async function() {
    const gui = window.dolOptGetGui();
    const infoEl = document.getElementById('dolOptEnvInfo');
    if (!infoEl) return;

    try {
        const mlVersion = gui?.gModUtils?.version || window.modUtils?.version || '2.x';
        const allMods = window.dolOptUniqueModNames(gui?.gModUtils?.getModListNameNoAlias() || []);
        const state = window._dolOptModState || await window.dolOptLoadModManageState();
        const sideLoadMods = window.dolOptUniqueModNames(state.sideEnabled);
        const enabledNames = new Set(sideLoadMods.map(name => name.trim().toLowerCase()));
        const hiddenSideMods = window.dolOptUniqueModNames(state.sideDisabled)
            .filter(name => !enabledNames.has(name.trim().toLowerCase()));

        // 尝试从模组市场接口直接检测可更新项
        let updatables = [];
        if (window.dolModMarket?.getUpdatableMods) {
            try {
                updatables = window.dolModMarket.getUpdatableMods() || [];
            } catch (_) {}
        }
        const updatableCount = updatables.length || (window._dolOptUpdatableCount || 0);

        const fourthCardHtml = updatableCount > 0
            ? `<div id="dolOptEnvInfoCardFourth" class="childItem dol-opt-stat-card dol-opt-clickable" onclick="window.dolOptGoToMarketUpdates()" title="点击前往模组市场查看并升级" style="border-color: var(--gold, #d4af37);">
                <div class="dol-opt-stat-num gold dol-opt-pulse-gold">${updatableCount}</div>
                <div class="gold dol-opt-stat-label">发现新版</div>
               </div>`
            : `<div id="dolOptEnvInfoCardFourth" class="childItem dol-opt-stat-card">
                <div class="dol-opt-stat-num">${window.dolOptEscapeHtml(mlVersion)}</div>
                <div class="grey dol-opt-stat-label">ModLoader 版本</div>
               </div>`;

        infoEl.innerHTML = `
            <div class="childItem dol-opt-stat-card">
                <div class="dol-opt-stat-num gold">${allMods.length}</div>
                <div class="grey dol-opt-stat-label">已加载模组</div>
            </div>
            <div class="childItem dol-opt-stat-card">
                <div class="dol-opt-stat-num green">${sideLoadMods.length}</div>
                <div class="grey dol-opt-stat-label">已启用模组</div>
            </div>
            <div class="childItem dol-opt-stat-card">
                <div class="dol-opt-stat-num">${hiddenSideMods.length}</div>
                <div class="grey dol-opt-stat-label">已禁用模组</div>
            </div>
            ${fourthCardHtml}
        `;

        // 渲染置顶横幅
        const bannerEl = document.getElementById('dolOptUpdateBanner');
        if (bannerEl) {
            if (updatableCount > 0) {
                bannerEl.innerHTML = `
                    <div class="dol-opt-update-banner dol-opt-clickable" onclick="window.dolOptGoToMarketUpdates()" title="点击前往模组市场一键更新">
                        <div class="dol-opt-update-banner-main">
                            <div class="dol-opt-update-banner-title">发现 ${updatableCount} 个模组有新版本可用！</div>
                            <div class="dol-opt-update-banner-sub">社区源检测到最新更新，支持一键平滑升级与本地更新。</div>
                        </div>
                        <button type="button" class="macro-button dol-opt-btn-primary" onclick="event.stopPropagation(); window.dolOptGoToMarketUpdates();">查看更新</button>
                    </div>
                `;
                bannerEl.style.display = 'block';
            } else {
                bannerEl.innerHTML = '';
                bannerEl.style.display = 'none';
            }
        }

        // 同步更新 Tab 角标
        if (typeof window.dolOptUpdateMarketTabBadge === 'function') {
            window.dolOptUpdateMarketTabBadge(updatableCount);
        }
    } catch (e) {
        console.error('[DolOptimization] 获取统计信息失败', e);
    }
};

// 通用 Tab 切换接口
window.dolOptSwitchTab = function(tabName) {
    if (typeof document === 'undefined') return false;
    const tabs = document.querySelectorAll('#overlayTabs button');
    for (const btn of tabs) {
        if (btn.textContent.trim().includes(tabName)) {
            btn.click();
            return true;
        }
    }
    return false;
};

// 窗口级全局文件拖拽安全拦截器（彻底拦截浏览器默认导航与二次下载行为，防止页面跳转或挂起）
window.dolOptInitGlobalDragDrop = function() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    if (window._dolOptGlobalDragDropInitialized) return;
    window._dolOptGlobalDragDropInitialized = true;

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
window.dolOptInitGlobalDragDrop();

// 单模组安装核心方法：直接通过底层 ModLoadController 将 Zip 数据写入 IndexedDB
// 返回 { modName, bootJson, version, verified }；任一步骤无法确认落盘都会抛出可读异常。
window.dolOptInstallModZip = async function(fileOrBlob, preferredFileName = '') {
    const controller = window.dolOptGetController();
    if (!controller || typeof controller.addModIndexDB !== 'function') {
        throw new Error('未找到 ModLoadController 存储接口');
    }

    const arrayBuffer = typeof fileOrBlob.arrayBuffer === 'function'
        ? await fileOrBlob.arrayBuffer()
        : fileOrBlob;
    const u8Data = new Uint8Array(arrayBuffer);

    // 1. 优先调用 ModLoader 官方接口校验并解析 boot.json
    let modName = null;
    let bootJson = null;
    let checkFailed = '';
    if (typeof controller.checkModZipFileIndexDB === 'function') {
        try {
            const checkResult = await controller.checkModZipFileIndexDB(u8Data);
            if (checkResult && typeof checkResult === 'object' && !Array.isArray(checkResult)) {
                bootJson = checkResult;
                modName = String(checkResult.name || '').trim() || null;
            } else if (checkResult) {
                checkFailed = typeof checkResult === 'string' ? checkResult : '安装包结构校验未通过';
            }
        } catch (err) {
            console.warn('[DolOptimization] checkModZipFileIndexDB 校验异常，使用回退解析:', err);
        }
    }

    // 安装包缺少合法 boot.json 时，ModLoader 重启后绝不会加载它，
    // 此处必须直接失败并给出原因，避免留下永远无法生效的幽灵安装包。
    if (checkFailed) {
        throw new Error(`安装包校验失败（${checkFailed}），该文件不是可用的模组压缩包`);
    }

    // 2. 备用兜底解析技术模组名
    const fileName = preferredFileName || fileOrBlob.name || '';
    if (!modName) {
        modName = fileName.replace(/(?:\.mod)?\.zip$/i, '') || 'UnknownMod';
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
    const ensured = await window.dolOptEnsureModInEnabledList(modName);
    if (!ensured.ok && !ensured.skipped) {
        throw new Error(`模组【${modName}】包体已写入，但未能登记到启用列表：${ensured.reason || '未知原因'}`);
    }
    if (ensured.skipped) {
        console.warn('[DolOptimization] 当前环境无法回读模组列表，跳过安装落盘校验:', ensured.reason);
    }

    return {
        modName,
        bootJson,
        version: bootJson?.version ? String(bootJson.version) : '',
        verified: ensured.ok === true
    };
};

// 批量安装文件流至 IndexedDB
window.dolOptInstallFilesViaIndexDB = async function(fileInputOrFiles) {
    const files = Array.isArray(fileInputOrFiles)
        ? fileInputOrFiles
        : Array.from(fileInputOrFiles?.files || []);
    if (!files.length) return [];

    const results = [];
    for (const file of files) {
        const res = await window.dolOptInstallModZip(file, file.name);
        results.push(res);
    }
    return results;
};

// 触发顶部导入模组选择
window.dolOptTriggerImport = function() {
    let input = document.getElementById('dolOptImportFileInput');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'dolOptImportFileInput';
        input.accept = '.zip';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
    }
    input.onchange = async () => {
        await window.dolOptHandleAddMod(input, { askRestart: true });
    };
    input.click();
};

window.dolOptHandleAddMod = async function(fileInput, options = {}) {
    const gui = window.dolOptGetGui();
    if (!gui) {
        window.dolOptShowToast('未找到模组管理器实例', 'warning');
        return;
    }
    const files = Array.isArray(fileInput)
        ? fileInput
        : Array.from(fileInput?.files || (Array.isArray(fileInput?.files) ? fileInput.files : []));
    if (!files || files.length === 0) return;

    const fileCount = files.length;
    const isBatch = fileCount > 1;

    window.dolOptShowToast(isBatch ? `正在解析并批量导入 ${fileCount} 个模组文件...` : '正在解析并导入模组文件...', 'warning');
    try {
        const imported = await window.dolOptRunManagerAction(async () => {
            const beforeSide = new Set([
                ...(gui.listSideLoadModNameOnly ? await gui.listSideLoadModNameOnly() : []),
                ...(gui.listSideLoadHiddenModNameOnly ? await gui.listSideLoadHiddenModNameOnly() : [])
            ]);
            // 优先使用官方原版 GUI 的 loadAndAddMod 接口
            // 当其不存在（或处于无 GUI / 极简环境）时，无缝回退至直写 IndexedDB 安装器
            if (typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(fileInput);
            } else if (typeof window.dolOptInstallFilesViaIndexDB === 'function') {
                await window.dolOptInstallFilesViaIndexDB(files);
            } else {
                throw new Error('未找到可用的模组安装接口');
            }
            // 安装已经落盘，后续状态刷新与美化扫描属于「尽力而为」，
            // 绝不允许它们的异常把一次成功的安装回判成失败（否则市场会给出误导性结论并跳过版本确权）。
            let state = null;
            try {
                state = await window.dolOptLoadModManageState(true);
            } catch (error) {
                console.warn('[DolOptimization] 安装后刷新模组列表失败，可稍后手动刷新:', error);
            }
            try {
                await window.dolOptLoadBeautyState();
            } catch (error) {
                console.warn('[DolOptimization] 安装后刷新美化配置失败，可稍后手动刷新:', error);
            }
            return {
                beforeSide,
                afterEnabled: state?.sideEnabled || [],
                afterDisabled: state?.sideDisabled || []
            };
        }, '正在导入模组，请稍候...');
        if (!imported) {
            // 记录可读原因供市场端展示，避免只抛出含糊的「安装未完成」
            window._dolOptLastInstallError = window._dolOptLastInstallError || window._dolOptManagerStatus || '模组管理器正忙或配置状态待核实';
            return false;
        }
        window._dolOptLastInstallError = '';
        const { beforeSide, afterEnabled, afterDisabled } = imported;
        const afterAll = [...afterEnabled, ...afterDisabled];
        const newlyAdded = afterAll.filter(name => !beforeSide.has(name));

        // 确定目标模组名称：仅采用可验证来源，禁止误取启用列表末项。
        const expectedName = String(options.targetModName || '').trim();
        const exactExpected = expectedName
            ? afterAll.find(name => name.toLowerCase() === expectedName.toLowerCase())
            : null;
        const sourceFileName = files[0]?.name || '';
        const targetModName = exactExpected || newlyAdded[newlyAdded.length - 1] ||
            window.dolOptResolveImportedModName(sourceFileName, afterAll, options.displayName || expectedName);
        const targetDisplayName = String(options.displayName || '').trim() || targetModName;

        if (fileInput && typeof fileInput === 'object' && 'value' in fileInput) {
            fileInput.value = '';
        }
        if (typeof window.dolOptUpdateGeneralInfo === 'function') {
            window.dolOptUpdateGeneralInfo();
        }

        // ===== 快捷添加模式：导入后询问是否立即重启游戏生效 =====
        if (options && (options.askRestart || options.promptReload)) {
            const label = isBatch ? `${fileCount} 个模组` : (targetDisplayName ? `模组【${targetDisplayName}】` : '模组');
            const ok = await window.dolOptConfirm({
                title: '重新载入游戏',
                message: `${label}已成功添加并完成配置！\n\n是否立即重新载入游戏以使模组生效？`,
                confirmText: '立即重载',
                cancelText: '稍后重载',
                confirmType: 'primary'
            });
            if (ok) {
                window.dolOptShowToast('正在重新载入游戏...', 'warning');
                window.dolOptRestartGame();
            } else if (options.keepCurrentTab) {
                // 模组市场安装场景：玩家通常需要连续安装多个模组，
                // 「稍后重载」后必须停留在市场页签，绝不切走打断浏览。
                window._dolOptHighlightMods = new Set(newlyAdded.length > 0 ? newlyAdded : (targetModName ? [targetModName] : []));
                window.dolOptShowToast(`${label}已添加完成。全部安装完成后可手动点击【重新载入游戏】生效。`, 'info');
            } else {
                window._dolOptHighlightMods = new Set(newlyAdded.length > 0 ? newlyAdded : (targetModName ? [targetModName] : []));
                window.dolOptShowToast(`${label}已添加完成，已在列表中标出。全部操作完成后可手动点击【重新载入游戏】生效。`, 'info');
                const switched = window.dolOptSwitchTab ? window.dolOptSwitchTab('模组管理') : false;
                if (!switched || document.getElementById('dolOptModManageContainer')) {
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
            window.dolOptShowToast(`${label}快捷添加成功，正在自动重新载入游戏...`, 'success');
            window.dolOptRestartGame();
            return true;
        }

        if (isBatch) {
            // ===== 批量导入场景：坚决不强行切页面，全量高亮保留在模组管理界面 =====
            const highlightSet = new Set(newlyAdded.length > 0 ? newlyAdded : (targetModName ? [targetModName] : []));
            window._dolOptHighlightMods = highlightSet;

            // 统计包含 ReadMe 的模组数量
            let readmeCount = 0;
            if (typeof gui.getModTReadMe === 'function') {
                for (const name of highlightSet) {
                    try {
                        const r = await gui.getModTReadMe(name);
                        if (window.dolOptHasReadmeContent(r)) {
                            readmeCount++;
                        }
                    } catch (_) {}
                }
            }

            const readmeNote = readmeCount > 0 ? `（其中 ${readmeCount} 个包含说明文档）` : '';
            window.dolOptShowToast(`已成功导入 ${highlightSet.size || fileCount} 个模组${readmeNote}，已在列表中高亮标出。`, 'success');

            const switched = window.dolOptSwitchTab('模组管理');
            if (!switched || document.getElementById('dolOptModManageContainer')) {
                if (typeof window.initModManage === 'function') {
                    await window.initModManage();
                }
            }
        } else {
            // ===== 单模组导入场景：依是否有 ReadMe 智能分流 =====
            let hasReadme = false;
            if (targetModName && typeof gui.getModTReadMe === 'function') {
                try {
                    const readme = await gui.getModTReadMe(targetModName);
                    if (window.dolOptHasReadmeContent(readme)) {
                        hasReadme = true;
                    }
                } catch (err) {
                    console.warn('[DolOptimization] 检测 ReadMe 异常', err);
                }
            }

            if (hasReadme) {
                window._dolOptSelectedMod = targetModName;
                window.dolOptShowToast(`模组【${targetDisplayName || targetModName}】导入成功，已为您打开说明文档。`, 'success');
                window.dolOptSwitchTab('模组说明');
                if (typeof window.dolOptSelectReadmeMod === 'function') {
                    window.dolOptSelectReadmeMod(targetModName);
                }
            } else {
                window._dolOptHighlightMods = new Set(targetModName ? [targetModName] : []);
                const label = targetDisplayName ? `模组【${targetDisplayName}】` : '模组';
                window.dolOptShowToast(`${label}导入成功，已在列表中高亮定位。`, 'success');
                const switched = window.dolOptSwitchTab('模组管理');
                if (!switched || document.getElementById('dolOptModManageContainer')) {
                    if (typeof window.initModManage === 'function') {
                        await window.initModManage();
                    }
                }
            }
        }
        return true;
    } catch (e) {
        console.error('[DolOptimization] 添加模组失败', e);
        window._dolOptLastInstallError = e?.message || String(e);
        window.dolOptShowToast('添加模组失败: ' + (e.message || e), 'warning');
        return false;
    }
};


// 通用按钮长按判定绑定函数（支持桌面端鼠标长按与移动端触摸长按，支持长按置顶/置底与防误触）
window.dolOptBindLongPressMove = function(btnElement, onShortPress, onLongPress) {
    if (!btnElement || typeof btnElement.addEventListener !== 'function') return;

    let timer = null;
    let isLongPress = false;
    let isPressed = false;
    let startX = 0;
    let startY = 0;

    // 确保全局挂载一次事件拦截钩子，在长按触发后拦截紧随其后的任何 mouseup/click/touchend 穿透
    if (typeof window !== 'undefined' && !window._dolOptLongPressGlobalHooked && typeof window.addEventListener === 'function') {
        window._dolOptLongPressGlobalHooked = true;
        const suppressTrailingPointerEvent = (e) => {
            const isRecentLongPress = window._dolOptLongPressActive || (window._dolOptLastLongPressTimestamp && (Date.now() - window._dolOptLastLongPressTimestamp < 600));
            if (isRecentLongPress) {
                // 仅拦截移动类按钮触发的残留指针弹起/点击
                if (e.target && typeof e.target.closest === 'function' && e.target.closest('.dol-opt-btn-move')) {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    if (typeof e.stopPropagation === 'function') e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                }
            }
        };
        window.addEventListener('mouseup', (e) => {
            suppressTrailingPointerEvent(e);
            if (window._dolOptLongPressActive) {
                setTimeout(() => {
                    window._dolOptLongPressActive = false;
                }, 60);
            }
        }, true);
        window.addEventListener('click', (e) => {
            suppressTrailingPointerEvent(e);
        }, true);
        window.addEventListener('touchend', (e) => {
            suppressTrailingPointerEvent(e);
            if (window._dolOptLongPressActive) {
                setTimeout(() => {
                    window._dolOptLongPressActive = false;
                }, 60);
            }
        }, true);
    }

    const start = (e) => {
        isPressed = true;
        isLongPress = false;
        if (e.touches && e.touches.length > 0) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else {
            startX = e.clientX;
            startY = e.clientY;
        }
        btnElement.classList.add('btn-pressing');
        timer = setTimeout(() => {
            isLongPress = true;
            isPressed = false; // 长按一旦触发，即已消费本次按压手势，释放时不应再触发短按
            if (typeof window !== 'undefined') {
                window._dolOptLongPressActive = true;
                window._dolOptLastLongPressTimestamp = Date.now();
            }
            btnElement.classList.remove('btn-pressing');
            btnElement.classList.add('btn-longpressed');
            setTimeout(() => btnElement.classList.remove('btn-longpressed'), 300);
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate(40); } catch (_) {}
            }
            if (typeof onLongPress === 'function') {
                onLongPress();
            }
        }, 450);
    };

    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        btnElement.classList.remove('btn-pressing');
    };

    btnElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        start(e);
    });

    btnElement.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;
        const wasPressed = isPressed;
        isPressed = false;
        clear();

        const isRecentLongPress = (typeof window !== 'undefined' && (window._dolOptLongPressActive || (window._dolOptLastLongPressTimestamp && (Date.now() - window._dolOptLastLongPressTimestamp < 600))));
        if (wasPressed && !isLongPress && !isRecentLongPress) {
            if (typeof onShortPress === 'function') {
                onShortPress();
            }
        }
    });

    btnElement.addEventListener('mouseleave', () => {
        isPressed = false;
        clear();
    });

    // 阻止移动按钮原生 click 冒泡，防止浏览器合成 click 产生连带副作用
    btnElement.addEventListener('click', (e) => {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
    });

    btnElement.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) start(e);
    }, { passive: true });

    btnElement.addEventListener('touchend', (e) => {
        const wasPressed = isPressed;
        isPressed = false;
        clear();

        const isRecentLongPress = (typeof window !== 'undefined' && (window._dolOptLongPressActive || (window._dolOptLastLongPressTimestamp && (Date.now() - window._dolOptLastLongPressTimestamp < 600))));
        if (wasPressed && !isLongPress && !isRecentLongPress) {
            if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
            if (typeof onShortPress === 'function') {
                onShortPress();
            }
        } else {
            if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
        }
    });

    btnElement.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
            const dx = Math.abs(e.touches[0].clientX - startX);
            const dy = Math.abs(e.touches[0].clientY - startY);
            if (dx > 10 || dy > 10) {
                isPressed = false;
                clear();
            }
        }
    }, { passive: true });

    btnElement.addEventListener('touchcancel', () => {
        isPressed = false;
        clear();
    });
};

// 批量绑定移动按钮长按手势
window.dolOptBindAllMoveButtons = function(container) {
    if (!container) return;

    container.querySelectorAll('.dol-opt-side-move-up').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.dolOptBindLongPressMove(
            btn,
            () => window.dolOptMoveSideMod(index, -1),
            () => window.dolOptMoveSideMod(index, 'top')
        );
    });
    container.querySelectorAll('.dol-opt-side-move-down').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.dolOptBindLongPressMove(
            btn,
            () => window.dolOptMoveSideMod(index, 1),
            () => window.dolOptMoveSideMod(index, 'bottom')
        );
    });

    container.querySelectorAll('.dol-opt-beauty-move-up').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.dolOptBindLongPressMove(
            btn,
            () => window.dolOptMoveBeauty(index, -1),
            () => window.dolOptMoveBeauty(index, 'top')
        );
    });
    container.querySelectorAll('.dol-opt-beauty-move-down').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.dolOptBindLongPressMove(
            btn,
            () => window.dolOptMoveBeauty(index, 1),
            () => window.dolOptMoveBeauty(index, 'bottom')
        );
    });
};

// 重新排列列表项并持久化保存
window.dolOptReorderList = async function(listType, fromIndex, targetIndex, isAfter) {
    return window.dolOptRunManagerAction(async () => {
        if (fromIndex === undefined || targetIndex === undefined || isNaN(fromIndex) || isNaN(targetIndex)) return false;
        let toIndex = isAfter ? targetIndex + 1 : targetIndex;
        if (fromIndex < toIndex) toIndex--;
        if (fromIndex === toIndex) return false;

        if (listType === 'side') {
            const state = window._dolOptModState;
            if (!state) return false;
            window.dolOptEnsureModStateSync(state);
            const list = state.sideMods;
            if (!list || fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return false;
            const [moved] = list.splice(fromIndex, 1);
            list.splice(toIndex, 0, moved);

            window.dolOptEnsureModStateSync(state);
            if (!await window.dolOptSaveModManageState(false)) throw new Error('模组配置保存失败');

            const movedName = typeof moved === 'object' ? moved.name : moved;
            window.dolOptShowToast(`已将【${movedName}】排序调整至第 ${toIndex + 1} 位`, 'success');
        } else if (listType === 'beauty') {
            const state = window._dolOptBeautyState;
            if (!state || !state.enabledList) return false;
            const list = state.enabledList;
            if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return false;
            const [moved] = list.splice(fromIndex, 1);
            list.splice(toIndex, 0, moved);

            if (!await window.dolOptSaveBeautyState(false)) throw new Error('美化配置保存失败');

            window.dolOptShowToast(`已将美化包【${moved.type}】覆盖优先级调整至第 ${toIndex + 1} 位`, 'success');
        }
    });
};

// 统一拖拽排序绑定函数（同时支持桌面端 HTML5 Drag & 移动端 Touch，内置视口边缘自动滚动）
window.dolOptBindDragSort = function(ulElement, listType) {
    if (!ulElement) return;

    let dragSrcIndex = null;
    let dragOverItem = null;
    let isAfterTarget = false;

    // 自动滚动 (Auto-scroll) 控制器
    let scrollRafId = null;
    let currentPointerY = null;

    // 寻找最直接的可滚动容器
    const getScrollContainer = () => {
        let parent = ulElement.parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
            const style = window.getComputedStyle ? window.getComputedStyle(parent) : null;
            if (style) {
                const overflowY = style.overflowY;
                if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
                    return parent;
                }
            }
            parent = parent.parentElement;
        }
        return window;
    };

    const stopAutoScroll = () => {
        if (scrollRafId !== null) {
            if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(scrollRafId);
            }
            scrollRafId = null;
        }
        currentPointerY = null;
    };

    const stepAutoScroll = () => {
        if (currentPointerY === null) {
            scrollRafId = null;
            return;
        }

        const container = getScrollContainer();
        let topBound = 0;
        let bottomBound = typeof window.innerHeight === 'number' ? window.innerHeight : 800;

        if (container !== window && container.getBoundingClientRect) {
            const rect = container.getBoundingClientRect();
            topBound = rect.top;
            bottomBound = rect.bottom;
        }

        const edgeThreshold = 70; // 边缘感应距离（像素）
        const maxSpeed = 16;      // 最大滚动速度（像素/帧）
        let scrollDelta = 0;

        if (currentPointerY < topBound + edgeThreshold) {
            // 靠近顶部边缘：向上滚
            const distance = Math.max(0, currentPointerY - topBound);
            const intensity = 1 - (distance / edgeThreshold);
            scrollDelta = -Math.max(2, Math.ceil(intensity * maxSpeed));
        } else if (currentPointerY > bottomBound - edgeThreshold) {
            // 靠近底部边缘：向下滚
            const distance = Math.max(0, bottomBound - currentPointerY);
            const intensity = 1 - (distance / edgeThreshold);
            scrollDelta = Math.max(2, Math.ceil(intensity * maxSpeed));
        }

        if (scrollDelta !== 0) {
            if (container === window) {
                if (typeof window.scrollBy === 'function') {
                    window.scrollBy(0, scrollDelta);
                }
            } else {
                const prev = container.scrollTop;
                container.scrollTop += scrollDelta;
                // 若容器到达物理边界，向外传递至窗口滚动
                if (container.scrollTop === prev && typeof window.scrollBy === 'function') {
                    window.scrollBy(0, scrollDelta);
                }
            }
            if (typeof requestAnimationFrame === 'function') {
                scrollRafId = requestAnimationFrame(stepAutoScroll);
            }
        } else {
            scrollRafId = null;
        }
    };

    const updatePointerPosition = (y) => {
        currentPointerY = y;
        if (scrollRafId === null && currentPointerY !== null && typeof requestAnimationFrame === 'function') {
            scrollRafId = requestAnimationFrame(stepAutoScroll);
        }
    };

    const clearIndicators = () => {
        stopAutoScroll();
        ulElement.querySelectorAll('.dol-opt-item').forEach(el => {
            el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging', 'touch-dragging');
        });
    };

    // 1. 桌面端 HTML5 Drag & Drop
    ulElement.addEventListener('dragstart', (e) => {
        const item = e.target.closest('li.dol-opt-item[draggable="true"]');
        if (!item || e.target.closest('.dol-opt-btn-group, button, input')) {
            e.preventDefault();
            return;
        }
        stopAutoScroll();
        dragSrcIndex = parseInt(item.dataset.index, 10);
        item.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(dragSrcIndex));
        }
    });

    ulElement.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        updatePointerPosition(e.clientY);

        const item = e.target.closest('li.dol-opt-item[draggable="true"]');
        if (!item) return;

        const targetIndex = parseInt(item.dataset.index, 10);
        if (targetIndex === dragSrcIndex) {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
            return;
        }

        const rect = item.getBoundingClientRect();
        const isBottom = (e.clientY - rect.top) > (rect.height / 2);

        ulElement.querySelectorAll('.dol-opt-item').forEach(el => {
            if (el !== item) el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        if (isBottom) {
            item.classList.remove('drag-over-top');
            item.classList.add('drag-over-bottom');
            isAfterTarget = true;
        } else {
            item.classList.remove('drag-over-bottom');
            item.classList.add('drag-over-top');
            isAfterTarget = false;
        }
        dragOverItem = item;
    });

    ulElement.addEventListener('dragleave', (e) => {
        const item = e.target.closest('li.dol-opt-item');
        if (item && !item.contains(e.relatedTarget)) {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
        }
    });

    ulElement.addEventListener('drop', async (e) => {
        e.preventDefault();
        stopAutoScroll();
        if (dragOverItem && dragSrcIndex !== null) {
            const targetIndex = parseInt(dragOverItem.dataset.index, 10);
            clearIndicators();
            if (!isNaN(dragSrcIndex) && !isNaN(targetIndex)) {
                await window.dolOptReorderList(listType, dragSrcIndex, targetIndex, isAfterTarget);
            }
        } else {
            clearIndicators();
        }
        dragSrcIndex = null;
        dragOverItem = null;
    });

    ulElement.addEventListener('dragend', () => {
        stopAutoScroll();
        clearIndicators();
        dragSrcIndex = null;
        dragOverItem = null;
    });

    // 2. 移动端触摸手柄拖拽支持 (Touch Events on .dol-opt-drag-handle)
    let touchItem = null;
    let touchStartY = 0;
    let isTouchDragging = false;

    ulElement.querySelectorAll('.dol-opt-drag-handle').forEach(handle => {
        handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const item = handle.closest('li.dol-opt-item[draggable="true"]');
            if (!item) return;
            stopAutoScroll();
            touchItem = item;
            touchStartY = e.touches[0].clientY;
            dragSrcIndex = parseInt(item.dataset.index, 10);
            isTouchDragging = false;
        }, { passive: true });

        handle.addEventListener('touchmove', (e) => {
            if (!touchItem || e.touches.length !== 1) return;
            const currentY = e.touches[0].clientY;
            const diffY = currentY - touchStartY;

            if (!isTouchDragging && Math.abs(diffY) > 8) {
                isTouchDragging = true;
                touchItem.classList.add('touch-dragging');
            }

            if (isTouchDragging) {
                if (e.cancelable) e.preventDefault();
                updatePointerPosition(currentY);

                const hoveredEl = document.elementFromPoint(e.touches[0].clientX, currentY);
                const targetLi = hoveredEl ? hoveredEl.closest('li.dol-opt-item[draggable="true"]') : null;

                ulElement.querySelectorAll('.dol-opt-item').forEach(el => {
                    if (el !== targetLi) el.classList.remove('drag-over-top', 'drag-over-bottom');
                });

                if (targetLi && targetLi !== touchItem) {
                    const rect = targetLi.getBoundingClientRect();
                    const isBottom = (currentY - rect.top) > (rect.height / 2);
                    if (isBottom) {
                        targetLi.classList.remove('drag-over-top');
                        targetLi.classList.add('drag-over-bottom');
                        isAfterTarget = true;
                    } else {
                        targetLi.classList.remove('drag-over-bottom');
                        targetLi.classList.add('drag-over-top');
                        isAfterTarget = false;
                    }
                    dragOverItem = targetLi;
                } else {
                    dragOverItem = null;
                }
            }
        }, { passive: false });

        handle.addEventListener('touchend', async () => {
            stopAutoScroll();
            if (isTouchDragging && dragOverItem && dragSrcIndex !== null) {
                const targetIndex = parseInt(dragOverItem.dataset.index, 10);
                clearIndicators();
                if (!isNaN(dragSrcIndex) && !isNaN(targetIndex)) {
                    await window.dolOptReorderList(listType, dragSrcIndex, targetIndex, isAfterTarget);
                }
            } else {
                clearIndicators();
            }
            touchItem = null;
            isTouchDragging = false;
            dragSrcIndex = null;
            dragOverItem = null;
        });

        handle.addEventListener('touchcancel', () => {
            stopAutoScroll();
            clearIndicators();
            touchItem = null;
            isTouchDragging = false;
            dragSrcIndex = null;
            dragOverItem = null;
        });
    });
};

// 保证模组状态中 sideMods 与 sideEnabled/sideDisabled 双向同步
window.dolOptEnsureModStateSync = function(state) {
    if (!state) return;
    const enabled = window.dolOptUniqueModNames(state.sideEnabled);
    const enabledNames = new Set(enabled.map(name => name.trim().toLowerCase()));
    const disabled = window.dolOptUniqueModNames(state.sideDisabled)
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
window.dolOptLoadModManageState = function(refresh = false) {
    if (window._dolOptModLoading) return window._dolOptModLoading;
    if (!refresh && window._dolOptModState) return Promise.resolve(window._dolOptModState);
    const gui = window.dolOptGetGui();
    if (!gui) return Promise.reject(new Error('无法获取 ModLoader 实例'));
    window._dolOptModLoading = (async () => {
        const [enabled, disabled] = await Promise.all([gui.listSideLoadModNameOnly(), gui.listSideLoadHiddenModNameOnly()]);
        const sideEnabled = window.dolOptUniqueModNames(enabled);
        const enabledNames = new Set(sideEnabled.map(name => name.trim().toLowerCase()));
        const sideDisabled = window.dolOptUniqueModNames(disabled)
            .filter(name => !enabledNames.has(name.trim().toLowerCase()));
        const allLoaded = window.dolOptUniqueModNames(gui.gModUtils?.getModListNameNoAlias ? gui.gModUtils.getModListNameNoAlias() : []);

        // 读取本地存储中持久化的全量统一顺序缓存
        let savedOrder = [];
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem('dol_opt_sideload_mod_order');
                if (raw) savedOrder = JSON.parse(raw);
            }
        } catch (_) {}

        const enabledSet = new Set(sideEnabled);
        const allSideSet = new Set([...sideEnabled, ...sideDisabled]);
        // 本次刚启用的模组尚未进入运行时，仍需保留它的安装包资料。
        const installedKeys = new Set([...allSideSet].map(name => name.trim().toLowerCase()));
        for (const key of window._dolOptDisabledModInfo.keys()) {
            if (!installedKeys.has(key)) window._dolOptDisabledModInfo.delete(key);
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
        const builtInMods = (window._dolOptModState?.builtInMods || allLoaded).filter(name => !allSideSet.has(name));

        window._dolOptModState = {
            sideMods,
            sideEnabled: sideMods.filter(m => m.enabled).map(m => m.name),
            sideDisabled: sideMods.filter(m => !m.enabled).map(m => m.name),
            builtInMods: [...builtInMods]
        };

        await window.dolOptLoadDisabledModInfo(sideDisabled, refresh);
        return window._dolOptModState;
    })().finally(() => { window._dolOptModLoading = null; });
    return window._dolOptModLoading;
};

window.dolOptUpdateManagerStatus = function() {
    const controls = document.getElementById('dolOptManagerControls');
    if (controls) controls.disabled = !!(window._dolOptManagerBusy || window._dolOptModLoading);
    const status = document.getElementById('dolOptManagerStatus');
    if (status) {
        status.textContent = window._dolOptManagerStatus || '配置自动保存，重新载入后生效';
        status.className = window._dolOptManagerSaveFailed ? 'red' : 'grey';
    }
};

// ponytail: 共用一把操作锁；确有并行操作需求时再按存储资源拆分。
window.dolOptRunManagerAction = async function(action, message = '正在保存，请稍候...') {
    if (window._dolOptManagerBusy || window._dolOptModLoading || window._dolOptManagerStateUncertain) {
        window.dolOptShowToast(window._dolOptManagerStateUncertain ? '请先刷新列表核实配置，再进行修改。' : '上一项操作尚未完成，请稍候。', 'warning');
        return false;
    }
    const modState = window._dolOptModState;
    const beforeMod = modState && {
        ...modState,
        sideMods: modState.sideMods?.map(item => ({ ...item })),
        sideEnabled: [...(modState.sideEnabled || [])], sideDisabled: [...(modState.sideDisabled || [])]
    };
    const beauty = window._dolOptBeautyState;
    const beforeBeauty = beauty && { ...beauty, enabledList: [...beauty.enabledList], disabledList: [...beauty.disabledList] };
    const previousStatus = window._dolOptManagerStatus;
    window._dolOptManagerBusy = true;
    window._dolOptManagerStatus = message;
    window.dolOptUpdateManagerStatus();
    try {
        const result = await action();
        window._dolOptManagerStatus = result === false ? previousStatus : '已保存，重新载入后生效';
        if (result !== false) window._dolOptManagerSaveFailed = false;
        return result === undefined ? true : result;
    } catch (error) {
        window._dolOptModState = beforeMod;
        window._dolOptBeautyState = beforeBeauty;
        // 两份模组列表可能只写入了一份，以重新读到的实际记录为准。
        try {
            await window.dolOptLoadModManageState(true);
            await window.dolOptLoadBeautyState(false);
            window._dolOptManagerStateUncertain = false;
        } catch (_) {
            window._dolOptModState = beforeMod;
            window._dolOptManagerStateUncertain = true;
        }
        window._dolOptManagerSaveFailed = true;
        window._dolOptManagerStatus = window._dolOptManagerStateUncertain
            ? '操作失败，配置状态待核实，请刷新列表后重试'
            : '操作失败，已重新读取配置，请检查后重试';
        console.error('[DolOptimization] 管理器操作失败', error);
        window.dolOptShowToast(window._dolOptManagerStatus + '：' + (error.message || error), 'warning');
        return false;
    } finally {
        window._dolOptManagerBusy = false;
        window.dolOptRenderModManageUI();
        window.dolOptUpdateManagerStatus();
    }
};

window.initModManage = async function(refresh = false) {
    const container = document.getElementById('dolOptModManageContainer');
    if (!container) return;
    if (window._dolOptModState) window.dolOptRenderModManageUI();
    else container.innerHTML = '<div class="mod-empty grey">正在读取模组列表...</div>';
    if (window._dolOptManagerInit) return window._dolOptManagerInit;
    if (window._dolOptManagerBusy) return;
    if (!refresh && window._dolOptModState && window._dolOptBeautyLoaded && !window._dolOptModLoading) return;
    window._dolOptManagerInit = (async () => {
        try {
            const loading = window.dolOptLoadModManageState(refresh);
            window.dolOptUpdateManagerStatus();
            await loading;
            // 自愈：修复「包体已安装、却未登记进启用列表」的历史遗留模组，
            // 这类模组重启后不会被加载，是市场反复显示未安装 / 可更新的根源之一。
            if (!window._dolOptOrphanRepairDone && typeof window.dolOptRepairOrphanModZips === 'function') {
                window._dolOptOrphanRepairDone = true;
                try {
                    const repair = await window.dolOptRepairOrphanModZips();
                    if (repair?.repaired?.length) await window.dolOptLoadModManageState(true);
                } catch (repairError) {
                    console.warn('[DolOptimization] 已安装未登记模组自愈失败', repairError);
                }
            }
            // 美化自动启用也可能写入配置，初始化期间同样禁止交错操作。
            window._dolOptManagerBusy = true;
            await window.dolOptLoadBeautyState();
            window._dolOptManagerStateUncertain = false;
            if (refresh) {
                window._dolOptManagerSaveFailed = false;
                window._dolOptManagerStatus = '已同步配置，修改在重新载入后生效';
            }
        } catch (error) {
            window._dolOptManagerSaveFailed = true;
            window._dolOptManagerStateUncertain = true;
            window._dolOptManagerStatus = '读取配置失败，请刷新列表重试';
            console.error('[DolOptimization] 读取模组列表异常', error);
            if (!window._dolOptModState) container.innerHTML = '<div class="mod-empty red">读取模组列表失败，请重新打开管理器重试。</div>';
        } finally {
            window._dolOptManagerBusy = false;
            window.dolOptRenderModManageUI();
            window.dolOptUpdateManagerStatus();
        }
    })().finally(() => { window._dolOptManagerInit = null; });
    return window._dolOptManagerInit;
};

window.dolOptRenderModManageUI = function() {
    const container = document.getElementById('dolOptModManageContainer');
    if (!container || !window._dolOptModState) return;

    window.dolOptEnsureModStateSync(window._dolOptModState);
    const sectionStates = new Map([...container.querySelectorAll('details[data-section]')].map(detail => [detail.dataset.section, detail.open]));
    const isSectionOpen = (name, defaultOpen = false) => sectionStates.has(name) ? sectionStates.get(name) : defaultOpen;
    const gui = window.dolOptGetGui();
    const { sideMods, builtInMods } = window._dolOptModState;
    const totalSideCount = sideMods ? sideMods.length : 0;
    const beautyCount = (window._dolOptBeautyState?.enabledList.length || 0) + (window._dolOptBeautyState?.disabledList.length || 0);

    let html = '<fieldset id="dolOptManagerControls" class="dol-opt-manager-controls">';

    // 1. 环境统计看板（原通用页面核心信息）
    html += '<div id="dolOptEnvInfo" class="settingsGridSmall dol-opt-stats-container"></div>';
    html += '<div id="dolOptUpdateBanner" style="display:none;"></div>';

    // 2. 固定吸顶操作工具栏
    html += `
        <div class="dol-opt-sticky-toolbar">
            <div class="childItem grey dol-opt-hint-bar" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                <span>提示：智能整理将根据需要自动调整MOD的顺序；支持拖拽MOD进行手动调整；长按上下按钮可以将MOD置顶或置底。</span>
                <label class="dol-opt-safemode-label" style="display:inline-flex; align-items:center; gap:4px; font-size:0.88em; cursor:pointer;" title="开启后仅加载签名模组，可用于排查异常 Mod">
                    <input type="checkbox" id="toggleSafeMode" class="macro-checkbox" />
                    <span class="gold">安全模式</span>
                </label>
            </div>
            <div id="dolOptManagerStatus" class="grey" role="status" aria-live="polite"></div>
            <div class="dol-opt-group-header">
                <span class="gold">模组与美化顺序管理</span>
                <div class="dol-opt-header-actions">
                    <button id="dolOptImportModBtn" class="macro-button dol-opt-btn-primary" type="button" title="从本地选择或直接拖拽 Zip 模组文件导入" onclick="window.dolOptTriggerImport()">导入模组</button>
                    <button id="dolOptRestartGameBtn" class="macro-button dol-opt-btn-primary" type="button" title="重新载入游戏以使最新模组和美化配置生效" onclick="window.dolOptRestartGame()">重新载入游戏</button>
                    <button class="macro-button" type="button" title="在原版管理器修改后，重新读取列表与模组资料" onclick="window.initModManage(true)">刷新列表</button>
                    <button id="dolOptSmartSortAllBtn" class="macro-button dol-opt-btn-primary" type="button" title="根据明确依赖，同时整理已安装模组的加载顺序和美化包的覆盖顺序" onclick="window.dolOptSmartSortAll()">智能整理模组与美化顺序</button>
                </div>
            </div>
        </div>
        <input type="file" id="dolOptImportFileInput" accept=".zip" multiple style="display:none;" />
        <details class="dol-opt-collapsible-section" data-section="side"${isSectionOpen('side', true) ? ' open' : ''}>
            <summary class="dol-opt-section-summary">已安装模组 - 共 ${totalSideCount} 个</summary>
            <div class="dol-opt-section-content">
    `;

    // 旁加载模组（启用与禁用归入同排序组，全量参与排序）
    if (!sideMods || sideMods.length === 0) {
        html += '<div class="mod-empty grey">当前暂无已安装模组，可点击上方【导入模组】添加 Zip 文件。</div>';
    } else {
        const updatableMap = window._dolOptUpdatableMap;
        html += '<ul class="dol-opt-list">';
        sideMods.forEach((item, index) => {
            const modName = item.name;
            const isEnabled = item.enabled;
            const modInfo = window.dolOptGetModInfo(modName);
            const version = modInfo?.bootJson?.version || '';
            const subText = window.dolOptGetModSubtext(modName, modInfo, false);
            const versionText = version ? (window.dolOptFormatVersion ? window.dolOptFormatVersion(version) : (/^v/i.test(version.trim()) ? version.trim() : 'v' + version.trim())) : '';

            // 检查是否有可升级新版本
            const updateInfo = updatableMap ? (updatableMap.get(modName) || updatableMap.get(modName.toLowerCase())) : null;
            let updateTagHtml = '';
            let updateBtnHtml = '';
            if (updateInfo && updateInfo.newVersion) {
                const newVerText = window.dolOptFormatVersion ? window.dolOptFormatVersion(updateInfo.newVersion) : updateInfo.newVersion;
                updateTagHtml = `<span class="gold dol-opt-update-tag" style="font-weight:bold;">[可更新 -&gt; ${window.dolOptEscapeHtml(newVerText)}]</span>`;
                updateBtnHtml = `<button class="macro-button dol-opt-btn-primary btn-inline-update" data-mod-action="update" title="立即升级至 ${window.dolOptEscapeHtml(newVerText)}">更新</button>`;
            }

            const descParts = [];
            if (isEnabled) {
                if (versionText) descParts.push(versionText);
                if (updateTagHtml) descParts.push(updateTagHtml);
                if (subText) descParts.push(`<span class="dol-opt-mod-alias">${window.dolOptEscapeHtml(subText)}</span>`);
            } else {
                descParts.push('已禁用');
                if (updateTagHtml) descParts.push(updateTagHtml);
                if (subText) descParts.push(`<span class="dol-opt-mod-alias">${window.dolOptEscapeHtml(subText)}</span>`);
            }
            const descHtml = descParts.join(' | ') || '<span class="grey">外部模组</span>';
            const isHighlight = window._dolOptHighlightMods && window._dolOptHighlightMods.has(modName);

            html += `
                <li class="dol-opt-item ${isEnabled ? '' : 'item-disabled'} ${isHighlight ? 'dol-opt-item-highlight' : ''}" data-mod-name="${window.dolOptEscapeHtml(modName)}" data-index="${index}" data-drag-type="side" draggable="true">
                    <div class="dol-opt-item-info">
                        <span class="dol-opt-drag-handle grey" title="按住拖拽调整加载顺序" aria-label="拖拽手柄">⋮⋮</span>
                        <div class="dol-opt-item-main">
                            <div class="dol-opt-item-title ${isEnabled ? '' : 'grey'}">${window.dolOptEscapeHtml(modName)}</div>
                            <div class="grey dol-opt-item-desc">${descHtml}</div>
                        </div>
                    </div>
                    <div class="dol-opt-btn-group">
                        ${updateBtnHtml}
                        <button class="macro-button dol-opt-btn-move dol-opt-side-move-up" data-index="${index}" title="上移一位（长按直接置顶）" aria-label="上移或置顶">▲</button>
                        <button class="macro-button dol-opt-btn-move dol-opt-side-move-down" data-index="${index}" title="下移一位（长按直接置底）" aria-label="下移或置底">▼</button>
                        <button class="macro-button dol-opt-btn-toggle ${isEnabled ? '' : 'btn-enable'}" data-mod-action="toggle" title="${isEnabled ? '禁用该模组' : '启用该模组'}">${isEnabled ? '禁用' : '启用'}</button>
                        <button class="macro-button dol-opt-btn-delete btn-delete" data-mod-action="delete" title="永久删除该模组"><span class="red">删除</span></button>
                    </div>
                </li>
            `;
        });
        html += '</ul>';
    }
    html += '</div></details>';

    // 分组 2: 美化图像包（来自旁加载模组，可独立控制覆盖顺序）
    html += `
        <details class="dol-opt-collapsible-section" data-section="beauty"${isSectionOpen('beauty') ? ' open' : ''}>
            <summary class="dol-opt-section-summary">美化图像包 - 共 ${beautyCount} 个</summary>
            <div id="dolOptBeautyContainer" class="dol-opt-section-content"></div>
        </details>
    `;

    const builtInList = Array.isArray(builtInMods) ? builtInMods : [];

    // 分组 3: 内置模组列表（只读展示）
    html += `
        <details class="dol-opt-collapsible-section" data-section="core"${isSectionOpen('core') ? ' open' : ''}>
            <summary class="dol-opt-section-summary">内置与核心模组 - 共 ${builtInList.length} 个</summary>
            <div class="dol-opt-section-content">
                <ul class="dol-opt-list">
    `;

    builtInList.forEach(modName => {
        const modInfo = window.dolOptGetModInfo(modName);
        const version = modInfo?.bootJson?.version || '';
        const subText = window.dolOptGetModSubtext(modName, modInfo, true);
        const versionText = version ? (window.dolOptFormatVersion ? window.dolOptFormatVersion(version) : (/^v/i.test(version.trim()) ? version.trim() : 'v' + version.trim())) : '';
        const descHtml = [versionText, subText ? `<span class="dol-opt-mod-alias">${window.dolOptEscapeHtml(subText)}</span>` : '']
            .filter(Boolean)
            .join(' | ') || '系统核心组件';
        html += `
            <li class="dol-opt-item item-readonly">
                <div class="dol-opt-item-info">
                    <span class="gold dol-opt-status-tag">[核心]</span>
                    <div class="dol-opt-item-main">
                        <div class="dol-opt-item-title">${window.dolOptEscapeHtml(modName)}</div>
                        <div class="grey dol-opt-item-desc">${descHtml}</div>
                    </div>
                </div>
            </li>
        `;
    });
    html += '</ul></div></details>';

    container.innerHTML = html + '</fieldset>';
    window.dolOptUpdateManagerStatus();
    container.onclick = async event => {
        const button = event.target?.closest?.('[data-mod-action]');
        const modName = button?.closest?.('li[data-mod-name]')?.dataset.modName;
        if (!button || !modName) return;
        if (button.dataset.modAction === 'update') await window.dolOptUpdateModDirectly(modName);
        else if (button.dataset.modAction === 'toggle') await window.dolOptToggleSideMod(modName);
        else if (button.dataset.modAction === 'delete') await window.dolOptDeleteSideMod(modName);
    };
    window.dolOptRenderBeautyUI();

    // 1. 刷新环境统计看板（原通用页面数据）
    if (typeof window.dolOptUpdateGeneralInfo === 'function') {
        window.dolOptUpdateGeneralInfo();
    }

    // 2. 绑定安全模式切换开关
    const toggleSafeMode = container.querySelector ? container.querySelector('#toggleSafeMode') : null;
    if (toggleSafeMode && gui && gui.modLoadSwitch) {
        toggleSafeMode.checked = gui.modLoadSwitch.isSafeModeOn();
        toggleSafeMode.onchange = () => window.dolOptToggleSafeMode(toggleSafeMode.checked);
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
            let input = document.getElementById('dolOptImportFileInput');
            if (input) {
                input.files = e.dataTransfer.files;
                await window.dolOptHandleAddMod(input, { askRestart: true });
            }
        }
    };

    // 绑定旁加载模组拖拽排序
    const sideUl = container.querySelector ? container.querySelector('.dol-opt-collapsible-section[data-section="side"] ul.dol-opt-list') : null;
    if (sideUl && typeof window.dolOptBindDragSort === 'function') {
        window.dolOptBindDragSort(sideUl, 'side');
    }

    // 批量绑定移动按钮长按手势（上移置顶 / 下移置底）
    if (typeof window.dolOptBindAllMoveButtons === 'function') {
        window.dolOptBindAllMoveButtons(container);
    }

    // 模组高亮与自动平滑滚动定位
    const highlightSet = window._dolOptHighlightMods;
    if (highlightSet && highlightSet.size > 0 && container.querySelectorAll) {
        let firstScrolled = false;
        container.querySelectorAll('li[data-mod-name]').forEach(li => {
            const modName = li.dataset.modName;
            if (highlightSet.has(modName)) {
                li.classList.add('dol-opt-item-highlight');
                if (!firstScrolled && typeof li.scrollIntoView === 'function') {
                    firstScrolled = true;
                    setTimeout(() => {
                        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 60);
                }
            }
        });
        setTimeout(() => {
            window._dolOptHighlightMods = null;
        }, 3000);
    }
};

window.dolOptOfferReload = async function(message = '配置已更新。') {
    const ok = await window.dolOptConfirm({
        title: '重新载入游戏',
        message: `${message}\n\n是否立即重新载入游戏以使配置生效？`,
        confirmText: '立即重载',
        cancelText: '稍后重载',
        confirmType: 'primary'
    });
    if (!ok) return;
    window.dolOptRestartGame();
};

window.dolOptBuildSmartOrder = async function(nodes, gui, dependentsFirst = false) {
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
        const boot = modNodes.find(node => node.boot)?.boot || window.dolOptGetModInfo(modName)?.bootJson || {};
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
        console.warn('[DolOptimization] 检测到循环依赖，保持原有相对顺序');
        return keys;
    }
    return sortedKeys;
};

window.dolOptSmartSortAll = async function() {
    const saved = await window.dolOptRunManagerAction(async () => {
        const gui = window.dolOptGetGui();
        if (!gui) {
            window.dolOptShowToast('未找到模组管理器实例', 'warning');
            return false;
        }

        const button = document.getElementById('dolOptSmartSortAllBtn');
        if (button) {
            button.disabled = true;
            button.textContent = '正在整理...';
        }

        try {
            let sideChanged = false;
            let beautyChanged = false;

            if (window._dolOptModState) {
                window.dolOptEnsureModStateSync(window._dolOptModState);
                const sideMods = window._dolOptModState.sideMods;
                const sideNodes = sideMods.map(item => ({ key: item.name, modName: item.name }));
                const sortedSideKeys = await window.dolOptBuildSmartOrder(sideNodes, gui, false);
                sideChanged = sortedSideKeys.some((name, index) => name !== sideMods[index].name);
                if (sideChanged) {
                    const map = new Map(sideMods.map(m => [m.name, m]));
                    window._dolOptModState.sideMods = sortedSideKeys.map(key => map.get(key)).filter(Boolean);
                    window.dolOptEnsureModStateSync(window._dolOptModState);
                }
            }

            if (window._dolOptBeautyState?.enabledList?.length) {
                const beautyNodes = window._dolOptBeautyState.enabledList.map(item => ({
                    key: item.type,
                    modName: item.modRef?.name || item.modName || item.type,
                    boot: item.modRef?.bootJson
                }));
                const sortedBeautyKeys = await window.dolOptBuildSmartOrder(beautyNodes, gui, true);
                beautyChanged = sortedBeautyKeys.some((type, index) => type !== window._dolOptBeautyState.enabledList[index].type);
                if (beautyChanged) {
                    const beautyMap = new Map(window._dolOptBeautyState.enabledList.map(item => [item.type, item]));
                    window._dolOptBeautyState.enabledList = sortedBeautyKeys.map(key => beautyMap.get(key)).filter(Boolean);
                }
            }

            if (!sideChanged && !beautyChanged) {
                window.dolOptShowToast('智能整理完成，暂时无需调整', 'success');
                return false;
            }

            if (sideChanged && !await window.dolOptSaveModManageState(false)) throw new Error('模组配置保存失败');
            if (beautyChanged && !await window.dolOptSaveBeautyState(false)) throw new Error('美化配置保存失败');

            const details = [];
            if (sideChanged) details.push('旁加载加载顺序');
            if (beautyChanged) details.push('美化覆盖顺序');
            const message = `已按依赖关系智能整理【${details.join(' 与 ')}】`;
            window.dolOptShowToast(message, 'success');
            return message;
        } catch (e) {
            console.error('[DolOptimization] 智能整理顺序失败', e);
            throw e;
        } finally {
            if (button?.isConnected) {
                button.disabled = false;
                button.textContent = '智能整理模组与美化顺序';
            }
        }
    });
    if (typeof saved === 'string') window.dolOptOfferReload(`${saved}。配置已保存。`);
    return saved;
};

// 旁加载模组移动（支持短按步进与长按置顶/置底）
window.dolOptMoveSideMod = async function(index, deltaOrPosition) {
    return window.dolOptRunManagerAction(async () => {
        const state = window._dolOptModState;
        if (!state) return false;
        window.dolOptEnsureModStateSync(state);
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

        window.dolOptEnsureModStateSync(state);
        if (!await window.dolOptSaveModManageState(false)) throw new Error('模组配置保存失败');


        const name = item.name;
        if (deltaOrPosition === 'top') {
            window.dolOptShowToast(`已将【${name}】置顶`, 'success');
        } else if (deltaOrPosition === 'bottom') {
            window.dolOptShowToast(`已将【${name}】置底`, 'success');
        }
    });
};

// 旁加载模组启用/禁用就地切换（保持原有排序位置绝对不变）
window.dolOptToggleSideMod = async function(modName, enable) {
    return window.dolOptRunManagerAction(async () => {
        const state = window._dolOptModState;
        if (!state) return false;
        window.dolOptEnsureModStateSync(state);

        const item = state.sideMods.find(m => m.name === modName);
        if (!item) return false;

        const targetEnable = enable !== undefined ? !!enable : !item.enabled;
        if (item.enabled === targetEnable) return false;

        item.enabled = targetEnable;
        window.dolOptEnsureModStateSync(state);

        if (!await window.dolOptSaveModManageState(false)) throw new Error('模组配置保存失败');

        // 若开启了美化自动启用，跟随对齐美化状态
        if (window.dolOptIsAutoBeautyEnabled()) {
            await window.dolOptLoadBeautyState();
        }

        window.dolOptShowToast(`模组【${modName}】已${targetEnable ? '启用' : '禁用'}（原排序保持不变）`, 'success');
    });
};

// 永久删除旁加载模组
window.dolOptDeleteSideMod = async function(modName) {
    const confirmed = await window.dolOptConfirm({
        title: '确认删除模组',
        message: `确定要删除模组【${modName}】吗？\n删除后该模组将从浏览器存储中彻底移除，不可恢复。`,
        confirmText: '确认删除',
        cancelText: '取消',
        confirmType: 'danger'
    });
    if (!confirmed) return;

    const saved = await window.dolOptRunManagerAction(async () => {
        const state = window._dolOptModState;
        if (!state) throw new Error('模组列表尚未读取完成');
        window.dolOptEnsureModStateSync(state);
        state.sideMods = state.sideMods.filter(item => item.name !== modName);
        state.sideEnabled = state.sideEnabled.filter(name => name !== modName);
        state.sideDisabled = state.sideDisabled.filter(name => name !== modName);
        // dropNames：明确告知保存层该模组已被删除，禁止被「已安装保留」逻辑复活
        if (!await window.dolOptSaveModManageState(false, { dropNames: [modName] })) throw new Error('删除模组配置失败');
        window._dolOptDisabledModInfo.delete(modName.trim().toLowerCase());
        // 真正删除浏览器存储中的安装包；
        // 只从列表移除而不删包体，会留下永远无法被加载的孤儿包体（占用空间且状态诡异）。
        const controller = window.dolOptGetController();
        if (controller && typeof controller.removeModIndexDB === 'function') {
            await controller.removeModIndexDB(modName);
        }
    });
    if (saved) {
        window.dolOptShowToast(`已删除模组【${modName}】，重新载入后生效`, 'warning');
        window.dolOptOfferReload(`模组【${modName}】已从模组列表中删除。`);
    }
    return saved;
};

// 保存模组管理状态
// options.dropNames：本次操作中明确移除、不允许被「已安装保留」逻辑复活的模组名
window.dolOptSaveModManageState = async function(showSuccess = true, options = {}) {
    const state = window._dolOptModState;
    if (!state) return false;
    window.dolOptEnsureModStateSync(state);

    window.dolOptRenderModManageUI();
    try {
        await window.dolOptSaveIndexDBModList(state.sideEnabled, state.sideDisabled, options);
        if (typeof localStorage !== 'undefined' && state.sideMods) {
            try {
                localStorage.setItem('dol_opt_sideload_mod_order', JSON.stringify(state.sideMods.map(m => m.name)));
            } catch (_) {}
        }

        if (showSuccess) window.dolOptShowToast('模组配置已更新，重新载入后生效', 'success');
        return true;
    } catch (e) {
        if (window._dolOptManagerBusy) throw e;
        console.error('[DolOptimization] 保存模组状态失败', e);
        window.dolOptShowToast('保存模组状态失败: ' + (e.message || e), 'warning');
        return false;
    }
};


/* =========================================================================
 * 3. 美化包管理器模块 (BeautySelector Addon)
 * ========================================================================= */

// 自动启用已启用旁加载模组美化的配置（默认开启）
window.dolOptIsAutoBeautyEnabled = function() {
    try {
        if (typeof localStorage === 'undefined') return true;
        const val = localStorage.getItem('dol_opt_auto_enable_sideload_beauty');
        return val === null ? true : val === 'true';
    } catch (_) {
        return true;
    }
};

window.dolOptSetAutoBeautyEnabled = function(val) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('dol_opt_auto_enable_sideload_beauty', val ? 'true' : 'false');
        }
    } catch (_) {}
};

window.dolOptToggleAutoBeautySetting = async function(checked) {
    return window.dolOptRunManagerAction(async () => {
        window.dolOptSetAutoBeautyEnabled(checked);
        window.dolOptShowToast(checked ? '已开启【自动启用旁加载模组美化】' : '已关闭【自动启用旁加载模组美化】', 'info');
        await window.dolOptLoadBeautyState();

    });
};

window.dolOptLoadBeautyState = async function(syncAuto = true) {
    const bAddon = window.addonBeautySelectorAddon;
    if (!bAddon || typeof bAddon.getTypeOrder !== 'function') {
        window._dolOptBeautyLoaded = true;
        window._dolOptBeautyState = null;
        return false;
    }

    try {
        const allList = [...bAddon.getTypeOrder()];
        let usedList = Array.isArray(bAddon.typeOrderUsed) ? [...bAddon.typeOrderUsed] : [];
        let usedTypeSet = new Set(usedList.map(item => item.type));
        let disabledList = allList.filter(item => !usedTypeSet.has(item.type));

        const autoBeautyEnabled = window.dolOptIsAutoBeautyEnabled();
        let beautyChanged = false;

        // 获取当前已启用的旁加载模组名集合
        const enabledSideMods = new Set();
        const gui = window.dolOptGetGui();
        if (window._dolOptModState && Array.isArray(window._dolOptModState.sideEnabled)) {
            window._dolOptModState.sideEnabled.forEach(m => {
                const name = typeof m === 'string' ? m : m?.name;
                if (name) enabledSideMods.add(name);
            });
        } else if (gui && typeof gui.listSideLoadModNameOnly === 'function') {
            try {
                const names = await gui.listSideLoadModNameOnly();
                if (Array.isArray(names)) {
                    names.forEach(n => enabledSideMods.add(n));
                }
            } catch (_) {}
        }

        const allMap = new Map(allList.map(item => [item.type, item]));

        if (syncAuto && autoBeautyEnabled && enabledSideMods.size > 0) {
            // 自动启用：属于已启用旁加载模组的美化项移入已启用列表
            const toEnable = [];
            disabledList = disabledList.filter(item => {
                const modName = item.modRef?.name || item.mod || item.fromMod || '';
                if (modName && enabledSideMods.has(modName)) {
                    toEnable.push(item);
                    return false;
                }
                return true;
            });

            if (toEnable.length > 0) {
                toEnable.forEach(item => {
                    if (!usedTypeSet.has(item.type)) {
                        usedList.push(item);
                        usedTypeSet.add(item.type);
                        beautyChanged = true;
                    }
                });
            }
        }

        // 标记是否属于受保护的自动管理美化项
        allList.forEach(item => {
            const modName = item.modRef?.name || item.mod || item.fromMod || '';
            item.isAutoManaged = !!(autoBeautyEnabled && modName && enabledSideMods.has(modName));
        });

        window._dolOptBeautyState = {
            enabledList: usedList,
            disabledList: disabledList,
            allMap: allMap
        };

        if (beautyChanged && !await window.dolOptSaveBeautyState(false)) throw new Error('美化自动启用保存失败');
        window._dolOptBeautyLoaded = true;
        return true;
    } catch (e) {
        if (window._dolOptManagerBusy && syncAuto) throw e;
        console.error('[DolOptimization] 初始化美化管理失败', e);
        window._dolOptBeautyState = null;
        return false;
    }
};

window.dolOptRenderBeautyUI = function() {
    const container = document.getElementById('dolOptBeautyContainer');
    if (!container) return;
    if (!window._dolOptBeautyState) {
        container.innerHTML = '<div class="mod-empty grey">未检测到 BeautySelectorAddon，暂时无法管理美化图像包。</div>';
        return;
    }

    const { enabledList, disabledList } = window._dolOptBeautyState;
    const autoBeautyEnabled = window.dolOptIsAutoBeautyEnabled();

    let html = `
        <div class="childItem dol-opt-section dol-opt-beauty-auto-box">
            <label class="dol-opt-checkbox-label">
                <input type="checkbox" id="toggleAutoBeauty" class="macro-checkbox" ${autoBeautyEnabled ? 'checked' : ''} onchange="window.dolOptToggleAutoBeautySetting(this.checked)" />
                自动启用已启用旁加载模组的美化 <span class="gold">(推荐)</span>
            </label>
            <div class="grey dol-opt-subdesc">默认开启。开启后已启用的旁加载模组美化将自动保持激活且无法手动停用，避免漏开或重装模组后图像缺失。</div>
        </div>
        <div class="childItem grey dol-opt-hint-bar">
            提示：上方图像覆盖优先级高于下方。智能排序会将依赖方放在基础包之前，无关项保持原序。
        </div>
    `;

    // 已启用列表
    html += `
        <div class="dol-opt-group-header">
            <span class="gold">已启用的美化图像包 (${enabledList.length}) - 覆盖优先级从高到低</span>
        </div>
    `;

    if (enabledList.length === 0) {
        html += '<div class="mod-empty grey">当前未启用任何美化包。</div>';
    } else {
        html += '<ul class="dol-opt-list">';
        enabledList.forEach((item, index) => {
            const modName = item.modRef?.name || '未知模组';
            const isAuto = autoBeautyEnabled && item.isAutoManaged;
            html += `
                <li class="dol-opt-item" data-index="${index}" data-drag-type="beauty" data-beauty-type="${window.dolOptEscapeHtml(item.type)}" draggable="true">
                    <div class="dol-opt-item-info">
                        <span class="dol-opt-drag-handle grey" title="按住拖拽调整覆盖优先级" aria-label="拖拽手柄">⋮⋮</span>
                        <span class="gold dol-opt-order-tag">#${index + 1}</span>
                        <span class="green dol-opt-status-tag">[已启用]</span>
                        ${isAuto ? '<span class="gold dol-opt-status-tag dol-opt-tag-auto" title="已跟随旁加载模组自动保持启用">[自动启用]</span>' : ''}
                        <div class="dol-opt-item-main">
                            <div class="dol-opt-item-title">${window.dolOptEscapeHtml(item.type)}</div>
                            <div class="grey dol-opt-item-desc">来自模组：[${window.dolOptEscapeHtml(modName)}]</div>
                        </div>
                    </div>
                    <div class="dol-opt-btn-group">
                        <button class="macro-button dol-opt-btn-move dol-opt-beauty-move-up" data-index="${index}" title="上移一位（长按直接置顶）" aria-label="上移或置顶">▲</button>
                        <button class="macro-button dol-opt-btn-move dol-opt-beauty-move-down" data-index="${index}" title="下移一位（长按直接置底）" aria-label="下移或置底">▼</button>
                        ${isAuto ?
                            '<button class="macro-button dol-opt-btn-toggle btn-auto-disabled" disabled title="已跟随旁加载模组自动启用，无法手动调整">已自动启用</button>' :
                            `<button class="macro-button dol-opt-btn-toggle" data-beauty-enabled="false" title="禁用该美化包">禁用</button>`
                        }
                    </div>
                </li>
            `;
        });
        html += '</ul>';
    }

    // 已禁用列表
    html += `
        <div class="dol-opt-group-header" style="margin-top: 18px;">
            <span class="grey">已禁用的美化图像包 (${disabledList.length})</span>
        </div>
    `;

    if (disabledList.length === 0) {
        html += '<div class="mod-empty grey">没有被禁用的美化包。</div>';
    } else {
        html += '<ul class="dol-opt-list">';
        disabledList.forEach(item => {
            const modName = item.modRef?.name || '未知模组';
            html += `
                <li class="dol-opt-item item-disabled" data-beauty-type="${window.dolOptEscapeHtml(item.type)}">
                    <div class="dol-opt-item-info">
                        <span class="grey dol-opt-status-tag">[已停用]</span>
                        <div class="dol-opt-item-main">
                            <div class="dol-opt-item-title grey">${window.dolOptEscapeHtml(item.type)}</div>
                            <div class="grey dol-opt-item-desc">来自模组：[${window.dolOptEscapeHtml(modName)}]</div>
                        </div>
                    </div>
                    <div class="dol-opt-btn-group">
                        <button class="macro-button dol-opt-btn-toggle btn-enable" data-beauty-enabled="true" title="启用该美化包">启用</button>
                    </div>
                </li>
            `;
        });
        html += '</ul>';
    }

    container.innerHTML = html;
    container.onclick = event => {
        const button = event.target?.closest?.('[data-beauty-enabled]');
        const beautyType = button?.closest?.('[data-beauty-type]')?.dataset.beautyType;
        if (button && beautyType) window.dolOptToggleBeauty(beautyType, button.dataset.beautyEnabled === 'true');
    };

    const beautyUl = container.querySelector ? container.querySelector('ul.dol-opt-list') : null;
    if (beautyUl && typeof window.dolOptBindDragSort === 'function') {
        window.dolOptBindDragSort(beautyUl, 'beauty');
    }

    if (typeof window.dolOptBindAllMoveButtons === 'function') {
        window.dolOptBindAllMoveButtons(container);
    }
};

// 美化项排序移动（支持短按步进与长按置顶/置底）
window.dolOptMoveBeauty = async function(index, deltaOrPosition) {
    return window.dolOptRunManagerAction(async () => {
        const state = window._dolOptBeautyState;
        if (!state || !state.enabledList) return false;
        const list = state.enabledList;
        if (index < 0 || index >= list.length) return false;

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

        if (!await window.dolOptSaveBeautyState(false)) throw new Error('美化配置保存失败');


        const type = item.type;
        if (deltaOrPosition === 'top') {
            window.dolOptShowToast(`已将美化包【${type}】置顶（最高覆盖优先级）`, 'success');
        } else if (deltaOrPosition === 'bottom') {
            window.dolOptShowToast(`已将美化包【${type}】置底（最低覆盖优先级）`, 'success');
        }
    });
};

// 美化项启用/禁用
window.dolOptToggleBeauty = async function(typeKey, enable) {
    return window.dolOptRunManagerAction(async () => {
        const state = window._dolOptBeautyState;
        if (!state) return false;

        const targetItem = state.allMap.get(typeKey);
        if (!targetItem) return false;

        if (!enable && window.dolOptIsAutoBeautyEnabled() && targetItem.isAutoManaged) {
            window.dolOptShowToast(`美化包【${typeKey}】已跟随旁加载模组自动启用，无需手动调整`, 'warning');
            return false;
        }

        if (enable) {
            state.disabledList = state.disabledList.filter(item => item.type !== typeKey);
            if (!state.enabledList.some(item => item.type === typeKey)) {
                state.enabledList.push(targetItem);
            }
        } else {
            state.enabledList = state.enabledList.filter(item => item.type !== typeKey);
            if (!state.disabledList.some(item => item.type === typeKey)) {
                state.disabledList.push(targetItem);
            }
        }

        if (!await window.dolOptSaveBeautyState()) throw new Error('美化配置保存失败');

    });
};

// 保存美化排序与设置
window.dolOptSaveBeautyState = async function(showSuccess = true) {
    const bAddon = window.addonBeautySelectorAddon;
    const state = window._dolOptBeautyState;
    if (!bAddon || !state) return false;

    window.dolOptRenderModManageUI();
    try {
        const typeOrder = state.enabledList.map(item => item.type);
        if (await bAddon.saveOrder(typeOrder) === false) throw new Error('美化配置保存失败');
        bAddon.typeOrderUsed = [...state.enabledList];
        if (showSuccess) window.dolOptShowToast('美化包排序已保存（重新载入后完全生效）', 'success');
        return true;
    } catch (e) {
        if (window._dolOptManagerBusy) throw e;
        console.error('[DolOptimization] 保存美化配置失败', e);
        window.dolOptShowToast('保存美化配置失败: ' + e.message, 'warning');
        return false;
    }
};


/* =========================================================================
 * 4. Mod ReadMe 文档浏览器 (ReadMe Viewer)
 * ========================================================================= */
window.initModReadMe = async function() {
    const container = document.getElementById('dolOptReadmeContainer');
    if (!container) return;

    const gui = window.dolOptGetGui();
    if (!gui) {
        container.innerHTML = '<div class="mod-empty grey">无法获取 ModLoader 实例。</div>';
        return;
    }

    const loadedMods = window.dolOptUniqueModNames(gui.gModUtils ? (gui.gModUtils.getModListNameNoAlias() || []) : []);
    let sideMods = [];
    try {
        if (typeof gui.listSideLoadModNameOnly === 'function') {
            sideMods = await gui.listSideLoadModNameOnly();
        }
    } catch (_) {}
    const allMods = window.dolOptUniqueModNames([...loadedMods, ...sideMods]);
    window._dolOptReadmeMods = allMods;
    if (!window._dolOptSelectedMod || !allMods.includes(window._dolOptSelectedMod)) {
        window._dolOptSelectedMod = allMods[0] || null;
    }

    container.innerHTML = `
        <div class="dol-opt-group-header" style="margin-top: 0; margin-bottom: 10px;">
            <span class="gold">模组说明文档 (ReadMe)</span>
            <button type="button" class="macro-button dol-opt-btn-primary" onclick="window.dolOptSwitchTab('模组管理')">返回模组管理</button>
        </div>
        <div class="dol-opt-readme-layout">
            <div class="dol-opt-readme-sidebar">
                <input type="text" id="dolOptReadmeSearch" class="dol-opt-search-input" placeholder="搜索模组..." />
                <ul id="dolOptReadmeModList" class="dol-opt-readme-list"></ul>
            </div>
            <div class="dol-opt-readme-content">
                <div id="dolOptReadmeBody" class="dol-opt-readme-body">
                    <div class="mod-empty grey">请从左侧选择要查看说明的模组</div>
                </div>
            </div>
        </div>
    `;

    const searchInput = document.getElementById('dolOptReadmeSearch');
    if (searchInput) {
        searchInput.oninput = () => {
            window.dolOptFilterReadmeList(searchInput.value.trim());
        };
    }
    const listEl = document.getElementById('dolOptReadmeModList');
    if (listEl) {
        listEl.onclick = event => {
            const item = event.target?.closest?.('[data-mod-name]');
            if (item?.dataset.modName) window.dolOptSelectReadmeMod(item.dataset.modName);
        };
    }

    window.dolOptFilterReadmeList('');
    if (window._dolOptSelectedMod) {
        window.dolOptLoadReadme(window._dolOptSelectedMod);
    }
};

window.dolOptFilterReadmeList = function(keyword) {
    const listEl = document.getElementById('dolOptReadmeModList');
    if (!listEl || !window._dolOptReadmeMods) return;

    const filtered = window._dolOptReadmeMods.filter(name => {
        if (!keyword) return true;
        return name.toLowerCase().includes(keyword.toLowerCase());
    });

    if (filtered.length === 0) {
        listEl.innerHTML = '<li class="mod-empty grey">无匹配模组</li>';
        return;
    }

    listEl.innerHTML = filtered.map(name => {
        const isSelected = name === window._dolOptSelectedMod;
        return `
            <li class="dol-opt-readme-mod-item ${isSelected ? 'active gold' : ''}" data-mod-name="${window.dolOptEscapeHtml(name)}">
                <span class="mod-name" title="${window.dolOptEscapeHtml(name)}">${window.dolOptEscapeHtml(name)}</span>
            </li>
        `;
    }).join('');
};

window.dolOptSelectReadmeMod = function(modName) {
    window._dolOptSelectedMod = modName;
    const searchInput = document.getElementById('dolOptReadmeSearch');
    window.dolOptFilterReadmeList(searchInput ? searchInput.value.trim() : '');
    window.dolOptLoadReadme(modName);
};

// 辅助：根据文件后缀获取合法图片 MIME 类型
window.dolOptGetMimeTypeByExt = function(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'svg': return 'image/svg+xml';
        case 'bmp': return 'image/bmp';
        case 'ico': return 'image/x-icon';
        default: return 'image/png';
    }
};

// 辅助：在模组 Zip 中智能多级查找图片 entry（支持 URI 解码、大小写容错、纯文件名容错与常见子目录）
window.dolOptFindZipImageEntry = function(zip, rawPath) {
    if (!zip || !rawPath) return null;
    let decoded = '';
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (_) {
        decoded = rawPath;
    }
    const cleanPath = decoded.replace(/^\.?\//, '').trim();
    if (!cleanPath) return null;

    // 1. 精确路径匹配
    if (typeof zip.file === 'function') {
        const directEntry = zip.file(cleanPath);
        if (directEntry) return { entry: directEntry, path: cleanPath };
    }

    if (!zip.files) return null;

    const lowerClean = cleanPath.toLowerCase();
    const fileNameOnly = lowerClean.split('/').pop();

    // 2. 大小写不敏感全路径匹配
    for (const relPath in zip.files) {
        if (!zip.files[relPath].dir && relPath.toLowerCase() === lowerClean) {
            return { entry: zip.files[relPath], path: relPath };
        }
    }

    // 3. 常见资源子目录补全匹配
    const commonPrefixes = ['img/', 'guide/', 'images/', 'photo/', 'assets/'];
    for (const prefix of commonPrefixes) {
        const candidate = prefix + lowerClean;
        for (const relPath in zip.files) {
            if (!zip.files[relPath].dir && relPath.toLowerCase() === candidate) {
                return { entry: zip.files[relPath], path: relPath };
            }
        }
    }

    // 4. 纯文件名跨目录匹配
    for (const relPath in zip.files) {
        if (!zip.files[relPath].dir) {
            const fileLower = relPath.toLowerCase();
            if (fileLower === fileNameOnly || fileLower.endsWith('/' + fileNameOnly)) {
                return { entry: zip.files[relPath], path: relPath };
            }
        }
    }

    return null;
};

// 为 ReadMe 视图中的图片设置本地 Zip 资源解析与加载失败容灾兜底
window.dolOptSetupReadmeImages = async function(container, modName) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    const replaceWithFallback = img => {
        if (!img || img.dataset.hasFailed) return;
        img.dataset.hasFailed = 'true';

        const fallbackType = img.dataset.fallback;
        const alt = img.alt || '';
        const origSrc = img.dataset.originalSrc || img.src;
        if (fallbackType === 'badge' || img.classList.contains('dol-opt-readme-badge')) {
            img.src = window.dolOptGenerateFallbackBadgeSvg(alt, origSrc);
            img.classList.add('dol-opt-badge-fallback');
            return;
        }

        const placeholder = document.createElement('span');
        placeholder.className = 'dol-opt-image-fallback';
        placeholder.innerHTML = `
            <span class="fallback-icon">[图片]</span>
            <span class="fallback-content">
                <strong class="fallback-title">${window.dolOptEscapeHtml(alt || '网络图片未能加载')}</strong>
                <span class="fallback-tip grey">（可能受限于当前网络环境）</span>
                ${origSrc && /^https?:\/\//i.test(origSrc) ? `
                    <a class="fallback-link gold" href="${window.dolOptEscapeHtml(origSrc)}" target="_blank" rel="noopener noreferrer">在新窗口中打开原图</a>
                ` : ''}
            </span>
        `;
        img.replaceWith(placeholder);
    };

    // 捕获阶段可覆盖浏览器 CSP 与普通网络错误。
    container.addEventListener('error', event => {
        const img = event.target;
        if (img?.tagName === 'IMG') replaceWithFallback(img);
    }, true);

    const modInfo = window.dolOptGetModInfo(modName);
    const zip = modInfo?.zip || (typeof modInfo?.getZipFile === 'function' ? modInfo.getZipFile() : null);

    // 1. 解析模组内置相对路径图片（转为合规 data: Base64 URL 彻底消除 CSP 与 404 限制）
    const localImgs = container.querySelectorAll('img[data-local-mod-path]');
    if (localImgs && localImgs.length > 0 && zip) {
        try {
            for (const img of localImgs) {
                const rawPath = img.getAttribute('data-local-mod-path');
                if (!rawPath) continue;

                const found = window.dolOptFindZipImageEntry(zip, rawPath);
                if (found && found.entry && typeof found.entry.async === 'function') {
                    try {
                        let dataUrl = '';
                        const mime = window.dolOptGetMimeTypeByExt(found.path || rawPath);
                        try {
                            const base64 = await found.entry.async('base64');
                            if (base64) dataUrl = `data:${mime};base64,${base64}`;
                        } catch (_) {}

                        if (!dataUrl) {
                            const blob = await found.entry.async('blob');
                            if (blob && typeof FileReader !== 'undefined') {
                                dataUrl = await new Promise((resolve, reject) => {
                                    const reader = new FileReader();
                                    reader.onload = () => resolve(reader.result);
                                    reader.onerror = () => reject(reader.error || new Error('图片转码失败'));
                                    reader.readAsDataURL(blob);
                                });
                            }
                        }

                        if (dataUrl) {
                            img.src = dataUrl;
                            img.removeAttribute('data-local-mod-path');
                        } else {
                            replaceWithFallback(img);
                        }
                    } catch (err) {
                        console.warn('[DolOptimization] 解码模组内置图片失败:', rawPath, err);
                        replaceWithFallback(img);
                    }
                } else {
                    replaceWithFallback(img);
                }
            }
        } catch (err) {
            console.warn('[DolOptimization] 提取模组内置资源时异常:', err);
        }
    }

    // 2. 远程图片：优先尝试本地 Zip 容灾匹配，次选 Worker 代理转 data: URL，最后优雅降级
    const remoteImgs = container.querySelectorAll('img[data-remote-image-url]');
    for (const img of remoteImgs) {
        try {
            const originalSrc = img.dataset.originalSrc || '';
            // 2.1 检查本地 Zip 是否自带同名资源（秒开且免疫外网断联）
            if (zip && originalSrc) {
                const localMatch = window.dolOptFindZipImageEntry(zip, originalSrc);
                if (localMatch && localMatch.entry && typeof localMatch.entry.async === 'function') {
                    try {
                        const mime = window.dolOptGetMimeTypeByExt(localMatch.path || originalSrc);
                        const base64 = await localMatch.entry.async('base64');
                        if (base64) {
                            img.src = `data:${mime};base64,${base64}`;
                            img.removeAttribute('data-remote-image-url');
                            continue;
                        }
                    } catch (_) {}
                }
            }

            // 2.2 请求 Worker 代理接口或远程原图并转为 CSP 允许的 data: URL
            const remoteUrl = img.getAttribute('data-remote-image-url');
            if (!remoteUrl) throw new Error('缺少远程图片加载地址');
            const response = await fetch(remoteUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
                reader.readAsDataURL(blob);
            });
            img.src = dataUrl;
            img.removeAttribute('data-remote-image-url');
        } catch (err) {
            console.warn('[DolOptimization] README 网络图片代理失败:', img.dataset.originalSrc, err);
            replaceWithFallback(img);
        }
    }
};

window.dolOptLoadReadme = async function(modName) {
    const bodyEl = document.getElementById('dolOptReadmeBody');
    if (!bodyEl) return;

    const gui = window.dolOptGetGui();
    bodyEl.innerHTML = '<div class="mod-empty grey">正在读取文档...</div>';

    try {
        let readme = null;
        if (gui && typeof gui.getModTReadMe === 'function') {
            readme = await gui.getModTReadMe(modName);
        }

        const modInfo = window.dolOptGetModInfo(modName);
        const boot = modInfo?.bootJson || {};
        let marketInfo = window.dolModMarket?.findMarketModByLocalName?.(modName) || null;
        if (!marketInfo && window.dolModMarket?.loadMarketData) {
            try {
                const marketMods = await window.dolModMarket.loadMarketData();
                marketInfo = window.dolModMarket.findMarketModByLocalName?.(modName, marketMods) || null;
            } catch (_) {}
        }
        const author = boot.author || marketInfo?.author;
        const description = marketInfo?.description && marketInfo.description !== '暂无说明'
            ? marketInfo.description
            : '';
        const bootRepository = typeof boot.repository === 'string' ? boot.repository : boot.repository?.url;
        const repositoryUrl = [bootRepository, marketInfo?.githubUrl]
            .find(url => /^https?:\/\/github\.com\//i.test(url || '')) || '';
        const category = marketInfo?.primaryCategory || marketInfo?.category || '';
        const hasLocalReadme = window.dolOptHasReadmeContent(readme);
        let githubReadme = null;
        if (!hasLocalReadme && marketInfo?.githubUrl && window.dolModMarket?.fetchGithubReadme) {
            try {
                githubReadme = await window.dolModMarket.fetchGithubReadme(marketInfo.githubUrl);
            } catch (err) {
                console.warn('[DolOptimization] GitHub README 获取失败:', err);
            }
        }
        const effectiveReadme = hasLocalReadme ? readme : githubReadme?.markdown;

        let marketHtml = '';
        if (description || repositoryUrl || category) {
            marketHtml = `
                <div class="childItem dol-opt-readme-market-summary">
                    <div class="dol-opt-readme-market-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <strong class="gold">模组市场资料</strong>
                        ${category ? `<span class="dep-tag gold">[${window.dolOptEscapeHtml(category)}]</span>` : ''}
                    </div>
                    ${description ? `<p style="margin: 4px 0 8px 0; line-height: 1.5;">${window.dolOptEscapeHtml(description)}</p>` : ''}
                    ${repositoryUrl ? `<a class="macro-button dol-opt-btn-primary dol-opt-readme-repo" href="${window.dolOptEscapeHtml(repositoryUrl)}" target="_blank" rel="noopener noreferrer">访问模组仓库</a>` : ''}
                </div>
            `;
        }

        let contentHtml = `
            <div class="dol-opt-readme-header">
                <h3 class="gold" style="margin: 0 0 6px 0;">${window.dolOptEscapeHtml(modName)}</h3>
                <div class="dol-opt-readme-meta grey">
                    <span>版本: <strong class="def">${window.dolOptEscapeHtml(boot.version || '未知')}</strong></span>
                    ${author ? `<span>作者: <strong class="def">${window.dolOptEscapeHtml(author)}</strong></span>` : ''}
                </div>
            </div>
            ${marketHtml}
        `;

        if (window.dolOptHasReadmeContent(effectiveReadme)) {
            if (githubReadme) {
                contentHtml += `<p class="grey dol-opt-readme-source">以下说明来自 <a class="dol-opt-readme-link" href="${window.dolOptEscapeHtml(githubReadme.sourceUrl || repositoryUrl)}" target="_blank" rel="noopener noreferrer">GitHub 仓库 README</a>。</p>`;
            }
            contentHtml += `<div class="dol-opt-markdown-view">${window.dolOptRenderMarkdown(effectiveReadme, {
                modName,
                repositoryUrl,
                remoteImageBaseUrl: githubReadme?.downloadUrl || '',
                remoteLinkBaseUrl: githubReadme?.sourceUrl || '',
                escapeRawHtml: Boolean(githubReadme)
            })}</div>`;
            if ((boot.dependenceInfo && boot.dependenceInfo.length) || (boot.addonPlugin && boot.addonPlugin.length)) {
                contentHtml += `
                    <div class="dol-opt-meta-view" style="margin-top: 20px; border-top: 1px solid var(--750); padding-top: 12px;">
                        <h4 class="gold" style="margin: 0 0 10px 0;">模组技术信息</h4>
                        <div class="dol-opt-meta-grid">
                            ${boot.dependenceInfo && boot.dependenceInfo.length ? `
                                <div class="childItem meta-item full-width">
                                    <span class="grey meta-key">依赖项</span>
                                    <span class="meta-val">
                                        ${boot.dependenceInfo.map(d => `<span class="dep-tag grey">[依赖] ${window.dolOptEscapeHtml(d.modName)} (${window.dolOptEscapeHtml(d.version)})</span>`).join(' ')}
                                    </span>
                                </div>
                            ` : ''}
                            ${boot.addonPlugin && boot.addonPlugin.length ? `
                                <div class="childItem meta-item full-width">
                                    <span class="grey meta-key">插件扩展 (AddonPlugin)</span>
                                    <span class="meta-val">
                                        ${boot.addonPlugin.map(a => `<span class="dep-tag grey">[扩展] ${window.dolOptEscapeHtml(a.modName)} / ${window.dolOptEscapeHtml(a.addonName)}</span>`).join(' ')}
                                    </span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }
        } else {
            contentHtml += `
                <div class="dol-opt-meta-view">
                    <p class="dol-opt-readme-empty">此模组没有说明文档。</p>
                    ${!marketHtml ? '<p class="grey">当前仅能显示模组自身的 boot.json 信息。</p>' : ''}
                    <div class="dol-opt-meta-grid">
                        <div class="childItem meta-item">
                            <span class="grey meta-key">模组名称</span>
                            <span class="meta-val def">${window.dolOptEscapeHtml(boot.name || modName)}</span>
                        </div>
                        <div class="childItem meta-item">
                            <span class="grey meta-key">版本号</span>
                            <span class="meta-val def">${window.dolOptEscapeHtml(boot.version || '未知')}</span>
                        </div>
                        ${boot.dependenceInfo && boot.dependenceInfo.length ? `
                            <div class="childItem meta-item full-width">
                                <span class="grey meta-key">依赖项</span>
                                <span class="meta-val">
                                    ${boot.dependenceInfo.map(d => `<span class="dep-tag grey">[依赖] ${window.dolOptEscapeHtml(d.modName)} (${window.dolOptEscapeHtml(d.version)})</span>`).join(' ')}
                                </span>
                            </div>
                        ` : ''}
                        ${boot.addonPlugin && boot.addonPlugin.length ? `
                            <div class="childItem meta-item full-width">
                                <span class="grey meta-key">插件扩展 (AddonPlugin)</span>
                                <span class="meta-val">
                                    ${boot.addonPlugin.map(a => `<span class="dep-tag grey">[扩展] ${window.dolOptEscapeHtml(a.modName)} / ${window.dolOptEscapeHtml(a.addonName)}</span>`).join(' ')}
                                </span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        bodyEl.innerHTML = contentHtml;
        window.dolOptSetupReadmeImages(bodyEl, modName);
    } catch (e) {
        console.error('[DolOptimization] 读取 ReadMe 失败', e);
        bodyEl.innerHTML = `<div class="mod-empty red">读取文档失败：${window.dolOptEscapeHtml(e.message)}</div>`;
    }
};

/* =========================================================================
 * 5. 加载日志分析诊断与结构化渲染引擎
 * ========================================================================= */

// 启动检测到错误时自动弹窗定位配置（默认开启）
window.dolOptIsAutoOpenErrorLogEnabled = function() {
    try {
        if (typeof localStorage === 'undefined') return true;
        const val = localStorage.getItem('dol_opt_auto_open_log_on_error');
        return val === null ? true : val === 'true';
    } catch (_) {
        return true;
    }
};

window.dolOptSetAutoOpenErrorLogEnabled = function(val) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('dol_opt_auto_open_log_on_error', val ? 'true' : 'false');
        }
    } catch (_) {}
};

window.dolOptToggleAutoOpenLogSetting = function(checked) {
    window.dolOptSetAutoOpenErrorLogEnabled(checked);
    window.dolOptShowToast(checked ? '已开启【加载出错时自动弹出错误窗口】' : '已关闭【加载出错时自动弹出错误窗口】', 'info');
    const toggleInput = document.getElementById('toggleAutoOpenErrorLog');
    if (toggleInput) toggleInput.checked = checked;
};

// 常见模组加载错误通俗化诊断知识库 (0 Emoji)
const DOL_OPT_ERROR_PATTERNS = [
    {
        id: 'game-version-mismatch',
        title: '游戏版本不满足模组要求',
        keywords: ['dependencechecker.checkgameversion() not satisfies'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*gameVersion\[([^\]]+)\].*gameVersion is \[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'game-version-mismatch',
                title: '游戏版本不满足模组要求',
                desc: `模组【${match[1]}】要求 DoL ${match[2]}，当前游戏版本为 ${match[3]}。`,
                solution: `将 DoL 更新或切换到满足 ${match[2]} 的版本；若要继续使用 DoL ${match[3]}，请改装【${match[1]}】的对应旧版兼容包。不要直接忽略此错误。`
            };
        }
    },
    {
        id: 'modloader-version-mismatch',
        title: 'ModLoader 版本不满足要求',
        keywords: ['not satisfies modloader'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*version\[([^\]]+)\].*ModLoader\[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'modloader-version-mismatch',
                title: 'ModLoader 版本不满足要求',
                desc: `模组【${match[1]}】要求 ModLoader ${match[2]}，当前版本为 ${match[3]}。`,
                solution: `升级 ModLoader 到满足 ${match[2]} 的版本；若当前游戏整合包无法升级，请改用【${match[1]}】的旧版兼容包。`
            };
        }
    },
    {
        id: 'dependency-version-mismatch',
        title: '前置模组版本不满足要求',
        keywords: ['dependencechecker.check() not satisfies:', 'dependencechecker.checkfor('],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*need mod\[([^\]]+)\] version\[([^\]]+)\].*find version\[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'dependency-version-mismatch',
                title: '前置模组版本不满足要求',
                desc: `模组【${match[1]}】要求前置【${match[2]}】版本 ${match[3]}，当前检测到 ${match[4]}。`,
                solution: `将【${match[2]}】更新或切换到满足 ${match[3]} 的版本，删除重复旧包并重新载入游戏。`
            };
        }
    },
    {
        id: 'dependency-order',
        title: '前置模组加载顺序错误',
        keywords: ['not satisfies order'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*need mod\[([^\]]+)\] load before it/i);
            if (!match) return null;
            return {
                id: 'dependency-order',
                title: '前置模组加载顺序错误',
                desc: `模组【${match[1]}】需要【${match[2]}】先完成加载。`,
                solution: `在模组管理中把【${match[2]}】移动到【${match[1]}】之前，或使用智能整理，然后重新载入游戏。`
            };
        }
    },
    {
        id: 'missing-dep',
        title: '前置依赖模组缺失',
        keywords: ['not found', 'cannot find mod', 'dependency', 'depends on', 'dependenceinfo', 'referror', '未找到前置'],
        desc: '某个模组运行需要其他基础模组提供支持，但当前游戏中未安装或未启用对应的前置模组。',
        solution: '请查看报错模组的说明文档（ReadMe），下载并启用对应的前置框架模组（如 Simple Framework 等）。'
    },
    {
        id: 'patch-conflict',
        title: '模组补丁冲突或文本不匹配',
        keywords: ['patchmodtogame', 'replacepatcher', 'replace target', 'replace error', 'patch failed', 'duplicate', 'already exists'],
        desc: '补丁尝试修改游戏原版段落或代码时失败。通常因为多个模组修改了同一处文本产生冲突，或模组版本过旧未适配当前游戏。',
        solution: '在模组管理中调整模组加载顺序（建议尝试【智能整理模组与美化顺序】）；若仍报错，请检查模组版本是否与当前游戏兼容。'
    },
    {
        id: 'syntax-error',
        title: '代码语法错误 / 压缩包损坏',
        keywords: ['syntaxerror', 'unexpected token', 'unexpected identifier', 'invalid or unexpected token'],
        desc: '模组脚本解析失败。模组的代码本身存在语法疏漏，或者压缩包在下载或解压过程中损坏。',
        solution: '排查最近添加或更新的模组文件，尝试重新下载完整 Mod Zip 压缩包，或向模组作者反馈语法错误。'
    },
    {
        id: 'type-error',
        title: '空指针未定义异常 (TypeError)',
        keywords: ['typeerror', 'cannot read properties of', 'cannot read property', 'is not a function', 'is undefined'],
        desc: '模组试图调用未定义的对象或方法。常因前置模组加载过晚，或新版游戏官方重构调整了内部变量名。',
        solution: '尝试将基础框架模组拖至模组管理顶部优先加载；若无法解决，可能是模组尚未适配当前游戏版本。'
    },
    {
        id: 'boot-json-error',
        title: '模组清单配置 (boot.json) 异常',
        keywords: ['boot.json', 'invalid json', 'json.parse', 'missing name in boot.json', 'format error'],
        desc: '模组核心清单文件损坏、缺少必要字段或不是合法的 JSON 格式。',
        solution: '重新下载原版 Mod Zip 文件；若自行修改过模组，请确保 boot.json 遵循规范 JSON 格式。'
    },
    {
        id: 'storage-quota',
        title: '本地存储空间超限 (QuotaExceeded)',
        keywords: ['quotaexceedederror', 'indexeddb', 'storage quota', 'database error'],
        desc: '旁加载模组体积过大或图片过多，超出了浏览器允许的本地 IndexedDB 存储空间上限。',
        solution: '在通用或模组管理界面删除不常用的大型旁加载模组，或使用整合版微端运行游戏。'
    },
    {
        id: 'asset-missing',
        title: '立绘或多媒体资源缺失 (404)',
        keywords: ['404', 'failed to load resource', 'img/', 'image pack'],
        desc: '游戏请求了模组图像或音效，但在对应路径下未能找到对应资源文件。',
        solution: '检查美化包是否完整，并确认在【美化管理】中已启用了对应的美化图像包。'
    }
];

// 获取环境中已知的所有模组名称集合
window.dolOptGetAllKnownModNames = function() {
    const modSet = new Set();
    const gui = window.dolOptGetGui();
    if (gui?.gModUtils?.getModListNameNoAlias) {
        try {
            const list = gui.gModUtils.getModListNameNoAlias();
            if (Array.isArray(list)) list.forEach(n => n && modSet.add(n));
        } catch (_) {}
    }
    if (window._dolOptModState) {
        (window._dolOptModState.sideEnabled || []).forEach(m => {
            const name = typeof m === 'string' ? m : m?.name;
            if (name) modSet.add(name);
        });
        (window._dolOptModState.sideDisabled || []).forEach(m => {
            const name = typeof m === 'string' ? m : m?.name;
            if (name) modSet.add(name);
        });
        (window._dolOptModState.builtInMods || []).forEach(name => {
            if (name) modSet.add(name);
        });
    }
    return modSet;
};

// 统一原版 ModLoader 加载日志与控制台异常获取引擎
window.dolOptGetRawModLoaderLogs = function() {
    const gui = window.dolOptGetGui ? window.dolOptGetGui() : null;
    const modLoaderLogs = [];

    // 1. 优先从原版 gui.gLoadingProgress.logList 结构化数据提取（这是原版 ModLoader 存储的真实数据源）
    if (Array.isArray(gui?.gLoadingProgress?.logList) && gui.gLoadingProgress.logList.length > 0) {
        gui.gLoadingProgress.logList.forEach(item => {
            const timeStr = item.time?.format ? item.time.format('HH:mm:ss.SSS') : (item.time ? String(item.time) : '');
            const rawType = String(item.type || '').toLowerCase();
            const level = rawType === 'error' ? 'error' : (rawType === 'warning' || rawType === 'warn' ? 'warn' : 'info');
            modLoaderLogs.push({
                time: timeStr,
                level,
                message: String(item.str || item.message || '').trim()
            });
        });
    } else if (typeof gui?.gLoadingProgress?.getLoadLog === 'function') {
        // 2. 次优：从 gui.gLoadingProgress.getLoadLog() 字符串数组提取
        try {
            const lines = gui.gLoadingProgress.getLoadLog();
            if (Array.isArray(lines) && lines.length > 0) {
                lines.forEach(line => {
                    const lineStr = String(line || '').trim();
                    if (!lineStr) return;
                    let timeStr = '';
                    let level = 'info';
                    let message = lineStr;
                    const m = lineStr.match(/^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\[(error|warning|warn|info)\]\s*(.*)$/i);
                    if (m) {
                        timeStr = m[1];
                        const t = m[2].toLowerCase();
                        level = t === 'error' ? 'error' : (t.startsWith('warn') ? 'warn' : 'info');
                        message = m[3];
                    }
                    modLoaderLogs.push({ time: timeStr, level, message });
                });
            }
        } catch (_) {}
    } else if (typeof gui?.gLoadingProgress?.getLoadLogHtml === 'function') {
        // 3. 再次：从 gui.gLoadingProgress.getLoadLogHtml() 提取（兼容 DOM 元素数组或 HTML 字符串）
        try {
            const raw = gui.gLoadingProgress.getLoadLogHtml();
            if (Array.isArray(raw)) {
                raw.forEach((node, idx) => {
                    const text = node?.innerText || node?.textContent || '';
                    if (!text) return;
                    if (idx === 0 && /error,\s*\d+\s*warning/i.test(text)) return;
                    let level = 'info';
                    if (node?.style?.color === 'red' || /error/i.test(node?.className || '')) level = 'error';
                    else if (node?.style?.color === 'orange' || /warn/i.test(node?.className || '')) level = 'warn';

                    let timeStr = '';
                    let message = text;
                    const tm = text.match(/^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(.*)$/);
                    if (tm) {
                        timeStr = tm[1];
                        message = tm[2];
                    }
                    modLoaderLogs.push({ time: timeStr, level, message });
                });
            } else if (typeof raw === 'string' && raw.trim()) {
                const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                lines.forEach(l => {
                    modLoaderLogs.push({ time: '', level: 'info', message: l });
                });
            }
        } catch (_) {}
    }

    // 4. 兜底：从 modModLoadController.logRecordBeforeAnyLogHookRegister 提取
    if (!modLoaderLogs.length) {
        const controller = window.dolOptGetController ? window.dolOptGetController() : null;
        if (Array.isArray(controller?.logRecordBeforeAnyLogHookRegister)) {
            controller.logRecordBeforeAnyLogHookRegister.forEach(item => {
                const timeStr = item.time?.format ? item.time.format('HH:mm:ss.SSS') : '';
                const rawType = String(item.type || '').toLowerCase();
                const level = rawType === 'error' ? 'error' : (rawType === 'warning' || rawType === 'warn' ? 'warn' : 'info');
                modLoaderLogs.push({
                    time: timeStr,
                    level,
                    message: String(item.message || item.str || '').trim()
                });
            });
        }
    }

    const result = [];
    const seenConsole = new Set();

    // 5. 跨流去重导入控制台捕获的严重启动异常（仅保留原版日志未收录的外部异常）
    if (Array.isArray(window._dolOptStartupErrors) && window._dolOptStartupErrors.length > 0) {
        window._dolOptStartupErrors.forEach(err => {
            const rawMsg = String(err || '').trim();
            if (!rawMsg || seenConsole.has(rawMsg)) return;
            seenConsole.add(rawMsg);

            const cleanMsg = rawMsg.replace(/^\[(?:控制台报错|脚本异常|异步异常)\]\s*/, '').trim();
            const cleanLower = cleanMsg.toLowerCase();

            // 过滤良性降级异常
            if (cleanLower.includes('modlist.json') || cleanLower.includes('resizeobserver') || cleanLower.includes('duplicate name')) {
                return;
            }

            // 比对 ModLoader 日志中是否已收录该错误（若已有则丢弃控制台重复条目）
            const isDuplicate = modLoaderLogs.some(l => {
                const lMsg = String(l.message || '');
                const lLower = lMsg.toLowerCase();
                if (lMsg.includes(cleanMsg) || cleanMsg.includes(lMsg)) return true;
                if (cleanLower.includes('checkgameversion() not satisfies') && lLower.includes('checkgameversion() not satisfies')) {
                    const m1 = cleanMsg.match(/\["([^"]+)"/);
                    const m2 = lMsg.match(/mod\[([^\]]+)\]/);
                    if (m1 && m2 && m1[1] === m2[1]) return true;
                    if (!m1 && !m2) return true;
                }
                if (cleanLower.includes('cannot find findstring') && lLower.includes('cannot find findstring')) return true;
                if (cleanLower.includes('modloadcontroller') && lLower.includes('modloadcontroller')) return true;
                return false;
            });

            if (!isDuplicate) {
                result.push({
                    time: '',
                    level: 'error',
                    message: rawMsg,
                    isConsoleError: true
                });
            }
        });
    }

    // 6. 追加原版 ModLoader 真实日志
    modLoaderLogs.forEach(item => result.push(item));

    return result;
};

// 日志分析核心引擎（支持结构化行对象数组或原始文本）
window.dolOptAnalyzeLogs = function(rawContent) {
    if (!rawContent) {
        return {
            lines: [],
            errorCount: 0,
            warnCount: 0,
            infoCount: 0,
            errorMods: [],
            errorFiles: [],
            matchedIssues: [],
            firstErrorIndex: -1
        };
    }

    const allKnownMods = window.dolOptGetAllKnownModNames();
    const parsedLines = [];
    const errorMods = new Set();
    const errorFiles = new Set();
    const matchedIssuesMap = new Map();
    let errorCount = 0;
    let warnCount = 0;
    let infoCount = 0;
    let firstErrorIndex = -1;

    // 统一拆解为行队列
    let items = [];
    if (Array.isArray(rawContent)) {
        items = rawContent.map(item => {
            if (typeof item === 'string') return { time: '', level: 'info', message: item };
            return {
                time: item?.time || '',
                level: item?.level || 'info',
                message: String(item?.message || item?.str || '')
            };
        });
    } else {
        let text = String(rawContent);
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/div>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        const entities = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' };
        for (let i = 0; i < 2; i++) {
            text = text.replace(/&(amp|quot|#39|apos|lt|gt);/gi, entity => entities[entity.slice(1, -1).toLowerCase()] || entity);
        }
        const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        items = rawLines.map(line => ({ time: '', level: 'info', message: line }));
    }

    items.forEach((item, index) => {
        let line = item.message;
        let timeStr = item.time;
        if (!timeStr) {
            const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|\[\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2})/);
            if (timeMatch) timeStr = timeMatch[1];
        }

        let level = item.level || 'info';
        const lineLower = line.toLowerCase();
        const isExplicitError = level === 'error' ||
            line.includes('[[logError]]') ||
            line.includes('[ERROR]') ||
            line.includes('[错误]') ||
            line.includes('[控制台报错]') ||
            lineLower.includes('logerror') ||
            line.includes('Error:') ||
            line.includes('error:') ||
            line.includes('cannot find findString') ||
            line.includes('not satisfies') ||
            (line.includes('errorCount:[') && !line.includes('errorCount:[0]'));

        const isExplicitWarn = !isExplicitError && (
            level === 'warn' ||
            level === 'warning' ||
            line.includes('[[logWarning]]') ||
            line.includes('[WARN]') ||
            line.includes('[WARNING]') ||
            line.includes('[警告]') ||
            line.includes('[控制台警告]') ||
            lineLower.includes('logwarning') ||
            line.includes('Warning:') ||
            line.includes('warning:') ||
            line.includes('duplicate name') ||
            (line.includes('warningCount:[') && !line.includes('warningCount:[0]'))
        );

        if (isExplicitError) {
            level = 'error';
            errorCount++;
            if (firstErrorIndex === -1) firstErrorIndex = index;
        } else if (isExplicitWarn) {
            level = 'warn';
            warnCount++;
        } else {
            level = 'info';
            infoCount++;
        }

        // 清理正文中的原始级别标签
        let cleanMsg = line;
        cleanMsg = cleanMsg.replace(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|\[\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2})\s*/, '');
        cleanMsg = cleanMsg.replace(/\[\[log(?:Error|Warning|Info)\]\]\s*/g, '');
        cleanMsg = cleanMsg.replace(/^\[(?:ERROR|WARN|WARNING|INFO|错误|警告|信息)\]\s*/i, '');

        // 提取模组名
        const foundModsInLine = new Set();
        const modRegexes = [
            /(?:mod|id|Mod|MOD)\s*\[([^\]]+)\]/g,
            /(?:modName|mod_name|mod)[\s:=]+([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g,
            /on mod\[([^\]]+)\]/g
        ];
        modRegexes.forEach(reg => {
            let m;
            while ((m = reg.exec(cleanMsg)) !== null) {
                const candidate = m[1].trim();
                if (candidate && candidate.length > 1 && !['info', 'warn', 'error', 'null', 'undefined'].includes(candidate.toLowerCase())) {
                    foundModsInLine.add(candidate);
                }
            }
        });

        for (const known of allKnownMods) {
            if (cleanMsg.includes(known)) foundModsInLine.add(known);
        }

        // 提取文件名
        const foundFilesInLine = new Set();
        const fileRegex = /([a-zA-Z0-9_\-\u4e00-\u9fa5./\\]+\.(?:js|twee|json|png|gif|css|zip|html))/gi;
        let fm;
        while ((fm = fileRegex.exec(cleanMsg)) !== null) {
            const fileName = fm[1].trim();
            if (!fileName.startsWith('http') && !fileName.endsWith('.com')) {
                foundFilesInLine.add(fileName);
            }
        }

        // 如果是错误行，归纳并匹配知识库
        if (level === 'error') {
            foundModsInLine.forEach(m => errorMods.add(m));
            foundFilesInLine.forEach(f => errorFiles.add(f));

            DOL_OPT_ERROR_PATTERNS.forEach(pattern => {
                if (pattern.keywords.some(kw => lineLower.includes(kw.toLowerCase()))) {
                    const issue = typeof pattern.resolve === 'function' ? pattern.resolve(cleanMsg) : pattern;
                    if (issue && !matchedIssuesMap.has(issue.id)) {
                        matchedIssuesMap.set(issue.id, issue);
                    }
                }
            });
        }

        parsedLines.push({
            index,
            time: timeStr,
            level,
            message: cleanMsg,
            mods: Array.from(foundModsInLine),
            files: Array.from(foundFilesInLine)
        });
    });

    return {
        lines: parsedLines,
        errorCount,
        warnCount,
        infoCount,
        errorMods: Array.from(errorMods),
        errorFiles: Array.from(errorFiles),
        matchedIssues: Array.from(matchedIssuesMap.values()),
        firstErrorIndex
    };
};

// 置顶诊断卡片渲染
window.dolOptRenderLogDiagnosis = function(analysis) {
    const container = document.getElementById('dolOptLogDiagnosisContainer');
    if (!container) return;

    const autoOpenEnabled = window.dolOptIsAutoOpenErrorLogEnabled();

    if (!analysis || analysis.errorCount === 0) {
        container.innerHTML = `
            <div class="childItem dol-opt-diagnosis-card diag-normal">
                <div class="dol-opt-diag-header">
                    <div class="dol-opt-diag-title green">
                        [正常] 模组加载流程正常，未检测到加载错误
                    </div>
                    <label class="dol-opt-checkbox-label" title="开启后，若下次游戏启动加载模组发生错误将自动弹出本窗口">
                        <input type="checkbox" id="toggleAutoOpenErrorLog" class="macro-checkbox" ${autoOpenEnabled ? 'checked' : ''} onchange="window.dolOptToggleAutoOpenLogSetting(this.checked)" />
                        加载出错时自动弹窗
                    </label>
                </div>
            </div>
        `;
        return;
    }

    let html = `
        <div class="childItem dol-opt-diagnosis-card diag-error">
            <div class="dol-opt-diag-header">
                <div class="dol-opt-diag-title red">
                    <span class="gold">[!]</span> 模组加载异常快速诊断 (发现 ${analysis.errorCount} 处错误)
                </div>
                <div class="dol-opt-diag-actions">
                    <button type="button" class="macro-button dol-opt-btn-primary dol-opt-btn-locate" onclick="window.dolOptScrollToFirstError()">定位首处错误</button>
                </div>
            </div>
    `;

    // 报错关联模组徽章
    if (analysis.errorMods.length > 0) {
        html += `
            <div class="dol-opt-diag-row">
                <span class="grey diag-label">报错关联模组：</span>
                <div class="diag-badges">
                    ${analysis.errorMods.map(modName => `
                        <button type="button" class="dol-opt-diag-badge mod-badge" data-log-search="${window.dolOptEscapeHtml(modName)}" title="点击在日志中筛选此模组">
                            [模组] ${window.dolOptEscapeHtml(modName)}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // 报错关联文件徽章
    if (analysis.errorFiles.length > 0) {
        html += `
            <div class="dol-opt-diag-row">
                <span class="grey diag-label">报错关联文件：</span>
                <div class="diag-badges">
                    ${analysis.errorFiles.map(fileName => `
                        <button type="button" class="dol-opt-diag-badge file-badge" data-log-search="${window.dolOptEscapeHtml(fileName)}" title="点击在日志中筛选此文件">
                            [文件] ${window.dolOptEscapeHtml(fileName)}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // 通俗原因分析与排查建议
    if (analysis.matchedIssues.length > 0) {
        html += `
            <div class="dol-opt-diag-issues">
                <div class="grey diag-label" style="margin-bottom: 6px;">可能原因分析与排查指引：</div>
                ${analysis.matchedIssues.map(issue => `
                    <div class="dol-opt-issue-item">
                        <div class="issue-title gold">【${window.dolOptEscapeHtml(issue.title)}】</div>
                        <div class="issue-desc grey">${window.dolOptEscapeHtml(issue.desc)}</div>
                        <div class="issue-solution"><span class="green">[排查建议]</span> ${window.dolOptEscapeHtml(issue.solution)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        html += `
            <div class="dol-opt-diag-issues">
                <div class="dol-opt-issue-item">
                    <div class="issue-title gold">【常规运行时异常】</div>
                    <div class="issue-desc grey">模组在执行代码逻辑或生命周期注入时抛出了未捕获的错误。</div>
                    <div class="issue-solution"><span class="green">[排查建议]</span> 请点击上方“定位首处错误”查看报错具体位置，排查最近安装的第三方模组。</div>
                </div>
            </div>
        `;
    }

    // 底部控制开关
    html += `
            <div class="dol-opt-diag-footer">
                <label class="dol-opt-checkbox-label" title="开启后，若下次游戏启动加载模组发生错误将自动弹出本日志窗口并定位错误">
                    <input type="checkbox" id="toggleAutoOpenErrorLog" class="macro-checkbox" ${autoOpenEnabled ? 'checked' : ''} onchange="window.dolOptToggleAutoOpenLogSetting(this.checked)" />
                    游戏启动检测到加载错误时直接打开错误窗口并定位 <span class="gold">(默认开启，可在此关闭)</span>
                </label>
            </div>
        </div>
    `;

    container.innerHTML = html;
    container.onclick = event => {
        const button = event.target?.closest?.('[data-log-search]');
        if (button) window.dolOptSetLogSearch(button.dataset.logSearch);
    };
};

// 结构化日志正文渲染
window.dolOptRenderStructuredLogs = function(container, lines) {
    if (!container) return;
    if (!lines || lines.length === 0) {
        container.innerHTML = '<div class="mod-empty grey">暂无加载日志内容</div>';
        return;
    }

    let html = '<div class="dol-opt-log-stream">';
    lines.forEach((item, index) => {
        const isFirstErr = (item.level === 'error' && index === window._dolOptFirstErrorIndex);
        const rowId = isFirstErr ? 'id="dolOptFirstError"' : '';
        const levelClass = item.level === 'error' ? 'log-row-error' : (item.level === 'warn' ? 'log-row-warn' : 'log-row-info');
        const badgeLabel = item.level === 'error' ? '[错误]' : (item.level === 'warn' ? '[警告]' : '[信息]');
        const badgeClass = item.level === 'error' ? 'log-badge-error' : (item.level === 'warn' ? 'log-badge-warn' : 'log-badge-info');

        html += `
            <div class="dol-opt-log-row ${levelClass}" ${rowId} data-level="${item.level}" data-line-index="${index}">
                <span class="dol-opt-log-time grey">${window.dolOptEscapeHtml(item.time || '')}</span>
                <span class="dol-opt-log-badge ${badgeClass}">${badgeLabel}</span>
                <span class="dol-opt-log-msg">${window.dolOptEscapeHtml(item.message)}</span>
            </div>
        `;
    });
    html += '</div>';

    container.innerHTML = html;
};

// 按级别（警告/错误）快速跳转并高亮定位（支持多处循环跳转）
window.dolOptJumpToLevel = function(level) {
    const log = document.getElementById('dolOptLogContent');
    if (!log) return;

    const normLevel = (level === 'warning' || level === 'warn') ? 'warn' : 'error';
    const targetClass = normLevel === 'warn' ? 'log-row-warn' : 'log-row-error';
    const label = normLevel === 'warn' ? '警告' : '错误';
    const rows = Array.from(log.querySelectorAll(`.dol-opt-log-row.${targetClass}`));

    if (!rows.length) {
        window.dolOptShowToast(`未在日志中检测到【${label}】项`, 'info');
        return;
    }

    window._dolOptLevelJumpIndex = window._dolOptLevelJumpIndex || {};
    if (window._dolOptLevelJumpIndex[normLevel] === undefined) {
        window._dolOptLevelJumpIndex[normLevel] = 0;
    } else {
        window._dolOptLevelJumpIndex[normLevel] = (window._dolOptLevelJumpIndex[normLevel] + 1) % rows.length;
    }

    const currentIdx = window._dolOptLevelJumpIndex[normLevel];
    const targetRow = rows[currentIdx];

    // 清除其他行活跃样式并为当前行添加脉冲高亮
    log.querySelectorAll('.dol-opt-log-row').forEach(r => r.classList.remove('active', 'dol-opt-highlight-pulse'));
    targetRow.classList.add('active', 'dol-opt-highlight-pulse');

    // 内层滚动：将错误行在日志容器内垂直居中
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });

    window.dolOptShowToast(`已定位至【${label}】(${currentIdx + 1}/${rows.length})`, normLevel === 'error' ? 'warning' : 'info');

    setTimeout(() => {
        targetRow.classList.remove('dol-opt-highlight-pulse');
    }, 2500);
};

// 定位到第一个错误
window.dolOptScrollToFirstError = function() {
    window._dolOptLevelJumpIndex = window._dolOptLevelJumpIndex || {};
    window._dolOptLevelJumpIndex['error'] = -1;
    window.dolOptJumpToLevel('error');
};

// 通用模组管理器弹窗安全呼出接口（支持直达任意 Tab，如“加载日志”）
window.dolOptOpenManager = function(tabName = '模组管理', options = {}) {
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
            window._dolOptPendingScrollToFirstError = true;
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
                console.warn('[DolOptimization] 直连渲染模组管理器面板失败，尝试降级呼出', errEval);
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
                    if (typeof window.dolOptScrollToFirstError === 'function') {
                        window.dolOptScrollToFirstError();
                    }
                }, 100);
            }
        }, 50);

        return rendered;
    } catch (e) {
        console.error('[DolOptimization] 呼出模组管理器失败', e);
        return false;
    }
};

// 判定游戏启动生命周期是否已正式结束且通道就绪（严禁在遮罩加载期提前弹出半成品日志）
window.dolOptIsGameStartupReady = function() {
    if (window._dolOptForceStartupErrorOpen) return true;
    if (typeof document === 'undefined') return true;

    // 1. 检查启动遮罩 #init-screen 是否仍然可见（处于模组与游戏加载阶段）
    const initScreen = document.getElementById('init-screen');
    if (initScreen) {
        if (typeof window.getComputedStyle === 'function') {
            try {
                const style = window.getComputedStyle(initScreen);
                if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return false;
                }
            } catch (_) {}
        } else {
            return false;
        }
    }

    // 2. 检查 customOverlay 容器是否已挂载
    const overlay = document.getElementById('customOverlay');
    if (!overlay) return false;

    // 3. 检查游戏引擎是否已经就绪进入通道（针对 SugarCube 运行时环境）
    if (typeof SugarCube !== 'undefined' && SugarCube.State) {
        if (!SugarCube.State.passage) return false;
    }

    return true;
};

// 启动时检测加载错误并自动弹窗（严格与日志分析器自洽）
window.dolOptCheckAndAutoOpenErrorLog = function() {
    if (!window.dolOptIsAutoOpenErrorLogEnabled()) return false;
    if (window._dolOptErrorDialogShown) return false;

    // 1. 获取最新日志流并做统一错误分析
    const rawLogs = typeof window.dolOptGetRawModLoaderLogs === 'function' ? window.dolOptGetRawModLoaderLogs() : null;
    let hasError = false;

    if (rawLogs && rawLogs.length > 0) {
        const analysis = window.dolOptAnalyzeLogs(rawLogs);
        if (analysis && analysis.errorCount > 0) {
            hasError = true;
        }
    }

    // 2. 补充检查控制台捕获的严重启动错误
    if (!hasError && Array.isArray(window._dolOptStartupErrors) && window._dolOptStartupErrors.length > 0) {
        hasError = true;
    }

    // 若无任何错误，绝对不自动弹窗，避免误打扰正常玩家
    if (!hasError) return false;

    // 标记系统已检测到启动错误
    window._dolOptHasDetectedStartupError = true;

    // 严禁在游戏启动遮罩加载中途强行呼出半成品日志弹窗
    if (!window.dolOptIsGameStartupReady()) {
        window._dolOptPendingAutoOpenErrorLog = true;
        return false;
    }

    // 尝试呼出模组错误日志弹窗
    const opened = window.dolOptOpenManager('加载日志', { scrollToError: true });
    if (opened) {
        window._dolOptErrorDialogShown = true;
        window._dolOptPendingAutoOpenErrorLog = false;
        return true;
    } else {
        window._dolOptPendingAutoOpenErrorLog = true;
        return false;
    }
};

window.dolOptFindTextOffsets = function(text, query) {
    const source = String(text || '').toLocaleLowerCase();
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return [];

    const offsets = [];
    let index = 0;
    while ((index = source.indexOf(needle, index)) !== -1) {
        offsets.push(index);
        index += needle.length;
    }
    return offsets;
};

window.dolOptMoveLogMatch = function(delta = 0) {
    const matches = window._dolOptLogMatches || [];
    const status = document.getElementById('dolOptLogSearchStatus');
    if (!matches.length) {
        if (status) status.textContent = '0/0';
        return;
    }

    window._dolOptLogMatchIndex = ((window._dolOptLogMatchIndex || 0) + delta + matches.length) % matches.length;
    matches.forEach((match, index) => match.classList.toggle('active', index === window._dolOptLogMatchIndex));
    const activeMatch = matches[window._dolOptLogMatchIndex];
    if (activeMatch && typeof activeMatch.scrollIntoView === 'function') {
        activeMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        activeMatch.classList.add('dol-opt-highlight-pulse');
        setTimeout(() => activeMatch.classList.remove('dol-opt-highlight-pulse'), 1800);
    }
    if (status) status.textContent = `${window._dolOptLogMatchIndex + 1}/${matches.length}`;
};

window.dolOptSearchLoadLog = function(query) {
    const log = document.getElementById('dolOptLogContent');
    if (!log) return;
    if (window._dolOptLogOriginalHtml === undefined) window._dolOptLogOriginalHtml = log.innerHTML;
    log.innerHTML = window._dolOptLogOriginalHtml;

    const needle = String(query || '').trim();
    if (!needle) {
        window._dolOptLogMatches = [];
        window._dolOptLogMatchIndex = 0;
        window.dolOptMoveLogMatch();
        return;
    }

    // 智能别名映射：如果搜索词是 logWarning 或 logError，自动匹配对应的行
    const needleLower = needle.toLowerCase();
    if (needleLower === 'logwarning' || needleLower === 'warning' || needle === '警告') {
        window.dolOptJumpToLevel('warn');
        return;
    }
    if (needleLower === 'logerror' || needleLower === 'error' || needle === '错误') {
        window.dolOptJumpToLevel('error');
        return;
    }

    const matches = [];
    const walker = document.createTreeWalker(log, 4);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(node => {
        const offsets = window.dolOptFindTextOffsets(node.data, needle);
        if (!offsets.length) return;

        const fragment = document.createDocumentFragment();
        let cursor = 0;
        offsets.forEach(offset => {
            fragment.append(document.createTextNode(node.data.slice(cursor, offset)));
            const mark = document.createElement('mark');
            mark.className = 'dol-opt-log-match';
            mark.textContent = node.data.slice(offset, offset + needle.length);
            fragment.append(mark);
            matches.push(mark);
            cursor = offset + needle.length;
        });
        fragment.append(document.createTextNode(node.data.slice(cursor)));
        node.parentNode.replaceChild(fragment, node);
    });

    window._dolOptLogMatches = matches;
    window._dolOptLogMatchIndex = 0;
    window.dolOptMoveLogMatch();
};

window.dolOptSetLogSearch = function(query) {
    const q = String(query || '').trim();
    const qLower = q.toLowerCase();
    if (qLower === 'logwarning' || qLower === 'warning' || q === '警告') {
        window.dolOptJumpToLevel('warn');
        return;
    }
    if (qLower === 'logerror' || qLower === 'error' || q === '错误') {
        window.dolOptJumpToLevel('error');
        return;
    }
    const input = document.getElementById('dolOptLogSearch');
    if (input) input.value = q;
    window.dolOptSearchLoadLog(q);
};

window.dolOptInitLogTools = function() {
    const log = document.getElementById('dolOptLogContent');
    const input = document.getElementById('dolOptLogSearch');
    if (!log) return;

    // 1. 获取并深度分析加载日志（优先从结构化原版日志流与控制台异常获取）
    const rawLogs = typeof window.dolOptGetRawModLoaderLogs === 'function' ? window.dolOptGetRawModLoaderLogs() : null;
    const analysis = window.dolOptAnalyzeLogs(rawLogs && rawLogs.length > 0 ? rawLogs : (log.innerHTML || ''));
    window._dolOptLastLogAnalysis = analysis;
    window._dolOptFirstErrorIndex = analysis.firstErrorIndex;

    // 2. 渲染置顶诊断卡片
    window.dolOptRenderLogDiagnosis(analysis);

    // 3. 结构化渲染日志正文行
    if (analysis.lines.length > 0) {
        window.dolOptRenderStructuredLogs(log, analysis.lines);
    } else {
        log.innerHTML = '<div class="mod-empty grey">暂无模组加载日志</div>';
    }

    // 4. 记录结构化后的原始 HTML 供搜索高亮
    window._dolOptLogOriginalHtml = log.innerHTML;
    window._dolOptLogMatches = [];
    window._dolOptLogMatchIndex = 0;

    if (input) {
        input.oninput = () => window.dolOptSearchLoadLog(input.value);
        input.onkeydown = event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            window.dolOptMoveLogMatch(event.shiftKey ? -1 : 1);
        };
    }

    // 5. 更新状态栏统计按钮与筛选标签
    const errorCount = analysis.errorCount;
    const warningCount = analysis.warnCount;
    const errorButton = document.getElementById('dolOptLogErrors');
    const warningButton = document.getElementById('dolOptLogWarnings');
    const filterErrorBtn = document.getElementById('dolOptFilterError');
    const filterWarnBtn = document.getElementById('dolOptFilterWarn');

    if (errorButton) {
        if (errorCount > 0) {
            errorButton.innerHTML = `<span class="red" style="font-weight: bold;">错误 ${errorCount}</span>`;
            errorButton.classList.add('has-errors');
            errorButton.disabled = false;
        } else {
            errorButton.innerHTML = `<span class="grey">错误 0</span>`;
            errorButton.classList.remove('has-errors');
            errorButton.disabled = true;
        }
    }
    if (warningButton) {
        if (warningCount > 0) {
            warningButton.innerHTML = `<span class="gold" style="font-weight: bold;">警告 ${warningCount}</span>`;
            warningButton.classList.add('has-warnings');
            warningButton.disabled = false;
        } else {
            warningButton.innerHTML = `<span class="grey">警告 0</span>`;
            warningButton.classList.remove('has-warnings');
            warningButton.disabled = true;
        }
    }
    if (filterErrorBtn) {
        filterErrorBtn.textContent = errorCount > 0 ? `仅错误 (${errorCount})` : '仅错误 (0)';
    }
    if (filterWarnBtn) {
        filterWarnBtn.textContent = warningCount > 0 ? `仅警告 (${warningCount})` : '仅警告 (0)';
    }

    // 默认保持当前的筛选状态（若未设置则为全部）
    window.dolOptSetLogLevelFilter(window._dolOptCurrentLogLevelFilter || 'all');

    // 若存在待定位首处错误标记，在当前微任务/下一帧立即执行精准定位
    if (window._dolOptPendingScrollToFirstError) {
        window._dolOptPendingScrollToFirstError = false;
        setTimeout(() => {
            if (typeof window.dolOptScrollToFirstError === 'function') {
                window.dolOptScrollToFirstError();
            }
        }, 60);
    }
};

/* =========================================================================
 * 5.1 日志全屏切换控制器
 * ========================================================================= */
window.dolOptIsLogFullscreen = function() {
    if (typeof document === 'undefined') return false;
    const overlay = document.getElementById('customOverlay') || document.querySelector('.customOverlay');
    return overlay ? overlay.classList.contains('dol-opt-overlay-fullscreen') : false;
};

window.dolOptToggleLogFullscreen = function(forceState = null) {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('customOverlay') || document.querySelector('.customOverlay');
    if (!overlay) return;
    const container = overlay.closest('.customOverlayContainer') || overlay.parentElement;

    const shouldBeFull = typeof forceState === 'boolean'
        ? forceState
        : !overlay.classList.contains('dol-opt-overlay-fullscreen');

    overlay.classList.toggle('dol-opt-overlay-fullscreen', shouldBeFull);
    if (container) {
        container.classList.toggle('dol-opt-container-fullscreen', shouldBeFull);
    }

    const btn = document.getElementById('btnToggleLogFullscreen');
    if (btn) {
        btn.textContent = shouldBeFull ? '还原窗口' : '全屏展示';
        btn.title = shouldBeFull ? '退出全屏模式 (Esc)' : '展开全屏模式';
        btn.classList.toggle('active', shouldBeFull);
        btn.classList.toggle('dol-opt-btn-primary', shouldBeFull);
        btn.classList.toggle('dol-opt-btn-secondary', !shouldBeFull);
    }
    if (typeof forceState !== 'boolean') {
        const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
        const hint = isTouch ? '点击上方“还原窗口”可随时退出' : '按 Esc 或点击“还原窗口”可随时退出';
        window.dolOptShowToast(shouldBeFull ? `已开启日志全屏模式 (${hint})` : '已退出全屏模式', 'info');
    }
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && window.dolOptIsLogFullscreen?.()) {
            e.stopPropagation();
            window.dolOptToggleLogFullscreen(false);
        }
    }, true);
}

if (typeof $ !== 'undefined' && typeof $(document) !== 'undefined' && typeof $(document).on === 'function') {
    $(document).on(':oncloseoverlay', function() {
        window.dolOptToggleLogFullscreen?.(false);
    });
    $(document).on('click', '#overlayTabs button, .customOverlayClose', function() {
        const text = $(this).text() || '';
        if (!text.includes('加载日志') && window.dolOptIsLogFullscreen?.()) {
            window.dolOptToggleLogFullscreen?.(false);
        }
    });
}

/* =========================================================================
 * 5.2 日志级别筛选控制器（全部 / 仅错误 / 仅警告 / 错误+警告）
 * ========================================================================= */
window._dolOptCurrentLogLevelFilter = 'all';

window.dolOptSetLogLevelFilter = function(filter) {
    const activeFilter = filter || 'all';
    window._dolOptCurrentLogLevelFilter = activeFilter;
    if (typeof document === 'undefined') return;

    const log = document.getElementById('dolOptLogContent');
    if (!log) return;

    log.classList.remove('filter-error-only', 'filter-warn-only', 'filter-issues-only');
    if (activeFilter === 'error') {
        log.classList.add('filter-error-only');
    } else if (activeFilter === 'warn') {
        log.classList.add('filter-warn-only');
    } else if (activeFilter === 'issues') {
        log.classList.add('filter-issues-only');
    }

    const filterBtns = document.querySelectorAll('.dol-opt-log-filter-btn');
    filterBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === activeFilter);
    });

    // 联动刷新搜索状态统计
    const searchInput = document.getElementById('dolOptLogSearch');
    if (searchInput && searchInput.value.trim()) {
        window.dolOptSearchLoadLog(searchInput.value.trim());
    } else {
        const rows = Array.from(log.querySelectorAll('.dol-opt-log-row'));
        const visibleCount = rows.filter(r => {
            if (activeFilter === 'error') return r.classList.contains('log-row-error');
            if (activeFilter === 'warn') return r.classList.contains('log-row-warn');
            if (activeFilter === 'issues') return r.classList.contains('log-row-error') || r.classList.contains('log-row-warn');
            return true;
        }).length;
        const status = document.getElementById('dolOptLogSearchStatus');
        if (status) status.textContent = `0/${visibleCount}`;
    }
};

/* =========================================================================
 * 5.3 纯原生 Canvas 诊断长图生成与一键截图（剪贴板直贴 + 自动保存）
 * ========================================================================= */
window.dolOptCaptureLogScreenshot = async function() {
    if (typeof document === 'undefined') return;
    const log = document.getElementById('dolOptLogContent');
    if (!log) {
        window.dolOptShowToast('未能找到日志内容', 'warning');
        return;
    }

    window.dolOptShowToast('正在生成诊断长图...', 'info');

    // 1. 获取当前筛选状态下的全部可见行
    const allRows = Array.from(log.querySelectorAll('.dol-opt-log-row'));
    const activeFilter = window._dolOptCurrentLogLevelFilter || 'all';
    let rows = allRows.filter(r => {
        if (activeFilter === 'error') return r.classList.contains('log-row-error');
        if (activeFilter === 'warn') return r.classList.contains('log-row-warn');
        if (activeFilter === 'issues') return r.classList.contains('log-row-error') || r.classList.contains('log-row-warn');
        return true;
    });

    if (!rows.length) {
        window.dolOptShowToast('当前筛选条件下没有日志内容可截取', 'warning');
        return;
    }

    const maxRows = 100;
    const isTruncated = rows.length > maxRows;
    rows = rows.slice(0, maxRows);

    const analysis = window._dolOptLastLogAnalysis || window.dolOptAnalyzeLogs?.(log.innerHTML) || {};
    const errCount = analysis.errorCount || 0;
    const warnCount = analysis.warnCount || 0;

    const width = 960;
    const padding = 20;
    const headerHeight = 112;
    const footerHeight = 44;
    const lineHeight = 18;
    const rowSpacing = 6;
    const rowPadding = 8;

    function wrapText(ctx, text, maxW) {
        const lines = [];
        const rawLines = String(text || '').split('\n');
        for (const raw of rawLines) {
            let current = '';
            for (let i = 0; i < raw.length; i++) {
                const char = raw[i];
                const testLine = current + char;
                if (ctx.measureText(testLine).width > maxW && current) {
                    lines.push(current);
                    current = char;
                } else {
                    current = testLine;
                }
            }
            if (current) lines.push(current);
        }
        return lines.length ? lines : [''];
    }

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext ? tempCanvas.getContext('2d') : null;
    if (!tempCtx) {
        window.dolOptShowToast('当前运行环境不支持 Canvas 图像绘制', 'warning');
        return;
    }
    tempCtx.font = '12px "Consolas", "Courier New", monospace';

    const preparedRows = [];
    let totalBodyHeight = 0;
    const contentWidth = width - padding * 2;
    const msgWidth = contentWidth - 145;

    for (const row of rows) {
        const level = row.dataset.level || (row.classList.contains('log-row-error') ? 'error' : (row.classList.contains('log-row-warn') ? 'warn' : 'info'));
        const time = row.querySelector('.dol-opt-log-time')?.textContent?.trim() || '';
        const msg = row.querySelector('.dol-opt-log-msg')?.textContent?.trim() || '';

        const wrappedMsg = wrapText(tempCtx, msg, msgWidth);
        const rowHeight = Math.max(28, wrappedMsg.length * lineHeight + rowPadding * 2);
        preparedRows.push({ level, time, msgLines: wrappedMsg, rowHeight });
        totalBodyHeight += rowHeight + rowSpacing;
    }

    if (isTruncated) totalBodyHeight += 32;

    const totalHeight = headerHeight + totalBodyHeight + footerHeight + padding * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    // 绘制暗黑背景
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, width, totalHeight);
    ctx.strokeStyle = '#2d2d2d';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, totalHeight - 1);

    // 绘制 Header 卡片
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(padding, padding, width - padding * 2, headerHeight - 10);
    ctx.strokeStyle = errCount > 0 ? '#8b2020' : '#444';
    ctx.strokeRect(padding + 0.5, padding + 0.5, width - padding * 2 - 1, headerHeight - 10 - 1);

    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('Degrees of Lewdity 模组加载报错诊断报告', padding + 16, padding + 30);

    ctx.fillStyle = '#aaa';
    ctx.font = '12px sans-serif';
    const nowStr = new Date().toLocaleString();
    const dolVer = window.StartConfig?.version || '0.5.11.9';
    const mlVer = window.modLoaderGui?.gModUtils?.version || '2.x';
    ctx.fillText(`游戏版本: DoL ${dolVer}  |  ModLoader: ${mlVer}  |  生成时间: ${nowStr}`, padding + 16, padding + 54);

    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = errCount > 0 ? '#ff5555' : '#888';
    ctx.fillText(`错误总数: ${errCount}`, padding + 16, padding + 80);
    ctx.fillStyle = warnCount > 0 ? '#ffd700' : '#888';
    ctx.fillText(`警告总数: ${warnCount}`, padding + 150, padding + 80);
    ctx.fillStyle = '#66bb6a';
    ctx.fillText(`当前截取: ${preparedRows.length} 条 (${activeFilter === 'error' ? '仅错误' : (activeFilter === 'warn' ? '仅警告' : (activeFilter === 'issues' ? '错误与警告' : '全部日志'))})`, padding + 280, padding + 80);

    // 逐条绘制日志行
    let currentY = padding + headerHeight;
    ctx.font = '12px "Consolas", "Courier New", monospace';

    for (const item of preparedRows) {
        const rowX = padding;
        const rowY = currentY;
        const rowW = contentWidth;
        const rowH = item.rowHeight;

        let bgColor = '#181818';
        let borderColor = '#2a2a2a';
        let badgeBg = '#333';
        let badgeColor = '#aaa';
        let badgeText = '[信息]';

        if (item.level === 'error') {
            bgColor = '#2b1212';
            borderColor = '#7a1f1f';
            badgeBg = '#d32f2f';
            badgeColor = '#fff';
            badgeText = '[错误]';
        } else if (item.level === 'warn') {
            bgColor = '#2a2210';
            borderColor = '#7a651a';
            badgeBg = '#f57f17';
            badgeColor = '#000';
            badgeText = '[警告]';
        }

        ctx.fillStyle = bgColor;
        ctx.fillRect(rowX, rowY, rowW, rowH);
        ctx.strokeStyle = borderColor;
        ctx.strokeRect(rowX + 0.5, rowY + 0.5, rowW - 1, rowH - 1);

        ctx.fillStyle = '#777';
        ctx.font = '11px "Consolas", "Courier New", monospace';
        ctx.fillText(item.time || '', rowX + 8, rowY + 18);

        ctx.fillStyle = badgeBg;
        ctx.fillRect(rowX + 72, rowY + 5, 42, 18);
        ctx.fillStyle = badgeColor;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(badgeText, rowX + 76, rowY + 18);

        ctx.font = '12px "Consolas", "Courier New", monospace';
        ctx.fillStyle = item.level === 'error' ? '#ffcccc' : (item.level === 'warn' ? '#fff3cd' : '#dddddd');
        let textY = rowY + 18;
        for (const line of item.msgLines) {
            ctx.fillText(line, rowX + 126, textY);
            textY += lineHeight;
        }

        currentY += rowH + rowSpacing;
    }

    if (isTruncated) {
        ctx.fillStyle = '#888';
        ctx.font = 'italic 12px sans-serif';
        ctx.fillText(`(因篇幅限制已省略后续日志，可在游戏内通过级别筛选查看其余项)`, padding + 16, currentY + 18);
        currentY += 32;
    }

    ctx.fillStyle = '#555';
    ctx.font = '11px sans-serif';
    ctx.fillText('由 ModHub 模组自动生成 · 支持直接在贴吧 / 交流群 Ctrl+V 粘贴', padding + 16, totalHeight - 14);

    if (typeof canvas.toBlob !== 'function') {
        window.dolOptShowToast('当前浏览器不支持导出图片 Blob', 'warning');
        return;
    }

    const triggerFileDownload = blob => {
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const pad = n => String(n).padStart(2, '0');
            const d = new Date();
            const dateTag = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            a.download = `DoL-Log-Report-${dateTag}.png`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 1000);
        } catch (_) {}
    };

    const isTouchDevice = typeof window !== 'undefined' && (
        'ontouchstart' in window ||
        (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
        (window.innerWidth && window.innerWidth <= 768)
    );

    canvas.toBlob(async blob => {
        if (!blob) {
            window.dolOptShowToast('生成图片数据失败', 'warning');
            return;
        }

        let clipboardSuccess = false;
        try {
            if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                const item = new ClipboardItem({ 'image/png': blob });
                await navigator.clipboard.write([item]);
                clipboardSuccess = true;
            }
        } catch (_) {}

        // 桌面端环境：优先剪贴板并触发文件下载
        if (!isTouchDevice) {
            triggerFileDownload(blob);
            if (clipboardSuccess) {
                window.dolOptShowToast('诊断长图已保存并复制到剪贴板', 'success', 2500);
            } else {
                window.dolOptShowToast('诊断长图已保存为图片文件', 'success', 2500);
            }
            return;
        }

        // 移动端环境：由于移动浏览器普遍禁止非直接手势异步下载或写入图片剪贴板，弹出可长按保存的原生暗黑模态预览
        triggerFileDownload(blob);

        let dataUrl = '';
        try {
            dataUrl = canvas.toDataURL ? canvas.toDataURL('image/png') : URL.createObjectURL(blob);
        } catch (_) {
            dataUrl = URL.createObjectURL(blob);
        }

        const previewHtml = `
            <div class="dol-opt-screenshot-preview">
                <div class="dol-opt-screenshot-tip gold">移动端请【长按下方图片】选择【保存图片】至相册分享</div>
                <div class="dol-opt-screenshot-box">
                    <img src="${dataUrl}" class="dol-opt-screenshot-img" alt="诊断长图" />
                </div>
            </div>
        `;

        if (typeof window.dolOptConfirm === 'function') {
            const confirmed = await window.dolOptConfirm({
                title: '诊断长图生成完毕',
                message: '移动端请长按下方预览图片并选择【保存图片】到相册：',
                trustedMessageHtml: previewHtml,
                confirmText: '尝试直接下载',
                cancelText: '关闭预览',
                confirmType: 'primary'
            });
            if (confirmed) {
                triggerFileDownload(blob);
            }
        } else {
            window.dolOptShowToast('诊断长图已生成，请长按保存', 'success', 2500);
        }
    }, 'image/png');
};

window.dolOptCopyLoadLog = async function() {
    const log = document.getElementById('dolOptLogContent');
    const text = (log?.innerText || log?.textContent || '').trim();
    if (!text) {
        window.dolOptShowToast('暂无可复制的加载日志', 'warning');
        return;
    }

    let copied = false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
    } catch (_) {}

    if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        textarea.remove();
    }

    window.dolOptShowToast(copied ? '加载日志已复制' : '复制日志失败，请手动选择日志文本', copied ? 'success' : 'warning');
};

// 启动自检测机制（支持多阶段延时轮询与事件监听兜底）
window.dolOptInitStartupErrorCheck = function() {
    if (window._dolOptStartupCheckInitialized) return;
    window._dolOptStartupCheckInitialized = true;

    const tryCheck = () => {
        if (window._dolOptErrorDialogShown) return true;
        if (typeof window.dolOptCheckAndAutoOpenErrorLog === 'function') {
            return window.dolOptCheckAndAutoOpenErrorLog();
        }
        return false;
    };

    // 1. 多阶段延时自检（在通道就绪后安全消费；若超过 45 秒仍未就绪且有严重错误，兜底强行呼出以便排查）
    [500, 1500, 3000, 6000, 10000, 15000, 25000, 45000].forEach(delay => {
        setTimeout(() => {
            if (!window._dolOptErrorDialogShown) {
                if (delay >= 45000 && window._dolOptPendingAutoOpenErrorLog) {
                    window._dolOptForceStartupErrorOpen = true;
                }
                tryCheck();
            }
        }, delay);
    });

    // 2. SugarCube 事件监听权威就绪点：在故事就绪与通道展示时检查并消费 pending 状态
    if (typeof $ !== 'undefined' && $(document) && typeof $(document).on === 'function') {
        const onPassageOrReady = () => {
            if (window._dolOptErrorDialogShown) return;
            setTimeout(() => {
                if (!window._dolOptErrorDialogShown) {
                    tryCheck();
                }
            }, 100);
        };

        $(document).on(':storyready', onPassageOrReady);
        $(document).on(':passagedisplay', onPassageOrReady);
    }
};

// 脚本载入时自动挂载启动检测
try {
    window.dolOptInitStartupErrorCheck();
} catch (_) {}
