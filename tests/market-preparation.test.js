// 市场包体准备、复用和写入边界。
const { assert, loadMarket, createStubElement } = require('./helpers');

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
            const card = createStubElement();
            card.dataset.modName = name;
            const progress = card.querySelector('.modhub-download-progress');
            progress.hidden = true;
            const track = progress.querySelector('.modhub-download-track');
            const attributes = new Map();
            track.setAttribute = (key, value) => attributes.set(key, value);
            track.removeAttribute = key => attributes.delete(key);
            track.getAttribute = key => attributes.get(key);
            const button = card.querySelector('.btn-market-install, .btn-market-update');
            button.dataset.idleText = idleText;
            const view = { card, progress, track, button, bar: progress.querySelector('.modhub-download-bar'),
                label: progress.querySelector('.modhub-download-label'), cancel: progress.querySelector('.modhub-download-cancel') };
            cards.set(name, view);
            return view;
        };
        const view = addCard(mod.name);
        sb.document.querySelectorAll = selector => selector === '.modhub-market-card'
            ? [...cards.values()].map(item => item.card) : [];
        sb.fetch = async () => {
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
        return { sb, mod, releaseInfo, state, view, addCard, market: sb.modHubMarket };
    };
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
        assert.equal(target.track.getAttribute('aria-valuenow'), '100');
        assert.equal(sb.modHubClearMarketPreparationProgress(mod.name, targetName), true, '释放待确认包体必须清理主卡片和进度目标');
        for (const card of new Set([view, target])) {
            assert.equal(card.progress.hidden, true);
            assert.equal(card.button.disabled, false);
            assert.equal(card.button.textContent, card.button.dataset.idleText);
            assert.equal(card.bar.style.width, '');
            assert.equal(card.track.getAttribute('aria-valuenow'), undefined);
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
