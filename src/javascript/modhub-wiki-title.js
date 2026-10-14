(function (root) {
  'use strict';

  // Worker、目录提取器和浏览器回退只共享标题规则，不修改来源或安装身份。
  const boundaryTags = Object.freeze(['br', 'hr', 'p', 'div', 'pre', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
    'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const ignoredTags = Object.freeze(['script', 'style', 'noscript']);
  const symbols = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0E\uFE0F\u200D]/gu;
  const legacyUtility = /github|discord|下载|论坛|链接|地址|\u2708|\u2764|\u2192|\[.*?\]/i;
  const sourceLabel = /^(?:git\s*hub|gh|源码|源代码|源碼|仓库|代码仓库|repo(?:sitory)?|source(?:\s+code)?|release(?:s)?|发布(?:页|页面)?|下载(?:页|页面|链接|地址)?|download(?:s)?|官网|官方网站|官方网页|项目(?:页面|主页)|(?:旧|新)?主页|网址|地址|链接|link|website|网页|论坛(?:地址|链接|帖子)?|forum|镜像(?:下载)?|点击(?:下载|查看)|直链)$/i;
  const contactLabel = /^(?:qq(?:\s*群|\s*频道)?|q群|企鹅群|交流群|交流(?:群|频道)|群聊|群组|群号|qq群号|联系方式|联系作者|联系我们|百度贴吧|贴吧|tieba|discord(?:\s*server|\s*服务器|\s*群)?|dc|telegram|tg)$/i;
  const contextPrefix = /^(?:github|源码|源代码|仓库|下载(?:链接|地址)?|发布(?:页|页面)?|网址|链接|联系(?:方式|我们)?|qq(?:群|频道|号)?|q群|交流群|群号|discord|dc|百度贴吧|贴吧)\s*[:：]/i;
  const numericContact = /(?:qq(?:群|频道|号)?|q群|企鹅群|交流群|qq群号|群号)\s*[:：#]?\s*\d{5,12}(?:\s*[(（][^()（）]*[)）])?/i;
  const inviteContact = /(?:discord|dc|telegram|tg|qq(?:群|频道)?)\s*[:：]\s*(?:https?:\/\/\S+|[a-z0-9_-]{3,})/i;
  const bareContactUrl = /^https?:\/\/(?:[^/]+\.)?(?:discord\.gg|discord\.com|qq\.com|telegram\.me|t\.me)\//i;
  const separator = /^(?:[\s/&|,，、;；:：()（）\[\]【】{}<>·+\-]|and|与|和|及)*$/i;
  const developmentSource = 'anlinstudio/degrees-of-lewdity-myexhibitionismexpansion';

  function cleanLegacy(value) {
    return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ').trim();
  }

  function clean(value) {
    return cleanLegacy(value).replace(symbols, '').trim();
  }

  function label(value) {
    let text = clean(value).normalize('NFKC').replace(/^[\s\u2190-\u21ff]+|[\s\u2190-\u21ff]+$/g, '')
      .replace(/[:：]\s*$/, '').trim();
    // 只解开完整的功能标签括号，保留真实标题中的括号与子串。
    while (/^(?:\[.*\]|\(.*\)|（.*）|【.*】)$/.test(text)) text = text.slice(1, -1).trim();
    return text;
  }

  function isUtilityName(value) {
    const text = label(value);
    if (!text) return false;
    if (sourceLabel.test(text) || contactLabel.test(text) || /^https?:\/\/\S+$/i.test(text)) return true;
    if ([numericContact, inviteContact].some(pattern => pattern.test(text) && !residual(text.replace(pattern, ''), true))) return true;
    const parts = text.split(/\s*[/|·,，、;；]\s*/);
    return parts.length > 1 && parts.every(part => isUtilityName(part));
  }

  function role(link) {
    const text = label(link.text);
    try {
      const url = new URL(link.href);
      const host = url.hostname.toLowerCase();
      // 邀请入口的用途由 URL 确定，标签改成任意文案也不能成为模组标题。
      if (/^https?:$/.test(url.protocol) && (/^(?:www\.)?discord\.gg$/.test(host)
        || /^(?:www\.)?discord(?:app)?\.com$/.test(host) && /^\/invite(?:\/|$)/i.test(url.pathname)
        || /^(?:qm|jq)\.qq\.com$/.test(host)
        || host === 'qun.qq.com' && /^\/(?:join|cgi-bin\/qm\/qr|qqweb\/qunpro\/share)(?:\/|$)/i.test(url.pathname)
        || /^(?:t\.me|telegram\.me)$/.test(host) && /^\/(?:joinchat(?:\/|$)|\+)/i.test(url.pathname))) return 'contact';
      const knownContact = /(?:^|\.)(?:qq\.com|discord\.com|discord\.gg|tieba\.baidu\.com|t\.me|telegram\.me)$/.test(host);
      const urlLabel = text.replace(/\/$/, '') === String(link.href || '').replace(/\/$/, '');
      if (knownContact && (urlLabel || /^(?:加入|点击加入|加入群聊|加入交流群|联系我们|联系作者|加群|进群|join(?:\s+us)?)$/i.test(text))) return 'contact';
      if (urlLabel || /^(?:https?:\/\/|www\.)/i.test(text)) return 'source';
    } catch {
      // 相对链接可以承载真实标题，不根据无效 URL 猜测其角色。
    }
    if (sourceLabel.test(text)) return 'source';
    if (contactLabel.test(text) || numericContact.test(text) && !clean(text.replace(numericContact, ''))) return 'contact';
    if (isUtilityName(text)) return 'source';
    return 'title';
  }

  function legacyName(tokens) {
    const links = tokens.filter(token => token?.type === 'link');
    const useful = links.filter(link => cleanLegacy(link.text) && !legacyUtility.test(cleanLegacy(link.text)));
    let text = useful.map(link => cleanLegacy(link.text)).join('/');
    if (!text) {
      text = tokens.map(token => token?.type === 'break' ? '' : String(token?.text || '')).join('');
      for (const link of links) if (legacyUtility.test(cleanLegacy(link.text))) text = text.replace(String(link.text || ''), '');
    }
    return clean(text);
  }

  function htmlTitleTokens(tokens) {
    const merged = [];
    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue;
      const previous = merged.at(-1);
      if (token.type === 'text' && previous?.type === 'text') {
        previous.text += String(token.text || '');
      } else {
        merged.push({ ...token, ...(token.type === 'text' || token.type === 'link' ? { text: String(token.text || '') } : {}) });
      }
    }
    // HTMLRewriter 保留这些原始实体；DOM 已解码文本不进入此适配。
    const decode = value => value.replace(/&#(?:x([0-9a-f]+)|(\d+));|&nbsp;/gi, (match, hex, decimal) => {
      if (!hex && !decimal) return '\u00a0';
      const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : '\ufffd';
    });
    return merged.map(token => token.type === 'text' || token.type === 'link' ? { ...token, text: decode(token.text) } : token);
  }

  function linesFrom(tokens) {
    const lines = [[]];
    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue;
      if (token.type === 'break') {
        lines.push([]);
      } else if (token.type === 'link') {
        lines.at(-1).push({ type: 'link', text: String(token.text || ''), href: String(token.href || '') });
      } else if (token.type === 'text') {
        // HTML 文本节点中的源码换行渲染为空白，只有显式结构 token 才分段。
        lines.at(-1).push({ type: 'text', text: String(token.text || '') });
      }
    }
    return lines;
  }

  function residual(value, removedUtility) {
    let text = clean(value).replace(/\(\s*\)|（\s*）|\[\s*\]|【\s*】/g, '').trim();
    if (separator.test(text)) return '';
    if (removedUtility) text = text.replace(/^[\s/|,，;；:：]+|[\s/|,，;；:：]+$/g, '').trim();
    return text;
  }

  function withoutContactSuffix(value, contacts) {
    let text = value;
    for (const pattern of [numericContact, inviteContact]) {
      const match = text.match(pattern);
      const suffix = match && text.slice(match.index + match[0].length);
      if (match && !residual(suffix, true)) {
        if (contacts) contacts.push({ text: clean(match[0]), href: '' });
        text = text.slice(0, match.index);
        if (/^\s*[)）]\s*$/.test(suffix)) text = text.replace(/\s*[(（]\s*$/, '');
      }
    }
    return text;
  }

  function githubSource(href) {
    try {
      const url = new URL(href);
      if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      const owner = parts[0], repo = parts[1]?.replace(/\.git$/i, '');
      if (!owner || !repo) return null;
      const repoKey = `${owner}/${repo}`.toLowerCase();
      const tail = parts.slice(2).join('/');
      return { repoKey, exactKey: `${repoKey}/${tail}`, fixed: /^releases\/(?:tag\/[^/]+|download\/[^/]+\/[^/]+)$/.test(tail) };
    } catch {
      return null;
    }
  }

  function nameKey(value) {
    return clean(value).normalize('NFKC').toLowerCase();
  }

  function hasDevelopmentSource(urls) {
    const sources = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search
          ? githubSource(value) : null;
      } catch { return null; }
    });
    return sources.length > 0 && sources.every(source => source?.exactKey === `${developmentSource}/`);
  }

  function isStatusName(value, urls) {
    return clean(value) === '正在开发中' && hasDevelopmentSource(urls);
  }

  function normalizeStatusTitle(value, urls) {
    // 仅核对真实名称列与已确认作者来源，不从简介或状态标签推断模组名。
    return hasDevelopmentSource(urls) && /^(?:露出拓展|露出拓展\s+正在开发中)$/.test(clean(value)) ? '露出拓展' : '';
  }

  function projectNameKey(value) {
    // 版本只参与判断是否为同一名称，不改写显示标题或精确来源。
    return nameKey(value).replace(/(?:\s+|[-_·(（]+)(?:v\d+(?:\.\d+)*|\d+(?:\.\d+)+)(?:[-+][a-z0-9._-]+)?[)）]?$/i, '').trim();
  }

  function independentProjects(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
      if (!candidate.href || !githubSource(candidate.href)) return [];
      const key = nameKey(candidate.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    }
    if (groups.size < 2 || new Set([...groups.keys()].map(projectNameKey)).size !== groups.size) return [];
    const projects = [];
    for (const group of groups.values()) {
      const sources = group.map(item => githubSource(item.href));
      if (new Set(sources.map(source => source.repoKey)).size !== 1) return [];
      projects.push({ candidate: group[0], source: sources[0], sources });
    }
    for (let index = 0; index < projects.length; index += 1) {
      for (let other = index + 1; other < projects.length; other += 1) {
        const left = projects[index], right = projects[other];
        if (left.source.repoKey !== right.source.repoKey) continue;
        // 同仓库的两个名字需要各自明确的固定标签或附件，通用仓库入口不能证明两个项目。
        if ([...left.sources, ...right.sources].some(source => !source.fixed)
          || left.sources.some(a => right.sources.some(b => a.exactKey === b.exactKey))) return [];
      }
    }
    return projects.map(({ candidate }) => ({ name: candidate.name, href: candidate.href, legacyName: clean(candidate.rawName) }));
  }

  function extract(input, options) {
    const tokens = Array.isArray(input) ? input : [];
    const result = { name: '', status: 'missing', projects: [], legacyName: legacyName(tokens), contacts: [] };
    const candidates = [];
    const githubUrls = tokens.filter(token => token?.type === 'link' && githubSource(token.href)).map(token => token.href);
    let removedStatus = false;
    let uncertain = false;
    for (const line of linesFrom(options?.htmlEncoded === true ? htmlTitleTokens(tokens) : tokens)) {
      const fullText = clean(line.map(token => token.text).join(''));
      if (!fullText || separator.test(fullText)) continue;
      if (isStatusName(fullText, githubUrls)) {
        removedStatus = true;
        continue;
      }
      const fullLabel = label(fullText);
      const pureContact = contactLabel.test(fullLabel) || bareContactUrl.test(fullText)
        || numericContact.test(fullText) && !residual(fullText.replace(numericContact, ''), true)
        || inviteContact.test(fullText) && !residual(fullText.replace(inviteContact, ''), true);
      if (pureContact || contextPrefix.test(fullText)) {
        result.contacts.push({ text: fullText, href: line.find(token => token.type === 'link')?.href || '' });
        continue;
      }
      if (isUtilityName(fullText)) continue;
      let removedUtility = false;
      const pieces = [];
      for (const token of line) {
        const tokenRole = token.type === 'link' ? role(token) : 'title';
        if (tokenRole !== 'title') {
          removedUtility = true;
          if (tokenRole === 'contact') result.contacts.push({ text: clean(token.text), href: token.href });
        } else {
          pieces.push(token);
        }
      }
      // 仅删除明确的号码或邀请格式；例如“QQ 互动增强”仍是完整标题。
      const joined = pieces.map(token => token.text).join('');
      const content = withoutContactSuffix(joined, result.contacts);
      removedUtility ||= content !== joined;
      const name = residual(content, removedUtility);
      if (!name || sourceLabel.test(label(name)) || contactLabel.test(label(name))) continue;
      const links = pieces.filter(token => token.type === 'link' && clean(token.text));
      const plain = residual(withoutContactSuffix(pieces.filter(token => token.type === 'text').map(token => token.text).join('')), removedUtility);
      if (links.length > 1) {
        if (plain) {
          // 多个具名链接夹杂独立说明时，无法证明哪一部分是标题。
          uncertain = true;
        } else {
          for (const link of links) candidates.push({ name: clean(link.text), rawName: link.text, href: link.href });
        }
      } else {
        const wholeLink = links.length === 1 && !plain && name === clean(links[0].text);
        candidates.push({ name, rawName: wholeLink ? links[0].text : name, href: wholeLink ? links[0].href : '' });
      }
    }
    const names = new Set(candidates.map(candidate => nameKey(candidate.name)));
    if (uncertain || names.size > 1) {
      result.status = 'ambiguous';
      if (!uncertain) result.projects = independentProjects(candidates);
      // 已明确拆成独立项目时整体解析成功，但不虚构一个合并名称。
      if (result.projects.length > 1) result.status = 'resolved';
    } else if (names.size === 1) {
      result.name = candidates[0].name;
      result.status = 'resolved';
      if (removedStatus && normalizeStatusTitle(result.name, githubUrls)) result.legacyName = '正在开发中';
    }
    return result;
  }

  function fromDom(cell) {
    const tokens = [];
    function walk(node) {
      if (node?.nodeType === 3) {
        tokens.push({ type: 'text', text: node.nodeValue ?? node.textContent ?? '' });
        return;
      }
      if (!node || node.nodeType !== 1) return;
      const tag = String(node.tagName || node.nodeName || '').toLowerCase();
      if (ignoredTags.includes(tag)) return;
      if (tag === 'br' || tag === 'hr') {
        tokens.push({ type: 'break' });
      } else if (tag === 'a') {
        tokens.push({ type: 'link', text: node.textContent || '', href: node.getAttribute?.('href') || '' });
      } else {
        if (boundaryTags.includes(tag)) tokens.push({ type: 'break' });
        for (const child of Array.from(node.childNodes || [])) walk(child);
        if (boundaryTags.includes(tag)) tokens.push({ type: 'break' });
      }
    }
    for (const child of Array.from(cell?.childNodes || [])) walk(child);
    return extract(tokens);
  }

  const api = Object.freeze({ extract, fromDom, isUtilityName, isStatusName, normalizeStatusTitle, boundaryTags, ignoredTags });
  root.modHubWikiTitle = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
