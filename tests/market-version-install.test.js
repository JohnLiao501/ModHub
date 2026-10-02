// ModHub 历史版本选择与真实包体依赖安装回归。
const { assert, createBaseSandbox, createStubElement, loadScripts, loadManager } = require('./helpers');

const reviewedPlan = fixture => [...fixture.prompts].reverse().find(options => ['请确认安装计划', '请再次核对安装计划'].includes(options.title));

function groupedChoiceDialog(sb, dialog = createStubElement()) {
    const area = dialog.querySelector('#modHubVersionChoices');
    const query = area.querySelector.bind(area);
    const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let html = '', groups = [], radios = [], labels = [], list = createStubElement();
    Object.defineProperty(area, 'innerHTML', { get: () => html, set(value) {
        [...groups, ...radios].forEach(node => { node.isConnected = false; });
        html = value; groups = []; radios = []; labels = []; list = createStubElement();
        const headers = [...html.matchAll(/<details class="modhub-version-group" data-group-key="([^"]+)"([^>]*)>/g)];
        headers.forEach((match, index) => {
            const group = createStubElement('details');
            group.dataset.groupKey = decode(match[1]); group.open = /\bopen\b/.test(match[2]); group.isConnected = true;
            const inputs = [];
            for (const radio of html.slice(match.index + match[0].length, headers[index + 1]?.index).matchAll(/<input type="radio" name="modHubMarketVersion" value="([^"]+)"([^>]*)>/g)) {
                const input = createStubElement('input'), label = createStubElement('label');
                input.name = 'modHubMarketVersion'; input.value = decode(radio[1]); input.checked = /\bchecked\b/.test(radio[2]); input.isConnected = true;
                input.focus = () => { sb.document.activeElement = input; };
                label.querySelector = () => input;
                inputs.push(input); radios.push(input); labels.push(label);
            }
            group.querySelectorAll = () => inputs;
            groups.push(group);
        });
    } });
    area.querySelector = selector => selector === '.modhub-version-list' ? list : query(selector);
    area.querySelectorAll = selector => selector === '.modhub-version-group' ? groups : selector === '.modhub-version-option' ? labels : radios;
    return { dialog, area, get groups() { return groups; }, get radios() { return radios; }, get list() { return list; } };
}

function fixture(definitions, installed = []) {
    const profiles = new Map(installed.map(boot => [boot.name, { ...boot, bootJson: boot }]));
    const events = [], prompts = [], alerts = [], preparedCalls = [], progress = new Map();
    const mods = definitions.map(definition => ({ id: definition.id, identityId: definition.id, name: definition.id,
        bootNames: [definition.boot?.name || definition.id], dependencies: definition.directoryDependencies || [],
        githubUrl: `https://github.com/ModHubTests/${definition.id}`, version: definition.version || definition.boot?.version || '1.0.0' }));
    const byId = new Map(definitions.map(definition => [definition.id, definition]));
    const compare = (left, right) => {
        const a = String(left || '').match(/\d+/g) || [], b = String(right || '').match(/\d+/g) || [];
        for (let index = 0; index < Math.max(a.length, b.length); index++) {
            const delta = Number(a[index] || 0) - Number(b[index] || 0); if (delta) return Math.sign(delta);
        }
        return 0;
    };
    const satisfies = (version, requirement) => {
        if (!requirement || requirement === '*') return true;
        const base = String(requirement).replace(/^[^\d]*/, '');
        if (requirement.startsWith('>=')) return compare(version, base) >= 0;
        if (requirement.startsWith('<=')) return compare(version, base) <= 0;
        if (requirement.startsWith('>')) return compare(version, base) > 0;
        if (requirement.startsWith('<')) return compare(version, base) < 0;
        if (requirement.startsWith('^')) return compare(version, base) >= 0 && String(version).split('.')[0] === base.split('.')[0];
        return compare(version, base) === 0;
    };
    const sb = createBaseSandbox({ AbortController });
    loadScripts(sb, ['javascript/modhub-dialog.js', 'javascript/modhub-restore.js', 'javascript/modhub-manager.js', 'javascript/modhub-market.js']);
    const runtimeMarket = sb.modHubMarket, offerReload = sb.modHubOfferReload;
    sb.modHubEscapeHtml = value => String(value).replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[character]));
    sb.modHubShowToast = () => {};
    sb.modHubAlert = async message => { alerts.push(message); };
    sb.modHubGetModInfo = name => ({ bootJson: profiles.get(name)?.bootJson });
    sb.modHubLoadModManageState = async () => {};
    sb.modHubOfferReload = async () => { events.push('reload'); };
    sb._modHubModState = { sideDisabled: [], sideMods: [] };
    sb.modHubToggleSideMod = async name => { events.push(`enable:${name}`); sb._modHubModState.sideDisabled = sb._modHubModState.sideDisabled.filter(item => item !== name); return true; };
    const renderDialog = async options => {
        const dialog = createStubElement('div');
        await options.onRender?.(dialog);
        options.renderedHtml = dialog.querySelector(options.title.startsWith('选择【') ? '#modHubVersionChoices' : '#modHubBatchVersionChoices').innerHTML || options.trustedMessageHtml;
        return dialog;
    };
    sb.modHubConfirm = async options => {
        prompts.push(options); await renderDialog(options);
        if (options.canConfirm && !options.canConfirm()) return false;
        return options.customResult ? options.customResult() : true;
    };
    sb.modHubClearMarketPreparationProgress = name => { if (progress.get(name) === 'prepared') { progress.delete(name); return true; } return false; };
    sb.modHubMarket = {
        runInstallTask: runtimeMarket.runInstallTask,
        isInstallBusy: () => !!(runtimeMarket.isInstallBusy() || sb.modHubMarket.batchInstallState.running),
        getMarketModKey: mod => mod.id, getMarketMods: () => mods, getCurrentMirrorId: () => 'test',
        getLocalInstalledProfiles: () => [...profiles.values()],
        checkModInstallStatus: mod => { mod._matchedLocal = [...profiles.values()].find(profile => mod.bootNames.includes(profile.name)) || null; return mod._matchedLocal ? 'up_to_date' : 'not_installed'; },
        compareVersions: compare, isSameVersion: runtimeMarket.isSameVersion, satisfiesVersion: satisfies, getReleaseInstallAssets: release => release.assets,
        MAX_DOWNLOAD_BYTES: 256 * 1024 * 1024, batchInstallState: { selected: new Set(), stopRequested: false },
        renderMarketCards: () => {}, renderBatchInstallToolbar: () => {}, confirmInstallConflicts: async () => true,
        formatVersionRiskMessage: runtimeMarket.formatVersionRiskMessage,
        getPreparedCompatibilityRisks: () => [],
        downloadAndInstallMod: async (mod, mirror, options) => {
            const definition = byId.get(mod.id);
            if (options.prepareOnly) {
                events.push(`prepare:${mod.id}`);
                preparedCalls.push({ id: mod.id, key: options.releaseInfo.candidateKey, remaining: options.maxPreparedBytes });
                if (definition.prepareFailure) { options.onFailure(definition.prepareFailure); return false; }
                const selected = definition.packages?.[options.releaseInfo.candidateKey] || definition;
                const boots = selected.boots || [selected.boot || { name: mod.id, version: selected.version || '1.0.0' }];
                progress.set(mod.name, 'prepared');
                return { files: [{}], boots, bytes: selected.bytes || 1, releaseInfo: options.releaseInfo };
            }
            assert.ok(options.preparedPackage, '执行必须复用已核验包体');
            events.push(`install:${mod.id}`);
            if (definition.installFailure) return false;
            progress.set(mod.name, 'success');
            for (const boot of options.preparedPackage.boots) profiles.set(boot.name, { ...boot, bootJson: boot });
            return true;
        }
    };
    const candidates = mod => {
        const definition = byId.get(mod.id);
        if (definition.candidates) return definition.candidates;
        return [{ candidateKey: `release:${mod.id}`, selectedKey: `release:${mod.id}`, seriesKey: mod.id,
            version: definition.version || definition.boot?.version || '1.0.0', tagName: 'v1',
            assets: [{ name: `${mod.id}.zip`, downloadUrl: `https://example.com/${mod.id}.zip`, size: definition.assetSize || 1 }],
            compatibility: { status: definition.compatibility || 'compatible', evidence: 'declaration', reason: '测试适配声明' },
            ...(Object.hasOwn(definition, 'dependencies') ? { dependencies: definition.dependencies } : {}) }];
    };
    loadScripts(sb, ['javascript/modhub-market-versions.js']);
    const actualVersions = sb.modHubMarketVersions;
    sb.modHubMarketVersions = {
        getGameVersion: () => '0.5.0.0', getCandidateStatus: actualVersions.getCandidateStatus,
        formatVersionRange: actualVersions.formatVersionRange,
        assessCompatibility: actualVersions.assessCompatibility,
        fetchReleases: async mod => ({ releases: candidates(mod), page: 1, hasMore: false, stale: Boolean(byId.get(mod.id).stale), fetchedAt: '2026-09-29T00:00:00Z' }),
        buildCandidates: (mod, history) => history.releases,
        rankCandidates: (mod, releases) => ({ candidates: releases, recommendedKey: releases[0]?.compatibility.status === 'compatible' || releases[0]?.compatibility.evidence === 'filename' ? releases[0].candidateKey : '', gameVersion: '0.5.0.0' })
    };
    loadScripts(sb, ['javascript/modhub-market-install.js']);
    return { sb, mods, events, prompts, alerts, profiles, preparedCalls, progress, renderDialog, actualVersions, runtimeMarket, offerReload };
}

/** 复现当前 ModLoader 的包装缓存、规范名称接口与原生声明别名接口。 */
function useNativeProfiles(f) {
    const runtime = loadManager();
    const cache = () => [...f.profiles.values()].map(profile => ({ name: profile.name, from: 'Local', zip: {},
        mod: { name: profile.name, version: profile.version, alias: profile.bootJson.alias || [], bootJson: profile.bootJson } }));
    const utils = {
        getModLoader: () => ({ getModCacheArray: cache }),
        getModListNameNoAlias: () => cache().map(entry => entry.mod.name),
        getAnyModByNameNoAlias: name => cache().find(entry => entry.mod.name === name)?.mod,
        getMod: name => cache().find(entry => entry.mod.name === name || entry.mod.alias.includes(name))?.mod
    };
    runtime.modHubGetGui = () => ({ gModUtils: utils });
    runtime._modHubModState = f.sb._modHubModState;
    loadScripts(runtime, ['javascript/modhub-market.js']);
    f.sb.modHubMarket.getLocalInstalledProfiles = runtime.modHubMarket.getLocalInstalledProfiles;
    f.sb.modHubGetModInfo = runtime.modHubGetModInfo;
    return runtime;
}

/** 固定当前游戏原生库实际解析出的范围形状，验证调用时保留 ^ 的上界。 */
function useNativeDependencyRanges(f) {
    const ranges = {
        '>=2.0.0': [{ lower: { version: { version: [2, 0, 0] }, operator: '>=' } }],
        '^3.0.0': [{ lower: { version: { version: [3, 0, 0] }, operator: '>=' }, upper: { version: { version: [4] }, operator: '<' } }]
    };
    f.sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
        parseVersion: value => ({ version: { version: String(value).split('.').map(Number) } }),
        parseRange: value => ranges[value] || [],
        satisfies: (version, boundaries, ignorePostfix) => {
            assert.equal(ignorePostfix, undefined, '模组前置版本不得忽略原生后缀语义');
            return boundaries.some(boundary => (!boundary.lower || f.sb.modHubMarket.compareVersions(version.version.join('.'), boundary.lower.version.version.join('.')) >= 0)
                && (!boundary.upper || f.sb.modHubMarket.compareVersions(version.version.join('.'), boundary.upper.version.version.join('.')) < 0));
        }
    }) }) };
}

module.exports = async function () {
    for (const targetPage of [2, 3]) {
        const candidates = Array.from({ length: targetPage }, (_, index) => ({ candidateKey: `DetectedPage:${index + 1}`,
            seriesKey: 'DetectedPage', version: index + 1 === targetPage ? '2.0.0' : `1.${index + 1}.0`,
            assets: [{ name: `DetectedPage-${index + 1}.zip` }],
            compatibility: { status: 'unknown', evidence: 'filename', targetGameVersion: '0.5.0.0' } }));
        const f = fixture([{ id: 'DetectedPage', candidates }], [{ name: 'DetectedPage', version: '1.0.0' }]);
        f.sb.StartConfig = { version: '0.5.0.0' };
        f.mods[0]._updateCheck = {};
        f.sb.modHubMarket.getModUpdateInfo = () => ({ pending: false, error: '', release: candidates.at(-1) });
        f.sb.modHubMarketVersions.rankCandidates = f.actualVersions.rankCandidates;
        f.sb.modHubMarketVersions.getLatestGameCandidate = f.actualVersions.getLatestGameCandidate;
        const pages = [];
        f.sb.modHubMarketVersions.fetchReleases = async (mod, options) => {
            pages.push(options.page);
            assert.ok(options.page <= targetPage, '找到已检测的更新后应停止自动读取，剩余历史由用户选择加载');
            return { page: options.page, hasMore: true, releases: [candidates[options.page - 1]] };
        };
        f.sb.modHubConfirm = async options => {
            const ui = groupedChoiceDialog(f.sb);
            await options.onRender(ui.dialog);
            assert.deepEqual(pages, Array.from({ length: targetPage }, (_, index) => index + 1), '单次更新必须自动读取到已检测候选所在页');
            assert.equal(ui.groups.length, 1, '同一游戏分支的历史候选继续显示为一个分类');
            assert.equal(ui.groups[0].open, true);
            assert.equal(options.customResult().selectedKey, candidates.at(-1).candidateKey, '第 2 或 3 页的最新版必须成为默认选择');
            assert.equal(options.customResult().manual, false);
            assert.equal(ui.radios.find(input => input.checked).value, candidates.at(-1).candidateKey);
            assert.equal(options.canConfirm(), true);
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '取消自动读取后的选择不得下载、写入或重载');
    }
    {
        const candidates = [
            { candidateKey: 'EvidenceUpdate:old', seriesKey: 'EvidenceUpdate', version: '1.5.0', assets: [{ name: 'EvidenceUpdate-1.5.0.zip' }],
                compatibility: { status: 'compatible', evidence: 'declaration', gameVersionRange: '>=0.5.0.0' } },
            { candidateKey: 'EvidenceUpdate:new', seriesKey: 'EvidenceUpdate', version: '2.0.0', assets: [{ name: 'EvidenceUpdate-2.0.0.zip' }],
                compatibility: { status: 'unknown', evidence: 'filename', targetGameVersion: '0.5.0.0' } }
        ];
        const f = fixture([{ id: 'EvidenceUpdate', candidates }], [{ name: 'EvidenceUpdate', version: '1.0.0' }]);
        f.sb.StartConfig = { version: '0.5.0.0' };
        f.sb.modHubMarketVersions.rankCandidates = f.actualVersions.rankCandidates;
        f.sb.modHubMarketVersions.getLatestGameCandidate = f.actualVersions.getLatestGameCandidate;
        assert.equal(f.actualVersions.rankCandidates(f.mods[0], candidates).recommendedKey, 'EvidenceUpdate:old', '普通排序仍将作者声明证据排在文件名之前');
        f.sb.modHubConfirm = async options => {
            const ui = groupedChoiceDialog(f.sb);
            await options.onRender(ui.dialog);
            assert.equal(options.customResult().selectedKey, 'EvidenceUpdate:new', '已有本地版本时必须默认当前游戏的最高模组版本，不能被旧版声明证据挤掉');
            assert.equal(ui.radios.find(input => input.checked).value, 'EvidenceUpdate:new');
            assert.equal(ui.radios.find(input => input.value === 'EvidenceUpdate:old').checked, false);
            assert.equal(options.canConfirm(), true);
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, []);
    }
    {
        const candidate = (key, compatibility, version = '1.0.0') => ({ candidateKey: key, seriesKey: 'Grouped', version,
            assets: [{ name: `${key}.zip`, downloadUrl: `https://example.com/${key}.zip` }], compatibility });
        const choices = [candidate('old', { status: 'unknown', evidence: 'filename', targetGameVersion: '0.4.0.0', referenceMismatch: true }),
            candidate('range', { status: 'compatible', evidence: 'declaration', gameVersionRange: '>=0.5.0.0 && <0.6.0.0' }),
            candidate('current', { status: 'unknown', evidence: 'filename', targetGameVersion: '0.5.0.0' }),
            candidate('unknown', { status: 'unknown' }, '')];
        const f = fixture([{ id: 'Grouped', candidates: choices }], [{ name: 'Grouped', version: '1.0.0' }]);
        f.mods[0].name = '<img src=x onerror=bad()> & "模组"';
        f.sb.modHubMarketVersions.rankCandidates = (mod, releases) => ({ candidates: releases, recommendedKey: 'current', gameVersion: '0.5.0.0' });
        let completePage;
        f.sb.modHubMarketVersions.fetchReleases = async (mod, options) => options.page >= 2
            ? new Promise(resolve => { completePage = () => resolve({ releases: [candidate('later', { status: 'unknown', targetGameVersion: '0.6.0.0' }, '<script>版本</script>')], page: options.page, hasMore: options.page === 2 }); })
            : { releases: choices, page: 1, hasMore: true };
        f.sb.modHubConfirm = async options => {
            const ui = groupedChoiceDialog(f.sb);
            await options.onRender(ui.dialog);
            assert.deepEqual(ui.groups.map(group => group.dataset.groupKey).sort(), ['range:>=0.5.0.0 && <0.6.0.0', 'target:0.4.0.0', 'target:0.5.0.0', 'unknown'].sort());
            const findGroup = key => ui.groups.find(group => group.dataset.groupKey === key);
            const selectCurrent = () => { ui.radios.forEach(input => { input.checked = input.value === 'current'; }); ui.radios.find(input => input.value === 'current').onchange(); };
            assert.ok(ui.groups.indexOf(findGroup('target:0.5.0.0')) < ui.groups.indexOf(findGroup('target:0.4.0.0')), '当前适配或推荐分类先于其他分类');
            assert.equal(findGroup('target:0.5.0.0').open, true);
            assert.equal(findGroup('target:0.4.0.0').open, false);
            assert.ok(ui.area.innerHTML.includes('分类不代表已核验适配') && ui.area.innerHTML.includes('参考推荐'), '版本分类保留证据限制，不能声称已经验证');
            assert.ok(ui.area.innerHTML.includes('当前游戏版本：') && ui.area.innerHTML.includes('DoL 0.5.0.0') && ui.area.innerHTML.includes('当前已安装模组版本：'));
            assert.ok(ui.area.innerHTML.includes('与已安装版本号相同') && ui.area.innerHTML.includes('版本未知'), '相同版本号与无法识别版本须分别说明');
            assert.ok(ui.area.innerHTML.includes('&lt;img src=x onerror=bad()&gt; &amp; &quot;模组&quot;') && !ui.area.innerHTML.includes('<img'));
            findGroup('target:0.5.0.0').open = false; findGroup('target:0.5.0.0').ontoggle();
            assert.equal(options.canConfirm(), false, '收起选中版本的分类立即禁止确认');
            assert.equal(options.customResult().selectedKey, '');
            assert.ok(ui.radios.every(input => !input.checked));
            findGroup('target:0.5.0.0').open = true; findGroup('target:0.5.0.0').ontoggle();
            assert.equal(options.canConfirm(), false, '重新展开不能自动恢复已清除的选择');
            selectCurrent(); assert.equal(options.canConfirm(), false, '选择已安装版本不能再次确认安装');
            findGroup('target:0.4.0.0').open = true; findGroup('target:0.4.0.0').ontoggle();
            ui.list.scrollTop = 129; ui.dialog.querySelector('.modhub-modal-body').scrollTop = 73;
            ui.radios.find(input => input.value === 'current').focus();
            const page = ui.area.querySelector('.modhub-version-load-more').onclick();
            assert.equal(options.canConfirm(), false, '读取更早版本期间保持原禁止确认规则');
            completePage(); await page;
            assert.equal(findGroup('target:0.4.0.0').open, true, '分页保留玩家展开的旧游戏分类');
            assert.equal(findGroup('target:0.5.0.0').open, true);
            assert.equal(options.customResult().selectedKey, 'current');
            assert.equal(ui.radios.find(input => input.value === 'current').checked, true);
            assert.equal(ui.list.scrollTop, 129); assert.equal(ui.dialog.querySelector('.modhub-modal-body').scrollTop, 73);
            assert.equal(f.sb.document.activeElement.value, 'current');
            assert.ok(ui.area.innerHTML.includes('&lt;script&gt;版本&lt;/script&gt;') && !ui.area.innerHTML.includes('<script>'));
            findGroup('target:0.5.0.0').open = false;
            const delayedTogglePage = ui.area.querySelector('.modhub-version-load-more').onclick();
            assert.equal(options.customResult().selectedKey, '', '原生折叠事件尚未派发时，重绘也必须清除不可见选择');
            completePage(); await delayedTogglePage;
            assert.equal(options.canConfirm(), false);
            assert.ok(ui.radios.every(input => !input.checked));
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '取消分组选择不得下载、安装或重载');
    }
    {
        const candidates = ['1.0.0', '2.0.0', '0.9.0', '1.0.0-beta.1', '1.0.0-cn', '1.0.0-en'].map(version => ({ candidateKey: `SameVersion:${version}`, version, seriesKey: 'SameVersion',
            assets: [{ name: `SameVersion-${version}.zip` }], compatibility: { status: 'compatible', evidence: 'declaration' } }));
        const f = fixture([{ id: 'SameVersion', candidates }], [{ name: 'SameVersion', version: '1.0.0' }]);
        loadScripts(f.sb, ['javascript/modhub-dialog.js']);
        const confirm = f.sb.modHubConfirm, keyHandlers = new Map();
        f.sb.document.addEventListener = (type, handler) => keyHandlers.set(type, handler);
        f.sb.document.removeEventListener = (type, handler) => { if (keyHandlers.get(type) === handler) keyHandlers.delete(type); };
        let ui, readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        f.sb.modHubConfirm = options => confirm({ ...options, onRender: dialog => {
            ui = groupedChoiceDialog(f.sb, dialog);
            options.onRender(dialog).then(readyResolve, readyReject);
        } });
        let finished = false;
        const install = f.sb.modHubMarketInstaller.install(f.mods[0]).then(result => { finished = true; return result; });
        await ready;
        const button = ui.dialog.querySelector('.modhub-modal-btn-confirm');
        assert.equal(button.textContent, '已安装', '默认选中同版本时，主按钮必须显示已安装');
        assert.equal(button.disabled, true);
        const choose = version => {
            const key = `SameVersion:${version}`;
            ui.radios.forEach(input => { input.checked = input.value === key; });
            ui.radios.find(input => input.value === key).onchange();
        };
        for (const version of ['2.0.0', '0.9.0', '1.0.0-beta.1', '1.0.0-cn', '1.0.0-en']) {
            choose(version);
            assert.equal(button.textContent, '查看安装计划', '主动选择其他版本后应恢复正常确认文案');
            assert.equal(button.disabled, false, '同版保护不得阻止用户主动选择升级或降级版本');
        }
        choose('1.0.0');
        assert.equal(button.textContent, '已安装');
        assert.equal(button.disabled, true, '从其他版本切回同版本须立即禁止确认');
        keyHandlers.get('keydown')({ key: 'Enter', target: ui.dialog, preventDefault() {} });
        button.dispatch('click');
        await Promise.resolve();
        assert.equal(finished, false, '同版本的 Enter 与点击不能关闭选版框或开始安装');
        assert.deepEqual(f.events, [], '同版本不得下载、准备或写入包体');
        ui.dialog.querySelector('.modhub-modal-btn-cancel').dispatch('click');
        assert.equal(await install, false);
        assert.deepEqual(f.events, []);
    }
    {
        const f = fixture([{ id: 'SameVersionBypass', version: '1.0.0' }], [{ name: 'SameVersionBypass', version: '1.0.0' }]);
        f.sb.modHubConfirm = async options => { await f.renderDialog(options); return { selectedKey: 'release:SameVersionBypass', manual: true }; };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false, '共享安装入口仍须阻止绕过按钮的同版本选择');
        assert.deepEqual(f.events, [], '绕过界面返回同版本也不能准备、安装或重载');
    }
    for (const batch of [false, true]) {
        const f = fixture([{ id: 'SameBootVersion', version: '2.0.0', boot: { name: 'SameBootVersion', version: '1.0.0' } }],
            [{ name: 'SameBootVersion', version: '1.0.0' }]);
        const outcome = batch ? await f.sb.modHubMarketInstaller.installBatch(f.mods) : await f.sb.modHubMarketInstaller.install(f.mods[0]);
        assert.equal(outcome, false, '发布元数据为新版但实际包内已是本地同版本时，普通安装与批量预检都须停止');
        assert.deepEqual(f.events, ['prepare:SameBootVersion'], '真实包体同版本仅允许完成核对，不能写入或询问重载');
        assert.equal(f.profiles.get('SameBootVersion').version, '1.0.0');
        assert.equal(f.progress.size, 0, '同版预检退出须释放准备进度');
    }
    {
        const definitions = [{ id: 'SameBatchA', version: '1.0.0' }, { id: 'SameBatchB', version: '2.0.0' }];
        const f = fixture(definitions, definitions.map(item => ({ name: item.id, version: item.version })));
        f.sb.modHubConfirm = async options => {
            const dialog = createStubElement(), area = dialog.querySelector('#modHubBatchVersionChoices');
            const selects = f.mods.map(mod => ({ ...createStubElement('select'), dataset: { key: mod.id } }));
            area.querySelectorAll = selector => selector === '.modhub-version-batch-select' ? selects : [];
            await options.onRender(dialog);
            assert.deepEqual([...options.customResult()], [], '批量不得默认选择任何已安装的同版本');
            assert.equal(options.canConfirm(), false);
            for (const mod of f.mods) assert.match(area.innerHTML, new RegExp(`<option value="release:${mod.id}"[^>]*disabled`), '批量同版本下拉选项须禁用');
            for (const select of selects) { select.value = `release:${select.dataset.key}`; select.onchange(); }
            assert.equal(options.canConfirm(), false, '人工注入全部同版选择仍不得确认批量安装');
            return f.mods.map(mod => ({ mod, release: { candidateKey: `release:${mod.id}`, version: mod.version, assets: [],
                compatibility: { status: 'compatible', evidence: 'declaration' } }, manual: true }));
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.deepEqual(f.events, [], '批量同版选择不得准备或写入任何模组');
    }
    {
        const definitions = [{ id: 'SuffixBeta', version: '1.0.0' }, { id: 'SuffixLanguage', version: '1.0.0-en' }];
        const f = fixture(definitions, [{ name: 'SuffixBeta', version: '1.0.0-beta.1' }, { name: 'SuffixLanguage', version: '1.0.0-cn' }]);
        f.sb.modHubConfirm = async options => {
            const dialog = createStubElement(), area = dialog.querySelector('#modHubBatchVersionChoices');
            const selects = f.mods.map(mod => ({ ...createStubElement('select'), dataset: { key: mod.id } }));
            area.querySelectorAll = selector => selector === '.modhub-version-batch-select' ? selects : [];
            await options.onRender(dialog);
            for (const select of selects) {
                assert.ok(!new RegExp(`<option value="release:${select.dataset.key}"[^>]*disabled`).test(area.innerHTML), '正式版与语言后缀不同的包不能当作已安装同版禁用');
                select.value = `release:${select.dataset.key}`; select.onchange();
            }
            assert.equal(options.canConfirm(), true, '批量应允许预发布转正式版及不同语言后缀的手动换版');
            assert.equal(options.customResult().length, 2);
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.deepEqual(f.events, [], '取消不同后缀换版时不得下载或写入');
    }
    for (const installed of [[], [{ name: 'UnknownContext', version: '' }]]) {
        const f = fixture([{ id: 'UnknownContext', candidates: [{ candidateKey: 'unknown', seriesKey: 'unknown', version: '', assets: [], compatibility: { status: 'unknown' } }] }], installed);
        f.sb.modHubMarketVersions.getGameVersion = () => '';
        f.sb.modHubMarketVersions.rankCandidates = (mod, candidates) => ({ candidates, recommendedKey: '', gameVersion: '' });
        f.sb.modHubConfirm = async options => {
            await f.renderDialog(options);
            assert.ok(options.renderedHtml.includes('当前游戏版本：<strong class="gold">未识别</strong>'));
            assert.ok(options.renderedHtml.includes(`当前已安装模组版本：<strong class="gold">${installed.length ? '未识别' : '未安装'}</strong>`));
            assert.ok(options.renderedHtml.includes('版本未知') && !options.renderedHtml.includes('与已安装版本号相同'));
            assert.equal(options.canConfirm(), false, '未知游戏与版本不能制造默认可确认的推荐');
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, []);
    }
    {
        const name = '<img src=x onerror=bad()> & "风险模组"';
        const f = fixture([{ id: 'UnknownRisk', boot: { name: 'UnknownRisk' }, candidates: [{ candidateKey: 'unknown-risk', seriesKey: 'risk', version: '', assets: [], compatibility: { status: 'incompatible' } }] }], [{ name: 'UnknownRisk', version: '' }]);
        f.mods[0].name = name; f.sb.modHubMarketVersions.getGameVersion = () => '';
        const confirm = f.sb.modHubConfirm;
        let risk;
        f.sb.modHubConfirm = async options => {
            if (options.title.startsWith('选择【')) { await f.renderDialog(options); return { selectedKey: 'unknown-risk', manual: true }; }
            if (options.title === '确认版本风险') { risk = options; return false; }
            return confirm(options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.ok(risk.message.includes('当前游戏版本：未识别') && risk.message.includes('当前已安装版本：未识别；所选模组版本：未识别'));
        assert.ok(risk.message.includes(`【${name}】作者声明不适配当前游戏`), '风险纯文本保留不可信原始名称和具体原因');
        assert.ok(risk.trustedMessageHtml.includes('&lt;img src=x onerror=bad()&gt; &amp; &quot;风险模组&quot;') && !risk.trustedMessageHtml.includes('<img'));
        assert.deepEqual(f.events, [], '拒绝未知版本风险仍须零下载、零写入');
    }
    {
        const f = fixture([]);
        const text = '【<img src=x onerror=bad()> & "模组"】需要 DoL >=0.5.10.12；当前 1.2.3-beta.1 <script>bad()</script>';
        const html = f.runtimeMarket.formatVersionRiskMessage(text);
        assert.ok(html.includes('<strong class="gold">【&lt;img src=x onerror=bad()&gt; &amp; &quot;模组&quot;】</strong>'), '风险名称应先转义再强调');
        assert.ok(html.includes('<strong class="gold">0.5.10.12</strong>') && html.includes('<strong class="gold">1.2.3-beta.1</strong>'), '风险中的数字版本和预发布后缀应突出显示');
        assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;') && !html.includes('<img') && !html.includes('<script>'), '风险原文不能作为可信 HTML 注入');
    }
    // 还原点整理可以包含真实包体回读；任何入口都必须等到根操作解锁后才询问重载。
    for (const route of ['单次安装', '批量安装', '市场单次入口', '市场批量入口', '全部更新入口']) {
        const f = fixture([{ id: 'ReloadTarget', version: '2.0.0', dependencies: [{ id: 'ReloadDependency' }] },
            { id: 'ReloadDependency' }], route === '全部更新入口'
                ? [{ name: 'ReloadTarget', version: '1.0.0' }, { name: 'ReloadDependency', version: '1.0.0' }] : []);
        f.sb._modHubModState.sideDisabled = ['ReloadDependency'];
        f.sb.modHubIsFrameworkMod = name => name === 'ReloadDependency';
        f.sb._modHubReloadRevision = 7;
        const contexts = [], install = f.sb.modHubMarket.downloadAndInstallMod, toggle = f.sb.modHubToggleSideMod;
        f.sb.modHubMarket.downloadAndInstallMod = (mod, mirror, options) => {
            if (!options.prepareOnly) contexts.push(options.restoreContext);
            return install(mod, mirror, options);
        };
        f.sb.modHubToggleSideMod = (name, enabled, options) => {
            contexts.push(options.restoreContext);
            return toggle(name, enabled, options);
        };
        const restore = f.sb.modHubRestore, finish = restore.finish;
        let releaseFinish, signalFinish, operationContext, operationCount = 0;
        const finishGate = new Promise(resolve => { releaseFinish = resolve; });
        const finishStarted = new Promise(resolve => { signalFinish = resolve; });
        restore.withOperation = async (meta, action) => {
            operationCount++;
            operationContext = restore.createOperation(meta);
            assert.equal(restore.claim(operationContext), true);
            try { return await action(operationContext); }
            finally { signalFinish(); await finishGate; await finish(operationContext); }
        };
        const timers = [], reloadPrompts = [];
        let reloaded = 0;
        f.sb.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
        f.sb.location = { reload: () => { reloaded++; } };
        f.sb.modHubOfferReload = f.offerReload;
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = options => {
            if (options.title.startsWith('重新载入游戏')) {
                assert.equal(operationContext.finished, true, '提示前必须完成还原点整理');
                assert.equal(restore.isOperationBlocked(), false, '提示前必须释放上下文所有权');
                assert.equal(f.sb.modHubMarket.isInstallBusy(), false, '提示前必须释放市场及批量忙碌标志');
                assert.equal(options.confirmType, 'danger', '前置核心框架的变更也应汇入最终提示');
                reloadPrompts.push(options);
                return true;
            }
            return confirm(options);
        };
        if (route.includes('入口')) {
            for (const mod of f.mods) mod.identityId = mod.id.toLowerCase();
            f.sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1,
                mods: f.mods.map(mod => ({ ...mod, versionSource: 'github' })) }) });
            if (route === '全部更新入口') f.sb._modHubModState.sideMods = [{ name: 'ReloadTarget', enabled: true }];
            await f.runtimeMarket.loadMarketData(true);
            if (route === '全部更新入口') assert.equal(f.runtimeMarket.getUpdatableMods().length, 1,
                `测试更新目标应可识别：${JSON.stringify(f.runtimeMarket.getMarketMods())}`);
            if (route === '市场批量入口') {
                f.runtimeMarket.toggleBatchSelection(true);
                f.runtimeMarket.setBatchModSelected(f.runtimeMarket.getMarketModKey(f.mods[0]), true);
            }
        }
        const result = route === '单次安装' ? f.sb.modHubMarketInstaller.install(f.mods[0])
            : route === '批量安装' ? f.sb.modHubMarketInstaller.installBatch([f.mods[0]])
            : route === '市场单次入口' ? f.runtimeMarket.promptDownloadMirrorAndInstall(f.mods[0])
            : route === '市场批量入口' ? f.runtimeMarket.installSelectedMods() : f.runtimeMarket.updateAllMods();
        await finishStarted;
        f.sb._modHubReloadExitPending = true;
        assert.equal(reloadPrompts.length, 0, `${route}：整理未完成不得弹重载框`);
        assert.equal(timers.filter(item => item.delay === 300 || item.delay === 450).length, 0, `${route}：整理未完成不得安排重载`);
        assert.equal(f.sb.modHubRestartGame(), false, '用户在整理期间手动重载也应被阻止');
        releaseFinish();
        const outcome = await result;
        assert.ok(outcome !== false, `${route}：保留安装结果`);
        assert.equal(operationCount, 1, `${route}：目标及前置只能有一个根操作`);
        assert.ok(contexts.length >= 2 && contexts.every(context => context === operationContext), `${route}：安装与启用前置显式使用同一上下文；实际 ${f.events.join('、')}`);
        assert.equal(reloadPrompts.length, 1, `${route}：整理完成后只提示一次`);
        for (const item of timers.filter(item => item.delay === 300)) item.callback();
        for (const item of timers.filter(item => item.delay === 450)) item.callback();
        assert.equal(reloaded, 1, `${route}：立即重载应成功一次`);
        assert.equal(await f.sb.modHubCompleteOperationReload(operationContext), false, '重复完成不得再次重载');
        assert.equal(await f.sb.modHubPromptPendingReload(), false, '本次提示不得重复为退出提醒');
    }
    for (const failure of ['整理失败', '保存失败', '状态待核实']) {
        const f = fixture([{ id: 'ReloadFailure' }]);
        const restore = f.sb.modHubRestore, finish = restore.finish;
        let context;
        f.sb._modHubReloadRevision = 4;
        restore.withOperation = async (meta, action) => {
            context = restore.createOperation(meta); restore.claim(context);
            try { return await action(context); }
            finally {
                await finish(context);
                if (failure === '整理失败') context.finishError = new Error('测试还原点整理失败');
                if (failure === '保存失败') f.sb._modHubManagerSaveFailed = true;
                if (failure === '状态待核实') f.sb._modHubManagerStateUncertain = true;
                f.sb._modHubReloadExitPending = true;
            }
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '整理保护不得把已落盘的安装改判为失败');
        assert.ok(!f.events.includes('reload'), `${failure}：不得自动提示重载`);
        assert.equal(f.sb._modHubReloadExitPending, false, '失败时不得转而触发重复退出提示');
        assert.equal(await f.sb.modHubCompleteOperationReload(context), false);
        assert.equal(f.sb.modHubPromptPendingReload(), false, '失败后退出市场也不能重新触发自动重载提示');
        assert.equal(f.sb.modHubRestartGame(), false, '失败后定时器或手动重载仍需先核验');
    }
    {
        const f = fixture([{ id: 'ReloadLater' }]);
        f.sb._modHubReloadRevision = 3;
        f.sb.modHubOfferReload = f.offerReload;
        const confirm = f.sb.modHubConfirm;
        let prompts = 0, switched = 0;
        f.sb.modHubSwitchTab = () => { switched++; };
        f.sb.modHubConfirm = options => {
            if (options.title.startsWith('重新载入游戏')) { prompts++; return false; }
            return confirm(options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.equal(prompts, 1);
        assert.equal(switched, 0, '稍后重载必须保持当前市场页签');
        assert.equal(await f.sb.modHubPromptPendingReload(), false, '稍后重载之后不得重复提示同一批次');
    }
    {
        const f = fixture([{ id: 'PartialTarget', dependencies: [{ id: 'PartialDependency' }], installFailure: true },
            { id: 'PartialDependency' }]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false, '目标失败仍保持单次安装失败返回值');
        assert.equal(f.profiles.has('PartialDependency'), true, '保留已成功落盘的前置');
        assert.equal(f.events.filter(event => event === 'reload').length, 1, '部分成功应在根完成后提示一次重载');
        assert.equal(f.sb.modHubMarket.isInstallBusy(), false);
    }
    {
        const f = fixture([]);
        useNativeDependencyRanges(f);
        const check = f.sb.modHubMarketInstaller.satisfiesDependency;
        for (const [version, range, expected] of [['3.9.9', '^3.0.0', true], ['4.0.0', '^3.0.0', false], ['5.1.3', '^3.0.0', false], ['5.1.3', '>=2.0.0', true]]) {
            assert.equal(check({ name: 'maplebirch', version }, { bootName: 'maplebirch', version: range }), expected, '必须保留原生 ^3 的 >=3 且 <4 边界');
        }
    }
    {
        const f = fixture([{ id: 'SatisfiedMapleTarget', dependencies: [{ id: 'maplebirch', version: '>=2.0.0' }], boot: {
            name: 'SatisfiedMapleTarget', version: '1.0.0', dependenceInfo: [{ modName: 'maplebirch', version: '>=2.0.0' }]
        } }, { id: 'maplebirch', version: '5.2.0' }], [{ name: 'maplebirch', version: '5.1.3' }]);
        useNativeProfiles(f); useNativeDependencyRanges(f);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:SatisfiedMapleTarget', 'install:SatisfiedMapleTarget', 'reload'], '已装满足的前置必须复用，不读取其版本列表或下载');
        assert.equal(f.prompts.filter(options => options.title.startsWith('选择【')).length, 1, '已满足时只能出现目标选版，不得弹前置选版');
    }
    {
        const candidates = ['5.2.0', '3.9.0'].map(version => ({ candidateKey: `maple:${version}`, seriesKey: 'maplebirch', version, tagName: version,
            assets: [{ name: `maplebirch-${version}.zip`, size: 1 }], compatibility: { status: 'compatible', evidence: 'declaration', reason: '测试适配声明' } }));
        const f = fixture([{ id: 'OldMapleTarget', dependencies: [{ id: 'maplebirch', version: '>=2.0.0' }], boot: {
            name: 'OldMapleTarget', version: '1.0.0', dependenceInfo: [{ modName: 'maplebirch', version: '^3.0.0' }]
        } }, { id: 'maplebirch', candidates }], [{ name: 'maplebirch', version: '5.1.3' }]);
        useNativeProfiles(f); useNativeDependencyRanges(f);
        f.sb.modHubMarketVersions.rankCandidates = f.actualVersions.rankCandidates;
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        const prompt = f.prompts.find(options => options.title === '选择【maplebirch】版本');
        assert.ok(prompt.trustedMessageHtml.includes('已识别本地【maplebirch】5.1.3') && prompt.trustedMessageHtml.includes('3.0.0及以上，低于4.0.0，当前不满足'), '加载首屏必须说明已装版本已识别，但真实范围不匹配');
        assert.ok(prompt.trustedMessageHtml.includes('历史版本记录') && prompt.trustedMessageHtml.includes('2.0.0及以上') && prompt.trustedMessageHtml.includes('安装包声明') && !prompt.trustedMessageHtml.includes('^3.0.0'), '历史与真实包内约束须并列标明来源并翻译范围');
        assert.equal(prompt.canConfirm(), false, '5.x 不满足要求，3.x 又低于已装版本，两者均不能自动预选');
        assert.ok(!prompt.renderedHtml.includes('checked'), '不得自动勾选更高但不满足的包、满足范围的旧包或风险跳过');
        assert.deepEqual(f.events, ['prepare:OldMapleTarget'], '取消前置选择不下载或替换已装框架');
        assert.equal(f.profiles.get('maplebirch').version, '5.1.3');
    }
    {
        const simple = { name: 'Simple Frameworks', version: '2.0.5', repository: 'https://github.com/emicoto/SCMLSimpleFramework' };
        const maple = { name: 'maplebirch', version: '5.1.3', repository: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' };
        const f = fixture([{ id: 'LocalFrameworkConsumer', boot: { name: 'LocalFrameworkConsumer', version: '1.0.0', dependenceInfo: [{ modName: simple.name, version: '>=2.0.0' }] } }], [simple, maple]);
        const runtime = useNativeProfiles(f);
        f.sb.modHubMarket.detectModInstallationConflicts = runtime.modHubMarket.detectModInstallationConflicts;
        f.sb.modHubMarket.formatConflictWarningHtml = runtime.modHubMarket.formatConflictWarningHtml;
        let conflictChecked = false;
        f.sb.modHubMarket.confirmInstallConflicts = async getActivePlan => {
            const plan = getActivePlan();
            if (!plan.actions.some(action => action.type === 'satisfied')) return true;
            conflictChecked = true;
            assert.ok(plan.actions.some(action => action.type === 'satisfied' && action.local?.name === simple.name), '冲突闭包必须包含无需下载的本地前置');
            assert.ok(runtime.modHubMarket.detectModInstallationConflicts(plan.targetMod, plan.actions).length > 0, '真实检测器应识别已有简易框架与启用秋枫互斥');
            const html = f.prompts.find(options => options.title === '请再次核对安装计划').trustedMessageHtml;
            assert.ok(html.includes('modhub-install-conflict-card'), '在点击开始安装前，最终计划必须显示真实闭包冲突警告');
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(conflictChecked, true);
        assert.equal(f.prompts.filter(options => options.title.startsWith('选择【')).length, 1, '本地满足前置不需要选版');
        assert.deepEqual(f.events, ['prepare:LocalFrameworkConsumer'], '取消冲突确认只能预检消费者，不得启用、下载前置或写入安装');
        assert.equal(f.progress.size, 0);
    }
    for (const scenario of [
        { providers: [{ name: 'BundledProvider', version: '2.1.0', alias: ['BundledAlias'] }], allowed: true },
        { providers: [{ name: 'BundledProvider', version: '1.0.0', alias: ['BundledAlias'] }], allowed: false, error: '不满足版本要求' },
        { providers: [{ name: 'BundledProvider', version: '2.1.0', alias: ['BundledAlias'] }, { name: 'SecondProvider', version: '2.1.0', alias: ['BundledAlias'] }], allowed: false, error: '存在多个提供者' },
        { providers: [{ name: 'BundledAlias', version: '2.1.0' }, { name: 'SecondProvider', version: '2.1.0', alias: ['BundledAlias'] }], allowed: false, error: '存在多个提供者' }
    ]) {
        const f = fixture([{ id: 'BundledTarget', boots: [
            { name: 'BundledTarget', version: '1.0.0', dependenceInfo: [{ modName: 'BundledAlias', version: '>=2.0.0' }] }, ...scenario.providers
        ] }]);
        if (scenario.allowed) f.sb.modHubMarket.getPreparedCompatibilityRisks = boots => boots.filter(boot => boot.name === 'BundledProvider').map(boot => ({ key: 'bundled-game-risk', name: boot.name, status: 'incompatible', range: '>=0.6.0' }));
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), scenario.allowed);
        assert.deepEqual(f.events.filter(event => event.startsWith('prepare:')), ['prepare:BundledTarget'], '包内原生声明的前置不能被误当外部依赖下载');
        assert.equal(f.events.some(event => event.startsWith('install:')), scenario.allowed, '包内提供者歧义或版本不足时必须零写入');
        if (scenario.error) assert.ok(f.alerts.some(message => message.includes(scenario.error)));
        if (scenario.allowed) assert.ok(f.prompts.find(options => options.title === '确认版本风险').message.includes('【BundledProvider】\n当前已安装版本：未安装；所选模组版本：2.1.0'), '附属包适配风险应显示附属包的真实版本，而非主包版本');
    }
    const imageHookBoot = { name: 'ModLoader DoL ImageLoaderHook', version: '2.101.0', alias: ['ImageLoaderHook', 'ImageLoaderHookCore'],
        dependenceInfo: [{ modName: 'ModLoader', version: '^2.100.0' }, { modName: 'GameVersion', version: '>=0.5.6' }] };
    {
        const f = fixture([{ id: 'Maplebirch', boot: { name: 'Maplebirch', version: '2.0.0', dependenceInfo: [
            { modName: 'ImageLoaderHook', version: '^2.18.0' }, { modName: 'ImageLoaderHookCore', version: '^2.18.0' }
        ] } }], [imageHookBoot]);
        const runtime = useNativeProfiles(f);
        f.sb._modHubModState.builtInMods = [imageHookBoot.name];
        assert.equal(runtime.modHubGetModInfo('ImageLoaderHook'), null, '管理器规范身份接口不能因前置别名放宽');
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:Maplebirch', 'install:Maplebirch', 'reload'], '内置 ImageLoaderHook 两个真实别名应共用一个无需下载的前置节点');
        const html = f.prompts.find(options => options.title === '请再次核对安装计划').trustedMessageHtml;
        assert.ok(html.includes(imageHookBoot.name) && html.includes('内置'), '确认页必须展示已满足的真实内置模块');
    }
    {
        const f = fixture([{ id: 'AliasConsumer', boot: { name: 'AliasConsumer', version: '1.0.0', dependenceInfo: [{ modName: 'DeclaredAlias', version: '>=1' }] } },
            { id: 'AliasBase' }], [{ name: 'CanonicalProvider', version: '1.0.0', alias: ['DeclaredAlias'], dependenceInfo: [{ modName: 'AliasBase', version: '>=1' }] }]);
        useNativeProfiles(f);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:AliasBase', 'install:AliasConsumer'], '按别名满足的本地前置仍须展开真实 boot 里的递归前置');
    }
    for (const installed of [
        [{ name: 'UnrelatedProvider', version: '2.101.0', nickName: 'ImageLoaderHook', aliases: ['ImageLoaderHook'] }],
        [{ ...imageHookBoot, version: '1.0.0' }],
        [imageHookBoot, { name: 'AnotherProvider', version: '2.101.0', alias: ['ImageLoaderHook'] }]
    ]) {
        const f = fixture([{ id: 'AliasBlocked', boot: { name: 'AliasBlocked', version: '1.0.0', dependenceInfo: [{ modName: 'ImageLoaderHook', version: '^2.18.0' }] } }], installed);
        useNativeProfiles(f);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false, '展示名、非原生 aliases、版本不足或重复别名不能证明可用前置');
        assert.equal(f.events.some(event => event.startsWith('install:')), false);
    }
    {
        const f = fixture([{ id: 'AliasChanged', boot: { name: 'AliasChanged', version: '1.0.0', dependenceInfo: [{ modName: 'ImageLoaderHook' }] } }], [{ ...imageHookBoot }]);
        useNativeProfiles(f);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            const result = await confirm(options);
            if (options.title === '请再次核对安装计划') f.profiles.get(imageHookBoot.name).bootJson.alias = [];
            return result;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(f.events.some(event => event.startsWith('install:')), false, '确认前别名声明变化必须使依赖快照失效');
    }
    {
        const f = fixture([{ id: 'AliasUpgradeTarget', boot: { name: 'AliasUpgradeTarget', version: '1.0.0', dependenceInfo: [{ modName: 'ImageLoaderHook', version: '>=2.100' }] } },
            { id: 'CanonicalHook', boot: imageHookBoot }], [{ ...imageHookBoot, version: '2.1.0' }]);
        useNativeProfiles(f);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:CanonicalHook', 'install:AliasUpgradeTarget'], '别名需升级时仅查真实规范名称对应的市场身份');
    }
    {
        const f = fixture([{ id: 'LateAliasConflict', boot: { name: 'LateAliasConflict', version: '1.0.0', dependenceInfo: [{ modName: 'ImageLoaderHook' }] } }], [imageHookBoot]);
        useNativeProfiles(f);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            const result = await confirm(options);
            if (options.title === '请再次核对安装计划') {
                const boot = { name: 'LateProvider', version: '2.101.0', alias: ['ImageLoaderHook'] };
                f.profiles.set(boot.name, { ...boot, bootJson: boot });
            }
            return result;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(f.events.some(event => event.startsWith('install:')), false, '确认后出现第二个声明者也必须停止写入');
    }
    for (const lateFailure of [false, true]) {
        const f = fixture([{ id: 'CancelLoading' }]);
        const originalFetch = f.sb.modHubMarketVersions.fetchReleases, originalConfirm = f.sb.modHubConfirm;
        let finish, signal, ready, area;
        f.sb.modHubMarketVersions.fetchReleases = (mod, options) => {
            signal = options.signal;
            return new Promise((resolve, reject) => { finish = () => lateFailure ? reject(new Error('迟到失败')) : resolve(originalFetch(mod)); });
        };
        f.sb.modHubConfirm = async options => {
            assert.ok(options.trustedMessageHtml.includes('正在读取版本列表'), '请求完成前必须显示加载弹窗');
            assert.equal(options.canConfirm(), false, '加载期间 Enter 不得开始准备');
            const dialog = createStubElement(); area = dialog.querySelector('#modHubVersionChoices');
            ready = options.onRender(dialog);
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(signal.aborted, true, '取消加载必须中止网络请求');
        const closedHtml = area.innerHTML;
        finish(); await ready;
        assert.equal(area.innerHTML, closedHtml, '迟到响应不得更新已关闭弹窗');
        assert.deepEqual(f.events, []); assert.deepEqual(f.alerts, [], '取消后的失败不能弹错误提示');
        f.sb.modHubMarketVersions.fetchReleases = originalFetch; f.sb.modHubConfirm = originalConfirm;
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '旧请求结束后仍可重新下载');
    }
    {
        const f = fixture([{ id: 'RetryInline' }]);
        const fetch = f.sb.modHubMarketVersions.fetchReleases;
        let calls = 0, dialogs = 0;
        f.sb.modHubMarketVersions.fetchReleases = (...args) => ++calls === 1 ? Promise.reject(new Error('<读取失败>')) : fetch(...args);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            if (!options.title.startsWith('选择【')) return confirm(options);
            dialogs++;
            const dialog = createStubElement(), area = dialog.querySelector('#modHubVersionChoices');
            await options.onRender(dialog);
            assert.ok(area.innerHTML.includes('&lt;读取失败&gt;'), '上游错误必须转义后显示');
            assert.equal(options.canConfirm(), false);
            await area.querySelector('.modhub-version-retry').onclick();
            assert.equal(options.canConfirm(), true);
            assert.ok(!area.innerHTML.includes('版本列表读取失败'));
            return options.customResult();
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.equal(dialogs, 1, '重试只能刷新当前弹窗'); assert.equal(calls, 2);
    }
    {
        const f = fixture([{ id: 'BatchLoading1' }, { id: 'BatchLoading2' }]);
        const fetch = f.sb.modHubMarketVersions.fetchReleases;
        let finish, signal, ready, area, calls = 0;
        f.sb.modHubMarketVersions.fetchReleases = (mod, options) => { calls++; signal = options.signal; return new Promise(resolve => { finish = () => resolve(fetch(mod)); }); };
        f.sb.modHubConfirm = async options => {
            assert.ok(options.trustedMessageHtml.includes('已读取 0 / 2 项'), '批量必须先展示所有占位行');
            assert.equal(options.canConfirm(), false);
            const dialog = createStubElement(); area = dialog.querySelector('#modHubBatchVersionChoices'); ready = options.onRender(dialog);
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.equal(signal.aborted, true);
        const closedHtml = area.innerHTML; finish(); await ready;
        assert.equal(calls, 1, '取消批量后不能继续读取后续项目');
        assert.equal(area.innerHTML, closedHtml); assert.deepEqual(f.events, []);
        assert.equal(f.sb.modHubMarket.batchInstallState.running, false, '取消后必须解除批量锁');
    }
    {
        const f = fixture([{ id: 'BatchReady1' }, { id: 'BatchReady2' }]);
        const fetch = f.sb.modHubMarketVersions.fetchReleases;
        let finish, ready, area, secondStarted;
        const started = new Promise(resolve => { secondStarted = resolve; });
        f.sb.modHubMarketVersions.fetchReleases = (mod, options) => mod.id === 'BatchReady1' ? fetch(mod, options)
            : new Promise(resolve => { finish = () => resolve(fetch(mod, options)); secondStarted(); });
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            if (options.title !== '选择批量安装版本') return confirm(options);
            const dialog = createStubElement(), select = createStubElement('select');
            select.dataset.key = 'BatchReady1'; area = dialog.querySelector('#modHubBatchVersionChoices');
            area.querySelectorAll = selector => selector === '.modhub-version-batch-select' ? [select] : [];
            ready = options.onRender(dialog);
            await started;
            assert.ok(area.innerHTML.includes('已读取 1 / 2 项'), '已完成行应及时显示');
            select.value = ''; select.onchange();
            finish(); await ready;
            assert.equal(options.customResult().length, 1, '后续完成不能覆盖已手动跳过的行');
            return options.customResult();
        };
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods);
        assert.equal(result.results.get('BatchReady2').status, 'success'); assert.ok(!f.events.includes('prepare:BatchReady1'));
    }
    {
        const candidate = (id, version, compatibility = { status: 'unknown' }, seriesKey = id) => ({
            candidateKey: `${id}-${version}-${seriesKey}`, seriesKey, version,
            assets: [{ name: `${id}-${version}.zip`, downloadUrl: `https://example.com/${id}-${version}.zip` }], compatibility });
        const cases = [
            { id: 'LatestUnknown', candidates: [candidate('LatestUnknown', '1.0'), candidate('LatestUnknown', '2.0')], expected: '2.0' },
            { id: 'PreferSupported', candidates: [candidate('PreferSupported', '9.0'), candidate('PreferSupported', '1.0', { status: 'compatible', evidence: 'declaration' })], expected: '1.0' },
            { id: 'OnlyMismatch', candidates: [candidate('OnlyMismatch', '2.0', { status: 'incompatible', evidence: 'declaration' })] },
            { id: 'FilenameMismatch', candidates: [candidate('FilenameMismatch', '2.0', { status: 'unknown', evidence: 'filename', referenceMismatch: true })] },
            { id: 'Languages', candidates: [candidate('Languages', '1.0', undefined, 'CN'), candidate('Languages', '2.0', undefined, 'EN')] },
            { id: 'Models', candidates: [candidate('Models', '1.0', undefined, 'female'), candidate('Models', '2.0', undefined, 'male')] },
            { id: 'UnknownSeries', candidates: [candidate('UnknownSeries', '1.0', undefined, '')] },
            { id: 'TiedPackages', candidates: [candidate('TiedPackages', '2.0'), { ...candidate('TiedPackages', '2.0'), candidateKey: 'other-format' }] },
            { id: 'PreventDowngrade', candidates: [candidate('PreventDowngrade', '1.0')], installed: [{ name: 'PreventDowngrade', version: '2.0' }] },
        ];
        for (const entry of cases) {
            const f = fixture([entry], entry.installed || []);
            f.sb.StartConfig = { version: '0.5.0.0' };
            f.sb.modHubMarketVersions.rankCandidates = f.actualVersions.rankCandidates;
            f.sb.modHubConfirm = async options => {
                await f.renderDialog(options);
                const selected = options.customResult();
                assert.equal(selected[0]?.release.version, entry.expected, '批量默认最新版必须保留适配优先、歧义和不降级边界');
                if (entry.expected) assert.equal(selected[0].manual, false, '自动回退的未知版本不能被记为人工选版');
                assert.equal(options.canConfirm(), Boolean(entry.expected));
                return false;
            };
            assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
            assert.deepEqual(f.events, [], '默认选版阶段不得预先下载或写入');
        }
        const definitions = [
            { id: 'UpdateUnknown', candidates: [candidate('UpdateUnknown', '2.0')] },
            { id: 'UpdateEqual', candidates: [candidate('UpdateEqual', '1.0', { status: 'compatible', evidence: 'declaration' })] },
            { id: 'UpdateProven', candidates: [candidate('UpdateProven', '2.0', { status: 'compatible', evidence: 'declaration' })] },
        ];
        const f = fixture(definitions, definitions.map(item => ({ name: item.id, version: '1.0' })));
        f.sb.modHubMarketVersions.rankCandidates = f.actualVersions.rankCandidates;
        f.sb.modHubConfirm = async options => {
            await f.renderDialog(options);
            assert.deepEqual(Array.from(options.customResult(), item => item.mod.id), ['UpdateProven'], '全部更新只能预选高于本地且有适配依据的版本');
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods, { updateOnly: true }), false);
        const downgrade = fixture([{ id: 'UnknownRealDowngrade', candidates: [candidate('UnknownRealDowngrade', '2.0')],
            boot: { name: 'UnknownRealDowngrade', version: '0.9' } }], [{ name: 'UnknownRealDowngrade', version: '1.0' }]);
        downgrade.sb.modHubMarketVersions.rankCandidates = downgrade.actualVersions.rankCandidates;
        await downgrade.sb.modHubMarketInstaller.installBatch(downgrade.mods);
        assert.deepEqual(downgrade.events, ['prepare:UnknownRealDowngrade'], '自动回退默认包的真实版本低于本地时仍须阻止自动降级');
        assert.equal(downgrade.profiles.get('UnknownRealDowngrade').version, '1.0');
    }
    {
        const candidate = (id, version) => ({ candidateKey: `${id}-${version}`, seriesKey: id, version,
            assets: [{ name: `${id}-${version}.zip`, downloadUrl: `https://example.com/${id}-${version}.zip` }],
            compatibility: { status: 'compatible', evidence: 'declaration' } });
        const f = fixture([{ id: 'PagedChoice' }, { id: 'PagedSkip' }]);
        const requests = []; let failedInitial = false, failedOlder = false, dialogs = 0;
        f.sb.modHubMarketVersions.fetchReleases = async (mod, options) => {
            requests.push([mod.id, options.page]);
            if (mod.id === 'PagedChoice' && options.page === 1 && !failedInitial) { failedInitial = true; throw new Error('<初次失败>'); }
            if (mod.id === 'PagedChoice' && options.page === 2 && !failedOlder) { failedOlder = true; throw new Error('<更早失败>'); }
            return { page: options.page, hasMore: options.page === 1, releases: options.page === 1
                ? [candidate(mod.id, '3.0'), candidate(mod.id, '2.0')] : [candidate(mod.id, '3.0'), candidate(mod.id, '1.0')] };
        };
        f.sb.modHubConfirm = async options => {
            dialogs++;
            assert.equal(options.title, '选择批量安装版本', '加载历史必须留在当前批量弹窗');
            const dialog = createStubElement(), area = dialog.querySelector('#modHubBatchVersionChoices');
            const selects = f.mods.map(mod => ({ ...createStubElement('select'), dataset: { key: mod.id } }));
            const buttons = f.mods.map(mod => ({ ...createStubElement('button'), dataset: { key: mod.id } }));
            area.querySelectorAll = selector => selector === '.modhub-version-batch-select' ? selects
                : selector === '.modhub-version-batch-more' ? buttons.filter(button => area.innerHTML.includes(`modhub-version-batch-more" data-key="${button.dataset.key}"`)) : [];
            await options.onRender(dialog);
            assert.ok(area.innerHTML.includes('&lt;初次失败&gt;') && area.innerHTML.includes('重试版本列表'));
            await buttons[0].onclick();
            assert.ok(area.innerHTML.includes('加载更早版本') && !area.innerHTML.includes('浏览更多版本'));
            selects[0].value = 'PagedChoice-2.0'; selects[0].onchange();
            selects[1].value = ''; selects[1].onchange();
            const failedPage = buttons[0].onclick();
            assert.equal(options.canConfirm(), false, '分页读取期间不能提交安装');
            await failedPage;
            assert.ok(area.innerHTML.includes('&lt;更早失败&gt;') && area.innerHTML.includes('重试加载更早版本'));
            assert.equal(options.customResult()[0].release.candidateKey, 'PagedChoice-2.0', '分页失败不能丢失当前选择');
            await buttons[0].onclick(); await buttons[1].onclick();
            assert.equal((area.innerHTML.match(/value="PagedChoice-3.0"/g) || []).length, 1, '跨页重复候选不得重复追加');
            assert.ok(area.innerHTML.includes('value="PagedChoice-1.0"') && area.innerHTML.includes('value="PagedSkip-1.0"'), '更早版本追加到当前下拉');
            assert.deepEqual(Array.from(options.customResult(), item => item.release.candidateKey), ['PagedChoice-2.0'], '加载下一页应同时保留选版与跳过状态');
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.deepEqual(requests, [['PagedChoice', 1], ['PagedSkip', 1], ['PagedChoice', 1], ['PagedChoice', 2], ['PagedChoice', 2], ['PagedSkip', 2]], '失败必须在原行重试同一页');
        assert.equal(dialogs, 1); assert.deepEqual(f.events, []);
    }
    for (const lateFailure of [false, true]) {
        const f = fixture([{ id: 'CancelBatchPage' }]);
        const fetch = f.sb.modHubMarketVersions.fetchReleases;
        let finish, signal, pending, area;
        f.sb.modHubMarketVersions.fetchReleases = (mod, options) => options.page === 1
            ? fetch(mod, options).then(history => ({ ...history, hasMore: true }))
            : new Promise((resolve, reject) => { signal = options.signal; finish = () => lateFailure
                ? reject(new Error('迟到分页失败')) : resolve({ page: 2, hasMore: false, releases: [] }); });
        f.sb.modHubConfirm = async options => {
            const dialog = createStubElement(), button = createStubElement('button'); button.dataset.key = f.mods[0].id;
            area = dialog.querySelector('#modHubBatchVersionChoices');
            area.querySelectorAll = selector => selector === '.modhub-version-batch-more' ? [button] : [];
            await options.onRender(dialog);
            pending = button.onclick();
            return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.equal(signal.aborted, true, '批量分页与初次读取必须随取消中止');
        const closedHtml = area.innerHTML; finish(); await pending;
        assert.equal(area.innerHTML, closedHtml, '迟到分页结果不得改写已关闭的批量弹窗');
        assert.deepEqual(f.events, []); assert.deepEqual(f.alerts, []);
    }
    {
        const f = fixture([{ id: 'RuntimeTarget', dependencies: [{ id: 'ModLoader', version: '>=2.5.2' }, { bootName: 'SugarCube', version: '>=2.38.0' }],
            boot: { name: 'RuntimeTarget', version: '1.0', dependenceInfo: [{ modName: 'Existing' }, { modName: 'ModLoader', version: '>=2.2.0' }] } }, { id: 'Existing' }],
        [{ name: 'Existing', version: '1.0' }]);
        f.sb.SugarCube = { version: { toString: () => '2.38.0' } };
        f.sb.modSC2DataManager = { getModUtils: () => ({ version: '2.101.1' }), getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: version => ({ version: { version: version.split('.').map(Number), raw: version } }), parseRange: range => [{ range }],
            satisfies: (version, range, ignorePostfix) => { assert.equal(ignorePostfix, undefined, '运行环境核对须保留原生后缀语义'); return f.sb.modHubMarket.satisfiesVersion(version.raw, range[0].range); }
        }) }) };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        const html = reviewedPlan(f).trustedMessageHtml;
        assert.ok(html.includes('本次选择（1 项）') && html.includes('已满足的前置（1 项，无需下载）'));
        assert.ok(html.includes('ModLoader 当前 2.101.1') && html.includes('SugarCube 当前 2.38.0') && html.includes('运行环境：已满足要求'));
        assert.ok(html.includes('&gt;=2.5.2') && html.includes('&gt;=2.2.0'), '目录专属与真实包内运行时约束都要核对');
        assert.ok(html.includes('是否支持当前游戏待确认'), '安装包没有游戏版本声明时应明确说明支持情况待确认');
        assert.ok(!html.includes('未核验') && !html.includes('需要处理的前置'));
        assert.deepEqual(f.events, ['prepare:RuntimeTarget', 'install:RuntimeTarget', 'reload'], '运行环境不能被当成市场前置下载');
    }
    {
        const f = fixture([{ id: 'RuntimeMismatch', boot: { name: 'RuntimeMismatch', version: '1.0', dependenceInfo: [{ modName: 'ModLoader', version: '>=2.5.2' }] } }]);
        f.sb.modSC2DataManager = { getModUtils: () => ({ version: '2.5.2-beta.1' }), getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: raw => ({ version: { version: [2, 5, 2], raw } }), parseRange: range => [{ range }],
            satisfies: (version, range, ignorePostfix) => { assert.equal(version.raw, '2.5.2-beta.1'); assert.equal(ignorePostfix, undefined); return false; }
        }) }) };
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = options => options.title === '确认版本风险' ? false : confirm(options);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        const html = reviewedPlan(f).trustedMessageHtml;
        assert.ok(html.includes('2.5.2-beta.1') && html.includes('不满足'));
        assert.deepEqual(f.events, ['prepare:RuntimeMismatch']); assert.equal(f.progress.size, 0);
    }
    {
        const f = fixture([
            { id: 'OldTarget', directoryDependencies: [{ id: 'Framework', version: '^2.0.0' }], boot: { name: 'OldTarget', version: '1.0.0', dependenceInfo: [{ modName: 'Framework', version: '^1.0.0' }] } },
            { id: 'Framework', version: '2.0.0' }
        ], [{ name: 'Framework', version: '1.2.0' }]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:OldTarget', 'install:OldTarget', 'reload'], '历史目标必须先核验自身，且不能继承最新目录前置');
        assert.ok(f.prompts.some(options => options.title === '请确认安装计划'));
    }
    {
        const f = fixture([
            { id: 'Target', dependencies: [], directoryDependencies: [{ id: 'NewFramework' }], boot: { name: 'Target', version: '1.0.0', dependenceInfo: [{ modName: 'Middle', version: '>=1.0.0' }] } },
            { id: 'Middle', boot: { name: 'Middle', version: '1.0.0', dependenceInfo: [{ modName: 'Base', version: '>=1.0.0' }, { modName: 'GameVersion', version: '>=0.5.0.0' }] } },
            { id: 'Base', boot: { name: 'Base', version: '1.0.0', dependenceInfo: [{ modName: 'ModLoader', version: '>=2.0' }] } },
            { id: 'NewFramework' }
        ]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:Target', 'prepare:Middle', 'prepare:Base', 'install:Base', 'install:Middle', 'install:Target', 'reload'], '全部目标与前置核验完成后才按依赖顺序写入');
    }
    {
        const f = fixture([
            { id: 'OldConsumer', boot: { name: 'OldConsumer', version: '1.0.0', dependenceInfo: [{ modName: 'Shared', version: '^1.0.0' }] } },
            { id: 'NewConsumer', boot: { name: 'NewConsumer', version: '1.0.0', dependenceInfo: [{ modName: 'Shared', version: '^2.0.0' }] } },
            { id: 'Independent' }, { id: 'Shared', version: '2.0.0' }
        ], [{ name: 'Shared', version: '1.0.0' }]);
        assert.equal((await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 3))).results.get('Independent').status, 'success');
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:Independent'], '共享前置版本冲突仅阻断全部受影响目标，不能误装前置或中断独立分支');
    }
    {
        const f = fixture([{ id: 'Unknown', compatibility: 'unknown' }]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '兼容性未知且未选择版本时，点击与Enter均不能开始预检');
    }
    {
        const f = fixture([
            { id: 'A', boot: { name: 'A', version: '1.0.0', dependenceInfo: [{ modName: 'B' }] } },
            { id: 'B', boot: { name: 'B', version: '1.0.0', dependenceInfo: [{ modName: 'A' }] } }
        ]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.ok(f.alerts.some(message => message.includes('循环依赖')));
        assert.equal(f.events.filter(event => event.startsWith('install:')).length, 0);
    }
    {
        const f = fixture([{ id: 'First', bytes: 160 * 1024 * 1024 }, { id: 'Second', assetSize: 160 * 1024 * 1024 }]);
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.ok(f.alerts.some(message => message.includes('256 MB')));
        assert.deepEqual(f.events, ['prepare:First'], '累计缓存超额必须在写入任何模组前整体停止');
    }
    {
        const f = fixture([{ id: 'Existing', version: '2.0.0', boot: { name: 'Existing', version: '2.0.0' } }], [{ name: 'Existing', version: '1.0.0' }]);
        assert.equal((await f.sb.modHubMarketInstaller.installBatch(f.mods, { updateOnly: true })).results.get('Existing').status, 'success');
        assert.ok(f.events.includes('install:Existing'), '全部更新必须对已安装顶层目标生成更新动作');
        assert.equal(f.profiles.get('Existing').version, '2.0.0');
    }
    {
        const f = fixture([{ id: 'UnknownDependency', boot: { name: 'UnknownDependency', version: '1.0.0', dependenceInfo: [{ modName: 'UnmappedTechnicalName' }] } }]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.ok(f.alerts.some(message => message.includes('无法精确识别')));
        assert.equal(f.events.filter(event => event.startsWith('install:')).length, 0, '未知技术名依赖不能被静默丢弃');
    }
    {
        const f = fixture([{ id: 'NativeRange', boot: { name: 'NativeRange', version: '1.0.0', dependenceInfo: [{ modName: 'Framework', version: '=1.2.0||>=2.0.0&&<3.0.0' }] } }, { id: 'Framework' }], [{ name: 'Framework', version: '1.2.0' }]);
        let checked = 0;
        f.sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
            parseRange: value => value.split('||').map(range => ({ range })),
            satisfies: (version, ranges) => { checked++; assert.equal(ranges[0].range, '=1.2.0'); assert.deepEqual(Array.from(version.version), [1, 2, 0]); return true; }
        }) }) };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.ok(checked > 0, '普通前置的等号和组合范围必须通过原生 InfiniteSemVer 核验');
        assert.ok(!f.events.includes('prepare:Framework'), '本地原生范围已满足时无需下载新版前置');
    }
    {
        const f = fixture([{ id: 'AfterStoppedBatch' }]);
        f.sb.modHubMarket.batchInstallState.stopRequested = true;
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '前次批量停止状态不能阻止下一次单装');
    }
    {
        const f = fixture([
            { id: 'Broken', boot: { name: 'Broken', version: '1.0.0', dependenceInfo: [{ modName: 'Shared', version: '^2.0.0' }, { modName: 'Missing' }] } },
            { id: 'Viable', boot: { name: 'Viable', version: '1.0.0', dependenceInfo: [{ modName: 'Shared', version: '^1.0.0' }] } },
            { id: 'Shared', version: '2.0.0' }
        ], [{ name: 'Shared', version: '1.0.0' }]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 2));
        assert.equal(result.results.get('Broken').status, 'skipped');
        assert.equal(result.results.get('Viable').status, 'success', '结构失败分支不能推动共享前置升级而连带阻断有效目标');
        assert.ok(!f.events.includes('prepare:Shared'), '已失败分支的新版前置无需下载');
        assert.equal(f.profiles.get('Shared').version, '1.0.0');
    }
    {
        const f = fixture([{ id: 'Mismatch', compatibility: 'incompatible' }]);
        f.sb.modHubConfirm = async options => {
            if (options.title.startsWith('选择【')) { await f.renderDialog(options); return { selectedKey: 'release:Mismatch', manual: true }; }
            return options.title !== '确认版本风险';
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '发布记录已知不适配风险被拒绝后必须零下载、零写入');
    }
    {
        const f = fixture([{ id: 'First' }, { id: 'Second' }]);
        const original = f.sb.modHubMarket.downloadAndInstallMod;
        f.sb.modHubMarket.downloadAndInstallMod = async (...args) => {
            const result = await original(...args);
            if (!args[2].prepareOnly) f.sb.modHubMarket.batchInstallState.stopRequested = true;
            return result;
        };
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods);
        assert.equal(result.results.get('First').status, 'success');
        assert.equal(result.results.get('Second').status, 'skipped');
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:First'], '批量停止保留已成功写入项并跳过后续');
        assert.equal(f.events.filter(event => event === 'reload').length, 1, '写入后停止只为已完成变更提示一次重载');
    }
    {
        const f = fixture([{ id: 'CancelFinal' }]);
        const original = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => options.title === '请确认安装计划' ? false : original(options);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '取消首次计划必须零包体下载、零导入、零启用及零重载');
        assert.equal(f.preparedCalls.length, 0);
        assert.deepEqual(f.alerts, [], '正常取消不能被误报为读取版本失败');
        assert.equal(f.progress.size, 0, '取消最终计划必须释放待确认进度');
        f.sb.modHubConfirm = original;
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '取消后应能再次选版并安装');
        assert.equal(f.progress.get('CancelFinal'), 'success', '最终清理不能擦掉成功状态');
    }
    {
        const f = fixture([{ id: 'Prerelease' }]);
        let calls = 0;
        f.sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: value => { assert.equal(value, '1.0.0-beta.1'); return { version: { version: [1, 0, 0], prerelease: 'beta.1' } }; },
            parseRange: range => [{ range }],
            satisfies: (version, ranges, ignorePostfix) => {
                calls++; assert.equal(version.prerelease, 'beta.1'); assert.equal(ranges[0].range, '>=1.0.0');
                assert.notEqual(ignorePostfix, true, '普通前置不得套用游戏版本忽略后缀策略'); return false;
            }
        }) }) };
        assert.equal(f.sb.modHubMarketInstaller.satisfiesDependency({ name: 'Prerelease', version: '1.0.0-beta.1' }, { version: '>=1.0.0' }), false);
        assert.equal(calls, 1, '公开依赖核验与安装内部必须复用相同原生接口');
        f.sb.modSC2DataManager = null;
        const check = f.sb.modHubMarketInstaller.satisfiesDependency;
        assert.equal(check({ name: 'Prerelease', version: '1.2.0' }, { version: '=1.2.0' }), true, '缺少原生接口仍复用现有简单等号比较');
        assert.equal(check({ name: 'Prerelease', version: '1.2.0' }, { version: '>=1.0.0' }), true);
        assert.equal(check({ name: 'Prerelease', version: '1.2.0' }, { version: '>=2.0.0' }), false);
        assert.equal(check({ name: 'Prerelease', version: '1.2.0' }, { version: '>=1.0.0&&<2.0.0' }), false, '缺少原生接口不能自行猜测复杂范围');
    }
    {
        const mb = 1024 * 1024;
        const candidate = version => ({ candidateKey: `D-${version}`, seriesKey: 'D', version,
            assets: [{ name: `D-${version}.zip`, downloadUrl: `https://example.com/D-${version}.zip`, size: 100 * mb }],
            compatibility: { status: 'compatible', evidence: 'declaration' } });
        const f = fixture([
            { id: 'A', bytes: 10 * mb, boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }] } },
            { id: 'B', bytes: 10 * mb, boot: { name: 'B', version: '1.0', dependenceInfo: [{ modName: 'C' }] } },
            { id: 'D', candidates: [candidate('1.0'), candidate('2.0')], packages: {
                'D-1.0': { bytes: 100 * mb, boot: { name: 'D', version: '1.0', dependenceInfo: [{ modName: 'Obsolete' }] } },
                'D-2.0': { bytes: 100 * mb, boot: { name: 'D', version: '2.0', dependenceInfo: [{ modName: 'Replacement' }] } }
            } },
            { id: 'C', bytes: 10 * mb, boot: { name: 'C', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=2.0' }] } },
            { id: 'Obsolete', bytes: 100 * mb }, { id: 'Replacement', bytes: 100 * mb }
        ]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 2));
        assert.equal(result.results.get('A').status, 'success'); assert.equal(result.results.get('B').status, 'success');
        assert.deepEqual(f.preparedCalls.filter(call => call.id === 'D').map(call => call.key), ['D-1.0', 'D-2.0'], '较深前置发现迟到约束时必须重新选版并核验');
        assert.equal(f.preparedCalls.find(call => call.key === 'D-2.0').remaining, 226 * mb, '被替代主包及孤立旧前置必须释放累计预算');
        assert.equal(f.profiles.get('D').version, '2.0'); assert.ok(f.profiles.has('Replacement'));
        assert.ok(!f.profiles.has('Obsolete'), '换版后旧依赖边不能进入执行计划');
        assert.ok(f.events.indexOf('prepare:Replacement') < f.events.indexOf('install:Replacement'), '闭包稳定前不能开始写入');
    }
    {
        const f = fixture([{ id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D' }] } }, { id: 'D' }, { id: 'E' }],
            [{ name: 'D', version: '1.0', dependenceInfo: [{ modName: 'E', version: '>=1.0' }] }]);
        f.sb._modHubModState.sideDisabled = ['D'];
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:A', 'prepare:E', 'install:E', 'enable:D', 'install:A', 'reload'], '已安装前置必须展开本地boot依赖，补齐后才启用');
        assert.ok(!f.events.includes('prepare:D'), '本地D版本已满足，无需下载新D');
    }
    {
        const f = fixture([{ id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D' }] } }, { id: 'D' }], [{ name: 'D', version: '1.0' }]);
        f.sb._modHubModState.sideDisabled = ['D'];
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => { if (options.title === '请确认安装计划') f.sb._modHubModState.sideDisabled = []; return confirm(options); };
        f.sb.modHubToggleSideMod = async () => { throw new Error('已启用时不应再次切换'); };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '确认期间前置已被启用必须按真实状态继续');
    }
    {
        const f = fixture([{ id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=2.0' }] } }, { id: 'D', version: '2.0' }], [{ name: 'D', version: '1.0' }]);
        const status = f.sb.modHubMarket.checkModInstallStatus;
        const getInfo = f.sb.modHubGetModInfo;
        f.sb.modHubMarket.checkModInstallStatus = mod => {
            const result = status(mod); if (mod.id === 'D') mod._matchedLocal = { name: 'D', version: '1.0', bootJson: { name: 'D', version: '1.0' } }; return result;
        };
        f.sb.modHubGetModInfo = name => name === 'D' ? { bootJson: { name: 'D', version: '1.0' } } : getInfo(name);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '本批已写入D2未重载时不能被运行时D1旧缓存误阻断');
        assert.equal(f.profiles.get('D').version, '2.0');
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:D', 'install:A']);
    }
    {
        const f = fixture([{ id: 'CancelConflict' }]);
        f.sb.modHubMarket.confirmInstallConflicts = async (getPlan, options) => {
            assert.equal(options.allowDisable, false, '准备确认期间不能开放会写状态的快捷禁用'); return false;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '取消下载前冲突确认必须零下载、零导入、零启用');
    }
    {
        const f = fixture([{ id: 'ManualDowngrade', version: '1.5.0' }], [{ name: 'ManualDowngrade', version: '2.0.0' }]);
        const original = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            if (options.title.startsWith('选择【')) {
                await f.renderDialog(options);
                assert.equal(options.canConfirm(), false, '唯一推荐旧版也必须等待一次明确勾选');
                return { selectedKey: 'release:ManualDowngrade', manual: true };
            }
            return original(options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.ok(f.prompts.some(options => options.title === '确认版本风险'), '人工降级仍须二次确认');
        const risks = f.prompts.filter(options => options.title === '确认版本风险');
        assert.equal(risks.length, 1, '下载前后相同风险沿用原确认集合，不得重复询问');
        assert.ok(risks[0].message.includes('当前游戏版本：DoL 0.5.0.0') && risks[0].message.includes('当前已安装版本：2.0.0；所选模组版本：1.5.0'));
        assert.ok(risks[0].message.includes('【ManualDowngrade】将从 2.0.0 降至 1.5.0'), '风险纯文本保持原具体原因');
        for (const value of ['0.5.0.0', '2.0.0', '1.5.0']) assert.ok(risks[0].trustedMessageHtml.includes(`<strong class="gold">${value}</strong>`));
        assert.ok(risks[0].trustedMessageHtml.includes('<strong class="gold">【ManualDowngrade】</strong>') && risks[0].trustedMessageHtml.includes('<strong class="red">继续可能导致模组无法运行</strong>'));
        assert.equal(f.profiles.get('ManualDowngrade').version, '1.5.0');
    }
    {
        const candidate = { candidateKey: 'reference', seriesKey: 'Reference', version: '1.0', assets: [{ name: 'Reference.zip', downloadUrl: 'https://example.com/Reference.zip' }],
            compatibility: { status: 'unknown', evidence: 'filename', targetGameVersion: '0.5.0.0', gameVersion: '0.5.0.0', referenceMismatch: false } };
        for (const batch of [false, true]) {
            const f = fixture([{ id: 'Reference', stale: true, candidates: [candidate] }]);
            if (batch) await f.sb.modHubMarketInstaller.installBatch(f.mods); else await f.sb.modHubMarketInstaller.install(f.mods[0]);
            const html = f.prompts[0].renderedHtml;
            assert.ok(html.includes('参考推荐') && html.includes('过期缓存') && html.includes('2026-09-29T00:00:00Z'), '单装与批量均须展示文件名参考推荐及过期缓存获取时间');
        }
    }
    {
        const f = fixture([{ id: 'BrokenBudget', bytes: 160 * 1024 * 1024, boot: { name: 'BrokenBudget', version: '1.0', dependenceInfo: [{ modName: 'Missing' }] } },
            { id: 'IndependentBudget', bytes: 160 * 1024 * 1024, assetSize: 160 * 1024 * 1024 }]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods);
        assert.equal(result.results.get('BrokenBudget').status, 'skipped'); assert.equal(result.results.get('IndependentBudget').status, 'success');
        assert.deepEqual(f.events.filter(event => event.startsWith('install:')), ['install:IndependentBudget'], '明确失败分支必须释放包体预算供独立目标使用');
    }
    {
        const candidate = (id, version) => ({ candidateKey: `${id}-${version}`, seriesKey: id, version,
            assets: [{ name: `${id}-${version}.zip`, downloadUrl: `https://example.com/${id}-${version}.zip` }],
            compatibility: { status: 'compatible', evidence: 'declaration' } });
        const f = fixture([
            { id: 'A', candidates: [candidate('A', '1.0'), candidate('A', '2.0')], packages: {
                'A-1.0': { boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'B', version: '>=2.0' }] } },
                'A-2.0': { boot: { name: 'A', version: '2.0', dependenceInfo: [{ modName: 'B', version: '<2.0' }] } }
            } },
            { id: 'B', candidates: [candidate('B', '1.0'), candidate('B', '2.0')], packages: {
                'B-1.0': { boot: { name: 'B', version: '1.0', dependenceInfo: [{ modName: 'A', version: '<2.0' }] } },
                'B-2.0': { boot: { name: 'B', version: '2.0', dependenceInfo: [{ modName: 'A', version: '>=2.0' }] } }
            } }
        ]);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.ok(f.preparedCalls.length <= 4, '候选与约束重复时必须结束，不能无限重选循环');
        assert.equal(f.events.filter(event => event.startsWith('install:')).length, 0);
    }
    {
        const f = fixture([{ id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D' }] } }, { id: 'D' }], [{ name: 'D', version: '1.0' }]);
        f.sb._modHubModState.sideDisabled = ['D'];
        f.sb.modHubToggleSideMod = async () => { f.sb._modHubModState.sideDisabled = []; return false; };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true, '切换返回false但真实前置已启用时不能误判失败');
    }
    {
        const f = fixture([{ id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D' }] } }, { id: 'D' }],
            [{ name: 'D', version: '1.0', dependenceInfo: [{ modName: 'GameVersion', version: '>=0.6.0' }] }]);
        f.sb._modHubModState.sideDisabled = ['D'];
        f.sb.modHubMarket.getPreparedCompatibilityRisks = boots => boots.filter(boot => boot?.name === 'D').map(boot => ({ key: 'D-game-mismatch', name: boot.name, status: 'incompatible', reason: '需要本体 >=0.6.0' }));
        const confirm = f.sb.modHubConfirm;
        let riskPrompt;
        f.sb.modHubConfirm = async options => options.title === '确认版本风险' ? (riskPrompt = options, false) : confirm(options);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.ok(riskPrompt.message.includes('【D】\n当前已安装版本：1.0；所选模组版本：1.0'), '启用现有前置时以本地真实档案显示所选版本');
        assert.deepEqual(f.events, ['prepare:A'], '拒绝本次将启用前置的真实本体不适配风险后必须零启用、零导入');
        assert.deepEqual(f.sb._modHubModState.sideDisabled, ['D']);
    }
    {
        const f = fixture([
            { id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }, { modName: 'Fail' }] } },
            { id: 'B', boot: { name: 'B', version: '1.0', dependenceInfo: [{ modName: 'C' }] } },
            { id: 'D', boot: { name: 'D', version: '1.0', dependenceInfo: [{ modName: 'Base' }] } },
            { id: 'Fail', boot: { name: 'Fail', version: '1.0', dependenceInfo: [{ modName: 'Missing' }] } },
            { id: 'C', boot: { name: 'C', version: '1.0', dependenceInfo: [{ modName: 'E' }] } },
            { id: 'E', boot: { name: 'E', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }] } }, { id: 'Base' }
        ]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 2));
        assert.equal(result.results.get('A').status, 'skipped'); assert.equal(result.results.get('B').status, 'success');
        assert.equal(f.preparedCalls.filter(call => call.id === 'D').length, 2, '失败分支释放共享包后，较深有效分支仍可重新核验同一候选');
        assert.ok(f.profiles.has('Base'), '被回收共享节点的旧边清理后必须重新建立真实闭包');
    }
    for (const nested of [false, true]) {
        const candidate = version => ({ candidateKey: `D-${version}`, seriesKey: 'D', version,
            assets: [{ name: `D-${version}.zip`, downloadUrl: `https://example.com/D-${version}.zip` }],
            compatibility: { status: 'compatible', evidence: 'declaration' } });
        const f = fixture([
            { id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }] } },
            { id: 'B', boot: { name: 'B', version: '1.0', dependenceInfo: [{ modName: 'C' }] } },
            { id: 'D', candidates: [candidate('1.0'), candidate('2.0')], packages: {
                'D-1.0': { boot: { name: 'D', version: '1.0', dependenceInfo: [{ modName: nested ? 'OldChild' : 'Missing' }] } },
                'D-2.0': { boot: { name: 'D', version: '2.0' } }
            } },
            { id: 'C', boot: { name: 'C', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=2.0' }] } },
            { id: 'OldChild', boot: { name: 'OldChild', version: '1.0', dependenceInfo: [{ modName: 'Missing' }] } }
        ]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 2));
        assert.equal(result.results.get('A').status, 'success'); assert.equal(result.results.get('B').status, 'success');
        assert.deepEqual(f.preparedCalls.filter(call => call.id === 'D').map(call => call.key), ['D-1.0', 'D-2.0'], '旧候选自身或旧闭包缺前置不能永久阻断迟到约束触发换版');
        assert.equal(f.profiles.get('D').version, '2.0'); assert.ok(!f.profiles.has('OldChild'));
    }
    for (const change of ['version', 'dependencies']) {
        const f = fixture([
            { id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }] } },
            { id: 'D' }, { id: 'E' }
        ], [{ name: 'D', version: '1.0' }]);
        f.sb._modHubModState.sideDisabled = ['D'];
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            const answer = await confirm(options);
            if (options.title === '请再次核对安装计划') {
                const boot = change === 'version' ? { name: 'D', version: '0.5' }
                    : { name: 'D', version: '1.0', dependenceInfo: [{ modName: 'E', version: '>=1.0' }] };
                f.profiles.set('D', { ...boot, bootJson: boot });
            }
            return answer;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, ['prepare:A'], '确认后禁用前置的版本或依赖变化时，必须在启用及导入之前中止');
        assert.deepEqual(f.sb._modHubModState.sideDisabled, ['D'], '前置变更后必须保持原禁用状态');
        assert.equal(f.progress.size, 0, '中止计划必须清除准备进度');
    }
    {
        const f = fixture([
            { id: 'A', boot: { name: 'A', version: '1.0', dependenceInfo: [{ modName: 'C', version: '>=1.0' }] } },
            { id: 'C' }, { id: 'D' }, { id: 'E' }
        ], [
            { name: 'C', version: '1.0', dependenceInfo: [{ modName: 'D', version: '>=1.0' }] },
            { name: 'D', version: '1.0' }
        ]);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            const answer = await confirm(options);
            if (options.title === '请再次核对安装计划') {
                const boot = { name: 'D', version: '1.0', dependenceInfo: [{ modName: 'E', version: '>=1.0' }] };
                f.profiles.set('D', { ...boot, bootJson: boot });
            }
            return answer;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, ['prepare:A'], '已启用的深层前置新增依赖时，必须复核递归闭包并阻止目标导入');
        assert.equal(f.profiles.has('A'), false);
        assert.equal(f.profiles.has('E'), false, '未重新确认的新增前置不得擅自安装');
        assert.equal(f.progress.size, 0);
    }
    {
        const f = fixture([{ id: 'Upgrade', version: '2.0' }], [{ name: 'Upgrade', version: '1.0' }]);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            const answer = await confirm(options);
            if (options.title === '请确认安装计划') {
                const boot = { name: 'Upgrade', version: '3.0' };
                f.profiles.set('Upgrade', { ...boot, bootJson: boot });
            }
            return answer;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.deepEqual(f.events, [], '下载前确认期间本地目标升至更高版本时，必须停止原计划且零下载');
        assert.equal(f.profiles.get('Upgrade').version, '3.0', '外部新安装的版本必须保留');
        assert.equal(f.progress.size, 0);
    }

    {
        const f = fixture([{ id: 'CancelBatchA' }, { id: 'CancelBatchB' }]);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = options => options.title === '请确认安装计划' ? false : confirm(options);
        assert.equal(await f.sb.modHubMarketInstaller.installBatch(f.mods), false);
        assert.deepEqual(f.events, [], '批量取消首次计划必须零包体下载、零写入及零重载');
        assert.equal(f.preparedCalls.length, 0); assert.equal(f.progress.size, 0);
    }
    for (const accept of [false, true]) {
        const f = fixture([{ id: 'NewDependencyTarget', boot: { name: 'NewDependencyTarget', version: '1.0.0', dependenceInfo: [{ modName: 'NewDependency', version: '>=1.0.0' }] } }, { id: 'NewDependency' }]);
        const confirm = f.sb.modHubConfirm;
        let initialApproved = false, extraApproved = false;
        f.sb.modHubConfirm = async options => {
            if (options.title === '请确认安装计划') {
                assert.deepEqual(f.events, [], '首次计划前不能下载');
                assert.ok(options.trustedMessageHtml.includes('尚未下载。下载后会检查支持的游戏版本和所需前置模组。'));
                assert.ok(options.trustedMessageHtml.includes('目前还没有下载或安装。确认后开始下载，并检查游戏版本和前置模组；如有变化，会请你再次确认。'));
                initialApproved = true;
            }
            if (options.title === '请再次核对安装计划') {
                assert.ok(options.trustedMessageHtml.includes('安装包已下载，尚未安装。检查结果与之前的计划不同，请再次核对。确认后开始安装，取消则不安装。'));
                assert.equal(options.confirmText, '确认并安装');
            }
            if (options.title === '安装计划有变更') {
                assert.equal(initialApproved, true);
                assert.deepEqual(f.events, ['prepare:NewDependencyTarget'], '新增前置确认之前只能下载已批准的目标包');
                assert.ok(options.message.includes('NewDependencyTarget') && options.message.includes('NewDependency'));
                extraApproved = accept;
                if (!accept) return false;
            }
            return confirm(options);
        };
        const download = f.sb.modHubMarket.downloadAndInstallMod;
        f.sb.modHubMarket.downloadAndInstallMod = async (mod, mirror, options) => {
            if (options.prepareOnly && mod.id === 'NewDependency') assert.equal(extraApproved, true, '新增前置必须确认后才下载');
            return download(mod, mirror, options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), accept);
        assert.deepEqual(f.events.filter(event => event.startsWith('prepare:')), accept ? ['prepare:NewDependencyTarget', 'prepare:NewDependency'] : ['prepare:NewDependencyTarget']);
        assert.equal(f.preparedCalls.filter(call => call.id === 'NewDependency').length, accept ? 1 : 0);
        assert.equal(f.progress.get('NewDependencyTarget') === 'prepared', false, '取消或完成都不能遗留待确认进度');
        if (!accept) { assert.deepEqual(f.alerts, []); assert.equal(f.profiles.has('NewDependencyTarget'), false); }
    }
    {
        const f = fixture([{ id: 'SkipMapleTarget', dependencies: [{ id: 'maplebirch', version: '>=2.0.0' }], boot: {
            name: 'SkipMapleTarget', version: '1.0.0', dependenceInfo: [{ modName: 'maplebirch', version: '^3.0.0' }]
        } }, { id: 'maplebirch', version: '5.2.0' }], [{ name: 'maplebirch', version: '5.1.3' }]);
        useNativeDependencyRanges(f);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            if (options.title === '选择【maplebirch】版本') {
                await f.renderDialog(options);
                assert.ok(options.trustedMessageHtml.includes('暂不安装此前置'));
                return { selectedKey: '__skip__', manual: true };
            }
            return confirm(options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.deepEqual(f.events, ['prepare:SkipMapleTarget', 'install:SkipMapleTarget', 'reload'], '主动跳过不足范围的已有前置只能写入目标，不能替换或降级框架');
        assert.equal(f.profiles.get('maplebirch').version, '5.1.3');
        const risk = f.prompts.find(options => options.title === '确认版本风险');
        assert.ok(risk.message.includes('SkipMapleTarget') && risk.message.includes('3.0.0及以上，低于4.0.0') && risk.message.includes('无法运行'));
        assert.ok(reviewedPlan(f).trustedMessageHtml.includes('暂不安装前置') && !reviewedPlan(f).trustedMessageHtml.includes('已满足的前置'));
    }
    {
        const f = fixture([{ id: 'ChangedSkipTarget', dependencies: [{ id: 'maplebirch', version: '^3.0.0' }], boot: {
            name: 'ChangedSkipTarget', version: '1.0.0', dependenceInfo: [{ modName: 'maplebirch', version: '>=2.0.0' }]
        } }, { id: 'maplebirch', version: '5.2.0' }], [{ name: 'maplebirch', version: '5.1.3' }]);
        useNativeDependencyRanges(f);
        const confirm = f.sb.modHubConfirm;
        let risks = 0;
        f.sb.modHubConfirm = async options => {
            if (options.title === '选择【maplebirch】版本') { await f.renderDialog(options); return { selectedKey: '__skip__', manual: true }; }
            if (options.title === '确认版本风险' && ++risks === 2) {
                assert.ok(options.message.includes('2.0.0及以上'), '实际包新增已跳过的约束时需显示新范围');
                return false;
            }
            return confirm(options);
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(risks, 2, '旧的跳过确认不能覆盖实际包新增要求');
        assert.deepEqual(f.events, ['prepare:ChangedSkipTarget']);
        assert.equal(f.progress.size, 0);
    }
    {
        const f = fixture([{ id: 'ManualMissing', boot: { name: 'ManualMissing', version: '1.0.0', dependenceInfo: [{ modName: 'UnknownManualDependency', version: '>=1' }] } }]);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = options => options.title === '前置需要手动处理' ? 'skip' : confirm(options);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        assert.ok(f.prompts.some(options => options.title === '确认版本风险' && options.message.includes('UnknownManualDependency')), '无法映射的前置也可明确跳过，但必须确认风险');
        assert.deepEqual(f.events, ['prepare:ManualMissing', 'install:ManualMissing', 'reload']);
    }
    {
        const maple = { name: 'maplebirch', version: '5.1.3', alias: ['Simple Frameworks'] };
        const f = fixture([{ id: 'NativeAliasConsumer', boot: { name: 'NativeAliasConsumer', version: '1.0.0', dependenceInfo: [{ modName: 'Simple Frameworks', version: '>=1.5.0' }] } }, { id: 'maplebirch', boot: maple }], [maple]);
        useNativeProfiles(f);
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), true);
        const html = reviewedPlan(f).trustedMessageHtml;
        assert.ok(html.includes('作者要求【Simple Frameworks】') && html.includes('已由【maplebirch】通过声明的兼容别名提供，无需重复安装'), '兼容别名代供应保留作者需求与实际提供者，并说明无需重复安装');
        assert.ok(!html.includes('不是同一模组'), '已确认的兼容别名不能作为身份风险警告');
        assert.ok(!f.events.includes('prepare:maplebirch'));
    }
    {
        const candidates = ['1.0.0', '2.0.0'].map(version => ({ candidateKey: `MetadataShared:${version}`, version, seriesKey: 'MetadataShared',
            assets: [{ name: `MetadataShared-${version}.zip`, size: 1 }], compatibility: { status: 'compatible', evidence: 'declaration', reason: '测试适配声明' } }));
        const f = fixture([
            { id: 'MetadataA', dependencies: [{ id: 'MetadataShared', version: '>=1.0.0' }] },
            { id: 'MetadataB', dependencies: [{ id: 'MetadataMiddle' }] },
            { id: 'MetadataMiddle', dependencies: [{ id: 'MetadataShared', version: '>=2.0.0' }] },
            { id: 'MetadataShared', candidates, packages: {
                'MetadataShared:1.0.0': { boot: { name: 'MetadataShared', version: '1.0.0' } },
                'MetadataShared:2.0.0': { boot: { name: 'MetadataShared', version: '2.0.0' } }
            } }
        ]);
        const confirm = f.sb.modHubConfirm;
        f.sb.modHubConfirm = async options => {
            if (options.title === '请确认安装计划') {
                assert.deepEqual(f.events, [], '迟到约束合并与重选应在首次下载确认之前完成');
                assert.ok(options.trustedMessageHtml.includes('MetadataShared') && options.trustedMessageHtml.includes('2.0.0'), '初步计划必须采用满足全部约束的新候选');
            }
            return confirm(options);
        };
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 2));
        assert.equal(result.results.get('MetadataA').status, 'success');
        assert.equal(result.results.get('MetadataB').status, 'success');
        assert.deepEqual(f.preparedCalls.filter(call => call.id === 'MetadataShared').map(call => call.key), ['MetadataShared:2.0.0'], '元数据阶段的旧候选不得先被下载');
        assert.equal(f.prompts.filter(options => options.title === '选择【MetadataShared】版本').length, 2, '共享约束迟到时须有界地重选一次');
    }
    {
        const f = fixture([{ id: 'EnableChangeTarget', dependencies: [{ id: 'EnableChangeLocal', version: '>=1.0.0' }],
            boot: { name: 'EnableChangeTarget', version: '1.0.0' } }, { id: 'EnableChangeLocal' }], [{ name: 'EnableChangeLocal', version: '1.0.0' }]);
        const confirm = f.sb.modHubConfirm;
        let changed = false;
        f.sb.modHubConfirm = async options => {
            if (options.title === '请再次核对安装计划') {
                changed = true;
                assert.ok(options.trustedMessageHtml.includes('EnableChangeLocal') && options.trustedMessageHtml.includes('启用'), '原有满足前置新增启用动作必须列入变化');
                return false;
            }
            const result = await confirm(options);
            if (options.title === '请确认安装计划') f.sb._modHubModState.sideDisabled = ['EnableChangeLocal'];
            return result;
        };
        assert.equal(await f.sb.modHubMarketInstaller.install(f.mods[0]), false);
        assert.equal(changed, true, 'boot 未变但启禁动作改变时不能跳过再次确认');
        assert.deepEqual(f.events, ['prepare:EnableChangeTarget'], '取消计划变化不能擅自启用前置或导入目标');
        assert.deepEqual(f.sb._modHubModState.sideDisabled, ['EnableChangeLocal']);
        assert.equal(f.progress.size, 0, '取消变化确认必须释放已准备包体与进度');
    }
    {
        const candidates = ['1.0.0', '2.0.0'].map(version => ({ candidateKey: `SelectedRootFramework:${version}`, version, seriesKey: 'SelectedRootFramework',
            assets: [{ name: `SelectedRootFramework-${version}.zip`, size: 1 }], compatibility: { status: 'compatible', evidence: 'declaration', reason: '测试适配声明' } }));
        const f = fixture([
            { id: 'SelectedRootFramework', candidates, packages: {
                'SelectedRootFramework:1.0.0': { boot: { name: 'SelectedRootFramework', version: '1.0.0' } },
                'SelectedRootFramework:2.0.0': { boot: { name: 'SelectedRootFramework', version: '2.0.0' } }
            } },
            { id: 'SelectedRootConsumer', dependencies: [{ id: 'SelectedRootFramework', version: '>=2.0.0' }] }
        ]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods);
        assert.equal(result.results.get('SelectedRootFramework').status, 'success');
        assert.equal(result.results.get('SelectedRootConsumer').status, 'success');
        assert.deepEqual(f.preparedCalls.filter(call => call.id === 'SelectedRootFramework').map(call => call.key), ['SelectedRootFramework:2.0.0'], '共享前置也是目标时，下载阶段必须采用初步计划已批准的重选，不得退回最初的旧根选择');
        assert.ok(!f.prompts.some(options => options.title === '安装计划有变更'), '已批准新版不能再提示需要倒退下载旧版本');
    }
    {
        const f = fixture([
            { id: 'StableLocalA', dependencies: [{ id: 'StableLocalShared', version: '>=1.0.0' }] },
            { id: 'StableLocalB', dependencies: [{ id: 'StableLocalMiddle' }] },
            { id: 'StableLocalX', dependencies: [{ id: 'StableLocalDeep1' }] },
            { id: 'StableLocalMiddle', dependencies: [{ id: 'StableLocalShared', version: '>=2.0.0' }] },
            { id: 'StableLocalDeep1', dependencies: [{ id: 'StableLocalDeep2' }] },
            { id: 'StableLocalDeep2', dependencies: [{ id: 'StableLocalShared', version: '>=2.0.0' }] },
            { id: 'StableLocalShared', version: '2.0.0' }
        ], [{ name: 'StableLocalShared', version: '1.0.0' }]);
        const result = await f.sb.modHubMarketInstaller.installBatch(f.mods.slice(0, 3));
        for (const id of ['StableLocalA', 'StableLocalB', 'StableLocalX']) assert.equal(result.results.get(id).status, 'success');
        assert.equal(f.prompts.filter(options => options.title === '选择【StableLocalShared】版本').length, 1, '初步已重选的候选满足更深相同约束时，不能因旧本地lastBoot或下载阶段局部约束再次选版');
        assert.deepEqual(f.preparedCalls.filter(call => call.id === 'StableLocalShared').map(call => call.key), ['release:StableLocalShared'], '尊重已批准的新版，主包必须只准备一次');
        assert.equal(f.profiles.get('StableLocalShared').version, '2.0.0');
    }
};
