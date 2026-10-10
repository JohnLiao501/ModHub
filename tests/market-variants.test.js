// 显式语言变体只聚合展示，旧 ID、技术名、来源、版号和摘要仍属于原成员。
const { assert, fs, path, srcRoot, createBaseSandbox, loadScripts } = require('./helpers');

module.exports = async function () {
    const sb = createBaseSandbox();
    loadScripts(sb, ['javascript/modhub-market-variants.js']);
    const api = sb.modHubMarketVariants;
    const variant = (id, label, extra = {}) => ({ groupId: 'future-product', groupName: '未来产品', type: 'language', id, label, ...extra });
    const member = (id, language, label, extra = {}) => ({ id, identityId: id, name: `独立条目 ${id}`,
        bootNames: [`Boot${id}`], githubUrl: 'https://github.com/FutureAuthor/SharedRepository',
        variant: variant(language, label), ...extra });
    const chs = member('chs-id', 'zh-CN', '简体中文', { version: '1.1.0', digest: '摘要甲' });
    const en = member('en-id', 'en', 'English', { version: '2.0.0', digest: '摘要乙' });
    const unrelated = member('unrelated', 'fr', 'Français', { variant: undefined });
    const original = JSON.stringify([chs, en, unrelated]);
    const grouped = api.groupMods([chs, unrelated, en]);
    assert.equal(grouped.length, 2, '只聚合有显式声明的语言成员，同仓库无关模组保持独立');
    const group = grouped[0];
    assert.equal(group.isLanguageGroup, true);
    assert.equal(group.variantGroupId, 'future-product');
    assert.equal(group.name, '未来产品');
    assert.equal(group.variants[0], chs);
    assert.equal(group.variants[1], en);
    assert.equal(grouped[1], unrelated);
    assert.equal(api.getMembers(group), group.variants);
    assert.equal(api.getMembers(chs)[0], chs);
    assert.equal(api.getMembers(null).length, 0);
    assert.equal(api.getDisplayName(chs), '独立条目 chs-id（简体中文）');
    assert.equal(api.getDisplayName(en), '独立条目 en-id（English）');
    assert.equal(api.getDisplayName(unrelated), unrelated.name);
    assert.equal(JSON.stringify([chs, en, unrelated]), original, '分组不能修改成员或混合语言不同步的版号和摘要');
    assert.equal(Object.hasOwn(group, 'identityId'), false, '展示组没有可安装身份');
    assert.equal(Object.hasOwn(group, 'bootNames'), false, '展示组不能拼接技术名');

    const invalid = [null, [], 'language', {}, variant('', '简中'), variant('zh-CN', ''),
        variant('zh-CN', '简中', { type: 'model' }), variant('zh-CN', '简中', { groupId: '../product' }),
        variant('zh-CN', '简中', { groupName: '' }), variant('zh-CN', '简中', { groupName: '名称\n换行' }),
        variant('zh-CN', '简中', { label: 'a'.repeat(81) }), variant('invalid_language', '简中')];
    for (const value of invalid) assert.equal(api.normalizeVariant(value), null, '非法字段不能生成展示组声明');
    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeVariant(variant('zh-CN', '简中', { extra: '忽略', groupId: ' FUTURE-PRODUCT ' })))),
        variant('zh-CN', '简中'), '声明只透传规定字段并归一化组标识');

    const fallbacks = [
        [chs], [chs, { ...en, variant: undefined }],
        [chs, { ...en, variant: variant('ZH-cn', '另一简中') }],
        [chs, { ...en, variant: variant('en', 'English', { groupName: '其他产品' }) }],
        [chs, { ...en, variant: variant('en', 'English', { type: 'model' }) }],
        [chs, { ...en, identityId: chs.identityId }],
        [chs, { ...en, identityId: null }], [chs, { ...en, id: '', identityId: '' }],
        [chs, { ...en, bootNames: [] }], [chs, { ...en, bootNames: [' '] }],
        [chs, { ...en, bootNames: [...chs.bootNames] }],
        [chs, en, { ...unrelated, variant: variant('', '法文') }]
    ];
    for (const input of fallbacks) {
        const result = api.groupMods(input);
        assert.equal(result.length, input.length, '歧义或不完整组必须全部回退，不能留下部分聚合');
        input.forEach((mod, index) => assert.equal(result[index], mod));
    }
    const old = [{ id: 'old-chs', name: '旧简中', bootNames: ['旧简中'] }, { id: 'old-en', name: '旧英文', bootNames: ['旧英文'] }];
    assert.deepEqual(Array.from(api.groupMods(old)), old, '旧缓存没有变体字段时继续返回独立条目');
    assert.equal(api.groupMods(null).length, 0);

    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeRequiredDependencies([
        { modName: ' ModI18N ', version: '*' }, { modName: 'modi18n', version: '*' },
        { modName: 'ModI18N', version: '>=1.0 && <2.0' }, { modName: 'ReplacePatcher' },
        null, { modName: '' }, { modName: '错误\n名称' }, { modName: 'Bad', version: 1 }
    ]))), [{ modName: 'ModI18N', version: '*' }, { modName: 'ModI18N', version: '>=1.0 && <2.0' },
        { modName: 'ReplacePatcher', version: '*' }], '额外前置使用真实技术名，去重不能抹掉不同版本约束');

    const identities = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
    const lnn = identities.mods.filter(mod => ['lnn-enemy-stats-display-chs', 'lnn-enemy-stats-display-en'].includes(mod.id));
    assert.equal(identities.schemaVersion, 1, '旧客户端继续消费 schemaVersion 1 的独立语言记录');
    const [lnnGroup] = api.groupMods(lnn);
    assert.equal(lnnGroup.variantGroupId, 'lnn-enemy-stats-display');
    assert.equal(lnnGroup.variants.length, 2);
    assert.equal(lnnGroup.variants[0], lnn[0]);
    assert.notEqual(lnn[0].verifiedReleaseAssets[0].sha256, lnn[1].verifiedReleaseAssets[0].sha256);
    assert.deepEqual(lnn[0].requiredDependencies, [{ modName: 'ModI18N', version: '*' }]);
    assert.deepEqual(lnn[1].requiredDependencies || [], [], '英文不继承简中额外前置');
    console.log('语言变体展示契约测试通过');
};
