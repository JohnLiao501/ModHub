// 使用真实浏览器 DOM 验证共享提取器与客户端 Wiki 回退；网络仅提供本地源码。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 自动化 DOM 回归复用已安装的 Playwright 与 Chrome，不下载依赖或网页。
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'node', 'node_modules', 'playwright')); }
const root = path.resolve(__dirname, '..');
const gh = 'https://github.com/Example/Main';
const tieba = 'https://tieba.baidu.com/p/123';
const qq = 'https://qm.qq.com/q/example';
const dc = 'https://discord.gg/example';
const anchor = (url, label) => `<a href="${url}">${label}</a>`;
const cases = [
    { label: '露出拓展真实 pre 名称列与开发状态',
        cell: `<b><big>露出拓展</big></b><pre>${anchor('https://sb.alseece.top/2?=DoL-MEE', '下载链接')}</pre><pre>正在开发中</pre><pre>${anchor('https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-MyExhibitionismExpansion', 'Github')}</pre>`,
        names: ['露出拓展'], github: ['https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-MyExhibitionismExpansion'],
        other: ['https://sb.alseece.top/2?=DoL-MEE'], legacy: '正在开发中' },
    { label: '普通文本标题与贴吧来源', cell: `小小PC修复增强<br>${anchor(gh, 'GitHub')} ${anchor(tieba, '百度贴吧')}`,
        names: ['小小PC修复增强'], github: [gh], other: [tieba], legacy: '百度贴吧' },
    { label: '截图中的ModHub文本标题与居中社群入口',
        cell: `<div style="text-align:center"><b>ModHub模组管理中心</b><div>${anchor(gh, 'Github')}${anchor(dc, 'Discord')}${anchor(tieba, '论坛地址')}${anchor(qq, 'QQ群')}</div></div>`,
        names: ['ModHub模组管理中心'], github: [gh], other: [dc, tieba, qq] },
    { label: '任意文案邀请链接不能覆盖标题', cell: `真实标题<br>${anchor(dc, '官方交流频道')} ${anchor(qq, 'MOD交流群')}`,
        names: ['真实标题'], github: [], other: [dc, qq] },
    { label: '仅有任意文案邀请链接时不猜标题', cell: `${anchor(dc, '官方交流频道')}<br>${anchor(qq, 'MOD交流群')}`,
        ambiguous: true, github: [], other: [dc, qq] },
    { label: '链接标题与贴吧来源', cell: `${anchor(gh, '小小PC修复增强')}<br>${anchor(tieba, '百度贴吧')}`,
        names: ['小小PC修复增强'], github: [gh], other: [tieba], legacy: '小小PC修复增强/百度贴吧' },
    { label: 'QQ群标签链接', cell: `甲模组<br>${anchor(gh, 'Github')} ${anchor(qq, 'QQ群')}`,
        names: ['甲模组'], github: [gh], other: [qq] },
    { label: 'QQ标签链接', cell: `乙模组<div>${anchor(qq, 'QQ')} ${anchor(gh, 'Github')}</div>`,
        names: ['乙模组'], github: [gh], other: [qq] },
    { label: 'dc标签链接', cell: `<p>丙模组</p><p>${anchor(gh, 'GitHub')} ${anchor(dc, 'dc')}</p>`,
        names: ['丙模组'], github: [gh], other: [dc] },
    { label: '完整Discord标签', cell: `丁模组<br>${anchor(gh, 'GitHub')} ${anchor(dc, 'Discord')}`,
        names: ['丁模组'], github: [gh], other: [dc] },
    { label: '纯文本QQ群号', cell: `戊模组<br>QQ群：123456789<br>${anchor(gh, 'GitHub')}`,
        names: ['戊模组'], github: [gh], other: [] },
    { label: '纯文本dc联系方式', cell: `<div>己模组</div><div>dc: https://discord.gg/example</div><div>${anchor(gh, 'GitHub')}</div>`,
        names: ['己模组'], github: [gh], other: [] },
    { label: '纯文本贴吧说明', cell: `<p>庚模组</p><p>百度贴吧：https://tieba.baidu.com/p/123</p><p>${anchor(gh, 'GitHub')}</p>`,
        names: ['庚模组'], github: [gh], other: [] },
    { label: '非GitHub真实标题', cell: `${anchor('https://mods.example.test/title', '外站真实标题')}<br>${anchor(dc, 'dc')}`,
        names: ['外站真实标题'], github: [], other: ['https://mods.example.test/title', dc] },
    { label: '普通文本与下载来源同段', cell: `原有效模组 ${anchor('https://downloads.example.test/main', '下载')} ${anchor(gh, 'GitHub')}`,
        names: ['原有效模组'], github: [gh], other: ['https://downloads.example.test/main'] },
    { label: 'div与嵌套span保留标题', cell: `<div><b><span>结构标题</span></b></div><div>${anchor(gh, 'GitHub')} ${anchor(tieba, '贴吧')}</div>`,
        names: ['结构标题'], github: [gh], other: [tieba] },
    { label: 'HTML源码换行只折叠空白', cell: `源码排版\r\n 标题\n<br>${anchor(gh, 'GitHub')}`,
        names: ['源码排版 标题'], github: [gh], other: [] },
    { label: '隐藏内容不得污染标题', cell: `<script>伪标题甲</script><style>伪标题乙</style><noscript>伪标题丙</noscript>隐藏块外的标题<br>${anchor(gh, 'GitHub')}`,
        names: ['隐藏块外的标题'], github: [gh], other: [] },
    { label: '多个具名项目', cell: `${anchor('https://github.com/Example/Combat', '遭遇战')} / ${anchor('https://github.com/Example/Cheats', '言灵集')}<br>${anchor(dc, 'dc')}`,
        names: ['遭遇战', '言灵集'], github: ['https://github.com/Example/Combat', 'https://github.com/Example/Cheats'], other: [dc] },
    { label: '单一具名项目', cell: anchor(gh, '明确名称'), names: ['明确名称'], github: [gh], other: [] },
    { label: 'HTML实体标题原生解码', cell: anchor(gh, '糖&amp;茶&#32;增强'), names: ['糖&茶 增强'], github: [gh], other: [] },
    { label: '标题包含QQ不应被子串过滤', cell: `QQ 互动增强<br>${anchor(gh, 'GitHub')}`,
        names: ['QQ 互动增强'], github: [gh], other: [] },
    { label: '同仓库首页版本页不拆项目', cell: `${anchor(gh, '同一模组')} / ${anchor(`${gh}/releases/tag/v1.2.3`, '同一模组')}`,
        names: ['同一模组'], github: [gh, `${gh}/releases/tag/v1.2.3`], other: [] },
    { label: '无下载纯名称', cell: '<p>无下载条目</p>', names: ['无下载条目'], github: [], other: [] },
    { label: '两个普通标题含糊', cell: `候选甲<br>候选乙<br>${anchor(gh, 'GitHub')} ${anchor(tieba, '贴吧')}`,
        ambiguous: true, github: [gh], other: [tieba] },
    { label: 'hr分隔的候选标题仍含糊', cell: `候选甲<hr>候选乙<br>${anchor(gh, 'GitHub')}`,
        ambiguous: true, github: [gh], other: [] },
    { label: '两个外站标题含糊', cell: `${anchor('https://mods.example.test/a', '候选标题甲')}<br>${anchor('https://mods.example.test/b', '候选标题乙')}`,
        ambiguous: true, github: [], other: ['https://mods.example.test/a', 'https://mods.example.test/b'] },
    { label: '联系方式不能充当标题', cell: `${anchor(qq, 'QQ群')}<br>${anchor(dc, 'dc')}<br>${anchor(gh, 'GitHub')}`,
        ambiguous: true, github: [gh], other: [qq, dc] },
];

function fixture(cell, privateTable = false, reordered = false) {
    const name = `<td>${cell}</td>`, description = `<td>说明与${anchor('https://github.com/Other/Dependency', '依赖引用')}及${anchor('https://reference.example.test/info', '参考资料')}</td>`;
    const author = `<td>${anchor('https://github.com/Author/Profile', '测试作者')}</td>`, date = '<td>2026-10-12 (v1.2.3)</td>';
    const cells = reordered ? [author, date, description, name] : [name, description, author, date];
    const headers = reordered ? ['作者', '最后更新', '简介', '名称'] : ['名称', '简介', '作者', '最后更新'];
    const table = `<table class="wikitable"><tr>${headers.map(value => `<th>${value}</th>`).join('')}</tr><tr>${cells.join('')}</tr></table>`;
    return `<h2 id="公开模组">公开模组</h2>${privateTable ? '' : table}<h2 id="私有模组">私有模组</h2>${privateTable ? table : ''}<h2 id="模组相关工具">模组相关工具</h2>`;
}

async function run() {
    const helper = fs.readFileSync(path.join(root, 'modhub-wiki-title.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const copy of ['src/javascript/modhub-wiki-title.js', 'dolmod-site/dist/modhub-wiki-title.js']) {
        assert.equal(fs.readFileSync(path.join(root, copy), 'utf8').replace(/\r\n/g, '\n'), helper, `标题解析器镜像一致：${copy}`);
    }
    const chrome = process.env.MODHUB_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    const browser = await playwright.chromium.launch({ ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}), headless: true });
    const requests = [];
    const messages = [];
    const pageErrors = [];
    try {
        const page = await browser.newPage();
        page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
        page.on('pageerror', error => pageErrors.push(error.message));
        const sources = new Map([
            ['/modhub-wiki-title.js', path.join(root, 'modhub-wiki-title.js')],
            ['/src/javascript/modhub-wiki-title.js', path.join(root, 'src/javascript/modhub-wiki-title.js')],
            ['/dol-mod-extractor.js', path.join(root, 'dol-mod-extractor.js')],
            ['/src/javascript/modhub-market.js', path.join(root, 'src/javascript/modhub-market.js')],
        ]);
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            requests.push(url.toString());
            assert.equal(url.origin, 'https://wiki-title.test', '测试不得请求外部来源');
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><meta charset="utf-8"><body></body></html>' });
            const source = sources.get(url.pathname);
            assert.ok(source, `未允许的本地请求：${url.pathname}`);
            return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(source, 'utf8') });
        });
        await page.goto('https://wiki-title.test/');
        await page.addScriptTag({ url: 'https://wiki-title.test/src/javascript/modhub-wiki-title.js' });
        await page.addScriptTag({ url: 'https://wiki-title.test/src/javascript/modhub-market.js' });
        await page.evaluate(async () => { window.fixtureExtractor = await import('/dol-mod-extractor.js'); });
        let checked = 0;
        for (const test of cases) for (const [privateTable, reordered] of [[false, false], [true, true]]) {
            const html = fixture(test.cell, privateTable, reordered);
            const result = await page.evaluate(html => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const title = globalThis.modHubWikiTitle.fromDom(doc.querySelectorAll('table.wikitable tr')[1].querySelectorAll('td')[doc.querySelector('th').textContent === '作者' ? 3 : 0]);
                return { title, extractor: window.fixtureExtractor.extractModsFromHtml(html), client: window.modHubMarket.parseModsFromHtml(html) };
            }, html);
            const label = `${test.label}（${privateTable ? '私有重排列' : '公开默认列'}）`;
            if (test.ambiguous) {
                assert.notEqual(result.title.status, 'resolved', `${label}：含糊输入不能硬猜标题`);
                assert.equal(result.client.length, 0, `${label}：客户端隔离未确定标题`);
                assert.equal(result.extractor.length, 1, `${label}：提取器保留诊断项`);
                assert.equal(result.extractor[0].name, null);
                assert.equal(result.extractor[0].status, 'Failed');
                assert.ok(result.extractor[0].missing.includes('name'));
            } else {
                assert.equal(result.title.status, 'resolved', `${label}：标题可确定`);
                for (const [parser, mods] of [['共享提取器', result.extractor], ['客户端', result.client]]) {
                    assert.deepEqual(mods.map(mod => mod.name), test.names, `${label}：${parser}名称`);
                    assert.ok(mods.every(mod => mod.titleStatus === 'resolved'), `${label}：${parser}明确标题状态`);
                    assert.deepEqual(mods.flatMap(mod => mod.githubUrls), test.github, `${label}：${parser}只保留名称列项目来源`);
                    assert.ok(mods.every(mod => mod.author === '测试作者'), `${label}：${parser}作者列识别`);
                    assert.ok(mods.every(mod => mod.version === '1.2.3'), `${label}：${parser}版本列识别`);
                    if (test.legacy) assert.equal(mods[0].wikiLegacyName, test.legacy, `${label}：保留旧名称兼容证据`);
                }
                assert.deepEqual(result.extractor.map(mod => mod.wikiLegacyName), result.client.map(mod => mod.wikiLegacyName), `${label}：两条路径旧名称一致`);
            }
            for (const mod of [...result.extractor, ...result.client]) {
                assert.deepEqual(mod.otherUrls, test.other, `${label}：来源与联系链接保留，描述和作者链接不串入`);
                assert.ok(!mod.githubUrls.some(url => /Other\/Dependency|Author\/Profile/.test(url)));
            }
            checked++;
        }
        assert.ok(requests.every(url => url.startsWith('https://wiki-title.test/')));
        assert.deepEqual(pageErrors, [], '实际解析脚本无浏览器异常');
        assert.ok(messages.filter(message => message.type === 'warning').some(message => message.text.includes('无法确定标题')), '明确报告被隔离的含糊输入');
        console.log(`Wiki 标题浏览器跨路径回归通过：${checked} 组、两条实际解析路径；仅加载本地源码，未访问线上或游戏。`);
    } finally { await browser.close(); }
}

module.exports = { cases, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
