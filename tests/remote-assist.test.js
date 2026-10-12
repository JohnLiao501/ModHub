// 匿名远程协助：单码连接、收信边界及本机执行记录。
const { assert, createBaseSandbox, createStubElement, loadScripts, readStyles, bootJson } = require('./helpers');
const { webcrypto, createHash } = require('node:crypto');
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const settle = () => new Promise(resolve => setImmediate(resolve));
const MODHUB_TEST_KEY = 'modhub_remote_assist:["game","mods"]';
const patch = { name: 'Example', version: '1.0.0', baselineHash: 'a'.repeat(64), summary: '修正取值', evidence: '源码依据', verification: '重新载入核验', changes: [{ path: 'main.js', before: '= 1', after: '= 2', reason: '修复' }] };

async function fixture(options = {}) {
    const role = options.role || 'player';
    const command = { id: 'command-1', seq: 2, kind: options.kind || 'collectDiagnostics', payload: options.payload || { allLogs: false }, status: 'queued' };
    command.digest = digest({ kind: command.kind, payload: command.payload });
    if (options.badDigest) command.digest = '0'.repeat(64);
    const invite = { id: 'invite-1', code: '1234567890', status: 'active', helper: { displayName: '测试协助者', verified: false }, expiresAt: Date.now() + 600000 };
    const session = { id: 'session-1', status: options.sessionStatus || 'active', role, helper: invite.helper, player: { displayName: '玩家' }, description: '', expiresAt: Date.now() + 604800000, verification: options.sessionVerification || null };
    const stats = { requests: [], saves: [], confirmations: [], alerts: [], results: [], applies: 0, checks: 0, preparations: [], events: [], scheduledTimers: [], scrolls: [], restoreCalls: [], patchReads: [], spellSubmissionArgs: [] };
    const timers = new Map(); let timerId = 0;
    const storage = options.storage || new Map();
    const messages = options.messages || [{ id: 'text-1', seq: 1, type: 'text', sender: role === 'helper' ? 'player' : 'helper', text: '<script>测试</script>' }, ...(options.commands === false ? [] : [{ ...command, type: 'command', sender: 'helper', payload: undefined }])];
    if (!options.empty && !storage.has(MODHUB_TEST_KEY)) storage.set(MODHUB_TEST_KEY, JSON.stringify({ current: { role, token: '1'.repeat(64), session, messages: [], after: 0, readSeq: 0, unread: 0, entries: {}, draft: { kind: 'collectDiagnostics', payload: { allLogs: false } }, chatDraft: '' }, pending: null, history: [] }));
    const host = createStubElement(); host.isConnected = true; host.getClientRects = () => options.hostHidden ? [] : [{}];
    const viewport = createStubElement(); viewport.id = 'customOverlayContent'; viewport.scrollHeight = 2000; viewport.clientHeight = 500; viewport.scrollTop = 0;
    host.parentNode = host.parentElement = viewport;
    if (options.recreateDom) {
        let markup = '';
        Object.defineProperty(host, 'innerHTML', { get: () => markup, set: value => {
            markup = value;
            for (const element of Object.values(host._queryCache || {})) element.isConnected = false;
            host._queryCache = {}; viewport.scrollTop = 0;
        } });
    }
    const sb = createBaseSandbox({
        crypto: webcrypto, TextEncoder, TextDecoder, AbortController, Uint8Array,
        ...(options.trackTimers ? { setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); stats.scheduledTimers.push(delay); return id; }, clearTimeout: id => timers.delete(id) } : {}),
        navigator: { clipboard: { writeText: async value => { stats.copied = value; } } },
        CustomEvent: function(type, value) { this.type = type; this.detail = value.detail; },
        dispatchEvent: event => stats.events.push(event),
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => {
            if (options.storageFails) throw new Error('本机存储空间不足');
            storage.set(key, value); stats.saves.push(JSON.parse(value));
        } },
        modHubEscapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        modHubOpenSpellSubmission: (...args) => { stats.spellSubmissionArgs.push(args); return Promise.resolve(false); },
        modHubRestore: {
            getStorageIdentity: () => ({ dbName: 'game', storeName: 'mods' }), showHistory: async () => {},
            createOperation: meta => { stats.restoreCalls.push('create'); stats.restoreMeta = meta; return {}; },
            prepare: async context => {
                stats.restoreCalls.push('prepare');
                if (options.restorePrepareError) throw new Error('时间点写入失败');
                context.pointId = 'js-point-1'; options.onRestorePrepare?.(); return true;
            },
            finish: async context => { stats.restoreCalls.push('finish'); if (options.restoreFinishError) context.finishError = new Error('时间点收尾回读失败'); if (options.restoreFinishThrow) throw new Error('时间点收尾异常'); },
            release: () => { stats.restoreCalls.push('release'); }
        },
        modHubConfirm: async value => { stats.confirmations.push(value); options.onConfirm?.(value); return options.confirm !== false && !(value.confirmText === '已核对风险，继续' && options.riskConfirm === false); },
        modHubAlert: async (message, title) => { stats.alerts.push({ message, title }); },
        modHubReadInstalledModPackage: async () => ({ data: new Uint8Array([2]) }),
        modHubReadIndexDBModLists: async () => ({ ok: true, enabled: ['Example'], disabled: [] }),
        modHubAiPackage: { hash: async () => 'b'.repeat(64), read: async () => ({ text: async path => { stats.patchReads.push(path); options.onPatchRead?.(); return options.patchSource || 'const test = 2;'; } }) },
        modHubGameCommand: {
            prepare: async p => { stats.gamePrepares = (stats.gamePrepares || 0) + 1; options.onGamePrepare?.(); return { text: p.summary + '\n' + p.script + '\n' + p.verification, stamp: 'game-stamp' }; },
            run: async (p, stamp, id, guard) => {
                stats.gameRuns = (stats.gameRuns || 0) + 1; stats.gameStamp = stamp; stats.gameId = JSON.parse(id);
                stats.gameBackupJournal = JSON.parse(storage.get(MODHUB_TEST_KEY)).current.entries[command.id]; options.onGameBackup?.();
                guard(options.noGameBackup ? undefined : 'modhub-game-' + 'a'.repeat(64));
                stats.runJournal = JSON.parse(storage.get(MODHUB_TEST_KEY)).current.entries[command.id];
                if (!options.noGameBackup) stats.gameExecutions = (stats.gameExecutions || 0) + 1;
                if (options.gameDrop) throw new Error('脚本运行时页面中断'); options.onGameRun?.();
                return { ok: !options.gameError, backupId: options.noGameBackup ? null : 'modhub-game-' + 'a'.repeat(64), ...(options.gameError ? { error: '本机私密游戏内容' } : {}) };
            },
            download: async id => { stats.download = id; }
        },
        modHubHelp: {
            redactRemoteCredentials: value => options.knownKey ? String(value).split(options.knownKey).join('[已隐去密钥]') : String(value),
            check: async () => { stats.checks++; options.onCheck?.(); return { issues: [{ id: 'dependency-X', title: '前置缺失', repair: {} }] }; },
            buildReport: () => options.report || '诊断 token=private',
            previewRemoteConfiguration: async issueId => { stats.configIssue = issueId; return { issueId, before: { enabled: ['Example'], disabled: [] }, after: { enabled: ['Required', 'Example'], disabled: [] } }; },
            applyRemoteConfiguration: async (_plan, { onPrepared } = {}) => {
                await onPrepared?.('point-1'); stats.applies++; options.onApply?.(); return options.applyResult || { ok: true, pointId: 'point-1' };
            }
        },
        modHubAiRepair: {
            sanitizeText: text => text.replace('private', '[已隐藏]'),
            prepare: async (name, description, settings) => {
                stats.preparations.push({ name, settings }); options.onPrepare?.();
                return { name, bootJson: { version: '1.0.0' }, hash: 'a'.repeat(64), baselineData: '不可上传的原包', material: JSON.stringify({ name, version: '1.0.0', files: [{ path: 'main.js', content: options.source || 'const test = 1;' }] }) };
            },
            previewResponse: async (prepared, response, settings) => { stats.previewSource = settings.source; return { response, data: new Uint8Array([3]) }; },
            getVerification: async () => ({ name: 'Example', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), enabled: ['Example'], disabled: [] }),
            apply: async (_plan, { onPrepared } = {}) => {
                await onPrepared?.('point-1'); stats.preApplyJournal = JSON.parse(storage.get(MODHUB_TEST_KEY)).current.entries[command.id];
                stats.applies++; options.onApply?.(); return options.applyResult || { ok: true, pointId: 'point-1' };
            }
        },
        fetch: async (url, init) => {
            const endpoint = url.split('/remote-assistance')[1], body = init.body ? JSON.parse(init.body) : undefined;
            stats.requests.push({ endpoint, method: init.method, headers: init.headers, credentials: init.credentials, cache: init.cache, body });
            if (options.pollError && endpoint.includes('?after=')) throw new Error('收信网络中断');
            if (options.chatError && endpoint.endsWith('/text')) throw new Error('发送网络中断');
            let result, status = 200;
            if (endpoint === '/direct/invites') {
                stats.created = body;
                if (options.createDrop && !stats.createDropped) { stats.createDropped = true; throw new Error('创建响应丢失'); }
                result = { invite, session: null };
            }
            else if (endpoint.startsWith('/direct/codes/')) result = { invite };
            else if (endpoint === '/direct/invites/invite-1') result = { invite, session: options.consumeInvite ? session : null };
            else if (endpoint.endsWith('/cancel')) { if (options.cancelStatus) { status = options.cancelStatus; result = { error: '协助码已不可取消' }; } else { invite.status = 'cancelled'; result = { invite, session: null }; } }
            else if (endpoint === '/direct/sessions') {
                stats.joinJournal = JSON.parse(storage.get(MODHUB_TEST_KEY)).pending;
                if (options.joinDrop && !stats.joinDropped) { stats.joinDropped = true; throw new Error('连接响应丢失'); }
                if (options.joinStatus) { status = options.joinStatus; result = { error: '协助码已使用或过期' }; }
                else { session.role = 'player'; result = { session }; }
            } else if (endpoint.endsWith('/text')) { result = { message: { id: 'own-text-' + stats.requests.length, seq: messages.length + 1, type: 'text', sender: role, text: body.text } }; }
            else if (endpoint === '/direct/sessions/session-1/commands') { stats.sentOperation = body; result = { command: { ...command, kind: body.kind, payload: body.payload } }; }
            else if (endpoint.endsWith('/claim')) {
                stats.claimJournal = JSON.parse(storage.get(MODHUB_TEST_KEY)).current.entries[command.id];
                if (options.claimDrop) throw new Error('领取响应丢失');
                command.status = 'claimed'; command.claimId = body.claimId; result = { command }; options.onClaim?.();
            } else if (endpoint.endsWith('/result')) {
                if (options.resultFails) throw new Error('回传网络中断');
                stats.results.push(body); command.status = 'completed'; result = { saved: true };
            } else if (endpoint.endsWith('/pause') || endpoint.endsWith('/resume')) { session.status = endpoint.endsWith('/pause') ? 'paused' : 'active'; result = { session }; }
            else if (endpoint.endsWith('/close') || endpoint.endsWith('/verify')) { session.status = 'closed'; result = { session }; }
            else if (endpoint.includes('/commands/')) result = { command };
            else if (endpoint.includes('/messages/')) result = { message: options.detailMessage };
            else if (endpoint.includes('?after=')) {
                const after = Number(endpoint.split('?after=')[1]); const page = messages.filter(item => item.seq > after).slice(0, 20);
                result = { session, messages: page, nextCursor: messages.some(item => item.seq > (page.at(-1)?.seq || after)) ? page.at(-1)?.seq : null };
            } else throw new Error('未预期请求：' + endpoint);
            return { ok: status === 200, status, text: async () => JSON.stringify(result) };
        }
    });
    sb.document.hidden = false;
    sb.document.getElementById = id => id === viewport.id ? viewport : null;
    sb.getComputedStyle = element => ({ overflowY: element === viewport ? 'auto' : 'visible', overflowX: 'visible' });
    host.contains = element => Object.values(host._queryCache || {}).includes(element);
    const focus = host.querySelector.bind(host);
    host.querySelector = selector => {
        const element = focus(selector); element.focus = () => { stats.focused = selector; sb.document.activeElement = element; }; element.isConnected = true;
        element.scrollIntoView = options => { stats.scrolls.push({ selector, options }); };
        if (options.recreateDom && !element._domInitialized) {
            element._domInitialized = true; element.id = selector.startsWith('#') ? selector.slice(1) : '';
            const idPattern = element.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tag = new RegExp('<([a-z][a-z0-9]*)\\b[^>]*\\bid="' + idPattern + '"[^>]*>', 'i').exec(host.innerHTML);
            element.tagName = tag ? tag[1].toUpperCase() : 'BUTTON';
            const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
            if (element.tagName === 'TEXTAREA') element.value = decode(new RegExp('<textarea\\b[^>]*\\bid="' + idPattern + '"[^>]*>([\\s\\S]*?)</textarea>', 'i').exec(host.innerHTML)?.[1] || '');
            else if (element.tagName === 'INPUT') element.value = decode(/\bvalue="([^"]*)"/.exec(tag[0])?.[1] || '');
            element.selectionStart = element.selectionEnd = 0; element.selectionDirection = 'none'; element.scrollTop = 0; element.scrollLeft = 0;
            element.setSelectionRange = (start, end, direction) => { element.selectionStart = start; element.selectionEnd = end; element.selectionDirection = direction; };
            if (selector === '#modHubAssistConversation') { element.scrollHeight = 1000; element.clientHeight = 300; }
        }
        return element;
    };
    if (options.recreateDom) host.querySelectorAll = selector => Object.values(host._queryCache || {}).filter(element => selector.split(',').some(part => {
        const match = part.trim(); return match === '[id]' && element.id || match.toUpperCase() === element.tagName || match === '#' + element.id;
    }));
    loadScripts(sb, ['javascript/modhub-remote-protocol.js', 'javascript/modhub-remote-assist.js']);
    await settle();
    const mount = nextRole => sb.modHubRemoteAssist.mount(host, nextRole || role, () => { stats.back = true; });
    const action = async (name, data = {}) => { await host.onclick({ target: { closest: () => ({ dataset: { assistAction: name, ...data } }) } }); await settle(); };
    const set = (id, value, change = true) => { const element = host.querySelector('#' + id); element.id = id; element.value = value; if (change) host.oninput?.({ target: element }); return element; };
    const tick = async () => { await settle(); sb.modHubRemoteAssist.start(); await settle(); };
    const key = async (event = {}) => {
        let prevented = false;
        await host.onkeydown?.({ target: host.querySelector('#modHubAssistChat'), key: 'Enter', preventDefault: () => { prevented = true; }, ...event }); await settle(); return prevented;
    };
    const saved = () => JSON.parse(storage.get(MODHUB_TEST_KEY));
    return { sb, stats, storage, host, viewport, command, session, invite, messages, options, timers, mount, action, set, tick, key, saved };
}

module.exports = async function runRemoteAssistTests() {
    {
        const f = await fixture();
        assert.deepEqual(plain(f.sb.modHubRemoteAssist.getSummary()), { role: 'player', unread: 1, pending: 1, status: 'active' }, '聊天未读与待操作各计一次');
        assert.ok(f.stats.requests.every(item => item.method === 'GET' && item.endpoint.includes('?after=')), '后台只读取摘要邮箱');
        assert.equal(f.stats.checks, 0); assert.equal(f.stats.preparations.length, 0);
        f.mount(); assert.equal(f.sb.modHubRemoteAssist.getSummary().unread, 0);
        assert.match(f.host.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(f.host.innerHTML, /<script>/);
        assert.ok(!f.host.innerHTML.includes('1'.repeat(64)), '界面不呈现匿名凭据');
        f.sb.modHubRemoteAssist.unmount(); f.messages.push({ id: 'text-2', seq: 3, type: 'text', sender: 'helper', text: '新消息' }); await f.tick();
        assert.equal(f.sb.modHubRemoteAssist.getSummary().unread, 1, '离开工作区继续收信');
        assert.ok(f.stats.requests.every(item => item.credentials === 'omit' && item.cache === 'no-store'));
    }
    {
        const f = await fixture({ commands: false, recreateDom: true }); f.mount(); await settle();
        const composer = f.set('modHubAssistChat', '正在输入的草稿'); composer.focus(); composer.setSelectionRange(2, 4, 'forward'); composer.scrollTop = 25;
        const conversation = f.host.querySelector('#modHubAssistConversation'); conversation.scrollTop = 120; conversation.onscroll(); f.viewport.scrollTop = 450;
        const requestCount = f.stats.requests.length;
        f.messages.push({ id: 'focused-text', seq: 2, type: 'text', sender: 'helper', text: '聚焦输入时自动到达' }); await f.tick();
        assert.match(f.host.innerHTML, /聚焦输入时自动到达/, '聚焦聊天输入时仍自动显示新消息');
        const restored = f.host.querySelector('#modHubAssistChat');
        assert.equal(restored.value, '正在输入的草稿'); assert.equal(f.sb.document.activeElement, restored, '收信保持输入焦点');
        assert.deepEqual([restored.selectionStart, restored.selectionEnd, restored.selectionDirection], [2, 4, 'forward'], '收信保持输入选区');
        assert.equal(restored.scrollTop, 25, '收信保持输入框内滚动');
        assert.equal(f.host.querySelector('#modHubAssistConversation').scrollTop, 120, '上翻旧记录时收信不跳至顶部或底部');
        assert.equal(f.viewport.scrollTop, 450, '收信不改变工作区外层滚动');
        assert.equal(f.sb.modHubRemoteAssist.getSummary().unread, 1, '上翻时保留新消息提示');
        assert.ok(f.stats.requests.slice(requestCount).every(item => item.method === 'GET' && item.endpoint.includes('?after=')), '自动刷新仍仅收信');
        assert.equal(f.stats.checks, 0); assert.equal(f.stats.applies, 0);
    }
    {
        const f = await fixture({ empty: true, role: 'helper', commands: false }); f.mount();
        f.set('modHubAssistName', '名'.repeat(81)); await f.action('create-code');
        assert.equal(f.stats.requests.length, 0, '超长名称前台拒绝'); assert.match(f.host.innerHTML, /80 字/);
        f.set('modHubAssistName', ''); await f.action('create-code');
        assert.equal(f.stats.created.displayName, '协助者'); assert.equal(f.stats.created.token.length, 64);
        assert.match(f.host.innerHTML, /modHubAssistInviteCode/); assert.match(f.host.innerHTML, /此码仅可建立一次连接/);
        assert.doesNotMatch(f.host.innerHTML, /（自填）/, '邀请名称不附带自填后缀');
        await f.action('copy-code'); assert.equal(f.stats.copied, '1234567890');
        f.options.consumeInvite = true; await f.tick();
        assert.equal(f.saved().pending, null); assert.equal(f.saved().current.role, 'helper', '一次性邀约升级为当前会话');
        assert.equal(f.stats.checks, 0);
    }
    {
        const f = await fixture({ empty: true, role: 'helper', createDrop: true, trackTimers: true }); f.mount(); f.set('modHubAssistName', '恢复协助'); await f.action('create-code');
        const firstRequest = f.stats.requests.find(item => item.endpoint === '/direct/invites');
        assert.equal(f.saved().pending.requestId, firstRequest.body.requestId, '创建响应丢失仍保留幂等请求');
        assert.equal(f.saved().pending.token, firstRequest.body.token); assert.equal(f.saved().pending.invite, undefined);
        assert.ok(f.stats.scheduledTimers.includes(30000), '请求超时计时与邮箱轮询计时分开');
        assert.ok(!f.stats.scheduledTimers.includes(2000), '没有邀请码的失败创建不安排重复邮箱重绘');
        assert.equal(f.timers.size, 0, '请求结束后无遗留定时器，等待用户手动重试');
        assert.match(f.host.innerHTML, /重试生成协助码/);
        await f.action('retry-create'); const createRequests = f.stats.requests.filter(item => item.endpoint === '/direct/invites');
        assert.deepEqual(createRequests[1].body, createRequests[0].body, '手动重试复用原名称、凭据和请求编号');
        assert.equal(f.saved().pending.invite.code, '1234567890');
        assert.ok([...f.timers.values()].some(item => item.delay === 2000), '取得邀请码后才开始等待连接的轮询');
    }
    {
        const f = await fixture({ empty: true, joinDrop: true }); f.mount(); f.set('modHubAssistCode', '1234567890'); await f.action('lookup');
        assert.match(f.host.innerHTML, /名称不代表身份认证/); assert.doesNotMatch(f.host.innerHTML, /（自填）/, '核对名称不附带自填后缀'); f.set('modHubAssistProblem', '安装后报错'); await f.action('join');
        const first = f.stats.requests.find(item => item.endpoint === '/direct/sessions');
        assert.equal(f.stats.joinJournal.requestId, first.body.requestId, '连接发送前已保存完整幂等请求');
        await f.action('retry-join'); const joins = f.stats.requests.filter(item => item.endpoint === '/direct/sessions');
        assert.deepEqual(joins[1].body, joins[0].body, '连接丢响应后复用同一凭据、编号和说明');
        assert.doesNotMatch(f.host.innerHTML, /（自填）/, '连接后名称不附带自填后缀');
        assert.ok(f.stats.confirmations.every(item => !item.message.includes('（自填）')), '连接确认框名称不附带自填后缀');
        assert.equal(f.stats.checks, 0, '连接不会自动诊断'); assert.equal(f.stats.confirmations.length, 2);
    }
    for (const joinStatus of [404, 409, 410]) {
        const f = await fixture({ empty: true, joinStatus }); f.mount(); f.set('modHubAssistCode', '1234567890'); await f.action('lookup'); await f.action('join');
        assert.equal(f.saved().pending, null, '明确无效协助码允许更换'); assert.match(f.host.innerHTML, /modHubAssistCode/);
    }
    for (const action of ['regenerate', 'cancel-invite']) {
        const f = await fixture({ empty: true, role: 'helper', cancelStatus: 404 }); f.mount(); await f.action('create-code'); await f.action(action);
        assert.equal(f.saved().current, null, '过期邀请码清理不伪造连接');
        if (action === 'regenerate') assert.equal(f.stats.requests.filter(item => item.endpoint === '/direct/invites').length, 2);
        else assert.equal(f.saved().pending, null);
    }
    {
        const f = await fixture({ empty: true, role: 'helper', cancelStatus: 409 }); f.mount(); await f.action('create-code'); f.options.consumeInvite = true; await f.action('regenerate');
        assert.equal(f.saved().current.role, 'helper'); assert.equal(f.saved().pending, null, '并发连接时返回已有会话');
        assert.equal(f.stats.requests.filter(item => item.endpoint === '/direct/invites').length, 1, '已有连接不生成第二协助码');
    }
    {
        const f = await fixture(); f.mount(); await f.action('preview');
        assert.equal(f.stats.focused, '#modHubAssistPlayerPreview'); assert.equal(f.stats.results.length, 0);
        await f.action('execute'); assert.equal(f.stats.results[0].status, 'sent');
        assert.doesNotMatch(f.stats.confirmations[0].message, /（自填）/, '操作确认框名称不附带自填后缀');
        assert.ok(!JSON.stringify(f.stats.results).includes('private'));
        assert.equal(f.stats.claimJournal.stage, 'started', '领取前登记执行记录');
        assert.equal(f.stats.claimJournal.phase, 'claiming'); assert.equal(f.stats.confirmations[0].confirmText, '发送资料');
        await f.tick(); assert.equal(f.stats.results.length, 1, '后台收信不重复回传');
    }
    {
        const f = await fixture({ kind: 'readSources', payload: { name: 'Example', paths: ['main.js'] } }); f.mount(); await f.action('preview'); await f.action('execute');
        assert.equal(f.stats.preparations[0].settings.source, 'remoteRepair');
        assert.deepEqual(f.stats.results[0].result.files, [{ path: 'main.js', content: 'const test = 1;' }]);
        assert.ok(!JSON.stringify(f.stats.results).includes('不可上传'));
    }
    {
        const f = await fixture({ badDigest: true }); f.mount(); await f.action('preview');
        assert.equal(f.stats.checks, 0); assert.match(f.host.innerHTML, /摘要不一致/);
        assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')));
    }
    {
        const f = await fixture({ kind: 'applyPatch', payload: { ...patch, baselineHash: 'c'.repeat(64) } }); f.mount(); await f.action('preview');
        assert.match(f.host.innerHTML, /包体已改变/); await f.action('execute'); assert.equal(f.stats.applies, 0);
    }
    {
        const f = await fixture({ kind: 'applyPatch', payload: patch }); f.options.onApply = () => f.sb.modHubRemoteAssist.unmount(); f.mount(); await f.action('preview'); await f.action('execute');
        assert.equal(f.stats.applies, 1); assert.equal(f.stats.results.length, 0, '离开后完成本机事务但不后台回传');
        assert.equal(f.saved().current.entries['command-1'].result.status, 'saved');
        await f.tick(); assert.equal(f.stats.results.length, 0);
        f.mount(); await f.action('reconcile', { id: 'command-1' }); await f.action('execute');
        assert.equal(f.stats.applies, 1, '回传中断记录不重新应用补丁'); assert.equal(f.stats.results[0].result.pointId, 'point-1');
        assert.equal(f.stats.confirmations.at(-1).confirmText, '回传结果');
    }
    {
        const f = await fixture({ kind: 'applyConfiguration', payload: { issueId: 'dependency-X' } }); f.mount(); await f.action('preview'); await f.action('execute');
        assert.equal(f.stats.configIssue, 'dependency-X'); assert.equal(f.stats.applies, 1);
        assert.ok(f.stats.claimJournal.verification.after, '持久保留配置回读依据');
    }
    {
        const f = await fixture({ kind: 'readSources', payload: { name: 'Example', paths: ['main.js'] } }); f.mount(); await f.action('preview');
        f.options.knownKey = 'const test = 1;'; await f.action('execute');
        assert.equal(f.stats.results.length, 0); assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')), '分享确认时重新核验当前凭据');
    }
    {
        const f = await fixture({ kind: 'applyPatch', payload: patch }); f.options.onClaim = () => f.sb.modHubRemoteAssist.unmount(); f.mount(); await f.action('preview'); await f.action('execute');
        assert.equal(f.stats.applies, 0, '领取等待期间离开后不开始本机修改'); assert.equal(f.saved().current.entries['command-1'].stage, 'interrupted');
    }
    {
        const f = await fixture(); f.mount(); await f.action('preview'); f.options.onConfirm = () => f.sb.modHubRemoteAssist.unmount(); await f.action('execute');
        assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')), '确认期间离开须重新预览');
        const hidden = await fixture({ hostHidden: true }); hidden.mount(); await hidden.action('preview'); assert.equal(hidden.stats.checks, 0, '隐藏工作区不读取本机资料');
        const changed = await fixture(); changed.options.onCheck = () => changed.sb.modHubRemoteAssist.unmount(); changed.mount(); await changed.action('preview');
        assert.equal(changed.stats.results.length, 0); assert.ok(!changed.stats.requests.some(item => item.endpoint.endsWith('/claim')), '异步整理完成后仍核验前台票据');
    }
    {
        const f = await fixture(); f.mount(); await f.action('preview'); f.options.storageFails = true; await f.action('execute');
        assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')), '本机记录保存失败时领取前阻断'); assert.equal(f.stats.applies, 0);
    }
    {
        const f = await fixture({ resultFails: true }); f.mount(); await f.action('preview'); await f.action('execute');
        const count = f.stats.requests.filter(item => item.endpoint.endsWith('/result')).length;
        f.sb.modHubRemoteAssist.unmount(); await f.tick(); assert.equal(f.stats.requests.filter(item => item.endpoint.endsWith('/result')).length, count);
        const restored = await fixture({ storage: f.storage }); assert.ok(restored.stats.requests.every(item => item.method === 'GET'), '重载仅收信，不自动补传');
        restored.mount(); await restored.action('reconcile', { id: 'command-1' }); await restored.action('execute');
        assert.equal(restored.stats.results.length, 1, '前台预览并重新确认后才补传');
    }
    {
        const f = await fixture(); f.mount(); await f.action('pause'); await f.action('preview'); assert.equal(f.stats.checks, 0);
        f.set('modHubAssistChat', '暂停后仍可沟通'); await f.action('chat-send'); assert.ok(f.stats.requests.some(item => item.endpoint.endsWith('/text')));
        await f.action('cancel-command'); assert.equal(f.stats.results[0].status, 'cancelled', '暂停允许拒绝尚未领取操作');
    }
    {
        const f = await fixture({ role: 'helper', commands: false }); f.mount(); await f.action('send-operation'); assert.equal(f.stats.sentOperation, undefined);
        await f.action('preview-operation'); f.set('modHubAssistAllLogs', '', false).checked = true; f.host.onchange({ target: f.host.querySelector('#modHubAssistAllLogs') });
        await f.action('send-operation'); assert.equal(f.stats.sentOperation, undefined, '编辑后重新预览');
        await f.action('preview-operation'); await f.action('send-operation'); assert.equal(f.stats.sentOperation.payload.allLogs, true);
        assert.equal(f.stats.checks, 0); assert.equal(f.stats.preparations.length, 0); assert.equal(f.stats.applies, 0, '协助端工具从不修改自己的环境');
        assert.doesNotMatch(f.host.innerHTML, /modHubAssistTemplateCode|旧修复码|data-assist-action="template"/, '新工作区没有旧修复码入口');
        assert.equal(f.sb.modHubRemoteHelp, undefined, '不注册旧客户端工作流');
        assert.ok(f.stats.requests.every(item => item.endpoint.startsWith('/direct/')), '仅请求直接协助服务');
    }
    {
        const messages = Array.from({ length: 240 }, (_, index) => ({ id: 'text-' + index, seq: index + 1, type: 'text', sender: 'helper', text: '文字' }));
        const f = await fixture({ messages }); assert.equal(f.saved().current.messages.length, 200); assert.equal(f.saved().current.after, 240);
        const restored = await fixture({ storage: f.storage, messages }); assert.equal(restored.stats.requests[0].endpoint, '/direct/sessions/session-1?after=240', '重载使用持久游标，不重新抓全量记录');
        restored.mount(); assert.equal(restored.saved().current.messages[0].text, '文字', '重载后保留原始聊天文本');
        assert.match(restored.host.innerHTML, /<p>文字<\/p>/, '持久游标与正文共同恢复，不显示空消息');
    }
    {
        const f = await fixture({ role: 'helper', detailMessage: { id: 'result-1', type: 'result', kind: 'readSources', result: { name: 'Example', version: '1.0.0', baselineHash: 'a'.repeat(64), files: [{ path: 'main.js', content: 'const test = 1;' }] } } }); f.mount();
        await f.action('view-message', { id: 'result-1' }); await f.action('use-source', { index: '0' });
        assert.equal(f.saved().current.draft.payload.baselineHash, 'a'.repeat(64)); assert.equal(f.saved().current.draft.payload.changes[0].before, 'const test = 1;');
        assert.ok(!JSON.stringify(f.saved().current.messages).includes('const test = 1;'), '完整源码详情不进入常驻缓存');
    }
    {
        const payload = { summary: '修正测试状态', script: 'V.modHubTest = 2;', verification: '查看测试状态' };
        const f = await fixture({ kind: 'runJavaScript', payload }); f.mount();
        await f.action('preview'); assert.equal(f.stats.gameRuns, undefined, '玩家预览不运行JS');
        assert.match(f.host.innerHTML, /待运行的完整 JS 指令|备份并运行指令/);
        await f.action('execute'); assert.equal(f.stats.gameRuns, 1);
        assert.equal(f.stats.gameStamp, 'game-stamp');
        assert.deepEqual(f.stats.gameId, [MODHUB_TEST_KEY, 'session-1', 'command-1']);
        assert.equal(f.stats.runJournal.phase, 'running'); assert.equal(f.stats.runJournal.backupId, 'modhub-game-' + 'a'.repeat(64), '执行前持久记录备份编号');
        assert.equal(f.stats.results[0].status, 'saved'); assert.equal(f.stats.results[0].result.verification, 'pending-game-check');
        assert.equal(f.stats.applies, 0); assert.equal(f.stats.checks, 0, 'JS不调用模组保存或诊断读取');
        await f.action('execute'); await f.tick(); assert.equal(f.stats.gameRuns, 1, '重复点击和收信不重复运行');
        await f.action('close'); assert.match(f.host.innerHTML, /下载运行前备份/, '结束协助仍可下载游戏备份');
        await f.action('download-backup', { id: f.stats.runJournal.backupId }); assert.equal(f.stats.download, f.stats.runJournal.backupId);
        await f.action('new-session'); assert.match(f.host.innerHTML, /以前协助的游戏备份/);
        assert.equal(f.saved().history[0].entries[0].backupId, f.stats.runJournal.backupId, '开始新协助仍保留备份入口');
        const restored = await fixture({ storage: f.storage, kind: 'runJavaScript', payload }); restored.mount();
        assert.equal(restored.stats.gameRuns, undefined, '重载仅收信，不运行JS');
    }
    for (const option of ['confirm', 'claimDrop', 'onGamePrepare']) {
        let f;
        const options = { kind: 'runJavaScript', payload: { summary: '修正', script: 'V.test = 1', verification: '查看' } };
        options[option] = option === 'confirm' ? false : option === 'onGamePrepare' ? () => f.sb.modHubRemoteAssist.unmount() : true;
        f = await fixture(options); f.mount(); await f.action('preview');
        if (option !== 'onGamePrepare') await f.action('execute');
        assert.equal(f.stats.gameRuns, undefined, '取消、领取失败或预览期间离页均不运行JS');
    }
    {
        const f = await fixture({ kind: 'runJavaScript', payload: { summary: '修正', script: 'throw "本机私密游戏内容"', verification: '查看' }, gameError: true }); f.mount();
        await f.action('preview'); await f.action('execute');
        assert.equal(f.stats.results[0].status, 'failed'); assert.match(f.host.innerHTML, /本机私密游戏内容/, '具体错误仅显示在本机');
        assert.ok(!JSON.stringify(f.stats.results).includes('本机私密游戏内容'), '不自动上传JS返回值或异常原文');
        assert.equal(f.saved().current.entries['command-1'].backupId, 'modhub-game-' + 'a'.repeat(64));
    }
    {
        const payload = { summary: '修正', script: 'V.test = 1', verification: '查看' };
        const f = await fixture({ kind: 'runJavaScript', payload, gameError: true, noGameBackup: true }); f.mount();
        await f.action('preview'); await f.action('execute'); assert.match(f.host.innerHTML, /备份未完成核验，指令未运行/);
        assert.doesNotMatch(f.host.innerHTML, /备份已保留|下载运行前备份/);
        const restored = await fixture({ storage: f.storage, kind: 'runJavaScript', payload }); restored.mount();
        assert.match(restored.host.innerHTML, /本机私密游戏内容/, '没有备份的具体失败原因在重载后仍可查看');
        const mixed = restored.saved(); mixed.current.entries.patch = { kind: 'applyPatch', saved: true }; mixed.current.session.status = 'active';
        restored.storage.set(MODHUB_TEST_KEY, JSON.stringify(mixed));
        const check = await fixture({ storage: restored.storage, kind: 'runJavaScript', payload }); check.mount(); await check.action('verify');
        assert.match(check.stats.confirmations.at(-1).message, /重新载入并复现/, '混合会话的模组修改仍须重载验证');
    }
    {
        const f = await fixture({ kind: 'runJavaScript', payload: { summary: '修正', script: 'V.test = 1', verification: '查看' }, gameDrop: true }); f.mount();
        await f.action('preview'); await f.action('execute'); assert.equal(f.stats.gameRuns, 1);
        await f.action('reconcile', { id: 'command-1' }); await f.action('execute');
        assert.equal(f.stats.gameRuns, 1, 'JS中断后仅回传待核验状态，不重试运行');
        assert.equal(f.stats.results[0].status, 'uncertain'); assert.match(f.stats.results[0].result.message, /无法判定脚本的全部影响/);
        assert.equal(f.stats.results[0].result.backupId, 'modhub-game-' + 'a'.repeat(64));
    }
    {
        const f = await fixture({ role: 'helper', commands: false }); f.mount();
        f.set('modHubAssistKind', 'runJavaScript', false); f.host.onchange({ target: f.host.querySelector('#modHubAssistKind') });
        assert.match(f.host.innerHTML, /&lt;&lt;script&gt;&gt;/, 'JS 宏提示按纯文本呈现，避免吞掉后续表单');
        f.set('modHubAssistSummary', '修正'); f.set('modHubAssistScript', 'V.test = 1;'); f.set('modHubAssistVerification', '查看');
        await f.action('preview-operation'); await f.action('send-operation');
        assert.equal(f.stats.sentOperation.kind, 'runJavaScript'); assert.equal(f.stats.sentOperation.payload.script, 'V.test = 1;');
        assert.equal(f.stats.gamePrepares, undefined); assert.equal(f.stats.gameRuns, undefined, '提供协助端只发送正文，不触碰自己的游戏');
    }
    {
        const f = await fixture({ commands: false, recreateDom: true }); f.mount();
        f.set('modHubAssistChat', '第一行\n第二行');
        for (const event of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { key: 'a' }, { target: { id: 'modHubAssistScript', value: 'JS正文' } }]) {
            assert.equal(await f.key(event), false, '换行、输入法与其他输入不拦截');
        }
        assert.equal(await f.key({ repeat: true }), true, '长按回车不重复发送');
        assert.equal(f.stats.requests.filter(item => item.endpoint.endsWith('/text')).length, 0);
        const first = f.key(), second = f.key(); await Promise.all([first, second]);
        const sends = f.stats.requests.filter(item => item.endpoint.endsWith('/text'));
        assert.equal(sends.length, 1, '回车与忙碌期间重复回车只发送一次');
        assert.equal(sends[0].body.text, '第一行\n第二行');
        assert.equal(f.saved().current.chatDraft, ''); assert.equal(f.stats.focused, '#modHubAssistChat');
        assert.equal(f.stats.scrolls.at(-1).selector, '#modHubAssistChat');
        f.set('modHubAssistChat', '   '); await f.key();
        assert.equal(f.stats.requests.filter(item => item.endpoint.endsWith('/text')).length, 1, '空白回车不发送或显示错误');
        assert.equal(f.stats.alerts.length, 0);
        f.sb.modHubRemoteAssist.unmount(); assert.equal(f.host.onkeydown, null, '卸载清理键盘入口');
    }
    {
        const f = await fixture({ commands: false, chatError: true }); f.mount(); f.set('modHubAssistChat', '保留未发送原文'); await f.key();
        assert.equal(f.saved().current.chatDraft, '保留未发送原文');
        assert.match(f.host.innerHTML, /modhub-assist-notice red[^>]*role="alert"/);
        assert.match(f.stats.alerts[0].message, /发送网络中断/);
        assert.equal(f.stats.scrolls.at(-1).selector, '.modhub-assist-notice', '关闭错误框后回到可见错误区域');
        const scrollCount = f.stats.scrolls.length, alertCount = f.stats.alerts.length;
        f.options.pollError = true; await f.tick();
        assert.equal(f.stats.scrolls.length, scrollCount, '后台收信失败不改变阅读位置');
        assert.equal(f.stats.alerts.length, alertCount, '后台收信失败不弹出警告');
    }
    for (const kind of ['applyConfiguration', 'applyPatch']) {
        for (const uncertain of [false, true]) {
            const f = await fixture({ kind, payload: kind === 'applyPatch' ? patch : { issueId: 'dependency-X' },
                applyResult: { ok: false, pointId: 'point-1', reason: '本机具体回读原因', uncertain, committed: uncertain } });
            f.mount(); await f.action('preview'); await f.action('execute');
            assert.equal(f.stats.results[0].status, uncertain ? 'uncertain' : 'failed', '返回型失败不能显示已保存');
            assert.equal(f.saved().current.entries['command-1'].localError, '本机具体回读原因');
            assert.equal(f.saved().current.entries['command-1'].committed, uncertain);
            assert.ok(f.stats.alerts.some(item => item.message.includes('本机具体回读原因')), '返回型失败同样弹出本机具体原因');
            assert.match(f.host.innerHTML, /modhub-assist-notice red[^>]*role="alert"/);
            assert.match(f.host.innerHTML, /受保护时间点：point-1/);
            assert.match(f.host.innerHTML, /data-assist-action="restore"[^>]*>查看受保护时间点/);
            if (kind === 'applyPatch') assert.equal(f.stats.preApplyJournal.pointId, 'point-1', '写入前先登记时间点编号');
        }
    }
    {
        const f = await fixture({ role: 'helper', detailMessage: { id: 'result-focus', type: 'result', kind: 'readSources', result: { name: 'Example', version: '1.0.0', files: [{ path: 'main.js', content: 'const test = 1;' }] } } });
        f.mount(); await f.action('view-message', { id: 'result-focus' });
        assert.equal(f.stats.scrolls.at(-1).selector, '#modHubAssistDetail', '查看详情定位实际详情区域');
        await f.action('use-source', { index: '0' });
        assert.equal(f.stats.scrolls.at(-1).selector, '.modhub-assist-tools', '使用源码定位填好的操作区');
        const before = f.stats.scrolls.length; await f.tick(); assert.equal(f.stats.scrolls.length, before, '收信不重复定位详情或操作区');
    }
    {
        const payload = { summary: '核对网络行为', script: 'fetch("https://example.invalid");', verification: '检查结果' };
        const f = await fixture({ kind: 'runJavaScript', payload, riskConfirm: false }); f.mount(); await f.action('preview');
        assert.match(f.host.innerHTML, /文本中包含/); assert.match(f.host.innerHTML, /注释或字符串也可能命中/);
        await f.action('execute');
        assert.equal(f.stats.confirmations.at(-1).confirmText, '已核对风险，继续');
        assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')), '风险确认取消发生在领取之前');
        assert.equal(f.stats.restoreCalls.length, 0, '风险确认取消不建立备份'); assert.equal(f.stats.gameRuns, undefined);
        f.options.riskConfirm = true; await f.action('execute');
        const entry = f.saved().current.entries['command-1']; assert.ok(entry.risks.length);
        assert.deepEqual(Object.keys(f.stats.results[0].result).sort(), ['backupId', 'message', 'verification'], '风险结果和时间点编号只保存在本机');
        assert.equal(f.stats.gameBackupJournal.pointId, 'js-point-1', '生成游戏备份前已保存时间点编号');
        assert.equal(entry.pointId, 'js-point-1'); assert.equal(f.stats.restoreMeta.kind, 'remoteRepair');
        assert.deepEqual(f.stats.restoreCalls, ['create', 'prepare', 'finish', 'release']);
    }
    {
        const f = await fixture({ kind: 'applyPatch', payload: { ...patch, changes: [...patch.changes, { ...patch.changes[0], before: '= 3', after: '= 4' }] },
            patchSource: 'const test = 2;\nfetch("https://example.invalid");', riskConfirm: false });
        f.mount(); await f.action('preview');
        assert.match(f.host.innerHTML, /网络相关文本/, '检查修改后文件全文，不能只检查安全替换片段');
        assert.deepEqual(f.stats.patchReads, ['main.js'], '同一文件的多个替换片段只读取一次全文');
        f.options.riskConfirm = true;
        f.options.onConfirm = prompt => { if (prompt.confirmText === '已核对风险，继续') f.options.patchSource += '\nconst laterChange = true;'; };
        await f.action('execute');
        assert.equal(f.stats.applies, 0); assert.ok(!f.stats.requests.some(item => item.endpoint.endsWith('/claim')), '确认期间包体正文变化需重新预览');
        assert.match(f.stats.alerts.at(-1).message, /正文、包体或风险提示已变化/);
    }
    for (const option of ['restorePrepareError', 'restoreFinishError', 'restoreFinishThrow']) {
        const f = await fixture({ kind: 'runJavaScript', payload: { summary: '双备份', script: 'V.test = 1;', verification: '检查变量' }, [option]: true });
        f.mount(); await f.action('preview'); await f.action('execute');
        assert.deepEqual(f.stats.restoreCalls, ['create', 'prepare', 'finish', 'release'], '时间点失败也必须收尾和释放');
        if (option === 'restorePrepareError') {
            assert.equal(f.stats.gameRuns, undefined, '时间点备份失败不能生成游戏备份或执行指令');
            assert.equal(f.stats.results.length, 0);
        } else {
            assert.equal(f.saved().current.entries['command-1'].executed, true, '收尾失败保留同步运行的实际结果');
            assert.equal(f.stats.results[0].status, 'uncertain', '收尾失败不能报告成功');
            assert.deepEqual(Object.keys(f.stats.results[0].result).sort(), ['backupId', 'message', 'verification']);
            await f.action('execute'); await f.tick(); assert.equal(f.stats.gameExecutions, 1, '收尾失败不重试指令');
        }
    }
    {
        const f = await fixture({ kind: 'runJavaScript', payload: { summary: '检查执行前离页', script: 'V.test = 1;', verification: '查看' } });
        f.options.onRestorePrepare = () => f.sb.modHubRemoteAssist.unmount();
        f.mount(); await f.action('preview'); await f.action('execute');
        assert.equal(f.saved().current.entries['command-1'].pointId, 'js-point-1', '时间点创建后离页也先保存编号');
        assert.equal(f.stats.gameRuns, undefined); assert.deepEqual(f.stats.restoreCalls, ['create', 'prepare', 'finish', 'release']);
        const g = await fixture({ kind: 'runJavaScript', payload: { summary: '检查游戏备份后离页', script: 'V.test = 1;', verification: '查看' } });
        g.options.onGameBackup = () => g.sb.modHubRemoteAssist.unmount();
        g.mount(); await g.action('preview'); await g.action('execute');
        assert.equal(g.saved().current.entries['command-1'].backupId, 'modhub-game-' + 'a'.repeat(64), '游戏备份完成后离页也先保存编号');
        assert.equal(g.stats.gameExecutions, undefined, '前台guard失败不开始JS运行');
        assert.deepEqual(g.stats.restoreCalls, ['create', 'prepare', 'finish', 'release']);
    }
    {
        const f = await fixture({ kind: 'runJavaScript', payload: { summary: '检查方法被改写', script: 'V.test = 1;', verification: '查看' } });
        f.options.onGameRun = () => { f.sb.modHubRestore.finish = f.sb.modHubRestore.release = () => { throw new Error('脚本替换的收尾接口不应使用'); }; };
        f.mount(); await f.action('preview'); await f.action('execute');
        assert.deepEqual(f.stats.restoreCalls, ['create', 'prepare', 'finish', 'release'], '运行前捕获原收尾接口，避免脚本替换导致锁未释放');
        assert.equal(f.stats.results[0].status, 'saved');
    }
    for (const options of [
        { role: 'helper', sessionStatus: 'closed' },
        { role: 'helper', sessionStatus: 'closed', sessionVerification: { solved: false, at: Date.now() } },
        { role: 'helper', sessionStatus: 'closed', sessionVerification: { solved: true, at: '伪造时间' } },
        { role: 'helper', sessionVerification: { solved: true, at: Date.now() } },
        { role: 'player', sessionStatus: 'closed', sessionVerification: { solved: true, at: Date.now() } },
    ]) {
        const f = await fixture({ ...options, commands: false }); f.mount(options.role);
        assert.ok(!f.host.innerHTML.includes('data-assist-action="prepare-spell"'), '普通结案、未验证与玩家视角不显示协助整理入口');
        await f.action('prepare-spell');
        assert.equal(f.stats.spellSubmissionArgs.length, 0, '伪造点击也不能绕过明确验证和角色条件');
    }
    {
        const f = await fixture({ role: 'helper', commands: false, sessionStatus: 'closed', sessionVerification: { solved: true, at: Date.now() },
            messages: [{ id: 'private-chat', seq: 1, type: 'text', sender: 'player', text: '私人聊天与变量' }] });
        f.mount('helper');
        assert.match(f.host.innerHTML, /data-assist-action="prepare-spell"[^>]*>整理候选言灵/);
        assert.equal(f.stats.spellSubmissionArgs.length, 0, '验证后不能自动开表单');
        const requestCount = f.stats.requests.length;
        await f.action('prepare-spell');
        assert.deepEqual(f.stats.spellSubmissionArgs, [[]], '整理入口不得传入session、聊天、诊断、源码、变量或凭证');
        assert.equal(f.stats.requests.length, requestCount, '整理不向协助服务或投稿服务发送资料');
        assert.match(f.host.innerHTML, /不会自动带入协助资料/);
        f.options.hostHidden = true;
        await f.action('prepare-spell');
        assert.equal(f.stats.spellSubmissionArgs.length, 1, '后台不能打开公开投稿');
    }
    const styles = readStyles();
    assert.match(styles, /\.modhub-assist-entry-badge\[hidden\][^{]*\{\s*display:\s*none\s*!important/);
    assert.equal(bootJson.scriptFileList.indexOf('javascript/modhub-remote-assist.js'), bootJson.scriptFileList.indexOf('javascript/modhub-game-command.js') + 1);
    console.log('匿名远程协助：连接、后台收信、前台确认与中断恢复验证通过');
};
