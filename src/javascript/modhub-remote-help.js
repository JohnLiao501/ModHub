/** ModHub 远程协助：本机预览、逐次确认与可暂停的资料往返。 */
(function() {
    'use strict';
    const MODHUB_REMOTE_ORIGIN = 'https://dolmod-release-index.johnliao381658675.workers.dev';
    const MODHUB_REMOTE_LIMIT = 1024 * 1024;
    const labels = { collectDiagnostics: '收集诊断', readSources: '读取源码', applyPatch: '应用补丁', applyConfiguration: '修复配置' };
    const copy = value => JSON.parse(JSON.stringify(value));
    const detail = error => String(error?.message || error || '未提供具体原因');
    const json = value => JSON.stringify(value);
    const bytes = value => new TextEncoder().encode(value);
    const fail = message => { throw new Error(message); };
    let state = null, storageKey = '', host = null, panel = null, observer = null;
    let active = false, working = false, polling = false, timer = null, controller = null, revision = 0, failures = 0;
    let pending = null, preview = null, lookup = null, message = '输入开发者提供的八位修复码，预览后决定是否加入。';

    function randomToken() {
        if (!window.crypto?.getRandomValues || !window.crypto?.subtle) fail('当前浏览器未提供安全随机数或 SHA-256，无法开启远程协助。');
        return [...window.crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
    }

    async function digest(value) {
        const result = await window.crypto.subtle.digest('SHA-256', bytes(json(value)));
        return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
    }

    function load() {
        const identity = window.modHubRestore?.getStorageIdentity?.();
        if (!identity?.dbName || !identity?.storeName) fail('加载器存储尚未就绪，暂时无法保存独立的协助记录。');
        const key = 'modhub_remote_help:' + json([identity.dbName, identity.storeName]);
        if (key === storageKey && state) return;
        if (active) pause('加载器存储已变化，协助已暂停。');
        const saved = localStorage.getItem(key);
        const next = saved ? JSON.parse(saved) : { entries: {}, history: [] };
        if (!next || typeof next !== 'object' || Array.isArray(next) || !next.entries || !Array.isArray(next.history)) fail('本机协助记录无法读取，请保留本机数据并联系开发者。');
        state = next; storageKey = key;
    }

    function save() {
        if (!state || !storageKey) fail('协助记录尚未就绪。');
        localStorage.setItem(storageKey, json(state));
    }

    async function readResponse(response) {
        if (!response.body?.getReader) {
            const raw = await response.text();
            if (bytes(raw).length > MODHUB_REMOTE_LIMIT) fail('协助服务返回的内容超过 1 MiB。');
            return raw;
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let length = 0, raw = '';
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done) return raw + decoder.decode();
                length += item.value.byteLength;
                if (length > MODHUB_REMOTE_LIMIT) fail('协助服务返回的内容超过 1 MiB。');
                raw += decoder.decode(item.value, { stream: true });
            }
        } finally { await reader.cancel().catch(() => {}); }
    }

    async function api(path, body, options = {}) {
        const identity = window.modHubRestore?.getStorageIdentity?.();
        if (storageKey !== 'modhub_remote_help:' + json([identity?.dbName, identity?.storeName])) fail('加载器存储身份已变化，请重新打开远程协助。');
        const serialized = body === undefined ? undefined : json(body);
        if (serialized && bytes(serialized).length > MODHUB_REMOTE_LIMIT) fail('本次资料超过 1 MiB，请缩小请求范围；未截断或发送。');
        const abort = new AbortController();
        const cancel = () => abort.abort();
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) abort.abort();
        const timeout = setTimeout(cancel, 30000);
        let response, raw;
        try {
        response = await fetch(MODHUB_REMOTE_ORIGIN + '/remote-assistance' + path, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
            headers: { ...(serialized ? { 'Content-Type': 'application/json' } : {}),
                ...(!options.public && state?.token ? { Authorization: 'Bearer ' + state.token } : {}) },
            body: serialized, signal: abort.signal, keepalive: options.keepalive === true
        });
        raw = await readResponse(response);
        } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel); }
        if (bytes(raw).length > MODHUB_REMOTE_LIMIT) fail('协助服务返回的内容超过限制。');
        let value;
        try { value = JSON.parse(raw); } catch (_) { fail('协助服务返回了无法读取的内容。'); }
        if (!response.ok) { const error = new Error((value.error || '协助服务暂时不可用。') + (value.details ? '\n具体原因：' + (typeof value.details === 'string' ? value.details : json(value.details)) : '')); error.status = response.status; throw error; }
        return value;
    }

    function sessionPath() {
        if (!state?.session?.id) fail('请先加入一个协助方案。');
        return '/sessions/' + encodeURIComponent(state.session.id);
    }

    const mounted = () => host?.isConnected !== false && panel?.open === true && document.getElementById('modHubHelpRemoteContent') === host;
    function redactResultText(value) {
        if (typeof window.modHubAiRepair?.sanitizeText !== 'function' || typeof window.modHubHelp?.redactRemoteCredentials !== 'function') fail('结果脱敏模块尚未就绪，请重新打开帮助中心后继续。');
        return window.modHubHelp.redactRemoteCredentials(window.modHubAiRepair.sanitizeText(String(value)));
    }
    function assertActive(ticket) {
        if (!active || ticket !== revision || !mounted()) fail('协助已暂停。请重新进入并点击继续协助，再预览操作。');
    }

    function pause(reason = '协助已暂停。点击继续协助后，重新预览待处理操作。') {
        const wasActive = active;
        active = false; revision++; clearTimeout(timer); timer = null;
        controller?.abort(); controller = null; preview = null; pending = null; message = reason;
        if (wasActive && state?.session && state.session.status !== 'closed') {
            state.session.status = 'paused';
            try { save(); } catch (_) {}
            api(sessionPath() + '/pause', {}, { keepalive: true }).catch(() => {});
        }
        render();
    }

    function schedule() {
        clearTimeout(timer);
        if (!active) return;
        const delay = failures ? Math.min(60000, 5000 * 2 ** failures) : document.hidden ? 30000 : 5000;
        timer = setTimeout(() => poll().catch(report), delay);
    }

    function report(error) {
        message = detail(error);
        if ([401, 403, 404, 410].includes(error?.status)) {
            if (state?.session) {
                state.unavailable = true;
                if ([404, 410].includes(error.status)) { state.session.status = 'closed'; state.localOnlyClosed = true; }
                try { save(); } catch (_) {}
            }
            pause(message + ' 协助已停止，请向开发者核对。');
        }
        render();
    }

    async function validate(command) {
        if (!command || !Object.hasOwn(labels, command.kind) || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) fail('此协助操作不受支持。');
        if (await digest({ kind: command.kind, payload: command.payload }) !== command.digest) fail('操作内容与发布摘要不一致，已拒绝处理。');
        const p = command.payload;
        const allowed = { collectDiagnostics: ['allLogs'], readSources: ['name', 'paths'], applyPatch: ['name', 'version', 'baselineHash', 'summary', 'evidence', 'verification', 'changes'], applyConfiguration: ['issueId'] }[command.kind];
        if (Object.keys(p).some(key => !allowed.includes(key))) fail('操作包含未支持的字段，已拒绝处理。');
        if (command.kind === 'collectDiagnostics' && p.allLogs !== undefined && typeof p.allLogs !== 'boolean') fail('日志选择格式无效。');
        if (['readSources', 'applyPatch'].includes(command.kind) && (typeof p.name !== 'string' || !p.name || p.name.length > 256)) fail('操作缺少精确模组技术名。');
        if (command.kind === 'readSources' && (!Array.isArray(p.paths) || !p.paths.length || p.paths.length > 20 || p.paths.some(path => typeof path !== 'string'))) fail('源码请求必须包含 1 至 20 个已声明路径。');
        if (command.kind === 'applyPatch' && (typeof p.version !== 'string' || !p.version || !Array.isArray(p.changes) || !p.changes.length || p.changes.length > 8
            || p.changes.some(change => !change || typeof change.path !== 'string') || p.baselineHash !== undefined && !/^[a-f0-9]{64}$/.test(p.baselineHash))) fail('补丁的版本、路径或包体摘要格式无效。');
        if (command.kind === 'applyConfiguration' && (typeof p.issueId !== 'string' || !p.issueId || p.issueId.length > 1024)) fail('配置检查条目标识无效。');
    }

    async function flush() {
        for (const [id, entry] of Object.entries(state.entries)) {
            if (['started', 'claim-uncertain'].includes(entry.stage) && !entry.result && !entry.uploaded) await reconcileEntry(id, entry);
            if (!entry.result || entry.uploaded) continue;
            await api(sessionPath() + '/commands/' + encodeURIComponent(id) + '/result', entry.result);
            entry.uploaded = true;
            entry.summary = entry.result.result?.message || ({ sent: '资料已发送', saved: '修改已保存，等待重新载入验证', cancelled: '此次操作已取消', failed: '操作未完成', uncertain: '操作结果待核验' }[entry.result.status] || '结果待核验');
            delete entry.result;
            save();
        }
    }

    async function reconcileEntry(id, entry) {
            const command = (await api(sessionPath() + '/commands/' + encodeURIComponent(id))).command;
            await validate(command);
            if (command.id !== id || entry.digest && command.digest !== entry.digest) { pause('服务端操作与本机记录不一致，已停止协助。'); fail('服务端操作与本机记录不一致，请核对协助历史。'); }
            if (command.status === 'completed') {
                entry.stage = 'done'; entry.uploaded = true; entry.summary = '服务端已有此操作结果。本机记录曾中断，请核对修改和游戏表现。'; save(); return;
            }
            if (command.status === 'queued') {
                entry.stage = 'done'; entry.result = { claimId: '', status: 'cancelled', result: { message: '服务端未登记领取，已取消此次操作并停止后续执行。请核对本机状态；不会自动重做修改。' } };
                save(); return;
            }
            if (command.status !== 'claimed') { pause('操作状态无法核验，已停止协助。'); fail('操作状态无法核验，请联系开发者。'); }
            try {
                const claimed = (await api(sessionPath() + '/commands/' + encodeURIComponent(id) + '/claim', { digest: command.digest, claimId: entry.claimId })).command;
                if (claimed.id !== id || claimed.digest !== command.digest) fail('领取记录与本机记录不一致。');
            } catch (error) {
                if (error.status === 409) pause('领取记录或会话状态已变化，已停止协助。请核对本机历史。');
                throw error;
            }
            let evidence = '操作在上次页面中断，未自动重试。';
            try {
                const v = entry.verification;
                if (v?.name) {
                    const current = await window.modHubReadInstalledModPackage(v.name);
                    if (!current?.data || current.error) throw current?.error || new Error('无法读取目标包体。');
                    const hash = await window.modHubAiPackage.hash(current.data);
                    evidence += hash === v.afterHash ? ' 当前包体与预览后的包体一致。' : hash === v.beforeHash ? ' 当前包体仍与修改前一致。' : ' 当前包体与预览前后均不一致。';
                }
                if (v?.after || v?.enabled) {
                    const lists = await window.modHubReadIndexDBModLists();
                    if (!lists?.ok) throw lists?.error || new Error('无法读取启禁配置。');
                    const expected = v.after || { enabled: v.enabled, disabled: v.disabled };
                    evidence += json([lists.enabled, lists.disabled]) === json([expected.enabled, expected.disabled]) ? ' 当前启禁与顺序符合预览。' : ' 当前启禁或顺序与预览不同。';
                }
            } catch (error) { evidence += ' 核验原因：' + redactResultText(detail(error)); }
            entry.stage = 'done';
            entry.result = { claimId: entry.claimId, status: 'uncertain', result: { message: evidence + ' 请在本机核对并重新载入验证，必要时使用时间点还原。', pointId: entry.pointId || null } };
            save();
    }

    async function reconcile() {
        for (const [id, entry] of Object.entries(state.entries)) if (['started', 'claim-uncertain'].includes(entry.stage) && !entry.result && !entry.uploaded) await reconcileEntry(id, entry);
    }

    async function poll() {
        if (!active) return;
        if (!mounted()) { pause(); return; }
        if (working || polling) { schedule(); return; }
        polling = true;
        const ticket = revision;
        controller = new AbortController();
        try {
            await flush();
            let after = 0, next;
            do {
                const result = await api(sessionPath() + '?after=' + after, undefined, { signal: controller.signal });
                assertActive(ticket);
                state.session = result.session;
                save();
                if (result.session.status !== 'active') { pause(result.session.status === 'closed' ? '此协助已结案。' : '此协助已暂停，请点击继续协助。'); return; }
                const item = result.messages?.find(item => item.type === 'command' && item.status !== 'completed' && !state.entries[item.id]);
                if (item && !pending) {
                    const value = await api(sessionPath() + '/commands/' + encodeURIComponent(item.id), undefined, { signal: controller.signal });
                    assertActive(ticket); await validate(value.command); assertActive(ticket);
                    pending = value.command;
                }
                next = Number(result.nextCursor);
                if (!Number.isSafeInteger(next) || next <= after || pending) break;
                after = next;
            } while (active);
            save(); failures = 0;
            if (!pending && !preview) message = '正在等待开发者操作。每条操作均需您预览并确认。';
            if (!preview) render();
        } catch (error) {
            if (ticket !== revision) return;
            failures++; report(error);
        } finally { controller = null; polling = false; schedule(); }
    }

    async function resume() {
        load();
        if (!mounted()) fail('请先展开远程协助。');
        if (working) fail('上一项操作仍在完成，请稍后继续。');
        const ticket = revision;
        working = true;
        try {
            const result = await api(sessionPath() + '/resume', {});
            state.session = result.session; save();
            if (ticket !== revision || !mounted()) { active = true; pause(); return; }
            await reconcile();
            if (ticket !== revision || !mounted()) { active = true; pause(); return; }
            active = true; revision++; failures = 0; pending = null; preview = null;
            message = '协助已继续，正在核对待处理操作。';
        } finally { working = false; render(); }
        await poll();
    }

    async function findRepair(code) {
        load();
        if (!/^\d{8}$/.test(code)) fail('请输入八位数字修复码。');
        if (state.session && state.session.status !== 'closed') fail('请先结束当前协助，再加入其他方案。');
        const result = await api('/repairs/' + code, undefined, { public: true });
        await validate(result.repair?.initialCommand);
        lookup = result.repair; render();
    }

    async function join() {
        if (!lookup || working) return;
        const selected = lookup;
        if (!await window.modHubConfirm({ title: '加入远程协助', message: '开发者：' + helperName(selected.helper) + '\n方案：' + selected.title + '\n' + selected.description
            + '\n\n加入仅建立独立协助记录。资料与修改仍须逐次预览确认；修改后的代码需要信任开发者。', confirmText: '加入协助', cancelText: '取消' })) return;
        if (!mounted()) fail('远程协助页面已离开，请重新打开后加入。');
        working = true;
        try {
            if (!state.joinRequest || state.joinRequest.code !== selected.code) {
                state.joinRequest = { code: selected.code, token: randomToken(), requestId: randomToken() };
                save();
            }
            const result = await api('/sessions', state.joinRequest, { public: true });
            await validate(result.command);
            if (result.command.digest !== selected.initialCommand.digest) fail('初始操作与预览不一致，请重新查询修复码。');
            if (state.session) state.history.unshift({ id: state.session.id, helper: state.session.helper, status: 'closed', entries: Object.values(state.entries).map(entry => ({ kind: entry.kind, summary: entry.summary || entry.result?.result?.message || '结果待核验', pointId: entry.pointId || null, at: entry.at })) });
            state = { history: state.history.slice(0, 10), entries: {}, session: result.session, continuationCode: result.continuationCode,
                token: state.joinRequest.token, requestId: state.joinRequest.requestId, continuationExpiresAt: Date.now() + 10 * 60 * 1000 };
            save(); lookup = null;
            if (mounted()) { active = true; revision++; pending = result.command; message = '协助已建立。请预览初始操作；续接码只交给您信任的此方案开发者。'; schedule(); }
            else { active = true; pause(); }
        } finally { working = false; render(); }
    }

    async function prepareCommand() {
        const ticket = revision, command = pending;
        assertActive(ticket);
        if (!command || working) return;
        working = true; render();
        try {
            await validate(command);
            const p = command.payload;
            let text, data, plan, verification;
            if (command.kind === 'collectDiagnostics') {
                const snapshot = await window.modHubHelp.check();
                const report = window.modHubHelp.buildReport(snapshot, { allLogs: p.allLogs === true });
                if (!report) fail('检查结果已过期，请重新预览。');
                if (typeof window.modHubAiRepair.sanitizeText !== 'function') fail('日志脱敏模块尚未就绪。');
                const sanitize = redactResultText;
                data = { report: sanitize(report), issues: snapshot.issues.filter(item => sanitize(item.id) === item.id)
                    .map(item => ({ id: item.id, title: sanitize(item.title), repairable: Boolean(item.repair) })) };
                text = JSON.stringify(data, null, 2);
            } else if (command.kind === 'readSources' || command.kind === 'applyPatch') {
                const paths = command.kind === 'readSources' ? p.paths : [...new Set(p.changes.map(item => item.path))];
                const prepared = await window.modHubAiRepair.prepare(p.name, '远程协助：' + labels[command.kind], { paths, source: 'remoteRepair' });
                const material = JSON.parse(prepared.material);
                const sourceValues = [material.name, material.version, ...material.files.flatMap(file => [file.path, file.content])];
                if (sourceValues.some(value => window.modHubHelp.redactRemoteCredentials(value) !== value)) fail('所选源码含有您当前使用的 AI 密钥，已停止此次操作。请先移除源码中的凭据，再重新预览；本次未改写源码。');
                if (command.kind === 'readSources') {
                    data = { name: material.name, version: material.version, files: material.files, baselineHash: prepared.hash };
                    text = JSON.stringify(data, null, 2);
                } else {
                    if (prepared.bootJson.version !== p.version || p.baselineHash && p.baselineHash !== prepared.hash) fail('本机模组版本或包体已改变，请让开发者根据当前源码重新提供方案。');
                    plan = await window.modHubAiRepair.previewResponse(prepared, { summary: p.summary, evidence: p.evidence, verification: p.verification, changes: p.changes }, { source: 'remoteRepair' });
                    verification = await window.modHubAiRepair.getVerification(plan);
                    text = [p.summary, '依据：' + p.evidence, '验证：' + p.verification, ...p.changes.map(change => '\n文件：' + change.path + '\n原因：' + change.reason + '\n原文：\n' + change.before + '\n替换为：\n' + change.after)].join('\n\n');
                }
            } else {
                plan = await window.modHubHelp.previewRemoteConfiguration(p.issueId);
                verification = { before: copy(plan.before), after: copy(plan.after) };
                const list = (title, names) => title + '\n' + (names.length ? names.map((name, index) => (index + 1) + '. ' + name).join('\n') : '无');
                text = '根据本机重新检查生成配置修复。\n' + (plan.enableName ? '启用前置：' + plan.enableName + '\n\n' : '\n')
                    + [list('当前启用顺序', plan.before.enabled), list('保存后的启用顺序', plan.after.enabled), list('保存后的禁用列表', plan.after.disabled)].join('\n\n');
            }
            assertActive(ticket);
            if (data && bytes(json({ claimId: '0'.repeat(64), status: 'sent', result: data })).length > MODHUB_REMOTE_LIMIT) fail('完整资料超过 1 MiB，请让开发者缩小请求范围。');
            preview = { command, data, plan, verification, text, ticket };
            message = data ? '请检查下方完整资料。确认后才会发送给开发者。' : '请检查下方修改。确认后先建立时间点，再保存；游戏存档不在还原范围内。';
        } finally { working = false; render(); if (preview) host?.querySelector('#modHubRemotePreview')?.focus(); }
    }

    async function execute() {
        if (!preview || working) return;
        const selected = preview, command = selected.command;
        assertActive(selected.ticket);
        if (state.entries[command.id]) { await flush(); return; }
        working = true; render();
        try {
            if (!await window.modHubConfirm({ title: selected.data ? '确认发送资料' : '确认应用远程修复',
                message: '开发者：' + helperName(state.session.helper) + '\n操作：' + labels[command.kind]
                    + (selected.data ? '\n仅发送刚才预览的资料。' : '\n保存前强制建立时间点，修改后需要重新载入验证。时间点不覆盖游戏存档。'),
                confirmText: selected.data ? '发送资料' : '应用修复', cancelText: '取消' })) return;
            assertActive(selected.ticket); await validate(command); assertActive(selected.ticket);
            const entry = { kind: command.kind, digest: command.digest, claimId: randomToken(), stage: 'started', phase: 'claiming', at: Date.now(), verification: selected.verification || null };
            state.entries[command.id] = entry;
            save();
            const claim = await api(sessionPath() + '/commands/' + encodeURIComponent(command.id) + '/claim', { digest: command.digest, claimId: entry.claimId });
            await validate(claim.command);
            if (claim.command.id !== command.id || claim.command.digest !== command.digest) fail('领取的操作与预览不同，已停止处理。');
            assertActive(selected.ticket);
            entry.phase = 'applying'; save();
            let result;
            if (selected.data) result = { claimId: entry.claimId, status: 'sent', result: selected.data };
            else {
                const applied = command.kind === 'applyPatch' ? await window.modHubAiRepair.apply(selected.plan) : await window.modHubHelp.applyRemoteConfiguration(selected.plan);
                if (applied?.ok) entry.saved = true;
                entry.pointId = applied?.pointId || null;
                save();
                result = { claimId: entry.claimId, status: applied?.ok ? 'saved' : 'failed', result: {
                    message: applied?.ok ? '已保存并回读通过，等待重新载入验证。' : redactResultText(applied?.reason || '修改未完成，请核对本机状态。'),
                    pointId: applied?.pointId || null, verification: applied?.ok ? 'pending-reload' : 'unverified' } };
            }
            entry.stage = 'done'; entry.result = result; save();
            preview = null; pending = null;
            message = result.status === 'saved' ? '修复已保存，等待重新载入验证。可使用时间点还原撤销。' : result.status === 'sent' ? '资料已准备，正在回传。' : result.result.message;
            await flush();
            if (active && result.status === 'sent') message = '资料已发送。未配对前，开发者不能读取此记录。';
        } catch (error) {
            const entry = state.entries[command.id];
            if (entry?.stage === 'started') {
                if (entry.phase === 'claiming') { entry.stage = 'claim-uncertain'; entry.summary = '领取结果待核验，本机未继续执行。'; }
                else {
                    entry.result = { claimId: entry.claimId, status: 'uncertain', result: { message: '操作未能确认完成：' + redactResultText(detail(error)) + '。请核验本机状态，未自动重试。', pointId: entry.pointId || null } };
                    entry.stage = 'done';
                }
                try { save(); } catch (_) {}
                preview = null; pending = null;
            }
            throw error;
        } finally { working = false; render(); schedule(); }
    }

    async function cancelCommand() {
        if (!pending || working) return;
        const command = pending;
        state.entries[command.id] = { kind: command.kind, digest: command.digest, stage: 'done', at: Date.now(),
            result: { claimId: '', status: 'cancelled', result: { message: '玩家取消了此次操作，未发送资料或保存修改。' } } };
        save(); preview = null; pending = null; await flush(); message = '此次操作已取消。'; render();
    }

    async function pair(accept) {
        const ticket = revision;
        assertActive(ticket);
        if (accept && !await window.modHubConfirm({ title: '确认开发者连接', message: helperName(state.session.helper) + ' 请求连接此记录。确认后可查看您已发送的资料，并提交后续操作；每条操作仍需您确认。', confirmText: '允许连接', cancelText: '取消' })) return;
        assertActive(ticket);
        const result = await api(sessionPath() + '/pair', { accept });
        state.session = result.session;
        if (result.continuationCode) { state.continuationCode = result.continuationCode; state.continuationExpiresAt = Date.now() + 10 * 60 * 1000; }
        save(); message = accept ? '已允许开发者连接。' : '原续接码已失效。请将新的续接码交给开发者，再确认连接。'; render();
    }

    async function close(solved = false) {
        if (working) fail('本地操作正在完成回读，请等待结束后再结案。');
        if (!await window.modHubConfirm({ title: solved ? '确认问题已解决' : '结束远程协助', message: solved ? '请确认已重新载入，并重复原操作验证问题已经解决。确认后此协助结案。' : '结案后开发者不能再读取资料或提交操作。已经保存的本机修改不会撤销。', confirmText: solved ? '已验证并结案' : '结束协助', cancelText: '取消' })) return;
        state.session = (await api(sessionPath() + (solved ? '/verify' : '/close'), solved ? { solved: true } : {})).session;
        save(); pause(solved ? '玩家确认问题已解决，此协助已结案。' : '此协助已结案。已保存的修改仍保留。');
    }

    async function detach() {
        if (working || !state?.unavailable) return;
        if (!await window.modHubConfirm({ title: '结束本机连接', message: '当前连接已无法授权，不能确认服务器是否结案。本机将保留操作历史并允许加入新方案；服务记录仍按到期规则清理，已保存的本机修改不会撤销。', confirmText: '结束本机连接', cancelText: '取消' })) return;
        state.session.status = 'closed'; state.localOnlyClosed = true; save(); pause('本机连接已结束，操作历史已保留。未确认服务器结案。');
    }

    function describeCommand(command) {
        const p = command.payload;
        let text = labels[command.kind];
        if (command.kind === 'collectDiagnostics') text += '：版本、模组清单、检查摘要及' + (p.allLogs ? '全部已捕获日志。' : '错误和警告日志。');
        else if (command.kind === 'readSources') text += '：' + p.name + '\n文件：\n' + p.paths.join('\n');
        else if (command.kind === 'applyPatch') text += '：' + p.name + ' ' + p.version + '\n' + p.summary + '\n文件：\n' + [...new Set(p.changes.map(item => item.path))].join('\n');
        else text += '：根据本机重新检查，预览启用唯一前置或整理加载顺序的方案。';
        return text;
    }

    function helperName(helper) { return typeof helper === 'string' ? helper : String(helper?.name || helper?.displayName || helper?.id || '未提供名称'); }
    function render() {
        if (!host) return;
        const escape = value => window.modHubEscapeHtml(String(value ?? ''));
        const button = (action, text, disabled = false) => '<button type="button" class="macro-button modhub-btn-secondary" data-remote-action="' + action + '"' + (disabled || working ? ' disabled' : '') + '>' + text + '</button>';
        const session = state?.session;
        host.innerHTML = '<div class="modhub-remote"><p>由您信任的开发者提供远程帮助。每次发送资料或保存修改前，均须您预览并确认。</p>'
            + '<p class="grey">离开此页、折叠或重新载入后暂停协助，须手动继续。闲置七天后服务记录自动清理。修改后请重新载入验证；撤销使用时间点还原，不包含游戏存档。</p>'
            + '<p><a href="' + MODHUB_REMOTE_ORIGIN + '/assist" target="_blank" rel="noopener noreferrer">开发者入口</a></p>'
            + '<p class="gold" role="status">' + escape(message) + '</p>'
            + (!session || session.status === 'closed' ? '<label>输入修复码<input id="modHubRemoteCode" inputmode="numeric" autocomplete="off" maxlength="8" pattern="[0-9]{8}" aria-label="八位数字修复码"></label><div class="modhub-help-actions">' + button('lookup', '查看方案') + '</div>' : '')
            + (lookup ? '<section><h4>' + escape(lookup.title) + '</h4><p>开发者：' + escape(helperName(lookup.helper)) + '</p><p>' + escape(lookup.description) + '</p><pre tabindex="0">' + escape(describeCommand(lookup.initialCommand)) + '</pre>' + button('join', '确认加入协助') + '</section>' : '')
            + (session ? '<section><h4>当前协助</h4><p>开发者：' + escape(helperName(session.helper)) + '；状态：' + (session.status === 'closed' ? state.localOnlyClosed ? '本机连接已结束' : '已结案' : active ? '协助中' : '已暂停') + '</p>'
                + (session.status !== 'closed' ? (session.pairing === 'paired' ? '<p>开发者已连接，仍须逐次确认操作。</p>' : '<p>续接码：<strong class="gold">' + escape(state.continuationCode) + '</strong></p><p class="grey">续接码生成后十分钟内有效，仅交给此方案开发者。过期后可重新生成；连接前仍须您确认。</p>') + '<p class="grey">暂停保留记录与连接关系。</p><div class="modhub-help-actions">'
                    + button(active ? 'pause' : 'resume', active ? '暂停协助' : '继续协助') + (session.pairing === 'unpaired' && active ? button('renew-code', '重新生成续接码') : '') + (state.unavailable ? button('detach', '结束本机连接') : button('close', '结束协助')) + '</div>' : '')
                + (session.pairing === 'pending' && active ? '<p>开发者请求连接，允许后可读取已发送资料。</p><div class="modhub-help-actions">' + button('pair', '允许连接') + button('reject-pair', '拒绝连接') + '</div>' : '') + '</section>' : '')
            + (pending && active ? '<section><h4>待处理：' + escape(labels[pending.kind]) + '</h4><pre tabindex="0">' + escape(describeCommand(pending)) + '</pre><div class="modhub-help-actions">' + button('preview', '在本机整理并预览') + button('cancel', '拒绝此次操作') + '</div></section>' : '')
            + (preview && active ? '<section><h4>' + (preview.data ? '将发送的完整资料' : '将保存的修改') + '</h4><textarea id="modHubRemotePreview" class="modhub-help-report" readonly aria-label="远程协助完整预览">' + escape(preview.text) + '</textarea><div class="modhub-help-actions">' + button('execute', preview.data ? '确认发送资料' : '确认保存修改') + '</div></section>' : '')
            + (session ? '<details><summary>本机协助历史</summary><ul>' + Object.values(state.entries).map(entry => '<li>' + escape(labels[entry.kind]) + '：' + escape(entry.summary || entry.result?.result?.message || '结果待核验或回传') + '</li>').join('') + '</ul></details>' : '')
            + (state?.history.length ? '<details><summary>此前的本机协助记录</summary><ul>' + state.history.map(item => '<li>' + escape(helperName(item.helper)) + '<ul>' + item.entries.map(entry => '<li>' + escape(labels[entry.kind]) + '：' + escape(entry.summary) + '</li>').join('') + '</ul></li>').join('') + '</ul></details>' : '')
            + (session && Object.values(state.entries).some(entry => entry.verification) ? '<div class="modhub-help-actions">' + button('reload', '重新载入以验证') + button('restore', '查看时间点还原')
                + (session.status !== 'closed' ? button('solved', '已重新载入验证，问题已解决') : '') + '</div>' : '') + '</div>';
    }

    function mount(nextHost, nextPanel) {
        pause(); observer?.disconnect();
        host = nextHost; panel = nextPanel; lookup = null;
        try { load(); } catch (error) { message = detail(error); }
        render();
        panel?.addEventListener('toggle', () => { if (!panel.open) pause(); });
        if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(() => { if (active && !mounted()) pause(); });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        host.onclick = event => {
            const action = event.target.closest?.('[data-remote-action]')?.dataset.remoteAction;
            if (!action || working) return;
            const operations = {
                lookup: () => findRepair(host.querySelector('#modHubRemoteCode').value.trim()), join, resume, pause,
                preview: prepareCommand, execute, cancel: cancelCommand, pair: () => pair(true), 'reject-pair': () => pair(false), 'renew-code': () => pair(false),
                close: () => close(false), solved: () => close(true), detach,
                reload: async () => { pause(); await window.modHubOfferReload?.(Object.values(state.entries).some(entry => entry.saved) ? '远程修复已保存。请先保存游戏进度，再重新载入验证。' : '远程操作结果仍需核验。请先核对当前配置并保存游戏进度，再决定是否重新载入。'); },
                restore: () => { pause(); return window.modHubRestore.showHistory(); }
            };
            if (operations[action]) return Promise.resolve().then(operations[action]).catch(report);
        };
    }

    window.addEventListener('pagehide', () => pause('页面已离开，协助已暂停。'));
    document.addEventListener('visibilitychange', schedule);
    window.modHubRemoteHelp = { mount, pause };
})();
