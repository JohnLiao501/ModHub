/**
 * ModHub - 公共提示与原生暗黑模态框。
 * 在早期注入阶段提供转义与弹窗接口；弹窗栈仅在本文件中维护。
 */

window.modHubEscapeHtml = function(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
};

// 统一 Toast 提示
window.modHubShowToast = function(message, type = '', duration = 2500) {
    let toast = document.getElementById('modHubToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'modHubToast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast ' + type + ' show';
    if (window._modHubToastTimer) clearTimeout(window._modHubToastTimer);
    window._modHubToastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, Math.max(1000, duration || 2500));
};

/**
 * 游戏原生暗黑风格确认模态框（替代浏览器原生突兀白底 confirm）
 * @param {Object|string} options 参数对象或提示文字
 * @returns {Promise<boolean>}
 */
// 活动模态弹窗栈，支持多层弹窗平滑嵌套与层级递增，彻底杜绝子弹窗破坏父弹窗 DOM
const modHubModalStack = [];

window.modHubConfirm = function(options) {
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
    let confirmDelay = 0;

    let customResult = null;
    let onRender = null;
    let validateConfirm = null;

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
        if (Number(options.confirmDelay) > 0) confirmDelay = Math.ceil(Number(options.confirmDelay));
        if (typeof options.customResult === 'function') customResult = options.customResult;
        if (typeof options.onRender === 'function') onRender = options.onRender;
        if (typeof options.canConfirm === 'function') validateConfirm = options.canConfirm;
    }

    // 针对非 DOM / Node 单元测试环境的安全回退
    if (typeof document === 'undefined' || !document.createElement || !document.body) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const stackLevel = modHubModalStack.length;
        const overlay = document.createElement('div');
        overlay.id = stackLevel === 0 ? 'modHubConfirmOverlay' : `modHubConfirmOverlay_${stackLevel}`;
        overlay.className = 'modhub-modal-backdrop';
        overlay.style.zIndex = String(100000 + stackLevel * 20);

        const dialog = document.createElement('div');
        dialog.className = `modhub-modal-dialog${dialogClass ? ` ${dialogClass}` : ''}`;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const messageHtml = trustedMessageHtml || window.modHubEscapeHtml(message).replace(/\n/g, '<br>');
        const selectHtml = selectOptions.length ? `
            <label class="modhub-modal-select-wrap">
                <span>${window.modHubEscapeHtml(selectLabel)}</span>
                <select class="modhub-modal-select">
                    ${selectOptions.map(option => `<option value="${window.modHubEscapeHtml(option.value)}" ${String(option.value) === selectValue ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${window.modHubEscapeHtml(option.label)}</option>`).join('')}
                </select>
            </label>
        ` : '';

        const initialConfirmBtnText = confirmDelay > 0
            ? `${confirmText} (${confirmDelay}s)`
            : confirmText;

        dialog.innerHTML = `
            <div class="modhub-modal-header">
                <span class="${isDanger ? 'red' : 'gold'} modhub-modal-title">${window.modHubEscapeHtml(title)}</span>
                <button type="button" class="modhub-modal-close" aria-label="关闭">&times;</button>
            </div>
            <div class="modhub-modal-body">
                <div class="modhub-modal-message">${messageHtml}</div>
                ${selectHtml}
            </div>
            <div class="modhub-modal-footer">
                <button type="button" class="macro-button ${isDanger ? 'modhub-btn-danger' : 'modhub-btn-primary'} modhub-modal-btn-confirm"${confirmDelay > 0 ? ' disabled' : ''}>${window.modHubEscapeHtml(initialConfirmBtnText)}</button>
                ${cancelText ? `<button type="button" class="macro-button modhub-modal-btn-cancel">${window.modHubEscapeHtml(cancelText)}</button>` : ''}
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        let delayTimer = null;
        let isDelaying = confirmDelay > 0;
        let remainingSeconds = confirmDelay;

        const confirmBtn = dialog.querySelector('.modhub-modal-btn-confirm');
        const select = dialog.querySelector('.modhub-modal-select');

        const canConfirm = () => {
            if (isDelaying) return false;
            if (requireSelection && !select?.value) return false;
            if (validateConfirm && !validateConfirm(dialog)) return false;
            return true;
        };

        const syncConfirmState = () => {
            if (confirmBtn) {
                if (isDelaying) {
                    confirmBtn.disabled = true;
                } else {
                    confirmBtn.disabled = !canConfirm();
                }
            }
        };
        dialog.modHubSyncConfirmState = syncConfirmState;

        if (confirmDelay > 0) {
            delayTimer = setInterval(() => {
                remainingSeconds--;
                if (remainingSeconds <= 0) {
                    clearInterval(delayTimer);
                    delayTimer = null;
                    isDelaying = false;
                    if (confirmBtn) {
                        confirmBtn.textContent = confirmText;
                        syncConfirmState();
                    }
                } else if (confirmBtn) {
                    confirmBtn.textContent = `${confirmText} (${remainingSeconds}s)`;
                }
            }, 1000);
        }

        dialog.modHubClearDelay = () => {
            if (delayTimer) {
                clearInterval(delayTimer);
                delayTimer = null;
            }
            isDelaying = false;
            syncConfirmState();
        };

        if (typeof onRender === 'function') {
            try {
                onRender(dialog);
            } catch (err) {
                console.warn('[modHubConfirm] onRender 执行异常:', err);
            }
        }

        let resolved = false;

        const getConfirmResult = () => {
            if (typeof customResult === 'function') {
                return customResult(dialog);
            }
            return selectOptions.length ? select?.value : true;
        };

        const closeWith = (result) => {
            if (resolved) return;
            resolved = true;
            if (delayTimer) {
                clearInterval(delayTimer);
                delayTimer = null;
            }
            const stackIdx = modHubModalStack.indexOf(modalEntry);
            if (stackIdx !== -1) {
                modHubModalStack.splice(stackIdx, 1);
            }

            if (typeof document.removeEventListener === 'function') {
                document.removeEventListener('keydown', handleKeydown);
            }
            overlay.classList.add('modhub-modal-closing');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 180);
            resolve(result);
        };

        const handleKeydown = (e) => {
            // 仅有栈顶活动模态框响应按键
            if (modHubModalStack[modHubModalStack.length - 1] !== modalEntry) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                closeWith(false);
            } else if (e.key === 'Enter') {
                if (e.defaultPrevented || (e.target?.closest?.('button, a, input, select, textarea, summary, [contenteditable="true"]')
                    && e.target.closest('.modhub-modal-dialog') === dialog)) return;
                e.preventDefault();
                if (canConfirm()) closeWith(getConfirmResult());
            }
        };

        const modalEntry = {
            overlay,
            dialog,
            closeWith
        };
        modHubModalStack.push(modalEntry);

        if (typeof document.addEventListener === 'function') {
            document.addEventListener('keydown', handleKeydown);
        }

        dialog.querySelector('.modhub-modal-close')?.addEventListener('click', () => closeWith(false));
        dialog.querySelector('.modhub-modal-btn-cancel')?.addEventListener('click', () => closeWith(false));
        confirmBtn?.addEventListener('click', () => {
            if (canConfirm()) closeWith(getConfirmResult());
        });
        select?.addEventListener('change', syncConfirmState);
        syncConfirmState();

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeWith(false);
            }
        });

        if (confirmBtn && !confirmBtn.disabled && !isDelaying && typeof confirmBtn.focus === 'function') {
            confirmBtn.focus();
        } else {
            const cancelBtn = dialog.querySelector('.modhub-modal-btn-cancel');
            if (cancelBtn && typeof cancelBtn.focus === 'function') {
                cancelBtn.focus();
            }
        }
    });
};

// 游戏原生暗黑风格提示框（替代浏览器原生 alert）
window.modHubAlert = function(message, title = '提示') {
    return window.modHubConfirm({
        title,
        message,
        confirmText: '确定',
        cancelText: ''
    });
};
