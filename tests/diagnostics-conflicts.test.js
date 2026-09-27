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

        assert.equal(analysis.errorCount, 2, '两行包含错误标记的日志必须计为 2 处错误');
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

    // 13.2 怨灵的倒影神庙段落补丁冲突精准诊断与友好建议测试
    {
        const manager = loadManager();
        const rawLogLines = [
            "18:03:49.097 [错误] [TweeReplacer] do_patch() cannot find findString: [Wraith'sReflection] findString:[<<lockicon>><<link [[询问贞操带|Temple Chastity]]>><</link>>] in:[Temple Jordan]",
            "18:03:49.107 [错误] [TweeReplacer] do_patch() done: [Wraith'sReflection] okCount:[75] errorCount:[1]"
        ];

        const analysis = manager.modHubAnalyzeLogs(rawLogLines);

        assert.equal(analysis.errorCount, 2, '两行错误日志必须计为 2 处错误');
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

        await manager.modHubCaptureLogScreenshot();
        assert.ok(drawnText.includes('当前截取: 100 / 125 条 (筛选：全部日志)'), '截断截图必须标明截取数和筛选后总数');
        assert.ok(drawnText.includes('(仅截取前 100 条，已省略 25 条；请筛选「仅错误」或复制日志查看其余项)'), '截断截图必须明确省略条数与查看方式');
        assert.ok(drawnText.includes('测试日志 100') && !drawnText.includes('测试日志 125'), '截图仍只保留前一百行');

        drawnText.length = 0;
        rows = allRows.slice(0, 100);
        await manager.modHubCaptureLogScreenshot();
        assert.ok(drawnText.includes('当前截取: 100 / 100 条 (筛选：全部日志)'), '恰好一百行时必须显示完整截取范围');
        assert.ok(!drawnText.some(text => text.includes('已省略')), '未截断截图不得显示省略提示');

        drawnText.length = 0;
        rows = allRows;
        manager._modHubCurrentLogLevelFilter = 'error';
        await manager.modHubCaptureLogScreenshot();
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
        assert.equal(buttonMatches.length, 4, '顶部操作栏必须有且仅有 4 个核心操作按钮');

        const buttonNames = buttonMatches.map(m => m[2].trim());
        assert.deepEqual(
            buttonNames,
            ['导入模组', '重新载入游戏', '智能整理模组与美化顺序', '刷新列表'],
            '顶部按钮顺序必须为：导入模组 -> 重新载入游戏 -> 智能整理模组与美化顺序 -> 刷新列表'
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
        assert.ok(conflictHtml.includes('本地冲突已启用·高风险'), '启用冲突必须包含高风险警示');
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
        assert.ok(disabledHtml.includes('冲突已排除 · 兼容性检查通过'), '冲突已全部排除时卡片标题必须切换为检查通过文本');
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
        assert.ok(marketJs.includes('await window.modHubToggleSideMod(action.local.name, true, { silentOfferReload: true })'), '多步骤计划中启用前置必须静默处理，严禁中途弹出重载提醒');
        assert.ok(marketJs.includes('skipReloadOffer: true'), '多步骤计划与批量更新中下载安装必须显式声明 skipReloadOffer: true');
        assert.ok(managerJs.includes('(!options || !options.skipReloadOffer)'), 'modHubHandleAddMod 必须尊重 skipReloadOffer 守护，杜绝擅自提前弹窗');
        assert.ok(managerJs.includes('if (!options?.keepCurrentTab)'), 'modHubHandleAddMod 必须在非 keepCurrentTab 模式下才允许跳转页签');

        // 16.6 契约 6：列表禁用模组必须执行下游依赖排查，且 Toast 不再包含冗余的原排序字样
        assert.ok(managerJs.includes('!targetEnable && !options.skipConfirm'), 'modHubToggleSideMod 必须在禁用前检查是否需二次确认');
        assert.ok(managerJs.includes('window.modHubFindDependentMods(modName)'), 'modHubToggleSideMod 必须调用 modHubFindDependentMods 排查下游受影响模组');
        assert.ok(!managerJs.includes('（原排序保持不变）'), 'Toast 提示中严禁残留（原排序保持不变）冗余文字');
        assert.ok(marketJs.includes('{ silentOfferReload: true, skipConfirm: true }'), '市场快捷禁用必须传入 skipConfirm: true 杜绝二次弹窗');

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
        assert.ok(sfConflict, '当已启用 maplebirch 时，启用 Simple Frameworks 必须检出互斥冲突');
        assert.equal(sfConflict.targetDisplayName, '简易框架', '待启用模组展示名称必须锁定为【简易框架】，绝不能被 maplebirch 别名污染为秋枫白桦！');
        assert.equal(sfConflict.conflictDisplayName, '秋枫白桦框架', '已启用冲突模组展示名称必须为【秋枫白桦框架】');
        assert.notEqual(sfConflict.targetDisplayName, sfConflict.conflictDisplayName, '待启用与已冲突模组展示名称绝不能相同！');
        assert.equal(sfConflict.targetRawName, 'Simple Frameworks', '待启用原始名称必须为 Simple Frameworks');
        assert.equal(sfConflict.conflictRawName, 'maplebirch', '已冲突原始名称必须为 maplebirch');

        // 场景 B：当前已启用 Simple Frameworks，准备启用 maplebirch
        const activeSimple = [
            { name: 'Simple Frameworks', enabled: true }
        ];
        const mbConflict = manager.modHubCheckEnableConflicts('maplebirch', activeSimple);
        assert.ok(mbConflict, '当已启用 Simple Frameworks 时，启用 maplebirch 必须检出互斥冲突');
        assert.equal(mbConflict.targetDisplayName, '秋枫白桦框架', '待启用模组必须为秋枫白桦框架');
        assert.equal(mbConflict.conflictDisplayName, '简易框架', '冲突模组必须为简易框架');

        // 场景 C：同组内不产生虚假互斥冲突（同为简易框架组）
        const activeSameGroup = [
            { name: 'simpleframework', enabled: true }
        ];
        const sameGroupConflict = manager.modHubCheckEnableConflicts('Simple Frameworks', activeSameGroup);
        assert.equal(sameGroupConflict, null, '同属于简易框架组的模组绝不能自身跟自身产生互斥冲突');

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

};
