// 市场包体准备、复用和写入边界。
const { assert, loadMarket, loadScripts, createStubElement } = require('./helpers');
const { webcrypto, createHash } = require('node:crypto');

module.exports = async function () {
    const fixture = () => {
        const sb = loadMarket();
        sb.Blob = Blob;
        sb.AbortController = AbortController;
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        sb.modHubGetGui = () => ({});
        const mod = { id: 'prepared-fixture', name: '准备测试', bootNames: ['PreparedFixture'],
            version: '9.0', githubUrl: 'https://github.com/ModHubTests/PreparedFixture' };
        const releaseInfo = { tagName: 'v1.0', version: '1.0', assets: [{ name: 'PreparedFixture1.0.zip',
            downloadUrl: `${mod.githubUrl}/releases/download/v1.0/PreparedFixture1.0.zip` }] };
        const state = { downloads: 0, reads: 0, imports: 0, confirms: 0,
            boot: { name: 'PreparedFixture', version: '1.0', dependenceInfo: [] } };
        const cards = new Map();
        const addCard = (name, idleText = '下载安装') => {
            if (cards.has(name)) cards.get(name).card.isConnected = false;
            const card = createStubElement();
            card.dataset.modName = name;
            card.isConnected = true;
            const progress = card.querySelector('.modhub-download-progress');
            progress.hidden = true;
            const classes = new Set();
            progress.classList = { toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
                remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) };
            const ring = progress.querySelector('.modhub-progress-ring'), ringClasses = new Set();
            ring.hidden = true;
            ring.classList = { toggle: (name, active) => active ? ringClasses.add(name) : ringClasses.delete(name),
                contains: name => ringClasses.has(name) };
            const attributes = new Map();
            ring.setAttribute = (key, value) => attributes.set(key, value);
            ring.removeAttribute = key => attributes.delete(key);
            ring.getAttribute = key => attributes.get(key);
            ring.setAttribute('role', 'progressbar');
            const button = card.querySelector('.btn-market-install, .btn-market-update');
            button.dataset.idleText = idleText;
            const value = ring.querySelector('.modhub-progress-value'), valueAttributes = new Map();
            value.setAttribute = (key, data) => valueAttributes.set(key, data);
            value.getAttribute = key => valueAttributes.get(key);
            const view = { card, progress, ring, button, value,
                label: progress.querySelector('.modhub-download-label'), cancel: progress.querySelector('.modhub-download-cancel') };
            cards.set(name, view);
            return view;
        };
        const view = addCard(mod.name);
        sb.document.querySelectorAll = selector => {
            if (selector !== '.modhub-market-card') return [];
            return [...cards.values()].map(item => item.card);
        };
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
            state.downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () => new Blob(['准备包体']) };
        };
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async () => { state.reads++; return state.boot; } });
        sb.modHubHandleAddMod = async (files, options) => {
            assert.equal(options.keepCurrentTab, true, '准备后的市场导入仍保持市场页签');
            state.restoreContext = options.restoreContext;
            state.imports++;
            return true;
        };
        sb.modHubConfirm = async () => { state.confirms++; return false; };
        const removeCard = name => { cards.get(name).card.isConnected = false; cards.delete(name); };
        return { sb, mod, releaseInfo, state, view, addCard, removeCard, market: sb.modHubMarket };
    };
    // 已知大小逐块更新真实圆环比例，未知大小不显示百分比，准备完成不继续等待动画。
    for (const knownSize of [false, true]) {
        const { sb, market, mod, releaseInfo, view } = fixture();
        let signalRead, finishRead;
        const nextRead = () => new Promise(resolve => { signalRead = resolve; });
        const reader = { read: () => { signalRead(); return new Promise(resolve => { finishRead = resolve; }); }, cancel: async () => {} };
        sb.fetch = async () => ({ ok: true, headers: { get: name => knownSize && name === 'Content-Length' ? '100' : null },
            body: { getReader: () => reader } });
        const firstRead = nextRead();
        const pending = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        await firstRead;
        const ring = view.ring, offsets = [];
        for (const percent of [25, 50, 75, 100]) {
            const read = nextRead(); finishRead({ done: false, value: new Uint8Array(25) }); await read;
            assert.equal(view.ring, ring, '流式更新复用圆环节点');
            assert.equal(ring.hidden, false);
            assert.equal(ring.classList.contains('is-determinate'), knownSize);
            assert.equal(ring.getAttribute('aria-valuenow'), knownSize ? String(percent) : undefined);
            if (knownSize) offsets.push(Number(view.value.getAttribute('stroke-dashoffset')));
        }
        if (knownSize) assert.ok(offsets.every((offset, index) => !index || offset < offsets[index - 1]), '实际比例增加时圆环进度相应增加');
        finishRead({ done: true }); assert.ok(await pending);
        assert.equal(ring.hidden, true);
        assert.equal(ring.getAttribute('aria-valuenow'), undefined, '准备完成后不保留正在运行的比例');
    }

    // 卡片重绘或离页后，只更新仍在页面中的新节点，返回页面时恢复当前真实状态。
    {
        const { sb, market, mod, releaseInfo, view, addCard, removeCard } = fixture();
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: [mod] }));
        await market.loadMarketData();
        let signalRead, finishRead;
        const nextRead = () => new Promise(resolve => { signalRead = resolve; });
        sb.fetch = async () => ({ ok: true, headers: { get: name => name === 'Content-Length' ? '100' : null },
            body: { getReader: () => ({ read: () => { signalRead(); return new Promise(resolve => { finishRead = resolve; }); } }) } });
        const firstRead = nextRead();
        const pending = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        await firstRead;
        const chunk = async () => { const read = nextRead(); finishRead({ done: false, value: new Uint8Array(25) }); await read; };
        await chunk();
        const replacement = addCard(mod.name);
        await chunk();
        assert.equal(view.ring.getAttribute('aria-valuenow'), '25', '重绘后不再回写旧卡片');
        assert.equal(replacement.ring.getAttribute('aria-valuenow'), '50');
        removeCard(mod.name);
        await chunk();
        assert.equal(replacement.ring.getAttribute('aria-valuenow'), '50', '离页后不再回写已脱离节点');
        const returned = addCard(mod.name), container = createStubElement();
        sb.document.getElementById = id => id === 'modHubMarketCardsContainer' ? container : null;
        market.renderMarketCards();
        assert.equal(returned.ring.getAttribute('aria-valuenow'), '75', '返回页面时从运行状态恢复真实比例');
        await chunk();
        assert.equal(returned.ring.getAttribute('aria-valuenow'), '100');
        finishRead({ done: true }); assert.ok(await pending);
        assert.equal(returned.ring.hidden, true);
    }

    // 安装内部没有真实比例，下载完成后改为不定圆环，成功、失败或取消后清理。
    for (const installed of [true, false]) {
        const { sb, market, mod, releaseInfo, view } = fixture();
        let finish, entered;
        const started = new Promise(resolve => { entered = resolve; });
        sb.modHubHandleAddMod = () => new Promise(resolve => { finish = resolve; entered(); });
        const pending = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, batchMode: true });
        await started;
        assert.equal(view.ring.hidden, false);
        assert.equal(view.ring.classList.contains('is-determinate'), false);
        assert.equal(view.ring.getAttribute('aria-valuenow'), undefined, '下载完成不能表示安装已完成');
        assert.match(view.ring.getAttribute('aria-label'), /安装进度/);
        finish(installed); assert.equal(await pending, installed);
        assert.equal(view.ring.hidden, true, '成功和失败都停止收尾圆环');
        assert.equal(view.progress.hidden, installed);
    }
    {
        const { sb, market, mod, releaseInfo, view } = fixture(), container = createStubElement();
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: [mod] }));
        await market.loadMarketData();
        sb.document.getElementById = id => id === 'modHubMarketCardsContainer' ? container : null;
        container.querySelectorAll = selector => selector === '.modhub-download-cancel' ? [view.cancel] : [];
        view.cancel.dataset.modIndex = '0'; market.renderMarketCards();
        assert.match(container.innerHTML, /class="modhub-progress-ring/);
        assert.doesNotMatch(container.innerHTML, /modhub-download-track|modhub-download-bar/);
        let fail, entered;
        const started = new Promise(resolve => { entered = resolve; });
        sb.fetch = () => new Promise((resolve, reject) => { fail = reject; entered(); });
        const pending = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        await started; view.cancel.onclick();
        assert.equal(view.ring.hidden, false, '等待已取消下载收尾时保留圆环');
        assert.equal(view.ring.getAttribute('aria-valuenow'), undefined);
        fail(Object.assign(new Error('已取消下载'), { name: 'AbortError' }));
        assert.equal(await pending, false);
        assert.equal(view.ring.hidden, true);
        assert.equal(view.progress.hidden, true);
    }

    const optionalAudioFixture = () => {
        const base = fixture(), { sb, state } = base;
        const mod = { id: 'deadwood-reblooms', identityId: 'deadwood-reblooms', name: '枯木逢春',
            bootNames: ['deadwood-reblooms'], version: '1.3.1', githubUrl: 'https://github.com/MaplebirchLeaf/Deadwood-Reblooms' };
        const mainName = 'deadwood-reblooms-0.5.12.13-v1.3.1.modpack';
        const audioName = 'deadwood-reblooms-audio-0.5.12.13-v1.3.1.modpack';
        const releaseInfo = { tagName: 'v1.3.1', version: '1.3.1', assets: [
            { name: mainName, downloadUrl: `${mod.githubUrl}/releases/download/v1.3.1/${mainName}`, packageRole: 'main' },
            { name: audioName, downloadUrl: `${mod.githubUrl}/releases/download/v1.3.1/${audioName}`,
                packageRole: 'audio', optional: true, bootName: 'deadwood-reblooms-audio' }
        ] };
        const mainBoot = { name: 'deadwood-reblooms', version: '1.3.1', dependenceInfo: [] };
        const audioBoot = { name: 'deadwood-reblooms-audio', version: '1.3.1',
            dependenceInfo: [{ modName: mainBoot.name, version: '>=1.3.1' }] };
        state.packBoots = new Map([[1, mainBoot], [2, audioBoot]]);
        state.localBoots = new Map([[mainBoot.name, mainBoot]]);
        state.disabledNames = new Set();
        state.importedFiles = [];
        const syncState = () => sb._modHubModState = {
            sideEnabled: [...state.localBoots.keys()].filter(name => !state.disabledNames.has(name)),
            sideDisabled: [...state.localBoots.keys()].filter(name => state.disabledNames.has(name)),
            sideMods: [...state.localBoots.keys()].map(name => ({ name, enabled: !state.disabledNames.has(name) })), builtInMods: [] };
        syncState();
        sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getModCacheArray: () =>
            [...state.localBoots.values()].map(bootJson => ({ mod: { name: bootJson.name, bootJson } })) }) } });
        sb.modHubLoadModManageState = async () => syncState();
        sb.fetch = async url => {
            state.downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () =>
                new Blob([new Uint8Array([String(url).includes('-audio-') ? 2 : 1])]) };
        };
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async bytes => {
            state.reads++;
            return state.packBoots.get(bytes[0]);
        } });
        sb.modHubHandleAddMod = async (input, options) => {
            assert.equal(options.keepCurrentTab, true, '只新增扩展也须保持市场页签');
            state.imports++;
            const files = Array.isArray(input) ? input : Array.from(input.files);
            state.importedFiles.push(files.map(file => file.name));
            for (const file of files) {
                const boot = state.packBoots.get(new Uint8Array(await file.arrayBuffer())[0]);
                state.localBoots.set(boot.name, boot);
            }
            syncState();
            return true;
        };
        return { ...base, mod, releaseInfo, mainBoot, audioBoot, mainName, audioName, syncState };
    };
    const sameBootPackageFixture = (marker = 1) => {
        const f = fixture(), { sb, mod, state, market } = f;
        sb.crypto = webcrypto;
        sb.atob = atob;
        mod.version = '1.8';
        mod.versionSource = 'github';
        mod.releaseUrl = `${mod.githubUrl}/releases/tag/v1.8`;
        const boot = { name: 'PreparedFixture', version: '1.7', dependenceInfo: [] };
        const packages = new Map([[1, new Uint8Array([1, 42, 255])], [2, new Uint8Array([2, 42, 255])], [3, new Uint8Array([3, 42, 255])]]);
        const stored = new Map([[boot.name, packages.get(marker)]]);
        const digest = data => 'sha256:' + createHash('sha256').update(data).digest('hex');
        const releaseInfo = { tagName: 'v1.8', version: '1.8', assets: [{ name: 'PreparedFixture.zip',
            downloadUrl: `${mod.githubUrl}/releases/download/v1.8/PreparedFixture.zip`, digest: digest(packages.get(2)) }] };
        sb._modHubModState = { sideEnabled: [boot.name], sideDisabled: [], sideMods: [{ name: boot.name, enabled: true }], builtInMods: [] };
        const loader = { customStore: {}, constructor: { calcModNameKey: name => name } };
        sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader,
            getModCacheArray: () => [{ mod: { name: boot.name, bootJson: boot } }] }),
            getIdbKeyValRef: () => ({ get: async name => stored.get(name) }) } });
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => {
            const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), char => char.charCodeAt(0)) : data;
            return bytes[0] === 3 ? { name: 'UnrelatedAliasProvider', alias: [boot.name], version: '99.0' }
                : { ...boot, version: state.persistedVersion || boot.version };
        } });
        sb.modHubLoadModManageState = async () => {};
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob([packages.get(2)]) });
        sb.modHubHandleAddMod = async input => {
            state.imports++;
            const files = Array.isArray(input) ? input : Array.from(input.files);
            stored.set(boot.name, new Uint8Array(await files[0].arrayBuffer()));
            return true;
        };
        return { ...f, boot, packages, stored, releaseInfo, digest };
    };
    {
        const { sb, market, mod, boot, releaseInfo, stored, packages, state } = sameBootPackageFixture();
        await market.refreshLocalPackageProfiles();
        const local = market.getLocalInstalledProfiles()[0];
        assert.equal(local.version, '1.7');
        assert.equal(market.isReleaseInstalled(releaseInfo, local), false, '同 boot 版本的旧包不能冒认为新发布已安装');
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(market.isPreparedComponentInstalled(prepared, prepared.boots[0]), false, '真正不同的包体需要替换');
        assert.equal(prepared.boots[0].version, '1.7', '发行1.8不能改写作者真实依赖版本');
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true, askRestart: false }), true);
        assert.deepEqual(stored.get(boot.name), packages.get(2));
        assert.equal(state.imports, 1);
        const updated = market.getLocalInstalledProfiles()[0];
        assert.equal(updated.version, '1.7', '更新后保留真实包内版本');
        assert.equal(market.isReleaseInstalled(releaseInfo, updated), true, '回读新包摘要后可确认对应发行已安装');
        assert.equal(sb.modHubGetModInfo(boot.name).bootJson.version, '1.7', '依赖接口不伪造发布标签版本');
    }
    {
        const { market, mod, releaseInfo, state } = sameBootPackageFixture(2);
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(market.isPreparedComponentInstalled(prepared, prepared.boots[0]), true);
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true,
            onFailure: (reason, code) => { failure = { reason, code }; } }), false);
        assert.equal(failure.code, 'ALREADY_INSTALLED', '真正同字节包不应重复安装');
        assert.equal(state.imports, 0);
    }
    {
        const { market, mod, releaseInfo, stored, packages, boot, state } = sameBootPackageFixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        stored.set(boot.name, packages.get(2));
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true,
            onFailure: (reason, code) => { failure = { reason, code }; } }), false);
        assert.equal(failure.code, 'INSTALL_PACKAGE_INVALID', '确认期间仓库包体变化，即使版本相同也须重新生成计划');
        assert.equal(state.imports, 0);
    }
    for (const base64 of [false, true]) {
        const { market, stored, packages, boot, releaseInfo } = sameBootPackageFixture(2);
        if (base64) stored.set(boot.name, Buffer.from(packages.get(2)).toString('base64'));
        await market.refreshLocalPackageProfiles();
        assert.equal(market.isReleaseInstalled(releaseInfo, market.getLocalInstalledProfiles()[0]), true, '真实字节和加载器base64存储使用同一包摘要');
        stored.set(boot.name, packages.get(3));
        await market.refreshLocalPackageProfiles();
        assert.equal(market.getLocalInstalledProfiles()[0].packageDigest, '', '错误技术名或别名仓库包不能取得当前模组的摘要身份');
    }
    for (const current of [1, 2]) {
        const { sb, market, mod, releaseInfo, state } = sameBootPackageFixture(current);
        sb.StartConfig = { version: '0.5.12.13' };
        const candidate = { ...releaseInfo, candidateKey: 'same-boot-release:1.8', seriesKey: mod.id,
            compatibility: { status: 'compatible', evidence: 'declaration', reason: '测试作者声明' } };
        loadScripts(sb, ['javascript/modhub-market-versions.js', 'javascript/modhub-market-install.js']);
        sb.modHubMarketVersions.fetchReleases = async () => ({ page: 1, hasMore: false });
        sb.modHubMarketVersions.buildCandidates = () => [candidate];
        sb.modHubConfirm = async options => {
            const dialog = createStubElement();
            await options.onRender?.(dialog);
            if (options.canConfirm && !options.canConfirm()) return false;
            return options.customResult ? options.customResult() : true;
        };
        assert.equal(await sb.modHubMarketInstaller.install(mod), current === 1, '公共选版、预检和安装计划均须按真实包体区分同号发行');
        assert.equal(state.imports, current === 1 ? 1 : 0, '已装原包不得再次写入，新内容同boot包允许替换');
        assert.equal(market.getLocalInstalledProfiles()[0].version, '1.7');
    }
    {
        const { sb, market, state, boot } = sameBootPackageFixture(2);
        state.persistedVersion = '1.8';
        assert.equal(sb.modHubGetModInfo(boot.name).bootJson.version, '1.7', '游戏尚在运行旧版时保留旧运行态');
        await market.refreshLocalPackageProfiles();
        assert.equal(market.getLocalInstalledProfiles()[0].version, '1.8', '市场必须显示新仓库版本，不能被旧运行态版本覆盖');
    }
    for (const preparedRoute of [false, true]) {
        for (const current of [1, 2]) {
            const { sb, market, mod, boot, releaseInfo, stored, state } = sameBootPackageFixture(current);
            const prepared = preparedRoute ? await market.downloadAndInstallMod(mod, 'ddlc', {
                releaseInfo, prepareOnly: true, batchMode: true }) : null;
            const changedBytes = new Uint8Array([4, 42, 255]);
            let waits = 0, failure;
            sb.modHubWaitManagerIdle = async () => {
                waits++;
                stored.set(boot.name, changedBytes);
                return true;
            };
            assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', {
                releaseInfo, ...(prepared ? { preparedPackage: prepared } : {}),
                batchMode: true, askRestart: false, restoreContext: {},
                onFailure: (reason, code) => { failure = { reason, code }; }
            }), false, '等待管理器期间同版本包体改变，直接与预检路径都须停止旧计划');
            assert.equal(waits, 1, '真实回读不通过轮询无限等待管理器');
            assert.equal(failure.code, 'INSTALL_PACKAGE_INVALID');
            assert.equal(state.imports, 0, '变化后不得导入旧目标或按旧缓存复用组件');
            assert.deepEqual(stored.get(boot.name), changedBytes, '等待期间新仓库内容不能被覆盖');
        }
    }
    {
        const { market, mod, releaseInfo, state, mainName, audioName, syncState } = optionalAudioFixture();
        state.localBoots.clear();
        syncState();
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, batchMode: true, askRestart: false }), true);
        assert.deepEqual(state.importedFiles, [[mainName, audioName]], '首次安装须在整组核验后一次性导入所选主包与扩展');
        assert.equal(state.imports, 1);
        assert.equal(state.reads, 2);
    }
    {
        const { market, mod, releaseInfo, state, mainBoot, audioBoot, audioName } = optionalAudioFixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.deepEqual(Array.from(prepared.boots, boot => boot.name), [mainBoot.name, audioBoot.name],
            '预检须核验全部所选组件，不能因主包同版跳过扩展清单');
        assert.equal(state.reads, 2);
        assert.equal(state.imports, 0);
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared,
            batchMode: true, askRestart: false }), true, '主包同版时仍须安装新增音频组件');
        assert.deepEqual(state.importedFiles, [[audioName]], '最终导入仅包含缺少的音频，不重复写入同版主包');
        assert.equal(state.localBoots.get(mainBoot.name), mainBoot, '复用主包须保留真实原生清单');
        assert.equal(state.localBoots.get(audioBoot.name), audioBoot);
        assert.equal(state.downloads, 2, '最终执行须复用预检包体');
        assert.equal(state.reads, 4, '最终写入前仍须重新核验两个组件');
    }
    {
        const { market, mod, releaseInfo, state, audioBoot, syncState } = optionalAudioFixture();
        state.localBoots.set(audioBoot.name, audioBoot);
        syncState();
        let failure;
        const options = { releaseInfo, batchMode: true, askRestart: false,
            onFailure: (reason, code) => { failure = { reason, code }; } };
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { ...options, prepareOnly: true });
        assert.ok(prepared, '全部同版时预检仍应返回所选组件清单');
        assert.equal(prepared.boots.length, 2);
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { ...options, preparedPackage: prepared }), false);
        assert.equal(failure.code, 'ALREADY_INSTALLED', '只有全部组件均同版且启用时才报告无需重复安装');
        assert.equal(state.imports, 0);
        assert.equal(state.reads, 4);
    }
    {
        const { market, mod, releaseInfo, state, audioBoot, syncState } = optionalAudioFixture();
        state.localBoots.set(audioBoot.name, audioBoot);
        state.disabledNames.add(audioBoot.name);
        syncState();
        let failure;
        const options = { releaseInfo, batchMode: true, askRestart: false,
            onFailure: (reason, code) => { failure = { reason, code }; } };
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { ...options, prepareOnly: true });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { ...options, preparedPackage: prepared }), true,
            '同版扩展已禁用时须允许后续确认计划处理启用，不能报告全部已经启用');
        assert.equal(failure, undefined);
        assert.equal(state.imports, 0, '启用同版组件不应再次写入安装包');
    }
    for (const invalidBoot of [false, { name: 'UnrelatedAudio', version: '1.3.1' }]) {
        const { market, mod, releaseInfo, state, syncState } = optionalAudioFixture();
        state.localBoots.clear();
        syncState();
        state.packBoots.set(2, invalidBoot);
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, batchMode: true, askRestart: false,
            onFailure: (reason, code) => { failure = { reason, code }; } }), false);
        assert.equal(failure.code, 'INSTALL_PACKAGE_INVALID');
        assert.equal(state.imports, 0, '扩展清单无效或身份不符必须阻止整组导入，不能先写入主包');
        assert.equal(state.localBoots.size, 0);
        assert.equal(state.reads, 2, '主包核验成功后还须核验扩展');
    }
    for (const changedField of ['version', 'dependenceInfo']) {
        const { market, mod, releaseInfo, state, audioBoot } = optionalAudioFixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        state.packBoots.set(2, { ...audioBoot, ...(changedField === 'version' ? { version: '1.3.2' }
            : { dependenceInfo: [{ modName: 'NewFramework', version: '>=2.0' }] }) });
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared,
            batchMode: true, askRestart: false, onFailure: (reason, code) => { failure = { reason, code }; } }), false,
            `扩展清单 ${changedField} 改变后必须停止旧计划`);
        assert.equal(failure.code, 'INSTALL_PACKAGE_INVALID');
        assert.equal(state.imports, 0, '预检后扩展版本或前置改变必须停止旧计划');
        assert.equal(state.downloads, 2);
    }
    for (const changedState of ['mainVersion', 'mainDependencies', 'mainEnabled', 'audioInstalled']) {
        const { market, mod, releaseInfo, state, mainBoot, audioBoot, syncState } = optionalAudioFixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        if (changedState === 'mainVersion') state.localBoots.set(mainBoot.name, { ...mainBoot, version: '1.3.2' });
        if (changedState === 'mainDependencies') state.localBoots.set(mainBoot.name, { ...mainBoot,
            dependenceInfo: [{ modName: 'ExistingFramework', version: '>=2.0' }] });
        if (changedState === 'mainEnabled') state.disabledNames.add(mainBoot.name);
        if (changedState === 'audioInstalled') state.localBoots.set(audioBoot.name, audioBoot);
        syncState();
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared,
            batchMode: true, askRestart: false, onFailure: (reason, code) => { failure = { reason, code }; } }), false,
            `本地组件状态 ${changedState} 改变后必须停止旧计划`);
        assert.equal(failure.code, 'INSTALL_PACKAGE_INVALID');
        assert.equal(state.imports, 0, '准备后本地组件版本、依赖、启用或安装状态改变必须重新确认计划');
        assert.equal(state.downloads, 2);
    }
    {
        const { sb, market, mod, releaseInfo, state, mainBoot, audioBoot, audioName, syncState } = optionalAudioFixture();
        const actualMain = { ...mainBoot, dependenceInfo: [{ modName: 'GameVersion', version: '=0.5.7.9' }] };
        state.localBoots.set(actualMain.name, actualMain);
        syncState();
        sb.modHubMarketVersions = { getGameVersion: () => '0.5.12.13', assessCompatibility: () => ({
            status: 'incompatible', reason: '复用主包声明适配其他游戏版本'
        }) };
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(prepared.boots[0], mainBoot, '预检原始下载清单须保留，不能改写为本地复用清单');
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared,
            batchMode: true, askRestart: false }), false, '复用主包的真实游戏版本要求也须参与最终风险确认');
        assert.equal(state.confirms, 1);
        assert.equal(state.imports, 0);
        const approvedCompatibilityRisks = market.getPreparedCompatibilityRisks([actualMain, audioBoot]).map(risk => risk.key);
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared,
            batchMode: true, askRestart: false, approvedCompatibilityRisks }), true);
        assert.deepEqual(state.importedFiles, [[audioName]]);
        assert.equal(state.localBoots.get(mainBoot.name), actualMain, '确认风险后仍保留真实本地主包与原有依赖');
    }
    {
        const { sb, market, mod, releaseInfo, state } = fixture();
        const restore = sb.modHubRestore, finish = restore.finish;
        let releaseFinish, signalFinish, context, operationCount = 0;
        const gate = new Promise(resolve => { releaseFinish = resolve; });
        const started = new Promise(resolve => { signalFinish = resolve; });
        restore.withOperation = async (meta, action) => {
            operationCount++; context = restore.createOperation(meta); restore.claim(context);
            try { return await action(context); }
            finally { signalFinish(); await gate; await finish(context); }
        };
        let offers = 0;
        sb.modHubOfferReload = async () => {
            offers++;
            assert.equal(context.finished, true, '直接下载必须完成整理后提示');
            assert.equal(market.isInstallBusy(), false, '直接下载必须释放市场忙碌标志后提示');
            assert.equal(restore.isOperationBlocked(), false, '直接下载必须释放还原操作所有权后提示');
            return false;
        };
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(operationCount, 0, '只读准备不能建立安装上下文或还原点');
        const installing = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true });
        await started;
        assert.equal(offers, 0, '直接下载整理未完成不得询问重载');
        assert.equal(state.restoreContext, context, '直接下载将同一上下文显式传入管理器');
        releaseFinish();
        assert.equal(await installing, true);
        assert.equal(operationCount, 1);
        assert.equal(offers, 1, '直接下载完成后仅提示一次');
        assert.equal(await sb.modHubCompleteOperationReload(context), false);
    }
    {
        const { sb, market, mod, releaseInfo, state } = fixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(state.imports, 0, '准备阶段不能写入');
        assert.equal(state.confirms, 0, '准备阶段只返回清单，不弹执行确认');
        assert.equal(prepared.boots[0].version, '1.0');
        assert.equal(prepared.bytes, prepared.files[0].size);
        assert.equal(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'), null, '准备不写入版本确权');
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', {
            releaseInfo, preparedPackage: prepared, batchMode: true, askRestart: false
        }), true);
        assert.equal(state.downloads, 1, '确认后复用同一包体，不能重新下载');
        assert.equal(state.reads, 2, '真正导入前重读清单');
        assert.equal(state.imports, 1);
        assert.equal(JSON.parse(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'))[mod.name], '1.0', '手选旧版不得记成目录最高版本');
    }
    {
        const { market, mod, releaseInfo, state } = fixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        const changed = { ...releaseInfo, tagName: 'v2.0' };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo: changed, preparedPackage: prepared, batchMode: true }), false);
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: { ...prepared }, batchMode: true }), false);
        assert.equal(state.imports, 0, '换版或伪造准备对象不得写入');
        assert.equal(state.downloads, 1);
    }
    {
        const { market, mod, releaseInfo, state } = fixture();
        state.boot.alias = ['PreparedAlias'];
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        state.boot = { ...state.boot, alias: ['ChangedAlias'] };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true }), false);
        assert.equal(state.imports, 0, '包内前置别名变化必须重新生成计划，不能继续导入');
        assert.equal(state.downloads, 1);
    }
    {
        const { market, mod, releaseInfo, state } = fixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        state.boot = { ...state.boot, dependenceInfo: [{ modName: 'NewFramework', version: '>=2.0' }] };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true }), false);
        assert.equal(state.imports, 0, '导入前真实前置改变必须停止旧计划');
    }
    {
        const { sb, market, mod, releaseInfo, state } = fixture();
        state.boot = { ...state.boot, version: '0.9' };
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true }), true);
        assert.equal(JSON.parse(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'))[mod.name], '0.9', '安装版本以真实清单为准');
    }
    {
        const { market, mod, releaseInfo, state } = fixture();
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', {
            releaseInfo, prepareOnly: true, batchMode: true, maxPreparedBytes: 1
        }), false);
        assert.equal(state.imports, 0, '超过累计剩余预算不能导入');
        assert.equal(state.reads, 0);
    }
    {
        const { sb, market, mod, releaseInfo, state, view, addCard } = fixture();
        sb.modHubMarketVersions = { getGameVersion: () => '0.5.3.9', assessCompatibility: () => ({
            status: 'incompatible', reason: '声明适配不同游戏版本'
        }) };
        const target = addCard('风险确认进度目标');
        state.boot.dependenceInfo = [{ modName: 'GameVersion', version: '=0.5.7.9' }];
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true,
            progressTargetName: '风险确认进度目标' });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true,
            progressTargetName: '风险确认进度目标' }), false);
        assert.equal(state.imports, 0, '取消真实包的兼容风险确认不能导入');
        assert.equal(state.confirms, 1);
        assert.equal(view.progress.hidden, true);
        assert.equal(target.progress.hidden, true, '取消兼容风险确认也要清理独立进度目标');
        const approvedCompatibilityRisks = market.getPreparedCompatibilityRisks(prepared.boots).map(risk => risk.key);
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', {
            releaseInfo, preparedPackage: prepared, batchMode: true, approvedCompatibilityRisks
        }), true);
        state.boot = { ...state.boot, dependenceInfo: [{ modName: 'GameVersion', version: '=0.5.8.9' }] };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', {
            releaseInfo, preparedPackage: prepared, batchMode: true, approvedCompatibilityRisks
        }), false);
        assert.equal(state.imports, 1, '新的真实声明必须重新确认');
    }
    {
        const { sb, market, mod, releaseInfo, state } = fixture();
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async () => {
            market.cancelDownload(mod.name);
            return state.boot;
        } });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true }), false);
        assert.equal(state.imports, 0, '核验期间取消不会生成可执行结果');
    }
    for (const separateTarget of [false, true]) {
        const { sb, market, mod, releaseInfo, state, view, addCard } = fixture();
        view.button.dataset.idleText = '更换版本';
        const targetName = separateTarget ? '前置进度目标' : mod.name;
        const target = separateTarget ? addCard(targetName, '一键更新') : view;
        const options = { releaseInfo, prepareOnly: true, batchMode: true,
            progressTargetName: targetName, progressPrefix: separateTarget ? '前置：' : '' };
        assert.ok(await market.downloadAndInstallMod(mod, 'ddlc', options));
        assert.equal(view.progress.hidden, false);
        assert.equal(view.button.disabled, true);
        assert.equal(target.ring.hidden, true, '等待安装确认时不继续播放进度动画');
        assert.equal(target.ring.getAttribute('aria-valuenow'), undefined);
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name, targetName), true, '释放待确认包体必须清理主卡片和进度目标');
        for (const card of new Set([view, target])) {
            assert.equal(card.progress.hidden, true);
            assert.equal(card.button.disabled, false);
            assert.equal(card.button.textContent, card.button.dataset.idleText);
            assert.equal(card.ring.hidden, true);
            assert.equal(card.ring.getAttribute('aria-valuenow'), undefined);
            assert.equal(card.label.textContent, '等待下载');
            assert.equal(card.cancel.hidden, true);
        }
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name, targetName), false, '重复释放不应重写卡片');
        const container = createStubElement();
        sb.document.getElementById = id => id === 'modHubMarketCardsContainer' ? container : null;
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: [mod] }));
        await market.loadMarketData();
        market.renderMarketCards();
        assert.equal(view.progress.hidden, true, '重绘市场不能重新播放已释放的百分百缓存');
        assert.equal(view.button.disabled, false);
        assert.ok(await market.downloadAndInstallMod(mod, 'ddlc', options), '取消后可以重新预检同一模组');
        assert.equal(state.downloads, 2);
        assert.equal(state.imports, 0, '清理与再次准备均不能写入包体');
        assert.equal(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'), null);
        sb.modHubClearMarketPreparationProgress(mod.name, targetName);
    }
    {
        const { sb, market, mod, releaseInfo, view } = fixture();
        await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        market.batchInstallState.running = true;
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name), true);
        assert.equal(view.progress.hidden, true);
        assert.equal(view.button.disabled, true, '释放准备包不能解除批量任务锁');
        market.batchInstallState.running = false;
    }
    {
        const { sb, market, mod, releaseInfo, state, view } = fixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true }), true);
        view.button.textContent = '已安装';
        const confirmed = sb.localStorage.getItem('modhub_market_confirmed_updates_v1');
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name), false, '成功项目没有待确认状态，统一释放必须跳过');
        assert.equal(view.button.textContent, '已安装');
        assert.equal(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'), confirmed);
        assert.equal(state.imports, 1);
    }
    {
        const { sb, market, mod, releaseInfo, state, view } = fixture();
        const prepared = await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        state.boot = { ...state.boot, dependenceInfo: [{ modName: 'ChangedFramework', version: '>=2.0' }] };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, preparedPackage: prepared, batchMode: true }), false);
        const failure = view.label.textContent;
        assert.equal(view.button.textContent, '重试');
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name), false, '清理待确认包不能覆盖真实执行失败提示');
        assert.equal(view.label.textContent, failure);
        assert.equal(view.button.disabled, false);
        assert.equal(state.imports, 0);
    }
    {
        const { sb, market, mod, releaseInfo, state, view } = fixture();
        await market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        let releaseDownload;
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: () => new Promise(resolve => { releaseDownload = resolve; }) });
        const next = market.downloadAndInstallMod(mod, 'ddlc', { releaseInfo, prepareOnly: true, batchMode: true });
        for (let step = 0; step < 10 && !releaseDownload; step++) await Promise.resolve();
        assert.equal(typeof releaseDownload, 'function', '新下载必须实际进入响应体读取');
        const progress = view.label.textContent;
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name), false, '新下载已经启动时旧准备清理不能重置它');
        assert.equal(view.label.textContent, progress);
        assert.equal(view.button.disabled, true);
        releaseDownload(new Blob(['重新准备']));
        assert.ok(await next);
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name), true);
        assert.equal(state.imports, 0);
    }
    {
        const { sb, market, mod, releaseInfo, state, view, addCard } = fixture();
        const target = addCard('失败进度目标');
        let failure;
        assert.equal(await market.downloadAndInstallMod(mod, 'github', {
            releaseInfo, prepareOnly: true, batchMode: true, progressTargetName: '失败进度目标',
            onFailure: (reason, code) => { failure = { reason, code }; }
        }), false);
        assert.equal(failure.reason, '当前线路只能手动下载');
        for (const card of [view, target]) {
            assert.equal(card.button.textContent, '重试');
            assert.equal(card.button.disabled, false, '预检早期失败不能把活动进度留成禁止重试');
            assert.ok(card.label.textContent.includes(failure.reason));
        }
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name, '失败进度目标'), false);
        assert.equal(state.downloads, 0);
        assert.equal(state.imports, 0);
    }
};
