/** ModHub 历史发布、游戏版本匹配与候选排序。 */
(function() {
    'use strict';

    const MODHUB_HISTORY_CACHE_PREFIX = 'modhub_market_history_v1_';
    const MODHUB_HISTORY_CACHE_TTL = 6 * 60 * 60 * 1000;
    const MODHUB_HISTORY_TIMEOUT = 10000;

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

    function assessCompatibility(range, gameVersion = getGameVersion()) {
        const unknown = reason => ({ status: 'unknown', reason });
        const version = normalizeGameVersion(gameVersion);
        if (!version) return unknown('当前游戏版本未能识别，请按作者说明选择安装包');
        if (typeof range !== 'string' || !range.trim()) return unknown('适用的游戏版本尚未确定，下一步会核对安装包中的说明');
        // 原生范围使用 && 和 ||；完整验证，避免宽松解析器把不支持的尾部当成有效声明。
        const clauses = range.trim().split('||');
        const supported = isNativeRangeSyntaxSupported(range);
        if (!supported) return unknown('暂不能识别作者的游戏版本说明，请查看发布说明');
        try {
            const api = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.();
            if (!api?.parseVersion || !api?.parseRange || !api?.satisfies) return unknown('当前 ModLoader 无法核对作者的游戏版本范围，请查看作者说明');
            const parsedVersion = api.parseVersion(version)?.version;
            const parsedRange = api.parseRange(range.trim());
            if (!parsedVersion?.version?.length || !Array.isArray(parsedRange) || parsedRange.length !== clauses.length) return unknown('暂不能核对作者的游戏版本说明，请查看发布说明');
            const compatible = api.satisfies(parsedVersion, parsedRange, true);
            if (typeof compatible !== 'boolean') return unknown('当前 ModLoader 未能确定该版本是否适用，请查看作者说明');
            return { status: compatible ? 'compatible' : 'incompatible', reason: compatible
                ? `作者声明的支持范围包含当前 DoL ${version}；下一步会核对所选安装包`
                : `作者声明支持 DoL ${formatVersionRange(range)}，当前游戏为 DoL ${version}，不在此范围内` };
        } catch (_) {
            return unknown('暂不能核对作者的游戏版本说明，请查看发布说明');
        }
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

    async function fetchReleases(mod, { page = 1, signal, useCache = true } = {}) {
        const market = window.modHubMarket;
        if (!mod?.id || !Number.isSafeInteger(page) || page < 1) throw historyError('无法识别模组历史发布请求', 'INVALID_RELEASE_REQUEST');
        if (market?.isWithdrawn?.(mod)) throw historyError('该模组来源已撤回，请刷新市场', 'MOD_RELEASES_UNAVAILABLE');
        if (mod.catalogSource === 'community' && !market?.hasCommunityReleaseSource?.(mod)) throw historyError('该社区模组未获准自动安装，请前往作者主页', 'MANUAL_SOURCE');
        const sourceUrl = normalizeSource(mod.githubUrl);
        const source = getReleaseSource(sourceUrl);
        if (!sourceUrl || !source) throw historyError('该模组没有可用的发布来源', 'MANUAL_SOURCE');
        // 索引镜像只提供目录文件，历史接口与其他动态接口共用真实 Worker 地址。
        const base = new URL(market.RELEASE_WORKER_API_BASE);
        const communityRevision = market.getCommunityRevision?.() ?? mod.communityRevision;
        const signature = JSON.stringify([base.origin, mod.id, sourceUrl, mod.catalogSource || '', mod.autoInstall,
            mod.autoInstallScope || '', mod.revision, communityRevision, mod.identityId, mod.name,
            mod.sourceUrl, mod.releaseUrl, mod.version, mod.repositoryKeys || [], mod.releaseCompatibility || [], mod.dependencies,
            mod.bootNames || [], mod.aliases || [], mod.sharedRepository, page, 'modpack-v1']);
        const cacheKey = MODHUB_HISTORY_CACHE_PREFIX + encodeURIComponent(signature);
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (_) {}
        const validResponse = data => data?.schemaVersion === 1 && data.id === mod.id
            && normalizeSource(data.sourceUrl) === sourceUrl && data.page === page && typeof data.hasMore === 'boolean'
            && Number.isFinite(Date.parse(data.fetchedAt)) && (data.stale === undefined || typeof data.stale === 'boolean')
            && (!Number.isSafeInteger(communityRevision) || data.communityRevision === communityRevision)
            && Array.isArray(data.releases) && data.releases.every(release => validHistoricalRelease(release, mod, source));
        if (cached?.signature !== signature || !Number.isFinite(cached?.timestamp) || !validResponse(cached?.data)) cached = null;
        if (signal?.aborted) throw historyError('已取消获取历史版本', 'ABORT_ERR');
        if (useCache && cached && !cached.data.stale && Date.now() - cached.timestamp < MODHUB_HISTORY_CACHE_TTL) return { ...cached.data, fromCache: true };
        const url = new URL('/mod-releases', base.origin);
        url.searchParams.set('id', mod.id);
        url.searchParams.set('page', String(page));
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const abort = () => controller?.abort();
        signal?.addEventListener?.('abort', abort, { once: true });
        const timeout = controller ? setTimeout(() => controller.abort(), MODHUB_HISTORY_TIMEOUT) : null;
        try {
            const response = await fetch(url.toString(), { signal: controller?.signal || signal });
            if (!response.ok) {
                let failure = null;
                try { failure = await response.json(); } catch (_) {}
                throw historyError(failure?.error || `历史发布服务暂不可用（HTTP ${response.status}）`, failure?.code || 'RELEASE_UPSTREAM_FAILED', response.status);
            }
            let data;
            try { data = await response.json(); } catch (error) {
                if (error?.name === 'SyntaxError') throw historyError('历史发布数据格式异常，请稍后重试', 'RELEASE_RESPONSE_INVALID');
                throw error;
            }
            if (signal?.aborted) throw historyError('已取消获取历史版本', 'ABORT_ERR');
            if (!validResponse(data)) throw historyError('历史发布来源已变化，请刷新市场后重试', 'RELEASE_SOURCE_CHANGED');
            const fetchedAt = Math.min(Date.now(), Date.parse(data.fetchedAt));
            data = { ...data, stale: Boolean(data.stale || Date.now() - fetchedAt >= MODHUB_HISTORY_CACHE_TTL) };
            try { localStorage.setItem(cacheKey, JSON.stringify({ signature, timestamp: data.stale ? 0 : fetchedAt, data })); } catch (_) {}
            return data;
        } catch (error) {
            if (signal?.aborted) throw error;
            const unsafe = ['INVALID_RELEASE_REQUEST', 'MOD_RELEASES_UNAVAILABLE', 'MANUAL_SOURCE', 'RELEASE_NOT_FOUND', 'RELEASE_SOURCE_CHANGED', 'RELEASE_RESPONSE_INVALID', 'CATALOG_UNAVAILABLE'].includes(error?.code)
                || [400, 401, 403, 404, 409, 503].includes(error?.status);
            if (unsafe) {
                try { localStorage.removeItem(cacheKey); } catch (_) {}
                throw error;
            }
            if (cached) return { ...cached.data, fromCache: true, stale: true };
            throw error;
        } finally {
            if (timeout !== null) clearTimeout(timeout);
            signal?.removeEventListener?.('abort', abort);
        }
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
            for (const asset of plan.candidates || []) {
                const tagName = release.tagName || '';
                const candidateKey = JSON.stringify([market.getMarketModKey(mod), tagName, asset.downloadUrl]);
                if (seen.has(candidateKey)) continue;
                seen.add(candidateKey);
                const version = market.getAssetVersionParts(asset.name).join('.') || release.version
                    || String(release.name || '').trim().match(/^v?(\d+(?:\.\d+)+)$/i)?.[1]
                    || (String(tagName).match(/(?:^|[^a-z0-9])v?(\d+(?:\.\d+)*)(?=$|[^a-z0-9.])/i)?.[1] || '');
                const selectedAssets = [asset, ...market.getMatchingCompanionAssets(asset, plan.availableAssets || assets)];
                candidates.push({ candidateKey, selectedKey: candidateKey, seriesKey: market.getAssetSeries(asset.name),
                    tagName, releaseName: release.name || '', htmlUrl: release.htmlUrl || '', version,
                    assetName: asset.name, assetUrl: asset.downloadUrl, assetSize: Number(asset.size) || 0, assetDigest: asset.digest || '',
                    assets: selectedAssets, availableAssets: plan.availableAssets || assets, candidateAssets: [asset],
                    requiresManualSelection: false, selectionReason: '', updateDate: String(release.publishedAt || '').slice(0, 10),
                    compatibility: candidateCompatibility(asset, release, gameVersion),
                    ...(Array.isArray(asset.dependencies) ? { dependencies: asset.dependencies }
                        : Array.isArray(release.dependencies) ? { dependencies: release.dependencies } : {}),
                    stale: Boolean(history?.stale), fromCache: Boolean(history?.fromCache) });
            }
        }
        return candidates;
    }

    function rankCandidates(mod, candidates, { updateOnly = false, localVersion = mod?._matchedLocal?.version || '' } = {}) {
        const market = window.modHubMarket;
        const gameVersion = getGameVersion();
        const rank = candidate => {
            const info = candidate.compatibility || {};
            if (info.status === 'compatible' && info.evidence === 'declaration') return 0;
            if (info.status === 'incompatible' || info.referenceMismatch) return 3;
            if (info.evidence === 'filename' && info.targetGameVersion && gameVersion
                && market.compareVersions(info.targetGameVersion, gameVersion) === 0) return 1;
            return 2;
        };
        const sorted = [...candidates].sort((a, b) => rank(a) - rank(b)
            || market.compareVersions(b.version, a.version) || String(b.updateDate).localeCompare(String(a.updateDate)));
        const series = new Set(sorted.map(candidate => candidate.seriesKey));
        const eligible = sorted.filter(candidate => rank(candidate) < 2
            && (!updateOnly || Boolean(localVersion && candidate.version) && market.compareVersions(candidate.version, localVersion) > 0));
        return { candidates: sorted, recommendedKey: series.size === 1 ? eligible[0]?.candidateKey || '' : '', gameVersion };
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

    window.modHubMarketVersions = { getGameVersion, formatVersionRange, assessCompatibility, fetchReleases, buildCandidates, rankCandidates, getCandidateStatus, renderCandidateOptions };
})();
