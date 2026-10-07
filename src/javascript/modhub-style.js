// 从本次加载的 ModHub 保留完整样式，仅在合并样式缺失时恢复。
(function() {
    const MODHUB_STYLE_MARKERS = ['--modhub-base-styles', '--modhub-market-styles', '--modhub-overrides-styles'];
    let snapshot = null;
    let sourceError = null;
    let warned = false;
    let utils;

    try {
        utils = window.modUtils || window.modSC2DataManager?.getModUtils?.();
        const loader = utils?.getModLoader?.() || window.modSC2DataManager?.getModLoader?.();
        const direct = utils?.getAnyModByNameNoAlias?.('ModHub') || utils?.getMod?.('ModHub');
        const entries = loader?.getModReadCache?.()?.get_Array?.() || loader?.getModCacheArray?.() || [];
        const candidates = [direct, ...Array.from(entries).filter(item => item?.name === 'ModHub')
            .map(item => item.mod || item.zip?.getModInfo?.() || item.zip?.modInfo)];
        const mod = candidates.find(item => item?.name === 'ModHub' && item.bootJson?.name === 'ModHub');
        if (!mod) throw new Error('未找到本次加载的 ModHub 精确档案');
        const files = mod.bootJson.styleFileList;
        if (!Array.isArray(files) || files.length !== MODHUB_STYLE_MARKERS.length || new Set(files).size !== files.length) {
            throw new Error('ModHub 样式清单不完整或包含重复条目');
        }
        const items = mod.cache?.styleFileItems?.items;
        const contents = files.map(name => {
            const item = items?.find(entry => entry.name === name);
            if (typeof item?.content !== 'string' || !item.content.trim()) throw new Error(`ModHub 样式缓存缺失：${name}`);
            return item.content;
        });
        const content = contents.join('\n');
        if (!hasMarkers(content)) throw new Error('ModHub 样式缓存缺少完整的样式标记');
        snapshot = content;
    } catch (error) {
        sourceError = error;
    }

    function hasMarkers(content) {
        return MODHUB_STYLE_MARKERS.every(marker => new RegExp(`${marker}\\s*:\\s*1\\s*;`).test(content));
    }

    function activeStyles() {
        if (typeof window.getComputedStyle !== 'function' || !document.documentElement) return false;
        const style = window.getComputedStyle(document.documentElement);
        return MODHUB_STYLE_MARKERS.every(marker => style.getPropertyValue(marker).trim() === '1');
    }

    function warn(error) {
        if (warned) return;
        warned = true;
        console.warn('[ModHub] 无法恢复界面样式：', error);
    }

    window.modHubEnsureStyles = function({ active = false } = {}) {
        try {
            let style = document.getElementById('modHubStylesFallback');
            if (active) {
                // SugarCube 后生成的残余样式不能反盖已恢复的完整层叠顺序。
                if (style?.tagName === 'STYLE' && document.head && document.head.lastChild !== style) {
                    document.head.appendChild(style);
                }
                if (typeof window.getComputedStyle !== 'function') return false;
                if (activeStyles()) return true;
            } else {
                const content = Array.from(document.querySelectorAll?.('tw-storydata style') || [])
                    .map(node => node.textContent || '').join('\n');
                if (hasMarkers(content)) return true;
            }
            if (snapshot === null) {
                warn(sourceError || new Error('ModHub 样式快照不可用'));
                return false;
            }
            if (!document.head || typeof document.createElement !== 'function') return false;
            if (style && style.tagName !== 'STYLE') throw new Error('样式恢复节点标识已被其他元素占用');
            if (!style) {
                style = document.createElement('style');
                style.id = 'modHubStylesFallback';
                style.textContent = snapshot;
                document.head.appendChild(style);
            } else if (style.textContent !== snapshot) {
                style.textContent = snapshot;
            }
            style.type = 'text/css';
            style.media = '';
            style.disabled = false;
            if (active && !activeStyles()) {
                warn(new Error('已恢复完整样式，但页面尚未应用 ModHub 样式标记'));
                return false;
            }
            return true;
        } catch (error) {
            warn(error);
            return false;
        }
    };

    try {
        const controller = window.modModLoadController || utils?.getModLoadController?.()
            || window.modSC2DataManager?.getModLoadController?.();
        controller?.addLifeTimeCircleHook?.('modHubStyles', {
            ModLoaderLoadEnd: () => window.modHubEnsureStyles({ active: false }),
        });
        window.jQuery?.(document).one?.(':storyready.modHubStyles', () => window.modHubEnsureStyles({ active: true }));
    } catch (error) {
        console.warn('[ModHub] 样式兼容检查注册失败：', error);
    }
})();
