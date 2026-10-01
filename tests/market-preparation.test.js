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
