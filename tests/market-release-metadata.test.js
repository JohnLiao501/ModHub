// 卡片版本、发布标签和发布日期的独立显示契约；不访问网络或安装模组。
const { assert, loadMarket, loadScripts, createStubElement } = require('./helpers');

const repository = 'https://github.com/MetadataFuture/SharedUtilities';
const definition = (id, boot, tag, extra = {}) => ({ id, identityId: id, name: id, bootNames: [boot],
    aliases: [id], repositories: [], repositoryKeys: ['MetadataFuture/SharedUtilities'], sharedRepository: true,
    catalogSource: 'community', autoInstall: true, contentType: 'package',
    sourceUrl: `${repository}/releases/tag/${tag}`, githubUrl: `${repository}/releases/tag/${tag}`,
    releaseUrl: `${repository}/releases/tag/${tag}`, versionSource: 'github', ...extra });

function setup() {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    sb.StartConfig = { version: '0.5.12.13' };
    const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubCategoryCapsules', 'modHubMarketStats']
        .map(id => [id, createStubElement()]));
    sb.document.getElementById = id => elements.get(id) || null;
    return { sb, cards: elements.get('modHubMarketCardsContainer') };
}

module.exports = async function () {
    // 未安装的市场条目只消费索引，也须显示作者真实发布标签和独立发布日期。
    {
        const { sb, cards } = setup();
        const mods = [
            definition('future-alpha', 'FutureAlpha', 'alpha-channel', { version: '', versionLabel: 'alpha-channel',
                updateDate: '2026-07-14', updateDateSource: 'github' }),
            definition('future-beta', 'FutureBeta', 'beta-0.1.5', { version: '0.1.5',
                updateDate: '2026-07-20', updateDateSource: 'github' }),
            definition('future-unknown', 'FutureUnknown', 'unmarked', { version: '', updateDate: null }),
        ];
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, communityRevision: 8, mods }) });
        await sb.modHubInitMarket(true);
        const alpha = cards.innerHTML.split('data-mod-name="future-alpha"')[1].split('data-mod-name=')[0];
        assert.ok(alpha.includes('最新版本：alpha-channel') && !alpha.includes('（发布标签，版号未标注）'));
        assert.ok(alpha.includes('发布: 2026-07-14'), '非数字发布仍显示真实发布日期');
        const beta = cards.innerHTML.split('data-mod-name="future-beta"')[1].split('data-mod-name=')[0];
        assert.ok(beta.includes('最新版本：v0.1.5') && beta.includes('发布: 2026-07-20'));
        const unknown = cards.innerHTML.split('data-mod-name="future-unknown"')[1].split('data-mod-name=')[0];
        assert.ok(unknown.includes('最新版本：未知') && !unknown.includes('发布:'), '缺失元数据时不借用其它产品');
        assert.ok(cards.innerHTML.indexOf('data-mod-name="future-beta"') < cards.innerHTML.indexOf('data-mod-name="future-alpha"'),
            '市场日期排序采用产品自身发布，而非同仓库顺序');
    }

    // 直连 GitHub 的回退与历史选版使用相同身份、固定标签和完整版本 token。
    {
        const { sb } = setup();
        const raw = definition('future-direct', 'FutureDirect', 'FD0.1.5');
        const [mod] = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 9, mods: [raw] });
        let releaseName = 'FutureDirectV0.1.5';
        let publishedAt = '2026-07-19T18:10:31Z';
        let fetchCount = 0;
        sb.fetch = async url => {
            fetchCount++;
            assert.equal(String(url), 'https://api.github.com/repos/MetadataFuture/SharedUtilities/releases/tags/FD0.1.5');
            return { ok: true, json: async () => ({ tag_name: 'FD0.1.5', name: releaseName,
                html_url: `${repository}/releases/tag/FD0.1.5`, published_at: publishedAt,
                assets: [{ name: 'FutureDirect.zip', size: 1234,
                    browser_download_url: `${repository}/releases/download/FD0.1.5/FutureDirect.zip` },
                    { name: 'FutureOther-v99.zip', size: 2345,
                        browser_download_url: `${repository}/releases/download/FD0.1.5/FutureOther-v99.zip` }] }) };
        };
        const release = await sb.modHubMarket.fetchModRelease(mod);
        assert.equal(release.version, '0.1.5', '完整版号不能截成1.5，也不能借用其它产品99');
        assert.equal(release.updateDate, '2026-07-20');
        assert.equal(release.publishedAt, '2026-07-19T18:10:31Z');
        assert.equal(release.updateDateSource, 'github');
        assert.equal((await sb.modHubMarket.fetchModRelease(mod)).fromCache, true);
        assert.equal(fetchCount, 1, '当前格式的精确标签缓存可以复用');
        const key = 'modhub_market_rel_v2_MetadataFuture_SharedUtilities_tag_FD0.1.5';
        const cached = JSON.parse(sb.localStorage.getItem(key));
        cached.data.assetPlanVersion = 4;
        cached.data.version = '1.5';
        delete cached.data.updateDateSource;
        sb.localStorage.setItem(key, JSON.stringify(cached));
        const corrected = await sb.modHubMarket.fetchModRelease(mod);
        assert.equal(corrected.version, '0.1.5');
        assert.equal(fetchCount, 2, '旧格式缓存应重新解析，不沿用截断版号');
        releaseName = 'FutureOther V99.0';
        publishedAt = undefined;
        mod.updateDate = '2026-07-18';
        mod.updateDateSource = 'wiki';
        const isolated = await sb.modHubMarket.fetchModRelease(mod, { useCache: false });
        assert.equal(isolated.version, '', '固定标签下的共享发布也不能借其他产品版号');
        assert.equal(isolated.updateDate, '2026-07-18');
        assert.equal(isolated.updateDateSource, 'wiki', '缺发布日时应保留目录日期来源');
    }

    // 旧目录元数据尚未更新时，已校验的本产品历史可补显示；过期签名不可补显示。
    {
        const { sb, cards } = setup();
        const raw = definition('future-history', 'FutureHistory', 'stable-channel', { version: '' });
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [{ name: 'FutureHistory',
            bootJson: { name: 'FutureHistory', version: '0.1', repository } }], getModListNameNoAlias: () => ['FutureHistory'] } });
        sb.modHubGetModInfo = () => ({ bootJson: { name: 'FutureHistory', version: '0.1', repository } });
        sb.fetch = async url => {
            if (String(url).includes('/mod-releases?')) return { ok: true, json: async () => ({ schemaVersion: 1,
                id: raw.id, sourceUrl: raw.githubUrl, page: 1, hasMore: false, communityRevision: 10,
                fetchedAt: new Date().toISOString(), releases: [{ tagName: 'stable-channel', name: 'FutureHistory',
                    publishedAt: '2026-07-22T12:30:00Z', assets: [{ name: 'FutureHistory.zip', size: 1234,
                        downloadUrl: `${repository}/releases/download/stable-channel/FutureHistory.zip` }] }] }) };
            return { ok: true, json: async () => ({ schemaVersion: 1, communityRevision: 10, mods: [raw] }) };
        };
        await sb.modHubInitMarket(true);
        const mod = sb.modHubMarket.getMarketMods()[0];
        await sb.modHubMarket.getModUpdateInfo(mod).promise;
        sb.modHubMarket.renderMarketCards();
        assert.ok(cards.innerHTML.includes('最新版本：stable-channel') && !cards.innerHTML.includes('（发布标签，版号未标注）'));
        assert.ok(cards.innerHTML.includes('发布: 2026-07-22'));
        assert.equal(mod.version, '', '显示发布标签不能修改数字版本或冒充包内版本');
        mod._updateCheck = { signature: '过期身份签名', latestRelease: { version: '99.0', updateDate: '2099-12-31' } };
        // 普通重绘会重新核对当前签名；旧来源元数据不应进入卡片。
        sb.modHubMarket.renderMarketCards();
        assert.ok(!cards.innerHTML.includes('v99.0') && !cards.innerHTML.includes('2099-12-31'));
    }
    // 目录更新时间可作缺失发布日的后备，但应保持 Wiki 日期来源。
    {
        const { sb, cards } = setup();
        const raw = definition('future-date-fallback', 'FutureDateFallback', 'release0.2', {
            version: '0.1', updateDate: '2026-07-21', updateDateSource: 'wiki' });
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [{ name: 'FutureDateFallback',
            bootJson: { name: 'FutureDateFallback', version: '0.1', repository } }],
            getModListNameNoAlias: () => ['FutureDateFallback'] } });
        sb.modHubGetModInfo = () => ({ bootJson: { name: 'FutureDateFallback', version: '0.1', repository } });
        sb.fetch = async url => {
            if (String(url).includes('/mod-releases?')) return { ok: true, json: async () => ({ schemaVersion: 1,
                id: raw.id, sourceUrl: raw.githubUrl, page: 1, hasMore: false, communityRevision: 11,
                fetchedAt: new Date().toISOString(), releases: [{ tagName: 'release0.2', name: 'FutureDateFallback',
                    assets: [{ name: 'FutureDateFallback.zip', size: 1234,
                        downloadUrl: `${repository}/releases/download/release0.2/FutureDateFallback.zip` }] }] }) };
            return { ok: true, json: async () => ({ schemaVersion: 1, communityRevision: 11, mods: [raw] }) };
        };
        await sb.modHubInitMarket(true);
        const mod = sb.modHubMarket.getMarketMods()[0];
        await sb.modHubMarket.getModUpdateInfo(mod).promise;
        sb.modHubMarket.renderMarketCards();
        assert.ok(cards.innerHTML.includes('最新版本：v0.2'));
        assert.ok(cards.innerHTML.includes('更新: 2026-07-21') && !cards.innerHTML.includes('发布: 2026-07-21'));
    }
};
