const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const source = await readFile(path.join(__dirname, 'dol-mod-extractor.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { mergeModIdentities, fetchModRelease, parseGithubReleaseTarget, markSharedRepositories } = await import(moduleUrl);
  const catalog = JSON.parse(await readFile(path.join(__dirname, 'mod-identities.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(new Set(catalog.mods.map((mod) => mod.id)).size, catalog.mods.length, '身份 ID 不得重复');
  const categories = new Set(['框架与前置', '剧情与角色', '玩法与内容', '界面与便利', '外观与资源', '规则与数值', '修复与兼容', '待分类']);
  assert.ok(catalog.mods.every((mod) => categories.has(mod.category)), '每个身份都必须使用受控主分类');
  assert.ok(catalog.mods.every((mod) => Array.isArray(mod.tags) && mod.tags.length <= 3), '每个身份最多保留三个内容标签');
  const identityIds = new Set(catalog.mods.map((mod) => mod.id));
  assert.ok(catalog.mods.every((mod) => (mod.dependencies || []).every((dependency) => identityIds.has(dependency.id))), '每个依赖都必须指向现有身份 ID');
  assert.ok(catalog.mods.every((mod) => !mod.repositories.length
    || (Array.isArray(mod.repositoryKeys) && mod.repositoryKeys.every((key) => /^[^/]+\/[^/]+$/.test(key)))),
  '带仓库别名的身份必须声明所有者/仓库完整键');
  const auditedRepositoryKeys = new Map([
    ['defrock-sydney', 'hxdnshx/sugarcube-2-modloader'],
    ['free-attitudes', 'emicoto/dolmods'],
    ['overfits-slots', 'mirrormirroronwall/dol-miyako-mods'],
    ['background-foreground-template', 'miyakoaki4828/dol-miyako-mods'],
    ['eliminate-spaces', 'omvjro/ovodolmods'],
    ['blood-boon', '3naka/darksouls'],
    ['trauma-appearance', 'a1066160186/bananamods'],
  ]);
  for (const [id, repositoryKey] of auditedRepositoryKeys) {
    const identity = catalog.mods.find((mod) => mod.id === id);
    assert.ok(identity?.repositoryKeys?.some((key) => key.toLowerCase() === repositoryKey), `${id} 必须声明精确仓库键`);
  }

  const mods = mergeModIdentities([
  {
    name: '织境空间',
    githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
    githubUrls: ['https://github.com/Kanna-hanabi/WovenRealm'],
  },
  {
    name: '任务辅助工具',
    githubUrl: 'https://github.com/JohnLiao501/DoL-Quest-Assistant',
    githubUrls: ['https://github.com/JohnLiao501/DoL-Quest-Assistant'],
  },
  {
    name: '织境空间-场景互动扩展',
    githubUrl: 'https://github.com/Kanna-hanabi/WovenRealmUI',
    githubUrls: ['https://github.com/Kanna-hanabi/WovenRealmUI'],
  },
  {
    name: 'NPC侧边栏头像',
    githubUrl: 'https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL',
    githubUrls: ['https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL'],
  },
  {
    name: '织境空间-料理扩展',
    githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
    githubUrls: ['https://github.com/Kanna-hanabi/WovenRealm'],
  },
  {
    name: '织境空间',
    githubUrl: 'https://github.com/attacker/WovenRealm',
    githubUrls: [],
  },
  {
    name: '未收录的独立模组',
    githubUrl: 'https://github.com/hxdnshx/sugarcube-2-ModLoader',
    githubUrls: ['https://github.com/hxdnshx/sugarcube-2-ModLoader'],
  },
  ], catalog);

  assert.equal(mods[0].identityId, 'woven-realm');
  assert.deepEqual(mods[0].bootNames, ['AIStoryGen']);
  assert.equal(mods[0].category, '剧情与角色');
  assert.deepEqual(mods[0].tags, ['AI', '剧情', '生成']);
  assert.equal(mods[1].identityId, 'dol-quest-assistant');
  assert.equal(mods[2].identityId, null);
  assert.equal(mods[2].category, null);
  assert.deepEqual(mods[2].tags, []);
  assert.deepEqual(mods[2].dependencies, []);
  assert.equal(mods[3].identityId, null);
  assert.equal(mods[4].identityId, 'woven-realm-cooking', '共享仓库必须继续按权威名称区分子模组');
  assert.equal(mods[5].identityId, null, '同仓库尾名但不同所有者不得冒充权威身份');
  assert.equal(mods[6].identityId, null, '单条身份记录也必须同时匹配权威名称，不能覆盖同仓库其他模组');

  const audited = mergeModIdentities([
    ['还俗&amp;两面悉尼', '剧情与角色'],
    ['模拟人生', '玩法与内容'],
    ['自由态度', '规则与数值'],
    ['外套头套槽', '玩法与内容'],
    ['背景前景', '外观与资源'],
    ['消灭空格', '修复与兼容'],
    ['猫咖出租屋', '玩法与内容'],
    ['邪恶蟑螂（桌宠）', '外观与资源'],
    ['电视', '玩法与内容'],
    ['自由对话态度', '规则与数值'],
    ['血月诅咒', '规则与数值'],
    ['高创伤不减容貌', '规则与数值'],
    ['农贸工厂卖花', '玩法与内容'],
    ['潜伏者捕捉狂', '规则与数值'],
    ['彩虹桥', '玩法与内容'],
  ].map(([name]) => ({ name, githubUrls: [] })), catalog);
  assert.deepEqual(
    audited.map((mod) => mod.category),
    ['剧情与角色', '玩法与内容', '规则与数值', '玩法与内容', '外观与资源',
      '修复与兼容', '玩法与内容', '外观与资源', '玩法与内容', '规则与数值',
      '规则与数值', '规则与数值', '玩法与内容', '规则与数值', '玩法与内容'],
    '已复核模组必须由身份表稳定分类',
  );
  assert.deepEqual(audited[7].dependencies, [{ id: 'simple-framework', version: '' }]);

  const maplebirchDependents = mergeModIdentities([
    ['公交车防骚扰', 'https://github.com/Ayndpa/NoBusHarassmentMod'],
    ['更长遭遇战/言灵作弊集', 'https://github.com/MaplebirchLeaf/LongerCombat'],
    ['泰拉瑞亚拓展', 'https://github.com/Nephthelana/DOL-Terra-Expanding-Modd'],
  ].map(([name, githubUrl]) => ({ name, githubUrl, githubUrls: [githubUrl] })), catalog);
  assert.deepEqual(
    maplebirchDependents.map((mod) => mod.dependencies),
    maplebirchDependents.map(() => [{ id: 'maplebirch', version: '' }]),
    'Wiki 明确标注的秋枫白桦依赖必须进入身份数据',
  );
  const inferred = mergeModIdentities([{
    name: '伊甸互动头像',
    description: '伊甸相关剧情添加立绘或 CG（依赖简易框架）',
    githubUrls: [],
  }], catalog);
  assert.deepEqual(inferred[0].dependencies, [{ id: 'simple-framework', version: '' }]);
  console.log('模组身份表测试通过');

  for (const url of [
    'https://example.test/github.com/Owner/Repo', 'https://github.com.example.test/Owner/Repo',
    'https://github.com/Owner/Repo/tree/main', 'https://github.com/Owner/Repo/blob/main/mod.zip',
    'https://github.com/Owner/Repo/issues/1', 'https://github.com/Owner/Repo/wiki',
  ]) assert.equal(parseGithubReleaseTarget(url), null, `不得将非发布入口改为最新发布: ${url}`);
  assert.deepEqual(parseGithubReleaseTarget('https://github.com/Owner/Repo/releases/download/v1/a%20b.zip'), {
    owner: 'Owner', repo: 'Repo', tag: 'v1', assetName: 'a b.zip',
  });
  const oldSharedIndex = markSharedRepositories([
    { name: '甲', githubUrl: 'https://github.com/Owner/Repo', version: '99.0', versionSource: 'github', wikiVersion: '1.0' },
    { name: '乙', githubUrl: 'https://github.com/Owner/Repo', version: '99.0', versionSource: 'github', wikiVersion: '2.0' },
  ]);
  assert.deepEqual(oldSharedIndex.map(mod => mod.version), ['1.0', '2.0'], '旧索引的共享最新版本不能继续显示为各产品版本');
  assert.ok(oldSharedIndex.every(mod => mod.sharedRepository));
  const originalFetch = global.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(global, 'localStorage');
  const cache = new Map();
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: (key) => cache.delete(key),
    },
  });
  const requests = [];
  const repoUrl = 'https://github.com/AOKIUTAGE/UTAGEsDOL3.0';
  const apiUrl = 'https://api.github.com/repos/AOKIUTAGE/UTAGEsDOL3.0/releases';
  const responses = new Map([
    [`${apiUrl}/tags/mod`, { tag_name: 'mod', assets: [{ name: 'AU.zip', browser_download_url: 'https://example.test/AU.zip' }] }],
    [`${apiUrl}/tags/face%2Fv1`, { tag_name: 'face/v1', assets: [] }],
    [`${apiUrl}/latest`, { tag_name: 'latest-version', assets: [] }],
  ]);
  global.fetch = async (url) => {
    requests.push(url);
    const data = responses.get(url);
    return { ok: !!data, status: data ? 200 : 404, json: async () => data };
  };
  try {
    const mainMod = { githubUrl: `${repoUrl}/releases/tag/mod` };
    const faceMod = { githubUrl: `${repoUrl}/releases/tag/face%2Fv1?source=wiki#assets` };
    const latestMod = { githubUrl: repoUrl };
    const mainRelease = await fetchModRelease(mainMod);
    assert.equal(mainRelease.tagName, 'mod', '主包必须读取 Wiki 指定的标签');
    assert.equal(mainRelease.assetName, 'AU.zip');
    assert.equal(mainRelease.assetUrl, 'https://example.test/AU.zip');
    assert.equal(mainRelease.htmlUrl, mainMod.githubUrl);
    assert.equal((await fetchModRelease(faceMod)).tagName, 'face/v1', '标签应解码后作为单个 API 路径参数编码');
    assert.equal((await fetchModRelease(latestMod)).tagName, 'latest-version');
    for (const [mod, tag] of [[mainMod, 'mod'], [faceMod, 'face/v1'], [latestMod, 'latest-version']]) {
      const cached = await fetchModRelease(mod);
      assert.equal(cached.tagName, tag, '同仓库各标签与最新版本必须使用独立缓存');
      assert.equal(cached.fromCache, true);
    }
    assert.deepEqual(requests, [`${apiUrl}/tags/mod`, `${apiUrl}/tags/face%2Fv1`, `${apiUrl}/latest`]);
    assert.equal(cache.size, 3);

    requests.length = 0;
    await assert.rejects(fetchModRelease({ githubUrl: `${repoUrl}/releases/tag/missing` }), /GitHub API 错误: 404/);
    assert.deepEqual(requests, [`${apiUrl}/tags/missing`], '指定标签不存在时不得回退最新版本或列表');

    requests.length = 0;
    responses.delete(`${apiUrl}/latest`);
    responses.set(`${apiUrl}?per_page=1`, [{ tag_name: 'preview', prerelease: true }]);
    const fallback = await fetchModRelease(latestMod, { useCache: false });
    assert.equal(fallback.tagName, 'preview');
    assert.equal(fallback.prerelease, true);
    assert.deepEqual(requests, [`${apiUrl}/latest`, `${apiUrl}?per_page=1`], '未指定标签时保留最新版本不存在的列表回退');
    requests.length = 0;
    await assert.rejects(fetchModRelease({ githubUrl: `${repoUrl}/tree/main` }), /原始主页/);
    assert.equal(requests.length, 0, '分支目录不得请求无关的仓库最新发布');
    responses.set(`${apiUrl}/tags/files`, { tag_name: 'files', assets: [
      { name: 'first.zip', browser_download_url: 'https://example.test/first.zip' },
      { name: 'selected.zip', browser_download_url: 'https://example.test/selected.zip' },
    ] });
    const selected = await fetchModRelease({ githubUrl: `${repoUrl}/releases/download/files/selected.zip` });
    assert.deepEqual(selected.assets.map(a => a.name), ['selected.zip'], '直接附件链接不得切换同发布中的其他产品');
    await assert.rejects(fetchModRelease({ githubUrl: `${repoUrl}/releases/download/files/missing.zip` }), /附件不存在/);
    responses.set(`${apiUrl}/tags/wrong`, { tag_name: 'other', assets: [] });
    await assert.rejects(fetchModRelease({ githubUrl: `${repoUrl}/releases/tag/wrong` }), /标签与模组来源不一致/);
    responses.set(`${apiUrl}?per_page=100`, [
      { tag_name: 'other-newest', published_at: '2026-09-27', assets: [{ name: 'Other.v99.0.zip' }] },
      { tag_name: 'shared-products', published_at: '2026-09-20', assets: [
        { name: 'First.v1.2.zip', browser_download_url: 'https://example.test/first.zip' },
        { name: 'Second.v2.3.zip', browser_download_url: 'https://example.test/second.zip' },
      ] },
    ]);
    const first = await fetchModRelease({ githubUrl: repoUrl, name: '产品甲', sharedRepository: true, bootNames: ['First'] });
    const second = await fetchModRelease({ githubUrl: repoUrl, name: '产品乙', sharedRepository: true, bootNames: ['Second'] });
    assert.equal(first.assetName, 'First.v1.2.zip');
    assert.equal(first.version, '1.2');
    assert.equal(second.assetName, 'Second.v2.3.zip', '同仓库不同产品不得复用对方缓存');
    assert.equal(second.version, '2.3');
    assert.equal(first.assets.length, 1, '网站不得给当前产品展示同仓库的其他模组作为下载');
    await assert.rejects(fetchModRelease({ githubUrl: repoUrl, name: '未知产品', sharedRepository: true }), /未找到当前模组/);
    console.log('GitHub Release 标签与缓存测试通过');
  } finally {
    global.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(global, 'localStorage', storageDescriptor);
    else delete global.localStorage;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
