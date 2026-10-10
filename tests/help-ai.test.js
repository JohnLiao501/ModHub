// 自有 AI 引导：首次发送与代码应用分别确认，授权范围内可自动接续分析。
const { assert, createBaseSandbox, createStubElement, loadScripts } = require('./helpers');

function fixture(options = {}) {
    const elements = new Map(), calls = [], storage = new Map(options.storage || []);
    const state = { data: new Uint8Array([1]), preparations: [], logPreparations: [], recommendations: [], requests: [], sourcePreparations: [], sourceLocks: [], investigations: [], investigationLocks: [], connectionTests: [], logReads: 0,
        prepareError: options.prepareError || '', connectionSaveError: '', logError: '', prepareLocks: [], focusEvents: [], focusOptions: [], triages: [], fileNodes: [], suggestionNodes: [],
        targets: options.targets ?? [{ name: '测试模组', enabled: true, bootJson: { version: '1.0.0' } }],
        analysis: { lines: options.lines || [], errorMods: options.errorMods || [], matchedIssues: [], errorCount: 0, warnCount: 0 } };
    state.analysis.errorCount = state.analysis.lines.filter(item => item.level === 'error').length;
    state.analysis.warnCount = state.analysis.lines.filter(item => item.level === 'warn').length;
    const container = createStubElement(), host = createStubElement();
    container.isConnected = host.isConnected = true;
    const el = id => {
        if (!elements.has(id)) {
            const element = createStubElement(id.includes('Material') || id.includes('Description') ? 'textarea' : 'button');
            element.focus = settings => { state.focusEvents.push({ id, disabled: element.disabled }); state.focusOptions.push(settings); };
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const fileNames = options.fileNames ?? [{ path: 'script.js', size: 12 }];
    let fileHtml = '';
    Object.defineProperty(el('modHubAiFiles'), 'innerHTML', { get: () => fileHtml, set: value => {
        fileHtml = value;
        state.fileNodes = [...value.matchAll(/<input\b([^>]*)>/g)].map(match => {
            const input = createStubElement('input');
            input.dataset.aiFile = match[1].match(/data-ai-file="([^"]+)"/)?.[1];
            input.checked = /\bchecked\b/.test(match[1]);
            input.disabled = /\bdisabled\b/.test(match[1]);
            if (/data-ai-unavailable/.test(match[1])) input.dataset.aiUnavailable = '';
            return input;
        });
    } });
    let suggestionHtml = '';
    Object.defineProperty(el('modHubAiSuggestionList'), 'innerHTML', { get: () => suggestionHtml, set: value => {
        suggestionHtml = value;
        state.suggestionNodes = [...value.matchAll(/<button\b([^>]*)>/g)].map(match => {
            const button = createStubElement('button');
            button.dataset.aiSuggestion = match[1].match(/data-ai-suggestion="([^"]+)"/)?.[1];
            return button;
        });
    } });
    container.querySelector = selector => selector === '#modHubHelpAi' ? host : el(selector.slice(1));
    host.querySelector = selector => el(selector.slice(1));
    host.querySelectorAll = selector => {
        if (selector === '[data-ai-file]:checked') return state.fileNodes.filter(input => input.checked);
        if (selector === '[data-ai-unavailable]') return state.fileNodes.filter(input => 'aiUnavailable' in input.dataset);
        if (selector === 'button, input, select, textarea:not([readonly])') return [
            ...['Settings', 'SettingsSave', 'SettingsTest', 'SettingsCancel', 'SettingsBack', 'Start', 'Target', 'Description', 'Endpoint', 'Model', 'Key', 'RememberMe', 'MaxRounds', 'UnlimitedRounds', 'AutoContinue', 'Prepare', 'Refresh', 'Preview', 'Analyze', 'Back', 'Apply', 'Continue', 'DescribeMore', 'Retry', 'LocalRepair', 'Reload', 'Verified', 'Undo', 'Again', 'Last', 'Cancel'].map(id => el('modHubAi' + id)), ...state.fileNodes, ...state.suggestionNodes,
        ];
        return [];
    };
    const plan = { name: '测试模组', summary: '<img src=x onerror=1>', evidence: '具体依据', verification: '重新打开页面',
        changes: [{ path: 'script.js', before: '旧原文', after: '新原文', reason: '修正' }], diff: '<script>纯文本预览</script>', data: new Uint8Array([1]) };
    const material = (name, description, paths, logError = '', maxRounds = 5) => ({ name, description, bootJson: name ? { name, version: '1.0.0' } : null,
        fileNames: name ? fileNames : [], files: paths.map(path => ({ path, content: '旧原文' })),
        material: JSON.stringify({ name, description, logError, files: paths.map(path => ({ path, content: '旧原文' })), diagnosisContext: { round: 1, maxRounds } }) });
    const sb = createBaseSandbox({
        AbortController,
        modHubEscapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
        modHubAnalyzeLogs: raw => raw.length ? { ...state.analysis, lines: raw.map(item => ({ ...item, files: options.selectedFiles || [] })) } : state.analysis,
        modHubGetRawModLoaderLogs: () => { state.logReads++; return []; },
        modHubAiRepair: {
            maxRounds: 5,
            normalizeMaxRounds: value => {
                if (value === undefined) return 5;
                if (!Number.isSafeInteger(value) || value < 0) throw new Error('分析轮次必须为非负整数；填写 0 表示不限轮次。');
                return value;
            },
            validateConnection: connection => {
                calls.push('校验设置');
                if (options.settingsError || !connection.endpoint || !connection.model) throw new Error(options.settingsError || '请先填写 API 地址和模型');
                assert.equal(typeof connection.key, 'string');
                return connection.endpoint;
            },
            testConnection: async connection => {
                calls.push('测试连接'); state.connectionTests.push({ ...connection });
                return options.connectionTest ? options.connectionTest(connection) : { model: connection.model };
            },
            listTargets: async () => { calls.push('读取清单'); return state.targets; },
            recommendFiles: (prepared, lines) => {
                calls.push('推荐文件'); state.recommendations.push({ prepared, lines });
                return options.recommendation || { paths: fileNames.map(item => item.path), reason: '已根据问题和日志整理相关文件。' };
            },
            prepare: async (name, description, data) => {
                calls.push('准备:' + data.paths.length);
                state.preparations.push({ name, description, paths: [...data.paths], logError: data.logError, maxRounds: data.maxRounds });
                state.prepareLocks.push(['Target', 'Description', 'Prepare', 'Preview'].every(id => el('modHubAi' + id).disabled));
                if (state.prepareError || options.sourceError && data.paths.length) throw new Error(state.prepareError || options.sourceError);
                let prepared = material(name, description, data.paths, data.logError, data.maxRounds);
                if (data.includeSources) prepared = withSourceCatalog(prepared, options.sourceCatalog || state.targets.map(target => ({ name: target.name, files: fileNames })));
                return options.prepare ? options.prepare(prepared, data) : prepared;
            },
            prepareLogs: async (description, { logError = '', includeSources = false, onProgress, maxRounds } = {}) => {
                calls.push('准备日志'); state.logPreparations.push({ description, logError, includeSources, maxRounds });
                if (state.logError) throw new Error(state.logError);
                const prepared = material('', description, [], logError, maxRounds);
                return options.prepareLogs ? options.prepareLogs(prepared, { logError, includeSources, onProgress, maxRounds }) : prepared;
            },
            prepareRequestedSources: async requestedPlan => {
                calls.push('读取请求源码'); state.sourcePreparations.push(requestedPlan);
                state.sourceLocks.push({ controls: ['Continue', 'Target', 'Description', 'Analyze', 'Apply', 'Settings', 'Retry'].every(id => el('modHubAi' + id).disabled),
                    progress: !el('modHubAiProgress').hidden });
                const previous = state.requests.at(-1).prepared;
                let prepared = material(requestedPlan.readRequest.name, previous.description, requestedPlan.readRequest.paths, JSON.parse(previous.material).logError);
                const context = JSON.parse(previous.material).diagnosisContext;
                prepared.material = JSON.stringify({ ...JSON.parse(prepared.material), diagnosisContext: { ...context, round: context.round + 1 } });
                if (previous.sourceCatalog?.length) prepared = withSourceCatalog(prepared, previous.sourceCatalog);
                return options.prepareRequestedSources ? options.prepareRequestedSources(requestedPlan, prepared) : prepared;
            },
            prepareInvestigation: async previousPlan => {
                calls.push('继续定位'); state.investigations.push(previousPlan);
                state.investigationLocks.push({ controls: ['Continue', 'Target', 'Description', 'Analyze', 'Apply', 'Settings', 'Retry'].every(id => el('modHubAi' + id).disabled),
                    progress: !el('modHubAiProgress').hidden });
                const previous = state.requests.at(-1).prepared;
                const context = JSON.parse(previous.material).diagnosisContext;
                const sourceCatalog = options.sourceCatalog ?? [{ name: '测试模组', version: '1.0.0', files: fileNames }];
                const sourceUnavailable = options.sourceUnavailable ?? [];
                const prepared = material('', previous.description, [], JSON.parse(previous.material).logError);
                const next = previousPlan.responseCorrection ? { ...previous,
                    material: JSON.stringify({ ...JSON.parse(previous.material), diagnosisContext: { ...context, round: context.round + 1,
                        responseCorrection: true, validationFeedback: previousPlan.validationFeedback } }) } : { ...prepared, sourceCatalog, sourceUnavailable,
                    material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog, sourceUnavailable,
                        diagnosisContext: { ...context, round: context.round + 1, summary: previousPlan.summary, evidence: previousPlan.evidence, verification: previousPlan.verification, history: [previousPlan.summary] } }) };
                return options.prepareInvestigation ? options.prepareInvestigation(previousPlan, next) : next;
            },
            prepareTriage: async previousPlan => {
                calls.push('自动核对来源'); state.triages.push(previousPlan);
                const previous = state.requests.at(-1).prepared;
                const body = JSON.parse(previous.material);
                const sourceEvidence = [...body.sourceEvidence || [], ...previous.files.map(file => ({ ...file, name: previous.name, offset: 0, incomplete: false, writable: false }))];
                const next = { ...previous, name: '', files: [], material: JSON.stringify({ ...body, name: '', files: [], sourceEvidence,
                    repairIntent: 'select-code-repair', diagnosisContext: { ...body.diagnosisContext, round: (body.diagnosisContext?.round || 1) + 1, summary: previousPlan.summary } }) };
                return options.prepareTriage ? options.prepareTriage(previousPlan, next) : next;
            },
            analyze: async (prepared, connection) => {
                calls.push('请求'); state.requests.push({ prepared, connection });
                assert.equal(connection.key, options.key ?? '仅内存密钥');
                if (options.analyze) return options.analyze(connection, prepared);
                return prepared.files.length ? plan : { ...plan, name: '', changes: [], diff: '', data: null };
            },
            apply: async value => { calls.push('应用'); assert.equal(value, plan); return options.result || { ok: true, pointId: '修复前点' }; },
        },
        modHubConfirm: async prompt => { calls.push('确认'); assert.match(prompt.message, /script\.js/); return options.confirm !== false; },
        modHubRestore: { restore: async id => { calls.push('还原:' + id); return options.restore === true; } },
        modHubAiPackage: { hash: async data => Array.from(data).join(',') },
        modHubReadInstalledModPackage: async () => ({ data: state.data }),
        modHubOpenManager: tab => { calls.push('导航:' + tab); return options.navigation !== false; },
        modHubOfferReload: async () => { calls.push('提示重载'); },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => {
            if (key === 'modhub_ai_connection' && state.connectionSaveError) throw new Error(state.connectionSaveError);
            storage.set(key, value);
        }, removeItem: key => storage.delete(key) },
    });
    sb.document.getElementById = id => id === 'modHubHelpContainer' ? container : el(id);
    const confirm = sb.modHubConfirm;
    loadScripts(sb, ['javascript/modhub-dialog.js', 'javascript/modhub-help.js']);
    sb.modHubConfirm = confirm;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const init = async () => {
        sb.modHubHelp.init(); await settle();
        // 既有用例明确关闭自动接续，保持逐轮手动确认的完整回归。
        el('modHubAiAutoContinue').checked = options.autoContinue === true;
        el('modHubAiAutoContinue').onchange?.();
    };
    const choose = index => el('modHubAiSuggestionList').onclick({ target: { closest: selector => {
        assert.equal(selector, '[data-ai-suggestion]');
        return state.suggestionNodes[index];
    } } });
    return { sb, calls, storage, state, container, host, plan, el: id => el('modHubAi' + id), init, settle, choose };
}

function configure(f, remember = false, maxRounds) {
    f.el('Settings').onclick();
    f.el('Endpoint').value = 'https://example.test/v1'; f.el('Endpoint').oninput();
    f.el('Model').value = 'model'; f.el('Model').oninput();
    f.el('Key').value = '仅内存密钥'; f.el('Key').oninput();
    f.el('RememberMe').checked = remember; f.el('RememberMe').onchange();
    if (maxRounds === 0) { f.el('UnlimitedRounds').checked = true; f.el('UnlimitedRounds').onchange(); }
    else if (maxRounds !== undefined) { f.el('MaxRounds').value = String(maxRounds); f.el('MaxRounds').oninput(); }
    f.el('SettingsSave').onclick();
}
async function start(f, description = '打开页面时出错') {
    f.el('Description').value = description; f.el('Description').oninput();
    await f.el('Start').onclick();
}
function assertCollapsedDetails(html, message) {
    const tags = [...html.matchAll(/<details\b([^>]*)>/g)];
    assert.ok(tags.length, message);
    tags.forEach(tag => assert.doesNotMatch(tag[1], /\bopen\b/, message));
}
function withSourceCatalog(prepared, sourceCatalog) {
    return { ...prepared, sourceCatalog, sourceUnavailable: [],
        material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog, sourceUnavailable: [] }) };
}

module.exports = async function() {
    // 底部导航随步骤显示，历史入口保留原有条件，不在空状态留下操作栏。
    {
        const f = fixture(); await f.init();
        assert.equal(f.el('Footer').hidden, true); assert.equal(f.el('Navigation').hidden, true);
        await start(f, '保留这段问题描述');
        assert.equal(f.el('Footer').hidden, false); assert.equal(f.el('Navigation').hidden, false);
        assert.equal(f.el('Last').hidden, true);
        assert.match(f.host.innerHTML, /id="modHubAiBack" class="macro-button modhub-btn-primary"/);
        f.el('Back').onclick();
        assert.equal(f.el('Description').value, '保留这段问题描述'); assert.equal(f.el('Footer').hidden, true);
        await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.el('Step3').hidden, false); assert.equal(f.el('Footer').hidden, true);
        await f.el('Apply').onclick();
        assert.equal(f.el('Step4').hidden, false); assert.equal(f.el('Footer').hidden, true);
        await f.init();
        assert.equal(f.el('Footer').hidden, false); assert.equal(f.el('Navigation').hidden, true);
        assert.equal(f.el('Last').hidden, false);
    }
    {
        const f = fixture(); await f.init();
        assert.deepEqual(f.calls, [], '首屏不读取包体或发送请求');
        assert.match(f.host.innerHTML, /需要什么帮助/);
        assert.match(f.host.innerHTML, /描述问题.*确认分析.*查看方案.*重载验证/);
        assert.match(f.container.innerHTML, /使用声明、数据与撤销范围/);
        assert.match(f.container.innerHTML, /发送内容.*密钥保存.*应用修改.*验证与撤销/);
        assert.doesNotMatch(f.host.innerHTML, /modHubAiConsent/, '明确发送按钮即表达同意，不增加重复复选框');
        const workflow = f.host.innerHTML.indexOf('id="modHubAiWorkflow"');
        assert.ok(f.host.innerHTML.indexOf('id="modHubAiKey"') < workflow, '连接设置独立于分析工作流');
        const rememberTag = f.host.innerHTML.match(/<input\b[^>]*\bid="modHubAiRememberMe"[^>]*>/)?.[0];
        assert.ok(rememberTag); assert.match(rememberTag, /type="checkbox"/); assert.match(f.host.innerHTML, /记住我/);
        const settingsPanel = f.host.innerHTML.match(/<section\b[^>]*id="modHubAiSettingsPanel"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '';
        assert.ok(settingsPanel.includes('勾选并保存后，下次自动填入密钥。取消勾选并保存可移除。请仅在可信设备使用。'), '记住密钥说明使用精简保存与移除文案');
        assert.ok(settingsPanel.includes('测试不发送问题、日志或源码，可能产生少量费用。保存设置不会发送请求。'), '连接测试和保存影响使用简洁独立文案');
        const riskDetails = settingsPanel.match(/<details\b([^>]*)>([\s\S]*?)<\/details>/);
        assert.ok(riskDetails, '共享运行环境的密钥读取说明放在原生附加折叠区');
        assert.doesNotMatch(riskDetails[1], /\bopen\b/, '附加密钥说明默认收起');
        assert.match(riskDetails[2], /其他模组[\s\S]*读取|共享运行环境/);
        assert.match(riskDetails[2], /读取[\s\S]*密钥|密钥[\s\S]*读取/);
        assert.equal(f.el('RememberMe').checked, false, '首次使用默认不记住密钥');
        const maxRoundsTag = f.host.innerHTML.match(/<input\b[^>]*\bid="modHubAiMaxRounds"[^>]*>/)?.[0];
        assert.ok(maxRoundsTag); assert.match(maxRoundsTag, /type="number"/); assert.match(maxRoundsTag, /min="1"/); assert.match(maxRoundsTag, /step="1"/);
        assert.doesNotMatch(maxRoundsTag, /\bmax\s*=/, '轮次设置不限制最高值'); assert.equal(f.el('MaxRounds').value, 5);
        const unlimitedTag = settingsPanel.match(/<input\b[^>]*\bid="modHubAiUnlimitedRounds"[^>]*>/)?.[0];
        assert.match(unlimitedTag, /type="checkbox"/); assert.match(settingsPanel, />不限轮次<\/label>/);
        assert.doesNotMatch(settingsPanel + f.container.innerHTML, /0 表示不限轮次/);
        assert.equal(f.el('UnlimitedRounds').checked, false, '新配置默认不勾选不限轮次'); assert.equal(f.el('MaxRounds').disabled, false);
        assert.equal(f.el('RoundsNotice').hidden, true, '默认五轮不显示较多轮次的 Token 提示');
        assert.match(settingsPanel, /Token 消耗[\s\S]*输入和输出 Token[\s\S]*源码与累计分析历史[\s\S]*可随时取消/);
        const descriptionTag = f.host.innerHTML.match(/<textarea\b[^>]*\bid="modHubAiDescription"[^>]*>/)?.[0];
        assert.ok(descriptionTag); assert.doesNotMatch(descriptionTag, /\bmaxlength\s*=/i);
        const review = f.host.innerHTML.slice(f.host.innerHTML.indexOf('id="modHubAiStep2"'), f.host.innerHTML.indexOf('id="modHubAiStep3"'));
        assert.match(review, /<h3>将发送哪些信息<\/h3>/);
        const primaryButtons = [...review.matchAll(/<button\b[^>]*class="[^"]*modhub-btn-primary[^"]*"[^>]*>/g)];
        assert.equal(primaryButtons.length, 1, '确认页只保留一个发送主操作'); assert.match(primaryButtons[0][0], /id="modHubAiAnalyze"/);
        assertCollapsedDetails(review, '确认页的问题、完整材料与技术选项默认收起');
        assert.match(review, /<details\b[^>]*><summary>您描述的问题<\/summary><p\b[^>]*id="modHubAiProblem"/);
        assert.match(review, /<details\b[^>]*id="modHubAiScopeDetails"[\s\S]*id="modHubAiSelectionReason"/, '完整选材理由保留在高级选项');
        const describeMoreTag = f.host.innerHTML.match(/<button\b[^>]*\bid="modHubAiDescribeMore"[^>]*>[^<]*<\/button>/)?.[0];
        const localRepairTag = f.host.innerHTML.match(/<button\b[^>]*\bid="modHubAiLocalRepair"[^>]*>[^<]*<\/button>/)?.[0];
        assert.match(describeMoreTag, />调整问题说明（可选）<\/button>/); assert.doesNotMatch(describeMoreTag, /modhub-btn-primary/, '调整问题是可选辅助操作');
        assert.match(localRepairTag, /modhub-btn-primary/, '没有代码方案时优先引导已有配置检查');
        assert.equal(f.el('Analyze').disabled, true);
        await start(f);
        assert.deepEqual(f.calls, ['读取清单', '准备:0', '推荐文件', '准备:1'], '获取帮助一次完成清单、文件定位与本地预览');
        assert.equal(f.el('Target').value, '测试模组');
        assert.equal(f.el('Step2').hidden, false);
        assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.el('MaterialDetails').open, false, '完整材料默认折叠');
        assert.match(f.el('SelectionSummary').textContent, /^1 个相关文件/);
        assert.match(f.el('SelectionReason').textContent, /已根据问题和日志整理相关文件/);
        assertCollapsedDetails(f.el('LogSummary').innerHTML, '日志线索默认折叠，主摘要只显示错误与警告数量');
        assert.match(f.el('LogSummary').innerHTML, /^<details\b[^>]*><summary>加载日志：0 条错误，0 条警告<\/summary>/);
        assert.deepEqual(JSON.parse(f.el('Material').value).files, [{ path: 'script.js', content: '旧原文' }]);
        assert.deepEqual(JSON.parse(f.el('Material').value).diagnosisContext, { round: 1, maxRounds: 5 });
        assert.ok(f.state.preparations.every(item => item.maxRounds === 5), '清单与完整源码准备均接收默认轮次预算');
        assert.ok(!f.calls.includes('请求'));
        assert.deepEqual(f.state.focusEvents.at(-1), { id: 'modHubAiStatus', disabled: false });
        assert.equal(f.state.focusOptions.at(-1)?.preventScroll, true, '获取帮助聚焦顶部状态，不能滚动到发送按钮');
        assert.ok(f.state.prepareLocks.every(Boolean));
        await f.el('Analyze').onclick();
        assert.equal(f.el('SettingsPanel').hidden, false, '未配置连接时直接引导设置，不要求重新描述问题');
        assert.equal(f.el('Step2').hidden, false);
        assert.ok(!f.calls.includes('请求'));
        configure(f);
        assert.ok(!JSON.stringify([...f.storage]).includes('仅内存密钥'));
        await f.el('Analyze').onclick();
        assert.equal(f.calls.filter(call => call === '请求').length, 1);
        assert.match(f.el('Advice').innerHTML, /&lt;img/); assert.doesNotMatch(f.el('Advice').innerHTML, /<img/);
        assert.match(f.el('Advice').innerHTML, /找到待确认的代码修改/);
        assert.doesNotMatch(f.el('Advice').innerHTML, /具体依据|重新打开页面/, '主结果只呈现结论，依据和验证说明移至折叠详情');
        assert.ok(f.el('AdviceDetails').innerHTML.includes('具体依据') && f.el('AdviceDetails').innerHTML.includes('重新打开页面'));
        assertCollapsedDetails(f.el('AdviceDetails').innerHTML, '结果的依据与验证说明默认收起');
        assert.equal(f.el('Continue').hidden, true); assert.equal(f.el('Apply').hidden, false, '代码方案只显示一个可执行的主操作');
        assert.equal(f.el('Diff').value, '<script>纯文本预览</script>');
        assert.equal(f.el('Diff').hidden, false, '结构化修改继续显示原文差异');
        assert.ok(!f.calls.includes('应用'));
        await f.el('Apply').onclick();
        assert.deepEqual(f.calls.slice(-2), ['确认', '应用']);
        assert.match(f.el('Saved').textContent, /等待重新载入并验证/);
        assert.ok(!f.calls.includes('提示重载'));
        await f.el('Reload').onclick(); await f.el('Undo').onclick();
        assert.ok(f.calls.includes('还原:修复前点')); assert.match(f.el('Status').textContent, /已取消还原/);
        f.el('Verified').onclick();
        assert.equal(JSON.parse(f.storage.get('modhub_ai_last_repair')).verified, true);
    }
    {
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }],
            errorMods: ['乙'], lines: [{ level: 'error', message: '[乙] script.js 中出现错误' }] });
        await f.init(); await start(f);
        assert.equal(f.el('Target').value, '乙', '唯一日志技术名优先关联');
        assert.ok(f.state.preparations.every(item => item.name === '乙')); assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }], errorMods: ['市场昵称'] });
        await f.init(); await start(f);
        assert.equal(f.el('Target').value, '', '不能以昵称猜测责任模组');
        assert.equal(f.state.preparations.length, 0); assert.equal(f.state.logPreparations.length, 1);
        assert.equal(f.state.logPreparations[0].includeSources, true, '帮助界面默认日志材料包含可继续核对的本地源码清单');
        assert.equal(f.state.logPreparations[0].maxRounds, 5, '日志准备也携带同一轮次预算');
        assert.equal(f.el('SelectionSummary').textContent, '本次不提供源码。');
        assert.match(f.el('SelectionReason').textContent, /不提供源码.*仅给出排查建议/);
        assert.equal(f.el('Analyze').disabled, false);
        configure(f); await f.el('Analyze').onclick();
        assert.equal(f.el('Apply').hidden, true, '日志分析不展示应用代码按钮');
        assert.match(f.el('Status').textContent, /尚无可应用的代码修改/); assert.match(f.el('Advice').innerHTML, /已获得排查建议/);
        await f.el('Apply').onclick(); assert.ok(!f.calls.includes('应用'));
    }
    {
        const sourceCatalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const sourceUnavailable = [{ name: '<img src=x onerror=1>', reason: '包体读取失败：<script>具体原因</script>' },
            { name: '', reason: '源码清单超限：请减少模组后重新整理。' }];
        const f = fixture({ targets: [], prepareLogs: prepared => ({ ...prepared, sourceCatalog, sourceUnavailable,
            material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog, sourceUnavailable }) }) });
        await f.init(); await start(f);
        assert.equal(f.state.logPreparations[0].includeSources, true);
        assert.deepEqual(JSON.parse(f.el('Material').value).files, [], '源码目录只提供文件信息，不将源码偷偷加入首轮材料');
        assert.deepEqual(JSON.parse(f.el('Material').value).sourceCatalog, sourceCatalog);
        assert.equal(f.el('SelectionSummary').textContent, '已整理文件清单和补丁声明。分析时可补充相关源码。');
        assert.match(f.el('SelectionReason').textContent, /已附可用源码清单.*本次不发送源码/);
        assert.equal(f.el('Error').textContent, '【<img src=x onerror=1>】包体读取失败：<script>具体原因</script>\n源码清单超限：请减少模组后重新整理。');
        assert.equal(f.el('Error').innerHTML, '', '不可用范围及具体原因只能写入纯文本详情');
        assert.equal(f.el('ErrorDetails').hidden, false); assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.state.requests.length, 0); assert.ok(!f.calls.includes('应用'));
    }
    {
        let resolve, progress;
        const f = fixture({ targets: [], prepareLogs: (prepared, data) => {
            progress = data.onProgress;
            return new Promise(done => { resolve = () => done(prepared); });
        } });
        await f.init(); const pending = start(f); await f.settle();
        assert.equal(typeof progress, 'function'); assert.equal(f.state.logPreparations[0].includeSources, true);
        progress('测试模组');
        assert.equal(f.el('Status').textContent, '正在核对已安装模组的源码清单；尚未发送。');
        assert.equal(f.el('Progress').hidden, false); assert.equal(f.el('Start').disabled, true);
        await f.init(); const status = f.el('Status').textContent, material = f.el('Material').value;
        progress('<img src=x onerror=1>'); resolve(); await pending;
        assert.equal(f.el('Status').textContent, status, '旧目录读取进度不能覆盖新页面提示');
        assert.equal(f.el('Material').value, material, '旧目录读取结果不能覆盖新页面材料');
        assert.equal(f.el('Step1').hidden, false); assert.equal(f.state.requests.length, 0);
        assert.ok(!f.calls.includes('应用'));
    }
    {
        let resolve;
        const request = { mode: 'source-request', name: '', summary: '需要读取相关源码后生成修复方案', evidence: '日志只提供了错误位置', verification: '重新执行原操作',
            readRequest: { name: '测试模组', paths: ['script.js'], reason: '<img src=x onerror="window.fake=1">\n需要核对 <<print $原文>> & 原始脚本' },
            changes: [], diff: '', data: null };
        const f = fixture({ targets: [], analyze: (_connection, prepared) => prepared.files.length ? f.plan : request,
            prepareRequestedSources: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f, '读取当前日志后检查这个问题'); configure(f);
        const logs = f.el('Material').value;
        assert.equal(f.state.logPreparations[0].includeSources, true);
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1); assert.equal(f.el('Step3').hidden, false);
        assert.equal(f.el('Continue').hidden, false); assert.equal(f.el('Continue').disabled, false);
        assert.equal(f.el('Continue').textContent, '确认新增材料并继续');
        assert.match(f.el('Advice').innerHTML, /需要读取相关源码/);
        assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(request.readRequest.reason)), '源码读取请求保留依据并转义外部文本');
        assert.ok(f.el('AdviceDetails').innerHTML.includes('测试模组') && f.el('AdviceDetails').innerHTML.includes('script.js'), '继续前可展开查看目标与请求文件');
        assertCollapsedDetails(f.el('AdviceDetails').innerHTML, '读取依据与文件列表默认折叠');
        assert.doesNotMatch(f.el('AdviceDetails').innerHTML, /<img|onerror="window\.fake/);
        assert.match(f.el('NextHint').textContent, /本机整理【测试模组】的 1 个文件.*确认发送/);
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.el('Apply').disabled, true);
        assert.equal(f.state.sourcePreparations.length, 0, '收到源码请求不能自动读取包体');
        assert.equal(f.el('Material').value, logs, '第三步保留已经发送的日志材料');
        const pending = f.el('Continue').onclick(); await f.settle();
        assert.equal(f.state.sourcePreparations.length, 1); assert.equal(f.state.sourcePreparations[0], request);
        assert.deepEqual(f.state.sourceLocks[0], { controls: true, progress: true }, '本地读取期间锁定操作并显示不定进度');
        assert.equal(f.el('Continue').disabled, true); assert.equal(f.el('Progress').hidden, false);
        await f.el('Continue').onclick(); assert.equal(f.state.sourcePreparations.length, 1, '读取期间重复点击不会重复读包');
        assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
        resolve(); await pending;
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Step3').hidden, true);
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.el('Continue').hidden, true, '回到确认分析后不保留旧请求的继续入口');
        assert.deepEqual(JSON.parse(f.el('Material').value).files, [{ path: 'script.js', content: '旧原文' }], '新预览展示实际读取的完整文件');
        assert.equal(f.el('MaterialDetails').open, false);
        assert.equal(f.state.requests.length, 1, '本地读取完成不得自动发送第二次分析请求');
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '本地读取不修改包体或弹出应用确认');
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '再次明确发送后才提交源码材料');
        assert.equal(f.state.requests[1].prepared.files[0].path, 'script.js');
        assert.equal(f.el('Apply').hidden, false); assert.ok(!f.calls.includes('应用'));
        await f.el('Apply').onclick(); assert.deepEqual(f.calls.slice(-2), ['确认', '应用'], '第二次生成的方案沿用确认与受控应用入口');
        assert.match(f.el('Saved').textContent, /修复前还原点：修复前点/);
    }
    {
        let resolve;
        const request = { mode: 'source-request', name: '', summary: '请补充源码', evidence: '缺少源码', verification: '复现问题',
            readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对原脚本' }, changes: [], diff: '', data: null };
        const f = fixture({ targets: [], analyze: async () => request,
            prepareRequestedSources: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        const pending = f.el('Continue').onclick(); await f.settle();
        await f.init(); const status = f.el('Status').textContent, material = f.el('Material').value;
        resolve(); await pending;
        assert.equal(f.el('Status').textContent, status); assert.equal(f.el('Material').value, material, '旧页面读取完成不能覆盖新页面材料');
        assert.equal(f.el('Step1').hidden, false); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用'));
    }
    {
        let resolve;
        const request = { mode: 'source-request', name: '', summary: '取消后迟到的源码请求', evidence: '旧依据', verification: '原问题',
            readRequest: { name: '测试模组', paths: ['script.js'], reason: '旧请求依据' }, changes: [], diff: '', data: null };
        const f = fixture({ targets: [], analyze: () => new Promise(done => { resolve = done; }) });
        await f.init(); await start(f); configure(f); const material = f.el('Material').value;
        const pending = f.el('Analyze').onclick(); await f.settle(); f.el('Cancel').onclick(); resolve(request); await pending;
        assert.equal(f.el('Material').value, material); assert.equal(f.el('Step2').hidden, false);
        assert.equal(f.el('Continue').hidden, true); assert.equal(f.state.sourcePreparations.length, 0);
        assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用'));
        assert.match(f.el('Status').textContent, /已取消分析.*材料仍保留/);
    }
    {
        const advice = { mode: 'advice', name: '', notice: '<img src=x onerror="window.fake=1">\n本次只提供排查建议',
            summary: '<script>来自 AI 的原始正文</script>', evidence: '需要核对 <前置> & 顺序', verification: '按原操作重新检查 "异常"',
            changes: [], diff: '', data: null };
        const f = fixture({ analyze: async () => advice }); await f.init(); await start(f); configure(f);
        await f.el('Analyze').onclick();
        assert.match(f.el('Advice').innerHTML, /<h3>已获得排查建议<\/h3>/, '纯文本建议明确标注为排查建议');
        assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(advice.notice)), '建议模式说明保留并转义');
        assert.ok(f.el('Advice').innerHTML.includes(f.sb.modHubEscapeHtml(advice.summary)), '建议正文按纯文本转义');
        assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(advice.evidence)));
        assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(advice.verification)));
        assertCollapsedDetails(f.el('AdviceDetails').innerHTML, '建议模式的依据、验证与说明均默认折叠');
        assert.doesNotMatch(f.el('Advice').innerHTML + f.el('AdviceDetails').innerHTML, /<img|<script|onerror="window\.fake/);
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.el('Apply').disabled, true);
        assert.equal(f.el('Continue').hidden, true, '普通建议没有明确读取请求时不展示继续生成入口');
        assert.match(f.host.innerHTML, /id="modHubAiRetry"[^>]*>查看分析材料<\/button>/, '普通建议提供查看材料入口');
        assert.equal(f.state.sourcePreparations.length, 0);
        assert.equal(f.el('Diff').hidden, true, '无代码改动时隐藏差异框');
        await f.el('Apply').onclick(); assert.ok(!f.calls.includes('应用')); assert.ok(!f.calls.includes('确认'));
        const material = f.el('Material').value;
        f.el('Retry').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Material').value, material);
        assert.equal(f.state.sourcePreparations.length, 0, '返回材料不会猜测文件或读取源码');
    }
    {
        const summary = '<script>未经确认的模型原文</script>\n' + '完整分析段落'.repeat(60) + '\n全文末尾不得丢失';
        const advice = { mode: 'advice', name: '', summary, evidence: '<img src=x onerror="window.fake=1">\n需要核对的证据原文',
            verification: '按原步骤打开 <<print $衣服.name>>，检查异常 & 结果。', notice: '模型回复仅供核对 <前置>，未确认责任模组。',
            changes: [], diff: '', data: null, canContinue: false,
            continuationReason: '本次定位已达到 12 轮上限。请补充触发步骤：<img src=x onerror=1>。' };
        const f = fixture({ analyze: async () => advice }); await f.init(); await start(f); configure(f);
        Object.defineProperty(f.el('NextHint'), 'innerHTML', { get: () => '', set: () => { throw new Error('停步原因不得注入 HTML'); } });
        await f.el('Analyze').onclick();
        assert.ok(f.el('Advice').innerHTML.includes(f.sb.modHubEscapeHtml(summary.slice(0, 240) + '…')), '长结论主区域展示有限预览');
        assert.doesNotMatch(f.el('Advice').innerHTML, /全文末尾不得丢失|分析依据|需要核对的证据原文/, '主区域不堆叠完整分析和技术依据');
        const details = f.el('AdviceDetails').innerHTML;
        assert.match(details, /^<details\b[^>]*><summary>查看完整分析<\/summary>/);
        assert.ok(details.includes(f.sb.modHubEscapeHtml(summary)), '长模型正文完整保留在可展开区域');
        assert.ok(details.includes(f.sb.modHubEscapeHtml(advice.evidence)));
        assert.ok(details.includes(f.sb.modHubEscapeHtml(advice.verification)));
        assert.ok(details.includes(f.sb.modHubEscapeHtml(advice.notice)));
        assertCollapsedDetails(details, '完整正文、依据、验证与回复说明默认收起');
        assert.doesNotMatch(f.el('Advice').innerHTML + details, /<img|<script|onerror="window\.fake/);
        assert.equal(f.el('NextHint').textContent, advice.continuationReason, '停步原因保留原文且清楚交代下一步');
        assert.equal(f.el('Continue').hidden, true); assert.equal(f.el('Continue').disabled, true);
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.state.investigations.length, 0);
        const material = f.el('Material').value; await f.el('Continue').onclick();
        assert.equal(f.el('Error').textContent, advice.continuationReason, '无接续能力时接口也不得绕过停步原因');
        assert.equal(f.el('Material').value, material); assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.investigations.length, 0); assert.equal(f.state.sourcePreparations.length, 0); assert.ok(!f.calls.includes('应用'));
    }
    {
        let resolve;
        const advice = { mode: 'advice', name: '测试模组', summary: '现有源码不足以确定问题来源，需要核对相关模组。',
            evidence: '本轮仅提供当前模组的声明脚本', verification: '打开同一页面重新检查',
            changes: [], diff: '', data: null, canContinue: true, continuationReason: '还有可核对的声明源码。' };
        const requested = { ...advice, mode: 'source-request', name: '', readRequest: { name: '另一个模组', paths: ['other.js'], reason: '核对另一份声明脚本的调用位置' } };
        const finished = { ...advice, name: '另一个模组', summary: '已核对相关声明源码，请将调用差异交给作者继续排查。',
            canContinue: false, continuationReason: '所有可读取的声明文件已经核对，请补充触发步骤后重新分析。' };
        const original = '  从第一个模组打开服装页时出错\n请继续查找真正的来源  ';
        const f = fixture({ targets: [{ name: '测试模组', enabled: true }, { name: '另一个模组', enabled: true }], errorMods: ['测试模组'],
            sourceCatalog: [{ name: '另一个模组', version: '1.0.0', files: [{ path: 'other.js', size: 12 }] }],
            analyze: (_connection, prepared) => !prepared.files.length ? requested : prepared.name === '另一个模组' ? finished : advice,
            prepareInvestigation: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: [{ path: 'other.js', size: 12 }] }) });
        await f.init(); await start(f, original); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.requests[0].prepared.files[0].path, 'script.js');
        assert.equal(f.el('Continue').hidden, false, '已有源码但没有代码改动时仍可继续查找其它来源');
        assert.equal(f.el('Continue').disabled, false); assert.equal(f.el('Continue').textContent, '继续自动排查');
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.state.investigations.length, 0);
        const material = f.el('Material').value;
        const pending = f.el('Continue').onclick(); await f.settle();
        assert.equal(f.state.investigations[0], advice); assert.deepEqual(f.state.investigationLocks[0], { controls: true, progress: true });
        assert.equal(f.el('Material').value, material, '继续定位完成前保留原始分析材料');
        await f.el('Continue').onclick(); assert.equal(f.state.investigations.length, 1, '本地定位期间重复点击不会再次整理');
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.sourcePreparations.length, 0); assert.ok(!f.calls.includes('应用'));
        resolve(); await pending;
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Analyze').disabled, false);
        const next = JSON.parse(f.el('Material').value);
        assert.equal(next.description, original); assert.deepEqual(next.files, []);
        assert.deepEqual(next.sourceCatalog[0].files, [{ path: 'other.js', size: 12 }]);
        assert.equal(next.diagnosisContext.summary, advice.summary, '继续定位材料保留已有判断供后续核对');
        assert.equal(f.state.requests.length, 1, '继续查找来源只整理本地目录，不自动发送下一轮');
        assert.equal(f.state.sourcePreparations.length, 0, '普通建议不能直接猜测并读取源码');
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2); assert.equal(f.el('Continue').textContent, '确认新增材料并继续');
        await f.el('Continue').onclick();
        assert.equal(f.state.sourcePreparations[0], requested); assert.equal(f.state.requests.length, 2);
        assert.equal(f.el('Target').value, '另一个模组');
        assert.deepEqual(JSON.parse(f.el('Material').value).files, [{ path: 'other.js', content: '旧原文' }]);
        assert.equal(JSON.parse(f.el('Material').value).description, original, '跨包继续核对完整保留原问题');
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.el('NextHint').textContent, finished.continuationReason, '不能再继续时显示具体原因和建议步骤');
        assert.equal(f.el('Apply').hidden, true); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
        const finalMaterial = f.el('Material').value; f.el('Retry').onclick();
        assert.equal(f.el('Material').value, finalMaterial); assert.equal(f.el('Step2').hidden, false);
    }
    {
        const advice = { mode: 'advice', name: '', summary: '需要继续核对相关来源。', evidence: '尚无明确责任模组', verification: '再次复现原问题',
            changes: [], diff: '', data: null, canContinue: true, continuationReason: '还有未核对的声明源码。' };
        let failure = '继续定位失败：<img src=x onerror=1>\n包体已变化，请重新整理材料。';
        const f = fixture({ analyze: async () => advice, prepareInvestigation: (_plan, prepared) => {
            if (failure) throw new Error(failure);
            return prepared;
        } });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        const material = f.el('Material').value;
        Object.defineProperty(f.el('Error'), 'innerHTML', { get: () => '', set: () => { throw new Error('继续定位失败不得注入 HTML'); } });
        await f.el('Continue').onclick();
        assert.equal(f.el('Error').textContent, failure); assert.equal(f.el('Step3').hidden, false);
        assert.equal(f.el('Material').value, material); assert.equal(f.el('Continue').disabled, true);
        assert.equal(f.el('Continue').hidden, true, '读取失败后不继续消费可能已过期的分析计划');
        assert.equal(f.el('LocalRepair').hidden, false);
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用'));
        await f.el('Retry').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Material').value, material, '返回原材料重新确认，不丢失具体问题');
        failure = ''; await f.el('Analyze').onclick(); await f.el('Continue').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.state.requests.length, 2, '重新分析后的本地读取成功仍等待下一次明确发送');
    }
    {
        let resolve;
        const advice = { mode: 'advice', name: '', summary: '继续定位', evidence: '需要补充来源目录', verification: '复现原问题',
            changes: [], diff: '', data: null, canContinue: true, continuationReason: '还有未核对来源。' };
        const f = fixture({ analyze: async () => advice,
            prepareInvestigation: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        const pending = f.el('Continue').onclick(); await f.settle(); await f.init();
        const status = f.el('Status').textContent, material = f.el('Material').value;
        resolve(); await pending;
        assert.equal(f.el('Status').textContent, status); assert.equal(f.el('Material').value, material, '旧定位结果不能覆盖新页面材料');
        assert.equal(f.el('Step1').hidden, false); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用'));
    }
    {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '需要核对声明源码。', evidence: '日志指向 script.js', verification: '重新打开故障页面',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对报错位置' } };
        const phases = [], stages = [];
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (connection, prepared) => {
                connection.onProgress('request'); phases.push(f.el('Status').textContent);
                stages.push({ confirmation: !f.el('Step2').hidden, results: !f.el('Step3').hidden });
                return prepared.files.length ? f.plan : requested;
            } });
        await f.init(); assert.equal(f.el('AutoContinue').checked, true); await start(f); configure(f);
        const autoTag = f.host.innerHTML.match(/<input\b[^>]*\bid="modHubAiAutoContinue"[^>]*>/)?.[0];
        assert.ok(autoTag); assert.match(autoTag, /\bchecked\b/, '实际界面默认开启已授权范围内的接续分析');
        assert.equal(f.el('AutoScopeDetails').hidden, false);
        assert.ok(f.el('AutoScopeList').innerHTML.includes('测试模组') && f.el('AutoScopeList').innerHTML.includes('script.js'), '首次发送前可查看技术名与声明文件授权范围');
        assertCollapsedDetails(f.el('AutoScopeList').innerHTML, '每个模组的授权文件范围默认折叠');
        assert.match(f.el('AutoScope').textContent + f.host.innerHTML, /5\s*轮/);
        assert.match(f.el('AutoScope').textContent + f.host.innerHTML, /512\s*KiB/);
        assert.equal(f.state.requests.length, 0, '开启自动接续和整理授权范围不自动发送');
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '一次明确授权后范围内源码可持续分析，无需再点击发送');
        assert.equal(f.state.sourcePreparations.length, 1); assert.equal(f.state.sourcePreparations[0], requested);
        assert.equal(f.state.requests[1].prepared.files[0].path, 'script.js');
        assert.ok(phases.some(message => /第\s*1\s*\/\s*5\s*轮/.test(message)) && phases.some(message => /第\s*2\s*\/\s*5\s*轮/.test(message)), '持续处理状态呈现真实轮次与默认五轮上限');
        assert.ok(stages.every(item => !item.confirmation && item.results), '已授权自动接续的每轮处理都留在结果页，不反复进入确认页');
        assert.equal(f.el('Step2').hidden, true); assert.equal(f.el('Step3').hidden, false);
        assert.equal(f.el('Apply').hidden, false); assert.equal(f.el('Diff').value, f.plan.diff);
        assert.ok(!f.calls.includes('确认') && !f.calls.includes('应用'), '自动分析找到方案后停止，不自动确认或保存代码');
        await f.el('Apply').onclick(); assert.deepEqual(f.calls.slice(-2), ['确认', '应用'], '代码修改继续使用既有确认和修复前还原点流程');
        assert.match(f.el('Saved').textContent, /修复前还原点：修复前点/);
    }
    {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '需要额外核对另一个来源。', evidence: '本次范围尚未包括该来源', verification: '复现原问题',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '范围外模组', paths: ['outside.js'], reason: '进一步核对调用位置' } };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (_connection, prepared) => prepared.files.length ? f.plan : requested,
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: [{ path: 'outside.js', size: 12 }] }) });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1, '范围外材料不得借用首次授权自动发送');
        assert.equal(f.el('Step3').hidden, false); assert.equal(f.el('Continue').hidden, false);
        assert.ok(f.el('Advice').innerHTML.includes(requested.summary), '超范围暂停保留最后一轮诊断');
        assert.equal(f.el('Apply').hidden, true); assert.ok(!f.calls.includes('应用'));
        await f.el('Continue').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.state.requests.length, 1, '手动准备新增范围后仍等待明确发送');
        assert.equal(JSON.parse(f.el('Material').value).name, '范围外模组');
        assert.deepEqual(JSON.parse(f.el('Material').value).files, [{ path: 'outside.js', content: '旧原文' }]);
        await f.el('Analyze').onclick(); assert.equal(f.state.requests.length, 2);
        assert.equal(f.el('Apply').hidden, false); assert.ok(!f.calls.includes('应用'));
    }
    {
        const catalog = [
            { name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] },
            { name: '另一个模组', version: '1.0.0', files: [{ path: 'other.js', size: 12 }] },
        ];
        const request = { mode: 'source-request', name: '', summary: '先核对第一处调用。', evidence: '首轮日志指向 script.js', verification: '按原步骤复现',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对初始调用' } };
        const otherRequest = { ...request, summary: '调用来自授权范围内的另一份源码。',
            readRequest: { name: '另一个模组', paths: ['other.js'], reason: '核对跨包调用' } };
        const finished = { ...request, readRequest: null, canContinue: false, summary: '已核对两处调用，建议检查前置配置。', continuationReason: '没有可应用的代码修改。' };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            prepareRequestedSources: (_plan, prepared) => ({ ...withSourceCatalog(prepared, catalog), fileNames: catalog.find(item => item.name === prepared.name).files }),
            analyze: (_connection, prepared) => {
                assert.equal(f.el('Step2').hidden, true, '授权范围内跨包读取也不反复进入确认页');
                return prepared.name === '另一个模组' ? finished : prepared.name ? otherRequest : request;
            } });
        await f.init(); await start(f, '完整保留跨包问题描述'); configure(f);
        assert.ok(f.el('AutoScopeList').innerHTML.includes('测试模组') && f.el('AutoScopeList').innerHTML.includes('另一个模组'));
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3); assert.equal(f.state.sourcePreparations.length, 2);
        assert.deepEqual(f.state.requests.map(item => item.prepared.name), ['', '测试模组', '另一个模组']);
        assert.ok(f.state.requests.every(item => JSON.parse(item.prepared.material).description === '完整保留跨包问题描述'));
        assert.equal(f.el('Step3').hidden, false); assert.ok(f.el('Advice').innerHTML.includes(finished.summary));
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.el('LocalRepair').hidden, false);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '授权内跨包分析只读取材料，不创建还原点或写入包体');
    }
    {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '需要补充声明源码。', evidence: '尚未确认责任', verification: '复现原问题',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对原脚本' } };
        const reason = '包体已变化：<script>具体读取失败原因</script>\n请重新整理材料。';
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog), analyze: async () => requested,
            prepareRequestedSources: async () => { throw new Error(reason); } });
        await f.init(); await start(f); configure(f); const material = f.el('Material').value;
        Object.defineProperty(f.el('NextHint'), 'innerHTML', { get: () => '', set: () => { throw new Error('自动停止原因不得注入 HTML'); } });
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.sourcePreparations.length, 1);
        assert.ok(f.el('Advice').innerHTML.includes(requested.summary), '自动准备失败保留上一已接受轮次的诊断');
        assert.ok(f.el('NextHint').textContent.includes(reason), '停止原因保留失败详情原文，供玩家判断下一步');
        assert.equal(f.el('Material').value, material); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.el('LocalRepair').hidden, false); assert.equal(f.el('Progress').hidden, true);
        assert.equal(f.el('Apply').hidden, true); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
        await f.el('Retry').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.state.requests.length, 1, '失败后只在本机重新整理，不自动重发或重用旧计划');
    }
    {
        let resolve;
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '已接受的首轮分析，需要核对源码。', evidence: '日志指向原脚本', verification: '复现原问题',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '继续核对' } };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (_connection, prepared) => prepared.files.length ? new Promise(done => { resolve = done; }) : requested });
        await f.init(); await start(f); configure(f);
        const pending = f.el('Analyze').onclick(); await f.settle();
        assert.equal(f.state.requests.length, 2); assert.equal(f.el('Cancel').disabled, false);
        f.el('Cancel').onclick(); resolve(f.plan); await pending;
        assert.equal(f.el('Step3').hidden, false); assert.ok(f.el('Advice').innerHTML.includes(requested.summary));
        assert.equal(f.el('Apply').hidden, true); assert.equal(f.el('Apply').disabled, true, '取消后迟到的代码方案不得变成可应用结果');
        assert.equal(f.el('Continue').hidden, true); assert.equal(f.el('Progress').hidden, true);
        assert.equal(JSON.parse(f.el('Material').value).files[0].path, 'script.js', '保留已发送的源码材料与上一轮有效诊断');
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        let resolve;
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '本轮需要核对源码。', evidence: '存在声明文件', verification: '打开同一页面',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对具体报错位置' } };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog), analyze: async () => requested,
            prepareRequestedSources: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f, '本地读取取消后保留完整问题与材料'); configure(f);
        const pending = f.el('Analyze').onclick(); await f.settle();
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.sourcePreparations.length, 1);
        assert.equal(f.el('Cancel').hidden, false); assert.equal(f.el('Cancel').disabled, false, '只读源码准备阶段也能取消持续分析会话');
        assert.equal(f.el('AutoContinue').disabled, true); assert.equal(f.el('Settings').disabled, true);
        assert.equal(f.el('Progress').hidden, false); f.el('Cancel').onclick();
        assert.equal(f.state.requests[0].connection.signal.aborted, true);
        resolve(); await pending;
        assert.equal(f.state.requests.length, 1, '取消后迟到的本地读取结果不能触发下一次网络请求');
        const material = JSON.parse(f.el('Material').value);
        assert.equal(material.description, '本地读取取消后保留完整问题与材料');
        assert.deepEqual(material.files, [{ path: 'script.js', content: '旧原文' }], '取消后保留已完成的只读材料，等待玩家重新审核');
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Continue').hidden, true);
        assert.ok(f.el('Advice').innerHTML.includes(requested.summary), '取消本地读取保留上一轮已接受的诊断');
        f.el('Retry').onclick(); assert.equal(f.el('Step2').hidden, false);
        assert.deepEqual(JSON.parse(f.el('Material').value), material, '返回确认页继续审核已读材料，不重读或自动发送');
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const advice = { mode: 'advice', name: '', summary: '现有日志还不能确认问题来源。', evidence: '还没有实际读取源码', verification: '补充原问题的触发步骤',
            changes: [], diff: '', data: null, canContinue: true, continuationReason: '目录中仍有未读文件。' };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: async () => advice, sourceCatalog: catalog });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.investigations.length, 1); assert.equal(f.state.requests.length, 1, '仅增加诊断历史、不增加源码或新证据时不能重发相同目录空转');
        assert.equal(f.el('Step3').hidden, false); assert.ok(f.el('Advice').innerHTML.includes(advice.summary));
        assert.equal(f.el('LocalRepair').hidden, false); assert.ok(!f.calls.includes('应用'));
        let reads = 0;
        f.sb.modHubReadIndexDBModLists = async () => { reads++; return { ok: true, enabled: [], disabled: [] }; };
        await f.el('LocalRepair').onclick();
        assert.ok(reads > 0, '无法生成代码修复时可直接启动已有本地检查');
        assert.equal(f.sb.document.getElementById('modHubHelpLocalDetails').open, true);
        assert.equal(f.state.requests.length, 1); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '本地检查入口不发送请求、不修改配置');
    }
    {
        const original = '<script>服务返回的普通分析正文</script>\n' + '具体排查说明'.repeat(55) + '\n普通正文完整末尾';
        const advice = { mode: 'advice', name: '', summary: original, notice: '模型没有返回可应用的结构化修改。', evidence: '尚需确认调用位置', verification: '按原操作复现异常',
            changes: [], diff: '', data: null, canContinue: false, continuationReason: '没有符合读取条件的源码，请使用本地检查或补充线索。' };
        const f = fixture({ autoContinue: true, targets: [], analyze: async () => advice });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1); assert.equal(f.el('Step3').hidden, false);
        assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(original)), '自动模式也完整保留普通回复正文');
        assert.equal(f.el('LocalRepair').hidden, false); assert.equal(f.el('Apply').hidden, true);
        assert.equal(f.state.investigations.length, 0); assert.equal(f.state.sourcePreparations.length, 0); assert.ok(!f.calls.includes('应用'));
    }
    {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'patch.json', size: 100 }] }];
        const evidence = { name: '测试模组', path: 'patch.json', content: ':: 故障段落\n<<print $状态.name>>', offset: 0, line: 1, incomplete: true, writable: false };
        const advice = { mode: 'advice', name: '', summary: '需要核对已声明的替换片段。', evidence: '报错关联故障段落', verification: '按原操作检查',
            changes: [], diff: '', data: null, canContinue: true, continuationReason: '可核对授权范围内的补丁正文。' };
        const complete = { ...advice, summary: '已核对相关补丁，当前片段只能作为只读诊断依据。', canContinue: false, continuationReason: '请先在本地检查对应前置与加载顺序。' };
        const f = fixture({ autoContinue: true, targets: [], sourceCatalog: catalog, prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (_connection, prepared) => prepared.sourceEvidence?.length ? complete : advice,
            prepareInvestigation: (_plan, prepared) => ({ ...prepared, sourceEvidence: [evidence], sourceEvidenceOmitted: [],
                material: JSON.stringify({ ...JSON.parse(prepared.material), sourceEvidence: [evidence], sourceEvidenceOmitted: [] }) }) });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '授权范围内新增实际补丁证据可自动继续分析');
        assert.deepEqual(f.state.requests[1].prepared.sourceEvidence, [evidence]);
        assert.deepEqual(JSON.parse(f.state.requests[1].prepared.material).sourceEvidence, [evidence]);
        assert.equal(f.el('Step3').hidden, false); assert.equal(f.el('Apply').hidden, true);
        assert.ok(f.el('Advice').innerHTML.includes(complete.summary)); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        const requested = { mode: 'source-request', name: '测试模组', summary: '要求再次读取已经提供的同一份源码。', evidence: '没有新增线索', verification: '复现原问题',
            changes: [], diff: '', data: null, canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '重复读取' } };
        const f = fixture({ autoContinue: true, analyze: async () => requested });
        await f.init(); await start(f); configure(f); const material = f.el('Material').value;
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1, '相同源码和材料不能因模型重复请求而自动发送第二次');
        assert.equal(f.el('Step3').hidden, false);
        const unchanged = JSON.parse(f.el('Material').value);
        unchanged.diagnosisContext.round = JSON.parse(material).diagnosisContext.round;
        assert.equal(JSON.stringify(unchanged), material, '重新读取只更新接续轮次，源码、范围与预算保持一致');
        assert.ok(f.el('Advice').innerHTML.includes(requested.summary)); assert.ok(!f.calls.includes('应用'));
    }
    for (const maxRounds of [undefined, 12]) {
        const expectedRounds = maxRounds ?? 5;
        const files = Array.from({ length: 12 }, (_, index) => ({ path: 'part-' + (index + 1) + '.js', size: 12 }));
        const catalog = [{ name: '测试模组', version: '1.0.0', files }];
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: files }),
            analyze: async () => ({ mode: 'source-request', name: '', summary: '第' + f.state.requests.length + '轮仍需核对源码。', evidence: '本轮尚无代码方案', verification: '重新复现问题',
                changes: [], diff: '', data: null, canContinue: true,
                readRequest: { name: '测试模组', paths: ['part-' + f.state.requests.length + '.js'], reason: '核对下一份声明文件' } }) });
        await f.init(); configure(f, false, maxRounds); await start(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, expectedRounds, '默认五轮或明确自定义十二轮均按玩家确认的预算停止');
        assert.ok(f.state.requests.every(request => JSON.parse(request.prepared.material).diagnosisContext.maxRounds === expectedRounds));
        assert.equal(f.el('Step3').hidden, false); assert.equal(f.el('Progress').hidden, true);
        assert.ok(f.el('Advice').innerHTML.includes('第' + expectedRounds + '轮仍需核对源码')); assert.equal(f.el('LocalRepair').hidden, false);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        const files = [{ path: 'first.js', size: 12 }, { path: 'second.js', size: 12 }];
        const catalog = [{ name: '测试模组', files }], phases = [];
        const f = fixture({ targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: files }),
            analyze: (connection, prepared) => {
                assert.equal(f.el('UnlimitedRounds').disabled, true, '分析期间锁定不限轮次选项');
                assert.equal(f.el('MaxRounds').disabled, true, '分析期间锁定有限轮次输入');
                connection.onProgress('request'); phases.push(f.el('Status').textContent);
                const round = JSON.parse(prepared.material).diagnosisContext.round;
                return { mode: 'source-request', name: '', summary: '需要继续核对第 ' + round + ' 处源码。', evidence: '当前仍无可应用修改', verification: '复现原操作',
                    changes: [], diff: '', data: null, canContinue: true,
                    readRequest: { name: '测试模组', paths: [round === 1 ? 'first.js' : 'second.js'], reason: '核对下一处调用' } };
            } });
        await f.init(); configure(f, false, 2); await start(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1); await f.el('Continue').onclick();
        assert.deepEqual(JSON.parse(f.el('Material').value).diagnosisContext, { round: 2, maxRounds: 2 }, '逐轮手动接续保留总预算并递增真实轮次');
        f.el('AutoContinue').checked = true; await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '第二次发送从真实第二轮接续，不能重新获得两轮额度');
        assert.equal(f.state.sourcePreparations.length, 1, '已达到轮次预算后不再准备第三轮源码');
        assert.ok(phases.some(message => /第\s*2\s*\/\s*2\s*轮/.test(message)));
        assert.match(f.el('NextHint').textContent, /2\s*轮/); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.el('Apply').hidden, true); assert.ok(!f.calls.includes('应用'));
    }
    for (const finish of ['方案', '取消']) {
        const files = Array.from({ length: 15 }, (_, index) => ({ path: 'part-' + (index + 1) + '.js', size: 12 }));
        const catalog = [{ name: '测试模组', files }], phases = [];
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: files }),
            analyze: (connection, prepared) => {
                connection.onProgress('request'); phases.push(f.el('Status').textContent);
                const round = JSON.parse(prepared.material).diagnosisContext.round;
                if (round === 15) {
                    if (finish === '方案') return f.plan;
                    f.el('Cancel').onclick();
                }
                return { mode: 'source-request', name: '', summary: '已核对第 ' + round + ' 轮。', evidence: '仍有未读声明源码', verification: '按原操作复现',
                    changes: [], diff: '', data: null, canContinue: true,
                    readRequest: { name: '测试模组', paths: ['part-' + round + '.js'], reason: '核对新增证据' } };
            } });
        await f.init(); configure(f, false, 0); await start(f);
        assert.equal(f.state.logPreparations[0].maxRounds, 0); assert.match(f.el('AutoScope').textContent, /不限轮次/);
        assert.deepEqual(JSON.parse(f.el('Material').value).diagnosisContext, { round: 1, maxRounds: 0 });
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 15, '不限轮次允许持续分析超过默认五轮，并在' + finish + '时停止');
        assert.ok(f.state.requests.every(request => JSON.parse(request.prepared.material).diagnosisContext.maxRounds === 0), '每次接续都保留不限轮次预算');
        assert.ok(phases.some(message => /第\s*13\s*轮（不限轮次）/.test(message)));
        assert.equal(f.el('Progress').hidden, true); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
        assert.equal(f.el('UnlimitedRounds').disabled, false, '分析结束或取消后解除轮次选项锁定');
        assert.equal(f.el('MaxRounds').disabled, true, '无限模式结束后仍禁用有限轮次输入');
        if (finish === '方案') assert.equal(f.el('Apply').hidden, false);
        else {
            assert.equal(f.state.requests.at(-1).connection.signal.aborted, true);
            assert.equal(f.el('Apply').hidden, true); assert.match(f.el('Error').textContent + f.el('Status').textContent, /取消/);
        }
    }
    {
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }, { name: '另一模组', files: [{ path: 'other.js', size: 12 }] }];
        const advice = { name: '', summary: '已读多个候选，需要依据现有错误自动核对。', evidence: '前次完整证据', verification: '重复原操作',
            changes: [], diff: '', canContinue: false, canTriage: true,
            repairTargets: [{ name: '测试模组', paths: ['script.js'] }, { name: '另一模组', paths: ['other.js'] }] };
        const request = { ...advice, canContinue: true, canTriage: false, readRequest: { name: '测试模组', paths: ['script.js'], reason: '错误位置与该文件的函数吻合。' } };
        const sourceEvidence = [{ name: '测试模组', path: 'script.js', content: '旧原文', offset: 0, incomplete: false, writable: false },
            { name: '另一模组', path: 'other.js', content: '无关函数', offset: 0, incomplete: false, writable: false }];
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => ({ ...withSourceCatalog(prepared, catalog),
            material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog: catalog, sourceEvidence }) }),
            analyze: (_connection, prepared) => prepared.files.length ? f.plan : JSON.parse(prepared.material).repairIntent ? request : advice });
        await f.init(); await start(f, '保留原问题继续生成修改'); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3, '一次确认自动完成来源判断、选定源码与生成修改');
        assert.equal(f.state.triages.length, 1); assert.equal(f.state.sourcePreparations[0].readRequest.name, '测试模组');
        assert.equal(f.state.requests[2].prepared.name, '测试模组', '来源由核验后的 AI 请求决定，不让用户判断');
        assert.equal(JSON.parse(f.state.requests[1].prepared.material).diagnosisContext.summary, advice.summary);
        assert.ok(!f.host.innerHTML.includes('modHubAiRepairTarget') && !f.host.innerHTML.includes('请选择修复对象'), '正常流程没有修复对象选择控件');
        assert.equal(f.el('Step3').hidden, false); assert.equal(f.el('Apply').hidden, false);
        assert.equal(f.el('LocalRepair').hidden, true); assert.equal(f.el('Diff').value, f.plan.diff);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '生成实际修改后仍须另行确认应用');
        await f.el('Apply').onclick(); assert.ok(f.calls.includes('确认') && f.calls.includes('应用'));
    }
    {
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }, { name: '另一模组', files: [{ path: 'other.js', size: 12 }] }];
        const sourceEvidence = [{ name: '测试模组', path: 'script.js', content: '旧原文', offset: 0, incomplete: false, writable: false }];
        const advice = { name: '', summary: '已有候选原文，需要核对另一处已声明的调用。', evidence: '当前候选不足以确认根因', verification: '复现原页面',
            changes: [], diff: '', canContinue: false, canTriage: true, repairTargets: [{ name: '测试模组', paths: ['script.js'] }] };
        const request = { ...advice, canTriage: false, canContinue: true,
            readRequest: { name: '另一模组', paths: ['other.js'], reason: '核对原始授权目录中的未读声明文件' } };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => ({ ...withSourceCatalog(prepared, catalog),
            material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog: catalog, sourceEvidence }) }),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, fileNames: catalog[1].files }),
            analyze: (_connection, prepared) => prepared.files.length ? f.plan : JSON.parse(prepared.material).repairIntent ? request : advice });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3, '分诊仍可读取首次授权目录中尚未核对的声明文件并生成修改');
        assert.equal(f.state.triages.length, 1); assert.equal(f.state.sourcePreparations[0], request);
        assert.equal(f.state.requests[2].prepared.name, '另一模组');
        assert.deepEqual(JSON.parse(f.state.requests[2].prepared.material).diagnosisContext, { round: 3, maxRounds: 5, summary: advice.summary });
        assert.equal(f.el('Apply').hidden, false); assert.equal(f.el('Continue').hidden, true);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '诊断生成方案后停止，代码应用仍需另行确认');
    }
    {
        const advice = { name: '测试模组', summary: '已提供完整源码，需要再次核对根因。', evidence: '完整原文', verification: '复现原操作',
            changes: [], diff: '', canContinue: false, canTriage: true, repairTargets: [{ name: '测试模组', paths: ['script.js'] }] };
        const request = { ...advice, canContinue: true, canTriage: false, readRequest: { name: '测试模组', paths: ['script.js'], reason: '已核对根因，选回完整源码生成修改。' } };
        const f = fixture({ autoContinue: true, analyze: (_connection, prepared) => f.state.requests.length === 1 ? advice
            : JSON.parse(prepared.material).repairIntent === 'select-code-repair' ? request : f.plan });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3, '首次已提供源码经自动分诊选回后仍能生成修改，不能误报重复读取');
        assert.equal(f.state.triages.length, 1); assert.equal(f.el('Apply').hidden, false);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }, { name: '只读来源', files: [{ path: 'large.js', size: 300000 }] }];
        const sourceEvidence = [{ name: '测试模组', path: 'script.js', content: '旧原文', offset: 0, incomplete: false, writable: false },
            { name: '只读来源', path: 'large.js', content: '只读上下文', offset: 200, incomplete: true, writable: false }];
        const advice = { name: '', summary: '已有完整证据，继续自动核对。', evidence: '完整源码与只读上下文', verification: '复现原操作',
            changes: [], diff: '', canContinue: false, canTriage: true, repairTargets: [{ name: '测试模组', paths: ['script.js'] }] };
        const request = { ...advice, canContinue: true, canTriage: false, readRequest: { name: '测试模组', paths: ['script.js'], reason: '根据已读证据确认修复对象。' } };
        const f = fixture({ targets: [], prepareLogs: prepared => ({ ...withSourceCatalog(prepared, catalog),
            material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog: catalog, sourceEvidence }) }),
            prepareTriage: (_plan, prepared) => withSourceCatalog(prepared, catalog.slice(0, 1)),
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, material: JSON.stringify({ ...JSON.parse(prepared.material), sourceEvidence: sourceEvidence.slice(1) }) }),
            analyze: (_connection, prepared) => prepared.files.length ? f.plan : JSON.parse(prepared.material).repairIntent ? request : advice });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        await f.el('Continue').onclick();
        assert.equal(f.state.requests.length, 1, '逐轮确认来源材料只在本机准备');
        assert.ok(f.el('AutoScopeList').innerHTML.includes('large.js'), '材料中保留的只读证据也列入确认范围');
        f.el('AutoContinue').checked = true; await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 3, '确认后保留已展示的只读证据，不误报范围外而阻断生成修改');
        assert.equal(f.el('Apply').hidden, false); assert.ok(!f.calls.includes('应用'));
    }
    {
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }];
        const advice = { name: '', summary: '根因未能确定。', evidence: '错误涉及游戏初始化，暂无对应的可写原文。', verification: '补充初始化时的具体操作',
            changes: [], diff: '', canContinue: true, canTriage: true, repairTargets: [{ name: '测试模组', paths: ['script.js'] }] };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (_connection, prepared) => JSON.parse(prepared.material).repairIntent ? { ...advice, canContinue: false, canTriage: false } : advice });
        await f.init(); await start(f, '保留问题原文'); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '一次自动核对仍无依据时停止，不重复发相同证据');
        assert.equal(f.el('DescribeMore').hidden, false); assert.equal(f.el('Apply').hidden, true);
        assert.match(f.el('CodeRepairHint').textContent, /材料.*保留|保留.*材料/);
        assert.match(f.el('CodeRepairHint').textContent, /配置检查|检查.*配置/);
        assert.doesNotMatch(f.el('CodeRepairHint').textContent, /请补充|必须.*(补充|说明)/, '无法继续时不要求玩家再次补充已经描述的问题');
        f.el('DescribeMore').onclick();
        assert.equal(f.el('Step1').hidden, false); assert.equal(f.el('Description').value, '保留问题原文');
        assert.doesNotMatch(f.el('Status').textContent, /补充触发步骤后/, '可选调整保留原描述，不把补充步骤设为前提');
        assert.equal(f.state.requests.length, 2); assert.ok(!f.calls.includes('应用'));
    }
    {
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }];
        const evidence = { name: '测试模组', path: 'script.js', content: '旧原文', offset: 0, incomplete: false, writable: false };
        const requested = { name: '', summary: '已读正文需选定为修复对象。', evidence: '完整只读证据', verification: '复现原错误', changes: [], canContinue: true,
            readRequest: { name: '测试模组', paths: ['script.js'], reason: '选定完整源码生成修改' } };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => ({ ...withSourceCatalog(prepared, catalog),
            material: JSON.stringify({ ...JSON.parse(prepared.material), sourceCatalog: catalog, sourceEvidence: [evidence] }) }),
            analyze: (_connection, prepared) => prepared.files.length ? f.plan : requested });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '将完整只读证据选定为可修改源码时允许自动继续，不能误判正文重复');
        assert.equal(f.el('Apply').hidden, false); assert.ok(!f.calls.includes('应用'));
    }
    {
        let resolve;
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }];
        const advice = { name: '', summary: '正在依据已读源码核对来源。', evidence: '完整证据', verification: '复现原操作',
            changes: [], diff: '', canContinue: false, canTriage: true, repairTargets: [{ name: '测试模组', paths: ['script.js'] }] };
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: async () => advice, prepareTriage: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f, '取消后保留原问题'); configure(f);
        const pending = f.el('Analyze').onclick(); await f.settle();
        assert.equal(f.state.triages.length, 1); assert.equal(f.el('Cancel').hidden, false);
        f.el('Cancel').onclick(); resolve(); await pending;
        assert.equal(f.state.requests.length, 1, '来源整理取消后，迟到结果不能自动发送');
        assert.equal(f.el('Continue').hidden, true); assert.equal(f.el('DescribeMore').hidden, false);
        assert.equal(f.el('Apply').hidden, true); assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
        f.el('DescribeMore').onclick(); assert.equal(f.el('Description').value, '取消后保留原问题');
    }
    for (const fileNames of [[], [{ path: 'large.js', size: 262145 }], Array.from({ length: 21 }, (_, index) => ({ path: 'part-' + index + '.js', size: 100 }))]) {
        const f = fixture({ fileNames, recommendation: { paths: [], reason: '没有可唯一关联且符合限制的源码，先分析日志。' } });
        await f.init(); await start(f);
        assert.equal(f.state.preparations.length, 1); assert.equal(f.state.logPreparations.length, 1);
        assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.el('SelectionSummary').textContent, '本次不提供源码。');
        assert.match(f.el('SelectionReason').textContent, /先分析日志.*本次不提供源码/);
        assert.ok(!f.calls.includes('请求'), '无可用源码时直接整理日志，不强迫选文件或自动发送');
    }
    {
        let resolve, sourceLocks;
        const f = fixture({ fileNames: [{ path: 'script.js', size: 12 }, { path: 'large.js', size: 262145 }],
            recommendation: { paths: ['script.js'], reason: '已找到符合限制的相关文件。' },
            prepare: (prepared, data) => {
                if (!data.paths.length) return prepared;
                sourceLocks = f.state.fileNodes.map(input => ({ path: input.dataset.aiFile, disabled: input.disabled }));
                return new Promise(done => { resolve = () => done(prepared); });
            } });
        await f.init(); const pending = start(f); await f.settle();
        assert.equal(sourceLocks.length, 2, '第二次读取源码前已创建动态文件复选框');
        assert.ok(sourceLocks.every(input => input.disabled), '读取源码期间所有新建文件复选框都保持锁定');
        assert.ok(f.state.fileNodes.every(input => input.disabled));
        resolve(); await pending;
        assert.equal(f.state.fileNodes.find(input => input.dataset.aiFile === 'script.js').disabled, false, '整理完成后普通文件恢复可选');
        assert.equal(f.state.fileNodes.find(input => input.dataset.aiFile === 'large.js').disabled, true, '超限文件在操作结束后仍保持禁用');
        assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture(); await f.init();
        f.el('Description').value = '先保留问题，独立配置连接'; f.el('Settings').onclick();
        assert.equal(f.el('SettingsPanel').hidden, false); assert.equal(f.el('Workflow').hidden, true);
        assert.deepEqual(f.calls, []);
        f.el('Endpoint').value = 'http://127.0.0.1:8000/v1'; f.el('Endpoint').oninput();
        f.el('Model').value = 'local-model'; f.el('Model').oninput();
        f.el('Key').value = '不可落盘的测试密钥'; f.el('Key').oninput(); f.el('SettingsSave').onclick();
        assert.deepEqual(f.calls, ['校验设置']); assert.equal(f.el('SettingsPanel').hidden, true);
        assert.equal(f.el('Description').value, '先保留问题，独立配置连接');
        assert.deepEqual(JSON.parse(f.storage.get('modhub_ai_connection')), { endpoint: 'http://127.0.0.1:8000/v1', model: 'local-model', maxRounds: 5 });
        assert.ok(!JSON.stringify([...f.storage]).includes('不可落盘的测试密钥'));
        assert.match(f.el('Status').textContent, /已保存.*未发送请求/);
        assert.equal(f.el('ConnectionStatus').textContent, 'AI 服务已配置 · 模型：local-model');
        assert.doesNotMatch(f.el('ConnectionStatus').textContent, /127\.0\.0\.1/, '常驻状态不重复展示长连接地址');
    }
    for (const maxRounds of [2, 12, 100000, 0]) {
        const f = fixture(); await f.init(); configure(f, false, maxRounds);
        assert.equal(JSON.parse(f.storage.get('modhub_ai_connection')).maxRounds, maxRounds, '自定义轮次以数值保存，包括大于默认值和不限轮次');
        const reload = fixture({ storage: f.storage }); await reload.init();
        assert.equal(reload.el('MaxRounds').value, maxRounds || 5, '无限模式也以正整数回填有限轮次');
        assert.equal(reload.el('UnlimitedRounds').checked, maxRounds === 0);
        assert.equal(reload.el('MaxRounds').disabled, maxRounds === 0);
        await start(f);
        assert.ok(f.state.preparations.every(item => item.maxRounds === maxRounds));
        assert.deepEqual(JSON.parse(f.el('Material').value).diagnosisContext, { round: 1, maxRounds });
        assert.ok(!f.calls.includes('请求'), '保存及准备自定义预算不会自动发送请求');
    }
    {
        const f = fixture(); await f.init(); configure(f, false, 9);
        assert.equal(f.el('RoundsNotice').hidden, true, '九轮不显示较多轮次的 Token 提示');
        f.el('Settings').onclick(); f.el('MaxRounds').value = '10'; f.el('MaxRounds').oninput();
        assert.equal(f.el('RoundsNotice').hidden, false, '十轮开始显示 Token 提示');
        f.el('MaxRounds').value = '9'; f.el('MaxRounds').oninput();
        f.el('UnlimitedRounds').checked = true; f.el('UnlimitedRounds').onchange();
        assert.equal(f.el('RoundsNotice').hidden, false, '不限轮次始终显示 Token 提示');
        assert.equal(f.el('MaxRounds').disabled, true); assert.equal(f.el('MaxRounds').value, '9');
        f.el('SettingsSave').onclick();
        assert.deepEqual(JSON.parse(f.storage.get('modhub_ai_connection')), { endpoint: 'https://example.test/v1', model: 'model', maxRounds: 0, finiteRounds: 9 });
        const reload = fixture({ storage: f.storage }); await reload.init();
        assert.equal(reload.el('UnlimitedRounds').checked, true); assert.equal(reload.el('MaxRounds').value, 9);
        reload.el('Settings').onclick(); reload.el('UnlimitedRounds').checked = false; reload.el('UnlimitedRounds').onchange();
        assert.equal(reload.el('MaxRounds').disabled, false); assert.equal(reload.el('MaxRounds').value, 9);
        assert.equal(reload.el('RoundsNotice').hidden, true, '取消无限后恢复有限值及对应提示');
        reload.el('SettingsSave').onclick();
        assert.equal(JSON.parse(reload.storage.get('modhub_ai_connection')).maxRounds, 9);
        assert.equal(JSON.parse(reload.storage.get('modhub_ai_connection')).finiteRounds, undefined, '有限预算无需重复保存有限值');
        await start(reload);
        assert.deepEqual(JSON.parse(reload.el('Material').value).diagnosisContext, { round: 1, maxRounds: 9 }, '退出无限模式后材料使用保留的有限预算');
        assert.ok(reload.state.preparations.every(item => item.maxRounds === 9));
    }
    for (const finiteRounds of [undefined, 0, -1, 1.5, '12']) {
        const saved = JSON.stringify({ endpoint: 'https://saved.test/v1', model: 'saved-model', maxRounds: 0, finiteRounds });
        const f = fixture({ storage: [['modhub_ai_connection', saved]] }); await f.init();
        assert.equal(f.el('UnlimitedRounds').checked, true, '旧数值零预算迁移为不限轮次选项');
        assert.equal(f.el('MaxRounds').value, 5, '旧无限配置缺少有效有限值时回填五轮'); assert.equal(f.el('MaxRounds').disabled, true);
        assert.equal(f.el('RoundsNotice').hidden, false);
        assert.equal(f.storage.get('modhub_ai_connection'), saved, '读取迁移不覆盖原设置');
        f.el('UnlimitedRounds').checked = false; f.el('UnlimitedRounds').onchange();
        assert.equal(f.el('MaxRounds').disabled, false); assert.equal(f.el('MaxRounds').value, 5);
        await start(f); assert.equal(JSON.parse(f.el('Material').value).diagnosisContext.maxRounds, 5);
    }
    for (const invalid of ['', '0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
        const f = fixture(); await f.init(); configure(f);
        const original = f.storage.get('modhub_ai_connection');
        f.el('Settings').onclick(); f.el('MaxRounds').value = invalid; f.el('MaxRounds').oninput(); f.el('SettingsSave').onclick();
        assert.equal(f.el('SettingsPanel').hidden, false); assert.match(f.el('SettingsError').textContent, /轮次.*正整数/);
        assert.equal(f.storage.get('modhub_ai_connection'), original, '无效轮次不能替换已保存的连接');
        assert.ok(!f.calls.includes('请求') && !f.calls.includes('测试连接'));
    }
    for (const invalid of ['', '0', -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
        const saved = JSON.stringify({ endpoint: 'https://saved.test/v1', model: 'saved-model', maxRounds: invalid });
        const f = fixture({ storage: [['modhub_ai_connection', saved]] }); await f.init();
        assert.equal(f.el('MaxRounds').value, 5, '已保存预算无效时回退五轮');
        assert.equal(f.el('UnlimitedRounds').checked, false, '无效预算不默认启用不限轮次');
        assert.equal(f.storage.get('modhub_ai_connection'), saved, '读取无效旧设置不覆盖原记录'); assert.deepEqual(f.calls, []);
    }
    {
        const f = fixture(); await f.init(); configure(f); await start(f, '保留已描述的原始问题');
        const material = f.el('Material').value;
        f.el('Settings').onclick(); f.el('MaxRounds').value = '5'; f.el('MaxRounds').oninput();
        assert.equal(f.el('Material').value, material, '预算数值不变时保留已准备材料');
        f.el('UnlimitedRounds').checked = true; f.el('UnlimitedRounds').onchange();
        assert.equal(f.el('Material').value, ''); assert.equal(f.el('Analyze').disabled, true, '预算改变立即使旧材料失效');
        f.el('SettingsSave').onclick(); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 0, '保存新预算后不能发送旧材料'); assert.equal(f.el('Description').value, '保留已描述的原始问题');
        await start(f, f.el('Description').value); assert.equal(JSON.parse(f.el('Material').value).diagnosisContext.maxRounds, 0);
        await f.el('Analyze').onclick(); assert.equal(f.state.requests.length, 1);
        assert.equal(JSON.parse(f.state.requests[0].prepared.material).diagnosisContext.maxRounds, 0, '重新准备并明确发送后使用新预算');
    }
    for (const saved of [
        { remember: true, key: '用于回填测试的虚构密钥' },
        { remember: false, key: '不应回填的虚构密钥' },
        { key: '无记住选项的虚构密钥' },
        { remember: 'true', key: '非布尔标志的虚构密钥' },
        { remember: true, key: 12345 },
    ]) {
        const connection = { endpoint: 'https://saved.test/v1', model: 'saved-model', ...saved };
        const f = fixture({ storage: [['modhub_ai_connection', JSON.stringify(connection)]] });
        const before = [...f.storage]; await f.init();
        assert.equal(f.el('Endpoint').value, connection.endpoint); assert.equal(f.el('Model').value, connection.model);
        assert.equal(f.el('RememberMe').checked, saved.remember === true);
        assert.equal(f.el('MaxRounds').value, 5, '旧版连接缺少预算时使用默认五轮');
        assert.equal(f.el('UnlimitedRounds').checked, false, '缺少预算的旧配置不启用不限轮次');
        assert.equal(f.el('Key').value, saved.remember === true && typeof saved.key === 'string' ? saved.key : '', '只有明确记住且密钥为文本时才回填');
        assert.deepEqual([...f.storage], before, '读取设置不修改已保存连接'); assert.deepEqual(f.calls, []);
    }
    for (const remember of [true, false]) {
        const f = fixture(); await f.init(); configure(f, !remember);
        const original = f.storage.get('modhub_ai_connection');
        f.el('Settings').onclick(); f.el('RememberMe').checked = remember; f.el('RememberMe').onchange();
        assert.equal(f.storage.get('modhub_ai_connection'), original, '单纯更改记住选项不立即持久化');
        f.el('SettingsBack').onclick(); assert.equal(f.storage.get('modhub_ai_connection'), original, '离开设置不提交未保存选项');
        await f.init(); assert.equal(f.el('RememberMe').checked, remember, '切页不以磁盘设置覆盖本次未保存选择');
        await start(f); await f.el('Analyze').onclick();
        assert.equal(f.storage.get('modhub_ai_connection'), original, '问题分析成功也不提交未保存连接设置');
        f.el('Settings').onclick(); f.el('SettingsSave').onclick();
        const expected = { endpoint: 'https://example.test/v1', model: 'model', maxRounds: 5, ...(remember ? { remember: true, key: '仅内存密钥' } : {}) };
        assert.deepEqual(JSON.parse(f.storage.get('modhub_ai_connection')), expected, '只有点击保存才写入当前记住选项并清除未勾选的旧密钥');
        const reload = fixture({ storage: f.storage }); await reload.init();
        assert.equal(reload.el('RememberMe').checked, remember);
        assert.equal(reload.el('Key').value, remember ? '仅内存密钥' : '', '重新加载按已保存选项恢复或移除密钥');
    }
    for (const remember of [true, false]) {
        const failure = '存储写入失败：<img src=x onerror="window.fake=1">\n浏览器存储不可用';
        const f = fixture(); await f.init(); await start(f); configure(f, !remember);
        const original = f.storage.get('modhub_ai_connection'), material = f.el('Material').value, status = f.el('Status').textContent;
        f.el('Settings').onclick();
        f.el('Endpoint').value = 'https://changed.test/v1'; f.el('Endpoint').oninput();
        f.el('Model').value = 'changed-model'; f.el('Model').oninput();
        f.el('Key').value = '保存失败仍保留的虚构密钥'; f.el('Key').oninput();
        f.el('RememberMe').checked = remember; f.el('RememberMe').onchange();
        f.state.connectionSaveError = failure;
        Object.defineProperty(f.el('SettingsError'), 'innerHTML', { get: () => '', set: () => { throw new Error('保存错误不得使用 HTML 注入'); } });
        f.el('SettingsSave').onclick();
        assert.equal(f.storage.get('modhub_ai_connection'), original, '保存失败保留原连接记录');
        assert.equal(f.el('SettingsPanel').hidden, false); assert.equal(f.el('SettingsError').textContent, failure);
        assert.equal(f.el('Status').textContent, status, '保存失败不能误报已保存');
        assert.equal(f.el('Endpoint').value, 'https://changed.test/v1'); assert.equal(f.el('Model').value, 'changed-model');
        assert.equal(f.el('Key').value, '保存失败仍保留的虚构密钥'); assert.equal(f.el('RememberMe').checked, remember);
        assert.equal(f.el('Material').value, material); assert.ok(!f.calls.includes('请求'));
        assert.deepEqual(f.state.focusEvents.at(-1), { id: 'modHubAiSettingsError', disabled: false });
        f.state.connectionSaveError = ''; f.el('SettingsSave').onclick();
        assert.deepEqual(JSON.parse(f.storage.get('modhub_ai_connection')), { endpoint: 'https://changed.test/v1', model: 'changed-model', maxRounds: 5,
            ...(remember ? { remember: true, key: '保存失败仍保留的虚构密钥' } : {}) }, '解除存储错误后可以重试保存');
    }
    {
        const malicious = '地址格式无效：<img src=x onerror="window.fake=1">';
        const f = fixture({ settingsError: malicious }); await f.init();
        f.el('Description').value = '保留的原始问题'; f.el('Settings').onclick();
        Object.defineProperty(f.el('SettingsError'), 'innerHTML', { get: () => '', set: () => { throw new Error('设置错误不得使用 HTML 注入'); } });
        f.el('SettingsSave').onclick(); assert.equal(f.el('SettingsError').textContent, malicious);
        assert.equal(f.el('SettingsPanel').hidden, false); assert.equal(f.storage.has('modhub_ai_connection'), false);
        assert.deepEqual(f.calls, ['校验设置']); f.el('SettingsBack').onclick();
        assert.equal(f.el('Description').value, '保留的原始问题');
    }
    {
        const f = fixture(); await f.init(); await start(f, '保留在本机的问题和源码'); configure(f);
        const material = f.el('Material').value, saved = [...f.storage], calls = [...f.calls], logReads = f.state.logReads;
        f.el('Settings').onclick();
        assert.equal(f.state.connectionTests.length, 0, '打开连接设置不会自动测试');
        assert.equal(f.el('SettingsCancel').hidden, true);
        assert.ok(f.host.innerHTML.includes('测试不发送问题、日志或源码，可能产生少量费用。保存设置不会发送请求。'));
        assert.match(f.host.innerHTML, /少量费用/);
        assert.match(f.host.innerHTML, /不.{0,8}(日志|源码|问题)/);
        const statusTag = f.host.innerHTML.match(/<p\b[^>]*\bid="modHubAiSettingsStatus"[^>]*>/)?.[0];
        assert.ok(statusTag); assert.match(statusTag, /role="status"/); assert.match(statusTag, /tabindex="-1"/);
        f.el('Endpoint').value = 'https://unsaved.test/v1'; f.el('Endpoint').oninput();
        f.el('Model').value = 'unsaved-model'; f.el('Model').oninput();
        f.el('Key').value = '测试连接的临时密钥'; f.el('Key').oninput();
        f.el('RememberMe').checked = true; f.el('RememberMe').onchange();
        await f.el('SettingsTest').onclick();
        const probeCalls = f.calls.slice(calls.length);
        assert.equal(probeCalls.filter(call => call === '测试连接').length, 1);
        assert.ok(probeCalls.every(call => call === '测试连接' || call === '校验设置'), '仅测试按钮发送固定探测，不读包或执行问题分析');
        assert.equal(f.state.connectionTests.length, 1);
        const connection = f.state.connectionTests[0];
        assert.ok(Object.keys(connection).every(key => ['endpoint', 'key', 'model', 'signal'].includes(key)), '测试连接只接收连接选项，不接收预算、记忆选项、问题或包体材料');
        assert.deepEqual(Object.keys(connection).sort(), ['endpoint', 'key', 'model', 'signal']);
        assert.equal(connection.endpoint, 'https://unsaved.test/v1'); assert.equal(connection.model, 'unsaved-model');
        assert.equal(connection.key, '测试连接的临时密钥'); assert.equal(connection.signal.aborted, false);
        assert.equal(f.state.logReads, logReads, '测试连接不额外读取日志');
        assert.deepEqual([...f.storage], saved, '测试连接不保存地址、模型或密钥');
        assert.equal(f.el('Material').value, material, '连接测试保留已整理的问题材料');
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('SettingsPanel').hidden, false);
        assert.equal(f.el('SettingsStatus').textContent, '连接成功。可以继续进行分析与修复。');
        assert.equal(f.el('SettingsCancel').hidden, true);
        for (const id of ['Endpoint', 'Model', 'Key']) {
            f.el(id).value += '-changed'; f.el(id).oninput();
            assert.equal(f.el('SettingsStatus').textContent, '', '任一连接字段变化都清除旧测试状态');
            await f.el('SettingsTest').onclick();
            assert.match(f.el('SettingsStatus').textContent, /成功|已连通|正常/);
        }
        assert.deepEqual([...f.storage], saved);
        assert.equal(f.el('Material').value, material);
    }
    {
        const reason = 'HTTP 401：<img src=x onerror="window.fake=1">\n密钥校验失败';
        const f = fixture({ connectionTest: async () => { throw new Error(reason); } }); await f.init(); configure(f);
        f.el('Settings').onclick();
        Object.defineProperty(f.el('SettingsStatus'), 'innerHTML', { get: () => '', set: () => { throw new Error('连接测试结果不得使用 HTML 注入'); } });
        await f.el('SettingsTest').onclick();
        assert.ok(f.el('SettingsStatus').textContent.includes(reason), '连接失败保留服务返回的具体原因');
        assert.equal(f.el('SettingsError').textContent, '', '连接探测错误独立于保存时的格式错误');
        assert.equal(f.el('SettingsTest').disabled, false); assert.equal(f.el('SettingsSave').disabled, false);
        assert.equal(f.el('SettingsCancel').hidden, true);
        f.el('Key').value = '新的临时密钥'; f.el('Key').oninput();
        assert.equal(f.el('SettingsStatus').textContent, '');
    }
    {
        const finish = [];
        const f = fixture({ connectionTest: () => new Promise(resolve => finish.push(resolve)) }); await f.init(); configure(f);
        f.el('Settings').onclick(); const first = f.el('SettingsTest').onclick(); await f.settle();
        for (const id of ['Endpoint', 'Model', 'Key', 'RememberMe', 'MaxRounds', 'UnlimitedRounds', 'SettingsTest', 'SettingsSave', 'Settings']) assert.equal(f.el(id).disabled, true, '测试中禁用 ' + id);
        assert.equal(f.el('SettingsBack').disabled, false); assert.equal(f.el('SettingsCancel').hidden, false);
        assert.equal(f.el('SettingsProgress').hidden, false, '连接测试期间显示圆环');
        assert.equal(f.el('SettingsCancel').disabled, false); assert.ok(f.el('SettingsStatus').textContent);
        const calls = [...f.calls]; await f.el('SettingsTest').onclick(); assert.deepEqual(f.calls, calls, '测试中不能重复发送');
        f.el('SettingsCancel').onclick();
        assert.equal(f.state.connectionTests[0].signal.aborted, true); assert.equal(f.el('SettingsCancel').hidden, true);
        assert.equal(f.el('SettingsProgress').hidden, true, '取消连接测试后移除圆环');
        assert.equal(f.el('SettingsTest').disabled, false); assert.match(f.el('SettingsStatus').textContent, /取消/);
        const second = f.el('SettingsTest').onclick(); await f.settle(); const status = f.el('SettingsStatus').textContent;
        finish[0]({ ok: true }); await first;
        assert.equal(f.el('SettingsStatus').textContent, status, '已取消的旧结果不能覆盖新测试');
        assert.equal(f.el('SettingsTest').disabled, true, '旧请求结束不能提前解锁仍进行中的测试');
        finish[1]({ ok: true }); await second;
        assert.match(f.el('SettingsStatus').textContent, /成功|已连通|正常/); assert.equal(f.el('SettingsTest').disabled, false);
    }
    for (const leave of ['返回帮助', '重建页面']) {
        let reject;
        const f = fixture({ connectionTest: () => new Promise((resolve, fail) => { reject = fail; }) });
        await f.init(); await start(f); configure(f); const material = f.el('Material').value;
        f.el('Settings').onclick(); const pending = f.el('SettingsTest').onclick(); await f.settle();
        if (leave === '返回帮助') f.el('SettingsBack').onclick(); else await f.init();
        assert.equal(f.state.connectionTests[0].signal.aborted, true, leave + '应中止连接测试');
        const status = f.el('SettingsStatus').textContent;
        reject(new Error('旧页面迟到的连接失败')); await pending;
        assert.equal(f.el('SettingsStatus').textContent, status, '离开后旧失败不能写入当前状态');
        if (leave === '返回帮助') {
            assert.equal(f.el('SettingsPanel').hidden, true);
            assert.equal(f.el('Material').value, material); assert.equal(f.el('Step2').hidden, false);
            assert.equal(f.el('Analyze').disabled, false, '返回后仍可继续使用已整理材料');
        }
    }
    {
        const f = fixture(); await f.init(); await start(f); const material = f.el('Material').value;
        f.el('Settings').onclick(); f.el('SettingsBack').onclick();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Material').value, material);
        f.el('Settings').onclick();
        f.el('Endpoint').value = 'https://changed.test/v1'; f.el('Endpoint').oninput();
        f.el('Model').value = 'new-model'; f.el('Model').oninput();
        f.el('Key').value = '仅内存密钥'; f.el('Key').oninput(); f.el('SettingsSave').onclick();
        assert.match(f.el('ConnectionHint').textContent, /changed\.test.*new-model/);
        assert.equal(f.el('Material').value, material); assert.ok(!f.calls.includes('请求'));
        await f.el('Analyze').onclick(); assert.equal(f.state.requests[0].connection.endpoint, 'https://changed.test/v1');
    }
    {
        const f = fixture(); await f.init(); await start(f, ' \n\t');
        assert.match(f.el('Error').textContent, /请先描述/); assert.equal(f.el('Step1').hidden, false); assert.deepEqual(f.calls, []);
        const longError = '<<widget "长错误原文">>\n' + '长报错内容'.repeat(900) + '\n原文尾部不得丢失';
        await start(f, longError); assert.match(f.el('DescriptionCount').textContent, /4000 字.*精简/);
        assert.match(f.el('Error').textContent, /超过 4000 字.*原文已保留/);
        assert.equal(f.el('Description').value, longError); assert.deepEqual(f.calls, []);
    }
    {
        const f = fixture(); await f.init();
        const original = '  打开服装页面时出错\n<<print $衣服.name>>\nTypeError: 原始错误末尾  ';
        await start(f, original); assert.equal(f.el('Problem').textContent, original);
        assert.ok(f.state.preparations.every(item => item.description === original)); f.el('Back').onclick();
        assert.equal(f.el('Step1').hidden, false); assert.equal(f.el('Description').value, original);
        assert.equal(f.el('Material').value, ''); await f.init();
        assert.equal(f.el('Description').value, original, '切换页面保留内存草稿');
        assert.ok(!JSON.stringify([...f.storage]).includes('原始错误末尾'));
    }
    {
        const fullError = '<img src=x onerror=1>\n' + '完整日志'.repeat(1500) + '\n完整日志末尾';
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }], errorMods: ['甲'], selectedFiles: ['故障段落'] });
        await f.init(); f.el('Description').value = '另一件旧问题'; f.el('Description').oninput();
        assert.equal(f.sb.modHubHelp.openProblem({ modName: '乙', error: fullError }), true); await f.init();
        assert.equal(f.el('Step2').hidden, false); assert.equal(f.el('Target').value, '乙');
        assert.notEqual(f.el('Description').value, '另一件旧问题');
        assert.ok(f.state.preparations.every(item => item.name === '乙' && item.logError === fullError), '完整日志不挤入 4000 字描述或截断');
        assert.equal(JSON.parse(f.el('Material').value).logError, fullError);
        assert.ok(f.state.recommendations[0].lines.some(item => item.message === fullError && item.files.includes('故障段落')), '选定日志保留诊断后的文件或段落标识');
        assert.match(f.el('LogSummary').innerHTML, /&lt;img/); assert.doesNotMatch(f.el('LogSummary').innerHTML, /<img/);
        assert.ok(!f.calls.includes('请求')); assert.ok(!JSON.stringify([...f.storage]).includes('完整日志末尾'));
    }
    {
        const f = fixture({ lines: ['一', '二', '三', '四'].map(message => ({ level: 'error', message })) });
        await f.init(); await start(f);
        assert.equal((f.el('LogSummary').innerHTML.match(/<pre\b/g) || []).length, 3); assert.match(f.el('LogSummary').innerHTML, /4 条错误/);
    }
    {
        const f = fixture(); await f.init(); await start(f); configure(f); await f.el('Analyze').onclick(); f.el('Retry').onclick();
        const material = f.el('Material').value; assert.ok(material); assert.equal(f.el('Apply').disabled, true);
        assert.equal(f.el('Analyze').disabled, false); f.el('Target').value = '另一个目标'; await f.el('Target').onchange();
        assert.ok(f.state.preparations.slice(-2).every(item => item.name === '另一个目标')); assert.notEqual(f.el('Material').value, material);
        assert.equal(f.el('Apply').disabled, true); assert.equal(f.state.fileNodes.length, 1);
        f.state.fileNodes[0].checked = false; f.el('Files').onchange();
        assert.equal(f.el('Analyze').disabled, true); assert.equal(f.el('Material').value, '');
        await f.el('Preview').onclick(); assert.equal(f.state.logPreparations.length, 1); assert.equal(f.el('Analyze').disabled, false);
    }
    {
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }], errorMods: ['甲'] });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick(); f.el('Retry').onclick();
        f.state.analysis.errorMods = ['乙'];
        f.state.analysis.lines = [{ level: 'error', message: '乙的最新错误' }];
        f.state.analysis.errorCount = 1;
        await f.el('Refresh').onclick();
        assert.equal(f.el('Target').value, '乙', '刷新重新核对当前日志和真实技术名');
        assert.ok(f.state.preparations.slice(-2).every(item => item.name === '乙'));
        assert.equal(JSON.parse(f.el('Material').value).name, '乙');
        assert.equal(f.el('Apply').hidden, true, '刷新材料后旧方案失效');
        assert.equal(f.calls.filter(call => call === '请求').length, 1, '刷新只在本机整理，不重新发送');
    }
    for (const failure of ['metadata', 'source']) {
        const malicious = '<img src=x onerror="window.fake=1">\n<<print $原文>>\n原始错误详情';
        const f = fixture(failure === 'metadata' ? { prepareError: malicious } : { sourceError: malicious }); await f.init();
        Object.defineProperty(f.el('Error'), 'innerHTML', { get: () => '', set: () => { throw new Error('错误详情不得使用 HTML 注入'); } });
        await start(f, '保留这段问题描述'); assert.equal(f.el('Error').textContent, malicious);
        assert.equal(f.el('ErrorDetails').hidden, false); assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.state.logPreparations.length, 1); assert.match(f.el('SelectionReason').textContent, /无法读取.*先分析日志/);
        assert.ok(!f.calls.includes('请求'), '声明或实际文本读取失败均降级日志，保留具体原因');
    }
    {
        const f = fixture(); await f.init(); await start(f); f.state.prepareError = '更新材料时读取失败'; await f.el('Preview').onclick();
        assert.equal(f.el('Material').value, ''); assert.equal(f.el('Analyze').disabled, true);
        assert.match(f.el('Error').textContent, /更新材料时读取失败/); assert.ok(f.state.prepareLocks.every(Boolean));
        await f.el('Analyze').onclick(); assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture({ confirm: false }); await f.init(); await start(f); configure(f);
        await f.el('Analyze').onclick(); await f.el('Apply').onclick(); assert.ok(!f.calls.includes('应用'));
    }
    {
        const f = fixture({ result: { ok: false, pointId: '失败保护点', reason: '包体已经写入，但回读失败' } });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick(); await f.el('Apply').onclick();
        assert.match(f.el('Error').textContent, /回读失败/); assert.match(f.el('Saved').textContent, /未完整通过核验/);
        assert.equal(f.el('Reload').disabled, true); assert.equal(f.el('Undo').disabled, false);
    }
    {
        const f = fixture({ restore: true }); await f.init(); await start(f); configure(f);
        await f.el('Analyze').onclick(); await f.el('Apply').onclick(); await f.el('Undo').onclick();
        assert.equal(f.storage.has('modhub_ai_last_repair'), false);
    }
    {
        const f = fixture(); await f.init(); await start(f); configure(f);
        await f.el('Analyze').onclick(); await f.el('Apply').onclick(); await f.init();
        f.state.data = new Uint8Array([2]); await f.el('Last').onclick();
        assert.match(f.el('Status').textContent, /不再对应当前包体/); assert.equal(f.storage.has('modhub_ai_last_repair'), false);
    }
    {
        let resolve;
        const f = fixture({ analyze: () => new Promise(done => { resolve = done; }) });
        await f.init(); await start(f); configure(f); const pending = f.el('Analyze').onclick(); await f.settle();
        assert.equal(f.el('Target').disabled, true); assert.equal(f.el('Analyze').disabled, true);
        assert.equal(f.el('Cancel').hidden, false); assert.equal(f.el('Cancel').disabled, false);
        await f.init(); const status = f.el('Status').textContent;
        assert.equal(f.state.requests[0].connection.signal.aborted, true, '离开旧页面时取消该页请求');
        resolve({ summary: '旧结果', evidence: '旧依据', verification: '旧验证', changes: [], diff: '' }); await pending;
        assert.equal(f.el('Status').textContent, status, '旧分析结果不能覆盖新页面');
    }
    {
        let resolve, reportStage;
        const f = fixture({ analyze: connection => {
            reportStage = connection.onProgress;
            return new Promise(done => { resolve = done; });
        } });
        await f.init(); await start(f); configure(f);
        const material = f.el('Material').value;
        const focusCount = f.state.focusEvents.length;
        const pending = f.el('Analyze').onclick();
        assert.equal(f.el('Analyze').disabled, true, '首次点击立即锁定发送按钮');
        assert.equal(f.el('Analyze').textContent, '正在分析…'); assert.equal(f.el('Progress').hidden, false);
        assert.match(f.el('ProgressText').textContent, /\d+\s*秒/);
        const progressTag = f.host.innerHTML.match(/<svg\b[^>]*aria-label="正在处理"[^>]*>/)?.[0];
        assert.ok(progressTag); assert.match(progressTag, /class="modhub-progress-ring"/);
        assert.match(progressTag, /role="progressbar"/);
        assert.match(progressTag, /aria-describedby="modHubAiStatus modHubAiProgressText"/);
        assert.doesNotMatch(progressTag, /aria-valuenow|\bvalue\s*=/, '网络进度使用不定圆环，不显示虚构百分比');
        const progressSection = f.host.innerHTML.slice(f.host.innerHTML.indexOf('id="modHubAiProgress"'), f.host.innerHTML.indexOf('id="modHubAiErrorDetails"'));
        assert.equal((f.host.innerHTML.match(/id="modHubAiCancel"/g) || []).length, 1, '取消分析按钮只有一个');
        assert.match(progressSection, /id="modHubAiCancel"/, '取消按钮与当前阶段、计时位于同一进度区域');
        assert.deepEqual(f.state.focusEvents[focusCount], { id: 'modHubAiStatus', disabled: false }, '首次发送主动聚焦当前阶段');
        assert.ok(!f.state.focusEvents.slice(focusCount).some(event => event.id === 'modHubAiAnalyze' && event.disabled), '发送期间不聚焦已禁用的发送按钮');
        await f.el('Analyze').onclick(); assert.equal(f.state.requests.length, 1, '重复点击不重复调用分析接口');
        await f.settle(); assert.equal(f.el('Analyze').disabled, true, '异步等待后仍保持锁定');
        assert.equal(typeof reportStage, 'function');
        const stageMessages = [];
        for (const stage of ['preflight', 'request', 'response', 'validate']) {
            reportStage(stage);
            assert.equal(f.el('Analyze').disabled, true, '阶段更新不能解锁发送按钮');
            assert.equal(f.el('Analyze').textContent, '正在分析…');
            assert.equal(f.el('Progress').hidden, false); assert.ok(f.el('Status').textContent);
            stageMessages.push(f.el('Status').textContent);
        }
        assert.equal(new Set(stageMessages).size, 4, '核对材料、等待回复、读取结果与验证方案分别呈现当前阶段');
        f.el('Cancel').onclick();
        assert.equal(f.state.requests[0].connection.signal.aborted, true);
        assert.equal(f.el('Analyze').disabled, true, '取消后等待请求收尾，防止提前重发');
        assert.equal(f.el('Progress').hidden, false);
        const cancelStatus = f.el('Status').textContent; reportStage('response');
        assert.equal(f.el('Status').textContent, cancelStatus, '取消后迟到的阶段通知不覆盖取消状态');
        await f.el('Analyze').onclick(); assert.equal(f.state.requests.length, 1);
        resolve({ summary: '取消后迟到结果', evidence: '', verification: '', changes: [], diff: '' }); await pending;
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Analyze').textContent, '发送并分析');
        assert.equal(f.el('Analyze').disabled, false); assert.equal(f.el('Material').value, material);
        assert.equal(f.el('Step2').hidden, false, '已取消的结果不进入待应用方案');
    }
    {
        let reject;
        const f = fixture({ analyze: () => new Promise((resolve, fail) => { reject = fail; }) });
        await f.init(); await start(f); configure(f);
        const pending = f.el('Analyze').onclick(); f.el('Cancel').onclick();
        assert.equal(f.el('Analyze').disabled, true);
        reject(new Error('被取消的网络请求拒绝')); await pending;
        assert.match(f.el('Status').textContent, /已取消分析.*材料仍保留/);
        assert.match(f.el('Status').className, /gold/); assert.doesNotMatch(f.el('Status').className, /red/);
        assert.equal(f.el('ErrorDetails').hidden, true, '正常取消不显示失败错误详情');
        assert.equal(f.el('Error').textContent, ''); assert.equal(f.el('Step2').hidden, false);
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.el('Analyze').textContent, '发送并分析');
    }
    {
        let resolve;
        const f = fixture({ prepare: (prepared, data) => data.paths.length ? prepared : new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); const pending = start(f);
        assert.equal(f.el('Progress').hidden, false, '整理材料期间也提供持续状态');
        assert.equal(f.el('Analyze').disabled, true); assert.equal(f.el('Start').disabled, true);
        await f.settle(); assert.equal(f.el('Progress').hidden, false); assert.equal(f.el('Analyze').disabled, true);
        assert.match(f.el('ProgressText').textContent, /\d+\s*秒/);
        resolve(); await pending;
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Analyze').disabled, false);
        assert.equal(f.el('Analyze').textContent, '发送并分析'); assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture({ analyze: async connection => { connection.onProgress('request'); throw new Error('模型请求失败的具体原因'); } });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.match(f.el('Error').textContent, /模型请求失败的具体原因/);
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Analyze').textContent, '发送并分析');
        assert.equal(f.el('Analyze').disabled, false, '失败收尾后才允许重试');
    }
    {
        let resolve;
        const f = fixture({ prepare: prepared => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); const pending = start(f); await f.settle();
        assert.equal(f.el('Cancel').hidden, true, '只读整理期间不显示没有取消能力的按钮');
        await f.init(); const status = f.el('Status').textContent; resolve(); await pending;
        assert.equal(f.el('Status').textContent, status, '旧整理结果不能覆盖新页面'); assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture({ lines: [{ level: 'info', message: '普通加载信息' }, { level: 'error', message: ' \n\t' }] });
        await f.init();
        assert.equal(f.el('Suggestions').hidden, true, '没有有效错误或警告时不显示猜你想问');
        assert.equal(f.sb.modHubHelp.suggestQuestions(f.state.analysis).length, 0);
        assert.deepEqual(f.calls, [], '生成问题只使用已有日志，不读取模组包体或请求模型');
    }
    {
        const lines = [
            { level: 'warn', message: '较早出现的普通警告', issueIds: [] },
            { level: 'error', message: '天气图像异常', issueIds: ['weather-image-error'] },
            { level: 'error', message: '另一条天气图像异常', issueIds: ['weather-image-error'] },
            { level: 'error', message: '前置加载次序异常', issueIds: ['dependency-order'] },
            { level: 'error', message: '段落补丁未匹配', issueIds: ['twee-patch-mismatch'] },
            { level: 'error', message: '初始化异常', issueIds: ['npc-pregnancy-init-error'] },
        ];
        const f = fixture({ lines }); await f.init();
        const questions = f.sb.modHubHelp.suggestQuestions(f.state.analysis);
        assert.equal(questions.length, 3, '不同分类最多三条');
        assert.deepEqual(Array.from(questions, item => item.error), ['天气图像异常', '前置加载次序异常', '段落补丁未匹配'], '错误优先且同类只保留首条');
        assert.ok(questions.every(item => typeof item.question === 'string' && item.question.endsWith('？') && item.question.length < 120), '建议采用玩家可以直接点选的短问题');
        assert.equal(f.el('Suggestions').hidden, false);
        assert.deepEqual(f.state.suggestionNodes.map(button => button.dataset.aiSuggestion), ['0', '1', '2']);
        assert.equal((f.el('SuggestionList').innerHTML.match(/<button\b[^>]*type="button"/g) || []).length, 3, '使用原生按钮支持键盘操作');
        assert.deepEqual(f.calls, []);
    }
    {
        const f = fixture({ lines: [
            { level: 'warn', message: '未分类警告一', issueIds: [] },
            { level: 'error', message: '未分类错误一', issueIds: ['未知分类'] },
            { level: 'error', message: '未分类错误二', issueIds: [] },
            { level: 'warn', message: '未分类警告二', issueIds: [] },
        ] });
        await f.init();
        const questions = f.sb.modHubHelp.suggestQuestions(f.state.analysis);
        assert.deepEqual(Array.from(questions, item => item.error), ['未分类错误一', '未分类警告一'], '未知分类按错误和警告各给一个通用问题');
    }
    {
        const error = 'TypeError: " onclick="window.fake=1" <img src=x onerror=1>\n' + '完整错误材料'.repeat(850) + '\n原文末尾';
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }], errorMods: ['甲'],
            lines: [{ level: 'error', message: error, mods: ['乙'], issueIds: ['npc-pregnancy-init-error'] }] });
        await f.init();
        f.el('Description').value = '玩家正在输入自己的问题'; f.el('Description').oninput();
        await f.init();
        assert.equal(f.el('Description').value, '玩家正在输入自己的问题', '展示建议不覆盖已有草稿');
        assert.deepEqual(f.calls, []);
        const html = f.el('SuggestionList').innerHTML;
        assert.doesNotMatch(html, /onclick=|<img|原文末尾|data-ai-error|data-ai-mod/, '错误正文和模组名不得写入 HTML 属性');
        assert.ok([...html.matchAll(/data-ai-suggestion="([^"]*)"/g)].every(match => /^\d+$/.test(match[1])));
        const question = f.sb.modHubHelp.suggestQuestions(f.state.analysis)[0].question;
        await f.choose(0);
        assert.equal(f.el('Description').value, question, '只有明确点击后才以所选问题替换草稿');
        assert.equal(f.el('Step2').hidden, false);
        assert.equal(f.el('Target').value, '乙');
        assert.ok(f.state.preparations.every(item => item.name === '乙' && item.description === question && item.logError === error));
        assert.equal(JSON.parse(f.el('Material').value).logError, error, '完整错误通过内存交给材料，不受短问题长度影响');
        assert.ok(!f.calls.includes('请求')); assert.ok(!f.calls.includes('应用'));
        assert.ok(!JSON.stringify([...f.storage]).includes('原文末尾'));
        const calls = [...f.calls]; await f.choose(0);
        assert.deepEqual(f.calls, calls, '进入确认分析后不接受首页旧建议事件');
    }
    {
        const error = '同时提及甲和乙，不能直接判断来源';
        const f = fixture({ targets: [{ name: '甲', enabled: true }, { name: '乙', enabled: true }],
            lines: [{ level: 'error', message: error, mods: ['甲', '乙'], issueIds: [] }] });
        await f.init(); await f.choose(0);
        assert.equal(f.el('Target').value, ''); assert.equal(f.state.preparations.length, 0);
        assert.equal(f.state.logPreparations[0].logError, error, '多个日志模组不写入单一目标，仍可携带完整错误分析日志');
        assert.ok(!f.calls.includes('请求'));
    }
    {
        let resolve;
        const f = fixture({ lines: [{ level: 'error', message: '整理期间不能重复启动', mods: ['测试模组'], issueIds: [] }],
            prepare: (prepared, data) => data.paths.length ? prepared : new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); const pending = f.choose(0); await f.settle();
        assert.equal(f.state.suggestionNodes[0].disabled, true);
        const calls = [...f.calls]; await f.choose(0); assert.deepEqual(f.calls, calls);
        resolve(); await pending;
        assert.equal(f.el('Step2').hidden, false); assert.ok(!f.calls.includes('请求'));
    }
    {
        const f = fixture({ lines: [{ level: 'error', message: '先前天气错误', mods: ['测试模组'], issueIds: ['weather-image-error'] }] });
        await f.init(); await start(f, '玩家自己的问题描述');
        const calls = [...f.calls];
        f.state.analysis.lines = [{ level: 'error', message: '最新前置顺序错误', mods: ['测试模组'], issueIds: ['dependency-order'] }];
        f.el('Back').onclick();
        assert.equal(f.el('Description').value, '玩家自己的问题描述', '返回首屏刷新建议但保留玩家草稿');
        assert.match(f.el('SuggestionList').innerHTML, /前置模组的加载顺序/);
        assert.doesNotMatch(f.el('SuggestionList').innerHTML, /天气或背景/);
        assert.deepEqual(f.calls, calls, '刷新建议只读取已有日志，不读取包体');
        await f.choose(0);
        assert.equal(f.state.preparations.at(-1).logError, '最新前置顺序错误', '刷新后的建议使用当前日志，不沿用旧闭包材料');
        assert.ok(!f.calls.includes('请求'));
    }
    {
        let calls = 0;
        const correction = { name: '测试模组', summary: '请求路径不在真实目录中，需要纠正。', evidence: 'script.js 已提供', verification: '复现原问题',
            changes: [], diff: '', canContinue: true, canTriage: true, responseCorrection: true,
            validationFeedback: { reason: '未声明 modules/eden-cc.js', name: '测试模组', paths: ['modules/eden-cc.js'] } };
        const f = fixture({ autoContinue: true, analyze: () => ++calls === 1 ? correction : f.plan,
            prepareInvestigation: (_plan, _next) => {
                const previous = f.state.requests.at(-1).prepared, body = JSON.parse(previous.material);
                return { ...previous, material: JSON.stringify({ ...body, diagnosisContext: { ...body.diagnosisContext, round: 2, responseCorrection: true, validationFeedback: correction.validationFeedback } }) };
            } });
        await f.init(); await start(f); configure(f); await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 2, '无效请求可在既定预算内向模型纠正一次，同一源码不能阻止校正');
        assert.equal(f.state.investigations.length, 1); assert.equal(f.state.triages.length, 0, '请求纠正优先于重新选择修复对象');
        assert.equal(f.el('Apply').hidden, false); assert.ok(!f.calls.includes('应用'));
    }
    for (const finish of ['方案', '重复无效', '轮次上限']) {
        const catalog = [{ name: '测试模组', version: '1.0.0', files: [{ path: 'script.js', size: 12 }] }];
        const requested = { mode: 'source-request', name: '', summary: '需要核对声明中的原始调用。', evidence: '日志指向 script.js', verification: '按已描述的操作复现',
            changes: [], diff: '', canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对实际报错函数' } };
        const correction = { mode: 'advice', name: '测试模组', summary: '服务回复缺少约定的 changes 字段，尚不能生成可应用的修改。', evidence: '已有完整 script.js 原文',
            verification: '沿用原复现步骤', changes: [], diff: '', canContinue: true, canTriage: false, responseCorrection: true,
            validationFeedback: { kind: 'response-format', reason: '回复缺少 changes 字段：<img src=x onerror=1>' } };
        const repeated = { ...correction, summary: '格式纠正后的回复仍不能通过校验。', notice: correction.validationFeedback.reason,
            canContinue: false, responseCorrection: false, continuationReason: '已自动纠正一次，回复仍不符合格式。已有材料与具体原因保留。' };
        const original = '  打开服装页后点击第一项时发生报错。\n此前步骤和预期结果已在原问题中说明。  ';
        const f = fixture({ autoContinue: true, targets: [], prepareLogs: prepared => withSourceCatalog(prepared, catalog),
            analyze: (_connection, prepared) => {
                const context = JSON.parse(prepared.material).diagnosisContext;
                return context.round === 1 ? requested : context.round === 2 ? correction : finish === '方案' ? f.plan : repeated;
            } });
        await f.init(); configure(f, false, finish === '轮次上限' ? 2 : 5); await start(f, original);
        const scope = f.el('AutoScopeList').innerHTML; await f.el('Analyze').onclick();
        assert.equal(f.state.sourcePreparations.length, 1); assert.equal(f.state.sourcePreparations[0], requested);
        assert.equal(f.state.triages.length, 0, '格式纠正沿用已确定源码，不重新分诊');
        assert.ok(f.state.requests.every(request => request.prepared.description === original && JSON.parse(request.prepared.material).description === original), '纠正回复不要求重写或截断玩家已经描述的问题');
        assert.ok(f.state.requests.every(request => JSON.stringify(request.prepared.sourceCatalog) === JSON.stringify(catalog)), '纠正使用首次授权的完整目录');
        assert.equal(f.el('AutoScopeList').innerHTML, scope, '纠正不扩大已确认的源码范围');
        const sourceBody = JSON.parse(f.state.requests[1].prepared.material);
        assert.deepEqual(sourceBody.files, [{ path: 'script.js', content: '旧原文' }]);
        if (finish === '轮次上限') {
            assert.equal(f.state.requests.length, 2, '无效回复出现在预算末轮时不追加纠正请求');
            assert.equal(f.state.investigations.length, 0, '预算不足时不准备第三轮材料');
            assert.equal(sourceBody.diagnosisContext.maxRounds, 2); assert.match(f.el('NextHint').textContent, /2\s*轮/);
        } else {
            assert.equal(f.state.requests.length, 3, '读源码、纠正回复与重新分析各占一轮');
            assert.equal(f.state.investigations.length, 1, '不规范回复只自动纠正一次');
            const correctedBody = JSON.parse(f.state.requests[2].prepared.material);
            assert.deepEqual(correctedBody.diagnosisContext, { ...sourceBody.diagnosisContext, round: 3, responseCorrection: true, validationFeedback: correction.validationFeedback });
            assert.deepEqual({ ...correctedBody, diagnosisContext: sourceBody.diagnosisContext }, sourceBody, '纠正保留问题、日志、已读源码、范围与预算，只增加本机校验反馈及轮次');
        }
        assert.equal(f.el('Progress').hidden, true); assert.equal(f.el('Continue').hidden, true);
        assert.equal(f.el('Material').value, f.state.requests.at(-1).prepared.material, '停止时保留最后实际发送的材料');
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'), '纠正流程只生成可审阅结果，不确认或写入包体');
        if (finish === '方案') {
            assert.equal(f.el('Apply').hidden, false); assert.equal(f.el('Diff').value, f.plan.diff);
            assert.equal(f.el('LocalRepair').hidden, true);
        } else {
            assert.equal(f.el('Apply').hidden, true); assert.equal(f.el('LocalRepair').hidden, false); assert.equal(f.el('DescribeMore').hidden, false);
            assert.doesNotMatch(f.el('CodeRepairHint').textContent, /请补充|必须.*(补充|说明)/, '格式或预算停止不强制补充已描述的问题');
            if (finish === '重复无效') {
                assert.ok(f.el('Advice').innerHTML.includes(repeated.summary)); assert.equal(f.el('NextHint').textContent, repeated.continuationReason);
                assert.ok(f.el('AdviceDetails').innerHTML.includes(f.sb.modHubEscapeHtml(repeated.notice))); assert.doesNotMatch(f.el('AdviceDetails').innerHTML, /<img|onerror=1>/);
            }
        }
    }
    {
        let resolve;
        const catalog = [{ name: '测试模组', files: [{ path: 'script.js', size: 12 }] }];
        const correction = { name: '测试模组', summary: '回复格式无效，保留已读取的原文并纠正一次。', evidence: '已有完整 script.js', verification: '沿用已描述操作',
            changes: [], diff: '', canContinue: true, responseCorrection: true,
            validationFeedback: { kind: 'response-format', reason: '回复不是约定的 JSON 对象。' } };
        const f = fixture({ autoContinue: true, sourceCatalog: catalog, analyze: () => correction,
            prepareInvestigation: (_plan, prepared) => new Promise(done => { resolve = () => done(prepared); }) });
        await f.init(); await start(f, '原描述已经说明触发步骤'); configure(f);
        const pending = f.el('Analyze').onclick(); await f.settle();
        assert.equal(f.state.requests.length, 1); assert.equal(f.state.investigations.length, 1); assert.equal(f.el('Cancel').disabled, false);
        f.el('Cancel').onclick(); resolve(); await pending;
        assert.equal(f.state.requests.length, 1, '取消后迟到的格式纠正材料不能继续发送');
        assert.equal(f.state.requests[0].connection.signal.aborted, true); assert.equal(f.el('Continue').hidden, true); assert.equal(f.el('Apply').hidden, true);
        const body = JSON.parse(f.el('Material').value);
        assert.equal(body.description, '原描述已经说明触发步骤'); assert.deepEqual(body.files, [{ path: 'script.js', content: '旧原文' }]);
        assert.equal(body.diagnosisContext.responseCorrection, true); assert.equal(body.diagnosisContext.maxRounds, 5);
        assert.ok(f.el('Advice').innerHTML.includes(correction.summary)); assert.match(f.el('Status').textContent, /取消/);
        assert.ok(!f.calls.includes('应用') && !f.calls.includes('确认'));
    }
    {
        const initialGame = [{ passage: 'Start', source: 'modloader', content: '<<initsettings>>', start: 0, end: 16, offset: 0, writable: false }];
        const request = { name: '测试模组', summary: '需要核对源码', evidence: '已有明确线索', verification: '复现',
            changes: [], diff: '', canContinue: true, readRequest: { name: '测试模组', paths: ['script.js'], reason: '核对' } };
        const f = fixture({ autoContinue: true, analyze: async () => request,
            prepare: (prepared, data) => data.includeSources ? { ...prepared, material: JSON.stringify({ ...JSON.parse(prepared.material), gameEvidence: initialGame }) } : prepared,
            prepareRequestedSources: (_plan, prepared) => ({ ...prepared, material: JSON.stringify({ ...JSON.parse(prepared.material), gameEvidence: [...initialGame,
                { passage: '未确认段落', content: '未经预览的游戏原文', source: 'modloader' }] }) }) });
        await f.init(); await start(f); configure(f);
        assert.match(f.el('SelectionSummary').textContent, /游戏段落只读证据/);
        assert.match(f.el('AutoScopeList').innerHTML, /Start.*不能修改/);
        await f.el('Analyze').onclick();
        assert.equal(f.state.requests.length, 1, '后续新增游戏段落必须重新确认，不能自动发送');
        assert.match(f.el('NextHint').textContent, /新材料超出已确认范围/);
        assert.ok(!f.calls.includes('应用'));
    }
    console.log('AI 帮助引导、连接记忆、排查建议、进度锁与取消隔离测试通过');
};
