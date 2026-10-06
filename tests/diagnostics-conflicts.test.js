// ModHub 日志诊断、界面和依赖冲突回归。
const {
    assert, fs, path, vm, srcRoot,
    bootJson, readStyles, createStubElement, createBaseSandbox, loadScripts,
    loadManager, loadMarket,
} = require('./helpers');

module.exports = async function() {
    // 13. 日志分析引擎与快速诊断增强测试（TweeReplacer 补丁冲突精准诊断与段落提取）
    {
        const manager = loadManager();
        const rawLogLines = [
            '17:44:46.245 [错误] [TweeReplacer] do_patch() cannot find findString: [原版优化] findString: [ <<overlayReplace "startFeats">> <</button>> </div>] in: [Widgets Clothing Caption]',
            '17:44:46.250 [错误] [TweeReplacer] do_patch() done: [原版优化] okCount:[31] errorCount:[1]'
        ];

        const analysis = manager.modHubAnalyzeLogs(rawLogLines);

        assert.equal(analysis.errorCount, 2, '两行包含错误标记的日志必须计为 2 条错误日志');
        assert.ok(analysis.errorMods.includes('原版优化'), '必须准确提取报错模组【原版优化】');
        assert.ok(analysis.errorFiles.includes('Widgets Clothing Caption'), '必须准确提取报错段落【Widgets Clothing Caption】');

        assert.equal(analysis.matchedIssues.length, 1, '两行补丁同源错误必须归纳为 1 项知识库命中');
        const issue = analysis.matchedIssues[0];
        assert.equal(issue.id, 'twee-patch-mismatch', '必须精准命中 twee-patch-mismatch 模式，绝不能退化为常规运行时异常');
        assert.ok(issue.desc.includes('原版优化'), '诊断描述中必须包含受影响模组名');
        assert.ok(issue.desc.includes('Widgets Clothing Caption'), '诊断描述中必须包含目标段落名');
        assert.ok(issue.solution.includes('智能整理模组与美化顺序'), '解决方案必须指导使用智能整理或调整次序');
        assert.ok(issue.solution.includes('核心剧情') && issue.solution.includes('可正常游玩'), '对于原版优化顶栏入口补丁冲突必须给出不影响核心游玩的安抚与分析');
    }

    // 截图中的作弊条件是待匹配代码，不能作为模组名，也不能套用管理器入口诊断。
    {
        const manager = loadManager({
            modLoaderGui: { gModUtils: { getModListNameNoAlias: () => ['Cheat-Lyra', 'Lyra', 'Remy Love Mod', 'Love Mod'] } }
        });
        const detail = '[错误] [TweeReplacer] do_patch() cannot find findString: [Cheat-Lyra] findString: [and $cheatsEnabled is true or $debug is 1] in: [StoryCaption]';
        const summary = '[错误] [TweeReplacer] do_patch() done: [Cheat-Lyra] okCount:[6] errorCount:[1]';
        for (const logs of [[detail, summary], [summary, detail]]) {
            const analysis = manager.modHubAnalyzeLogs(logs);
            assert.deepEqual(Array.from(analysis.errorMods), ['Cheat-Lyra', 'TweeReplacer'], '仅补丁来源与框架可作为关联模组，不能提取条件代码或 Lyra 子串');
            assert.deepEqual(Array.from(analysis.errorFiles), ['StoryCaption'], '必须保留真实目标段落');
            const issue = analysis.matchedIssues[0];
            assert.ok(issue.desc.includes('作弊按钮开放条件'), '统计行先出现时，仍应优先使用具体补丁诊断');
            assert.ok(issue.desc.includes('不能确定冲突来源或功能影响'), '不得断定错误来源或保证补丁无害');
            assert.ok(!issue.desc.includes('原版优化') && !issue.solution.includes('完全不会影响'), '作弊补丁不能套用原版优化入口安抚');
            const diagnosis = createStubElement();
            manager.document.getElementById = id => id === 'modHubLogDiagnosisContainer' ? diagnosis : null;
            manager.modHubRenderLogDiagnosis(analysis);
            assert.ok(diagnosis.innerHTML.includes('发现 2 条错误日志'), '界面须按日志行数描述错误计数');
        }
        const regexAnalysis = manager.modHubAnalyzeLogs([
            '[错误] [TweeReplacer] do_patch() cannot find findRegex: [其他模组] findRegex: [and [Lyra] <<link [[入口|StoryCaption]]>>] in: [StoryCaption]'
        ]);
        assert.deepEqual(Array.from(regexAnalysis.errorMods), ['其他模组', 'TweeReplacer'], 'findRegex 正文中的名称与嵌套方括号不得成为模组来源');
        assert.ok(!regexAnalysis.matchedIssues[0].desc.includes('管理器入口'), '同一段落的其他补丁不得套用入口诊断');
        const known = manager.modHubAnalyzeLogs(['[错误] Cheat-Lyra 与 Remy Love Mod 调用失败']);
        assert.deepEqual(Array.from(known.errorMods).sort(), ['Cheat-Lyra', 'Remy Love Mod'], '已知模组须匹配完整名称，不能匹配连字符或空格中的短名称');
        const quoted = manager.modHubAnalyzeLogs(['[错误] modName: "Remy Love Mod"']);
        assert.deepEqual(Array.from(quoted.errorMods), ['Remy Love Mod'], '带空格的名称字段不得被截成首个词');
    }

    // 13.2 怨灵的倒影神庙段落补丁冲突精准诊断与友好建议测试
    {
        const manager = loadManager();
        const rawLogLines = [
            "18:03:49.097 [错误] [TweeReplacer] do_patch() cannot find findString: [Wraith'sReflection] findString:[<<lockicon>><<link [[询问贞操带|Temple Chastity]]>><</link>>] in:[Temple Jordan]",
            "18:03:49.107 [错误] [TweeReplacer] do_patch() done: [Wraith'sReflection] okCount:[75] errorCount:[1]"
        ];

        const analysis = manager.modHubAnalyzeLogs(rawLogLines);

        assert.equal(analysis.errorCount, 2, '两行错误日志必须计为 2 条错误日志');
        assert.ok(analysis.errorMods.includes("Wraith'sReflection"), '必须准确提取报错模组 Wraith\'sReflection');
        assert.ok(analysis.errorFiles.includes('Temple Jordan'), '必须准确提取报错段落 Temple Jordan');

        assert.equal(analysis.matchedIssues.length, 1, '同源错误必须归纳为 1 项知识库命中');
        const issue = analysis.matchedIssues[0];
        assert.equal(issue.id, 'twee-patch-mismatch', '必须精准命中 twee-patch-mismatch 模式');
        assert.ok(issue.desc.includes('怨灵的倒影'), '描述中必须包含友好中文别名【怨灵的倒影】');
        assert.ok(issue.desc.includes('Temple Jordan'), '描述中必须包含目标段落名 Temple Jordan');
        assert.ok(issue.desc.includes('汉化') || issue.desc.includes('银海螺'), '描述中必须说明汉化环境或分支选项原因');
        assert.ok(issue.solution.includes('不必担心') && issue.solution.includes('怨灵恋爱核心剧情'), '必须给出定心丸说明不影响恋爱核心剧情');
        assert.ok(issue.solution.includes('智能整理模组与美化顺序'), '解决方案必须指导使用智能整理模组与美化顺序');
        const diagnosis = createStubElement();
        manager.document.getElementById = id => id === 'modHubLogDiagnosisContainer' ? diagnosis : null;
        manager.modHubRenderLogDiagnosis(analysis);
        assert.ok(diagnosis.innerHTML.includes('怨灵的倒影'), '独立日志模块必须通过共享接口渲染中文别名');
    }

    // 早期恢复日志与常规捕获器、原版日志重复时只显示一次，独立错误不能被同类关键词吞掉。
    {
        const nativeError = '[TweeReplacer] do_patch() cannot find findString: [ModA] findString: [原文] in: [Example]';
        const otherError = '[TweeReplacer] do_patch() cannot find findString: [ModB] findString: [原文] in: [Example]';
        const runtimeError = 'TypeError: 启动对象未定义\nstartup@game.html:12:3';
        const earlyLogs = [
            '[脚本异常] ' + runtimeError,
            '[控制台报错] ' + nativeError,
            { message: '[控制台报错] ' + otherError, level: 'error', time: '11:00:00' },
            { message: '早期恢复入口已就绪', level: 'info', time: '11:00:01' },
            { message: '早期恢复警告', level: 'warning', time: Date.now() }
        ];
        const nativeLogs = [{ type: 'error', str: nativeError }, { type: 'info', str: '' }];
        const manager = loadManager({
            modLoaderGui: { gLoadingProgress: { logList: nativeLogs } },
            modHubRestore: { getStartupLogs: () => earlyLogs }
        });
        manager._modHubStartupErrors.push('[控制台报错] ' + runtimeError);
        const logs = manager.modHubGetRawModLoaderLogs();
        const analysis = manager.modHubAnalyzeLogs(logs);
        assert.equal(analysis.errorCount, 3, '早期与常规捕获重复的运行时错误、原版补丁错误分别只保留一次');
        assert.equal(logs.filter(item => item.message.includes(runtimeError)).length, 1, '不同捕获前缀的同一堆栈必须跨流去重');
        assert.equal(logs.filter(item => item.message.includes(nativeError)).length, 1, '原版已有的早期日志不得再次导入');
        assert.equal(logs.find(item => item.message.includes(otherError)).time, '11:00:00', '不同模组的同类错误不得被合并且须保留时间');
        assert.equal(logs.find(item => item.message === '早期恢复入口已就绪').level, 'info', '结构化早期日志须保留真实级别');
        const warning = logs.find(item => item.message === '早期恢复警告');
        assert.equal(warning.level, 'warn', '恢复模块的 warning 级别不得误记为 error');
        assert.match(warning.time, /^\d{1,2}:\d{2}:\d{2}$/, '早期数值时间戳须转换为可读时间');
        assert.equal(nativeLogs.length, 2, '合并不得修改原版日志');
        assert.equal(earlyLogs.length, 5, '合并不得修改早期捕获数据');
        manager.modHubRestore.getStartupLogs = () => { throw new Error('日志接口暂不可用'); };
        assert.doesNotThrow(() => manager.modHubGetRawModLoaderLogs(), '早期日志接口失败不得破坏现有日志查看');
    }

    // 真实早期模块先捕获异常，常规脚本稍后加载时仍须合并且不重复计算。
    {
        const listeners = {};
        let earlyHook;
        const controller = { addLifeTimeCircleHook: (name, hook) => { earlyHook = hook; } };
        const loader = {
            constructor: { dbName: '阶段测试库', storeName: '阶段测试库', modDataIndexDBZipList: '启用', modDataIndexDBZipListHidden: '禁用', calcModNameKey: name => '包:' + name },
            customStore: () => Promise.reject(new Error('阶段测试不提供持久层'))
        };
        const manager = createBaseSandbox({
            indexedDB: {}, modModLoadController: controller,
            modUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader }) },
            addEventListener: (type, listener) => { listeners[type] = listener; },
            console: { error() {}, warn() {}, log() {} }
        });
        loadScripts(manager, bootJson.scriptFileList_inject_early);
        await manager.modHubRestore.startupReady;
        assert.ok(earlyHook && typeof listeners.error === 'function', 'inject_early 阶段必须注册错误与加载日志捕获');
        earlyHook.logWarning('分阶段加载警告');
        listeners.error({ message: 'TypeError: 分阶段启动异常' });
        loadScripts(manager, bootJson.scriptFileList.filter(file => file !== 'javascript/modhub-market.js'));
        manager.console.error('TypeError: 分阶段启动异常');
        const analysis = manager.modHubAnalyzeLogs(manager.modHubGetRawModLoaderLogs());
        assert.equal(analysis.errorCount, 1, '早期与常规捕获器的同一异常须只显示一次');
        assert.equal(analysis.warnCount, 1, '真实早期模块的 warning 日志须保留为警告');
        assert.ok(analysis.lines.some(line => line.message.includes('分阶段启动异常')), '正常模块加载后仍可查看早期异常');
    }

    // 13.3 启动错误对象不能因消息缺少 Error 字样而漏记，原版日志仍保持独立
    {
        const forwarded = [];
        const manager = loadManager({
            console: {
                error(...args) { forwarded.push({ context: this, args }); return '已转发'; }
            },
            modLoaderGui: {
                gLoadingProgress: { logList: [{ type: 'info', str: 'ModLoader startInit() start' }] }
            }
        });
        const firstError = vm.runInContext("new TypeError('ev.preventDefault is not a function')", manager, { filename: 'tw-user-script-0' });
        const detail = { source: '启动脚本' };
        const originalContext = {};
        assert.equal(manager.console.error.call(originalContext, firstError, detail), '已转发', '捕获器必须保留原 console.error 返回值');
        assert.equal(manager._modHubStartupErrors.length, 1, '消息中不含 Error 字样的 TypeError 也必须捕获');
        assert.ok(manager._modHubStartupErrors[0].includes('TypeError: ev.preventDefault is not a function'), '必须保留原始异常类型与消息');
        assert.ok(manager._modHubStartupErrors[0].includes('tw-user-script-0:1:'), '必须保留异常堆栈中的脚本位置');
        assert.equal(manager._modHubStartupErrors[0].split('TypeError: ev.preventDefault is not a function').length, 2, '堆栈已含异常摘要时不得重复添加摘要');
        assert.equal(forwarded[0].context, originalContext, '必须保留原 console.error 调用上下文');
        assert.equal(forwarded[0].args[0], firstError, '必须原样转发异常对象');
        assert.equal(forwarded[0].args[1], detail, '必须原样转发附加参数');

        manager.console.error(vm.runInContext(`new Error("0.5.11.9 Error (:: ): <<variablesStatic>>: TypeError: Cannot read properties of undefined (reading 'Init')")`, manager));
        manager.console.error('普通控制台提示');
        manager.console.error(new Error('modList.json 读取失败'));
        manager.console.error(new Error('ResizeObserver loop limit exceeded'));
        assert.equal(manager._modHubStartupErrors.length, 2, '后续 StoryInit 异常必须保留，普通提示与良性降级不得误报');
        assert.equal(forwarded.length, 5, '捕获或过滤日志都必须原样转发且仅转发一次');

        const loaderLogs = manager.modLoaderGui.gLoadingProgress.logList;
        assert.equal(loaderLogs.filter(item => item.type === 'error').length, 0, '不得将运行时异常写入原版 ModLoader 日志');
        const analysis = manager.modHubAnalyzeLogs(manager.modHubGetRawModLoaderLogs());
        assert.equal(analysis.errorCount, 2, '原版日志无错误时，合并日志仍须显示两个运行时异常');
        assert.equal(analysis.infoCount, 1, '合并日志必须保留原版信息日志');

        const noStackError = new ReferenceError('启动变量未定义');
        delete noStackError.stack;
        manager.console.error(noStackError);
        assert.equal(manager._modHubStartupErrors[2], '[控制台报错] ReferenceError: 启动变量未定义', '无堆栈的异常也必须保留类型并正常捕获');
        const firefoxError = new TypeError('启动对象不可用');
        firefoxError.stack = 'startup@file:///game.html:12:3';
        manager.console.error(firefoxError);
        assert.equal(manager._modHubStartupErrors[3], '[控制台报错] TypeError: 启动对象不可用\nstartup@file:///game.html:12:3', '堆栈不含类型摘要时必须补充摘要并保留原堆栈');
        assert.equal(forwarded.length, 7, '不同堆栈格式不得影响原日志转发');
    }

    // 外部名称或别名查询日志保留错误级别，只修正诊断解释，不认定查询无害。
    {
        const forwarded = [];
        const manager = loadManager({ console: { error(...args) { forwarded.push(args); } } });
        const message = 'ModOrderContainer getByNameOneWithAlias() cannot find name/alias.';
        const details = ['Remy Love Mod', { source: '外部查询' }];
        manager.console.error(message, details);
        const rawLogs = manager.modHubGetRawModLoaderLogs();
        const analysis = manager.modHubAnalyzeLogs(rawLogs);
        assert.equal(analysis.errorCount, 1, '外部查询未命中仍须计入错误，不得静默隐藏');
        assert.ok(analysis.lines[0].message.includes(message) && analysis.lines[0].message.includes('Remy Love Mod'), '必须保留原查询日志与目标名称');
        assert.deepEqual(Array.from(analysis.matchedIssues, issue => issue.id), ['mod-name-lookup-miss'], '完整来源和查询签名必须命中专项诊断');
        assert.equal(forwarded.length, 1, '原控制台日志只能转发一次');
        assert.equal(forwarded[0][0], message, '控制台消息必须原样转发');
        assert.equal(forwarded[0][1], details, '控制台附加参数必须原样转发');
        assert.equal(manager._modHubPendingAutoOpenErrorLog, true, '外部查询日志仍须保留自动提示');

        const diagnosis = createStubElement();
        manager.document.getElementById = id => id === 'modHubLogDiagnosisContainer' ? diagnosis : null;
        manager.modHubRenderLogDiagnosis(analysis);
        assert.ok(diagnosis.innerHTML.includes('模组名称或别名查询未命中'), '界面必须显示具体查询诊断');
        assert.ok(diagnosis.innerHTML.includes('不能确认是否影响游戏'), '诊断不得把未命中认定为无害');
        assert.ok(!diagnosis.innerHTML.includes('抛出了未捕获的错误'), '普通控制台查询日志不得被解释为未捕获异常');
        manager.modHubIsGameStartupReady = () => true;
        const openedTabs = [];
        manager.modHubOpenManager = tab => { openedTabs.push(tab); return true; };
        assert.equal(manager.modHubCheckAndAutoOpenErrorLog(), true, '专项诊断不得关闭既有自动提示流程');
        assert.deepEqual(openedTabs, ['加载日志'], '外部查询报错仍须自动打开加载日志');

        const mixed = manager.modHubAnalyzeLogs([
            ...rawLogs,
            '[错误] cannot find mod RequiredFramework',
            '[错误] TypeError: Cannot read properties of undefined',
            '[错误] [TweeReplacer] do_patch() cannot find findString: [剧情模组] findString: [待替换] in: [Example]'
        ]);
        assert.equal(mixed.errorCount, 4, '查询未命中不得掩盖同时出现的其他错误');
        for (const id of ['mod-name-lookup-miss', 'missing-dep', 'type-error', 'twee-patch-mismatch']) {
            assert.ok(mixed.matchedIssues.some(issue => issue.id === id), `混合日志必须保留 ${id} 诊断`);
        }

        const unmatched = manager.modHubAnalyzeLogs([
            '[控制台报错] Error: 未分类启动失败',
            '[控制台报错] 其他组件 cannot find name/alias. Unknown Mod'
        ]);
        assert.equal(unmatched.errorCount, 2, '未分类错误仍须保留错误计数');
        assert.equal(unmatched.matchedIssues.length, 0, '相似关键词不得误套特定查询来源的诊断');
        manager.modHubRenderLogDiagnosis(unmatched);
        assert.ok(diagnosis.innerHTML.includes('未分类的错误日志'), '未命中知识库时必须显示中性回退');
        assert.ok(diagnosis.innerHTML.includes('需要结合原始日志和调用上下文确认'), '通用回退必须保留影响不确定性');
        assert.ok(!diagnosis.innerHTML.includes('抛出了未捕获的错误') && !diagnosis.innerHTML.includes('最近安装的第三方模组'), '通用回退不得臆断异常类型或来源');
    }

    // 模组附加档案里的函数、依赖和补丁字段不得制造控制台启动报错。
    {
        const forwarded = [];
        const manager = loadManager({ console: { error(...args) { forwarded.push(args); } } });
        const modInfo = {
            name: '说明测试',
            cache: { error: ['(revive:eval)', '(s) => c.logError(s)'] },
            bootJson: {
                additionFile: [],
                dependenceInfo: [{ modName: 'TweeReplacer' }],
                addonPlugin: [{ modName: 'ReplacePatcher', replaceFile: 'example.twee' }],
            },
        };
        const details = ['说明测试', modInfo, []];
        manager.console.error('getModReadMe() (!additionFile || isArray(additionFile) && additionFile.length == 0)', details);
        manager.console.error('读取可选说明', modInfo);
        const analysis = manager.modHubAnalyzeLogs(manager.modHubGetRawModLoaderLogs());
        assert.equal(manager._modHubStartupErrors.length, 0, '说明缺失和附加档案不得因 logError 字段误记为启动异常');
        assert.equal(Boolean(manager._modHubPendingAutoOpenErrorLog), false, '说明缺失不得自动打开加载日志');
        assert.equal(analysis.errorCount, 0, '说明缺失不得制造加载错误');
        assert.equal(analysis.matchedIssues.length, 0, '模组档案不得制造依赖和补丁冲突诊断');
        assert.equal(forwarded[0][1], details, '未捕获的说明提示仍原样转发控制台');

        manager.console.error('getModReadMe() failed', new TypeError('Failed to fetch'), modInfo);
        assert.equal(manager._modHubStartupErrors.length, 1, '真实 ReadMe 网络异常仍必须捕获');
        assert.ok(manager._modHubStartupErrors[0].includes('TypeError: Failed to fetch'), '真实异常必须保留类型和消息');
        assert.ok(manager._modHubStartupErrors[0].includes('example.twee'), '真实异常必须保留附加档案以供排查');
        manager.console.error('Error: 启动脚本失败', { source: 'modList.json' });
        assert.equal(manager._modHubStartupErrors.length, 2, '附加上下文的良性关键词不得掩盖真实错误');
        assert.equal(forwarded.length, 4, '说明提示和真实错误均应只转发一次');
    }

    // 13.4 全局异步与脚本异常保留类型、堆栈和后备位置
    {
        const events = new Map();
        const manager = loadManager({
            console: { error() {}, warn() {}, log() {} },
            addEventListener: (name, handler) => events.set(name, handler),
        });
        const asyncError = vm.runInContext("new TypeError('异步对象不可用')", manager, { filename: 'async-startup.js' });
        events.get('unhandledrejection')({ reason: asyncError });
        assert.equal(manager._modHubStartupErrors[0], `[异步异常] ${asyncError.stack}`, '异步异常必须完整保留类型与堆栈且不重复摘要');

        const scriptError = vm.runInContext("new TypeError('脚本对象不可用')", manager, { filename: 'script-startup.js' });
        events.get('error')({ message: scriptError.message, error: scriptError, filename: 'game.html', lineno: 12, colno: 3 });
        assert.ok(manager._modHubStartupErrors[1].includes(scriptError.stack), '脚本异常必须保留 event.error 的完整堆栈');
        events.get('error')({ message: '后备位置异常', filename: 'fallback.js', lineno: 12, colno: 3 });
        assert.equal(manager._modHubStartupErrors[2], '[脚本异常] 后备位置异常 (fallback.js:12:3)', '无异常对象时必须保留文件、行号和列号');

        const firefoxError = new TypeError('异步对象不可用');
        firefoxError.stack = 'saveList@file:///game.html:12:3';
        events.get('unhandledrejection')({ reason: firefoxError });
        assert.equal(manager._modHubStartupErrors[3], '[异步异常] TypeError: 异步对象不可用\nsaveList@file:///game.html:12:3', 'Firefox 异步堆栈缺少摘要时必须补充类型和消息');
        const noStackError = new ReferenceError('异步变量未定义');
        delete noStackError.stack;
        events.get('unhandledrejection')({ reason: noStackError });
        assert.equal(manager._modHubStartupErrors[4], '[异步异常] ReferenceError: 异步变量未定义', '无堆栈异步异常仍必须保留类型和消息');
    }

    // 已有异常中的资源事件保留不可枚举的目标路径，不新增浏览器资源错误捕获。
    {
        const events = new Map();
        const forwarded = [];
        let prevented = 0;
        let stopped = 0;
        const manager = loadManager({
            console: { error(...args) { forwarded.push({ context: this, args }); return '资源日志已转发'; } },
            addEventListener: (name, handler, options) => events.set(name, { handler, options }),
        });
        const makeEvent = target => Object.defineProperties(typeof Event === 'function' ? new Event('error') : {}, {
            type: { value: 'error', configurable: true },
            target: { value: target, configurable: true },
            currentTarget: { value: null, configurable: true },
            preventDefault: { value: () => { prevented++; } },
            stopPropagation: { value: () => { stopped++; } },
        });
        const imgEvent = makeEvent({ tagName: 'IMG', currentSrc: 'img/misc/sky/clouds/cirrus/0.png', src: 'img/misc/sky/clouds/overcast/0.png' });
        assert.equal(Object.getOwnPropertyDescriptor(imgEvent, 'target').enumerable, false, '资源事件目标必须不可枚举');
        assert.ok(!JSON.stringify(imgEvent).includes('img/misc/sky/clouds/cirrus/0.png'), '普通 JSON 序列化不能读取资源事件目标路径');
        if (typeof Event === 'function') assert.ok(imgEvent instanceof Event, 'Node 支持 Event 时必须使用外部上下文的原生 Event 验证');
        const errorListener = events.get('error');
        assert.ok(errorListener.options === undefined || errorListener.options === false, '脚本错误监听不得扩展到资源错误捕获阶段');
        const resourceEvents = [
            [imgEvent, 'IMG error img/misc/sky/clouds/cirrus/0.png'],
            [makeEvent({ tagName: 'SCRIPT', src: 'javascript/weather.js' }), 'SCRIPT error javascript/weather.js'],
            [makeEvent({ tagName: 'LINK', href: 'stylesheet/weather.css' }), 'LINK error stylesheet/weather.css'],
        ];
        for (const [event] of resourceEvents) {
            assert.doesNotThrow(() => errorListener.handler(event), '无 message 的资源事件不得影响原脚本错误监听');
        }
        assert.equal(manager._modHubStartupErrors.length, 0, '无 message 的 IMG、SCRIPT、LINK 资源事件不得升级为启动异常');
        assert.equal(Boolean(manager._modHubHasDetectedStartupError), false, '资源错误不得单独设置启动异常标志');
        assert.equal(Boolean(manager._modHubPendingAutoOpenErrorLog), false, '资源错误不得单独触发启动日志弹窗');
        imgEvent.circular = imgEvent;
        const originalError = vm.runInContext("new TypeError('天气渲染异常')", manager, { filename: 'weather-renderer.js' });
        const originalContext = {};
        assert.equal(manager.console.error.call(originalContext, originalError, imgEvent), '资源日志已转发', '循环资源事件不得影响原 console.error 返回值');
        assert.ok(manager._modHubStartupErrors[0].includes(originalError.stack), '资源事件附加参数不得改写异常堆栈');
        assert.ok(manager._modHubStartupErrors[0].includes('资源加载失败: IMG error img/misc/sky/clouds/cirrus/0.png'), '不可枚举的资源事件必须保留 currentSrc 路径');
        assert.ok(!manager._modHubStartupErrors[0].includes('img/misc/sky/clouds/overcast/0.png'), 'IMG 已有 currentSrc 时不得改用 src');
        assert.equal(forwarded[0].context, originalContext, '资源摘要不得改变原 console.error 的 this');
        assert.equal(forwarded[0].args[0], originalError, '原控制台必须收到同一异常对象');
        assert.equal(forwarded[0].args[1], imgEvent, '原控制台必须收到同一循环事件对象');

        for (const [event, expected] of resourceEvents) {
            assert.doesNotThrow(() => events.get('unhandledrejection').handler({ reason: event }), 'Promise 拒绝中的资源事件必须安全格式化');
            assert.equal(manager._modHubStartupErrors.at(-1), `[异步异常] 资源加载失败: ${expected}`, '必须区分 IMG、SCRIPT、LINK 并保留真实资源路径');
        }
        const resourceAnalysis = manager.modHubAnalyzeLogs(manager.modHubGetRawModLoaderLogs());
        assert.ok(resourceAnalysis.errorFiles.includes('img/misc/sky/clouds/cirrus/0.png'), '合并日志分析必须保留资源事件路径');
        assert.ok(resourceAnalysis.errorFiles.includes('javascript/weather.js'), '脚本资源路径必须可供诊断检索');
        assert.ok(resourceAnalysis.errorFiles.includes('stylesheet/weather.css'), '样式资源路径必须可供诊断检索');

        const fallbackImage = { tagName: 'IMG', src: 'img/misc/sky/clouds/overcast/0.png' };
        Object.defineProperty(fallbackImage, 'currentSrc', { get() { throw new Error('资源 getter 已失效'); } });
        const fallbackEvent = makeEvent(null);
        Object.defineProperties(fallbackEvent, {
            target: { get() { throw new Error('target getter 已失效'); } },
            currentTarget: { value: fallbackImage },
            message: { get() { throw new Error('message getter 已失效'); } },
        });
        assert.doesNotThrow(() => events.get('unhandledrejection').handler({ reason: fallbackEvent }), '失效的事件和图像 getter 不得使异常格式化失败');
        assert.equal(manager._modHubStartupErrors.at(-1), '[异步异常] 资源加载失败: IMG error img/misc/sky/clouds/overcast/0.png', '失效的 target 和 currentSrc 必须回退至 currentTarget.src');
        assert.doesNotThrow(() => manager.console.error.call(originalContext, fallbackEvent), '失效 getter 不得阻断原控制台');
        assert.equal(forwarded[1].context, originalContext, 'getter 异常时仍须保留原控制台调用上下文');
        assert.equal(forwarded[1].args[0], fallbackEvent, 'getter 异常时仍须原样且仅一次转发事件');

        const ordinaryEvent = makeEvent({ tagName: 'DIV', src: 'img/irrelevant.png' });
        const beforeOrdinary = manager._modHubStartupErrors.length;
        errorListener.handler(ordinaryEvent);
        manager.console.error(ordinaryEvent);
        assert.equal(manager._modHubStartupErrors.length, beforeOrdinary, '普通非资源 Event 不得制造全局资源或控制台异常');
        events.get('unhandledrejection').handler({ reason: ordinaryEvent });
        assert.equal(manager._modHubStartupErrors.at(-1), '[异步异常] Event: error', 'Promise 拒绝中的普通 Event 必须保留事件类型');
        const eventAnalysis = manager.modHubAnalyzeLogs([manager._modHubStartupErrors.at(-1)]);
        assert.equal(eventAnalysis.errorCount, 1, '不含 Error 字样的异步事件也必须按异常前缀计为错误');
        assert.equal(eventAnalysis.errorFiles.length, 0, '普通 Event 不得伪造资源路径');
        assert.equal(eventAnalysis.matchedIssues.length, 0, '普通 Event 不得被归因于天气或美化缺图');

        const inlineEvent = makeEvent({ tagName: 'IMG', src: `data:image/png;base64,${'A'.repeat(100000)}` });
        events.get('unhandledrejection').handler({ reason: inlineEvent });
        assert.equal(manager._modHubStartupErrors.at(-1), '[异步异常] 资源加载失败: IMG error data:image/png（内联资源）', '巨大 data URI 必须只保留资源类型，不能复制完整 base64');
        events.get('unhandledrejection').handler({ reason: makeEvent({ tagName: 'IMG', src: `data:${'A'.repeat(100000)};base64,AAAA` }) });
        assert.equal(manager._modHubStartupErrors.at(-1), '[异步异常] 资源加载失败: IMG error data:（内联资源）', '畸形超长媒体类型也不得扩大内联资源摘要');
        const blobEvent = makeEvent({ tagName: 'IMG', src: 'blob:https://game.example/private-resource-token' });
        events.get('unhandledrejection').handler({ reason: blobEvent });
        assert.equal(manager._modHubStartupErrors.at(-1), '[异步异常] 资源加载失败: IMG error blob:（临时资源）', 'blob URI 不得带出临时资源标识');
        for (const source of ['https://game.example/img/misc/sky/clouds/cirrus/0.png', 'file:///game/img/misc/sky/clouds/cirrus/0.png']) {
            events.get('unhandledrejection').handler({ reason: makeEvent({ tagName: 'IMG', src: source }) });
            assert.equal(manager._modHubStartupErrors.at(-1), `[异步异常] 资源加载失败: IMG error ${source}`, 'HTTP 与本地文件资源必须保留可定位的完整路径');
        }

        const invalidEvent = makeEvent(null);
        Object.defineProperties(invalidEvent, {
            type: { get() { throw new Error('type getter 已失效'); } },
            target: { get() { throw new Error('target getter 已失效'); } },
            currentTarget: { get() { throw new Error('currentTarget getter 已失效'); } },
            message: { get() { throw new Error('message getter 已失效'); } },
        });
        const beforeInvalid = manager._modHubStartupErrors.length;
        assert.doesNotThrow(() => errorListener.handler(invalidEvent), '全部事件字段失效时监听器仍不得抛错');
        assert.equal(manager._modHubStartupErrors.length, beforeInvalid, '无法识别的事件不得伪造资源异常');
        assert.equal(manager.console.error.call(originalContext, invalidEvent), '资源日志已转发', '无法读取的事件仍须返回原控制台结果');
        assert.equal(forwarded.length, 4, '资源、普通与失效事件均只能原样转发一次');
        assert.equal(forwarded[3].args[0], invalidEvent, '全部 getter 失效时仍必须保留事件对象引用');
        assert.equal(prevented, 0, '诊断监听器不得调用 preventDefault 改变浏览器错误处理');
        assert.equal(stopped, 0, '诊断监听器不得阻止事件传播');
    }

    // 天气连锁错误只合并诊断卡片，保留每条错误；其他模块与美化错误仍独立诊断。
    {
        const manager = loadManager({ console: { error() {}, warn() {}, log() {} } });
        const effects = ['bannerCirrusClouds', 'bannerOvercastClouds', 'rainbow', 'bannerClouds', 'location', 'bannerPrecipitation'];
        const weatherRows = effects.map((effect, index) => ({
            level: 'error',
            message: `Error during effect '${effect}': Error: randomInt called with invalid parameters: ${index % 2 ? 'undefined, NaN' : 'NaN, NaN'}`,
        }));
        weatherRows[0].message = `Error during effect ' bannerCirrusClouds ' init function. Error: Error: randomInt called with invalid parameters, {"0":["(revive:eval)","NaN"],"1":["(revive:eval)","NaN"]} at Weather.Renderer.Sky.setupCanvas`;
        weatherRows[1].message = `Error during effect ' bannerOvercastClouds ' init function. Error: Error: randomInt called with invalid parameters, {"0":["(revive:eval)","0"],"1":["(revive:eval)","undefined"]} at Weather.Renderer.Sky.setupCanvas`;
        weatherRows.push(
            { level: 'error', message: 'Weather.Renderer.Sky Error: randomInt called with invalid parameters: 0, undefined' },
            { level: 'error', message: "Weather.Renderer.Sky TypeError: Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The provided value is not of type HTMLImageElement at img/misc/sky/clouds/overcast/0.png" },
        );
        const weather = manager.modHubAnalyzeLogs(weatherRows);
        assert.equal(weather.errorCount, weatherRows.length, '多种天气 effect、参数范围和 drawImage 错误必须全部计数');
        assert.equal(weather.lines.length, weatherRows.length, '合并诊断不得删除或压缩原始错误行');
        assert.deepEqual(Array.from(weather.lines, line => line.message), weatherRows.map(row => row.message), '每条天气错误的 effect、参数与图像路径必须原样保留');
        assert.deepEqual(Array.from(weather.matchedIssues, issue => issue.id), ['weather-image-error'], '同一组天气错误只显示一条具体诊断，不附通用 TypeError 或美化缺图卡片');
        assert.ok(weather.errorFiles.includes('img/misc/sky/clouds/overcast/0.png'), '天气专用分类不能隐藏原始图像路径');
        assert.ok(weather.matchedIssues[0].desc.includes('可能'), '天气诊断必须保留图片加载原因尚待核实的边界');

        const independentRows = [
            { level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'isTrusted') at tw-user-script-0.js:12" },
            { level: 'error', message: 'NPCPetSlot.mount failed to load resource img/hands/left.png 404' },
        ];
        const mixed = manager.modHubAnalyzeLogs([...weatherRows, ...independentRows]);
        assert.equal(mixed.errorCount, weatherRows.length + independentRows.length, '独立脚本和美化错误必须继续计数');
        assert.deepEqual(Array.from(mixed.matchedIssues, issue => issue.id).sort(), ['asset-missing', 'type-error', 'weather-image-error'], '天气分类不得遮蔽独立的 TypeError 和美化资源缺失');
        assert.ok(mixed.errorFiles.includes('img/hands/left.png'), '独立美化资源错误仍必须保留路径');

        const unrelatedRows = [
            { level: 'error', message: 'Inventory Error: randomInt called with invalid parameters: NaN, undefined' },
            { level: 'error', message: "Avatar TypeError: drawImage: The provided value is not of type HTMLImageElement at img/avatar.png" },
            { level: 'error', message: "Error during effect 'bannerCloudsExtra': Error: randomInt called with invalid parameters: NaN, NaN" },
            { level: 'error', message: 'Weather.Renderer.Sky Error: randomInt called with invalid parameters: 0, 0' },
            { level: 'error', message: 'Weather.Renderer.Sky Error: drawImage canvas is unavailable' },
            { level: 'error', message: "Error during effect 'rainbow': Error: undefined state" },
        ];
        const unrelated = manager.modHubAnalyzeLogs(unrelatedRows);
        assert.equal(unrelated.errorCount, unrelatedRows.length, '未匹配天气诊断的异常仍全部保留');
        assert.ok(!unrelated.matchedIssues.some(issue => issue.id === 'weather-image-error'), '其他模块的 NaN、drawImage 及不完整天气线索不得误判为天气缺图');
        assert.ok(unrelated.matchedIssues.some(issue => issue.id === 'type-error'), '其他模块的 drawImage TypeError 仍须使用通用诊断');
        assert.ok(unrelated.matchedIssues.some(issue => issue.id === 'asset-missing'), '其他模块的图像路径仍须参与资源诊断');
    }

    // 诊断模块只读取资源信息，不改写游戏图像构造器、画布方法或随机数状态。
    {
        function TestImage() {}
        function TestHTMLImageElement() {}
        function TestHTMLCanvasElement() {}
        function TestCanvasRenderingContext2D() {}
        const drawImage = function() { return '原画布方法'; };
        TestCanvasRenderingContext2D.prototype.drawImage = drawImage;
        const randomInt = () => 7;
        const random = () => 0.25;
        const math = Object.create(Math);
        math.random = random;
        const prng = { seed: '诊断测试', pull: 12, random };
        const state = { prng };
        const sugarCube = { State: state };
        const sandbox = createBaseSandbox({
            console: { error() {}, warn() {}, log() {} },
            Image: TestImage,
            HTMLImageElement: TestHTMLImageElement,
            HTMLCanvasElement: TestHTMLCanvasElement,
            CanvasRenderingContext2D: TestCanvasRenderingContext2D,
            Math: math,
            randomInt,
            State: state,
            SugarCube: sugarCube,
        });
        const defineProperty = vm.runInContext('Object.defineProperty', sandbox);
        const imagePrototype = Object.getOwnPropertyDescriptors(TestImage.prototype);
        const canvasPrototype = Object.getOwnPropertyDescriptors(TestCanvasRenderingContext2D.prototype);
        loadScripts(sandbox, bootJson.scriptFileList.filter(file => file !== 'javascript/modhub-market.js'));
        assert.equal(sandbox.Image, TestImage, '诊断模块不得代理或替换 Image');
        assert.equal(sandbox.HTMLImageElement, TestHTMLImageElement, '诊断模块不得替换 HTMLImageElement');
        assert.equal(sandbox.HTMLCanvasElement, TestHTMLCanvasElement, '诊断模块不得替换 HTMLCanvasElement');
        assert.equal(sandbox.CanvasRenderingContext2D, TestCanvasRenderingContext2D, '诊断模块不得替换画布上下文构造器');
        assert.deepEqual(Object.getOwnPropertyDescriptors(TestImage.prototype), imagePrototype, '诊断模块不得修改 Image 原型');
        assert.deepEqual(Object.getOwnPropertyDescriptors(TestCanvasRenderingContext2D.prototype), canvasPrototype, '诊断模块不得修改 drawImage 或画布原型');
        assert.equal(vm.runInContext('Object.defineProperty', sandbox), defineProperty, '诊断模块不得改写 Object.defineProperty');
        assert.equal(sandbox.Math, math, '诊断模块不得替换 Math');
        assert.equal(sandbox.Math.random, random, '诊断模块不得拦截 Math.random');
        assert.equal(sandbox.randomInt, randomInt, '诊断模块不得替换游戏 randomInt');
        assert.equal(sandbox.State, state, '诊断模块不得替换 SugarCube 状态');
        assert.equal(sandbox.SugarCube, sugarCube, '诊断模块不得替换 SugarCube');
        assert.equal(sandbox.SugarCube.State.prng, prng, '诊断模块不得替换 PRNG 状态');
        assert.deepEqual(prng, { seed: '诊断测试', pull: 12, random }, '诊断模块不得消耗或改写 PRNG 种子与计数');
    }

    // 13.5 截图明确显示筛选后总数与省略数，保留前一百行截取策略
    {
        const manager = loadManager();
        const drawnText = [];
        const context = {
            measureText: text => ({ width: text.length * 6 }),
            fillRect() {}, strokeRect() {},
            fillText: text => drawnText.push(text),
        };
        const allRows = Array.from({ length: 125 }, (_, index) => ({
            dataset: { level: index === 0 || index === 124 ? 'error' : 'info' },
            classList: { contains: name => name === 'log-row-error' && (index === 0 || index === 124) },
            querySelector: selector => ({ textContent: selector === '.modhub-log-time' ? '12:00:00' : `测试日志 ${index + 1}` }),
        }));
        let rows = allRows;
        manager.document.getElementById = id => id === 'modHubLogContent' ? { querySelectorAll: () => rows } : null;
        manager.document.createElement = () => ({ getContext: () => context });
        manager._modHubLastLogAnalysis = { errorCount: 2, warnCount: 0 };
        manager.StartConfig = { version: '0.5.12.13' };
        manager.modLoaderGui = { gModUtils: { version: '2.101.1' } };

        await manager.modHubCaptureLogScreenshot();
        assert.ok(drawnText.some(text => text.startsWith('游戏版本: DoL 0.5.12.13  |  ModLoader: 2.101.1  |')), '新游戏截图必须显示实际游戏和加载器版本');
        assert.ok(drawnText.includes('当前截取: 100 / 125 条 (筛选：全部日志)'), '截断截图必须标明截取数和筛选后总数');
        assert.ok(drawnText.includes('(仅截取前 100 条，已省略 25 条；请筛选「仅错误」或复制日志查看其余项)'), '截断截图必须明确省略条数与查看方式');
        assert.ok(drawnText.includes('测试日志 100') && !drawnText.includes('测试日志 125'), '截图仍只保留前一百行');

        drawnText.length = 0;
        rows = allRows.slice(0, 100);
        delete manager.StartConfig;
        delete manager.modLoaderGui;
        await manager.modHubCaptureLogScreenshot();
        assert.ok(drawnText.some(text => text.startsWith('游戏版本: DoL 未识别  |  ModLoader: 未识别  |')), '没有运行时版本时截图必须明确未识别，不能编造历史游戏或加载器版本');
        assert.ok(drawnText.includes('当前截取: 100 / 100 条 (筛选：全部日志)'), '恰好一百行时必须显示完整截取范围');
        assert.ok(!drawnText.some(text => text.includes('已省略')), '未截断截图不得显示省略提示');

        drawnText.length = 0;
        rows = allRows;
        manager._modHubCurrentLogLevelFilter = 'error';
        manager.modUtils = { version: '2.101.1' };
        await manager.modHubCaptureLogScreenshot();
        assert.ok(drawnText.some(text => text.startsWith('游戏版本: DoL 未识别  |  ModLoader: 2.101.1  |')), '仅有兼容 GUI 代理时截图必须读取实际加载器版本');
        assert.ok(drawnText.includes('当前截取: 2 / 2 条 (筛选：仅错误)'), '仅错误截图的总数必须使用筛选后的条数');
        assert.ok(drawnText.includes('测试日志 1') && drawnText.includes('测试日志 125') && !drawnText.includes('测试日志 2'), '仅错误筛选必须保留末尾错误并排除普通日志');
        assert.ok(!drawnText.some(text => text.includes('已省略')), '筛选结果未截断时不得沿用全量日志的省略提示');
    }

    // 14. 顶部吸顶操作栏按钮顺序与样式契约测试
    {
        const managerScript = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-manager.js'), 'utf8');
        const actionBlockMatch = managerScript.match(/<div class="modhub-header-actions">([\s\S]*?)<\/div>/);
        assert.ok(actionBlockMatch, 'modhub-manager.js 必须包含 modhub-header-actions 操作按钮容器');
        const actionBlock = actionBlockMatch[1];

        // 提取按钮文本与顺序
        const buttonMatches = [...actionBlock.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)];
        assert.equal(buttonMatches.length, 5, '顶部操作栏必须有且仅有 5 个核心操作按钮');

        const buttonNames = buttonMatches.map(m => m[2].trim());
        assert.deepEqual(
            buttonNames,
            ['导入模组', '重新载入游戏', '智能整理模组与美化顺序', '刷新列表', '时间点还原'],
            '顶部按钮顺序必须为：导入模组 -> 重新载入游戏 -> 智能整理模组与美化顺序 -> 刷新列表 -> 时间点还原'
        );

        // 验证所有按钮均统一具备 modhub-btn-primary 类
        for (const m of buttonMatches) {
            const attrs = m[1];
            const name = m[2].trim();
            assert.ok(attrs.includes('modhub-btn-primary'), `按钮【${name}】必须具备 modhub-btn-primary 样式类`);
            assert.ok(attrs.includes('macro-button'), `按钮【${name}】必须具备 macro-button 基础类`);
        }

        for (const narrow of [true, false]) {
            const container = createStubElement();
            const sb = createBaseSandbox({ matchMedia: () => ({ matches: narrow }) });
            sb.document.getElementById = id => id === 'modHubModManageContainer' ? container : null;
            container.querySelector = () => null;
            loadScripts(sb);
            sb._modHubModState = { sideMods: [], builtInMods: [] };
            sb.modHubRenderBeautyUI = () => {};
            sb.modHubRenderModManageUI();
            assert.equal(/data-section="manager-help" open/.test(container.innerHTML), !narrow, '手机说明默认收起，桌面默认展开');
            container.querySelectorAll = () => [{ dataset: { section: 'manager-help' }, open: narrow }];
            sb.modHubRenderModManageUI();
            assert.equal(/data-section="manager-help" open/.test(container.innerHTML), narrow, '重绘必须保留玩家切换后的说明状态');
            assert.ok(container.innerHTML.includes('id="toggleSafeMode"'), '说明折叠不能移除安全模式入口');
        }
    }

    /* =========================================================================
     * 13. 前置依赖展示与可勾选契约（多色状态指示与可选安装）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        assert.equal(typeof market.formatDependencyListHtml, 'function', '必须导出 formatDependencyListHtml 函数');

        // 13.1 前置依赖全部满足场景
        const satisfiedPlan = {
            requirements: [
                { mod: { name: '秋枫白桦框架' }, dependency: { id: 'maplebirch', version: '^1.0.0' } }
            ],
            actions: []
        };
        const satisfiedHtml = market.formatDependencyListHtml(satisfiedPlan);
        assert.ok(satisfiedHtml.includes('modhub-dep-satisfied'), '已满足依赖必须带有 modhub-dep-satisfied 类');
        assert.ok(satisfiedHtml.includes('green'), '已满足依赖状态必须带有 green 绿色高亮');
        assert.ok(satisfiedHtml.includes('已满足'), '已满足依赖必须显示「已满足」标签');
        assert.ok(!satisfiedHtml.includes('type="checkbox"'), '已满足依赖不应展示勾选框');

        // 13.2 包含未安装、待更新、未启用多种状态的场景
        const modA = { name: '已安装模组' };
        const modB = { name: '未安装模组' };
        const modC = { name: '待更新模组' };
        const modD = { name: '未启用模组' };
        const mixedPlan = {
            requirements: [
                { mod: modA, dependency: { id: 'modA' } },
                { mod: modB, dependency: { id: 'modB', version: '^2.0.0' } },
                { mod: modC, dependency: { id: 'modC', version: '^1.5.0' } },
                { mod: modD, dependency: { id: 'modD' } }
            ],
            actions: [
                { type: 'install', mod: modB, requirement: '^2.0.0' },
                { type: 'update', mod: modC, local: { version: '1.0.0' }, requirement: '^1.5.0' },
                { type: 'enable', mod: modD }
            ]
        };
        const mixedHtml = market.formatDependencyListHtml(mixedPlan);
        // 未安装项：金色，可勾选
        assert.ok(mixedHtml.includes('未安装'), '必须包含「未安装」状态');
        assert.ok(mixedHtml.includes('data-active-color="gold"'), '未安装状态色彩必须为 gold');
        assert.ok(mixedHtml.includes('name="modHubDepReq"'), '待处理项必须提供复选框');
        assert.ok(mixedHtml.includes('checked'), '复选框必须默认勾选');
        // 需更新项：金色
        assert.ok(mixedHtml.includes('需更新'), '必须包含「需更新」状态');
        // 未启用项：紫色
        assert.ok(mixedHtml.includes('未启用'), '必须包含「未启用」状态');
        assert.ok(mixedHtml.includes('data-active-color="purple"'), '未启用状态色彩必须为 purple');

        // 13.3 勾选与取消勾选时的 actions 过滤逻辑断言
        // 模拟用户仅勾选未安装模组 (reqIndex 1)，取消更新与启用
        const selectedReqIndices = new Set([1]);
        const filteredActions = mixedPlan.actions.filter(action =>
            mixedPlan.requirements.some((req, idx) => req.mod === action.mod && selectedReqIndices.has(idx))
        );
        assert.equal(filteredActions.length, 1, '取消勾选后只保留选中的 1 项 action');
        assert.equal(filteredActions[0].mod.name, '未安装模组', '保留的 action 必须对应选中的未安装模组');

        // 模拟用户全部取消勾选
        const emptyIndices = new Set();
        const noneActions = mixedPlan.actions.filter(action =>
            mixedPlan.requirements.some((req, idx) => req.mod === action.mod && emptyIndices.has(idx))
        );
        assert.equal(noneActions.length, 0, '全部取消勾选时 actions 必须为空');
    }

    /* =========================================================================
     * 14. 模组安装兼容性与冲突检测契约（枫叶框架 vs 简易框架等）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const cssContent = readStyles();
        assert.ok(Array.isArray(market.KNOWN_MOD_CONFLICT_RULES), '必须导出已知模组冲突规则库');
        assert.equal(typeof market.detectModInstallationConflicts, 'function', '必须导出 detectModInstallationConflicts');
        assert.equal(typeof market.formatConflictWarningHtml, 'function', '必须导出 formatConflictWarningHtml');

        // 14.1 场景 1：本地已安装且启用「秋枫白桦框架」，安装依赖「简易框架」的模组（如日落伊甸园）
        const localProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch', nickName: { chs: '秋枫白桦框架' } },
                displayNames: ['秋枫白桦框架', 'maplebirch']
            }
        ];
        const targetMod = { name: '日落伊甸园', id: 'InTheEdenAfterSunset' };
        const candidateActions = [
            { type: 'install', mod: { name: '简易框架', id: 'SimpleFramework' } }
        ];
        // 本地未禁用（即处于启用状态）
        const conflicts = market.detectModInstallationConflicts(targetMod, candidateActions, localProfiles, new Set());
        assert.equal(conflicts.length, 1, '必须准确识别 1 项已知互斥冲突');
        assert.equal(conflicts[0].incomingMod.name, '简易框架', '即将引入的冲突模组必须为简易框架');
        assert.equal(conflicts[0].localConflictMod.name, '秋枫白桦框架', '本地冲突模组必须识别为秋枫白桦框架');
        assert.equal(conflicts[0].localConflictMod.isEnabled, true, '本地模组必须识别为已启用状态');

        // 验证 HTML 渲染
        const conflictHtml = market.formatConflictWarningHtml(conflicts);
        assert.ok(conflictHtml.includes('modhub-install-conflict-card'), '必须包含冲突警告卡片容器');
        assert.ok(conflictHtml.includes('兼容性警告'), '必须包含兼容性警告标签');
        assert.ok(conflictHtml.includes('本地冲突已启用·兼容性未确认'), '启用冲突必须包含高风险警示');
        assert.ok(conflictHtml.includes('秋枫白桦框架'), '必须包含秋枫白桦框架名称');
        assert.ok(conflictHtml.includes('简易框架'), '必须包含简易框架名称');

        // 14.2 场景 2：玩家取消勾选冲突前置依赖「简易框架」
        const emptyActions = [];
        const clearedConflicts = market.detectModInstallationConflicts(targetMod, emptyActions, localProfiles, new Set());
        assert.equal(clearedConflicts.length, 0, '取消勾选冲突前置后，冲突数量必须归零');

        // 14.3 场景 3：本地存在冲突模组但处于禁用状态
        const disabledNames = new Set(['maplebirch']);
        const disabledConflicts = market.detectModInstallationConflicts(targetMod, candidateActions, localProfiles, disabledNames);
        assert.equal(disabledConflicts.length, 1, '禁用状态下依然需要提醒冲突存在');
        assert.equal(disabledConflicts[0].localConflictMod.isEnabled, false, '本地模组必须识别为未启用');
        const disabledHtml = market.formatConflictWarningHtml(disabledConflicts);
        assert.ok(disabledHtml.includes('本地已安装·当前禁用'), '未启用模组必须显示当前禁用标签');
        assert.ok(disabledHtml.includes('is-resolved'), '冲突已全部排除时卡片容器必须携带 is-resolved 类名');
        assert.ok(disabledHtml.includes('检查通过'), '冲突已全部排除时卡片徽章必须显示【检查通过】');
        assert.ok(disabledHtml.includes('框架同时加载风险已排除'), '冲突已全部排除时卡片标题必须切换为检查通过文本');
        assert.ok(!disabledHtml.includes('modhub-conflict-disable-btn'), '已禁用模组无需再渲染快捷禁用按钮');

        // 14.4 场景 4：目标模组自身直接为冲突模组（如本地有秋枫，直接安装简易框架）
        const directMod = { name: '简易框架', id: 'SimpleFramework' };
        const directConflicts = market.detectModInstallationConflicts(directMod, [], localProfiles, new Set());
        assert.equal(directConflicts.length, 1, '直接安装冲突模组必须触发冲突警告');
        assert.equal(directConflicts[0].incomingMod.role, '目标模组', '冲突角色必须为目标模组');

        // 同一作者的普通模组不能因仓库所有者含框架名称而误判互斥。
        const longerCombat = { id: 'longer-combat', name: '更长遭遇战/言灵作弊集', githubUrl: 'https://github.com/MaplebirchLeaf/LongerCombat' };
        const ordinaryActions = [{ type: 'install', mod: directMod }, { type: 'install', mod: longerCombat }];
        assert.equal(market.detectModInstallationConflicts(directMod, [ordinaryActions[1]], [], new Set()).length, 0, '单项安装中的普通同作者模组不能误判为秋枫框架');
        assert.equal(market.detectModInstallationConflicts(null, ordinaryActions, [], new Set()).length, 0, '简易框架与同作者普通模组批量安装不能误报内部互斥');
        assert.equal(market.detectModInstallationConflicts(longerCombat, [], [{ name: 'Simple Frameworks' }], new Set()).length, 0, '本地有简易框架时安装普通同作者模组也不能误报冲突');
        const realFrameworkConflicts = market.detectModInstallationConflicts(null, ordinaryActions, localProfiles, new Set());
        assert.equal(realFrameworkConflicts.length, 1, '同批次存在真实本地秋枫框架时必须保留框架互斥警告');
        assert.equal(realFrameworkConflicts[0].incomingMod.name, '简易框架', '冲突必须准确归因于简易框架，不能归因于同作者普通模组');
        assert.equal(realFrameworkConflicts[0].localConflictMod.rawName, 'maplebirch', '警告必须指向真实本地秋枫框架');
        const [mapleGroup, simpleGroup] = market.KNOWN_MOD_CONFLICT_RULES[0].conflictingGroups;
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' }, mapleGroup), true, '仅给出完整秋枫框架仓库时仍须匹配权威身份');
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework' }, simpleGroup), true, '仅给出完整简易框架仓库时仍须匹配权威身份');
        assert.equal(market.isModMatchingConflictGroup({ githubUrl: longerCombat.githubUrl }, mapleGroup), false, '仓库回退必须匹配完整身份，不能只匹配作者名');
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        market.applyIdentityCatalog(catalog);
        for (const identity of catalog.mods) {
            const mod = { ...identity, identityId: identity.id, bootJson: identity.bootNames.length
                ? { name: identity.bootNames[0], nickName: '简易框架' } : undefined };
            assert.equal(market.isModMatchingConflictGroup(mod, mapleGroup), identity.id === 'maplebirch',
                `目录身份 ${identity.id} 不能因 ID、昵称或别名子串被归入秋枫框架`);
            assert.equal(market.isModMatchingConflictGroup(mod, simpleGroup), identity.id === 'simple-framework',
                `目录身份 ${identity.id} 不能因昵称或别名被归入简易框架`);
        }
        assert.equal(market.isModMatchingConflictGroup({ id: 'unknown-maplebirch-helper', name: '普通框架辅助包' }, mapleGroup),
            false, '未知条目的 ID 含框架名称也不能认定其为框架本体');
        assert.equal(market.isModMatchingConflictGroup({ name: 'UnknownProvider',
            bootJson: { name: 'UnknownProvider', nickName: '简易框架' }, displayNames: ['简易框架'], normalizedNames: ['simpleframework'] }, simpleGroup),
            false, '真实未知技术名不能凭本地昵称和展示别名充当已知框架本体');

        // 选版预检后按真实主包、附属包和本地前置识别框架，不能只看市场展示名。
        const unnamedFramework = { id: 'framework-package', name: '作者安装包' };
        const preparedAction = { type: 'install', role: '目标模组', mod: unnamedFramework,
            prepared: { boots: [{ name: 'Simple Frameworks', version: '2.0.5' }] } };
        const actualBootConflicts = market.detectModInstallationConflicts(unnamedFramework, [preparedAction], localProfiles, new Set());
        assert.equal(actualBootConflicts.length, 1, '目标先登记目录身份后仍必须补真实 boot 的框架身份');
        assert.equal(actualBootConflicts[0].incomingMod.role, '目标模组');
        assert.equal(actualBootConflicts[0].localConflictMod.rawName, 'maplebirch');
        const companionAction = { type: 'install', mod: longerCombat,
            prepared: { boots: [{ name: 'LongerCombat' }, { name: 'Simple Frameworks' }] } };
        const companionConflicts = market.detectModInstallationConflicts(null, [companionAction], localProfiles, new Set());
        assert.equal(companionConflicts.length, 1, '实际附属包为框架时必须提示其与已安装框架的互斥');
        assert.equal(companionConflicts[0].incomingMod.role, '附属包');
        assert.equal(market.detectModInstallationConflicts(null, [{ type: 'enable', mod: unnamedFramework,
            local: { name: 'Simple Frameworks', bootJson: { name: 'Simple Frameworks' } } }], localProfiles, new Set()).length,
            1, '待启用前置的本地真实 boot 必须参与框架互斥检测');
        assert.equal(market.detectModInstallationConflicts(null, [preparedAction], localProfiles, new Set(['maplebirch']))[0].localConflictMod.isEnabled,
            false, '真实 boot 路径仍必须区分本地已启用与已禁用框架');
        assert.equal(market.detectModInstallationConflicts(null, [{ type: 'install', mod: longerCombat,
            prepared: { boots: [{ name: 'LongerCombat' }] } }], [], new Set()).length,
            0, '普通同作者模组的真实 boot 不能造成框架误报');
        const replacementActions = [preparedAction, { type: 'update', mod: { id: 'other-package', name: '另一安装包' },
            prepared: { boots: [{ name: 'maplebirch' }] } }];
        const replacementConflicts = market.detectModInstallationConflicts(null, replacementActions,
            [...localProfiles, { name: 'Simple Frameworks', bootJson: { name: 'Simple Frameworks' } }], new Set());
        assert.equal(replacementConflicts.length, 1, '同技术名重装应按新安装集合检查，不能重复当作旧本地框架');
        assert.equal(replacementConflicts[0].localConflictMod.isIncoming, true, '两项重装互斥必须标为安装项内部冲突');
        assert.ok(!market.formatConflictWarningHtml(replacementConflicts).includes('modhub-conflict-disable-btn'),
            '将被替换的旧包不能展示快捷禁用来误示新包冲突已消除');

        // 兼容确认使用持久状态回读；弹窗期间新增的已启用框架必须再次展示。
        const live = loadMarket();
        const names = ['maplebirch'];
        live._modHubModState = { sideMods: [{ name: 'maplebirch', enabled: false }], sideDisabled: ['maplebirch'] };
        live.modHubGetModInfo = name => ({ bootJson: { name } });
        let stateReads = 0, confirmations = 0;
        live.modHubLoadModManageState = async () => {
            stateReads++;
            live._modHubModState = { sideMods: names.map(name => ({ name, enabled: true })), sideDisabled: [] };
        };
        live.modHubConfirm = async options => {
            confirmations++;
            assert.ok(options.trustedMessageHtml.includes('本地冲突已启用·兼容性未确认'), '确认前必须按回读状态展示启用冲突');
            assert.ok(!options.trustedMessageHtml.includes('modhub-conflict-disable-btn'), '只读计划确认不得提前修改启禁状态');
            if (confirmations === 1) { names.push('scml-dol-maplebirchframework'); return true; }
            return false;
        };
        assert.equal(await live.modHubMarket.confirmInstallConflicts(() => ({ targetMod: null, actions: [preparedAction] }), { allowDisable: false }),
            false, '新增本地活跃框架风险后的取消必须终止安装');
        assert.equal(confirmations, 2, '确认期间新增本地框架不得沿用原风险确认');
        assert.ok(stateReads >= 3, '首次确认及确认后均须回读真实启禁状态');

        // 14.5 场景 5：纯英文技术名模组（无中文 nickName）必须能自动映射为中文友好名称，且建议文本去除重复的“建议”
        const englishOnlyProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch' },
                displayNames: ['maplebirch']
            }
        ];
        const enConflicts = market.detectModInstallationConflicts(targetMod, candidateActions, englishOnlyProfiles, new Set());
        assert.equal(enConflicts.length, 1, '英文标识模组必须能正常匹配冲突');
        assert.equal(enConflicts[0].localConflictMod.name, '秋枫白桦框架', '无中文属性的英文技术模组必须回退映射为冲突组中文名称');
        assert.equal(enConflicts[0].localConflictMod.rawName, 'maplebirch', '底层原始名称必须保留为 maplebirch 用于接口调用');
        assert.ok(!enConflicts[0].advice.startsWith('建议'), '建议正文开头严禁带有重复的「建议」二字');

        // 14.6 场景 6：启用冲突卡片中必须渲染快捷禁用按钮
        const enHtml = market.formatConflictWarningHtml(enConflicts);
        assert.ok(enHtml.includes('modhub-conflict-disable-btn'), '启用的冲突模组卡片中必须包含快捷禁用按钮');
        assert.ok(enHtml.includes('data-conflict-raw="maplebirch"'), '快捷禁用按钮必须携带底层原始名称');
        assert.ok(enHtml.includes('快捷禁用【秋枫白桦框架】'), '快捷禁用按钮必须呈现中文友好名称');
        const readOnlyHtml = market.formatConflictWarningHtml(enConflicts, { allowDisable: false });
        assert.ok(readOnlyHtml.includes('兼容性警告'), '选版准备流程仍须展示冲突风险');
        assert.ok(!readOnlyHtml.includes('modhub-conflict-disable-btn'), '选版确认期间不提供会提前写入状态的快捷禁用');

        // 14.7 场景 7：findDependentModsForConflict 依赖影响深度评估
        const depTestProfiles = [
            {
                name: 'maplebirch',
                bootJson: { name: 'maplebirch' }
            },
            {
                name: 'CustomStoryMod',
                bootJson: {
                    name: 'CustomStoryMod',
                    nickName: { chs: '自制剧情模组' },
                    version: '1.2.0',
                    dependenceInfo: [{ modName: 'maplebirch', version: '^1.0.0' }]
                }
            },
            {
                name: 'CustomClothMod',
                bootJson: {
                    name: 'CustomClothMod',
                    nickName: { chs: '自制服装模组' },
                    version: '2.0.1',
                    addonPlugin: [{ modName: 'scml-dol-maplebirchframework', addonName: 'cloth' }]
                }
            },
            {
                name: 'IndependentMod',
                bootJson: {
                    name: 'IndependentMod',
                    nickName: { chs: '独立无依赖模组' }
                }
            },
            {
                name: 'DisabledDependentMod',
                bootJson: {
                    name: 'DisabledDependentMod',
                    nickName: { chs: '已禁用的下游模组' },
                    dependenceInfo: [{ modName: 'maplebirch' }]
                }
            }
        ];
        const testDisabledNames = new Set(['disableddependentmod']);
        const affected = market.findDependentModsForConflict('maplebirch', depTestProfiles, testDisabledNames);
        assert.equal(affected.length, 2, '必须准确找出 2 个依赖于 maplebirch 的已启用模组');
        const affectedNames = affected.map(a => a.name);
        assert.ok(affectedNames.includes('自制剧情模组'), '必须包含自制剧情模组');
        assert.ok(affectedNames.includes('自制服装模组'), '必须包含自制服装模组');
        assert.ok(!affectedNames.includes('独立无依赖模组'), '绝不能包含无依赖的独立模组');
        assert.ok(!affectedNames.includes('已禁用的下游模组'), '已被禁用的模组不能作为受影响活跃项混淆提示');

        // 14.8 场景 8：样式表必须包含二次确认高亮警告框与快捷禁用按钮样式
        assert.ok(cssContent.includes('.modhub-modal-conflict-alert-box'), 'CSS 必须定义二次确认的高亮警示盒样式');
        assert.ok(cssContent.includes('.modhub-conflict-disable-btn'), 'CSS 必须定义冲突卡片快捷禁用按钮样式');
    }

    // -------------------------------------------------------------------------
    // 15. 模组管理页启用冲突检测、删除受影响模组评估与简易框架别名契约
    // -------------------------------------------------------------------------
    {
        const manager = loadManager();

        // 15.1 契约 1：Simple Frameworks 别名映射与副标题必须准确解析为【简易框架】，严禁误判为【秋枫白桦框架】
        const sfSubtext = manager.modHubGetModSubtext('Simple Frameworks', {
            name: 'Simple Frameworks',
            bootJson: { name: 'Simple Frameworks', version: '2.0.5' }
        }, false);
        assert.equal(sfSubtext, '简易框架', 'Simple Frameworks 必须准确映射为【简易框架】');

        const sfWithS = manager.modHubGetModSubtext('SimpleFrameworks', null, false);
        assert.equal(sfWithS, '简易框架', 'SimpleFrameworks 必须准确映射为【简易框架】');

        // 15.2 契约 2：市场端源码中二次确认弹窗的确认按钮文本必须为【继续安装】
        const marketJs = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-market.js'), 'utf8');
        assert.ok(marketJs.includes("confirmText: '继续安装'"), '市场冲突二次确认弹窗的确认按钮文本必须为【继续安装】');

        // 15.3 契约 3：模组管理页启用冲突检测引擎 modHubCheckEnableConflicts
        assert.equal(typeof manager.modHubCheckEnableConflicts, 'function', '必须导出 modHubCheckEnableConflicts');
        const activeMods = [
            { name: 'maplebirch', enabled: true },
            { name: 'IndependentMod', enabled: true }
        ];
        // 待启用简易框架
        const conflictDetected = manager.modHubCheckEnableConflicts('Simple Frameworks', activeMods);
        assert.ok(conflictDetected, '当已启用秋枫白桦时，启用 Simple Frameworks 必须检出互斥冲突');
        assert.equal(conflictDetected.ruleId, 'maplebirch-vs-simpleframework');
        assert.ok(conflictDetected.targetDisplayName.includes('简易框架') || conflictDetected.targetDisplayName === 'Simple Frameworks');
        assert.ok(conflictDetected.conflictDisplayName.includes('秋枫白桦') || conflictDetected.conflictDisplayName === 'maplebirch');

        // 反向检测：当已启用简易框架时，启用秋枫白桦同样检出冲突
        const activeWithSF = [
            { name: 'Simple Frameworks', enabled: true }
        ];
        const reverseConflict = manager.modHubCheckEnableConflicts('maplebirch', activeWithSF);
        assert.ok(reverseConflict, '当已启用简易框架时，启用秋枫白桦必须检出互斥冲突');

        // 无冲突场景：启用普通独立模组不触发冲突
        const noConflict = manager.modHubCheckEnableConflicts('NormalMod', activeMods);
        assert.equal(noConflict, null, '普通独立模组启用时不应产生互斥冲突');

        // 15.4 契约 4：模组删除时的下游受影响模组评估 modHubFindDependentMods
        assert.equal(typeof manager.modHubFindDependentMods, 'function', '必须导出 modHubFindDependentMods');
        manager._modHubModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'StoryModA', enabled: true },
                { name: 'ClothModB', enabled: false },
                { name: 'StandaloneMod', enabled: true }
            ]
        };
        // 模拟 modInfo
        const mockModInfoMap = new Map([
            ['maplebirch', { name: 'maplebirch', bootJson: { name: 'maplebirch', version: '5.0.4', nickName: { chs: '秋枫白桦框架' } } }],
            ['storymoda', { name: 'StoryModA', bootJson: { name: 'StoryModA', version: '1.2.0', dependenceInfo: [{ modName: 'maplebirch' }] } }],
            ['clothmodb', { name: 'ClothModB', bootJson: { name: 'ClothModB', version: '1.0.0', dependenceInfo: [{ modName: 'Maplebirch' }] } }],
            ['standalonemod', { name: 'StandaloneMod', bootJson: { name: 'StandaloneMod', version: '1.0.0' } }]
        ]);
        const oldGetModInfo = manager.modHubGetModInfo;
        manager.modHubGetModInfo = name => mockModInfoMap.get(String(name).toLowerCase()) || null;

        const depResult = await manager.modHubFindDependentMods('maplebirch');
        assert.equal(depResult.length, 2, '必须找出 2 个依赖 maplebirch 的下游模组');
        const depNames = depResult.map(d => d.rawName);
        assert.ok(depNames.includes('StoryModA'), '受影响列表必须包含 StoryModA');
        assert.ok(depNames.includes('ClothModB'), '受影响列表必须包含 ClothModB');
        assert.ok(!depNames.includes('StandaloneMod'), '受影响列表绝不能包含 StandaloneMod');

        // 15.5 契约 5：modHubToggleSideMod 启用冲突拦截确认
        let confirmCallArgs = null;
        manager.modHubConfirm = async (opts) => {
            confirmCallArgs = opts;
            return false; // 模拟玩家点击【暂不启用】
        };
        manager._modHubModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'Simple Frameworks', enabled: false }
            ],
            sideEnabled: ['maplebirch'],
            sideDisabled: ['Simple Frameworks']
        };
        const toggleResult = await manager.modHubToggleSideMod('Simple Frameworks', true);
        assert.equal(toggleResult, false, '玩家取消启用时必须返回 false 且中断启用流程');
        assert.ok(confirmCallArgs, '必须弹出冲突确认弹窗');
        assert.equal(confirmCallArgs.title, '模组冲突风险确认');
        assert.equal(confirmCallArgs.confirmText, '继续启用');
        assert.equal(confirmCallArgs.cancelText, '暂不启用');
        assert.equal(confirmCallArgs.confirmDelay, 5, '冲突启用弹窗必须设置 5 秒倒计时');
        assert.equal(manager._modHubModState.sideMods.find(m => m.name === 'Simple Frameworks').enabled, false, '未确认前保持禁用状态');
        assert.ok(confirmCallArgs.trustedMessageHtml.includes('modhub-conflict-disable-btn'), '模组管理启用冲突弹窗必须包含快捷禁用按钮');
        assert.ok(confirmCallArgs.trustedMessageHtml.includes('快捷禁用【秋枫白桦框架】'), '模组管理启用冲突弹窗快捷禁用按钮必须呈现中文友好名称');
        assert.equal(typeof confirmCallArgs.onRender, 'function', '冲突启用弹窗必须提供 onRender 钩子以支持快捷禁用交互');

        // 15.6 契约 6：市场安装弹窗中前置依赖与主按钮文案必须统一为【一键安装】
        assert.ok(marketJs.includes('默认勾选一键安装，可取消勾选'), '市场前置依赖提示文案必须为默认勾选一键安装');
        assert.ok(marketJs.includes('一键安装（含'), '市场安装确认按钮文本必须包含一键安装');

        // 15.7 契约 7：modHubDeleteSideMod 删除被依赖模组时的下游警示弹窗
        let deleteConfirmArgs = null;
        manager.modHubConfirm = async (opts) => {
            deleteConfirmArgs = opts;
            return false; // 模拟取消删除
        };
        manager._modHubModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'StoryModA', enabled: true }
            ],
            sideEnabled: ['maplebirch', 'StoryModA'],
            sideDisabled: []
        };
        manager.modHubGetModInfo = name => mockModInfoMap.get(String(name).toLowerCase()) || null;
        const deleteResult = await manager.modHubDeleteSideMod('maplebirch');
        assert.equal(deleteResult, undefined, '取消删除时必须中断流程');
        assert.ok(deleteConfirmArgs, '删除具有下游依赖的模组必须触发确认弹窗');
        assert.equal(deleteConfirmArgs.title, '确认删除模组（存在依赖警告）');
        assert.ok(deleteConfirmArgs.message.includes('StoryModA'), '删除提示文本中必须包含依赖它的下游模组');
        assert.equal(deleteConfirmArgs.confirmDelay, 5, '存在依赖警告的删除弹窗必须设置 5 秒倒计时');

        // 恢复 mock
        manager.modHubGetModInfo = oldGetModInfo;
    }

    // 16. 需求回归与缺陷修复验证测试
    {
        const manager = loadManager();
        const market = loadMarket().modHubMarket;
        // 16.1 契约 1：前置依赖与冲突卡片标题去除 (1) 数字
        const testDepPlan = {
            requirements: [{ mod: { name: 'DepA' }, dependency: { id: 'DepA', version: '1.0.0' } }],
            actions: [{ type: 'install', mod: { name: 'DepA' } }]
        };
        const depHtml = market.formatDependencyListHtml(testDepPlan);
        assert.ok(depHtml.includes('<strong class="modhub-install-dependencies-title">前置依赖</strong>'), '前置依赖标题必须为干净的【前置依赖】');
        assert.ok(!depHtml.includes('前置依赖（'), '前置依赖标题绝不能包含括号数字标记');

        const testConflicts = [{
            incomingMod: { name: 'ModX' },
            localConflictMod: { name: 'ModY', rawName: 'ModY', isEnabled: true },
            reason: '测试冲突原因',
            advice: '测试冲突建议'
        }];
        const conflictHtml = market.formatConflictWarningHtml(testConflicts);
        assert.ok(conflictHtml.includes('<strong class="modhub-conflict-heading red">检测到已知模组冲突</strong>'), '冲突卡片标题必须为干净的【检测到已知模组冲突】');
        assert.ok(!conflictHtml.includes('已知模组冲突（'), '冲突卡片标题绝不能包含括号数字标记');

        // 16.2 契约 2：对手冲突组别名隔离与防误诊（解决 CustomHair 误归秋枫白桦）
        const oldGetModInfo = manager.modHubGetModInfo;
        const testModInfoMap = new Map([
            ['maplebirch', {
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'], // 诱发误判的关键污染源
                    version: '5.0.4'
                }
            }],
            ['customhair', {
                bootJson: {
                    name: 'CustomHair',
                    dependenceInfo: [{ modName: 'Simple Frameworks' }],
                    version: '1.2.0'
                }
            }],
            ['maplemod', {
                bootJson: {
                    name: 'MapleMod',
                    dependenceInfo: [{ modName: 'maplebirch' }],
                    version: '1.0.0'
                }
            }],
            ['simpleframework', {
                bootJson: {
                    name: 'simpleframework',
                    version: '1.0.0'
                }
            }]
        ]);

        manager.modHubGetModInfo = name => testModInfoMap.get(String(name).toLowerCase()) || null;
        manager._modHubModState = {
            sideMods: [
                { name: 'maplebirch', enabled: true },
                { name: 'CustomHair', enabled: true },
                { name: 'MapleMod', enabled: true },
                { name: 'simpleframework', enabled: false }
            ],
            sideEnabled: ['maplebirch', 'CustomHair', 'MapleMod'],
            sideDisabled: ['simpleframework']
        };

        const mapleDeps = await manager.modHubFindDependentMods('maplebirch');
        const mapleDepNames = mapleDeps.map(m => m.name || m.rawName);
        assert.ok(mapleDepNames.includes('MapleMod'), '依赖 maplebirch 的 MapleMod 必须被识别出来');
        assert.ok(!mapleDepNames.includes('CustomHair'), '依赖 Simple Frameworks 的 CustomHair 绝不能被归入 maplebirch 的下游！');

        const simpleDeps = await manager.modHubFindDependentMods('Simple Frameworks');
        const simpleDepNames = simpleDeps.map(m => m.name || m.rawName);
        assert.ok(simpleDepNames.includes('CustomHair'), '依赖 Simple Frameworks 的 CustomHair 必须属于 Simple Frameworks 的下游');
        assert.ok(!simpleDepNames.includes('MapleMod'), '依赖 maplebirch 的 MapleMod 绝不能属于 Simple Frameworks 的下游');

        // 测试 market 端的 findDependentModsForConflict 对手隔离
        const mockProfiles = [
            { name: 'maplebirch', rawName: 'maplebirch', bootJson: testModInfoMap.get('maplebirch').bootJson },
            { name: 'CustomHair', rawName: 'CustomHair', bootJson: testModInfoMap.get('customhair').bootJson },
            { name: 'MapleMod', rawName: 'MapleMod', bootJson: testModInfoMap.get('maplemod').bootJson }
        ];
        const marketAffected = market.findDependentModsForConflict('maplebirch', mockProfiles, new Set());
        const marketAffectedNames = marketAffected.map(m => m.name || m.rawName);
        assert.ok(marketAffectedNames.includes('MapleMod'), '市场端冲突检测中 MapleMod 属于 maplebirch 下游');
        assert.ok(!marketAffectedNames.includes('CustomHair'), '市场端冲突检测中 CustomHair 绝不能误归 maplebirch 下游');

        // 验证删除 DOLI 时不误判依赖 ImageLoaderHook 的模组
        const doliTestMap = new Map([
            ['doli', { name: 'DOLI', bootJson: { name: 'DOLI', version: '1.0.0' } }],
            ['游戏中文化补丁', { name: '游戏中文化补丁', bootJson: { name: '游戏中文化补丁', version: '1.0.1a',
                addonPlugin: [{ modName: 'ModLoader DoL ImageLoaderHook', addonName: 'ImageLoaderHook' }] } }],
            ['realdolidep', { name: 'RealDoliDep', bootJson: { name: 'RealDoliDep', version: '1.0.0',
                dependenceInfo: [{ modName: 'DOLI', minVersion: '1.0.0' }] } }]
        ]);
        manager.modHubGetModInfo = name => doliTestMap.get(String(name).toLowerCase()) || null;
        manager._modHubModState = {
            sideMods: [
                { name: 'DOLI', enabled: true },
                { name: '游戏中文化补丁', enabled: true },
                { name: 'RealDoliDep', enabled: true }
            ],
            sideEnabled: ['DOLI', '游戏中文化补丁', 'RealDoliDep'],
            sideDisabled: []
        };
        const doliDeps = await manager.modHubFindDependentMods('DOLI');
        const doliDepNames = doliDeps.map(m => m.name || m.rawName);
        assert.ok(doliDepNames.includes('RealDoliDep'), '真正依赖 DOLI 的模组必须被找出');
        assert.ok(!doliDepNames.includes('游戏中文化补丁'), '依赖 ImageLoaderHook 的模组绝不能因字母拼接被误判为依赖 DOLI！');

        const doliProfiles = [
            { name: 'DOLI', rawName: 'DOLI', bootJson: doliTestMap.get('doli').bootJson },
            { name: '游戏中文化补丁', rawName: '游戏中文化补丁', bootJson: doliTestMap.get('游戏中文化补丁').bootJson },
            { name: 'RealDoliDep', rawName: 'RealDoliDep', bootJson: doliTestMap.get('realdolidep').bootJson }
        ];
        const marketDoliDeps = market.findDependentModsForConflict('DOLI', doliProfiles, new Set());
        const marketDoliDepNames = marketDoliDeps.map(m => m.name || m.rawName);
        assert.ok(marketDoliDepNames.includes('RealDoliDep'), '市场端：真正依赖 DOLI 的模组必须被找出');
        assert.ok(!marketDoliDepNames.includes('游戏中文化补丁'), '市场端：依赖 ImageLoaderHook 的模组绝不能误判为依赖 DOLI！');

        manager.modHubGetModInfo = oldGetModInfo;

        // 16.3 契约 3：核心框架判断与重启建议强化
        assert.equal(manager.modHubIsFrameworkMod('maplebirch'), true, 'maplebirch 必须被判定为核心框架');
        assert.equal(manager.modHubIsFrameworkMod('秋枫白桦框架'), true, '秋枫白桦框架 必须被判定为核心框架');
        assert.equal(manager.modHubIsFrameworkMod('Simple Frameworks'), true, 'Simple Frameworks 必须被判定为核心框架');
        assert.equal(manager.modHubIsFrameworkMod('SomeCustomFrameworkMod'), true, '名称包含 framework 的模组必须被识别为框架');
        assert.equal(manager.modHubIsFrameworkMod('普通发型美化'), false, '普通模组绝不能被识别为框架');

        let reloadConfirmArgs = null;
        manager.modHubConfirm = async (opts) => {
            reloadConfirmArgs = opts;
            return false;
        };
        // 恢复真实 window.modHubOfferReload 实现进行断言验证
        const optCode = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-manager.js'), 'utf8');
        const offerReloadMatch = optCode.match(/window\.modHubOfferReload = async function\([\s\S]*?\n\};/);
        assert.ok(offerReloadMatch, '源码中必须定义真实的 window.modHubOfferReload');
        vm.runInContext(offerReloadMatch[0], manager);

        await manager.modHubOfferReload('测试框架已更改', { isFramework: true });
        assert.ok(reloadConfirmArgs, '必须调用确认弹窗');
        assert.equal(reloadConfirmArgs.title, '重新载入游戏（强烈建议）', '核心框架变更必须使用【重新载入游戏（强烈建议）】标题');
        assert.equal(reloadConfirmArgs.confirmText, '立即重新载入', '核心框架变更确认按钮必须为【立即重新载入】');
        assert.equal(reloadConfirmArgs.cancelText, '稍后重载', '核心框架变更取消按钮必须为【稍后重载】');
        assert.equal(reloadConfirmArgs.confirmType, 'danger', '核心框架变更确认弹窗必须为高风险醒目类型');
        assert.ok(reloadConfirmArgs.trustedMessageHtml.includes('强烈建议立即重新载入'), '提示内容中必须包含强烈建议字样');

        // 16.4 契约 4：移动端左侧关闭按钮识别与样式支持
        assert.equal(manager.modHubIsCloseButton('Close'), true, 'Close 必须被识别为移动端关闭按钮');
        assert.equal(manager.modHubIsCloseButton('关闭'), true, '关闭 必须被识别为移动端关闭按钮');
        assert.equal(manager.modHubIsCloseButton('關閉'), true, '關閉 必须被识别为移动端关闭按钮');
        assert.equal(manager.modHubIsCloseButton('模组管理'), false, '普通 Tab 绝不能被识别为关闭按钮');
        assert.equal(manager.modHubIsCloseButton({ textContent: 'Close' }), true, 'DOM 元素节点文本为 Close 时必须识别为关闭按钮');

        const tweeContent = fs.readFileSync(path.join(srcRoot, 'twee/modloader/modloader.twee'), 'utf8');
        assert.ok(tweeContent.includes('modHubInitOverlayTabs'), 'modloader.twee 必须通过外部函数 modHubInitOverlayTabs 初始化顶栏');
        assert.ok(!tweeContent.includes('var isClose ='), 'modloader.twee 绝不能内联复杂函数，杜绝 SugarCube Unexpected token 报错');

        const managerJs = fs.readFileSync(path.join(srcRoot, 'javascript/modhub-manager.js'), 'utf8');
        assert.ok(managerJs.includes('modhub-mobile-close-tab'), 'modhub-manager.js 必须赋予移动端关闭按钮专属类名');
        assert.ok(managerJs.includes('modhub-has-mobile-close'), 'modhub-manager.js 必须为容器添加 modhub-has-mobile-close 类名');

        const cssContent = readStyles();
        assert.ok(cssContent.includes('.modhub-mobile-close-tab'), 'CSS 中必须包含移动端关闭按钮样式定义');
        assert.ok(cssContent.includes('.modhub-has-mobile-close'), 'CSS 中必须包含带有移动端关闭按钮时的容器留白样式');

        // 16.5 契约 5：连续安装/多步骤下载过程中不弹出重启提示打断，全部完成后统一弹窗
        const marketJs = fs.readFileSync(path.join(srcRoot, 'javascript/modhub-market.js'), 'utf8');
        assert.ok(marketJs.includes('skipReloadOffer: options.skipReloadOffer'), 'downloadAndInstallMod 必须透传 skipReloadOffer 到底层');
        assert.match(marketJs, /await window\.modHubToggleSideMod\(action\.local\.name, true, \{ silentOfferReload: true,\s*restoreContext(?:\s*:[^}]*)? \}\)/, '多步骤计划中启用前置必须静默处理，并显式传递同批次还原点上下文');
        assert.ok(marketJs.includes('skipReloadOffer: true'), '多步骤计划与批量更新中下载安装必须显式声明 skipReloadOffer: true');
        assert.ok(managerJs.includes('(!options || !options.skipReloadOffer)'), 'modHubHandleAddMod 必须尊重 skipReloadOffer 守护，杜绝擅自提前弹窗');
        assert.ok(managerJs.includes('if (!options?.keepCurrentTab)'), 'modHubHandleAddMod 必须在非 keepCurrentTab 模式下才允许跳转页签');

        // 16.6 契约 6：列表禁用模组必须执行下游依赖排查，且 Toast 不再包含冗余的原排序字样
        assert.ok(managerJs.includes('!targetEnable && !options.skipConfirm'), 'modHubToggleSideMod 必须在禁用前检查是否需二次确认');
        assert.ok(managerJs.includes('window.modHubFindDependentMods(modName)'), 'modHubToggleSideMod 必须调用 modHubFindDependentMods 排查下游受影响模组');
        assert.ok(!managerJs.includes('（原排序保持不变）'), 'Toast 提示中严禁残留（原排序保持不变）冗余文字');
        assert.match(marketJs, /\{ silentOfferReload: true, skipConfirm: true,\s*restoreContext(?:\s*:[^}]*)? \}/, '市场快捷禁用必须传入 skipConfirm: true，并显式使用同批次还原点上下文');
        assert.ok(!marketJs.includes('marketRestoreContext') && !marketJs.includes('getRestoreContext'), '市场共享操作上下文不能依赖全局隐式状态');

        // 16.7 契约 7：简易框架与秋枫白桦互斥组仲裁引擎与防别名污染
        // 模拟运行环境中 ModLoader 别名重定向导致 modHubGetModInfo('Simple Frameworks') 返回 maplebirch 信息，
        // 且其 subtext 为【秋枫白桦框架】的极端污染场景
        const conflictModInfoMap = new Map([
            ['maplebirch', {
                name: 'maplebirch',
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'],
                    version: '5.0.4',
                    nickName: { chs: '秋枫白桦框架' }
                }
            }],
            ['simple frameworks', {
                name: 'maplebirch', // ModLoader 别名映射返回了 maplebirch
                bootJson: {
                    name: 'maplebirch',
                    alias: ['Simple Frameworks'],
                    version: '5.0.4',
                    nickName: { chs: '秋枫白桦框架' }
                }
            }],
            ['simpleframework', {
                name: 'simpleframework',
                bootJson: {
                    name: 'simpleframework',
                    version: '1.0.0'
                }
            }]
        ]);
        manager.modHubGetModInfo = name => conflictModInfoMap.get(String(name).toLowerCase()) || null;

        // 场景 A：当前已启用 maplebirch，准备启用 Simple Frameworks
        const activeMaplebirch = [
            { name: 'maplebirch', enabled: true },
            { name: 'SomeOtherMod', enabled: true }
        ];
        const sfConflict = manager.modHubCheckEnableConflicts('Simple Frameworks', activeMaplebirch);
        assert.equal(sfConflict, null, '同一秋枫包仅通过原生别名提供 Simple Frameworks 时不能把它当两个框架冲突');

        // 场景 B：当前已启用 Simple Frameworks，准备启用 maplebirch
        const activeSimple = [
            { name: 'Simple Frameworks', enabled: true }
        ];
        const mbConflict = manager.modHubCheckEnableConflicts('maplebirch', activeSimple);
        assert.equal(mbConflict, null, '原生别名返回同一实际包时，反向检查也不能制造独立简易框架');

        // 场景 C：同组内不产生虚假互斥冲突（同为简易框架组）
        const activeSameGroup = [
            { name: 'simpleframework', enabled: true }
        ];
        const sameGroupConflict = manager.modHubCheckEnableConflicts('Simple Frameworks', activeSameGroup);
        assert.equal(sameGroupConflict, null, '同属于简易框架组的模组绝不能自身跟自身产生互斥冲突');

        conflictModInfoMap.set('simple frameworks', { name: 'Simple Frameworks',
            bootJson: { name: 'Simple Frameworks', version: '2.0.5' } });
        const doubleProvider = manager.modHubCheckEnableConflicts('Simple Frameworks', activeMaplebirch);
        assert.equal(doubleProvider.kind, 'alias-provider-overlap', '两个实际包同时提供 Simple Frameworks 应提示别名重复，而非功能互斥');
        assert.equal(doubleProvider.targetDisplayName, '简易框架');
        assert.equal(doubleProvider.conflictDisplayName, '秋枫白桦框架');
        assert.ok(!doubleProvider.reason.includes('挂钩机制') && !doubleProvider.reason.includes('存档损坏'));
        assert.equal(manager.modHubCheckEnableConflicts('Simple Frameworks', [{ name: 'maplebirch', enabled: false }]), null,
            '禁用秋枫不参与两个提供者同时启用风险');

        // 恢复 getModInfo
        manager.modHubGetModInfo = oldGetModInfo;

        // 16.8 契约 8：ModHub 市场分类归类为【界面与便利】与身份库契约
        const catalogData = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        const modhubIdentity = catalogData.mods.find(m => m.id === 'modhub');
        assert.ok(modhubIdentity, 'mod-identities.json 必须收录 modhub 身份');
        assert.equal(modhubIdentity.category, '界面与便利', 'ModHub 在身份库中分类必须为【界面与便利】');
        assert.ok(Array.isArray(modhubIdentity.bootNames) && modhubIdentity.bootNames.includes('ModHub'), 'modhub 必须包含 bootNames: ModHub');

        // 测试市场端的分类自动推导逻辑
        assert.equal(typeof market.deriveClassification, 'function', '市场必须导出 deriveClassification');
        const hubClassified1 = market.deriveClassification('ModHub模组管理中心', '用于在游戏内管理、排序和更新模组的管理套件');
        assert.equal(hubClassified1.category, '界面与便利', 'ModHub模组管理中心 必须归入【界面与便利】分类');
        assert.ok(hubClassified1.tags.includes('管理'), 'ModHub 标签必须包含【管理】');

        const hubClassified2 = market.deriveClassification('ModHub', '游戏内模组中心');
        assert.equal(hubClassified2.category, '界面与便利', 'ModHub 必须归入【界面与便利】分类');

        const hubClassified3 = market.deriveClassification('dol-mod-hub', 'Mod Manager');
        assert.equal(hubClassified3.category, '界面与便利', '包含 mod-hub 的仓库模组必须归入【界面与便利】分类');
    }

    // 真实秋枫 5.1.3 提供原生简易框架别名：兼容代供与重复提供者分别检查。
    {
        const env = loadMarket();
        const market = env.modHubMarket;
        const maple = { name: 'maplebirch', bootJson: { name: 'maplebirch', version: '5.1.3', alias: ['Simple Frameworks'] } };
        const simple = { name: 'Simple Frameworks', bootJson: { name: 'Simple Frameworks', version: '2.0.5' } };
        const target = { id: 'eden-visuals', name: '伊甸互动头像' };
        assert.equal(market.detectModInstallationConflicts(target, [{ type: 'satisfied', mod: { id: 'maplebirch', name: '秋枫白桦框架' }, local: maple }], [maple], new Set()).length,
            0, '仅原生别名代供不构成框架冲突');
        const actions = [{ type: 'install', mod: { id: 'simple-framework', name: '简易框架' }, prepared: { boots: [simple.bootJson] } }];
        const duplicates = market.detectModInstallationConflicts(target, actions, [maple], new Set());
        assert.equal(duplicates.length, 1, '两个独立 canonical 包将同时启用时需要一个重复别名风险');
        assert.equal(duplicates[0].kind, 'alias-provider-overlap');
        const html = market.formatConflictWarningHtml(duplicates);
        assert.ok(html.includes('重复提供 Simple Frameworks'));
        assert.ok(!html.includes('互斥') && !html.includes('存档损坏'), '别名声明不能被展示成功能互斥');
        assert.equal(market.detectModInstallationConflicts(target, actions, [maple], new Set(['maplebirch'])).length,
            0, '禁用的实际包不造成两个别名提供者同时启用');
        const both = [{ type: 'install', mod: { id: 'maplebirch', name: '秋枫白桦框架' }, prepared: { boots: [maple.bootJson] } }, ...actions];
        assert.equal(market.detectModInstallationConflicts(null, both, [maple, simple], new Set())[0].kind,
            'alias-provider-overlap', '同批安装的两个实际框架也提示原生别名重复提供');
        const preview = { type: 'install', mod: { id: 'maplebirch', name: '秋枫白桦框架', version: '5.1.3',
            githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' }, release: { version: '5.1.3', tag: 'maplebirch-release-v5.1.3' } };
        assert.equal(market.detectModInstallationConflicts(null, [preview], [simple], new Set())[0].kind,
            'alias-provider-overlap', '精确已核验发布允许提供者预览');
        const history = { ...preview, release: { version: '1.0.0', tag: '1.0.0' } };
        assert.equal(market.detectModInstallationConflicts(null, [history], [simple], new Set())[0].kind,
            'unverified-framework-pair', '历史版本不能继承目录最新版的别名证据');
        const realMissingAlias = { ...preview, prepared: { boots: [{ name: 'maplebirch', version: '5.1.3', alias: [] }] } };
        assert.equal(market.detectModInstallationConflicts(null, [realMissingAlias], [simple], new Set())[0].kind,
            'unverified-framework-pair', '实际包体优先于发布预览；缺少原生别名不得猜测兼容');
        env.modHubGetModInfo = name => name === 'maplebirch' ? maple : simple;
        env._modHubModState = { sideMods: [{ name: 'maplebirch', enabled: true }, { name: 'Simple Frameworks', enabled: false }],
            sideDisabled: ['Simple Frameworks'] };
        let enableConfirmations = 0;
        env.modHubConfirm = async options => {
            enableConfirmations++;
            assert.ok(options.trustedMessageHtml.includes('重复提供这一技术名'));
            assert.ok(!options.trustedMessageHtml.includes('挂钩逻辑互斥') && !options.trustedMessageHtml.includes('存档损坏'));
            return false;
        };
        assert.equal(await env.modHubToggleSideMod('Simple Frameworks', true), false,
            '管理启用调用同一真实别名提供者检查；取消不得启用第二个框架');
        assert.equal(enableConfirmations, 1);
        assert.equal(env._modHubModState.sideMods[1].enabled, false);
    }

    // 15. SugarCube 段落 (:: Start)、Widget 宏与 NPC 怀孕系统/开局变量未初始化专项诊断测试
    {
        const manager = loadManager({
            modLoaderGui: {
                gModUtils: {
                    getModListNameNoAlias: () => ['FertilityExpansion', 'DoLSims', 'DomRobin']
                }
            }
        });
        const pregnancyLogLines = [
            "[错误] [sugarcube] (:: Start): <<if>>: bad conditional expression in <<if>> clause: TypeError: Cannot read properties of undefined (reading 'pregnancy') <<if C.npc[$_name].pregnancy is undefined>> <<set C.npc[$_name].pregnancy to {}>> <</if>>",
            "[错误] [sugarcube] (:: Start): <<set>>: bad evaluation: TypeError: Cannot read properties of undefined (reading 'pregnancy') <<set $_pregnancy to C.npc[$_name].pregnancy>>",
            "[错误] [sugarcube] (:: Start): <<if>>: bad conditional expression in <<if>> clause: TypeError: Cannot read properties of undefined (reading 'type') <<if !setup.pregnancy.infertile.includes($_name) and setup.pregnancy.typesEnabled.includes(C.npc[$_name].type) and ...",
            "[错误] [sugarcube] (:: Start): <<if>>: bad conditional expression in <<if>> clause: TypeError: Cannot read properties of undefined (reading 'pregnancyAvoidance') <<if !C.npc[$_name].pregnancyAvoidance or $objectVersion.pregnancyAvoidance is undefined>>",
            "[错误] [sugarcube] (:: Start): <<if>>: bad conditional expression in <<elseif>> clause (#1): TypeError: Cannot read properties of undefined (reading 'incompletePregnancyEnabled') <<if ... $settings.incompletePregnancyEnabled ...",
            "[错误] [sugarcube] (:: Start): <<set>>: bad evaluation: TypeError: Cannot set properties of undefined (setting 'pregnancyAvoidance') <<set $objectVersion.pregnancyAvoidance to 1>>",
            "[错误] [sugarcube] (:: Start): <<npcPregnancyUpdater>>: error within widget code (0.5.12.13 Error (:: Start) ... <<npcPregnancyUpdater>>)"
        ];

        const analysis = manager.modHubAnalyzeLogs(pregnancyLogLines);
        assert.equal(analysis.errorCount, 7, '7 行错误日志必须精确计数');
        assert.ok(analysis.errorFiles.includes('Start'), '必须从 (:: Start) 中精准提取段落【Start】');
        assert.ok(analysis.errorFiles.includes('<<npcPregnancyUpdater>>'), '必须精准提取出错宏【<<npcPregnancyUpdater>>】');

        assert.equal(analysis.matchedIssues.length, 1, 'NPC 怀孕变量未定义连锁报错必须归纳为 1 项专项诊断');
        const issue = analysis.matchedIssues[0];
        assert.equal(issue.id, 'npc-pregnancy-init-error', '必须精准命中 npc-pregnancy-init-error 专项诊断，绝不能退化为普通 TypeError');
        assert.ok(issue.desc.includes('npcPregnancyUpdater'), '描述中必须指明出错宏 npcPregnancyUpdater');
        assert.ok(issue.desc.includes('Start'), '描述中必须指明出错段落 Start');
        assert.ok(issue.solution.includes('FertilityExpansion') || issue.solution.includes('生育拓展'), '建议中必须动态包含环境中检测到的机制模组');
        assert.ok(issue.solution.includes('DoLSims') || issue.solution.includes('模拟人生'), '建议中必须动态包含环境中检测到的机制模组');
        assert.ok(issue.solution.includes('还原点'), '建议中必须指导使用还原点');

        // 测试渲染出的卡片
        const diagnosis = createStubElement();
        manager.document.getElementById = id => id === 'modHubLogDiagnosisContainer' ? diagnosis : null;
        manager.modHubRenderLogDiagnosis(analysis);
        assert.ok(diagnosis.innerHTML.includes('[段落] Start'), '界面必须渲染 [段落] Start 徽章');
        assert.ok(diagnosis.innerHTML.includes('[宏] &lt;&lt;npcPregnancyUpdater&gt;&gt;'), '界面必须渲染 [宏] 徽章');
        assert.ok(diagnosis.innerHTML.includes('data-log-search="npcPregnancyUpdater"'), '宏徽章点击搜索词必须智能去除尖括号');

        // 验证混合日志：当存在独立的其他 TypeError 时，两者必须同时保留
        const mixedLogs = [
            ...pregnancyLogLines,
            "[错误] NPCPetSlot TypeError: Cannot read properties of undefined (reading 'isTrusted')"
        ];
        const mixedAnalysis = manager.modHubAnalyzeLogs(mixedLogs);
        assert.equal(mixedAnalysis.errorCount, 8, '8 行错误必须全部计数');
        assert.ok(mixedAnalysis.matchedIssues.some(i => i.id === 'npc-pregnancy-init-error'), '混合日志必须包含 NPC 怀孕专项诊断');
        assert.ok(mixedAnalysis.matchedIssues.some(i => i.id === 'type-error'), '混合日志中独立的不相干 TypeError 必须继续保留独立诊断');
    }
};
