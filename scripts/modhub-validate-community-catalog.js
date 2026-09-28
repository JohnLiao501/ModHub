'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');

const root = path.resolve(__dirname, '..');
const MODHUB_SOURCE_HOSTS = {
    github: ['github.com', 'www.github.com'],
    tieba: ['tieba.baidu.com'],
    discord: ['discord.com', 'www.discord.com', 'discord.gg'],
};
const MODHUB_ALLOWED_FIELDS = new Set([
    'id', 'name', 'description', 'author', 'sourceUrl', 'sourcePlatform',
    'status', 'issueUrl', 'otherUrl', 'identityId', 'installable',
]);

function httpsUrl(value, label) {
    assert.equal(typeof value, 'string', `${label} 必须为字符串`);
    assert(value === value.trim() && value.length <= 2048, `${label} 不得含首尾空白或超过 2048 字符`);
    let url;
    try { url = new URL(value); } catch { throw new Error(`${label} 不是有效 URL`); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port,
        `${label} 必须是无账号信息和自定义端口的 HTTPS 链接`);
    assert(url.hostname.includes('.') && !isIP(url.hostname) && !url.hostname.endsWith('.local'),
        `${label} 必须指向公开域名`);
    return url;
}

function textField(value, label, maxLength, minLength = 1) {
    assert.equal(typeof value, 'string', `${label} 必须为字符串`);
    assert(value === value.trim() && value.length >= minLength && value.length <= maxLength,
        `${label} 长度须在 ${minLength} 至 ${maxLength} 字符之间，且不得含首尾空白`);
    assert(!/[\u0000-\u001f\u007f<>]/.test(value), `${label} 只能填写纯文本`);
}

function validateCatalog(catalog) {
    assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), '目录必须为对象');
    assert.equal(catalog.schemaVersion, 1, '目录 schemaVersion 必须为 1');
    assert(Array.isArray(catalog.mods), '目录 mods 必须为数组');
    assert(Object.keys(catalog).every(key => ['schemaVersion', 'mods'].includes(key)), '目录含未知顶层字段');
    const identities = JSON.parse(fs.readFileSync(path.join(root, 'mod-identities.json'), 'utf8')).mods;
    const ids = new Set();

    for (const mod of catalog.mods) {
        assert(mod && typeof mod === 'object' && !Array.isArray(mod), '目录条目必须为对象');
        assert(Object.keys(mod).every(key => MODHUB_ALLOWED_FIELDS.has(key)), `条目 ${mod.id || '(无标识)'} 含未知字段`);
        assert(typeof mod.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mod.id) && mod.id.length <= 80,
            '条目 id 必须是长度不超过 80 的小写短横线标识');
        assert(!ids.has(mod.id), `重复条目 id：${mod.id}`);
        ids.add(mod.id);
        assert(['active', 'withdrawn'].includes(mod.status), `条目 ${mod.id} 的 status 无效`);
        if (mod.status === 'active') {
            assert(mod.id.startsWith('community-'), `在架社区条目 ${mod.id} 的 id 必须以 community- 开头`);
        }

        const source = httpsUrl(mod.sourceUrl, `${mod.id}.sourceUrl`);
        assert(Object.values(MODHUB_SOURCE_HOSTS).flat().includes(source.hostname), `${mod.id}.sourceUrl 域名不在支持范围内`);
        assert(source.pathname !== '/' || source.search, `${mod.id}.sourceUrl 必须指向具体页面`);
        if (MODHUB_SOURCE_HOSTS.github.includes(source.hostname)) {
            assert(/^\/[^/]+\/[^/]+(?:\/|$)/.test(source.pathname), `${mod.id}.sourceUrl 必须指向具体 GitHub 仓库`);
        }
        if (mod.sourcePlatform !== undefined || mod.status === 'active') {
            assert(Object.hasOwn(MODHUB_SOURCE_HOSTS, mod.sourcePlatform), `${mod.id}.sourcePlatform 无效`);
            assert(MODHUB_SOURCE_HOSTS[mod.sourcePlatform].includes(source.hostname), `${mod.id}.sourcePlatform 与来源域名不一致`);
        }

        if (mod.status === 'active') {
            textField(mod.name, `${mod.id}.name`, 100);
            textField(mod.description, `${mod.id}.description`, 500, 10);
            textField(mod.author, `${mod.id}.author`, 100);
            assert(mod.issueUrl !== undefined, `${mod.id}.issueUrl 必须记录审核议题`);
        }
        for (const [field, maxLength] of [['name', 100], ['description', 500], ['author', 100]]) {
            if (mod.status === 'withdrawn' && mod[field] !== undefined) textField(mod[field], `${mod.id}.${field}`, maxLength);
        }
        if (mod.issueUrl !== undefined) {
            const issue = httpsUrl(mod.issueUrl, `${mod.id}.issueUrl`);
            assert(issue.hostname === 'github.com' && /^\/JohnLiao501\/ModHub\/issues\/[1-9]\d*\/?$/i.test(issue.pathname),
                `${mod.id}.issueUrl 必须是本仓库的议题链接`);
        }
        if (mod.otherUrl !== undefined) httpsUrl(mod.otherUrl, `${mod.id}.otherUrl`);
        if (mod.identityId !== undefined) {
            assert(typeof mod.identityId === 'string' && identities.some(item => item.id === mod.identityId),
                `${mod.id}.identityId 不在身份目录中`);
        }
        if (mod.installable !== undefined) assert.equal(typeof mod.installable, 'boolean', `${mod.id}.installable 必须为布尔值`);
        if (mod.installable) {
            assert(mod.status === 'active' && mod.sourcePlatform === 'github' && mod.identityId,
                `${mod.id} 只有已核验身份的 GitHub 条目可标记为可安装`);
            const match = /^\/([^/]+)\/([^/]+)\/releases\/(?:latest|tag\/[^/]+)\/?$/.exec(source.pathname);
            assert(match, `${mod.id}.sourceUrl 必须是 GitHub Release 入口`);
            const identity = identities.find(item => item.id === mod.identityId);
            const repositoryKey = `${match[1]}/${match[2]}`.toLowerCase();
            assert(identity.repositoryKeys?.some(key => key.toLowerCase() === repositoryKey),
                `${mod.id}.sourceUrl 仓库与身份目录不一致`);
        }
    }
    return catalog.mods.length;
}

if (require.main === module) {
    try {
        const file = process.argv[2] || path.join(root, 'modhub-community-catalog.json');
        const count = validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
        console.log(`[ModHub] 社区目录校验通过：${count} 个条目`);
    } catch (error) {
        console.error(`[ModHub] 社区目录校验失败：${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { validateCatalog };
