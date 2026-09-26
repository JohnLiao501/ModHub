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
        'npcavatarsmod': ['npc社交栏头像', 'npc侧边栏头像', 'dolnpciconmods', 'maespicvarynpcmod', 'npcavatarsmod'],
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
        'simpleframework': ['简易框架', 'scmlsimpleframework'],
        '简易框架': ['simpleframework', 'scmlsimpleframework'],
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
    const DOL_OPT_OFFLINE_REPOSITORIES = {
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
        ['界面与便利', /界面|\bui\b|显示|侧边栏|快捷|自动|优化|面板|导航|翻译|本地化|按钮|任务助手/i],
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

    // 通用通用停用词集合（严禁单凭此类泛化词汇认定模组已安装）
    const GENERIC_STOP_WORDS = new Set([
        'npc', 'dol', 'mod', 'addon', 'expansion', 'framework', 'pack', 'tool',
        '助手', '系统', '美化', '优化', '扩展', '拓展', '剧情', '功能', '立绘', '头像',
        'game', 'original', 'image', 'alpha', 'beta', 'test', 'v', 'the'
    ]);

    /** 清理模组标题中的平台噪点、下载标注与括号说明 */
    function cleanModTitle(str) {
        if (!str) return '';
        let s = cleanText(str);
        // 移除 [Github], [Discord], (v1.0), 【xxx】 等附加噪点
        s = s.replace(/\[.*?\]|\(.*?\)|【.*?】|（.*?）/g, ' ');
        s = s.replace(/github|discord|下载|论坛|链接|地址|\u2708|\u2764|\u2192/gi, ' ');
        return cleanText(s);
    }

    /**
     * 将可能包含子模块的复合模组标题拆解为主名与子模块鉴别词
     * 例如："织境空间-场景互动扩展" -> { base: "织境空间", subs: ["场景互动扩展"] }
     * 例如："织境空间·料理扩展（测试版）" -> { base: "织境空间", subs: ["料理扩展"] }
     */
    function splitTitleParts(title) {
        const raw = cleanModTitle(title);
        const segments = raw.split(/[-—_·:：/]/).map(s => s.trim()).filter(Boolean);
        if (segments.length >= 2) {
            return {
                base: segments[0],
                subs: segments.slice(1)
            };
        }
        return {
            base: raw,
            subs: []
        };
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
        const utilityRegex = /github|discord|下载|论坛|链接|地址|\u2708|\u2764|\u2192|\[.*?\]/i;
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
            if (host === WIKI_HOST || host.endsWith('.miraheze.org') || host.includes('github.com')) return;
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

                const name = extractModName(tds[idx.name]);
                if (!name) continue;

                const description = cleanText(tds[idx.description] ? tds[idx.description].textContent : '');
                const author = idx.author >= 0 && tds[idx.author] ? cleanText(tds[idx.author].textContent) : '';
                const dateText = idx.date >= 0 && tds[idx.date] ? cleanText(tds[idx.date].textContent) : '';
                const { date, version } = parseDateCell(dateText);

                const githubUrls = extractGithubUrls(row);
                const githubUrl = githubUrls[0] || null;
                const otherUrls = extractOtherUrls(row);
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
        return mods;
    }

    // ==================== GitHub Release 检索 ====================

    function parseGithubRepo(url) {
        if (!url) return null;
        const m = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/i);
        if (!m) return null;
        const repo = m[2].replace(/\.git$/i, '');
        return { owner: m[1], repo, key: `${m[1]}/${repo}`.toLowerCase() };
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
        const matches = String(name || '').match(/\d+(?:\.\d+){1,3}/g) || [];
        return (matches.at(-1) || '').split('.').filter(Boolean).map(Number);
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
        return String(name || '').match(/(?:^|[-_.])(?:dol[-_.]?)?(0\.5\.\d+(?:\.\d+)?)(?=[-_.]|$)/i)?.[1] || '';
    }

    function buildReleaseAssetPlan(assets, gameVersion = window.StartConfig?.version || '') {
        const downloadable = (assets || []).filter(asset =>
            asset?.downloadUrl &&
            !/source[\s_-]*code/i.test(asset.name || '') &&
            /\.(?:zip|7z|mod|rar)$/i.test(asset.name || '')
        );
        if (!downloadable.length) return { assets: [], candidates: [], needsChoice: false, reason: '' };

        const companions = downloadable.filter(asset => COMPANION_ASSET_PATTERN.test(asset.name || ''));
        let mainCandidates = downloadable.filter(asset => !COMPANION_ASSET_PATTERN.test(asset.name || ''));
        if (!mainCandidates.length) mainCandidates = downloadable;

        const isMobile = typeof window.dolOptIsMobile === 'function'
            ? !!window.dolOptIsMobile()
            : !!window.dolOptIsMobile;
        const preferredPlatform = isMobile
            ? /(?:^|[-_.])(?:mobile|android)(?=[-_.]|$)/i
            : /(?:^|[-_.])(?:desktop|pc|windows)(?=[-_.]|$)/i;
        const oppositePlatform = isMobile
            ? /(?:^|[-_.])(?:desktop|pc|windows)(?=[-_.]|$)/i
            : /(?:^|[-_.])(?:mobile|android)(?=[-_.]|$)/i;
        const preferred = mainCandidates.filter(asset => preferredPlatform.test(asset.name || ''));
        if (preferred.length) {
            mainCandidates = preferred;
        } else {
            const neutral = mainCandidates.filter(asset => !oppositePlatform.test(asset.name || ''));
            if (neutral.length) mainCandidates = neutral;
        }

        const normalizedGameVersion = String(gameVersion || '').replace(/^v/i, '');
        const versionSpecific = mainCandidates.filter(asset => getAssetGameVersion(asset.name));
        if (normalizedGameVersion && versionSpecific.length) {
            const exact = versionSpecific.filter(asset => getAssetGameVersion(asset.name) === normalizedGameVersion);
            if (exact.length) {
                mainCandidates = exact;
            } else if (versionSpecific.length === mainCandidates.length && mainCandidates.length > 1) {
                return {
                    assets: [],
                    candidates: mainCandidates,
                    needsChoice: true,
                    reason: `没有与当前 DoL ${normalizedGameVersion} 完全匹配的兼容包`
                };
            }
        }

        mainCandidates.sort((a, b) => compareAssetVersions(b, a));
        const selectedMain = mainCandidates[0];
        const sameVersion = mainCandidates.filter(asset => compareAssetVersions(asset, selectedMain) === 0);
        if (sameVersion.length > 1) {
            return {
                assets: [],
                candidates: sameVersion,
                needsChoice: true,
                reason: '检测到多个同版本安装包，无法可靠判断用途'
            };
        }

        const mainVersion = getAssetVersionParts(selectedMain.name).join('.');
        const selectedCompanions = companions.filter(asset => {
            const companionVersion = getAssetVersionParts(asset.name).join('.');
            return !companionVersion || !mainVersion || companionVersion === mainVersion;
        });
        return {
            assets: [selectedMain, ...selectedCompanions],
            candidates: downloadable,
            needsChoice: false,
            reason: ''
        };
    }

    async function fetchModRelease(mod, options = {}) {
        const { useCache = true, signal } = options;
        if (!mod || !mod.githubUrl) throw new Error('模组缺少 GitHub 仓库链接');
        const repo = parseGithubRepo(mod.githubUrl);
        if (!repo) throw new Error('无法解析 GitHub 仓库地址');

        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}`;
        const gameVersion = window.StartConfig?.version || '';
        if (useCache) {
            const cached = readLocalCache(cacheKey, RELEASE_CACHE_TTL);
            if (cached?.assetPlanVersion === 2 && cached.assetPlanGameVersion === gameVersion) {
                return { ...cached, fromCache: true };
            }
        }

        const headers = { Accept: 'application/vnd.github+json' };
        const baseUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;

        let releaseData = null;
        try {
            const latestRes = await fetch(`${baseUrl}/releases/latest`, { headers, signal });

            if (latestRes.status === 429 || latestRes.status === 403) {
                const err = new Error('GitHub API 触发速率限制，请稍候再试');
                err.code = 'RATE_LIMITED';
                throw err;
            }

            if (latestRes.status === 404) {
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
            const currentRepoKey = `${repo.owner}/${repo.repo}`.toLowerCase();
            unmarkRepoAsDead(currentRepoKey);
            if (mod) mod._isDeadRepo = false;
        } catch (fetchErr) {
            if (fetchErr?.code === 'REPO_NOT_FOUND' || fetchErr?.status === 404) {
                throw fetchErr;
            }
            const staleCache = readLocalCache(cacheKey, Infinity, true);
            if (staleCache?.assets && staleCache.assets.length > 0) {
                console.warn('[DolOptimization] GitHub API 直连受限，回退使用最近成功缓存的 Release 数据:', fetchErr);
                return { ...staleCache, fromCache: true, isStale: true };
            }
            throw fetchErr;
        }

        const assets = (releaseData.assets || []).map(a => ({
            name: a.name,
            size: a.size,
            downloadUrl: a.browser_download_url,
            digest: a.digest || ''
        }));
        const assetPlan = buildReleaseAssetPlan(assets, gameVersion);
        const bestAsset = assetPlan.assets[0] || null;

        const releaseTitle = String(releaseData.name || '').trim();
        const explicitTitleVersion = releaseTitle.match(/^v?(\d+(?:\.\d+){1,3}(?:-[0-9a-z][0-9a-z.-]*)?)$/i)?.[1];
        const tagName = String(releaseData.tag_name || '');
        const tagVersion = /^(?:v?\d)|(?:^|[^a-z0-9])(?:v\d|\d+\.\d+)/i.test(tagName) ? tagName : '';
        const prefixedTitleVersion = releaseTitle.match(/^v(\d+(?:\.\d+){1,3})(?=$|[\s(（-])/i)?.[1];
        const version = explicitTitleVersion || tagVersion || prefixedTitleVersion || mod.version || '';
        const updateDate = releaseData.published_at ? releaseData.published_at.slice(0, 10) : mod.updateDate || '';

        const result = {
            tagName: releaseData.tag_name || '',
            releaseName: releaseData.name || '',
            htmlUrl: releaseData.html_url || `${mod.githubUrl}/releases/latest`,
            assetName: bestAsset ? bestAsset.name : null,
            assetUrl: bestAsset ? bestAsset.downloadUrl : null,
            assetSize: bestAsset ? Number(bestAsset.size) || 0 : 0,
            assetDigest: bestAsset ? bestAsset.digest : '',
            assets: assetPlan.assets,
            candidateAssets: assetPlan.candidates,
            requiresManualSelection: assetPlan.needsChoice,
            selectionReason: assetPlan.reason,
            assetPlanVersion: 2,
            assetPlanGameVersion: gameVersion,
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
        if (!repo) return [];
        const cacheKey = `${RELEASE_CACHE_PREFIX}${repo.owner}_${repo.repo}_companions`;
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
            for (const asset of release.assets || []) {
                if (!COMPANION_ASSET_PATTERN.test(asset.name || '') || !asset.browser_download_url) continue;
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
            assets: [asset],
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

    /** 提取中文/英文词块（长度 >= 2） */
    function extractNameParts(str) {
        if (!str) return [];
        const parts = [];
        const clean = str.replace(/[()（）\[\]【】_—\-—.\s]/g, ' ').trim();
        if (clean) parts.push(clean);

        // 提取中文字符串
        const cnMatches = str.match(/[\u4e00-\u9fa5]+/g);
        if (cnMatches) parts.push(...cnMatches);

        // 提取英文字符串（>= 3个字符）
        const enMatches = str.match(/[a-zA-Z0-9]{3,}/g);
        if (enMatches) parts.push(...enMatches);

        return [...new Set(parts.map(normalizeKey).filter(p => p.length >= 2))];
    }

    /** 从 GitHub 仓库地址提取仓库名（小写且归一化） */
    function extractRepoName(url) {
        const repo = parseGithubRepo(url);
        return repo ? normalizeKey(repo.repo) : '';
    }

    function extractRepoKey(url) {
        return parseGithubRepo(url)?.key || '';
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
            if (!identity || typeof identity !== 'object') continue;

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
                ...(Array.isArray(identity.repositories) ? identity.repositories : []),
                ...repositoryKeys.map(key => key.split('/')[1])
            ].filter(value => typeof value === 'string').map(cleanText).filter(Boolean);
            const keys = [...new Set(names.map(normalizeKey).filter(Boolean))];
            if (!keys.length) continue;

            for (const key of keys) {
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
        return index.mods.map(mod => {
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
                const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
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
            const profileKey = normalizeKey(modName);
            if (!profileKey || seenNames.has(profileKey)) return;
            seenNames.add(profileKey);

            const resolvedMod = window.dolOptGetModInfo?.(modName) || modRef;
            const boot = resolvedMod?.bootJson || bootJson || modRef?.bootJson || {};
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

            // 4. 调用模组管理器的友好副标题解析方法 (dolOptGetModSubtext，显式禁用市场反查避免循环递归)
            if (typeof window.dolOptGetModSubtext === 'function') {
                const subtext = window.dolOptGetModSubtext(modName, resolvedMod || modRef || { bootJson: boot }, false, true);
                if (subtext && typeof subtext === 'string') {
                    displayNames.add(subtext.trim());
                }
            }

            // 5. 提取本地配置中可能包含的 repository
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

            // 6. 查阅社区知名模组全能别名库，扩充中文与仓库标识
            for (const name of Array.from(displayNames)) {
                const norm = normalizeKey(name);
                const aliases = DOL_OPT_KNOWN_MOD_MARKET_ALIASES[norm] || [];
                aliases.forEach(alias => {
                    displayNames.add(alias);
                    repos.add(normalizeKey(alias));
                    const ac = stripDoLPrefix(alias);
                    if (ac && ac.length >= 3) repos.add(ac);
                });
                const knownRepos = DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[norm] || [];
                knownRepos.forEach(k => repositoryKeys.add(k));
            }

            const cleanNames = Array.from(displayNames).map(cleanModTitle).filter(Boolean);
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
                    const m = window.dolOptGetModInfo?.(name) || (gui.gModUtils.getMod ? gui.gModUtils.getMod(name) : null);
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
                    const m = window.dolOptGetModInfo?.(name) || (gui?.gModUtils?.getMod ? gui.gModUtils.getMod(name) : null);
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
                if (DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normK]) {
                    DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normK].forEach(a => {
                        disp.add(a);
                        repos.add(normalizeKey(a));
                    });
                }
                if (DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normK]) {
                    DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normK].forEach(repo => repositoryKeys.add(String(repo).toLowerCase()));
                }
                const clean = Array.from(disp).map(cleanModTitle).filter(Boolean);
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
                        repos: Array.from(allRepos),
                        repositoryKeys: (p.repositoryKeys || []).map(key => String(key).toLowerCase())
                    };
                }
                const disp = new Set(p.displayNames || p.keys || [p.name]);
                const repos = new Set(p.repos || (p.keys ? p.keys.map(normalizeKey) : [normalizeKey(p.name)]));
                const normN = normalizeKey(p.name);
                const nCore = stripDoLPrefix(p.name);
                if (nCore && nCore.length >= 3) repos.add(nCore);
                if (DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normN]) {
                    DOL_OPT_KNOWN_MOD_MARKET_ALIASES[normN].forEach(a => {
                        disp.add(a);
                        repos.add(normalizeKey(a));
                        const ac = stripDoLPrefix(a);
                        if (ac && ac.length >= 3) repos.add(ac);
                    });
                }
                const repositoryKeys = new Set((p.repositoryKeys || []).map(key => String(key).toLowerCase()));
                if (DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normN]) {
                    DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[normN].forEach(repo => repositoryKeys.add(String(repo).toLowerCase()));
                }
                const clean = Array.from(disp).map(cleanModTitle).filter(Boolean);
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

        const marketTitle = cleanModTitle(mod.name);
        const marketNorm = normalizeKey(marketTitle);
        const marketRepo = extractRepoName(mod.githubUrl);
        const marketRepoKey = extractRepoKey(mod.githubUrl);
        const trustedRepoKeys = new Set([
            ...(Array.isArray(mod.repositoryKeys) ? mod.repositoryKeys : []),
            ...(DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[marketNorm] || []),
            ...(DOL_OPT_KNOWN_MOD_REPOSITORY_KEYS[marketRepo] || [])
        ].map(key => String(key).toLowerCase()));
        if (trustedRepoKeys.size && !trustedRepoKeys.has(marketRepoKey)) {
            mod._matchedLocal = null;
            return mod.githubUrl ? 'not_installed' : (mod.otherUrl ? 'external_only' : 'unavailable');
        }
        const { base: marketBase, subs: marketSubs } = splitTitleParts(mod.name);
        const marketBaseNorm = normalizeKey(marketBase);
        const marketSubsNorm = marketSubs.map(normalizeKey);

        let bestProfile = null;
        let bestScore = 0;

        for (const p of profileList) {
            let score = 0;
            const normTech = normalizeKey(p.name);
            if (marketRepoKey && p.repositoryKeys?.length && !p.repositoryKeys.includes(marketRepoKey)) continue;

            // 1. 全名或别名完全一致 (Score 100)
            if (p.normalizedNames.includes(marketNorm)) {
                score = 100;
            }

            // 2. 仓库名精确匹配 (Score 90-95)
            if (score < 90 && marketRepo) {
                const marketRepoCore = stripDoLPrefix(marketRepo);
                const techCore = stripDoLPrefix(normTech);
                const isCoreMatch = marketRepoCore && marketRepoCore.length >= 3 && !GENERIC_STOP_WORDS.has(marketRepoCore) &&
                    (marketRepoCore === normTech || marketRepoCore === techCore || (p.repos && p.repos.some(r => stripDoLPrefix(r) === marketRepoCore)));
                const repoMatch = (marketRepo === normTech) || (p.repos && p.repos.includes(marketRepo)) || isCoreMatch;
                if (repoMatch) {
                    if (marketSubs.length > 0) {
                        // 市场模组包含具体子扩展（如场景互动扩展），要求本地模组必须也含有该子模块关键词
                        const subMatched = p.normalizedNames.some(pNorm =>
                            marketSubsNorm.some(s => s.length >= 2 && pNorm.includes(s))
                        );
                        if (subMatched) {
                            score = 95;
                        }
                    } else {
                        // 市场模组是主模组，如果本地模组是一个明确命名的子 Addon（如 WovenRealmCookingAddon），不应匹配到主模组
                        const isProfileSubAddon = ['addon', 'cooking', 'ui', 'plugin'].some(s => normTech.includes(s));
                        if (marketRepo === normTech || !isProfileSubAddon) {
                            score = 90;
                        }
                    }
                }
            }

            // 3. 复合标题双重匹配：主名一致 + 子扩展模块鉴别词一致 (Score 85)
            if (score < 85 && marketSubs.length > 0 && marketBaseNorm && !GENERIC_STOP_WORDS.has(marketBaseNorm)) {
                for (const pName of p.displayNames) {
                    const { base: pBase, subs: pSubs } = splitTitleParts(pName);
                    const pBaseNorm = normalizeKey(pBase);
                    const pSubsNorm = pSubs.map(normalizeKey);
                    if (pBaseNorm === marketBaseNorm) {
                        // 主名吻合，检查子模块关键词
                        const hasSubMatch = marketSubsNorm.some(ws => {
                            const wsClean = ws.replace(/扩展|拓展|addon|mod/g, '');
                            return pSubsNorm.some(ps => ps.includes(ws) || (wsClean.length >= 2 && ps.includes(wsClean)));
                        });
                        if (hasSubMatch) {
                            score = 85;
                            break;
                        }
                    }
                }
            }

            // 4. 多别名斜杠拆分精确命中 (Score 80)
            if (score < 80 && mod.name && mod.name.includes('/')) {
                const parts = mod.name.split('/').map(x => normalizeKey(cleanModTitle(x))).filter(Boolean);
                for (const pt of parts) {
                    if (pt.length >= 3 && !GENERIC_STOP_WORDS.has(pt) && p.normalizedNames.includes(pt)) {
                        score = 80;
                        break;
                    }
                }
            }

            // 5. 跨语言语义长词双向包含匹配 (Score 82)
            if (score < 80 && marketNorm.length >= 3) {
                for (const pNorm of p.normalizedNames) {
                    if (!pNorm || pNorm.length < 3) continue;
                    if (GENERIC_STOP_WORDS.has(pNorm) || GENERIC_STOP_WORDS.has(marketNorm)) continue;

                    const isMarketChinese = /[\u4e00-\u9fa5]/.test(marketNorm);
                    const isPChinese = /[\u4e00-\u9fa5]/.test(pNorm);
                    const hasChinese = isMarketChinese || isPChinese;

                    const shortStr = marketNorm.length <= pNorm.length ? marketNorm : pNorm;
                    const longStr = marketNorm.length > pNorm.length ? marketNorm : pNorm;

                    // 纯 ASCII（英文/数字）环境防局部字母拼接假阳性：
                    // 严禁短于 8 字符的纯英文字串作为子串跨词匹配（避免如 doli 误撞 modloaderdolimageloaderhook 等），且覆盖率须 >= 80%
                    if (!hasChinese) {
                        if (shortStr.length < 8) continue;
                        if ((shortStr.length / longStr.length) < 0.8) continue;
                    } else {
                        // 中文语义环境下，短串有效长度至少为 3，且覆盖率须 >= 40%
                        if (shortStr.length < 3) continue;
                        if ((shortStr.length / longStr.length) < 0.4) continue;
                    }

                    const isContained = longStr.includes(shortStr);
                    if (isContained) {
                        if (marketSubs.length > 0) {
                            const subMatched = p.normalizedNames.some(pn =>
                                marketSubsNorm.some(s => s.length >= 2 && pn.includes(s))
                            );
                            if (subMatched) {
                                score = 82;
                                break;
                            }
                        } else {
                            const isProfileSubAddon = ['addon', 'cooking', 'ui', 'plugin'].some(s => normTech.includes(s));
                            if (!isProfileSubAddon) {
                                score = 82;
                                break;
                            }
                        }
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestProfile = p;
            }
        }

        // 低于 80 分一律认定为未匹配
        const matchedProfile = bestScore >= 80 ? bestProfile : null;
        mod._matchedLocal = matchedProfile || null;
        mod._matchedScore = matchedProfile ? bestScore : 0;

        if (!matchedProfile) {
            const isDead = Boolean(mod._isDeadRepo || isDeadRepo(marketRepoKey, mod) || isDeadRepo(mod.githubUrl, mod));
            if (isDead) {
                return mod.otherUrl ? 'external_only' : 'unavailable';
            }
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

    // ==================== 下载与一键安装 ====================

    const activeDownloadControllers = new Map();

    function cancelDownload(modName) {
        const controller = activeDownloadControllers.get(modName);
        if (!controller || controller.signal.aborted) return false;
        controller.abort();
        return true;
    }

    function updateDownloadProgress(modName, percent, text, state = 'active') {
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
            button.disabled = !['error', 'cancelled'].includes(state);
            button.textContent = state === 'installing'
                ? '正在安装'
                : (state === 'error'
                    ? '重试'
                    : (state === 'cancelled' ? (button.dataset.idleText || '下载安装') : (value === null ? '正在下载' : `下载 ${value}%`)));
        }
    }

    function resetDownloadProgress(modName) {
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
            button.disabled = false;
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

    async function downloadAndInstallMod(mod, mirrorId = currentMirrorId, options = {}) {
        if (!mod) return false;
        const gui = window.dolOptGetGui ? window.dolOptGetGui() : null;
        if (!gui) {
            window.dolOptShowToast('未找到 ModLoader 运行时实例，无法自动安装', 'warning');
            return false;
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
        }

        if (!installAssets.length) {
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
        if (selectedMirror.browserOnly) return startBrowserDownload();

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
                return false;
            }
            if (typeof window.dolOptHandleAddMod === 'function') {
                const installed = await window.dolOptHandleAddMod(dummyInput.files && dummyInput.files.length > 0 ? dummyInput : fileObjects, {
                    askRestart,
                    // 市场内安装：「稍后重载」后停留市场页签，方便玩家连续安装多个模组
                    keepCurrentTab: true,
                    targetModName: mod._matchedLocal?.name || '',
                    displayName: mod.name || ''
                });
                if (installed === false) {
                    clearActiveDownload();
                    const reason = String(window._dolOptLastInstallError || '').trim();
                    reportProgress(null, reason ? `安装未完成：${reason}` : '安装未完成，请检查管理器提示后重试', 'error');
                    return false;
                }
            } else if (typeof window.dolOptInstallFilesViaIndexDB === 'function') {
                await window.dolOptInstallFilesViaIndexDB(fileObjects);
            } else if (typeof gui.loadAndAddMod === 'function') {
                await gui.loadAndAddMod(dummyInput);
                if (askRestart) {
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
                return false;
            }
            const isTooLarge = err?.code === 'FILE_TOO_LARGE';
            const isDigestFailure = ['DIGEST_MISMATCH', 'DIGEST_UNSUPPORTED', 'DIGEST_UNAVAILABLE'].includes(err?.code);
            console.warn('[DolOptimization] 页面内自动安装失败:', err);
            reportProgress(null, isDigestFailure ? '完整性校验失败，已阻止安装' : (isTooLarge ? '安装包较大，可改用浏览器下载' : '自动安装失败，请重试或改用浏览器下载'), 'error');

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
                applyIdentityCatalog(cached);
                marketModList = cached;
                return marketModList;
            }
        }

        try {
            marketModList = await fetchReleaseIndex();
            return marketModList;
        } catch (error) {
            console.warn('[DolOptimization] Cloudflare 自动版本索引不可用，尝试本地缓存或 Wiki', error);
        }

        const identityPromise = loadIdentityCatalog(forceRefresh);
        if (!forceRefresh) {
            const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
            if (stale && Array.isArray(stale) && stale.length > 0) {
                await identityPromise;
                marketModList = stale;
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
            return marketModList;
        } catch (error) {
            const stale = readLocalCache(WIKI_CACHE_KEY, WIKI_CACHE_TTL, true);
            if (stale && Array.isArray(stale) && stale.length > 0) {
                marketModList = stale;
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
        const localProfile = profiles.find(profile => normalizeKey(profile.name) === normalizedName)
            || profiles.find(profile => profile.normalizedNames?.includes(normalizedName))
            || { name: modName, version: '' };

        let bestCandidate = null;
        let highestScore = 0;

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
                }
            }
        }
        return bestCandidate;
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

        const core = stripDoLPrefix(modName);
        for (const m of list) {
            const mNorm = normalizeKey(m.name);
            const mRepo = extractRepoName(m.githubUrl);
            const mRepoCore = stripDoLPrefix(mRepo);
            const isMatch = (mNorm === norm) ||
                (mRepo && mRepo === norm) ||
                (core.length >= 3 && mRepoCore.length >= 3 && core === mRepoCore) ||
                (DOL_OPT_KNOWN_MOD_MARKET_ALIASES[norm] && DOL_OPT_KNOWN_MOD_MARKET_ALIASES[norm].includes(mNorm));
            if (isMatch) {
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
                <div class="childItem dol-opt-market-card ${isUpdatable ? 'dol-opt-market-card-updatable' : ''}" data-mod-name="${escapeHtml(mod.name)}" data-mod-index="${modIndex}">
                    <div class="dol-opt-market-card-header">
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

        // 绑定卡片内按钮事件
        container.querySelectorAll('.btn-market-install, .btn-market-update').forEach(btn => {
            btn.onclick = async () => {
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

        updateToolbarResetBtn();
    }

    /** 弹窗开始下载 */
    async function promptDownloadMirrorAndInstall(mod) {
        const selectedMirror = MIRROR_SERVERS.find(m => m.id === currentMirrorId) || MIRROR_SERVERS[0];
        const externalOnly = !mod.githubUrl && Boolean(mod.otherUrl);
        const plan = buildDependencyPlan(mod);
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
        const dependencyHtml = dependencyLines.length
            ? `<div class="dol-opt-install-dependencies"><strong>前置依赖（${dependencyLines.length}）</strong><ul>${dependencyLines.map(line => `<li>${window.dolOptEscapeHtml(line)}</li>`).join('')}</ul></div>`
            : '';
        const trustedMessageHtml = !externalOnly && releaseInfo
            ? `${dependencyHtml}${formatReleaseInstallPlanHtml(releaseInfo, selectedMirror, historicalCompanions.length)}`
            : '';
        const choice = await window.dolOptConfirm({
            title: externalOnly ? `处理【${mod.name}】的前置依赖` : `下载并安装【${mod.name}】`,
            message: actionLines.length
                ? `检测到以下必需依赖需要一并处理：\n\n${actionLines.join('\n')}\n\n${externalOnly ? '处理完成后将打开目标模组的外部下载页面。' : `${installPlanText}\n\n将按依赖顺序处理，并在最后安装【${mod.name}】。`}`
                : `${installPlanText}\n\n${selectedMirror.browserOnly ? '以上文件将由浏览器下载后手动导入。' : '以上文件将自动注册到 ModLoader 旁加载中。'}\n\n下载线路：${selectedMirror.name}\n\n是否立即开始下载并安装？`,
            trustedMessageHtml,
            dialogClass: externalOnly ? '' : 'dol-opt-install-dialog',
            confirmText: manualAssetOptions.length ? '安装所选包' : (actionLines.length ? `一并处理（${plan.actions.length}项）` : '开始安装'),
            cancelText: '取消',
            confirmType: 'primary',
            selectLabel: manualAssetOptions.length ? '主安装包选择' : (companionOptions.length ? '历史美术包选择' : undefined),
            selectOptions,
            selectValue: manualAssetOptions.length ? '' : (companionOptions.length ? 'none' : undefined),
            requireSelection: manualAssetOptions.length > 0
        });

        if (!choice) {
            resetDownloadProgress(mod.name);
            return false;
        }
        const selectedReleaseInfo = applyManualAssetSelection(releaseInfo, choice);
        if (selectedReleaseInfo) releaseInfo = selectedReleaseInfo;
        const historyMatch = typeof choice === 'string' ? choice.match(/^history:(\d+)$/) : null;
        if (historyMatch && releaseInfo) {
            const selectedCompanion = historicalCompanions[Number(historyMatch[1])];
            if (selectedCompanion) {
                releaseInfo = { ...releaseInfo, assets: [...getReleaseInstallAssets(releaseInfo), selectedCompanion] };
            }
        }
        if (!actionLines.length) return downloadAndInstallMod(mod, currentMirrorId, { releaseInfo });

        const totalSteps = plan.actions.length + (externalOnly ? 0 : 1);
        for (let index = 0; index < plan.actions.length; index++) {
            const action = plan.actions[index];
            const progressPrefix = `${index + 1}/${totalSteps} 前置【${action.mod.name}】：`;
            if (action.type === 'enable') {
                updateDownloadProgress(mod.name, null, `${progressPrefix}正在启用...`);
                if (typeof window.dolOptToggleSideMod !== 'function') {
                    await window.dolOptAlert(`无法启用前置依赖【${action.mod.name}】，已停止安装目标模组。`, '安装已停止');
                    return false;
                }
                await window.dolOptToggleSideMod(action.local.name, true);
                updateDownloadProgress(mod.name, 100, `${progressPrefix}已启用`);
                continue;
            }
            window.dolOptShowToast(`正在${action.type === 'update' ? '更新' : '安装'}前置依赖【${action.mod.name}】...`, 'warning');
            if (!await downloadAndInstallMod(action.mod, currentMirrorId, {
                askRestart: false,
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
            progressPrefix: `${totalSteps}/${totalSteps} 目标模组【${mod.name}】：`,
            releaseInfo
        })) return false;
        const restart = await window.dolOptConfirm({
            title: '安装完成',
            message: `模组【${mod.name}】及所需前置依赖已处理完成。\n\n是否立即重新载入游戏使其生效？`,
            confirmText: '立即重载',
            cancelText: '稍后重载',
            confirmType: 'primary'
        });
        if (restart) {
            window.dolOptShowToast('正在重新载入游戏...', 'warning');
            setTimeout(() => location.reload(), 300);
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

            <!-- ===== 模组卡片列表容器 ===== -->
            <div id="dolOptMarketCardsContainer" class="dol-opt-market-grid">
                <div class="dol-opt-loading-box grey">
                    正在拉取 Wiki 模组市场数据，请稍候……
                </div>
            </div>
        `;

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
                if (await downloadAndInstallMod(item.marketMod, currentMirrorId, { askRestart: false })) successCount++;
                else failCount++;
            } catch (err) {
                console.error('[DolOptimization] 批量更新单个模组失败', item.name, err);
                failCount++;
            }
        }

        renderMarketCards();

        const msg = `批量更新已完成！\n成功: ${successCount} 个${failCount > 0 ? `，失败: ${failCount} 个` : ''}。\n\n是否立即重新载入游戏以使新版本生效？`;
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
        formatVersionDisplay,
        MIRROR_SERVERS,
        getUpdatableMods,
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
        getStaticMarketModSubtext
    };

})();
