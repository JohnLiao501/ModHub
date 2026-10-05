/** ModHub 社区获取说明与咒语配方。正文只作为文本展示和复制。 */
(function() {
    'use strict';

    const MODHUB_SPELL_CACHE_KEY = 'modhub_market_spells_v1';
    const MODHUB_SOURCE_NAMES = { github: 'GitHub', tieba: '百度贴吧', discord: 'Discord' };
    let revision = -1;
    let spells = [];

    function safeUrl(value) {
        try {
            const url = new URL(String(value || ''));
            return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
        } catch (_) { return ''; }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }

    function normalizeSources(entry) {
        const sources = (Array.isArray(entry?.sources) ? entry.sources : []).filter(source => source && safeUrl(source.url))
            .map(source => ({ ...source, platform: String(source.platform || ''), url: safeUrl(source.url),
                downloadUrl: safeUrl(source.downloadUrl), label: String(source.label || ''),
                extractionCode: String(source.extractionCode || ''), archivePassword: String(source.archivePassword || ''),
                instructions: String(source.instructions || '') }));
        for (const value of [entry?.sourceUrl, entry?.githubUrl, entry?.otherUrl]) {
            const url = safeUrl(value);
            if (url && !sources.some(source => source.url === url)) {
                sources.push({ platform: value === entry?.githubUrl ? 'github' : '', url });
            }
        }
        return [...new Map(sources.map(source => [`${source.platform}:${source.url}`, source])).values()];
    }

    function normalizePackages(entry) {
        return (Array.isArray(entry?.packageRecords) ? entry.packageRecords : []).filter(record => record && typeof record === 'object')
            .map(record => ({ ...record, sourceUrl: safeUrl(record.sourceUrl), downloadUrl: safeUrl(record.downloadUrl),
                version: String(record.version || ''), bootName: String(record.bootName || ''),
                gameVersionRange: String(record.gameVersionRange || ''), instructions: String(record.instructions || ''),
                extractionCode: String(record.extractionCode || ''), archivePassword: String(record.archivePassword || '') }));
    }

    function isVerifiedPackage(record) {
        return record?.verificationStatus === 'package-checked' && record.wholePackageStructureChecked === true
            && /^[a-f0-9]{64}$/i.test(record.sha256 || '')
            && Boolean(record.id && record.fileName && record.format && record.version && safeUrl(record.sourceUrl)
                && safeUrl(record.evidenceUrl) && Number.isFinite(Date.parse(record.verifiedAt)));
    }

    function normalizeSpells(index) {
        const withdrawn = new Set((Array.isArray(index.withdrawnSpellIds) ? index.withdrawnSpellIds : []).map(id => String(id).toLowerCase()));
        return (Array.isArray(index.spells) ? index.spells : []).filter(entry => entry && entry.status !== 'withdrawn'
            && typeof entry.id === 'string' && entry.id.startsWith('spell-') && !withdrawn.has(entry.id.toLowerCase())
            && typeof entry.spell?.body === 'string' && entry.spell.body.trim())
            .map(entry => ({ ...entry, contentType: 'spell', autoInstall: false, sources: normalizeSources(entry),
                spell: { ...entry.spell, body: entry.spell.body } }));
    }

    function applyIndex(index, minimumRevision = 0) {
        const nextRevision = index.communityRevision === undefined ? 0 : index.communityRevision;
        if (!Number.isSafeInteger(nextRevision) || nextRevision < minimumRevision || nextRevision < revision) return false;
        spells = normalizeSpells(index);
        revision = nextRevision;
        try { localStorage.setItem(MODHUB_SPELL_CACHE_KEY, JSON.stringify({ revision, spells })); } catch (_) {}
        return true;
    }

    function restoreCache(expectedRevision) {
        try {
            const cached = JSON.parse(localStorage.getItem(MODHUB_SPELL_CACHE_KEY) || '{}');
            if (Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && cached.revision === expectedRevision) {
                spells = normalizeSpells({ spells: cached.spells });
                revision = expectedRevision;
                return true;
            }
        } catch (_) {}
        spells = [];
        return false;
    }

    function filter(search = '', sort = 'date') {
        const keyword = String(search).toLowerCase();
        const values = spells.filter(entry => !keyword || [entry.name, entry.author, entry.description, entry.spell.body,
            entry.spell.syntax, entry.spell.inputLocation, entry.spell.prerequisites, entry.spell.gameVersionRange]
            .some(value => String(value || '').toLowerCase().includes(keyword)));
        return values.sort((left, right) => sort === 'name' ? String(left.name).localeCompare(String(right.name), 'zh-CN')
            : String(right.updateDate || right.spell.verifiedAt || '').localeCompare(String(left.updateDate || left.spell.verifiedAt || '')));
    }

    function acquisitionHtml(entry) {
        const sources = normalizeSources(entry);
        const packages = normalizePackages(entry);
        const link = (url, label) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : '';
        const facts = fields => {
            const values = fields.filter(([, value]) => value !== undefined && value !== null && String(value).trim());
            return values.length ? `<dl class="modhub-detail-facts">${values.map(([label, value]) =>
                `<div><dt>${escapeHtml(label)}：</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : '';
        };
        const note = (label, value) => value ? `<div class="modhub-detail-note"><span class="modhub-detail-label">${escapeHtml(label)}：</span>`
            + `<p class="modhub-acquisition-text modhub-detail-readme" tabindex="0">${escapeHtml(value)}</p></div>` : '';
        const sourceLines = sources.map(source => {
            const label = source.label || MODHUB_SOURCE_NAMES[source.platform] || '原始来源';
            return '<div class="modhub-acquisition-source">'
                + `<div class="modhub-detail-links">${link(source.url, label)}${source.downloadUrl && source.downloadUrl !== source.url ? link(source.downloadUrl, '下载入口') : ''}</div>`
                + facts([['提取码', source.extractionCode], ['解压密码', source.archivePassword]])
                + (source.platform === 'discord' ? '<div class="modhub-detail-hint">需登录 Discord，并按原帖要求加入服务器或取得访问权限。</div>' : '')
                + note('获取说明', source.instructions) + '</div>';
        }).join('');
        const packageLines = packages.map(record => {
            const dependencies = Array.isArray(record.dependencies) ? record.dependencies.map(dependency => typeof dependency === 'string' ? dependency
                : `${dependency.modName || dependency.bootName || dependency.id || dependency.name || '未命名前置'}${dependency.version ? ` ${dependency.version}` : ''}`).join('；') : '';
            const prerequisites = Array.isArray(record.prerequisites) ? record.prerequisites.join('\n')
                : typeof record.prerequisites === 'object' && record.prerequisites ? JSON.stringify(record.prerequisites) : record.prerequisites;
            const packageLinks = new Map();
            for (const [value, label] of [[record.sourceUrl, '版本来源'], [record.downloadUrl, '下载此版本'], [record.evidenceUrl, '核验来源']]) {
                const url = safeUrl(value);
                if (!url) continue;
                if (!packageLinks.has(url)) packageLinks.set(url, []);
                packageLinks.get(url).push(label);
            }
            return '<article class="modhub-acquisition-package">'
                + `<div class="modhub-detail-package-heading"><strong>${escapeHtml(record.fileName || record.bootName || '安装包')}</strong>`
                + (record.version ? `<span class="modhub-detail-version">版本 ${escapeHtml(record.version)}</span>` : '') + '</div>'
                + `<div class="modhub-detail-status">${isVerifiedPackage(record) ? '安装包结构已核验' : '安装包资料待核对'} · ${record.gameTested === true ? '已游戏验证' : '未游戏实测'}</div>`
                + facts([['文件格式', record.format], ['模组标识', record.bootName], ['适配 DoL', record.gameVersionRange || '未知，请核对作者说明'],
                    ['美化框架', record.framework], ['前置要求', dependencies], ['提取码', record.extractionCode], ['解压密码', record.archivePassword]])
                + `<div class="modhub-detail-links">${[...packageLinks].map(([url, labels]) => link(url, labels.join(' · '))).join('')}</div>`
                + note('前提条件', prerequisites) + note('安装说明', record.instructions) + note('核验范围', record.verificationScope) + '</article>';
        }).join('');
        const section = (title, count, body) => count ? `<section class="modhub-detail-section"><div class="modhub-detail-heading">${title}<span>${count} 项</span></div>${body}</section>` : '';
        return `<div class="modhub-acquisition" tabindex="0" aria-label="来源与安装包资料">`
            + section('来源入口', sources.length, sourceLines) + section('包体资料', packages.length, packageLines)
            + (entry.contentType !== 'spell' ? '<footer class="modhub-detail-footer"><p>从原平台下载后，请按作者说明解压；在此导入支持 ModLoader 的安装包。普通美化文件请按对应框架的说明安装。</p></footer>' : '') + '</div>';
    }

    /** 每个平台只展示一个入口，全部原始来源与安装资格仍保留在资料中。 */
    function getSourceLinks(entry) {
        const links = new Map();
        for (const source of normalizeSources(entry)) {
            const url = new URL(source.url);
            const host = url.hostname;
            const isGithub = ['github.com', 'www.github.com'].includes(host);
            const asset = isGithub && url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/[^/]+\/?$/i);
            if (asset) {
                url.pathname = `/${asset[1]}/${asset[2]}/releases/tag/${asset[3]}`;
                url.search = '';
                url.hash = '';
            }
            const displayUrl = url.href;
            const name = isGithub ? 'GitHub'
                : host === 'tieba.baidu.com' ? '百度贴吧'
                : ['discord.com', 'discord.gg', 'canary.discord.com', 'ptb.discord.com', 'discordapp.com'].includes(host) ? 'Discord' : host;
            const priority = isGithub ? (/^\/[^/]+\/[^/]+\/?$/.test(url.pathname) ? 2 : asset ? 0 : 1) : 0;
            if (!links.has(name) || priority > links.get(name).priority) {
                links.set(name, { priority, link: { url: displayUrl, name, title: source.label || source.url } });
            }
        }
        return [...links.values()].map(source => source.link);
    }

    function renderAcquisitionDetails(entry, index) {
        const sources = normalizeSources(entry), links = getSourceLinks(entry);
        const linkHtml = links.map(source => `<a class="modhub-market-source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(source.title)}">${escapeHtml(source.name)}</a>`).join('<span aria-hidden="true">·</span>');
        const hasInstructions = new Set(sources.map(source => source.url)).size > links.length
            || normalizePackages(entry).length || sources.some(source => source.instructions || source.extractionCode
            || source.archivePassword || source.downloadUrl && source.downloadUrl !== source.url);
        const instructionsHtml = hasInstructions ? `<span aria-hidden="true">·</span><a class="modhub-market-acquisition-link" href="#" data-mod-index="${Number.isSafeInteger(index) && index >= 0 ? index : ''}">安装说明</a>` : '';
        return `<div class="modhub-market-source-bar"><span class="modhub-market-source-summary">来源：</span>`
            + (linkHtml || '<span class="modhub-market-source-empty">暂无来源链接</span>') + instructionsHtml + '</div>';
    }

    async function openAcquisition(entry) {
        if (typeof window.modHubConfirm !== 'function') return false;
        const importRequested = await window.modHubConfirm({ title: `来源与说明【${entry.name}】`,
            trustedMessageHtml: acquisitionHtml(entry),
            confirmText: '下载后导入', cancelText: '关闭', dialogClass: 'modhub-acquisition-dialog' });
        if (importRequested && typeof window.modHubTriggerImport === 'function') window.modHubTriggerImport();
        return Boolean(importRequested);
    }

    async function copyBody(entry) {
        const body = entry?.spell?.body;
        if (typeof body !== 'string') return false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
            await navigator.clipboard.writeText(body);
            window.modHubShowToast?.('已复制咒语正文。请按说明在对应位置使用。', 'success');
            return true;
        } catch (error) {
            await window.modHubAlert?.(`未能复制咒语正文。请在详情中选择正文后手动复制。\n\n错误详情：${error.message || String(error)}`, '复制未完成');
            return false;
        }
    }

    async function showDetails(entry) {
        if (typeof window.modHubConfirm !== 'function') return false;
        const confirmed = await window.modHubConfirm({ title: entry.name || '咒语配方', confirmText: '复制正文', cancelText: '关闭',
            trustedMessageHtml: '<div class="modhub-spell-detail"></div>', dialogClass: 'modhub-spell-dialog',
            onRender(dialog) {
                const host = dialog.querySelector('.modhub-spell-detail');
                const fields = [['说明', entry.description], ['语法类型', entry.spell.syntax], ['输入位置', entry.spell.inputLocation],
                    ['使用步骤', entry.spell.instructions], ['参数', entry.spell.parameters], ['前提条件', entry.spell.prerequisites],
                    ['适配 DoL', entry.spell.gameVersionRange || '未知，请核对原帖'], ['核验说明', '语法与使用资料已核验，未游戏实测']];
                fields.forEach(([label, value]) => {
                    if (!value) return;
                    const paragraph = document.createElement('p');
                    paragraph.textContent = `${label}：${Array.isArray(value) ? value.join('\n') : typeof value === 'object' ? JSON.stringify(value) : value}`;
                    host.appendChild(paragraph);
                });
                const body = document.createElement('pre');
                body.className = 'modhub-spell-body';
                body.tabIndex = 0;
                body.textContent = entry.spell.body;
                host.appendChild(body);
                const sources = document.createElement('div');
                sources.innerHTML = acquisitionHtml(entry);
                host.appendChild(sources);
            } });
        return confirmed ? copyBody(entry) : false;
    }

    function render(container, { search = '', sort = 'date' } = {}) {
        const entries = filter(search, sort);
        container.innerHTML = entries.length ? entries.map((entry, index) => `<div class="childItem modhub-market-card modhub-spell-card">`
            + `<div class="modhub-market-card-header"><span class="modhub-market-title gold">${escapeHtml(entry.name)}</span>`
            + '<span class="modhub-market-badge badge-external">咒语配方</span></div>'
            + `<div class="modhub-market-meta grey">作者：${escapeHtml(entry.author || '未知作者')} · 未游戏实测</div>`
            + `<div class="modhub-market-desc">${escapeHtml(entry.description || '暂无说明')}</div>`
            + `<div class="modhub-market-meta grey">输入位置：${escapeHtml(entry.spell.inputLocation || '请查看详情')}<br>适配 DoL：${escapeHtml(entry.spell.gameVersionRange || '未知，请核对原帖')}</div>`
            + `<div class="modhub-market-actions"><button type="button" class="macro-button modhub-btn-primary modhub-spell-detail-button" data-spell-index="${index}">查看使用说明</button>`
            + `<button type="button" class="macro-button modhub-btn-sub modhub-spell-copy-button" data-spell-index="${index}">复制正文</button></div></div>`).join('')
            : `<div class="modhub-empty-state grey">${search ? '没有匹配的咒语配方。可清除搜索或刷新市场。' : '当前暂无咒语配方。可刷新市场获取最新目录。'}</div>`;
        container.querySelectorAll('.modhub-spell-detail-button').forEach(button => { button.onclick = () => showDetails(entries[Number(button.dataset.spellIndex)]); });
        container.querySelectorAll('.modhub-spell-copy-button').forEach(button => { button.onclick = () => copyBody(entries[Number(button.dataset.spellIndex)]); });
    }

    window.modHubMarketSpells = { applyIndex, restoreCache, normalizeSpells, normalizeSources, normalizePackages, isVerifiedPackage,
        acquisitionHtml, getSourceLinks, renderAcquisitionDetails, openAcquisition, copyBody, showDetails, render, filter, getSpells: () => spells.slice(),
        getRevision: () => revision, CACHE_KEY: MODHUB_SPELL_CACHE_KEY };
})();
