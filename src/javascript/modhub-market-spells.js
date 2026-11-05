/** ModHub 社区获取说明、言灵与确认后应用。 */
(function() {
    'use strict';

    const modHubHtml = html => window.modHubTranslateHtml ? window.modHubTranslateHtml(html) : html;
    const t = (key, params) => window.modHubT ? window.modHubT(key, params) : String(key ?? '').replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    const labelHtml = (key, params) => `<span data-modhub-i18n-key="${escapeHtml(key)}"${params ? ` data-modhub-i18n-key-params="${escapeHtml(JSON.stringify(params))}"` : ''}>${escapeHtml(t(key, params))}</span>`;


    const MODHUB_SPELL_CACHE_KEY = 'modhub_market_spells_v1';
    const MODHUB_SPELL_CATEGORIES = ['状态与治疗', '属性与技能', '物品与金钱', '角色与关系', '时间调整', '地点传送', '任务与事件', '外观与身体', '经历与声望'];
    const MODHUB_SOURCE_NAMES = { github: 'GitHub', tieba: '百度贴吧', discord: 'Discord' };
    let revision = -1;
    let spells = [];
    let applying = false;
    let applyingId = '';
    let applyPhase = '';
    let refreshBackupControls = null;

    const spellText = value => Array.isArray(value) ? value.join('\n')
        : typeof value === 'object' && value ? JSON.stringify(value) : String(value ?? '');

    function displayText(entry, field) {
        const value = entry[field] ?? entry.spell?.[field];
        return typeof value === 'string' ? window.modHubGetMarketCardText(entry, field).text : value;
    }

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

    function getCategory(entry) {
        return MODHUB_SPELL_CATEGORIES.includes(entry?.spell?.category) ? entry.spell.category : '未分类';
    }

    function filter(search = '', category = 'all') {
        const query = search ? window.modHubSearch.compile(search) : { tokens: [] };
        return spells.filter(entry => window.modHubMarket.matchesContentLanguage(entry) && (category === 'all' || getCategory(entry) === category)).map(entry => ({ entry, score: query.tokens.length ? window.modHubSearch.score(window.modHubMarket.getLocalizedSearchEntry(entry), query) : 0 }))
            .filter(item => item.score >= 0).sort((left, right) => {
                if (query.tokens.length && left.score !== right.score) return right.score - left.score;
                return String(displayText(left.entry, 'name')).localeCompare(String(displayText(right.entry, 'name')), 'zh-CN');
            }).map(item => item.entry);
    }

    function getCategories(search = '') {
        const counts = new Map([...MODHUB_SPELL_CATEGORIES, '未分类'].map(category => [category, 0]));
        filter(search).forEach(entry => counts.set(getCategory(entry), counts.get(getCategory(entry)) + 1));
        return [...counts].map(([category, count]) => ({ category, count }));
    }

    function acquisitionHtml(entry) {
        const sources = normalizeSources(entry);
        const packages = normalizePackages(entry);
        const spellSource = Boolean(entry.spell);
        const link = (url, label, original = false) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer"${original ? ' data-modhub-i18n-ignore' : ''}>${original ? escapeHtml(label) : (Array.isArray(label) ? label : [label]).map(key => labelHtml(key)).join(' · ')}</a>` : '';
        const facts = fields => {
            const values = fields.filter(([, value]) => value !== undefined && value !== null && String(value).trim());
            return values.length ? `<dl class="modhub-detail-facts">${values.map(([label, value]) =>
                `<div><dt>${labelHtml(label)}：</dt><dd data-modhub-i18n-ignore>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : '';
        };
        const note = (label, value) => value ? `<div class="modhub-detail-note"><span class="modhub-detail-label">${labelHtml(label)}：</span>`
            + `<p class="modhub-acquisition-text modhub-detail-readme" tabindex="0" data-modhub-i18n-ignore>${escapeHtml(value)}</p></div>` : '';
        const sourceLines = sources.map(source => {
            const label = source.label || MODHUB_SOURCE_NAMES[source.platform] || '原始来源';
            if (spellSource) return '<div class="modhub-spell-source">'
                + link(source.url, label, Boolean(source.label))
                + (source.downloadUrl && source.downloadUrl !== source.url ? link(source.downloadUrl, '下载入口') : '')
                + facts([['提取码', source.extractionCode], ['解压密码', source.archivePassword]])
                + (source.platform === 'discord' ? '<p>' + labelHtml('需登录 Discord，并按原帖要求加入服务器或取得访问权限。') + '</p>' : '')
                + (source.instructions ? `<p data-modhub-i18n-ignore>${escapeHtml(source.instructions)}</p>` : '') + '</div>';
            return '<div class="modhub-acquisition-source">'
                + `<div class="modhub-detail-links">${link(source.url, label, Boolean(source.label))}${source.downloadUrl && source.downloadUrl !== source.url ? link(source.downloadUrl, '下载入口') : ''}</div>`
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
                + `<div class="modhub-detail-package-heading"><strong data-modhub-i18n-ignore>${escapeHtml(record.fileName || record.bootName || '安装包')}</strong>`
                + (record.version ? `<span class="modhub-detail-version">${labelHtml('版本')} <span data-modhub-i18n-ignore>${escapeHtml(record.version)}</span></span>` : '') + '</div>'
                + `<div class="modhub-detail-status"><span>${isVerifiedPackage(record) ? '安装包结构已核验' : '安装包资料待核对'}</span> · <span>${record.gameTested === true ? '已游戏验证' : '未游戏实测'}</span></div>`
                + facts([['文件格式', record.format], ['模组标识', record.bootName], ['适配 DoL', record.gameVersionRange || t('未知，请核对作者说明')],
                    ['美化框架', record.framework], ['前置要求', dependencies], ['提取码', record.extractionCode], ['解压密码', record.archivePassword]])
                + `<div class="modhub-detail-links">${[...packageLinks].map(([url, labels]) => link(url, labels)).join('')}</div>`
                + note('前提条件', prerequisites) + note('安装说明', record.instructions) + note('核验范围', record.verificationScope) + '</article>';
        }).join('');
        const section = (title, count, body) => count ? `<section class="modhub-detail-section"><div class="modhub-detail-heading">${labelHtml(title)}${labelHtml('{count} 项', { count })}</div>${body}</section>` : '';
        if (spellSource) return `<div class="modhub-spell-sources">${sourceLines}</div>`
            + (packages.length ? `<div class="modhub-acquisition">${section('包体资料', packages.length, packageLines)}</div>` : '');
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
        const platformOrder = { 'github': 1, 'discord': 2, '百度贴吧': 3 };
        const result = [...links.values()].map(source => source.link);
        result.sort((a, b) => {
            const orderA = platformOrder[String(a.name || '').toLowerCase()] || 99;
            const orderB = platformOrder[String(b.name || '').toLowerCase()] || 99;
            return orderA - orderB;
        });
        return result;
    }

    function renderAcquisitionDetails(entry) {
        const links = getSourceLinks(entry);
        const linkHtml = links.map(source => `<a class="modhub-market-source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" data-modhub-i18n-title="${escapeHtml(source.title)}" data-modhub-i18n-title-params="{}" title="${escapeHtml(t(source.title, {}))}"><span data-modhub-i18n-key="${escapeHtml(source.name)}" data-modhub-i18n-key-params="{}">${escapeHtml(t(source.name, {}))}</span></a>`).join('<span aria-hidden="true">·</span>');
        return `<div class="modhub-market-source-bar"><span class="modhub-market-source-summary">${labelHtml('来源')}：</span>`
            + (linkHtml || '<span class="modhub-market-source-empty">暂无来源链接</span>') + '</div>';
    }

    async function copyBody(entry) {
        const body = entry?.spell?.body;
        if (typeof body !== 'string') return false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
            await navigator.clipboard.writeText(body);
            window.modHubShowToast?.('已复制言灵正文。请按说明在对应位置使用。', 'success');
            return true;
        } catch (error) {
            await window.modHubAlert?.(`未能复制言灵正文。请在详情中选择正文后手动复制。\n\n错误详情：${error.message || String(error)}`, '复制未完成');
            return false;
        }
    }

    function appendSpellDetails(host, entry, showName = true) {
        const originalText = (node, value) => {
            node.setAttribute('data-modhub-i18n-ignore', '');
            node.textContent = spellText(value);
            return node;
        };
        const section = (title, className = '') => {
            const box = document.createElement('section');
            box.className = 'modhub-spell-section' + (className ? ' ' + className : '');
            const heading = document.createElement('div');
            heading.className = 'modhub-spell-section-heading';
            const label = document.createElement('h3');
            if (window.modHubBindText) window.modHubBindText(label, title); else label.textContent = t(title);
            heading.appendChild(label);
            box.appendChild(heading);
            host.appendChild(box);
            return { box, heading };
        };
        const facts = (title, fields, className) => {
            const values = fields.filter(([, value]) => value !== undefined && value !== null && String(value).trim());
            if (!values.length) return;
            const { box } = section(title, className);
            const list = document.createElement('dl');
            list.className = 'modhub-spell-facts';
            values.forEach(([key, value]) => {
                const row = document.createElement('div');
                row.className = 'modhub-spell-fact';
                const label = document.createElement('dt');
                if (window.modHubBindText) window.modHubBindText(label, key); else label.textContent = t(key);
                row.appendChild(label);
                row.appendChild(originalText(document.createElement('dd'), value));
                list.appendChild(row);
            });
            box.appendChild(list);
        };
        const summary = document.createElement('section');
        summary.className = 'modhub-spell-summary';
        if (showName) {
            const name = originalText(document.createElement('h3'), displayText(entry, 'name') || t('言灵'));
            name.className = 'modhub-spell-name';
            summary.appendChild(name);
        }
        if (entry.author) {
            const author = document.createElement('p');
            author.className = 'modhub-spell-author';
            author.innerHTML = modHubHtml(labelHtml('作者') + '：');
            author.appendChild(originalText(document.createElement('span'), entry.author));
            summary.appendChild(author);
        }
        if (displayText(entry, 'description')) {
            const description = originalText(document.createElement('p'), displayText(entry, 'description'));
            description.className = 'modhub-spell-description';
            summary.appendChild(description);
        }
        if (summary.children.length) host.appendChild(summary);
        facts('使用方法', [['手动输入位置', displayText(entry, 'inputLocation')], ['使用步骤', displayText(entry, 'instructions')]]);
        facts('使用条件', [['前提条件', displayText(entry, 'prerequisites')], ['参数', displayText(entry, 'parameters')]], 'modhub-spell-section-important');

        const { box, heading } = section('言灵正文');
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'macro-button modhub-btn-secondary modhub-spell-copy-icon';
        for (const attribute of ['title', 'aria-label']) {
            copy.setAttribute(attribute, t('复制正文'));
            copy.setAttribute('data-modhub-i18n-' + attribute, '复制正文');
        }
        copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
        copy.onclick = () => copyBody(entry);
        heading.appendChild(copy);
        const body = document.createElement('pre');
        body.className = 'modhub-spell-body';
        body.tabIndex = 0;
        body.textContent = entry.spell.body;
        body.setAttribute('data-modhub-i18n-ignore', '');
        box.appendChild(body);
        facts('适用环境', [['适配 DoL', displayText(entry, 'gameVersionRange')],
            ['适用模组及版本', displayText(entry, 'modVersions')], ['使用后检查', displayText(entry, 'verificationMethod')]]);
        if (normalizeSources(entry).length || normalizePackages(entry).length) {
            const sources = document.createElement('div');
            sources.innerHTML = modHubHtml(acquisitionHtml(entry));
            section('来源').box.appendChild(sources);
        }
    }

    async function showDetails(entry) {
        if (typeof window.modHubConfirm !== 'function') return false;
        const apply = await window.modHubConfirm({ title: displayText(entry, 'name') || '言灵', confirmText: '应用这条言灵', cancelText: '关闭',
            trustedMessageHtml: '<div class="modhub-spell-detail"></div>', dialogClass: 'modhub-spell-dialog',
            onRender: dialog => appendSpellDetails(dialog.querySelector('.modhub-spell-detail'), entry, false) });
        return apply ? applySpell(entry) : false;
    }

    function refreshApplyButtons(root = document) {
        root.querySelectorAll('.modhub-spell-apply-button').forEach(button => {
            const active = Boolean(applyPhase) && button.dataset.spellId === applyingId;
            button.disabled = Boolean(applyPhase);
            button.setAttribute('aria-busy', String(active));
            const key = active ? applyPhase : '应用';
            if (window.modHubBindText) window.modHubBindText(button, key); else button.textContent = t(key);
        });
        refreshBackupControls?.();
    }

    function executionPayload(entry) {
        const body = entry?.spell?.body;
        if (typeof body !== 'string' || !body.trim()) throw new Error(t('言灵正文为空，无法应用。'));
        const syntax = String(entry.spell.syntax || '');
        let script;
        if (/JavaScript|\bJS\b/i.test(syntax)) script = body;
        else if (/SugarCube/i.test(syntax)) {
            if (typeof window.SugarCube?.Wikifier?.wikifyEval !== 'function' || typeof window.jQuery?.fn?.triggerHandler !== 'function') {
                throw new Error(t('当前游戏缺少 SugarCube 接口，无法直接运行这条言灵。请复制正文，按作者说明手动使用。'));
            }
            script = `(() => {
    const fragment = window.SugarCube.Wikifier.wikifyEval(${JSON.stringify(body)});
    const actions = fragment.querySelectorAll('a.link-internal, button.link-internal');
    if (fragment.querySelector('a.link-external')) throw new Error(${JSON.stringify(t('这条言灵包含外部链接，无法直接运行。请按作者说明使用。'))});
    if (fragment.querySelector('a.link-broken')) throw new Error(${JSON.stringify(t('这条言灵需要的场景不存在，请核对游戏版本和使用条件。'))});
    if (actions.length > 1) throw new Error(${JSON.stringify(t('这条言灵包含多个操作，无法自动选择。请按作者说明使用。'))});
    if (actions.length === 1) window.jQuery(actions[0]).triggerHandler('click');
    const error = fragment.querySelector('.error');
    if (error) throw new Error(error.textContent);
})();`;
        } else throw new Error(t('暂不支持直接运行这种语法。请复制正文，按作者说明手动使用。'));
        return { summary: t('应用言灵：{name}', { name: displayText(entry, 'name') || t('言灵') }), script,
            verification: entry.spell.verificationMethod || t('使用后请按说明检查游戏中的变化。') };
    }

    async function downloadBackup(backupId) {
        try { return await window.modHubGameCommand.download(backupId); }
        catch (error) {
            await window.modHubAlert(t('备份下载未完成，请在“言灵备份”中重试。') + '\n\n' + t('错误详情') + '：' + (error.message || String(error)), t('备份下载未完成'));
            return false;
        }
    }

    async function showApplyFailure({ notRun = false, message = '', error = '', backupId = null }) {
        const download = await window.modHubConfirm({ title: '应用未完成',
            confirmText: backupId ? '下载备份存档' : '确定', cancelText: backupId ? '关闭' : '',
            trustedMessageHtml: '<div class="modhub-spell-failure"></div>',
            dialogClass: 'modhub-spell-dialog modhub-spell-failure-dialog', onRender(dialog) {
                const host = dialog.querySelector('.modhub-spell-failure');
                const text = (parent, tag, className, value, original = false) => {
                    const node = document.createElement(tag);
                    node.className = className;
                    if (original) {
                        node.setAttribute('data-modhub-i18n-ignore', '');
                        node.textContent = String(value);
                    } else if (window.modHubBindText) window.modHubBindText(node, value);
                    else node.textContent = t(value);
                    parent.appendChild(node);
                    return node;
                };
                const status = document.createElement('section');
                status.className = 'modhub-spell-failure-status';
                text(status, 'h3', 'modhub-spell-failure-heading red', notRun ? '言灵未运行' : '应用未完成');
                if (message && error) text(status, 'p', 'modhub-spell-failure-message', message, true);
                host.appendChild(status);
                const details = document.createElement('section');
                details.className = 'modhub-spell-failure-error';
                text(details, 'h3', 'gold', '错误详情');
                const raw = text(details, 'pre', 'modhub-spell-failure-raw', error || message, true);
                raw.tabIndex = 0;
                raw.setAttribute('aria-label', t('错误详情'));
                host.appendChild(details);
                const next = document.createElement('section');
                next.className = 'modhub-spell-failure-next';
                text(next, 'h3', 'gold', '建议操作');
                text(next, 'p', '', notRun ? '请按错误详情中的提示处理，再返回言灵页面重新确认。'
                    : '请先检查游戏中的变化，再按错误详情处理。需要重试时，请重新确认应用。');
                host.appendChild(next);
                if (backupId) {
                    const backup = document.createElement('section');
                    backup.className = 'modhub-spell-failure-backup';
                    text(backup, 'h3', 'gold', '言灵备份');
                    text(backup, 'p', '', '已自动备份使用前的存档。需要恢复时，可下载备份，再通过游戏的存档界面导入。');
                    host.appendChild(backup);
                }
            } });
        if (backupId && download) await downloadBackup(backupId);
    }

    async function applySpell(entry) {
        if (applying) return false;
        applying = true;
        let runRequested = false, retainedBackupId = null;
        try {
            const command = window.modHubGameCommand;
            if (!command) throw new Error(t('言灵功能尚未就绪，请重新载入游戏后重试。'));
            const payload = executionPayload(entry);
            const confirmedFields = ['body', 'syntax', 'inputLocation', 'instructions', 'prerequisites', 'parameters',
                'gameVersionRange', 'modVersions', 'verificationMethod'];
            const confirmedValues = confirmedFields.map(field => spellText(entry[field] ?? entry.spell?.[field]));
            const assertActive = backupId => {
                if (backupId) retainedBackupId = backupId;
                const host = document.getElementById('modHubModMarketContainer');
                if (!applying || !host?.getClientRects().length || window.modHubMarket.getCurrentMarketSection() !== 'spells') {
                    throw new Error(t('请返回言灵页面，重新确认后再应用。'));
                }
                const current = spells.find(item => item.id === entry.id);
                if (!current) throw new Error(t('这条言灵已从当前目录移除，请刷新列表后重新选择。'));
                if (confirmedFields.some((field, index) => spellText(current[field] ?? current.spell?.[field]) !== confirmedValues[index])) {
                    throw new Error(t('这条言灵的内容或使用说明已更新，请重新打开并确认后再应用。'));
                }
                if (backupId) {
                    applyPhase = '正在应用…';
                    refreshApplyButtons();
                }
                return true;
            };
            assertActive();
            applyingId = entry.id;
            applyPhase = '正在准备';
            refreshApplyButtons();
            const prepared = await command.prepare(payload);
            assertActive();
            const confirmed = await window.modHubConfirm({ title: '确认应用言灵', confirmText: '确认应用', cancelText: '取消',
                trustedMessageHtml: '<p class="modhub-spell-apply-notice">' + labelHtml('确认后会先备份当前存档，再运行这条言灵。有些言灵会刷新或切换场景，请先阅读使用条件。')
                    + '</p><div class="modhub-spell-detail"></div>', dialogClass: 'modhub-spell-dialog',
                onRender: dialog => appendSpellDetails(dialog.querySelector('.modhub-spell-detail'), entry) });
            if (!confirmed) return false;
            assertActive();
            applyPhase = '正在备份…';
            refreshApplyButtons();
            const operationId = 'modhub-spell:' + entry.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
            window.modHubShowToast?.('正在备份存档，请稍候。', 'info');
            runRequested = true;
            const result = await command.run(payload, prepared.stamp, operationId, assertActive);
            if (!result.ok) {
                await showApplyFailure({ message: result.message, error: result.error, backupId: result.backupId });
                return false;
            }
            const message = t('言灵已运行，请查看游戏中的变化。');
            const detail = message + (result.error ? '\n\n' + t('错误详情') + '：' + result.error : '');
            if (result.backupId) {
                const download = await window.modHubConfirm({ title: result.ok ? '执行完成' : '应用未完成',
                    message: detail + '\n\n' + t('已自动备份使用前的存档。需要恢复时，可下载备份，再通过游戏的存档界面导入。'),
                    confirmText: '下载备份存档', cancelText: '关闭' });
                if (download) await downloadBackup(result.backupId);
            } else await window.modHubAlert(detail, t(result.ok ? '执行完成' : '应用未完成'));
            return result.ok;
        } catch (error) {
            await showApplyFailure({ notRun: !runRequested, error: error.message || String(error), backupId: retainedBackupId });
            return false;
        } finally {
            applying = false;
            applyingId = '';
            applyPhase = '';
            refreshApplyButtons();
        }
    }

    async function showBackups() {
        let closed = false;
        try {
            if (!window.modHubGameCommand?.listBackups) throw new Error(t('言灵功能尚未就绪，请重新载入游戏后重试。'));
            const readBackups = async () => (await window.modHubGameCommand.listBackups()).filter(record => record.requestId?.startsWith('modhub-spell:'));
            let backups = await readBackups(), busy = false, statusKey = '', statusParams;
            const selected = new Set();
            await window.modHubConfirm({ title: '言灵备份', confirmText: '关闭', cancelText: '',
                trustedMessageHtml: '<p>' + labelHtml('这里保留了使用言灵前的存档。下载后可在游戏的存档界面导入，恢复当时的进度。') + '</p><div class="modhub-spell-backup-manager"></div>',
                dialogClass: 'modhub-spell-dialog', onRender(dialog) {
                    const host = dialog.querySelector('.modhub-spell-backup-manager');
                    const bind = (node, key, params) => window.modHubBindText ? window.modHubBindText(node, key, params) : (node.textContent = t(key, params));
                    const count = document.createElement('p'), toolbar = document.createElement('div'), status = document.createElement('p'), list = document.createElement('div');
                    count.className = 'modhub-spell-backup-count';
                    count.setAttribute('aria-live', 'polite');
                    toolbar.className = 'modhub-spell-backup-toolbar';
                    status.className = 'modhub-spell-backup-status';
                    status.setAttribute('role', 'status');
                    list.className = 'modhub-spell-backups';
                    host.appendChild(count); host.appendChild(toolbar); host.appendChild(status); host.appendChild(list);
                    const button = (key, className, handler) => {
                        const node = document.createElement('button');
                        node.type = 'button';
                        node.className = 'macro-button modhub-btn-secondary ' + className;
                        bind(node, key); node.onclick = handler; toolbar.appendChild(node);
                        return node;
                    };
                    const sync = () => {
                        bind(count, '共 {count} 份备份，已选 {selected} 份', { count: backups.length, selected: selected.size });
                        bind(selectAll, backups.length && selected.size === backups.length ? '取消选择' : '全选');
                        selectAll.disabled = busy || !backups.length;
                        remove.disabled = busy || applying || !selected.size;
                        clear.disabled = busy || applying || !backups.length;
                        list.querySelectorAll('input').forEach(input => { input.disabled = busy; });
                        const key = applying ? '言灵正在应用，请稍候再删除备份。' : statusKey;
                        status.hidden = !key;
                        if (key) bind(status, key, applying ? undefined : statusParams);
                    };
                    const render = () => {
                        const available = new Set(backups.map(record => record.id));
                        for (const id of selected) if (!available.has(id)) selected.delete(id);
                        list.replaceChildren();
                        backups.forEach((record, index) => {
                            const row = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('span');
                            row.className = 'modhub-spell-backup-row' + (selected.has(record.id) ? ' is-selected' : '');
                            label.className = 'modhub-spell-backup-select';
                            input.type = 'checkbox'; input.checked = selected.has(record.id);
                            input.className = 'modhub-spell-backup-checkbox';
                            input.onchange = () => {
                                if (busy || closed) return;
                                if (input.checked) selected.add(record.id); else selected.delete(record.id);
                                row.classList.toggle('is-selected', input.checked); sync();
                            };
                            const entry = spells.find(entry => record.requestId?.split(':')[1] === entry.id);
                            const summary = entry ? t('应用言灵：{name}', { name: displayText(entry, 'name') }) : record.summary || t('言灵');
                            name.textContent = summary + '\n' + new Date(record.createdAt).toLocaleString();
                            label.appendChild(input); label.appendChild(name); row.appendChild(label);
                            const download = document.createElement('button');
                            download.type = 'button'; download.className = 'macro-button modhub-btn-secondary modhub-spell-backup-download';
                            download.dataset.backupIndex = String(index); bind(download, '下载备份存档');
                            download.onclick = () => downloadBackup(record.id);
                            row.appendChild(download); list.appendChild(row);
                        });
                        if (!backups.length) {
                            const empty = document.createElement('p');
                            empty.className = 'modhub-spell-backup-empty grey';
                            bind(empty, '还没有言灵备份。使用言灵时会自动保存。'); list.appendChild(empty);
                        }
                        sync();
                    };
                    const deleteRecords = async all => {
                        if (busy || closed) return false;
                        if (applying) { sync(); return false; }
                        busy = true; statusKey = ''; sync();
                        try {
                            backups = await readBackups();
                            if (closed || applying) return false;
                            render();
                            const ids = backups.filter(record => all || selected.has(record.id)).map(record => record.id);
                            if (!ids.length) return false;
                            const confirmed = await window.modHubConfirm({ title: '确认删除言灵备份', confirmType: 'danger',
                                message: t(all ? '将清空本机全部 {count} 份言灵备份。此操作无法撤销，已下载的存档文件不受影响。'
                                    : '将删除所选 {count} 份言灵备份。此操作无法撤销，已下载的存档文件不受影响。', { count: ids.length }),
                                confirmText: '删除', cancelText: '取消' });
                            if (!confirmed || closed || applying) return false;
                            statusKey = '正在删除备份，请稍候。'; sync();
                            const deleted = await window.modHubGameCommand.deleteBackups(ids);
                            selected.clear(); backups = backups.filter(record => !ids.includes(record.id));
                            statusKey = '已删除 {count} 份言灵备份。'; statusParams = { count: deleted };
                            if (!closed) render();
                            return true;
                        } catch (error) {
                            statusKey = '备份删除未完成。\n\n错误详情：{error}'; statusParams = { error: error.message || String(error) };
                            return false;
                        } finally { busy = false; if (!closed) sync(); }
                    };
                    const selectAll = button('全选', 'modhub-spell-backup-select-all', () => {
                        if (busy || closed || !backups.length) return;
                        if (selected.size === backups.length) selected.clear(); else backups.forEach(record => selected.add(record.id));
                        render();
                    });
                    const remove = button('删除所选', 'modhub-spell-backup-delete', () => deleteRecords(false));
                    const clear = button('清空历史', 'modhub-spell-backup-clear', () => deleteRecords(true));
                    refreshBackupControls = sync;
                    render();
                } });
            return true;
        } catch (error) {
            await window.modHubAlert(t('无法读取言灵备份。') + '\n\n' + t('错误详情') + '：' + (error.message || String(error)), t('言灵备份'));
            return false;
        } finally { closed = true; refreshBackupControls = null; }
    }

    function render(container, { search = '', entries = filter(search), paginationHtml = '' } = {}) {
        container.innerHTML = modHubHtml((entries.length ? entries.map((entry, index) => `<div class="childItem modhub-market-card modhub-spell-card" data-spell-id="${escapeHtml(entry.id)}">`
            + `<div class="modhub-market-card-header"><span class="modhub-market-title gold" data-modhub-card-field="name" data-modhub-i18n-ignore>${escapeHtml(displayText(entry, 'name'))}</span></div>`
            + `<div class="modhub-market-tags"><span class="modhub-market-tag modhub-market-category">${labelHtml(getCategory(entry))}</span></div>`
            + `<div class="modhub-market-meta grey"><span>${labelHtml('作者')}：<span data-modhub-i18n-ignore>${escapeHtml(entry.author || t('未知作者'))}</span></span></div>`
            + window.modHubMarket.renderCardDescription(entry, escapeHtml)
            + `<div class="modhub-market-meta grey" data-modhub-spell-meta-row="gameVersionRange"${displayText(entry, 'gameVersionRange') ? '' : ' hidden'}>${labelHtml('适配 DoL')}：<span data-modhub-spell-field="gameVersionRange" data-modhub-i18n-ignore>${escapeHtml(displayText(entry, 'gameVersionRange') || '')}</span></div>`
            + `<div class="modhub-market-actions"><button type="button" class="macro-button modhub-btn-primary modhub-spell-apply-button" data-spell-id="${escapeHtml(entry.id)}" data-spell-index="${index}">应用</button>`
            + `<button type="button" class="macro-button modhub-btn-secondary modhub-spell-detail-button" data-spell-index="${index}">查看使用说明</button></div></div>`).join('')
            : `<div class="modhub-empty-state grey">${spells.length ? '没有找到匹配的言灵。请调整用途或搜索条件。' : '这里还没有言灵，可以刷新列表再看看。'}</div>`) + paginationHtml);
        container.querySelectorAll('.modhub-spell-detail-button').forEach(button => { button.onclick = () => showDetails(entries[Number(button.dataset.spellIndex)]); });
        container.querySelectorAll('.modhub-spell-apply-button').forEach(button => { button.onclick = () => applySpell(entries[Number(button.dataset.spellIndex)]); });
        refreshApplyButtons(container);
    }

    function refreshLanguage(root) {
        root.querySelectorAll('.modhub-spell-card[data-spell-id]').forEach(card => {
            const entry = spells.find(item => item.id === card.dataset.spellId);
            if (entry) {
                window.modHubMarket.refreshCardContent(card, entry);
                card.querySelectorAll('[data-modhub-spell-meta-row]').forEach(row => {
                    const value = displayText(entry, row.dataset.modhubSpellMetaRow);
                    row.hidden = !value;
                    row.querySelector('[data-modhub-spell-field]').textContent = value || '';
                });
            }
        });
        refreshApplyButtons(root);
    }

    window.modHubMarketSpells = { applyIndex, restoreCache, normalizeSpells, normalizeSources, normalizePackages, isVerifiedPackage,
        acquisitionHtml, getSourceLinks, renderAcquisitionDetails, copyBody, showDetails, applySpell, showBackups, render, refreshLanguage, filter, getCategory, getCategories,
        getCategoryNames: () => MODHUB_SPELL_CATEGORIES.slice(), getSpells: () => spells.slice(),
        getRevision: () => revision, CACHE_KEY: MODHUB_SPELL_CACHE_KEY };
})();
