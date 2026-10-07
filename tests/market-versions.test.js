// ModHub 历史发布、兼容证据、推荐与来源缓存回归。
const { assert, fs, path, loadMarket, loadScripts } = require('./helpers');

function loadVersions() {
    const sb = loadMarket();
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    sb.StartConfig = { version: '0.5.10.12-汉化版' };
    // 测试原生接口的完整参数传递，范围语义由 ModLoader 提供。
    const calls = [];
    sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
        parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
        parseRange: value => value.includes('&&>=') ? [] : value.split('||').map(range => ({ range })),
        satisfies(version, ranges, ignorePostfix) {
            calls.push({ version, ranges, ignorePostfix });
            return !ranges[0].range.startsWith('>=0.5.11');
        }
    }) }) };
    return { sb, versions: sb.modHubMarketVersions, calls };
}

function useEnumerableStorage(sb) {
    const values = new Map();
    sb.localStorage = {
        get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)
    };
    return values;
}

const asset = (name, extra = {}) => ({ name, downloadUrl: `https://github.com/Owner/Example/releases/download/v1/${name}`, size: 100, ...extra });
const release = (version, assets, compatibility) => ({ tagName: `v${version}`, name: version,
    htmlUrl: `https://github.com/Owner/Example/releases/tag/v${version}`, publishedAt: '2026-09-30T00:00:00Z',
    assets: assets.map(item => ({ ...item, downloadUrl: item.downloadUrl.replace(/\/download\/[^/]+\//, `/download/v${version}/`) })),
    ...(compatibility ? { compatibility } : {}) });
const baseMod = { id: 'example', name: 'Example', bootNames: ['Example'], githubUrl: 'https://github.com/Owner/Example' };

module.exports = async function() {
    // 正常响应与 429 登记快照共用真实附件合同；核验时间不充当 GitHub 发布日期。
    {
        const identities = JSON.parse(fs.readFileSync(path.join(__dirname, '../mod-identities.json'), 'utf8')).mods;
        const registered = identities.flatMap(identity => (identity.verifiedReleaseAssets || []).map(verified => ({ identity, verified })));
        assert.ok(registered.length >= 11, '应覆盖本轮已登记的固定附件');
        for (const { identity, verified } of registered) {
            const { sb, versions } = loadVersions();
            const parts = new URL(verified.sourceUrl).pathname.split('/').filter(Boolean);
            const tag = decodeURIComponent(parts[4]), name = decodeURIComponent(parts[5]);
            const [mod] = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
                id: identity.id, identityId: identity.id, name: identity.name, catalogSource: 'community', sourcePlatform: 'github',
                sourceUrl: verified.sourceUrl, githubUrl: verified.sourceUrl, autoInstall: true,
                bootNames: identity.bootNames, repositoryKeys: [`${parts[0]}/${parts[1]}`], verifiedReleaseAsset: verified,
                version: verified.version
            }] });
            for (const stale of [false, true]) {
                const payload = { schemaVersion: 1, id: mod.id, sourceUrl: verified.sourceUrl, page: 1, hasMore: false,
                    communityRevision: sb.modHubMarket.getCommunityRevision(), fetchedAt: stale ? verified.verifiedAt : new Date().toISOString(), stale,
                    ...(stale ? { snapshotSource: 'verified-package', verifiedAt: verified.verifiedAt, notice: '登记包体资料，发布服务暂时限制请求。' } : {}),
                    releases: [{ tagName: tag, name: tag, version: verified.version, versionSource: 'verified-boot',
                        htmlUrl: `https://github.com/${parts[0]}/${parts[1]}/releases/tag/${encodeURIComponent(tag)}`,
                        publishedAt: null, prerelease: false, assets: [{ name, size: verified.size, downloadUrl: verified.sourceUrl,
                            digest: `sha256:${verified.sha256}`, bootName: verified.bootName, version: verified.version, versionSource: 'verified-boot' }] }] };
                sb.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
                const history = await versions.fetchReleases(mod, { useCache: false });
                const candidates = versions.buildCandidates(mod, history);
                assert.equal(candidates.length, 1, `${mod.id} 仅保留登记的固定附件`);
                const candidate = candidates[0];
                assert.equal(candidate.version, verified.version, `${mod.id} 必须显示真实 boot 版本`);
                assert.equal(candidate.versionSource, 'verified-boot');
                assert.equal(candidate.bootName, verified.bootName);
                assert.equal(candidate.assetDigest, `sha256:${verified.sha256}`);
                assert.equal(candidate.assetSize, verified.size);
                assert.equal(candidate.assets[0].digest, `sha256:${verified.sha256}`);
                assert.equal(candidate.assets[0].size, verified.size);
                assert.equal(candidate.assets[0].downloadUrl, verified.sourceUrl);
                assert.equal(candidate.updateDate, '', '原包核验时间不能改成发布日期');
                assert.equal(candidate.compatibility.status, 'unknown');
                const defaults = versions.rankCandidates(mod, candidates);
                assert.equal(defaults.defaultKey, candidate.candidateKey, '登记附件无歧义时恢复默认最新主包');
                assert.equal(defaults.defaultRisk, true, '登记 boot 版本不能代替游戏适配风险确认');
                assert.match(defaults.defaultReason, /安装前需确认适配风险/);
                assert.equal(defaults.recommendedKey, '', '未知兼容不能成为适配推荐');
                assert.equal(history.fetchedAt, payload.fetchedAt);
                assert.equal(history.stale, stale);
                if (stale) assert.equal(history.snapshotSource, 'verified-package');
            }
        }
    }
    // 发布名、文件名和标签版本不同于真实 boot 时，仅严格匹配的登记证据可覆盖线索。
    {
        const { sb, versions } = loadVersions();
        for (const [bootName, bootVersion, tagVersion, fileName] of [
            ['realistic-pain', '1.0.19', '1.0.20', 'realistic-pain-v1.0.20.mod.zip'],
            ['Little-Teachers-Pet', '1.0.0', '1.0.1', 'Little-Teachers-Pet.zip']
        ]) {
            const url = `https://github.com/Owner/Registered/releases/download/v${tagVersion}/${fileName}`;
            const tuple = { sourceUrl: url, sha256: 'a'.repeat(64), bootName, version: bootVersion, size: 123, verifiedAt: '2026-10-04T00:00:00Z' };
            const mod = { ...baseMod, githubUrl: url, bootNames: [bootName], verifiedReleaseAsset: tuple };
            const entry = { tagName: `v${tagVersion}`, name: `v${tagVersion}`, version: bootVersion, versionSource: 'verified-boot', publishedAt: null,
                assets: [{ name: fileName, downloadUrl: url, size: 123, digest: `sha256:${tuple.sha256}`, bootName, version: bootVersion, versionSource: 'verified-boot' }] };
            assert.equal(versions.buildCandidates(mod, [entry])[0].version, bootVersion);
            for (const change of [{ digest: `sha256:${'b'.repeat(64)}` }, { size: 124 }, { bootName: 'WrongBoot' },
                { version: tagVersion }]) {
                const wrong = { ...entry, assets: [{ ...entry.assets[0], ...change }] };
                assert.equal(versions.buildCandidates(mod, [wrong]).length, 0, '登记标记与当前 URL/SHA/大小/身份/版本不一致时不得变成可信候选');
            }
            assert.equal(versions.buildCandidates({ ...mod, verifiedReleaseAsset: undefined }, [entry]).length, 0, '响应不能单方面声明已登记 boot 版本');
            assert.equal(versions.buildCandidates({ ...mod, verifiedReleaseAsset: { ...tuple, sourceUrl: url.replace('Owner', 'Other') } }, [entry]).length, 0);
            const plain = { ...entry, version: undefined, versionSource: undefined,
                assets: [{ name: fileName, downloadUrl: url, size: 123 }] };
            assert.equal(versions.buildCandidates({ ...mod, verifiedReleaseAsset: undefined }, [plain])[0].version, tagVersion,
                '普通来源仍按既有文件名或标签线索解析，不被登记版本逻辑改写');
        }
        const url = 'https://github.com/Owner/Registered/releases/download/v1/Registered.zip';
        const tuple = { sourceUrl: url, sha256: 'a'.repeat(64), bootName: 'Registered', version: '1.0.0', size: 123 };
        const mod = { ...baseMod, id: 'registered-cache', githubUrl: url, bootNames: ['Registered'], verifiedReleaseAsset: tuple };
        const storage = useEnumerableStorage(sb);
        const payload = { schemaVersion: 1, id: mod.id, sourceUrl: url, page: 1, hasMore: false,
            communityRevision: sb.modHubMarket.getCommunityRevision(), fetchedAt: new Date().toISOString(), stale: false, releases: [] };
        let fetches = 0;
        sb.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => payload }; };
        await versions.fetchReleases(mod);
        await versions.fetchReleases(mod);
        assert.equal(fetches, 1);
        mod.verifiedReleaseAsset = { ...tuple, sha256: 'b'.repeat(64) };
        await versions.fetchReleases(mod);
        assert.equal(fetches, 2, '登记证据变化后不能继续使用旧缓存候选');
        assert.equal(storage.size, 2);
    }
    {
        const { sb, versions } = loadVersions();
        const bound = (operator, parts) => ({ operator, version: { version: parts } });
        // 使用当前原生库实际返回的边界，不使用 npm 对全零主版本的不同规则。
        const cases = [
            ['^3.0.0', { lower: bound('>=', [3, 0, 0]), upper: bound('<', [4]) }, '3.0.0及以上，低于4.0.0'],
            ['^0.2.3', { lower: bound('>=', [0, 2, 3]), upper: bound('<', [0, 3]) }, '0.2.3及以上，低于0.3.0'],
            ['^0.0.3', { lower: bound('>=', [0, 0, 3]), upper: bound('<', [0, 1]) }, '0.0.3及以上，低于0.1.0'],
            ['^0.5.10.12', { lower: bound('>=', [0, 5, 10, 12]), upper: bound('<', [0, 6]) }, '0.5.10.12及以上，低于0.6.0'],
            ['>=2.0.0', { lower: bound('>=', [2, 0, 0]) }, '2.0.0及以上'],
            ['>2.0.0', { lower: bound('>', [2, 0, 0]) }, '高于2.0.0'],
            ['<=2.0.0', { upper: bound('<=', [2, 0, 0]) }, '不高于2.0.0'],
            ['<2.0.0', { upper: bound('<', [2, 0, 0]) }, '低于2.0.0'],
            ['=2.0.0', { lower: bound('>=', [2, 0, 0]), upper: bound('<=', [2, 0, 0]) }, '仅限2.0.0'],
            ['2.0.0', { lower: bound('>=', [2, 0, 0]), upper: bound('<=', [2, 0, 0]) }, '仅限2.0.0'],
            ['>=0.5.10.1&&<0.5.11.0', { lower: bound('>=', [0, 5, 10, 1]), upper: bound('<', [0, 5, 11, 0]) }, '0.5.10.1及以上，低于0.5.11.0']
        ];
        const ranges = Object.fromEntries(cases.map(([range, result]) => [range, [result]]));
        ranges['^3.0.0||>=2.0.0'] = [ranges['^3.0.0'][0], ranges['>=2.0.0'][0]];
        const snapshot = JSON.stringify(ranges);
        const api = { parseRange: range => ranges[range] || [], satisfies: () => { throw new Error('展示不得执行或改写兼容判断'); } };
        sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => api }) };
        for (const [range, , expected] of cases) assert.equal(versions.formatVersionRange(range), expected);
        assert.equal(versions.formatVersionRange('^3.0.0||>=2.0.0'), '（3.0.0及以上，低于4.0.0）或者（2.0.0及以上）');
        assert.equal(versions.formatVersionRange('*'), '任意版本');
        assert.equal(versions.formatVersionRange(''), '版本要求未声明');
        for (const range of ['~1.2.3', '>=2.0.0 <3.0.0', '1.2.3 - 2.0.0', '[1.2.3,2.0.0)', '^3.0.0||invalid', '>=2&&>=3', '1.x', '<b>要求</b>']) {
            assert.equal(versions.formatVersionRange(range), `版本要求需手动确认（作者原始写法：${range}）`, '不支持或未解析的写法不得猜测版本区间');
        }
        assert.equal(JSON.stringify(ranges), snapshot, '范围展示不得修改原生边界对象');
        delete sb.modSC2DataManager;
        assert.equal(versions.formatVersionRange('^3.0.0'), '版本要求需手动确认（作者原始写法：^3.0.0）', '缺失原生接口时不得套用另一种 caret 语义');
    }
    {
        const { sb, versions } = loadVersions();
        const declaration = { gameVersionRange: '^0.5.10.12', evidenceUrl: `${baseMod.githubUrl}/releases/tag/v1.0` };
        const native = versions.buildCandidates({ ...baseMod, sharedRepository: true }, [
            release('1.0', [asset('Example-v1.0.modpack'), asset('Example.PhotoPack-v1.0.modpack.crypt'),
                asset('Other-v1.0.modpack'), asset('Example-v1.0.modpack.exe'), asset('source-code.modpack')], declaration),
            release('2.0', [asset('Example-v2.0.MODPACK.CRYPT')], declaration),
        ]);
        assert.deepEqual(Array.from(native, item => item.assetName), ['Example-v1.0.modpack', 'Example-v2.0.MODPACK.CRYPT'], '历史版本应识别两种原生包并隔离共享仓库及伪后缀');
        assert.deepEqual(Array.from(native[0].assets, item => item.name), ['Example-v1.0.modpack', 'Example.PhotoPack-v1.0.modpack.crypt'], '同发布同版本的跨格式附属包应继续配对');
        const assets = [asset('Example-v1.0.modpack'), asset('Example-v2.0.modpack.crypt')];
        assert.equal(sb.modHubMarket.buildReleaseAssetPlan(assets, '', baseMod).assets[0].name, 'Example-v2.0.modpack.crypt', '最新发布的格式变化不能拆成不同产品系列');
        const model = sb.modHubMarket.buildReleaseAssetPlan([asset('female.model-v1.0.modpack'), asset('female.imgpack-v1.0.zip')], '', null);
        assert.deepEqual(Array.from(model.assets, item => item.name), ['female.model-v1.0.modpack'], '格式不同的配对手动覆盖图包也不得参与自动导入');
    }
    {
        const { versions } = loadVersions();
        const declaration = { gameVersionRange: '^0.5.10.12' };
        const history = [release('1.0', [asset('Example-v1.0.modpack'), asset('Example-audio-v1.0.modpack'), asset('Example.PhotoPack-v1.0.zip')], declaration)];
        const snapshot = JSON.stringify(history);
        const candidates = versions.buildCandidates(baseMod, history);
        assert.equal(candidates.length, 1, '可靠配对的音频扩展不得成为第二个主包版本');
        assert.deepEqual(Array.from(candidates[0].assets, item => item.name), ['Example-v1.0.modpack', 'Example.PhotoPack-v1.0.zip'], '默认安装仍包含主包及既有资源伴包');
        assert.deepEqual(Array.from(candidates[0].assets, item => item.packageRole), ['main', 'resource']);
        assert.deepEqual(Array.from(candidates[0].optionalAssets, item => item.name), ['Example-audio-v1.0.modpack']);
        assert.equal(candidates[0].optionalAssets[0].packageRole, 'audio');
        assert.equal(candidates[0].optionalAssets[0].optional, true);
        assert.equal(versions.rankCandidates(baseMod, candidates).defaultKey, candidates[0].candidateKey, '附带可选扩展不能阻止主包默认选择');
        assert.equal(JSON.stringify(history), snapshot, '候选角色与可选状态不得污染原始发布资产');
    }
    {
        const { sb } = loadVersions();
        let requests = 0;
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ tag_name: 'v1.0',
            assets: [{ name: 'Example-v1.0.modpack', browser_download_url: `${baseMod.githubUrl}/releases/download/v1.0/Example-v1.0.modpack` }] }) }; };
        const current = await sb.modHubMarket.fetchModRelease(baseMod);
        const key = 'modhub_market_rel_v2_Owner_Example';
        sb.localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data: { ...current,
            assetPlanVersion: 3, assets: [], candidateAssets: [], availableAssets: [], assetName: null, assetUrl: null } }));
        assert.equal((await sb.modHubMarket.fetchModRelease(baseMod)).assets[0].name, 'Example-v1.0.modpack', '旧后缀规则缓存的空列表必须立即失效');
        assert.equal(requests, 2, '格式支持升级后不得等旧缓存六小时过期');
    }
    {
        const { versions } = loadVersions();
        const mod = { id: 'universal-combat-zed-fix', name: '战斗美化修复', bootNames: ['通用战斗美化-zed修复'],
            githubUrl: 'https://github.com/Zed660033/mysterious', version: '9.26' };
        const names = ['Z-outdate-UCB-zedfix-1.0.0.zip', 'Z-outdate-UCB-zedfix-1.0.1.zip',
            'Z-outdate-UCB-zedfix-1.0.2.zip', 'UCB-zedfix-1.0.3.zip'];
        const candidates = versions.buildCandidates(mod, [{ tagName: '9.26', name: '9.26', version: '9.26',
            htmlUrl: `${mod.githubUrl}/releases/tag/9.26`, publishedAt: '2026-09-26T00:00:00Z',
            assets: names.map(name => ({ name, size: 100, downloadUrl: `${mod.githubUrl}/releases/download/9.26/${name}` })) }]);
        assert.deepEqual(Array.from(candidates, item => item.assetName), ['UCB-zedfix-1.0.3.zip'], '作者标记过期的三个旧包不得进入历史安装候选');
        assert.equal(candidates[0].version, '1.0.3', '安装包版本必须优先于日期形式的发布标题、Tag及索引版号');
        assert.deepEqual(Array.from(candidates[0].assets, item => item.name), ['UCB-zedfix-1.0.3.zip']);
        assert.equal(candidates[0].compatibility.evidence, 'unknown', '模组版号不能误识别成游戏适配证据');
        assert.equal(versions.getLatestGameCandidate(mod, candidates), null, '没有游戏适配证据不能冒充当前游戏的兼容候选');
        const ranked = versions.rankCandidates(mod, candidates);
        assert.equal(ranked.candidates[0].version, '1.0.3');
        assert.equal(ranked.recommendedKey, '', '未声明适配不能显示适配推荐');
        assert.equal(ranked.defaultKey, candidates[0].candidateKey, '未声明适配时仍应默认最新主包');
        assert.equal(ranked.defaultRisk, true, '默认最新不能代替安装前的风险确认');
    }
    {
        const { sb, versions, calls } = loadVersions();
        sb.StartConfig.version = 'v0.5.10.12-cn+test';
        assert.equal(versions.getGameVersion(), '0.5.10.12', '版本比较必须保留第四段并去除版本后缀');
        // 非 ASCII 的本体后缀同样不能令游戏版本无法识别。
        sb.StartConfig.version = '0.5.10.12-汉化版';
        assert.equal(versions.getGameVersion(), '0.5.10.12');
        const supported = versions.assessCompatibility('>=0.5.10.1&&<0.5.11.0');
        assert.equal(supported.status, 'compatible');
        assert.deepEqual(Array.from(calls[0].version.version), [0, 5, 10, 12]);
        assert.equal(calls[0].ranges[0].range, '>=0.5.10.1&&<0.5.11.0');
        assert.equal(calls[0].ignorePostfix, true, '必须和原生游戏检查一样忽略后缀');
        assert.equal(versions.assessCompatibility('>=0.5.11.0').status, 'incompatible');
        assert.equal(versions.assessCompatibility('^0.5.10.12||^0.4.0.0').status, 'compatible');
        for (const range of ['', '~0.5.10', '*', '>=0.5.10 <0.5.11', '^0.5||invalid', 'v0.5.10', '>= 0.5.10']) {
            assert.equal(versions.assessCompatibility(range).status, 'unknown', `不支持的声明必须标未知：${range}`);
        }
        assert.equal(versions.assessCompatibility('>=0.5&&>=0.6').status, 'unknown', '原生拒绝的重复下界不能误判不适配');
        sb.modSC2DataManager = null;
        assert.equal(versions.assessCompatibility('^0.5.10').status, 'unknown', '没有原生比较器不能自造兼容结论');
        sb.StartConfig.version = '异常版本';
        assert.equal(versions.getGameVersion(), '');
        assert.equal(versions.assessCompatibility('^0.5.10').status, 'unknown');
    }

    {
        const { sb, versions } = loadVersions();
        const declaration = { gameVersionRange: '>=0.5.10.1&&<0.5.11.0', evidenceUrl: 'https://github.com/Owner/Example/releases/tag/v2.0' };
        const history = { releases: [
            release('3.0', [asset('Example-v3.0.zip')], { gameVersionRange: '>=0.5.11.0' }),
            release('2.0', [asset('Example-v2.0.zip'), asset('Example-v1.5.zip'), asset('Example.PhotoPack-v2.0.zip')], declaration),
            release('1.0', [asset('Example-v1.0-DoL-0.5.10.12.zip')]),
            release('4.0', [asset('Example-v4.0.zip')]),
        ] };
        const candidates = versions.buildCandidates(baseMod, history);
        assert.equal(candidates.length, 5, '同一发布内的旧版主资产必须保留');
        const old = candidates.find(candidate => candidate.version === '1.5');
        assert.ok(old, '手选低版本必须有独立 releaseInfo');
        assert.equal(old.assets[0].name, 'Example-v1.5.zip');
        assert.equal(old.assets.length, 1, '旧版主包不能搭配新版附属包');
        const newestCompatible = candidates.find(candidate => candidate.version === '2.0');
        assert.equal(newestCompatible.assets.length, 2, '保留同发布同版本配对附属包');
        assert.equal(newestCompatible.compatibility.evidenceUrl, declaration.evidenceUrl);
        const ranked = versions.rankCandidates(baseMod, candidates);
        assert.deepEqual(Array.from(ranked.candidates, candidate => candidate.version), ['2.0', '1.5', '1.0', '4.0', '3.0']);
        assert.equal(ranked.recommendedKey, newestCompatible.candidateKey, '声明匹配组的最新版本优先推荐');
        assert.equal(ranked.gameVersion, '0.5.10.12');
        assert.equal(versions.rankCandidates(baseMod, candidates, { updateOnly: true, localVersion: '2.0' }).recommendedKey, '', '全部更新不得自动选旧版或等版本');
        assert.equal(versions.rankCandidates(baseMod, candidates, { updateOnly: true, localVersion: '1.5' }).recommendedKey, newestCompatible.candidateKey);
        assert.equal(versions.renderCandidateOptions(ranked.candidates, ranked.recommendedKey)[1].value, newestCompatible.candidateKey);
        assert.ok(versions.renderCandidateOptions(ranked.candidates, ranked.recommendedKey)[1].label.startsWith('推荐：'));
        const declaredStatus = versions.getCandidateStatus(newestCompatible, { recommended: true });
        assert.equal(declaredStatus.label, '推荐，作者声明适配');
        assert.equal(declaredStatus.tone, 'green');
        assert.match(declaredStatus.reason, /作者声明/);
        assert.doesNotMatch(declaredStatus.reason, /实测|验证通过/, '作者支持范围不能表述为游戏实测结论');
        assert.equal(old.requiresManualSelection, false);
        assert.ok(old.assetUrl && old.assetName && old.tagName, '候选必须能直接交给已有下载器');
        sb.StartConfig.version = '';
        const unknown = versions.buildCandidates(baseMod, history);
        const unknownSelection = versions.rankCandidates(baseMod, unknown);
        assert.equal(unknownSelection.recommendedKey, '', '无法识别本体版本不能显示适配推荐');
        assert.equal(unknown.find(candidate => candidate.candidateKey === unknownSelection.defaultKey).version, '4.0', '未识别游戏时仍应默认数值最新版本');
        assert.equal(unknownSelection.defaultRisk, true);
        assert.match(unknownSelection.defaultReason, /当前游戏版本未能识别/);
    }

    {
        const { sb, versions } = loadVersions();
        const declaration = { gameVersionRange: '^0.5.10.12' };
        const neutralMod = { ...baseMod, bootNames: [] };
        const variants = versions.buildCandidates(neutralMod, [release('2.0', [asset('Example-EN-v2.0.zip'), asset('Example-CN-v2.0.zip')], declaration)]);
        assert.equal(variants.length, 2);
        assert.equal(versions.rankCandidates(neutralMod, variants).recommendedKey, '', '不同语言或型号不得跨系列预选');
        assert.equal(versions.rankCandidates(neutralMod, variants, { updateOnly: true, localVersion: '1.0' }).defaultKey, '', '全部更新也不能跨语言或型号默认选择');
        assert.equal(versions.getLatestUpdateCandidate(neutralMod, variants), null, '多产品系列不得猜测更新候选');
        const noDeclaration = versions.buildCandidates(baseMod, [release('4.0', [asset('Example-v4.0.zip')])]);
        const undeclaredSelection = versions.rankCandidates(baseMod, noDeclaration);
        assert.equal(undeclaredSelection.recommendedKey, '', '没有匹配证据不能显示适配推荐');
        assert.equal(undeclaredSelection.defaultKey, noDeclaration[0].candidateKey, '没有适配声明时默认最新主包');
        assert.equal(undeclaredSelection.defaultRisk, true);
        assert.match(undeclaredSelection.defaultReason, /作者未声明/);
        assert.equal(undeclaredSelection.candidates[0].candidateKey, noDeclaration[0].candidateKey, '未知兼容包仍须可见、可手动选择');
        assert.equal(versions.getLatestUpdateCandidate(baseMod, noDeclaration).candidateKey, noDeclaration[0].candidateKey, '无适配声明的单一正式主包仍须发现新版');
        assert.equal(versions.getLatestGameCandidate(baseMod, noDeclaration), null, '发现新版不能将未知适配候选变成当前游戏推荐');
        const undeclaredUpdate = versions.rankCandidates(baseMod, noDeclaration, { updateOnly: true, localVersion: '3.0' });
        assert.equal(undeclaredUpdate.defaultKey, noDeclaration[0].candidateKey, '全部更新默认选择单一系列的无声明新版');
        assert.equal(undeclaredUpdate.defaultRisk, true, '无声明新版默认选择仍保留安装前风险确认');
        assert.equal(undeclaredUpdate.recommendedKey, '', '默认选择不能把未知适配标为当前游戏推荐');
        for (const localVersion of ['4.0', '4.1', '']) {
            assert.equal(versions.rankCandidates(baseMod, noDeclaration, { updateOnly: true, localVersion }).defaultKey, '',
                '全部更新不默认选择等版、旧版，或无法比较本地版本的包');
        }
        const reference = versions.buildCandidates(baseMod, [release('1.0', [asset('Example-v1.0-DoL-0.5.10.12.zip')])]);
        assert.equal(reference[0].compatibility.status, 'unknown');
        assert.equal(reference[0].compatibility.evidence, 'filename');
        assert.equal(versions.rankCandidates(baseMod, reference).recommendedKey, reference[0].candidateKey, '文件名精确匹配可供参考推荐，不能标声明已验证');
        assert.equal(versions.rankCandidates(baseMod, reference).defaultKey, reference[0].candidateKey, '名称精确匹配时恢复当前游戏最新主包的默认选择');
        assert.match(versions.rankCandidates(baseMod, reference).defaultReason, /根据安装包名称/);
        const referenceStatus = versions.getCandidateStatus(reference[0], { recommended: true });
        assert.equal(referenceStatus.label, '参考推荐');
        assert.equal(referenceStatus.tone, 'gold', '文件名线索不能使用已声明适配的绿色状态');
        assert.match(referenceStatus.reason, /安装包名称.*DoL 0\.5\.10\.12/);
        assert.match(referenceStatus.reason, /选择后.*核对.*适配说明/);
        assert.doesNotMatch(referenceStatus.reason, /文件名对应|包内适配未核验|作者声明|实测/, '参考理由应解释线索来源及选择后的核对步骤');
        assert.ok(versions.renderCandidateOptions(reference, reference[0].candidateKey)[1].label.startsWith('参考推荐：'));
        const gameBranches = versions.buildCandidates(baseMod, [release('1.0', [asset('Example-v1.0-DoL-v0.5.10.12.zip')]),
            release('2.0', [asset('Example-v2.0-DoL-0.5.11.0.zip')])]);
        assert.equal(new Set(gameBranches.map(candidate => candidate.seriesKey)).size, 1, 'DoL目标版本及v前缀不能拆成不同产品系列');
        assert.equal(versions.rankCandidates(baseMod, gameBranches).recommendedKey, gameBranches.find(candidate => candidate.version === '1.0').candidateKey, '同系列旧版游戏分支应被推荐');
        const conflicts = versions.buildCandidates(baseMod, [release('1.0', [asset('Example-v1.0-DoL-0.5.10.12.zip')], { gameVersionRange: '>=0.5.11.0' })]);
        assert.equal(conflicts[0].compatibility.status, 'incompatible', '声明不匹配必须优先于文件名提示');
        assert.equal(versions.rankCandidates(baseMod, conflicts).recommendedKey, '');
        assert.equal(versions.rankCandidates(baseMod, conflicts).defaultKey, '', '明确不兼容的包不能默认选中');
        assert.equal(versions.rankCandidates(baseMod, conflicts, { updateOnly: true, localVersion: '0.9' }).defaultKey, '', '全部更新仍排除明确不兼容的包');
        assert.equal(versions.rankCandidates(baseMod, conflicts).defaultRisk, false);
        assert.equal(versions.getLatestUpdateCandidate(baseMod, conflicts), null, '作者声明不适配当前游戏的包不得成为更新候选');
        assert.equal(versions.getCandidateStatus(conflicts[0]).tone, 'red', '红色风险只用于明确的作者支持范围不符');
        const mixedEvidence = versions.buildCandidates(baseMod, [release('1.0', [asset('Example-v1.0.zip')], declaration),
            release('2.0', [asset('Example-v2.0-DoL-0.5.10.12.zip')]), release('3.0', [asset('Example-v3.0-DoL-0.5.11.0.zip')])]);
        assert.equal(versions.getLatestGameCandidate(baseMod, mixedEvidence).version, '2.0', '更新检测先排除其他游戏分支，再比较最高模组版本，不因证据等级推荐旧版');
        const mixedSelection = versions.rankCandidates(baseMod, mixedEvidence);
        assert.equal(mixedSelection.candidates[0].version, '2.0', '文件名匹配的新版必须排在作者声明匹配的旧版之前');
        assert.equal(mixedSelection.defaultKey, mixedEvidence.find(candidate => candidate.version === '2.0').candidateKey, '匹配当前游戏的候选按模组版本选最高，不因旧版声明证据而默认旧版');
        assert.equal(mixedSelection.defaultKey, mixedSelection.recommendedKey, '当前游戏最高候选的默认勾选与参考推荐保持一致');
        assert.equal(mixedSelection.defaultRisk, false);
        assert.equal(versions.rankCandidates(baseMod, mixedEvidence, { updateOnly: true, localVersion: '1.0' }).recommendedKey,
            mixedEvidence.find(candidate => candidate.version === '2.0').candidateKey);
        assert.equal(versions.rankCandidates(baseMod, mixedEvidence, { updateOnly: true, localVersion: '1.0' }).defaultKey,
            mixedEvidence.find(candidate => candidate.version === '2.0').candidateKey, '全部更新也恢复文件名匹配新版的默认勾选');
        assert.equal(versions.getLatestGameCandidate(neutralMod, variants), null, '多个语言或型号仍应留给用户选择');
        const mismatched = versions.buildCandidates(baseMod, [release('3.0', [asset('Example-v3.0-DoL-0.5.9.0.zip')]),
            release('2.0', [asset('Example-v2.0.zip')])]);
        const referenceMismatch = mismatched.find(candidate => candidate.version === '3.0');
        assert.equal(referenceMismatch.compatibility.status, 'unknown', '仅文件名不同不能宣称明确不兼容');
        assert.equal(referenceMismatch.compatibility.referenceMismatch, true);
        assert.equal(versions.getLatestUpdateCandidate(baseMod, [referenceMismatch]), null, '名称指向其他游戏版本的包不得成为更新候选');
        assert.equal(versions.getCandidateStatus(referenceMismatch).tone, 'grey', '名称标注其他版本仍是待核对线索，不应显示明确不适配的红色');
        assert.match(versions.getCandidateStatus(referenceMismatch).reason, /当前游戏为 DoL 0\.5\.10\.12/);
        assert.equal(versions.getCandidateStatus(noDeclaration[0]).label, '适配待核对');
        assert.equal(versions.getCandidateStatus(noDeclaration[0]).tone, 'grey');
        assert.equal(versions.rankCandidates(baseMod, mismatched).candidates.at(-1).candidateKey, referenceMismatch.candidateKey, '文件名参考不匹配仍排在末尾');
        const scoped = release('1.0', [asset('Example-v1.0.zip', { dependencies: [] })], declaration);
        scoped.dependencies = [{ id: 'latest-framework', version: '>=2.0' }];
        assert.equal(versions.buildCandidates(baseMod, [scoped])[0].dependencies.length, 0, '资产显式空依赖必须覆盖发布级新版依赖');
        scoped.assets[0].dependencies = [{ id: 'old-framework', version: '^1.0' }];
        assert.equal(versions.buildCandidates(baseMod, [scoped])[0].dependencies[0].id, 'old-framework');
        const dated = [release('1.0', [asset('Example-v1.0.zip')], declaration),
            release('1.0.0', [asset('Example-v1.0.zip')], declaration),
            release('1.0.0.0', [asset('Example-v1.0.zip')], declaration)];
        dated[0].publishedAt = '2025-09-30T00:00:00Z';
        dated[2].publishedAt = null;
        const byDate = versions.rankCandidates({ ...baseMod, updateDate: '2026-09-30' }, versions.buildCandidates(baseMod, dated)).candidates;
        assert.equal(byDate[0].tagName, 'v1.0.0', '同数字版本按历史发布日期降序');
        assert.equal(byDate.at(-1).updateDate, '', '历史发布日期缺失不能借用目录最新版日期');
        sb.modHubIsMobile = true;
        const platform = versions.buildCandidates(neutralMod, [release('1.0', [asset('Example-Mobile-v1.0.zip'), asset('Example-Desktop-v1.0.zip')], declaration)]);
        assert.equal(platform.length, 1);
        assert.ok(platform[0].assetName.includes('Mobile'), '历史候选仍保留现有平台隔离');
        const shared = versions.buildCandidates({ ...baseMod, sharedRepository: true }, [release('1.0', [asset('Unrelated-v1.0.zip')], declaration)]);
        assert.equal(shared.length, 0, '共享仓库不得提供其他模组作为历史候选');
        sb.StartConfig.version = '';
        const unknownGame = versions.buildCandidates(baseMod, [release('1.0', [asset('Example-v1.0-DoL-0.5.10.12.zip')])]);
        assert.equal(unknownGame[0].compatibility.targetGameVersion, '0.5.10.12', '未识别当前游戏时仍应保留安装包名称的目标版本线索');
        assert.equal(versions.getCandidateStatus(unknownGame[0]).label, '适配待核对', '未识别当前游戏不能声称名称对应当前版本');
        assert.match(versions.getCandidateStatus(unknownGame[0]).reason, /当前游戏版本未能识别/);
        assert.equal(versions.rankCandidates(baseMod, unknownGame).recommendedKey, '');
        assert.equal(versions.rankCandidates(baseMod, unknownGame).defaultKey, unknownGame[0].candidateKey);
        assert.equal(versions.rankCandidates(baseMod, unknownGame).defaultRisk, true);
    }

    {
        const { sb, versions } = loadVersions();
        const candidate = (version, name = `Example-v${version}.zip`, compatibility = { status: 'unknown', evidence: 'unknown' }, seriesKey = 'Example', tagName = `v${version || 'unknown'}`) => {
            const assetUrl = `https://github.com/Owner/Example/releases/download/${tagName}/${name}`;
            return { candidateKey: JSON.stringify(['example', tagName, assetUrl]), tagName, version, assetName: name,
                assetUrl, assets: [{ name, size: 100, downloadUrl: assetUrl }], seriesKey, compatibility, updateDate: '2026-10-01' };
        };
        const compatible = { status: 'compatible', evidence: 'declaration' };
        const latest = candidate('2.10', undefined, compatible), previous = candidate('2.9', undefined, compatible);
        const unknownOlder = candidate('3.9'), unknownNewer = candidate('3.10');
        assert.equal(versions.getLatestUpdateCandidate(baseMod, [unknownOlder, unknownNewer]).candidateKey, unknownNewer.candidateKey, '未知适配的单一系列应按数值发现最高版本');
        assert.equal(versions.getLatestUpdateCandidate(baseMod, [unknownNewer, previous, latest]).candidateKey, latest.candidateKey, '当前游戏已有适配候选时仍优先该候选，不转向未知适配高版');
        const snapshot = JSON.stringify([latest, previous]);
        const selected = versions.getDefaultSelection(baseMod, [previous, latest], { localVersion: '2.10' });
        assert.equal(selected.defaultKey, latest.candidateKey, '本地同版应保持最新选择，不能为了可安装而默认旧版');
        assert.equal(JSON.stringify([latest, previous]), snapshot, '默认选择不得改变兼容性状态或原始候选');
        assert.equal(versions.getDefaultSelection(baseMod, [previous, latest], { localVersion: '3.0' }).defaultKey, '', '不能自动默认低于本地版本的包');
        assert.equal(versions.getDefaultSelection(baseMod, [previous, latest], { updateOnly: true, localVersion: '1.0' }).defaultKey, latest.candidateKey, '全部更新可以默认选中作者声明匹配的最新版本');
        assert.equal(versions.getDefaultSelection(baseMod, [candidate('3.0')]).defaultKey, candidate('3.0').candidateKey, '未知适配的无歧义最新候选恢复默认选择');
        assert.equal(versions.getDefaultSelection(baseMod, [candidate('3.0')]).defaultRisk, true, '默认最新不修改未知适配证据');
        assert.equal(versions.getDefaultSelection(baseMod, [candidate('3.0')], { updateOnly: true, localVersion: '1.0' }).defaultKey,
            candidate('3.0').candidateKey, '全部更新与多选安装共用无歧义最新版默认选择');
        const unknownVersion = candidate('', 'Example.zip');
        assert.equal(versions.getDefaultSelection(baseMod, [unknownVersion]).defaultKey, unknownVersion.candidateKey, '唯一合法发布可以预选，不将标签伪造成数字版号');
        assert.equal(versions.getDefaultSelection(baseMod, [unknownVersion]).defaultRisk, true, '无数字版号的唯一发布仍须确认适配风险');
        assert.equal(versions.getDefaultSelection(baseMod, [unknownVersion], { updateOnly: true, localVersion: '1.0' }).defaultKey, '', '未知版号不能自动认定高于已安装版本');
        assert.equal(versions.getDefaultSelection(baseMod, [latest, candidate('3.0', 'Example-EN-v3.0.zip', undefined, 'Example-EN')]).defaultKey, '', '不同主包语言或型号不得默认跨系列');
        const otherFormat = candidate('2.10', 'Example-v2.10.modpack', compatible);
        assert.equal(versions.getDefaultSelection(baseMod, [latest, otherFormat]).defaultKey, '', '相同版本不同主资产格式不得擅自选择');
        assert.equal(versions.getDefaultSelection(baseMod, [latest, otherFormat], { updateOnly: true, localVersion: '1.0' }).defaultKey, '', '全部更新仍保留同版主资产歧义，不能默认下载');
        assert.equal(versions.getLatestUpdateCandidate(baseMod, [latest, otherFormat]), null, '同版不同主包存在歧义时不得猜测更新候选');
        assert.equal(versions.getLatestUpdateCandidate(baseMod, [latest, otherFormat, unknownNewer]), null, '当前游戏适配主包有歧义时不得借未知适配新版绕过人工选择');
        assert.equal(versions.getDefaultSelection(baseMod, [{ ...latest, compatibility: compatible }, { ...otherFormat, compatibility: compatible }, candidate('3.0')]).defaultKey,
            '', '匹配版本的主资产存在歧义时，不得借未知适配的新版绕过人工选择');
        const olderRelease = { ...candidate('2.10', undefined, compatible, 'Example', 'older-tag'), updateDate: '2026-09-30' };
        assert.equal(versions.getDefaultSelection(baseMod, [olderRelease, latest]).defaultKey, latest.candidateKey, '同名同版本主包重复发布按实际日期消歧');
        const unsupported = candidate('3.0', undefined, { status: 'incompatible', evidence: 'declaration', gameVersionRange: '>=0.5.11.0' });
        assert.equal(versions.getDefaultSelection(baseMod, [unsupported]).defaultKey, '');
        assert.equal(versions.getDefaultSelection(baseMod, [unsupported]).defaultReason, '');
        assert.equal(unsupported.compatibility.status, 'incompatible', '保留明确不兼容状态供用户核对');
        const matched = candidate('2.10', undefined, { status: 'compatible', evidence: 'declaration' });
        assert.equal(versions.getDefaultSelection(baseMod, [matched], { updateOnly: true, localVersion: '2.9' }).defaultKey, matched.candidateKey);
        assert.equal(versions.getDefaultSelection(baseMod, [matched], { updateOnly: true, localVersion: '2.10' }).defaultKey, '', '全部更新仍排除等版本');
        sb.StartConfig.version = '';
        assert.equal(versions.getDefaultSelection(baseMod, [matched]).defaultKey, matched.candidateKey, '游戏未识别时采用无歧义最新候选');
        assert.equal(versions.getDefaultSelection(baseMod, [matched]).defaultRisk, true, '旧匹配状态不能免除游戏未识别时的风险确认');
    }

    {
        const { sb, versions } = loadVersions();
        let revision = 1;
        sb.modHubMarket.getCommunityRevision = () => revision;
        let calls = 0;
        let fail = false;
        sb.fetch = async url => {
            assert.equal(url, sb.modHubMarket.RELEASE_INDEX_MIRRORS[0]);
            return { ok: true, json: async () => ({ schemaVersion: 1, communityRevision: revision, mods: [baseMod] }) };
        };
        await sb.modHubMarket.fetchReleaseIndex();
        assert.equal(sb.modHubMarket.getActiveReleaseWorkerBaseUrl(), sb.modHubMarket.RELEASE_INDEX_MIRRORS[0]);
        const responseFor = (mod, page = 1) => ({ schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl, page,
            hasMore: page === 1, fetchedAt: new Date().toISOString(), communityRevision: revision,
            releases: [release('1.0', [asset('Example-v1.0.zip')])] });
        sb.fetch = async url => {
            calls++;
            if (fail) throw new Error('模拟离线');
            assert.ok(String(url).includes('/mod-releases?'));
            assert.equal(new URL(url).origin, new URL(sb.modHubMarket.RELEASE_WORKER_API_BASE).origin,
                '目录镜像可返回索引，但历史请求必须使用真实 Worker API，避免本地游戏收到无跨域响应头的 404');
            const page = Number(new URL(url).searchParams.get('page'));
            return { ok: true, json: async () => responseFor(baseMod, page) };
        };
        await versions.fetchReleases(baseMod);
        assert.equal((await versions.fetchReleases(baseMod)).fromCache, true);
        assert.equal(calls, 1, '六小时内复用同来源成功缓存');
        const historyWrites = [];
        const writeHistory = sb.localStorage.setItem;
        sb.localStorage.setItem = (key, value) => { historyWrites.push([key, value]); writeHistory(key, value); };
        await versions.fetchReleases(baseMod, { useCache: false });
        const [currentKey, storedHistory] = historyWrites.find(([key]) => key.startsWith('modhub_market_history_v1_'));
        const oldHistory = JSON.parse(storedHistory);
        const oldSignature = JSON.parse(oldHistory.signature);
        assert.equal(oldSignature.pop(), 'modpack-v1', '历史缓存签名须隔离旧附件筛选规则');
        oldHistory.signature = JSON.stringify(oldSignature);
        oldHistory.data.releases = [];
        const oldKey = 'modhub_market_history_v1_' + encodeURIComponent(oldHistory.signature);
        sb.localStorage.setItem(oldKey, JSON.stringify(oldHistory));
        sb.localStorage.removeItem(currentKey);
        const beforeRefresh = calls;
        assert.equal((await versions.fetchReleases(baseMod)).releases.length, 1, '历史旧规则的成功空缓存不能屏蔽新增 ModPack');
        assert.equal(calls, beforeRefresh + 1);
        assert.ok(sb.localStorage.getItem(oldKey), '缓存迁移只使用新签名，不删除其他存储');
        fail = true;
        assert.equal((await versions.fetchReleases(baseMod, { useCache: false })).stale, true, '离线只允许回退同来源历史缓存');
        await assert.rejects(versions.fetchReleases({ ...baseMod, releaseCompatibility: [{ releaseTag: 'v1.0', gameVersionRange: '^0.5.9.0' }] }), /模拟离线/, '兼容审核规则变化必须使旧历史缓存失效');
        await assert.rejects(versions.fetchReleases({ ...baseMod, identityId: 'other-identity' }), /模拟离线/, '身份摘要变化不得复用历史缓存');
        await assert.rejects(versions.fetchReleases({ ...baseMod, version: '2.0' }), /模拟离线/, '目录发现新版后不能被六小时旧历史缓存挡住');
        await assert.rejects(versions.fetchReleases({ ...baseMod, githubUrl: `${baseMod.githubUrl}/releases/tag/model` }), /模拟离线/, '固定发布渠道不能复用仓库默认渠道的历史缓存');
        await assert.rejects(versions.fetchReleases(baseMod, { page: 2 }), /模拟离线/, '不同分页不能共用上一页缓存');
        revision = 2;
        await assert.rejects(versions.fetchReleases(baseMod), /模拟离线/, '审核修订变化必须隔离历史缓存');
        revision = 1;
        sb.fetch = async () => ({ ok: false, status: 404, json: async () => ({ code: 'RELEASE_NOT_FOUND', error: '指定发布已失效' }) });
        await assert.rejects(versions.fetchReleases(baseMod, { useCache: false }), error => error.code === 'RELEASE_NOT_FOUND', '指定发布失效不能过期回退');
        sb.fetch = async () => { throw new Error('模拟离线'); };
        await assert.rejects(versions.fetchReleases(baseMod), /模拟离线/, '失效发布的旧缓存必须清除');
        sb.fetch = async () => ({ ok: true, json: async () => ({ ...responseFor(baseMod), sourceUrl: 'https://github.com/Owner/Other' }) });
        await assert.rejects(versions.fetchReleases(baseMod), error => error.code === 'RELEASE_SOURCE_CHANGED', '返回来源错配不能写入历史缓存');
        sb.modHubMarket.isWithdrawn = () => true;
        await assert.rejects(versions.fetchReleases(baseMod), error => error.code === 'MOD_RELEASES_UNAVAILABLE');
        sb.modHubMarket.isWithdrawn = () => false;
        sb.modHubMarket.hasCommunityReleaseSource = () => false;
        await assert.rejects(versions.fetchReleases({ ...baseMod, catalogSource: 'community' }), error => error.code === 'MANUAL_SOURCE', '社区手动来源不能变成自动历史下载');
    }

    {
        const valid = () => ({ schemaVersion: 1, id: baseMod.id, sourceUrl: baseMod.githubUrl, page: 1,
            hasMore: false, fetchedAt: new Date().toISOString(), communityRevision: 0, releases: [release('1.0', [asset('Example-v1.0.zip')])] });
        for (const stage of ['headers', 'body', 'error-body']) {
            for (const supportsAbort of [true, false]) {
                const { sb, versions } = loadVersions();
                sb.modHubMarket.getCommunityRevision = () => 0;
                sb.modHubMarket.hasCommunityReleaseSource = () => true;
                sb.AbortController = supportsAbort ? AbortController : undefined;
                const timers = new Map(), writes = [];
                sb.setTimeout = (callback, delay) => { timers.set(1, { callback, delay }); return 1; };
                sb.clearTimeout = id => timers.delete(id);
                sb.localStorage.setItem = (key, value) => writes.push([key, value]);
                let finish, requestSignal;
                const delayed = new Promise(resolve => { finish = resolve; });
                sb.fetch = async (_, options) => {
                    requestSignal = options.signal;
                    return stage === 'headers' ? delayed : { ok: stage !== 'error-body', status: 502, json: () => delayed };
                };
                const pending = versions.fetchReleases({ ...baseMod, catalogSource: 'community', autoInstall: true });
                const timer = timers.get(1);
                assert.equal(timer.delay, 20000, '前端必须允许 Worker 的 15 秒上游查询完成并保留网络往返时间');
                for (let index = 0; index < 10; index++) await Promise.resolve();
                timer.callback();
                await assert.rejects(pending, error => error.code === 'RELEASE_TIMEOUT' && error.name === 'TimeoutError'
                    && /20 秒/.test(error.message), `${stage} 等待必须有明确上限，不能透出无原因的 AbortError`);
                assert.equal(timers.size, 0, '超时后应清理计时器');
                if (supportsAbort) {
                    assert.equal(requestSignal.aborted, true, '支持取消时同时停止实际网络请求');
                    assert.equal(requestSignal.reason.code, 'RELEASE_TIMEOUT');
                }
                finish(stage === 'headers' ? { ok: true, json: async () => valid() } : valid());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
                assert.equal(writes.length, 0, '超时后迟到的响应不得污染历史缓存');
            }
        }
        const { sb, versions } = loadVersions();
        sb.modHubMarket.getCommunityRevision = () => 0;
        sb.AbortController = AbortController;
        const timers = new Map();
        sb.setTimeout = callback => { timers.set(1, callback); return 1; };
        sb.clearTimeout = id => timers.delete(id);
        sb.fetch = async () => ({ ok: true, json: async () => valid() });
        await versions.fetchReleases(baseMod);
        let requestSignal;
        sb.fetch = async (_, options) => { requestSignal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; };
        const timedOut = versions.fetchReleases(baseMod, { useCache: false });
        timers.get(1)();
        const fallback = await timedOut;
        assert.equal(fallback.fromCache, true);
        assert.equal(fallback.stale, true, '请求超时可回退经来源核验的旧缓存');
        const cancellation = new AbortController();
        const canceled = versions.fetchReleases(baseMod, { useCache: false, signal: cancellation.signal });
        cancellation.abort();
        await assert.rejects(canceled, error => error.name === 'AbortError' && error.code === 'ABORT_ERR', '用户取消必须结束等待且不得改为缓存成功');
        assert.equal(requestSignal.aborted, true);
        assert.equal(timers.size, 0, '用户取消后应清理计时器');
        await assert.rejects(versions.fetchReleases(baseMod, { signal: cancellation.signal }), error => error.code === 'ABORT_ERR', '已有新鲜缓存也不能越过用户取消');
        sb.AbortController = undefined;
        const oldBrowserCancellation = new AbortController();
        const oldBrowserRequest = versions.fetchReleases(baseMod, { useCache: false, signal: oldBrowserCancellation.signal });
        oldBrowserCancellation.abort();
        await assert.rejects(oldBrowserRequest, error => error.code === 'ABORT_ERR', '缺少内部 AbortController 时仍须立即结束用户取消的等待');
    }

    {
        for (const action of ['timeout', 'cancel']) {
            for (const supportsAbort of [true, false]) {
                const { sb, versions } = loadVersions();
                sb.AbortController = supportsAbort ? AbortController : undefined;
                const timers = new Map();
                let timerId = 0, directSignal, calls = 0, writes = 0;
                sb.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
                sb.clearTimeout = id => timers.delete(id);
                sb.localStorage.setItem = () => { writes++; };
                sb.fetch = async (url, options) => {
                    calls++;
                    if (!String(url).startsWith('https://api.github.com/')) throw new Error('模拟 Worker 连接失败');
                    directSignal = options.signal;
                    return { ok: true, json: () => new Promise(() => {}) };
                };
                const cancellation = new AbortController();
                const pending = versions.fetchReleases(baseMod, { signal: cancellation.signal });
                for (let index = 0; index < 10; index++) await Promise.resolve();
                assert.equal(calls, 2);
                assert.equal(timers.size, 1, '进入直连前应清理 Worker 等待计时器');
                const timer = [...timers.values()][0];
                assert.equal(timer.delay, 10000, '历史直连包含响应体的等待上限为 10 秒，合计最多 30 秒');
                if (action === 'timeout') timer.callback();
                else cancellation.abort();
                await assert.rejects(pending, error => action === 'timeout'
                    ? error.code === 'RELEASE_TIMEOUT' && /GitHub.*10 秒/.test(error.message)
                    : error.code === 'ABORT_ERR', '直连也必须支持超时与用户取消');
                assert.equal(timers.size, 0);
                assert.equal(writes, 0);
                if (supportsAbort) assert.equal(directSignal.aborted, true);
            }
        }
        for (const status of [403, 503]) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.getCommunityRevision = () => 0;
            let timer, calls = 0;
            sb.setTimeout = callback => { timer = callback; return 1; };
            sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, id: baseMod.id, sourceUrl: baseMod.githubUrl,
                page: 1, hasMore: false, communityRevision: 0, fetchedAt: new Date().toISOString(), releases: [] }) });
            await versions.fetchReleases(baseMod);
            sb.fetch = async () => { calls++; return { ok: false, status, json: () => new Promise(() => {}) }; };
            const pending = versions.fetchReleases(baseMod, { useCache: false });
            for (let index = 0; index < 10; index++) await Promise.resolve();
            timer();
            await assert.rejects(pending, error => error.code === 'RELEASE_TIMEOUT' && error.status === status,
                '已收到拒绝或无法核验响应时，错误体停滞不能借超时改名绕过来源限制');
            assert.equal(calls, 1, '安全错误既不回退缓存，也不直连');
        }
    }

    {
        const diagnostics = { name: 'TimeoutError', message: 'The user aborted a request. <script>bad()</script>', status: '403',
            retryAfter: '60', rateLimitRemaining: '0', rateLimitReset: '1791000000' };
        for (const failure of [
            { status: 504, code: 'RELEASE_UPSTREAM_TIMEOUT', error: '作者发布服务响应超时，请稍后重试' },
            { status: 429, code: 'RELEASE_REQUEST_LIMITED', error: '版本列表请求过于频繁，请稍后重试' },
            { status: 429, code: 'RELEASE_RATE_LIMITED', error: '作者发布服务暂时限制请求，请稍后重试' },
            { status: 502, code: 'FUTURE_RELEASE_ERROR', error: 'upstream connection failed' },
            { status: 502, error: 'The user aborted a request.' }
        ]) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.hasCommunityReleaseSource = () => true;
            sb.fetch = async () => ({ ok: false, status: failure.status, json: async () => ({ ...failure, details: diagnostics }) });
            await assert.rejects(versions.fetchReleases({ ...baseMod, catalogSource: 'community', autoInstall: true }), error => {
                assert.ok(/[\u3400-\u9fff]/.test(error.message) && !/The user|connection failed/.test(error.message), '新旧服务端及未知代码的主状态必须使用中文');
                assert.equal(error.code, failure.code || 'RELEASE_UPSTREAM_FAILED');
                assert.equal(error.status, failure.status);
                const info = versions.getHistoryErrorInfo(error);
                assert.ok(info.details.includes(`原始错误：${diagnostics.message}`));
                assert.ok(info.details.includes('上游响应：HTTP 403') && info.details.includes('上游剩余请求额度：0'));
                assert.ok(info.details.includes('建议等待：60') && info.details.includes('上游额度重置时间：1791000000'));
                return true;
            });
        }
        const legacy = loadVersions();
        legacy.sb.modHubMarket.hasCommunityReleaseSource = () => true;
        legacy.sb.fetch = async () => ({ ok: false, status: 502, headers: { get: header => ({ 'Retry-After': '120', 'X-RateLimit-Remaining': '0' }[header] || null) },
            json: async () => ({ error: 'The user aborted a request.' }) });
        await assert.rejects(legacy.versions.fetchReleases({ ...baseMod, catalogSource: 'community', autoInstall: true }), error => {
            assert.ok(error.details.message.includes('The user aborted a request.'));
            assert.equal(error.details.retryAfter, '120'); assert.equal(error.details.rateLimitRemaining, '0');
            return true;
        });
        const valid = () => ({ schemaVersion: 1, id: baseMod.id, sourceUrl: baseMod.githubUrl, page: 1,
            hasMore: false, fetchedAt: new Date().toISOString(), communityRevision: 0, releases: [release('1.0', [asset('Example-v1.0.zip')])] });
        for (const [status, code] of [[504, 'RELEASE_UPSTREAM_TIMEOUT'], [429, 'RELEASE_REQUEST_LIMITED'], [429, 'RELEASE_RATE_LIMITED']]) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.getCommunityRevision = () => 0;
            sb.fetch = async () => ({ ok: true, json: async () => valid() });
            await versions.fetchReleases(baseMod);
            sb.fetch = async () => ({ ok: false, status, json: async () => ({ code, error: '模拟临时上游失败' }) });
            const cached = await versions.fetchReleases(baseMod, { useCache: false });
            assert.ok(cached.fromCache && cached.stale, '超时与临时限流继续允许同来源的过期缓存回退');
        }
        for (const [status, code] of [[400, 'INVALID_RELEASE_REQUEST'], [403, 'RELEASE_UPSTREAM_DENIED'], [404, 'RELEASE_NOT_FOUND'], [409, 'RELEASE_SOURCE_CHANGED'], [503, 'CATALOG_UNAVAILABLE'], [503, 'FUTURE_CATALOG_ERROR']]) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.getCommunityRevision = () => 0;
            sb.fetch = async () => ({ ok: true, json: async () => valid() });
            await versions.fetchReleases(baseMod);
            let requests = 0;
            sb.fetch = async () => { requests++; return { ok: false, status, json: async () => ({ code, error: '模拟核验拒绝' }) }; };
            await assert.rejects(versions.fetchReleases(baseMod, { useCache: false }), error => error.code === code);
            assert.equal(requests, 1, '拒绝与目录无法核验不能放宽为过期缓存或直连');
            sb.fetch = async () => { requests++; throw new Error('旧缓存不得保留'); };
            await assert.rejects(versions.fetchReleases(baseMod), /旧缓存不得保留/, '无法核验响应必须清除原有历史缓存');
        }
    }

    {
        const prefix = 'modhub_market_history_v1_';
        const responseFor = (mod, page) => ({ schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl, page,
            hasMore: page === 1, fetchedAt: new Date().toISOString(), communityRevision: 0,
            releases: [release(mod.githubUrl.endsWith('/v2.0') ? '2.0' : '1.0', [asset(`Example-v${mod.githubUrl.endsWith('/v2.0') ? '2.0' : '1.0'}.zip`)])] });
        for (const failure of ['worker-404', 'state-503', 'direct-404']) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.getCommunityRevision = () => 0;
            const storage = useEnumerableStorage(sb), base = sb.modHubMarket.RELEASE_WORKER_API_BASE;
            const target = { ...baseMod, githubUrl: `${baseMod.githubUrl}/releases/tag/v1.0` };
            const otherMod = { ...target, id: 'other-example' }, otherSource = { ...target, githubUrl: `${baseMod.githubUrl}/releases/tag/v2.0` };
            sb.fetch = async url => ({ ok: true, json: async () => responseFor(new URL(url).searchParams.get('id') === otherMod.id ? otherMod : target,
                Number(new URL(url).searchParams.get('page'))) });
            await versions.fetchReleases(target); await versions.fetchReleases(target, { page: 2 });
            const targetKeys = [...storage.keys()];
            const oldSignature = JSON.parse(decodeURIComponent(targetKeys[0].slice(prefix.length)));
            oldSignature.pop(); oldSignature[2] += '/#旧签名';
            const oldKey = prefix + encodeURIComponent(JSON.stringify(oldSignature));
            storage.set(oldKey, storage.get(targetKeys[0]));
            await versions.fetchReleases(otherMod);
            const otherModKey = [...storage.keys()].at(-1);
            sb.fetch = async () => ({ ok: true, json: async () => responseFor(otherSource, 1) });
            await versions.fetchReleases(otherSource);
            const otherSourceKey = [...storage.keys()].at(-1);
            sb.modHubMarket.RELEASE_WORKER_API_BASE = 'https://other-worker.test';
            sb.fetch = async () => ({ ok: true, json: async () => responseFor(target, 1) });
            await versions.fetchReleases(target);
            const otherWorkerKey = [...storage.keys()].at(-1);
            sb.modHubMarket.RELEASE_WORKER_API_BASE = base;
            storage.set('dol_opt_mod_order', '保留旧管理设置'); storage.set(prefix + '无法解析的旧键', '保留无法核验归属的旧存储');
            sb.fetch = async url => failure === 'direct-404' && !String(url).startsWith('https://api.github.com/')
                ? { ok: false, status: 502, json: async () => ({ code: 'RELEASE_UPSTREAM_FAILED', error: '模拟临时 Worker 故障' }) }
                : { ok: false, status: failure === 'state-503' ? 503 : 404, json: async () => ({
                    code: failure === 'state-503' ? 'RELEASE_SOURCE_STATE_UNAVAILABLE' : 'RELEASE_NOT_FOUND', error: '模拟来源核验失败' }) };
            await assert.rejects(versions.fetchReleases(target, { page: failure === 'direct-404' ? 3 : 1, useCache: false }),
                error => error.status === (failure === 'state-503' ? 503 : 404));
            assert.ok([...targetKeys, oldKey].every(key => !storage.has(key)), '不可安全回退错误必须使同来源全部分页及旧签名缓存失效');
            assert.ok([otherModKey, otherSourceKey, otherWorkerKey].every(key => storage.has(key)), '缓存清理必须保留其他条目、来源和 Worker');
            assert.equal(storage.get('dol_opt_mod_order'), '保留旧管理设置');
            assert.ok(storage.has(prefix + '无法解析的旧键'), '无法核验缓存归属时不得扩大清理范围');
            sb.fetch = async () => { throw new Error('模拟离线，旧页不得回退'); };
            await assert.rejects(versions.fetchReleases(target, { page: 2 }), /旧页不得回退/, '当前页失效后另一页不得通过热缓存或过期缓存复活');
            assert.equal((await versions.fetchReleases(otherMod)).fromCache, true);
            assert.equal((await versions.fetchReleases(otherSource)).fromCache, true);
            sb.modHubMarket.RELEASE_WORKER_API_BASE = 'https://other-worker.test';
            assert.equal((await versions.fetchReleases(target)).fromCache, true);
        }
        for (const stage of ['worker-success', 'worker-failure', 'direct-success']) {
            const { sb, versions } = loadVersions();
            sb.modHubMarket.getCommunityRevision = () => 0;
            const storage = useEnumerableStorage(sb);
            sb.fetch = async url => ({ ok: true, json: async () => responseFor(baseMod, Number(new URL(url).searchParams.get('page'))) });
            await versions.fetchReleases(baseMod); await versions.fetchReleases(baseMod, { page: 2 });
            let finish;
            const delayed = new Promise(resolve => { finish = resolve; });
            sb.fetch = async url => {
                if (String(url).startsWith('https://api.github.com/')) return { ok: true, json: () => delayed };
                if (new URL(url).searchParams.get('page') === '1') return { ok: false, status: 404,
                    json: async () => ({ code: 'RELEASE_NOT_FOUND', error: '模拟来源已失效' }) };
                if (stage === 'direct-success') throw new Error('模拟 Worker 故障，开始直连');
                return { ok: stage === 'worker-success', status: stage === 'worker-success' ? 200 : 502, json: () => delayed };
            };
            const page = stage === 'direct-success' ? 3 : 2;
            const pending = versions.fetchReleases(baseMod, { page, useCache: false });
            for (let index = 0; index < 20; index++) await Promise.resolve();
            await assert.rejects(versions.fetchReleases(baseMod, { useCache: false }), error => error.code === 'RELEASE_NOT_FOUND');
            assert.equal([...storage.keys()].filter(key => key.startsWith(prefix)).length, 0);
            sb.fetch = async () => ({ ok: true, json: async () => responseFor(baseMod, 1) });
            await versions.fetchReleases(baseMod);
            const recoveredKey = [...storage.keys()][0], recovered = storage.get(recoveredKey);
            finish(stage === 'direct-success' ? [{ tag_name: 'v1.0', assets: [{ name: 'Example-v1.0.zip', size: 100,
                browser_download_url: `${baseMod.githubUrl}/releases/download/v1.0/Example-v1.0.zip` }] }]
                : stage === 'worker-success' ? responseFor(baseMod, page) : { code: 'RELEASE_UPSTREAM_FAILED', error: '迟到临时错误' });
            await assert.rejects(pending, error => error.code === 'RELEASE_SOURCE_CHANGED', '失效前启动的网络请求不得用迟到结果更新界面或回退旧快照');
            assert.deepEqual([...storage.keys()], [recoveredKey], '迟到 Worker 或直连成功不能重新写回其他旧页');
            assert.equal(storage.get(recoveredKey), recovered, '迟到错误不能再次清空失效后取得的新成功缓存');
            assert.equal((await versions.fetchReleases(baseMod)).fromCache, true, '失效后启动的新请求仍可正常恢复缓存');
        }
    }

    {
        const rawRelease = (version, assets, tag = `v${version}`) => ({ tag_name: tag, name: version,
            published_at: '2026-09-30T00:00:00Z', assets: assets.map(item => ({ name: item.name, size: item.size,
                browser_download_url: item.downloadUrl.replace(/\/download\/[^/]+\//, `/download/${tag}/`) })) });
        const { sb, versions } = loadVersions();
        sb.modHubMarket.getCommunityRevision = () => 0;
        const calls = [];
        const current = rawRelease('2.0', [asset('Example-v2.0-DoL-0.5.10.12.modpack'), asset('Other-v9.0.zip')]);
        sb.fetch = async (url, options) => {
            calls.push(url);
            if (!String(url).startsWith('https://api.github.com/')) throw new Error('模拟 Worker 连接失败');
            assert.equal(new URL(url).searchParams.get('page'), '2');
            assert.equal(new URL(url).searchParams.get('per_page'), '20');
            assert.equal(options.headers.Accept, 'application/vnd.github+json');
            return { ok: true, headers: { get: () => '<https://api.github.com/repos/owner/example/releases?page=3>; rel="next"' }, json: async () => [
                current, { ...current, tag_name: 'draft', draft: true }, { ...current, prerelease: true },
                rawRelease('3.0', [asset('Example-v3.0.zip', { downloadUrl: 'https://github.com/Owner/Other/releases/download/v3/Example-v3.0.zip' })]),
                rawRelease('4.0', [asset('Unrelated-v4.0.zip')]) ] };
        };
        const direct = await versions.fetchReleases({ ...baseMod, sharedRepository: true }, { page: 2 });
        assert.equal(direct.fromGithub, true);
        assert.equal(direct.hasMore, true);
        assert.equal(direct.releases.length, 1, '直连历史排除草稿、预发布、异仓库附件与其他共享产品');
        assert.deepEqual(Array.from(versions.buildCandidates({ ...baseMod, sharedRepository: true }, direct), item => item.version), ['2.0']);
        assert.equal(calls.length, 2, 'Worker 网络错误应回退同仓库的历史分页接口');
        const reused = await versions.fetchReleases({ ...baseMod, sharedRepository: true }, { page: 2, useCache: false });
        assert.equal(reused.stale, true);
        assert.equal(calls.length, 3, '同来源成功缓存优先于再次直连');

        const pinned = { ...baseMod, githubUrl: `${baseMod.githubUrl}/releases/download/main/Example-v1.0.zip`,
            releaseCompatibility: [{ releaseTag: 'v0.9', assetName: 'Example-v0.9.zip', gameVersionRange: '^0.5.10.12',
                evidenceUrl: `${baseMod.githubUrl}/releases/tag/v0.9`, dependencies: [{ id: 'old-framework' }] }] };
        const pinnedCalls = [];
        sb.fetch = async url => {
            if (!String(url).startsWith('https://api.github.com/')) throw new Error('模拟 Worker 连接失败');
            pinnedCalls.push(url);
            const tag = decodeURIComponent(new URL(url).pathname.split('/').pop());
            assert.ok(['main', 'v0.9'].includes(tag), '固定渠道只查询自身与审核声明过的历史标签');
            return { ok: true, json: async () => rawRelease(tag === 'main' ? '1.0' : '0.9',
                [asset(tag === 'main' ? 'Example-v1.0.zip' : 'Example-v0.9.zip'), asset('Other-v9.0.zip')], tag) };
        };
        const history = await versions.fetchReleases(pinned);
        assert.equal(pinnedCalls.length, 2);
        assert.equal(history.releases.length, 2);
        assert.equal(history.releases[0].assets.length, 1, '固定附件渠道不能混入同标签其他产品');
        const old = versions.buildCandidates(pinned, history).find(item => item.version === '0.9');
        assert.equal(old.compatibility.evidence, 'declaration');
        assert.equal(old.dependencies[0].id, 'old-framework', '直连回退保留历史标签的适配声明与版本专属前置');

        for (const status of [400, 401, 403, 404, 409, 503]) {
            const loaded = loadVersions();
            let requests = 0;
            loaded.sb.fetch = async () => { requests++; return { ok: false, status, json: async () => ({
                code: status === 503 ? 'CATALOG_UNAVAILABLE' : 'RELEASE_UPSTREAM_FAILED', error: '模拟来源核验失败' }) }; };
            await assert.rejects(loaded.versions.fetchReleases(baseMod), /模拟来源核验失败/);
            assert.equal(requests, 1, '来源或审核错误禁止用 GitHub 绕过');
        }
        for (const status of [500, 502, 503, 504]) {
            const loaded = loadVersions();
            loaded.sb.modHubMarket.getCommunityRevision = () => 0;
            let requests = 0;
            loaded.sb.fetch = async url => { requests++; return String(url).startsWith('https://api.github.com/')
                ? { ok: true, json: async () => [current] }
                : { ok: false, status, json: async () => ({ code: status === 504 ? 'RELEASE_UPSTREAM_TIMEOUT' : 'RELEASE_UPSTREAM_FAILED', error: '模拟上游服务失败' }) }; };
            assert.equal((await loaded.versions.fetchReleases(baseMod)).fromGithub, true);
            assert.equal(requests, 2, '已明确的临时上游服务错误允许历史直连回退');
        }
        const community = loadVersions();
        community.sb.modHubMarket.hasCommunityReleaseSource = () => true;
        let communityCalls = 0;
        community.sb.fetch = async () => { communityCalls++; throw new Error('模拟 Worker 连接失败'); };
        await assert.rejects(community.versions.fetchReleases({ ...baseMod, catalogSource: 'community', autoInstall: true }), /模拟 Worker 连接失败/);
        assert.equal(communityCalls, 1, '社区模组仍须经过 Worker 当前审核，不能直连绕过撤回');

        // 社区模组已在目录核验过官方安装包时（如生育扩展），Worker 失败时回退到已核验目录发布快照
        const verifiedCommunityMod = {
            id: 'fertility-expansion',
            name: '生育扩展',
            bootNames: ['FertilityExpansion'],
            catalogSource: 'community',
            autoInstall: true,
            githubUrl: 'https://github.com/Liliths-Legacy/DOL-FertilityExpansion-MOD/releases/download/v1.5.12/FertilityExpansion.mod.zip',
            verifiedReleaseAsset: {
                sourceUrl: 'https://github.com/Liliths-Legacy/DOL-FertilityExpansion-MOD/releases/download/v1.5.12/FertilityExpansion.mod.zip',
                repositoryKey: 'liliths-legacy/dol-fertilityexpansion-mod',
                tag: 'v1.5.12',
                fileName: 'FertilityExpansion.mod.zip',
                sha256: '660ef7c7fe64b30602a08703358595023de18d97d28c8e629130e890d613fb9a',
                bootName: 'FertilityExpansion',
                version: '1.5.12',
                size: 126498,
                verifiedAt: '2026-10-04T17:58:11.884768+00:00'
            },
            releaseCompatibility: [{
                releaseTag: 'v1.5.12',
                assetName: 'FertilityExpansion.mod.zip',
                gameVersionRange: '=0.5.12.13',
                evidenceUrl: 'https://github.com/Liliths-Legacy/DOL-FertilityExpansion-MOD/releases/tag/v1.5.12'
            }]
        };
        const fallbackRes = await community.versions.fetchReleases(verifiedCommunityMod);
        assert.equal(fallbackRes.releases.length, 1, '已核验社区模组在Worker失败时须成功回退目录已核验快照');
        assert.equal(fallbackRes.releases[0].tagName, 'v1.5.12');
        assert.equal(fallbackRes.releases[0].assets[0].name, 'FertilityExpansion.mod.zip');
        const candidates = community.versions.buildCandidates(verifiedCommunityMod, fallbackRes);
        assert.equal(candidates.length, 1, '回退快照须成功构建候选版本供下载');
        assert.equal(candidates[0].version, '1.5.12');
    }

    {
        const { sb, versions } = loadVersions();
        sb.modHubMarket.getCommunityRevision = () => 1;
        const valid = () => ({ schemaVersion: 1, id: baseMod.id, sourceUrl: baseMod.githubUrl, page: 1,
            hasMore: false, fetchedAt: new Date().toISOString(), communityRevision: 1,
            releases: [release('1.0', [asset('Example-v1.0.zip')])] });
        let calls = 0;
        sb.fetch = async () => { calls++; return { ok: true, json: async () => ({ ...valid(), stale: true }) }; };
        assert.equal((await versions.fetchReleases(baseMod)).stale, true);
        assert.equal((await versions.fetchReleases(baseMod)).stale, true);
        assert.equal(calls, 2, 'Worker过期响应不能被本地六小时缓存伪装成新鲜结果');
        sb.fetch = async () => { calls++; return { ok: true, json: async () => ({ ...valid(), stale: false,
            fetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }) }; };
        assert.equal((await versions.fetchReleases(baseMod)).stale, true, '服务端旧快照不能重新开始本地六小时新鲜期');
        const malformed = [
            data => { data.communityRevision = 2; },
            data => { data.releases[0].assets[0].downloadUrl = 'https://example.test/Example-v1.0.zip'; },
            data => { data.releases[0].assets[0].downloadUrl = 'https://github.com/Owner/Other/releases/download/v1.0/Example-v1.0.zip'; },
            data => { data.releases[0].assets[0].downloadUrl = 'https://github.com/Owner/Example/releases/download/v2.0/Example-v1.0.zip'; },
            data => { data.releases[0].assets[0].downloadUrl = 'https://github.com/Owner/Example/releases/download/v1.0/Other.zip'; },
        ];
        for (const mutate of malformed) {
            const data = valid();
            mutate(data);
            sb.fetch = async () => ({ ok: true, json: async () => data });
            await assert.rejects(versions.fetchReleases(baseMod, { useCache: false }), error => error.code === 'RELEASE_SOURCE_CHANGED', '错误审核或资产来源必须拒绝且不缓存');
            sb.fetch = async () => { throw new Error('缓存不得保留'); };
            await assert.rejects(versions.fetchReleases(baseMod), /缓存不得保留/);
        }
        const encoded = valid();
        encoded.releases[0].tagName = 'model/stable';
        encoded.releases[0].assets[0].name = 'Example v1.0.zip';
        encoded.releases[0].assets[0].downloadUrl = 'https://github.com/Owner/Example/releases/download/model%2Fstable/Example%20v1.0.zip';
        sb.fetch = async () => ({ ok: true, json: async () => encoded });
        assert.equal((await versions.fetchReleases(baseMod)).releases[0].tagName, 'model/stable', '编码标签与带空格附件必须按解码一次后精确比较');
        const pinned = { ...baseMod, githubUrl: `${baseMod.githubUrl}/releases/tag/mod`,
            releaseCompatibility: [{ releaseTag: 'v1.0', assetName: 'Example-v1.0.zip', gameVersionRange: '^0.5.10' }] };
        const pinnedResponse = valid();
        pinnedResponse.sourceUrl = pinned.githubUrl;
        sb.fetch = async () => ({ ok: true, json: async () => pinnedResponse });
        assert.equal((await versions.fetchReleases(pinned)).releases[0].tagName, 'v1.0', '固定渠道只允许审核规则明确声明的历史标签');
        const foreign = { ...pinnedResponse, releases: [release('9.0', [asset('Example-v9.0.zip')])] };
        sb.fetch = async () => ({ ok: true, json: async () => foreign });
        await assert.rejects(versions.fetchReleases(pinned, { useCache: false }), error => error.code === 'RELEASE_SOURCE_CHANGED', '固定渠道不能跳到未经声明的同仓库标签');
    }

    {
        const { sb, versions } = loadVersions();
        const optimizationMod = { id: 'dol-optimization', name: '原版优化', githubUrl: 'https://github.com/Owner/Example',
            aliases: ['Dol-Optimization', 'DolOptimization', '原版优化OPT'], bootNames: ['原版优化OPT'] };
        const releases = [
            release('1.1.1.4', [asset('Dol-Optimization-v1.1.1.4.zip')]),
            release('1.0.9', [asset('Optimization-1.0.9-DolMod.zip')]),
            release('1.0.7a', [asset('Dol-Optimization-v1.0.7a.zip')]),
            release('1.0.0', [asset('Dol-Optimization-v1.0.0.zip')])
        ];
        const candidates = versions.buildCandidates(optimizationMod, releases);
        assert.equal(candidates.length, 4, '全部历史资产必须正常解析为候选包');
        assert.equal(new Set(candidates.map(c => c.seriesKey)).size, 1, '历史前后缀变化与字母小版本必须归一为单一系列');
        const selection = versions.getDefaultSelection(optimizationMod, candidates);
        assert.equal(selection.defaultKey, candidates[0].candidateKey, '缺少适配声明的单一模组必须自动默认选择最高可用版本');
        assert.equal(selection.defaultRisk, true, '无声明版本默认选择仍保留适配风险提示');
    }
};

