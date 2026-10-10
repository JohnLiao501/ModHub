// ModHub 帮助中心：只读检查、证据边界、过期快照与纯文本求助报告。
const {
    assert, fs, path, srcRoot, bootJson, readStyles, createStubElement, createBaseSandbox, loadScripts, createMockController,
} = require('./helpers');

const boot = (name, extra = {}) => ({ name, version: '1.0.0', ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const issueText = issue => [issue.title, issue.evidence, issue.advice].join(' ');
const hasIssue = (snapshot, status, pattern) => snapshot.issues.some(issue => issue.status === status && pattern.test(issueText(issue)));

function loadHelp(options = {}) {
    const installed = options.installed || { Example: boot('Example') };
    const enabled = options.enabled || Object.keys(installed);
    const state = {
        lists: { ok: true, enabled: [...enabled], disabled: [...(options.disabled || [])], error: null },
        installed,
        reads: [],
        toasts: [],
    };
    const runtime = options.runtime || enabled.map(name => ({ name, bootJson: installed[name], source: 'IndexDB' }));
    const cache = runtime.map(item => ({ mod: { name: item.name, bootJson: item.bootJson }, from: item.source || 'IndexDB' }));
    const forbidden = () => { throw new Error('帮助中心不得写入配置或执行安装'); };
    const elements = new Map();
    for (const id of ['modHubHelpContainer', 'modHubHelpResults', 'modHubHelpReport', 'modHubHelpAllLogs']) {
        const element = createStubElement(id === 'modHubHelpReport' ? 'textarea' : 'div');
        element.id = id;
        element.isConnected = true;
        element.select = () => {};
        element.setSelectionRange = () => {};
        elements.set(id, element);
    }
    elements.get('modHubHelpContainer').querySelector = selector => {
        const id = selector.replace(/^#/, '');
        if (!elements.has(id)) {
            const element = createStubElement('button');
            element.id = id;
            element.isConnected = true;
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const gui = {
        gLoadingProgress: { logList: options.logs || [] },
        gModUtils: {
            version: '2.101.1',
            getModListNameNoAlias: () => runtime.map(item => item.name),
            getModLoader: () => ({ getModCacheArray: () => cache,
                getModReadCache: () => ({ get_Array: () => cache }) }),
        },
    };
    const sb = createBaseSandbox({
        StartConfig: { version: '0.5.10.12' },
        modLoaderGui: gui,
        navigator: { clipboard: { writeText: async text => { state.copied = text; } } },
        localStorage: { getItem: () => null, setItem: forbidden, removeItem: forbidden },
        modHubGetGui: () => gui,
        modHubGetAllKnownModNames: () => new Set(runtime.map(item => item.name)),
        modHubGetModInfo: name => cache.find(item => item.mod.name === name)?.mod || null,
        modHubGetController: () => ({ overwriteModIndexDBModList: forbidden,
            overwriteModIndexDBHiddenModList: forbidden, removeModIndexDB: forbidden }),
        modHubReadIndexDBModLists: async () => {
            state.reads.push('lists');
            return { ...state.lists, enabled: [...state.lists.enabled], disabled: [...state.lists.disabled] };
        },
        modHubReadInstalledModBoot: async name => {
            state.reads.push(name);
            const value = state.installed[name];
            const bootJson = value instanceof Error ? null : plain(value || null);
            await options.onRead?.(name, state, sb);
            return { name, bootJson,
                error: value instanceof Error ? value : null, missing: !value };
        },
        modHubSaveModManageState: forbidden,
        modHubRunManagerAction: forbidden,
        modHubRepairOrphanedModLists: forbidden,
        modHubShowToast: (message, type) => { state.toasts.push({ message, type }); },
        modHubEscapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
        modHubMarket: { isInstallBusy: () => false, mods: [] },
        modHubRestore: { isRestoring: () => false, showHistory: forbidden },
        modHubIsReloadBusy: () => Boolean(sb._modHubManagerBusy || sb._modHubModLoading),
        _modHubReloadRevision: 0,
    });
    sb.document.getElementById = id => elements.get(id) || null;
    sb.document.querySelector = selector => selector.startsWith('#') ? elements.get(selector.slice(1)) || null : null;
    // 原生比较器保留真实接口形状；具体语法边界由共享版本模块核验。
    sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
        parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
        parseRange: value => value.split('||').map(range => ({ range })),
        satisfies: (version, ranges) => !ranges[0].range.startsWith('>=9'),
    }) }) };
    const { modHubConfirm, modHubAlert, modHubShowToast } = sb;
    loadScripts(sb, ['javascript/modhub-dialog.js', 'javascript/modhub-log.js', 'javascript/modhub-market-versions.js', 'javascript/modhub-help.js']);
    Object.assign(sb, { modHubConfirm, modHubAlert, modHubShowToast });
    return { sb, help: sb.modHubHelp, state, elements };
}

// 修复用例使用真实管理器锁、列表保存与回读；默认 loadHelp 仍禁止任何写入。
function loadRepairHelp(options = {}) {
    const fixture = loadHelp(options);
    const { sb, state } = fixture;
    const readBoot = sb.modHubReadInstalledModBoot;
    const events = [];
    const controller = createMockController({ enabled: state.lists.enabled, disabled: state.lists.disabled });
    sb.console = { log() {}, warn() {}, error() {} };
    loadScripts(sb, ['javascript/modhub-manager.js']);
    sb.modHubReadInstalledModBoot = readBoot;
    sb.modModLoadController = controller;
    const gui = sb.modHubGetGui();
    gui.listSideLoadModNameOnly = () => controller.listModIndexDB();
    gui.listSideLoadHiddenModNameOnly = () => controller.loadHiddenModList();
    sb._modHubModState = { sideMods: [
        ...controller.store.enabled.map(name => ({ name, enabled: true })),
        ...controller.store.disabled.map(name => ({ name, enabled: false })),
    ], sideEnabled: [...controller.store.enabled], sideDisabled: [...controller.store.disabled], builtInMods: [] };
    const storage = new Map();
    sb.localStorage = { getItem: name => storage.get(name) || null,
        setItem: (name, value) => { events.push('本地配置:' + name); storage.set(name, value); },
        removeItem: name => { events.push('移除本地配置:' + name); storage.delete(name); } };
    for (const method of ['overwriteModIndexDBModList', 'overwriteModIndexDBHiddenModList']) {
        const write = controller[method];
        controller[method] = async list => {
            assert.equal(sb._modHubManagerBusy, true, '写入必须在管理器锁内');
            assert.ok(state.restoreContexts.some(context => context.prepared && !context.finished), '必须先建立操作前还原点');
            events.push(method);
            return write(list);
        };
    }
    state.restoreContexts = [];
    let owner = null;
    sb.modHubRestore = {
        isRestoring: () => false,
        isOperationBlocked: context => Boolean(owner && owner !== context),
        createOperation: meta => {
            const context = { ...meta, id: '修复还原点-' + state.restoreContexts.length };
            state.restoreContexts.push(context);
            events.push('创建还原上下文');
            return context;
        },
        claim: context => { owner = context; events.push('取得还原锁'); return true; },
        prepare: async context => {
            events.push('建立还原点');
            if (options.prepareFailure) throw new Error('建立还原点失败');
            context.prepared = true;
            return true;
        },
        finish: async context => {
            events.push('整理还原点');
            if (options.finishFailure) throw new Error('还原点整理失败');
            context.finished = true;
        },
        release: context => { if (owner === context) owner = null; events.push('释放还原锁'); },
        getRecoveryInfo: enabled => ({ order: [...enabled], protectedNames: [], issues: [] }),
        keepRecoveryOrder: names => [...names],
    };
    sb.modHubRenderModManageUI = sb.modHubUpdateManagerStatus = () => {};
    sb.modHubLoadBeautyState = async () => { events.push('读取美化'); return true; };
    sb.modHubSaveBeautyState = async () => { events.push('保存美化'); throw new Error('帮助修复不得改写美化配置'); };
    sb.modHubConfirm = async prompt => {
        state.confirmations = [...(state.confirmations || []), prompt];
        events.push('确认修复');
        return options.confirm ? options.confirm(prompt, fixture) : true;
    };
    sb.modHubAlert = async (message, title) => { state.alerts = [...(state.alerts || []), { message, title }]; };
    sb.modHubOfferReload = async message => {
        assert.equal(sb._modHubManagerBusy, false, '重载提示必须在管理器锁释放后');
        assert.equal(owner, null, '重载提示必须在还原锁释放后');
        events.push('提示重载');
        state.reloadMessages = [...(state.reloadMessages || []), message];
    };
    return Object.assign(fixture, { controller, events });
}

module.exports = async function() {
    // 第五个页签与普通模块加载契约，帮助中心不能进入早期救援依赖链。
    assert.equal(bootJson.scriptFileList.at(-1), 'javascript/modhub-help.js');
    assert.ok(!bootJson.scriptFileList_inject_early.includes('javascript/modhub-help.js'));
    const template = fs.readFileSync(path.join(srcRoot, 'twee/modloader/modloader.twee'), 'utf8');
    assert.ok(template.indexOf('<<button "帮助中心">>') > template.indexOf('<<button "加载日志">>'));
    assert.match(template, /id="modHubHelpContainer"/);
    assert.match(template, /modHubHelp\??\.init/);

    // 本页所有按钮（含折叠区内入口）都保留移动端触控高度，并允许文字换行增高。
    const helpButtons = readStyles().match(/#modHubHelpContainer\s+button\s*\{([^}]*)\}/);
    assert.ok(helpButtons, '帮助中心通用按钮样式不能只覆盖操作栏');
    assert.match(helpButtons[1], /min-height:\s*32px\s*!important\s*;/);
    assert.match(helpButtons[1], /(?:^|[;\s])height:\s*auto\s*!important\s*;/);
    assert.match(helpButtons[1], /white-space:\s*normal\s*!important\s*;/);
    assert.match(helpButtons[1], /max-width:\s*100%\s*;/);

    // 自有 AI 界面不依赖枫叶原生服务，进入页面不会自动发送请求。
    {
        const f = loadHelp();
        f.help.init();
        assert.match(f.elements.get('modHubHelpContainer').innerHTML, /modHubHelpAi/);
        assert.doesNotMatch(f.elements.get('modHubHelpContainer').innerHTML, /data-help-maple/);
        assert.equal(f.help.openMapleRepair, undefined);
        assert.equal(f.state.reads.length, 0);
    }

    // 共享包体读取器只读真实仓库，并明确区分缺包与无法核验。
    {
        const data = new Map([['包:Example', { bytes: '真实包体' }]]);
        const store = {};
        const calls = [];
        const forbidden = () => { throw new Error('只读检查禁止写入'); };
        const loader = { customStore: store, constructor: { calcModNameKey: name => `包:${name}` } };
        const controller = { checkModZipFileIndexDB: async bytes => {
            calls.push(['校验', bytes]);
            return boot('Example');
        }, overwriteModIndexDBModList: forbidden, overwriteModIndexDBHiddenModList: forbidden,
        removeModIndexDB: forbidden };
        const utils = { getModLoader: () => ({ getIndexDBLoader: () => loader }),
            getIdbKeyValRef: () => ({ get: async (key, actualStore) => {
                assert.equal(actualStore, store);
                calls.push(['读取', key]);
                return data.get(key);
            }, set: forbidden, del: forbidden }) };
        const sb = createBaseSandbox({ modLoaderGui: { gModUtils: utils }, modModLoadController: controller,
            console: { log() {}, warn() {}, error() {} },
            localStorage: { getItem: () => null, setItem: forbidden, removeItem: forbidden } });
        loadScripts(sb, ['javascript/modhub-manager.js']);
        const valid = await sb.modHubReadInstalledModBoot('Example');
        assert.equal(valid.bootJson.name, 'Example');
        assert.equal(valid.error, null);
        assert.equal(valid.missing, false);
        assert.deepEqual(calls.map(item => item[0]), ['读取', '校验']);
        assert.equal((await sb.modHubReadInstalledModBoot('Missing')).missing, true);
        controller.checkModZipFileIndexDB = async () => boot('Other');
        assert.match((await sb.modHubReadInstalledModBoot('Example')).error.message, /技术名|登记名称/);
        controller.checkModZipFileIndexDB = async () => boot('example');
        assert.match((await sb.modHubReadInstalledModBoot('Example')).error.message, /技术名|登记名称/, '原生仓库技术名区分大小写');
        controller.checkModZipFileIndexDB = async () => { throw new Error('字节校验异常'); };
        assert.match((await sb.modHubReadInstalledModBoot('Example')).error.message, /字节校验异常/);
        delete loader.customStore;
        const unavailable = await sb.modHubReadInstalledModBoot('Example');
        assert.equal(unavailable.missing, false);
        assert.match(unavailable.error.message, /读取接口/);
    }

    // 帮助跳转指定日志词时，等日志初始化后应用一次，不能被首错定位抢走。
    {
        const events = [];
        const pending = [];
        const overlay = createStubElement();
        const log = createStubElement();
        const sb = createBaseSandbox({
            console: { log() {}, warn() {}, error() {} },
            setTimeout: callback => { pending.push(callback); return pending.length; },
            Wikifier: { wikifyEval: () => { events.push('渲染页签'); } },
        });
        sb.document.getElementById = id => ({ customOverlay: overlay, modHubLogContent: log }[id] || null);
        loadScripts(sb, ['javascript/modhub-manager.js', 'javascript/modhub-log.js']);
        pending.length = 0;
        sb.modHubGetRawModLoaderLogs = () => [];
        sb.modHubRenderLogDiagnosis = () => {};
        sb.modHubRenderStructuredLogs = () => {};
        sb.modHubSetLogLevelFilter = () => {};
        sb.modHubSetLogSearch = query => { events.push(`搜索:${query}`); };
        sb.modHubScrollToFirstError = () => { events.push('首错'); };
        assert.equal(sb.modHubOpenManager('加载日志', { logSearch: 'Required' }), true);
        assert.equal(sb._modHubPendingLogSearch, 'Required');
        assert.ok(!events.includes('搜索:Required'));
        sb._modHubPendingScrollToFirstError = true;
        sb.modHubInitLogTools();
        assert.equal(sb._modHubPendingLogSearch, null);
        assert.equal(sb._modHubPendingScrollToFirstError, false);
        assert.equal(events.filter(event => event === '搜索:Required').length, 1);
        sb.modHubInitLogTools();
        pending.splice(0).forEach(callback => callback());
        assert.equal(events.filter(event => event === '搜索:Required').length, 1);
        assert.ok(!events.includes('首错'));

        // 呼出失败或改看其他页签，不能把检索词遗留给下一次日志打开。
        const wikifier = sb.Wikifier;
        sb.Wikifier = undefined;
        assert.equal(sb.modHubOpenManager('加载日志', { logSearch: 'Failed' }), false);
        assert.equal(sb._modHubPendingLogSearch, null);
        assert.equal(sb._modHubPendingScrollToFirstError, false);
        sb.Wikifier = wikifier;
        sb.modHubOpenManager('加载日志', { logSearch: 'Abandoned' });
        sb.modHubOpenManager('帮助中心');
        assert.equal(sb._modHubPendingLogSearch, null);
        assert.equal(sb._modHubPendingScrollToFirstError, false);
        sb.modHubInitLogTools();
        assert.ok(!events.includes('搜索:Abandoned'));

        // 两种旧首错定时器都不能抢占更新一轮的关键词导航。
        for (const oldTimer of ['呼出', '日志初始化']) {
            events.length = pending.length = 0;
            sb.modHubOpenManager('加载日志');
            if (oldTimer === '呼出') pending.shift()();
            else sb.modHubInitLogTools();
            sb.modHubOpenManager('加载日志', { logSearch: 'Latest' });
            sb.modHubInitLogTools();
            pending.splice(0).forEach(callback => callback());
            assert.equal(events.filter(event => event === '搜索:Latest').length, 1);
            assert.ok(!events.includes('首错'), `${oldTimer}旧定时器不能覆盖新检索`);
        }
    }

    // 首次进入只展示已有日志；显式检查只读真实列表与包体。
    {
        const { sb, help, state, elements } = loadHelp();
        for (const method of ['init', 'check', 'buildReport', 'copyReport']) assert.equal(typeof help[method], 'function');
        help.init();
        assert.equal(state.reads.length, 0, '进入帮助中心不能自动读取安装包');
        const initialHtml = elements.get('modHubHelpContainer').innerHTML;
        assert.match(initialHtml, /检查并查找可用修复/);
        assert.match(initialHtml, /<select id="modHubHelpSymptom">/);
        assert.ok(!/\bopen\b/.test(initialHtml.match(/<details[^>]*id="modHubHelpReportDetails"[^>]*>/)[0]), '求助报告入口默认收起');
        assert.ok(!/\bopen\b/.test(elements.get('modHubHelpResults').innerHTML.match(/<details[^>]*id="modHubHelpLogDetails"[^>]*>/)[0]), '原运行日志默认收起');
        const symptom = elements.get('modHubHelpSymptom');
        symptom.value = '3';
        symptom.onchange();
        assert.match(elements.get('modHubHelpTopic').innerHTML, /图片缺失|美化/);
        assert.match(elements.get('modHubHelpTopic').innerHTML, /data-help-images/);
        symptom.value = '';
        symptom.onchange();
        assert.equal(elements.get('modHubHelpTopic').innerHTML, '');
        await elements.get('modHubHelpContainer').onclick({ target: { closest: selector => selector === '[data-help-topic]' ? { dataset: { helpTopic: '3' } } : null } });
        assert.equal(symptom.value, '3');
        assert.equal(elements.get('modHubHelpLocalDetails').open, true, '首页常见问题应展开对应本地排查');
        assert.match(elements.get('modHubHelpTopic').innerHTML, /data-help-images/);
        assert.equal(state.reads.length, 0, '选择症状仍不能自动改写或读取安装包');
        const snapshot = await help.check();
        assert.equal(snapshot.stale, false);
        assert.equal(snapshot.different, false);
        assert.equal(snapshot.lists.ok, true);
        assert.ok(state.reads.filter(item => item === 'lists').length >= 2, '检查必须回读配置以排除过期');
        assert.ok(state.reads.filter(item => item === 'Example').length >= 2, '同名包替换必须通过回读声明识别');
        assert.equal(snapshot.issues.filter(issue => issue.status === 'problem').length, 0);
    }

    // 包内技术名与 alias 是唯一依赖身份来源，不使用昵称或简介猜测。
    {
        const { help } = loadHelp({ installed: {
            Provider: boot('Provider', { alias: ['Actual API'], nickName: 'Display API', description: 'Missing API' }),
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: '*' }, { modName: 'Display API', version: '*' }] }),
        } });
        const snapshot = await help.check();
        assert.ok(!snapshot.issues.some(issue => /Actual API/.test(issueText(issue))), '有效 alias 提供者不能被误报缺失');
        assert.ok(hasIssue(snapshot, 'problem', /Display API/), '显示名称不能充当依赖提供者');
    }

    // 前置缺失、禁用、顺序、版本与重复提供者分别给出有依据的状态。
    {
        const cases = [
            { label: '缺失', installed: { Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '*' }] }) }, enabled: ['Consumer'], status: 'problem', pattern: /Required/ },
            { label: '禁用', installed: { Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '*' }] }), Required: boot('Required') }, enabled: ['Consumer'], disabled: ['Required'], status: 'problem', pattern: /未启用|禁用/ },
            { label: '顺序', installed: { Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '*' }] }), Required: boot('Required') }, enabled: ['Consumer', 'Required'], status: 'problem', pattern: /顺序|之前|之后/ },
            { label: '版本不符', installed: { Required: boot('Required'), Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '>=9.0.0' }] }) }, status: 'problem', pattern: /版本|范围/ },
            { label: '版本未知', installed: { Required: boot('Required'), Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '~1.0.0' }] }) }, status: 'review', pattern: /~1\.0\.0|版本|范围/ },
            { label: '重复提供者', installed: { First: boot('First', { alias: ['Required'] }), Second: boot('Second', { alias: ['Required'] }), Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '*' }] }) }, status: 'review', pattern: /多个|重复|提供/ },
        ];
        for (const item of cases) {
            const { help } = loadHelp(item);
            const snapshot = await help.check();
            assert.equal(snapshot.stale, false, item.label);
            assert.ok(hasIssue(snapshot, item.status, item.pattern), `必须区分${item.label}：${JSON.stringify(snapshot.issues)}`);
        }
    }

    // 同技术名的旁加载包会替换内置档案；不同技术名共用 alias 仍需核对。
    {
        const installed = {
            Provider: boot('Provider', { alias: ['Current API'] }),
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Current API', version: '*' }, { modName: 'Old API', version: '*' }] }),
        };
        const runtime = [
            { name: 'Provider', bootJson: boot('Provider', { alias: ['Old API'] }), source: 'Local' },
            { name: 'Consumer', bootJson: installed.Consumer, source: 'IndexDB' },
        ];
        const { help } = loadHelp({ installed, runtime });
        const snapshot = await help.check();
        assert.ok(!snapshot.issues.some(issue => issue.id.startsWith('providers-')), '同技术名的运行档案与已保存包不能重复计数');
        assert.ok(!snapshot.issues.some(issue => /Current API/.test(issueText(issue))), '同名覆盖后按已保存包的 alias 检查');
        assert.ok(hasIssue(snapshot, 'problem', /Old API/), '已被覆盖的旧 alias 不能继续满足前置');

        const shared = loadHelp({ installed: { Provider: boot('Provider', { alias: ['Shared API'] }) }, runtime: [
            { name: 'Builtin', bootJson: boot('Builtin', { alias: ['Shared API'] }), source: 'Local' },
            { name: 'Provider', bootJson: boot('Provider', { alias: ['Shared API'] }), source: 'IndexDB' },
        ] });
        assert.ok(hasIssue(await shared.help.check(), 'review', /Shared API.*Builtin.*Provider/), '不同技术名共用 alias 仍保留多个真实提供者');
    }

    // 本次运行来源以已加载缓存为准，不使用同名原始读取档案覆盖。
    {
        const f = loadHelp({ installed: { Provider: boot('Provider') } });
        const utils = f.sb.modHubGetGui().gModUtils;
        const loader = utils.getModLoader();
        loader.getModReadCache = () => ({ get_Array: () => [
            { from: 'Local', mod: { name: 'Provider', bootJson: boot('Provider') } },
            ...loader.getModCacheArray(),
        ] });
        utils.getModLoader = () => loader;
        const snapshot = await f.help.check();
        assert.equal(snapshot.runtime[0].source, 'IndexDB');
        assert.equal(snapshot.builtins.length, 0);
        assert.equal(snapshot.different, false);
        assert.ok(!snapshot.issues.some(issue => issue.id.startsWith('providers-')));
    }

    // 原生依赖映射区分大小写，不能把相似技术名或 alias 视为满足。
    {
        const { sb, help } = loadHelp({ installed: {
            Provider: boot('Provider', { alias: ['Actual API', ' Padded API '] }),
            Consumer: boot('Consumer', { dependenceInfo: [
                { modName: 'provider', version: '*' }, { modName: 'actual api', version: '*' },
                { modName: 'Padded API', version: '*' },
            ] }),
        } });
        sb.modHubMarketInstaller = { getDependencyBootNames: () => { throw new Error('不能用市场名称规范化代替原生依赖索引'); } };
        const snapshot = await help.check();
        assert.ok(hasIssue(snapshot, 'problem', /provider/));
        assert.ok(hasIssue(snapshot, 'problem', /actual api/));
        assert.ok(hasIssue(snapshot, 'problem', /Padded API/));
    }

    // 原生顺序要求提供者严格在前；模组自己的 alias 不能作为自身前置。
    {
        const { help } = loadHelp({ installed: { Example: boot('Example', {
            alias: ['Self API'], dependenceInfo: [{ modName: 'Self API', version: '*' }],
        }) } });
        assert.ok(hasIssue(await help.check(), 'problem', /顺序|之前/));
    }

    // 游戏与加载器依赖使用当前真实版本；不能当作未安装模组。
    {
        const { help } = loadHelp({ installed: { Example: boot('Example', { dependenceInfo: [
            { modName: 'GameVersion', version: '>=9.0.0' }, { modName: 'ModLoader', version: '~2.0.0' },
        ] }) } });
        const snapshot = await help.check();
        assert.ok(hasIssue(snapshot, 'problem', /GameVersion|游戏|DoL/));
        assert.ok(hasIssue(snapshot, 'review', /ModLoader/));
        assert.ok(!snapshot.issues.some(issue => /(?:GameVersion|ModLoader).*(?:未安装|缺失)/.test(issueText(issue))));
    }

    // GameVersion 延续原生忽略后缀契约，普通前置仍使用严格版本判断。
    {
        const { sb, help } = loadHelp({ installed: { Example: boot('Example', {
            dependenceInfo: [{ modName: 'GameVersion', version: '>=0.5.10.12' }],
        }) } });
        sb.StartConfig.version = '0.5.10.12-beta';
        const calls = [];
        sb.modSC2DataManager.getDependenceChecker = () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: value => ({ version: { version: value.split('-')[0].split('.').map(Number), preRelease: 'beta' } }),
            parseRange: value => [{ range: value }],
            satisfies: (version, ranges, ignorePostfix) => { calls.push(ignorePostfix); return ignorePostfix === true; },
        }) });
        let snapshot = await help.check();
        assert.deepEqual(calls, [true]);
        assert.ok(!snapshot.issues.some(issue => /GameVersion/.test(issueText(issue))));
        sb.StartConfig.version = '0.5.10.12-汉化版';
        snapshot = await help.check();
        assert.ok(hasIssue(snapshot, 'review', /GameVersion/), '宽松原生解析器不能使未支持的后缀冒充完整解析');
        assert.deepEqual(calls, [true]);
    }

    // 包体不可读时，无法穷尽 alias，必须保留原因而不能断定依赖缺失。
    {
        const { help } = loadHelp({ installed: {
            Broken: new Error('安装包校验失败：头部损坏'),
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Unknown API', version: '*' }] }),
        } });
        const snapshot = await help.check();
        assert.ok(hasIssue(snapshot, 'review', /头部损坏/));
        assert.ok(hasIssue(snapshot, 'review', /Unknown API/));
        assert.ok(!hasIssue(snapshot, 'problem', /Unknown API/), '未读完所有声明不能确认缺失');
    }

    // 真实内置提供者也可满足依赖；未识别来源不能被误报为已保存配置变化。
    {
        const consumer = boot('Consumer', { dependenceInfo: [{ modName: 'Builtin API', version: '*' }] });
        const { sb, help } = loadHelp({ installed: { Consumer: consumer }, runtime: [
            { name: 'Builtin', bootJson: boot('Builtin', { alias: ['Builtin API'] }), source: 'Local' },
            { name: 'Consumer', bootJson: consumer, source: 'IndexDB' },
        ] });
        let snapshot = await help.check();
        assert.ok(!snapshot.issues.some(issue => /Builtin API/.test(issueText(issue))));
        assert.equal(snapshot.different, false);
        sb.modHubGetGui().gModUtils.getModLoader().getModCacheArray()[1].from = '';
        snapshot = await help.check();
        assert.equal(snapshot.different, false, '来源未知不是配置变化的证据');
        assert.ok(hasIssue(snapshot, 'review', /来源|差异暂不能/));
    }

    // 框架组合必须通过既有精确身份规则，并复用共享风险说明。
    {
        const { sb, help } = loadHelp({ installed: {
            Maple: boot('Maple'), Simple: boot('Simple'), Unrelated: boot('Unrelated', { nickName: 'Maple' }),
        } });
        const calls = [];
        sb.modHubMarket.KNOWN_MOD_CONFLICT_RULES = [{ id: 'framework-pair', conflictingGroups: [
            { key: 'maplebirch', technicalName: 'Maple' }, { key: 'simpleframework', technicalName: 'Simple' },
        ] }];
        sb.modHubMarket.isModMatchingConflictGroup = (item, group) => item.bootJson.name === group.technicalName;
        sb.modHubGetFrameworkPairRisk = (maple, simple) => {
            calls.push([maple.bootJson.name, simple.bootJson.name]);
            return { reason: '共享框架规则的具体依据', advice: '共享框架规则的建议' };
        };
        const snapshot = await help.check();
        assert.deepEqual(calls, [['Maple', 'Simple']]);
        assert.ok(hasIssue(snapshot, 'review', /共享框架规则的具体依据/));
    }

    // 原始读取缓存中被拒绝加载的内置包，不能被当作已启用提供者。
    {
        const { sb, help } = loadHelp({ installed: {
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Target', version: '*' }] }),
        } });
        const utils = sb.modHubGetGui().gModUtils;
        const loader = utils.getModLoader();
        const raw = [...loader.getModCacheArray(), {
            from: 'Local', mod: { name: 'Denied', bootJson: boot('Denied', { alias: ['Target'] }) },
        }];
        loader.getModReadCache = () => ({ get_Array: () => raw });
        utils.getModLoader = () => loader;
        const snapshot = await help.check();
        assert.ok(!snapshot.runtime.some(item => item.name === 'Denied'));
        assert.ok(hasIssue(snapshot, 'problem', /Target/), '原始缓存中有包不代表该包已经加载');
    }

    // 本次运行与已保存配置分开比较，包括同名包在重载前升级的情况。
    {
        const { help } = loadHelp({ installed: { Example: boot('Example', { version: '2.0.0' }) },
            runtime: [{ name: 'Example', bootJson: boot('Example') }] });
        const snapshot = await help.check();
        assert.equal(snapshot.different, true);
        const report = help.buildReport(snapshot);
        assert.match(report, /本次运行/);
        assert.match(report, /已保存/);
        assert.match(report, /1\.0\.0/);
        assert.match(report, /2\.0\.0/);
    }

    // 配置列表、同名包声明、操作轮次变化均使检查快照过期。
    {
        for (const change of [
            (state, sb) => { state.lists.disabled.push('Later'); },
            (state, sb) => { state.installed.Example.version = '2.0.0'; },
            (state, sb) => { sb._modHubReloadRevision++; },
        ]) {
            let changed = false;
            const { help } = loadHelp({ onRead: async (name, state, sb) => {
                if (changed) return;
                changed = true;
                // 在首份声明已取出后的微任务修改配置，保证与尾部回读不同。
                Promise.resolve().then(() => change(state, sb));
            } });
            const snapshot = await help.check();
            assert.equal(snapshot.stale, true, '变化期间的检查必须标记过期');
            assert.ok(hasIssue(snapshot, 'review', /变化|重新检查|过期/));
        }
    }

    // 未知错误保留真实日志；没有规则命中不能声称兼容。
    {
        const { help } = loadHelp({ logs: [{ type: 'error', str: 'UnclassifiedError: 独立异常 xyz987' }] });
        const snapshot = await help.check();
        assert.equal(snapshot.analysis.errorCount, 1);
        assert.ok(snapshot.issues.length > 0);
        assert.ok(!snapshot.issues.some(issue => /完全兼容|可正常游玩|保证正常/.test(issueText(issue))));
    }

    // 报告是纯文本：默认错误与警告，可选择完整日志，HTML 原文不可被执行或丢失。
    {
        const html = '<img src=x onerror="window.compromised=true">';
        const { help, state, sb, elements } = loadHelp({ installed: { ModHub: boot('ModHub', { version: '1.4.0',
            dependenceInfo: [{ modName: html, version: '*' }] }) }, logs: [
            { type: 'error', str: `错误原文 ${html}` },
            { type: 'warning', str: '警告原文 warn-only' },
            { type: 'info', str: '信息原文 info-only' },
        ] });
        const snapshot = await help.check();
        const report = help.buildReport(snapshot, { allLogs: false });
        assert.match(report, /0\.5\.10\.12/);
        assert.match(report, /2\.101\.1/);
        assert.match(report, /1\.4\.0/);
        assert.ok(report.includes(html), '求助报告必须保留原始错误正文');
        assert.match(report, /warn-only/);
        assert.ok(!report.includes('info-only'));
        assert.match(help.buildReport(snapshot, { allLogs: true }), /info-only/);
        help.init();
        await elements.get('modHubHelpPreview').onclick();
        assert.ok(elements.get('modHubHelpReport').value.includes(html), 'UI 报告必须写入 textarea.value');
        assert.ok(elements.get('modHubHelpResults').innerHTML.includes('&lt;img'), '界面证据必须转义不可信技术名');
        assert.ok(!elements.get('modHubHelpResults').innerHTML.includes(html));
        assert.equal(await help.copyReport(report), true);
        assert.equal(state.copied, report);
        elements.get('modHubHelpReport').value = report;
        sb.navigator.clipboard.writeText = async () => { throw new Error('系统拒绝剪贴板访问'); };
        assert.equal(await help.copyReport(report), false);
        assert.equal(elements.get('modHubHelpReport').value, report, '复制失败必须保留可手动复制的报告');
        assert.ok(state.toasts.some(item => /手动|选择|复制/.test(item.message)));
        assert.equal(sb.compromised, undefined);
    }

    // 两次检查交错完成时，旧请求不得覆盖较新结果或预览报告。
    {
        let release;
        let started;
        let firstRead = true;
        const gate = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { started = resolve; });
        const { help, state, elements } = loadHelp({ onRead: async () => {
            if (!firstRead) return;
            firstRead = false;
            started();
            await gate;
        } });
        help.init();
        const older = elements.get('modHubHelpCheck').onclick();
        await entered;
        state.installed.Example.dependenceInfo = [{ modName: 'Later API', version: '*' }];
        await elements.get('modHubHelpPreview').onclick();
        const result = elements.get('modHubHelpResults').innerHTML;
        const report = elements.get('modHubHelpReport').value;
        assert.match(result, /Later API/);
        assert.match(report, /Later API/);
        release();
        await older;
        assert.equal(elements.get('modHubHelpResults').innerHTML, result);
        assert.equal(elements.get('modHubHelpReport').value, report);
    }

    // 时间点入口的异步和同步失败都使用原生提示的字符串参数，并保留原因。
    {
        const { sb, help, elements } = loadHelp();
        help.init();
        const restoreButton = { closest: selector => selector === '[data-help-restore]' ? restoreButton : null };
        for (const showHistory of [
            () => Promise.reject(new Error('历史目录读取被拒绝')),
            () => { throw new Error('恢复引擎尚未注册'); },
        ]) {
            const alerts = [];
            sb.modHubAlert = (message, title) => { alerts.push({ message, title }); };
            sb.modHubRestore.showHistory = showHistory;
            assert.doesNotThrow(() => elements.get('modHubHelpContainer').onclick({ target: restoreButton }));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(alerts.length, 1);
            assert.equal(alerts[0].title, '无法打开时间点还原');
            assert.equal(typeof alerts[0].message, 'string');
            assert.match(alerts[0].message, /历史目录读取被拒绝|恢复引擎尚未注册/);
        }
    }

    // 管理器的操作锁仍生效时，不能生成可发布的检查快照。
    {
        const { sb, help } = loadHelp();
        sb._modHubManagerBusy = true;
        assert.equal((await help.check()).stale, true, '配置正在保存时不得发布有效检查');
    }

    // 图像排查按钮先确认；取消不刷新，成功仍待玩家验证，失败保留具体原因。
    {
        const { sb, help, state, elements } = loadHelp();
        let accepted = false;
        let count = 0;
        let outcome = true;
        sb.modHubConfirm = async () => accepted;
        sb.modHubRefreshBeautyImages = () => { count++; return outcome; };
        help.init();
        const imageButton = { closest: selector => selector === '[data-help-images]' ? imageButton : null };
        await elements.get('modHubHelpContainer').onclick({ target: imageButton });
        assert.equal(count, 0);
        accepted = true;
        await elements.get('modHubHelpContainer').onclick({ target: imageButton });
        assert.equal(count, 1);
        assert.equal(elements.get('modHubHelpStatus').className, 'gold');
        assert.match(elements.get('modHubHelpStatus').textContent, /请检查|仍异常/);
        outcome = false;
        await elements.get('modHubHelpContainer').onclick({ target: imageButton });
        assert.equal(count, 2);
        assert.equal(elements.get('modHubHelpStatus').className, 'red');
        assert.match(elements.get('modHubHelpStatus').textContent, /未能完整刷新/);
        sb.modHubRefreshBeautyImages = () => { throw new Error('已连接画布重绘失败'); };
        await elements.get('modHubHelpContainer').onclick({ target: imageButton });
        assert.match(elements.get('modHubHelpStatus').textContent, /已连接画布重绘失败/);
        assert.equal(state.reads.length, 0, '图像刷新不得触发配置检查或持久化');
        assert.equal(sb._modHubReloadRevision, 0);
    }

    const enableFixture = options => loadRepairHelp({ installed: {
        Required: boot('Required', { alias: ['Actual API'] }),
        Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: '*' }] }),
    }, enabled: ['Consumer'], disabled: ['Required'], ...options });
    const repairIssue = (snapshot, type = 'enable') => {
        const issue = snapshot.issues.find(item => item.repair?.type === type);
        assert.ok(issue, `应提供${type}修复预览：${JSON.stringify(snapshot.issues)}`);
        return issue;
    };
    const writes = fixture => fixture.events.filter(item => /overwrite|本地配置|保存美化/.test(item));
    const assertNoSuccess = fixture => {
        assert.ok(!fixture.state.toasts.some(item => item.type === 'success'));
        assert.equal(fixture.state.reloadMessages?.length || 0, 0);
        assert.equal(Boolean(fixture.sb._modHubManagerBusy), false);
    };

    // 预览复用真实排序器，启用唯一 alias 提供者并排到消费者之前，预览本身零写入。
    {
        const f = enableFixture();
        for (const method of ['buildRepairPlan', 'repair']) assert.equal(typeof f.help[method], 'function');
        const snapshot = await f.help.check();
        const issue = repairIssue(snapshot);
        assert.equal(issue.repair.enableName, 'Required');
        const plan = await f.help.buildRepairPlan(snapshot, issue.id);
        assert.deepEqual(plain(plan.before), { enabled: ['Consumer'], disabled: ['Required'] });
        assert.deepEqual(Array.from(plan.enabled), ['Required', 'Consumer']);
        assert.deepEqual(Array.from(plan.disabled), []);
        assert.equal(plan.packages.length, 2);
        assert.deepEqual(writes(f), []);
        assert.equal(f.state.restoreContexts.length, 0);
        assert.equal(f.state.confirmations?.length || 0, 0);
    }

    // 同名内置与旁加载档案不能使顺序修复丢失唯一 alias 提供者。
    {
        const installed = {
            Required: boot('Required', { alias: ['Actual API'] }),
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: '*' }] }),
        };
        const f = loadRepairHelp({ installed, enabled: ['Consumer', 'Required'], runtime: [
            { name: 'Required', bootJson: installed.Required, source: 'Local' },
            { name: 'Consumer', bootJson: installed.Consumer, source: 'IndexDB' },
        ] });
        const snapshot = await f.help.check();
        const plan = await f.help.buildRepairPlan(snapshot, repairIssue(snapshot, 'order').id);
        assert.deepEqual(plain(plan.enabled), ['Required', 'Consumer']);
        assert.deepEqual(writes(f), [], '同名去重与修复预览不能写配置');
    }

    // 等待用户确认时不得建立还原点或写配置；取消后保持两份列表及包体不变。
    {
        let answer;
        let opened;
        const gate = new Promise(resolve => { answer = resolve; });
        const shown = new Promise(resolve => { opened = resolve; });
        const f = enableFixture({ confirm: async () => { opened(); return gate; } });
        const snapshot = await f.help.check();
        const pending = f.help.repair(snapshot, repairIssue(snapshot).id);
        await shown;
        assert.deepEqual(writes(f), []);
        assert.equal(f.state.restoreContexts.length, 0);
        assert.deepEqual(f.controller.store.enabled, ['Consumer']);
        assert.deepEqual(f.controller.store.disabled, ['Required']);
        answer(false);
        const result = await pending;
        assert.equal(result.status, 'cancelled');
        assert.equal(result.ok, false);
        assert.deepEqual(writes(f), []);
        assertNoSuccess(f);
    }

    // 确认保存经管理器锁、强制手动还原点和真实回读，旧运行日志继续保留。
    {
        const f = enableFixture({ logs: [{ type: 'error', str: 'OldError: 重新载入前的原始异常' }] });
        const snapshot = await f.help.check();
        const result = await f.help.repair(snapshot, repairIssue(snapshot).id);
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.status, 'saved');
        assert.deepEqual(f.controller.store.enabled, ['Required', 'Consumer']);
        assert.deepEqual(f.controller.store.disabled, []);
        assert.equal(f.state.restoreContexts.length, 1);
        assert.equal(f.state.restoreContexts[0].kind, 'manual', '帮助修复的操作前还原点不可按自动建点设置跳过');
        assert.ok(f.events.indexOf('建立还原点') < f.events.indexOf('overwriteModIndexDBModList'));
        assert.ok(f.events.indexOf('overwriteModIndexDBHiddenModList') < f.events.indexOf('整理还原点'));
        assert.ok(f.events.indexOf('释放还原锁') < f.events.indexOf('提示重载'));
        assert.equal(f.state.reloadMessages.length, 1);
        assert.equal(result.snapshot.analysis.errorCount, 1);
        assert.equal(result.snapshot.different, true);
        assert.ok(result.snapshot.issues.some(item => item.id === 'log-unknown'));
        assert.match(result.reason, /等待|重载|重新载入/);
        assert.match(result.reason, /不代表|未验证|不会.*清除/);
        assert.match(result.reason, /不代表问题已解决/);
        assert.equal(f.sb._modHubManagerBusy, false);
    }

    // 用户确认期间列表或同名包发生变化，旧预览必须作废，不能覆盖他人的配置。
    {
        for (const change of [
            f => { f.controller.store.disabled.push('Later'); },
            f => { f.state.installed.Required.version = '2.0.0'; },
        ]) {
            const f = enableFixture({ confirm: async (prompt, fixture) => { change(fixture); return true; } });
            const snapshot = await f.help.check();
            const result = await f.help.repair(snapshot, repairIssue(snapshot).id);
            assert.equal(result.status, 'stale');
            assert.equal(result.ok, false);
            assert.deepEqual(writes(f), []);
            assert.equal(f.state.restoreContexts.length, 0);
            assertNoSuccess(f);
        }
        const f = enableFixture();
        const snapshot = await f.help.check();
        const issue = repairIssue(snapshot);
        snapshot.stale = true;
        assert.equal((await f.help.repair(snapshot, issue.id)).ok, false);
        assert.deepEqual(writes(f), []);
        assertNoSuccess(f);
    }

    // 无法重读配置时保留具体失败原因，不能进入确认或写入。
    {
        const f = enableFixture();
        const snapshot = await f.help.check();
        f.controller.listModIndexDB = async () => { throw new Error('真实列表读取被拒绝'); };
        const result = await f.help.repair(snapshot, repairIssue(snapshot).id);
        assert.equal(result.ok, false);
        assert.match(result.reason + ' ' + (result.snapshot?.issues || []).map(issueText).join(' '), /真实列表读取被拒绝/);
        assert.equal(f.state.confirmations?.length || 0, 0);
        assert.deepEqual(writes(f), []);
        assertNoSuccess(f);
    }

    // 重新检查本身过期，或建点后、实际写入前配置变化，都必须中止而非覆盖新状态。
    {
        let armed = false;
        const f = enableFixture({ onRead: async name => {
            if (!armed || name !== 'Consumer') return;
            armed = false;
            f.controller.store.disabled.push('Later');
        } });
        const snapshot = await f.help.check();
        armed = true;
        assert.equal((await f.help.repair(snapshot, repairIssue(snapshot).id)).status, 'stale');
        assert.equal(f.state.confirmations?.length || 0, 0);
        assert.deepEqual(writes(f), []);
        const guarded = enableFixture();
        const initial = await guarded.help.check();
        const prepare = guarded.sb.modHubRestore.prepare;
        guarded.sb.modHubRestore.prepare = async context => {
            await prepare(context);
            guarded.state.installed.Required.version = '2.0.0';
            return true;
        };
        const result = await guarded.help.repair(initial, repairIssue(initial).id);
        assert.equal(result.status, 'failed');
        assert.match(result.reason, /包体声明已改变|安装包.*变化/);
        assert.deepEqual(writes(guarded), []);
        assertNoSuccess(guarded);
    }

    // 版本未知或不符、提供者不唯一、资料不完整都只引导核对，不提供自动启用。
    {
        for (const range of ['>=9.0.0', '~1.0.0']) {
            const f = enableFixture({ installed: {
                Required: boot('Required', { alias: ['Actual API'] }),
                Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: range }] }),
            } });
            const snapshot = await f.help.check();
            const issue = snapshot.issues.find(item => /未启用/.test(item.title));
            assert.equal(issue.repair, undefined, range);
            await assert.rejects(() => f.help.buildRepairPlan(snapshot, issue.id));
            assert.equal((await f.help.repair(snapshot, issue.id)).ok, false);
            assert.deepEqual(writes(f), []);
            assert.equal(f.state.confirmations?.length || 0, 0);
            const order = loadRepairHelp({ installed: {
                Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: range }] }), Required: boot('Required'),
            }, enabled: ['Consumer', 'Required'] });
            const orderSnapshot = await order.help.check();
            const orderIssue = orderSnapshot.issues.find(item => /加载顺序/.test(item.title));
            assert.equal(orderIssue.repair, undefined, '目标前置版本未满足时不能用排序掩盖问题');
            await assert.rejects(() => order.help.buildRepairPlan(orderSnapshot, orderIssue.id));
        }
        for (const extra of [
            { Extra: boot('Extra', { alias: ['Actual API'] }) },
            { Broken: new Error('额外包体读取失败') },
        ]) {
            const f = enableFixture({ installed: {
                Required: boot('Required', { alias: ['Actual API'] }),
                Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: '*' }] }), ...extra,
            }, disabled: ['Required', ...Object.keys(extra)] });
            const snapshot = await f.help.check();
            const issue = snapshot.issues.find(item => /未启用/.test(item.title));
            assert.equal(issue.repair, undefined);
            await assert.rejects(() => f.help.buildRepairPlan(snapshot, issue.id));
            assert.deepEqual(writes(f), []);
        }
    }

    // 新启用的包会增加重复提供者警告时拒绝方案；循环依赖不能冒充排序修复。
    {
        const f = enableFixture({ installed: {
            Other: boot('Other', { alias: ['Shared API'] }),
            Required: boot('Required', { alias: ['Actual API', 'Shared API'] }),
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Actual API', version: '*' }] }),
        }, enabled: ['Other', 'Consumer'] });
        const snapshot = await f.help.check();
        await assert.rejects(() => f.help.buildRepairPlan(snapshot, repairIssue(snapshot).id), /提供者|重复|需要处理/);
        assert.deepEqual(writes(f), []);
        const cyclic = loadRepairHelp({ installed: {
            A: boot('A', { dependenceInfo: [{ modName: 'B', version: '*' }] }),
            B: boot('B', { dependenceInfo: [{ modName: 'A', version: '*' }] }),
        }, enabled: ['A', 'B'] });
        const cycleSnapshot = await cyclic.help.check();
        await assert.rejects(() => cyclic.help.buildRepairPlan(cycleSnapshot, repairIssue(cycleSnapshot, 'order').id), /循环|顺序|需要处理/);
        assert.deepEqual(writes(cyclic), []);
    }

    // 纯加载顺序修复不读写美化，不改变美化覆盖优先级。
    {
        const f = loadRepairHelp({ installed: {
            Consumer: boot('Consumer', { dependenceInfo: [{ modName: 'Required', version: '*' }] }), Required: boot('Required'),
        }, enabled: ['Consumer', 'Required'] });
        f.sb._modHubBeautyState = { enabledList: ['First', 'Second'], disabledList: ['Third'] };
        const beforeBeauty = plain(f.sb._modHubBeautyState);
        const snapshot = await f.help.check();
        const result = await f.help.repair(snapshot, repairIssue(snapshot, 'order').id);
        assert.equal(result.ok, true, result.reason);
        assert.deepEqual(f.controller.store.enabled, ['Required', 'Consumer']);
        assert.deepEqual(plain(f.sb._modHubBeautyState), beforeBeauty);
        assert.ok(!f.events.includes('读取美化'));
        assert.ok(!f.events.includes('保存美化'));
    }

    // 还原点建立失败、列表回读不符或还原点整理失败时，不显示保存成功或重载成功提示。
    {
        for (const failure of ['prepare', 'readback', 'finish']) {
            const f = enableFixture({ prepareFailure: failure === 'prepare', finishFailure: failure === 'finish' });
            if (failure === 'readback') {
                const save = f.controller.overwriteModIndexDBModList;
                f.controller.overwriteModIndexDBModList = async names => {
                    await save(names);
                    f.controller.store.enabled.reverse();
                    return true;
                };
            }
            const snapshot = await f.help.check();
            const result = await f.help.repair(snapshot, repairIssue(snapshot).id);
            assert.equal(result.ok, false, failure);
            assert.equal(result.status, 'failed', failure);
            assertNoSuccess(f);
            assert.equal(f.state.restoreContexts[0]?.kind, 'manual');
            if (failure === 'prepare') assert.deepEqual(writes(f), []);
            else assert.ok(writes(f).length > 0);
        }
    }

    // 配置已保存且回读通过后，重载提示本身失败不能把实际保存误报为失败。
    {
        const f = enableFixture();
        f.sb.modHubOfferReload = async () => {
            assert.equal(f.sb._modHubManagerBusy, false);
            assert.ok(f.events.includes('释放还原锁'));
            throw new Error('重载提示无法打开');
        };
        const snapshot = await f.help.check();
        const result = await f.help.repair(snapshot, repairIssue(snapshot).id);
        assert.equal(result.ok, true);
        assert.equal(result.status, 'saved');
        assert.deepEqual(f.controller.store.enabled, ['Required', 'Consumer']);
        assert.match(result.reason, /重载提示无法打开/);
        assert.match(result.reason, /手动重新载入/);
    }
};
