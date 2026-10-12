// 远程协助协议工具：摘要与字段校验、响应限额及脱敏拒绝边界。
const { assert, createBaseSandbox, loadScripts } = require('./helpers');
const { webcrypto, createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const command = (kind, payload) => ({ kind, payload, digest: digest({ kind, payload }) });
const limit = 1024 * 1024;

function fixture(overrides = {}) {
    const calls = [];
    const sb = createBaseSandbox({
        crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
        localStorage: { getItem: () => { calls.push('storage'); }, setItem: () => { calls.push('storage'); } },
        addEventListener: () => { calls.push('window-listener'); },
        setTimeout: () => { calls.push('timer'); },
        fetch: async () => { calls.push('fetch'); throw new Error('协议工具不能联网'); },
        modHubAiRepair: { sanitizeText: text => text.replace('token=private', 'token=[已隐藏]') },
        modHubHelp: { redactRemoteCredentials: text => text.replaceAll('known-memory-key', '[已隐去密钥]') },
        ...overrides
    });
    sb.document.addEventListener = () => { calls.push('document-listener'); };
    sb.document.getElementById = () => { calls.push('document-read'); };
    loadScripts(sb, ['javascript/modhub-remote-protocol.js']);
    return { sb, protocol: sb.modHubRemoteProtocol, calls };
}

module.exports = async function runRemoteProtocolTests() {
    const { sb, protocol, calls } = fixture();
    assert.deepEqual(Object.keys(protocol).sort(), ['describeCommand', 'inspectCodeSources', 'readResponse', 'redactResultText', 'validateCommand']);
    assert.equal(sb.modHubRemoteHelp, undefined, '旧客户端工作流不能由协议工具恢复');
    assert.deepEqual(calls, [], '协议工具加载不读存储、DOM，不注册监听或启动联网');

    {
        const clean = [{ path: '指令.js', content: 'V.test = 1;\nState.variables.test = 2;' }];
        assert.equal(protocol.inspectCodeSources(clean).length, 0, '普通游戏变量修改不命中所检查的特征');
        const files = [
            { path: 'main.js', content: 'V.test = 1;\r\nfetch("https://example.invalid"); fetch("再次访问");\nlocalStorage.clear();\neval("V.test = 2");\nsetTimeout(() => {}, 0);' },
            { path: 'patch.twee', content: '段落正文\n<<script>>document.body.innerHTML = "<script>";<</script>>' },
            { path: 'replace.txt', content: '<div onclick="fetch()">文本</div>' }
        ];
        const original = JSON.stringify(files);
        const findings = JSON.parse(JSON.stringify(protocol.inspectCodeSources(files)));
        assert.deepEqual(findings.map(item => [item.path, item.category, item.line]), [
            ['main.js', '网络相关文本', 2], ['main.js', '本机数据相关文本', 3],
            ['main.js', '动态求值文本', 4], ['main.js', '异步调度文本', 5],
            ['patch.twee', '脚本或 HTML 注入文本', 2],
            ['replace.txt', '网络相关文本', 1], ['replace.txt', '脚本或 HTML 注入文本', 1]
        ], '每个文件和类别合并重复命中，保留稳定顺序与原文行号');
        assert.ok(findings.every(item => item.excerpt.length <= 180 && item.reason.startsWith('文本中包含')));
        assert.equal(JSON.stringify(files), original, '检查不能修改源码原文');
        const comments = protocol.inspectCodeSources([{ path: 'notes.html', content: '// fetch 仅是注释\rconst note = "indexedDB";' }]);
        assert.equal(comments.length, 2, '注释和字符串也保留文本线索，不能假装完成语法或行为判定');
        assert.equal(comments[1].line, 2, '独立回车也按原文行号处理');
        for (const source of ['new XMLHttpRequest()', 'new WebSocket()', 'new EventSource()', 'navigator.sendBeacon()']) {
            assert.equal(protocol.inspectCodeSources([{ path: 'script', content: source }])[0].category, '网络相关文本');
        }
        for (const source of ['document["cookie"]', 'sessionStorage.clear()', 'indexedDB.deleteDatabase("game")', 'caches.delete("game")']) {
            assert.equal(protocol.inspectCodeSources([{ path: 'script', content: source }])[0].category, '本机数据相关文本');
        }
        for (const source of ['new Function("return 1")', 'import("./code.js")']) {
            assert.equal(protocol.inspectCodeSources([{ path: 'script', content: source }])[0].category, '动态求值文本');
        }
        for (const source of ['document.createElement("script")', '<script>正文</script>', 'javascript:void(0)', 'document.write("正文")']) {
            assert.equal(protocol.inspectCodeSources([{ path: 'script', content: source }])[0].category, '脚本或 HTML 注入文本');
        }
        for (const source of ['queueMicrotask(() => {})', 'Promise.resolve(1)', 'async function test() {}', 'setInterval(() => {}, 1)']) {
            assert.equal(protocol.inspectCodeSources([{ path: 'script', content: source }])[0].category, '异步调度文本');
        }
        assert.deepEqual(calls, [], '扫描不执行、联网、采集本机数据或注册监听');
        assert.throws(() => protocol.inspectCodeSources([{ path: 'broken', content: null }]), /完整的文件路径和文本/);
        assert.throws(() => protocol.inspectCodeSources(null), /完整的文件路径和文本/);
    }

    const patch = { name: 'Example', version: '1.0.0', baselineHash: 'a'.repeat(64), summary: '修正取值', evidence: '源码依据', verification: '重新载入核验', changes: [{ path: 'main.js', before: '= 1', after: '= 2', reason: '修复' }] };
    for (const [kind, payload] of [
        ['collectDiagnostics', {}], ['collectDiagnostics', { allLogs: false }], ['collectDiagnostics', { allLogs: true }],
        ['readSources', { name: 'Example', paths: ['main.js'] }],
        ['readSources', { name: '名'.repeat(256), paths: Array.from({ length: 20 }, (_, index) => index + '.js') }],
        ['applyPatch', patch], ['applyPatch', { ...patch, changes: Array.from({ length: 8 }, (_, index) => ({ ...patch.changes[0], path: index + '.js' })) }],
        ['applyConfiguration', { issueId: 'dependency-X' }], ['applyConfiguration', { issueId: 'x'.repeat(1024) }]
    ]) await protocol.validateCommand(command(kind, payload));

    const quick = { summary: '修正当前游戏状态', script: '\nV.test = 1;\n', verification: '检查状态后自行存档' };
    await protocol.validateCommand(command('runJavaScript', quick));
    assert.match(protocol.describeCommand(command('runJavaScript', quick)), /须先备份游戏/);
    for (const payload of [{ ...quick, script: ' ' }, { ...quick, script: 'x'.repeat(16001) }, { ...quick, summary: 'x'.repeat(2001) }, { ...quick, verification: '' }, { ...quick, script: 1 }, { ...quick, save: '额外字段' }]) {
        await assert.rejects(protocol.validateCommand(command('runJavaScript', payload)), /快速指令|未支持的字段/);
    }
    await assert.rejects(protocol.validateCommand({ ...command('runJavaScript', quick), payload: { ...quick, script: 'V.test = 2;' } }), /摘要不一致/);
    await assert.rejects(protocol.validateCommand(null), /不受支持/);
    await assert.rejects(protocol.validateCommand(command('constructor', {})), /不受支持/, '继承属性不能成为支持的操作类型');
    await assert.rejects(protocol.validateCommand(command('collectDiagnostics', [])), /不受支持/);
    await assert.rejects(protocol.validateCommand(command('collectDiagnostics', null)), /不受支持/);
    await assert.rejects(protocol.validateCommand({ ...command('collectDiagnostics', { allLogs: false }), payload: { allLogs: true } }), /摘要不一致/, '校验篡改正文，不能沿用原摘要');
    await assert.rejects(protocol.validateCommand({ ...command('collectDiagnostics', {}), digest: 'A'.repeat(64) }), /摘要不一致/);
    for (const [kind, payload, error] of [
        ['collectDiagnostics', { allLogs: false, token: '不允许' }, /未支持的字段/],
        ['collectDiagnostics', { allLogs: 'true' }, /日志选择格式无效/],
        ['readSources', { name: '', paths: ['main.js'] }, /精确模组技术名/],
        ['readSources', { name: 1, paths: ['main.js'] }, /精确模组技术名/],
        ['readSources', { name: 'x'.repeat(257), paths: ['main.js'] }, /精确模组技术名/],
        ['readSources', { name: 'Example', paths: [] }, /1 至 20/],
        ['readSources', { name: 'Example', paths: Array(21).fill('main.js') }, /1 至 20/],
        ['readSources', { name: 'Example', paths: [1] }, /1 至 20/],
        ['applyPatch', { ...patch, version: '' }, /版本、路径或包体摘要/],
        ['applyPatch', { ...patch, changes: [] }, /版本、路径或包体摘要/],
        ['applyPatch', { ...patch, changes: Array(9).fill(patch.changes[0]) }, /版本、路径或包体摘要/],
        ['applyPatch', { ...patch, changes: [null] }, /版本、路径或包体摘要/],
        ['applyPatch', { ...patch, changes: [{ path: 1 }] }, /版本、路径或包体摘要/],
        ['applyPatch', { ...patch, baselineHash: 'A'.repeat(64) }, /版本、路径或包体摘要/],
        ['applyConfiguration', { issueId: '' }, /条目标识无效/],
        ['applyConfiguration', { issueId: 'x'.repeat(1025) }, /条目标识无效/],
        ['applyConfiguration', { issueId: 1 }, /条目标识无效/],
        ['applyConfiguration', { issueId: 'dependency-X', enabled: ['Example'] }, /未支持的字段/]
    ]) await assert.rejects(protocol.validateCommand(command(kind, payload)), error);
    assert.deepEqual(calls, [], '内容校验只计算摘要，不采集本机环境或发送请求');

    assert.equal(await protocol.readResponse({ text: async () => 'x'.repeat(limit) }), 'x'.repeat(limit));
    await assert.rejects(protocol.readResponse({ text: async () => '中'.repeat(Math.floor(limit / 3) + 1) }), /超过 1 MiB/, '按 UTF-8 字节计算响应限额');
    {
        const encoded = new TextEncoder().encode('跨块中文');
        const chunks = [encoded.slice(0, 1), encoded.slice(1)];
        let reads = 0, cancelled = false;
        assert.equal(await protocol.readResponse({ body: { getReader: () => ({
            read: async () => reads < chunks.length ? { value: chunks[reads++], done: false } : { done: true },
            cancel: async () => { cancelled = true; }
        }) }, text: async () => { throw new Error('不能绕过流式读取'); } }), '跨块中文');
        assert.equal(cancelled, true, '完成读取也释放响应流');
    }
    {
        let reads = 0, cancelled = false;
        await assert.rejects(protocol.readResponse({ body: { getReader: () => ({
            read: async () => { reads++; return { value: new Uint8Array(600000), done: false }; },
            cancel: async () => { cancelled = true; }
        }) }, text: async () => { throw new Error('不能完整缓存超限响应'); } }), /超过 1 MiB/);
        assert.equal(reads, 2, '读流超限立即停止，不等待其余正文');
        assert.equal(cancelled, true, '超限时取消响应流');
    }
    {
        let cancelled = false;
        await assert.rejects(protocol.readResponse({ body: { getReader: () => ({
            read: async () => { throw new Error('流读取中断'); },
            cancel: async () => { cancelled = true; throw new Error('流已关闭'); }
        }) } }), /流读取中断/);
        assert.equal(cancelled, true, '读取异常仍释放响应流，保留原具体原因');
    }

    const sensitive = 'token=private，当前凭据 known-memory-key';
    assert.equal(protocol.redactResultText(sensitive), 'token=[已隐藏]，当前凭据 [已隐去密钥]');
    assert.equal(sensitive, 'token=private，当前凭据 known-memory-key', '脱敏返回新字符串，不修改用于匹配的源码原文');
    for (const overrides of [{ modHubAiRepair: {} }, { modHubHelp: {} }]) {
        assert.throws(() => fixture(overrides).protocol.redactResultText(sensitive), /脱敏模块尚未就绪/, '任一脱敏依赖缺失时拒绝处理，不能原文回退');
    }

    assert.equal(protocol.describeCommand(command('collectDiagnostics', { allLogs: false })), '收集诊断：版本、模组清单、检查摘要及错误和警告日志。');
    assert.match(protocol.describeCommand(command('collectDiagnostics', { allLogs: true })), /全部已捕获日志/);
    assert.equal(protocol.describeCommand(command('readSources', { name: 'Example', paths: ['main.js', 'other.js'] })), '读取源码：Example\n文件：\nmain.js\nother.js');
    assert.equal(protocol.describeCommand(command('applyPatch', { ...patch, changes: [patch.changes[0], patch.changes[0]] })), '应用补丁：Example 1.0.0\n修正取值\n文件：\nmain.js');
    assert.equal(protocol.describeCommand(command('applyConfiguration', { issueId: 'dependency-X' })), '修复配置：根据本机重新检查，预览启用唯一前置或整理加载顺序的方案。');
};
