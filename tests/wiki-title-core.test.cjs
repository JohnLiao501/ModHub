const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extract, fromDom, isUtilityName, isStatusName, normalizeStatusTitle, boundaryTags, ignoredTags } = require('../src/javascript/modhub-wiki-title.js');
const text = value => ({ type: 'text', text: value });
const link = (value, href) => ({ type: 'link', text: value, href });
const br = () => ({ type: 'break' });
const gh = 'https://github.com/John/Example';
const tieba = 'https://tieba.baidu.com/p/123456';
let count = 0;

function test(name, body) {
  body();
  count += 1;
  console.log(`通过：${name}`);
}

function resolved(tokens, expected) {
  const value = extract(tokens);
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, expected);
  assert.deepEqual(value.projects, []);
  return value;
}

function unresolved(tokens, expected = 'ambiguous') {
  const value = extract(tokens);
  assert.equal(value.status, expected);
  assert.equal(value.name, '');
  return value;
}

function projects(tokens) {
  const value = extract(tokens);
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, '');
  assert.ok(value.projects.length > 1);
  return value;
}

test('普通文本标题不会被百度贴吧链接覆盖，旧兼容名精确保留', () => {
  const value = resolved([text('小小PC修复增强'), br(), link('GitHub', gh), br(), link('百度贴吧', tieba)], '小小PC修复增强');
  assert.equal(value.legacyName, '百度贴吧');
  assert.deepEqual(value.contacts, [{ text: '百度贴吧', href: tieba }]);
});

test('普通文本标题后的 QQ、QQ群与 dc 链接均为功能入口', () => {
  for (const label of ['QQ', 'QQ群', 'dc', 'Discord', '交流频道', 'QQ群号']) {
    resolved([text('真实标题'), br(), link(label, 'https://qm.qq.com/q/example')], '真实标题');
  }
});

test('非 GitHub 链接也可以承载真实模组标题', () => {
  resolved([link('小小PC修复增强', tieba), br(), link('QQ群', 'https://qm.qq.com/q/example')], '小小PC修复增强');
});

test('已知联系方式域名的真实标题不会按域名直接删除', () => {
  for (const href of [tieba, 'https://discord.com/channels/123/456', 'https://example.org/mod']) {
    resolved([link('外站发布的真实标题', href)], '外站发布的真实标题');
  }
});

test('邀请入口按 URL 用途识别，不依赖社群链接的文案', () => {
  for (const href of ['https://discord.gg/example', 'https://discord.com/invite/example',
    'https://discordapp.com/invite/example', 'https://qm.qq.com/q/example', 'https://jq.qq.com/?k=example',
    'https://qun.qq.com/qqweb/qunpro/share?_wv=3', 'https://t.me/+example', 'https://t.me/joinchat/example']) {
    for (const name of ['官方交流频道', 'MOD交流群', 'QQ交流群', '进入这里']) {
      resolved([text('真实标题'), br(), link(name, href)], '真实标题');
      unresolved([link(name, href)], 'missing');
    }
  }
});

test('伪装邀请域名和外站内容页面不按社群入口删除', () => {
  for (const href of ['https://discord.gg.example.org/mod', 'https://qm.qq.com.example.org/mod',
    'https://discord.com/channels/123/456', tieba, 'https://t.me/example_mod']) {
    resolved([link('真实标题', href)], '真实标题');
  }
});

test('完整功能名称与组合可识别，真实标题中的功能词保留', () => {
  for (const value of ['QQ群', '百度贴吧', '论坛地址', '论坛链接', 'QQ / dc / GitHub', '[下载]', 'Github →', 'QQ群：12345678']) {
    assert.equal(isUtilityName(value), true, value);
  }
  for (const value of ['QQ 互动增强', 'Discord NPC 扩展', '贴吧剧情扩展', '[测试] NPC Github helper', '模组甲/模组乙', '']) {
    assert.equal(isUtilityName(value), false, value);
  }
  unresolved([text('QQ / dc / GitHub')], 'missing');
  resolved([text('真实标题'), br(), link('Github →', gh)], '真实标题');
});

test('纯文本联系方式所在行不进入标题', () => {
  resolved([text('真实标题'), br(), text('QQ群：12345678'), br(), text('dc: https://discord.gg/example')], '真实标题');
  resolved([text('真实标题'), br(), text('群号：12345678'), br(), text('Discord: https://discord.gg/example')], '真实标题');
});

test('同行明确联系方式后缀可以分离', () => {
  resolved([text('真实标题 QQ群：12345678')], '真实标题');
  resolved([text('真实标题 (QQ群：12345678)')], '真实标题');
});

test('标题中的 QQ、Discord、dc、贴吧和 GitHub 子串原样保留', () => {
  for (const value of ['QQ 互动增强', 'Discord NPC 扩展', 'dcRepair', '贴吧剧情扩展', '[测试] NPC Github helper']) {
    resolved([text(value)], value);
    resolved([link(value, 'https://example.org/mod')], value);
  }
});

test('功能标签括号和外围分隔符不会污染标题', () => {
  resolved([text('真实标题 ('), link('GitHub', gh), text(') / '), link('[百度贴吧]', tieba)], '真实标题');
  resolved([text('真实标题'), br(), link('[下载]', 'https://example.org/file'), br(), link('(dc)', 'https://discord.gg/example')], '真实标题');
});

test('明确的来源前缀行不取来源页标题作为模组名', () => {
  resolved([text('真实标题'), br(), text('源码：'), link('John 的仓库', gh), br(), text('下载地址：'), link('附件', 'https://example.org/file')], '真实标题');
});

test('完整旧主页、新主页标签是来源入口，旧兼容名不被改写', () => {
  for (const label of ['旧主页', '新主页']) {
    const value = resolved([link('测试模组', gh), text(' '), link(label, 'https://old.example/home')], '测试模组');
    assert.equal(value.legacyName, `测试模组/${label}`);
  }
});

test('真实标题包含旧主页、新主页字样时不按子串过滤', () => {
  for (const value of ['旧主页修复增强', '我的旧主页', '新主页主题扩展']) {
    resolved([text(value)], value);
    resolved([link(value, 'https://old.example/mod')], value);
  }
});

test('仅功能入口时缺少标题，不猜仓库名称', () => {
  const value = unresolved([link('GitHub', gh), br(), link('QQ', 'https://qm.qq.com/q/example'), br(), link('百度贴吧', tieba)], 'missing');
  assert.deepEqual(value.projects, []);
});

test('文本流分块不影响结果', () => {
  assert.deepEqual(extract([text('小小'), text('PC'), text('修复增强')]), extract([text('小小PC修复增强')]));
});

test('HTML 源码换行只折叠为空白，不创建多个标题候选', () => {
  resolved([text('真实\n标题')], '真实 标题');
  resolved([text('真实\r\n  标题')], '真实 标题');
  resolved([text('真实\n'), text('标题')], '真实 标题');
});

test('两个独立普通文本标题不选第一个', () => {
  const value = unresolved([text('项目甲'), br(), text('项目乙')]);
  assert.deepEqual(value.projects, []);
});

test('两个外站具名标题没有项目关系时保持歧义', () => {
  const value = unresolved([link('项目甲', 'https://example.org/a'), br(), link('项目乙', 'https://example.org/b')]);
  assert.deepEqual(value.projects, []);
});

test('同段落多个外站标题也不拼接或默认选中', () => {
  const value = unresolved([link('项目甲', 'https://example.org/a'), text('/'), link('项目乙', 'https://example.org/b')]);
  assert.deepEqual(value.projects, []);
});

test('两个明确具名 GitHub 项目保留独立名称、来源与旧兼容名', () => {
  const value = projects([link('项目甲', gh), text(' / '), link('项目乙', 'https://github.com/Other/Project')]);
  assert.deepEqual(value.projects, [
    { name: '项目甲', href: gh, legacyName: '项目甲' },
    { name: '项目乙', href: 'https://github.com/Other/Project', legacyName: '项目乙' },
  ]);
  assert.equal(value.legacyName, '项目甲/项目乙');
});

test('来源标签不会加入多项目拆分', () => {
  const value = projects([link('项目甲', gh), br(), link('项目乙', 'https://github.com/Other/Project'), br(), link('GitHub', 'https://github.com/Third/Source'), br(), link('百度贴吧', tieba)]);
  assert.equal(value.projects.length, 2);
});

test('同标题的重复链接、不同版本链接和大小写仓库地址不拆项目', () => {
  resolved([link('项目甲', gh), br(), link('项目甲', 'https://github.com/john/example.git'), br(), link('项目甲', `${gh}/releases/tag/v1.0.0`)], '项目甲');
});

test('同仓库不同标题但没有独立固定来源时不拆项目', () => {
  const value = unresolved([link('项目甲', gh), br(), link('项目乙', `${gh}/tree/main`)]);
  assert.deepEqual(value.projects, []);
});

test('同仓库名称仅版本不同不会登记为两个模组', () => {
  const value = unresolved([link('项目甲 v1.0', `${gh}/releases/tag/v1.0`), br(), link('项目甲 v2.0', `${gh}/releases/tag/v2.0`)]);
  assert.deepEqual(value.projects, []);
});

test('同仓库两个明确语言包固定附件保留独立项目身份', () => {
  const chs = `${gh}/releases/download/v1.1.0/Enemy.CHS.mod.zip`;
  const en = `${gh}/releases/download/v1.1.0/Enemy.EN.mod.zip`;
  const value = projects([link('对手状态简中', chs), br(), link('Enemy Stats English', en)]);
  assert.deepEqual(value.projects, [
    { name: '对手状态简中', href: chs, legacyName: '对手状态简中' },
    { name: 'Enemy Stats English', href: en, legacyName: 'Enemy Stats English' },
  ]);
});

test('两个标题指向同一标签页面无法证明独立附件', () => {
  const value = unresolved([link('对手状态简中', `${gh}/releases/tag/v1.1.0`), br(), link('Enemy Stats English', `${gh}/releases/tag/v1.1.0`)]);
  assert.deepEqual(value.projects, []);
});

test('独立文本标题加不相同的具名项目链接不会硬猜', () => {
  const value = unresolved([text('真实标题'), br(), link('其他项目', gh)]);
  assert.deepEqual(value.projects, []);
});

test('legacyName 精确保留旧链接优先次序和原宽功能词规则', () => {
  const value = extract([text('普通标题'), br(), link('QQ群', 'https://qm.qq.com/q/example'), br(), link('dc', 'https://discord.gg/example'), br(), link('Discord Mod', gh), br(), link('百度贴吧', tieba)]);
  assert.equal(value.legacyName, 'QQ群/dc/百度贴吧');
});

test('legacyName 的换行边界不自行插入空格，fallback 只替换第一个原文本', () => {
  assert.equal(extract([text('甲'), br(), text('乙')]).legacyName, '甲乙');
  const value = extract([text('GitHub'), br(), link('GitHub', gh)]);
  assert.equal(value.legacyName, 'GitHub');
});

test('legacyName 精确保留原功能箭头方向，不能扩大旧兼容过滤', () => {
  assert.equal(extract([text('真实标题'), link(String.fromCodePoint(0x2192), gh)]).legacyName, '真实标题');
  assert.equal(extract([text('真实标题'), link(String.fromCodePoint(0x2193), gh)]).legacyName, String.fromCodePoint(0x2193));
});

test('实体、文本空白和图形符号处理一致，输入本身不被修改', () => {
  const tokens = [text('  甲 &amp; 乙  '), br(), link('GitHub', gh)];
  const before = JSON.stringify(tokens);
  resolved(tokens, '甲 & 乙');
  assert.equal(JSON.stringify(tokens), before);
  resolved([text(`真实${String.fromCodePoint(0x1f680)}标题`)], '真实标题');
});

test('HTML 原始文本适配解码数字与 nbsp 实体，旧兼容名称完全不变', () => {
  for (const [raw, name] of [['糖&amp;茶&#32;增强', '糖&茶 增强'], ['糖&#x20;茶&#x589e;&#24378;', '糖 茶增强'], ['糖&nbsp;茶', '糖 茶']]) {
    const tokens = [link(raw, gh)];
    const before = JSON.stringify(tokens);
    const value = extract(tokens, { htmlEncoded: true });
    assert.equal(value.status, 'resolved');
    assert.equal(value.name, name);
    assert.equal(value.legacyName, extract(tokens).legacyName);
    assert.equal(JSON.stringify(tokens), before);
  }
  assert.equal(extract([link('糖&amp;茶&#32;增强', gh)], { htmlEncoded: true }).legacyName, '糖&茶&#32;增强');
});

test('HTML 连续文本块先合并，拆开的实体也正确解码', () => {
  const value = extract([text('糖&#'), text('x20;茶&nb'), text('sp;增强')], { htmlEncoded: true });
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, '糖 茶 增强');
  assert.equal(value.legacyName, '糖&#x20;茶&nbsp;增强');
});

test('未启用 HTML 适配时保留字面数字和 nbsp 实体，不重复解码', () => {
  for (const literal of ['字面&#32;文本', '字面&#x20;文本', '字面&nbsp;文本']) {
    resolved([text(literal)], literal);
    assert.equal(extract([text(literal)], { htmlEncoded: false }).name, literal);
  }
  assert.equal(extract([text('字面&amp;#32;文本')], { htmlEncoded: true }).name, '字面&#32;文本');
});

function domText(value) {
  return { nodeType: 3, nodeValue: value, textContent: value };
}

function dom(tag, children = [], attrs = {}) {
  return { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
    get textContent() { return children.map(child => child.textContent || '').join(''); },
    getAttribute(name) { return attrs[name] || null; } };
}

test('DOM 适配保留 p、div、br、li 边界，行内强调不重复读取', () => {
  const cell = dom('td', [dom('p', [domText('小小'), dom('strong', [domText('PC')]), domText('修复增强')]),
    dom('div', [dom('a', [domText('GitHub')], { href: gh })]), dom('br'),
    dom('ul', [dom('li', [dom('a', [domText('百度贴吧')], { href: tieba })])])]);
  const value = fromDom(cell);
  assert.equal(value.name, '小小PC修复增强');
  assert.equal(value.legacyName, '百度贴吧');
});

test('DOM 分开的两个标题不会因 textContent 拼接成一个名字', () => {
  assert.equal(fromDom(dom('td', [dom('p', [domText('项目甲')]), dom('p', [domText('项目乙')])])).status, 'ambiguous');
});

test('DOM 文本源码跨行和行内强调仍为一个完整标题', () => {
  const value = fromDom(dom('td', [domText('真实\n'), dom('strong', [domText('标题')]), domText('\n')]));
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, '真实 标题');
  assert.equal(value.legacyName, '真实 标题');
});

test('DOM 已解码文本中的字面数字实体保持原样', () => {
  const value = fromDom(dom('td', [domText('字面&#32;文本')]));
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, '字面&#32;文本');
});

test('DOM 的 hr 也分隔标题，不能把两个候选拼成名字', () => {
  const value = fromDom(dom('td', [domText('候选甲'), dom('hr'), domText('候选乙')]));
  assert.equal(value.status, 'ambiguous');
  assert.equal(value.name, '');
  assert.equal(value.legacyName, '候选甲候选乙');
});

test('露出拓展名称列的 pre 开发状态不覆盖真实标题，保留旧名称锚', () => {
  const source = 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-MyExhibitionismExpansion';
  const cell = dom('td', [dom('b', [dom('big', [domText('露出拓展')])]),
    dom('pre', [dom('a', [domText('下载链接')], { href: 'https://sb.alseece.top/2?=DoL-MEE' })]),
    dom('pre', [domText('正在开发中')]), dom('pre', [dom('a', [domText('Github')], { href: source })])]);
  const value = fromDom(cell);
  assert.equal(value.status, 'resolved');
  assert.equal(value.name, '露出拓展');
  assert.equal(value.legacyName, '正在开发中');
  assert.equal(isStatusName('正在开发中', [source]), true);
  assert.equal(normalizeStatusTitle('露出拓展 正在开发中', [source]), '露出拓展');
  for (const name of ['正在开发中', '简介中提到露出拓展', '露出拓展的新分支']) {
    assert.equal(normalizeStatusTitle(name, [source]), '', '只能核对名称列全串，不能从状态或说明猜测名称');
  }
  for (const other of [source.replace('ANLINSTUDIO', 'Other'), source + '/tree/main', source + '?other=1',
    source.replace('https://github.com/', 'https://user@github.com/'), source.replace('github.com', 'github.com.example.org')]) {
    assert.equal(isStatusName('正在开发中', [other]), false, '其它完整来源不能继承该状态标签证据');
    assert.equal(normalizeStatusTitle('露出拓展 正在开发中', [other]), '');
  }
  unresolved([text('正在开发中'), br(), link('Github', source)], 'missing');
  unresolved([text('露出拓展'), br(), text('正在开发中'), br(), link('Github', gh)]);
});

test('边界与忽略标签列表由 API 冻结共享，DOM 忽略其文本', () => {
  assert.equal(Object.isFrozen(boundaryTags), true);
  assert.equal(Object.isFrozen(ignoredTags), true);
  assert.deepEqual(boundaryTags, ['br', 'hr', 'p', 'div', 'pre', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
    'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  assert.deepEqual(ignoredTags, ['script', 'style', 'noscript']);
  const value = fromDom(dom('td', [domText('真实标题'), ...ignoredTags.map(tag => dom(tag, [domText('不属于标题')]))]));
  assert.equal(value.name, '真实标题');
});

test('缺少输入与空 DOM 返回 missing', () => {
  assert.equal(extract(null).status, 'missing');
  assert.equal(fromDom(null).status, 'missing');
});

test('浏览器和 Worker 普通脚本入口导出冻结 API，无 DOM 或网络依赖', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/javascript/modhub-wiki-title.js'), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  assert.equal(Object.isFrozen(context.modHubWikiTitle), true);
  assert.equal(Object.isFrozen(context.modHubWikiTitle.boundaryTags), true);
  assert.equal(Object.isFrozen(context.modHubWikiTitle.ignoredTags), true);
  assert.equal(context.modHubWikiTitle.extract([text('真实标题')]).name, '真实标题');
});

console.log(`共享标题核心测试全部通过，共 ${count} 项。`);
