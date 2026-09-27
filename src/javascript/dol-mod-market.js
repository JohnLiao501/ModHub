/**
 * ModHub - 模组市场核心服务与界面交互模块
 * 
 * 功能：
 * 1. Wiki 模组列表获取与容错解析（带本地缓存、主分类与内容标签）；
 * 2. GitHub Release 检索与国内镜像加速支持（排除源码包）；
 * 3. 本地已安装状态智能比对（识别未安装、已是最新、可更新）；
 * 4. 一键下载二进制流并自动旁加载写入 IndexedDB；
 * 5. DoL 原生暗黑风格界面与移动端窄屏流式适配（严格遵循 0 Emoji 红线）。
 */

(function() {
    'use strict';

    const WIKI_API = 'https://degreesoflewditycn.miraheze.org/w/api.php';
    const WIKI_PAGE = '模组列表';
    const WIKI_CACHE_KEY = 'dol_opt_market_wiki_v5';
    const WIKI_CACHE_TTL = 30 * 60 * 1000; // 30 分钟
    const PRIMARY_RELEASE_INDEX_URL = 'https://dol.alseece.top/release-index.json';
    const BACKUP_RELEASE_INDEX_URL = 'https://dolmod-release-index.johnliao381658675.workers.dev/release-index.json';
    const RELEASE_WORKER_API_BASE = 'https://dolmod-release-index.johnliao381658675.workers.dev';
    const RELEASE_INDEX_URL = PRIMARY_RELEASE_INDEX_URL;
    const RELEASE_INDEX_MIRRORS = [
        PRIMARY_RELEASE_INDEX_URL,
        BACKUP_RELEASE_INDEX_URL
    ];
    let activeReleaseWorkerBaseUrl = PRIMARY_RELEASE_INDEX_URL;
    const IDENTITY_CATALOG_URL = 'https://dolmod-catalog-pages.pages.dev/mod-identities.json';
    const IDENTITY_CACHE_KEY = 'dol_opt_market_identities_v3';
    const IDENTITY_FETCH_TIMEOUT_MS = 8000;
    const README_FETCH_TIMEOUT_MS = 8000;
    const RELEASE_CACHE_PREFIX = 'dol_opt_market_rel_v2_';
    const RELEASE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
    const IGNORE_STORAGE_KEY = 'dol_opt_market_ignored_updates_v1';
    const CONFIRMED_STORAGE_KEY = 'dol_opt_market_confirmed_updates_v1';
    const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
    const COMPANION_ASSET_PATTERN = /(?:photo|image|resource|asset)[\s._-]*pack|图包|图片包|资源包|素材包/i;

    // 针对社区个别模组作者打包失误（如 Release 为新版但内部 boot.json 未递增）或 Wiki 录入虚高版本的容错规则库
    const MOD_MARKET_VERSION_RULES = [
        {
            // D.O.L.I: 远程 Release v0.2.3 资产包内 boot.json 未修改版本号仍写 0.2.2
            name: 'D.O.L.I',
            match: (name, repo) => /^(d\.?o\.?l\.?i|degreesoflewdityintelligence)$/i.test(name) || repo === 'degreesoflewdityintelligence',
            isUpToDate: (localVer, remoteVer) => {
                // 本地只要已安装 >= 0.2.2，且当前远程 <= 0.2.3，即认定为已是最新
                return compareVersions(localVer, '0.2.2') >= 0 && compareVersions(remoteVer, '0.2.3') <= 0;
            }
        },
        {
            // 惠特尼剧情扩展: Wiki 词条误录为 v1.0，实际仓库与作者最新发布版为 0.3.1
            name: '惠特尼剧情扩展',
            match: (name, repo) => name.includes('惠特尼') || repo === 'whitneyexpansion',
            isUpToDate: (localVer, remoteVer) => {
                // 本地只要已安装 >= 0.3.1，即认定为已是最新
                return compareVersions(localVer, '0.3.1') >= 0;
            }
        },
        {
            // 强势罗宾扩展: Release 0.08 的包内版本实际写作 0.0.8
            name: '强势罗宾扩展',
            match: (name, repo) => name === 'domrobin' || repo === 'degreesoflewdityrobinmod',
            isUpToDate: (localVer, remoteVer) =>
                compareVersions(localVer, '0.0.8') >= 0 && /^v?0\.08(?:$|[-+_])/i.test(String(remoteVer).trim())
        },
        {
            // 悉尼裸体学习: Release v1.5 的包内 boot.json 仍写 0.1
            name: '悉尼裸体学习',
            match: (name, repo) => name === 'sydneybarestudymod' || repo === 'dolsydneybarestudymod',
            isUpToDate: (localVer, remoteVer) =>
                compareVersions(localVer, '0.1') >= 0 && /^v?1\.5(?:$|[-+_])/i.test(String(remoteVer).trim())
        },
        {
            // 织境空间系列模组: 作者已移除 GitHub 仓库 (404)，且 Wiki 词条录入的料理扩展历史版本 (0.4.19) 虚高且无可用发布
            name: '织境空间',
            match: (name, repo) => name.includes('织境') || (repo && repo.includes('wovenrealm')),
            isUpToDate: (localVer, remoteVer) => true // 本地只要已安装即视为已是最新，绝不误报更新
        }
    ];

    function getIgnoredUpdates() {
        try {
            return JSON.parse(localStorage.getItem(IGNORE_STORAGE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function setModUpdateIgnored(modName, version, ignored = true) {
        if (!modName) return;
        const map = getIgnoredUpdates();
        if (ignored) {
            map[modName] = version || 'ignored';
        } else {
            delete map[modName];
        }
        try {
            localStorage.setItem(IGNORE_STORAGE_KEY, JSON.stringify(map));
        } catch (_) {}
    }

    function getConfirmedUpdates() {
        try {
            return JSON.parse(localStorage.getItem(CONFIRMED_STORAGE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function setModUpdateConfirmed(modName, version) {
        if (!modName || !version) return;
        const map = getConfirmedUpdates();
        map[modName] = version;
        try {
            localStorage.setItem(CONFIRMED_STORAGE_KEY, JSON.stringify(map));
        } catch (_) {}
    }

    // 社区知名模组全能中英文别名与关联仓库映射词库（用于 Wiki 词条与本地技术模组精准比对）
    const DOL_OPT_KNOWN_MOD_MARKET_ALIASES = {
        '原版优化': ['原版优化opt', 'doloptimization', 'degreesoflewditydoloptimization'],
        'doloptimization': ['原版优化', '原版优化opt', 'degreesoflewditydoloptimization'],
        'cummilk': ['风味自制奶', 'dolmodcummilk'],
        'doli': ['d.o.l.i', 'degreesoflewdityintelligence'],
        'dynamicest': ['极致动态dynamicest', '极致动态', 'degreesoflewditydoldynamicest'],
        'moreloveinterestsmod': ['更多恋人', 'dolmoreloveinterestsmod'],
        'morefarmupgrade': ['更多农场升级', 'dolmorefarmupgrademod'],
        'smartphonealpha': ['万能的智能手机', '智能手机', 'smartphone', 'degreesoflewditydolsmartphone'],
        'smartphone': ['万能的智能手机', '智能手机', 'smartphone', 'degreesoflewditydolsmartphone'],
        '万能的智能手机': ['smartphonealpha', 'smartphone', '智能手机', 'degreesoflewditydolsmartphone'],
        '智能手机': ['smartphonealpha', 'smartphone', '万能的智能手机', 'degreesoflewditydolsmartphone'],
        'phonemod': ['手机', 'dolphonemod'],
        'dolphonemod': ['手机', 'phonemod'],
        '手机': ['phonemod', 'dolphonemod'],
        'dolarcadeexpansion': ['遊戲廳拓展', '游戏厅拓展', 'dolarcadeexpansion'],
        'maplebirch': ['秋枫白桦框架', 'scml-dol-maplebirchframework', 'scmldolmaplebirchframework'],
        'babyhawk': ['鹰宝宝', 'dolbabyhawkmod'],
        'dolquestassistant': ['欲都孤儿任务助手', 'dolquestassistant'],
        'domrobin': ['dom罗宾', 'degreesoflewdityrobinmod', 'robinmod'],
        'sydneybarestudymod': ['悉尼裸体学习', 'dolsydneybarestudymod', 'sydneybarestudy'],
        'whitneyexpansion': ['惠特尼剧情扩展', 'whitney'],
        'whitneyexpansion_': ['惠特尼剧情扩展', 'whitney'],
        'modi18n': ['本地化翻译', 'degreesoflewditymodi18nmod', 'i18nmod'],
        'wovenrealmcookingaddon': ['织境空间-料理扩展', '织境空间·料理扩展', 'wovenrealmcookingaddon', '料理扩展'],
        'aistorygen': ['织境空间', 'wovenrealm'],
        'npcavatarsmod': ['npc社交栏头像', 'dolnpciconmods', 'npcavatarsmod'],
        'autoclean': ['自动清洁', '自动清洁身体污垢'],
        'autoclothesrepair': ['自动修衣', '衣物破损自动修补'],
        'autoschool': ['自动上学', '自动上课与学校日常辅助'],
        'wardrobeincrementalexpansion': ['衣柜容量扩充', '大大大衣柜容量扩展', '扩建衣柜容量'],
        'baileysofficee': ['贝利办公室剧情扩展', '贝利办公室'],
        'extrarecipestudy': ['额外菜谱研习'],
        'gameoriginalimagepack': ['原版高清图像资源包'],
        'honestmarkets': ['诚实市场模组', '诚实市场'],
        'guidetome': ['控制npc嘴部', '控制嘴部', '引导嘴部', 'dolguidetome'],
        '控制npc嘴部': ['guidetome', 'dolguidetome'],
        'dolsims': ['模拟人生', 'degreesoflewditydolsims', 'sims'],
        '模拟人生': ['dolsims', 'degreesoflewditydolsims', 'sims'],
        'wraithsreflection': ['怨灵的倒影', '幽灵倒影', '怨灵倒影', 'wraithreflection'],
        '怨灵的倒影': ['wraithsreflection', 'wraithreflection'],
        'nobusharassmentmod': ['公交车防骚扰', 'nobusharassment'],
        '公交车防骚扰': ['nobusharassmentmod', 'nobusharassment'],
        'modhub': ['modhub模组管理中心', 'modhub模组管理', 'modhub模组管理器'],
        'modhub模组管理中心': ['modhub', 'modhub模组管理'],
        'simpleframework': ['简易框架', 'scmlsimpleframework', 'simpleframeworks'],
        'simpleframeworks': ['简易框架', 'scmlsimpleframework', 'simpleframework'],
        '简易框架': ['simpleframework', 'simpleframeworks', 'scmlsimpleframework'],
        'fishinglife': ['钓鱼人生', 'dolmodfishinglife'],
        '钓鱼人生': ['fishinglife', 'dolmodfishinglife'],
        'cattery': ['猫咖出租屋', 'degreesoflewditycattery'],
        '猫咖出租屋': ['cattery', 'degreesoflewditycattery'],
        'evilcockroach': ['邪恶蟑螂', '邪恶蟑螂桌宠', 'evilcockroachmod'],
        '邪恶蟑螂（桌宠）': ['evilcockroach', 'evilcockroachmod']
    };

    const MARKET_CATEGORIES = [
        '框架与前置',
        '剧情与角色',
        '玩法与内容',
        '界面与便利',
        '外观与资源',
        '规则与数值',
        '修复与兼容',
        '待分类'
    ];
    const DOL_OPT_KNOWN_MOD_CLASSIFICATIONS = {};
    const DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS = {};
    const DOL_OPT_IDENTITY_NAME_OWNERS = new Map();
    const DOL_OPT_AMBIGUOUS_IDENTITY_NAMES = new Set();
    const DOL_OPT_BOOT_IDENTITIES = new Map();
    const DOL_OPT_OFFLINE_REPOSITORIES = {
        modhub: ['JohnLiao501/ModHub'],
        'modhub模组管理中心': ['JohnLiao501/ModHub'],
        doloptimization: ['ANLINSTUDIO/Degrees-of-Lewdity-DolOptimization'],
        cummilk: ['Lethivia/DoL-mod-cummilk'],
        doli: ['ArsNativa/Degrees-of-Lewdity-Intelligence'],
        dynamicest: ['ANLINSTUDIO/Degrees-of-Lewdity-DolDynamicest'],
        moreloveinterestsmod: ['Nephthelana/DoL-More-Love-Interests-Mod'],
        smartphonealpha: ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        smartphone: ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        '万能的智能手机': ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        '智能手机': ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        phonemod: ['HCPTangHY/DOL-PhoneMod'],
        '手机': ['HCPTangHY/DOL-PhoneMod'],
        maplebirch: ['MaplebirchLeaf/SCML-DOL-maplebirchframework'],
        babyhawk: ['koooooiCarp/DOL-BabyHawk-Mod'],
        aistorygen: ['Kanna-hanabi/WovenRealm'],
        dolquestassistant: ['JohnLiao501/DoL-Quest-Assistant'],
        domrobin: ['ZeroRing233/Degrees-of-Lewdity-RobinMod'],
        sydneybarestudymod: ['koooooiCarp/DOL-Sydney-Bare-Study-Mod'],
        npcavatarsmod: ['Eudemonism00/DOL-npcicon-mods'],
        wovenrealmcookingaddon: ['Kanna-hanabi/WovenRealm'],
        whitneyexpansion: ['Ayusai31/WhitneyExpansion'],
        modi18n: ['Lyoko-Jeremie/Degrees-of-Lewdity_Mod_i18nMod'],
        '模拟人生': ['MissedHeart/Degrees-of-Lewdity-DolSims'],
        'dolsims': ['MissedHeart/Degrees-of-Lewdity-DolSims'],
        '控制NPC嘴部': ['Ayndpa/DOL-GuideToMe'],
        'guidetome': ['Ayndpa/DOL-GuideToMe'],
        '怨灵的倒影': ['Water2311/WraithsReflection'],
        'wraithsreflection': ['Water2311/WraithsReflection'],
        '公交车防骚扰': ['Ayndpa/NoBusHarassmentMod'],
        'nobusharassmentmod': ['Ayndpa/NoBusHarassmentMod'],
        '简易框架': ['emicoto/SCMLSimpleFramework'],
        'simpleframework': ['emicoto/SCMLSimpleFramework'],
        'simpleframeworks': ['emicoto/SCMLSimpleFramework'],
        '钓鱼人生': ['Future-R/DOLMOD-FishingLife'],
        'fishinglife': ['Future-R/DOLMOD-FishingLife'],
        'ModHub': ['JohnLiao501/ModHub'],
        'modhub': ['JohnLiao501/ModHub'],
        'ModHub模组管理中心': ['JohnLiao501/ModHub'],
        '猫咖出租屋': ['Maomaoi/Degrees-of-Lewdity-Cattery'],
        '邪恶蟑螂（桌宠）': ['LooopSpiner/Evil-Cockroach-Mod'],
        '电视': ['Lethivia/DoL-mod-tv'],
        '自由对话态度': ['zbf0/Free-Speech-Attitudes']
    };
    for (const [name, repositoryKeys] of Object.entries(DOL_OPT_OFFLINE_REPOSITORIES)) {
        const normalizedKeys = repositoryKeys.map(key => key.toLowerCase());
        [name, ...(DOL_OPT_KNOWN_MOD_MARKET_ALIASES[name] || [])].forEach(alias => {
            DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normalizeKey(alias)] = normalizedKeys;
        });
        normalizedKeys.forEach(key => {
            DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normalizeKey(key.split('/')[1])] = normalizedKeys;
        });
    }

    const CATEGORY_RULES = [
        ['修复与兼容', /错误修正|修正.{0,12}(问题|错误|异常)|修复.{0,12}(问题|错误|异常|显示)|避免.{0,12}(错误|报错)|兼容补丁/i],
        ['框架与前置', /前置模组|前置模板|基础库|用于模组创作|有助于模组创作|提供.{0,12}(接口|框架)/i],
        ['外观与资源', /美化|立绘|贴图|材质|sprite|\bart\b|icon|头像|模型|服装|衣服|发型|发色|染发|面部|光环/i],
        ['规则与数值', /作弊|言灵|无限|解除.{0,4}限制|取消.{0,6}限制|数值|倍速|时停|金钱|属性修改|规则调整/i],
        ['界面与便利', /界面|\bui\b|显示|侧边栏|快捷|自动|优化|面板|导航|翻译|本地化|按钮|任务助手|管理|管理器|管理中心|管理套件|modhub|mod[-_\s]?hub|\bmanager\b|\bqol\b/i],
        ['剧情与角色', /剧情|故事|角色|人物|\bnpc\b|恋爱|约会|结局|事件|互动/i],
        ['玩法与内容', /玩法|系统|机制|地图|地点|农场|战斗|钓鱼|物品|料理|内容|扩展|拓展|新增|转化/i]
    ];

    const TAG_RULES = [
        ['剧情', /剧情|故事|事件|结局/i],
        ['NPC', /\bnpc\b|角色|人物/i],
        ['恋爱', /恋爱|恋人|约会/i],
        ['地图', /地图|地点|场景/i],
        ['农场', /农场|园艺|种植/i],
        ['战斗', /战斗|遭遇战|\bhp\b|\bap\b/i],
        ['服装', /服装|衣服|衣物|衣柜|穿戴|饰品/i],
        ['发型', /发型|发色|染发|头发/i],
        ['头像', /头像|立绘/i],
        ['界面', /界面|\bui\b|侧边栏|面板|显示/i],
        ['管理', /管理|管理器|modhub|mod[-_\s]?hub|\bmanager\b/i],
        ['自动化', /自动|快捷/i],
        ['言灵', /言灵/i],
        ['数值', /数值|金钱|属性|倍速|时停/i],
        ['翻译', /翻译|本地化|汉化/i],
        ['料理', /料理|菜谱|烹饪/i]
    ];

    // 下载线路配置：经国内直连网络真实压测，DDLC 与 Boki 具备极速稳定且带 CORS 优势；自建反代专线与 GitHub 直连作为补充。
    const MIRROR_SERVERS = [
        { id: 'ddlc', name: '加速通道 1（DDLC 加速·推荐）', shortName: 'DDLC', prefix: 'https://gh.ddlc.top/' },
        { id: 'boki', name: '加速通道 2（Boki 高速）', shortName: 'Boki', prefix: 'https://github.boki.moe/' },
        { id: 'worker', name: '加速通道 3（自建反代专线）', shortName: '自建专线', prefix: '', useWorker: true },
        { id: 'github', name: 'GitHub 直连（浏览器）', shortName: 'GitHub', prefix: '', browserOnly: true }
    ];
    let currentMirrorId = 'ddlc';

    function resolveMirrorServer(mirrorId) {
        let normId = mirrorId;
        if (normId === 'jasonzeng') normId = 'ddlc';
        if (normId === 'llkk') normId = 'boki';
        if (normId === 'ghfast') normId = 'boki';
        return MIRROR_SERVERS.find(m => m.id === normId) || MIRROR_SERVERS[0];
    }

    // 内存数据缓存
    let marketModList = [];
    let currentCategory = 'all';
    let currentStatusFilter = 'all';
    let currentSortBy = 'date'; // 'date' | 'name'
    let currentSearchText = '';
    let isLoading = false;
    const batchInstallState = { selecting: false, selected: new Set(), running: false, stopRequested: false, current: '', completed: 0, total: 0 };

    function getMarketModKey(mod) {
        const repo = parseGithubRepo(mod?.githubUrl);
        const key = mod?.identityId || mod?.id || (repo?.key
            ? `${repo.key}${mod.sharedRepository ? `/${normalizeKey(mod.name)}` : ''}` : normalizeKey(mod?.name));
        return `${String(key).toLowerCase()}${repo?.releaseTag ? `@${repo.key}/releases/tag/${encodeURIComponent(repo.releaseTag)}` : ''}${repo?.assetName ? `/${encodeURIComponent(repo.assetName)}` : ''}`;
    }

    function isBatchInstallEligible(mod, profiles = getLocalInstalledProfiles()) {
        return Boolean(mod && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:[/?#]|$)/i.test(mod.githubUrl || '')
            && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod)
            && checkModInstallStatus(mod, profiles) === 'not_installed');
    }

    function getBatchSelectionState() {
        return { ...batchInstallState, selected: Array.from(batchInstallState.selected) };
    }

    function toggleBatchSelection(selecting = !batchInstallState.selecting) {
        if (batchInstallState.running) return;
        batchInstallState.selecting = Boolean(selecting);
        if (!batchInstallState.selecting) batchInstallState.selected.clear();
        renderMarketCards();
    }

    function setBatchModSelected(key, checked) {
        if (batchInstallState.running || !batchInstallState.selecting) return;
        const mod = marketModList.find(item => getMarketModKey(item) === key);
        if (checked && isBatchInstallEligible(mod)) batchInstallState.selected.add(key);
        else batchInstallState.selected.delete(key);
        document.querySelectorAll('.dol-opt-market-select').forEach(input => {
            input.checked = batchInstallState.selected.has(input.dataset.modKey);
            input.closest?.('.dol-opt-market-card')?.classList.toggle('is-batch-selected', input.checked);
        });
        renderBatchInstallToolbar();
    }

    function selectAllVisibleMods() {
        if (batchInstallState.running || !batchInstallState.selecting) return;
        const profiles = getLocalInstalledProfiles();
        filterAndSortMods().filter(mod => isBatchInstallEligible(mod, profiles)).forEach(mod => batchInstallState.selected.add(getMarketModKey(mod)));
        renderMarketCards();
    }

    function clearBatchSelection() {
        if (batchInstallState.running) return;
        batchInstallState.selected.clear();
        renderMarketCards();
    }

    function renderBatchInstallToolbar() {
        const state = batchInstallState;
        if (!state.running) {
            const profiles = getLocalInstalledProfiles();
            const eligibleKeys = new Set(marketModList.filter(mod => isBatchInstallEligible(mod, profiles)).map(getMarketModKey));
            for (const key of state.selected) if (!eligibleKeys.has(key)) state.selected.delete(key);
        }
        document.querySelectorAll('#dolOptMarketBtnRefresh, #dolOptMirrorSelect, .btn-market-install, .btn-market-update, .dol-opt-market-update-all, .dol-opt-market-select').forEach(control => {
            const mod = marketModList[Number(control.dataset?.modIndex)];
            control.disabled = state.running || Boolean(mod && activeDownloadControllers.has(mod.name));
        });
        const toolbar = document.getElementById('dolOptMarketBatchToolbar');
        if (!toolbar) return;
        const escapeHtml = window.dolOptEscapeHtml || (value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));
        const focusedId = toolbar.contains?.(document.activeElement) ? document.activeElement?.id : '';
        toolbar.classList.toggle('is-active', state.selecting || state.running);
        toolbar.classList.toggle('is-entry', !state.selecting && !state.running);
        if (state.running) {
            toolbar.innerHTML = `
                <div class="dol-opt-batch-status" role="status" aria-live="polite"><strong class="gold">批量安装 ${state.completed}/${state.total}</strong><span>${state.current ? `正在处理：${escapeHtml(state.current)}` : '正在准备安装计划'}</span></div>
                <progress class="dol-opt-batch-progress" max="${Math.max(1, state.total)}" value="${state.completed}" aria-label="批量安装总进度"></progress>
                <button id="dolOptBatchStop" type="button" class="macro-button dol-opt-btn-secondary" ${state.stopRequested ? 'disabled' : ''}>${state.stopRequested ? '当前项完成后停止' : '停止后续'}</button>`;
            const stopButton = document.getElementById('dolOptBatchStop');
            if (stopButton) stopButton.onclick = () => { state.stopRequested = true; renderBatchInstallToolbar(); };
        } else {
            toolbar.innerHTML = `
                <button id="dolOptBatchToggle" type="button" class="macro-button ${state.selecting ? 'dol-opt-btn-secondary' : 'dol-opt-btn-primary dol-opt-batch-entry'}" aria-pressed="${state.selecting}"${state.selecting ? '' : ' aria-describedby="dolOptBatchEntryHint"'}>${state.selecting ? '退出多选' : '批量下载'}</button>
                ${state.selecting ? '' : '<span id="dolOptBatchEntryHint" class="dol-opt-batch-entry-hint">勾选多个模组，统一下载并安装</span>'}
                ${state.selecting ? `<span class="dol-opt-batch-count grey" role="status" aria-live="polite">已选 ${state.selected.size} 项，仅选择未安装模组</span>
                <button id="dolOptBatchSelectAll" type="button" class="macro-button dol-opt-btn-secondary">全选当前筛选</button>
                <button id="dolOptBatchClear" type="button" class="macro-button dol-opt-btn-secondary" ${state.selected.size ? '' : 'disabled'}>清空选择</button>
                <button id="dolOptBatchInstall" type="button" class="macro-button dol-opt-btn-primary" ${state.selected.size ? '' : 'disabled'}>下载并安装（${state.selected.size}）</button>` : ''}`;
            const handlers = { dolOptBatchToggle: () => toggleBatchSelection(), dolOptBatchSelectAll: selectAllVisibleMods, dolOptBatchClear: clearBatchSelection, dolOptBatchInstall: () => installSelectedMods() };
            Object.entries(handlers).forEach(([id, handler]) => {
                const button = document.getElementById(id);
                if (button) button.onclick = handler;
            });
        }
        if (focusedId) document.getElementById(focusedId)?.focus();
    }

    // ==================== 工具函数 ====================

    function cleanText(text) {
        return String(text || '')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function readLocalCache(key, ttl, allowExpired = false) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (Date.now() - parsed.timestamp > ttl) {
                return allowExpired ? parsed.data : null;
            }
            return parsed.data;
        } catch {
            return null;
        }
    }

    function writeLocalCache(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
        } catch {
            /* 忽略配额超限错误 */
        }
    }

    /** 清理模组标题中的平台噪点、下载标注与括号说明 */
    function cleanModTitle(str) {
        if (!str) return '';
        let s = cleanText(str);
        // 移除 [Github], [Discord], (v1.0), 【xxx】 等附加噪点
        s = s.replace(/\[.*?\]|\(.*?\)|【.*?】|（.*?）/g, ' ');
        s = s.replace(/github|discord|下载|论坛|链接|地址|\u2708|\u2764|\u2192/gi, ' ');
        s = s.replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0E\uFE0F\u200D]/gu, '');
        return cleanText(s);
    }

    /**
     * 规范化并解析版本号字符串
     * 提取主版本、次版本、修订版本等数字序列
     */
    function parseVersionNumbers(verStr) {
        if (!verStr) return [];
        const s = String(verStr).trim();
        const marked = s.match(/(?:^|[^a-z0-9])v(\d+(?:\.\d+)*)/i);
        const numeric = marked?.[1] || s.match(/\d+(?:\.\d+)*/)?.[0];
        return numeric ? numeric.split('.').map(n => parseInt(n, 10) || 0) : [];
    }

    /**
     * 比较版本号：v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
     * 遵循语义化数字版本逐段比对
     */
    function compareVersions(v1, v2) {
        if (!v1 && !v2) return 0;
        if (!v1) return -1;
        if (!v2) return 1;

        const nums1 = parseVersionNumbers(v1);
        const nums2 = parseVersionNumbers(v2);

        if (nums1.length === 0 && nums2.length === 0) {
            return String(v1).localeCompare(String(v2));
        }
        if (nums1.length === 0) return -1;
        if (nums2.length === 0) return 1;

        const maxLen = Math.max(nums1.length, nums2.length);
        for (let i = 0; i < maxLen; i++) {
            const p1 = nums1[i] !== undefined ? nums1[i] : 0;
            const p2 = nums2[i] !== undefined ? nums2[i] : 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    function satisfiesVersion(version, requirement) {
        if (!requirement || requirement === '*') return true;
        if (!version) return false;
        const match = String(requirement).trim().match(/^(>=|<=|>|<|\^|~)?\s*v?(\d+(?:\.\d+)*)$/i);
        if (!match) return compareVersions(version, requirement) === 0;
        const [, operator = '', base] = match;
        const compared = compareVersions(version, base);
        if (operator === '>=') return compared >= 0;
        if (operator === '<=') return compared <= 0;
        if (operator === '>') return compared > 0;
        if (operator === '<') return compared < 0;
        if (!operator) return compared === 0;

        const parts = parseVersionNumbers(base);
        const upper = [...parts];
        if (operator === '~') {
            const index = parts.length === 1 ? 0 : 1;
            upper[index] = (upper[index] || 0) + 1;
            upper.splice(index + 1);
        } else {
            const firstNonZero = parts.findIndex(part => part > 0);
            const index = firstNonZero < 0 ? Math.max(parts.length - 1, 0) : firstNonZero;
            upper[index] = (upper[index] || 0) + 1;
            upper.splice(index + 1);
        }
        return compared >= 0 && compareVersions(version, upper.join('.')) < 0;
    }

    function normalizeDependencyList(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.flatMap(item => {
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            const key = id.toLowerCase();
            if (!id || seen.has(key)) return [];
            seen.add(key);
            return [{
                id,
                version: typeof item.version === 'string' ? item.version.trim() : ''
            }];
        });
    }

    function getModDependencies(mod) {
        const dependencies = normalizeDependencyList(mod?.dependencies);
        const description = cleanText(mod?.description || '');
        const inferred = [
            ['simple-framework', /(?:^|[（(，,：:\s])依赖(?:于)?\s*(?:模组)?\s*简易框架/i],
            ['maplebirch', /(?:^|[（(，,：:\s])依赖(?:于)?\s*(?:模组)?\s*秋枫白桦框架/i]
        ].filter(([, pattern]) => pattern.test(description)).map(([id]) => ({ id }));
        return normalizeDependencyList([...dependencies, ...inferred]);
    }

    /**
     * 规范化版本号展示，避免 "vv..." 或缺失前缀
     */
    function formatVersionDisplay(verStr) {
        if (!verStr) return '';
        const s = String(verStr).trim();
        return /^v/i.test(s) ? s : 'v' + s;
    }
    window.dolOptFormatVersion = formatVersionDisplay;
    window.dolOptCompareVersions = compareVersions;

    /** 已知模组使用权威分类；未知模组只做保守回退，无法判断时进入“待分类”。 */
    function deriveClassification(name, desc, category, tags) {
        const nameText = String(name || '').toLowerCase();
        const descText = String(desc || '').toLowerCase();
        const text = `${name || ''} ${desc || ''}`.toLowerCase();
        const known = DOL_OPT_KNOWN_MOD_CLASSIFICATIONS[normalizeKey(name)] || {};
        const nameCategory = /修复|补丁|相容|兼容|bugfix|patch/i.test(nameText)
            ? '修复与兼容'
            : (/框架|tweereplacer|modloader|framework|\bapi\b|\blibrary\b/i.test(nameText) ? '框架与前置' : null);
        const inferredCategory = nameCategory || CATEGORY_RULES.reduce((best, [candidate, pattern]) => {
            const score = (pattern.test(nameText) ? 2 : 0) + (pattern.test(descText) ? 1 : 0);
            return score > best.score ? { category: candidate, score } : best;
        }, { category: '待分类', score: 0 }).category;
        const explicitTags = Array.isArray(tags) && tags.length ? tags : known.tags;
        const normalizedTags = Array.isArray(explicitTags)
            ? explicitTags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim())
            : [];
        const inferredTags = TAG_RULES.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
        return {
            category: MARKET_CATEGORIES.includes(category) && category !== '待分类'
                ? category
                : (MARKET_CATEGORIES.includes(known.category) ? known.category : inferredCategory),
            tags: [...new Set(normalizedTags.length ? normalizedTags : inferredTags)].slice(0, 3)
        };
    }

    function deriveTags(name, desc) {
        return deriveClassification(name, desc).tags;
    }

    // ==================== Wiki 解析逻辑 ====================

    function getTablesInRange(doc, startId, endId) {
        const start = doc.getElementById(startId);
        if (!start) return [];
        const end = endId ? doc.getElementById(endId) : null;
        return Array.from(doc.querySelectorAll('table')).filter(table => {
            const afterStart = start.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING;
            const beforeEnd = !end || end.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_PRECEDING;
            return afterStart && beforeEnd;
        });
    }

    function getColumnIndexes(table) {
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (!headerRow) return null;
        const headers = Array.from(headerRow.querySelectorAll('th, td'));
        if (!headers.length) return null;

        const idx = { name: -1, description: -1, author: -1, date: -1 };
        headers.forEach((cell, i) => {
            const text = cleanText(cell.textContent);
            if (idx.name === -1 && /名称|名字|标题/.test(text)) idx.name = i;
            else if (idx.description === -1 && /简介|介绍|描述/.test(text)) idx.description = i;
            else if (idx.author === -1 && /作者|制作者|制作人/.test(text)) idx.author = i;
            else if (idx.date === -1 && /更新|日期|时间/.test(text)) idx.date = i;
        });

        if (idx.name === -1) idx.name = 0;
        if (idx.description === -1) idx.description = 1;
        if (idx.author === -1) idx.author = headers.length >= 5 ? 3 : 2;
        if (idx.date === -1) idx.date = headers.length - 1;
        return idx;
    }

    function extractModName(td) {
        if (!td) return '';
        const utilityRegex = /github|discord|下载|论坛|链接|地址|源码|镜像|\u2708|\u2764|\u2192|\[.*?\]/i;
        const anchors = Array.from(td.querySelectorAll('a'));
        const nameAnchors = anchors.filter(a => {
            const t = cleanText(a.textContent);
            return t && !utilityRegex.test(t);
        });
        let raw = '';
        if (nameAnchors.length) {
            raw = nameAnchors.map(a => cleanText(a.textContent)).join('/');
        } else {
            const clone = td.cloneNode(true);
            clone.querySelectorAll('a').forEach(a => {
                if (utilityRegex.test(cleanText(a.textContent))) a.remove();
            });
            raw = cleanText(clone.textContent);
        }
        return cleanModTitle(raw) || raw;
    }

    function extractGithubUrls(row) {
        const urls = [];
        row.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href') || '';
            if (/^https?:\/\/(www\.)?github\.com\//i.test(href)) {
                urls.push(href.split('#')[0]);
            }
        });
        return [...new Set(urls)];
    }

    function extractOtherUrls(row) {
        const urls = [];
        const WIKI_HOST = 'degreesoflewditycn.miraheze.org';
        row.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href') || '';
            if (!/^https?:\/\//i.test(href)) return;
            let u;
            try {
                u = new URL(href);
            } catch {
                return;
            }
            const host = u.hostname.toLowerCase();
            if (host === WIKI_HOST || host.endsWith('.miraheze.org') || /^(www\.)?github\.com$/.test(host)) return;
            if (host === 'upload.wikimedia.org' || host === 'static.miraheze.org') return;
            urls.push(href.split('#')[0]);
        });
        return [...new Set(urls)];
    }

    function parseDateCell(text) {
        const result = { date: null, version: null };
        if (!text) return result;
        const dateMatch = text.match(/(\d{4})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
        if (dateMatch) {
            result.date = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
        }
        const versionMatch = text.match(/[（(]\s*[vV]?\s*([0-9][0-9A-Za-z.\-_]*)\s*[)）]/);
        if (versionMatch) result.version = versionMatch[1];
        return result;
    }

    function parseModsFromHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const publicTables = getTablesInRange(doc, '公开模组', '私有模组');
        const privateTables = getTablesInRange(doc, '私有模组', '模组相关工具');
        const tables = [...publicTables, ...privateTables];
        const mods = [];

        for (const table of tables) {
            const idx = getColumnIndexes(table);
            if (!idx) continue;
            const rows = Array.from(table.querySelectorAll('tr')).filter(tr => {
                const tds = tr.querySelectorAll('td');
                return tds.length > 0 && !tr.querySelector('th');
            });

            for (const row of rows) {
                const tds = Array.from(row.querySelectorAll('td'));
                if (!tds.length) continue;

                const nameCell = tds[idx.name];
                const namedProjects = Array.from(nameCell?.querySelectorAll('a[href]') || []).filter(a =>
                    parseGithubRepo(a.getAttribute('href')) && cleanText(a.textContent)
                    && !/github|discord|下载|论坛|链接|地址|源码|镜像|\u2708|\u2764|\u2192|\[.*?\]/i.test(cleanText(a.textContent)));
                const projects = new Set(namedProjects.map(a => a.getAttribute('href').replace(/\/+$/, ''))).size > 1
                    ? namedProjects : [null];
                for (const project of projects) {
                const name = project ? cleanModTitle(project.textContent) : extractModName(nameCell);
                if (!name) continue;

                const description = cleanText(tds[idx.description] ? tds[idx.description].textContent : '');
                const author = idx.author >= 0 && tds[idx.author] ? cleanText(tds[idx.author].textContent) : '';
                const dateText = idx.date >= 0 && tds[idx.date] ? cleanText(tds[idx.date].textContent) : '';
                const { date, version } = parseDateCell(dateText);

                const githubUrls = project ? [project.getAttribute('href')] : extractGithubUrls(nameCell);
                const githubUrl = githubUrls[0] || null;
                const otherUrls = project ? [] : extractOtherUrls(nameCell);
                const otherUrl = otherUrls[0] || null;

                const classification = deriveClassification(name, description);
                const repoKey = extractRepoKey(githubUrl);
                const isDead = Boolean(isDeadRepo(repoKey) || isDeadRepo(githubUrl));

                mods.push({
                    name,
                    githubUrl,
                    githubUrls,
                    otherUrl,
                    otherUrls,
                    description: description || '暂无说明',
                    author: author || '未知作者',
                    version: version || '',
                    versionSource: 'wiki',
                    updateDate: date || '',
                    category: classification.category,
                    tags: classification.tags,
                    _isDeadRepo: isDead
                });
                }
            }
        }
        return markSharedRepositories(mods);
    }

    function markSharedRepositories(mods) {
        const groups = new Map();
        for (const mod of mods) {
            const key = extractRepoKey(mod.githubUrl);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, new Set());
            groups.get(key).add(mod.identityId || normalizeKey(mod.name || mod.wikiName));
        }
        return mods.map(mod => ({ ...mod, sharedRepository: Boolean(mod.sharedRepository
            || groups.get(extractRepoKey(mod.githubUrl))?.size > 1) }));
    }

    // ==================== GitHub Release 检索 ====================

    function parseGithubRepo(url) {
        try {
            const parsed = new URL(url);
            if (!/^https?:$/.test(parsed.protocol) || !/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return null;
            const parts = parsed.pathname.replace(/\/+$/, '').split('/').slice(1);
            const [owner, rawRepo, section, action] = parts;
            if (!owner || !rawRepo) return null;
            const repo = rawRepo.replace(/\.git$/i, '');
            const isTag = section === 'releases' && action === 'tag' && parts.length > 4;
            const isAsset = section === 'releases' && action === 'download' && parts.length > 5;
            const releaseTag = isTag ? decodeURIComponent(parts.slice(4).join('/'))
                : (isAsset ? decodeURIComponent(parts.slice(4, -1).join('/')) : '');
            const sourcePath = section && !(section === 'releases' && ((!action && parts.length === 3)
                || (action === 'latest' && parts.length === 4) || isTag || isAsset))
                ? parts.slice(2).join('/') : '';
            return { owner, repo, key: `${owner}/${repo}`.toLowerCase(), releaseTag,
                assetName: isAsset ? decodeURIComponent(parts.at(-1)) : '', sourcePath };
        } catch {
            return null;
        }
    }

    function getReleaseWorkerUrl(path) {
        try {
            return new URL(path, RELEASE_WORKER_API_BASE).toString();
        } catch {
            return '';
        }
    }

    async function fetchGithubReadme(repositoryUrl) {
        const repo = parseGithubRepo(repositoryUrl);
        const endpoint = getReleaseWorkerUrl('/readme');
        if (!repo || !endpoint) return null;
        const url = new URL(endpoint);
        url.searchParams.set('repo', repo.key);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), README_FETCH_TIMEOUT_MS) : null;
        try {
            const response = await fetch(url.toString(), controller ? { signal: controller.signal } : undefined);
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`GitHub README 获取失败: ${response.status}`);
            const data = await response.json();
            return typeof data?.markdown === 'string' && data.markdown.trim() ? data : null;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    function getReadmeImageProxyUrl(repositoryUrl, imageUrl) {
        const repo = parseGithubRepo(repositoryUrl);
        const endpoint = getReleaseWorkerUrl('/readme-image');
        if (!repo || !endpoint) return '';
        try {
            const source = new URL(imageUrl);
            const isRawGithub = source.hostname === 'raw.githubusercontent.com';
            const isGithubAttachment = source.hostname === 'github.com'
                && /^\/user-attachments\/assets\/[0-9a-f-]+$/i.test(source.pathname);
            if (source.protocol !== 'https:' || (!isRawGithub && !isGithubAttachment)) return '';
            const url = new URL(endpoint);
            url.searchParams.set('repo', repo.key);
            url.searchParams.set('url', source.toString());
            return url.toString();
        } catch {
            return '';
        }
    }

    function getAssetVersionParts(name) {
        const withoutGame = String(name || '').replace(getAssetGameVersion(name), '');
        return (withoutGame.match(/\d+(?:\.\d+)+/)?.[0] || '').split('.').filter(Boolean).map(Number);
    }

    function compareAssetVersions(a, b) {
        const av = getAssetVersionParts(a.name);
        const bv = getAssetVersionParts(b.name);
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const diff = (av[i] || 0) - (bv[i] || 0);
            if (diff) return diff;
        }
        return 0;
    }

    function getAssetGameVersion(name) {
        const value = String(name || '');
        const explicit = value.match(/(?:^|[\s_.-])(?:for[\s._-]*)?dol[\s._-]*v?(0\.\d+\.\d+(?:\.\d+)?)(?=[\s_.-]|$)/i)?.[1];
        if (explicit) return explicit;
        // 单个 0.5.x 也可能是模组版本；只有并列模组版本时才识别无 DoL 前缀的兼容版本。
        const versions = value.match(/\d+(?:\.\d+)+/g) || [];
        return versions.length > 1 ? (versions.find(version => /^0\.5\.\d+(?:\.\d+)?$/.test(version)) || '') : '';
    }

    function getAssetSeries(name) {
        return String(name || '').replace(/\.(?:zip|mod)$/ig, '')
            .replace(/(?:for[\s._-]*)?dol[\s._-]*\d+(?:\.\d+)+/ig, '')
            .replace(/(?:version|ver|v)?\d+(?:\.\d+)+/ig, '')
            .replace(/(?:^|[\s._-])build[\s._-]*\d+/ig, '')
            .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').replace(/(?:mod)+$/, '');
    }

    function matchesAssetIdentity(asset, mod) {
        const series = getAssetSeries(String(asset.name || '').replace(/(?:^|[\s._-])(?:desktop|windows|pc|mobile|android|english|chinese|chs|cht|cn|en|zh)(?=[\s._-]|$)/ig, ''));
        return [...(mod?.bootNames || []), ...(mod?.aliases || []), mod?.name].some(name => {
            const identity = getAssetSeries(name);
            return identity.length >= 3 && identity === series;
        });
    }

    function getMatchingCompanionAssets(main, assets) {
        const mainSeries = getAssetSeries(main.name);
        const mainVersion = getAssetVersionParts(main.name).join('.');
        return assets.filter(asset => asset.downloadUrl !== main.downloadUrl
            && COMPANION_ASSET_PATTERN.test(asset.name || '')
            && getAssetSeries(asset.name.replace(COMPANION_ASSET_PATTERN, '')) === mainSeries
            && (!getAssetGameVersion(asset.name) || getAssetGameVersion(asset.name) === getAssetGameVersion(main.name))
            && (!getAssetVersionParts(asset.name).length || getAssetVersionParts(asset.name).join('.') === mainVersion));
    }

    function buildReleaseAssetPlan(assets, gameVersion = window.StartConfig?.version || '', mod = null) {
        let downloadable = (assets || []).filter(asset => asset?.downloadUrl
            && /\.(?:zip|mod)$/i.test(asset.name || '')
            && !/(?:^|[\s._-])(?:source(?:[\s._-]*code)?|src|apk|outdated?|obsolete)(?=[\s._-]|$)|源码|整合包/i.test(asset.name || '')
            && !/\/archive\//i.test(asset.downloadUrl));
        const modelNames = new Set(downloadable.filter(asset => /\.model(?=[._-])/i.test(asset.name)).map(asset => asset.name.toLowerCase()));
        // 同版本直装包存在时，配对的手动覆盖图包不参与自动安装。
        downloadable = downloadable.filter(asset => !/\.imgpack(?=[._-])/i.test(asset.name)
            || !modelNames.has(asset.name.replace(/\.imgpack(?=[._-])/i, '.model').toLowerCase()));
        if (!downloadable.length) return { assets: [], candidates: [], availableAssets: [], needsChoice: false, reason: '没有可自动导入的模组安装包' };

        const identified = mod ? downloadable.filter(asset => matchesAssetIdentity(asset, mod)) : [];
        let mainCandidates = identified.length ? identified : downloadable.filter(asset => !COMPANION_ASSET_PATTERN.test(asset.name || ''));
        if (!mainCandidates.length) mainCandidates = downloadable;
        if (mod?.sharedRepository && !identified.length) {
            return { assets: [], candidates: [], availableAssets: [], needsChoice: false, reason: '同仓库包含多个模组，未找到与当前条目身份一致的安装包' };
        }

        const isMobile = typeof window.dolOptIsMobile === 'function' ? !!window.dolOptIsMobile() : !!window.dolOptIsMobile;
        const preferredPlatform = isMobile ? /(?:^|[\s_.-])(?:mobile|android)(?=[\s_.-]|$)/i : /(?:^|[\s_.-])(?:desktop|pc|windows)(?=[\s_.-]|$)/i;
        const oppositePlatform = isMobile ? /(?:^|[\s_.-])(?:desktop|pc|windows)(?=[\s_.-]|$)/i : /(?:^|[\s_.-])(?:mobile|android)(?=[\s_.-]|$)/i;
        const platformGroups = new Map();
        for (const asset of mainCandidates) {
            const key = getAssetSeries(asset.name.replace(/(?:^|[\s_.-])(?:mobile|android|desktop|pc|windows)(?=[\s_.-]|$)/ig, ''));
            if (!platformGroups.has(key)) platformGroups.set(key, []);
            platformGroups.get(key).push(asset);
        }
        mainCandidates = [...platformGroups.values()].flatMap(group => {
            const preferred = group.filter(asset => preferredPlatform.test(asset.name || ''));
            const neutral = group.filter(asset => !oppositePlatform.test(asset.name || ''));
            return preferred.length ? preferred : (neutral.length ? neutral : group);
        });

        const normalizedGameVersion = String(gameVersion || '').replace(/^v/i, '');
        const versionSpecific = mainCandidates.filter(asset => getAssetGameVersion(asset.name));
        if (normalizedGameVersion && versionSpecific.length) {
            const exact = versionSpecific.filter(asset => getAssetGameVersion(asset.name) === normalizedGameVersion);
            const matchingSeries = new Set(exact.map(asset => getAssetSeries(asset.name)));
            if (exact.length && mainCandidates.every(asset => matchingSeries.has(getAssetSeries(asset.name)))) mainCandidates = exact;
            else return { assets: [], candidates: mainCandidates, availableAssets: downloadable, needsChoice: true,
                reason: `无法唯一确定适用于当前 DoL ${normalizedGameVersion} 的模组系列，请核对作者说明后选择` };
        }

        // 仅在同一产品、语言和模型系列内比较版本，不用另一个模组的版本号淘汰本模组。
        const series = new Map();
        for (const asset of mainCandidates) {
            const key = `${getAssetSeries(asset.name)}${getAssetVersionParts(asset.name).length ? '' : ':unversioned'}`;
            const existing = series.get(key) || [];
            const comparison = existing.length ? compareAssetVersions(asset, existing[0]) : 1;
            if (comparison > 0) series.set(key, [asset]);
            else if (comparison === 0) existing.push(asset);
        }
        mainCandidates = [...series.values()].flat();
        if (mainCandidates.length > 1) return { assets: [], candidates: mainCandidates, availableAssets: downloadable, needsChoice: true,
            reason: '检测到多个独立模组或安装变体，请选择需要的安装包' };
        const selectedMain = mainCandidates[0];
        return { assets: [selectedMain, ...getMatchingCompanionAssets(selectedMain, downloadable)],
            candidates: mainCandidates, availableAssets: downloadable, needsChoice: false, reason: '' };
    }

    async function fetchModRelease(mod, options = {}) {
        const { useCache = true, signal } = options;
        if (!mod || !mod.githubUrl) throw new Error('模组缺少 GitHub 仓库链接');
        const repo = parseGithubRepo(mod.githubUrl);
        if (!repo) throw new Error('无法解析 GitHub 仓库地址');
        if (repo.sourcePath) {
            const err = new Error('此条目指向仓库内的文件或分支，请前往模组主页按作者说明下载安装');
            err.code = 'MANUAL_SOURCE';
            throw err;
        }
        const sharedRepository = !repo.releaseTag && (mod.sharedRepository || (marketModList || [])
            .filter(item => parseGithubRepo(item.githubUrl)?.key === repo.key).length > 1);

        // 同仓库的主包和扩展可能分属固定标签，不能共用 latest 或旧缓存。
        const entryKey = mod.id || mod.identityId || mod.name || '';
        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}${repo.releaseTag ? `_tag_${encodeURIComponent(repo.releaseTag)}` : ''}${repo.assetName ? `_asset_${encodeURIComponent(repo.assetName)}` : ''}${sharedRepository ? `_entry_${encodeURIComponent(entryKey)}` : ''}`;
        const gameVersion = window.StartConfig?.version || '';
        const platform = (typeof window.dolOptIsMobile === 'function' ? window.dolOptIsMobile() : window.dolOptIsMobile) ? 'mobile' : 'desktop';
        const source = JSON.stringify([repo.key, repo.releaseTag, repo.assetName, entryKey, mod.bootNames || [], mod.aliases || []]);
        const isUsableCache = cached => cached?.assetPlanVersion === 3 && cached.assetPlanGameVersion === gameVersion
            && cached.assetPlanPlatform === platform && cached.assetPlanSource === source
            && (!mod.version || compareVersions(cached.version, mod.version) >= 0);
        if (useCache) {
            const cached = readLocalCache(cacheKey, RELEASE_CACHE_TTL);
            if (isUsableCache(cached)) {
                return { ...cached, fromCache: true };
            }
        }

        const headers = { Accept: 'application/vnd.github+json' };
        const baseUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;

        let releaseData = null;
        try {
            const latestRes = await fetch(sharedRepository ? `${baseUrl}/releases?per_page=100`
                : `${baseUrl}/releases/${repo.releaseTag ? `tags/${encodeURIComponent(repo.releaseTag)}` : 'latest'}`, { headers, signal });

            if (latestRes.status === 429 || latestRes.status === 403) {
                const err = new Error('GitHub API 触发速率限制，请稍候再试');
                err.code = 'RATE_LIMITED';
                throw err;
            }

            if (latestRes.status === 404) {
                if (repo.releaseTag) {
                    const err = new Error(`指定发布标签不存在或不可访问：${repo.releaseTag}`);
                    err.code = 'RELEASE_NOT_FOUND';
                    throw err;
                }
                const listRes = await fetch(`${baseUrl}/releases?per_page=1`, { headers, signal });
                if (listRes.status === 429 || listRes.status === 403) {
                    const err = new Error('GitHub API 触发速率限制');
                    err.code = 'RATE_LIMITED';
                    throw err;
                }
                if (listRes.status === 404) {
                    const deadKey = `${repo.owner}/${repo.repo}`.toLowerCase();
                    markRepoAsDead(deadKey);
                    if (mod) mod._isDeadRepo = true;
                    invalidateDeadRepoMods(deadKey);
                    const err = new Error('该模组的 GitHub 仓库已被作者移除或不存在 (404)');
                    err.code = 'REPO_NOT_FOUND';
                    err.status = 404;
                    throw err;
                }
                if (!listRes.ok) throw new Error(`GitHub 访问异常: ${listRes.status}`);
                const list = await listRes.json();
                if (!Array.isArray(list) || !list.length) throw new Error('该仓库未发布 Release');
                releaseData = list[0];
            } else if (!latestRes.ok) {
                throw new Error(`GitHub 访问异常: ${latestRes.status}`);
            } else {
                releaseData = await latestRes.json();
            }
            if (sharedRepository) {
                const releases = Array.isArray(releaseData) ? releaseData : [releaseData];
                // ponytail: 最多检索最近 100 个发布；超出范围时转作者主页，确有需求再增加分页。
                // 共享仓库按产品身份找发布，不能把该仓库最后发布的另一个模组当成当前模组。
                releaseData = releases.filter(release => !release.draft && !release.prerelease
                    && (release.assets || []).some(asset => matchesAssetIdentity(asset, mod)))
                    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
                if (!releaseData) {
                    const err = new Error('共享仓库中未找到与当前模组身份一致的发布，请前往模组主页核对');
                    err.code = 'MANUAL_SOURCE';
                    throw err;
                }
            }
            if (repo.releaseTag && releaseData.tag_name !== repo.releaseTag) {
                const err = new Error('返回的发布标签与模组来源不一致，请前往模组主页核对');
                err.code = 'RELEASE_NOT_FOUND';
                throw err;
            }
            if (repo.assetName && !(releaseData.assets || []).some(asset => asset.name === repo.assetName)) {
                const err = new Error(`指定的模组附件不存在：${repo.assetName}`);
                err.code = 'RELEASE_NOT_FOUND';
                throw err;
            }
            const currentRepoKey = `${repo.owner}/${repo.repo}`.toLowerCase();
            unmarkRepoAsDead(currentRepoKey);
            if (mod) mod._isDeadRepo = false;
        } catch (fetchErr) {
            if (['REPO_NOT_FOUND', 'RELEASE_NOT_FOUND', 'MANUAL_SOURCE'].includes(fetchErr?.code) || fetchErr?.status === 404 || fetchErr?.name === 'AbortError') {
                throw fetchErr;
            }
            const staleCache = readLocalCache(cacheKey, Infinity, true);
            if (isUsableCache(staleCache) && (staleCache.assets?.length || staleCache.requiresManualSelection)) {
                console.warn('[DolOptimization] GitHub API 直连受限，回退使用最近成功缓存的 Release 数据:', fetchErr);
                return { ...staleCache, fromCache: true, isStale: true };
            }
            throw fetchErr;
        }

        const assets = (releaseData.assets || []).filter(a => !repo.assetName || a.name === repo.assetName).map(a => ({
            name: a.name,
            size: a.size,
            downloadUrl: a.browser_download_url,
            digest: a.digest || ''
        }));
        const assetPlan = buildReleaseAssetPlan(assets, gameVersion, { ...mod, sharedRepository });
        const bestAsset = assetPlan.assets[0] || null;

        const releaseTitle = String(releaseData.name || '').trim();
        const explicitTitleVersion = releaseTitle.match(/^v?(\d+(?:\.\d+){1,3}(?:-[0-9a-z][0-9a-z.-]*)?)$/i)?.[1];
        const tagName = String(releaseData.tag_name || '');
        const tagVersion = /^(?:v?\d)|(?:^|[^a-z0-9])(?:v\d|\d+\.\d+)/i.test(tagName) ? tagName : '';
        const prefixedTitleVersion = releaseTitle.match(/^v(\d+(?:\.\d+){1,3})(?=$|[\s(（-])/i)?.[1];
        const version = sharedRepository ? (getAssetVersionParts(bestAsset?.name).join('.') || mod.wikiVersion || '')
            : (getAssetVersionParts(bestAsset?.name).join('.') || explicitTitleVersion || tagVersion || prefixedTitleVersion || mod.version || '');
        const updateDate = releaseData.published_at ? releaseData.published_at.slice(0, 10) : mod.updateDate || '';

        const result = {
            tagName: releaseData.tag_name || '',
            releaseName: releaseData.name || '',
            htmlUrl: releaseData.html_url || `https://github.com/${repo.owner}/${repo.repo}/releases/${repo.releaseTag ? `tag/${encodeURIComponent(repo.releaseTag)}` : 'latest'}`,
            assetName: bestAsset ? bestAsset.name : null,
            assetUrl: bestAsset ? bestAsset.downloadUrl : null,
            assetSize: bestAsset ? Number(bestAsset.size) || 0 : 0,
            assetDigest: bestAsset ? bestAsset.digest : '',
            assets: assetPlan.assets,
            candidateAssets: assetPlan.candidates,
            availableAssets: assetPlan.availableAssets,
            requiresManualSelection: assetPlan.needsChoice,
            selectionReason: assetPlan.reason,
            assetPlanVersion: 3,
            assetPlanGameVersion: gameVersion,
            assetPlanPlatform: platform,
            assetPlanSource: source,
            version,
            updateDate
        };

        if (useCache) {
            writeLocalCache(cacheKey, result);
        }
        return result;
    }

    async function fetchRecentCompanionAssets(mod, limit = 3, options = {}) {
        if (!mod?.githubUrl) return [];
        const repo = parseGithubRepo(mod.githubUrl);
        if (!repo || repo.releaseTag || repo.sourcePath || mod.sharedRepository) return [];
        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}_companions_v3_${encodeURIComponent(mod.id || mod.name || '')}`;
        if (options.useCache !== false) {
            const cached = readLocalCache(cacheKey, RELEASE_CACHE_TTL);
            if (Array.isArray(cached)) return cached.slice(0, limit);
        }

        const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=20`, {
            headers: { Accept: 'application/vnd.github+json' },
            signal: options.signal
        });
        if (response.status === 429 || response.status === 403) throw new Error('GitHub API 触发速率限制');
        if (!response.ok) throw new Error(`GitHub 访问异常: ${response.status}`);
        const releases = await response.json();
        const companions = [];
        for (const release of Array.isArray(releases) ? releases : []) {
            if (release.draft || release.prerelease) continue;
            for (const asset of release.assets || []) {
                if (!COMPANION_ASSET_PATTERN.test(asset.name || '') || !asset.browser_download_url
                    || !/\.(?:zip|mod)$/i.test(asset.name || '')
                    || !matchesAssetIdentity({ name: asset.name.replace(COMPANION_ASSET_PATTERN, '') }, mod)) continue;
                companions.push({
                    name: asset.name,
                    size: Number(asset.size) || 0,
                    digest: asset.digest || '',
                    downloadUrl: asset.browser_download_url,
                    releaseTag: release.tag_name || '',
                    releaseDate: release.published_at ? release.published_at.slice(0, 10) : ''
                });
                if (companions.length >= limit) break;
            }
            if (companions.length >= limit) break;
        }
        writeLocalCache(cacheKey, companions);
        return companions;
    }

    function getReleaseInstallAssets(releaseInfo) {
        if (!releaseInfo) return [];
        return Array.isArray(releaseInfo.assets) && releaseInfo.assets.length
            ? releaseInfo.assets
            : (releaseInfo.assetUrl ? [{
                name: releaseInfo.assetName,
                size: releaseInfo.assetSize,
                digest: releaseInfo.assetDigest,
                downloadUrl: releaseInfo.assetUrl
            }] : []);
    }

    function formatAssetSize(size) {
        const bytes = Number(size) || 0;
        if (!bytes) return '大小未知';
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function getManualAssetOptions(releaseInfo) {
        const candidates = releaseInfo?.candidateAssets || [];
        return [
            { value: '', label: '请选择一个安装包', disabled: true },
            ...candidates.map((asset, index) => ({
                value: `asset:${index}`,
                label: `${asset.name}（${formatAssetSize(asset.size)}）`
            }))
        ];
    }

    function applyManualAssetSelection(releaseInfo, choice) {
        const match = typeof choice === 'string' ? choice.match(/^asset:(\d+)$/) : null;
        const asset = match ? releaseInfo?.candidateAssets?.[Number(match[1])] : null;
        if (!asset) return null;
        return {
            ...releaseInfo,
            assetName: asset.name,
            assetUrl: asset.downloadUrl,
            assetSize: Number(asset.size) || 0,
            assetDigest: asset.digest || '',
            assets: [asset, ...getMatchingCompanionAssets(asset, releaseInfo.availableAssets || [])],
            version: getAssetVersionParts(asset.name).join('.') || releaseInfo.version,
            requiresManualSelection: false,
            selectionReason: ''
        };
    }

    function formatReleaseInstallPlanHtml(releaseInfo, selectedMirror, historicalCount = 0) {
        const escape = value => window.dolOptEscapeHtml(String(value ?? ''));
        const needsChoice = Boolean(releaseInfo?.requiresManualSelection);
        const assets = needsChoice ? [] : getReleaseInstallAssets(releaseInfo);
        const candidates = releaseInfo?.candidateAssets || [];
        const totalSize = assets.reduce((sum, asset) => sum + (Number(asset.size) || 0), 0);
        const companionCount = assets.filter(asset => COMPANION_ASSET_PATTERN.test(asset.name || '')).length;
        const mainGameVersion = getAssetGameVersion(assets[0]?.name);
        const versionText = needsChoice
            ? (releaseInfo?.selectionReason || '请从下方选择安装包')
            : (mainGameVersion ? `匹配 DoL ${mainGameVersion}` : '最新主包');
        const companionText = companionCount
            ? `${companionCount} 个，将一并安装`
            : (historicalCount ? `当前版本无；下方可选 ${historicalCount} 个历史资源包` : '无');
        const filesHtml = assets.map((asset, index) => {
            const role = COMPANION_ASSET_PATTERN.test(asset.name || '') ? '附属资源' : (index === 0 ? '主模组' : '附属安装包');
            return `<div class="dol-opt-install-file"><span class="dol-opt-install-label">${role}</span><span class="dol-opt-install-name">${escape(asset.name)}</span><span class="dol-opt-install-size">${escape(formatAssetSize(asset.size))}</span></div>`;
        }).join('');
        const summaryTitle = needsChoice ? '请选择 1 个安装包' : `将安装 ${assets.length} 个文件`;
        const summaryMeta = needsChoice ? `${candidates.length} 个候选` : (totalSize ? `共 ${formatAssetSize(totalSize)}` : '大小未知');
        const modeText = selectedMirror?.browserOnly ? '浏览器下载后手动导入' : '自动导入 ModLoader';
        return `
            <div class="dol-opt-install-summary">
                <div class="dol-opt-install-overview"><strong>${escape(summaryTitle)}</strong><span>${escape(summaryMeta)}</span></div>
                ${filesHtml ? `<div class="dol-opt-install-files">${filesHtml}</div>` : ''}
                <dl class="dol-opt-install-meta">
                    <div><dt>版本选择</dt><dd class="${needsChoice ? 'gold' : 'green'}">${escape(versionText)}</dd></div>
                    <div><dt>附属资源</dt><dd>${escape(companionText)}</dd></div>
                    <div><dt>下载线路</dt><dd class="gold">${escape(selectedMirror?.name || '默认加速')}</dd></div>
                    <div><dt>安装方式</dt><dd class="green">${escape(modeText)}</dd></div>
                </dl>
            </div>`;
    }

    /** 格式化前置依赖清单 HTML（支持多色状态显示与可选勾选） */
    function formatDependencyListHtml(plan) {
        if (!plan?.requirements?.length) return '';
        const escape = value => typeof window.dolOptEscapeHtml === 'function' ? window.dolOptEscapeHtml(String(value ?? '')) : String(value ?? '');

        const isModMatch = (a, b) => a === b || (Boolean(a?.name) && a?.name === b?.name);

        const actionableCount = plan.requirements.filter(req =>
            (plan.actions || []).some(action => isModMatch(action.mod, req.mod))
        ).length;

        const itemsHtml = plan.requirements.map((req, reqIndex) => {
            const reqActions = (plan.actions || []).filter(action => isModMatch(action.mod, req.mod));
            const isSatisfied = reqActions.length === 0;

            if (isSatisfied) {
                const versionText = req.dependency.version ? `满足 ${req.dependency.version}` : '';
                return `
                    <div class="dol-opt-dep-item dol-opt-dep-satisfied">
                        <span class="dol-opt-dep-bullet green" aria-hidden="true">•</span>
                        <div class="dol-opt-dep-content">
                            <span class="dol-opt-dep-name">${escape(req.mod.name)}</span>
                            ${versionText ? `<span class="dol-opt-dep-version grey">（${escape(versionText)}）</span>` : ''}
                        </div>
                        <span class="dol-opt-dep-status green">已满足</span>
                    </div>
                `;
            }

            const installAction = reqActions.find(a => a.type === 'install');
            const updateAction = reqActions.find(a => a.type === 'update');
            const enableAction = reqActions.find(a => a.type === 'enable');

            let activeColor = 'gold';
            let activeText = '未安装';
            let skipText = '跳过安装';
            let versionText = '';

            if (installAction) {
                activeColor = 'gold';
                activeText = '未安装';
                skipText = '跳过安装';
                if (req.dependency.version) {
                    versionText = `需要 ${req.dependency.version}`;
                }
            } else if (updateAction) {
                activeColor = 'gold';
                activeText = '需更新';
                skipText = '跳过更新';
                const localVer = formatVersionDisplay(updateAction.local?.version) || '旧版';
                const reqVer = req.dependency.version || formatVersionDisplay(updateAction.mod?.version) || '新版';
                versionText = `当前 ${localVer} · 需要 ${reqVer}`;
            } else if (enableAction) {
                activeColor = 'purple';
                activeText = '未启用';
                skipText = '保持禁用';
                versionText = '已安装未启用';
            }

            return `
                <label class="dol-opt-dep-item dol-opt-dep-actionable" data-req-index="${reqIndex}">
                    <input type="checkbox" class="dol-opt-dep-checkbox" name="dolOptDepReq" data-req-index="${reqIndex}" checked>
                    <div class="dol-opt-dep-content">
                        <span class="dol-opt-dep-name">${escape(req.mod.name)}</span>
                        ${versionText ? `<span class="dol-opt-dep-version grey">（${escape(versionText)}）</span>` : ''}
                    </div>
                    <span class="dol-opt-dep-status ${activeColor}" data-active-text="${activeText}" data-active-color="${activeColor}" data-skip-text="${skipText}">${activeText}</span>
                </label>
            `;
        }).join('');

        const tipText = actionableCount > 0
            ? '默认勾选一键安装，可取消勾选'
            : '已安装且符合版本要求';

        return `
            <div class="dol-opt-install-dependencies">
                <div class="dol-opt-install-dependencies-header">
                    <strong class="dol-opt-install-dependencies-title">前置依赖</strong>
                    <span class="dol-opt-install-dependencies-tip grey">${escape(tipText)}</span>
                </div>
                <div class="dol-opt-dep-list">
                    ${itemsHtml}
                </div>
            </div>
        `;
    }

    function formatReleaseInstallPlan(releaseInfo) {
        if (releaseInfo?.requiresManualSelection) {
            const candidates = (releaseInfo.candidateAssets || []).map(asset => `· 候选安装包：${asset.name}`).join('\n');
            return `安装包清单：需要玩家选择。\n${candidates}\n\n原因：${releaseInfo.selectionReason || '无法可靠判断安装包用途'}。`;
        }
        const assets = getReleaseInstallAssets(releaseInfo);
        if (!assets.length) return '安装包清单：未找到可自动下载的压缩包。';
        const lines = assets.map((asset, index) => {
            const role = COMPANION_ASSET_PATTERN.test(asset.name || '') ? '附属图包/资源包' : (index === 0 ? '主模组' : '附属安装包');
            const size = Number(asset.size) > 0 ? `（${(Number(asset.size) / 1024 / 1024).toFixed(1)} MB）` : '';
            return `· ${role}：${asset.name}${size}`;
        });
        const companionCount = assets.filter(asset => COMPANION_ASSET_PATTERN.test(asset.name || '')).length;
        const mainGameVersion = getAssetGameVersion(assets[0]?.name);
        const compatibility = mainGameVersion
            ? `兼容匹配：已选择当前 DoL ${mainGameVersion} 对应安装包。`
            : '兼容匹配：当前 Release 未按 DoL 版本拆分安装包，已选择其最新主包。';
        const companionSummary = companionCount
            ? `附属包：检测到 ${companionCount} 个，将与主模组一并下载并安装。`
            : '附属包：本次 Release 未提供独立图包/资源包。';
        return `安装包清单（共 ${assets.length} 个）：\n${lines.join('\n')}\n\n${compatibility}\n${companionSummary}`;
    }

    // ==================== 镜像与加速处理 ====================

    function getAcceleratedUrl(url, mirrorId) {
        if (!url) return '';
        const mirror = resolveMirrorServer(mirrorId);
        if (!mirror.prefix) return url;
        return `${mirror.prefix}${url}`;
    }

    function getDownloadUrl(url, mirrorId) {
        const mirror = resolveMirrorServer(mirrorId);
        const targetUrl = getAcceleratedUrl(url, mirrorId);
        if (!targetUrl || !mirror.useWorker) return targetUrl;
        const proxyUrl = new URL('/download', RELEASE_WORKER_API_BASE);
        proxyUrl.searchParams.set('url', targetUrl);
        return proxyUrl.toString();
    }

    function setCurrentMirror(mirrorId, notify = true) {
        const mirror = resolveMirrorServer(mirrorId);
        if (!mirror) return false;
        currentMirrorId = mirror.id;
        const select = document.getElementById?.('dolOptMirrorSelect');
        if (select) select.value = mirror.id;
        renderMarketCards();
        if (notify) window.dolOptShowToast(`已切换下载线路: ${mirror.name}`, 'info');
        return true;
    }

    // ==================== 本地模组状态比对 ====================

    /** 归一化字符串：小写，去除空格、标点、短横线、下划线、括号、单双引号等 */
    function normalizeKey(str) {
        if (!str) return '';
        return cleanText(str)
            .toLowerCase()
            .replace(/[()（）\[\]【】_—\-—.\s'’"“”`]/g, '')
            .trim();
    }

    /** 剥离 DoL 生态常见仓库/技术名前缀与后缀，提取核心标识（纯正则单次执行，绝无死循环风险） */
    function stripDoLPrefix(str) {
        if (!str) return '';
        let s = normalizeKey(str);
        if (s.length < 3) return s;
        // 剥离 DoL 生态常见前缀
        s = s.replace(/^(?:degreesoflewdity|degreeslewdity|scmldol|scml|dolmod|dol)/i, '');
        // 若剩余部分以 dol 开头（例如 Degrees-of-Lewdity-DolSims 剥离后变为 dolsims），再次剥离 dol
        if (s.length >= 6 && /^dol/i.test(s)) {
            s = s.slice(3);
        }
        // 剥离模组常见后缀（保留核心词长度 >= 3）
        if (s.length > 5) {
            s = s.replace(/(?:addon|expansion|mod|plugin)$/i, '');
        }
        return s.length >= 2 ? s : normalizeKey(str);
    }

    /** 从 GitHub 仓库地址提取仓库名（小写且归一化） */
    function extractRepoName(url) {
        return normalizeKey(extractRepoKey(url).split('/')[1]);
    }

    function extractRepoKey(url) {
        // 身份校验仍需读取 tree/blob 主页所属仓库，下载入口是否可用由 parseGithubRepo 单独判定。
        const match = String(url || '').match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/i);
        return match ? `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase() : '';
    }

    const DEAD_REPOS_STORAGE_KEY = 'dol_opt_market_dead_repos_v1';
    // 已确凿验证被作者彻底删除（HTTP 404）的 GitHub 仓库
    const KNOWN_DEAD_REPOSITORIES = new Set([
        'kanna-hanabi/wovenrealm',
        'kanna-hanabi/wovenrealmui'
    ]);
    // 经核实正常活跃的仓库白名单（包含短横线单字符仓库名，防止误诊，并自动清洗本地可能存留的误诊记录）
    const KNOWN_ACTIVE_REPOSITORIES = new Set([
        'dawalizhang/-',
        'lingyu230514/-'
    ]);

    function getDeadRepos() {
        try {
            const stored = JSON.parse(localStorage.getItem(DEAD_REPOS_STORAGE_KEY) || '[]');
            let list = Array.isArray(stored) ? stored.map(s => String(s).toLowerCase().trim()) : [];
            // 误诊自愈清洗：若历史存储中误包含了活跃仓库，即时清除
            const cleanedList = list.filter(repo => !KNOWN_ACTIVE_REPOSITORIES.has(repo));
            if (cleanedList.length !== list.length) {
                try {
                    localStorage.setItem(DEAD_REPOS_STORAGE_KEY, JSON.stringify(cleanedList));
                } catch (_) {}
                list = cleanedList;
            }
            KNOWN_DEAD_REPOSITORIES.forEach(repo => {
                if (!list.includes(repo)) list.push(repo);
            });
            return list;
        } catch {
            return Array.from(KNOWN_DEAD_REPOSITORIES);
        }
    }

    function markRepoAsDead(repoKeyOrUrl) {
        if (!repoKeyOrUrl) return;
        const key = extractRepoKey(repoKeyOrUrl) || (String(repoKeyOrUrl).includes('/') ? String(repoKeyOrUrl).trim().toLowerCase() : '');
        if (!key) return;
        const norm = key.toLowerCase();
        // 绝不将白名单中的活跃仓库标记为失效
        if (KNOWN_ACTIVE_REPOSITORIES.has(norm)) return;
        try {
            const list = getDeadRepos();
            if (!list.includes(norm)) {
                list.push(norm);
                localStorage.setItem(DEAD_REPOS_STORAGE_KEY, JSON.stringify(list));
            }
        } catch (_) {}
    }

    function unmarkRepoAsDead(repoKeyOrUrl) {
        if (!repoKeyOrUrl) return;
        const key = extractRepoKey(repoKeyOrUrl) || (String(repoKeyOrUrl).includes('/') ? String(repoKeyOrUrl).trim().toLowerCase() : '');
        if (!key) return;
        const norm = key.toLowerCase();
        try {
            const list = getDeadRepos().filter(r => r !== norm && !KNOWN_DEAD_REPOSITORIES.has(r));
            localStorage.setItem(DEAD_REPOS_STORAGE_KEY, JSON.stringify(list));
        } catch (_) {}
    }

    function isDeadRepo(repoKeyOrUrl, mod) {
        if (mod && mod._isDeadRepo) return true;
        const targetUrl = repoKeyOrUrl || mod?.githubUrl || '';
        if (!targetUrl && (!mod || !mod.name)) return false;
        const key = extractRepoKey(targetUrl) || (String(targetUrl).includes('/') ? String(targetUrl).trim().toLowerCase() : '');
        if (key && KNOWN_ACTIVE_REPOSITORIES.has(key.toLowerCase())) {
            return false;
        }
        if (key && getDeadRepos().includes(key.toLowerCase())) return true;
        // 作者璐子已知全系模组仓库失效保护（织境空间全系扩展）
        if (mod && (mod.author === '璐子' || (typeof mod.author === 'string' && mod.author.includes('璐子')))) {
            const hasDeadKeyword = /wovenrealm|织境/i.test(String(mod.name || '')) || /wovenrealm/i.test(String(targetUrl || ''));
            if (hasDeadKeyword) return true;
        }
        return false;
    }

    /** 当某个仓库被检测为已失效或 404 时，即时纠偏当前内存中所有引用该仓库的模组状态并触发界面重绘 */
    function invalidateDeadRepoMods(repoKeyOrUrl) {
        markRepoAsDead(repoKeyOrUrl);
        if (!Array.isArray(marketModList) || !marketModList.length) return;
        const profiles = getLocalInstalledProfiles();
        let changed = false;
        for (const mod of marketModList) {
            const modRepoKey = extractRepoKey(mod.githubUrl);
            if (isDeadRepo(modRepoKey, mod) || isDeadRepo(mod.githubUrl, mod)) {
                mod._isDeadRepo = true;
                const newStatus = checkModInstallStatus(mod, profiles);
                if (mod._status !== newStatus) {
                    mod._status = newStatus;
                    changed = true;
                }
            }
        }
        if (changed && typeof renderMarketCards === 'function') {
            try {
                renderMarketCards();
            } catch (_) {}
        }
    }

    /** 将远程身份字典合并进内置别名库，内置数据继续作为离线兜底 */
    function applyIdentityCatalog(catalog) {
        const identities = Array.isArray(catalog) ? catalog : catalog?.mods;
        if (!Array.isArray(identities)) return 0;

        let applied = 0;
        for (const identity of identities) {
            if (!identity || typeof identity !== 'object' || identity.identityId === null) continue;

            // 净化异常数据：强行切断万能的智能手机与唐百玎HY手机模组的历史混淆关联
            if (identity.id === 'smartphone' || identity.name === '万能的智能手机') {
                identity.aliases = (identity.aliases || []).filter(a => a !== '手机');
                identity.repositories = (identity.repositories || []).filter(r => !/dolphonemod/i.test(r));
                identity.repositoryKeys = (identity.repositoryKeys || []).filter(k => !/hcptanghy/i.test(k));
            }
            if (identity.id === 'dol-phone-mod' || identity.name === '手机' || (identity.repositoryKeys || []).some(k => /hcptanghy/i.test(k))) {
                identity.bootNames = (identity.bootNames || []).filter(b => !/smartphone/i.test(b));
                identity.aliases = (identity.aliases || []).filter(a => !/智能手机|smartphone/i.test(a));
                identity.repositories = (identity.repositories || []).filter(r => !/dolsmartphone/i.test(r));
                identity.repositoryKeys = (identity.repositoryKeys || []).filter(k => !/anlinstudio/i.test(k));
            }

            const repositoryKeys = (Array.isArray(identity.repositoryKeys) ? identity.repositoryKeys : [])
                .filter(value => typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value))
                .map(value => value.toLowerCase());
            const names = [
                identity.name,
                identity.wikiName,
                ...(Array.isArray(identity.bootNames) ? identity.bootNames : []),
                ...(Array.isArray(identity.aliases) ? identity.aliases : []),
                ...(Array.isArray(identity.repositories) ? identity.repositories : [])
            ].filter(value => typeof value === 'string').map(cleanText).filter(Boolean);
            const keys = [...new Set(names.map(normalizeKey).filter(Boolean))];
            if (!keys.length) continue;

            const owner = String(identity.identityId || identity.id || `${repositoryKeys.join('|')}:${normalizeKey(identity.name)}`).toLowerCase();
            for (const bootName of identity.bootNames || []) {
                if (typeof bootName !== 'string') continue;
                const exactName = bootName.trim().toLowerCase();
                const previous = DOL_OPT_BOOT_IDENTITIES.get(exactName);
                DOL_OPT_BOOT_IDENTITIES.set(exactName, previous && previous.id !== owner ? { id: null, repositoryKeys: [] } : { id: owner, repositoryKeys });
            }
            for (const key of keys) {
                const previousOwner = DOL_OPT_IDENTITY_NAME_OWNERS.get(key);
                if (previousOwner && previousOwner !== owner) DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.add(key);
                DOL_OPT_IDENTITY_NAME_OWNERS.set(key, owner);
                if (DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(key)) continue;
                const aliases = new Set(DOL_OPT_KNOWN_MOD_MARKET_ALIASES[key] || []);
                names.forEach(name => {
                    if (normalizeKey(name) !== key) aliases.add(name);
                });
                DOL_OPT_KNOWN_MOD_MARKET_ALIASES[key] = [...aliases];
                if (repositoryKeys.length) DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[key] = repositoryKeys;
                const existing = DOL_OPT_KNOWN_MOD_CLASSIFICATIONS[key];
                if (identity.identityId !== null && MARKET_CATEGORIES.includes(identity.category)
                    && (identity.category !== '待分类' || !existing || existing.category === '待分类')) {
                    DOL_OPT_KNOWN_MOD_CLASSIFICATIONS[key] = {
                        category: identity.category,
                        tags: Array.isArray(identity.tags) ? identity.tags : []
                    };
                }
            }
            applied++;
        }
        // 同名条目不能互相扩充别名；仓库名也不能替代同仓库内各模组的身份。
        for (const key of DOL_OPT_AMBIGUOUS_IDENTITY_NAMES) {
            delete DOL_OPT_KNOWN_MOD_MARKET_ALIASES[key];
            delete DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[key];
            delete DOL_OPT_KNOWN_MOD_CLASSIFICATIONS[key];
        }
        for (const key of Object.keys(DOL_OPT_KNOWN_MOD_MARKET_ALIASES)) {
            DOL_OPT_KNOWN_MOD_MARKET_ALIASES[key] = DOL_OPT_KNOWN_MOD_MARKET_ALIASES[key]
                .filter(name => !DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(normalizeKey(name)));
        }
        return applied;
    }

    /** 将 Cloudflare 统一索引转换为模组市场既有数据结构 */
    function normalizeReleaseIndex(index) {
        if (index?.schemaVersion !== 1 || !Array.isArray(index.mods)) {
            throw new Error('自动版本索引格式异常');
        }

        // 客户端容错修正：若远程 release-index 仍包含未更新的旧身份映射，即时纠偏并拆分
        for (const mod of index.mods) {
            const repoKey = (extractRepoKey(mod.githubUrl) || mod.repo || '').toLowerCase();
            if (repoKey === 'hcptanghy/dol-phonemod') {
                mod.id = 'dol-phone-mod';
                mod.identityId = 'dol-phone-mod';
                mod.name = '手机';
                mod.wikiName = '手机';
                mod.bootNames = ['PhoneMod', 'DOL-PhoneMod'];
                mod.aliases = ['手机', 'DOL-PhoneMod'];
                mod.repositories = ['DOL-PhoneMod'];
                mod.repositoryKeys = ['HCPTangHY/DOL-PhoneMod'];
            } else if (repoKey === 'anlinstudio/degrees-of-lewdity-dolsmartphone') {
                mod.id = 'smartphone';
                mod.identityId = 'smartphone';
                mod.name = '万能的智能手机';
                mod.wikiName = '万能的智能手机';
                mod.bootNames = ['SmartPhone Alpha', 'SmartPhone'];
                mod.aliases = ['万能的智能手机', '智能手机'];
                mod.repositories = ['Degrees-of-Lewdity-DolSmartPhone'];
                mod.repositoryKeys = ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'];
            }
        }

        applyIdentityCatalog(index.identities);
        applyIdentityCatalog(index.mods);
        return markSharedRepositories(index.mods).map(mod => {
            const target = parseGithubRepo(mod.githubUrl);
            const indexedRelease = parseGithubRepo(mod.releaseUrl);
            if (target?.sourcePath || (mod.sharedRepository && !target?.releaseTag) ||
                (target?.releaseTag && mod.releaseUrl &&
                (indexedRelease?.key !== target.key || indexedRelease?.releaseTag !== target.releaseTag))) {
                // 旧索引可能把扩展版本写入主包条目，回退到该条目自身的 Wiki 元数据。
                mod = { ...mod, releaseUrl: null, version: mod.wikiVersion || '', versionLabel: '',
                    versionSource: 'wiki', updateDate: mod.wikiDate || '', updateDateSource: mod.wikiDate ? 'wiki' : null };
            }
            const hasAuthoritativeClassification = mod.identityId !== null;
            const classification = deriveClassification(
                mod.name || mod.wikiName,
                mod.description,
                hasAuthoritativeClassification ? mod.category : null,
                hasAuthoritativeClassification ? mod.tags : null
            );
            const repoKey = extractRepoKey(mod.githubUrl) || (mod.repo ? String(mod.repo).toLowerCase() : '');
            const isDead = Boolean(isDeadRepo(repoKey) || isDeadRepo(mod.githubUrl));
            return {
                ...mod,
                _isDeadRepo: isDead,
                name: cleanModTitle(mod.name || mod.wikiName) || mod.wikiName || '未命名模组',
                githubUrls: Array.isArray(mod.githubUrls)
                    ? mod.githubUrls
                    : (mod.githubUrl ? [mod.githubUrl] : []),
                otherUrls: Array.isArray(mod.otherUrls)
                    ? mod.otherUrls
                    : (mod.otherUrl ? [mod.otherUrl] : []),
                description: mod.description || '暂无说明',
                author: mod.author || '未知作者',
                version: mod.version || '',
                versionLabel: typeof mod.versionLabel === 'string' ? mod.versionLabel.trim() : '',
                updateDate: mod.updateDate || '',
                category: classification.category,
                tags: classification.tags,
                dependencies: getModDependencies(mod)
            };
        });
    }

    async function fetchReleaseIndex() {
        let lastError = null;
        for (const url of RELEASE_INDEX_MIRRORS) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = controller
                ? setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS)
                : null;
            try {
                const res = await fetch(url, { cache: 'no-cache', signal: controller?.signal });
                if (!res.ok) throw new Error(`自动版本索引返回状态码: ${res.status}`);
                const mods = normalizeReleaseIndex(await res.json());
                activeReleaseWorkerBaseUrl = url;
                writeLocalCache(WIKI_CACHE_KEY, mods);
                return mods;
            } catch (error) {
                lastError = error;
                console.warn(`[DolOptimization] 自动版本索引镜像不可用 (${url})，尝试下一镜像或回退`, error);
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
            }
        }
        throw lastError || new Error('所有自动版本索引镜像均不可用');
    }

    async function loadIdentityCatalog(forceRefresh = false) {
        const cached = readLocalCache(IDENTITY_CACHE_KEY, WIKI_CACHE_TTL);
        if (!forceRefresh && cached && applyIdentityCatalog(cached) > 0) return cached;

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = controller
            ? setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS)
            : null;
        try {
            const res = await fetch(IDENTITY_CATALOG_URL, controller ? { signal: controller.signal } : undefined);
            if (!res.ok) throw new Error(`身份字典返回状态码: ${res.status}`);
            const catalog = await res.json();
            if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.mods)) {
                throw new Error('身份字典格式异常');
            }
            applyIdentityCatalog(catalog);
            writeLocalCache(IDENTITY_CACHE_KEY, catalog);
            return catalog;
        } catch (error) {
            if (cached && applyIdentityCatalog(cached) > 0) return cached;
            console.warn('[DolOptimization] 远程模组身份字典加载失败，继续使用内置映射', error);
            return null;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    /** 全面搜集本地已安装的模组档案 (支持已加载、已启用、已禁用全状态) */
    function getLocalInstalledProfiles() {
        const profiles = [];
        const seenNames = new Set();

        const addProfile = (modName, bootJson, modRef) => {
            const profileKey = String(modName || '').trim().toLowerCase();
            if (!profileKey || seenNames.has(profileKey)) return;
            seenNames.add(profileKey);

            let resolvedMod = window.dolOptGetModInfo?.(modName) || modRef;
            let boot = resolvedMod?.bootJson || bootJson || modRef?.bootJson || {};
            const actualName = boot.name || resolvedMod?.name;
            if (actualName && String(actualName).trim().toLowerCase() !== String(modName).trim().toLowerCase()) {
                resolvedMod = null;
                boot = {};
            }
            const version = boot.version || '';
            const displayNames = new Set();
            const repos = new Set();
            const repositoryKeys = new Set();

            // 1. 模组技术标识名
            displayNames.add(modName);
            repos.add(normalizeKey(modName));
            const techCore = stripDoLPrefix(modName);
            if (techCore && techCore.length >= 3) {
                repos.add(techCore);
                displayNames.add(techCore);
            }

            // 2. boot.json 的 name 字段
            if (boot.name) {
                displayNames.add(boot.name);
                repos.add(normalizeKey(boot.name));
                const nameCore = stripDoLPrefix(boot.name);
                if (nameCore && nameCore.length >= 3) {
                    repos.add(nameCore);
                    displayNames.add(nameCore);
                }
            }

            // 3. boot.json 的 nickName 字段（支持中英文多语言展开）
            if (boot.nickName) {
                if (typeof boot.nickName === 'object') {
                    for (const v of Object.values(boot.nickName)) {
                        if (typeof v === 'string' && v.trim()) {
                            displayNames.add(v.trim());
                        }
                    }
                } else if (typeof boot.nickName === 'string' && boot.nickName.trim()) {
                    displayNames.add(boot.nickName.trim());
                }
            }

            // 4. 提取本地配置中明确声明的 repository，优先于按名称推断的仓库。
            if (boot.repository) {
                const repoUrl = typeof boot.repository === 'string' ? boot.repository : boot.repository.url;
                const repo = extractRepoName(repoUrl);
                if (repo) {
                    repos.add(repo);
                    const repoCore = stripDoLPrefix(repo);
                    if (repoCore && repoCore.length >= 3) repos.add(repoCore);
                }
                const repositoryKey = extractRepoKey(repoUrl);
                if (repositoryKey) repositoryKeys.add(repositoryKey);
            }

            // 5. 只扩充与本地声明仓库相容的权威别名，不使用展示简介推断身份。
            const declaredRepositoryKeys = new Set(repositoryKeys);
            if (!declaredRepositoryKeys.size) {
                (DOL_OPT_BOOT_IDENTITIES.get(String(modName).trim().toLowerCase())?.repositoryKeys || []).forEach(key => repositoryKeys.add(key));
            }
            for (const name of Array.from(displayNames)) {
                const norm = normalizeKey(name);
                const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[norm] || [];
                if (declaredRepositoryKeys.size && knownRepos.length && !knownRepos.some(key => declaredRepositoryKeys.has(key))) continue;
                const aliases = DOL_OPT_KNOWN_MOD_MARKET_ALIASES[norm] || [];
                aliases.forEach(alias => {
                    displayNames.add(alias);
                    repos.add(normalizeKey(alias));
                    const ac = stripDoLPrefix(alias);
                    if (ac && ac.length >= 3) repos.add(ac);
                });
                if (!declaredRepositoryKeys.size) knownRepos.forEach(k => repositoryKeys.add(k));
            }

            const cleanNames = Array.from(displayNames).map(cleanText).filter(Boolean);
            const normalizedNames = cleanNames.map(normalizeKey).filter(Boolean);

            profiles.push({
                name: modName,
                version,
                displayNames: cleanNames,
                normalizedNames,
                repos: Array.from(repos).filter(Boolean),
                repositoryKeys: Array.from(repositoryKeys)
            });
        };

        try {
            const gui = window.dolOptGetGui ? window.dolOptGetGui() : null;

            // 来源 1：gModUtils.getModList()
            if (gui?.gModUtils?.getModList) {
                const list = gui.gModUtils.getModList() || [];
                for (const m of list) {
                    if (m && m.name) addProfile(m.name, m.bootJson, m);
                }
            }

            // 来源 2：gModUtils.getModListNameNoAlias()
            if (gui?.gModUtils?.getModListNameNoAlias) {
                const names = gui.gModUtils.getModListNameNoAlias() || [];
                for (const name of names) {
                    const m = typeof window.dolOptGetModInfo === 'function' ? window.dolOptGetModInfo(name) : gui.gModUtils.getMod?.(name);
                    addProfile(name, m?.bootJson, m);
                }
            }

            // 来源 3：已缓存的模组管理器状态 (含已禁用旁加载模组)
            const state = window._dolOptModState;
            if (state) {
                const allNames = [
                    ...(state.sideEnabled || []),
                    ...(state.sideDisabled || []),
                    ...(state.builtInMods || []),
                    ...(state.sideMods ? state.sideMods.map(m => m.name) : [])
                ];
                for (const name of allNames) {
                    const m = typeof window.dolOptGetModInfo === 'function' ? window.dolOptGetModInfo(name) : gui?.gModUtils?.getMod?.(name);
                    addProfile(name, m?.bootJson, m);
                }
            }
        } catch (e) {
            console.warn('[DolOptimization] 获取本地模组档案异常', e);
        }

        return profiles;
    }

    /** 检查市场模组是否与本地模组匹配，并返回状态与本地模组信息 */
    function checkModInstallStatus(mod, profiles) {
        if (!profiles) profiles = getLocalInstalledProfiles();
        mod._isIgnored = false;
        mod._ignoredVersion = '';
        mod._matchedLocal = null;
        mod._matchedScore = 0;

        // 兼容传入 Map 的老接口 (如单元测试)
        let profileList = profiles;
        if (profiles instanceof Map) {
            profileList = [];
            for (const [k, v] of profiles.entries()) {
                const disp = new Set([k]);
                if (v && v.name) disp.add(v.name);
                if (v && v.nickName) {
                    if (typeof v.nickName === 'object') Object.values(v.nickName).forEach(val => val && disp.add(val));
                    else disp.add(v.nickName);
                }
                const repos = new Set([normalizeKey(v?.name || k)]);
                const repositoryKeys = new Set();
                const repoUrl = typeof v?.repository === 'string' ? v.repository : v?.repository?.url;
                const repositoryKey = extractRepoKey(repoUrl);
                if (repositoryKey) repositoryKeys.add(repositoryKey);
                const normK = normalizeKey(k);
                const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normK] || [];
                const compatibleRepository = !repositoryKey || !knownRepos.length || knownRepos.includes(repositoryKey);
                if (compatibleRepository && DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normK]) {
                    DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normK].forEach(a => {
                        disp.add(a);
                        repos.add(normalizeKey(a));
                    });
                }
                if (!repositoryKey) knownRepos.forEach(repo => repositoryKeys.add(String(repo).toLowerCase()));
                const clean = Array.from(disp).map(cleanText).filter(Boolean);
                const allRepos = new Set(Array.from(repos).filter(Boolean));
                allRepos.forEach(r => {
                    const c = stripDoLPrefix(r);
                    if (c && c.length >= 3) allRepos.add(c);
                });
                profileList.push({
                    name: v?.name || k,
                    version: v?.version || '',
                    displayNames: clean,
                    normalizedNames: clean.map(normalizeKey),
                    repos: Array.from(allRepos),
                    repositoryKeys: Array.from(repositoryKeys)
                });
            }
        }

        if (Array.isArray(profileList)) {
            profileList = profileList.map(p => {
                if (p.normalizedNames && p.displayNames && p.repos) {
                    const allRepos = new Set(p.repos);
                    allRepos.forEach(r => {
                        const c = stripDoLPrefix(r);
                        if (c && c.length >= 3) allRepos.add(c);
                    });
                    return {
                        ...p,
                        normalizedNames: [...new Set([...p.normalizedNames, ...p.displayNames.map(normalizeKey)])],
                        repos: Array.from(allRepos),
                        repositoryKeys: (p.repositoryKeys || []).map(key => String(key).toLowerCase())
                    };
                }
                const disp = new Set(p.displayNames || p.keys || [p.name]);
                const repos = new Set(p.repos || (p.keys ? p.keys.map(normalizeKey) : [normalizeKey(p.name)]));
                const normN = normalizeKey(p.name);
                const nCore = stripDoLPrefix(p.name);
                if (nCore && nCore.length >= 3) repos.add(nCore);
                const repositoryKeys = new Set((p.repositoryKeys || []).map(key => String(key).toLowerCase()));
                const repositoryKey = extractRepoKey(typeof p.repository === 'string' ? p.repository : p.repository?.url);
                if (repositoryKey) repositoryKeys.add(repositoryKey);
                if (!repositoryKeys.size) {
                    (DOL_OPT_BOOT_IDENTITIES.get(String(p.name || '').trim().toLowerCase())?.repositoryKeys || []).forEach(key => repositoryKeys.add(key));
                }
                const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normN] || [];
                const compatibleRepository = !repositoryKeys.size || !knownRepos.length || knownRepos.some(key => repositoryKeys.has(key));
                if (compatibleRepository && DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normN]) {
                    DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normN].forEach(a => {
                        disp.add(a);
                        repos.add(normalizeKey(a));
                        const ac = stripDoLPrefix(a);
                        if (ac && ac.length >= 3) repos.add(ac);
                    });
                }
                if (!repositoryKeys.size) knownRepos.forEach(repo => repositoryKeys.add(String(repo).toLowerCase()));
                const clean = Array.from(disp).map(cleanText).filter(Boolean);
                const allRepos = new Set(Array.from(repos).filter(Boolean));
                allRepos.forEach(r => {
                    const c = stripDoLPrefix(r);
                    if (c && c.length >= 3) allRepos.add(c);
                });
                return {
                    name: p.name,
                    version: p.version || '',
                    displayNames: clean,
                    normalizedNames: clean.map(normalizeKey),
                    repos: Array.from(allRepos),
                    repositoryKeys: Array.from(repositoryKeys)
                };
            });
        }

        const marketNorm = normalizeKey(mod.name);
        const marketRepo = extractRepoName(mod.githubUrl);
        const marketRepoKey = extractRepoKey(mod.githubUrl);
        const trustedRepoKeys = new Set([
            ...(Array.isArray(mod.repositoryKeys) ? mod.repositoryKeys : []),
            ...(DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[marketNorm] || [])
        ].map(key => String(key).toLowerCase()));
        const marketNames = new Set([mod.name, mod.wikiName, ...(mod.bootNames || []), ...(mod.aliases || [])]
            .filter(value => typeof value === 'string').map(normalizeKey).filter(Boolean));
        const marketBootNames = new Set((mod.bootNames || []).filter(name => typeof name === 'string').map(name => name.trim().toLowerCase()));
        const marketOwner = mod.identityId || (!DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(marketNorm) && DOL_OPT_IDENTITY_NAME_OWNERS.get(marketNorm));
        let bestProfile = null;
        let bestScore = 0;
        let bestMatchCount = 0;

        for (const p of profileList) {
            const normTech = normalizeKey(p.name);
            if (marketRepoKey && trustedRepoKeys.size && !trustedRepoKeys.has(marketRepoKey)) continue;
            if (marketRepoKey && p.repositoryKeys?.length && !p.repositoryKeys.includes(marketRepoKey)) continue;
            const exactName = String(p.name || '').trim().toLowerCase();
            const exactIdentity = DOL_OPT_BOOT_IDENTITIES.get(exactName);
            const localOwner = exactIdentity?.id || DOL_OPT_IDENTITY_NAME_OWNERS.get(normTech);
            if (marketOwner && localOwner && marketOwner !== localOwner && !DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(normTech)) continue;
            if (marketOwner && exactIdentity?.id && marketOwner !== exactIdentity.id) continue;
            if (marketBootNames.size && DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(normTech) && !marketBootNames.has(exactName)) continue;
            if (DOL_OPT_AMBIGUOUS_IDENTITY_NAMES.has(marketNorm) && !(marketRepoKey && p.repositoryKeys?.includes(marketRepoKey))) continue;

            // 完整技术名和权威别名精确命中；子串或简介相似不能证明是同一模组。
            let score = marketBootNames.has(exactName) ? 120 : marketNames.has(normTech) ? 110
                : p.normalizedNames.some(name => marketNames.has(name)) ? 100 : 0;
            if (!score && marketRepo && !mod.sharedRepository && !parseGithubRepo(mod.githubUrl)?.releaseTag && marketRepo === normTech) score = 90;
            if (score > bestScore) {
                bestScore = score;
                bestProfile = p;
                bestMatchCount = 1;
            } else if (score && score === bestScore) {
                bestMatchCount++;
            }
        }

        // 同分候选无法确认身份，避免取列表首项而更新了另一个模组。
        const matchedProfile = bestScore >= 80 && bestMatchCount === 1 ? bestProfile : null;
        mod._matchedLocal = matchedProfile;
        mod._matchedScore = matchedProfile ? bestScore : 0;

        if (!matchedProfile) {
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            if (isDead) return mod.otherUrl ? 'external_only' : 'unavailable';
            if (!mod.githubUrl && !mod.otherUrl) return 'unavailable';
            if (!mod.githubUrl && mod.otherUrl) return 'external_only';
            return 'not_installed';
        }

        // 比对版本
        const localVer = matchedProfile.version;
        const remoteVer = mod.version;
        if (localVer && remoteVer) {
            // 1. 检查社区版本异常容错规则库（处理作者漏改内部版本号或 Wiki 虚高误录）
            const marketNorm = normalizeKey(cleanModTitle(mod.name));
            const marketRepo = extractRepoName(mod.githubUrl);
            const localNorm = normalizeKey(matchedProfile.name);
            const rule = MOD_MARKET_VERSION_RULES.find(r =>
                r.match(marketNorm, marketRepo) || r.match(localNorm, marketRepo)
            );
            if (rule && typeof rule.isUpToDate === 'function') {
                if (rule.isUpToDate(localVer, remoteVer)) {
                    return 'up_to_date';
                }
            }

            // 2. 常规语义化版本比较；只有忽略记录实际挡住更新时才显示“已忽略”
            const cmp = compareVersions(remoteVer, localVer);
            if (cmp > 0) {
                // 检查仓库是否已知失效（已被作者移除 404）
                const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
                if (isDead) {
                    return 'up_to_date';
                }

                // 检查是否有真实可用的更新发布源：
                // 若模组来自 release-index 统一索引，但 releaseUrl 为空且版本来源为 'wiki'，
                // 说明远程未检测到 GitHub Release（仓库被删或未发 Release），版本仅为 Wiki 历史人工文本，不可作为更新依据
                const hasAuthoritativeRelease = Boolean(
                    mod.releaseUrl ||
                    mod.versionSource === 'github' ||
                    mod.downloadUrl ||
                    (Array.isArray(mod.assets) && mod.assets.length > 0)
                );

                if (!hasAuthoritativeRelease && mod.versionSource === 'wiki') {
                    return 'up_to_date';
                }

                const ignoredMap = getIgnoredUpdates();
                const ignoredVer = ignoredMap[mod.name] || (matchedProfile.name ? ignoredMap[matchedProfile.name] : null);
                if (ignoredVer && (ignoredVer === 'ignored' || compareVersions(remoteVer, ignoredVer) <= 0)) {
                    mod._isIgnored = true;
                    mod._ignoredVersion = ignoredVer;
                    return 'up_to_date';
                }
                const confirmedMap = getConfirmedUpdates();
                const confirmedVer = confirmedMap[mod.name] || (matchedProfile.name ? confirmedMap[matchedProfile.name] : null);
                if (confirmedVer && compareVersions(remoteVer, confirmedVer) <= 0) {
                    return 'up_to_date';
                }
                return 'update_available';
            }
        }
        return 'up_to_date';
    }

    function buildDependencyPlan(targetMod, mods = marketModList, profiles = getLocalInstalledProfiles(), disabledNames) {
        const actions = [];
        const actionKeys = new Set();
        const requirements = [];
        const requirementKeys = new Set();
        const unavailable = [];
        const cycles = [];
        const visited = new Set();
        const visiting = new Set();
        const disabled = disabledNames && typeof disabledNames[Symbol.iterator] === 'function'
            ? new Set(Array.from(disabledNames, normalizeKey))
            : new Set([
                ...(window._dolOptModState?.sideDisabled || []),
                ...(window._dolOptModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
            ].map(normalizeKey));
        const modKey = mod => String(mod?.identityId || mod?.id || normalizeKey(mod?.name)).toLowerCase();
        const addAction = action => {
            const key = `${modKey(action.mod)}:${action.type}`;
            if (!actionKeys.has(key)) {
                actionKeys.add(key);
                actions.push(action);
            }
        };
        const findMod = id => mods.find(mod => [mod.identityId, mod.id].some(value => String(value || '').toLowerCase() === id.toLowerCase()));

        const visit = mod => {
            const key = modKey(mod);
            if (visiting.has(key)) {
                cycles.push(mod.name || key);
                return;
            }
            if (visited.has(key)) return;
            visiting.add(key);

            for (const dependency of getModDependencies(mod)) {
                const dependencyMod = findMod(dependency.id);
                if (!dependencyMod) {
                    unavailable.push({ dependency, reason: '未在模组市场找到' });
                    continue;
                }

                const dependencyKey = modKey(dependencyMod);
                if (!requirementKeys.has(dependencyKey)) {
                    requirementKeys.add(dependencyKey);
                    requirements.push({ dependency, mod: dependencyMod });
                }

                visit(dependencyMod);
                checkModInstallStatus(dependencyMod, profiles);
                const local = dependencyMod._matchedLocal;
                const downloadable = Boolean(dependencyMod.githubUrl);
                const remoteCompatible = !dependency.version || satisfiesVersion(dependencyMod.version, dependency.version);

                if (!local) {
                    if (downloadable && remoteCompatible) {
                        addAction({ type: 'install', mod: dependencyMod, requirement: dependency.version });
                    } else {
                        unavailable.push({
                            dependency,
                            mod: dependencyMod,
                            reason: downloadable ? '市场版本不满足要求' : '没有可自动安装的发布包'
                        });
                    }
                    continue;
                }

                if (dependency.version && !satisfiesVersion(local.version, dependency.version)) {
                    if (downloadable && remoteCompatible && compareVersions(dependencyMod.version, local.version) > 0) {
                        addAction({ type: 'update', mod: dependencyMod, local, requirement: dependency.version });
                    } else {
                        unavailable.push({ dependency, mod: dependencyMod, local, reason: '本地及市场版本均不满足要求' });
                    }
                }
                if ([local.name, ...(local.displayNames || [])].some(name => disabled.has(normalizeKey(name)))) {
                    addAction({ type: 'enable', mod: dependencyMod, local, requirement: dependency.version });
                }
            }

            visiting.delete(key);
            visited.add(key);
        };

        visit(targetMod);
        return { actions, requirements, unavailable, cycles: [...new Set(cycles)] };
    }

    // 批量计划保留依赖边，显式跳过与执行失败分别处理。
    function buildBatchInstallPlan(targets, mods = marketModList, profiles = getLocalInstalledProfiles(), disabledNames,
        skippedDependencyKeys = new Set(), releaseInfos = new Map(), excludedKeys = new Map()) {
        targets = [...new Map((targets || []).map(mod => [getMarketModKey(mod), mod])).values()];
        const targetKeys = new Set(targets.map(getMarketModKey));
        const catalog = new Map();
        [...mods, ...targets].forEach(mod => [mod.id, mod.identityId].filter(Boolean).forEach(id => catalog.set(String(id).toLowerCase(), mod)));
        const disabled = new Set(Array.from(disabledNames || [
            ...(window._dolOptModState?.sideDisabled || []),
            ...(window._dolOptModState?.sideMods || []).filter(mod => !mod.enabled).map(mod => mod.name)
        ], normalizeKey));
        const nodes = new Map(), allDependencies = new Map(), dependencies = new Map(), constraints = new Map();
        const issues = new Map(), requirementsByKey = new Map(), cycles = new Set();
        const skipped = key => skippedDependencyKeys.has(key) && !targetKeys.has(key);
        const collect = mod => {
            const key = getMarketModKey(mod);
            if (nodes.has(key)) return;
            checkModInstallStatus(mod, profiles);
            const local = mod._matchedLocal;
            const needsEnable = Boolean(local && [local.name, ...(local.displayNames || [])].some(name => disabled.has(normalizeKey(name))));
            nodes.set(key, { mod, local, needsEnable });
            const edges = new Set();
            allDependencies.set(key, edges);
            for (const dependency of getModDependencies(mod)) {
                const dep = catalog.get(dependency.id.toLowerCase());
                if (!dep) {
                    issues.set(key, `未在市场找到前置【${dependency.id}】`);
                    continue;
                }
                const depKey = getMarketModKey(dep);
                edges.add(depKey);
                if (!constraints.has(depKey)) constraints.set(depKey, []);
                constraints.get(depKey).push({ parent: key, dependency });
                if (!requirementsByKey.has(depKey)) requirementsByKey.set(depKey, { mod: dep, dependency, requiredBy: [] });
                collect(dep);
            }
        };
        targets.forEach(collect);
        const reachableByTarget = new Map(), active = new Set(), order = [], visited = new Set(), visiting = [];
        const visit = key => {
            if (visiting.includes(key)) {
                visiting.slice(visiting.indexOf(key)).forEach(cycleKey => {
                    cycles.add(nodes.get(cycleKey).mod.name);
                    issues.set(cycleKey, '检测到循环依赖');
                });
                return;
            }
            if (visited.has(key)) return;
            active.add(key);
            visiting.push(key);
            const edges = new Set([...allDependencies.get(key) || []].filter(depKey => !skipped(depKey)));
            dependencies.set(key, edges);
            edges.forEach(visit);
            visiting.pop();
            visited.add(key);
            order.push(key);
        };
        targetKeys.forEach(visit);
        const collectReachable = (key, graph, seen = new Set()) => {
            if (seen.has(key)) return seen;
            seen.add(key);
            for (const dep of graph.get(key) || []) collectReachable(dep, graph, seen);
            return seen;
        };
        for (const target of targets) {
            const key = getMarketModKey(target);
            reachableByTarget.set(key, collectReachable(key, dependencies));
            for (const dep of collectReachable(key, allDependencies)) {
                requirementsByKey.get(dep)?.requiredBy.push(target.name);
            }
        }
        // 已失败或结构不完整的分支不再推动共享前置升级，避免连带阻断独立目标。
        for (const key of active) {
            const { mod, local } = nodes.get(key);
            if (excludedKeys.has(key)) issues.set(key, excludedKeys.get(key));
            if (!local && (!mod.githubUrl || mod._isDeadRepo || isDeadRepo(mod.githubUrl, mod))) issues.set(key, '没有可自动安装的发布包');
        }
        const viable = new Set();
        for (const reachable of reachableByTarget.values()) {
            if (![...reachable].some(key => issues.has(key))) reachable.forEach(key => viable.add(key));
        }
        const proposedActions = [];
        for (const key of order) {
            if (!viable.has(key)) continue;
            const { mod, local, needsEnable } = nodes.get(key);
            const requirements = (constraints.get(key) || []).filter(item => viable.has(item.parent) && !skipped(key));
            const remoteVersion = releaseInfos.get(key)?.version || mod.version;
            const needsUpdate = local && requirements.some(item => !satisfiesVersion(local.version, item.dependency.version));
            const type = !local ? 'install' : (needsUpdate ? 'update' : '');
            const finalVersion = type ? remoteVersion : local?.version;
            const downloadable = mod.githubUrl && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod);
            if (excludedKeys.has(key)) issues.set(key, excludedKeys.get(key));
            if (type && !downloadable) issues.set(key, '没有可自动安装的发布包');
            if (needsUpdate && compareVersions(remoteVersion, local.version) <= 0) issues.set(key, '市场版本无法满足前置要求');
            if (requirements.some(item => !satisfiesVersion(finalVersion, item.dependency.version))) {
                issues.set(key, `前置【${mod.name}】的最终版本不满足全部要求：${[...new Set(requirements.map(item => item.dependency.version).filter(Boolean))].join('、')}`);
            }
            const role = targetKeys.has(key) ? '目标模组' : '前置依赖';
            if (type) proposedActions.push({ type, mod, local, role, key, enableAfter: Boolean(needsEnable) });
            if (!type && needsEnable) {
                proposedActions.push({ type: 'enable', mod, local, role, key });
            }
        }
        const blocked = new Map();
        for (const [key, reachable] of reachableByTarget) {
            const reasons = [...reachable].filter(dep => issues.has(dep)).map(dep => issues.get(dep));
            if (reasons.length) blocked.set(key, [...new Set(reasons)].join('；'));
        }
        const needed = new Set();
        for (const [key, reachable] of reachableByTarget) if (!blocked.has(key)) reachable.forEach(dep => needed.add(dep));
        const requirements = [...requirementsByKey].map(([key, req]) => {
            const { local, needsEnable } = nodes.get(key);
            return {
                ...req, key, skipped: skipped(key), isTarget: targetKeys.has(key),
                satisfied: Boolean(local && !needsEnable && !issues.has(key) && (constraints.get(key) || []).every(item => satisfiesVersion(local.version, item.dependency.version))),
                requiredBy: [...new Set(req.requiredBy)]
            };
        });
        return {
            targets, actions: proposedActions.filter(action => needed.has(action.key)), allActions: proposedActions, requirements, blocked, dependencies, nodes,
            unavailable: [...issues].filter(([key]) => active.has(key)).map(([key, reason]) => ({ mod: nodes.get(key).mod, reason })),
            cycles: [...cycles]
        };
    }

    // 按唯一模组执行；失败向依赖它的任务传播，独立分支继续。
    async function executeBatchInstallPlan(plan, options = {}) {
        const results = new Map(), changedMods = new Set();
        let currentPlan = plan;
        const refresh = options.refresh || (async () => { await window.dolOptLoadModManageState?.(true); });
        const install = options.install || (action => {
            if (options.releaseInfos && !options.releaseInfos.has(action.key)) {
                action.failureReason = '安装计划已变化，请重新核对安装包';
                return false;
            }
            return downloadAndInstallMod(action.mod, currentMirrorId, {
            askRestart: false, skipReloadOffer: true, batchMode: true,
            releaseInfo: options.releaseInfos?.get(action.key),
            onFailure: reason => { action.failureReason = reason; }
            });
        });
        const enable = options.enable || (action => window.dolOptToggleSideMod?.(action.local.name, true, { silentOfferReload: true }));
        const isEnabled = action => {
            const state = window._dolOptModState;
            const item = state?.sideMods?.find(mod => mod.name === action.local?.name);
            return item ? item.enabled === true : (state?.sideEnabled || []).includes(action.local?.name);
        };
        const setResult = (action, status, reason = '') => results.set(action.key, { status, reason, action });
        for (const target of plan.targets) {
            const key = getMarketModKey(target);
            if (plan.blocked.has(key)) setResult({ key, mod: target, role: '目标模组' }, 'skipped', plan.blocked.get(key));
        }
        const failedDependency = (key, seen = new Set()) => {
            if (seen.has(key)) return null;
            seen.add(key);
            for (const dep of currentPlan.dependencies.get(key) || []) {
                const result = results.get(dep);
                if (result && result.status !== 'success') return result.action.mod.name;
                const failed = failedDependency(dep, seen);
                if (failed) return failed;
            }
            return null;
        };
        let stopped = false;
        for (let index = 0; index < plan.actions.length; index++) {
            let action = plan.actions[index];
            if (stopped || options.shouldStop?.()) {
                stopped = true;
                setResult(action, 'skipped', '已停止后续安装');
                continue;
            }
            options.onProgress?.(action, index, plan.actions.length);
            try {
                await refresh();
                currentPlan = options.getPlan?.() || plan;
                const currentAction = currentPlan.actions.find(item => item.key === action.key);
                if (!currentAction) {
                    setResult(action, 'skipped', currentPlan.blocked.get(action.key) || '已从当前安装计划移除');
                    continue;
                }
                action = currentAction;
                const dependency = failedDependency(action.key);
                if (dependency) {
                    setResult(action, 'skipped', `前置【${dependency}】未完成`);
                    continue;
                }
                if (options.confirm && !await options.confirm(plan, action, results)) {
                    setResult(action, 'skipped', '已取消冲突风险确认');
                    stopped = true;
                    continue;
                }
                // 快捷禁用可改变当前动作和依赖边，确认后不能继续执行旧的启用任务。
                currentPlan = options.getPlan?.() || plan;
                const confirmedAction = currentPlan.actions.find(item => item.key === action.key);
                if (!confirmedAction) {
                    setResult(action, 'skipped', currentPlan.blocked.get(action.key) || '已从当前安装计划移除');
                    continue;
                }
                action = confirmedAction;
                let ok = action.type === 'enable' ? await enable(action) : await install(action);
                const reportedChange = ok === true;
                if (reportedChange && action.type !== 'enable') changedMods.add(action.mod.name);
                if (action.type === 'enable' || (ok === true && action.enableAfter)) {
                    await refresh();
                    if (action.type !== 'enable' && !isEnabled(action)) {
                        await enable(action);
                        await refresh();
                    }
                    ok = isEnabled(action);
                    if (ok && reportedChange && action.type === 'enable') changedMods.add(action.mod.name);
                }
                if (ok === true) {
                    setResult(action, 'success');
                } else {
                    setResult(action, 'failed', action.failureReason || '操作未完成或已取消');
                }
            } catch (error) {
                setResult(action, 'failed', error?.message || String(error));
            }
        }
        for (const mod of plan.targets) {
            const key = getMarketModKey(mod);
            if (!results.has(key)) setResult({ key, mod, role: '目标模组' }, 'skipped', '本地已安装，无需重复安装');
        }
        return { results, changedMods };
    }

    let marketInstallBusy = false;
    async function runMarketInstallTask(task) {
        if (marketInstallBusy) {
            window.dolOptShowToast('已有市场安装任务，请等待完成后再试', 'warning');
            return false;
        }
        marketInstallBusy = true;
        try { return await task(); }
        finally { marketInstallBusy = false; }
    }

    function formatBatchInstallPlanHtml(originalTargets, activeTargets, plan, mirrorId) {
        const escape = window.dolOptEscapeHtml;
        const labels = { install: '将安装', update: '将更新', enable: '将启用' };
        const targets = originalTargets.map(mod => {
            const key = getMarketModKey(mod), reason = plan.blocked.get(key);
            const required = getModDependencies(mod).map(dependency => {
                const entry = marketModList.find(item => [item.id, item.identityId].some(id => String(id || '').toLowerCase() === dependency.id.toLowerCase()));
                return { key: entry ? getMarketModKey(entry) : dependency.id, text: `${entry?.name || dependency.id}${dependency.version ? `（${dependency.version}）` : ''}` };
            });
            for (const req of plan.requirements) {
                if (req.key !== key && req.requiredBy.includes(mod.name) && !required.some(item => item.key === req.key)) required.push({ key: req.key, text: req.mod.name });
            }
            return `<label class="dol-opt-dep-item dol-opt-dep-actionable"><input type="checkbox" class="dol-opt-dep-checkbox" name="dolOptBatchTarget" data-key="${escape(key)}" ${activeTargets.has(key) ? 'checked' : ''}><span class="dol-opt-dep-content"><span class="gold">${escape(mod.name)}</span>${required.length ? `<span class="dol-opt-batch-target-dependencies grey">需要前置：${escape(required.map(item => item.text).join('、'))}</span>` : ''}${reason ? `<span class="red">${escape(reason)}</span>` : ''}</span></label>`;
        }).join('');
        const dependencies = plan.requirements.filter(req => !req.isTarget).map(req => {
            const action = plan.actions.find(item => item.key === req.key);
            const problem = plan.unavailable.find(item => getMarketModKey(item.mod) === req.key);
            if (req.satisfied && !req.skipped && !problem) {
                return `<div class="dol-opt-dep-item dol-opt-dep-satisfied"><span class="dol-opt-dep-bullet green" aria-hidden="true">•</span><span class="dol-opt-dep-content"><span class="dol-opt-dep-name">${escape(req.mod.name)}</span><span class="green">已满足，无需下载</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span></span></div>`;
            }
            const status = req.skipped ? '自行处理，可能无法运行' : (problem?.reason || (action ? `${labels[action.type]}${action.enableAfter ? '并启用' : ''}` : '随所属目标跳过'));
            return `<label class="dol-opt-dep-item dol-opt-dep-actionable"><input type="checkbox" class="dol-opt-dep-checkbox" name="dolOptBatchDependency" data-key="${escape(req.key)}" ${req.skipped ? '' : 'checked'}><span class="dol-opt-dep-content"><span class="gold">${escape(req.mod.name)}</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span><span class="${req.skipped || problem ? 'red' : 'grey'}">${escape(status)}</span></span></label>`;
        }).join('');
        return `${formatConflictWarningHtml(detectModInstallationConflicts(null, plan.actions))}${dependencies ? `<div class="dol-opt-install-dependencies"><strong class="gold">前置依赖（需要处理的项目默认勾选，可取消）</strong>${dependencies}</div>` : ''}<div class="dol-opt-install-dependencies"><strong class="gold">所选目标</strong><div class="dol-opt-batch-target-list" role="group" aria-label="所选目标，可上下滚动" tabindex="0">${targets}</div></div><div class="dol-opt-batch-summary grey"><div>将串行处理 <strong class="gold">${plan.actions.length} 项操作</strong>；不可执行的目标会跳过。</div><div>下载线路：<strong class="gold">${escape(resolveMirrorServer(mirrorId).name)}</strong></div></div>`;
    }

    function batchConflictKey(conflict) {
        // 同一对模组从待安装变成本地已安装时，沿用玩家刚确认的风险。
        return `${conflict.ruleId}:${[conflict.incomingMod.groupName || normalizeKey(conflict.incomingMod.name),
            conflict.localConflictMod.groupName || normalizeKey(conflict.localConflictMod.name)].sort().join(':')}`;
    }

    async function installSelectedMods() {
        return runMarketInstallTask(async () => {
            const originalTargets = marketModList.filter(mod => batchInstallState.selected.has(getMarketModKey(mod)) && isBatchInstallEligible(mod));
            if (!originalTargets.length) {
                window.dolOptShowToast('请先选择尚未安装的模组', 'info');
                return false;
            }
            const mirrorId = currentMirrorId;
            if (resolveMirrorServer(mirrorId).browserOnly) {
                await window.dolOptAlert('当前线路仅支持浏览器下载，请切换到加速通道再批量安装。', '当前线路不支持批量安装');
                return false;
            }
            Object.assign(batchInstallState, { running: true, stopRequested: false, completed: 0, total: 0, current: '生成安装计划' });
            renderMarketCards();
            const activeTargets = new Set(originalTargets.map(getMarketModKey));
            const skippedDependencies = new Set(), releaseInfos = new Map(), excluded = new Map(), changedMods = new Set();
            const getPlan = () => buildBatchInstallPlan(originalTargets.filter(mod => activeTargets.has(getMarketModKey(mod))),
                marketModList, getLocalInstalledProfiles(), undefined, skippedDependencies, releaseInfos, excluded);
            const getAffectedTargets = name => [...new Set(getPlan().requirements.filter(req => req.mod._matchedLocal?.name === name).flatMap(req => req.requiredBy))];
            const onChanged = name => {
                changedMods.add(name);
                for (const req of getPlan().requirements) {
                    if (!req.isTarget && req.mod._matchedLocal?.name === name) skippedDependencies.add(req.key);
                }
            };
            let outcome = null;
            try {
                await window.dolOptLoadModManageState?.(true);
                const prepareDownloads = async downloads => {
                    batchInstallState.total = downloads.length;
                    for (const [index, action] of downloads.entries()) {
                        if (batchInstallState.stopRequested) break;
                        Object.assign(batchInstallState, { current: `读取【${action.mod.name}】安装包`, completed: index });
                        renderBatchInstallToolbar();
                        const controller = typeof AbortController === 'function' ? new AbortController() : null;
                        if (controller) activeDownloadControllers.set(action.mod.name, controller);
                        updateDownloadProgress(action.mod.name, null, '正在读取安装包清单...');
                        try {
                            let release = await fetchModRelease(action.mod, { useCache: true, signal: controller?.signal });
                            if (release.requiresManualSelection) {
                                const choice = await window.dolOptConfirm({
                                    title: `选择【${action.mod.name}】的安装包`,
                                    message: `${release.selectionReason || '请选择适合当前游戏的安装包。'}\n取消将跳过此项及依赖它的模组。`,
                                    selectLabel: '主安装包', selectOptions: getManualAssetOptions(release), selectValue: '',
                                    requireSelection: true, confirmText: '使用所选包', cancelText: '跳过此项', confirmType: 'primary'
                                });
                                release = applyManualAssetSelection(release, choice);
                                if (!release) throw new Error('已取消安装包选择');
                            }
                            if (!getReleaseInstallAssets(release).length) throw new Error('没有可自动安装的发布包，请单独处理');
                            releaseInfos.set(action.key, release);
                        } catch (error) {
                            excluded.set(action.key, error?.name === 'AbortError' ? '已取消安装包读取' : (error?.message || '读取安装包失败'));
                        } finally {
                            if (activeDownloadControllers.get(action.mod.name) === controller) activeDownloadControllers.delete(action.mod.name);
                            resetDownloadProgress(action.mod.name);
                        }
                    }
                };
                await prepareDownloads(getPlan().allActions.filter(action => action.type !== 'enable'));
                if (batchInstallState.stopRequested) {
                    outcome = { results: new Map(originalTargets.map(mod => [getMarketModKey(mod), {
                        status: 'skipped', reason: '已停止后续安装', action: { mod, role: '目标模组' }
                    }])) };
                } else {
                    batchInstallState.current = '核对安装清单';
                    renderBatchInstallToolbar();
                    const planHtml = () => formatBatchInstallPlanHtml(originalTargets, activeTargets, getPlan(), mirrorId);
                    let pendingPlanChange = null;
                    const confirmPlan = () => window.dolOptConfirm({
                        title: '批量安装确认', message: '请核对所选目标、前置依赖和兼容性警告。',
                        trustedMessageHtml: `<div id="dolOptBatchPlan">${planHtml()}</div>`,
                        dialogClass: 'dol-opt-install-dialog', confirmText: '开始批量安装', cancelText: '取消', confirmType: 'primary',
                        onRender: dialog => {
                            const area = dialog.querySelector('#dolOptBatchPlan');
                            const render = () => {
                                const scrollTop = area.querySelector('.dol-opt-batch-target-list')?.scrollTop || 0;
                                area.innerHTML = planHtml();
                                const targetList = area.querySelector('.dol-opt-batch-target-list');
                                if (targetList) targetList.scrollTop = scrollTop;
                                area.querySelectorAll('input[name="dolOptBatchTarget"], input[name="dolOptBatchDependency"]').forEach(input => {
                                    input.onchange = () => {
                                        const set = input.name === 'dolOptBatchTarget' ? activeTargets : skippedDependencies;
                                        const add = input.name === 'dolOptBatchTarget' ? input.checked : !input.checked;
                                        if (add) set.add(input.dataset.key); else set.delete(input.dataset.key);
                                        render();
                                        Array.from(area.querySelectorAll('input')).find(next => next.name === input.name && next.dataset.key === input.dataset.key)?.focus({ preventScroll: true });
                                    };
                                });
                                area.querySelectorAll('.dol-opt-conflict-disable-btn').forEach(button => {
                                    button.onclick = async () => {
                                        if (pendingPlanChange) return;
                                        button.disabled = true;
                                        pendingPlanChange = (async () => {
                                            try {
                                                if (await disableInstallConflict(button.dataset.conflictRaw, button.dataset.conflictName, getAffectedTargets(button.dataset.conflictRaw))) onChanged(button.dataset.conflictRaw);
                                            } catch (error) { window.dolOptShowToast(error.message || '快捷禁用失败', 'warning'); }
                                        })();
                                        await pendingPlanChange;
                                        pendingPlanChange = null;
                                        render();
                                    };
                                });
                            };
                            render();
                        }
                    });
                    let choice;
                    while (true) {
                        choice = await confirmPlan();
                        if (pendingPlanChange) await pendingPlanChange;
                        if (!choice || batchInstallState.stopRequested) break;
                        await window.dolOptLoadModManageState?.(true);
                        const newDownloads = getPlan().actions.filter(action => action.type !== 'enable'
                            && !releaseInfos.has(action.key) && !excluded.has(action.key));
                        if (!newDownloads.length) break;
                        // 改勾选可能恢复原先受阻的分支，先补齐真实发布信息再让玩家核对。
                        await prepareDownloads(newDownloads);
                        batchInstallState.current = '核对更新后的安装清单';
                        renderBatchInstallToolbar();
                    }
                    if (choice && !batchInstallState.stopRequested) {
                        await window.dolOptLoadModManageState?.(true);
                        if (await confirmInstallConflicts(() => ({ targetMod: null, actions: getPlan().actions }), { onChanged, getAffectedTargets })) {
                            const plan = getPlan();
                            const approved = new Set(detectModInstallationConflicts(null, plan.actions).filter(item => item.localConflictMod.isEnabled).map(batchConflictKey));
                            const approvedActions = new Set(plan.actions.map(action => `${action.key}:${action.type}`));
                            outcome = await executeBatchInstallPlan(plan, {
                                releaseInfos,
                                getPlan,
                                shouldStop: () => batchInstallState.stopRequested,
                                onProgress: (action, index, total) => {
                                    Object.assign(batchInstallState, { current: action.mod.name, completed: index, total });
                                    renderBatchInstallToolbar();
                                },
                                confirm: async (_plan, action, results) => {
                                    const remaining = () => {
                                        const current = getPlan();
                                        if (current.blocked.has(action.key)) throw new Error(current.blocked.get(action.key));
                                        const actions = current.actions.filter(item => !results.has(item.key));
                                        if (actions.some(item => !approvedActions.has(`${item.key}:${item.type}`))) throw new Error('前置状态已改变，请重新生成安装计划');
                                        return { targetMod: null, actions };
                                    };
                                    const conflicts = detectModInstallationConflicts(null, remaining().actions).filter(item => item.localConflictMod.isEnabled);
                                    if (!conflicts.some(item => !approved.has(batchConflictKey(item)))) return true;
                                    if (!await confirmInstallConflicts(remaining, { onChanged, getAffectedTargets })) return false;
                                    detectModInstallationConflicts(null, remaining().actions).forEach(item => approved.add(batchConflictKey(item)));
                                    return true;
                                }
                            });
                            outcome.changedMods.forEach(name => changedMods.add(name));
                        }
                    }
                }
            } catch (error) {
                await window.dolOptAlert(error?.message || String(error), '批量安装未完成');
            } finally {
                batchInstallState.running = false;
                batchInstallState.current = '';
                batchInstallState.completed = batchInstallState.total;
                if (outcome) for (const [key, result] of outcome.results) if (result.status === 'success') batchInstallState.selected.delete(key);
                renderMarketCards();
            }
            const targets = outcome ? [...outcome.results.values()].filter(result => result.action.role === '目标模组') : [];
            const count = status => targets.filter(result => result.status === status).length;
            const dependencies = outcome ? [...outcome.results.values()].filter(result => result.action.role !== '目标模组') : [];
            const summary = outcome
                ? `目标模组：成功 ${count('success')} 个，失败 ${count('failed')} 个，跳过 ${count('skipped')} 个。\n前置处理：成功 ${dependencies.filter(result => result.status === 'success').length} 项，未完成 ${dependencies.filter(result => result.status !== 'success').length} 项。\n\n${[...outcome.results.values()].filter(result => result.status !== 'success').map(result => `· ${result.action.mod.name}：${result.reason}`).join('\n')}`
                : '批量安装已取消。';
            if (changedMods.size) {
                const isFramework = [...changedMods].some(name => window.dolOptIsFrameworkMod?.(name));
                if (typeof window.dolOptOfferReload === 'function') await window.dolOptOfferReload(summary, { isFramework });
                else {
                    const restart = await window.dolOptConfirm({ title: '批量安装结果', message: `${summary}\n\n是否立即重新载入游戏？`, confirmText: '立即重载', cancelText: '稍后重载', confirmType: 'primary' });
                    if (restart) location.reload();
                }
            } else if (outcome) await window.dolOptAlert(summary, '批量安装结果');
            return outcome || false;
        });
    }

    // ==================== 模组兼容性与冲突检测 ====================

    /** 已知模组冲突与兼容性互斥规则库 */
    const KNOWN_MOD_CONFLICT_RULES = [
        {
            id: 'maplebirch-vs-simpleframework',
            name: '秋枫白桦框架 与 简易框架 互斥',
            conflictingGroups: [
                {
                    key: 'maplebirch',
                    name: '秋枫白桦框架',
                    aliases: [
                        'maplebirch', '秋枫白桦', '秋枫白桦框架', '枫叶框架', 'maplebirchframework',
                        'scml-dol-maplebirchframework', 'scmldolmaplebirchframework',
                        'MaplebirchLeaf/SCML-DOL-maplebirchframework'
                    ]
                },
                {
                    key: 'simpleframework',
                    name: '简易框架',
                    aliases: [
                        'simpleframework', '简易框架', 'scmlsimpleframework',
                        'simpleframeworks', 'Simple Frameworks', 'SimpleFrameworks',
                        'emicoto/SCMLSimpleFramework'
                    ]
                }
            ],
            reason: '两者底层挂钩机制与核心段落重写逻辑互斥，同时启用可能导致脚本报错、界面错乱或存档损坏。',
            advice: '在【模组管理】中先禁用或卸载冲突框架，切勿同时启用两者。',
            level: 'danger'
        }
    ];

    /** 判断模组对象或名称是否匹配某个冲突组 */
    function isModMatchingConflictGroup(modOrName, group) {
        if (!modOrName || !group) return false;
        const targetKeys = [group.key, ...(group.aliases || [])].map(normalizeKey).filter(Boolean);

        const candidates = [];
        if (typeof modOrName === 'string') {
            candidates.push(modOrName);
        } else if (typeof modOrName === 'object') {
            if (modOrName.name) candidates.push(modOrName.name);
            if (modOrName.identityId) candidates.push(modOrName.identityId);
            if (modOrName.id) candidates.push(modOrName.id);
            if (modOrName.bootJson?.name) candidates.push(modOrName.bootJson.name);
            if (modOrName.bootJson?.nickName) {
                if (typeof modOrName.bootJson.nickName === 'string') candidates.push(modOrName.bootJson.nickName);
                else if (typeof modOrName.bootJson.nickName === 'object') {
                    Object.values(modOrName.bootJson.nickName).forEach(val => val && candidates.push(val));
                }
            }
            if (modOrName.nickName) {
                if (typeof modOrName.nickName === 'string') candidates.push(modOrName.nickName);
                else if (typeof modOrName.nickName === 'object') {
                    Object.values(modOrName.nickName).forEach(val => val && candidates.push(val));
                }
            }
            if (Array.isArray(modOrName.displayNames)) {
                candidates.push(...modOrName.displayNames);
            }
            if (Array.isArray(modOrName.normalizedNames)) {
                candidates.push(...modOrName.normalizedNames);
            }
            if (modOrName.githubUrl) {
                // 仓库仅匹配完整身份，作者名包含框架名不代表该模组就是框架。
                const repository = extractRepoKey(modOrName.githubUrl);
                if (repository && (group.aliases || []).some(alias => String(alias).toLowerCase() === repository)) return true;
            }
        }

        for (const candidate of candidates) {
            const norm = normalizeKey(candidate);
            const stripped = stripDoLPrefix(candidate);
            for (const target of targetKeys) {
                if (norm === target || stripped === target) return true;
                if (target.length >= 4 && (norm.includes(target) || stripped.includes(target))) return true;
            }
        }
        return false;
    }

    /** 解析冲突模组的友好中文展示名称（优先中文昵称或冲突组预设名称，避免生硬展示英文标识） */
    function resolveConflictModDisplayName(modOrProfile, group) {
        if (!modOrProfile) return group?.name || '未知模组';

        // 1. 如果对象带有中文 nickName
        const boot = modOrProfile.bootJson || {};
        const nick = boot.nickName || modOrProfile.nickName;
        if (typeof nick === 'object' && nick) {
            const cn = nick.chs || nick.zh || nick.cn || nick.default;
            if (typeof cn === 'string' && /[\u4e00-\u9fa5]/.test(cn)) return cn.trim();
        } else if (typeof nick === 'string' && /[\u4e00-\u9fa5]/.test(nick)) {
            return nick.trim();
        }

        // 2. 如果自身的 name 已经包含汉字
        const selfName = typeof modOrProfile === 'string' ? modOrProfile : (modOrProfile.name || '');
        if (/[\u4e00-\u9fa5]/.test(selfName)) {
            return selfName.trim();
        }

        // 3. 优先使用匹配到的冲突组标准中文名（如 group.name 即 '秋枫白桦框架'、'简易框架'）
        if (group?.name && /[\u4e00-\u9fa5]/.test(group.name)) {
            return group.name;
        }

        // 4. 从市场模组列表查找中文名
        if (Array.isArray(marketModList)) {
            const normKey = normalizeKey(selfName);
            const match = marketModList.find(m => normalizeKey(m.name) === normKey && /[\u4e00-\u9fa5]/.test(m.name));
            if (match) return match.name;
        }

        // 5. 从已知模组别名映射词库查找中文别名
        const normKey = normalizeKey(selfName);
        if (DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normKey]) {
            const found = DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normKey].find(a => /[\u4e00-\u9fa5]/.test(a));
            if (found) return found;
        }

        return selfName;
    }

    /** 查找本地已启用的依赖于指定冲突模组的其他模组列表（用于禁用前影响评估） */
    function findDependentModsForConflict(targetRawName, profiles = getLocalInstalledProfiles(), disabledNames) {
        if (!targetRawName) return [];

        const disabled = disabledNames && typeof disabledNames[Symbol.iterator] === 'function'
            ? new Set(Array.from(disabledNames, normalizeKey))
            : new Set([
                ...(window._dolOptModState?.sideDisabled || []),
                ...(window._dolOptModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
            ].map(normalizeKey));

        // 找到该冲突模组所匹配的冲突组（如果有），以获取全部别名并提取对手组
        let matchingGroup = null;
        let matchedRule = null;
        for (const rule of KNOWN_MOD_CONFLICT_RULES) {
            for (const grp of rule.conflictingGroups || []) {
                if (isModMatchingConflictGroup(targetRawName, grp)) {
                    matchingGroup = grp;
                    matchedRule = rule;
                    break;
                }
            }
            if (matchingGroup) break;
        }

        // 收集对手组别名，防止互斥组别名交叉污染导致误判
        const opponentKeySet = new Set();
        if (matchedRule && matchingGroup) {
            for (const grp of matchedRule.conflictingGroups || []) {
                if (grp !== matchingGroup) {
                    [grp.key, ...(grp.aliases || [])].map(normalizeKey).forEach(k => opponentKeySet.add(k));
                }
            }
        }

        const isOpponentKey = (norm) => {
            if (!norm) return false;
            if (opponentKeySet.has(norm)) return true;
            for (const opp of opponentKeySet) {
                if (opp.length >= 4 && (norm === opp || norm.includes(opp) || opp.includes(norm))) return true;
            }
            return false;
        };

        const targetKeys = new Set();
        const addTargetKey = (name) => {
            if (!name) return;
            const norm = normalizeKey(name);
            if (!norm || isOpponentKey(norm)) return;
            targetKeys.add(norm);
            const stripped = normalizeKey(stripDoLPrefix(name));
            if (stripped && stripped.length >= 3 && !isOpponentKey(stripped)) {
                targetKeys.add(stripped);
            }
        };

        addTargetKey(targetRawName);
        if (matchingGroup) {
            [matchingGroup.key, ...(matchingGroup.aliases || [])].forEach(addTargetKey);
        }

        const targetKeyList = Array.from(targetKeys);

        const matchesTarget = (name) => {
            if (!name) return false;
            const norm = normalizeKey(name);
            const stripped = normalizeKey(stripDoLPrefix(name));

            // 防线：若明确指向对手组（如依赖 Simple Frameworks），则绝不匹配本目标
            if (isOpponentKey(norm) || (stripped && isOpponentKey(stripped))) {
                return false;
            }

            for (const t of targetKeyList) {
                if (norm === t || stripped === t) return true;
                if (t.length >= 4 && (norm.includes(t) || (stripped && stripped.includes(t)))) return true;
            }
            return false;
        };

        const isSelfMatch = (profile) => {
            if (!profile) return false;
            if (matchesTarget(profile.name)) return true;
            if (profile.rawName && matchesTarget(profile.rawName)) return true;
            if (profile.bootJson?.name && matchesTarget(profile.bootJson.name)) return true;
            return false;
        };

        const affected = [];
        const seenNames = new Set();

        for (const profile of profiles || []) {
            // 排除自身
            if (isSelfMatch(profile)) continue;

            // 仅检查当前已启用的模组
            const localNames = [profile.name, ...(profile.displayNames || [])];
            const isLocalDisabled = localNames.some(n => disabled.has(normalizeKey(n)));
            if (isLocalDisabled) continue;

            const boot = profile.bootJson || window.dolOptGetModInfo?.(profile.name)?.bootJson || {};
            const deps = [
                ...(Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []),
                ...(Array.isArray(boot.addonPlugin) ? boot.addonPlugin : []),
                ...(Array.isArray(boot.dependencies) ? boot.dependencies : []),
                ...(Array.isArray(boot.depends) ? boot.depends : [])
            ];

            let dependsOnTarget = false;
            for (const dep of deps) {
                const depName = typeof dep === 'string' ? dep : (dep.modName || dep.name || dep.id);
                if (matchesTarget(depName)) {
                    dependsOnTarget = true;
                    break;
                }
            }

            if (dependsOnTarget) {
                const displayName = profile.bootJson?.nickName?.chs ||
                    (typeof profile.bootJson?.nickName === 'string' ? profile.bootJson.nickName : null) ||
                    profile.name;
                const normKey = normalizeKey(profile.name);
                if (!seenNames.has(normKey)) {
                    seenNames.add(normKey);
                    affected.push({
                        name: displayName,
                        rawName: profile.name,
                        version: boot.version || profile.version || ''
                    });
                }
            }
        }

        return affected;
    }

    /** 检测即将安装的模组集合与本地环境是否存在已知互斥冲突 */
    function detectModInstallationConflicts(targetMod, candidateActions = [], profiles = getLocalInstalledProfiles(), disabledNames) {
        const disabled = disabledNames && typeof disabledNames[Symbol.iterator] === 'function'
            ? new Set(Array.from(disabledNames, normalizeKey))
            : new Set([
                ...(window._dolOptModState?.sideDisabled || []),
                ...(window._dolOptModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
            ].map(normalizeKey));

        // 即将引入的候选模组列表
        const incomingItems = [];
        const incomingByKey = new Map();
        const incomingLocalKeys = new Map();
        const modKey = mod => String(mod?.identityId || mod?.id || normalizeKey(mod?.name)).toLowerCase();
        const addIncoming = (mod, role, actionType, local) => {
            const key = modKey(mod);
            if (!mod || !key) return;
            const localName = local?.name || mod._matchedLocal?.name;
            if (localName) incomingLocalKeys.set(normalizeKey(localName), key);
            const existing = incomingByKey.get(key);
            if (existing) {
                if (role === '目标模组') existing.role = role;
                return;
            }
            const item = { mod, key, name: mod.name || role, role, actionType };
            incomingByKey.set(key, item);
            incomingItems.push(item);
        };
        if (targetMod) {
            addIncoming(targetMod, '目标模组');
        }
        (candidateActions || []).forEach(action => {
            if (action?.mod) {
                addIncoming(action.mod, action.role || '前置依赖', action.type, action.local);
            }
        });

        const conflicts = [];
        const seenConflictKeys = new Set();

        for (const rule of KNOWN_MOD_CONFLICT_RULES) {
            if (!Array.isArray(rule.conflictingGroups) || rule.conflictingGroups.length < 2) continue;
            const [groupA, groupB] = rule.conflictingGroups;

            // 1. 即将安装的模组 与 本地已有模组 的冲突检测
            for (const incoming of incomingItems) {
                const matchesA = isModMatchingConflictGroup(incoming.mod, groupA);
                const matchesB = isModMatchingConflictGroup(incoming.mod, groupB);
                if (!matchesA && !matchesB) continue;

                const opponentGroup = matchesA ? groupB : groupA;
                const matchedIncomingGroup = matchesA ? groupA : groupB;

                for (const profile of profiles || []) {
                    if (isModMatchingConflictGroup(profile, opponentGroup)) {
                        const localKey = incomingLocalKeys.get(normalizeKey(profile.name)) || modKey(profile);
                        // 已在安装集合中的本地项统一由内部互斥检查展示，避免重复或误示可快捷消除。
                        if (incomingByKey.has(localKey)) continue;
                        const localNames = [profile.name, ...(profile.displayNames || [])];
                        const isLocalDisabled = localNames.some(n => disabled.has(normalizeKey(n)));
                        const isLocalEnabled = !isLocalDisabled;

                        const conflictKey = `${rule.id}:local:${incoming.key}:${localKey}`;
                        if (!seenConflictKeys.has(conflictKey)) {
                            seenConflictKeys.add(conflictKey);
                            const incomingDisplayName = resolveConflictModDisplayName(incoming.mod, matchedIncomingGroup);
                            const localDisplayName = resolveConflictModDisplayName(profile, opponentGroup);

                            conflicts.push({
                                ruleId: rule.id,
                                incomingMod: {
                                    key: incoming.key,
                                    name: incomingDisplayName,
                                    role: incoming.role,
                                    groupName: matchedIncomingGroup.name
                                },
                                localConflictMod: {
                                    key: localKey,
                                    name: localDisplayName,
                                    rawName: profile.name,
                                    groupName: opponentGroup.name,
                                    isEnabled: isLocalEnabled
                                },
                                reason: rule.reason,
                                advice: rule.advice,
                                level: rule.level || 'danger'
                            });
                        }
                    }
                }
            }

            // 2. 即将安装的集合内部（如目标自身 vs 某个勾选前置，或两个勾选前置之间）的互斥检测
            for (let i = 0; i < incomingItems.length; i++) {
                for (let j = i + 1; j < incomingItems.length; j++) {
                    const item1 = incomingItems[i];
                    const item2 = incomingItems[j];
                    const item1MatchesA = isModMatchingConflictGroup(item1.mod, groupA);
                    const item1MatchesB = isModMatchingConflictGroup(item1.mod, groupB);
                    const item2MatchesA = isModMatchingConflictGroup(item2.mod, groupA);
                    const item2MatchesB = isModMatchingConflictGroup(item2.mod, groupB);

                    if ((item1MatchesA && item2MatchesB) || (item1MatchesB && item2MatchesA)) {
                        const conflictKey = `${rule.id}:internal:${[item1.key, item2.key].sort().join(':')}`;
                        if (!seenConflictKeys.has(conflictKey)) {
                            seenConflictKeys.add(conflictKey);
                            const item1Group = item1MatchesA ? groupA : groupB;
                            const item2Group = item2MatchesA ? groupA : groupB;
                            const item1DisplayName = resolveConflictModDisplayName(item1.mod, item1Group);
                            const item2DisplayName = resolveConflictModDisplayName(item2.mod, item2Group);

                            conflicts.push({
                                ruleId: rule.id,
                                incomingMod: {
                                    key: item1.key,
                                    name: item1DisplayName,
                                    role: item1.role,
                                    groupName: item1Group.name
                                },
                                localConflictMod: {
                                    key: item2.key,
                                    name: item2DisplayName,
                                    rawName: item2.name,
                                    groupName: item2Group.name,
                                    isEnabled: true,
                                    isIncoming: true
                                },
                                reason: rule.reason,
                                advice: rule.advice,
                                level: rule.level || 'danger'
                            });
                        }
                    }
                }
            }
        }

        return conflicts;
    }

    /** 格式化冲突警告卡片 HTML */
    function formatConflictWarningHtml(conflicts) {
        if (!conflicts || !conflicts.length) return '';
        const escape = value => typeof window.dolOptEscapeHtml === 'function' ? window.dolOptEscapeHtml(String(value ?? '')) : String(value ?? '');

        // 判定是否存在未解决的高风险冲突（包括即将安装的前置互斥，或本地已启用的冲突模组）
        const hasActiveConflict = conflicts.some(c => c.localConflictMod?.isIncoming || c.localConflictMod?.isEnabled);

        const itemsHtml = conflicts.map(c => {
            const isLocalEnabled = c.localConflictMod?.isEnabled;
            const isIncoming = c.localConflictMod?.isIncoming;
            const statusBadge = isIncoming
                ? '<span class="dol-opt-conflict-tag red">安装项间互斥</span>'
                : (isLocalEnabled
                    ? '<span class="dol-opt-conflict-tag red">本地冲突已启用·高风险</span>'
                    : '<span class="dol-opt-conflict-tag green">本地已安装·当前禁用</span>');

            const targetDesc = isIncoming ? '将一并安装的' : '本地';
            const conflictModColor = (isIncoming || isLocalEnabled) ? 'red' : 'green';

            // 快捷禁用按钮（仅针对本地已安装且处于已启用状态的冲突模组）
            const disableActionHtml = (!isIncoming && isLocalEnabled)
                ? `
                    <div class="dol-opt-conflict-action-row">
                        <button type="button" class="macro-button dol-opt-conflict-disable-btn" data-conflict-raw="${escape(c.localConflictMod.rawName)}" data-conflict-name="${escape(c.localConflictMod.name)}">
                            快捷禁用【${escape(c.localConflictMod.name)}】
                        </button>
                    </div>
                `
                : '';

            const adviceHtml = (!isIncoming && !isLocalEnabled)
                ? `<div class="dol-opt-conflict-advice"><strong class="green">检查结果：</strong>本地冲突模组当前处于禁用状态，不会与新安装模组产生运行时互斥，可安全安装。</div>`
                : `<div class="dol-opt-conflict-advice"><strong class="gold">建议：</strong>${escape(c.advice)}</div>`;

            return `
                <div class="dol-opt-conflict-item">
                    <div class="dol-opt-conflict-title-row">
                        <span class="dol-opt-conflict-name gold">【${escape(c.incomingMod.name)}】</span>
                        <span class="grey">与${targetDesc}</span>
                        <span class="dol-opt-conflict-name ${conflictModColor}">【${escape(c.localConflictMod.name)}】</span>
                        <span class="grey">存在冲突</span>
                        ${statusBadge}
                    </div>
                    <div class="dol-opt-conflict-reason grey">${escape(c.reason)}</div>
                    ${adviceHtml}
                    ${disableActionHtml}
                </div>
            `;
        }).join('');

        const cardClass = hasActiveConflict ? 'dol-opt-install-conflict-card' : 'dol-opt-install-conflict-card is-resolved';
        const badgeHtml = hasActiveConflict
            ? '<span class="dol-opt-conflict-badge red">兼容性警告</span>'
            : '<span class="dol-opt-conflict-badge green">检查通过</span>';
        const headingHtml = hasActiveConflict
            ? '<strong class="dol-opt-conflict-heading red">检测到已知模组冲突</strong>'
            : '<strong class="dol-opt-conflict-heading green">冲突已排除 · 兼容性检查通过</strong>';

        return `
            <div class="${cardClass}">
                <div class="dol-opt-conflict-header">
                    ${badgeHtml}
                    ${headingHtml}
                </div>
                <div class="dol-opt-conflict-list">
                    ${itemsHtml}
                </div>
            </div>
        `;
    }

    async function disableInstallConflict(rawName, displayName, pendingTargets = []) {
        if (!rawName || typeof window.dolOptToggleSideMod !== 'function') return false;
        await window.dolOptLoadModManageState?.(true);
        const affectedMods = findDependentModsForConflict(rawName);
        const affectedText = affectedMods.map(item => `· 【${item.name}】${item.version ? ` (${item.version})` : ''}`).join('\n');
        const escape = window.dolOptEscapeHtml;
        const localHtml = affectedMods.map(item => `<div class="dol-opt-modal-affected-item"><strong class="gold">${escape(item.name)}</strong>${item.version ? ` <span class="grey">(${escape(item.version)})</span>` : ''}</div>`).join('');
        const pendingHtml = pendingTargets.map(name => `<div class="dol-opt-modal-affected-item"><strong class="gold">${escape(name)}</strong></div>`).join('');
        const confirmed = await window.dolOptConfirm({
            title: `确认快捷禁用【${displayName}】？`,
            message: affectedMods.length
                ? `禁用【${displayName}】后，以下依赖该框架的模组可能会受到影响或无法正常运行：\n\n${affectedText}\n\n是否仍然确认禁用？`
                : `确定要禁用【${displayName}】吗？\n禁用后会重新检查安装计划。`,
            trustedMessageHtml: `<div class="dol-opt-modal-intro">将禁用 <strong class="red">【${escape(displayName)}】</strong>。依赖它的模组可能无法正常运行。</div>${localHtml ? `<div class="dol-opt-modal-affected-box"><strong>本地受影响模组（${affectedMods.length}）</strong>${localHtml}</div>` : '<p class="grey">未发现依赖它的本地已启用模组。</p>'}${pendingHtml ? `<div class="dol-opt-modal-affected-box"><strong>本次安装受影响目标（${pendingTargets.length}）</strong>${pendingHtml}</div><p class="grey">本次将取消该前置的自动处理，保持禁用；上述目标需要你自行处理前置后才能正常运行。</p>` : ''}<div class="dol-opt-modal-question grey">禁用后将重新读取本地状态并检查兼容性。是否确认禁用？</div>`,
            dialogClass: 'dol-opt-install-dialog',
            confirmText: '确认禁用',
            cancelText: '暂不禁用',
            confirmType: affectedMods.length || pendingTargets.length ? 'danger' : 'warning'
        });
        if (!confirmed) return false;
        const result = await window.dolOptToggleSideMod(rawName, false, { silentOfferReload: true, skipConfirm: true });
        if (result !== true) return false;
        await window.dolOptLoadModManageState?.(true);
        const state = window._dolOptModState;
        const local = state?.sideMods?.find(item => item.name === rawName);
        const disabled = local ? local.enabled === false : (state?.sideDisabled || []).includes(rawName);
        if (!disabled) {
            window.dolOptShowToast(`未能确认【${displayName}】已禁用，请检查模组管理状态`, 'warning');
            return false;
        }
        window.dolOptShowToast(`已快捷禁用【${displayName}】，正在重新检查安装计划`, 'success');
        return true;
    }

    /** 单装和批量安装共用；每次读取当前计划，避免快捷禁用后误报冲突消除。 */
    async function confirmInstallConflicts(getActivePlan, options = {}) {
        const readConflicts = () => {
            const plan = getActivePlan();
            return detectModInstallationConflicts(plan.targetMod, plan.actions);
        };
        const activeConflicts = conflicts => conflicts.filter(item => item.localConflictMod?.isIncoming || item.localConflictMod?.isEnabled);
        const signature = conflicts => activeConflicts(conflicts).map(item => {
            const incomingKey = item.incomingMod.key || normalizeKey(item.incomingMod.name);
            const otherKey = item.localConflictMod.key || normalizeKey(item.localConflictMod.rawName);
            const pair = item.localConflictMod.isIncoming ? [incomingKey, otherKey].sort() : [incomingKey, otherKey];
            return `${item.ruleId}:${item.localConflictMod.isIncoming ? 'internal' : 'local'}:${pair.join(':')}`;
        }).sort().join('|');

        while (true) {
            const initialConflicts = readConflicts();
            const initialSignature = signature(initialConflicts);
            if (!initialSignature) return true;
            let pendingChange = null;
            let clearedRisk = false;
            const choice = await window.dolOptConfirm({
                title: '模组冲突风险确认',
                message: '检测到本次安装与本地模组或安装项之间存在已知兼容性冲突。同时启用可能导致脚本报错、界面错乱或存档损坏。是否确认继续安装？',
                trustedMessageHtml: `<div class="dol-opt-install-conflict-review">${formatConflictWarningHtml(initialConflicts)}</div><div class="dol-opt-modal-conflict-question grey">同时启用互斥模组可能导致脚本报错、界面错乱或存档损坏。是否确认继续安装？</div>`,
                dialogClass: 'dol-opt-install-dialog',
                confirmText: '继续安装',
                cancelText: '取消安装',
                confirmType: 'danger',
                confirmDelay: 5,
                onRender: dialog => {
                    const area = dialog.querySelector('.dol-opt-install-conflict-review');
                    const render = () => {
                        const conflicts = readConflicts();
                        if (area) area.innerHTML = formatConflictWarningHtml(conflicts) || '<div class="green">当前安装计划的已知冲突已排除。</div>';
                        const hasActive = activeConflicts(conflicts).length > 0;
                        if (!hasActive) {
                            clearedRisk = true;
                            dialog.dolOptClearDelay?.();
                            const button = dialog.querySelector('.dol-opt-modal-btn-confirm');
                            if (button) {
                                button.className = button.className.replace(/\bdol-opt-btn-danger\b/, 'dol-opt-btn-primary');
                                button.textContent = '确认安装';
                            }
                            const question = dialog.querySelector('.dol-opt-modal-conflict-question');
                            if (question) question.textContent = '当前安装计划的已知冲突已排除，确认后继续安装。';
                        }
                        area?.querySelectorAll('.dol-opt-conflict-disable-btn').forEach(button => {
                            button.onclick = async event => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (pendingChange) return;
                                const rawName = button.dataset.conflictRaw;
                                const current = readConflicts().find(item => !item.localConflictMod.isIncoming && item.localConflictMod.isEnabled && item.localConflictMod.rawName === rawName);
                                if (!current) return render();
                                button.disabled = true;
                                const change = (async () => {
                                    try {
                                        if (await disableInstallConflict(rawName, current.localConflictMod.name, options.getAffectedTargets?.(rawName))) {
                                            await options.onChanged?.(rawName);
                                        }
                                    } catch (error) {
                                        console.error('[dolModMarket] 快捷禁用冲突模组失败:', error);
                                        window.dolOptShowToast('快捷禁用未完成，请检查模组管理器状态', 'warning');
                                    }
                                })();
                                pendingChange = change;
                                await change;
                                pendingChange = null;
                                render();
                            };
                        });
                    };
                    render();
                },
                customResult: () => ({ ready: !pendingChange })
            });
            if (pendingChange) await pendingChange;
            if (!choice) return false;
            const currentSignature = signature(readConflicts());
            if (!currentSignature) return true;
            // 弹窗期间新增或改变的活跃风险必须重新展示并完成倒计时确认。
            if (!clearedRisk && choice.ready !== false && currentSignature === initialSignature) return true;
        }
    }

    // ==================== 下载与一键安装 ====================

    const activeDownloadControllers = new Map();
    const downloadProgressState = new Map();

    function cancelDownload(modName) {
        const controller = activeDownloadControllers.get(modName);
        if (!controller || controller.signal.aborted) return false;
        controller.abort();
        return true;
    }

    function updateDownloadProgress(modName, percent, text, state = 'active') {
        downloadProgressState.set(modName, { percent, text, state });
        const cards = Array.from(document.querySelectorAll?.('.dol-opt-market-card') || []);
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.dol-opt-download-progress');
        if (!progress) return;

        const value = percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
        const track = progress.querySelector('.dol-opt-download-track');
        const bar = progress.querySelector('.dol-opt-download-bar');
        const label = progress.querySelector('.dol-opt-download-label');
        const cancelButton = progress.querySelector('.dol-opt-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        progress.hidden = false;
        progress.classList.toggle('is-indeterminate', value === null && state === 'active');
        progress.classList.toggle('is-error', state === 'error');
        if (value === null) {
            track.removeAttribute('aria-valuenow');
            bar.style.width = '';
        } else {
            track.setAttribute('aria-valuenow', String(value));
            bar.style.width = `${value}%`;
        }
        label.textContent = text;
        if (cancelButton) cancelButton.hidden = state !== 'active' || !activeDownloadControllers.has(modName);
        if (button) {
            button.disabled = batchInstallState.running || !['error', 'cancelled'].includes(state);
            button.textContent = state === 'installing'
                ? '正在安装'
                : (state === 'error'
                    ? '重试'
                    : (state === 'cancelled' ? (button.dataset.idleText || '下载安装') : (value === null ? '正在下载' : `下载 ${value}%`)));
        }
    }

    function resetDownloadProgress(modName) {
        downloadProgressState.delete(modName);
        const cards = Array.from(document.querySelectorAll?.('.dol-opt-market-card') || []);
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.dol-opt-download-progress');
        if (!progress) return;
        const track = progress.querySelector('.dol-opt-download-track');
        const bar = progress.querySelector('.dol-opt-download-bar');
        const label = progress.querySelector('.dol-opt-download-label');
        const cancelButton = progress.querySelector('.dol-opt-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        progress.hidden = true;
        progress.classList.remove?.('is-indeterminate', 'is-error');
        track?.removeAttribute?.('aria-valuenow');
        if (bar) bar.style.width = '';
        if (label) label.textContent = '等待下载';
        if (cancelButton) cancelButton.hidden = true;
        if (button) {
            button.disabled = batchInstallState.running;
            button.textContent = button.dataset.idleText || '下载安装';
        }
    }

    function createFileTooLargeError() {
        const error = new Error('安装包超过自动安装大小限制');
        error.code = 'FILE_TOO_LARGE';
        return error;
    }

    async function readDownloadResponse(response, onProgress, maxBytes = MAX_DOWNLOAD_BYTES, expectedBytes = 0) {
        const total = Number(response.headers?.get?.('Content-Length')) || Number(expectedBytes) || 0;
        if (total > maxBytes) throw createFileTooLargeError();
        if (!response.body?.getReader) {
            const blob = await response.blob();
            if (blob.size > maxBytes) throw createFileTooLargeError();
            return blob;
        }
        const chunks = [];
        const reader = response.body.getReader();
        let received = 0;
        let lastReportedProgress;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
                await reader.cancel();
                throw createFileTooLargeError();
            }
            chunks.push(value);
            const progress = total ? Math.round(Math.min(100, received * 100 / total)) : null;
            if (progress !== lastReportedProgress) {
                lastReportedProgress = progress;
                onProgress(progress);
            }
        }
        return new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
    }

    async function verifyAssetDigest(blob, digest) {
        if (!digest) return true;
        const match = String(digest).trim().match(/^sha256:([a-f0-9]{64})$/i);
        if (!match) {
            const error = new Error('GitHub 返回了无法识别的安装包摘要');
            error.code = 'DIGEST_UNSUPPORTED';
            throw error;
        }
        if (!window.crypto?.subtle || typeof blob?.arrayBuffer !== 'function') {
            const error = new Error('当前浏览器无法校验安装包完整性');
            error.code = 'DIGEST_UNAVAILABLE';
            throw error;
        }
        const hash = await window.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== match[1].toLowerCase()) {
            const error = new Error('安装包 SHA-256 与 GitHub 官方摘要不一致');
            error.code = 'DIGEST_MISMATCH';
            throw error;
        }
        return true;
    }

    async function offerOriginalDownloadSource(mod, error) {
        const confirmed = await window.dolOptConfirm({
            title: '请按作者说明下载',
            message: `【${mod.name}】${error.message}。\n\n是否打开该条目原始主页？`,
            confirmText: '打开主页', cancelText: '取消', confirmType: 'primary'
        });
        if (confirmed) window.open(mod.githubUrl || mod.otherUrl, '_blank', 'noopener');
        return false;
    }

    async function downloadAndInstallMod(mod, mirrorId = currentMirrorId, options = {}) {
        if (!mod) return false;
        const failBatch = reason => { options.onFailure?.(reason); return false; };
        const gui = window.dolOptGetGui ? window.dolOptGetGui() : null;
        if (!gui) {
            window.dolOptShowToast('未找到 ModLoader 运行时实例，无法自动安装', 'warning');
            return failBatch('未找到 ModLoader 运行时实例');
        }

        const progressTargetName = options.progressTargetName || mod.name;
        const progressPrefix = options.progressPrefix || '';
        const reportProgress = (percent, text, state = 'active') => {
            if (progressTargetName !== mod.name) updateDownloadProgress(mod.name, percent, text, state);
            updateDownloadProgress(progressTargetName, percent, `${progressPrefix}${text}`, state);
        };

        let releaseInfo = options.releaseInfo || null;
        let installAssets = [];
        let targetVersion = mod.version || '';

        // 1. 获取 Release 信息
        reportProgress(null, '正在获取发布信息...');
        window.dolOptShowToast(`正在获取【${mod.name}】发布信息...`, 'info');
        try {
            if (!releaseInfo) releaseInfo = await fetchModRelease(mod, { useCache: true });
            installAssets = getReleaseInstallAssets(releaseInfo);
            if (releaseInfo.version) targetVersion = releaseInfo.version;
        } catch (err) {
            console.warn('[DolOptimization] 读取 Release 失败，尝试回退', err);
            if (options.batchMode) return failBatch(err?.message || '读取发布包失败');
            if (['MANUAL_SOURCE', 'RELEASE_NOT_FOUND'].includes(err?.code)) {
                resetDownloadProgress(mod.name);
                return offerOriginalDownloadSource(mod, err);
            }
            if (err?.code === 'REPO_NOT_FOUND' || err?.status === 404 || mod._isDeadRepo || isDeadRepo(mod.githubUrl)) {
                reportProgress(null, '模组仓库已被作者移除', 'error');
                if (typeof window.dolOptAlert === 'function') {
                    await window.dolOptAlert('该模组的 GitHub 仓库已被作者移除或不存在 (404)，无法下载更新。\n\n已自动更新本地模组状态为无需更新。', '模组仓库已失效');
                }
                if (typeof renderMarketCards === 'function') renderMarketCards();
                return false;
            }
        }

        if (releaseInfo?.requiresManualSelection) {
            if (options.batchMode) return failBatch('需要重新选择兼容安装包');
            reportProgress(null, '需要手动选择兼容安装包', 'error');
            const selectedMirror = resolveMirrorServer(mirrorId);
            const choice = await window.dolOptConfirm({
                title: '请选择对应的安装包',
                message: `${releaseInfo.selectionReason}。请从候选文件中明确选择一个安装包。`,
                trustedMessageHtml: formatReleaseInstallPlanHtml(releaseInfo, selectedMirror),
                dialogClass: 'dol-opt-install-dialog',
                selectLabel: '主安装包选择',
                selectOptions: getManualAssetOptions(releaseInfo),
                selectValue: '',
                requireSelection: true,
                confirmText: '安装所选包',
                cancelText: '取消',
                confirmType: 'primary'
            });
            releaseInfo = applyManualAssetSelection(releaseInfo, choice);
            if (!releaseInfo) return false;
            installAssets = getReleaseInstallAssets(releaseInfo);
            targetVersion = releaseInfo.version || targetVersion;
        }

        if (!installAssets.length) {
            if (options.batchMode) return failBatch('没有可自动安装的发布包');
            reportProgress(null, '未找到可直接下载的安装包', 'error');
            // 没有直接资源包，弹窗引导去网页下载
            const ok = await window.dolOptConfirm({
                title: '前往外部页面下载',
                message: `模组【${mod.name}】未检测到可直接下载的 Release 压缩包。\n\n该模组最新发布可能尚未上传完成编译包，或作者仅发布了源代码。\n\n是否打开其发布主页手动下载？`,
                confirmText: '打开主页',
                cancelText: '取消',
                confirmType: 'primary'
            });
            if (ok) {
                const targetUrl = releaseInfo?.htmlUrl || mod.githubUrl || mod.otherUrl;
                if (targetUrl) window.open(targetUrl, '_blank', 'noopener');
            }
            return false;
        }

        // 2. 准备下载链接与原生下载触发器
        const selectedMirror = resolveMirrorServer(mirrorId);
        const triggerBrowserDownload = (downloadUrl, fileName) => {
            if (!downloadUrl) return;
            try {
                const el = document.createElement('a');
                el.href = downloadUrl;
                el.src = downloadUrl;
                if (fileName) el.download = fileName;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
                if (document.body && typeof document.body.appendChild === 'function') {
                    document.body.appendChild(el);
                }
                if (typeof el.click === 'function') el.click();
                setTimeout(() => el.remove?.(), 1000);
            } catch (_) {}
        };
        const startBrowserDownload = async () => {
            installAssets.forEach(asset => triggerBrowserDownload(getDownloadUrl(asset.downloadUrl, mirrorId), asset.name));
            const fileNames = installAssets.map(asset => asset.name).join('、');
            window.dolOptShowToast(`已为您启动浏览器下载 ${installAssets.length} 个安装包`, 'info');
            reportProgress(null, '浏览器下载已启动，请下载后手动导入');

            const tipMsg = `模组【${mod.name}】的 ${installAssets.length} 个安装包已通过浏览器启动下载：\n\n${fileNames}\n\n【安装指引】：\n待浏览器下载完成后，点击下方【选择已下载的文件导入】，同时选中这些文件即可完成安装。`;
            if (typeof window.dolOptConfirm === 'function') {
                const choice = await window.dolOptConfirm({
                    title: '浏览器下载已启动',
                    message: tipMsg,
                    confirmText: '选择已下载的文件导入',
                    cancelText: '我知道了',
                    confirmType: 'primary'
                });
                if (choice && typeof window.dolOptTriggerImport === 'function') {
                    window.dolOptTriggerImport();
                }
            }
            return false;
        };

        // GitHub Release 最终下载域不提供 CORS，直连只能交给浏览器下载后手动导入。
        if (selectedMirror.browserOnly) return options.batchMode ? failBatch('当前线路只能手动下载') : startBrowserDownload();

        window.dolOptShowToast(`正在获取【${mod.name}】的 ${installAssets.length} 个安装包...`, 'warning');

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const cancelKeys = [...new Set([mod.name, progressTargetName].filter(Boolean))];
        const clearActiveDownload = () => cancelKeys.forEach(key => {
            if (activeDownloadControllers.get(key) === controller) activeDownloadControllers.delete(key);
        });
        if (controller) cancelKeys.forEach(key => activeDownloadControllers.set(key, controller));
        let failedMirror = selectedMirror;
        reportProgress(null, `正在连接 ${selectedMirror.name}...`);

        try {
            const fileObjects = [];
            let activeMirror = selectedMirror;
            const availableMirrors = [
                selectedMirror,
                ...MIRROR_SERVERS.filter(m => !m.browserOnly && m.id !== selectedMirror.id)
            ];

            for (let assetIndex = 0; assetIndex < installAssets.length; assetIndex++) {
                const asset = installAssets[assetIndex];
                const fileName = asset.name || `${mod.name}-${assetIndex + 1}.zip`;
                const assetSize = Number(asset.size) || 0;
                const assetDigest = asset.digest || '';
                if (assetSize > MAX_DOWNLOAD_BYTES) throw createFileTooLargeError();

                const candidateMirrors = [
                    activeMirror,
                    ...availableMirrors.filter(m => m.id !== activeMirror.id)
                ];

                let blob = null;
                let lastError = null;

                for (let cIdx = 0; cIdx < candidateMirrors.length; cIdx++) {
                    const currentCandidate = candidateMirrors[cIdx];
                    failedMirror = currentCandidate;
                    const fetchUrl = getDownloadUrl(asset.downloadUrl, currentCandidate.id);

                    if (cIdx > 0) {
                        console.warn(`[DolOptimization] 下载线路故障转移，正在自动切换至 ${currentCandidate.name} 下载【${fileName}】`);
                        window.dolOptShowToast(`【${fileName}】正在自动切换至 ${currentCandidate.name}...`, 'warning');
                    }
                    reportProgress(null, `${assetIndex + 1}/${installAssets.length} 正在连接 ${currentCandidate.name}...`);

                    let success = false;
                    for (let attempt = 0; attempt < 2; attempt++) {
                        if (controller?.signal.aborted) break;
                        if (attempt > 0) {
                            reportProgress(null, `${assetIndex + 1}/${installAssets.length} 连接中断，正在自动重试...`);
                        }

                        // 连接握手超时控制（8 秒内未建立响应则超时中断并自动故障转移）
                        const connectTimeoutController = typeof AbortController === 'function' ? new AbortController() : null;
                        let abortHandler = null;
                        if (controller && connectTimeoutController) {
                            if (controller.signal.aborted) {
                                connectTimeoutController.abort();
                            } else {
                                abortHandler = () => connectTimeoutController.abort();
                                controller.signal.addEventListener('abort', abortHandler);
                            }
                        }
                        const timeoutId = connectTimeoutController
                            ? setTimeout(() => {
                                const timeoutErr = new Error(`连接 ${currentCandidate.name} 超时（超过 8 秒未响应）`);
                                timeoutErr.name = 'TimeoutError';
                                timeoutErr.code = 'ETIMEDOUT';
                                connectTimeoutController.abort(timeoutErr);
                            }, 8000)
                            : null;

                        try {
                            const response = await fetch(fetchUrl, connectTimeoutController ? { signal: connectTimeoutController.signal } : (controller ? { signal: controller.signal } : undefined));
                            if (timeoutId !== null) clearTimeout(timeoutId);

                            if (!response.ok) {
                                const error = new Error(`网络响应异常 HTTP ${response.status}`);
                                error.status = response.status;
                                if (response.status === 413) error.code = 'FILE_TOO_LARGE';
                                throw error;
                            }

                            // 握手成功后读取流（流式下载过程不再受 8 秒连接握手限制，仅受外层取消信号控制）
                            blob = await readDownloadResponse(response, percent => {
                                const overall = percent === null ? null : ((assetIndex + percent / 100) / installAssets.length) * 100;
                                reportProgress(
                                    overall,
                                    `${assetIndex + 1}/${installAssets.length} ${percent === null ? '正在接收' : `正在下载 ${Math.round(percent)}%`}：${fileName}`
                                );
                            }, MAX_DOWNLOAD_BYTES, assetSize);

                            if (assetSize && blob.size !== assetSize) {
                                const error = new Error(`安装包大小不完整（预期 ${assetSize} 字节，实际 ${blob.size} 字节）`);
                                error.code = 'DOWNLOAD_INCOMPLETE';
                                throw error;
                            }

                            await verifyAssetDigest(blob, assetDigest);
                            activeMirror = currentCandidate;
                            success = true;
                            break;
                        } catch (err) {
                            if (timeoutId !== null) clearTimeout(timeoutId);
                            lastError = err;
                            const nonRetryableCodes = ['FILE_TOO_LARGE', 'DIGEST_MISMATCH', 'DIGEST_UNSUPPORTED', 'DIGEST_UNAVAILABLE'];
                            if (controller?.signal.aborted || nonRetryableCodes.includes(err?.code)) {
                                throw err;
                            }
                            if (attempt === 0) {
                                console.warn(`[DolOptimization] ${currentCandidate.name} 下载中断，自动重试一次:`, err);
                                continue;
                            }
                        } finally {
                            if (controller && abortHandler) {
                                controller.signal.removeEventListener('abort', abortHandler);
                            }
                        }
                    }

                    if (success && blob) break;
                    if (controller?.signal.aborted) break;
                }

                if (!blob) {
                    throw lastError || new Error('所有可用下载线路均尝试失败');
                }

                try {
                    fileObjects.push(new File([blob], fileName, { type: 'application/zip' }));
                } catch {
                    const fileBlob = new Blob([blob], { type: 'application/zip' });
                    fileBlob.name = fileName;
                    fileObjects.push(fileBlob);
                }
            }
            // 写入前统一核验所有包，避免主包错误或附属包无效时留下部分安装。
            const modController = window.dolOptGetController?.() || gui.modModLoadController;
            if (typeof modController?.checkModZipFileIndexDB === 'function') {
                const expectedNames = (mod.bootNames?.length ? mod.bootNames : [mod._matchedLocal?.name])
                    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().toLowerCase());
                for (const [index, file] of fileObjects.entries()) {
                    try {
                        const boot = await modController.checkModZipFileIndexDB(new Uint8Array(await file.arrayBuffer()));
                        const actualName = typeof boot?.name === 'string' ? boot.name.trim() : '';
                        if (!actualName || typeof boot !== 'object' || Array.isArray(boot)) {
                            throw new Error(`【${file.name}】没有可识别的模组清单，不能作为 ModLoader 模组导入。`);
                        }
                        if (index === 0 && expectedNames.length && !expectedNames.includes(actualName.toLowerCase())) {
                            throw new Error(`所选【${mod.name}】的安装包实际为【${actualName}】，与已确认的模组身份不符，已停止安装。`);
                        }
                    } catch (error) {
                        const failure = new Error(error?.message || '无法读取安装包的模组清单');
                        failure.code = 'INSTALL_PACKAGE_INVALID';
                        throw failure;
                    }
                }
            }
            reportProgress(100, installAssets.length === 1 ? '下载完成，正在安装...' : `${installAssets.length} 个安装包下载完成，正在安装...`, 'installing');

            // 3. 构造虚拟文件列表并一次性交给 ModLoader 批量导入。
            let dummyInput = document.createElement('input');
            dummyInput.type = 'file';
            dummyInput.multiple = true;

            if (typeof DataTransfer !== 'undefined') {
                try {
                    const dt = new DataTransfer();
                    fileObjects.forEach(fileObj => dt.items.add(fileObj));
                    dummyInput.files = dt.files;
                } catch (_) {
                    dummyInput.files = fileObjects;
                }
            } else {
                dummyInput.files = fileObjects;
            }

            // 4. 调用已有的智能模组导入器
            const askRestart = options.askRestart !== undefined ? options.askRestart : true;
            // 安装前先确认模组管理器空闲：管理器在保存 / 读取配置时会直接拒绝写入，
            // 若不做等待与提示，用户只会看到一次毫无原因的「安装未完成」。
            if (typeof window.dolOptWaitManagerIdle === 'function' && !await window.dolOptWaitManagerIdle()) {
                clearActiveDownload();
                reportProgress(null, '模组管理器正在保存其他配置，请稍后再试', 'error');
                return failBatch('模组管理器正忙，请稍后重试');
            }
            if (typeof window.dolOptHandleAddMod === 'function') {
                const installed = await window.dolOptHandleAddMod(dummyInput.files && dummyInput.files.length > 0 ? dummyInput : fileObjects, {
                    askRestart,
                    skipReloadOffer: options.skipReloadOffer,
                    // 市场内安装：「稍后重载」后停留市场页签，方便玩家连续安装多个模组
                    keepCurrentTab: true,
                    targetModName: mod._matchedLocal?.name || '',
                    displayName: mod.name || ''
                });
                if (installed === false || (options.batchMode && installed !== true)) {
                    clearActiveDownload();
                    const reason = String(window._dolOptLastInstallError || '').trim();
                    reportProgress(null, reason ? `安装未完成：${reason}` : '安装未完成，请检查管理器提示后重试', 'error');
                    return failBatch(reason || '安装未完成');
                }
            } else if (typeof window.dolOptInstallFilesViaIndexDB === 'function') {
                await window.dolOptInstallFilesViaIndexDB(fileObjects);
            } else if (typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(dummyInput);
                if (askRestart && !options.skipReloadOffer) {
                    const isFramework = typeof window.dolOptIsFrameworkMod === 'function' && window.dolOptIsFrameworkMod(mod.name);
                    if (isFramework && typeof window.dolOptOfferReload === 'function') {
                        await window.dolOptOfferReload(`模组【${mod.name}】已成功安装并载入配置！`, { isFramework: true });
                    } else {
                        const ok = await window.dolOptConfirm({
                            title: '安装成功',
                            message: `模组【${mod.name}】已成功安装并载入配置！\n\n是否立即重新载入游戏使模组生效？`,
                            confirmText: '立即重载',
                            cancelText: '稍后重载',
                            confirmType: 'primary'
                        });
                        if (ok) {
                            location.reload();
                        }
                    }
                }
            } else {
                throw new Error('未找到 ModLoader 导入执行接口');
            }

            // 安装完毕后记录版本确权，防止第三方 zip 内 boot.json 漏改版本号导致死循环更新
            const installedVer = targetVersion || mod.version;
            setModUpdateIgnored(mod.name, '', false);
            setModUpdateConfirmed(mod.name, installedVer);
            if (mod._matchedLocal?.name) {
                setModUpdateIgnored(mod._matchedLocal.name, '', false);
                setModUpdateConfirmed(mod._matchedLocal.name, installedVer);
            }

            // 安装完毕后刷新市场 UI 状态
            clearActiveDownload();
            resetDownloadProgress(mod.name);
            if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
            try {
                // 强制重读存储中的模组列表，确保刚安装的模组立刻出现在本地档案里
                if (typeof window.dolOptLoadModManageState === 'function') {
                    await window.dolOptLoadModManageState(true);
                }
            } catch (refreshError) {
                console.warn('[DolOptimization] 安装后刷新本地模组档案失败', refreshError);
            }
            renderMarketCards();
            // 安装已经成功却仍判为未安装时，明确记录原因，便于用户与作者定位别名匹配问题
            try {
                if (checkModInstallStatus(mod, getLocalInstalledProfiles()) === 'not_installed') {
                    console.warn(`[DolOptimization] 模组【${mod.name}】安装成功，但市场未能与本地记录匹配（可能为别名或版本识别问题）`);
                }
            } catch (_) {}
            return true;
        } catch (err) {
            clearActiveDownload();
            if (controller?.signal.aborted || err?.name === 'AbortError') {
                resetDownloadProgress(mod.name);
                if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                window.dolOptShowToast(`已取消【${mod.name}】的下载`, 'info');
                return failBatch('已取消下载');
            }
            const isTooLarge = err?.code === 'FILE_TOO_LARGE';
            const isDigestFailure = ['DIGEST_MISMATCH', 'DIGEST_UNSUPPORTED', 'DIGEST_UNAVAILABLE'].includes(err?.code);
            if (err?.code === 'INSTALL_PACKAGE_INVALID') {
                reportProgress(null, err.message, 'error');
                if (!options.batchMode) await window.dolOptAlert(err.message, '安装包校验失败');
                return failBatch(err.message);
            }
            console.warn('[DolOptimization] 页面内自动安装失败:', err);
            reportProgress(null, isDigestFailure ? '完整性校验失败，已阻止安装' : (isTooLarge ? '安装包较大，可改用浏览器下载' : '自动安装失败，请重试或改用浏览器下载'), 'error');

            if (options.batchMode) return failBatch(err?.message || '下载或安装失败');

            if (isDigestFailure) {
                if (typeof window.dolOptAlert === 'function') {
                    await window.dolOptAlert(`模组【${mod.name}】的安装包未能通过 GitHub 官方 SHA-256 完整性校验，已阻止安装。\n\n请切换至 GitHub 直连后手动下载。`, '安装包完整性校验失败');
                }
                return false;
            }

            const alternatives = (isTooLarge ? MIRROR_SERVERS.filter(mirror => mirror.browserOnly) : MIRROR_SERVERS.filter(mirror => mirror.id !== failedMirror.id));
            const failureReason = err?.status === 429
                ? `${failedMirror.name} 当前返回 HTTP 429，服务正在限流。`
                : `${failedMirror.name} 页面内下载连接中断，自动重试仍未成功。`;
            const fallbackMsg = isTooLarge
                ? `模组【${mod.name}】安装包较大，不适合在页面内缓存。\n\n请选择 GitHub 直连，由浏览器下载后手动导入。`
                : `模组【${mod.name}】下载失败。\n\n${failureReason}\n\n请选择其他下载线路重试。`;
            let retryMirrorId = '';
            if (typeof window.dolOptConfirm === 'function') {
                retryMirrorId = await window.dolOptConfirm({
                    title: '自动安装失败',
                    message: fallbackMsg,
                    selectLabel: '重试线路',
                    selectOptions: alternatives.map(mirror => ({ value: mirror.id, label: mirror.name })),
                    selectValue: alternatives[0]?.id || '',
                    confirmText: '切换并重试',
                    cancelText: '取消',
                    confirmType: 'primary'
                });
            } else if (typeof window.dolOptAlert === 'function') {
                await window.dolOptAlert(fallbackMsg, '自动安装失败');
            }
            if (!MIRROR_SERVERS.some(mirror => mirror.id === retryMirrorId)) return false;
            setCurrentMirror(retryMirrorId);
            return downloadAndInstallMod(mod, retryMirrorId, options);
        }
    }

    // ==================== 界面渲染逻辑 ====================

    async function loadMarketData(forceRefresh = false) {
        if (!forceRefresh && marketModList.length > 0) return marketModList;

        if (!forceRefresh) {
            const cached = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL);
            if (cached && Array.isArray(cached) && cached.length > 0) {
                marketModList = normalizeReleaseIndex({ schemaVersion: 1, mods: cached });
                renderBatchInstallToolbar();
                return marketModList;
            }
        }

        try {
            marketModList = await fetchReleaseIndex();
            renderBatchInstallToolbar();
            return marketModList;
        } catch (error) {
            console.warn('[DolOptimization] Cloudflare 自动版本索引不可用，尝试本地缓存或 Wiki', error);
        }

        const identityPromise = loadIdentityCatalog(forceRefresh);
        if (!forceRefresh) {
            const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
            if (stale && Array.isArray(stale) && stale.length > 0) {
                await identityPromise;
                marketModList = normalizeReleaseIndex({ schemaVersion: 1, mods: stale });
                renderBatchInstallToolbar();
                return marketModList;
            }
        }

        const params = new URLSearchParams({
            action: 'parse',
            page: WIKI_PAGE,
            format: 'json',
            prop: 'text',
            origin: '*'
        });

        try {
            const [res] = await Promise.all([
                fetch(`${WIKI_API}?${params.toString()}`),
                identityPromise
            ]);
            if (!res.ok) throw new Error(`Wiki API 返回状态码: ${res.status}`);
            const data = await res.json();
            if (!data.parse || !data.parse.text) throw new Error('Wiki 数据格式解析异常');

            marketModList = parseModsFromHtml(data.parse.text['*']);
            writeLocalCache(WIKI_CACHE_KEY, marketModList);
            renderBatchInstallToolbar();
            return marketModList;
        } catch (error) {
            const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
            if (stale && Array.isArray(stale) && stale.length > 0) {
                marketModList = normalizeReleaseIndex({ schemaVersion: 1, mods: stale });
                renderBatchInstallToolbar();
                return marketModList;
            }
            throw error;
        }
    }

    function filterAndSortMods() {
        const profiles = getLocalInstalledProfiles();
        let list = marketModList.map((mod, marketIndex) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: marketIndex };
        });

        // 1. 主分类过滤
        if (currentCategory !== 'all') {
            list = list.filter(m => m.category === currentCategory);
        }

        // 2. 状态过滤
        if (currentStatusFilter === 'installable') {
            list = list.filter(m => m._status === 'not_installed' || m._status === 'update_available');
        } else if (currentStatusFilter === 'installed') {
            list = list.filter(m => m._status === 'up_to_date' || m._status === 'update_available');
        } else if (currentStatusFilter === 'updatable') {
            list = list.filter(m => m._status === 'update_available');
        } else if (currentStatusFilter === 'ignored') {
            list = list.filter(m => m._isIgnored);
        }

        // 3. 搜索关键词过滤
        if (currentSearchText) {
            const kw = currentSearchText.toLowerCase();
            list = list.filter(m =>
                (m.name && m.name.toLowerCase().includes(kw)) ||
                (m.author && m.author.toLowerCase().includes(kw)) ||
                (m.description && m.description.toLowerCase().includes(kw)) ||
                (m.category && m.category.toLowerCase().includes(kw)) ||
                (Array.isArray(m.tags) && m.tags.some(tag => tag.toLowerCase().includes(kw)))
            );
        }

        // 4. 排序：有新版本可更新的模组始终最高优先级强制置顶！
        list.sort((a, b) => {
            const aUp = a._status === 'update_available' ? 1 : 0;
            const bUp = b._status === 'update_available' ? 1 : 0;
            if (aUp !== bUp) return bUp - aUp;

            if (currentSortBy === 'date') {
                const da = a.updateDate || '1970-01-01';
                const db = b.updateDate || '1970-01-01';
                return db.localeCompare(da);
            } else if (currentSortBy === 'name') {
                return (a.name || '').localeCompare(b.name || '', 'zh-CN');
            }
            return 0;
        });

        return list;
    }

    function findMarketModByLocalName(modName, mods = null) {
        const source = Array.isArray(mods)
            ? mods
            : (marketModList.length ? marketModList : (readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true) || []));
        if (!modName || !Array.isArray(source)) return null;

        const normalizedName = normalizeKey(modName);
        const profiles = getLocalInstalledProfiles();
        const exactProfile = profiles.find(profile => String(profile.name).trim().toLowerCase() === String(modName).trim().toLowerCase());
        const aliasProfiles = profiles.filter(profile => profile.normalizedNames?.includes(normalizedName));
        const localProfile = exactProfile || (aliasProfiles.length === 1 ? aliasProfiles[0] : { name: modName, version: '' });

        let bestCandidate = null;
        let highestScore = 0;
        let bestMatchCount = 0;

        for (const mod of source) {
            const candidate = { ...mod };
            checkModInstallStatus(candidate, [localProfile]);
            if (candidate._matchedLocal && candidate._matchedScore >= 80) {
                let score = candidate._matchedScore || 80;
                const modRepoKey = extractRepoKey(candidate.githubUrl);
                const normName = normalizeKey(modName);
                const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normName] || [];
                if (modRepoKey && knownRepos.includes(modRepoKey)) {
                    score += 15;
                }
                if (score > highestScore) {
                    highestScore = score;
                    bestCandidate = candidate;
                    bestMatchCount = 1;
                } else if (score === highestScore) {
                    bestMatchCount++;
                }
            }
        }
        return bestMatchCount === 1 ? bestCandidate : null;
    }

    /**
     * 纯同步、只读、无重入副作用的模组简介静态查询方法
     * 仅供管理页渲染展示使用，严禁调用 getLocalInstalledProfiles 或 checkModInstallStatus
     */
    function getStaticMarketModSubtext(modName) {
        if (!modName) return '';
        const norm = normalizeKey(modName);
        if (!norm) return '';
        const list = marketModList.length ? marketModList : (readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true) || []);
        if (!Array.isArray(list) || !list.length) return '';

        const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[norm] || [];
        const names = new Set([norm, ...(DOL_OPT_KNOWN_MOD_MARKET_ALIASES[norm] || []).map(normalizeKey)]);
        const matches = list.filter(m => {
            const repoKey = extractRepoKey(m.githubUrl);
            if (repoKey && knownRepos.length && !knownRepos.includes(repoKey)) return false;
            return [m.name, ...(m.bootNames || []), ...(m.aliases || [])].some(name => names.has(normalizeKey(name)));
        });
        if (matches.length === 1) {
            const m = matches[0];
            if (m.name && m.name !== modName && /[\u4e00-\u9fa5]/.test(m.name)) {
                return m.name;
            }
            const d = m.desc || m.description;
            if (d && typeof d === 'string') {
                let clean = d.replace(/[\r\n\t]+/g, ' ').trim();
                clean = clean.replace(/^(?:包含|提供|支持|增加|新增|用于)[：:]\s*/, '');
                if (clean.length > 28) clean = clean.slice(0, 26) + '...';
                if (clean) return clean;
            }
        }
        return '';
    }

    function isStatsFilterActive(filter) {
        if (filter === 'all') return currentCategory === 'all' && currentStatusFilter === 'all' && !currentSearchText;
        return currentStatusFilter === filter;
    }

    function renderStatsHeader(allCount, installedCount, updatableCount) {
        const statsEl = document.getElementById('dolOptMarketStats');
        if (!statsEl) return;
        const selectedMirror = MIRROR_SERVERS.find(mirror => mirror.id === currentMirrorId) || MIRROR_SERVERS[0];
        const updateAllBtnHtml = updatableCount > 0
            ? `<button type="button" class="macro-button dol-opt-market-update-all" onclick="window.dolModMarket.updateAllMods()" title="更新全部 ${updatableCount} 个可更新模组">一键更新全部模组</button>`
            : '';

        statsEl.innerHTML = `
            <div class="childItem dol-opt-stat-card dol-opt-clickable ${isStatsFilterActive('all') ? 'is-selected' : ''}" onclick="window.dolModMarket.resetFilters()" title="点击清除所有筛选，查看全部社区收录模组">
                <div class="dol-opt-stat-num gold">${allCount}</div>
                <div class="grey dol-opt-stat-label">社区收录</div>
            </div>
            <div class="childItem dol-opt-stat-card dol-opt-clickable ${isStatsFilterActive('installed') ? 'is-selected' : ''}" onclick="window.dolModMarket.filterInstalledOnly()" title="点击仅查看本地已安装模组">
                <div class="dol-opt-stat-num green">${installedCount}</div>
                <div class="grey dol-opt-stat-label">本地已装</div>
            </div>
            <div class="childItem dol-opt-stat-card dol-opt-clickable ${isStatsFilterActive('updatable') ? 'is-selected' : ''}" onclick="window.dolModMarket.filterUpdatableOnly()" title="点击仅查看发现新版的模组">
                <div class="dol-opt-stat-num ${updatableCount > 0 ? 'gold dol-opt-pulse-gold' : ''}">${updatableCount}</div>
                <div class="grey dol-opt-stat-label">发现新版</div>
            </div>
            <div class="childItem dol-opt-stat-card" title="当前线路：${selectedMirror.name}">
                <div class="dol-opt-stat-num">${selectedMirror.shortName}</div>
                <div class="grey dol-opt-stat-label">下载线路</div>
            </div>
            ${updateAllBtnHtml}
        `;
    }

    function renderIgnoredFilterLink(ignoredCount) {
        const btn = document.getElementById('dolOptMarketBtnIgnored');
        if (!btn) return;
        btn.hidden = ignoredCount === 0;
        btn.textContent = `查看已忽略模组（${ignoredCount}）`;
        btn.classList.toggle('is-selected', currentStatusFilter === 'ignored');
        btn.setAttribute('aria-pressed', currentStatusFilter === 'ignored' ? 'true' : 'false');
    }

    function renderMarketCards() {
        const container = document.getElementById('dolOptMarketCardsContainer');
        if (!container) return;

        const filtered = filterAndSortMods();

        // 统计数字与可更新模组列表
        const profiles = getLocalInstalledProfiles();
        let installedCount = 0;
        let updatableCount = 0;
        let ignoredCount = 0;
        const updatableList = [];

        marketModList.forEach(m => {
            const st = checkModInstallStatus(m, profiles);
            if (st === 'up_to_date' || st === 'update_available') installedCount++;
            if (m._isIgnored) ignoredCount++;
            if (st === 'update_available') {
                updatableCount++;
                updatableList.push({
                    marketMod: m,
                    localProfile: m._matchedLocal,
                    newVersion: m.version,
                    currentVersion: m._matchedLocal?.version || ''
                });
            }
        });

        renderStatsHeader(marketModList.length, installedCount, updatableCount);
        renderIgnoredFilterLink(ignoredCount);
        renderBatchInstallToolbar();

        // 同步通知外部模组管理环境看板与 Tab 徽标
        if (typeof window.dolOptNotifyUpdateState === 'function') {
            window.dolOptNotifyUpdateState(updatableCount, updatableList);
        }

        if (!filtered.length) {
            container.innerHTML = `
                <div class="dol-opt-empty-state grey">
                    未找到匹配的模组。您可以尝试清除筛选或点击右上角刷新市场数据。
                    <br><br>
                    <button type="button" class="macro-button dol-opt-btn-primary" onclick="window.dolModMarket.resetFilters()">返回查看全部模组</button>
                </div>
            `;
            updateToolbarResetBtn();
            return;
        }

        const escapeHtml = window.dolOptEscapeHtml || (s => s);

        const html = filtered.map(mod => {
            const modIndex = mod._marketIndex;
            const tagsHtml = [
                `<span class="dol-opt-market-tag dol-opt-market-category">${escapeHtml(mod.category || '待分类')}</span>`,
                ...(mod.tags || []).map(t => `<span class="dol-opt-market-tag">${escapeHtml(t)}</span>`)
            ].join('');
            
            // 状态徽章与主操作按钮
            let badgeHtml = '';
            let actionBtnHtml = '';
            const marketRepoKey = extractRepoKey(mod.githubUrl);
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            const isUpdatable = mod._status === 'update_available' && !isDead;
            const isIgnored = !!mod._isIgnored;
            const isPermanentlyIgnored = mod._ignoredVersion === 'ignored';
            const selected = batchInstallState.selected.has(getMarketModKey(mod));
            const selectionHtml = batchInstallState.selecting && isBatchInstallEligible(mod, profiles)
                ? `<label class="dol-opt-market-select-label"><input type="checkbox" class="dol-opt-market-select" data-mod-key="${escapeHtml(getMarketModKey(mod))}" aria-label="选择${escapeHtml(mod.name)}" ${selected ? 'checked' : ''} ${batchInstallState.running ? 'disabled' : ''}>选择</label>`
                : '';

            if (isDead) {
                // 源已失效：统一采用红色标签醒目提示
                badgeHtml = `<span class="dol-opt-market-badge badge-dead-repo">源已失效</span>`;
                if (mod._status === 'up_to_date' || mod._matchedLocal) {
                    actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary" disabled>已安装</button>`;
                } else if (mod.otherUrl) {
                    actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary btn-market-external" data-mod-index="${modIndex}">外部主页</button>`;
                } else {
                    actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary" disabled>暂无下载</button>`;
                }
            } else if (isUpdatable) {
                badgeHtml = `<span class="dol-opt-market-badge badge-update">发现新版</span>`;
                actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-primary btn-market-update" data-mod-index="${modIndex}" data-idle-text="一键更新">一键更新</button>`;
            } else if (mod._status === 'up_to_date') {
                if (isIgnored) {
                    badgeHtml = `<span class="dol-opt-market-badge badge-ignored">${isPermanentlyIgnored ? '已永久忽略' : '已忽略本次'}</span>`;
                    actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-primary btn-market-update" data-mod-index="${modIndex}" data-idle-text="更新">更新</button>`;
                } else {
                    badgeHtml = `<span class="dol-opt-market-badge badge-installed">已是最新</span>`;
                    actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary" disabled>已安装</button>`;
                }
            } else if (mod._status === 'not_installed') {
                badgeHtml = `<span class="dol-opt-market-badge badge-new">未安装</span>`;
                actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-primary btn-market-install" data-mod-index="${modIndex}" data-idle-text="下载安装">下载安装</button>`;
            } else if (mod._status === 'external_only') {
                badgeHtml = `<span class="dol-opt-market-badge badge-external">外部资源</span>`;
                actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary btn-market-external" data-mod-index="${modIndex}">外部主页</button>`;
            } else {
                badgeHtml = `<span class="dol-opt-market-badge badge-external">暂无直链</span>`;
                actionBtnHtml = `<button type="button" class="macro-button dol-opt-btn-secondary" disabled>暂无下载</button>`;
            }

            const homeUrl = mod.githubUrl || mod.otherUrl || '';
            const homeBtnHtml = homeUrl
                ? `<a href="${escapeHtml(homeUrl)}" target="_blank" rel="noopener" class="buttonlike dol-opt-btn-sub" title="访问模组发布主页">主页</a>`
                : '';

            const localVerText = mod._matchedLocal?.version
                ? `<span class="${mod._status === 'update_available' ? 'gold' : 'green'}">已装: ${escapeHtml(formatVersionDisplay(mod._matchedLocal.version))}</span>`
                : (mod._matchedLocal ? `<span class="green">已装</span>` : '');

            const ignoreActionsHtml = isUpdatable
                ? `<div class="dol-opt-market-ignore-actions">
                    <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="once" title="仅忽略 ${escapeHtml(formatVersionDisplay(mod.version))}，更高版本仍会提醒">忽略本次</button>
                    <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="always" title="以后不再提示此模组更新">永久忽略</button>
                   </div>`
                : (isIgnored && currentStatusFilter === 'ignored'
                    ? `<div class="dol-opt-market-ignore-actions"><button type="button" class="btn-market-unignore" data-mod-index="${modIndex}">取消忽略</button></div>`
                    : '');

            return `
                <div class="childItem dol-opt-market-card ${isUpdatable ? 'dol-opt-market-card-updatable' : ''} ${selected ? 'is-batch-selected' : ''} ${selectionHtml ? 'is-batch-selectable' : ''}" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${modIndex}">
                    <div class="dol-opt-market-card-header">
                        ${selectionHtml}
                        <div class="dol-opt-market-title-wrap">
                            <span class="dol-opt-market-title gold">${escapeHtml(mod.name)}</span>
                            ${badgeHtml}
                        </div>
                        <div class="dol-opt-market-tags">${tagsHtml}</div>
                    </div>
                    <div class="dol-opt-market-meta grey">
                        <span>作者: ${escapeHtml(mod.author)}</span>
                        ${mod.updateDate ? `<span>更新: ${escapeHtml(mod.updateDate)}</span>` : ''}
                        ${mod.version || mod.versionLabel ? `<span>版本: ${escapeHtml(mod.version ? formatVersionDisplay(mod.version) : mod.versionLabel)}</span>` : ''}
                        ${localVerText}
                    </div>
                    <div class="dol-opt-market-desc">
                        ${escapeHtml(mod.description)}
                    </div>
                    <div class="dol-opt-download-progress" hidden aria-live="polite">
                        <div class="dol-opt-download-track" role="progressbar" aria-label="${escapeHtml(mod.name)}下载进度" aria-valuemin="0" aria-valuemax="100">
                            <div class="dol-opt-download-bar"></div>
                        </div>
                        <span class="dol-opt-download-label grey">等待下载</span>
                        <button type="button" class="dol-opt-download-cancel" data-mod-index="${modIndex}" hidden>取消下载</button>
                    </div>
                    ${ignoreActionsHtml}
                    <div class="dol-opt-market-actions">
                        ${actionBtnHtml}
                        ${homeBtnHtml}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;
        downloadProgressState.forEach((progress, name) => updateDownloadProgress(name, progress.percent, progress.text, progress.state));

        // 绑定卡片内按钮事件
        container.querySelectorAll('.dol-opt-market-select').forEach(input => {
            input.onchange = () => setBatchModSelected(input.dataset.modKey, input.checked);
            const card = input.closest('.dol-opt-market-card');
            if (card) card.onclick = event => {
                if (input.disabled || batchInstallState.running || event.target.closest('a, button, input, label, select, textarea, summary, [role="button"], [contenteditable]')) return;
                if (String(window.getSelection?.() || '')) return;
                input.click();
            };
        });
        container.querySelectorAll('.btn-market-install, .btn-market-update').forEach(btn => {
            btn.onclick = async () => {
                if (batchInstallState.running) return;
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (targetMod) {
                    await promptDownloadMirrorAndInstall(targetMod);
                }
            };
        });

        container.querySelectorAll('.dol-opt-download-cancel').forEach(btn => {
            btn.onclick = () => {
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (!targetMod || !cancelDownload(targetMod.name)) return;
                btn.disabled = true;
                updateDownloadProgress(targetMod.name, null, '正在取消下载...', 'cancelling');
            };
        });

        container.querySelectorAll('.btn-market-ignore').forEach(btn => {
            btn.onclick = async () => {
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (!targetMod) return;
                const isPermanent = btn.dataset.ignoreMode === 'always';
                const ok = !isPermanent || await window.dolOptConfirm({
                    title: '永久忽略更新',
                    message: `是否永久忽略模组【${targetMod.name}】的更新？\n\n以后发布的新版本也不会再提醒，您仍可在“已忽略模组”中手动更新或取消忽略。`,
                    confirmText: '永久忽略',
                    cancelText: '取消',
                    confirmType: 'primary'
                });
                if (ok) {
                    const ignoredVersion = isPermanent ? 'ignored' : (targetMod.version || 'ignored');
                    setModUpdateIgnored(targetMod.name, ignoredVersion, true);
                    if (targetMod._matchedLocal?.name) {
                        setModUpdateIgnored(targetMod._matchedLocal.name, ignoredVersion, true);
                    }
                    window.dolOptShowToast(isPermanent
                        ? `已永久忽略【${targetMod.name}】的更新`
                        : `已忽略【${targetMod.name}】的本次更新`, 'success');
                    renderMarketCards();
                    if (typeof window.dolOptUpdateGeneralInfo === 'function') {
                        window.dolOptUpdateGeneralInfo();
                    }
                }
            };
        });

        container.querySelectorAll('.btn-market-unignore').forEach(btn => {
            btn.onclick = () => {
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (!targetMod) return;
                setModUpdateIgnored(targetMod.name, '', false);
                if (targetMod._matchedLocal?.name) {
                    setModUpdateIgnored(targetMod._matchedLocal.name, '', false);
                }
                window.dolOptShowToast(`已取消忽略【${targetMod.name}】的 ${formatVersionDisplay(targetMod.version)} 更新`, 'info');
                renderMarketCards();
                if (typeof window.dolOptUpdateGeneralInfo === 'function') {
                    window.dolOptUpdateGeneralInfo();
                }
            };
        });

        container.querySelectorAll('.btn-market-external').forEach(btn => {
            btn.onclick = () => {
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (targetMod) {
                    const url = targetMod.otherUrl || targetMod.githubUrl;
                    if (url) window.open(url, '_blank', 'noopener');
                }
            };
        });

        renderBatchInstallToolbar();
        updateToolbarResetBtn();
    }

    /** 弹窗开始下载 */
    async function promptDownloadMirrorAndInstall(mod) {
        return runMarketInstallTask(() => promptDownloadMirrorAndInstallUnlocked(mod));
    }

    async function promptDownloadMirrorAndInstallUnlocked(mod) {
        const selectedMirror = MIRROR_SERVERS.find(m => m.id === currentMirrorId) || MIRROR_SERVERS[0];
        const externalOnly = !mod.githubUrl && Boolean(mod.otherUrl);
        let plan = buildDependencyPlan(mod);
        const dependencyKey = item => String(item?.identityId || item?.id || normalizeKey(item?.name)).toLowerCase();
        const skippedDependencyKeys = new Set();
        const getActivePlan = () => {
            plan = buildDependencyPlan(mod);
            return { targetMod: mod, actions: plan.actions.filter(action => !skippedDependencyKeys.has(dependencyKey(action.mod))) };
        };
        const getAffectedTargets = name => {
            getActivePlan();
            return plan.requirements.some(req => req.mod._matchedLocal?.name === name) ? [mod.name] : [];
        };
        const onConflictDisabled = name => {
            getActivePlan();
            plan.requirements.filter(req => req.mod._matchedLocal?.name === name).forEach(req => skippedDependencyKeys.add(dependencyKey(req.mod)));
        };
        if (plan.unavailable.length || plan.cycles.length) {
            const unavailableLines = plan.unavailable.map(item => {
                const name = item.mod?.name || item.dependency.id;
                const version = item.dependency.version ? `（需要 ${item.dependency.version}）` : '';
                return `· ${name}${version}：${item.reason}`;
            });
            const cycleLines = plan.cycles.map(name => `· ${name}：检测到循环依赖`);
            await window.dolOptAlert(
                `无法安全生成安装计划：\n\n${[...unavailableLines, ...cycleLines].join('\n')}\n\n请先手动处理以上前置依赖。`,
                '前置依赖无法自动处理'
            );
            return false;
        }

        const actionLabels = {
            install: action => `· ${action.mod.name}：未安装`,
            update: action => `· ${action.mod.name}：当前 ${formatVersionDisplay(action.local?.version) || '版本未知'}，需要 ${action.requirement}`,
            enable: action => `· ${action.mod.name}：已安装但未启用`
        };
        const actionLines = plan.actions.map(action => actionLabels[action.type](action));
        const dependencyLines = plan.requirements.map(requirement => {
            const actions = plan.actions.filter(action => action.mod === requirement.mod);
            const states = [
                actions.some(action => action.type === 'install') ? '将安装' : '',
                actions.some(action => action.type === 'update') ? '将更新' : '',
                actions.some(action => action.type === 'enable') ? '将启用' : ''
            ].filter(Boolean);
            const version = requirement.dependency.version ? `（需要 ${requirement.dependency.version}）` : '';
            return `${requirement.mod.name}${version}：${states.join('并') || '已满足'}`;
        });
        if (externalOnly && !actionLines.length) {
            window.open(mod.otherUrl, '_blank', 'noopener');
            return true;
        }
        let releaseInfo = null;
        let installPlanText = '';
        let historicalCompanions = [];
        if (!externalOnly) {
            const planController = typeof AbortController === 'function' ? new AbortController() : null;
            if (planController) activeDownloadControllers.set(mod.name, planController);
            updateDownloadProgress(mod.name, null, '正在生成安装包清单...');
            try {
                releaseInfo = await fetchModRelease(mod, { useCache: true, signal: planController?.signal });
                installPlanText = formatReleaseInstallPlan(releaseInfo);
                const currentAssets = getReleaseInstallAssets(releaseInfo);
                if (!releaseInfo.requiresManualSelection && !currentAssets.some(asset => COMPANION_ASSET_PATTERN.test(asset.name || ''))) {
                    historicalCompanions = await fetchRecentCompanionAssets(mod, 3, { useCache: true, signal: planController?.signal });
                    if (historicalCompanions.length) {
                        const historyLines = historicalCompanions.map(asset => {
                            const size = asset.size ? `，${(asset.size / 1024 / 1024).toFixed(1)} MB` : '';
                            return `· ${asset.name}${asset.releaseTag ? `（${asset.releaseTag}${asset.releaseDate ? `，${asset.releaseDate}` : ''}${size}）` : ''}`;
                        });
                        installPlanText += `\n\n同仓库历史可选图包/资源包（旧版兼容性需玩家确认，不会默认安装）：\n${historyLines.join('\n')}`;
                    }
                }
            } catch (error) {
                if (planController?.signal.aborted || error?.name === 'AbortError') {
                    resetDownloadProgress(mod.name);
                    window.dolOptShowToast(`已取消【${mod.name}】的安装包清单读取`, 'info');
                    return false;
                }
                resetDownloadProgress(mod.name);
                if (['MANUAL_SOURCE', 'RELEASE_NOT_FOUND'].includes(error?.code)) {
                    return offerOriginalDownloadSource(mod, error);
                }
                if (error?.code === 'REPO_NOT_FOUND' || error?.status === 404 || mod._isDeadRepo || isDeadRepo(mod.githubUrl)) {
                    if (typeof window.dolOptAlert === 'function') {
                        await window.dolOptAlert('该模组的 GitHub 仓库已被作者移除或不存在 (404)，无法下载更新。\n\n已自动更新本地模组状态为无需更新。', '模组仓库已失效');
                    }
                    if (typeof renderMarketCards === 'function') renderMarketCards();
                    return false;
                }
                console.warn('[DolOptimization] 预读取安装包清单失败，将在安装时重试', error);
                installPlanText = '安装包清单：暂时读取失败，开始安装后将自动重试。';
            } finally {
                if (activeDownloadControllers.get(mod.name) === planController) activeDownloadControllers.delete(mod.name);
            }
        }
        const companionOptions = historicalCompanions.length
            ? [{ value: 'none', label: '不安装历史附属包' }, ...historicalCompanions.map((asset, index) => ({
                value: `history:${index}`,
                label: `${asset.name}${asset.releaseTag ? `（${asset.releaseTag}）` : ''}`
            }))]
            : [];
        const manualAssetOptions = releaseInfo?.requiresManualSelection ? getManualAssetOptions(releaseInfo) : [];
        const selectOptions = manualAssetOptions.length ? manualAssetOptions : companionOptions;
        const dependencyHtml = plan.requirements.length ? `<div id="dolOptInstallDependencyArea">${formatDependencyListHtml(plan)}</div>` : '';
        const initialConflicts = detectModInstallationConflicts(mod, plan.actions);
        const conflictAreaHtml = `<div id="dolOptInstallConflictArea"${initialConflicts.length ? '' : ' style="display:none;"'}>${formatConflictWarningHtml(initialConflicts)}</div>`;

        const trustedMessageHtml = releaseInfo
            ? `${dependencyHtml}${conflictAreaHtml}${formatReleaseInstallPlanHtml(releaseInfo, selectedMirror, historicalCompanions.length)}`
            : ((dependencyHtml || initialConflicts.length) ? `${dependencyHtml}${conflictAreaHtml}<div class="dol-opt-install-summary"><div class="dol-opt-install-overview"><strong>目标模组需手动下载</strong></div><p style="margin:8px 0 0; color:var(--300,#bbb); font-size:0.9em;">处理完上述勾选的前置依赖后，将自动为您打开【${window.dolOptEscapeHtml(mod.name)}】的下载页面。</p></div>` : '');
        const initialActionCount = plan.actions.length;
        const initialConfirmText = manualAssetOptions.length
            ? '安装所选包'
            : (initialActionCount
                ? (externalOnly ? `一并处理（${initialActionCount}项依赖）` : `一键安装（含 ${initialActionCount} 项依赖）`)
                : '开始安装');

        let pendingConflictChange = null;
        const choice = await window.dolOptConfirm({
            title: externalOnly ? `处理【${mod.name}】的前置依赖` : `下载并安装【${mod.name}】`,
            message: actionLines.length
                ? `检测到以下必需依赖需要一并处理：\n\n${actionLines.join('\n')}\n\n${externalOnly ? '处理完成后将打开目标模组的外部下载页面。' : `${installPlanText}\n\n将按依赖顺序处理，并在最后安装【${mod.name}】。`}`
                : `${installPlanText}\n\n${selectedMirror.browserOnly ? '以上文件将由浏览器下载后手动导入。' : '以上文件将自动注册到 ModLoader 旁加载中。'}\n\n下载线路：${selectedMirror.name}\n\n是否立即开始下载并安装？`,
            trustedMessageHtml,
            dialogClass: 'dol-opt-install-dialog',
            confirmText: initialConfirmText,
            cancelText: '取消',
            confirmType: initialConflicts.some(c => c.localConflictMod?.isEnabled) ? 'danger' : 'primary',
            selectLabel: manualAssetOptions.length ? '主安装包选择' : (companionOptions.length ? '历史美术包选择' : undefined),
            selectOptions,
            selectValue: manualAssetOptions.length ? '' : (companionOptions.length ? 'none' : undefined),
            requireSelection: manualAssetOptions.length > 0,
            onRender: (dialog) => {
                const dependencyArea = dialog.querySelector('#dolOptInstallDependencyArea');
                const confirmBtn = dialog.querySelector('.dol-opt-modal-btn-confirm');
                const conflictArea = dialog.querySelector('#dolOptInstallConflictArea');
                const updateDepUi = () => {
                    const activeActions = getActivePlan().actions;
                    if (dependencyArea) dependencyArea.innerHTML = formatDependencyListHtml(plan);
                    dialog.querySelectorAll('input[name="dolOptDepReq"]').forEach(checkbox => {
                        const requirement = plan.requirements[Number(checkbox.dataset.reqIndex)];
                        if (!requirement) return;
                        const key = dependencyKey(requirement.mod);
                        checkbox.checked = !skippedDependencyKeys.has(key);
                        if (!checkbox.checked) {
                            const row = checkbox.closest('.dol-opt-dep-item');
                            row?.classList.add('dol-opt-dep-skipped');
                            const status = row?.querySelector('.dol-opt-dep-status');
                            if (status) {
                                status.textContent = status.dataset.skipText || '跳过处理';
                                status.className = 'dol-opt-dep-status grey';
                            }
                        }
                        checkbox.addEventListener('change', () => {
                            if (checkbox.checked) skippedDependencyKeys.delete(key);
                            else skippedDependencyKeys.add(key);
                            updateDepUi();
                        });
                    });
                    const conflicts = detectModInstallationConflicts(mod, activeActions);
                    if (conflictArea) {
                        conflictArea.innerHTML = formatConflictWarningHtml(conflicts);
                        conflictArea.style.display = conflicts.length ? '' : 'none';
                        conflictArea.querySelectorAll('.dol-opt-conflict-disable-btn').forEach(button => {
                            button.onclick = async event => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (pendingConflictChange) return;
                                button.disabled = true;
                                pendingConflictChange = (async () => {
                                    try {
                                        if (await disableInstallConflict(button.dataset.conflictRaw, button.dataset.conflictName, getAffectedTargets(button.dataset.conflictRaw))) onConflictDisabled(button.dataset.conflictRaw);
                                    } catch (error) {
                                        console.error('[dolModMarket] 快捷禁用冲突模组失败:', error);
                                        window.dolOptShowToast('快捷禁用未完成，请检查模组管理器状态', 'warning');
                                    }
                                })();
                                await pendingConflictChange;
                                pendingConflictChange = null;
                                updateDepUi();
                            };
                        });
                    }
                    if (confirmBtn && !manualAssetOptions.length) {
                        const danger = conflicts.some(item => item.localConflictMod.isIncoming || item.localConflictMod.isEnabled);
                        confirmBtn.className = confirmBtn.className.replace(/\bdol-opt-btn-(?:primary|danger)\b/, danger ? 'dol-opt-btn-danger' : 'dol-opt-btn-primary');
                        confirmBtn.textContent = activeActions.length
                            ? (externalOnly ? `一并处理（${activeActions.length}项依赖）` : `一键安装（含 ${activeActions.length} 项依赖）`)
                            : (externalOnly ? '直接打开下载页面' : '开始安装');
                    }
                };
                updateDepUi();
            },
            customResult: (dialog) => {
                const selectEl = dialog.querySelector('.dol-opt-modal-select');
                return {
                    selectValue: selectOptions.length ? (selectEl?.value || '') : ''
                };
            }
        });

        if (pendingConflictChange) await pendingConflictChange;
        if (!choice) {
            resetDownloadProgress(mod.name);
            return false;
        }

        let selectValue = '';
        if (typeof choice === 'object' && choice !== null) {
            selectValue = choice.selectValue;
        } else if (typeof choice === 'string') {
            selectValue = choice;
        }

        const selectedReleaseInfo = applyManualAssetSelection(releaseInfo, selectValue);
        if (selectedReleaseInfo) releaseInfo = selectedReleaseInfo;
        const historyMatch = typeof selectValue === 'string' ? selectValue.match(/^history:(\d+)$/) : null;
        if (historyMatch && releaseInfo) {
            const selectedCompanion = historicalCompanions[Number(historyMatch[1])];
            if (selectedCompanion) {
                releaseInfo = { ...releaseInfo, assets: [...getReleaseInstallAssets(releaseInfo), selectedCompanion] };
            }
        }

        if (!await confirmInstallConflicts(getActivePlan, { onChanged: onConflictDisabled, getAffectedTargets })) {
            resetDownloadProgress(mod.name);
            return false;
        }
        const actionsToExecute = getActivePlan().actions;
        if (plan.unavailable.length || plan.cycles.length) {
            await window.dolOptAlert('本地模组状态已变化，前置依赖暂时无法满足。请重新检查后再安装。', '安装计划已变化');
            return false;
        }

        if (!actionsToExecute.length) {
            if (externalOnly) {
                window.open(mod.otherUrl, '_blank', 'noopener');
                return true;
            }
            return downloadAndInstallMod(mod, currentMirrorId, { releaseInfo });
        }

        const totalSteps = actionsToExecute.length + (externalOnly ? 0 : 1);
        for (let index = 0; index < actionsToExecute.length; index++) {
            const action = actionsToExecute[index];
            const progressPrefix = `${index + 1}/${totalSteps} 前置【${action.mod.name}】：`;
            if (action.type === 'enable') {
                updateDownloadProgress(mod.name, null, `${progressPrefix}正在启用...`);
                if (typeof window.dolOptToggleSideMod !== 'function') {
                    await window.dolOptAlert(`无法启用前置依赖【${action.mod.name}】，已停止安装目标模组。`, '安装已停止');
                    return false;
                }
                const isEnabled = () => {
                    const state = window._dolOptModState;
                    const local = state?.sideMods?.find(item => item.name === action.local.name);
                    return local ? local.enabled === true : (state?.sideEnabled || []).includes(action.local.name);
                };
                if (!isEnabled()) {
                    const enabled = await window.dolOptToggleSideMod(action.local.name, true, { silentOfferReload: true });
                    if (enabled !== true || !isEnabled()) {
                        await window.dolOptAlert(`前置依赖【${action.mod.name}】未能启用，已停止安装目标模组。`, '安装已停止');
                        return false;
                    }
                }
                updateDownloadProgress(mod.name, 100, `${progressPrefix}已启用`);
                continue;
            }
            window.dolOptShowToast(`正在${action.type === 'update' ? '更新' : '安装'}前置依赖【${action.mod.name}】...`, 'warning');
            if (!await downloadAndInstallMod(action.mod, currentMirrorId, {
                askRestart: false,
                skipReloadOffer: true,
                progressTargetName: mod.name,
                progressPrefix
            })) {
                await window.dolOptAlert(`前置依赖【${action.mod.name}】未能自动安装，已停止安装目标模组。`, '安装已停止');
                return false;
            }
        }

        if (externalOnly) {
            window.open(mod.otherUrl, '_blank', 'noopener');
            updateDownloadProgress(mod.name, 100, `${totalSteps}/${totalSteps} 前置依赖已处理，已打开下载页面`);
            window.dolOptShowToast(`前置依赖已处理，已打开【${mod.name}】下载页面`, 'info');
            return true;
        }
        if (!await downloadAndInstallMod(mod, currentMirrorId, {
            askRestart: false,
            skipReloadOffer: true,
            progressPrefix: `${totalSteps}/${totalSteps} 目标模组【${mod.name}】：`,
            releaseInfo
        })) return false;
        const isFramework = (typeof window.dolOptIsFrameworkMod === 'function' && (
            window.dolOptIsFrameworkMod(mod.name) ||
            actionsToExecute.some(a => window.dolOptIsFrameworkMod(a.mod?.name) || window.dolOptIsFrameworkMod(a.local?.name))
        ));
        if (isFramework && typeof window.dolOptOfferReload === 'function') {
            await window.dolOptOfferReload(`模组【${mod.name}】${actionsToExecute.length ? '及所选前置依赖' : ''}已处理完成。`, { isFramework: true });
        } else {
            const restart = await window.dolOptConfirm({
                title: '安装完成',
                message: `模组【${mod.name}】${actionsToExecute.length ? '及所选前置依赖' : ''}已处理完成。\n\n是否立即重新载入游戏使其生效？`,
                confirmText: '立即重载',
                cancelText: '稍后重载',
                confirmType: 'primary'
            });
            if (restart) {
                window.dolOptShowToast('正在重新载入游戏...', 'warning');
                setTimeout(() => location.reload(), 300);
            }
        }
        return true;
    }

    function shouldShowCategoryFilters(statusFilter) {
        return !['installed', 'updatable', 'ignored'].includes(statusFilter);
    }

    function renderCategoryFilters() {
        const container = document.getElementById('dolOptCategoryCapsules');
        if (!container) return;
        const showCategories = shouldShowCategoryFilters(currentStatusFilter);
        container.style.display = showCategories ? '' : 'none';
        if (!showCategories) return;
        const counts = new Map();
        marketModList.forEach(mod => counts.set(mod.category || '待分类', (counts.get(mod.category || '待分类') || 0) + 1));
        const categories = [
            ...MARKET_CATEGORIES.filter(category => counts.has(category)),
            ...[...counts.keys()].filter(category => !MARKET_CATEGORIES.includes(category)).sort((a, b) => a.localeCompare(b))
        ];
        if (currentCategory !== 'all' && !counts.has(currentCategory)) currentCategory = 'all';
        const escapeHtml = window.dolOptEscapeHtml || (value => value);
        container.innerHTML = [
            `<button type="button" class="macro-button capsule-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all">全部分类（${marketModList.length}）</button>`,
            ...categories.map(category => `<button type="button" class="macro-button capsule-btn ${currentCategory === category ? 'active' : ''}" data-cat="${escapeHtml(category)}">${escapeHtml(category)}（${counts.get(category)}）</button>`)
        ].join('');
        container.querySelectorAll('.capsule-btn').forEach(btn => {
            btn.onclick = () => {
                currentCategory = btn.dataset.cat || 'all';
                renderCategoryFilters();
                renderMarketCards();
            };
        });
    }

    /** 初始化模组市场主入口 */
    window.dolOptInitMarket = async function(forceRefresh = false) {
        const root = document.getElementById('dolOptModMarketContainer');
        if (!root) return;

        root.innerHTML = `
            <!-- ===== 顶部状态信息卡 ===== -->
            <div id="dolOptMarketStats" class="settingsGridSmall dol-opt-stats-container"></div>

            <div class="dol-opt-market-source grey" role="note">
                模组资料来源：<a href="https://degreesoflewditycn.miraheze.org/wiki/%E6%A8%A1%E7%BB%84%E5%88%97%E8%A1%A8" target="_blank" rel="noopener">DOL 中文社区 Wiki「模组列表」</a>
            </div>

            <!-- ===== 搜索与筛选工具栏 ===== -->
            <div class="dol-opt-market-toolbar">
                <div class="dol-opt-market-search-row">
                    <input
                        id="dolOptMarketSearch"
                        class="dol-opt-search-input"
                        type="search"
                        placeholder="搜索模组名称、作者或简介关键词……"
                        value="${window.dolOptEscapeHtml(currentSearchText)}"
                    />
                    <button id="dolOptMarketBtnResetFilter" type="button" class="macro-button dol-opt-btn-primary" onclick="window.dolModMarket.resetFilters()" title="清除当前所有筛选与搜索，查看全部模组" style="display:none; white-space:nowrap;">返回全部模组</button>
                    <button id="dolOptMarketBtnRefresh" type="button" class="macro-button dol-opt-btn-sub" title="重新从 Wiki 拉取最新模组">刷新市场</button>
                </div>

                <div class="dol-opt-market-filter-row">
                    <div class="dol-opt-market-capsules" id="dolOptCategoryCapsules">
                        <button type="button" class="macro-button capsule-btn active" data-cat="all">全部分类</button>
                    </div>
                    <div class="dol-opt-market-selects">
                        <select id="dolOptStatusSelect" class="dol-opt-select">
                            <option value="all" ${currentStatusFilter === 'all' ? 'selected' : ''}>全部状态</option>
                            <option value="installable" ${currentStatusFilter === 'installable' ? 'selected' : ''}>可安装/可更新</option>
                            <option value="updatable" ${currentStatusFilter === 'updatable' ? 'selected' : ''}>仅看可更新</option>
                            <option value="installed" ${currentStatusFilter === 'installed' ? 'selected' : ''}>已安装模组</option>
                            <option value="ignored" ${currentStatusFilter === 'ignored' ? 'selected' : ''}>已忽略更新</option>
                        </select>
                        <select id="dolOptSortSelect" class="dol-opt-select">
                            <option value="date" ${currentSortBy === 'date' ? 'selected' : ''}>按最新更新</option>
                            <option value="name" ${currentSortBy === 'name' ? 'selected' : ''}>按模组名称</option>
                        </select>
                        <select id="dolOptMirrorSelect" class="dol-opt-select" title="下载线路切换">
                            ${MIRROR_SERVERS.map(m => `<option value="${m.id}" ${currentMirrorId === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="dol-opt-market-filter-footer">
                    <button id="dolOptMarketBtnIgnored" type="button" class="dol-opt-market-text-action" onclick="window.dolModMarket.filterIgnoredOnly()" aria-pressed="false" hidden>查看已忽略模组</button>
                </div>
            </div>

            <div id="dolOptMarketBatchToolbar" class="dol-opt-market-batch-toolbar" role="group" aria-label="模组多选安装"></div>

            <!-- ===== 模组卡片列表容器 ===== -->
            <div id="dolOptMarketCardsContainer" class="dol-opt-market-grid">
                <div class="dol-opt-loading-box grey">
                    正在拉取 Wiki 模组市场数据，请稍候……
                </div>
            </div>
        `;
        renderBatchInstallToolbar();

        // 绑定搜索与筛选事件
        const searchInput = document.getElementById('dolOptMarketSearch');
        if (searchInput) {
            let debounceTimer;
            searchInput.oninput = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    currentSearchText = searchInput.value.trim();
                    renderMarketCards();
                }, 200);
            };
        }

        const refreshBtn = document.getElementById('dolOptMarketBtnRefresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                if (batchInstallState.running) return;
                refreshBtn.disabled = true;
                refreshBtn.textContent = '刷新中...';
                window.dolOptShowToast('正在从 Wiki 抓取最新模组列表...', 'info');
                try {
                    await loadMarketData(true);
                    renderCategoryFilters();
                    renderMarketCards();
                    window.dolOptShowToast(`刷新成功，已载入 ${marketModList.length} 个模组`, 'success');
                } catch (e) {
                    window.dolOptShowToast(`刷新失败: ${e.message}`, 'warning');
                } finally {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = '刷新市场';
                }
            };
        }

        const statusSelect = document.getElementById('dolOptStatusSelect');
        if (statusSelect) {
            statusSelect.onchange = () => {
                currentStatusFilter = statusSelect.value;
                if (!shouldShowCategoryFilters(currentStatusFilter)) currentCategory = 'all';
                renderCategoryFilters();
                renderMarketCards();
            };
        }

        const sortSelect = document.getElementById('dolOptSortSelect');
        if (sortSelect) {
            sortSelect.onchange = () => {
                currentSortBy = sortSelect.value;
                renderMarketCards();
            };
        }

        const mirrorSelect = document.getElementById('dolOptMirrorSelect');
        if (mirrorSelect) {
            mirrorSelect.onchange = () => {
                if (batchInstallState.running) return;
                setCurrentMirror(mirrorSelect.value);
            };
        }

        // 预载模组管理状态以获得完整的本地模组列表与别名
        try {
            // 自愈：先把「包体已安装、却未登记进启用列表」的模组补回列表，
            // 否则市场会把明明已经下载好的模组一直显示成未安装 / 可更新。
            if (!window._dolOptOrphanRepairDone && typeof window.dolOptRepairOrphanModZips === 'function') {
                window._dolOptOrphanRepairDone = true;
                const repair = await window.dolOptRepairOrphanModZips();
                if (repair?.repaired?.length && typeof window.dolOptLoadModManageState === 'function') {
                    await window.dolOptLoadModManageState(true);
                }
            }
            if (typeof window.dolOptLoadModManageState === 'function') {
                await window.dolOptLoadModManageState();
            }
            if (typeof window.dolOptLoadDisabledModInfo === 'function') {
                await window.dolOptLoadDisabledModInfo();
            }
        } catch (_) {}

        // 加载数据
        try {
            await loadMarketData(forceRefresh);
            renderCategoryFilters();
            renderMarketCards();
        } catch (err) {
            const cardsContainer = document.getElementById('dolOptMarketCardsContainer');
            if (cardsContainer) {
                cardsContainer.innerHTML = `
                    <div class="dol-opt-empty-state red">
                        加载模组市场数据失败: ${window.dolOptEscapeHtml(err.message || String(err))}
                        <br><br>
                        <button type="button" class="macro-button dol-opt-btn-primary" onclick="window.dolOptInitMarket()">重新尝试加载</button>
                    </div>
                `;
            }
        }
    };

    /** 获取所有有新版本可更新的模组列表（优先读内存，次选读 localStorage 缓存） */
    function getUpdatableMods() {
        let list = marketModList;
        if (!list || !list.length) {
            const cached = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL);
            if (cached && Array.isArray(cached) && cached.length > 0) {
                list = cached;
            }
        }
        if (!list || !list.length) return [];

        const profiles = getLocalInstalledProfiles();
        const updatables = [];
        for (const mod of list) {
            const st = checkModInstallStatus(mod, profiles);
            if (st === 'update_available') {
                updatables.push({
                    marketMod: mod,
                    localProfile: mod._matchedLocal,
                    name: mod.name,
                    localName: mod._matchedLocal?.name || mod.name,
                    currentVersion: mod._matchedLocal?.version || '',
                    newVersion: mod.version || ''
                });
            }
        }
        return updatables;
    }

    /** 动态更新工具栏上的“返回全部模组”按钮显隐状态 */
    function updateToolbarResetBtn() {
        const btn = document.getElementById('dolOptMarketBtnResetFilter');
        if (!btn) return;
        const isFiltering = (currentCategory !== 'all' || currentStatusFilter !== 'all' || !!currentSearchText);
        btn.style.display = isFiltering ? 'inline-block' : 'none';
    }

    /** 一键重置所有筛选，还原为全部模组展示 */
    function resetFilters() {
        currentCategory = 'all';
        currentStatusFilter = 'all';
        currentSearchText = '';
        const searchInput = document.getElementById('dolOptMarketSearch');
        if (searchInput) searchInput.value = '';
        const statusSelect = document.getElementById('dolOptStatusSelect');
        if (statusSelect) statusSelect.value = 'all';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
        if (typeof window.dolOptShowToast === 'function') {
            window.dolOptShowToast('已返回并展示全部模组', 'info');
        }
    }

    /** 快捷将市场卡片过滤为“已安装模组” */
    function filterInstalledOnly() {
        currentStatusFilter = 'installed';
        currentCategory = 'all';
        const sel = document.getElementById('dolOptStatusSelect');
        if (sel) sel.value = 'installed';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 快捷将市场卡片过滤为“仅看可更新” */
    function filterUpdatableOnly() {
        currentStatusFilter = 'updatable';
        currentCategory = 'all';
        const sel = document.getElementById('dolOptStatusSelect');
        if (sel) sel.value = 'updatable';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 进入独立的已忽略更新列表 */
    function filterIgnoredOnly() {
        currentStatusFilter = 'ignored';
        currentCategory = 'all';
        const sel = document.getElementById('dolOptStatusSelect');
        if (sel) sel.value = 'ignored';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 一键全部批量更新 */
    async function updateAllMods() {
        return runMarketInstallTask(() => updateAllModsUnlocked());
    }

    async function updateAllModsUnlocked() {
        const updatables = getUpdatableMods();
        if (!updatables.length) {
            window.dolOptShowToast('当前暂无可更新的模组', 'info');
            return;
        }

        const selectedMirror = MIRROR_SERVERS.find(m => m.id === currentMirrorId) || MIRROR_SERVERS[0];
        if (selectedMirror.browserOnly) {
            await window.dolOptAlert('GitHub 直连受浏览器跨域限制，只支持逐个浏览器下载后手动导入。\n\n请切换至加速通道 1、2 或 3 后再使用一键全部更新。', '当前线路不支持批量更新');
            return;
        }

        const lines = updatables.map(u => `· ${u.name} (当前: ${formatVersionDisplay(u.currentVersion)} -> 最新: ${formatVersionDisplay(u.newVersion)})`).join('\n');
        const ok = await window.dolOptConfirm({
            title: '一键全部更新',
            message: `检测到共有 ${updatables.length} 个模组可升级至最新版本：\n\n${lines}\n\n当前下载线路：${MIRROR_SERVERS.find(m => m.id === currentMirrorId)?.name || '默认加速'}\n是否立即开始批量下载并安装？`,
            confirmText: '开始更新',
            cancelText: '取消',
            confirmType: 'primary'
        });

        if (!ok) return;

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < updatables.length; i++) {
            const item = updatables[i];
            window.dolOptShowToast(`[${i + 1}/${updatables.length}] 正在更新【${item.name}】...`, 'warning');
            try {
                if (await downloadAndInstallMod(item.marketMod, currentMirrorId, { askRestart: false, skipReloadOffer: true })) successCount++;
                else failCount++;
            } catch (err) {
                console.error('[DolOptimization] 批量更新单个模组失败', item.name, err);
                failCount++;
            }
        }

        renderMarketCards();

        const hasUpdatedFramework = updatables.slice(0, successCount).some(u => typeof window.dolOptIsFrameworkMod === 'function' && window.dolOptIsFrameworkMod(u.name));
        const msg = `批量更新已完成！\n成功: ${successCount} 个${failCount > 0 ? `，失败: ${failCount} 个` : ''}。\n\n是否立即重新载入游戏以使新版本生效？`;
        if (hasUpdatedFramework && typeof window.dolOptOfferReload === 'function') {
            await window.dolOptOfferReload(`批量更新已完成（成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}，含核心框架）。`, { isFramework: true });
        } else {
            const restart = await window.dolOptConfirm({
                title: '更新完成',
                message: msg,
                confirmText: '立即重载',
                cancelText: '稍后重载',
                confirmType: 'primary'
            });
            if (restart) {
                window.dolOptShowToast('正在重新载入游戏...', 'warning');
                setTimeout(() => location.reload(), 300);
            }
        }
    }

    /** 从外部（模组管理页等）一键跳转到模组市场并开启更新筛选 */
    window.dolOptGoToMarketUpdates = function() {
        window.dolOptSwitchTab('模组市场');
        setTimeout(() => {
            filterUpdatableOnly();
        }, 30);
    };

    /** 从模组管理列表原地直接更新单个模组 */
    window.dolOptUpdateModDirectly = async function(modName) {
        if (!modName) return;
        const updatables = getUpdatableMods();
        const target = updatables.find(u => u.localName === modName || u.name === modName)
            || (marketModList ? marketModList.find(m => m.name === modName || m._matchedLocal?.name === modName) : null);
        if (target) {
            const marketMod = target.marketMod || target;
            await promptDownloadMirrorAndInstall(marketMod);
        } else {
            window.dolOptShowToast(`未在模组市场找到【${modName}】对应的发布包`, 'warning');
        }
    };

    // 挂载公共接口
    window.dolModMarket = {
        loadMarketData,
        fetchGithubReadme,
        getReadmeImageProxyUrl,
        parseModsFromHtml,
        fetchModRelease,
        fetchRecentCompanionAssets,
        buildReleaseAssetPlan,
        formatReleaseInstallPlan,
        getAcceleratedUrl,
        getDownloadUrl,
        readDownloadResponse,
        verifyAssetDigest,
        getLocalInstalledProfiles,
        checkModInstallStatus,
        findMarketModByLocalName,
        cancelDownload,
        downloadAndInstallMod,
        deriveClassification,
        deriveTags,
        compareVersions,
        satisfiesVersion,
        buildDependencyPlan,
        buildBatchInstallPlan,
        executeBatchInstallPlan,
        installSelectedMods,
        formatVersionDisplay,
        MIRROR_SERVERS,
        getUpdatableMods,
        getMarketModKey,
        isBatchInstallEligible,
        getBatchSelectionState,
        toggleBatchSelection,
        selectAllVisibleMods,
        clearBatchSelection,
        setBatchModSelected,
        isStatsFilterActive,
        shouldShowCategoryFilters,
        filterUpdatableOnly,
        filterInstalledOnly,
        filterIgnoredOnly,
        resetFilters,
        updateToolbarResetBtn,
        updateAllMods,
        promptDownloadMirrorAndInstall,
        getIgnoredUpdates,
        setModUpdateIgnored,
        MOD_MARKET_VERSION_RULES,
        RELEASE_INDEX_URL,
        RELEASE_INDEX_MIRRORS,
        getActiveReleaseWorkerBaseUrl: () => activeReleaseWorkerBaseUrl,
        RELEASE_WORKER_API_BASE,
        IDENTITY_CATALOG_URL,
        normalizeReleaseIndex,
        fetchReleaseIndex,
        applyIdentityCatalog,
        loadIdentityCatalog,
        MARKET_CATEGORIES,
        KNOWN_MOD_MARKET_ALIASES: DOL_OPT_KNOWN_MOD_MARKET_ALIASES,
        isDeadRepo,
        markRepoAsDead,
        unmarkRepoAsDead,
        getDeadRepos,
        KNOWN_DEAD_REPOSITORIES,
        KNOWN_ACTIVE_REPOSITORIES,
        getStaticMarketModSubtext,
        formatDependencyListHtml,
        KNOWN_MOD_CONFLICT_RULES,
        isModMatchingConflictGroup,
        resolveConflictModDisplayName,
        findDependentModsForConflict,
        detectModInstallationConflicts,
        confirmInstallConflicts,
        formatConflictWarningHtml
    };

})();
