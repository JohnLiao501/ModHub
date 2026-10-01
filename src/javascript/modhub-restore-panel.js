/** ModHub 时间点还原面板：界面只调用恢复引擎，不复制包体或目标构建逻辑。 */
(function () {
    'use strict';
    if (window.modHubShowRestorePanel) return;
    let active = null;
    const description = '时间点还原会将游戏的模组状态还原到所选还原点。在该还原点之后所做的任何更改都将丢失，包括：模组安装、启用状态、加载顺序与美化配置。 还原不会影响ModHub和游戏存档。\n如果游戏因为模组加载遇到问题，甚至无法启动，可以选择一个还原点，然后将游戏还原到该状态。游戏将重启并恢复到捕获还原点时的状态。还原前会保存当前模组状态，方便需要时撤销此次还原。';
    const accents = new Map([['模组安装、启用状态、加载顺序与美化配置', 'gold'], ['游戏将重启', 'gold'], ['还原前会保存当前模组状态', 'gold'], ['任何更改都将丢失', 'red'], ['还原不会影响ModHub和游戏存档', 'green']]);

    function element(tag, text, className, id) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        if (id) node.id = id;
        return node;
    }

    function styles() {
        if (document.getElementById('modHubRestorePanelStyle')) return;
        const style = element('style', undefined, undefined, 'modHubRestorePanelStyle');
        style.textContent = '.modhub-restore-panel-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(2px);padding:16px 16px calc(60px + env(safe-area-inset-bottom));box-sizing:border-box;white-space:normal;pointer-events:auto}.modhub-restore-panel{width:100%;max-width:720px;max-height:calc(100dvh - 76px - env(safe-area-inset-bottom));display:flex;flex-direction:column;min-height:0;background:var(--850,#222);color:var(--100,#eee);border:1px solid var(--600,#666);box-shadow:0 10px 30px rgba(0,0,0,.85);font:16px/1.6 sans-serif;text-align:left;box-sizing:border-box;overflow:hidden}.modhub-restore-panel-header,.modhub-restore-panel-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;padding:12px 16px}.modhub-restore-panel-header{border-bottom:1px solid var(--600,#666);justify-content:space-between}.modhub-restore-panel-footer{border-top:1px solid var(--600,#666);justify-content:flex-end;padding-bottom:calc(12px + env(safe-area-inset-bottom))}.modhub-restore-panel-body{min-height:0;overflow:auto;padding:16px 16px calc(60px + env(safe-area-inset-bottom));overflow-wrap:anywhere}.modhub-restore-panel button{min-height:32px;flex-shrink:0;padding:6px 12px;color:var(--100,#eee);background:var(--800,#333);border:1px solid var(--600,#666);cursor:pointer}.modhub-restore-panel button:disabled{opacity:.5;cursor:default}.modhub-restore-panel .modhub-restore-primary{border-color:var(--gold,#d6b365)}.modhub-restore-panel .gold{color:var(--gold,#d6b365)}.modhub-restore-panel .red{color:var(--red,#ed7878)}.modhub-restore-panel .green{color:var(--green,#88bd86)}.modhub-restore-panel .grey{color:var(--400,#aaa)}.modhub-restore-panel p{margin:0 0 14px}.modhub-restore-panel-settings{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-top:1px solid var(--600,#666);padding-top:12px}.modhub-restore-panel input[type=text],.modhub-restore-panel select{min-width:0;max-width:100%;min-height:32px;background:var(--800,#333);color:var(--100,#eee);border:1px solid var(--600,#666);box-sizing:border-box;padding:6px}.modhub-restore-panel-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.modhub-restore-panel-manual{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.modhub-restore-panel-manual input{flex:1 1 240px}.modhub-restore-panel-points{display:flex;flex-direction:column;gap:8px}.modhub-restore-panel-point{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--600,#666);cursor:pointer}.modhub-restore-panel-point input{flex-shrink:0;margin-top:5px}.modhub-restore-panel-point span{min-width:0;flex:1}.modhub-restore-panel-point small{display:block}.modhub-restore-panel-status{margin:10px 0 0;min-height:1.6em}.modhub-restore-panel details{margin-bottom:14px}.modhub-restore-panel summary{cursor:pointer;min-height:32px}@media(max-width:768px){.modhub-restore-panel-settings{grid-template-columns:1fr}.modhub-restore-panel-footer button{flex:1 1 0;min-width:0}.modhub-restore-panel-manual button{flex:1 1 auto}.modhub-restore-panel-actions button{flex:1 1 auto}.modhub-restore-panel-body{padding-left:12px;padding-right:12px}}';
        document.head.appendChild(style);
    }

    function mount(overlay, startup) {
        document.body.appendChild(overlay);
        if (startup) window.modHubRestore.mountDialog?.(overlay.children[0], true);
    }

    function appendDescription(container) {
        description.split('\n').forEach((text, index) => {
            if (index) container.appendChild(document.createTextNode('\n'));
            const paragraph = element('p');
            const parts = text.split(/(模组安装、启用状态、加载顺序与美化配置|游戏将重启|还原前会保存当前模组状态|任何更改都将丢失|还原不会影响ModHub和游戏存档)/);
            for (const part of parts) paragraph.appendChild(element(accents.has(part) ? 'strong' : 'span', part, accents.get(part)));
            container.appendChild(paragraph);
        });
    }

    window.modHubShowRestorePanel = function (options = {}) {
        if (active) return active.promise;
        const api = window.modHubRestore;
        if (!api?.getPanelState) return Promise.resolve(window.modHubAlert?.('时间点还原引擎尚未就绪')).then(() => false);
        styles();
        const previousFocus = document.activeElement;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        active = { promise };
        const rescue = options.startup === true;
        let data = null, step = rescue ? 'points' : 'intro', selected = '', preview = null, dirty = false, working = false;
        const overlay = element('div', undefined, 'modhub-restore-panel-overlay', 'modHubRestorePanelOverlay');
        const dialog = element('section', undefined, 'modhub-restore-panel', 'modHubRestorePanel');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'modHubRestorePanelTitle');
        dialog.tabIndex = -1;
        const header = element('header', undefined, 'modhub-restore-panel-header');
        const title = element('strong', '时间点还原', 'gold', 'modHubRestorePanelTitle');
        const close = element('button', '关闭', undefined, 'modHubRestorePanelClose');
        const body = element('div', undefined, 'modhub-restore-panel-body', 'modHubRestorePanelBody');
        const footer = element('footer', undefined, 'modhub-restore-panel-footer');
        const back = element('button', '上一步', undefined, 'modHubRestorePanelBack');
        const next = element('button', '下一步', 'modhub-restore-primary', 'modHubRestorePanelNext');
        const cancel = element('button', rescue ? '继续等待或启动' : '取消', undefined, 'modHubRestorePanelCancel');
        header.appendChild(title); header.appendChild(close);
        footer.appendChild(back); footer.appendChild(next); footer.appendChild(cancel);
        dialog.appendChild(header); dialog.appendChild(body); dialog.appendChild(footer); overlay.appendChild(dialog);
        mount(overlay, rescue);
        let status;

        function message(text, error = false) {
            if (!status) return;
            status.textContent = text;
            status.className = `modhub-restore-panel-status ${error ? 'red' : 'grey'}`;
        }

        function sync() {
            body.inert = working;
            close.disabled = cancel.disabled = working;
            back.disabled = working || step === 'intro' || rescue && step === 'points';
            next.disabled = working || dirty || !data || (step === 'points' && !selected) || (step === 'preview' && !preview?.canRestore);
            next.textContent = step === 'preview' ? '开始还原' : '下一步';
        }

        async function task(action) {
            if (working) return;
            working = true; sync();
            try { return await action(); }
            catch (error) { message((error?.message || '操作未完成，请重试') + (api.isRestoring?.() ? '。恢复记录已保留，游戏加载保持暂停；重新打开游戏将继续恢复。' : ''), true); }
            finally { working = false; sync(); if (active) next.focus(); }
        }

        async function refresh() {
            data = await api.getPanelState();
            if (!data.points.some(point => point.id === selected)) selected = data.points.find(point => point.id === data.recommendedId)?.id || data.points.find(point => point.protected)?.id || data.points[0]?.id || '';
            dirty = false;
            render();
        }

        function finish(result) {
            document.removeEventListener('keydown', keyboard);
            document.removeEventListener('focusin', keepFocus);
            overlay.remove(); active = null;
            if (previousFocus?.isConnected) previousFocus.focus();
            resolve(result);
        }

        async function leave() {
            if (working) return;
            if (dirty) {
                const discard = await task(() => window.modHubConfirm({ title: '放弃未保存的设置', message: '还原设置尚未保存，是否放弃本次设置修改？', confirmText: '放弃修改并关闭', cancelText: '继续编辑' }));
                if (!discard) return;
            }
            finish(false);
        }

        function render() {
            body.textContent = '';
            title.textContent = step === 'preview' ? '确认还原点与变更' : step === 'points' ? '选择还原点' : '时间点还原';
            if (options.reason) body.appendChild(element('p', options.reason, 'grey'));
            if (step === 'intro') {
                const explanation = element('div', undefined, undefined, 'modHubRestoreDescription');
                appendDescription(explanation); body.appendChild(explanation);
                const scope = element('details');
                scope.appendChild(element('summary', '还原范围'));
                scope.appendChild(element('p', '还原浏览器管理的模组包体、启用状态、加载顺序和美化配置。游戏 HTML、内置模组与游戏存档不在还原范围内；当前 ModHub 恢复工具保留。', 'grey'));
                body.appendChild(scope);
                renderSettings();
            } else if (step === 'points') renderPoints();
            else renderPreview();
            status = element('p', '', 'modhub-restore-panel-status grey', 'modHubRestorePanelStatus');
            status.setAttribute('aria-live', 'polite'); body.appendChild(status);
            sync(); next.focus();
        }

        function renderSettings() {
            const settings = element('div', undefined, 'modhub-restore-panel-settings');
            const autoLabel = element('label');
            const auto = element('input', undefined, undefined, 'modHubRestoreAutoCreate'); auto.type = 'checkbox'; auto.checked = data.config.autoCreate;
            autoLabel.appendChild(auto); autoLabel.appendChild(element('span', ' 模组配置变更前自动创建还原点'));
            const limitLabel = element('label', '最多保留还原点 ');
            const limit = element('select', undefined, undefined, 'modHubRestoreMaxPoints');
            [5, 10, 20, 50].forEach(value => { const option = element('option', `${value} 个`); option.value = String(value); limit.appendChild(option); });
            limit.value = String(data.config.maxPoints); limitLabel.appendChild(limit);
            settings.appendChild(autoLabel); settings.appendChild(limitLabel); body.appendChild(settings);
            body.appendChild(element('p', `${data.points.length} 个还原点；包体去重后占用约 ${(data.usageBytes / 1048576).toFixed(1)} MiB。受保护的还原点不会被清理。`, 'grey'));
            const actions = element('div', undefined, 'modhub-restore-panel-actions');
            const save = element('button', '保存设置', undefined, 'modHubRestoreSaveConfig');
            const undo = element('button', '撤销修改', undefined, 'modHubRestoreUndoConfig');
            save.disabled = undo.disabled = true;
            const changed = () => { dirty = auto.checked !== data.config.autoCreate || Number(limit.value) !== data.config.maxPoints; save.disabled = undo.disabled = !dirty; message(dirty ? '设置尚未保存，请先保存或撤销修改再继续。' : ''); sync(); };
            auto.onchange = limit.onchange = changed;
            undo.onclick = () => { auto.checked = data.config.autoCreate; limit.value = String(data.config.maxPoints); changed(); };
            save.onclick = () => task(async () => { if (await api.saveConfig({ autoCreate: auto.checked, maxPoints: Number(limit.value) })) { await refresh(); message('还原设置已保存'); } });
            actions.appendChild(save); actions.appendChild(undo); body.appendChild(actions);
            const manual = element('div', undefined, 'modhub-restore-panel-manual');
            const name = element('input', undefined, undefined, 'modHubRestorePointName'); name.type = 'text'; name.maxLength = 80; name.value = '手动还原点'; name.setAttribute('aria-label', '手动还原点名称，最多 80 字');
            const create = element('button', '创建还原点', undefined, 'modHubRestoreCreatePoint');
            create.onclick = () => { if (dirty) { message('请先保存或撤销设置修改。', true); return; } return task(async () => { selected = await api.createPoint(name.value.trim().slice(0, 80) || '手动还原点'); await refresh(); message('手动还原点已创建'); }); };
            manual.appendChild(name); manual.appendChild(create); body.appendChild(manual);
        }

        function renderPoints() {
            if (!data.points.length) { body.appendChild(element('p', '暂无还原点。没有保存过模组状态时无法回滚；可正常启动后在还原中心创建还原点。', 'grey', 'modHubRestoreEmpty')); return; }
            const list = element('div', undefined, 'modhub-restore-panel-points');
            const groups = new Map();
            data.points.forEach(point => { const group = groups.get(point.roundId) || []; group.push(point); groups.set(point.roundId, group); });
            const containers = new Map();
            [...groups.entries()].forEach(([round, points], index) => {
                const details = element('details'); details.open = index === 0 || points.some(point => point.id === selected);
                details.appendChild(element('summary', `${new Date(points.at(-1).at).toLocaleString('zh-CN', { hour12: false })} 起 · ${points.length} 个还原点`));
                containers.set(round, details); list.appendChild(details);
            });
            data.points.forEach(point => {
                const label = element('label', undefined, 'modhub-restore-panel-point');
                const radio = element('input', undefined, undefined, `modHubRestorePoint_${point.id}`); radio.type = 'radio'; radio.name = 'modHubRestoreSelectedPoint'; radio.value = point.id; radio.checked = point.id === selected;
                const info = element('span');
                info.appendChild(element('strong', point.label));
                info.appendChild(element('small', `${new Date(point.at).toLocaleString('zh-CN', { hour12: false })} · ${point.kind === 'manual' ? '手动创建' : point.kind === 'preRestore' ? '还原前状态' : '自动创建'} · ${point.modCount} 个模组`, 'grey'));
                const summary = [['installed', '安装'], ['updated', '更新'], ['removed', '删除'], ['enabled', '启用'], ['disabled', '禁用']]
                    .filter(([key]) => point.summary?.[key]?.length).map(([key, text]) => `${text}：${point.summary[key].join('、')}`);
                if (point.summary?.beautyChanged) summary.push('美化配置调整');
                if (point.summary?.orderChanged) summary.push('加载顺序调整');
                if (summary.length) info.appendChild(element('small', summary.join('；'), 'grey'));
                if (point.protected) info.appendChild(element('small', '受保护：本轮首次操作前状态或撤销还原所需状态', 'gold'));
                radio.onchange = () => { selected = point.id; render(); };
                label.appendChild(radio); label.appendChild(info); containers.get(point.roundId).appendChild(label);
            });
            body.appendChild(list);
            if (rescue) return;
            const actions = element('div', undefined, 'modhub-restore-panel-actions');
            const remove = element('button', '删除所选还原点', undefined, 'modHubRestoreDeletePoint');
            const clear = element('button', '清理未受保护的还原点', undefined, 'modHubRestoreClearPoints');
            remove.disabled = !!data.points.find(point => point.id === selected)?.protected;
            clear.disabled = !data.points.some(point => !point.protected);
            remove.onclick = () => task(async () => { if (await api.deletePoints([selected])) { await refresh(); message('所选还原点已删除'); } });
            clear.onclick = () => task(async () => { if (await api.deletePoints(data.points.filter(point => !point.protected).map(point => point.id))) { await refresh(); message('未受保护的还原点已清理'); } });
            actions.appendChild(remove); actions.appendChild(clear); body.appendChild(actions);
        }

        function renderPreview() {
            body.appendChild(element('p', `所选还原点：${preview.label}`));
            if (!preview.canRestore) body.appendChild(element('p', preview.reason || '该还原点无法恢复，请选择其他还原点。', 'red'));
            const changes = preview.changes || {};
            const list = element('ul'); let count = 0;
            [['installed', '恢复已删除模组'], ['updated', '回退包体'], ['removed', '移除后来安装的模组'], ['enabled', '恢复启用'], ['disabled', '恢复禁用']].forEach(([key, label]) => { if (changes[key]?.length) { list.appendChild(element('li', `${label}：${changes[key].join('、')}`)); count++; } });
            [['orderChanged', '恢复加载顺序'], ['beautyChanged', '恢复美化配置'], ['settingsChanged', '恢复管理配置']].forEach(([key, label]) => { if (changes[key]) { list.appendChild(element('li', label)); count++; } });
            body.appendChild(count ? list : element('p', '目标与当前模组状态一致', 'grey'));
            (preview.riskMessages || []).forEach(risk => body.appendChild(element('p', risk, 'red')));
            body.appendChild(element('p', '开始还原后仍需确认最终变更。还原前保存当前模组状态，完成后游戏重新加载。', 'grey'));
        }

        next.onclick = () => { if (dirty || next.disabled) return; return task(async () => {
            if (step === 'intro') { step = 'points'; render(); }
            else if (step === 'points') { preview = await api.preview(selected); step = 'preview'; render(); }
            else if (await api.restore(selected)) finish(true);
        }); };
        back.onclick = () => { if (working) return; step = step === 'preview' ? 'points' : 'intro'; preview = null; render(); };
        close.onclick = cancel.onclick = leave;
        overlay.onclick = event => { if (event.target === overlay) leave(); };
        function focusable() {
            return Array.from(dialog.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]'))
                .filter(node => !node.disabled && node.tabIndex !== -1 && node.getClientRects().length > 0);
        }
        function keepFocus(event) {
            if (working || dialog.contains(event.target)) return;
            (next.disabled ? cancel : next).focus();
        }
        function keyboard(event) {
            if (working) return;
            if (event.key === 'Escape') { event.preventDefault(); leave(); }
            else if (event.key === 'Tab') {
                const controls = focusable();
                const first = controls[0], last = controls.at(-1);
                if (!first) { event.preventDefault(); dialog.focus(); }
                else if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            } else if (event.key === 'Enter' && !next.disabled && !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A'].includes(event.target?.tagName)) { event.preventDefault(); next.onclick(); }
        }
        document.addEventListener('keydown', keyboard);
        document.addEventListener('focusin', keepFocus);
        status = element('p', '正在读取还原点...', 'grey'); body.appendChild(status); sync();
        task(refresh);
        return promise;
    };
})();
