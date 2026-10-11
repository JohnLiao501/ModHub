// 远程协助客户端：确认边界、凭据隔离、暂停与中断不重放。
const { assert, createBaseSandbox, createStubElement, loadScripts } = require('./helpers');
const { webcrypto, createHash } = require('node:crypto');
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(options = {}) {
    const command = { id: 'command-1', seq: 1, kind: options.kind || 'collectDiagnostics', payload: options.payload || { allLogs: false }, status: options.commandStatus || 'queued', claimId: options.claimId || null };
    command.digest = digest({ kind: command.kind, payload: command.payload });
    const helper = { id: 'helper-1', displayName: '测试开发者' };
    const repair = { id: 'repair-1', code: '12345678', title: '测试协助', description: '检查问题', helper, initialCommand: plain(command) };
    const session = { id: 'session-1', repairId: repair.id, repairCode: repair.code, helper, status: 'active', pairing: 'unpaired' };
    const state = { requests: [], applies: 0, preparations: [], confirmations: [], saves: [], results: [], pairings: [], checks: 0 };
    const storage = options.storage || new Map();
    const host = createStubElement(); host.isConnected = true;
    const panel = createStubElement('details'); panel.open = true;
    const timers = new Map(); let timerId = 0;
    const identity = { dbName: 'game', storeName: 'mods' };
    const sb = createBaseSandbox({
        crypto: webcrypto, TextEncoder, TextDecoder, AbortController, Uint8Array,
        setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => {
            if (options.storageFails) throw new Error('本机存储空间不足');
            if (options.resultStoreFails && Object.values(JSON.parse(value).entries || {}).some(entry => entry.result)) throw new Error('结果正文保存失败');
            storage.set(key, value); state.saves.push(JSON.parse(value));
        } },
        modHubEscapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        modHubRestore: { getStorageIdentity: () => identity, showHistory: async () => {} },
        modHubConfirm: async value => { state.confirmations.push(value); return options.confirm !== false; },
        modHubReadInstalledModPackage: async () => ({ data: new Uint8Array([2]) }),
        modHubReadIndexDBModLists: async () => ({ ok: true, enabled: ['Example'], disabled: [] }),
        modHubAiPackage: { hash: async () => 'b'.repeat(64) },
        modHubHelp: {
            redactRemoteCredentials: value => options.knownKey ? String(value).split(options.knownKey).join('[已隐去密钥]') : String(value),
            check: async () => { state.checks++; return { issues: [{ id: 'dependency-X', title: '前置缺失', repair: {} }] }; },
            buildReport: () => options.report || '诊断报告 token=private',
            previewRemoteConfiguration: async issueId => { state.configIssue = issueId; return { issueId, before: { enabled: ['Example'], disabled: [] }, after: { enabled: ['Required', 'Example'], disabled: [] } }; },
            applyRemoteConfiguration: async () => { state.applies++; return { ok: true, pointId: 'point-1' }; }
        },
        modHubAiRepair: {
            sanitizeText: text => text.replace('private', '[已隐藏]'),
            prepare: async (name, description, settings) => {
                state.preparations.push({ name, settings });
                return { name, bootJson: { version: '1.0.0' }, hash: 'a'.repeat(64), baselineData: '不可上传的原包',
                    material: JSON.stringify({ name, version: '1.0.0', files: [{ path: 'main.js', content: options.source || 'const test = 1;' }] }) };
            },
            previewResponse: async (prepared, response, settings) => { state.previewSource = settings.source; return { response }; },
            getVerification: async () => ({ name: 'Example', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), enabled: ['Example'], disabled: [] }),
            apply: async () => { state.applies++; options.onApply?.(); return { ok: true, pointId: 'point-1' }; }
        },
        fetch: async (url, init) => {
            const endpoint = url.split('/remote-assistance')[1];
            const body = init.body ? JSON.parse(init.body) : undefined;
            state.requests.push({ endpoint, ...init, parsed: body });
            let result, status = 200;
            if (endpoint === '/repairs/12345678') result = { repair };
            else if (endpoint === '/sessions') { state.join = body; result = { session, continuationCode: '1234567890', command }; }
            else if (endpoint.endsWith('/resume')) { session.status = 'active'; result = { session }; }
            else if (endpoint.endsWith('/pause')) { session.status = 'paused'; result = { session }; }
            else if (endpoint.endsWith('/claim')) {
                state.claimJournal = [...storage.values()].map(JSON.parse)[0]?.entries[command.id];
                if (options.claimDropBefore && !state.claimDropped) { state.claimDropped = true; throw new Error('领取请求未到达服务端'); }
                if (options.claimFails) { status = options.claimStatus || 403; result = { error: '权限已撤销', details: '开发者授权已停止' }; }
                else if (command.status === 'claimed' && command.claimId !== body.claimId) { status = 409; result = { error: '已由其他编号领取' }; }
                else { command.status = 'claimed'; command.claimId = body.claimId; result = { command }; }
                if (options.claimDropAfter && !state.claimDropped) { state.claimDropped = true; throw new Error('领取响应在返回途中丢失'); }
            } else if (endpoint.endsWith('/result')) {
                if (options.resultFails) throw new Error('回传网络中断');
                state.results.push(body); command.status = 'completed'; result = { saved: true };
            } else if (endpoint.endsWith('/pair')) { state.pairings.push(body); session.pairing = body.accept ? 'paired' : 'unpaired'; result = { session, ...(!body.accept ? { continuationCode: '9876543210' } : {}) }; }
            else if (endpoint.endsWith('/close') || endpoint.endsWith('/verify')) { session.status = 'closed'; result = { session }; }
            else if (endpoint.includes('/commands/')) result = { command };
            else if (endpoint.includes('?after=')) result = { session, messages: [{ ...command, type: 'command', payload: undefined }], nextCursor: null };
            else throw new Error('未预期请求：' + endpoint);
            if (options.stream && endpoint.startsWith('/repairs/')) {
                let read = 0;
                return { ok: true, status: 200, body: { getReader: () => ({
                    read: async () => { state.streamReads = ++read; return { done: false, value: new Uint8Array(600000) }; },
                    cancel: async () => { state.streamCancelled = true; }
                }) }, text: () => { throw new Error('禁止完整读取响应'); } };
            }
            return { ok: status === 200, status, text: async () => JSON.stringify(result) };
        }
    });
    sb.document.getElementById = id => id === 'modHubHelpRemoteContent' ? host : null;
    loadScripts(sb, ['javascript/modhub-remote-help.js']);
    sb.modHubRemoteHelp.mount(host, panel);
    const action = async name => host.onclick({ target: { closest: () => ({ dataset: { remoteAction: name } }) } });
    const join = async () => { host.querySelector('#modHubRemoteCode').value = '12345678'; await action('lookup'); await action('join'); };
    const tick = async () => { const timer = [...timers.values()].find(item => item.delay !== 30000) || [...timers.values()][0]; await timer?.fn(); await new Promise(resolve => setImmediate(resolve)); };
    return { sb, state, storage, host, panel, command, session, identity, action, join, tick, options };
}

module.exports = async function runRemoteHelpTests() {
    {
        const f = fixture();
        assert.equal(f.state.requests.length, 0, '打开帮助不发网络请求');
        await f.join();
        assert.equal(f.state.checks, 0, '加入不读取或上传诊断');
        assert.equal(f.state.join.token.length, 64);
        assert.match([...f.storage.keys()][0], /game.*mods/);
        assert.ok(f.state.saves[0].joinRequest, '建会话前保存幂等凭据');
        assert.ok(!f.host.innerHTML.includes(f.state.join.token), '凭据不呈现到页面');
        await f.action('preview');
        assert.equal(f.state.results.length, 0, '本机预览未发送');
        assert.match(f.host.innerHTML, /已隐藏/);
        await f.action('execute');
        assert.equal(f.state.results[0].status, 'sent');
        assert.ok(!JSON.stringify(f.state.results).includes('private'));
        assert.equal(f.state.claimJournal.stage, 'started', '领取前登记执行记录');
        const claim = f.state.requests.find(item => item.endpoint.endsWith('/claim'));
        assert.equal(claim.headers.Authorization, 'Bearer ' + f.state.join.token);
        assert.ok(f.state.requests.every(item => item.credentials === 'omit' && item.cache === 'no-store'));
        assert.equal(f.state.confirmations.length, 2);
        await f.tick();
        assert.equal(f.state.results.length, 1, '重复指令不重发或重执行');
    }
    {
        const f = fixture({ confirm: false });
        await f.join();
        assert.equal(f.state.requests.filter(item => item.endpoint === '/sessions').length, 0, '取消加入不建会话');
    }
    {
        const f = fixture({ kind: 'readSources', payload: { name: 'Example', paths: ['main.js'] } });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.preparations[0].settings.source, 'remoteRepair');
        assert.deepEqual(f.state.results[0].result.files, [{ path: 'main.js', content: 'const test = 1;' }]);
        assert.ok(!JSON.stringify(f.state.results).includes('baselineData'));
        assert.ok(!JSON.stringify(f.state.results).includes('不可上传'));
    }
    const patch = { name: 'Example', version: '1.0.0', summary: '修正取值', evidence: '源码依据', verification: '重新载入核验', changes: [{ path: 'main.js', before: '= 1', after: '= 2', reason: '修复' }] };
    {
        const f = fixture({ kind: 'applyPatch', payload: patch });
        await f.join(); await f.action('preview');
        assert.equal(f.state.applies, 0);
        assert.equal(f.state.previewSource, 'remoteRepair');
        await f.action('execute');
        assert.equal(f.state.applies, 1);
        assert.equal(f.state.results[0].status, 'saved');
        assert.equal(f.state.results[0].result.pointId, 'point-1');
        assert.equal(f.state.results[0].result.verification, 'pending-reload');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: { ...patch, baselineHash: 'c'.repeat(64) } });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.applies, 0);
        assert.match(f.host.innerHTML, /包体已改变/);
    }
    {
        const f = fixture({ kind: 'applyConfiguration', payload: { issueId: 'dependency-X' } });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.configIssue, 'dependency-X');
        assert.equal(f.state.applies, 1);
        assert.ok(f.state.claimJournal.verification.after, '持久保存本机配置核验依据');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch });
        await f.join(); await f.action('preview');
        f.panel.open = false; f.panel.dispatch('toggle');
        await f.action('execute');
        assert.equal(f.state.applies, 0, '折叠撤销旧预览');
        f.panel.open = true; await f.action('resume'); await f.action('execute');
        assert.equal(f.state.applies, 0, '继续后不能恢复旧确认');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch, claimFails: true });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.applies, 0, '服务撤销权限后不能写入');
        assert.match(f.host.innerHTML, /权限已撤销/);
        assert.match(f.host.innerHTML, /开发者授权已停止/);
        assert.match(f.host.innerHTML, /结束本机连接/);
        await f.action('detach');
        assert.equal(JSON.parse([...f.storage.values()][0]).session.status, 'closed');
        assert.match(f.host.innerHTML, /未确认服务器结案/);
        await f.join();
        assert.equal(f.state.requests.filter(item => item.endpoint === '/sessions').length, 2, '拒绝授权后仍可结束本机连接并加入其他协助');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch, resultFails: true });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.applies, 1);
        assert.ok(JSON.parse([...f.storage.values()][0]).entries['command-1'].result, '回传失败保留原结果');
        assert.equal(JSON.parse([...f.storage.values()][0]).entries['command-1'].pointId, 'point-1', '回传失败保留本机还原点编号');
        f.options.resultFails = false;
        await f.tick();
        assert.equal(f.state.applies, 1, '补传结果不重做修改');
        assert.equal(f.state.results.length, 1);
        assert.equal(JSON.parse([...f.storage.values()][0]).entries['command-1'].pointId, 'point-1', '回传成功删除正文后仍保留还原点编号');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch });
        await f.join();
        const stored = JSON.parse([...f.storage.values()][0]);
        stored.entries['command-1'] = { kind: 'applyPatch', stage: 'started', claimId: 'd'.repeat(64), pointId: 'crash-point', verification: { name: 'Example', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), enabled: ['Example'], disabled: [] } };
        f.storage.set([...f.storage.keys()][0], JSON.stringify(stored));
        const next = fixture({ kind: 'applyPatch', payload: patch, storage: f.storage, commandStatus: 'claimed', claimId: 'd'.repeat(64) });
        assert.equal(next.state.requests.length, 0, '重载后不自动联网');
        await next.action('resume');
        assert.equal(next.state.applies, 0, '中断执行不能重放');
        assert.equal(next.state.results[0].status, 'uncertain');
        assert.equal(next.state.results[0].result.pointId, 'crash-point');
        assert.equal(JSON.parse([...next.storage.values()][0]).entries['command-1'].pointId, 'crash-point');
        assert.match(next.state.results[0].result.message, /当前包体与预览后的包体一致/);
    }
    {
        const f = fixture(); await f.join();
        f.session.pairing = 'pending'; await f.tick(); await f.action('pair');
        assert.equal(f.state.pairings[0].accept, true);
        assert.match(f.state.confirmations.at(-1).title, /确认开发者连接/);
        f.session.pairing = 'unpaired'; await f.action('renew-code');
        assert.match(f.host.innerHTML, /9876543210/);
    }
    {
        const f = fixture(); await f.join(); await f.action('close');
        assert.equal(JSON.parse([...f.storage.values()][0]).session.status, 'closed', '结案不能被本机暂停覆盖');
        assert.match(f.host.innerHTML, /输入修复码/);
        const other = fixture(); await other.join(); other.session.status = 'closed'; await other.tick();
        assert.equal(JSON.parse([...other.storage.values()][0]).session.status, 'closed', '开发者结案同样释放加入入口');
    }
    {
        const f = fixture();
        f.command.payload.allLogs = true;
        await f.join();
        assert.equal(f.state.checks, 0, '篡改摘要拒绝本机读取');
        assert.match(f.host.innerHTML, /摘要不一致/);
    }
    {
        const f = fixture(); await f.join(); await f.action('preview');
        f.options.storageFails = true; await f.action('execute');
        assert.equal(f.state.requests.filter(item => item.endpoint.endsWith('/claim')).length, 0, '执行记录不能保存时不能领取');
    }
    {
        const f = fixture({ report: '大'.repeat(400000) });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.results.length, 0, '超限资料不截断发送');
        assert.match(f.host.innerHTML, /超过 1 MiB/);
    }
    {
        const f = fixture({ stream: true });
        await f.join();
        assert.equal(f.state.streamReads, 2, '读流超限立即停止，不完整缓存响应');
        assert.equal(f.state.streamCancelled, true);
        assert.match(f.host.innerHTML, /超过 1 MiB/);
    }
    for (const option of ['claimDropBefore', 'claimDropAfter']) {
        const f = fixture({ kind: 'applyPatch', payload: patch, [option]: true });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.applies, 0, '领取结果未知时不执行本机修改');
        assert.equal(JSON.parse([...f.storage.values()][0]).entries['command-1'].stage, 'claim-uncertain');
        await f.tick();
        assert.equal(f.state.applies, 0, '核验领取不重放本机修改');
        assert.equal(f.state.results.length, 1, '领取失败核验后不会以错误编号永久阻塞回传');
        assert.equal(f.state.results[0].status, option === 'claimDropBefore' ? 'cancelled' : 'uncertain');
        assert.equal(f.state.results[0].claimId === '', option === 'claimDropBefore');
        assert.doesNotMatch(f.host.innerHTML, /：cancelled|：uncertain/);
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch, claimFails: true, claimStatus: 410 });
        await f.join();
        assert.doesNotMatch(f.host.innerHTML, /digest|baselineHash|\bseq\b|command-1/, '默认只呈现玩家可读摘要');
        await f.action('preview'); await f.action('execute');
        assert.equal(JSON.parse([...f.storage.values()][0]).session.status, 'closed', '已到期会话释放加入入口');
        assert.match(f.host.innerHTML, /本机连接已结束/);
    }
    {
        const secret = 'plain-memory-credential';
        const f = fixture({ report: '日志直接记录了 ' + secret, knownKey: secret });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.ok(!JSON.stringify(f.state.results).includes(secret), '没有key标签的当前内存密钥也不能上传');
        assert.match(f.state.results[0].result.report, /已隐去密钥/);
        const source = 'const text = "' + secret + '";';
        const g = fixture({ kind: 'readSources', payload: { name: 'Example', paths: ['main.js'] }, source, knownKey: secret });
        await g.join(); await g.action('preview'); await g.action('execute');
        assert.equal(g.state.results.length, 0, '源码含当前密钥时拒传整个请求');
        assert.equal(g.state.applies, 0);
        assert.match(g.host.innerHTML, /源码含有您当前使用的 AI 密钥/);
        assert.equal(g.options.source, source, '保护凭据不能改写用于匹配的源码原文');
    }
    {
        const f = fixture({ kind: 'applyPatch', payload: patch, resultStoreFails: true });
        await f.join(); await f.action('preview'); await f.action('execute');
        assert.equal(f.state.applies, 1);
        const record = JSON.parse([...f.storage.values()][0]).entries['command-1'];
        assert.equal(record.pointId, 'point-1', '保存结果正文失败前已单独保存还原点编号');
        assert.equal(record.stage, 'started', '记录仍保留为待核验而非假称结果已持久保存');
    }
    for (const throws of [false, true]) {
        const secret = 'plain-error-credential';
        const f = fixture({ kind: 'applyPatch', payload: patch, knownKey: secret });
        f.sb.modHubAiRepair.apply = async () => {
            f.state.applies++;
            if (throws) throw new Error('回读错误：' + secret);
            return { ok: false, pointId: 'failed-point', reason: '读取失败：' + secret };
        };
        await f.join(); await f.action('preview'); await f.action('execute'); await f.tick();
        assert.equal(f.state.applies, 1, '失败和异常结果补传不重复修改');
        assert.equal(f.state.results[0].status, throws ? 'uncertain' : 'failed');
        assert.ok(!JSON.stringify(f.state.results).includes(secret), '执行错误文案也必须移除当前 AI 密钥');
        assert.match(f.state.results[0].result.message, /已隐去密钥/);
        assert.ok(![...f.storage.values()].some(value => value.includes(secret)), '远程持久结果不保留错误中的密钥');
        if (!throws) assert.equal(f.state.results[0].result.pointId, 'failed-point');
    }
};
