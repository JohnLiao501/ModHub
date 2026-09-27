/**
 * ModHub - 长按移动、触摸拖拽与边缘自动滚动。
 * 通过 modhub-manager.js 的共享接口执行重排与保存；绑定时才注册事件。
 */

// 通用按钮长按判定绑定函数（支持桌面端鼠标长按与移动端触摸长按，支持长按置顶/置底与防误触）
window.modHubBindLongPressMove = function(btnElement, onShortPress, onLongPress) {
    if (!btnElement || typeof btnElement.addEventListener !== 'function') return;

    let timer = null;
    let isLongPress = false;
    let isPressed = false;
    let startX = 0;
    let startY = 0;

    // 确保全局挂载一次事件拦截钩子，在长按触发后拦截紧随其后的任何 mouseup/click/touchend 穿透
    if (typeof window !== 'undefined' && !window._modHubLongPressGlobalHooked && typeof window.addEventListener === 'function') {
        window._modHubLongPressGlobalHooked = true;
        const suppressTrailingPointerEvent = (e) => {
            const isRecentLongPress = window._modHubLongPressActive || (window._modHubLastLongPressTimestamp && (Date.now() - window._modHubLastLongPressTimestamp < 600));
            if (isRecentLongPress) {
                // 仅拦截移动类按钮触发的残留指针弹起/点击
                if (e.target && typeof e.target.closest === 'function' && e.target.closest('.modhub-btn-move')) {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    if (typeof e.stopPropagation === 'function') e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                }
            }
        };
        window.addEventListener('mouseup', (e) => {
            suppressTrailingPointerEvent(e);
            if (window._modHubLongPressActive) {
                setTimeout(() => {
                    window._modHubLongPressActive = false;
                }, 60);
            }
        }, true);
        window.addEventListener('click', (e) => {
            suppressTrailingPointerEvent(e);
        }, true);
        window.addEventListener('touchend', (e) => {
            suppressTrailingPointerEvent(e);
            if (window._modHubLongPressActive) {
                setTimeout(() => {
                    window._modHubLongPressActive = false;
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
                window._modHubLongPressActive = true;
                window._modHubLastLongPressTimestamp = Date.now();
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

        const isRecentLongPress = (typeof window !== 'undefined' && (window._modHubLongPressActive || (window._modHubLastLongPressTimestamp && (Date.now() - window._modHubLastLongPressTimestamp < 600))));
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

        const isRecentLongPress = (typeof window !== 'undefined' && (window._modHubLongPressActive || (window._modHubLastLongPressTimestamp && (Date.now() - window._modHubLastLongPressTimestamp < 600))));
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
window.modHubBindAllMoveButtons = function(container) {
    if (!container) return;

    container.querySelectorAll('.modhub-side-move-up').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.modHubBindLongPressMove(
            btn,
            () => window.modHubMoveSideMod(index, -1),
            () => window.modHubMoveSideMod(index, 'top')
        );
    });
    container.querySelectorAll('.modhub-side-move-down').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.modHubBindLongPressMove(
            btn,
            () => window.modHubMoveSideMod(index, 1),
            () => window.modHubMoveSideMod(index, 'bottom')
        );
    });

    container.querySelectorAll('.modhub-beauty-move-up').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.modHubBindLongPressMove(
            btn,
            () => window.modHubMoveBeauty(index, -1),
            () => window.modHubMoveBeauty(index, 'top')
        );
    });
    container.querySelectorAll('.modhub-beauty-move-down').forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        window.modHubBindLongPressMove(
            btn,
            () => window.modHubMoveBeauty(index, 1),
            () => window.modHubMoveBeauty(index, 'bottom')
        );
    });
};

// 统一拖拽排序绑定函数（同时支持桌面端 HTML5 Drag & 移动端 Touch，内置视口边缘自动滚动）
window.modHubBindDragSort = function(ulElement, listType) {
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
        ulElement.querySelectorAll('.modhub-item').forEach(el => {
            el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging', 'touch-dragging');
        });
    };

    // 1. 桌面端 HTML5 Drag & Drop
    ulElement.addEventListener('dragstart', (e) => {
        const item = e.target.closest('li.modhub-item[draggable="true"]');
        if (!item || e.target.closest('.modhub-btn-group, button, input')) {
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

        const item = e.target.closest('li.modhub-item[draggable="true"]');
        if (!item) return;

        const targetIndex = parseInt(item.dataset.index, 10);
        if (targetIndex === dragSrcIndex) {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
            return;
        }

        const rect = item.getBoundingClientRect();
        const isBottom = (e.clientY - rect.top) > (rect.height / 2);

        ulElement.querySelectorAll('.modhub-item').forEach(el => {
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
        const item = e.target.closest('li.modhub-item');
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
                await window.modHubReorderList(listType, dragSrcIndex, targetIndex, isAfterTarget);
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

    // 2. 移动端触摸手柄拖拽支持 (Touch Events on .modhub-drag-handle)
    let touchItem = null;
    let touchStartY = 0;
    let isTouchDragging = false;

    ulElement.querySelectorAll('.modhub-drag-handle').forEach(handle => {
        handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const item = handle.closest('li.modhub-item[draggable="true"]');
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
                const targetLi = hoveredEl ? hoveredEl.closest('li.modhub-item[draggable="true"]') : null;

                ulElement.querySelectorAll('.modhub-item').forEach(el => {
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
                    await window.modHubReorderList(listType, dragSrcIndex, targetIndex, isAfterTarget);
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
