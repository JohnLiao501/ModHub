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

    // 单产品仓库的早期附件改名不能令明确的新主包失去默认选择。
    const renamedRepository = 'https://github.com/NewAuthorFixture/Feature-Complete';
    const renamedMod = { id: 'fresh-product-fixture', name: '新加入的独立产品', bootNames: [], aliases: [],
        githubUrl: renamedRepository, sharedRepository: false };
    const renamedRelease = (version, names) => ({ tagName: `v${version}`, name: version,
        publishedAt: '2026-10-14T00:00:00Z', assets: names.map(name => ({ name, size: 100,
            downloadUrl: `${renamedRepository}/releases/download/v${version}/${name}` })) });
    const renamedCandidates = versions.buildCandidates(renamedMod, [
        renamedRelease('2.10', ['Feature-Complete-v2.10.zip']),
        renamedRelease('2.9', ['Feature-Complete-v2.9.zip']),
        renamedRelease('1.0', ['Early-Feature.zip'])
    ]);
    assert.equal(new Set(renamedCandidates.map(candidate => candidate.seriesKey)).size, 2);
    const renamedSelection = versions.rankCandidates(renamedMod, renamedCandidates);
    assert.equal(renamedSelection.candidates.length, 3, '旧名称仍出现在手动历史列表中');
    assert.equal(renamedSelection.defaultKey, renamedCandidates[0].candidateKey, '精确仓库产品系列的最新数字版可默认选择');
    assert.equal(renamedSelection.defaultRisk, true, '附件归属不代替适配声明');
    assert.equal(versions.getLatestReleaseCandidate(renamedMod, renamedCandidates)?.candidateKey, renamedCandidates[0].candidateKey);
    assert.equal(versions.getLatestUpdateCandidate(renamedMod, renamedCandidates)?.candidateKey, renamedCandidates[0].candidateKey);
    assert.equal(versions.getDefaultSelection(renamedMod, renamedCandidates, { updateOnly: true, localVersion: '2.9' }).defaultKey, renamedCandidates[0].candidateKey);
    assert.equal(versions.getDefaultSelection(renamedMod, renamedCandidates, { localVersion: '3.0' }).defaultKey, '', '不自动降级');
    assert.equal(versions.getDefaultSelection({ ...renamedMod, bootNames: ['Feature-Complete', 'Early-Feature'] }, renamedCandidates).defaultKey,
        renamedCandidates[0].candidateKey, '登记在同一产品身份下的旧技术名可以参与历史归属核对');
    const sharedProduct = { ...renamedMod, sharedRepository: true, bootNames: ['Feature-Complete', 'Early-Feature'] };
    assert.equal(versions.getDefaultSelection(sharedProduct, renamedCandidates).defaultKey, renamedCandidates[0].candidateKey,
        '共享仓库的候选全部有本品精确技术身份时，历史改名也不应否决最新主包');
    assert.equal(versions.getDefaultSelection({ ...sharedProduct, bootNames: ['Feature-Complete'] }, renamedCandidates).defaultKey, '',
        '共享仓库不得凭仓库名或其他未核验系列猜产品归属');
    assert.equal(versions.getDefaultSelection({ ...sharedProduct, bootNames: [], aliases: ['Feature-Complete', 'Early-Feature'] }, renamedCandidates).defaultKey, '',
        '共享仓库中的展示别名不能替代精确技术身份');
    for (const unsafe of [
        { ...renamedMod, sharedRepository: true },
        { ...renamedMod, githubUrl: 'https://github.com/OtherFixture/Feature-Complete' }
    ]) assert.equal(versions.getDefaultSelection(unsafe, renamedCandidates).defaultKey, '', '共享产品、已登记不同系列或不同来源仍需手选');
    for (const alternate of [
        renamedRelease('2.10', ['Feature-Complete-v2.10.zip', 'Early-Feature-v2.10.zip']),
        renamedRelease('3.0', ['Early-Feature-v3.0.zip']),
        { ...renamedRelease('channel', ['Early-Feature.zip']), name: '无版号' }
    ]) {
        const ambiguous = versions.buildCandidates(renamedMod, [renamedRelease('2.10', ['Feature-Complete-v2.10.zip']), alternate]);
        assert.equal(versions.getDefaultSelection(renamedMod, ambiguous).defaultKey, '', '同版其他包型、其他系列新版或未知版号不能猜选');
    }
    const languageHistory = versions.buildCandidates(renamedMod, [
        renamedRelease('2.10', ['Feature-Complete-EN-v2.10.zip']),
        renamedRelease('2.9', ['Feature-Complete-CN-v2.9.zip'])
    ]);
    assert.equal(versions.getDefaultSelection(renamedMod, languageHistory).defaultKey, '', '不同语言不能借仓库名称归并');
    const matchedRename = renamedCandidates.map(candidate => ({ ...candidate, compatibility: { status: 'compatible', evidence: 'declaration' } }));
    assert.equal(versions.getLatestGameCandidate(renamedMod, matchedRename)?.candidateKey, renamedCandidates[0].candidateKey);
    const blockedRename = renamedCandidates.map(candidate => ({ ...candidate, compatibility: { status: 'incompatible', evidence: 'declaration' } }));
    assert.equal(versions.getDefaultSelection(renamedMod, blockedRename).defaultKey, '', '明确不适配仍不能预选');

    // 新缩写只有精确包体摘要和真实技术身份能扩大自动选版范围。
    const evidenceRepository = 'https://github.com/EvidenceAuthorFixture/SeparateRepository';
    const evidenceUrl = `${evidenceRepository}/releases/download/v2.10/AFX-v2.10.zip`;
    const evidenceRecord = { sourceUrl: evidenceUrl, sha256: 'b'.repeat(64), bootName: 'ActualFeature', version: '2.10', size: 100 };
    const evidenceMod = { id: 'evidence-product', name: '已登记技术产品', bootNames: ['ActualFeature'], githubUrl: evidenceRepository,
        verifiedReleaseAssets: [evidenceRecord] };
    const evidenceHistory = [
        { tagName: 'v2.10', name: '新附件', assets: [{ name: 'AFX-v2.10.zip', downloadUrl: evidenceUrl, size: 100, digest: `sha256:${evidenceRecord.sha256}` }] },
        { tagName: 'v1.0', name: '旧附件', assets: [{ name: 'ActualFeature-v1.0.zip', downloadUrl: `${evidenceRepository}/releases/download/v1.0/ActualFeature-v1.0.zip`, size: 100 }] }
    ];
    const evidenceCandidates = versions.buildCandidates(evidenceMod, evidenceHistory);
    assert.equal(evidenceCandidates[0].bootName, 'ActualFeature');
    assert.equal(versions.getDefaultSelection(evidenceMod, evidenceCandidates).defaultKey, evidenceCandidates[0].candidateKey,
        '精确摘要核验的新附件缩写可继承同一技术产品身份');
    assert.equal(versions.getDefaultSelection({ ...evidenceMod, verifiedReleaseAssets: [] }, versions.buildCandidates({ ...evidenceMod, verifiedReleaseAssets: [] }, evidenceHistory)).defaultKey,
        '', '没有附件证据不能从新缩写猜技术身份');
    const changedHistory = evidenceHistory.map((release, index) => index ? release : { ...release,
        assets: release.assets.map(asset => ({ ...asset, digest: `sha256:${'c'.repeat(64)}` })) });
    assert.equal(versions.getDefaultSelection(evidenceMod, versions.buildCandidates(evidenceMod, changedHistory)).defaultKey, '',
        '新包摘要变化不能沿用另一包体的技术身份扩大自动范围');

    // 每次发布只有一个纯版号主包时，文件名为空系列不代表产品来源不明。
    const anonymousHistory = [renamedRelease('2.10', ['_v2.10.zip']), renamedRelease('2.9', ['_v2.9.zip'])];
    const anonymousCandidates = versions.buildCandidates(renamedMod, anonymousHistory);
    assert.equal(anonymousCandidates.length, 2);
    assert.equal(anonymousCandidates[0].seriesKey, 'repository:newauthorfixture/feature-complete');
    const anonymousSelection = versions.rankCandidates(renamedMod, anonymousCandidates);
    assert.equal(anonymousSelection.defaultKey, anonymousCandidates[0].candidateKey, '匿名版号主包按数字最高正式发布默认选择');
    assert.equal(anonymousSelection.defaultRisk, true, '单仓库归属不能免除适配风险');
    assert.equal(anonymousSelection.recommendedKey, '', '未知适配不能标为适配推荐');
    const namelessMod = { ...renamedMod, name: '', bootNames: [], aliases: [], repositories: [] };
    const namelessCandidates = versions.buildCandidates(namelessMod, anonymousHistory);
    assert.equal(versions.getDefaultSelection(namelessMod, namelessCandidates).defaultKey, namelessCandidates[0].candidateKey,
        '匿名仓库唯一主包不依赖技术名或展示名猜测系列');
    const unversionedAnonymous = versions.buildCandidates(namelessMod, [renamedRelease('channel', ['.zip'])]);
    assert.equal(unversionedAnonymous.length, 1);
    assert.equal(unversionedAnonymous[0].version, '');
    assert.equal(unversionedAnonymous[0].seriesKey, '', '没有版号和文件名身份时不能仅凭仓库补充系列');
    assert.equal(versions.getDefaultSelection(namelessMod, unversionedAnonymous).defaultKey, '', '未知版号匿名附件不得默认');
    assert.equal(versions.getDefaultSelection(renamedMod, anonymousCandidates, { localVersion: '3.0' }).defaultKey, '', '匿名附件仍不能自动降级');
    assert.equal(versions.getDefaultSelection(renamedMod, versions.buildCandidates(renamedMod,
        [renamedRelease('2.10', ['_v2.10.zip', '_v2.9.zip'])])).defaultKey, '', '同次发布有多个匿名主包时仍需明确选择');
    assert.equal(versions.getDefaultSelection({ ...renamedMod, sharedRepository: true },
        versions.buildCandidates({ ...renamedMod, sharedRepository: true }, anonymousHistory)).defaultKey, '', '共享仓库不能从匿名文件猜产品身份');
    const typedAnonymous = { ...namelessMod, packageEditions: [{ id: 'first', label: '包型甲', bootName: 'ActualFeature',
        assetSeries: 'Feature-Complete', exclusive: true }] };
    assert.equal(versions.getDefaultSelection(typedAnonymous, versions.buildCandidates(typedAnonymous, anonymousHistory)).defaultKey, '',
        '已登记包型的匿名附件不能绕过明确包型选择');

    // 摘要失效的新版被剔除后，旧包仍可手选，但不能成为自动回退目标。
    const rejectedNewest = evidenceHistory.map((release, index) => index ? release : { ...release,
        assets: release.assets.map(asset => ({ ...asset, digest: `sha256:${'c'.repeat(64)}`, bootName: 'ActualFeature', version: '2.10', versionSource: 'verified-boot' })) });
    const survivors = versions.buildCandidates(evidenceMod, rejectedNewest);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].version, '1.0');
    assert.equal(survivors[0].requiresManualSelection, false, '拒绝上下文不改变已明确旧主包的附件选择规则');
    assert.equal(versions.getDefaultSelection(evidenceMod, survivors).defaultKey, '');
    assert.equal(versions.getLatestGameCandidate(evidenceMod, survivors), null);
    assert.equal(versions.getLatestReleaseCandidate(evidenceMod, survivors), null);
    assert.equal(versions.getLatestUpdateCandidate(evidenceMod, survivors), null);
    const warning = (version, name = `Feature-Complete-v${version}.zip`) => ({ code: 'RELEASE_ASSET_CHANGED', tagName: `v${version}`,
        assetName: name, sourceUrl: `${renamedRepository}/releases/download/v${version}/${name}`, message: '附件摘要已改变' });
    const oldValid = [renamedRelease('1.0', ['Feature-Complete-v1.0.zip'])];
    const warnNewer = { releases: oldValid, sourceWarnings: [warning('2.10')] };
    const warningSurvivors = versions.buildCandidates(renamedMod, warnNewer);
    assert.equal(warningSurvivors.length, 1);
    assert.equal(versions.rankCandidates(renamedMod, warningSurvivors).defaultKey, '', '服务仅返回警告而没有新版附件时不能回退旧版');
    assert.equal(versions.rankCandidates(renamedMod, versions.buildCandidates(renamedMod, oldValid), { sourceWarnings: [warning('2.10')] }).defaultKey,
        '', '后页只有警告时，先前已有候选也必须收到拒绝上下文');
    const warnedOld = versions.buildCandidates(renamedMod, { releases: oldValid, sourceWarnings: [warning('0.5')] });
    assert.equal(versions.getDefaultSelection(renamedMod, warnedOld).defaultKey, warnedOld[0].candidateKey, '明确较低旧包的摘要失效只约束对应附件');
    const unknownWarning = warning('channel', 'Legacy-Unknown.zip');
    assert.equal(versions.getDefaultSelection(renamedMod, versions.buildCandidates(renamedMod,
        { releases: oldValid, sourceWarnings: [unknownWarning] })).defaultKey, '', '被拒绝附件没有可比较版号时不能自动认定旧候选仍为最新');
    const foreignWarning = { ...warning('99.0'), sourceUrl: warning('99.0').sourceUrl.replace('/NewAuthorFixture/', '/AnotherAuthorFixture/') };
    const foreignSurvivors = versions.buildCandidates(renamedMod, { releases: oldValid, sourceWarnings: [foreignWarning] });
    assert.equal(versions.getDefaultSelection(renamedMod, foreignSurvivors).defaultKey, foreignSurvivors[0].candidateKey,
        '其他仓库的附件拒绝记录不能约束本品默认');

    // 同一真实技术名的不同完整包型，拒绝信息只影响对应包型。
    const editionNames = { lite: 'EditionFeature-Lite', visual: 'EditionFeature-Visual' };
    const editionUrl = (id, version) => `${renamedRepository}/releases/download/v${version}/${editionNames[id]}-v${version}.zip`;
    const editionMod = { id: 'edition-warning-fixture', name: '匿名完整包型', bootNames: ['EditionFeature'], githubUrl: renamedRepository,
        packageEditions: ['lite', 'visual'].map(id => ({ id, label: id, bootName: 'EditionFeature', bootEdition: id,
            assetSeries: editionNames[id], exclusive: true, verifiedAssets: [{ sourceUrl: editionUrl(id, '2.0'), version: '2.0', sha256: 'd'.repeat(64) }] })) };
    const editionRelease = version => ({ tagName: `v${version}`, name: version, assets: ['lite', 'visual'].map(id => ({
        name: `${editionNames[id]}-v${version}.zip`, downloadUrl: editionUrl(id, version), size: 100,
        ...(version === '2.0' ? { bootName: 'EditionFeature', version, versionSource: 'verified-boot', digest: `sha256:${'d'.repeat(64)}` } : {}) })) });
    const editionHistory = [editionRelease('2.0'), editionRelease('1.0')];
    assert.equal(versions.getHistorySelectionWarnings(editionMod, editionHistory).length, 0,
        '相同技术名的合法Visual摘要必须按对应包型核验，不能拿Lite记录误判失配');
    const editionValid = versions.buildCandidates(editionMod, editionHistory);
    const editionWarning = id => ({ ...warning('2.0', `${editionNames[id]}-v2.0.zip`), sourceUrl: editionUrl(id, '2.0') });
    const visualWarned = versions.buildCandidates(editionMod, { releases: editionHistory, sourceWarnings: [editionWarning('visual')] });
    const liteLatest = visualWarned.find(candidate => candidate.packageEdition.id === 'lite' && candidate.version === '2.0');
    assert.equal(versions.getDefaultSelection({ ...editionMod, _selectedPackageEdition: 'lite' }, visualWarned).defaultKey,
        liteLatest.candidateKey, 'Visual同版失配不影响明确选择的Lite最新');
    const localLite = { name: 'EditionFeature', version: '1.0', bootJson: { name: 'EditionFeature', version: '1.0', edition: 'lite' } };
    assert.equal(versions.getDefaultSelection(editionMod, visualWarned, { updateOnly: true, localProfile: localLite }).defaultKey,
        liteLatest.candidateKey, '真实boot.edition继承Lite时也不受Visual警告影响');
    assert.equal(versions.rankCandidates(editionMod, editionValid, { updateOnly: true, localProfile: localLite,
        sourceWarnings: [editionWarning('visual')] }).defaultKey, liteLatest.candidateKey,
    '分页仅追加Visual警告时，rank也按候选的真实包型约束');
    const newerVisualWarning = { ...editionWarning('visual'), tagName: 'v3.0', assetName: `${editionNames.visual}-v3.0.zip`, sourceUrl: editionUrl('visual', '3.0') };
    assert.equal(versions.rankCandidates(editionMod, editionValid, { updateOnly: true, localProfile: localLite,
        sourceWarnings: [newerVisualWarning] }).defaultKey, liteLatest.candidateKey, 'Visual较新版失配也不应阻断已继承Lite最新');
    assert.equal(versions.getDefaultSelection({ ...editionMod, _selectedPackageEdition: 'visual' }, visualWarned).defaultKey, '',
        'Visual新版拒绝后不能自动回退Visual旧包');
    const liteWarned = versions.buildCandidates(editionMod, { releases: editionHistory, sourceWarnings: [editionWarning('lite')] });
    const visualLatest = liteWarned.find(candidate => candidate.packageEdition.id === 'visual' && candidate.version === '2.0');
    assert.equal(versions.getDefaultSelection({ ...editionMod, _selectedPackageEdition: 'visual' }, liteWarned).defaultKey,
        visualLatest.candidateKey, '反向Lite失配不影响Visual最新');
    assert.equal(versions.getDefaultSelection(editionMod, liteWarned, { updateOnly: true, localProfile: localLite }).defaultKey, '',
        '本包型的新版拒绝仍不能回退旧版');
    const unknownEditionWarning = warning('2.0', 'UnknownEdition-v2.0.zip');
    for (const id of ['lite', 'visual']) assert.equal(versions.rankCandidates({ ...editionMod, _selectedPackageEdition: id }, editionValid,
        { sourceWarnings: [unknownEditionWarning] }).defaultKey, '', '无法确认对应包型的警告仍保守约束，不猜目标');
    const verifiedAliasUrl = `${renamedRepository}/releases/download/v2.0/UnrelatedAlias-v2.0.zip`;
    const aliasEditionMod = { ...editionMod, packageEditions: editionMod.packageEditions.map(edition => edition.id === 'visual'
        ? { ...edition, verifiedAssets: [...edition.verifiedAssets, { sourceUrl: verifiedAliasUrl, version: '2.0', sha256: 'e'.repeat(64) }] } : edition) };
    assert.equal(versions.rankCandidates(aliasEditionMod, editionValid, { updateOnly: true, localProfile: localLite,
        sourceWarnings: [{ ...warning('2.0', 'UnrelatedAlias-v2.0.zip'), sourceUrl: verifiedAliasUrl }] }).defaultKey,
        liteLatest.candidateKey, '精确verifiedAssets来源可确认Visual，不能只依赖文件名系列');

    // 目录强制前置适用于全部历史候选，不能被包体或发布中的空声明覆盖。
    const translated = { ...mod, requiredDependencies: [{ modName: 'GenericTranslation', version: '*' }] };
    const dependencyRelease = release('v2.10', '2026-06-14T22:00:00Z');
    for (const declaration of [dependencyRelease, { ...dependencyRelease, dependencies: [] },
        { ...dependencyRelease, dependencies: [{ id: 'OriginalRequirement', version: '^1.0.0' }],
            assets: dependencyRelease.assets.map(asset => ({ ...asset, dependencies: [] })) }]) {
        const [candidate] = candidates([declaration], translated);
        assert.equal(candidate.dependencies.length, 1);
        assert.equal(candidate.dependencies[0].bootName, 'GenericTranslation');
        assert.equal(candidate.dependencies[0].required, true);
        assert.equal(candidate.dependencies[0].source, '目录强制前置');
    }
    assert.equal(candidates([dependencyRelease], mod)[0].dependencies, undefined, '无额外目录前置的语言不借用其他语言的要求');
    const [combinedDependencies] = candidates([{ ...dependencyRelease,
        dependencies: [{ id: 'GenericTranslation', version: '*' }, { bootName: 'GenericTranslation', version: '>=1.0' },
            { id: 'OriginalRequirement', version: '^1.0.0' }] }], {
        ...translated, requiredDependencies: [...translated.requiredDependencies,
            { bootName: 'GenericTranslation', version: '>=2.0' }, { id: 'OnlyCatalogId', version: '^3.0' },
            { bootName: 'ActualTechnicalName', modName: 'DisplayAlias', id: 'catalog-entry', version: '*' }, {}]
    });
    assert.deepEqual(Array.from(combinedDependencies.dependencies.filter(item => (item.bootName || item.id) === 'GenericTranslation'), item => item.version),
        ['*', '>=1.0', '>=2.0'], '同一前置的不同版本范围必须全部保留');
    assert.equal(combinedDependencies.dependencies.find(item => item.version === '*').source, '目录强制前置', '相同要求合并时保留强制来源');
    assert.ok(combinedDependencies.dependencies.some(item => item.id === 'OriginalRequirement'));
    assert.ok(combinedDependencies.dependencies.some(item => item.id === 'OnlyCatalogId' && item.required));
    assert.ok(combinedDependencies.dependencies.some(item => item.bootName === 'ActualTechnicalName' && item.id === 'catalog-entry'),
        '明确 bootName 优先于兼容字段 modName，同时保留目录 ID');

    // 同版重打包只能由已安装包与主包的可靠摘要证明，默认及推荐使用相同规则。
    const oldDigest = 'sha256:' + 'a'.repeat(64), newDigest = 'sha256:' + 'b'.repeat(64);
    const localProfile = { name: 'GenericFeatureAlpha', version: '2.10', packageDigest: oldDigest };
    const [repacked] = candidates([{ ...dependencyRelease,
        assets: dependencyRelease.assets.map(asset => ({ ...asset, digest: newDigest })) }]);
    repacked.compatibility = { status: 'compatible', evidence: 'declaration' };
    const repackOptions = { updateOnly: true, localProfile };
    const repackSelection = versions.rankCandidates(mod, [repacked], repackOptions);
    assert.equal(repackSelection.defaultKey, repacked.candidateKey);
    assert.equal(repackSelection.recommendedKey, repacked.candidateKey);
    assert.equal(repackSelection.defaultRisk, false);
    assert.equal(versions.getDefaultSelection({ ...mod, _matchedLocal: localProfile }, [repacked], { updateOnly: true }).defaultKey, repacked.candidateKey);
    for (const packageDigest of [newDigest, newDigest.toUpperCase(), '', 'sha256:bad', 'sha512:' + 'a'.repeat(64), { toString: () => newDigest }]) {
        const ranked = versions.rankCandidates(mod, [repacked], { updateOnly: true, localProfile: { ...localProfile, packageDigest } });
        assert.equal(ranked.defaultKey, '', '相同或未知本地摘要不能默认选同版更新');
        assert.equal(ranked.recommendedKey, '');
    }
    for (const digest of ['', 'sha256:bad', oldDigest]) {
        const candidate = { ...repacked, assetDigest: digest, assets: repacked.assets.map(asset => ({ ...asset, digest })) };
        assert.equal(versions.rankCandidates(mod, [candidate], repackOptions).defaultKey, '', '未知或相同主包摘要不能默认选同版更新');
    }
    const installedCheck = market.isReleaseInstalled;
    for (const installed of [true, null, undefined]) {
        market.isReleaseInstalled = () => installed;
        const ranked = versions.rankCandidates(mod, [repacked], repackOptions);
        assert.equal(ranked.defaultKey, '', '安装状态须明确为 false');
        assert.equal(ranked.recommendedKey, '');
    }
    market.isReleaseInstalled = installedCheck;
    const originalProfiles = market.getLocalInstalledProfiles;
    market.getLocalInstalledProfiles = () => [localProfile];
    assert.equal(versions.rankCandidates(mod, [repacked], { updateOnly: true, localVersion: '2.10' }).defaultKey, repacked.candidateKey,
        '缺少选项档案时可以按目录中的唯一技术名回读摘要');
    market.getLocalInstalledProfiles = () => [{ ...localProfile, name: 'AnotherTechnicalName', displayNames: [mod.name] }];
    assert.equal(versions.rankCandidates(mod, [repacked], { updateOnly: true, localVersion: '2.10' }).defaultKey, '',
        '同展示名不能证明已安装包身份');
    assert.equal(versions.rankCandidates(mod, [repacked], { updateOnly: true, localProfile: { ...localProfile, name: 'AnotherTechnicalName' } }).defaultKey, '',
        '其他语言或产品的摘要不能证明本语言更新');
    assert.equal(versions.rankCandidates(mod, [repacked], { updateOnly: true, localProfile: { ...localProfile, name: '' } }).defaultKey, '',
        '缺少技术身份的摘要不能证明本语言已安装包');
    market.getLocalInstalledProfiles = originalProfiles;
    const onlyResourceDigest = { ...repacked, assetDigest: '', assets: [
        { ...repacked.assets[0], digest: '' }, { name: 'GenericFeatureAlpha-resource.zip', packageRole: 'resource', digest: newDigest }
    ] };
    assert.equal(versions.rankCandidates(mod, [onlyResourceDigest], repackOptions).defaultKey, '', '附包摘要不能替代主包摘要');
    assert.equal(versions.rankCandidates(mod, [repacked], { updateOnly: true, localProfile: { ...localProfile, version: '3.0' } }).defaultKey, '',
        '不同摘要不允许默认降级');

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

    const withRequired = { ...pinned, requiredDependencies: [{ modName: 'GenericTranslation', version: '*' }] };
    assert.equal((await versions.fetchReleases(withRequired)).schemaVersion, 1, '额外契约保持旧客户端 schemaVersion 1');
    await versions.fetchReleases(withRequired);
    assert.equal(requests, 4, '新增目录强制前置必须跳过旧缓存，新签名仍可复用');
    await versions.fetchReleases({ ...withRequired, requiredDependencies: [{ modName: 'GenericTranslation', version: '>=2.0' }] });
    assert.equal(requests, 5, '目录强制前置的版本范围变化使缓存失效');
    const zhVariant = { ...withRequired, variant: { groupId: 'generic-feature', kind: 'language', code: 'zh-CN', label: '简体中文' } };
    await versions.fetchReleases(zhVariant);
    await versions.fetchReleases(zhVariant);
    assert.equal(requests, 6, '语言变体契约新增后不复用旧缓存');
    await versions.fetchReleases({ ...zhVariant, variant: { ...zhVariant.variant, code: 'en', label: 'English' } });
    assert.equal(requests, 7, '语言变体变化必须重新核验历史');
    const withEditions = { ...zhVariant, packageEditions: [{ id: 'lite', label: '轻量版', bootName: 'GenericFeatureAlpha', assetSeries: 'GenericFeatureAlpha', exclusive: true }] };
    await versions.fetchReleases(withEditions);
    await versions.fetchReleases(withEditions);
    assert.equal(requests, 8, '包型契约新增后不复用旧历史缓存，新签名仍可复用');
    await versions.fetchReleases({ ...withEditions, _selectedPackageEdition: 'lite' });
    assert.equal(requests, 9, '明确包型选择需要独立历史缓存，避免另类型过滤结果串用');
    await versions.fetchReleases({ ...withEditions, optionalResources: [{ bootName: 'ExtraResource', label: '附加资源', assetSeries: 'ExtraResource', packageRole: 'resource' }] });
    assert.equal(requests, 10, '附加资源契约变化须核验新候选');
};
