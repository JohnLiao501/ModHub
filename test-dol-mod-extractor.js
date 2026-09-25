const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const source = await readFile(path.join(__dirname, 'dol-mod-extractor.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { mergeModIdentities } = await import(moduleUrl);
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
    name: '别重购垃圾',
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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
