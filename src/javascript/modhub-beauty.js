/* =========================================================================
 * 美化包管理器模块 (BeautySelector Addon)
 * ========================================================================= */

// 自动启用已启用旁加载模组美化的配置（默认开启）
window.modHubIsAutoBeautyEnabled = function() {
    try {
        if (typeof localStorage === 'undefined') return true;
        const val = localStorage.getItem('modhub_auto_enable_sideload_beauty') ?? localStorage.getItem('dol_opt_auto_enable_sideload_beauty');
        return val === null ? true : val === 'true';
    } catch (_) {
        return true;
    }
};

window.modHubSetAutoBeautyEnabled = function(val) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('modhub_auto_enable_sideload_beauty', val ? 'true' : 'false');
        }
    } catch (_) {}
};

window.modHubToggleAutoBeautySetting = async function(checked) {
    return window.modHubRunManagerAction(async () => {
        window.modHubSetAutoBeautyEnabled(checked);
        window.modHubShowToast(checked ? '已开启【自动启用旁加载模组美化】' : '已关闭【自动启用旁加载模组美化】', 'info');
        await window.modHubLoadBeautyState();

    });
};

window.modHubLoadBeautyState = async function(syncAuto = true) {
    const bAddon = window.addonBeautySelectorAddon;
    if (!bAddon || typeof bAddon.getTypeOrder !== 'function') {
        window._modHubBeautyLoaded = true;
        window._modHubBeautyState = null;
        return false;
    }

    try {
        const allList = [...bAddon.getTypeOrder()];
        let usedList = Array.isArray(bAddon.typeOrderUsed) ? [...bAddon.typeOrderUsed] : [];
        let usedTypeSet = new Set(usedList.map(item => item.type));
        let disabledList = allList.filter(item => !usedTypeSet.has(item.type));

        const autoBeautyEnabled = window.modHubIsAutoBeautyEnabled();
        let beautyChanged = false;

        // 获取当前已启用的旁加载模组名集合
        const enabledSideMods = new Set();
        const gui = window.modHubGetGui();
        if (window._modHubModState && Array.isArray(window._modHubModState.sideEnabled)) {
            window._modHubModState.sideEnabled.forEach(m => {
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

        window._modHubBeautyState = {
            enabledList: usedList,
            disabledList: disabledList,
            allMap: allMap
        };

        if (beautyChanged && !await window.modHubSaveBeautyState(false)) throw new Error('美化自动启用保存失败');
        window._modHubBeautyLoaded = true;
        return true;
    } catch (e) {
        if (window._modHubManagerBusy && syncAuto) throw e;
        console.error('[ModHub] 初始化美化管理失败', e);
        window._modHubBeautyState = null;
        return false;
    }
};

window.modHubRenderBeautyUI = function() {
    const container = document.getElementById('modHubBeautyContainer');
    if (!container) return;
    if (!window._modHubBeautyState) {
        container.innerHTML = '<div class="mod-empty grey">未检测到 BeautySelectorAddon，暂时无法管理美化图像包。</div>';
        return;
    }

    const { enabledList, disabledList } = window._modHubBeautyState;
    const autoBeautyEnabled = window.modHubIsAutoBeautyEnabled();

    let html = `
        <div class="childItem modhub-section modhub-beauty-auto-box">
            <label class="modhub-checkbox-label">
                <input type="checkbox" id="toggleAutoBeauty" class="macro-checkbox" ${autoBeautyEnabled ? 'checked' : ''} onchange="window.modHubToggleAutoBeautySetting(this.checked)" />
                自动启用已启用旁加载模组的美化 <span class="gold">(推荐)</span>
            </label>
            <div class="grey modhub-subdesc">默认开启。开启后已启用的旁加载模组美化将自动保持激活且无法手动停用，避免漏开或重装模组后图像缺失。</div>
        </div>
        <div class="childItem grey modhub-hint-bar">
            提示：上方图像覆盖优先级高于下方。智能排序会将依赖方放在基础包之前，无关项保持原序。
        </div>
    `;

    // 已启用列表
    html += `
        <div class="modhub-group-header">
            <span class="gold">已启用的美化图像包 (${enabledList.length}) - 覆盖优先级从高到低</span>
        </div>
    `;

    if (enabledList.length === 0) {
        html += '<div class="mod-empty grey">当前未启用任何美化包。</div>';
    } else {
        html += '<ul class="modhub-list">';
        enabledList.forEach((item, index) => {
            const modName = item.modRef?.name || '未知模组';
            const isAuto = autoBeautyEnabled && item.isAutoManaged;
            html += `
                <li class="modhub-item" data-index="${index}" data-drag-type="beauty" data-beauty-type="${window.modHubEscapeHtml(item.type)}" draggable="true">
                    <div class="modhub-item-info">
                        <span class="modhub-drag-handle grey" title="按住拖拽调整覆盖优先级" aria-label="拖拽手柄">⋮⋮</span>
                        <span class="gold modhub-order-tag">#${index + 1}</span>
                        <span class="green modhub-status-tag">[已启用]</span>
                        ${isAuto ? '<span class="gold modhub-status-tag modhub-tag-auto" title="已跟随旁加载模组自动保持启用">[自动启用]</span>' : ''}
                        <div class="modhub-item-main">
                            <div class="modhub-item-title">${window.modHubEscapeHtml(item.type)}</div>
                            <div class="grey modhub-item-desc">来自模组：[${window.modHubEscapeHtml(modName)}]</div>
                        </div>
                    </div>
                    <div class="modhub-btn-group">
                        <button class="macro-button modhub-btn-move modhub-beauty-move-up" data-index="${index}" title="上移一位（长按直接置顶）" aria-label="上移或置顶">▲</button>
                        <button class="macro-button modhub-btn-move modhub-beauty-move-down" data-index="${index}" title="下移一位（长按直接置底）" aria-label="下移或置底">▼</button>
                        ${isAuto ?
                            '<button class="macro-button modhub-btn-toggle btn-auto-disabled" disabled title="已跟随旁加载模组自动启用，无法手动调整">已自动启用</button>' :
                            `<button class="macro-button modhub-btn-toggle" data-beauty-enabled="false" title="禁用该美化包">禁用</button>`
                        }
                    </div>
                </li>
            `;
        });
        html += '</ul>';
    }

    // 已禁用列表
    html += `
        <div class="modhub-group-header" style="margin-top: 18px;">
            <span class="grey">已禁用的美化图像包 (${disabledList.length})</span>
        </div>
    `;

    if (disabledList.length === 0) {
        html += '<div class="mod-empty grey">没有被禁用的美化包。</div>';
    } else {
        html += '<ul class="modhub-list">';
        disabledList.forEach(item => {
            const modName = item.modRef?.name || '未知模组';
            html += `
                <li class="modhub-item item-disabled" data-beauty-type="${window.modHubEscapeHtml(item.type)}">
                    <div class="modhub-item-info">
                        <span class="grey modhub-status-tag">[已停用]</span>
                        <div class="modhub-item-main">
                            <div class="modhub-item-title grey">${window.modHubEscapeHtml(item.type)}</div>
                            <div class="grey modhub-item-desc">来自模组：[${window.modHubEscapeHtml(modName)}]</div>
                        </div>
                    </div>
                    <div class="modhub-btn-group">
                        <button class="macro-button modhub-btn-toggle btn-enable" data-beauty-enabled="true" title="启用该美化包">启用</button>
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
        if (button && beautyType) window.modHubToggleBeauty(beautyType, button.dataset.beautyEnabled === 'true');
    };

    const beautyUl = container.querySelector ? container.querySelector('ul.modhub-list') : null;
    if (beautyUl && typeof window.modHubBindDragSort === 'function') {
        window.modHubBindDragSort(beautyUl, 'beauty');
    }

    if (typeof window.modHubBindAllMoveButtons === 'function') {
        window.modHubBindAllMoveButtons(container);
    }
};

// 美化项排序移动（支持短按步进与长按置顶/置底）
window.modHubMoveBeauty = async function(index, deltaOrPosition) {
    return window.modHubRunManagerAction(async () => {
        const state = window._modHubBeautyState;
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

        if (!await window.modHubSaveBeautyState(false)) throw new Error('美化配置保存失败');


        const type = item.type;
        if (deltaOrPosition === 'top') {
            window.modHubShowToast(`已将美化包【${type}】置顶（最高覆盖优先级）`, 'success');
        } else if (deltaOrPosition === 'bottom') {
            window.modHubShowToast(`已将美化包【${type}】置底（最低覆盖优先级）`, 'success');
        }
    });
};

// 美化项启用/禁用
window.modHubToggleBeauty = async function(typeKey, enable) {
    return window.modHubRunManagerAction(async () => {
        const state = window._modHubBeautyState;
        if (!state) return false;

        const targetItem = state.allMap.get(typeKey);
        if (!targetItem) return false;

        if (!enable && window.modHubIsAutoBeautyEnabled() && targetItem.isAutoManaged) {
            window.modHubShowToast(`美化包【${typeKey}】已跟随旁加载模组自动启用，无需手动调整`, 'warning');
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

        if (!await window.modHubSaveBeautyState()) throw new Error('美化配置保存失败');

    });
};

// 保存美化排序与设置
window.modHubSaveBeautyState = async function(showSuccess = true) {
    const bAddon = window.addonBeautySelectorAddon;
    const state = window._modHubBeautyState;
    if (!bAddon || !state) return false;

    window.modHubRenderModManageUI();
    try {
        const typeOrder = state.enabledList.map(item => item.type);
        if (await bAddon.saveOrder(typeOrder) === false) throw new Error('美化配置保存失败');
        bAddon.typeOrderUsed = [...state.enabledList];
        if (showSuccess) window.modHubShowToast('美化包排序已保存（重新载入后完全生效）', 'success');
        return true;
    } catch (e) {
        if (window._modHubManagerBusy) throw e;
        console.error('[ModHub] 保存美化配置失败', e);
        window.modHubShowToast('保存美化配置失败: ' + e.message, 'warning');
        return false;
    }
};
