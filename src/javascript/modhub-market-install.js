/** ModHub - 市场版本选择、包体预检与依赖安装。 */
(function () {
    'use strict';

    const modHubHtml = html => window.modHubTranslateHtml ? window.modHubTranslateHtml(html) : html;
    const modHubText = (node, value) => { if (window.modHubBindText && node?.setAttribute && node?.getAttribute) window.modHubBindText(node, String(value ?? '')); else node.textContent = window.modHubT ? window.modHubT(value) : value; return value; };


    const MODHUB_SPECIAL_DEPENDENCIES = new Set(['gameversion', 'modloader', 'sugarcube', 'dol', 'degrees of lewdity']);
    const market = () => window.modHubMarket;
    const versions = () => window.modHubMarketVersions;
    const gameVersionLabel = () => versions().getGameVersionLabel?.() ?? (versions().getGameVersion() ? `DoL ${versions().getGameVersion()}` : '');
    const rangeText = value => versions().formatVersionRange(value || '*');
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const t = (key, params) => window.modHubT ? window.modHubT(key, params) : String(key ?? '').replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    const label = (key, params) => `<span data-modhub-i18n-key="${escape(key)}"${params ? ` data-modhub-i18n-key-params="${escape(JSON.stringify(params))}"` : ''}>${escape(t(key, params))}</span>`;
    const displayVariantLabel = value => window.modHubMarketVariants?.getLabelText?.(value) ?? value;
    const normalize = value => String(value || '').trim().toLowerCase();
    const keyOf = mod => market().getMarketModKey(mod);
    const stopped = () => Boolean(market().batchInstallState?.stopRequested);
    const localBoot = profile => profile?.bootJson || window.modHubGetModInfo?.(profile?.name)?.bootJson || profile;
    const bootSnapshot = boot => boot ? JSON.stringify([boot.name, boot.version, boot.edition || '', boot.alias || [], boot.dependenceInfo || []]) : '';
    const isDisabled = name => (window._modHubModState?.sideDisabled || []).some(item => normalize(item) === normalize(name))
        || (window._modHubModState?.sideMods || []).some(item => normalize(item.name) === normalize(name) && item.enabled === false);

    const historyFailure = error => versions().getHistoryErrorInfo?.(error) || {
        message: error?.message || '版本列表读取失败，请稍后重试或查看作者主页',
        details: error?.message ? [`原始错误：${error.message}`] : []
    };
    const errorDetailsHtml = details => details?.length ? `<details class="modhub-version-error-details modhub-version-status grey"><summary>${label('错误详情')}</summary><div data-modhub-i18n-ignore>${details.map(escape).join('<br>')}</div></details>` : '';
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
            return { value: keyOf(member), label: `${displayVariantLabel(member.variant?.label || member.name)}${local
                ? ` · ${t('已安装')} ${localBoot(local)?.version || t('版本未知')}${isDisabled(local.name) ? ` · ${t('已禁用')}` : ''}` : ` · ${t('未安装')}`}`,
            disabled: !eligible(member) };
        });
        const installed = members.filter(member => getLocal(member));
        const selected = await window.modHubConfirm({
            title: t('选择【{name}】{kind}', { name: group.name, kind: t(kind) }),
            message: kind === '语言' ? t('请先选择安装语言，再选择该语言的版本。') + (installed.length > 1 ? `\n${t('已同时安装多种语言，请明确选择本次目标。')}` : '')
                : t('请选择要安装的版本，再选择版本号。') + (installed.length > 1 ? `\n${t('已安装多个版本，请选择本次要更新的版本。')}` : ''),
            selectOptions: [{ value: '', label: t(`请选择安装${kind}`), disabled: true }, ...choices], selectValue: '',
            selectLabel: t(`安装${kind}`), requireSelection: true,
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
            message: t('本次目标：{target}。\n已安装其他语言：{installed}。\n\n继续将同时保留两份语言包，可能产生功能冲突。若要切换语言，请取消后前往模组管理移除旧语言包，再重新安装。', {
                target: `${displayVariantLabel(mod.variant?.label || mod.name)}（${mod.name}）`,
                installed: others.map(({ member, local }) => `${displayVariantLabel(member.variant?.label || member.name)}（${localBoot(local)?.name || local.name} ${localBoot(local)?.version || t('版本未知')}${isDisabled(local.name) ? `，${t('已禁用')}` : ''}）`).join('、') }),
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
                label: `${displayVariantLabel(edition.label)}${installed.some(item => item.edition.id === edition.id) ? ` · ${t('已安装')}` : ''}` }))],
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
    const assetSizeText = asset => Number(asset?.size) ? asset.size < 104858 ? t('小于 0.1 MB') : `${(asset.size / 1048576).toFixed(1)} MB` : t('大小未知');
    const roleText = asset => asset.label || t((asset.packageRole || market().getAssetRole?.(asset.name)) === 'audio' ? '音频扩展包' : asset.packageRole === 'resource' ? '附属资源包' : '主包');
    const assetsHtml = (candidate, note = '') => candidate?.assets?.length ? `<details class="modhub-version-package-details" data-detail-key="packages:${escape(candidate.candidateKey || candidate.version || '')}"><summary>${label('安装包')}${candidate.assets.length > 1 ? ` (${label('{count} 个', { count: candidate.assets.length })})` : ''}</summary>${note ? `<span class="modhub-version-description grey">${escape(t(note))}</span>` : ''}${candidate.assets.map(asset => `<span class="modhub-version-asset-name grey"><span data-modhub-i18n-ignore>${escape(asset.name)}</span><span class="modhub-version-meta">${escape(asset.version || candidate.version || t('版本未知'))} · ${escape(assetSizeText(asset))}</span></span>`).join('')}</details>` : '';
    const optionalHtml = (candidate, selected, enabled, key) => (candidate?.optionalAssets || []).map(asset => {
        const installed = optionalInstalled(asset, candidate.version), local = componentLocal(asset);
        return `<div class="modhub-version-optional"><label class="modhub-version-optional-label"><input type="checkbox" class="modhub-version-optional-input" data-key="${escape(key)}" data-url="${escape(asset.downloadUrl)}" ${selected.has(asset.downloadUrl) ? 'checked' : ''} ${!enabled ? 'disabled' : ''}><span><strong class="purple"><span data-modhub-i18n-ignore>${escape(roleText(asset))}</span>${installed ? ` · ${label('已安装')}` : ''}${local && isDisabled(local.name) ? ` · ${label('保持禁用')}` : ''}</strong></span></label><details class="modhub-version-package-details" data-detail-key="optional:${escape(key)}:${escape(asset.downloadUrl)}"><summary>${label('安装包详情')}</summary><span class="modhub-version-asset-name grey" data-modhub-i18n-ignore>${escape(asset.name)}</span><span class="modhub-version-meta grey">${label('当前')}：${escape(local?.version || t('未安装'))} · ${label('所选')}：${escape(asset.version || candidate.version || t('版本未知'))} · ${escape(assetSizeText(asset))}</span></details></div>`;
    }).join('');

    function candidateLabel(candidate) {
        return `${candidate.version || candidate.tagName || t('版本未知')} · ${candidate.assetName || candidate.assets?.[0]?.name || t('安装包')}`;
    }

    function groupCandidates(candidates, gameVersion, recommendedKey = '') {
        const groups = new Map();
        candidates.forEach(candidate => {
            const info = candidate.compatibility || {};
            const target = String(info.targetGameVersion || '').trim(), range = String(info.gameVersionRange || '').trim();
            const key = target ? `target:${target}` : range ? `range:${range}` : 'unknown';
            const group = groups.get(key) || { key, label: target ? `DoL ${target}` : range ? t('作者声明：DoL {range}', { range: t(rangeText(range)) }) : t('适配待核对'), candidates: [], preferred: false };
            group.candidates.push(candidate);
            group.preferred ||= candidate.candidateKey === recommendedKey || Boolean(!info.branchUnverified && !info.branchMismatch && gameVersion && (target
                ? market().compareVersions(target, gameVersion) === 0 : range && info.status === 'compatible'));
            groups.set(key, group);
        });
        return [...groups.values()].sort((a, b) => Number(b.preferred) - Number(a.preferred));
    }

    function sourceLink(url, text) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' && !parsed.username && !parsed.password
                ? `<a href="${escape(parsed.toString())}" target="_blank" rel="noopener noreferrer">${label(text)}</a>` : '';
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
                    <span class="modhub-version-meta grey">${escape(candidate.updateDate || t('发布日期未知'))} · ${Number(candidate.assetSize) ? escape(assetSizeText({ size: candidate.assetSize })) : escape(t('包体大小未知'))}</span>
                    <span class="modhub-version-description">${escape(t(status.reason))}</span>
                    ${candidate.candidateKey === selectedKey && candidate.candidateKey === defaults.defaultKey && defaults.defaultReason ? `<span class="modhub-version-description ${defaults.defaultRisk ? 'gold' : 'grey'}">${escape(t(defaults.defaultReason))}</span>` : ''}
                    ${assetsHtml(candidate)}
                    ${optionalHtml(candidate, selectedOptional, candidate.candidateKey === selectedKey, candidate.candidateKey)}
                    ${sourceLink(candidate.htmlUrl, '发布说明')}
                </span></div>`;
        };
        const listHtml = () => `<div class="modhub-version-context"><strong class="gold" data-modhub-i18n-ignore>${escape(mod.name)}</strong><span class="grey">${label('当前游戏版本')}：<strong class="gold">${gameVersionLabel() ? escape(gameVersionLabel()) : label('未识别')}</strong></span><span class="grey">${label('当前已安装模组版本')}：<strong class="gold">${escape(localVersion || t(local ? '未识别' : '未安装'))}</strong></span></div>
            ${requires.length ? `<p class="modhub-install-plan-warning"><strong class="gold">${label('需要前置版本')}：${escape(requires.map(requirementText).join('；'))}。</strong></p>` : ''}
            <p class="grey">请选择适合当前游戏的模组版本。${sourceLink(mod.githubUrl, '作者主页')}</p>
            ${localContext}
            ${requirementSources ? `<p class="grey">${label('前置要求来源')}：<br><span data-modhub-i18n-ignore>${requirementSources}</span></p>` : ''}
            ${loading ? `<div class="modhub-version-loading">${window.modHubLoadingHtml(candidates.length ? '正在读取更早版本…' : '正在读取版本列表…')}<span class="grey">${slow ? '发布服务响应较慢，请稍候；也可以取消后重试。' : '正在查找可用安装包并核对适配说明，可以随时取消。'}</span></div>` : ''}
            ${errorMessage ? `<div class="modhub-version-status" role="status"><p class="gold">${escape(t(errorMessage))}</p>${errorDetailsHtml(errorDetails)}${!history ? '<button type="button" class="macro-button modhub-version-retry">重试版本列表</button>' : ''}<span class="grey">也可以查看作者主页获取安装包。</span></div>` : ''}
            ${staleFetchedAt ? `<p class="gold">${label('正在使用过期缓存，发布数据可能已变化。获取时间：{time}。', { time: staleFetchedAt })}</p>` : ''}${sourceWarningsHtml(history)}
            <div class="modhub-version-list" role="radiogroup" aria-label="按游戏版本分类选择模组版本" tabindex="0">${options.allowSkip ? `<label class="modhub-version-option ${selectedKey === '__skip__' ? 'modhub-version-selected' : ''}"><input type="radio" name="modHubMarketVersion" value="__skip__" ${selectedKey === '__skip__' ? 'checked' : ''}><span class="modhub-version-content"><strong class="gold">暂不安装此前置</strong><span class="modhub-version-description">保留目标模组，前置由您自行处理。缺少前置或版本不符可能导致模组无法运行。</span></span></label>` : ''}${groupCandidates(candidates, gameVersion, initialKey).map(group => {
                const open = openGroups.has(group.key) ? openGroups.get(group.key) : group.preferred;
                return `<details class="modhub-version-group" data-group-key="${escape(group.key)}" ${open ? 'open' : ''}><summary class="modhub-version-group-summary" aria-expanded="${open}"><strong class="gold">${escape(group.label)}</strong><span class="grey">${label('{count} 个版本', { count: group.candidates.length })}</span></summary>${group.candidates.map(candidateHtml).join('')}</details>`;
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
                        if (button) modHubText(button, selectedInstalled() ? '已安装' : '查看安装计划');
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
                        area.innerHTML = modHubHtml(listHtml());
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
                                if (status) status.innerHTML = modHubHtml(window.modHubLoadingHtml('发布服务响应较慢，请稍候；也可以取消后重试。')); }
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

    async function selectBatch(targets, updateOnly, { single = false, addonsOnly = false } = {}) {
        const controller = new AbortController();
        const optionalKeys = new Set((market().getMarketMods?.() || targets)
            .flatMap(mod => market().getOptionalAddonMods?.(mod) || []).map(keyOf));
        const hasSource = mod => mod.autoInstall !== false && (market().hasInstallSource?.(mod)
            ?? Boolean(mod.githubUrl && (mod.catalogSource !== 'community' || market().hasCommunityReleaseSource?.(mod))));
        const makeRow = (mod, root = false) => ({ mod, root, active: true, local: getLocal(mod), candidates: [], selectedKey: '', defaultKey: '', recommendedKey: '', selectedOptional: new Set(), optionalOverrides: new Map(), manualSource: !hasSource(mod), loading: hasSource(mod), requirements: [] });
        const rows = targets.map(mod => makeRow(mod, true));
        const targetKeys = new Set(targets.map(keyOf));
        for (const parent of rows.slice()) {
            parent.hostOnly = addonsOnly;
            for (const mod of market().getOptionalAddonMods?.(parent.mod) || []) {
                if (rows.some(row => keyOf(row.mod) === keyOf(mod)) || targetKeys.has(keyOf(mod))) continue;
                const row = makeRow(mod, true);
                Object.assign(row, { addon: true, parentKey: keyOf(parent.mod), checked: Boolean(row.local),
                    manualSource: row.manualSource || !mod.bootNames?.length, loading: false });
                if (row.manualSource) row.checked = false;
                rows.push(row);
            }
        }
        const unresolvedChoices = new Map();
        let closed = false, checkingLocal = true, localError = '', localErrorDetails = [];
        let preview = null, previewBusy = true, previewError = '', previewGeneration = 0, unresolved = [];
        const visibleRows = () => rows.filter(row => row.root || row.active);
        const loading = () => checkingLocal || visibleRows().some(row => row.loading && !row.manualSource && !row.hostOnly && (!row.addon || row.checked));
        const needsEdition = row => packageEditions(row.mod).length && !row.mod._selectedPackageEdition && !versions().getLegacyVerifiedRelease?.(row.mod);
        const inheritEdition = row => {
            const editions = packageEditions(row.mod);
            if (row.editionResolved || !editions.length || versions().getLegacyVerifiedRelease?.(row.mod)) return;
            const profiles = market().getLocalInstalledProfiles();
            const inherited = [...new Set(profiles.map(profile => window.modHubMarketVariants?.getPackageEdition?.(row.mod, profile)?.id).filter(Boolean))];
            const hasInstalled = profiles.some(profile => editions.some(edition => normalize(edition.bootName) === normalize(profile.name)));
            if ((!row.root || updateOnly) && hasInstalled) row.mod = { ...row.mod, _selectedPackageEdition: inherited.length === 1 ? inherited[0] : '',
                ...(row.root && updateOnly ? { _packageEditionUpdateOnly: true } : {}) };
            else if (!row.mod._selectedPackageEdition && inherited.length === 1) row.mod = { ...row.mod, _selectedPackageEdition: inherited[0] };
            row.editionResolved = true; row.local = getLocal(row.mod);
        };
        const rowSelection = row => {
            let release = selectedRelease(row.candidates.find(candidate => candidate.candidateKey === row.selectedKey), row.selectedOptional, row);
            if (release && (row.addon || optionalKeys.has(keyOf(row.mod))) && row.local && isDisabled(row.local.name)) release = { ...release,
                assets: release.assets.map((asset, index) => index ? asset : { ...asset, optional: true, bootName: row.local.name }) };
            return { mod: row.mod, release, manual: Boolean(row.manual || row.mod._packageEditionManual || row.selectedKey !== row.defaultKey) };
        };
        const canSelect = row => Boolean(row.selectedKey) && row.candidates.some(candidate => candidate.candidateKey === row.selectedKey
            && releaseNeedsAction(row.mod, selectedRelease(candidate, row.selectedOptional), row.local));
        const addonHostReady = row => {
            const parent = rows.find(item => keyOf(item.mod) === row.parentKey);
            return Boolean(parent && (parent.local || !parent.manualSource && !parent.hostOnly && canSelect(parent)));
        };
        const selections = () => rows.filter(row => row.root && !row.manualSource && !row.hostOnly && (!row.addon || row.checked) && canSelect(row)).map(rowSelection);
        const risks = () => preview ? collectPlanRisks(preview, runtimeChecks(preview)) : { risks: [], approved: [] };
        const canInstall = () => !closed && !localError && !loading() && !previewBusy && !previewError
            && !rows.some(row => row.addon && row.checked && (row.manualSource || row.error && !row.history || !row.selectedKey || !addonHostReady(row)))
            && Boolean(preview?.actions.length) && ![...preview.nodes.values()].some(node => node.selectionPending);
        const chooseDefault = (row, choices) => {
            const eligible = row.requirements.length ? versions().rankCandidates(row.mod, choices.candidates.filter(candidate => row.requirements.every(requirement =>
                !requirement.bootVersions && satisfiesRange(candidate.version, requirement.version || '*'))), { updateOnly: row.root && updateOnly, localVersion: row.local?.version || '', localProfile: row.local }) : choices;
            Object.assign(row, { defaultKey: eligible.defaultKey ?? eligible.recommendedKey ?? '', defaultReason: eligible.defaultReason || '', defaultRisk: Boolean(eligible.defaultRisk) });
            if (!row.manual) row.selectedKey = row.defaultKey || (row.addon && row.local
                ? row.candidates.find(candidate => releaseInstalled(candidate, row.local))?.candidateKey || '' : '');
            selectOptionalDefaults(row.candidates.find(candidate => candidate.candidateKey === row.selectedKey), row.selectedOptional, row.optionalOverrides);
        };
        const rowHtml = row => {
            const optionalStart = row.addon ? `<div class="modhub-version-optional" data-addon-key="${escape(keyOf(row.mod))}"><label class="modhub-version-optional-label"><input type="checkbox" class="modhub-version-addon-input" data-key="${escape(keyOf(row.mod))}" ${row.checked ? 'checked' : ''} ${checkingLocal || row.manualSource ? 'disabled' : ''}><strong class="purple" data-modhub-i18n-ignore>${escape(row.mod.name)}${row.local ? ` · ${escape(t('已安装'))}` : ''}${row.local && isDisabled(row.local.name) ? ` · ${escape(t('保持禁用'))}` : ''}</strong></label>${row.checked && !addonHostReady(row) ? `<p class="gold">${label('请先安装主模组，或在本窗口选择主模组版本。')}</p>` : ''}` : '';
            const optionalEnd = row.addon ? '</div>' : '';
            if (row.addon && !row.checked && !row.manualSource) return optionalStart + optionalEnd;
            const children = rows.filter(child => child.addon && child.parentKey === keyOf(row.mod)).map(rowHtml).join('');
            if (row.manualSource || row.hostOnly) {
                const explanation = row.manualSource ? row.addon ? '此附加内容需按作者说明手动获取，不会自动安装。'
                    : '此主模组需按作者说明手动获取，不会自动安装。' : '仅处理所选附加内容，不会重新安装主模组。';
                return `${optionalStart}<div class="modhub-version-batch-row" data-key="${escape(keyOf(row.mod))}">${!row.addon ? `<strong class="gold" data-modhub-i18n-ignore>${escape(row.mod.name)}</strong>` : ''}<p class="grey">${label(explanation)}</p>${row.mod.description ? `<p class="modhub-version-description grey" data-modhub-i18n-ignore>${escape(row.mod.description)}</p>` : ''}<div class="modhub-version-row-links">${sourceLink(market().getExternalDownloadUrl?.(row.mod) || row.mod.githubUrl, '作者主页')}</div>${children}</div>${optionalEnd}`;
            }
            const localVersion = row.local?.version || '';
            const selected = row.candidates.find(candidate => candidate.candidateKey === row.selectedKey);
            const selectedAssets = selectedRelease(selected, row.selectedOptional)?.assets || [];
            const totalSize = selectedAssets.reduce((total, asset) => total + (Number(asset.size) || 0), 0);
            const sizeText = totalSize ? `<span>${selectedAssets.some(asset => !Number(asset.size)) ? '已知大小' : '总大小'}</span> <span>${escape(assetSizeText({ size: totalSize }))}</span>` : '大小未知';
            const choices = groupCandidates(row.candidates, row.gameVersion, row.defaultKey).map(group => `<optgroup label="${escape(group.label)}">${group.candidates.map(candidate => `<option value="${escape(candidate.candidateKey)}" ${candidate.candidateKey === row.selectedKey ? 'selected' : ''} ${row.root && !releaseNeedsAction(row.mod, candidate, row.local) && !candidate.optionalAssets?.length ? 'disabled' : ''}>${escape(candidateLabel(candidate))}</option>`).join('')}</optgroup>`).join('');
            const editionOptions = packageEditions(row.mod);
            const editions = editionOptions.length && !versions().getLegacyVerifiedRelease?.(row.mod) ? `<label class="modhub-version-edition-label"><span class="grey">安装版本</span><select class="modhub-version-edition-select" data-key="${escape(keyOf(row.mod))}" ${checkingLocal || row.loading && !needsEdition(row) ? 'disabled' : ''}><option value="">请选择安装版本</option>${editionOptions.map(edition => `<option value="${escape(edition.id)}" ${row.mod._selectedPackageEdition === edition.id ? 'selected' : ''}>${escape(displayVariantLabel(edition.label))}</option>`).join('')}</select></label>` : '';
            const required = row.requirements.some(requirement => requirement.required);
            const requirementText = [...new Set(row.requirements.map(requirement => `${requirement.bootName || row.mod.name} ${rangeText(requirement.version)}`))].join('；');
            return `${optionalStart}<div class="modhub-version-batch-row${row.root ? '' : ' modhub-version-batch-dependency'}" data-key="${escape(keyOf(row.mod))}">${row.addon ? '' : `<label><strong class="gold" data-modhub-i18n-ignore>${escape(row.mod.name)}</strong>${!row.root ? '<span class="grey">前置模组</span>' : ''}</label>`}${editions}<label><span class="modhub-version-batch-current grey">${escape(localVersion || t(row.local ? '版本未识别' : '未安装'))}${selected ? ` → <strong class="gold">${escape(selected.version || selected.tagName || t('版本未识别'))}</strong> · ${sizeText}` : ''}</span><select class="modhub-version-batch-select" data-key="${escape(keyOf(row.mod))}" ${checkingLocal || row.loading && !row.history || localError || needsEdition(row) ? 'disabled' : ''}><option value="">${checkingLocal || localError ? '等待核对完成' : needsEdition(row) ? '请先选择安装版本' : row.loading && !row.history ? '正在读取版本列表…' : row.error && !row.history ? '读取失败' : row.root ? '请选择版本或跳过此项' : '请选择前置版本'}</option>${!row.root && !required ? `<option value="__skip__" ${row.selectedKey === '__skip__' ? 'selected' : ''}>暂不安装此前置</option>` : ''}${choices}</select></label>${requirementText ? `<span class="grey">${label('需要')}：${escape(requirementText)}</span>` : ''}${row.selectedKey === '__skip__' ? '<span class="gold">此前置由您自行处理，相关模组可能无法运行。</span>' : ''}${row.defaultReason && row.selectedKey === row.defaultKey && row.defaultRisk ? `<span class="modhub-version-default-note gold">${escape(t(row.defaultReason))}</span>` : ''}${assetsHtml(selected, row.selectedKey === row.defaultKey && !row.defaultRisk ? row.defaultReason : '')}${optionalHtml(selected, row.selectedOptional, !row.loading || Boolean(row.history), keyOf(row.mod))}${sourceWarningsHtml(row.history)}${!checkingLocal && !localError && (row.error || row.loading) ? `<span class="grey">${escape(t(row.error || (row.history ? '正在加载更早版本…' : '正在读取版本列表…')))}</span>` : ''}${errorDetailsHtml(row.errorDetails)}${row.history?.stale ? `<span class="gold">${label('正在显示缓存版本。获取时间：{time}。', { time: row.history.fetchedAt || t('未知') })}</span>` : ''}<div class="modhub-version-row-links">${sourceLink(row.mod.githubUrl, '作者主页')}${row.history?.hasMore || row.error ? `<button type="button" class="macro-button modhub-version-batch-more" data-key="${escape(keyOf(row.mod))}" ${row.loading ? 'disabled' : ''}>${row.error ? row.history ? '重试加载更早版本' : '重试版本列表' : '加载更早版本'}</button>` : ''}</div>${children}</div>${optionalEnd}`;
        };
        const previewHtml = () => {
            if (previewBusy) return '';
            if (previewError) return `<p class="red">${escape(previewError)}</p>`;
            if (!preview) return '<p class="grey">选择版本后显示安装内容。</p>';
            const pending = [...preview.nodes.values()].some(node => node.selectionPending);
            return `${unresolved.map(node => `<label class="modhub-version-unresolved"><span class="gold">【${escape(node.mod.name)}】的部分前置需要手动处理：${escape(node.unresolved.map(item => `${item.bootName || item.id} ${rangeText(item.version)}`).join('；'))}</span><select class="modhub-version-unresolved-choice" data-key="${escape(node.key)}"><option value="stop" ${unresolvedChoices.get(node.key) !== 'skip' ? 'selected' : ''}>跳过依赖此前置的目标模组</option><option value="skip" ${unresolvedChoices.get(node.key) === 'skip' ? 'selected' : ''}>暂不安装此前置，保留目标模组</option></select></label>`).join('')}${pending ? '<p class="grey">请完成前置模组选择。</p>' : ''}${planHtml(preview, runtimeChecks(preview), { inline: true })}${renderPlanRisks(preview, risks().risks)}`;
        };
        const html = () => {
            const statusHtml = localError ? `<div class="modhub-version-status grey"><p class="red">${escape(localError)}</p>${errorDetailsHtml(localErrorDetails)}<button type="button" class="macro-button modhub-btn-secondary modhub-version-local-retry">重新核对</button></div>`
                : loading() ? '' : '<div class="modhub-version-status grey"><span role="status" aria-live="polite">请选择版本，并核对本次安装内容。</span></div>';
            return `<p class="grey">${label('当前游戏版本')}：<strong class="gold">${gameVersionLabel() ? escape(gameVersionLabel()) : label('未识别')}</strong></p>${statusHtml}${visibleRows().filter(row => !row.addon).map(rowHtml).join('')}<div id="modHubInstallPlanPreview" class="modhub-install-plan-preview" aria-live="polite">${previewHtml()}</div>`;
        };
        try {
            targets.forEach(mod => market().updateDownloadProgress?.(mod.name, null, '等待选择版本与安装内容', 'confirming'));
            const choice = await window.modHubConfirm({
                title: addonsOnly ? t('选择【{name}】附加内容', { name: targets[0].name })
                    : single ? `下载并安装【${targets[0].name}】` : updateOnly ? '更新全部模组' : '批量下载并安装',
                message: '请选择版本，并核对本次安装内容。',
                trustedMessageHtml: `<div class="modhub-version-list" id="modHubBatchVersionChoices">${html()}</div>`,
                dialogClass: 'modhub-install-dialog modhub-version-dialog', confirmText: '下载并安装', cancelText: '取消',
                canConfirm: canInstall,
                onRender: dialog => {
                    const area = dialog.querySelector('#modHubBatchVersionChoices');
                    const queue = [];
                    let active = 0;
                    const render = () => {
                        if (closed) return;
                        const scroll = area.scrollTop || 0;
                        const body = dialog.querySelector('.modhub-modal-body'), bodyScroll = body?.scrollTop || 0;
                        const focused = document.activeElement;
                        const focusClass = focused?.classList?.contains('modhub-version-batch-select') ? 'modhub-version-batch-select'
                            : focused?.classList?.contains('modhub-version-edition-select') ? 'modhub-version-edition-select' : '';
                        const focusKey = focusClass ? focused.dataset.key : '';
                        const detailKey = detail => `${detail.closest('.modhub-version-batch-row')?.dataset?.key || 'plan'}:${detail.dataset?.detailKey || detail.className}`;
                        const openedDetails = new Map([...area.querySelectorAll('details')].map(detail => [detailKey(detail), detail.open]));
                        area.innerHTML = modHubHtml(html());
                        area.querySelectorAll('details').forEach(detail => { if (openedDetails.has(detailKey(detail))) detail.open = openedDetails.get(detailKey(detail)); });
                        const button = dialog.querySelector('.modhub-modal-btn-confirm');
                        const busy = checkingLocal || loading() || previewBusy;
                        window.modHubSetButtonBusy?.(button, busy);
                        if (button) {
                            button.classList.toggle('modhub-btn-danger', !busy && risks().risks.length > 0);
                            button.classList.toggle('modhub-btn-primary', busy || !risks().risks.length);
                            const label = button.querySelector('.modhub-button-busy-label') || button;
                            modHubText(label, busy ? '正在核对安装内容' : risks().risks.length ? '仍然下载并安装' : '下载并安装');
                        }
                        dialog.modHubSyncConfirmState?.();
                        area.querySelectorAll('.modhub-version-batch-select').forEach(select => {
                            select.onchange = () => {
                                const row = rows.find(item => keyOf(item.mod) === select.dataset.key);
                                if (closed || select.isConnected === false || row?.loading && !row.history) return;
                                if (row) { row.selectedKey = select.value; row.manual = true; selectOptionalDefaults(row.candidates.find(candidate => candidate.candidateKey === row.selectedKey), row.selectedOptional, row.optionalOverrides); }
                                return updatePreview();
                            };
                        });
                        area.querySelectorAll('.modhub-version-edition-select').forEach(select => {
                            select.onchange = async () => {
                                const row = rows.find(item => keyOf(item.mod) === select.dataset.key);
                                if (closed || select.isConnected === false || !row || !packageEditions(row.mod).some(edition => edition.id === select.value)) return;
                                row.mod = { ...row.mod, _selectedPackageEdition: select.value, _packageEditionManual: true,
                                    ...(row.root && updateOnly ? { _packageEditionUpdateOnly: true } : {}) };
                                Object.assign(row, { candidates: [], selectedKey: '', history: null, manual: false, error: '' });
                                previewGeneration++; previewBusy = true; render();
                                await loadRow(row); return updatePreview();
                            };
                        });
                        area.querySelectorAll('.modhub-version-optional-input').forEach(input => {
                            input.onchange = () => {
                                const row = rows.find(item => keyOf(item.mod) === input.dataset.key);
                                if (closed || input.isConnected === false || input.disabled || !row || row.loading && !row.history) return;
                                if (input.checked) row.selectedOptional.add(input.dataset.url); else row.selectedOptional.delete(input.dataset.url);
                                const asset = row.candidates.find(candidate => candidate.candidateKey === row.selectedKey)?.optionalAssets?.find(item => item.downloadUrl === input.dataset.url);
                                if (asset) row.optionalOverrides.set(optionalKey(asset), input.checked);
                                return updatePreview();
                            };
                        });
                        area.querySelectorAll('.modhub-version-addon-input').forEach(input => {
                            input.onchange = async () => {
                                const row = rows.find(item => item.addon && keyOf(item.mod) === input.dataset.key);
                                if (closed || input.isConnected === false || input.disabled || !row || row.manualSource) return;
                                row.checked = input.checked; row.addonManual = true;
                                previewGeneration++; previewBusy = true; render();
                                if (row.checked && !row.history) await loadRow(row);
                                return updatePreview();
                            };
                        });
                        area.querySelectorAll('.modhub-version-unresolved-choice').forEach(select => {
                            select.onchange = () => { if (closed || select.isConnected === false) return; unresolvedChoices.set(select.dataset.key, select.value); return updatePreview(); };
                        });
                        area.querySelectorAll('.modhub-version-batch-more').forEach(button => {
                            button.onclick = async () => {
                                if (closed || button.isConnected === false) return;
                                const row = rows.find(item => keyOf(item.mod) === button.dataset.key);
                                if (row && !row.loading) { previewGeneration++; previewBusy = true; await loadRow(row); return updatePreview(); }
                            };
                        });
                        const retryLocal = area.querySelector('.modhub-version-local-retry');
                        if (retryLocal) retryLocal.onclick = () => initialize();
                        area.scrollTop = scroll;
                        if (body) body.scrollTop = bodyScroll;
                        if (focusKey) [...area.querySelectorAll('.' + focusClass)].find(select => select.dataset.key === focusKey)?.focus({ preventScroll: true });
                    };
                    const readRow = async row => {
                        const initial = !row.history;
                        market().setBatchInstallStatus?.(row.mod.name, 'preparing', initial ? '正在读取可用版本' : '正在加载更早版本');
                        try {
                            const local = getLocal(row.mod);
                            if (initial) {
                                await loadChoices(row.mod, { updateOnly: row.root && updateOnly, localVersion: local?.version || '', localProfile: local, signal: controller.signal, onProgress: choices => {
                                    if (closed || controller.signal.aborted) return;
                                    Object.assign(row, choices, { local, history: choices.history }); chooseDefault(row, choices); render();
                                } });
                            } else {
                                const history = await versions().fetchReleases(row.mod, { page: row.history.page + 1, signal: controller.signal, useCache: row.historyContext?.useCache });
                                if (closed || controller.signal.aborted) return;
                                history.sourceWarnings = [...(row.history?.sourceWarnings || []), ...(versions().getHistorySelectionWarnings?.(row.mod, history) || history.sourceWarnings || [])];
                                const merged = new Map([...row.candidates, ...versions().buildCandidates(row.mod, history)].map(candidate => [candidate.candidateKey, candidate]));
                                const choices = versions().rankCandidates(row.mod, [...merged.values()], { updateOnly: row.root && updateOnly, localVersion: local?.version || '', localProfile: local, sourceWarnings: history.sourceWarnings });
                                const staleHistory = row.history?.stale ? row.history : history;
                                Object.assign(row, choices, { local, history: { ...history, stale: Boolean(row.history?.stale || history.stale), fetchedAt: staleHistory.fetchedAt, sourceWarnings: history.sourceWarnings } });
                                chooseDefault(row, choices);
                                if (!history.hasMore) market().rememberMarketCandidates?.(row.mod, choices.candidates, { context: row.historyContext });
                            }
                        } catch (error) {
                            if (!closed && !controller.signal.aborted) { const failure = historyFailure(error); row.error = failure.message; row.errorDetails = failure.details; }
                        } finally {
                            if (!closed && !controller.signal.aborted) market().setBatchInstallStatus?.(row.mod.name, row.error && !row.history ? 'error' : 'waiting', row.error || '版本已就绪，等待选择');
                        }
                    };
                    // 初次读取、分页及逐行重试共用两路队列，其他已完成行仍可操作。
                    const pump = () => {
                        if (closed || controller.signal.aborted) return;
                        if (stopped()) { controller.abort(); return; }
                        while (active < 2 && queue.length) {
                            const { row, resolve } = queue.shift(); active++;
                            readRow(row).finally(() => {
                                active--; row.pending = false; row.loading = false; row.loadPromise = null;
                                if (!closed) render(); resolve(); pump();
                            });
                        }
                    };
                    const loadRow = row => {
                        if (closed || controller.signal.aborted || row.manualSource || row.hostOnly
                            || row.addon && !row.checked || needsEdition(row)) { row.loading = false; return Promise.resolve(); }
                        if (row.loadPromise) return row.loadPromise;
                        row.pending = true; row.loading = true; row.error = ''; row.errorDetails = [];
                        row.loadPromise = new Promise(resolve => { queue.push({ row, resolve }); });
                        render(); pump(); return row.loadPromise;
                    };
                    const updatePreview = async () => {
                        const generation = ++previewGeneration;
                        previewBusy = true; previewError = ''; render();
                        const current = () => !closed && !controller.signal.aborted && generation === previewGeneration;
                        const nextUnresolved = [], usedDependencies = new Set();
                        try {
                            const selected = selections();
                            const next = selected.length ? await preparePlan(selected, updateOnly, { download: false, isCurrent: current,
                                resolveSelection: async (node, requirements) => {
                                    usedDependencies.add(node.key);
                                    let row = rows.find(item => keyOf(item.mod) === node.key);
                                    if (!row) { row = makeRow(node.mod); rows.push(row); }
                                    row.active = true; row.requirements = requirements; row.local = node.local;
                                    inheritEdition(row);
                                    if (needsEdition(row)) { row.loading = false; render(); return { pending: true }; }
                                    if (!row.history && !row.error || row.loading) await loadRow(row);
                                    if (!current()) return { pending: true };
                                    if (!row.manual && row.history) chooseDefault(row, row);
                                    if (row.selectedKey === '__skip__' && !requirements.some(item => item.required)) return { skipped: true, manual: true };
                                    if (!row.selectedKey || !row.candidates.some(candidate => candidate.candidateKey === row.selectedKey)) return { pending: true };
                                    return rowSelection(row);
                                },
                                resolveUnresolved: node => { nextUnresolved.push(node); return unresolvedChoices.get(node.key) || 'stop'; }
                            }) : null;
                            if (!current()) return;
                            rows.forEach(row => { if (!row.root) row.active = usedDependencies.has(keyOf(row.mod)); });
                            preview = next; unresolved = nextUnresolved;
                        } catch (error) { if (current()) { preview = null; previewError = error.message || '无法核对安装内容'; } }
                        finally { if (current()) { previewBusy = false; render(); } }
                    };
                    controller.signal.addEventListener('abort', () => {
                        for (const { row, resolve } of queue.splice(0)) { row.pending = false; row.loading = false; row.loadPromise = null; resolve(); }
                    }, { once: true });
                    const initialize = async () => {
                        previewGeneration++; checkingLocal = true; previewBusy = true; localError = ''; localErrorDetails = []; render();
                        if (typeof window.requestAnimationFrame === 'function') await window.modHubYieldToBrowser();
                        if (closed || controller.signal.aborted) return;
                        try {
                            if (market().refreshLocalPackageProfiles) await market().refreshLocalPackageProfiles(undefined, () => !closed && !controller.signal.aborted && !stopped());
                            if (closed || controller.signal.aborted || stopped()) return;
                            rows.forEach(row => {
                                row.local = getLocal(row.mod);
                                if (row.addon && !row.addonManual) row.checked = !row.manualSource && Boolean(row.local);
                                inheritEdition(row);
                            });
                        } catch (error) {
                            if (!closed && !controller.signal.aborted) { localError = '无法核对已安装模组，请重试。'; localErrorDetails = [error?.message || '本地安装包读取失败']; rows.forEach(row => { row.loading = false; }); }
                        }
                        checkingLocal = false; render();
                        if (!localError && !closed && !controller.signal.aborted) { await Promise.all(rows.filter(row => row.root).map(loadRow)); await updatePreview(); }
                    };
                    return initialize();
                },
                customResult: () => ({ selections: selections(), initialPlan: preview, initialImpact: preview ? planImpact(preview) : '', acknowledged: risks().risks.map(risk => risk.key) })
            });
            return choice?.initialPlan && Array.isArray(choice.selections) ? choice : null;
        } finally { closed = true; previewGeneration++; controller.abort(); targets.forEach(mod => window.modHubClearMarketPreparationProgress?.(mod.name)); }
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

    async function preparePlan(selections, updateOnly, { download = true, initialPlan = null, initialImpact = '', acknowledged = new Set(), resolveSelection, resolveUnresolved, isCurrent,
        preparedCache = new Map(), preserveProgress = false, mergeOnNewDependencies = false, protectedNames = new Map(), downloads } = {}) {
        const api = market(), catalog = api.getMarketMods();
        checkExclusiveSelections(selections);
        const nodes = new Map(), roots = new Set(), queue = [];
        const downloadApprovals = new Map(initialPlan?.downloadApprovals || []);
        const approvedImpacts = new Map((initialImpact ? JSON.parse(initialImpact) : []).map(impact => [impact[0], impact]));
        const approvedSkippedNodes = new Set();
        let mergePending = false;
        let bytes = [...preparedCache.values()].reduce((sum, node) => sum + (Number(node.prepared.bytes) || 0), 0);
        const budget = api.MAX_DOWNLOAD_BYTES || 256 * 1024 * 1024;
        const addNode = (mod, selection = null) => {
            const key = keyOf(mod);
            if (download) api.trackBatchInstallMod?.(mod, selection ? '目标模组' : '前置模组');
            const previous = initialPlan?.nodes.get(key);
            selection = previous || selection;
            if (!nodes.has(key)) nodes.set(key, { key, mod, local: getLocal(mod), release: selection?.release || null,
                manual: Boolean(selection?.manual), requirements: [], dependencies: new Set(), issue: '', prepared: null,
                skipped: Boolean(selection?.skipped), planned: false, plannedVersion: '', unresolved: [],
                localSnapshot: previous?.localSnapshot, localDisabledSnapshot: previous?.localDisabledSnapshot,
                unresolvedDecision: previous?.unresolvedDecision,
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
            if (download) window.modHubClearMarketPreparationProgress?.(node.mod.name);
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
                if (mergeOnNewDependencies && !initialPlan?.nodes.has(dependency.key)) mergePending = true;
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
            const signature = JSON.stringify(node.unresolved.map(item => [item.id || item.bootName, item.version, Boolean(item.required)]));
            let choice, approved = false;
            if (node.unresolvedDecision?.signature === signature) { choice = node.unresolvedDecision.choice; approved = node.unresolvedDecision.approved; }
            else if (resolveUnresolved) choice = await resolveUnresolved(node);
            else {
                const changedPlan = { nodes, roots, actions: [{ ...node, type: node.local ? 'update' : 'install' }] };
                const newRisks = collectPlanRisks(changedPlan, runtimeChecks(changedPlan)).risks.filter(risk => !acknowledged.has(risk.key));
                const message = `【${node.mod.name}】无法精确识别以下前置：\n${node.unresolved.map(item => `${item.bootName || item.id}：${rangeText(item.version)}`).join('\n')}\n\n请选择处理方式。继续安装时，缺少前置可能导致相关模组无法运行。`;
                choice = await window.modHubConfirm({ title: initialPlan ? '安装前请确认' : '前置需要手动处理', message,
                    trustedMessageHtml: renderPlanRisks(changedPlan, newRisks) + `<p>${escape(message).replace(/\n/g, '<br>')}</p>`,
                    selectOptions: [{ value: 'stop', label: '跳过依赖此前置的目标模组' }, { value: 'skip', label: '暂不安装此前置，保留目标模组' }],
                    selectValue: 'stop', confirmText: '采用所选处理方式', cancelText: '取消', dialogClass: 'modhub-install-dialog'
                });
                if (!choice || stopped()) throw Object.assign(new Error('已取消前置处理'), { code: 'INSTALL_CANCELLED' });
                approved = true;
                if (choice === 'skip') newRisks.forEach(risk => acknowledged.add(risk.key));
            }
            node.unresolvedDecision = { signature, choice, approved };
            if (choice !== 'skip') {
                node.issue = `无法精确识别前置【${node.unresolved.map(item => item.bootName || item.id).join('、')}】，已跳过目标。`;
                node.recoverableIssue = true;
                if (approved) approvedSkippedNodes.add(node.key);
            }

        };
        try {
            while (queue.length && !mergePending) {
                if (stopped() || isCurrent && !isCurrent()) throw Object.assign(new Error('已停止安装准备'), { code: 'INSTALL_CANCELLED' });
                const node = queue.shift();
                if (nodes.get(node.key) !== node || (node.issue && !node.forceReselect)) continue;
                if (node.skipped) continue;
                let pendingRequirements = null;
                if (node.forceReselect) {
                    pendingRequirements = node.requirements.slice();
                    releaseNode(node); clearDependencies(node); node.release = null;
                    node.issue = ''; node.downloadFailureDetails = null; node.recoverableIssue = false; node.forceReselect = false; node.planned = false; node.plannedVersion = '';
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
                            node.skipped = true;
                            await chooseUnresolved(node);
                            if (node.issue) node.skipped = false;
                            continue;
                        }
                        let choice;
                        if (resolveSelection) choice = await resolveSelection(node, selectionRequirements);
                        else {
                            const selectedMod = await selectPackageEdition(node.mod, { updateOnly: true });
                            if (!selectedMod) throw new Error('已取消前置类型选择');
                            node.mod = selectedMod;
                            choice = await selectVersion(node.mod, { requirements: selectionRequirements.map(requirement => ({
                                ...requirement, targetName: nodes.get(requirement.parent)?.mod.name || ''
                            })), allowSkip: !roots.has(node.key) && !selectionRequirements.some(requirement => requirement.required), localBoot: localBoot(node.local), localVersion: node.local?.version || '', localProfile: node.local });
                        }
                        if (choice?.pending) { node.selectionPending = true; continue; }
                        if (!choice) throw new Error('已取消前置版本选择');
                        if (choice.skipped) { node.skipped = true; continue; }
                        if (choice.mod) node.mod = choice.mod;
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
                    const protectedName = [...(node.mod.bootNames || []), ...getDependencyBootNames(localBoot(node.local))]
                        .find(name => protectedNames.has(`boot:${normalize(name)}`));
                    if (protectedName) throw new Error(`此前已完成项目正在使用【${protectedNames.get(`boot:${normalize(protectedName)}`)}】，本次不能替换此前置。请核对前置版本后重试。`);
                    if (downloadApprovals.get(node.key) !== downloadSignature(node.release)) {
                        const action = { ...node, type: node.local ? 'update' : 'install' };
                        const changedPlan = { nodes, roots, actions: [action] };
                        const newRisks = collectPlanRisks(changedPlan, runtimeChecks(changedPlan)).risks.filter(risk => !acknowledged.has(risk.key));
                        const message = `核对安装包后，需要新增下载或更换【${node.mod.name}】${node.release.version || node.release.tagName || '版本未知'}。\n${node.requirements.map(item => `【${nodes.get(item.parent)?.mod.name || item.declaredBy}】要求 ${item.bootName || node.mod.name}：${rangeText(item.version)}`).join('\n')}\n\n确认后将下载并安装此版本${node.local && isDisabled(node.local.name) ? '，并启用该模组' : ''}${node.switchGroup?.disabledNames.length ? `，并停用【${node.switchGroup.disabledNames.join('、')}】；旧安装包会保留` : ''}。${preserveProgress ? '取消将停止后续处理，已完成的项目会保留。' : '取消不会导入任何模组。'}`;
                        const ok = await window.modHubConfirm({ title: '安装计划有变更',
                            message, trustedMessageHtml: renderPlanRisks(changedPlan, newRisks) + `<p>${escape(message).replace(/\n/g, '<br>')}</p>`,
                            confirmText: newRisks.length ? '仍然下载并安装' : '下载并安装此版本', cancelText: '取消', confirmType: newRisks.length ? 'danger' : 'primary', dialogClass: 'modhub-install-dialog'
                        });
                        if (!ok || stopped()) throw Object.assign(new Error('已取消安装计划变更'), { code: 'INSTALL_CANCELLED' });
                        downloadApprovals.set(node.key, downloadSignature(node.release));
                        approvedImpacts.set(node.key, actionImpact(action));
                        newRisks.forEach(risk => acknowledged.add(risk.key));
                    }
                    const assets = api.getReleaseInstallAssets(node.release);
                    const expected = assets.reduce((total, asset) => total + (Number(asset.size) || 0), 0);
                    let cached = preparedCache.get(node.key);
                    preparedCache.delete(node.key);
                    if (cached) bytes -= Number(cached.prepared.bytes) || 0;
                    const reusable = cached && downloadSignature(cached.release) === downloadSignature(node.release) ? cached.prepared : null;
                    cached = null;
                    if (bytes + (reusable ? Number(reusable.bytes) || 0 : expected) > budget) throw Object.assign(new Error('本组安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
                    const onFailure = (reason, code, error) => { node.issue = reason; node.downloadFailureDetails = error?.downloadFailureDetails; if (code === 'FILE_TOO_LARGE') node.budgetExceeded = true; };
                    const prepared = reusable || (downloads ? await downloads.take(node, budget - bytes, onFailure)
                        : await api.downloadAndInstallMod(node.mod, api.getCurrentMirrorId(), {
                            releaseInfo: node.release, prepareOnly: true, batchMode: true, maxPreparedBytes: budget - bytes, onFailure
                        }));
                    if (node.budgetExceeded) throw Object.assign(new Error('本组安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
                    if (!prepared || !Array.isArray(prepared.boots)) throw new Error(node.issue || '安装包预检失败');
                    node.prepared = prepared; node.wasReleased = false; bytes += Number(prepared.bytes) || 0;
                    if (bytes > budget) throw Object.assign(new Error('本组安装包超过 256 MB 的准备缓存上限，请拆分批次安装。'), { code: 'PREPARE_BUDGET' });
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
            nodes.forEach(node => {
                if (node.localSnapshot === undefined) node.localSnapshot = bootSnapshot(localBoot(node.local));
                if (node.localDisabledSnapshot === undefined) node.localDisabledSnapshot = Boolean(node.local && isDisabled(node.local.name));
            });
            const actions = order.filter(key => needed.has(key)).map(key => {
                const node = nodes.get(key);
                const type = node.skipped ? '' : node.prepared || !download && node.release ? (node.local ? 'update' : 'install') : (node.local && isDisabled(node.local.name) ? 'enable' : '');
                return { ...node, type, role: roots.has(key) ? '目标模组' : '前置依赖', dependencyRequirements: node.requirements };
            }).filter(node => node.type);
            if (download && approvedSkippedNodes.size) {
                const activeKeys = new Set(actions.map(action => action.key));
                for (const root of roots) if (blocked.has(root) && [...reachable.get(root)].some(key => approvedSkippedNodes.has(key))) {
                    for (const key of reachable.get(root)) if (!activeKeys.has(key)) approvedImpacts.delete(key);
                }
            }
            if (!download) actions.filter(action => action.release).forEach(action => downloadApprovals.set(action.key, downloadSignature(action.release)));
            const plan = { nodes, roots, reachable, blocked, actions, bytes, downloaded: download, downloadApprovals,
                approvedImpact: JSON.stringify([...approvedImpacts.values()].sort((a, b) => a[0].localeCompare(b[0]))) };
            if (isCurrent && !isCurrent()) throw Object.assign(new Error('安装预览已更新'), { code: 'INSTALL_CANCELLED' });
            api.setBatchInstallPlan?.(plan, { preserveOtherItems: preserveProgress });
            return plan;
        } catch (error) { nodes.forEach(releaseNode); throw error; }
        finally { preparedCache.clear(); }
    }

    function releasePrepared(plan) {
        plan?.nodes.forEach(node => { window.modHubClearMarketPreparationProgress?.(node.mod.name); node.prepared = null; });
        for (const action of plan?.actions || []) action.prepared = null;
        plan?.compatibilityChanges?.clear();
        window.modHubCompatibility?.releaseCandidateData?.(plan?.compatibilityResult);
    }

    const actionBoots = action => action.effectiveBoots || action.prepared?.boots || (action.type === 'enable' && action.local ? [localBoot(action.local)] : []);
    const downloadSignature = release => JSON.stringify([release?.candidateKey || release?.tagName, release?.version,
        release?.packageEdition?.id, (release?.assets || []).map(asset => [asset.name, asset.downloadUrl, asset.digest, asset.size, asset.bootName, asset.version])]);

    function actionImpact(action) {
        return [action.key, action.type,
            actionBoots(action)[0]?.version || action.release?.version || localBoot(action.local)?.version,
            downloadSignature(action.release), action.switchGroup?.targetName || '', [...(action.switchGroup?.disabledNames || [])].sort(),
            (action.release?.assets || []).map(asset => [asset.downloadUrl, Boolean(asset.optional && asset.bootName && isDisabled(asset.bootName))])
        ];
    }

    function planImpact(plan) {
        return JSON.stringify(plan.actions.map(actionImpact).sort((a, b) => a[0].localeCompare(b[0])));
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

    function planHtml(plan, runtimes, { inline = false, recorded = false } = {}) {
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
                return `<span class="modhub-version-asset-name grey"><strong class="${asset.optional ? 'purple' : 'gold'}">${escape(roleText(asset))}</strong>：<span data-modhub-i18n-ignore>${escape(asset.name)}</span><span class="modhub-version-meta">${label('当前')}：${escape(profile?.version || t('未安装'))} · ${label('所选')}：${escape(component?.version || asset.version || action.release?.version || t('版本未知'))} · ${escape(t(state))} · ${assetSizeText(asset)}</span></span>`;
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
            return `<div class="modhub-install-plan-item"><div class="modhub-install-plan-heading"><div class="modhub-install-plan-identity"><svg class="modhub-install-plan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.25l9 4.5"/></svg><strong class="modhub-install-plan-name" data-modhub-i18n-ignore>${escape(action.mod.name)}</strong></div><span class="modhub-install-plan-operation gold">${label(operation)} <span data-modhub-i18n-ignore>${escape(version)}</span></span></div>
                ${action.local && action.type !== 'enable' ? `<div class="modhub-install-plan-meta">${label(recorded ? '安装前版本' : '当前已安装')}：<span data-modhub-i18n-ignore>${escape(action.local.version)}</span></div>` : ''}
                <p class="modhub-install-plan-meta ${status === 'incompatible' ? 'red' : ''}">${label(gameNote)}${gameRanges.length ? ` ${label('支持范围')}：DoL ${escape(gameRanges.map(item => t(rangeText(item.version))).join('；'))}。` : ''}</p>
                ${assets.length ? `<details class="modhub-version-assets modhub-install-plan-files"><summary>${label('查看安装包')}${assets.length > 1 ? ` (${label('{count} 个', { count: assets.length })})` : ''}</summary>${componentHtml}</details>` : ''}
                ${action.switchGroup?.disabledNames.length ? `<div class="modhub-install-plan-warning gold">安装成功后停用：${escape(action.switchGroup.disabledNames.join('、'))}。保留旧安装包，可在模组管理中重新选择。</div>` : ''}
                ${existing.length ? `<details class="modhub-version-assets modhub-install-plan-prerequisites"><summary><span class="green">${label('前置模组已就绪（{count} 项）', { count: existing.length })}</span></summary>${existing.map(providerHtml).join('')}</details>` : ''}</div>`;
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
            : `<p class="modhub-install-plan-meta">${plan.downloaded ? recorded ? '本次未取得完整兼容性检查结果，请结合游戏运行情况核对。' : '尚未完成兼容性检查。您可以取消安装，稍后重试。' : onlyEnable ? '启用前会检查前置模组和兼容性。' : '下载后会自动检查前置模组和兼容性。'}</p>`;
        const requirements = plan.actions.flatMap(action => requiredDependencies(action.mod).map(item => {
            const name = api.getMarketMods().find(mod => (mod.bootNames || []).includes(item.bootName))?.name || item.bootName || item.id;
            return `<p>${label('【{name}】需要【{dependency}】{details}。', { name: action.mod.name, dependency: name, details: item.version && item.version !== '*' ? t('，版本要求：{range}', { range: t(rangeText(item.version)) }) : '' })}${item.evidence ? `<span class="modhub-install-plan-meta">${label('作者说明')}：<span data-modhub-i18n-ignore>${escape(item.evidence)}</span></span>` : ''}</p>`;
        }));
        if (inline) return `<div class="modhub-install-plan">${compatibilityHtml}<p class="modhub-install-plan-intro">${label('本次安装 {count} 项{details}。', { count: targets.length, details: dependencies.length ? t('，同时处理 {count} 项前置', { count: dependencies.length }) : '' })}</p>
            ${dependencies.length ? `<div class="modhub-install-plan-inline-dependencies grey">${dependencies.map(action => `<span>${escape(action.mod.name)} ${escape(action.release?.version || localBoot(action.local)?.version || '')} · ${label(action.type === 'enable' ? '启用' : action.local ? '更换版本' : '安装')}</span>`).join('')}</div>` : ''}
            ${plan.actions.filter(action => action.switchGroup?.disabledNames.length).map(action => `<p class="gold">安装【${escape(action.mod.name)}】后停用：${escape(action.switchGroup.disabledNames.join('、'))}。保留旧安装包，可在模组管理中重新选择。</p>`).join('')}
            ${warnings.length ? `<div class="modhub-install-plan-warning">${warnings.map(warning => `<p>${escape(t(warning))}</p>`).join('')}</div>` : ''}
            ${runtimes.length || requirements.length ? `<details class="modhub-install-plan-details"><summary>查看安装详情</summary>${requirements.join('')}${runtimes.map(item => `<p>【${escape(item.modName)}】需要 ${escape(item.name)} ${escape(rangeText(item.range))}。当前版本：${escape(item.current || '无法识别')}；${item.status === 'compatible' ? '已满足要求' : item.status === 'incompatible' ? '不满足要求，请更换模组或加载器版本' : '暂时无法确认，请查看模组说明'}。</p>`).join('')}</details>` : ''}</div>`;
        return `<div class="modhub-install-plan">${compatibilityHtml}<p class="modhub-install-plan-intro">${recorded ? '以下为安装处理前核对的内容。实际处理结果请查看各项状态。' : onlyEnable ? '确认后将启用以下模组。' : plan.downloaded ? '安装文件已准备好。确认后开始安装。' : '确认后将下载并安装以下内容。'}</p>
            <strong class="modhub-install-plan-section-title">${label('安装内容（{count} 项）', { count: targets.length })}</strong>${targets.map(actionHtml).join('')}
            ${dependencies.length ? `<strong class="modhub-install-plan-section-title">${label('同时安装或启用的前置（{count} 项）', { count: dependencies.length })}</strong>${dependencies.map(actionHtml).join('')}` : ''}
            ${warnings.length ? `<div class="modhub-install-plan-warning">${warnings.map(warning => `<p>${escape(t(warning))}</p>`).join('')}</div>` : ''}
            ${runtimes.length || requirements.length ? `<details class="modhub-install-plan-details"><summary>查看安装详情</summary>
                ${requirements.length ? `<div class="modhub-install-plan-meta"><strong>前置要求</strong>${requirements.join('')}</div>` : ''}
                ${runtimes.length ? `<div class="modhub-install-plan-meta"><strong>加载器与运行库</strong>${runtimes.map(item => `<p>【${escape(item.modName)}】需要 ${escape(item.name)} ${escape(rangeText(item.range))}。当前版本：${escape(item.current || '无法识别')}；${item.status === 'compatible' ? '已满足要求' : item.status === 'incompatible' ? '不满足要求，请更换模组或加载器版本' : '暂时无法确认，请查看模组说明'}。</p>`).join('')}</div>` : ''}
            </details>` : ''}</div>`;
    }

    function collectPlanRisks(plan, runtimes) {
        const api = market(), approved = [], risks = [], gameProblems = new Set();
        const addRisk = (name, reason, related = [], key = `【${name}】${reason}`) => risks.push({ name, reason, names: [name, ...related], key });
        for (const action of plan.actions) {
            const boots = actionBoots(action), version = boots[0]?.version || action.release?.version;
            if (action.local && version && api.compareVersions(version, action.local.version, action.mod) < 0) addRisk(action.mod.name, `将从 ${action.local.version} 降至 ${version || '未知版本'}`);
            const gameKey = (name, componentVersion, range) => JSON.stringify(['game', versions().getGameIdentity?.() || versions().getGameVersion(), action.key, name, componentVersion, range]);
            if (action.release?.compatibility?.status === 'incompatible') addRisk(action.mod.name, '作者注明此版本不支持当前游戏', [], gameKey('', version, action.release.compatibility.gameVersionRange || action.release.compatibility.targetGameVersion || ''));
            else if (action.release?.compatibility?.branchUnverified || action.release?.compatibility?.branchMismatch) addRisk(action.mod.name, action.release.compatibility.reason, [], gameKey('', version, action.release.compatibility.gameVersionRange || action.release.compatibility.targetGameVersion || ''));
            for (const risk of api.getPreparedCompatibilityRisks?.(boots) || []) {
                approved.push(risk.key);
                if (risk.status === 'incompatible' || risk.branchUnverified || risk.branchMismatch) {
                    gameProblems.add(risk.name);
                    addRisk(risk.name, risk.branchUnverified || risk.branchMismatch ? risk.reason : `需要游戏版本：${rangeText(risk.range)}`, [action.mod.name], gameKey(risk.name === boots[0]?.name ? '' : risk.name, risk.version, risk.range));
                }
            }
        }
        for (const runtime of runtimes.filter(item => item.status === 'incompatible')) addRisk(runtime.modName, `需要 ${runtime.name} ${rangeText(runtime.range)}，当前为 ${runtime.current}`);
        for (const node of plan.nodes.values()) {
            if (node.skipped) addRisk(node.mod.name, `已跳过此前置${node.local ? `，保留本地 ${localBoot(node.local)?.version || '未知版本'}` : ''}。${node.requirements.map(item => `【${plan.nodes.get(item.parent)?.mod.name}】需要 ${item.bootName || node.mod.name} ${rangeText(item.version)}`).join('；')}。缺少符合要求的前置，相关模组可能无法运行`, node.requirements.map(item => plan.nodes.get(item.parent)?.mod.name).filter(Boolean));
            if (!node.issue && node.unresolved.length) addRisk(node.mod.name, `缺少前置：${node.unresolved.map(item => `${item.bootName || item.id} ${rangeText(item.version)}`).join('；')}`);
        }
        const affectedNames = new Set(plan.actions.flatMap(action => [action.mod.name, ...(action.mod.bootNames || []), ...actionBoots(action).map(boot => boot.name), ...(action.switchGroup?.disabledNames || [])]));
        for (const finding of plan.compatibilityResult?.compatibility?.findings || []) {
            if (finding.kind === 'configuration' && finding.status === 'problem' && finding.id !== 'configuration-different') {
                const names = finding.mods?.length ? finding.mods : finding.query ? [finding.query]
                    : [...String(finding.evidence || '').matchAll(/【([^】]+)】/g)].map(match => match[1]);
                if (!names.some(name => affectedNames.has(name))) continue;
                const target = names[1];
                const alreadyDescribed = /^(dependency|version)-/.test(finding.id || '') && (
                    [...plan.nodes.values()].some(node => node.skipped && node.requirements.some(item => item.bootName === target)
                        || !node.issue && node.unresolved.some(item => item.bootName === target))
                    || target === 'GameVersion' && gameProblems.has(names[0])
                    || runtimes.some(runtime => runtime.status === 'incompatible' && runtime.name === target
                        && plan.actions.some(action => action.mod.name === runtime.modName && actionBoots(action).some(boot => boot.name === names[0]))));
                if (alreadyDescribed) continue;
                addRisk(names[0], `${finding.title}：${finding.evidence || finding.advice || ''}`, names.slice(1), JSON.stringify(['configuration', finding.id, finding.evidence]));
            }
        }
        return { risks: [...new Map(risks.map(risk => [risk.key, risk])).values()], approved };
    }

    function renderPlanRisks(plan, risks) {
        if (!risks.length) return '';
        const api = market();
        const affected = plan.actions.filter(action => [action.mod.name, ...actionBoots(action).map(boot => boot.name)]
            .some(name => name && risks.some(risk => risk.names.includes(name))));
        const context = `当前游戏版本：${gameVersionLabel() || '未识别'}${affected.length ? '\n\n' : ''}` + affected.map(action => {
            const boots = actionBoots(action);
            const main = `【${action.mod.name}】\n当前已安装版本：${action.local ? localBoot(action.local)?.version || '未识别' : '未安装'}；所选模组版本：${boots[0]?.version || action.release?.version || '未识别'}`;
            const companions = boots.slice(1).filter(boot => risks.some(risk => risk.names.includes(boot.name))).map(boot => {
                const local = api.getLocalInstalledProfiles().find(profile => normalize(profile.name) === normalize(boot.name));
                return `【${boot.name}】\n当前已安装版本：${local ? localBoot(local)?.version || '未识别' : '未安装'}；所选模组版本：${boot.version || '未识别'}`;
            });
            return [main, ...companions].join('\n\n');
        }).join('\n\n');
        const groups = new Map();
        for (const risk of risks) {
            if (!groups.has(risk.reason)) groups.set(risk.reason, new Set());
            groups.get(risk.reason).add(risk.name);
        }
        return `<div class="modhub-install-plan-risks"><strong class="red">请注意：所选内容存在以下问题</strong>${[...groups].map(([reason, names]) => `<div class="modhub-install-plan-warning">${api.formatVersionRiskMessage(`${reason}\n涉及模组：${[...names].map(name => `【${name}】`).join('、')}`)}</div>`).join('')}<details class="modhub-version-error-details" data-detail-key="risk-versions"><summary>查看版本详情</summary><div>${api.formatVersionRiskMessage(context)}</div></details></div>`;
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
                if (bootSnapshot(localBoot(getLocal(action.mod))) !== action.localSnapshot
                    || Boolean(getLocal(action.mod) && isDisabled(getLocal(action.mod).name)) !== action.localDisabledSnapshot) throw new Error('本地版本、启禁状态或依赖已改变，请重新核对安装计划。');
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

    function showBlockedPlan(plan) {
        const items = [...plan.blocked].map(([key, reason]) => {
            const root = plan.nodes.get(key);
            const issues = [...(plan.reachable.get(key) || [key])].map(id => plan.nodes.get(id)).filter(node => node.issue);
            const reasons = (issues.length ? issues : [{ ...root, issue: reason }]).map(node => {
                const download = node.downloadFailureDetails;
                const dependency = node.key !== key ? `<p class="modhub-install-error-dependency grey">前置模组：<strong data-modhub-i18n-ignore>${escape(node.mod.name)}</strong></p>` : '';
                if (!download) return `${dependency}<p class="modhub-install-error-cause">${escape(node.issue).replace(/\n/g, '<br>')}</p>`;
                const groups = new Map();
                for (const failure of download.failures) {
                    if (!groups.has(failure.message)) groups.set(failure.message, new Set());
                    groups.get(failure.message).add(failure.mirrorName);
                }
                return `${dependency}<p class="modhub-install-error-cause red">安装包下载失败。</p>
                    <div class="modhub-install-error-file"><span class="grey">安装包</span><strong data-modhub-i18n-ignore>${escape(download.fileName)}</strong></div>
                    <details class="modhub-version-group modhub-install-error-details" open>
                        <summary class="modhub-version-group-summary">下载线路详情<span class="grey">${download.failures.length} 条记录</span></summary>
                        ${[...groups].map(([message, mirrors]) => `<div class="modhub-install-error-group"><p class="modhub-install-error-cause">${escape(message).replace(/\n/g, '<br>')}</p><p class="modhub-install-error-mirrors grey">${[...mirrors].map(escape).join('、')}</p></div>`).join('')}
                    </details>`;
            }).join('');
            return `<section class="modhub-install-error-item"><h3 class="gold" data-modhub-i18n-ignore>${escape(root.mod.name)}</h3>${reasons}</section>`;
        }).join('');
        return window.modHubConfirm({
            title: '安装计划无法执行',
            message: '没有需要安装的项目',
            trustedMessageHtml: items ? `<p class="modhub-install-error-intro">本次选择的 <strong class="gold">${plan.blocked.size}</strong> 个模组无法继续安装。</p>${items}<p class="modhub-install-error-advice grey">请根据错误详情处理后重试。下载失败时，可稍后重试或切换下载线路。</p>` : '',
            confirmText: '确定', cancelText: '', dialogClass: 'modhub-install-dialog modhub-install-error-dialog'
        });
    }

    function slicePlan(plan, roots) {
        const keys = new Set([...roots].flatMap(key => [...(plan.reachable.get(key) || [key])]));
        return { ...plan, roots, nodes: new Map([...plan.nodes].filter(([key]) => keys.has(key))),
            reachable: new Map([...plan.reachable].filter(([key]) => roots.has(key))),
            blocked: new Map([...plan.blocked].filter(([key]) => roots.has(key))),
            actions: plan.actions.filter(action => keys.has(action.key)) };
    }

    function planFootprint(plan) {
        const read = new Set(), write = new Set(), actions = new Set(plan.actions.map(action => action.key));
        for (const node of plan.nodes.values()) {
            const names = [`key:${node.key}`, ...(node.mod.bootNames || []).map(name => `boot:${normalize(name)}`),
                ...[localBoot(node.local), ...(node.effectiveBoots || node.prepared?.boots || [])].filter(Boolean)
                    .flatMap(boot => getDependencyBootNames(boot).map(name => `boot:${normalize(name)}`)),
                ...(node.release?.assets || []).filter(asset => asset.bootName).map(asset => `boot:${normalize(asset.bootName)}`),
                ...[node.switchGroup?.targetName, ...(node.switchGroup?.disabledNames || [])].filter(Boolean).map(name => `boot:${normalize(name)}`)];
            names.forEach(name => { read.add(name); if (actions.has(node.key)) write.add(name); });
        }
        return { read, write };
    }

    const footprintsOverlap = (left, right) => [...left.write].some(name => right.read.has(name))
        || [...right.write].some(name => left.read.has(name));

    function reportInstallOutcome(outcome, deferred, restoreContext) {
        const count = status => [...outcome.results.values()].filter(result => result.status === status).length;
        window.modHubShowToast(`安装处理完成：成功 ${count('success')} 项，失败 ${count('failed')} 项，跳过 ${count('skipped')} 项${deferred ? `；暂未处理前置 ${deferred} 项` : ''}`, count('failed') || deferred ? 'warning' : 'info');
        if (outcome.changed.size) window.modHubRegisterOperationReload(restoreContext, '所选模组及前置已处理，重新载入后生效。', { isFramework: [...outcome.changed].some(name => window.modHubIsFrameworkMod?.(name)) });
    }

    function createBatchDownloads(plan, restoreContext) {
        const api = market(), entries = new Map(), failures = new Map(), consumed = new Set();
        const actions = plan.actions.filter(action => action.release && action.type !== 'enable'
            && plan.downloadApprovals.get(action.key) === downloadSignature(action.release));
        const size = node => {
            const assets = api.getReleaseInstallAssets(node.release);
            return assets.length && assets.every(asset => Number(asset.size) > 0)
                ? assets.reduce((sum, asset) => sum + Number(asset.size), 0) : 0;
        };
        let closed = false;
        const cancelled = () => closed || stopped() || restoreContext?.cancelled;
        const start = (node, limit) => {
            const entry = { node, limit, signature: downloadSignature(node.release), prepared: null, failure: null };
            entries.set(node.key, entry);
            entry.promise = (async () => {
                try {
                    entry.prepared = await api.downloadAndInstallMod(node.mod, api.getCurrentMirrorId(), {
                        releaseInfo: node.release, prepareOnly: true, batchMode: true, maxPreparedBytes: limit,
                        onFailure: (reason, code, error) => { entry.failure = [reason, code, error]; }
                    });
                    if (entry.prepared) entry.limit = Number(entry.prepared.bytes) || 0;
                } catch (error) { entry.failure = [error.message || '安装包下载失败', error.code, error]; }
                if (!entry.prepared && !entry.failure) entry.failure = ['安装包预检失败'];
                return entry;
            })();
            return entry;
        };
        const discard = async entry => {
            await entry.promise;
            if (entry.failure) failures.set(entry.node.key, entry);
            entry.prepared = null; entries.delete(entry.node.key);
            window.modHubClearMarketPreparationProgress?.(entry.node.mod.name);
        };
        return {
            async take(node, available, onFailure) {
                if (cancelled()) throw Object.assign(new Error('已停止后续下载'), { code: 'INSTALL_CANCELLED' });
                const failure = failures.get(node.key);
                failures.delete(node.key);
                if (failure?.signature === downloadSignature(node.release)) {
                    consumed.add(node.key); onFailure(...failure.failure); return false;
                }
                let entry = entries.get(node.key);
                if (entry && entry.signature !== downloadSignature(node.release)) { await discard(entry); entry = null; }
                let other = [...entries.values()].find(item => item !== entry);
                // 大小未知时独占剩余预算；需要更多空间时先释放尚未使用的预取包。
                if (other && (!size(node) || size(node) + other.limit > available)) { await discard(other); other = null; }
                if (cancelled()) throw Object.assign(new Error('已停止后续下载'), { code: 'INSTALL_CANCELLED' });
                const next = !other && size(node) ? actions.find(action => action.key !== node.key && !consumed.has(action.key)
                    && !entries.has(action.key) && !failures.has(action.key) && size(action) > 0 && size(node) + size(action) <= available) : null;
                if (!entry) entry = start(node, available - (other?.limit || (next ? size(next) : 0)));
                if (next && !cancelled() && entry.limit + size(next) <= available) start(next, size(next));
                await entry.promise;
                entries.delete(node.key); consumed.add(node.key);
                const prepared = entry.prepared; entry.prepared = null;
                if (!prepared) onFailure(...(entry.failure || ['安装包预检失败']));
                return prepared;
            },
            async close() {
                closed = true;
                await Promise.all([...entries.values()].map(discard));
                failures.clear();
            }
        };
    }

    async function runIncrementally(reviewed, updateOnly, restoreContext, languageAcknowledged) {
        const initialPlan = reviewed.initialPlan, pending = reviewed.selections.slice();
        const results = new Map(), changed = new Set(), protectedNames = new Map();
        const downloads = createBatchDownloads(initialPlan, restoreContext);
        let handled = false, deferred = 0, previousPlan;
        try {
            while (pending.length && !stopped() && !restoreContext?.cancelled) {
                const group = [pending.shift()];
                let initial, footprint, expanded;
                do {
                    initial = slicePlan(initialPlan, new Set(group.map(selection => keyOf(selection.mod))));
                    footprint = planFootprint(initial); expanded = false;
                    for (let index = 0; index < pending.length; index++) {
                        const candidate = slicePlan(initialPlan, new Set([keyOf(pending[index].mod)]));
                        if (!footprintsOverlap(footprint, planFootprint(candidate))) continue;
                        group.push(...pending.splice(index--, 1)); expanded = true;
                    }
                } while (expanded);
                const execution = { group: true, protectedNames, previousPlan, downloads, shouldMerge: plan => pending.length && (
                    [...plan.nodes.keys()].some(key => !initial.nodes.has(key))
                    || footprintsOverlap(planFootprint(plan), planFootprint(slicePlan(initialPlan, new Set(pending.map(selection => keyOf(selection.mod))))))) };
                if (!pending.length) execution.shouldMerge = null;
                let outcome = await run({ ...reviewed, selections: group, initialPlan: initial, initialImpact: planImpact(initial) }, updateOnly, restoreContext, languageAcknowledged, execution);
                if (outcome?.pendingPlan) {
                    // 包体揭示了额外依赖时，先合并尚未处理的目标，避免提前写入旧前置。
                    const prepared = outcome.pendingPlan;
                    group.push(...pending.splice(0));
                    initial = slicePlan(initialPlan, new Set(group.map(selection => keyOf(selection.mod))));
                    const initialImpact = JSON.stringify([...new Map([...JSON.parse(planImpact(initial)), ...JSON.parse(prepared.approvedImpact)].map(impact => [impact[0], impact])).values()]);
                    initial.nodes = new Map([...initial.nodes, ...[...prepared.nodes].filter(([key, node]) => node.release || !initial.nodes.has(key))]);
                    initial.downloadApprovals = new Map([...initial.downloadApprovals, ...prepared.downloadApprovals]);
                    const preparedCache = new Map([...prepared.nodes].filter(([, node]) => node.prepared)
                        .map(([key, node]) => [key, { release: node.release, prepared: node.prepared }]));
                    releasePrepared(prepared);
                    execution.shouldMerge = null; execution.preparedCache = preparedCache;
                    try {
                        outcome = await run({ ...reviewed, acknowledged: outcome.acknowledged, selections: group, initialPlan: initial, initialImpact }, updateOnly, restoreContext, languageAcknowledged, execution);
                    } finally { preparedCache.clear(); releasePrepared(prepared); }
                }
                if (outcome?.results) {
                    previousPlan = outcome.plan;
                    handled = true; deferred += outcome.deferred || 0;
                    outcome.results.forEach((value, key) => results.set(key, value));
                    outcome.changed.forEach(name => changed.add(name));
                    for (const [key, result] of outcome.results) if (result.status === 'success' && outcome.plan.roots.has(key)) {
                        for (const id of outcome.plan.reachable.get(key) || [key]) {
                            const node = outcome.plan.nodes.get(id);
                            if (node.skipped) continue;
                            for (const boot of [localBoot(getLocal(node.mod)), ...(node.effectiveBoots || [])].filter(Boolean)) {
                                for (const name of getDependencyBootNames(boot)) protectedNames.set(`boot:${normalize(name)}`, node.mod.name);
                            }
                        }
                    }
                } else for (const selection of group) results.set(keyOf(selection.mod), { status: execution.failureReason ? 'failed' : 'skipped', reason: execution.failureReason || '本次未完成安装' });
                if (execution.cancelled) break;
            }
            await downloads.close();
            for (const selection of pending) results.set(keyOf(selection.mod), { status: 'skipped', reason: '已停止，尚未安装' });
            if (!handled) return false;
            const outcome = { results, changed, changedMods: changed };
            reportInstallOutcome(outcome, deferred, restoreContext);
            return outcome;
        } finally { await downloads.close(); }
    }

    async function run(reviewed, updateOnly, restoreContext, languageAcknowledged = new Set(), execution = {}) {
        const selections = reviewed?.selections || [];
        if (!execution.group && selections.length > 1 && reviewed.initialPlan) return runIncrementally(reviewed, updateOnly, restoreContext, languageAcknowledged);
        let plan, initialPlan = reviewed?.initialPlan;
        let keepPrepared = false;
        const initialImpact = reviewed?.initialImpact || initialPlan && planImpact(initialPlan);
        const acknowledged = new Set(reviewed?.acknowledged || []);
        try {
            if (!selections.length || !initialPlan || stopped()) return false;
            for (const selection of selections) if (!await confirmLanguageCoexistence(selection.mod, languageAcknowledged) || stopped()) return false;
            plan = initialPlan;
            if (execution.previousPlan) await assertPlanCompatibility(execution.previousPlan);
            if (!plan.actions.length) { await showBlockedPlan(plan); return false; }
            await window.modHubLoadModManageState?.(true);
            for (const node of plan.nodes.values()) {
                if (bootSnapshot(localBoot(getLocal(node.mod))) !== node.localSnapshot
                    || Boolean(getLocal(node.mod) && isDisabled(getLocal(node.mod).name)) !== node.localDisabledSnapshot) throw new Error('本地模组或前置已改变，请重新生成安装计划。');
            }
            selections.forEach(({ mod }) => market().updateDownloadProgress?.(mod.name, null, '正在准备下载与包体核验，请稍候。', 'preparing'));
            plan = await preparePlan(selections, updateOnly, { initialPlan, initialImpact, acknowledged,
                preparedCache: execution.preparedCache, preserveProgress: Boolean(execution.group), mergeOnNewDependencies: Boolean(execution.shouldMerge),
                protectedNames: execution.protectedNames, downloads: execution.downloads });
            if (execution.shouldMerge?.(plan)) { keepPrepared = true; return { pendingPlan: plan, acknowledged: [...acknowledged] }; }
            if (!plan.actions.length) { await showBlockedPlan(plan); return false; }
            const protectedName = [...planFootprint(plan).write].find(name => execution.protectedNames?.has(name));
            if (protectedName) throw new Error(`本次变更会替换或停用此前已完成项目使用的【${execution.protectedNames.get(protectedName)}】。为保留已完成项目，已停止处理当前组。请核对前置版本后重试。`);
            const actualRuntimes = runtimeChecks(plan);
            if (execution.previousPlan) await assertPlanCompatibility(execution.previousPlan);
            await checkPlanCompatibility(plan);
            const checkDetailsHtml = `<details class="modhub-install-result-details"><summary>查看安装详情</summary>${planHtml(plan, actualRuntimes, { recorded: true })}</details>`;
            for (const key of plan.roots) market().setBatchInstallCompatibility?.(plan.nodes.get(key).mod.name, checkDetailsHtml);
            const collected = collectPlanRisks(plan, actualRuntimes);
            const newRisks = collected.risks.filter(risk => !acknowledged.has(risk.key));
            if (planImpact(plan) !== plan.approvedImpact || newRisks.length) {
                const changed = await window.modHubConfirm({ title: '安装前请确认',
                    message: '检查发现需要重新确认的安装内容，请核对后继续。',
                    trustedMessageHtml: renderPlanRisks(plan, newRisks) + planHtml(plan, actualRuntimes),
                    confirmText: newRisks.length ? '仍然安装' : '确认并安装', cancelText: '取消',
                    confirmType: newRisks.length ? 'danger' : 'primary', dialogClass: 'modhub-install-dialog modhub-version-dialog' });
                if (!changed || stopped()) { execution.cancelled = true; return false; }
                newRisks.forEach(risk => acknowledged.add(risk.key));
            }
            await assertPlanCompatibility(plan);
            const outcome = await executePlan(plan, collected.approved, restoreContext, languageAcknowledged);
            for (const key of plan.roots) if (outcome.results.get(key)?.status === 'success') market().batchInstallState?.selected?.delete(key);
            market().renderMarketCards?.();
            const deferred = [...plan.nodes.values()].reduce((count, node) => count + (node.skipped ? 1 : 0) + (!node.issue ? node.unresolved.length : 0), 0);
            if (!execution.group) reportInstallOutcome(outcome, deferred, restoreContext);
            return { ...outcome, changedMods: outcome.changed, ...(execution.group ? { plan, deferred } : {}) };
        } catch (error) {
            if (error.code === 'INSTALL_CANCELLED') execution.cancelled = true;
            if (error.code !== 'INSTALL_CANCELLED') {
                execution.failureReason = error.message || '安装准备失败';
                if (execution.group) {
                    for (const node of (plan || initialPlan).nodes.values()) if ((plan || initialPlan).actions.some(action => action.key === node.key)) {
                        market().setBatchInstallStatus?.(node.mod.name, 'error', error.message || '安装准备失败');
                    }
                } else market().failBatchInstallProgress?.(error.message || '安装准备失败');
                await window.modHubAlert(error.message || '安装准备失败', '安装未完成');
            }
            return false;
        } finally {
            if (!keepPrepared) { releasePrepared(plan); if (initialPlan !== plan) releasePrepared(initialPlan); }
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
            const languageAcknowledged = new Set();
            if (!await confirmLanguageCoexistence(mod, languageAcknowledged)) return false;
            const reviewed = await selectBatch([mod], false, { single: true });
            if (!reviewed) return false;
            const outcome = await run(reviewed, false, restoreContext, languageAcknowledged);
            return Boolean(outcome?.results?.get(keyOf(mod))?.status === 'success'
                || !reviewed.selections.some(selection => keyOf(selection.mod) === keyOf(mod))
                    && reviewed.selections.some(selection => outcome?.results?.get(keyOf(selection.mod))?.status === 'success'));
        } catch (error) { await window.modHubAlert(error.message || '发布版本读取失败', '无法选择版本'); return false; }
        finally { window.modHubClearMarketPreparationProgress?.(progressName); }
    }

    async function installAddons(parent, { restoreContext } = {}) {
        if (!parent || parent.contentType === 'spell' || !market().getOptionalAddonMods?.(parent)?.length) return false;
        if (!restoreContext) return market().runInstallTask(context => installAddons(parent, { restoreContext: context }),
            { label: '市场附加内容安装', names: [parent.name] });
        if (market().batchInstallState) market().batchInstallState.stopRequested = false;
        try {
            const reviewed = await selectBatch([parent], false, { single: true, addonsOnly: true });
            if (!reviewed) return false;
            const outcome = await run(reviewed, false, restoreContext, new Set());
            return [...(outcome?.results?.values() || [])].some(result => result.status === 'success');
        } catch (error) { await window.modHubAlert(error.message || '发布版本读取失败', '无法选择版本'); return false; }
        finally { window.modHubClearMarketPreparationProgress?.(parent.name); }
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
            const unique = [...new Map(members.map(member => [keyOf(member), member])).values()];
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

    window.modHubMarketInstaller = { install, installAddons, installBatch, selectLanguage, satisfiesDependency: satisfies, getDependencyBootNames };
})();
