// ModHub 市场索引、身份、版本与来源解析。
const {
    assert, fs, path, srcRoot, bootJson,
    readStyles, loadScripts, loadManager, loadMarket,
} = require('./helpers');

module.exports = async function() {
    /* =========================================================================
     * 10. 统一索引契约（网站 release-index / 身份目录 <-> Mod 端消费）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        assert.ok(market, '市场模块必须导出 window.modHubMarket');
        for (const member of ['normalizeReleaseIndex', 'applyIdentityCatalog', 'fetchReleaseIndex', 'MARKET_CATEGORIES', 'KNOWN_MOD_MARKET_ALIASES', 'IDENTITY_CATALOG_URL', 'RELEASE_WORKER_API_BASE']) {
            assert.ok(market[member] !== undefined, `市场导出必须包含 ${member}`);
        }
        // 10.1 schemaVersion 守卫
        assert.throws(() => market.normalizeReleaseIndex({ schemaVersion: 2, mods: [] }), /格式异常/, '非 v1 索引必须拒绝');
        const normalized = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [] });
        assert.ok(normalized && typeof normalized === 'object', '合法索引必须正常归一化');
        // 10.2 身份目录结构契约：schemaVersion=1、mods 数组、关键字段齐全
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        assert.equal(catalog.schemaVersion, 1, '身份目录 schemaVersion 必须为 1');
        assert.ok(Array.isArray(catalog.mods) && catalog.mods.length > 0, '身份目录 mods 必须为非空数组');
        for (const mod of catalog.mods) {
            assert.ok(mod.id && typeof mod.id === 'string', '身份条目必须包含 id');
            assert.ok(mod.name && typeof mod.name === 'string', `身份条目 ${mod.id} 必须包含 name`);
            assert.ok(Array.isArray(mod.bootNames), `身份条目 ${mod.id} 必须包含 bootNames 数组`);
            assert.ok(typeof mod.category === 'string', `身份条目 ${mod.id} 必须声明分类`);
            // 10.3 分类必须落在市场分类表内，否则 applyIdentityCatalog 会静默丢弃
            assert.ok(market.MARKET_CATEGORIES.includes(mod.category), `身份条目 ${mod.id} 的分类「${mod.category}」必须存在于 MARKET_CATEGORIES`);
        }
        // 10.4 身份目录可被 Mod 端正确消费（应用数量与别名注册）
        const applied = market.applyIdentityCatalog(JSON.parse(JSON.stringify(catalog)));
        assert.ok(applied >= catalog.mods.length, '身份目录必须全部被应用');
        const first = catalog.mods.find(m => m.bootNames.length > 0);
        // 与市场内部 normalizeKey 等效的键归一化
        const firstKey = String(first.bootNames[0]).toLowerCase().replace(/[()（）\[\]【】_—\-—.\s]/g, '').trim();
        assert.ok(market.KNOWN_MOD_MARKET_ALIASES[firstKey], `应用后必须能通过 bootName 键「${firstKey}」检索到别名映射`);

        // 10.5 目录与版本独立刷新仍兼容 v1，且保留 Wiki 元数据与权威版本字段
        const indexedMod = {
            ...catalog.mods.find(mod => mod.id === 'modhub'),
            identityId: 'modhub', wikiName: 'ModHub模组管理中心',
            githubUrl: 'https://github.com/JohnLiao501/ModHub',
            githubUrls: ['https://github.com/JohnLiao501/ModHub', 'https://github.com/NEEDMEET/ModHub'],
            wikiVersion: '1.0.1', wikiDate: '2026-09-26',
            version: '1.0.2', versionSource: 'github', updateDate: '2026-09-27',
            releaseUrl: 'https://github.com/JohnLiao501/ModHub/releases/tag/v1.0.2'
        };
        const splitIndex = {
            schemaVersion: 1, catalogUpdatedAt: '2026-09-27T00:02:00.000Z',
            generatedAt: '2026-09-27T00:05:00.000Z', identities: catalog.mods, mods: [indexedMod]
        };
        const [normalizedMod] = market.normalizeReleaseIndex(splitIndex);
        for (const field of ['id', 'identityId', 'wikiVersion', 'wikiDate', 'version', 'versionSource', 'updateDate', 'releaseUrl', 'category']) {
            assert.equal(normalizedMod[field], indexedMod[field], `独立刷新索引必须保留 ${field}`);
        }
        assert.deepEqual(Array.from(normalizedMod.githubUrls), indexedMod.githubUrls, '必须保留 Wiki 原始仓库链接集合');
        assert.deepEqual(Array.from(normalizedMod.bootNames), indexedMod.bootNames, '独立刷新不得丢失模组身份名称');
        assert.equal(splitIndex.catalogUpdatedAt, '2026-09-27T00:02:00.000Z', '归一化不得改写目录刷新时间');

        // 10.6 手动刷新绕过列表缓存，并重新验证各镜像的 HTTP 缓存
        const oldMod = { name: 'ModHub', version: '1.0.1', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [oldMod], timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '1.0.1', '普通加载应保留已有列表缓存');
        const requestedUrls = [];
        sb.fetch = async (url, options) => {
            requestedUrls.push(url);
            assert.equal(options.cache, 'no-cache', '索引请求必须重新验证 HTTP 缓存');
            if (url === market.RELEASE_INDEX_MIRRORS[0]) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: [{ ...oldMod, version: '1.0.2' }] }) };
        };
        assert.equal((await market.loadMarketData(true))[0].version, '1.0.2', '手动刷新必须取代内存和本地的旧版本列表');
        assert.deepEqual(requestedUrls, Array.from(market.RELEASE_INDEX_MIRRORS), '主镜像失效后必须继续尝试备用镜像');
    }

    // README 在线线路失败后使用官方 API 或最后成功缓存，不能无限等待网络。
    {
        const sb = loadMarket();
        sb.atob = atob;
        sb.TextDecoder = TextDecoder;
        const market = sb.modHubMarket;
        const repository = 'https://github.com/Owner/Readme';
        const cacheKey = 'modhub_market_readme_v1_owner/readme';
        const markdown = '# 中文说明\n\n离线时仍可阅读。';
        const payload = {
            markdown, sourceUrl: `${repository}/blob/main/docs/README.md`,
            downloadUrl: 'https://raw.githubusercontent.com/Owner/Readme/main/docs/README.md'
        };
        const requests = [];
        sb.fetch = async url => {
            requests.push(url);
            return { ok: true, status: 200, json: async () => payload };
        };
        assert.equal(await market.fetchGithubReadme('https://example.test/Owner/Readme'), null, '非 GitHub 仓库不得触发请求');
        assert.equal((await market.fetchGithubReadme(repository)).markdown, markdown);
        assert.equal(new URL(requests[0]).origin, market.RELEASE_WORKER_API_BASE, 'README 只能使用已实现该路由的服务，不能假定网站镜像提供代理');
        assert.equal((await market.fetchGithubReadme(repository.toLowerCase())).fromCache, true, '同仓库大小写不同也应复用成功缓存');
        assert.equal(requests.length, 1, '有效缓存期间重复点选不得重复联网');

        const previous = { data: payload, timestamp: 1 };
        sb.localStorage.setItem(cacheKey, JSON.stringify(previous));
        sb.fetch = async url => { requests.push(url); throw new Error('模拟直连离线'); };
        const offline = await market.fetchGithubReadme(repository);
        assert.equal(offline.markdown, markdown);
        assert.equal(offline.isStale, true, '两条线路均失败后须标明最后成功缓存');
        assert.equal(JSON.parse(sb.localStorage.getItem(cacheKey)).timestamp, 1, '离线读取不能把旧缓存伪装为新文档');
        assert.equal(requests.at(-1), 'https://api.github.com/repos/Owner/Readme/readme', '代理不可达后必须尝试官方 API');

        sb.fetch = async (url, options) => {
            if (!url.startsWith('https://api.github.com/')) throw new Error('模拟 workers.dev 不可达');
            assert.equal(options.headers.Accept, 'application/vnd.github+json');
            return { ok: true, status: 200, json: async () => ({
                encoding: 'base64', content: Buffer.from(markdown).toString('base64'),
                html_url: payload.sourceUrl, download_url: payload.downloadUrl
            }) };
        };
        const direct = await market.fetchGithubReadme(repository);
        assert.equal(direct.markdown, markdown, '官方 API 的 Base64 必须按 UTF-8 解码中文');
        assert.equal(direct.sourceUrl, payload.sourceUrl);
        assert.equal(direct.downloadUrl, payload.downloadUrl, '必须保留 README 真实路径供相对图片解析');
        assert.notEqual(direct.isStale, true, '直连成功必须替换过期缓存');

        sb.localStorage.removeItem(cacheKey);
        sb.fetch = async url => ({ ok: true, status: 200, json: async () => url.startsWith('https://api.github.com/') ? {
            encoding: 'base64', content: Buffer.from(markdown).toString('base64'),
            html_url: 'https://github.com/Other/Repo/blob/main/README.md',
            download_url: 'https://raw.githubusercontent.com/Other/Repo/main/README.md'
        } : {} });
        const safeSources = await market.fetchGithubReadme(repository);
        assert.equal(safeSources.sourceUrl, repository, 'API 不得把说明来源指向其他仓库');
        assert.equal(safeSources.downloadUrl, '', 'API 不得把相对图片基址指向其他仓库');

        sb.localStorage.setItem(cacheKey, JSON.stringify(previous));
        sb.fetch = async () => ({ ok: false, status: 404 });
        assert.equal(await market.fetchGithubReadme(repository), null, '明确不存在的 README 不应被过期缓存冒充');
        sb.localStorage.removeItem(cacheKey);
        sb.fetch = async () => { throw new Error('模拟完全离线'); };
        await assert.rejects(market.fetchGithubReadme(repository), /模拟完全离线/, '无缓存时保留失败状态，交由说明页提示');

        // 无 AbortController 的旧浏览器、响应体挂起都必须在两次受控超时后结束。
        for (const waitingForBody of [false, true]) {
            const timers = [];
            let cleared = 0, aborted = 0;
            sb.AbortController = waitingForBody ? class {
                signal = {};
                abort() { aborted++; }
            } : undefined;
            sb.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timers.push(callback); return timers.length; };
            sb.clearTimeout = () => { cleared++; };
            sb.fetch = async () => waitingForBody
                ? { ok: true, status: 200, json: () => new Promise(() => {}) }
                : new Promise(() => {});
            const pending = assert.rejects(market.fetchGithubReadme(repository), /获取超时/);
            for (let source = 0; source < 2; source++) {
                await new Promise(setImmediate);
                assert.equal(timers.length, source + 1, '每条请求线路都必须安装超时计时器');
                timers[source]();
            }
            await pending;
            assert.equal(cleared, 2, '无论超时还是失败都必须清理两条线路的计时器');
            assert.equal(aborted, waitingForBody ? 2 : 0, '支持 AbortController 时还必须中断实际请求');
        }
    }

    // 统一索引已更新时，安装预检与下载共用的 Release 缓存不能选择旧安装包
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const mod = { name: 'ModHub', version: '1.0.2', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        const cacheKey = 'modhub_market_rel_v2_JohnLiao501_ModHub';
        let cache = {
            version: '1.0.1', assetPlanVersion: 2, assetPlanGameVersion: '',
            assets: [{ name: 'ModHub-v1.0.1.zip', downloadUrl: `${mod.githubUrl}/releases/download/v1.0.1/ModHub-v1.0.1.zip` }]
        };
        const writeCache = version => sb.localStorage.setItem(cacheKey, JSON.stringify({ data: { ...cache, version }, timestamp: Date.now() }));
        writeCache('1.0.1');
        let requestCount = 0;
        sb.fetch = async () => {
            requestCount++;
            return { ok: true, status: 200, json: async () => ({
                tag_name: 'v1.0.2', name: 'v1.0.2', assets: [{
                    name: 'ModHub-v1.0.2.zip',
                    browser_download_url: `${mod.githubUrl}/releases/download/v1.0.2/ModHub-v1.0.2.zip`
                }]
            }) };
        };
        const release = await market.fetchModRelease(mod);
        assert.equal(release.version, '1.0.2', '低于市场版本的 Release 缓存必须被重新获取');
        assert.equal(requestCount, 1, '跳过旧缓存后必须请求 GitHub');
        assert.ok(release.assetUrl.endsWith('/ModHub-v1.0.2.zip'), '安装包地址必须来自新 Release');
        assert.equal((await market.fetchModRelease(mod)).fromCache, true, '不低于市场版本的缓存仍可复用');
        assert.equal(requestCount, 1, '可用缓存不得产生额外请求');

        sb.fetch = async () => { throw new Error('模拟 GitHub 离线'); };
        writeCache('1.0.2');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, '旧资产选择规则缓存即使版本一致也不得离线复用');
        cache = { ...release };
        writeCache('1.0.1');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, 'GitHub 失败时也不得回退到低于市场版本的安装包');
        writeCache('1.0.2');
        assert.equal((await market.fetchModRelease(mod, { useCache: false })).isStale, true, '版本满足要求时必须保留网络失败后的缓存回退');
        sb.localStorage.setItem(cacheKey.replace(/^modhub_/, 'dol_opt_'), sb.localStorage.getItem(cacheKey));
        sb.localStorage.removeItem(cacheKey);
        assert.equal((await market.fetchModRelease(mod, { useCache: false })).isStale, true, '更名后必须兼容旧版动态 Release 缓存键');
    }

    // 统一索引保留指定发布渠道，主包与同仓库扩展不得串包或共用旧缓存
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const repoUrl = 'https://github.com/AOKIUTAGE/UTAGEsDOL3.0';
        const index = { schemaVersion: 1, mods: [
            { name: 'AU美化', identityId: null, githubUrl: `${repoUrl}/releases/tag/mod`, releaseUrl: `${repoUrl}/releases/tag/facemod`, version: '99.0', versionSource: 'github', wikiVersion: '0.8.7' },
            { name: 'AU面部扩展', identityId: null, githubUrl: `${repoUrl}/releases/tag/facemod` }
        ] };
        const mods = market.normalizeReleaseIndex(index);
        assert.equal(mods[0].version, '0.8.7', '旧索引的跨渠道版本必须回退到本条目的Wiki版本');
        assert.equal(mods[0].releaseUrl, null, '旧索引的错配发布页不得继续展示');
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: index.mods, timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '0.8.7', '本地列表缓存也必须经过渠道纠偏');
        assert.notEqual(market.getMarketModKey(mods[0]), market.getMarketModKey(mods[1]), '同仓库不同发布渠道必须保留独立的批量安装身份');
        sb.localStorage.setItem('modhub_market_rel_v2_AOKIUTAGE_UTAGEsDOL3.0', JSON.stringify({
            timestamp: Date.now(), data: { version: '99.0', assetPlanVersion: 2, assetPlanGameVersion: '', assets: [{ name: 'wrong.zip', downloadUrl: 'wrong' }] }
        }));
        const urls = [];
        sb.fetch = async url => {
            urls.push(url);
            const tag = decodeURIComponent(url.split('/tags/')[1] || 'latest');
            return { ok: true, status: 200, json: async () => ({ tag_name: tag, assets: [{
                name: `${tag}.zip`, browser_download_url: `${repoUrl}/releases/download/${tag}/${tag}.zip`
            }] }) };
        };
        assert.equal((await market.fetchModRelease(mods[0])).assetName, 'mod.zip', 'AU主包必须遵循 githubUrl 指定渠道，不得采用旧索引 releaseUrl 或缓存中的面部扩展');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '面部扩展必须使用自己的发布渠道');
        assert.deepEqual(urls, ['mod', 'facemod'].map(tag => `https://api.github.com/repos/AOKIUTAGE/UTAGEsDOL3.0/releases/tags/${tag}`));
        assert.equal((await market.fetchModRelease(mods[0])).fromCache, true, '指定标签成功后仍可复用本渠道缓存');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '两次缓存读取不得互相覆盖');
        assert.equal(urls.length, 2, '渠道缓存命中不得额外访问网络');
        assert.equal((await market.fetchRecentCompanionAssets(mods[0])).length, 0, '固定渠道不得跨发布渠道推荐附属包');
        assert.equal(urls.length, 2);

        const encodedMod = { githubUrl: `${repoUrl}/releases/tag/model%2Fstable?test=1#assets` };
        const encodedRelease = await market.fetchModRelease(encodedMod);
        assert.ok(urls.at(-1).endsWith('/releases/tags/model%2Fstable'), '标签须解码一次再作为单个 API 路径参数编码');
        assert.equal(encodedRelease.htmlUrl, `${repoUrl}/releases/tag/model%2Fstable`, '缺少发布页地址时必须回退到指定标签');
        const callsBeforeMissing = urls.length;
        sb.fetch = async url => { urls.push(url); return { ok: false, status: 404 }; };
        await assert.rejects(market.fetchModRelease(mods[0], { useCache: false }), error => error.code === 'RELEASE_NOT_FOUND', '指定标签404不得回退到 latest 或过期包');
        assert.equal(urls.length, callsBeforeMissing + 1, '指定标签失效不得继续查询其他发布渠道');
        assert.notEqual(mods[0]._isDeadRepo, true, '标签不存在不能误标整个仓库失效');
        sb.fetch = async () => { throw new Error('模拟渠道离线'); };
        assert.equal((await market.fetchModRelease(mods[0], { useCache: false })).assetName, 'mod.zip', '离线回退也必须保持渠道隔离');
    }

    // AU发布页包含多个独立模型系列，覆盖包不能被误当成直装包
    {
        const market = loadMarket().modHubMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const assets = Object.entries({ female: ['0.8.7', '0.9.3'], male: ['0.3.7', '0.4.2'], androgynous: ['0.0.7', '0.1.1'] })
            .flatMap(([model, versions]) => versions.flatMap(version => ['model', 'imgpack'].map(type => asset(`AU${model}.${type}_v${version}.zip`))));
        const plan = market.buildReleaseAssetPlan(assets);
        assert.equal(plan.needsChoice, true, '不同模型系列必须交由玩家选择');
        assert.equal(plan.assets.length, 0, '不得跨模型系列比较版本后自动安装女体');
        assert.deepEqual(Array.from(plan.candidates, item => item.name).sort(), [
            'AUfemale.model_v0.9.3.zip', 'AUmale.model_v0.4.2.zip', 'AUandrogynous.model_v0.1.1.zip'
        ].sort(), '必须保留每个模型系列的最新版直装包，排除配对覆盖包');
        const single = market.buildReleaseAssetPlan([asset('AUfemale.model_v0.9.3.zip'), asset('AUfemale.imgpack_v0.9.3.zip')]);
        assert.equal(single.needsChoice, false);
        assert.equal(single.assets.length, 1, '同一模型不得同时安装model与覆盖用imgpack');
        assert.equal(single.assets[0].name, 'AUfemale.model_v0.9.3.zip');
        assert.equal(market.buildReleaseAssetPlan([asset('Example-v1.0.zip'), asset('Example-v2.0.zip')]).assets[0].name, 'Example-v2.0.zip', '普通模组仍选最新版本');
        assert.equal(market.buildReleaseAssetPlan([asset('Only.imgpack_v1.0.zip')]).assets[0].name, 'Only.imgpack_v1.0.zip', '无配对model时不得凭扩展命名排除既有独立资源');
    }

    // Wiki 回退也必须只采用名称列来源，拆分独立项目并识别共享仓库。
    {
        const sb = loadMarket();
        const anchor = (textContent, href) => ({ textContent, getAttribute: () => href });
        const cell = (textContent, links = []) => ({ textContent, querySelectorAll: () => links });
        const cells = [
            [cell('主模组', [anchor('主模组', 'https://github.com/Owner/Shared')]), cell('介绍', [anchor('依赖', 'https://github.com/Other/Dependency')]), cell('作者'), cell('2026-09-27 (v1.0)')],
            [cell('扩展 / 独立工具', [anchor('扩展', 'https://github.com/Owner/Shared'), anchor('独立工具', 'https://github.com/Owner/Tool')]), cell('介绍'), cell('作者'), cell('2026-09-27')]
        ];
        const header = { querySelectorAll: () => ['名称', '简介', '作者', '更新'].map(text => cell(text)) };
        const rows = cells.map(tds => ({ querySelectorAll: () => tds, querySelector: () => null }));
        const table = { querySelector: () => header, querySelectorAll: () => rows };
        sb.Node = { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 };
        sb.DOMParser = class { parseFromString() { return {
            getElementById: id => id === '公开模组' ? { compareDocumentPosition: () => 4 } : null,
            querySelectorAll: () => [table]
        }; } };
        const mods = sb.modHubMarket.parseModsFromHtml('');
        assert.deepEqual(Array.from(mods, mod => mod.name), ['主模组', '扩展', '独立工具']);
        assert.deepEqual(Array.from(mods[0].githubUrls), ['https://github.com/Owner/Shared'], '不得采集介绍中的依赖仓库');
        assert.equal(mods[0].otherUrl, null);
        assert.deepEqual(Array.from(mods, mod => mod.sharedRepository), [true, true, false]);
        assert.notEqual(sb.modHubMarket.getMarketModKey(mods[0]), sb.modHubMarket.getMarketModKey(mods[1]), 'Wiki回退无ID时共享仓库多项不能被批量合并');
        const cached = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: mods.map(mod => ({
            ...mod, sharedRepository: undefined, version: '99.0', versionSource: 'github', wikiVersion: '1.0',
            releaseUrl: 'https://github.com/Owner/Shared/releases/tag/Other'
        })) });
        assert.equal(cached[0].sharedRepository, true, '旧缓存未带字段时也必须重新识别共享仓库');
        assert.equal(cached[0].version, '1.0', '共享仓库的旧latest版本必须清除');
        assert.equal(cached[0].releaseUrl, null);
        assert.equal(cached[2].version, '99.0', '独立仓库版本仍可正常使用');
    }

    // 同名、子串和仓库尾名都不能跨模组建立身份。
    {
        const market = loadMarket().modHubMarket;
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        market.applyIdentityCatalog(catalog);
        const main = { ...catalog.mods.find(item => item.id === 'woven-realm'), githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm', sharedRepository: true };
        const child = { ...catalog.mods.find(item => item.id === 'woven-realm-cooking'), githubUrl: main.githubUrl, sharedRepository: true };
        for (const [target, other] of [[main, child], [child, main]]) {
            market.checkModInstallStatus(target, [{ name: target.bootNames[0] }]);
            assert.equal(target._matchedLocal?.name, target.bootNames[0]);
            market.checkModInstallStatus(other, [{ name: target.bootNames[0] }]);
            assert.equal(other._matchedLocal, null, '织境主包和料理扩展不得共享别名');
        }
        const unknown = { name: '美化扩展', githubUrl: 'https://github.com/Fixture/Unknown' };
        assert.equal(market.checkModInstallStatus(unknown, [{ name: '美化扩展修复' }]), 'not_installed');
        market.applyIdentityCatalog([{ identityId: null, id: 'wiki-a', name: '假条目', repositories: ['RealTech'] }]);
        assert.equal(market.checkModInstallStatus({ ...unknown, name: '假条目' }, [{ name: 'RealTech' }]), 'not_installed');
        const sameNames = ['A', 'B'].map(owner => ({ id: `fixture-${owner}`, name: '同名模组', bootNames: [`Tech${owner}`], repositoryKeys: [`${owner}/Same`], githubUrl: `https://github.com/${owner}/Same` }));
        market.applyIdentityCatalog(sameNames);
        for (const entry of sameNames) {
            for (const local of sameNames) {
                market.checkModInstallStatus(entry, [{ name: local.bootNames[0], repository: local.githubUrl }]);
                assert.equal(Boolean(entry._matchedLocal), entry.id === local.id, '同名不同作者必须按完整仓库隔离');
            }
        }
        const doli = { name: 'D.O.L.I', githubUrl: 'https://github.com/ArsNativa/DOLI' };
        market.checkModInstallStatus(doli, [{ name: 'DOLI', repository: 'https://github.com/Other/Different' }]);
        assert.equal(doli._matchedLocal, null, '显式来源与已知身份不同的本地包不得冒充官方版本');
        assert.equal(market.findMarketModByLocalName('无来源同名', ['A', 'B'].map(owner => ({ name: '无来源同名', githubUrl: `https://github.com/${owner}/Repo` }))), null, '反查同分不能取第一项');
        const tagged = tag => ({ identityId: 'one-id', name: '固定渠道', githubUrl: `https://github.com/Owner/Repo/releases/tag/${tag}` });
        assert.notEqual(market.getMarketModKey(tagged('main')), market.getMarketModKey(tagged('extra')));
        assert.notEqual(...['main.zip', 'extra.zip'].map(name => market.getMarketModKey({ identityId: 'one-id', githubUrl: `https://github.com/Owner/Repo/releases/download/v1/${name}` })), '同标签的指定附件也必须保留独立身份');
        const shared = { ...unknown, githubUrl: 'https://github.com/Owner/RealTech', sharedRepository: true };
        market.checkModInstallStatus(shared, [{ name: 'RealTech' }]);
        assert.equal(shared._matchedLocal, null, '共享仓库尾名不能证明当前产品已安装');
        const sidebar = { name: 'NPC侧边栏头像', githubUrl: 'https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL' };
        market.checkModInstallStatus(sidebar, [{ name: 'NPC侧边栏头像', repository: sidebar.githubUrl }]);
        assert.ok(sidebar._matchedLocal, '侧边栏头像本身的真实来源必须仍可识别');
        market.checkModInstallStatus(sidebar, [{ name: 'NPCAvatarsMod', repository: 'https://github.com/Eudemonism00/DOL-npcicon-mods' }]);
        assert.equal(sidebar._matchedLocal, null, '社交栏头像不能充当另一作者的侧边栏头像');
    }

    // 资产按产品系列选择，共享仓库查找当前条目的发布而非仓库latest。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const frameworkAssets = ['Simple.Framework.ver2.0.5.build_2.zip', 'Simple.Inventory.ver1.0.0.build_18.zip', 'simple.new.content.ver0.0.1.zip'].map(asset);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets).needsChoice, true);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets, '', { bootNames: ['Simple Framework'] }).assets[0].name, frameworkAssets[0].name);
        assert.equal(market.buildReleaseAssetPlan(['Foo1.0.zip', 'Bar99.0.zip'].map(asset)).candidates.length, 2, '不能跨产品比较版本');
        assert.equal(market.buildReleaseAssetPlan([asset('ResourcePack.zip')]).assets.length, 1, '独立资源主包不能重复安装');
        const companions = market.buildReleaseAssetPlan(['Main1.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip'].map(asset));
        assert.deepEqual(Array.from(companions.assets, item => item.name), ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(market.buildReleaseAssetPlan(['source-code.zip', 'app.apk.zip', 'Other.7z', 'Other.rar'].map(asset)).assets.length, 0);
        assert.equal(market.buildReleaseAssetPlan([asset('Foo Mobile 1.0.zip'), asset('Foo Desktop 1.0.zip')]).assets[0].name, 'Foo Desktop 1.0.zip');
        const repo = 'https://github.com/Fixture/Shared';
        const urls = [];
        sb.fetch = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ['Other', 'Foo', 'Bar'].map((name, index) => ({
            tag_name: `product-${index}`, html_url: `${repo}/releases/tag/product-${index}`,
            assets: [{ name: `${name}1.0.zip`, browser_download_url: `${repo}/releases/download/product-${index}/${name}1.0.zip` }]
        })) }; };
        const mod = name => ({ name, bootNames: [name], githubUrl: repo, sharedRepository: true });
        assert.equal((await market.fetchModRelease(mod('Foo'))).assetName, 'Foo1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Bar'))).assetName, 'Bar1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Foo'))).fromCache, true);
        assert.equal(urls.length, 2, '同仓库不同条目缓存不能串包');
        assert.ok(urls.every(url => url.endsWith('/releases?per_page=100')));
        await assert.rejects(market.fetchModRelease(mod('Missing')), error => error.code === 'MANUAL_SOURCE');
        for (const suffix of ['/tree/main', '/blob/main/mod.zip', '/issues/1', '/releases/latest/extra']) {
            await assert.rejects(market.fetchModRelease({ githubUrl: repo + suffix }), error => error.code === 'MANUAL_SOURCE');
        }
        await assert.rejects(market.fetchModRelease({ githubUrl: 'https://fake.github.com/Fixture/Shared' }), /无法解析/);
        sb.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1', assets: ['Foo1.0.zip', 'Bar2.0.zip'].map(name => ({ name, browser_download_url: `${repo}/releases/download/v1/${name}` })) }) });
        assert.equal((await market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Foo1.0.zip` })).assetName, 'Foo1.0.zip');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Missing.zip` }), error => error.code === 'RELEASE_NOT_FOUND', '指定附件消失时不能改装其他文件');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/tag/another` }), error => error.code === 'RELEASE_NOT_FOUND', '返回标签与指定标签不同必须停止');
        sb.fetch = async () => { const error = new Error('取消'); error.name = 'AbortError'; throw error; };
        await assert.rejects(market.fetchModRelease(mod('Foo'), { useCache: false }), error => error.name === 'AbortError', '取消请求不能继续使用离线包');
    }

    // 手选仍保留匹配资源；需手动来源的条目直接解释原因，不进入自动导入。
    {
        const sb = loadMarket();
        sb.Blob = Blob;
        sb.modHubGetGui = () => ({});
        sb.modHubShowToast = () => {};
        sb.modHubEscapeHtml = value => value;
        const installedFiles = [];
        sb.modHubHandleAddMod = async input => { installedFiles.push(...Array.from(input.files || input, file => file.name)); return true; };
        sb.modHubConfirm = async () => 'asset:0';
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob(['data']) });
        const availableAssets = ['Main1.0.zip', 'Bar2.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip']
            .map(name => ({ name, downloadUrl: `https://example.test/${name}` }));
        assert.equal(await sb.modHubMarket.downloadAndInstallMod({ name: '手选测试' }, 'ddlc', { askRestart: false, releaseInfo: {
            requiresManualSelection: true, version: '99.0', candidateAssets: availableAssets.slice(0, 2), availableAssets
        } }), true);
        assert.deepEqual(installedFiles, ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(JSON.parse(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'))['手选测试'], '1.0', '手选低版本不能被记录为仓库最高版本');
        const dialogs = [];
        sb.modHubConfirm = async dialog => { dialogs.push(dialog); return false; };
        sb.fetch = async () => { throw new Error('文件页不应访问API'); };
        const manual = { name: '分支模组', githubUrl: 'https://github.com/Fixture/Repo/tree/main' };
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(manual), false);
        assert.equal(dialogs.at(-1).confirmText, '打开主页');
        assert.ok(dialogs.at(-1).message.includes('文件或分支'));
        assert.equal(installedFiles.length, 2, '手动来源不能调用安装接口');
        let batchFailure = '';
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(manual, 'ddlc', { batchMode: true, onFailure: reason => { batchFailure = reason; } }), false);
        assert.ok(batchFailure.includes('文件或分支'));
        assert.equal(dialogs.length, 1, '批量应记录原因且不弹单装对话框');
    }

    /* =========================================================================
     * 11. 模组安装分流：市场安装「稍后重载」不得切走页签
     * ========================================================================= */
    {
        // 11.1 市场安装路径必须声明 keepCurrentTab（防止回归）
        const marketSource = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-market.js'), 'utf8');
        const marketCall = marketSource.match(/modHubHandleAddMod\([^)]*?\{[\s\S]*?\}\)/);
        assert.ok(marketCall && marketCall[0].includes('keepCurrentTab: true'), '市场安装调用必须传递 keepCurrentTab: true');
        // 11.2 管理页本地导入路径不得携带 keepCurrentTab（保持原有高亮跳转设计）
        const managerSource = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-manager.js'), 'utf8');
        const importCalls = managerSource.match(/modHubHandleAddMod\([^)]*?\{[^}]*?\}\)/g) || [];
        assert.ok(importCalls.length >= 4, '管理器本地导入调用点必须存在');
        for (const call of importCalls) {
            assert.ok(!call.includes('keepCurrentTab'), `本地导入不得携带 keepCurrentTab: ${call.slice(0, 80)}`);
        }
        // 11.3 分支结构断言：keepCurrentTab 分支只提示不跳页，本地导入分支保留原高亮跳转设计
        const keepBranch = managerSource.match(/else if \(options\.keepCurrentTab\) \{[\s\S]*?\} else \{/);
        assert.ok(keepBranch, '稍后重载分支必须包含 keepCurrentTab 专用处理');
        assert.ok(!keepBranch[0].includes("modHubSwitchTab('模组管理')"), 'keepCurrentTab 分支严禁切换页签');
        const legacyBranch = managerSource.match(/\} else \{\s*window\._modHubHighlightMods[\s\S]*?modHubSwitchTab\('模组管理'\)/);
        assert.ok(legacyBranch, '本地导入分支必须保留「切换管理页并高亮」的原有设计');
    }

    /* =========================================================================
     * 12. 模组市场已移除仓库（404）与无 Release 更新判定防护
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;

        // 12.1 作者已移除 GitHub 仓库（isDeadRepo）时，即使远程有更高版本，也绝不误报更新，返回 up_to_date
        const deadRepoMod = {
            name: '织境空间·料理扩展',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '0.4.19',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const profiles = [{
            name: 'WovenRealmCookingAddon',
            version: '0.1.626',
            displayNames: ['WovenRealmCookingAddon', '织境空间-料理扩展', '织境空间·料理扩展'],
            normalizedNames: ['wovenrealmcookingaddon', '织境空间料理扩展'],
            repos: ['wovenrealmcookingaddon'],
            repositoryKeys: ['kanna-hanabi/wovenrealm']
        }];
        const deadStatus = market.checkModInstallStatus(deadRepoMod, profiles);
        assert.equal(deadStatus, 'up_to_date', '作者已移除仓库的模组本地已安装时必须判定为已是最新（up_to_date），严禁误报更新');

        // 12.2 仓库失效且未安装时，无外部链接必须返回 unavailable，有外部链接返回 external_only
        const deadNotInstalled = {
            name: '某个已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadNotInstalled, []), 'unavailable', '已删库且无外部链接未安装模组必须返回 unavailable');
        const deadWithOtherUrl = {
            name: '带网盘的已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            otherUrl: 'https://example.com/pan',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadWithOtherUrl, []), 'external_only', '已删库但有外部链接未安装模组必须返回 external_only');

        // 12.3 无有效 Release 产物且版本来源为 Wiki 时，不误报更新
        const wikiOnlyMod = {
            name: '纯Wiki旧版本模组',
            githubUrl: 'https://github.com/some-author/no-release-mod',
            version: '2.0.0',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const localModProfiles = [{
            name: '纯Wiki旧版本模组',
            version: '1.0.0',
            displayNames: ['纯Wiki旧版本模组'],
            normalizedNames: ['纯wiki旧版本模组'],
            repos: ['no-release-mod'],
            repositoryKeys: ['some-author/no-release-mod']
        }];
        assert.equal(market.checkModInstallStatus(wikiOnlyMod, localModProfiles), 'up_to_date', '无可用 Release 的 Wiki 参考版本模组不得误报 update_available');

        // 12.4 正常具备 GitHub Release 且版本更高时，必须正确触发 update_available
        const validReleaseMod = {
            name: '正常可更新模组',
            githubUrl: 'https://github.com/normal-author/good-mod',
            version: '2.0.0',
            versionSource: 'github',
            releaseUrl: 'https://github.com/normal-author/good-mod/releases/tag/v2.0.0'
        };
        const validLocalProfiles = [{
            name: '正常可更新模组',
            version: '1.0.0',
            displayNames: ['正常可更新模组'],
            normalizedNames: ['正常可更新模组'],
            repos: ['good-mod'],
            repositoryKeys: ['normal-author/good-mod']
        }];
        assert.equal(market.checkModInstallStatus(validReleaseMod, validLocalProfiles), 'update_available', '具有真实 Release 的更高版本模组必须正常触发 update_available');

        // 12.5 同作者多个模组自动识别为失效（织境空间主模组与场景互动扩展）
        const uiMod = {
            name: '织境空间-场景互动扩展',
            author: '璐子',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealmUI',
            version: '0.8.7',
            versionSource: 'wiki',
            releaseUrl: null
        };
        assert.ok(market.isDeadRepo(uiMod.githubUrl, uiMod), '同作者扩展模组仓库 WovenRealmUI 必须被识别为已失效');
        assert.equal(market.checkModInstallStatus(uiMod, []), 'unavailable', '已失效的场景互动扩展未安装时必须返回 unavailable');

        // 12.6 样式表必须包含 .badge-dead-repo 红色标签样式
        const cssContent = readStyles();
        assert.ok(cssContent.includes('.badge-dead-repo'), 'CSS 必须定义 .badge-dead-repo 红色标签样式');

        // 12.7 市场脚本中必须导出并正确引用 badge-dead-repo
        const marketJs = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-market.js'), 'utf8');
        assert.ok(marketJs.includes('badge-dead-repo'), '市场卡片渲染必须应用 badge-dead-repo');

        // 12.8 消除误诊：单字符短横线合法仓库（如 dawalizhang/- 与 lingyu230514/-）严禁被误判为失效
        const ranchMod = {
            name: '牧场与你相识的故事',
            author: '海苔大福&达瓦里张&多玩',
            githubUrl: 'https://github.com/dawalizhang/-',
            version: '1.0.0'
        };
        const newSpaceMod = {
            name: '全新空间',
            author: '多玩',
            githubUrl: 'https://github.com/lingyu230514/-',
            version: '1.04'
        };
        assert.equal(market.isDeadRepo(ranchMod.githubUrl, ranchMod), false, '牧场与你相识的故事严禁被误判为源失效');
        assert.equal(market.isDeadRepo(newSpaceMod.githubUrl, newSpaceMod), false, '全新空间严禁被误判为源失效');
        assert.equal(market.checkModInstallStatus(ranchMod, []), 'not_installed', '牧场与你相识的故事未安装时必须为 not_installed 允许下载');
        assert.equal(market.checkModInstallStatus(newSpaceMod, []), 'not_installed', '全新空间未安装时必须为 not_installed 允许下载');

        // 12.9 历史存储误诊自愈清洗能力断言
        sb.localStorage.setItem('modhub_market_dead_repos_v1', JSON.stringify(['dawalizhang/-', 'kanna-hanabi/wovenrealm']));
        const cleanedList = market.getDeadRepos();
        assert.ok(!cleanedList.includes('dawalizhang/-'), '活跃白名单仓库必须自动从失效存储中清洗剔除');
        assert.ok(cleanedList.includes('kanna-hanabi/wovenrealm'), '真正失效的仓库必须继续保留');

        // 12.10 本地安装 GuideToMe 等模组被市场准确识别为已安装
        const mouthMod = {
            name: '控制NPC嘴部',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/DOL-GuideToMe',
            version: '1.1.0'
        };
        const simsMod = {
            name: '模拟人生',
            author: '丧心',
            githubUrl: 'https://github.com/MissedHeart/Degrees-of-Lewdity-DolSims',
            version: '0.8.1.7'
        };
        const wraithMod = {
            name: '怨灵的倒影',
            author: '水墨儿（悠飘过去了）',
            githubUrl: 'https://github.com/Water2311/WraithsReflection/',
            version: '1.3.0'
        };
        const busMod = {
            name: '公交车防骚扰',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/NoBusHarassmentMod',
            version: '1.0.3'
        };

        const testProfiles = [
            { name: 'GuideToMe', version: '1.1.0' },
            { name: 'DoLSims', version: '0.8.1.7' },
            { name: 'Wraith\'sReflection', version: '1.3.0' },
            { name: 'NoBusHarassmentMod', version: '1.0.3' },
            { name: 'ModHub', version: '1.0.2' }
        ];

        assert.equal(market.checkModInstallStatus(mouthMod, testProfiles), 'up_to_date', 'GuideToMe 本地已安装时，市场控制NPC嘴部必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(simsMod, testProfiles), 'up_to_date', 'DoLSims 本地已安装时，市场模拟人生必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(wraithMod, testProfiles), 'up_to_date', 'Wraith\'sReflection 本地已安装时，市场怨灵的倒影必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(busMod, testProfiles), 'up_to_date', 'NoBusHarassmentMod 本地已安装时，市场公交车防骚扰必须识别为 up_to_date');

        // 12.11 管理页 modHubGetModSubtext 智能副标题与简介回填测试
        const fullSb = loadManager();
        loadScripts(fullSb, ['javascript/modhub-market.js']);

        assert.equal(fullSb.window.modHubGetModSubtext('GuideToMe', { bootJson: { version: '1.1.0' } }), '控制NPC嘴部', 'GuideToMe 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('DoLSims', { bootJson: { version: '0.8.1.7' } }), '模拟人生', 'DoLSims 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('Wraith\'sReflection', { bootJson: { version: '1.3.0' } }), '怨灵的倒影', 'Wraith\'sReflection 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('ModHub', { bootJson: bootJson }), '模组管理器与市场套件', 'ModHub 必须显示自身副标题');

        // 12.12 动态市场回填测试：未知本地模组通过市场条目自动回填中文名称或简介
        fullSb.window.modHubMarket.findMarketModByLocalName = (localName) => {
            if (localName === 'SomeUnknownMod') {
                return { name: '未知超强扩展', desc: '用于增强各种交互功能的拓展' };
            }
            return null;
        };
        assert.equal(fullSb.window.modHubGetModSubtext('SomeUnknownMod', { bootJson: { version: '1.0.0' } }), '未知超强扩展', '未知模组必须能联动市场数据自动回填副标题');

        // 12.13 模组市场与本地模组防混淆测试（针对 ImageLoaderHook 与 D.O.L.I 字母拼合假阳性拦截）
        const doliMarketMod = {
            name: 'D.O.L.I',
            author: 'ArsNativa',
            githubUrl: 'https://github.com/ArsNativa/Degrees-of-Lewdity-Intelligence',
            repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence'],
            version: '0.2.3'
        };

        const imageHookProfiles = [
            {
                name: 'ModLoader DoL ImageLoaderHook',
                version: '2.101.0',
                displayNames: ['ModLoader DoL ImageLoaderHook'],
                normalizedNames: ['modloaderdolimageloaderhook'],
                repos: ['modloaderdolimageloaderhook'],
                repositoryKeys: []
            },
            {
                name: 'ModSubUiAngularJs',
                version: '1.0.0',
                displayNames: ['ModSubUiAngularJs'],
                normalizedNames: ['modsubuiangularjs'],
                repos: ['modsubuiangularjs'],
                repositoryKeys: []
            }
        ];

        // 仅安装 ImageLoaderHook 时，D.O.L.I 必须准确识别为 not_installed
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, imageHookProfiles),
            'not_installed',
            '本地仅安装 ImageLoaderHook 时，市场中的 D.O.L.I 必须为 not_installed，绝不能误判为 up_to_date'
        );

        // findMarketModByLocalName 反查时，ImageLoaderHook 绝不能反向匹配到 D.O.L.I
        const reversedMarketMod = market.findMarketModByLocalName('ModLoader DoL ImageLoaderHook', [doliMarketMod]);
        assert.equal(
            reversedMarketMod,
            null,
            'ImageLoaderHook 在模组市场反向检索中必须返回 null，不得误匹配到 D.O.L.I'
        );

        // 当本地真正安装了 DOLI 时，必须能准确匹配并判定为已是最新
        const realDoliProfiles = [
            {
                name: 'DOLI',
                version: '0.2.2',
                displayNames: ['DOLI', 'D.O.L.I', 'Degrees-of-Lewdity-Intelligence'],
                normalizedNames: ['doli', 'degreesoflewdityintelligence'],
                repos: ['doli', 'degreesoflewdityintelligence'],
                repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence']
            }
        ];
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, realDoliProfiles),
            'up_to_date',
            '本地真正安装 DOLI 时，市场中的 D.O.L.I 必须准确识别为 up_to_date'
        );
        const realMatchedMarket = market.findMarketModByLocalName('DOLI', [doliMarketMod]);
        assert.ok(
            realMatchedMarket && realMatchedMarket.name === 'D.O.L.I',
            '本地 DOLI 必须能准确反向找到市场中的 D.O.L.I'
        );
    }

};
