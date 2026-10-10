// 实际客户端目录、卡片与批量选择的语言变体回归；不下载包体或写入游戏。
const { assert, fs, path, srcRoot, readStyles, createStubElement, loadMarket, loadScripts } = require('./helpers');

const repository = 'https://github.com/LanguageCardsFixture/SharedProducts';
const offlineCatalogUrls = [
    'https://dol.alseece.top/release-index.json',
    'https://dolmod-release-index.johnliao381658675.workers.dev/release-index.json',
    'https://dolmod-catalog-pages.pages.dev/mod-identities.json'
];
const copy = value => JSON.parse(JSON.stringify(value));
const language = (id, label) => ({ groupId: 'language-cards-fixture', groupName: '语言测试模组', type: 'language', id, label });
const definitions = [
    { id: 'language-cards-chs', name: '语言测试模组（简中）', bootName: 'LanguageCardsChinese', tag: 'zh-channel', version: '1.1.0',
        variant: language('zh-CN', '简体中文'), requiredDependencies: [{ modName: 'ModI18N', version: '*' }] },
    { id: 'language-cards-en', name: '语言测试模组（英文）', bootName: 'LanguageCardsEnglish', tag: 'en-channel', version: '2.0.0',
        variant: language('en', 'English') }
];

function indexFor({ legacy = false, unrelated = false } = {}) {
    const items = definitions.concat(unrelated ? [{ id: 'language-cards-unrelated', name: '同仓库独立模组',
        bootName: 'LanguageCardsUnrelated', tag: 'other-channel', version: '3.0.0' }] : []);
    const identities = items.map(item => ({ id: item.id, name: item.name, bootNames: [item.bootName], aliases: [],
        repositories: [], repositoryKeys: [], category: '界面与便利', tags: [],
        ...(!legacy && item.variant ? { variant: copy(item.variant) } : {}),
        ...(!legacy && item.requiredDependencies ? { requiredDependencies: copy(item.requiredDependencies) } : {}) }));
    return { schemaVersion: 1, communityRevision: 71, identities: legacy ? [] : identities,
        mods: items.map(item => ({ id: item.id, identityId: item.id, name: item.name, bootNames: [item.bootName],
            aliases: [], repositories: [], repositoryKeys: [], category: '界面与便利', tags: [], sharedRepository: true,
            githubUrl: `${repository}/releases/tag/${item.tag}`, sourceUrl: `${repository}/releases/tag/${item.tag}`,
            releaseUrl: `${repository}/releases/tag/${item.tag}`, version: item.version, versionSource: 'github',
            description: `${item.name}的独立说明`, author: '测试作者', updateDate: '2026-10-08' })) };
}

async function fixture({ installed = [], providers = [], disabled = [], legacy = false, cache = false, unrelated = false, indexOverride = null } = {}) {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    sb.StartConfig = { version: '0.5.12.13' };
    const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
    const elements = new Map(['modHubMarketCardsContainer', 'modHubMarketStats', 'modHubMarketBatchToolbar',
        'modHubStatusSelect'].map(id => [id, createStubElement()]));
    sb.document.getElementById = id => elements.get(id) || null;
    const locals = installed.map(({ id, version }) => {
        const item = definitions.find(definition => definition.id === id);
        return { name: item.bootName, bootJson: { name: item.bootName, version } };
    }).concat(providers);
    sb._modHubModState = { sideEnabled: locals.filter(item => !disabled.includes(item.name)).map(item => item.name), sideDisabled: disabled };
    sb.modHubGetGui = () => ({ gModUtils: { getModList: () => locals, getModListNameNoAlias: () => locals.map(item => item.name) } });
    sb.modHubGetModInfo = name => locals.find(item => item.name === name) || null;
    const index = indexOverride || indexFor({ legacy, unrelated });
    let requests = 0;
    const requestUrls = [];
    sb.fetch = async url => {
        requests++;
        requestUrls.push(String(url));
        if (String(url).endsWith('/mod-identities.json')) {
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: copy(legacy ? index.mods : index.identities) }) };
        }
        assert.ok(String(url).includes('release-index.json'), '卡片测试仅模拟统一索引，不读取真实包体');
        if (cache) throw new Error('模拟在线版本索引不可用');
        return { ok: true, headers: { get: () => null }, json: async () => copy(index) };
    };
    versions.fetchReleases = async mod => {
        const item = index.mods.find(entry => entry.id === mod.id);
        const assetName = `${item.bootNames[0]}-v${item.version}.zip`;
        const tagName = (item.releaseUrl || item.githubUrl).split('/').at(-1);
        return { schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl, page: 1, hasMore: false,
            fetchedAt: '2026-10-08T00:00:00Z', releases: [{ tagName, name: item.version,
                publishedAt: '2026-10-08T00:00:00Z', assets: [{ name: assetName, size: 100,
                    downloadUrl: `${repository}/releases/download/${tagName}/${assetName}` }] }] };
    };
    if (cache) sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: copy(index.mods) }));
    const mods = await market.loadMarketData();
    await Promise.all(mods.map(mod => market.getModUpdateInfo(mod).promise));
    market.renderMarketCards();
    const cards = elements.get('modHubMarketCardsContainer');
    const row = id => {
        const mod = mods.find(item => item.id === id);
        const start = cards.innerHTML.indexOf(`<div class="modhub-market-variant-row" data-mod-name="${mod.name}" data-mod-index="${mods.indexOf(mod)}"`);
        assert.ok(start >= 0, `必须显示语言成员 ${id}`);
        const end = cards.innerHTML.indexOf('<div class="modhub-market-variant-row"', start + 1);
        return cards.innerHTML.slice(start, end < 0 ? undefined : end);
    };
    return { sb, market, mods, index, cards, row, locals, requestUrls, requests: () => requests };
}

function bindLanguageCard(f) {
    const card = createStubElement(), controls = [];
    card.dataset.variantGroup = 'language-cards-fixture';
    for (const match of f.cards.innerHTML.matchAll(/<(button|div)\b([^>]*class="[^"]*"[^>]*)>/g)) {
        const attributes = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), item => [item[1], item[2]]));
        if (!/(?:btn-market-language-choice|btn-market-install|btn-market-update|modhub-market-variant-row)/.test(attributes.class)) continue;
        const element = createStubElement(match[1]);
        element.className = attributes.class;
        element.hidden = /\shidden(?:\s|$)/.test(match[2]);
        element.disabled = /\sdisabled(?:\s|$)/.test(match[2]);
        element.dataset = Object.fromEntries(Object.entries(attributes).filter(([name]) => name.startsWith('data-'))
            .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
        element.getAttribute = name => attributes[name] ?? null;
        element.setAttribute = (name, value) => { attributes[name] = String(value); };
        element.closest = selector => selector === '.modhub-market-language-card' ? card : null;
        controls.push(element);
    }
    const select = selector => controls.filter(element => selector.split(',').some(part => {
        const className = part.trim().slice(1);
        return part.trim().startsWith('.') && element.className.split(/\s+/).includes(className);
    }));
    card.querySelectorAll = select;
    f.cards.querySelectorAll = select;
    f.market.renderMarketCards();
    return { choices: select('.btn-market-language-choice'), rows: select('.modhub-market-variant-row'),
        versions: select('.btn-market-install, .btn-market-update') };
}

module.exports = async function () {
    {
        const provider = (name, version = '2.0.0', alias = []) => ({ name, bootJson: { name, version, alias } });
        const nativeApi = {
            parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
            parseRange: range => [{ range }],
            satisfies: (version, ranges) => version.version[0] >= Number(ranges[0].range.slice(2).split('.')[0])
        };
        const cases = [
            { name: '未安装', providers: [], color: 'red', status: '未安装' },
            { name: '真实技术名', providers: [provider('ModI18N')], color: 'green', status: '已安装' },
            { name: '真实原生别名', providers: [provider('TranslationProvider', '2.0.0', [' modi18n '])], color: 'green', status: '已安装' },
            { name: '展示别名不能证明身份', providers: [{ ...provider('OtherMod'), displayNames: ['ModI18N'] }], color: 'red', status: '未安装' },
            { name: '包体声明未读取', providers: [{ name: 'ModI18N' }], color: 'gold', status: '需要核对' },
            { name: '其他未知包体也不能推断缺失', providers: [{ name: 'UnreadPackage' }], color: 'gold', status: '需要核对' },
            { name: '已禁用', providers: [provider('ModI18N')], disabled: ['ModI18N'], color: 'red', status: '已禁用' },
            { name: '提供者不唯一', providers: [provider('ModI18N'), provider('OtherTranslation', '2.0.0', ['ModI18N'])], color: 'gold', status: '需要核对' },
            { name: '版本满足要求', providers: [provider('ModI18N')], range: '>=1.0', nativeApi, color: 'green', status: '已安装' },
            { name: '版本不符', providers: [provider('ModI18N', '1.0.0')], range: '>=2.0', nativeApi, color: 'red', status: '版本不符' },
            { name: '无法识别版本', providers: [provider('ModI18N', '未知')], range: '>=1.0', nativeApi, color: 'gold', status: '需要核对' },
            { name: '无法识别范围', providers: [provider('ModI18N')], range: '>=1.0 junk', nativeApi, color: 'gold', status: '需要核对' },
            { name: '原生核对接口不可用', providers: [provider('ModI18N')], range: '>=1.0', color: 'gold', status: '需要核对' }
        ];
        for (const item of cases) {
            const f = await fixture(item);
            f.mods[0].requiredDependencies = [{ modName: 'ModI18N', version: item.range || '*' }];
            if (item.nativeApi) f.sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => item.nativeApi }) };
            f.market.renderMarketCards();
            const chinese = f.row(definitions[0].id);
            assert.ok(chinese.includes(`class="modhub-market-meta modhub-market-variant-requirements ${item.color}"`), `${item.name}必须使用对应原生状态颜色`);
            assert.ok(chinese.includes(`ModI18N（${item.status}）`), `${item.name}必须同时显示文字状态`);
            assert.match(chinese, /modhub-market-variant-requirements[^>]*title="[^"]+"/, `${item.name}保留具体核对依据`);
            assert.ok(!f.row(definitions[1].id).includes('modhub-market-variant-requirements'), '英文未声明前置时不显示额外前置行');
        }
        const f = await fixture({ providers: [provider('ModI18N')] });
        f.mods[0].requiredDependencies.push({ modName: 'MissingProvider', version: '*' });
        f.market.renderMarketCards();
        let chinese = f.row(definitions[0].id);
        assert.match(chinese, /modhub-market-variant-requirements green[^>]*>该语言额外前置：ModI18N（已安装）<\/div>/, '多个前置各自显示已安装状态');
        assert.match(chinese, /modhub-market-variant-requirements red[^>]*>该语言额外前置：MissingProvider（未安装）<\/div>/, '多个前置不能共用整行颜色');
        f.sb._modHubModState.sideDisabled.push('ModI18N');
        f.market.renderMarketCards();
        chinese = f.row(definitions[0].id);
        assert.match(chinese, /modhub-market-variant-requirements red[^>]*>该语言额外前置：ModI18N（已禁用）<\/div>/, '重绘必须读取最新启禁状态');
        f.locals.push(provider('MissingProvider'));
        f.sb._modHubModState.sideEnabled.push('MissingProvider');
        f.market.renderMarketCards();
        assert.match(f.row(definitions[0].id), /modhub-market-variant-requirements green[^>]*>该语言额外前置：MissingProvider（已安装）<\/div>/, '重绘必须读取新安装的真实包体声明');
    }
    {
        const f = await fixture({ unrelated: true });
        f.sb.modHubMarketSpells = { renderAcquisitionDetails: mod => `<div class="modhub-market-source-bar"><span>来源：</span><a class="modhub-market-source-link" href="${mod.githubUrl}">GitHub</a></div>` };
        f.mods[0].description = '<script>说明仅作为文本</script>';
        f.market.renderMarketCards();
        const chinese = f.row(definitions[0].id);
        assert.ok(chinese.includes('简体中文') && chinese.includes('未安装'), '当前语言面板保留语言和独立安装状态');
        assert.ok(chinese.includes('已安装版本：未安装') && chinese.includes('最新版本：v1.1.0'), '当前语言面板同时显示已安装和最新版本');
        assert.ok(!chinese.includes('<details') && !chinese.includes('<summary'), '语言说明常显，不再额外折叠');
        assert.ok(chinese.includes('&lt;script&gt;说明仅作为文本&lt;/script&gt;') && !chinese.includes('<script>'), '语言说明继续转义外部内容');
        assert.ok(chinese.includes('modhub-market-source-link') && chinese.includes(f.mods[0].githubUrl), '当前语言面板保留真实来源入口');
        assert.ok(chinese.includes('data-mod-index="0"') && chinese.includes('modhub-download-cancel'), '语言面板保留原下载状态和取消入口属性');
        assert.match(f.cards.innerHTML, /class="modhub-market-language-switch"[^>]*role="group"/, '语言选择使用明确的按钮组');
        assert.equal((f.cards.innerHTML.match(/btn-market-language-choice/g) || []).length, 2, '每种语言提供一个直接切换按钮');
        assert.ok(chinese.includes('选择简体中文版本'), '选版操作明确标示将安装的语言');
        assert.ok(f.cards.innerHTML.includes('modhub-market-card-footer'), '普通卡片的来源与操作使用紧凑独立底栏');
        const css = readStyles();
        const grid = css.match(/\.modhub-market-grid\s*\{([^}]+)\}/)?.[1] || '';
        const card = css.match(/\.modhub-market-card\s*\{([^}]+)\}/)?.[1] || '';
        const description = css.match(/\.modhub-market-desc\s*\{([^}]+)\}/)?.[1] || '';
        const footer = css.match(/\.modhub-market-card-footer\s*\{([^}]+)\}/)?.[1] || '';
        assert.match(grid, /align-items:\s*stretch/, '宽屏网格恢复同行等高卡片');
        assert.match(card, /align-self:\s*stretch/, '卡片不得覆盖网格的同行等高布局');
        assert.match(card, /min-height:\s*0/, '普通卡片不得保留人为最小高度');
        assert.match(description, /flex:\s*0\s+1\s+auto/, '简介不得自动填充卡片空白');
        assert.match(footer, /margin-top:\s*auto/, '普通卡片的来源与操作固定在底部');
        assert.match(css, /\.modhub-market-variant-row\[hidden\]\s*\{[^}]*display:\s*none/, '隐藏的语言面板不占布局空间');
        const languageButtonCss = css.match(/\.modhub-market-language-switch\s*>\s*\.modhub-market-language-choice\s*\{([^}]+)\}/)?.[1] || '';
        assert.ok(Number(languageButtonCss.match(/min-height:\s*(\d+)px/)?.[1]) >= 32, '语言切换保留手机触控面积');
        assert.match(css, /\.modhub-market-actions button,\s*\.modhub-market-actions \.buttonlike\s*\{[^}]*min-height:\s*32px/, '安装操作保留最小触控高度');
    }
    {
        const f = await fixture();
        f.sb.modHubRestore = null;
        const installed = [];
        f.sb.modHubMarketInstaller = { install: async (mod, options) => {
            installed.push(mod);
            assert.ok(options.restoreContext, '语言成员沿用市场统一恢复上下文');
            return false;
        } };
        let controls = bindLanguageCard(f);
        assert.deepEqual(controls.choices.map(button => button.getAttribute('aria-pressed')), ['true', 'false'], '首次只预览第一语言');
        assert.deepEqual(controls.rows.map(row => row.hidden), [false, true], '同一时刻只显示一个语言面板');
        assert.deepEqual(installed, [], '初始预览不会自动安装');
        for (const index of [1, 0]) {
            assert.equal(typeof controls.choices[index].onclick, 'function', '语言按钮绑定真实切换处理器');
            await controls.choices[index].onclick();
            assert.deepEqual(controls.choices.map(button => button.getAttribute('aria-pressed')), [index === 0 ? 'true' : 'false', index === 1 ? 'true' : 'false']);
            assert.deepEqual(controls.rows.map(row => row.hidden), [index !== 0, index !== 1]);
            assert.equal(installed.length, index === 1 ? 0 : 1, '切换语言只更新预览，不开始下载或安装');
            const versionButton = controls.versions.find(button => Number(button.dataset.modIndex) === index);
            assert.equal(typeof versionButton.onclick, 'function', '当前语言选版按钮绑定共用安装处理器');
            await versionButton.onclick();
            assert.equal(installed.at(-1), f.mods[index], '明确点击选版后只交给安装器对应真实语言成员');
        }
        await controls.choices[1].onclick();
        f.market.renderMarketCards();
        controls = bindLanguageCard(f);
        assert.deepEqual(controls.choices.map(button => button.getAttribute('aria-pressed')), ['false', 'true'], '市场重绘保留玩家已选择的语言');
        assert.deepEqual(controls.rows.map(row => row.hidden), [true, false]);
        let release;
        const busy = f.market.runInstallTask(() => new Promise(resolve => { release = resolve; }));
        try {
            await controls.choices[0].onclick();
            assert.equal(controls.rows[0].hidden, true, '单次安装期间不能切换语言');
            assert.equal(controls.choices[1].getAttribute('aria-pressed'), 'true');
        } finally { release(false); await busy; }
        f.market.batchInstallState.running = true;
        try {
            await controls.choices[0].onclick();
            assert.equal(controls.rows[0].hidden, true, '批量安装期间不能切换语言');
            assert.equal(controls.choices[1].getAttribute('aria-pressed'), 'true');
        } finally { f.market.batchInstallState.running = false; }
        assert.deepEqual(installed.map(mod => mod.id), [definitions[1].id, definitions[0].id]);
        assert.equal(f.requests(), 1, '预览、切换、重绘和路由测试不读取真实包体');
    }
    {
        const f = await fixture();
        assert.equal(f.mods.length, 2, '市场原目录保持两个独立安装身份，旧客户端仍能读取');
        assert.deepEqual(Array.from(f.mods, mod => mod.id), definitions.map(item => item.id));
        assert.equal(new Set(f.mods.map(mod => mod.name)).size, 2,
            '成员内部名称保持语言区别，忽略更新和下载状态不能共享同一个名称键');
        assert.equal(f.index.schemaVersion, 1);
        assert.deepEqual(copy(f.mods[0].variant), definitions[0].variant, 'index.identities 精确身份补全语言字段');
        assert.deepEqual(copy(f.mods[0].requiredDependencies), definitions[0].requiredDependencies,
            'index.identities 精确身份补全作者说明中的额外前置');
        assert.deepEqual(copy(f.mods[1].requiredDependencies || []), [], '英文不继承简中额外前置');
        const [group] = f.market.getDisplayMods();
        assert.equal(group.isLanguageGroup, true);
        assert.equal(group.variants[0], f.mods[0]);
        assert.equal(group.variants[1], f.mods[1]);
        assert.equal((f.cards.innerHTML.match(/class="childItem modhub-market-card/g) || []).length, 1, '两语言只渲染一张市场卡片');
        assert.equal((f.cards.innerHTML.match(/class="modhub-market-variant-row"/g) || []).length, 2);
        assert.ok(f.row(definitions[0].id).includes('ModI18N'));
        assert.ok(!f.row(definitions[1].id).includes('ModI18N'), '英文行不能显示简中额外前置');
        assert.ok(f.row(definitions[0].id).includes('选择简体中文版本'));
        assert.ok(f.row(definitions[1].id).includes('选择English版本'));
        assert.ok(f.row(definitions[0].id).includes('最新版本：v1.1.0'));
        assert.ok(f.row(definitions[1].id).includes('最新版本：v2.0.0'), '语言不同步发布时各行显示各自最新版');
        f.market.toggleBatchSelection(true);
        assert.equal(f.market.getBatchSelectionState().selected.length, 0, '进入多选不能默认勾选任何语言');
        f.market.selectAllVisibleMods();
        assert.deepEqual(Array.from(f.market.getBatchSelectionState().selected), ['language-group:language-cards-fixture'],
            '全选仅选择一个展示组，不能自动加入两个语言安装任务');
        f.market.clearBatchSelection();
        f.market.setBatchModSelected(f.market.getMarketModKey(f.mods[0]), true);
        assert.equal(f.market.getBatchSelectionState().selected.length, 0, '成员旧 ID 不能绕过展示组的语言选择');
        f.market.setBatchModSelected(f.market.getMarketModKey(group), true);
        f.sb.modHubRestore = null;
        const received = [];
        f.sb.modHubMarketInstaller = { installBatch: async targets => { received.push(...targets); return false; } };
        assert.equal(await f.market.installSelectedMods(), false);
        assert.equal(received.length, 1, '批量入口交给安装器一个待选语言的展示组');
        assert.equal(received[0].isLanguageGroup, true);
        assert.equal(received[0].variants[0], f.mods[0]);
        assert.equal(received[0].variants[1], f.mods[1]);
        delete f.sb.modHubMarketInstaller;
        const alerts = [];
        f.sb.modHubAlert = async message => alerts.push(message);
        assert.equal(await f.market.installSelectedMods(), false);
        assert.ok(alerts.some(message => message.includes('语言与版本选择模块尚未就绪')),
            '旧安装器缺少语言选择时必须停下，不能回退自动安装两包');
        assert.equal(f.requests(), 1, '选择、取消及缺少安装器都不能下载真实包体');

        const unknown = f.market.normalizeReleaseIndex({ schemaVersion: 1, identities: copy(f.index.identities),
            mods: [{ ...copy(f.index.mods[0]), id: 'unknown-member', identityId: 'unknown-member' }] })[0];
        assert.equal(unknown.variant, null, '未知身份不能按同仓库或相似展示名补全语言声明');
        assert.deepEqual(copy(unknown.requiredDependencies || []), []);
    }
    {
        const index = indexFor();
        index.mods.forEach(mod => Object.assign(mod, { githubUrl: repository, sourceUrl: repository,
            wikiVersion: '0.7.0', releaseAssetVersion: mod.version }));
        const f = await fixture({ indexOverride: index });
        assert.deepEqual(Array.from(f.mods, mod => mod.version), definitions.map(item => item.version),
            '显式同仓库语言条目没有固定发布标签时，不能把独立官方版本回退为 Wiki 旧版');
        assert.deepEqual(Array.from(f.mods, mod => mod.releaseAssetVersion), definitions.map(item => item.version));
        assert.deepEqual(Array.from(f.mods, mod => mod.releaseUrl), index.mods.map(mod => mod.releaseUrl),
            '显式语言隔离保留每个成员自己的发布证据');
        assert.ok(f.mods.every(mod => mod.versionSource === 'github' && mod.sharedRepository));
        assert.equal(f.market.getDisplayMods().length, 1);
        assert.ok(f.row(definitions[0].id).includes('最新版本：v1.1.0'));
        assert.ok(f.row(definitions[1].id).includes('最新版本：v2.0.0'));
    }
    {
        const index = indexFor();
        index.mods.forEach((mod, position) => { mod.variant = copy(definitions[1 - position].variant); });
        const f = await fixture({ indexOverride: index });
        assert.deepEqual(Array.from(f.mods, mod => copy(mod.variant)), definitions.map(item => item.variant),
            '条目字段与精确身份声明冲突时，以已登记身份确定真实语言，不能交换两个安装包标签');
        assert.ok(f.row(definitions[0].id).includes('选择简体中文版本'));
        assert.ok(f.row(definitions[1].id).includes('选择English版本'));
        loadScripts(f.sb, ['javascript/modhub-market-install.js']);
        const [group] = f.market.getDisplayMods();
        const english = f.mods.find(mod => mod.id === definitions[1].id);
        f.sb.modHubConfirm = async options => {
            const choice = options.selectOptions.find(item => item.value === f.market.getMarketModKey(english));
            assert.ok(choice.label.startsWith('English'), 'English 选项必须关联英文独立身份');
            return choice.value;
        };
        const selected = await f.sb.modHubMarketInstaller.selectLanguage(group);
        assert.equal(selected.id, definitions[1].id);
        assert.deepEqual(Array.from(selected.bootNames), [definitions[1].bootName],
            '字段冲突后明确选择 English 仍必须得到英文技术名，不能得到简中包');
        assert.equal(f.requests(), 1, '语言选择回归不得读取或安装真实包体');
    }
    for (const removal of ['withdrawn', 'removed']) {
        const index = indexFor();
        if (removal === 'withdrawn') index.mods[0].status = 'withdrawn';
        else index.mods = index.mods.filter(mod => mod.id !== definitions[0].id);
        const f = await fixture({ indexOverride: index, installed: [{ id: definitions[0].id, version: '1.1.0' }] });
        assert.deepEqual(Array.from(f.market.getMarketMods(), mod => mod.id), [definitions[1].id],
            '撤回或删除的简中成员不能回到可安装目录');
        assert.equal(f.market.getDisplayMods().length, 1);
        assert.equal(f.market.getDisplayMods()[0].isLanguageGroup, false, '只有在架英文时不保留虚假可选语言组');
        assert.equal(f.market.findMarketModByLocalName(definitions[0].bootName), null,
            '已移除语言的本地安装不能重新关联到英文安装入口');
        const members = f.market.getLanguageIdentityMembers(f.mods[0]);
        assert.equal(members.length, 2, '身份目录仍须保留旧语言关系供共存提示识别');
        const former = members.find(mod => mod.id === definitions[0].id);
        assert.ok(former);
        assert.deepEqual(Array.from(former.bootNames), [definitions[0].bootName]);
        assert.deepEqual(copy(former.variant), definitions[0].variant);
        assert.equal(former.autoInstall, false, '旧身份仅供安装事实识别，不赋予自动安装资格');
        assert.equal(former.githubUrl, null);
        assert.equal(f.market.isBatchInstallEligible(former), false);
        assert.equal(f.market.getLocalInstalledProfiles()[0].name, definitions[0].bootName,
            '目录撤回或删除成员不会改写用户已安装的真实技术名');
    }
    for (const item of definitions) {
        const f = await fixture({ installed: [{ id: item.id, version: item.version }] });
        const own = f.mods.find(mod => mod.id === item.id), other = f.mods.find(mod => mod.id !== item.id);
        assert.equal(f.market.checkModInstallStatus(own), 'up_to_date', '历史安装按真实技术名识别其语言');
        assert.equal(own._matchedLocal.name, item.bootName);
        assert.equal(f.market.checkModInstallStatus(other), 'not_installed', '不能将同仓库的另一语言认成已安装');
        assert.equal(other._matchedLocal, null);
        assert.equal(f.market.findMarketModByLocalName(item.bootName).id, item.id, '管理页历史安装关联返回独立成员');
        assert.ok(f.cards.innerHTML.includes(`已安装${item.variant.label}`));
        const controls = bindLanguageCard(f);
        assert.equal(controls.choices.find(button => Number(button.dataset.modIndex) === f.mods.indexOf(own)).getAttribute('aria-pressed'), 'true',
            '仅安装一种语言时优先预览该语言');
        assert.equal(controls.rows.find(row => Number(row.dataset.modIndex) === f.mods.indexOf(own)).hidden, false);
        assert.equal(controls.rows.find(row => Number(row.dataset.modIndex) === f.mods.indexOf(other)).hidden, true);
        f.market.filterInstalledOnly();
        assert.equal((f.cards.innerHTML.match(/class="modhub-market-variant-row"/g) || []).length, 2,
            '安装状态仅匹配一种语言时仍展示完整组，保留另一语言的明确选择');
        const filtered = f.market.getFilteredDisplayMods([own], f.market.getLocalInstalledProfiles());
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].variants.length, 2);
    }
    {
        const f = await fixture({ installed: [{ id: definitions[0].id, version: '1.0.0' }] });
        const [chs, en] = f.mods;
        assert.equal(f.market.checkModInstallStatus(chs), 'update_available');
        assert.equal(f.market.getModUpdateInfo(chs).version, '1.1.0', '简中不能借用英文的 2.0.0 版本');
        assert.equal(f.market.checkModInstallStatus(en), 'not_installed');
        assert.ok(f.row(chs.id).includes('更新简体中文'));
        assert.ok(!f.row(en.id).includes('更新English'));
        f.market.filterUpdatableOnly();
        assert.equal((f.cards.innerHTML.match(/class="modhub-market-variant-row"/g) || []).length, 2,
            '仅一种语言可更新时仍保留完整语言组');
        const updates = f.market.getUpdatableMods();
        assert.equal(updates.length, 1);
        assert.equal(updates[0].marketMod.id, chs.id);
        assert.equal(updates[0].localProfile.name, definitions[0].bootName);
    }
    {
        const f = await fixture({ installed: [{ id: definitions[0].id, version: '1.0.0' },
            { id: definitions[1].id, version: '1.5.0' }] });
        assert.ok(f.cards.innerHTML.includes('已安装 2 种语言'));
        assert.ok(f.cards.innerHTML.includes('当前同时保留多个语言包'));
        assert.ok(f.row(definitions[0].id).includes('已安装版本：1.0.0'));
        assert.ok(f.row(definitions[1].id).includes('已安装版本：1.5.0'));
        assert.ok(f.row(definitions[0].id).includes('更新简体中文'));
        assert.ok(f.row(definitions[1].id).includes('更新English'));
        const updates = f.market.getUpdatableMods();
        assert.deepEqual(Array.from(updates, item => item.marketMod.id), definitions.map(item => item.id),
            '双安装的更新列表保持两个独立目标，不取首个成员代表全部');
        assert.deepEqual(Array.from(updates, item => item.localProfile.name), definitions.map(item => item.bootName));
        const [chs, en] = f.mods;
        f.sb.modHubRestore = null;
        const updated = [];
        f.sb.modHubMarketInstaller = { install: async mod => { updated.push(mod); return false; } };
        const controls = bindLanguageCard(f);
        assert.deepEqual(controls.choices.map(button => button.getAttribute('aria-pressed')), ['true', 'false'], '多语言已安装时只预览第一成员，不默认安装');
        await controls.choices[1].onclick();
        const englishUpdate = controls.versions.find(button => Number(button.dataset.modIndex) === 1);
        assert.ok(englishUpdate.className.split(/\s+/).includes('btn-market-update'), '英文新版使用共用更新按钮');
        await englishUpdate.onclick();
        assert.deepEqual(updated.map(mod => mod.id), [en.id], '选中英文后更新入口不能处理简中成员');
        f.market.setModUpdateIgnored(chs.name, '1.1.0');
        assert.equal(f.market.getIgnoredUpdates()[chs.name], '1.1.0');
        assert.equal(f.market.getIgnoredUpdates()[en.name], undefined, '忽略简中不能写入英文的更新偏好');
        assert.equal(f.market.checkModInstallStatus(en), 'update_available', '忽略简中不能遮蔽英文独立新版');
        assert.deepEqual(Array.from(f.market.getUpdatableMods(), item => item.marketMod.id), [en.id]);
    }
    {
        const f = await fixture({ legacy: true, cache: true });
        assert.equal(f.requests(), 3, '本轮先尝试两个在线索引，失败后核对身份并复用最后成功目录');
        assert.deepEqual(f.requestUrls, offlineCatalogUrls, '保留主索引、备用索引、持久目录身份校验的回退顺序，不能下载包体');
        assert.equal(f.market.getDisplayMods().length, 2, '旧缓存没有显式声明时保留两个独立条目');
        assert.ok(f.market.getDisplayMods().every(mod => !mod.isLanguageGroup));
        assert.equal((f.cards.innerHTML.match(/class="childItem modhub-market-card/g) || []).length, 2);
    }
    {
        const f = await fixture({ unrelated: true });
        assert.equal(f.market.getMarketMods().length, 3);
        assert.equal(f.market.getDisplayMods().length, 2, '同仓库第三个无关模组保持独立卡片');
        assert.equal(f.market.getDisplayMods().find(mod => !mod.isLanguageGroup).id, 'language-cards-unrelated');
    }
    {
        // 使用已核验的真实身份构造未来发布；测试数据不代表上游已有此发布。
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.12.13' };
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        const lnn = ['lnn-enemy-stats-display-chs', 'lnn-enemy-stats-display-en']
            .map(id => catalog.mods.find(mod => mod.id === id));
        const upstream = 'https://github.com/DGCK81LNN/dol-enemy-stats-display-mod';
        const raw = lnn.map(mod => ({ ...copy(mod), identityId: mod.id, githubUrl: `${upstream}/releases/latest`,
            sourceUrl: `${upstream}/releases/latest`, sharedRepository: true }));
        const mods = market.normalizeReleaseIndex({ schemaVersion: 1, identities: copy(lnn), mods: raw });
        const assets = ['LNN_Enemy_Stats_Display_CHS_v1.2.0.mod.zip', 'LNN_Enemy_Stats_Display_v1.2.0.mod.zip']
            .map(name => ({ name, size: 100, downloadUrl: `${upstream}/releases/download/v1.2.0/${name}` }));
        const history = (mod, available = assets) => ({ schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl,
            page: 1, hasMore: false, releases: [{ tagName: 'v1.2.0', name: '1.2.0',
                publishedAt: '2026-10-09T00:00:00Z', assets: available }] });
        const candidates = mods.map((mod, index) => {
            const result = versions.buildCandidates(mod, history(mod));
            assert.deepEqual(Array.from(result, item => item.assetName), [assets[index].name],
                '真实 LNN 身份的未来同发布两语言只能各自匹配一个候选');
            assert.equal(result[0].version, '1.2.0');
            assert.equal(market.matchesAssetIdentity(assets[1 - index], mod), false);
            return result;
        });
        assert.equal(versions.getDefaultSelection(mods[0], [...candidates[0], ...candidates[1]]).defaultKey, '',
            '混合语言候选不能默认选择一个更高或同版语言');
        const [onlyChs] = market.normalizeReleaseIndex({ schemaVersion: 1, identities: [copy(lnn[0])],
            mods: [{ ...copy(raw[0]), sharedRepository: false }] });
        assert.equal(onlyChs.sharedRepository, false);
        assert.equal(versions.buildCandidates(onlyChs, history(onlyChs, [assets[1]])).length, 0,
            '目录只剩简中且不标共享仓库时，也不能借用英文安装包');
        assert.equal(market.buildReleaseAssetPlan([assets[1]], '0.5.12.13', onlyChs).candidates.length, 0);
        assert.deepEqual(Array.from(versions.buildCandidates(onlyChs, history(onlyChs)), item => item.assetName), [assets[0].name]);
    }
    {
        // 未登记过的产品也可由显式语言声明和其自身附件证据隔离，不依赖 LNN 名称。
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        const upstream = 'https://github.com/FutureLanguageAuthor/Shared';
        const definitions = [
            { id: 'future-language-zh', bootName: '未来产品·简中', label: '简体中文', languageId: 'zh-CN', file: 'Future_Feature_CHS' },
            { id: 'future-language-en', bootName: 'Future Feature', label: 'English', languageId: 'en', file: 'Future_Feature' }
        ];
        const raw = definitions.map((item, index) => ({ id: item.id, identityId: item.id, name: '另一个语言产品',
            bootNames: [item.bootName], aliases: [], repositories: [], repositoryKeys: [], sharedRepository: true,
            githubUrl: `${upstream}/releases/latest`, sourceUrl: `${upstream}/releases/latest`,
            variant: { groupId: 'future-language-product', groupName: '另一个语言产品', type: 'language', id: item.languageId, label: item.label },
            verifiedReleaseAssets: [{ sourceUrl: `${upstream}/releases/download/v1.0.0/${item.file}_v1.0.0.mod.zip`,
                sha256: String(index + 1).repeat(64), bootName: item.bootName, version: '1.0.0' }] }));
        const mods = market.normalizeReleaseIndex({ schemaVersion: 1, mods: copy(raw) });
        assert.equal(market.getDisplayMods(mods).length, 1);
        const assets = definitions.map(item => ({ name: `${item.file}_v2.0.0.mod.zip`, size: 100,
            downloadUrl: `${upstream}/releases/download/v2.0.0/${item.file}_v2.0.0.mod.zip` }));
        mods.forEach((mod, index) => {
            const result = versions.buildCandidates(mod, { schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl,
                releases: [{ tagName: 'v2.0.0', name: '2.0.0', publishedAt: '2026-10-09T00:00:00Z', assets }] });
            assert.deepEqual(Array.from(result, item => item.assetName), [assets[index].name], '新产品复用同一语言附件边界');
        });
        const legacy = copy(raw).map(mod => { delete mod.variant; return mod; });
        assert.equal(market.getDisplayMods(market.normalizeReleaseIndex({ schemaVersion: 1, mods: legacy })).length, 2,
            '旧客户端结构没有显式变体字段时不能根据仓库或已核验文件名猜分组');
    }
    {
        const sb = loadMarket(), market = sb.modHubMarket;
        const legacy = indexFor({ legacy: true, unrelated: true });
        const fresh = { schemaVersion: 1, mods: indexFor({ unrelated: true }).identities };
        market.applyIdentityCatalog(copy(fresh));
        const directlyMigrated = market.normalizeReleaseIndex(copy(legacy));
        assert.deepEqual(copy(directlyMigrated[0].requiredDependencies), definitions[0].requiredDependencies,
            '已加载的精确身份目录必须补回旧索引丢失的额外依赖');
        assert.equal(market.getDisplayMods(directlyMigrated).length, 2, '精确补全两语言，同时保留同仓无关模组');
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: copy(legacy.mods) }));
        const requestUrls = [];
        sb.fetch = async url => {
            requestUrls.push(String(url));
            if (String(url).includes('release-index.json')) throw new Error('模拟在线版本索引不可用');
            assert.ok(String(url).endsWith('/mod-identities.json'), '离线迁移仅补充身份，不下载包体');
            return { ok: true, json: async () => copy(fresh) };
        };
        const migrated = await market.loadMarketData();
        assert.deepEqual(requestUrls, offlineCatalogUrls);
        assert.deepEqual(copy(migrated[0].requiredDependencies), definitions[0].requiredDependencies);
        assert.deepEqual(copy(market.getModDependencies(migrated[0])), [{ id: 'ModI18N', bootName: 'ModI18N', version: '*', required: true }]);
        assert.deepEqual(copy(migrated[1].requiredDependencies), [], '英文不借用简中依赖');
        assert.equal(market.getDisplayMods(migrated).length, 2);
        assert.equal(migrated[2].variant, null);
        assert.equal(migrated[0]._identityMetadataUnavailable, false);
    }
    {
        const sb = loadMarket(), market = sb.modHubMarket;
        const legacy = indexFor({ legacy: true });
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: copy(legacy.mods) }));
        sb.localStorage.setItem('modhub_market_identities_v3', JSON.stringify({ timestamp: Date.now(), data: { schemaVersion: 1, mods: copy(legacy.mods) } }));
        sb.fetch = async () => { throw new Error('身份目录离线'); };
        const cached = await market.loadMarketData();
        assert.ok(cached.every(mod => mod._identityMetadataUnavailable && mod.autoInstall === false),
            '旧身份缓存不能替代新版依赖契约，离线时保留只读条目并停止自动安装');
        let operations = 0, failure;
        sb.modHubRestore = { withOperation: async () => { operations++; } };
        sb.modHubGetGui = () => { throw new Error('不得进入游戏加载器'); };
        assert.equal(await market.downloadAndInstallMod(cached[0], undefined, { onFailure: (message, code) => { failure = code; } }), false);
        assert.equal(failure, 'IDENTITY_METADATA_UNAVAILABLE');
        assert.equal(operations, 0, '依赖元数据缺失时不创建还原事务或写入模组');
    }
    for (const mode of ['empty', 'missing-chs']) {
        const sb = loadMarket(), market = sb.modHubMarket;
        const legacy = indexFor({ legacy: true, unrelated: true });
        delete legacy.mods[2].identityId;
        const catalog = { schemaVersion: 1, mods: mode === 'empty' ? []
            : indexFor().identities.filter(identity => identity.id === definitions[1].id) };
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: copy(legacy.mods) }));
        const requestUrls = [];
        sb.fetch = async url => {
            requestUrls.push(String(url));
            if (String(url).includes('release-index.json')) throw new Error('模拟在线版本索引不可用');
            assert.ok(String(url).endsWith('/mod-identities.json'), '缺目标身份时只核对目录，不读取包体');
            return { ok: true, json: async () => copy(catalog) };
        };
        const cached = await market.loadMarketData();
        const chs = cached.find(mod => mod.id === definitions[0].id);
        const english = cached.find(mod => mod.id === definitions[1].id);
        const unrelated = cached.find(mod => mod.id === 'language-cards-unrelated');
        assert.equal(chs._identityMetadataUnavailable, true, `${mode}：成功响应不能替代缺失的精确 CHS 身份`);
        assert.equal(chs.autoInstall, false, `${mode}：缺少目标身份时停止自动安装`);
        assert.equal(english._identityMetadataUnavailable, mode === 'empty');
        assert.equal(english.autoInstall, mode !== 'empty', '已登记英文保持可用，不继承简中依赖或阻断状态');
        assert.deepEqual(copy(english.requiredDependencies), []);
        assert.equal(unrelated._identityMetadataUnavailable, false, '没有 identityId 的独立条目不受他人身份缺失影响');
        assert.equal(unrelated.autoInstall, true);
        assert.equal(unrelated.variant, null);
        assert.deepEqual(copy(unrelated.requiredDependencies), []);
        let operations = 0, failure;
        sb.modHubRestore = { withOperation: async () => { operations++; } };
        sb.modHubGetGui = () => { throw new Error('不得进入游戏加载器'); };
        assert.equal(await market.downloadAndInstallMod(chs, undefined, { onFailure: (message, code) => { failure = code; } }), false);
        assert.equal(failure, 'IDENTITY_METADATA_UNAVAILABLE');
        assert.equal(operations, 0, '缺精确身份时不创建还原事务或写入模组');
        assert.deepEqual(requestUrls, offlineCatalogUrls, '首轮离线回退后，缺少身份的安装仍不得继续请求包体');
    }
    console.log('语言变体市场卡片测试通过');
};
