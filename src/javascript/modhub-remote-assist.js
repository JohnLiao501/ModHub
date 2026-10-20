/** ModHub 匿名远程协助：后台收信，前台逐项预览确认。 */
(function() {
    'use strict';
    const ui = html => window.modHubTranslateHtml ? window.modHubTranslateHtml(html) : html;
    const setText = (node, value) => {
        if (window.modHubBindText) window.modHubBindText(node, String(value ?? ''));
        else node.textContent = value;
    };
    const MODHUB_ASSIST_ORIGIN = 'https://dol.alseece.top';
    const MODHUB_ASSIST_LIMIT = 1024 * 1024;
    const labels = { runJavaScript: '快速 JS 指令', collectDiagnostics: '收集诊断', readSources: '查看源码', applyConfiguration: '配置建议', applyPatch: '源码补丁（高级修复）' };
    const hints = {
        runJavaScript: '填写纯 JavaScript，可使用 V 或 State.variables。适用于当前已载入的游戏状态。不要粘贴 <<set>>、<<script>> 或完整言灵宏文本；运行后按验证方法检查，是否存档由对方决定。',
        collectDiagnostics: '请求版本、模组列表及脱敏日志。对方在本机预览并确认后才会分享。',
        readSources: '填写目标模组技术名称及已声明文本路径，每行一项。对方核对后只分享所选文件。',
        applyConfiguration: '从对方诊断报告选择建议编号。保存前会在对方本机重新检查，并建立时间点。',
        applyPatch: '基于对方回传的精确版本和源码填写替换片段、依据及验证步骤。保存前建立时间点，保存后须重载验证。'
    };
    const json = value => JSON.stringify(value);
    const copy = value => JSON.parse(json(value));
    const bytes = value => new TextEncoder().encode(value);
    const fail = value => { throw new Error(value); };
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const displayName = (value, fallback = '未填写名称') => '<span' + (value ? ' data-modhub-i18n-ignore' : '') + '>' + escape(value || fallback) + '</span>';
    const dateHtml = value => '<time data-modhub-assist-date="' + escape(new Date(value).getTime()) + '">' + escape(new Date(value).toLocaleString(window.modHubGetLanguage?.())) + '</time>';
    const engine = () => window.modHubRemoteProtocol;
    let state = null, storageKey = '', host = null, role = 'player', onBack = null;
    let timer = null, polling = false, working = false, revision = 0, failures = 0;
    let preview = null, lookup = null, operationPreview = '', detailMessage = null;
    let notice = '', noticeError = false, atBottom = true, renderedSession = '', renderedDetail = null;
    const draftDefault = () => ({ kind: 'runJavaScript', payload: { summary: '', script: '', verification: '' } });
    function random() {
        if (!window.crypto?.getRandomValues || !window.crypto?.subtle) fail('当前浏览器缺少安全随机数或 SHA-256，无法建立协助连接。');
        return [...window.crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    async function hash(value) {
        return [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes(json(value))))].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    const current = () => state?.current;
    const visible = () => host && host.isConnected !== false && !document.hidden && !host.closest?.('[hidden]') && (!host.getClientRects || host.getClientRects().length > 0);
    const foreground = () => visible() && current()?.role === role;
    function reveal(target, block = 'start') {
        const element = typeof target === 'string' ? host?.querySelector(target) : target;
        if (!visible() || !element) return;
        if (!element.matches?.('button, input, select, textarea, a[href], [tabindex]')) element.setAttribute?.('tabindex', '-1');
        element.focus?.({ preventScroll: true });
        element.scrollIntoView?.({ block, behavior: 'auto' });
    }
    function assertForeground(ticket, allowPaused = false) {
        if (!foreground() || ticket !== revision || current().session.status === 'closed' || (!allowPaused && current().session.status === 'paused')) fail('请返回当前协助工作区并重新预览确认。后台只接收消息，不处理本机操作。');
    }
    function load() {
        const identity = window.modHubRestore?.getStorageIdentity?.();
        if (!identity?.dbName || !identity?.storeName) return false;
        const key = 'modhub_remote_assist:' + json([identity.dbName, identity.storeName]);
        if (key === storageKey && state) return true;
        revision++; preview = null; detailMessage = null;
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) : { current: null, pending: null, history: [] };
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.history)) fail('本机协助记录无法读取，请保留本机数据后重试。');
        for (const item of [value.current, value.pending].filter(Boolean)) {
            if (!['helper', 'player'].includes(item.role) || !/^[a-f0-9]{64}$/.test(item.token || '')) fail('本机协助凭据无法读取，未恢复连接。');
        }
        if (value.current && (!value.current.session || !Array.isArray(value.current.messages) || !value.current.entries)) fail('本机协助会话记录无效。');
        state = value; storageKey = key; return true;
    }
    function save() {
        if (!state || !storageKey) fail('加载器存储尚未就绪，暂时无法保存协助记录。');
        const persisted = { ...state, current: state.current ? { ...state.current, messages: state.current.messages.map(item => Object.fromEntries(['id', 'seq', 'type', 'kind', 'digest', 'status', 'sender', 'commandId', 'text'].filter(key => item[key] !== undefined).map(key => [key, item[key]]))) } : null };
        localStorage.setItem(storageKey, json(persisted));
    }
    function getSummary() {
        const record = current();
        const unread = record?.unread || 0;
        const pending = record?.role === 'player' ? record.messages.filter(item => item.type === 'command' && item.status !== 'completed' && !record.entries[item.id]?.uploaded).length : 0;
        return { role: record?.role || state?.pending?.role || null, unread, pending, status: record?.session.status || (state?.pending ? 'waiting' : 'idle') };
    }
    function notify() {
        if (typeof window.CustomEvent === 'function' && window.dispatchEvent) window.dispatchEvent(new window.CustomEvent('modHubRemoteAssistUpdate', { detail: getSummary() }));
    }
    function report(error) {
        notice = String(error?.message || error || '未提供具体原因');
        noticeError = true;
        if ([401, 403, 404, 410].includes(error?.status) && current()) {
            current().unavailable = true;
            if ([404, 410].includes(error.status)) current().session.status = 'closed';
            try { save(); } catch (_) {}
        }
        render(); notify();
    }
    async function api(path, body, record = current()) {
        const identity = window.modHubRestore?.getStorageIdentity?.();
        if (storageKey !== 'modhub_remote_assist:' + json([identity?.dbName, identity?.storeName])) fail('加载器存储身份已变化，请重新进入协助工作区。');
        const serialized = body === undefined ? undefined : json(body);
        if (serialized && bytes(serialized).length > MODHUB_ASSIST_LIMIT) fail('本次资料超过 1 MiB，请缩小请求范围。未截断或发送。');
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
        let response, raw;
        try {
            response = await fetch(MODHUB_ASSIST_ORIGIN + '/remote-assistance/direct' + path, {
                method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
                headers: { ...(serialized ? { 'Content-Type': 'application/json' } : {}), ...(record?.token ? { Authorization: 'Bearer ' + record.token } : {}) }, body: serialized
            });
            raw = await engine().readResponse(response);
        } finally { clearTimeout(timeout); }
        let value; try { value = JSON.parse(raw); } catch (_) { fail('协助服务返回了无法读取的内容。'); }
        if (!response.ok) { const error = new Error(value.error || '协助服务暂时不可用。'); error.status = response.status; throw error; }
        return value;
    }
    const sessionPath = record => '/sessions/' + encodeURIComponent(record.session.id);
    function promote(record, session) {
        state.current = { role: record.role, token: record.token, session, messages: [], after: 0, readSeq: 0, unread: 0, entries: {}, draft: draftDefault(), chatDraft: '' };
        state.pending = null; preview = null; operationPreview = ''; detailMessage = null; revision++;
        save(); notify();
    }
    function schedule() {
        clearTimeout(timer); timer = null;
        if (!current() && !state?.pending?.invite) return;
        if (current()?.session.status === 'closed' || state?.pending?.invite?.expiresAt <= Date.now()) return;
        timer = setTimeout(() => receive().catch(report), failures ? Math.min(60000, 5000 * 2 ** Math.min(failures, 4)) : document.hidden ? 30000 : 2000);
    }
    async function receive() {
        if (polling || working || !load()) { schedule(); return; }
        polling = true;
        try {
            const pending = state.pending;
            if (!current() && pending?.role === 'helper' && pending.invite && pending.invite.expiresAt > Date.now()) {
                const result = await api('/invites/' + encodeURIComponent(pending.invite.id), undefined, pending);
                if (state.pending !== pending) return;
                pending.invite = result.invite;
                if (result.session) promote(pending, result.session); else save();
            }
            const record = current();
            if (record && record.session.status !== 'closed') {
                let next, previous;
                do {
                    previous = record.after;
                    const result = await api(sessionPath(record) + '?after=' + record.after, undefined, record);
                    if (current() !== record) return;
                    if (result.session.role !== record.role || result.session.id !== record.session.id) fail('协助会话与本机凭据不一致，未接收资料。');
                    record.session = result.session;
                    const messages = new Map(record.messages.map(item => [item.id, item]));
                    for (const item of result.messages || []) {
                        if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.seq) || item.seq < 1 || !['text', 'command', 'result'].includes(item.type)) fail('协助消息格式无效。');
                        if (item.type === 'text' && (typeof item.text !== 'string' || item.text.length > 4000)) fail('聊天消息超出限制。');
                        if (item.seq > previous && item.type !== 'command' && item.sender !== record.role && !messages.has(item.id)) record.unread = (record.unread || 0) + 1;
                        messages.set(item.id, item); record.after = Math.max(record.after, item.seq);
                    }
                    record.messages = [...messages.values()].sort((a, b) => a.seq - b.seq);
                    for (const item of record.messages) if (item.type === 'result') { const command = messages.get(item.commandId); if (command) command.status = 'completed'; }
                    const recentMessages = new Set(record.messages.filter(item => item.type !== 'command').slice(-200).map(item => item.id));
                    record.messages = record.messages.filter(item => item.type === 'command' || recentMessages.has(item.id));
                    next = Number(result.nextCursor); save();
                } while (Number.isSafeInteger(next) && next > 0 && record.after > previous && record.session.status !== 'closed');
            }
            failures = 0; markRead(); render(); notify();
        } catch (error) { failures++; report(error); }
        finally { polling = false; schedule(); }
    }
    function markRead() {
        if (foreground() && atBottom && (current().readSeq < current().after || current().unread)) { current().readSeq = current().after; current().unread = 0; save(); }
    }
    async function act(action, destination = '.modhub-assist-notice') {
        if (working) return;
        const previousPreview = preview, previousOperation = operationPreview, previousDetail = detailMessage, actionHost = host;
        working = true; noticeError = false; window.modHubRefreshLanguageSelectors?.();
        try { await action(); } catch (error) { report(error); }
        finally {
            working = false; window.modHubRefreshLanguageSelectors?.(); render(true);
            if (host === actionHost && visible()) {
                if (destination === '.modhub-assist-tools') host.querySelector('.modhub-assist-tools details')?.setAttribute('open', '');
                const target = noticeError ? '.modhub-assist-notice' : preview && preview !== previousPreview ? '#modHubAssistPlayerPreview'
                    : operationPreview && operationPreview !== previousOperation ? '#modHubAssistOperationPreview'
                    : detailMessage && detailMessage !== previousDetail ? '#modHubAssistDetail' : typeof destination === 'function' ? destination() : destination;
                reveal(target, ['#modHubAssistChat', '#modHubAssistConversation'].includes(target) ? 'nearest' : 'start');
            }
            notify(); schedule();
            if (noticeError && host === actionHost && visible()) {
                try { await window.modHubAlert?.(notice, '操作未完成'); } catch (_) {}
                if (host === actionHost && visible()) reveal('.modhub-assist-notice');
            }
        }
    }
    function value(id) { return host?.querySelector('#' + id)?.value || ''; }
    const button = (action, text, primary = false, disabled = false, extra = '') => '<button type="button" class="macro-button modhub-btn-' + (primary ? 'primary' : 'secondary') + '" data-assist-action="' + action + '"' + (disabled || working ? ' disabled' : '') + extra + '>' + text + '</button>';
    const field = (title, id, content = '', multiline = false, extra = '') => '<label class="modhub-assist-field" for="' + id + '">' + title + '<' + (multiline ? 'textarea' : 'input') + ' id="' + id + '"' + extra + (multiline ? '>' + escape(content) + '</textarea>' : ' value="' + escape(content) + '">') + '</label>';
    function blockedRole() { return (current()?.role || state?.pending?.role) && (current()?.role || state.pending.role) !== role; }
    async function retireInvite(record) {
        if (!record?.invite) return true;
        try { await api('/invites/' + encodeURIComponent(record.invite.id) + '/cancel', {}, record); }
        catch (error) {
            if ([404, 410].includes(error.status)) return true;
            if (error.status !== 409) throw error;
            const result = await api('/invites/' + encodeURIComponent(record.invite.id), undefined, record);
            if (result.session) { promote(record, result.session); notice = '对方已建立连接，已返回当前协助。请先结束此协助，再创建新协助码。'; return false; }
            throw error;
        }
        return true;
    }
    async function createCode(regenerate = false) {
        if (!load()) fail('加载器存储尚未就绪，请稍后重新进入。');
        if (current()) fail('请先结束当前协助，再生成新的协助码。');
        if (state.pending && !regenerate) fail('已有待连接协助，请复制当前协助码或重新生成。');
        const displayName = state.pending?.displayName ?? value('modHubAssistName').trim();
        if (displayName.length > 80) fail('名称最多 80 字。');
        if (regenerate && state.pending?.invite && !await retireInvite(state.pending)) return;
        if (!state.pending || state.pending.invite && regenerate) { state.pending = { role: 'helper', token: random(), requestId: random(), displayName }; save(); }
        const record = state.pending;
        const result = await api('/invites', { token: record.token, requestId: record.requestId, displayName: record.displayName || '协助者' }, record);
        record.invite = result.invite; save(); notice = '请将协助码通过已有联系渠道交给需要帮助的人。名称由您自行填写。';
    }
    async function lookupCode() {
        if (!load()) fail('加载器存储尚未就绪。');
        if (current() || state.pending) fail('请先结束当前协助或处理上次连接，再连接其他协助者。');
        const code = value('modHubAssistCode').trim();
        if (!/^\d{10}$/.test(code)) fail('请输入十位数字协助码。');
        const result = await api('/codes/' + code, undefined, null);
        lookup = { code, invite: result.invite }; notice = '请核对协助者名称。确认连接不会发送诊断、源码或保存修改。';
    }
    async function join(retry = false) {
        if (current()) fail('请先结束当前协助。');
        const selected = retry ? state.pending?.lookup : lookup;
        if (!selected) fail('请先核对协助者名称。');
        const ticket = revision;
        if (!await window.modHubConfirm({ title: '确认连接', message: '协助者：' + (selected.invite.helper.displayName || '未填写名称') + '\n名称不代表身份认证。连接后可文字沟通；诊断、源码及修改仍须逐次预览确认。', confirmText: '连接', cancelText: '取消' })) return;
        if (!host || document.hidden || ticket !== revision) fail('请返回协助工作区重新确认连接。');
        if (!retry) {
            const description = value('modHubAssistProblem').trim();
            if (description.length > 4000) fail('问题说明最多 4000 字。');
            state.pending = { role: 'player', token: random(), requestId: random(), lookup: selected, description }; save();
        }
        const record = state.pending;
        let result;
        try { result = await api('/sessions', { code: record.lookup.code, token: record.token, requestId: record.requestId, ...(record.description ? { description: record.description } : {}) }, record); }
        catch (error) { if ([404, 409, 410].includes(error.status)) { state.pending = null; lookup = null; save(); } throw error; }
        promote(record, result.session); lookup = null; notice = '连接已建立。可先描述问题，再逐项预览和确认协助请求。';
    }
    async function sendChat() {
        const record = current(); if (!foreground() || record.session.status === 'closed') fail('请打开当前协助再发送消息。');
        const text = value('modHubAssistChat').trim(); if (!text || text.length > 4000) fail('请输入 1 至 4000 字的消息。');
        if (!record.chatRequest || record.chatRequest.text !== text) { record.chatRequest = { requestId: random(), text }; save(); }
        const { message } = await api(sessionPath(record) + '/text', record.chatRequest, record);
        if (!record.messages.some(item => item.id === message.id)) record.messages.push(message);
        record.chatDraft = ''; record.chatRequest = null; atBottom = true; save();
    }
    function buildCommand() {
        const record = current(); if (!record || record.role !== 'helper') fail('只有提供协助的一方可以准备操作。');
        return copy(record.draft || draftDefault());
    }
    async function previewOperation() {
        const command = buildCommand();
        await engine().validateCommand({ ...command, digest: await hash(command) });
        operationPreview = json(command); notice = '请核对当前操作。发送仅加入对方的待处理列表，不会自动执行。';
    }
    async function sendOperation() {
        const record = current(); if (!foreground() || record.role !== 'helper') fail('请打开提供协助工作区。');
        const command = buildCommand(); if (operationPreview !== json(command)) fail('请先预览当前操作；编辑后须重新预览。');
        const ticket = revision;
        if (!await window.modHubConfirm({ title: '发送待确认操作', message: engine().describeCommand(command) + '\n\n每次操作仍须对方在本机预览确认。', confirmText: '发送操作', cancelText: '取消' })) return;
        assertForeground(ticket, true);
        const signature = await hash(command); assertForeground(ticket, true);
        if (!record.commandRequest || record.commandRequest.signature !== signature) { record.commandRequest = { requestId: random(), signature }; save(); }
        const result = await api(sessionPath(record) + '/commands', { requestId: record.commandRequest.requestId, ...command }, record);
        if (!record.messages.some(item => item.id === result.command.id)) record.messages.push({ ...result.command, type: 'command', sender: 'helper' });
        record.commandRequest = null; operationPreview = ''; save(); notice = record.session.status === 'paused' ? '操作已排队。对方需主动继续处理，再预览确认。' : '操作已发送，等待对方预览确认。';
    }
    function pendingCommand() { return current()?.messages.find(item => item.type === 'command' && item.status !== 'completed' && !current().entries[item.id]); }
    const riskText = risks => risks.map(item => item.path + '：第 ' + item.line + ' 行 · ' + item.category + '\n' + item.reason + '\n' + item.excerpt).join('\n\n');
    async function inspectCommand(command, plan) {
        let files = [], verification = null;
        if (command.kind === 'runJavaScript') files = [{ path: '协助指令.js', content: command.payload.script }];
        else if (command.kind === 'applyPatch') {
            verification = await window.modHubAiRepair.getVerification(plan);
            const archive = await window.modHubAiPackage.read(plan.data);
            for (const path of [...new Set(command.payload.changes.map(item => item.path))]) files.push({ path, content: await archive.text(path) });
        }
        return { stamp: await hash({ files, verification }), risks: engine().inspectCodeSources(files) };
    }
    async function checkInspection(selected) {
        if (!selected.inspection) return;
        const fresh = await inspectCommand(selected.command, selected.plan);
        assertForeground(selected.ticket);
        if (fresh.stamp !== selected.inspection.stamp || json(fresh.risks) !== json(selected.inspection.risks) || json(selected.command) !== selected.commandStamp) fail('预览正文、包体或风险提示已变化，请重新预览确认。');
    }
    async function prepareCommand() {
        const record = current(), item = pendingCommand(), ticket = revision;
        assertForeground(ticket); if (record.role !== 'player' || !item) fail('暂无需要处理的协助请求。');
        const { command } = await api(sessionPath(record) + '/commands/' + encodeURIComponent(item.id), undefined, record);
        await engine().validateCommand(command); assertForeground(ticket);
        const p = command.payload; let text, data, plan, verification;
        if (command.kind === 'runJavaScript') {
            const prepared = await window.modHubGameCommand.prepare(p); assertForeground(ticket);
            text = prepared.text; verification = prepared.stamp;
        } else if (command.kind === 'collectDiagnostics') {
            const snapshot = await window.modHubHelp.check();
            assertForeground(ticket);
            const report = window.modHubHelp.buildReport(snapshot, { allLogs: p.allLogs === true });
            if (!report) fail('检查结果已过期，请重新预览。');
            const sanitize = engine().redactResultText;
            data = { report: sanitize(report), issues: snapshot.issues.filter(item => sanitize(item.id) === item.id).map(item => ({ id: item.id, title: sanitize(item.title), repairable: Boolean(item.repair) })) };
            text = JSON.stringify(data, null, 2);
        } else if (command.kind === 'readSources' || command.kind === 'applyPatch') {
            const paths = command.kind === 'readSources' ? p.paths : [...new Set(p.changes.map(item => item.path))];
            const prepared = await window.modHubAiRepair.prepare(p.name, '远程协助：' + labels[command.kind], { paths, source: 'remoteRepair' });
            assertForeground(ticket);
            const material = JSON.parse(prepared.material);
            if ([material.name, material.version, ...material.files.flatMap(file => [file.path, file.content])].some(text => window.modHubHelp.redactRemoteCredentials(text) !== text)) fail('所选源码含有当前 AI 密钥，已停止分享。请移除凭据后重新预览；本次未改写源码。');
            if (command.kind === 'readSources') { data = { name: material.name, version: material.version, files: material.files, baselineHash: prepared.hash }; text = JSON.stringify(data, null, 2); }
            else {
                if (prepared.bootJson.version !== p.version || p.baselineHash && p.baselineHash !== prepared.hash) fail('目标版本或包体已改变，请协助者根据当前源码重新准备补丁。');
                plan = await window.modHubAiRepair.previewResponse(prepared, { summary: p.summary, evidence: p.evidence, verification: p.verification, changes: p.changes }, { source: 'remoteRepair' });
                assertForeground(ticket);
                verification = await window.modHubAiRepair.getVerification(plan);
                text = [p.summary, '依据：' + p.evidence, '验证：' + p.verification, ...p.changes.map(change => '\n文件：' + change.path + '\n原因：' + change.reason + '\n原文：\n' + change.before + '\n替换为：\n' + change.after)].join('\n\n');
            }
        } else {
            plan = await window.modHubHelp.previewRemoteConfiguration(p.issueId); assertForeground(ticket); verification = { before: copy(plan.before), after: copy(plan.after) };
            text = '当前配置：\n' + JSON.stringify(plan.before, null, 2) + '\n保存后：\n' + JSON.stringify(plan.after, null, 2);
        }
        assertForeground(ticket);
        if (data && bytes(json({ claimId: '0'.repeat(64), status: 'sent', result: data })).length > MODHUB_ASSIST_LIMIT) fail('完整资料超过 1 MiB，请协助者缩小请求范围。');
        const inspection = ['runJavaScript', 'applyPatch'].includes(command.kind) ? await inspectCommand(command, plan) : null;
        assertForeground(ticket);
        if (inspection) text += '\n\n本机风险检查\n' + (inspection.risks.length ? riskText(inspection.risks) : '未发现所检查的特征，不能证明代码安全。')
            + '\n\n检查仅识别文本特征，注释或字符串也可能命中；混淆、间接调用及未知行为可能漏检。结果仅留在本机。';
        preview = { command, data, plan, verification, text, ticket, inspection, commandStamp: json(command) }; notice = data ? '请核对将分享的完整资料。确认前不会上传。' : command.kind === 'runJavaScript' ? '请查看完整 JS 正文及验证方法。确认后先建立受保护时间点和本机游戏备份，再运行一次指令。' : '请核对将保存的修改。保存前建立受保护时间点，之后仍须重载验证。';
    }
    async function runGameCommand(selected, entry, record) {
        const restore = window.modHubRestore;
        const finish = restore.finish, release = restore.release;
        const context = restore.createOperation({ kind: 'remoteRepair', label: '远程 JS 指令：' + selected.command.payload.summary });
        let result, finishError;
        try {
            if (!await restore.prepare(context) || !context.pointId) fail('未能建立操作前时间点，JS 指令未运行。');
            entry.pointId = context.pointId; entry.phase = 'game-backup'; save();
            assertForeground(selected.ticket);
            await checkInspection(selected);
            result = await window.modHubGameCommand.run(selected.command.payload, selected.verification, json([storageKey, record.session.id, selected.command.id]), backupId => {
                if (backupId) { entry.backupId = backupId; entry.phase = 'running'; save(); }
                assertForeground(selected.ticket);
                if (json(selected.command) !== selected.commandStamp || json(engine().inspectCodeSources([{ path: '协助指令.js', content: selected.command.payload.script }])) !== json(selected.inspection.risks)) fail('JS 正文或风险提示已变化，请重新预览确认。');
            });
            entry.executed = result.ok === true; entry.backupId = result.backupId || entry.backupId || null; entry.localError = result.error || null; save();
        } finally {
            try { await finish(context); finishError = context.finishError; }
            catch (error) { finishError = error; }
            finally { release(context); }
        }
        if (finishError) return { ...result, uncertain: true, error: [result.error, '时间点收尾核验未完成：' + String(finishError.message || finishError)].filter(Boolean).join('\n') };
        return result;
    }
    async function upload(entry, id, record) {
        await api(sessionPath(record) + '/commands/' + encodeURIComponent(id) + '/result', entry.result, record);
        entry.uploaded = true; entry.summary = entry.result.result?.message || (entry.result.status === 'sent' ? '资料已分享' : '操作结果已回传');
        delete entry.result; save();
    }
    async function execute() {
        const selected = preview, record = current(); if (!selected) fail('请先预览当前操作。');
        assertForeground(selected.ticket); if (record.role !== 'player') fail('只有获取协助的一方可以处理本机操作。');
        const command = selected.command;
        const quick = command.kind === 'runJavaScript' && !selected.retryEntry;
        if (!await window.modHubConfirm({ title: selected.data ? '确认发送资料' : selected.retryEntry ? '确认回传结果' : quick ? '确认运行 JS 指令' : '确认保存修改', message: '协助者：' + (record.session.helper.displayName || '未填写名称') + '\n操作：' + labels[command.kind] + (selected.data ? '\n仅分享刚才预览的资料。' : selected.retryEntry ? '\n仅回传已核验记录，不会重新执行本机修改。' : quick ? '\n先建立受保护时间点，再保存原生游戏存档备份；两份备份保存并回读成功后运行一次。时间点覆盖旁加载模组和管理配置，原生备份覆盖游戏存档，两者均不能撤销网络请求、整页脚本或异步任务。JS 具有游戏页面的全部权限。只运行您信任的协助者提供的指令。' : '\n保存前建立受保护时间点；游戏存档不在还原范围内。'), confirmText: selected.data ? '发送资料' : selected.retryEntry ? '回传结果' : quick ? '备份并运行' : '保存修改', cancelText: '取消' })) return;
        assertForeground(selected.ticket); await engine().validateCommand(command); assertForeground(selected.ticket);
        if (selected.data && window.modHubHelp.redactRemoteCredentials(json(selected.data)) !== json(selected.data)) fail('待分享资料含有当前 AI 密钥，请移除凭据后重新预览。本次未发送。');
        if (selected.retryEntry) { await upload(selected.retryEntry, command.id, record); preview = null; return; }
        await checkInspection(selected);
        if (selected.inspection?.risks.length) {
            if (!await window.modHubConfirm({ title: '代码包含需注意的文本特征', message: riskText(selected.inspection.risks) + '\n\n这些文本可能涉及页面外请求、本机数据或后续脚本执行。注释和字符串也可能命中；该检查不能证明代码安全。备份不能撤销全部副作用。请核对来源和用途后决定是否继续。', confirmText: '已核对风险，继续', cancelText: '取消操作', confirmType: 'danger' })) return;
            assertForeground(selected.ticket); await checkInspection(selected);
        }
        if (record.entries[command.id]) fail('此项操作已有本机记录，请核验记录，不会重复执行。');
        const entry = { kind: command.kind, digest: command.digest, claimId: random(), stage: 'started', phase: 'claiming', verification: selected.verification || null, risks: selected.inspection?.risks || [], at: Date.now() };
        record.entries[command.id] = entry; save();
        try {
            const { command: claimed } = await api(sessionPath(record) + '/commands/' + encodeURIComponent(command.id) + '/claim', { digest: command.digest, claimId: entry.claimId }, record);
            await engine().validateCommand(claimed);
            if (claimed.id !== command.id || claimed.digest !== command.digest) fail('领取内容与预览不同，未继续处理。');
            assertForeground(selected.ticket); await checkInspection(selected); entry.phase = 'applying'; save();
            if (selected.data) entry.result = { claimId: entry.claimId, status: 'sent', result: selected.data };
            else if (quick) {
                const result = await runGameCommand(selected, entry, record);
                entry.executed = result.ok === true; entry.backupId = result.backupId || entry.backupId || null; entry.localError = result.error || null; entry.uncertain = result.uncertain === true;
                entry.result = { claimId: entry.claimId, status: entry.uncertain ? 'uncertain' : result.ok ? 'saved' : 'failed', result: { message: entry.uncertain ? 'JS 结果或时间点收尾仍待核验。具体原因请玩家在本机查看。' : result.ok ? 'JS 同步运行结束，等待玩家按验证方法检查。' : 'JS 未完成。具体原因请玩家在本机查看。', backupId: entry.backupId, verification: 'pending-game-check' } };
            } else {
                const onPrepared = async pointId => {
                    entry.pointId = pointId; entry.phase = 'saving'; save();
                    assertForeground(selected.ticket); await checkInspection(selected);
                };
                const result = command.kind === 'applyPatch' ? await window.modHubAiRepair.apply(selected.plan, { onPrepared }) : await window.modHubHelp.applyRemoteConfiguration(selected.plan, { onPrepared });
                entry.saved = result?.ok === true; entry.pointId = result?.pointId || entry.pointId || null; entry.uncertain = result?.uncertain === true; entry.committed = result?.committed === true || entry.saved;
                entry.localError = entry.saved ? null : result?.reason || '修改未完成，请核对本机状态。';
                entry.result = { claimId: entry.claimId, status: entry.uncertain ? 'uncertain' : entry.saved ? 'saved' : 'failed', result: { message: entry.saved ? '已保存并回读通过，等待重新载入验证。' : engine().redactResultText(result?.reason || '修改未完成，请核对本机状态。'), pointId: entry.pointId, verification: entry.saved ? 'pending-reload' : 'unverified' } };
            }
            entry.stage = 'done'; save(); preview = null;
            if (foreground() && selected.ticket === revision && record.session.status === 'active') await upload(entry, command.id, record);
            noticeError = Boolean(entry.localError);
            notice = quick ? (entry.localError ? (entry.uncertain ? '操作结果待核验：' : 'JS 运行未完成：') + entry.localError + (entry.backupId ? '。备份已保留，未自动重试。' : '。游戏备份未完成核验，指令未运行。') : 'JS 同步运行结束。操作前时间点已保护。请按验证方法检查；需要保留修改时再自行保存游戏。') : entry.localError ? (entry.uncertain ? '修复结果待核验：' : '修复未完成：') + entry.localError : entry.saved ? '修复已保存，操作前时间点已保护，等待重新载入验证。时间点还原不包含游戏存档。' : entry.uploaded ? '操作结果已回传。' : '本机操作已记录。请返回此工作区预览并确认回传结果。';
        } catch (error) {
            entry.localError = String(error.message || error);
            if (!entry.result) { entry.stage = 'interrupted'; entry.summary = '操作中断，结果待核验。未自动重复执行。'; }
            try { save(); } catch (_) {}
            preview = null; throw error;
        }
    }
    async function cancelCommand() {
        const record = current(), command = preview?.command || pendingCommand(), ticket = revision;
        assertForeground(ticket, true); if (!command || record.role !== 'player') fail('没有可拒绝的操作。');
        if (record.entries[command.id]) fail('已开始的操作不能直接取消，请先核验本机记录。');
        const entry = { kind: command.kind, digest: command.digest, stage: 'done', result: { claimId: '', status: 'cancelled', result: { message: '对方拒绝了此次操作，未分享资料或保存修改。' } }, at: Date.now() };
        record.entries[command.id] = entry; save(); await upload(entry, command.id, record); preview = null; notice = '此次操作已拒绝。';
    }
    async function reconcile(id) {
        const record = current(), entry = record.entries[id], ticket = revision; assertForeground(ticket);
        if (record.role !== 'player' || !entry) fail('找不到待核验的本机记录。');
        const { command } = await api(sessionPath(record) + '/commands/' + encodeURIComponent(id), undefined, record);
        await engine().validateCommand(command); assertForeground(ticket);
        if (command.digest !== entry.digest) fail('服务端与本机操作记录不一致，未继续处理。');
        if (command.status === 'completed') { entry.uploaded = true; entry.summary = '服务端已有结果，请核对本机修改与游戏表现。'; delete entry.result; save(); return; }
        if (!entry.result) {
            if (command.status === 'queued') entry.result = { claimId: '', status: 'cancelled', result: { message: '服务端未登记领取，本机不会自动重新执行。' } };
            else {
                await api(sessionPath(record) + '/commands/' + encodeURIComponent(id) + '/claim', { digest: command.digest, claimId: entry.claimId }, record);
                assertForeground(ticket); let evidence = '上次操作中断，未自动重试。'; const v = entry.verification;
                if (v?.name) {
                    const installed = await window.modHubReadInstalledModPackage(v.name); assertForeground(ticket);
                    if (!installed?.data || installed.error) throw installed?.error || new Error('无法读取目标包体。');
                    const digest = await window.modHubAiPackage.hash(installed.data); assertForeground(ticket);
                    evidence += digest === v.afterHash ? ' 当前包体符合预览后的摘要。' : digest === v.beforeHash ? ' 当前包体仍符合修改前摘要。' : ' 当前包体与预览前后摘要均不同。';
                }
                if (v?.after || v?.enabled) {
                    const lists = await window.modHubReadIndexDBModLists(); assertForeground(ticket);
                    if (!lists?.ok) throw lists?.error || new Error('无法读取配置。');
                    const expected = v.after || { enabled: v.enabled, disabled: v.disabled };
                    evidence += json([lists.enabled, lists.disabled]) === json([expected.enabled, expected.disabled]) ? ' 当前配置符合预览。' : ' 当前配置与预览不同。';
                }
                entry.result = { claimId: entry.claimId, status: 'uncertain', result: { message: evidence + (command.kind === 'runJavaScript' ? ' 无法判定脚本的全部影响，请核对游戏状态；本机备份可供原生导入。' : ' 请重新载入验证，必要时使用时间点还原。'), ...(command.kind === 'runJavaScript' ? { backupId: entry.backupId || null, verification: 'pending-game-check' } : { pointId: entry.pointId || null }) } };
            }
            entry.stage = 'done'; save();
        }
        assertForeground(ticket);
        const text = JSON.stringify(entry.result.result, null, 2);
        if (window.modHubHelp.redactRemoteCredentials(text) !== text) fail('待回传资料含有当前凭据，已停止回传。请核对本机记录。');
        preview = { command, data: entry.result.status === 'sent' ? entry.result.result : null, retryEntry: entry, text, ticket };
        notice = '请核对上次操作结果。确认后仅回传记录，不会重复执行本机操作。';
    }
    async function sessionAction(action) {
        const record = current(), ticket = revision; if (!foreground()) fail('请打开当前协助工作区。');
        if (action === 'close' || action === 'verify') {
            if (!await window.modHubConfirm({ title: action === 'verify' ? '确认问题已解决' : '结束协助', message: action === 'verify' ? (!Object.values(record.entries).some(item => item.saved) && Object.values(record.entries).some(item => item.kind === 'runJavaScript') ? '请确认已按协助者的验证方法核对游戏，问题已解决。确认后此协助结案。' : '请确认已重新载入并复现原操作，问题已解决。确认后此协助结案。') : '结束后双方不能继续聊天或提交操作。已保存的本机修改仍保留。', confirmText: action === 'verify' ? '已验证并结案' : '结束协助', cancelText: '取消' })) return;
        }
        assertForeground(ticket, true);
        const result = await api(sessionPath(record) + '/' + action, action === 'verify' ? { solved: true } : {}, record);
        record.session = result.session; preview = null; revision++; save();
        notice = action === 'pause' ? '本机操作已暂停，仍可接收消息并聊天。' : action === 'resume' ? '可继续处理请求，请重新预览确认。' : '协助已结束，已保存的修改不会撤销。';
    }
    function canPrepareSpell(record = current()) {
        return record?.role === 'helper' && record.session?.status === 'closed' && record.session.verification?.solved === true
            && Number.isFinite(record.session.verification.at) && record.session.verification.at > 0;
    }
    async function prepareSpellCandidate() {
        if (!foreground() || role !== 'helper' || !canPrepareSpell()) fail('仅在玩家明确验证问题已解决后，协助者才能主动整理候选言灵。');
        if (typeof window.modHubOpenSpellSubmission !== 'function') fail('候选言灵投稿接口尚未就绪，请重新载入游戏后从言灵市场进入。');
        notice = '候选言灵须手动填写并提交审核。不会自动带入协助资料，也不会自动公开。';
        await window.modHubOpenSpellSubmission();
    }
    async function viewMessage(id) {
        const record = current(), ticket = revision; if (!foreground()) fail('请打开当前协助工作区。');
        const { message } = await api(sessionPath(record) + '/messages/' + encodeURIComponent(id), undefined, record);
        assertForeground(ticket, true); detailMessage = message;
    }
    function useSource(index) {
        const result = detailMessage?.result, file = result?.files?.[index]; if (!file || current()?.role !== 'helper') return;
        current().draft = { kind: 'applyPatch', payload: { name: result.name, version: result.version, ...(result.baselineHash ? { baselineHash: result.baselineHash } : {}), summary: '', evidence: '', verification: '', changes: [{ path: file.path, before: file.content, after: file.content, reason: '' }] } };
        operationPreview = ''; save(); notice = '已填入回传源码。请缩小为唯一匹配片段，并填写替换文本、依据和验证步骤。';
    }
    function useIssue(index) {
        const issue = detailMessage?.result?.issues?.[index]; if (!issue?.repairable || current()?.role !== 'helper') return;
        current().draft = { kind: 'applyConfiguration', payload: { issueId: issue.id } }; operationPreview = ''; save(); notice = '已填入建议编号。对方预览时会重新检查本机配置。';
    }
    function editor() {
        const draft = current().draft || draftDefault(), p = draft.payload; let fields = '';
        if (draft.kind === 'runJavaScript') fields = field('修复说明', 'modHubAssistSummary', p.summary, true, ' maxlength="2000"') + field('JS 正文', 'modHubAssistScript', p.script, true, ' maxlength="16000" spellcheck="false" rows="6"') + field('验证方法', 'modHubAssistVerification', p.verification, true, ' maxlength="2000"');
        else if (draft.kind === 'collectDiagnostics') fields = '<label class="modhub-assist-check"><input id="modHubAssistAllLogs" type="checkbox"' + (p.allLogs ? ' checked' : '') + '>包含全部已捕获的脱敏日志</label>';
        else if (draft.kind === 'readSources') fields = field('模组技术名称', 'modHubAssistModName', p.name) + field('已声明路径，每行一项，最多二十项', 'modHubAssistPaths', (p.paths || []).join('\n'), true);
        else if (draft.kind === 'applyConfiguration') fields = field('诊断报告中的建议编号', 'modHubAssistIssueId', p.issueId);
        else {
            fields = field('模组技术名称', 'modHubAssistModName', p.name) + field('精确版本', 'modHubAssistVersion', p.version) + field('包体 SHA-256，可由回传源码填写', 'modHubAssistBaseline', p.baselineHash) + field('修复说明', 'modHubAssistSummary', p.summary, true) + field('依据', 'modHubAssistEvidence', p.evidence, true) + field('验证步骤', 'modHubAssistVerification', p.verification, true);
            fields += (p.changes || []).map((change, index) => '<fieldset class="modhub-assist-change"><legend>替换片段 ' + (index + 1) + '</legend>' + [['path', '文件路径'], ['before', '唯一匹配的原文'], ['after', '替换后的文本'], ['reason', '修改原因']].map(([key, title]) => field(title, 'modHubAssistChange' + index + key, change[key], key !== 'path', ' data-assist-change="' + index + '" data-assist-field="' + key + '"')).join('') + button('remove-change', '移除此片段', false, false, ' data-index="' + index + '"') + '</fieldset>').join('');
            fields += button('add-change', '添加替换片段', false, (p.changes || []).length >= 8);
            fields = '<details class="modhub-assist-secondary"><summary>高级修复：修改模组安装包</summary>' + fields + '</details>';
        }
        return '<section class="modhub-assist-tools" aria-labelledby="modHubAssistToolsTitle"><h3 id="modHubAssistToolsTitle">准备操作</h3><p class="grey">快速指令处理对方当前已载入的游戏状态；诊断及模组修复可单独选择。所有操作须对方逐项确认。</p><label class="modhub-assist-field" for="modHubAssistKind">操作类型<select id="modHubAssistKind">' + Object.entries(labels).map(([kind, title]) => '<option value="' + kind + '"' + (kind === draft.kind ? ' selected' : '') + '>' + title + '</option>').join('') + '</select></label><p class="modhub-assist-hint">' + escape(hints[draft.kind]) + '</p>' + fields + '<div class="modhub-help-actions">' + button('preview-operation', '预览操作') + button('send-operation', '发送操作', true, !operationPreview) + '</div>' + (operationPreview ? '<pre id="modHubAssistOperationPreview" class="modhub-assist-code" tabindex="0">' + escape(engine().describeCommand(draft) + '\n\n' + JSON.stringify(draft, null, 2)) + '</pre>' : '') + '</section>';
    }
    function resultView() {
        if (!detailMessage) return '';
        const result = detailMessage.result; let content = '';
        if (detailMessage.type === 'result' && detailMessage.kind === 'readSources' && Array.isArray(result?.files)) content = '<p>' + escape(result.name + ' · ' + result.version) + '</p>' + result.files.map((file, index) => '<details><summary>' + escape(file.path) + '</summary><pre class="modhub-assist-code" tabindex="0">' + escape(file.content) + '</pre>' + (current().role === 'helper' ? button('use-source', '使用此文件准备补丁', false, false, ' data-index="' + index + '"') : '') + '</details>').join('');
        else if (detailMessage.type === 'result' && detailMessage.kind === 'collectDiagnostics') content = '<pre class="modhub-assist-code" tabindex="0">' + escape(result?.report || '') + '</pre>' + (result?.issues || []).map((issue, index) => '<p>' + escape(issue.title) + '</p>' + (issue.repairable && current().role === 'helper' ? button('use-issue', '准备此配置建议', false, false, ' data-index="' + index + '"') : '')).join('');
        else content = '<pre class="modhub-assist-code" tabindex="0">' + escape(JSON.stringify(detailMessage.type === 'result' ? result : detailMessage.payload, null, 2)) + '</pre>';
        return '<section id="modHubAssistDetail" class="modhub-assist-detail" tabindex="-1"><h3>操作详情：' + escape(labels[detailMessage.kind] || '结果') + '</h3>' + content + button('hide-detail', '关闭详情') + '</section>';
    }
    function previousGameBackups() {
        const entries = state?.history.filter(item => item.role === 'player').flatMap(item => item.entries || []).filter(entry => entry.backupId) || [];
        if (role !== 'player' || !entries.length) return '';
        return '<details class="modhub-assist-secondary"><summary>以前协助的游戏备份</summary><p class="grey">保留最近十次会话的入口。备份仅在本机，下载后可从原生存档页导入。</p>' + entries.map(entry => '<p>' + dateHtml(entry.at) + '</p>' + button('download-backup', '下载游戏备份', false, false, ' data-id="' + escape(entry.backupId) + '"')).join('') + '</details>';
    }
    function render(force = false) {
        if (!host || host.isConnected === false) return;
        const record = current(), pending = state?.pending;
        const sessionKey = record && !blockedRole() ? role + ':' + record.session.id + ':' + (record.session.status === 'closed' ? 'closed' : 'open') : '';
        const partial = !force && sessionKey && sessionKey === renderedSession && host.firstElementChild;
        let body = '';
        if (blockedRole()) body = '<section class="modhub-assist-card"><h3>本机已有' + ((record?.role || pending.role) === 'helper' ? '提供协助' : '获取协助') + '记录</h3><p>请返回当前协助。结束连接或取消待连接记录后，才能更换角色。</p>' + button('current-role', '返回当前协助', true) + '</section>';
        else if (!record && role === 'helper') {
            const invite = pending?.invite, expired = invite && invite.expiresAt <= Date.now();
            body = '<section class="modhub-assist-card"><h3>提供协助</h3>' + (invite ? '<p>名称：' + displayName(invite.helper.displayName) + '</p><p class="modhub-assist-invite">协助码 <strong id="modHubAssistInviteCode">' + escape(invite.code) + '</strong></p><p>' + (expired ? '协助码已过期，请重新生成。' : '等待对方核对名称并确认连接。剩余约 ' + Math.max(1, Math.ceil((invite.expiresAt - Date.now()) / 60000)) + ' 分钟，此码仅可建立一次连接。') + '</p><div class="modhub-help-actions">' + button('copy-code', '复制协助码', !expired, expired) + button('regenerate', '重新生成', expired) + button('cancel-invite', '取消待连接协助') + '</div>' : field('您的名称，可不填写', 'modHubAssistName', pending?.displayName || '', false, ' maxlength="80"') + '<p class="grey">名称供对方核对，由您自行填写，无需登录。</p>' + button(pending ? 'retry-create' : 'create-code', pending ? '重试生成协助码' : '生成协助码', true)) + '</section>';
        } else if (!record) {
            body = '<section class="modhub-assist-card"><h3>获取协助</h3>' + (pending ? '<p>上次连接结果尚未确认。可重试同一连接，不会重复建立记录。</p>' + button('retry-join', '重试连接', true) : lookup ? '<h4>核对协助者</h4><p>名称：<strong>' + displayName(lookup.invite.helper.displayName) + '</strong></p><p class="grey">名称不代表身份认证。确认连接不会自动分享诊断、源码或保存修改。</p>' + field('问题说明，可不填写', 'modHubAssistProblem', '', true, ' maxlength="4000"') + '<div class="modhub-help-actions">' + button('join', '确认连接', true) + button('change-code', '更换协助码') + '</div>' : '<p>请向协助者获取十位协助码，再核对名称并确认连接。</p>' + field('十位协助码', 'modHubAssistCode', '', false, ' inputmode="numeric" autocomplete="off" maxlength="10"') + button('lookup', '核对协助者', true)) + '</section>';
        } else {
            const summary = getSummary(), open = record.session.status !== 'closed', paused = record.session.status === 'paused';
            const name = role === 'player' ? displayName(record.session.helper.displayName) : displayName(record.session.player?.displayName, '当前玩家');
            const command = pendingCommand();
            body = '<div id="modHubAssistSessionHeader" class="modhub-assist-session-header"><div><strong>' + name + '</strong><p class="grey">' + (open ? paused ? '本机操作已暂停，消息仍可往返。' : '连接已建立。后台仅接收消息。' : '协助已结束，已保存的修改仍保留。') + '</p></div><div class="modhub-help-actions">' + (role === 'player' && open ? button(paused ? 'resume' : 'pause', paused ? '继续处理请求' : '暂停本机操作') : '') + (canPrepareSpell(record) && role === 'helper' ? button('prepare-spell', '整理候选言灵') : '') + (open ? button('close', '结束协助') : button('new-session', '开始新的协助', true)) + '</div></div>';
            body += '<div id="modHubAssistPlayerTasks">';
            if (role === 'player') {
                if (open) {
                const unresolved = Object.entries(record.entries).find(([, entry]) => !entry.uploaded);
                if (unresolved && !preview) body += '<section class="modhub-assist-task"><h3>本机记录待核验或回传</h3><p>' + escape(unresolved[1].summary || '上次操作已记录，尚未完成回传。后台不会重试。') + '</p>' + button('reconcile', '核验并预览记录', true, paused, ' data-id="' + escape(unresolved[0]) + '"') + '</section>';
                else if (preview) body += '<section class="modhub-assist-task"><h3>' + (preview.data ? '将分享的完整资料' : preview.retryEntry ? '待回传的操作结果' : preview.command.kind === 'runJavaScript' ? '待运行的完整 JS 指令' : '将保存的修改') + '</h3><textarea id="modHubAssistPlayerPreview" class="modhub-assist-preview" readonly aria-label="本次操作完整预览">' + escape(preview.text) + '</textarea><div class="modhub-help-actions">' + button('execute', preview.data ? '确认发送资料' : preview.retryEntry ? '确认回传结果' : preview.command.kind === 'runJavaScript' ? '备份并运行指令' : '确认保存修改', true, paused) + (!preview.retryEntry ? button('cancel-command', '拒绝此次操作') : button('discard-preview', '返回聊天')) + '</div></section>';
                else if (command) body += '<section class="modhub-assist-task"><h3>待您确认：' + escape(labels[command.kind]) + '</h3><p>先在本机预览，确认后才分享资料、运行指令或保存修改。</p><div class="modhub-help-actions">' + button('preview', '在本机整理并预览', true, paused) + button('cancel-command', '拒绝此次操作') + '</div></section>';
                }
                const gameEntries = Object.values(record.entries).filter(entry => entry.kind === 'runJavaScript' && (entry.backupId || entry.localError));
                if (gameEntries.length) body += '<section class="modhub-assist-verification"><h3>本机 JS 记录与备份</h3><p>游戏备份仅保存在本机，采用原生存档范围。需要恢复游戏时，下载后从游戏原生存档页导入；受保护时间点用于恢复旁加载模组和管理配置。两份备份均不能撤销脚本或网络副作用。</p>' + gameEntries.map(entry => '<p' + (entry.localError ? ' class="red"' : '') + '>' + dateHtml(entry.at) + (entry.localError ? ' · ' + escape(entry.localError) + (entry.backupId ? '' : ' · 备份未完成核验，指令未运行。') : '') + '</p>' + (entry.pointId ? '<p class="grey">受保护时间点：' + escape(entry.pointId) + '</p>' : '') + (entry.backupId ? button('download-backup', '下载运行前备份', false, false, ' data-id="' + escape(entry.backupId) + '"') : '')).join('') + (gameEntries.some(entry => entry.pointId) ? button('restore', '查看受保护时间点') : '') + (open ? button('verify', '已验证，问题已解决') : '') + '</section>';
                const localFailures = Object.values(record.entries).filter(entry => entry.kind !== 'runJavaScript' && entry.localError);
                if (localFailures.length) body += '<section class="modhub-assist-verification" role="alert"><h3>本机操作未完成</h3>' + localFailures.map(entry => '<p class="red">' + escape(entry.localError) + '</p>' + (entry.pointId ? '<p class="grey">受保护时间点：' + escape(entry.pointId) + '</p>' : '')).join('') + (localFailures.some(entry => entry.pointId) ? button('restore', '查看受保护时间点') : '') + '</section>';
                if (Object.values(record.entries).some(entry => entry.saved)) body += '<div class="modhub-assist-verification"><p>修改已保存。请保存游戏进度，重新载入并复现原问题。时间点还原不包含游戏存档。</p><div class="modhub-help-actions">' + button('reload', '重新载入验证') + button('restore', '查看时间点还原') + button('verify', '已验证，问题已解决') + '</div></div>';
            }
            body += '</div><div class="modhub-assist-connected' + (role === 'player' ? ' modhub-assist-player' : '') + '"><section class="modhub-assist-chat"><h3>沟通记录</h3><p id="modHubAssistUnread" class="modhub-assist-hint">' + (summary.unread ? '新消息 ' + summary.unread + ' 条。' : '') + (summary.pending ? '待处理操作 ' + summary.pending + ' 项。' : '') + '</p>' + '<div id="modHubAssistReadLatest">' + (summary.unread && !atBottom ? button('read-latest', '查看新消息') : '') + '</div><div id="modHubAssistConversation" class="modhub-assist-conversation" tabindex="0" aria-label="沟通记录">' + (record.session.description ? '<article class="modhub-assist-system">问题说明：<span data-modhub-i18n-ignore>' + escape(record.session.description) + '</span>' + '</article>' : '') + (record.messages.length ? record.messages.map(item => '<article class="modhub-assist-message' + (item.sender === role ? ' modhub-assist-message-own' : '') + '"><small>' + (item.sender === role ? '您' : role === 'player' ? '协助者' : '对方') + '</small>' + (item.type === 'text' ? '<p data-modhub-i18n-ignore>' + escape(item.text ?? '正在载入此前消息') + '</p>' : '<p>' + escape(labels[item.kind] || '操作') + ' · ' + escape(item.type === 'result' ? ({ sent: '资料已分享', saved: item.kind === 'runJavaScript' ? 'JS 同步运行结束，仍须验证' : '修改已保存，仍须重载验证', cancelled: '已拒绝', failed: '未完成', uncertain: '待核验' }[item.status] || item.status) : item.status === 'completed' ? '已有回传结果' : item.status === 'claimed' ? '执行中或待核验' : '等待对方确认') + '</p>' + button('view-message', '查看详情', false, false, ' data-id="' + escape(item.id) + '"')) + '</article>').join('') : '<p class="grey">连接后可先描述问题，再逐项处理请求。</p>') + '</div>' + (open ? field('发送文字消息', 'modHubAssistChat', record.chatDraft, true, ' maxlength="4000" rows="2"') + '<div class="modhub-help-actions">' + button('chat-send', '发送消息', false, !record.chatDraft?.trim()) + '</div>' : '') + (partial ? '' : resultView()) + '</section>' + (!partial && role === 'helper' && open ? editor() : '') + '</div>';
        }
        const html = '<div class="modhub-assist"><header class="modhub-assist-header" tabindex="-1"><div><h2>远程协助</h2><p class="grey">' + (role === 'helper' ? '提供协助' : '获取协助') + ' · 文字沟通与逐项确认</p></div>' + button('back', '返回帮助中心') + '</header><p class="modhub-assist-notice' + (noticeError ? ' red' : '') + '" role="' + (noticeError ? 'alert' : 'status') + '" aria-live="' + (noticeError ? 'assertive' : 'polite') + '" tabindex="-1">' + escape(notice) + '</p>' + body + previousGameBackups() + '<details class="modhub-assist-secondary"><summary>使用范围与资料保留</summary><p>支持文字沟通、纯 JS 指令、诊断、所选源码及模组配置或补丁。JS 仅由玩家在前台确认后运行，备份不能撤销整页副作用；不支持屏幕共享或整机控制。每次分享资料、运行指令或保存修改均需本机预览确认。离开或重载后自动恢复收信，不自动处理操作。服务记录闲置七天到期，轮询不会延长保留时间。</p></details></div>';
        const ancestors = [];
        for (let element = host; element; element = element.parentElement) ancestors.push([element, element.scrollTop, element.scrollLeft]);
        const previousConversation = host.querySelector('#modHubAssistConversation');
        const chatTop = previousConversation?.scrollTop || 0;
        if (partial) {
            // 收信只更新消息与状态，保留输入法、草稿和完整资料的实际节点。
            const next = document.createElement('div'); next.innerHTML = ui(html);
            for (const selector of ['.modhub-assist-notice', '#modHubAssistSessionHeader', '#modHubAssistPlayerTasks', '#modHubAssistUnread', '#modHubAssistReadLatest', '#modHubAssistConversation']) {
                const previous = host.querySelector(selector), updated = next.querySelector(selector);
                if (previous && updated) {
                    if (previous.innerHTML !== updated.innerHTML) previous.innerHTML = updated.innerHTML;
                    if (selector === '.modhub-assist-notice') {
                        previous.className = updated.className;
                        for (const name of ['role', 'aria-live']) previous.setAttribute(name, updated.getAttribute(name));
                    }
                }
            }
        } else {
            const active = host.contains?.(document.activeElement) ? document.activeElement : null;
            const selection = active && [active.selectionStart, active.selectionEnd, active.selectionDirection];
            const scrolls = [...host.querySelectorAll('[id]')].map(element => [element.id, element.scrollTop, element.scrollLeft]);
            const expanded = [...host.querySelectorAll('details')].filter(element => !element.closest?.('#modHubAssistDetail')).map(element => [element.querySelector('summary')?.textContent, element.open]);
            const detail = renderedDetail === detailMessage?.id ? host.querySelector('#modHubAssistDetail') : null;
            host.innerHTML = ui(html);
            if (detail) host.querySelector('#modHubAssistDetail')?.replaceWith?.(detail);
            for (const [id, top, left] of scrolls) { const element = host.querySelector('#' + id); if (element) { element.scrollTop = top; element.scrollLeft = left; } }
            for (const element of host.querySelectorAll('details')) { const item = expanded.find(([title]) => title === element.querySelector('summary')?.textContent); if (item) element.open = item[1]; }
            const focused = active?.id ? host.querySelector('#' + active.id) : active?.isConnected && host.contains?.(active) ? active : null;
            if (focused) { focused.focus({ preventScroll: true }); if (selection && Number.isInteger(selection[0]) && focused.setSelectionRange) focused.setSelectionRange(...selection); }
        }
        renderedSession = sessionKey; renderedDetail = detailMessage?.id || null;
        const conversation = host.querySelector('#modHubAssistConversation');
        if (conversation) { conversation.scrollTop = atBottom ? conversation.scrollHeight : chatTop; conversation.onscroll = () => { atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 30; if (atBottom) { markRead(); notify(); } }; }
        for (const [element, top, left] of ancestors) { element.scrollTop = top; element.scrollLeft = left; }
    }
    function capture(event) {
        const record = current(), target = event.target;
        if (!record || record.role !== role) return;
        if (target.id === 'modHubAssistChat') { record.chatDraft = target.value; const send = host.querySelector('[data-assist-action="chat-send"]'); if (send) send.disabled = working || !target.value.trim(); save(); return; }
        if (record.role !== 'helper' || !target.id?.startsWith('modHubAssist')) return;
        const draft = record.draft || (record.draft = draftDefault()), p = draft.payload;
        if (target.id === 'modHubAssistKind') {
            draft.kind = target.value; draft.payload = draft.kind === 'runJavaScript' ? { summary: '', script: '', verification: '' } : draft.kind === 'collectDiagnostics' ? { allLogs: false } : draft.kind === 'readSources' ? { name: '', paths: [] } : draft.kind === 'applyConfiguration' ? { issueId: '' } : { name: '', version: '', summary: '', evidence: '', verification: '', changes: [{ path: '', before: '', after: '', reason: '' }] };
            operationPreview = ''; save(); render(true); return;
        }
        if (target.dataset.assistField) p.changes[Number(target.dataset.assistChange)][target.dataset.assistField] = target.value;
        else if (target.id === 'modHubAssistAllLogs') p.allLogs = target.checked;
        else if (target.id === 'modHubAssistPaths') p.paths = target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        else { const key = { modHubAssistModName: 'name', modHubAssistVersion: 'version', modHubAssistBaseline: 'baselineHash', modHubAssistSummary: 'summary', modHubAssistScript: 'script', modHubAssistEvidence: 'evidence', modHubAssistVerification: 'verification', modHubAssistIssueId: 'issueId' }[target.id]; if (key) { if (key === 'baselineHash' && !target.value.trim()) delete p[key]; else p[key] = target.value; } }
        operationPreview = ''; save(); const send = host.querySelector('[data-assist-action="send-operation"]'); if (send) send.disabled = true;
        const previous = host.querySelector('#modHubAssistOperationPreview'); if (previous) setText(previous, '内容已变更，请重新预览。');
    }
    function mount(nextHost, nextRole, back) {
        unmount(); role = nextRole === 'helper' ? 'helper' : 'player'; host = nextHost; onBack = back; notice = ''; noticeError = false; atBottom = true;
        try { if (!load()) notice = '加载器存储尚未就绪，请稍后重新进入。'; } catch (error) { report(error); }
        if (!host) return;
        host.oninput = host.onchange = event => { try { capture(event); } catch (error) { report(error); } };
        host.onkeydown = event => {
            if (event.target.id !== 'modHubAssistChat' || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (event.repeat || working || !event.target.value.trim()) return;
            return act(sendChat, '#modHubAssistChat');
        };
        host.onclick = event => {
            const target = event.target.closest?.('[data-assist-action]'), action = target?.dataset.assistAction;
            if (!action || working) return;
            const record = current();
            const actions = {
                back: () => { const callback = onBack; unmount(); callback?.(); },
                'current-role': () => mount(host, (current() || state.pending).role, onBack),
                'create-code': () => createCode(), 'retry-create': () => createCode(true), regenerate: () => createCode(true),
                'copy-code': async () => { if (!navigator.clipboard?.writeText) fail('当前浏览器无法自动复制，请选择上方协助码手动复制。'); await navigator.clipboard.writeText(state.pending.invite.code); notice = '协助码已复制。'; },
                'cancel-invite': async () => { if (!await retireInvite(state.pending)) return; state.pending = null; save(); notice = '待连接协助已取消。'; },
                lookup: lookupCode, join: () => join(), 'retry-join': () => join(true), 'change-code': () => { lookup = null; },
                'chat-send': sendChat, 'preview-operation': previewOperation, 'send-operation': sendOperation,
                preview: prepareCommand, execute, 'cancel-command': cancelCommand, 'discard-preview': () => { preview = null; revision++; },
                pause: () => sessionAction('pause'), resume: () => sessionAction('resume'), close: () => sessionAction('close'), verify: () => sessionAction('verify'),
                'prepare-spell': prepareSpellCandidate,
                'view-message': () => viewMessage(target.dataset.id), 'hide-detail': () => { detailMessage = null; },
                'download-backup': () => window.modHubGameCommand.download(target.dataset.id),
                'use-source': () => useSource(Number(target.dataset.index)), 'use-issue': () => useIssue(Number(target.dataset.index)),
                'add-change': () => { const changes = record.draft.payload.changes; if (changes.length >= 8) fail('单个补丁最多八个片段。'); changes.push({ path: '', before: '', after: '', reason: '' }); operationPreview = ''; save(); },
                'remove-change': () => { record.draft.payload.changes.splice(Number(target.dataset.index), 1); operationPreview = ''; save(); },
                reconcile: () => reconcile(target.dataset.id),
                'read-latest': () => { atBottom = true; markRead(); },
                reload: () => { preview = null; revision++; return window.modHubOfferReload?.('请先保存游戏进度，再重新载入验证。远程协助会自动恢复收信，不自动执行操作。'); },
                restore: () => { preview = null; revision++; return window.modHubRestore.showHistory(); },
                'new-session': () => { state.history.unshift({ role: record.role, session: record.session, entries: Object.values(record.entries).map(entry => ({ kind: entry.kind, summary: entry.summary || '结果待核验', pointId: entry.pointId || null, saved: entry.saved === true, backupId: entry.backupId || null, at: entry.at })) }); state.history = state.history.slice(0, 10); state.current = null; preview = null; detailMessage = null; save(); }
            };
            const detailId = detailMessage?.id;
            const destinations = { 'chat-send': '#modHubAssistChat', 'read-latest': '#modHubAssistConversation', 'use-source': '.modhub-assist-tools', 'use-issue': '.modhub-assist-tools',
                lookup: '.modhub-assist-card', 'change-code': '#modHubAssistCode', 'create-code': '#modHubAssistInviteCode', 'retry-create': '#modHubAssistInviteCode', regenerate: '#modHubAssistInviteCode',
                join: '#modHubAssistSessionHeader', 'retry-join': '#modHubAssistSessionHeader', 'discard-preview': '#modHubAssistChat', 'add-change': '.modhub-assist-change:last-of-type', 'remove-change': '.modhub-assist-tools', 'new-session': '.modhub-assist-header',
                'hide-detail': () => [...host.querySelectorAll('[data-assist-action="view-message"]')].find(button => button.dataset.id === detailId) || '#modHubAssistConversation' };
            if (actions[action]) return act(actions[action], destinations[action]);
        };
        markRead(); render(true); reveal('.modhub-assist-header'); notify(); start();
    }
    function unmount() {
        if (host) { host.onclick = host.oninput = host.onchange = host.onkeydown = null; }
        host = null; onBack = null; preview = null; detailMessage = null; operationPreview = ''; renderedSession = ''; renderedDetail = null; revision++;
    }
    function start() {
        try { if (!load()) return false; } catch (error) { report(error); return false; }
        receive().catch(report); schedule(); return true;
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) { preview = null; revision++; } else { markRead(); render(); } schedule(); });
    window.addEventListener('pagehide', () => { preview = null; revision++; clearTimeout(timer); timer = null; });
    window.addEventListener('modhub:languagechange', () => {
        window.modHubLocalizeOwned?.(host);
        host?.querySelectorAll('[data-modhub-assist-date]').forEach(node => {
            node.textContent = new Date(Number(node.getAttribute('data-modhub-assist-date'))).toLocaleString(window.modHubGetLanguage?.());
        });
    });
    window.modHubRemoteAssist = { mount, unmount, start, getSummary, isBusy: () => working };
    start();
})();
