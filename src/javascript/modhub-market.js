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

    const modHubHtml = html => window.modHubTranslateHtml ? window.modHubTranslateHtml(html) : html;
    const modHubText = (node, value, params) => { if (window.modHubBindText && node?.setAttribute && node?.getAttribute) window.modHubBindText(node, String(value ?? ''), params); else node.textContent = modHubT(value, params); return value; };
    function modHubLabelHtml(key, params) {
        const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
        return `<span data-modhub-i18n-key="${escape(key)}"${params ? ` data-modhub-i18n-key-params="${escape(JSON.stringify(params))}"` : ''}>${escape(modHubT(key, params))}</span>`;
    }
    function modHubSubmissionSummary(node, name, fallback, message) {
        const title = document.createElement('span');
        if (name) { title.textContent = name; title.setAttribute('data-modhub-i18n-ignore', ''); }
        else modHubText(title, fallback);
        const status = document.createElement('span');
        modHubText(status, message);
        const separator = document.createElement('span');
        separator.textContent = '：';
        node.appendChild(title);
        node.appendChild(separator);
        node.appendChild(status);
    }


    const modHubT = (key, params) => window.modHubT ? window.modHubT(key, params) : String(key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    function normalizeCatalogLanguages(value) {
        return value === undefined ? ['zh'] : Array.isArray(value)
            ? [...new Set(value.filter(language => language === 'zh' || language === 'en'))] : [];
    }

    function matchesContentLanguage(mod) {
        return (mod.isLanguageGroup ? mod.variants : [mod]).some(member =>
            normalizeCatalogLanguages(member.catalogLanguages).includes('zh'));
    }

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
    const RELEASE_WORKER_API_BASE = 'https://dol.alseece.top';
    const RELEASE_INDEX_URL = PRIMARY_RELEASE_INDEX_URL;
    const RELEASE_INDEX_MIRRORS = [
        PRIMARY_RELEASE_INDEX_URL,
        BACKUP_RELEASE_INDEX_URL
    ];
    let activeReleaseWorkerBaseUrl = PRIMARY_RELEASE_INDEX_URL;
    const IDENTITY_CATALOG_URL = 'https://dol.alseece.top/mod-identities.json';
    const IDENTITY_CACHE_KEY = 'modhub_market_identities_v5';
    const IDENTITY_FETCH_TIMEOUT_MS = 8000;
    const README_FETCH_TIMEOUT_MS = 8000;
    const MODHUB_README_CACHE_PREFIX = 'modhub_market_readme_v1_';
    const MODHUB_README_CACHE_TTL = 6 * 60 * 60 * 1000;
    const RELEASE_CACHE_PREFIX = 'modhub_market_rel_v2_';
    const RELEASE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
    const IGNORE_STORAGE_KEY = 'modhub_market_ignored_updates_v1';
    const CONFIRMED_STORAGE_KEY = 'modhub_market_confirmed_updates_v1';
    const PACKAGE_DIGEST_CACHE_KEY = 'modhub_package_digest_cache_v1';
    const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
    // 准备结果只在本次安装内复用，不能把换版后的包或外部构造的对象直接导入。
    const preparedMarketPackages = new WeakMap();
    const modUpdateChecks = new Map();
    const modUpdateQueue = [];
    let modUpdateActive = 0;
    const modUpdateRetryRoots = new WeakSet();
    // 已撤回或目录已移除的身份仅用于识别本地旧语言包，不能重新开放安装。
    const languageIdentityMembers = new Map();
    const selectedMarketLanguages = new Map();
    const selectedMarketPackageEditions = new Map();
    const registeredIdentityMetadata = new Map();
    let marketHistoryRefresh = 0;
    const installedPackageRecords = new Map();
    // 仅标记本次读取产生的标准化资料，不缓存身份匹配或安装状态。
    const normalizedLocalProfiles = new WeakSet();
    const downloadedPackageDigests = new Map();
    const officialPackageRevisions = new Map();
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
                        bootJson: v.bootJson ? { name: v.bootJson.name, version: v.bootJson.version,
                            ...(v.bootJson.edition ? { edition: v.bootJson.edition } : {}) } : { name: k },
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
    const MODHUB_OFFLINE_WIKI_IDENTITIES = [{ id: 'modhub', name: 'ModHub模组管理中心', bootNames: ['ModHub'],
        aliases: [...MODHUB_KNOWN_MOD_MARKET_ALIASES.modhub], repositoryKeys: MODHUB_OFFLINE_REPOSITORIES.modhub }];
    // 包语言只用于显示，不参与身份匹配或安装授权。
    const MODHUB_VERIFIED_PACKAGE_LANGUAGES = Object.freeze({
        "modhub": [
            "zh-CN",
            "zh-TW",
            "en"
        ],
        "auto-clothes-repair": [
            "zh-CN"
        ],
        "combat-terminator": [
            "zh-CN"
        ],
        "auto-clean": [
            "zh-CN"
        ],
        "blood-boon": [
            "zh-CN"
        ],
        "fallen-loop": [
            "zh-CN"
        ],
        "gwl-rollback": [
            "zh-CN"
        ],
        "honest-markets": [
            "zh-CN"
        ],
        "li-longer-combat": [
            "zh-CN"
        ],
        "eden-roll-back": [
            "zh-CN"
        ],
        "cummilk": [
            "zh-CN"
        ],
        "kitchen-plus": [
            "zh-CN"
        ],
        "dol-tv": [
            "zh-CN"
        ],
        "no-bus-harassment": [
            "zh-CN",
            "en"
        ],
        "guide-to-me": [
            "zh-CN"
        ],
        "chimera-blessing": [
            "zh-CN"
        ],
        "cheat-extended-chris": [
            "zh-CN",
            "zh-TW"
        ],
        "nail-art": [
            "zh-TW"
        ],
        "bailey-rent": [
            "zh-TW"
        ],
        "strange-garden": [
            "zh-TW"
        ],
        "baby-hawk": [
            "zh-CN"
        ],
        "love-locket-text": [
            "zh-CN"
        ],
        "evil-cockroach": [
            "zh-CN"
        ],
        "eden-after-sunset": [
            "zh-CN"
        ],
        "maplebirch": [
            "zh-CN",
            "en"
        ],
        "simple-framework": [
            "zh-CN",
            "en"
        ],
        "doli": [
            "zh-CN",
            "en"
        ],
        "deadwood-reblooms": [
            "zh-CN",
            "en"
        ],
        "fumo-mod": [
            "zh-CN",
            "en"
        ],
        "npc-social-avatars": [
            "zh-CN",
            "en"
        ],
        "longer-combat-emicoto": [
            "zh-CN",
            "en"
        ],
        "candy-and-robot": [
            "zh-CN",
            "en"
        ],
        "dol-phone-mod": [
            "zh-CN"
        ],
        "a-red-secret": [
            "zh-CN"
        ],
        "dol-optimization": [
            "zh-CN"
        ],
        "smartphone": [
            "zh-CN"
        ],
        "little-pc": [
            "zh-CN"
        ],
        "dynamicest": [
            "zh-CN"
        ],
        "fertility-expansion": [
            "zh-CN"
        ],
        "lnn-enemy-stats-display-chs": [
            "zh-CN"
        ],
        "lnn-enemy-stats-display-en": [
            "en"
        ],
        "whitney-extra-mod": [
            "zh-CN"
        ],
        "mod-i18n": [
            "zh-CN"
        ],
        "more-farm-upgrade": [
            "zh-CN"
        ],
        "dom-robin": [
            "zh-CN"
        ],
        "dol-sims": [
            "zh-CN"
        ],
        "terra-expanding": [
            "zh-CN"
        ],
        "custom-hair": [
            "zh-CN"
        ],
        "bunny-transformation": [
            "zh-CN"
        ],
        "more-love-interests": [
            "zh-CN"
        ],
        "character-romance-qol": [
            "zh-CN"
        ],
        "midsummer-night-dream": [
            "zh-CN"
        ],
        "smartphone-omega": [
            "zh-CN"
        ],
        "wraith-reflection": [
            "zh-CN"
        ],
        "sydney-bare-study": [
            "zh-CN"
        ],
        "time-multi": [
            "zxx"
        ],
        "free-speech-attitudes": [
            "zxx"
        ],
        "ui-bar-background": [
            "zh-CN"
        ],
        "eden-visuals": [
            "zh-CN"
        ],
        "special-pose-extension": [
            "zh-TW"
        ],
        "clothing-trait-compatibility": [
            "zh-CN"
        ],
        "head-mask-compatibility": [
            "zxx"
        ],
        "combat-status-display": [
            "zxx"
        ],
        "cheat-lyra": [
            "zxx"
        ],
        "bes-armcover-fix": [
            "zxx"
        ],
        "neoui-patch": [
            "zxx"
        ],
        "custom-spellbook": [
            "zh-CN"
        ],
        "eden-fence-rescue": [
            "zh-CN"
        ],
        "fishing-life": [
            "zh-CN"
        ],
        "eliminate-spaces": [
            "zxx"
        ],
        "realistic-pain": [
            "zxx"
        ],
        "angel-halos": [
            "zh-CN"
        ],
        "extra-recipe-study": [
            "zh-CN"
        ],
        "dol-quest-assistant": [
            "zh-CN"
        ],
        "remy-love": [
            "zh-CN"
        ],
        "exhibitionism-expansion": [
            "zh-CN"
        ],
        "dol-mod-center": [
            "zh-CN"
        ],
        "dolsoftwetgameui-dol-game-ui": [
            "zh-CN"
        ],
        "cheat-extend-hsskyboy": [
            "zh-CN"
        ],
        "free-attitudes": [
            "zh-CN"
        ],
        "lower-sky-box": [
            "zxx"
        ],
        "whitney-expansion": [
            "zh-CN"
        ],
        "cattery": [
            "zh-CN"
        ],
        "better-cheat-command-management": [
            "zh-CN"
        ],
        "eu-clothing-addition": [
            "zh-CN"
        ],
        "little-teachers-pet": [
            "zh-CN"
        ],
        "rw-beautification": [
            "zxx"
        ],
        "inuno-image-pack": [
            "zxx"
        ],
        "dol-arcade-expansion": [
            "zh-TW"
        ],
        "ranch-story": [
            "zh-CN"
        ],
        "brand-new-spaces": [
            "zh-CN"
        ],
        "overfits-slots": [
            "zh-CN"
        ],
        "layering-fixes": [
            "zxx"
        ],
        "background-foreground-template": [
            "en"
        ],
        "trauma-appearance": [
            "zh-CN"
        ],
        "defrock-sydney": [
            "zh-CN",
            "en"
        ],
        "time-hourglass": [
            "zh-CN"
        ],
        "no-auto-rebuy-trash": [
            "zxx"
        ],
        "universal-combat-beautification": [
            "zxx"
        ],
        "universal-combat-zed-fix": [
            "zxx"
        ],
        "no-anal-ride-neo": [
            "zh-CN"
        ],
        "community-ba74fb20-ce11-450e-a1d6-8e27a16553c8": [
            "zh-CN"
        ],
        "factory-flower-sales": [
            "zh-CN"
        ],
        "lurker-capture": [
            "zh-CN"
        ],
        "rainbow-bridge": [
            "zh-CN"
        ],
        "au-beautification": [
            "zxx"
        ],
        "au-facial-expansion": [
            "zh-CN"
        ],
        "paperdoll-plus": [
            "zh-CN",
            "en"
        ],
        "ray-beautification": [
            "zh-CN",
            "en"
        ],
        "ray-extra-clothes": [],
        "sydney-dialogue-events": [
            "zh-CN"
        ],
        "au-hair-optimization": [
            "zh-CN"
        ],
        "decorations-zh-fix": [
            "zh-CN"
        ],
        "degrees-immersion": [
            "en"
        ],
        "combat-ui-rework": [
            "en"
        ],
        "outfit-transfer": [
            "en"
        ]
    });
    const MODHUB_VERIFIED_SOURCE_PACKAGE_LANGUAGES = Object.freeze([
        {
            "name": "ModHub模组管理中心",
            "sourceUrl": "https://github.com/JohnLiao501/ModHub/releases",
            "packageLanguages": [
                "zh-CN",
                "zh-TW",
                "en"
            ]
        },
        {
            "name": "clothesicon · 状态栏服装图标",
            "sourceUrl": "https://github.com/KonoLLo/DoL-Clothesicon",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "小小PC修复增强",
            "sourceUrl": "https://github.com/KonoLLo/Litter-PC-Fix-Enhance",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "NPC社交栏头像5.11.9兼容",
            "sourceUrl": "https://github.com/102326/DoL-NPC-Avatars-Compat",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "美化修正",
            "sourceUrl": "https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-BeautyFixer",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "艾弗里孤儿院便签",
            "sourceUrl": "https://github.com/Daseinfool/DOL-AveryOrphanageNote",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "神殿祈祷室神圣事件去随机化",
            "sourceUrl": "https://github.com/Daseinfool/DOL-TemplePendantGuarantee",
            "packageLanguages": [
                "zxx"
            ]
        },
        {
            "name": "BSA 美化切換",
            "sourceUrl": "https://github.com/chris81605/DoL-BSA-Beauty-Switcher",
            "packageLanguages": [
                "zh-TW"
            ]
        },
        {
            "name": "孤儿院大厅海报",
            "sourceUrl": "https://github.com/ZeroRing233/DOL-Orphanage-Poster-Mod",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "露出拓展",
            "sourceUrl": "https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-MyExhibitionismExpansion",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "作弊模组",
            "sourceUrl": "https://github.com/cphxj123/Dol-BJX-Mods",
            "packageLanguages": [
                "zxx"
            ]
        },
        {
            "name": "血量显示",
            "sourceUrl": "https://github.com/cphxj123/Dol-BJX-Mods",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "言灵解放",
            "sourceUrl": "https://github.com/cphxj123/Dol-BJX-Mods",
            "packageLanguages": [
                "zxx"
            ]
        },
        {
            "name": "随身言灵",
            "sourceUrl": "https://github.com/cphxj123/Dol-BJX-Mods",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "NPC侧边栏头像",
            "sourceUrl": "https://github.com/Maenoko/Mae-s-Picvary-NPC-mod/tree/DOL",
            "packageLanguages": [
                "zxx"
            ]
        },
        {
            "name": "寿里美化",
            "sourceUrl": "https://github.com/sakuramifushika/closeup/",
            "packageLanguages": [
                "zh-CN",
                "en"
            ]
        },
        {
            "name": "默示录：归途之书",
            "sourceUrl": "https://github.com/MaplebirchLeaf/Revelation-The-Book-of-Return",
            "packageLanguages": [
                "zh-CN",
                "en"
            ]
        },
        {
            "name": "更有用的食物",
            "sourceUrl": "https://github.com/chris81605/More-Useful-Foodstuff-/releases/latest",
            "packageLanguages": [
                "zh-TW"
            ]
        },
        {
            "name": "PC的面包坊",
            "sourceUrl": "https://github.com/Liliths-Legacy/DOL-PCbakery-MOD/releases/tag/v1.0.0",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "基本需求",
            "sourceUrl": "https://github.com/YanYeQi/Degrees-of-Lewdity-BasicNeeds/releases/latest",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "npc-Robert",
            "sourceUrl": "https://github.com/LukeM44444/Degrees-of-Lewdity-Chinese-Localization-Robert/releases/latest",
            "packageLanguages": [
                "zh-CN",
                "en"
            ]
        },
        {
            "name": "MapleBirchCE剧情条件解锁面板",
            "sourceUrl": "https://github.com/TXF182/MapleBirchCE/releases/latest",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "伊甸事件拓展",
            "sourceUrl": "https://tieba.baidu.com/p/8651634982?see_lz=1",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "快捷键绑定",
            "sourceUrl": "https://tieba.baidu.com/p/9192223044?see_lz=1",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "奥雅之光Goose服装与鞋子美化",
            "sourceUrl": "https://tieba.baidu.com/p/11036847250",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "DoLChat",
            "sourceUrl": "https://tieba.baidu.com/p/11012599145",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "G模改脸美化整合",
            "sourceUrl": "https://tieba.baidu.com/p/11044288528",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "O0O战斗美化 B3",
            "sourceUrl": "https://tieba.baidu.com/p/11068644986",
            "packageLanguages": [
                "zh-CN"
            ]
        },
        {
            "name": "Snowy G原版补齐美化",
            "sourceUrl": "https://tieba.baidu.com/p/11047225830",
            "packageLanguages": [
                "zh-CN"
            ]
        }
    ]);
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
      ['剧情', /剧情|故事|事件|结局/i, /\bstory\b|plotexpansionmod\b|\bplot[- ](?:expansion|project)\b|\b(?:holiday|temple|monthly) events?\b|\bmonthly temple check\b/i],
      ['NPC', /\bnpc\b|角色|人物/i, /\bnpcs?\b|\b(?:new|original|interactive|supernatural) characters?(?![- ](?:doll|art|artwork|sprites?|graphics?|model|options)\b)\b|(?<!player[- ])(?<!pc )\bcharacter[- ](?:content|expansion|relationships?)\b|\bcharacter and story\b|\blove interests?\b|\b(?:new li|li mod)\b/i],
      ['恋爱', /恋爱|恋人|约会/i, /\blove (?:interests?|mod)\b|\b(?:new li|li mod)\b/i],
      ['地图', /地图|地点|场景/i, /\b(?:maps?|locations?|destinations?|residences|ruins|pier)\b|\bocean and beach\b|\bpet shop\b/i],
      ['农场', /农场|园艺|种植/i, /\b(?:farms?|farming|gardens?|gardening|planting)\b/i],
      ['战斗', /战斗|遭遇战|\bhp\b|\bap\b/i, /\bcombat[- ](?:actions?|controls?|ui|interface|systems?|mechanics?|stats|status)\b|\bduring combat\b|\bgame's combat\b/i],
      ['服装', /服装|衣服|衣物|衣柜|穿戴|饰品|套装/i, /\b(?:clothing|outfits?|wardrobes?|swimsuits?|accessories|masks|fashion)\b/i],
      ['发型', /发型|发色|染发|头发/i, /(?<!before )\bhair(?:dresser|styles?)?\b|\bhair[- ]gradient\b|\bdye[- ]pricing\b/i],
      ['头像', /头像|立绘/i, /\bportraits?\b/i],
      ['界面', /界面|\bui\b|侧边栏|面板|显示/i, /\b(?:ui|gui|interfaces?|sidebar|panels?|navigation|hotkeys?|shortcuts?|colour picker|color picker)\b|\b(?:extra stats|statistics) page\b|\bdisplay script\b|\btext area\b|\bdesktop pets\b|\boutfit (?:transfer|editor)\b|\bweb tool for editing\b|\b(?:radio buttons|passage width|appearance settings|settings import and export|variable inspection)\b|\bhairdresser colou?r controls\b|\bshows the current passage name\b/i],
      ['管理', /管理|管理器|modhub|mod[-_\s]?hub|\bmanager\b/i],
      ['自动化', /自动|快捷/i, /\b(?:hotkeys?|shortcuts?|automat(?:e[sd]?|ic|ion))\b/i], ['言灵', /言灵/i],
      ['数值', /数值|金钱|属性|倍速|时停/i, /\bbanking\b|\bdye[- ]pricing\b|\b(?:taking|take|stealing)\b.{0,40}\bmoney\b|\balways (?:receive|get|draw)\b.{0,30}\bblackjack\b/i],
      ['翻译', /翻译|本地化|汉化/i, /\b(?:translation|locali[sz]ation) (?:project|built|built around)\b|\b(?:indonesian|french|spanish|russian|japanese|american english|brazilian portuguese) (?:translation|locali[sz]ation)\b|\btranslation project targeting\b/i],
      ['料理', /料理|菜谱|烹饪/i, /\b(?:cooking|recipes?|cookbook)\b/i],
      ['图像', /图像|图片替换/i, /\b(?:art|graphics?|image|sprite|icon)[- ](?:mod|pack|project|overhaul|replacement|rework)\b|\bvisual (?:pack|project|overhaul|rework|replacement|mod)\b|\bvisual-novel-style presentation\b|\bsprite-only cosmetic\b|\bgraphics and animation project\b|\breplaces\b.{0,50}\b(?:photos|images)\b|\b(?:redraws?|redrawn|sideview|artwork|skin[- ]colou?r|skin ?tones?|custom-head selector|image layers|character lighting|water-dragon visuals)\b/i],
      ['背景', /背景/i, /\b(?:backgrounds?|foregrounds?|wallpaper)\b|\bsky (?:and weather artwork|rendering canvas)\b/i],
      ['纸娃娃', /纸娃娃/i, /\bdoll(?:mod)?\b|\bpuppet-themed\b/i],
      ['工具', /创作工具|调试器|注入器/i, /\b(?:debugger|injector|patcher|generator|userscript)\b|\btexture-pack manager\b|\bmodloader compatibility layer\b/i],
      ['变身', /变身/i, /\btransformation (?:project|options|template)\b/i],
      ['随机化', /随机化/i, /\brandomiz(?:er|ation)\b/i],
      ['炼金', /炼金/i, /\balchemy\b|\bbrewing potions\b/i],
      ['科技', /科技/i, /\btechnology-themed\b|\bcomputers? and hacking\b/i],
    ];

    // 镜像按顺序回退，自建线路统一核验目录授权；手动浏览器入口单独保留。
    const MIRROR_SERVERS = [
        { id: 'ghproxy', name: 'GH-Proxy 镜像', shortName: 'GH-Proxy', prefix: 'https://gh-proxy.org/' },
        { id: 'llkk', name: 'LLKK 镜像', shortName: 'LLKK', prefix: 'https://gh.llkk.cc/' },
        { id: 'fastgit', name: 'FastGit 镜像', shortName: 'FastGit', prefix: 'https://fastgit.cc/' },
        { id: 'ddlc', name: 'DDLC 镜像', shortName: 'DDLC', prefix: 'https://gh.ddlc.top/' },
        { id: 'boki', name: 'Boki 镜像', shortName: 'Boki', prefix: 'https://github.boki.moe/' },
        { id: 'worker', name: 'ModHub 加速', shortName: 'ModHub', prefix: '', useWorker: true,
            description: '通过 ModHub 下载服务获取安装包，支持一键安装。' },
        { id: 'github-direct', name: 'GitHub 下载', shortName: 'GitHub', prefix: '', direct: true,
            description: '直接从 GitHub 下载；连接失败时自动尝试其他方式。' },
        { id: 'github', name: '浏览器下载（手动安装）', shortName: 'GitHub', prefix: '', browserOnly: true,
            description: '由浏览器下载安装包，完成后请在“导入模组”中安装。' }
    ];
    const MODHUB_MIRROR_STORAGE_KEY = 'modhub_market_mirror';
    function getDefaultMirrorId() {
        return window.modHubGetLanguage?.() === 'en' ? 'github-direct' : 'ghproxy';
    }
    let currentMirrorId = getDefaultMirrorId();
    let hasExplicitMirrorPreference = false;
    try {
        const saved = resolveMirrorServer(localStorage.getItem(MODHUB_MIRROR_STORAGE_KEY)
            ?? localStorage.getItem('dol_opt_market_mirror'), false);
        if (saved) { currentMirrorId = saved.id; hasExplicitMirrorPreference = true; }
    } catch (_) {}

    function resolveMirrorServer(mirrorId, fallback = true) {
        let normId = mirrorId;
        if (normId === 'jasonzeng') normId = 'ddlc';
        if (normId === 'ghfast') normId = 'boki';
        return MIRROR_SERVERS.find(m => m.id === normId)
            || (fallback ? MIRROR_SERVERS.find(m => m.id === getDefaultMirrorId()) : null);
    }
    function syncMirrorControls() {
        const mirror = resolveMirrorServer(currentMirrorId);
        const select = document.getElementById?.('modHubMirrorSelect');
        if (select) select.value = mirror.id;
        const hint = document.getElementById?.('modHubMirrorHint');
        if (hint) modHubText(hint, mirror.description || '通过所选镜像下载，支持一键安装；连接失败时自动尝试其他方式。');
    }
    window.addEventListener('modhub:languagechange', () => {
        if (hasExplicitMirrorPreference) return;
        currentMirrorId = getDefaultMirrorId();
        syncMirrorControls();
    });

    // 内存数据缓存
    let marketModList = [];
    let marketViewRevision = 0;
    let marketDataRequest = null;
    let marketDataRefreshing = false;
    let marketDataLoaded = false;
    let marketViewLoading = false;
    let marketUpdateFrame = null;
    let marketUpdateRenderRevision = 0;
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
    let isLoading = false;
    const batchInstallState = { selecting: false, selected: new Set(), running: false, preparing: false, progressExpanded: true, progressScrollTop: 0, stopRequested: false, progressPhase: '', current: '', completed: 0, total: 0, items: new Map() };

    const MODHUB_BATCH_FINISHED = new Set(['success', 'enabled', 'ready', 'error', 'skipped', 'cancelled']);
    const batchEscape = value => window.modHubEscapeHtml(String(value || ''));
    function batchTargetCounts() {
        const items = [...batchInstallState.items.values()].filter(item => item.role === '目标模组');
        return { total: items.length, finished: items.filter(item => MODHUB_BATCH_FINISHED.has(item.state)).length,
            success: items.filter(item => ['success', 'enabled'].includes(item.state)).length,
            failed: items.filter(item => item.state === 'error').length,
            skipped: items.filter(item => ['ready', 'skipped', 'cancelled'].includes(item.state)).length };
    }
    function startBatchInstallProgress(targets, updateOnly = false) {
        const state = batchInstallState;
        const openPanel = !state.running && !state.preparing;
        if (openPanel) state.progressExpanded = true;
        Object.assign(state, { running: true, preparing: false, stopRequested: false, progressPhase: 'preparing', current: '读取可选版本', completed: 0, total: targets.length });
        state.items = new Map(targets.map(mod => [mod.name, { name: mod.name, key: getMarketModKey(mod), type: updateOnly ? 'update' : 'install', role: '目标模组', state: 'preparing', text: '正在读取可选版本', percent: null }]));
        targets.forEach(mod => resetDownloadProgress(mod.name));
        renderBatchInstallToolbar();
        if (openPanel) setBatchTaskPanelExpanded(true);
    }

    function trackBatchInstallMod(mod, role = '前置模组', type = '') {
        if (!batchInstallState.running) return;
        const previous = batchInstallState.items.get(mod.name);
        if (previous) { if (type) { previous.type = type; previous.requiresAction = true; } if (role === '目标模组') previous.role = role; return; }
        if (!activeDownloadControllers.has(mod.name)) resetDownloadProgress(mod.name);
        batchInstallState.items.set(mod.name, { name: mod.name, key: getMarketModKey(mod), role, type, requiresAction: Boolean(type), state: 'waiting', text: '等待处理', percent: null });
        renderBatchInstallToolbar();
    }

    function setBatchInstallPlan(plan, { preserveOtherItems = false } = {}) {
        if (!batchInstallState.running) return;
        const previous = batchInstallState.items;
        batchInstallState.items = preserveOtherItems ? new Map(previous) : new Map();
        for (const node of plan.nodes.values()) {
            const action = plan.actions.find(item => item.key === node.key);
            const old = previous.get(node.mod.name);
            if (preserveOtherItems && !action && ['success', 'enabled'].includes(old?.state)) continue;
            const blocked = plan.blocked.get(node.key) || node.issue;
            const ready = !action && node.local && !modHubComponentDisabled(node.local.name)
                && (node.requirements || []).every(requirement => satisfiesDependency(node.local.bootJson || node.local, requirement));
            const state = blocked ? old?.state === 'cancelled' ? 'cancelled' : node.issue ? 'error' : 'skipped' : node.skipped ? 'skipped' : !action ? ready ? 'ready' : 'skipped' : node.prepared ? 'prepared' : 'waiting';
            batchInstallState.items.set(node.mod.name, { ...old, name: node.mod.name, key: node.key,
                type: action?.type || old?.type || '', role: plan.roots.has(node.key) ? '目标模组' : '前置模组', state,
                requiresAction: Boolean(action), handled: old?.handled || Boolean(node.prepared),
                text: blocked || (node.skipped ? '本次跳过' : !action ? ready ? '已就绪，无需安装' : '目标未安装，本次跳过' : node.prepared ? '安装包已准备好，等待确认' : action.type === 'enable' ? '等待确认启用' : '等待确认下载'), percent: null });
        }
        for (const item of previous.values()) if (!preserveOtherItems && item.role === '目标模组' && !batchInstallState.items.has(item.name)) {
            batchInstallState.items.set(item.name, { ...item, state: 'skipped', text: '本次未选择安装版本', percent: null });
        }
        renderBatchInstallToolbar();
    }

    function finishBatchInstallProgress() {
        for (const item of batchInstallState.items.values()) if (!MODHUB_BATCH_FINISHED.has(item.state)) {
            item.state = 'cancelled'; item.percent = null;
            item.text = batchInstallState.stopRequested ? '已停止，尚未安装' : '已取消，尚未安装';
        }
        batchInstallState.running = false;
        batchInstallState.progressPhase = ''; batchInstallState.current = '';
        renderBatchInstallToolbar();
    }

    function failBatchInstallProgress(reason) {
        for (const item of batchInstallState.items.values()) if (!MODHUB_BATCH_FINISHED.has(item.state)) {
            setBatchInstallStatus(item.name, 'error', reason);
        }
    }

    function clearBatchInstallResults(modName) {
        if (batchInstallState.running || batchInstallState.preparing) return false;
        const names = modName === undefined ? [...batchInstallState.items.keys()] : [modName];
        let removed = false;
        for (const name of names) {
            if (!batchInstallState.items.delete(name)) continue;
            removed = true;
            if (!marketInstallBusy && !activeDownloadControllers.has(name)) resetDownloadProgress(name);
        }
        renderBatchInstallToolbar();
        return removed;
    }

    function batchItemLabel(item) {
        const value = item.state === 'active' && Number.isFinite(item.percent) ? Math.max(0, Math.min(100, Math.round(item.percent))) : null;
        return ({ preparing: '正在准备', waiting: '等待处理', confirming: '等待确认', active: value === null ? '正在下载' : `下载 ${value}%`, checking: '正在检查', prepared: '等待安装确认',
            installing: item.type === 'enable' ? '正在启用' : item.type === 'update' ? '正在更新' : '正在安装', success: item.type === 'update' ? '已更新' : '已安装',
            enabled: '已启用', ready: '已就绪', error: '未完成', skipped: '已跳过', cancelled: '已取消', cancelling: '正在取消' })[item.state] || '等待处理';
    }

    function batchDisplayName(name) {
        const item = batchInstallState.items.get(name);
        if (!item) return modHubT(name);
        const mod = item.mod || marketModList.find(candidate => getMarketModKey(candidate) === item.key);
        return getLocalizedModName(mod || { name: item.name });
    }

    function batchItemHtml(item) {
        const displayName = batchDisplayName(item.name);
        const value = item.state === 'active' && Number.isFinite(item.percent) ? Math.max(0, Math.min(100, Math.round(item.percent))) : null;
        const tone = item.state === 'error' ? 'red' : ['success', 'enabled', 'ready'].includes(item.state) ? 'green' : 'grey';
        const busy = ['preparing', 'confirming', 'active', 'checking', 'prepared', 'installing', 'cancelling'].includes(item.state);
        return `<div class="modhub-batch-item-heading"><strong class="gold" data-modhub-i18n-ignore>${batchEscape(displayName)}</strong><span class="modhub-batch-item-state ${tone}">${busy ? window.modHubProgressRingHtml(value, displayName + modHubT(batchItemLabel(item))) : ''}<span>${batchEscape(batchItemLabel(item))}</span></span>${batchInstallState.running ? '' : `<button type="button" class="modhub-batch-result-remove" data-mod-name="${batchEscape(item.name)}" aria-label="${batchEscape(modHubT('删除{title}的记录', { title: displayName }))}">删除记录</button>`}</div>
            <div class="modhub-batch-item-detail grey">${item.role === '前置模组' ? '前置模组 · ' : ''}${batchEscape(item.text)}</div>
            ${item.compatibilityHtml ? `<div class="modhub-install-check-result"><span class="grey">本次安装兼容性检查</span>${item.compatibilityHtml}</div>` : ''}`;
    }

    function isBatchProgressItemVisible(item) {
        return item.role === '目标模组' || item.state !== 'ready' && (item.state === 'error' || item.requiresAction || item.handled);
    }

    function batchTaskCounts() {
        const items = [...batchInstallState.items.values()].filter(isBatchProgressItemVisible);
        const results = items.filter(item => MODHUB_BATCH_FINISHED.has(item.state)).length;
        return { active: items.length - results, results,
            success: items.filter(item => ['success', 'enabled'].includes(item.state)).length,
            failed: items.filter(item => item.state === 'error').length,
            skipped: items.filter(item => ['ready', 'skipped', 'cancelled'].includes(item.state)).length };
    }

    function batchTaskPresentation(counts) {
        const busy = batchInstallState.running || batchInstallState.preparing;
        const state = busy ? 'busy' : counts.failed ? 'error' : counts.skipped || counts.active ? 'ended' : 'success';
        const label = busy ? batchInstallState.preparing && !batchInstallState.running ? '正在准备' : '正在处理'
            : state === 'error' ? '存在未完成项' : state === 'ended' ? '已结束' : '已完成';
        const paths = { success: '<path d="m5 12 4 4L19 6"/>', error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>', ended: '<path d="M5 12h14"/>' };
        const icon = busy ? window.modHubProgressRingHtml() : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[state]}</svg>`;
        return { state, label, icon };
    }

    function batchTaskToggleHtml(counts) {
        const state = batchInstallState, presentation = batchTaskPresentation(counts);
        return `<button id="modHubBatchProgressToggle" type="button" class="macro-button modhub-btn-secondary modhub-batch-progress-toggle" data-task-state="${presentation.state}" aria-expanded="${state.progressExpanded}" aria-controls="modHubBatchProgressContent" aria-haspopup="dialog" title="${batchEscape(modHubT('成功 {success} 项，未完成 {failed} 项，跳过或取消 {skipped} 项', counts))}"><span id="modHubBatchTaskIcon" class="modhub-batch-task-icon" aria-hidden="true">${presentation.icon}</span><span class="modhub-batch-task-content"><span class="modhub-batch-task-heading">${modHubLabelHtml('下载任务')}<span id="modHubBatchTaskState" class="modhub-batch-task-state">${modHubLabelHtml(presentation.label)}</span></span><span class="modhub-batch-task-counts"><span id="modHubBatchTaskActiveCount"${state.running || state.preparing ? '' : ' hidden'}>${modHubLabelHtml('进行中 {count} 项', { count: counts.active })}</span><span id="modHubBatchTaskResultCount">${modHubLabelHtml('结果 {count} 项', { count: counts.results })}</span></span></span></button>`;
    }

    function syncBatchTaskCounts() {
        const counts = batchTaskCounts();
        const presentation = batchTaskPresentation(counts);
        const toggle = document.getElementById('modHubBatchProgressToggle');
        if (toggle) {
            if (toggle.dataset.taskState !== presentation.state) {
                toggle.dataset.taskState = presentation.state;
                const icon = document.getElementById('modHubBatchTaskIcon');
                if (icon) icon.innerHTML = presentation.icon;
            }
            toggle.title = modHubT('成功 {success} 项，未完成 {failed} 项，跳过或取消 {skipped} 项', counts);
        }
        const status = document.getElementById('modHubBatchTaskState');
        if (status) modHubText(status, presentation.label);
        for (const [id, key, count] of [['modHubBatchTaskActiveCount', '进行中 {count} 项', counts.active], ['modHubBatchTaskResultCount', '结果 {count} 项', counts.results]]) {
            const node = document.getElementById(id);
            if (node) {
                if (id === 'modHubBatchTaskActiveCount') node.hidden = !batchInstallState.running && !batchInstallState.preparing;
                if (node.textContent !== modHubT(key, { count })) modHubText(node, key, { count });
            }
        }
    }

    function fitBatchTaskPanel() {
        const panel = document.getElementById('modHubBatchProgressContent');
        const toggle = document.getElementById('modHubBatchProgressToggle');
        if (!batchInstallState.progressExpanded || !panel || panel.hidden || !toggle?.getBoundingClientRect) return;
        const height = window.innerHeight || 800;
        const targetHeight = Math.min(520, Math.max(0, height - 84));
        const top = Math.min(Math.max(12, toggle.getBoundingClientRect().bottom + 8), Math.max(12, height - 72 - targetHeight));
        panel.style.setProperty?.('--modhub-task-panel-top', `${top}px`);
    }

    function setBatchTaskPanelExpanded(expanded, returnFocus = false) {
        const state = batchInstallState;
        const list = document.getElementById('modHubBatchProgressList');
        if (state.progressExpanded && list) state.progressScrollTop = list.scrollTop;
        state.progressExpanded = Boolean(expanded);
        const toggle = document.getElementById('modHubBatchProgressToggle');
        toggle?.setAttribute('aria-expanded', String(state.progressExpanded));
        const panel = document.getElementById('modHubBatchProgressContent');
        if (panel) panel.hidden = !state.progressExpanded;
        if (state.progressExpanded) {
            if (list) list.scrollTop = state.progressScrollTop;
            fitBatchTaskPanel();
            document.getElementById('modHubBatchProgressClose')?.focus();
        } else if (returnFocus) toggle?.focus();
    }

    document.addEventListener('pointerdown', event => {
        const panel = document.getElementById('modHubBatchProgressContent');
        const toggle = document.getElementById('modHubBatchProgressToggle');
        if (!batchInstallState.progressExpanded || !panel || panel.hidden || event.target === panel || panel.contains?.(event.target)
            || event.target === toggle || toggle?.contains?.(event.target)) return;
        setBatchTaskPanelExpanded(false);
    });
    document.addEventListener('keydown', event => {
        const panel = document.getElementById('modHubBatchProgressContent');
        if (event.key !== 'Escape' || !batchInstallState.progressExpanded || !panel || panel.hidden) return;
        event.preventDefault();
        event.stopPropagation?.();
        setBatchTaskPanelExpanded(false, true);
    });
    document.addEventListener('scroll', fitBatchTaskPanel, true);
    window.addEventListener('resize', fitBatchTaskPanel);
    window.addEventListener('modhub:languagechange', () => {
        if (batchInstallState.items.size || batchInstallState.preparing) renderBatchInstallToolbar();
    });

    function updateBatchInstallProgress(modName, status) {
        if (!batchInstallState.running) return;
        const item = batchInstallState.items.get(modName);
        if (!item) return;
        const wasVisible = isBatchProgressItemVisible(item);
        Object.assign(item, { state: status.state, percent: status.percent, text: status.text });
        if (['active', 'checking', 'prepared', 'installing', 'success', 'enabled', 'error', 'cancelled'].includes(status.state)) item.handled = true;
        if (!MODHUB_BATCH_FINISHED.has(status.state)) batchInstallState.current = modName;
        if (wasVisible !== isBatchProgressItemVisible(item)) { renderBatchInstallToolbar(); return; }
        const row = [...(document.querySelectorAll('.modhub-batch-item') || [])].find(element => element.dataset.modName === modName);
        if (row) row.innerHTML = modHubHtml(batchItemHtml(item));
        const title = document.getElementById('modHubBatchProgressTitle');
        const counts = batchTargetCounts();
        if (title) modHubText(title, `批量安装 ${counts.finished}/${counts.total}`);
        const current = document.getElementById('modHubBatchProgressCurrent');
        if (current) modHubText(current, '正在处理：{name}', { name: batchDisplayName(batchInstallState.current || modName) });
        syncBatchTaskCounts();
    }

    function setBatchInstallStatus(modName, state, text) {
        updateBatchInstallProgress(modName, { state, text, percent: null });
    }

    function getMarketModKey(mod) {
        if (mod?.isLanguageGroup) return `language-group:${mod.variantGroupId}`;
        const repo = parseGithubRepo(mod?.githubUrl);
        const key = mod?.identityId || mod?.id || (repo?.key
            ? `${repo.key}${mod.sharedRepository ? `/${normalizeKey(mod.name)}` : ''}` : normalizeKey(mod?.name));
        return `${String(key).toLowerCase()}${repo?.releaseTag ? `@${repo.key}/releases/tag/${encodeURIComponent(repo.releaseTag)}` : ''}${repo?.assetName ? `/${encodeURIComponent(repo.assetName)}` : ''}`;
    }

    function isBatchInstallEligible(mod, profiles = getLocalInstalledProfiles(), useRenderedStatus = false) {
        mod = resolveDisplayedInstallMod(mod, profiles);
        return Boolean(mod && mod.contentType !== 'spell' && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:[/?#]|$)/i.test(mod.githubUrl || '')
            && (mod.catalogSource !== 'community' || hasCommunityReleaseSource(mod))
            && !isWithdrawn(mod)
            && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod)
            && (useRenderedStatus && typeof mod._status === 'string' ? mod._status : checkModInstallStatus(mod, profiles)) === 'not_installed');
    }

    function resolveDisplayedInstallMod(mod, profiles) {
        if (!mod) return null;
        if (mod.isLanguageGroup) {
            const members = mod.variants || [];
            mod = members.find(member => getMarketModKey(member) === selectedMarketLanguages.get(mod.variantGroupId)) || members[0];
            if (!mod) return null;
        }
        const editions = window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions) || [];
        if (editions.length) {
            if (window.modHubMarketVersions?.getLegacyVerifiedRelease?.(mod)) return mod;
            const cardSelection = selectedMarketPackageEditions.get(getMarketModKey(mod));
            const selected = mod._packageEditionUpdateOnly ? mod._selectedPackageEdition : cardSelection || mod._selectedPackageEdition;
            const localProfiles = profiles instanceof Map ? [...profiles].map(([name, profile]) => ({ name, ...profile, bootJson: profile?.bootJson || profile })) : profiles || getLocalInstalledProfiles();
            const installed = editions.filter(edition => localProfiles.some(profile => window.modHubMarketVariants.getPackageEdition(mod, profile)?.id === edition.id));
            const active = editions.find(edition => edition.id === selected) || (installed.length === 1 ? installed[0] : editions[0]);
            mod._selectedPackageEdition = active.id;
            if (!mod._packageEditionUpdateOnly && active.id === cardSelection) mod._packageEditionManual = true;
        }
        return mod;
    }

    function installedUpdateTarget(mod, profiles) {
        const editions = window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions) || [];
        if (!editions.length) return mod;
        const installed = editions.filter(edition => profiles.some(profile => window.modHubMarketVariants.getPackageEdition(mod, profile)?.id === edition.id));
        return installed.length === 1 ? { ...mod, _selectedPackageEdition: installed[0].id, _packageEditionUpdateOnly: true, _packageEditionManual: false } : mod;
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

    const MODHUB_OPTIONAL_ADDON_IDENTITIES = {
        'au-beautification': ['au-hair-optimization', 'au-facial-expansion'],
        'ray-beautification': ['ray-extra-clothes']
    };

    function getOptionalAddonMods(parent, mods = marketModList) {
        if (!parent || !isMarketSourceVisible(parent)) return [];
        const identity = parent?.identityId === undefined ? parent?.id : parent.identityId;
        const identities = Object.hasOwn(MODHUB_OPTIONAL_ADDON_IDENTITIES, identity) ? MODHUB_OPTIONAL_ADDON_IDENTITIES[identity] : [];
        if (!identities.length) return [];
        return (mods || []).filter(mod => identities.includes(mod.identityId === undefined ? mod.id : mod.identityId)
            && isMarketSourceVisible(mod));
    }

    function getDisplayModMembers(entry, mods = marketModList) {
        return (entry.isLanguageGroup ? entry.variants : [entry]).flatMap(mod => [mod, ...getOptionalAddonMods(mod, mods)]);
    }

    function getDisplayMods(mods = marketModList, allLanguages = false) {
        const visible = (mods || []).filter(isMarketSourceVisible);
        const attached = new Set(visible.filter(mod => allLanguages || matchesContentLanguage(mod)).flatMap(mod => getOptionalAddonMods(mod, visible)));
        const roots = visible.filter(mod => !attached.has(mod));
        const products = window.modHubMarketVariants?.groupMods(roots) || roots;
        return allLanguages ? products : products.filter(matchesContentLanguage);
    }

    function getLocalizedModName(mod) {
        return window.modHubGetMarketCardText(mod, 'name').text;
    }

    function getLocalizedSearchEntry(mod) {
        return { ...mod, aliases: [...(Array.isArray(mod.aliases) ? mod.aliases : []), getLocalizedModName(mod)],
            extraText: [mod.extraText || '', window.modHubGetMarketCardText(mod, 'description').text,
                ...[mod.category, ...(mod.tags || [])].filter(Boolean).map(name => window.modHubGetMarketCardText({ name }, 'name').text)].join(' ') };
    }

    function getCardTranslationState(mod) {
        const name = window.modHubGetMarketCardText(mod, 'name');
        const description = window.modHubGetMarketCardText(mod, 'description');
        const tags = [mod.category, ...(mod.tags || [])].filter(Boolean).map(name => window.modHubGetMarketCardText({ name }, 'name'));
        const fields = [name, description, ...tags];
        return { name, description, tags, missing: fields.some(field => field.missing), translated: fields.some(field => field.translated) };
    }

    function renderCardDescription(mod, escapeHtml) {
        const { name, description, tags, missing, translated } = getCardTranslationState(mod);
        return `<div class="modhub-market-desc" data-modhub-card-field="description" data-modhub-i18n-ignore>${escapeHtml(description.text || window.modHubT('暂无说明'))}</div>
            <div class="modhub-market-translation-note grey" data-modhub-card-missing ${missing ? '' : 'hidden'}>部分内容暂缺译文，已显示原文。</div>
            <details class="modhub-market-original" data-modhub-card-original ${translated ? '' : 'hidden'}><summary>查看原文</summary><div data-modhub-i18n-ignore><strong>${escapeHtml(name.source)}</strong><p>${escapeHtml(description.source)}</p>${tags.length ? `<p>${tags.map(tag => escapeHtml(tag.source)).join(' · ')}</p>` : ''}</div></details>`;
    }

    function refreshCardContent(host, mod) {
        const { name, description, missing, translated } = getCardTranslationState(mod);
        const title = host.querySelector('[data-modhub-card-field="name"]');
        if (title) {
            title.textContent = name.text;
            if (host.hasAttribute?.('aria-label')) {
                host.setAttribute('data-modhub-i18n-aria-label-params', JSON.stringify({ name: name.text }));
                host.setAttribute('aria-label', window.modHubT('{name}的模组信息', { name: name.text }));
            }
        }
        const body = host.querySelector('[data-modhub-card-field="description"]');
        if (body) body.textContent = description.text || window.modHubT('暂无说明');
        const note = host.querySelector('[data-modhub-card-missing]');
        if (note) note.hidden = !missing;
        const original = host.querySelector('[data-modhub-card-original]');
        if (original) original.hidden = !translated;
        host.querySelectorAll('[data-modhub-card-tag]').forEach(node => {
            node.textContent = window.modHubGetMarketCardText({ name: node.dataset.modhubCardTag }, 'name').text;
        });
    }

    function getFilteredDisplayMods(filtered, profiles, evaluatedMods) {
        const positions = new Map(filtered.map((mod, index) => [getMarketModKey(mod), index]));
        const all = (evaluatedMods || marketModList.map((mod, index) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: index };
        })).filter(isMarketSourceVisible);
        const members = entry => getDisplayModMembers(entry, all);
        const position = entry => Math.min(...members(entry).map(mod => positions.get(getMarketModKey(mod)) ?? Infinity));
        return getDisplayMods(all).filter(entry => position(entry) !== Infinity).sort((a, b) => position(a) - position(b));
    }

    function syncBatchSelectionControls() {
        document.querySelectorAll('.modhub-market-select').forEach(input => {
            input.checked = batchInstallState.selected.has(input.dataset.modKey);
            const label = input.closest?.('.modhub-market-select-label');
            if (label) label.hidden = !batchInstallState.selecting;
            const card = input.closest?.('.modhub-market-card');
            card?.classList.toggle('is-batch-selectable', batchInstallState.selecting);
            card?.classList.toggle('is-batch-selected', input.checked);
        });
        renderBatchInstallToolbar();
    }

    function toggleBatchSelection(selecting = !batchInstallState.selecting) {
        if (currentMarketSection !== 'packages' || batchInstallState.running || batchInstallState.preparing || marketInstallBusy) return;
        batchInstallState.selecting = Boolean(selecting);
        if (!batchInstallState.selecting) {
            batchInstallState.selected.clear();
            for (const name of batchInstallState.items.keys()) {
                if (downloadProgressState.get(name)?.batchProgress && !activeDownloadControllers.has(name)) resetDownloadProgress(name);
            }
            batchInstallState.items.clear();
            Object.assign(batchInstallState, { stopRequested: false, progressPhase: '', current: '', completed: 0, total: 0, progressExpanded: true, progressScrollTop: 0 });
        }
        syncBatchSelectionControls();
    }

    function setBatchModSelected(key, checked) {
        if (currentMarketSection !== 'packages' || batchInstallState.running || marketInstallBusy || !batchInstallState.selecting) return;
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
        if (currentMarketSection !== 'packages' || batchInstallState.running || marketInstallBusy || !batchInstallState.selecting) return;
        const profiles = getLocalInstalledProfiles();
        getFilteredDisplayMods(filterAndSortMods(), profiles).filter(mod => isBatchInstallEligible(mod, profiles)).forEach(mod => batchInstallState.selected.add(getMarketModKey(mod)));
        syncBatchSelectionControls();
    }

    function clearBatchSelection() {
        if (batchInstallState.running || marketInstallBusy) return;
        batchInstallState.selected.clear();
        syncBatchSelectionControls();
    }

    function renderBatchInstallToolbar(profiles, evaluatedMods) {
        const state = batchInstallState;
        if (!state.running && !state.preparing && state.selected.size) {
            profiles = profiles || getLocalInstalledProfiles();
            const eligibleKeys = new Set(getDisplayMods(evaluatedMods).filter(mod => state.selected.has(getMarketModKey(mod))
                && isBatchInstallEligible(mod, profiles, Boolean(evaluatedMods))).map(getMarketModKey));
            for (const key of state.selected) if (!eligibleKeys.has(key)) state.selected.delete(key);
        }
        document.querySelectorAll('#modHubMarketBtnRefresh, [data-modhub-market-tool], .modhub-market-tool-pin, #modHubMirrorSelect, .btn-market-install, .btn-market-update, .btn-market-addons, .btn-market-language-choice, .btn-market-package-edition, .modhub-market-update-all, .modhub-market-summary-button, .modhub-market-select').forEach(control => {
            const mod = marketModList[Number(control.dataset?.modIndex)];
            control.disabled = state.running || state.preparing || Boolean(mod && activeDownloadControllers.has(mod.name))
                || state.selecting && ['btn-market-install', 'btn-market-update', 'btn-market-addons'].some(name => control.classList.contains(name))
                || marketInstallBusy && ['btn-market-language-choice', 'btn-market-package-edition', 'btn-market-install', 'btn-market-update', 'btn-market-addons', 'modhub-market-summary-button'].some(name => control.classList.contains(name));
        });
        const toolbar = document.getElementById('modHubMarketBatchToolbar');
        if (!toolbar) return;
        toolbar.hidden = currentMarketSection !== 'packages';
        const filters = document.querySelector('#modHubModMarketContainer .modhub-market-filter-row');
        const controls = filters?.closest('.modhub-market-toolbar');
        const selecting = state.selecting && !state.running;
        // 多选操作仍覆盖整个列表，任务入口和浮窗不占用结果栏布局。
        if (controls && (selecting || state.preparing)) {
            if (toolbar.parentNode !== controls.parentNode) controls.after(toolbar);
        } else {
            const actions = document.getElementById('modHubMarketMainActions');
            if (actions && toolbar.parentNode !== actions) actions.insertBefore(toolbar, document.getElementById('modHubMarketMore'));
        }
        const escapeHtml = window.modHubEscapeHtml || (value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));
        const focusedId = toolbar.contains?.(document.activeElement) ? document.activeElement?.id : '';
        const previousList = document.getElementById('modHubBatchProgressList');
        if (state.progressExpanded && previousList) state.progressScrollTop = previousList.scrollTop;
        toolbar.classList.toggle('is-active', selecting || state.preparing);
        toolbar.classList.toggle('is-entry', !selecting && !state.preparing);
        const counts = batchTargetCounts();
        if (state.running) {
            toolbar.innerHTML = '';
        } else {
            toolbar.innerHTML = modHubHtml(`
                <button id="modHubBatchToggle" type="button" class="macro-button ${state.selecting ? 'modhub-btn-secondary' : 'modhub-btn-primary modhub-batch-entry'}" aria-pressed="${state.selecting}"${state.selecting ? '' : ' aria-describedby="modHubBatchEntryHint"'}>${state.selecting ? '退出多选' : '多选安装'}</button>
                ${state.selecting ? '' : '<span id="modHubBatchEntryHint" class="modhub-batch-entry-hint">勾选多个模组，统一下载并安装</span>'}
                ${state.selecting ? `<span class="modhub-batch-count grey" role="status" aria-live="polite">已选 ${state.selected.size} 项</span>
                <button id="modHubBatchSelectAll" type="button" class="macro-button modhub-btn-secondary">全选当前筛选</button>
                <button id="modHubBatchClear" type="button" class="macro-button modhub-btn-secondary" ${state.selected.size ? '' : 'disabled'}>清空选择</button>
                <button id="modHubBatchInstall" type="button" class="macro-button modhub-btn-primary" ${state.selected.size ? '' : 'disabled'}>下载并安装（${state.selected.size}）</button>` : ''}`);
        }
        const visibleProgressItems = [...state.items.values()].filter(isBatchProgressItemVisible);
        toolbar.classList.toggle('is-expanded', selecting || state.preparing);
        if (visibleProgressItems.length || state.running || state.preparing) {
            const taskCounts = batchTaskCounts();
            toolbar.innerHTML += modHubHtml(`<div id="modHubBatchProgressDetails" class="modhub-batch-progress-details">${batchTaskToggleHtml(taskCounts)}<section id="modHubBatchProgressContent" class="modhub-batch-task-panel" role="dialog" aria-modal="false" aria-labelledby="modHubBatchTaskPanelTitle"${state.progressExpanded ? '' : ' hidden'}><div class="modhub-batch-task-panel-header"><strong id="modHubBatchTaskPanelTitle" class="gold">${modHubLabelHtml('下载与安装任务')}</strong><button id="modHubBatchProgressClose" type="button" class="macro-button modhub-btn-secondary modhub-batch-task-close" aria-label="${escapeHtml(modHubT('收起任务面板'))}" title="${escapeHtml(modHubT('收起面板不会停止任务。'))}"><span aria-hidden="true">&times;</span></button></div><div class="modhub-batch-status" role="status" aria-live="polite"><strong id="modHubBatchProgressTitle" class="gold">${state.preparing && !state.running ? '正在准备批量安装' : state.running ? `批量安装 ${counts.finished}/${counts.total}` : `查看上次结果（完成 ${counts.success} 项）`}</strong>${state.running ? `<span id="modHubBatchProgressCurrent">${state.current ? escapeHtml(modHubT('正在处理：{name}', { name: batchDisplayName(state.current) })) : '正在准备安装计划'}</span>` : ''}</div>${state.running ? `<button id="modHubBatchStop" type="button" class="macro-button modhub-btn-secondary" ${state.stopRequested ? 'disabled' : ''}>${state.stopRequested ? '当前项完成后停止' : '停止后续'}</button>` : state.preparing ? '' : `<div class="modhub-batch-result-actions"><span class="grey">成功 ${counts.success} 项，未完成 ${counts.failed} 项，跳过或取消 ${counts.skipped} 项</span><button id="modHubBatchResultsClear" type="button" class="macro-button modhub-btn-secondary">清除全部记录</button></div>`}<div id="modHubBatchProgressList" class="modhub-batch-progress-list" role="region" aria-label="各模组安装进度，可上下滚动" tabindex="0">${visibleProgressItems.map(item => `<div class="modhub-batch-item" data-mod-name="${batchEscape(item.name)}">${batchItemHtml(item)}</div>`).join('')}</div></section></div>`);
            const list = document.getElementById('modHubBatchProgressList');
            if (list && state.progressExpanded) list.scrollTop = state.progressScrollTop;
            fitBatchTaskPanel();
        }
        const handlers = { modHubBatchToggle: () => toggleBatchSelection(), modHubBatchSelectAll: selectAllVisibleMods, modHubBatchClear: clearBatchSelection, modHubBatchInstall: () => installSelectedMods(), modHubBatchStop: () => { state.stopRequested = true; renderBatchInstallToolbar(); }, modHubBatchResultsClear: () => clearBatchInstallResults() };
        Object.entries(handlers).forEach(([id, handler]) => {
            const button = document.getElementById(id);
            if (button) button.onclick = handler;
        });
        toolbar.querySelectorAll('.modhub-batch-result-remove').forEach(button => { button.onclick = () => clearBatchInstallResults(button.dataset.modName); });
        const progressToggle = document.getElementById('modHubBatchProgressToggle');
        if (progressToggle) progressToggle.onclick = () => setBatchTaskPanelExpanded(!state.progressExpanded);
        const progressClose = document.getElementById('modHubBatchProgressClose');
        if (progressClose) progressClose.onclick = () => setBatchTaskPanelExpanded(false, true);
        if (state.preparing) {
            toolbar.querySelectorAll('button').forEach(button => { if (!['modHubBatchProgressToggle', 'modHubBatchProgressClose'].includes(button.id)) button.disabled = true; });
            const prepareButton = document.getElementById('modHubBatchInstall');
            window.modHubSetButtonBusy(prepareButton, true);
            const label = prepareButton?.querySelector('.modhub-button-busy-label');
            if (label) modHubText(label, '正在准备批量安装');
        }
        if (focusedId) document.getElementById(focusedId)?.focus();
        syncMarketLoadingControls();
    }

    function syncMarketLoadingControls() {
        const status = document.getElementById('modHubMarketLoadStatus');
        if (status) {
            status.hidden = !marketViewLoading;
        }
        if (marketViewLoading) document.querySelectorAll('#modHubMarketBtnRefresh, .btn-market-install, .btn-market-update, .btn-market-addons, .modhub-market-select, .modhub-market-update-all, #modHubBatchInstall')
            .forEach(control => { control.disabled = true; });
    }

    // ==================== 工具函数 ====================

    function cleanText(text) {
        const entities = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' };
        return String(text || '')
            .replace(/&(amp|quot|#39|apos|lt|gt);/gi, (_match, entity) => entities[entity.toLowerCase()])
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
            if (Date.now() - parsed.timestamp > ttl && !allowExpired) return null;
            return key === WIKI_CACHE_KEY && Array.isArray(parsed.data)
                ? normalizeWikiTitles(parsed.data, readLocalCache(IDENTITY_CACHE_KEY, ttl, true)) : parsed.data;
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

    function hasCommunityReleaseSource(mod) {
        return mod?.autoInstall === true && Boolean(parseGithubRepo(safeHttpsUrl(mod.githubUrl)));
    }

    function sourceUrlKey(value) {
        const safe = safeHttpsUrl(value);
        if (!safe) return null;
        const url = new URL(safe);
        url.hash = '';
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.href;
    }

    // 此批次已停止市场支持；本地包仍由玩家在模组管理中自行处理。
    const MODHUB_UNSUPPORTED_MARKET_TARGETS = [{"id":"community-bfec2f9b-fd42-4db1-a8bb-b5a5697fc6fa","sources":["https://discord.com/channels/675158131688603721/1469439826108350564"]},
        {"id":"community-dce6c4e3-32b5-4b42-82b2-8f6a5cf916b7","sources":["https://discord.com/channels/675158131688603721/1502118831815004211"]},
        {"id":"community-65e9acd7-03e1-4ca2-a63d-e63519fb6cc8","sources":["https://discord.com/channels/675158131688603721/1471614393337905192"]},
        {"id":"community-e8ee2deb-5225-4f7e-a056-072c38a22bf5","sources":["https://discord.com/channels/675158131688603721/1366204577359200267"]},
        {"id":"community-02d2c0f3-280b-4a18-a3f0-9dfd4a3dd452","sources":["https://discord.com/channels/675158131688603721/1405971417643749386"]},
        {"id":"community-c9b9731f-3bec-45bb-bb04-9ac497bfb1b3","sources":["https://discord.com/channels/675158131688603721/1411745567272341524"]},
        {"id":"community-7ebeea42-1ee3-4bd9-b969-25d82e1ac6b0","sources":["https://discord.com/channels/675158131688603721/1197873016269443113"]},
        {"id":"community-2104e144-a14d-40aa-85b0-b663a0d9db87","sources":["https://discord.com/channels/675158131688603721/1503880319022010449"]},
        {"id":"community-4fce851c-561e-4a70-ae10-87843bacd989","sources":["https://discord.com/channels/675158131688603721/1266239348240679035"]},
        {"id":"community-cba2d7a8-a6fa-4acf-bcc8-5270b79f70ce","sources":["https://discord.com/channels/675158131688603721/1470682200826445834"]},
        {"id":"community-ea7f1d40-bcef-4687-a3fe-14c0e4b7a533","sources":["https://discord.com/channels/675158131688603721/1472164593542365184"]},
        {"id":"community-b9cf7663-3763-4ef6-b7ef-36ea016431c3","sources":["https://discord.com/channels/675158131688603721/1197837962617040916"]},
        {"id":"community-fcb6dbd3-c5e0-4cc6-b953-c16c7feba21d","sources":["https://discord.com/channels/675158131688603721/1462757470953799690"]},
        {"id":"community-a03cee69-d6d9-4463-9ba6-c222352b3cda","sources":["https://discord.com/channels/675158131688603721/1206959209443237998"]},
        {"id":"community-5b068304-720e-4f36-967f-525a22a3dbeb","sources":["https://discord.com/channels/675158131688603721/1336325007420162048"]},
        {"id":"community-4e721736-f3ca-43fc-b8f5-4fdc8a959fd3","sources":["https://discord.com/channels/675158131688603721/1451127258990383104"]},
        {"id":"community-c42cadf0-e964-4b79-804c-6a218417dc9f","sources":["https://discord.com/channels/675158131688603721/1502531889825714216"]},
        {"id":"community-dc93b02a-653f-448f-b978-fea8f16fe027","sources":["https://discord.com/channels/675158131688603721/1459638074966282438"]},
        {"id":"community-4a6f6025-002f-4261-8de5-4565e08a67c6","sources":["https://discord.com/channels/675158131688603721/1370958943320543482"]},
        {"id":"community-937f6c19-1621-48c6-ac2e-045da83f9d5b","sources":["https://discord.com/channels/675158131688603721/1494356535399157780"]},
        {"id":"community-afb6295e-6fde-462f-bca1-8bd7566c96b9","sources":["https://discord.com/channels/675158131688603721/1391456535741468803"]},
        {"id":"community-b7171a1d-5293-4a60-a0e5-e71a891abb3c","sources":["https://discord.com/channels/675158131688603721/1384950395952042115"]},
        {"id":"community-9ed826a7-fac9-4221-96e2-249ddbf6865f","sources":["https://discord.com/channels/675158131688603721/1382555292256043089"]},
        {"id":"community-4aedbc89-fdab-4ed6-a7a5-5e0387b273c8","sources":["https://discord.com/channels/675158131688603721/1382128620608426075"]},
        {"id":"community-310c8145-a26f-4ba3-a6b9-fbeb5c3c1de5","sources":["https://discord.com/channels/675158131688603721/1376736369740742817"]},
        {"id":"community-03d950c3-a28e-4770-8606-210209e8aa6b","sources":["https://discord.com/channels/675158131688603721/1376287738931839048"]},
        {"id":"community-84133e8c-bd70-4c7a-b475-5e78d87a4485","sources":["https://discord.com/channels/675158131688603721/1361945226968699012"]},
        {"id":"community-d20f735b-fd1e-4b76-b48f-4893ca9849c7","sources":["https://discord.com/channels/675158131688603721/1358375313574199299"]},
        {"id":"community-05795d3b-ea78-4eff-a360-30c0e0e750de","sources":["https://discord.com/channels/675158131688603721/1356295167774162955"]},
        {"id":"community-de9a0fad-cf80-40d3-a41f-fddeb9669a31","sources":["https://discord.com/channels/675158131688603721/1346882281729556490"]},
        {"id":"community-91199707-04d7-43a0-ace9-26be01095619","sources":["https://discord.com/channels/675158131688603721/1356675449178034246"]},
        {"id":"community-00b4c3e7-1443-472d-ade3-dc4c47af0cef","sources":["https://discord.com/channels/675158131688603721/1340827432071991386"]},
        {"id":"community-49ff3341-d489-489c-a08d-29007d09a655","sources":["https://discord.com/channels/675158131688603721/1340492768123814010"]},
        {"id":"community-b55ac713-5728-43a1-89ce-c7ad20d20020","sources":["https://discord.com/channels/675158131688603721/1331009456359604317"]},
        {"id":"community-b9d4c62a-eb5f-4181-92fc-2ce4b67c5080","sources":["https://discord.com/channels/675158131688603721/1326585199122714728"]},
        {"id":"community-b2719230-05b4-4bf5-abd7-515e6accc91b","sources":["https://discord.com/channels/675158131688603721/1326341261669564487"]},
        {"id":"community-6770a49d-fe19-44bc-9083-a17760724c2e","sources":["https://discord.com/channels/675158131688603721/1322577237308080148"]},
        {"id":"community-43e0fae4-8949-41ca-b9a0-09165dfd1e04","sources":["https://discord.com/channels/675158131688603721/1318336238960246784"]},
        {"id":"community-1b7cac3f-f061-4037-89b0-faab2b9bcfb6","sources":["https://discord.com/channels/675158131688603721/1308968780927602838"]},
        {"id":"community-90d3ae44-3b5c-4951-a382-c017eba355f0","sources":["https://discord.com/channels/675158131688603721/1301574701033717914"]},
        {"id":"community-6979d282-7655-48df-8649-9c6710ea4eba","sources":["https://discord.com/channels/675158131688603721/1300116648954433640"]},
        {"id":"community-972f2f4c-dce8-4e9b-9d1d-087ce8823952","sources":["https://discord.com/channels/675158131688603721/1293974748342259795"]},
        {"id":"community-8585f38d-4e8a-494f-aade-a9e3e81ca930","sources":["https://discord.com/channels/675158131688603721/1284230376411103303"]},
        {"id":"community-02cd31a6-efba-4fd3-bbe5-a753cc763420","sources":["https://discord.com/channels/675158131688603721/1283628935258832906"]},
        {"id":"community-6c6c2f54-97f7-4c7a-ab18-054f55533496","sources":["https://discord.com/channels/675158131688603721/1266418801059303424"]},
        {"id":"community-6273d2c3-b5e6-457e-ae90-eacaf890c44c","sources":["https://discord.com/channels/675158131688603721/1253668468486836236"]},
        {"id":"community-0e13bf89-5498-45e7-a2cb-3d4a16d5aa11","sources":["https://discord.com/channels/675158131688603721/1253630656668368926"]},
        {"id":"community-357ede43-6952-422b-a327-4d6597584897","sources":["https://discord.com/channels/675158131688603721/1251565810208735332"]},
        {"id":"community-eac3d6c9-1825-47ff-a252-d66307f5439b","sources":["https://discord.com/channels/675158131688603721/1244340470855893022"]},
        {"id":"community-cf8ef0fc-f086-4cc4-a4ba-303f7a128d81","sources":["https://discord.com/channels/675158131688603721/1247763175194234920"]},
        {"id":"community-783f99ad-c3a0-444f-97d6-80f0a31bfad2","sources":["https://discord.com/channels/675158131688603721/1239178939323125810"]},
        {"id":"community-0f8ba3cb-8e4a-4151-8b14-fc7ccb2fe5ad","sources":["https://discord.com/channels/675158131688603721/1232757274141786143"]},
        {"id":"community-55fcfb50-8ef9-44fd-8ac9-c3126afe0dc7","sources":["https://discord.com/channels/675158131688603721/1225729558116962395"]},
        {"id":"community-0fb9c65c-bd66-4526-a4fd-cba6b35de597","sources":["https://discord.com/channels/675158131688603721/1223889154488799273"]},
        {"id":"community-b72ea479-9d4a-4a73-bb25-5a69f7437019","sources":["https://discord.com/channels/675158131688603721/1223147089484054658"]},
        {"id":"community-31c323be-8cb9-402b-b0c7-9b115d9c201c","sources":["https://discord.com/channels/675158131688603721/1220006857746284656"]},
        {"id":"community-f598ace4-6b53-4b6c-96b1-89d49cc479f6","sources":["https://discord.com/channels/675158131688603721/1214050411502243840"]},
        {"id":"community-8d5565fa-ab4a-413c-92a3-1cca35056745","sources":["https://discord.com/channels/675158131688603721/1204845476059418654"]},
        {"id":"community-0595d80d-b2c6-4bf8-a10a-63ae6525b398","sources":["https://discord.com/channels/675158131688603721/1198091542380957746"]},
        {"id":"community-f0db65da-fdd6-43ba-a3fa-0e3768d11f3d","sources":["https://discord.com/channels/675158131688603721/1198053338588127252"]},
        {"id":"community-708ae7a3-15c8-4033-8971-81cdc4b02e5d","sources":["https://discord.com/channels/675158131688603721/1493698537165291541"]},
        {"id":"community-de922316-a764-4ea1-84eb-6e1c2b9327f8","sources":["https://discord.com/channels/675158131688603721/1492249624084218076"]},
        {"id":"community-95073947-9b95-475d-9817-ccb85a23e702","sources":["https://discord.com/channels/675158131688603721/1491818407405031566"]},
        {"id":"community-24a0b975-9456-4a77-b171-6d07e9b742fe","sources":["https://discord.com/channels/675158131688603721/1484029648240251053"]},
        {"id":"community-4ebfd1a2-0fbc-4d92-bd06-e5d6791820fd","sources":["https://discord.com/channels/675158131688603721/1484018091590422619"]},
        {"id":"community-f0b8da6e-3385-4509-9171-5b41e51201e4","sources":["https://discord.com/channels/675158131688603721/1476007910789222442"]},
        {"id":"community-12d9406f-28d8-42c9-9557-b4312f041a85","sources":["https://discord.com/channels/675158131688603721/1483492660013432972"]},
        {"id":"community-018ab22e-a920-4381-a97a-7d6c2d519a69","sources":["https://discord.com/channels/675158131688603721/1469325659863122057"]},
        {"id":"community-e804d1fe-5799-45f0-b8dd-861381bd969e","sources":["https://discord.com/channels/675158131688603721/1464216544434192496"]},
        {"id":"community-a24c3bd7-c0ce-4247-993a-6fa3a1ae09fa","sources":["https://discord.com/channels/675158131688603721/1449772305117872219"]},
        {"id":"community-6fa53d9b-1045-4b25-b09a-9c1ab181b3ca","sources":["https://discord.com/channels/675158131688603721/1440831677839442052"]},
        {"id":"community-50df5a4a-06da-424d-bc76-ee52e69ff3c5","sources":["https://discord.com/channels/675158131688603721/1438503937815609424"]},
        {"id":"community-b3fb9741-277e-48ad-8b13-91934dd4b7be","sources":["https://discord.com/channels/675158131688603721/1425967335952617544"]},
        {"id":"community-75d2adb1-b04e-4410-a704-e3ff51031c6c","sources":["https://discord.com/channels/675158131688603721/1425743463437176914"]},
        {"id":"community-650a80ab-c862-4ba9-a67a-e6bcf6fc0fb7","sources":["https://discord.com/channels/675158131688603721/1425439390716526693"]},
        {"id":"community-90c428d1-4c7c-425f-a8ff-abcf7d9733fb","sources":["https://discord.com/channels/675158131688603721/1415842884728520815"]},
        {"id":"community-a47dc4d6-cd74-48cf-b7af-6d8c4dcb3b91","sources":["https://discord.com/channels/675158131688603721/1414905206466019388"]},
        {"id":"community-ed2be936-a693-44c7-b90c-399b6552c175","sources":["https://discord.com/channels/675158131688603721/1406338522184417442"]},
        {"id":"community-5695ef7f-746e-4533-94d3-1b11f0da1fc4","sources":["https://discord.com/channels/675158131688603721/1400892949193035786"]},
        {"id":"community-e6bf4094-c492-4e61-8564-f700ca48e8eb","sources":["https://discord.com/channels/675158131688603721/1396741451391438848"]},
        {"id":"community-a76d0ed6-a538-4c30-965f-83d6f3da1701","sources":["https://discord.com/channels/675158131688603721/1394685777883041945"]},
        {"id":"community-386f6110-1a2e-409f-8122-fa36087addda","sources":["https://discord.com/channels/675158131688603721/1392760102842531910"]},
        {"id":"community-5416f4b5-bed3-4191-a6a3-d95ad7cf1d6e","sources":["https://discord.com/channels/675158131688603721/1423798459214856212"]},
        {"id":"community-feccf18e-15ef-4c97-a6ce-b92397848792","sources":["https://discord.com/channels/675158131688603721/1423798459214856212"]},
        {"id":"community-98d9dc83-27cb-4ffb-9890-c2299f4701d9","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1432555681898168350"]},
        {"id":"community-3d286443-8189-4db2-8889-aee5445fbff5","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1423802687652233437"]},
        {"id":"community-32bff4af-474e-457f-9ae0-69f34d00329e","sources":["https://discord.com/channels/675158131688603721/1423798459214856212"]},
        {"id":"community-21638345-90e4-4649-bf96-51bf3d8b16fc","sources":["https://discord.com/channels/675158131688603721/1423798459214856212"]},
        {"id":"community-6f67b53f-aed1-4d31-a44c-4ecbbbb19655","sources":["https://discord.com/channels/675158131688603721/1554229888532348979"]},
        {"id":"community-6795444f-6753-48a3-a3d9-7900553aedec","identityIds":["degrees-immersion"],"repositoryKeys":["whelm027/Degrees-of-Inmersion"],"bootNames":["Degrees of Inmersion"],"sources":["https://discord.com/channels/675158131688603721/1539431497730363523","https://github.com/whelm027/Degrees-of-Inmersion","https://github.com/whelm027/Degrees-of-Inmersion/releases/tag/1.2.2","https://github.com/whelm027/Degrees-of-Inmersion/releases/download/1.2.2/DegreesImmersion-1.2.2.fixedfrfr.zip"]},
        {"id":"community-d8d0041a-ed9c-4d07-b906-841b4346ce99","sources":["https://discord.com/channels/675158131688603721/1528045669145907341"]},
        {"id":"community-6e413dcc-ad34-4e03-8bc0-d833542c9087","sources":["https://discord.com/channels/675158131688603721/1503627497214971914"]},
        {"id":"community-2aa5e15d-cfb8-4866-b9b3-df8453df166c","sources":["https://discord.com/channels/675158131688603721/1530407664666935426"]},
        {"id":"community-e6c58061-f0eb-4423-b900-86cd534f2b24","identityIds":["combat-ui-rework"],"repositoryKeys":["LeafGithub/D4Mods-Releases"],"bootNames":["DOL Combat UI Rework"],"sources":["https://discord.com/channels/675158131688603721/1459705660479373424","https://github.com/LeafGithub/D4Mods-Releases","https://github.com/LeafGithub/D4Mods-Releases/releases/tag/v20261004.100940-cc92637","https://github.com/LeafGithub/D4Mods-Releases/releases/download/v20261004.100940-cc92637/dol-combat-ui-rework-mod.zip"]},
        {"id":"community-e6da30e0-f86a-4dbb-aadb-ccbbb72b9a76","identityIds":["outfit-transfer"],"repositoryKeys":["LeafGithub/D4Mods-Releases"],"bootNames":["DOL Outfit Transfer"],"sources":["https://discord.com/channels/675158131688603721/1556315225551020043","https://github.com/LeafGithub/D4Mods-Releases","https://github.com/LeafGithub/D4Mods-Releases/releases/tag/v20261004.142506-bbdb652","https://github.com/LeafGithub/D4Mods-Releases/releases/download/v20261004.142506-bbdb652/dol-outfit-transfer-mod.zip"]},
        {"id":"community-8b97173b-3cdd-4783-947e-495d7f793552","sources":["https://discord.com/channels/675158131688603721/1514680245641548007"]},
        {"id":"community-2508ea81-2b7b-4c90-b96f-7cc9b0da6618","sources":["https://discord.com/channels/675158131688603721/1546413533867147354"]},
        {"id":"community-2efbb7c3-601b-408c-b603-fd64deb3a07b","sources":["https://discord.com/channels/675158131688603721/1391211032369827981"]},
        {"id":"community-8234501a-3962-44e7-806f-ee1e483ff711","sources":["https://discord.com/channels/675158131688603721/1393115734170931370"]},
        {"id":"community-8e5dcfad-0553-4bfb-bc56-2aa44888f900","sources":["https://discord.com/channels/675158131688603721/1412729040950919168"]},
        {"id":"community-d44037d5-12d4-440d-bd27-fb473e8f6f69","sources":["https://discord.com/channels/675158131688603721/1419854390055010456"]},
        {"id":"community-62e7311c-4f9a-4e87-b60a-0a75ed22f5fc","sources":["https://discord.com/channels/675158131688603721/1419022179487449288"]},
        {"id":"community-58c06287-d3dd-4490-8959-7d531200a5ed","sources":["https://discord.com/channels/675158131688603721/1441191881399865464"]},
        {"id":"community-f8e61877-ad7e-45f6-9536-d58acabc819d","sources":["https://discord.com/channels/675158131688603721/1463374588242296942"]},
        {"id":"community-238ee0f1-7f12-4d75-8bd7-9615d086fda1","sources":["https://discord.com/channels/675158131688603721/1476247286588641381"]},
        {"id":"community-9d755bad-d3c8-4f0b-9a41-10814c565c12","sources":["https://discord.com/channels/675158131688603721/1239132433639804958"]},
        {"id":"community-bc6bbd8e-c335-456a-9bfb-c4117741b385","sources":["https://discord.com/channels/675158131688603721/1250776871788871843"]},
        {"id":"community-c4ed0815-f631-4c67-84d1-6802c0c72b97","sources":["https://discord.com/channels/675158131688603721/1252423370104901692"]},
        {"id":"community-832ca174-4db2-40ad-8741-d09640769d55","sources":["https://discord.com/channels/675158131688603721/1293317653087260782"]},
        {"id":"community-deb43fd5-cfdc-457b-a2a6-9527666f8776","sources":["https://discord.com/channels/675158131688603721/1294689221629575188"]},
        {"id":"community-fe2f9511-c968-45e0-b93e-da643d8c5f10","sources":["https://discord.com/channels/675158131688603721/1446934029675790376/1452482741244268695"]},
        {"id":"community-886caadb-a0a2-4b3b-b1d1-54f45ca40652","sources":["https://discord.com/channels/675158131688603721/1446934029675790376/1453242742166786244"]},
        {"id":"community-18bc0033-bb76-4c47-91f6-1b6a31eb72a5","sources":["https://discord.com/channels/675158131688603721/1446934029675790376/1452868082048696341"]},
        {"id":"community-16c4e5bf-71fe-4a71-9572-3409094f43f6","sources":["https://discord.com/channels/675158131688603721/1446934029675790376/1461867595010539602"]},
        {"id":"community-318611b7-028d-4bc2-864a-2d8f395093ae","sources":["https://discord.com/channels/675158131688603721/1446934029675790376/1462301230440124479"]},
        {"id":"community-40cf7801-2556-4c1f-8662-da1ca3a285d8","bootNames":["select head"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43329/uploads/f59dc46b447e59a040df521a1244a6c3/select-head-1.4.2.mod.zip","https://gitgud.io/xxvirus/dol-select-head/-/releases/v142","https://gitgud.io/-/project/43329/uploads/dae8ceb7316036ff95a4b34b723f3be4/select-head-1.4.2-cn-compat.mod.zip"]},
        {"id":"community-d7582e37-45bc-4ac3-8df1-6156c946d1cf","bootNames":["skin detail"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43331/uploads/f9138baff1d8ea7fb42bae023c2bcaaf/skin-detail-2.0.1.mod.zip","https://gitgud.io/xxvirus/dol-skin-detail/-/releases/v201","https://gitgud.io/-/project/43331/uploads/de77289a8e203ee1afb6a84431642a82/skin-detail-2.0.1-cn-compat.mod.zip"]},
        {"id":"community-8d926bec-f6ac-4253-8004-780bee69393f","bootNames":["yes teeth"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43333/uploads/c6f03336b0bac5e9f66b851cde58b210/yes_teeth.zip","https://gitgud.io/xxvirus/dol-yes-teeth/-/releases/v102"]},
        {"id":"community-3babf937-1428-400f-8cc8-c6f85850f386","bootNames":["custom makeup"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43328/uploads/4bb182f427b4ee16b5b6a3edfc26d0ee/custom-makeup-201.mod.zip","https://gitgud.io/xxvirus/dol-custom-makeup/-/releases/V201","https://gitgud.io/-/project/43328/uploads/89aedd2a35068589f525f5b4b363ac62/custom-makeup-201-cn-compat.mod.zip"]},
        {"id":"community-db6a1322-a494-40f7-81d7-490181aad70c","bootNames":["dye HARDER"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43337/uploads/d98623c72731dd3e5e79bcd15a3c4ea9/dye-HARDER-0.26.mod.zip","https://gitgud.io/xxvirus/dol-dye-harder/-/releases/v026","https://gitgud.io/-/project/43337/uploads/b20d999252ca3777befec6ddcb6413d5/dye-HARDER-0.26-cn-compat.mod.zip"]},
        {"id":"community-a88fd667-088d-4159-bd19-94764d0904b1","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1423800677934829659"]},
        {"id":"community-128c091f-b168-4a4e-850d-932f9fc79db1","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1423801652040831037"]},
        {"id":"community-497a1743-21e9-4679-9e62-dd1ea78bb269","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1428540294982275114"]},
        {"id":"community-803b845b-d355-4ebe-ba41-ecde4b416f1d","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1431504441437065247"]},
        {"id":"community-dca07ddf-3dad-431c-ad72-27d0843da493","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1424195920248967289"]},
        {"id":"community-01abf7c0-7461-4422-943a-23ce84c77fc0","sources":["https://discord.com/channels/675158131688603721/1423798459214856212/1429573086595780710"]},
        {"id":"community-2e641260-a655-4ef8-a16b-415f48340d5d","bootNames":["yes teeth"],"sources":["https://discord.com/channels/675158131688603721/1447674006562930871","https://gitgud.io/-/project/43334/uploads/abcaa2e7f1c44c1f23e326432a034067/yes_teeth_dolp.zip","https://gitgud.io/xxvirus/dolp-yes-teeth/-/releases/v102"]}];
    const MODHUB_RETAINED_MARKET_IDENTITIES = new Set(["ray-beautification", "npc-social-avatars", "paperdoll-plus"]);
    const MODHUB_UNSUPPORTED_MARKET_IDS = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.map(target => target.id));
    const MODHUB_UNSUPPORTED_MARKET_IDENTITIES = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.flatMap(target => target.identityIds || []));
    const MODHUB_UNSUPPORTED_MARKET_BOOT_NAMES = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.flatMap(target => target.bootNames || []).map(name => name.toLowerCase()));
    const MODHUB_UNSUPPORTED_SHARED_REPOSITORIES = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.flatMap(target => target.repositoryKeys || [])
        .map(key => key.toLowerCase()).filter((key, index, keys) => keys.indexOf(key) !== index));
    const MODHUB_UNSUPPORTED_MARKET_SOURCES = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.flatMap(target => target.sources).map(sourceUrlKey));
    const MODHUB_UNSUPPORTED_MARKET_REPOSITORIES = new Set(MODHUB_UNSUPPORTED_MARKET_TARGETS.flatMap(target => target.sources)
        .filter(source => /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(source)).map(sourceUrlKey));
    function isUnsupportedMarketTarget(mod) {
        const id = String(mod.id || '').toLowerCase(), identity = String(mod.identityId || '').toLowerCase();
        if (MODHUB_UNSUPPORTED_MARKET_IDS.has(id)) return true;
        if (MODHUB_RETAINED_MARKET_IDENTITIES.has(id) || MODHUB_RETAINED_MARKET_IDENTITIES.has(identity)) return false;
        if (MODHUB_UNSUPPORTED_MARKET_IDENTITIES.has(id) || MODHUB_UNSUPPORTED_MARKET_IDENTITIES.has(identity)) return true;
        const names = [...(Array.isArray(mod.bootNames) ? mod.bootNames : []), mod._matchedLocal?.name].filter(Boolean)
            .map(name => String(name).trim().toLowerCase());
        if (names.some(name => MODHUB_UNSUPPORTED_MARKET_BOOT_NAMES.has(name))) return true;
        const urls = [mod.sourceUrl, mod.otherUrl, mod.githubUrl, ...(Array.isArray(mod.otherUrls) ? mod.otherUrls : []),
            ...(Array.isArray(mod.githubUrls) ? mod.githubUrls : []),
            ...(Array.isArray(mod.sources) ? mod.sources.flatMap(source => [source.url, source.sourceUrl, source.downloadUrl]) : [])]
            .map(sourceUrlKey).filter(Boolean);
        return urls.some(key => {
            if (!MODHUB_UNSUPPORTED_MARKET_SOURCES.has(key)) return false;
            // 共用仓库先核验精准产品；根地址不能阻止该仓库的其他产品。
            if (MODHUB_UNSUPPORTED_SHARED_REPOSITORIES.has(extractRepoKey(key))
                && (MODHUB_UNSUPPORTED_MARKET_REPOSITORIES.has(key) || identity || names.length)) return false;
            return !MODHUB_UNSUPPORTED_MARKET_REPOSITORIES.has(key) || !identity && !names.length;
        });
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
        if (isUnsupportedMarketTarget(mod)) return true;
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
                    contentType: item.contentType === 'spell' ? 'spell' : 'package',
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
            contentType: row.contentType === 'spell' ? 'spell' : row.contentType === 'package' ? 'package' : previous.contentType || 'package',
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
        const spellView = currentMarketSection === 'spells';
        const targetType = spellView ? '言灵' : '模组';
        const displayTargetType = modHubT(targetType);
        const mode = await window.modHubConfirm({
            title: '纠错与下架申请', message: '请选择申请类型。', confirmText: modHubT(`选择${targetType}`), cancelText: '取消',
            selectLabel: '申请类型', selectOptions: [
                { value: 'correct', label: '资料纠错' }, { value: 'withdraw', label: '申请下架' }
            ]
        });
        if (!['correct', 'withdraw'].includes(mode) || batchInstallState.running) return false;
        const targets = (spellView ? window.modHubMarketSpells?.getSpells() || [] : marketModList).filter(mod => !isWithdrawn(mod));
        if (!targets.length) {
            await window.modHubAlert?.(modHubT('当前没有可选择的{kind}，请刷新市场后再试。', { kind: displayTargetType }));
            return false;
        }
        const labels = targets.map(mod => {
            const source = marketExternalUrl(mod) || modHubT('来源未标注');
            return modHubT('{name} · 作者: {author} · 来源: {source}', {
                name: getLocalizedModName(mod) || modHubT('未命名' + targetType), author: mod.author || modHubT('未标注'), source
            });
        });
        const selected = await window.modHubConfirm({
            title: modHubT(mode === 'correct' ? `选择纠错${targetType}` : `选择下架${targetType}`),
            dialogClass: 'modhub-market-feedback-dialog',
            trustedMessageHtml: `<label class="modhub-feedback-search-label">搜索完整目录<input class="modhub-feedback-search" type="search" autocomplete="off" placeholder="名称、作者、来源、拼音或首字母"></label>`,
            selectLabel: modHubT(`目标${targetType}`), selectValue: '', requireSelection: true,
            selectOptions: [{ value: '', label: modHubT(`请选择目标${targetType}`), disabled: true },
                ...labels.map((label, index) => ({ value: String(index), label }))],
            confirmText: '填写申请', cancelText: '取消',
            onRender(dialog) {
                const search = dialog.querySelector('.modhub-feedback-search');
                const select = dialog.querySelector('.modhub-modal-select');
                const confirm = dialog.querySelector('.modhub-modal-btn-confirm');
                select.size = Math.min(targets.length + 1, 6);
                search.focus?.();
                search.oninput = () => {
                    const query = window.modHubSearch.compile(search.value);
                    select.replaceChildren();
                    const placeholder = document.createElement('option');
                    placeholder.value = '';
                    modHubText(placeholder, `请选择目标${targetType}`);
                    placeholder.disabled = true;
                    select.appendChild(placeholder);
                    targets.map((mod, index) => ({ index, score: window.modHubSearch.score({ ...getLocalizedSearchEntry(mod),
                        extraText: [mod.extraText, marketExternalUrl(mod)] }, query) }))
                        .filter(item => item.score >= 0)
                        .sort((a, b) => b.score - a.score || a.index - b.index)
                        .forEach(({ index }) => {
                            const option = document.createElement('option');
                            option.value = String(index);
                            modHubText(option, labels[index]);
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
                    const message = modHubT(targetState.activeDelistStatus ? '该{kind}已有进行中的下架申请，请等待审核结果。'
                        : targetState.targetStatus === 'withdrawn' ? '该{kind}已下架，无需重复申请。'
                            : targetState.targetStatus === 'missing' ? '当前目录中未找到该{kind}，请刷新市场后再试。'
                                : '暂时无法确认该{kind}的在架状态，请稍后重试。', { kind: displayTargetType });
                    await window.modHubAlert?.(message);
                    return false;
                }
            } catch (error) {
                await window.modHubAlert?.(error.message || modHubT('无法确认{kind}状态，请稍后重试。', { kind: displayTargetType }));
                return false;
            }
        }
        return target ? openCommunitySubmission(mode, target) : false;
    }

    async function openCommunitySubmission(mode = 'new', mod = null, knownReceipt = '') {
        if (typeof window.modHubConfirm !== 'function' || !['new', 'spell', 'my', 'correct', 'withdraw', 'amend'].includes(mode)) return false;
        // 新候选仅使用手工公共草稿，不接受协助记录或其他来源的预填内容。
        if (mode === 'spell') { mod = null; knownReceipt = ''; }
        const isMine = mode === 'my';
        const isAmend = mode === 'amend';
        const isSpell = mode === 'spell' || mode === 'correct' && mod?.contentType === 'spell'
            || isAmend && ['add', 'correct'].includes(mod?.kind) && mod?.contentType === 'spell';
        const spellFields = ['body', 'syntax', 'inputLocation', 'instructions', 'parameters', 'prerequisites', 'gameVersionRange', 'modVersions', 'verificationMethod', 'submittedEnvironmentVerified'];
        const isWithdrawForm = mode === 'withdraw';
        const isPackageSubmission = !isSpell && (mode === 'new' || isAmend && mod?.kind === 'add');
        const hasCategoryField = isPackageSubmission || !isSpell && (mode === 'correct' || isAmend && mod?.kind === 'correct');
        const submissionCategories = ['框架与前置', '剧情与角色', '玩法与内容', '界面与便利', '外观与资源', '规则与数值', '修复与兼容'];
        const sourceLocked = isAmend && (mod?.kind !== 'add' || mod?.approvedCatalogId);
        const catalogId = String(isAmend ? (mod?.catalogId || '') : (mod?.id || '')).slice(0, 100);
        const isCatalogFeedback = Boolean(catalogId) && (['correct', 'withdraw'].includes(mode)
            || (isAmend && ['correct', 'withdraw'].includes(mod?.kind)));
        const sourceUrl = safeHttpsUrl(mod?.sourceUrl || mod?.otherUrl || mod?.githubUrl) || '';
        const draftKey = `${mode}:${isAmend ? mod?.id || '' : catalogId || sourceUrl}`;
        const draft = readSubmissionDraft(draftKey);
        const titles = { new: '申请上架 / 推荐模组', spell: '投稿候选言灵', my: '我的投稿', correct: '纠错', withdraw: '申请下架', amend: isSpell ? '补充候选言灵资料' : '补充投稿资料' };
        const escapeHtml = window.modHubEscapeHtml || (value => String(value ?? '').replace(/[&<>"']/g,
            char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));
        const formFieldsHtml = isSpell ? `
            <p class="grey">候选内容只进入审核，不会自动公开。请手动整理可公开的通用内容，不要填写聊天记录、诊断、源码包、日志、存档、私人变量值、协助码或令牌。</p>
            <label>言灵名称<input name="name" maxlength="100" required></label>
            <label>作者或提交者<input name="author" maxlength="100" required></label>
            <label>公开来源链接（原创可留空）<input name="sourceUrl" type="url" maxlength="1000" inputmode="url"></label>
            <label>用途说明<textarea name="description" maxlength="1000" required></textarea></label>
            <label>言灵正文<textarea name="body" maxlength="64000" rows="8" spellcheck="false" required></textarea></label>
            <label>语法类型<input name="syntax" maxlength="200" required></label>
            <label>输入位置<input name="inputLocation" maxlength="1000" required></label>
            <label>使用步骤<textarea name="instructions" maxlength="8000" required></textarea></label>
            <label>参数说明（无参数请填写“无”）<textarea name="parameters" maxlength="4000" required></textarea></label>
            <label>前提条件<textarea name="prerequisites" maxlength="4000" required></textarea></label>
            <label>适用游戏版本或范围<input name="gameVersionRange" maxlength="200" required></label>
            <label>适用模组及版本（不依赖模组请填写“无”）<textarea name="modVersions" maxlength="4000" required></textarea></label>
            <label>验证方法<textarea name="verificationMethod" maxlength="4000" required></textarea></label>
            <label>补充说明<textarea name="notes" maxlength="1000"></textarea></label>
            <label class="modhub-community-check"><input name="submittedEnvironmentVerified" type="checkbox" required><span>我已在上述提交者环境中按验证方法确认结果。</span></label>
            <p class="grey">此项仅记录提交者自述的环境验证。通用适配尚无结论，须由审核继续核验，不能视为其他环境安全或可用。</p>
            <label class="modhub-community-check"><input name="publicationConsent" type="checkbox" required><span>我已移除私人资料，并同意将填写的内容提交公开收录审核。</span></label>` : isWithdrawForm ? `
            <div class="modhub-community-target">
                <strong data-modhub-i18n-ignore>${escapeHtml(mod?.name || '未命名模组')}</strong>
                <span class="grey">${modHubLabelHtml('作者')}：<span data-modhub-i18n-ignore>${escapeHtml(mod?.author || modHubT('未标注'))}</span></span>
                <span class="grey">${modHubLabelHtml('目录条目')}：<span data-modhub-i18n-ignore>${escapeHtml(catalogId)}</span></span>
                <span class="grey">${modHubLabelHtml('来源')}：<span data-modhub-i18n-ignore>${escapeHtml(sourceUrl || modHubT('暂无来源链接，按目录条目核对'))}</span></span>
            </div>
            <input name="name" type="hidden" maxlength="100"><input name="author" type="hidden" maxlength="100">
            <input name="sourceUrl" type="hidden" maxlength="1000"><textarea name="description" hidden maxlength="1000"></textarea>
            <label>下架原因<textarea name="notes" maxlength="1000" required></textarea></label>` : `
            <div class="modhub-community-intro"><strong class="gold">${isPackageSubmission ? '将模组提交到市场目录' : '补充准确的模组资料'}</strong><p>${isPackageSubmission ? '您可以申请收录自己的模组，也可以推荐其他作者的作品。审核通过后，模组才会在市场展示。' : '请填写需要更正的资料，审核人员会结合现有目录核对。'}</p><span class="grey">标有“必填”的项目须填写；关闭后可继续编辑本机草稿。</span></div>
            <fieldset class="modhub-community-section"><legend>基本信息</legend>
            <div class="modhub-community-grid"><label>${modHubLabelHtml('模组名称')} <span class="gold">${modHubLabelHtml('必填')}</span><input name="name" maxlength="100" placeholder="填写模组的完整名称" required></label>
            <label>${modHubLabelHtml('作者')} <span class="gold">${modHubLabelHtml('必填')}</span><input name="author" maxlength="100" placeholder="填写原作者名称" required></label></div>
            <label>${isCatalogFeedback ? modHubLabelHtml('当前目录来源（未标注时留空）') : `${modHubLabelHtml('来源链接')} <span class="gold">${modHubLabelHtml('必填')}</span>`}<input name="sourceUrl" type="url" maxlength="1000" inputmode="url" placeholder="https://" ${isCatalogFeedback ? 'readonly' : 'required'}></label>
            ${isCatalogFeedback ? '' : '<p class="modhub-community-hint grey">请提供作者发布页或公开介绍页，便于核对作品与来源。</p>'}
            ${isCatalogFeedback ? `<p class="grey">${modHubLabelHtml('申请绑定目录条目 {id}；没有来源链接也可提交。新增来源链接请填写在补充说明中，供审核人员核验。', { id: catalogId })}</p>` : ''}
            </fieldset>
            <fieldset class="modhub-community-section"><legend>分类与简介</legend>
            ${hasCategoryField ? `<label>${modHubLabelHtml('模组分类')} <span class="${mode === 'new' ? 'gold' : 'grey'}">${modHubLabelHtml(mode === 'new' ? '必填' : '可调整')}</span><select name="category" ${mode === 'new' ? 'required' : ''}><option value="">${modHubT(mode === 'new' ? '请选择最符合主要功能的分类' : '不修改分类')}</option>${submissionCategories.map(category => `<option value="${category}" data-modhub-i18n-key="${category}">${modHubT(category)}</option>`).join('')}</select></label><p class="modhub-community-hint grey">${isPackageSubmission ? '按模组的主要功能选择一类；审核人员可根据实际内容调整。' : '当前分类不准确时，可选择更合适的分类；选择“不修改分类”仅更正其他资料。'}</p>` : ''}
            <label>${modHubLabelHtml('简介')} <span class="gold">${modHubLabelHtml('必填')}</span><textarea name="description" maxlength="1000" placeholder="介绍主要功能、使用方式或适用范围" required></textarea></label>
            </fieldset>
            <fieldset class="modhub-community-section"><legend>${modHubLabelHtml('补充说明')} <span class="grey">${modHubLabelHtml('可选')}</span></legend>
            <label>补充说明或申请原因<textarea name="notes" maxlength="1000" placeholder="可补充版本要求、前置模组或需要审核人员了解的信息"></textarea></label></fieldset>`;
        const formHtml = `<form class="modhub-community-form" novalidate>
            <div class="modhub-community-fields">
            ${formFieldsHtml}
            <div class="modhub-community-result" hidden><strong class="modhub-community-result-title">投稿已提交</strong><p>查询凭证已保存在本机；换设备或清除本机数据前，请另行备份。</p><button type="button" class="macro-button modhub-btn-sub modhub-community-copy">复制凭证</button><details><summary>查看完整查询凭证</summary><code class="modhub-community-receipt" tabindex="-1"></code></details></div>
            </div>
            <div class="modhub-community-safety">
                <div class="modhub-community-challenge-wrap"><span class="modhub-community-safety-label grey">安全验证</span><iframe class="modhub-community-challenge" title="安全验证" sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer"></iframe></div>
                <p class="modhub-community-status grey" role="status" aria-live="polite">请完成安全验证。</p>
                <div class="modhub-community-actions"><button type="submit" class="macro-button modhub-btn-primary modhub-community-submit" disabled>${isAmend ? '提交补充资料' : mode === 'withdraw' ? '提交下架申请' : '提交审核'}</button></div>
            </div>
        </form>`;
        const mineHtml = `<div class="modhub-community-my">
            <div class="modhub-community-list-tools">
                <label>搜索投稿<input class="modhub-community-search" type="search" autocomplete="off" placeholder="投稿名称"></label>
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
                if (status) modHubText(status, '安全验证已过期，请重新完成。');
                return;
            }
            if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) return;
            challengeToken = data.token;
            if (submit) submit.disabled = false;
            if (status) modHubText(status, '安全验证已完成，可以提交。');
        };
        if (!isMine) window.addEventListener('message', onMessage);
        try {
            return await window.modHubConfirm({
                title: titles[mode], confirmText: '关闭', cancelText: '', dialogClass: `modhub-community-dialog ${isMine ? 'is-query' : 'is-form'}${isSpell || mod?.contentType === 'spell' ? ' is-spell' : ''}`,
                trustedMessageHtml: isMine ? `${mineHtml}<p class="modhub-community-status grey" role="status" aria-live="polite"></p>` : formHtml,
                onRender(currentDialog) {
                    dialog = currentDialog;
                    dialog.addEventListener('keydown', event => {
                        if (event.key === 'Enter' && event.target.closest?.('.modhub-community-form, .modhub-community-my')) {
                            event.stopPropagation();
                        }
                    }, true);
                    const status = dialog.querySelector('.modhub-community-status');
                    const tell = message => { if (status) modHubText(status, message); };
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
                        const kindLabel = row => row.kind === 'add' && row.contentType === 'spell' ? '候选言灵' : kindLabels[row.kind] || '投稿';
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
                                            kind: payload.kind || '', contentType: payload.contentType === 'spell' ? 'spell' : 'package', status: 'pending_confirmation', updatedAt: '', queriedAt: 0,
                                            targetStatus: '', activeDelistStatus: '', canRequestDelist: false });
                                    }
                                });
                            } catch (_) {}
                            return records;
                        };
                        let records = readRecords();
                        const formatRecordTime = record => {
                            const time = Number(record.queriedAt);
                            return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString(window.modHubGetLanguage?.() || 'zh-CN', {
                                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                            }) : '尚未查询';
                        };
                        const renderRecordMeta = (node, record, lastQuery) => {
                            const labels = [kindLabel(record)];
                            if (lastQuery) labels.push(submissionStatusLabel(record));
                            labels.push(lastQuery ? '上次查询' : '查询于', formatRecordTime(record));
                            labels.forEach((label, index) => {
                                const part = document.createElement('span');
                                modHubText(part, label);
                                node.appendChild(part);
                                if (index < labels.length - 1) {
                                    const separator = document.createElement('span');
                                    separator.textContent = index === labels.length - 2 ? ' ' : ' · ';
                                    node.appendChild(separator);
                                }
                            });
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
                                modHubText(empty, records.length ? '没有符合筛选条件的投稿。' : '本机尚未保存投稿，可在下方用查询凭证恢复。');
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
                                if (record.name) { title.textContent = record.name; title.setAttribute('data-modhub-i18n-ignore', ''); }
                                else modHubText(title, '未命名投稿');
                                const meta = document.createElement('span');
                                meta.className = 'grey';
                                renderRecordMeta(meta, record, true);
                                open.appendChild(title);
                                open.appendChild(meta);
                                open.onclick = () => querySubmission(record.receipt);
                                card.appendChild(open);
                                saved.appendChild(card);
                            });
                            modHubText(pageLabel, `${currentPage} / ${pages}，共 ${filtered.length} 条`);
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
                            const title = deleting ? row.kind === 'add' ? row.contentType === 'spell' ? '删除候选言灵' : '删除推荐' : '删除投稿' : '撤回投稿';
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
                            modHubSubmissionSummary(summary, row.name, '投稿', submissionStatusLabel(row));
                            detail.appendChild(summary);
                            const meta = document.createElement('p');
                            meta.className = 'grey';
                            renderRecordMeta(meta, { ...row, queriedAt: Date.now() }, false);
                            detail.appendChild(meta);
                            if (row.contentType !== 'spell' && submissionCategories.includes(row.category)) {
                                const category = document.createElement('p');
                                modHubText(category, '申请分类：{category}', { category: modHubT(row.category) });
                                detail.appendChild(category);
                            }
                            if (row.contentType === 'spell') {
                                const verification = document.createElement('p');
                                modHubText(verification, `提交者环境：${row.spell?.submittedEnvironmentVerified === true ? '已验证（提交者自述）' : '未声明已验证'}；通用适配：尚无结论，待审核核验。`);
                                detail.appendChild(verification);
                            }
                            if (row.reviewerNote) {
                                const note = document.createElement('p');
                                modHubText(note, '审核说明：{note}', { note: row.reviewerNote });
                                detail.appendChild(note);
                            }
                            if (row.duplicateOf && row.mergedProgress) {
                                const merged = document.createElement('p');
                                modHubText(merged, `此申请已归并到较早的申请，当前进度：${statusLabels[row.mergedProgress.status] || '处理中'}`);
                                detail.appendChild(merged);
                            }
                            const addAction = (label, handler, danger = false) => {
                                const actionButton = document.createElement('button');
                                actionButton.type = 'button';
                                actionButton.className = `macro-button ${danger ? 'modhub-btn-danger' : 'modhub-btn-sub'}`;
                                modHubText(actionButton, label);
                                actionButton.onclick = handler;
                                detail.appendChild(actionButton);
                            };
                            if (!row.duplicateOf && ['pending', 'needs_info', 'manual_check'].includes(row.status)) {
                                addAction('补充资料', () => { if (!operationBusy) openCommunitySubmission('amend', row, receipt); });
                                if (!row.approvedCatalogId) addAction('撤回投稿', () => runAction(row, receipt, 'withdraw'), true);
                            }
                            if (!row.duplicateOf && !row.approvedCatalogId && row.status !== 'approved') {
                                addAction(row.kind === 'add' ? row.contentType === 'spell' ? '删除候选言灵' : '删除推荐' : '删除投稿', () => runAction(row, receipt, 'delete'), true);
                            }
                            if (!row.duplicateOf && row.approvedCatalogId) {
                                const target = document.createElement('p');
                                if (row.targetStatus === 'withdrawn') modHubText(target, `当前目录状态：${row.contentType === 'spell' ? '言灵' : '模组'}已下架`);
                                else if (row.targetStatus === 'missing') modHubText(target, `当前目录状态：未找到对应${row.contentType === 'spell' ? '言灵' : '模组'}`);
                                else if (row.activeDelistStatus) modHubText(target, `下架申请：${statusLabels[row.activeDelistStatus] || '处理中'}`);
                                else if (row.targetStatus === 'active') modHubText(target, '当前目录状态：仍在架');
                                else modHubText(target, '当前目录状态尚未确认，请稍后重新查询。');
                                detail.appendChild(target);
                                if (row.canRequestDelist === true) {
                                    addAction('申请下架', async () => {
                                        if (operationBusy) return;
                                        let target = row;
                                        if (row.contentType === 'spell') {
                                            try {
                                                target = window.modHubMarketSpells?.getSpells().find(entry => entry.id === row.approvedCatalogId);
                                                if (!target) {
                                                    await fetchReleaseIndex();
                                                    target = window.modHubMarketSpells?.getSpells().find(entry => entry.id === row.approvedCatalogId);
                                                }
                                                if (!target) throw new Error('当前目录中未找到该言灵，请刷新市场并重新查询投稿。');
                                            } catch (error) { await window.modHubAlert?.(error.message); return; }
                                        }
                                        if (!closed) openCommunitySubmission('withdraw', {
                                            ...target, id: row.approvedCatalogId, ...(row.contentType === 'spell' ? submissionTargetFields(target) : {}), notes: ''
                                        });
                                    });
                                }
                            }
                        };
                        const renderMissingRecord = (record, receipt, message) => {
                            detail.replaceChildren();
                            const explanation = document.createElement('p');
                            modHubSubmissionSummary(explanation, record?.name, '这条投稿', message || '服务端已找不到该记录。');
                            detail.appendChild(explanation);
                            const remove = document.createElement('button');
                            remove.type = 'button';
                            remove.className = 'macro-button modhub-btn-danger';
                            modHubText(remove, '从本机移除');
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
                    const fields = ['name', 'author', 'sourceUrl', 'description', 'notes', ...(hasCategoryField ? ['category'] : []), ...(isSpell ? [...spellFields, 'publicationConsent'] : [])];
                    const input = Object.fromEntries(fields.map(name => [name, form.elements.namedItem(name)]));
                    const values = () => Object.fromEntries(fields.map(name => [name, input[name].type === 'checkbox' ? input[name].checked === true
                        : name === 'body' ? input[name].value : input[name].value.trim()]));
                    let pending = /^[A-Za-z0-9_-]{43}$/.test(draft?.pending?.receipt || '') && draft?.pending?.payload
                        ? draft.pending : null;
                    const storedInitial = pending ? { ...draft?.fields, ...pending.payload, ...pending.payload.spell } : draft?.fields || {
                        name: mod?.name || '', author: mod?.author || '', sourceUrl,
                        description: mod?.description || '', notes: mod?.notes || '', category: mod?.category || '', ...(isSpell ? mod?.spell : {})
                    };
                    const initial = isWithdrawForm && !pending ? {
                        name: mod?.name || '', author: mod?.author || '', sourceUrl,
                        description: mod?.description || '', notes: storedInitial.notes || ''
                    } : storedInitial;
                    fields.forEach(name => {
                        if (input[name].type === 'checkbox') input[name].checked = false;
                        else input[name].value = name === 'category' ? (submissionCategories.includes(initial[name]) ? initial[name] : '')
                            : String(initial[name] || '').slice(0, input[name].maxLength);
                    });
                    if ((sourceLocked || isCatalogFeedback) && !pending) input.sourceUrl.value = sourceUrl;
                    const submit = dialog.querySelector('.modhub-community-submit');
                    const result = dialog.querySelector('.modhub-community-result');
                    const resultTitle = dialog.querySelector('.modhub-community-result-title');
                    const resultReceipt = dialog.querySelector('.modhub-community-receipt');
                    frame = dialog.querySelector('.modhub-community-challenge');
                    const lockFields = locked => fields.forEach(name => {
                        input[name].disabled = locked && input[name].type !== 'checkbox' || (isWithdrawForm && name !== 'notes')
                            || ((sourceLocked || isCatalogFeedback) && name === 'sourceUrl');
                    });
                    const resetSpellConfirmation = () => {
                        if (isSpell) { input.submittedEnvironmentVerified.checked = false; input.publicationConsent.checked = false; }
                    };
                    lockFields(false);
                    const refreshChallenge = (message = '') => {
                        challengeToken = '';
                        submit.disabled = true;
                        nonce = submissionNonce();
                        if (!nonce) { tell('当前浏览器无法完成安全验证。'); return; }
                        const challenge = new URL('/community-challenge', RELEASE_WORKER_API_BASE);
                        challenge.searchParams.set('nonce', nonce);
                        challenge.searchParams.set('embedded', '1');
                        challenge.searchParams.set('language', window.modHubGetLanguage?.() || 'zh-CN');
                        const width = frame.clientWidth || (dialog.clientWidth && dialog.clientWidth - 24)
                            || (window.innerWidth && window.innerWidth - 48) || 440;
                        // 验证页两侧各留 8px，普通控件另需 300px。
                        frame.dataset.size = width < 316 ? 'compact' : 'normal';
                        if (width < 316) {
                            challenge.searchParams.set('size', 'compact');
                        }
                        frame.src = challenge.href;
                        tell(message || '请完成安全验证。');
                    };
                    if (pending) {
                        lockFields(true);
                        modHubText(submit, '重试提交');
                    }
                    fields.forEach(name => input[name].addEventListener('input', () => {
                        if (isSpell && input[name].type !== 'checkbox') resetSpellConfirmation();
                        if (name === 'category' && submissionCategories.includes(input[name].value) && status?.textContent === modHubT('请选择模组分类。')) {
                            tell(challengeToken ? '安全验证已完成，可提交审核。' : '请完成安全验证。');
                        }
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
                        if ((!current.sourceUrl && !isCatalogFeedback && !isSpell) || (current.sourceUrl && !safeHttpsUrl(current.sourceUrl))) {
                            tell(isCatalogFeedback || isSpell ? '来源链接如有填写，须是有效的 HTTPS 链接。' : '推荐模组须填写有效的 HTTPS 来源链接。'); return;
                        }
                        if (!current.name || (kind !== 'withdraw' && (!current.author || !current.description))
                            || (kind === 'withdraw' && !current.notes)) {
                            tell(kind === 'withdraw' ? '请填写下架原因。' : isSpell ? '请填写言灵名称、作者或提交者和用途说明。' : '请填写模组名称、作者和简介。'); return;
                        }
                        if (hasCategoryField && !pending && (mode === 'new' || current.category) && !submissionCategories.includes(current.category)) {
                            tell('请选择模组分类。'); input.category.focus(); return;
                        }
                        if (isSpell && spellFields.filter(name => name !== 'submittedEnvironmentVerified').some(name => !current[name]?.trim())) {
                            tell('请完整填写正文、使用环境、参数、前提及验证方法；不依赖模组或没有参数时，请明确填写“无”。'); return;
                        }
                        if (isSpell && (!current.submittedEnvironmentVerified || !current.publicationConsent)) {
                            tell('请确认已在所填环境验证，并移除私人资料后同意提交审核。'); return;
                        }
                        const spellPlatform = isSpell && current.sourceUrl ? Object.entries({ github: ['github.com', 'www.github.com'],
                            tieba: ['tieba.baidu.com'], discord: ['discord.com', 'www.discord.com', 'discord.gg'] })
                            .find(([, hosts]) => hosts.includes(new URL(current.sourceUrl).hostname))?.[0] : '';
                        if (isSpell && current.sourceUrl && !spellPlatform) { tell('言灵来源仅支持 GitHub、百度贴吧或 Discord；原创候选可留空。'); return; }
                        if (isSpell && pending && fields.filter(name => name !== 'publicationConsent').some(name =>
                            current[name] !== (spellFields.includes(name) ? pending.payload.spell?.[name] : pending.payload[name]))) {
                            pending = null; lockFields(false); resetSpellConfirmation();
                            saveSubmissionDraft(draftKey, { fields: values() });
                            tell('候选内容已改变，请重新核对全部公开字段并确认后提交。'); return;
                        }
                        if (!pending) {
                            const receipt = isAmend ? knownReceipt : submissionReceipt();
                            if (!/^[A-Za-z0-9_-]{43}$/.test(receipt || '')) { tell('无法生成安全查询凭证。'); return; }
                            const publicFields = isSpell ? { ...Object.fromEntries(['name', 'author', 'sourceUrl', 'description', 'notes'].map(name => [name, current[name]])),
                                contentType: 'spell', sources: current.sourceUrl ? [{ platform: spellPlatform, url: current.sourceUrl }] : [], packageRecords: [], spell: { ...Object.fromEntries(spellFields.map(name => [name, current[name]])), generalCompatibility: 'unverified' } } : current;
                            const payload = { ...publicFields, receipt, catalogId,
                                kind: isAmend ? mod.kind : mode === 'new' || mode === 'spell' ? 'add' : mode,
                                ...(!isSpell && mod?.contentType === 'spell' ? { contentType: 'spell', spell: mod.spell, sources: mod.sources || [], packageRecords: [] } : {}),
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
                                if (latest.revision <= pending.payload.revision || !fields.filter(name => name !== 'publicationConsent').every(name =>
                                    (isSpell && spellFields.includes(name) ? latest.spell?.[name] === pending.payload.spell?.[name] : latest[name] === pending.payload[name]))) throw error;
                                row = latest;
                            }
                            if (typeof row.id !== 'string' || !row.id) throw new Error('服务响应缺少投稿编号');
                            const saved = saveSubmissionReceipt(row.id, pending.receipt, { ...pending.payload, ...row });
                            if (saved) saveSubmissionDraft(draftKey, null);
                            modHubText(resultReceipt, pending.receipt);
                            modHubText(resultTitle, saved ? '投稿已保存到本机' : '本机保存失败，请备份查询凭证');
                            result.hidden = false;
                            succeeded = true;
                            nonce = null;
                            frame.src = 'about:blank';
                            dialog.querySelector('.modhub-community-challenge-wrap').hidden = true;
                            submit.disabled = true;
                            modHubText(submit, '已提交');
                            tell(saved ? '投稿已记录，可在“我的投稿”中查看进度。' : '投稿已记录，但本机保存失败，请复制查询凭证。');
                            copyButton.focus?.();
                            return;
                        } catch (error) {
                            resetSpellConfirmation();
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
    function normalizeModVersion(mod, value, bootName = '') {
        const text = String(value || '').trim(), id = mod?.identityId || mod?.id;
        const name = String(bootName).toLowerCase();
        // 作者旧手机包的 Alpha.3.xx 对应后续 0.3.xx；仅用于已确认身份的比较，显示保留原文。
        if ((id === 'smartphone' || ['smartphone alpha', 'smartphone', 'smartphone photopack'].includes(name)) && /^Alpha\.3\.\d+(?:\.\d+)*$/i.test(text)) return `0.${text.slice(6)}`;
        if ((id === 'smartphone-omega' || name === 'smartphone omega') && /^Omega\.\d+(?:\.\d+)*$/i.test(text)) return text.slice(6);
        return text;
    }

    function compareVersions(v1, v2, mod = null, bootName = '') {
        v1 = normalizeModVersion(mod, v1, bootName);
        v2 = normalizeModVersion(mod, v2, bootName);
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

    function isSameVersion(left, right, mod = null, bootName = '') {
        const a = normalizeModVersion(mod, left, bootName).replace(/^v(?=\d)/i, '');
        const b = normalizeModVersion(mod, right, bootName).replace(/^v(?=\d)/i, '');
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
        { id: 'clothesicon状态栏服装图标-dol-clothesicon', name: 'clothesicon · 状态栏服装图标', bootNames: ['clothesicon'],
            aliases: ['状态栏服装图标', 'Clothes Icon Bar'], repositories: ['DoL-Clothesicon'],
            repositoryKeys: ['KonoLLo/DoL-Clothesicon'], category: '外观与资源', tags: ['地图', '服装'] },
        { id: 'character-romance-qol', name: '人物附加与生活质量提升', bootNames: ['人物附加与生活质量提升'],
            aliases: ['人物恋爱扩展与生活质量提升'], repositories: ['DolMod-'],
            repositoryKeys: ['doctor55555-55555/DolMod-'], category: '剧情与角色', tags: ['剧情', 'NPC', '恋爱'] },
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
        return { ...mod, name: identity.name, identityId: identity.id, bootNames: [...identity.bootNames], aliases: [...identity.aliases],
            repositories: [...identity.repositories], repositoryKeys: [...identity.repositoryKeys],
            category: identity.category, tags: [...identity.tags],
            dependencies: normalizeDependencyList([...(identity.dependencies || []), ...(mod.dependencies || [])]) };
    }

    function normalizeDependencyList(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.flatMap(item => {
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            if (!id) return [];
            const bootVersions = Object.fromEntries(Object.entries(item.bootVersions && typeof item.bootVersions === 'object' && !Array.isArray(item.bootVersions) ? item.bootVersions : {})
                .filter(([name, version]) => name.trim() && typeof version === 'string' && /^(?:>=|<=|>|<|\^|~)?\s*v?\d+(?:\.\d+)*$/.test(version.trim()))
                .map(([name, version]) => [name.trim(), version.trim()]));
            const key = JSON.stringify([id.toLowerCase(), item.bootName || '', item.version?.trim?.() || '*', bootVersions]);
            if (!id || seen.has(key)) return [];
            seen.add(key);
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
        if (dependency.bootName && (dependency.required
            ? ![boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])].includes(dependency.bootName)
            : String(boot?.name || '').trim().toLowerCase() !== dependency.bootName.trim().toLowerCase())) return false;
        const simple = !requirement || requirement === '*' || /^(?:>=|<=|>|<|=|\^|~)?\s*v?\d+(?:\.\d+)*$/.test(requirement);
        return (!dependency.bootVersions || Boolean(requirement)) && (simple ? satisfiesVersion(boot?.version, requirement)
            : window.modHubMarketVersions?.assessVersionRange?.(boot?.version, requirement)?.status === 'compatible');
    }

    function formatVersionRange(range) {
        return window.modHubMarketVersions?.formatVersionRange?.(range)
            || (range ? `版本要求需手动确认（作者原始写法：${range}）` : '版本要求未声明');
    }

    function formatDependencyRequirement(dependency) {
        if (dependency.allRequirements) return [...new Set(dependency.allRequirements.map(formatDependencyRequirement).filter(Boolean))].join(' 且 ');
        if (dependency.version) return formatVersionRange(dependency.version);
        const labels = { '【AUfemale】model': '女体', '【AUmale】model': '男体', '【AUandrogynous】model': '中性' };
        const variants = Object.entries(dependency.bootVersions || {}).map(([name, version]) => `${labels[name] || name} ${formatVersionRange(version)}`);
        return variants.length ? `${variants.join(' / ')}（任选一种）` : '';
    }

    /** 简介只识别明确的必需声明；展示别名用于找目录，实际提供者仍核验包内 name/alias。 */
    function inferRequiredDependencies(mod, catalog = marketModList) {
        const description = String(mod?.description || mod?.desc || '');
        if (!description) return [];
        const identities = [
            { id: 'maplebirch', bootNames: ['maplebirch'], name: '秋枫白桦框架', aliases: ['枫叶框架', 'Maplebirch Frameworks'] },
            { id: 'simple-framework', bootNames: ['Simple Frameworks'], name: '简易框架', aliases: ['SCML 简易框架', 'SimpleFramework', 'SimpleFrameworks', 'Simple Framework'] },
            ...(Array.isArray(catalog) ? catalog : [])
        ];
        const names = new Map();
        for (const identity of identities) {
            const boots = [...new Set((Array.isArray(identity.bootNames) ? identity.bootNames : []).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
            if (identity.identityId === null || boots.length !== 1) continue;
            for (const name of [identity.name, identity.wikiName, ...boots, ...(Array.isArray(identity.aliases) ? identity.aliases : [])]) {
                if (typeof name !== 'string' || name.trim().length < 2) continue;
                const alias = name.trim(), key = alias.toLowerCase();
                if (!names.has(key)) names.set(key, { alias, modName: boots[0] });
                else if (names.get(key)?.modName !== boots[0]) names.set(key, null);
            }
        }
        const result = [];
        const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const clauses = description.split(/[。！？!?；;\n]/).map(cleanText).filter(sentence => sentence
            && !/(?:可能|有时|如需|若|如果|只有|仅在|仅当|时才|情况|条件|当.+时|可(?:以)?独立(?:运行|使用)|独立运行|单独运行|可选|非必需|非必须|不再|无需|无须|不需|不必|不依赖|移除|取消|optional|standalone|independent|\b(?:may|might|sometimes|if|unless)\b|\bnot\s+(?:requires?|needs?|depends?)\b)/i.test(sentence)
            && !(/(?:或|任选|二选一|任一|均可|\b(?:either|or)\b)/i.test(sentence)
                && new Set([...names.values()].filter(entry => entry && sentence.toLowerCase().includes(entry.alias.toLowerCase())).map(entry => entry.modName)).size > 1))
            .flatMap(sentence => sentence.split(/[，,](?!\s*(?:[<>=^~]|且|并且|或|and\b|or\b))/i)).map(cleanText).filter(Boolean);
        for (const clause of clauses) {
            if (/(?:无需|无须|不再|不必|不需|不依赖|没有依赖|已(?:经)?(?:移除|取消)|移除(?:了)?依赖|取消(?:了)?依赖|可选|非必需|非必须|按需|建议|推荐|兼容|支持|曾经|旧版|以前|如果|若需|optional|without|no longer|does not|not required)/i.test(clause)) continue;
            for (const entry of names.values()) {
                if (!entry) continue;
                const name = '[【「“"\\s]*' + escapePattern(entry.alias).replace(/\s+/g, '\\s*') + '[】」”"\\s]*';
                const boundary = /[a-z0-9_]$/i.test(entry.alias) ? '(?![a-z0-9_])' : '';
                const target = name + boundary;
                const explicit = new RegExp('(?:依赖(?:于)?|需要(?:先)?(?:安装|启用|使用)?|必须(?:先)?(?:安装|启用|使用)?|必需(?:安装|启用)?|前置(?:框架|模组|插件)?\\s*(?:[:：]|为|是)|requires?\\s+|depends\\s+on\\s+)\\s*[:：]?\\s*(?:模组|框架|插件)?\\s*(?:[^。；;!?]*?[、和与及/])?' + target, 'i');
                const framework = new RegExp('(?:通过|基于|使用)\\s*' + target + '(?:框架)?\\s*(?:v?\\d+(?:\\.\\d+)*(?:及以上|以上|或更高)?\\s*)?(?:制作|开发|构建|实现)', 'i');
                const requiredAs = new RegExp(target + '(?:为|是)(?:必需|必须)?前置', 'i');
                if (!explicit.test(clause) && !framework.test(clause) && !requiredAs.test(clause)) continue;
                if (Array.isArray(mod.bootNames) && mod.bootNames.includes(entry.modName)) continue;
                const after = clause.slice(clause.toLowerCase().indexOf(entry.alias.toLowerCase()) + entry.alias.length);
                const tail = after.replace(/^[】」”"\s]*(?:(?:版本(?:要求)?|要求(?:版本)?)\s*[:：]?\s*)?/, '')
                    .replace(/^[（(]\s*(?=[v\d<>=^~≥≤])/i, '').replace(/[）)]$/, '');
                const range = (explicit.test(clause) || requiredAs.test(clause)) && /^[v\d<>=^~≥≤]/i.test(tail) ? tail.split('、')[0].trim() : '';
                const version = range?.replace(/≥/g, '>=').replace(/≤/g, '<=')
                    .replace(/v?(\d+(?:\.\d+)*)\s*(?:及以上|以上|或更高)/gi, '>=$1')
                    .replace(/\s*(?:且|并且|\band\b|[，,](?=\s*[<>=^~]))\s*/gi, ' && ')
                    .replace(/\s*(?:或|\bor\b)\s*/gi, ' || ').replace(/(^|[\s<>=^~|&])v(?=\d)/gi, '$1')
                    .replace(/([<>=^~])\s+(?=\d)/g, '$1').trim();
                result.push({ modName: entry.modName, version: version || '*',
                    source: '简介声明', evidence: clause });
            }
        }
        return [...new Map(result.map(item => [item.modName.toLowerCase() + '\n' + item.version, item])).values()];
    }

    function getRequiredDependencies(mod, catalog = marketModList) {
        const declared = window.modHubMarketVariants?.normalizeRequiredDependencies(mod?.requiredDependencies) || [];
        const result = new Map();
        for (const item of [...inferRequiredDependencies(mod, catalog), ...declared]) {
            const key = item.modName.toLowerCase() + '\n' + item.version;
            result.set(key, { ...result.get(key), ...item });
        }
        return [...result.values()];
    }

    function getCatalogRequiredDependencies(boot) {
        if (typeof boot?.name !== 'string') return [];
        const catalog = marketDataLoaded || marketModList.length ? marketModList : readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true) || [];
        if (!Array.isArray(catalog)) return [];
        const matches = catalog.filter(mod => !isWithdrawn(mod) && !isDelistedMarketMod(mod)
            && Array.isArray(mod.bootNames) && mod.bootNames.includes(boot.name));
        if (matches.length !== 1) return [];
        return getRequiredDependencies(matches[0], catalog);
    }

    function selectDependencyProvider(profiles, modName, allowDisabled = false) {
        const key = value => String(value || '');
        const candidates = profiles.filter(profile => {
            const boot = profile.bootJson || profile;
            return [boot.name, ...(Array.isArray(boot.alias) ? boot.alias : [])].some(name => key(name) === key(modName));
        });
        const state = window._modHubModState;
        const knownOrder = Array.isArray(state?.sideEnabled) && Array.isArray(state?.builtInMods);
        const knownNames = Array.isArray(state?.sideEnabled) || Array.isArray(state?.builtInMods);
        const order = [...(state?.builtInMods || []), ...(state?.sideEnabled || [])].map(key);
        const active = candidates.filter(profile => !modHubComponentDisabled(profile.name) && (!knownNames || order.includes(key(profile.name))));
        if (!active.length) return allowDisabled && candidates.length === 1
            && (!knownNames || modHubComponentDisabled(candidates[0].name)) ? candidates[0] : null;
        if (active.length === 1) return active[0];
        if (!knownOrder) return null;
        if (active.some(profile => !order.includes(key(profile.name))) || new Set(active.map(profile => key(profile.name))).size !== active.length) return null;
        return active.reduce((previous, profile) => order.lastIndexOf(key(profile.name)) > order.lastIndexOf(key(previous.name)) ? profile : previous);
    }

    function getModDependencies(mod, catalog = marketModList) {
        const required = getRequiredDependencies(mod, catalog).sort((left, right) => Number(left.version === '*') - Number(right.version === '*'))
            .map(item => ({ id: MODHUB_BOOT_IDENTITIES.get(item.modName.toLowerCase())?.id
                || (item.modName === 'Simple Frameworks' ? 'simple-framework' : item.modName), bootName: item.modName, version: item.version, required: true }));
        if (Array.isArray(mod?._modHubResolvedDependencies)) return normalizeDependencyList([...required, ...mod._modHubResolvedDependencies]);
        const auIdentity = extractRepoKey(mod?.githubUrl) === 'aokiutage/utagesdol3.0'
            ? AU_MARKET_IDENTITIES.find(identity => normalizeKey(identity.name) === normalizeKey(cleanModTitle(mod?.name))) : null;
        const dependencies = normalizeDependencyList([...required.filter(item => item.version !== '*'), ...(auIdentity?.dependencies || []),
            ...(mod?.dependencies || []), ...required.filter(item => item.version === '*')]);
        return dependencies;
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
        const englishEvidenceAvailable = !/\bopening (?:message|post)\b.{0,50}\b(?:unavailable|no longer available)\b/i.test(descText);
        const englishTagText = text.replace(/\b(?:do not|does not|without|not)\s+(?:occupy(?:ing)?|using)\s+(?:any\s+)?clothing\s+slots?\b/gi, '');
        const inferredTags = TAG_RULES.filter(([tag, pattern, englishPattern]) => pattern.test(text)
          || (englishEvidenceAvailable && (tag !== '图像' || !/\brather than (?:the|an?) art pack\b/i.test(descText))
            && englishPattern?.test(tag === '图像' ? descText : englishTagText))).map(([tag]) => tag);
        // 英文界面集合可能覆盖多个领域，保留主功能标签，避免被三项上限挤掉。
        if (inferredTags.length > 3 && /\b(?:ui|gui|interface|sidebar)\b/i.test(englishTagText) && inferredTags.includes('界面')) {
          inferredTags.splice(inferredTags.indexOf('界面'), 1);
          inferredTags.unshift('界面');
        }
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

    function parseModsFromHtml(html, catalog = readLocalCache(IDENTITY_CACHE_KEY, WIKI_CACHE_TTL, true)) {
        if (!globalThis.modHubWikiTitle?.fromDom) throw new Error('Wiki 标题解析模块未加载');
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
                const title = globalThis.modHubWikiTitle.fromDom(nameCell, { identities: getWikiTitleIdentities(catalog) });
                if (title.status !== 'resolved') {
                    console.warn(`[ModHub] 跳过无法确定标题的 Wiki 条目（${title.status}）`, title.legacyName);
                    continue;
                }
                const projects = title.projects.length > 1 ? title.projects : [null];
                for (const project of projects) {
                const name = project ? project.name : title.name;
                if (!name) continue;

                const description = cleanText(tds[idx.description] ? tds[idx.description].textContent : '');
                const author = idx.author >= 0 && tds[idx.author] ? cleanText(tds[idx.author].textContent) : '';
                const dateText = idx.date >= 0 && tds[idx.date] ? cleanText(tds[idx.date].textContent) : '';
                const { date, version } = parseDateCell(dateText);

                const parsedGithubUrls = project ? [project.href] : extractGithubUrls(nameCell);
                const wikiSources = globalThis.modHubWikiTitle.normalizeSources({ name, titleStatus: title.status, author,
                    githubUrl: parsedGithubUrls[0] || null, githubUrls: parsedGithubUrls });
                const githubUrls = wikiSources.githubUrls;
                const githubUrl = wikiSources.githubUrl;
                const otherUrls = extractOtherUrls(nameCell);
                const otherUrl = otherUrls[0] || null;

                const classification = deriveClassification(name, description);
                const repoKey = extractRepoKey(githubUrl);
                const isDead = Boolean(isDeadRepo(repoKey) || isDeadRepo(githubUrl));

                mods.push({
                    name,
                    wikiName: name,
                    wikiLegacyName: project ? (project.legacyName || project.name) : title.legacyName,
                    titleStatus: title.status,
                    wikiAuthor: author,
                    ...(wikiSources.wikiSourceCorrections ? { wikiSourceCorrections: wikiSources.wikiSourceCorrections } : {}),
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
        return markSharedRepositories(mods).filter(isMarketSourceVisible).map(mod => ({ ...mod,
            packageLanguages: getPackageLanguages(mod, registeredIdentityMetadata.get(mod.identityId)) }));
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
        const legacyPhone = withoutGame.match(/^SmartPhone(?:[._-]PhotoPack)?[._-]v?Alpha[._-](3\.\d+(?:\.\d+)*)/i)?.[1];
        if (legacyPhone) return [0, ...legacyPhone.split('.').map(Number)];
        const explicit = [...withoutGame.matchAll(/(?:^|[\s_.-])v(\d+(?:\.\d+)+)/ig)].pop()?.[1];
        return (explicit || withoutGame.match(/\d+(?:\.\d+)+/)?.[0] || '').split('.').filter(Boolean).map(Number);
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
        const editions = window.modHubMarketVariants?.normalizePackageEditions(mod?.packageEditions) || [];
        const edition = editions.find(item => getAssetSeries(item.assetSeries) === getAssetSeries(asset.name));
        if (edition) return !mod._selectedPackageEdition || mod._selectedPackageEdition === edition.id;
        if (editions.length) return false;
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
        const scoped = Boolean(mod?.sharedRepository || mod?.releaseTrackingSourceUrl);
        const names = scoped ? [...(mod.bootNames || [])] : [...(mod?.bootNames || []), ...(mod?.aliases || []), ...(mod?.repositories || []), mod?.name];
        if (scoped) for (const record of [...(mod.verifiedReleaseAssets || []), ...(mod.verifiedReleaseAsset ? [mod.verifiedReleaseAsset] : [])]) {
            if (!(mod.bootNames || []).includes(record.bootName) || !/^[a-f0-9]{64}$/i.test(record.sha256 || '')) continue;
            try {
                const url = new URL(record.sourceUrl), fileName = decodeURIComponent(url.pathname.split('/').pop());
                if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash
                    || !/\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) || record.fileName && record.fileName !== fileName
                    || parseGithubRepo(url.href)?.key !== parseGithubRepo(mod.githubUrl)?.key) continue;
                names.push(fileName);
            } catch (_) { /* 无法核对来源的登记不扩大安装身份。 */ }
        }
        return names.some(name => {
            const identity = getAssetSeries(name);
            return identity.length >= 3 && identity === series;
        });
    }

    function getMatchingCompanionAssets(main, assets, mod = null) {
        const mainSeries = getAssetSeries(main.name);
        const mainVersion = getAssetVersionParts(main.name).join('.');
        const optional = new Set(getMatchingOptionalAssets(main, assets, mod).map(asset => asset.downloadUrl));
        return assets.filter(asset => asset.downloadUrl !== main.downloadUrl
            && !optional.has(asset.downloadUrl)
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
    function getMatchingOptionalAssets(main, assets, mod = null) {
        if (!main) return [];
        const declarations = window.modHubMarketVariants?.normalizeOptionalResources(mod?.optionalResources) || [];
        const declaredAssets = mod && matchesAssetIdentity(main, mod) ? declarations.flatMap(item => {
            let found = item.sourceUrl ? (assets || []).find(asset => asset.downloadUrl === item.sourceUrl)
                : (assets || []).find(asset => getAssetSeries(asset.name) === getAssetSeries(item.assetSeries)
                    && (item.packageRole !== 'audio' || getAssetVersionParts(asset.name).join('.') === getAssetVersionParts(main.name).join('.')
                        && getAssetGameVersion(asset.name) === getAssetGameVersion(main.name)));
            if (item.sourceUrl && !found) {
                try {
                    const source = new URL(item.sourceUrl), owner = parseGithubRepo(mod.githubUrl);
                    if (parseGithubRepo(item.sourceUrl)?.key !== owner?.key) return [];
                    found = { name: decodeURIComponent(source.pathname.split('/').pop()), downloadUrl: source.href, size: item.size || 0 };
                } catch (_) { return []; }
            }
            if (!found || found.downloadUrl === main.downloadUrl) return [];
            return [{ ...found, bootName: item.bootName, label: item.label, version: item.sourceUrl && item.version || found.version || getAssetVersionParts(found.name).join('.') || item.version || '',
                packageRole: item.packageRole, optional: true, ...(item.sha256 ? { digest: `sha256:${item.sha256}` } : {}) }];
        }) : [];
        if (declaredAssets.length) return declaredAssets;
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

        const optionalUrls = new Set(downloadable.flatMap(asset => getMatchingOptionalAssets(asset, downloadable, mod)).map(asset => asset.downloadUrl));
        const mainAssets = downloadable.filter(asset => !optionalUrls.has(asset.downloadUrl));
        const identified = mod ? mainAssets.filter(asset => matchesAssetIdentity(asset, mod)) : [];
        if (mod?._selectedPackageEdition && !identified.length) return { assets: [], candidates: [], availableAssets: downloadable,
            needsChoice: false, reason: '本次发布没有所选包型的安装包' };
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
        return { assets: [selectedMain, ...getMatchingCompanionAssets(selectedMain, downloadable, mod)],
            candidates: mainCandidates, availableAssets: downloadable, needsChoice: false, reason: '' };
    }

    function historicalReleaseMetadata(release) {
        return { tag_name: release.tagName, name: release.name, html_url: release.htmlUrl,
            published_at: release.publishedAt, draft: release.draft, prerelease: release.prerelease,
            version: release.version, versionSource: release.versionSource,
            assets: release.assets.map(asset => ({ ...asset, browser_download_url: asset.downloadUrl })) };
    }

    async function fetchModRelease(mod, options = {}) {
        const { useCache = true, signal } = options;
        if (!mod || !mod.githubUrl) throw new Error('模组缺少 GitHub 仓库链接');
        let repo = parseGithubRepo(mod.githubUrl);
        if (!repo) throw new Error('无法解析 GitHub 仓库地址');
        if (repo.sourcePath) {
            const err = new Error('此条目指向仓库内的文件或分支，请前往模组主页按作者说明下载安装');
            err.code = 'MANUAL_SOURCE';
            throw err;
        }
        if (isWithdrawn(mod) || mod.autoInstall === false || mod.catalogSource === 'community' && !hasCommunityReleaseSource(mod)) {
            const error = new Error(isWithdrawn(mod) ? '该模组来源已撤回，请刷新市场' : '该模组未获准自动安装，请前往作者主页');
            error.code = isWithdrawn(mod) ? 'MOD_RELEASES_UNAVAILABLE' : 'MANUAL_SOURCE';
            throw error;
        }
        // 精确摘要查询仍以目录原始来源核验，不能临时替换来源绕过历史接口。
        if (options.releaseTag) repo = { ...repo, releaseTag: options.releaseTag,
            assetName: options.releaseTag === repo.releaseTag ? repo.assetName : '' };
        const sharedRepository = !repo.releaseTag && (mod.sharedRepository || (marketModList || [])
            .filter(item => parseGithubRepo(item.githubUrl)?.key === repo.key).length > 1);

        // 同仓库的主包和扩展可能分属固定标签，不能共用 latest 或旧缓存。
        const entryKey = mod.id || mod.identityId || mod.name || '';
        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}${repo.releaseTag ? `_tag_${encodeURIComponent(repo.releaseTag)}` : ''}${repo.assetName ? `_asset_${encodeURIComponent(repo.assetName)}` : ''}${sharedRepository ? `_entry_${encodeURIComponent(entryKey)}` : ''}`;
        const gameVersion = window.StartConfig?.version || '';
        const platform = (typeof window.modHubIsMobile === 'function' ? window.modHubIsMobile() : window.modHubIsMobile) ? 'mobile' : 'desktop';
        const source = JSON.stringify([repo.key, repo.releaseTag, repo.assetName, getModUpdateSignature(mod, gameVersion)]);
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

        let releaseData = null, catalogStale = false;
        try {
            if (mod.id && window.modHubMarketVersions?.fetchReleases) {
                let history, selected;
                const releases = [];
                do {
                    history = await window.modHubMarketVersions.fetchReleases(mod, {
                        page: history ? history.page + 1 : 1, useCache, signal
                    });
                    catalogStale ||= Boolean(history.stale);
                    releases.push(...history.releases.map(historicalReleaseMetadata));
                    selected = releases.find(release => repo.releaseTag ? release.tag_name === repo.releaseTag
                        : !sharedRepository || release.assets.some(asset => matchesAssetIdentity(asset, mod)));
                } while (!selected && history.hasMore);
                if (!selected) {
                    const error = new Error(repo.releaseTag ? `指定发布标签未出现在当前目录历史中：${repo.releaseTag}`
                        : '当前目录历史中未找到该模组的安装包，请核对作者发布');
                    error.code = repo.releaseTag ? 'RELEASE_NOT_FOUND' : 'MANUAL_SOURCE';
                    throw error;
                }
                releaseData = sharedRepository ? releases : selected;
            } else {
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
            if (['REPO_NOT_FOUND', 'RELEASE_NOT_FOUND', 'MANUAL_SOURCE'].includes(fetchErr?.code) || fetchErr?.status === 404 || fetchErr?.name === 'AbortError'
                || window.modHubMarketVersions?.isUnsafeHistoryError?.(fetchErr)) {
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
            digest: a.digest || '',
            ...(a.versionSource === 'verified-boot' ? { bootName: a.bootName, version: a.version, versionSource: a.versionSource } : {})
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
                    prerelease: releaseData.prerelease, version: releaseData.version, versionSource: releaseData.versionSource, assets }]
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

        if (catalogStale) result.isStale = true;

        if (useCache && !catalogStale) {
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

        let releases, catalogStale = false;
        if (mod.id && window.modHubMarketVersions?.fetchReleases) {
            const history = await window.modHubMarketVersions.fetchReleases(mod, { page: 1,
                useCache: options.useCache !== false, signal: options.signal });
            catalogStale = Boolean(history.stale);
            releases = history.releases.map(historicalReleaseMetadata);
        } else {
            const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=20`, {
                headers: { Accept: 'application/vnd.github+json' },
                signal: options.signal
            });
            if (response.status === 429 || response.status === 403) throw new Error('GitHub API 触发速率限制');
            if (!response.ok) throw new Error(`GitHub 访问异常: ${response.status}`);
            releases = await response.json();
        }
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
        if (!catalogStale) writeLocalCache(cacheKey, companions);
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

    function formatAssetSize(size, detailed = false) {
        const bytes = Number(size) || 0;
        if (!bytes) return detailed ? '0 B' : '大小未知';
        if (detailed && bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${detailed ? (bytes / 1024).toFixed(2) : Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / 1024 / 1024).toFixed(detailed ? 2 : 1)} MB`;
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
            return `<div class="modhub-install-file"><span class="modhub-install-label">${role}</span><span class="modhub-install-name ${color}" data-modhub-i18n-ignore>${escape(asset.name)}</span><span class="modhub-install-size">${escape(formatAssetSize(asset.size))}</span></div>`;
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
                    <div><dt>下载线路</dt><dd class="${selectedMirror?.browserOnly ? '' : 'green'}">${escape(modHubT(selectedMirror?.name || '默认加速'))}</dd></div>
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
                            <span class="modhub-dep-name" data-modhub-i18n-ignore>${escape(req.mod.name)}</span>
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
                        <span class="modhub-dep-name" data-modhub-i18n-ignore>${escape(req.mod.name)}</span>
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

    function getDownloadUrl(url, mirrorId, workerBackup = false) {
        const mirror = resolveMirrorServer(mirrorId);
        const targetUrl = getAcceleratedUrl(url, mirrorId);
        if (!targetUrl || !mirror.useWorker) return targetUrl;
        const proxyUrl = new URL('/download', workerBackup ? BACKUP_RELEASE_INDEX_URL : RELEASE_WORKER_API_BASE);
        proxyUrl.searchParams.set('url', targetUrl);
        return proxyUrl.toString();
    }

    function getOfficialGithubAssetSource(mod, release, asset) {
        try {
            if (!/^https:\/\/github\.com\//i.test(asset.downloadUrl)) return null;
            const url = new URL(asset.downloadUrl);
            if (url.origin !== 'https://github.com' || url.username || url.password || url.port || url.search || url.hash) return null;
            const parts = url.pathname.split('/').slice(1);
            if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download'
                || !parts.slice(0, 2).every(part => /^[a-z0-9_.-]+$/i.test(part)) || !parts[4] || !parts[5]) return null;
            const key = `${parts[0]}/${parts[1]}`.toLowerCase();
            const repositories = new Set((mod.repositoryKeys || []).filter(key => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(key))
                .map(key => key.toLowerCase()));
            for (const value of [mod.githubUrl, ...(mod.githubUrls || [])]) {
                if (!/^https:\/\/github\.com\//i.test(value || '')) continue;
                const source = new URL(value);
                if (source.origin !== 'https://github.com' || source.username || source.password || source.port) continue;
                const pair = source.pathname.split('/').slice(1, 3);
                if (pair.length === 2 && pair.every(part => /^[a-z0-9_.-]+$/i.test(part))) repositories.add(pair.join('/').replace(/\.git$/i, '').toLowerCase());
            }
            if (!repositories.has(key) || release.tagName && decodeURIComponent(parts[4]) !== release.tagName
                || asset.name && decodeURIComponent(parts[5]) !== asset.name) return null;
            return asset.downloadUrl;
        } catch (_) { return null; }
    }

    function isOfficialDownloadRoute(fetchUrl, sourceUrl) {
        if (fetchUrl === sourceUrl) return true;
        try {
            const url = new URL(fetchUrl);
            return [RELEASE_WORKER_API_BASE, BACKUP_RELEASE_INDEX_URL].some(base => url.origin === new URL(base).origin)
                && !url.username && !url.password && !url.port && !url.hash && url.pathname === '/download'
                && [...url.searchParams.keys()].length === 1 && url.searchParams.get('url') === sourceUrl;
        } catch (_) { return false; }
    }

    async function readWorkerDownloadFailure(response, signal) {
        let text = '';
        try {
            // 仅按实际流读取最多 4 KiB；不可读取的错误响应保持普通网络错误。
            if (response.body?.getReader) text = await (await readDownloadResponse(response, () => {}, 4096, 0, signal)).text();
        } catch (error) {
            if (signal?.aborted) throw error;
        } finally { try { await response.body?.cancel?.(); } catch (_) {} }
        let data;
        try { data = JSON.parse(text); } catch (_) {}
        const reason = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : text.trim();
        const legacy = { '该仓库不在模组市场中': 'DOWNLOAD_NOT_AUTHORIZED', '当前模组目录暂时无法核验，请稍后重试': 'CATALOG_UNAVAILABLE' };
        const code = ['DOWNLOAD_NOT_AUTHORIZED', 'CATALOG_UNAVAILABLE'].includes(data?.code) ? data.code : legacy[reason];
        return code ? Object.assign(new Error(reason || (code === 'DOWNLOAD_NOT_AUTHORIZED'
            ? '该仓库不在模组市场中' : '当前模组目录暂时无法核验，请稍后重试')), { code, status: response.status }) : null;
    }

    function setCurrentMirror(mirrorId, notify = true) {
        const mirror = resolveMirrorServer(mirrorId, false);
        if (!mirror) return false;
        currentMirrorId = mirror.id;
        hasExplicitMirrorPreference = true;
        try { localStorage.setItem(MODHUB_MIRROR_STORAGE_KEY, mirror.id); }
        catch (error) {
            if (notify) window.modHubShowToast?.(modHubT('本次会话已切换下载线路，但无法保存偏好。错误详情：{error}',
                { error: error.message || String(error) }), 'warning');
        }
        syncMirrorControls();
        renderMarketCards();
        if (notify) window.modHubShowToast(modHubT('已切换下载线路: {name}', { name: modHubT(mirror.name) }), 'info');
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
    const MODHUB_DELISTED_MARKET_IDS = new Set([
        'woven-realm', 'woven-realm-cooking', '织境空间场景互动扩展-wovenrealmui', 'dol-mod-center'
    ]);

    function isDelistedMarketMod(mod) {
        // 固定下架记录覆盖旧缓存；临时网络错误和没有发布均不属于下架依据。
        return MODHUB_DELISTED_MARKET_IDS.has(String(mod?.identityId || mod?.id || '').toLowerCase())
            || [mod?.githubUrl, mod?.sourceUrl, mod?.repo].some(source =>
                KNOWN_DEAD_REPOSITORIES.has(extractRepoKey(source) || String(source || '').toLowerCase()));
    }
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
                    ...(identity.packageLanguages !== undefined ? { packageLanguages: window.modHubMarketVariants?.normalizePackageLanguages(identity.packageLanguages) || [] } : {}),
                    requiredDependencies: window.modHubMarketVariants?.normalizeRequiredDependencies(identity.requiredDependencies) || [],
                    verifiedReleaseAssets: Array.isArray(identity.verifiedReleaseAssets) ? identity.verifiedReleaseAssets : [],
                    packageEditions: window.modHubMarketVariants?.normalizePackageEditions(identity.packageEditions) || [],
                    optionalResources: window.modHubMarketVariants?.normalizeOptionalResources(identity.optionalResources) || [],
                    releaseTrackingSourceUrl: safeHttpsUrl(identity.releaseTrackingSourceUrl)
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

    function getWikiTitleIdentities(catalog) {
        const entries = Array.isArray(catalog) ? catalog : catalog?.mods;
        const identities = (Array.isArray(entries) ? entries : [])
            .filter(identity => identity && typeof identity === 'object' && identity.identityId !== null);
        return [...identities, ...[...MODHUB_OFFLINE_WIKI_IDENTITIES, ...AU_MARKET_IDENTITIES, ...MODHUB_VERIFIED_MARKET_IDENTITIES]
            .filter(identity => !identities.some(registered => registered.id === identity.id))].filter(identity => !isWithdrawn(identity));
    }

    function normalizeWikiTitles(mods, catalog = readLocalCache(IDENTITY_CACHE_KEY, WIKI_CACHE_TTL, true)) {
        const identities = getWikiTitleIdentities(catalog);
        return mods.flatMap(mod => {
            if (!mod || typeof mod !== 'object') return [];
            if (mod.catalogSource === 'community' || mod.contentType === 'spell') return [mod];
            const name = cleanText(mod.name || mod.wikiName);
            const titleSources = mod.wikiGithubUrls?.length ? mod.wikiGithubUrls : [mod.wikiGithubUrl || mod.githubUrl];
            if (name === cleanText(mod.wikiName || name) && globalThis.modHubWikiTitle.isStatusName(name, titleSources)) {
                const candidate = globalThis.modHubWikiTitle.normalizeStatusTitle(mod.wikiCandidateName, titleSources);
                if (candidate) return [{ ...mod, name: candidate }];
            }
            if (name && !globalThis.modHubWikiTitle.isUtilityName(name)) {
                if (mod.titleStatus !== 'ambiguous' && mod.titleStatus !== 'missing') return [mod];
                const repoKey = extractRepoKey(mod.githubUrl);
                const registeredName = mod.name && repoKey && identities.some(identity => (Array.isArray(identity.repositoryKeys) ? identity.repositoryKeys : [])
                    .some(key => typeof key === 'string' && key.toLowerCase() === repoKey)
                    && [identity.name, ...(Array.isArray(identity.aliases) ? identity.aliases : []),
                        ...(Array.isArray(identity.bootNames) ? identity.bootNames : [])]
                        .some(value => typeof value === 'string' && normalizeKey(value) === normalizeKey(name)));
                // 只保留已有且同源登记的名称，不按仓库或条目 ID 生成标题或安装身份。
                if (registeredName) return [mod];
            }
            // 旧快照只允许采用已经保留的 Wiki 标题，不从仓库或旧链接标签猜名称。
            const wikiName = cleanText(mod.wikiName);
            return wikiName && !globalThis.modHubWikiTitle.isUtilityName(wikiName)
                ? [{ ...mod, name: wikiName, titleStatus: 'resolved' }] : [];
        });
    }

    function getPackageLanguages(mod, identity) {
        const declared = identity?.packageLanguages !== undefined ? identity.packageLanguages : mod.packageLanguages;
        const identityId = mod.identityId === undefined ? (mod.catalogSource === 'community' ? null : mod.id) : mod.identityId;
        let bundled = declared === undefined && typeof identityId === 'string' ? MODHUB_VERIFIED_PACKAGE_LANGUAGES[identityId] : undefined;
        if (declared === undefined && bundled === undefined) {
            // 来源证据仅补充语言显示，不补全安装身份。
            bundled = MODHUB_VERIFIED_SOURCE_PACKAGE_LANGUAGES.find(record => record.name === mod.name
                && record.sourceUrl === (mod.githubUrl || mod.sourceUrl))?.packageLanguages;
        }
        if (declared === undefined && bundled === undefined) return undefined;
        return window.modHubMarketVariants?.normalizePackageLanguages(declared === undefined ? bundled : declared) || [];
    }

    /** 将 Cloudflare 统一索引转换为模组市场既有数据结构 */
    function normalizeReleaseIndex(index) {
        if (index?.schemaVersion !== 1 || !Array.isArray(index.mods)) {
            throw new Error('自动版本索引格式异常');
        }
        rememberWithdrawals(index);
        const titleMods = normalizeWikiTitles(index.mods, index.identities);
        const activeMods = titleMods.filter(mod => mod.contentType !== 'spell' && mod.status !== 'withdrawn' && !isWithdrawn(mod));
        const unlinkedLanguageMods = new Set(activeMods.filter(mod => mod.identityId === null));

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

        let visibleMods = activeMods.filter(isMarketSourceVisible);
        // 完整登记条目存在时，移除同一官方仓库遗留的重复 Wiki 条目。
        if (visibleMods.some(mod => mod.id === 'fertility-expansion' && mod.identityId === 'fertility-expansion'
            && mod.catalogSource === 'community' && extractRepoKey(mod.githubUrl) === 'liliths-legacy/dol-fertilityexpansion-mod')) {
            visibleMods = visibleMods.filter(mod => !(mod.id === '生育拓展fertilityexpansion-dol-fertilityexpansion-mod'
                && mod.catalogSource !== 'community' && (!mod.identityId || mod.identityId === 'fertility-expansion')
                && extractRepoKey(mod.githubUrl) === 'liliths-legacy/dol-fertilityexpansion-mod'));
        }
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

        applyIdentityCatalog(titleMods.filter(mod => mod.contentType !== 'spell'), false);
        applyIdentityCatalog(index.identities, false);
        applyIdentityCatalog(visibleMods.filter(mod => mod.catalogSource !== 'community' || mod.identityId), false);
        const identities = Array.isArray(index.identities) ? index.identities : index.identities?.mods || [];
        return markSharedRepositories(visibleMods).map((mod, position) => {
            const matching = mod.identityId ? identities.filter(identity => identity.id === mod.identityId) : [];
            const registered = mod.identityId ? registeredIdentityMetadata.get(mod.identityId) : null;
            const identity = registered ? { ...(matching.length === 1 ? matching[0] : {}), ...registered }
                : matching.length === 1 ? matching[0] : null;
            const registeredVariant = window.modHubMarketVariants?.normalizeVariant(identity?.variant);
            const languageMod = unlinkedLanguageMods.has(visibleMods[position]) ? { ...mod, identityId: null } : mod;
            mod = { ...mod, variant: registeredVariant || (mod.variant === undefined ? null : mod.variant),
                packageLanguages: getPackageLanguages(languageMod, languageMod.identityId === null ? null : identity),
                packageEditions: window.modHubMarketVariants?.normalizePackageEditions(identity?.packageEditions || mod.packageEditions) || [],
                optionalResources: window.modHubMarketVariants?.normalizeOptionalResources(identity?.optionalResources || mod.optionalResources) || [],
                releaseTrackingSourceUrl: identity?.releaseTrackingSourceUrl || mod.releaseTrackingSourceUrl || '',
                verifiedReleaseAssets: Array.isArray(identity?.verifiedReleaseAssets) ? identity.verifiedReleaseAssets
                    : Array.isArray(mod.verifiedReleaseAssets) ? mod.verifiedReleaseAssets : [],
                requiredDependencies: window.modHubMarketVariants?.normalizeRequiredDependencies([
                    ...(Array.isArray(identity?.requiredDependencies) ? identity.requiredDependencies : []),
                    ...(Array.isArray(mod.requiredDependencies) ? mod.requiredDependencies : [])]) || mod.requiredDependencies || [] };
            const isCommunity = mod.catalogSource === 'community';
            const sourceUrl = safeHttpsUrl(mod.sourceUrl);
            const otherUrl = safeHttpsUrl(mod.otherUrl) || (isCommunity ? sourceUrl : null);
            const tracking = parseGithubRepo(mod.releaseTrackingSourceUrl);
            const originalTarget = parseGithubRepo(mod.githubUrl);
            const approvedKeys = (identity?.repositoryKeys || []).map(key => String(key).toLowerCase());
            const trackingAllowed = identity?.releaseTrackingSourceUrl === mod.releaseTrackingSourceUrl && tracking
                && !tracking.releaseTag && !tracking.sourcePath && originalTarget && originalTarget.owner.toLowerCase() === tracking.owner.toLowerCase()
                && approvedKeys.includes(originalTarget.key) && approvedKeys.includes(tracking.key);
            const githubUrl = safeHttpsUrl(trackingAllowed ? mod.releaseTrackingSourceUrl : mod.githubUrl);
            const autoInstall = mod.autoInstall !== false && (!isCommunity || hasCommunityReleaseSource(mod));
            mod = {
                ...mod,
                sourceUrl,
                otherUrl,
                autoInstall: Boolean(autoInstall),
                githubUrl: githubUrl && autoInstall ? githubUrl : null
            };
            const target = parseGithubRepo(mod.githubUrl);
            const indexedRelease = parseGithubRepo(mod.releaseUrl);
            const scopedRelease = mod.releaseProductScoped === true && mod.bootNames?.length && indexedRelease?.key === target?.key && indexedRelease?.releaseTag;
            if (target?.sourcePath || (mod.sharedRepository && !target?.releaseTag && !scopedRelease && mod.variant?.type !== 'language') ||
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
                catalogLanguages: normalizeCatalogLanguages(mod.catalogLanguages),
                releaseStatus: ['development', 'preview', 'released', 'unknown'].includes(mod.releaseStatus) ? mod.releaseStatus : 'unknown',
                isLanguageGroup: false,
                variants: undefined,
                sources: window.modHubMarketSpells?.normalizeSources(mod) || [],
                packageRecords: window.modHubMarketSpells?.normalizePackages(mod) || [],
                _isDeadRepo: isDead,
                name: window.modHubMarketVariants?.getDisplayName({ name: (isCommunity || mod.titleStatus === 'resolved' ? cleanText(mod.name || mod.wikiName) : cleanModTitle(mod.name || mod.wikiName)) || mod.wikiName || '未命名模组', variant: mod.variant })
                    || (isCommunity || mod.titleStatus === 'resolved' ? cleanText(mod.name || mod.wikiName) : cleanModTitle(mod.name || mod.wikiName)) || mod.wikiName || '未命名模组',
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
                dependencies: getModDependencies(mod, visibleMods)
            };
        });
    }

    async function fetchMarketJson(url, source, signal) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timeoutId;
        let cancel;
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
                }),
                new Promise((_, reject) => {
                    cancel = () => {
                        controller?.abort();
                        reject(new Error(`${source}请求已取消`));
                    };
                    if (signal?.aborted) cancel();
                    else signal?.addEventListener('abort', cancel, { once: true });
                })
            ]);
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', cancel);
        }
    }

    function fetchReleaseIndex() {
        return new Promise((resolve, reject) => {
            let settled = false, started = 0, failed = 0, backupTimer;
            const controllers = [];
            const finish = () => {
                settled = true;
                clearTimeout(backupTimer);
                controllers.forEach(controller => controller?.abort());
            };
            const start = () => {
                if (settled || started >= RELEASE_INDEX_MIRRORS.length) return;
                const url = RELEASE_INDEX_MIRRORS[started++];
                const controller = typeof AbortController === 'function' ? new AbortController() : null;
                controllers.push(controller);
                fetchMarketJson(url, '自动版本索引', controller?.signal).then(index => {
                    if (settled) return;
                    const mods = normalizeReleaseIndex(index);
                    window.modHubMarketSpells?.applyIndex(index, withdrawnRevision);
                    activeReleaseWorkerBaseUrl = url;
                    writeLocalCache(WIKI_CACHE_KEY, mods);
                    finish();
                    resolve(mods);
                }).catch(error => {
                    if (settled) return;
                    failed++;
                    console.warn(`[ModHub] 自动版本索引镜像不可用 (${url})，尝试下一镜像或回退`, error);
                    if (failed === RELEASE_INDEX_MIRRORS.length) {
                        finish();
                        reject(error);
                    } else start();
                });
            };
            start();
            backupTimer = setTimeout(start, 350);
        });
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
        return JSON.stringify([gameVersion, window.modHubMarketVersions?.getGameIdentity?.(), RELEASE_WORKER_API_BASE, mod.id, mod.githubUrl, mod.version,
            mod.releaseUrl, mod.catalogSource, mod.autoInstall, mod.autoInstallScope, mod.revision, withdrawnRevision,
            mod.identityId, mod.name, mod.sourceUrl, mod.repositoryKeys, mod.bootNames, mod.aliases,
            mod.sharedRepository, mod.releaseCompatibility, mod.dependencies, getRequiredDependencies(mod), mod.variant, mod.verifiedReleaseAssets, mod.verifiedReleaseAsset, mod._identityMetadataUnavailable,
            mod.packageEditions, mod.optionalResources, mod.releaseTrackingSourceUrl, mod.releaseProductScoped, mod._selectedPackageEdition,
            mod.packageEditions?.length ? [mod._matchedLocal?.name || '', mod._matchedLocal?.bootJson?.edition || mod._matchedLocal?.edition || '', mod._matchedLocal?.packageDigest || ''] : null,
            (mod.identityId || mod.id) === 'au-beautification' ? mod._matchedLocal?.name || '' : '', marketHistoryRefresh]);
    }

    function getReleaseHistoryContext(mod) {
        const signature = getModUpdateSignature(mod, window.modHubMarketVersions?.getGameVersion?.());
        const checked = modUpdateChecks.get(signature);
        return { signature, refresh: marketHistoryRefresh,
            useCache: marketHistoryRefresh === 0 || Boolean(checked && !checked.pending && !checked.error) };
    }

    function queueMarketUpdateRender() {
        if (typeof window.requestAnimationFrame !== 'function') { renderMarketCards(); return; }
        marketUpdateRenderRevision = marketViewRevision;
        if (marketUpdateFrame !== null) return;
        marketUpdateFrame = window.requestAnimationFrame(() => {
            marketUpdateFrame = null;
            if (marketUpdateRenderRevision === marketViewRevision) renderMarketCards();
        });
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

    // 后台与面板共用两个检查槽位，避免已安装模组同时展开全部历史分页。
    function queueModUpdateCheck(operation) {
        return new Promise((resolve, reject) => {
            modUpdateQueue.push({ operation, resolve, reject });
            drainModUpdateQueue();
        });
    }

    function drainModUpdateQueue() {
        while (modUpdateActive < 2 && modUpdateQueue.length) {
            const task = modUpdateQueue.shift();
            modUpdateActive++;
            Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => {
                modUpdateActive--;
                drainModUpdateQueue();
            });
        }
    }

    function modUpdateBlocked() {
        return document.hidden || window.modHubIsReloadBusy?.()
            || window.modHubRestore?.isRestoring?.() || window.modHubRestore?.isOperationBlocked?.();
    }

    async function waitForModUpdateIdle(current) {
        while (current() && modUpdateBlocked()) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 每次重新进入面板只重试一次失败项，结果通知不能反复重排同一个失败请求。
    function retryFailedModUpdateChecks(root) {
        if (!root || modUpdateRetryRoots.has(root)) return;
        modUpdateRetryRoots.add(root);
        for (const [signature, state] of modUpdateChecks) {
            if (!state.pending && state.error) modUpdateChecks.delete(signature);
        }
    }

    /** 更新状态复用历史包体身份与版号，适配推荐和未知适配新版分别处理。 */
    function getModUpdateInfo(mod, profiles) {
        resolveDisplayedInstallMod(mod, profiles);
        const versions = window.modHubMarketVersions;
        const gameVersion = versions?.getGameVersion?.();
        if (!mod?.id || !versions?.getLatestGameCandidate) return { version: mod?.version || '' };
        const signature = getModUpdateSignature(mod, gameVersion);
        const cached = modUpdateChecks.get(signature);
        if (cached && (cached.pending || Date.now() - cached.checkedAt < RELEASE_CACHE_TTL)) {
            mod._updateCheck = cached;
            return cached;
        }
        if (marketViewLoading) return { version: '', release: null, pending: true };
        const state = mod._updateCheck = { signature, checkedAt: Date.now(), pending: true, version: '', release: null, error: '' };
        modUpdateChecks.set(signature, state);
        const context = getReleaseHistoryContext(mod), refresh = context.refresh;
        const current = () => refresh === marketHistoryRefresh && modUpdateChecks.get(signature) === state && mod._updateCheck === state
            && versions.getGameVersion() === gameVersion && getModUpdateSignature(mod, gameVersion) === signature
            && (!mod.packageEditions?.length || mod._packageEditionUpdateOnly
                || !selectedMarketPackageEditions.has(getMarketModKey(mod))
                || selectedMarketPackageEditions.get(getMarketModKey(mod)) === mod._selectedPackageEdition);
        state.promise = queueModUpdateCheck(async () => {
            const candidates = [];
            let history;
            do {
                if (modUpdateBlocked()) await waitForModUpdateIdle(current);
                if (!current() || isWithdrawn(mod)) return;
                history = await versions.fetchReleases(mod, { page: history ? history.page + 1 : 1, useCache: context.useCache });
                if (modUpdateBlocked()) await waitForModUpdateIdle(current);
                if (!current() || isWithdrawn(mod)) return;
                candidates.push(...versions.buildCandidates(mod, history));
            } while (history.hasMore);
            if (!rememberMarketCandidates(mod, candidates, { state, context })) return;
            const asset = getReleaseInstallAssets(state.release)[0];
            const repository = parseGithubRepo(mod.githubUrl);
            if (mod._matchedLocal?.packageDigest && asset && !getAssetPackageDigest(asset) && repository && state.release.tagName) {
                try {
                    const official = await queueOfficialPackageMetadata(signal => {
                        if (!current() || signal?.aborted) return null;
                        return fetchModRelease(mod, { signal, useCache: false, releaseTag: state.release.tagName });
                    }, current);
                    const matching = official?.availableAssets?.find(item => item.downloadUrl === asset.downloadUrl);
                    if (current() && matching?.digest) {
                        asset.digest = matching.digest;
                        const digest = getAssetPackageDigest(matching);
                        if (digest) downloadedPackageDigests.set(asset.downloadUrl, digest);
                    }
                } catch (_) { /* 官方元数据不可用时保留包内版本，不推断发布身份。 */ }
            }
        }).catch(error => { state.error = error.message || '更新版本暂时无法核对'; }).finally(() => {
            state.pending = false;
            if (!current()) {
                if (modUpdateChecks.get(signature) === state) modUpdateChecks.delete(signature);
                return;
            }
            state.checkedAt = Date.now();
            const updates = getUpdatableMods();
            window.modHubNotifyUpdateState?.(updates.length, updates);
            if (!document.getElementById('modHubMarketCardsContainer')) return;
            if (mod.packageEditions?.length || mod.variant) {
                refreshMarketVariantCard(mod);
                const allProducts = getDisplayMods(marketModList, true);
                const products = allProducts.filter(matchesContentLanguage);
                const members = product => product.isLanguageGroup ? product.variants : [product];
                const updated = new Set(updates.map(item => getMarketModKey(item.marketMod)));
                renderStatsHeader(products.filter(product => members(product).some(member => member._matchedLocal)).length,
                    products.filter(product => members(product).some(member => updated.has(getMarketModKey(member)))).length, products.length,
                    allProducts.filter(product => members(product).some(member => updated.has(getMarketModKey(member)))).length);
            } else queueMarketUpdateRender();
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
                    const m = typeof window.modHubGetModInfo === 'function' ? null : gui.gModUtils.getMod?.(name);
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
                    const m = typeof window.modHubGetModInfo === 'function' ? null : gui?.gModUtils?.getMod?.(name);
                    addProfile(name, m?.bootJson, m);
                }
            }
        } catch (e) {
            console.warn('[ModHub] 获取本地模组档案异常', e);
        }

        normalizedLocalProfiles.add(profiles);
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
        mod._selectedEditionMismatch = false;
        if (isWithdrawn(mod)) return 'unavailable';

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
                    ...v,
                    name: v?.name || k,
                    bootJson: v?.bootJson || v,
                    version: v?.version || '',
                    displayNames: clean,
                    normalizedNames: clean.map(normalizeKey),
                    repos: Array.from(allRepos),
                    repositoryKeys: Array.from(repositoryKeys)
                });
            }
        }

        if (Array.isArray(profileList) && !normalizedLocalProfiles.has(profileList)) {
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

        resolveDisplayedInstallMod(mod, profileList);
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
        mod._selectedEditionMismatch = Boolean(matchedProfile && mod._selectedPackageEdition
            && window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions).length
            && window.modHubMarketVariants.getPackageEdition(mod, matchedProfile)?.id !== mod._selectedPackageEdition);
        if (mod._selectedPackageEdition && mod.packageEditions?.length) getModUpdateInfo(mod, profileList);

        if (!matchedProfile || mod._selectedEditionMismatch) {
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
        const localVer = normalizeModVersion(mod, matchedProfile.version);
        let remoteVer = getModUpdateInfo(mod, profileList).version || mod.version;
        if (localVer && remoteVer) {
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            const hasAuthoritativeRelease = Boolean(mod._updateCheck?.release || mod.releaseUrl || mod.versionSource === 'github' || mod.downloadUrl
                || (Array.isArray(mod.assets) && mod.assets.length > 0));
            // Wiki 人工版本与失效仓库不能作为真实更新依据。
            if (isDead || !hasAuthoritativeRelease && mod.versionSource === 'wiki') return 'up_to_date';
            remoteVer = normalizeModVersion(mod, getModUpdateInfo(mod, profileList).version);
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

    function getWithdrawnDependencyMod(id) {
        const key = String(id).toLowerCase();
        const target = MODHUB_UNSUPPORTED_MARKET_TARGETS.find(target => [target.id, ...(target.identityIds || [])].includes(key));
        if (!target?.bootNames?.length) return null;
        // 停止支持的目录不再展示，仅保留登记技术名供已安装包核验。
        return { id: target.identityIds?.[0] || target.id, name: target.bootNames[0], bootNames: target.bootNames.slice(), autoInstall: false };
    }

    function getWithdrawnDependencyProfile(mod, profiles) {
        if (!isWithdrawn(mod)) return null;
        const list = profiles instanceof Map ? [...profiles.values()] : profiles;
        const registered = getWithdrawnDependencyMod(mod.identityId || mod.id) || mod;
        const names = (registered.bootNames || []).map(name => name.toLowerCase());
        const matches = list.filter(profile => names.includes(String((profile.bootJson || profile).name || '').toLowerCase()));
        return matches.length === 1 ? matches[0].bootJson || matches[0] : null;
    }

    function buildDependencyPlan(targetMod, mods = marketModList, profiles = getLocalInstalledProfiles(), disabledNames) {
        if (isWithdrawn(targetMod)) return { actions: [], requirements: [], unavailable: [{ mod: targetMod, reason: '该来源已停止市场支持，请使用模组管理处理已安装包' }], cycles: [] };
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
        const findMod = id => mods.find(mod => [mod.identityId, mod.id].some(value => String(value || '').toLowerCase() === id.toLowerCase()))
            || getWithdrawnDependencyMod(id);

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
                const local = dependencyMod._matchedLocal || getWithdrawnDependencyProfile(dependencyMod, profiles);
                const requirement = getDependencyVersion(dependency, local);
                const requirementKey = dependencyKey + '\n' + JSON.stringify(dependency);
                if (!requirementKeys.has(requirementKey)) {
                    requirementKeys.add(requirementKey);
                    requirements.push({ dependency: { ...dependency, version: requirement }, mod: dependencyMod });
                }

                const localDisabled = local && [local.name, ...(local.displayNames || [])].some(name => disabled.has(normalizeKey(name)));
                if (isWithdrawn(dependencyMod) && (!local || localDisabled || !satisfiesDependency(local, dependency))) {
                    unavailable.push({ dependency, mod: dependencyMod, reason: '该来源已停止市场支持，请使用模组管理处理已安装包' });
                    continue;
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
                if (localDisabled) {
                    addAction({ type: 'enable', mod: dependencyMod, local, requirement });
                }
            }

            visiting.delete(key);
            visited.add(key);
        };

        visit(targetMod);
        for (const action of actions) action.dependencyRequirements = requirements.filter(item => item.mod === action.mod).map(item => item.dependency);
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
            const local = mod._matchedLocal || getWithdrawnDependencyProfile(mod, profiles);
            const needsEnable = Boolean(local && [local.name, ...(local.displayNames || [])].some(name => disabled.has(normalizeKey(name))));
            nodes.set(key, { mod, local, needsEnable });
            const edges = new Set();
            allDependencies.set(key, edges);
            for (const dependency of getModDependencies(mod)) {
                const dep = catalog.get(dependency.id.toLowerCase()) || getWithdrawnDependencyMod(dependency.id);
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
            const { mod, local, needsEnable } = nodes.get(key);
            if (isWithdrawn(mod) && (!local || needsEnable || targetKeys.has(key)
                || (constraints.get(key) || []).some(item => !satisfiesDependency(local, item.dependency)))) {
                issues.set(key, '该来源已停止市场支持，请使用模组管理处理已安装包');
            }
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
                ...req, dependency: { ...req.dependency, version: getDependencyVersion(req.dependency, local),
                    allRequirements: (constraints.get(key) || []).map(item => ({ ...item.dependency, version: getDependencyVersion(item.dependency, local) })) },
                key, skipped: skipped(key), isTarget: targetKeys.has(key),
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
        const setResult = (action, status, reason = '') => {
            results.set(action.key, { status, reason, action });
            trackBatchInstallMod(action.mod, action.role, action.type);
            setBatchInstallStatus(action.mod.name, status === 'success' ? action.type === 'enable' ? 'enabled' : 'success' : status === 'failed' ? 'error' : 'skipped',
                reason || (action.type === 'enable' ? '已启用，重新载入后生效' : action.type === 'update' ? '已更新，重新载入后生效' : '已安装，重新载入后生效'));
        };
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
            trackBatchInstallMod(action.mod, action.role, action.type);
            if (action.type === 'enable') setBatchInstallStatus(action.mod.name, 'installing', '正在启用前置模组');
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
                    setResult(action, 'skipped', '已取消安装计划确认');
                    stopped = true;
                    continue;
                }
                // 确认期间配置可能改变，不能继续执行旧的启用任务。
                currentPlan = options.getPlan?.() || plan;
                const confirmedAction = currentPlan.actions.find(item => item.key === action.key);
                if (!confirmedAction) {
                    setResult(action, 'skipped', currentPlan.blocked.get(action.key) || '已从当前安装计划移除');
                    continue;
                }
                action = confirmedAction;
                if (isWithdrawn(action.mod)) {
                    setResult(action, 'skipped', '该来源已停止市场支持，请使用模组管理处理已安装包');
                    continue;
                }
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
        if (marketViewLoading) {
            window.modHubShowToast('市场和本地模组资料正在核对，请稍后重试。', 'info');
            return false;
        }
        if (marketInstallBusy) {
            window.modHubShowToast('已有市场安装任务，请等待完成后再试', 'warning');
            return false;
        }
        const installButtons = [...document.querySelectorAll('.btn-market-install, .btn-market-update, .btn-market-addons')]
            .map(button => [button, [...downloadProgressState.values()].find(progress => progress.button === button)?.idleDisabled ?? button.disabled]);
        marketInstallBusy = true;
        const prepareButton = options.batchPreparation ? document.getElementById('modHubBatchInstall') : null;
        if (options.batchPreparation) {
            batchInstallState.preparing = true;
            batchInstallState.progressExpanded = true;
            renderBatchInstallToolbar();
            setBatchTaskPanelExpanded(true);
            document.getElementById('modHubMarketBatchToolbar')?.querySelectorAll('button').forEach(button => { if (!['modHubBatchProgressToggle', 'modHubBatchProgressClose'].includes(button.id)) button.disabled = true; });
            window.modHubSetButtonBusy(prepareButton, true);
            if (prepareButton) {
                prepareButton.disabled = true;
                const label = prepareButton.querySelector('.modhub-button-busy-label');
                if (label) modHubText(label, '正在准备批量安装');
            }
        }
        renderMarketSections();
        installButtons.forEach(([button]) => { button.disabled = true; });
        document.querySelectorAll('.btn-market-language-choice, .btn-market-package-edition').forEach(control => { control.disabled = true; });
        let restoreContext;
        try {
            if (options.batchPreparation && typeof window.requestAnimationFrame === 'function') {
                await window.modHubYieldToBrowser();
            }
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
            if (options.batchPreparation) {
                batchInstallState.preparing = false;
                window.modHubSetButtonBusy(prepareButton, false);
                renderBatchInstallToolbar();
            }
            renderMarketSections();
            const originalDisabled = new Map(installButtons);
            document.querySelectorAll('.btn-market-install, .btn-market-update, .btn-market-addons').forEach(button => {
                const mod = marketModList[Number(button.dataset?.modIndex)];
                if (originalDisabled.has(button)) button.disabled = batchInstallState.selecting || batchInstallState.running || originalDisabled.get(button);
                else if (mod && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod)) button.disabled = batchInstallState.selecting || batchInstallState.running || activeDownloadControllers.has(mod.name);
            });
            document.querySelectorAll('.btn-market-language-choice, .btn-market-package-edition').forEach(control => { control.disabled = batchInstallState.running; });
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
            return `<label class="modhub-dep-item modhub-dep-actionable"><input type="checkbox" class="modhub-dep-checkbox" name="modHubBatchTarget" data-key="${escape(key)}" ${activeTargets.has(key) ? 'checked' : ''}><span class="modhub-dep-content"><span class="gold" data-modhub-i18n-ignore>${escape(mod.name)}</span>${required.length ? `<span class="modhub-batch-target-dependencies grey">需要前置：${escape(required.map(item => item.text).join('、'))}</span>` : ''}${reason ? `<span class="red">${escape(reason)}</span>` : ''}</span></label>`;
        }).join('');
        const dependencies = plan.requirements.filter(req => !req.isTarget).map(req => {
            const action = plan.actions.find(item => item.key === req.key);
            const problem = plan.unavailable.find(item => getMarketModKey(item.mod) === req.key);
            if (req.satisfied && !req.skipped && !problem) {
                return `<div class="modhub-dep-item modhub-dep-satisfied"><span class="modhub-dep-bullet green" aria-hidden="true">•</span><span class="modhub-dep-content"><span class="modhub-dep-name" data-modhub-i18n-ignore>${escape(req.mod.name)}</span><span class="green">已满足，无需下载</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span></span></div>`;
            }
            const status = req.skipped ? '自行处理，可能无法运行' : (problem?.reason || (action ? `${labels[action.type]}${action.enableAfter ? '并启用' : ''}` : '随所属目标跳过'));
            return `<label class="modhub-dep-item modhub-dep-actionable"><input type="checkbox" class="modhub-dep-checkbox" name="modHubBatchDependency" data-key="${escape(req.key)}" ${req.skipped ? '' : 'checked'}><span class="modhub-dep-content"><span class="gold" data-modhub-i18n-ignore>${escape(req.mod.name)}</span><span class="grey">影响：${escape(req.requiredBy.join('、'))}</span><span class="${req.skipped || problem ? 'red' : 'grey'}">${escape(status)}</span></span></label>`;
        }).join('');
        return `${dependencies ? `<div class="modhub-install-dependencies"><strong class="gold">前置依赖（需要处理的项目默认勾选，可取消）</strong>${dependencies}</div>` : ''}<div class="modhub-install-dependencies"><strong class="gold">所选目标</strong><div class="modhub-batch-target-list" role="group" aria-label="所选目标，可上下滚动" tabindex="0">${targets}</div></div><div class="modhub-batch-summary grey"><div>将串行处理 <strong class="gold">${plan.actions.length} 项操作</strong>；不可执行的目标会跳过。</div><div>下载线路：<strong class="gold">${escape(modHubT(resolveMirrorServer(mirrorId).name))}</strong></div></div>`;
    }

    async function installSelectedMods() {
        if (currentMarketSection !== 'packages') return false;
        return runMarketInstallTask(async restoreContext => {
            const profiles = getLocalInstalledProfiles();
            const originalTargets = getDisplayMods().filter(mod => batchInstallState.selected.has(getMarketModKey(mod)) && isBatchInstallEligible(mod, profiles));
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
                await window.modHubAlert('当前选择“浏览器下载（手动安装）”，需要逐个下载后手动导入。\n\n如需批量安装，请选择其他下载方式。', '当前方式需要手动安装');
                return false;
            }
            startBatchInstallProgress(originalTargets);
            renderMarketCards();
            const activeTargets = new Set(originalTargets.map(getMarketModKey));
            const skippedDependencies = new Set(), releaseInfos = new Map(), excluded = new Map(), changedMods = new Set();
            const getPlan = () => buildBatchInstallPlan(originalTargets.filter(mod => activeTargets.has(getMarketModKey(mod))),
                marketModList, getLocalInstalledProfiles(), undefined, skippedDependencies, releaseInfos, excluded);
            let outcome = null;
            try {
                await window.modHubLoadModManageState?.(true);
                const prepareDownloads = async downloads => {
                    getPlan().allActions.forEach(action => trackBatchInstallMod(action.mod, action.role, action.type));
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
                    const confirmPlan = () => window.modHubConfirm({
                        title: '批量安装确认', message: '请核对所选目标和前置依赖。',
                        trustedMessageHtml: `<div id="modHubBatchPlan">${planHtml()}</div>`,
                        dialogClass: 'modhub-install-dialog', confirmText: '开始批量安装', cancelText: '取消', confirmType: 'primary',
                        onRender: dialog => {
                            const area = dialog.querySelector('#modHubBatchPlan');
                            const render = () => {
                                const scrollTop = area.querySelector('.modhub-batch-target-list')?.scrollTop || 0;
                                area.innerHTML = modHubHtml(planHtml());
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

                            };
                            render();
                        }
                    });
                    let choice;
                    while (true) {
                        choice = await confirmPlan();
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
                        const plan = getPlan();
                        const approvedActions = new Set(plan.actions.map(action => `${action.key}:${action.type}`));
                        batchInstallState.progressPhase = 'downloading';
                        setBatchTaskPanelExpanded(true);
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
                                const current = getPlan();
                                if (current.blocked.has(action.key)) throw new Error(current.blocked.get(action.key));
                                const remaining = current.actions.filter(item => !results.has(item.key));
                                if (remaining.some(item => !approvedActions.has(`${item.key}:${item.type}`))) throw new Error('前置状态已改变，请重新生成安装计划');
                                return true;
                            }
                        });
                        outcome.changedMods.forEach(name => changedMods.add(name));
                    }
                }
            } catch (error) {
                failBatchInstallProgress(error?.message || '批量安装未完成');
                await window.modHubAlert(error?.message || String(error), '批量安装未完成');
            } finally {
                finishBatchInstallProgress();
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
        }, { batchPreparation: true });
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

    function updateDownloadProgress(modName, percent, text, state = 'active', replay = false) {
        const previous = downloadProgressState.get(modName);
        const status = { ...previous, percent, text, state, batchProgress: batchInstallState.running || Boolean(replay && previous?.batchProgress) };
        downloadProgressState.set(modName, status);
        if (state !== 'result') updateBatchInstallProgress(modName, status);
        const cards = [...Array.from(document.querySelectorAll?.('.modhub-market-card') || []), ...Array.from(document.querySelectorAll?.('.modhub-market-variant-row') || [])];
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.modhub-download-progress');
        if (!progress) return;
        const checkResult = card.querySelector('.modhub-install-check-result');
        if (checkResult) {
            checkResult.hidden = !status.compatibilityHtml;
            const resultHtml = status.compatibilityHtml ? `<span class="grey">本次安装兼容性检查</span>${status.compatibilityHtml}` : '';
            if (checkResult.innerHTML !== resultHtml) checkResult.innerHTML = modHubHtml(resultHtml);
        }
        if (state === 'result') return;

        const value = state === 'active' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
        const label = progress.querySelector('.modhub-download-label');
        const cancelButton = progress.querySelector('.modhub-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        if (button && status.button !== button) { status.button = button; status.idleDisabled = !batchInstallState.selecting && button.disabled; }
        const waiting = state === 'preparing' || state === 'checking';
        const busy = ['active', 'installing', 'cancelling', 'preparing', 'checking', 'confirming', 'prepared'].includes(state);
        progress.hidden = false;
        progress.classList.toggle('is-error', state === 'error');
        modHubText(label, text);
        if (cancelButton) cancelButton.hidden = !['active', 'checking'].includes(state) || !activeDownloadControllers.has(modName);
        if (button) {
            window.modHubSetButtonBusy(button, busy);
            button.disabled = batchInstallState.selecting || batchInstallState.running || !['error', 'cancelled'].includes(state);
            if (!busy) button.removeAttribute('aria-busy');
            const buttonLabel = busy ? button.querySelector('.modhub-button-busy-label') : button;
            modHubText(buttonLabel, waiting ? state === 'checking' ? '正在核验' : '正在准备' : state === 'installing'
                ? '正在安装'
                : (state === 'error'
                    ? '重试'
                    : (state === 'cancelled' ? (button.dataset.idleText || '下载安装') : ['confirming', 'prepared'].includes(state) ? '等待确认' : state === 'cancelling' ? '正在取消' : (value === null ? '正在下载' : `下载 ${value}%`))));
            if (busy) {
                const ring = button.querySelector('.modhub-progress-ring');
                ring.removeAttribute('aria-hidden');
                ring.setAttribute('role', 'progressbar');
                ring.setAttribute('aria-valuemin', '0');
                ring.setAttribute('aria-valuemax', '100');
                ring.setAttribute('aria-label', `${modName} ${modHubT(['confirming', 'prepared'].includes(state) ? '等待安装确认' : waiting ? '安装准备进度' : state === 'installing' ? '安装进度' : state === 'cancelling' ? '取消下载进度' : '下载进度')}`);
                window.modHubSetProgressRing(ring, value);
            }
        }
    }

    function setBatchInstallCompatibility(modName, trustedHtml) {
        const previous = downloadProgressState.get(modName);
        const status = { ...previous, compatibilityHtml: String(trustedHtml || '') };
        downloadProgressState.set(modName, status);
        const item = batchInstallState.items.get(modName);
        if (batchInstallState.running && item) item.compatibilityHtml = status.compatibilityHtml;
        updateDownloadProgress(modName, previous?.percent ?? null, previous?.text || '', previous?.state || 'result');
        if (batchInstallState.running && item && !previous) {
            const row = [...(document.querySelectorAll('.modhub-batch-item') || [])].find(element => element.dataset.modName === modName);
            if (row) row.innerHTML = modHubHtml(batchItemHtml(item));
        }
    }

    function resetDownloadProgress(modName, preserveResult = false) {
        const previous = downloadProgressState.get(modName);
        downloadProgressState.delete(modName);
        if (preserveResult && previous?.compatibilityHtml) downloadProgressState.set(modName, { compatibilityHtml: previous.compatibilityHtml, state: 'result' });
        const cards = [...Array.from(document.querySelectorAll?.('.modhub-market-card') || []), ...Array.from(document.querySelectorAll?.('.modhub-market-variant-row') || [])];
        const card = cards.find(item => item.dataset.modName === modName);
        const progress = card?.querySelector('.modhub-download-progress');
        if (!progress) return;
        const label = progress.querySelector('.modhub-download-label');
        const cancelButton = progress.querySelector('.modhub-download-cancel');
        const button = card.querySelector('.btn-market-install, .btn-market-update');
        const checkResult = card.querySelector('.modhub-install-check-result');
        if (checkResult && !preserveResult) { checkResult.hidden = true; checkResult.innerHTML = modHubHtml(''); }
        progress.hidden = true;
        progress.classList.remove?.('is-error');
        if (label) modHubText(label, '等待下载');
        if (cancelButton) cancelButton.hidden = true;
        if (button) {
            window.modHubSetButtonBusy(button, false);
            button.disabled = batchInstallState.selecting || batchInstallState.running || Boolean(previous?.button === button && previous.idleDisabled);
            button.removeAttribute('aria-busy');
            modHubText(button, button.dataset.idleText || '下载安装');
        }
    }

    // 释放待确认的包体时同步清理卡片；成功、失败及新下载的状态由各自流程维护。
    window.modHubClearMarketPreparationProgress = function(modName, progressTargetName = modName) {
        let cleared = false;
        for (const name of new Set([modName, progressTargetName].filter(Boolean))) {
            if (!['prepared', 'preparing', 'checking', 'confirming'].includes(downloadProgressState.get(name)?.state) || activeDownloadControllers.has(name)) continue;
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

    async function readDownloadResponse(response, onProgress, maxBytes = MAX_DOWNLOAD_BYTES, expectedBytes = 0, signal = null) {
        const total = Number(response.headers?.get?.('Content-Length')) || Number(expectedBytes) || 0;
        if (total > maxBytes) throw createFileTooLargeError();
        const reader = response.body?.getReader?.();
        const waitForData = async read => {
            let timer, onAbort;
            try {
                return await new Promise((resolve, reject) => {
                    onAbort = () => reject(signal.reason || Object.assign(new Error('已取消下载'), { name: 'AbortError' }));
                    if (signal?.aborted) { onAbort(); return; }
                    signal?.addEventListener('abort', onAbort, { once: true });
                    timer = setTimeout(() => reject(Object.assign(new Error('下载中断（连续 30 秒未收到数据）'),
                        { name: 'TimeoutError', code: 'ETIMEDOUT' })), 30000);
                    Promise.resolve().then(read).then(resolve, reject);
                });
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            }
        };
        try {
            if (!reader) {
                const blob = await waitForData(() => response.blob());
                if (blob.size > maxBytes) throw createFileTooLargeError();
                return blob;
            }
            const chunks = [];
            let received = 0;
            let lastReportedProgress;
            while (true) {
                const { done, value } = await waitForData(() => reader.read());
                if (done) break;
                received += value.byteLength;
                if (received > maxBytes) throw createFileTooLargeError();
                chunks.push(value);
                const progress = total ? Math.round(Math.min(100, received * 100 / total)) : null;
                if (progress !== lastReportedProgress) {
                    lastReportedProgress = progress;
                    onProgress(progress);
                }
            }
            return new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
        } catch (error) {
            if (reader) Promise.resolve(reader.cancel()).catch(() => {});
            throw error;
        } finally {
            reader?.releaseLock?.();
        }
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
    function queueOfficialPackageMetadata(operation, current) {
        const request = officialPackageMetadataQueue.then(async () => {
            if (modUpdateBlocked()) await waitForModUpdateIdle(current);
            if (!current()) return null;
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
        const edition = release?.packageEdition;
        if (edition) {
            const boot = profile?.bootJson || profile;
            if (String(boot?.name || '').toLowerCase() !== edition.bootName.toLowerCase()) return false;
            if (matched !== null) return matched;
            if (edition.bootEdition && boot?.edition !== edition.bootEdition) return false;
            if (!edition.bootEdition && (release?.packageEditions || []).filter(item => item.bootName === edition.bootName).length > 1
                && isReleasePackageInstalled(release, profile) === null) return false;
        }
        if (matched !== null) return matched;
        const published = getPublishedVersion(release);
        if (published && release?.version && !isSameVersion(published, release.version)) return false;
        return isSameVersion(release?.version, profile?.version, null, profile?.bootJson?.name || profile?.name);
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
        return JSON.stringify([getMarketModKey(mod), mod.githubUrl, releaseInfo?.tagName || '', mod.packageEditions, mod.optionalResources,
            releaseInfo?.packageEdition, mod._selectedPackageEdition,
            getReleaseInstallAssets(releaseInfo).map(asset => [asset.name, asset.downloadUrl, asset.size || 0, asset.digest || '', Boolean(asset.optional), asset.bootName || '', asset.packageRole || '', asset.version || '', officialPackageRevisions.get(asset.downloadUrl) || null])]);
    }

    function getPreparedDependencySnapshot(boots) {
        return JSON.stringify(boots.map(boot => [boot.name, boot.version, boot.edition || '', Array.isArray(boot.alias) ? boot.alias : [],
            (Array.isArray(boot.dependenceInfo) ? boot.dependenceInfo : []).filter(dependency => dependency.modName !== 'GameVersion')]));
    }

    const modHubComponentDisabled = name => (window._modHubModState?.sideDisabled || []).some(item => String(item).toLowerCase() === String(name).toLowerCase())
        || (window._modHubModState?.sideMods || []).some(item => String(item.name).toLowerCase() === String(name).toLowerCase() && item.enabled === false);

    function getPreparedLocalComponentSnapshot(boots) {
        const profiles = getLocalInstalledProfiles();
        return JSON.stringify(boots.map(boot => {
            const local = profiles.find(profile => String(profile.name).trim().toLowerCase() === String(boot.name).trim().toLowerCase());
            const actual = local?.bootJson || local;
            return [boot.name, actual ? [actual.name, actual.version, actual.edition || '', actual.alias || [], actual.dependenceInfo || [], local.packageDigest || ''] : null,
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
        return (boots || []).flatMap(boot => {
            const gameRanges = (Array.isArray(boot?.dependenceInfo) ? boot.dependenceInfo : [])
                .filter(dependency => dependency?.modName === 'GameVersion');
            if (!gameRanges.length && versions.getGameIdentity?.().branch === 'dolp') gameRanges.push({ version: '' });
            return gameRanges.flatMap(dependency => {
                const range = String(dependency.version || '');
                const assessment = versions.assessCompatibility(range, gameVersion);
                if (assessment.status === 'compatible') return [];
                return [{ key: JSON.stringify([gameVersion, versions.getGameIdentity?.(), boot.name, boot.version, range]), name: boot.name,
                    version: boot.version || '', range, ...assessment }];
            });
        });
    }

    async function downloadAndInstallMod(mod, mirrorId = currentMirrorId, options = {}) {
        if (!mod || mod.contentType === 'spell') return false;
        if (isWithdrawn(mod)) {
            const message = '该来源已停止市场支持，请使用模组管理处理已安装包';
            options.onFailure?.(message, 'DOWNLOAD_NOT_AUTHORIZED');
            window.modHubShowToast?.(message, 'warning');
            return false;
        }
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
        const failBatch = (reason, code = '', error = null) => {
            if (options.prepareOnly && progressReported) {
                for (const name of new Set([mod.name, options.progressTargetName].filter(Boolean))) {
                    if (['active', 'preparing', 'checking'].includes(downloadProgressState.get(name)?.state)) {
                        updateDownloadProgress(name, null, `${name === mod.name ? '' : options.progressPrefix || ''}${reason}`, 'error');
                    }
                }
            }
            options.onFailure?.(reason, code, error);
            return false;
        };
        if (isWithdrawn(mod) || mod.autoInstall === false) {
            return failBatch('该来源不支持自动安装');
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
        reportProgress(null, '正在获取发布信息...', 'preparing');
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

        // 手动入口不计作安装成功；自动直连受 CORS 限制时由独立线路回退。
        if (selectedMirror.browserOnly && !preparedPackage) return (options.batchMode || options.prepareOnly)
            ? failBatch('当前线路只能手动下载') : startBrowserDownload();

        if (batchInstallState.running && batchInstallState.progressPhase === 'preparing') {
            batchInstallState.progressPhase = 'downloading';
            setBatchTaskPanelExpanded(true);
        }
        window.modHubShowToast(`正在获取【${mod.name}】的 ${installAssets.length} 个安装包...`, 'warning');

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const cancelKeys = [...new Set([mod.name, progressTargetName].filter(Boolean))];
        const clearActiveDownload = () => cancelKeys.forEach(key => {
            if (activeDownloadControllers.get(key) === controller) activeDownloadControllers.delete(key);
        });
        if (controller) cancelKeys.forEach(key => activeDownloadControllers.set(key, controller));
        let failedMirror = selectedMirror;
        reportProgress(null, preparedSnapshot ? '正在检查已下载的安装包'
            : modHubT('正在连接 {route}...', { route: modHubT(selectedMirror.name) }), preparedSnapshot ? 'checking' : 'active');

        try {
            const fileObjects = preparedSnapshot ? preparedSnapshot.files.slice() : [];
            let reusedResources = Boolean(preparedSnapshot?.reusedResources);
            const preparedLimit = options.maxPreparedBytes === undefined ? MAX_DOWNLOAD_BYTES
                : Math.min(MAX_DOWNLOAD_BYTES, Number(options.maxPreparedBytes));
            if (!(preparedLimit >= 0) || (preparedSnapshot && preparedPackage.bytes > preparedLimit)) throw createFileTooLargeError();

            for (let assetIndex = 0; !preparedSnapshot && assetIndex < installAssets.length; assetIndex++) {
                const asset = installAssets[assetIndex];
                const fileName = asset.name || `${mod.name}-${assetIndex + 1}.zip`;
                const records = [...(mod.verifiedReleaseAssets || []), ...(mod.verifiedReleaseAsset ? [mod.verifiedReleaseAsset] : []),
                    ...(window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions) || []).flatMap(edition =>
                        (edition.verifiedAssets || []).map(record => ({ ...record, bootName: edition.bootName })))];
                const evidence = records.find(record => record.sourceUrl === asset.downloadUrl
                    && (mod.bootNames || []).includes(record.bootName) && /^[a-f0-9]{64}$/i.test(record.sha256 || ''));
                const resourceEvidence = (window.modHubMarketVariants?.normalizeOptionalResources(mod.optionalResources) || []).find(record => record.sha256
                    && (record.sourceUrl ? record.sourceUrl === asset.downloadUrl
                        : record.bootName === asset.bootName || getAssetSeries(record.assetSeries) === getAssetSeries(asset.name)));
                const expectedDigest = evidence ? `sha256:${evidence.sha256.toLowerCase()}`
                    : resourceEvidence ? `sha256:${resourceEvidence.sha256.toLowerCase()}` : '';
                if (expectedDigest && asset.digest && String(asset.digest).toLowerCase() !== expectedDigest
                    || (evidence?.size || resourceEvidence?.size) && asset.size && Number(evidence?.size || resourceEvidence?.size) !== Number(asset.size)) {
                    throw Object.assign(new Error(`安装包【${fileName}】与登记的摘要或大小不一致，已停止安装`), { code: 'DIGEST_MISMATCH' });
                }
                const fixedDigest = records.some(record => record.sourceUrl === asset.downloadUrl && /^[a-f0-9]{64}$/i.test(record.sha256 || ''))
                    || Boolean(resourceEvidence);
                const knownRevision = officialPackageRevisions.get(asset.downloadUrl);
                const declaredDigest = String(asset.digest || '').toLowerCase();
                let revision = !fixedDigest && knownRevision?.supersededDigests.includes(declaredDigest) ? knownRevision : null;
                let assetSize = Number(evidence?.size || resourceEvidence?.size || revision?.size || asset.size) || 0;
                let assetDigest = expectedDigest || revision?.digest || asset.digest || '';
                let officialAssetCheck;
                const readOfficialAsset = () => officialAssetCheck ||= Promise.resolve().then(() =>
                    window.modHubMarketVersions.fetchOfficialReleaseAsset(officialSource, { signal: controller?.signal }));
                const verifyDownloadedAsset = async blob => {
                    if (assetSize && blob.size !== assetSize) {
                        const expectedSize = formatAssetSize(assetSize, true), actualSize = formatAssetSize(blob.size, true);
                        const difference = expectedSize === actualSize ? `，差异 ${formatAssetSize(Math.abs(assetSize - blob.size), true)}` : '';
                        throw Object.assign(new Error(`安装包大小不完整（预期 ${expectedSize}，实际 ${actualSize}${difference}）`), { code: 'DOWNLOAD_INCOMPLETE' });
                    }
                    await verifyAssetDigest(blob, assetDigest);
                };
                const officialSource = getOfficialGithubAssetSource(mod, releaseInfo, asset);
                const remainingBytes = preparedLimit - fileObjects.reduce((sum, file) => sum + file.size, 0);
                if (remainingBytes <= 0) throw createFileTooLargeError();
                let blob = null;
                if (asset.optional && asset.bootName && ['audio', 'resource'].includes(asset.packageRole)
                    && typeof window.modHubReadInstalledModPackage === 'function') {
                    reportProgress(null, `${modHubT('正在核对已安装文件')}：${fileName}`, 'checking');
                    try {
                        const installed = await window.modHubReadInstalledModPackage(asset.bootName);
                        if (!installed?.error && !installed?.missing && installed?.data
                            && installed.bootJson?.name === asset.bootName) {
                            if (controller?.signal.aborted) throw Object.assign(new Error('已取消下载'), { name: 'AbortError' });
                            if (!fixedDigest && officialSource && window.modHubMarketVersions?.fetchOfficialReleaseAsset) {
                                const currentAsset = await readOfficialAsset();
                                assetSize = currentAsset.size;
                                assetDigest = currentAsset.digest;
                                revision = currentAsset;
                            }
                            // 普通附件必须使用本次官方证据；固定资源仅按批准摘要复用。
                            if ((fixedDigest || revision && officialAssetCheck) && /^sha256:[a-f0-9]{64}$/i.test(assetDigest)) {
                                const data = installed.data;
                                if (typeof data === 'string' && data.length > Math.ceil(remainingBytes / 3) * 4) throw createFileTooLargeError();
                                const localBlob = new Blob([typeof data === 'string'
                                    ? Uint8Array.from(window.atob(data), char => char.charCodeAt(0)) : data]);
                                if (localBlob.size > remainingBytes) throw createFileTooLargeError();
                                await verifyDownloadedAsset(localBlob);
                                if (controller?.signal.aborted) throw Object.assign(new Error('已取消下载'), { name: 'AbortError' });
                                blob = localBlob;
                                reusedResources = true;
                                reportProgress(100, `${modHubT('已复用已安装文件')}：${fileName}`, 'checking');
                            }
                        }
                    } catch (error) {
                        if (controller?.signal.aborted || error?.name === 'AbortError') throw error;
                    }
                }
                if (controller?.signal.aborted) throw Object.assign(new Error('已取消下载'), { name: 'AbortError' });
                if (assetSize > remainingBytes) throw createFileTooLargeError();
                const trustedDigest = /^sha256:[a-f0-9]{64}$/i.test(assetDigest);
                if (!trustedDigest && !officialSource) {
                    throw Object.assign(new Error('安装包来源无法核验，已停止自动安装'), { code: 'DOWNLOAD_SOURCE_INVALID' });
                }
                const worker = resolveMirrorServer('worker');
                const direct = resolveMirrorServer('github-direct');
                const first = trustedDigest || selectedMirror.useWorker || selectedMirror.direct ? selectedMirror : direct;
                if (first !== selectedMirror) reportProgress(null, '该附件缺少可信摘要，正在使用官方源下载');
                const candidates = [first, worker, { ...worker, name: 'ModHub 加速（备用）', workerBackup: true },
                    ...(trustedDigest ? MIRROR_SERVERS.filter(mirror => !mirror.browserOnly && !mirror.useWorker && !mirror.direct) : [direct])];
                const seenRoutes = new Set();
                const availableMirrors = candidates.filter(candidate => {
                    const route = getDownloadUrl(asset.downloadUrl, candidate.id, candidate.workerBackup);
                    if (seenRoutes.has(route) || !trustedDigest && !isOfficialDownloadRoute(route, officialSource)) return false;
                    seenRoutes.add(route);
                    return true;
                }).slice(0, 3);
                let lastError = null;
                const failures = [];

                for (let cIdx = 0; !blob && cIdx < availableMirrors.length; cIdx++) {
                    const currentCandidate = availableMirrors[cIdx];
                    failedMirror = currentCandidate;
                    const fetchUrl = getDownloadUrl(asset.downloadUrl, currentCandidate.id, currentCandidate.workerBackup);

                    if (cIdx > 0) {
                        console.warn(`[ModHub] 下载线路故障转移，正在自动切换至 ${currentCandidate.name} 下载【${fileName}】`);
                        window.modHubShowToast(modHubT('【{name}】正在自动切换至 {route}...',
                            { name: fileName, route: modHubT(currentCandidate.name) }), 'warning');
                    }
                    reportProgress(null, modHubT('{step}/{total} 正在连接 {route}...',
                        { step: assetIndex + 1, total: installAssets.length, route: modHubT(currentCandidate.name) }));

                    let success = false;
                    if (controller?.signal.aborted) break;
                    {

                        // 自建线路需先核验目录并回源；各附件仍优先使用玩家所选线路。
                        const connectTimeoutMs = currentCandidate.useWorker ? 20000 : 8000;
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
                                const timeoutErr = new Error(`连接超时（超过 ${connectTimeoutMs / 1000} 秒未响应）`);
                                timeoutErr.name = 'TimeoutError';
                                timeoutErr.code = 'ETIMEDOUT';
                                connectTimeoutController.abort(timeoutErr);
                            }, connectTimeoutMs)
                            : null;

                        try {
                            const fetchOptions = { cache: 'no-store', ...(connectTimeoutController ? { signal: connectTimeoutController.signal }
                                : (controller ? { signal: controller.signal } : {})) };
                            if (currentCandidate.direct) Object.assign(fetchOptions, { mode: 'cors', credentials: 'omit' });
                            const response = await fetch(fetchUrl, fetchOptions);
                            if (timeoutId !== null) clearTimeout(timeoutId);

                            if (!response.ok) {
                                const denial = currentCandidate.useWorker ? await readWorkerDownloadFailure(response, connectTimeoutController?.signal || controller?.signal) : null;
                                if (denial) throw denial;
                                response.body?.cancel?.().catch(() => {});
                                const error = new Error(`网络响应异常 HTTP ${response.status}`);
                                error.status = response.status;
                                throw error;
                            }

                            // 接收阶段按实际数据重置等待时间，慢速传输不受总时长限制。
                            blob = await readDownloadResponse(response, percent => {
                                reportProgress(
                                    percent,
                                    `${assetIndex + 1}/${installAssets.length} ${percent === null ? '正在接收' : `正在下载 ${Math.round(percent)}%`}：${fileName}`
                                );
                            }, remainingBytes, assetSize, connectTimeoutController?.signal || controller?.signal);

                            try {
                                await verifyDownloadedAsset(blob);
                            } catch (error) {
                                if (!['DIGEST_MISMATCH', 'DOWNLOAD_INCOMPLETE'].includes(error.code) || fixedDigest || !officialSource
                                    || officialAssetCheck || !window.modHubMarketVersions?.fetchOfficialReleaseAsset) throw error;
                                // 作者可替换同名附件；只信任精确官方发布的现行证据，不以收到的包体修订预期摘要。
                                let currentAsset;
                                try {
                                    currentAsset = await readOfficialAsset();
                                } catch (refreshError) {
                                    if (controller?.signal.aborted) throw refreshError;
                                    error.message += `；GitHub 附件复核失败：${refreshError.message || refreshError}`;
                                    throw error;
                                }
                                assetSize = currentAsset.size;
                                assetDigest = currentAsset.digest;
                                revision = currentAsset;
                                await verifyDownloadedAsset(blob);
                            }
                            success = true;
                        } catch (err) {
                            if (timeoutId !== null) clearTimeout(timeoutId);
                            blob = null;
                            lastError = connectTimeoutController?.signal.reason?.code === 'ETIMEDOUT'
                                ? connectTimeoutController.signal.reason : err;
                            failures.push({ mirrorName: currentCandidate.name, message: lastError.message || String(lastError) });
                            connectTimeoutController?.abort(lastError);
                            const nonRetryableCodes = ['FILE_TOO_LARGE', 'DIGEST_UNSUPPORTED', 'DIGEST_UNAVAILABLE', 'DOWNLOAD_NOT_AUTHORIZED', 'CATALOG_UNAVAILABLE'];
                            if (controller?.signal.aborted || nonRetryableCodes.includes(err?.code)) {
                                throw err;
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
                    const uniqueFailures = [...new Map(failures.map(failure => [`${failure.mirrorName}：${failure.message}`, failure])).values()];
                    const error = new Error(`安装包【${fileName}】下载失败。\n${uniqueFailures.map(failure => `${failure.mirrorName}：${failure.message}`).join('\n') || '所有可用下载线路均尝试失败'}`);
                    error.code = lastError?.code || 'DOWNLOAD_FAILED';
                    error.downloadFailures = true;
                    error.downloadFailureDetails = { fileName, failures: uniqueFailures };
                    error.status = lastError?.status;
                    throw error;
                }

                if ((revision || !fixedDigest && knownRevision) && /^sha256:[a-f0-9]{64}$/i.test(assetDigest)) {
                    const supersededDigests = [...new Set([...(knownRevision?.supersededDigests || []), knownRevision?.digest, declaredDigest]
                        .filter(digest => /^sha256:[a-f0-9]{64}$/i.test(digest || '') && digest !== assetDigest))];
                    officialPackageRevisions.set(asset.downloadUrl, { size: assetSize, digest: assetDigest, supersededDigests });
                    Object.assign(asset, { size: assetSize, digest: assetDigest });
                    if (assetIndex === 0) Object.assign(releaseInfo, { assetSize, assetDigest });
                }
                const digest = await getPackageDigest(blob);
                if (digest) downloadedPackageDigests.set(asset.downloadUrl, digest);
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
            const boots = [];
            const sameComponents = new Set();
            if ((options.prepareOnly || preparedPackage || options.dependencyRequirements?.some(item => item.bootVersions))
                && typeof modController?.checkModZipFileIndexDB !== 'function') {
                const error = new Error('当前 ModLoader 无法核验所选安装包，请手动下载并导入。');
                error.code = 'INSTALL_PACKAGE_INVALID';
                throw error;
            }
            if (typeof modController?.checkModZipFileIndexDB === 'function') {
                reportProgress(null, '正在核验安装包身份与前置声明，请稍候。', 'checking');
                const edition = releaseInfo.packageEdition;
                const auModelName = !edition && (mod.identityId || mod.id) === 'au-beautification'
                    ? mod._matchedLocal?.name || mod.bootNames?.find(name => normalizeKey(name) === getAssetSeries(fileObjects[0]?.name)) : '';
                const expectedNames = (edition ? [edition.bootName] : auModelName ? [auModelName] : (mod.bootNames?.length ? mod.bootNames : [mod._matchedLocal?.name]))
                    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().toLowerCase());
                for (const [index, file] of fileObjects.entries()) {
                    try {
                        const boot = await modController.checkModZipFileIndexDB(new Uint8Array(await file.arrayBuffer()));
                        const actualName = typeof boot?.name === 'string' ? boot.name.trim() : '';
                        if (!actualName || typeof boot !== 'object' || Array.isArray(boot)) {
                            throw new Error(`【${file.name}】没有可识别的模组清单，不能作为 ModLoader 模组导入。`);
                        }
                        const asset = installAssets[index];
                        if (index === 0 && expectedNames.length && !expectedNames.includes(actualName.toLowerCase())) {
                            throw new Error(`所选【${mod.name}】的安装包实际为【${actualName}】，与已确认的模组身份不符，已停止安装。`);
                        }
                        if (index === 0 && edition?.bootEdition && boot.edition !== edition.bootEdition) {
                            throw new Error('安装包的实际包型与所选类型不一致，已停止安装。');
                        }
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
                            : isSameVersion(boot.version, profile?.version, null, boot.name) && (!edition || window.modHubMarketVariants?.getPackageEdition(mod, profile)?.id === edition.id);
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
            if (isWithdrawn(mod)) throw Object.assign(new Error('该来源已停止市场支持，请使用模组管理处理已安装包'), { code: 'DOWNLOAD_NOT_AUTHORIZED' });
            if (options.prepareOnly) {
                const prepared = { files: fileObjects, boots, releaseInfo,
                    bytes: fileObjects.reduce((sum, file) => sum + file.size, 0),
                    modKey: getMarketModKey(mod), sourceFingerprint: getPreparedPackageSource(mod, releaseInfo) };
                preparedMarketPackages.set(prepared, { source: prepared.sourceFingerprint, files: fileObjects.slice(),
                    sameComponents, reusedResources, dependencies: getPreparedDependencySnapshot(boots), localComponents: checkedLocalComponents });
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
                const gameLabel = window.modHubMarketVersions?.getGameVersionLabel?.() || (gameVersion ? `DoL ${gameVersion}` : '未识别');
                const localProfiles = getLocalInstalledProfiles();
                const context = `当前游戏版本：${gameLabel}\n\n` + newRisks.map(risk => {
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
            reportProgress(100, '安装文件已准备好，正在安装...', 'installing');

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
                if ((Array.isArray(mod.requiredDependencies) && mod.requiredDependencies.length || inferRequiredDependencies(mod).length)
                    && !window.modHubMarketVariants?.normalizeRequiredDependencies) {
                    throw Object.assign(new Error('前置检查功能不可用，已停止安装。'), { code: 'INSTALL_PACKAGE_INVALID' });
                }
                return getRequiredDependencies(mod);
            };
            const requiredSnapshot = JSON.stringify(readImportRequirements());
            const validateRequiredDependencies = async () => {
                const requirements = readImportRequirements();
                if (JSON.stringify(requirements) !== requiredSnapshot) throw Object.assign(new Error('模组的前置要求已更改，请重新确认要安装的内容。'), { code: 'INSTALL_PACKAGE_INVALID' });
                if (!requirements.length) return;
                await refreshLocalPackageProfiles();
                const profiles = getLocalInstalledProfiles();
                for (const requirement of requirements) {
                    const internal = boots.filter(boot => [boot.name, ...(Array.isArray(boot.alias) ? boot.alias : [])].includes(requirement.modName));
                    if (internal.length) {
                        if (internal.length === 1 && satisfiesDependency(internal[0], { bootName: requirement.modName, version: requirement.version, required: true })) continue;
                        throw Object.assign(new Error(`安装包提供的前置【${requirement.modName}】身份不明确或版本不符，已停止安装。`), { code: 'INSTALL_PACKAGE_INVALID' });
                    }
                    const provider = selectDependencyProvider(profiles, requirement.modName);
                    const boot = provider?.bootJson || provider;
                    if (!provider || modHubComponentDisabled(provider.name) || !satisfiesDependency(boot, { bootName: requirement.modName, version: requirement.version, required: true })) {
                        throw Object.assign(new Error(`前置模组【${requirement.modName}】尚未满足要求：未安装、未启用、身份无法确认或版本不符。请先安装并启用符合要求的前置，再重试。`), { code: 'INSTALL_PACKAGE_INVALID' });
                    }
                }
            };
            const validateBeforeImport = async () => {
                if (isWithdrawn(mod)) throw Object.assign(new Error('该来源已停止市场支持，请使用模组管理处理已安装包'), { code: 'DOWNLOAD_NOT_AUTHORIZED' });
                await validateRequiredDependencies();
                await options.beforeImport?.();
                if (isWithdrawn(mod)) throw Object.assign(new Error('该来源已停止市场支持，请使用模组管理处理已安装包'), { code: 'DOWNLOAD_NOT_AUTHORIZED' });
                if (reusedResources) {
                    await refreshLocalPackageProfiles(boots.map(boot => boot.name));
                    if (controller?.signal.aborted) throw Object.assign(new Error('已取消安装'), { name: 'AbortError' });
                    if (checkedLocalComponents !== getPreparedLocalComponentSnapshot(boots)) {
                        throw Object.assign(new Error('等待写入时本地组件状态已变化，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
                    }
                }
                const atomic = options.atomicPackageChanges;
                if (!atomic) return;
                const optionalNames = installAssets.filter(asset => asset.optional && asset.bootName).map(asset => asset.bootName.toLowerCase());
                const preserved = (atomic.preserveDisabledNames || []).map(name => name.toLowerCase());
                if (preserved.some(name => !optionalNames.includes(name) || !modHubComponentDisabled(name))) {
                    throw new Error('附加项身份或禁用状态已变化，请重新生成安装计划。');
                }
                if (boots.some(boot => (boot.dependenceInfo || []).some(item => preserved.includes(String(item.modName || '').toLowerCase())))) {
                    throw new Error('所选包必需依赖当前保持禁用的附加项，请调整安装计划。');
                }
                if (atomic.switchGroup) {
                    const declared = window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions) || [];
                    const members = mod.variant?.type === 'edition' ? getLanguageIdentityMembers(mod) : [];
                    const allowed = [...declared.filter(item => item.exclusive).map(item => item.bootName), ...members.flatMap(item => item.bootNames || [])].map(name => name.toLowerCase());
                    if (!allowed.includes(String(atomic.switchGroup.targetName).toLowerCase())
                        || !boots.some(boot => boot.name.toLowerCase() === String(atomic.switchGroup.targetName).toLowerCase())
                        || (atomic.switchGroup.disabledNames || []).some(name => !allowed.includes(name.toLowerCase()))) {
                        throw new Error('互斥分支的真实身份与目录声明不一致，已停止安装。');
                    }
                }
            };
            await refreshLocalPackageProfiles(boots.map(boot => boot.name));
            await validateBeforeImport();
            if (controller?.signal.aborted) throw Object.assign(new Error('已取消安装'), { name: 'AbortError' });
            const primaryBoot = boots[0];
            if (checkedLocalComponents !== getPreparedLocalComponentSnapshot(boots)) {
                throw Object.assign(new Error('等待写入时本地组件状态已变化，请重新生成安装计划'), { code: 'INSTALL_PACKAGE_INVALID' });
            }
            const preservedNames = (options.atomicPackageChanges?.preserveDisabledNames || []).map(name => name.toLowerCase());
            const switchPending = options.atomicPackageChanges?.switchGroup && (modHubComponentDisabled(options.atomicPackageChanges.switchGroup.targetName)
                || options.atomicPackageChanges.switchGroup.disabledNames.some(name => !modHubComponentDisabled(name)));
            if (!filesToImport.length && !switchPending && !boots.some(boot => sameComponent(boot) && modHubComponentDisabled(boot.name) && !preservedNames.includes(boot.name.toLowerCase()))) {
                clearActiveDownload();
                resetDownloadProgress(mod.name);
                if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                window.modHubShowToast('当前所选版本已安装，无需重复安装', 'info');
                return failBatch('当前所选版本已安装，无需重复安装', 'ALREADY_INSTALLED');
            }
            if (filesToImport.length && typeof window.modHubHandleAddMod !== 'function' && options.restoreContext && window.modHubRestore?.prepare &&
                !await window.modHubRestore.prepare(options.restoreContext)) return failBatch('已取消没有还原点的安装');
            if (options.atomicPackageChanges && typeof window.modHubHandleAddMod !== 'function') throw new Error('原子模组导入接口不可用，已停止安装。');
            if (!filesToImport.length && !options.atomicPackageChanges) {
                // 同版且已禁用的组件由确认计划后的管理器操作启用，不重新写入包体。
            } else if (typeof window.modHubHandleAddMod === 'function') {
                const installed = await window.modHubHandleAddMod(dummyInput.files && dummyInput.files.length > 0 ? dummyInput : filesToImport, {
                    askRestart,
                    skipReloadOffer: options.skipReloadOffer,
                    // 市场内安装：「稍后重载」后停留市场页签，方便玩家连续安装多个模组
                    keepCurrentTab: true,
                    restoreContext: options.restoreContext,
                    ...(options.atomicPackageChanges ? { atomicPackageChanges: options.atomicPackageChanges } : {}),
                    targetModName: filesToImport[0] === fileObjects[0] ? mod._matchedLocal?.name || '' : '',
                    displayName: mod.name || '',
                    beforeImport: validateBeforeImport
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
            resetDownloadProgress(mod.name, true);
            if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName, true);
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
                setBatchInstallStatus(mod.name, 'cancelled', '已取消，尚未安装');
                resetDownloadProgress(mod.name);
                if (progressTargetName !== mod.name) resetDownloadProgress(progressTargetName);
                window.modHubShowToast(`已取消【${mod.name}】的下载`, 'info');
                return failBatch('已取消下载', 'INSTALL_CANCELLED');
            }
            if (['DOWNLOAD_NOT_AUTHORIZED', 'CATALOG_UNAVAILABLE', 'DOWNLOAD_SOURCE_INVALID'].includes(err?.code)) {
                reportProgress(null, err.message, 'error');
                if (!options.batchMode && !options.prepareOnly) await window.modHubAlert?.(err.message, '自动安装已停止');
                return failBatch(err.message, err.code, err);
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

            if (options.batchMode || options.prepareOnly) return failBatch(err?.message || '下载或安装失败', err?.code || '', err);

            if (isDigestFailure) {
                if (typeof window.modHubAlert === 'function') {
                    await window.modHubAlert(modHubT('模组【{name}】的安装包未能通过 GitHub 官方 SHA-256 完整性校验，已阻止安装。\n\n请选择“浏览器下载（手动安装）”，重新下载后手动导入。',
                        { name: mod.name }), '安装包完整性校验失败');
                }
                return false;
            }

            const alternatives = (isTooLarge ? MIRROR_SERVERS.filter(mirror => mirror.browserOnly) : MIRROR_SERVERS.filter(mirror => mirror.id !== failedMirror.id));
            const failureReason = err?.status === 429
                ? `${failedMirror.name} 当前返回 HTTP 429，服务正在限流。`
                : `${failedMirror.name} 页面内下载连接中断，自动重试仍未成功。`;
            const fallbackMsg = isTooLarge
                ? modHubT('模组【{name}】安装包较大，请选择“浏览器下载（手动安装）”，下载完成后手动导入。', { name: mod.name })
                : `模组【${mod.name}】下载失败。\n\n${err?.downloadFailures ? err.message : failureReason}\n\n请选择其他下载线路重试。`;
            let retryMirrorId = '';
            if (typeof window.modHubConfirm === 'function') {
                retryMirrorId = await window.modHubConfirm({
                    title: '自动安装失败',
                    message: fallbackMsg,
                    selectLabel: '重试线路',
                    selectOptions: alternatives.map(mirror => ({ value: mirror.id, label: modHubT(mirror.name) })),
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
            const [data, catalog] = await Promise.all([
                fetchMarketJson(`${WIKI_API}?${params.toString()}`, 'Wiki API'),
                identityPromise
            ]);
            if (!data.parse || !data.parse.text) throw new Error('Wiki 数据格式解析异常');

            marketModList = parseModsFromHtml(data.parse.text['*'], catalog).filter(mod => !isWithdrawn(mod));
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
        return !isWithdrawn(mod) && !isDelistedMarketMod(mod);
    }

    function filterAndSortMods(profiles = getLocalInstalledProfiles(), evaluatedMods) {
        let list = evaluatedMods || marketModList.map((mod, marketIndex) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: marketIndex };
        });

        const browsableKeys = new Set(getDisplayMods(list).flatMap(mod => getDisplayModMembers(mod, list)).map(getMarketModKey));
        list = list.filter(mod => isMarketSourceVisible(mod) && browsableKeys.has(getMarketModKey(mod)));

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

        // 3. 两端共用离线搜索规则，名称优先，支持多词、拼音和有限拼写容错。
        const search = currentSearchText ? window.modHubSearch.compile(currentSearchText) : { tokens: [] };
        if (search.tokens.length) {
            list = list.map(mod => ({ ...mod, _searchScore: window.modHubSearch.score(getLocalizedSearchEntry(mod), search) }))
                .filter(mod => mod._searchScore >= 0);
        }

        const effectiveDates = currentSortBy === 'date' ? new Map(list.map(mod =>
            [mod, getLatestMarketVersionInfo(mod).updateDate || mod.updateDate || '1970-01-01'])) : null;
        // 4. 排序：有新版本可更新的模组始终最高优先级强制置顶！
        list.sort((a, b) => {
            const aUp = a._status === 'update_available' ? 1 : 0;
            const bUp = b._status === 'update_available' ? 1 : 0;
            if (aUp !== bUp) return bUp - aUp;

            if (search.tokens.length && currentSortBy === 'date' && a._searchScore !== b._searchScore) {
                return b._searchScore - a._searchScore;
            }

            if (currentSortBy === 'date') {
                // 列表按当前产品的最新发布排序，不使用适配推荐的旧版本日期。
                const da = effectiveDates.get(a);
                const db = effectiveDates.get(b);
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
        return currentStatusFilter === filter;
    }

    function renderStatsHeader(installedCount, updatableCount, totalCount, allUpdatableCount) {
        const statsEl = document.getElementById('modHubMarketStats');
        if (!statsEl) return;
        const focusedFilter = statsEl.contains?.(document.activeElement) ? document.activeElement?.dataset?.filter : '';
        const busy = batchInstallState.running || batchInstallState.preparing || marketInstallBusy;
        const updateAllBtnHtml = allUpdatableCount > 0
            ? `<button type="button" class="macro-button modhub-market-update-all" data-filter="update-all" onclick="window.modHubMarket.updateAllMods()" title="更新全部 ${allUpdatableCount} 个可更新模组" aria-label="更新全部 ${allUpdatableCount} 个可更新模组"${busy ? ' disabled' : ''}><span>一键更新全部模组</span><strong class="modhub-market-update-count" aria-hidden="true">${allUpdatableCount}</strong></button>`
            : '';
        const filters = [
            ['all', '全部', totalCount, '查看全部安装状态，保留当前分类与搜索'],
            ['installed', '已装', installedCount, '仅查看本地已安装模组'],
            ['updatable', '可更新', updatableCount, '仅查看发现新版的模组'],
            ['installable', '可安装', null, '仅查看可安装或可更新的模组'],
            ['ignored', '已忽略', null, '仅查看已忽略更新的模组']
        ];
        statsEl.innerHTML = modHubHtml(filters.map(([filter, label, count, title]) =>
            `<button type="button" class="modhub-market-summary-button ${isStatsFilterActive(filter) ? 'is-selected' : ''}" data-filter="${filter}" onclick="window.modHubMarket.selectStatusFilter('${filter}')" aria-pressed="${isStatsFilterActive(filter)}" aria-controls="modHubMarketCardsContainer" title="${title}"${busy ? ' disabled' : ''}>${label}${count == null ? '' : ` <strong>${count}</strong>`}</button>`).join('') + updateAllBtnHtml);
        if (focusedFilter) statsEl.querySelector(`[data-filter="${focusedFilter}"]:not(:disabled)`)?.focus();
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
        if (mod._selectedPackageEdition && mod.packageEditions?.length) {
            return { version: latestRelease?.version || '', text: latestRelease?.version ? formatVersionDisplay(latestRelease.version) : currentUpdate?.pending ? '正在读取' : '未知',
                updateDate: latestRelease?.updateDate || '', updateDateSource: latestRelease?.updateDateSource || 'github' };
        }
        if (latestRelease?.version && compareVersions(latestRelease.version, indexedVersion, mod) > 0) {
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
        const unpublishedDifference = publishedVersion && !isSameVersion(publishedVersion, latestVersion, mod);
        if (packageMatch === true && isSameVersion(published, latestVersion, mod)
            || packageMatch !== false && !unpublishedDifference && localVersion && latestVersion && isSameVersion(localVersion, latestVersion, mod)) {
            label = '已是最新';
            title = '与当前目录最新版本相同';
        } else if (localVersion && latestVersion && compareVersions(localVersion, latestVersion, mod) > 0) {
            title = `当前已安装版本 (${formatVersionDisplay(localVersion)}) 高于市场目录收录版本 (${formatVersionDisplay(latestVersion)})。`;
        } else if (localVersion && latestVersion && updateInfo.release && isSameVersion(localVersion, updateInfo.version, mod)
            && ['declaration', 'filename'].includes(updateInfo.release.compatibility?.evidence)
            && compareVersions(latestVersion, localVersion, mod) > 0) {
            label = '已是推荐版本';
            title = `当前游戏推荐版本与已安装版本相同；目录最新版本 ${formatVersionDisplay(latestVersion)} 更高。`
                + (updateInfo.release.compatibility?.evidence === 'filename' ? '根据安装包名称推荐。' : '根据作者说明推荐。');
        } else if (localVersion && latestVersion && mod._updateCheck && !updateInfo.version && !updateInfo.error
            && (!updateInfo.pending || !window.modHubMarketVersions?.getGameVersion?.())) {
            if (compareVersions(localVersion, latestVersion, mod) < 0) {
                details.push(window.modHubMarketVersions?.getGameVersion?.()
                    ? '未找到适配当前游戏的版本' : '无法识别当前游戏版本，尚未检查适配更新');
            }
        }
        if (updateInfo.pending) details.push('正在检查更新，请稍候。');
        if (updateInfo.error) {
            if (localVersion && latestVersion && compareVersions(localVersion, latestVersion, mod) >= 0) {
                // 本地已是高版本或最新版本时，远端更新检查临时失败不作为阻断性错误呈现
            } else {
                details.push(`更新检查失败：${updateInfo.error}。可刷新市场后重试。`);
            }
        }
        const detail = details.join('；');
        return { label, title: [title, detail].filter(Boolean).join('；'), detail };
    }

    // 主用途已核对为图像或服装资源；仅隐藏卡片徽标，不宣称无文本，也不改变语言选包。
    const MODHUB_VISUAL_LANGUAGE_BADGE_HIDDEN_IDS = new Set([
        'angel-halos', 'eu-clothing-addition', 'fumo-mod', 'npc-social-avatars', 'ray-beautification', 'ray-extra-clothes'
    ]);

    function hideModHubLanguageTag(mod) {
        const identityId = mod.identityId === null ? '' : mod.identityId || mod.id;
        return identityId === 'modhub' || !mod.identityId && ['ModHub', 'ModHub模组管理中心'].includes(mod.name)
            && [mod.githubUrl, mod.sourceUrl, ...(mod.githubUrls || [])]
                .some(url => extractRepoKey(url) === 'johnliao501/modhub');
    }

    function renderCardClassificationTags(mod, escapeHtml) {
        const hideTranslationTag = mod.name === '美化修正' && [mod.githubUrl, mod.sourceUrl, ...(mod.githubUrls || [])]
            .some(url => extractRepoKey(url) === 'anlinstudio/degrees-of-lewdity-beautyfixer');
        const hideLanguageTag = hideModHubLanguageTag(mod);
        return [
            `<span class="modhub-market-tag modhub-market-category" data-modhub-card-tag="${escapeHtml(mod.category || '待分类')}" data-modhub-i18n-ignore>${escapeHtml(window.modHubGetMarketCardText({ name: mod.category || '待分类' }, 'name').text)}</span>`,
            ...(mod.tags || []).filter(tag => (!hideTranslationTag || tag !== '翻译') && (!hideLanguageTag || tag !== '繁体中文')).map(tag => `<span class="modhub-market-tag" data-modhub-card-tag="${escapeHtml(tag)}" data-modhub-i18n-ignore>${escapeHtml(window.modHubGetMarketCardText({ name: tag }, 'name').text)}</span>`)
        ].join('');
    }

    function renderOptionalAddonSummary(mod, escapeHtml) {
        const addons = getOptionalAddonMods(mod);
        if (!addons.length) return '';
        const profiles = getLocalInstalledProfiles();
        const items = addons.map(addon => {
            const status = checkModInstallStatus(addon, profiles);
            const state = status === 'update_available' ? '发现新版' : addon._matchedLocal ? '已安装' : '未安装';
            return `<span class="modhub-market-addon-item"><span data-modhub-i18n-ignore>${escapeHtml(getLocalizedModName(addon))}</span> · ${modHubLabelHtml(state)}</span>`;
        }).join('');
        return `<div class="modhub-market-addon-summary"><div class="modhub-market-meta grey">${modHubLabelHtml('可选附加内容')}：${items}</div><button type="button" class="macro-button modhub-btn-secondary btn-market-addons" data-mod-index="${mod._marketIndex}" ${marketViewLoading || marketInstallBusy || batchInstallState.running ? 'disabled' : ''}>${modHubLabelHtml('选择附加内容')}</button></div>`;
    }

    function renderCardLanguageTags(mod, escapeHtml) {
        const members = (mod.isLanguageGroup ? mod.variants : [mod]).filter(member => {
            const identityId = member.identityId === null ? '' : member.identityId || member.id;
            if (hideModHubLanguageTag(member)) return false;
            if (window.modHubMarketVariants?.normalizeVariant(member.variant)?.type === 'language') return true;
            return member.contentType === 'spell' || !MODHUB_VISUAL_LANGUAGE_BADGE_HIDDEN_IDS.has(identityId);
        });
        const hasTraditionalChinese = members.some(member => {
            const variant = window.modHubMarketVariants?.normalizeVariant(member.variant);
            const locales = variant?.type === 'language' ? [variant.id]
                : window.modHubMarketVariants?.normalizePackageLanguages(member.packageLanguages) || [];
            return locales.some(locale => /^zh-(?:TW|Hant(?:-[a-z0-9]{2,8})*)$/i.test(locale));
        });
        if (!hasTraditionalChinese) return '';
        const label = '繁体中文';
        const title = `title="${escapeHtml(modHubT('模组语言'))}" data-modhub-i18n-title="模组语言"`;
        return `<span class="modhub-market-tag" data-modhub-card-language ${title}><span data-modhub-card-tag="${label}" data-modhub-i18n-ignore>${escapeHtml(window.modHubGetMarketCardText({ name: label }, 'name').text)}</span></span>`;
    }

    function renderReleaseStatus(mod) {
        const label = { development: '制作中', preview: '预发布' }[mod.releaseStatus];
        return label ? `<span class="modhub-market-tag" data-modhub-i18n-key="${label}">${modHubT(label)}</span>` : '';
    }

    function renderLanguageGroupCard(group, profiles, escapeHtml) {
        const editionGroup = group.variantType === 'edition';
        const typeText = editionGroup ? '版本类型' : '语言';
        const installed = group.variants.filter(mod => mod._matchedLocal);
        const isUpdatable = group.variants.some(mod => mod._status === 'update_available'
            && !mod._isDeadRepo && !isDeadRepo(mod.githubUrl, mod));
        const active = resolveDisplayedInstallMod(group, profiles);
        const selected = batchInstallState.selected.has(getMarketModKey(group));
        const selectionHtml = isBatchInstallEligible(group, profiles, true)
            ? `<label class="modhub-market-select-label" ${batchInstallState.selecting ? '' : 'hidden'}><input type="checkbox" class="modhub-market-select" data-mod-key="${escapeHtml(getMarketModKey(group))}" aria-label="选择${escapeHtml(group.name)}" ${selected ? 'checked' : ''} ${batchInstallState.running ? 'disabled' : ''}>选择</label>` : '';
        const choices = [];
        const rows = group.variants.map(mod => {
            const label = window.modHubMarketVariants.normalizeVariant(mod.variant).label;
            const displayLabel = window.modHubMarketVariants.getLabelText(label);
            const latest = getLatestMarketVersionInfo(mod);
            const dead = mod._isDeadRepo || isDeadRepo(mod.githubUrl, mod);
            const state = dead ? '来源失效' : mod._status === 'update_available' ? '发现新版'
                : mod._isIgnored ? '已忽略更新' : mod._matchedLocal ? '已安装'
                    : mod._status === 'not_installed' ? '未安装' : '请核对来源';
            const requirements = getRequiredDependencies(mod);
            const requirementsHtml = requirements.map(requirement => {
                const providers = profiles.filter(profile => {
                    const boot = profile.bootJson;
                    return [boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])]
                        .some(name => name === requirement.modName);
                });
                const provider = selectDependencyProvider(profiles, requirement.modName, true);
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
                return `<div class="modhub-market-meta modhub-market-variant-requirements ${color}" title="${escapeHtml(modHubT(reason))}">${modHubLabelHtml(editionGroup ? '该版本类型额外前置' : '该语言额外前置')}：<span data-modhub-i18n-ignore>${escapeHtml(requirement.modName)}</span>（${modHubLabelHtml(status)}）</div>`;
            }).join('');
            const source = window.modHubMarketSpells?.renderAcquisitionDetails(mod) || '';
            const actionLabel = modHubT(mod._status === 'update_available' ? '更新{kind}' : '选择{kind}版本', { kind: displayLabel });
            const action = `<button type="button" class="macro-button ${dead ? 'modhub-btn-secondary' : `modhub-btn-primary ${mod._status === 'update_available' ? 'btn-market-update' : 'btn-market-install'}`}" data-mod-index="${mod._marketIndex}" data-idle-text="${escapeHtml(actionLabel)}" ${dead || batchInstallState.running || marketInstallBusy ? 'disabled' : ''}>${dead ? '来源失效' : escapeHtml(actionLabel)}</button>`;
            const ignore = mod._status === 'update_available' && !dead
                ? `<div class="modhub-market-ignore-actions"><button type="button" class="btn-market-ignore" data-mod-index="${mod._marketIndex}" data-ignore-mode="once">忽略本次</button><button type="button" class="btn-market-ignore" data-mod-index="${mod._marketIndex}" data-ignore-mode="always">永久忽略</button></div>`
                : mod._isIgnored ? `<button type="button" class="btn-market-unignore" data-mod-index="${mod._marketIndex}">${modHubLabelHtml('取消忽略{name}', { name: displayLabel })}</button>` : '';
            const choiceDetail = modHubT('{label}；{state}；已安装版本：{installed}；最新版本：{latest}', { label: displayLabel, state: modHubT(state), installed: mod._matchedLocal?.version || modHubT(mod._matchedLocal ? '未知' : '未安装'), latest: modHubT(latest.text) });
            const loading = mod === active && mod._updateCheck?.pending;
            choices.push(`<button type="button" class="modhub-market-language-choice btn-market-language-choice" data-variant-group="${escapeHtml(group.variantGroupId)}" data-mod-index="${mod._marketIndex}" aria-pressed="${mod === active}" aria-controls="modHubMarketLanguagePanel${mod._marketIndex}" aria-label="${escapeHtml(choiceDetail)}" title="${escapeHtml(choiceDetail)}" ${loading ? 'aria-busy="true"' : ''} ${batchInstallState.running || marketInstallBusy ? 'disabled' : ''}><span data-modhub-card-tag="${escapeHtml(label)}" data-modhub-i18n-ignore>${escapeHtml(displayLabel)}</span><span class="modhub-market-variant-status ${mod._status === 'update_available' ? 'gold' : 'grey'}">${state}</span></button>`);
            return `<div class="modhub-market-variant-row" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${mod._marketIndex}" id="modHubMarketLanguagePanel${mod._marketIndex}" ${mod === active ? '' : 'hidden'}>
                <div class="modhub-market-meta grey"><span>${modHubLabelHtml('作者')}: <span data-modhub-i18n-ignore>${escapeHtml(mod.author || modHubT('未知'))}</span></span>${latest.updateDate ? `<span>${modHubLabelHtml(latest.updateDateSource === 'github' ? '发布' : '更新')}: <span data-modhub-i18n-ignore>${escapeHtml(latest.updateDate)}</span></span>` : ''}${mod._matchedLocal ? `<span data-modhub-i18n-ignore>${escapeHtml(mod._matchedLocal.name)}</span>` : ''}</div>
                <div class="modhub-market-meta modhub-market-versions grey"><span>${modHubLabelHtml('已安装版本')}：<span data-modhub-i18n-ignore>${escapeHtml(mod._matchedLocal?.version || modHubT(mod._matchedLocal ? '未知' : '未安装'))}</span></span><span class="purple">${modHubLabelHtml('最新版本')}：<span data-modhub-i18n-ignore>${escapeHtml(modHubT(latest.text))}</span></span></div>
                ${renderReleaseStatus(mod)}
                ${renderCardDescription(mod, escapeHtml)}
                ${renderOptionalAddonSummary(mod, escapeHtml)}
                ${requirementsHtml}
                <div class="modhub-market-card-footer">${source}${ignore}<div class="modhub-market-actions">${action}<div class="modhub-download-progress" hidden role="status" aria-live="polite"><span class="modhub-download-label grey">等待下载</span><button type="button" class="modhub-download-cancel" data-mod-index="${mod._marketIndex}" hidden>取消下载</button></div></div><div class="modhub-install-check-result" hidden></div></div>
            </div>`;
        }).join('');
        return `<div class="childItem modhub-market-card modhub-market-language-card ${isUpdatable ? 'modhub-market-card-updatable' : ''} ${selected ? 'is-batch-selected' : ''}" data-variant-group="${escapeHtml(group.variantGroupId)}" data-mod-name="${escapeHtml(group.name)}" tabindex="0" aria-label="${escapeHtml(getLocalizedModName(group))}的模组信息">
            <div class="modhub-market-card-header">${selectionHtml}<div class="modhub-market-title-wrap"><span class="modhub-market-title gold" data-modhub-card-field="name" data-modhub-i18n-ignore>${escapeHtml(getLocalizedModName(group))}</span><div class="modhub-market-title-controls"><div class="modhub-market-language-switch" role="group" aria-label="${escapeHtml(modHubT('{name}的安装{kind}', { name: group.name, kind: modHubT(typeText) }))}">${choices.join('')}</div><span class="modhub-market-badge ${installed.length ? 'badge-installed' : 'badge-new'}">${installed.length > 1 ? modHubLabelHtml(editionGroup ? '已安装 {count} 种版本类型' : '已安装 {count} 种语言', { count: installed.length }) : installed.length === 1 ? `${modHubLabelHtml('已安装')} ${modHubLabelHtml(installed[0].variant.label, {})}` : modHubLabelHtml('未安装')}</span></div></div><div class="modhub-market-tags">${renderCardClassificationTags(active, escapeHtml)}${renderCardLanguageTags(group, escapeHtml)}</div></div>
            ${editionGroup ? '<div class="modhub-market-variant-intro grey">各版本分别检查更新。切换时将停用另一版本，保留已安装的包体与存档。</div>' : installed.length > 1 ? '<div class="modhub-market-variant-intro gold">当前同时保留多个语言包。请明确选择要处理的语言；每个包分别检查更新。</div>' : ''}
            <div class="modhub-market-variant-list">${rows}</div>
        </div>`;
    }

    function renderPackageEditionChoices(mod, profiles, escapeHtml, index) {
        const api = window.modHubMarketVariants;
        const editions = api?.normalizePackageEditions(mod.packageEditions) || [];
        if (!editions.length) return { switchHtml: '', introHtml: '' };
        resolveDisplayedInstallMod(mod, profiles);
        const active = editions.find(edition => edition.id === mod._selectedPackageEdition);
        const buttons = editions.map(edition => {
            const local = profiles.find(profile => api.getPackageEdition(mod, profile)?.id === edition.id);
            const version = local?.bootJson?.version || local?.version;
            const state = local ? `${modHubT(modHubComponentDisabled(local.name) ? '已禁用' : '已安装')}${version ? ` ${version}` : ''}` : modHubT('未安装');
            const loading = active?.id === edition.id && mod._updateCheck?.pending;
            return `<button type="button" class="modhub-market-language-choice btn-market-package-edition" data-mod-index="${index}" data-edition="${escapeHtml(edition.id)}" aria-pressed="${active?.id === edition.id}" ${loading ? 'aria-busy="true"' : ''} ${batchInstallState.running || marketInstallBusy ? 'disabled' : ''}><span data-modhub-card-tag="${escapeHtml(edition.label)}" data-modhub-i18n-ignore>${escapeHtml(api.getLabelText(edition.label))}</span><span class="modhub-market-variant-status grey">${escapeHtml(state)}</span></button>`;
        }).join('');
        return { switchHtml: `<div class="modhub-market-language-switch" role="group" aria-label="${escapeHtml(modHubT('{name}的包型', { name: mod.name }))}">${buttons}</div>`,
            introHtml: active ? '' : `<div class="modhub-market-variant-intro grey">请选择要处理的包型。${editions.some(edition => edition.exclusive) ? '切换前会显示安装计划，保留存档。' : '本次选择只决定下载安装的模型，显示类型由美化设置控制。'}</div>` };
    }

    function refreshMarketVariantCard(mod) {
        const container = document.getElementById('modHubMarketCardsContainer');
        if (!container || currentMarketSection !== 'packages') return;
        mod = marketModList.find(member => getMarketModKey(member) === getMarketModKey(mod)) || mod;
        const variant = window.modHubMarketVariants?.normalizeVariant(mod.variant);
        const source = variant ? marketModList.filter(member => member.variant?.groupId === variant.groupId && member.variant?.type === variant.type) : [mod];
        const card = variant ? container.querySelector(`.modhub-market-card[data-variant-group="${variant.groupId}"]`)
            : container.querySelector(`.modhub-market-card[data-mod-index="${marketModList.findIndex(member => getMarketModKey(member) === getMarketModKey(mod))}"]`);
        // 筛选资格可能变化时仍使用完整筛选；普通浏览保持卡片位置与其他卡片状态。
        if (currentStatusFilter !== 'all') { renderMarketCards(); return; }
        if (!card) return;
        if (typeof card.replaceWith !== 'function') { renderMarketCards(); return; }
        const profiles = getLocalInstalledProfiles();
        const members = source.map(member => {
            const status = checkModInstallStatus(member, profiles);
            return { ...member, _status: status, _marketIndex: marketModList.indexOf(member) };
        });
        const product = getDisplayMods(members)[0];
        if (!product) return;
        const template = document.createElement('template');
        template.innerHTML = modHubHtml(renderMarketCard(product, profiles, window.modHubEscapeHtml));
        const replacement = template.content.firstElementChild;
        const scroll = card.scrollTop;
        const focused = card.contains(document.activeElement) ? document.activeElement : null;
        const focusSelector = focused?.classList.contains('btn-market-package-edition') ? `.btn-market-package-edition[data-edition="${focused.dataset.edition}"]`
            : focused?.classList.contains('btn-market-language-choice') ? `.btn-market-language-choice[data-mod-index="${focused.dataset.modIndex}"]` : '';
        card.replaceWith(replacement);
        bindMarketCardEvents(replacement);
        source.forEach(member => {
            const progress = downloadProgressState.get(member.name);
            if (progress) updateDownloadProgress(member.name, progress.percent, progress.text, progress.state, true);
        });
        renderBatchInstallToolbar();
        replacement.scrollTop = scroll;
        if (focusSelector) replacement.querySelector(focusSelector)?.focus({ preventScroll: true });
    }

    async function switchMarketVariant(button, mod, applyChoice, isCurrent) {
        if (batchInstallState.running || marketInstallBusy || button.disabled || button.isConnected === false) return;
        if (isCurrent) { applyChoice(false); return; }
        const card = button.closest('.modhub-market-card') || button.closest('.modhub-market-language-card');
        if (!card) return;
        applyChoice(true);
        card.setAttribute('aria-busy', 'true');
        const controls = [...card.querySelectorAll('.btn-market-language-choice, .btn-market-package-edition, .btn-market-install, .btn-market-update, .btn-market-addons, .modhub-market-select')];
        const disabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        button.setAttribute('aria-busy', 'true');
        try {
            await window.modHubYieldToBrowser();
            if (card.isConnected !== false) refreshMarketVariantCard(mod);
        } finally {
            button.removeAttribute('aria-busy');
            controls.forEach((control, index) => { control.disabled = disabled[index]; });
            card.removeAttribute('aria-busy');
        }
    }

    function renderMarketCard(mod, profiles, escapeHtml) {
        if (mod.isLanguageGroup) return renderLanguageGroupCard(mod, profiles, escapeHtml);
        const modIndex = mod._marketIndex;
        const updateInfo = mod._updateCheck ? getModUpdateInfo(mod, profiles) : { version: mod.version };
        const latestVersionInfo = getLatestMarketVersionInfo(mod);
        const latestVersionText = latestVersionInfo.text;
        const installedBadge = getInstalledMarketBadgeInfo(mod, updateInfo, latestVersionInfo.version);
        const isCommunity = mod.catalogSource === 'community';
        const tagsHtml = [
            renderCardClassificationTags(mod, escapeHtml),
            renderReleaseStatus(mod),
            renderCardLanguageTags(mod, escapeHtml)
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
        const selectionHtml = isBatchInstallEligible(mod, profiles, true)
            ? `<label class="modhub-market-select-label" ${batchInstallState.selecting ? '' : 'hidden'}><input type="checkbox" class="modhub-market-select" data-mod-key="${escapeHtml(getMarketModKey(mod))}" aria-label="选择${escapeHtml(mod.name)}" ${selected ? 'checked' : ''} ${batchInstallState.running ? 'disabled' : ''}>选择</label>`
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
            const releaseSource = mod.autoInstall === false && window.modHubMarketSpells?.normalizeSources(mod).find(source => {
                const url = new URL(source.url);
                return url.protocol === 'https:' && ['github.com', 'www.github.com'].includes(url.hostname) && !url.port
                    && !url.username && !url.password && /^\/[^/]+\/[^/]+\/releases(?:\/tag\/[^/]+)?\/?$/.test(url.pathname);
            });
            actionBtnHtml = releaseSource ? `<a class="macro-button modhub-btn-secondary modhub-market-manual-download" href="${escapeHtml(releaseSource.url)}" target="_blank" rel="noopener noreferrer">${modHubLabelHtml('前往 GitHub 下载（手动）')}</a><span class="grey">${modHubLabelHtml('按作者说明选择安装包；一键安装尚未完成核验。')}</span>` : '';
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
        const isLocalHigher = Boolean(mod._matchedLocal?.version && latestVersionInfo.version && compareVersions(mod._matchedLocal.version, latestVersionInfo.version, mod) > 0);
        const localVerText = mod._matchedLocal && !mod._selectedEditionMismatch
            ? `<span class="${installedBadge.label === '已是最新' ? 'green' : 'gold'}">${modHubLabelHtml('已安装版本')}：<span data-modhub-i18n-ignore>${escapeHtml(mod._matchedLocal.version
                ? installedVersionText : modHubT('未知'))}</span></span>` : '';

        const ignoreActionsHtml = isUpdatable
            ? `<div class="modhub-market-ignore-actions">
                <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="once" title="仅忽略 ${escapeHtml(formatVersionDisplay(updateInfo.version))}，更高版本仍会提醒">忽略本次</button>
                <button type="button" class="btn-market-ignore" data-mod-index="${modIndex}" data-ignore-mode="always" title="以后不再提示此模组更新">永久忽略</button>
               </div>`
            : (isIgnored && currentStatusFilter === 'ignored'
                ? `<div class="modhub-market-ignore-actions"><button type="button" class="btn-market-unignore" data-mod-index="${modIndex}">取消忽略</button></div>`
                : '');

        const editionChoices = renderPackageEditionChoices(mod, profiles, escapeHtml, modIndex);
        return `
            <div class="childItem modhub-market-card ${isUpdatable ? 'modhub-market-card-updatable' : ''} ${selected ? 'is-batch-selected' : ''} ${batchInstallState.selecting && selectionHtml ? 'is-batch-selectable' : ''}" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${modIndex}" tabindex="0" aria-label="${escapeHtml(getLocalizedModName(mod))}的模组信息">
                <div class="modhub-market-card-header">
                    ${selectionHtml}
                    <div class="modhub-market-title-wrap">
                        <span class="modhub-market-title gold" data-modhub-card-field="name" data-modhub-i18n-ignore>${escapeHtml(getLocalizedModName(mod))}</span>
                        <div class="modhub-market-title-controls">${editionChoices.switchHtml}${badgeHtml}</div>
                    </div>
                    <div class="modhub-market-tags">${tagsHtml}</div>
                </div>
                ${editionChoices.introHtml}
                <div class="modhub-market-meta grey">
                    <span>${modHubLabelHtml('作者')}: <span data-modhub-i18n-ignore>${escapeHtml(mod.author || modHubT('未知'))}</span></span>
                    ${latestVersionInfo.updateDate ? `<span>${modHubLabelHtml(latestVersionInfo.updateDateSource === 'github' ? '发布' : '更新')}: <span data-modhub-i18n-ignore>${escapeHtml(latestVersionInfo.updateDate)}</span></span>` : ''}
                </div>
                <div class="modhub-market-meta modhub-market-versions grey">
                    ${localVerText}
                    <span class="purple">${modHubLabelHtml('最新版本')}：<span data-modhub-i18n-ignore>${escapeHtml(modHubT(latestVersionText))}</span></span>
                </div>
                ${installedStatusDetail || updateInfo.error ? `<div class="modhub-market-meta grey">${escapeHtml(installedStatusDetail || `更新检查失败：${updateInfo.error}。可刷新市场后重试。`)}</div>` : ''}
                ${renderCardDescription(mod, escapeHtml)}
                ${renderOptionalAddonSummary(mod, escapeHtml)}
                <div class="modhub-market-card-footer">
                    ${acquisitionDetailsHtml}
                    ${ignoreActionsHtml}
                    ${actionBtnHtml ? `<div class="modhub-market-actions">${actionBtnHtml}<div class="modhub-download-progress" hidden role="status" aria-live="polite"><span class="modhub-download-label grey">等待下载</span><button type="button" class="modhub-download-cancel" data-mod-index="${modIndex}" hidden>取消下载</button></div></div>` : ''}
                    <div class="modhub-install-check-result" hidden></div>
                </div>
            </div>
        `;
    }

    function renderMarketCards() {
        const container = document.getElementById('modHubMarketCardsContainer');
        if (!container) return;

        const profiles = getLocalInstalledProfiles();
        const evaluatedMods = marketModList.map((mod, index) => {
            const status = checkModInstallStatus(mod, profiles);
            return { ...mod, _status: status, _marketIndex: index };
        });
        const filtered = filterAndSortMods(profiles, evaluatedMods);

        // 本轮筛选、统计和卡片共用同一份已核对状态，不跨渲染保留身份结果。
        let updatableCount = 0;
        const updatableList = [];
        const updatableIndexes = new Set();

        const activeMods = evaluatedMods.filter(isMarketSourceVisible);
        activeMods.forEach(m => {
            const updateMod = installedUpdateTarget(m, profiles);
            const st = updateMod === m ? m._status : checkModInstallStatus(updateMod, profiles);
            if (st === 'update_available') {
                updatableCount++;
                updatableIndexes.add(m._marketIndex);
                updatableList.push({
                    marketMod: updateMod,
                    localProfile: updateMod._matchedLocal,
                    newVersion: getModUpdateInfo(updateMod).version,
                    currentVersion: updateMod._matchedLocal?.version || ''
                });
            }
        });

        const allDisplayStats = getDisplayMods(activeMods, true);
        const displayStats = allDisplayStats.filter(matchesContentLanguage);
        const statMembers = entry => getDisplayModMembers(entry, activeMods);
        const displayedMods = getFilteredDisplayMods(filtered, profiles, evaluatedMods);
        renderStatsHeader(displayStats.filter(entry => statMembers(entry).some(mod => mod._matchedLocal)).length,
            displayStats.filter(entry => statMembers(entry).some(mod => updatableIndexes.has(mod._marketIndex))).length, displayStats.length,
            allDisplayStats.filter(entry => statMembers(entry).some(mod => updatableIndexes.has(mod._marketIndex))).length);
        renderBatchInstallToolbar(profiles, evaluatedMods);
        const filterResult = document.getElementById('modHubMarketFilterResult');
        if (filterResult) {
            filterResult.hidden = currentCategory === 'all' && currentStatusFilter === 'all' && !currentSearchText;
            modHubText(filterResult, `当前显示 ${displayedMods.length} / 共 ${displayStats.length} 个模组`);
        }

        // 同步通知外部模组管理环境看板与 Tab 徽标
        if (typeof window.modHubNotifyUpdateState === 'function') {
            window.modHubNotifyUpdateState(updatableCount, updatableList);
        }

        const spellView = currentMarketSection === 'spells';
        renderMarketSections();
        const batchToolbar = document.getElementById('modHubMarketBatchToolbar');
        if (batchToolbar) batchToolbar.hidden = spellView;
        const mirrorSelect = document.getElementById('modHubMirrorSelect');
        if (mirrorSelect) mirrorSelect.disabled = spellView || batchInstallState.running || batchInstallState.preparing;
        if (spellView) {
            if (window.modHubMarketSpells) window.modHubMarketSpells.render(container, { search: currentSearchText, sort: currentSortBy });
            else container.innerHTML = modHubHtml('<div class="modhub-empty-state grey">言灵资料模块尚未就绪。请重新载入游戏后重试。</div>');
            updateToolbarResetBtn();
            return;
        }

        if (!filtered.length) {
            container.innerHTML = modHubHtml(`
                <div class="modhub-empty-state grey">
                    未找到匹配的模组。您可以清除筛选或刷新市场数据。
                    <br><br>
                    <button type="button" class="macro-button modhub-btn-primary" onclick="window.modHubMarket.resetFilters()">返回查看全部模组</button>
                </div>
            `);
            updateToolbarResetBtn();
            return;
        }

        const escapeHtml = window.modHubEscapeHtml || (value => String(value ?? '').replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]));

        const html = displayedMods.map(mod => renderMarketCard(mod, profiles, escapeHtml)).join('');

        container.innerHTML = modHubHtml(html);
        downloadProgressState.forEach((progress, name) => updateDownloadProgress(name, progress.percent, progress.text, progress.state, true));

        bindMarketCardEvents(container);

        renderBatchInstallToolbar(profiles, evaluatedMods);
        updateToolbarResetBtn();
        syncMarketLoadingControls();
    }

    function bindMarketCardEvents(container) {
        container.querySelectorAll('.btn-market-addons').forEach(button => {
            button.onclick = async () => {
                const mod = marketModList[Number(button.dataset.modIndex)];
                if (!mod || !getOptionalAddonMods(mod).length) return;
                if (!window.modHubMarketInstaller?.installAddons) {
                    await window.modHubAlert('附加内容选择模块尚未就绪，请重新载入游戏后重试。', '无法选择附加内容');
                    return;
                }
                return runMarketInstallTask(context => window.modHubMarketInstaller.installAddons(mod, { restoreContext: context }));
            };
        });
        // 绑定卡片内按钮事件
        container.querySelectorAll('.modhub-market-select').forEach(input => {
            input.onchange = () => setBatchModSelected(input.dataset.modKey, input.checked);
            const card = input.closest('.modhub-market-card');
            if (card) card.onclick = event => {
                if (!batchInstallState.selecting || input.disabled || batchInstallState.running || event.target.closest('a, button, input, label, select, textarea, summary, [role="button"], [contenteditable]')) return;
                if (String(window.getSelection?.() || '')) return;
                input.click();
            };
        });
        container.querySelectorAll('.btn-market-install, .btn-market-update').forEach(btn => {
            btn.onclick = async () => {
                if (batchInstallState.selecting || batchInstallState.running || btn.disabled) return;
                const targetMod = marketModList[Number(btn.dataset.modIndex)];
                if (targetMod) {
                    await promptDownloadMirrorAndInstall(targetMod);
                }
            };
        });
        container.querySelectorAll('.btn-market-package-edition').forEach(btn => {
            btn.onclick = async () => {
                const mod = marketModList[Number(btn.dataset.modIndex)];
                if (!mod || !window.modHubMarketVariants?.normalizePackageEditions(mod.packageEditions).some(edition => edition.id === btn.dataset.edition)) return;
                return switchMarketVariant(btn, mod, changed => {
                    if (changed) batchInstallState.selected.delete(getMarketModKey(mod));
                    mod._selectedPackageEdition = btn.dataset.edition;
                    selectedMarketPackageEditions.set(getMarketModKey(mod), btn.dataset.edition);
                }, mod._selectedPackageEdition === btn.dataset.edition);
            };
        });
        container.querySelectorAll('.btn-market-language-choice').forEach(btn => {
            btn.onclick = async () => {
                const group = getDisplayMods().find(entry => entry.isLanguageGroup && entry.variantGroupId === btn.dataset.variantGroup);
                const member = marketModList[Number(btn.dataset.modIndex)];
                const card = btn.closest('.modhub-market-language-card');
                if (!member || !group?.variants.includes(member) || !card) return;
                return switchMarketVariant(btn, member, changed => {
                    if (changed) batchInstallState.selected.delete(getMarketModKey(group));
                    selectedMarketLanguages.set(group.variantGroupId, getMarketModKey(member));
                    card.querySelectorAll('.btn-market-language-choice').forEach(choice => choice.setAttribute('aria-pressed', String(choice === btn)));
                    card.querySelectorAll('.modhub-market-variant-row').forEach(row => { row.hidden = row.dataset.modIndex !== btn.dataset.modIndex; });
                }, getMarketModKey(resolveDisplayedInstallMod(group)) === getMarketModKey(member));
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

    }

    /** 弹窗开始下载 */
    async function promptDownloadMirrorAndInstall(mod) {
        const started = !marketViewLoading && !marketInstallBusy && Boolean(mod?.name);
        if (started) {
            resetDownloadProgress(mod.name);
            updateDownloadProgress(mod.name, null, '正在准备版本选择，请稍候。', 'preparing');
        }
        try { return await runMarketInstallTask(context => promptDownloadMirrorAndInstallUnlocked(mod, context)); }
        finally { if (started) window.modHubClearMarketPreparationProgress(mod.name); }
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
        const trustedMessageHtml = releaseInfo
            ? `${dependencyHtml}${formatReleaseInstallPlanHtml(releaseInfo, selectedMirror, historicalCompanions.length)}`
            : (dependencyHtml ? `${dependencyHtml}<div class="modhub-install-summary"><div class="modhub-install-overview"><strong>目标模组需手动下载</strong></div><p style="margin:8px 0 0; color:var(--300,#bbb); font-size:0.9em;">处理完上述勾选的前置依赖后，将自动为您打开【${window.modHubEscapeHtml(mod.name)}】的下载页面。</p></div>` : '');
        const initialActionCount = plan.actions.length;
        const initialConfirmText = manualAssetOptions.length
            ? '安装所选包'
            : (initialActionCount
                ? (externalOnly ? `一并处理（${initialActionCount}项依赖）` : `一键安装（含 ${initialActionCount} 项依赖）`)
                : (externalOnly ? '打开下载页面' : '开始安装'));

        const choice = await window.modHubConfirm({
            title: externalOnly ? `处理【${mod.name}】的前置依赖` : `下载并安装【${mod.name}】`,
            message: actionLines.length
                ? `检测到以下必需依赖需要一并处理：\n\n${actionLines.join('\n')}\n\n${externalOnly ? '处理完成后将打开目标模组的外部下载页面。' : `${installPlanText}\n\n将按依赖顺序处理，并在最后安装【${mod.name}】。`}`
                : (externalOnly ? `${dependencyLines.join('\n')}\n\n${installPlanText}\n\n是否打开作者下载页面？` : `${installPlanText}\n\n${selectedMirror.browserOnly ? '以上文件将由浏览器下载后手动导入。' : '以上文件将自动注册到 ModLoader 旁加载中。'}\n\n下载线路：${modHubT(selectedMirror.name)}\n\n是否立即开始下载并安装？`),
            trustedMessageHtml,
            dialogClass: 'modhub-install-dialog',
            confirmText: initialConfirmText,
            cancelText: '取消',
            confirmType: 'primary',
            selectLabel: manualAssetOptions.length ? '主安装包选择' : (companionOptions.length ? '历史美术包选择' : undefined),
            selectOptions,
            selectValue: manualAssetOptions.length ? '' : (companionOptions.length ? 'none' : undefined),
            requireSelection: manualAssetOptions.length > 0,
            onRender: (dialog) => {
                const dependencyArea = dialog.querySelector('#modHubInstallDependencyArea');
                const confirmBtn = dialog.querySelector('.modhub-modal-btn-confirm');
                const updateDepUi = () => {
                    const activeActions = getActivePlan().actions;
                    if (dependencyArea) dependencyArea.innerHTML = modHubHtml(formatDependencyListHtml(plan));
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
                                modHubText(status, status.dataset.skipText || '跳过处理');
                                status.className = 'modhub-dep-status grey';
                            }
                        }
                        checkbox.addEventListener('change', () => {
                            if (checkbox.checked) skippedDependencyKeys.delete(key);
                            else skippedDependencyKeys.add(key);
                            updateDepUi();
                        });
                    });
                    if (confirmBtn && !manualAssetOptions.length) {
                        modHubText(confirmBtn, activeActions.length
                            ? (externalOnly ? `一并处理（${activeActions.length}项依赖）` : `一键安装（含 ${activeActions.length} 项依赖）`)
                            : (externalOnly ? '直接打开下载页面' : '开始安装'));
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
            if (isWithdrawn(mod) || isWithdrawn(action.mod)) {
                await window.modHubAlert('该来源已停止市场支持，请使用模组管理处理已安装包', '自动安装已停止');
                return false;
            }
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
        return ['all', 'installed', 'updatable', 'installable', 'ignored'].includes(statusFilter);
    }

    function syncMarketSearchClearButton() {
        const button = document.getElementById('modHubMarketSearchClear');
        if (button) button.hidden = !document.getElementById('modHubMarketSearch')?.value;
    }

    /** 两个板块保留各自搜索；模组状态和分类不参与言灵筛选。 */
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
            const sortSelect = document.getElementById('modHubSortSelect');
            if (sortSelect) sortSelect.value = currentSortBy;
        }
        syncMarketSearchClearButton();
        if (render) {
            renderCategoryFilters();
            renderMarketCards();
        }
        return true;
    }

    function renderMarketSections() {
        const spellView = currentMarketSection === 'spells';
        document.getElementById('modHubMarketStats')?.querySelectorAll('button').forEach(button => {
            button.disabled = batchInstallState.running || batchInstallState.preparing || marketInstallBusy
                || marketViewLoading && button.classList.contains('modhub-market-update-all');
        });
        const sectionButtons = document.getElementById('modHubMarketSections');
        if (sectionButtons) {
            const focusedSection = sectionButtons.contains?.(document.activeElement) ? document.activeElement?.dataset?.section : '';
            const counts = { packages: getDisplayMods().length,
                spells: window.modHubMarketSpells?.getSpells().filter(matchesContentLanguage).length || 0 };
            sectionButtons.innerHTML = modHubHtml([['packages', 'MOD 与美化'], ['spells', '言灵']].map(([section, label]) =>
                `<button type="button" class="macro-button modhub-market-section-button ${currentMarketSection === section ? 'is-selected' : ''}" data-section="${section}" aria-pressed="${currentMarketSection === section}" aria-controls="modHubMarketCardsContainer" ${batchInstallState.running || marketInstallBusy ? 'disabled' : ''}>${label}（${counts[section]}）</button>`).join(''));
            sectionButtons.querySelectorAll('.modhub-market-section-button').forEach(button => {
                button.onclick = () => selectMarketSection(button.dataset.section);
                if (focusedSection === button.dataset.section && !button.disabled) button.focus();
            });
        }
        ['modHubMarketStats', 'modHubMarketMirrorField', 'modHubMarketSource', 'modHubMarketBatchToolbar'].forEach(id => {
            const control = document.getElementById(id);
            if (control) control.hidden = spellView;
        });
        const footer = document.getElementById('modHubMarketFilterFooter');
        if (footer) footer.hidden = spellView && !currentSearchText;
        const result = document.getElementById('modHubMarketFilterResult');
        if (spellView && result) result.hidden = true;
        const note = document.getElementById('modHubMarketSpellNote');
        if (note) note.hidden = !spellView;
        ['modHubMarketBtnSubmit', 'modHubMarketBtnSubmitPinned'].forEach(id => {
            const submit = document.getElementById(id);
            const submitLabel = submit?.querySelector('span') || submit;
            if (submitLabel) modHubText(submitLabel, spellView ? '投稿候选言灵' : '申请上架 / 推荐模组');
        });
        const submitPin = document.querySelector('[data-modhub-market-pin="modHubMarketBtnSubmit"]');
        if (submitPin) updateMarketToolPin(submitPin);
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) {
            searchInput.placeholder = spellView ? '搜索言灵名称、正文或拼音' : '搜索名称、作者、拼音或首字母';
            searchInput.title = '支持多词搜索、拼音全拼、首字母和少量拼写误差；有搜索词时，默认按相关程度优先显示。';
            searchInput.setAttribute('aria-label', spellView ? '搜索言灵' : '搜索 MOD 与美化');
            window.modHubLocalizeOwned?.(searchInput);
        }
        syncMarketSearchClearButton();
        const sortSelect = document.getElementById('modHubSortSelect');
        if (sortSelect?.options) {
            Array.from(sortSelect.options).forEach(option => {
                if (option.value === 'name') modHubText(option, spellView ? '按言灵名称' : '按模组名称');
            });
        }
    }

    const MODHUB_MARKET_REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.8L21 8M21 3v5h-5"/></svg>';
    const MODHUB_MARKET_TOOLS = [
        { id: 'modHubMarketBtnSubmit', label: '申请上架 / 推荐模组', action: () => openCommunitySubmission(currentMarketSection === 'spells' ? 'spell' : 'new') },
        { id: 'modHubMarketBtnMy', label: '我的投稿', action: () => openCommunitySubmission('my') },
        { id: 'modHubMarketBtnFeedback', label: '纠错与下架申请', action: () => openCommunityFeedback() }
    ];

    function readPinnedMarketTools() {
        try {
            const stored = JSON.parse(localStorage.getItem('modhub_market_pinned_tools') ?? '["modHubMarketBtnSubmit"]');
            return Array.isArray(stored) ? [...new Set(stored)].filter(id => MODHUB_MARKET_TOOLS.some(tool => tool.id === id)) : [];
        } catch (_) { return []; }
    }

    function marketToolLabel(tool) {
        return tool.id === 'modHubMarketBtnSubmit' && currentMarketSection === 'spells' ? '投稿候选言灵' : tool.label;
    }

    function marketToolHtml(tool, pinned = false) {
        return `<button id="${tool.id}${pinned ? 'Pinned' : ''}" data-modhub-market-tool="${tool.id}" type="button" class="macro-button ${tool.id === 'modHubMarketBtnSubmit' ? 'modhub-btn-primary modhub-submit-link' : 'modhub-btn-secondary'}"><span>${marketToolLabel(tool)}</span></button>`;
    }

    function updateMarketToolPin(button) {
        const tool = MODHUB_MARKET_TOOLS.find(tool => tool.id === button.dataset.modhubMarketPin);
        if (!tool) return;
        const active = readPinnedMarketTools().includes(tool.id);
        const label = `${active ? '取消固定' : '固定'}${marketToolLabel(tool)}${active ? '' : '到操作栏'}`;
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        window.modHubLocalizeOwned?.(button);
    }

    function renderPinnedMarketTools() {
        const container = document.getElementById('modHubMarketPinnedTools');
        if (container) container.innerHTML = modHubHtml(readPinnedMarketTools().map(id => marketToolHtml(MODHUB_MARKET_TOOLS.find(tool => tool.id === id), true)).join(''));
        document.querySelectorAll('[data-modhub-market-tool]').forEach(button => {
            button.onclick = () => {
                if (button.disabled || batchInstallState.running || batchInstallState.preparing) return;
                const more = document.getElementById('modHubMarketMore');
                if (more) more.open = false;
                return MODHUB_MARKET_TOOLS.find(tool => tool.id === button.dataset.modhubMarketTool)?.action();
            };
        });
        document.querySelectorAll('.modhub-market-tool-pin').forEach(button => {
            updateMarketToolPin(button);
            button.onclick = () => {
                if (button.disabled || batchInstallState.running || batchInstallState.preparing) return;
                const id = button.dataset.modhubMarketPin;
                if (!MODHUB_MARKET_TOOLS.some(tool => tool.id === id)) return;
                const pinned = readPinnedMarketTools();
                const next = pinned.includes(id) ? pinned.filter(value => value !== id) : [...pinned, id];
                try { localStorage.setItem('modhub_market_pinned_tools', JSON.stringify(next)); }
                catch (_) { window.modHubShowToast('无法保存固定工具设置，请检查浏览器存储权限。', 'warning'); return; }
                renderPinnedMarketTools();
                renderBatchInstallToolbar();
                const more = document.getElementById('modHubMarketMore');
                if (more) { more.open = false; more.querySelector('summary')?.focus(); }
            };
        });
    }

    // 根据实际滚动视口预留底部操作空间，较矮窗口只滚动面板内容。
    function fitMarketMorePanel() {
        const more = document.getElementById('modHubMarketMore');
        if (!more?.open) return;
        const panel = more.querySelector('.modhub-market-more-content');
        if (!panel) return;
        const viewport = window.visualViewport;
        const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        const overlay = more.closest('#customOverlayContent');
        const available = Math.min(bottom, overlay?.getBoundingClientRect().bottom ?? bottom)
            - panel.getBoundingClientRect().top - 60;
        panel.style.setProperty('--modhub-market-more-space', `${Math.max(80, available)}px`);
    }

    window.addEventListener('resize', fitMarketMorePanel);
    window.visualViewport?.addEventListener('resize', fitMarketMorePanel);
    document.addEventListener('scroll', fitMarketMorePanel, true);
    document.addEventListener('pointerdown', event => {
        const more = document.getElementById('modHubMarketMore');
        if (more?.open && !more.contains(event.target)) more.open = false;
    }, true);
    document.addEventListener('keydown', event => {
        const more = document.getElementById('modHubMarketMore');
        if (event.key === 'Escape' && more?.open) {
            event.preventDefault();
            more.open = false;
            more.querySelector('summary')?.focus();
        }
    });

    function renderCategoryFilters() {
        const container = document.getElementById('modHubCategoryCapsules');
        if (!container) return;
        const showCategories = currentMarketSection === 'packages' && shouldShowCategoryFilters(currentStatusFilter);
        container.style.display = showCategories ? '' : 'none';
        if (!showCategories) return;
        const counts = new Map();
        const visibleMods = getDisplayMods();
        visibleMods.forEach(entry => {
            const members = getDisplayModMembers(entry);
            new Set(members.map(mod => mod.category || '待分类')).forEach(category =>
                counts.set(category, (counts.get(category) || 0) + 1));
        });
        const categories = [
            ...MARKET_CATEGORIES.filter(category => counts.has(category)),
            ...[...counts.keys()].filter(category => !MARKET_CATEGORIES.includes(category)).sort((a, b) => a.localeCompare(b))
        ];
        if (currentCategory !== 'all' && !counts.has(currentCategory)) currentCategory = 'all';
        const escapeHtml = window.modHubEscapeHtml || (value => value);
        container.innerHTML = modHubHtml([
            `<option value="all">全部分类（${visibleMods.length}）</option>`,
            ...categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}（${counts.get(category)}）</option>`)
        ].join(''));
        container.value = currentCategory;
        container.onchange = () => {
            currentCategory = container.value || 'all';
            renderCategoryFilters();
            renderMarketCards();
        };
    }

    /** 初始化模组市场主入口 */
    window.modHubInitMarket = async function(forceRefresh = false, contentOnly = false) {
        const root = document.getElementById('modHubModMarketContainer');
        if (!root) return;
        const previousSearchInput = document.getElementById('modHubMarketSearch');
        if (previousSearchInput && root.contains?.(previousSearchInput)) currentSearchText = previousSearchInput.value.trim();
        clearTimeout(marketSearchTimer);
        const state = window._modHubModState;
        const reuseLocal = contentOnly && !forceRefresh && !marketViewLoading && marketDataLoaded && !marketDataRequest
            && state && state === localProfileState && getLocalProfileStamp() === localProfileStamp
            && !window._modHubOrphanRepairRequest;
        const revision = ++marketViewRevision;
        const current = () => revision === marketViewRevision && document.getElementById('modHubModMarketContainer') === root;
        retryFailedModUpdateChecks(root);
        marketViewLoading = !reuseLocal;

        root.innerHTML = modHubHtml(`
            <div class="modhub-market-heading">
                <div id="modHubMarketSections" class="modhub-market-sections" role="group" aria-label="市场内容板块"></div>
            </div>
            <div id="modHubMarketStats" class="modhub-market-summary" role="group" aria-label="按安装状态筛选模组"></div>
            <p id="modHubMarketSpellNote" class="modhub-market-section-note grey" hidden>言灵按原文展示和复制。请按使用说明在对应位置使用；市场不执行言灵，也不会将其安装为模组。</p>

            <!-- ===== 搜索与筛选工具栏 ===== -->
            <div class="modhub-market-toolbar">
                <div class="modhub-market-tools">
                    <div class="modhub-market-search-row">
                        <div class="modhub-market-search-field">
                        <input
                            id="modHubMarketSearch"
                            class="modhub-search-input"
                            type="search"
                            placeholder="搜索名称、作者、拼音或首字母"
                            value="${window.modHubEscapeHtml(currentSearchText)}"
                        />
                        <button id="modHubMarketSearchClear" type="button" aria-label="清空搜索输入" title="清空搜索输入" data-modhub-i18n-aria-label="清空搜索输入" data-modhub-i18n-title="清空搜索输入" ${currentSearchText ? '' : 'hidden'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
                        </div>
                        <button id="modHubMarketBtnRefresh" type="button" class="macro-button modhub-btn-secondary" aria-label="刷新市场" title="刷新市场，重新获取最新模组目录">${MODHUB_MARKET_REFRESH_ICON}</button>
                    </div>
                </div>

                <div class="modhub-market-filter-row">
                    <select id="modHubCategoryCapsules" class="modhub-select" aria-label="模组分类">
                        <option value="all">全部分类</option>
                    </select>
                    <select id="modHubSortSelect" class="modhub-select" aria-label="排列方式">
                        <option value="date" ${currentSortBy === 'date' ? 'selected' : ''}>按最新更新</option>
                        <option value="name" ${currentSortBy === 'name' ? 'selected' : ''}>按模组名称</option>
                    </select>
                    <div id="modHubMarketHeaderActions" class="modhub-market-header-actions">
                    <div id="modHubMarketPinnedTools" class="modhub-market-pinned-tools"></div>
                    <div id="modHubMarketMainActions" class="modhub-market-main-actions">
                    <div id="modHubMarketBatchToolbar" class="modhub-market-batch-toolbar" role="group" aria-label="模组多选安装" ${currentMarketSection === 'spells' ? 'hidden' : ''}></div>
                    <details id="modHubMarketMore" class="modhub-market-more">
                        <summary>更多</summary>
                        <div class="modhub-market-more-content">
                            <div class="modhub-market-community-tools" role="group" aria-labelledby="modHubMarketCommunityTitle">
                                <div id="modHubMarketCommunityTitle" class="modhub-market-group-title">投稿与反馈</div>
                                ${MODHUB_MARKET_TOOLS.map(tool => `<div class="modhub-market-tool-row">${marketToolHtml(tool)}<button type="button" class="modhub-market-tool-pin" data-modhub-market-pin="${tool.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3h8M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v6"/></svg></button></div>`).join('')}
                            </div>
                            <label id="modHubMarketMirrorField">下载方式
                                <select id="modHubMirrorSelect" class="modhub-select" title="选择下载方式" aria-describedby="modHubMirrorHint">
                                    ${MIRROR_SERVERS.map(m => `<option value="${m.id}" ${currentMirrorId === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
                                </select>
                                <span id="modHubMirrorHint" class="modhub-market-route-hint grey" role="note" aria-live="polite">${modHubLabelHtml(resolveMirrorServer(currentMirrorId).description || '通过所选镜像下载，支持一键安装；连接失败时自动尝试其他方式。')}</span>
                            </label>
                            <div id="modHubMarketSource" class="modhub-market-source grey" role="note">
                                <span class="modhub-market-source-label">模组资料来源：</span>
                                <span class="modhub-market-source-detail">${modHubLabelHtml('目录资料来源包括中文 Wiki、作者 GitHub 发布、Discord 社区及百度贴吧。请通过各条目的来源链接核对作者说明。')} <a href="https://degreesoflewditycn.miraheze.org/wiki/%E6%A8%A1%E7%BB%84%E5%88%97%E8%A1%A8" target="_blank" rel="noopener" data-modhub-i18n-key="DOL 中文社区 Wiki「模组列表」">${modHubT('DOL 中文社区 Wiki「模组列表」')}</a> · <a href="https://discord.com/channels/1103864219620884560/1197809298902896731" target="_blank" rel="noopener" data-modhub-i18n-key="Discord 模组论坛">${modHubT('Discord 模组论坛')}</a></span>
                            </div>
                        </div>
                    </details>
                    </div>
                    </div>
                </div>
                <div id="modHubMarketFilterFooter" class="modhub-market-filter-footer">
                    <span id="modHubMarketFilterResult" class="grey" role="status" aria-live="polite" hidden></span>
                    <button id="modHubMarketBtnResetFilter" type="button" class="modhub-market-text-action" onclick="window.modHubMarket.resetFilters()" title="清除当前所有筛选与搜索，查看全部模组" style="display:none;">返回全部模组</button>
                </div>
            </div>

            <p id="modHubMarketLoadStatus" class="grey" role="status" aria-live="polite" hidden>${window.modHubProgressRingHtml()}<span>正在加载，请稍后</span></p>

            <!-- ===== 模组卡片列表容器 ===== -->
            <div id="modHubMarketCardsContainer" class="modhub-market-grid">
                ${window.modHubLoadingHtml('正在拉取模组市场数据，请稍候……')}
            </div>
        `);
        renderPinnedMarketTools();
        renderMarketSections();
        renderBatchInstallToolbar();
        // 上次成功目录仅用于先浏览，本轮联网及本地核验完成前不能安装。
        try {
            if (!marketDataLoaded && !marketModList.length) {
                const cached = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
                if (Array.isArray(cached)) {
                    const identities = readLocalCache(IDENTITY_CACHE_KEY, WIKI_CACHE_TTL, true);
                    if (identities) applyIdentityCatalog(identities, false);
                    marketModList = protectCachedIdentityMetadata(normalizeReleaseIndex({ schemaVersion: 1, mods: cached }), identities);
                    window.modHubMarketSpells?.restoreCache(withdrawnRevision);
                }
            }
        } catch (error) {
            console.warn('[ModHub] 缓存目录无法预览，继续获取在线目录', error);
        }
        if (marketDataLoaded || marketModList.length) {
            renderCategoryFilters();
            renderMarketCards();
        }

        const refreshView = async (force, repairOrphans = false) => {
            marketViewLoading = true;
            syncMarketLoadingControls();
            let localReady = false, catalogReady = false, catalogError;
            const catalog = loadMarketData(force).then(() => {
                catalogReady = true;
                if (current() && !localReady) {
                    renderCategoryFilters();
                    renderMarketCards();
                }
            }).catch(error => { catalogError = error; });
            const local = (async () => {
                if (repairOrphans && !window._modHubOrphanRepairDone && typeof window.modHubRepairOrphanModZips === 'function') {
                    window._modHubOrphanRepairDone = true;
                    window._modHubOrphanRepairRequest = (async () => {
                        const repair = await window.modHubRepairOrphanModZips();
                        if (repair?.repaired?.length && typeof window.modHubLoadModManageState === 'function') {
                            await window.modHubLoadModManageState(true);
                        }
                    })().finally(() => { window._modHubOrphanRepairRequest = null; });
                }
                if (window._modHubOrphanRepairRequest) await window._modHubOrphanRepairRequest;
                if (!current()) return;
                if (typeof window.modHubLoadModManageState === 'function') await window.modHubLoadModManageState();
                if (current()) await loadLocalPackageProfiles(force, current);
            })().catch(error => {
                console.warn('[ModHub] 本地模组资料核对未完成，安装前将重新核验', error);
            }).finally(() => { localReady = true; });
            await Promise.all([catalog, local]);
            if (revision === marketViewRevision) marketViewLoading = false;
            if (!current()) return false;
            renderCategoryFilters();
            renderMarketCards();
            if (!catalogReady) throw catalogError;
            return true;
        };

        // 绑定搜索与筛选事件
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) {
            searchInput.oninput = () => {
                clearTimeout(marketSearchTimer);
                syncMarketSearchClearButton();
                marketSearchTimer = setTimeout(() => {
                    if (!current()) return;
                    currentSearchText = searchInput.value.trim();
                    renderMarketCards();
                }, 200);
            };
        }
        const clearSearchButton = document.getElementById('modHubMarketSearchClear');
        if (clearSearchButton) {
            clearSearchButton.onclick = () => {
                if (!current()) return;
                clearTimeout(marketSearchTimer);
                currentSearchText = '';
                if (searchInput) searchInput.value = '';
                syncMarketSearchClearButton();
                renderMarketCards();
                searchInput?.focus();
            };
        }

        const refreshBtn = document.getElementById('modHubMarketBtnRefresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                if (batchInstallState.running || marketViewLoading) return;
                refreshBtn.disabled = true;
                refreshBtn.setAttribute('aria-busy', 'true');
                refreshBtn.innerHTML = modHubHtml(window.modHubProgressRingHtml());
                window.modHubShowToast('正在获取最新模组目录...', 'info');
                try {
                    if (!await refreshView(true)) return;
                    window.modHubShowToast(`刷新成功，已载入 ${getDisplayMods().length} 个模组、${window.modHubMarketSpells?.getSpells().length || 0} 个言灵配方`, 'success');
                } catch (e) {
                    if (current()) window.modHubShowToast(`刷新失败: ${e.message}`, 'warning');
                } finally {
                    refreshBtn.removeAttribute('aria-busy');
                    refreshBtn.disabled = batchInstallState.running;
                    refreshBtn.innerHTML = modHubHtml(MODHUB_MARKET_REFRESH_ICON);
                }
            };
        }

        const more = document.getElementById('modHubMarketMore');
        if (more) more.ontoggle = fitMarketMorePanel;

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

        try {
            if (reuseLocal) return;
            await refreshView(forceRefresh, true);
        } catch (err) {
            if (!current()) return;
            if (marketModList.length) {
                window.modHubShowToast(`市场资料更新失败: ${err.message || String(err)}`, 'warning');
                return;
            }
            const cardsContainer = document.getElementById('modHubMarketCardsContainer');
            if (cardsContainer) {
                cardsContainer.innerHTML = modHubHtml(`
                    <div class="modhub-empty-state red">
                        加载模组市场数据失败: ${window.modHubEscapeHtml(err.message || String(err))}
                        <br><br>
                        <button type="button" class="macro-button modhub-btn-primary" onclick="window.modHubInitMarket()">重新尝试加载</button>
                    </div>
                `);
            }
        }
    };

    /** 获取所有有新版本可更新的模组列表（优先读内存，次选读 localStorage 缓存） */
    function getUpdatableMods() {
        retryFailedModUpdateChecks(document.getElementById('modHubModManageContainer'));
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
        for (const entry of list) {
            const mod = installedUpdateTarget(entry, profiles);
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
        modHubText(btn, spellView ? '清除搜索' : '返回全部模组');
        btn.title = spellView ? '清除搜索，查看全部言灵' : '清除当前所有筛选与搜索，查看全部模组';
        window.modHubLocalizeOwned?.(btn);
        btn.style.display = isFiltering ? 'inline-block' : 'none';
    }

    /** 重置分类、状态与搜索。 */
    function resetFilters() {
        clearTimeout(marketSearchTimer);
        currentCategory = 'all';
        currentStatusFilter = 'all';
        currentSearchText = '';
        const searchInput = document.getElementById('modHubMarketSearch');
        if (searchInput) searchInput.value = '';
        syncMarketSearchClearButton();
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
        if (typeof window.modHubShowToast === 'function') {
            window.modHubShowToast(currentMarketSection === 'spells' ? '已清除搜索并展示全部言灵' : '已返回并展示全部模组', 'info');
        }
    }

    /** 安装状态与分类、搜索组合筛选，不清除玩家已设置的条件。 */
    function selectStatusFilter(status) {
        if (!shouldShowCategoryFilters(status) || batchInstallState.preparing || !selectMarketSection('packages', false)) return false;
        currentStatusFilter = status;
        renderCategoryFilters();
        renderMarketCards();
        updateToolbarResetBtn();
        return true;
    }

    function filterInstalledOnly() { return selectStatusFilter('installed'); }

    function filterUpdatableOnly() { return selectStatusFilter('updatable'); }

    function filterIgnoredOnly() { return selectStatusFilter('ignored'); }

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
            await window.modHubAlert('当前选择“浏览器下载（手动安装）”，需要逐个下载后手动导入。\n\n如需一键更新全部模组，请选择其他下载方式。', '当前方式需要手动安装');
            return;
        }

        const lines = updatables.map(u => `· ${u.name} (当前: ${formatVersionDisplay(u.currentVersion)} -> 最新: ${formatVersionDisplay(u.newVersion)})`).join('\n');
        const ok = await window.modHubConfirm({
            title: '一键全部更新',
            message: `检测到共有 ${updatables.length} 个模组可升级至最新版本：\n\n${lines}\n\n当前下载线路：${modHubT(selectedMirror.name)}\n是否立即开始批量下载并安装？`,
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
        if (getUpdatableMods().some(entry => !matchesContentLanguage(entry.marketMod))) {
            window.modHubSwitchTab('manager');
            setTimeout(() => {
                const row = [...(document.getElementById('modHubModManageContainer')?.querySelectorAll('li[data-mod-name]') || [])]
                    .find(item => window._modHubUpdatableMap?.has(item.dataset.modName));
                if (!row) return;
                let ancestor = row.parentElement;
                while (ancestor) { if (ancestor.tagName === 'DETAILS') ancestor.open = true; ancestor = ancestor.parentElement; }
                row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                row.querySelector('.btn-inline-update')?.focus();
            }, 30);
            return;
        }
        window.modHubSwitchTab('market');
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
    window.modHubOpenSpellSubmission = () => batchInstallState.running ? false : openCommunitySubmission('spell');

    window.addEventListener('modhub:languagechange', () => {
        const root = document.getElementById('modHubModMarketContainer');
        if (root) {
            root.querySelectorAll('.modhub-market-card[data-mod-index], .modhub-market-variant-row[data-mod-index]').forEach(node => {
                const mod = marketModList[Number(node.dataset.modIndex)];
                if (mod) refreshCardContent(node, mod);
            });
            const groups = getDisplayMods().filter(mod => mod.isLanguageGroup);
            root.querySelectorAll('.modhub-market-language-card[data-variant-group]').forEach(node => {
                const group = groups.find(mod => mod.variantGroupId === node.dataset.variantGroup);
                const title = node.querySelector('[data-modhub-card-field="name"]');
                node.querySelectorAll('[data-modhub-card-tag]').forEach(tag => {
                    tag.textContent = window.modHubGetMarketCardText({ name: tag.dataset.modhubCardTag }, 'name').text;
                });
                if (group && title) {
                    const name = getLocalizedModName(group);
                    title.textContent = name;
                    node.setAttribute('data-modhub-i18n-aria-label-params', JSON.stringify({ name }));
                    node.setAttribute('aria-label', window.modHubT('{name}的模组信息', { name }));
                }
            });
            window.modHubMarketSpells?.refreshLanguage?.(root);
            window.modHubApplyLanguage?.(root);
        }
    });

    window.modHubMarket = {
        renderCardDescription,
        refreshCardContent,
        getLocalizedSearchEntry,
        getBrowsableMods: () => getDisplayMods(),
        getBrowsableUpdateCount: () => getUpdatableMods().filter(entry => matchesContentLanguage(entry.marketMod)).length,
        matchesContentLanguage,
        isInstallBusy: () => marketInstallBusy || batchInstallState.running,
        isCatalogLoading: () => marketViewLoading,
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
        getPackageDigest,
        formatVersionRiskMessage,
        getReleaseInstallAssets,
        formatReleaseInstallPlanHtml,
        getModDependencies,
        getRequiredDependencies,
        getCatalogRequiredDependencies,
        selectDependencyProvider,
        inferRequiredDependencies,
        getMarketMods: () => marketModList || [],
        getDisplayMods,
        getFilteredDisplayMods,
        getLanguageIdentityMembers,
        getCurrentMirrorId: () => currentMirrorId,
        getCommunityRevision: () => withdrawnRevision,
        resolveMirrorServer,
        setCurrentMirror,
        isWithdrawn,
        hasCommunityReleaseSource,
        renderMarketCards,
        selectMarketSection,
        getCurrentMarketSection: () => currentMarketSection,
        renderBatchInstallToolbar,
        startBatchInstallProgress,
        trackBatchInstallMod,
        setBatchInstallStatus,
        setBatchInstallCompatibility,
        clearBatchInstallResults,
        setBatchInstallPlan,
        finishBatchInstallProgress,
        failBatchInstallProgress,
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
        getOptionalAddonMods,
        getExternalDownloadUrl: marketExternalUrl,
        getModUpdateInfo,
        rememberMarketCandidates,
        getReleaseHistoryContext,
        checkModInstallStatus,
        findMarketModByLocalName,
        cancelDownload,
        updateDownloadProgress,
        downloadAndInstallMod,
        runInstallTask: runMarketInstallTask,
        deriveClassification,
        deriveTags,
        compareVersions,
        normalizeModVersion,
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
        resolveDisplayedInstallMod,
        getBatchSelectionState,
        toggleBatchSelection,
        selectAllVisibleMods,
        clearBatchSelection,
        setBatchModSelected,
        isStatsFilterActive,
        shouldShowCategoryFilters,
        selectStatusFilter,
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
    };

    let startupUpdateTimer = null;
    let startupUpdateIdle = null;
    let startupUpdateStarted = false;

    function startupUpdateReady() {
        if (!window.SugarCube?.State?.passage || !window.modHubMarketVersions?.getLatestGameCandidate) return false;
        return !['init-screen', 'LoadingProgressLog'].some(id => {
            for (let node = document.getElementById(id); node && node !== document; node = node.parentElement || node.parentNode) {
                if (node.hidden) return false;
                const style = window.getComputedStyle?.(node);
                if (style?.display === 'none' || style?.visibility === 'hidden') return false;
            }
            return Boolean(document.getElementById(id));
        });
    }

    function startupUpdateBusy() {
        return document.hidden || !startupUpdateReady() || marketViewLoading || window.modHubIsReloadBusy?.()
            || window.modHubRestore?.isRestoring?.() || window.modHubRestore?.isOperationBlocked?.();
    }

    function scheduleStartupUpdateCheck() {
        if (startupUpdateStarted || startupUpdateTimer !== null || startupUpdateIdle !== null || document.hidden) return;
        if (startupUpdateBusy()) {
            startupUpdateTimer = setTimeout(() => {
                startupUpdateTimer = null;
                scheduleStartupUpdateCheck();
            }, 1000);
            return;
        }
        startupUpdateTimer = setTimeout(() => {
            startupUpdateTimer = null;
            if (startupUpdateBusy()) { scheduleStartupUpdateCheck(); return; }
            if (typeof window.requestIdleCallback === 'function') {
                startupUpdateIdle = window.requestIdleCallback(() => {
                    startupUpdateIdle = null;
                    runStartupUpdateCheck();
                }, { timeout: 3000 });
            } else {
                startupUpdateIdle = setTimeout(() => {
                    startupUpdateIdle = null;
                    runStartupUpdateCheck();
                }, 0);
            }
        }, 2000);
    }

    async function runStartupUpdateCheck() {
        if (startupUpdateBusy()) { scheduleStartupUpdateCheck(); return; }
        startupUpdateStarted = true;
        try {
            await Promise.all([loadMarketData(), window.modHubLoadModManageState?.()]);
            // 面板核验或还原可能在目录请求期间开始，待其结束后再共用检查结果。
            if (startupUpdateBusy()) {
                startupUpdateStarted = false;
                scheduleStartupUpdateCheck();
                return;
            }
            const updates = getUpdatableMods();
            window.modHubNotifyUpdateState?.(updates.length, updates);
        } catch (error) {
            console.warn('[ModHub] 启动后的模组更新检测未完成，可在市场中重新检查', error);
        } finally {
            if (startupUpdateStarted) {
                document.removeEventListener('visibilitychange', onStartupUpdateVisibility);
                window.jQuery?.(document).off?.('.modHubMarketStartup');
            }
        }
    }

    function onStartupUpdateVisibility() {
        if (startupUpdateTimer !== null) clearTimeout(startupUpdateTimer);
        startupUpdateTimer = null;
        if (startupUpdateIdle !== null) {
            if (typeof window.requestIdleCallback === 'function') window.cancelIdleCallback?.(startupUpdateIdle);
            else clearTimeout(startupUpdateIdle);
        }
        startupUpdateIdle = null;
        scheduleStartupUpdateCheck();
    }

    document.addEventListener('visibilitychange', onStartupUpdateVisibility);
    window.jQuery?.(document).on?.(':storyready.modHubMarketStartup :passagedisplay.modHubMarketStartup', scheduleStartupUpdateCheck);
    scheduleStartupUpdateCheck();

})();
