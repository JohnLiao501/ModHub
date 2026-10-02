/** ModHub - 市场版本选择、包体预检与依赖安装。 */
(function () {
    'use strict';

    const MODHUB_SPECIAL_DEPENDENCIES = new Set(['gameversion', 'modloader', 'sugarcube', 'dol', 'degrees of lewdity']);
    const market = () => window.modHubMarket;
    const versions = () => window.modHubMarketVersions;
    const rangeText = value => versions().formatVersionRange(value || '*');
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const normalize = value => String(value || '').trim().toLowerCase();
    const keyOf = mod => market().getMarketModKey(mod);
    const stopped = () => Boolean(market().batchInstallState?.stopRequested);
    const localBoot = profile => profile?.bootJson || window.modHubGetModInfo?.(profile?.name)?.bootJson || profile;
    const bootSnapshot = boot => boot ? JSON.stringify([boot.name, boot.version, boot.alias || [], boot.dependenceInfo || []]) : '';
    const isDisabled = name => (window._modHubModState?.sideDisabled || []).some(item => normalize(item) === normalize(name))
        || (window._modHubModState?.sideMods || []).some(item => normalize(item.name) === normalize(name) && item.enabled === false);

    function getLocal(mod) {
        const profiles = market().getLocalInstalledProfiles();
        market().checkModInstallStatus(mod, profiles);
        return mod._matchedLocal || profiles.find(profile => (mod.bootNames || []).some(name => normalize(name) === normalize(profile.name))) || null;
    }

    function satisfies(boot, requirement) {
        if (!boot) return false;
        if (requirement.bootName && !getDependencyBootNames(boot).some(name => normalize(name) === normalize(requirement.bootName))) return false;
        if (requirement.bootVersions) {
            const entry = Object.entries(requirement.bootVersions).find(([name]) => normalize(name) === normalize(boot.name));
            return Boolean(entry && satisfiesRange(boot.version, entry[1]));
        }
        return satisfiesRange(boot.version, requirement.version || '*');
    }

    /** 仅复用原生 boot.name 与 boot.alias，不能使用展示名或目录别名证明前置身份。 */
    function getDependencyBootNames(boot) {
        return [...new Set([boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])]
            .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
    }

    function satisfiesRange(version, range) {
        if (!range || range === '*') return true;
        try {
            const api = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.();
            if (api?.parseVersion && api?.parseRange && api?.satisfies) {
                const supported = String(range).split('||').every(clause => {
                    const bounds = clause.trim().split('&&');
                    return bounds.length <= 2 && bounds.every(bound => /^(?:>=|<=|>|<|=|\^)?\d+(?:\.\d+)*(?:-[0-9a-z][0-9a-z.-]*)?(?:\+[0-9a-z][0-9a-z.-]*)?$/i.test(bound.trim()));
                });
                if (!supported) return false;
                const parsedVersion = api.parseVersion(String(version || ''))?.version;
                const parsedRange = api.parseRange(String(range));
                if (!parsedVersion?.version?.length || !Array.isArray(parsedRange) || parsedRange.length !== String(range).split('||').length) return false;
                return api.satisfies(parsedVersion, parsedRange) === true;
            }
        } catch (_) { return false; }
        // ponytail: 旧加载器仅回退现有单条件比较，复杂范围须原生比较器或手动处理。
        return /^(?:>=|<=|>|<|=|\^|~)?\s*v?\d+(?:\.\d+)*$/.test(String(range).trim())
            && market().satisfiesVersion(version, String(range).replace(/^\s*=\s*/, ''));
    }

    const matchesLocalVersion = (candidate, localVersion) => market().isSameVersion(candidate?.version, localVersion);

    function candidateLabel(candidate, recommended = false, localVersion = '') {
        return `${candidate.version || candidate.tagName || '版本未知'} · ${versions().getCandidateStatus(candidate, { recommended }).label}${matchesLocalVersion(candidate, localVersion) ? ' · 与已安装版本号相同' : ''} · ${candidate.assetName || candidate.assets?.[0]?.name || '安装包'}`;
    }

    function groupCandidates(candidates, gameVersion, recommendedKey = '') {
        const groups = new Map();
        candidates.forEach(candidate => {
            const info = candidate.compatibility || {};
            const target = String(info.targetGameVersion || '').trim(), range = String(info.gameVersionRange || '').trim();
            const key = target ? `target:${target}` : range ? `range:${range}` : 'unknown';
            const group = groups.get(key) || { key, label: target ? `DoL ${target}` : range ? `作者声明：DoL ${rangeText(range)}` : '适配待核对', candidates: [], preferred: false };
            group.candidates.push(candidate);
            group.preferred ||= candidate.candidateKey === recommendedKey || Boolean(gameVersion && (target
                ? market().compareVersions(target, gameVersion) === 0 : range && info.status === 'compatible'));
            groups.set(key, group);
        });
        return [...groups.values()].sort((a, b) => Number(b.preferred) - Number(a.preferred));
    }

    function sourceLink(url, text) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' && !parsed.username && !parsed.password
                ? `<a href="${escape(parsed.toString())}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>` : '';
        } catch (_) { return ''; }
    }

    async function loadChoices(mod, options = {}) {
        let history = await versions().fetchReleases(mod, { page: 1, signal: options.signal });
        const candidates = versions().buildCandidates(mod, history);
        const update = mod._updateCheck && market().getModUpdateInfo?.(mod);
        const target = !update?.pending && !update?.error ? update?.release : null;
        // 已检测到的更新可能在后续历史页，直接读取到目标所在页再显示选择。
        while (target && history.hasMore && !candidates.some(candidate => candidate.candidateKey === target.candidateKey)) {
            history = await versions().fetchReleases(mod, { page: history.page + 1, signal: options.signal });
            candidates.push(...versions().buildCandidates(mod, history));
        }
        const ranked = versions().rankCandidates(mod, candidates, options);
        const latest = options.localVersion && versions().getLatestGameCandidate?.(mod, candidates);
        if (latest && market().compareVersions(latest.version, options.localVersion) > 0) ranked.recommendedKey = latest.candidateKey;
        return { ...ranked, history };
    }

    async function selectVersion(mod, options = {}) {
        const controller = new AbortController();
        let candidates = [], selectedKey = '', initialKey = '', manuallySelected = false;
        let closed = false, loading = true, slow = false, errorMessage = '', slowTimer;
        let history = null, staleFetchedAt = '', gameVersion = versions().getGameVersion();
        const local = options.localBoot || getLocal(mod), localVersion = String(options.localVersion || local?.version || '');
        const selectedInstalled = () => matchesLocalVersion(candidates.find(candidate => candidate.candidateKey === selectedKey), localVersion);
        const openGroups = new Map(), renderedGroups = new Map();
        const selectionVisible = key => key === '__skip__' ? Boolean(options.allowSkip) : candidates.some(candidate => candidate.candidateKey === key)
            && ![...renderedGroups.values()].some(group => [...group.querySelectorAll('input[name="modHubMarketVersion"]')].some(input => input.value === key && (!group.open || input.checked === false)));
        const requires = options.requirements || [];
        const requirementText = item => item.bootVersions ? Object.entries(item.bootVersions).map(([name, range]) => `${name}：${rangeText(range)}`).join('；') : rangeText(item.version);
        const unmet = options.localBoot ? requires.filter(item => !satisfies(options.localBoot, item)) : [];
        const localContext = unmet.length ? `<p class="gold">已识别本地【${escape(mod.name)}】${escape(options.localBoot.version || '版本未知')}，但所选目标要求 ${escape([...new Set(unmet.map(requirementText))].join('；'))}，当前不满足。可以选择其他版本，也可以跳过此前置并自行处理。</p>` : '';
        const requirementSources = requires.filter(item => item.source).map(item => escape(`【${item.targetName || item.declaredBy || mod.name}】${item.source}${item.declaredBy && item.declaredBy !== item.targetName ? `（${item.declaredBy}）` : ''}：${requirementText(item)}`)).join('<br>');
        const candidateMeetsRequirements = candidate => requires.every(requirement =>
            !requirement.bootVersions && satisfiesRange(candidate?.version, requirement.version || '*'));
        const candidateHtml = candidate => {
            const status = versions().getCandidateStatus(candidate, { recommended: candidate.candidateKey === initialKey });
            return `<label class="modhub-version-option ${candidate.candidateKey === selectedKey ? 'modhub-version-selected' : ''}">
                <input type="radio" name="modHubMarketVersion" value="${escape(candidate.candidateKey)}" ${candidate.candidateKey === selectedKey ? 'checked' : ''}>
                <span class="modhub-version-content"><span class="modhub-version-heading"><strong class="modhub-version-number gold">${escape(candidate.version || candidate.tagName || '版本未知')}</strong><span class="modhub-version-badge ${status.tone}">${escape(status.label)}</span>${matchesLocalVersion(candidate, localVersion) ? '<span class="modhub-version-badge gold">与已安装版本号相同</span>' : ''}</span>
                    <span class="modhub-version-meta grey">${escape(candidate.updateDate || '发布日期未知')} · ${Number(candidate.assetSize) ? (candidate.assetSize < 104858 ? '小于 0.1 MB' : `${(candidate.assetSize / 1048576).toFixed(1)} MB`) : '包体大小未知'}</span>
                    <span class="modhub-version-description">${escape(status.reason)}</span>
                    <details class="modhub-version-assets"><summary>安装文件${candidate.assets?.length > 1 ? `：主包及 ${candidate.assets.length - 1} 个附属包` : '：1 个主包'}</summary>${(candidate.assets || []).map((asset, index) => `<span class="modhub-version-asset-name grey">${index ? '附属包' : '主包'}：${escape(asset.name)}</span>`).join('')}</details>
                    ${sourceLink(candidate.htmlUrl, '发布说明')}
                </span></label>`;
        };
        const listHtml = () => `<div class="modhub-version-context"><strong class="gold">${escape(mod.name)}</strong><span class="grey">当前游戏版本：<strong class="gold">${gameVersion ? `DoL ${escape(gameVersion)}` : '未识别'}</strong></span><span class="grey">当前已安装模组版本：<strong class="gold">${escape(localVersion || (local ? '未识别' : '未安装'))}</strong></span></div>
            ${requires.length ? `<p class="modhub-install-plan-warning"><strong class="gold">需要前置版本：${escape(requires.map(requirementText).join('；'))}。</strong></p>` : ''}
            <p class="grey">以下按作者声明或安装包名称标注的游戏版本分类，分类不代表已核验适配。请核对作者说明。${sourceLink(mod.githubUrl, '作者主页')}</p>
            ${localContext}
            ${requirementSources ? `<p class="grey">前置要求来源：<br>${requirementSources}</p>` : ''}
            ${loading ? `<div class="modhub-version-loading" role="status" aria-live="polite">${candidates.length ? '正在读取更早版本…' : '正在读取版本列表…'}<span class="grey">${slow ? '发布服务响应较慢，请稍候；也可以取消后重试。' : '正在查找可用安装包并核对适配说明，可以随时取消。'}</span></div>` : ''}
            ${errorMessage ? `<div class="modhub-version-status" role="status"><p class="gold">${escape(errorMessage)}</p>${!history ? '<button type="button" class="macro-button modhub-version-retry">重试版本列表</button>' : ''}<span class="grey">也可以查看作者主页获取安装包。</span></div>` : ''}
            ${staleFetchedAt ? `<p class="gold">正在使用过期缓存，发布数据可能已变化。获取时间：${escape(staleFetchedAt)}。</p>` : ''}
            <div class="modhub-version-list" role="radiogroup" aria-label="按游戏版本分类选择模组版本" tabindex="0">${options.allowSkip ? `<label class="modhub-version-option ${selectedKey === '__skip__' ? 'modhub-version-selected' : ''}"><input type="radio" name="modHubMarketVersion" value="__skip__" ${selectedKey === '__skip__' ? 'checked' : ''}><span class="modhub-version-content"><strong class="gold">暂不安装此前置</strong><span class="modhub-version-description">保留目标模组，前置由您自行处理。缺少前置或版本不符可能导致模组无法运行。</span></span></label>` : ''}${groupCandidates(candidates, gameVersion, initialKey).map(group => {
                const open = openGroups.has(group.key) ? openGroups.get(group.key) : group.preferred;
                return `<details class="modhub-version-group" data-group-key="${escape(group.key)}" ${open ? 'open' : ''}><summary class="modhub-version-group-summary" aria-expanded="${open}"><strong class="gold">${escape(group.label)}</strong><span class="grey">${group.candidates.length} 个版本</span></summary>${group.candidates.map(candidateHtml).join('')}</details>`;
            }).join('') || (!loading && !errorMessage ? '<p class="grey">没有找到可自动安装的发布包。</p>' : '')}</div>
            ${history?.hasMore ? `<button type="button" class="macro-button modhub-version-load-more" ${loading ? 'disabled' : ''}>${errorMessage ? '重试加载更早版本' : '加载更早版本'}</button>` : ''}`;
        try {
            const choice = await window.modHubConfirm({
                title: `选择【${mod.name}】版本`, message: '请核对游戏版本与作者适配声明。',
                trustedMessageHtml: `<div id="modHubVersionChoices">${listHtml()}</div>`,
                dialogClass: 'modhub-install-dialog modhub-version-dialog', confirmText: '查看安装计划', cancelText: '取消',
                canConfirm: () => selectedKey === '__skip__' && options.allowSkip || Boolean(selectedKey) && !loading && selectionVisible(selectedKey) && !selectedInstalled(),
                onRender: dialog => {
                    const area = dialog.querySelector('#modHubVersionChoices');
                    const syncConfirm = () => {
                        const button = dialog.querySelector('.modhub-modal-btn-confirm');
                        if (button) button.textContent = selectedInstalled() ? '已安装' : '查看安装计划';
                        dialog.modHubSyncConfirmState?.();
                    };
                    const render = () => {
                        if (closed) return;
                        if (selectedKey && !selectionVisible(selectedKey)) { selectedKey = ''; manuallySelected = true; }
                        const scroll = area.querySelector('.modhub-version-list')?.scrollTop || 0;
                        const body = dialog.querySelector('.modhub-modal-body'), bodyScroll = body?.scrollTop || 0;
                        const focusKey = document.activeElement?.name === 'modHubMarketVersion' ? document.activeElement.value : '';
                        renderedGroups.forEach((group, key) => openGroups.set(key, group.open));
                        renderedGroups.clear();
                        area.innerHTML = listHtml();
                        area.querySelectorAll('.modhub-version-group').forEach(group => {
                            renderedGroups.set(group.dataset.groupKey, group);
                            const summary = group.querySelector('summary');
                            group.ontoggle = () => {
                                if (group.isConnected === false) return;
                                openGroups.set(group.dataset.groupKey, group.open); summary?.setAttribute('aria-expanded', String(group.open));
                                if (!group.open && [...group.querySelectorAll('input[name="modHubMarketVersion"]')].some(input => input.value === selectedKey)) {
                                    selectedKey = ''; manuallySelected = true;
                                    area.querySelectorAll('input[name="modHubMarketVersion"]').forEach(input => { input.checked = false; });
                                    area.querySelectorAll('.modhub-version-option').forEach(label => label.classList.remove('modhub-version-selected'));
                                    summary?.focus();
                                }
                                syncConfirm();
                            };
                        });
                        syncConfirm();
                        area.querySelectorAll('input[name="modHubMarketVersion"]').forEach(input => {
                            input.onchange = () => { if (closed || input.isConnected === false || input.checked === false || !selectionVisible(input.value)) return;
                                selectedKey = input.value; manuallySelected = true;
                                area.querySelectorAll('.modhub-version-option').forEach(label => label.classList.toggle('modhub-version-selected', label.querySelector('input')?.value === selectedKey));
                                syncConfirm(); };
                        });
                        const list = area.querySelector('.modhub-version-list');
                        if (list) list.scrollTop = scroll;
                        if (body) body.scrollTop = bodyScroll;
                        if (focusKey) [...area.querySelectorAll('input[name="modHubMarketVersion"]')].find(input => input.value === focusKey)?.focus({ preventScroll: true });
                        const retry = area.querySelector('.modhub-version-retry');
                        if (retry) retry.onclick = () => loadPage(true);
                        const more = area.querySelector('.modhub-version-load-more');
                        if (more) more.onclick = () => loadPage(false);
                    };
                    const loadPage = async first => {
                        if (closed || (loading && slowTimer !== undefined)) return;
                        loading = true; slow = false; errorMessage = ''; render();
                        slowTimer = setTimeout(() => {
                            if (!closed && loading) { slow = true; const status = area.querySelector('.modhub-version-loading');
                                if (status) status.innerHTML = '发布服务响应较慢，请稍候；也可以取消后重试。'; }
                        }, 3000);
                        try {
                            if (first) {
                                const choices = await loadChoices(mod, { ...options, signal: controller.signal });
                                if (closed) return;
                                candidates = choices.candidates; history = choices.history; gameVersion = choices.gameVersion;
                                if (!manuallySelected) {
                                    selectedKey = selectedKey === '__skip__' ? selectedKey : choices.recommendedKey || '';
                                    if (requires.length && selectedKey !== '__skip__') selectedKey = versions().rankCandidates(mod, candidates.filter(candidateMeetsRequirements), options).recommendedKey || '';
                                    if (selectedKey && selectedKey !== '__skip__' && !candidates.some(candidate => candidate.candidateKey === selectedKey && candidateMeetsRequirements(candidate))) selectedKey = '';
                                    if (selectedKey && selectedKey !== '__skip__' && options.localVersion && market().compareVersions(candidates.find(candidate => candidate.candidateKey === selectedKey)?.version, options.localVersion) < 0) selectedKey = '';
                                    initialKey = selectedKey;
                                } else if (selectedKey !== '__skip__' && !candidates.some(candidate => candidate.candidateKey === selectedKey)) selectedKey = '';
                            } else {
                                const page = await versions().fetchReleases(mod, { page: history.nextPage || Number(history.page || 1) + 1, signal: controller.signal });
                                if (closed) return;
                                history = page;
                                const joined = [...new Map([...candidates, ...versions().buildCandidates(mod, history)].map(candidate => [candidate.candidateKey, candidate])).values()];
                                candidates = versions().rankCandidates(mod, joined, options).candidates;
                            }
                            if (history.stale) staleFetchedAt = history.fetchedAt || '未知';
                        } catch (error) { if (!closed) errorMessage = `版本列表读取失败：${error.message || '发布服务暂不可用'}`; }
                        finally {
                            clearTimeout(slowTimer); slowTimer = undefined; loading = false;
                            if (!closed) render();
                        }
                    };
                    render();
                    return loadPage(true);
                },
                customResult: () => ({ selectedKey, manual: manuallySelected || selectedKey !== initialKey || !initialKey })
            });
            if (!choice) return null;
            const chosenKey = typeof choice === 'string' ? choice : choice.selectedKey;
            if (chosenKey === '__skip__' && options.allowSkip) return { skipped: true, manual: true };
            const release = candidates.find(candidate => candidate.candidateKey === chosenKey);
            return release && !matchesLocalVersion(release, localVersion) ? { release, manual: typeof choice === 'object' ? choice.manual : true } : null;
        } finally { closed = true; controller.abort(); clearTimeout(slowTimer); }
    }

    async function selectBatch(targets, updateOnly) {
        const controller = new AbortController();
        const rows = targets.map(mod => ({ mod, local: getLocal(mod), candidates: [], selectedKey: '', defaultKey: '', recommendedKey: '', loading: true }));
        let loading = true, closed = false;
        const canSelect = row => Boolean(row.selectedKey) && row.candidates.some(candidate => candidate.candidateKey === row.selectedKey && !matchesLocalVersion(candidate, row.local?.version));
        const defaultKey = (choices, local) => {
            const safe = choices.candidates.filter(candidate => candidate.compatibility?.status !== 'incompatible' && !candidate.compatibility?.referenceMismatch && !matchesLocalVersion(candidate, local?.version));
            const recommended = safe.find(candidate => candidate.candidateKey === choices.recommendedKey);
            const hasEvidence = candidate => candidate?.compatibility?.status === 'compatible' && candidate.compatibility.evidence === 'declaration'
                || candidate?.compatibility?.evidence === 'filename' && candidate.compatibility.targetGameVersion && choices.gameVersion
                    && market().compareVersions(candidate.compatibility.targetGameVersion, choices.gameVersion) === 0;
            if (recommended && hasEvidence(recommended) && (!local || market().compareVersions(recommended.version, local.version) >= 0)
                && (!updateOnly || local?.version && recommended.version && market().compareVersions(recommended.version, local.version) > 0)) return recommended.candidateKey;
            if (updateOnly || !choices.candidates[0]?.seriesKey || new Set(choices.candidates.map(candidate => candidate.seriesKey)).size !== 1) return '';
            const unknown = safe.filter(candidate => (!candidate.compatibility?.status || candidate.compatibility.status === 'unknown')
                && candidate.version && (!local || market().compareVersions(candidate.version, local.version) >= 0))
                .sort((a, b) => market().compareVersions(b.version, a.version));
            if (!unknown.length || unknown.length > 1 && market().compareVersions(unknown[0].version, unknown[1].version) === 0) return '';
            return unknown[0].candidateKey;
        };
        const rowHtml = row => {
            const localVersion = row.local?.version || '';
            const choices = groupCandidates(row.candidates, row.gameVersion, row.recommendedKey).map(group => `<optgroup label="${escape(group.label)}">${group.candidates.map(candidate => `<option value="${escape(candidate.candidateKey)}" ${candidate.candidateKey === row.selectedKey ? 'selected' : ''} ${matchesLocalVersion(candidate, localVersion) ? 'disabled' : ''}>${escape(candidateLabel(candidate, candidate.candidateKey === row.recommendedKey, localVersion))}</option>`).join('')}</optgroup>`).join('');
            return `<div class="modhub-version-batch-row"><label><strong class="gold">${escape(row.mod.name)}</strong><select class="modhub-version-batch-select" data-key="${escape(keyOf(row.mod))}" ${row.loading ? 'disabled' : ''}><option value="">${row.loading && !row.history ? '正在读取版本列表…' : row.error && !row.history ? '跳过：读取失败' : '请选择版本或跳过此项'}</option>${choices}</select></label><span class="grey">当前已安装模组版本：<strong class="gold">${escape(localVersion || (row.local ? '未识别' : '未安装'))}</strong></span><span class="grey">${escape(row.error || (row.loading ? row.history ? '正在加载更早版本，当前选择会保留。' : '读取完成后即可选择，也可以取消整个批次。' : row.selectedKey ? '下一步会核对所选安装包的适配说明；也可改版或留空跳过。' : '请自行选择版本，留空即可跳过。'))}</span>${row.history?.stale ? `<span class="gold">过期缓存，获取时间：${escape(row.history.fetchedAt || '未知')}，发布数据可能已变化。</span>` : ''}${sourceLink(row.mod.githubUrl, '作者主页')}${row.history?.hasMore || row.error ? `<button type="button" class="macro-button modhub-version-batch-more" data-key="${escape(keyOf(row.mod))}" ${loading ? 'disabled' : ''}>${row.error ? row.history ? '重试加载更早版本' : '重试版本列表' : '加载更早版本'}</button>` : ''}</div>`;
        };
        const html = () => `<p class="grey">当前游戏版本：<strong class="gold">${versions().getGameVersion() ? `DoL ${escape(versions().getGameVersion())}` : '未识别'}</strong>。按作者声明或安装包名称分类，不代表已核验适配。</p><div class="modhub-version-status grey" role="status" aria-live="polite">已读取 ${rows.filter(row => row.history || !row.loading).length} / ${rows.length} 项${rows.some(row => row.loading) ? '，正在读取版本列表…' : '，请选择版本或跳过。'}</div>${rows.map(rowHtml).join('')}`;
        try {
            const choice = await window.modHubConfirm({
            title: updateOnly ? '选择全部更新版本' : '选择批量安装版本', message: '请选择各模组版本，留空的项目会跳过。',
            trustedMessageHtml: `<div class="modhub-version-list" id="modHubBatchVersionChoices">${html()}</div>`,
            dialogClass: 'modhub-install-dialog modhub-version-dialog', confirmText: '查看安装计划', cancelText: '取消',
            canConfirm: () => !loading && rows.some(canSelect),
            onRender: dialog => {
                const area = dialog.querySelector('#modHubBatchVersionChoices');
                const render = () => {
                    if (closed) return;
                    area.innerHTML = html(); dialog.modHubSyncConfirmState?.();
                    area.querySelectorAll('.modhub-version-batch-select').forEach(select => {
                        select.onchange = () => { const row = rows.find(item => keyOf(item.mod) === select.dataset.key); if (row) { row.selectedKey = select.value; row.manual = true; } dialog.modHubSyncConfirmState?.(); };
                    });
                    area.querySelectorAll('.modhub-version-batch-more').forEach(button => {
                        button.onclick = async () => {
                            if (loading || closed) return;
                            const row = rows.find(item => keyOf(item.mod) === button.dataset.key);
                            if (row) await loadRow(row);
                        };
                    });
                };
                const loadRow = async row => {
                    const initial = !row.history;
                    row.loading = true; row.error = ''; loading = true; render();
                    try {
                        const local = getLocal(row.mod);
                        const history = await versions().fetchReleases(row.mod, { page: initial ? 1 : row.history.page + 1, signal: controller.signal });
                        if (closed) return;
                        const merged = new Map([...row.candidates, ...versions().buildCandidates(row.mod, history)].map(candidate => [candidate.candidateKey, candidate]));
                        const choices = versions().rankCandidates(row.mod, [...merged.values()], { updateOnly, localVersion: local?.version || '' });
                        const selectedKey = initial && !row.manual ? defaultKey(choices, local) : row.selectedKey;
                        const staleHistory = row.history?.stale ? row.history : history;
                        Object.assign(row, choices, { local, selectedKey, defaultKey: initial && !row.manual ? selectedKey : row.defaultKey, history: { ...history,
                            stale: Boolean(row.history?.stale || history.stale), fetchedAt: staleHistory.fetchedAt } });
                    } catch (error) { if (!closed) row.error = error.message || '读取发布版本失败'; }
                    finally { row.loading = false; loading = rows.some(item => item.loading); if (!closed) render(); }
                };
                render();
                return (async () => {
                    for (const row of rows) {
                        if (closed || stopped()) break;
                        await loadRow(row);
                    }
                    loading = false; render();
                })();
            },
            customResult: () => rows.filter(canSelect).map(row => ({ mod: row.mod,
                release: row.candidates.find(candidate => candidate.candidateKey === row.selectedKey),
                manual: Boolean(row.manual || row.selectedKey !== row.defaultKey) }))
        });
        return Array.isArray(choice) ? choice.filter(item => item.release && !matchesLocalVersion(item.release, getLocal(item.mod)?.version)) : [];
        } finally { closed = true; controller.abort(); }
    }

    function declaredDependencies(node) {
        return Array.isArray(node.release?.dependencies) ? node.release.dependencies
            .filter(item => !MODHUB_SPECIAL_DEPENDENCIES.has(normalize(item.bootName || item.id)))
            .map(item => ({ ...item, source: '历史版本记录', declaredBy: node.mod.name })) : [];
    }

    function bootDependencies(node) {
        const provided = node.prepared?.boots || (node.local && !node.release ? [localBoot(node.local)] : []);
        const result = node.release ? declaredDependencies(node) : [];
        for (const boot of provided) {
            for (const dependency of Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []) {
                const name = typeof dependency?.modName === 'string' ? dependency.modName.trim() : '';
                if (!name || MODHUB_SPECIAL_DEPENDENCIES.has(normalize(name))) continue;
                const requirement = { bootName: name, version: dependency.version || '*', source: '安装包声明', declaredBy: boot.name };
                const providers = provided.filter(item => getDependencyBootNames(item).some(bootName => normalize(bootName) === normalize(name)));
                if (providers.length > 1) throw new Error(`包内前置【${name}】存在多个提供者，请使用作者明确的安装包组合。`);
                const internal = providers[0];
                if (internal) {
                    if (!satisfies(internal, requirement)) throw new Error(`包内前置【${name}】不满足版本要求：${rangeText(requirement.version)}`);
                    continue;
                }
                result.push(requirement);
            }
        }
        return result;
    }

    function resolveDependency(requirement, catalog, profiles) {
        if (requirement.id) {
            const mod = catalog.find(item => [item.id, item.identityId].some(id => normalize(id) === normalize(requirement.id)));
            return mod ? { mod, local: getLocal(mod) } : null;
        }
        const locals = profiles.filter(profile => getDependencyBootNames(localBoot(profile))
            .some(name => normalize(name) === normalize(requirement.bootName)));
        // 原生别名可能被多个模块同时声明；不能由缓存顺序替玩家决定提供方。
        if (locals.length > 1) return null;
        if (locals.length === 1) {
            const local = locals[0], canonicalName = localBoot(local).name || local.name;
            const owners = catalog.filter(item => (item.bootNames || []).some(name => normalize(name) === normalize(canonicalName)));
            if (owners.length > 1) return null;
            return { mod: owners[0] || { id: `boot:${normalize(canonicalName)}`, name: canonicalName, bootNames: [canonicalName] }, local };
        }
        const matches = catalog.filter(item => (item.bootNames || []).some(name => normalize(name) === normalize(requirement.bootName)));
        if (matches.length === 1) return { mod: matches[0], local: getLocal(matches[0]) };
        return null;
    }

    async function preparePlan(selections, updateOnly, { download = true, initialPlan = null } = {}) {
        const api = market(), catalog = api.getMarketMods();
        const nodes = new Map(), roots = new Set(), queue = [];
        let bytes = 0;
        const budget = api.MAX_DOWNLOAD_BYTES || 256 * 1024 * 1024;
        const addNode = (mod, selection = null) => {
            const key = keyOf(mod);
            const previous = initialPlan?.nodes.get(key);
            selection = previous || selection;
            if (!nodes.has(key)) nodes.set(key, { key, mod, local: getLocal(mod), release: selection?.release || null,
                manual: Boolean(selection?.manual), requirements: [], dependencies: new Set(), issue: '', prepared: null,
                skipped: Boolean(selection?.skipped), planned: false, plannedVersion: '', unresolved: [],
                localSnapshot: previous?.localSnapshot,
                expandedLocal: false, attempts: new Set(), lastBoot: null, recoverableIssue: false, forceReselect: false });
            return nodes.get(key);
        };
        for (const selection of selections) {
            const node = addNode(selection.mod, selection); roots.add(node.key); queue.push(node);
        }
        const viableNodes = () => {
            const active = new Set();
            const collect = (key, seen = new Set()) => {
                if (seen.has(key)) return seen;
                seen.add(key);
                for (const dependency of nodes.get(key).dependencies) collect(dependency, seen);
                return seen;
            };
            for (const root of roots) {
                const reachable = collect(root);
                if (![...reachable].some(key => nodes.get(key).issue)) reachable.forEach(key => active.add(key));
            }
            return active;
        };
        const releaseNode = node => {
            if (node.prepared) { bytes -= Number(node.prepared.bytes) || 0; node.wasReleased = true; }
            window.modHubClearMarketPreparationProgress?.(node.mod.name);
            node.prepared = null;
        };
        const clearDependencies = node => {
            node.dependencies.clear(); node.expandedLocal = false; node.unresolved = [];
            for (const dependent of nodes.values()) dependent.requirements = dependent.requirements.filter(requirement => requirement.parent !== node.key);
            const reachable = new Set();
            const collect = key => {
                if (reachable.has(key)) return;
                reachable.add(key); nodes.get(key).dependencies.forEach(collect);
            };
            roots.forEach(collect);
            for (const [key, orphan] of nodes) if (!reachable.has(key)) { releaseNode(orphan); nodes.delete(key); }
            for (const dependent of nodes.values()) dependent.requirements = dependent.requirements.filter(requirement => nodes.has(requirement.parent));
        };
        const expandDependencies = node => {
            for (const requirement of bootDependencies(node)) {
                const resolved = resolveDependency(requirement, catalog, api.getLocalInstalledProfiles());
                if (!resolved) { node.unresolved.push(requirement); continue; }
                const dependency = addNode(resolved.mod);
                dependency.local = resolved.local;
                dependency.requirements.push({ ...requirement, parent: node.key }); node.dependencies.add(dependency.key);
                if ((!dependency.issue || dependency.recoverableIssue) && (dependency.planned
                    ? !requirement.bootVersions && !satisfiesRange(dependency.plannedVersion, requirement.version || '*')
                    : dependency.lastBoot && !satisfies(dependency.lastBoot, requirement))) {
                    dependency.forceReselect = true;
                }
                if (!dependency.issue || dependency.forceReselect) queue.push(dependency);
            }
        };
        const chooseUnresolved = async node => {
            if (!node.unresolved.length) return;
            const choice = await window.modHubConfirm({ title: '前置需要手动处理',
                message: `【${node.mod.name}】无法精确识别以下前置：\n${node.unresolved.map(item => `${item.bootName || item.id}：${rangeText(item.version)}`).join('\n')}\n\n可以跳过此前置，继续安装目标。缺少前置可能导致模组无法运行。`,
                selectOptions: [{ value: 'stop', label: '跳过依赖此前置的目标模组' }, { value: 'skip', label: '暂不安装此前置，保留目标模组' }],
                selectValue: 'stop', confirmText: '采用所选处理方式', cancelText: '取消'
            });
            if (choice !== 'skip') { node.issue = `无法精确识别前置【${node.unresolved.map(item => item.bootName || item.id).join('、')}】，已跳过目标。`; node.recoverableIssue = true; }
        };
        try {
            while (queue.length) {
                if (stopped()) throw new Error('已停止安装准备');
                const node = queue.shift();
                if (nodes.get(node.key) !== node || (node.issue && !node.forceReselect)) continue;
                if (node.skipped) continue;
                let pendingRequirements = null;
                if (node.forceReselect) {
                    pendingRequirements = node.requirements.slice();
                    releaseNode(node); clearDependencies(node); node.release = null;
                    node.issue = ''; node.recoverableIssue = false; node.forceReselect = false; node.planned = false; node.plannedVersion = '';
                }
                const active = viableNodes();
                for (const candidate of nodes.values()) if (!active.has(candidate.key) && candidate.prepared) {
                    releaseNode(candidate); candidate.attempts.clear();
                }
                for (const key of active) {
                    const candidate = nodes.get(key);
                    if (candidate !== node && candidate.wasReleased && !candidate.prepared && !candidate.issue && !queue.includes(candidate)) queue.push(candidate);
                }
                if (!active.has(node.key)) continue;
                node.requirements = node.requirements.filter(requirement => active.has(requirement.parent));
                try {
                    if (!roots.has(node.key) && !node.release && node.local && node.requirements.every(requirement => satisfies(localBoot(node.local), requirement))) {
                        if (node.prepared) { releaseNode(node); clearDependencies(node); node.release = null; }
                        if (!node.expandedLocal) { node.expandedLocal = true; node.lastBoot = { ...localBoot(node.local) }; expandDependencies(node); await chooseUnresolved(node); }
                        continue;
                    }
                    if (!download && node.planned) continue;
                    if (node.prepared && node.requirements.every(requirement => satisfies(node.prepared.boots[0], requirement))) continue;
                    const selectionRequirements = pendingRequirements || node.requirements.slice();
                    if (node.prepared || node.expandedLocal) {
                        releaseNode(node); clearDependencies(node); node.release = null;
                } else if (node.dependencies.size) clearDependencies(node);
                    if (!node.release) {
                        if (!node.mod.githubUrl) {
                            node.unresolved = [{ bootName: node.mod.name, version: selectionRequirements.map(item => item.version).filter(Boolean).join('&&') || '*' }];
                            await chooseUnresolved(node);
                            if (!node.issue) node.skipped = true;
                            continue;
                        }
                        const choice = await selectVersion(node.mod, { requirements: selectionRequirements.map(requirement => ({
                            ...requirement, targetName: nodes.get(requirement.parent)?.mod.name || ''
                        })), allowSkip: !roots.has(node.key), localBoot: localBoot(node.local), localVersion: node.local?.version || '' });
                        if (!choice) throw new Error('已取消前置版本选择');
                        if (choice.skipped) { node.skipped = true; continue; }
                        node.release = choice.release; node.manual = choice.manual;
                    }
                    if (matchesLocalVersion(node.release, node.local?.version)) {
                        node.issue = '当前所选版本已安装，无需重复安装'; continue;
                    }
                    const signature = JSON.stringify([node.release.candidateKey || node.release.selectedKey || node.release.tagName,
                        node.requirements.map(item => JSON.stringify([item.id || item.bootName, item.version || '*', item.bootVersions || null])).sort()]);
                    if (node.attempts.has(signature)) throw new Error(`前置【${node.mod.name}】选版无法稳定满足全部要求，请重新选择目标版本或拆分批次。`);
                    node.attempts.add(signature);
                    if (!download) { node.planned = true; node.plannedVersion = node.release.version; expandDependencies(node); await chooseUnresolved(node); continue; }
                    if (!initialPlan?.actions.some(action => action.key === node.key && downloadSignature(action.release) === downloadSignature(node.release))) {
                        const ok = await window.modHubConfirm({ title: '安装计划有变更',
                            message: `核对安装包后，需要新增下载或更换【${node.mod.name}】${node.release.version || node.release.tagName || '版本未知'}。\n${node.requirements.map(item => `【${nodes.get(item.parent)?.mod.name || item.declaredBy}】要求 ${item.bootName || node.mod.name}：${rangeText(item.version)}`).join('\n')}\n\n确认后才会下载此版本；取消不会导入任何模组。`,
                            confirmText: '确认并下载此版本', cancelText: '取消', dialogClass: 'modhub-install-dialog'
                        });
                        if (!ok || stopped()) throw Object.assign(new Error('已取消安装计划变更'), { code: 'INSTALL_CANCELLED' });
                    }
                    const assets = api.getReleaseInstallAssets(node.release);
                    const expected = assets.reduce((total, asset) => total + (Number(asset.size) || 0), 0);
                    if (bytes + expected > budget) throw Object.assign(new Error('本批安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
                    const prepared = await api.downloadAndInstallMod(node.mod, api.getCurrentMirrorId(), {
                        releaseInfo: node.release, prepareOnly: true, batchMode: true, maxPreparedBytes: budget - bytes,
                        onFailure: (reason, code) => { node.issue = reason; if (code === 'FILE_TOO_LARGE') node.budgetExceeded = true; }
                    });
                    if (node.budgetExceeded) throw Object.assign(new Error('本批安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
                    if (!prepared || !Array.isArray(prepared.boots)) throw new Error(node.issue || '安装包预检失败');
                    node.prepared = prepared; node.wasReleased = false; bytes += Number(prepared.bytes) || 0;
                    if (bytes > budget) throw Object.assign(new Error('本批安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
                    const boot = prepared.boots[0];
                    node.lastBoot = { ...boot };
                    if (node.local && api.compareVersions(boot?.version, node.local.version) < 0 && !node.manual) {
                        throw new Error('推荐包的真实版本低于本地版本，已停止自动降级；请自行选择历史版本。');
                    }
                    if (matchesLocalVersion(boot, node.local?.version)) {
                        node.issue = '安装包实际版本已安装，请选择其他版本'; continue;
                    }
                    expandDependencies(node);
                    await chooseUnresolved(node);
                    if (node.requirements.some(requirement => !satisfies(node.prepared.boots[0], requirement))) queue.push(node);
                } catch (error) {
                    if (error.code === 'PREPARE_BUDGET' || error.code === 'INSTALL_CANCELLED') throw error;
                    node.issue = error.message || '安装准备失败';
                    node.recoverableIssue = Boolean(node.prepared || node.expandedLocal);
                }
            }
            const viable = viableNodes();
            for (const node of nodes.values()) {
                if (!viable.has(node.key)) continue;
                node.requirements = node.requirements.filter(requirement => viable.has(requirement.parent));
                const boot = node.prepared?.boots[0] || localBoot(node.local);
                if (!node.skipped && node.requirements.some(requirement => !download && node.release
                    ? !requirement.bootVersions && !satisfiesRange(node.release.version, requirement.version || '*') : !satisfies(boot, requirement))) node.issue = `前置【${node.mod.name}】的最终版本不满足全部所选目标要求`;
            }
            const reachable = new Map(), visiting = [], visited = new Set(), order = [];
            const visit = (key, seen) => {
                if (visiting.includes(key)) {
                    visiting.slice(visiting.indexOf(key)).forEach(id => { nodes.get(id).issue = '检测到循环依赖'; }); return;
                }
                if (seen.has(key)) return;
                seen.add(key);
                visiting.push(key);
                for (const dependency of nodes.get(key).dependencies) visit(dependency, seen);
                visiting.pop();
                if (!visited.has(key)) { visited.add(key); order.push(key); }
            };
            for (const key of roots) { const seen = new Set(); visit(key, seen); reachable.set(key, seen); }
            const blocked = new Map(), needed = new Set();
            for (const [key, set] of reachable) {
                const issues = [...set].map(id => nodes.get(id).issue).filter(Boolean);
                if (issues.length) blocked.set(key, [...new Set(issues)].join('；'));
                else set.forEach(id => needed.add(id));
            }
            nodes.forEach(node => { if (node.localSnapshot === undefined) node.localSnapshot = bootSnapshot(localBoot(node.local)); });
            const actions = order.filter(key => needed.has(key)).map(key => {
                const node = nodes.get(key);
                const type = node.skipped ? '' : node.prepared || !download && node.release ? (node.local ? 'update' : 'install') : (node.local && isDisabled(node.local.name) ? 'enable' : '');
                return { ...node, type, role: roots.has(key) ? '目标模组' : '前置依赖', dependencyRequirements: node.requirements };
            }).filter(node => node.type);
            return { nodes, roots, reachable, blocked, actions, bytes, downloaded: download };
        } catch (error) { nodes.forEach(releaseNode); throw error; }
    }

    function releasePrepared(plan) {
        plan?.nodes.forEach(node => { window.modHubClearMarketPreparationProgress?.(node.mod.name); node.prepared = null; });
        for (const action of plan?.actions || []) action.prepared = null;
    }

    const actionBoots = action => action.prepared?.boots || (action.type === 'enable' && action.local ? [localBoot(action.local)] : []);
    const downloadSignature = release => JSON.stringify([release?.candidateKey || release?.tagName, release?.version,
        (release?.assets || []).map(asset => [asset.name, asset.downloadUrl, asset.digest, asset.size])]);

    function planSignature(plan) {
        return JSON.stringify([[...plan.actions].map(action => [action.key, action.type]).sort(), [...plan.nodes.values()].map(node => [node.key, node.skipped, node.issue,
            node.prepared?.boots[0]?.version || node.release?.version || localBoot(node.local)?.version,
            [...node.dependencies].sort(), node.requirements.map(item => [item.parent, item.id || item.bootName, item.version, item.bootVersions]).sort(),
            node.unresolved.map(item => [item.id || item.bootName, item.version]),
            (node.prepared?.boots || []).flatMap(boot => (boot.dependenceInfo || []).filter(item => MODHUB_SPECIAL_DEPENDENCIES.has(normalize(item.modName))))
        ]).sort()]);
    }

    function getConflictPlan(plan) {
        const keys = new Set();
        for (const [root, reachable] of plan.reachable) {
            if (!plan.blocked.has(root)) reachable.forEach(key => keys.add(key));
        }
        const actions = new Map(plan.actions.map(action => [action.key, action]));
        return { targetMod: null, actions: [...keys].filter(key => !plan.nodes.get(key).skipped || plan.nodes.get(key).local && !isDisabled(plan.nodes.get(key).local.name)).map(key => actions.get(key) || {
            ...plan.nodes.get(key), type: 'satisfied', role: '已有前置'
        }) };
    }

    function runtimeChecks(plan) {
        const checks = [];
        for (const action of plan.actions) {
            const requirements = [...(action.release?.dependencies || []).map(item => ({ modName: item.bootName || item.id, version: item.version })),
                ...actionBoots(action).flatMap(boot => boot.dependenceInfo || [])];
            for (const dependency of requirements.filter(item => ['modloader', 'sugarcube'].includes(normalize(item.modName)))) {
                const name = normalize(dependency.modName) === 'modloader' ? 'ModLoader' : 'SugarCube';
                let current = '', status = 'unknown';
                const range = String(dependency.version || '*');
                try {
                    const value = name === 'ModLoader'
                        ? window.modSC2DataManager?.getModUtils?.()?.version || window.modHubGetGui?.()?.gModUtils?.version || window.modUtils?.version
                        : window.SugarCube?.version;
                    current = typeof value === 'string' ? value : value?.toString?.() || '';
                    const api = window.modSC2DataManager?.getDependenceChecker?.()?.getInfiniteSemVerApi?.();
                    if (/^\d+(?:\.\d+)*(?:-[0-9a-z][0-9a-z.-]*)?(?:\+[0-9a-z][0-9a-z.-]*)?$/i.test(current)
                        && api?.parseVersion && api?.parseRange && api?.satisfies) {
                        if (range === '*') status = 'compatible';
                        else {
                            const clauses = range.split('||');
                            const supported = clauses.every(clause => {
                                const bounds = clause.trim().split('&&');
                                return bounds.length <= 2 && bounds.every(bound => /^(?:>=|<=|>|<|=|\^)?\d+(?:\.\d+)*(?:-[0-9a-z][0-9a-z.-]*)?(?:\+[0-9a-z][0-9a-z.-]*)?$/i.test(bound.trim()));
                            });
                            const parsedVersion = api.parseVersion(current)?.version, parsedRange = supported ? api.parseRange(range) : null;
                            if (parsedVersion?.version?.length && Array.isArray(parsedRange) && parsedRange.length === clauses.length) {
                                const result = api.satisfies(parsedVersion, parsedRange);
                                if (typeof result === 'boolean') status = result ? 'compatible' : 'incompatible';
                            }
                        }
                    }
                } catch (_) { status = 'unknown'; }
                checks.push({ name, current, range, status, modName: action.mod.name });
            }
        }
        return [...new Map(checks.map(check => [JSON.stringify(check), check])).values()];
    }

    function planHtml(plan, runtimes) {
        const api = market(), conflictPlan = getConflictPlan(plan);
        const conflicts = api.detectModInstallationConflicts?.(conflictPlan.targetMod, conflictPlan.actions) || [];
        const conflictHtml = api.formatConflictWarningHtml?.(conflicts, { allowDisable: false }) || '';
        const actionKeys = new Set(plan.actions.map(action => action.key));
        const actionHtml = action => {
            const boot = actionBoots(action)[0], version = boot?.version || action.release?.version || '未知版本';
            const operation = action.type === 'enable' ? '启用' : action.local && market().compareVersions(version, action.local.version) < 0 ? '降级' : action.type === 'update' ? '更换版本' : '安装';
            const gameRanges = actionBoots(action).flatMap(item => item.dependenceInfo || []).filter(item => normalize(item.modName) === 'gameversion');
            const assessment = gameRanges.map(item => versions().assessCompatibility(item.version));
            const status = assessment.some(item => item.status === 'incompatible') ? 'incompatible'
                : assessment.length && assessment.every(item => item.status === 'compatible') ? 'compatible' : 'unknown';
            const statusLabel = status === 'compatible' ? '作者标注支持当前游戏' : status === 'incompatible' ? '作者标注不支持当前游戏' : '是否支持当前游戏待确认';
            const existing = [...action.dependencies].filter(key => !actionKeys.has(key) && !plan.nodes.get(key).skipped).map(key => plan.nodes.get(key));
            const providerHtml = node => {
                const boot = localBoot(node.local);
                const aliases = [...new Set(node.requirements.filter(item => item.parent === action.key && item.bootName && normalize(item.bootName) !== normalize(boot?.name)).map(item => item.bootName))];
                return `<span class="modhub-version-asset-name grey">${escape(node.mod.name)} ${escape(boot?.version || '版本未知')}${(window._modHubModState?.builtInMods || []).some(name => normalize(name) === normalize(node.local?.name)) ? '（游戏内置）' : ''}</span>${aliases.length ? `<span class="modhub-version-description grey">作者要求【${escape(aliases.join('、'))}】；已由【${escape(node.mod.name)}】通过声明的兼容别名提供，无需重复安装。</span>` : ''}`;
            };
            return `<div class="modhub-install-plan-item"><div class="modhub-install-plan-heading"><strong>${escape(action.mod.name)}</strong><span class="gold">${escape(operation)} ${escape(version)}</span></div>
                ${action.local && action.type !== 'enable' ? `<div class="modhub-install-plan-meta">当前已安装：${escape(action.local.version)}</div>` : ''}
                <div class="modhub-version-heading"><span class="modhub-version-badge ${status === 'compatible' ? 'green' : status === 'incompatible' ? 'red' : 'grey'}">${statusLabel}</span><span class="modhub-install-plan-meta">${gameRanges.length ? `支持的游戏版本：DoL ${escape(gameRanges.map(item => rangeText(item.version)).join('；'))}` : plan.downloaded ? '作者没有注明支持哪些游戏版本，请查看作者说明。' : '尚未下载。下载后会检查支持的游戏版本和所需前置模组。'}</span></div>
                ${existing.length ? `<details class="modhub-version-assets" ${existing.some(node => node.requirements.some(item => item.bootName && normalize(item.bootName) !== normalize(localBoot(node.local)?.name))) ? 'open' : ''}><summary>已满足的前置（${existing.length} 项，无需下载）</summary>${existing.map(providerHtml).join('')}</details>` : ''}</div>`;
        };
        const targets = plan.actions.filter(action => plan.roots.has(action.key));
        const dependencies = plan.actions.filter(action => !plan.roots.has(action.key));
        const warnings = [...plan.blocked].map(([key, reason]) => `跳过【${plan.nodes.get(key).mod.name}】：${reason}`);
        for (const node of plan.nodes.values()) {
            if (node.skipped) warnings.push(`暂不安装前置【${node.mod.name}】${node.local ? `，保留本地 ${localBoot(node.local)?.version || '未知版本'}` : ''}；${node.requirements.map(item => `【${plan.nodes.get(item.parent)?.mod.name}】要求 ${item.bootName || node.mod.name}：${rangeText(item.version)}`).join('；')}。目标模组可能无法运行，需自行处理。`);
            if (!node.issue && node.unresolved.length) warnings.push(`【${node.mod.name}】未处理前置：${node.unresolved.map(item => item.bootName || item.id).join('、')}；目标模组可能无法运行，需自行处理。`);
        }
        return `<div class="modhub-install-plan">${conflictHtml}<strong class="gold">本次选择（${targets.length} 项）</strong>${targets.map(actionHtml).join('')}
            ${dependencies.length ? `<strong class="gold">需要处理的前置（${dependencies.length} 项）</strong>${dependencies.map(actionHtml).join('')}` : ''}
            ${runtimes.length ? `<details class="modhub-version-assets" ${runtimes.some(item => item.status !== 'compatible') ? 'open' : ''}><summary>运行环境：${runtimes.every(item => item.status === 'compatible') ? '已满足要求' : '需要确认'}</summary>${runtimes.map(item => `<div class="modhub-install-plan-meta">${escape(item.modName)}：${escape(item.name)} 当前 ${escape(item.current || '无法识别')}，要求 ${escape(rangeText(item.range))} <span class="${item.status === 'compatible' ? 'green' : item.status === 'incompatible' ? 'red' : 'gold'}">${item.status === 'compatible' ? '已满足' : item.status === 'incompatible' ? '不满足' : '无法自动核对，请确认满足要求'}</span></div>`).join('')}</details>` : ''}
            ${warnings.length ? `<div class="modhub-install-plan-warning">${warnings.map(warning => `<p>${escape(warning)}</p>`).join('')}</div>` : ''}
            <p class="grey">${plan.downloaded ? '安装包已下载，尚未安装。检查结果与之前的计划不同，请再次核对。确认后开始安装，取消则不安装。' : '目前还没有下载或安装。确认后开始下载，并检查游戏版本和前置模组；如有变化，会请你再次确认。'}</p></div>`;
    }

    async function confirmRisks(plan, runtimes, acknowledged = new Set()) {
        const api = market(), approved = [];
        const risks = [];
        for (const action of plan.actions) {
            const version = action.prepared?.boots[0]?.version || action.release?.version;
            if (action.local && version && api.compareVersions(version, action.local.version) < 0) risks.push(`【${action.mod.name}】将从 ${action.local.version} 降至 ${version || '未知版本'}`);
            if (action.release?.compatibility?.status === 'incompatible') risks.push(`【${action.mod.name}】作者声明不适配当前游戏`);
            if (action.release?.compatibility?.referenceMismatch) risks.push(`【${action.mod.name}】安装包名称标注的游戏版本与当前版本不同，请确认作者说明`);
            for (const risk of api.getPreparedCompatibilityRisks?.(actionBoots(action)) || []) {
                approved.push(risk.key);
                if (risk.status === 'incompatible') risks.push(`【${risk.name}】需要游戏版本：${rangeText(risk.range)}`);
            }
        }
        for (const runtime of runtimes.filter(item => item.status === 'incompatible')) risks.push(`【${runtime.modName}】要求 ${runtime.name}：${rangeText(runtime.range)}，当前 ${runtime.current} 不满足要求`);
        for (const node of plan.nodes.values()) {
            if (node.skipped) risks.push(`已跳过前置【${node.mod.name}】${node.local ? `，保留本地 ${localBoot(node.local)?.version || '未知版本'}` : ''}：${node.requirements.map(item => `【${plan.nodes.get(item.parent)?.mod.name}】要求 ${item.bootName || node.mod.name} ${rangeText(item.version)}`).join('；')}。目标模组可能无法运行，请自行处理`);
            if (!node.issue && node.unresolved.length) risks.push(`【${node.mod.name}】仍缺少前置 ${node.unresolved.map(item => `${item.bootName || item.id}：${rangeText(item.version)}`).join('；')}`);
        }
        const newRisks = [...new Set(risks)].filter(risk => !acknowledged.has(risk));
        if (newRisks.length) {
            const gameVersion = versions().getGameVersion();
            const affected = plan.actions.filter(action => [action.mod.name, ...actionBoots(action).map(boot => boot.name)]
                .some(name => name && newRisks.some(risk => risk.includes(`【${name}】`))));
            const context = `当前游戏版本：${gameVersion ? `DoL ${gameVersion}` : '未识别'}${affected.length ? '\n\n' : ''}` + affected.map(action => {
                const boots = actionBoots(action);
                const main = `【${action.mod.name}】\n当前已安装版本：${action.local ? localBoot(action.local)?.version || '未识别' : '未安装'}；所选模组版本：${boots[0]?.version || action.release?.version || '未识别'}`;
                const companions = boots.slice(1).filter(boot => newRisks.some(risk => risk.includes(`【${boot.name}】`))).map(boot => {
                    const local = api.getLocalInstalledProfiles().find(profile => normalize(profile.name) === normalize(boot.name));
                    return `【${boot.name}】\n当前已安装版本：${local ? localBoot(local)?.version || '未识别' : '未安装'}；所选模组版本：${boot.version || '未识别'}`;
                });
                return [main, ...companions].join('\n\n');
            }).join('\n\n');
            const details = `${context}\n\n${newRisks.join('\n')}`;
            const message = `${details}\n\n继续可能导致模组无法运行，是否仍安装所选版本？`;
            if (!await window.modHubConfirm({ title: '确认版本风险', message,
                trustedMessageHtml: `${api.formatVersionRiskMessage(details)}<br><br><strong class="red">继续可能导致模组无法运行</strong>，是否仍安装所选版本？`,
                confirmText: '仍然安装', cancelText: '取消', confirmType: 'danger' })) return null;
        }
        newRisks.forEach(risk => acknowledged.add(risk));
        return approved;
    }

    async function executePlan(plan, approved, restoreContext) {
        const api = market(), results = new Map(), changed = new Set();
        const installedBoots = new Map();
        for (const [key, reason] of plan.blocked) results.set(key, { status: 'skipped', reason });
        const failedDependency = (key, seen = new Set()) => {
            if (seen.has(key)) return false;
            seen.add(key);
            return [...plan.nodes.get(key).dependencies].some(id => (results.has(id) && results.get(id).status !== 'success') || failedDependency(id, seen));
        };
        const checkDependencies = (key, seen = new Set()) => {
            if (seen.has(key)) return;
            seen.add(key);
            const profiles = api.getLocalInstalledProfiles().map(profile => {
                const installed = [...installedBoots.values()].find(boot => normalize(boot.name) === normalize(profile.name));
                return installed ? { ...profile, bootJson: installed } : profile;
            });
            for (const dependency of plan.nodes.get(key).dependencies) {
                const node = plan.nodes.get(dependency), local = getLocal(node.mod);
                if (node.skipped) continue;
                const boot = installedBoots.get(dependency) || localBoot(local);
                if (!local || isDisabled(local.name) || !node.requirements.every(item => satisfies(boot, item))
                    || (!installedBoots.has(dependency) && bootSnapshot(boot) !== node.localSnapshot)) throw new Error(`前置【${node.mod.name}】状态已改变，请重新生成安装计划。`);
                for (const requirement of node.requirements.filter(item => item.bootName)) {
                    const resolved = resolveDependency(requirement, [], profiles);
                    if (!resolved || normalize(resolved.local.name) !== normalize(local.name)) throw new Error(`前置【${requirement.bootName}】提供方已改变或存在多个声明，请重新生成安装计划。`);
                }
                checkDependencies(dependency, seen);
            }
        };
        for (const [index, action] of plan.actions.entries()) {
            if (api.batchInstallState) Object.assign(api.batchInstallState, { current: action.mod.name, completed: index, total: plan.actions.length });
            api.renderBatchInstallToolbar?.();
            if (stopped() || restoreContext?.cancelled || failedDependency(action.key)) { results.set(action.key, { status: 'skipped', reason: stopped() || restoreContext?.cancelled ? '已停止后续安装' : '前置未完成' }); window.modHubClearMarketPreparationProgress?.(action.mod.name); continue; }
            try {
                await window.modHubLoadModManageState?.(true);
                if (bootSnapshot(localBoot(getLocal(action.mod))) !== action.localSnapshot) throw new Error('本地版本或依赖已改变，请重新核对安装计划。');
                checkDependencies(action.key);
                let changedByAction = false;
                if (action.type === 'enable') {
                    const currentBoot = localBoot(getLocal(action.mod));
                    if (!currentBoot || !action.requirements.every(item => satisfies(currentBoot, item))
                        || bootSnapshot(currentBoot) !== action.localSnapshot) throw new Error('前置版本或依赖已改变，请重新核对安装计划。');
                    const risks = api.getPreparedCompatibilityRisks?.([currentBoot]) || [];
                    if (risks.some(risk => !approved.includes(risk.key))) throw new Error('前置游戏适配声明已变化，请重新核对安装计划。');
                    if (isDisabled(action.local.name)) changedByAction = await window.modHubToggleSideMod?.(action.local.name, true, { silentOfferReload: true, restoreContext }) === true;
                    if (changedByAction) {
                        changed.add(action.mod.name);
                        window.modHubRegisterOperationReload(restoreContext, '所选前置已启用，重新载入后生效。',
                            { isFramework: window.modHubIsFrameworkMod?.(action.mod.name) });
                    }
                    await window.modHubLoadModManageState?.(true);
                    if (!getLocal(action.mod) || isDisabled(action.local.name)) throw new Error('前置未能实际启用');
                } else {
                    const ok = await api.downloadAndInstallMod(action.mod, api.getCurrentMirrorId(), {
                        releaseInfo: action.release, preparedPackage: action.prepared, askRestart: false, skipReloadOffer: true,
                        batchMode: true, dependencyRequirements: action.requirements, approvedCompatibilityRisks: approved,
                        restoreContext,
                        onFailure: reason => { action.failureReason = reason; }
                    });
                    if (!ok) throw new Error(action.failureReason || '安装未完成');
                    installedBoots.set(action.key, { ...action.prepared.boots[0] });
                    changed.add(action.mod.name);
                    window.modHubRegisterOperationReload(restoreContext, '所选模组及前置已处理，重新载入后生效。',
                        { isFramework: window.modHubIsFrameworkMod?.(action.mod.name) });
                    await window.modHubLoadModManageState?.(true);
                    const local = getLocal(action.mod);
                    if (local && isDisabled(local.name)) {
                        await window.modHubToggleSideMod?.(local.name, true, { silentOfferReload: true, restoreContext });
                        await window.modHubLoadModManageState?.(true);
                        if (isDisabled(local.name)) throw new Error('安装完成但前置未能启用');
                    }
                }
                results.set(action.key, { status: 'success' });
            } catch (error) { results.set(action.key, { status: 'failed', reason: error.message || '安装失败' }); }
            finally { window.modHubClearMarketPreparationProgress?.(action.mod.name); plan.nodes.get(action.key).prepared = null; action.prepared = null; }
        }
        return { results, changed };
    }

    async function run(selections, updateOnly, restoreContext) {
        let plan, initialPlan;
        const acknowledged = new Set();
        try {
            if (!selections.length || stopped()) return false;
            initialPlan = await preparePlan(selections, updateOnly, { download: false });
            plan = initialPlan;
            const lines = [...plan.blocked].map(([key, reason]) => `【${plan.nodes.get(key).mod.name}】跳过：${reason}`);
            if (!plan.actions.length) { await window.modHubAlert(lines.join('\n') || '没有需要安装的项目', '安装计划无法执行'); return false; }
            await window.modHubLoadModManageState?.(true);
            const runtimes = runtimeChecks(plan);
            const ok = await window.modHubConfirm({ title: '请确认安装计划', message: '请确认本次下载与安装内容。', trustedMessageHtml: planHtml(plan, runtimes), confirmText: '开始下载并安装', cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog' });
            if (!ok || stopped()) return false;
            let approved = await confirmRisks(plan, runtimes, acknowledged);
            if (approved === null || stopped()) return false;
            if (market().confirmInstallConflicts && !await market().confirmInstallConflicts(() => getConflictPlan(plan), { allowDisable: false })) return false;
            await window.modHubLoadModManageState?.(true);
            for (const node of plan.nodes.values()) {
                if (bootSnapshot(localBoot(getLocal(node.mod))) !== node.localSnapshot) throw new Error('本地模组或前置已改变，请重新生成安装计划。');
            }
            plan = await preparePlan(selections, updateOnly, { initialPlan });
            if (!plan.actions.length) { await window.modHubAlert([...plan.blocked].map(([key, reason]) => `【${plan.nodes.get(key).mod.name}】跳过：${reason}`).join('\n') || '没有需要安装的项目', '安装计划无法执行'); return false; }
            const actualRuntimes = runtimeChecks(plan);
            if (planSignature(plan) !== planSignature(initialPlan)) {
                const changed = await window.modHubConfirm({ title: '请再次核对安装计划', message: '下载后的检查结果与之前的计划不同，请再核对一次。', trustedMessageHtml: planHtml(plan, actualRuntimes), confirmText: '确认并安装', cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog' });
                if (!changed || stopped()) return false;
            }
            approved = await confirmRisks(plan, actualRuntimes, acknowledged);
            if (approved === null || stopped()) return false;
            if (market().confirmInstallConflicts && !await market().confirmInstallConflicts(() => getConflictPlan(plan), { allowDisable: false })) return false;
            const outcome = await executePlan(plan, approved, restoreContext);
            const success = [...outcome.results.values()].filter(result => result.status === 'success').length;
            const failed = [...outcome.results.values()].filter(result => result.status === 'failed').length;
            const skipped = [...outcome.results.values()].filter(result => result.status === 'skipped').length;
            for (const key of plan.roots) if (outcome.results.get(key)?.status === 'success') market().batchInstallState?.selected?.delete(key);
            market().renderMarketCards?.();
            const deferred = [...plan.nodes.values()].reduce((count, node) => count + (node.skipped ? 1 : 0) + (!node.issue ? node.unresolved.length : 0), 0);
            window.modHubShowToast(`安装处理完成：成功 ${success} 项，失败 ${failed} 项，跳过 ${skipped} 项${deferred ? `；暂未处理前置 ${deferred} 项` : ''}`, failed || deferred ? 'warning' : 'info');
            if (outcome.changed.size) window.modHubRegisterOperationReload(restoreContext, '所选模组及前置已处理，重新载入后生效。', { isFramework: [...outcome.changed].some(name => window.modHubIsFrameworkMod?.(name)) });
            return { ...outcome, changedMods: outcome.changed };
        } catch (error) { if (error.code !== 'INSTALL_CANCELLED') await window.modHubAlert(error.message || '安装准备失败', '安装未完成'); return false; }
        finally { releasePrepared(plan); if (initialPlan !== plan) releasePrepared(initialPlan); }
    }

    async function install(mod, { restoreContext } = {}) {
        if (!restoreContext) return market().runInstallTask(context => install(mod, { restoreContext: context }),
            { label: '市场安装及前置处理', names: [mod.name] });
        if (market().batchInstallState) market().batchInstallState.stopRequested = false;
        try {
            const choice = await selectVersion(mod, { localVersion: getLocal(mod)?.version || '' });
            if (!choice) return false;
            const outcome = await run([{ mod, ...choice }], false, restoreContext);
            return Boolean(outcome?.results?.get(keyOf(mod))?.status === 'success');
        } catch (error) { await window.modHubAlert(error.message || '发布版本读取失败', '无法选择版本'); return false; }
    }

    async function installBatch(targets, { updateOnly = false, restoreContext } = {}) {
        if (!restoreContext) return market().runInstallTask(context => installBatch(targets, { updateOnly, restoreContext: context }),
            { label: updateOnly ? '市场批量更新' : '市场批量安装', names: targets.map(mod => mod.name) });
        const state = market().batchInstallState;
        if (state) Object.assign(state, { running: true, stopRequested: false, current: '读取可选版本', completed: 0, total: targets.length });
        market().renderBatchInstallToolbar?.();
        try { return await run(await selectBatch(targets, updateOnly), updateOnly, restoreContext); }
        catch (error) { await window.modHubAlert(error.message || '批量安装准备失败', '安装未完成'); return false; }
        finally {
            if (state) Object.assign(state, { running: false, current: '', completed: state.total });
            market().renderBatchInstallToolbar?.(); market().renderMarketCards?.();
        }
    }

    window.modHubMarketInstaller = { install, installBatch, satisfiesDependency: satisfies, getDependencyBootNames };
})();
