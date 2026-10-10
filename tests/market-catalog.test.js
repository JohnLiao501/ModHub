// ModHub 市场索引、身份、版本与来源解析。
const {
    assert, fs, path, srcRoot, bootJson,
    readStyles, loadScripts, loadManager, loadMarket, createStubElement,
} = require('./helpers');

module.exports = async function() {
    // 普通加载共用在途请求，多个强制刷新顺序获取一份新目录。
    {
        const sb = loadMarket(), market = sb.modHubMarket;
        let finish, requests = 0;
        const index = version => ({ schemaVersion: 1, mods: [{ id: 'shared-request', name: '共享目录请求', version }] });
        sb.fetch = () => { requests++; return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => index('1.0') }); }); };
        const first = market.loadMarketData(), second = market.loadMarketData();
        assert.equal(first, second, '离开后重新进入市场应共用仍在拉取的目录');
        assert.equal(requests, 1);
        finish(); await Promise.all([first, second]);

        const cachedSb = loadMarket(), cachedMarket = cachedSb.modHubMarket;
        let finishFirst, indexRequests = 0;
        cachedSb.fetch = () => {
            indexRequests++;
            if (indexRequests === 1) return new Promise(resolve => { finishFirst = () => resolve({ ok: true, json: async () => index('1.0') }); });
            return Promise.resolve({ ok: true, json: async () => index('2.0') });
        };
        const cached = cachedMarket.loadMarketData(), refresh = cachedMarket.loadMarketData(true), repeatedRefresh = cachedMarket.loadMarketData(true);
        assert.equal(indexRequests, 1, '强制刷新不应与尚未完成的普通读取并发覆盖目录');
        finishFirst();
        assert.equal((await cached)[0].version, '1.0');
        const results = await Promise.all([refresh, repeatedRefresh]);
        assert.equal(indexRequests, 2, '多个强制刷新应共用下一次真实网络请求');
        assert.ok(results.every(mods => mods[0].version === '2.0'), '强制刷新不能把旧缓存当作刷新成功');
    }
    // 同一轮游戏首次联网核对目录；之后复用成功结果，空目录也不重复拉取。
    for (const preheated of [false, true]) {
        const sb = loadMarket(), market = sb.modHubMarket;
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: Date.now(), data: [
            { id: 'old-session', name: '旧缓存目录', version: '1.0' }
        ] }));
        if (preheated) market.getUpdatableMods();
        let requests = 0;
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ schemaVersion: 1, mods: [
            { id: 'new-session', name: '本轮最新目录', version: '2.0' }
        ] }) }; };
        assert.equal((await market.loadMarketData())[0].version, '2.0', '首次进入不能直接沿用上轮游戏持久缓存或看板预热');
        await market.loadMarketData();
        assert.equal(requests, 1, '本轮首次成功后切页仅复用内存目录');
        await market.loadMarketData(true);
        assert.equal(requests, 2, '手动强制刷新仍获取网络新目录');
    }
    {
        const sb = loadMarket();
        let requests = 0;
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ schemaVersion: 1, mods: [] }) }; };
        await sb.modHubMarket.loadMarketData(); await sb.modHubMarket.loadMarketData();
        assert.equal(requests, 1, '成功的空目录也是本轮缓存');
        const nextSession = loadMarket();
        nextSession.fetch = sb.fetch;
        await nextSession.modHubMarket.loadMarketData();
        assert.equal(requests, 2, '重新加载游戏后重新核对一次目录');
    }
    // 客户端只保存成功目录；离线读取保留原内容与时间，空目录不会被旧缓存复活。
    for (const empty of [false, true]) {
        const sb = loadMarket(), key = 'modhub_market_wiki_v5';
        const saved = JSON.stringify({ timestamp: 1, data: empty ? [] : [
            { id: 'saved', name: '最近成功目录', bootNames: ['Saved'], description: '最近成功说明', version: '1.0' }
        ] });
        sb.localStorage.setItem(key, saved);
        const write = sb.localStorage.setItem;
        let writes = 0, requests = 0;
        sb.localStorage.setItem = (storageKey, value) => { if (storageKey === key) writes++; write(storageKey, value); };
        sb.fetch = async url => {
            requests++;
            if (String(url).includes('mod-identities.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [] }) };
            throw new Error('模拟离线');
        };
        const offline = await sb.modHubMarket.loadMarketData();
        assert.equal(offline.length, empty ? 0 : 1);
        assert.equal(sb.localStorage.getItem(key), saved, '离线回退不能刷新持久目录时间或内容');
        assert.equal(writes, 0, '离线读取不能写成新目录');
        const offlineRequests = requests;
        await sb.modHubMarket.loadMarketData();
        assert.equal(requests, offlineRequests, '有效离线目录在同一轮游戏内也只读取一次');
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [
            { id: 'latest', name: '最新成功目录', version: '2.0' }
        ] }) });
        await sb.modHubMarket.loadMarketData(true);
        const updated = JSON.parse(sb.localStorage.getItem(key));
        assert.equal(writes, 1);
        assert.ok(updated.timestamp > 1);
        assert.equal(updated.data[0].name, '最新成功目录');
        assert.equal(updated.data[0].version, '2.0');
    }
    {
        const sb = loadMarket(), market = sb.modHubMarket, key = 'modhub_market_wiki_v5';
        sb.localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data: [
            { id: 'old', name: '旧版', bootNames: ['Old'], description: '旧说明', version: '2.0' }
        ] }));
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [{ name: 'Old', bootJson: { name: 'Old', version: '1.0' } }] } });
        assert.ok(market.findMarketModByLocalName('Old'));
        assert.equal(market.getStaticMarketModSubtext('Old'), '旧版');
        const write = sb.localStorage.setItem;
        sb.localStorage.setItem = (storageKey, value) => {
            if (storageKey === key) throw new Error('模拟存储写入失败');
            write(storageKey, value);
        };
        let requests = 0;
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ schemaVersion: 1, mods: [] }) }; };
        await market.loadMarketData(); await market.loadMarketData();
        assert.equal(requests, 1);
        assert.equal(market.findMarketModByLocalName('Old'), null, '已成功获取空目录后身份查询不能复活旧持久目录');
        assert.equal(market.getStaticMarketModSubtext('Old'), '');
        assert.equal(market.getUpdatableMods().length, 0, '空目录不能由管理页更新查询重新预热旧缓存');
    }
    // 本地资料仅复用已完成的真实扫描；名单、对象、包体修订或显式失效均重新核验。
    {
        const fixture = () => {
            const sb = loadMarket(), elements = new Map(), counts = { reads: 0, checks: 0, disabled: 0, requests: 0 };
            const loader = { customStore: {}, constructor: { calcModNameKey: name => name } };
            let failRead = false;
            const reopen = () => ['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketBtnRefresh']
                .forEach(id => elements.set(id, createStubElement()));
            reopen();
            sb.document.getElementById = id => elements.get(id) || null;
            sb._modHubOrphanRepairDone = true;
            sb._modHubModState = { sideEnabled: ['First', 'Second'], sideDisabled: [], sideMods: [] };
            sb.modHubLoadModManageState = async () => sb._modHubModState;
            sb.modHubLoadDisabledModInfo = async () => { counts.disabled++; };
            sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader, getModCacheArray: () => [] }),
                getIdbKeyValRef: () => ({ get: async name => { counts.reads++; if (failRead) throw new Error('测试读取失败'); return { name }; } }) } });
            sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => { counts.checks++; return { name: data.name, version: '1.0' }; } });
            sb.setTimeout = (callback, delay) => delay === 0 ? setTimeout(callback, 0) : 0;
            sb.fetch = async () => { counts.requests++; return { ok: true, json: async () => ({ schemaVersion: 1, mods: [] }) }; };
            return { sb, elements, counts, reopen, fail: value => { failRead = value; } };
        };
        const f = fixture();
        await f.sb.modHubInitMarket();
        assert.deepEqual(f.counts, { reads: 2, checks: 2, disabled: 1, requests: 1 });
        f.reopen(); await f.sb.modHubInitMarket();
        assert.deepEqual(f.counts, { reads: 2, checks: 2, disabled: 1, requests: 1 }, '重复切页不再解包、计算摘要或获取目录');
        f.sb._modHubModState.sideDisabled.push(f.sb._modHubModState.sideEnabled.pop());
        await f.sb.modHubInitMarket();
        assert.equal(f.counts.reads, 4, '原地启禁后重新核对两份包体');
        f.sb._modHubModState.sideEnabled.pop();
        await f.sb.modHubInitMarket();
        assert.equal(f.counts.reads, 5, '原地删除后仅核验仍登记的包体');
        f.sb._modHubModState = { ...f.sb._modHubModState };
        await f.sb.modHubInitMarket();
        assert.equal(f.counts.reads, 6, '同名换包后的状态重新读取不能沿用旧摘要');
        f.sb._modHubReloadRevision++;
        await f.sb.modHubInitMarket();
        assert.equal(f.counts.reads, 7, '仅包体修订变化也需重新核验');
        f.sb.modHubMarket.invalidateLocalPackageProfiles();
        await f.sb.modHubInitMarket();
        assert.equal(f.counts.reads, 8, '显式失效覆盖导入已落盘但名单读取失败');
        await f.sb.modHubInitMarket(true);
        assert.equal(f.counts.reads, 9, '强制进入重新核验本地资料');
        assert.equal(f.counts.requests, 2);
        await f.elements.get('modHubMarketBtnRefresh').onclick();
        assert.equal(f.counts.reads, 10, '手动刷新重新核验本地资料');
        assert.equal(f.counts.requests, 3, '手动刷新同时获取最新目录');

        const failed = fixture();
        failed.fail(true); await failed.sb.modHubInitMarket();
        assert.equal(failed.counts.reads, 2);
        failed.fail(false); failed.reopen(); await failed.sb.modHubInitMarket();
        assert.equal(failed.counts.reads, 4, '读取失败不得登记扫描完成，重进应重新核验');
        failed.reopen(); await failed.sb.modHubInitMarket();
        assert.equal(failed.counts.reads, 4, '成功重试后可以复用本轮资料');
        failed.fail(true); await failed.sb.modHubInitMarket(true);
        assert.equal(failed.counts.reads, 6);
        failed.fail(false); failed.reopen(); await failed.sb.modHubInitMarket();
        assert.equal(failed.counts.reads, 8, '已成功后强制扫描失败，也必须使旧完成标记失效');

        const unavailable = fixture(), getGui = unavailable.sb.modHubGetGui;
        unavailable.sb.modHubGetGui = () => ({});
        await unavailable.sb.modHubInitMarket();
        assert.equal(unavailable.counts.reads, 0);
        unavailable.sb.modHubGetGui = getGui;
        unavailable.reopen(); await unavailable.sb.modHubInitMarket();
        assert.equal(unavailable.counts.reads, 2, '加载器接口未就绪不能登记扫描完成');

        const changing = fixture(), getController = changing.sb.modHubGetController;
        let invalidated = false;
        changing.sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => {
            const oldBoot = await getController().checkModZipFileIndexDB(data);
            if (!invalidated) {
                invalidated = true;
                changing.sb._modHubDisabledModInfo.set('first', { name: 'First', bootJson: { name: 'First', version: '2.0' } });
                changing.sb.modHubMarket.invalidateLocalPackageProfiles();
                return oldBoot;
            }
            return { ...oldBoot, version: '2.0' };
        } });
        await changing.sb.modHubInitMarket();
        assert.equal(changing.counts.reads, 1, '扫描期间换包失效后立即停止余包读取');
        assert.equal(changing.sb.modHubMarket.getLocalInstalledProfiles().find(profile => profile.name === 'First').version, '2.0',
            '旧包校验完成后不得覆盖安装刚写入的新版本资料');
        changing.reopen(); await changing.sb.modHubInitMarket();
        assert.equal(changing.counts.reads, 3, '扫描期间包体落盘失效不能被扫描结束的完成标记覆盖');
        changing.reopen(); await changing.sb.modHubInitMarket();
        assert.equal(changing.counts.reads, 3);

        const canceled = fixture(), tasks = [];
        canceled.sb.setTimeout = (callback, delay) => { if (delay === 0) tasks.push(callback); return 0; };
        const pending = canceled.sb.modHubInitMarket();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(tasks.length, 1);
        canceled.reopen();
        tasks.shift()(); await pending;
        assert.equal(canceled.counts.reads, 0);
        canceled.sb.setTimeout = (callback, delay) => delay === 0 ? setTimeout(callback, 0) : 0;
        await canceled.sb.modHubInitMarket();
        assert.equal(canceled.counts.reads, 2, '中途取消不得登记扫描完成，重进应扫描全部包体');

        let finishDisabled;
        f.sb.modHubLoadDisabledModInfo = () => new Promise(resolve => { finishDisabled = resolve; });
        const refreshing = f.elements.get('modHubMarketBtnRefresh').onclick();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        f.reopen(); finishDisabled(); await refreshing;
        assert.equal(f.counts.requests, 3, '手动刷新预载过程中离页不得继续新目录请求');
    }
    // 拉取期间切到其他页签，再次进入只渲染新容器并复用目录请求。
    {
        const sb = loadMarket();
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketSearch'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        sb.modHubRepairOrphanModZips = async () => ({ repaired: [] });
        sb.modHubLoadModManageState = async () => {};
        sb.modHubLoadDisabledModInfo = async () => {};
        let finish, requests = 0, started;
        const fetching = new Promise(resolve => { started = resolve; });
        sb.fetch = () => { requests++; started(); return new Promise(resolve => {
            finish = () => resolve({ ok: true, json: async () => ({ schemaVersion: 1, mods: [{ id: 'reentry', name: '重新进入市场' }] }) });
        }); };
        const first = sb.modHubInitMarket();
        await fetching;
        let oldSearchTask;
        sb.setTimeout = (callback, delay) => { if (delay === 200) oldSearchTask = callback; return 0; };
        const oldSearch = elements.get('modHubMarketSearch');
        oldSearch.value = '已离页的旧输入';
        oldSearch.oninput();
        const oldCards = elements.get('modHubMarketCardsContainer');
        oldCards.innerHTML = '旧页面已离开';
        for (const id of elements.keys()) elements.set(id, createStubElement());
        const second = sb.modHubInitMarket();
        finish(); await Promise.all([first, second]);
        oldSearchTask();
        assert.equal(requests, 1);
        assert.equal(oldCards.innerHTML, '旧页面已离开', '离页的请求不能重新绘制旧容器');
        assert.match(elements.get('modHubMarketCardsContainer').innerHTML, /重新进入市场/);
        assert.equal(sb.modHubMarket.isInstallBusy(), false, '目录读取不能建立安装锁');
    }
    // 每段本地预载完成后检查页签；逐包校验前让出事件循环，离页不再读余包。
    for (const leavingAt of ['repair', 'manager', 'disabled']) {
        const sb = loadMarket(), root = createStubElement(), stages = [];
        let active = true, requests = 0;
        sb.document.getElementById = id => active && id === 'modHubModMarketContainer' ? root : null;
        const stage = name => { stages.push(name); if (name === leavingAt) active = false; };
        sb.modHubRepairOrphanModZips = async () => { stage('repair'); return { repaired: [] }; };
        sb.modHubLoadModManageState = async () => { stage('manager'); };
        sb.modHubLoadDisabledModInfo = async () => { stage('disabled'); };
        sb.fetch = async () => { requests++; throw new Error('离页后不应拉取目录'); };
        await sb.modHubInitMarket();
        assert.equal(stages.at(-1), leavingAt, '离页后不应继续后续预载阶段');
        assert.equal(requests, 0);
    }
    // 自愈已写入仓库时，即使离页也先同步状态缓存；重新进入不得复用旧名单。
    {
        const sb = loadMarket();
        let active = true, repaired = 0, forced = 0, requests = 0;
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => active ? elements.get(id) || null : null;
        sb._modHubModState = { sideEnabled: [], sideDisabled: [], sideMods: [], builtInMods: [] };
        const bootJson = { name: 'Recovered', version: '1.0' };
        sb.modHubGetGui = () => ({ listSideLoadModNameOnly: async () => ['Recovered'], listSideLoadHiddenModNameOnly: async () => [],
            gModUtils: { getModListNameNoAlias: () => [], getModLoader: () => ({ getModCacheArray: () => [] }) } });
        sb.modHubLoadDisabledModInfo = async names => {
            if (names?.includes('Recovered')) sb._modHubDisabledModInfo.set('recovered', { name: 'Recovered', bootJson });
        };
        const loadState = sb.modHubLoadModManageState;
        sb.modHubLoadModManageState = refresh => { if (refresh) forced++; return loadState(refresh); };
        sb.modHubRepairOrphanModZips = async () => { repaired++; active = false; return { repaired: ['Recovered'] }; };
        sb.fetch = async () => { requests++; return { ok: true, json: async () => ({ schemaVersion: 1, mods: [
            { id: 'recovered', name: '已恢复模组', bootNames: ['Recovered'], githubUrl: 'https://github.com/ModHubTests/Recovered', version: '1.0', versionSource: 'wiki' }
        ] }) }; };
        await sb.modHubInitMarket();
        assert.equal(forced, 1, '已完成自愈必须强制回读缓存后才可因离页退出');
        assert.deepEqual(Array.from(sb._modHubModState.sideEnabled), ['Recovered']);
        assert.equal(requests, 0, '状态同步完成后，离页仍不应拉取目录');
        active = true;
        for (const id of elements.keys()) elements.set(id, createStubElement());
        await sb.modHubInitMarket();
        assert.equal(forced, 1);
        assert.equal(repaired, 1, '再次进入不得重复执行已完成的孤儿包自愈');
        assert.equal(requests, 1);
        assert.match(elements.get('modHubMarketCardsContainer').innerHTML, /已安装版本：v1\.0/);
        assert.notEqual(sb.modHubMarket.checkModInstallStatus(sb.modHubMarket.getMarketMods()[0]), 'not_installed');
    }
    {
        const sb = loadMarket(), tasks = [], reads = [];
        let active = true, checked = 0;
        class Loader { static calcModNameKey(name) { return 'package:' + name; } }
        const loader = new Loader(); loader.customStore = {};
        sb._modHubModState = { sideEnabled: ['First', 'Second'], sideDisabled: [] };
        sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader }), getIdbKeyValRef: () => ({
            get: async key => { reads.push(key); active = false; return {}; }
        }) } });
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async () => { checked++; return { name: 'First' }; } });
        sb.setTimeout = callback => { tasks.push(callback); return tasks.length; };
        const pending = sb.modHubMarket.refreshLocalPackageProfiles(undefined, () => active);
        assert.deepEqual(reads, [], '包体读取前必须给页签事件一个调度机会');
        assert.equal(tasks.length, 1);
        tasks.shift()(); await pending;
        assert.deepEqual(reads, ['package:First']);
        assert.equal(checked, 0, '读取过程中离页，不再解包或扫描下一个包');
    }
    {
        const counts = [];
        for (const yielding of [false, true]) {
            const sb = loadMarket(), names = Array.from({ length: 8 }, (_, index) => 'Busy' + index);
            let active = true, checked = 0, left;
            const navigation = new Promise(resolve => { left = resolve; });
            sb.setTimeout = setTimeout;
            sb._modHubModState = { sideEnabled: names, sideDisabled: [] };
            const loader = { customStore: {}, constructor: { calcModNameKey: name => name } };
            sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader }),
                getIdbKeyValRef: () => ({ get: async name => ({ name }) }) } });
            sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => {
                checked++;
                const until = performance.now() + 20;
                while (performance.now() < until) {}
                if (checked === 1) setTimeout(() => { active = false; left(checked); }, 0);
                return { name: data.name, version: '1.0' };
            } });
            const pending = sb.modHubMarket.refreshLocalPackageProfiles(undefined, yielding ? () => active : undefined);
            counts.push(await navigation);
            await pending;
            if (yielding) assert.equal(checked, 1, '页签切走后立即停止余下七个同步解包任务');
        }
        assert.deepEqual(counts, [8, 1], '连续微任务会阻塞页签事件；逐包让出后事件在第一包完成时执行');
    }
    // 超时覆盖响应体读取，保留镜像、缓存及 Wiki 回退；失败后可重新尝试。
    for (const phase of ['mirror-cache', 'wiki-fetch', 'wiki-body']) {
        const sb = loadMarket(), timers = new Map();
        let timerId = 0, wikiStarted, mirrorRequests = 0;
        const wikiReady = new Promise(resolve => { wikiStarted = resolve; });
        sb.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
        sb.clearTimeout = id => timers.delete(id);
        const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
        if (phase === 'mirror-cache') sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ timestamp: 0,
            data: [{ id: 'stale', name: '离线目录', version: '1.0' }] }));
        sb.fetch = url => {
            if (String(url).includes('release-index.json')) {
                mirrorRequests++;
                return phase === 'mirror-cache' ? new Promise(() => {}) : Promise.reject(new Error('测试镜像不可用'));
            }
            if (String(url).includes('mod-identities.json')) return Promise.resolve({ ok: true, json: async () => ({ schemaVersion: 1, mods: [] }) });
            wikiStarted();
            return phase === 'wiki-fetch' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
        };
        const pending = sb.modHubMarket.loadMarketData(true);
        const failure = phase === 'mirror-cache' ? null : assert.rejects(pending, /Wiki API请求超时/);
        if (phase === 'mirror-cache') {
            await flush();
            for (let i = 0; i < 2; i++) {
                assert.equal(timers.size, 1);
                timers.values().next().value.callback(); await flush();
            }
            assert.equal((await pending)[0].name, '离线目录', '两份在线索引超时后仍保留最后成功目录');
        } else {
            await wikiReady; await flush();
            assert.equal(timers.size, 1, '身份字典结束后仅保留 Wiki 读取的超时');
            const timer = timers.values().next().value;
            assert.equal(timer.delay, 8000);
            timer.callback(); await failure;
            sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [{ id: 'retry', name: '重试成功' }] }) });
            assert.equal((await sb.modHubMarket.loadMarketData())[0].name, '重试成功', '失败请求不得登记会话成功，普通重进仍允许重试');
        }
        assert.equal(mirrorRequests, 2, '仍按主索引、备用索引顺序回退');
        assert.equal(timers.size, 0, '成功或失败后均清理请求超时');
    }
    // 刷新沿用原卡片，按钮圆环随请求结束清理；离页后的旧按钮不影响新页面。
    for (const leaving of [false, true]) {
        const sb = loadMarket();
        sb.modHubLoadModManageState = async () => {};
        sb.modHubLoadDisabledModInfo = async () => {};
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketBtnRefresh'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        const refresh = elements.get('modHubMarketBtnRefresh'), attributes = new Map();
        refresh.setAttribute = (name, value) => attributes.set(name, value);
        refresh.removeAttribute = name => attributes.delete(name);
        Object.defineProperty(refresh, 'textContent', { get: () => refresh.innerHTML.replace(/<[^>]*>/g, ''), set: value => { refresh.innerHTML = value; } });
        const index = { schemaVersion: 1, mods: [{ id: 'refresh-loading', name: '刷新等待测试', version: '1.0.0', versionSource: 'wiki' }] };
        sb.fetch = async () => ({ ok: true, json: async () => index });
        await sb.modHubInitMarket(true);
        const cards = elements.get('modHubMarketCardsContainer'), originalCards = cards.innerHTML;
        let finish, started;
        const fetching = new Promise(resolve => { started = resolve; });
        sb.fetch = () => { started(); return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => index }); }); };
        const pending = refresh.onclick();
        assert.match(refresh.innerHTML, /modhub-progress-ring/);
        assert.doesNotMatch(refresh.innerHTML, /is-determinate|aria-valuenow/);
        assert.equal(attributes.get('aria-busy'), 'true');
        assert.equal(cards.innerHTML, originalCards, '刷新等待期间保留已有卡片');
        await fetching;
        if (leaving) {
            elements.set('modHubModMarketContainer', createStubElement());
            elements.set('modHubMarketBtnRefresh', createStubElement());
            elements.get('modHubMarketBtnRefresh').innerHTML = '新页面按钮';
        } else sb.modHubMarket.batchInstallState.running = true;
        finish(); await pending;
        assert.equal(refresh.innerHTML, '刷新市场');
        assert.equal(attributes.has('aria-busy'), false);
        assert.equal(refresh.disabled, !leaving, '请求结束后仍服从当前批量任务锁');
        if (leaving) assert.equal(elements.get('modHubMarketBtnRefresh').innerHTML, '新页面按钮');
    }
    // 批量总进度使用真实完成项比例，准备计划时使用不定圆环，终止后清理。
    {
        const sb = loadMarket(), toolbar = createStubElement(), market = sb.modHubMarket;
        sb.document.getElementById = id => id === 'modHubMarketBatchToolbar' ? toolbar : null;
        Object.assign(market.batchInstallState, { running: true, progressPhase: 'installing', completed: 1, total: 4, current: '<当前模组>' });
        market.renderBatchInstallToolbar();
        assert.equal((toolbar.innerHTML.match(/class="modhub-progress-ring/g) || []).length, 1);
        assert.match(toolbar.innerHTML, /class="modhub-progress-ring is-determinate"[^>]*role="progressbar"[^>]*aria-label="批量安装总进度"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="25"/);
        assert.match(toolbar.innerHTML, /批量安装 1\/4/);
        assert.doesNotMatch(toolbar.innerHTML, /<progress|modhub-batch-progress/);
        assert.match(toolbar.innerHTML, /&lt;当前模组&gt;/);
        Object.assign(market.batchInstallState, { progressPhase: 'preparing' });
        market.renderBatchInstallToolbar();
        assert.match(toolbar.innerHTML, /class="modhub-progress-ring"[^>]*role="progressbar"/);
        assert.doesNotMatch(toolbar.innerHTML, /is-determinate|aria-valuenow/, '准备阶段即使已有项目总数，也不代表实际安装比例');
        Object.assign(market.batchInstallState, { progressPhase: 'installing', completed: 0, total: 0 });
        market.renderBatchInstallToolbar();
        assert.doesNotMatch(toolbar.innerHTML, /is-determinate|aria-valuenow/, '没有实际项目总数时保留不定状态');
        market.batchInstallState.running = false;
        market.renderBatchInstallToolbar();
        assert.doesNotMatch(toolbar.innerHTML, /modhub-progress-ring/);
    }

    // 帮助中心只按原生规则核对版本，不将无法判断误报为版本不符。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        const versions = sb.modHubMarketVersions;
        assert.equal(versions.assessVersionRange('', '*').status, 'compatible', '任意版本只要求调用者确认提供者存在');
        assert.equal(versions.assessVersionRange('', '').status, 'compatible', '空要求只核对提供者存在');
        assert.equal(versions.assessVersionRange('1.2.3', '^1.0').status, 'unknown', '没有原生比较接口不得判定版本不符');
        const parsedVersions = [], comparisons = [];
        const api = {
            parseVersion: value => {
                parsedVersions.push(value);
                const match = value.match(/^(\d+(?:\.\d+)*)(?:-([^+]+))?(?:\+(.+))?$/);
                return { version: { version: match[1].split('.').map(Number), preRelease: match[2], buildMetadata: match[3] } };
            },
            parseRange: value => value.split('||').map(range => ({ range })),
            satisfies: (version, ranges, ignorePostfix = false) => {
                comparisons.push(ignorePostfix);
                if (ranges[0].range.trim() === '>=1.2.3') return ignorePostfix || !version.preRelease;
                return ranges[0].range.trim() !== '>=2.0';
            }
        };
        sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => api }) };
        assert.equal(versions.assessVersionRange('v1.2.3-beta+build', '^1.0').status, 'compatible');
        assert.equal(parsedVersions.at(-1), '1.2.3-beta+build', '通用比较必须保留预发布与构建标记');
        assert.equal(versions.assessVersionRange('1.2.3-beta', '>=1.2.3').status, 'incompatible', '原生前置比较不能忽略预发布后缀');
        assert.equal(comparisons.at(-1), false, '普通依赖沿用原生后缀比较');
        assert.equal(versions.assessCompatibility('>=1.2.3', '1.2.3-beta').status, 'compatible', '游戏版本保持原有忽略后缀策略');
        assert.equal(comparisons.at(-1), true, '游戏适配包装须显式使用原生忽略后缀策略');
        assert.equal(versions.assessVersionRange('1.2.3', '>=2.0').status, 'incompatible');
        assert.equal(versions.assessVersionRange('1.2.3', '>=1.0&&<2.0||=3.0').status, 'compatible');
        for (const range of ['>=1.0 junk', '>=1.0 <2.0', '1.0 - 2.0', '~1.0', '^9007199254740992']) {
            assert.equal(versions.assessVersionRange('1.2.3', range).status, 'unknown', `不支持的完整范围须保留未知：${range}`);
        }
        for (const version of ['', '1.2junk', '9007199254740992.0']) {
            assert.equal(versions.assessVersionRange(version, '>=1.0').status, 'unknown', '未知或不完整版本不得参与比较');
        }
        assert.equal(versions.assessCompatibility('*', '0.5.12.13').status, 'unknown', '市场游戏适配不得把任意版本当作适配证据');
        assert.equal(versions.assessCompatibility('', '0.5.12.13').reason, '适用的游戏版本尚未确定，下一步会核对安装包中的说明');
        assert.equal(versions.assessCompatibility('>=1.0', '0.5.12.13').reason, '作者声明的支持范围包含当前 DoL 0.5.12.13；下一步会核对所选安装包');
        api.satisfies = () => undefined;
        assert.equal(versions.assessVersionRange('1.2.3', '>=1.0').status, 'unknown', '非布尔原生结果必须保留未知');
        api.parseRange = () => [];
        assert.equal(versions.assessVersionRange('1.2.3', '>=1.0').status, 'unknown', '不完整的原生解析必须保留未知');
        api.parseRange = () => { throw new Error('范围读取失败'); };
        assert.equal(versions.assessVersionRange('1.2.3', '>=1.0').status, 'unknown', '原生比较异常不得阻断帮助中心');
    }
    await require('./reviewed-install-identities.test')();
    await require('./market-release-metadata.test')();
    // 发行标签与包内版本不同时，卡片必须用真实仓库包及官方摘要确认发行身份。
    for (const { currentPackage, version, bootVersion, tag } of [
        { currentPackage: 1, version: '1.8', bootVersion: '1.7', tag: 'v1.8' },
        { currentPackage: 2, version: '1.8', bootVersion: '1.7', tag: 'v1.8' },
        { currentPackage: 2, version: '0.0.5', bootVersion: '0.0.5', tag: '25.5.23' }
    ]) {
        const { webcrypto, createHash } = require('node:crypto');
        const sb = loadMarket();
        sb.setTimeout = (callback, delay) => { if (delay === 0) callback(); return 0; };
        sb.crypto = webcrypto;
        sb.StartConfig = { version: '0.5.12.13' };
        const id = 'same-boot-published', githubUrl = `https://github.com/VersionTests/${id}`;
        const boot = { name: id, version: bootVersion, dependenceInfo: [] };
        const digest = 'sha256:' + createHash('sha256').update(new Uint8Array([2, 42])).digest('hex');
        const downloadUrl = `${githubUrl}/releases/download/${tag}/Published.zip`;
        const release = { tagName: tag, version, assets: [{ name: 'Published.zip', downloadUrl }] };
        const loader = { customStore: {}, constructor: { calcModNameKey: name => name } };
        sb._modHubModState = { sideEnabled: [id], sideDisabled: [], sideMods: [{ name: id, enabled: true }], builtInMods: [] };
        sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getIndexDBLoader: () => loader,
            getModCacheArray: () => [{ mod: { name: id, bootJson: boot } }] }),
            getIdbKeyValRef: () => ({ get: async () => new Uint8Array([currentPackage, 42]) }) } });
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async () => ({ ...boot }) });
        sb.modHubLoadModManageState = async () => {};
        sb.modHubLoadDisabledModInfo = async () => {};
        sb.modHubMarketVersions = { getGameVersion: () => '0.5.12.13',
            fetchReleases: async () => ({ page: 1, hasMore: false }), buildCandidates: () => [release], getLatestGameCandidate: () => release };
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketStats'].map(key => [key, createStubElement()]));
        sb.document.getElementById = key => elements.get(key) || null;
        const requests = [];
        sb.fetch = async url => {
            requests.push(String(url));
            if (String(url).startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ tag_name: tag,
                html_url: `${githubUrl}/releases/tag/${tag}`, assets: [{ name: 'Published.zip', browser_download_url: downloadUrl, size: 2, digest }] }) };
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: [{ id, identityId: id, name: id, bootNames: [id],
                githubUrl, version, releaseAssetVersion: bootVersion, releaseUrl: `${githubUrl}/releases/tag/${tag}`, versionSource: 'github' }] }) };
        };
        await sb.modHubInitMarket(true);
        const [mod] = sb.modHubMarket.getMarketMods();
        const update = sb.modHubMarket.getModUpdateInfo(mod);
        await update.promise;
        sb.modHubMarket.renderMarketCards();
        const card = elements.get('modHubMarketCardsContainer').innerHTML;
        assert.ok(requests.includes(`https://api.github.com/repos/VersionTests/${id}/releases/tags/${tag}`), '索引无摘要时补取精确tag的官方元数据');
        assert.ok(card.includes(`最新版本：v${version}`));
        assert.equal(mod._matchedLocal.version, bootVersion, '市场身份与依赖保留真实boot版本');
        if (currentPackage === 2) {
            const installedText = version === bootVersion ? `v${bootVersion}` : `v${version}（包内 v${bootVersion}）`;
            assert.ok(card.includes(`已安装版本：${installedText}`) && card.includes('>已是最新</span>'), '已装新包可显示真实发行版及包内版本');
            if (tag === '25.5.23') assert.ok(!card.includes('版本：v25.5.23'), '已核验0.0.5不能因包摘要一致被替换为日期tag');
            assert.equal(sb.modHubMarket.checkModInstallStatus(mod), 'up_to_date');
        } else {
            assert.ok(card.includes('已安装版本：v1.7') && !card.includes('>已是最新</span>'), '同boot旧包不能声称已装最新');
            assert.equal(sb.modHubMarket.checkModInstallStatus(mod), 'update_available');
            sb.modHubMarket.setModUpdateIgnored(mod.name, '1.8');
            assert.equal(sb.modHubMarket.checkModInstallStatus(mod), 'up_to_date', '精确摘要证明有更新时仍尊重忽略本次');
            sb.modHubMarket.setModUpdateIgnored(mod.name, 'ignored');
            assert.equal(sb.modHubMarket.checkModInstallStatus(mod), 'up_to_date', '包体摘要判断不能绕过永久忽略');
            sb.modHubMarket.setModUpdateIgnored(mod.name, '', false);
            assert.equal(sb.modHubMarket.checkModInstallStatus(mod), 'update_available');
        }
    }
    // 目录最新与已安装版本独立显示；未知游戏不能使线上版本字段消失。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '' };
        const cases = [
            { id: 'version-uninstalled', name: '未安装有最新版', version: '1.20', source: 'github', latest: 'v1.20' },
            { id: 'version-different', name: '已安装不同版本', local: '1.0', version: '2.0', source: 'github', latest: 'v2.0' },
            { id: 'version-same', name: '已安装相同版本', local: '2.0', version: '2.0', source: 'github', latest: 'v2.0', badge: '已是最新', reason: '与当前目录最新版本相同' },
            { id: 'version-unknown', name: '已安装远端未知', local: '7.0', version: '', source: 'github', latest: '未知', badge: '已安装', reason: '未能获取最新版本' },
            { id: 'version-local-only', name: '仅本地版本线索', local: '7.0', version: '7.0', source: 'installed', latest: '未知', badge: '已安装', reason: '未能获取最新版本' },
            { id: 'version-both-unknown', name: '已安装版本未识别', local: '', version: '', source: 'github', latest: '未知', badge: '已安装', reason: '无法识别已安装版本' },
            { id: 'version-local-unknown', name: '本地版本未知目录已知', local: '', version: '2.0', source: 'github', latest: 'v2.0', badge: '已安装', reason: '无法识别已安装版本' },
            { id: 'version-label', name: '原始版号说明', version: '', label: '公开测试版 <说明>', source: 'wiki', latest: '公开测试版 &lt;说明&gt;' },
            { id: 'version-registered', name: '登记真实包版本', local: '1.0.0', version: '1.0.20', assetVersion: '1.0.19', source: 'github', latest: 'v1.0.19' },
            { id: 'version-registered-same', name: '本地等于真实包版本', local: '1.0.19', version: '1.0.20', assetVersion: '1.0.19', source: 'github', latest: 'v1.0.19', badge: '已是最新' },
            { id: 'version-tag-same', name: '本地仅等于发布标签', local: '1.0.20', version: '1.0.20', assetVersion: '1.0.19', source: 'github', latest: 'v1.0.19', badge: '已安装' }
        ];
        const local = cases.filter(item => Object.hasOwn(item, 'local')).map(item => ({ name: item.id,
            bootJson: { name: item.id, version: item.local, repository: `https://github.com/VersionTests/${item.id}` } }));
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => local, getModListNameNoAlias: () => local.map(item => item.name) } });
        sb.modHubGetModInfo = name => local.find(item => item.name === name) || null;
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubCategoryCapsules', 'modHubMarketStats']
            .map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        const mods = cases.map(item => ({ id: item.id, identityId: item.id, name: item.name, bootNames: [item.id], author: '作者',
            githubUrl: `https://github.com/VersionTests/${item.id}`, version: item.version, versionSource: item.source,
            releaseAssetVersion: item.assetVersion, versionLabel: item.label }));
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods }) });
        await sb.modHubInitMarket(true);
        const html = elements.get('modHubMarketCardsContainer').innerHTML;
        for (const item of cases) {
            const card = html.split(`data-mod-name="${item.name}"`)[1].split('data-mod-name=')[0];
            assert.ok(card.includes(`最新版本：${item.latest}`), `${item.name} 保留真实线上最新字段`);
            assert.ok(card.includes(`<span class="purple">最新版本：${item.latest}</span>`), '线上最新版本统一使用紫色');
            if (Object.hasOwn(item, 'local')) {
                assert.ok(card.includes(`已安装版本：${item.local ? 'v' + item.local : '未知'}`), '已安装版本从本地包独立读取');
                assert.ok(card.includes(`<span class="${item.badge === '已是最新' ? 'green' : 'gold'}">已安装版本：`),
                    '仅核实已安装最新版本时使用绿色；较旧或版本未知时使用金色');
                assert.equal((card.match(/最新版本：/g) || []).length, 1);
                assert.equal((card.match(/已安装版本：/g) || []).length, 1);
            } else assert.ok(!card.includes('已安装版本：'), '未安装条目不构造本地版本');
            if (item.badge) assert.ok(new RegExp(`class="modhub-market-badge badge-installed"[^>]*>${item.badge}</span>`).test(card), `${item.name} 徽标须反映可核实的安装事实`);
            if (item.reason) assert.ok(card.includes(item.reason), `${item.name} 须提供明确原因`);
            if (item.badge === '已安装') assert.ok(!card.includes('>已是最新</span>'), '缺少版本事实或只有标签相同不能声称全局最新');
        }
        assert.ok(!html.includes('已安装版本：v1.20') && !html.includes('<说明>'), '未安装和原文说明不能伪造本地状态或注入HTML');
        assert.ok(!html.includes('更新版本待核对') && !html.includes('最新版本待核对'), '已安装事实不得被空适配检查替换成笼统待核对标签');
    }
    // 所有有效来源回退，卡片按平台合并，附件展示不触发下载，原始资料保持完整。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        const api = sb.modHubMarketSpells;
        const asset = 'https://github.com/Owner/Repo/releases/download/v1%2F2/Mod.zip';
        const entry = { sources: [{ platform: 'discord', url: 'https://discord.com/channels/1/2', instructions: '原文\r\n保留末尾\n' },
            { platform: 'tieba', url: 'https://discord.com/channels/1/2' }], sourceUrl: 'javascript:bad', githubUrl: asset,
            otherUrl: 'https://other.example.test/home' };
        const before = JSON.stringify(entry), links = api.getSourceLinks(entry);
        assert.equal(links.length, 3, '按真实平台合并，同名来源只展示一次');
        assert.ok(links.some(item => item.name === 'Discord' && item.url === 'https://discord.com/channels/1/2'));
        assert.ok(links.some(item => item.name === 'GitHub' && item.url === 'https://github.com/Owner/Repo/releases/tag/v1%2F2'));
        assert.ok(links.some(item => item.name === 'other.example.test' && item.url === entry.otherUrl), '未知站点使用真实域名');
        assert.equal(JSON.stringify(entry), before, '展示归一不得改写来源、附件和精确资格原数据');
        assert.equal(api.getSourceLinks({ githubUrl: asset + '/' })[0].url, 'https://github.com/Owner/Repo/releases/tag/v1%2F2', '附件尾斜杠仍展示发布页，与网站保持一致');
        assert.ok(api.acquisitionHtml(entry).includes('原文\r\n保留末尾\n') && api.acquisitionHtml(entry).includes(asset), '原附件及作者原文仍可在安装说明访问');
        const grouped = { sources: [
            { platform: 'discord', url: 'https://discord.com/channels/1/2', label: '主要原帖' },
            { platform: 'github', url: asset },
            { platform: 'discord', url: 'https://discord.com/channels/1/3', label: '补充原帖' },
            { platform: 'github', url: 'https://github.com/Owner/Repo/releases/tag/v2.0' },
            { platform: 'discord', url: 'https://discord.gg/OriginalInvite' },
            { platform: 'github', url: 'https://github.com/Owner/Repo/' }
        ] };
        const groupedBefore = JSON.stringify(grouped), groupedLinks = api.getSourceLinks(grouped);
        assert.deepEqual(Array.from(groupedLinks, item => [item.name, item.url]), [
            ['GitHub', 'https://github.com/Owner/Repo/'], ['Discord', 'https://discord.com/channels/1/2']
        ], '平台来源统一按 GitHub -> Discord -> 百度贴吧排序，Discord 保留首个原帖，GitHub 优先已提供的仓库主页');
        const groupedRow = api.renderAcquisitionDetails(grouped, 0);
        assert.equal((groupedRow.match(/>Discord<\/a>/g) || []).length, 1);
        assert.equal((groupedRow.match(/>GitHub<\/a>/g) || []).length, 1);
        assert.ok(!groupedRow.includes('GitHub（发布）') && !groupedRow.includes('modhub-market-acquisition-link') && !groupedRow.includes('安装说明'),
            '来源行按平台合并且不再提供安装说明入口');
        const groupedDetails = api.acquisitionHtml(grouped);
        for (const source of grouped.sources) assert.ok(groupedDetails.includes(`href="${source.url}"`), '每个原帖与附件仍完整保留');
        assert.equal(JSON.stringify(grouped), groupedBefore, '平台展示合并不得更改原始来源');
        const withoutHome = api.getSourceLinks({ sources: [grouped.sources[1], grouped.sources[3]] });
        assert.equal(withoutHome.length, 1);
        assert.equal(withoutHome[0].url, grouped.sources[3].url, '没有仓库主页时优先现有发布页，避免附件下载');
        const aliases = { sources: [
            { url: 'https://canary.discord.com/channels/1/2' }, { url: 'https://ptb.discord.com/channels/1/3' },
            { url: 'https://discordapp.com/channels/1/4' }, { url: 'https://discord.com/channels/1/5' },
            { url: 'https://www.github.com/Owner/Repo/releases/download/v1%2F2/Mod.zip?download=1#asset' },
            { url: 'https://github.com/Owner/Repo' }
        ] };
        assert.deepEqual(Array.from(api.getSourceLinks(aliases), item => [item.name, item.url]), [
            ['GitHub', aliases.sources[5].url], ['Discord', aliases.sources[0].url]
        ], '平台按统一顺序展示，Discord 官方域名和 GitHub www 入口仍按同一平台合并，与网站一致');
        assert.equal(api.getSourceLinks({ sources: [aliases.sources[4]] })[0].url,
            'https://www.github.com/Owner/Repo/releases/tag/v1%2F2', 'www 附件只派生发布页，标签编码保持且不携带下载参数');
        const mixed = { sources: [{ url: 'https://github.com/Owner/Repo' }], sourceUrl: 'https://tieba.baidu.com/p/123',
            githubUrl: 'https://github.com/Owner/Repo', otherUrl: 'https://other.example.test/home' };
        assert.equal(api.getSourceLinks(mixed).length, 3, '三字段有效来源全部补齐且不重复');
        const unsafe = { sources: [{ url: 'https://user:secret@example.test/' }, { url: 'javascript:bad' }],
            sourceUrl: 'https://user:secret@example.test/', githubUrl: 'http://github.com/Owner/Repo' };
        const empty = api.renderAcquisitionDetails(unsafe, 0);
        assert.ok(empty.includes('来源：') && empty.includes('暂无来源链接') && !empty.includes('<a '), '无有效来源固定显示空状态且不构造链接');
        const escaped = api.renderAcquisitionDetails({sources:[{url:'https://other.example.test/',label:'<script>bad</script>'}]},0);
        assert.ok(escaped.includes('&lt;script&gt;') && !escaped.includes('<script>'), '链接标题安全转义');
    }
    // 适配检查进度和错误保留版本事实，相等版本不因异步结果空白而改变徽标。
    for (const sameVersion of [true, false]) {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.12.13' };
        const id = `stable-status-${sameVersion}`, localVersion = sameVersion ? '2.0' : '1.0';
        const local = { name: id, bootJson: { name: id, version: localVersion, repository: `https://github.com/StatusTests/${id}` } };
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [local], getModListNameNoAlias: () => [id] } });
        sb.modHubGetModInfo = () => local;
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketStats'].map(key => [key, createStubElement()]));
        sb.document.getElementById = key => elements.get(key) || null;
        let failHistory;
        sb.modHubMarketVersions.fetchReleases = () => new Promise((_, reject) => { failHistory = reject; });
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [{ id, identityId: id, name: id,
            bootNames: [id], author: '作者', githubUrl: `https://github.com/StatusTests/${id}`, version: '2.0', versionSource: 'github' }] }) });
        await sb.modHubInitMarket(true);
        const [mod] = sb.modHubMarket.getMarketMods(), pending = sb.modHubMarket.getModUpdateInfo(mod);
        const expectedBadge = sameVersion ? '已是最新' : '已安装';
        const cards = () => elements.get('modHubMarketCardsContainer').innerHTML;
        assert.equal(pending.pending, true);
        assert.ok(new RegExp(`badge-installed"[^>]*>${expectedBadge}</span>`).test(cards()));
        assert.ok(cards().includes('正在检查更新') && cards().includes(`已安装版本：v${localVersion}`) && cards().includes('最新版本：v2.0'));
        failHistory(new Error('测试历史服务离线 <script>不执行</script>'));
        await pending.promise;
        assert.ok(new RegExp(`badge-installed"[^>]*>${expectedBadge}</span>`).test(cards()), '网络失败不覆盖已核实的安装与目录版本事实');
        assert.ok(cards().includes('更新检查失败') && cards().includes('&lt;script&gt;不执行&lt;/script&gt;') && !cards().includes('<script>'));
        assert.ok(cards().includes(`已安装版本：v${localVersion}`) && cards().includes('最新版本：v2.0'));
        assert.notEqual(sb.modHubMarket.checkModInstallStatus(mod), 'update_available', '显示事实不改变适配更新动作判断');
    }
    // 两个板块独立筛选，来源直接链接原帖，卡片不再提供安装说明入口。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubMarketSections',
            'modHubMarketStats', 'modHubCategoryCapsules', 'modHubMarketFilterFooter', 'modHubMarketSpellNote',
            'modHubMarketSearch', 'modHubStatusSelect', 'modHubSortSelect', 'modHubMirrorSelect',
            'modHubMarketBatchToolbar', 'modHubMarketBtnResetFilter'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        const record = { id: 'external-v1', fileName: 'external.zip', format: 'ModLoader Zip', bootName: 'External',
            version: '1.0', gameVersionRange: '', dependencies: [{ id: 'Replace', version: '^1.0' }],
            sourceUrl: 'https://tieba.baidu.com/p/456', downloadUrl: 'https://pan.example.test/version',
            evidenceUrl: 'https://tieba.baidu.com/p/789', framework: '原美化框架', prerequisites: ['保留存档', '选择对应语言'],
            verificationScope: '旧游戏版本的原始说明\n<script>不能执行</script>',
            instructions: '前置安装完成后导入此包。\n不能与另一语言版本同时启用。',
            archivePassword: 'abc<123', extractionCode: '4567' };
        const external = { id: 'external-ui', name: '外部资料', author: '作者', contentType: 'package',
            catalogSource: 'community', sourcePlatform: 'tieba', sourceUrl: 'https://tieba.baidu.com/p/456',
            autoInstall: false, sources: [{ platform: 'tieba', url: 'https://tieba.baidu.com/p/456',
                instructions: '作者原文\n登录后下载', downloadUrl: 'https://pan.example.test/file', extractionCode: '4567' }],
            packageRecords: [record] };
        const github = { id: 'github-ui', name: '可下载包', author: '作者', githubUrl: 'https://github.com/Owner/Direct',
            sources: [{ platform: 'github', url: 'https://github.com/Owner/Direct' }] };
        const spell = { id: 'spell-ui', name: '独立咒语', contentType: 'spell', spell: { body: '<<set $x to "t">>\n原文', inputLocation: '指定位置' } };
        const index = { schemaVersion: 1, communityRevision: 21, mods: [external, github], spells: [spell] };
        sb.fetch = async () => ({ ok: true, json: async () => index });
        await sb.modHubInitMarket(true);
        const cards = () => elements.get('modHubMarketCardsContainer').innerHTML;
        const sections = () => elements.get('modHubMarketSections').innerHTML;
        const search = elements.get('modHubMarketSearch');
        assert.ok(sections().includes('MOD 与美化（2）') && sections().includes('咒语（1）'), '板块入口直接显示两区数量');
        assert.ok(sections().includes('data-section="packages" aria-pressed="true"'), '默认明确选中 MOD 与美化');
        const externalCard = cards().split('data-mod-name="外部资料"')[1].split('<div class="childItem modhub-market-card')[0];
        assert.ok(!externalCard.includes('>主页</a>') && !externalCard.includes('外部主页') && !externalCard.includes('获取与适配说明'));
        assert.equal((externalCard.match(/class="modhub-market-source-bar"/g) || []).length, 1, '每张卡片统一提供一行来源');
        assert.match(externalCard, /<a class="modhub-market-source-link" href="https:\/\/tieba.baidu.com\/p\/456"[^>]*>百度贴吧<\/a>/, '平台文字直接链接原帖');
        assert.ok(!externalCard.includes('modhub-market-acquisition-link') && !externalCard.includes('安装说明'), '即使含额外资料，卡片也不提供安装说明入口');
        assert.ok(!externalCard.includes('查看来源') && !externalCard.includes('<details') && !externalCard.includes('abc&lt;123') && !externalCard.includes('前置安装完成'), '来源直接链接原帖，不在卡片展开长资料');
        assert.ok(!externalCard.includes('安装包资料待核对') && !externalCard.includes('未游戏实测') && !/已核验 \d+ 个安装包/.test(externalCard), '卡片不显示自动生成的核验统计');
        const githubName = sb.modHubMarket.getMarketMods().find(mod => mod.id === 'github-ui').name;
        const githubCard = cards().split(`data-mod-name="${githubName}"`)[1].split('data-mod-name=')[0];
        assert.ok(githubCard.includes('modhub-market-source-bar') && githubCard.includes('href="https://github.com/Owner/Direct"'), '普通 GitHub 也显示同一来源行');
        assert.ok(!githubCard.includes('modhub-market-acquisition-link') && !githubCard.includes('>主页</a>'), '没有额外资料时不增加说明或重复主页入口');
        const sourceHtml = sb.modHubMarketSpells.acquisitionHtml(external), sourceText = sourceHtml.replace(/<[^>]*>/g, '');
        for (const text of ['提取码：4567', '解压密码：abc&lt;123', '前置要求：Replace ^1.0', '适配 DoL：未知，请核对作者说明',
            '原美化框架', 'external.zip', '版本 1.0', '保留存档\n选择对应语言', '安装包资料待核对', '未游戏实测', '支持 ModLoader']) {
            assert.ok(sourceText.includes(text), `底层原始资料仍保留 ${text}`);
        }
        assert.ok(sourceHtml.includes('旧游戏版本的原始说明\n&lt;script&gt;不能执行&lt;/script&gt;'));
        assert.ok(sourceHtml.includes('前置安装完成后导入此包。\n不能与另一语言版本同时启用。'), '作者说明与换行逐字保留');
        for (const url of [record.sourceUrl, record.downloadUrl, record.evidenceUrl, external.sources[0].downloadUrl]) {
            assert.ok(sourceHtml.includes(`href="${url}"`), '原平台、逐包下载和核验链接保留');
        }
        assert.ok(!sourceHtml.includes('<script>') && !sourceHtml.includes('安装包结构已核验'));
        const sameGithub = { sources: [{ platform: 'github', url: 'https://github.com/Owner/Only', downloadUrl: 'https://github.com/Owner/Only' }] };
        assert.ok(sb.modHubMarketSpells.renderAcquisitionDetails(sameGithub, 0).includes('modhub-market-source-link') && !sb.modHubMarketSpells.renderAcquisitionDetails(sameGithub, 0).includes('modhub-market-acquisition-link'), '同一 GitHub URL 仍统一显示来源，但不增加说明入口');
        assert.equal((sb.modHubMarketSpells.acquisitionHtml(sameGithub).match(/href="https:\/\/github\.com\/Owner\/Only"/g) || []).length, 1,
            '同一来源的原帖和下载地址相同时只显示一个链接');
        assert.ok(cards().includes('btn-market-install'), '普通 GitHub 条目仍可进入原有安装入口');
        assert.ok(!cards().includes('独立咒语') && !elements.get('modHubCategoryCapsules').innerHTML.includes('咒语配方'), '咒语独立于模组卡片和分类');

        search.value = '外部资料';
        sb.modHubMarket.selectMarketSection('packages');
        assert.ok(cards().includes('外部资料') && !cards().includes('可下载包'), '点击当前板块应立即使用搜索框当前值');

        sb.setTimeout = callback => { callback(); return 0; };
        search.value = '外部资料';
        search.oninput();
        assert.ok(cards().includes('外部资料') && !cards().includes('可下载包'));
        const selectedMod = sb.modHubMarket.getMarketMods().find(mod => mod.id === 'github-ui');
        const selectedKey = sb.modHubMarket.getMarketModKey(selectedMod);
        sb.modHubMarket.toggleBatchSelection(true);
        sb.modHubMarket.setBatchModSelected(selectedKey, true);
        assert.ok(sb.modHubMarket.getBatchSelectionState().selected.includes(selectedKey), '用例先明确勾选可安装 MOD');
        assert.equal(sb.modHubMarket.selectMarketSection('spells'), true);
        assert.ok(sb.modHubMarket.getBatchSelectionState().selected.includes(selectedKey), '同一会话进入咒语不清除 MOD 勾选');
        assert.equal(sb.modHubMarket.selectMarketSection('packages'), true);
        assert.ok(sb.modHubMarket.getBatchSelectionState().selected.includes(selectedKey), '同一会话返回 MOD 区恢复原勾选');
        assert.equal(sb.modHubMarket.selectMarketSection('spells'), true);
        let finishManagerRead, startedManagerRead;
        const managerReadStarted = new Promise(resolve => { startedManagerRead = resolve; });
        const originalManagerRead = sb.modHubLoadModManageState;
        sb.modHubLoadModManageState = () => { startedManagerRead(); return new Promise(resolve => { finishManagerRead = resolve; }); };
        const reopening = sb.modHubInitMarket();
        await managerReadStarted;
        assert.equal(elements.get('modHubMarketBatchToolbar').hidden, true, '重新进入咒语区时，管理状态读取未完成也必须立即隐藏批量栏');
        assert.ok(elements.get('modHubModMarketContainer').innerHTML.includes('aria-label="模组多选安装" hidden'), '初始DOM就隐藏咒语板块的批量入口');
        assert.equal(await sb.modHubMarket.installSelectedMods(), false, '咒语期间残留的批量动作不能安装已勾选 MOD');
        assert.equal(sb.modHubMarket.isInstallBusy(), false, '阻止动作不建立安装或恢复上下文');
        finishManagerRead();
        await reopening;
        sb.modHubLoadModManageState = originalManagerRead;
        assert.equal(search.value, '', '首次进入咒语区不继承 MOD 搜索');
        assert.ok(cards().includes('独立咒语') && !cards().includes('btn-market-install'));
        assert.ok(sections().includes('data-section="spells" aria-pressed="true"'));
        assert.equal(elements.get('modHubMarketBatchToolbar').hidden, true);
        assert.equal(elements.get('modHubStatusSelect').hidden, true);
        assert.equal(elements.get('modHubMarketFilterFooter').hidden, true);
        assert.equal(elements.get('modHubMarketStats').hidden, true);
        assert.equal(elements.get('modHubMarketSpellNote').hidden, false);
        assert.equal(elements.get('modHubCategoryCapsules').style.display, 'none');
        search.value = '不匹配';
        search.oninput();
        assert.ok(cards().includes('没有匹配的咒语配方'));
        sb.modHubMarket.resetFilters();
        assert.equal(sb.modHubMarket.getCurrentMarketSection(), 'spells', '清除咒语搜索保持当前板块');
        assert.ok(cards().includes('独立咒语'));
        search.value = '原文';
        search.oninput();
        assert.equal(sb.modHubMarket.selectMarketSection('packages'), true);
        assert.equal(search.value, '外部资料', '返回 MOD 区恢复该区的搜索');
        assert.equal(elements.get('modHubMarketBatchToolbar').hidden, false);
        assert.equal(elements.get('modHubMarketStats').hidden, false);
        assert.equal(sb.modHubMarket.selectMarketSection('spells'), true);
        assert.equal(search.value, '原文', '返回咒语区恢复该区搜索');
        sb.modHubMarket.filterInstalledOnly();
        assert.equal(sb.modHubMarket.getCurrentMarketSection(), 'packages', '已安装快捷入口明确返回 MOD 区');
        assert.equal(elements.get('modHubStatusSelect').value, 'installed');
        assert.equal(sb.modHubMarket.selectMarketSection('spells'), true);
        sb.modHubMarketSpells.applyIndex({ communityRevision: 22, spells: [] });
        sb.modHubMarket.resetFilters();
        assert.ok(sections().includes('咒语（0）') && cards().includes('当前暂无咒语配方'), '空板块保留可发现的入口及原因');
        sb.modHubMarket.batchInstallState.running = true;
        assert.equal(sb.modHubMarket.selectMarketSection('packages'), false, '安装处理中不切换板块或混入其他操作');
        assert.equal(sb.modHubMarket.getCurrentMarketSection(), 'spells');
    }
    // 维护者批准的固定附件仍受原安装资格校验，语言和历史渠道不能互相替换。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-spells.js', 'javascript/modhub-market-versions.js']);
        const market = sb.modHubMarket;
        const url = 'https://github.com/Owner/Shared/releases/download/v1.0/Shared.CHS.1.0.zip';
        const approved = { id: 'community-chs', identityId: 'shared-chs', name: '共享仓库中文包', contentType: 'package',
            catalogSource: 'community', sourcePlatform: 'github', sourceUrl: url, githubUrl: url,
            autoInstall: true, bootNames: ['SharedCHS'], repositoryKeys: ['Owner/Shared'] };
        const [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [approved] });
        assert.equal(mod.githubUrl, url, '可信社区固定附件保留完整 GitHub 来源');
        assert.equal(market.hasCommunityReleaseSource(mod), true);
        assert.equal(market.isBatchInstallEligible(mod, []), true);
        const communityGithubMod = {
            id: 'community-0b975914-aba0-477e-9737-7a4e07eb1e9e',
            identityId: 'community-0b975914-aba0-477e-9737-7a4e07eb1e9e',
            name: 'BSA 美化切换器',
            author: '隨風飄逸',
            catalogSource: 'community',
            sourcePlatform: 'github',
            sourceUrl: 'https://github.com/chris81605/DoL-BSA-Beauty-Switcher.git',
            githubUrl: 'https://github.com/chris81605/DoL-BSA-Beauty-Switcher/releases/latest',
            autoInstall: true,
            bootNames: ['BSA 美化切换器'],
            repositoryKeys: ['chris81605/dol-bsa-beauty-switcher'],
        };
        assert.equal(market.hasCommunityReleaseSource(communityGithubMod), true, '审核通过的社区 GitHub 模组应当具备安装资格');
        assert.equal(market.checkModInstallStatus(communityGithubMod, []), 'not_installed', '审核通过的社区 GitHub 模组未安装时应呈现下载安装');
        assert.equal(market.hasCommunityReleaseSource({ ...approved, autoInstall: false }), false, '关闭安装资格时不能因已知仓库或资产绕过');
        const [manual] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ ...approved, autoInstall: false,
            sourcePlatform: 'discord', sourceUrl: 'https://discord.com/channels/1/2', sources: [{ platform: 'github', url }] }] });
        assert.equal(manual.githubUrl, null, '追加 GitHub 来源不能擅自赋予直接安装资格');
        assert.equal(market.isBatchInstallEligible(manual, []), false);
        assert.equal(market.hasCommunityReleaseSource({ ...approved, repositoryKeys: ['Owner/Other'] }), false);
        assert.equal(market.hasCommunityReleaseSource({ ...approved, bootNames: [] }), false);
        assert.equal(market.hasCommunityReleaseSource({ ...approved, githubUrl: 'https://github.com/Owner/Shared' }), false);
        const release = { tagName: 'v1.0', publishedAt: '2026-10-04T00:00:00Z', assets: [{ name: 'Shared.CHS.1.0.zip', size: 100, downloadUrl: url }] };
        const candidates = sb.modHubMarketVersions.buildCandidates(mod, { id: mod.id, sourceUrl: url, releases: [release] });
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].assetName, 'Shared.CHS.1.0.zip');
        assert.equal(sb.modHubMarketVersions.buildCandidates(mod, { id: mod.id, sourceUrl: url, releases: [{ ...release,
            assets: [{ name: 'Shared.EN.1.0.zip', size: 100, downloadUrl: url.replace('CHS', 'EN') }] }] }).length, 0, '固定中文附件不能改选英文附件');
        assert.equal(sb.modHubMarketVersions.buildCandidates(mod, { id: mod.id, sourceUrl: url, releases: [{ ...release,
            tagName: 'v2.0', assets: [{ name: 'Shared.CHS.2.0.zip', size: 100, downloadUrl: url.replaceAll('1.0', '2.0') }] }] }).length, 0, '未经登记的新标签不能替换历史固定包');
        sb.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.0',
            assets: [{ name: 'Shared.EN.1.0.zip', browser_download_url: url.replace('CHS', 'EN') },
                { name: 'Shared.CHS.1.0.zip', browser_download_url: url }] }) });
        const fetched = await market.fetchModRelease(mod, { useCache: false });
        assert.equal(fetched.assetName, 'Shared.CHS.1.0.zip', '直接发布解析同样只采用指定附件');
        assert.equal(fetched.availableAssets?.length || fetched.assets?.length, 1);
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubCategoryCapsules']
            .map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [approved] }) });
        await sb.modHubInitMarket(true);
        const card = elements.get('modHubMarketCardsContainer').innerHTML;
        assert.ok(card.includes('btn-market-install'), '批准的精确附件以普通安装卡片呈现');
        assert.ok(card.includes('href="https://github.com/Owner/Shared/releases/tag/v1.0"'), '主页应查看标签发布页，不直接触发 ZIP 下载');
    }
    // v1 扩展保持安装身份，并将配方与所有安装入口隔离。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        const api = sb.modHubMarketSpells;
        const body = '<<set $test = "<script>alert(1)</script>">>\n  第二行\n';
        const spell = { id: 'spell-test', name: '测试配方', contentType: 'spell', sourceUrl: 'https://tieba.baidu.com/p/123',
            spell: { body, syntax: 'SugarCube', inputLocation: '作者指定位置', gameVersionRange: '0.5.12.13' } };
        assert.equal(api.applyIndex({ communityRevision: 3, spells: [spell] }), true);
        assert.equal(api.getSpells()[0].spell.body, body, '原始正文及尾部换行必须逐字保留');
        assert.equal(api.filter('第二行').length, 1, '配方正文必须参与搜索');
        assert.equal(api.applyIndex({ communityRevision: 2, spells: [] }), false, '旧目录不得覆盖新修订');
        assert.equal(api.restoreCache(2), false, '修订不匹配不得复活缓存配方');
        assert.equal(api.restoreCache(3), true);
        assert.equal(api.applyIndex({ communityRevision: 4, spells: [], withdrawnSpellIds: [spell.id] }), true);
        assert.equal(api.getSpells().length, 0, '下架后的完整快照必须清除配方');
        assert.equal(api.applyIndex({ communityRevision: 5, spells: [{ ...spell, spell: { body: '更正文' } }] }), true);
        assert.equal(api.getSpells()[0].spell.body, '更正文', '更正或恢复只读取新快照');
        assert.equal(api.applyIndex({ communityRevision: 6, mods: [] }), true);
        assert.equal(api.getSpells().length, 0, '旧索引缺少配方字段时视为空列表');
        assert.equal(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [spell] }).length, 0);
        assert.equal(sb.modHubMarket.isBatchInstallEligible({ ...spell, githubUrl: 'https://github.com/Owner/Test' }), false);
        assert.equal(sb.modHubMarket.checkModInstallStatus(spell), 'unavailable');
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(spell), false, '配方不能下载或创建还原上下文');
        assert.equal(sb.modHubMarket.buildBatchInstallPlan([spell]).actions.length, 0, '配方不得进入批量安装计划');
        loadScripts(sb, ['javascript/modhub-market-versions.js', 'javascript/modhub-market-install.js']);
        assert.equal(await sb.modHubMarketInstaller.install(spell), false, '共用选版入口必须拒绝配方');
        assert.equal(await sb.modHubMarketInstaller.installBatch([spell]), false, '共用批量入口必须拒绝纯配方列表');
        const repository = 'https://github.com/Owner/Package/releases/tag/v1';
        const mod = { id: 'community-package', name: '测试安装包', contentType: 'package', catalogSource: 'community',
            identityId: 'package', bootNames: ['Package'], repositoryKeys: ['Owner/Package'], sourcePlatform: 'tieba',
            sourceUrl: 'https://tieba.baidu.com/p/456', githubUrl: repository, autoInstall: true,
            sources: [{ platform: 'github', url: repository }, { platform: 'tieba', url: 'https://tieba.baidu.com/p/456',
                downloadUrl: 'https://pan.example.test/download', extractionCode: '1234', archivePassword: 'abcd', instructions: '<script>不执行</script>' }],
            packageRecords: [{ id: 'package-v1', sourceUrl: 'https://tieba.baidu.com/p/456', fileName: 'Package.zip', format: 'zip',
                sha256: 'a'.repeat(64), evidenceUrl: 'https://tieba.baidu.com/p/456', verifiedAt: '2026-10-04T08:00:00Z',
                version: '1', gameVersionRange: '0.5.12.13', gameTested: false, verificationStatus: 'package-checked',
                wholePackageStructureChecked: true, verificationScope: '外层及内层完整引用；<script>只读检查</script>' }] };
        const [normalized] = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [mod] });
        assert.equal(normalized.githubUrl, repository, '追加贴吧来源不能移除已审核 GitHub 发布源');
        assert.equal(normalized.autoInstall, true);
        assert.equal(normalized.packageRecords[0].gameVersionRange, '0.5.12.13');
        assert.equal(api.isVerifiedPackage(normalized.packageRecords[0]), true);
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], sha256: '缺少摘要' }), false);
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], verificationStatus: 'pending' }), false);
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], wholePackageStructureChecked: undefined }), false, '缺少完整结构证据不能显示核验徽标');
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], wholePackageStructureChecked: false }), false, '仅外层核验不能显示完整包徽标');
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], verificationStatus: 'package-defect' }), false, '缺陷包不能显示完整核验徽标');
        assert.equal(api.isVerifiedPackage({ ...normalized.packageRecords[0], verificationStatus: 'outer-only' }), false);
        const html = api.acquisitionHtml(normalized);
        const acquisitionText = html.replace(/<[^>]*>/g, '');
        assert.ok(acquisitionText.includes('提取码：1234') && acquisitionText.includes('解压密码：abcd') && acquisitionText.includes('未游戏实测'));
        assert.ok(html.includes('&lt;script&gt;不执行&lt;/script&gt;'), '获取说明必须转义');
        assert.ok(acquisitionText.includes('核验范围：外层及内层完整引用；&lt;script&gt;只读检查&lt;/script&gt;'), '核验范围按文本显示并转义');
        assert.equal(api.normalizeSources({ sources: [{ platform: 'tieba', url: 'javascript:alert(1)' }] }).length, 0);
        let copied = '';
        sb.navigator = { clipboard: { writeText: async value => { copied = value; } } };
        assert.equal(await api.copyBody(spell), true);
        assert.equal(copied, body, '复制正文不能裁剪换行或执行正文');
        let renderedBody;
        sb.modHubConfirm = async options => {
            const host = createStubElement();
            options.onRender({ querySelector: () => host });
            renderedBody = host.children.find(element => element.tagName === 'PRE');
            return false;
        };
        await api.showDetails(spell);
        assert.ok(renderedBody, '配方详情必须真实构建可选择的 pre 节点');
        assert.equal(renderedBody.textContent, body, '详情只写 textContent 并逐字保留正文');
        assert.equal(renderedBody.innerHTML, '', '正文不能写入 HTML 或执行');
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, communityRevision: 7, mods: [mod], spells: [spell] }) });
        await sb.modHubMarket.fetchReleaseIndex();
        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        await sb.modHubMarket.loadMarketData();
        assert.equal(sb.modHubMarketSpells.getSpells()[0].spell.body, body, '从模组目录缓存加载时按同一修订恢复独立配方缓存');
        const emptySb = loadMarket();
        loadScripts(emptySb, ['javascript/modhub-market-spells.js']);
        emptySb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, communityRevision: 8, mods: [], spells: [spell] }) });
        await emptySb.modHubMarket.fetchReleaseIndex();
        loadScripts(emptySb, ['javascript/modhub-market-spells.js']);
        emptySb.fetch = async () => { throw new Error('离线配方缓存测试'); };
        assert.equal((await emptySb.modHubMarket.loadMarketData()).length, 0);
        assert.equal(emptySb.modHubMarketSpells.getSpells().length, 1, '纯配方目录离线时仍可恢复同修订的配方缓存');
    }
    {
        const sb = loadManager();
        const boot = { name: 'ModLoader DoL ImageLoaderHook', version: '2.101.0', alias: ['ImageLoaderHook', 'ImageLoaderHookCore'],
            dependenceInfo: [{ modName: 'ModLoader', version: '^2.100.0' }, { modName: 'GameVersion', version: '>=0.5.6' }] };
        const mod = { name: boot.name, alias: boot.alias, bootJson: boot };
        const cache = [{ name: boot.name, from: 'Local', mod, zip: {} }];
        sb.modHubGetGui = () => ({ gModUtils: {
            getModLoader: () => ({ getModCacheArray: () => cache }),
            getModListNameNoAlias: () => [boot.name],
            getMod: name => name === boot.name || boot.alias.includes(name) ? mod : null
        } });
        sb._modHubModState = { builtInMods: [boot.name], sideEnabled: [], sideDisabled: [], sideMods: [] };
        loadScripts(sb, ['javascript/modhub-market.js']);
        assert.equal(sb.modHubGetModInfo('ImageLoaderHook'), null, '原生别名不能污染管理器的真实名称查找');
        const profiles = sb.modHubMarket.getLocalInstalledProfiles();
        assert.equal(profiles.length, 1, '包装缓存、规范名称列表与内置状态必须按真实名称去重');
        assert.equal(profiles[0].name, boot.name);
        assert.equal(profiles[0].bootJson, boot, '本地档案必须保留规范名称核验后的真实 boot 及递归前置');
        assert.deepEqual([...sb.modHubMarketInstaller.getDependencyBootNames(profiles[0].bootJson)], [boot.name, ...boot.alias]);
        assert.equal(sb.modHubMarketInstaller.satisfiesDependency(profiles[0].bootJson, { bootName: 'ImageLoaderHook', version: '^2.18.0' }), true);
        assert.equal(sb.modHubMarket.checkModInstallStatus({ id: 'unrelated', name: 'ImageLoaderHook', bootNames: ['UnrelatedProvider'], githubUrl: 'https://github.com/ModHubTests/UnrelatedProvider', version: '2.101.0' }, profiles), 'not_installed', '仅依赖别名匹配不能扩散为市场安装身份');
        cache.push({ name: boot.name, from: 'Side', mod: { name: boot.name, bootJson: { ...boot, version: '2.102.0', alias: ['CurrentAlias'] } } });
        const updated = sb.modHubMarket.getLocalInstalledProfiles()[0];
        assert.equal(updated.version, '2.102.0', '同名新缓存必须覆盖旧运行时声明');
        assert.deepEqual([...updated.bootJson.alias], ['CurrentAlias']);
        const pendingBoot = { ...boot, version: '2.103.0', alias: ['PendingAlias'] };
        sb._modHubDisabledModInfo.set(boot.name.toLowerCase(), { name: boot.name, bootJson: pendingBoot });
        assert.equal(sb.modHubMarket.getLocalInstalledProfiles()[0].version, '2.103.0', '已持久化的新安装清单不能被尚未重载的旧运行态覆盖');
        sb._modHubDisabledModInfo.set(boot.name.toLowerCase(), { name: boot.name, bootJson: { name: 'UnrelatedAliasProvider', version: '99.0' } });
        assert.equal(sb.modHubMarket.getLocalInstalledProfiles()[0].version, '2.102.0', '仓库记录的别名或错误技术名不能覆盖精确身份');
    }
    // 作者展示名与包内技术名不同时，旧索引和离线目录也须使用精确身份。
    {
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        const fixtures = [
            { id: 'midsummer-night-dream', legacyId: '多恋人淫啪-mnd-hotel', name: '多恋人淫啪',
                repo: 'youmu1818/MND-Hotel', bootName: 'MidsummerNightDream', nickName: '仲夏夜之梦', version: '1.1' },
            { id: 'deadwood-reblooms', legacyId: '枯木逢春-deadwood-reblooms', name: '枯木逢春',
                repo: 'MaplebirchLeaf/Deadwood-Reblooms', bootName: 'deadwood-reblooms', nickName: '枯木逢春', version: '1.3.1' }
        ];
        for (const fixture of fixtures) {
            const sb = loadMarket(), market = sb.modHubMarket;
            const cache = [];
            sb.modHubGetGui = () => ({ gModUtils: { getModLoader: () => ({ getModCacheArray: () => cache }) } });
            const source = `https://github.com/${fixture.repo}`;
            const raw = { id: fixture.legacyId, identityId: null, name: fixture.name, githubUrl: source,
                bootNames: [], aliases: [], repositoryKeys: [], version: fixture.version, versionSource: 'github',
                releaseUrl: `${source}/releases/tag/v${fixture.version}` };
            const [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, identities: [], mods: [raw] });
            const identity = catalog.mods.find(item => item.id === fixture.id);
            assert.ok(identity, '共享身份表须包含已核验包体的技术名');
            assert.equal(mod.id, fixture.legacyId, '旧索引条目 ID 须保留，不能破坏服务端历史查询');
            assert.equal(mod.identityId, identity.id);
            for (const field of ['bootNames', 'aliases', 'repositories', 'repositoryKeys', 'tags']) {
                assert.deepEqual(Array.from(mod[field]), identity[field], `内置与共享身份的 ${field} 须一致`);
            }
            assert.equal(mod.category, identity.category);
            assert.equal(market.checkModInstallStatus(mod), 'not_installed');
            const boot = { name: fixture.bootName, version: fixture.version, nickName: { cn: fixture.nickName } };
            cache.push({ mod: { name: boot.name, bootJson: boot } });
            assert.equal(market.checkModInstallStatus(mod), 'up_to_date', '新安装包重读后须立即识别为已安装');
            assert.equal(mod._matchedLocal?.name, fixture.bootName);
            assert.equal(mod._matchedLocal?.version, fixture.version);

            cache.length = 0;
            sb._modHubModState = { sideEnabled: [], sideDisabled: [boot.name], sideMods: [{ name: boot.name, enabled: false }], builtInMods: [] };
            sb._modHubDisabledModInfo.set(boot.name.toLowerCase(), { name: boot.name, bootJson: boot });
            assert.equal(market.checkModInstallStatus(mod), 'up_to_date', '已禁用的真实安装包仍须识别为已安装');
            sb._modHubModState = null;
            sb._modHubDisabledModInfo.clear();

            for (const falseBoot of [
                { name: 'UnrelatedNativeMod', version: fixture.version, nickName: fixture.name, alias: [fixture.bootName], repository: source },
                { name: fixture.bootName, version: fixture.version, repository: `https://github.com/Another/${fixture.repo.split('/')[1]}` },
                { name: `${fixture.bootName}-audio`, version: fixture.version, nickName: fixture.name, repository: source }
            ]) {
                cache.splice(0, cache.length, { mod: { name: falseBoot.name, bootJson: falseBoot } });
                assert.equal(market.checkModInstallStatus(mod), 'not_installed', '昵称、依赖别名、错误作者或音频扩展均不能冒充主包');
                assert.equal(mod._matchedLocal, null);
            }
            const [wrongSource] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ ...raw,
                githubUrl: `https://github.com/Another/${fixture.repo.split('/')[1]}` }] });
            assert.equal(wrongSource.identityId, null, '同名不同仓库的旧索引不能补用内置身份');
            const [otherProduct] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ ...raw, name: `${fixture.name}音频包` }] });
            assert.equal(otherProduct.identityId, null, '同仓库其他产品不能补用主包身份');
            const [community] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ ...raw, catalogSource: 'community',
                sourceUrl: `${source}/releases/latest`, sourcePlatform: 'github', autoInstall: false }] });
            assert.equal(community.identityId, null, '未核验社区条目不能由内置映射替代审核关联');
        }
    }
    /* =========================================================================
     * 10. 统一索引契约（网站 release-index / 身份目录 <-> Mod 端消费）
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        assert.ok(market, '市场模块必须导出 window.modHubMarket');
        for (const member of ['normalizeReleaseIndex', 'applyIdentityCatalog', 'fetchReleaseIndex', 'MARKET_CATEGORIES', 'KNOWN_MOD_MARKET_ALIASES', 'IDENTITY_CATALOG_URL', 'RELEASE_WORKER_API_BASE']) {
            assert.ok(market[member] !== undefined, `市场导出必须包含 ${member}`);
        }
        // 10.1 schemaVersion 守卫
        assert.throws(() => market.normalizeReleaseIndex({ schemaVersion: 2, mods: [] }), /格式异常/, '非 v1 索引必须拒绝');
        const normalized = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [] });
        assert.ok(normalized && typeof normalized === 'object', '合法索引必须正常归一化');
        // 10.2 身份目录结构契约：schemaVersion=1、mods 数组、关键字段齐全
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        assert.equal(catalog.schemaVersion, 1, '身份目录 schemaVersion 必须为 1');
        assert.ok(Array.isArray(catalog.mods) && catalog.mods.length > 0, '身份目录 mods 必须为非空数组');
        for (const mod of catalog.mods) {
            assert.ok(mod.id && typeof mod.id === 'string', '身份条目必须包含 id');
            assert.ok(mod.name && typeof mod.name === 'string', `身份条目 ${mod.id} 必须包含 name`);
            assert.ok(Array.isArray(mod.bootNames), `身份条目 ${mod.id} 必须包含 bootNames 数组`);
            assert.ok(typeof mod.category === 'string', `身份条目 ${mod.id} 必须声明分类`);
            // 10.3 分类必须落在市场分类表内，否则 applyIdentityCatalog 会静默丢弃
            assert.ok(market.MARKET_CATEGORIES.includes(mod.category), `身份条目 ${mod.id} 的分类「${mod.category}」必须存在于 MARKET_CATEGORIES`);
            for (const rule of mod.releaseCompatibility || []) {
                assert.ok(typeof rule.releaseTag === 'string' && rule.releaseTag, '兼容记录必须绑定精确发布标签');
                assert.ok(typeof rule.gameVersionRange === 'string' && rule.gameVersionRange, '兼容记录必须包含明确范围');
                assert.match(rule.evidenceUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\//, '兼容证据必须指向作者精确发布');
                if (rule.dependencies !== undefined) assert.ok(Array.isArray(rule.dependencies), '历史前置缺失与显式空数组必须可区分');
            }
        }
        // 10.4 身份目录可被 Mod 端正确消费（应用数量与别名注册）
        const applied = market.applyIdentityCatalog(JSON.parse(JSON.stringify(catalog)));
        assert.ok(applied >= catalog.mods.length, '身份目录必须全部被应用');
        const first = catalog.mods.find(m => m.bootNames.length > 0);
        // 与市场内部 normalizeKey 等效的键归一化
        const firstKey = String(first.bootNames[0]).toLowerCase().replace(/[()（）\[\]【】_—\-—.\s]/g, '').trim();
        assert.ok(market.KNOWN_MOD_MARKET_ALIASES[firstKey], `应用后必须能通过 bootName 键「${firstKey}」检索到别名映射`);

        // 10.5 目录与版本独立刷新仍兼容 v1，且保留 Wiki 元数据与权威版本字段
        const indexedMod = {
            ...catalog.mods.find(mod => mod.id === 'modhub'),
            identityId: 'modhub', wikiName: 'ModHub模组管理中心',
            githubUrl: 'https://github.com/JohnLiao501/ModHub',
            githubUrls: ['https://github.com/JohnLiao501/ModHub', 'https://github.com/NEEDMEET/ModHub'],
            wikiVersion: '1.0.1', wikiDate: '2026-09-26',
            version: '1.0.2', versionSource: 'github', updateDate: '2026-09-27',
            releaseUrl: 'https://github.com/JohnLiao501/ModHub/releases/tag/v1.0.2',
            releaseCompatibility: [{ releaseTag: 'v1.0.1', gameVersionRange: '=0.5.10.12',
                evidenceUrl: 'https://github.com/JohnLiao501/ModHub/releases/tag/v1.0.1', dependencies: [] }]
        };
        const splitIndex = {
            schemaVersion: 1, catalogUpdatedAt: '2026-09-27T00:02:00.000Z',
            generatedAt: '2026-09-27T00:05:00.000Z', identities: catalog.mods, mods: [indexedMod]
        };
        const [normalizedMod] = market.normalizeReleaseIndex(splitIndex);
        for (const field of ['id', 'identityId', 'wikiVersion', 'wikiDate', 'version', 'versionSource', 'updateDate', 'releaseUrl', 'category']) {
            assert.equal(normalizedMod[field], indexedMod[field], `独立刷新索引必须保留 ${field}`);
        }
        assert.deepEqual(Array.from(normalizedMod.githubUrls), indexedMod.githubUrls, '必须保留 Wiki 原始仓库链接集合');
        assert.deepEqual(Array.from(normalizedMod.bootNames), indexedMod.bootNames, '独立刷新不得丢失模组身份名称');
        assert.equal(JSON.stringify(normalizedMod.releaseCompatibility), JSON.stringify(indexedMod.releaseCompatibility), 'v1 索引必须保留精确发布的兼容声明与空前置列表');
        assert.equal(splitIndex.catalogUpdatedAt, '2026-09-27T00:02:00.000Z', '归一化不得改写目录刷新时间');
        const assetVersionEntry = { ...indexedMod, version: '1.0.3', releaseAssetVersion: '1.0.3',
            releaseUrl: 'https://github.com/JohnLiao501/ModHub/releases/tag/9.26' };
        const [assetVersionMod] = market.normalizeReleaseIndex({ ...splitIndex, mods: [assetVersionEntry] });
        assert.equal(assetVersionMod.releaseAssetVersion, '1.0.3', 'v1 索引须保留可选的已核验附件版本字段');
        assert.equal(assetVersionMod.version, '1.0.3', '归一化不得用原始发布标签9.26覆盖已核验附件版号');
        assert.equal(assetVersionMod.releaseUrl, assetVersionEntry.releaseUrl, '已核验附件版号不得改写原始发布来源');
        assert.equal(normalizedMod.releaseAssetVersion, undefined, '不含附件版本字段的旧v1索引仍须正常消费');

        // 10.6 手动刷新绕过列表缓存，并重新验证各镜像的 HTTP 缓存
        const oldMod = { name: 'ModHub', version: '1.0.1', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [oldMod], timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '1.0.1', '普通加载应保留已有列表缓存');
        const requestedUrls = [];
        sb.fetch = async (url, options) => {
            requestedUrls.push(url);
            assert.equal(options.cache, 'no-cache', '索引请求必须重新验证 HTTP 缓存');
            if (url === market.RELEASE_INDEX_MIRRORS[0]) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: [{ ...oldMod, version: '1.0.2' }] }) };
        };
        assert.equal((await market.loadMarketData(true))[0].version, '1.0.2', '手动刷新必须取代内存和本地的旧版本列表');
        assert.deepEqual(requestedUrls, Array.from(market.RELEASE_INDEX_MIRRORS), '主镜像失效后必须继续尝试备用镜像');
    }

    // 社区外链默认只开放原帖；审核通过的精确 GitHub 发布源才可自动安装。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        const market = sb.modHubMarket;
        const sourceUrl = 'https://tieba.baidu.com/p/12345';
        const manual = {
            id: 'community-manual', name: '社区手动模组', description: '<img src=x onerror=alert(1)>',
            author: '作者', catalogSource: 'community', sourcePlatform: 'tieba',
            sourceUrl, otherUrl: sourceUrl, githubUrl: 'https://github.com/Other/Wrong',
            autoInstall: false, version: '9.0.0', versionSource: 'github', identityId: null,
            contentType: 'package', sources: [{ platform: 'tieba', url: sourceUrl }], packageRecords: [],
            category: '外观与资源', tags: ['美化']
        };
        const [external] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [manual] });
        assert.equal(external.githubUrl, null, '社区条目未获安装资格时不得使用投稿的 GitHub 仓库');
        assert.equal(market.checkModInstallStatus(external, []), 'external_only');
        assert.equal(market.checkModInstallStatus(external, [{ name: manual.name, version: '1.0.0', repository: 'https://github.com/Other/Else' }]),
            'external_only', '未核实身份的同名社区条目不能声称本地已安装');
        assert.equal(market.isBatchInstallEligible(external, []), false);
        assert.equal(external.identityId, null, '原帖条目不能虚构安装身份');
        assert.equal(external.category, manual.category, '已审批社区原帖的分类不依赖安装身份');
        assert.ok(external.tags.includes('美化'), '已审批原帖标签须保留以供检索');
        assert.equal(external.packageRecords.length, 0, '原帖条目不能虚构包体核验记录');
        assert.equal(external.sources[0].url, sourceUrl, '空包记录仍须保留来源访问');
        const [identified] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            ...manual, id: 'community-identified', identityId: 'verified-tech', bootNames: ['VerifiedTech']
        }] });
        assert.equal(market.checkModInstallStatus(identified, [{ name: 'VerifiedTech', version: '1.0.0' }]),
            'external_installed', '核实技术名后可显示已安装，但人工版本不能触发更新');

        const release = 'https://github.com/Owner/Verified/releases/tag/v2';
        const [approved] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            id: 'community-approved', identityId: 'verified-github', name: '已核验 GitHub 模组', catalogSource: 'community',
            repositoryKeys: ['Owner/Verified'], bootNames: ['VerifiedTech'],
            sourcePlatform: 'github', sourceUrl: release, otherUrl: release,
            githubUrl: release, autoInstall: true
        }] });
        assert.equal(approved.githubUrl, release, '已核验的精确发布源仍可沿用现有 GitHub 安装');
        assert.equal(market.isBatchInstallEligible(approved, []), true);
        const repositoryRoot = 'https://github.com/Owner/Verified';
        const [unscoped] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            id: 'community-unscoped', identityId: 'verified-github', name: '仓库根地址',
            repositoryKeys: ['Owner/Verified'], bootNames: ['VerifiedTech'],
            catalogSource: 'community', sourcePlatform: 'github', sourceUrl: repositoryRoot,
            githubUrl: repositoryRoot, autoInstall: true
        }] });
        assert.equal(unscoped.githubUrl, null, '社区安装资格必须指向明确的 GitHub Release 入口');
        const [wrongRepo] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            id: 'community-wrong-repo', identityId: 'verified-github', name: '错误仓库',
            repositoryKeys: ['Other/Repo'], bootNames: ['VerifiedTech'],
            catalogSource: 'community', sourcePlatform: 'github', sourceUrl: release,
            githubUrl: release, autoInstall: true
        }] });
        assert.equal(wrongRepo.githubUrl, null, '发布仓库必须属于已核验身份仓库');
        const [badLink] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            id: 'community-bad', name: '非法链接', catalogSource: 'community',
            sourcePlatform: 'tieba', sourceUrl: 'javascript:alert(1)', otherUrl: 'http://example.com/mod'
        }] });
        assert.equal(badLink.otherUrl, null, '市场外链必须是无凭据的 HTTPS URL');
        assert.equal(market.checkModInstallStatus(badLink, []), 'unavailable');
        const [catalogOnly] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            id: '惩罚礼顿-external', name: '惩罚礼顿++', author: 'lyjjl', description: '无来源的目录条目',
            catalogSource: 'community', sourcePlatform: 'catalog', sourceUrl: '', autoInstall: true,
            identityId: null, githubUrl: null, otherUrl: null
        }] });
        assert.equal(catalogOnly.sourceUrl, null, '目录型条目允许没有来源 URL，不构造虚假链接');
        assert.equal(catalogOnly.autoInstall, false, '无来源目录条目不能获得一键安装资格');
        assert.equal(market.checkModInstallStatus(catalogOnly, []), 'unavailable');

        loadScripts(sb, ['javascript/modhub-market-spells.js']);
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer',
            'modHubCategoryCapsules'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        sb.modHubEscapeHtml = value => String(value).replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [manual] }) });
        await sb.modHubInitMarket(true);
        const card = elements.get('modHubMarketCardsContainer').innerHTML;
        const toolbar = elements.get('modHubModMarketContainer').innerHTML;
        assert.ok(toolbar.includes('modHubMarketBtnSubmit') && toolbar.includes('modHubMarketBtnMy'), '市场必须提供游戏内投稿与查询入口');
        assert.ok(toolbar.includes('modHubMarketBtnFeedback'), '纠错与下架申请应共用一个入口');
        assert.ok(!toolbar.includes('issues/new'), '市场投稿不应再跳转 GitHub Issue');
        assert.ok(card.includes('modhub-market-source-link') && card.includes('>百度贴吧</a>') && !card.includes('>主页</a>'));
        assert.ok(!card.includes('btn-market-correct') && !card.includes('btn-market-withdraw'), '反馈入口不应挤占每张卡片的主操作区');
        assert.ok(!card.includes('一键更新') && !card.includes('已是最新') && !card.includes('<img src=x'), '外链卡片不能承诺自动更新，也不能渲染投稿 HTML');
        const opened = [];
        let feedbackMode = 'correct';
        sb.modHubConfirm = async options => {
            opened.push(options);
            if (opened.length === 1) return feedbackMode;
            if (opened.length === 2) {
                const search = { value: '', oninput: null };
                const select = { size: 0, value: '', children: [], replaceChildren() { this.children = []; },
                    appendChild(child) { this.children.push(child); } };
                const confirm = { disabled: false };
                options.onRender({ querySelector: selector => ({
                    '.modhub-feedback-search': search, '.modhub-modal-select': select,
                    '.modhub-modal-btn-confirm': confirm
                })[selector] });
                search.value = '没有结果';
                search.oninput();
                assert.equal(select.children.length, 1, '搜索无结果时不得保留旧目标');
                assert.equal(confirm.disabled, true, '搜索后必须重新选择目标');
                search.value = '作者';
                search.oninput();
                assert.equal(select.children.length, 2, '可按作者搜索完整目录');
                return '0';
            }
            return false;
        };
        await market.openCommunityFeedback();
        assert.equal(opened[2].title, '纠错', '公共入口应在选择类型和目标后打开对应表单');
        assert.ok(opened[1].selectOptions[1].label.includes(sourceUrl), '目标列表应显示原始来源以区分同名模组');
        opened.length = 0;
        feedbackMode = 'withdraw';
        let targetRequest = null;
        let blockedMessage = '';
        sb.modHubAlert = message => { blockedMessage = message; };
        sb.fetch = async (url, options) => {
            targetRequest = { path: new URL(url).pathname, body: JSON.parse(options.body) };
            return { ok: true, json: async () => ({ targetStatus: 'active', activeDelistStatus: 'pending', canRequestDelist: false }) };
        };
        await market.openCommunityFeedback();
        assert.equal(targetRequest.path, '/community-submissions/target-status', '下架入口必须向服务端确认目标当前状态');
        assert.equal(targetRequest.body.catalogId, 'community-manual');
        assert.ok(blockedMessage.includes('已有进行中的下架申请'));
        assert.equal(opened.length, 2, '已有下架申请时不得打开重复申请表单');

        const linkless = { id: '惩罚礼顿-external', name: '惩罚礼顿++', author: 'lyjjl',
            description: '目录中已有的无链接模组', identityId: null, githubUrl: null, otherUrl: null,
            catalogSource: 'community', sourcePlatform: 'catalog', sourceUrl: '', autoInstall: false };
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [linkless] }) });
        await sb.modHubInitMarket(true);
        assert.ok(elements.get('modHubMarketCardsContainer').innerHTML.includes('暂无来源链接'),
            '无来源目录条目不能误称出处已核验');
        opened.length = 0;
        sb.fetch = async (url, options) => {
            targetRequest = { path: new URL(url).pathname, body: JSON.parse(options.body) };
            return { ok: true, json: async () => ({ targetStatus: 'active', canRequestDelist: true }) };
        };
        await market.openCommunityFeedback();
        assert.equal(targetRequest.body.catalogId, linkless.id, '无链接下架申请仍绑定实际目录 ID');
        assert.equal(targetRequest.body.sourceUrl, '');
        assert.equal(targetRequest.body.targetName, linkless.name, '目标状态检查携带原目录名称防止旧缓存误选');
        assert.equal(targetRequest.body.targetAuthor, linkless.author);
        assert.equal(opened[2].title, '申请下架', '无来源条目可从公共入口进入下架表单');
        assert.ok(opened[2].trustedMessageHtml.includes('暂无来源链接，按目录条目核对'));
        feedbackMode = 'correct';
        opened.length = 0;
        await market.openCommunityFeedback();
        assert.equal(opened[2].title, '纠错', '无来源条目可从公共入口进入纠错表单');
        assert.ok(opened[2].trustedMessageHtml.includes('没有来源链接也可提交'));
    }

    // 下架快照按最大社区修订号更新；旧缓存不能复活下架条目，新修订可以恢复。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const sharedUrl = 'https://github.com/Owner/Shared/releases/tag/v1';
        const removed = { id: 'community-removed', catalogSource: 'community', name: '下架模组', sourceUrl: sharedUrl, otherUrl: sharedUrl };
        const active = { id: 'community-active', catalogSource: 'community', name: '同源在架模组', sourceUrl: sharedUrl, otherUrl: sharedUrl };
        const oldUrl = 'https://tieba.baidu.com/p/98765';
        const index = { schemaVersion: 1, communityRevision: 2, withdrawnIds: [removed.id], withdrawnUrls: [`${oldUrl}/#reply`], mods: [removed, active] };
        assert.deepEqual(Array.from(market.normalizeReleaseIndex(index), mod => mod.id), [active.id], '共享来源仅下架指定 id');
        const oldWiki = { name: '旧 Wiki 模组', otherUrl: oldUrl };
        assert.deepEqual(Array.from(market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 1, mods: [removed, active, oldWiki] }), mod => mod.name),
            [active.name], '旧索引及 Wiki 回退不能复活已下架来源');
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [removed, active, oldWiki], timestamp: 1 }));
        const requests = [];
        sb.fetch = async url => { requests.push(url); throw new Error('模拟离线'); };
        assert.deepEqual(Array.from(await market.loadMarketData(true), mod => mod.name), [active.name],
            '手动刷新离线时仍应优先使用经过下架过滤的最后成功缓存');
        assert.ok(!requests.some(url => String(url).includes('/w/api.php')), '已有成功缓存时无需退回 Wiki');
        loadScripts(sb, ['javascript/modhub-market.js']);
        assert.deepEqual(Array.from(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [removed, active, oldWiki] }), mod => mod.name),
            [active.name], '重启后仍保留下架墓碑');
        assert.deepEqual(Array.from(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 3,
            withdrawnIds: [], withdrawnUrls: [], mods: [removed, active, oldWiki] }), mod => mod.name),
            [removed.name, active.name, oldWiki.name], '新修订的完整快照可以恢复原下架条目');
        assert.deepEqual(Array.from(sb.modHubMarket.normalizeReleaseIndex(index), mod => mod.name),
            [removed.name, active.name], '恢复后旧镜像不能重新下架条目');
    }

    // 无链接墓碑保留原目录指纹；Wiki 重用同一编号时不能被旧缓存误隐藏。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const old = { id: '惩罚礼顿-external', name: '惩罚礼顿++', author: 'lyjjl',
            sourceUrl: null, githubUrl: null, otherUrl: null };
        const target = { id: old.id, wikiName: old.name, wikiAuthor: old.author };
        market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 4, withdrawnIds: [old.id], mods: [] });
        const nextAuthor = { ...old, author: '新作者' };
        assert.deepEqual(Array.from(market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 4,
            withdrawnIds: [], withdrawnCatalogTargets: [target], mods: [old, nextAuthor] }), mod => mod.author),
            ['新作者'], '相同修订也须接入目录指纹，旧 ID 不能误下架同名新作者');
        assert.deepEqual(Array.from(market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 3,
            mods: [old, nextAuthor] }), mod => mod.author), ['新作者'], '旧镜像不清空目录指纹');
        const idlessOld = { name: old.name, author: old.author };
        const idlessNew = { name: old.name, author: nextAuthor.author };
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [idlessOld, idlessNew], timestamp: 1 }));
        sb.fetch = async () => { throw new Error('模拟无链接条目离线'); };
        assert.deepEqual(Array.from(await market.loadMarketData(true), mod => mod.author), ['新作者'],
            '没有目录 ID 的 Wiki 回退也按原名称与作者过滤，避免复活旧条目');
        loadScripts(sb, ['javascript/modhub-market.js']);
        assert.deepEqual(Array.from(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [old, nextAuthor] }),
            mod => mod.author), ['新作者'], '重启后原目标指纹仍生效');
        assert.equal(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [
            { ...old, sourceUrl: 'https://tieba.baidu.com/p/123' }
        ] }).length, 1, '原无来源墓碑不能误隐藏后来有来源的条目');
        assert.equal(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 5,
            withdrawnIds: [], withdrawnCatalogTargets: [], mods: [old] }).length, 1, '新修订恢复上架清理原目录墓碑');
        assert.throws(() => sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1,
            withdrawnCatalogTargets: {}, mods: [] }), /格式异常/);
    }

    // 原生投稿表单持久化查询凭证；挑战消息须核对来源、窗口与 nonce。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        sb.crypto = require('node:crypto').webcrypto;
        sb.btoa = value => Buffer.from(value, 'binary').toString('base64');
        let listener = null;
        sb.addEventListener = (name, handler) => { if (name === 'message') listener = handler; };
        sb.removeEventListener = (name, handler) => { if (name === 'message' && listener === handler) listener = null; };
        const opened = [];
        function makeDialog() {
            const inputs = Object.fromEntries(Object.entries({ name: 100, author: 100, sourceUrl: 1000, description: 1000, notes: 1000 })
                .map(([name, maxLength]) => [name, { value: '', maxLength, disabled: false, addEventListener() {} }]));
            const form = { elements: { namedItem: name => inputs[name] }, onsubmit: null };
            const frame = { src: '', contentWindow: {}, dataset: {} };
            const result = { hidden: true };
            const resultTitle = { textContent: '' };
            const status = { textContent: '' };
            const receipt = { textContent: '' };
            const submit = { disabled: false, textContent: '' };
            const queryInput = { value: '' };
            const query = { disabled: false, onclick: null };
            const saved = createStubElement();
            saved.replaceChildren = () => { saved.children = []; };
            const detail = createStubElement();
            detail.replaceChildren = () => { detail.children = []; };
            const search = { value: '', oninput: null };
            const filter = { value: '', onchange: null };
            const refreshPage = { disabled: false, onclick: null };
            const previousPage = { disabled: false, onclick: null };
            const nextPage = { disabled: false, onclick: null };
            const pageLabel = { textContent: '' };
            const nodes = {
                '.modhub-community-form': form, '.modhub-community-challenge': frame,
                '.modhub-community-result': result, '.modhub-community-status': status,
                '.modhub-community-result-title': resultTitle,
                '.modhub-community-receipt': receipt, '.modhub-community-submit': submit,
                '.modhub-community-copy': {}, '.modhub-community-query-input': queryInput,
                '.modhub-community-query': query, '.modhub-community-saved': saved,
                '.modhub-community-detail': detail,
                '.modhub-community-search': search, '.modhub-community-filter': filter,
                '.modhub-community-refresh-page': refreshPage, '.modhub-community-prev': previousPage,
                '.modhub-community-next': nextPage, '.modhub-community-page': pageLabel,
                '.modhub-community-actions': { appendChild() {} },
                '.modhub-modal-btn-confirm': {}, '.modhub-modal-footer': { remove() {} },
                '.modhub-community-challenge-wrap': { hidden: false }
            };
            return { inputs, form, frame, result, resultTitle, status, receipt, submit, queryInput, query, saved, detail,
                search, filter, refreshPage, previousPage, nextPage, pageLabel,
                dialog: { querySelector: selector => nodes[selector], addEventListener() {} } };
        }
        sb.modHubConfirm = options => new Promise(resolve => {
            const current = makeDialog();
            current.close = resolve;
            current.html = options.trustedMessageHtml;
            current.options = options;
            opened.push(current);
            options.onRender?.(current.dialog);
        });
        const origin = new URL(market.RELEASE_WORKER_API_BASE).origin;
        let attempts = 0;
        let queriedStatus = 'needs_info';
        let queriedKind = 'add';
        let queriedApprovedKind = '';
        let queriedPublished = false;
        let queriedTargetStatus = '';
        let queriedActiveDelistStatus = '';
        let queriedCanRequestDelist = false;
        let queriedDuplicate = false;
        let queryErrorStatus = 0;
        const posted = [];
        sb.fetch = async (url, options) => {
            const path = new URL(url).pathname;
            const body = JSON.parse(options.body);
            posted.push({ path, body });
            if (path === '/community-submissions') {
                attempts++;
                if (attempts === 1) throw new Error('模拟响应丢失');
                return { ok: true, json: async () => ({ id: 'sub-1', revision: 1, status: 'pending' }) };
            }
            if (path === '/community-submissions/query') {
                if (queryErrorStatus) return { ok: false, status: queryErrorStatus,
                    json: async () => ({ error: '投稿记录不存在' }) };
                return { ok: true, json: async () => ({ id: 'sub-1', kind: queriedKind, catalogId: 'community-a',
                    name: '测试模组', author: '作者', sourceUrl: 'https://tieba.baidu.com/p/123',
                    description: '简介', notes: '', revision: queriedStatus === 'withdrawn' ? 2 : 1,
                    status: queriedStatus, approvedCatalogId: queriedStatus === 'approved' || queriedPublished ? 'community-a' : null,
                    approvedKind: queriedApprovedKind || null,
                    targetStatus: queriedTargetStatus || null, activeDelistStatus: queriedActiveDelistStatus || null,
                    canRequestDelist: queriedCanRequestDelist,
                    ...(queriedDuplicate ? { duplicateOf: 'older-submission', mergedProgress: { status: 'pending', updatedAt: '2026-09-29T00:00:00Z' } } : {}) }) };
            }
            if (path === '/community-submissions/query-batch') return { ok: true, json: async () => ({
                results: body.receipts.map((value, index) => ({ index, submission: {
                    id: `batch-${index}-${value.slice(0, 4)}`, kind: 'add', name: `批量记录 ${index + 1}`,
                    status: 'pending', revision: 1, updatedAt: '2026-09-29T00:00:00Z',
                    targetStatus: null, activeDelistStatus: null, canRequestDelist: false
                } }))
            }) };
            if (path === '/community-submissions/amend') return { ok: true, json: async () => ({ id: 'sub-1', revision: 2, status: 'pending' }) };
            if (path === '/community-submissions/withdraw') {
                queriedStatus = 'withdrawn';
                return { ok: true, json: async () => ({ id: 'sub-1', revision: 2, status: 'withdrawn' }) };
            }
            if (path === '/community-submissions/delete') return { ok: true, json: async () => ({ id: 'sub-1', deleted: true }) };
            throw new Error('意外请求');
        };
        const firstTask = market.openCommunitySubmission('new');
        const first = opened.at(-1);
        assert.ok(first.html.includes('<form') && first.html.includes('modhub-community-challenge')
            && !first.html.includes('community-submit?'), '玩家表单必须留在游戏原生弹窗');
        assert.ok(first.html.includes('modhub-community-fields') && first.html.includes('modhub-community-safety')
            && first.html.includes('title="安全验证"') && !first.html.includes('投稿验证'), '填写区单独滚动，验证提示统一为安全验证');
        assert.equal(new URL(first.frame.src).searchParams.get('embedded'), '1', '嵌入验证页不能重复显示提示');
        Object.assign(first.inputs.name, { value: '测试模组' });
        Object.assign(first.inputs.author, { value: '作者' });
        Object.assign(first.inputs.sourceUrl, { value: 'https://tieba.baidu.com/p/123' });
        Object.assign(first.inputs.description, { value: '简介' });
        let nonce = new URL(first.frame.src).searchParams.get('nonce');
        listener({ origin: 'https://evil.example', source: first.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '伪造' } });
        listener({ origin, source: {}, data: { type: 'modHubCommunityChallenge', nonce, token: '伪造' } });
        listener({ origin, source: first.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce: 'wrong', token: '伪造' } });
        await first.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.length, 0, '伪造挑战消息不得触发投稿');
        listener({ origin, source: first.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '真实挑战' } });
        listener({ origin, source: first.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: null } });
        assert.equal(first.submit.disabled, true, '安全验证过期时应禁用提交');
        await first.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.length, 0, '验证过期必须清空旧 token');
        listener({ origin, source: first.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '新挑战' } });
        await first.form.onsubmit({ preventDefault() {} });
        const receipt = posted[0].body.receipt;
        assert.match(receipt, /^[A-Za-z0-9_-]{43}$/);
        assert.ok(first.status.textContent.includes('模拟响应丢失'), '提交失败的具体原因应留在外层状态区');
        assert.equal(JSON.parse(sb.localStorage.getItem('modhub_market_submission_drafts_v1'))['new:'].pending.receipt, receipt,
            '响应丢失后原查询凭证须保留在本机');
        assert.ok(!sb.localStorage.getItem('modhub_market_submission_drafts_v1').includes('新挑战'), '挑战 token 不得落盘');
        first.close(false);
        await firstTask;
        assert.equal(listener, null, '关闭弹窗须解绑挑战监听');

        const retryTask = market.openCommunitySubmission('new');
        const retry = opened.at(-1);
        assert.equal(retry.inputs.name.value, '测试模组', '重开时恢复原申请内容');
        assert.equal(retry.inputs.name.disabled, true, '未确认申请锁定内容以保证幂等重试');
        assert.ok(retry.status.textContent.includes('上次提交结果尚未确认'), '待确认投稿重开后保留风险提示');
        nonce = new URL(retry.frame.src).searchParams.get('nonce');
        listener({ origin, source: retry.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '重试挑战' } });
        await retry.form.onsubmit({ preventDefault() {} });
        assert.equal(posted[1].body.receipt, receipt, '超时重试须使用同一查询凭证');
        assert.equal(retry.receipt.textContent, receipt, '成功后游戏内显示可复制凭证');
        assert.ok(retry.html.includes('<details>') && retry.html.includes('查看完整查询凭证'), '完整凭证默认收进显式展开区');
        assert.equal(retry.resultTitle.textContent, '投稿已保存到本机');
        const savedSubmission = JSON.parse(sb.localStorage.getItem('modhub_market_submission_receipts_v1'))[0];
        assert.equal(savedSubmission.name, '测试模组', '新记录应保存可读名称摘要');
        assert.equal(savedSubmission.kind, 'add', '新记录应保存申请类型摘要');
        const successStatus = retry.status.textContent;
        listener({ origin, source: retry.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: null } });
        assert.equal(retry.status.textContent, successStatus, '验证回调不能覆盖提交成功提示');
        retry.close(false);
        await retryTask;

        const legacyRecords = JSON.parse(sb.localStorage.getItem('modhub_market_submission_receipts_v1'));
        for (let index = 1; index <= 11; index++) {
            legacyRecords.push({ id: `legacy-${index}`, receipt: Buffer.alloc(32, index).toString('base64url') });
        }
        sb.localStorage.setItem('modhub_market_submission_receipts_v1', JSON.stringify(legacyRecords));
        const myTask = market.openCommunitySubmission('my');
        const mine = opened.at(-1);
        assert.ok(mine.html.includes('modhub-community-search') && mine.html.includes('modhub-community-filter'),
            '投稿较多时提供名称搜索与状态筛选');
        assert.ok(mine.html.includes('<details class="modhub-community-backup">'), '查询凭证入口默认收进备份与恢复区');
        assert.equal(mine.saved.children.length, 10, '我的投稿每页最多显示十条');
        assert.ok(mine.pageLabel.textContent.includes('共 12 条'));
        mine.nextPage.onclick();
        assert.equal(mine.saved.children.length, 2, '下一页显示剩余记录');
        mine.previousPage.onclick();
        mine.search.value = '测试模组';
        mine.search.oninput();
        assert.equal(mine.saved.children.length, 1, '名称搜索只保留匹配投稿');
        mine.search.value = '';
        mine.search.oninput();
        await mine.refreshPage.onclick();
        assert.equal(posted.at(-1).path, '/community-submissions/query-batch', '刷新本页使用最多十条的批量查询');
        assert.equal(posted.at(-1).body.receipts.length, 10);
        mine.queryInput.value = receipt;
        await mine.query.onclick();
        assert.equal(posted.at(-1).path, '/community-submissions/query', '允许手动输入凭证查询');
        const refreshedLocal = JSON.parse(sb.localStorage.getItem('modhub_market_submission_receipts_v1'))
            .find(item => item.receipt === receipt);
        assert.equal(refreshedLocal.name, '测试模组', '旧记录查询成功后补齐可读摘要');
        assert.ok(refreshedLocal.queriedAt > 0, '缓存状态记录最近查询时间');
        assert.ok(mine.detail.children.some(child => child.textContent === '补充资料'), '待补充投稿提供补充入口');
        const clickAction = button => button.onclick ? button.onclick() : button._listeners.click[0]({ preventDefault() {} });
        const retractButton = mine.detail.children.find(child => child.textContent === '撤回投稿');
        assert.ok(retractButton, '待审核投稿提供撤回入口');
        assert.ok(mine.detail.children.some(child => child.textContent === '删除推荐'), '待审核推荐提供删除入口');
        const canceled = clickAction(retractButton);
        assert.equal(opened.at(-1).options.confirmType, 'danger', '撤回须先在暗黑对话框确认');
        opened.at(-1).close(false);
        await canceled;
        assert.equal(posted.at(-1).path, '/community-submissions/query', '取消撤回不能发请求');
        const retracting = clickAction(retractButton);
        opened.at(-1).close(true);
        await retracting;
        assert.equal(posted.at(-1).path, '/community-submissions/withdraw');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1).body)), { receipt, revision: 1 });
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent === '删除推荐'), '撤回后仍可删除推荐');
        assert.ok(!mine.detail.children.some(child => child.textContent === '补充资料'), '撤回后不得继续补充');
        const deleting = clickAction(mine.detail.children.find(child => child.textContent === '删除推荐'));
        assert.equal(opened.at(-1).options.confirmType, 'danger', '删除须先在暗黑对话框确认');
        opened.at(-1).close(true);
        await deleting;
        assert.equal(posted.at(-1).path, '/community-submissions/delete');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1).body)), { receipt, revision: 2 });
        assert.equal(mine.detail.children.length, 0, '删除后清空投稿详情');
        assert.ok(!sb.localStorage.getItem('modhub_market_submission_receipts_v1').includes(receipt),
            '删除后移除本机查询凭证');
        queriedStatus = 'approved';
        queriedTargetStatus = 'active';
        queriedCanRequestDelist = true;
        const approvedReceipt = Buffer.alloc(32, 19).toString('base64url');
        sb.localStorage.setItem('modhub_market_submission_drafts_v1', JSON.stringify({ manual: {
            pending: { receipt: approvedReceipt, payload: { name: '测试模组', kind: 'add' } }
        } }));
        mine.queryInput.value = approvedReceipt;
        await mine.query.onclick();
        assert.ok(!sb.localStorage.getItem('modhub_market_submission_drafts_v1').includes(approvedReceipt),
            '手动凭证查询成功后保存正式记录并清理匹配的待确认草稿');
        assert.ok(!mine.detail.children.some(child => child.textContent === '删除推荐'), '已批准推荐不能直接删除');
        const delistButton = mine.detail.children.find(child => child.textContent === '申请下架');
        assert.ok(delistButton, '已批准推荐提供下架申请入口');
        const delisting = clickAction(delistButton);
        const delist = opened.at(-1);
        assert.ok(delist.html.includes('提交下架申请'));
        assert.ok(delist.html.includes('下架原因') && !delist.html.includes('<label>模组名称'), '下架表单仅让玩家填写原因');
        assert.equal(delist.inputs.name.value, '测试模组');
        assert.equal(delist.inputs.name.disabled, true, '下架目标基础资料必须锁定');
        assert.equal(delist.inputs.notes.disabled, false);
        delist.close(false);
        await delisting;
        queriedActiveDelistStatus = 'pending';
        queriedCanRequestDelist = false;
        await mine.query.onclick();
        assert.ok(!mine.detail.children.some(child => child.textContent === '申请下架'), '已有进行中下架申请时不得重复显示入口');
        assert.ok(mine.detail.children.some(child => child.textContent.includes('下架申请：待审核')));
        queriedStatus = 'pending';
        queriedTargetStatus = '';
        queriedActiveDelistStatus = '';
        queriedDuplicate = true;
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent.includes('已归并到较早的申请')),
            '归并副单显示主申请进度');
        assert.ok(!mine.detail.children.some(child => ['补充资料', '撤回投稿', '删除推荐'].includes(child.textContent)),
            '归并副单不得提供会产生无效写入的操作');
        queriedDuplicate = false;
        queriedKind = 'withdraw';
        queriedStatus = 'approved';
        queriedTargetStatus = 'withdrawn';
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent.includes('下架申请已通过')),
            '已批准的下架申请使用明确状态文案');
        queriedKind = 'correct';
        queriedApprovedKind = 'withdraw';
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent.includes('下架申请已通过')),
            '纠错投稿批准下架时按实际审核动作显示');
        assert.ok(JSON.parse(sb.localStorage.getItem('modhub_market_submission_receipts_v1'))
            .some(record => record.approvedKind === 'withdraw'), '实际审核动作须保存到本机记录');
        queriedApprovedKind = 'restore';
        queriedTargetStatus = 'active';
        queriedCanRequestDelist = true;
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent.includes('恢复上架已通过')),
            '原始投稿类型不能遮盖后续恢复上架结果');
        queriedPublished = true;
        queriedStatus = 'needs_info';
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent === '补充资料'),
            '曾批准的申请退回补充后仍可补充草稿');
        assert.ok(!mine.detail.children.some(child => ['撤回投稿', '删除投稿'].includes(child.textContent)),
            '退回补充不解锁已执行目录操作记录的撤回或删除');
        queriedStatus = 'rejected';
        await mine.query.onclick();
        assert.ok(mine.detail.children.some(child => child.textContent === '当前目录状态：仍在架'),
            '后续拒绝不隐藏仍在架条目的真实目录状态');
        assert.ok(mine.detail.children.some(child => child.textContent === '申请下架'),
            '曾批准后又拒绝的申请仍可按当前目录状态申请下架');
        assert.ok(!mine.detail.children.some(child => child.textContent === '删除投稿'),
            '后续拒绝不能让玩家删除已发布记录');
        queryErrorStatus = 404;
        await mine.query.onclick();
        const removeLocal = mine.detail.children.find(child => child.textContent === '从本机移除');
        assert.ok(removeLocal, '服务端已不存在的投稿允许只移除本机记录');
        const removingLocal = clickAction(removeLocal);
        opened.at(-1).close(true);
        await removingLocal;
        assert.ok(!sb.localStorage.getItem('modhub_market_submission_receipts_v1').includes(approvedReceipt));
        mine.close(false);
        await myTask;

        const row = { id: 'sub-1', kind: 'add', catalogId: 'community-a', name: '测试模组', author: '作者',
            sourceUrl: 'https://tieba.baidu.com/p/123', description: '简介', notes: '', revision: 1 };
        const amendTask = market.openCommunitySubmission('amend', row, receipt);
        const amend = opened.at(-1);
        nonce = new URL(amend.frame.src).searchParams.get('nonce');
        listener({ origin, source: amend.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '补充挑战' } });
        await amend.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).path, '/community-submissions/amend', '补充资料调用修订接口');
        assert.equal(posted.at(-1).body.revision, 1, '补充资料必须带审核修订号');
        amend.close(false);
        await amendTask;

        const withdrawAmendTask = market.openCommunitySubmission('amend', {
            ...row, kind: 'withdraw', author: '', description: '', notes: '下架原因', approvedCatalogId: 'community-a'
        }, receipt);
        const withdrawAmend = opened.at(-1);
        assert.ok(withdrawAmend.html.includes('<label>作者') && withdrawAmend.html.includes('<label>简介'),
            '下架类别退回补充后须允许补齐其他审核动作需要的基础资料');
        assert.equal(withdrawAmend.inputs.author.disabled, false);
        assert.equal(withdrawAmend.inputs.description.disabled, false);
        assert.equal(withdrawAmend.inputs.sourceUrl.disabled, true, '补充已审核或目标固定的申请不能改来源');
        withdrawAmend.inputs.author.value = '补充作者';
        withdrawAmend.inputs.description.value = '补充简介';
        nonce = new URL(withdrawAmend.frame.src).searchParams.get('nonce');
        listener({ origin, source: withdrawAmend.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '下架补充挑战' } });
        await withdrawAmend.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).path, '/community-submissions/amend');
        assert.equal(posted.at(-1).body.author, '补充作者');
        assert.equal(posted.at(-1).body.description, '补充简介');
        withdrawAmend.close(false);
        await withdrawAmendTask;

        sb.innerWidth = 320;
        const correctTask = market.openCommunitySubmission('correct', {
            id: 'community-target', name: '待纠错模组', author: '作者',
            sourceUrl: 'https://tieba.baidu.com/p/123', description: '原简介'
        });
        const correct = opened.at(-1);
        assert.equal(new URL(correct.frame.src).searchParams.get('size'), 'compact', '窄屏验证控件应选紧凑尺寸');
        nonce = new URL(correct.frame.src).searchParams.get('nonce');
        listener({ origin, source: correct.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '纠错挑战' } });
        await correct.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).body.catalogId, 'community-target', '纠错必须绑定实际目录条目 ID');
        assert.equal(posted.at(-1).body.kind, 'correct');
        correct.close(false);
        await correctTask;

        const linkless = { id: '惩罚礼顿-external', name: '惩罚礼顿++', author: 'lyjjl', description: '目录简介' };
        const noSourceCorrectTask = market.openCommunitySubmission('correct', linkless);
        const noSourceCorrect = opened.at(-1);
        assert.equal(noSourceCorrect.inputs.sourceUrl.value, '');
        assert.equal(noSourceCorrect.inputs.sourceUrl.disabled, true, '纠错来源由目录绑定，不要求用户补造链接');
        noSourceCorrect.inputs.name.value = '惩罚礼顿修正显示名';
        noSourceCorrect.inputs.description.value = '纠正后的简介';
        nonce = new URL(noSourceCorrect.frame.src).searchParams.get('nonce');
        listener({ origin, source: noSourceCorrect.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '无来源纠错挑战' } });
        const beforeInvalidSource = posted.length;
        noSourceCorrect.inputs.sourceUrl.value = 'http://invalid.example/mod';
        await noSourceCorrect.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.length, beforeInvalidSource, '即使目标反馈允许空来源，也不能提交非 HTTPS 链接');
        noSourceCorrect.inputs.sourceUrl.value = '';
        await noSourceCorrect.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).body.kind, 'correct');
        assert.equal(posted.at(-1).body.catalogId, linkless.id);
        assert.equal(posted.at(-1).body.sourceUrl, '');
        assert.equal(posted.at(-1).body.targetName, linkless.name, '可编辑的纠错正文不能替换原目标指纹');
        assert.equal(posted.at(-1).body.targetAuthor, linkless.author);
        assert.equal(posted.at(-1).body.name, '惩罚礼顿修正显示名');
        assert.equal(posted.at(-1).body.description, '纠正后的简介');
        noSourceCorrect.close(false);
        await noSourceCorrectTask;

        const noSourceWithdrawTask = market.openCommunitySubmission('withdraw', {
            ...linkless, name: '更正后的目录显示名', author: '更正后的作者显示',
            catalogTarget: { id: linkless.id, wikiName: linkless.name, wikiAuthor: linkless.author }
        });
        const noSourceWithdraw = opened.at(-1);
        noSourceWithdraw.inputs.notes.value = '没有公开发布版，申请下架';
        nonce = new URL(noSourceWithdraw.frame.src).searchParams.get('nonce');
        listener({ origin, source: noSourceWithdraw.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '无来源下架挑战' } });
        await noSourceWithdraw.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).body.kind, 'withdraw');
        assert.equal(posted.at(-1).body.catalogId, linkless.id);
        assert.equal(posted.at(-1).body.sourceUrl, '');
        assert.equal(posted.at(-1).body.targetName, linkless.name, '更正后的目录仍携带原 Wiki 名称');
        assert.equal(posted.at(-1).body.targetAuthor, linkless.author, '更正后的目录仍携带原 Wiki 作者');
        noSourceWithdraw.close(false);
        await noSourceWithdrawTask;

        const emptyOriginalAuthorTask = market.openCommunitySubmission('withdraw', {
            ...linkless, author: '已审核补上的展示作者', wikiName: linkless.name, wikiAuthor: null
        });
        const emptyOriginalAuthor = opened.at(-1);
        emptyOriginalAuthor.inputs.notes.value = '核对原无作者目录条目';
        nonce = new URL(emptyOriginalAuthor.frame.src).searchParams.get('nonce');
        listener({ origin, source: emptyOriginalAuthor.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '原作者为空挑战' } });
        await emptyOriginalAuthor.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.at(-1).body.targetAuthor, '', '原 Wiki 作者为空时不能回退到已更正的展示作者');
        emptyOriginalAuthor.close(false);
        await emptyOriginalAuthorTask;

        const missingNewSourceTask = market.openCommunitySubmission('new');
        const missingNewSource = opened.at(-1);
        missingNewSource.inputs.name.value = '新推荐';
        missingNewSource.inputs.author.value = '作者';
        missingNewSource.inputs.description.value = '简介';
        nonce = new URL(missingNewSource.frame.src).searchParams.get('nonce');
        listener({ origin, source: missingNewSource.frame.contentWindow,
            data: { type: 'modHubCommunityChallenge', nonce, token: '无来源推荐挑战' } });
        const beforeMissingNewSource = posted.length;
        await missingNewSource.form.onsubmit({ preventDefault() {} });
        assert.equal(posted.length, beforeMissingNewSource, '新推荐仍必须提供有效来源');
        assert.ok(missingNewSource.status.textContent.includes('推荐模组须填写'));
        missingNewSource.close(false);
        await missingNewSourceTask;
    }

    // 社区自动安装必须先拿到权威 Worker 的实时审核确认。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        sb.modHubShowToast = () => {};
        const release = 'https://github.com/Owner/Verified/releases/tag/v1';
        const entry = { id: 'community-install-check', identityId: 'verified-tech', name: '待重验模组',
            catalogSource: 'community', sourcePlatform: 'github', sourceUrl: release, githubUrl: release,
            repositoryKeys: ['Owner/Verified'], bootNames: ['VerifiedTech'], autoInstall: true, version: '1.0.0' };
        const [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 1, mods: [entry] });
        let requests = 0;
        sb.fetch = async (url, options) => {
            requests++;
            assert.equal(url, `${market.RELEASE_WORKER_API_BASE}/release-index.json`, '安装只查询权威 Worker');
            assert.equal(options.cache, 'no-store', '安装重验不得使用浏览器缓存');
            return { ok: true, headers: { get: () => '0' }, json: async () => ({ schemaVersion: 1, communityRevision: 1, mods: [entry] }) };
        };
        assert.equal(await market.downloadAndInstallMod(mod), false, 'Worker 未确认 D1 最新修订时须停止自动安装');
        assert.equal(requests, 1);
        sb.fetch = async () => ({ ok: true, headers: { get: () => '1' }, json: async () => ({
            schemaVersion: 1, communityRevision: 2, withdrawnIds: [entry.id], mods: [entry]
        }) });
        assert.equal(await market.downloadAndInstallMod(mod), false, '审核下架后旧市场卡片不得继续安装');
    }

    // README 在线线路失败后使用官方 API 或最后成功缓存，不能无限等待网络。
    {
        const sb = loadMarket();
        sb.atob = atob;
        sb.TextDecoder = TextDecoder;
        const market = sb.modHubMarket;
        const repository = 'https://github.com/Owner/Readme';
        const cacheKey = 'modhub_market_readme_v1_owner/readme';
        const markdown = '# 中文说明\n\n离线时仍可阅读。';
        const payload = {
            markdown, sourceUrl: `${repository}/blob/main/docs/README.md`,
            downloadUrl: 'https://raw.githubusercontent.com/Owner/Readme/main/docs/README.md'
        };
        const requests = [];
        sb.fetch = async url => {
            requests.push(url);
            return { ok: true, status: 200, json: async () => payload };
        };
        assert.equal(await market.fetchGithubReadme('https://example.test/Owner/Readme'), null, '非 GitHub 仓库不得触发请求');
        assert.equal((await market.fetchGithubReadme(repository)).markdown, markdown);
        assert.equal(new URL(requests[0]).origin, market.RELEASE_WORKER_API_BASE, 'README 只能使用已实现该路由的服务，不能假定网站镜像提供代理');
        assert.equal((await market.fetchGithubReadme(repository.toLowerCase())).fromCache, true, '同仓库大小写不同也应复用成功缓存');
        assert.equal(requests.length, 1, '有效缓存期间重复点选不得重复联网');

        const previous = { data: payload, timestamp: 1 };
        sb.localStorage.setItem(cacheKey, JSON.stringify(previous));
        sb.fetch = async url => { requests.push(url); throw new Error('模拟直连离线'); };
        const offline = await market.fetchGithubReadme(repository);
        assert.equal(offline.markdown, markdown);
        assert.equal(offline.isStale, true, '两条线路均失败后须标明最后成功缓存');
        assert.equal(JSON.parse(sb.localStorage.getItem(cacheKey)).timestamp, 1, '离线读取不能把旧缓存伪装为新文档');
        assert.equal(requests.at(-1), 'https://api.github.com/repos/Owner/Readme/readme', '代理不可达后必须尝试官方 API');

        sb.fetch = async (url, options) => {
            if (!url.startsWith('https://api.github.com/')) throw new Error('模拟 workers.dev 不可达');
            assert.equal(options.headers.Accept, 'application/vnd.github+json');
            return { ok: true, status: 200, json: async () => ({
                encoding: 'base64', content: Buffer.from(markdown).toString('base64'),
                html_url: payload.sourceUrl, download_url: payload.downloadUrl
            }) };
        };
        const direct = await market.fetchGithubReadme(repository);
        assert.equal(direct.markdown, markdown, '官方 API 的 Base64 必须按 UTF-8 解码中文');
        assert.equal(direct.sourceUrl, payload.sourceUrl);
        assert.equal(direct.downloadUrl, payload.downloadUrl, '必须保留 README 真实路径供相对图片解析');
        assert.notEqual(direct.isStale, true, '直连成功必须替换过期缓存');

        sb.localStorage.removeItem(cacheKey);
        sb.fetch = async url => ({ ok: true, status: 200, json: async () => url.startsWith('https://api.github.com/') ? {
            encoding: 'base64', content: Buffer.from(markdown).toString('base64'),
            html_url: 'https://github.com/Other/Repo/blob/main/README.md',
            download_url: 'https://raw.githubusercontent.com/Other/Repo/main/README.md'
        } : {} });
        const safeSources = await market.fetchGithubReadme(repository);
        assert.equal(safeSources.sourceUrl, repository, 'API 不得把说明来源指向其他仓库');
        assert.equal(safeSources.downloadUrl, '', 'API 不得把相对图片基址指向其他仓库');

        sb.localStorage.setItem(cacheKey, JSON.stringify(previous));
        sb.fetch = async () => ({ ok: false, status: 404 });
        assert.equal(await market.fetchGithubReadme(repository), null, '明确不存在的 README 不应被过期缓存冒充');
        sb.localStorage.removeItem(cacheKey);
        sb.fetch = async () => { throw new Error('模拟完全离线'); };
        await assert.rejects(market.fetchGithubReadme(repository), /模拟完全离线/, '无缓存时保留失败状态，交由说明页提示');

        // 无 AbortController 的旧浏览器、响应体挂起都必须在两次受控超时后结束。
        for (const waitingForBody of [false, true]) {
            const timers = [];
            let cleared = 0, aborted = 0;
            sb.AbortController = waitingForBody ? class {
                signal = {};
                abort() { aborted++; }
            } : undefined;
            sb.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timers.push(callback); return timers.length; };
            sb.clearTimeout = () => { cleared++; };
            sb.fetch = async () => waitingForBody
                ? { ok: true, status: 200, json: () => new Promise(() => {}) }
                : new Promise(() => {});
            const pending = assert.rejects(market.fetchGithubReadme(repository), /获取超时/);
            for (let source = 0; source < 2; source++) {
                await new Promise(setImmediate);
                assert.equal(timers.length, source + 1, '每条请求线路都必须安装超时计时器');
                timers[source]();
            }
            await pending;
            assert.equal(cleared, 2, '无论超时还是失败都必须清理两条线路的计时器');
            assert.equal(aborted, waitingForBody ? 2 : 0, '支持 AbortController 时还必须中断实际请求');
        }
    }

    // 统一索引已更新时，安装预检与下载共用的 Release 缓存不能选择旧安装包
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const mod = { name: 'ModHub', version: '1.0.2', githubUrl: 'https://github.com/JohnLiao501/ModHub' };
        const cacheKey = 'modhub_market_rel_v2_JohnLiao501_ModHub';
        let cache = {
            version: '1.0.1', assetPlanVersion: 2, assetPlanGameVersion: '',
            assets: [{ name: 'ModHub-v1.0.1.zip', downloadUrl: `${mod.githubUrl}/releases/download/v1.0.1/ModHub-v1.0.1.zip` }]
        };
        const writeCache = version => sb.localStorage.setItem(cacheKey, JSON.stringify({ data: { ...cache, version }, timestamp: Date.now() }));
        writeCache('1.0.1');
        let requestCount = 0;
        sb.fetch = async () => {
            requestCount++;
            return { ok: true, status: 200, json: async () => ({
                tag_name: 'v1.0.2', name: 'v1.0.2', assets: [{
                    name: 'ModHub-v1.0.2.zip',
                    browser_download_url: `${mod.githubUrl}/releases/download/v1.0.2/ModHub-v1.0.2.zip`
                }]
            }) };
        };
        const release = await market.fetchModRelease(mod);
        assert.equal(release.version, '1.0.2', '低于市场版本的 Release 缓存必须被重新获取');
        assert.equal(requestCount, 1, '跳过旧缓存后必须请求 GitHub');
        assert.ok(release.assetUrl.endsWith('/ModHub-v1.0.2.zip'), '安装包地址必须来自新 Release');
        assert.equal((await market.fetchModRelease(mod)).fromCache, true, '不低于市场版本的缓存仍可复用');
        assert.equal(requestCount, 1, '可用缓存不得产生额外请求');

        sb.fetch = async () => { throw new Error('模拟 GitHub 离线'); };
        writeCache('1.0.2');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, '旧资产选择规则缓存即使版本一致也不得离线复用');
        cache = { ...release };
        writeCache('1.0.1');
        await assert.rejects(market.fetchModRelease(mod), /模拟 GitHub 离线/, 'GitHub 失败时也不得回退到低于市场版本的安装包');
        writeCache('1.0.2');
        assert.equal((await market.fetchModRelease(mod, { useCache: false })).isStale, true, '版本满足要求时必须保留网络失败后的缓存回退');
        sb.localStorage.setItem(cacheKey.replace(/^modhub_/, 'dol_opt_'), sb.localStorage.getItem(cacheKey));
        sb.localStorage.removeItem(cacheKey);
        assert.equal((await market.fetchModRelease(mod, { useCache: false })).isStale, true, '更名后必须兼容旧版动态 Release 缓存键');
    }

    // 统一索引保留指定发布渠道，主包与同仓库扩展不得串包或共用旧缓存
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const repoUrl = 'https://github.com/AOKIUTAGE/UTAGEsDOL3.0';
        const index = { schemaVersion: 1, mods: [
            { name: 'AU美化', identityId: null, githubUrl: `${repoUrl}/releases/tag/mod`, releaseUrl: `${repoUrl}/releases/tag/facemod`, version: '99.0', versionSource: 'github', wikiVersion: '0.8.7' },
            { name: 'AU面部扩展', identityId: null, githubUrl: `${repoUrl}/releases/tag/facemod` }
        ] };
        const mods = market.normalizeReleaseIndex(index);
        assert.equal(mods[0].version, '0.8.7', '旧索引的跨渠道版本必须回退到本条目的Wiki版本');
        assert.equal(mods[0].releaseUrl, null, '旧索引的错配发布页不得继续展示');
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: index.mods, timestamp: Date.now() }));
        assert.equal((await market.loadMarketData())[0].version, '0.8.7', '本地列表缓存也必须经过渠道纠偏');
        assert.notEqual(market.getMarketModKey(mods[0]), market.getMarketModKey(mods[1]), '同仓库不同发布渠道必须保留独立的批量安装身份');
        sb.localStorage.setItem('modhub_market_rel_v2_AOKIUTAGE_UTAGEsDOL3.0', JSON.stringify({
            timestamp: Date.now(), data: { version: '99.0', assetPlanVersion: 2, assetPlanGameVersion: '', assets: [{ name: 'wrong.zip', downloadUrl: 'wrong' }] }
        }));
        const urls = [];
        sb.fetch = async url => {
            urls.push(url);
            const tag = decodeURIComponent(url.split('/tags/')[1] || 'latest');
            return { ok: true, status: 200, json: async () => ({ tag_name: tag, assets: [{
                name: `${tag}.zip`, browser_download_url: `${repoUrl}/releases/download/${tag}/${tag}.zip`
            }] }) };
        };
        assert.equal((await market.fetchModRelease(mods[0])).assetName, 'mod.zip', 'AU主包必须遵循 githubUrl 指定渠道，不得采用旧索引 releaseUrl 或缓存中的面部扩展');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '面部扩展必须使用自己的发布渠道');
        assert.deepEqual(urls, ['mod', 'facemod'].map(tag => `https://api.github.com/repos/AOKIUTAGE/UTAGEsDOL3.0/releases/tags/${tag}`));
        assert.equal((await market.fetchModRelease(mods[0])).fromCache, true, '指定标签成功后仍可复用本渠道缓存');
        assert.equal((await market.fetchModRelease(mods[1])).assetName, 'facemod.zip', '两次缓存读取不得互相覆盖');
        assert.equal(urls.length, 2, '渠道缓存命中不得额外访问网络');
        assert.equal((await market.fetchRecentCompanionAssets(mods[0])).length, 0, '固定渠道不得跨发布渠道推荐附属包');
        assert.equal(urls.length, 2);

        const encodedMod = { githubUrl: `${repoUrl}/releases/tag/model%2Fstable?test=1#assets` };
        const encodedRelease = await market.fetchModRelease(encodedMod);
        assert.ok(urls.at(-1).endsWith('/releases/tags/model%2Fstable'), '标签须解码一次再作为单个 API 路径参数编码');
        assert.equal(encodedRelease.htmlUrl, `${repoUrl}/releases/tag/model%2Fstable`, '缺少发布页地址时必须回退到指定标签');
        const callsBeforeMissing = urls.length;
        sb.fetch = async url => { urls.push(url); return { ok: false, status: 404 }; };
        await assert.rejects(market.fetchModRelease(mods[0], { useCache: false }), error => error.code === 'RELEASE_NOT_FOUND', '指定标签404不得回退到 latest 或过期包');
        assert.equal(urls.length, callsBeforeMissing + 1, '指定标签失效不得继续查询其他发布渠道');
        assert.notEqual(mods[0]._isDeadRepo, true, '标签不存在不能误标整个仓库失效');
        sb.fetch = async () => { throw new Error('模拟渠道离线'); };
        assert.equal((await market.fetchModRelease(mods[0], { useCache: false })).assetName, 'mod.zip', '离线回退也必须保持渠道隔离');
    }

    // AU发布页包含多个独立模型系列，覆盖包不能被误当成直装包
    {
        const market = loadMarket().modHubMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const assets = Object.entries({ female: ['0.8.7', '0.9.3'], male: ['0.3.7', '0.4.2'], androgynous: ['0.0.7', '0.1.1'] })
            .flatMap(([model, versions]) => versions.flatMap(version => ['model', 'imgpack'].map(type => asset(`AU${model}.${type}_v${version}.zip`))));
        const plan = market.buildReleaseAssetPlan(assets);
        assert.equal(plan.needsChoice, true, '不同模型系列必须交由玩家选择');
        assert.equal(plan.assets.length, 0, '不得跨模型系列比较版本后自动安装女体');
        assert.deepEqual(Array.from(plan.candidates, item => item.name).sort(), [
            'AUfemale.model_v0.9.3.zip', 'AUmale.model_v0.4.2.zip', 'AUandrogynous.model_v0.1.1.zip'
        ].sort(), '必须保留每个模型系列的最新版直装包，排除配对覆盖包');
        const single = market.buildReleaseAssetPlan([asset('AUfemale.model_v0.9.3.zip'), asset('AUfemale.imgpack_v0.9.3.zip')]);
        assert.equal(single.needsChoice, false);
        assert.equal(single.assets.length, 1, '同一模型不得同时安装model与覆盖用imgpack');
        assert.equal(single.assets[0].name, 'AUfemale.model_v0.9.3.zip');
        assert.equal(market.buildReleaseAssetPlan([asset('Example-v1.0.zip'), asset('Example-v2.0.zip')]).assets[0].name, 'Example-v2.0.zip', '普通模组仍选最新版本');
        assert.equal(market.buildReleaseAssetPlan([asset('Only.imgpack_v1.0.zip')]).assets[0].name, 'Only.imgpack_v1.0.zip', '无配对model时不得凭扩展命名排除既有独立资源');
    }

    // Wiki 回退也必须只采用名称列来源，拆分独立项目并识别共享仓库。
    {
        const sb = loadMarket();
        const anchor = (textContent, href) => ({ textContent, getAttribute: () => href });
        const cell = (textContent, links = []) => ({ textContent, querySelectorAll: () => links, cloneNode: () => cell(textContent, links) });
        const cells = [
            [cell('主模组', [anchor('主模组', 'https://github.com/Owner/Shared')]), cell('介绍', [anchor('依赖', 'https://github.com/Other/Dependency')]), cell('作者'), cell('2026-09-27 (v1.0)')],
            [cell('扩展 / 独立工具', [anchor('扩展', 'https://github.com/Owner/Shared'), anchor('独立工具', 'https://github.com/Owner/Tool')]), cell('介绍'), cell('作者'), cell('2026-09-27')],
            [cell('未署名条目'), cell('介绍'), cell(''), cell('')]
        ];
        const header = { querySelectorAll: () => ['名称', '简介', '作者', '更新'].map(text => cell(text)) };
        const rows = cells.map(tds => ({ querySelectorAll: () => tds, querySelector: () => null }));
        const table = { querySelector: () => header, querySelectorAll: () => rows };
        sb.Node = { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 };
        sb.DOMParser = class { parseFromString() { return {
            getElementById: id => id === '公开模组' ? { compareDocumentPosition: () => 4 } : null,
            querySelectorAll: () => [table]
        }; } };
        const mods = sb.modHubMarket.parseModsFromHtml('');
        assert.deepEqual(Array.from(mods, mod => mod.name), ['主模组', '扩展', '独立工具', '未署名条目']);
        assert.deepEqual(Array.from(mods[0].githubUrls), ['https://github.com/Owner/Shared'], '不得采集介绍中的依赖仓库');
        assert.equal(mods[0].otherUrl, null);
        assert.deepEqual(Array.from(mods, mod => mod.sharedRepository), [true, true, false, false]);
        assert.equal(mods[3].author, '未知作者');
        assert.equal(mods[3].wikiAuthor, '', 'Wiki 原作者须独立保留，不能用展示兜底文字匹配目录指纹');
        assert.notEqual(sb.modHubMarket.getMarketModKey(mods[0]), sb.modHubMarket.getMarketModKey(mods[1]), 'Wiki回退无ID时共享仓库多项不能被批量合并');
        const cached = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: mods.map(mod => ({
            ...mod, sharedRepository: undefined, version: '99.0', versionSource: 'github', wikiVersion: '1.0',
            releaseUrl: 'https://github.com/Owner/Shared/releases/tag/Other'
        })) });
        assert.equal(cached[0].sharedRepository, true, '旧缓存未带字段时也必须重新识别共享仓库');
        assert.equal(cached[0].version, '1.0', '共享仓库的旧latest版本必须清除');
        assert.equal(cached[0].releaseUrl, null);
        assert.equal(cached[2].version, '99.0', '独立仓库版本仍可正常使用');
        assert.deepEqual(Array.from(sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, communityRevision: 9,
            withdrawnCatalogTargets: [{ id: '未署名条目-external', wikiName: '未署名条目', wikiAuthor: '' }], mods }), mod => mod.name),
            ['主模组', '扩展', '独立工具'], '空作者的无链接条目也不能从实际 Wiki 解析回退复活');
    }

    // 生育扩展只登记真实技术身份；游戏范围通过不代替原包前置核验。
    {
        const catalogBytes = fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'));
        assert.deepEqual(catalogBytes, fs.readFileSync(path.join(srcRoot, '..', 'dolmod-site', 'dist', 'mod-identities.json')),
            '生育扩展身份登记必须在根目录与网站逐字节同步');
        const catalog = JSON.parse(catalogBytes);
        const identities = catalog.mods.filter(item => item.id === 'fertility-expansion');
        assert.equal(identities.length, 1, '生育扩展只能登记一个身份');
        const identity = identities[0];
        assert.deepEqual(identity.bootNames, ['FertilityExpansion']);
        assert.deepEqual(identity.aliases, ['生育扩展', '生育拓展'], '显示别名不能添加其他模组技术名');
        assert.deepEqual(identity.repositoryKeys, ['Liliths-Legacy/DOL-FertilityExpansion-MOD']);
        assert.deepEqual(identity.repositories, ['DOL-FertilityExpansion-MOD']);
        assert.deepEqual(identity.dependencies || [], [], '不存在的市场身份不能写入目录前置');
        const assetUrl = 'https://github.com/Liliths-Legacy/DOL-FertilityExpansion-MOD/releases/download/v1.5.12/FertilityExpansion.mod.zip';
        assert.deepEqual(identity.verifiedReleaseAssets, [{ sourceUrl: assetUrl,
            sha256: '660ef7c7fe64b30602a08703358595023de18d97d28c8e629130e890d613fb9a',
            bootName: 'FertilityExpansion', version: '1.5.12', size: 126498,
            verifiedAt: '2026-10-04T17:58:11.884768+00:00' }], '官方附件URL与原包摘要、身份、版本、大小必须完整绑定');
        assert.deepEqual(identity.releaseCompatibility, [{ releaseTag: 'v1.5.12', assetName: 'FertilityExpansion.mod.zip',
            gameVersionRange: '=0.5.12.13', evidenceUrl: 'https://github.com/Liliths-Legacy/DOL-FertilityExpansion-MOD/releases/tag/v1.5.12' }]);
        const actualBoot = { name: 'FertilityExpansion', version: '1.5.12', dependenceInfo: [
            { modName: 'ModLoader', version: '^2.101.0' }, { modName: 'GameVersion', version: '=0.5.12.13' },
            { modName: 'TweeReplacer', version: '^1.7.0' }
        ] };
        for (const scenario of ['缺少TweeReplacer', 'ModLoader版本不足', '游戏版本不同']) {
            const sb = loadMarket();
            sb.AbortController = AbortController;
            sb.StartConfig = { version: scenario === '游戏版本不同' ? '0.5.11.9' : '0.5.12.13' };
            loadScripts(sb, ['javascript/modhub-market-versions.js', 'javascript/modhub-market-install.js']);
            const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
            market.applyIdentityCatalog(catalog);
            const target = { ...identity, identityId: identity.id, githubUrl: assetUrl, version: '1.5.12' };
            const profiles = scenario === '缺少TweeReplacer' ? [] : [{ name: 'TweeReplacer', version: '1.7.0',
                bootJson: { name: 'TweeReplacer', version: '1.7.0', dependenceInfo: [] } }];
            market.checkModInstallStatus(target, [{ name: '生育扩展', version: '99.0', bootJson: { name: '生育扩展', version: '99.0' } }]);
            assert.equal(target._matchedLocal, null, '展示别名不能证明真实技术包已安装');
            market.getLocalInstalledProfiles = () => profiles;
            market.refreshLocalPackageProfiles = async () => profiles;
            market.getMarketMods = () => [target];
            market.confirmInstallConflicts = async () => true;
            sb.modHubLoadModManageState = async () => {};
            const loaderVersion = scenario === 'ModLoader版本不足' ? '2.100.0' : '2.101.1';
            // 范围解析接口是沙箱依赖；实际选版、依赖图、运行环境和原包风险检查保留。
            sb.modSC2DataManager = { getModUtils: () => ({ version: loaderVersion }), getDependenceChecker: () => ({
                getInfiniteSemVerApi: () => ({
                    parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
                    parseRange: range => [{ range }],
                    satisfies: (value, ranges) => market.satisfiesVersion(value.version.join('.'), ranges[0].range.replace(/^=/, ''))
                })
            }) };
            const release = { tagName: 'v1.5.12', publishedAt: '2026-10-04T12:43:01Z',
                htmlUrl: identity.releaseCompatibility[0].evidenceUrl,
                assets: [{ name: 'FertilityExpansion.mod.zip', downloadUrl: assetUrl, size: 126498,
                    compatibility: { gameVersionRange: identity.releaseCompatibility[0].gameVersionRange,
                        evidenceUrl: identity.releaseCompatibility[0].evidenceUrl } }] };
            versions.fetchReleases = async () => ({ releases: [release], page: 1, hasMore: false });
            const candidates = versions.buildCandidates(target, { releases: [release] });
            assert.equal(candidates.length, 1);
            assert.equal(candidates[0].compatibility.status, scenario === '游戏版本不同' ? 'incompatible' : 'compatible',
                '选版的游戏范围声明必须保留，不表示前置已满足');
            const prompts = [], alerts = [];
            let prepared = 0, imported = 0;
            market.downloadAndInstallMod = async (_mod, _mirror, options) => {
                if (!options.prepareOnly) { imported++; return true; }
                prepared++;
                return { files: [{}], boots: [actualBoot], bytes: 126498, releaseInfo: options.releaseInfo };
            };
            sb.modHubConfirm = async options => {
                prompts.push(options);
                if (options.title.startsWith('选择【')) {
                    await options.onRender?.(createStubElement());
                    return { selectedKey: candidates[0].candidateKey, manual: true };
                }
                if (options.title === '前置需要手动处理') return 'stop';
                if (options.title === '确认版本风险') return prepared === 0;
                return true;
            };
            sb.modHubAlert = async (message, title) => { alerts.push({ message, title }); };
            assert.equal(await sb.modHubMarketInstaller.install(target, { restoreContext: {} }), false,
                `${scenario}时采用停止处理，不得安装`);
            assert.equal(prepared, 1, `${scenario}必须核对原包声明，不能只测目录提示`);
            assert.equal(imported, 0, `${scenario}取消后不得导入`);
            if (scenario === '缺少TweeReplacer') {
                assert.ok(prompts.some(item => item.title === '前置需要手动处理' && item.message.includes('TweeReplacer')
                    && item.message.includes('1.7.0')), '缺少真实包前置必须说明要求并默认停止');
                assert.ok(alerts.some(item => item.message.includes('TweeReplacer')));
            } else {
                const warning = prompts.filter(item => item.title === '确认版本风险').at(-1);
                assert.ok(warning, '下载后仍须明确确认原包版本风险');
                assert.ok(warning.message.includes(scenario === 'ModLoader版本不足' ? 'ModLoader' : '需要游戏版本'));
                assert.ok(warning.message.includes(scenario === 'ModLoader版本不足' ? '2.101.0' : '0.5.12.13'));
            }
        }
    }

    // 同名、子串和仓库尾名都不能跨模组建立身份。
    {
        const market = loadMarket().modHubMarket;
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        market.applyIdentityCatalog(catalog);
        for (const identity of catalog.mods.filter(item => item.bootNames.length)) {
            const target = { ...identity, identityId: identity.id, githubUrl: identity.repositoryKeys?.[0]
                ? `https://github.com/${identity.repositoryKeys[0]}` : 'https://github.com/ModHubTests/Fixture' };
            const nicknameProvider = { name: 'UnrelatedNativeProvider', version: '99.0',
                bootJson: { name: 'UnrelatedNativeProvider', version: '99.0', nickName: identity.name, alias: identity.bootNames },
                displayNames: [identity.name, ...identity.bootNames], normalizedNames: identity.bootNames, repos: [],
                repositoryKeys: target.repositoryKeys || [] };
            market.checkModInstallStatus(target, [nicknameProvider]);
            assert.equal(target._matchedLocal, null, `身份 ${identity.id} 不能由另一技术名的昵称、展示别名或依赖 alias 冒充`);
        }
        for (const localIdentity of catalog.mods.filter(item => item.bootNames.length)) {
            for (const bootName of localIdentity.bootNames) {
                for (const identity of catalog.mods.filter(item => item.bootNames.length)) {
                    const target = { ...identity, identityId: identity.id,
                        githubUrl: identity.repositoryKeys?.[0] ? `https://github.com/${identity.repositoryKeys[0]}` : 'https://github.com/ModHubTests/Fixture' };
                    market.checkModInstallStatus(target, [{ name: bootName }]);
                    assert.equal(Boolean(target._matchedLocal), identity.id === localIdentity.id,
                        `全目录技术名边界：${bootName} 只能归属 ${localIdentity.id}，不能归属 ${identity.id}`);
                }
            }
        }
        const maple = { ...catalog.mods.find(item => item.id === 'maplebirch'), githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchFramework' };
        const actualMapleBoot = { name: 'maplebirch', version: '5.1.3', alias: ['Simple Frameworks'] };
        market.checkModInstallStatus(maple, [{ name: actualMapleBoot.name, version: actualMapleBoot.version, bootJson: actualMapleBoot }]);
        assert.equal(maple._matchedLocal.bootJson, actualMapleBoot, '精确身份匹配必须保留原生 boot 别名，供依赖代供核验而非身份扩散');
        const simple = { ...catalog.mods.find(item => item.id === 'simple-framework'), githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework' };
        market.checkModInstallStatus(simple, [{ name: actualMapleBoot.name, version: actualMapleBoot.version, bootJson: actualMapleBoot }]);
        assert.equal(simple._matchedLocal, null, 'maplebirch 的原生 alias 不代表已安装简易框架目录身份');
        const avatars = { ...catalog.mods.find(item => item.id === 'eden-visuals'), githubUrl: 'https://github.com/LooopSpiner/Eden-Visuals-Mod' };
        market.checkModInstallStatus(avatars, [{ name: '伊甸头像互动', version: '1.2.0' }]);
        assert.equal(avatars._matchedLocal?.name, '伊甸头像互动', 'Wiki 展示名与包内中文词序不同必须仍按真实 bootNames 精确识别');
        const main = { ...catalog.mods.find(item => item.id === 'woven-realm'), githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm', sharedRepository: true };
        const child = { ...catalog.mods.find(item => item.id === 'woven-realm-cooking'), githubUrl: main.githubUrl, sharedRepository: true };
        for (const [target, other] of [[main, child], [child, main]]) {
            market.checkModInstallStatus(target, [{ name: target.bootNames[0] }]);
            assert.equal(target._matchedLocal?.name, target.bootNames[0]);
            market.checkModInstallStatus(other, [{ name: target.bootNames[0] }]);
            assert.equal(other._matchedLocal, null, '织境主包和料理扩展不得共享别名');
        }
        const unknown = { name: '美化扩展', githubUrl: 'https://github.com/Fixture/Unknown' };
        assert.equal(market.checkModInstallStatus(unknown, [{ name: '美化扩展修复' }]), 'not_installed');
        market.applyIdentityCatalog([{ identityId: null, id: 'wiki-a', name: '假条目', repositories: ['RealTech'] }]);
        assert.equal(market.checkModInstallStatus({ ...unknown, name: '假条目' }, [{ name: 'RealTech' }]), 'not_installed');
        const sameNames = ['A', 'B'].map(owner => ({ id: `fixture-${owner}`, name: '同名模组', bootNames: [`Tech${owner}`], repositoryKeys: [`${owner}/Same`], githubUrl: `https://github.com/${owner}/Same` }));
        market.applyIdentityCatalog(sameNames);
        for (const entry of sameNames) {
            for (const local of sameNames) {
                market.checkModInstallStatus(entry, [{ name: local.bootNames[0], repository: local.githubUrl }]);
                assert.equal(Boolean(entry._matchedLocal), entry.id === local.id, '同名不同作者必须按完整仓库隔离');
            }
        }
        const doli = { name: 'D.O.L.I', githubUrl: 'https://github.com/ArsNativa/DOLI' };
        market.checkModInstallStatus(doli, [{ name: 'DOLI', repository: 'https://github.com/Other/Different' }]);
        assert.equal(doli._matchedLocal, null, '显式来源与已知身份不同的本地包不得冒充官方版本');
        assert.equal(market.findMarketModByLocalName('无来源同名', ['A', 'B'].map(owner => ({ name: '无来源同名', githubUrl: `https://github.com/${owner}/Repo` }))), null, '反查同分不能取第一项');
        const tagged = tag => ({ identityId: 'one-id', name: '固定渠道', githubUrl: `https://github.com/Owner/Repo/releases/tag/${tag}` });
        assert.notEqual(market.getMarketModKey(tagged('main')), market.getMarketModKey(tagged('extra')));
        assert.notEqual(...['main.zip', 'extra.zip'].map(name => market.getMarketModKey({ identityId: 'one-id', githubUrl: `https://github.com/Owner/Repo/releases/download/v1/${name}` })), '同标签的指定附件也必须保留独立身份');
        const shared = { ...unknown, githubUrl: 'https://github.com/Owner/RealTech', sharedRepository: true };
        market.checkModInstallStatus(shared, [{ name: 'RealTech' }]);
        assert.equal(shared._matchedLocal, null, '共享仓库尾名不能证明当前产品已安装');
        const sidebar = { name: 'NPC侧边栏头像', githubUrl: 'https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL' };
        market.checkModInstallStatus(sidebar, [{ name: 'NPC侧边栏头像', repository: sidebar.githubUrl }]);
        assert.ok(sidebar._matchedLocal, '侧边栏头像本身的真实来源必须仍可识别');
        market.checkModInstallStatus(sidebar, [{ name: 'NPCAvatarsMod', repository: 'https://github.com/Eudemonism00/DOL-npcicon-mods' }]);
        assert.equal(sidebar._matchedLocal, null, '社交栏头像不能充当另一作者的侧边栏头像');
    }

    // 资产按产品系列选择，共享仓库查找当前条目的发布而非仓库latest。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const asset = name => ({ name, downloadUrl: `https://example.test/${name}` });
        const frameworkAssets = ['Simple.Framework.ver2.0.5.build_2.zip', 'Simple.Inventory.ver1.0.0.build_18.zip', 'simple.new.content.ver0.0.1.zip'].map(asset);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets).needsChoice, true);
        assert.equal(market.buildReleaseAssetPlan(frameworkAssets, '', { bootNames: ['Simple Framework'] }).assets[0].name, frameworkAssets[0].name);
        assert.equal(market.buildReleaseAssetPlan(['Foo1.0.zip', 'Bar99.0.zip'].map(asset)).candidates.length, 2, '不能跨产品比较版本');
        assert.equal(market.buildReleaseAssetPlan([asset('ResourcePack.zip')]).assets.length, 1, '独立资源主包不能重复安装');
        const companions = market.buildReleaseAssetPlan(['Main1.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip'].map(asset));
        assert.deepEqual(Array.from(companions.assets, item => item.name), ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(market.buildReleaseAssetPlan(['source-code.zip', 'app.apk.zip', 'Other.7z', 'Other.rar'].map(asset)).assets.length, 0);
        assert.equal(market.buildReleaseAssetPlan([asset('Foo Mobile 1.0.zip'), asset('Foo Desktop 1.0.zip')]).assets[0].name, 'Foo Desktop 1.0.zip');
        const repo = 'https://github.com/Fixture/Shared';
        const urls = [];
        sb.fetch = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ['Other', 'Foo', 'Bar'].map((name, index) => ({
            tag_name: `product-${index}`, html_url: `${repo}/releases/tag/product-${index}`,
            assets: [{ name: `${name}1.0.zip`, browser_download_url: `${repo}/releases/download/product-${index}/${name}1.0.zip` }]
        })) }; };
        const mod = name => ({ name, bootNames: [name], githubUrl: repo, sharedRepository: true });
        assert.equal((await market.fetchModRelease(mod('Foo'))).assetName, 'Foo1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Bar'))).assetName, 'Bar1.0.zip');
        assert.equal((await market.fetchModRelease(mod('Foo'))).fromCache, true);
        assert.equal(urls.length, 2, '同仓库不同条目缓存不能串包');
        assert.ok(urls.every(url => url.endsWith('/releases?per_page=100')));
        await assert.rejects(market.fetchModRelease(mod('Missing')), error => error.code === 'MANUAL_SOURCE');
        for (const suffix of ['/tree/main', '/blob/main/mod.zip', '/issues/1', '/releases/latest/extra']) {
            await assert.rejects(market.fetchModRelease({ githubUrl: repo + suffix }), error => error.code === 'MANUAL_SOURCE');
        }
        await assert.rejects(market.fetchModRelease({ githubUrl: 'https://fake.github.com/Fixture/Shared' }), /无法解析/);
        sb.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1', assets: ['Foo1.0.zip', 'Bar2.0.zip'].map(name => ({ name, browser_download_url: `${repo}/releases/download/v1/${name}` })) }) });
        assert.equal((await market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Foo1.0.zip` })).assetName, 'Foo1.0.zip');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/download/v1/Missing.zip` }), error => error.code === 'RELEASE_NOT_FOUND', '指定附件消失时不能改装其他文件');
        await assert.rejects(market.fetchModRelease({ githubUrl: `${repo}/releases/tag/another` }), error => error.code === 'RELEASE_NOT_FOUND', '返回标签与指定标签不同必须停止');
        sb.fetch = async () => { const error = new Error('取消'); error.name = 'AbortError'; throw error; };
        await assert.rejects(market.fetchModRelease(mod('Foo'), { useCache: false }), error => error.name === 'AbortError', '取消请求不能继续使用离线包');
    }

    // 手选仍保留匹配资源；需手动来源的条目直接解释原因，不进入自动导入。
    {
        const sb = loadMarket();
        sb.Blob = Blob;
        sb.modHubGetGui = () => ({});
        sb.modHubShowToast = () => {};
        sb.modHubEscapeHtml = value => value;
        const installedFiles = [];
        sb.modHubHandleAddMod = async input => { installedFiles.push(...Array.from(input.files || input, file => file.name)); return true; };
        sb.modHubConfirm = async () => 'asset:0';
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob(['data']) });
        const availableAssets = ['Main1.0.zip', 'Bar2.0.zip', 'Main.PhotoPack1.0.zip', 'Other.PhotoPack1.0.zip']
            .map(name => ({ name, downloadUrl: `https://example.test/${name}` }));
        assert.equal(await sb.modHubMarket.downloadAndInstallMod({ name: '手选测试' }, 'ddlc', { askRestart: false, releaseInfo: {
            requiresManualSelection: true, version: '99.0', candidateAssets: availableAssets.slice(0, 2), availableAssets
        } }), true);
        assert.deepEqual(installedFiles, ['Main1.0.zip', 'Main.PhotoPack1.0.zip']);
        assert.equal(JSON.parse(sb.localStorage.getItem('modhub_market_confirmed_updates_v1'))['手选测试'], '1.0', '手选低版本不能被记录为仓库最高版本');
        const dialogs = [];
        sb.modHubConfirm = async dialog => { dialogs.push(dialog); return false; };
        sb.fetch = async () => { throw new Error('文件页不应访问API'); };
        const manual = { name: '分支模组', githubUrl: 'https://github.com/Fixture/Repo/tree/main' };
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(manual), false);
        assert.equal(dialogs.at(-1).confirmText, '打开主页');
        assert.ok(dialogs.at(-1).message.includes('文件或分支'));
        assert.equal(installedFiles.length, 2, '手动来源不能调用安装接口');
        let batchFailure = '';
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(manual, 'ddlc', { batchMode: true, onFailure: reason => { batchFailure = reason; } }), false);
        assert.ok(batchFailure.includes('文件或分支'));
        assert.equal(dialogs.length, 1, '批量应记录原因且不弹单装对话框');
    }

    // 目录尚未刷新时，已读取的完整发布历史须纠正卡片；手动刷新须绕过真实历史缓存。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.12.13' };
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        const githubUrl = 'https://github.com/VersionTests/ModHub';
        const indexed = { id: 'modhub', identityId: 'modhub', name: 'ModHub模组管理中心', bootNames: ['ModHub'],
            githubUrl, repositoryKeys: ['VersionTests/ModHub'], version: '1.3.1', versionSource: 'github',
            releaseUrl: `${githubUrl}/releases/tag/v1.3.1`, updateDate: '2026-10-01' };
        const local = { name: 'ModHub', bootJson: { name: 'ModHub', version: '1.3.2', repository: githubUrl } };
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [local], getModListNameNoAlias: () => ['ModHub'] } });
        sb.modHubGetModInfo = name => name === 'ModHub' ? local : null;
        const cards = createStubElement();
        sb.document.getElementById = id => id === 'modHubMarketCardsContainer' ? cards : null;
        let remoteVersion = '1.3.2', historyRequests = 0;
        const release = (version, target = '') => {
            const name = `ModHub-v${version}${target ? `-DoL-${target}` : ''}.zip`;
            return { tagName: `v${version}`, name: version, publishedAt: version === '1.4.0' ? '2026-10-07T00:00:00Z' : '2026-10-06T00:00:00Z',
                assets: [{ name, size: 100, downloadUrl: `${githubUrl}/releases/download/v${version}/${name}` }] };
        };
        const history = releases => ({ schemaVersion: 1, id: indexed.id, sourceUrl: githubUrl, page: 1, hasMore: false,
            communityRevision: market.getCommunityRevision(), fetchedAt: new Date().toISOString(), releases });
        sb.fetch = async url => {
            if (String(url).endsWith('/mod-identities.json')) {
                return { ok: true, json: async () => ({ schemaVersion: 1, mods: [indexed] }) };
            }
            if (String(url).includes('/mod-releases?')) {
                historyRequests++;
                return { ok: true, json: async () => history([release(remoteVersion)]) };
            }
            assert.ok(String(url).endsWith('/release-index.json'), '本用例只读取统一目录与历史接口');
            return { ok: true, json: async () => ({ schemaVersion: 1, mods: [indexed] }) };
        };
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [indexed], timestamp: Date.now() }));
        sb.localStorage.setItem('modhub_custom_setting', '保留');
        let [mod] = await market.loadMarketData();
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        market.renderMarketCards();
        assert.ok(cards.innerHTML.includes('已安装版本：v1.3.2') && cards.innerHTML.includes('最新版本：v1.3.2')
            && cards.innerHTML.includes('>已是最新</span>'), '截图中的完整历史1.3.2须纠正旧目录1.3.1');
        assert.equal(mod.version, '1.3.1', '历史观测不能覆盖目录版号或改变历史缓存签名');
        assert.equal(market.getModUpdateInfo(mod).latestRelease.version, '1.3.2');
        assert.ok(cards.innerHTML.includes('发布: 2026-10-06'), '采用新历史版号时须同步其真实发布日期');
        assert.equal(historyRequests, 1, '重绘必须复用已完成的历史检测');

        const oldHistoryContext = market.getReleaseHistoryContext(mod);
        remoteVersion = '1.3.3';
        assert.equal((await versions.fetchReleases(mod)).releases[0].tagName, 'v1.3.2', '普通历史读取仍保留六小时缓存');
        assert.equal(historyRequests, 1);
        [mod] = await market.loadMarketData(true);
        market.checkModInstallStatus(mod);
        const pending = market.getModUpdateInfo(mod);
        assert.equal(market.getModUpdateInfo({ ...mod }).promise, pending.promise, '手动刷新后同来源副本仍共用请求');
        await pending.promise;
        assert.equal(historyRequests, 2, '手动刷新必须实际重读历史，不能命中旧localStorage');
        assert.equal(market.getModUpdateInfo(mod).version, '1.3.3');
        assert.ok(cards.innerHTML.includes('最新版本：v1.3.3'));
        assert.equal(sb.localStorage.getItem('modhub_custom_setting'), '保留', '刷新不能删除其它用户设置');
        assert.equal(market.getReleaseHistoryContext(mod).useCache, false, '刷新后选版必须使用同一历史缓存策略');
        assert.equal(market.rememberMarketCandidates(mod, versions.buildCandidates(mod, history([release('9.0.0')])),
            { context: oldHistoryContext }), null, '刷新前尚未完成的选版请求不能污染新一轮历史状态');
        assert.equal(market.getModUpdateInfo(mod).latestRelease.version, '1.3.3');

        const candidates = versions.buildCandidates(mod, history([release('1.4.0', '0.5.13.0'), release('1.3.2', '0.5.12.13'),
            { ...release('9.0.0'), draft: true }, { ...release('8.0.0'), prerelease: true }]));
        market.rememberMarketCandidates(mod, candidates);
        const selected = market.getModUpdateInfo(mod);
        assert.equal(selected.latestRelease.version, '1.4.0', '选版完成后须同步全局最新版');
        assert.equal(selected.release.version, '1.3.2', '当前游戏推荐目标须独立保留');
        assert.ok(cards.innerHTML.includes('最新版本：v1.4.0'));
        assert.ok(cards.innerHTML.includes('发布: 2026-10-07'), '全局最新日期不能误用当前游戏低版本日期');
        assert.equal(historyRequests, 2, '完整选版候选同步不能再次获取历史');
        assert.equal(mod.version, '1.3.1');
        assert.equal(versions.getLatestReleaseCandidate({ ...mod, githubUrl: 'https://github.com/Other/ModHub' }, candidates), null,
            '其他来源的候选不能作为当前模组全局最新版');
        assert.equal(versions.getLatestReleaseCandidate(mod, [...candidates, { ...candidates[0], seriesKey: 'other-product' }]), null,
            '多个产品系列不能猜测统一最新版');
        sb.StartConfig.version = '';
        remoteVersion = '1.5.0';
        await market.getModUpdateInfo(mod).promise;
        const withoutGame = market.getModUpdateInfo(mod);
        assert.equal(withoutGame.version, '', '未知游戏不能推断适配更新目标');
        assert.equal(withoutGame.release, null);
        assert.equal(withoutGame.latestRelease.version, '1.5.0', '未知游戏仍可核对全局最新发行版');
        assert.ok(cards.innerHTML.includes('最新版本：v1.5.0'));
        Object.assign(mod, { versionSource: 'installed', version: '7.0', releaseUrl: null });
        market.rememberMarketCandidates(mod, versions.buildCandidates(mod, history([release('1.5.0')])));
        assert.ok(cards.innerHTML.includes('最新版本：v1.5.0') && !cards.innerHTML.includes('最新版本：v7.0'),
            '目录缺少远端版号来源时，仍可使用真实历史新版，不能以本地线索代替');
        market.markRepoAsDead(githubUrl);
        market.renderMarketCards();
        assert.equal(market.rememberMarketCandidates(mod, candidates), null);
        assert.ok(!cards.innerHTML.includes('最新版本：v1.5.0'),
            '失效来源不能继续使用历史观测宣称新版');
    }

    // 更新提醒、统计和忽略记录必须指向当前游戏的最新版，而非仓库最高版本。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.11.9' };
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        let [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ id: 'maplebirch', identityId: 'maplebirch', name: '秋枫白桦框架', bootNames: ['maplebirch'],
            githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework',
            repositoryKeys: ['MaplebirchLeaf/SCML-DOL-maplebirchframework'], version: '5.2.1', versionSource: 'github',
            releaseUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework/releases/tag/v5.2.1' }] });
        let localVersion = '5.1.3';
        const localMod = () => ({ name: 'maplebirch', bootJson: { name: 'maplebirch', version: localVersion, repository: mod.githubUrl } });
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [localMod()], getModListNameNoAlias: () => ['maplebirch'] } });
        sb.modHubGetModInfo = name => name === 'maplebirch' ? localMod() : null;
        const makeRelease = (version, target) => {
            const name = `maplebirch-v${version}${target ? `-DoL-${target}` : ''}.zip`;
            return { tagName: `v${version}`, name: version, publishedAt: '2026-10-02T00:00:00Z',
                htmlUrl: `${mod.githubUrl}/releases/tag/v${version}`,
                assets: [{ name, size: 100, downloadUrl: `${mod.githubUrl}/releases/download/v${version}/${name}` }] };
        };
        const pages = [makeRelease('5.2.1', '0.5.12.13'), makeRelease('5.1.1', '0.5.11.9'), makeRelease('5.1.3', '0.5.11.9')];
        const requestedPages = [];
        versions.fetchReleases = async (_mod, { page = 1 } = {}) => {
            requestedPages.push(page);
            return { id: _mod.id, sourceUrl: mod.githubUrl, page, nextPage: page + 1, hasMore: page < pages.length,
                fetchedAt: '2026-10-02T00:00:00Z', releases: [pages[page - 1]] };
        };
        sb.localStorage.setItem('modhub_market_identities_v4', JSON.stringify({ data: { schemaVersion: 1, mods: [mod] }, timestamp: Date.now() }));
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [mod], timestamp: Date.now() }));
        [mod] = await market.loadMarketData();
        assert.notEqual(market.checkModInstallStatus(mod), 'update_available', '适配信息读取完成前不能用另一游戏版本误报更新');
        const pending = market.getModUpdateInfo(mod);
        assert.equal(pending.pending, true);
        const pendingClone = { ...mod };
        delete pendingClone._updateCheck;
        market.checkModInstallStatus(pendingClone);
        assert.equal(market.getModUpdateInfo(pendingClone).promise, pending.promise, '检测中的独立模组副本必须共用同一请求，不能重新分页读取');
        await pending.promise;
        const current = market.getModUpdateInfo(mod);
        assert.equal(current.pending, false);
        assert.equal(current.version, '5.1.3', '应跨页选择当前游戏最高模组版本，不能停在先读到的5.1.1');
        assert.equal(current.release.version, '5.1.3');
        assert.deepEqual(requestedPages, [1, 2, 3], '历史未读完时必须继续核对后续页');
        assert.equal(market.checkModInstallStatus(mod), 'up_to_date', '当前游戏已装5.1.3时不能提示适配0.5.12的5.2.1');
        assert.equal(market.getModUpdateInfo({ ...mod }).version, '5.1.3', '卡片副本必须复用同来源同游戏检测结果');
        assert.deepEqual(requestedPages, [1, 2, 3], '重绘与重复检测不得重复读取历史');
        assert.equal(mod.version, '5.2.1', '适配检测不得覆写统一索引版本或破坏历史缓存签名');
        const installedCardElements = new Map(['modHubMarketCardsContainer', 'modHubMarketStats'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => installedCardElements.get(id) || null;
        market.renderMarketCards();
        const installedCard = installedCardElements.get('modHubMarketCardsContainer').innerHTML;
        assert.ok(installedCard.includes('最新版本：v5.2.1') && installedCard.includes('已安装版本：v5.1.3'));
        assert.ok(installedCard.includes('<span class="gold">已安装版本：v5.1.3') && installedCard.includes('<span class="purple">最新版本：v5.2.1'),
            '当前游戏推荐版低于目录最新版时，已安装版本仍显示金色');
        assert.ok(installedCard.includes('已是推荐版本') && installedCard.includes('当前游戏推荐版本与已安装版本相同')
            && installedCard.includes('依据安装包名称参考，不代表游戏实测') && !installedCard.includes('已是最新') && !installedCard.includes('当前版本已适配'),
            '当前游戏候选已安装时只说明参考推荐，不声称全局最新或游戏兼容已验证');

        localVersion = '5.1.1';
        assert.equal(market.checkModInstallStatus(mod), 'update_available', '当前游戏的旧版仍须提示5.1.3更新');
        const elements = new Map(['modHubMarketCardsContainer', 'modHubMarketStats'].map(id => [id, createStubElement()]));
        const cards = elements.get('modHubMarketCardsContainer');
        const ignoreOnce = createStubElement('button');
        ignoreOnce.dataset = { modIndex: '0', ignoreMode: 'once' };
        cards.querySelectorAll = selector => selector === '.btn-market-ignore' ? [ignoreOnce] : [];
        sb.document.getElementById = id => elements.get(id) || null;
        const notifications = [];
        sb.modHubNotifyUpdateState = (count, list) => notifications.push({ count, list });
        market.renderMarketCards();
        assert.ok(cards.innerHTML.includes('发现新版') && cards.innerHTML.includes('5.1.3'), '卡片更新提醒应展示当前游戏候选');
        assert.ok(cards.innerHTML.includes('依据文件名') && cards.innerHTML.includes('选择更新版本'), '文件名线索更新须明示参考依据并要求选版');
        assert.ok(cards.innerHTML.includes('最新版本：v5.2.1') && cards.innerHTML.includes('已安装版本：v5.1.1'),
            '目录最新与当前已安装版本独立显示；更新动作仍使用当前游戏的5.1.3候选');
        assert.ok(/仅忽略\s+v?5\.1\.3/.test(cards.innerHTML), '忽略本次说明必须引用当前游戏候选');
        assert.equal(notifications.at(-1).count, 1);
        assert.equal(notifications.at(-1).list[0].newVersion, '5.1.3', '管理页徽标与统计必须使用同一个候选版本');
        assert.equal(market.getUpdatableMods()[0].newVersion, '5.1.3', '全部更新和管理页直接更新列表必须使用同一个候选版本');
        const missingModuleAlerts = [];
        const originalAlert = sb.modHubAlert;
        sb.modHubAlert = async message => { missingModuleAlerts.push(message); };
        assert.equal(await market.promptDownloadMirrorAndInstall(mod), false, '参考更新缺少选版模块时不能退回旧下载入口');
        assert.equal(await market.updateAllMods(), false, '全部更新缺少选版模块时不能直接下载参考版本');
        assert.equal(missingModuleAlerts.length, 2);
        assert.ok(missingModuleAlerts.every(message => message.includes('版本选择模块尚未就绪')));
        sb.modHubAlert = originalAlert;
        await ignoreOnce.onclick();
        assert.equal(market.getIgnoredUpdates()[mod.name], '5.1.3', '忽略本次不能把另一游戏系列5.2.1一并忽略');
        assert.equal(market.getUpdatableMods().length, 0);
        market.setModUpdateIgnored(mod.name, '', false);
        market.setModUpdateIgnored('maplebirch', '', false);

        sb.StartConfig.version = '0.5.12.13';
        assert.notEqual(market.checkModInstallStatus(mod), 'update_available', '切换游戏版本后须重新核对，不能复用旧游戏结论');
        await market.getModUpdateInfo(mod).promise;
        assert.equal(market.getModUpdateInfo(mod).version, '5.2.1');
        assert.equal(market.checkModInstallStatus(mod), 'update_available', '切到0.5.12后应提示该系列5.2.1');
        assert.deepEqual(requestedPages, [1, 2, 3, 1, 2, 3]);
        assert.equal(mod.version, '5.2.1');

        const expired = market.getModUpdateInfo(mod), requestsBeforeExpiry = requestedPages.length;
        expired.checkedAt -= 6 * 60 * 60 * 1000 + 1;
        const renewed = market.getModUpdateInfo(mod);
        assert.equal(renewed.pending, true);
        assert.notEqual(renewed.promise, expired.promise, '超过六小时的检测结论必须重新核对');
        await renewed.promise;
        assert.equal(requestedPages.length, requestsBeforeExpiry + 3);
        assert.equal(market.getModUpdateInfo(mod).version, '5.2.1');

        sb.StartConfig.version = '0.5.11.9';
        const lowerLatest = { ...mod, id: 'lower-global-latest', version: '5.0.0' };
        market.checkModInstallStatus(lowerLatest);
        await market.getModUpdateInfo(lowerLatest).promise;
        assert.equal(market.getModUpdateInfo(lowerLatest).version, '5.1.3');
        assert.equal(market.checkModInstallStatus(lowerLatest), 'update_available', '仓库最新发布维护较低分支时，仍须发现当前游戏5.1.3高于本地5.1.1');
        assert.equal(lowerLatest.version, '5.0.0', '当前游戏较高版本检测不得改写较低分支的目录版本');
        sb.StartConfig.version = '0.5.12.13';

        versions.fetchReleases = async source => ({ id: source.id, sourceUrl: source.githubUrl, page: 1, hasMore: false,
            fetchedAt: '2026-10-02T00:00:00Z', releases: [makeRelease('5.2.1')] });
        const unlabelled = { ...mod, id: 'unlabelled-update' };
        assert.notEqual(market.checkModInstallStatus(unlabelled), 'update_available');
        await market.getModUpdateInfo(unlabelled).promise;
        assert.equal(market.checkModInstallStatus(unlabelled), 'update_available', '单一系列数值新版仍应提示更新，适配须另行核对');
        assert.equal(market.getModUpdateInfo(unlabelled).version, '5.2.1');
        assert.equal(market.getModUpdateInfo(unlabelled).release.compatibility.evidence, 'unknown');

        versions.fetchReleases = async source => ({ id: source.id, sourceUrl: source.githubUrl, page: 1, hasMore: false,
            fetchedAt: '2026-10-02T00:00:00Z', releases: [makeRelease('5.1.3', '0.5.11.9')] });
        const mismatched = { ...mod, id: 'mismatched-update' };
        market.checkModInstallStatus(mismatched);
        await market.getModUpdateInfo(mismatched).promise;
        assert.ok(!market.getModUpdateInfo(mismatched).version);
        assert.notEqual(market.checkModInstallStatus(mismatched), 'update_available', '有其他游戏适配证据但无当前候选时不得回退到仓库最高版本');

        versions.fetchReleases = async () => { throw new Error('测试历史服务离线'); };
        const unavailable = mod;
        unavailable.revision = 1;
        assert.notEqual(market.checkModInstallStatus(unavailable), 'update_available');
        market.renderMarketCards();
        assert.ok(cards.innerHTML.includes('正在检查更新') && !cards.innerHTML.includes('已是最新'), '新来源读取期间只能显示待检查状态');
        await market.getModUpdateInfo(unavailable).promise;
        const failed = market.getModUpdateInfo(unavailable);
        assert.equal(failed.pending, false);
        assert.ok(!failed.version && String(failed.error?.message || failed.error).includes('测试历史服务离线'), '读取失败必须保留未知结论及具体原因');
        assert.notEqual(market.checkModInstallStatus(unavailable), 'update_available', '读取失败不能回退到另一游戏系列的仓库最高版本');
        market.renderMarketCards();
        assert.ok(cards.innerHTML.includes('更新检查失败') && cards.innerHTML.includes('测试历史服务离线')
            && !cards.innerHTML.includes('已是最新'), '失败卡片必须说明具体原因，不能声称已是最新');
        assert.equal(market.getUpdatableMods().length, 0);
        assert.equal(mod.version, '5.2.1');

        let retryRequests = 0;
        versions.fetchReleases = async source => {
            retryRequests++;
            return { id: source.id, sourceUrl: source.githubUrl, page: 1, hasMore: false,
                fetchedAt: '2026-10-02T00:00:00Z', releases: [makeRelease('5.2.1', '0.5.12.13')] };
        };
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: [{ ...mod }] }) });
        [mod] = await market.loadMarketData(true);
        market.checkModInstallStatus(mod);
        const retry = market.getModUpdateInfo(mod);
        assert.equal(retry.pending, true, '手动刷新市场须清除失败结论，不能继续等待六小时缓存过期');
        assert.notEqual(retry.promise, failed.promise);
        await retry.promise;
        assert.equal(retryRequests, 1, '刷新后同来源副本只能重试一次');
        assert.equal(market.checkModInstallStatus(mod), 'update_available');
        assert.equal(market.getModUpdateInfo(mod).version, '5.2.1');
        assert.ok(!market.getModUpdateInfo(mod).error);
        sb.StartConfig.version = '';
        assert.equal(market.getModUpdateInfo(mod).version, '', '无法识别当前游戏时不能使用目录最新版推断更新');
        assert.notEqual(market.checkModInstallStatus(mod), 'update_available');
        market.renderMarketCards();
        assert.ok(/badge-installed"[^>]*>已安装<\/span>/.test(cards.innerHTML) && cards.innerHTML.includes('无法识别当前游戏版本，尚未检查适配更新')
            && !cards.innerHTML.includes('已是最新') && !cards.innerHTML.includes('更新版本待核对'), '未知游戏保留已安装事实，并明确无法检查适配更新的原因');
    }

    // 怨灵的倒影无适配声明时，仍发现真实新版；所有安装入口必须先选择并核对版本。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.12.13' };
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        let [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ id: 'wraiths-reflection', identityId: 'wraiths-reflection',
            name: '怨灵的倒影', bootNames: ["Wraith'sReflection"], repositoryKeys: ['Water2311/WraithsReflection'],
            githubUrl: 'https://github.com/Water2311/WraithsReflection', version: '1.3.3', versionSource: 'github' }] });
        const local = { name: "Wraith'sReflection", bootJson: { name: "Wraith'sReflection", version: '1.3.2', repository: mod.githubUrl } };
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [local], getModListNameNoAlias: () => [local.name] } });
        sb.modHubGetModInfo = name => name === local.name ? local : null;
        let remoteVersion = '1.3.3', unexpectedDownloads = 0;
        const history = () => ({ page: 1, hasMore: false, releases: [{ tagName: `v${remoteVersion}`, name: remoteVersion,
            publishedAt: '2026-10-05T00:00:00Z', htmlUrl: `${mod.githubUrl}/releases/tag/v${remoteVersion}`,
            assets: [{ name: `WraithsReflection-v${remoteVersion}.zip`, size: 100,
                downloadUrl: `${mod.githubUrl}/releases/download/v${remoteVersion}/WraithsReflection-v${remoteVersion}.zip` }] }] });
        versions.fetchReleases = async () => history();
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
            unexpectedDownloads++;
            throw new Error('更新入口不得绕过选版直接下载');
        };
        const elements = new Map(['modHubMarketCardsContainer', 'modHubMarketStats'].map(id => [id, createStubElement()]));
        const cards = elements.get('modHubMarketCardsContainer');
        const updateButton = createStubElement('button'), ignoreOnce = createStubElement('button'), ignoreAlways = createStubElement('button');
        updateButton.dataset = { modIndex: '0' };
        ignoreOnce.dataset = { modIndex: '0', ignoreMode: 'once' };
        ignoreAlways.dataset = { modIndex: '0', ignoreMode: 'always' };
        cards.querySelectorAll = selector => selector === '.btn-market-ignore' ? [ignoreOnce, ignoreAlways]
            : selector === '.btn-market-install, .btn-market-update' ? [updateButton] : [];
        sb.document.getElementById = id => elements.get(id) || null;
        const notifications = [];
        sb.modHubNotifyUpdateState = (count, list) => notifications.push({ count, list });
        sb.localStorage.setItem('modhub_market_identities_v4', JSON.stringify({ data: { schemaVersion: 1, mods: [mod] }, timestamp: Date.now() }));
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [mod], timestamp: Date.now() }));
        [mod] = await market.loadMarketData();
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        market.renderMarketCards();
        const update = market.getModUpdateInfo(mod), candidates = versions.buildCandidates(mod, history());
        assert.equal(market.checkModInstallStatus(mod), 'update_available', '截图中的本地1.3.2须发现线上1.3.3');
        assert.ok(cards.innerHTML.includes('已安装版本：v1.3.2') && cards.innerHTML.includes('最新版本：v1.3.3'));
        assert.ok(cards.innerHTML.includes('<span class="gold">已安装版本：v1.3.2') && cards.innerHTML.includes('<span class="purple">最新版本：v1.3.3'),
            '已安装旧版显示金色，线上最新版显示紫色');
        assert.ok(cards.innerHTML.includes('发现新版，适配待核对') && cards.innerHTML.includes('选择更新版本'));
        assert.ok(cards.innerHTML.includes(update.release.compatibility.reason) && !cards.innerHTML.includes('未找到适配当前游戏的版本'),
            '卡片说明真实适配未知原因，不能隐藏已发现的新版');
        assert.equal(update.version, '1.3.3');
        assert.equal(market.getUpdatableMods()[0].newVersion, '1.3.3');
        assert.equal(notifications.at(-1).count, 1);
        assert.equal(notifications.at(-1).list[0].newVersion, '1.3.3');
        assert.ok(elements.get('modHubMarketStats').innerHTML.includes('更新全部 1 个可更新模组'));
        assert.equal(versions.getLatestGameCandidate(mod, candidates), null, '未知适配不能升级为当前游戏推荐');
        const ranked = versions.rankCandidates(mod, candidates, { updateOnly: true, localVersion: '1.3.2' });
        assert.equal(ranked.recommendedKey, '');
        assert.equal(ranked.defaultKey, candidates[0].candidateKey, '批量更新默认选择单一系列的1.3.3新版');
        assert.equal(ranked.defaultRisk, true, '默认选中新版仍须在安装前核对未知适配风险');

        const alerts = [];
        sb.modHubAlert = async message => { alerts.push(message); };
        await updateButton.onclick();
        assert.equal(await market.updateAllMods(), false);
        assert.equal(alerts.length, 2);
        assert.ok(alerts.every(message => message.includes('版本选择模块尚未就绪')));
        const installs = [];
        sb.modHubMarketInstaller = {
            install: async (target, options) => { installs.push({ targets: [target], options }); return false; },
            installBatch: async (targets, options) => { installs.push({ targets, options }); return false; }
        };
        await updateButton.onclick();
        assert.equal(await market.updateAllMods(), false);
        assert.equal(installs.length, 2);
        assert.ok(installs.every(call => call.targets.length === 1 && call.targets[0].id === mod.id && call.options.restoreContext));
        assert.equal(installs[1].options.updateOnly, true);
        assert.equal(unexpectedDownloads, 0, '单项及批量更新都不能绕过共用选版模块');

        await ignoreOnce.onclick();
        assert.equal(market.getIgnoredUpdates()[mod.name], '1.3.3');
        assert.equal(market.getUpdatableMods().length, 0);
        assert.ok(cards.innerHTML.includes('<span class="gold">已安装版本：v1.3.2'), '忽略本次更新不能将旧版标为绿色');
        remoteVersion = '1.3.4';
        mod.revision = 1;
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        assert.equal(market.getUpdatableMods()[0].newVersion, '1.3.4', '忽略本次不能隐藏后续新版');
        sb.modHubConfirm = async () => true;
        await ignoreAlways.onclick();
        assert.equal(market.getIgnoredUpdates()[mod.name], 'ignored');
        assert.ok(cards.innerHTML.includes('<span class="gold">已安装版本：v1.3.2'), '永久忽略更新不能将旧版标为绿色');
        remoteVersion = '1.3.5';
        mod.revision = 2;
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        assert.equal(market.getUpdatableMods().length, 0, '永久忽略仍覆盖后续未知适配新版');
        assert.equal(notifications.at(-1).count, 0);

        market.setModUpdateIgnored(mod.name, '', false);
        market.setModUpdateIgnored(local.name, '', false);
        remoteVersion = '1.3.2';
        mod.revision = 3;
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        market.renderMarketCards();
        assert.ok(/badge-installed"[^>]*>已安装<\/span>/.test(cards.innerHTML)
            && !cards.innerHTML.includes('已是推荐版本') && !cards.innerHTML.includes('推荐依据作者声明'),
            '历史未知适配版本等于本地时，只能保留已安装事实，不能构造作者推荐');
        assert.ok(cards.innerHTML.includes('<span class="gold">已安装版本：v1.3.2'), '本地低于目录最新版时仍显示金色');
        assert.equal(versions.rankCandidates(mod, versions.buildCandidates(mod, history())).recommendedKey, '', '未知适配历史最高版仍没有严格推荐');
    }

    // 发布标题为日期时，更新入口必须使用真实安装包版号，且不猜测多个产品系列。
    {
        const sb = loadMarket();
        loadScripts(sb, ['javascript/modhub-market-versions.js']);
        sb.StartConfig = { version: '0.5.11.9' };
        const market = sb.modHubMarket, versions = sb.modHubMarketVersions;
        let [mod] = market.normalizeReleaseIndex({ schemaVersion: 1, mods: [{ id: 'universal-combat-zed-fix', identityId: 'universal-combat-zed-fix',
            name: '战斗美化修复', bootNames: ['通用战斗美化-zed修复'], repositoryKeys: ['Zed660033/mysterious'],
            githubUrl: 'https://github.com/Zed660033/mysterious', version: '9.26', releaseAssetVersion: '1.0.3', versionSource: 'github',
            releaseUrl: 'https://github.com/Zed660033/mysterious/releases/tag/9.26' }] });
        let localVersion = '1.0.3';
        const localMod = () => ({ name: '通用战斗美化-zed修复', bootJson: { name: '通用战斗美化-zed修复', version: localVersion, repository: mod.githubUrl } });
        sb.modHubGetGui = () => ({ gModUtils: { getModList: () => [localMod()], getModListNameNoAlias: () => ['通用战斗美化-zed修复'] } });
        sb.modHubGetModInfo = name => name === '通用战斗美化-zed修复' ? localMod() : null;
        sb.modSC2DataManager = { getDependenceChecker: () => ({ getInfiniteSemVerApi: () => ({
            parseVersion: value => ({ version: { version: value.split('.').map(Number) } }),
            parseRange: value => [{ range: value }],
            satisfies: (version, ranges) => version.version.join('.') === ranges[0].range
        }) }) };
        const makeRelease = names => ({ tagName: '9.26', name: '9.26', version: '9.26', publishedAt: '2026-09-26T00:00:00Z',
            htmlUrl: `${mod.githubUrl}/releases/tag/9.26`,
            compatibility: { gameVersionRange: '0.5.11.9', evidenceUrl: `${mod.githubUrl}/releases/tag/9.26` },
            assets: names.map(name => ({ name, size: 100, downloadUrl: `${mod.githubUrl}/releases/download/9.26/${name}` })) });
        let releases = [makeRelease(['Z-outdate-UCB-zedfix-1.0.0.zip', 'Z-outdate-UCB-zedfix-1.0.1.zip',
            'Z-outdate-UCB-zedfix-1.0.2.zip', 'UCB-zedfix-1.0.3.zip'])];
        versions.fetchReleases = async source => ({ id: source.id, sourceUrl: source.githubUrl, page: 1, hasMore: false,
            fetchedAt: '2026-10-02T00:00:00Z', releases });
        sb.localStorage.setItem('modhub_market_identities_v4', JSON.stringify({ data: { schemaVersion: 1, mods: [mod] }, timestamp: Date.now() }));
        sb.localStorage.setItem('modhub_market_wiki_v5', JSON.stringify({ data: [mod], timestamp: Date.now() }));
        [mod] = await market.loadMarketData();
        market.checkModInstallStatus(mod);
        await market.getModUpdateInfo(mod).promise;
        const current = market.getModUpdateInfo(mod);
        assert.equal(current.version, '1.0.3', '目录9.26不能覆盖安装包中可识别的1.0.3版号');
        assert.equal(current.release.assetName, 'UCB-zedfix-1.0.3.zip', '作者声明适配的单一系列须保留真实发布候选');
        assert.equal(current.release.version, '1.0.3');
        assert.equal(market.checkModInstallStatus(mod), 'up_to_date', '本地1.0.3不能因日期Tag9.26误报新版');
        assert.equal(market.getUpdatableMods().length, 0);
        assert.equal(mod.version, '9.26', '检测不能改写统一目录原始版本');

        localVersion = '1.0.2';
        assert.equal(market.checkModInstallStatus(mod), 'update_available');
        const elements = new Map(['modHubMarketCardsContainer', 'modHubMarketStats'].map(id => [id, createStubElement()]));
        const cards = elements.get('modHubMarketCardsContainer'), ignoreOnce = createStubElement('button');
        ignoreOnce.dataset = { modIndex: '0', ignoreMode: 'once' };
        cards.querySelectorAll = selector => selector === '.btn-market-ignore' ? [ignoreOnce] : [];
        sb.document.getElementById = id => elements.get(id) || null;
        const notifications = [];
        sb.modHubNotifyUpdateState = (count, list) => notifications.push({ count, list });
        market.renderMarketCards();
        assert.ok(cards.innerHTML.includes('发现新版') && cards.innerHTML.includes('最新版本：v1.0.3'), '卡片应采用目录核验安装包1.0.3版号');
        assert.ok(!cards.innerHTML.includes('最新版本：v9.26'), '卡片不能把发布日期当作模组版本');
        assert.ok(/仅忽略\s+v?1\.0\.3/.test(cards.innerHTML));
        assert.equal(notifications.at(-1).list[0].newVersion, '1.0.3', '管理页徽标必须共用真实包版号');
        assert.equal(market.getUpdatableMods()[0].newVersion, '1.0.3', '管理页直接更新和全部更新必须共用真实包版号');
        await ignoreOnce.onclick();
        assert.equal(market.getIgnoredUpdates()[mod.name], '1.0.3', '忽略本次应记录安装包版号，不能记录日期Tag');
        assert.equal(market.getUpdatableMods().length, 0);
        market.setModUpdateIgnored(mod.name, '', false);
        market.setModUpdateIgnored('通用战斗美化-zed修复', '', false);

        releases = [makeRelease(['UCB-zedfix-1.0.2.zip', 'UCB-zedfix-1.0.4.zip', 'UCB-zedfix-1.0.3.zip'])];
        const unordered = { ...mod, id: 'unlabelled-unordered' };
        market.checkModInstallStatus(unordered);
        await market.getModUpdateInfo(unordered).promise;
        assert.equal(market.getModUpdateInfo(unordered).version, '1.0.4', '单一系列声明适配时应按模组版号选择最高候选，不能按资产顺序选择');

        releases = [{ ...makeRelease(['UCB-zedfix-1.0.4.zip']), compatibility: undefined }];
        const unknownCompatibility = { ...mod, id: 'date-tag-unknown-compatibility' };
        market.checkModInstallStatus(unknownCompatibility);
        await market.getModUpdateInfo(unknownCompatibility).promise;
        assert.equal(market.getModUpdateInfo(unknownCompatibility).version, '1.0.4', '单一系列无适配声明时，更新提醒仍使用真实包版号');
        assert.equal(market.checkModInstallStatus(unknownCompatibility), 'update_available');
        assert.equal(versions.buildCandidates(unknownCompatibility, { releases: [{ ...releases[0], compatibility: null }] }).length, 0,
            '非法适配数据仍须排除，不能当作缺少声明提示更新');

        releases = [makeRelease(['UCB-zedfix-EN-1.0.3.zip', 'UCB-zedfix-CN-1.0.4.zip'])];
        const ambiguous = { ...mod, id: 'unlabelled-multiple-series' };
        market.checkModInstallStatus(ambiguous);
        await market.getModUpdateInfo(ambiguous).promise;
        assert.ok(!market.getModUpdateInfo(ambiguous).version && !market.getModUpdateInfo(ambiguous).release);
        assert.notEqual(market.checkModInstallStatus(ambiguous), 'update_available', '无适配声明的多语言系列不能猜测更新目标或回退目录9.26');

        releases = [];
        const noPackage = { ...mod, id: 'unlabelled-no-package' };
        market.checkModInstallStatus(noPackage);
        await market.getModUpdateInfo(noPackage).promise;
        assert.ok(!market.getModUpdateInfo(noPackage).version);
        assert.notEqual(market.checkModInstallStatus(noPackage), 'update_available', '历史没有可安装候选时不得回退目录9.26误报更新');
        assert.equal(mod.version, '9.26');
    }

    /* =========================================================================
     * 11. 模组安装分流：市场安装「稍后重载」不得切走页签
     * ========================================================================= */
    {
        // 11.1 市场安装路径必须声明 keepCurrentTab（防止回归）
        const marketSource = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-market.js'), 'utf8');
        const marketCall = marketSource.match(/modHubHandleAddMod\([^)]*?\{[\s\S]*?\}\)/);
        assert.ok(marketCall && marketCall[0].includes('keepCurrentTab: true'), '市场安装调用必须传递 keepCurrentTab: true');
        // 11.2 管理页本地导入路径不得携带 keepCurrentTab（保持原有高亮跳转设计）
        const managerSource = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-manager.js'), 'utf8');
        const importCalls = managerSource.match(/modHubHandleAddMod\([^)]*?\{[^}]*?\}\)/g) || [];
        assert.ok(importCalls.length >= 4, '管理器本地导入调用点必须存在');
        for (const call of importCalls) {
            assert.ok(!call.includes('keepCurrentTab'), `本地导入不得携带 keepCurrentTab: ${call.slice(0, 80)}`);
        }
        // 11.3 分支结构断言：keepCurrentTab 分支只提示不跳页，本地导入分支保留原高亮跳转设计
        const keepBranch = managerSource.match(/else if \(options\.keepCurrentTab\) \{[\s\S]*?\} else \{/);
        assert.ok(keepBranch, '稍后重载分支必须包含 keepCurrentTab 专用处理');
        assert.ok(!keepBranch[0].includes('modHubSwitchTab('), 'keepCurrentTab 分支严禁切换页签');
        const legacyBranch = managerSource.match(/\} else \{\s*window\._modHubHighlightMods[\s\S]*?modHubSwitchTab\('模组管理', \{ skipReloadPrompt: true \}\)/);
        assert.ok(legacyBranch, '本地导入分支必须保留「切换管理页并高亮」的原有设计');
    }

    /* =========================================================================
     * 12. 模组市场已移除仓库（404）与无 Release 更新判定防护
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;

        // 12.1 作者已移除 GitHub 仓库（isDeadRepo）时，即使远程有更高版本，也绝不误报更新，返回 up_to_date
        const deadRepoMod = {
            name: '织境空间·料理扩展',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '0.4.19',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const profiles = [{
            name: 'WovenRealmCookingAddon',
            version: '0.1.626',
            displayNames: ['WovenRealmCookingAddon', '织境空间-料理扩展', '织境空间·料理扩展'],
            normalizedNames: ['wovenrealmcookingaddon', '织境空间料理扩展'],
            repos: ['wovenrealmcookingaddon'],
            repositoryKeys: ['kanna-hanabi/wovenrealm']
        }];
        const deadStatus = market.checkModInstallStatus(deadRepoMod, profiles);
        assert.equal(deadStatus, 'up_to_date', '作者已移除仓库的模组本地已安装时必须判定为已是最新（up_to_date），严禁误报更新');

        // 12.2 仓库失效且未安装时，无外部链接必须返回 unavailable，有外部链接返回 external_only
        const deadNotInstalled = {
            name: '某个已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadNotInstalled, []), 'unavailable', '已删库且无外部链接未安装模组必须返回 unavailable');
        const deadWithOtherUrl = {
            name: '带网盘的已删库模组',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm',
            otherUrl: 'https://example.com/pan',
            version: '1.0.0',
            _isDeadRepo: true
        };
        assert.equal(market.checkModInstallStatus(deadWithOtherUrl, []), 'external_only', '已删库但有外部链接未安装模组必须返回 external_only');

        // 当前仓库、正式发布与附件均不可访问时，历史可信记录不能让新玩家默认下载安装。
        const modCenterSource = 'https://github.com/102326/DoL-Mod-Center/releases/download/v2.3.2/DoLModCenter-2.3.2.mod.zip';
        const modCenter = { id: 'dol-mod-center', identityId: 'dol-mod-center', name: 'DoL Mod Center',
            bootNames: ['DoLModCenter'], repositoryKeys: ['102326/dol-mod-center'], catalogSource: 'community',
            sourcePlatform: 'github', autoInstall: true, sourceUrl: modCenterSource, githubUrl: modCenterSource,
            version: '2.3.2', versionSource: 'github', releaseUrl: 'https://github.com/102326/DoL-Mod-Center/releases/tag/v2.3.2' };
        assert.ok(market.isDeadRepo(modCenter.githubUrl, modCenter), '没有本地失效记录的新玩家也须识别当前不可访问仓库');
        assert.ok(market.isDeadRepo('https://github.com/102326/DOL-MOD-CENTER/releases/tag/v2.3.2'), '失效仓库键须沿用大小写归一化');
        assert.ok(market.hasCommunityReleaseSource(modCenter), '历史安装资格仍保留，失效保护不改目录和包记录');
        assert.equal(market.checkModInstallStatus(modCenter, []), 'unavailable', '当前失效仓库不能显示默认下载状态');
        assert.equal(market.isBatchInstallEligible(modCenter, []), false, '当前失效仓库不能加入批量安装');
        assert.equal(market.checkModInstallStatus({ ...modCenter, otherUrl: 'https://discord.com/channels/1103864219620884560/1553436520944238612' }, []),
            'external_only', '关闭失效隐藏后仍保留原帖人工核对入口');
        assert.equal(market.checkModInstallStatus(modCenter, [{ name: 'DoLModCenter', version: '2.3.1' }]),
            'up_to_date', '当前失效仓库不能凭历史更高版本向已安装玩家推荐更新');

        // 12.3 无有效 Release 产物且版本来源为 Wiki 时，不误报更新
        const wikiOnlyMod = {
            name: '纯Wiki旧版本模组',
            githubUrl: 'https://github.com/some-author/no-release-mod',
            version: '2.0.0',
            versionSource: 'wiki',
            releaseUrl: null
        };
        const localModProfiles = [{
            name: '纯Wiki旧版本模组',
            version: '1.0.0',
            displayNames: ['纯Wiki旧版本模组'],
            normalizedNames: ['纯wiki旧版本模组'],
            repos: ['no-release-mod'],
            repositoryKeys: ['some-author/no-release-mod']
        }];
        assert.equal(market.checkModInstallStatus(wikiOnlyMod, localModProfiles), 'up_to_date', '无可用 Release 的 Wiki 参考版本模组不得误报 update_available');

        // 12.4 正常具备 GitHub Release 且版本更高时，必须正确触发 update_available
        const validReleaseMod = {
            name: '正常可更新模组',
            githubUrl: 'https://github.com/normal-author/good-mod',
            version: '2.0.0',
            versionSource: 'github',
            releaseUrl: 'https://github.com/normal-author/good-mod/releases/tag/v2.0.0'
        };
        const validLocalProfiles = [{
            name: '正常可更新模组',
            version: '1.0.0',
            displayNames: ['正常可更新模组'],
            normalizedNames: ['正常可更新模组'],
            repos: ['good-mod'],
            repositoryKeys: ['normal-author/good-mod']
        }];
        assert.equal(market.checkModInstallStatus(validReleaseMod, validLocalProfiles), 'update_available', '具有真实 Release 的更高版本模组必须正常触发 update_available');

        // 12.5 同作者多个模组自动识别为失效（织境空间主模组与场景互动扩展）
        const uiMod = {
            name: '织境空间-场景互动扩展',
            author: '璐子',
            githubUrl: 'https://github.com/Kanna-hanabi/WovenRealmUI',
            version: '0.8.7',
            versionSource: 'wiki',
            releaseUrl: null
        };
        assert.ok(market.isDeadRepo(uiMod.githubUrl, uiMod), '同作者扩展模组仓库 WovenRealmUI 必须被识别为已失效');
        assert.equal(market.checkModInstallStatus(uiMod, []), 'unavailable', '已失效的场景互动扩展未安装时必须返回 unavailable');

        // 12.6 样式表必须包含 .badge-dead-repo 红色标签样式
        const cssContent = readStyles();
        assert.ok(cssContent.includes('.badge-dead-repo'), 'CSS 必须定义 .badge-dead-repo 红色标签样式');

        // 12.7 市场脚本中必须导出并正确引用 badge-dead-repo
        const marketJs = fs.readFileSync(path.join(srcRoot, 'javascript', 'modhub-market.js'), 'utf8');
        assert.ok(marketJs.includes('badge-dead-repo'), '市场卡片渲染必须应用 badge-dead-repo');

        // 12.8 消除误诊：单字符短横线合法仓库（如 dawalizhang/- 与 lingyu230514/-）严禁被误判为失效
        const ranchMod = {
            name: '牧场与你相识的故事',
            author: '海苔大福&达瓦里张&多玩',
            githubUrl: 'https://github.com/dawalizhang/-',
            version: '1.0.0'
        };
        const newSpaceMod = {
            name: '全新空间',
            author: '多玩',
            githubUrl: 'https://github.com/lingyu230514/-',
            version: '1.04'
        };
        assert.equal(market.isDeadRepo(ranchMod.githubUrl, ranchMod), false, '牧场与你相识的故事严禁被误判为源失效');
        assert.equal(market.isDeadRepo(newSpaceMod.githubUrl, newSpaceMod), false, '全新空间严禁被误判为源失效');
        assert.equal(market.checkModInstallStatus(ranchMod, []), 'not_installed', '牧场与你相识的故事未安装时必须为 not_installed 允许下载');
        assert.equal(market.checkModInstallStatus(newSpaceMod, []), 'not_installed', '全新空间未安装时必须为 not_installed 允许下载');

        // 12.9 历史存储误诊自愈清洗能力断言
        sb.localStorage.setItem('modhub_market_dead_repos_v1', JSON.stringify(['dawalizhang/-', 'kanna-hanabi/wovenrealm']));
        const cleanedList = market.getDeadRepos();
        assert.ok(!cleanedList.includes('dawalizhang/-'), '活跃白名单仓库必须自动从失效存储中清洗剔除');
        assert.ok(cleanedList.includes('kanna-hanabi/wovenrealm'), '真正失效的仓库必须继续保留');

        assert.ok(cleanedList.includes('102326/dol-mod-center'), '新增已核验失效仓库仍沿用原名单机制');
        market.markRepoAsDead('https://github.com/ModHubTests/TransientSource');
        assert.ok(market.isDeadRepo('modhubtests/transientsource'), '临时失效检测仍须登记仓库');
        market.unmarkRepoAsDead('https://github.com/ModHubTests/TransientSource');
        assert.equal(market.isDeadRepo('modhubtests/transientsource'), false, '未列入固定失效名单的仓库恢复后仍可解除标记');

        // 12.10 本地安装 GuideToMe 等模组被市场准确识别为已安装
        const mouthMod = {
            name: '控制NPC嘴部',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/DOL-GuideToMe',
            version: '1.1.0'
        };
        const simsMod = {
            name: '模拟人生',
            author: '丧心',
            githubUrl: 'https://github.com/MissedHeart/Degrees-of-Lewdity-DolSims',
            version: '0.8.1.7'
        };
        const wraithMod = {
            name: '怨灵的倒影',
            author: '水墨儿（悠飘过去了）',
            githubUrl: 'https://github.com/Water2311/WraithsReflection/',
            version: '1.3.0'
        };
        const busMod = {
            name: '公交车防骚扰',
            author: 'Ayndpa',
            githubUrl: 'https://github.com/Ayndpa/NoBusHarassmentMod',
            version: '1.0.3'
        };

        const testProfiles = [
            { name: 'GuideToMe', version: '1.1.0' },
            { name: 'DoLSims', version: '0.8.1.7' },
            { name: 'Wraith\'sReflection', version: '1.3.0' },
            { name: 'NoBusHarassmentMod', version: '1.0.3' },
            { name: 'ModHub', version: '1.0.2' }
        ];

        assert.equal(market.checkModInstallStatus(mouthMod, testProfiles), 'up_to_date', 'GuideToMe 本地已安装时，市场控制NPC嘴部必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(simsMod, testProfiles), 'up_to_date', 'DoLSims 本地已安装时，市场模拟人生必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(wraithMod, testProfiles), 'up_to_date', 'Wraith\'sReflection 本地已安装时，市场怨灵的倒影必须识别为 up_to_date');
        assert.equal(market.checkModInstallStatus(busMod, testProfiles), 'up_to_date', 'NoBusHarassmentMod 本地已安装时，市场公交车防骚扰必须识别为 up_to_date');

        // 12.11 管理页 modHubGetModSubtext 智能副标题与简介回填测试
        const fullSb = loadManager();
        loadScripts(fullSb, ['javascript/modhub-market.js']);

        assert.equal(fullSb.window.modHubGetModSubtext('GuideToMe', { bootJson: { version: '1.1.0' } }), '控制NPC嘴部', 'GuideToMe 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('DoLSims', { bootJson: { version: '0.8.1.7' } }), '模拟人生', 'DoLSims 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('Wraith\'sReflection', { bootJson: { version: '1.3.0' } }), '怨灵的倒影', 'Wraith\'sReflection 必须能获取友好副标题');
        assert.equal(fullSb.window.modHubGetModSubtext('ModHub', { bootJson: bootJson }), '模组管理器与市场套件', 'ModHub 必须显示自身副标题');

        // 12.12 动态市场回填测试：未知本地模组通过市场条目自动回填中文名称或简介
        fullSb.window.modHubMarket.findMarketModByLocalName = (localName) => {
            if (localName === 'SomeUnknownMod') {
                return { name: '未知超强扩展', desc: '用于增强各种交互功能的拓展' };
            }
            return null;
        };
        assert.equal(fullSb.window.modHubGetModSubtext('SomeUnknownMod', { bootJson: { version: '1.0.0' } }), '未知超强扩展', '未知模组必须能联动市场数据自动回填副标题');

        // 12.13 模组市场与本地模组防混淆测试（针对 ImageLoaderHook 与 D.O.L.I 字母拼合假阳性拦截）
        const doliMarketMod = {
            name: 'D.O.L.I',
            author: 'ArsNativa',
            githubUrl: 'https://github.com/ArsNativa/Degrees-of-Lewdity-Intelligence',
            repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence'],
            version: '0.2.3'
        };

        const imageHookProfiles = [
            {
                name: 'ModLoader DoL ImageLoaderHook',
                version: '2.101.0',
                displayNames: ['ModLoader DoL ImageLoaderHook'],
                normalizedNames: ['modloaderdolimageloaderhook'],
                repos: ['modloaderdolimageloaderhook'],
                repositoryKeys: []
            },
            {
                name: 'ModSubUiAngularJs',
                version: '1.0.0',
                displayNames: ['ModSubUiAngularJs'],
                normalizedNames: ['modsubuiangularjs'],
                repos: ['modsubuiangularjs'],
                repositoryKeys: []
            }
        ];

        // 仅安装 ImageLoaderHook 时，D.O.L.I 必须准确识别为 not_installed
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, imageHookProfiles),
            'not_installed',
            '本地仅安装 ImageLoaderHook 时，市场中的 D.O.L.I 必须为 not_installed，绝不能误判为 up_to_date'
        );

        // findMarketModByLocalName 反查时，ImageLoaderHook 绝不能反向匹配到 D.O.L.I
        const reversedMarketMod = market.findMarketModByLocalName('ModLoader DoL ImageLoaderHook', [doliMarketMod]);
        assert.equal(
            reversedMarketMod,
            null,
            'ImageLoaderHook 在模组市场反向检索中必须返回 null，不得误匹配到 D.O.L.I'
        );

        // 同一包内版本可能对应不同发布内容，不能仅凭作者漏改版本号认定最新。
        const realDoliProfiles = [
            {
                name: 'DOLI',
                version: '0.2.2',
                displayNames: ['DOLI', 'D.O.L.I', 'Degrees-of-Lewdity-Intelligence'],
                normalizedNames: ['doli', 'degreesoflewdityintelligence'],
                repos: ['doli', 'degreesoflewdityintelligence'],
                repositoryKeys: ['arsnativa/degrees-of-lewdity-intelligence']
            }
        ];
        assert.equal(
            market.checkModInstallStatus(doliMarketMod, realDoliProfiles),
            'update_available',
            'DOLI 0.2.2 未有包体一致证据时，不能冒认为 0.2.3 已安装'
        );
        const realMatchedMarket = market.findMarketModByLocalName('DOLI', [doliMarketMod]);
        assert.ok(
            realMatchedMarket && realMatchedMarket.name === 'D.O.L.I',
            '本地 DOLI 必须能准确反向找到市场中的 D.O.L.I'
        );
    }

    // 共享仓库多模组身份规范、防重名消歧与智能手机 Omega 隔离契约测试
    {
        const catalog = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8'));
        const repoMap = new Map();
        for (const mod of catalog.mods) {
            for (const repo of mod.repositoryKeys || []) {
                const key = String(repo).toLowerCase();
                if (!repoMap.has(key)) repoMap.set(key, []);
                repoMap.get(key).push(mod);
            }
        }

        // 契约 1：同一仓库若登记了多个模组，必须全部明确标记 sharedRepository: true，且技术名必须互斥
        for (const [repoKey, mods] of repoMap.entries()) {
            if (mods.length > 1) {
                for (const mod of mods) {
                    assert.equal(
                        mod.sharedRepository,
                        true,
                        `共享仓库【${repoKey}】下的模组【${mod.name}】(${mod.id}) 必须声明 sharedRepository: true`
                    );
                }
                const bootNameSet = new Set();
                for (const mod of mods) {
                    for (const bootName of mod.bootNames || []) {
                        const bKey = String(bootName).toLowerCase();
                        assert.ok(
                            !bootNameSet.has(bKey),
                            `共享仓库【${repoKey}】下的不同模组不能共享相同的 bootName:【${bootName}】`
                        );
                        bootNameSet.add(bKey);
                    }
                }
            }
        }

        const market = loadMarket().modHubMarket;

        // 契约 2：原始 release-index 中的万能的智能手机与 Omega 在经 normalizeReleaseIndex 规范化后绝不重名、绝不串号
        const mockRawIndex = {
            schemaVersion: 1,
            identities: catalog.mods,
            mods: [
                {
                    id: 'smartphone',
                    name: '万能的智能手机',
                    wikiName: '万能的智能手机',
                    repo: 'anlinstudio/degrees-of-lewdity-dolsmartphone',
                    githubUrl: 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone',
                    sourceUrl: 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone',
                    version: '0.3.85',
                    category: '玩法与内容',
                    tags: ['社交', '剧情', 'NPC']
                },
                {
                    id: '万能的智能手机omega-degrees-of-lewdity-dolsmartphone',
                    name: '万能的智能手机 OmegaΩ',
                    wikiName: '万能的智能手机 OmegaΩ',
                    repo: 'anlinstudio/degrees-of-lewdity-dolsmartphone',
                    githubUrl: 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone/releases/tag/v.omega.1.0',
                    sourceUrl: 'https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone/releases/tag/v.omega.1.0',
                    version: '1.0',
                    category: '外观与资源',
                    tags: ['服装']
                }
            ]
        };

        const normalizedMods = market.normalizeReleaseIndex(mockRawIndex);
        assert.equal(normalizedMods.length, 2, '必须保留两个独立模组');

        const [normOriginal, normOmega] = normalizedMods;
        assert.notEqual(normOriginal.name, normOmega.name, '本体与 Omega 绝不能被覆盖成相同名称');
        assert.equal(normOriginal.name, '万能的智能手机', '本体模组名称必须保持为万能的智能手机');
        assert.ok(
            normOmega.name.includes('Omega'),
            `Omega 模组名称必须包含 Omega 标识，实际为:【${normOmega.name}】`
        );
        assert.equal(normOriginal.sharedRepository, true, '本体必须标记为 sharedRepository');
        assert.equal(normOmega.sharedRepository, true, 'Omega 必须标记为 sharedRepository');
        assert.ok(
            normOriginal.bootNames.includes('SmartPhone') || normOriginal.bootNames.includes('SmartPhone Alpha'),
            '本体必须包含 SmartPhone bootNames'
        );
        assert.ok(
            normOmega.bootNames.includes('SmartPhone Omega'),
            'Omega 必须包含独立的 SmartPhone Omega bootNames'
        );
        assert.ok(
            !normOmega.bootNames.includes('SmartPhone'),
            'Omega 绝对不能包含本体的 SmartPhone 技术名'
        );
        assert.ok(
            !normOriginal.bootNames.includes('SmartPhone Omega'),
            '本体绝对不能包含 Omega 的 SmartPhone Omega 技术名'
        );

        // 契约 3：安装状态防串号匹配验证
        // 情况 A: 本地仅安装本体 SmartPhone (v1.0.0)
        const localOriginalOnly = [
            {
                name: 'SmartPhone',
                version: '1.0.0',
                displayNames: ['SmartPhone', '万能的智能手机'],
                normalizedNames: ['smartphone', '万能的智能手机'],
                repos: ['smartphone', 'degreesoflewditydolsmartphone'],
                repositoryKeys: ['anlinstudio/degrees-of-lewdity-dolsmartphone']
            }
        ];
        const statusOrigA = market.checkModInstallStatus(normOriginal, localOriginalOnly);
        const statusOmegaA = market.checkModInstallStatus(normOmega, localOriginalOnly);
        assert.ok(
            ['up_to_date', 'update_available'].includes(statusOrigA),
            '本地安装 SmartPhone 时，本体卡片必须正确匹配为已安装状态'
        );
        assert.equal(
            statusOmegaA,
            'not_installed',
            '本地仅安装 SmartPhone 时，Omega 卡片必须严格为 not_installed，绝不能发生串号匹配'
        );
        assert.equal(normOmega._matchedLocal, null, 'Omega 卡片不能关联到本体的本地档案');

        // 情况 B: 本地仅安装 SmartPhone Omega (v1.0)
        const localOmegaOnly = [
            {
                name: 'SmartPhone Omega',
                version: '1.0',
                displayNames: ['SmartPhone Omega', '万能的智能手机 OmegaΩ', '万能的智能手机 简化版'],
                normalizedNames: ['smartphoneomega', '万能的智能手机omega', '万能的智能手机omegaω'],
                repos: ['smartphoneomega', 'degreesoflewditydolsmartphone'],
                repositoryKeys: ['anlinstudio/degrees-of-lewdity-dolsmartphone']
            }
        ];
        const statusOrigB = market.checkModInstallStatus(normOriginal, localOmegaOnly);
        const statusOmegaB = market.checkModInstallStatus(normOmega, localOmegaOnly);
        assert.equal(
            statusOrigB,
            'not_installed',
            '本地仅安装 SmartPhone Omega 时，本体卡片必须严格为 not_installed，绝不能发生反向误匹配'
        );
        assert.ok(
            ['up_to_date', 'update_available'].includes(statusOmegaB),
            '本地安装 SmartPhone Omega 时，Omega 卡片必须正确匹配为已安装状态'
        );
        assert.equal(normOriginal._matchedLocal, null, '本体卡片不能关联到 Omega 的本地档案');

        // 契约 4：同名自动消歧防御测试
        const duplicateIndex = {
            schemaVersion: 1,
            identities: [],
            mods: [
                {
                    id: 'sample-mod-main',
                    name: '测试模组',
                    wikiName: '测试模组',
                    sourceUrl: 'https://github.com/Sample/Repo/releases/tag/v1.0'
                },
                {
                    id: 'sample-mod-addon',
                    name: '测试模组',
                    wikiName: '测试模组 附加包',
                    sourceUrl: 'https://github.com/Sample/Repo/releases/tag/v2.0'
                }
            ]
        };
        const disambiguated = market.normalizeReleaseIndex(duplicateIndex);
        assert.notEqual(
            disambiguated[0].name,
            disambiguated[1].name,
            '当不同条目出现同名冲突时，防重名防御安全网必须自动消解歧义，生成不重复的名称'
        );
    }

};
