// 无数字版号的合法发布、发布时间排序和默认选版边界。
const { assert, loadMarket, loadScripts } = require('./helpers');

module.exports = async function() {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    sb.StartConfig = { version: '0.5.12.13' };
    const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
    const repository = 'https://github.com/ReleaseSelectionFixture/SharedProducts';
    const [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 61, mods: [{
        id: 'release-selection-alpha', identityId: 'release-selection-alpha', name: '通用产品甲',
        bootNames: ['GenericFeatureAlpha'], aliases: ['通用产品甲'], repositories: [],
        repositoryKeys: ['ReleaseSelectionFixture/SharedProducts'], sharedRepository: true,
        sourceUrl: repository + '/releases/latest', githubUrl: repository + '/releases/latest',
        catalogSource: 'community', autoInstall: true
    }] });
    const release = (tagName, publishedAt, names = ['GenericFeatureAlpha.zip'], extra = {}) => ({
        tagName, name: '发布说明', ...(publishedAt === undefined ? {} : { publishedAt }),
        assets: names.map(name => ({ name, size: 100, downloadUrl: `${repository}/releases/download/${tagName}/${name}` })),
        ...extra
    });
    const candidates = (releases, target = mod) => versions.buildCandidates(target, { id: target.id, sourceUrl: target.githubUrl, releases });
    const selection = (releases, target = mod, options) => versions.rankCandidates(target, candidates(releases, target), options);

    // 任意非数字固定标签的唯一产品包可以预选，适配证据仍是未知。
    const pinned = { ...mod, githubUrl: repository + '/releases/tag/alpha-channel', sourceUrl: repository + '/releases/tag/alpha-channel' };
    const pinnedHistory = [release('alpha-channel', '2026-06-14T18:30:00Z')];
    const [only] = candidates(pinnedHistory, pinned);
    const defaults = selection(pinnedHistory, pinned);
    assert.equal(only.version, '');
    assert.equal(only.tagName, 'alpha-channel');
    assert.equal(defaults.defaultKey, only.candidateKey);
    assert.equal(defaults.recommendedKey, '');
    assert.equal(defaults.defaultRisk, true);
    assert.match(defaults.defaultReason, /安装前需确认适配风险/);
    assert.equal(only.compatibility.evidence, 'unknown');
    assert.equal(versions.getDefaultSelection(pinned, [only], { localVersion: '0.1' }).defaultKey, '');
    assert.equal(versions.getDefaultSelection(pinned, [only], { updateOnly: true, localVersion: '0.1' }).defaultKey, '');

    // 标签前缀不能令完整数字版号被截成后半段；日期和 DoL 标签不冒充模组版号。
    for (const [tag, expected] of [['Feature0.1.5', '0.1.5'], ['v0.5.1', '0.5.1'], ['Feature1.2026.06.14', '1.2026.06.14'],
        ['2026-06-14', ''], ['date-2026-06-14', ''], ['20260614', ''], ['date-2026.06.14', ''],
        ['DoL0.5.12.13', ''], ['for-DoL-v0.5.12.13', '']]) {
        const [candidate] = candidates([release(tag, '2026-06-14T18:30:00Z')]);
        assert.equal(candidate.version, expected, `标签 ${tag} 应保持完整且诚实的模组版号`);
    }
    assert.equal(candidates([release('channel', '2026-06-14T18:30:00Z', undefined, { name: '2026.06.14' })])[0].version, '');

    // 共享同标签发布不能给本品借用另一个产品的文件名、标题或全局标签版号。
    const mixedNames = ['GenericFeatureAlpha.zip', 'GenericFeatureBeta-v99.0.zip'];
    for (const [tag, name] of [['channel', 'GenericFeatureBeta V99.0'], ['channel', 'v99.0'],
        ['v99.0', '发布说明'], ['channel', 'GenericFeatureAlpha included; GenericFeatureBeta V99.0']]) {
        const [candidate] = candidates([release(tag, '2026-06-14T18:30:00Z', mixedNames, { name, version: '99.0' })]);
        assert.equal(candidate.version, '', `本品不能借用 ${name} / ${tag} 的全局版号`);
        assert.equal(candidate.tagName, tag);
        assert.equal(candidate.updateDate, '2026-06-15');
    }
    for (const name of ['GenericFeatureAlphaV0.1.5', 'GenericFeatureAlpha V0.1.5', '通用产品甲 V0.1.5']) {
        const [candidate] = candidates([release('v99.0', '2026-06-14T18:30:00Z', mixedNames, { name, version: '99.0' })]);
        assert.equal(candidate.version, '0.1.5', '本品名称直接绑定的完整标题版号可以采用');
    }
    const [ownAssetVersion] = candidates([release('v99.0', '2026-06-14T18:30:00Z',
        ['GenericFeatureAlpha-v2.0.zip', 'GenericFeatureBeta-v99.0.zip'], { name: 'GenericFeatureAlpha V0.1.5', version: '99.0' })]);
    assert.equal(ownAssetVersion.version, '2.0', '本品包内版号优先于标题和其他产品');
    const [resourceOnly] = candidates([release('v0.1.5', '2026-06-14T18:30:00Z',
        ['GenericFeatureAlpha.zip', 'GenericFeatureBeta-resource-pack-v99.0.zip'])]);
    assert.equal(resourceOnly.version, '0.1.5', '资源附包不构成另一个产品的主安装包');
    const [pairedAudio] = candidates([release('v0.1.5', '2026-06-14T18:30:00Z',
        ['GenericFeatureAlpha.zip', 'GenericFeatureBeta-v99.0.zip', 'GenericFeatureBeta-audio-pack-v99.0.zip'])
    ]);
    assert.equal(pairedAudio.version, '', '别品主包即使另有配对音频包仍不能借用其全局版号');
    const [ownPairedAudio] = candidates([release('v99.0', '2026-06-14T18:30:00Z',
        ['GenericFeatureAlpha-v0.1.5.zip', 'GenericFeatureAlpha-audio-pack-v0.1.5.zip'])]);
    assert.equal(ownPairedAudio.version, '0.1.5');
    assert.equal(ownPairedAudio.optionalAssets.length, 1, '真正同系列同版音频仍保持可选附包');
    const [standaloneAudio] = candidates([release('v99.0', '2026-06-14T18:30:00Z',
        ['GenericFeatureAlpha.zip', 'GenericFeatureBeta-audio-pack-v99.0.zip'], { name: 'v99.0', version: '99.0' })]);
    assert.equal(standaloneAudio.version, '', '未配对的独立音频产品必须阻止借用全局版号');

    // 无数字版号时，完整发布时刻决定顺序；同日倒序输入不影响结果。
    const morning = release('morning-channel', '2026-06-14T01:00:00Z');
    const evening = release('evening-channel', '2026-06-14T09:00:00Z');
    const [lateUtc] = candidates([release('late-channel', '2026-06-14T22:00:00Z')]);
    assert.equal(lateUtc.updateDate, '2026-06-15', '展示日期沿用目录北京时间，不能因UTC跨日少一天');
    assert.equal(lateUtc.publishedAt, '2026-06-14T22:00:00Z', '排序仍保留真实UTC发布时刻');
    assert.equal(candidates([release('undated-channel', undefined)])[0].updateDate, '', '缺发布日期不能借用最新目录日期');
    for (const input of [[morning, evening], [evening, morning]]) {
        const ranked = selection(input);
        assert.equal(ranked.candidates[0].tagName, 'evening-channel');
        assert.equal(ranked.candidates.find(candidate => candidate.candidateKey === ranked.defaultKey).tagName, 'evening-channel');
        assert.equal(ranked.defaultRisk, true);
    }
    const numericOlder = release('v2.0', '2026-06-14T01:00:00Z');
    for (const input of [[numericOlder, evening], [evening, numericOlder]]) {
        const ranked = selection(input);
        assert.equal(ranked.candidates.find(candidate => candidate.candidateKey === ranked.defaultKey).tagName, 'evening-channel', '混合版号不能把未知新版当零');
    }
    assert.equal(selection([morning, release('other-channel', morning.publishedAt)]).defaultKey, '', '同一最高时刻有不同附件来源时必须手选');
    assert.equal(selection([morning, release('undated-channel', undefined)]).defaultKey, '', '未知版号缺少日期时不能确定两个发布的先后');
    assert.equal(selection([release('first-channel', undefined), release('second-channel', undefined)]).defaultKey, '');
    assert.ok(selection([release('only-channel', undefined)]).defaultKey, '唯一合法包不需要伪造日期或版号');
    const oldCachedCandidates = candidates([morning, evening]).map(candidate => ({ ...candidate, publishedAt: '' }));
    assert.equal(versions.getDefaultSelection(mod, oldCachedCandidates).defaultKey, '', '旧的仅日期候选不能分辨同日先后');

    // 所有版号可比较时保留数字排序，缺日期不能挡住已明确更高的版号。
    const numeric = selection([release('v2.9', '2026-06-15T00:00:00Z'), release('v2.10', undefined)]);
    assert.equal(numeric.candidates.find(candidate => candidate.candidateKey === numeric.defaultKey).version, '2.10');
    const sameVersion = selection([release('v2.10', '2026-06-14T09:00:00Z'), release('build-v2.10', '2026-06-14T22:00:00Z')]);
    assert.equal(sameVersion.candidates.find(candidate => candidate.candidateKey === sameVersion.defaultKey).tagName, 'build-v2.10');
    assert.equal(selection([release('v2.10', '2026-06-14T22:00:00Z', ['GenericFeatureAlpha.zip', 'GenericFeatureAlpha.modpack'])]).defaultKey, '', '同版不同主包格式仍有歧义');
    assert.equal(versions.getDefaultSelection(mod, numeric.candidates, { updateOnly: true, localVersion: 'unknown-installed' }).defaultKey, '');
    assert.equal(versions.getDefaultSelection(mod, numeric.candidates, { updateOnly: true, localVersion: '3.0' }).defaultKey, '');

    // 默认选择只接收实际归属和固定标签筛选后的候选。
    for (const invalid of [release('other-tag', '2026-06-14T22:00:00Z'),
        release('alpha-channel', '2026-06-14T22:00:00Z', ['GenericFeatureBeta.zip']),
        release('alpha-channel', '2026-06-14T22:00:00Z', undefined, { draft: true }),
        release('alpha-channel', '2026-06-14T22:00:00Z', undefined, { prerelease: true }),
        release('alpha-channel', '2026-06-14T22:00:00Z', undefined, { assets: [{ name: 'GenericFeatureAlpha.zip', size: 100,
            downloadUrl: 'https://github.com/OtherAuthor/SharedProducts/releases/download/alpha-channel/GenericFeatureAlpha.zip' }] })]) {
        assert.equal(candidates([invalid], pinned).length, 0);
        assert.equal(selection([invalid], pinned).defaultKey, '');
    }
    const mixedAssets = candidates([release('alpha-channel', '2026-06-14T18:30:00Z', ['GenericFeatureAlpha.zip', 'GenericFeatureBeta.zip'])], pinned);
    assert.deepEqual(Array.from(mixedAssets, candidate => candidate.assetName), ['GenericFeatureAlpha.zip']);
    assert.equal(versions.getLatestReleaseCandidate({ ...pinned, githubUrl: pinned.githubUrl.replace('ReleaseSelectionFixture', 'OtherAuthor') }, mixedAssets), null);
    assert.equal(versions.getDefaultSelection(mod, [...mixedAssets, { ...mixedAssets[0], seriesKey: 'another-product' }]).defaultKey, '');
    const unsupported = mixedAssets.map(candidate => ({ ...candidate, compatibility: { status: 'incompatible', evidence: 'declaration' } }));
    assert.equal(versions.getDefaultSelection(pinned, unsupported).defaultKey, '');
    assert.equal(unsupported[0].compatibility.status, 'incompatible');
    const supported = mixedAssets.map(candidate => ({ ...candidate, compatibility: { status: 'compatible', evidence: 'declaration' } }));
    const compatibleDefault = versions.rankCandidates(pinned, supported);
    assert.equal(compatibleDefault.defaultKey, supported[0].candidateKey);
    assert.equal(compatibleDefault.defaultRisk, false);

    // 身份变化使历史缓存签名失配；强制刷新仍跳过新签名的有效缓存。
    let requests = 0;
    sb.AbortController = AbortController;
    sb.fetch = async url => {
        assert.ok(String(url).includes('/mod-releases?'), '测试不得访问真实网络');
        requests++;
        return { ok: true, json: async () => ({ schemaVersion: 1, id: pinned.id, sourceUrl: pinned.githubUrl,
            page: 1, hasMore: false, communityRevision: market.getCommunityRevision(), fetchedAt: new Date().toISOString(), releases: pinnedHistory }) };
    };
    const previousIdentity = { ...pinned, bootNames: ['PreviousTechnicalIdentity'] };
    assert.equal(versions.buildCandidates(previousIdentity, await versions.fetchReleases(previousIdentity)).length, 0);
    assert.equal(versions.buildCandidates(pinned, await versions.fetchReleases(pinned)).length, 1);
    assert.equal(requests, 2, '身份更新后必须重新拉取历史');
    await versions.fetchReleases(pinned);
    assert.equal(requests, 2);
    await versions.fetchReleases(pinned, { useCache: false });
    assert.equal(requests, 3, '刷新上下文跳过有效历史缓存');
};
