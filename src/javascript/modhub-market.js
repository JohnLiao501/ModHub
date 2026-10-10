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
    const WIKI_CACHE_KEY = 'modhub_market_wiki_v5';
    const WIKI_CACHE_TTL = 30 * 60 * 1000; // 30 分钟
    const MODHUB_WITHDRAWN_STORAGE_KEY = 'modhub_market_withdrawn_v2';
    const MODHUB_SUBMISSION_RECEIPTS_KEY = 'modhub_market_submission_receipts_v1';
    const MODHUB_SUBMISSION_DRAFTS_KEY = 'modhub_market_submission_drafts_v1';
    const MODHUB_SUBMISSION_PAGE_SIZE = 10;
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
    const IDENTITY_CACHE_KEY = 'modhub_market_identities_v4';
    const IDENTITY_FETCH_TIMEOUT_MS = 8000;
    const README_FETCH_TIMEOUT_MS = 8000;
    const MODHUB_README_CACHE_PREFIX = 'modhub_market_readme_v1_';
    const MODHUB_README_CACHE_TTL = 6 * 60 * 60 * 1000;
    const RELEASE_CACHE_PREFIX = 'modhub_market_rel_v2_';
    const RELEASE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
    const IGNORE_STORAGE_KEY = 'modhub_market_ignored_updates_v1';
    const CONFIRMED_STORAGE_KEY = 'modhub_market_confirmed_updates_v1';
    const HIDE_DEAD_SOURCES_KEY = 'modhub_market_hide_dead_sources_v1';
    const PACKAGE_DIGEST_CACHE_KEY = 'modhub_package_digest_cache_v1';
    const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
    // 准备结果只在本次安装内复用，不能把换版后的包或外部构造的对象直接导入。
    const preparedMarketPackages = new WeakMap();
    const modUpdateChecks = new Map();
    // 已撤回或目录已移除的身份仅用于识别本地旧语言包，不能重新开放安装。
    const languageIdentityMembers = new Map();
    const selectedMarketLanguages = new Map();
    const registeredIdentityMetadata = new Map();
    let marketHistoryRefresh = 0;
    const installedPackageRecords = new Map();
    const downloadedPackageDigests = new Map();
    let officialPackageMetadataQueue = Promise.resolve();

    function loadInstalledPackageRecordsFromStorage() {
        try {
            const raw = localStorage.getItem(PACKAGE_DIGEST_CACHE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                for (const [key, value] of Object.entries(parsed)) {
                    if (key && value && typeof value.digest === 'string' && value.digest) {
                        installedPackageRecords.set(key.toLowerCase(), {
                            bootJson: value.bootJson || { name: key },
                            digest: value.digest
                        });
                    }
                }
            }
        } catch (_) {}
    }

    function saveInstalledPackageRecordsToStorage() {
        try {
            const obj = {};
            for (const [k, v] of installedPackageRecords.entries()) {
                if (k && v?.digest) {
                    obj[k] = {
                        bootJson: v.bootJson ? { name: v.bootJson.name, version: v.bootJson.version } : { name: k },
                        digest: v.digest
                    };
                }
            }
            localStorage.setItem(PACKAGE_DIGEST_CACHE_KEY, JSON.stringify(obj));
        } catch (_) {}
    }

    loadInstalledPackageRecordsFromStorage();
    const COMPANION_ASSET_PATTERN = /(?:photo|image|resource|asset)[\s._-]*pack|图包|图片包|资源包|素材包/i;
    const MODHUB_OPTIONAL_AUDIO_PATTERN = /(?:^|[\s._-])(?:audio(?:[\s._-]*pack)?|(?:sound|music|bgm)[\s._-]*pack)(?=[\s._-]|$)|音频包|音乐包|音效包/i;

    // 针对社区个别模组作者打包失误（如 Release 为新版但内部 boot.json 未递增）或 Wiki 录入虚高版本的容错规则库
    const MOD_MARKET_VERSION_RULES = [
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
            // 织境空间系列模组: 作者已移除 GitHub 仓库 (404)，且 Wiki 词条录入的料理扩展历史版本 (0.4.19) 虚高且无可用发布
            name: '织境空间',
            match: (name, repo) => name.includes('织境') || (repo && repo.includes('wovenrealm')),
            isUpToDate: (localVer, remoteVer) => true // 本地只要已安装即视为已是最新，绝不误报更新
        }
    ];

    function getIgnoredUpdates() {
        try {
            return JSON.parse(readStoredValue(IGNORE_STORAGE_KEY) || '{}');
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
            return JSON.parse(readStoredValue(CONFIRMED_STORAGE_KEY) || '{}');
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
    const MODHUB_KNOWN_MOD_MARKET_ALIASES = {
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
        'smartphoneomega': ['万能的智能手机 Omega', '万能的智能手机 OmegaΩ', '万能的智能手机 简化版', 'SmartPhone Omega'],
        '万能的智能手机omega': ['smartphoneomega', '万能的智能手机 Omega', '万能的智能手机 OmegaΩ', '万能的智能手机 简化版', 'SmartPhone Omega'],
        '万能的智能手机omegaω': ['smartphoneomega', '万能的智能手机 Omega', '万能的智能手机 OmegaΩ', '万能的智能手机 简化版', 'SmartPhone Omega'],
        '万能的智能手机简化版': ['smartphoneomega', '万能的智能手机 Omega', '万能的智能手机 OmegaΩ', 'SmartPhone Omega'],
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
    const MODHUB_KNOWN_MOD_CLASSIFICATIONS = {};
    const MODHUB_KNOWN_MOD_REPOSITORY_KEYS = {};
    const MODHUB_IDENTITY_NAME_OWNERS = new Map();
    const MODHUB_AMBIGUOUS_IDENTITY_NAMES = new Set();
    const MODHUB_BOOT_IDENTITIES = new Map();
    const MODHUB_OFFLINE_REPOSITORIES = {
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
        smartphoneomega: ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        '万能的智能手机omega': ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        '万能的智能手机omegaω': ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
        '万能的智能手机简化版': ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'],
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
    for (const [name, repositoryKeys] of Object.entries(MODHUB_OFFLINE_REPOSITORIES)) {
        const normalizedKeys = repositoryKeys.map(key => key.toLowerCase());
        [name, ...(MODHUB_KNOWN_MOD_MARKET_ALIASES[name] || [])].forEach(alias => {
            MODHUB_KNOWN_MOD_REPOSITORY_KEYS[normalizeKey(alias)] = normalizedKeys;
        });
        normalizedKeys.forEach(key => {
            MODHUB_KNOWN_MOD_REPOSITORY_KEYS[normalizeKey(key.split('/')[1])] = normalizedKeys;
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
    let marketViewRevision = 0;
    let marketDataRequest = null;
    let marketDataRefreshing = false;
    let marketDataLoaded = false;
    let localProfileState = null;
    let localProfileStamp = '';
    let localProfileRevision = 0;
    let currentCategory = 'all';
    let currentStatusFilter = 'all';
    let currentSortBy = 'date'; // 'date' | 'name'
    let currentSearchText = '';
    let currentMarketSection = 'packages';
    let marketSearchTimer;
    const sectionFilters = {
        packages: { category: 'all', status: 'all', search: '', sort: 'date' },
        spells: { category: 'all', status: 'all', search: '', sort: 'date' }
    };
    let hideDeadSources = true;
    try { hideDeadSources = readStoredValue(HIDE_DEAD_SOURCES_KEY) !== 'false'; } catch (_) {}
    let isLoading = false;
    const batchInstallState = { selecting: false, selected: new Set(), running: false, stopRequested: false, progressPhase: '', current: '', completed: 0, total: 0 };

    function getMarketModKey(mod) {
        if (mod?.isLanguageGroup) return `language-group:${mod.variantGroupId}`;
        const repo = parseGithubRepo(mod?.githubUrl);
        const key = mod?.identityId || mod?.id || (repo?.key
            ? `${repo.key}${mod.sharedRepository ? `/${normalizeKey(mod.name)}` : ''}` : normalizeKey(mod?.name));
        return `${String(key).toLowerCase()}${repo?.releaseTag ? `@${repo.key}/releases/tag/${encodeURIComponent(repo.releaseTag)}` : ''}${repo?.assetName ? `/${encodeURIComponent(repo.assetName)}` : ''}`;
    }

    function isBatchInstallEligible(mod, profiles = getLocalInstalledProfiles()) {
        if (mod?.isLanguageGroup) return mod.variants.some(member => isBatchInstallEligible(member, profiles));
        return Boolean(mod && mod.contentType !== 'spell' && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:[/?#]|$)/i.test(mod.githubUrl || '')
            && (mod.catalogSource !== 'community' || hasCommunityReleaseSource(mod))
            && !isWithdrawn(mod)
            && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod)
            && checkModInstallStatus(mod, profiles) === 'not_installed');
    }

    function getBatchSelectionState() {
        return { ...batchInstallState, selected: Array.from(batchInstallState.selected) };
    }

    // 分组只服务展示和明确选语言，安装、缓存与更新仍使用原成员。
    function getLanguageIdentityMembers(mod) {
        const variant = window.modHubMarketVariants?.normalizeVariant(mod?.variant);
        if (!variant) return [mod].filter(Boolean);
        const members = new Map(languageIdentityMembers);
        marketModList.forEach(member => members.set(member.identityId || member.id, member));
        return [...members.values()].filter(member => {
            const declared = window.modHubMarketVariants?.normalizeVariant(member.variant);
            return declared?.groupId === variant.groupId && declared.type === variant.type;
        });
    }

    function getDisplayMods(mods = marketModList) {
        return window.modHubMarketVariants?.groupMods(mods || []) || mods || [];
    }

    function getFilteredDisplayMods(filtered, profiles) {
        const positions = new Map(filtered.map((mod, index) => [getMarketModKey(mod), index]));
        const all = marketModList.map((mod, index) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: index };
        }).filter(isMarketSourceVisible);
        const members = entry => entry.isLanguageGroup ? entry.variants : [entry];
        const position = entry => Math.min(...members(entry).map(mod => positions.get(getMarketModKey(mod)) ?? Infinity));
        return getDisplayMods(all).filter(entry => position(entry) !== Infinity).sort((a, b) => position(a) - position(b));
    }

    function toggleBatchSelection(selecting = !batchInstallState.selecting) {
        if (currentMarketSection !== 'packages' || batchInstallState.running) return;
        batchInstallState.selecting = Boolean(selecting);
        if (!batchInstallState.selecting) batchInstallState.selected.clear();
        renderMarketCards();
    }

    function setBatchModSelected(key, checked) {
        if (currentMarketSection !== 'packages' || batchInstallState.running || !batchInstallState.selecting) return;
        const mod = getDisplayMods().find(item => getMarketModKey(item) === key);
        if (checked && isBatchInstallEligible(mod)) batchInstallState.selected.add(key);
        else batchInstallState.selected.delete(key);
        document.querySelectorAll('.modhub-market-select').forEach(input => {
            input.checked = batchInstallState.selected.has(input.dataset.modKey);
            input.closest?.('.modhub-market-card')?.classList.toggle('is-batch-selected', input.checked);
        });
        renderBatchInstallToolbar();
    }

    function selectAllVisibleMods() {
        if (currentMarketSection !== 'packages' || batchInstallState.running || !batchInstallState.selecting) return;
        const profiles = getLocalInstalledProfiles();
        getFilteredDisplayMods(filterAndSortMods(), profiles).filter(mod => isBatchInstallEligible(mod, profiles)).forEach(mod => batchInstallState.selected.add(getMarketModKey(mod)));
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
            const eligibleKeys = new Set(getDisplayMods().filter(mod => isBatchInstallEligible(mod, profiles)).map(getMarketModKey));
            for (const key of state.selected) if (!eligibleKeys.has(key)) state.selected.delete(key);
        }
        document.querySelectorAll('#modHubMarketBtnRefresh, #modHubMarketBtnSubmit, #modHubMarketBtnMy, #modHubMarketBtnFeedback, #modHubMirrorSelect, .btn-market-install, .btn-market-update, .btn-market-language-choice, .modhub-market-update-all, .modhub-market-select').forEach(control => {
            const mod = marketModList[Number(control.dataset?.modIndex)];
            control.disabled = state.running || Boolean(mod && activeDownloadControllers.has(mod.name))
                || marketInstallBusy && control.classList.contains('btn-market-language-choice');
        });
        const toolbar = document.getElementById('modHubMarketBatchToolbar');
        if (!toolbar) return;
        toolbar.hidden = currentMarketSection !== 'packages';
        const escapeHtml = window.modHubEscapeHtml || (value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));
        const focusedId = toolbar.contains?.(document.activeElement) ? document.activeElement?.id : '';
        toolbar.classList.toggle('is-active', state.selecting || state.running);
        toolbar.classList.toggle('is-entry', !state.selecting && !state.running);
        if (state.running) {
            toolbar.innerHTML = `
                <div class="modhub-batch-status" role="status" aria-live="polite">${window.modHubProgressRingHtml(state.progressPhase === 'installing' && state.total > 0 ? state.completed * 100 / state.total : null, '批量安装总进度')}<strong class="gold">批量安装 ${state.completed}/${state.total}</strong><span>${state.current ? `正在处理：${escapeHtml(state.current)}` : '正在准备安装计划'}</span></div>
                <button id="modHubBatchStop" type="button" class="macro-button modhub-btn-secondary" ${state.stopRequested ? 'disabled' : ''}>${state.stopRequested ? '当前项完成后停止' : '停止后续'}</button>`;
            const stopButton = document.getElementById('modHubBatchStop');
            if (stopButton) stopButton.onclick = () => { state.stopRequested = true; renderBatchInstallToolbar(); };
        } else {
            toolbar.innerHTML = `
                <button id="modHubBatchToggle" type="button" class="macro-button ${state.selecting ? 'modhub-btn-secondary' : 'modhub-btn-primary modhub-batch-entry'}" aria-pressed="${state.selecting}"${state.selecting ? '' : ' aria-describedby="modHubBatchEntryHint"'}>${state.selecting ? '退出多选' : '批量下载'}</button>
                ${state.selecting ? '' : '<span id="modHubBatchEntryHint" class="modhub-batch-entry-hint">勾选多个模组，统一下载并安装</span>'}
                ${state.selecting ? `<span class="modhub-batch-count grey" role="status" aria-live="polite">已选 ${state.selected.size} 项，仅选择未安装模组</span>
                <button id="modHubBatchSelectAll" type="button" class="macro-button modhub-btn-secondary">全选当前筛选</button>
                <button id="modHubBatchClear" type="button" class="macro-button modhub-btn-secondary" ${state.selected.size ? '' : 'disabled'}>清空选择</button>
                <button id="modHubBatchInstall" type="button" class="macro-button modhub-btn-primary" ${state.selected.size ? '' : 'disabled'}>下载并安装（${state.selected.size}）</button>` : ''}`;
            const handlers = { modHubBatchToggle: () => toggleBatchSelection(), modHubBatchSelectAll: selectAllVisibleMods, modHubBatchClear: clearBatchSelection, modHubBatchInstall: () => installSelectedMods() };
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

    // 新键优先，旧版偏好与离线缓存只读兼容；所有写入均使用 ModHub 键。
    function readStoredValue(key) {
        return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^modhub_/, 'dol_opt_'));
    }

    function readLocalCache(key, ttl, allowExpired = false) {
        try {
            const raw = readStoredValue(key);
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

    function safeHttpsUrl(value) {
        if (typeof value !== 'string') return null;
        try {
            const url = new URL(value.trim());
            return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
        } catch {
            return null;
        }
    }

    function marketExternalUrl(mod) {
        const candidates = mod?.catalogSource === 'community'
            ? [mod.sourceUrl, mod.otherUrl, mod.githubUrl]
            : [mod?.otherUrl, mod?.githubUrl];
        return candidates.map(safeHttpsUrl).find(Boolean) || null;
    }

    function sameGithubRepoOrSource(sourceA, sourceB) {
        if (!sourceA || !sourceB) return false;
        if (sourceUrlKey(sourceA) === sourceUrlKey(sourceB)) return true;
        const repoA = parseGithubRepo(sourceA);
        const repoB = parseGithubRepo(sourceB);
        return Boolean(repoA && repoB && repoA.key === repoB.key);
    }

    function hasCommunityReleaseSource(mod) {
        const githubUrl = safeHttpsUrl(mod?.githubUrl);
        const repo = parseGithubRepo(githubUrl);
        const repositoryKeys = Array.isArray(mod?.repositoryKeys) ? mod.repositoryKeys : [];
        return mod?.autoInstall === true && typeof mod.identityId === 'string' && !!mod.identityId.trim()
            && Array.isArray(mod.bootNames) && mod.bootNames.length > 0
            && !!repo && repositoryKeys.some(key => String(key).toLowerCase() === repo.key)
            && /^\/[^/]+\/[^/]+\/releases\/(?:latest|tag\/[^/]+|download\/[^/]+\/[^/]+)\/?$/.test(new URL(githubUrl).pathname)
            && (sameGithubRepoOrSource(mod.sourceUrl, githubUrl)
                || (Array.isArray(mod.sources) && mod.sources.some(source => source?.platform === 'github'
                    && sameGithubRepoOrSource(source.url, githubUrl))));
    }

    function sourceUrlKey(value) {
        const safe = safeHttpsUrl(value);
        if (!safe) return null;
        const url = new URL(safe);
        url.hash = '';
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.href;
    }

    const withdrawnIds = new Set();
    const withdrawnUrls = new Set();
    const withdrawnCatalogTargets = new Map();
    let withdrawnRevision = -1;
    function rememberCatalogTarget(target) {
        if (typeof target?.id === 'string' && target.id && typeof target.wikiName === 'string' && target.wikiName
            && typeof target.wikiAuthor === 'string') {
            withdrawnCatalogTargets.set(target.id.toLowerCase(), {
                id: target.id, wikiName: target.wikiName, wikiAuthor: target.wikiAuthor
            });
        }
    }
    try {
        const saved = JSON.parse(readStoredValue(MODHUB_WITHDRAWN_STORAGE_KEY) || '{}');
        if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) {
            withdrawnRevision = saved.revision;
            (Array.isArray(saved.ids) ? saved.ids : []).forEach(id => { if (typeof id === 'string') withdrawnIds.add(id.toLowerCase()); });
            (Array.isArray(saved.urls) ? saved.urls : []).forEach(url => { const key = sourceUrlKey(url); if (key) withdrawnUrls.add(key); });
            (Array.isArray(saved.catalogTargets) ? saved.catalogTargets : []).forEach(rememberCatalogTarget);
        }
    } catch (_) {}

    function rememberWithdrawals(index) {
        const revision = index.communityRevision === undefined ? 0 : index.communityRevision;
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('自动版本索引格式异常');
        if (index.withdrawnCatalogTargets !== undefined && !Array.isArray(index.withdrawnCatalogTargets)) throw new Error('自动版本索引格式异常');
        if (revision < withdrawnRevision || (revision === withdrawnRevision && index.withdrawnCatalogTargets === undefined)) return;
        if (revision > withdrawnRevision) {
            withdrawnIds.clear();
            withdrawnUrls.clear();
            const removed = (index.mods || []).filter(mod => mod?.status === 'withdrawn');
            [...(Array.isArray(index.withdrawnIds) ? index.withdrawnIds : []), ...removed.map(mod => mod.id)]
                .forEach(id => { if (typeof id === 'string' && id.trim()) withdrawnIds.add(id.trim().toLowerCase()); });
            (Array.isArray(index.withdrawnUrls) ? index.withdrawnUrls : [])
                .forEach(url => { const key = sourceUrlKey(url); if (key) withdrawnUrls.add(key); });
        }
        withdrawnCatalogTargets.clear();
        (index.withdrawnCatalogTargets || []).forEach(rememberCatalogTarget);
        withdrawnRevision = revision;
        try { localStorage.setItem(MODHUB_WITHDRAWN_STORAGE_KEY, JSON.stringify({ revision, ids: [...withdrawnIds],
            urls: [...withdrawnUrls], catalogTargets: [...withdrawnCatalogTargets.values()] })); } catch (_) {}
    }

    function catalogWithdrawalMatches(target, mod) {
        if ([mod.sourceUrl, mod.otherUrl, mod.githubUrl,
            ...(Array.isArray(mod.otherUrls) ? mod.otherUrls : []),
            ...(Array.isArray(mod.githubUrls) ? mod.githubUrls : [])].some(Boolean)) return false;
        const original = submissionTargetFields(mod);
        return target.wikiName === original.targetName && target.wikiAuthor === original.targetAuthor;
    }

    function isWithdrawn(mod) {
        if (!mod) return false;
        if (typeof mod.id === 'string') {
            const target = withdrawnCatalogTargets.get(mod.id.toLowerCase());
            if (target ? catalogWithdrawalMatches(target, mod) : withdrawnIds.has(mod.id.toLowerCase())) return true;
        } else if ([...withdrawnCatalogTargets.values()].some(target => catalogWithdrawalMatches(target, mod))) return true;
        if (mod.catalogSource === 'community' && mod.id) return false;
        return [mod.sourceUrl, mod.otherUrl, mod.githubUrl,
            ...(Array.isArray(mod.otherUrls) ? mod.otherUrls : []),
            ...(Array.isArray(mod.githubUrls) ? mod.githubUrls : [])]
            .some(url => withdrawnUrls.has(sourceUrlKey(url)));
    }

    function readSubmissionReceipts() {
        try {
            const saved = JSON.parse(localStorage.getItem(MODHUB_SUBMISSION_RECEIPTS_KEY) || '[]');
            return Array.isArray(saved) ? saved.filter(item => typeof item?.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item?.receipt || ''))
                .map(item => ({
                    id: item.id,
                    receipt: item.receipt,
                    name: typeof item.name === 'string' ? item.name.slice(0, 100) : '',
                    kind: ['add', 'correct', 'withdraw'].includes(item.kind) ? item.kind : '',
                    approvedKind: ['add', 'correct', 'withdraw', 'restore'].includes(item.approvedKind) ? item.approvedKind : '',
                    status: typeof item.status === 'string' ? item.status : '',
                    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
                    queriedAt: Number.isFinite(item.queriedAt) ? item.queriedAt : 0,
                    targetStatus: typeof item.targetStatus === 'string' ? item.targetStatus : '',
                    activeDelistStatus: typeof item.activeDelistStatus === 'string' ? item.activeDelistStatus : '',
                    canRequestDelist: item.canRequestDelist === true
                })) : [];
        } catch {
            return [];
        }
    }

    function saveSubmissionReceipt(id, receipt, row = {}) {
        const previous = readSubmissionReceipts().find(item => item.id === id || item.receipt === receipt) || {};
        const records = readSubmissionReceipts().filter(item => item.id !== id && item.receipt !== receipt);
        records.unshift({
            ...previous,
            id,
            receipt,
            name: typeof row.name === 'string' ? row.name.slice(0, 100) : previous.name || '',
            kind: ['add', 'correct', 'withdraw'].includes(row.kind) ? row.kind : previous.kind || '',
            approvedKind: ['add', 'correct', 'withdraw', 'restore'].includes(row.approvedKind) ? row.approvedKind
                : row.approvedKind === null ? '' : previous.approvedKind || '',
            status: typeof row.status === 'string' ? row.status : previous.status || '',
            updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : previous.updatedAt || '',
            queriedAt: Date.now(),
            targetStatus: row.targetStatus === null ? ''
                : typeof row.targetStatus === 'string' ? row.targetStatus : previous.targetStatus || '',
            activeDelistStatus: row.activeDelistStatus === null ? ''
                : typeof row.activeDelistStatus === 'string' ? row.activeDelistStatus : previous.activeDelistStatus || '',
            canRequestDelist: typeof row.canRequestDelist === 'boolean' ? row.canRequestDelist : previous.canRequestDelist === true
        });
        try {
            localStorage.setItem(MODHUB_SUBMISSION_RECEIPTS_KEY, JSON.stringify(records));
            return true;
        } catch {
            return false;
        }
    }

    function clearPendingSubmissionDraft(receipt) {
        try {
            const drafts = JSON.parse(localStorage.getItem(MODHUB_SUBMISSION_DRAFTS_KEY) || '{}');
            let changed = false;
            for (const [key, draft] of Object.entries(drafts)) {
                if (draft?.pending?.receipt === receipt) {
                    delete drafts[key];
                    changed = true;
                }
            }
            if (changed) localStorage.setItem(MODHUB_SUBMISSION_DRAFTS_KEY, JSON.stringify(drafts));
            return true;
        } catch {
            return false;
        }
    }

    function forgetSubmissionReceipt(receipt) {
        try {
            localStorage.setItem(MODHUB_SUBMISSION_RECEIPTS_KEY,
                JSON.stringify(readSubmissionReceipts().filter(item => item.receipt !== receipt)));
            return clearPendingSubmissionDraft(receipt);
        } catch {
            return false;
        }
    }

    function readSubmissionDraft(key) {
        try {
            return JSON.parse(localStorage.getItem(MODHUB_SUBMISSION_DRAFTS_KEY) || '{}')[key] || null;
        } catch {
            return null;
        }
    }

    function saveSubmissionDraft(key, draft) {
        try {
            const drafts = JSON.parse(localStorage.getItem(MODHUB_SUBMISSION_DRAFTS_KEY) || '{}');
            if (!draft || Object.values(draft).every(value => !value)) delete drafts[key];
            else drafts[key] = draft;
            localStorage.setItem(MODHUB_SUBMISSION_DRAFTS_KEY, JSON.stringify(drafts));
            return true;
        } catch {
            return false;
        }
    }

    function submissionNonce() {
        if (!window.crypto?.getRandomValues) return null;
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function submissionReceipt() {
        if (!window.crypto?.getRandomValues || typeof window.btoa !== 'function') return null;
        const bytes = window.crypto.getRandomValues(new Uint8Array(32));
        return window.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    async function communitySubmissionRequest(path, payload) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
        try {
            const response = await fetch(new URL(path, RELEASE_WORKER_API_BASE).href, {
                method: 'POST', cache: 'no-store', credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), ...(controller ? { signal: controller.signal } : {})
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`);
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('请求超时，请检查投稿进度后重试');
            throw error;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    function submissionTargetFields(mod) {
        const target = mod?.catalogTarget || mod || {};
        const targetName = Object.prototype.hasOwnProperty.call(mod || {}, 'targetName') ? mod.targetName
            : Object.prototype.hasOwnProperty.call(target, 'wikiName') ? target.wikiName : target.name;
        const targetAuthor = Object.prototype.hasOwnProperty.call(mod || {}, 'targetAuthor') ? mod.targetAuthor
            : Object.prototype.hasOwnProperty.call(target, 'wikiAuthor') ? target.wikiAuthor : target.author;
        return {
            targetName: String(targetName ?? ''),
            targetAuthor: String(targetAuthor ?? '')
        };
    }

    async function openCommunityFeedback() {
        if (batchInstallState.running || typeof window.modHubConfirm !== 'function') return false;
        const mode = await window.modHubConfirm({
            title: '纠错与下架申请', message: '请选择申请类型。', confirmText: '选择模组', cancelText: '取消',
            selectLabel: '申请类型', selectOptions: [
                { value: 'correct', label: '资料纠错' }, { value: 'withdraw', label: '申请下架' }
            ]
        });
        if (!['correct', 'withdraw'].includes(mode) || batchInstallState.running) return false;
        const targets = marketModList.filter(mod => !isWithdrawn(mod));
        if (!targets.length) {
            await window.modHubAlert?.('当前没有可选择的模组，请刷新市场后再试。');
            return false;
        }
        const labels = targets.map(mod => {
            const source = marketExternalUrl(mod) || '来源未标注';
            return `${mod.name || '未命名模组'} · 作者: ${mod.author || '未标注'} · 来源: ${source}`;
        });
        const selected = await window.modHubConfirm({
            title: mode === 'correct' ? '选择纠错模组' : '选择下架模组',
            dialogClass: 'modhub-market-feedback-dialog',
            trustedMessageHtml: '<label class="modhub-feedback-search-label">搜索完整目录<input class="modhub-feedback-search" type="search" autocomplete="off" placeholder="模组名称、作者或来源"></label>',
            selectLabel: '目标模组', selectValue: '', requireSelection: true,
            selectOptions: [{ value: '', label: '请选择目标模组', disabled: true },
                ...labels.map((label, index) => ({ value: String(index), label }))],
            confirmText: '填写申请', cancelText: '取消',
            onRender(dialog) {
                const search = dialog.querySelector('.modhub-feedback-search');
                const select = dialog.querySelector('.modhub-modal-select');
                const confirm = dialog.querySelector('.modhub-modal-btn-confirm');
                select.size = Math.min(targets.length + 1, 6);
                search.focus?.();
                search.oninput = () => {
                    const term = search.value.trim().toLowerCase();
                    select.replaceChildren();
                    const placeholder = document.createElement('option');
                    placeholder.value = '';
                    placeholder.textContent = '请选择目标模组';
                    placeholder.disabled = true;
                    select.appendChild(placeholder);
                    labels.forEach((label, index) => {
                        if (!label.toLowerCase().includes(term)) return;
                        const option = document.createElement('option');
                        option.value = String(index);
                        option.textContent = label;
                        select.appendChild(option);
                    });
                    select.value = '';
                    confirm.disabled = true;
                };
            }
        });
        if (!/^\d+$/.test(selected) || batchInstallState.running) return false;
        const target = targets[Number(selected)];
        if (target && mode === 'withdraw') {
            try {
                const targetState = await communitySubmissionRequest('/community-submissions/target-status', {
                    catalogId: String(target.id || '').slice(0, 100),
                    sourceUrl: marketExternalUrl(target) || '', ...submissionTargetFields(target)
                });
                Object.assign(target, targetState);
                if (targetState.canRequestDelist !== true) {
                    const message = targetState.activeDelistStatus ? '该模组已有进行中的下架申请，请等待审核结果。'
                        : targetState.targetStatus === 'withdrawn' ? '该模组已下架，无需重复申请。'
                            : targetState.targetStatus === 'missing' ? '当前目录中未找到该模组，请刷新市场后再试。'
                                : '暂时无法确认该模组的在架状态，请稍后重试。';
                    await window.modHubAlert?.(message);
                    return false;
                }
            } catch (error) {
                await window.modHubAlert?.(error.message || '无法确认模组状态，请稍后重试。');
                return false;
            }
        }
        return target ? openCommunitySubmission(mode, target) : false;
    }

    async function openCommunitySubmission(mode = 'new', mod = null, knownReceipt = '') {
        if (typeof window.modHubConfirm !== 'function' || !['new', 'my', 'correct', 'withdraw', 'amend'].includes(mode)) return false;
        const isMine = mode === 'my';
        const isAmend = mode === 'amend';
        const isWithdrawForm = mode === 'withdraw';
        const sourceLocked = isAmend && (mod?.kind !== 'add' || mod?.approvedCatalogId);
        const catalogId = String(isAmend ? (mod?.catalogId || '') : (mod?.id || '')).slice(0, 100);
        const isCatalogFeedback = Boolean(catalogId) && (['correct', 'withdraw'].includes(mode)
            || (isAmend && ['correct', 'withdraw'].includes(mod?.kind)));
        const sourceUrl = safeHttpsUrl(mod?.sourceUrl || mod?.otherUrl || mod?.githubUrl) || '';
        const draftKey = `${mode}:${isAmend ? mod?.id || '' : catalogId || sourceUrl}`;
        const draft = readSubmissionDraft(draftKey);
        const titles = { new: '推荐模组', my: '我的投稿', correct: '纠错', withdraw: '申请下架', amend: '补充投稿资料' };
        const escapeHtml = window.modHubEscapeHtml || (value => String(value ?? '').replace(/[&<>"']/g,
            char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));
        const formFieldsHtml = isWithdrawForm ? `
            <div class="modhub-community-target">
                <strong>${escapeHtml(mod?.name || '未命名模组')}</strong>
                <span class="grey">作者：${escapeHtml(mod?.author || '未标注')}</span>
                <span class="grey">目录条目：${escapeHtml(catalogId)}</span>
                <span class="grey">来源：${escapeHtml(sourceUrl || '暂无来源链接，按目录条目核对')}</span>
            </div>
            <input name="name" type="hidden" maxlength="100"><input name="author" type="hidden" maxlength="100">
            <input name="sourceUrl" type="hidden" maxlength="1000"><textarea name="description" hidden maxlength="1000"></textarea>
            <label>下架原因<textarea name="notes" maxlength="1000" required></textarea></label>` : `
            <label>模组名称<input name="name" maxlength="100" required></label>
            <label>作者<input name="author" maxlength="100"></label>
            <label>${isCatalogFeedback ? '当前目录来源（未标注时留空）' : '来源链接'}<input name="sourceUrl" type="url" maxlength="1000" inputmode="url" ${isCatalogFeedback ? 'readonly' : 'required'}></label>
            ${isCatalogFeedback ? `<p class="grey">申请绑定目录条目 ${escapeHtml(catalogId)}；没有来源链接也可提交。新增来源链接请填写在补充说明中，供审核人员核验。</p>` : ''}
            <label>简介<textarea name="description" maxlength="1000"></textarea></label>
            <label>补充说明或申请原因<textarea name="notes" maxlength="1000"></textarea></label>`;
        const formHtml = `<form class="modhub-community-form" novalidate>
            <div class="modhub-community-fields">
            ${formFieldsHtml}
            <div class="modhub-community-result" hidden><strong class="modhub-community-result-title">投稿已提交</strong><p>查询凭证已保存在本机；换设备或清除本机数据前，请另行备份。</p><button type="button" class="macro-button modhub-btn-sub modhub-community-copy">复制凭证</button><details><summary>查看完整查询凭证</summary><code class="modhub-community-receipt" tabindex="-1"></code></details></div>
            </div>
            <div class="modhub-community-safety">
                <div class="modhub-community-challenge-wrap"><iframe class="modhub-community-challenge" title="安全验证" sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer"></iframe></div>
                <p class="modhub-community-status grey" role="status" aria-live="polite">请完成安全验证。</p>
                <div class="modhub-community-actions"><button type="submit" class="macro-button modhub-btn-primary modhub-community-submit" disabled>${isAmend ? '提交补充资料' : mode === 'withdraw' ? '提交下架申请' : '提交审核'}</button></div>
            </div>
        </form>`;
        const mineHtml = `<div class="modhub-community-my">
            <div class="modhub-community-list-tools">
                <label>搜索投稿<input class="modhub-community-search" type="search" autocomplete="off" placeholder="模组名称"></label>
                <label>状态<select class="modhub-community-filter"><option value="">全部状态</option><option value="pending_confirmation">待确认</option><option value="pending">待审核</option><option value="needs_info">待补充</option><option value="manual_check">待人工核验</option><option value="approved">已通过</option><option value="rejected">未通过</option><option value="withdrawn">已撤回或已下架</option></select></label>
            </div>
            <div class="modhub-community-list-actions"><button type="button" class="macro-button modhub-btn-sub modhub-community-refresh-page">刷新本页</button></div>
            <div class="modhub-community-saved" role="list"></div>
            <div class="modhub-community-pager"><button type="button" class="macro-button modhub-btn-sub modhub-community-prev">上一页</button><span class="modhub-community-page grey"></span><button type="button" class="macro-button modhub-btn-sub modhub-community-next">下一页</button></div>
            <details class="modhub-community-backup"><summary>备份与恢复</summary><p class="grey">换设备或清除本机数据后，可输入查询凭证恢复投稿。</p><label>查询凭证<input class="modhub-community-query-input" maxlength="43" autocomplete="off" spellcheck="false"></label><div class="modhub-community-actions"><button type="button" class="macro-button modhub-btn-primary modhub-community-query">查询并保存</button></div></details>
            <div class="modhub-community-detail"></div>
        </div>`;
        let dialog = null;
        let frame = null;
        let nonce = null;
        let challengeToken = '';
        let closed = false;
        let submitting = false;
        let succeeded = false;
        const onMessage = event => {
            if (event.origin !== new URL(RELEASE_WORKER_API_BASE).origin || !frame || event.source !== frame.contentWindow) return;
            const data = event.data;
            if (data?.type !== 'modHubCommunityChallenge' || data.nonce !== nonce || submitting || succeeded) return;
            const status = dialog?.querySelector('.modhub-community-status');
            const submit = dialog?.querySelector('.modhub-community-submit');
            if (data.token === null) {
                challengeToken = '';
                if (submit) submit.disabled = true;
                if (status) status.textContent = '安全验证已过期，请重新完成。';
                return;
            }
            if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) return;
            challengeToken = data.token;
            if (submit) submit.disabled = false;
            if (status) status.textContent = '安全验证已完成，可以提交。';
        };
        if (!isMine) window.addEventListener('message', onMessage);
        try {
            return await window.modHubConfirm({
                title: titles[mode], confirmText: '关闭', cancelText: '', dialogClass: `modhub-community-dialog ${isMine ? 'is-query' : 'is-form'}`,
                trustedMessageHtml: isMine ? `${mineHtml}<p class="modhub-community-status grey" role="status" aria-live="polite"></p>` : formHtml,
                onRender(currentDialog) {
                    dialog = currentDialog;
                    dialog.addEventListener('keydown', event => {
                        if (event.key === 'Enter' && event.target.closest?.('.modhub-community-form, .modhub-community-my')) {
                            event.stopPropagation();
                        }
                    }, true);
                    const status = dialog.querySelector('.modhub-community-status');
                    const tell = message => { if (status) status.textContent = message; };
                    if (isMine) {
                        const input = dialog.querySelector('.modhub-community-query-input');
                        const button = dialog.querySelector('.modhub-community-query');
                        const detail = dialog.querySelector('.modhub-community-detail');
                        const saved = dialog.querySelector('.modhub-community-saved');
                        const search = dialog.querySelector('.modhub-community-search');
                        const filter = dialog.querySelector('.modhub-community-filter');
                        const refreshPage = dialog.querySelector('.modhub-community-refresh-page');
                        const previousPage = dialog.querySelector('.modhub-community-prev');
                        const nextPage = dialog.querySelector('.modhub-community-next');
                        const pageLabel = dialog.querySelector('.modhub-community-page');
                        let operationBusy = false;
                        let currentPage = 1;
                        let selectedReceipt = '';
                        const statusLabels = { pending_confirmation: '待确认', pending: '待审核', needs_info: '待补充',
                            manual_check: '待人工核验', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
                        const kindLabels = { add: '推荐模组', correct: '资料纠错', withdraw: '申请下架' };
                        const submissionStatusLabel = row => row.status === 'approved' && row.approvedKind === 'restore' ? '恢复上架已通过'
                            : row.status === 'approved' && (row.approvedKind || row.kind) === 'withdraw' ? '下架申请已通过'
                            : row.status === 'approved' && row.targetStatus === 'withdrawn' ? '模组已下架'
                                : statusLabels[row.status] || '状态未知';
                        const readRecords = () => {
                            const records = readSubmissionReceipts();
                            try {
                                const drafts = JSON.parse(localStorage.getItem(MODHUB_SUBMISSION_DRAFTS_KEY) || '{}');
                                Object.values(drafts).forEach(item => {
                                    const receipt = item?.pending?.receipt;
                                    const payload = item?.pending?.payload || {};
                                    if (/^[A-Za-z0-9_-]{43}$/.test(receipt || '') && !records.some(savedItem => savedItem.receipt === receipt)) {
                                        records.push({ id: '待确认的投稿', receipt, name: payload.name || item?.fields?.name || '',
                                            kind: payload.kind || '', status: 'pending_confirmation', updatedAt: '', queriedAt: 0,
                                            targetStatus: '', activeDelistStatus: '', canRequestDelist: false });
                                    }
                                });
                            } catch (_) {}
                            return records;
                        };
                        let records = readRecords();
                        const formatRecordTime = record => {
                            const time = Number(record.queriedAt);
                            return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString('zh-CN', {
                                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                            }) : '尚未查询';
                        };
                        const filteredRecords = () => {
                            const term = search.value.trim().toLowerCase();
                            return records.filter(record => (!term || (record.name || '').toLowerCase().includes(term))
                                && (!filter.value || record.status === filter.value
                                    || (filter.value === 'withdrawn' && record.targetStatus === 'withdrawn')));
                        };
                        const pageRecords = () => filteredRecords().slice((currentPage - 1) * MODHUB_SUBMISSION_PAGE_SIZE,
                            currentPage * MODHUB_SUBMISSION_PAGE_SIZE);
                        const renderSavedRecords = () => {
                            saved.replaceChildren();
                            const filtered = filteredRecords();
                            const pages = Math.max(1, Math.ceil(filtered.length / MODHUB_SUBMISSION_PAGE_SIZE));
                            currentPage = Math.min(currentPage, pages);
                            const visible = pageRecords();
                            if (!visible.length) {
                                const empty = document.createElement('p');
                                empty.className = 'grey modhub-community-empty';
                                empty.textContent = records.length ? '没有符合筛选条件的投稿。' : '本机尚未保存投稿，可在下方用查询凭证恢复。';
                                saved.appendChild(empty);
                            }
                            visible.forEach(record => {
                                const card = document.createElement('div');
                                card.className = `modhub-community-record${record.receipt === selectedReceipt ? ' is-selected' : ''}`;
                                card.setAttribute('role', 'listitem');
                                const open = document.createElement('button');
                                open.type = 'button';
                                open.className = 'modhub-community-record-open';
                                const title = document.createElement('strong');
                                title.textContent = record.name || '未命名投稿';
                                const meta = document.createElement('span');
                                meta.className = 'grey';
                                meta.textContent = `${kindLabels[record.kind] || '投稿'} · ${submissionStatusLabel(record)} · 上次查询 ${formatRecordTime(record)}`;
                                open.appendChild(title);
                                open.appendChild(meta);
                                open.onclick = () => querySubmission(record.receipt);
                                card.appendChild(open);
                                saved.appendChild(card);
                            });
                            pageLabel.textContent = `${currentPage} / ${pages}，共 ${filtered.length} 条`;
                            previousPage.disabled = currentPage <= 1 || operationBusy;
                            nextPage.disabled = currentPage >= pages || operationBusy;
                            refreshPage.disabled = operationBusy || !visible.length;
                        };
                        const runAction = async (row, receipt, action) => {
                            if (closed || operationBusy || button.disabled) return;
                            operationBusy = true;
                            button.disabled = true;
                            input.disabled = true;
                            renderSavedRecords();
                            const deleting = action === 'delete';
                            const title = deleting ? row.kind === 'add' ? '删除推荐' : '删除投稿' : '撤回投稿';
                            try {
                                const confirmed = await window.modHubConfirm({
                                    title, message: deleting
                                        ? `确定删除「${row.name || '投稿'}」？删除后无法再用查询凭证查看。`
                                        : `确定撤回「${row.name || '投稿'}」？撤回后将停止审核。`,
                                    confirmText: deleting ? '确认删除' : '确认撤回', cancelText: '取消', confirmType: 'danger'
                                });
                                if (!confirmed || closed) return;
                                tell(deleting ? '正在删除投稿…' : '正在撤回投稿…');
                                const updated = await communitySubmissionRequest(`/community-submissions/${action}`, { receipt, revision: row.revision });
                                if (deleting) {
                                    const forgotten = forgetSubmissionReceipt(receipt);
                                    if (closed) return;
                                    records = readRecords();
                                    selectedReceipt = '';
                                    input.value = '';
                                    detail.replaceChildren();
                                    tell(forgotten ? '投稿已删除。' : '投稿已删除，但本机凭证清理失败。');
                                } else {
                                    if (closed) return;
                                    const current = { ...row, ...updated, status: 'withdrawn' };
                                    saveSubmissionReceipt(current.id, receipt, current);
                                    records = readRecords();
                                    renderSubmissionDetail(current, receipt);
                                    tell('投稿已撤回。');
                                }
                            } catch (error) {
                                if (!closed) {
                                    const actionError = error.message || '操作结果未确认';
                                    tell(`${actionError}。正在刷新当前状态…`);
                                    try {
                                        const latest = await communitySubmissionRequest('/community-submissions/query', { receipt });
                                        if (!closed && typeof latest.id === 'string' && latest.id) {
                                            saveSubmissionReceipt(latest.id, receipt, latest);
                                            records = readRecords();
                                            renderSubmissionDetail(latest, receipt);
                                            tell(`${actionError}。已刷新当前状态。`);
                                        }
                                    } catch (_) {
                                        if (!closed) {
                                            detail.replaceChildren();
                                            tell(`${actionError}。请重新查询进度。`);
                                        }
                                    }
                                }
                            } finally {
                                operationBusy = false;
                                button.disabled = false;
                                input.disabled = false;
                                renderSavedRecords();
                            }
                        };
                        const renderSubmissionDetail = (row, receipt) => {
                            detail.replaceChildren();
                            const summary = document.createElement('p');
                            summary.textContent = `${row.name || '投稿'}：${submissionStatusLabel(row)}`;
                            detail.appendChild(summary);
                            const meta = document.createElement('p');
                            meta.className = 'grey';
                            meta.textContent = `${kindLabels[row.kind] || '投稿'} · 查询于 ${formatRecordTime({ queriedAt: Date.now() })}`;
                            detail.appendChild(meta);
                            if (row.reviewerNote) {
                                const note = document.createElement('p');
                                note.textContent = `审核说明：${row.reviewerNote}`;
                                detail.appendChild(note);
                            }
                            if (row.duplicateOf && row.mergedProgress) {
                                const merged = document.createElement('p');
                                merged.textContent = `此申请已归并到较早的申请，当前进度：${statusLabels[row.mergedProgress.status] || '处理中'}`;
                                detail.appendChild(merged);
                            }
                            const addAction = (label, handler, danger = false) => {
                                const actionButton = document.createElement('button');
                                actionButton.type = 'button';
                                actionButton.className = `macro-button ${danger ? 'modhub-btn-danger' : 'modhub-btn-sub'}`;
                                actionButton.textContent = label;
                                actionButton.onclick = handler;
                                detail.appendChild(actionButton);
                            };
                            if (!row.duplicateOf && ['pending', 'needs_info', 'manual_check'].includes(row.status)) {
                                addAction('补充资料', () => { if (!operationBusy) openCommunitySubmission('amend', row, receipt); });
                                if (!row.approvedCatalogId) addAction('撤回投稿', () => runAction(row, receipt, 'withdraw'), true);
                            }
                            if (!row.duplicateOf && !row.approvedCatalogId && row.status !== 'approved') {
                                addAction(row.kind === 'add' ? '删除推荐' : '删除投稿', () => runAction(row, receipt, 'delete'), true);
                            }
                            if (!row.duplicateOf && row.approvedCatalogId) {
                                const target = document.createElement('p');
                                if (row.targetStatus === 'withdrawn') target.textContent = '当前目录状态：模组已下架';
                                else if (row.targetStatus === 'missing') target.textContent = '当前目录状态：未找到对应模组';
                                else if (row.activeDelistStatus) target.textContent = `下架申请：${statusLabels[row.activeDelistStatus] || '处理中'}`;
                                else if (row.targetStatus === 'active') target.textContent = '当前目录状态：仍在架';
                                else target.textContent = '当前目录状态尚未确认，请稍后重新查询。';
                                detail.appendChild(target);
                                if (row.canRequestDelist === true) {
                                    addAction('申请下架', () => {
                                        if (!operationBusy) openCommunitySubmission('withdraw', {
                                            ...row, id: row.approvedCatalogId, notes: ''
                                        });
                                    });
                                }
                            }
                        };
                        const renderMissingRecord = (record, receipt, message) => {
                            detail.replaceChildren();
                            const explanation = document.createElement('p');
                            explanation.textContent = `${record?.name || '这条投稿'}：${message || '服务端已找不到该记录。'}`;
                            detail.appendChild(explanation);
                            const remove = document.createElement('button');
                            remove.type = 'button';
                            remove.className = 'macro-button modhub-btn-danger';
                            remove.textContent = '从本机移除';
                            remove.onclick = async () => {
                                const confirmed = await window.modHubConfirm({ title: '移除本机记录',
                                    message: `确定从本机移除「${record?.name || '这条投稿'}」？此操作不会更改服务端数据。`,
                                    confirmText: '确认移除', cancelText: '取消', confirmType: 'danger' });
                                if (!confirmed || closed) return;
                                forgetSubmissionReceipt(receipt);
                                records = readRecords();
                                selectedReceipt = '';
                                detail.replaceChildren();
                                renderSavedRecords();
                                tell('已从本机移除记录。');
                            };
                            detail.appendChild(remove);
                        };
                        const querySubmission = async receipt => {
                            if (operationBusy || button.disabled) return;
                            if (!/^[A-Za-z0-9_-]{43}$/.test(receipt)) { tell('请输入完整的查询凭证。'); return; }
                            operationBusy = true;
                            button.disabled = true;
                            input.disabled = true;
                            detail.replaceChildren();
                            tell('正在查询投稿…');
                            try {
                                const row = await communitySubmissionRequest('/community-submissions/query', { receipt });
                                if (closed) return;
                                if (typeof row.id !== 'string' || !row.id) throw new Error('服务响应缺少投稿编号');
                                const savedLocally = saveSubmissionReceipt(row.id, receipt, row);
                                if (savedLocally) clearPendingSubmissionDraft(receipt);
                                records = readRecords();
                                selectedReceipt = receipt;
                                renderSubmissionDetail(row, receipt);
                                tell(savedLocally ? '查询成功，已保存到本机。' : '查询成功，但本机保存失败，请保留查询凭证。');
                            } catch (error) {
                                if (!closed) {
                                    if ([404, 410].includes(error.status)) {
                                        renderMissingRecord(records.find(record => record.receipt === receipt), receipt, error.message);
                                    }
                                    tell(error.message || '查询失败。');
                                }
                            } finally {
                                operationBusy = false;
                                button.disabled = false;
                                input.disabled = false;
                                renderSavedRecords();
                            }
                        };
                        button.onclick = () => querySubmission(input.value.trim());
                        refreshPage.onclick = async () => {
                            if (operationBusy || refreshPage.disabled) return;
                            const visible = pageRecords();
                            if (!visible.length) return;
                            operationBusy = true;
                            button.disabled = true;
                            input.disabled = true;
                            renderSavedRecords();
                            tell(`正在刷新本页 ${visible.length} 条投稿…`);
                            try {
                                const data = await communitySubmissionRequest('/community-submissions/query-batch', {
                                    receipts: visible.map(record => record.receipt)
                                });
                                const results = Array.isArray(data.results) ? data.results : [];
                                let refreshed = 0;
                                results.forEach((result, fallbackIndex) => {
                                    const index = Number.isInteger(result?.index) ? result.index : fallbackIndex;
                                    const record = visible[index];
                                    if (!record || !result?.submission?.id) return;
                                    if (saveSubmissionReceipt(result.submission.id, record.receipt, result.submission)) {
                                        clearPendingSubmissionDraft(record.receipt);
                                        refreshed++;
                                    }
                                    if (selectedReceipt === record.receipt) renderSubmissionDetail(result.submission, record.receipt);
                                });
                                records = readRecords();
                                tell(`本页已更新 ${refreshed} 条${refreshed < visible.length ? `，${visible.length - refreshed} 条未能更新` : ''}。`);
                            } catch (error) {
                                if (!closed) tell(error.message || '刷新本页失败。');
                            } finally {
                                operationBusy = false;
                                button.disabled = false;
                                input.disabled = false;
                                renderSavedRecords();
                            }
                        };
                        search.oninput = () => { currentPage = 1; renderSavedRecords(); };
                        filter.onchange = () => { currentPage = 1; renderSavedRecords(); };
                        previousPage.onclick = () => { if (currentPage > 1 && !operationBusy) { currentPage--; renderSavedRecords(); } };
                        nextPage.onclick = () => {
                            const pages = Math.max(1, Math.ceil(filteredRecords().length / MODHUB_SUBMISSION_PAGE_SIZE));
                            if (currentPage < pages && !operationBusy) { currentPage++; renderSavedRecords(); }
                        };
                        renderSavedRecords();
                        return;
                    }

                    dialog.querySelector('.modhub-community-actions').appendChild(dialog.querySelector('.modhub-modal-btn-confirm'));
                    dialog.querySelector('.modhub-modal-footer').remove();

                    const form = dialog.querySelector('.modhub-community-form');
                    const fields = ['name', 'author', 'sourceUrl', 'description', 'notes'];
                    const input = Object.fromEntries(fields.map(name => [name, form.elements.namedItem(name)]));
                    const values = () => Object.fromEntries(fields.map(name => [name, input[name].value.trim()]));
                    let pending = /^[A-Za-z0-9_-]{43}$/.test(draft?.pending?.receipt || '') && draft?.pending?.payload
                        ? draft.pending : null;
                    const storedInitial = pending?.payload || draft?.fields || {
                        name: mod?.name || '', author: mod?.author || '', sourceUrl,
                        description: mod?.description || '', notes: mod?.notes || ''
                    };
                    const initial = isWithdrawForm && !pending ? {
                        name: mod?.name || '', author: mod?.author || '', sourceUrl,
                        description: mod?.description || '', notes: storedInitial.notes || ''
                    } : storedInitial;
                    fields.forEach(name => { input[name].value = String(initial[name] || '').slice(0, input[name].maxLength); });
                    if ((sourceLocked || isCatalogFeedback) && !pending) input.sourceUrl.value = sourceUrl;
                    const submit = dialog.querySelector('.modhub-community-submit');
                    const result = dialog.querySelector('.modhub-community-result');
                    const resultTitle = dialog.querySelector('.modhub-community-result-title');
                    const resultReceipt = dialog.querySelector('.modhub-community-receipt');
                    frame = dialog.querySelector('.modhub-community-challenge');
                    const lockFields = locked => fields.forEach(name => {
                        input[name].disabled = locked || (isWithdrawForm && name !== 'notes')
                            || ((sourceLocked || isCatalogFeedback) && name === 'sourceUrl');
                    });
                    lockFields(false);
                    const refreshChallenge = (message = '') => {
                        challengeToken = '';
                        submit.disabled = true;
                        nonce = submissionNonce();
                        if (!nonce) { tell('当前浏览器无法完成安全验证。'); return; }
                        const challenge = new URL('/community-challenge', RELEASE_WORKER_API_BASE);
                        challenge.searchParams.set('nonce', nonce);
                        challenge.searchParams.set('embedded', '1');
                        const width = frame.clientWidth || (dialog.clientWidth && dialog.clientWidth - 24)
                            || (window.innerWidth && window.innerWidth - 48) || 440;
                        frame.dataset.size = width < 300 ? 'compact' : 'normal';
                        if (width < 300) {
                            challenge.searchParams.set('size', 'compact');
                        }
                        frame.src = challenge.href;
                        tell(message || '请完成安全验证。');
                    };
                    if (pending) {
                        lockFields(true);
                        submit.textContent = '重试提交';
                    }
                    fields.forEach(name => input[name].addEventListener('input', () => {
                        if (!pending && !saveSubmissionDraft(draftKey, { fields: values() })) {
                            tell('本机无法保存草稿，请先复制填写内容。');
                        }
                    }));
                    const copyButton = dialog.querySelector('.modhub-community-copy');
                    copyButton.onclick = async () => {
                        try { await navigator.clipboard.writeText(resultReceipt.textContent); tell('查询凭证已复制。'); }
                        catch {
                            const selection = window.getSelection();
                            const range = document.createRange();
                            range.selectNodeContents(resultReceipt);
                            selection.removeAllRanges(); selection.addRange(range);
                            tell('复制失败，已选中凭证，请使用设备的复制操作。');
                        }
                    };
                    form.onsubmit = async event => {
                        event.preventDefault();
                        if (submit.disabled || submitting || succeeded) return;
                        if (!challengeToken) { tell('请先完成安全验证。'); return; }
                        const current = values();
                        const kind = isAmend ? mod.kind : mode;
                        if ((!current.sourceUrl && !isCatalogFeedback) || (current.sourceUrl && !safeHttpsUrl(current.sourceUrl))) {
                            tell(isCatalogFeedback ? '来源链接如有填写，须是有效的 HTTPS 链接。' : '推荐模组须填写有效的 HTTPS 来源链接。'); return;
                        }
                        if (!current.name || (kind !== 'withdraw' && (!current.author || !current.description))
                            || (kind === 'withdraw' && !current.notes)) {
                            tell(kind === 'withdraw' ? '请填写下架原因。' : '请填写模组名称、作者和简介。'); return;
                        }
                        if (!pending) {
                            const receipt = isAmend ? knownReceipt : submissionReceipt();
                            if (!/^[A-Za-z0-9_-]{43}$/.test(receipt || '')) { tell('无法生成安全查询凭证。'); return; }
                            const payload = { ...current, receipt, catalogId,
                                kind: isAmend ? mod.kind : mode === 'new' ? 'add' : mode,
                                ...(isCatalogFeedback && !isAmend ? submissionTargetFields(mod) : {}),
                                ...(isAmend ? { revision: mod.revision } : {}) };
                            pending = { receipt, payload };
                            if (!saveSubmissionDraft(draftKey, { fields: current, pending })) {
                                pending = null;
                                tell('本机无法保存查询凭证，为避免丢失投稿结果，已停止提交。');
                                return;
                            }
                            lockFields(true);
                        }
                        submit.disabled = true;
                        submitting = true;
                        tell('正在提交审核...');
                        const token = challengeToken;
                        challengeToken = '';
                        let retryMessage = '请完成新的安全验证后重试。';
                        try {
                            const endpoint = isAmend ? '/community-submissions/amend' : '/community-submissions';
                            let row;
                            try {
                                row = await communitySubmissionRequest(endpoint, { ...pending.payload, turnstileToken: token });
                            } catch (error) {
                                if (!isAmend || error.status !== 409) throw error;
                                const latest = await communitySubmissionRequest('/community-submissions/query', { receipt: pending.receipt });
                                if (latest.revision <= pending.payload.revision || !fields.every(name => latest[name] === pending.payload[name])) throw error;
                                row = latest;
                            }
                            if (typeof row.id !== 'string' || !row.id) throw new Error('服务响应缺少投稿编号');
                            const saved = saveSubmissionReceipt(row.id, pending.receipt, { ...pending.payload, ...row });
                            if (saved) saveSubmissionDraft(draftKey, null);
                            resultReceipt.textContent = pending.receipt;
                            resultTitle.textContent = saved ? '投稿已保存到本机' : '本机保存失败，请备份查询凭证';
                            result.hidden = false;
                            succeeded = true;
                            nonce = null;
                            frame.src = 'about:blank';
                            dialog.querySelector('.modhub-community-challenge-wrap').hidden = true;
                            submit.disabled = true;
                            submit.textContent = '已提交';
                            tell(saved ? '投稿已记录，可在“我的投稿”中查看进度。' : '投稿已记录，但本机保存失败，请复制查询凭证。');
                            copyButton.focus?.();
                            return;
                        } catch (error) {
                            retryMessage = `${error.message || '提交失败'}。可用原查询凭证查询结果。`;
                            if (error.status === 400 || error.status === 409) {
                                pending = null;
                                lockFields(false);
                                saveSubmissionDraft(draftKey, { fields: values() });
                            }
                        } finally {
                            submitting = false;
                            if (result.hidden) {
                                refreshChallenge(retryMessage);
                            }
                        }
                    };
                    refreshChallenge(pending ? '上次提交结果尚未确认，请使用原查询凭证重试，或在“我的投稿”查询。' : '');
                }
            });
        } finally {
            closed = true;
            if (!isMine) window.removeEventListener('message', onMessage);
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

    function isSameVersion(left, right) {
        const a = String(left || '').trim().replace(/^v(?=\d)/i, '');
        const b = String(right || '').trim().replace(/^v(?=\d)/i, '');
        if (!a || !b) return false;
        const partsA = a.match(/^(\d+(?:\.\d+)*)(.*)$/), partsB = b.match(/^(\d+(?:\.\d+)*)(.*)$/);
        return partsA && partsB ? partsA[2] === partsB[2] && compareVersions(partsA[1], partsB[1]) === 0 : a === b;
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

    // AU 三种模型任选其一，技术名已核对官方直装包的 boot.json。
    const AU_MARKET_IDENTITIES = [
        { id: 'au-beautification', name: 'AU美化', bootNames: ['【AUfemale】model', '【AUmale】model', '【AUandrogynous】model'] },
        { id: 'au-hair-optimization', name: 'AU染发优化', bootNames: [], dependencies: [{ id: 'au-beautification' }] },
        { id: 'au-facial-expansion', name: 'AU面部扩展', bootNames: ['【AUsDoL】facial expansion'], dependencies: [{ id: 'au-beautification',
            bootVersions: { '【AUfemale】model': '>=0.6.6', '【AUmale】model': '>=0.3.1', '【AUandrogynous】model': '>=0.0.3' } }] }
    ].map(identity => ({ ...identity, repositoryKeys: ['AOKIUTAGE/UTAGEsDOL3.0'], category: '外观与资源' }));
    applyIdentityCatalog(AU_MARKET_IDENTITIES);

    // 已核对作者包内技术名；用于旧索引及身份服务不可用时的精确识别。
    const MODHUB_VERIFIED_MARKET_IDENTITIES = [
        { id: 'midsummer-night-dream', name: '多恋人淫啪', bootNames: ['MidsummerNightDream'],
            aliases: ['仲夏夜之梦', 'Midsummer Night Dream'], repositories: ['MND-Hotel'],
            repositoryKeys: ['youmu1818/MND-Hotel'], category: '玩法与内容', tags: ['恋爱'], dependencies: [{ id: 'maplebirch' }] },
        { id: 'deadwood-reblooms', name: '枯木逢春', bootNames: ['deadwood-reblooms'],
            aliases: ['Deadwood Reblooms'], repositories: ['Deadwood-Reblooms'],
            repositoryKeys: ['MaplebirchLeaf/Deadwood-Reblooms'], category: '玩法与内容', tags: ['农场', '剧情'], dependencies: [{ id: 'maplebirch' }] }
    ];
    applyIdentityCatalog(MODHUB_VERIFIED_MARKET_IDENTITIES);

    function applyVerifiedMarketIdentity(mod) {
        // 社区目录的身份须由审核明确关联，不能由客户端替代审核决定。
        if (mod.catalogSource === 'community') return mod;
        const repoKey = extractRepoKey(mod.githubUrl);
        const nameKey = normalizeKey(cleanModTitle(mod.name || mod.wikiName));
        const identity = MODHUB_VERIFIED_MARKET_IDENTITIES.find(item => item.repositoryKeys.some(key => key.toLowerCase() === repoKey)
            && [item.name, ...item.bootNames, ...item.aliases, ...item.repositories].some(name => normalizeKey(name) === nameKey));
        if (!identity || (mod.identityId && mod.identityId !== identity.id)) return mod;
        // 保留索引条目 ID，历史查询仍须使用服务端实际存在的目录标识。
        return { ...mod, identityId: identity.id, bootNames: [...identity.bootNames], aliases: [...identity.aliases],
            repositories: [...identity.repositories], repositoryKeys: [...identity.repositoryKeys],
            category: identity.category, tags: [...identity.tags],
            dependencies: normalizeDependencyList([...(identity.dependencies || []), ...(mod.dependencies || [])]) };
    }

    function normalizeDependencyList(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.flatMap(item => {
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            const key = id.toLowerCase();
            if (!id || seen.has(key)) return [];
            seen.add(key);
            const bootVersions = Object.fromEntries(Object.entries(item.bootVersions && typeof item.bootVersions === 'object' && !Array.isArray(item.bootVersions) ? item.bootVersions : {})
                .filter(([name, version]) => name.trim() && typeof version === 'string' && /^(?:>=|<=|>|<|\^|~)?\s*v?\d+(?:\.\d+)*$/.test(version.trim()))
                .map(([name, version]) => [name.trim(), version.trim()]));
            return [{
                id,
                version: typeof item.version === 'string' ? item.version.trim() : '',
                ...(typeof item.bootName === 'string' && item.bootName.trim() ? { bootName: item.bootName.trim() } : {}),
                ...(item.required === true ? { required: true } : {}),
                ...(Object.keys(bootVersions).length ? { bootVersions } : {})
            }];
        });
    }

    function getDependencyVersion(dependency, boot) {
        if (!dependency.bootVersions) return dependency.version || '';
        return Object.entries(dependency.bootVersions).find(([name]) => name.toLowerCase() === String(boot?.name || '').toLowerCase())?.[1] || '';
    }

    function satisfiesDependency(boot, dependency) {
        if (window.modHubMarketInstaller?.satisfiesDependency) return window.modHubMarketInstaller.satisfiesDependency(boot, dependency);
        const requirement = getDependencyVersion(dependency, boot);
        if (dependency.bootName && String(boot?.name || '').trim().toLowerCase() !== dependency.bootName.trim().toLowerCase()) return false;
        return (!dependency.bootVersions || Boolean(requirement)) && satisfiesVersion(boot?.version, requirement);
    }

    function formatVersionRange(range) {
        return window.modHubMarketVersions?.formatVersionRange?.(range)
            || (range ? `版本要求需手动确认（作者原始写法：${range}）` : '版本要求未声明');
    }

    function formatDependencyRequirement(dependency) {
        if (dependency.version) return formatVersionRange(dependency.version);
        const labels = { '【AUfemale】model': '女体', '【AUmale】model': '男体', '【AUandrogynous】model': '中性' };
        const variants = Object.entries(dependency.bootVersions || {}).map(([name, version]) => `${labels[name] || name} ${formatVersionRange(version)}`);
        return variants.length ? `${variants.join(' / ')}（任选一种）` : '';
    }

    function getModDependencies(mod) {
        const required = (window.modHubMarketVariants?.normalizeRequiredDependencies(mod?.requiredDependencies) || [])
            .map(item => ({ id: item.modName, bootName: item.modName, version: item.version, required: true }));
        if (Array.isArray(mod?._modHubResolvedDependencies)) return normalizeDependencyList([...required, ...mod._modHubResolvedDependencies]);
        const auIdentity = extractRepoKey(mod?.githubUrl) === 'aokiutage/utagesdol3.0'
            ? AU_MARKET_IDENTITIES.find(identity => normalizeKey(identity.name) === normalizeKey(cleanModTitle(mod?.name))) : null;
        const dependencies = normalizeDependencyList([...required, ...(auIdentity?.dependencies || []), ...(mod?.dependencies || [])]);
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
    window.modHubFormatVersion = formatVersionDisplay;
    window.modHubCompareVersions = compareVersions;

    /** 已知模组使用权威分类；未知模组只做保守回退，无法判断时进入“待分类”。 */
    function deriveClassification(name, desc, category, tags) {
        const nameText = String(name || '').toLowerCase();
        const descText = String(desc || '').toLowerCase();
        const text = `${name || ''} ${desc || ''}`.toLowerCase();
        const known = MODHUB_KNOWN_MOD_CLASSIFICATIONS[normalizeKey(name)] || {};
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
            if (!safeHttpsUrl(href)) return;
            let u;
            try {
                u = new URL(href);
            } catch {
                return;
            }
            const host = u.hostname.toLowerCase();
            if (host === WIKI_HOST || host.endsWith('.miraheze.org') || /^(www\.)?github\.com$/.test(host)) return;
            if (host === 'upload.wikimedia.org' || host === 'static.miraheze.org') return;
            urls.push(sourceUrlKey(href));
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
                    wikiName: name,
                    wikiAuthor: author,
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
        mods = mods.map(mod => {
            mod = applyVerifiedMarketIdentity(mod);
            if (extractRepoKey(mod.githubUrl) !== 'aokiutage/utagesdol3.0') return mod;
            const identity = AU_MARKET_IDENTITIES.find(item => normalizeKey(item.name) === normalizeKey(cleanModTitle(mod.name || mod.wikiName)));
            return identity ? { ...mod, identityId: identity.id, bootNames: identity.bootNames, dependencies: getModDependencies(mod) } : mod;
        });
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
        const cacheKey = MODHUB_README_CACHE_PREFIX + repo.key;
        const hasMarkdown = data => typeof data?.markdown === 'string' && Boolean(data.markdown.trim());
        const cached = readLocalCache(cacheKey, MODHUB_README_CACHE_TTL);
        if (hasMarkdown(cached)) return { ...cached, fromCache: true };
        const url = new URL(endpoint);
        url.searchParams.set('repo', repo.key);
        const sources = [url.toString(), `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/readme`];
        let lastError;
        for (const [index, source] of sources.entries()) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timeoutId;
            try {
                // 每条线路的超时覆盖响应体读取；缺少 AbortController 时仍须结束等待。
                const data = await Promise.race([
                    (async () => {
                        const response = await fetch(source, {
                            ...(controller ? { signal: controller.signal } : {}),
                            ...(index ? { headers: { Accept: 'application/vnd.github+json' } } : {})
                        });
                        if (response.status === 404) return null;
                        if (!response.ok) throw new Error(`GitHub README 获取失败: ${response.status}`);
                        let payload = await response.json();
                        if (index) {
                            if (payload?.encoding !== 'base64' || typeof payload.content !== 'string') {
                                throw new Error('GitHub README 返回格式异常');
                            }
                            const bytes = Uint8Array.from(atob(payload.content.replace(/\s/g, '')), char => char.charCodeAt(0));
                            if (bytes.length > 1024 * 1024) throw new Error('GitHub README 超过大小限制');
                            const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                            const getSourceUrl = (value, hostname) => {
                                try {
                                    const parsed = new URL(value);
                                    return parsed.protocol === 'https:' && parsed.hostname === hostname && !parsed.username && !parsed.password
                                        && parsed.pathname.split('/').slice(1, 3).join('/').toLowerCase() === repo.key ? parsed.href : '';
                                } catch { return ''; }
                            };
                            payload = { markdown, repo: repo.key,
                                sourceUrl: getSourceUrl(payload.html_url, 'github.com') || `https://github.com/${repo.owner}/${repo.repo}`,
                                downloadUrl: getSourceUrl(payload.download_url, 'raw.githubusercontent.com') };
                        }
                        if (!hasMarkdown(payload)) throw new Error('GitHub README 返回格式异常');
                        return payload;
                    })(),
                    new Promise((_, reject) => {
                        timeoutId = setTimeout(() => {
                            reject(new Error('GitHub README 获取超时'));
                            controller?.abort();
                        }, README_FETCH_TIMEOUT_MS);
                    })
                ]);
                if (data) writeLocalCache(cacheKey, data);
                return data;
            } catch (error) {
                lastError = error;
            } finally {
                clearTimeout(timeoutId);
            }
        }
        const previous = readLocalCache(cacheKey, MODHUB_README_CACHE_TTL, true);
        if (hasMarkdown(previous)) return { ...previous, fromCache: true, isStale: true };
        throw lastError;
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
        const stripped = String(name || '').replace(/\.(?:zip|mod|modpack(?:\.crypt)?)$/ig, '')
            .replace(/(^|[\s._-])v(?=(?:alpha|beta|omega)[\s._-]*\d)/ig, '$1')
            .replace(/(?:for[\s._-]*)?dol[\s._-]*v?\d+(?:\.\d+)+[a-z]?(?=[\s._+-]|$)/ig, '')
            .replace(/(?:version|ver|v)?\d+(?:\.\d+)+[a-z]?(?:[._-](?:fix|hotfix)\d*)?(?=[\s._+-]|$)/ig, '')
            .replace(/(?:^|[\s._-])build[\s._-]*\d+/ig, '')
            .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
        return stripped.replace(/^(?:dol|mod)+/, '').replace(/(?:dol|mod)+$/, '') || stripped;
    }

    function matchesAssetIdentity(asset, mod) {
        if (window.modHubMarketVariants?.normalizeVariant(mod?.variant)) {
            // 显式语言条目只认技术名或已核验附件的完整系列，保留语言后缀。
            const platformless = name => String(name || '').replace(/(?:^|[\s._-])(?:desktop|windows|pc|mobile|android)(?=[\s._-]|$)/ig, '');
            const series = getAssetSeries(platformless(asset.name));
            const bootNames = (mod.bootNames || []).map(name => String(name).trim().toLowerCase());
            const names = [...(mod.bootNames || [])];
            const records = [...(Array.isArray(mod.verifiedReleaseAssets) ? mod.verifiedReleaseAssets : []), ...(mod.verifiedReleaseAsset ? [mod.verifiedReleaseAsset] : [])];
            for (const record of records) {
                if (!bootNames.includes(String(record.bootName || '').trim().toLowerCase()) || !/^[a-f0-9]{64}$/i.test(record.sha256 || '')) continue;
                try {
                    const url = new URL(record.sourceUrl);
                    if (parseGithubRepo(url.toString())?.key !== parseGithubRepo(mod.githubUrl)?.key) continue;
                    names.push(decodeURIComponent(url.pathname.split('/').pop()));
                } catch (_) { /* 无法核对来源的登记不扩大安装身份。 */ }
            }
            return names.some(name => { const identity = getAssetSeries(platformless(name)); return identity.length >= 3 && identity === series; });
        }
        const series = getAssetSeries(String(asset.name || '').replace(/(?:^|[\s._-])(?:desktop|windows|pc|mobile|android|english|chinese|chs|cht|cn|en|zh)(?=[\s._-]|$)/ig, ''));
        return [...(mod?.bootNames || []), ...(mod?.aliases || []), ...(mod?.repositories || []), mod?.name].some(name => {
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

    function getAssetRole(asset) {
        const name = typeof asset === 'string' ? asset : asset?.name || '';
        if (MODHUB_OPTIONAL_AUDIO_PATTERN.test(name)) return 'audio';
        return COMPANION_ASSET_PATTERN.test(name) ? 'resource' : 'main';
    }

    /** 音频扩展须与主包在同一发布中精确配对，独立音频模组仍保留为安装候选。 */
    function getMatchingOptionalAssets(main, assets) {
        if (!main || getAssetRole(main) === 'audio') return [];
        const version = getAssetVersionParts(main.name).join('.');
        if (!version) return [];
        const releasePath = value => { try { const url = new URL(value); return url.origin + url.pathname.slice(0, url.pathname.lastIndexOf('/')); } catch (_) { return ''; } };
        const source = releasePath(main.downloadUrl);
        return (assets || []).filter(asset => asset.downloadUrl !== main.downloadUrl && getAssetRole(asset) === 'audio'
            && source && releasePath(asset.downloadUrl) === source
            && getAssetSeries(asset.name.replace(MODHUB_OPTIONAL_AUDIO_PATTERN, '')) === getAssetSeries(main.name)
            && getAssetVersionParts(asset.name).join('.') === version
            && getAssetGameVersion(asset.name) === getAssetGameVersion(main.name))
            .map(asset => ({ ...asset, packageRole: 'audio', optional: true,
                ...(getAssetSeries(asset.name) === 'deadwoodrebloomsaudio' ? { bootName: 'deadwood-reblooms-audio' } : {}) }));
    }

    function buildReleaseAssetPlan(assets, gameVersion = window.StartConfig?.version || '', mod = null, options = {}) {
        let downloadable = (assets || []).filter(asset => asset?.downloadUrl
            && /\.(?:zip|mod|modpack(?:\.crypt)?)$/i.test(asset.name || '')
            && !/(?:^|[\s._-])(?:source(?:[\s._-]*code)?|src|apk|outdated?|obsolete)(?=[\s._-]|$)|源码|整合包|过时版/i.test(asset.name || '')
            && !/\/archive\//i.test(asset.downloadUrl));
        const packageStem = name => String(name || '').replace(/\.(?:zip|mod|modpack(?:\.crypt)?)$/i, '').toLowerCase();
        const modelNames = new Set(downloadable.filter(asset => /\.model(?=[._-])/i.test(asset.name)).map(asset => packageStem(asset.name)));
        // 同版本直装包存在时，配对的手动覆盖图包不参与自动安装。
        downloadable = downloadable.filter(asset => !/\.imgpack(?=[._-])/i.test(asset.name)
            || !modelNames.has(packageStem(asset.name.replace(/\.imgpack(?=[._-])/i, '.model'))));
        if (!downloadable.length) return { assets: [], candidates: [], availableAssets: [], needsChoice: false, reason: '没有可自动导入的模组安装包' };

        const optionalUrls = new Set(downloadable.flatMap(asset => getMatchingOptionalAssets(asset, downloadable)).map(asset => asset.downloadUrl));
        const mainAssets = downloadable.filter(asset => !optionalUrls.has(asset.downloadUrl));
        const identified = mod ? mainAssets.filter(asset => matchesAssetIdentity(asset, mod)) : [];
        let mainCandidates = identified.length ? identified : mainAssets.filter(asset => !COMPANION_ASSET_PATTERN.test(asset.name || ''));
        if (!mainCandidates.length) mainCandidates = downloadable;
        if ((mod?.identityId || mod?.id) === 'au-beautification' && mod._matchedLocal?.name) {
            // 更新已装模型时保留其类型，避免更新女体却另外装入男体或中性模型。
            mainCandidates = mainCandidates.filter(asset => getAssetSeries(asset.name) === normalizeKey(mod._matchedLocal.name));
            if (!mainCandidates.length) return { assets: [], candidates: [], availableAssets: downloadable, needsChoice: false, reason: '未找到当前 AU 模型的更新包' };
        }
        if ((mod?.sharedRepository || window.modHubMarketVariants?.normalizeVariant(mod?.variant)) && !identified.length) {
            return { assets: [], candidates: [], availableAssets: [], needsChoice: false, reason: '同仓库包含多个模组，未找到与当前条目身份一致的安装包' };
        }

        const isMobile = typeof window.modHubIsMobile === 'function' ? !!window.modHubIsMobile() : !!window.modHubIsMobile;
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
        if (!options.preserveVersions && normalizedGameVersion && versionSpecific.length) {
            const exact = versionSpecific.filter(asset => getAssetGameVersion(asset.name) === normalizedGameVersion);
            const matchingSeries = new Set(exact.map(asset => getAssetSeries(asset.name)));
            if (exact.length && mainCandidates.every(asset => matchingSeries.has(getAssetSeries(asset.name)))) mainCandidates = exact;
            else return { assets: [], candidates: mainCandidates, availableAssets: downloadable, needsChoice: true,
                reason: `无法唯一确定适用于当前 DoL ${normalizedGameVersion} 的模组系列，请核对作者说明后选择` };
        }

        // 仅在同一产品、语言和模型系列内比较版本，不用另一个模组的版本号淘汰本模组。
        const series = new Map();
        for (const asset of mainCandidates) {
            const key = options.preserveVersions ? asset.downloadUrl
                : `${getAssetSeries(asset.name)}${getAssetVersionParts(asset.name).length ? '' : ':unversioned'}`;
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
        const platform = (typeof window.modHubIsMobile === 'function' ? window.modHubIsMobile() : window.modHubIsMobile) ? 'mobile' : 'desktop';
        const source = JSON.stringify([repo.key, repo.releaseTag, repo.assetName, entryKey, mod.bootNames || [], mod.aliases || [],
            (mod.identityId || mod.id) === 'au-beautification' ? mod._matchedLocal?.name || '' : '']);
        const isUsableCache = cached => cached?.assetPlanVersion === 6 && cached.assetPlanGameVersion === gameVersion
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
                console.warn('[ModHub] GitHub API 直连受限，回退使用最近成功缓存的 Release 数据:', fetchErr);
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
        let version = sharedRepository ? (getAssetVersionParts(bestAsset?.name).join('.') || mod.wikiVersion || '')
            : (getAssetVersionParts(bestAsset?.name).join('.') || explicitTitleVersion || tagVersion || prefixedTitleVersion || mod.version || '');
        // 直连回退复用选版的来源与身份校验，不能借用同仓库其它产品的版号。
        if (window.modHubMarketVersions?.buildCandidates) {
            const candidates = window.modHubMarketVersions.buildCandidates({ ...mod,
                sharedRepository: Boolean(mod.sharedRepository || sharedRepository) }, {
                sourceUrl: mod.githubUrl,
                releases: [{ tagName, name: releaseTitle, htmlUrl: releaseData.html_url,
                    publishedAt: releaseData.published_at, draft: releaseData.draft,
                    prerelease: releaseData.prerelease, assets }]
            });
            const metadata = candidates.find(candidate => candidate.assetUrl === bestAsset?.downloadUrl);
            version = metadata?.version || '';
        }
        const publishedTime = Date.parse(releaseData.published_at || '');
        const updateDate = window.modHubMarketVersions?.formatReleaseDate
            ? window.modHubMarketVersions.formatReleaseDate(releaseData.published_at) || mod.updateDate || ''
            : Number.isFinite(publishedTime) ? new Date(publishedTime + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : mod.updateDate || '';

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
            assetPlanVersion: 6,
            assetPlanGameVersion: gameVersion,
            assetPlanPlatform: platform,
            assetPlanSource: source,
            version,
            versionLabel: version ? '' : tagName,
            publishedAt: releaseData.published_at || null,
            updateDate,
            updateDateSource: Number.isFinite(publishedTime) ? 'github' : mod.updateDateSource || null
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
        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}_companions_v4_${encodeURIComponent(mod.id || mod.name || '')}`;
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
                    || !/\.(?:zip|mod|modpack(?:\.crypt)?)$/i.test(asset.name || '')
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
        const escape = value => window.modHubEscapeHtml(String(value ?? ''));
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
            const isCompanion = COMPANION_ASSET_PATTERN.test(asset.name || '');
            const role = isCompanion ? '附属资源' : (index === 0 ? '主模组' : '附属安装包');
            const color = isCompanion || index > 0 ? 'purple' : 'gold';
            return `<div class="modhub-install-file"><span class="modhub-install-label">${role}</span><span class="modhub-install-name ${color}">${escape(asset.name)}</span><span class="modhub-install-size">${escape(formatAssetSize(asset.size))}</span></div>`;
        }).join('');
        const summaryTitle = needsChoice ? '请选择 1 个安装包' : `将安装 ${assets.length} 个文件`;
        const summaryMeta = needsChoice ? `${candidates.length} 个候选` : (totalSize ? `共 ${formatAssetSize(totalSize)}` : '大小未知');
        const modeText = selectedMirror?.browserOnly ? '浏览器下载后手动导入' : '自动导入 ModLoader';
        return `
            <div class="modhub-install-summary">
                <div class="modhub-install-overview"><strong>${escape(summaryTitle)}</strong><span>${escape(summaryMeta)}</span></div>
                ${filesHtml ? `<div class="modhub-install-files">${filesHtml}</div>` : ''}
                <dl class="modhub-install-meta">
                    <div><dt>版本选择</dt><dd class="gold">${escape(versionText)}</dd></div>
                    <div><dt>附属资源</dt><dd class="${companionCount ? 'purple' : 'grey'}">${escape(companionText)}</dd></div>
                    <div><dt>下载线路</dt><dd class="${selectedMirror?.browserOnly ? '' : 'green'}">${escape(selectedMirror?.name || '默认加速')}</dd></div>
                    <div><dt>安装方式</dt><dd class="${selectedMirror?.browserOnly ? 'gold' : 'green'}">${escape(modeText)}</dd></div>
                </dl>
            </div>`;
    }

    /** 格式化前置依赖清单 HTML（支持多色状态显示与可选勾选） */
    function formatDependencyListHtml(plan) {
        if (!plan?.requirements?.length) return '';
        const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');

        const isModMatch = (a, b) => a === b || (Boolean(a?.name) && a?.name === b?.name);

        const actionableCount = plan.requirements.filter(req =>
            (plan.actions || []).some(action => isModMatch(action.mod, req.mod))
        ).length;

        const itemsHtml = plan.requirements.map((req, reqIndex) => {
            const reqActions = (plan.actions || []).filter(action => isModMatch(action.mod, req.mod));
            const isSatisfied = reqActions.length === 0;

            if (isSatisfied) {
                const versionText = formatDependencyRequirement(req.dependency) ? `满足 ${formatDependencyRequirement(req.dependency)}` : '';
                return `
                    <div class="modhub-dep-item modhub-dep-satisfied">
                        <span class="modhub-dep-bullet green" aria-hidden="true">•</span>
                        <div class="modhub-dep-content">
                            <span class="modhub-dep-name">${escape(req.mod.name)}</span>
                            ${versionText ? `<span class="modhub-dep-version grey">（${escape(versionText)}）</span>` : ''}
                        </div>
                        <span class="modhub-dep-status green">已满足</span>
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
                if (formatDependencyRequirement(req.dependency)) {
                    versionText = `需要 ${formatDependencyRequirement(req.dependency)}`;
                }
            } else if (updateAction) {
                activeColor = 'gold';
                activeText = '需更新';
                skipText = '跳过更新';
                const localVer = formatVersionDisplay(updateAction.local?.version) || '旧版';
                const reqVer = formatDependencyRequirement(req.dependency) || formatVersionDisplay(updateAction.mod?.version) || '新版';
                versionText = `当前 ${localVer} · 需要 ${reqVer}`;
            } else if (enableAction) {
                activeColor = 'purple';
                activeText = '未启用';
                skipText = '保持禁用';
                versionText = '已安装未启用';
            }

            return `
                <label class="modhub-dep-item modhub-dep-actionable" data-req-index="${reqIndex}">
                    <input type="checkbox" class="modhub-dep-checkbox" name="modHubDepReq" data-req-index="${reqIndex}" checked>
                    <div class="modhub-dep-content">
                        <span class="modhub-dep-name">${escape(req.mod.name)}</span>
                        ${versionText ? `<span class="modhub-dep-version grey">（${escape(versionText)}）</span>` : ''}
                    </div>
                    <span class="modhub-dep-status ${activeColor}" data-active-text="${activeText}" data-active-color="${activeColor}" data-skip-text="${skipText}">${activeText}</span>
                </label>
            `;
        }).join('');

        const tipText = actionableCount > 0
            ? '默认勾选一键安装，可取消勾选'
            : '已安装且符合版本要求';

        return `
            <div class="modhub-install-dependencies">
                <div class="modhub-install-dependencies-header">
                    <strong class="modhub-install-dependencies-title">前置依赖</strong>
                    <span class="modhub-install-dependencies-tip grey">${escape(tipText)}</span>
                </div>
                <div class="modhub-dep-list">
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
        const select = document.getElementById?.('modHubMirrorSelect');
        if (select) select.value = mirror.id;
        renderMarketCards();
        if (notify) window.modHubShowToast(`已切换下载线路: ${mirror.name}`, 'info');
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

    const DEAD_REPOS_STORAGE_KEY = 'modhub_market_dead_repos_v1';
    // 已核实当前不可访问（HTTP 404）的 GitHub 仓库
    const KNOWN_DEAD_REPOSITORIES = new Set([
        'kanna-hanabi/wovenrealm',
        'kanna-hanabi/wovenrealmui',
        '102326/dol-mod-center'
    ]);
    // 经核实正常活跃的仓库白名单（包含短横线单字符仓库名，防止误诊，并自动清洗本地可能存留的误诊记录）
    const KNOWN_ACTIVE_REPOSITORIES = new Set([
        'dawalizhang/-',
        'lingyu230514/-'
    ]);

    function getDeadRepos() {
        try {
            const stored = JSON.parse(readStoredValue(DEAD_REPOS_STORAGE_KEY) || '[]');
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
                renderCategoryFilters();
                renderMarketCards();
            } catch (_) {}
        }
    }

    /** 将远程身份字典合并进内置别名库，内置数据继续作为离线兜底 */
    function applyIdentityCatalog(catalog, registerMetadata = true) {
        const identities = Array.isArray(catalog) ? catalog : catalog?.mods;
        if (!Array.isArray(identities)) return 0;
        if (registerMetadata) registeredIdentityMetadata.clear();

        let applied = 0;
        for (const identity of identities) {
            if (!identity || typeof identity !== 'object' || identity.identityId === null) continue;
            const declaredVariant = window.modHubMarketVariants?.normalizeVariant(identity.variant);
            const technicalNames = (Array.isArray(identity.bootNames) ? identity.bootNames : []).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
            if (registerMetadata && typeof identity.id === 'string' && identity.id && technicalNames.length) {
                registeredIdentityMetadata.set(identity.id, {
                    variant: declaredVariant,
                    requiredDependencies: window.modHubMarketVariants?.normalizeRequiredDependencies(identity.requiredDependencies) || [],
                    verifiedReleaseAssets: Array.isArray(identity.verifiedReleaseAssets) ? identity.verifiedReleaseAssets : []
                });
            }
            if (identity.id && declaredVariant && technicalNames.length) {
                languageIdentityMembers.set(identity.id, { id: identity.id, identityId: identity.id,
                    name: identity.name || identity.id, wikiName: identity.name || identity.id,
                    bootNames: [...new Set(technicalNames)], aliases: [], variant: declaredVariant,
                    autoInstall: false, githubUrl: null, contentType: 'package' });
            }

            // 净化异常数据：强行切断万能的智能手机、Omega 简化版与唐百玎HY手机模组的历史混淆关联
            if (identity.id === 'smartphone' || identity.name === '万能的智能手机') {
                identity.aliases = (identity.aliases || []).filter(a => a !== '手机' && !/omega|简化/i.test(a));
                identity.bootNames = (identity.bootNames || []).filter(b => !/omega|简化/i.test(b));
                identity.repositories = (identity.repositories || []).filter(r => !/dolphonemod/i.test(r));
                identity.repositoryKeys = (identity.repositoryKeys || []).filter(k => !/hcptanghy/i.test(k));
            }
            if (identity.id === 'smartphone-omega' || /omega/i.test(identity.id || '') || /omega/i.test(identity.name || '')) {
                identity.bootNames = (identity.bootNames || []).filter(b => !/alpha/i.test(b) && b.toLowerCase() !== 'smartphone');
                identity.aliases = (identity.aliases || []).filter(a => a !== '智能手机' && a !== '手机');
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
                const previous = MODHUB_BOOT_IDENTITIES.get(exactName);
                MODHUB_BOOT_IDENTITIES.set(exactName, previous && previous.id !== owner ? { id: null, repositoryKeys: [] } : { id: owner, repositoryKeys });
            }
            for (const key of keys) {
                const previousOwner = MODHUB_IDENTITY_NAME_OWNERS.get(key);
                if (previousOwner && previousOwner !== owner) MODHUB_AMBIGUOUS_IDENTITY_NAMES.add(key);
                MODHUB_IDENTITY_NAME_OWNERS.set(key, owner);
                if (MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(key)) continue;
                const aliases = new Set(MODHUB_KNOWN_MOD_MARKET_ALIASES[key] || []);
                names.forEach(name => {
                    if (normalizeKey(name) !== key) aliases.add(name);
                });
                MODHUB_KNOWN_MOD_MARKET_ALIASES[key] = [...aliases];
                if (repositoryKeys.length) MODHUB_KNOWN_MOD_REPOSITORY_KEYS[key] = repositoryKeys;
                const existing = MODHUB_KNOWN_MOD_CLASSIFICATIONS[key];
                if (identity.identityId !== null && MARKET_CATEGORIES.includes(identity.category)
                    && (identity.category !== '待分类' || !existing || existing.category === '待分类')) {
                    MODHUB_KNOWN_MOD_CLASSIFICATIONS[key] = {
                        category: identity.category,
                        tags: Array.isArray(identity.tags) ? identity.tags : []
                    };
                }
            }
            applied++;
        }
        // 同名条目不能互相扩充别名；仓库名也不能替代同仓库内各模组的身份。
        for (const key of MODHUB_AMBIGUOUS_IDENTITY_NAMES) {
            delete MODHUB_KNOWN_MOD_MARKET_ALIASES[key];
            delete MODHUB_KNOWN_MOD_REPOSITORY_KEYS[key];
            delete MODHUB_KNOWN_MOD_CLASSIFICATIONS[key];
        }
        for (const key of Object.keys(MODHUB_KNOWN_MOD_MARKET_ALIASES)) {
            MODHUB_KNOWN_MOD_MARKET_ALIASES[key] = MODHUB_KNOWN_MOD_MARKET_ALIASES[key]
                .filter(name => !MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(normalizeKey(name)));
        }
        return applied;
    }

    /** 将 Cloudflare 统一索引转换为模组市场既有数据结构 */
    function normalizeReleaseIndex(index) {
        if (index?.schemaVersion !== 1 || !Array.isArray(index.mods)) {
            throw new Error('自动版本索引格式异常');
        }
        rememberWithdrawals(index);
        const activeMods = index.mods.filter(mod => mod && mod.contentType !== 'spell' && mod.status !== 'withdrawn');

        // 客户端容错修正：若远程 release-index 仍包含未更新的旧身份映射，即时纠偏并拆分
        for (const mod of activeMods) {
            const repoKey = (extractRepoKey(mod.githubUrl) || mod.repo || '').toLowerCase();
            if (repoKey === 'hcptanghy/dol-phonemod') {
                mod.id = 'dol-phone-mod';
                mod.identityId = 'dol-phone-mod';
                mod.name = mod.name || '手机';
                mod.wikiName = mod.wikiName || '手机';
                mod.bootNames = ['PhoneMod', 'DOL-PhoneMod'];
                mod.aliases = ['手机', 'DOL-PhoneMod'];
                mod.repositories = ['DOL-PhoneMod'];
                mod.repositoryKeys = ['HCPTangHY/DOL-PhoneMod'];
            } else if (repoKey === 'anlinstudio/degrees-of-lewdity-dolsmartphone') {
                const isOmega = /omega|简化/i.test(`${mod.id || ''} ${mod.name || ''} ${mod.wikiName || ''} ${mod.githubUrl || ''} ${mod.sourceUrl || ''}`);
                if (isOmega) {
                    mod.id = (mod.id && mod.id !== 'smartphone') ? mod.id : 'smartphone-omega';
                    mod.identityId = 'smartphone-omega';
                    mod.name = mod.name || '万能的智能手机 OmegaΩ';
                    mod.wikiName = mod.wikiName || '万能的智能手机 OmegaΩ';
                    mod.bootNames = ['SmartPhone Omega'];
                    mod.aliases = ['万能的智能手机 Omega', '万能的智能手机 OmegaΩ', '万能的智能手机 简化版', 'SmartPhone Omega'];
                    mod.repositories = ['Degrees-of-Lewdity-DolSmartPhone'];
                    mod.repositoryKeys = ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'];
                    mod.sharedRepository = true;
                } else {
                    mod.id = 'smartphone';
                    mod.identityId = 'smartphone';
                    mod.name = mod.name || '万能的智能手机';
                    mod.wikiName = mod.wikiName || '万能的智能手机';
                    mod.bootNames = ['SmartPhone Alpha', 'SmartPhone'];
                    mod.aliases = ['万能的智能手机', '智能手机'];
                    mod.repositories = ['Degrees-of-Lewdity-DolSmartPhone'];
                    mod.repositoryKeys = ['ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone'];
                    mod.sharedRepository = true;
                }
            }
        }

        const visibleMods = activeMods.filter(mod => !isWithdrawn(mod));
        // 模组同名防御安全网：同仓库或不同条目间绝不允许产生完全重名的卡片
        const seenDisplayNames = new Map();
        for (const mod of visibleMods) {
            const rawName = mod.name || mod.wikiName || '';
            const key = normalizeKey(rawName);
            if (!key) continue;
            if (seenDisplayNames.has(key)) {
                const prev = seenDisplayNames.get(key);
                if (prev.id !== mod.id || prev.sourceUrl !== mod.sourceUrl) {
                    console.warn(`[ModHub] 检测到同名模组冲突:【${rawName}】(id: ${prev.id} vs ${mod.id})，执行自动歧义消解`);
                    if (mod.wikiName && mod.wikiName !== rawName && normalizeKey(mod.wikiName) !== key) {
                        mod.name = mod.wikiName;
                    } else if (prev.wikiName && prev.wikiName !== rawName && normalizeKey(prev.wikiName) !== key) {
                        prev.name = prev.wikiName;
                    } else {
                        const modTag = parseGithubRepo(mod.githubUrl)?.releaseTag || mod.id.split('-').pop();
                        if (modTag) mod.name = `${rawName} (${modTag})`;
                    }
                }
            } else {
                seenDisplayNames.set(key, mod);
            }
        }

        applyIdentityCatalog(index.mods.filter(mod => mod && mod.contentType !== 'spell'), false);
        applyIdentityCatalog(index.identities, false);
        applyIdentityCatalog(visibleMods.filter(mod => mod.catalogSource !== 'community' || mod.identityId), false);
        const identities = Array.isArray(index.identities) ? index.identities : index.identities?.mods || [];
        return markSharedRepositories(visibleMods).map(mod => {
            const matching = mod.identityId ? identities.filter(identity => identity.id === mod.identityId) : [];
            const registered = mod.identityId ? registeredIdentityMetadata.get(mod.identityId) : null;
            const identity = registered ? { ...(matching.length === 1 ? matching[0] : {}), ...registered }
                : matching.length === 1 ? matching[0] : null;
            const registeredVariant = window.modHubMarketVariants?.normalizeVariant(identity?.variant);
            mod = { ...mod, variant: registeredVariant || (mod.variant === undefined ? null : mod.variant),
                verifiedReleaseAssets: Array.isArray(identity?.verifiedReleaseAssets) ? identity.verifiedReleaseAssets
                    : Array.isArray(mod.verifiedReleaseAssets) ? mod.verifiedReleaseAssets : [],
                requiredDependencies: window.modHubMarketVariants?.normalizeRequiredDependencies([
                    ...(Array.isArray(identity?.requiredDependencies) ? identity.requiredDependencies : []),
                    ...(Array.isArray(mod.requiredDependencies) ? mod.requiredDependencies : [])]) || mod.requiredDependencies || [] };
            const isCommunity = mod.catalogSource === 'community';
            const sourceUrl = safeHttpsUrl(mod.sourceUrl);
            const otherUrl = safeHttpsUrl(mod.otherUrl) || (isCommunity ? sourceUrl : null);
            const githubUrl = safeHttpsUrl(mod.githubUrl);
            const autoInstall = !isCommunity || hasCommunityReleaseSource(mod);
            mod = {
                ...mod,
                sourceUrl,
                otherUrl,
                autoInstall: Boolean(autoInstall),
                githubUrl: githubUrl && autoInstall ? githubUrl : null
            };
            const target = parseGithubRepo(mod.githubUrl);
            const indexedRelease = parseGithubRepo(mod.releaseUrl);
            if (target?.sourcePath || (mod.sharedRepository && !target?.releaseTag && !window.modHubMarketVariants?.normalizeVariant(mod.variant)) ||
                (target?.releaseTag && mod.releaseUrl &&
                (indexedRelease?.key !== target.key || indexedRelease?.releaseTag !== target.releaseTag))) {
                // 旧索引可能把扩展版本写入主包条目，回退到该条目自身的 Wiki 元数据。
                mod = { ...mod, releaseUrl: null, version: mod.wikiVersion || '', versionLabel: '',
                    versionSource: 'wiki', updateDate: mod.wikiDate || '', updateDateSource: mod.wikiDate ? 'wiki' : null };
            }
            const hasAuthoritativeClassification = mod.identityId !== null || isCommunity;
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
                contentType: 'package',
                isLanguageGroup: false,
                variants: undefined,
                sources: window.modHubMarketSpells?.normalizeSources(mod) || [],
                packageRecords: window.modHubMarketSpells?.normalizePackages(mod) || [],
                _isDeadRepo: isDead,
                name: window.modHubMarketVariants?.getDisplayName({ name: cleanModTitle(mod.name || mod.wikiName) || mod.wikiName || '未命名模组', variant: mod.variant })
                    || cleanModTitle(mod.name || mod.wikiName) || mod.wikiName || '未命名模组',
                githubUrls: Array.isArray(mod.githubUrls)
                    ? mod.githubUrls
                    : (mod.githubUrl ? [mod.githubUrl] : []),
                otherUrls: Array.isArray(mod.otherUrls)
                    ? mod.otherUrls.map(safeHttpsUrl).filter(Boolean)
                    : (otherUrl ? [otherUrl] : []),
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

    async function fetchMarketJson(url, source) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timeoutId;
        try {
            return await Promise.race([
                (async () => {
                    const response = await fetch(url, { cache: 'no-cache', signal: controller?.signal });
                    if (!response.ok) throw new Error(`${source}返回状态码: ${response.status}`);
                    return response.json();
                })(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        controller?.abort();
                        reject(new Error(`${source}请求超时`));
                    }, IDENTITY_FETCH_TIMEOUT_MS);
                })
            ]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function fetchReleaseIndex() {
        let lastError = null;
        for (const url of RELEASE_INDEX_MIRRORS) {
            try {
                const index = await fetchMarketJson(url, '自动版本索引');
                const mods = normalizeReleaseIndex(index);
                window.modHubMarketSpells?.applyIndex(index, withdrawnRevision);
                activeReleaseWorkerBaseUrl = url;
                writeLocalCache(WIKI_CACHE_KEY, mods);
                return mods;
            } catch (error) {
                lastError = error;
                console.warn(`[ModHub] 自动版本索引镜像不可用 (${url})，尝试下一镜像或回退`, error);
            }
        }
        throw lastError || new Error('所有自动版本索引镜像均不可用');
    }

    async function verifyCurrentCommunityInstall(mod) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS) : null;
        try {
            const response = await fetch(getReleaseWorkerUrl('/release-index.json'), {
                cache: 'no-store', ...(controller ? { signal: controller.signal } : {})
            });
            if (!response.ok || response.headers?.get('X-ModHub-Community-Fresh') !== '1') {
                throw new Error('无法确认社区目录的最新审核状态');
            }
            const index = await response.json();
            if (!Number.isSafeInteger(index.communityRevision) || index.communityRevision < withdrawnRevision) {
                throw new Error('社区目录修订号已过期');
            }
            const current = normalizeReleaseIndex(index).find(item => item.id === mod.id && item.catalogSource === 'community');
            const sameNames = (a, b) => JSON.stringify((Array.isArray(a) ? a : []).map(value => String(value).toLowerCase()).sort())
                === JSON.stringify((Array.isArray(b) ? b : []).map(value => String(value).toLowerCase()).sort());
            if (!current || !hasCommunityReleaseSource(current) || isWithdrawn(current)
                || sourceUrlKey(current.sourceUrl) !== sourceUrlKey(mod.sourceUrl)
                || sourceUrlKey(current.githubUrl) !== sourceUrlKey(mod.githubUrl)
                || sourceUrlKey(current.releaseUrl) !== sourceUrlKey(mod.releaseUrl)
                || current.identityId !== mod.identityId || current.version !== mod.version
                || !sameNames(current.repositoryKeys, mod.repositoryKeys)
                || !sameNames(current.bootNames, mod.bootNames)) {
                throw new Error('社区条目审核信息已变化，请刷新市场后再安装');
            }
            return true;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    async function loadIdentityCatalog(forceRefresh = false) {
        const cached = readLocalCache(IDENTITY_CACHE_KEY, WIKI_CACHE_TTL);
        if (!forceRefresh && cached && applyIdentityCatalog(cached) > 0) return cached;

        try {
            const catalog = await fetchMarketJson(IDENTITY_CATALOG_URL, '身份字典');
            if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.mods)) {
                throw new Error('身份字典格式异常');
            }
            applyIdentityCatalog(catalog);
            writeLocalCache(IDENTITY_CACHE_KEY, catalog);
            return catalog;
        } catch (error) {
            if (cached && applyIdentityCatalog(cached) > 0) return cached;
            console.warn('[ModHub] 远程模组身份字典加载失败，继续使用内置映射', error);
            return null;
        }
    }

    function getModUpdateSignature(mod, gameVersion) {
        return JSON.stringify([gameVersion, RELEASE_WORKER_API_BASE, mod.id, mod.githubUrl, mod.version,
            mod.releaseUrl, mod.catalogSource, mod.autoInstall, mod.autoInstallScope, mod.revision, withdrawnRevision,
            mod.identityId, mod.name, mod.sourceUrl, mod.repositoryKeys, mod.bootNames, mod.aliases,
            mod.sharedRepository, mod.releaseCompatibility, mod.dependencies, mod.requiredDependencies, mod.variant, mod.verifiedReleaseAssets, mod.verifiedReleaseAsset, mod._identityMetadataUnavailable,
            (mod.identityId || mod.id) === 'au-beautification' ? mod._matchedLocal?.name || '' : '', marketHistoryRefresh]);
    }

    function getReleaseHistoryContext(mod) {
        return { signature: getModUpdateSignature(mod, window.modHubMarketVersions?.getGameVersion?.()),
            refresh: marketHistoryRefresh, useCache: marketHistoryRefresh === 0 };
    }

    /** 只接收已完成分页的历史候选；目录版号和当前游戏更新目标各自保留。 */
    function rememberMarketCandidates(mod, candidates, { state, context = getReleaseHistoryContext(mod) } = {}) {
        const versions = window.modHubMarketVersions, gameVersion = versions?.getGameVersion?.();
        if (!mod?.id || !versions || isWithdrawn(mod) || mod._isDeadRepo || isDeadRepo(mod.githubUrl, mod)
            || mod.autoInstall === false || mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod)) return null;
        const signature = getModUpdateSignature(mod, gameVersion);
        if (context.signature !== signature || context.refresh !== marketHistoryRefresh) return null;
        if (state && modUpdateChecks.get(signature) !== state) return null;
        const latestRelease = versions.getLatestReleaseCandidate?.(mod, candidates) || null;
        const release = gameVersion ? (versions.getLatestUpdateCandidate || versions.getLatestGameCandidate)(mod, candidates) : null;
        if (!state) {
            state = mod._updateCheck = { signature, checkedAt: Date.now(), pending: false, error: '' };
            modUpdateChecks.set(signature, state);
        }
        Object.assign(state, { latestRelease, release, version: release?.version || '' });
        if (!state.pending) renderMarketCards();
        return state;
    }

    /** 更新状态复用历史包体身份与版号，适配推荐和未知适配新版分别处理。 */
    function getModUpdateInfo(mod) {
        const versions = window.modHubMarketVersions;
        const gameVersion = versions?.getGameVersion?.();
        if (!mod?.id || !versions?.getLatestGameCandidate) return { version: mod?.version || '' };
        const signature = getModUpdateSignature(mod, gameVersion);
        const cached = modUpdateChecks.get(signature);
        if (cached && (cached.pending || Date.now() - cached.checkedAt < RELEASE_CACHE_TTL)) {
            mod._updateCheck = cached;
            return cached;
        }
        const state = mod._updateCheck = { signature, checkedAt: Date.now(), pending: true, version: '', release: null, error: '' };
        modUpdateChecks.set(signature, state);
        const context = getReleaseHistoryContext(mod), refresh = context.refresh;
        state.promise = Promise.resolve().then(async () => {
            const candidates = [];
            let history;
            do {
                history = await versions.fetchReleases(mod, { page: history ? history.page + 1 : 1, useCache: context.useCache });
                if (refresh !== marketHistoryRefresh || mod._updateCheck !== state || versions.getGameVersion() !== gameVersion || isWithdrawn(mod)) return;
                candidates.push(...versions.buildCandidates(mod, history));
            } while (history.hasMore);
            if (!rememberMarketCandidates(mod, candidates, { state, context })) return;
            const asset = getReleaseInstallAssets(state.release)[0];
            const repository = parseGithubRepo(mod.githubUrl);
            if (mod._matchedLocal?.packageDigest && asset && !getAssetPackageDigest(asset) && repository && state.release.tagName) {
                try {
                    const official = await queueOfficialPackageMetadata(signal => {
                        if (mod._updateCheck !== state || versions.getGameVersion() !== gameVersion) return null;
                        return fetchModRelease({ ...mod,
                            githubUrl: `https://github.com/${repository.owner}/${repository.repo}/releases/tag/${encodeURIComponent(state.release.tagName)}` }, { signal });
                    });
                    const matching = official?.availableAssets?.find(item => item.downloadUrl === asset.downloadUrl);
                    if (matching?.digest) {
                        asset.digest = matching.digest;
                        const digest = getAssetPackageDigest(matching);
                        if (digest) downloadedPackageDigests.set(asset.downloadUrl, digest);
                    }
                } catch (_) { /* 官方元数据不可用时保留包内版本，不推断发布身份。 */ }
            }
        }).catch(error => { state.error = error.message || '更新版本暂时无法核对'; }).finally(() => {
            state.pending = false;
            if (refresh !== marketHistoryRefresh || mod._updateCheck !== state || versions.getGameVersion() !== gameVersion) return;
            const updates = getUpdatableMods();
            window.modHubNotifyUpdateState?.(updates.length, updates);
            renderMarketCards();
        });
        return state;
    }

    /** 全面搜集本地已安装的模组档案 (支持已加载、已启用、已禁用全状态) */
    function getLocalInstalledProfiles() {
        const profiles = [];
        const seenNames = new Set();

        const addProfile = (modName, bootJson, modRef) => {
            const profileKey = String(modName || '').trim().toLowerCase();
            if (!profileKey || seenNames.has(profileKey)) return;
            seenNames.add(profileKey);

            const stored = window._modHubDisabledModInfo?.get?.(profileKey);
            const exactStored = String(stored?.bootJson?.name || '').trim().toLowerCase() === profileKey ? stored : null;
            let resolvedMod = exactStored || window.modHubGetModInfo?.(modName) || modRef;
            let boot = resolvedMod?.bootJson || bootJson || modRef?.bootJson || {};
            const actualName = boot.name || resolvedMod?.name;
            if (actualName && String(actualName).trim().toLowerCase() !== String(modName).trim().toLowerCase()) {
                resolvedMod = null;
                boot = {};
            }
            const version = boot.version || '';
            const packageRecord = installedPackageRecords.get(profileKey);
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
                (MODHUB_BOOT_IDENTITIES.get(String(modName).trim().toLowerCase())?.repositoryKeys || []).forEach(key => repositoryKeys.add(key));
            }
            // 昵称只用于展示；身份与仓库别名只从真实技术名扩充，避免借用其他模组昵称。
            for (const name of [modName, boot.name].filter(Boolean)) {
                const norm = normalizeKey(name);
                const knownRepos = MODHUB_KNOWN_MOD_REPOSITORY_KEYS[norm] || [];
                if (declaredRepositoryKeys.size && knownRepos.length && !knownRepos.some(key => declaredRepositoryKeys.has(key))) continue;
                const aliases = MODHUB_KNOWN_MOD_MARKET_ALIASES[norm] || [];
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

            const matchesBoot = packageRecord && (
                packageRecord.bootJson === boot ||
                !boot.name ||
                String(packageRecord.bootJson?.name || '').trim().toLowerCase() === String(boot.name || '').trim().toLowerCase()
            );
            const packageDigest = matchesBoot && packageRecord.digest ? packageRecord.digest : '';

            profiles.push({
                name: modName,
                packageDigest,
                version,
                // 原生依赖别名与递归前置仅取同名 boot 声明，展示别名不能替代身份。
                ...(boot.name ? { bootJson: boot } : {}),
                displayNames: cleanNames,
                normalizedNames,
                repos: Array.from(repos).filter(Boolean),
                repositoryKeys: Array.from(repositoryKeys)
            });
        };

        try {
            const gui = window.modHubGetGui ? window.modHubGetGui() : null;

            // 原生缓存条目为 { mod: ModInfo, ... }，内置模块也从此处读取真实 boot。
            const cache = gui?.gModUtils?.getModLoader?.()?.getModCacheArray?.()
                || window.modSC2DataManager?.getModLoader?.()?.getModCacheArray?.();
            if (Array.isArray(cache)) {
                for (let index = cache.length - 1; index >= 0; index--) {
                    const mod = cache[index]?.mod || cache[index];
                    if (mod?.name) addProfile(mod.name, mod.bootJson, mod);
                }
            }

            // 来源 1：gModUtils.getModList()
            if (gui?.gModUtils?.getModList) {
                const list = gui.gModUtils.getModList() || [];
                for (const entry of list) {
                    const m = entry?.mod || entry;
                    if (m && m.name) addProfile(m.name, m.bootJson, m);
                }
            }

            // 来源 2：gModUtils.getModListNameNoAlias()
            if (gui?.gModUtils?.getModListNameNoAlias) {
                const names = gui.gModUtils.getModListNameNoAlias() || [];
                for (const name of names) {
                    const m = typeof window.modHubGetModInfo === 'function' ? window.modHubGetModInfo(name) : gui.gModUtils.getMod?.(name);
                    addProfile(name, m?.bootJson, m);
                }
            }

            // 来源 3：已缓存的模组管理器状态 (含已禁用旁加载模组)
            const state = window._modHubModState;
            if (state) {
                const allNames = [
                    ...(state.sideEnabled || []),
                    ...(state.sideDisabled || []),
                    ...(state.builtInMods || []),
                    ...(state.sideMods ? state.sideMods.map(m => m.name) : [])
                ];
                for (const name of allNames) {
                    const m = typeof window.modHubGetModInfo === 'function' ? window.modHubGetModInfo(name) : gui?.gModUtils?.getMod?.(name);
                    addProfile(name, m?.bootJson, m);
                }
            }
        } catch (e) {
            console.warn('[ModHub] 获取本地模组档案异常', e);
        }

        return profiles;
    }

    /** 检查市场模组是否与本地模组匹配，并返回状态与本地模组信息 */
    function checkModInstallStatus(mod, profiles, disabledNames) {
        if (!mod || mod.contentType === 'spell') return 'unavailable';
        if (!profiles) profiles = getLocalInstalledProfiles();
        mod._isIgnored = false;
        mod._ignoredVersion = '';
        mod._matchedLocal = null;
        mod._matchedScore = 0;
        if (isWithdrawn(mod)) return 'unavailable';
        if (mod.catalogSource === 'community' && !mod.identityId) {
            return marketExternalUrl(mod) ? 'external_only' : 'unavailable';
        }

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
                const knownRepos = MODHUB_KNOWN_MOD_REPOSITORY_KEYS[normK] || [];
                const compatibleRepository = !repositoryKey || !knownRepos.length || knownRepos.includes(repositoryKey);
                if (compatibleRepository && MODHUB_KNOWN_MOD_MARKET_ALIASES[normK]) {
                    MODHUB_KNOWN_MOD_MARKET_ALIASES[normK].forEach(a => {
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
                    (MODHUB_BOOT_IDENTITIES.get(String(p.name || '').trim().toLowerCase())?.repositoryKeys || []).forEach(key => repositoryKeys.add(key));
                }
                const knownRepos = MODHUB_KNOWN_MOD_REPOSITORY_KEYS[normN] || [];
                const compatibleRepository = !repositoryKeys.size || !knownRepos.length || knownRepos.some(key => repositoryKeys.has(key));
                if (compatibleRepository && MODHUB_KNOWN_MOD_MARKET_ALIASES[normN]) {
                    MODHUB_KNOWN_MOD_MARKET_ALIASES[normN].forEach(a => {
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
                    ...p,
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
            ...(MODHUB_KNOWN_MOD_REPOSITORY_KEYS[marketNorm] || [])
        ].map(key => String(key).toLowerCase()));
        const marketNames = new Set([mod.name, mod.wikiName, ...(mod.bootNames || []), ...(mod.aliases || [])]
            .filter(value => typeof value === 'string').map(normalizeKey).filter(Boolean));
        const marketBootNames = new Set((mod.bootNames || []).filter(name => typeof name === 'string').map(name => name.trim().toLowerCase()));
        const marketOwner = mod.identityId || (!MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(marketNorm) && MODHUB_IDENTITY_NAME_OWNERS.get(marketNorm));
        const isAuModel = marketOwner === 'au-beautification';
        const disabledAuNames = new Set(Array.from(disabledNames || [
            ...(window._modHubModState?.sideDisabled || []),
            ...(window._modHubModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
        ], normalizeKey));
        let bestProfile = null;
        let bestScore = 0;
        let bestMatchCount = 0;

        for (const p of profileList) {
            const normTech = normalizeKey(p.name);
            if (marketRepoKey && trustedRepoKeys.size && !trustedRepoKeys.has(marketRepoKey)) continue;
            if (marketRepoKey && p.repositoryKeys?.length && !p.repositoryKeys.includes(marketRepoKey)) continue;
            const exactName = String(p.name || '').trim().toLowerCase();
            // 已审核 bootNames 是安装身份边界；昵称、展示别名和依赖 alias 不能冒充该技术名。
            if (marketBootNames.size && !marketBootNames.has(exactName)) continue;
            const exactIdentity = MODHUB_BOOT_IDENTITIES.get(exactName);
            const localOwner = exactIdentity?.id || MODHUB_IDENTITY_NAME_OWNERS.get(normTech);
            if (marketOwner && localOwner && marketOwner !== localOwner && !MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(normTech)) continue;
            if (marketOwner && exactIdentity?.id && marketOwner !== exactIdentity.id) continue;
            if (marketBootNames.size && MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(normTech) && !marketBootNames.has(exactName)) continue;
            if (MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(marketNorm) && !(marketRepoKey && p.repositoryKeys?.includes(marketRepoKey))) continue;

            // 完整技术名和权威别名精确命中；子串或简介相似不能证明是同一模组。
            let score = marketBootNames.has(exactName) ? 120 : marketNames.has(normTech) ? 110
                : p.normalizedNames.some(name => marketNames.has(name)) ? 100 : 0;
            // 同一 AU 目录的模型是可替代实现，优先使用已启用且达到面扩要求的模型。
            if (isAuModel && AU_MARKET_IDENTITIES[0].bootNames.some(name => name.toLowerCase() === exactName)) {
                score = 120 + (disabledAuNames.has(normTech) ? 0 : 2)
                    + (satisfiesDependency(p, AU_MARKET_IDENTITIES[2].dependencies[0]) ? 1 : 0);
            }
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
        const matchedProfile = bestScore >= 80 && (bestMatchCount === 1 || isAuModel) ? bestProfile : null;
        mod._matchedLocal = matchedProfile;
        mod._matchedScore = matchedProfile ? bestScore : 0;

        if (!matchedProfile) {
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            if (isDead) return safeHttpsUrl(mod.otherUrl) ? 'external_only' : 'unavailable';
            if (!mod.githubUrl && !safeHttpsUrl(mod.otherUrl)) return 'unavailable';
            if (!mod.githubUrl || (mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod))) return 'external_only';
            return 'not_installed';
        }

        if (!mod.githubUrl || (mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod))) {
            return 'external_installed';
        }

        // 比对版本
        const localVer = matchedProfile.version;
        let remoteVer = getModUpdateInfo(mod).version || mod.version;
        if (localVer && remoteVer) {
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            const hasAuthoritativeRelease = Boolean(mod._updateCheck?.release || mod.releaseUrl || mod.versionSource === 'github' || mod.downloadUrl
                || (Array.isArray(mod.assets) && mod.assets.length > 0));
            // Wiki 人工版本与失效仓库不能作为真实更新依据。
            if (isDead || !hasAuthoritativeRelease && mod.versionSource === 'wiki') return 'up_to_date';
            remoteVer = getModUpdateInfo(mod).version;
            if (!remoteVer) return 'up_to_date';
            const packageMatch = isReleasePackageInstalled(mod._updateCheck?.release, matchedProfile);
            if (packageMatch === true) return 'up_to_date';
            const packageUpdate = packageMatch === false && compareVersions(remoteVer, localVer) >= 0;
            // 1. 检查社区版本异常容错规则库（处理作者漏改内部版本号或 Wiki 虚高误录）
            const marketNorm = normalizeKey(cleanModTitle(mod.name));
            const marketRepo = extractRepoName(mod.githubUrl);
            const localNorm = normalizeKey(matchedProfile.name);
            const rule = MOD_MARKET_VERSION_RULES.find(r =>
                r.match(marketNorm, marketRepo) || r.match(localNorm, marketRepo)
            );
            if (!packageUpdate && rule && typeof rule.isUpToDate === 'function') {
                if (rule.isUpToDate(localVer, remoteVer)) {
                    return 'up_to_date';
                }
            }

            // 2. 常规语义化版本比较；只有忽略记录实际挡住更新时才显示“已忽略”
            const cmp = compareVersions(remoteVer, localVer);
            if (cmp > 0 || packageUpdate) {
                const ignoredMap = getIgnoredUpdates();
                const ignoredVer = ignoredMap[mod.name] || (matchedProfile.name ? ignoredMap[matchedProfile.name] : null);
                if (ignoredVer && (ignoredVer === 'ignored' || compareVersions(remoteVer, ignoredVer) <= 0)) {
                    mod._isIgnored = true;
                    mod._ignoredVersion = ignoredVer;
                    return 'up_to_date';
                }
                const confirmedMap = getConfirmedUpdates();
                const confirmedVer = confirmedMap[mod.name] || (matchedProfile.name ? confirmedMap[matchedProfile.name] : null);
                if (!packageUpdate && confirmedVer && compareVersions(remoteVer, confirmedVer) <= 0) {
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
                ...(window._modHubModState?.sideDisabled || []),
                ...(window._modHubModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
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
                checkModInstallStatus(dependencyMod, profiles, disabled);
                const local = dependencyMod._matchedLocal;
                const requirement = getDependencyVersion(dependency, local);
                if (!requirementKeys.has(dependencyKey)) {
                    requirementKeys.add(dependencyKey);
                    requirements.push({ dependency: { ...dependency, version: requirement }, mod: dependencyMod });
                }

                visit(dependencyMod);
                const downloadable = Boolean(dependencyMod.githubUrl);
                const remoteCompatible = Boolean(dependency.bootVersions) || !requirement || satisfiesVersion(dependencyMod.version, requirement);

                if (!local) {
                    if (downloadable && remoteCompatible) {
                        addAction({ type: 'install', mod: dependencyMod, requirement, dependencyRequirements: [dependency] });
                    } else {
                        unavailable.push({
                            dependency,
                            mod: dependencyMod,
                            reason: downloadable ? '市场版本不满足要求' : '没有可自动安装的发布包'
                        });
                    }
                    continue;
                }

                if (!satisfiesDependency(local, dependency)) {
                    if (downloadable && remoteCompatible && (dependency.bootVersions || compareVersions(dependencyMod.version, local.version) > 0)) {
                        addAction({ type: 'update', mod: dependencyMod, local, requirement, dependencyRequirements: [dependency] });
                    } else {
                        unavailable.push({ dependency, mod: dependencyMod, local, reason: '本地及市场版本均不满足要求' });
                    }
                }
                if ([local.name, ...(local.displayNames || [])].some(name => disabled.has(normalizeKey(name)))) {
                    addAction({ type: 'enable', mod: dependencyMod, local, requirement });
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
        targets = [...new Map((targets || []).filter(mod => mod && mod.contentType !== 'spell').map(mod => [getMarketModKey(mod), mod])).values()];
        mods = mods.filter(mod => mod && mod.contentType !== 'spell');
        const targetKeys = new Set(targets.map(getMarketModKey));
        const catalog = new Map();
        [...mods, ...targets].forEach(mod => [mod.id, mod.identityId].filter(Boolean).forEach(id => catalog.set(String(id).toLowerCase(), mod)));
        const disabled = new Set(Array.from(disabledNames || [
            ...(window._modHubModState?.sideDisabled || []),
            ...(window._modHubModState?.sideMods || []).filter(mod => !mod.enabled).map(mod => mod.name)
        ], normalizeKey));
        const nodes = new Map(), allDependencies = new Map(), dependencies = new Map(), constraints = new Map();
        const issues = new Map(), requirementsByKey = new Map(), cycles = new Set();
        const skipped = key => skippedDependencyKeys.has(key) && !targetKeys.has(key);
        const collect = mod => {
            const key = getMarketModKey(mod);
            if (nodes.has(key)) return;
            checkModInstallStatus(mod, profiles, disabled);
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
            const release = releaseInfos.get(key);
            const remoteVersion = release?.version || mod.version;
            const needsUpdate = local && requirements.some(item => !satisfiesDependency(local, item.dependency));
            const type = !local ? 'install' : (needsUpdate ? 'update' : '');
            const finalVersion = type ? remoteVersion : local?.version;
            const finalBoot = type ? { version: finalVersion,
                name: (mod.bootNames || []).find(name => normalizeKey(name) === getAssetSeries(getReleaseInstallAssets(release)[0]?.name)) || '' } : local;
            const downloadable = mod.githubUrl && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod);
            if (excludedKeys.has(key)) issues.set(key, excludedKeys.get(key));
            if (type && !downloadable) issues.set(key, '没有可自动安装的发布包');
            if (needsUpdate && !requirements.some(item => item.dependency.bootVersions) && compareVersions(remoteVersion, local.version) <= 0) issues.set(key, '市场版本无法满足前置要求');
            if (requirements.some(item => !(type && !release && item.dependency.bootVersions) && !satisfiesDependency(finalBoot, item.dependency))) {
                issues.set(key, `前置【${mod.name}】的最终版本不满足全部要求：${[...new Set(requirements.map(item => formatDependencyRequirement(item.dependency)).filter(Boolean))].join('、')}`);
            }
            const role = targetKeys.has(key) ? '目标模组' : '前置依赖';
            if (type) proposedActions.push({ type, mod, local, role, key, enableAfter: Boolean(needsEnable), dependencyRequirements: requirements.map(item => item.dependency) });
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
                ...req, dependency: { ...req.dependency, version: getDependencyVersion(req.dependency, local) }, key, skipped: skipped(key), isTarget: targetKeys.has(key),
                satisfied: Boolean(local && !needsEnable && !issues.has(key) && (constraints.get(key) || []).every(item => satisfiesDependency(local, item.dependency))),
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
        if (!options.restoreContext) {
            return runMarketInstallTask(context => executeBatchInstallPlan(plan, { ...options, restoreContext: context }),
                { label: '市场批量安装', names: plan.targets.map(mod => mod.name), reloadOnChange: false });
        }
        const results = new Map(), changedMods = new Set();
        let currentPlan = plan;
        const refresh = options.refresh || (async () => { await window.modHubLoadModManageState?.(true); });
        const install = options.install || (action => {
            if (options.releaseInfos && !options.releaseInfos.has(action.key)) {
                action.failureReason = '安装计划已变化，请重新核对安装包';
                return false;
            }
            return downloadAndInstallMod(action.mod, currentMirrorId, {
            askRestart: false, skipReloadOffer: true, batchMode: true,
            restoreContext: options.restoreContext,
            releaseInfo: options.releaseInfos?.get(action.key),
            dependencyRequirements: action.dependencyRequirements,
            onFailure: reason => { action.failureReason = reason; }
            });
        });
        const enable = options.enable || (action => window.modHubToggleSideMod?.(action.local.name, true, { silentOfferReload: true, restoreContext: options.restoreContext }));
        const isEnabled = action => {
            const state = window._modHubModState;
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
            if (stopped || options.restoreContext?.cancelled || options.shouldStop?.()) {
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
        if (changedMods.size && options.restoreContext.reloadOnChange) {
            window.modHubRegisterOperationReload(options.restoreContext, '市场批量安装已处理，重新载入后生效。',
                { isFramework: [...changedMods].some(name => window.modHubIsFrameworkMod?.(name)) });
        }
        return { results, changedMods };
    }

    let marketInstallBusy = false;
    async function runMarketInstallTask(task, options = {}) {
        if (marketInstallBusy) {
            window.modHubShowToast('已有市场安装任务，请等待完成后再试', 'warning');
            return false;
        }
        marketInstallBusy = true;
        renderMarketSections();
        document.querySelectorAll('.btn-market-language-choice').forEach(control => { control.disabled = true; });
        let restoreContext;
        try {
            if (!window.modHubRestore) {
                restoreContext = { reloadOnChange: options.reloadOnChange !== false };
                try { return await task(restoreContext); }
                finally { restoreContext.finished = true; }
            }
            return await window.modHubRestore.withOperation({ label: options.label || '市场安装或更新', names: options.names }, async context => {
                restoreContext = context;
                context.reloadOnChange = options.reloadOnChange !== false;
                return task(context);
            });
        }
        finally {
            marketInstallBusy = false;
            renderMarketSections();
            document.querySelectorAll('.btn-market-language-choice').forEach(control => { control.disabled = batchInstallState.running; });
            if (restoreContext?.reloadOffer) await window.modHubCompleteOperationReload(restoreContext);
            else if (!restoreContext?.finishError && window._modHubReloadExitPending) window.modHubPromptPendingReload?.();
        }
    }

    function formatBatchInstallPlanHtml(originalTargets, activeTargets, plan, mirrorId) {
        const escape = window.modHubEscapeHtml;
        const labels = { install: '将安装', update: '将更新', enable: '将启用' };
        const targets = originalTargets.map(mod => {
            const key = getMarketModKey(mod), reason = plan.blocked.get(key);
            const required = getModDependencies(mod).map(dependency => {
                const entry = marketModList.find(item => [item.id, item.identityId].some(id => String(id || '').toLowerCase() === dependency.id.toLowerCase()));
                const requirement = formatDependencyRequirement(dependency);
                return { key: entry ? getMarketModKey(entry) : dependency.id, text: `${entry?.name || dependency.id}${requirement ? `（${requirement}）` : ''}` };
            });
            for (const req of plan.requirements) {
                if (req.key !== key && req.requiredBy.includes(mod.name) && !required.some(item => item.key === req.key)) required.push({ key: req.key, text: req.mod.name });
            }
            return `<label class="modhub-dep-item modhub-dep-actionable"><input type="checkbox" class="modhub-dep-checkbox" name="modHubBatchTarget" data-key="${escape(key)}" ${activeTargets.has(key) ? 'checked' : ''}><span class="modhub-dep-content"><span class="gold">${escape(mod.name)}</span>${required.length ? `<span class="modhub-batch-target-dependencies grey">需要前置：${escape(required.map(item => item.text).join('、'))}</span>` : ''}${reason ? `<span class="red">${escape(reason)}</span>` : ''}</span></label>`;
        }).join('');
        const dependencies = plan.requirements.filter(req => !req.isTarget).map(req => {
            const action = plan.actions.find(item => item.key === req.key);
            const problem = plan.unavailable.find(item => getMarketModKey(item.mod) === req.key);
            if (req.satisfied && !req.skipped && !problem) {
                return `<div class="modhub-dep-item modhub-dep-satisfied"><span class="modhub-dep-bullet green" aria-hidden="true">•</span><span class="modhub-dep-content"><span class="modhub-dep-name">${escape(req.mod.name)}</span><span class="green">已满足，无需下载</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span></span></div>`;
            }
            const status = req.skipped ? '自行处理，可能无法运行' : (problem?.reason || (action ? `${labels[action.type]}${action.enableAfter ? '并启用' : ''}` : '随所属目标跳过'));
            return `<label class="modhub-dep-item modhub-dep-actionable"><input type="checkbox" class="modhub-dep-checkbox" name="modHubBatchDependency" data-key="${escape(req.key)}" ${req.skipped ? '' : 'checked'}><span class="modhub-dep-content"><span class="gold">${escape(req.mod.name)}</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span><span class="${req.skipped || problem ? 'red' : 'grey'}">${escape(status)}</span></span></label>`;
        }).join('');
        return `${formatConflictWarningHtml(detectModInstallationConflicts(null, plan.actions))}${dependencies ? `<div class="modhub-install-dependencies"><strong class="gold">前置依赖（需要处理的项目默认勾选，可取消）</strong>${dependencies}</div>` : ''}<div class="modhub-install-dependencies"><strong class="gold">所选目标</strong><div class="modhub-batch-target-list" role="group" aria-label="所选目标，可上下滚动" tabindex="0">${targets}</div></div><div class="modhub-batch-summary grey"><div>将串行处理 <strong class="gold">${plan.actions.length} 项操作</strong>；不可执行的目标会跳过。</div><div>下载线路：<strong class="gold">${escape(resolveMirrorServer(mirrorId).name)}</strong></div></div>`;
    }

    function batchConflictKey(conflict) {
        // 同一对模组从待安装变成本地已安装时，沿用玩家刚确认的风险。
        return `${conflict.ruleId}:${[conflict.incomingMod.groupName || normalizeKey(conflict.incomingMod.name),
            conflict.localConflictMod.groupName || normalizeKey(conflict.localConflictMod.name)].sort().join(':')}`;
    }

    async function installSelectedMods() {
        if (currentMarketSection !== 'packages') return false;
        return runMarketInstallTask(async restoreContext => {
            const originalTargets = getDisplayMods().filter(mod => batchInstallState.selected.has(getMarketModKey(mod)) && isBatchInstallEligible(mod));
            if (!originalTargets.length) {
                window.modHubShowToast('请先选择尚未安装的模组', 'info');
                return false;
            }
            if (window.modHubMarketInstaller) {
                const result = await window.modHubMarketInstaller.installBatch(originalTargets, { restoreContext });
                if (result) originalTargets.filter(mod => mod.isLanguageGroup).forEach(mod => batchInstallState.selected.delete(getMarketModKey(mod)));
                return result;
            }
            if (originalTargets.some(mod => mod.isLanguageGroup)) {
                await window.modHubAlert('语言与版本选择模块尚未就绪，请重新载入游戏后重试。', '无法选择语言');
                return false;
            }
            const mirrorId = currentMirrorId;
            if (resolveMirrorServer(mirrorId).browserOnly) {
                await window.modHubAlert('当前线路仅支持浏览器下载，请切换到加速通道再批量安装。', '当前线路不支持批量安装');
                return false;
            }
            Object.assign(batchInstallState, { running: true, stopRequested: false, progressPhase: 'preparing', completed: 0, total: 0, current: '生成安装计划' });
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
                await window.modHubLoadModManageState?.(true);
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
                                const choice = await window.modHubConfirm({
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
                    const confirmPlan = () => window.modHubConfirm({
                        title: '批量安装确认', message: '请核对所选目标、前置依赖和兼容性警告。',
                        trustedMessageHtml: `<div id="modHubBatchPlan">${planHtml()}</div>`,
                        dialogClass: 'modhub-install-dialog', confirmText: '开始批量安装', cancelText: '取消', confirmType: 'primary',
                        onRender: dialog => {
                            const area = dialog.querySelector('#modHubBatchPlan');
                            const render = () => {
                                const scrollTop = area.querySelector('.modhub-batch-target-list')?.scrollTop || 0;
                                area.innerHTML = planHtml();
                                const targetList = area.querySelector('.modhub-batch-target-list');
                                if (targetList) targetList.scrollTop = scrollTop;
                                area.querySelectorAll('input[name="modHubBatchTarget"], input[name="modHubBatchDependency"]').forEach(input => {
                                    input.onchange = () => {
                                        const set = input.name === 'modHubBatchTarget' ? activeTargets : skippedDependencies;
                                        const add = input.name === 'modHubBatchTarget' ? input.checked : !input.checked;
                                        if (add) set.add(input.dataset.key); else set.delete(input.dataset.key);
                                        render();
                                        Array.from(area.querySelectorAll('input')).find(next => next.name === input.name && next.dataset.key === input.dataset.key)?.focus({ preventScroll: true });
                                    };
                                });
                                area.querySelectorAll('.modhub-conflict-disable-btn').forEach(button => {
                                    button.onclick = async () => {
                                        if (pendingPlanChange) return;
                                        button.disabled = true;
                                        pendingPlanChange = (async () => {
                                            try {
                                                if (await disableInstallConflict(button.dataset.conflictRaw, button.dataset.conflictName, getAffectedTargets(button.dataset.conflictRaw), restoreContext)) onChanged(button.dataset.conflictRaw);
                                            } catch (error) { window.modHubShowToast(error.message || '快捷禁用失败', 'warning'); }
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
                        await window.modHubLoadModManageState?.(true);
                        const newDownloads = getPlan().actions.filter(action => action.type !== 'enable'
                            && !releaseInfos.has(action.key) && !excluded.has(action.key));
                        if (!newDownloads.length) break;
                        // 改勾选可能恢复原先受阻的分支，先补齐真实发布信息再让玩家核对。
                        await prepareDownloads(newDownloads);
                        batchInstallState.current = '核对更新后的安装清单';
                        renderBatchInstallToolbar();
                    }
                    if (choice && !batchInstallState.stopRequested) {
                        await window.modHubLoadModManageState?.(true);
                        if (await confirmInstallConflicts(() => ({ targetMod: null, actions: getPlan().actions }), { onChanged, getAffectedTargets, restoreContext })) {
                            const plan = getPlan();
                            const approved = new Set(detectModInstallationConflicts(null, plan.actions).filter(item => item.localConflictMod.isEnabled).map(batchConflictKey));
                            const approvedActions = new Set(plan.actions.map(action => `${action.key}:${action.type}`));
                            outcome = await executeBatchInstallPlan(plan, {
                                restoreContext,
                                releaseInfos,
                                getPlan,
                                shouldStop: () => batchInstallState.stopRequested,
                                onProgress: (action, index, total) => {
                                    Object.assign(batchInstallState, { progressPhase: 'installing', current: action.mod.name, completed: index, total });
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
                                    if (!await confirmInstallConflicts(remaining, { onChanged, getAffectedTargets, restoreContext })) return false;
                                    detectModInstallationConflicts(null, remaining().actions).forEach(item => approved.add(batchConflictKey(item)));
                                    return true;
                                }
                            });
                            outcome.changedMods.forEach(name => changedMods.add(name));
                        }
                    }
                }
            } catch (error) {
                await window.modHubAlert(error?.message || String(error), '批量安装未完成');
            } finally {
                batchInstallState.running = false;
                batchInstallState.progressPhase = '';
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
                const isFramework = [...changedMods].some(name => window.modHubIsFrameworkMod?.(name));
                window.modHubRegisterOperationReload(restoreContext, summary, { isFramework });
            } else if (outcome) await window.modHubAlert(summary, '批量安装结果');
            return outcome || false;
        });
    }

    // ==================== 模组兼容性与冲突检测 ====================

    /** 已知框架身份配对；实际风险按包体原生别名声明判断。 */
    const KNOWN_MOD_CONFLICT_RULES = [
        {
            id: 'maplebirch-vs-simpleframework',
            name: '秋枫白桦框架 与 简易框架 提供者检查',
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
            reason: '需要根据实际框架版本与原生别名声明核对提供者。',
            advice: '请按作者要求核对框架版本与实际提供者。',
            level: 'warning'
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
            const canonicalName = modOrName.bootJson?.name || modOrName.name;
            const canonicalKey = normalizeKey(canonicalName);
            const knownOwner = MODHUB_BOOT_IDENTITIES.get(String(canonicalName || '').trim().toLowerCase())?.id
                || (!MODHUB_AMBIGUOUS_IDENTITY_NAMES.has(canonicalKey) && MODHUB_IDENTITY_NAME_OWNERS.get(canonicalKey));
            // 已知目录身份优先于昵称或 ID 子串，依赖框架的普通模组不能被当作框架本身。
            if (knownOwner) return targetKeys.includes(normalizeKey(knownOwner));
            // 有真实 boot 时只依据其技术名，不能借用另一个框架的昵称或展示别名。
            if (typeof modOrName.bootJson?.name === 'string' && modOrName.bootJson.name.trim()) {
                return targetKeys.includes(normalizeKey(modOrName.bootJson.name))
                    || targetKeys.includes(stripDoLPrefix(modOrName.bootJson.name));
            }
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
        if (MODHUB_KNOWN_MOD_MARKET_ALIASES[normKey]) {
            const found = MODHUB_KNOWN_MOD_MARKET_ALIASES[normKey].find(a => /[\u4e00-\u9fa5]/.test(a));
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
                ...(window._modHubModState?.sideDisabled || []),
                ...(window._modHubModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
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
                const isAscii = !/[^\x00-\x7F]/.test(t);
                if (isAscii) {
                    if (norm === t || stripped === t) return true;
                    if (t.length >= 8 && norm.length >= t.length && (norm.includes(t) || (stripped && stripped.includes(t)))) {
                        const ratio = t.length / norm.length;
                        if (ratio >= 0.8) return true;
                    }
                    continue;
                }
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

            const boot = profile.bootJson || window.modHubGetModInfo?.(profile.name)?.bootJson || {};
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
                ...(window._modHubModState?.sideDisabled || []),
                ...(window._modHubModState?.sideMods || []).filter(item => !item.enabled).map(item => item.name)
            ].map(normalizeKey));

        // 即将引入的候选模组列表
        const incomingItems = [];
        const incomingByKey = new Map();
        const incomingLocalKeys = new Map();
        const modKey = mod => String(mod?.identityId || mod?.id || normalizeKey(mod?.name)).toLowerCase();
        const addIncoming = (mod, role, actionType, local) => {
            const key = modKey(mod);
            if (!mod || !key) return;
            const localName = local?.name || mod._matchedLocal?.name || mod.bootJson?.name;
            if (localName) incomingLocalKeys.set(normalizeKey(localName), key);
            const existing = incomingByKey.get(key);
            if (existing) {
                if (role === '目标模组') existing.role = role;
                if (mod.bootJson) existing.mod = mod;
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
                // 新选版流程已预检真实包体；框架身份须同时读取主包、附属包及待启用前置的 boot。
                const boots = Array.isArray(action.prepared?.boots) ? action.prepared.boots
                    : action.local?.bootJson ? [action.local.bootJson] : [];
                const primaryBoot = boots[0];
                addIncoming({ ...action.mod, ...(primaryBoot ? { bootJson: primaryBoot } : {}), releaseInfo: action.release },
                    action.role || '前置依赖', action.type, action.local);
                for (const boot of boots.slice(1)) {
                    if (typeof boot?.name !== 'string' || !boot.name.trim()) continue;
                    const local = (profiles || []).find(profile => normalizeKey(profile.name) === normalizeKey(boot.name));
                    addIncoming({ id: `${modKey(action.mod)}:package:${normalizeKey(boot.name)}`, name: boot.name, bootJson: boot },
                        '附属包', action.type, local);
                }
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
                        const risk = window.modHubGetFrameworkPairRisk(matchesA ? incoming.mod : profile,
                            matchesB ? incoming.mod : profile);
                        if (!risk || (risk.kind === 'alias-provider-overlap' && !isLocalEnabled)) continue;

                        const conflictKey = `${rule.id}:local:${incoming.key}:${localKey}`;
                        if (!seenConflictKeys.has(conflictKey)) {
                            seenConflictKeys.add(conflictKey);
                            const incomingDisplayName = resolveConflictModDisplayName(incoming.mod, matchedIncomingGroup);
                            const localDisplayName = resolveConflictModDisplayName(profile, opponentGroup);

                            conflicts.push({
                                ...risk,
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
                        const risk = window.modHubGetFrameworkPairRisk(item1MatchesA ? item1.mod : item2.mod,
                            item1MatchesB ? item1.mod : item2.mod);
                        if (!risk) continue;
                        const conflictKey = `${rule.id}:internal:${[item1.key, item2.key].sort().join(':')}`;
                        if (!seenConflictKeys.has(conflictKey)) {
                            seenConflictKeys.add(conflictKey);
                            const item1Group = item1MatchesA ? groupA : groupB;
                            const item2Group = item2MatchesA ? groupA : groupB;
                            const item1DisplayName = resolveConflictModDisplayName(item1.mod, item1Group);
                            const item2DisplayName = resolveConflictModDisplayName(item2.mod, item2Group);

                            conflicts.push({
                                ...risk,
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
                            });
                        }
                    }
                }
            }
        }

        return conflicts;
    }

    /** 格式化冲突警告卡片 HTML */
    function formatConflictWarningHtml(conflicts, { allowDisable = true } = {}) {
        if (!conflicts || !conflicts.length) return '';
        const escape = value => typeof window.modHubEscapeHtml === 'function' ? window.modHubEscapeHtml(String(value ?? '')) : String(value ?? '');

        // 判定是否存在未解决的高风险冲突（包括即将安装的前置互斥，或本地已启用的冲突模组）
        const hasActiveConflict = conflicts.some(c => c.localConflictMod?.isIncoming || c.localConflictMod?.isEnabled);

        const itemsHtml = conflicts.map(c => {
            const isLocalEnabled = c.localConflictMod?.isEnabled;
            const isIncoming = c.localConflictMod?.isIncoming;
            const providerOverlap = c.kind === 'alias-provider-overlap';
            const statusBadge = isIncoming
                ? `<span class="modhub-conflict-tag red">${providerOverlap ? '安装项重复提供别名' : '安装项兼容性未确认'}</span>`
                : (isLocalEnabled
                    ? `<span class="modhub-conflict-tag red">${providerOverlap ? '本地别名提供者已启用' : '本地冲突已启用·兼容性未确认'}</span>`
                    : '<span class="modhub-conflict-tag green">本地已安装·当前禁用</span>');

            const targetDesc = isIncoming ? '将一并安装的' : '本地';
            const conflictModColor = (isIncoming || isLocalEnabled) ? 'red' : 'green';

            // 快捷禁用按钮（仅针对本地已安装且处于已启用状态的冲突模组）
            const disableActionHtml = (allowDisable && !isIncoming && isLocalEnabled)
                ? `
                    <div class="modhub-conflict-action-row">
                        <button type="button" class="macro-button modhub-conflict-disable-btn" data-conflict-raw="${escape(c.localConflictMod.rawName)}" data-conflict-name="${escape(c.localConflictMod.name)}">
                            快捷禁用【${escape(c.localConflictMod.name)}】
                        </button>
                    </div>
                `
                : '';

            const adviceHtml = (!isIncoming && !isLocalEnabled)
                ? `<div class="modhub-conflict-advice"><strong class="green">检查结果：</strong>本地框架当前处于禁用状态，不参与本次同时加载检查。</div>`
                : `<div class="modhub-conflict-advice"><strong class="gold">建议：</strong>${escape(c.advice)}</div>`;

            return `
                <div class="modhub-conflict-item">
                    <div class="modhub-conflict-title-row">
                        <span class="modhub-conflict-name gold">【${escape(c.incomingMod.name)}】</span>
                        <span class="grey">与${targetDesc}</span>
                        <span class="modhub-conflict-name ${conflictModColor}">【${escape(c.localConflictMod.name)}】</span>
                        <span class="grey">${providerOverlap ? '重复提供 Simple Frameworks' : '兼容性尚未确认'}</span>
                        ${statusBadge}
                    </div>
                    <div class="modhub-conflict-reason grey">${escape(c.reason)}</div>
                    ${adviceHtml}
                    ${disableActionHtml}
                </div>
            `;
        }).join('');

        const cardClass = hasActiveConflict ? 'modhub-install-conflict-card' : 'modhub-install-conflict-card is-resolved';
        const badgeHtml = hasActiveConflict
            ? '<span class="modhub-conflict-badge red">兼容性警告</span>'
            : '<span class="modhub-conflict-badge green">检查通过</span>';
        const headingHtml = hasActiveConflict
            ? '<strong class="modhub-conflict-heading red">检测到已知模组冲突</strong>'
            : '<strong class="modhub-conflict-heading green">框架同时加载风险已排除</strong>';

        return `
            <div class="${cardClass}">
                <div class="modhub-conflict-header">
                    ${badgeHtml}
                    ${headingHtml}
                </div>
                <div class="modhub-conflict-list">
                    ${itemsHtml}
                </div>
            </div>
        `;
    }

    async function disableInstallConflict(rawName, displayName, pendingTargets = [], restoreContext) {
        if (!rawName || typeof window.modHubToggleSideMod !== 'function') return false;
        await window.modHubLoadModManageState?.(true);
        const affectedMods = findDependentModsForConflict(rawName);
        const affectedText = affectedMods.map(item => `· 【${item.name}】${item.version ? ` (${item.version})` : ''}`).join('\n');
        const escape = window.modHubEscapeHtml;
        const localHtml = affectedMods.map(item => `<div class="modhub-modal-affected-item"><strong class="gold">${escape(item.name)}</strong>${item.version ? ` <span class="grey">(${escape(item.version)})</span>` : ''}</div>`).join('');
        const pendingHtml = pendingTargets.map(name => `<div class="modhub-modal-affected-item"><strong class="gold">${escape(name)}</strong></div>`).join('');
        const confirmed = await window.modHubConfirm({
            title: `确认快捷禁用【${displayName}】？`,
            message: affectedMods.length
                ? `禁用【${displayName}】后，以下依赖该框架的模组可能会受到影响或无法正常运行：\n\n${affectedText}\n\n是否仍然确认禁用？`
                : `确定要禁用【${displayName}】吗？\n禁用后会重新检查安装计划。`,
            trustedMessageHtml: `<div class="modhub-modal-intro">将禁用 <strong class="red">【${escape(displayName)}】</strong>。依赖它的模组可能无法正常运行。</div>${localHtml ? `<div class="modhub-modal-affected-box"><strong>本地受影响模组（${affectedMods.length}）</strong>${localHtml}</div>` : '<p class="grey">未发现依赖它的本地已启用模组。</p>'}${pendingHtml ? `<div class="modhub-modal-affected-box"><strong>本次安装受影响目标（${pendingTargets.length}）</strong>${pendingHtml}</div><p class="grey">本次将取消该前置的自动处理，保持禁用；上述目标需要你自行处理前置后才能正常运行。</p>` : ''}<div class="modhub-modal-question grey">禁用后将重新读取本地状态并检查兼容性。是否确认禁用？</div>`,
            dialogClass: 'modhub-install-dialog',
            confirmText: '确认禁用',
            cancelText: '暂不禁用',
            confirmType: affectedMods.length || pendingTargets.length ? 'danger' : 'warning'
        });
        if (!confirmed) return false;
        const result = await window.modHubToggleSideMod(rawName, false, { silentOfferReload: true, skipConfirm: true, restoreContext });
        if (result !== true) return false;
        await window.modHubLoadModManageState?.(true);
        const state = window._modHubModState;
        const local = state?.sideMods?.find(item => item.name === rawName);
        const disabled = local ? local.enabled === false : (state?.sideDisabled || []).includes(rawName);
        if (!disabled) {
            window.modHubShowToast(`未能确认【${displayName}】已禁用，请检查模组管理状态`, 'warning');
            return false;
        }
        window.modHubShowToast(`已快捷禁用【${displayName}】，正在重新检查安装计划`, 'success');
        if (restoreContext?.reloadOnChange) window.modHubRegisterOperationReload(restoreContext,
            `模组【${displayName}】已禁用，重新载入后生效。`, { isFramework: window.modHubIsFrameworkMod?.(rawName) });
        return true;
    }

    /** 单装和批量安装共用；每次读取当前计划，避免快捷禁用后误报冲突消除。 */
    async function confirmInstallConflicts(getActivePlan, options = {}) {
        const displayOptions = { allowDisable: options.allowDisable !== false };
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
            await window.modHubLoadModManageState?.(true);
            const initialConflicts = readConflicts();
            const initialSignature = signature(initialConflicts);
            if (!initialSignature) return true;
            let pendingChange = null;
            let clearedRisk = false;
            const choice = await window.modHubConfirm({
                title: '模组冲突风险确认',
                message: '本次安装涉及框架别名重复提供或尚未确认的同时加载兼容性，请核对具体版本与提供者。是否确认继续安装？',
                trustedMessageHtml: `<div class="modhub-install-conflict-review">${formatConflictWarningHtml(initialConflicts, displayOptions)}</div><div class="modhub-modal-conflict-question grey">请核对上述提供者与版本风险。是否确认继续安装？</div>`,
                dialogClass: 'modhub-install-dialog',
                confirmText: '继续安装',
                cancelText: '取消安装',
                confirmType: 'danger',
                confirmDelay: 5,
                onRender: dialog => {
                    const area = dialog.querySelector('.modhub-install-conflict-review');
                    const render = () => {
                        const conflicts = readConflicts();
                        if (area) area.innerHTML = formatConflictWarningHtml(conflicts, displayOptions) || '<div class="green">当前安装计划的已知冲突已排除。</div>';
                        const hasActive = activeConflicts(conflicts).length > 0;
                        if (!hasActive) {
                            clearedRisk = true;
                            dialog.modHubClearDelay?.();
                            const button = dialog.querySelector('.modhub-modal-btn-confirm');
                            if (button) {
                                button.className = button.className.replace(/\bmodhub-btn-danger\b/, 'modhub-btn-primary');
                                button.textContent = '确认安装';
                            }
                            const question = dialog.querySelector('.modhub-modal-conflict-question');
                            if (question) question.textContent = '当前安装计划的已知冲突已排除，确认后继续安装。';
                        }
                        area?.querySelectorAll('.modhub-conflict-disable-btn').forEach(button => {
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
                                        if (await disableInstallConflict(rawName, current.localConflictMod.name, options.getAffectedTargets?.(rawName), options.restoreContext)) {
                                            await options.onChanged?.(rawName);
                                        }
                                    } catch (error) {
                                        console.error('[ModHub] 快捷禁用冲突模组失败:', error);
                                        window.modHubShowToast('快捷禁用未完成，请检查模组管理器状态', 'warning');
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
            await window.modHubLoadModManageState?.(true);
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
        const cards = [...Array.from(document.querySelectorAll?.('.modhub-market-card') || []), ...Array.from(document.querySelectorAll?.('.modhub-market-variant-row') || [])];
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.modhub-download-progress');
        if (!progress) return;

        const value = state === 'active' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
        const ring = progress.querySelector('.modhub-progress-ring');
        const label = progress.querySelector('.modhub-download-label');
        const cancelButton = progress.querySelector('.modhub-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        progress.hidden = false;
        progress.classList.toggle('is-error', state === 'error');
        if (ring) {
            window.modHubSetProgressRing(ring, value);
            ring.hidden = !['active', 'installing', 'cancelling'].includes(state);
            ring.setAttribute('aria-label', modName + (state === 'installing' ? '安装进度' : state === 'cancelling' ? '取消下载进度' : '下载进度'));
        }
        label.textContent = text;
        if (cancelButton) cancelButton.hidden = state !== 'active' || !activeDownloadControllers.has(modName);
        if (button) {
            button.disabled = batchInstallState.running || !['error', 'cancelled'].includes(state);
            button.textContent = state === 'installing'
                ? '正在安装'
                : (state === 'error'
                    ? '重试'
                    : (state === 'cancelled' ? (button.dataset.idleText || '下载安装') : state === 'prepared' ? '等待确认' : state === 'cancelling' ? '正在取消' : (value === null ? '正在下载' : `下载 ${value}%`)));
        }
    }

    function resetDownloadProgress(modName) {
        downloadProgressState.delete(modName);
        const cards = [...Array.from(document.querySelectorAll?.('.modhub-market-card') || []), ...Array.from(document.querySelectorAll?.('.modhub-market-variant-row') || [])];
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.modhub-download-progress');
        if (!progress) return;
        const ring = progress.querySelector('.modhub-progress-ring');
        const label = progress.querySelector('.modhub-download-label');
        const cancelButton = progress.querySelector('.modhub-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        progress.hidden = true;
        progress.classList.remove?.('is-error');
        if (ring) { window.modHubSetProgressRing(ring, null); ring.hidden = true; }
        if (label) label.textContent = '等待下载';
        if (cancelButton) cancelButton.hidden = true;
        if (button) {
            button.disabled = batchInstallState.running;
            button.textContent = button.dataset.idleText || '下载安装';
        }
    }

    // 释放待确认的包体时同步清理卡片；成功、失败及新下载的状态由各自流程维护。
    window.modHubClearMarketPreparationProgress = function(modName, progressTargetName = modName) {
        let cleared = false;
        for (const name of new Set([modName, progressTargetName].filter(Boolean))) {
            if (downloadProgressState.get(name)?.state !== 'prepared' || activeDownloadControllers.has(name)) continue;
            resetDownloadProgress(name);
            cleared = true;
        }
        return cleared;
    };

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

    async function getPackageDigest(data) {
        if (!window.crypto?.subtle) return '';
        const bytes = typeof data?.arrayBuffer === 'function' ? await data.arrayBuffer()
            : typeof data === 'string' ? Uint8Array.from(window.atob(data), char => char.charCodeAt(0)) : data;
        if (!bytes) return '';
        const hash = await window.crypto.subtle.digest('SHA-256', bytes);
        return 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // 缺摘要的已安装条目按顺序补查官方元数据，不下载包体；复用精确标签缓存。
    function queueOfficialPackageMetadata(operation) {
        const request = officialPackageMetadataQueue.then(async () => {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
            try { return await operation(controller?.signal); }
            finally { if (timer !== null) clearTimeout(timer); }
        });
        officialPackageMetadataQueue = request.catch(() => {});
        return request;
    }

    // 只从加载器真实旁加载仓库读取精确技术名；运行时清单可能尚未重新载入。
    async function refreshLocalPackageProfiles(names, current) {
        const utils = window.modHubGetGui?.()?.gModUtils;
        const loader = utils?.getModLoader?.()?.getIndexDBLoader?.();
        const keyval = utils?.getIdbKeyValRef?.();
        const controller = window.modHubGetController?.();
        if (!loader?.customStore || typeof loader.constructor?.calcModNameKey !== 'function'
            || typeof keyval?.get !== 'function' || typeof controller?.checkModZipFileIndexDB !== 'function') return false;
        const registered = [...(window._modHubModState?.sideEnabled || []), ...(window._modHubModState?.sideDisabled || [])];
        const requested = names || registered;
        let complete = true;
        for (const name of [...new Set(requested)]) {
            if (current) {
                if (!current()) { complete = false; break; }
                // 每个包校验前让出主线程，及时处理切页并停止余下扫描。
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!current()) { complete = false; break; }
            }
            const key = String(name || '').trim().toLowerCase();
            if (!key || !registered.some(item => String(item).trim().toLowerCase() === key)) continue;
            installedPackageRecords.delete(key);
            try {
                const storedName = registered.find(item => String(item).trim().toLowerCase() === key);
                const data = await keyval.get(loader.constructor.calcModNameKey(storedName), loader.customStore);
                if (current && !current()) { complete = false; break; }
                if (!data) continue;
                const bootJson = await controller.checkModZipFileIndexDB(data);
                if (current && !current()) { complete = false; break; }
                if (String(bootJson?.name || '').trim().toLowerCase() !== key) continue;
                const digest = await getPackageDigest(data);
                if (current && !current()) { complete = false; break; }
                installedPackageRecords.set(key, { bootJson, digest });
                window._modHubDisabledModInfo?.set?.(key, { name: bootJson.name, bootJson });
            } catch (_) { complete = false; /* 无法回读时不推断已安装的发布版本。 */ }
        }
        saveInstalledPackageRecordsToStorage();
        return complete;
    }

    function getLocalProfileStamp() {
        const state = window._modHubModState;
        return JSON.stringify([state?.sideEnabled, state?.sideDisabled, window._modHubReloadRevision, localProfileRevision]);
    }

    function invalidateLocalPackageProfiles() {
        localProfileState = null;
        localProfileRevision++;
    }

    async function loadLocalPackageProfiles(forceRefresh, current) {
        const state = window._modHubModState;
        if (!forceRefresh && state && state === localProfileState && getLocalProfileStamp() === localProfileStamp) return;
        invalidateLocalPackageProfiles();
        const stamp = getLocalProfileStamp();
        if (typeof window.modHubLoadDisabledModInfo === 'function') {
            await window.modHubLoadDisabledModInfo();
            if (!current()) return;
        }
        const complete = await refreshLocalPackageProfiles(undefined,
            () => current() && state === window._modHubModState && stamp === getLocalProfileStamp());
        if (complete && current() && state && state === window._modHubModState && stamp === getLocalProfileStamp()) {
            localProfileState = state;
            localProfileStamp = stamp;
        }
    }

    function getAssetPackageDigest(asset) {
        const value = asset?.digest || downloadedPackageDigests.get(asset?.downloadUrl) || '';
        return /^sha256:[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
    }

    function isReleasePackageInstalled(release, profile) {
        const asset = getReleaseInstallAssets(release)[0];
        const digest = getAssetPackageDigest(asset);
        return digest && profile?.packageDigest ? digest === profile.packageDigest : null;
    }

    function getPublishedVersion(release) {
        const tag = String(release?.tagName || release?.releaseUrl?.match(/\/releases\/tag\/([^/?#]+)/)?.[1] || '');
        const version = tag.match(/^v?(\d+(?:\.\d+){1,3}(?:-[0-9a-z][0-9a-z.-]*)?)$/i)?.[1] || '';
        // 精确包体摘要不能证明日期标签就是产品版本，保留候选已核验的版本依据。
        return version && (!release?.version || isSameVersion(version, release.version)) ? version : '';
    }

    function isReleaseInstalled(release, profile) {
        const matched = isReleasePackageInstalled(release, profile);
        if (matched !== null) return matched;
        const published = getPublishedVersion(release);
        if (published && release?.version && !isSameVersion(published, release.version)) return false;
        return isSameVersion(release?.version, profile?.version);
    }

    function isPreparedComponentInstalled(prepared, boot) {
        return preparedMarketPackages.get(prepared)?.sameComponents?.has(String(boot?.name || '').trim().toLowerCase());
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
        const actual = (await getPackageDigest(blob)).slice(7);
        if (actual !== match[1].toLowerCase()) {
            const error = new Error('安装包 SHA-256 与 GitHub 官方摘要不一致');
            error.code = 'DIGEST_MISMATCH';
            throw error;
        }
        return true;
    }

    async function offerOriginalDownloadSource(mod, error) {
        const confirmed = await window.modHubConfirm({
            title: '请按作者说明下载',
            message: `【${mod.name}】${error.message}。\n\n是否打开该条目原始主页？`,
            confirmText: '打开主页', cancelText: '取消', confirmType: 'primary'
        });
        const url = safeHttpsUrl(mod.githubUrl || mod.otherUrl);
        if (confirmed && url) window.open(url, '_blank', 'noopener');
        return false;
    }

    function getPreparedPackageSource(mod, releaseInfo) {
        return JSON.stringify([getMarketModKey(mod), mod.githubUrl, releaseInfo?.tagName || '',
            getReleaseInstallAssets(releaseInfo).map(asset => [asset.name, asset.downloadUrl, asset.size || 0, asset.digest || '', Boolean(asset.optional), asset.bootName || '', asset.packageRole || ''])]);
    }

    function getPreparedDependencySnapshot(boots) {
        return JSON.stringify(boots.map(boot => [boot.name, boot.version, Array.isArray(boot.alias) ? boot.alias : [],
            (Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []).filter(dependency => dependency.modName !== 'GameVersion')]));
    }

    const modHubComponentDisabled = name => (window._modHubModState?.sideDisabled || []).some(item => String(item).toLowerCase() === String(name).toLowerCase())
        || (window._modHubModState?.sideMods || []).some(item => String(item.name).toLowerCase() === String(name).toLowerCase() && item.enabled === false);

    function getPreparedLocalComponentSnapshot(boots) {
        const profiles = getLocalInstalledProfiles();
        return JSON.stringify(boots.map(boot => {
            const local = profiles.find(profile => String(profile.name).trim().toLowerCase() === String(boot.name).trim().toLowerCase());
            const actual = local?.bootJson || local;
            return [boot.name, actual ? [actual.name, actual.version, actual.alias || [], actual.dependenceInfo || [], local.packageDigest || ''] : null,
                local ? !modHubComponentDisabled(local.name) : false];
        }));
    }

    function formatVersionRiskMessage(message) {
        return window.modHubEscapeHtml(String(message)).replace(/(【[^】]*】|\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/g,
            '<strong class="gold">$1</strong>').replace(/\n/g, '<br>');
    }

    function getPreparedCompatibilityRisks(boots) {
        const versions = window.modHubMarketVersions;
        if (!versions) return [];
        const gameVersion = versions.getGameVersion();
        return (boots || []).flatMap(boot => (Array.isArray(boot?.dependenceInfo) ? boot.dependenceInfo : [])
            .filter(dependency => dependency?.modName === 'GameVersion')
            .flatMap(dependency => {
                const range = String(dependency.version || '');
                const assessment = versions.assessCompatibility(range, gameVersion);
                if (assessment.status === 'compatible') return [];
                return [{ key: JSON.stringify([gameVersion, boot.name, boot.version, range]), name: boot.name,
                    version: boot.version || '', range, ...assessment }];
            }));
    }

    async function downloadAndInstallMod(mod, mirrorId = currentMirrorId, options = {}) {
        if (!mod || mod.contentType === 'spell') return false;
        if (mod._identityMetadataUnavailable) {
            const message = '无法核对该模组的身份和前置要求，请刷新市场后重试';
            window.modHubShowToast?.(message, 'warning');
            options.onFailure?.(message, 'IDENTITY_METADATA_UNAVAILABLE');
            return false;
        }
        if (!options.prepareOnly && !options.restoreContext) {
            return runMarketInstallTask(context => downloadAndInstallMod(mod, mirrorId, { ...options, restoreContext: context }),
                { label: `市场安装【${mod.name}】`, names: [mod.name], reloadOnChange: options.askRestart !== false && !options.skipReloadOffer });
        }
        let progressReported = false;
        const failBatch = (reason, code = '') => {
            if (options.prepareOnly && progressReported) {
                for (const name of new Set([mod.name, options.progressTargetName].filter(Boolean))) {
                    if (downloadProgressState.get(name)?.state === 'active') {
                        updateDownloadProgress(name, null, `${name === mod.name ? '' : options.progressPrefix || ''}${reason}`, 'error');
                    }
                }
            }
            options.onFailure?.(reason, code);
            return false;
        };
        if (isWithdrawn(mod) || (mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod))) {
            return failBatch('该来源不支持自动安装');
        }
        if (mod.catalogSource === 'community') {
            try {
                await verifyCurrentCommunityInstall(mod);
            } catch (error) {
                window.modHubShowToast?.(error.message || '无法确认社区条目的最新审核状态', 'warning');
                return failBatch(error.message || '无法确认社区条目的最新审核状态');
            }
        }
        const gui = window.modHubGetGui ? window.modHubGetGui() : null;
        if (!gui) {
            window.modHubShowToast('未找到 ModLoader 运行时实例，无法自动安装', 'warning');
            return failBatch('未找到 ModLoader 运行时实例');
        }

        const progressTargetName = options.progressTargetName || mod.name;
        const progressPrefix = options.progressPrefix || '';
        const reportProgress = (percent, text, state = 'active') => {
            progressReported = true;
            if (progressTargetName !== mod.name) updateDownloadProgress(mod.name, percent, text, state);
            updateDownloadProgress(progressTargetName, percent, `${progressPrefix}${text}`, state);
        };

        const preparedPackage = options.preparedPackage || null;
        const preparedSnapshot = preparedPackage && preparedMarketPackages.get(preparedPackage);
        let releaseInfo = options.releaseInfo || preparedPackage?.releaseInfo || null;
        if (preparedPackage && (!preparedSnapshot
            || preparedSnapshot.source !== getPreparedPackageSource(mod, releaseInfo)
            || preparedSnapshot.files.length !== preparedPackage.files?.length
            || preparedSnapshot.files.some((file, index) => file !== preparedPackage.files[index]))) {
            return failBatch('所选版本或安装包已变化，请重新核验');
        }
        let installAssets = [];
        let targetVersion = mod.version || '';

        // 1. 获取 Release 信息
        reportProgress(null, '正在获取发布信息...');
        window.modHubShowToast(`正在获取【${mod.name}】发布信息...`, 'info');
        try {
            if (!releaseInfo) releaseInfo = await fetchModRelease(mod, { useCache: true });
            installAssets = getReleaseInstallAssets(releaseInfo);
            if (releaseInfo.version) targetVersion = releaseInfo.version;
        } catch (err) {
            console.warn('[ModHub] 读取 Release 失败，尝试回退', err);
            if (options.batchMode) return failBatch(err?.message || '读取发布包失败');
            if (['MANUAL_SOURCE', 'RELEASE_NOT_FOUND'].includes(err?.code)) {
                resetDownloadProgress(mod.name);
                return offerOriginalDownloadSource(mod, err);
            }
            if (err?.code === 'REPO_NOT_FOUND' || err?.status === 404 || mod._isDeadRepo || isDeadRepo(mod.githubUrl)) {
                reportProgress(null, '模组仓库已被作者移除', 'error');
                if (typeof window.modHubAlert === 'function') {
                    await window.modHubAlert('该模组的 GitHub 仓库已被作者移除或不存在 (404)，无法下载更新。\n\n已自动更新本地模组状态为无需更新。', '模组仓库已失效');
                }
                if (typeof renderMarketCards === 'function') renderMarketCards();
                return false;
            }
        }

        if (releaseInfo?.requiresManualSelection) {
            if (options.batchMode) return failBatch('需要重新选择兼容安装包');
            reportProgress(null, '需要手动选择兼容安装包', 'error');
            const selectedMirror = resolveMirrorServer(mirrorId);
            const choice = await window.modHubConfirm({
                title: '请选择对应的安装包',
                message: `${releaseInfo.selectionReason}。请从候选文件中明确选择一个安装包。`,
                trustedMessageHtml: formatReleaseInstallPlanHtml(releaseInfo, selectedMirror),
                dialogClass: 'modhub-install-dialog',
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
            const ok = await window.modHubConfirm({
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
            window.modHubShowToast(`已为您启动浏览器下载 ${installAssets.length} 个安装包`, 'info');
            reportProgress(null, '浏览器下载已启动，请下载后手动导入');

            const tipMsg = `模组【${mod.name}】的 ${installAssets.length} 个安装包已通过浏览器启动下载：\n\n${fileNames}\n\n【安装指引】：\n待浏览器下载完成后，点击下方【选择已下载的文件导入】，同时选中这些文件即可完成安装。`;
            if (typeof window.modHubConfirm === 'function') {
                const choice = await window.modHubConfirm({
                    title: '浏览器下载已启动',
                    message: tipMsg,
                    confirmText: '选择已下载的文件导入',
                    cancelText: '我知道了',
                    confirmType: 'primary'
                });
                if (choice && typeof window.modHubTriggerImport === 'function') {
                    window.modHubTriggerImport();
                }
            }
            return false;
        };

        // GitHub Release 最终下载域不提供 CORS，直连只能交给浏览器下载后手动导入。
        if (selectedMirror.browserOnly && !preparedPackage) return (options.batchMode || options.prepareOnly)
            ? failBatch('当前线路只能手动下载') : startBrowserDownload();

        window.modHubShowToast(`正在获取【${mod.name}】的 ${installAssets.length} 个安装包...`, 'warning');

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const cancelKeys = [...new Set([mod.name, progressTargetName].filter(Boolean))];
        const clearActiveDownload = () => cancelKeys.forEach(key => {
            if (activeDownloadControllers.get(key) === controller) activeDownloadControllers.delete(key);
        });
        if (controller) cancelKeys.forEach(key => activeDownloadControllers.set(key, controller));
        let failedMirror = selectedMirror;
        reportProgress(null, `正在连接 ${selectedMirror.name}...`);

        try {
            const fileObjects = preparedSnapshot ? preparedSnapshot.files.slice() : [];
            const preparedLimit = options.maxPreparedBytes === undefined ? MAX_DOWNLOAD_BYTES
                : Math.min(MAX_DOWNLOAD_BYTES, Number(options.maxPreparedBytes));
            if (!(preparedLimit >= 0) || (preparedSnapshot && preparedPackage.bytes > preparedLimit)) throw createFileTooLargeError();
            let activeMirror = selectedMirror;
            const availableMirrors = [
                selectedMirror,
                ...MIRROR_SERVERS.filter(m => !m.browserOnly && m.id !== selectedMirror.id)
            ];

            for (let assetIndex = 0; !preparedSnapshot && assetIndex < installAssets.length; assetIndex++) {
                const asset = installAssets[assetIndex];
                const fileName = asset.name || `${mod.name}-${assetIndex + 1}.zip`;
                const assetSize = Number(asset.size) || 0;
                const assetDigest = asset.digest || '';
                const remainingBytes = preparedLimit - fileObjects.reduce((sum, file) => sum + file.size, 0);
                if (remainingBytes <= 0 || assetSize > remainingBytes) throw createFileTooLargeError();

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
                        console.warn(`[ModHub] 下载线路故障转移，正在自动切换至 ${currentCandidate.name} 下载【${fileName}】`);
                        window.modHubShowToast(`【${fileName}】正在自动切换至 ${currentCandidate.name}...`, 'warning');
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
                                reportProgress(
                                    percent,
                                    `${assetIndex + 1}/${installAssets.length} ${percent === null ? '正在接收' : `正在下载 ${Math.round(percent)}%`}：${fileName}`
                                );
                            }, remainingBytes, assetSize);

                            if (assetSize && blob.size !== assetSize) {
                                const error = new Error(`安装包大小不完整（预期 ${assetSize} 字节，实际 ${blob.size} 字节）`);
                                error.code = 'DOWNLOAD_INCOMPLETE';
                                throw error;
                            }

                            await verifyAssetDigest(blob, assetDigest);
                            const digest = await getPackageDigest(blob);
                            if (digest) downloadedPackageDigests.set(asset.downloadUrl, digest);
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
                                console.warn(`[ModHub] ${currentCandidate.name} 下载中断，自动重试一次:`, err);
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

                const contentType = /\.modpack(?:\.crypt)?$/i.test(fileName) ? 'application/octet-stream' : 'application/zip';
                try {
                    fileObjects.push(new File([blob], fileName, { type: contentType }));
                } catch {
                    const fileBlob = new Blob([blob], { type: contentType });
                    fileBlob.name = fileName;
                    fileObjects.push(fileBlob);
                }
            }
            // 写入前统一核验所有包，避免主包错误或附属包无效时留下部分安装。
            const modController = window.modHubGetController?.() || gui.modModLoadController;
            const communityInstall = mod.catalogSource === 'community' && mod.autoInstall === true;
            const boots = [];
            const sameComponents = new Set();
            if ((options.prepareOnly || preparedPackage || communityInstall || options.dependencyRequirements?.some(item => item.bootVersions))
                && typeof modController?.checkModZipFileIndexDB !== 'function') {
                const error = new Error(communityInstall
                    ? '当前 ModLoader 无法核验社区模组安装包，请手动下载并导入。'
                    : '当前 ModLoader 无法核验所选安装包，请手动下载并导入。');
                error.code = 'INSTALL_PACKAGE_INVALID';
                throw error;
            }
            if (typeof modController?.checkModZipFileIndexDB === 'function') {
                const auModelName = (mod.identityId || mod.id) === 'au-beautification'
                    ? mod._matchedLocal?.name || mod.bootNames?.find(name => normalizeKey(name) === getAssetSeries(fileObjects[0]?.name)) : '';
                const expectedNames = (auModelName ? [auModelName] : (mod.bootNames?.length ? mod.bootNames : [mod._matchedLocal?.name]))
                    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().toLowerCase());
                if (communityInstall && (!mod.bootNames?.length || !expectedNames.length)) {
                    const error = new Error('社区模组缺少已确认的技术名，无法核验安装包身份。');
                    error.code = 'INSTALL_PACKAGE_INVALID';
                    throw error;
                }
                for (const [index, file] of fileObjects.entries()) {
                    try {
                        const boot = await modController.checkModZipFileIndexDB(new Uint8Array(await file.arrayBuffer()));
                        const actualName = typeof boot?.name === 'string' ? boot.name.trim() : '';
                        if (!actualName || typeof boot !== 'object' || Array.isArray(boot)) {
                            throw new Error(`【${file.name}】没有可识别的模组清单，不能作为 ModLoader 模组导入。`);
                        }
                        if ((index === 0 || communityInstall) && expectedNames.length && !expectedNames.includes(actualName.toLowerCase())) {
                            throw new Error(`所选【${mod.name}】的安装包实际为【${actualName}】，与已确认的模组身份不符，已停止安装。`);
                        }
                        const asset = installAssets[index];
                        if (asset?.optional && (asset.bootName ? actualName.toLowerCase() !== asset.bootName.toLowerCase()
                            : getAssetSeries(actualName) !== getAssetSeries(asset.name))) {
                            throw new Error(`所选扩展【${file.name}】实际为【${actualName}】，与扩展身份不符，已停止安装。`);
                        }
                        if (boots.some(item => item.name.toLowerCase() === actualName.toLowerCase())) {
                            throw new Error(`所选安装文件重复提供【${actualName}】，请重新选择安装包。`);
                        }
                        await refreshLocalPackageProfiles([actualName]);
                        const profile = getLocalInstalledProfiles().find(local => String(local.name).trim().toLowerCase() === actualName.toLowerCase());
                        const fileDigest = await getPackageDigest(file);
                        const sameBytes = profile?.packageDigest && fileDigest ? profile.packageDigest === fileDigest
                            : isSameVersion(boot.version, profile?.version);
                        if (sameBytes) sameComponents.add(actualName.toLowerCase());
                        if (index === 0) {
                            const effectiveBoot = sameBytes ? profile.bootJson || profile : boot;
                            const unmet = options.dependencyRequirements?.filter(dependency => !satisfiesDependency(effectiveBoot, dependency)) || [];
                            if (unmet.length) {
                                const requirements = unmet.map(dependency => {
                                    const range = getDependencyVersion(dependency, boot);
                                    return range ? formatVersionRange(range) : formatDependencyRequirement(dependency);
                                }).join('、');
                                throw new Error(`所选前置【${actualName}】版本 ${boot.version || '未知'} 不满足依赖要求（需要 ${requirements}），已停止安装。`);
                            }
                        }
                        boots.push(boot);
                    } catch (error) {
                        const failure = new Error(error?.message || '无法读取安装包的模组清单');
                        failure.code = 'INSTALL_PACKAGE_INVALID';
                        throw failure;
                    }
                }
            }
            if (controller?.signal.aborted) throw Object.assign(new Error('已取消包体核验'), { name: 'AbortError' });
            if (preparedSnapshot && preparedSnapshot.dependencies !== getPreparedDependencySnapshot(boots)) {
                throw Object.assign(new Error('安装包的身份、版本或前置声明已变化，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
            }
            const checkedLocalComponents = getPreparedLocalComponentSnapshot(boots);
            if (preparedSnapshot && preparedSnapshot.localComponents !== checkedLocalComponents) {
                throw Object.assign(new Error('本地组件版本、依赖或启用状态已变化，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
            }
            if (options.prepareOnly) {
                const prepared = { files: fileObjects, boots, releaseInfo,
                    bytes: fileObjects.reduce((sum, file) => sum + file.size, 0),
                    modKey: getMarketModKey(mod), sourceFingerprint: getPreparedPackageSource(mod, releaseInfo) };
                preparedMarketPackages.set(prepared, { source: prepared.sourceFingerprint, files: fileObjects.slice(),
                    sameComponents, dependencies: getPreparedDependencySnapshot(boots), localComponents: checkedLocalComponents });
                clearActiveDownload();
                reportProgress(100, '包体已核验，等待确认安装计划', 'prepared');
                return prepared;
            }
            const componentProfiles = getLocalInstalledProfiles();
            const sameComponent = boot => boot && componentProfiles.find(profile =>
                String(profile.name).trim().toLowerCase() === String(boot.name).trim().toLowerCase() && sameComponents.has(String(boot.name).trim().toLowerCase()));
            const effectiveBoots = boots.map(boot => { const profile = sameComponent(boot); return profile?.bootJson || profile || boot; });
            const approvedRisks = new Set(options.approvedCompatibilityRisks || []);
            const newRisks = getPreparedCompatibilityRisks(effectiveBoots).filter(risk => !approvedRisks.has(risk.key));
            if (newRisks.length) {
                const gameVersion = window.modHubMarketVersions?.getGameVersion();
                const localProfiles = getLocalInstalledProfiles();
                const context = `当前游戏版本：${gameVersion ? `DoL ${gameVersion}` : '未识别'}\n\n` + newRisks.map(risk => {
                    const local = localProfiles.find(profile => String(profile.name).trim().toLowerCase() === String(risk.name).trim().toLowerCase());
                    return `【${risk.name}】\n当前已安装版本：${local ? local.version || '未识别' : '未安装'}；所选模组版本：${risk.version || '未识别'}`;
                }).join('\n\n');
                const message = context + '\n\n' + newRisks.map(risk => `【${risk.name}】需要游戏版本：${formatVersionRange(risk.range)}，${risk.reason}`).join('\n')
                    + '\n\n实际安装包的声明与当前游戏不匹配或无法核验，是否继续安装？';
                const accepted = await window.modHubConfirm({
                    title: '所选包的游戏兼容性需要确认',
                    message, trustedMessageHtml: formatVersionRiskMessage(message),
                    confirmText: '仍然安装', cancelText: '取消', confirmType: 'danger'
                });
                if (!accepted) {
                    clearActiveDownload();
                    resetDownloadProgress(mod.name);
                    if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                    return failBatch('已取消游戏兼容性风险确认');
                }
            }
            reportProgress(100, installAssets.length === 1 ? '下载完成，正在安装...' : `${installAssets.length} 个安装包下载完成，正在安装...`, 'installing');

            const filesToImport = fileObjects.filter((file, index) => !sameComponent(boots[index]));

            // 3. 构造虚拟文件列表并一次性交给 ModLoader 批量导入。
            let dummyInput = document.createElement('input');
            dummyInput.type = 'file';
            dummyInput.multiple = true;

            if (typeof DataTransfer !== 'undefined') {
                try {
                    const dt = new DataTransfer();
                    filesToImport.forEach(fileObj => dt.items.add(fileObj));
                    dummyInput.files = dt.files;
                } catch (_) {
                    dummyInput.files = filesToImport;
                }
            } else {
                dummyInput.files = filesToImport;
            }

            // 4. 调用已有的智能模组导入器
            const askRestart = options.askRestart !== undefined ? options.askRestart : true;
            // 安装前先确认模组管理器空闲：管理器在保存 / 读取配置时会直接拒绝写入，
            // 若不做等待与提示，用户只会看到一次毫无原因的「安装未完成」。
            if (typeof window.modHubWaitManagerIdle === 'function' && !await window.modHubWaitManagerIdle()) {
                clearActiveDownload();
                reportProgress(null, '模组管理器正在保存其他配置，请稍后再试', 'error');
                return failBatch('模组管理器正忙，请稍后重试');
            }
            const readImportRequirements = () => {
                if (Array.isArray(mod.requiredDependencies) && mod.requiredDependencies.length
                    && !window.modHubMarketVariants?.normalizeRequiredDependencies) {
                    throw Object.assign(new Error('目录必需前置校验模块不可用，已停止安装'), { code: 'INSTALL_PACKAGE_INVALID' });
                }
                return window.modHubMarketVariants?.normalizeRequiredDependencies(mod.requiredDependencies) || [];
            };
            const requiredSnapshot = JSON.stringify(readImportRequirements());
            const validateRequiredDependencies = async () => {
                const requirements = readImportRequirements();
                if (JSON.stringify(requirements) !== requiredSnapshot) throw Object.assign(new Error('目录必需前置已改变，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
                if (!requirements.length) return;
                await refreshLocalPackageProfiles();
                const profiles = getLocalInstalledProfiles();
                for (const requirement of requirements) {
                    const target = requirement.modName.toLowerCase();
                    const providers = profiles.filter(profile => {
                        const boot = profile.bootJson || profile;
                        return [boot.name, ...(Array.isArray(boot.alias) ? boot.alias : [])].some(name => typeof name === 'string' && name.trim().toLowerCase() === target);
                    });
                    const provider = providers.length === 1 ? providers[0] : null;
                    const boot = provider?.bootJson || provider;
                    if (!provider || modHubComponentDisabled(provider.name) || !satisfiesDependency(boot, { version: requirement.version })) {
                        throw Object.assign(new Error(`目录必需前置【${requirement.modName}】缺失、已禁用、身份不明确或版本不符。请先安装并启用满足要求的前置，已停止安装。`), { code: 'INSTALL_PACKAGE_INVALID' });
                    }
                }
            };
            await refreshLocalPackageProfiles(boots.map(boot => boot.name));
            await validateRequiredDependencies();
            if (controller?.signal.aborted) throw Object.assign(new Error('已取消安装'), { name: 'AbortError' });
            const primaryBoot = boots[0];
            if (checkedLocalComponents !== getPreparedLocalComponentSnapshot(boots)) {
                throw Object.assign(new Error('等待写入时本地组件状态已变化，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
            }
            if (!filesToImport.length && !boots.some(boot => sameComponent(boot) && modHubComponentDisabled(boot.name))) {
                clearActiveDownload();
                resetDownloadProgress(mod.name);
                if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                window.modHubShowToast('当前所选版本已安装，无需重复安装', 'info');
                return failBatch('当前所选版本已安装，无需重复安装', 'ALREADY_INSTALLED');
            }
            if (filesToImport.length && typeof window.modHubHandleAddMod !== 'function' && options.restoreContext && window.modHubRestore?.prepare &&
                !await window.modHubRestore.prepare(options.restoreContext)) return failBatch('已取消没有还原点的安装');
            if (!filesToImport.length) {
                // 同版且已禁用的组件由确认计划后的管理器操作启用，不重新写入包体。
            } else if (typeof window.modHubHandleAddMod === 'function') {
                const installed = await window.modHubHandleAddMod(dummyInput.files && dummyInput.files.length > 0 ? dummyInput : filesToImport, {
                    askRestart,
                    skipReloadOffer: options.skipReloadOffer,
                    // 市场内安装：「稍后重载」后停留市场页签，方便玩家连续安装多个模组
                    keepCurrentTab: true,
                    restoreContext: options.restoreContext,
                    targetModName: filesToImport[0] === fileObjects[0] ? mod._matchedLocal?.name || '' : '',
                    displayName: mod.name || '',
                    beforeImport: validateRequiredDependencies
                });
                if (installed === false || (options.batchMode && installed !== true)) {
                    clearActiveDownload();
                    const reason = String(window._modHubLastInstallError || '').trim();
                    reportProgress(null, reason ? `安装未完成：${reason}` : '安装未完成，请检查管理器提示后重试', 'error');
                    return failBatch(reason || '安装未完成');
                }
            } else if (typeof window.modHubInstallFilesViaIndexDB === 'function') {
                await window.modHubInstallFilesViaIndexDB(filesToImport);
            } else if (typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(dummyInput);
                invalidateLocalPackageProfiles();
            } else {
                throw new Error('未找到 ModLoader 导入执行接口');
            }
            if (options.restoreContext?.reloadOnChange) window.modHubRegisterOperationReload(options.restoreContext,
                `模组【${mod.name}】已成功安装并载入配置。`, { isFramework: window.modHubIsFrameworkMod?.(mod.name) });

            // 安装完毕后记录版本确权，防止第三方 zip 内 boot.json 漏改版本号导致死循环更新
            const installedVer = (preparedPackage ? boots[0]?.version : '') || targetVersion || mod.version;
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
                if (typeof window.modHubLoadModManageState === 'function') {
                    await window.modHubLoadModManageState(true);
                }
                await refreshLocalPackageProfiles(boots.map(boot => boot.name));
            } catch (refreshError) {
                console.warn('[ModHub] 安装后刷新本地模组档案失败', refreshError);
            }
            renderMarketCards();
            // 安装已经成功却仍判为未安装时，明确记录原因，便于用户与作者定位别名匹配问题
            try {
                if (checkModInstallStatus(mod, getLocalInstalledProfiles()) === 'not_installed') {
                    console.warn(`[ModHub] 模组【${mod.name}】安装成功，但市场未能与本地记录匹配（可能为别名或版本识别问题）`);
                }
            } catch (_) {}
            return true;
        } catch (err) {
            clearActiveDownload();
            if (controller?.signal.aborted || err?.name === 'AbortError') {
                resetDownloadProgress(mod.name);
                if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                window.modHubShowToast(`已取消【${mod.name}】的下载`, 'info');
                return failBatch('已取消下载');
            }
            const isTooLarge = err?.code === 'FILE_TOO_LARGE';
            const isDigestFailure = ['DIGEST_MISMATCH', 'DIGEST_UNSUPPORTED', 'DIGEST_UNAVAILABLE'].includes(err?.code);
            if (err?.code === 'INSTALL_PACKAGE_INVALID') {
                reportProgress(null, err.message, 'error');
                if (!options.batchMode) await window.modHubAlert(err.message, '安装包校验失败');
                return failBatch(err.message, err.code);
            }
            console.warn('[ModHub] 页面内自动安装失败:', err);
            reportProgress(null, isDigestFailure ? '完整性校验失败，已阻止安装' : (isTooLarge ? '安装包较大，可改用浏览器下载' : '自动安装失败，请重试或改用浏览器下载'), 'error');

            if (options.batchMode || options.prepareOnly) return failBatch(err?.message || '下载或安装失败', err?.code || '');

            if (isDigestFailure) {
                if (typeof window.modHubAlert === 'function') {
                    await window.modHubAlert(`模组【${mod.name}】的安装包未能通过 GitHub 官方 SHA-256 完整性校验，已阻止安装。\n\n请切换至 GitHub 直连后手动下载。`, '安装包完整性校验失败');
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
            if (typeof window.modHubConfirm === 'function') {
                retryMirrorId = await window.modHubConfirm({
                    title: '自动安装失败',
                    message: fallbackMsg,
                    selectLabel: '重试线路',
                    selectOptions: alternatives.map(mirror => ({ value: mirror.id, label: mirror.name })),
                    selectValue: alternatives[0]?.id || '',
                    confirmText: '切换并重试',
                    cancelText: '取消',
                    confirmType: 'primary'
                });
            } else if (typeof window.modHubAlert === 'function') {
                await window.modHubAlert(fallbackMsg, '自动安装失败');
            }
            if (!MIRROR_SERVERS.some(mirror => mirror.id === retryMirrorId)) return false;
            setCurrentMirror(retryMirrorId);
            return downloadAndInstallMod(mod, retryMirrorId, options);
        }
    }

    // ==================== 界面渲染逻辑 ====================

    function protectCachedIdentityMetadata(mods, catalog) {
        return mods.map(mod => {
            const unavailable = Boolean(mod.identityId) && (!catalog || !registeredIdentityMetadata.has(mod.identityId));
            return { ...mod, _identityMetadataUnavailable: unavailable,
                autoInstall: unavailable ? false : mod.autoInstall };
        });
    }

    function loadMarketData(forceRefresh = false) {
        if (marketDataRequest) {
            if (forceRefresh && !marketDataRefreshing) {
                return marketDataRequest.catch(() => {}).then(() => loadMarketData(true));
            }
            return marketDataRequest;
        }
        marketDataRefreshing = forceRefresh;
        marketDataRequest = fetchMarketData(forceRefresh).then(mods => {
            marketDataLoaded = true;
            return mods;
        }).finally(() => {
            marketDataRequest = null;
            marketDataRefreshing = false;
        });
        return marketDataRequest;
    }

    async function fetchMarketData(forceRefresh) {
        if (forceRefresh) {
            marketHistoryRefresh++;
            modUpdateChecks.clear();
        }
        if (!forceRefresh && marketDataLoaded) return marketModList;

        try {
            marketModList = await fetchReleaseIndex();
            renderBatchInstallToolbar();
            return marketModList;
        } catch (error) {
            console.warn('[ModHub] Cloudflare 自动版本索引不可用，尝试本地缓存或 Wiki', error);
        }

        const identityPromise = loadIdentityCatalog(forceRefresh);
        window.modHubMarketSpells?.restoreCache(withdrawnRevision);
        const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
        if (Array.isArray(stale)) {
            const catalog = await identityPromise;
            window.modHubMarketSpells?.restoreCache(withdrawnRevision);
            marketModList = protectCachedIdentityMetadata(normalizeReleaseIndex({ schemaVersion: 1, mods: stale }), catalog);
            renderBatchInstallToolbar();
            return marketModList;
        }

        const params = new URLSearchParams({
            action: 'parse',
            page: WIKI_PAGE,
            format: 'json',
            prop: 'text',
            origin: '*'
        });

        try {
            const [data] = await Promise.all([
                fetchMarketJson(`${WIKI_API}?${params.toString()}`, 'Wiki API'),
                identityPromise
            ]);
            if (!data.parse || !data.parse.text) throw new Error('Wiki 数据格式解析异常');

            marketModList = parseModsFromHtml(data.parse.text['*']).filter(mod => !isWithdrawn(mod));
            writeLocalCache(WIKI_CACHE_KEY, marketModList);
            renderBatchInstallToolbar();
            return marketModList;
        } catch (error) {
            const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
            if (Array.isArray(stale)) {
                const catalog = await identityPromise;
                window.modHubMarketSpells?.restoreCache(withdrawnRevision);
                marketModList = protectCachedIdentityMetadata(normalizeReleaseIndex({ schemaVersion: 1, mods: stale }), catalog);
                renderBatchInstallToolbar();
                return marketModList;
            }
            throw error;
        }
    }

    function isMarketSourceVisible(mod) {
        return !isWithdrawn(mod) && (!hideDeadSources || !isDeadRepo(mod.githubUrl, mod));
    }

    function filterAndSortMods() {
        const profiles = getLocalInstalledProfiles();
        let list = marketModList.map((mod, marketIndex) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: marketIndex };
        });

        list = list.filter(isMarketSourceVisible);

        // 1. 主分类过滤
        if (currentCategory !== 'all') {
            list = list.filter(m => m.category === currentCategory);
        }

        // 2. 状态过滤
        if (currentStatusFilter === 'installable') {
            list = list.filter(m => m._status === 'not_installed' || m._status === 'update_available');
        } else if (currentStatusFilter === 'installed') {
            list = list.filter(m => ['up_to_date', 'update_available', 'external_installed'].includes(m._status));
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
                (window.modHubMarketVariants?.normalizeVariant(m.variant)?.groupName.toLowerCase().includes(kw)) ||
                (window.modHubMarketVariants?.normalizeVariant(m.variant)?.label.toLowerCase().includes(kw)) ||
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
                const getEffectiveDate = (m) => {
                    // 列表按当前产品的最新发布排序，不使用适配推荐的旧版本日期。
                    return getLatestMarketVersionInfo(m).updateDate || m.updateDate || '1970-01-01';
                };
                const da = getEffectiveDate(a);
                const db = getEffectiveDate(b);
                const cmp = db.localeCompare(da);
                if (cmp !== 0) return cmp;
                return (a.name || '').localeCompare(b.name || '', 'zh-CN');
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
            : (marketDataLoaded || marketModList.length ? marketModList : (readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true) || []));
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
            if (isWithdrawn(mod)) continue;
            const candidate = { ...mod };
            checkModInstallStatus(candidate, [localProfile]);
            if (candidate._matchedLocal && candidate._matchedScore >= 80) {
                let score = candidate._matchedScore || 80;
                const modRepoKey = extractRepoKey(candidate.githubUrl);
                const normName = normalizeKey(modName);
                const knownRepos = MODHUB_KNOWN_MOD_REPOSITORY_KEYS[normName] || [];
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
        const list = marketDataLoaded || marketModList.length ? marketModList : (readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true) || []);
        if (!Array.isArray(list) || !list.length) return '';

        const knownRepos = MODHUB_KNOWN_MOD_REPOSITORY_KEYS[norm] || [];
        const names = new Set([norm, ...(MODHUB_KNOWN_MOD_MARKET_ALIASES[norm] || []).map(normalizeKey)]);
        const matches = list.filter(m => {
            if (isWithdrawn(m)) return false;
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
        const statsEl = document.getElementById('modHubMarketStats');
        if (!statsEl) return;
        const selectedMirror = MIRROR_SERVERS.find(mirror => mirror.id === currentMirrorId) || MIRROR_SERVERS[0];
        const updateAllBtnHtml = updatableCount > 0
            ? `<button type="button" class="macro-button modhub-market-update-all" onclick="window.modHubMarket.updateAllMods()" title="更新全部 ${updatableCount} 个可更新模组">一键更新全部模组</button>`
            : '';

        statsEl.innerHTML = `
            <div class="childItem modhub-stat-card modhub-clickable ${isStatsFilterActive('all') ? 'is-selected' : ''}" onclick="window.modHubMarket.resetFilters()" title="点击清除所有筛选，查看全部社区收录模组">
                <div class="modhub-stat-num gold">${allCount}</div>
                <div class="grey modhub-stat-label">社区收录</div>
            </div>
            <div class="childItem modhub-stat-card modhub-clickable ${isStatsFilterActive('installed') ? 'is-selected' : ''}" onclick="window.modHubMarket.filterInstalledOnly()" title="点击仅查看本地已安装模组">
                <div class="modhub-stat-num green">${installedCount}</div>
                <div class="grey modhub-stat-label">本地已装</div>
            </div>
            <div class="childItem modhub-stat-card modhub-clickable ${isStatsFilterActive('updatable') ? 'is-selected' : ''}" onclick="window.modHubMarket.filterUpdatableOnly()" title="点击仅查看发现新版的模组">
                <div class="modhub-stat-num ${updatableCount > 0 ? 'gold modhub-pulse-gold' : ''}">${updatableCount}</div>
                <div class="grey modhub-stat-label">发现新版</div>
            </div>
            <div class="childItem modhub-stat-card" title="当前线路：${selectedMirror.name}">
                <div class="modhub-stat-num">${selectedMirror.shortName}</div>
                <div class="grey modhub-stat-label">下载线路</div>
            </div>
            ${updateAllBtnHtml}
        `;
    }

    function renderIgnoredFilterLink(ignoredCount) {
        const btn = document.getElementById('modHubMarketBtnIgnored');
        if (!btn) return;
        btn.hidden = ignoredCount === 0;
        btn.textContent = `查看已忽略模组（${ignoredCount}）`;
        btn.classList.toggle('is-selected', currentStatusFilter === 'ignored');
        btn.setAttribute('aria-pressed', currentStatusFilter === 'ignored' ? 'true' : 'false');
    }

    /** 目录最新版本与当前游戏的适配候选分开；本地版本仅用于已安装版本。 */
    function getLatestMarketVersionInfo(mod) {
        const indexedVersionSource = ['github', 'wiki'].includes(mod.versionSource)
            || safeHttpsUrl(mod.releaseUrl) || safeHttpsUrl(mod.downloadUrl)
            || mod.assets?.some(asset => safeHttpsUrl(asset.downloadUrl));
        const indexedVersion = !indexedVersionSource ? '' : typeof mod.releaseAssetVersion === 'string' && mod.releaseAssetVersion.trim()
            ? mod.releaseAssetVersion.trim() : typeof mod.version === 'string' ? mod.version.trim() : '';
        const currentUpdate = mod._updateCheck?.signature === getModUpdateSignature(mod, window.modHubMarketVersions?.getGameVersion?.())
            && !isWithdrawn(mod) && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod) ? mod._updateCheck : null;
        const latestRelease = currentUpdate?.latestRelease;
        const indexDate = mod.updateDate || '';
        if (latestRelease?.version && compareVersions(latestRelease.version, indexedVersion) > 0) {
            return { version: latestRelease.version, text: formatVersionDisplay(latestRelease.version),
                updateDate: latestRelease.updateDate || indexDate,
                updateDateSource: latestRelease.updateDate ? latestRelease.updateDateSource || 'github' : mod.updateDateSource };
        }
        if (!indexedVersionSource) return { version: '', text: '未知' };
        const release = currentUpdate?.release;
        const published = getPublishedVersion(release);
        const latestPublished = getPublishedVersion(mod) || mod.version;
        if (mod._matchedLocal?.packageDigest && published && getAssetPackageDigest(getReleaseInstallAssets(release)[0])
            && isSameVersion(published, latestPublished)) {
            return { version: published, text: formatVersionDisplay(published), updateDate: indexDate,
                updateDateSource: mod.updateDateSource };
        }
        const label = typeof mod.versionLabel === 'string' && mod.versionLabel.trim()
            ? mod.versionLabel.trim() : !indexedVersion && latestRelease ? latestRelease.versionLabel || latestRelease.tagName || '' : '';
        return { version: indexedVersion, text: indexedVersion ? formatVersionDisplay(indexedVersion)
            : label || '未知', updateDate: !indexedVersion && latestRelease?.updateDate || indexDate,
            updateDateSource: !indexedVersion && latestRelease?.updateDate ? latestRelease.updateDateSource || 'github' : mod.updateDateSource };
    }

    /** 安装事实与适配检查独立显示，未知结果不能覆盖已核实的相同版本。 */
    function getInstalledMarketBadgeInfo(mod, updateInfo, latestVersion) {
        const localVersion = mod._matchedLocal?.version || '';
        const details = [];
        let label = '已安装';
        let title = '';
        if (!localVersion) details.push('无法识别已安装版本');
        if (!latestVersion) details.push('未能获取最新版本');
        const packageMatch = isReleasePackageInstalled(updateInfo.release, mod._matchedLocal);
        const published = getPublishedVersion(updateInfo.release) || updateInfo.version;
        const publishedVersion = getPublishedVersion(updateInfo.release) || getPublishedVersion(mod);
        const unpublishedDifference = publishedVersion && !isSameVersion(publishedVersion, latestVersion);
        if (packageMatch === true && isSameVersion(published, latestVersion)
            || packageMatch !== false && !unpublishedDifference && localVersion && latestVersion && isSameVersion(localVersion, latestVersion)) {
            label = '已是最新';
            title = '与当前目录最新版本相同';
        } else if (localVersion && latestVersion && compareVersions(localVersion, latestVersion) > 0) {
            title = `当前已安装版本 (${formatVersionDisplay(localVersion)}) 高于市场目录收录版本 (${formatVersionDisplay(latestVersion)})。`;
        } else if (localVersion && latestVersion && updateInfo.release && isSameVersion(localVersion, updateInfo.version)
            && ['declaration', 'filename'].includes(updateInfo.release.compatibility?.evidence)
            && compareVersions(latestVersion, localVersion) > 0) {
            label = '已是推荐版本';
            title = `当前游戏推荐版本与已安装版本相同；目录最新版本 ${formatVersionDisplay(latestVersion)} 更高。`
                + (updateInfo.release.compatibility?.evidence === 'filename' ? '推荐依据安装包名称参考，不代表游戏实测。' : '推荐依据作者声明，不代表游戏实测。');
        } else if (localVersion && latestVersion && mod._updateCheck && !updateInfo.version && !updateInfo.error
            && (!updateInfo.pending || !window.modHubMarketVersions?.getGameVersion?.())) {
            if (compareVersions(localVersion, latestVersion) < 0) {
                details.push(window.modHubMarketVersions?.getGameVersion?.()
                    ? '未找到适配当前游戏的版本' : '无法识别当前游戏版本，尚未检查适配更新');
            }
        }
        if (updateInfo.pending) details.push('正在检查更新，请稍候。');
        if (updateInfo.error) {
            if (localVersion && latestVersion && compareVersions(localVersion, latestVersion) >= 0) {
                // 本地已是高版本或最新版本时，远端更新检查临时失败不作为阻断性错误呈现
            } else {
                details.push(`更新检查失败：${updateInfo.error}。可刷新市场后重试。`);
            }
        }
        const detail = details.join('；');
        return { label, title: [title, detail].filter(Boolean).join('；'), detail };
    }

    function renderLanguageGroupCard(group, profiles, escapeHtml) {
        const installed = group.variants.filter(mod => mod._matchedLocal);
        const active = group.variants.find(mod => getMarketModKey(mod) === selectedMarketLanguages.get(group.variantGroupId))
            || (installed.length === 1 ? installed[0] : group.variants[0]);
        selectedMarketLanguages.set(group.variantGroupId, getMarketModKey(active));
        const selected = batchInstallState.selected.has(getMarketModKey(group));
        const selectionHtml = batchInstallState.selecting && isBatchInstallEligible(group, profiles)
            ? `<label class="modhub-market-select-label"><input type="checkbox" class="modhub-market-select" data-mod-key="${escapeHtml(getMarketModKey(group))}" aria-label="选择${escapeHtml(group.name)}" ${selected ? 'checked' : ''} ${batchInstallState.running ? 'disabled' : ''}>选择</label>` : '';
        const choices = [];
        const rows = group.variants.map(mod => {
            const label = window.modHubMarketVariants.normalizeVariant(mod.variant).label;
            const latest = getLatestMarketVersionInfo(mod);
            const dead = mod._isDeadRepo || isDeadRepo(mod.githubUrl, mod);
            const state = dead ? '来源失效' : mod._status === 'update_available' ? '发现新版'
                : mod._isIgnored ? '已忽略更新' : mod._matchedLocal ? '已安装'
                    : mod._status === 'not_installed' ? '未安装' : '请核对来源';
            const requirements = window.modHubMarketVariants.normalizeRequiredDependencies(mod.requiredDependencies);
            const requirementsHtml = requirements.map(requirement => {
                const providers = profiles.filter(profile => {
                    const boot = profile.bootJson;
                    return [boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])]
                        .some(name => typeof name === 'string' && name.trim().toLowerCase() === requirement.modName.toLowerCase());
                });
                const provider = providers.length === 1 ? providers[0] : null;
                let color = 'gold', status = '需要核对', reason = '多个已安装模组声明此前置身份，请核对提供者。';
                if (!providers.length) {
                    if (profiles.some(profile => !profile.bootJson?.name)) {
                        reason = '部分已安装模组的包内声明尚未读取，无法确认此前置是否存在。';
                    } else {
                        color = 'red'; status = '未安装'; reason = '请先安装并启用此前置。';
                    }
                } else if (provider) {
                    if (modHubComponentDisabled(provider.name)) {
                        color = 'red'; status = '已禁用'; reason = '请先在模组管理中启用此前置。';
                    } else {
                        const assessment = window.modHubMarketVersions?.assessVersionRange?.(provider.bootJson.version, requirement.version);
                        reason = assessment?.reason || '版本核对模块尚未就绪，请重新载入后核对。';
                        if (assessment?.status === 'compatible') { color = 'green'; status = '已安装'; }
                        else if (assessment?.status === 'incompatible') { color = 'red'; status = '版本不符'; }
                    }
                }
                return `<div class="modhub-market-meta modhub-market-variant-requirements ${color}" title="${escapeHtml(reason)}">该语言额外前置：${escapeHtml(requirement.modName)}（${status}）</div>`;
            }).join('');
            const source = window.modHubMarketSpells?.renderAcquisitionDetails(mod) || '';
            const actionLabel = mod._status === 'update_available' ? `更新${label}` : `选择${label}版本`;
            const action = `<button type="button" class="macro-button ${dead ? 'modhub-btn-secondary' : `modhub-btn-primary ${mod._status === 'update_available' ? 'btn-market-update' : 'btn-market-install'}`}" data-mod-index="${mod._marketIndex}" data-idle-text="${escapeHtml(actionLabel)}" ${dead || batchInstallState.running || marketInstallBusy ? 'disabled' : ''}>${dead ? '来源失效' : escapeHtml(actionLabel)}</button>`;
            const ignore = mod._status === 'update_available' && !dead
                ? `<div class="modhub-market-ignore-actions"><button type="button" class="btn-market-ignore" data-mod-index="${mod._marketIndex}" data-ignore-mode="once">忽略本次</button><button type="button" class="btn-market-ignore" data-mod-index="${mod._marketIndex}" data-ignore-mode="always">永久忽略</button></div>`
                : mod._isIgnored ? `<button type="button" class="btn-market-unignore" data-mod-index="${mod._marketIndex}">取消忽略${escapeHtml(label)}</button>` : '';
            choices.push(`<button type="button" class="modhub-market-language-choice btn-market-language-choice" data-variant-group="${escapeHtml(group.variantGroupId)}" data-mod-index="${mod._marketIndex}" aria-pressed="${mod === active}" aria-controls="modHubMarketLanguagePanel${mod._marketIndex}" ${batchInstallState.running || marketInstallBusy ? 'disabled' : ''}><span>${escapeHtml(label)}</span><span class="modhub-market-variant-status ${mod._status === 'update_available' ? 'gold' : 'grey'}">${state}</span></button>`);
            return `<div class="modhub-market-variant-row" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${mod._marketIndex}" id="modHubMarketLanguagePanel${mod._marketIndex}" ${mod === active ? '' : 'hidden'}>
                <div class="modhub-market-meta grey"><span>作者: ${escapeHtml(mod.author || '未知')}</span>${latest.updateDate ? `<span>${latest.updateDateSource === 'github' ? '发布' : '更新'}: ${escapeHtml(latest.updateDate)}</span>` : ''}${mod._matchedLocal ? `<span>${escapeHtml(mod._matchedLocal.name)}</span>` : ''}</div>
                <div class="modhub-market-meta modhub-market-versions grey"><span>已安装版本：${escapeHtml(mod._matchedLocal?.version || (mod._matchedLocal ? '未知' : '未安装'))}</span><span class="purple">最新版本：${escapeHtml(latest.text)}</span></div>
                <div class="modhub-market-desc">${escapeHtml(mod.description || '暂无说明')}</div>
                ${requirementsHtml}
                <div class="modhub-download-progress" hidden aria-live="polite">${window.modHubProgressRingHtml(null, label + '下载进度')}<span class="modhub-download-label grey">等待下载</span><button type="button" class="modhub-download-cancel" data-mod-index="${mod._marketIndex}" hidden>取消下载</button></div>
                <div class="modhub-market-card-footer">${source}${ignore}<div class="modhub-market-actions">${action}</div></div>
            </div>`;
        }).join('');
        return `<div class="childItem modhub-market-card modhub-market-language-card ${selected ? 'is-batch-selected' : ''}" data-variant-group="${escapeHtml(group.variantGroupId)}" data-mod-name="${escapeHtml(group.name)}">
            <div class="modhub-market-card-header">${selectionHtml}<div class="modhub-market-title-wrap"><span class="modhub-market-title gold">${escapeHtml(group.name)}</span><span class="modhub-market-badge ${installed.length ? 'badge-installed' : 'badge-new'}">${installed.length > 1 ? `已安装 ${installed.length} 种语言` : installed.length === 1 ? `已安装${escapeHtml(installed[0].variant.label)}` : '未安装'}</span></div></div>
            <div class="modhub-market-language-switch" role="group" aria-label="${escapeHtml(group.name)}的安装语言">${choices.join('')}</div>
            ${installed.length > 1 ? '<div class="modhub-market-variant-intro gold">当前同时保留多个语言包。请明确选择要处理的语言；每个包分别检查更新。</div>' : ''}
            <div class="modhub-market-variant-list">${rows}</div>
        </div>`;
    }

    function renderMarketCards() {
        const container = document.getElementById('modHubMarketCardsContainer');
        if (!container) return;

        const filtered = filterAndSortMods();

        // 统计数字与可更新模组列表
        const profiles = getLocalInstalledProfiles();
        let installedCount = 0;
        let updatableCount = 0;
        let ignoredCount = 0;
        const updatableList = [];

        const activeMods = marketModList.filter(mod => !isWithdrawn(mod));
        activeMods.forEach(m => {
            const st = checkModInstallStatus(m, profiles);
            if (st === 'up_to_date' || st === 'update_available' || st === 'external_installed') installedCount++;
            if (m._isIgnored) ignoredCount++;
            if (st === 'update_available') {
                updatableCount++;
                updatableList.push({
                    marketMod: m,
                    localProfile: m._matchedLocal,
                    newVersion: getModUpdateInfo(m).version,
                    currentVersion: m._matchedLocal?.version || ''
                });
            }
        });

        const displayStats = getDisplayMods(activeMods);
        const statMembers = entry => entry.isLanguageGroup ? entry.variants : [entry];
        renderStatsHeader(displayStats.length,
            displayStats.filter(entry => statMembers(entry).some(mod => mod._matchedLocal)).length,
            displayStats.filter(entry => statMembers(entry).some(mod => checkModInstallStatus(mod, profiles) === 'update_available')).length);
        renderIgnoredFilterLink(ignoredCount);
        renderBatchInstallToolbar();
        const deadCount = document.getElementById('modHubDeadSourceCount');
        if (deadCount) deadCount.textContent = `（${marketModList.filter(mod => isDeadRepo(mod.githubUrl, mod)).length}）`;

        // 同步通知外部模组管理环境看板与 Tab 徽标
        if (typeof window.modHubNotifyUpdateState === 'function') {
            window.modHubNotifyUpdateState(updatableCount, updatableList);
        }

        const spellView = currentMarketSection === 'spells';
        renderMarketSections();
        const batchToolbar = document.getElementById('modHubMarketBatchToolbar');
        if (batchToolbar) batchToolbar.hidden = spellView;
        ['modHubStatusSelect', 'modHubMirrorSelect'].forEach(id => {
            const control = document.getElementById(id);
            if (control) control.disabled = spellView || batchInstallState.running;
        });
        if (spellView) {
            if (window.modHubMarketSpells) window.modHubMarketSpells.render(container, { search: currentSearchText, sort: currentSortBy });
            else container.innerHTML = '<div class="modhub-empty-state grey">咒语资料模块尚未就绪。请重新载入游戏后重试。</div>';
            updateToolbarResetBtn();
            return;
        }

        if (!filtered.length) {
            container.innerHTML = `
                <div class="modhub-empty-state grey">
                    未找到匹配的模组。您可以清除筛选、关闭“隐藏失效来源”或刷新市场数据。
                    <br><br>
                    <button type="button" class="macro-button modhub-btn-primary" onclick="window.modHubMarket.resetFilters()">返回查看全部模组</button>
                </div>
            `;
            updateToolbarResetBtn();
            return;
        }

        const escapeHtml = window.modHubEscapeHtml || (value => String(value ?? '').replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));

        const html = getFilteredDisplayMods(filtered, profiles).map(mod => {
            if (mod.isLanguageGroup) return renderLanguageGroupCard(mod, profiles, escapeHtml);
            const modIndex = mod._marketIndex;
            const updateInfo = mod._updateCheck ? getModUpdateInfo(mod) : { version: mod.version };
            const latestVersionInfo = getLatestMarketVersionInfo(mod);
            const latestVersionText = latestVersionInfo.text;
            const installedBadge = getInstalledMarketBadgeInfo(mod, updateInfo, latestVersionInfo.version);
            const isCommunity = mod.catalogSource === 'community';
            const tagsHtml = [
                `<span class="modhub-market-tag modhub-market-category">${escapeHtml(mod.category || '待分类')}</span>`,
                ...(mod.tags || []).map(t => `<span class="modhub-market-tag">${escapeHtml(t)}</span>`)
            ].join('');
            
            // 状态徽章与主操作按钮
            let badgeHtml = '';
            let actionBtnHtml = '';
            let installedStatusDetail = '';
            const marketRepoKey = extractRepoKey(mod.githubUrl);
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            const isUpdatable = mod._status === 'update_available' && !isDead;
            const isReferenceUpdate = updateInfo.release?.compatibility?.evidence === 'filename';
            const isUnknownUpdate = updateInfo.release && (!updateInfo.release.compatibility?.evidence || updateInfo.release.compatibility.evidence === 'unknown');
            const isIgnored = !!mod._isIgnored;
            const isPermanentlyIgnored = mod._ignoredVersion === 'ignored';
            const selected = batchInstallState.selected.has(getMarketModKey(mod));
            const selectionHtml = batchInstallState.selecting && isBatchInstallEligible(mod, profiles)
                ? `<label class="modhub-market-select-label"><input type="checkbox" class="modhub-market-select" data-mod-key="${escapeHtml(getMarketModKey(mod))}" aria-label="选择${escapeHtml(mod.name)}" ${selected ? 'checked' : ''} ${batchInstallState.running ? 'disabled' : ''}>选择</label>`
                : '';

            if (isDead) {
                // 源已失效：统一采用红色标签醒目提示
                badgeHtml = `<span class="modhub-market-badge badge-dead-repo">源已失效</span>`;
                if (mod._status === 'up_to_date' || mod._matchedLocal) {
                    actionBtnHtml = `<button type="button" class="macro-button modhub-btn-secondary" disabled>已安装</button>`;
                } else actionBtnHtml = '';
            } else if (isUpdatable) {
                badgeHtml = `<span class="modhub-market-badge badge-update"${isReferenceUpdate ? ' title="依据文件名识别"' : ''}>${isUnknownUpdate ? '发现新版，适配待核对' : '发现新版'}</span>`;
                const updateLabel = isReferenceUpdate || isUnknownUpdate ? '选择更新版本' : '一键更新';
                if (isUnknownUpdate) installedStatusDetail = updateInfo.release.compatibility?.reason || '适用的游戏版本尚未确定，下一步会核对安装包中的说明';
                actionBtnHtml = `<button type="button" class="macro-button modhub-btn-primary btn-market-update" data-mod-index="${modIndex}" data-idle-text="${updateLabel}">${updateLabel}</button>`;
            } else if (mod._status === 'external_installed') {
                badgeHtml = `<span class="modhub-market-badge badge-installed">已安装</span>`;
                actionBtnHtml = '';
            } else if (mod._status === 'up_to_date') {
                if (isIgnored) {
                    badgeHtml = `<span class="modhub-market-badge badge-ignored">${isPermanentlyIgnored ? '已永久忽略' : '已忽略本次'}</span>`;
                    actionBtnHtml = `<button type="button" class="macro-button modhub-btn-primary btn-market-update" data-mod-index="${modIndex}" data-idle-text="更新">更新</button>`;
                } else {
                    installedStatusDetail = installedBadge.detail;
                    badgeHtml = `<span class="modhub-market-badge badge-installed"${installedBadge.title ? ` title="${escapeHtml(installedBadge.title)}"` : ''}>${installedBadge.label}</span>`;
                    actionBtnHtml = `<button type="button" class="macro-button modhub-btn-secondary" disabled>已安装</button>`;
                }
                if (window.modHubMarketInstaller && mod.githubUrl && (!isCommunity || hasCommunityReleaseSource(mod))) {
                    actionBtnHtml = `<button type="button" class="macro-button modhub-btn-secondary btn-market-update" data-mod-index="${modIndex}" data-idle-text="更换版本">更换版本</button>`;
                }
            } else if (mod._status === 'not_installed') {
                badgeHtml = `<span class="modhub-market-badge badge-new">未安装</span>`;
                actionBtnHtml = `<button type="button" class="macro-button modhub-btn-primary btn-market-install" data-mod-index="${modIndex}" data-idle-text="下载安装">下载安装</button>`;
            } else if (mod._status === 'external_only') {
                badgeHtml = `<span class="modhub-market-badge badge-external">外部资源</span>`;
                actionBtnHtml = '';
            } else {
                badgeHtml = `<span class="modhub-market-badge badge-external">暂无直链</span>`;
                actionBtnHtml = '';
            }

            const acquisitionDetailsHtml = window.modHubMarketSpells?.renderAcquisitionDetails(mod)
                || '<div class="modhub-market-source-bar"><span>来源：</span><span>来源资料模块尚未就绪</span></div>';

            const installedRelease = isReleasePackageInstalled(updateInfo.release, mod._matchedLocal) === true ? getPublishedVersion(updateInfo.release) : '';
            const installedVersionText = installedRelease && !isSameVersion(installedRelease, mod._matchedLocal?.version)
                ? `${formatVersionDisplay(installedRelease)}（包内 ${formatVersionDisplay(mod._matchedLocal.version)}）`
                : mod._matchedLocal?.version ? formatVersionDisplay(mod._matchedLocal.version) : '未知';
            const isLocalHigher = Boolean(mod._matchedLocal?.version && latestVersionInfo.version && compareVersions(mod._matchedLocal.version, latestVersionInfo.version) > 0);
            const localVerText = mod._matchedLocal
                ? `<span class="${installedBadge.label === '已是最新' ? 'green' : 'gold'}">已安装版本：${escapeHtml(mod._matchedLocal.version
                    ? installedVersionText : '未知')}</span>` : '';

            const ignoreActionsHtml = isUpdatable
                ? `<div class="modhub-market-ignore-actions">
                    <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="once" title="仅忽略 ${escapeHtml(formatVersionDisplay(updateInfo.version))}，更高版本仍会提醒">忽略本次</button>
                    <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="always" title="以后不再提示此模组更新">永久忽略</button>
                   </div>`
                : (isIgnored && currentStatusFilter === 'ignored'
                    ? `<div class="modhub-market-ignore-actions"><button type="button" class="btn-market-unignore" data-mod-index="${modIndex}">取消忽略</button></div>`
                    : '');

            return `
                <div class="childItem modhub-market-card ${isUpdatable ? 'modhub-market-card-updatable' : ''} ${selected ? 'is-batch-selected' : ''} ${selectionHtml ? 'is-batch-selectable' : ''}" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${modIndex}">
                    <div class="modhub-market-card-header">
                        ${selectionHtml}
                        <div class="modhub-market-title-wrap">
                            <span class="modhub-market-title gold">${escapeHtml(mod.name)}</span>
                            ${badgeHtml}
                        </div>
                        <div class="modhub-market-tags">${tagsHtml}</div>
                    </div>
                    <div class="modhub-market-meta grey">
                        <span>作者: ${escapeHtml(mod.author)}</span>
                        ${latestVersionInfo.updateDate ? `<span>${latestVersionInfo.updateDateSource === 'github' ? '发布' : '更新'}: ${escapeHtml(latestVersionInfo.updateDate)}</span>` : ''}
                    </div>
                    <div class="modhub-market-meta modhub-market-versions grey">
                        ${localVerText}
                        <span class="purple">最新版本：${escapeHtml(latestVersionText)}</span>
                    </div>
                    ${installedStatusDetail || updateInfo.error ? `<div class="modhub-market-meta grey">${escapeHtml(installedStatusDetail || `更新检查失败：${updateInfo.error}。可刷新市场后重试。`)}</div>` : ''}
                    <div class="modhub-market-desc">
                        ${escapeHtml(mod.description)}
                    </div>
                    <div class="modhub-download-progress" hidden aria-live="polite">
                        ${window.modHubProgressRingHtml(null, mod.name + '下载进度')}
                        <span class="modhub-download-label grey">等待下载</span>
                        <button type="button" class="modhub-download-cancel" data-mod-index="${modIndex}" hidden>取消下载</button>
                    </div>
                    <div class="modhub-market-card-footer">
                        ${acquisitionDetailsHtml}
                        ${ignoreActionsHtml}
                        ${actionBtnHtml ? `<div class="modhub-market-actions">${actionBtnHtml}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;
        downloadProgressState.forEach((progress, name) => updateDownloadProgress(name, progress.percent, progress.text, progress.state));

        // 绑定卡片内按钮事件
        container.querySelectorAll('.modhub-market-select').forEach(input => {
            input.onchange = () => setBatchModSelected(input.dataset.modKey, input.checked);
            const card = input.closest('.modhub-market-card');
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
        container.querySelectorAll('.btn-market-language-choice').forEach(btn => {
            btn.onclick = () => {
                if (batchInstallState.running || marketInstallBusy) return;
                const group = getDisplayMods().find(entry => entry.isLanguageGroup && entry.variantGroupId === btn.dataset.variantGroup);
                const member = marketModList[Number(btn.dataset.modIndex)];
                const card = btn.closest('.modhub-market-language-card');
                if (!member || !group?.variants.includes(member) || !card) return;
                selectedMarketLanguages.set(group.variantGroupId, getMarketModKey(member));
                card.querySelectorAll('.btn-market-language-choice').forEach(choice => choice.setAttribute('aria-pressed', String(choice === btn)));
                card.querySelectorAll('.modhub-market-variant-row').forEach(row => { row.hidden = row.dataset.modIndex !== btn.dataset.modIndex; });
            };
        });

        container.querySelectorAll('.modhub-download-cancel').forEach(btn => {
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
                const ok = !isPermanent || await window.modHubConfirm({
                    title: '永久忽略更新',
                    message: `是否永久忽略模组【${targetMod.name}】的更新？\n\n以后发布的新版本也不会再提醒，您仍可在“已忽略模组”中手动更新或取消忽略。`,
                    confirmText: '永久忽略',
                    cancelText: '取消',
                    confirmType: 'primary'
                });
                if (ok) {
                    const ignoredVersion = isPermanent ? 'ignored' : getModUpdateInfo(targetMod).version;
                    if (!ignoredVersion) return;
                    setModUpdateIgnored(targetMod.name, ignoredVersion, true);
                    if (targetMod._matchedLocal?.name) {
                        setModUpdateIgnored(targetMod._matchedLocal.name, ignoredVersion, true);
                    }
                    window.modHubShowToast(isPermanent
                        ? `已永久忽略【${targetMod.name}】的更新`
                        : `已忽略【${targetMod.name}】的本次更新`, 'success');
                    renderMarketCards();
                    if (typeof window.modHubUpdateGeneralInfo === 'function') {
                        window.modHubUpdateGeneralInfo();
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
                window.modHubShowToast(`已取消忽略【${targetMod.name}】的 ${formatVersionDisplay(targetMod.version)} 更新`, 'info');
                renderMarketCards();
                if (typeof window.modHubUpdateGeneralInfo === 'function') {
                    window.modHubUpdateGeneralInfo();
                }
            };
        });

        renderBatchInstallToolbar();
        updateToolbarResetBtn();
    }

    /** 弹窗开始下载 */
    async function promptDownloadMirrorAndInstall(mod) {
        return runMarketInstallTask(context => promptDownloadMirrorAndInstallUnlocked(mod, context));
    }

    async function promptDownloadMirrorAndInstallUnlocked(mod, restoreContext) {
        if (mod?.isLanguageGroup) {
            if (window.modHubMarketInstaller) return window.modHubMarketInstaller.install(mod, { restoreContext });
            await window.modHubAlert('语言与版本选择模块尚未就绪，请重新载入游戏后重试。', '无法选择语言');
            return false;
        }
        if (mod?.contentType === 'spell' || isWithdrawn(mod)) return false;
        if (window.modHubMarketInstaller && mod.githubUrl && (mod.catalogSource !== 'community' || hasCommunityReleaseSource(mod))) {
            return window.modHubMarketInstaller.install(mod, { restoreContext });
        }
        if (window.modHubMarketVersions && mod.githubUrl && (mod.catalogSource !== 'community' || hasCommunityReleaseSource(mod))) {
            await window.modHubAlert('版本选择模块尚未就绪，请重新载入游戏后选择安装版本。', '无法核对安装版本');
            return false;
        }
        const selectedMirror = MIRROR_SERVERS.find(m => m.id === currentMirrorId) || MIRROR_SERVERS[0];
        let externalOnly = !mod.githubUrl || (mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod));
        const manualSourceUrl = externalOnly ? marketExternalUrl(mod) : safeHttpsUrl(mod.githubUrl);
        if (externalOnly && !manualSourceUrl) return false;
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
                const requirement = formatDependencyRequirement(item.dependency);
                const version = requirement ? `（需要 ${requirement}）` : '';
                return `· ${name}${version}：${item.reason}`;
            });
            const cycleLines = plan.cycles.map(name => `· ${name}：检测到循环依赖`);
            await window.modHubAlert(
                `无法安全生成安装计划：\n\n${[...unavailableLines, ...cycleLines].join('\n')}\n\n请先手动处理以上前置依赖。`,
                '前置依赖无法自动处理'
            );
            return false;
        }

        const actionLabels = {
            install: action => `· ${action.mod.name}：未安装`,
            update: action => `· ${action.mod.name}：当前 ${formatVersionDisplay(action.local?.version) || '版本未知'}，需要 ${formatVersionRange(action.requirement)}`,
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
            const requiredVersion = formatDependencyRequirement(requirement.dependency);
            const version = requiredVersion ? `（需要 ${requiredVersion}）` : '';
            return `${requirement.mod.name}${version}：${states.join('并') || '已满足'}`;
        });
        if (externalOnly && !actionLines.length) {
            window.open(manualSourceUrl, '_blank', 'noopener');
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
                    window.modHubShowToast(`已取消【${mod.name}】的安装包清单读取`, 'info');
                    return false;
                }
                resetDownloadProgress(mod.name);
                if (['MANUAL_SOURCE', 'RELEASE_NOT_FOUND'].includes(error?.code)) {
                    if (!plan.requirements.length) return offerOriginalDownloadSource(mod, error);
                    // 手动来源仍须展示和处理已发现的前置，不能在这里绕过依赖流程。
                    externalOnly = true;
                    releaseInfo = null;
                    installPlanText = `目标模组需手动下载：${error.message}`;
                } else if (error?.code === 'REPO_NOT_FOUND' || error?.status === 404 || mod._isDeadRepo || isDeadRepo(mod.githubUrl)) {
                    if (typeof window.modHubAlert === 'function') {
                        await window.modHubAlert('该模组的 GitHub 仓库已被作者移除或不存在 (404)，无法下载更新。\n\n已自动更新本地模组状态为无需更新。', '模组仓库已失效');
                    }
                    if (typeof renderMarketCards === 'function') renderMarketCards();
                    return false;
                } else {
                    console.warn('[ModHub] 预读取安装包清单失败，将在安装时重试', error);
                    installPlanText = '安装包清单：暂时读取失败，开始安装后将自动重试。';
                }
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
        const dependencyHtml = plan.requirements.length ? `<div id="modHubInstallDependencyArea">${formatDependencyListHtml(plan)}</div>` : '';
        const initialConflicts = detectModInstallationConflicts(mod, plan.actions);
        const conflictAreaHtml = `<div id="modHubInstallConflictArea"${initialConflicts.length ? '' : ' style="display:none;"'}>${formatConflictWarningHtml(initialConflicts)}</div>`;

        const trustedMessageHtml = releaseInfo
            ? `${dependencyHtml}${conflictAreaHtml}${formatReleaseInstallPlanHtml(releaseInfo, selectedMirror, historicalCompanions.length)}`
            : ((dependencyHtml || initialConflicts.length) ? `${dependencyHtml}${conflictAreaHtml}<div class="modhub-install-summary"><div class="modhub-install-overview"><strong>目标模组需手动下载</strong></div><p style="margin:8px 0 0; color:var(--300,#bbb); font-size:0.9em;">处理完上述勾选的前置依赖后，将自动为您打开【${window.modHubEscapeHtml(mod.name)}】的下载页面。</p></div>` : '');
        const initialActionCount = plan.actions.length;
        const initialConfirmText = manualAssetOptions.length
            ? '安装所选包'
            : (initialActionCount
                ? (externalOnly ? `一并处理（${initialActionCount}项依赖）` : `一键安装（含 ${initialActionCount} 项依赖）`)
                : (externalOnly ? '打开下载页面' : '开始安装'));

        let pendingConflictChange = null;
        const choice = await window.modHubConfirm({
            title: externalOnly ? `处理【${mod.name}】的前置依赖` : `下载并安装【${mod.name}】`,
            message: actionLines.length
                ? `检测到以下必需依赖需要一并处理：\n\n${actionLines.join('\n')}\n\n${externalOnly ? '处理完成后将打开目标模组的外部下载页面。' : `${installPlanText}\n\n将按依赖顺序处理，并在最后安装【${mod.name}】。`}`
                : (externalOnly ? `${dependencyLines.join('\n')}\n\n${installPlanText}\n\n是否打开作者下载页面？` : `${installPlanText}\n\n${selectedMirror.browserOnly ? '以上文件将由浏览器下载后手动导入。' : '以上文件将自动注册到 ModLoader 旁加载中。'}\n\n下载线路：${selectedMirror.name}\n\n是否立即开始下载并安装？`),
            trustedMessageHtml,
            dialogClass: 'modhub-install-dialog',
            confirmText: initialConfirmText,
            cancelText: '取消',
            confirmType: initialConflicts.some(c => c.localConflictMod?.isEnabled) ? 'danger' : 'primary',
            selectLabel: manualAssetOptions.length ? '主安装包选择' : (companionOptions.length ? '历史美术包选择' : undefined),
            selectOptions,
            selectValue: manualAssetOptions.length ? '' : (companionOptions.length ? 'none' : undefined),
            requireSelection: manualAssetOptions.length > 0,
            onRender: (dialog) => {
                const dependencyArea = dialog.querySelector('#modHubInstallDependencyArea');
                const confirmBtn = dialog.querySelector('.modhub-modal-btn-confirm');
                const conflictArea = dialog.querySelector('#modHubInstallConflictArea');
                const updateDepUi = () => {
                    const activeActions = getActivePlan().actions;
                    if (dependencyArea) dependencyArea.innerHTML = formatDependencyListHtml(plan);
                    dialog.querySelectorAll('input[name="modHubDepReq"]').forEach(checkbox => {
                        const requirement = plan.requirements[Number(checkbox.dataset.reqIndex)];
                        if (!requirement) return;
                        const key = dependencyKey(requirement.mod);
                        checkbox.checked = !skippedDependencyKeys.has(key);
                        if (!checkbox.checked) {
                            const row = checkbox.closest('.modhub-dep-item');
                            row?.classList.add('modhub-dep-skipped');
                            const status = row?.querySelector('.modhub-dep-status');
                            if (status) {
                                status.textContent = status.dataset.skipText || '跳过处理';
                                status.className = 'modhub-dep-status grey';
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
                        conflictArea.querySelectorAll('.modhub-conflict-disable-btn').forEach(button => {
                            button.onclick = async event => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (pendingConflictChange) return;
                                button.disabled = true;
                                pendingConflictChange = (async () => {
                                    try {
                                        if (await disableInstallConflict(button.dataset.conflictRaw, button.dataset.conflictName, getAffectedTargets(button.dataset.conflictRaw), restoreContext)) onConflictDisabled(button.dataset.conflictRaw);
                                    } catch (error) {
                                        console.error('[ModHub] 快捷禁用冲突模组失败:', error);
                                        window.modHubShowToast('快捷禁用未完成，请检查模组管理器状态', 'warning');
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
                        confirmBtn.className = confirmBtn.className.replace(/\bmodhub-btn-(?:primary|danger)\b/, danger ? 'modhub-btn-danger' : 'modhub-btn-primary');
                        confirmBtn.textContent = activeActions.length
                            ? (externalOnly ? `一并处理（${activeActions.length}项依赖）` : `一键安装（含 ${activeActions.length} 项依赖）`)
                            : (externalOnly ? '直接打开下载页面' : '开始安装');
                    }
                };
                updateDepUi();
            },
            customResult: (dialog) => {
                const selectEl = dialog.querySelector('.modhub-modal-select');
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

        if (!await confirmInstallConflicts(getActivePlan, { onChanged: onConflictDisabled, getAffectedTargets, restoreContext })) {
            resetDownloadProgress(mod.name);
            return false;
        }
        const actionsToExecute = getActivePlan().actions;
        if (plan.unavailable.length || plan.cycles.length) {
            await window.modHubAlert('本地模组状态已变化，前置依赖暂时无法满足。请重新检查后再安装。', '安装计划已变化');
            return false;
        }

        if (!actionsToExecute.length) {
            if (externalOnly) {
                window.open(manualSourceUrl, '_blank', 'noopener');
                return true;
            }
            return downloadAndInstallMod(mod, currentMirrorId, { releaseInfo, restoreContext });
        }

        const totalSteps = actionsToExecute.length + (externalOnly ? 0 : 1);
        for (let index = 0; index < actionsToExecute.length; index++) {
            const action = actionsToExecute[index];
            const progressPrefix = `${index + 1}/${totalSteps} 前置【${action.mod.name}】：`;
            if (action.type === 'enable') {
                updateDownloadProgress(mod.name, null, `${progressPrefix}正在启用...`);
                if (typeof window.modHubToggleSideMod !== 'function') {
                    await window.modHubAlert(`无法启用前置依赖【${action.mod.name}】，已停止安装目标模组。`, '安装已停止');
                    return false;
                }
                const isEnabled = () => {
                    const state = window._modHubModState;
                    const local = state?.sideMods?.find(item => item.name === action.local.name);
                    return local ? local.enabled === true : (state?.sideEnabled || []).includes(action.local.name);
                };
                if (!isEnabled()) {
                    const enabled = await window.modHubToggleSideMod(action.local.name, true, { silentOfferReload: true, restoreContext });
                    if (enabled !== true || !isEnabled()) {
                        await window.modHubAlert(`前置依赖【${action.mod.name}】未能启用，已停止安装目标模组。`, '安装已停止');
                        return false;
                    }
                    window.modHubRegisterOperationReload(restoreContext, '所选前置已启用，重新载入后生效。',
                        { isFramework: window.modHubIsFrameworkMod?.(action.local.name) });
                }
                updateDownloadProgress(mod.name, 100, `${progressPrefix}已启用`);
                continue;
            }
            window.modHubShowToast(`正在${action.type === 'update' ? '更新' : '安装'}前置依赖【${action.mod.name}】...`, 'warning');
            if (!await downloadAndInstallMod(action.mod, currentMirrorId, {
                askRestart: false,
                skipReloadOffer: true,
                restoreContext,
                progressTargetName: mod.name,
                progressPrefix,
                dependencyRequirements: action.dependencyRequirements
            })) {
                await window.modHubAlert(`前置依赖【${action.mod.name}】未能自动安装，已停止安装目标模组。`, '安装已停止');
                return false;
            }
        }

        if (externalOnly) {
            window.open(manualSourceUrl, '_blank', 'noopener');
            updateDownloadProgress(mod.name, 100, `${totalSteps}/${totalSteps} 前置依赖已处理，已打开下载页面`);
            window.modHubShowToast(`前置依赖已处理，已打开【${mod.name}】下载页面`, 'info');
            return true;
        }
        if (!await downloadAndInstallMod(mod, currentMirrorId, {
            askRestart: false,
            skipReloadOffer: true,
            restoreContext,
            progressPrefix: `${totalSteps}/${totalSteps} 目标模组【${mod.name}】：`,
            releaseInfo
        })) return false;
        const isFramework = (typeof window.modHubIsFrameworkMod === 'function' && (
            window.modHubIsFrameworkMod(mod.name) ||
            actionsToExecute.some(a => window.modHubIsFrameworkMod(a.mod?.name) || window.modHubIsFrameworkMod(a.local?.name))
        ));
        window.modHubRegisterOperationReload(restoreContext,
            `模组【${mod.name}】${actionsToExecute.length ? '及所选前置依赖' : ''}已处理完成。`, { isFramework });
        return true;
    }

    function shouldShowCategoryFilters(statusFilter) {
        return !['installed', 'updatable', 'ignored'].includes(statusFilter);
    }

    /** 两个板块保留各自搜索；模组状态和分类不参与咒语筛选。 */
    function selectMarketSection(section, render = true) {
        if (!['packages', 'spells'].includes(section) || batchInstallState.running || marketInstallBusy) return false;
        clearTimeout(marketSearchTimer);
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) currentSearchText = searchInput.value.trim();
        if (section !== currentMarketSection) {
            sectionFilters[currentMarketSection] = { category: currentCategory, status: currentStatusFilter,
                search: currentSearchText, sort: currentSortBy };
            currentMarketSection = section;
            const restored = sectionFilters[section];
            currentCategory = restored.category;
            currentStatusFilter = restored.status;
            currentSearchText = restored.search;
            currentSortBy = restored.sort;
            if (searchInput) searchInput.value = currentSearchText;
            const statusSelect = document.getElementById('modHubStatusSelect');
            if (statusSelect) statusSelect.value = currentStatusFilter;
            const sortSelect = document.getElementById('modHubSortSelect');
            if (sortSelect) sortSelect.value = currentSortBy;
        }
        if (render) {
            renderCategoryFilters();
            renderMarketCards();
        }
        return true;
    }

    function renderMarketSections() {
        const spellView = currentMarketSection === 'spells';
        const sectionButtons = document.getElementById('modHubMarketSections');
        if (sectionButtons) {
            const focusedSection = sectionButtons.contains?.(document.activeElement) ? document.activeElement?.dataset?.section : '';
            const counts = { packages: marketModList.filter(mod => !isWithdrawn(mod)).length,
                spells: window.modHubMarketSpells?.getSpells().length || 0 };
            sectionButtons.innerHTML = [['packages', 'MOD 与美化'], ['spells', '咒语']].map(([section, label]) =>
                `<button type="button" class="macro-button modhub-market-section-button ${currentMarketSection === section ? 'is-selected' : ''}" data-section="${section}" aria-pressed="${currentMarketSection === section}" aria-controls="modHubMarketCardsContainer" ${batchInstallState.running || marketInstallBusy ? 'disabled' : ''}>${label}（${counts[section]}）</button>`).join('');
            sectionButtons.querySelectorAll('.modhub-market-section-button').forEach(button => {
                button.onclick = () => selectMarketSection(button.dataset.section);
                if (focusedSection === button.dataset.section && !button.disabled) button.focus();
            });
        }
        ['modHubMarketStats', 'modHubMarketFilterFooter', 'modHubStatusSelect', 'modHubMirrorSelect', 'modHubMarketBatchToolbar'].forEach(id => {
            const control = document.getElementById(id);
            if (control) control.hidden = spellView;
        });
        const note = document.getElementById('modHubMarketSpellNote');
        if (note) note.hidden = !spellView;
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) {
            searchInput.placeholder = spellView ? '搜索咒语名称、正文或使用说明……' : '搜索模组名称、作者或简介关键词……';
            searchInput.setAttribute('aria-label', spellView ? '搜索咒语' : '搜索 MOD 与美化');
        }
        const sortSelect = document.getElementById('modHubSortSelect');
        if (sortSelect?.options) {
            Array.from(sortSelect.options).forEach(option => {
                if (option.value === 'name') option.textContent = spellView ? '按咒语名称' : '按模组名称';
            });
        }
    }

    function renderCategoryFilters() {
        const container = document.getElementById('modHubCategoryCapsules');
        if (!container) return;
        const showCategories = currentMarketSection === 'packages' && shouldShowCategoryFilters(currentStatusFilter);
        container.style.display = showCategories ? '' : 'none';
        if (!showCategories) return;
        const counts = new Map();
        const visibleMods = marketModList.filter(isMarketSourceVisible);
        visibleMods.forEach(mod => counts.set(mod.category || '待分类', (counts.get(mod.category || '待分类') || 0) + 1));
        const categories = [
            ...MARKET_CATEGORIES.filter(category => counts.has(category)),
            ...[...counts.keys()].filter(category => !MARKET_CATEGORIES.includes(category)).sort((a, b) => a.localeCompare(b))
        ];
        if (currentCategory !== 'all' && !counts.has(currentCategory)) currentCategory = 'all';
        const escapeHtml = window.modHubEscapeHtml || (value => value);
        container.innerHTML = [
            `<button type="button" class="macro-button capsule-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all">全部分类（${visibleMods.length}）</button>`,
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
    window.modHubInitMarket = async function(forceRefresh = false) {
        const root = document.getElementById('modHubModMarketContainer');
        if (!root) return;
        const revision = ++marketViewRevision;
        const current = () => revision === marketViewRevision && document.getElementById('modHubModMarketContainer') === root;

        root.innerHTML = `
            <div id="modHubMarketSections" class="modhub-market-sections" role="group" aria-label="市场内容板块"></div>
            <p id="modHubMarketSpellNote" class="modhub-market-section-note grey" hidden>咒语按原文展示和复制。请按使用说明在对应位置使用；市场不执行咒语，也不会将其安装为模组。</p>
            <!-- ===== 顶部状态信息卡 ===== -->
            <div id="modHubMarketStats" class="settingsGridSmall modhub-stats-container"></div>

            <div class="modhub-market-source grey" role="note">
                模组资料来源：<a href="https://degreesoflewditycn.miraheze.org/wiki/%E6%A8%A1%E7%BB%84%E5%88%97%E8%A1%A8" target="_blank" rel="noopener">DOL 中文社区 Wiki「模组列表」</a>及维护者审核的社区目录。收录表示出处经过核验，不代表安装包安全。
            </div>

            <!-- ===== 搜索与筛选工具栏 ===== -->
            <div class="modhub-market-toolbar">
                <div class="modhub-market-search-row">
                    <input
                        id="modHubMarketSearch"
                        class="modhub-search-input"
                        type="search"
                        placeholder="搜索模组名称、作者或简介关键词……"
                        value="${window.modHubEscapeHtml(currentSearchText)}"
                    />
                    <button id="modHubMarketBtnResetFilter" type="button" class="macro-button modhub-btn-sub" onclick="window.modHubMarket.resetFilters()" title="清除当前所有筛选与搜索，查看全部模组" style="display:none; white-space:nowrap;">返回全部模组</button>
                    <button id="modHubMarketBtnRefresh" type="button" class="macro-button modhub-btn-primary" title="重新获取最新模组目录">刷新市场</button>
                    <button id="modHubMarketBtnSubmit" type="button" class="macro-button modhub-btn-primary modhub-submit-link">推荐模组</button>
                    <button id="modHubMarketBtnMy" type="button" class="macro-button modhub-btn-primary modhub-submit-link">我的投稿</button>
                </div>
                <div class="modhub-market-feedback-row"><button id="modHubMarketBtnFeedback" type="button" class="modhub-market-text-action">纠错与下架申请</button></div>

                <div class="modhub-market-filter-row">
                    <div class="modhub-market-capsules" id="modHubCategoryCapsules">
                        <button type="button" class="macro-button capsule-btn active" data-cat="all">全部分类</button>
                    </div>
                    <div class="modhub-market-selects">
                        <select id="modHubStatusSelect" class="modhub-select">
                            <option value="all" ${currentStatusFilter === 'all' ? 'selected' : ''}>全部状态</option>
                            <option value="installable" ${currentStatusFilter === 'installable' ? 'selected' : ''}>可安装/可更新</option>
                            <option value="updatable" ${currentStatusFilter === 'updatable' ? 'selected' : ''}>仅看可更新</option>
                            <option value="installed" ${currentStatusFilter === 'installed' ? 'selected' : ''}>已安装模组</option>
                            <option value="ignored" ${currentStatusFilter === 'ignored' ? 'selected' : ''}>已忽略更新</option>
                        </select>
                        <select id="modHubSortSelect" class="modhub-select">
                            <option value="date" ${currentSortBy === 'date' ? 'selected' : ''}>按最新更新</option>
                            <option value="name" ${currentSortBy === 'name' ? 'selected' : ''}>按模组名称</option>
                        </select>
                        <select id="modHubMirrorSelect" class="modhub-select" title="下载线路切换">
                            ${MIRROR_SERVERS.map(m => `<option value="${m.id}" ${currentMirrorId === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div id="modHubMarketFilterFooter" class="modhub-market-filter-footer">
                    <label class="modhub-market-source-toggle" title="仅隐藏已确认失效的来源；需要手动下载的模组仍会显示">
                        <input id="modHubHideDeadSources" type="checkbox" ${hideDeadSources ? 'checked' : ''}>隐藏失效来源<span id="modHubDeadSourceCount" class="grey"></span>
                    </label>
                    <button id="modHubMarketBtnIgnored" type="button" class="modhub-market-text-action" onclick="window.modHubMarket.filterIgnoredOnly()" aria-pressed="false" hidden>查看已忽略模组</button>
                </div>
            </div>

            <div id="modHubMarketBatchToolbar" class="modhub-market-batch-toolbar" role="group" aria-label="模组多选安装" ${currentMarketSection === 'spells' ? 'hidden' : ''}></div>

            <!-- ===== 模组卡片列表容器 ===== -->
            <div id="modHubMarketCardsContainer" class="modhub-market-grid">
                ${window.modHubLoadingHtml('正在拉取模组市场数据，请稍候……')}
            </div>
        `;
        renderMarketSections();
        renderBatchInstallToolbar();

        // 绑定搜索与筛选事件
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) {
            searchInput.oninput = () => {
                clearTimeout(marketSearchTimer);
                marketSearchTimer = setTimeout(() => {
                    if (!current()) return;
                    currentSearchText = searchInput.value.trim();
                    renderMarketCards();
                }, 200);
            };
        }

        const refreshBtn = document.getElementById('modHubMarketBtnRefresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                if (batchInstallState.running) return;
                refreshBtn.disabled = true;
                refreshBtn.setAttribute('aria-busy', 'true');
                refreshBtn.innerHTML = window.modHubProgressRingHtml() + '刷新中...';
                window.modHubShowToast('正在获取最新模组目录...', 'info');
                try {
                    if (typeof window.modHubLoadModManageState === 'function') await window.modHubLoadModManageState();
                    if (!current()) return;
                    await loadLocalPackageProfiles(true, current);
                    if (!current()) return;
                    await loadMarketData(true);
                    if (!current()) return;
                    renderCategoryFilters();
                    renderMarketCards();
                    window.modHubShowToast(`刷新成功，已载入 ${marketModList.length} 个模组、${window.modHubMarketSpells?.getSpells().length || 0} 个咒语配方`, 'success');
                } catch (e) {
                    if (current()) window.modHubShowToast(`刷新失败: ${e.message}`, 'warning');
                } finally {
                    refreshBtn.removeAttribute('aria-busy');
                    refreshBtn.disabled = batchInstallState.running;
                    refreshBtn.textContent = '刷新市场';
                }
            };
        }

        const submitBtn = document.getElementById('modHubMarketBtnSubmit');
        if (submitBtn) submitBtn.onclick = () => { if (!batchInstallState.running) openCommunitySubmission('new'); };
        const myBtn = document.getElementById('modHubMarketBtnMy');
        if (myBtn) myBtn.onclick = () => { if (!batchInstallState.running) openCommunitySubmission('my'); };
        const feedbackBtn = document.getElementById('modHubMarketBtnFeedback');
        if (feedbackBtn) feedbackBtn.onclick = openCommunityFeedback;

        const statusSelect = document.getElementById('modHubStatusSelect');
        if (statusSelect) {
            statusSelect.onchange = () => {
                currentStatusFilter = statusSelect.value;
                if (!shouldShowCategoryFilters(currentStatusFilter)) currentCategory = 'all';
                renderCategoryFilters();
                renderMarketCards();
            };
        }

        const hideDeadInput = document.getElementById('modHubHideDeadSources');
        if (hideDeadInput) {
            hideDeadInput.onchange = () => {
                hideDeadSources = hideDeadInput.checked;
                try { localStorage.setItem(HIDE_DEAD_SOURCES_KEY, String(hideDeadSources)); } catch (_) {}
                renderCategoryFilters();
                renderMarketCards();
            };
        }

        const sortSelect = document.getElementById('modHubSortSelect');
        if (sortSelect) {
            sortSelect.onchange = () => {
                currentSortBy = sortSelect.value;
                renderMarketCards();
            };
        }

        const mirrorSelect = document.getElementById('modHubMirrorSelect');
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
            if (!window._modHubOrphanRepairDone && typeof window.modHubRepairOrphanModZips === 'function') {
                window._modHubOrphanRepairDone = true;
                const repair = await window.modHubRepairOrphanModZips();
                if (repair?.repaired?.length && typeof window.modHubLoadModManageState === 'function') {
                    await window.modHubLoadModManageState(true);
                }
                if (!current()) return;
            }
            if (typeof window.modHubLoadModManageState === 'function') {
                await window.modHubLoadModManageState();
                if (!current()) return;
            }
            await loadLocalPackageProfiles(forceRefresh, current);
        } catch (_) {}

        if (!current()) return;
        // 加载数据
        try {
            await loadMarketData(forceRefresh);
            if (!current()) return;
            renderCategoryFilters();
            renderMarketCards();
        } catch (err) {
            if (!current()) return;
            const cardsContainer = document.getElementById('modHubMarketCardsContainer');
            if (cardsContainer) {
                cardsContainer.innerHTML = `
                    <div class="modhub-empty-state red">
                        加载模组市场数据失败: ${window.modHubEscapeHtml(err.message || String(err))}
                        <br><br>
                        <button type="button" class="macro-button modhub-btn-primary" onclick="window.modHubInitMarket()">重新尝试加载</button>
                    </div>
                `;
            }
        }
    };

    /** 获取所有有新版本可更新的模组列表（优先读内存，次选读 localStorage 缓存） */
    function getUpdatableMods() {
        let list = marketModList;
        if (!marketDataLoaded && (!list || !list.length)) {
            const cached = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL);
            if (cached && Array.isArray(cached) && cached.length > 0) {
                list = marketModList = normalizeReleaseIndex({ schemaVersion: 1, mods: cached });
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
                    newVersion: getModUpdateInfo(mod).version || ''
                });
            }
        }
        return updatables;
    }

    /** 动态更新工具栏上的“返回全部模组”按钮显隐状态 */
    function updateToolbarResetBtn() {
        const btn = document.getElementById('modHubMarketBtnResetFilter');
        if (!btn) return;
        const spellView = currentMarketSection === 'spells';
        const isFiltering = spellView ? !!currentSearchText : (currentCategory !== 'all' || currentStatusFilter !== 'all' || !!currentSearchText);
        btn.textContent = spellView ? '清除搜索' : '返回全部模组';
        btn.title = spellView ? '清除搜索，查看全部咒语' : '清除当前所有筛选与搜索，查看全部模组';
        btn.style.display = isFiltering ? 'inline-block' : 'none';
    }

    /** 重置分类、状态与搜索，保留失效来源显示偏好 */
    function resetFilters() {
        clearTimeout(marketSearchTimer);
        currentCategory = 'all';
        currentStatusFilter = 'all';
        currentSearchText = '';
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) searchInput.value = '';
        const statusSelect = document.getElementById('modHubStatusSelect');
        if (statusSelect) statusSelect.value = 'all';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
        if (typeof window.modHubShowToast === 'function') {
            window.modHubShowToast(currentMarketSection === 'spells' ? '已清除搜索并展示全部咒语' : '已返回并展示全部模组', 'info');
        }
    }

    /** 快捷将市场卡片过滤为“已安装模组” */
    function filterInstalledOnly() {
        if (!selectMarketSection('packages', false)) return;
        currentStatusFilter = 'installed';
        currentCategory = 'all';
        const sel = document.getElementById('modHubStatusSelect');
        if (sel) sel.value = 'installed';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 快捷将市场卡片过滤为“仅看可更新” */
    function filterUpdatableOnly() {
        if (!selectMarketSection('packages', false)) return;
        currentStatusFilter = 'updatable';
        currentCategory = 'all';
        const sel = document.getElementById('modHubStatusSelect');
        if (sel) sel.value = 'updatable';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 进入独立的已忽略更新列表 */
    function filterIgnoredOnly() {
        if (!selectMarketSection('packages', false)) return;
        currentStatusFilter = 'ignored';
        currentCategory = 'all';
        const sel = document.getElementById('modHubStatusSelect');
        if (sel) sel.value = 'ignored';
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
    }

    /** 一键全部批量更新 */
    async function updateAllMods() {
        return runMarketInstallTask(context => updateAllModsUnlocked(context));
    }

    async function updateAllModsUnlocked(restoreContext) {
        const updatables = getUpdatableMods();
        if (!updatables.length) {
            window.modHubShowToast('当前暂无可更新的模组', 'info');
            return;
        }
        if (window.modHubMarketInstaller) return window.modHubMarketInstaller.installBatch(updatables.map(item => item.marketMod), { updateOnly: true, restoreContext });
        if (window.modHubMarketVersions) {
            await window.modHubAlert('版本选择模块尚未就绪，请重新载入游戏后选择更新版本。', '无法核对更新版本');
            return false;
        }

        const selectedMirror = MIRROR_SERVERS.find(m => m.id === currentMirrorId) || MIRROR_SERVERS[0];
        if (selectedMirror.browserOnly) {
            await window.modHubAlert('GitHub 直连受浏览器跨域限制，只支持逐个浏览器下载后手动导入。\n\n请切换至加速通道 1、2 或 3 后再使用一键全部更新。', '当前线路不支持批量更新');
            return;
        }

        const lines = updatables.map(u => `· ${u.name} (当前: ${formatVersionDisplay(u.currentVersion)} -> 最新: ${formatVersionDisplay(u.newVersion)})`).join('\n');
        const ok = await window.modHubConfirm({
            title: '一键全部更新',
            message: `检测到共有 ${updatables.length} 个模组可升级至最新版本：\n\n${lines}\n\n当前下载线路：${MIRROR_SERVERS.find(m => m.id === currentMirrorId)?.name || '默认加速'}\n是否立即开始批量下载并安装？`,
            confirmText: '开始更新',
            cancelText: '取消',
            confirmType: 'primary'
        });

        if (!ok) return;

        let successCount = 0;
        let failCount = 0;
        const updatedNames = [];

        for (let i = 0; i < updatables.length; i++) {
            const item = updatables[i];
            window.modHubShowToast(`[${i + 1}/${updatables.length}] 正在更新【${item.name}】...`, 'warning');
            try {
                if (await downloadAndInstallMod(item.marketMod, currentMirrorId, { askRestart: false, skipReloadOffer: true, restoreContext })) {
                    successCount++;
                    updatedNames.push(item.name);
                }
                else failCount++;
            } catch (err) {
                console.error('[ModHub] 批量更新单个模组失败', item.name, err);
                failCount++;
            }
        }

        renderMarketCards();

        if (successCount) window.modHubRegisterOperationReload(restoreContext,
            `批量更新已完成（成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}）。`,
            { isFramework: updatedNames.some(name => window.modHubIsFrameworkMod?.(name)) });
    }

    /** 从外部（模组管理页等）一键跳转到模组市场并开启更新筛选 */
    window.modHubGoToMarketUpdates = function() {
        window.modHubSwitchTab('模组市场');
        setTimeout(() => {
            filterUpdatableOnly();
        }, 30);
    };

    /** 从模组管理列表原地直接更新单个模组 */
    window.modHubUpdateModDirectly = async function(modName) {
        if (!modName) return;
        const updatables = getUpdatableMods();
        const target = updatables.find(u => u.localName === modName || u.name === modName)
            || (marketModList ? marketModList.find(m => m.name === modName || m._matchedLocal?.name === modName) : null);
        if (target) {
            const marketMod = target.marketMod || target;
            await promptDownloadMirrorAndInstall(marketMod);
        } else {
            window.modHubShowToast(`未在模组市场找到【${modName}】对应的发布包`, 'warning');
        }
    };

    // 挂载公共接口
    window.modHubMarket = {
        isInstallBusy: () => marketInstallBusy || batchInstallState.running,
        loadMarketData,
        fetchGithubReadme,
        getReadmeImageProxyUrl,
        parseModsFromHtml,
        fetchModRelease,
        fetchRecentCompanionAssets,
        buildReleaseAssetPlan,
        getAssetGameVersion,
        matchesAssetIdentity,
        getAssetSeries,
        getAssetVersionParts,
        getMatchingCompanionAssets,
        getMatchingOptionalAssets,
        getAssetRole,
        getPreparedCompatibilityRisks,
        formatVersionRiskMessage,
        getReleaseInstallAssets,
        formatReleaseInstallPlanHtml,
        getModDependencies,
        getMarketMods: () => marketModList || [],
        getDisplayMods,
        getFilteredDisplayMods,
        getLanguageIdentityMembers,
        getCurrentMirrorId: () => currentMirrorId,
        getCommunityRevision: () => withdrawnRevision,
        resolveMirrorServer,
        isWithdrawn,
        hasCommunityReleaseSource,
        renderMarketCards,
        selectMarketSection,
        getCurrentMarketSection: () => currentMarketSection,
        renderBatchInstallToolbar,
        batchInstallState,
        MAX_DOWNLOAD_BYTES,
        formatReleaseInstallPlan,
        getAcceleratedUrl,
        getDownloadUrl,
        readDownloadResponse,
        verifyAssetDigest,
        refreshLocalPackageProfiles,
        invalidateLocalPackageProfiles,
        isReleaseInstalled,
        isPreparedComponentInstalled,
        getLocalInstalledProfiles,
        getModUpdateInfo,
        rememberMarketCandidates,
        getReleaseHistoryContext,
        checkModInstallStatus,
        findMarketModByLocalName,
        cancelDownload,
        downloadAndInstallMod,
        runInstallTask: runMarketInstallTask,
        deriveClassification,
        deriveTags,
        compareVersions,
        isSameVersion,
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
        openCommunitySubmission,
        openCommunityFeedback,
        fetchReleaseIndex,
        applyIdentityCatalog,
        loadIdentityCatalog,
        MARKET_CATEGORIES,
        KNOWN_MOD_MARKET_ALIASES: MODHUB_KNOWN_MOD_MARKET_ALIASES,
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
