/**
 * ModHub - 加载日志诊断、检索、截图与启动自检。
 * 共享接口由 modhub-manager.js 提供，错误捕获在主脚本中提前注册。
 */

/* =========================================================================
 * 5. 加载日志分析诊断与结构化渲染引擎
 * ========================================================================= */

// 启动检测到错误时自动弹窗定位配置（默认开启）
window.modHubIsAutoOpenErrorLogEnabled = function() {
    try {
        if (typeof localStorage === 'undefined') return true;
        const val = localStorage.getItem('modhub_auto_open_log_on_error') ?? localStorage.getItem('dol_opt_auto_open_log_on_error');
        return val === null ? true : val === 'true';
    } catch (_) {
        return true;
    }
};

window.modHubSetAutoOpenErrorLogEnabled = function(val) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('modhub_auto_open_log_on_error', val ? 'true' : 'false');
        }
    } catch (_) {}
};

window.modHubToggleAutoOpenLogSetting = function(checked) {
    window.modHubSetAutoOpenErrorLogEnabled(checked);
    window.modHubShowToast(checked ? '已开启【加载出错时自动打开日志窗口】' : '已关闭【加载出错时自动打开日志窗口】', 'info');
    const toggleInput = document.getElementById('toggleAutoOpenErrorLog');
    if (toggleInput) toggleInput.checked = checked;
};

// 天气图像异常需同时匹配渲染上下文和具体失败，不能把任意 NaN 归因于缺图。
const modHubIsWeatherImageFailure = line => {
    const weatherContext = /\bWeather\.Renderer\.Sky\b/i.test(line) ||
        /Error during effect\s*['"]\s*(?:bannerCirrusClouds|bannerOvercastClouds|bannerClouds|bannerPrecipitation|bannerStarField|rainbow|moon|location)\s*['"]/i.test(line);
    if (!weatherContext) return false;
    return (/randomInt called with invalid parameters/i.test(line) && /\b(?:NaN|undefined)\b/i.test(line)) ||
        (/drawImage/i.test(line) && /provided value is not of type/i.test(line));
};

// NPC 怀孕/生育系统或开局变量未初始化异常判定
const modHubIsNpcPregnancyInitFailure = line => {
    const lineLower = line.toLowerCase();
    if (lineLower.includes('npcpregnancyupdater')) return true;
    if (lineLower.includes('pregnancyavoidance') && (lineLower.includes('undefined') || lineLower.includes('typeerror'))) return true;
    if (lineLower.includes('incompletepregnancyenabled')) return true;
    if (lineLower.includes('setup.pregnancy') && (lineLower.includes('c.npc') || lineLower.includes('$_name'))) return true;
    if (lineLower.includes("reading 'pregnancy'") && (lineLower.includes('c.npc') || lineLower.includes('$_name'))) return true;
    if (lineLower.includes('c.npc[$_name].pregnancy')) return true;
    return false;
};

// 常见模组加载错误通俗化诊断知识库 (0 Emoji)
const MODHUB_ERROR_PATTERNS = [
    {
        id: 'weather-image-error',
        title: '原版天气图像加载或渲染失败',
        keywords: ['randomint called with invalid parameters', 'drawimage'],
        resolve: line => modHubIsWeatherImageFailure(line) ? {
            id: 'weather-image-error',
            title: '原版天气图像加载或渲染失败',
            desc: '天气系统在渲染天空或背景效果时遇到无效图像数据。此错误可能是原版图像资源缺失或加载失败导致的连锁异常。',
            solution: '建议：1. 确认原版 img 图像资源完整且与当前 DoL 版本匹配；2. 若使用 GameOriginalImagePack 图像包，确认其已启用并重新载入游戏；3. 若仍有异常，检查图像加载框架与游戏版本的兼容性。'
        } : null
    },
    {
        id: 'game-version-mismatch',
        title: '游戏版本不满足模组要求',
        keywords: ['dependencechecker.checkgameversion() not satisfies'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*gameVersion\[([^\]]+)\].*gameVersion is \[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'game-version-mismatch',
                title: '游戏版本不满足模组要求',
                desc: `模组【${match[1]}】需要 DoL ${match[2]}，当前游戏版本为 ${match[3]}。`,
                solution: `建议：将游戏更新至 ${match[2]} 或更高版本；或更换为适用于 DoL ${match[3]} 的旧版模组包。`
            };
        }
    },
    {
        id: 'modloader-version-mismatch',
        title: 'ModLoader 版本不满足要求',
        keywords: ['not satisfies modloader'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*version\[([^\]]+)\].*ModLoader\[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'modloader-version-mismatch',
                title: 'ModLoader 版本不满足要求',
                desc: `模组【${match[1]}】需要 ModLoader ${match[2]}，当前版本为 ${match[3]}。`,
                solution: `建议：将 ModLoader 更新至 ${match[2]} 或更高版本；或安装与当前 ModLoader 兼容的模组版本。`
            };
        }
    },
    {
        id: 'dependency-version-mismatch',
        title: '前置模组版本不满足要求',
        keywords: ['dependencechecker.check() not satisfies:', 'dependencechecker.checkfor('],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*need mod\[([^\]]+)\] version\[([^\]]+)\].*find version\[([^\]]+)\]/i);
            if (!match) return null;
            return {
                id: 'dependency-version-mismatch',
                title: '前置模组版本不满足要求',
                desc: `模组【${match[1]}】需要前置模组【${match[2]}】版本 ${match[3]}，当前检测到 ${match[4]}。`,
                solution: `建议：将【${match[2]}】更新至满足要求的版本，清理重复旧包后重新载入游戏。`
            };
        }
    },
    {
        id: 'dependency-order',
        title: '前置模组加载顺序错误',
        keywords: ['not satisfies order'],
        resolve: line => {
            const match = line.match(/mod\[([^\]]+)\].*need mod\[([^\]]+)\] load before it/i);
            if (!match) return null;
            return {
                id: 'dependency-order',
                title: '前置模组加载顺序错误',
                desc: `模组【${match[1]}】依赖【${match[2]}】，要求其优先加载。`,
                solution: `建议：在模组管理中将【${match[2]}】移动至【${match[1]}】之前，或执行【智能整理模组与美化顺序】。`
            };
        }
    },
    {
        id: 'mod-name-lookup-miss',
        title: '模组名称或别名查询未命中',
        keywords: ['modordercontainer getbynameonewithalias() cannot find name/alias.'],
        desc: 'ModLoader 按名称或别名查找模组时未找到匹配项。可能由于目标模组未安装、未启用或名称不匹配引起。仅凭此日志，不能确认是否影响游戏。',
        solution: '建议：核对目标模组的安装与启用状态；若伴随脚本或依赖报错，请结合具体错误排查。'
    },
    {
        id: 'missing-dep',
        title: '前置依赖模组缺失',
        keywords: ['not found', 'cannot find mod', 'dependency', 'depends on', 'dependenceinfo', 'referror', '未找到前置'],
        desc: '当前模组缺少必要的前置依赖，或对应依赖项未启用。',
        solution: '建议：查看模组说明文档，下载并启用所需的前置框架模组（例如 Simple Framework）。'
    },
    {
        id: 'twee-patch-mismatch',
        title: 'TweeReplacer 补丁文本不匹配 / 模组间补丁冲突',
        keywords: ['cannot find findstring', 'cannot find findregex', 'tweereplacer'],
        resolve: line => {
            // 针对统计行: [TweeReplacer] do_patch() done: [某模组] okCount:[75] errorCount:[1]
            if (line.includes('do_patch() done:')) {
                const countMatch = line.match(/errorCount:\[(\d+)\]/);
                const okMatch = line.match(/okCount:\[(\d+)\]/);
                if (countMatch && parseInt(countMatch[1], 10) > 0) {
                    const modM = line.match(/done:\s*\[([^\]]+)\]/);
                    const rawModName = modM ? modM[1].trim() : '';
                    const friendlyName = window.modHubFindKnownAlias(rawModName);
                    const modLabel = friendlyName && friendlyName !== rawModName ? `${friendlyName} (${rawModName})` : (rawModName || '模组');
                    const okCount = okMatch ? okMatch[1] : '';

                    const desc = `模组【${modLabel}】有 ${countMatch[1]} 处补丁未能匹配${okCount ? `（其余 ${okCount} 处已匹配）` : ''}。原因可能是多个模组修改了同一文本，或文本与当前游戏/汉化版本存在差异。`;

                    return {
                        id: 'twee-patch-mismatch',
                        title: 'TweeReplacer 补丁文本未匹配',
                        desc,
                        solution: '建议：1. 执行【智能整理模组与美化顺序】调整加载次序；2. 若游戏功能异常，可在【还原点】中恢复安装前的配置。若大部分补丁已匹配，通常仅影响局部选项。',
                        isSummary: true
                    };
                }
                return null;
            }

            // 针对 cannot find findString / findRegex 具体行
            const match = line.match(/cannot find (?:findString|findRegex):\s*\[([^\]]+)\].*?in:\s*\[([^\]]+)\]/i);
            const rawModName = match ? match[1].trim() : '';
            const passageName = match ? match[2].trim() : '';

            const friendlyName = window.modHubFindKnownAlias(rawModName);
            const modLabel = friendlyName && friendlyName !== rawModName ? `${friendlyName} (${rawModName})` : (rawModName || '模组');

            // 提取查找的目标文本与段落特征（剥离前置 cannot find 前缀避免误匹配模组名）
            const afterCannot = line.replace(/cannot find (?:findString|findRegex):\s*\[[^\]]+\]/i, '');
            const findMatch = afterCannot.match(/find(?:String|Regex):\s*\[([\s\S]*?)\]\s*in:/i);
            const findTarget = findMatch ? findMatch[1].trim() : '';
            const isChineseSnippet = /[\u4e00-\u9fa5]/.test(findTarget);

            let desc = '';
            let solution = '';

            const isWraithTemple = (rawModName.includes('Wraith') || modLabel.includes('怨灵')) &&
                (passageName.includes('Temple Jordan') || findTarget.includes('Temple Chastity') || findTarget.includes('贞操带'));

            const isOriginalOptimizationUiEntry = ['原版优化', 'doloptimization'].includes(rawModName.toLowerCase()) &&
                ((passageName === 'Widgets Clothing Caption' && findTarget.includes('overlayReplace "startFeats"')) ||
                 (passageName === 'StoryCaption' && findTarget.includes('overlayReplace "saves"')));
            const isCheatLyraEntry = rawModName.toLowerCase() === 'cheat-lyra' && passageName === 'StoryCaption' &&
                /\$cheatsEnabled\s+is\s+true\s+or\s+\$debug\s+is\s+1/.test(findTarget);

            if (isWraithTemple) {
                desc = `模组【${modLabel}】在神庙段落【Temple Jordan】中未匹配到选项文本。原因可能是模组针对特定中文汉化制作，而当前游戏文本存在词句差异。该补丁仅用于添加询问银海螺的次要选项。`;
                solution = '建议：1. 不必担心，此项未匹配不影响怨灵恋爱核心剧情，可正常继续游玩；2. 若安装了独立汉化模组，可在模组管理中执行【智能整理模组与美化顺序】确保汉化优先加载。';
            } else if (isOriginalOptimizationUiEntry) {
                desc = `模组【${modLabel}】在段落【${passageName}】的管理器入口补丁未能匹配。原因可能是入口已被 ModHub 替代，或游戏界面文本存在差异。`;
                solution = '建议：1. 此项不影响核心剧情，游戏可正常游玩；2. 可执行【智能整理模组与美化顺序】检查次序；3. 若遇到功能异常，可在【还原点】中恢复之前的配置。';
            } else if (isCheatLyraEntry) {
                desc = `模组【${modLabel}】在【StoryCaption】中修改作弊按钮开放条件的补丁未能匹配。可能由于其他模组修改了相同位置或游戏版本差异引起，仅凭此日志不能确定冲突来源或功能影响。`;
                solution = '建议：1. 确认作弊入口是否正常显示；2. 检查与当前游戏版本及其他作弊模组的兼容性；3. 可执行【智能整理模组与美化顺序】，或在【还原点】中恢复安装前的配置。';
            } else if (isChineseSnippet && passageName) {
                const previewSnippet = findTarget.length > 24 ? findTarget.slice(0, 24) + '...' : findTarget;
                desc = `模组【${modLabel}】在段落【${passageName}】中未匹配到中文文本“${previewSnippet}”。原因可能是当前游戏或汉化版本的词句、空格或排版存在差异。`;
                solution = '建议：1. 在模组管理中执行【智能整理模组与美化顺序】，确保汉化优先加载；2. 若游戏运行正常，通常仅影响局部剧情分支。';
            } else if (rawModName && passageName) {
                desc = `模组【${modLabel}】在段落【${passageName}】中未找到匹配目标。原因可能是多个模组修改了同一文本，或模组未适配当前游戏版本。`;
                solution = '建议：1. 执行【智能整理模组与美化顺序】调整加载次序；2. 若出现异常，可在【还原点】中恢复配置。若大部分补丁已匹配，通常仅影响局部选项。';
            } else {
                desc = '补丁未能找到匹配的文本目标。原因可能是多个模组修改了同一位置，或模组未适配当前游戏版本。';
                solution = '建议：1. 执行【智能整理模组与美化顺序】；2. 若仍有异常，检查模组与当前游戏版本的兼容性。';
            }

            return {
                id: 'twee-patch-mismatch',
                title: 'TweeReplacer 补丁文本未匹配',
                desc,
                solution
            };
        }
    },
    {
        id: 'npc-pregnancy-init-error',
        title: 'NPC 怀孕系统或开局变量未初始化',
        keywords: ['npcpregnancyupdater', 'c.npc[$_name]', 'setup.pregnancy', 'pregnancyavoidance', 'incompletepregnancyenabled', "reading 'pregnancy'"],
        resolve: line => {
            if (!modHubIsNpcPregnancyInitFailure(line)) return null;

            // 检查已安装模组中是否存在相关的机制模组
            const knownMods = window.modHubGetAllKnownModNames ? Array.from(window.modHubGetAllKnownModNames()) : [];
            const relatedKeywords = ['fertility', 'pregnancy', 'sims', '生育', '模拟人生', 'babyhawk', '育雏'];
            const detectedRelatedMods = knownMods.filter(name => {
                const lower = String(name).toLowerCase();
                const alias = (window.modHubFindKnownAlias ? window.modHubFindKnownAlias(name) : '').toLowerCase();
                return relatedKeywords.some(kw => lower.includes(kw) || alias.includes(kw));
            }).map(name => {
                const friendly = window.modHubFindKnownAlias ? window.modHubFindKnownAlias(name) : '';
                return friendly && friendly !== name ? `${friendly} (${name})` : name;
            });

            const desc = '游戏在段落【Start】执行宏【<<npcPregnancyUpdater>>】时，因相关变量未初始化导致读取失败。原因可能是多个修改 NPC 或生育机制的模组同时存在，导致初始化时序冲突或代码被覆盖。';

            let solution = '';
            if (detectedRelatedMods.length > 0) {
                solution = `已检测到相关模组：【${detectedRelatedMods.join('】、【')}】。建议：1. 禁用其中一个机制模组（如生育拓展或模拟人生）以排查冲突；2. 尝试新建游戏开档，确认是否为旧存档字段不兼容；3. 在【还原点】中恢复之前的配置。`;
            } else {
                solution = '建议：1. 禁用近期添加的机制类模组以排查冲突；2. 尝试新建游戏开档，确认是否为旧存档字段不兼容；3. 在【还原点】中恢复之前的配置。';
            }

            return {
                id: 'npc-pregnancy-init-error',
                title: 'NPC 怀孕系统或开局变量未初始化',
                desc,
                solution
            };
        }
    },
    {
        id: 'patch-conflict',
        title: '模组补丁冲突或目标未找到',
        keywords: ['patchmodtogame', 'replacepatcher', 'replace target', 'replace error', 'patch failed', 'duplicate', 'already exists'],
        desc: '补丁未能成功应用到游戏段落或脚本。原因可能是多个模组修改了同一内容，或模组版本与当前游戏不兼容。',
        solution: '建议：1. 执行【智能整理模组与美化顺序】优化加载次序；2. 若仍有错误，检查模组与当前游戏版本的兼容性。'
    },
    {
        id: 'syntax-error',
        title: '代码语法错误 / 压缩包损坏',
        keywords: ['syntaxerror', 'unexpected token', 'unexpected identifier', 'invalid or unexpected token'],
        desc: '模组脚本语法解析失败。原因可能是脚本本身存在语法错误，或文件在下载解压过程中损坏。',
        solution: '建议：1. 重新下载并安装最近添加的模组；2. 若问题仍存在，请向模组作者反馈。'
    },
    {
        id: 'type-error',
        title: '脚本未定义异常 (TypeError)',
        keywords: ['typeerror', 'cannot read properties of', 'cannot read property', 'is not a function', 'is undefined'],
        desc: '脚本尝试访问未定义的对象或方法。原因可能是前置依赖缺失、加载顺序不当，或模组未适配当前游戏版本。',
        solution: '建议：1. 检查并将基础前置模组移至前面优先加载；2. 确认相关模组是否与当前游戏版本兼容。'
    },
    {
        id: 'boot-json-error',
        title: '模组清单配置 (boot.json) 异常',
        keywords: ['boot.json', 'invalid json', 'json.parse', 'missing name in boot.json', 'format error'],
        desc: '模组清单文件 (boot.json) 损坏、缺失关键字段或 JSON 格式无效。',
        solution: '建议：1. 重新下载该模组的安装包；2. 若曾手动修改过模组，请检查 boot.json 是否符合标准 JSON 格式。'
    },
    {
        id: 'storage-quota',
        title: '本地存储空间超限 (QuotaExceeded)',
        keywords: ['quotaexceedederror', 'indexeddb', 'storage quota', 'database error'],
        desc: '旁加载模组数据超出了浏览器 IndexedDB 存储配额上限。',
        solution: '建议：在模组管理中删除未使用的大型旁加载模组，或改用独立微端运行游戏。'
    },
    {
        id: 'asset-missing',
        title: '图片或多媒体资源加载失败',
        keywords: ['404', 'failed to load resource', 'img/', 'image pack'],
        desc: '资源文件无法加载。可能由于文件缺失、路径无效或未正确解压引起。',
        solution: '建议：1. 根据日志中记录的路径检查对应资源文件是否存在；2. 检查所用美化或图片包是否已正确启用且与当前游戏版本匹配。'
    }
];

// 获取环境中已知的所有模组名称集合
window.modHubGetAllKnownModNames = function() {
    const modSet = new Set();
    const gui = window.modHubGetGui();
    if (gui?.gModUtils?.getModListNameNoAlias) {
        try {
            const list = gui.gModUtils.getModListNameNoAlias();
            if (Array.isArray(list)) list.forEach(n => n && modSet.add(n));
        } catch (_) {}
    }
    if (window._modHubModState) {
        (window._modHubModState.sideEnabled || []).forEach(m => {
            const name = typeof m === 'string' ? m : m?.name;
            if (name) modSet.add(name);
        });
        (window._modHubModState.sideDisabled || []).forEach(m => {
            const name = typeof m === 'string' ? m : m?.name;
            if (name) modSet.add(name);
        });
        (window._modHubModState.builtInMods || []).forEach(name => {
            if (name) modSet.add(name);
        });
    }
    return modSet;
};

// 统一原版 ModLoader 加载日志与控制台异常获取引擎
window.modHubGetRawModLoaderLogs = function() {
    const gui = window.modHubGetGui ? window.modHubGetGui() : null;
    const modLoaderLogs = [];

    // 1. 优先从原版 gui.gLoadingProgress.logList 结构化数据提取（这是原版 ModLoader 存储的真实数据源）
    if (Array.isArray(gui?.gLoadingProgress?.logList) && gui.gLoadingProgress.logList.length > 0) {
        gui.gLoadingProgress.logList.forEach(item => {
            const timeStr = item.time?.format ? item.time.format('HH:mm:ss.SSS') : (item.time ? String(item.time) : '');
            const rawType = String(item.type || '').toLowerCase();
            const level = rawType === 'error' ? 'error' : (rawType === 'warning' || rawType === 'warn' ? 'warn' : 'info');
            modLoaderLogs.push({
                time: timeStr,
                level,
                message: String(item.str || item.message || '').trim()
            });
        });
    } else if (typeof gui?.gLoadingProgress?.getLoadLog === 'function') {
        // 2. 次优：从 gui.gLoadingProgress.getLoadLog() 字符串数组提取
        try {
            const lines = gui.gLoadingProgress.getLoadLog();
            if (Array.isArray(lines) && lines.length > 0) {
                lines.forEach(line => {
                    const lineStr = String(line || '').trim();
                    if (!lineStr) return;
                    let timeStr = '';
                    let level = 'info';
                    let message = lineStr;
                    const m = lineStr.match(/^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\[(error|warning|warn|info)\]\s*(.*)$/i);
                    if (m) {
                        timeStr = m[1];
                        const t = m[2].toLowerCase();
                        level = t === 'error' ? 'error' : (t.startsWith('warn') ? 'warn' : 'info');
                        message = m[3];
                    }
                    modLoaderLogs.push({ time: timeStr, level, message });
                });
            }
        } catch (_) {}
    } else if (typeof gui?.gLoadingProgress?.getLoadLogHtml === 'function') {
        // 3. 再次：从 gui.gLoadingProgress.getLoadLogHtml() 提取（兼容 DOM 元素数组或 HTML 字符串）
        try {
            const raw = gui.gLoadingProgress.getLoadLogHtml();
            if (Array.isArray(raw)) {
                raw.forEach((node, idx) => {
                    const text = node?.innerText || node?.textContent || '';
                    if (!text) return;
                    if (idx === 0 && /error,\s*\d+\s*warning/i.test(text)) return;
                    let level = 'info';
                    if (node?.style?.color === 'red' || /error/i.test(node?.className || '')) level = 'error';
                    else if (node?.style?.color === 'orange' || /warn/i.test(node?.className || '')) level = 'warn';

                    let timeStr = '';
                    let message = text;
                    const tm = text.match(/^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(.*)$/);
                    if (tm) {
                        timeStr = tm[1];
                        message = tm[2];
                    }
                    modLoaderLogs.push({ time: timeStr, level, message });
                });
            } else if (typeof raw === 'string' && raw.trim()) {
                const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                lines.forEach(l => {
                    modLoaderLogs.push({ time: '', level: 'info', message: l });
                });
            }
        } catch (_) {}
    }

    // 4. 兜底：从 modModLoadController.logRecordBeforeAnyLogHookRegister 提取
    if (!modLoaderLogs.length) {
        const controller = window.modHubGetController ? window.modHubGetController() : null;
        if (Array.isArray(controller?.logRecordBeforeAnyLogHookRegister)) {
            controller.logRecordBeforeAnyLogHookRegister.forEach(item => {
                const timeStr = item.time?.format ? item.time.format('HH:mm:ss.SSS') : '';
                const rawType = String(item.type || '').toLowerCase();
                const level = rawType === 'error' ? 'error' : (rawType === 'warning' || rawType === 'warn' ? 'warn' : 'info');
                modLoaderLogs.push({
                    time: timeStr,
                    level,
                    message: String(item.message || item.str || '').trim()
                });
            });
        }
    }

    const result = [];
    const seenConsole = new Set();

    // 5. 合并早期恢复模块与常规捕获器的启动日志，保留原版日志未收录的条目。
    let earlyLogs = [];
    try {
        const captured = window.modHubRestore?.getStartupLogs?.();
        if (Array.isArray(captured)) earlyLogs = captured;
    } catch (_) {}
    const startupLogs = [...(Array.isArray(window._modHubStartupErrors) ? window._modHubStartupErrors : []), ...earlyLogs];
    startupLogs.forEach(err => {
        const rawMsg = String(typeof err === 'string' ? err : (err?.message || err?.str || '')).trim();
        if (!rawMsg) return;
        const rawLevel = typeof err === 'object' ? err?.level : 'error';
        const level = rawLevel === 'warning' ? 'warn' : (['info', 'warn', 'error'].includes(rawLevel) ? rawLevel : 'error');
        const cleanMsg = rawMsg.replace(/^\[(?:控制台报错|脚本异常|异步异常)\]\s*/, '').trim();
        if (!cleanMsg || seenConsole.has(cleanMsg)) return;
        seenConsole.add(cleanMsg);
        const cleanLower = cleanMsg.toLowerCase();

        // 过滤良性降级异常
        if (cleanLower.includes('modlist.json') || cleanLower.includes('resizeobserver') || cleanLower.includes('duplicate name')) {
            return;
        }

        // 比对 ModLoader 日志中是否已收录该错误（若已有则丢弃控制台重复条目）
        const isDuplicate = modLoaderLogs.some(l => {
            const lMsg = String(l.message || '');
            const lLower = lMsg.toLowerCase();
            if (lMsg && (lMsg.includes(cleanMsg) || cleanMsg.includes(lMsg))) return true;
            if (cleanLower.includes('checkgameversion() not satisfies') && lLower.includes('checkgameversion() not satisfies')) {
                const m1 = cleanMsg.match(/\["([^"]+)"/);
                const m2 = lMsg.match(/mod\[([^\]]+)\]/);
                if (m1 && m2 && m1[1] === m2[1]) return true;
                if (!m1 && !m2) return true;
            }
            return false;
        });

        if (!isDuplicate) {
            result.push({
                time: typeof err?.time === 'number' ? new Date(err.time).toLocaleTimeString('zh-CN', { hour12: false }) : err?.time || '',
                level,
                message: rawMsg,
                isConsoleError: true
            });
        }
    });

    // 6. 追加原版 ModLoader 真实日志
    modLoaderLogs.forEach(item => result.push(item));

    return result;
};

// 日志分析核心引擎（支持结构化行对象数组或原始文本）
window.modHubAnalyzeLogs = function(rawContent) {
    if (!rawContent) {
        return {
            lines: [],
            errorCount: 0,
            warnCount: 0,
            infoCount: 0,
            errorMods: [],
            errorFiles: [],
            matchedIssues: [],
            firstErrorIndex: -1
        };
    }

    const allKnownMods = [...window.modHubGetAllKnownModNames()].filter(name => typeof name === 'string' && name)
        .sort((a, b) => b.length - a.length)
        .map(name => [name, new RegExp(`(^|[^\\p{L}\\p{N}_'’-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_'’-])`, 'gu')]);
    const parsedLines = [];
    const errorMods = new Set();
    const errorFiles = new Set();
    const matchedIssuesMap = new Map();
    let errorCount = 0;
    let warnCount = 0;
    let infoCount = 0;
    let firstErrorIndex = -1;

    // 统一拆解为行队列
    let items = [];
    if (Array.isArray(rawContent)) {
        items = rawContent.map(item => {
            if (typeof item === 'string') return { time: '', level: 'info', message: item };
            return {
                time: item?.time || '',
                level: item?.level || 'info',
                message: String(item?.message || item?.str || '')
            };
        });
    } else {
        let text = String(rawContent);
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/div>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        const entities = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' };
        for (let i = 0; i < 2; i++) {
            text = text.replace(/&(amp|quot|#39|apos|lt|gt);/gi, entity => entities[entity.slice(1, -1).toLowerCase()] || entity);
        }
        const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        items = rawLines.map(line => ({ time: '', level: 'info', message: line }));
    }

    items.forEach((item, index) => {
        let line = item.message;
        let timeStr = item.time;
        if (!timeStr) {
            const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|\[\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2})/);
            if (timeMatch) timeStr = timeMatch[1];
        }

        let level = item.level || 'info';
        const lineLower = line.toLowerCase();
        const isExplicitError = level === 'error' ||
            line.includes('[[logError]]') ||
            line.includes('[ERROR]') ||
            line.includes('[错误]') ||
            line.includes('[控制台报错]') ||
            line.includes('[脚本异常]') ||
            line.includes('[异步异常]') ||
            lineLower.includes('logerror') ||
            line.includes('Error:') ||
            line.includes('error:') ||
            line.includes('cannot find findString') ||
            line.includes('not satisfies') ||
            (line.includes('errorCount:[') && !line.includes('errorCount:[0]'));

        const isExplicitWarn = !isExplicitError && (
            level === 'warn' ||
            level === 'warning' ||
            line.includes('[[logWarning]]') ||
            line.includes('[WARN]') ||
            line.includes('[WARNING]') ||
            line.includes('[警告]') ||
            line.includes('[控制台警告]') ||
            lineLower.includes('logwarning') ||
            line.includes('Warning:') ||
            line.includes('warning:') ||
            line.includes('duplicate name') ||
            (line.includes('warningCount:[') && !line.includes('warningCount:[0]'))
        );

        if (isExplicitError) {
            level = 'error';
            errorCount++;
            if (firstErrorIndex === -1) firstErrorIndex = index;
        } else if (isExplicitWarn) {
            level = 'warn';
            warnCount++;
        } else {
            level = 'info';
            infoCount++;
        }

        // 清理正文中的原始级别标签
        let cleanMsg = line;
        cleanMsg = cleanMsg.replace(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|\[\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2})\s*/, '');
        cleanMsg = cleanMsg.replace(/\[\[log(?:Error|Warning|Info)\]\]\s*/g, '');
        cleanMsg = cleanMsg.replace(/^\[(?:ERROR|WARN|WARNING|INFO|错误|警告|信息)\]\s*/i, '');

        // 提取模组名
        const foundModsInLine = new Set();
        const modRegexes = [
            /(?:mod|id|Mod|MOD)\s*\[([^\]]+)\]/g,
            /(?:modName|mod_name|mod)\s*[:=]\s*"([^"]+)"/gi,
            /(?:modName|mod_name|mod)[\s:=]+([A-Za-z0-9_\-\u4e00-\u9fa5]+)(?=\s*[,;]|$)/g,
            /on mod\[([^\]]+)\]/g,
            /(?:cannot find (?:findString|findRegex)|do_patch\(\) done):\s*\[([^\]]+)\]/gi,
            /\[(TweeReplacer)\]/g
        ];
        modRegexes.forEach(reg => {
            let m;
            while ((m = reg.exec(cleanMsg)) !== null) {
                const candidate = m[1].trim();
                if (candidate && candidate.length > 1 && !candidate.startsWith('<') && !['info', 'warn', 'error', 'null', 'undefined'].includes(candidate.toLowerCase())) {
                    foundModsInLine.add(candidate);
                }
            }
        });

        // 补丁正文可能包含代码或其他名称，仅使用真正的补丁来源字段。
        if (!/cannot find (?:findString|findRegex):|do_patch\(\) done:/i.test(cleanMsg)) {
            let nameText = cleanMsg;
            for (const [known, pattern] of allKnownMods) {
                nameText = nameText.replace(pattern, (_, prefix) => {
                    foundModsInLine.add(known);
                    return prefix + ' '.repeat(known.length);
                });
            }
        }

        // 提取文件名与段落名
        const foundFilesInLine = new Set();
        const fileRegex = /([a-zA-Z0-9_\-\u4e00-\u9fa5./\\]+\.(?:js|twee|json|png|gif|css|zip|html))/gi;
        let fm;
        while ((fm = fileRegex.exec(cleanMsg)) !== null) {
            const fileName = fm[1].trim();
            if (!fileName.startsWith('http') && !fileName.endsWith('.com')) {
                foundFilesInLine.add(fileName);
            }
        }
        const passageRegex = /(?:in|passage):\s*\[([^\]]+)\]/gi;
        let pm;
        while ((pm = passageRegex.exec(cleanMsg)) !== null) {
            const passageName = pm[1].trim();
            if (passageName && !['info', 'warn', 'error'].includes(passageName.toLowerCase())) {
                foundFilesInLine.add(passageName);
            }
        }

        // 提取 SugarCube 报错段落名，如 (:: Start)
        const sugarCubePassageRegex = /\(\s*::\s*([^):]+?)\s*\)/g;
        let scpm;
        while ((scpm = sugarCubePassageRegex.exec(cleanMsg)) !== null) {
            const passageName = scpm[1].trim();
            if (passageName && !['info', 'warn', 'error'].includes(passageName.toLowerCase())) {
                foundFilesInLine.add(passageName);
            }
        }

        // 提取 Widget/宏报错名称，如 <<npcPregnancyUpdater>>: error within widget code
        if (cleanMsg.includes('error within widget code') || cleanMsg.includes('<<widget')) {
            const widgetErrorRegex = /<<([a-zA-Z0-9_\-]+)>>/gi;
            let wem;
            while ((wem = widgetErrorRegex.exec(cleanMsg)) !== null) {
                const widgetName = wem[1].trim();
                const builtInMacros = ['if', 'else', 'elseif', 'endif', 'set', 'unset', 'switch', 'case', 'default', 'for', 'break', 'continue', 'link', 'button'];
                if (widgetName && !builtInMacros.includes(widgetName.toLowerCase())) {
                    foundFilesInLine.add(`<<${widgetName}>>`);
                }
            }
        }

        const foundIssueIdsInLine = new Set();
        // 如果是错误行，归纳并匹配知识库
        if (level === 'error') {
            foundModsInLine.forEach(m => errorMods.add(m));
            foundFilesInLine.forEach(f => errorFiles.add(f));

            const isWeatherImageFailure = modHubIsWeatherImageFailure(cleanMsg);
            const isPregnancyInitFailure = modHubIsNpcPregnancyInitFailure(cleanMsg);
            MODHUB_ERROR_PATTERNS.forEach(pattern => {
                // 特定天气行使用图像诊断，独立的其他 TypeError 和资源错误仍照常保留。
                if (isWeatherImageFailure && ['type-error', 'asset-missing'].includes(pattern.id)) return;
                // NPC 怀孕系统初始化异常使用专项诊断，避免混入宽泛的普通 TypeError。
                if (isPregnancyInitFailure && pattern.id === 'type-error') return;
                if (pattern.keywords.some(kw => lineLower.includes(kw.toLowerCase()))) {
                    const issue = typeof pattern.resolve === 'function' ? pattern.resolve(cleanMsg) : pattern;
                    if (issue) {
                        foundIssueIdsInLine.add(issue.id);
                        if (!matchedIssuesMap.has(issue.id) ||
                            (matchedIssuesMap.get(issue.id).isSummary && !issue.isSummary)) {
                            matchedIssuesMap.set(issue.id, issue);
                        }
                    }
                }
            });
        }

        parsedLines.push({
            index,
            time: timeStr,
            level,
            message: cleanMsg,
            mods: Array.from(foundModsInLine),
            files: Array.from(foundFilesInLine),
            issueIds: Array.from(foundIssueIdsInLine)
        });
    });

    return {
        lines: parsedLines,
        errorCount,
        warnCount,
        infoCount,
        errorMods: Array.from(errorMods),
        errorFiles: Array.from(errorFiles),
        matchedIssues: Array.from(matchedIssuesMap.values()),
        firstErrorIndex
    };
};

// 置顶诊断卡片渲染
window.modHubRenderLogDiagnosis = function(analysis) {
    const container = document.getElementById('modHubLogDiagnosisContainer');
    if (!container) return;

    const autoOpenEnabled = window.modHubIsAutoOpenErrorLogEnabled();

    if (!analysis || analysis.errorCount === 0) {
        container.onclick = null;
        container.innerHTML = `
            <div class="childItem modhub-diagnosis-card diag-normal">
                <div class="modhub-diag-header">
                    <div class="modhub-diag-title green">
                        [正常] 模组加载流程正常，未检测到加载错误
                    </div>
                    <label class="modhub-checkbox-label" title="开启后，若下次游戏启动加载模组发生错误将自动弹出本窗口">
                        <input type="checkbox" id="toggleAutoOpenErrorLog" class="macro-checkbox" ${autoOpenEnabled ? 'checked' : ''} onchange="window.modHubToggleAutoOpenLogSetting(this.checked)" />
                        <span>加载出错时自动弹窗</span>
                    </label>
                </div>
            </div>
        `;
        return;
    }

    let html = `
        <div class="childItem modhub-diagnosis-card diag-error">
            <div class="modhub-diag-header">
                <div class="modhub-diag-heading">
                    <div class="modhub-diag-title red">模组加载异常快速诊断</div>
                    <div class="modhub-diag-count grey">发现 ${analysis.errorCount} 条错误日志</div>
                </div>
                <div class="modhub-diag-actions">
                    <button type="button" class="macro-button modhub-btn-primary modhub-btn-locate" onclick="window.modHubScrollToFirstError()">定位首处错误</button>
                    <button type="button" class="macro-button modhub-btn-locate" data-log-help-first="true">获取帮助</button>
                </div>
            </div>
    `;

    // 报错关联模组徽章
    if (analysis.errorMods.length > 0) {
        html += `
            <div class="modhub-diag-row">
                <span class="grey diag-label">报错关联模组：</span>
                <div class="modhub-diag-mod-list">
                    ${analysis.errorMods.map((modName, modIndex) => {
                        const friendly = window.modHubFindKnownAlias(modName);
                        const label = friendly && friendly !== modName ? `${friendly} (${modName})` : modName;
                        return `
                            <div class="modhub-diag-mod">
                                <button type="button" class="modhub-diag-badge mod-badge" data-log-search="${window.modHubEscapeHtml(modName)}" title="点击在日志中筛选此模组">
                                    [模组] ${window.modHubEscapeHtml(label)}
                                </button>
                                <button type="button" class="modhub-diag-badge modhub-diag-help" data-log-help-mod="${modIndex}">分析此问题</button>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    html += '<div class="modhub-diag-note grey">点击“获取帮助”预览错误日志和模组源码，确认后发送给 AI 分析。</div>';

    // 报错关联文件/段落徽章
    if (analysis.errorFiles.length > 0) {
        html += `
            <div class="modhub-diag-row">
                <span class="grey diag-label">报错关联文件/段落：</span>
                <div class="diag-badges">
                    ${analysis.errorFiles.map(fileName => {
                        const isFile = /\.(?:js|twee|json|png|gif|css|zip|html)$/i.test(fileName);
                        const isWidget = /^<<.*>>$/.test(fileName);
                        const tag = isFile ? '[文件]' : (isWidget ? '[宏]' : '[段落]');
                        const searchTerm = isWidget ? fileName.slice(2, -2) : fileName;
                        return `
                            <button type="button" class="modhub-diag-badge file-badge" data-log-search="${window.modHubEscapeHtml(searchTerm)}" title="点击在日志中筛选此${isFile ? '文件' : (isWidget ? '宏' : '段落')}">
                                ${tag} ${window.modHubEscapeHtml(fileName)}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // 原因分析与排查建议
    if (analysis.matchedIssues.length > 0) {
        html += `
            <div class="modhub-diag-issues">
                <div class="grey diag-label">原因分析与排查建议：</div>
                ${analysis.matchedIssues.map(issue => `
                    <div class="modhub-issue-item">
                        <div class="issue-title gold">【${window.modHubEscapeHtml(issue.title)}】</div>
                        <div class="issue-desc grey">${window.modHubEscapeHtml(issue.desc)}</div>
                        <div class="issue-solution"><span class="green">[排查建议]</span> ${window.modHubEscapeHtml(issue.solution)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        html += `
            <div class="modhub-diag-issues">
                <div class="modhub-issue-item">
                    <div class="issue-title gold">【未分类的错误日志】</div>
                    <div class="issue-desc grey">控制台或加载器记录了错误信息，尚未匹配到专项诊断。是否影响游戏，需要结合原始日志和调用上下文确认。</div>
                    <div class="issue-solution"><span class="green">[排查建议]</span> 请点击上方“定位首处错误”查看完整内容，并保留相关日志排查。</div>
                </div>
            </div>
        `;
    }

    // 底部控制开关
    html += `
            <div class="modhub-diag-footer">
                <label class="modhub-checkbox-label" title="开启后，若下次游戏启动检测到加载错误将自动打开日志窗口并定位">
                    <input type="checkbox" id="toggleAutoOpenErrorLog" class="macro-checkbox" ${autoOpenEnabled ? 'checked' : ''} onchange="window.modHubToggleAutoOpenLogSetting(this.checked)" />
                    <span>游戏启动检测到加载错误时自动打开日志窗口并定位 <span class="gold">(默认开启，可在此关闭)</span></span>
                </label>
            </div>
        </div>
    `;

    container.innerHTML = html;
    container.onclick = event => {
        const helpButton = event.target?.closest?.('[data-log-help-first], [data-log-help-mod]');
        if (helpButton) {
            if (typeof window.modHubHelp?.openProblem !== 'function') {
                window.modHubShowToast('帮助中心尚未就绪，请等待模组加载完成后重试。', 'warning');
                return;
            }
            const firstError = helpButton.dataset.logHelpFirst === 'true';
            const modName = firstError ? '' : analysis.errorMods[Number(helpButton.dataset.logHelpMod)];
            const line = (analysis.lines || []).find(item => item.level === 'error' && (firstError || item.mods?.includes(modName)));
            if (!line) {
                window.modHubShowToast('未找到对应错误原文，请重新加载日志后重试。', 'warning');
                return;
            }
            return window.modHubHelp.openProblem({ modName: modName || line.mods?.[0] || '', error: line.message });
        }
        const button = event.target?.closest?.('[data-log-search]');
        if (button) window.modHubSetLogSearch(button.dataset.logSearch);
    };
};

// 结构化日志正文渲染
window.modHubRenderStructuredLogs = function(container, lines) {
    if (!container) return;
    if (!lines || lines.length === 0) {
        container.innerHTML = '<div class="mod-empty grey">暂无加载日志内容</div>';
        return;
    }

    let html = '<div class="modhub-log-stream">';
    lines.forEach((item, index) => {
        const isFirstErr = (item.level === 'error' && index === window._modHubFirstErrorIndex);
        const rowId = isFirstErr ? 'id="modHubFirstError"' : '';
        const levelClass = item.level === 'error' ? 'log-row-error' : (item.level === 'warn' ? 'log-row-warn' : 'log-row-info');
        const badgeLabel = item.level === 'error' ? '[错误]' : (item.level === 'warn' ? '[警告]' : '[信息]');
        const badgeClass = item.level === 'error' ? 'log-badge-error' : (item.level === 'warn' ? 'log-badge-warn' : 'log-badge-info');

        html += `
            <div class="modhub-log-row ${levelClass}" ${rowId} data-level="${item.level}" data-line-index="${index}">
                <span class="modhub-log-time grey">${window.modHubEscapeHtml(item.time || '')}</span>
                <span class="modhub-log-badge ${badgeClass}">${badgeLabel}</span>
                <span class="modhub-log-msg">${window.modHubEscapeHtml(item.message)}</span>
            </div>
        `;
    });
    html += '</div>';

    container.innerHTML = html;
};

// 按级别（警告/错误）快速跳转并高亮定位（支持多处循环跳转）
window.modHubJumpToLevel = function(level) {
    const log = document.getElementById('modHubLogContent');
    if (!log) return;

    const normLevel = (level === 'warning' || level === 'warn') ? 'warn' : 'error';
    const targetClass = normLevel === 'warn' ? 'log-row-warn' : 'log-row-error';
    const label = normLevel === 'warn' ? '警告' : '错误';
    const rows = Array.from(log.querySelectorAll(`.modhub-log-row.${targetClass}`));

    if (!rows.length) {
        window.modHubShowToast(`未在日志中检测到【${label}】项`, 'info');
        return;
    }

    window._modHubLevelJumpIndex = window._modHubLevelJumpIndex || {};
    if (window._modHubLevelJumpIndex[normLevel] === undefined) {
        window._modHubLevelJumpIndex[normLevel] = 0;
    } else {
        window._modHubLevelJumpIndex[normLevel] = (window._modHubLevelJumpIndex[normLevel] + 1) % rows.length;
    }

    const currentIdx = window._modHubLevelJumpIndex[normLevel];
    const targetRow = rows[currentIdx];

    // 清除其他行活跃样式并为当前行添加脉冲高亮
    log.querySelectorAll('.modhub-log-row').forEach(r => r.classList.remove('active', 'modhub-highlight-pulse'));
    targetRow.classList.add('active', 'modhub-highlight-pulse');

    // 内层滚动：将错误行在日志容器内垂直居中
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });

    window.modHubShowToast(`已定位至【${label}】(${currentIdx + 1}/${rows.length})`, normLevel === 'error' ? 'warning' : 'info');

    setTimeout(() => {
        targetRow.classList.remove('modhub-highlight-pulse');
    }, 2500);
};

// 定位到第一个错误
window.modHubScrollToFirstError = function() {
    window._modHubLevelJumpIndex = window._modHubLevelJumpIndex || {};
    window._modHubLevelJumpIndex['error'] = -1;
    window.modHubJumpToLevel('error');
};

// 判定游戏启动生命周期是否已正式结束且通道就绪（严禁在遮罩加载期提前弹出半成品日志）
window.modHubIsGameStartupReady = function() {
    if (window._modHubForceStartupErrorOpen) return true;
    if (typeof document === 'undefined') return true;

    // 1. 检查启动遮罩 #init-screen 是否仍然可见（处于模组与游戏加载阶段）
    const initScreen = document.getElementById('init-screen');
    if (initScreen) {
        if (typeof window.getComputedStyle === 'function') {
            try {
                const style = window.getComputedStyle(initScreen);
                if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return false;
                }
            } catch (_) {}
        } else {
            return false;
        }
    }

    // 2. 检查 customOverlay 容器是否已挂载
    const overlay = document.getElementById('customOverlay');
    if (!overlay) return false;

    // 3. 检查游戏引擎是否已经就绪进入通道（针对 SugarCube 运行时环境）
    if (typeof SugarCube !== 'undefined' && SugarCube.State) {
        if (!SugarCube.State.passage) return false;
    }

    return true;
};

// 启动时检测加载错误并自动弹窗（严格与日志分析器自洽）
window.modHubCheckAndAutoOpenErrorLog = function() {
    if (!window.modHubIsAutoOpenErrorLogEnabled()) return false;
    if (window._modHubErrorDialogShown) return false;

    // 1. 获取最新日志流并做统一错误分析
    const rawLogs = typeof window.modHubGetRawModLoaderLogs === 'function' ? window.modHubGetRawModLoaderLogs() : null;
    let hasError = false;

    if (rawLogs && rawLogs.length > 0) {
        const analysis = window.modHubAnalyzeLogs(rawLogs);
        if (analysis && analysis.errorCount > 0) {
            hasError = true;
        }
    }

    // 2. 补充检查控制台捕获的严重启动错误
    if (!hasError && Array.isArray(window._modHubStartupErrors) && window._modHubStartupErrors.length > 0) {
        hasError = true;
    }

    // 若无任何错误，绝对不自动弹窗，避免误打扰正常玩家
    if (!hasError) return false;

    // 标记系统已检测到启动错误
    window._modHubHasDetectedStartupError = true;

    // 严禁在游戏启动遮罩加载中途强行呼出半成品日志弹窗
    if (!window.modHubIsGameStartupReady()) {
        window._modHubPendingAutoOpenErrorLog = true;
        return false;
    }

    // 尝试呼出模组错误日志弹窗
    const opened = window.modHubOpenManager('加载日志', { scrollToError: true });
    if (opened) {
        window._modHubErrorDialogShown = true;
        window._modHubPendingAutoOpenErrorLog = false;
        return true;
    } else {
        window._modHubPendingAutoOpenErrorLog = true;
        return false;
    }
};

window.modHubFindTextOffsets = function(text, query) {
    const source = String(text || '').toLocaleLowerCase();
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return [];

    const offsets = [];
    let index = 0;
    while ((index = source.indexOf(needle, index)) !== -1) {
        offsets.push(index);
        index += needle.length;
    }
    return offsets;
};

window.modHubMoveLogMatch = function(delta = 0) {
    const matches = window._modHubLogMatches || [];
    const status = document.getElementById('modHubLogSearchStatus');
    if (!matches.length) {
        if (status) status.textContent = '0/0';
        return;
    }

    window._modHubLogMatchIndex = ((window._modHubLogMatchIndex || 0) + delta + matches.length) % matches.length;
    matches.forEach((match, index) => match.classList.toggle('active', index === window._modHubLogMatchIndex));
    const activeMatch = matches[window._modHubLogMatchIndex];
    if (activeMatch && typeof activeMatch.scrollIntoView === 'function') {
        activeMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        activeMatch.classList.add('modhub-highlight-pulse');
        setTimeout(() => activeMatch.classList.remove('modhub-highlight-pulse'), 1800);
    }
    if (status) status.textContent = `${window._modHubLogMatchIndex + 1}/${matches.length}`;
};

window.modHubSearchLoadLog = function(query) {
    const log = document.getElementById('modHubLogContent');
    if (!log) return;
    if (window._modHubLogOriginalHtml === undefined) window._modHubLogOriginalHtml = log.innerHTML;
    log.innerHTML = window._modHubLogOriginalHtml;

    const needle = String(query || '').trim();
    if (!needle) {
        window._modHubLogMatches = [];
        window._modHubLogMatchIndex = 0;
        window.modHubMoveLogMatch();
        return;
    }

    // 智能别名映射：如果搜索词是 logWarning 或 logError，自动匹配对应的行
    const needleLower = needle.toLowerCase();
    if (needleLower === 'logwarning' || needleLower === 'warning' || needle === '警告') {
        window.modHubJumpToLevel('warn');
        return;
    }
    if (needleLower === 'logerror' || needleLower === 'error' || needle === '错误') {
        window.modHubJumpToLevel('error');
        return;
    }

    const matches = [];
    const walker = document.createTreeWalker(log, 4);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(node => {
        const offsets = window.modHubFindTextOffsets(node.data, needle);
        if (!offsets.length) return;

        const fragment = document.createDocumentFragment();
        let cursor = 0;
        offsets.forEach(offset => {
            fragment.append(document.createTextNode(node.data.slice(cursor, offset)));
            const mark = document.createElement('mark');
            mark.className = 'modhub-log-match';
            mark.textContent = node.data.slice(offset, offset + needle.length);
            fragment.append(mark);
            matches.push(mark);
            cursor = offset + needle.length;
        });
        fragment.append(document.createTextNode(node.data.slice(cursor)));
        node.parentNode.replaceChild(fragment, node);
    });

    window._modHubLogMatches = matches;
    window._modHubLogMatchIndex = 0;
    window.modHubMoveLogMatch();
};

window.modHubSetLogSearch = function(query) {
    const q = String(query || '').trim();
    const qLower = q.toLowerCase();
    if (qLower === 'logwarning' || qLower === 'warning' || q === '警告') {
        window.modHubJumpToLevel('warn');
        return;
    }
    if (qLower === 'logerror' || qLower === 'error' || q === '错误') {
        window.modHubJumpToLevel('error');
        return;
    }
    const input = document.getElementById('modHubLogSearch');
    if (input) input.value = q;
    window.modHubSearchLoadLog(q);
};

window.modHubInitLogTools = function() {
    const log = document.getElementById('modHubLogContent');
    const input = document.getElementById('modHubLogSearch');
    if (!log) return;

    // 1. 获取并深度分析加载日志（优先从结构化原版日志流与控制台异常获取）
    const rawLogs = typeof window.modHubGetRawModLoaderLogs === 'function' ? window.modHubGetRawModLoaderLogs() : null;
    const analysis = window.modHubAnalyzeLogs(rawLogs && rawLogs.length > 0 ? rawLogs : (log.innerHTML || ''));
    window._modHubLastLogAnalysis = analysis;
    window._modHubFirstErrorIndex = analysis.firstErrorIndex;

    // 2. 渲染置顶诊断卡片
    window.modHubRenderLogDiagnosis(analysis);

    // 3. 结构化渲染日志正文行
    if (analysis.lines.length > 0) {
        window.modHubRenderStructuredLogs(log, analysis.lines);
    } else {
        log.innerHTML = '<div class="mod-empty grey">暂无模组加载日志</div>';
    }

    // 4. 记录结构化后的原始 HTML 供搜索高亮
    window._modHubLogOriginalHtml = log.innerHTML;
    window._modHubLogMatches = [];
    window._modHubLogMatchIndex = 0;

    if (input) {
        input.oninput = () => window.modHubSearchLoadLog(input.value);
        input.onkeydown = event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            window.modHubMoveLogMatch(event.shiftKey ? -1 : 1);
        };
    }

    // 5. 更新状态栏统计按钮与筛选标签
    const errorCount = analysis.errorCount;
    const warningCount = analysis.warnCount;
    const errorButton = document.getElementById('modHubLogErrors');
    const warningButton = document.getElementById('modHubLogWarnings');
    const filterErrorBtn = document.getElementById('modHubFilterError');
    const filterWarnBtn = document.getElementById('modHubFilterWarn');

    if (errorButton) {
        if (errorCount > 0) {
            errorButton.innerHTML = `<span class="red" style="font-weight: bold;">错误 ${errorCount}</span>`;
            errorButton.classList.add('has-errors');
            errorButton.disabled = false;
        } else {
            errorButton.innerHTML = `<span class="grey">错误 0</span>`;
            errorButton.classList.remove('has-errors');
            errorButton.disabled = true;
        }
    }
    if (warningButton) {
        if (warningCount > 0) {
            warningButton.innerHTML = `<span class="gold" style="font-weight: bold;">警告 ${warningCount}</span>`;
            warningButton.classList.add('has-warnings');
            warningButton.disabled = false;
        } else {
            warningButton.innerHTML = `<span class="grey">警告 0</span>`;
            warningButton.classList.remove('has-warnings');
            warningButton.disabled = true;
        }
    }
    if (filterErrorBtn) {
        filterErrorBtn.textContent = errorCount > 0 ? `仅错误 (${errorCount})` : '仅错误 (0)';
    }
    if (filterWarnBtn) {
        filterWarnBtn.textContent = warningCount > 0 ? `仅警告 (${warningCount})` : '仅警告 (0)';
    }

    // 默认保持当前的筛选状态（若未设置则为全部）
    window.modHubSetLogLevelFilter(window._modHubCurrentLogLevelFilter || 'all');

    // 帮助中心指定的检索在日志渲染后只应用一次，优先于首错定位。
    if (typeof window._modHubPendingLogSearch === 'string' && window._modHubPendingLogSearch) {
        const query = window._modHubPendingLogSearch;
        window._modHubPendingLogSearch = null;
        window._modHubPendingScrollToFirstError = false;
        window.modHubSetLogLevelFilter('all');
        window.modHubSetLogSearch(query);
    } else if (window._modHubPendingScrollToFirstError) {
        window._modHubPendingScrollToFirstError = false;
        const navigation = window._modHubManagerNavigationRevision;
        setTimeout(() => {
            if (navigation !== window._modHubManagerNavigationRevision) return;
            if (typeof window.modHubScrollToFirstError === 'function') {
                window.modHubScrollToFirstError();
            }
        }, 60);
    }
};

/* =========================================================================
 * 5.1 日志全屏切换控制器
 * ========================================================================= */
window.modHubIsLogFullscreen = function() {
    if (typeof document === 'undefined') return false;
    const overlay = document.getElementById('customOverlay') || document.querySelector('.customOverlay');
    return overlay ? overlay.classList.contains('modhub-overlay-fullscreen') : false;
};

window.modHubToggleLogFullscreen = function(forceState = null) {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('customOverlay') || document.querySelector('.customOverlay');
    if (!overlay) return;
    const container = overlay.closest('.customOverlayContainer') || overlay.parentElement;

    const shouldBeFull = typeof forceState === 'boolean'
        ? forceState
        : !overlay.classList.contains('modhub-overlay-fullscreen');

    overlay.classList.toggle('modhub-overlay-fullscreen', shouldBeFull);
    if (container) {
        container.classList.toggle('modhub-container-fullscreen', shouldBeFull);
    }

    const btn = document.getElementById('btnToggleLogFullscreen');
    if (btn) {
        btn.textContent = shouldBeFull ? '还原窗口' : '全屏展示';
        btn.title = shouldBeFull ? '退出全屏模式 (Esc)' : '展开全屏模式';
        btn.classList.toggle('active', shouldBeFull);
        btn.classList.toggle('modhub-btn-primary', shouldBeFull);
        btn.classList.toggle('modhub-btn-secondary', !shouldBeFull);
    }
    if (typeof forceState !== 'boolean') {
        const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
        const hint = isTouch ? '点击上方“还原窗口”可随时退出' : '按 Esc 或点击“还原窗口”可随时退出';
        window.modHubShowToast(shouldBeFull ? `已开启日志全屏模式 (${hint})` : '已退出全屏模式', 'info');
    }
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && window.modHubIsLogFullscreen?.()) {
            e.stopPropagation();
            window.modHubToggleLogFullscreen(false);
        }
    }, true);
}

if (typeof $ !== 'undefined' && typeof $(document) !== 'undefined' && typeof $(document).on === 'function') {
    $(document).on(':oncloseoverlay', function() {
        window.modHubToggleLogFullscreen?.(false);
    });
    $(document).on('click', '#overlayTabs button, .customOverlayClose', function() {
        const text = $(this).text() || '';
        if (!text.includes('加载日志') && window.modHubIsLogFullscreen?.()) {
            window.modHubToggleLogFullscreen?.(false);
        }
    });
}

/* =========================================================================
 * 5.2 日志级别筛选控制器（全部 / 仅错误 / 仅警告 / 错误+警告）
 * ========================================================================= */
window._modHubCurrentLogLevelFilter = 'all';

window.modHubSetLogLevelFilter = function(filter) {
    const activeFilter = filter || 'all';
    window._modHubCurrentLogLevelFilter = activeFilter;
    if (typeof document === 'undefined') return;

    const log = document.getElementById('modHubLogContent');
    if (!log) return;

    log.classList.remove('filter-error-only', 'filter-warn-only', 'filter-issues-only');
    if (activeFilter === 'error') {
        log.classList.add('filter-error-only');
    } else if (activeFilter === 'warn') {
        log.classList.add('filter-warn-only');
    } else if (activeFilter === 'issues') {
        log.classList.add('filter-issues-only');
    }

    const filterBtns = document.querySelectorAll('.modhub-log-filter-btn');
    filterBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === activeFilter);
    });

    // 联动刷新搜索状态统计
    const searchInput = document.getElementById('modHubLogSearch');
    if (searchInput && searchInput.value.trim()) {
        window.modHubSearchLoadLog(searchInput.value.trim());
    } else {
        const rows = Array.from(log.querySelectorAll('.modhub-log-row'));
        const visibleCount = rows.filter(r => {
            if (activeFilter === 'error') return r.classList.contains('log-row-error');
            if (activeFilter === 'warn') return r.classList.contains('log-row-warn');
            if (activeFilter === 'issues') return r.classList.contains('log-row-error') || r.classList.contains('log-row-warn');
            return true;
        }).length;
        const status = document.getElementById('modHubLogSearchStatus');
        if (status) status.textContent = `0/${visibleCount}`;
    }
};

/* =========================================================================
 * 5.3 纯原生 Canvas 诊断长图生成与一键截图（剪贴板直贴 + 自动保存）
 * ========================================================================= */
window.modHubCaptureLogScreenshot = async function() {
    if (typeof document === 'undefined') return;
    const log = document.getElementById('modHubLogContent');
    if (!log) {
        window.modHubShowToast('未能找到日志内容', 'warning');
        return;
    }

    window.modHubShowToast('正在生成诊断长图...', 'info');

    // 1. 获取当前筛选状态下的全部可见行
    const allRows = Array.from(log.querySelectorAll('.modhub-log-row'));
    const activeFilter = window._modHubCurrentLogLevelFilter || 'all';
    let rows = allRows.filter(r => {
        if (activeFilter === 'error') return r.classList.contains('log-row-error');
        if (activeFilter === 'warn') return r.classList.contains('log-row-warn');
        if (activeFilter === 'issues') return r.classList.contains('log-row-error') || r.classList.contains('log-row-warn');
        return true;
    });

    if (!rows.length) {
        window.modHubShowToast('当前筛选条件下没有日志内容可截取', 'warning');
        return;
    }

    const maxRows = 100;
    const filteredRowCount = rows.length;
    const isTruncated = filteredRowCount > maxRows;
    rows = rows.slice(0, maxRows);

    const analysis = window._modHubLastLogAnalysis || window.modHubAnalyzeLogs?.(log.innerHTML) || {};
    const errCount = analysis.errorCount || 0;
    const warnCount = analysis.warnCount || 0;

    const width = 960;
    const padding = 20;
    const headerHeight = 112;
    const footerHeight = 44;
    const lineHeight = 18;
    const rowSpacing = 6;
    const rowPadding = 8;

    function wrapText(ctx, text, maxW) {
        const lines = [];
        const rawLines = String(text || '').split('\n');
        for (const raw of rawLines) {
            let current = '';
            for (let i = 0; i < raw.length; i++) {
                const char = raw[i];
                const testLine = current + char;
                if (ctx.measureText(testLine).width > maxW && current) {
                    lines.push(current);
                    current = char;
                } else {
                    current = testLine;
                }
            }
            if (current) lines.push(current);
        }
        return lines.length ? lines : [''];
    }

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext ? tempCanvas.getContext('2d') : null;
    if (!tempCtx) {
        window.modHubShowToast('当前运行环境不支持 Canvas 图像绘制', 'warning');
        return;
    }
    tempCtx.font = '12px "Consolas", "Courier New", monospace';

    const preparedRows = [];
    let totalBodyHeight = 0;
    const contentWidth = width - padding * 2;
    const msgWidth = contentWidth - 145;

    for (const row of rows) {
        const level = row.dataset.level || (row.classList.contains('log-row-error') ? 'error' : (row.classList.contains('log-row-warn') ? 'warn' : 'info'));
        const time = row.querySelector('.modhub-log-time')?.textContent?.trim() || '';
        const msg = row.querySelector('.modhub-log-msg')?.textContent?.trim() || '';

        const wrappedMsg = wrapText(tempCtx, msg, msgWidth);
        const rowHeight = Math.max(28, wrappedMsg.length * lineHeight + rowPadding * 2);
        preparedRows.push({ level, time, msgLines: wrappedMsg, rowHeight });
        totalBodyHeight += rowHeight + rowSpacing;
    }

    if (isTruncated) totalBodyHeight += 32;

    const totalHeight = headerHeight + totalBodyHeight + footerHeight + padding * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    // 绘制暗黑背景
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, width, totalHeight);
    ctx.strokeStyle = '#2d2d2d';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, totalHeight - 1);

    // 绘制 Header 卡片
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(padding, padding, width - padding * 2, headerHeight - 10);
    ctx.strokeStyle = errCount > 0 ? '#8b2020' : '#444';
    ctx.strokeRect(padding + 0.5, padding + 0.5, width - padding * 2 - 1, headerHeight - 10 - 1);

    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('Degrees of Lewdity 模组加载报错诊断报告', padding + 16, padding + 30);

    ctx.fillStyle = '#aaa';
    ctx.font = '12px sans-serif';
    const nowStr = new Date().toLocaleString();
    const dolVer = window.StartConfig?.version || '未识别';
    const mlVer = window.modHubGetGui?.()?.gModUtils?.version || '未识别';
    ctx.fillText(`游戏版本: DoL ${dolVer}  |  ModLoader: ${mlVer}  |  生成时间: ${nowStr}`, padding + 16, padding + 54);

    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = errCount > 0 ? '#ff5555' : '#888';
    ctx.fillText(`错误总数: ${errCount}`, padding + 16, padding + 80);
    ctx.fillStyle = warnCount > 0 ? '#ffd700' : '#888';
    ctx.fillText(`警告总数: ${warnCount}`, padding + 150, padding + 80);
    ctx.fillStyle = '#66bb6a';
    ctx.fillText(`当前截取: ${preparedRows.length} / ${filteredRowCount} 条 (筛选：${activeFilter === 'error' ? '仅错误' : (activeFilter === 'warn' ? '仅警告' : (activeFilter === 'issues' ? '错误与警告' : '全部日志'))})`, padding + 280, padding + 80);

    // 逐条绘制日志行
    let currentY = padding + headerHeight;
    ctx.font = '12px "Consolas", "Courier New", monospace';

    for (const item of preparedRows) {
        const rowX = padding;
        const rowY = currentY;
        const rowW = contentWidth;
        const rowH = item.rowHeight;

        let bgColor = '#181818';
        let borderColor = '#2a2a2a';
        let badgeBg = '#333';
        let badgeColor = '#aaa';
        let badgeText = '[信息]';

        if (item.level === 'error') {
            bgColor = '#2b1212';
            borderColor = '#7a1f1f';
            badgeBg = '#d32f2f';
            badgeColor = '#fff';
            badgeText = '[错误]';
        } else if (item.level === 'warn') {
            bgColor = '#2a2210';
            borderColor = '#7a651a';
            badgeBg = '#f57f17';
            badgeColor = '#000';
            badgeText = '[警告]';
        }

        ctx.fillStyle = bgColor;
        ctx.fillRect(rowX, rowY, rowW, rowH);
        ctx.strokeStyle = borderColor;
        ctx.strokeRect(rowX + 0.5, rowY + 0.5, rowW - 1, rowH - 1);

        ctx.fillStyle = '#777';
        ctx.font = '11px "Consolas", "Courier New", monospace';
        ctx.fillText(item.time || '', rowX + 8, rowY + 18);

        ctx.fillStyle = badgeBg;
        ctx.fillRect(rowX + 72, rowY + 5, 42, 18);
        ctx.fillStyle = badgeColor;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(badgeText, rowX + 76, rowY + 18);

        ctx.font = '12px "Consolas", "Courier New", monospace';
        ctx.fillStyle = item.level === 'error' ? '#ffcccc' : (item.level === 'warn' ? '#fff3cd' : '#dddddd');
        let textY = rowY + 18;
        for (const line of item.msgLines) {
            ctx.fillText(line, rowX + 126, textY);
            textY += lineHeight;
        }

        currentY += rowH + rowSpacing;
    }

    if (isTruncated) {
        ctx.fillStyle = '#888';
        ctx.font = 'italic 12px sans-serif';
        ctx.fillText(`(仅截取前 ${maxRows} 条，已省略 ${filteredRowCount - maxRows} 条；请筛选「仅错误」或复制日志查看其余项)`, padding + 16, currentY + 18);
        currentY += 32;
    }

    ctx.fillStyle = '#555';
    ctx.font = '11px sans-serif';
    ctx.fillText('由 ModHub 模组自动生成 · 支持直接在贴吧 / 交流群 Ctrl+V 粘贴', padding + 16, totalHeight - 14);

    if (typeof canvas.toBlob !== 'function') {
        window.modHubShowToast('当前浏览器不支持导出图片 Blob', 'warning');
        return;
    }

    const triggerFileDownload = blob => {
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const pad = n => String(n).padStart(2, '0');
            const d = new Date();
            const dateTag = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            a.download = `DoL-Log-Report-${dateTag}.png`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 1000);
        } catch (_) {}
    };

    const isTouchDevice = typeof window !== 'undefined' && (
        'ontouchstart' in window ||
        (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
        (window.innerWidth && window.innerWidth <= 768)
    );

    canvas.toBlob(async blob => {
        if (!blob) {
            window.modHubShowToast('生成图片数据失败', 'warning');
            return;
        }

        let clipboardSuccess = false;
        try {
            if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                const item = new ClipboardItem({ 'image/png': blob });
                await navigator.clipboard.write([item]);
                clipboardSuccess = true;
            }
        } catch (_) {}

        // 桌面端环境：优先剪贴板并触发文件下载
        if (!isTouchDevice) {
            triggerFileDownload(blob);
            if (clipboardSuccess) {
                window.modHubShowToast('诊断长图已保存并复制到剪贴板', 'success', 2500);
            } else {
                window.modHubShowToast('诊断长图已保存为图片文件', 'success', 2500);
            }
            return;
        }

        // 移动端环境：由于移动浏览器普遍禁止非直接手势异步下载或写入图片剪贴板，弹出可长按保存的原生暗黑模态预览
        triggerFileDownload(blob);

        let dataUrl = '';
        try {
            dataUrl = canvas.toDataURL ? canvas.toDataURL('image/png') : URL.createObjectURL(blob);
        } catch (_) {
            dataUrl = URL.createObjectURL(blob);
        }

        const previewHtml = `
            <div class="modhub-screenshot-preview">
                <div class="modhub-screenshot-tip gold">移动端请【长按下方图片】选择【保存图片】至相册分享</div>
                <div class="modhub-screenshot-box">
                    <img src="${dataUrl}" class="modhub-screenshot-img" alt="诊断长图" />
                </div>
            </div>
        `;

        if (typeof window.modHubConfirm === 'function') {
            const confirmed = await window.modHubConfirm({
                title: '诊断长图生成完毕',
                message: '移动端请长按下方预览图片并选择【保存图片】到相册：',
                trustedMessageHtml: previewHtml,
                confirmText: '尝试直接下载',
                cancelText: '关闭预览',
                confirmType: 'primary'
            });
            if (confirmed) {
                triggerFileDownload(blob);
            }
        } else {
            window.modHubShowToast('诊断长图已生成，请长按保存', 'success', 2500);
        }
    }, 'image/png');
};

window.modHubCopyLoadLog = async function() {
    const log = document.getElementById('modHubLogContent');
    const text = (log?.innerText || log?.textContent || '').trim();
    if (!text) {
        window.modHubShowToast('暂无可复制的加载日志', 'warning');
        return;
    }

    let copied = false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
    } catch (_) {}

    if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        textarea.remove();
    }

    window.modHubShowToast(copied ? '加载日志已复制' : '复制日志失败，请手动选择日志文本', copied ? 'success' : 'warning');
};

// 启动自检测机制（支持多阶段延时轮询与事件监听兜底）
window.modHubInitStartupErrorCheck = function() {
    if (window._modHubStartupCheckInitialized) return;
    window._modHubStartupCheckInitialized = true;

    const tryCheck = () => {
        if (window._modHubErrorDialogShown) return true;
        if (typeof window.modHubCheckAndAutoOpenErrorLog === 'function') {
            return window.modHubCheckAndAutoOpenErrorLog();
        }
        return false;
    };

    // 1. 多阶段延时自检（在通道就绪后安全消费；若超过 45 秒仍未就绪且有严重错误，兜底强行呼出以便排查）
    [500, 1500, 3000, 6000, 10000, 15000, 25000, 45000].forEach(delay => {
        setTimeout(() => {
            if (!window._modHubErrorDialogShown) {
                if (delay >= 45000 && window._modHubPendingAutoOpenErrorLog) {
                    window._modHubForceStartupErrorOpen = true;
                }
                tryCheck();
            }
        }, delay);
    });

    // 2. SugarCube 事件监听权威就绪点：在故事就绪与通道展示时检查并消费 pending 状态
    if (typeof $ !== 'undefined' && $(document) && typeof $(document).on === 'function') {
        const onPassageOrReady = () => {
            if (window._modHubErrorDialogShown) return;
            setTimeout(() => {
                if (!window._modHubErrorDialogShown) {
                    tryCheck();
                }
            }, 100);
        };

        $(document).on(':storyready', onPassageOrReady);
        $(document).on(':passagedisplay', onPassageOrReady);
    }
};

// 脚本载入时自动挂载启动检测
try {
    window.modHubInitStartupErrorCheck();
} catch (_) {}
