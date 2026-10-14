// 网站与 Mod 共用的离线搜索规则，以及真实市场入口的筛选与排序。
const { assert, createStubElement, loadMarket, loadScripts } = require('./helpers');
const search = require('../src/javascript/modhub-search.js');

module.exports = async function () {
    const matches = (entry, value) => search.score(entry, search.compile(value)) >= 0;
    const maple = { name: '秋枫白桦框架', author: 'Maplebirch', category: '框架与前置', tags: ['界面'], description: '用于原生暗黑界面。' };
    for (const query of ['秋枫 白桦', 'qiufengbaihua', 'qiu feng bai hua', 'qfbh', 'ＱＦＢＨ', 'qfbh MAPLEBIRCH', '框架 界面']) {
        assert.ok(matches(maple, query), `必须匹配 ${query}`);
    }
    assert.ok(!matches(maple, 'qfbh 不存在'), '多词均须匹配，不能把一个命中词当成全部命中');
    assert.ok(matches({ name: 'Mod Hub' }, 'ｍｏｄｈｕｂ'), '全半角与空格不影响名称匹配');
    assert.ok(matches({ name: '美化' }, 'meihau'), '相邻字母调换算作一次拼写误差');
    assert.ok(matches({ name: '美化' }, 'meihxa'), '支持一次字母替换');
    assert.ok(matches({ name: '美化' }, 'meihuaa'), '支持一次字母插入');
    assert.ok(matches({ name: '美化' }, 'mehua'), '支持一次字母遗漏');
    assert.ok(!matches({ name: '美化' }, 'meifuo'), '两次误拼不能扩宽召回范围');
    assert.ok(!matches({ name: 'ABC' }, 'ax'), '短查询不做拼写容错');
    assert.ok(matches({ name: '模组管理器' }, '模组管里器'), '中文长名称支持一次误写');
    assert.ok(!matches({ name: '模组管理器' }, '模祖管里器'), '中文名称不能容忍两次误写');
    assert.ok(matches({ name: '角色音乐' }, 'juese yinyue'), '常见多音词采用词语读音');
    assert.ok(matches({ name: '女绿' }, 'nv lv'), 'ü 支持使用 v 输入');
    assert.ok(matches({ name: '人物美化', aliases: ['角色装饰'], bootNames: ['CharacterBeauty'], variant: { label: '简体中文' } }, 'characterbeauty 简体'), '别名、包体名称和语言标签继续可检索');
    assert.ok(matches({ name: '候选言灵', spell: { body: '<<set $test to 1>>', inputLocation: '调试控制台' } }, 'test 调试'), '言灵正文和使用环境可跨字段搜索');
    assert.ok(matches({ name: '配方', extraText: ['适用原生环境'] }, '原生'), '网站额外说明保留低权重检索');
    assert.equal(search.score({}, search.compile('  ')), 0);
    assert.equal(search.score({}, search.compile('不存在')), -1);
    const query = search.compile('美化');
    assert.ok(search.score({ name: '美化' }, query) > search.score({ name: '另一个模组', description: '美化' }, query), '直接名称优先于正文偶然提及');
    assert.ok(search.score({ name: '美化' }, search.compile('meihau')) > search.score({ description: 'meihau' }, search.compile('meihau')), '误拼名称仍优先于正文偶然提及');
    assert.ok(!matches({ description: '管理器' }, '管里器'), '简介不做短词拼写容错');

    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-spells.js']);
    const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketSections',
        'modHubMarketStats', 'modHubCategoryCapsules', 'modHubMarketFilterFooter', 'modHubMarketSpellNote',
        'modHubMarketSearch', 'modHubStatusSelect', 'modHubSortSelect', 'modHubMirrorSelect',
        'modHubMarketBatchToolbar', 'modHubMarketBtnResetFilter', 'modHubMarketBtnSubmit'].map(id => [id, createStubElement()]));
    sb.document.getElementById = id => elements.get(id) || null;
    const mods = [
        { id: 'search-maple', ...maple, updateDate: '2026-01-01', githubUrl: 'https://github.com/SearchFixture/Maple' },
        { id: 'search-mentioned', name: '其他模组', description: '秋枫白桦框架的补充资料', updateDate: '2026-10-14', githubUrl: 'https://github.com/SearchFixture/Other' }
    ];
    sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods, communityRevision: 1 }) });
    await sb.modHubInitMarket(true);
    const input = elements.get('modHubMarketSearch');
    input.value = 'qfbh';
    sb.modHubMarket.selectMarketSection('packages');
    const cards = () => elements.get('modHubMarketCardsContainer').innerHTML;
    assert.ok(cards().includes('秋枫白桦框架') && cards().includes('其他模组'), '实际市场入口应匹配名称和简介的首字母');
    assert.ok(cards().indexOf('data-mod-name="秋枫白桦框架"') < cards().indexOf('data-mod-name="其他模组"'), '搜索相关性应优先于更新日期');
    input.value = 'qfbh MAPLEBIRCH';
    sb.modHubMarket.selectMarketSection('packages');
    assert.ok(cards().includes('data-mod-name="秋枫白桦框架"') && !cards().includes('data-mod-name="其他模组"'), '实际市场多词跨字段筛选');
    sb.modHubMarketSpells.applyIndex({ communityRevision: 2, spells: [
        { id: 'spell-search', name: '角色音乐', spell: { body: '原文', inputLocation: '调试控制台' } }
    ] });
    assert.equal(sb.modHubMarketSpells.filter('juese yinyue').length, 1, '言灵入口采用相同拼音规则');
    assert.equal(sb.modHubMarketSpells.filter('原文 调试').length, 1, '言灵入口保留正文和环境检索');

    const feedbackMods = mods.slice().reverse();
    sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: feedbackMods, communityRevision: 3 }) });
    await sb.modHubInitMarket(true);
    sb.modHubMarketSpells.applyIndex({ communityRevision: 3, spells: [
        { id: 'spell-search', name: '角色音乐', author: '配方作者', catalogSource: 'community', sourceUrl: 'https://example.com/spell-search',
            spell: { body: '原文', inputLocation: '调试控制台' } }
    ] });
    for (const section of ['packages', 'spells']) {
        input.value = '';
        sb.modHubMarket.selectMarketSection(section);
        assert.ok(!/[.…]/.test(input.placeholder), '切换市场分区后搜索提示也不带省略号');
        const name = section === 'packages' ? maple.name : '角色音乐';
        const queries = section === 'packages'
            ? ['qiufengbaihua', 'ＱＦＢＨ', 'qiu feng bai hua', 'qfbh MAPLEBIRCH', '秋枫白华框架', 'SearchFixture/Maple']
            : ['juese yinyue', 'jsyy', '角色 音乐', '原文 调试', 'example.com/spell-search'];
        for (const mode of ['correct', 'withdraw']) {
            let step = 0;
            let targetRequest;
            sb.fetch = async (url, options) => {
                assert.equal(new URL(url).pathname, '/community-submissions/target-status');
                targetRequest = JSON.parse(options.body);
                return { ok: true, json: async () => ({ targetStatus: 'active', canRequestDelist: true }) };
            };
            sb.modHubConfirm = async options => {
                if (++step === 1) return mode;
                if (step === 2) {
                    assert.ok(options.trustedMessageHtml.includes('拼音或首字母'), '选择框提示应说明新的搜索方式');
                    const searchInput = { value: '', oninput: null };
                    const select = { value: '', children: [], replaceChildren() { this.children = []; },
                        appendChild(child) { this.children.push(child); } };
                    const confirm = { disabled: false };
                    options.onRender({ querySelector: selector => ({ '.modhub-feedback-search': searchInput,
                        '.modhub-modal-select': select, '.modhub-modal-btn-confirm': confirm })[selector] });
                    const targetValue = options.selectOptions.find(option => option.label.startsWith(`${name} ·`)).value;
                    for (const value of queries) {
                        select.value = '旧目标';
                        confirm.disabled = false;
                        searchInput.value = value;
                        searchInput.oninput();
                        assert.equal(select.children[1]?.value, targetValue, `${section}/${mode} 应按相关程度找到 ${value}`);
                        assert.equal(select.value, '', '搜索后必须清除旧选择，不能误申请另一个目标');
                        assert.equal(confirm.disabled, true, '搜索后须重新选择才能填写申请');
                    }
                    searchInput.value = '没有这个目标';
                    searchInput.oninput();
                    assert.equal(select.children.length, 1, '无匹配结果时只保留空选项');
                    searchInput.value = '  ';
                    searchInput.oninput();
                    assert.deepEqual(select.children.slice(1).map(option => option.value),
                        Array.from(options.selectOptions.slice(1), option => option.value), '清空搜索应恢复完整目录原顺序');
                    return targetValue;
                }
                assert.equal(options.title, mode === 'correct' ? '纠错' : '申请下架');
                const dialog = createStubElement();
                const fields = new Map();
                dialog.querySelector('.modhub-community-form').elements = { namedItem(field) {
                    if (!fields.has(field)) fields.set(field, Object.assign(createStubElement('input'), { maxLength: 64000 }));
                    return fields.get(field);
                } };
                options.onRender(dialog);
                assert.equal(fields.get('name').value, name, '搜索排序后仍须打开原目标的申请表');
                return false;
            };
            await sb.modHubMarket.openCommunityFeedback();
            assert.equal(step, 3, `${section}/${mode} 应完成类型、目标与申请表三步`);
            if (mode === 'withdraw') assert.equal(targetRequest.catalogId, section === 'packages' ? 'search-maple' : 'spell-search');
        }
    }
    console.log('离线搜索规则与市场入口验证通过');
};
