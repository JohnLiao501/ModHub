// 自有 AI 修复：发送边界、原文替换、过期材料与受控应用。
const { assert, createBaseSandbox, loadScripts } = require('./helpers');
const { createHash } = require('node:crypto');
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
    const state = {
        enabled: ['Example'], disabled: [], data: encode(options.files || { 'javascript/example.js': 'const value = broken();\nconst other = 1;', 'style/example.css': '.sample { color: red; }' }),
        boot: { name: 'Example', version: '1.0.0', scriptFileList: ['javascript/example.js'], styleFileList: ['style/example.css'], ...options.boot },
        requests: [], writes: [], timers: [], timerDelays: [], clearedTimers: [], aborts: 0,
        answer: { summary: '原函数不存在。', evidence: '源码调用 broken。', verification: '重新载入并重复原操作。', changes: [{ path: 'javascript/example.js', before: 'broken()', after: 'working()', reason: '使用有效函数。' }] },
    };
    const hash = async data => createHash('sha256').update(data).digest('hex');
    const sb = createBaseSandbox({
        TextEncoder, TextDecoder, Uint8Array, AbortController,
        setTimeout: (callback, delay) => { state.timers.push(callback); state.timerDelays.push(delay); return state.timers.length; },
        clearTimeout: timer => { state.clearedTimers.push(timer); },
        StartConfig: { version: '0.5.12.13' },
        modHubGetGui: () => ({ gModUtils: { version: '2.101.1' } }),
        modHubReadIndexDBModLists: async () => ({ ok: true, enabled: [...state.enabled], disabled: [...state.disabled] }),
        modHubReadInstalledModBoot: async name => ({ name, bootJson: { ...state.boot, name } }),
        modHubReadInstalledModPackage: async name => ({ name, bootJson: { ...state.boot, name }, data: new Uint8Array(state.data) }),
        modHubGetRawModLoaderLogs: () => [],
        modHubAnalyzeLogs: () => ({ lines: options.logs || [{ level: 'error', message: 'broken is not defined' }, { level: 'info', message: '不会发送的信息' }] }),
        modHubAiPackage: {
            hash,
            read: async data => {
                const files = JSON.parse(new TextDecoder().decode(data));
                return { bytes: new Uint8Array(data), entries: new Map(Object.entries(files).map(([path, content]) => [path, { size: new TextEncoder().encode(content).byteLength }])),
                    text: async path => files[path], sourceText: async path => files[path], fixtureFiles: files };
            },
            replace: async (archive, replacements) => encode({ ...archive.fixtureFiles, ...Object.fromEntries(replacements) }),
        },
        modHubApplyAiPackage: async plan => { state.writes.push(plan); state.data = new Uint8Array(plan.data); return { ok: true, pointId: 'repair-point' }; },
        fetch: async (url, request) => {
            state.requests.push({ url, request });
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.answer) } }] }) };
        },
    });
    loadScripts(sb, ['javascript/modhub-ai-repair.js']);
    return { sb, state, api: sb.modHubAiRepair, connection: { endpoint: 'https://example.test/v1', model: 'example', key: 'private-test-key-12345' } };
}

function multiplePackageFixture() {
    const f = fixture();
    f.state.enabled = ['A', 'B'];
    f.packages = {
        A: { files: { 'a.js': 'function innocent() { return 1; }' } },
        B: { files: { 'b.js': 'const result = broken();' } },
    };
    f.sb.modHubReadInstalledModPackage = async name => ({ bootJson: { name, version: '1.0.0',
        scriptFileList: Object.keys(f.packages[name].files) }, data: encode(f.packages[name].files) });
    f.answer = (readRequest = null) => ({ summary: '仍需核对责任来源。', evidence: '已有源码不能确认原日志的原因。',
        verification: '重新执行原操作并核对首条异常。', changes: [], readRequest });
    f.readA = { name: 'A', paths: ['a.js'], reason: '先核对声明中的调用。' };
    f.readB = { name: 'B', paths: ['b.js'], reason: 'A 未包含对应错误，继续核对另一候选包。' };
    return f;
}

async function assertReadCorrection(f, prepared, pattern) {
    const plan = await f.api.analyze(prepared, f.connection);
    assert.equal(plan.responseCorrection, true, '无效读取请求保留一次受限纠正机会，不读取请求路径');
    assert.match(plan.validationFeedback.reason, pattern);
    assert.equal(plan.readRequest, null);
    assert.deepEqual(plain(plan.changes), []);
    assert.equal(plan.data, null);
    return plan;
}

function patchBootFixture(content = '旧版选项\n<<if $money >= 300>>\n购买饮品\n<</if>>') {
    const before = '<<if $money gte 300>>', after = '<<if $money >= 300>>';
    const boot = { name: 'Example', version: '1.0.0', scriptFileList: [], styleFileList: [],
        addonPlugin: [{ modName: 'TweeReplacer', addonName: 'TweeReplacerAddon',
            params: [{ passage: 'Ocean Breeze', findString: before, replaceFile: 'patch/ocean.txt' }] }] };
    const f = fixture({ files: { 'boot.json': JSON.stringify(boot), 'patch/ocean.txt': '购买选项' }, boot,
        logs: [{ level: 'error', message: '[TweeReplacer] cannot find findString: [Example] findString: [' + before + '] in: [Ocean Breeze]' }] });
    const packageSandbox = createBaseSandbox({ TextEncoder, TextDecoder, Uint8Array });
    loadScripts(packageSandbox, ['javascript/modhub-ai-package.js']);
    f.sb.modHubAiPackage.validatePatchBoot = packageSandbox.modHubAiPackage.validatePatchBoot;
    f.game = { 'Ocean Breeze': content };
    f.gameReads = [];
    f.sb.modUtils = { getAllPassageData: () => Object.entries(f.game).map(([name, content]) => ({ name, content, tags: [] })),
        getPassageData: name => { f.gameReads.push(name); return typeof f.game[name] === 'string' ? { name, content: f.game[name] } : null; } };
    f.before = before; f.after = after;
    f.change = { path: 'boot.json', before: JSON.stringify(before), after: JSON.stringify(after), reason: '根据已核对的游戏原文更新失效查找串。' };
    return f;
}

module.exports = async function () {
    assert.equal(fixture().api.maxRounds, 5, '默认五轮预算，供界面读取');
    {
        const f = fixture();
        assert.equal(f.api.normalizeMaxRounds(), 5);
        for (const value of [0, 1, 12, 13, Number.MAX_SAFE_INTEGER]) assert.equal(f.api.normalizeMaxRounds(value), value);
        for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', '', null, false, {}]) {
            assert.throws(() => f.api.normalizeMaxRounds(value), /非负安全整数/);
            await assert.rejects(f.api.prepare('Example', '检查无效轮次。', { maxRounds: value }), /非负安全整数/);
            await assert.rejects(f.api.prepareLogs('检查无效轮次。', { maxRounds: value }), /非负安全整数/);
        }
        const logs = await f.api.prepareLogs('检查默认轮次。');
        assert.deepEqual(JSON.parse(logs.material).diagnosisContext, { round: 1, maxRounds: 5 });
        const source = await f.api.prepare('Example', '检查自定义轮次。', { maxRounds: 27 });
        assert.deepEqual(JSON.parse(source.material).diagnosisContext, { round: 1, maxRounds: 27 });
        f.state.answer.changes = [];
        const plan = await f.api.analyze(source, { ...f.connection, maxRounds: 1 });
        assert.match(plan.continuationReason, /第 1 轮.*27 轮/, '连接参数不能覆盖已经预览的私有轮次设定');
        const system = JSON.parse(f.state.requests[0].request.body).messages[0].content;
        assert.match(system, /最多 27 轮/); assert.ok(!system.includes('最多12轮'));
        const empty = await f.api.prepare('Example', '未选择源码。', { paths: [], maxRounds: 0 });
        assert.equal(empty.material, '', '轮次上下文不能把原本没有源码的预览变成可分析材料');
        await assert.rejects(f.api.analyze(empty, f.connection), /至少选择一个相关源码/);
        assert.equal(f.state.writes.length, 0);
    }
    {
        const calls = [];
        const forbidden = name => () => { calls.push(name); throw new Error('推荐选材不得访问 ' + name); };
        const sb = createBaseSandbox({ fetch: forbidden('网络'), modHubReadIndexDBModLists: forbidden('配置'),
            modHubReadInstalledModPackage: forbidden('包体'), modHubGetRawModLoaderLogs: forbidden('全局日志'),
            localStorage: { getItem: forbidden('存储'), setItem: forbidden('存储') } });
        loadScripts(sb, ['javascript/modhub-ai-repair.js']);
        const recommend = sb.modHubAiRepair.recommendFiles;
        const small = { description: '功能按钮报错。', fileNames: [{ path: 'scripts/alpha.js', size: 100 }, { path: 'styles/main.css', size: 50 }] };
        const all = recommend(small);
        assert.deepEqual(plain(all.paths), ['scripts/alpha.js', 'styles/main.css']);
        assert.deepEqual(plain(all.matchedPaths), []);
        assert.equal(all.totalSize, 150);
        assert.match(all.reason, /全部.*2.*声明文件/);
        assert.deepEqual(plain(recommend({ ...small, description: '在 alpha.js:12 报错。' }).paths), ['scripts/alpha.js']);
        assert.deepEqual(plain(recommend(small, [{ message: '错误来自（scripts/alpha.js:12）' }]).paths), ['scripts/alpha.js']);
        assert.deepEqual(plain(recommend(small, [{ files: ['styles/main.css'] }]).paths), ['styles/main.css']);
        for (const message of ['other/alpha.js:12', 'prefixscripts/alpha.js', 'scripts/alpha.js.map', 'long-alpha.js', 'alpha.js.old', 'alpha.jsX', '伪alpha.js']) {
            assert.deepEqual(plain(recommend(small, [{ message }]).matchedPaths), [], '不能将路径子串或相似文件名当作明确线索：' + message);
        }
        const special = { description: '报错位于「a+b(1)[x].js:2」', fileNames: [{ path: 'scripts/a+b(1)[x].js', size: 50 }, { path: 'other.js', size: 1 }] };
        assert.deepEqual(plain(recommend(special).paths), ['scripts/a+b(1)[x].js']);
        assert.deepEqual(plain(recommend({ ...special, description: '' }, ['错误：[scripts/a+b(1)[x].js:2]']).paths), ['scripts/a+b(1)[x].js']);
        const many = { description: '功能报错。', fileNames: Array.from({ length: 50 }, (_, index) => ({ path: 'scripts/file-' + index + '.js', size: 100 })) };
        const unknown = recommend(many);
        assert.deepEqual(plain(unknown.paths), [], '无线索大包不能任取前 20 个文件');
        assert.equal(unknown.omitted.length, 50);
        assert.match(unknown.reason, /先分析日志/);
        assert.deepEqual(plain(recommend(many, [{ message: 'scripts/file-49.js:2' }]).paths), ['scripts/file-49.js']);
        const sameName = { description: '', fileNames: [...many.fileNames, { path: 'first/index.js', size: 1 }, { path: 'second/index.js', size: 1 }] };
        const ambiguous = recommend(sameName, [{ message: 'index.js:2' }]);
        assert.deepEqual(plain(ambiguous.paths), []);
        assert.deepEqual(plain(ambiguous.ambiguousNames), ['index.js']);
        assert.match(ambiguous.reason, /同名文件无法唯一/);
        assert.deepEqual(plain(recommend(sameName, [{ message: 'second/index.js:2' }]).paths), ['second/index.js']);
        assert.deepEqual(plain(recommend({ description: '', fileNames: [{ path: 'index.js', size: 1 }, { path: 'second/index.js', size: 1 }] }, ['index.js:2']).matchedPaths), [], '根目录文件名也不能绕过同名歧义');
        const limits = { description: '', fileNames: [{ path: 'large.js', size: 256 * 1024 + 1 }, { path: 'small.js', size: 100 }] };
        const partial = recommend(limits, ['large.js:2 small.js:3']);
        assert.deepEqual(plain(partial.paths), ['small.js']);
        assert.match(partial.omitted[0].reason, /256 KiB.*不能截断/);
        assert.match(partial.reason, /未发送或截断/);
        assert.deepEqual(plain(recommend(limits).paths), [], '无线索时不能只凭文件大小选源码');
        const tooManyNamed = recommend(many, [{ files: many.fileNames.map(file => file.path) }]);
        assert.deepEqual(plain(tooManyNamed.paths), []);
        assert.match(tooManyNamed.reason, /无法自动决定舍弃/);
        const total = recommend({ description: '', fileNames: ['a.js', 'b.js', 'c.js'].map(path => ({ path, size: 200 * 1024 })) }, ['a.js b.js c.js']);
        assert.deepEqual(plain(total.paths), []);
        assert.match(total.reason, /512 KiB/);
        assert.deepEqual(plain(recommend({ description: '', fileNames: [] }).paths), []);
        assert.throws(() => recommend({ fileNames: [{ path: 'bad.js', size: NaN }] }), /格式无效/);
        assert.throws(() => recommend({ fileNames: [{ path: '../bad.js', size: 1 }] }), /格式无效/);
        assert.deepEqual(calls, [], '推荐函数只使用显式传入的清单、描述和日志');
    }

    {
        const f = fixture();
        const metadata = { description: '', fileNames: [{ path: 'patch/robin.txt', size: 20 }, { path: 'patch/other.txt', size: 20 }, { path: 'scripts/known.js', size: 20 }],
            bootJson: { addonPlugin: [
                { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ passage: 'Widgets Robin', replaceFile: 'patch/robin.txt' }, { passage: 'Widgets Other', replaceFile: 'patch/other.txt' }] },
                { modName: 'OtherPlugin', addonName: 'TweeReplacerAddon', params: [{ passage: 'Widgets Robin', replaceFile: 'patch/other.txt' }] },
            ] } };
        const exact = f.api.recommendFiles(metadata, [{ message: '段落替换失败', files: ['Widgets Robin'] }]);
        assert.deepEqual(plain(exact.paths), ['patch/robin.txt']);
        assert.match(exact.reason, /段落及 TweeReplacer 声明/);
        assert.deepEqual(plain(f.api.recommendFiles(metadata, [{ files: ['Robin'] }]).matchedPaths), [], '不能模糊关联段落名');
        assert.deepEqual(plain(f.api.recommendFiles(metadata, [{ files: ['Widgets Robin', 'scripts/known.js'] }]).paths), ['scripts/known.js'], '明确文件线索优先于段落范围');
    }

    {
        const selected = '早期首错 Authorization: Bearer selected-secret-123 api_key="selected-api-secret"';
        const logs = [{ level: 'error', message: selected }, ...Array.from({ length: 100 }, (_, index) => ({ level: 'error', message: '后续错误 ' + index }))];
        const f = fixture({ logs });
        const prepared = await f.api.prepare('Example', '日志中的操作失败。', { paths: ['javascript/example.js'], logError: selected });
        const material = JSON.parse(prepared.material);
        assert.match(material.logs[0], /早期首错/);
        assert.equal(material.logs.length, 80);
        assert.equal(material.logs.filter(line => line.includes('早期首错')).length, 1);
        assert.ok(!prepared.material.includes('selected-secret-123'));
        assert.ok(!prepared.material.includes('selected-api-secret'));
        assert.ok(!('logError' in prepared), '选中原日志不新增可被误用的公开材料字段');
        const recent = fixture({ logs: [{ level: 'error', message: selected }, { level: 'warn', message: selected }] });
        assert.equal(JSON.parse((await recent.api.prepare('Example', '日志中的操作失败。', { logError: selected })).material).logs.length, 1, '选中日志在全局出现时按脱敏文本去重');
        const full = '完整选中日志 ' + 'x'.repeat(32 * 1024 - new TextEncoder().encode('完整选中日志 ').byteLength);
        const nearLimit = fixture({ logs: [{ level: 'error', message: '追加日志不能挤掉选中内容' }] });
        const nearMaterial = JSON.parse((await nearLimit.api.prepare('Example', '日志中的操作失败。', { logError: full })).material);
        assert.deepEqual(nearMaterial.logs, [full], '恰好 32 KiB 的选中日志完整保留且不附超限日志');
        for (const logError of [null, {}, 3, 'x'.repeat(32 * 1024 + 1)]) {
            const invalid = fixture();
            invalid.sb.modHubReadIndexDBModLists = () => { throw new Error('不应读取配置'); };
            await assert.rejects(invalid.api.prepare('Example', '日志中的操作失败。', { paths: [], logError }), /选中的问题日志/);
            assert.equal(invalid.state.requests.length, 0);
        }
    }

    {
        const f = fixture();
        f.sb.modHubReadInstalledModPackage = () => { throw new Error('纯日志分析不得读取包体'); };
        f.sb.modHubReadInstalledModBoot = () => { throw new Error('纯日志分析不得读取包体声明'); };
        delete f.sb.modHubAiPackage;
        const prepared = await f.api.prepareLogs('根据选中的错误说明排查步骤。', { logError: '原始错误 token=selected-secret' });
        assert.equal(prepared.name, '');
        assert.equal(prepared.baselineData, null);
        assert.deepEqual(plain(prepared.files), []);
        assert.deepEqual(plain(prepared.fileNames), []);
        assert.deepEqual(plain(prepared.sourceCatalog), []);
        assert.deepEqual(plain(prepared.sourceUnavailable), []);
        const material = JSON.parse(prepared.material);
        assert.equal(material.target, null);
        assert.deepEqual(material.files, []);
        assert.deepEqual(material.savedConfiguration.enabled, ['Example'], '已安装模组仍可作为清单线索，但不发送其源码');
        assert.ok(!prepared.material.includes('const value'));
        assert.ok(!prepared.material.includes('selected-secret'));
        assert.equal(f.state.requests.length, 0);
        f.state.answer.changes = [];
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(plan.name, '');
        assert.equal(plan.data, null);
        assert.equal(f.state.requests.length, 1);
        assert.equal((await f.api.apply(plan)).ok, false);
        assert.equal(f.state.writes.length, 0);
        f.state.answer.changes = [{ path: 'javascript/example.js', before: 'broken()', after: 'working()', reason: '越权修改' }];
        await assert.rejects(f.api.analyze(await f.api.prepareLogs('分析日志。'), f.connection), /仅分析日志/);
        assert.equal(f.state.writes.length, 0);
        const noTarget = fixture();
        noTarget.state.enabled = [];
        assert.equal((await noTarget.api.prepareLogs('没有目标时先分析错误。')).name, '');
    }

    {
        const changed = fixture();
        const prepared = await changed.api.prepareLogs('分析日志。');
        changed.state.disabled.push('Other');
        await assert.rejects(changed.api.analyze(prepared, changed.connection), /改变/);
        assert.equal(changed.state.requests.length, 0);
        const superseded = fixture();
        const old = await superseded.api.prepareLogs('旧日志。');
        await superseded.api.prepareLogs('新日志。');
        await assert.rejects(superseded.api.analyze(old, superseded.connection), /过期/);
        const raced = fixture();
        let reads = 0;
        raced.sb.modHubReadIndexDBModLists = async () => ({ ok: true, enabled: ++reads === 1 ? ['Example'] : [], disabled: [] });
        await assert.rejects(raced.api.prepareLogs('分析日志。'), /准备日志材料期间模组配置已改变/);
        const altered = fixture();
        const alteredPrepared = await altered.api.prepareLogs('分析日志。');
        alteredPrepared.material = '其他材料';
        await assert.rejects(altered.api.analyze(alteredPrepared, altered.connection), /材料已改变/);
        await assert.rejects(altered.api.prepareLogs('x'.repeat(4001)), /4000/);
        await assert.rejects(altered.api.prepareLogs('日志异常。', { logError: 'x'.repeat(32 * 1024 + 1) }), /32 KiB/);
    }

    // 首轮只发送真实声明目录；读取后仍须独立确认发送，最终应用沿用原文替换。
    {
        const f = fixture();
        let textReads = 0;
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data), originalText = archive.text;
            archive.text = async path => { textReads++; return originalText(path); };
            return archive;
        };
        f.state.enabled.push('ModHub', 'TweeReplacer');
        const stages = [];
        const prepared = await f.api.prepareLogs('功能按钮报错。', { includeSources: true, logError: '完整选中错误 token=selected-secret', onProgress: stage => stages.push(stage) });
        assert.deepEqual(plain(prepared.sourceCatalog), [{ name: 'Example', version: '1.0.0', boot: { name: 'Example', version: '1.0.0', addonPlugin: [] }, files: [
            { path: 'javascript/example.js', size: 40 }, { path: 'style/example.css', size: 23 },
        ] }]);
        assert.deepEqual(plain(prepared.sourceUnavailable), []);
        assert.deepEqual(stages, ['catalog'], '目录进度只传固定阶段，不传包名、日志或密钥');
        assert.equal(textReads, 0, '准备目录不能解压源码正文');
        assert.deepEqual(JSON.parse(prepared.material).files, []);
        assert.deepEqual(JSON.parse(prepared.material).sourceCatalog, plain(prepared.sourceCatalog));
        assert.ok(!prepared.material.includes('const value'));
        assert.equal(f.state.requests.length, 0);
        const patch = plain(f.state.answer);
        f.state.answer = { ...patch, summary: '需要核对函数 token=diagnosis-secret。', changes: [],
            readRequest: { name: 'Example', paths: ['javascript/example.js'], reason: '核对日志中的 broken 调用。' } };
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(plan.mode, 'source-request');
        assert.deepEqual(plain(plan.readRequest), f.state.answer.readRequest);
        assert.deepEqual(plain(plan.changes), []);
        assert.equal(plan.data, null);
        assert.equal(plan.diff, '');
        assert.equal(textReads, 0, '收到读取请求不会隐式解压源码');
        assert.equal((await f.api.apply(plan)).ok, false);
        const next = await f.api.prepareRequestedSources(plan);
        assert.equal(next.name, 'Example');
        assert.deepEqual(plain(next.files).map(file => file.path), ['javascript/example.js']);
        assert.equal(textReads, 1);
        const material = JSON.parse(next.material);
        assert.match(material.diagnosisContext.notice, /不可信分析数据/);
        assert.deepEqual(material.diagnosisContext.readRequest, f.state.answer.readRequest);
        assert.ok(!next.material.includes('diagnosis-secret'));
        assert.ok(!next.material.includes('selected-secret'));
        assert.ok(material.logs.some(line => line.includes('完整选中错误')));
        assert.ok(next.material.includes('const value = broken()'));
        assert.equal(f.state.requests.length, 1, '本地整理请求源码不发起第二次云请求');
        assert.equal(f.state.writes.length, 0, '目录、诊断与源码预览均不写入包体');
        await assert.rejects(f.api.prepareRequestedSources(plan), /过期/);
        f.state.answer = { ...patch, readRequest: null };
        const repaired = await f.api.analyze(next, f.connection);
        assert.equal(f.state.requests.length, 2, '第二次分析只在显式调用后执行');
        assert.equal(repaired.mode, 'structured');
        assert.equal(repaired.readRequest, null);
        assert.match(repaired.diff, /working\(\)/);
        assert.equal(f.state.writes.length, 0);
        assert.equal((await f.api.apply(repaired)).ok, true);
        assert.equal(f.state.writes.length, 1);
        assert.deepEqual(plain(f.state.writes[0].enabled), ['Example', 'ModHub', 'TweeReplacer']);
    }

    // 大文件只读窗口、声明锚点及累计证据，均不扩大当前单包写入权限。
    {
        const f = fixture({ files: { 'patch/Start.txt': '<<npcPregnancyUpdater>>' }, boot: { scriptFileList: [], styleFileList: [],
            alias: ['NativeExample', 'NativeSecond'], dependenceInfo: [{ modName: 'Required', version: '^2.0.0', password: '不能发送' }],
            api_key: '不能发送', description: '不能发送', addonPlugin: [
                { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ passage: 'Start', findString: '<<old>>',
                    findRegex: 'old\\s+', regexFlag: 'g', tip: 'token=private-value', replaceFile: 'patch/Start.txt', secret: '不能发送' }] },
                { modName: 'Unknown', params: [{ findString: '不能发送' }] },
            ] } });
        const prepared = await f.api.prepareLogs('Start 段落异常。', { includeSources: true });
        const boot = prepared.sourceCatalog[0].boot;
        assert.deepEqual(plain(boot.alias), ['NativeExample', 'NativeSecond'], '仅采用包内原生 alias 标识，保留依赖身份依据');
        assert.deepEqual(plain(boot.dependenceInfo), [{ modName: 'Required', version: '^2.0.0' }]);
        assert.equal(boot.addonPlugin[0].params[0].findString, '<<old>>');
        assert.equal(boot.addonPlugin[0].params[0].findRegex, 'old\\s+');
        assert.equal(boot.addonPlugin[0].params[0].regexFlag, 'g');
        assert.ok(!prepared.material.includes('private-value'));
        assert.ok(!prepared.material.includes('不能发送'));
        assert.ok(!prepared.sourceCatalog[0].files.some(file => file.path === 'boot.json'));
        f.state.answer = { ...f.state.answer, changes: [], readRequest: null };
        const next = await f.api.prepareInvestigation(await f.api.analyze(prepared, f.connection));
        assert.equal(next.files[0].path, 'patch/Start.txt', '明确段落名与原生补丁声明可本地定位，保留真实替换条件');
        assert.equal(f.state.requests.length, 1);
    }

    {
        const f = fixture({ boot: { alias: 'NativeSingleAlias', nickName: '不会推断为技术标识' } });
        const prepared = await f.api.prepare('Example', '核对声明身份。');
        assert.equal(JSON.parse(prepared.material).targetBoot.alias, 'NativeSingleAlias');
        assert.ok(!prepared.material.includes('不会推断为技术标识'));
    }

    {
        const content = 'x'.repeat(300 * 1024) + '\nconst pregnancy = broken();\n' + 'y'.repeat(300 * 1024);
        const f = fixture({ files: { 'distinject_early.js': content }, boot: { scriptFileList: ['distinject_early.js'], styleFileList: [] } });
        let sourceReads = 0, fullReads = 0;
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.text = async () => { fullReads++; throw new Error('大文件不能进入可改全文'); };
            archive.sourceText = async path => { sourceReads++; return archive.fixtureFiles[path]; };
            return archive;
        };
        const prepared = await f.api.prepareLogs('读取 pregnancy 时报错。', { includeSources: true });
        assert.deepEqual(plain(prepared.sourceUnavailable), [], '大文件可以按线索只读定位，不再整文件拒绝');
        assert.equal(sourceReads, 0, '初始目录预览仍不读取任何源码正文');
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['distinject_early.js'], reason: '定位真实属性读取。', search: ['pregnancy'] } };
        const first = await f.api.analyze(prepared, f.connection);
        const next = await f.api.prepareRequestedSources(first);
        assert.deepEqual(plain(next.files), [], '大文件只读窗口绝不列入可写 files');
        assert.equal(fullReads, 0); assert.equal(sourceReads, 1);
        const evidence = next.sourceEvidence[0];
        assert.equal(evidence.name, 'Example'); assert.equal(evidence.path, 'distinject_early.js');
        assert.equal(evidence.content, content.slice(evidence.start, evidence.end));
        assert.equal(evidence.offset, evidence.start); assert.equal(evidence.line, content.slice(0, evidence.start).split('\n').length);
        assert.equal(evidence.incomplete, true); assert.equal(evidence.writable, false);
        assert.ok(evidence.content.includes('pregnancy')); assert.ok(evidence.content.length < content.length);
        assert.deepEqual(JSON.parse(next.material).sourceEvidence, plain(next.sourceEvidence));
        assert.ok(new TextEncoder().encode(evidence.content).byteLength <= 512 * 1024);
        assert.equal(f.state.requests.length, 1, '读取窗口只在本机整理，发送须另行调用');
        await assertReadCorrection(f, next, /已经读取.*没有新增定位证据/);
        f.state.answer = { ...f.state.answer, readRequest: null, changes: [{ path: 'distinject_early.js', before: 'broken()', after: 'working()', reason: '试图直接写入只读大文件。' }] };
        await assert.rejects(f.api.analyze(next, f.connection), /不能.*修改|未提供的文件/);
        f.state.answer.changes = [];
        const plan = await f.api.analyze(next, f.connection);
        assert.equal((await f.api.apply(plan)).ok, false);
        assert.equal(f.state.writes.length, 0);
        next.sourceEvidence[0].start++;
        const requests = f.state.requests.length;
        await assert.rejects(f.api.analyze(next, f.connection), /待发送材料已改变/);
        assert.equal(f.state.requests.length, requests, '篡改窗口元数据在网络前拒绝');
    }

    for (const search of [[], [''], ['x'], [null], ['line\nbreak'], [' same'], ['same', 'same'], Array.from({ length: 9 }, (_, index) => 'token' + index), ['x'.repeat(129)]]) {
        const f = fixture();
        const prepared = await f.api.prepareLogs('核对源码。', { includeSources: true });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['javascript/example.js'], reason: '核对明确线索。', search } };
        await assertReadCorrection(f, prepared, /搜索词无效/);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const content = 'x'.repeat(300 * 1024) + ' otherIdentifier ';
        const f = fixture({ files: { 'large.js': content }, boot: { scriptFileList: ['large.js'], styleFileList: [] }, logs: [] });
        const prepared = await f.api.prepareLogs('功能异常，无明确源码标识符。', { includeSources: true });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['large.js'], reason: '需要定位。' } };
        await assertReadCorrection(f, prepared, /readRequest.search.*large\.js/);
        f.state.answer.readRequest.search = ['missingIdentifier'];
        const request = await f.api.analyze(prepared, f.connection);
        await assert.rejects(f.api.prepareRequestedSources(request), /large\.js.*未找到新的.*missingIdentifier/);
        assert.equal(f.state.requests.length, 2, '本地无命中不隐式重发请求');
        assert.equal(f.state.writes.length, 0);
    }

    {
        const content = 'x'.repeat(300 * 1024) + '\nconst pregnancy = broken();\n';
        const f = fixture({ files: { 'bundle.js': content }, boot: { scriptFileList: ['bundle.js'], styleFileList: [] }, logs: [{ level: 'error', message: "Cannot read properties of undefined (reading 'pregnancy')" }] });
        const prepared = await f.api.prepareLogs('打开页面失败。', { includeSources: true });
        f.state.answer.changes = [];
        const next = await f.api.prepareInvestigation(await f.api.analyze(prepared, f.connection));
        assert.equal(next.files.length, 0);
        assert.ok(next.sourceEvidence.some(item => item.path === 'bundle.js' && item.content.includes('pregnancy')));
        assert.equal(JSON.parse(next.material).diagnosisContext.round, 2);
        assert.equal(f.state.requests.length, 1);
        const plan = await f.api.analyze(next, f.connection);
        await assert.rejects(f.api.prepareInvestigation(plan), /没有新的源码证据/, '相同窗口不形成新一轮事实');
        assert.equal(f.state.requests.length, 2);
    }

    {
        const large = 'x'.repeat(6 * 1024 * 1024 - 40);
        const files = { 'large-one.js': large + '\nconst result = diagnosisNeedle();', 'large-two.js': large,
            'large-three.js': large + '\nconst result = diagnosisNeedle();' };
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] },
            logs: [{ level: 'error', message: 'diagnosisNeedle is not defined' }] });
        const reads = [];
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.sourceText = async path => { reads.push(path); return archive.fixtureFiles[path]; };
            return archive;
        };
        f.state.answer = { summary: '需要核对 diagnosisNeedle 的真实定义。', evidence: '日志报告 diagnosisNeedle is not defined。', verification: '核对原调用。', changes: [] };
        const initial = await f.api.prepareLogs('诊断函数缺失。', { includeSources: true });
        const first = await f.api.prepareInvestigation(await f.api.analyze(initial, f.connection));
        assert.deepEqual(reads, ['large-one.js', 'large-two.js']);
        assert.deepEqual(JSON.parse(first.material).diagnosisContext.searchHistory.map(item => item.path), ['large-one.js', 'large-two.js'], '完整扫描但未命中的大文件同样记账');
        const second = await f.api.prepareInvestigation(await f.api.analyze(first, f.connection));
        assert.deepEqual(reads, ['large-one.js', 'large-two.js', 'large-three.js'], '下一轮相同词跳过此前扫描，剩余候选能进入 16 MiB 本地预算');
        assert.ok(second.sourceEvidence.some(item => item.path === 'large-one.js'));
        assert.ok(second.sourceEvidence.some(item => item.path === 'large-three.js'));
        assert.equal(JSON.parse(second.material).diagnosisContext.round, 3);
        const plan = await f.api.analyze(second, f.connection);
        await assert.rejects(f.api.prepareInvestigation(plan), /没有新的源码证据/, '全部扫描完后停止，不重复发送同一证据');
        assert.equal(f.state.requests.length, 3); assert.equal(f.state.writes.length, 0);
    }
    {
        const large = 'x'.repeat(6 * 1024 * 1024 - 40);
        const files = { 'first.js': large, 'second.js': large, 'third.js': large + '\nconst result = diagnosisNeedle();' };
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] },
            logs: [{ level: 'error', message: 'diagnosisNeedle is not defined' }] });
        const reads = [];
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.sourceText = async path => { reads.push(path); return archive.fixtureFiles[path]; };
            return archive;
        };
        f.state.answer = { summary: '核对实际定义。', evidence: 'diagnosisNeedle is not defined。', verification: '核对原调用。', changes: [] };
        const initial = await f.api.prepareLogs('诊断函数缺失。', { includeSources: true });
        const next = await f.api.prepareInvestigation(await f.api.analyze(initial, f.connection));
        assert.deepEqual(reads, ['first.js', 'second.js', 'third.js'], '整批无命中时在本机换批，第三份不被前两份重新占预算');
        assert.ok(next.sourceEvidence.some(item => item.path === 'third.js' && item.content.includes('diagnosisNeedle')));
        assert.equal(JSON.parse(next.material).diagnosisContext.round, 2, '本地两批扫描仍只生成下一轮材料');
        assert.deepEqual(JSON.parse(next.material).diagnosisContext.searchHistory.map(item => item.path), ['first.js', 'second.js', 'third.js']);
        assert.ok(next.sourceEvidenceOmitted.some(item => item.path === 'third.js' && /第 1 批.*16 MiB/.test(item.reason)));
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }
    {
        const marker = '\nconst result = diagnosisNeedle();';
        const small = 'x'.repeat(256 * 1024 - marker.length) + marker;
        const files = { 'one.js': small, 'two.js': small, 'large.js': 'x'.repeat(300 * 1024) + marker };
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] },
            logs: [{ level: 'error', message: 'diagnosisNeedle is not defined' }] });
        const reads = [];
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.sourceText = async path => { reads.push(path); return archive.fixtureFiles[path]; };
            return archive;
        };
        f.state.answer = { summary: '核对实际定义。', evidence: 'diagnosisNeedle is not defined。', verification: '核对原调用。', changes: [] };
        const first = await f.api.prepareInvestigation(await f.api.analyze(await f.api.prepareLogs('调用失败。', { includeSources: true }), f.connection));
        assert.deepEqual(plain(first.files).map(item => item.path), ['one.js', 'two.js']);
        assert.ok(!first.sourceEvidence.some(item => item.path === 'large.js'));
        assert.ok(!JSON.parse(first.material).diagnosisContext.searchHistory.some(item => item.path === 'large.js'), '命中却无正文预算时不误记大文件已完成');
        const next = await f.api.prepareInvestigation(await f.api.analyze(first, f.connection));
        assert.ok(next.sourceEvidence.some(item => item.path === 'large.js' && item.content.includes('diagnosisNeedle')));
        assert.deepEqual(reads, ['one.js', 'two.js', 'large.js', 'large.js'], '下一轮跳过已读小文件，重新提供此前被预算挡住的大文件窗口');
        assert.equal(f.state.requests.length, 2); assert.equal(f.state.writes.length, 0);
    }
    for (const interrupt of ['read-failure', 'snapshot']) {
        const large = 'x'.repeat(6 * 1024 * 1024 - 40);
        const files = { 'first.js': large, 'second.js': large, 'third.js': large + '\nconst result = diagnosisNeedle();' };
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] },
            logs: [{ level: 'error', message: 'diagnosisNeedle is not defined' }] });
        const reads = [];
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.sourceText = async path => {
                reads.push(path);
                if (path === 'first.js' && interrupt === 'read-failure') throw new Error('本地文本读取失败');
                if (path === 'second.js' && interrupt === 'snapshot') f.state.data = encode({ ...files, 'third.js': '已变更的包体' });
                return archive.fixtureFiles[path];
            };
            return archive;
        };
        f.state.answer = { summary: '核对实际定义。', evidence: 'diagnosisNeedle is not defined。', verification: '核对原调用。', changes: [] };
        const plan = await f.api.analyze(await f.api.prepareLogs('诊断调用失败。', { includeSources: true }), f.connection);
        if (interrupt === 'snapshot') {
            await assert.rejects(f.api.prepareInvestigation(plan), /安装包已改变/, '本地批次间核验快照，不扫描已变更包体的下一批');
            assert.deepEqual(reads, ['first.js', 'second.js']);
        } else {
            const next = await f.api.prepareInvestigation(plan);
            assert.deepEqual(reads, ['first.js', 'second.js', 'third.js'], '本地失败不在同次准备中无限重试');
            assert.deepEqual(JSON.parse(next.material).diagnosisContext.searchHistory.map(item => item.path), ['second.js', 'third.js'], '读取失败不记为完成扫描');
            assert.ok(next.sourceEvidenceOmitted.some(item => item.path === 'first.js' && /本地文本读取失败/.test(item.reason)));
            assert.ok(next.sourceEvidence.some(item => item.path === 'third.js'));
        }
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }

    {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'a'.repeat(200 * 1024);
        f.packages.B.files = { 'b.js': 'b'.repeat(200 * 1024), 'b2.js': 'c'.repeat(200 * 1024) };
        f.state.answer = f.answer(f.readA);
        const a = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('核对原文证据预算。', { includeSources: true }), f.connection));
        f.state.answer = f.answer({ name: 'B', paths: ['b.js', 'b2.js'], reason: '明确请求第二个包的完整源码。' });
        const b = await f.api.prepareRequestedSources(await f.api.analyze(a, f.connection));
        assert.equal(b.sourceEvidence.length, 0, '当前完整源码优先，不偷偷截断旧正文塞入预算');
        assert.ok(b.sourceEvidenceOmitted.some(item => item.name === 'A' && item.path === 'a.js' && /512 KiB.*未保留.*旧正文/.test(item.reason)));
        assert.equal(JSON.parse(b.material).diagnosisContext.readHistory[0].paths[0], 'a.js', '已读记录与实际正文是否保留分别说明');
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = multiplePackageFixture();
        f.state.answer = f.answer(f.readA);
        const a = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('检查首错。', { includeSources: true }), f.connection));
        f.state.answer = f.answer(f.readB);
        const b = await f.api.prepareRequestedSources(await f.api.analyze(a, f.connection));
        assert.equal(b.sourceEvidence[0].content, f.packages.A.files['a.js']);
        assert.equal(b.sourceEvidence[0].name, 'A');
        f.packages.A.files['a.js'] = '篡改旧证据所在包';
        await assert.rejects(f.api.analyze(b, f.connection), /候选模组.*安装包已改变/);
        assert.equal(f.state.requests.length, 2, '累计证据所在包变化必须在再次请求前拒绝');
    }

    for (const wrap of [value => '这是分析说明。\n' + value + '\n以上仅为建议。', value => '前置说明 {不是 JSON}\n' + value]) {
        const f = fixture();
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: wrap(JSON.stringify(f.state.answer)) } }] }) });
        const plan = await f.api.analyze(await f.api.prepare('Example', '执行功能报错。'), f.connection);
        if (wrap('').includes('{不是 JSON}')) {
            assert.equal(plan.mode, 'advice'); assert.equal(plan.data, null); assert.equal(plan.changes.length, 0);
        } else { assert.equal(plan.mode, 'structured'); assert.equal(plan.changes.length, 1, '唯一完整对象允许带外说明，仍核验真实锚点'); }
    }

    const readingAnswer = (f, readRequest) => ({ ...f.state.answer, changes: [], readRequest });
    const validReadRequest = () => ({ name: 'Example', paths: ['javascript/example.js'], reason: '需要核对函数原文。' });
    for (const [request, pattern] of [
        [{ ...validReadRequest(), name: 'Unknown' }, /不在本次/],
        [{ ...validReadRequest(), name: 'ModHub' }, /不能请求/],
        [{ ...validReadRequest(), name: 'TweeReplacer' }, /不能请求/],
        [{ ...validReadRequest(), paths: ['unknown.js'] }, /未声明/],
        [{ ...validReadRequest(), paths: ['README.md'] }, /未声明/],
        [{ ...validReadRequest(), paths: ['../example.js'] }, /请求无效/],
        [{ ...validReadRequest(), paths: ['https://example.test/example.js'] }, /请求无效/],
        [{ ...validReadRequest(), paths: ['boot.json'] }, /请求无效/],
        [{ ...validReadRequest(), paths: [] }, /请求无效/],
        [{ ...validReadRequest(), paths: ['javascript/example.js', 'javascript/example.js'] }, /请求无效/],
        [{ ...validReadRequest(), paths: Array.from({ length: 21 }, (_, index) => 'file-' + index + '.js') }, /请求无效/],
        [{ ...validReadRequest(), reason: '' }, /请求无效/],
        [{ ...validReadRequest(), command: 'run()' }, /请求无效/],
    ]) {
        const f = fixture();
        const prepared = await f.api.prepareLogs('先定位日志。', { includeSources: true });
        f.state.answer = readingAnswer(f, request);
        await assertReadCorrection(f, prepared, pattern);
        assert.equal(f.state.requests.length, 1, '无效请求不读取文件，纠正材料准备仍须调用独立入口');
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        f.state.answer.readRequest = validReadRequest();
        await assert.rejects(f.api.analyze(await f.api.prepareLogs('先定位日志。', { includeSources: true }), f.connection), /不能与代码修改同时/);
        f.state.answer.changes = [];
        await assert.rejects(f.api.analyze(await f.api.prepareLogs('普通日志分析。'), f.connection), /不允许.*额外源码/);
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '源码分析。'), f.connection), /不允许.*额外源码/, '未提供真实目录的初始源码材料不能凭模型猜测请求其它包');
        await assert.rejects(f.api.prepareLogs('日志分析。', { includeSources: 'true' }), /选项格式/);
        assert.equal(f.state.writes.length, 0);
    }

    for (const [files, request, pattern] of [
        [{ 'large.js': 'x'.repeat(8 * 1024 * 1024 + 1) }, { name: 'Example', paths: ['large.js'], reason: '读取大文件。' }, /单文件 8 MiB/],
        [{ 'a.js': 'x'.repeat(256 * 1024), 'b.js': 'x'.repeat(256 * 1024), 'c.js': 'x' }, { name: 'Example', paths: ['a.js', 'b.js', 'c.js'], reason: '读取相关文件。' }, /512 KiB/],
    ]) {
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] } });
        const prepared = await f.api.prepareLogs('先定位日志。', { includeSources: true });
        if (Object.keys(files).length === 1) assert.deepEqual(plain(prepared.sourceUnavailable), [{ name: 'Example', path: 'large.js', reason: '单文件超过本地只读扫描的 8 MiB 上限，不能读取或修改。' }]);
        f.state.answer = readingAnswer(f, request);
        await assertReadCorrection(f, prepared, pattern);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const path = 'modules/eden-cc.js';
        const f = fixture({ files: { [path]: 'const init = broken();', 'readme.txt': '不能发送', 'image.png': '不能发送' },
            boot: { scriptFileList: [], styleFileList: [], additionFile: [path, 'readme.txt', 'image.png'] } });
        f.state.enabled = ['FertilityExpansion'];
        const prepared = await f.api.prepareLogs('初始化调用失败。', { includeSources: true });
        assert.deepEqual(plain(prepared.sourceCatalog[0].files).map(file => file.path), [path], '真实 additionFile 源码模块进入确认目录，普通说明与图片不发送');
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'FertilityExpansion', paths: [path], reason: '核对初始化调用。' } };
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(prepared, f.connection));
        assert.equal(selected.files[0].content, 'const init = broken();');
        f.state.answer.readRequest = null;
        const located = await f.api.analyze(selected, f.connection);
        const repair = await f.api.prepareRepair(located, 'FertilityExpansion');
        assert.equal(JSON.parse(repair.material).repairIntent, 'generate-code-repair');
        f.state.answer.changes = [{ path, before: 'broken()', after: 'working()', reason: '调用已存在的初始化入口。' }];
        const plan = await f.api.analyze(repair, f.connection);
        assert.equal((await f.api.apply(plan)).ok, true);
        assert.equal(JSON.parse(new TextDecoder().decode(f.state.data))[path], 'const init = working();');
        assert.deepEqual(plain(f.state.writes[0].enabled), ['FertilityExpansion']);
    }

    for (const additionFile of [{}, ['../outside.js'], ['/outside.js'], ['valid.js', null], ['readme.txt', 'C:/outside.png']]) {
        const f = fixture({ boot: { additionFile } });
        await assert.rejects(f.api.prepare('Example', '核对声明文件。'), /additionFile/);
        assert.equal(f.state.requests.length, 0);
    }

    for (const [message, content] of [
        ['$settings.incompletePregnancyEnabled is undefined', 'const value = options.incompletePregnancyEnabled;'],
        ['C.npc[$_name].pregnancy is undefined', 'const value = npc.pregnancy;'],
        ['$objectVersion is not defined', 'const version = $objectVersion;'],
    ]) {
        const f = fixture({ files: { 'module.js': content }, boot: { scriptFileList: ['module.js'], styleFileList: [] }, logs: [{ level: 'error', message }] });
        const prepared = await f.api.prepareLogs('Start 初始化失败。', { includeSources: true });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: null };
        const next = await f.api.prepareInvestigation(await f.api.analyze(prepared, f.connection));
        assert.equal(next.files[0].content, content, 'SugarCube 变量、中括号属性链及具体属性均能在真实目录内查找');
    }

    {
        const f = fixture({ files: { 'module.js': 'const value = options.incompletePregnancyEnabled;' },
            boot: { scriptFileList: ['module.js'], styleFileList: [] }, logs: [] });
        const prepared = await f.api.prepareLogs('Start 初始化失败。', { includeSources: true });
        f.state.answer = { summary: '还需读取真实初始化源码。', evidence: '$settings.incompletePregnancyEnabled 的初始化需要核对。',
            verification: '重载后核对原操作。', changes: [], readRequest: null };
        const next = await f.api.prepareInvestigation(await f.api.analyze(prepared, f.connection));
        assert.equal(next.files[0].path, 'module.js', '模型诊断仅作为本地搜索线索，真实内容命中后才发送');
        assert.deepEqual(plain(next.sourceCatalog[0].files).map(file => file.path), ['module.js'], '诊断文本不能扩大确认目录');
    }

    {
        const f = fixture({ logs: [] });
        const prepared = await f.api.prepareLogs('功能异常。', { includeSources: true });
        f.state.answer = { summary: '需核对来源。', evidence: '尚无源码依据。', verification: '重载后核对。', changes: [],
            readRequest: { name: 'Example', paths: ['modules/fictional.js'], reason: '核对文件。' } };
        const invalid = await assertReadCorrection(f, prepared, /未声明.*modules\/fictional\.js/);
        assert.equal(invalid.summary, f.state.answer.summary);
        assert.equal(invalid.evidence, f.state.answer.evidence);
        const correction = await f.api.prepareInvestigation(invalid);
        const context = JSON.parse(correction.material).diagnosisContext;
        assert.equal(context.responseCorrection, true, '只有一次带校验反馈的材料可在同事实下继续');
        assert.equal(context.round, 2);
        assert.deepEqual(context.validationFeedback.paths, ['modules/fictional.js']);
        assert.deepEqual(plain(correction.sourceCatalog[0].files).map(file => file.path), ['javascript/example.js', 'style/example.css']);
        assert.equal(f.state.requests.length, 1, '准备纠正材料不隐式发送请求');
        await assert.rejects(f.api.analyze(correction, f.connection), /未声明.*modules\/fictional\.js/, '重复无效请求终止，不因不限轮次而无限纠正');
        f.state.answer.readRequest.paths = ['javascript/example.js'];
        const request = await f.api.analyze(correction, f.connection);
        const selected = await f.api.prepareRequestedSources(request);
        f.state.answer.readRequest = null;
        f.state.answer.changes = [{ path: 'javascript/example.js', before: 'broken()', after: 'working()', reason: '核对源码后调用有效函数。' }];
        const plan = await f.api.analyze(selected, f.connection);
        assert.equal((await f.api.apply(plan)).ok, true, '纠正到真实目录路径后可完成代码修改');
    }

    {
        const f = fixture({ logs: [] });
        const prepared = await f.api.prepare('Example', '功能异常。', { includeSources: true });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['fictional.js'], reason: '核对文件。' } };
        const invalid = await assertReadCorrection(f, prepared, /未声明/);
        const correction = await f.api.prepareInvestigation(invalid);
        assert.deepEqual(plain(correction.files), plain(prepared.files), '已读完整源码保留，纠正回合不会丢失当前可写目标');
        await assert.rejects(f.api.analyze(correction, f.connection), /未声明/);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepareLogs('核对有限轮次。', { includeSources: true, maxRounds: 1 });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['fictional.js'], reason: '核对文件。' } };
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(plan.responseCorrection, false);
        assert.equal(plan.canContinue, false);
        assert.match(plan.validationFeedback.reason, /未声明/);
        await assert.rejects(f.api.prepareInvestigation(plan), /轮上限/);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepareLogs('核对无效请求摘要。', { includeSources: true });
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: Array.from({ length: 100 }, () => 'x'.repeat(500)), reason: '请求范围无效。' } };
        const invalid = await assertReadCorrection(f, prepared, /请求无效/);
        assert.equal(invalid.validationFeedback.paths.length, 20);
        assert.ok(invalid.validationFeedback.paths.every(path => path.length <= 256));
        assert.ok(invalid.validationFeedback.reason.length <= 8000);
        assert.equal(f.state.writes.length, 0, '无效响应仅保留有限校验摘要，不把巨量路径复制到纠正材料');
    }

    {
        const f = patchBootFixture();
        const metadata = await f.api.prepare('Example', '', { paths: [] });
        assert.ok(metadata.fileNames.some(file => file.path === 'boot.json'), '纯声明预览可列出受限补丁文件，但不读取游戏原文');
        assert.equal(f.gameReads.length, 0);
        await assert.rejects(f.api.prepare('Example', '修复锚点。', { paths: ['boot.json'] }), /已确认.*游戏段落原文/);
        const prepared = await f.api.prepareLogs('Ocean Breeze 选项缺失。', { includeSources: true });
        assert.ok(prepared.sourceCatalog[0].files.some(file => file.path === 'boot.json'));
        assert.equal(prepared.gameEvidence[0].passage, 'Ocean Breeze');
        assert.equal(prepared.gameEvidence[0].content, f.game['Ocean Breeze']);
        assert.equal(prepared.gameEvidence[0].writable, false);
        assert.equal(prepared.gameEvidence[0].source, 'modloader');
        f.state.answer = { summary: '查找串与当前段落不符。', evidence: '已核对游戏段落中的对应条件。', verification: '重载后核对原选项。', changes: [],
            readRequest: { name: 'Example', paths: ['boot.json'], reason: '需要核对现有补丁的精确查找串。' } };
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(prepared, f.connection));
        assert.deepEqual(plain(selected.gameEvidence), plain(prepared.gameEvidence), '后续只继承首次确认的游戏段落快照');
        f.state.answer.readRequest = null;
        f.state.answer.changes = [f.change];
        const plan = await f.api.analyze(selected, f.connection);
        assert.ok(plan.data);
        assert.equal((await f.api.apply(plan)).ok, true);
        const modified = JSON.parse(JSON.parse(new TextDecoder().decode(f.state.data))['boot.json']);
        assert.equal(modified.addonPlugin[0].params[0].findString, f.after);
        assert.equal(modified.name, 'Example'); assert.equal(modified.version, '1.0.0');
        assert.deepEqual(modified.addonPlugin[0].params[0].replaceFile, 'patch/ocean.txt');
        assert.deepEqual(plain(f.state.writes[0].enabled), ['Example']);
    }

    for (const [content, after] of [
        ['<<if $money >= 300>>', '不在游戏原文中的条件'],
        ['<<if $money >= 300>>重复<<if $money >= 300>>', '<<if $money >= 300>>'],
        ['<<if $money gte 300>>与<<if $money >= 300>>', '<<if $money >= 300>>'],
    ]) {
        const f = patchBootFixture(content);
        const prepared = await f.api.prepare('Example', 'Ocean Breeze 锚点未命中。', { paths: ['boot.json'], includeSources: true });
        f.state.answer.changes = [{ ...f.change, after: JSON.stringify(after) }];
        await assert.rejects(f.api.analyze(prepared, f.connection), /游戏原文校验/);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = patchBootFixture();
        const prepared = await f.api.prepare('Example', 'Ocean Breeze 锚点未命中。', { paths: ['boot.json'], includeSources: true });
        f.state.answer.changes = [f.change, { path: 'boot.json', before: '"name":"Example"', after: '"name":"Other"', reason: '试图更改身份。' }];
        await assert.rejects(f.api.analyze(prepared, f.connection), /身份|其他清单字段/);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = patchBootFixture();
        f.sb.modUtils = undefined;
        const prepared = await f.api.prepareLogs('Ocean Breeze 锚点未命中。', { includeSources: true });
        assert.ok(!prepared.sourceCatalog[0].files.some(file => file.path === 'boot.json'));
        assert.equal(prepared.gameEvidence.length, 0);
        assert.match(prepared.gameEvidenceOmitted[0].reason, /未提供.*段落原文/);
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['boot.json'], reason: '试图在没有游戏证据时读取补丁声明。' } };
        const invalid = await assertReadCorrection(f, prepared, /缺少.*已确认.*原文证据/);
        assert.equal(invalid.data, null);
        assert.equal(f.state.writes.length, 0);
    }

    for (const beforeAnalysis of [true, false]) {
        const f = patchBootFixture();
        const prepared = await f.api.prepare('Example', 'Ocean Breeze 锚点未命中。', { paths: ['boot.json'], includeSources: true });
        f.state.answer.changes = [f.change];
        const plan = beforeAnalysis ? null : await f.api.analyze(prepared, f.connection);
        f.game['Ocean Breeze'] += '其他插件追加了段落原文';
        if (beforeAnalysis) {
            await assert.rejects(f.api.analyze(prepared, f.connection), /游戏段落原文发生变化/);
            assert.equal(f.state.requests.length, 0);
        } else {
            const applied = await f.api.apply(plan);
            assert.equal(applied.ok, false);
            assert.match(applied.reason, /游戏段落原文发生变化/);
        }
        assert.equal(f.state.writes.length, 0, '游戏快照变化后不能应用旧查找串');
    }

    {
        const f = patchBootFixture();
        const prepared = await f.api.prepareLogs('Ocean Breeze 锚点未命中。', { includeSources: true });
        prepared.gameEvidence[0].content += '伪造原文';
        await assert.rejects(f.api.analyze(prepared, f.connection), /待发送材料已改变/);
        assert.equal(f.state.requests.length, 0);
    }

    {
        const f = fixture({ logs: [{ level: 'error', message: 'Start: $settings.incompletePregnancyEnabled is undefined' }] });
        const passages = { Start: '<<initsettings>>', 'Widgets Settings': '<<widget "initsettings">><<set $settings.incompletePregnancyEnabled = false>><</widget>>' };
        f.sb.modUtils = { getAllPassageData: () => Object.entries(passages).map(([name, content]) => ({ name, content, tags: name.startsWith('Widgets') ? ['widget'] : [] })),
            getPassageData: name => ({ name, content: passages[name] }) };
        Object.defineProperty(f.sb, 'State', { get: () => { throw new Error('禁止读取存档状态'); }, configurable: true });
        const prepared = await f.api.prepareLogs('Start 初始化失败。', { includeSources: true });
        assert.deepEqual(plain(prepared.gameEvidence).map(item => item.passage), ['Start', 'Widgets Settings'], '已有报错段落时仍补充命中真实属性的初始化定义');
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['javascript/example.js'], reason: '核对初始化调用。' } };
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(prepared, f.connection));
        assert.deepEqual(plain(selected.gameEvidence), plain(prepared.gameEvidence));
    }

    {
        const f = fixture({ logs: [] });
        const passages = Object.fromEntries(Array.from({ length: 8 }, (_, index) => ['段落' + index, '字'.repeat(10000) + ' $settings.incompletePregnancyEnabled']));
        f.sb.modUtils = { getAllPassageData: () => Object.entries(passages).map(([name, content]) => ({ name, content, tags: [] })),
            getPassageData: name => ({ name, content: passages[name] }) };
        const prepared = await f.api.prepareLogs(Object.keys(passages).join(' ') + ' $settings.incompletePregnancyEnabled', { includeSources: true });
        const size = prepared.gameEvidence.reduce((total, item) => total + new TextEncoder().encode(item.content).byteLength, 0);
        assert.ok(size <= 128 * 1024, '中文游戏窗口按 UTF-8 字节限制，不会超出预览预算');
        assert.ok(prepared.gameEvidence.every(item => item.writable === false));
    }

    {
        const firstError = "TypeError in: [Start] Cannot read properties of undefined (reading 'pregnancy')";
        const warnings = Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['Warning Passage ' + index, '只读警告原文']));
        const passages = { ...warnings, Start: '<<initnpc>>', 'Widgets NPC': '<<widget "initnpc">><<set C.npc = {}>><</widget>>' };
        const f = fixture({ logs: [{ level: 'error', message: Object.keys(warnings).map(name => 'cannot find findString in: [' + name + ']').join('\n') },
            { level: 'error', message: firstError }] });
        f.sb.modUtils = { getAllPassageData: () => Object.entries(passages).map(([name, content]) => ({ name, content, tags: name.startsWith('Widgets') ? ['widget'] : [] })),
            getPassageData: name => typeof passages[name] === 'string' ? { name, content: passages[name] } : null };
        const prepared = await f.api.prepareLogs('初始化报错。', { includeSources: true, logError: firstError });
        const names = plain(prepared.gameEvidence).map(item => item.passage);
        assert.equal(names[0], 'Start', '选中首处错误优先于九处补丁告警');
        assert.ok(names.includes('Widgets NPC'), '真正 widget 定义不含报错属性时也可通过首层调用采集');
        assert.ok(names.length <= 8); assert.ok(prepared.gameEvidenceOmitted.some(item => /超过 8 个/.test(item.reason)));
        assert.equal(f.state.requests.length, 0, '定义追踪仅用于初次本机预览');
        passages.Start = '<<nonexistentInitializer>>';
        const withoutDefinition = await f.api.prepareLogs('核对没有定义的初始化调用。', { includeSources: true, logError: firstError });
        assert.ok(!withoutDefinition.gameEvidence.some(item => item.passage === 'Widgets NPC'), '没有对应实际 widget 时不猜测初始化来源');
    }
    {
        const firstError = "TypeError in: [Start] Cannot read properties of undefined (reading 'type')";
        const generics = Object.fromEntries(Array.from({ length: 8 }, (_, index) => ['Widgets Generic ' + index, '<<widget "generic' + index + '">><<set $item.type = 1>><</widget>>']));
        const passages = { Start: '<<initnpc>>', ...generics, 'Widgets NPC': '<<widget "initnpc">><<set C.npc = {}>>' + 'x'.repeat(40 * 1024) + '<</widget>>' };
        const f = fixture({ logs: [{ level: 'error', message: firstError }] });
        f.sb.modUtils = { getAllPassageData: () => Object.entries(passages).map(([name, content]) => ({ name, content, tags: name.startsWith('Widgets') ? ['widget'] : [] })),
            getPassageData: name => ({ name, content: passages[name] }) };
        const prepared = await f.api.prepareLogs('初始化错误。', { includeSources: true, logError: firstError });
        const names = prepared.gameEvidence.map(item => item.passage);
        assert.equal(names[0], 'Start'); assert.equal(names[1], 'Widgets NPC', '实际首层 widget 定义优先于八个通用属性命中');
        const widget = prepared.gameEvidence.find(item => item.passage === 'Widgets NPC');
        assert.ok(widget.content.includes('<<widget "initnpc">>')); assert.ok(widget.content.includes('C.npc = {}'));
        assert.equal(widget.incomplete, true); assert.equal(widget.writable, false);
        assert.ok(names.length <= 8);
        assert.ok(prepared.gameEvidence.reduce((total, item) => total + new TextEncoder().encode(item.content).byteLength, 0) <= 128 * 1024);
        assert.ok(prepared.gameEvidenceOmitted.some(item => /超过 8 个/.test(item.reason)));
        assert.equal(f.state.requests.length, 0);
    }

    // 无法读取的候选保留具体原因，不以展示名、未知插件或目录错误扩大权限。
    for (const [configure, pattern] of [
        [f => { f.sb.modHubReadInstalledModPackage = async () => ({ error: new Error('安装包 CRC 校验失败：patch/start.txt') }); }, /CRC.*patch\/start\.txt/],
        [f => { f.state.boot.scriptFileList = ['missing.js']; }, /scriptFileList.*missing\.js/],
        [f => { f.state.boot.scriptFileList = ['../danger.js']; }, /scriptFileList.*\.\.\/danger\.js/],
        [f => { f.state.boot.scriptFileList = []; f.state.boot.styleFileList = []; f.state.boot.addonPlugin = [{ modName: 'Unknown', params: [{ replaceFile: 'javascript/example.js' }] }]; }, /未声明/],
    ]) {
        const f = fixture(); configure(f);
        const prepared = await f.api.prepareLogs('先定位日志。', { includeSources: true });
        assert.deepEqual(plain(prepared.sourceCatalog), []);
        assert.equal(prepared.sourceUnavailable[0].name, 'Example');
        assert.match(prepared.sourceUnavailable[0].reason, pattern);
        assert.deepEqual(JSON.parse(prepared.material).sourceUnavailable, plain(prepared.sourceUnavailable));
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture({ files: { 'patch/Start.txt': '<<print broken()>>' }, boot: { scriptFileList: [], styleFileList: [],
            addonPlugin: [{ modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ passage: 'Start', replaceFile: 'patch/Start.txt' }] }] } });
        const prepared = await f.api.prepareLogs('Start 段落异常。', { includeSources: true });
        assert.equal(prepared.sourceCatalog[0].files[0].path, 'patch/Start.txt', '真实 TweeReplacer 文本声明进入目录，不猜测扩展名');
        f.state.answer = readingAnswer(f, { name: 'Example', paths: ['patch/Start.txt'], reason: '核对已声明的段落替换文本。' });
        const next = await f.api.prepareRequestedSources(await f.api.analyze(prepared, f.connection));
        assert.equal(next.files[0].content, '<<print broken()>>');
        next.material += '未预览的额外材料';
        await assert.rejects(f.api.analyze(next, f.connection), /待发送材料已改变/);
        assert.equal(f.state.requests.length, 1);
    }

    {
        const f = fixture(); f.state.enabled = Array.from({ length: 65 }, (_, index) => 'Mod-' + index);
        let packageReads = 0;
        f.sb.modHubReadInstalledModPackage = async () => { packageReads++; throw new Error('不应读取任意前 64 包'); };
        const prepared = await f.api.prepareLogs('模组太多。', { includeSources: true });
        assert.deepEqual(plain(prepared.sourceCatalog), []);
        assert.match(prepared.sourceUnavailable[0].reason, /65.*64.*未任意/);
        assert.equal(packageReads, 0);
        assert.equal(f.state.requests.length, 0);
    }

    for (const [count, longPath, pattern] of [[1000, false, null], [1001, false, /1000/], [900, true, /128 KiB/]]) {
        const files = Object.fromEntries(Array.from({ length: count }, (_, index) => ['scripts/' + (longPath ? 'x'.repeat(170) : '') + index + '.js', '']));
        const f = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] } });
        const prepared = await f.api.prepareLogs('先定位大包。', { includeSources: true });
        if (pattern) {
            assert.deepEqual(plain(prepared.sourceCatalog), [], '目录超限不能任意选择前几个文件');
            assert.match(prepared.sourceUnavailable.at(-1).reason, pattern);
        } else assert.equal(prepared.sourceCatalog[0].files.length, 1000, '1000 文件边界可以完整提供目录');
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.writes.length, 0);
    }

    for (const mutate of [prepared => { prepared.sourceCatalog[0].files[0].path = 'other.js'; }, prepared => { prepared.sourceUnavailable.push({ name: 'Example', reason: '伪造范围' }); }]) {
        const f = fixture();
        const prepared = await f.api.prepareLogs('先定位日志。', { includeSources: true }); mutate(prepared);
        await assert.rejects(f.api.analyze(prepared, f.connection), /待发送材料已改变/);
        assert.equal(f.state.requests.length, 0);
    }

    for (const mutate of [plan => { plan.readRequest.paths.push('style/example.css'); }, plan => { plan.readRequest.reason = '不同请求'; }, plan => { plan.readRequest.name = 'Other'; }, plan => { plan.mode = 'structured'; }]) {
        const f = fixture(); f.state.answer = readingAnswer(f, validReadRequest());
        const plan = await f.api.analyze(await f.api.prepareLogs('先定位日志。', { includeSources: true }), f.connection);
        mutate(plan);
        await assert.rejects(f.api.prepareRequestedSources(plan), /计划已改变/);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
    }

    for (const mutate of [f => { f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' }); }, f => { f.state.disabled.push('Other'); }, async f => { await f.api.prepareLogs('新的材料。'); }]) {
        const f = fixture(); f.state.answer = readingAnswer(f, validReadRequest());
        const plan = await f.api.analyze(await f.api.prepareLogs('先定位日志。', { includeSources: true }), f.connection);
        await mutate(f);
        await assert.rejects(f.api.prepareRequestedSources(plan), /改变|过期/);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture(); f.state.answer = readingAnswer(f, validReadRequest());
        const plan = await f.api.analyze(await f.api.prepareLogs('先定位日志。', { includeSources: true }), f.connection);
        await assert.rejects(f.api.prepareRequestedSources(plain(plan)), /计划已改变/, '复制或伪造计划无法获得私有读取权限');
        const originalRead = f.sb.modHubAiPackage.read;
        f.sb.modHubAiPackage.read = async data => {
            const archive = await originalRead(data);
            archive.text = async () => { f.state.disabled.push('Other'); return 'const value = broken();'; };
            return archive;
        };
        await assert.rejects(f.api.prepareRequestedSources(plan), /配置或包体已改变/);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepareLogs('先定位日志。', { includeSources: true });
        f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' });
        await assert.rejects(f.api.analyze(prepared, f.connection), /候选模组.*安装包已改变/);
        assert.equal(f.state.requests.length, 0);
        const raced = fixture();
        const originalRead = raced.sb.modHubReadInstalledModPackage;
        let reads = 0;
        raced.sb.modHubReadInstalledModPackage = async name => {
            const result = await originalRead(name);
            if (++reads === 1) raced.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' });
            return result;
        };
        await assert.rejects(raced.api.prepareLogs('读取中包体变化。', { includeSources: true }), /安装包已改变/);
        const progress = fixture();
        const next = await progress.api.prepareLogs('进度回调异常不能影响材料。', { includeSources: true, onProgress: () => { throw new Error('界面异常'); } });
        assert.equal(next.sourceCatalog.length, 1);
    }

    // 源码结果可以请求另一包；文件权限始终只属于本轮实际读取的单个包。
    {
        const f = multiplePackageFixture();
        f.state.answer = f.answer(f.readA);
        const first = await f.api.analyze(await f.api.prepareLogs('打开功能页报错。', { includeSources: true }), f.connection);
        const sourceA = await f.api.prepareRequestedSources(first);
        assert.equal(JSON.parse(sourceA.material).diagnosisContext.round, 2);
        assert.deepEqual(plain(sourceA.sourceCatalog).map(item => item.name), ['A', 'B']);
        f.state.answer = f.answer(f.readB);
        const second = await f.api.analyze(sourceA, f.connection);
        assert.equal(second.readRequest.name, 'B', '已有源码时可以从原目录请求另一真实包');
        assert.equal(second.canContinue, true);
        const sourceB = await f.api.prepareRequestedSources(second);
        const material = JSON.parse(sourceB.material);
        assert.equal(sourceB.name, 'B');
        assert.equal(material.diagnosisContext.round, 3);
        assert.deepEqual(material.diagnosisContext.readHistory, [{ name: 'A', paths: ['a.js'] }, { name: 'B', paths: ['b.js'] }]);
        assert.deepEqual(material.diagnosisContext.history.map(item => [item.round, item.name]), [[1, ''], [2, 'A']]);
        assert.deepEqual(material.files.map(file => file.path), ['b.js']);
        assert.ok(!material.files.some(file => file.content.includes('innocent')), '上一包原文不混入当前可修改文件');
        assert.equal(f.state.requests.length, 2);
        assert.equal(f.state.writes.length, 0);
        f.state.answer = { ...f.answer(), changes: [{ path: 'a.js', before: 'return 1', after: 'return 2', reason: '试图修改此前读取的包。' }] };
        await assert.rejects(f.api.analyze(sourceB, f.connection), /未提供的文件/);
        f.state.answer.changes = [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '修正当前包的实际调用。' }];
        const repaired = await f.api.analyze(sourceB, f.connection);
        assert.equal(repaired.name, 'B');
        assert.equal(repaired.canContinue, false);
        assert.match(repaired.continuationReason, /已有待确认/);
        await assert.rejects(f.api.prepareInvestigation(repaired), /已有待确认/, '已有补丁须先审阅，不能当作无修改结果接续');
        assert.equal((await f.api.apply(repaired)).ok, true);
        assert.equal(f.state.writes[0].name, 'B');
    }

    // 无修改、无读取请求也可继续定位，所有接续只在本机整理，不隐式收费或保存。
    {
        const f = multiplePackageFixture();
        const description = '打开服装页面出现首条异常，预期能正常显示。';
        const logError = '完整选中日志 token=selected-secret';
        f.state.answer = f.answer(f.readA);
        const first = await f.api.analyze(await f.api.prepareLogs(description, { includeSources: true, logError }), f.connection);
        const sourceA = await f.api.prepareRequestedSources(first);
        f.state.answer = { ...f.answer(), summary: 'A 没有对应调用。token=history-secret' };
        const second = await f.api.analyze(sourceA, f.connection);
        assert.equal(second.readRequest, null);
        assert.equal(second.canContinue, true);
        assert.match(second.continuationReason, /第 2 轮.*5 轮/);
        const investigation = await f.api.prepareInvestigation(second);
        const material = JSON.parse(investigation.material);
        assert.equal(investigation.name, 'B', '继续定位根据原日志明确的 broken 标识符在本机找到新源码');
        assert.deepEqual(plain(investigation.files).map(file => file.path), ['b.js']);
        assert.equal(investigation.description, description);
        assert.equal(material.diagnosisContext.round, 3);
        assert.equal(material.diagnosisContext.maxRounds, 5);
        assert.equal(material.diagnosisContext.readRequest, null);
        assert.deepEqual(material.diagnosisContext.history.map(item => [item.round, item.name]), [[1, ''], [2, 'A']]);
        assert.deepEqual(material.diagnosisContext.readHistory, [{ name: 'A', paths: ['a.js'] }, { name: 'B', paths: ['b.js'] }]);
        assert.equal(material.sourceEvidence[0].name, 'A');
        assert.equal(material.sourceEvidence[0].content, f.packages.A.files['a.js'], '此前源码作为明确只读证据保留');
        assert.equal(material.sourceEvidence[0].writable, false);
        assert.ok(material.logs.some(line => line.includes('完整选中日志')));
        assert.ok(!investigation.material.includes('history-secret'));
        assert.ok(!investigation.material.includes('selected-secret'));
        assert.equal(f.state.requests.length, 2, '继续查找只本地准备，第二轮结果后不自动发送第三轮');
        assert.equal(f.state.writes.length, 0);
        await assert.rejects(f.api.prepareInvestigation(second), /过期/);
        f.state.answer = { ...f.answer(), changes: [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '修复本轮确认的调用。' }] };
        const third = await f.api.analyze(investigation, f.connection);
        assert.equal(f.state.requests.length, 3);
        assert.equal(third.name, 'B');
        assert.equal((await f.api.apply(third)).ok, true, '无空目录轮次，第三次分析即可产生当前包补丁');
        assert.equal(f.state.writes.length, 1);
    }

    for (const initialSource of [false, true]) {
        const f = multiplePackageFixture();
        f.state.answer = f.answer();
        const prepared = initialSource ? await f.api.prepare('A', '保留原描述。', { logError: '保留原首错。' })
            : await f.api.prepareLogs('保留原描述。', { logError: '保留原首错。' });
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(plan.canContinue, true, '初始未附全目录的建议允许先本地整理目录');
        const next = await f.api.prepareInvestigation(plan);
        assert.equal(next.sourceCatalog.length, 2);
        assert.equal(f.state.requests.length, 1);
        const context = JSON.parse(next.material).diagnosisContext;
        assert.deepEqual(context.readHistory, initialSource ? [{ name: 'A', paths: ['a.js'] }, { name: 'B', paths: ['b.js'] }] : [{ name: 'B', paths: ['b.js'] }]);
        assert.ok(JSON.parse(next.material).logs.some(line => line.includes('保留原首错')));
    }

    {
        const f = multiplePackageFixture();
        f.state.answer = f.answer(f.readA);
        const source = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('核对来源。', { includeSources: true }), f.connection));
        await assertReadCorrection(f, source, /已经读取.*没有新增定位证据/);
        f.state.answer = f.answer();
        const advice = await f.api.analyze(source, f.connection);
        const investigation = await f.api.prepareInvestigation(advice);
        f.state.answer = f.answer(f.readA);
        const promotion = await f.api.analyze(investigation, f.connection);
        assert.equal(promotion.readRequest.name, 'A', '此前完整源码变为只读证据后，允许明确选定为当前单包可写全文');
        const selected = await f.api.prepareRequestedSources(promotion);
        assert.equal(selected.name, 'A');
        assert.deepEqual(plain(selected.files).map(file => file.path), ['a.js']);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = multiplePackageFixture();
        f.packages.A.files['a-extra.js'] = 'function additional() { return 2; }';
        f.state.answer = f.answer(f.readA);
        const source = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('继续核对同包上下文。', { includeSources: true }), f.connection));
        f.state.answer = f.answer({ name: 'A', paths: ['a.js', 'a-extra.js'], reason: '补充未读文件，并保留已有调用上下文。' });
        const next = await f.api.prepareRequestedSources(await f.api.analyze(source, f.connection));
        assert.deepEqual(plain(next.files).map(file => file.path), ['a.js', 'a-extra.js']);
        assert.deepEqual(JSON.parse(next.material).diagnosisContext.readHistory, [{ name: 'A', paths: ['a.js', 'a-extra.js'] }]);
    }

    {
        const f = multiplePackageFixture();
        f.packages.A.files['a-later.js'] = 'later';
        f.state.answer = f.answer(f.readA);
        const a = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('继续核对来源。', { includeSources: true }), f.connection));
        f.state.answer = f.answer();
        const investigation = await f.api.prepareInvestigation(await f.api.analyze(a, f.connection));
        f.state.answer = f.answer({ name: 'A', paths: ['a-later.js'], reason: '明确请求尚未读取的另一个声明文件。' });
        const b = await f.api.prepareRequestedSources(await f.api.analyze(investigation, f.connection));
        f.packages.A.files['a-unread.js'] = 'extra';
        await assert.rejects(f.api.analyze(b, f.connection), /安装包已改变/, '原目录与当前包均必须保持原哈希');
        delete f.packages.A.files['a-unread.js'];
        f.state.answer = f.answer();
        const last = await f.api.analyze(b, f.connection);
        assert.equal(last.canContinue, true);
        assert.match(last.continuationReason, /第 4 轮.*5 轮/);
        const requests = f.state.requests.length;
        await assert.rejects(f.api.prepareRequestedSources(last), /源码读取请求不存在/);
        assert.equal(f.state.requests.length, requests);
        last.canContinue = false;
        await assert.rejects(f.api.prepareInvestigation(last), /计划已改变/, '修改继续标记不能绕过限额');
        f.state.answer = f.answer({ name: 'B', paths: ['b.js'], reason: '仍想继续读取已核对的文件。' });
        const stopped = await f.api.analyze(b, f.connection);
        assert.equal(stopped.readRequest.name, 'B', '第四轮仍可明确选定已有完整只读证据');
        assert.equal(stopped.canContinue, true);
        f.packages.A.files['new.js'] = 'new';
        await assert.rejects(f.api.analyze(b, f.connection), /安装包已改变/);
        delete f.packages.A.files['new.js'];
        f.state.answer = f.answer();
        const limit = await f.api.analyze(b, f.connection);
        assert.equal(limit.readRequest, null, '没有明确读取请求时保留诊断，不擅自选择下一包');
        assert.equal(limit.canContinue, true);
        assert.match(limit.continuationReason, /第 4 轮.*5 轮/);
        assert.equal(f.state.writes.length, 0);

        assert.ok(limit.repairTargets.some(target => target.name === 'B' && target.paths.includes('b.js')));
        const sent = f.state.requests.length;
        const repair = await f.api.prepareRepair(limit, 'B');
        const material = JSON.parse(repair.material);
        assert.equal(f.state.requests.length, sent, '四轮后明确选择源码仅在本机整理，不自动发送第五次请求');
        assert.equal(material.repairIntent, 'generate-code-repair');
        assert.equal(material.diagnosisContext.round, 5, '生成模式沿用同一分析预算，不能重置轮次');
        assert.equal(material.diagnosisContext.history.length, 4, '重新生成仍保留全部已完成定位诊断');
        assert.deepEqual(material.files.map(file => file.path), ['b.js']);
        assert.ok(material.sourceEvidence.some(item => item.name === 'A' && item.writable === false));
        f.state.answer = { ...f.answer(), changes: [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '修正已确认目标的调用。' }] };
        const generated = await f.api.analyze(repair, f.connection);
        assert.equal(generated.changes.length, 1);
        assert.equal((await f.api.apply(generated)).ok, true, '已核验的旧完整证据可以重新进入真实代码修复链路');
        assert.equal(f.state.writes[0].name, 'B');
    }

    // 默认与自定义轮次结束后不能分诊、读取新文件或以生成模式重置预算。
    for (const maxRounds of [undefined, 12, 3, 1]) {
        const f = multiplePackageFixture();
        const limitRounds = maxRounds === undefined ? 5 : maxRounds;
        for (let index = 1; index < limitRounds; index++) f.packages.A.files['step-' + index + '.js'] = 'const value' + index + ' = broken();';
        let prepared = await f.api.prepare('A', '持续核对 broken 调用。', { paths: ['a.js'], includeSources: true, maxRounds });
        assert.deepEqual(JSON.parse(prepared.material).diagnosisContext, { round: 1, maxRounds: limitRounds });
        for (let index = 1; index < limitRounds; index++) {
            f.state.answer = f.answer({ name: 'A', paths: ['step-' + index + '.js'], reason: '核对第 ' + index + ' 份独立上下文。' });
            prepared = await f.api.prepareRequestedSources(await f.api.analyze(prepared, f.connection));
            assert.equal(JSON.parse(prepared.material).diagnosisContext.round, index + 1);
            assert.equal(JSON.parse(prepared.material).diagnosisContext.maxRounds, limitRounds);
        }
        f.state.answer = f.answer(f.readB);
        const limit = await f.api.analyze(prepared, f.connection);
        assert.equal(limit.readRequest, null);
        assert.equal(limit.canContinue, false); assert.equal(limit.canTriage, false);
        assert.ok(limit.continuationReason.includes(limitRounds + ' 轮上限'));
        await assert.rejects(f.api.prepareInvestigation(limit), /轮上限/);
        await assert.rejects(f.api.prepareRequestedSources(limit), /轮上限/);
        await assert.rejects(f.api.prepareTriage(limit), /不能再次自动/);
        await assert.rejects(f.api.prepareRepair(limit, 'A'), /轮上限/);
        assert.equal(f.state.requests.length, limitRounds); assert.equal(f.state.writes.length, 0);
    }

    // 不限轮次仍逐轮读取新证据，超过五轮默认预算后继续到第十四轮，并保留分诊与生成入口。
    {
        const f = multiplePackageFixture();
        for (let index = 1; index <= 13; index++) f.packages.A.files['step-' + index + '.js'] = 'const value' + index + ' = broken();';
        let prepared = await f.api.prepareLogs('持续核对 broken 调用。', { includeSources: true, maxRounds: 0 });
        for (let index = 1; index <= 13; index++) {
            f.state.answer = f.answer({ name: 'A', paths: ['step-' + index + '.js'], reason: '核对第 ' + index + ' 份独立上下文。' });
            const plan = await f.api.analyze(prepared, f.connection);
            assert.equal(plan.canContinue, true); assert.match(plan.continuationReason, /不限轮次/);
            prepared = await f.api.prepareRequestedSources(plan);
            assert.equal(JSON.parse(prepared.material).diagnosisContext.maxRounds, 0);
        }
        assert.equal(JSON.parse(prepared.material).diagnosisContext.round, 14);
        const system = JSON.parse(f.state.requests[12].request.body).messages[0].content;
        assert.match(system, /不限分析轮次/); assert.ok(!system.includes('最多12轮'));
        f.state.answer = f.answer();
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(plan.canTriage, true);
        const repair = await f.api.prepareRepair(plan, 'A');
        assert.equal(JSON.parse(repair.material).diagnosisContext.round, 15);
        assert.equal(JSON.parse(repair.material).diagnosisContext.maxRounds, 0);
        assert.equal(f.state.requests.length, 14); assert.equal(f.state.writes.length, 0);
    }

    // 调查、分诊、源码选定和生成共享首次预览的预算。
    {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'const candidate = broken();';
        f.state.answer = f.answer();
        const logs = await f.api.prepareLogs('核对 broken 调用。', { includeSources: true, maxRounds: 7 });
        const evidence = await f.api.prepareInvestigation(await f.api.analyze(logs, f.connection));
        assert.equal(JSON.parse(evidence.material).diagnosisContext.maxRounds, 7);
        const triage = await f.api.prepareTriage(await f.api.analyze(evidence, f.connection));
        assert.equal(JSON.parse(triage.material).diagnosisContext.maxRounds, 7);
        f.state.answer = f.answer(f.readB);
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(triage, f.connection));
        assert.equal(JSON.parse(selected.material).diagnosisContext.maxRounds, 7);
        f.state.answer = f.answer();
        const repair = await f.api.prepareRepair(await f.api.analyze(selected, f.connection), 'B');
        assert.equal(JSON.parse(repair.material).diagnosisContext.maxRounds, 7);
        assert.equal(JSON.parse(repair.material).diagnosisContext.round, 5);
    }

    // 首次单包全文可同时核验目录，确认后自动补充其它已授权包。
    {
        const f = multiplePackageFixture();
        const initial = await f.api.prepare('A', '需要核对跨包调用。', { paths: ['a.js'], includeSources: true });
        const material = JSON.parse(initial.material);
        assert.deepEqual(material.files.map(file => file.path), ['a.js']);
        assert.deepEqual(material.sourceCatalog.map(source => source.name), ['A', 'B']);
        f.state.answer = f.answer(f.readB);
        const next = await f.api.prepareRequestedSources(await f.api.analyze(initial, f.connection));
        assert.equal(next.name, 'B'); assert.equal(f.state.requests.length, 1);
        const stale = await f.api.prepare('A', '候选目录仍需保持原包。', { includeSources: true });
        f.packages.B.files['b.js'] = 'changed';
        const sent = f.state.requests.length;
        await assert.rejects(f.api.analyze(stale, f.connection), /候选模组.*安装包已改变/);
        assert.equal(f.state.requests.length, sent);
        await assert.rejects(f.api.prepare('A', '无效目录设置。', { includeSources: 'true' }), /目录选项格式/);
    }

    // 自动分诊将已有全文转为只读证据，让模型依据证据选包，不取目录首项。
    {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'const innocentCandidate = broken();';
        f.packages.A.files['unread.js'] = 'const unrelated = 1;';
        f.state.answer = f.answer();
        const logs = await f.api.prepareLogs('broken 调用出现异常。', { includeSources: true });
        const initialPlan = await f.api.analyze(logs, f.connection);
        assert.equal(initialPlan.canTriage, false, '目录不是完整源码证据，不能直接分诊');
        const evidence = await f.api.prepareInvestigation(initialPlan);
        const plan = await f.api.analyze(evidence, f.connection);
        assert.equal(plan.canTriage, true);
        const sent = f.state.requests.length;
        const triage = await f.api.prepareTriage(plan);
        const material = JSON.parse(triage.material);
        assert.equal(f.state.requests.length, sent, '分诊准备不隐式发送请求');
        assert.equal(material.repairIntent, 'select-code-repair');
        assert.equal(material.diagnosisContext.round, 3);
        assert.deepEqual(material.files, []);
        assert.deepEqual(material.sourceCatalog.map(source => [source.name, source.files.map(file => file.path)]), [['A', ['a.js', 'unread.js']], ['B', ['b.js']]], '分诊保留原确认声明目录，未读文件可先请求读取，不能直接修改');
        assert.ok(material.sourceEvidence.every(item => item.writable === false));
        f.state.answer = f.answer({ name: 'A', paths: ['unread.js'], reason: '尝试选择未读文件。' });
        const extra = await f.api.analyze(triage, f.connection);
        assert.deepEqual(plain(extra.readRequest.paths), ['unread.js'], '证据不足时允许读取原确认目录中的未读声明文件');
        f.state.answer = f.answer({ name: 'A', paths: ['fictional.js'], reason: '虚构目录外文件。' });
        await assertReadCorrection(f, triage, /未声明.*【A】fictional\.js/);
        f.state.answer = f.answer({ name: 'A', paths: ['boot.json'], reason: '试图修改安装包清单。' });
        await assertReadCorrection(f, triage, /源码读取请求无效/);
        f.state.answer = { ...f.answer(), changes: [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '试图直接修改分诊的只读证据。' }] };
        await assert.rejects(f.api.analyze(triage, f.connection), /当前仅分析日志/);
        f.state.answer = f.answer(f.readB);
        const selection = await f.api.analyze(triage, f.connection);
        assert.equal(selection.readRequest.name, 'B', '模型选择第二个有依据的包，不要求玩家判断责任模组');
        assert.equal(selection.canTriage, false);
        const selected = await f.api.prepareRequestedSources(selection);
        assert.equal(selected.name, 'B'); assert.equal(JSON.parse(selected.material).diagnosisContext.round, 4);
        f.state.answer = f.answer();
        const unchanged = await f.api.analyze(selected, f.connection);
        assert.equal(unchanged.canTriage, false, '明确选包后不能再次消耗分诊轮次');
        f.state.answer.changes = [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '修正模型确认的单包实际调用。' }];
        const generated = await f.api.analyze(selected, f.connection);
        assert.equal((await f.api.apply(generated)).ok, true); assert.equal(f.state.writes[0].name, 'B');
    }
    // 分诊补读未读声明文件后，只有本轮完整源码可以生成修改。
    {
        const f = multiplePackageFixture();
        f.packages.B.files['unread.js'] = 'const next = broken();';
        f.state.answer = f.answer();
        const source = await f.api.prepare('A', '核对后续调用。', { paths: ['a.js'], includeSources: true });
        const diagnosis = await f.api.analyze(source, f.connection);
        await assert.rejects(f.api.prepareRepair(diagnosis, 'B'), /完整源码范围/, '候选声明目录仍不能直接授予源码修改权限');
        const triage = await f.api.prepareTriage(diagnosis);
        f.state.answer = f.answer({ name: 'B', paths: ['unread.js'], reason: '先读取原确认目录中另一包尚未提供的调用原文。' });
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(triage, f.connection));
        assert.equal(selected.name, 'B', '分诊可补读已授权但尚无完整证据的另一候选包');
        assert.deepEqual(plain(selected.files).map(file => file.path), ['unread.js']);
        assert.equal(JSON.parse(selected.material).diagnosisContext.round, 3);
        f.state.answer = { ...f.answer(), changes: [{ path: 'unread.js', before: 'broken()', after: 'working()', reason: '依据本轮完整源码修正调用。' }] };
        const generated = await f.api.analyze(selected, f.connection);
        assert.equal(generated.changes.length, 1); assert.equal(f.state.writes.length, 0);
    }
    // 分诊中的大文件请求只提供搜索窗口，仍不能修改大文件。
    {
        const f = multiplePackageFixture();
        f.packages.A.files['large.js'] = 'const filler = 1;\n'.repeat(17000) + 'const marker = diagnosisNeedle();\n';
        f.state.answer = f.answer();
        const source = await f.api.prepare('A', '核对 diagnosisNeedle 调用。', { paths: ['a.js'], includeSources: true });
        const triage = await f.api.prepareTriage(await f.api.analyze(source, f.connection));
        f.state.answer = f.answer({ name: 'A', paths: ['large.js'], reason: '在已授权大文件中搜索具体调用。', search: ['diagnosisNeedle'] });
        const selected = await f.api.prepareRequestedSources(await f.api.analyze(triage, f.connection));
        assert.deepEqual(plain(selected.files), []);
        assert.ok(selected.sourceEvidence.some(item => item.path === 'large.js' && item.incomplete && item.writable === false));
        f.state.answer = { ...f.answer(), changes: [{ path: 'large.js', before: 'diagnosisNeedle()', after: 'working()', reason: '试图改写只读大文件。' }] };
        await assert.rejects(f.api.analyze(selected, f.connection), /当前仅分析日志/);
        assert.equal(f.state.writes.length, 0);
    }
    {
        const f = fixture();
        f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepare('Example', '当前全文无法确认根因。'), f.connection);
        const triage = await f.api.prepareTriage(plan);
        const material = JSON.parse(triage.material);
        assert.equal(material.diagnosisContext.round, 2);
        assert.deepEqual(material.sourceCatalog[0].files.map(file => file.path), ['javascript/example.js', 'style/example.css']);
        const unknown = await f.api.analyze(triage, f.connection);
        assert.equal(unknown.canContinue, true); assert.equal(unknown.canTriage, false);
        await assert.rejects(f.api.prepareTriage(unknown), /不能再次自动/);
        await assert.rejects(f.api.prepareInvestigation(unknown), /没有新的源码证据/, '分诊允许核对未读声明文件，但本机无新命中时不重发相同材料');
        assert.equal(f.state.requests.length, 2); assert.equal(f.state.writes.length, 0);
    }
    {
        const f = multiplePackageFixture(); f.state.answer = f.answer();
        const source = await f.api.prepare('A', 'broken is not defined', { paths: ['a.js'], includeSources: true });
        const triage = await f.api.prepareTriage(await f.api.analyze(source, f.connection));
        const undecided = await f.api.analyze(triage, f.connection);
        assert.equal(undecided.canContinue, true, '分诊未请求文件时仍可按当前标识符查原确认目录');
        const evidence = await f.api.prepareInvestigation(undecided);
        assert.equal(evidence.name, 'B'); assert.deepEqual(plain(evidence.files).map(item => item.path), ['b.js']);
        assert.equal(JSON.parse(evidence.material).diagnosisContext.round, 3);
        assert.equal(f.state.requests.length, 2); assert.equal(f.state.writes.length, 0);
    }
    {
        const f = multiplePackageFixture(); f.state.answer = f.answer();
        const source = await f.api.prepare('A', '核对声明中的调用。', { paths: ['a.js'], includeSources: true });
        const selected = await f.api.prepareRepair(await f.api.analyze(source, f.connection), 'A');
        f.state.answer = f.answer(f.readB);
        const request = await f.api.analyze(selected, f.connection);
        assert.equal(request.mode, 'source-request'); assert.equal(request.canContinue, true, '生成阶段仍可补读原确认目录中合法的新请求');
        assert.deepEqual(plain(request.readRequest), f.readB);
        const following = await f.api.prepareRequestedSources(request);
        assert.equal(following.name, 'B'); assert.deepEqual(plain(following.files).map(item => item.path), ['b.js']);
        assert.equal(JSON.parse(following.material).diagnosisContext.round, 3);
        assert.equal(f.state.requests.length, 2); assert.equal(f.state.writes.length, 0);
    }
    for (const mutate of [
        (f, plan) => { plan.canTriage = false; },
        f => { f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' }); },
        async f => { await f.api.prepareLogs('其它问题的材料。'); },
    ]) {
        const f = fixture(); f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepare('Example', '核对分诊计划。'), f.connection);
        await assert.rejects(f.api.prepareTriage(plain(plan)), /不能再次自动/);
        await mutate(f, plan);
        await assert.rejects(f.api.prepareTriage(plan), /不能再次自动|改变|过期/);
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }

    // 多包完整证据须明确选择单个目标；继续定位仍不能扩大当前写入权限。
    {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'function first() { return broken(); }';
        f.state.answer = f.answer();
        const initial = await f.api.prepareLogs('核对 broken 调用。', { includeSources: true });
        const evidence = await f.api.prepareInvestigation(await f.api.analyze(initial, f.connection));
        assert.equal(evidence.files.length, 0);
        const plan = await f.api.analyze(evidence, f.connection);
        assert.deepEqual(plain(plan.repairTargets), [{ name: 'A', paths: ['a.js'] }, { name: 'B', paths: ['b.js'] }]);
        await assert.rejects(f.api.prepareRepair(plan, 'ModHub'), /完整源码范围/);
        const selected = await f.api.prepareRepair(plan, 'A');
        assert.equal(selected.name, 'A');
        const advice = await f.api.analyze(selected, f.connection);
        assert.equal(advice.canContinue, true, '生成模式保留原确认目录内继续定位机会');
        await assert.rejects(f.api.prepareInvestigation(advice), /没有新的源码证据/, '所有已读完整证据不能重新构成同事实轮次');
        f.state.answer = { ...f.answer(), changes: [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '试图改写另一个只读包。' }] };
        await assert.rejects(f.api.analyze(selected, f.connection), /未提供的文件/);
        f.state.answer.changes = [{ path: 'a.js', before: 'broken()', after: 'working()', reason: '修正本轮完整目标源码。' }];
        const generated = await f.api.analyze(selected, f.connection);
        assert.equal((await f.api.apply(generated)).ok, true);
        assert.equal(f.state.writes[0].name, 'A');
    }

    // 本机接续后暂停仍可使用来源方案的原目标，但不能放宽其他过期方案。
    for (const method of ['prepareInvestigation', 'prepareRequestedSources']) {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'const secondary = broken();';
        let source;
        if (method === 'prepareRequestedSources') {
            f.state.answer = f.answer(f.readB);
            source = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('broken 调用发生异常。', { includeSources: true }), f.connection));
            f.state.answer = f.answer(f.readA);
        } else {
            source = await f.api.prepare('B', 'broken 调用发生异常。');
            f.state.answer = f.answer();
        }
        const previous = await f.api.analyze(source, f.connection);
        const unlinked = await f.api.analyze(source, f.connection);
        const following = await f.api[method](previous);
        assert.equal(following.name, 'A');
        await assert.rejects(f.api.prepareRepair(unlinked, 'B'), /材料已经过期/, '同一旧材料生成的其他方案未关联接续，不得重用');
        const sent = f.state.requests.length;
        const selected = await f.api.prepareRepair(previous, 'B');
        assert.equal(f.state.requests.length, sent, '暂停后重新整理原目标只读本机文件，不自动重发请求');
        const material = JSON.parse(selected.material);
        assert.deepEqual(material.files.map(file => file.path), ['b.js']);
        assert.equal(material.diagnosisContext.history.length, JSON.parse(following.material).diagnosisContext.history.length, '关联接续已保留来源诊断，不重复追加');
        assert.ok(material.sourceEvidence.some(item => item.name === 'A' && item.writable === false));
        f.state.answer = { ...f.answer(), changes: [{ path: 'b.js', before: 'broken()', after: 'working()', reason: '修正暂停前已选择的目标。' }] };
        const generated = await f.api.analyze(selected, f.connection);
        assert.equal((await f.api.apply(generated)).ok, true);
        assert.equal(f.state.writes[0].name, 'B');
    }
    for (const mutate of [
        async (f) => { await f.api.prepareLogs('无关的新材料。'); },
        (f, previous) => { previous.repairTargets[0].paths.push('boot.json'); },
        (f, previous, following) => { following.material += ' '; },
        f => { f.packages.A.files['a.js'] = 'changed'; },
        f => { f.packages.B.files['b.js'] = 'changed'; },
        f => { f.state.disabled.push('Other'); },
    ]) {
        const f = multiplePackageFixture();
        f.packages.A.files['a.js'] = 'const secondary = broken();';
        f.state.answer = f.answer();
        const previous = await f.api.analyze(await f.api.prepare('B', 'broken 调用发生异常。'), f.connection);
        const following = await f.api.prepareInvestigation(previous);
        await mutate(f, previous, following);
        const sent = f.state.requests.length;
        await assert.rejects(f.api.prepareRepair(previous, 'B'), /计划.*改变|材料.*改变|材料.*过期|配置.*改变|包.*改变/);
        assert.equal(f.state.requests.length, sent); assert.equal(f.state.writes.length, 0);
    }

    // 生成目标与诊断一样不可篡改，配置或原包变化使目标失效。
    for (const mutate of [plan => plan.repairTargets[0].paths.push('boot.json'), plan => { plan.repairTargets[0].name = 'ModHub'; }]) {
        const f = fixture();
        f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepare('Example', '核对完整目标。'), f.connection);
        assert.deepEqual(plain(plan.repairTargets), [{ name: 'Example', paths: ['javascript/example.js', 'style/example.css'] }]);
        await assert.rejects(f.api.prepareRepair(plain(plan), 'Example'), /计划已改变/);
        mutate(plan);
        await assert.rejects(f.api.prepareRepair(plan, 'Example'), /计划已改变/);
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }
    for (const change of ['package', 'lists', 'during-read']) {
        const f = fixture();
        f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepare('Example', '核对生成前状态。'), f.connection);
        if (change === 'package') f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' });
        else if (change === 'lists') f.state.disabled.push('Other');
        else {
            const read = f.sb.modHubReadInstalledModPackage;
            let count = 0;
            f.sb.modHubReadInstalledModPackage = async name => {
                if (++count === 2) f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' });
                return read(name);
            };
        }
        await assert.rejects(f.api.prepareRepair(plan, 'Example'), /配置或.*包体.*改变|配置或安装包已改变/);
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }
    {
        const f = fixture({ files: { 'bundle.js': 'x'.repeat(256 * 1024) + ' broken()' }, boot: { scriptFileList: ['bundle.js'], styleFileList: [] } });
        f.state.answer = readingAnswer(f, { name: 'Example', paths: ['bundle.js'], reason: '核对大文件调用。', search: ['broken'] });
        const source = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('broken 报错。', { includeSources: true }), f.connection));
        f.state.answer = { ...f.state.answer, readRequest: null };
        const plan = await f.api.analyze(source, f.connection);
        assert.deepEqual(plain(plan.repairTargets), [], '只读大文件窗口不能成为生成目标');
        await assert.rejects(f.api.prepareRepair(plan, 'Example'), /完整源码范围/);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture({ files: { 'small.js': 'x', 'oversized.js': 'x'.repeat(256 * 1024 + 1) }, boot: { scriptFileList: ['small.js', 'oversized.js'], styleFileList: [] } });
        f.state.answer = readingAnswer(f, { name: 'Example', paths: ['small.js'], reason: '读取符合限制的文件。' });
        const source = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('检查所有可读文件。', { includeSources: true }), f.connection));
        f.state.answer = { ...f.state.answer, readRequest: null };
        const plan = await f.api.analyze(source, f.connection);
        assert.equal(plan.canContinue, true, '大文件允许进一步按明确搜索词只读定位');
        await assert.rejects(f.api.prepareInvestigation(plan), /没有新的源码证据/, '大文件无命中时不耗一次云分析或返回空目录');
    }

    {
        const f = fixture(); f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepareLogs('目录读取失败也保留原原因。'), f.connection);
        f.sb.modHubReadInstalledModPackage = async () => ({ error: new Error('候选包 CRC 校验失败：patch/Start.txt') });
        await assert.rejects(f.api.prepareInvestigation(plan), /没有新的源码证据.*CRC.*patch\/Start\.txt/);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
    }

    for (const mutate of [f => { f.packages.B.files['b.js'] = 'changed'; }, f => { f.state.disabled.push('Other'); }, async f => { await f.api.prepareLogs('新材料。'); }]) {
        const f = multiplePackageFixture(); f.state.answer = f.answer();
        const plan = await f.api.analyze(await f.api.prepareLogs('继续定位前检查原目录。', { includeSources: true }), f.connection);
        await mutate(f);
        await assert.rejects(f.api.prepareInvestigation(plan), /改变|过期/);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
    }

    for (const mutate of [plan => { plan.canContinue = false; }, plan => { plan.continuationReason = '伪造定位原因'; }]) {
        const f = multiplePackageFixture(); f.state.answer = f.answer();
        const plan = await f.api.analyze(await f.api.prepareLogs('继续入口验证真伪。', { includeSources: true }), f.connection);
        await assert.rejects(f.api.prepareInvestigation(plain(plan)), /计划已改变/);
        mutate(plan);
        await assert.rejects(f.api.prepareInvestigation(plan), /计划已改变/);
        assert.equal(f.state.requests.length, 1);
    }

    {
        const calls = [];
        const forbidden = name => () => { calls.push(name); throw new Error('连接格式验证不得访问 ' + name); };
        const sb = createBaseSandbox({
            fetch: forbidden('网络'), modHubReadIndexDBModLists: forbidden('模组列表'),
            modHubReadInstalledModPackage: forbidden('包体'), modHubReadInstalledModBoot: forbidden('包体声明'),
            localStorage: { getItem: forbidden('本地存储'), setItem: forbidden('本地存储'), removeItem: forbidden('本地存储') },
        });
        loadScripts(sb, ['javascript/modhub-ai-repair.js']);
        const validate = sb.modHubAiRepair.validateConnection;
        assert.equal(typeof validate, 'function');
        for (const [endpoint, expected] of [
            ['https://example.test/v1', 'https://example.test/v1/chat/completions'],
            ['https://example.test/v1/', 'https://example.test/v1/chat/completions'],
            ['https://example.test/v1/chat/completions', 'https://example.test/v1/chat/completions'],
            ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
            ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/chat/completions'],
            ['http://[::1]:1234/v1', 'http://[::1]:1234/v1/chat/completions'],
        ]) {
            assert.equal(validate({ endpoint, model: 'provider/model-name:version' }), expected);
            assert.equal(validate({ endpoint, model: ' model ', key: 'session-key' }), expected);
        }
        assert.equal(validate({ endpoint: 'https://example.test/v1', model: 'm'.repeat(200), key: '' }), 'https://example.test/v1/chat/completions');
        for (const model of [undefined, null, '', '   ', 1, {}, 'm'.repeat(201)]) {
            assert.throws(() => validate({ endpoint: 'https://example.test/v1', model }), /模型名称和 API 密钥/);
        }
        for (const key of [null, 1, {}, 'key\nvalue', 'key\rvalue']) {
            assert.throws(() => validate({ endpoint: 'https://example.test/v1', model: 'model', key }), /模型名称和 API 密钥/);
        }
        for (const endpoint of [undefined, null, 'not-a-url', 'http://example.test/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#fragment', 'file:///api']) {
            assert.throws(() => validate({ endpoint, model: 'model' }), /API 地址/);
        }
        assert.throws(() => validate(), /模型名称和 API 密钥/);
        assert.deepEqual(calls, [], '保存连接参数前的格式检查不请求服务，也不读写模组或本地存储');
    }

    // 连接测试仅发送固定短消息，不读取问题材料，也不回传或记录服务文本。
    {
        const f = fixture();
        const calls = [];
        const forbidden = name => () => { calls.push(name); throw new Error('连接测试不得访问 ' + name); };
        for (const name of ['modHubReadIndexDBModLists', 'modHubReadInstalledModPackage', 'modHubReadInstalledModBoot',
            'modHubGetRawModLoaderLogs', 'modHubAnalyzeLogs', 'modHubApplyAiPackage', 'modHubGetGui']) f.sb[name] = forbidden(name);
        f.sb.modHubAiPackage = { read: forbidden('读取 ZIP'), hash: forbidden('包体摘要'), replace: forbidden('改写 ZIP') };
        f.sb.localStorage = { getItem: forbidden('读取存储'), setItem: forbidden('保存存储'), removeItem: forbidden('移除存储') };
        f.sb.console = { log: forbidden('输出日志'), warn: forbidden('输出警告'), error: forbidden('输出错误') };
        f.sb.fetch = async (url, request) => {
            f.state.requests.push({ url, request });
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '服务返回的任意非空文本不得展示' } }] }) };
        };
        const result = await f.api.testConnection({ ...f.connection, model: ' example ' });
        assert.deepEqual(plain(result), { model: 'example' }, '只确认服务返回文本，不将正文带入界面');
        assert.equal(f.state.requests.length, 1);
        const { url, request } = f.state.requests[0];
        assert.equal(url, 'https://example.test/v1/chat/completions');
        assert.equal(request.method, 'POST');
        assert.equal(request.redirect, 'error');
        assert.equal(request.credentials, 'omit');
        assert.equal(request.headers.Authorization, 'Bearer ' + f.connection.key);
        assert.equal(request.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(request.body), { model: 'example', stream: false, max_tokens: 128, messages: [{ role: 'user', content: '请只回复 OK。' }] });
        assert.ok(!request.body.includes(f.connection.key));
        assert.deepEqual(f.state.timerDelays, [15000]);
        assert.deepEqual(f.state.clearedTimers, [1]);
        assert.deepEqual(calls, [], '连接测试不得接触日志、模组包、启禁列表、设置或控制台');
        await f.api.testConnection({ endpoint: f.connection.endpoint, model: 'example' });
        assert.ok(!('Authorization' in f.state.requests[1].request.headers), '无密钥本机服务不添加空认证头');
        assert.equal(f.state.writes.length, 0);
        await assert.rejects(f.api.testConnection({ ...f.connection, endpoint: 'http://example.test/v1' }), /API 地址/);
        await assert.rejects(f.api.testConnection({ ...f.connection, model: '' }), /模型名称/);
        await assert.rejects(f.api.testConnection({ ...f.connection, model: f.connection.key }), /包含 API 密钥/);
        assert.equal(f.state.requests.length, 2, '无效连接参数不能发起测试请求');
    }

    // 只按官方 origin 发送 DeepSeek 思考开关，不凭模型名称识别兼容代理。
    for (const [endpoint, official] of [
        ['https://api.deepseek.com', true],
        ['https://api.deepseek.com/v1', true],
        ['https://api.deepseek.com/beta', true],
        ['https://API.DeepSeek.com:443/v1', true],
        ['https://api.deepseek.com.example.test/v1', false],
        ['https://proxy.example.test/deepseek/v1', false],
        ['https://api.deepseek.com:8443/v1', false],
    ]) {
        const f = fixture();
        f.sb.fetch = async (url, request) => {
            f.state.requests.push({ url, request });
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK', reasoning_content: '推理内容不能替代最终答案或返回界面' } }] }) };
        };
        const result = await f.api.testConnection({ ...f.connection, endpoint, model: 'deepseek-flash' });
        assert.deepEqual(plain(result), { model: 'deepseek-flash' });
        assert.equal(f.state.requests.length, 1, '测试连接不因服务适配重复请求');
        const body = JSON.parse(f.state.requests[0].request.body);
        assert.equal(body.max_tokens, 128, '小请求须为最终正文保留合理余量，不能限制为 8 token');
        assert.deepEqual(body.messages, [{ role: 'user', content: '请只回复 OK。' }]);
        assert.equal(body.stream, false);
        if (official) assert.deepEqual(body.thinking, { type: 'disabled' });
        else assert.ok(!('thinking' in body), '其他 origin 不接收 DeepSeek 专有参数');
        assert.equal(f.state.writes.length, 0);
    }

    for (const [message, finishReason, expected] of [
        [{ content: '', reasoning_content: '只有推理原文不得展示' }, 'stop', /只返回了推理字段.*最终正文/],
        [{ content: '', reasoning_content: '仅生成少量推理 token' }, 'length', /长度上限.*finish_reason: length/],
        [{ content: 'OK' }, 'length', /长度上限.*finish_reason: length/],
        [{ content: 'OK', refusal: '拒答原文不得展示' }, 'stop', /拒绝生成/],
        [{ content: 'OK', tool_calls: [{ type: 'function' }] }, 'tool_calls', /工具调用/],
    ]) {
        const f = fixture();
        let requests = 0;
        f.sb.fetch = async () => { requests++; return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: finishReason, message }] }) }; };
        await assert.rejects(f.api.testConnection({ ...f.connection, endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }), error => expected.test(error.message)
            && !/原文不得展示/.test(error.message));
        assert.equal(requests, 1, '无最终正文或输出未完成时明确失败，不自动重试');
        assert.deepEqual(f.state.clearedTimers, [1]);
    }

    {
        const f = fixture();
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), { ...f.connection, endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
        const body = JSON.parse(f.state.requests[0].request.body);
        assert.deepEqual(body.thinking, { type: 'disabled' }, '官方 DeepSeek 的正式结构化请求同样使用最终正文模式');
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.equal(body.max_tokens, 8192, '正式修复为完整 JSON 输出明确设置合理额度');
        assert.equal(plan.mode, 'structured');
        assert.equal(plan.notice, '');
    }

    // 测试连接保留已准备材料的有效性，正式分析仍使用独立的 90 秒整体超时。
    {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '原问题材料。');
        const revision = prepared.revision;
        const originalFetch = f.sb.fetch;
        f.sb.fetch = async (url, request) => JSON.parse(request.body).max_tokens === 128
            ? { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) }
            : originalFetch(url, request);
        await f.api.testConnection(f.connection);
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(prepared.revision, revision);
        assert.equal(plan.revision, revision);
        assert.equal(plan.changes.length, 1, '测试连接不得使已准备的修复材料过期');
        assert.equal(JSON.parse(f.state.requests[0].request.body).messages[1].content, prepared.material);
        assert.equal(JSON.parse(f.state.requests[0].request.body).max_tokens, 8192, '正式分析不使用连接测试的小响应额度');
        assert.deepEqual(f.state.timerDelays, [15000, 90000]);
        assert.deepEqual(f.state.clearedTimers, [1, 2]);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(f.api.testConnection({ ...f.connection, signal: cancelled.signal }), /已取消连接测试/);
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.timers.length, 0);
        let started;
        const fetching = new Promise(resolve => { started = resolve; });
        f.sb.fetch = async (_url, request) => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('服务中止正文不得显示')));
            started();
        });
        const live = new AbortController();
        const pending = f.api.testConnection({ ...f.connection, signal: live.signal });
        await fetching;
        live.abort();
        await assert.rejects(pending, /已取消连接测试/);
        assert.deepEqual(f.state.clearedTimers, [1]);
        const timeout = fixture();
        let timeoutStarted;
        const timeoutFetching = new Promise(resolve => { timeoutStarted = resolve; });
        timeout.sb.fetch = async (_url, request) => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('服务中止正文不得显示')));
            timeoutStarted();
        });
        const timed = timeout.api.testConnection(timeout.connection);
        await timeoutFetching;
        timeout.state.timers[0]();
        await assert.rejects(timed, /超过 15 秒/);
        assert.deepEqual(timeout.state.timerDelays, [15000]);
        assert.deepEqual(timeout.state.clearedTimers, [1]);

        const reading = fixture();
        let complete;
        let bodyStarted;
        const bodyReading = new Promise(resolve => { bodyStarted = resolve; });
        reading.sb.fetch = async () => ({ ok: true, text: () => new Promise(resolve => { complete = resolve; bodyStarted(); }) });
        const controller = new AbortController();
        const bodyPending = reading.api.testConnection({ ...reading.connection, signal: controller.signal });
        await bodyReading;
        controller.abort();
        complete(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        await assert.rejects(bodyPending, /已取消连接测试/, '读取响应期间取消后，即使服务返回文本也不能报成功');
    }

    for (const status of [401, 500]) {
        const f = fixture();
        let bodyReads = 0;
        f.sb.fetch = async () => ({ ok: false, status, text: async () => { bodyReads++; return '服务错误正文不得直接展示'; } });
        await assert.rejects(f.api.testConnection(f.connection), error => error.message.includes('HTTP ' + status)
            && !error.message.includes(f.connection.key) && !error.message.includes('服务错误正文 '));
        assert.equal(bodyReads, 1, 'HTTP 失败时限额读取一次；非 JSON 服务正文不得直接显示');
        assert.deepEqual(f.state.clearedTimers, [1]);
    }

    for (const [body, expected] of [
        ['返回了普通文本', /有效 JSON/],
        ['{', /有效 JSON/],
        [JSON.stringify({}), /choices\[0\]\.message/],
        [JSON.stringify({ choices: [{ message: { content: '' } }] }), /非空文本/],
        [JSON.stringify({ choices: [{ message: { content: '  \n ' } }] }), /非空文本/],
        [JSON.stringify({ choices: [{ message: { content: 123 } }] }), /非空文本/],
        ['x'.repeat(1024 * 1024 + 1), /1 MiB/],
    ]) {
        const f = fixture();
        f.sb.fetch = async () => ({ ok: true, status: 200, text: async () => body });
        await assert.rejects(f.api.testConnection(f.connection), expected);
        assert.deepEqual(f.state.clearedTimers, [1]);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        f.sb.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: f.connection.key } }] }) });
        await assert.rejects(f.api.testConnection(f.connection), error => /包含 API 密钥/.test(error.message) && !error.message.includes(f.connection.key));
        for (const error of [new Error('服务异常正文 ' + f.connection.key), new TypeError('网络异常正文 ' + f.connection.key)]) {
            f.sb.fetch = async () => { throw error; };
            await assert.rejects(f.api.testConnection(f.connection), result => /隐去密钥/.test(result.message) && !result.message.includes(f.connection.key));
        }
        f.sb.fetch = async () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(f.api.testConnection(f.connection), /CORS/);
        f.sb.fetch = async () => { throw new Error('未知错误正文不得显示'); };
        await assert.rejects(f.api.testConnection(f.connection), error => /连接测试未完成/.test(error.message) && !error.message.includes('未知错误正文'));
        f.sb.fetch = async () => ({ ok: true, headers: { get: () => String(2 * 1024 * 1024) }, text: async () => { throw new Error('超限响应不得读取'); } });
        await assert.rejects(f.api.testConnection(f.connection), /1 MiB/);
    }

    {
        const f = fixture();
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(f.state.answer) + '\n```' } }] }) });
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection);
        assert.equal(plan.changes.length, 1, '接受单个 JSON 围栏仍须通过原文和结构校验');
    }

    for (const wrap of [
        value => value,
        value => '```\n' + value + '\n```',
        value => '```JSON\r\n' + value + '\r\n```',
        value => '以下方案仍需确认原文和实际效果。\n```json\n' + value + '\n```\n请重新载入验证。',
    ]) {
        const f = fixture();
        const requests = [];
        const stages = [];
        f.sb.fetch = async (_url, request) => {
            requests.push(JSON.parse(request.body));
            return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: wrap(JSON.stringify(f.state.answer)) } }] }) };
        };
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), { ...f.connection, onProgress: (...args) => stages.push(args) });
        assert.equal(plan.changes.length, 1, '明确 JSON 或唯一 JSON 围栏须继续经过原文替换校验');
        assert.equal(requests.length, 1, '解析兼容不能自动重复收费请求');
        assert.deepEqual(requests[0].response_format, { type: 'json_object' }, '正式分析必须明确请求 JSON 对象输出');
        assert.match(requests[0].messages[0].content, /JSON/);
        assert.deepEqual(stages, [['preflight'], ['request'], ['response'], ['validate']], '进度只提供固定阶段，不包含服务正文、材料或密钥');
        assert.equal(f.state.writes.length, 0);
    }

    for (const [body, expected, advice] of [
        ['<html>网关错误正文不得显示</html>', /服务响应不是有效 JSON/],
        [JSON.stringify({ choices: [] }), /choices\[0\]\.message/],
        [JSON.stringify({ choices: [{ message: { content: '' } }] }), /非空文本正文/],
        [JSON.stringify({ choices: [{ message: { content: null, reasoning_content: '推理原文不得显示' } }] }), /只返回了推理字段.*最终正文/],
        [JSON.stringify({ choices: [{ message: { refusal: '服务拒答原文不得显示', content: null } }] }), /拒绝生成/],
        [JSON.stringify({ choices: [{ message: { content: '请先检查配置。' } }] }), null, true],
        [JSON.stringify({ choices: [{ message: { content: '```json\n{"summary":"尚未完成"\n```' } }] }), null, true],
        [JSON.stringify({ choices: [{ message: { content: '```json\n{}\n```\n```json\n{}\n```' } }] }), null, true],
        [JSON.stringify({ choices: [{ message: { content: '另一个对象 {}\n```json\n{}\n```' } }] }), null, true],
        [JSON.stringify({ choices: [{ message: { content: '{}\n{}' } }] }), null, true],
    ]) {
        const f = fixture();
        let requests = 0;
        const stages = [];
        f.sb.fetch = async () => { requests++; return { ok: true, text: async () => body }; };
        f.sb.modHubAiPackage.replace = () => { throw new Error('无效响应不得改写安装包'); };
        const pending = f.api.analyze(await f.api.prepare('Example', '测试错误'), { ...f.connection, onProgress: stage => stages.push(stage) });
        if (advice) {
            const plan = await pending;
            assert.equal(plan.mode, 'advice'); assert.deepEqual(plain(plan.changes), []); assert.equal(plan.data, null);
            assert.equal((await f.api.apply(plan)).ok, false, '未唯一解析的响应在源码模式也只能作为安全建议');
        } else await assert.rejects(pending, error => expected.test(error.message) && !/不得显示/.test(error.message));
        assert.equal(requests, 1, '格式失败不自动重试');
        assert.deepEqual(stages, advice ? ['preflight', 'request', 'response', 'validate'] : ['preflight', 'request', 'response']);
        assert.equal(f.state.writes.length, 0);
    }

    for (const [finishReason, expected] of [
        ['length', /长度上限.*finish_reason: length/],
        ['content_filter', /内容过滤.*finish_reason: content_filter/],
        ['tool_calls', /工具调用.*finish_reason: tool_calls/],
        ['function_call', /函数调用.*finish_reason: function_call/],
        ['insufficient_system_resource', /资源不足.*finish_reason: insufficient_system_resource/],
        ['aborted', /服务中止.*finish_reason: aborted/],
        [null, /未确认完成的 finish_reason/],
        ['unknown-provider-state', /未确认完成的 finish_reason/],
    ]) {
        const f = fixture();
        let requests = 0;
        f.sb.fetch = async () => { requests++; return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(f.state.answer) } }] }) }; };
        f.sb.modHubAiPackage.replace = () => { throw new Error('未完成输出不能生成修复包'); };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), expected);
        assert.equal(requests, 1);
        assert.equal(f.state.writes.length, 0, '即使正文恰好是有效 JSON，未正常完成的输出仍不可应用');
    }

    // 无修改诊断容错只规范化说明文本；不会把缺失结构猜成代码修改。
    for (const value of [
        { summary: '尚需核对初始化。' },
        { summary: ['尚需核对初始化。', '现有日志未能确认责任来源。'], evidence: ['首处错误位于 Start。', '未读取存档。'], verification: ['重新载入。', '检查同一错误是否重现。'], changes: [] },
        { summary: '暂无可应用修改。', evidence: [], verification: null, changes: null },
    ]) {
        const f = fixture(); f.state.answer = value;
        const plan = await f.api.analyze(await f.api.prepareLogs('分析初始化错误。'), f.connection);
        assert.equal(plan.responseCorrection, false);
        assert.equal(plan.mode, 'structured'); assert.deepEqual(plain(plan.changes), []); assert.equal(plan.data, null);
        assert.equal(plan.summary, Array.isArray(value.summary) ? value.summary.join('\n') : value.summary);
        assert.ok(plan.evidence.trim()); assert.ok(plan.verification.trim());
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.writes.length, 0);
    }
    {
        const f = fixture();
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '```json ' + JSON.stringify({ summary: '暂无代码修改。' }) + '```' } }] }) });
        const plan = await f.api.analyze(await f.api.prepareLogs('核对外层围栏。'), f.connection);
        assert.equal(plan.mode, 'structured'); assert.equal(plan.summary, '暂无代码修改。'); assert.equal(plan.data, null);
    }
    {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '现有源码调用错误。', { paths: ['javascript/example.js'], includeSources: true });
        const expected = { ...f.state.answer };
        f.state.answer = { ...expected, verification: undefined };
        const invalid = await f.api.analyze(prepared, f.connection);
        assert.equal(invalid.responseCorrection, true); assert.equal(invalid.validationFeedback.kind, 'response-format');
        assert.match(invalid.validationFeedback.reason, /verification/);
        assert.deepEqual(plain(invalid.changes), []); assert.equal(invalid.data, null);
        assert.equal((await f.api.apply(invalid)).ok, false, '实际修改缺少必需说明时不降级放行原替换');
        const corrected = await f.api.prepareInvestigation(invalid);
        assert.deepEqual(plain(corrected.files), plain(prepared.files), '格式校正不读取未确认的新 files');
        assert.deepEqual(plain(corrected.sourceCatalog), plain(prepared.sourceCatalog));
        assert.deepEqual(plain(corrected.sourceEvidence), plain(prepared.sourceEvidence));
        const context = JSON.parse(corrected.material).diagnosisContext;
        assert.equal(context.round, 2); assert.equal(context.responseCorrection, true);
        assert.equal(context.validationFeedback.kind, 'response-format'); assert.match(context.validationFeedback.responseExcerpt, /verification|summary/);
        assert.equal(f.state.requests.length, 1, '本机格式校正准备不产生隐藏网络请求');
        f.state.answer = expected;
        const plan = await f.api.analyze(corrected, f.connection);
        assert.equal(plan.changes.length, 1); assert.equal(f.state.requests.length, 2);
        assert.equal((await f.api.apply(plan)).ok, true, '校正后的原文替换仍通过完整受控应用链路');
        assert.equal(f.state.writes.length, 1);
    }
    {
        const f = multiplePackageFixture();
        f.state.answer = { ...f.answer(f.readA), summary: '已核对日志，尚需 A 的真实调用。' };
        const current = await f.api.prepareRequestedSources(await f.api.analyze(await f.api.prepareLogs('核对 broken 调用。', { includeSources: true }), f.connection));
        const previous = JSON.parse(current.material).diagnosisContext.history[0];
        f.state.answer = { summary: { bad: '不能将此对象当作结论' }, changes: 'invalid', evidence: ['api_key="reply-secret"'] };
        const invalid = await f.api.analyze(current, f.connection);
        assert.equal(invalid.summary, previous.summary, '首次结构失败优先保留此前有效诊断');
        assert.equal(invalid.responseCorrection, true); assert.ok(!invalid.validationFeedback.responseExcerpt.includes('reply-secret'));
        const corrected = await f.api.prepareInvestigation(invalid);
        const terminal = await f.api.analyze(corrected, f.connection);
        assert.equal(terminal.responseCorrection, false); assert.equal(terminal.canContinue, false);
        assert.equal(terminal.summary, previous.summary); assert.equal(terminal.evidence, previous.evidence);
        assert.match(terminal.continuationReason, /已尝试一次.*格式校正.*已有材料|已尝试一次.*当前材料/);
        assert.match(terminal.validationFeedback.reason, /summary.*changes/);
        assert.deepEqual(plain(terminal.changes), []); assert.equal(terminal.data, null);
        await assert.rejects(f.api.prepareInvestigation(terminal), /已尝试一次.*格式校正/);
        assert.equal(f.state.requests.length, 3); assert.equal(f.state.writes.length, 0);
        assert.equal(JSON.parse(corrected.material).diagnosisContext.history[0].summary, previous.summary);
    }
    {
        const f = fixture(); f.state.answer = {};
        const prepared = await f.api.prepareLogs('纯日志格式校正。');
        delete f.sb.modHubAiPackage;
        f.sb.modHubReadInstalledModPackage = () => { throw new Error('格式校正不能读取新包体'); };
        const invalid = await f.api.analyze(prepared, f.connection);
        const corrected = await f.api.prepareInvestigation(invalid);
        assert.deepEqual(plain(corrected.files), []); assert.deepEqual(plain(corrected.sourceCatalog), []);
        f.state.answer = { summary: '日志尚不足以确认代码修改。' };
        const plan = await f.api.analyze(corrected, f.connection);
        assert.equal(plan.responseCorrection, false); assert.equal(plan.data, null); assert.equal(f.state.requests.length, 2);
    }
    for (const withSources of [false, true]) {
        const logs = [{ level: 'error', message: '此前已确认的错误日志' }];
        const f = fixture({ logs }); f.state.answer = {};
        const prepared = withSources
            ? await f.api.prepare('Example', '同材料校正。', { paths: ['javascript/example.js'], includeSources: true })
            : await f.api.prepareLogs('同材料校正。');
        const original = JSON.parse(prepared.material);
        const invalid = await f.api.analyze(prepared, f.connection);
        logs.push({ level: 'error', message: '轮次间新增但尚未确认的日志' });
        f.sb.StartConfig.version = '轮次间变动的环境标识';
        f.sb.modHubGetGui = () => ({ gModUtils: { version: '新加载器环境标识' } });
        const corrected = await f.api.prepareInvestigation(invalid);
        const material = JSON.parse(corrected.material);
        assert.deepEqual(material.logs, original.logs, '格式校正保留上一轮实际发送日志，不自动增加全局新日志');
        assert.deepEqual(material.environment, original.environment, '格式校正保留已确认环境快照');
        assert.deepEqual(material.files, original.files);
        assert.equal(material.diagnosisContext.round, 2); assert.equal(material.diagnosisContext.responseCorrection, true);
        assert.ok(!corrected.material.includes('尚未确认的日志')); assert.ok(!corrected.material.includes('环境标识'));
        f.state.answer = { summary: '已按原材料校正结构。', changes: [] };
        await f.api.analyze(corrected, f.connection);
        assert.equal(JSON.parse(f.state.requests[1].request.body).messages[1].content, corrected.material, '私有材料、预览正文和实际发送保持同一快照');
        assert.equal(f.state.writes.length, 0);
    }
    {
        const f = fixture(); f.state.answer = { summary: {}, changes: [] };
        const plan = await f.api.analyze(await f.api.prepareLogs('轮次预算边界。', { maxRounds: 1 }), f.connection);
        assert.equal(plan.responseCorrection, false); assert.equal(plan.canContinue, false);
        assert.match(plan.continuationReason, /达到 1 轮上限.*AI 设置/);
        await assert.rejects(f.api.prepareInvestigation(plan), /达到 1 轮上限/);
        assert.equal(f.state.requests.length, 1);
    }
    // 读取路径校正与格式校正各自一次，但均消耗相同的总轮次预算。
    {
        const f = fixture();
        f.state.answer = { ...f.state.answer, changes: [], readRequest: { name: 'Example', paths: ['missing.js'], reason: '核对调用。' } };
        const readInvalid = await f.api.analyze(await f.api.prepareLogs('broken 调用失败。', { includeSources: true }), f.connection);
        const readCorrected = await f.api.prepareInvestigation(readInvalid);
        f.state.answer = {};
        const formatInvalid = await f.api.analyze(readCorrected, f.connection);
        assert.equal(formatInvalid.responseCorrection, true, '已有路径校正不封锁独立的格式校正');
        const formatCorrected = await f.api.prepareInvestigation(formatInvalid);
        assert.equal(JSON.parse(formatCorrected.material).diagnosisContext.round, 3);
        f.state.answer = { summary: '仍然返回无效路径。', changes: [], readRequest: { name: 'Example', paths: ['missing.js'], reason: '重复错误。' } };
        await assert.rejects(f.api.analyze(formatCorrected, f.connection), /未声明.*missing\.js/, '格式校正不能重置已消耗的路径校正');
        assert.equal(f.state.requests.length, 3); assert.equal(f.state.writes.length, 0);
    }
    for (const stop of ['cancel', 'timeout', 'snapshot']) {
        const f = fixture(); f.state.answer = {};
        const invalid = await f.api.analyze(await f.api.prepare('Example', '校正边界。'), f.connection);
        const corrected = await f.api.prepareInvestigation(invalid);
        if (stop === 'snapshot') {
            f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' });
            await assert.rejects(f.api.analyze(corrected, f.connection), /改变/);
            assert.equal(f.state.requests.length, 1, '格式校正仍在网络前核验快照');
        } else {
            let complete, started;
            const fetching = new Promise(resolve => { started = resolve; });
            f.sb.fetch = () => new Promise(resolve => { complete = resolve; started(); });
            const controller = new AbortController();
            const pending = f.api.analyze(corrected, { ...f.connection, signal: controller.signal });
            await fetching;
            if (stop === 'cancel') controller.abort(); else f.state.timers[f.state.timers.length - 1]();
            complete({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '已校正。', changes: [] }) } }] }) });
            await assert.rejects(pending, stop === 'cancel' ? /已取消分析/ : /超过 90 秒/);
        }
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        const stages = [];
        await assert.doesNotReject(f.api.analyze(prepared, { ...f.connection, onProgress: stage => {
            stages.push(stage);
            if (stage === 'request') return Promise.reject(new Error('界面进度更新异常'));
            throw new Error('界面进度更新异常');
        } }), '进度回调失败不得使正常分析中止');
        assert.deepEqual(stages, ['preflight', 'request', 'response', 'validate']);
        const stale = fixture();
        const old = await stale.api.prepare('Example', '测试错误');
        stale.state.disabled.push('Other');
        const beforeRequest = [];
        await assert.rejects(stale.api.analyze(old, { ...stale.connection, onProgress: stage => beforeRequest.push(stage) }), /改变/);
        assert.deepEqual(beforeRequest, ['preflight'], '发送前核对失败不能显示已请求或已收到结果');
        assert.equal(stale.state.requests.length, 0);

        const logsOnly = fixture();
        logsOnly.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '只有普通说明，不是结构化修复方案。' } }] }) });
        const advice = await logsOnly.api.analyze(await logsOnly.api.prepareLogs('分析日志。'), logsOnly.connection);
        assert.equal(advice.mode, 'advice', '纯日志模式保留普通说明，但必须明确其未经结构化校验');
        assert.match(advice.notice, /尚未生成结构化修复方案.*不会修改文件/);
        assert.deepEqual(plain(advice.changes), []);
        assert.equal(advice.data, null);
        assert.equal((await logsOnly.api.apply(advice)).ok, false, '普通排查说明不能应用为修改');
        assert.equal(logsOnly.state.writes.length, 0);
    }

    // 日志建议只作为脱敏纯文本展示，解析失败时不猜测或提取其中的补丁。
    for (const content of [
        '请先核对启用列表，再查看前置版本要求。',
        '建议检查 <<npcPregnancyUpdater>>。\n<script>不可执行</script>\n<img src=x onerror="不可执行">',
        '```json\n{"summary":"第一个对象","changes":[{"path":"outside.js"}]}\n```\n```json\n{"summary":"另一个对象"}\n```',
        '{"summary":"尚未形成完整对象"',
        'API Key: api_key="service-generated-secret"。请核对配置。',
    ]) {
        const f = fixture();
        const prepared = await f.api.prepareLogs('分析日志。');
        delete f.sb.modHubAiPackage;
        f.sb.modHubReadInstalledModPackage = () => { throw new Error('建议模式不能读包'); };
        f.sb.modHubApplyAiPackage = () => { throw new Error('建议模式不能改包'); };
        f.sb.fetch = async (url, request) => {
            f.state.requests.push({ url, request });
            return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
        };
        const stages = [];
        const plan = await f.api.analyze(prepared, { ...f.connection, onProgress: stage => stages.push(stage) });
        assert.equal(plan.mode, 'advice');
        assert.match(plan.notice, /普通排查建议.*尚未生成结构化修复方案.*不会修改文件/);
        assert.equal(plan.name, '');
        assert.deepEqual(plain(plan.changes), []);
        assert.equal(plan.diff, '');
        assert.equal(plan.data, null);
        assert.equal(plan.revision, prepared.revision);
        assert.ok(!plan.summary.includes('service-generated-secret'), '排查正文的常见密钥字段继续脱敏');
        if (!content.includes('service-generated-secret')) assert.equal(plan.summary, content, '完整建议原文不截断，也不从多对象中猜选补丁');
        assert.equal((await f.api.apply(plan)).ok, false);
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.writes.length, 0);
        assert.deepEqual(stages, ['preflight', 'request', 'response', 'validate']);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepareLogs('分析日志。');
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(8001) } }] }) });
        await assert.rejects(f.api.analyze(prepared, f.connection), /超过 8000 字.*无法完整显示/, '超限普通说明明确拒绝，不能默默截断');
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '缺少必要字段', changes: [] }) } }] }) });
        const diagnosis = await f.api.analyze(prepared, f.connection);
        assert.equal(diagnosis.summary, '缺少必要字段');
        assert.match(diagnosis.evidence, /未提供独立分析依据/);
        assert.match(diagnosis.verification, /重新检查原问题/);
        assert.equal(diagnosis.responseCorrection, false, '无修改诊断的可选字段省略不会要求重新付费分析');
        f.state.answer.changes = [{ path: 'outside.js', before: '旧原文', after: '新原文', reason: '不允许' }];
        f.sb.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(f.state.answer) } }] }) });
        await assert.rejects(f.api.analyze(prepared, f.connection), /当前仅分析日志/, '有效结构中的越权修改须拒绝，不能改成普通建议后忽略');
        assert.equal(f.state.writes.length, 0);
    }

    for (const cancelled of [false, true]) {
        const f = fixture();
        const prepared = await f.api.prepareLogs('分析日志。');
        let complete, started;
        const fetching = new Promise(resolve => { started = resolve; });
        f.sb.fetch = () => new Promise(resolve => { complete = resolve; started(); });
        const controller = new AbortController();
        const pending = f.api.analyze(prepared, { ...f.connection, signal: controller.signal });
        await fetching;
        if (cancelled) controller.abort();
        else f.state.disabled.push('Other');
        complete({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '先检查配置。' } }] }) });
        await assert.rejects(pending, cancelled ? /已取消分析/ : /改变/, '建议模式同样执行取消与配置过期校验');
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        f.state.enabled.push('ModHub', 'TweeReplacer');
        f.state.disabled.push('Disabled');
        f.sb.modHubReadInstalledModBoot = () => { throw new Error('只列名称时不应读取全部包体'); };
        const targets = await f.api.listTargets();
        assert.deepEqual(plain(targets).map(item => [item.name, item.enabled]), [['Example', true], ['Disabled', false]]);
        const metadata = await f.api.prepare('Example', '', { paths: [] });
        assert.equal(metadata.material, '');
        assert.deepEqual(plain(metadata.files), []);
        assert.deepEqual(plain(metadata.fileNames).map(item => item.path), ['javascript/example.js', 'style/example.css']);
        assert.ok(metadata.fileNames.every(item => item.size > 0));
        await assert.rejects(f.api.analyze(metadata, f.connection), /至少选择/);
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.writes.length, 0);
        await assert.rejects(f.api.prepare('ModHub', '测试'), /不允许/);
        await assert.rejects(f.api.prepare('Unknown', '测试'), /不在/);
    }

    {
        const f = fixture({ logs: [{ level: 'error', message: 'Authorization: Bearer private-token-123 api_key=secret123 sk-example123456 user@example.org {"api_key":"json-secret-value", "access_token": "json-token-value"} token=plain-token-value password:\'quoted pass value\'' }] });
        const prepared = await f.api.prepare('Example', '点击功能按钮后出现错误。', { paths: ['javascript/example.js'] });
        assert.equal(f.state.requests.length, 0, '准备和预览不发送网络请求');
        assert.equal(f.state.writes.length, 0, '准备和预览不得写配置');
        assert.ok(!prepared.material.includes('private-token-123'));
        assert.ok(!prepared.material.includes('secret123'));
        assert.ok(!prepared.material.includes('sk-example123456'));
        assert.ok(!prepared.material.includes('user@example.org'));
        for (const secret of ['json-secret-value', 'json-token-value', 'plain-token-value', 'quoted pass value']) assert.ok(!prepared.material.includes(secret));
        assert.equal(JSON.parse(prepared.material).environment.modHub, '未识别');
        assert.ok(!prepared.material.includes('不会发送的信息'));
        assert.ok(!prepared.material.includes('style/example.css'));
        const plan = await f.api.analyze(prepared, f.connection);
        const request = f.state.requests[0];
        assert.equal(request.url, 'https://example.test/v1/chat/completions');
        assert.equal(request.request.redirect, 'error');
        assert.equal(request.request.credentials, 'omit');
        assert.equal(request.request.headers.Authorization, 'Bearer ' + f.connection.key);
        assert.equal(JSON.parse(request.request.body).messages[1].content, prepared.material);
        assert.ok(!request.request.body.includes(f.connection.key));
        assert.equal(f.sb.localStorage.getItem('modhub_ai_key'), null);
        assert.match(plan.diff, /修改前：[\s\S]*broken\(\)[\s\S]*修改后：[\s\S]*working\(\)/);
        assert.equal(f.state.writes.length, 0, '分析只返回可审阅补丁');
        const result = await f.api.apply(plan);
        assert.equal(result.ok, true);
        assert.equal(result.pointId, 'repair-point');
        assert.equal(f.state.writes.length, 1);
        assert.equal(JSON.parse(new TextDecoder().decode(f.state.writes[0].data))['javascript/example.js'], 'const value = working();\nconst other = 1;');
        assert.deepEqual(plain(f.state.writes[0].enabled), ['Example']);
        assert.equal((await f.api.apply(plan)).ok, false, '成功后旧计划不得再次应用');
    }

    for (const endpoint of ['http://example.test/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/#fragment', 'file:///api']) {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        await assert.rejects(f.api.analyze(prepared, { ...f.connection, endpoint }), /API 地址/);
        assert.equal(f.state.requests.length, 0);
    }

    {
        const f = fixture({ files: { 'patch/known.twee': '<<print broken()>>', 'patch/unknown.twee': '<<print ignored()>>' }, boot: {
            scriptFileList: [], styleFileList: [], addonPlugin: [
                { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ replaceFile: 'patch/known.twee' }, { replaceString: '内联替换不读取文件' }] },
                { modName: 'UnknownPlugin', params: [{ replaceFile: 'patch/unknown.twee' }] },
            ],
        } });
        const metadata = await f.api.prepare('Example', '', { paths: [] });
        assert.deepEqual(plain(metadata.fileNames).map(item => item.path), ['patch/known.twee']);
        await assert.rejects(f.api.prepare('Example', '测试错误', { paths: ['patch/unknown.twee'] }), /路径/);
        const prepared = await f.api.prepare('Example', '测试错误', { paths: ['patch/known.twee'] });
        f.state.answer.changes[0].path = 'patch/known.twee';
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(JSON.parse(new TextDecoder().decode(plan.data))['patch/known.twee'], '<<print working()>>');
        f.state.boot.addonPlugin[0].params = {};
        await assert.rejects(f.api.prepare('Example', '', { paths: [] }), /补丁参数/);
    }

    // DomRobin 官方 boot.json 使用 .txt；实际 TweeReplacer 1.7.0 按声明路径读文本，不检查扩展名。
    // 来源：https://raw.githubusercontent.com/ZeroRing233/Degrees-of-Lewdity-RobinMod/master/boot.json
    {
        const sourcePath = 'game/robin-work/lemonade/lemonadeUpgradeResult.txt';
        const f = fixture({ files: { [sourcePath]: '<<print broken()>>', 'game/not-declared.txt': '不能发送' }, boot: {
            scriptFileList: [], styleFileList: [], tweeFileList: [], additionFile: [sourcePath, 'game/not-declared.txt'],
            addonPlugin: [{ modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', modVersion: '1.0.0',
                params: [{ passage: "Robin's Lemonade", findString: '<<print $robin.timer.hurt', replaceFile: sourcePath }] }],
        } });
        f.state.enabled = ['DomRobin'];
        const metadata = await f.api.prepare('DomRobin', '', { paths: [] });
        assert.deepEqual(plain(metadata.fileNames).map(item => item.path), [sourcePath]);
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.writes.length, 0);
        await assert.rejects(f.api.prepare('DomRobin', '点击功能后报错', { paths: ['game/not-declared.txt'] }), /路径/);
        const prepared = await f.api.prepare('DomRobin', '点击功能后报错', { paths: [sourcePath] });
        assert.ok(prepared.material.includes(sourcePath));
        assert.ok(!prepared.material.includes('game/not-declared.txt'));
        f.state.answer.changes[0].path = sourcePath;
        const plan = await f.api.analyze(prepared, f.connection);
        assert.equal(JSON.parse(new TextDecoder().decode(plan.data))[sourcePath], '<<print working()>>');
        assert.equal((await f.api.apply(plan)).ok, true);
        assert.equal(f.state.writes.length, 1);
        f.state.boot.addonPlugin[0].addonName = 'UnknownAddon';
        assert.equal((await f.api.prepare('DomRobin', '', { paths: [] })).fileNames.length, 0, '同技术模组的未知插件不能扩大源码范围');
    }

    for (const path of ['patch/replacement', 'patch/template.html']) {
        const f = fixture({ files: { [path]: '<<print broken()>>' }, boot: { scriptFileList: [], styleFileList: [], addonPlugin: [
            { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ replaceFile: path }] },
        ] } });
        assert.deepEqual(plain((await f.api.prepare('Example', '', { paths: [] })).fileNames).map(item => item.path), [path], '替换文件身份来自原生声明，不按后缀猜测');
        assert.equal((await f.api.prepare('Example', '测试替换异常', { paths: [path] })).files[0].content, '<<print broken()>>');
    }

    for (const path of ['../patch.txt', '/patch.txt', 'C:/patch.txt', 'patch\\file.txt', 'boot.json', '', null, 3]) {
        const f = fixture({ boot: { scriptFileList: [], styleFileList: [], addonPlugin: [
            { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ replaceFile: path }] },
        ] } });
        await assert.rejects(f.api.prepare('Example', '', { paths: [] }), error =>
            error.message.includes('addonPlugin[0].params[0].replaceFile') && error.message.includes(JSON.stringify(path)));
        assert.equal(f.state.requests.length, 0);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const missingPath = 'game/missing-replacement.txt';
        const f = fixture({ boot: { scriptFileList: [], styleFileList: [], addonPlugin: [
            { modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [{ replaceFile: missingPath }] },
        ] } });
        await assert.rejects(f.api.prepare('Example', '', { paths: [] }), error =>
            error.message.includes('addonPlugin[0].params[0].replaceFile') && error.message.includes(missingPath));
    }
    for (const endpoint of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1/chat/completions', 'http://[::1]:1234/v1']) {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        await f.api.analyze(prepared, { ...f.connection, endpoint, key: '' });
        assert.ok(!('Authorization' in f.state.requests[0].request.headers));
    }

    {
        const f = fixture();
        for (const paths of [['boot.json'], ['../javascript/example.js'], ['javascript/example.js', 'javascript/example.js']]) {
            await assert.rejects(f.api.prepare('Example', '测试错误', { paths }), /路径/);
        }
        const empty = await f.api.prepare('Example', '');
        await assert.rejects(f.api.analyze(empty, f.connection), /描述实际现象/);
        const altered = await f.api.prepare('Example', '测试错误');
        altered.material = '其他内容';
        await assert.rejects(f.api.analyze(altered, f.connection), /材料已改变/);
        assert.equal(f.state.requests.length, 0);
    }

    for (const change of [
        { path: 'boot.json', before: 'Example', after: 'NewName', reason: '更名' },
        { path: '../example.js', before: 'broken()', after: 'working()', reason: '越界' },
        { path: 'javascript/example.js', before: '', after: 'working()', reason: '空匹配' },
        { path: 'javascript/example.js', before: 'missing()', after: 'working()', reason: '原文不存在' },
        { path: 'javascript/example.js', before: 'broken()', after: 'broken()', reason: '没有修改' },
    ]) {
        const f = fixture();
        f.state.answer.changes = [change];
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection));
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture({ files: { 'javascript/example.js': 'broken(); broken();', 'style/example.css': '' } });
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), /唯一/);
        const overlap = fixture();
        overlap.state.answer.changes.push({ path: 'javascript/example.js', before: 'value = broken()', after: 'value = 2', reason: '重叠' });
        await assert.rejects(overlap.api.analyze(await overlap.api.prepare('Example', '测试错误'), overlap.connection), /重叠/);
        const multiple = fixture();
        multiple.state.answer.changes.push({ path: 'javascript/example.js', before: 'other = 1', after: 'other = 2', reason: '独立片段' });
        const plan = await multiple.api.analyze(await multiple.api.prepare('Example', '测试错误'), multiple.connection);
        assert.equal(JSON.parse(new TextDecoder().decode(plan.data))['javascript/example.js'], 'const value = working();\nconst other = 2;');
    }

    {
        const f = fixture();
        f.state.answer.changes = [];
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection);
        assert.equal(plan.data, null);
        assert.ok(plan.summary);
        assert.equal((await f.api.apply(plan)).ok, false);
        assert.equal(f.state.writes.length, 0);
        const many = fixture();
        many.state.answer.changes = Array.from({ length: 9 }, () => many.state.answer.changes[0]);
        await assert.rejects(many.api.analyze(await many.api.prepare('Example', '测试错误'), many.connection), /结构/);
    }

    {
        const f = fixture({ files: { 'javascript/example.js': 'x'.repeat(256 * 1024 + 1), 'style/example.css': 'body {}' } });
        assert.equal((await f.api.prepare('Example', '', { paths: [] })).files.length, 0);
        await assert.rejects(f.api.prepare('Example', '测试错误'), /256 KiB/);
        assert.equal((await f.api.prepare('Example', '测试错误', { paths: ['style/example.css'] })).files.length, 1);
        const files = Object.fromEntries(Array.from({ length: 21 }, (_, index) => ['javascript/' + index + '.js', 'x']));
        const many = fixture({ files, boot: { scriptFileList: Object.keys(files), styleFileList: [] } });
        await assert.rejects(many.api.prepare('Example', '测试错误'), /20 个/);
        const total = fixture({ files: { 'a.js': 'x'.repeat(256 * 1024), 'b.js': 'x'.repeat(256 * 1024), 'c.js': 'x' }, boot: { scriptFileList: ['a.js', 'b.js', 'c.js'], styleFileList: [] } });
        await assert.rejects(total.api.prepare('Example', '测试错误'), /512 KiB/);
    }

    for (const mutation of [f => f.state.disabled.push('Other'), f => { f.state.data = encode({ 'javascript/example.js': 'changed', 'style/example.css': '' }); }, async f => { await f.api.prepare('Example', '新检查'); }]) {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        await mutation(f);
        await assert.rejects(f.api.analyze(prepared, f.connection), /改变|过期/);
        assert.equal(f.state.requests.length, 0);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        let complete;
        let started;
        const fetching = new Promise(resolve => { started = resolve; });
        f.sb.fetch = () => new Promise(resolve => { complete = resolve; started(); });
        const pending = f.api.analyze(prepared, f.connection);
        await fetching;
        f.state.disabled.push('Other');
        complete({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.state.answer) } }] }) });
        await assert.rejects(pending, /改变/);
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(f.api.analyze(prepared, { ...f.connection, signal: controller.signal }), /取消/);
        assert.equal(f.state.requests.length, 0);
        let started;
        const fetching = new Promise(resolve => { started = resolve; });
        f.sb.fetch = async (_url, request) => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('中止')));
            started();
        });
        const controller2 = new AbortController();
        const pending = f.api.analyze(prepared, { ...f.connection, signal: controller2.signal });
        await fetching;
        controller2.abort();
        await assert.rejects(pending, /取消/);
        const timeout = fixture();
        let timeoutStarted;
        const timeoutFetching = new Promise(resolve => { timeoutStarted = resolve; });
        timeout.sb.fetch = async (_url, request) => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('中止')));
            timeoutStarted();
        });
        const timed = timeout.api.analyze(await timeout.api.prepare('Example', '测试错误'), timeout.connection);
        await timeoutFetching;
        timeout.state.timers[0]();
        await assert.rejects(timed, /90 秒/);
    }

    for (const timeout of [false, true]) {
        const f = fixture();
        const prepared = await f.api.prepare('Example', '测试错误');
        const originalHash = f.sb.modHubAiPackage.hash;
        let complete;
        let started;
        const hashing = new Promise(resolve => { started = resolve; });
        f.sb.modHubAiPackage.hash = async data => {
            const result = await originalHash(data);
            if (!new TextDecoder().decode(data).includes('working()')) return result;
            return new Promise(resolve => { complete = () => resolve(result); started(); });
        };
        const controller = new AbortController();
        const pending = f.api.analyze(prepared, { ...f.connection, signal: controller.signal });
        await hashing;
        if (timeout) f.state.timers[0]();
        else controller.abort();
        complete();
        await assert.rejects(pending, timeout ? /90 秒/ : /已取消分析/, '修复包摘要等待期间取消或超时，不能返回可应用计划');
        assert.equal(f.state.writes.length, 0);
        assert.deepEqual(f.state.clearedTimers, [1]);
    }

    for (const response of [
        { ok: false, status: 401, text: async () => 'private-test-key-12345' },
        { ok: true, text: async () => '{"not-valid":true}' },
        { ok: true, text: async () => 'x'.repeat(1024 * 1024 + 1) },
        { ok: true, text: async () => 'private-test-key-12345' },
    ]) {
        const f = fixture();
        f.sb.fetch = async () => response;
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), error => !error.message.includes(f.connection.key));
        assert.equal(f.state.writes.length, 0);
    }

    {
        const f = fixture();
        const response = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.state.answer) } }] }));
        let cancelCount = 0;
        let index = 0;
        f.sb.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => index++ === 0 ? { done: false, value: response.slice(0, 31) }
            : index === 2 ? { done: false, value: response.slice(31) } : { done: true }, cancel: async () => { cancelCount++; } }) } });
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection);
        assert.ok(plan.data);
        assert.equal(cancelCount, 1);
        index = 0;
        f.sb.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(600 * 1024) }), cancel: async () => { cancelCount++; } }) } });
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), /1 MiB/);
        assert.equal(cancelCount, 2);
        f.sb.fetch = async () => ({ ok: true, headers: { get: () => String(2 * 1024 * 1024) }, text: async () => { throw new Error('不应读取超限响应'); } });
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), /1 MiB/);
    }

    {
        const f = fixture({ files: { 'javascript/example.js': 'const value = "private-test-key-12345";', 'style/example.css': '' } });
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection), /包含 API 密钥/);
        assert.equal(f.state.requests.length, 0);
        const network = fixture();
        network.sb.fetch = async () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(network.api.analyze(await network.api.prepare('Example', '测试错误'), network.connection), /CORS/);
        network.sb.fetch = async () => { throw new TypeError(network.connection.key); };
        await assert.rejects(network.api.analyze(await network.api.prepare('Example', '测试错误'), network.connection), error => !error.message.includes(network.connection.key));
    }

    {
        const f = fixture();
        const calls = [];
        f.sb.fetch = async (url, request) => {
            calls.push({ url, request, body: JSON.parse(request.body) });
            return calls.length === 1 ? { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Unsupported parameter: response_format', param: 'response_format', code: 'unsupported_parameter' } }) }
                : { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.state.answer) } }] }) };
        };
        const plan = await f.api.analyze(await f.api.prepare('Example', '核对不支持 JSON 输出参数的网关。'), f.connection);
        assert.ok(plan.data);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
        assert.equal(calls[1].body.response_format, undefined);
        const { response_format, ...original } = calls[0].body;
        assert.deepEqual(calls[1].body, original, '安全降级只移除拒绝的参数，沿用同一材料、模型、取消和密钥');
        assert.equal(calls[0].request.signal, calls[1].request.signal);
        assert.deepEqual(f.state.timerDelays, [90000], '参数降级与首请求共用一次超时预算');
    }

    for (const error of [
        { message: 'Unknown model: missing-model', code: 'invalid_model' },
        { message: 'Account quota exhausted', code: 'insufficient_quota' },
        { message: 'Invalid response_format JSON value', code: 'invalid_value', param: 'response_format' },
    ]) {
        const f = fixture();
        let calls = 0;
        f.sb.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => JSON.stringify({ error }) }; };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '核对服务拒绝原因。'), f.connection), result => result.message.includes(error.message) && !result.message.includes('CORS'));
        assert.equal(calls, 1, '模型、额度或错误参数值不触发兼容重试');
        await assert.rejects(f.api.testConnection(f.connection), result => result.code === 'MODHUB_AI_HTTP' && result.message.includes(error.message));
        assert.equal(calls, 2);
    }

    {
        const f = fixture();
        let calls = 0;
        f.sb.fetch = async () => { calls++; return { ok: false, status: 422, text: async () => JSON.stringify({ error: { message: 'response_format is not supported' } }) }; };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '网关反复拒绝参数。'), f.connection), /HTTP 422.*not supported/);
        assert.equal(calls, 2, '明确拒绝参数最多降级一次，第二次拒绝不会再发请求');
    }

    for (const key of ['', 'private-test-key-12345']) {
        const f = fixture();
        f.sb.location = { protocol: 'file:', origin: 'null' };
        let calls = 0;
        f.sb.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
        const connection = { ...f.connection, key };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '核对跨域失败。'), connection), error => /CORS/.test(error.message)
            && /Origin: null/.test(error.message) && /OPTIONS.*POST.*Content-Type/.test(error.message)
            && error.message.includes('Authorization') === Boolean(key));
        assert.equal(calls, 1, 'CORS 失败不会尝试兼容参数或重复联网');
        await assert.rejects(f.api.testConnection(connection), /CORS.*Origin: null/);
        assert.equal(calls, 2);
    }

    {
        const f = fixture();
        f.sb.modHubAiPackage.replace = async () => { throw new TypeError('本地包体替换内容类型无效'); };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '核对本地业务错误。'), f.connection), error => /本地包体替换内容类型无效/.test(error.message) && !/CORS/.test(error.message));
        f.sb.fetch = async () => ({ ok: true, status: 200, text: async () => { throw new TypeError('响应读取器类型无效'); } });
        await assert.rejects(f.api.testConnection(f.connection), error => /响应读取器类型无效/.test(error.message) && !/CORS/.test(error.message));
    }

    {
        const f = fixture();
        const controller = new AbortController();
        let calls = 0;
        f.sb.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => { controller.abort(); return JSON.stringify({ error: { message: 'unsupported response_format' } }); } }; };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '参数降级前取消。'), { ...f.connection, signal: controller.signal }), /取消/);
        assert.equal(calls, 1, '校验错误响应期间取消，不发送参数降级请求');
    }

    {
        const f = fixture();
        let calls = 0;
        f.sb.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'unsupported response_format ' + f.connection.key } }) }; };
        await assert.rejects(f.api.analyze(await f.api.prepare('Example', '错误正文包含密钥。'), f.connection), error => /包含 API 密钥/.test(error.message) && !error.message.includes(f.connection.key));
        assert.equal(calls, 1, 'HTTP 错误正文回显密钥时硬停止，不继续请求');
        f.sb.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid API key; api_key=sk-privatesecret123456; owner=user@example.com' } }) });
        await assert.rejects(f.api.testConnection(f.connection), error => /Invalid API key/.test(error.message)
            && !/privatesecret|user@example.com/.test(error.message));
    }

    for (const mutation of [f => f.state.disabled.push('Other'), (f, plan) => { plan.diff = '未展示的不同改动'; }, (f, plan) => { plan.data[0] ^= 1; },
        (f, plan) => { plan.mode = 'advice'; }, (f, plan) => { plan.notice = '未展示的状态说明'; }]) {
        const f = fixture();
        const plan = await f.api.analyze(await f.api.prepare('Example', '测试错误'), f.connection);
        mutation(f, plan);
        assert.equal((await f.api.apply(plan)).ok, false);
        assert.equal(f.state.writes.length, 0);
    }
};
