/**
 * DOL CN Wiki 模组列表提取器
 * 数据源: https://degreesoflewditycn.miraheze.org/wiki/模组列表
 *
 * 导出:
 *   fetchModListFromWiki()       从 wiki API 获取并解析全部模组（不请求 GitHub）
 *   extractModsFromHtml(html)    从 HTML 字符串解析（不请求 GitHub）
 *   fetchModIdentities()         获取网站维护的模组身份表
 *   mergeModIdentities(mods)     将身份表合并进模组列表
 *   fetchModRelease(mod)         传入模组对象，获取其 GitHub 最新 Release（带缓存）
 *   clearReleaseCache()          清空 release 缓存
 */

const WIKI_API = 'https://degreesoflewditycn.miraheze.org/w/api.php';
const WIKI_PAGE = '模组列表';
const IDENTITY_FILE = './mod-identities.json';
const CACHE_PREFIX = 'dol_mod_release_v1_';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时

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
    return [{ id, version: typeof item.version === 'string' ? item.version.trim() : '' }];
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

/** 提取该行所有 GitHub 链接 */
function extractGithubUrls(row) {
  const urls = [];
  row.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\/(www\.)?github\.com\//i.test(href)) {
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

      const name = extractName(tds[idx.name]);
      const description = cleanText(tds[idx.description] ? tds[idx.description].textContent : '');
      const author =
        idx.author >= 0 && tds[idx.author] ? cleanText(tds[idx.author].textContent) : '';
      const dateText = idx.date >= 0 && tds[idx.date] ? cleanText(tds[idx.date].textContent) : '';
      const { date, version } = parseDateCell(dateText);

      const githubUrls = extractGithubUrls(row);
      const githubUrl = githubUrls[0] || null;

      const otherUrls = extractOtherUrls(row);
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

  return mods;
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

// ==================== 获取 GitHub Release（按需 + 缓存） ====================

function parseGithubUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function pickDownloadAsset(assets) {
  if (!assets || !assets.length) return null;
  const prefer = [/\.zip$/i, /\.7z$/i, /\.rar$/i, /\.mod$/i, /\.jar$/i, /\.tar\.gz$/i];
  for (const re of prefer) {
    const found = assets.find((a) => re.test(a.name));
    if (found) return found;
  }
  return assets.find((a) => a.downloadUrl) || null;
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
 * 获取模组的 GitHub 最新 Release（带 localStorage 缓存，不使用 Token）
 * @param {object} mod 模组对象（需要 githubUrl）
 * @param {object} [options]
 * @param {boolean} [options.useCache=true] 是否使用缓存
 */
export async function fetchModRelease(mod, options = {}) {
  const { useCache = true } = options;

  if (!mod || !mod.githubUrl) throw new Error('模组缺少 GitHub 链接');
  const parsed = parseGithubUrl(mod.githubUrl);
  if (!parsed) throw new Error('无法解析 GitHub 链接');

  const cacheKey = `${CACHE_PREFIX}${parsed.owner}/${parsed.repo}`;

  if (useCache) {
    const cached = readCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  const headers = { Accept: 'application/vnd.github+json' };
  const baseUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

  const latestRes = await fetch(`${baseUrl}/releases/latest`, { headers });
  if (latestRes.status === 429 || latestRes.status === 403) throw rateLimitError(latestRes);

  let releaseData = null;

  if (latestRes.status === 404) {
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

  const assets = (releaseData.assets || []).map((a) => ({
    name: a.name,
    size: a.size,
    contentType: a.content_type,
    downloadUrl: a.browser_download_url,
  }));
  const best = pickDownloadAsset(assets);

  const version = releaseData.tag_name || mod.version || null;
  const updateDate = releaseData.published_at
    ? releaseData.published_at.slice(0, 10)
    : mod.updateDate || null;

  const release = {
    tagName: releaseData.tag_name || null,
    releaseName: releaseData.name || null,
    htmlUrl: releaseData.html_url || `${mod.githubUrl}/releases/latest`,
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
