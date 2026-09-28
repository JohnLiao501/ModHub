'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCatalog } = require('../scripts/modhub-validate-community-catalog');

const root = path.resolve(__dirname, '..');
const base = {
    id: 'community-modhub-test', name: '测试模组', description: '这是用于验证目录边界的测试模组。', author: '测试作者',
    sourceUrl: 'https://github.com/JohnLiao501/ModHub', sourcePlatform: 'github', status: 'active',
    issueUrl: 'https://github.com/JohnLiao501/ModHub/issues/1',
};
const check = (...mods) => validateCatalog({ schemaVersion: 1, mods });

module.exports = async function() {
    assert.equal(check(), 0);
    assert.equal(check(base), 1);
    assert.equal(check(base, { ...base, id: 'community-another-mod' }), 2, '共享仓库允许不同模组共用来源链接');
    assert.equal(check({ ...base, sourcePlatform: 'tieba', sourceUrl: 'https://tieba.baidu.com/p/123456' }), 1);
    assert.equal(check({ ...base, sourcePlatform: 'discord', sourceUrl: 'https://discord.gg/example' }), 1);
    assert.throws(() => check(base, base), /重复条目 id/);
    assert.throws(() => check({ ...base, id: 'modhub' }), /community-/);
    assert.throws(() => check({ ...base, sourceUrl: 'https://github.com.evil.example/JohnLiao501/ModHub' }), /域名不在支持范围/);
    assert.throws(() => check({ ...base, sourceUrl: 'http://github.com/JohnLiao501/ModHub' }), /HTTPS/);
    assert.throws(() => check({ ...base, sourceUrl: 'https://github.com/JohnLiao501' }), /具体 GitHub 仓库/);
    assert.throws(() => check({ ...base, sourcePlatform: 'discord' }), /与来源域名不一致/);
    assert.throws(() => check({ ...base, issueUrl: 'https://github.com/other/repo/issues/1' }), /本仓库/);
    assert.throws(() => check({ ...base, installable: true }), /已核验身份/);
    assert.throws(() => check({ ...base, sourceUrl: 'https://github.com/JohnLiao501/ModHub', identityId: 'modhub', installable: true }), /Release 入口/);
    assert.throws(() => check({ ...base, sourceUrl: 'https://github.com/other/repo/releases/latest', identityId: 'modhub', installable: true }), /仓库与身份目录不一致/);
    assert.equal(check({ ...base, sourceUrl: 'https://github.com/JohnLiao501/ModHub/releases/latest', identityId: 'modhub', installable: true }), 1);
    assert.equal(check({ id: 'modhub', status: 'withdrawn', sourceUrl: base.sourceUrl }), 1, '下架墓碑可引用现有 Wiki 标识');
    const approvedCatalog = JSON.parse(fs.readFileSync(path.join(root, 'modhub-community-catalog.json'), 'utf8'));
    assert.equal(validateCatalog(approvedCatalog), approvedCatalog.mods.length, '正式目录中的每个条目都必须通过校验');
    console.log('[ModHub] 社区目录边界测试通过');
};

if (require.main === module) module.exports().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
