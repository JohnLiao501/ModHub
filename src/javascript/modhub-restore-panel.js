/** ModHub 时间点还原面板：界面只调用恢复引擎，不复制包体或目标构建逻辑。 */
(function () {
    'use strict';
    if (window.modHubShowRestorePanel) return;
    let active = null;
    const description = '时间点还原会将游戏的模组状态还原到所选还原点。在该还原点之后所做的任何更改都将丢失，包括：模组安装、启用状态、加载顺序与美化配置。 还原不会影响ModHub和游戏存档。\n如果游戏因为模组加载遇到问题，甚至无法启动，可以选择一个还原点，然后将游戏还原到该状态。游戏将重启并恢复到捕获还原点时的状态。还原前会保存当前模组状态，方便需要时撤销此次还原。';
    const accents = new Map([['模组安装、启用状态、加载顺序与美化配置', 'gold'], ['游戏将重启', 'gold'], ['还原前会保存当前模组状态', 'gold'], ['任何更改都将丢失', 'red'], ['还原不会影响ModHub和游戏存档', 'green']]);
    const protectionHints = new Map([
        ['手动保护', ['手动保护', '此还原点已设为保留，不会自动清理。可使用“取消手动保护”解除此项保护。']],
        ['本轮首次操作前状态待启动验证', ['系统保护', '此还原点保留了本次模组调整前的状态。重新载入并成功进入游戏后，系统将自动解除此保护。']],
        ['未完成还原引用的状态', ['还原未完成', '此还原点正用于完成尚未结束的还原。还原完成后，系统将自动解除此保护。']],
    ]);

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
        style.textContent = `
.modhub-restore-panel-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(2px);padding:16px 16px calc(60px + env(safe-area-inset-bottom));box-sizing:border-box;white-space:normal;pointer-events:auto}
.modhub-restore-panel{width:100%;max-width:720px;max-height:calc(100dvh - 76px - env(safe-area-inset-bottom));display:flex;flex-direction:column;min-height:0;background:var(--850,#222);color:var(--100,#eee);border:1px solid var(--600,#666);box-shadow:0 10px 30px rgba(0,0,0,.85);font:16px/1.6 sans-serif;text-align:left;box-sizing:border-box;overflow:hidden}
.modhub-restore-panel-list-step{height:min(680px,calc(100dvh - 76px - env(safe-area-inset-bottom)))}
.modhub-restore-panel-header,.modhub-restore-panel-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;padding:12px 16px}
.modhub-restore-panel-header{border-bottom:1px solid var(--600,#666);justify-content:space-between}
.modhub-restore-panel-footer{border-top:1px solid var(--600,#666);justify-content:flex-end;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
.modhub-restore-panel-body{min-height:0;overflow:auto;padding:16px;overflow-wrap:anywhere}
.modhub-restore-panel-body-list{display:flex;flex-direction:column;flex:1 1 0;min-height:0;overflow:hidden}
.modhub-restore-panel-body-list> :not(.modhub-restore-panel-scroll){flex-shrink:0}
.modhub-restore-panel-scroll{flex:1 1 0;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;border:1px solid var(--600,#666)}
.modhub-restore-panel-scroll:focus-visible{outline:2px solid var(--gold,#d6b365);outline-offset:2px}
.modhub-restore-panel button{min-height:32px;flex-shrink:0;padding:6px 12px;color:var(--100,#eee);background:var(--800,#333);border:1px solid var(--600,#666);cursor:pointer}
.modhub-restore-panel button:not(.modhub-modal-close){box-sizing:border-box;min-width:0!important;max-width:100%;height:auto!important;white-space:normal!important;overflow-wrap:anywhere;line-height:1.4!important}
.modhub-restore-panel button:disabled{opacity:.5;cursor:default}
.modhub-restore-panel button[hidden]{display:none!important}
.modhub-restore-panel .modhub-modal-close{width:32px;min-width:32px;min-height:32px;box-sizing:border-box;background:transparent!important;border:none!important;color:var(--400,#888)!important;font-size:1.4em!important;line-height:1!important;padding:0 4px!important}
.modhub-restore-panel .modhub-modal-close:hover{color:var(--100,#fff)!important}
.modhub-restore-panel .modhub-modal-close:disabled{cursor:default!important}
.modhub-restore-panel .modhub-restore-primary{border-color:var(--gold,#d6b365)}
.modhub-restore-panel .gold{color:var(--gold,#d6b365)}
.modhub-restore-panel .red{color:var(--red,#ed7878)}
.modhub-restore-panel .green{color:var(--green,#88bd86)}
.modhub-restore-panel .grey{color:var(--400,#aaa)}
.modhub-restore-panel p{margin:0 0 14px}
.modhub-restore-panel-settings{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-top:1px solid var(--600,#666);padding-top:12px}
.modhub-restore-panel input[type=text],.modhub-restore-panel select{min-width:0;max-width:100%;min-height:32px;background:var(--800,#333);color:var(--100,#eee);border:1px solid var(--600,#666);box-sizing:border-box;padding:6px}
.modhub-restore-panel-actions,.modhub-restore-panel-manual{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.modhub-restore-panel-manual input{flex:1 1 240px}
.modhub-restore-panel-point{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--600,#666);cursor:pointer}
.modhub-restore-panel-point:hover,.modhub-restore-panel-point:focus-within,.modhub-restore-panel-point-selected{border-color:var(--gold,#d6b365)}
.modhub-restore-panel-point input{flex-shrink:0;margin-top:5px;accent-color:var(--gold,#d6b365)}
.modhub-restore-panel-point input[type=radio]:focus{outline:none!important;box-shadow:none!important}
.modhub-restore-panel-point span{min-width:0;flex:1}
.modhub-restore-panel-point small{display:block}
.modhub-restore-panel-point-info{display:block}
.modhub-restore-panel-point-fields{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);gap:4px 12px;margin:6px 0;font-size:.875em;line-height:1.5}
.modhub-restore-panel-point-fields>span{display:block}
.modhub-restore-panel-field-name{display:block;color:var(--400,#aaa);font-size:inherit}
.modhub-restore-panel-protection{display:block;margin-top:8px;padding-left:10px;border-left:2px solid var(--gold,#d6b365)}
.modhub-restore-panel-protection strong{font-size:.875em}
.modhub-restore-panel-protection small{line-height:1.5}
.modhub-restore-panel-status{margin:8px 0 0;min-height:1.6em}
.modhub-restore-panel-status:empty{display:none}
.modhub-restore-panel details{margin-bottom:14px}
.modhub-restore-panel summary{cursor:pointer;min-height:32px}
.modhub-restore-panel-points details{margin:0}
.modhub-restore-panel-group-summary{display:flex;align-items:center;padding:10px;border:1px solid var(--600,#666);background:var(--800,#333);font-weight:bold;list-style:none;user-select:none}
.modhub-restore-panel-group-summary::-webkit-details-marker{display:none}
.modhub-restore-panel-group-summary::before{content:'';display:inline-block;flex-shrink:0;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid var(--gold,#ffcc00);margin-right:8px;transform-origin:2px center}
.modhub-restore-panel-points details[open]>.modhub-restore-panel-group-summary::before{transform:rotate(90deg)}
.modhub-restore-panel-group-summary:hover,.modhub-restore-panel-group-summary:focus-visible{border-color:var(--gold,#d6b365);outline:1px solid var(--gold,#d6b365);outline-offset:-1px}
.modhub-restore-panel-selection strong{display:block}
.modhub-restore-panel-changes{padding:12px;box-sizing:border-box}
.modhub-restore-panel-changes section+section{margin-top:14px}
.modhub-restore-panel-changes ul{margin:4px 0 0;padding-left:22px}
.modhub-restore-panel-changes li{overflow-wrap:anywhere}
.modhub-restore-panel-changes li+li{margin-top:6px}
.modhub-restore-panel-changes li small{display:block;line-height:1.5}
.modhub-restore-panel-notice{margin:12px 0 0!important}
@media(max-width:768px){.modhub-restore-panel-settings{grid-template-columns:1fr}.modhub-restore-panel-footer button{flex:1 1 0;min-width:0}.modhub-restore-panel-manual button,.modhub-restore-panel-actions button{flex:1 1 auto;min-width:0}.modhub-restore-panel-body{padding-left:12px;padding-right:12px}}
@media(max-width:768px){.modhub-restore-panel-point-fields{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.modhub-restore-panel-point-fields>span:first-child{grid-column:1/-1}}
@media(max-height:560px){.modhub-restore-panel-header,.modhub-restore-panel-footer{padding:8px 12px}.modhub-restore-panel-body{padding:8px 12px}.modhub-restore-panel p{margin-bottom:8px}.modhub-restore-panel-actions{margin:6px 0}.modhub-restore-panel-notice{margin-top:6px!important}.modhub-restore-panel-status{margin-top:4px}}
`;
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
        let data = null, step = rescue ? 'points' : 'intro', selected = '', preview = null, dirty = false, working = false, scanReturn = 'points';
        const openDates = new Map();
        let renderedDates = new Map(), pointList = null, pointScroll = 0;
        const overlay = element('div', undefined, 'modhub-restore-panel-overlay', 'modHubRestorePanelOverlay');
        const dialog = element('section', undefined, 'modhub-restore-panel', 'modHubRestorePanel');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'modHubRestorePanelTitle');
        dialog.tabIndex = -1;
        const header = element('header', undefined, 'modhub-restore-panel-header');
        const title = element('strong', '时间点还原', 'gold', 'modHubRestorePanelTitle');
        const close = element('button', '×', 'modhub-modal-close', 'modHubRestorePanelClose');
        close.type = 'button'; close.setAttribute('aria-label', '关闭');
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

        function selectedPoint() {
            const point = data?.points.find(point => point.id === selected);
            if (!point) return;
            const radio = document.getElementById(`modHubRestorePoint_${selected}`);
            if (step === 'points' && (!radio?.checked || !radio.parentNode?.parentNode?.open)) return;
            if (['preview', 'changes'].includes(step) && preview?.id !== selected) return;
            return point;
        }

        function sync() {
            body.inert = working;
            close.disabled = cancel.disabled = working;
            back.disabled = working || step === 'intro' || rescue && step === 'points';
            next.disabled = working || dirty || !data || step === 'changes' || (step !== 'intro' && !selectedPoint()) || (step === 'preview' && !preview?.canRestore);
            next.textContent = step === 'preview' ? '开始还原' : '下一步';
            next.hidden = step === 'changes';
            back.textContent = step === 'changes' ? '返回' : '上一步';
            cancel.textContent = step === 'changes' ? '关闭' : rescue ? '继续等待或启动' : '取消';
        }

        async function task(action) {
            if (working) return;
            working = true; sync();
            try { return await action(); }
            catch (error) { message((error?.message || '操作未完成，请重试') + (api.isRestoring?.() ? '。恢复记录已保留，游戏加载保持暂停；重新打开游戏将继续恢复。' : ''), true); }
            finally { working = false; sync(); if (active) (next.disabled ? close : next).focus(); }
        }

        async function refresh() {
            data = await api.getPanelState();
            if (!data.points.some(point => point.id === selected)) selected = '';
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
            if (step === 'changes') { step = scanReturn; render(); document.getElementById('modHubRestoreScanPoint')?.focus(); return; }
            if (dirty) {
                const discard = await task(() => window.modHubConfirm({ title: '放弃未保存的设置', message: '还原设置尚未保存，是否放弃本次设置修改？', confirmText: '放弃修改并关闭', cancelText: '继续编辑' }));
                if (!discard) return;
            }
            finish(false);
        }

        function render() {
            renderedDates.forEach((details, date) => openDates.set(date, details.open));
            renderedDates = new Map();
            if (pointList) pointScroll = pointList.scrollTop || 0;
            pointList = null;
            body.textContent = '';
            body.className = `modhub-restore-panel-body${step === 'intro' ? '' : ' modhub-restore-panel-body-list'}`;
            dialog.className = `modhub-restore-panel${step === 'intro' ? '' : ' modhub-restore-panel-list-step'}`;
            title.textContent = step === 'preview' ? '确认还原点与变更' : step === 'changes' ? '受影响的模组' : step === 'points' ? '选择还原点' : '时间点还原';
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
            sync(); (next.disabled ? close : next).focus();
        }

        function renderSettings() {
            const settings = element('div', undefined, 'modhub-restore-panel-settings');
            const autoLabel = element('label');
            const auto = element('input', undefined, undefined, 'modHubRestoreAutoCreate'); auto.type = 'checkbox'; auto.checked = data.config.autoCreate;
            autoLabel.appendChild(auto); autoLabel.appendChild(element('span', ' 模组配置变更前自动创建还原点'));
            const limitLabel = element('label', '普通历史保留上限 ');
            const limit = element('select', undefined, undefined, 'modHubRestoreMaxPoints');
            [5, 10, 20, 50].forEach(value => { const option = element('option', `${value} 个`); option.value = String(value); limit.appendChild(option); });
            limit.value = String(data.config.maxPoints); limitLabel.appendChild(limit);
            settings.appendChild(autoLabel); settings.appendChild(limitLabel); body.appendChild(settings);
            const protectedCount = data.points.filter(point => point.protected).length;
            body.appendChild(element('p', `${data.points.length} 个还原点，其中 ${protectedCount} 个受保护；包体去重后占用约 ${(data.usageBytes / 1048576).toFixed(1)} MiB。保留上限只限制普通历史，受保护点额外保留。`, 'grey'));
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
            create.onclick = () => { if (dirty) { message('请先保存或撤销设置修改。', true); return; } return task(async () => { await api.createPoint(name.value.trim().slice(0, 80) || '手动还原点'); await refresh(); message('手动还原点已创建'); }); };
            manual.appendChild(name); manual.appendChild(create); body.appendChild(manual);
        }

        function renderPoints() {
            if (!data.points.length) { body.appendChild(element('p', '暂无还原点。没有保存过模组状态时无法回滚；可正常启动后在还原中心创建还原点。', 'grey', 'modHubRestoreEmpty')); return; }
            body.appendChild(element('p', '选择一个还原点。可先扫描受影响的模组，或选择“下一步”确认还原。', undefined, 'modHubRestorePointInstruction'));
            if (!rescue) body.appendChild(element('p', `普通历史最多保留 ${data.config.maxPoints} 个，受保护点额外保留。`, 'grey'));
            const list = element('div', undefined, 'modhub-restore-panel-points modhub-restore-panel-scroll', 'modHubRestorePointList');
            list.tabIndex = 0;
            list.setAttribute('role', 'region');
            list.setAttribute('aria-label', '按日期分组的还原点列表，使用方向键滚动');
            const groups = new Map();
            const dateOf = point => { const date = new Date(point.at); return Number.isFinite(date.getTime()) ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}` : '日期未知'; };
            data.points.forEach(point => { const date = dateOf(point); const group = groups.get(date) || []; group.push(point); groups.set(date, group); });
            const containers = new Map();
            [...groups.entries()].sort((a, b) => Math.max(...b[1].map(point => new Date(point.at).getTime() || 0)) - Math.max(...a[1].map(point => new Date(point.at).getTime() || 0))).forEach(([date, points], index) => {
                const details = element('details'); details.open = openDates.has(date) ? openDates.get(date) : index === 0 || points.some(point => point.id === (selected || data.recommendedId));
                details.dataset.date = date;
                const summary = element('summary', undefined, 'modhub-restore-panel-group-summary');
                const label = `${date} · ${points.length}个还原点`;
                summary.appendChild(element('span', label));
                summary.setAttribute('aria-label', label);
                const update = () => summary.setAttribute('aria-expanded', String(details.open));
                update(); details.ontoggle = () => {
                    update();
                    if (!details.isConnected) return;
                    openDates.set(date, details.open);
                    if (!details.open && points.some(point => point.id === selected)) {
                        selected = ''; preview = null; render(); renderedDates.get(date)?.children[0].focus();
                    }
                };
                details.appendChild(summary);
                renderedDates.set(date, details); containers.set(date, details); list.appendChild(details);
            });
            data.points.forEach(point => {
                const label = element('label', undefined, `modhub-restore-panel-point${point.id === selected ? ' modhub-restore-panel-point-selected' : ''}`);
                const radio = element('input', undefined, undefined, `modHubRestorePoint_${point.id}`); radio.type = 'radio'; radio.name = 'modHubRestoreSelectedPoint'; radio.value = point.id; radio.checked = point.id === selected;
                const info = element('span', undefined, 'modhub-restore-panel-point-info');
                info.appendChild(element('strong', point.label, point.id === selected ? 'gold' : undefined));
                const fields = element('span', undefined, 'modhub-restore-panel-point-fields');
                [['创建时间', new Date(point.at).toLocaleString('zh-CN', { hour12: false })], ['类型', point.kind === 'manual' ? '手动创建' : point.kind === 'preRestore' ? '还原前状态' : '自动创建'], ['包含模组', `${point.modCount} 个`]].forEach(([name, value]) => {
                    const field = element('span');
                    field.appendChild(element('small', name, 'modhub-restore-panel-field-name'));
                    field.appendChild(element('span', value)); fields.appendChild(field);
                });
                info.appendChild(fields);
                const summary = [['installed', '安装'], ['updated', '更新'], ['removed', '删除'], ['enabled', '启用'], ['disabled', '禁用']]
                    .filter(([key]) => point.summary?.[key]?.length).map(([key, text]) => `${text}：${point.summary[key].join('、')}`);
                if (point.summary?.beautyChanged) summary.push('美化配置调整');
                if (point.summary?.orderChanged) summary.push('加载顺序调整');
                if (summary.length) info.appendChild(element('small', `相关操作：${summary.join('；')}`, 'grey'));
                if (point.protected) (point.protectionReasons?.length ? point.protectionReasons : ['此还原点正在被系统使用，暂时无法删除。']).forEach(reason => {
                    const [heading, detail] = protectionHints.get(reason) || ['受保护', reason];
                    const protection = element('span', undefined, 'modhub-restore-panel-protection');
                    protection.appendChild(element('strong', heading, 'gold'));
                    protection.appendChild(element('small', detail, 'grey')); info.appendChild(protection);
                });
                radio.onchange = () => { if (working || !radio.checked || !radio.isConnected || !containers.get(dateOf(point)).open) return; selected = point.id; render(); document.getElementById(radio.id)?.focus(); };
                label.appendChild(radio); label.appendChild(info); containers.get(dateOf(point)).appendChild(label);
            });
            body.appendChild(list);
            pointList = list; list.scrollTop = pointScroll;
            const actions = element('div', undefined, 'modhub-restore-panel-actions');
            actions.appendChild(scanButton());
            if (rescue) { body.appendChild(actions); return; }
            const current = selectedPoint();
            const protect = element('button', current?.userProtected ? '取消手动保护' : '保护所选还原点', 'modhub-restore-primary', 'modHubRestoreProtectPoint');
            const remove = element('button', '删除所选还原点', undefined, 'modHubRestoreDeletePoint');
            const clear = element('button', '清理未受保护的还原点', undefined, 'modHubRestoreClearPoints');
            remove.disabled = !current || !!current.protected;
            clear.disabled = !data.points.some(point => !point.protected);
            protect.disabled = !current;
            protect.onclick = () => { const point = selectedPoint(); if (protect.disabled || !point) return; return task(async () => {
                if (!await api.setPointProtection(point.id, !point.userProtected)) return;
                await refresh();
                message(point.userProtected ? data.points.find(item => item.id === point.id)?.systemProtected ? '已取消手动保护；该点仍受系统保护。' : '已取消手动保护，该点将参与后续普通历史清理。' : '已手动保护该还原点，不参与自动淘汰或历史清理。');
            }); };
            remove.onclick = () => { const point = selectedPoint(); if (remove.disabled || !point || point.protected) return; return task(async () => { if (await api.deletePoints([point.id])) { await refresh(); message('所选还原点已删除'); } }); };
            clear.onclick = () => task(async () => { if (await api.deletePoints(data.points.filter(point => !point.protected).map(point => point.id))) { await refresh(); message('未受保护的还原点已清理'); } });
            actions.appendChild(protect); actions.appendChild(remove); actions.appendChild(clear); body.appendChild(actions);
        }

        function scanButton() {
            const scan = element('button', '扫描受影响的模组', undefined, 'modHubRestoreScanPoint');
            scan.disabled = !selectedPoint();
            scan.onclick = () => { const point = selectedPoint(); if (working || scan.disabled || !point) return; return task(async () => {
                message('正在扫描受影响的模组，请稍候。');
                const result = await api.preview(point.id);
                scanReturn = step; preview = result; step = 'changes'; render();
            }); };
            return scan;
        }

        function renderPreview() {
            const selection = element('p', undefined, 'modhub-restore-panel-selection', 'modHubRestorePreviewSelection');
            selection.appendChild(element('span', '所选还原点：', 'grey'));
            selection.appendChild(element('strong', preview.label, 'gold'));
            const at = preview.at ?? data.points.find(point => point.id === selected)?.at;
            if (at !== undefined) selection.appendChild(element('span', new Date(at).toLocaleString('zh-CN', { hour12: false }), 'grey'));
            body.appendChild(selection);
            if (step === 'preview') {
                const actions = element('div', undefined, 'modhub-restore-panel-actions');
                actions.appendChild(scanButton()); body.appendChild(actions);
            }
            const changes = preview.changes || {};
            const list = element('div', undefined, 'modhub-restore-panel-changes modhub-restore-panel-scroll', step === 'changes' ? 'modHubRestoreChangeList' : 'modHubRestoreSummaryList');
            list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', step === 'changes' ? '还原变更与风险列表，使用方向键滚动' : '还原影响摘要与风险列表，使用方向键滚动');
            if (!preview.canRestore) list.appendChild(element('p', preview.reason || '该还原点无法恢复，请选择其他还原点。', 'red'));
            let count = 0;
            [['installed', '恢复已删除模组', 'green'], ['updated', '回退包体', 'gold'], ['removed', '移除后来安装的模组', 'red'], ['enabled', '恢复启用', 'green'], ['disabled', '恢复禁用', 'red']].forEach(([key, label, color]) => {
                if (!changes[key]?.length) return;
                if (step === 'preview') { list.appendChild(element('p', `${label}：${changes[key].length} 个`, color)); count++; return; }
                const group = element('section');
                group.appendChild(element('strong', `${label}：`, color));
                const names = element('ul');
                changes[key].forEach(name => {
                    const item = element('li', name);
                    if (['installed', 'updated', 'removed'].includes(key)) {
                        const versions = preview.packageVersions?.[name];
                        const current = versions?.current === null ? '未安装' : versions?.current || '未识别';
                        const target = versions?.target === null ? '未安装' : versions?.target || '未识别';
                        item.appendChild(element('small', `当前版本：${current}；还原后版本：${target}`, 'grey'));
                    }
                    names.appendChild(item);
                });
                group.appendChild(names); list.appendChild(group); count++;
            });
            [['orderChanged', '恢复加载顺序'], ['beautyChanged', '恢复美化配置'], ['settingsChanged', '恢复管理配置']].forEach(([key, label]) => { if (changes[key]) { list.appendChild(element('p', label, 'gold')); count++; } });
            if (!count && preview.canRestore) list.appendChild(element('p', '目标与当前模组状态一致', 'grey'));
            (preview.riskMessages || []).forEach(risk => list.appendChild(element('p', risk, 'red')));
            body.appendChild(list);
            if (step === 'changes') { body.appendChild(element('p', '关闭扫描结果可返回之前的页面，所选还原点将保留。', 'grey', 'modHubRestoreScanInstruction')); return; }
            const note = element('p', undefined, 'modhub-restore-panel-notice');
            note.appendChild(element('span', '开始还原后仍需确认最终变更。', 'grey'));
            note.appendChild(element('strong', '还原前保存当前模组状态', 'gold'));
            note.appendChild(element('span', '；'));
            note.appendChild(element('strong', '当前 ModHub 与游戏存档保留', 'green'));
            note.appendChild(element('span', '；完成后'));
            note.appendChild(element('strong', '游戏重新加载', 'gold'));
            note.appendChild(element('span', '。')); body.appendChild(note);
        }

        next.onclick = () => { const point = selectedPoint(); if (dirty || next.disabled || step !== 'intro' && !point) return; return task(async () => {
            if (step === 'intro') { step = 'points'; render(); }
            else if (step === 'points') { preview = await api.preview(point.id); step = 'preview'; render(); }
            else if (await api.restore(point.id)) finish(true);
        }); };
        back.onclick = () => { if (working) return; if (step === 'changes') return leave(); step = step === 'preview' ? 'points' : 'intro'; preview = null; render(); };
        close.onclick = cancel.onclick = leave;
        overlay.onclick = event => { if (event.target === overlay) leave(); };
        function focusable() {
            return Array.from(dialog.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]'))
                .filter(node => !node.disabled && !node.hidden && node.tabIndex !== -1 && node.getClientRects().length > 0);
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
