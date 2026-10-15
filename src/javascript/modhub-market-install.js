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
    const bootSnapshot = boot => boot ? JSON.stringify([boot.name, boot.version, boot.edition || '', boot.alias || [], boot.dependenceInfo || []]) : '';
    const isDisabled = name => (window._modHubModState?.sideDisabled || []).some(item => normalize(item) === normalize(name))
        || (window._modHubModState?.sideMods || []).some(item => normalize(item.name) === normalize(name) && item.enabled === false);

    const historyFailure = error => versions().getHistoryErrorInfo?.(error) || {
        message: /[\u3400-\u9fff]/.test(error?.message || '') ? error.message : '版本列表读取失败，请稍后重试或查看作者主页',
        details: error?.message ? [`原始错误：${error.message}`] : []
    };
    const errorDetailsHtml = details => details?.length ? `<details class="modhub-version-error-details modhub-version-status grey"><summary>错误详情</summary><div>${details.map(escape).join('<br>')}</div></details>` : '';
    const sourceWarningsHtml = history => {
        const warnings = [...new Map((history?.sourceWarnings || []).map(warning => [warning.sourceUrl, warning])).values()];
        return warnings.length ? `<p class="gold">部分历史附件未通过核验，已从可安装列表排除；其他版本可继续选择。</p>${errorDetailsHtml(warnings.map(warning =>
            `${warning.tagName} · ${warning.assetName}：${warning.message}${warning.expectedDigest ? `\n登记摘要：${warning.expectedDigest}` : ''}${warning.actualDigest ? `\n当前摘要：${warning.actualDigest}` : ''}`))}` : '';
    };

    function getLocal(mod) {
        const profiles = market().getLocalInstalledProfiles();
        market().checkModInstallStatus(mod, profiles);
        const edition = (mod?.packageEditions || []).find(item => item.id === mod._selectedPackageEdition);
        if (edition) return profiles.find(profile => normalize(profile.name) === normalize(edition.bootName)) || null;
        return mod._matchedLocal || profiles.find(profile => (mod.bootNames || []).some(name => normalize(name) === normalize(profile.name))) || null;
    }

    function languageMembers(mod) {
        if (mod?.isLanguageGroup || mod?.isVariantGroup) return window.modHubMarketVariants?.getMembers?.(mod) || mod.variants || [];
        const variant = mod?.variant;
        if (!['language', 'edition'].includes(variant?.type) || !variant.groupId) return [mod].filter(Boolean);
        return market().getMarketMods().filter(member => member.variant?.type === variant.type
            && member.variant.groupId === variant.groupId);
    }

    /** 语言与真实包身份先明确选择，再读取对应成员的历史版本。 */
    async function selectLanguage(group, { eligibleOnly = false } = {}) {
        const members = languageMembers(group);
        const kind = members[0]?.variant?.type === 'edition' ? '版本' : '语言';
        const eligible = member => !eligibleOnly || (market().isBatchInstallEligible?.(member)
            ?? Boolean(member.githubUrl && member.autoInstall !== false && !getLocal(member)));
        const choices = members.map(member => {
            const local = getLocal(member);
            return { value: keyOf(member), label: `${member.variant?.label || member.name}${local
                ? ` · 已安装 ${localBoot(local)?.version || '版本未知'}${isDisabled(local.name) ? ' · 已禁用' : ''}` : ' · 未安装'}`,
            disabled: !eligible(member) };
        });
        const installed = members.filter(member => getLocal(member));
        const selected = await window.modHubConfirm({
            title: `选择【${group.name}】${kind}`,
            message: kind === '语言' ? `请先选择安装语言，再选择该语言的版本。${installed.length > 1 ? '\n已同时安装多种语言，请明确选择本次目标。' : ''}`
                : `请选择要安装的版本，再选择版本号。${installed.length > 1 ? '\n已安装多个版本，请选择本次要更新的版本。' : ''}`,
            selectOptions: [{ value: '', label: `请选择安装${kind}`, disabled: true }, ...choices], selectValue: '',
            selectLabel: `安装${kind}`, requireSelection: true,
            canConfirm: dialog => choices.some(choice => !choice.disabled && choice.value === dialog?.querySelector('.modhub-modal-select')?.value),
            confirmText: `选择此${kind}的版本`, cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog'
        });
        return members.find(member => keyOf(member) === selected && eligible(member)) || null;
    }

    async function confirmLanguageCoexistence(mod, acknowledged = new Set()) {
        if (mod?.variant?.type === 'edition') return true;
        if (getLocal(mod)) return true;
        // 撤回或删除的成员仅用于识别本地旧语言包，不能进入可安装语言选项。
        const members = market().getLanguageIdentityMembers?.(mod) || languageMembers(mod);
        const others = members.filter(member => keyOf(member) !== keyOf(mod)).map(member => ({ member, local: getLocal(member) }))
            .filter(item => item.local);
        if (!others.length) return true;
        const signature = JSON.stringify([keyOf(mod), others.map(({ member, local }) => [keyOf(member), bootSnapshot(localBoot(local))]).sort()]);
        if (acknowledged.has(signature)) return true;
        const ok = await window.modHubConfirm({ title: '确认保留其他语言包',
            message: `本次目标：${mod.variant?.label || mod.name}（${mod.name}）。\n已安装其他语言：${others.map(({ member, local }) => `${member.variant?.label || member.name}（${localBoot(local)?.name || local.name} ${localBoot(local)?.version || '版本未知'}${isDisabled(local.name) ? '，已禁用' : ''}）`).join('、')}。\n\n继续将同时保留两份语言包，可能产生功能冲突。若要切换语言，请取消后前往模组管理移除旧语言包，再重新安装。`,
            confirmText: '保留旧语言包并继续', cancelText: '取消', dialogClass: 'modhub-install-dialog' });
        if (ok) acknowledged.add(signature);
        return Boolean(ok);
    }

    const packageEditions = mod => window.modHubMarketVariants?.normalizePackageEditions?.(mod?.packageEditions) || mod?.packageEditions || [];

    async function selectPackageEdition(mod, { updateOnly = false } = {}) {
        const editions = packageEditions(mod);
        if (!editions.length) return mod;
        if (versions().getLegacyVerifiedRelease?.(mod)) return mod;
        const profiles = market().getLocalInstalledProfiles();
        const installed = profiles.map(profile => ({ profile, edition: window.modHubMarketVariants?.getPackageEdition?.(mod, profile) })).filter(item => item.edition);
        const inherited = [...new Set(installed.map(item => item.edition.id))];
        if (updateOnly && inherited.length === 1) return { ...mod, _selectedPackageEdition: inherited[0], _packageEditionUpdateOnly: true };
        const hasInstalledEdition = profiles.some(profile => editions.some(edition => normalize(edition.bootName) === normalize(profile.name)));
        if (editions.some(edition => edition.id === mod._selectedPackageEdition) && (!updateOnly || !hasInstalledEdition)) return mod;
        const selected = await window.modHubConfirm({ title: `选择【${mod.name}】安装版本`,
            message: '请选择要安装的版本。' + (editions.every(edition => edition.exclusive) ? '选择其他版本后，原版本将停用，安装包会保留。' : ''),
            selectOptions: [{ value: '', label: '请选择安装版本', disabled: true }, ...editions.map(edition => ({ value: edition.id,
                label: `${edition.label}${installed.some(item => item.edition.id === edition.id) ? ' · 已安装' : ''}` }))],
            selectValue: inherited.length === 1 ? inherited[0] : '', selectLabel: '安装版本', requireSelection: true,
            canConfirm: dialog => editions.some(edition => edition.id === dialog?.querySelector('.modhub-modal-select')?.value),
            confirmText: '查看可用版本', cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog'
        });
        return editions.some(edition => edition.id === selected) ? { ...mod, _selectedPackageEdition: selected, _packageEditionManual: true,
            ...(updateOnly ? { _packageEditionUpdateOnly: true } : {}) } : null;
    }

    function switchGroup(mod, release) {
        const edition = release?.packageEdition || packageEditions(mod).find(item => item.id === mod._selectedPackageEdition);
        const members = mod?.variant?.type === 'edition' ? market().getLanguageIdentityMembers?.(mod) || languageMembers(mod) : [];
        if (!members.length && !edition?.exclusive) return null;
        const targetName = edition?.bootName || release?.assets?.[0]?.bootName || mod.bootNames?.[0];
        const names = new Set((members.length ? members.flatMap(member => member.bootNames || []) : packageEditions(mod).map(item => item.bootName)).map(normalize));
        const snapshot = market().getLocalInstalledProfiles().filter(profile => names.has(normalize(profile.name)))
            .map(profile => ({ name: profile.name, enabled: !isDisabled(profile.name), version: localBoot(profile)?.version || profile.version || '' }));
        return targetName ? { targetName, disabledNames: snapshot.filter(item => item.enabled && normalize(item.name) !== normalize(targetName)).map(item => item.name), snapshot } : null;
    }

    const needsSwitch = group => Boolean(group && (group.disabledNames.length || group.snapshot.some(item => normalize(item.name) === normalize(group.targetName) && !item.enabled)));
    const releaseNeedsAction = (mod, release, local) => !releaseInstalled(release, local) || needsSwitch(switchGroup(mod, release));

    function checkExclusiveSelections(selections) {
        const groups = new Map();
        for (const { mod, release } of selections) {
            const edition = release?.packageEdition;
            const group = mod.variant?.type === 'edition' ? `variant:${mod.variant.groupId}` : edition?.exclusive ? `package:${keyOf(mod)}` : '';
            if (!group) continue;
            const target = mod.variant?.type === 'edition' ? mod.variant.id : edition.id;
            if (groups.has(group) && groups.get(group) !== target) throw new Error('同一互斥组不能同时选择多个类型，请保留一个目标后重试。');
            groups.set(group, target);
        }
    }

    function requiredDependencies(mod) {
        const result = [...(Array.isArray(mod?.requiredDependencies) ? mod.requiredDependencies : []), ...(market()?.getRequiredDependencies?.(mod) || [])].map(item => {
            const bootName = String(item?.modName || item?.bootName || '').trim();
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            return bootName || id ? { ...item, ...(bootName ? { bootName } : {}), ...(id ? { id } : {}),
                version: item.version || '*', required: true, source: item.source || '市场资料', declaredBy: mod.name } : null;
        }).filter(Boolean);
        return [...new Map(result.map(item => [JSON.stringify([item.id || '', item.bootName || '', item.version]), item])).values()];
    }

    function satisfies(boot, requirement) {
        if (!boot) return false;
        if (requirement.bootName && !getDependencyBootNames(boot).some(name => requirement.required
            ? name === requirement.bootName : normalize(name) === normalize(requirement.bootName))) return false;
        if (requirement.bootVersions) {
            const entry = Object.entries(requirement.bootVersions).find(([name]) => normalize(name) === normalize(boot.name));
            return Boolean(entry && satisfiesRange(boot.version, entry[1]));
        }
        return satisfiesRange(boot.version, requirement.version || '*');
    }

    /** 仅复用原生 boot.name 与 boot.alias，不能使用展示名或目录别名证明前置身份。 */
    function getDependencyBootNames(boot) {
        return [...new Set([boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])]
            .filter(name => typeof name === 'string' && name.trim()))];
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
    const releaseInstalled = (release, local) => {
        if (!release) return false;
        const profile = local?.packageDigest ? local : local && market().getLocalInstalledProfiles().find(item => normalize(item.name) === normalize(local.name)) || local;
        if (release.packageEdition) {
            const edition = window.modHubMarketVariants?.getPackageEdition?.({ packageEditions: release.packageEditions || [release.packageEdition] }, profile);
            if (!edition || edition.id !== release.packageEdition.id) return false;
        }
        const assets = release.assets || [];
        return assets.length ? assets.every((asset, index) => {
            const installed = index === 0 ? profile : componentLocal(asset);
            const component = { ...release, version: asset.version || release.version, assets: [asset] };
            return market().isReleaseInstalled?.(component, installed) ?? matchesLocalVersion(component, installed?.version);
        }) : market().isReleaseInstalled?.(release, profile) ?? matchesLocalVersion(release, profile?.version);
    };
    const preparedInstalled = (prepared, boot, profile) => boot?.edition && boot.edition !== localBoot(profile)?.edition ? false
        : market().isPreparedComponentInstalled?.(prepared, boot) ?? matchesLocalVersion(boot, profile?.version);
    const componentLocal = asset => asset?.bootName ? market().getLocalInstalledProfiles().find(profile => normalize(profile.name) === normalize(asset.bootName)) : null;
    const optionalInstalled = (asset, version) => releaseInstalled({ version: asset.version || version, assets: [asset] }, componentLocal(asset));
    const optionalKey = asset => normalize(asset.bootName) || asset.downloadUrl;
    function selectOptionalDefaults(candidate, selected, overrides) {
        selected.clear();
        for (const asset of candidate?.optionalAssets || []) {
            if (overrides.has(optionalKey(asset)) ? overrides.get(optionalKey(asset)) : Boolean(componentLocal(asset))) selected.add(asset.downloadUrl);
        }
    }
    const selectedRelease = (candidate, urls = new Set(), defaults = {}) => candidate && ({ ...candidate,
        assets: [...(candidate.assets || []), ...(candidate.optionalAssets || []).filter(asset => urls.has(asset.downloadUrl))],
        defaultReason: candidate.candidateKey === defaults.defaultKey ? defaults.defaultReason || '' : '',
        defaultRisk: candidate.candidateKey === defaults.defaultKey && Boolean(defaults.defaultRisk) });
    const assetSizeText = asset => Number(asset?.size) ? asset.size < 104858 ? '小于 0.1 MB' : `${(asset.size / 1048576).toFixed(1)} MB` : '大小未知';
    const roleText = asset => asset.label || ((asset.packageRole || market().getAssetRole?.(asset.name)) === 'audio' ? '音频扩展包' : asset.packageRole === 'resource' ? '附属资源包' : '主包');
    const assetsHtml = candidate => (candidate?.assets || []).map(asset => `<span class="modhub-version-asset-name grey"><strong class="gold">${escape(roleText(asset))}</strong>：${escape(asset.name)}<span class="modhub-version-meta">所选：${escape(asset.version || candidate.version || '版本未知')} · ${assetSizeText(asset)}</span></span>`).join('');
    const optionalHtml = (candidate, selected, enabled, key) => (candidate?.optionalAssets || []).map(asset => {
        const installed = optionalInstalled(asset, candidate.version), local = componentLocal(asset);
        return `<label class="modhub-version-optional"><input type="checkbox" class="modhub-version-optional-input" data-key="${escape(key)}" data-url="${escape(asset.downloadUrl)}" ${selected.has(asset.downloadUrl) ? 'checked' : ''} ${!enabled ? 'disabled' : ''}><span><strong class="purple">${escape(roleText(asset))}${installed ? ' · 已安装' : ' · 可选'}${local && isDisabled(local.name) ? ' · 保持禁用' : ''}</strong><span class="modhub-version-asset-name grey">${escape(asset.name)}</span><span class="modhub-version-meta grey">当前：${escape(local?.version || '未安装')} · 所选：${escape(asset.version || candidate.version || '版本未知')} · ${assetSizeText(asset)}</span></span></label>`;
    }).join('');

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
        const candidates = new Map();
        const sourceWarnings = new Map();
        const historyContext = market().getReleaseHistoryContext?.(mod);
        let history, staleHistory;
        do {
            const page = history ? Number(history.page) + 1 : 1;
            history = await versions().fetchReleases(mod, { page, signal: options.signal, useCache: historyContext?.useCache });
            if (history.page !== page) throw new Error('历史版本分页未能继续，请重试版本列表');
            if (history.stale && !staleHistory) staleHistory = history;
            (versions().getHistorySelectionWarnings?.(mod, history) || history.sourceWarnings || []).forEach(warning => sourceWarnings.set(warning.sourceUrl, warning));
            versions().buildCandidates(mod, { ...history, sourceWarnings: [...sourceWarnings.values()] }).forEach(candidate => candidates.set(candidate.candidateKey, candidate));
            const choices = { ...versions().rankCandidates(mod, [...candidates.values()], { ...options, sourceWarnings: [...sourceWarnings.values()] }), historyContext, history: { ...history,
                sourceWarnings: [...sourceWarnings.values()],
                stale: Boolean(staleHistory), fetchedAt: staleHistory?.fetchedAt || history.fetchedAt } };
            options.onProgress?.(choices);
            if (!history.hasMore) {
                market().rememberMarketCandidates?.(mod, choices.candidates, { context: historyContext });
                return choices;
            }
        } while (!options.signal?.aborted);
        throw Object.assign(new Error('已取消获取历史版本'), { name: 'AbortError' });
    }

    async function selectVersion(mod, options = {}) {
        const controller = new AbortController();
        let candidates = [], selectedKey = '', initialKey = '', manuallySelected = false;
        let defaults = {}, selectedOptional = new Set();
        const optionalOverrides = new Map();
        let closed = false, loading = true, slow = false, errorMessage = '', errorDetails = [], slowTimer;
        let history = null, historyContext, staleFetchedAt = '', gameVersion = versions().getGameVersion();
        const local = options.localBoot || getLocal(mod), localVersion = String(options.localVersion || local?.version || '');
        const selectedInstalled = () => {
            const candidate = candidates.find(item => item.candidateKey === selectedKey);
            return Boolean(candidate && !releaseNeedsAction(mod, selectedRelease(candidate, selectedOptional), local));
        };
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
            const status = versions().getCandidateStatus(candidate, { recommended: candidate.candidateKey === defaults.recommendedKey });
            return `<div class="modhub-version-option ${candidate.candidateKey === selectedKey ? 'modhub-version-selected' : ''}">
                <input type="radio" name="modHubMarketVersion" aria-label="选择版本 ${escape(candidate.version || candidate.tagName)}" value="${escape(candidate.candidateKey)}" ${candidate.candidateKey === selectedKey ? 'checked' : ''}>
                <span class="modhub-version-content"><span class="modhub-version-heading"><strong class="modhub-version-number gold">${escape(candidate.version || candidate.tagName || '版本未知')}</strong><span class="modhub-version-badge ${status.tone}">${escape(status.label)}</span>${matchesLocalVersion(candidate, localVersion) ? '<span class="modhub-version-badge gold">与已安装版本号相同</span>' : ''}</span>
                    <span class="modhub-version-meta grey">${escape(candidate.updateDate || '发布日期未知')} · ${Number(candidate.assetSize) ? (candidate.assetSize < 104858 ? '小于 0.1 MB' : `${(candidate.assetSize / 1048576).toFixed(1)} MB`) : '包体大小未知'}</span>
                    <span class="modhub-version-description">${escape(status.reason)}</span>
                    ${candidate.candidateKey === selectedKey && candidate.candidateKey === defaults.defaultKey && defaults.defaultReason ? `<span class="modhub-version-description ${defaults.defaultRisk ? 'gold' : 'grey'}">${escape(defaults.defaultReason)}</span>` : ''}
                    ${assetsHtml(candidate)}
                    ${optionalHtml(candidate, selectedOptional, candidate.candidateKey === selectedKey, candidate.candidateKey)}
                    ${sourceLink(candidate.htmlUrl, '发布说明')}
                </span></div>`;
        };
        const listHtml = () => `<div class="modhub-version-context"><strong class="gold">${escape(mod.name)}</strong><span class="grey">当前游戏版本：<strong class="gold">${gameVersion ? `DoL ${escape(gameVersion)}` : '未识别'}</strong></span><span class="grey">当前已安装模组版本：<strong class="gold">${escape(localVersion || (local ? '未识别' : '未安装'))}</strong></span></div>
            ${requires.length ? `<p class="modhub-install-plan-warning"><strong class="gold">需要前置版本：${escape(requires.map(requirementText).join('；'))}。</strong></p>` : ''}
            <p class="grey">请选择适合当前游戏的模组版本。${sourceLink(mod.githubUrl, '作者主页')}</p>
            ${localContext}
            ${requirementSources ? `<p class="grey">前置要求来源：<br>${requirementSources}</p>` : ''}
            ${loading ? `<div class="modhub-version-loading">${window.modHubLoadingHtml(candidates.length ? '正在读取更早版本…' : '正在读取版本列表…')}<span class="grey">${slow ? '发布服务响应较慢，请稍候；也可以取消后重试。' : '正在查找可用安装包并核对适配说明，可以随时取消。'}</span></div>` : ''}
            ${errorMessage ? `<div class="modhub-version-status" role="status"><p class="gold">${escape(errorMessage)}</p>${errorDetailsHtml(errorDetails)}${!history ? '<button type="button" class="macro-button modhub-version-retry">重试版本列表</button>' : ''}<span class="grey">也可以查看作者主页获取安装包。</span></div>` : ''}
            ${staleFetchedAt ? `<p class="gold">正在使用过期缓存，发布数据可能已变化。获取时间：${escape(staleFetchedAt)}。</p>` : ''}${sourceWarningsHtml(history)}
            <div class="modhub-version-list" role="radiogroup" aria-label="按游戏版本分类选择模组版本" tabindex="0">${options.allowSkip ? `<label class="modhub-version-option ${selectedKey === '__skip__' ? 'modhub-version-selected' : ''}"><input type="radio" name="modHubMarketVersion" value="__skip__" ${selectedKey === '__skip__' ? 'checked' : ''}><span class="modhub-version-content"><strong class="gold">暂不安装此前置</strong><span class="modhub-version-description">保留目标模组，前置由您自行处理。缺少前置或版本不符可能导致模组无法运行。</span></span></label>` : ''}${groupCandidates(candidates, gameVersion, initialKey).map(group => {
                const open = openGroups.has(group.key) ? openGroups.get(group.key) : group.preferred;
                return `<details class="modhub-version-group" data-group-key="${escape(group.key)}" ${open ? 'open' : ''}><summary class="modhub-version-group-summary" aria-expanded="${open}"><strong class="gold">${escape(group.label)}</strong><span class="grey">${group.candidates.length} 个版本</span></summary>${group.candidates.map(candidateHtml).join('')}</details>`;
            }).join('') || (!loading && !errorMessage ? '<p class="grey">没有找到可自动安装的发布包。</p>' : '')}</div>
            ${history?.hasMore ? `<button type="button" class="macro-button modhub-version-load-more" ${loading ? 'disabled' : ''}>${errorMessage ? '重试加载更早版本' : '加载更早版本'}</button>` : ''}`;
        try {
            const choice = await window.modHubConfirm({
                title: `选择【${mod.name}】版本`, message: '请选择要安装的版本。',
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
                        if (selectedKey && !loading && !selectionVisible(selectedKey)) { selectedKey = ''; manuallySelected = true; selectedOptional.clear(); }
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
                                    selectedKey = ''; manuallySelected = true; selectedOptional.clear();
                                    area.querySelectorAll('input[name="modHubMarketVersion"]').forEach(input => { input.checked = false; });
                                    area.querySelectorAll('.modhub-version-optional-input').forEach(input => { input.checked = false; input.disabled = true; });
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
                                selectOptionalDefaults(candidates.find(candidate => candidate.candidateKey === selectedKey), selectedOptional, optionalOverrides);
                                area.querySelectorAll('.modhub-version-option').forEach(label => label.classList.toggle('modhub-version-selected', label.querySelector('input')?.value === selectedKey));
                                render(); };
                        });
                        area.querySelectorAll('.modhub-version-optional-input').forEach(input => {
                            input.onchange = () => {
                                if (closed || input.isConnected === false || input.disabled || input.dataset.key !== selectedKey) return;
                                if (input.checked) selectedOptional.add(input.dataset.url); else selectedOptional.delete(input.dataset.url);
                                const asset = candidates.find(candidate => candidate.candidateKey === selectedKey)?.optionalAssets?.find(item => item.downloadUrl === input.dataset.url);
                                if (asset) optionalOverrides.set(optionalKey(asset), input.checked);
                                syncConfirm();
                            };
                        });
                        area.querySelectorAll('.modhub-version-option').forEach(card => {
                            card.onclick = event => {
                                const interactive = event.target?.closest?.('input, a, button, details, .modhub-version-optional');
                                if (interactive && card.contains(interactive)) return;
                                const radio = card.querySelector('input[type="radio"]');
                                if (radio && !radio.checked) { radio.checked = true; radio.onchange?.(); }
                            };
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
                        loading = true; slow = false; errorMessage = ''; errorDetails = []; render();
                        slowTimer = setTimeout(() => {
                            if (!closed && loading) { slow = true; const status = area.querySelector('.modhub-version-loading');
                                if (status) status.innerHTML = window.modHubLoadingHtml('发布服务响应较慢，请稍候；也可以取消后重试。'); }
                        }, 3000);
                        try {
                            if (first) {
                                const applyChoices = choices => {
                                    if (closed) return;
                                    candidates = choices.candidates; history = choices.history; historyContext = choices.historyContext; gameVersion = choices.gameVersion;
                                    defaults = requires.length ? versions().rankCandidates(mod, candidates.filter(candidateMeetsRequirements), options) : choices;
                                    if (!manuallySelected) {
                                        selectedKey = selectedKey === '__skip__' ? selectedKey : defaults.defaultKey ?? defaults.recommendedKey ?? '';
                                        selectOptionalDefaults(candidates.find(candidate => candidate.candidateKey === selectedKey), selectedOptional, optionalOverrides);
                                        initialKey = selectedKey;
                                        if (selectedKey) groupCandidates(candidates, gameVersion, selectedKey).filter(group => group.candidates.some(candidate => candidate.candidateKey === selectedKey)).forEach(group => openGroups.set(group.key, true));
                                    }
                                    render();
                                };
                                const choices = await loadChoices(mod, { ...options, localProfile: local, signal: controller.signal, onProgress: applyChoices });
                                if (closed) return;
                                candidates = choices.candidates; history = choices.history; gameVersion = choices.gameVersion;
                                if (!manuallySelected) {
                                    selectedKey = selectedKey === '__skip__' ? selectedKey : defaults.defaultKey ?? defaults.recommendedKey ?? '';
                                    if (selectedKey && selectedKey !== '__skip__' && !candidates.some(candidate => candidate.candidateKey === selectedKey && candidateMeetsRequirements(candidate))) selectedKey = '';
                                    if (selectedKey && selectedKey !== '__skip__' && options.localVersion && market().compareVersions(candidates.find(candidate => candidate.candidateKey === selectedKey)?.version, options.localVersion, mod) < 0) selectedKey = '';
                                    initialKey = selectedKey;
                                } else if (selectedKey !== '__skip__' && !candidates.some(candidate => candidate.candidateKey === selectedKey)) selectedKey = '';
                                selectOptionalDefaults(candidates.find(candidate => candidate.candidateKey === selectedKey), selectedOptional, optionalOverrides);
                            } else {
                                const page = await versions().fetchReleases(mod, { page: history.nextPage || Number(history.page || 1) + 1, signal: controller.signal, useCache: historyContext?.useCache });
                                if (closed) return;
                                history = { ...page, sourceWarnings: [...(history?.sourceWarnings || []), ...(versions().getHistorySelectionWarnings?.(mod, page) || page.sourceWarnings || [])] };
                                const joined = [...new Map([...candidates, ...versions().buildCandidates(mod, history)].map(candidate => [candidate.candidateKey, candidate])).values()];
                                candidates = versions().rankCandidates(mod, joined, { ...options, sourceWarnings: history.sourceWarnings }).candidates;
                                if (!history.hasMore) market().rememberMarketCandidates?.(mod, candidates, { context: historyContext });
                            }
                            if (history.stale) staleFetchedAt = history.fetchedAt || '未知';
                        } catch (error) { if (!closed) { const failure = historyFailure(error); errorMessage = `版本列表读取失败：${failure.message}`; errorDetails = failure.details; } }
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
            const selected = selectedRelease(release, selectedOptional, defaults);
            return selected && releaseNeedsAction(mod, selected, local) ? { release: selected, manual: typeof choice === 'object' ? choice.manual : true } : null;
        } finally { closed = true; controller.abort(); clearTimeout(slowTimer); }
    }

    async function selectBatch(targets, updateOnly) {
        const controller = new AbortController();
        const rows = targets.map(mod => ({ mod, local: getLocal(mod), candidates: [], selectedKey: '', defaultKey: '', recommendedKey: '', selectedOptional: new Set(), optionalOverrides: new Map(), loading: true }));
        let closed = false, checkingLocal = true, localError = '', localErrorDetails = [];
        const loading = () => checkingLocal || rows.some(row => row.loading);
        const canSelect = row => Boolean(row.selectedKey) && row.candidates.some(candidate => candidate.candidateKey === row.selectedKey && releaseNeedsAction(row.mod, selectedRelease(candidate, row.selectedOptional), row.local));
        const defaultKey = choices => choices.defaultKey ?? choices.recommendedKey ?? '';
        const rowHtml = row => {
            const localVersion = row.local?.version || '';
            const choices = groupCandidates(row.candidates, row.gameVersion, row.defaultKey).map(group => `<optgroup label="${escape(group.label)}">${group.candidates.map(candidate => `<option value="${escape(candidate.candidateKey)}" ${candidate.candidateKey === row.selectedKey ? 'selected' : ''} ${!releaseNeedsAction(row.mod, candidate, row.local) && !candidate.optionalAssets?.length ? 'disabled' : ''}>${escape(candidateLabel(candidate, candidate.candidateKey === row.recommendedKey, localVersion))}</option>`).join('')}</optgroup>`).join('');
            const selected = row.candidates.find(candidate => candidate.candidateKey === row.selectedKey);
            const components = assetsHtml(selected) + optionalHtml(selected, row.selectedOptional, !row.loading, keyOf(row.mod)) + sourceWarningsHtml(row.history);
            return `<div class="modhub-version-batch-row"><label><strong class="gold">${escape(row.mod.name)}</strong><select class="modhub-version-batch-select" data-key="${escape(keyOf(row.mod))}" ${checkingLocal || row.loading || localError ? 'disabled' : ''}><option value="">${checkingLocal || localError ? '等待核对完成' : row.loading && !row.history ? '正在读取版本列表…' : row.error && !row.history ? '跳过：读取失败' : '请选择版本或跳过此项'}</option>${choices}</select></label>${row.defaultReason && row.selectedKey === row.defaultKey ? `<span class="gold">${escape(row.defaultReason)}</span>` : ''}${components}<span class="grey">当前已安装模组版本：<strong class="gold">${escape(localVersion || (row.local ? '未识别' : '未安装'))}</strong></span>${!checkingLocal && !localError && (row.error || row.loading) ? `<span class="grey">${escape(row.error || (row.history ? '正在加载更早版本…' : '正在读取版本列表…'))}</span>` : ''}${errorDetailsHtml(row.errorDetails)}${row.history?.stale ? `<span class="gold">正在显示缓存版本。获取时间：${escape(row.history.fetchedAt || '未知')}。</span>` : ''}${sourceLink(row.mod.githubUrl, '作者主页')}${row.history?.hasMore || row.error ? `<button type="button" class="macro-button modhub-version-batch-more" data-key="${escape(keyOf(row.mod))}" ${row.loading ? 'disabled' : ''}>${row.error ? row.history ? '重试加载更早版本' : '重试版本列表' : '加载更早版本'}</button>` : ''}</div>`;
        };
        const html = () => {
            const status = checkingLocal ? '正在核对已安装模组…' : `已读取 ${rows.filter(row => row.history || !row.loading).length} / ${rows.length} 项${loading() ? '，正在读取版本列表…' : '，请选择版本或跳过。'}`;
            return `<p class="grey">当前游戏版本：<strong class="gold">${versions().getGameVersion() ? `DoL ${escape(versions().getGameVersion())}` : '未识别'}</strong></p><div class="modhub-version-status grey">${localError ? `<p class="red">${escape(localError)}</p>${errorDetailsHtml(localErrorDetails)}<button type="button" class="macro-button modhub-btn-secondary modhub-version-local-retry">重新核对</button>` : loading() ? window.modHubLoadingHtml(status) : `<span role="status" aria-live="polite">${status}</span>`}</div>${rows.map(rowHtml).join('')}`;
        };
        try {
            const choice = await window.modHubConfirm({
            title: updateOnly ? '选择全部更新版本' : '选择批量安装版本', message: '请选择各模组版本，留空的项目会跳过。',
            trustedMessageHtml: `<div class="modhub-version-list" id="modHubBatchVersionChoices">${html()}</div>`,
            dialogClass: 'modhub-install-dialog modhub-version-dialog', confirmText: '查看安装计划', cancelText: '取消',
            canConfirm: () => !localError && !loading() && rows.some(canSelect),
            onRender: dialog => {
                const area = dialog.querySelector('#modHubBatchVersionChoices');
                const queue = [];
                let active = 0;
                const render = () => {
                    if (closed) return;
                    const scroll = area.scrollTop || 0;
                    const focusKey = document.activeElement?.classList?.contains('modhub-version-batch-select') ? document.activeElement.dataset.key : '';
                    area.innerHTML = html(); dialog.modHubSyncConfirmState?.();
                    area.querySelectorAll('.modhub-version-batch-select').forEach(select => {
                        select.onchange = () => { const row = rows.find(item => keyOf(item.mod) === select.dataset.key); if (closed || select.isConnected === false || row?.loading) return; if (row) { row.selectedKey = select.value; row.manual = true; selectOptionalDefaults(row.candidates.find(candidate => candidate.candidateKey === row.selectedKey), row.selectedOptional, row.optionalOverrides); } render(); };
                    });
                    area.querySelectorAll('.modhub-version-optional-input').forEach(input => {
                        input.onchange = () => {
                            const row = rows.find(item => keyOf(item.mod) === input.dataset.key);
                            if (closed || input.isConnected === false || input.disabled || !row || row.loading) return;
                            if (input.checked) row.selectedOptional.add(input.dataset.url); else row.selectedOptional.delete(input.dataset.url);
                            const asset = row.candidates.find(candidate => candidate.candidateKey === row.selectedKey)?.optionalAssets?.find(item => item.downloadUrl === input.dataset.url);
                            if (asset) row.optionalOverrides.set(optionalKey(asset), input.checked);
                            dialog.modHubSyncConfirmState?.();
                        };
                    });
                    area.querySelectorAll('.modhub-version-batch-more').forEach(button => {
                        button.onclick = async () => {
                            if (closed || button.isConnected === false) return;
                            const row = rows.find(item => keyOf(item.mod) === button.dataset.key);
                            if (row && !row.loading) await loadRow(row);
                        };
                    });
                    const retryLocal = area.querySelector('.modhub-version-local-retry');
                    if (retryLocal) retryLocal.onclick = () => initialize();
                    area.scrollTop = scroll;
                    if (focusKey) [...area.querySelectorAll('.modhub-version-batch-select')].find(select => select.dataset.key === focusKey)?.focus({ preventScroll: true });
                };
                const readRow = async row => {
                    const initial = !row.history;
                    market().setBatchInstallStatus?.(row.mod.name, 'preparing', initial ? '正在读取可用版本' : '正在加载更早版本');
                    try {
                        const local = getLocal(row.mod);
                        if (initial) {
                            const applyChoices = choices => {
                                if (closed || controller.signal.aborted) return;
                                const selectedKey = !row.manual ? defaultKey(choices, local) : row.selectedKey;
                                Object.assign(row, choices, { local, selectedKey, history: choices.history });
                                selectOptionalDefaults(row.candidates.find(candidate => candidate.candidateKey === selectedKey), row.selectedOptional, row.optionalOverrides);
                                render();
                            };
                            await loadChoices(row.mod, { updateOnly, localVersion: local?.version || '', localProfile: local, signal: controller.signal, onProgress: applyChoices });
                            return;
                        }
                        const history = await versions().fetchReleases(row.mod, { page: row.history.page + 1, signal: controller.signal, useCache: row.historyContext?.useCache });
                        if (closed || controller.signal.aborted) return;
                        history.sourceWarnings = [...(row.history?.sourceWarnings || []), ...(versions().getHistorySelectionWarnings?.(row.mod, history) || history.sourceWarnings || [])];
                        const merged = new Map([...row.candidates, ...versions().buildCandidates(row.mod, history)].map(candidate => [candidate.candidateKey, candidate]));
                        const choices = versions().rankCandidates(row.mod, [...merged.values()], { updateOnly, localVersion: local?.version || '', localProfile: local,
                            sourceWarnings: history.sourceWarnings });
                        const selectedKey = initial && !row.manual ? defaultKey(choices, local) : row.selectedKey;
                        const staleHistory = row.history?.stale ? row.history : history;
                        Object.assign(row, choices, { local, selectedKey, defaultKey: initial && !row.manual ? selectedKey : row.defaultKey, history: { ...history,
                            stale: Boolean(row.history?.stale || history.stale), fetchedAt: staleHistory.fetchedAt,
                            sourceWarnings: history.sourceWarnings } });
                        selectOptionalDefaults(row.candidates.find(candidate => candidate.candidateKey === selectedKey), row.selectedOptional, row.optionalOverrides);
                        if (!history.hasMore) market().rememberMarketCandidates?.(row.mod, choices.candidates, { context: row.historyContext });
                    } catch (error) { if (!closed && !controller.signal.aborted) { const failure = historyFailure(error); row.error = failure.message; row.errorDetails = failure.details; } }
                    finally {
                        if (!closed && !controller.signal.aborted) market().setBatchInstallStatus?.(row.mod.name,
                            row.error && !row.history ? 'error' : 'waiting', row.error || '版本已就绪，等待选择');
                    }
                };
                // 初次读取、分页及逐行重试共用两路队列，其他已完成行仍可操作。
                const pump = () => {
                    if (closed || controller.signal.aborted) return;
                    if (stopped()) { controller.abort(); return; }
                    while (active < 2 && queue.length) {
                        const { row, resolve } = queue.shift();
                        active++;
                        readRow(row).finally(() => {
                            active--; row.pending = false; row.loading = false;
                            if (!closed) render();
                            resolve(); pump();
                        });
                    }
                };
                const loadRow = row => {
                    if (closed || controller.signal.aborted || row.pending) return Promise.resolve();
                    row.pending = true; row.loading = true; row.error = ''; row.errorDetails = [];
                    return new Promise(resolve => { queue.push({ row, resolve }); render(); pump(); });
                };
                controller.signal.addEventListener('abort', () => {
                    for (const { row, resolve } of queue.splice(0)) { row.pending = false; row.loading = false; resolve(); }
                }, { once: true });
                const initialize = async () => {
                    checkingLocal = true; localError = ''; localErrorDetails = []; render();
                    if (typeof window.requestAnimationFrame === 'function') await window.modHubYieldToBrowser();
                    if (closed || controller.signal.aborted) return;
                    try {
                        if (market().refreshLocalPackageProfiles) await market().refreshLocalPackageProfiles(undefined, () => !closed && !controller.signal.aborted && !stopped());
                        if (closed || controller.signal.aborted || stopped()) return;
                        rows.forEach(row => { row.local = getLocal(row.mod); });
                    } catch (error) {
                        if (!closed && !controller.signal.aborted) {
                            localError = '无法核对已安装模组，请重试。'; localErrorDetails = [error?.message || '本地安装包读取失败'];
                            rows.forEach(row => { row.loading = false; });
                        }
                    }
                    checkingLocal = false; render();
                    if (!localError && !closed && !controller.signal.aborted) return Promise.all(rows.map(loadRow));
                };
                return initialize();
            },
            customResult: () => rows.filter(canSelect).map(row => ({ mod: row.mod,
                release: selectedRelease(row.candidates.find(candidate => candidate.candidateKey === row.selectedKey), row.selectedOptional, row),
                manual: Boolean(row.manual || row.mod._packageEditionManual || row.selectedKey !== row.defaultKey) }))
        });
        return Array.isArray(choice) ? choice.filter(item => item.release && releaseNeedsAction(item.mod, item.release, getLocal(item.mod))) : [];
        } finally { closed = true; controller.abort(); }
    }

    function declaredDependencies(node) {
        return Array.isArray(node.release?.dependencies) ? node.release.dependencies
            .filter(item => !MODHUB_SPECIAL_DEPENDENCIES.has(normalize(item.bootName || item.id)))
            .map(item => ({ ...item, source: item.source || '历史版本记录', declaredBy: node.mod.name })) : [];
    }

    function bootDependencies(node) {
        const provided = node.effectiveBoots || node.prepared?.boots || (node.local && !node.release ? [localBoot(node.local)] : []);
        const result = [...requiredDependencies(node.mod), ...(node.release ? declaredDependencies(node) : [])].filter(requirement => {
            if (!requirement.required || !requirement.bootName) return true;
            const internal = provided.filter(boot => getDependencyBootNames(boot).includes(requirement.bootName));
            if (internal.length > 1) throw new Error(`包内前置【${requirement.bootName}】存在多个提供者，请使用作者明确的安装包组合。`);
            if (!internal.length) return true;
            if (!satisfies(internal[0], requirement)) throw new Error(`包内前置【${requirement.bootName}】不满足版本要求：${rangeText(requirement.version)}`);
            return false;
        });
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
        return [...new Map(result.map(item => [JSON.stringify([item.id || '', item.bootName || '', item.version || '*', item.bootVersions || null, Boolean(item.required)]), item])).values()];
    }

    function resolveDependency(requirement, catalog, profiles) {
        if (requirement.id && !(requirement.required && requirement.bootName)) {
            const mod = catalog.find(item => [item.id, item.identityId].some(id => normalize(id) === normalize(requirement.id)));
            return mod ? { mod, local: getLocal(mod) } : null;
        }
        let locals = profiles.filter(profile => getDependencyBootNames(localBoot(profile))
            .some(name => normalize(name) === normalize(requirement.bootName)));
        if (requirement.required && market().selectDependencyProvider) {
            const selected = market().selectDependencyProvider(profiles, requirement.bootName, true);
            locals = selected ? [selected] : [];
            if (!selected && profiles.some(profile => getDependencyBootNames(localBoot(profile)).some(name => normalize(name) === normalize(requirement.bootName)))) return null;
        }
        // 原生别名可能被多个模块同时声明；不能由缓存顺序替玩家决定提供方。
        if (locals.length > 1) return null;
        if (locals.length === 1) {
            const local = locals[0], canonicalName = localBoot(local).name || local.name;
            const owners = catalog.filter(item => (item.bootNames || []).some(name => requirement.required ? name === canonicalName : normalize(name) === normalize(canonicalName)));
            if (owners.length > 1) return null;
            return { mod: owners[0] || { id: `boot:${normalize(canonicalName)}`, name: canonicalName, bootNames: [canonicalName] }, local };
        }
        const matches = catalog.filter(item => (item.bootNames || []).some(name => requirement.required ? name === requirement.bootName : normalize(name) === normalize(requirement.bootName)));
        if (matches.length === 1) return { mod: matches[0], local: getLocal(matches[0]) };
        return null;
    }

    async function preparePlan(selections, updateOnly, { download = true, initialPlan = null } = {}) {
        const api = market(), catalog = api.getMarketMods();
        checkExclusiveSelections(selections);
        const nodes = new Map(), roots = new Set(), queue = [];
        let bytes = 0;
        const budget = api.MAX_DOWNLOAD_BYTES || 256 * 1024 * 1024;
        const addNode = (mod, selection = null) => {
            const key = keyOf(mod);
            api.trackBatchInstallMod?.(mod, selection ? '目标模组' : '前置模组');
            const previous = initialPlan?.nodes.get(key);
            selection = previous || selection;
            if (!nodes.has(key)) nodes.set(key, { key, mod, local: getLocal(mod), release: selection?.release || null,
                manual: Boolean(selection?.manual), requirements: [], dependencies: new Set(), issue: '', prepared: null,
                skipped: Boolean(selection?.skipped), planned: false, plannedVersion: '', unresolved: [],
                localSnapshot: previous?.localSnapshot,
                switchGroup: previous?.switchGroup || switchGroup(mod, selection?.release),
                requiredSnapshot: JSON.stringify(requiredDependencies(mod)),
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
            node.prepared = null; node.effectiveBoots = null;
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
                if (requirement.required && dependency.skipped) { dependency.skipped = false; dependency.forceReselect = true; }
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
            const required = node.unresolved.filter(item => item.required);
            if (required.length) {
                node.issue = `未找到或无法确认需要的前置模组【${required.map(item => item.bootName || item.id).join('、')}】。请先安装并启用此前置，再安装目标模组。`;
                node.recoverableIssue = true;
                return;
            }
            const choice = await window.modHubConfirm({ title: '前置需要手动处理',
                message: `【${node.mod.name}】无法精确识别以下前置：\n${node.unresolved.map(item => `${item.bootName || item.id}：${rangeText(item.version)}`).join('\n')}\n\n可以跳过此前置，继续安装目标。缺少前置可能导致模组无法运行。`,
                selectOptions: [{ value: 'stop', label: '跳过依赖此前置的目标模组' }, { value: 'skip', label: '暂不安装此前置，保留目标模组' }],
                selectValue: 'stop', confirmText: '采用所选处理方式', cancelText: '取消'
            });
            if (choice !== 'skip') { node.issue = `无法精确识别前置【${node.unresolved.map(item => item.bootName || item.id).join('、')}】，已跳过目标。`; node.recoverableIssue = true; }
        };
        try {
            while (queue.length) {
                if (stopped()) throw Object.assign(new Error('已停止安装准备'), { code: 'INSTALL_CANCELLED' });
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
                    if (node.prepared && node.requirements.every(requirement => satisfies(node.effectiveBoots?.[0] || node.prepared.boots[0], requirement))) continue;
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
                        const selectedMod = await selectPackageEdition(node.mod, { updateOnly: true });
                        if (!selectedMod) throw new Error('已取消前置类型选择');
                        node.mod = selectedMod;
                        const choice = await selectVersion(node.mod, { requirements: selectionRequirements.map(requirement => ({
                            ...requirement, targetName: nodes.get(requirement.parent)?.mod.name || ''
                        })), allowSkip: !roots.has(node.key) && !selectionRequirements.some(requirement => requirement.required), localBoot: localBoot(node.local), localVersion: node.local?.version || '', localProfile: node.local });
                        if (!choice) throw new Error('已取消前置版本选择');
                        if (choice.skipped) { node.skipped = true; continue; }
                        node.release = choice.release; node.manual = choice.manual;
                    }
                    node.switchGroup ||= switchGroup(node.mod, node.release);
                    if (!releaseNeedsAction(node.mod, node.release, node.local)) {
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
                    const profiles = api.getLocalInstalledProfiles();
                    node.effectiveBoots = prepared.boots.map(boot => {
                        const profile = profiles.find(item => normalize(item.name) === normalize(boot.name));
                        return preparedInstalled(prepared, boot, profile) ? localBoot(profile) : boot;
                    });
                    const boot = node.effectiveBoots[0];
                    node.lastBoot = { ...boot };
                    if (node.local && api.compareVersions(boot?.version, node.local.version, node.mod) < 0 && !node.manual) {
                        throw new Error('推荐包的真实版本低于本地版本，已停止自动降级；请自行选择历史版本。');
                    }
                    if (!needsSwitch(node.switchGroup) && prepared.boots.every(item => {
                        const profile = profiles.find(local => normalize(local.name) === normalize(item.name));
                        return preparedInstalled(prepared, item, profile);
                    })) {
                        node.issue = '安装包实际版本已安装，请选择其他版本'; continue;
                    }
                    expandDependencies(node);
                    await chooseUnresolved(node);
                    if (node.requirements.some(requirement => !satisfies(node.effectiveBoots?.[0] || node.prepared.boots[0], requirement))) queue.push(node);
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
                const boot = node.effectiveBoots?.[0] || node.prepared?.boots[0] || localBoot(node.local);
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
            const plan = { nodes, roots, reachable, blocked, actions, bytes, downloaded: download };
            api.setBatchInstallPlan?.(plan);
            return plan;
        } catch (error) { nodes.forEach(releaseNode); throw error; }
    }

    function releasePrepared(plan) {
        plan?.nodes.forEach(node => { window.modHubClearMarketPreparationProgress?.(node.mod.name); node.prepared = null; });
        for (const action of plan?.actions || []) action.prepared = null;
    }

    const actionBoots = action => action.effectiveBoots || action.prepared?.boots || (action.type === 'enable' && action.local ? [localBoot(action.local)] : []);
    const downloadSignature = release => JSON.stringify([release?.candidateKey || release?.tagName, release?.version,
        release?.packageEdition?.id, (release?.assets || []).map(asset => [asset.name, asset.downloadUrl, asset.digest, asset.size, asset.bootName, asset.version])]);

    function planSignature(plan) {
        return JSON.stringify([[...plan.actions].map(action => [action.key, action.type]).sort(), [...plan.nodes.values()].map(node => [node.key, node.skipped, node.issue,
            node.effectiveBoots?.[0]?.version || node.prepared?.boots[0]?.version || node.release?.version || localBoot(node.local)?.version, downloadSignature(node.release),
            [...node.dependencies].sort(), node.requirements.map(item => [item.parent, item.id || item.bootName, item.bootName, item.version, item.bootVersions, Boolean(item.required)]).sort(),
            requiredDependencies(node.mod).map(item => [item.id || item.bootName, item.bootName, item.version]),
            node.unresolved.map(item => [item.id || item.bootName, item.version, Boolean(item.required)]),
            node.switchGroup,
            (node.effectiveBoots || []).map(boot => [boot.name, boot.version, isDisabled(boot.name)]),
            (node.prepared?.boots || []).flatMap(boot => (boot.dependenceInfo || []).filter(item => MODHUB_SPECIAL_DEPENDENCIES.has(normalize(item.modName))))
        ]).sort()]);
    }

    function compatibilityLists(lists, order) {
        return { enabled: [...lists.enabled], disabled: [...lists.disabled], order: [...order] };
    }

    function advanceCompatibilityLists(lists, action, records, enableName) {
        const unique = names => [...new Map(names.map(name => [normalize(name), name])).values()];
        const enabledKeys = new Set(lists.enabled.map(normalize));
        let enabled, disabled;
        if (enableName) {
            enabledKeys.add(normalize(enableName));
            enabled = lists.order.filter(name => enabledKeys.has(normalize(name)));
            disabled = lists.disabled.filter(name => normalize(name) !== normalize(enableName));
        } else {
            const preserved = records.filter(item => !item.enabled).map(item => item.name);
            const stoppedNames = action.switchGroup?.disabledNames || [];
            const toDisable = new Set([...preserved, ...stoppedNames].map(normalize));
            enabled = unique([...lists.enabled.filter(name => !toDisable.has(normalize(name))),
                ...records.filter(item => item.imported && !toDisable.has(normalize(item.name))).map(item => item.name),
                ...(action.switchGroup?.targetName ? [action.switchGroup.targetName] : [])]);
            const nextEnabled = new Set(enabled.map(normalize));
            disabled = unique([...lists.disabled, ...stoppedNames, ...preserved]).filter(name => !nextEnabled.has(normalize(name)));
        }
        enabled = window.modHubKeepRecoveryOrder?.(enabled, records) || enabled;
        const all = new Set([...enabled, ...disabled].map(normalize)), active = new Set(enabled.map(normalize));
        const slots = unique([...lists.order.filter(name => all.has(normalize(name))), ...enabled, ...disabled]);
        let enabledIndex = 0, disabledIndex = 0;
        let order = slots.map(name => active.has(normalize(name)) ? enabled[enabledIndex++] : disabled[disabledIndex++]);
        if (enableName) {
            const protectedNames = new Set((window.modHubProtectedRecoveryNames?.() || []).map(normalize));
            const first = enabled.filter(name => protectedNames.has(normalize(name)));
            order = [...first, ...order.filter(name => !first.includes(name))];
        }
        return { enabled, disabled, order };
    }

    async function checkPlanCompatibility(plan) {
        const api = window.modHubCompatibility;
        if (!api?.check) return;
        const candidates = [], changes = new Map();
        const baseline = { enabled: [...(window._modHubModState?.sideEnabled || [])], disabled: [...(window._modHubModState?.sideDisabled || [])] };
        const order = window._modHubModState?.sideMods?.length ? window._modHubModState.sideMods.map(item => item.name) : [...baseline.enabled, ...baseline.disabled];
        let projected = compatibilityLists(baseline, order);
        for (const action of plan.actions) {
            const records = [];
            for (const [index, boot] of (action.prepared?.boots || actionBoots(action)).entries()) {
                const asset = action.release?.assets?.[index];
                const keepDisabled = Boolean(asset?.optional && isDisabled(boot.name));
                const installed = !action.prepared ? await window.modHubReadInstalledModPackage?.(boot.name) : null;
                const data = action.prepared?.files?.[index] || installed?.data;
                const profile = market().getLocalInstalledProfiles().find(item => normalize(item.name) === normalize(boot.name));
                const record = { name: boot.name, bootJson: boot, data, enabled: !keepDisabled,
                    imported: Boolean(action.prepared && !preparedInstalled(action.prepared, boot, profile)) };
                candidates.push(record); records.push(record);
            }
            changes.set(action.key, records);
            if (action.type !== 'enable') projected = advanceCompatibilityLists(projected, action, records);
            for (const record of records) if (record.enabled && projected.disabled.some(name => normalize(name) === normalize(record.name))) {
                projected = advanceCompatibilityLists(projected, action, records, record.name);
            }
        }
        const result = await api.check({ candidates, enabledNames: projected.enabled, disabledNames: projected.disabled, allowBusy: true });
        const checkedBaseline = result.compatibility?.baselineLists;
        if (result.stale || stopped() || checkedBaseline
            && JSON.stringify([baseline.enabled, baseline.disabled]) !== JSON.stringify([checkedBaseline.enabled, checkedBaseline.disabled])) {
            throw Object.assign(new Error(stopped() ? '已停止安装准备' : '检查期间配置或安装包已改变，请重新生成安装计划。'),
                { code: stopped() ? 'INSTALL_CANCELLED' : 'INSTALL_PLAN_CHANGED' });
        }
        plan.compatibilityResult = result;
        plan.compatibilitySignature = api.signature(result);
        plan.compatibilityChanges = changes;
        plan.compatibilityCompleted = new Map();
        plan.compatibilityIgnored = new Set();
        plan.compatibilityLists = compatibilityLists(result.compatibility?.baselineLists || baseline, order);
        plan.compatibilityHashes = new Map();
        for (const candidate of candidates) if (candidate.data) {
            plan.compatibilityHashes.set(normalize(candidate.name), await (api.hashPackage || window.modHubAiPackage.hash)(candidate.data));
        }
    }

    async function assertPlanCompatibility(plan) {
        if (!plan.compatibilityResult) return;
        const api = window.modHubCompatibility;
        if (!api?.assertCurrent || api.signature(plan.compatibilityResult) !== plan.compatibilitySignature
            || await api.assertCurrent(plan.compatibilityResult, { allowBusy: true, ignoreNames: [...plan.compatibilityIgnored],
                expectedLists: plan.compatibilityLists,
                expectedPackages: [...plan.compatibilityCompleted].map(([name, hash]) => ({ name, hash })) }) === false) {
            throw new Error('配置、安装包或检查结果已改变，请重新生成安装计划。');
        }
    }

    function recordCompatibilityChanges(plan, action) {
        if (!plan.compatibilityResult) return;
        for (const record of plan.compatibilityChanges.get(action.key) || []) {
            plan.compatibilityIgnored.add(record.name);
            const hash = plan.compatibilityHashes.get(normalize(record.name));
            if (hash) plan.compatibilityCompleted.set(record.name, hash);
        }
        for (const name of action.switchGroup?.disabledNames || []) {
            plan.compatibilityIgnored.add(name);
            const fingerprint = plan.compatibilityResult.compatibility?.fingerprints?.find(item => normalize(item.name) === normalize(name));
            if (fingerprint?.hash) plan.compatibilityCompleted.set(name, fingerprint.hash);
        }
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
        const api = market();
        const actionKeys = new Set(plan.actions.map(action => action.key));
        const actionHtml = action => {
            const boot = actionBoots(action)[0], version = boot?.version || action.release?.version || '未知版本';
            const operation = action.type === 'enable' ? '启用' : action.local && market().compareVersions(version, action.local.version, action.mod) < 0 ? '降级' : action.type === 'update' ? '更换版本' : '安装';
            const assets = action.release?.assets || [];
            const componentHtml = assets.map((asset, index) => {
                const component = actionBoots(action)[index];
                const profile = component ? api.getLocalInstalledProfiles().find(local => normalize(local.name) === normalize(component.name))
                    : index === 0 ? action.local : componentLocal(asset);
                const reuse = action.prepared ? preparedInstalled(action.prepared, component, profile) : releaseInstalled({ ...action.release, version: asset.version || action.release?.version, assets: [asset], ...(index ? { packageEdition: null } : {}) }, profile);
                const keepDisabled = Boolean(asset.optional && profile && isDisabled(profile.name));
                const state = reuse ? keepDisabled ? '保留同版，保持禁用' : profile && isDisabled(profile.name) ? '保留同版，启用' : '已安装，保留同版' : keepDisabled ? '更新，保持禁用' : profile ? '更新' : '安装';
                return `<span class="modhub-version-asset-name grey"><strong class="${asset.optional ? 'purple' : 'gold'}">${escape(roleText(asset))}</strong>：${escape(asset.name)}<span class="modhub-version-meta">当前：${escape(profile?.version || '未安装')} · 所选：${escape(component?.version || asset.version || action.release?.version || '版本未知')} · ${escape(state)} · ${assetSizeText(asset)}</span></span>`;
            }).join('');
            const gameRanges = actionBoots(action).flatMap(item => item.dependenceInfo || []).filter(item => normalize(item.modName) === 'gameversion');
            const assessment = gameRanges.map(item => versions().assessCompatibility(item.version));
            const status = assessment.some(item => item.status === 'incompatible') ? 'incompatible'
                : assessment.length && assessment.every(item => item.status === 'compatible') ? 'compatible' : 'unknown';
            const gameNote = status === 'compatible' ? '支持当前游戏版本。' : status === 'incompatible'
                ? '作者注明此版本不支持当前游戏，请更换版本。'
                : gameRanges.length ? '暂时无法确认是否支持当前游戏，请查看模组说明。'
                : plan.downloaded ? '作者未注明支持的游戏版本，请查看模组说明。' : '支持的游戏版本将在下载后检查。';
            const existing = [...action.dependencies].filter(key => !actionKeys.has(key) && !plan.nodes.get(key).skipped).map(key => plan.nodes.get(key));
            const providerHtml = node => {
                const boot = localBoot(node.local);
                const aliases = [...new Set(node.requirements.filter(item => item.parent === action.key && item.bootName && normalize(item.bootName) !== normalize(boot?.name)).map(item => item.bootName))];
                return `<span class="modhub-version-asset-name grey">${escape(node.mod.name)} ${escape(boot?.version || '版本未知')}${(window._modHubModState?.builtInMods || []).some(name => normalize(name) === normalize(node.local?.name)) ? '（游戏内置）' : ''}</span>${aliases.length ? `<span class="modhub-version-description grey">【${escape(node.mod.name)}】已提供所需的【${escape(aliases.join('、'))}】功能，无需另外安装。</span>` : ''}`;
            };
            return `<div class="modhub-install-plan-item"><div class="modhub-install-plan-heading"><div class="modhub-install-plan-identity"><svg class="modhub-install-plan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.25l9 4.5"/></svg><strong class="modhub-install-plan-name">${escape(action.mod.name)}</strong></div><span class="modhub-install-plan-operation gold">${escape(operation)} ${escape(version)}</span></div>
                ${action.local && action.type !== 'enable' ? `<div class="modhub-install-plan-meta">当前已安装：${escape(action.local.version)}</div>` : ''}
                <p class="modhub-install-plan-meta ${status === 'incompatible' ? 'red' : ''}">${gameNote}${gameRanges.length ? ` 支持范围：DoL ${escape(gameRanges.map(item => rangeText(item.version)).join('；'))}。` : ''}</p>
                ${assets.length ? `<details class="modhub-version-assets modhub-install-plan-files"><summary>查看安装包${assets.length > 1 ? `（${assets.length} 个）` : ''}</summary>${componentHtml}</details>` : ''}
                ${action.switchGroup?.disabledNames.length ? `<div class="modhub-install-plan-warning gold">安装成功后停用：${escape(action.switchGroup.disabledNames.join('、'))}。保留旧安装包，可在模组管理中重新选择。</div>` : ''}
                ${existing.length ? `<details class="modhub-version-assets modhub-install-plan-prerequisites"><summary><span class="green">前置模组已就绪（${existing.length} 项）</span></summary>${existing.map(providerHtml).join('')}</details>` : ''}</div>`;
        };
        const targets = plan.actions.filter(action => plan.roots.has(action.key));
        const dependencies = plan.actions.filter(action => !plan.roots.has(action.key));
        const warnings = [...plan.blocked].map(([key, reason]) => `跳过【${plan.nodes.get(key).mod.name}】：${reason}`);
        for (const node of plan.nodes.values()) {
            if (node.skipped) warnings.push(`暂不安装前置【${node.mod.name}】${node.local ? `，保留本地 ${localBoot(node.local)?.version || '未知版本'}` : ''}；${node.requirements.map(item => `【${plan.nodes.get(item.parent)?.mod.name}】要求 ${item.bootName || node.mod.name}：${rangeText(item.version)}`).join('；')}。目标模组可能无法运行，需自行处理。`);
            if (!node.issue && node.unresolved.length) warnings.push(`【${node.mod.name}】未处理前置：${node.unresolved.map(item => item.bootName || item.id).join('、')}；目标模组可能无法运行，需自行处理。`);
        }
        const runtimeProblems = runtimes.filter(item => item.status === 'incompatible').map(item => ({
            kind: 'configuration', status: 'problem', title: '加载器或运行库版本不符合要求', mods: [item.modName],
            evidence: `【${item.modName}】需要 ${item.name} ${rangeText(item.range)}，当前版本为 ${item.current}。`,
            advice: '请安装符合要求的加载器或运行库，或选择支持当前环境的模组版本。'
        }));
        const checked = plan.compatibilityResult;
        // 发布资料中的运行库要求也须出现在同一提醒内，不改动用于写入核验的检查结果。
        const preview = runtimeProblems.length ? { ...checked, compatibility: { ...checked?.compatibility, projected: true,
            findings: [...(checked?.compatibility?.findings || checked?.issues?.map(item => ({ ...item, kind: 'configuration' })) || []), ...runtimeProblems] } } : checked;
        const onlyEnable = plan.actions.every(action => action.type === 'enable');
        const compatibilityHtml = preview && window.modHubCompatibility?.render ? window.modHubCompatibility.render(preview, { compact: true })
            : runtimeProblems.length ? `<details class="modhub-install-plan-warning"><summary class="red">请注意：加载器或运行库版本不符合要求</summary>${runtimeProblems.map(item => `<p>${escape(item.evidence)}</p><p>${escape(item.advice)}</p>`).join('')}</details>`
            : `<p class="modhub-install-plan-meta">${plan.downloaded ? '尚未完成兼容性检查。您可以取消安装，稍后重试。' : onlyEnable ? '启用前会检查前置模组和兼容性。' : '下载后会自动检查前置模组和兼容性。'}</p>`;
        const requirements = plan.actions.flatMap(action => requiredDependencies(action.mod).map(item => {
            const name = api.getMarketMods().find(mod => (mod.bootNames || []).includes(item.bootName))?.name || item.bootName || item.id;
            return `<p>【${escape(action.mod.name)}】需要【${escape(name)}】${item.version && item.version !== '*' ? `，版本要求：${escape(rangeText(item.version))}` : ''}。${item.evidence ? `<span class="modhub-install-plan-meta">作者说明：${escape(item.evidence)}</span>` : ''}</p>`;
        }));
        return `<div class="modhub-install-plan">${compatibilityHtml}<p class="modhub-install-plan-intro">${onlyEnable ? '确认后将启用以下模组。' : plan.downloaded ? '安装文件已准备好。确认后开始安装。' : '确认后将下载并安装以下内容。'}</p>
            <strong class="modhub-install-plan-section-title">安装内容（${targets.length} 项）</strong>${targets.map(actionHtml).join('')}
            ${dependencies.length ? `<strong class="modhub-install-plan-section-title">同时安装或启用的前置（${dependencies.length} 项）</strong>${dependencies.map(actionHtml).join('')}` : ''}
            ${warnings.length ? `<div class="modhub-install-plan-warning">${warnings.map(warning => `<p>${escape(warning)}</p>`).join('')}</div>` : ''}
            ${runtimes.length || requirements.length ? `<details class="modhub-install-plan-details"><summary>查看安装详情</summary>
                ${requirements.length ? `<div class="modhub-install-plan-meta"><strong>前置要求</strong>${requirements.join('')}</div>` : ''}
                ${runtimes.length ? `<div class="modhub-install-plan-meta"><strong>加载器与运行库</strong>${runtimes.map(item => `<p>【${escape(item.modName)}】需要 ${escape(item.name)} ${escape(rangeText(item.range))}。当前版本：${escape(item.current || '无法识别')}；${item.status === 'compatible' ? '已满足要求' : item.status === 'incompatible' ? '不满足要求，请更换模组或加载器版本' : '暂时无法确认，请查看模组说明'}。</p>`).join('')}</div>` : ''}
            </details>` : ''}</div>`;
    }

    async function confirmRisks(plan, runtimes, acknowledged = new Set()) {
        const api = market(), approved = [];
        const risks = [];
        const addRisk = (name, reason, related = []) => risks.push({ name, reason, names: [name, ...related], key: `【${name}】${reason}` });
        for (const action of plan.actions) {
            const version = actionBoots(action)[0]?.version || action.release?.version;
            if (action.local && version && api.compareVersions(version, action.local.version, action.mod) < 0) addRisk(action.mod.name, `将从 ${action.local.version} 降至 ${version || '未知版本'}`);
            if (action.release?.compatibility?.status === 'incompatible') addRisk(action.mod.name, '作者注明此版本不支持当前游戏');
            if (action.release?.compatibility?.referenceMismatch) addRisk(action.mod.name, '安装包标注的游戏版本与当前版本不同，请查看作者说明');
            if (action.release?.defaultRisk) addRisk(action.mod.name, action.release.defaultReason || '已默认选择最新版本。支持的游戏版本尚未注明。');
            for (const risk of api.getPreparedCompatibilityRisks?.(actionBoots(action)) || []) {
                approved.push(risk.key);
                if (risk.status === 'incompatible') addRisk(risk.name, `需要游戏版本：${rangeText(risk.range)}`);
            }
        }
        for (const runtime of runtimes.filter(item => item.status === 'incompatible')) addRisk(runtime.modName, `需要 ${runtime.name} ${rangeText(runtime.range)}，当前为 ${runtime.current}`);
        for (const node of plan.nodes.values()) {
            if (node.skipped) addRisk(node.mod.name, `已跳过此前置${node.local ? `，保留本地 ${localBoot(node.local)?.version || '未知版本'}` : ''}。${node.requirements.map(item => `【${plan.nodes.get(item.parent)?.mod.name}】需要 ${item.bootName || node.mod.name} ${rangeText(item.version)}`).join('；')}。缺少符合要求的前置，相关模组可能无法运行`, node.requirements.map(item => plan.nodes.get(item.parent)?.mod.name).filter(Boolean));
            if (!node.issue && node.unresolved.length) addRisk(node.mod.name, `缺少前置：${node.unresolved.map(item => `${item.bootName || item.id} ${rangeText(item.version)}`).join('；')}`);
        }
        const newRisks = [...new Map(risks.map(risk => [risk.key, risk])).values()].filter(risk => !acknowledged.has(risk.key));
        if (newRisks.length) {
            const gameVersion = versions().getGameVersion();
            const affected = plan.actions.filter(action => [action.mod.name, ...actionBoots(action).map(boot => boot.name)]
                .some(name => name && newRisks.some(risk => risk.names.includes(name))));
            const context = `当前游戏版本：${gameVersion ? `DoL ${gameVersion}` : '未识别'}${affected.length ? '\n\n' : ''}` + affected.map(action => {
                const boots = actionBoots(action);
                const main = `【${action.mod.name}】\n当前已安装版本：${action.local ? localBoot(action.local)?.version || '未识别' : '未安装'}；所选模组版本：${boots[0]?.version || action.release?.version || '未识别'}`;
                const companions = boots.slice(1).filter(boot => newRisks.some(risk => risk.names.includes(boot.name))).map(boot => {
                    const local = api.getLocalInstalledProfiles().find(profile => normalize(profile.name) === normalize(boot.name));
                    return `【${boot.name}】\n当前已安装版本：${local ? localBoot(local)?.version || '未识别' : '未安装'}；所选模组版本：${boot.version || '未识别'}`;
                });
                return [main, ...companions].join('\n\n');
            }).join('\n\n');
            const groups = new Map();
            for (const risk of newRisks) {
                if (!groups.has(risk.reason)) groups.set(risk.reason, new Set());
                groups.get(risk.reason).add(risk.name);
            }
            const notices = [...groups].map(([reason, names]) => `${reason}\n涉及模组：${[...names].map(name => `【${name}】`).join('、')}`);
            const message = `${notices.join('\n\n')}\n\n${context}\n\n是否继续安装所选版本？`;
            if (!await window.modHubConfirm({ title: '确认版本风险', message,
                trustedMessageHtml: notices.map(notice => `<div class="modhub-install-plan-warning">${api.formatVersionRiskMessage(notice)}</div>`).join('')
                    + `<details class="modhub-version-error-details"><summary>查看版本详情</summary><div>${api.formatVersionRiskMessage(context)}</div></details><p>是否继续安装所选版本？</p>`,
                confirmText: '仍然安装', cancelText: '取消', confirmType: 'danger' })) return null;
        }
        newRisks.forEach(risk => acknowledged.add(risk.key));
        return approved;
    }

    async function executePlan(plan, approved, restoreContext, languageAcknowledged) {
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
                if (node.skipped) {
                    if (node.requirements.some(item => item.required)) throw new Error(`安装需要前置模组【${node.mod.name}】，不能跳过。请重新开始安装。`);
                    continue;
                }
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
            if (api.batchInstallState?.running) Object.assign(api.batchInstallState, { progressPhase: 'installing', current: action.mod.name, completed: index, total: plan.actions.length });
            api.renderBatchInstallToolbar?.();
            if (stopped() || restoreContext?.cancelled || failedDependency(action.key)) {
                const reason = stopped() || restoreContext?.cancelled ? '已停止，尚未安装' : '前置未完成，本次跳过';
                results.set(action.key, { status: 'skipped', reason });
                api.setBatchInstallStatus?.(action.mod.name, 'skipped', reason);
                window.modHubClearMarketPreparationProgress?.(action.mod.name); continue;
            }
            try {
                await assertPlanCompatibility(plan);
                await window.modHubLoadModManageState?.(true);
                await api.refreshLocalPackageProfiles?.();
                if (bootSnapshot(localBoot(getLocal(action.mod))) !== action.localSnapshot) throw new Error('本地版本或依赖已改变，请重新核对安装计划。');
                if (JSON.stringify(requiredDependencies(action.mod)) !== action.requiredSnapshot) throw new Error('模组的前置要求已更改，请重新确认要安装的内容。');
                checkDependencies(action.key);
                for (const requirement of requiredDependencies(action.mod)) {
                    const internal = actionBoots(action).filter(boot => getDependencyBootNames(boot).includes(requirement.bootName));
                    if (internal.length === 1 && satisfies(internal[0], requirement)) continue;
                    const resolved = resolveDependency(requirement, api.getMarketMods(), api.getLocalInstalledProfiles());
                    if (!resolved?.local || isDisabled(resolved.local.name) || !satisfies(localBoot(resolved.local), requirement)) {
                        throw new Error(`前置模组【${requirement.bootName || requirement.id}】尚未满足要求。请确认已安装并启用符合版本要求的前置，再重试。`);
                    }
                }
                if (!await confirmLanguageCoexistence(action.mod, languageAcknowledged)) throw Object.assign(new Error('已取消保留其他语言包'), { code: 'INSTALL_CANCELLED' });
                let changedByAction = false;
                if (action.type === 'enable') {
                    api.setBatchInstallStatus?.(action.mod.name, 'installing', '正在启用前置模组');
                    const nextLists = plan.compatibilityResult && advanceCompatibilityLists(plan.compatibilityLists, action,
                        plan.compatibilityChanges.get(action.key), action.local.name);
                    const currentBoot = localBoot(getLocal(action.mod));
                    if (!currentBoot || !action.requirements.every(item => satisfies(currentBoot, item))
                        || bootSnapshot(currentBoot) !== action.localSnapshot) throw new Error('前置版本或依赖已改变，请重新核对安装计划。');
                    const risks = api.getPreparedCompatibilityRisks?.([currentBoot]) || [];
                    if (risks.some(risk => !approved.includes(risk.key))) throw new Error('前置游戏适配声明已变化，请重新核对安装计划。');
                    if (isDisabled(action.local.name)) changedByAction = await window.modHubToggleSideMod?.(action.local.name, true, {
                        silentOfferReload: true, restoreContext, beforeSave: () => assertPlanCompatibility(plan) }) === true;
                    if (changedByAction) {
                        changed.add(action.mod.name);
                        window.modHubRegisterOperationReload(restoreContext, '所选前置已启用，重新载入后生效。',
                            { isFramework: window.modHubIsFrameworkMod?.(action.mod.name) });
                    }
                    await window.modHubLoadModManageState?.(true);
                    if (!getLocal(action.mod) || isDisabled(action.local.name)) throw new Error('前置未能实际启用');
                    if (nextLists) plan.compatibilityLists = nextLists;
                    recordCompatibilityChanges(plan, action);
                    await assertPlanCompatibility(plan);
                } else {
                    const nextLists = plan.compatibilityResult && advanceCompatibilityLists(plan.compatibilityLists, action,
                        plan.compatibilityChanges.get(action.key));
                    const preserveDisabledNames = (action.release?.assets || []).filter(asset => asset.optional && asset.bootName && isDisabled(asset.bootName)).map(asset => asset.bootName);
                    const atomicPackageChanges = preserveDisabledNames.length || action.switchGroup || action.release?.packageEdition
                        ? { preserveDisabledNames, ...(action.switchGroup ? { switchGroup: action.switchGroup } : {}) } : undefined;
                    const ok = await api.downloadAndInstallMod(action.mod, api.getCurrentMirrorId(), {
                        releaseInfo: action.release, preparedPackage: action.prepared, askRestart: false, skipReloadOffer: true,
                        batchMode: true, dependencyRequirements: action.requirements, approvedCompatibilityRisks: approved,
                        restoreContext,
                        beforeImport: () => assertPlanCompatibility(plan),
                        ...(atomicPackageChanges ? { atomicPackageChanges, preserveDisabledNames, switchGroup: action.switchGroup } : {}),
                        onFailure: (reason, code) => { action.failureReason = reason; action.failureCode = code; }
                    });
                    if (!ok) throw Object.assign(new Error(action.failureReason || '安装未完成'), { code: action.failureCode });
                    if (nextLists) plan.compatibilityLists = nextLists;
                    recordCompatibilityChanges(plan, action);
                    changed.add(action.mod.name);
                    window.modHubRegisterOperationReload(restoreContext, '所选模组及前置已处理，重新载入后生效。',
                        { isFramework: window.modHubIsFrameworkMod?.(action.mod.name) });
                    await assertPlanCompatibility(plan);
                    installedBoots.set(action.key, { ...actionBoots(action)[0] });
                    await window.modHubLoadModManageState?.(true);
                    for (const boot of actionBoots(action)) {
                        const local = api.getLocalInstalledProfiles().find(profile => normalize(profile.name) === normalize(boot.name));
                        if (preserveDisabledNames.some(name => normalize(name) === normalize(boot.name))) continue;
                        if (local && isDisabled(local.name)) {
                            const enabledLists = plan.compatibilityResult && advanceCompatibilityLists(plan.compatibilityLists, action,
                                plan.compatibilityChanges.get(action.key), local.name);
                            await window.modHubToggleSideMod?.(local.name, true, { silentOfferReload: true, restoreContext,
                                beforeSave: () => assertPlanCompatibility(plan) });
                            await window.modHubLoadModManageState?.(true);
                            if (isDisabled(local.name)) throw new Error(`安装完成但【${local.name}】未能启用`);
                            if (enabledLists) plan.compatibilityLists = enabledLists;
                            await assertPlanCompatibility(plan);
                        }
                    }
                }
                results.set(action.key, { status: 'success' });
                api.setBatchInstallStatus?.(action.mod.name, action.type === 'enable' ? 'enabled' : 'success',
                    action.type === 'enable' ? '已启用，重新载入后生效' : action.type === 'update' ? '已更新，重新载入后生效' : '已安装，重新载入后生效');
            } catch (error) {
                results.set(action.key, { status: 'failed', reason: error.message || '安装失败' });
                api.setBatchInstallStatus?.(action.mod.name, error.code === 'INSTALL_CANCELLED' ? 'cancelled' : 'error', error.message || '安装失败');
            }
            finally { window.modHubClearMarketPreparationProgress?.(action.mod.name); plan.nodes.get(action.key).prepared = null; action.prepared = null; }
        }
        return { results, changed };
    }

    async function run(selections, updateOnly, restoreContext, languageAcknowledged = new Set()) {
        let plan, initialPlan;
        const acknowledged = new Set();
        try {
            if (!selections.length || stopped()) return false;
            for (const selection of selections) if (!await confirmLanguageCoexistence(selection.mod, languageAcknowledged) || stopped()) return false;
            selections.forEach(({ mod }) => market().updateDownloadProgress?.(mod.name, null, '正在生成安装计划并核对前置要求，请稍候。', 'preparing'));
            initialPlan = await preparePlan(selections, updateOnly, { download: false });
            plan = initialPlan;
            const lines = [...plan.blocked].map(([key, reason]) => `【${plan.nodes.get(key).mod.name}】跳过：${reason}`);
            if (!plan.actions.length) { await window.modHubAlert(lines.join('\n') || '没有需要安装的项目', '安装计划无法执行'); return false; }
            selections.forEach(({ mod }) => market().updateDownloadProgress?.(mod.name, null, '正在核对本地模组状态，请稍候。', 'preparing'));
            await window.modHubLoadModManageState?.(true);
            const runtimes = runtimeChecks(plan);
            selections.forEach(({ mod }) => window.modHubClearMarketPreparationProgress?.(mod.name));
            const ok = await window.modHubConfirm({ title: '确认安装内容', message: '请确认要安装的模组。', trustedMessageHtml: planHtml(plan, runtimes), confirmText: plan.actions.every(action => action.type === 'enable') ? '启用模组' : '下载并安装', cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog' });
            if (!ok || stopped()) return false;
            let approved = await confirmRisks(plan, runtimes, acknowledged);
            if (approved === null || stopped()) return false;
            await window.modHubLoadModManageState?.(true);
            for (const node of plan.nodes.values()) {
                if (bootSnapshot(localBoot(getLocal(node.mod))) !== node.localSnapshot) throw new Error('本地模组或前置已改变，请重新生成安装计划。');
            }
            selections.forEach(({ mod }) => market().updateDownloadProgress?.(mod.name, null, '正在准备下载与包体核验，请稍候。', 'preparing'));
            plan = await preparePlan(selections, updateOnly, { initialPlan });
            if (!plan.actions.length) { await window.modHubAlert([...plan.blocked].map(([key, reason]) => `【${plan.nodes.get(key).mod.name}】跳过：${reason}`).join('\n') || '没有需要安装的项目', '安装计划无法执行'); return false; }
            const actualRuntimes = runtimeChecks(plan);
            await checkPlanCompatibility(plan);
            if (planSignature(plan) !== planSignature(initialPlan) || plan.compatibilityResult
                && plan.compatibilityResult.compatibility?.baselineSignature !== plan.compatibilitySignature) {
                const changed = await window.modHubConfirm({ title: '安装前请确认', message: '下载后的检查结果与之前的计划不同，请再核对一次。', trustedMessageHtml: planHtml(plan, actualRuntimes), confirmText: '确认并安装', cancelText: '取消', dialogClass: 'modhub-install-dialog modhub-version-dialog' });
                if (!changed || stopped()) return false;
            }
            approved = await confirmRisks(plan, actualRuntimes, acknowledged);
            if (approved === null || stopped()) return false;
            await assertPlanCompatibility(plan);
            const outcome = await executePlan(plan, approved, restoreContext, languageAcknowledged);
            const success = [...outcome.results.values()].filter(result => result.status === 'success').length;
            const failed = [...outcome.results.values()].filter(result => result.status === 'failed').length;
            const skipped = [...outcome.results.values()].filter(result => result.status === 'skipped').length;
            for (const key of plan.roots) if (outcome.results.get(key)?.status === 'success') market().batchInstallState?.selected?.delete(key);
            market().renderMarketCards?.();
            const deferred = [...plan.nodes.values()].reduce((count, node) => count + (node.skipped ? 1 : 0) + (!node.issue ? node.unresolved.length : 0), 0);
            window.modHubShowToast(`安装处理完成：成功 ${success} 项，失败 ${failed} 项，跳过 ${skipped} 项${deferred ? `；暂未处理前置 ${deferred} 项` : ''}`, failed || deferred ? 'warning' : 'info');
            if (outcome.changed.size) window.modHubRegisterOperationReload(restoreContext, '所选模组及前置已处理，重新载入后生效。', { isFramework: [...outcome.changed].some(name => window.modHubIsFrameworkMod?.(name)) });
            return { ...outcome, changedMods: outcome.changed };
        } catch (error) {
            if (error.code !== 'INSTALL_CANCELLED') {
                market().failBatchInstallProgress?.(error.message || '安装准备失败');
                await window.modHubAlert(error.message || '安装准备失败', '安装未完成');
            }
            return false;
        }
        finally {
            releasePrepared(plan); if (initialPlan !== plan) releasePrepared(initialPlan);
            selections.forEach(({ mod }) => window.modHubClearMarketPreparationProgress?.(mod.name));
        }
    }

    async function install(mod, { restoreContext } = {}) {
        if (!mod || mod.contentType === 'spell') return false;
        if (!restoreContext) return market().runInstallTask(context => install(mod, { restoreContext: context }),
            { label: '市场安装及前置处理', names: [mod.name] });
        const progressName = mod.name;
        if (market().batchInstallState) market().batchInstallState.stopRequested = false;
        try {
            market().updateDownloadProgress?.(progressName, null, '正在读取已安装模组信息，请稍候。', 'preparing');
            await market().refreshLocalPackageProfiles?.();
            window.modHubClearMarketPreparationProgress?.(progressName);
            mod = market().resolveDisplayedInstallMod?.(mod) || mod;
            if (mod.isLanguageGroup || mod.isVariantGroup) mod = await selectLanguage(mod);
            if (!mod) return false;
            mod = await selectPackageEdition(mod);
            if (!mod) return false;
            const languageAcknowledged = new Set();
            if (!await confirmLanguageCoexistence(mod, languageAcknowledged)) return false;
            const local = getLocal(mod);
            const choice = await selectVersion(mod, { localVersion: local?.version || '', localProfile: local });
            if (!choice) return false;
            choice.manual ||= Boolean(mod._packageEditionManual);
            const outcome = await run([{ mod, ...choice }], false, restoreContext, languageAcknowledged);
            return Boolean(outcome?.results?.get(keyOf(mod))?.status === 'success');
        } catch (error) { await window.modHubAlert(error.message || '发布版本读取失败', '无法选择版本'); return false; }
        finally { window.modHubClearMarketPreparationProgress?.(progressName); }
    }

    async function installBatch(targets, { updateOnly = false, restoreContext } = {}) {
        targets = (targets || []).filter(mod => mod && mod.contentType !== 'spell');
        if (!targets.length) return false;
        if (!restoreContext) return market().runInstallTask(context => installBatch(targets, { updateOnly, restoreContext: context }),
            { label: updateOnly ? '市场批量更新' : '市场批量安装', names: targets.map(mod => mod.name) });
        const state = market().batchInstallState;
        if (market().startBatchInstallProgress) market().startBatchInstallProgress(targets, updateOnly);
        else if (state) Object.assign(state, { running: true, stopRequested: false, progressPhase: 'preparing', current: '读取可选版本', completed: 0, total: targets.length });
        market().renderBatchInstallToolbar?.();
        try {
            const members = [];
            for (let target of targets) {
                if (stopped()) return false;
                if (!updateOnly) target = market().resolveDisplayedInstallMod?.(target) || target;
                if (target.isLanguageGroup || target.isVariantGroup) {
                    if (updateOnly) {
                        const installed = languageMembers(target).filter(member => getLocal(member));
                        if (target.isEditionGroup || target.variantType === 'edition') {
                            if (installed.length === 1) members.push(installed[0]);
                            else { const member = await selectLanguage(target); if (!member) return false; members.push(member); }
                        } else members.push(...installed);
                    }
                    else {
                        const member = await selectLanguage(target, { eligibleOnly: true });
                        if (!member) return false;
                        members.push(member);
                    }
                } else members.push(target);
            }
            const resolved = [];
            for (const member of members) { const mod = await selectPackageEdition(member, { updateOnly }); if (!mod) return false; resolved.push(mod); }
            const unique = [...new Map(resolved.map(member => [keyOf(member), member])).values()];
            if (stopped()) return false;
            market().startBatchInstallProgress?.(unique, updateOnly);
            const languageAcknowledged = new Set();
            for (const member of unique) if (!await confirmLanguageCoexistence(member, languageAcknowledged) || stopped()) return false;
            return await run(await selectBatch(unique, updateOnly), updateOnly, restoreContext, languageAcknowledged);
        }
        catch (error) {
            if (error.code !== 'INSTALL_CANCELLED') market().failBatchInstallProgress?.(error.message || '批量安装准备失败');
            await window.modHubAlert(error.message || '批量安装准备失败', '安装未完成'); return false;
        }
        finally {
            if (market().finishBatchInstallProgress) market().finishBatchInstallProgress();
            else if (state) Object.assign(state, { running: false, progressPhase: '', current: '' });
            market().renderBatchInstallToolbar?.(); market().renderMarketCards?.();
        }
    }

    window.modHubMarketInstaller = { install, installBatch, selectLanguage, satisfiesDependency: satisfies, getDependencyBootNames };
})();
