// 已核对的发布包技术名与共享仓库安装身份契约；不访问网络或安装游戏模组。
const { assert, fs, path, srcRoot, loadMarket, loadScripts } = require('./helpers');
const root = path.join(srcRoot, '..');
const repository = 'https://github.com/3naka/DarksOuLs';
const targets = [
    { submissionId: '1df0e364-3be9-4c6d-8bb1-d0cd4f962f82', identityId: 'combat-terminator',
        name: '战斗终结者', bootName: 'CombatTerminator', tag: 'CT', version: '0.1' },
    { submissionId: '89c55985-f6e5-416d-ab05-2b0d18e87ca3', identityId: 'auto-clothes-repair',
        name: '原地补衣', bootName: 'AutoClothesRepair', tag: 'ACR', version: '0.1' },
    { submissionId: '4300b6f2-1baa-4f98-9fbf-4c347feb57ce', identityId: 'auto-clean',
        name: '自动清理V0.1.5', bootName: 'AutoClean', tag: 'AC0.1.5', version: '0.1.5' },
].map(item => ({ ...item, id: `community-${item.submissionId}` }));

function sandbox() {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    sb.StartConfig = { version: '0.5.12.13' };
    return sb;
}

function asset(repo, tag, name) {
    return { name, size: 100, downloadUrl: `${repo}/releases/download/${tag}/${name}` };
}

function history(mod, tag, assets) {
    return { schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl, page: 1, hasMore: false,
        fetchedAt: new Date().toISOString(), releases: [{ tagName: tag,
            publishedAt: '2026-10-07T00:00:00Z', assets }] };
}

module.exports = async function() {
    const bytes = fs.readFileSync(path.join(root, 'mod-identities.json'));
    assert.ok(bytes.equals(fs.readFileSync(path.join(root, 'dolmod-site/dist/mod-identities.json'))),
        '身份目录与静态站必须逐字节同步');
    const identities = JSON.parse(bytes).mods;
    const rawMods = targets.map(target => {
        const identity = identities.find(item => item.id === target.identityId);
        assert.ok(identity, `必须登记规范身份：${target.identityId}`);
        assert.deepEqual(identity.bootNames, [target.bootName], '技术名取自实际 boot.json，不能使用展示名代替');
        assert.equal(identities.filter(item => item.bootNames?.includes(target.bootName)).length, 1,
            '每个技术名只能属于一个规范身份');
        assert.equal(identity.sharedRepository, true);
        assert.deepEqual(identity.repositories, [], '共享仓库通用名字不能当作包名身份');
        assert.deepEqual(identity.repositoryKeys.map(key => key.toLowerCase()), ['3naka/darksouls']);
        const sourceUrl = `${repository}/releases/tag/${target.tag}`;
        return { ...identity, id: target.id, identityId: target.identityId, name: target.name,
            contentType: 'package', catalogSource: 'community', sourceUrl, githubUrl: sourceUrl,
            autoInstall: true, sources: [{ platform: 'github', url: sourceUrl }], packageRecords: [] };
    });
    const mappedIndex = { schemaVersion: 1, communityRevision: 54, identities, mods: rawMods };

    for (const target of targets) {
        const sb = sandbox(), market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        const raw = rawMods.find(item => item.id === target.id);
        const old = market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 53,
            mods: [{ ...raw, identityId: target.id, bootNames: [target.name], aliases: [target.name], repositories: ['DarksOuLs'] }] })[0];
        let requests = 0;
        sb.fetch = async url => {
            assert.ok(String(url).includes('/mod-releases?'));
            requests++;
            return { ok: true, json: async () => ({ ...history(old, target.tag, [asset(repository, target.tag, `${target.bootName}.zip`)]),
                communityRevision: market.getCommunityRevision() }) };
        };
        assert.equal(versions.buildCandidates(old, await versions.fetchReleases(old)).length, 0,
            '回归原始错误：中文展示名不能匹配真实技术包名');
        const mod = market.normalizeReleaseIndex(structuredClone(mappedIndex)).find(item => item.id === target.id);
        assert.equal(mod.name, target.name, '纠正技术身份不能更改社区中文展示名');
        assert.equal(market.hasCommunityReleaseSource(mod), true, '目录资格与固定来源必须一致');
        const combined = history(mod, target.tag, targets.map(item => asset(repository, target.tag, `${item.bootName}.zip`)));
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ ...combined,
            communityRevision: market.getCommunityRevision() }) }; };
        const data = await versions.fetchReleases(mod);
        assert.equal(requests, 2, '身份变更必须使旧历史缓存失效并重读');
        assert.deepEqual(Array.from(versions.buildCandidates(mod, data), item => item.assetName), [`${target.bootName}.zip`],
            '同一个标签包含其它模组时，只选属于目标身份的包');
        await versions.fetchReleases(mod);
        assert.equal(requests, 2, '新身份成功读取后可复用缓存');
        const foreign = combined.releases[0].assets.filter(item => item.name !== `${target.bootName}.zip`);
        assert.equal(versions.buildCandidates(mod, history(mod, target.tag, foreign)).length, 0, '纯其它模组附件必须拒绝');
        assert.equal(versions.buildCandidates(mod, history(mod, 'wrong-tag', [asset(repository, 'wrong-tag', `${target.bootName}.zip`)])).length, 0,
            '同名包不能跨固定标签安装');
        const otherRepository = 'https://github.com/AnotherAuthor/DarksOuLs';
        assert.equal(versions.buildCandidates(mod, history(mod, target.tag, [asset(otherRepository, target.tag, `${target.bootName}.zip`)])).length, 0,
            '相同仓库尾名和技术包名不能冒充其它作者仓库');
        assert.equal(versions.buildCandidates(mod, history(mod, target.tag,
            ['DarksOuLs.zip', 'DarkSoULs-v99.zip'].map(name => asset(repository, target.tag, name)))).length, 0,
            '模糊的共享仓库名附件不能代替目标身份');
        assert.equal(versions.buildCandidates({ ...mod, name: '另一个中文展示名' }, data).length, 1);
        market.checkModInstallStatus(mod, [{ name: target.bootName, bootJson: { name: target.bootName, version: target.version } }]);
        assert.equal(mod._matchedLocal?.name, target.bootName, '真实技术名应正确识别本地安装');
        for (const other of targets.filter(item => item !== target)) {
            market.checkModInstallStatus(mod, [{ name: other.bootName, bootJson: { name: other.bootName, version: other.version } }]);
            assert.equal(mod._matchedLocal, null, '同仓库其它技术名不能串为已安装');
        }
    }

    // 未登记过的新共享仓库使用相同机制，不依赖三条目标记录的专用代码。
    const sb = sandbox(), market = sb.modHubMarket, versions = sb.modHubMarketVersions;
    const syntheticRepository = 'https://github.com/FutureAuthor/SyntheticShared';
    const definitions = [
        { id: 'synthetic-alpha', name: '新共享模组甲', bootName: 'SyntheticAlphaFeature', tag: 'alpha-v1' },
        { id: 'synthetic-beta', name: '新共享模组乙', bootName: 'SyntheticBetaFeature', tag: 'beta-v1' },
    ];
    const synthetic = definitions.map(item => ({ id: item.id, identityId: item.id, name: item.name,
        bootNames: [item.bootName], aliases: [item.name], repositories: [], repositoryKeys: ['FutureAuthor/SyntheticShared'],
        catalogSource: 'community', sharedRepository: true, autoInstall: true,
        githubUrl: `${syntheticRepository}/releases/tag/${item.tag}`, sourceUrl: `${syntheticRepository}/releases/tag/${item.tag}` }));
    const mods = market.normalizeReleaseIndex({ schemaVersion: 1, identities: structuredClone(synthetic), mods: structuredClone(synthetic) });
    for (const definition of definitions) {
        const mod = mods.find(item => item.id === definition.id), raw = synthetic.find(item => item.id === definition.id);
        const all = definitions.map(item => asset(syntheticRepository, definition.tag, `${item.bootName}.zip`));
        assert.deepEqual(Array.from(versions.buildCandidates(mod, history(mod, definition.tag, all)), item => item.assetName),
            [`${definition.bootName}.zip`], '新共享仓库完整元数据能区分两个模组');
        for (const [field, value] of [['identityId', null], ['bootNames', []]]) {
            const missing = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ ...raw, [field]: value }] })[0];
            assert.equal(market.hasCommunityReleaseSource(missing), false, `缺少 ${field} 时不能获准自动安装`);
            assert.equal(versions.buildCandidates(missing, history(missing, definition.tag, all)).length, 0);
        }
        assert.equal(versions.buildCandidates(mod, history(mod, 'wrong-tag', [asset(syntheticRepository, 'wrong-tag', `${definition.bootName}.zip`)])).length, 0);
        assert.equal(versions.buildCandidates(mod, history(mod, definition.tag,
            ['SyntheticShared.zip', 'SyntheticShared-v99.zip', 'mod.zip', 'package.zip'].map(name => asset(syntheticRepository, definition.tag, name)))).length, 0);
    }
    // 正式附件中的版别前缀、最低版本加号和修订后缀不能造成共享产品失配。
    const realPackages = [
        ['smartphone-omega', 'ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone', 'v.omega.1.0', 'SmartPhone-vOmega.1.0.mod.zip'],
        ['head-mask-compatibility', 'chris81605/DOL-Compatibility-Mods', 'Compatibility', 'LegacyHeadMaskCompat.0.5.10.12+.zip'],
        ['candy-and-robot', 'emicoto/DOLMods', 'sf1.15', 'i.Candy.and.Robot.ver2.4.5.1.fix.zip'],
    ];
    for (const [id, repo, tag, fileName] of realPackages) {
        const identity = identities.find(item => item.id === id);
        const repoUrl = `https://github.com/${repo}`;
        const mod = { ...identity, identityId: id, githubUrl: `${repoUrl}/releases/tag/${tag}` };
        const ownAsset = asset(repoUrl, tag, fileName);
        const foreign = asset(repoUrl, tag, 'ForeignFeature-v99.0.zip');
        const plan = market.buildReleaseAssetPlan([ownAsset, foreign], '', mod);
        assert.deepEqual(Array.from(plan.assets, item => item.name), [fileName], `正式附件 ${fileName} 必须精确匹配本品`);
        assert.deepEqual(Array.from(versions.buildCandidates(mod, history(mod, tag, [ownAsset, foreign])), item => item.assetName), [fileName],
            '历史选版必须复用相同识别规则，且不能混入同仓库其它产品');
        assert.equal(versions.buildCandidates(mod, history(mod, tag, [foreign])).length, 0);
    }
    const phoneRepo = 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone';
    const omega = { ...identities.find(item => item.id === 'smartphone-omega'), identityId: 'smartphone-omega',
        githubUrl: `${phoneRepo}/releases/tag/v.omega.1.0` };
    const phones = ['SmartPhone-vOmega.1.0.mod.zip', 'SmartPhone-vAlpha.0.3.85.mod.zip']
        .map(name => asset(phoneRepo, 'v.omega.1.0', name));
    assert.deepEqual(Array.from(market.buildReleaseAssetPlan(phones, '', omega).assets, item => item.name), [phones[0].name]);
    const alpha = { ...identities.find(item => item.id === 'smartphone'), githubUrl: phoneRepo, sharedRepository: true };
    assert.deepEqual(Array.from(market.buildReleaseAssetPlan(phones, '', alpha).assets, item => item.name), [phones[1].name],
        '去掉版别的 v 标记后，Alpha 与 Omega 仍必须隔离');
    for (const [name, expected] of [['Feature-vBeta.1.0.zip', 'featurebeta'], ['Feature-vOmega.1.0.hotfix2.zip', 'featureomega'],
        ['Violet-v2.0.zip', 'violet'], ['Valkyrie-2.0.zip', 'valkyrie']]) {
        assert.equal(market.getAssetSeries(name), expected, '已知版本标记不能误删合法产品名');
    }
    sb.fetch = async url => String(url).includes('/mod-releases?')
        ? { ok: false, status: 502, json: async () => ({ code: 'RELEASE_UPSTREAM_FAILED', error: '模拟历史服务离线' }) }
        : { ok: true, json: async () => ({ tag_name: 'v.omega.1.0', name: 'OmegaΩ v1.0 | 万能的智能手机 简化版',
            published_at: '2026-10-05T10:04:08Z', assets: phones.map(item => ({ name: item.name, size: item.size,
                browser_download_url: item.downloadUrl })) }) };
    const fallback = await versions.fetchReleases(omega, { useCache: false });
    assert.equal(fallback.fromGithub, true);
    assert.deepEqual(Array.from(versions.buildCandidates(omega, fallback), item => item.assetName), [phones[0].name],
        '历史服务离线时，GitHub 直连也必须识别真实 Omega 包并保持身份隔离');

    // 健康空响应可能来自旧筛选规则；补偿仅核对原仓库，不能绕过社区审核或启动守卫。
    const headMaskRepo = 'https://github.com/chris81605/DOL-Compatibility-Mods';
    const headMaskTag = 'Compatibility', headMaskName = 'LegacyHeadMaskCompat.0.5.10.12+.zip';
    const headMask = { ...identities.find(item => item.id === 'head-mask-compatibility'),
        identityId: 'head-mask-compatibility', githubUrl: `${headMaskRepo}/releases/tag/${headMaskTag}` };
    const headMaskAsset = asset(headMaskRepo, headMaskTag, headMaskName);
    const rawHeadMask = { tag_name: headMaskTag, published_at: '2026-10-07T00:00:00Z', assets: [
        headMaskAsset, asset(headMaskRepo, headMaskTag, 'ForeignFeature-v99.0.zip'),
        asset('https://github.com/AnotherAuthor/DOL-Compatibility-Mods', headMaskTag, headMaskName),
    ].map(item => ({ name: item.name, size: item.size, browser_download_url: item.downloadUrl })) };
    for (const mode of ['empty', 'nonempty', 'community']) {
        const run = sandbox(), api = run.modHubMarketVersions;
        const mod = mode === 'community' ? { ...headMask, catalogSource: 'community', autoInstall: true } : headMask;
        run.modHubMarket.hasCommunityReleaseSource = () => true;
        let workerRequests = 0, directRequests = 0;
        run.fetch = async url => {
            if (String(url).includes('/mod-releases?')) {
                workerRequests++;
                return { ok: true, json: async () => ({ ...history(mod, headMaskTag, [headMaskAsset]),
                    communityRevision: run.modHubMarket.getCommunityRevision(),
                    ...(mode !== 'nonempty' ? { releases: [] } : {}) }) };
            }
            directRequests++;
            assert.equal(String(url), 'https://api.github.com/repos/chris81605/dol-compatibility-mods/releases/tags/Compatibility',
                '空历史补偿只能查询目录指定的原作者、原仓库和原标签');
            return { ok: true, json: async () => rawHeadMask };
        };
        const result = await api.fetchReleases(mod);
        assert.equal(workerRequests, 1);
        assert.equal(directRequests, mode === 'empty' ? 1 : 0, '非空历史或社区健康空响应不得额外直连');
        if (mode === 'empty') assert.equal(result.fromGithub, true, '旧服务健康空响应须能由原仓库核验补回');
        assert.deepEqual(Array.from(api.buildCandidates(mod, result), item => item.assetName),
            mode === 'community' ? [] : [headMaskName], '补偿仍须排除同仓库其他产品及其他作者同名附件');
    }
    for (const failure of ['403', '404', 'network']) {
        const run = sandbox(), api = run.modHubMarketVersions;
        let workerRequests = 0, directRequests = 0;
        run.fetch = async url => {
            if (String(url).includes('/mod-releases?')) {
                workerRequests++;
                return { ok: true, json: async () => ({ ...history(headMask, headMaskTag, []), releases: [],
                    communityRevision: run.modHubMarket.getCommunityRevision() }) };
            }
            directRequests++;
            if (directRequests > 1) return { ok: true, json: async () => rawHeadMask };
            if (failure === 'network') throw new Error('模拟 GitHub 连接失败');
            return { ok: false, status: Number(failure), json: async () => ({ message: failure === '403' ? 'API rate limit exceeded' : 'Not Found' }) };
        };
        const empty = await api.fetchReleases(headMask);
        assert.equal(empty.releases.length, 0, '可选直连失败应保留已核验的 Worker 空响应');
        assert.equal(empty.fromGithub, undefined);
        const retry = await api.fetchReleases(headMask);
        assert.equal(retry.fromGithub, true);
        assert.equal(workerRequests, 2);
        assert.equal(directRequests, 2, '暂时无法核验的空历史不得长期缓存阻止后续重试');
    }
    for (const stop of ['cancel', 'source', 'withdrawn']) {
        const run = sandbox(), api = run.modHubMarketVersions, controller = new AbortController();
        let withdrawn = false, directRequests = 0;
        run.modHubMarket.isWithdrawn = () => withdrawn;
        run.fetch = async url => {
            if (String(url).includes('/mod-releases?')) return { ok: true, json: async () => ({
                ...history(headMask, headMaskTag, []), releases: [], communityRevision: run.modHubMarket.getCommunityRevision() }) };
            directRequests++;
            if (stop === 'cancel') controller.abort();
            if (stop === 'withdrawn') withdrawn = true;
            return { ok: true, json: async () => stop === 'source' ? { ...rawHeadMask, tag_name: 'another-tag' } : rawHeadMask };
        };
        const code = stop === 'cancel' ? 'ABORT_ERR' : stop === 'source' ? 'RELEASE_SOURCE_CHANGED' : 'MOD_RELEASES_UNAVAILABLE';
        await assert.rejects(api.fetchReleases(headMask, { signal: controller.signal }), error => error.code === code,
            '空响应补偿不得吞掉取消、来源变化或撤回状态');
        assert.equal(directRequests, 1);
    }
};
