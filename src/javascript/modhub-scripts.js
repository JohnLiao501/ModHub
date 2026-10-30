// 让 SugarCube 分别执行本包模块，避免其他合并脚本的异常阻断全部管理入口。
(function() {
    if (typeof window.modHubIsolateScripts === 'function') return;
    let isolated = false;
    let attempted = false;

    window.modHubIsolateScripts = function() {
        if (attempted) return isolated;
        attempted = true;
        try {
            if (typeof window.modHubGetGui === 'function' || typeof window.initModReadMe === 'function') {
                throw new Error('ModHub 普通模块已经执行，已停止重排脚本节点');
            }
            const utils = window.modUtils || window.modSC2DataManager?.getModUtils?.();
            const loader = utils?.getModLoader?.() || window.modSC2DataManager?.getModLoader?.();
            const active = loader?.getModCacheArray?.();
            if (!Array.isArray(active)) throw new Error('加载器未提供当前启用模组档案');
            const candidates = active.filter(item => item?.mod?.name === 'ModHub');
            // 已禁用或移除的 ModHub 不得通过残余档案重新加载。
            if (!candidates.length) return false;
            if (candidates.length !== 1) throw new Error('当前启用列表包含重复的 ModHub 档案');
            const mod = candidates[0].mod;
            const files = mod.bootJson?.scriptFileList;
            const items = mod.cache?.scriptFileItems?.items;
            if (mod.bootJson?.name !== 'ModHub' || !Array.isArray(files) || !files.length ||
                new Set(files).size !== files.length || !Array.isArray(items) || items.length !== files.length ||
                files.some(name => typeof name !== 'string' || mod.bootJson.scriptFileList_inject_early?.includes(name))) {
                throw new Error('ModHub 普通脚本清单不完整或与早期脚本重叠');
            }
            const sources = new Map(files.map(name => {
                const matches = items.filter(item => item.name === name);
                if (matches.length !== 1 || typeof matches[0].content !== 'string' || !matches[0].content.trim()) {
                    throw new Error(`ModHub 普通脚本缓存缺失或重复：${name}`);
                }
                return [name, matches[0].content];
            }));
            const root = document.querySelector('tw-storydata');
            if (!root) throw new Error('游戏脚本容器尚未就绪');
            const found = new Set();
            const changes = [];
            for (const node of Array.from(root.querySelectorAll('script'))) {
                if (node.parentNode !== root) continue;
                const original = node.textContent || '';
                const markers = [...original.matchAll(/\/\* twine-user-script #\d+: "([^'"\r\n]+)" \*\//g)];
                let retained = original.slice(0, markers[0]?.index ?? original.length);
                let changed = false;
                for (let index = 0; index < markers.length; index++) {
                    const marker = markers[index];
                    const block = original.slice(marker.index, markers[index + 1]?.index ?? original.length);
                    const name = marker[1];
                    if (!sources.has(name)) { retained += block; continue; }
                    const content = block.slice(marker[0].length);
                    const source = sources.get(name);
                    // 加载器重建节点时可能追加换行，源码本身仍须逐字一致。
                    if (found.has(name) || !content.startsWith(source) || !/^(?:\r?\n)*$/.test(content.slice(source.length))) {
                        throw new Error(`ModHub 合并脚本与本次包体缓存不一致：${name}`);
                    }
                    if (node.getAttribute('type') !== 'text/twine-javascript' || node.getAttribute('role') !== 'script') {
                        throw new Error('ModHub 合并脚本节点类型不受支持');
                    }
                    found.add(name);
                    changed = true;
                }
                if (changed) changes.push({ node, original, retained });
            }
            if (found.size !== files.length) throw new Error('ModHub 合并脚本不完整，已保留原始节点');
            const nodes = files.map(name => {
                const node = document.createElement('script');
                node.setAttribute('type', 'text/twine-javascript');
                node.setAttribute('role', 'script');
                node.setAttribute('data-modhub-script', name);
                node.textContent = sources.get(name);
                return node;
            });
            try {
                // 第三方内容仍在同一作用域内，本包只执行一次并保持原有模块顺序。
                for (const change of changes) change.node.textContent = change.retained;
                for (const node of nodes) root.appendChild(node);
            } catch (error) {
                for (const node of nodes) node.remove();
                for (const change of changes) change.node.textContent = change.original;
                throw error;
            }
            isolated = true;
            return true;
        } catch (error) {
            console.warn('[ModHub] 普通脚本隔离未完成，已保留原始加载方式：', error);
            return false;
        }
    };

    try {
        const utils = window.modUtils || window.modSC2DataManager?.getModUtils?.();
        const controller = window.modModLoadController || utils?.getModLoadController?.() ||
            window.modSC2DataManager?.getModLoadController?.();
        if (typeof controller?.addLifeTimeCircleHook !== 'function') throw new Error('加载器未提供脚本隔离所需的启动回调');
        controller.addLifeTimeCircleHook('modHubScripts', { ModLoaderLoadEnd: () => window.modHubIsolateScripts() });
    } catch (error) {
        console.warn('[ModHub] 普通脚本隔离检查注册失败：', error);
    }
})();
