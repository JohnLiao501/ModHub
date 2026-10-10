/** ModHub 历史发布、游戏版本匹配与候选排序。 */
(function() {
    'use strict';

    const MODHUB_HISTORY_CACHE_PREFIX = 'modhub_market_history_v1_';
    const MODHUB_HISTORY_CACHE_TTL = 6 * 60 * 60 * 1000;
    const MODHUB_HISTORY_GENERATIONS = new Map();
    const MODHUB_RELEASE_DATE_LABEL_PATTERN = /^(?:[a-z][a-z_-]*)?(?:19|20)\d{2}[-._]?(?:0?[1-9]|1[0-2])[-._]?(?:0?[1-9]|[12]\d|3[01])(?:[-+][a-z0-9][a-z0-9.-]*)?$/i;
    // Worker 的上游查询最多等待 15 秒，为往返与目录核验保留时间。
    const MODHUB_HISTORY_TIMEOUT = 20000;

    function formatReleaseDate(publishedAt) {
        const time = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN;
        return Number.isFinite(time) ? new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
    }

    function normalizeGameVersion(value) {
        if (typeof value !== 'string') return '';
        const match = value.trim().match(/^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/i);
        if (!match) return '';
        const parts = match[1].split('.').map(Number);
        return parts.every(Number.isSafeInteger) ? parts.join('.') : '';
    }

    function getGameVersion() {
        return normalizeGameVersion(window.StartConfig?.version);
    }

    function isNativeRangeSyntaxSupported(range) {
        return range.trim().split('||').every(clause => {
            const bounds = clause.trim().split('&&');
            return bounds.length <= 2 && bounds.every(bound => {
                const match = bound.trim().match(/^(?:>=|<=|>|<|=|\^)?(\d+(?:\.\d+)*)(?:-[0-9a-z][0-9a-z.-]*)?(?:\+[0-9a-z][0-9a-z.-]*)?$/i);
                return Boolean(match && match[1].split('.').every(part => Number.isSafeInteger(Number(part))));
            });
        });
    }

    /** 只翻译加载器实际解析出的范围，不改变比较或猜测不支持的语法。 */
    function formatVersionRange(range) {
        const text = typeof range === 'string' ? range.trim() : '';
        if (!text) return '版本要求未声明';
        if (text === '*') return '任意版本';
        const manual = () => `版本要求需手动确认（作者原始写法：${text}）`;
        if (!isNativeRangeSyntaxSupported(text)) return manual();
        try {
            const parsed = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.()?.parseRange?.(text);
            if (!Array.isArray(parsed) || parsed.length !== text.split('||').length) return manual();
            const versionText = value => {
                if (!Array.isArray(value?.version) || !value.version.length || !value.version.every(part => Number.isSafeInteger(part) && part >= 0)) return '';
                const parts = [...value.version];
                while (parts.length < 3) parts.push(0);
                return parts.join('.') + (value.preRelease ? `-${value.preRelease}` : '') + (value.buildMetadata ? `+${value.buildMetadata}` : '');
            };
            const words = { '>=': version => `${version}及以上`, '>': version => `高于${version}`, '<=': version => `不高于${version}`, '<': version => `低于${version}` };
            const clauses = parsed.map(bounds => {
                const lower = bounds.lower ? versionText(bounds.lower.version) : '', upper = bounds.upper ? versionText(bounds.upper.version) : '';
                if ((bounds.lower && !lower) || (bounds.upper && !upper)) return '';
                if (lower && lower === upper && bounds.lower.operator === '>=' && bounds.upper.operator === '<=') return `仅限${lower}`;
                const descriptions = [bounds.lower, bounds.upper].filter(Boolean).map(bound => words[bound.operator]?.(versionText(bound.version)) || '');
                return descriptions.length && descriptions.every(Boolean) ? descriptions.join('，') : '';
            });
            if (clauses.some(clause => !clause)) return manual();
            return clauses.length === 1 ? clauses[0] : clauses.map(clause => `（${clause}）`).join('或者');
        } catch (_) { return manual(); }
    }

    /** 只按原生范围判断版本；未知结果不能解释为版本不符。调用方先确认提供者存在。 */
    function assessVersionRange(version, range, ignorePostfix = false) {
        const unknown = reason => ({ status: 'unknown', reason });
        if (range == null || typeof range === 'string' && (!range.trim() || range.trim() === '*')) {
            return { status: 'compatible', reason: '未声明版本限制，仅核对提供者是否存在' };
        }
        const current = typeof version === 'string' ? version.trim().replace(/^v(?=\d)/i, '') : '';
        const match = current.match(/^(\d+(?:\.\d+)*)(?:-[0-9a-z][0-9a-z.-]*)?(?:\+[0-9a-z][0-9a-z.-]*)?$/i);
        if (!match || !match[1].split('.').every(part => Number.isSafeInteger(Number(part)))) return unknown('当前版本未能识别');
        // 原生范围使用 && 和 ||；完整验证，避免宽松解析器把不支持的尾部当成有效声明。
        if (typeof range !== 'string' || !isNativeRangeSyntaxSupported(range)) return unknown('暂不能识别版本要求');
        const clauses = range.trim().split('||');
        try {
            const api = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.();
            if (!api?.parseVersion || !api?.parseRange || !api?.satisfies) return unknown('当前 ModLoader 未提供版本核对接口');
            const parsedVersion = api.parseVersion(current)?.version;
            const parsedRange = api.parseRange(range.trim());
            if (!parsedVersion?.version?.length || !Array.isArray(parsedRange) || parsedRange.length !== clauses.length) return unknown('暂不能解析版本要求');
            const compatible = api.satisfies(parsedVersion, parsedRange, ignorePostfix);
            if (typeof compatible !== 'boolean') return unknown('当前 ModLoader 未能确定版本是否满足要求');
            return { status: compatible ? 'compatible' : 'incompatible', reason: compatible
                ? `当前版本 ${current} 满足作者声明的版本要求 ${range.trim()}`
                : `当前版本 ${current} 不满足作者声明的版本要求 ${range.trim()}` };
        } catch (_) {
            return unknown('暂不能解析版本要求');
        }
    }

    function assessCompatibility(range, gameVersion = getGameVersion()) {
        const unknown = reason => ({ status: 'unknown', reason });
        const version = normalizeGameVersion(gameVersion);
        if (!version) return unknown('当前游戏版本未能识别，请按作者说明选择安装包');
        if (typeof range !== 'string' || !range.trim()) return unknown('适用的游戏版本尚未确定，下一步会核对安装包中的说明');
        if (!isNativeRangeSyntaxSupported(range)) return unknown('暂不能识别作者的游戏版本说明，请查看发布说明');
        const result = assessVersionRange(version, range, true);
        if (result.status === 'unknown') {
            const reasons = {
                '当前 ModLoader 未提供版本核对接口': '当前 ModLoader 无法核对作者的游戏版本范围，请查看作者说明',
                '当前 ModLoader 未能确定版本是否满足要求': '当前 ModLoader 未能确定该版本是否适用，请查看作者说明'
            };
            return unknown(reasons[result.reason] || '暂不能核对作者的游戏版本说明，请查看发布说明');
        }
        return { status: result.status, reason: result.status === 'compatible'
            ? `作者声明的支持范围包含当前 DoL ${version}；下一步会核对所选安装包`
            : `作者声明支持 DoL ${formatVersionRange(range)}，当前游戏为 DoL ${version}，不在此范围内` };
    }

    function normalizeSource(value) {
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password) return '';
            url.hash = '';
            url.pathname = url.pathname.replace(/\/+$/, '') || '/';
            return url.toString();
        } catch (_) { return ''; }
    }

    function historyError(message, code, status) {
        const error = new Error(message);
        error.code = code;
        if (status) error.status = status;
        return error;
    }

    function unsafeHistoryError(error) {
        return ['INVALID_RELEASE_REQUEST', 'RELEASE_PAGE_UNAVAILABLE', 'MOD_RELEASES_UNAVAILABLE', 'MANUAL_SOURCE', 'RELEASE_NOT_FOUND', 'RELEASE_SOURCE_CHANGED', 'RELEASE_RESPONSE_INVALID', 'CATALOG_UNAVAILABLE'].includes(error?.code)
            || [400, 401, 403, 404, 409].includes(error?.status)
            || error?.status === 503 && error?.code !== 'RELEASE_UPSTREAM_FAILED';
    }

    /** 同一服务、条目和发布来源的全部历史页失效，兼容旧签名字段。 */
    function invalidateHistoryFamily(family, cacheKey) {
        const familyKey = JSON.stringify(family);
        MODHUB_HISTORY_GENERATIONS.set(familyKey, (MODHUB_HISTORY_GENERATIONS.get(familyKey) || 0) + 1);
        const keys = new Set([cacheKey]);
        try {
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                if (!key?.startsWith(MODHUB_HISTORY_CACHE_PREFIX)) continue;
                try {
                    const signature = JSON.parse(decodeURIComponent(key.slice(MODHUB_HISTORY_CACHE_PREFIX.length)));
                    if (Array.isArray(signature) && signature[0] === family[0] && signature[1] === family[1]
                        && normalizeSource(signature[2]) === family[2]) keys.add(key);
                } catch (_) {}
            }
        } catch (_) {}
        for (const key of keys) { try { localStorage.removeItem(key); } catch (_) {} }
    }

    /** 中文主状态与原始诊断分开，兼容旧服务端和未知错误代码。 */
    function getHistoryErrorInfo(error) {
        const raw = typeof error?.message === 'string' ? error.message.trim() : '';
        const messages = {
            ABORT_ERR: '已取消获取历史版本',
            RELEASE_TIMEOUT: '版本列表读取超时，请重试版本列表',
            RELEASE_UPSTREAM_TIMEOUT: '历史发布服务响应超时，请稍后重试版本列表',
            RELEASE_REQUEST_LIMITED: '版本列表请求过于频繁，请稍后重试',
            RELEASE_RATE_LIMITED: '作者发布服务暂时限制请求，请稍后重试',
            RELEASE_UPSTREAM_DENIED: '作者发布服务拒绝了请求，请稍后重试或查看作者主页',
            RELEASE_UPSTREAM_FAILED: '历史发布服务暂不可用，请稍后重试',
            CATALOG_UNAVAILABLE: '暂时无法核验模组目录，请稍后重试',
            INVALID_RELEASE_REQUEST: '无法识别模组历史发布请求',
            RELEASE_PAGE_UNAVAILABLE: '暂时无法核验所请求的历史页，请刷新版本列表',
            MOD_RELEASES_UNAVAILABLE: '该模组来源已撤回，请刷新市场',
            MANUAL_SOURCE: '该模组未获准自动安装，请前往作者主页',
            RELEASE_NOT_FOUND: '指定发布已失效，请查看作者主页',
            RELEASE_SOURCE_CHANGED: '历史发布来源已变化，请刷新市场后重试',
            RELEASE_RESPONSE_INVALID: '历史发布数据格式异常，请稍后重试'
        };
        const message = /[\u3400-\u9fff]/.test(raw) ? raw : messages[error?.code]
            || (error?.status === 429 ? '版本列表请求暂时受限，请稍后重试' : '版本列表读取失败，请稍后重试或查看作者主页');
        const details = [];
        if (typeof error?.code === 'string' && error.code) details.push(`错误代码：${error.code}`);
        const diagnostic = error?.details && typeof error.details === 'object' ? error.details : {};
        if (diagnostic.name) details.push(`异常类型：${diagnostic.name}`);
        if (diagnostic.message) details.push(`原始错误：${diagnostic.message}`);
        else if (raw && raw !== message) details.push(`原始错误：${raw}`);
        if (error?.status) details.push(`服务响应：HTTP ${error.status}`);
        if (diagnostic.status) details.push(`上游响应：HTTP ${diagnostic.status}`);
        if (diagnostic.retryAfter) details.push(`建议等待：${diagnostic.retryAfter}`);
        if (diagnostic.rateLimitRemaining !== undefined) details.push(`上游剩余请求额度：${diagnostic.rateLimitRemaining}`);
        if (diagnostic.rateLimitReset) details.push(`上游额度重置时间：${diagnostic.rateLimitReset}`);
        return { message, details };
    }

    function responseHistoryError(failure, response, service) {
        const raw = typeof failure?.error === 'string' ? failure.error : typeof failure?.message === 'string' ? failure.message : '';
        const error = historyError(raw || `${service}暂不可用（HTTP ${response.status}）`,
            typeof failure?.code === 'string' ? failure.code : 'RELEASE_UPSTREAM_FAILED', response.status);
        const details = {};
        for (const key of ['name', 'message', 'status', 'retryAfter', 'rateLimitRemaining', 'rateLimitReset']) {
            const value = failure?.details?.[key];
            if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) details[key] = String(value).slice(0, 1000);
        }
        for (const [key, header] of [['retryAfter', 'Retry-After'], ['rateLimitRemaining', 'X-RateLimit-Remaining'], ['rateLimitReset', 'X-RateLimit-Reset']]) {
            const value = response.headers?.get?.(header);
            if (details[key] === undefined && value) details[key] = String(value).slice(0, 1000);
        }
        if (raw && !/[\u3400-\u9fff]/.test(raw) && !details.message) details.message = raw;
        error.details = details;
        error.message = getHistoryErrorInfo(error).message;
        return error;
    }

    function getReleaseSource(value) {
        try {
            const url = new URL(value);
            if (url.origin !== 'https://github.com' || url.username || url.password) return null;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length < 2 || !parts.slice(0, 2).every(part => /^[a-z0-9_.-]+$/i.test(part))) return null;
            if (parts.length > 2 && (parts[2] !== 'releases' || (parts.length > 3 && !['latest', 'tag', 'download'].includes(parts[3])))) return null;
            return { key: `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase(),
                tag: parts[2] === 'releases' && ['tag', 'download'].includes(parts[3]) ? decodeURIComponent(parts[3] === 'tag' ? parts.slice(4).join('/') : parts[4] || '') : '',
                assetName: parts[2] === 'releases' && parts[3] === 'download' ? decodeURIComponent(parts[5] || '') : '' };
        } catch (_) { return null; }
    }

    function validHistoricalRelease(release, mod, source) {
        const validDeclaration = value => value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
            && typeof value.gameVersionRange === 'string' && (!value.evidenceUrl || Boolean(normalizeSource(value.evidenceUrl))));
        if (!release || typeof release.tagName !== 'string' || !release.tagName || !Array.isArray(release.assets)
            || !validDeclaration(release.compatibility) || (release.dependencies !== undefined && !Array.isArray(release.dependencies))
            || (release.publishedAt != null && !Number.isFinite(Date.parse(release.publishedAt)))) return false;
        const rules = (Array.isArray(mod.releaseCompatibility) ? mod.releaseCompatibility : []).filter(rule => rule.releaseTag === release.tagName);
        if (source.tag && release.tagName !== source.tag && !rules.length) return false;
        return release.assets.every(asset => {
            try {
                if (!asset || typeof asset.name !== 'string' || !asset.name || !Number.isSafeInteger(asset.size) || asset.size < 0
                    || !validDeclaration(asset.compatibility) || (asset.dependencies !== undefined && !Array.isArray(asset.dependencies))) return false;
                const url = new URL(asset.downloadUrl);
                const parts = url.pathname.split('/').filter(Boolean);
                const target = getReleaseSource(asset.downloadUrl);
                if (!target || target.key !== source.key || parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download'
                    || target.tag !== release.tagName || target.assetName !== asset.name) return false;
                if (source.assetName && release.tagName === source.tag && asset.name !== source.assetName) return false;
                if (source.assetName && release.tagName !== source.tag && !rules.some(rule => (rule.assetName || source.assetName) === asset.name)) return false;
                if (source.tag && release.tagName !== source.tag && !rules.some(rule => !rule.assetName || rule.assetName === asset.name)) return false;
                return true;
            } catch (_) { return false; }
        });
    }

    async function requestHistoryJson(url, { signal, headers, timeoutMs = MODHUB_HISTORY_TIMEOUT, service = '历史发布服务' } = {}) {
        if (signal?.aborted) throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let rejectRequest;
        let responseStatus;
        const stopped = new Promise((_, reject) => { rejectRequest = reject; });
        const abort = () => {
            const error = Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
            rejectRequest(error);
            controller?.abort(error);
        };
        signal?.addEventListener?.('abort', abort, { once: true });
        const timeout = setTimeout(() => {
            const error = Object.assign(historyError(`${service}在 ${timeoutMs / 1000} 秒内未完成响应，请重试版本列表`, 'RELEASE_TIMEOUT', responseStatus), { name: 'TimeoutError' });
            rejectRequest(error);
            controller?.abort(error);
        }, timeoutMs);
        try {
            // 等待上限覆盖响应体；旧浏览器或迟到的请求也不能持续等待或写入缓存。
            return await Promise.race([stopped, (async () => {
                const response = await fetch(String(url), { signal: controller?.signal || signal, ...(headers ? { headers } : {}) });
                if (!response.ok) responseStatus = response.status;
                if (!response.ok) {
                    let failure = null;
                    try { failure = await response.json(); } catch (_) {}
                    throw responseHistoryError(failure, response, service);
                }
                try { return { data: await response.json(), response }; } catch (error) {
                    if (error?.name === 'SyntaxError') throw historyError('历史发布数据格式异常，请稍后重试', 'RELEASE_RESPONSE_INVALID');
                    throw error;
                }
            })()]);
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', abort);
        }
    }

    async function fetchGithubHistory(mod, source, page, signal, communityRevision) {
        const market = window.modHubMarket;
        const rules = Array.isArray(mod.releaseCompatibility) ? mod.releaseCompatibility : [];
        const tags = [...new Set([source.tag, ...rules.map(rule => rule.releaseTag)].filter(Boolean))];
        const selectedTags = tags.slice((page - 1) * 20, page * 20);
        const request = path => requestHistoryJson(`https://api.github.com/repos/${source.key}/releases${path}`,
            { signal, headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 10000, service: 'GitHub 历史发布服务' });
        let raw, hasMore;
        if (source.tag) {
            const responses = await Promise.all([...new Set([source.tag, ...selectedTags])].map(async tag => {
                try {
                    const { data } = await request(`/tags/${encodeURIComponent(tag)}`);
                    if (data?.tag_name !== tag) throw historyError('历史发布标签与目录来源不一致', 'RELEASE_SOURCE_CHANGED');
                    return data;
                } catch (error) {
                    if (error.status === 404 && tag !== source.tag) return null;
                    throw error;
                }
            }));
            const pinned = responses.find(release => release?.tag_name === source.tag);
            if (source.assetName && !pinned?.assets?.some(asset => asset.name === source.assetName)) throw historyError('指定模组附件已不存在，请核对作者主页', 'RELEASE_NOT_FOUND', 404);
            raw = responses.filter(release => selectedTags.includes(release?.tag_name));
            hasMore = tags.length > page * 20;
        } else {
            const { data, response } = await request(`?per_page=20&page=${page}`);
            if (!Array.isArray(data)) throw historyError('GitHub 历史发布数据格式异常，请稍后重试', 'RELEASE_RESPONSE_INVALID');
            raw = data;
            hasMore = /<[^>]+>;\s*rel="next"/.test(response.headers?.get?.('Link') || '') || raw.length === 20;
        }
        const shared = mod.sharedRepository || market.getMarketMods?.().some(item => item.id !== mod.id && getReleaseSource(item.githubUrl)?.key === source.key);
        const releases = raw.flatMap(release => {
            if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return [];
            const reviewed = rules.filter(rule => rule.releaseTag === release.tag_name);
            const general = reviewed.find(rule => !rule.assetName);
            const declaration = rule => ({ gameVersionRange: rule.gameVersionRange, evidenceUrl: rule.evidenceUrl || '' });
            const normalized = { tagName: release.tag_name, name: typeof release.name === 'string' ? release.name : release.tag_name,
                htmlUrl: `https://github.com/${source.key}/releases/tag/${encodeURIComponent(release.tag_name)}`,
                publishedAt: release.published_at || null, assets: [], ...(general ? { compatibility: declaration(general) } : {}) };
            normalized.assets = release.assets.flatMap(asset => {
                const rule = reviewed.find(item => item.assetName === asset?.name);
                const value = { name: asset?.name, size: asset?.size, downloadUrl: asset?.browser_download_url,
                    digest: typeof asset?.digest === 'string' ? asset.digest : '', ...(rule ? { compatibility: declaration(rule) } : {}),
                    ...(Array.isArray(rule?.dependencies) ? { dependencies: rule.dependencies } : {}) };
                return validHistoricalRelease({ ...normalized, assets: [value] }, mod, source) ? [value] : [];
            });
            const plan = market.buildReleaseAssetPlan(normalized.assets, '', { ...mod, sharedRepository: Boolean(shared) }, { preserveVersions: true });
            if (!plan.candidates?.length) return [];
            normalized.assets = plan.availableAssets;
            const dependencyRule = general || (normalized.assets.length === 1 && reviewed.find(rule => rule.assetName === normalized.assets[0].name));
            if (Array.isArray(dependencyRule?.dependencies)) normalized.dependencies = dependencyRule.dependencies;
            return [normalized];
        });
        return { schemaVersion: 1, id: mod.id, sourceUrl: normalizeSource(mod.githubUrl), page, hasMore, communityRevision,
            fetchedAt: new Date().toISOString(), stale: false, fromGithub: true, releases };
    }


    function buildDirectoryFallbackReleases(mod, source, page, communityRevision) {
        if (!mod || page !== 1) return null;
        const verified = mod.verifiedReleaseAsset;
        const records = Array.isArray(mod.packageRecords) ? mod.packageRecords : [];
        const targetRecord = records.find(r => r.downloadUrl || r.sourceUrl);
        const rules = Array.isArray(mod.releaseCompatibility) ? mod.releaseCompatibility : [];

        const downloadUrl = normalizeSource(verified?.sourceUrl || targetRecord?.downloadUrl || (typeof mod.downloadUrl === 'string' ? mod.downloadUrl : ''));
        const assetName = verified?.fileName || targetRecord?.fileName || (downloadUrl ? downloadUrl.split('/').pop().split('?')[0] : '');
        let tagName = verified?.tag || rules[0]?.releaseTag || source.tag || (mod.version ? ('v' + mod.version) : 'v1.0.0');

        if (!downloadUrl || !assetName) return null;

        const rule = rules.find(r => r.releaseTag === tagName && (!r.assetName || r.assetName === assetName)) || rules[0];
        const gameVersionRange = rule?.gameVersionRange || targetRecord?.gameVersionRange || '';
        const evidenceUrl = rule?.evidenceUrl || targetRecord?.evidenceUrl || downloadUrl;
        const declaration = gameVersionRange ? { gameVersionRange, evidenceUrl } : undefined;

        const asset = {
            name: source.assetName || assetName,
            size: Number(verified?.size || targetRecord?.size) || 100000,
            downloadUrl,
            digest: verified?.sha256 ? ('sha256:' + verified.sha256.toLowerCase()) : (targetRecord?.sha256 ? ('sha256:' + targetRecord.sha256.toLowerCase()) : ''),
            bootName: verified?.bootName || targetRecord?.bootName || mod.bootNames?.[0] || '',
            version: verified?.version || targetRecord?.version || mod.version || '',
            versionSource: verified ? 'verified-boot' : 'catalog',
            ...(declaration ? { compatibility: declaration } : {}),
            dependencies: Array.isArray(targetRecord?.dependencies) ? targetRecord.dependencies : Array.isArray(mod.dependencies) ? mod.dependencies : []
        };

        if (source.tag) tagName = source.tag;

        const release = {
            tagName,
            name: tagName,
            htmlUrl: mod.releaseUrl || ('https://github.com/' + source.key + '/releases/tag/' + encodeURIComponent(tagName)),
            publishedAt: verified?.verifiedAt || targetRecord?.verifiedAt || mod.updateDate || new Date().toISOString(),
            assets: [asset],
            ...(declaration ? { compatibility: declaration } : {}),
            dependencies: asset.dependencies
        };

        if (!validHistoricalRelease(release, mod, source)) return null;

        return {
            schemaVersion: 1,
            id: mod.id,
            sourceUrl: normalizeSource(mod.githubUrl),
            page: 1,
            hasMore: false,
            communityRevision,
            fetchedAt: new Date().toISOString(),
            stale: true,
            fromCache: true,
            releases: [release]
        };
    }

    async function fetchReleases(mod, { page = 1, signal, useCache = true } = {}) {
        const market = window.modHubMarket;
        if (!mod?.id || !Number.isSafeInteger(page) || page < 1) throw historyError('无法识别模组历史发布请求', 'INVALID_RELEASE_REQUEST');
        const sourceUrl = normalizeSource(mod.githubUrl);
        const source = getReleaseSource(sourceUrl);
        if (!sourceUrl || !source) throw historyError('该模组没有可用的发布来源', 'MANUAL_SOURCE');
        // 索引镜像只提供目录文件，历史接口与其他动态接口共用真实 Worker 地址。
        const base = new URL(market.RELEASE_WORKER_API_BASE);
        const communityRevision = market.getCommunityRevision?.() ?? mod.communityRevision;
        const signatureFields = [base.origin, mod.id, sourceUrl, mod.catalogSource || '', mod.autoInstall,
            mod.autoInstallScope || '', mod.revision, communityRevision, mod.identityId, mod.name,
            mod.sourceUrl, mod.releaseUrl, mod.version, mod.repositoryKeys || [], mod.releaseCompatibility || [], mod.dependencies,
            mod.bootNames || [], mod.aliases || [], mod.sharedRepository, mod.requiredDependencies || [], mod.variant || null, mod.verifiedReleaseAssets || [],
            page, 'modpack-v1', 'asset-series-v2'];
        // 登记证据、语言或强制前置变化时废弃旧候选缓存。
        if (mod.verifiedReleaseAsset) signatureFields.push(mod.verifiedReleaseAsset);
        const signature = JSON.stringify(signatureFields);
        const cacheKey = MODHUB_HISTORY_CACHE_PREFIX + encodeURIComponent(signature);
        const family = [base.origin, mod.id, sourceUrl], familyKey = JSON.stringify(family);
        const generation = MODHUB_HISTORY_GENERATIONS.get(familyKey) || 0;
        const checkCurrent = () => {
            if ((MODHUB_HISTORY_GENERATIONS.get(familyKey) || 0) !== generation) {
                throw historyError('历史发布来源的状态已更新，请重新读取版本列表', 'RELEASE_SOURCE_CHANGED', 409);
            }
        };
        const rejectUnsafe = error => {
            if (unsafeHistoryError(error)) invalidateHistoryFamily(family, cacheKey);
            throw error;
        };
        const verifyEmptyHistory = Boolean(mod.sharedRepository && mod.catalogSource !== 'community');
        if (market?.isWithdrawn?.(mod)) rejectUnsafe(historyError('该模组来源已撤回，请刷新市场', 'MOD_RELEASES_UNAVAILABLE'));
        if (mod.autoInstall === false || mod.catalogSource === 'community' && !market?.hasCommunityReleaseSource?.(mod)) rejectUnsafe(historyError('该模组未获准自动安装，请前往作者主页', 'MANUAL_SOURCE'));
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (_) {}
        const validResponse = data => data?.schemaVersion === 1 && data.id === mod.id
            && normalizeSource(data.sourceUrl) === sourceUrl && data.page === page && typeof data.hasMore === 'boolean'
            && Number.isFinite(Date.parse(data.fetchedAt)) && (data.stale === undefined || typeof data.stale === 'boolean')
            && (!Number.isSafeInteger(communityRevision) || data.communityRevision === communityRevision)
            && Array.isArray(data.releases) && data.releases.every(release => validHistoricalRelease(release, mod, source));
        if (cached?.signature !== signature || !Number.isFinite(cached?.timestamp) || !validResponse(cached?.data)) cached = null;
        if (verifyEmptyHistory && !cached?.data.releases.length) cached = null;
        if (signal?.aborted) throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
        if (useCache && cached && !cached.data.stale && Date.now() - cached.timestamp < MODHUB_HISTORY_CACHE_TTL) return { ...cached.data, fromCache: true };
        const url = new URL('/mod-releases', base.origin);
        url.searchParams.set('id', mod.id);
        url.searchParams.set('page', String(page));
        let data;
        try {
            ({ data } = await requestHistoryJson(url, { signal }));
            checkCurrent();
            if (!validResponse(data)) throw historyError('历史发布来源已变化，请刷新市场后重试', 'RELEASE_SOURCE_CHANGED');
        } catch (error) {
            if (signal?.aborted || error?.code === 'ABORT_ERR') throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
            checkCurrent();
            if (unsafeHistoryError(error)) rejectUnsafe(error);
            if (cached) return { ...cached.data, fromCache: true, stale: true };
            const fallback = buildDirectoryFallbackReleases(mod, source, page, communityRevision);
            if (mod.catalogSource === 'community') {
                if (fallback) return fallback;
                throw error;
            }
            try {
                data = await fetchGithubHistory(mod, source, page, signal, communityRevision);
                checkCurrent();
                if (!validResponse(data)) throw historyError('历史发布来源已变化，请刷新市场后重试', 'RELEASE_SOURCE_CHANGED');
            } catch (directError) {
                if (signal?.aborted || directError?.code === 'ABORT_ERR') throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
                checkCurrent();
                if (fallback) return fallback;
                rejectUnsafe(directError);
            }
        }
        // 旧服务可能按旧文件名规则漏筛；只核对已获准的原仓库，不绕过社区审核。
        if (verifyEmptyHistory && !data.fromGithub && !data.releases.length) {
            checkCurrent();
            try {
                const direct = await fetchGithubHistory(mod, source, page, signal, communityRevision);
                checkCurrent();
                if (!validResponse(direct)) throw historyError('历史发布来源已变化，请刷新市场后重试', 'RELEASE_SOURCE_CHANGED');
                if (direct.releases.length) data = direct;
            } catch (error) {
                if (signal?.aborted || error?.code === 'ABORT_ERR') throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
                checkCurrent();
                if (['RELEASE_SOURCE_CHANGED', 'MOD_RELEASES_UNAVAILABLE'].includes(error?.code)) rejectUnsafe(error);
            }
        }
        if (signal?.aborted) throw Object.assign(historyError('已取消获取历史版本', 'ABORT_ERR'), { name: 'AbortError' });
        checkCurrent();
        if (market.isWithdrawn?.(mod)) rejectUnsafe(historyError('该模组来源已撤回，请刷新市场', 'MOD_RELEASES_UNAVAILABLE'));
        const fetchedAt = Math.min(Date.now(), Date.parse(data.fetchedAt));
        data = { ...data, stale: Boolean(data.stale || Date.now() - fetchedAt >= MODHUB_HISTORY_CACHE_TTL) };
        if (!verifyEmptyHistory || data.releases.length) {
            try { localStorage.setItem(cacheKey, JSON.stringify({ signature, timestamp: data.stale ? 0 : fetchedAt, data })); } catch (_) {}
        }
        return data;
    }

    function candidateCompatibility(asset, release, gameVersion) {
        const declaration = asset.compatibility?.gameVersionRange ? asset.compatibility : release.compatibility;
        if (declaration?.gameVersionRange) return { ...assessCompatibility(declaration.gameVersionRange, gameVersion),
            gameVersion, evidence: 'declaration', gameVersionRange: declaration.gameVersionRange, evidenceUrl: declaration.evidenceUrl || '' };
        const target = normalizeGameVersion(asset.targetGameVersion || window.modHubMarket.getAssetGameVersion(asset.name));
        if (target) {
            const matches = Boolean(gameVersion && window.modHubMarket.compareVersions(target, gameVersion) === 0);
            return { status: 'unknown', evidence: 'filename', referenceMismatch: Boolean(gameVersion && !matches), gameVersion,
                targetGameVersion: target, reason: !gameVersion
                    ? `安装包名称标注支持 DoL ${target}；当前游戏版本未能识别，选择后还会核对安装包中的适配说明`
                    : matches ? `安装包名称标注支持 DoL ${target}，选择后还会核对安装包中的适配说明`
                        : `安装包名称标注支持 DoL ${target}，当前游戏为 DoL ${gameVersion}；选择后还会核对安装包中的适配说明` };
        }
        return { status: 'unknown', evidence: 'unknown', gameVersion, reason: gameVersion
            ? '适用的游戏版本尚未确定，下一步会核对安装包中的说明'
            : '当前游戏版本未能识别，请按作者说明选择；下一步会核对所选安装包' };
    }

    function getCandidateStatus(candidate, { recommended = false } = {}) {
        const info = candidate.compatibility || {};
        let label = '适配待核对', tone = 'grey';
        if (info.status === 'incompatible') {
            label = '作者支持范围不符';
            tone = 'red';
        } else if (info.status === 'compatible' && info.evidence === 'declaration') {
            label = recommended ? '推荐，作者声明适配' : '作者声明适配';
            tone = 'green';
        } else if (info.evidence === 'filename') {
            if (info.referenceMismatch) label = '名称标注其他版本';
            else if (info.gameVersion && info.targetGameVersion) {
                label = recommended ? '参考推荐' : '名称标注当前版本';
                tone = recommended ? 'gold' : 'grey';
            }
        } else if (info.evidence === 'declaration') label = '作者声明待核对';
        return { label, tone, reason: info.reason || '适用的游戏版本尚未确定，下一步会核对安装包中的说明' };
    }

    /** 仅当前精确附件、摘要、大小和身份均匹配时采用登记的真实 boot 版本。 */
    function verifiedCandidateBootVersion(mod, asset) {
        const verified = mod?.verifiedReleaseAsset;
        if (asset?.versionSource !== 'verified-boot' || !verified || typeof verified !== 'object' || Array.isArray(verified)
            || typeof verified.version !== 'string' || !verified.version.trim()
            || typeof verified.bootName !== 'string' || !verified.bootName.trim()
            || !Array.isArray(mod.bootNames) || !mod.bootNames.some(name => String(name).toLowerCase() === verified.bootName.toLowerCase())
            || !/^[a-f0-9]{64}$/i.test(verified.sha256 || '')
            || !Number.isSafeInteger(verified.size) || verified.size <= 0 || asset.size !== verified.size
            || asset.bootName !== verified.bootName || asset.version !== verified.version
            || String(asset.digest || '').toLowerCase() !== `sha256:${verified.sha256.toLowerCase()}`
            || !normalizeSource(verified.sourceUrl) || normalizeSource(asset.downloadUrl) !== normalizeSource(verified.sourceUrl)
            || normalizeSource(mod.githubUrl) !== normalizeSource(verified.sourceUrl)) return '';
        return verified.version;
    }

    /** 多产品发布的标题版号必须直接跟随本品名称，不能借用标题别处的其他产品版号。 */
    function ownedReleaseTitleVersion(title, mod) {
        const text = String(title || '').normalize('NFKC');
        const versions = new Set();
        for (const name of [...(mod?.bootNames || []), ...(mod?.aliases || []), ...(mod?.repositories || []), mod?.name]) {
            const identity = String(name || '').trim().normalize('NFKC');
            if (!identity) continue;
            const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp('(?:^|[^\\p{L}\\p{N}])' + escaped
                + '[\\s._:：-]*v(\\d+(?:\\.\\d+)+)(?:-[0-9a-z][0-9a-z.-]*)?(?=$|[\\s)\\]（），,])', 'giu');
            for (const match of text.matchAll(pattern)) {
                if (!MODHUB_RELEASE_DATE_LABEL_PATTERN.test(match[1])) versions.add(match[1]);
            }
        }
        return versions.size === 1 ? [...versions][0] : '';
    }

    /** 目录强制前置独立于包体声明；空声明不能移除目录中已核验的要求。 */
    function candidateDependencies(mod, asset, release) {
        const declared = Array.isArray(asset.dependencies) ? asset.dependencies
            : Array.isArray(release.dependencies) ? release.dependencies : [];
        const required = (Array.isArray(mod.requiredDependencies) ? mod.requiredDependencies : []).flatMap(item => {
            const bootName = typeof item?.bootName === 'string' && item.bootName.trim()
                || typeof item?.modName === 'string' && item.modName.trim() || '';
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            if (!bootName && !id) return [];
            return [{ ...item, ...(bootName ? { bootName } : {}), ...(id ? { id } : {}),
                version: typeof item.version === 'string' && item.version.trim() || '*',
                required: true, source: '目录强制前置', declaredBy: mod.name }];
        });
        if (!required.length) return Array.isArray(asset.dependencies) || Array.isArray(release.dependencies)
            ? { dependencies: declared } : {};
        const dependencies = [], positions = new Map();
        for (const dependency of [...declared, ...required]) {
            const identity = String(dependency?.bootName || dependency?.modName || dependency?.id || '').trim().toLowerCase();
            const key = JSON.stringify([identity, dependency?.version || '*', dependency?.bootVersions || null]);
            if (!identity || !positions.has(key)) {
                if (identity) positions.set(key, dependencies.length);
                dependencies.push(dependency);
            } else if (dependency.source === '目录强制前置') {
                const index = positions.get(key);
                dependencies[index] = { ...dependencies[index], ...dependency };
            }
        }
        return { dependencies };
    }

    function buildCandidates(mod, history) {
        const market = window.modHubMarket;
        const source = getReleaseSource(normalizeSource(mod?.githubUrl));
        if (!source || (history?.id && history.id !== mod.id)
            || (history?.sourceUrl && normalizeSource(history.sourceUrl) !== normalizeSource(mod.githubUrl))) return [];
        const releases = Array.isArray(history) ? history : history?.releases || [];
        const gameVersion = getGameVersion();
        const candidates = [];
        const seen = new Set();
        for (const release of releases) {
            if (release?.draft || release?.prerelease || !validHistoricalRelease(release, mod, source)) continue;
            const assets = release.assets || [];
            const plan = market.buildReleaseAssetPlan(assets, '', mod, { preserveVersions: true });
            const availableAssets = plan.availableAssets || assets;
            const optionalUrls = new Set(availableAssets.flatMap(asset => market.getMatchingOptionalAssets(asset, availableAssets))
                .map(asset => asset.downloadUrl));
            const mainAssets = availableAssets.filter(asset => market.getAssetRole(asset.name) !== 'resource'
                && !optionalUrls.has(asset.downloadUrl));
            const mixedProducts = Boolean(mod?.sharedRepository
                && mainAssets.some(asset => market.matchesAssetIdentity(asset, mod))
                && mainAssets.some(asset => !market.matchesAssetIdentity(asset, mod)));
            const ownedTitleVersion = ownedReleaseTitleVersion(release.name, mod);
            for (const asset of plan.candidates || []) {
                const verifiedVersion = verifiedCandidateBootVersion(mod, asset);
                if (asset.versionSource === 'verified-boot' && !verifiedVersion) continue;
                const tagName = release.tagName || '';
                const candidateKey = JSON.stringify([market.getMarketModKey(mod), tagName, asset.downloadUrl]);
                if (seen.has(candidateKey)) continue;
                seen.add(candidateKey);
                const tagVersion = MODHUB_RELEASE_DATE_LABEL_PATTERN.test(tagName)
                    || Boolean(market.getAssetGameVersion(tagName))
                    ? '' : String(tagName).match(/^(?:[a-z][a-z_-]*)?v?(\d+(?:\.\d+)*)(?:[-+][a-z0-9][a-z0-9.-]*)?$/i)?.[1] || '';
                const titleVersion = MODHUB_RELEASE_DATE_LABEL_PATTERN.test(release.name || '') ? ''
                    : String(release.name || '').trim().match(/^v?(\d+(?:\.\d+)+)$/i)?.[1];
                const version = verifiedVersion || market.getAssetVersionParts(asset.name).join('.')
                    || (mixedProducts ? ownedTitleVersion
                        : (release.versionSource !== 'verified-boot' ? release.version : '')
                            || ownedTitleVersion || titleVersion || tagVersion);
                const selectedAssets = [{ ...asset, packageRole: market.getAssetRole?.(asset.name) || 'main' },
                    ...market.getMatchingCompanionAssets(asset, plan.availableAssets || assets).map(companion => ({ ...companion, packageRole: 'resource' }))];
                candidates.push({ candidateKey, selectedKey: candidateKey, seriesKey: market.getAssetSeries(asset.name),
                    tagName, releaseName: release.name || '', htmlUrl: release.htmlUrl || '', version,
                    assetName: asset.name, assetUrl: asset.downloadUrl, assetSize: Number(asset.size) || 0, assetDigest: asset.digest || '',
                    assets: selectedAssets, optionalAssets: market.getMatchingOptionalAssets?.(asset, plan.availableAssets || assets) || [],
                    availableAssets: plan.availableAssets || assets, candidateAssets: [asset],
                    requiresManualSelection: false, selectionReason: '', publishedAt: release.publishedAt || '',
                    updateDate: formatReleaseDate(release.publishedAt),
                    compatibility: candidateCompatibility(asset, release, gameVersion),
                    ...candidateDependencies(mod, asset, release),
                    ...(verifiedVersion ? { versionSource: 'verified-boot', bootName: asset.bootName } : {}),
                    stale: Boolean(history?.stale), fromCache: Boolean(history?.fromCache) });
            }
        }
        return candidates;
    }

    function matchesCurrentGame(candidate, gameVersion) {
        const info = candidate.compatibility || {};
        return Boolean(gameVersion && !info.referenceMismatch && info.status !== 'incompatible'
            && (info.evidence === 'declaration' && info.status === 'compatible'
                || info.evidence === 'filename' && info.targetGameVersion
                    && window.modHubMarket.compareVersions(info.targetGameVersion, gameVersion) === 0));
    }

    function candidatePublicationTime(candidate, fullTime) {
        const published = typeof candidate.publishedAt === 'string' ? candidate.publishedAt : '';
        if (fullTime) return /T/.test(published) ? Date.parse(published) : NaN;
        const day = /^\d{4}-\d{2}-\d{2}$/.test(candidate.updateDate || '') ? candidate.updateDate
            : Number.isFinite(Date.parse(published)) ? new Date(published).toISOString().slice(0, 10) : '';
        return Date.parse(day);
    }

    function latestUnambiguousCandidate(candidates) {
        if (!candidates.length) return null;
        const market = window.modHubMarket;
        let latest = candidates;
        // 所有候选版号都可比较时才使用版号，不能把未知版号当作零或截取标签尾段。
        if (candidates.every(candidate => normalizeGameVersion(candidate.version))) {
            const highest = [...candidates].sort((a, b) => market.compareVersions(b.version, a.version))[0];
            latest = candidates.filter(candidate => market.compareVersions(candidate.version, highest.version) === 0);
        }
        if (latest.length > 1) {
            const fullTime = latest.every(candidate => Number.isFinite(candidatePublicationTime(candidate, true)));
            const times = latest.map(candidate => candidatePublicationTime(candidate, fullTime));
            if (times.some(time => !Number.isFinite(time))) return null;
            const newest = Math.max(...times);
            latest = latest.filter((candidate, index) => times[index] === newest);
        }
        // 同一最高版号或发布时间有不同附件时，仍须玩家选择，不依赖上游列表顺序。
        return new Set(latest.map(candidate => candidate.assetUrl || candidate.assets?.[0]?.downloadUrl || candidate.candidateKey)).size === 1 ? latest[0] : null;
    }

    function getLatestGameCandidate(mod, candidates) {
        const gameVersion = getGameVersion();
        if (!gameVersion || !candidates[0]?.seriesKey || new Set(candidates.map(candidate => candidate.seriesKey)).size !== 1) return null;
        return latestUnambiguousCandidate(candidates.filter(candidate => matchesCurrentGame(candidate, gameVersion)));
    }

    /** 全局最新只比较同一产品系列，适配证据不影响真实发行版号。 */
    function getLatestReleaseCandidate(mod, candidates) {
        const market = window.modHubMarket, source = getReleaseSource(normalizeSource(mod?.githubUrl));
        if (!source || !candidates[0]?.seriesKey || new Set(candidates.map(candidate => candidate.seriesKey)).size !== 1
            || candidates.some(candidate => getReleaseSource(normalizeSource(candidate.assetUrl))?.key !== source.key
                || candidate.candidateKey !== JSON.stringify([market.getMarketModKey(mod), candidate.tagName, candidate.assetUrl]))) return null;
        return latestUnambiguousCandidate(candidates);
    }

    /** 缺少适配声明不代表没有新版；仅补充身份和版号明确的未知适配候选。 */
    function getLatestUpdateCandidate(mod, candidates) {
        const gameVersion = getGameVersion();
        if (!gameVersion || !candidates[0]?.seriesKey || new Set(candidates.map(candidate => candidate.seriesKey)).size !== 1) return null;
        if (candidates.some(candidate => matchesCurrentGame(candidate, gameVersion))) return getLatestGameCandidate(mod, candidates);
        return latestUnambiguousCandidate(candidates.filter(candidate => {
            const info = candidate.compatibility || {};
            return info.status !== 'incompatible' && !info.referenceMismatch && (!info.evidence || info.evidence === 'unknown');
        }));
    }

    /** 仅按精确技术身份回读摘要，展示名与同仓库关系不能证明本地包身份。 */
    function selectionLocalProfile(mod, localProfile) {
        const profile = localProfile || mod?._matchedLocal;
        const normalizeName = name => String(name || '').trim().toLowerCase();
        const names = (mod?.bootNames || []).map(normalizeName).filter(Boolean);
        const name = normalizeName(profile?.bootJson?.name || profile?.name);
        if (name && names.length && !names.includes(name)) return null;
        if (profile?.packageDigest) return name ? profile : null;
        const matches = (window.modHubMarket.getLocalInstalledProfiles?.() || []).filter(item => {
            const actual = normalizeName(item.bootJson?.name || item.name);
            return name ? actual === name : names.includes(actual);
        });
        return matches.length === 1 ? matches[0] : profile || null;
    }

    /** 同版重打包须两份有效摘要及明确未安装结果，不能仅凭版号或日期猜更新。 */
    function isVerifiedRepackage(mod, candidate, localVersion, localProfile) {
        const market = window.modHubMarket, profile = selectionLocalProfile(mod, localProfile);
        const normalizeDigest = digest => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : '';
        const asset = market.getReleaseInstallAssets?.(candidate)?.[0] || candidate?.assets?.[0];
        const localDigest = normalizeDigest(profile?.packageDigest);
        const candidateDigest = normalizeDigest(asset?.digest || (!asset || asset.downloadUrl === candidate.assetUrl ? candidate.assetDigest : ''));
        return Boolean(localDigest && candidateDigest && localDigest !== candidateDigest
            && market.isSameVersion(candidate?.version, localVersion) && market.isSameVersion(profile?.version, localVersion)
            && market.isReleaseInstalled?.(candidate, profile) === false);
    }

    function isDefaultUpdate(mod, candidate, localVersion, localProfile) {
        if (!localVersion || !normalizeGameVersion(candidate?.version) || !normalizeGameVersion(localVersion)) return false;
        const compared = window.modHubMarket.compareVersions(candidate.version, localVersion);
        return compared > 0 || compared === 0 && isVerifiedRepackage(mod, candidate, localVersion, localProfile);
    }

    /** 默认选择仅减少操作步骤，不能替代安装包的实际适配核对。 */
    function getDefaultSelection(mod, candidates, { updateOnly = false, localProfile, localVersion = localProfile?.version || mod?._matchedLocal?.version || '' } = {}) {
        const empty = { defaultKey: '', defaultReason: '', defaultRisk: false };
        if (!candidates[0]?.seriesKey || new Set(candidates.map(candidate => candidate.seriesKey)).size !== 1) return empty;
        const market = window.modHubMarket, gameVersion = getGameVersion();
        const matching = candidates.filter(candidate => matchesCurrentGame(candidate, gameVersion));
        const matched = getLatestGameCandidate(mod, candidates);
        const latest = matching.length ? matched : latestUnambiguousCandidate(
            candidates.filter(candidate => candidate.compatibility?.status !== 'incompatible'));
        if (!latest || localVersion && (!normalizeGameVersion(latest.version) || !normalizeGameVersion(localVersion)
                || market.compareVersions(latest.version, localVersion) < 0)
            || updateOnly && !isDefaultUpdate(mod, latest, localVersion, localProfile)) return empty;
        let defaultReason;
        if (matched) defaultReason = latest.compatibility?.evidence === 'declaration'
            ? '已默认选择作者声明支持当前游戏的最新版本，下一步将核对安装包中的说明。'
            : '已根据安装包名称默认选择匹配当前游戏的最新版本，下一步将核对安装包中的说明。';
        else if (!gameVersion) defaultReason = '当前游戏版本未能识别，已默认选择最新版本；安装前需确认适配风险。';
        else if (latest.compatibility?.evidence === 'unknown' || !latest.compatibility?.evidence)
            defaultReason = '作者未声明支持的游戏版本，已默认选择最新版本；安装前需确认适配风险。';
        else defaultReason = '没有找到匹配当前游戏的版本，已默认选择最新版本；安装前需确认适配风险。';
        return { defaultKey: latest.candidateKey, defaultReason, defaultRisk: !matched };
    }

    function rankCandidates(mod, candidates, { updateOnly = false, localProfile, localVersion = localProfile?.version || mod?._matchedLocal?.version || '' } = {}) {
        const market = window.modHubMarket;
        const gameVersion = getGameVersion();
        const rank = candidate => {
            const info = candidate.compatibility || {};
            if (matchesCurrentGame(candidate, gameVersion)) return 0;
            if (info.status === 'incompatible' || info.referenceMismatch) return 3;
            return 2;
        };
        const numeric = candidates.every(candidate => normalizeGameVersion(candidate.version));
        const fullTime = candidates.every(candidate => Number.isFinite(candidatePublicationTime(candidate, true))
            || !Number.isFinite(candidatePublicationTime(candidate, false)));
        const publicationTime = candidate => {
            const time = candidatePublicationTime(candidate, fullTime);
            return Number.isFinite(time) ? time : -Infinity;
        };
        const sorted = [...candidates].sort((a, b) => rank(a) - rank(b)
            || (numeric ? market.compareVersions(b.version, a.version) : 0)
            || publicationTime(b) - publicationTime(a)
            || String(a.candidateKey).localeCompare(String(b.candidateKey)));
        const recommended = getLatestGameCandidate(mod, sorted);
        return { candidates: sorted, recommendedKey: recommended
            && (!updateOnly || isDefaultUpdate(mod, recommended, localVersion, localProfile)) ? recommended.candidateKey : '',
            ...getDefaultSelection(mod, sorted, { updateOnly, localVersion, localProfile }), gameVersion };
    }

    function renderCandidateOptions(candidates, recommendedKey = '') {
        return [{ value: '', label: '请选择版本与安装包' }, ...candidates.map(candidate => {
            const recommended = candidate.candidateKey === recommendedKey;
            const status = getCandidateStatus(candidate);
            const prefix = recommended ? (candidate.compatibility?.evidence === 'filename' ? '参考推荐：' : '推荐：') : '';
            return { value: candidate.candidateKey,
                label: `${prefix}${candidate.version || candidate.tagName || '版本未知'} · ${status.label} · ${candidate.assetName || '安装包'}` };
        })];
    }

    window.modHubMarketVersions = { getGameVersion, formatReleaseDate, formatVersionRange, assessVersionRange, assessCompatibility, fetchReleases, getHistoryErrorInfo, buildCandidates, getLatestGameCandidate, getLatestReleaseCandidate, getLatestUpdateCandidate, getDefaultSelection, rankCandidates, getCandidateStatus, renderCandidateOptions };
})();
