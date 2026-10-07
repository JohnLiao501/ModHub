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
};
