/**
 * DOL CN Wiki 模组列表提取器
 * 数据源: https://degreesoflewditycn.miraheze.org/wiki/模组列表
 *
 * 导出:
 *   fetchModListFromWiki()       从 wiki API 获取并解析全部模组（不请求 GitHub）
 *   extractModsFromHtml(html)    从 HTML 字符串解析（不请求 GitHub）
 *   fetchModIdentities()         获取网站维护的模组身份表
 *   mergeModIdentities(mods)     将身份表合并进模组列表
 *   fetchModRelease(mod)         传入模组对象，获取其 GitHub 指定或最新 Release（带缓存）
 *   clearReleaseCache()          清空 release 缓存
 *   parseGithubReleaseTarget()   校验精确发布入口
 *   markSharedRepositories()     标记共享仓库并清除旧快照错配版本
 */

const WIKI_API = 'https://degreesoflewditycn.miraheze.org/w/api.php';
const WIKI_PAGE = '模组列表';
const IDENTITY_FILE = './mod-identities.json';
const CACHE_PREFIX = 'dol_mod_release_v2_';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
const MODHUB_RELEASE_API_BASE = 'https://dolmod-release-index.johnliao381658675.workers.dev';

// ==================== 通用工具 ====================

function cleanText(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIdentityKey(value) {
  return cleanText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value.trim()))];
}

function normalizeDependencies(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const key = id.toLowerCase();
    if (!id || seen.has(key)) return [];
    seen.add(key);
    const bootVersions = Object.fromEntries(Object.entries(item.bootVersions && typeof item.bootVersions === 'object' && !Array.isArray(item.bootVersions) ? item.bootVersions : {})
      .filter(([name, version]) => name.trim() && typeof version === 'string' && /^(?:>=|<=|>|<|\^|~)?\s*v?\d+(?:\.\d+)*$/.test(version.trim()))
      .map(([name, version]) => [name.trim(), version.trim()]));
    return [{ id, version: typeof item.version === 'string' ? item.version.trim() : '',
      ...(Object.keys(bootVersions).length ? { bootVersions } : {}) }];
  });
}

function getModDependencies(mod, identity) {
  const description = cleanText(mod?.description || '');
  const inferred = [
    ['simple-framework', /(?:^|[（(，,：:\s])依赖(?:于)?\s*(?:模组)?\s*简易框架/i],
    ['maplebirch', /(?:^|[（(，,：:\s])依赖(?:于)?\s*(?:模组)?\s*秋枫白桦框架/i],
  ].filter(([, pattern]) => pattern.test(description)).map(([id]) => ({ id }));
  return normalizeDependencies([...(identity?.dependencies || []), ...inferred]);
}

export function modHubNormalizeReleaseCompatibility(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(record => {
    const releaseTag = typeof record?.releaseTag === 'string' ? record.releaseTag.trim() : '';
    const assetName = typeof record?.assetName === 'string' ? record.assetName.trim() : '';
    const gameVersionRange = typeof record?.gameVersionRange === 'string' ? record.gameVersionRange.trim() : '';
    let evidenceUrl;
    try {
      const url = new URL(record?.evidenceUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return [];
      evidenceUrl = url.toString();
    } catch { return []; }
    const key = `${releaseTag}\n${assetName}`;
    if (!releaseTag || releaseTag.length > 200 || /[\u0000-\u001f]/u.test(releaseTag)
        || (record.assetName !== undefined && (!assetName || assetName.length > 500 || /[\\/\u0000-\u001f]/u.test(assetName)))
        || gameVersionRange.length > 200 || !/^(?:(?:>=|<=|>|<|=|\^|~)\s*)?\d+(?:\.\d+)*(?:\s*(?:&&|\|\|)\s*(?:(?:>=|<=|>|<|=|\^|~)\s*)?\d+(?:\.\d+)*)*$/.test(gameVersionRange)
        || seen.has(key)) return [];
    seen.add(key);
    return [{ releaseTag, ...(assetName ? { assetName } : {}), gameVersionRange, evidenceUrl,
      ...(Array.isArray(record.dependencies) ? { dependencies: normalizeDependencies(record.dependencies) } : {}) }];
  });
}

function getIdentityNameKeys(identity) {
  return uniqueStrings([
    identity.name,
    ...(identity.bootNames || []),
    ...(identity.aliases || []),
    ...(identity.repositories || []),
  ]).map(normalizeIdentityKey).filter(Boolean);
}

function getIdentityRepoKeys(identity) {
  return uniqueStrings(identity.repositoryKeys).map((key) => key.trim().toLowerCase()).filter(Boolean);
}

function findModIdentity(mod, identities) {
  const titleKeys = uniqueStrings([
    mod.name,
    ...String(mod.name || '').split(/[\/／|]/),
  ]).map(normalizeIdentityKey).filter(Boolean);

  const findNameMatches = (candidates) => candidates.filter((identity) => {
    const identityKeys = getIdentityNameKeys(identity);
    return titleKeys.some((key) => identityKeys.includes(key));
  });

  const repoKeys = uniqueStrings([...(mod.githubUrls || []), mod.githubUrl])
    .map(parseGithubUrl)
    .filter(Boolean)
    .map(({ owner, repo }) => `${owner}/${repo}`.toLowerCase());
  if (repoKeys.length) {
    const repoMatches = identities.filter((identity) => {
      const identityRepos = getIdentityRepoKeys(identity);
      return repoKeys.some((key) => identityRepos.includes(key));
    });
    const namedMatches = findNameMatches(repoMatches);
    return namedMatches.length === 1 ? namedMatches[0] : null;
  }
  const nameMatches = findNameMatches(identities);
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

export function mergeModIdentities(mods, catalog) {
  const identities = Array.isArray(catalog) ? catalog : catalog?.mods;
  if (!Array.isArray(mods)) throw new TypeError('模组列表必须是数组');
  if (!Array.isArray(identities)) return mods;

  return mods.map((mod) => {
    const identity = findModIdentity(mod, identities);
    if (!identity) {
      return {
        ...mod,
        identityId: null,
        canonicalName: mod.name || null,
        bootNames: [],
        aliases: [],
        repositories: [],
        repositoryKeys: [],
        category: null,
        tags: [],
        dependencies: getModDependencies(mod),
      };
    }
    return {
      ...mod,
      identityId: identity.id,
      canonicalName: identity.name || mod.name || null,
      bootNames: uniqueStrings(identity.bootNames),
      aliases: uniqueStrings(identity.aliases),
      repositories: uniqueStrings(identity.repositories),
      repositoryKeys: uniqueStrings(identity.repositoryKeys),
      category: typeof identity.category === 'string' ? identity.category : null,
      tags: uniqueStrings(identity.tags),
      dependencies: getModDependencies(mod, identity),
      releaseCompatibility: modHubNormalizeReleaseCompatibility(identity.releaseCompatibility),
    };
  });
}

export async function fetchModIdentities() {
  try {
    const res = await fetch(new URL(IDENTITY_FILE, import.meta.url));
    if (!res.ok) throw new Error(`身份表返回状态码: ${res.status}`);
    const catalog = await res.json();
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.mods)) {
      throw new Error('身份表格式异常');
    }
    return catalog;
  } catch (err) {
    console.warn('[DOL 模组列表] 身份表加载失败，将保留 Wiki 原始数据:', err);
    return { schemaVersion: 1, mods: [] };
  }
}

function getTablesInRange(doc, startId, endId) {
  const start = doc.getElementById(startId);
  if (!start) return [];
  const end = endId ? doc.getElementById(endId) : null;
  return Array.from(doc.querySelectorAll('table')).filter((table) => {
    const afterStart = start.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING;
    const beforeEnd =
      !end || end.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_PRECEDING;
    return afterStart && beforeEnd;
  });
}

/** 依据表头自动识别列索引 */
function getColumnIndexes(table) {
  const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
  if (!headerRow) return null;
  const headers = Array.from(headerRow.querySelectorAll('th, td'));
  if (!headers.length) return null;

  const idx = { name: -1, description: -1, author: -1, date: -1 };
  headers.forEach((cell, i) => {
    const text = cleanText(cell.textContent);
    if (idx.name === -1 && /名称|名字|标题/.test(text)) idx.name = i;
    else if (idx.description === -1 && /简介|介绍|描述/.test(text)) idx.description = i;
    else if (idx.author === -1 && /作者|制作者|制作人/.test(text)) idx.author = i;
    else if (idx.date === -1 && /更新|日期|时间/.test(text)) idx.date = i;
  });

  if (idx.name === -1) idx.name = 0;
  if (idx.description === -1) idx.description = 1;
  if (idx.author === -1) idx.author = headers.length >= 5 ? 3 : 2;
  if (idx.date === -1) idx.date = headers.length - 1;
  return idx;
}

/** 提取模组名，排除「Github / 下载 / 论坛」等功能链接 */
function extractName(td) {
  if (!td) return '';
  const utilityRegex = /github|discord|下载|论坛|链接|地址|\u2708|\u2764|→|\[.*?\]/i;
  const anchors = Array.from(td.querySelectorAll('a'));
  const nameAnchors = anchors.filter((a) => {
    const t = cleanText(a.textContent);
    return t && !utilityRegex.test(t);
  });
  if (nameAnchors.length) {
    return nameAnchors.map((a) => cleanText(a.textContent)).join('/');
  }
  const clone = td.cloneNode(true);
  clone.querySelectorAll('a').forEach((a) => {
    if (utilityRegex.test(cleanText(a.textContent))) a.remove();
  });
  return cleanText(clone.textContent);
}

/** 仅提取名称列中的 GitHub 项目链接，描述与作者中的引用不是发布源。 */
function extractGithubUrls(row) {
  const urls = [];
  row.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (parseGithubUrl(href)) {
      urls.push(href.split('#')[0]);
    }
  });
  return [...new Set(urls)];
}

/**
 * 提取该行所有「非 GitHub 的外链」
 * 排除：wiki 内部链接、miraheze 域名、图片/编辑/引用等
 */
function extractOtherUrls(row) {
  const urls = [];
  const WIKI_HOST = 'degreesoflewditycn.miraheze.org';

  row.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return; // 排除相对路径 / 锚点 / javascript:

    let u;
    try {
      u = new URL(href);
    } catch {
      return;
    }
    const host = u.hostname.toLowerCase();
    if (host === WIKI_HOST) return; // wiki 自身
    if (host.endsWith('.miraheze.org')) return; // 其他 miraheze 子域
    if (host === 'github.com' || host === 'www.github.com') return; // GitHub 已在另一处收集
    if (host === 'upload.wikimedia.org' || host === 'static.miraheze.org') return; // 图片

    urls.push(href.split('#')[0]);
  });

  return [...new Set(urls)];
}

/** 从其他链接中挑选最优的作为 fallback（优先像下载/发布页的） */
function pickBestOtherUrl(urls) {
  if (!urls || !urls.length) return null;
  const preferRe = /download|release|\/dl\/|下载|releases|baidu\.com\/p\/|pan\./i;
  return urls.find((u) => preferRe.test(u)) || urls[0];
}

/**
 * 解析「最后更新日期」列，返回 { date, version }
 */
function parseDateCell(text) {
  const result = { date: null, version: null };
  if (!text) return result;

  const dateMatch = text.match(/(\d{4})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (dateMatch) {
    result.date = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(
      dateMatch[3]
    ).padStart(2, '0')}`;
  }

  const versionMatch = text.match(/[（(]\s*[vV]?\s*([0-9][0-9A-Za-z.\-_]*)\s*[)）]/);
  if (versionMatch) result.version = versionMatch[1];

  return result;
}

// ==================== 解析模组列表（不请求 GitHub） ====================

export function extractModsFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const publicTables = getTablesInRange(doc, '公开模组', '私有模组');
  const privateTables = getTablesInRange(doc, '私有模组', '模组相关工具');
  const tables = [...publicTables, ...privateTables];

  const mods = [];

  for (const table of tables) {
    const idx = getColumnIndexes(table);
    if (!idx) continue;

    const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => {
      const tds = tr.querySelectorAll('td');
      return tds.length > 0 && !tr.querySelector('th');
    });

    for (const row of rows) {
      const tds = Array.from(row.querySelectorAll('td'));
      if (!tds.length) continue;

      const nameCell = tds[idx.name];
      const namedProjects = Array.from(nameCell?.querySelectorAll('a[href]') || []).filter((a) =>
        parseGithubUrl(a.getAttribute('href')) && cleanText(a.textContent)
        && !/github|discord|下载|论坛|链接|地址|源码|镜像|\u2708|\u2764|→|\[.*?\]/i.test(cleanText(a.textContent)));
      const projects = new Set(namedProjects.map((a) => a.getAttribute('href').replace(/\/+$/, ''))).size > 1
        ? namedProjects : [null];
      for (const project of projects) {
        const name = (project ? cleanText(project.textContent) : extractName(nameCell))
          .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0E\uFE0F\u200D]/gu, '').trim();
        const description = cleanText(tds[idx.description] ? tds[idx.description].textContent : '');
        const author =
          idx.author >= 0 && tds[idx.author] ? cleanText(tds[idx.author].textContent) : '';
        const dateText = idx.date >= 0 && tds[idx.date] ? cleanText(tds[idx.date].textContent) : '';
        const { date, version } = parseDateCell(dateText);

        const githubUrls = project ? [project.getAttribute('href')] : extractGithubUrls(nameCell);
        const githubUrl = githubUrls[0] || null;

        const otherUrls = project ? [] : extractOtherUrls(nameCell);
        const otherUrl = pickBestOtherUrl(otherUrls);

        // 状态判定：核心字段决定 Failed / 通过
        const coreMissing = [];
        if (!name) coreMissing.push('name');
        if (!githubUrl && !otherUrl) coreMissing.push('url');

        // 次要字段决定 Warning
        const secondaryMissing = [];
        if (!description) secondaryMissing.push('description');
        if (!author) secondaryMissing.push('author');
        if (!date) secondaryMissing.push('updateDate');
        if (!version) secondaryMissing.push('version');
        if (!githubUrl) secondaryMissing.push('githubUrl'); // 无 GitHub 视为次要缺失

        let status = 'Succeed';
        if (coreMissing.length > 0) status = 'Failed';
        else if (secondaryMissing.length > 0) status = 'Warning';

        const missing = [...coreMissing, ...secondaryMissing];

        mods.push({
          name: name || null,
          githubUrl,
          githubUrls,
          otherUrl,
          otherUrls,
          description: description || null,
          author: author || null,
          // 表格中的版本 / 日期（未请求 release 时的回退值）
          version: version || null,
          updateDate: date || null,
          tableVersion: version || null,
          tableUpdateDate: date || null,
          tableDateRaw: dateText || null,
          status,
          missing,
        });
      }
    }
  }

  return markSharedRepositories(mods);
}

// ==================== 从 Wiki 获取 ====================

export async function fetchModListFromWiki() {
  const params = new URLSearchParams({
    action: 'parse',
    page: WIKI_PAGE,
    format: 'json',
    prop: 'text',
    origin: '*',
  });

  const [res, identities] = await Promise.all([
    fetch(`${WIKI_API}?${params.toString()}`),
    fetchModIdentities(),
  ]);
  if (!res.ok) throw new Error(`Wiki API 错误: ${res.status}`);
  const data = await res.json();
  if (!data.parse || !data.parse.text) throw new Error('Wiki API 返回数据格式异常');

  return mergeModIdentities(extractModsFromHtml(data.parse.text['*']), identities);
}

// ==================== 缓存 ====================

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {
    /* 忽略配额错误 */
  }
}

export function clearReleaseCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

/** 按当前目录来源读取历史发布，缓存及下架检查统一交给 Worker。 */
export async function modHubFetchModReleases(mod, { page = 1, signal } = {}) {
  const id = mod?.id || mod?.identityId;
  if (!id || !Number.isSafeInteger(page) || page < 1) throw new Error('模组缺少目录身份或页码无效，请核对原始发布页');
  const params = new URLSearchParams({ id, page: String(page) });
  const response = await fetch(`${MODHUB_RELEASE_API_BASE}/mod-releases?${params}`, { cache: 'no-cache', signal });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || '历史发布暂时无法读取'), { code: payload.code, status: response.status });
  const normalizeSource = value => {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  };
  if (payload?.schemaVersion !== 1 || payload.id !== id || payload.page !== page || !Array.isArray(payload.releases)
      || normalizeSource(payload.sourceUrl) !== normalizeSource(mod.githubUrl)) {
    throw Object.assign(new Error('发布来源与当前目录不一致，请刷新目录后重试'), { code: 'RELEASE_SOURCE_CHANGED', status: 409 });
  }
  return payload;
}

// ==================== 获取 GitHub Release（按需 + 缓存） ====================

function parseGithubUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    const [owner, rawRepo] = url.pathname.split('/').filter(Boolean);
    const repo = rawRepo?.replace(/\.git$/i, '');
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

export function markSharedRepositories(mods) {
  const repoCounts = new Map();
  for (const mod of mods) {
    const repo = parseGithubUrl(mod.githubUrl);
    if (repo) {
      const key = `${repo.owner}/${repo.repo}`.toLowerCase();
      repoCounts.set(key, (repoCounts.get(key) || 0) + 1);
    }
  }
  return mods.map(mod => {
    const repo = parseGithubUrl(mod.githubUrl);
    const sharedRepository = Boolean(mod.sharedRepository || (!!repo && repoCounts.get(`${repo.owner}/${repo.repo}`.toLowerCase()) > 1));
    const target = parseGithubReleaseTarget(mod.githubUrl);
    const unscopedVersion = mod.versionSource === 'github' && mod.githubUrl && (!target || (sharedRepository && !target.tag));
    return { ...mod, sharedRepository, ...(unscopedVersion ? {
      version: mod.wikiVersion || mod.tableVersion || null, versionLabel: null, versionSource: 'wiki',
      updateDate: mod.wikiDate || mod.tableUpdateDate || null, updateDateSource: 'wiki', releaseUrl: null,
    } : {}) };
  });
}
// 分支、目录、文件与讨论页不能隐式跳到仓库的其他产品发布。
export function parseGithubReleaseTarget(value) {
  const repo = parseGithubUrl(value);
  if (!repo) return null;
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '');
    const tagMatch = path.match(/^\/[^/]+\/[^/]+\/releases\/tag\/(.+)$/i);
    const assetMatch = path.match(/^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/i);
    if (!tagMatch && !assetMatch && !/^\/[^/]+\/[^/]+(?:\/releases(?:\/latest)?)?$/i.test(path)) return null;
    return { ...repo, tag: decodeURIComponent(tagMatch?.[1] || assetMatch?.[1] || ''), assetName: assetMatch ? decodeURIComponent(assetMatch[2]) : null };
  } catch {
    return null;
  }
}

export function modHubIsModPackageName(name) {
  return /\.(?:zip|mod|modpack(?:\.crypt)?)$/i.test(name || '')
    && !/(?:^|[\s._-])(?:source(?:[\s._-]*code)?|src|apk|outdated?|obsolete)(?=[\s._-]|$)|源码|整合包|过时版/i.test(name || '');
}

function pickDownloadAsset(assets) {
  if (!assets || !assets.length) return null;
  const prefer = [/\.zip$/i, /\.mod$/i, /\.modpack$/i, /\.modpack\.crypt$/i];
  for (const re of prefer) {
    const found = assets.filter((a) => re.test(a.name));
    if (found.length) return found.length === 1 ? found[0] : null;
  }
  return null;
}

// 与 Mod 端保持一致，只按完整产品系列匹配，避免主包、扩展与依赖之间的子串误认。
function getAssetSeries(name) {
  return String(name || '').replace(/\.(?:zip|mod|modpack(?:\.crypt)?)$/ig, '')
    .replace(/(?:for[\s._-]*)?dol[\s._-]*v?\d+(?:\.\d+)+/ig, '')
    .replace(/(?:version|ver|v)?\d+(?:\.\d+)+/ig, '')
    .replace(/(?:^|[\s._-])build[\s._-]*\d+/ig, '')
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').replace(/(?:mod)+$/, '');
}

function matchesAssetIdentity(asset, mod) {
  const series = getAssetSeries(String(asset.name || '').replace(/(?:^|[\s._-])(?:desktop|windows|pc|mobile|android|english|chinese|chs|cht|cn|en|zh)(?=[\s._-]|$)/ig, ''));
  return [...(mod?.bootNames || []), ...(mod?.aliases || []), mod?.name].some(name => {
    const identity = getAssetSeries(name);
    return identity.length >= 3 && identity === series;
  });
}

function rateLimitError(res) {
  const reset = res.headers.get('X-RateLimit-Reset');
  const retryAfter = res.headers.get('Retry-After');
  const err = new Error('RATE_LIMITED');
  err.code = 'RATE_LIMITED';
  err.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
  err.resetAt = reset ? parseInt(reset, 10) * 1000 : null;
  return err;
}

/**
 * 获取模组的 GitHub 指定或最新 Release（带 localStorage 缓存，不使用 Token）
 * @param {object} mod 模组对象（需要 githubUrl）
 * @param {object} [options]
 * @param {boolean} [options.useCache=true] 是否使用缓存
 */
export async function fetchModRelease(mod, options = {}) {
  const { useCache = true } = options;

  if (!mod || !mod.githubUrl) throw new Error('模组缺少 GitHub 链接');
  const parsed = parseGithubReleaseTarget(mod.githubUrl);
  if (!parsed) throw new Error('该链接未指定模组发布页，请前往原始主页下载');

  const sharedRepository = !!mod.sharedRepository && !parsed.tag;
  const releasePath = parsed.tag ? `tags/${encodeURIComponent(parsed.tag)}` : 'latest';
  const cacheKey = `${CACHE_PREFIX}${parsed.owner}/${parsed.repo}/${releasePath}/${encodeURIComponent(parsed.assetName || '')}/${encodeURIComponent(JSON.stringify([mod.identityId || mod.id || mod.name || '', sharedRepository, mod.bootNames || [], mod.aliases || [], 'modpack-v1']))}`;

  if (useCache) {
    const cached = readCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  const headers = { Accept: 'application/vnd.github+json' };
  const baseUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

  const latestRes = await fetch(sharedRepository ? `${baseUrl}/releases?per_page=100` : `${baseUrl}/releases/${releasePath}`, { headers });
  if (latestRes.status === 429 || latestRes.status === 403) throw rateLimitError(latestRes);

  let releaseData = null;

  if (latestRes.status === 404 && !parsed.tag && !sharedRepository) {
    const listRes = await fetch(`${baseUrl}/releases?per_page=1`, { headers });
    if (listRes.status === 429 || listRes.status === 403) throw rateLimitError(listRes);
    if (!listRes.ok) throw new Error(`GitHub API 错误: ${listRes.status}`);
    const list = await listRes.json();
    if (!Array.isArray(list) || !list.length) throw new Error('该仓库没有 Release');
    releaseData = list[0];
  } else if (!latestRes.ok) {
    throw new Error(`GitHub API 错误: ${latestRes.status}`);
  } else {
    releaseData = await latestRes.json();
  }

  if (sharedRepository) {
    // ponytail: 最多检索最近 100 个发布，无可信匹配时转作者主页，确有需求再增加分页。
    releaseData = (Array.isArray(releaseData) ? releaseData : []).filter(release => !release.draft && !release.prerelease
      && (release.assets || []).some(asset => modHubIsModPackageName(asset.name) && matchesAssetIdentity(asset, mod)))
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
    if (!releaseData) throw new Error('共享仓库中未找到当前模组的发布，请前往原始主页核对');
  }
  if (parsed.tag && releaseData.tag_name !== parsed.tag) throw new Error('返回的 Release 标签与模组来源不一致');
  const assets = (releaseData.assets || []).filter((a) => modHubIsModPackageName(a.name) && (!parsed.assetName || a.name === parsed.assetName)
    && (!sharedRepository || matchesAssetIdentity(a, mod))).map((a) => ({
    name: a.name,
    size: a.size,
    contentType: a.content_type,
    downloadUrl: a.browser_download_url,
  }));
  if (parsed.assetName && !assets.length) throw new Error('指定的模组附件不存在');
  const best = pickDownloadAsset(assets);

  const assetVersions = String(best?.name || '').match(/\d+(?:\.\d+)+/g) || [];
  const gameVersion = String(best?.name || '').match(/(?:^|[\s_.-])(?:for[\s._-]*)?dol[\s._-]*v?(0\.\d+\.\d+(?:\.\d+)?)(?=[\s_.-]|$)/i)?.[1]
    || (assetVersions.length > 1 ? assetVersions.find(version => /^0\.5\.\d+(?:\.\d+)?$/.test(version)) : '');
  const assetVersion = String(best?.name || '').replace(gameVersion || '', '').match(/\d+(?:\.\d+)+/)?.[0];
  const version = sharedRepository ? assetVersion || mod.wikiVersion || mod.tableVersion || null : releaseData.tag_name || mod.version || null;
  const updateDate = releaseData.published_at
    ? releaseData.published_at.slice(0, 10)
    : mod.updateDate || null;

  const release = {
    tagName: releaseData.tag_name || null,
    releaseName: releaseData.name || null,
    htmlUrl: releaseData.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/releases/${releaseData.tag_name ? `tag/${encodeURIComponent(releaseData.tag_name)}` : 'latest'}`,
    publishedAt: releaseData.published_at || null,
    prerelease: !!releaseData.prerelease,
    assetName: best ? best.name : null,
    assetUrl: best ? best.downloadUrl : null,
    assets,
    version,
    updateDate,
    repoUrl: mod.githubUrl,
  };

  if (useCache) writeCache(cacheKey, release);
  return release;
}
