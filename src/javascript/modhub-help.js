/** ModHub 帮助中心：按现象检查、确认配置修复与本地求助报告。 */
(function() {
    'use strict';

    const key = value => String(value || '');
    const detail = error => String(error?.message || error || '未提供具体原因');
    // 原生依赖索引按原文匹配技术名与 alias，不能套用市场的名称规范化。
    const namesOf = boot => [boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])]
        .filter(name => typeof name === 'string' && name.length);
    const bootStamp = boot => JSON.stringify([boot?.name, boot?.version, boot?.alias, boot?.dependenceInfo, boot?.addonPlugin]);
    const listStamp = lists => JSON.stringify([lists.ok, lists.enabled, lists.disabled]);
    const packageStamp = packages => JSON.stringify(packages.map(item => [item.name, item.missing, detail(item.error), bootStamp(item.bootJson)]));
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const busy = () => Boolean(window.modHubIsReloadBusy?.() || window._modHubManagerBusy || window._modHubModLoading);
    let viewRevision = 0;
    let repairing = false;
    const configurationStamp = snapshot => JSON.stringify([snapshot.gameVersion, snapshot.loaderVersion,
        listStamp(snapshot.lists), packageStamp(snapshot.packages), snapshot.runtime.map(item => [item.name, item.source, bootStamp(item.bootJson)])]);

    function readRuntime() {
        const utils = window.modHubGetGui?.()?.gModUtils || window.modUtils;
        const loader = utils?.getModLoader?.() || window.modSC2DataManager?.getModLoader?.();
        const cache = loader?.getModCacheArray?.();
        const read = loader?.getModReadCache?.()?.get_Array?.();
        const entries = Array.isArray(cache) ? cache : [];
        const sources = Array.isArray(read) ? read : entries;
        const info = entry => entry?.mod || entry?.zip?.getModInfo?.() || entry?.zip?.modInfo || entry;
        const declared = utils?.getModListNameNoAlias?.();
        const names = Array.isArray(declared) ? declared : entries.map(entry => info(entry)?.name || info(entry)?.bootJson?.name).filter(Boolean);
        const unique = values => [...new Map(values.filter(value => typeof value === 'string' && value.trim()).map(value => [key(value), value])).values()];
        const runtime = unique(names).map(name => {
            const entry = [...entries].reverse().find(item => key(info(item)?.bootJson?.name || info(item)?.name) === key(name));
            const mod = info(entry);
            const from = sources.filter(item => key(info(item)?.bootJson?.name || item?.name) === key(name));
            const sourceNames = [...new Set(from.map(item => item.from).filter(Boolean))];
            return { name, bootJson: mod?.bootJson || null, source: entry?.from || (sourceNames.length === 1 ? sourceNames[0] : '') };
        });
        // 原始读取缓存也含被框架禁止加载的包，只用它补充来源，不能据此认定提供者已启用。
        const builtins = runtime.filter(item => item.source && item.source !== 'IndexDB');
        return { runtime, builtins, runtimeKnown: Array.isArray(declared),
            builtinKnown: Array.isArray(declared) && Array.isArray(cache) && runtime.every(item => item.source && item.bootJson),
            loaderVersion: String(utils?.version || window.modSC2DataManager?.getModUtils?.()?.version || '') };
    }

    function readLogs() {
        return window.modHubAnalyzeLogs(window.modHubGetRawModLoaderLogs?.() || []);
    }

    function suggestQuestions(analysis) {
        const questions = {
            'weather-image-error': '天气或背景图片显示异常，怎么办？',
            'game-version-mismatch': '游戏版本不满足模组要求，怎么办？',
            'modloader-version-mismatch': '加载器版本不满足要求，怎么办？',
            'dependency-version-mismatch': '前置模组版本不满足要求，怎么办？',
            'dependency-order': '前置模组的加载顺序该怎么调整？',
            'twee-patch-mismatch': '日志中的补丁问题该怎么处理？',
            'npc-pregnancy-init-error': '游戏初始化时报错，应该怎么处理？',
            'syntax-error': '脚本提示语法错误，应该怎么处理？',
            'type-error': '脚本运行时报错，应该怎么处理？',
            'boot-json-error': '模组安装包信息异常，应该怎么处理？',
            'storage-quota': '日志提示存储空间不足，该怎么处理？',
            'asset-missing': '日志提示资源加载异常，应该怎么排查？',
            'patch-conflict': '怀疑模组冲突，应该怎么排查？',
            'mod-name-lookup-miss': '日志找不到模组名称，该怎么检查？',
            'missing-dep': '日志提示找不到所需内容，该怎么检查？'
        };
        const suggestions = [], seen = new Set();
        for (const level of ['error', 'warn']) {
            for (const line of analysis.lines || []) {
                if (line.level !== level || typeof line.message !== 'string' || !line.message.trim()) continue;
                const id = level === 'error' ? Object.keys(questions).find(id => line.issueIds?.includes(id)) || 'error' : 'warn';
                if (seen.has(id)) continue;
                seen.add(id);
                suggestions.push({ question: questions[id] || (level === 'error' ? '加载时报错，应该怎么处理？' : '这条加载警告需要处理吗？'),
                    error: line.message, modName: line.mods?.length === 1 ? line.mods[0] : '', level });
                if (suggestions.length === 3) return suggestions;
            }
        }
        return suggestions;
    }

    function addIssue(snapshot, id, status, title, evidence, advice, tab = '模组管理', query = '', repair = null) {
        snapshot.issues.push({ id, status, title, evidence, advice, tab, query, ...(repair ? { repair } : {}) });
    }

    function logIssues(snapshot) {
        const analysis = snapshot.analysis;
        for (const issue of analysis.matchedIssues || []) {
            addIssue(snapshot, 'log-' + issue.id, 'problem', issue.title,
                '本次运行日志：' + issue.desc, issue.solution, '加载日志',
                analysis.errorMods?.find(name => String(issue.desc).includes(name)) || '');
        }
        if (analysis.errorCount && !analysis.matchedIssues?.length) {
            addIssue(snapshot, 'log-unknown', 'problem', '日志记录了尚未定位原因的错误',
                '本次运行共记录 ' + analysis.errorCount + ' 条错误日志。',
                '请查看具体错误及其前后日志；仅凭错误中出现的模组名，不能确定责任模组。', '加载日志');
        }
        if (analysis.warnCount) {
            addIssue(snapshot, 'log-warnings', 'review', '有警告日志需要核对',
                '本次运行共记录 ' + analysis.warnCount + ' 条警告日志。',
                '请结合实际异常和作者说明核对。警告本身不能证明模组冲突。', '加载日志');
        }
    }

    async function readPackages(lists) {
        const enabled = new Set(lists.enabled.map(key));
        const names = [...new Map([...lists.enabled, ...lists.disabled].map(name => [key(name), name])).values()];
        const packages = [];
        for (const name of names) {
            let result;
            try {
                result = await window.modHubReadInstalledModBoot(name);
            } catch (error) {
                result = { name, bootJson: null, error };
            }
            packages.push({ ...result, name, enabled: enabled.has(key(name)) });
        }
        return packages;
    }

    function checkDeclarations(snapshot, metadata) {
        const { packages } = snapshot;
        // 加载器按精确技术名覆盖包体，已保存的启用包替换同名运行档案。
        const active = [...new Map([...metadata.builtins, ...packages.filter(item => item.enabled && item.bootJson)]
            .map(item => [key(item.bootJson?.name || item.name), item])).values()];
        const disabled = packages.filter(item => !item.enabled && item.bootJson);
        const complete = metadata.builtinKnown && packages.every(item => item.bootJson || item.missing);
        const providers = new Map();
        for (const item of active) {
            for (const name of new Set(namesOf(item.bootJson).map(key))) {
                if (!providers.has(name)) providers.set(name, []);
                providers.get(name).push(item);
            }
        }
        for (const [name, matches] of providers) {
            if (matches.length > 1) addIssue(snapshot, 'providers-' + name, 'review', '依赖提供者不唯一',
                '技术名或原生别名【' + name + '】由 ' + matches.map(item => '【' + item.name + '】').join('、') + ' 同时提供。',
                '请按作者说明核对需要启用的提供者，不要仅凭兼容别名重复安装框架。');
        }
        for (const item of packages) {
            if (item.missing || item.error || !item.bootJson) {
                addIssue(snapshot, 'package-' + key(item.name), item.missing ? 'problem' : 'review',
                    item.missing ? '登记的模组缺少安装包' : '安装包资料暂不能读取',
                    '【' + item.name + '】：' + (item.missing ? '启禁列表仍有记录，但仓库中未找到包体。' : detail(item.error)),
                    '请在模组管理中核对记录和安装包；需要时重新导入作者提供的正式安装包。');
            }
        }
        if (!metadata.builtinKnown) addIssue(snapshot, 'builtin-unknown', 'review', '内置模组清单未能完整核对',
            '当前加载器没有提供完整的模组来源或包体声明。', '部分依赖只能结合本次运行日志及作者说明核对。');
        const order = new Map(snapshot.lists.enabled.map((name, index) => [key(name), index]));
        for (const item of active) {
            const dependencies = item.bootJson?.dependenceInfo;
            if (dependencies !== undefined && !Array.isArray(dependencies)) {
                addIssue(snapshot, 'declaration-' + key(item.name), 'review', '前置声明格式无法识别',
                    '【' + item.name + '】的 dependenceInfo 不是列表。', '请查看作者说明或向作者提供具体错误。', '模组说明');
                continue;
            }
            for (const dependency of dependencies || []) {
                const target = dependency?.modName;
                if (typeof target !== 'string' || !target.trim()) {
                    addIssue(snapshot, 'dependency-invalid-' + key(item.name), 'review', '前置声明缺少技术名',
                        '【' + item.name + '】有无法识别的前置条目。', '请查看包体说明并向作者核对。', '模组说明');
                    continue;
                }
                const id = key(item.name) + '-' + key(target);
                const evidence = '【' + item.name + '】声明需要【' + target + '】' + (dependency.version ? ' ' + dependency.version : '') + '。';
                let version = '';
                if (target === 'GameVersion') version = snapshot.gameVersion;
                else if (target === 'ModLoader') version = snapshot.loaderVersion;
                else {
                    const matches = providers.get(key(target)) || [];
                    if (!matches.length) {
                        const installed = disabled.filter(profile => namesOf(profile.bootJson).some(name => key(name) === key(target)));
                        const title = installed.length ? '前置已安装但未启用' : complete ? '缺少前置模组' : '暂不能确认此前置是否已安装';
                        const checked = installed.length === 1 && window.modHubMarketVersions?.assessVersionRange?.(installed[0].bootJson.version, dependency.version);
                        const canEnable = complete && checked?.status === 'compatible';
                        addIssue(snapshot, 'dependency-' + id, installed.length || complete ? 'problem' : 'review', title,
                            evidence + (installed.length ? '已禁用提供者：' + installed.map(profile => profile.name).join('、') + '。' + (checked?.reason || '') : ''),
                            installed.length ? canEnable ? '可预览启用此前置及必要的顺序调整，确认后保存，再重新载入。' : '请核对提供者及其版本要求；当前依据不足，不能直接启用。'
                                : complete ? '请在模组市场或作者发布页获取满足要求的前置。' : '请先处理未能读取的包体资料，再重新检查。',
                            installed.length || !complete ? '模组管理' : '模组市场', '', canEnable ? { type: 'enable', enableName: installed[0].name } : null);
                        continue;
                    }
                    if (matches.length !== 1) continue;
                    const provider = matches[0];
                    version = provider.bootJson?.version;
                    if (order.has(key(item.name)) && order.has(key(provider.name)) && order.get(key(provider.name)) >= order.get(key(item.name))) {
                        const canOrder = window.modHubMarketVersions?.assessVersionRange?.(version, dependency.version)?.status === 'compatible';
                        addIssue(snapshot, 'order-' + id, 'problem', '前置加载顺序需要调整', evidence,
                            canOrder ? '可按包内声明预览加载顺序调整，确认后保存，再重新载入。' : '请先核对并满足版本要求，再调整顺序。', '模组管理', '',
                            canOrder && provider.name !== item.name ? { type: 'order' } : null);
                    }
                }
                const checked = window.modHubMarketVersions?.assessVersionRange?.(version, dependency.version, target === 'GameVersion')
                    || { status: 'unknown', reason: '版本比较接口尚未就绪' };
                if (checked.status !== 'compatible') addIssue(snapshot, 'version-' + id,
                    checked.status === 'incompatible' ? 'problem' : 'review',
                    checked.status === 'incompatible' ? '版本不满足前置要求' : '版本要求暂不能核对',
                    evidence + '当前版本：' + (version || '未识别') + '。' + (checked.reason || ''),
                    '请核对游戏、加载器和模组的实际版本，并按作者声明选择适用安装包。', '模组说明');
            }
        }
        const market = window.modHubMarket;
        for (const rule of market?.KNOWN_MOD_CONFLICT_RULES || []) {
            if (!market.isModMatchingConflictGroup || !Array.isArray(rule.conflictingGroups)) continue;
            const [mapleGroup, simpleGroup] = rule.conflictingGroups;
            if (mapleGroup?.key !== 'maplebirch' || simpleGroup?.key !== 'simpleframework') continue;
            for (const maple of active.filter(item => item.bootJson && market.isModMatchingConflictGroup(item, mapleGroup))) {
                for (const simple of active.filter(item => item.bootJson && market.isModMatchingConflictGroup(item, simpleGroup))) {
                    const risk = window.modHubGetFrameworkPairRisk?.(maple, simple);
                    if (risk) addIssue(snapshot, rule.id + '-' + key(maple.name) + '-' + key(simple.name),
                        'review', '框架组合需要核对', '【' + maple.name + '】与【' + simple.name + '】：' + risk.reason, risk.advice);
                }
            }
        }
    }

    async function check() {
        const snapshot = { checkedAt: new Date().toISOString(), analysis: readLogs(), runtime: [], lists: { ok: false, enabled: [], disabled: [] },
            packages: [], issues: [], stale: false, different: false, gameVersion: String(window.StartConfig?.version || ''), loaderVersion: '' };
        logIssues(snapshot);
        const revision = window._modHubReloadRevision;
        try {
            if (busy()) {
                snapshot.stale = true;
                throw new Error('另一项模组操作尚未完成，请等待完成后重新检查');
            }
            const metadata = readRuntime();
            Object.assign(snapshot, { runtime: metadata.runtime, loaderVersion: metadata.loaderVersion,
                builtins: metadata.builtins, builtinKnown: metadata.builtinKnown });
            if (!metadata.runtimeKnown) addIssue(snapshot, 'runtime-unknown', 'review', '本次运行清单未能完整核对',
                '当前加载器未提供实际运行顺序，下面仅列可读取的运行档案。', '请结合加载日志核对，不将缓存清单视为全部成功加载的模组。');
            snapshot.lists = await window.modHubReadIndexDBModLists();
            if (!snapshot.lists.ok) throw snapshot.lists.error || new Error('当前无法读取已保存的启禁配置');
            const overlap = snapshot.lists.enabled.filter(name => snapshot.lists.disabled.some(disabled => key(name) === key(disabled)));
            if (overlap.length) addIssue(snapshot, 'list-overlap', 'review', '启禁配置存在重复登记',
                overlap.join('、') + ' 同时出现在启用与禁用列表中。', '请在模组管理中刷新并核对配置。');
            snapshot.packages = await readPackages(snapshot.lists);
            checkDeclarations(snapshot, metadata);
            const runtimeSide = snapshot.runtime.filter(item => item.source === 'IndexDB');
            const runtimeOrder = runtimeSide.map(item => key(item.name));
            const savedOrder = snapshot.lists.enabled.map(key);
            const runtimeComparable = metadata.runtimeKnown && snapshot.runtime.every(item => item.source && item.bootJson);
            snapshot.different = runtimeComparable && (JSON.stringify(runtimeOrder) !== JSON.stringify(savedOrder)
                || snapshot.packages.some(item => item.enabled && item.bootJson && runtimeSide.some(run => key(run.name) === key(item.name) && bootStamp(run.bootJson) !== bootStamp(item.bootJson))));
            if (!runtimeComparable) addIssue(snapshot, 'comparison-unknown', 'review', '运行与配置的差异暂不能完整核对',
                '部分运行档案或模组来源未识别。', '报告将分别列出可读取的运行清单和已保存配置，请结合日志核对。');
            if (snapshot.different) addIssue(snapshot, 'configuration-different', 'review', '已保存配置与本次运行不同',
                '启用清单、加载顺序或包体声明存在差异；本次运行日志仍属于重新载入前的环境。',
                '请先保存游戏进度，再按模组管理中的提示重新载入。');
            const after = await window.modHubReadIndexDBModLists();
            const afterPackages = after.ok && listStamp(after) === listStamp(snapshot.lists) ? await readPackages(after) : [];
            snapshot.stale = busy() || revision !== window._modHubReloadRevision
                || listStamp(after) !== listStamp(snapshot.lists) || packageStamp(afterPackages) !== packageStamp(snapshot.packages);
            if (snapshot.stale) addIssue(snapshot, 'stale', 'review', '检查期间配置发生变化',
                '本次检查结果已过期。', '请等待模组操作完成，然后重新检查。');
        } catch (error) {
            addIssue(snapshot, 'read-failed', 'review', '检查未能完成', detail(error), '请处理上述原因后重新检查；已读取的日志仍可查看。');
        }
        return snapshot;
    }

    async function buildRepairPlan(snapshot, issueId) {
        const issue = snapshot?.issues?.find(item => item.id === issueId);
        if (!issue?.repair || snapshot.stale || !snapshot.lists.ok) throw new Error('此结果不能直接修复，请重新检查或使用对应管理入口。');
        if (!snapshot.builtinKnown || snapshot.packages.some(item => !item.bootJson)) throw new Error('安装包或内置模组资料不完整，不能预览配置修复。');
        const allNames = [...snapshot.lists.enabled, ...snapshot.lists.disabled];
        if (new Set(allNames.map(name => name.trim().toLowerCase())).size !== allNames.length) throw new Error('存在管理器无法区分的重复名称，请先在原生管理器核对。');
        if (typeof window.modHubBuildSmartOrder !== 'function' || typeof window.modHubKeepRecoveryOrder !== 'function') throw new Error('加载顺序处理接口尚未就绪。');
        const { type, enableName } = issue.repair;
        const enabled = [...snapshot.lists.enabled];
        if (type === 'enable') {
            if (!snapshot.lists.disabled.includes(enableName)) throw new Error('前置状态已变化，请重新检查。');
            enabled.push(enableName);
        }
        const disabled = snapshot.lists.disabled.filter(name => name !== enableName);
        const profiles = [...new Map([...snapshot.builtins, ...snapshot.packages.filter(item => enabled.includes(item.name))]
            .map(item => [key(item.bootJson?.name || item.name), item])).values()];
        const providers = new Map();
        profiles.forEach(item => [...new Set(namesOf(item.bootJson))].forEach(name => {
            if (!providers.has(name)) providers.set(name, []);
            providers.get(name).push(item.name);
        }));
        // 复用排序引擎，但只传已核实的原生身份，不让市场昵称参与配置修复。
        const nodes = enabled.map(name => {
            const boot = snapshot.packages.find(item => item.name === name).bootJson;
            const resolve = entries => (Array.isArray(entries) ? entries : []).flatMap(entry => {
                const matches = providers.get(entry?.modName) || [];
                return matches.length === 1 ? [{ ...entry, modName: matches[0] }] : [];
            });
            return { key: name, modName: name, boot: { ...boot, nickName: undefined, dependenceInfo: resolve(boot.dependenceInfo), addonPlugin: resolve(boot.addonPlugin) } };
        });
        const sorted = await window.modHubBuildSmartOrder(nodes, window.modHubGetGui?.(), false);
        const target = window.modHubKeepRecoveryOrder(sorted, profiles);
        if (target.length !== enabled.length || new Set(target).size !== enabled.length || target.some(name => !enabled.includes(name))) throw new Error('无法生成完整的加载顺序，请在模组管理中核对。');
        const candidate = { ...snapshot, lists: { ok: true, enabled: target, disabled }, issues: [],
            packages: snapshot.packages.map(item => ({ ...item, enabled: target.includes(item.name) })) };
        checkDeclarations(candidate, { builtins: snapshot.builtins, builtinKnown: snapshot.builtinKnown });
        const previous = new Set(snapshot.issues.map(item => item.id + ':' + item.status));
        const unresolved = candidate.issues.filter(item => item.id === issueId || !previous.has(item.id + ':' + item.status));
        if (unresolved.length) throw new Error('当前方案仍有需要处理的条件：' + unresolved.map(item => item.title + '；' + item.evidence).join('\n'));
        if (JSON.stringify(target) === JSON.stringify(snapshot.lists.enabled) && JSON.stringify(disabled) === JSON.stringify(snapshot.lists.disabled)) throw new Error('没有可应用的变更；可能存在循环依赖，请核对作者说明。');
        return { type, enableName, before: { enabled: [...snapshot.lists.enabled], disabled: [...snapshot.lists.disabled] },
            packages: snapshot.packages.map(item => ({ name: item.name, bootJson: item.bootJson })), enabled: target, disabled };
    }

    async function repair(snapshot, issueId) {
        if (!snapshot || snapshot.stale) return { ok: false, status: 'stale', reason: '检查结果已过期，请重新检查。' };
        if (repairing || busy()) return { ok: false, status: 'failed', reason: '另一项操作尚未完成，请稍后再试。' };
        repairing = true;
        try {
            const fresh = await check();
            if (fresh.stale || configurationStamp(fresh) !== configurationStamp(snapshot)) return { ok: false, status: 'stale', reason: '配置或安装包已经变化，请重新检查。', snapshot: fresh };
            const plan = await buildRepairPlan(fresh, issueId);
            const rows = (title, names) => title + '\n' + (names.length ? names.map((name, index) => (index + 1) + '. ' + name).join('\n') : '无');
            const ok = await window.modHubConfirm({ title: '确认配置修复',
                message: (plan.type === 'enable' ? '启用已安装的前置【' + plan.enableName + '】，并按声明调整必要顺序。所属美化按现有自动启用设置同步。' : '按已核实的包内声明整理已启用模组的加载顺序。美化覆盖顺序不变。')
                    + '\n\n' + rows('当前启用顺序', plan.before.enabled) + '\n\n' + rows('保存后的启用顺序', plan.enabled)
                    + '\n\n修复前会建立时间点。取消不会修改配置。保存后需要重新载入，请先保存游戏进度。',
                confirmText: '应用修复', cancelText: '取消', confirmType: 'primary' });
            if (!ok) return { ok: false, status: 'cancelled', reason: '已取消，配置保持不变。' };
            const confirmed = await check();
            if (confirmed.stale || configurationStamp(confirmed) !== configurationStamp(fresh)) return { ok: false, status: 'stale', reason: '确认期间配置或安装包发生变化，请重新检查。', snapshot: confirmed };
            if (typeof window.modHubApplyHelpConfiguration !== 'function') throw new Error('配置修复接口尚未就绪。');
            const saved = await window.modHubApplyHelpConfiguration(plan);
            const after = await check();
            if (!saved?.ok) return { ok: false, status: 'failed', reason: saved?.reason || '修复未完成，请根据重新读取的配置核对。', snapshot: after };
            if (after.stale || !after.lists.ok || JSON.stringify(after.lists.enabled) !== JSON.stringify(plan.enabled)
                || JSON.stringify(after.lists.disabled) !== JSON.stringify(plan.disabled) || after.issues.some(item => item.id === issueId)) {
                return { ok: false, status: 'failed', reason: '保存后的检查未通过。请核对当前配置，必要时使用修复前的时间点。', snapshot: after };
            }
            try { await window.modHubOfferReload?.('帮助中心的配置修复已保存并回读通过。请重新载入后验证问题是否解决。'); }
            catch (error) { return { ok: true, status: 'saved', reason: '配置已保存并回读通过，但重载提示未能打开：' + detail(error) + '。请保存游戏进度后手动重新载入。', snapshot: after }; }
            return { ok: true, status: 'saved', reason: '配置修复已保存，等待重新载入验证。原有运行日志不会因此清除，也不代表问题已解决。', snapshot: after };
        } catch (error) {
            return { ok: false, status: 'failed', reason: detail(error) };
        } finally { repairing = false; }
    }

    function buildReport(snapshot, { allLogs = false } = {}) {
        if (!snapshot || snapshot.stale) return '';
        const runtime = snapshot.runtime || [];
        const modHub = runtime.find(item => key(item.name) === 'ModHub');
        const lines = ['ModHub 求助信息', '生成时间：' + snapshot.checkedAt,
            '游戏版本：' + (snapshot.gameVersion || '未识别'), 'ModLoader 版本：' + (snapshot.loaderVersion || '未识别'),
            'ModHub 运行版本：' + (modHub?.bootJson?.version || '未识别'),
            '说明：运行日志属于本次运行；已保存配置可能尚未重新载入。检查只覆盖可读取的声明和已知规则，不代表全部兼容。', '',
            '本次运行的模组（按可读取顺序）'];
        runtime.forEach((item, index) => lines.push((index + 1) + '. ' + item.name + ' | ' + (item.bootJson?.version || '未识别') + ' | 来源：' + (item.source || '未识别')));
        if (!runtime.length) lines.push('未能读取运行清单');
        lines.push('', '已保存的启用配置');
        const listRows = enabled => {
            for (const [index, name] of (enabled ? snapshot.lists.enabled : snapshot.lists.disabled).entries()) {
                const item = snapshot.packages.find(profile => key(profile.name) === key(name));
                lines.push((index + 1) + '. ' + name + ' | ' + (item?.bootJson?.version || '未识别')
                    + (item?.missing ? ' | 包体缺失' : item?.error ? ' | ' + detail(item.error) : ''));
            }
            if (!(enabled ? snapshot.lists.enabled : snapshot.lists.disabled).length) lines.push('无');
        };
        if (snapshot.lists.ok) listRows(true);
        else lines.push('未能读取：' + detail(snapshot.lists.error));
        lines.push('', '已保存的禁用配置');
        if (snapshot.lists.ok) listRows(false);
        else lines.push('未能读取');
        lines.push('', '检查摘要', '错误日志：' + (snapshot.analysis.errorCount || 0) + '；警告日志：' + (snapshot.analysis.warnCount || 0));
        for (const issue of snapshot.issues) lines.push('[' + (issue.status === 'problem' ? '发现问题' : '需要核对') + '] ' + issue.title,
            '依据：' + issue.evidence, '建议：' + issue.advice);
        if (!snapshot.issues.length) lines.push('未发现已知问题；这不代表全部模组已经验证兼容。');
        lines.push('', allLogs ? '全部已捕获日志' : '错误和警告日志');
        const logs = (snapshot.analysis.lines || []).filter(item => allLogs || ['error', 'warn'].includes(item.level));
        logs.forEach(item => lines.push((item.time ? '[' + item.time + '] ' : '') + '[' + item.level + '] ' + item.message));
        if (!logs.length) lines.push('暂无符合条件的日志');
        return lines.join('\n');
    }

    async function copyReport(text) {
        const preview = document.getElementById('modHubHelpReport');
        const value = typeof text === 'string' ? text : preview?.value;
        if (!value) {
            window.modHubShowToast('请先生成并预览求助信息。', 'warning');
            return false;
        }
        let copied = false;
        try {
            if (window.navigator?.clipboard?.writeText) {
                await window.navigator.clipboard.writeText(value);
                copied = true;
            }
        } catch (_) {}
        if (!copied && preview?.value === value) {
            preview.focus();
            preview.select();
            try { copied = document.execCommand?.('copy') === true; } catch (_) {}
        }
        window.modHubShowToast(copied ? '求助信息已复制。' : '复制失败。请在预览框中选择文本并手动复制。', copied ? 'success' : 'warning');
        return copied;
    }

    const MODHUB_AI_NOTICE = 'AI 辅助修复由 ModHub 提供，不依赖枫叶框架。点击“发送并分析”确认范围后，才会向您填写的服务发送问题描述、所选源码、环境清单和已脱敏的错误与警告日志；发送前可查看完整材料。勾选自动补充时，可在已确认的声明文件范围内自动定位并生成修改，轮次上限可在 AI 连接设置中自定义，也可勾选“不限轮次”；找到方案或没有新证据时提前停止，可随时取消；新增范围需再次确认。不会读取游戏存档、其他服务的密钥或投稿凭证。分析轮次增加可能产生更多服务费用，请核对服务方的数据政策。\n'
        + '地址和模型名称可在本机保留。密钥默认仅在当前页面内存中保留；勾选“记住我”并保存后，密钥将保存在当前浏览器的本机数据中，取消勾选并保存即可移除。同一游戏的模组共享运行环境，可能读取已保存的密钥，请使用可信模组及限额密钥。\n'
        + 'AI 建议可能错误。代码改动须经您预览并确认，保存前强制建立时间点还原点；修改普通旁加载 ZIP 中选定的源码，保留启禁与顺序，不修改游戏 HTML、内嵌模组或 ModHub 恢复工具。重新导入或更新目标模组会覆盖修改。\n'
        + '保存成功不代表问题已解决。请重新载入并重复原操作验证；撤销使用修复前时间点，会一并还原该点覆盖的旁加载包和管理配置，确认页将列出影响。';
    const aiConnection = { endpoint: '', model: '', key: '', remember: false, maxRounds: 5, finiteRounds: 5 };
    const roundLimitText = maxRounds => maxRounds === 0 ? '不限轮次' : '最多发送 ' + maxRounds + ' 轮';
    let aiConnectionLoaded = false;
    const aiDraft = { description: '', modName: '', error: '' };
    let aiOpenRequested = false;
    let aiAbort = null;
    let aiConnectionAbort = null;
    let aiStopProgress = null;

    function openProblem({ modName = '', error = '' } = {}) {
        aiDraft.modName = typeof modName === 'string' ? modName : '';
        aiDraft.error = typeof error === 'string' ? error : '';
        aiDraft.description = '加载时出现报错，请结合这条日志分析原因和处理方法。';
        aiOpenRequested = true;
        if (window.modHubOpenManager?.('帮助中心')) return true;
        aiOpenRequested = false;
        return false;
    }

    function initAi(host, mounted) {
        if (!host) return;
        aiAbort?.abort();
        aiConnectionAbort?.abort();
        aiStopProgress?.();
        const api = window.modHubAiRepair;
        if (!api) { host.textContent = 'AI 修复模块尚未就绪。请重新载入后再试。'; return; }
        let stage = 1, ticket = 0, working = false, analyzing = false, candidate = null, prepared = null, plan = null, last = null;
        let testing = false, testTicket = 0, testController = null, progressTimer = null, continuationBlocked = false, needsPreparation = false;
        let analysis = readLogs();
        let suggestions = [];
        try {
            if (!aiConnectionLoaded) {
                aiConnectionLoaded = true;
                const saved = JSON.parse(localStorage.getItem('modhub_ai_connection') || '{}');
                aiConnection.endpoint = typeof saved.endpoint === 'string' ? saved.endpoint : '';
                aiConnection.model = typeof saved.model === 'string' ? saved.model : '';
                try { aiConnection.maxRounds = api.normalizeMaxRounds(saved.maxRounds); } catch (_) { aiConnection.maxRounds = 5; }
                aiConnection.finiteRounds = aiConnection.maxRounds || (Number.isSafeInteger(saved.finiteRounds) && saved.finiteRounds > 0 ? saved.finiteRounds : 5);
                aiConnection.remember = saved.remember === true;
                if (aiConnection.remember) aiConnection.key = typeof saved.key === 'string' ? saved.key : '';
            }
            const previous = JSON.parse(localStorage.getItem('modhub_ai_last_repair') || 'null');
            if (previous && typeof previous.name === 'string' && typeof previous.pointId === 'string') last = previous;
        } catch (_) {}
        const button = (id, label, primary = false) => '<button type="button" id="modHubAi' + id + '" class="macro-button modhub-btn-' + (primary ? 'primary' : 'secondary') + '">' + label + '</button>';
        host.innerHTML = '<header id="modHubAiWelcome" class="modhub-help-welcome"><h2>需要什么帮助？</h2><p>告诉我们您遇到的模组问题，获取排查建议，或使用 AI 辅助修复。</p></header>'
            + '<div id="modHubAiToolbar" class="modhub-ai-toolbar"><span id="modHubAiConnectionStatus" class="grey"></span>' + button('Settings', 'AI 连接设置') + '</div>'
            + '<section id="modHubAiSettingsPanel" class="modhub-help-topic modhub-ai-settings" hidden><h3>连接您的 AI 服务</h3><p class="grey">填写服务商提供的连接信息。保存后即可返回，继续处理刚才的问题。</p>'
            + '<div class="modhub-ai-settings-fields"><label class="modhub-ai-field modhub-ai-settings-address">API 地址<input id="modHubAiEndpoint" type="url" placeholder="https://服务地址/v1" autocomplete="off" spellcheck="false" aria-describedby="modHubAiEndpointHint"><small id="modHubAiEndpointHint" class="grey">支持基础地址、/v1 或完整 /chat/completions 地址。</small></label>'
            + '<label class="modhub-ai-field">模型名称<input id="modHubAiModel" placeholder="填写服务商的模型标识" autocomplete="off" spellcheck="false"></label>'
            + '<label class="modhub-ai-field">API 密钥<input id="modHubAiKey" type="password" autocomplete="off" spellcheck="false" placeholder="填写服务商提供的密钥" aria-describedby="modHubAiRememberHint"></label>'
            + '<label class="modhub-ai-remember modhub-ai-settings-wide"><input id="modHubAiRememberMe" type="checkbox" aria-describedby="modHubAiRememberHint">记住我</label>'
            + '<p id="modHubAiRememberHint" class="grey modhub-ai-settings-hint modhub-ai-settings-wide">勾选并保存后，下次自动填入密钥。取消勾选并保存可移除。请仅在可信设备使用。</p>'
            + '<div class="modhub-ai-field modhub-ai-settings-wide"><label for="modHubAiMaxRounds">分析轮次上限</label><div class="modhub-ai-rounds-controls"><input id="modHubAiMaxRounds" type="number" min="1" step="1" inputmode="numeric" aria-describedby="modHubAiMaxRoundsHint modHubAiRoundsNotice"><label class="modhub-ai-remember"><input id="modHubAiUnlimitedRounds" type="checkbox" aria-describedby="modHubAiMaxRoundsHint modHubAiRoundsNotice">不限轮次</label></div></div>'
            + '<small id="modHubAiMaxRoundsHint" class="grey modhub-ai-settings-wide">默认 5 轮，可填写正整数或勾选“不限轮次”。找到方案或没有新证据时停止，可随时取消。</small><small id="modHubAiRoundsNotice" class="gold modhub-ai-settings-wide" role="status" hidden>请注意 Token 消耗。分析会使用输入和输出 Token；源码与累计分析历史会增加输入量，较多轮次可能增加服务费用。请核对服务计费规则，可随时取消分析。</small></div>'
            + '<p class="grey modhub-ai-settings-hint">测试不发送问题、日志或源码，可能产生少量费用。保存设置不会发送请求。</p>'
            + '<details class="modhub-help-topic"><summary>密钥保存与连接要求</summary><p class="grey">未勾选时，密钥仅在本次页面保留。已保存的密钥可能被其他模组读取，请使用限额密钥。服务需允许浏览器跨域请求。本地 HTML 的来源通常为 null；服务端须允许当前来源的 OPTIONS 预检与 POST，以及 Content-Type 和 Authorization 请求头。若服务仅支持服务器调用，请使用您自行配置的可信中转地址，或选择支持浏览器访问的服务。</p></details>'
            + '<span id="modHubAiSettingsProgress" hidden>' + window.modHubProgressRingHtml(null, '正在测试连接', 'modHubAiSettingsStatus') + '</span><p id="modHubAiSettingsStatus" class="modhub-ai-status grey" role="status" tabindex="-1"></p>'
            + '<p id="modHubAiSettingsError" class="red" role="alert" tabindex="-1"></p><div class="modhub-help-actions modhub-ai-settings-actions">' + button('SettingsTest', '测试连接') + button('SettingsCancel', '取消测试') + button('SettingsBack', '返回帮助') + button('SettingsSave', '保存并返回帮助', true) + '</div></section>'
            + '<div id="modHubAiWorkflow"><ol class="modhub-help-steps modhub-ai-steps" aria-label="AI 修复步骤"><li data-ai-step="1">描述问题</li><li data-ai-step="2">确认分析</li><li data-ai-step="3">查看方案</li><li data-ai-step="4">重载验证</li></ol>'
            + '<p id="modHubAiStatus" class="modhub-ai-status" role="status" aria-live="polite" tabindex="-1"></p>'
            + '<div id="modHubAiProgress" class="modhub-ai-progress" hidden>' + window.modHubProgressRingHtml(null, '正在处理', 'modHubAiStatus modHubAiProgressText') + '<p id="modHubAiProgressText" class="grey"></p><div class="modhub-help-actions modhub-help-actions-links">' + button('Cancel', '取消分析') + '</div></div>'
            + '<details id="modHubAiErrorDetails" class="modhub-help-topic" hidden><summary>查看具体原因</summary><pre id="modHubAiError" class="modhub-ai-error"></pre></details>'
            + '<div id="modHubAiStep1"><section id="modHubAiSuggestions" class="modhub-help-suggestions" aria-labelledby="modHubAiSuggestionsHeading" hidden><h3 id="modHubAiSuggestionsHeading">猜你想问</h3><p class="grey">根据本次加载日志整理，选择一个问题即可继续。</p><div id="modHubAiSuggestionList" class="modhub-help-topics"></div></section>'
            + '<label class="modhub-ai-field modhub-help-question">请描述您遇到的问题<textarea id="modHubAiDescription" rows="4" aria-describedby="modHubAiDescriptionHint modHubAiDescriptionCount" placeholder="例如：安装模组后，打开服装页面出现报错。应该如何解决？"></textarea></label>'
            + '<div class="modhub-help-question-meta"><span id="modHubAiDescriptionHint" class="grey">请说明触发步骤、实际异常与预期结果。可以粘贴错误原文；无需粘贴整个源码文件。</span><span id="modHubAiDescriptionCount" class="grey">0 / 4000 字</span></div>'
            + '<div class="modhub-help-actions modhub-help-actions-primary">' + button('Start', '获取帮助', true) + '</div>'
            + '<h3>常见问题</h3><p class="grey">也可以直接查看排查步骤和可用的配置修复，无需连接 AI。</p><div class="modhub-help-topics">'
            + MODHUB_HELP_TOPICS.map((topic, index) => '<button type="button" class="macro-button modhub-btn-secondary" data-help-topic="' + index + '">' + escape(topic.title) + '</button>').join('') + '</div></div>'
            + '<div id="modHubAiStep2" hidden><section class="modhub-ai-review"><h3>将发送哪些信息</h3><p class="grey modhub-ai-review-hint">已在本机整理。确认后，AI 将分析原因并查找处理方法。</p>'
            + '<dl class="modhub-ai-overview"><dt>分析范围</dt><dd id="modHubAiTargetSummary" hidden></dd><dt>源码</dt><dd id="modHubAiSelectionSummary"></dd></dl>'
            + '<div id="modHubAiLogSummary" class="modhub-ai-log-summary"></div>'
            + '<details class="modhub-help-topic"><summary>您描述的问题</summary><p id="modHubAiProblem" class="modhub-ai-problem"></p></details>'
            + '<div id="modHubAiSetup" hidden>'
            + '<details id="modHubAiMaterialDetails" class="modhub-help-topic"><summary>查看将发送的完整材料</summary><textarea id="modHubAiMaterial" class="modhub-help-report" readonly aria-label="将发送的材料"></textarea></details>'
            + '<div class="modhub-ai-send"><p id="modHubAiConnectionHint" class="grey"></p>'
            + '<label class="modhub-ai-remember"><input id="modHubAiAutoContinue" type="checkbox" checked aria-describedby="modHubAiAutoScope">自动补充相关源码，持续定位</label><p id="modHubAiAutoScope" class="grey modhub-ai-send-notice"></p><details id="modHubAiAutoScopeDetails" class="modhub-help-topic"><summary>查看允许补充的源码范围</summary><div id="modHubAiAutoScopeList"></div></details>'
            + '<p class="grey modhub-ai-send-notice">点击“发送并分析”即同意发送上述材料及勾选的补充范围。服务可能收费；代码修改需另行确认。</p>'
            + '<div class="modhub-help-actions modhub-help-actions-primary">' + button('Analyze', '发送并分析', true) + '</div></div></div></section>'
            + '<details id="modHubAiScopeDetails" class="modhub-help-topic modhub-ai-selection"><summary>高级选项：调整分析范围</summary><p class="grey">通常无需更改。日志提及的模组不一定是问题原因；只有预览并确认修改后才会保存代码。</p>'
            + '<p id="modHubAiSelectionReason" class="grey"></p>'
            + '<label class="modhub-ai-field">分析对象<select id="modHubAiTarget"><option value="">不确定，先分析日志</option></select></label>'
            + '<div class="modhub-help-actions modhub-help-actions-links">' + button('Prepare', '重新整理材料') + button('Refresh', '刷新日志与模组') + '</div>'
            + '<details id="modHubAiSelectionDetails" class="modhub-help-topic"><summary>查看或调整文件选择</summary><p class="grey">单文件最多 256 KiB，合计最多 512 KiB、20 个文件。仅能提供目标模组声明的文本。</p><div id="modHubAiFiles" class="modhub-ai-files"></div>'
            + '<div class="modhub-help-actions modhub-help-actions-links">' + button('Preview', '按选择更新材料') + '</div></details></details>'
            + '</div>'
            + '<div id="modHubAiStep3" hidden><section class="modhub-ai-result"><div id="modHubAiAdvice"></div><p id="modHubAiNextHint" class="grey"></p>'
            + '<textarea id="modHubAiDiff" class="modhub-help-report" readonly aria-label="AI 建议的代码改动"></textarea>'
            + '<p id="modHubAiCodeRepairHint" class="grey" hidden></p>'
            + '<div class="modhub-help-actions modhub-help-actions-primary">' + button('Retry', '查看分析材料') + button('Continue', '继续自动排查', true) + button('LocalRepair', '检查可用配置修复', true) + button('DescribeMore', '调整问题说明（可选）') + button('Apply', '确认并应用这份修改', true) + '</div></section><div id="modHubAiAdviceDetails"></div></div>'
            + '<div id="modHubAiStep4" hidden><p id="modHubAiSaved" class="gold"></p><p>先保存游戏进度，再重新载入，重复原操作检查异常是否消失。加载完成只能说明已启动，不能证明原问题已经解决。</p>'
            + '<div class="modhub-help-actions modhub-help-actions-primary">' + button('Reload', '重新载入以验证', true) + button('Verified', '我已验证，问题已解决') + '</div>'
            + '<div class="modhub-help-actions modhub-help-actions-links">' + button('Undo', '撤销本次修复（时间点还原）') + button('Again', '分析另一个问题') + '</div></div>'
            + '<footer id="modHubAiFooter" class="modhub-ai-footer" hidden><div id="modHubAiNavigation" class="modhub-help-actions modhub-ai-navigation" hidden>' + button('Back', '返回描述问题', true) + action('加载日志') + action('模组说明') + '</div>'
            + '<div class="modhub-help-actions modhub-help-actions-links modhub-ai-history-actions">' + button('Last', '查看上次修复与撤销入口') + '</div></footer></div>';
        const el = id => host.querySelector('#modHubAi' + id);
        const current = value => mounted === viewRevision && value === ticket && host.isConnected !== false;
        const stopProgress = () => {
            if (progressTimer !== null) clearInterval(progressTimer);
            progressTimer = null;
            el('Progress').hidden = true;
            if (aiStopProgress === stopProgress) aiStopProgress = null;
        };
        const startProgress = () => {
            stopProgress();
            const started = Date.now();
            el('Progress').hidden = false;
            const update = () => {
                if (mounted !== viewRevision || host.isConnected === false) { stopProgress(); return; }
                el('ProgressText').textContent = '已用 ' + Math.floor((Date.now() - started) / 1000) + ' 秒；处理时间取决于材料大小和服务响应。';
            };
            update();
            progressTimer = setInterval(update, 1000);
            aiStopProgress = stopProgress;
        };
        const status = (message, color = 'grey') => {
            el('Status').textContent = message;
            el('Status').className = 'modhub-ai-status ' + color;
            el('ErrorDetails').hidden = true;
            el('Error').textContent = '';
        };
        const renderSuggestions = () => {
            suggestions = suggestQuestions(readLogs());
            el('Suggestions').hidden = !suggestions.length;
            el('SuggestionList').innerHTML = suggestions.map((item, index) => '<button type="button" class="macro-button modhub-btn-secondary" data-ai-suggestion="' + index + '"><span>'
                + escape(item.question) + '</span><small class="grey">' + (item.level === 'error' ? '来自错误日志' : '来自警告日志') + '</small></button>').join('');
        };
        const show = next => {
            stage = next;
            if (stage === 1) renderSuggestions();
            el('Welcome').hidden = stage !== 1;
            for (let i = 1; i <= 4; i++) el('Step' + i).hidden = i !== stage;
            el('TargetSummary').hidden = stage === 1 || stage === 4 || !prepared && !plan;
            host.querySelectorAll('[data-ai-step]').forEach(item => {
                item.className = Number(item.dataset.aiStep) === stage ? 'gold' : 'grey';
                if (Number(item.dataset.aiStep) === stage) item.setAttribute('aria-current', 'step');
                else item.removeAttribute('aria-current');
            });
            el('Last').hidden = !last || stage === 4;
            el('Navigation').hidden = stage !== 2;
            el('Footer').hidden = stage !== 2 && (!last || stage === 4);
            host.scrollIntoView?.({ block: 'start' });
        };
        const controls = value => {
            working = value;
            host.setAttribute('aria-busy', String(value));
            host.querySelectorAll('button, input, select, textarea:not([readonly])').forEach(item => { item.disabled = value; });
            el('MaxRounds').disabled = value || el('UnlimitedRounds').checked;
            el('Cancel').hidden = !value || !analyzing;
            el('Cancel').disabled = false;
            el('SettingsCancel').hidden = !testing;
            el('SettingsProgress').hidden = !testing;
            el('SettingsCancel').disabled = false;
            el('SettingsBack').disabled = value && !testing;
            el('SettingsTest').textContent = testing ? '正在测试…' : '测试连接';
            el('Analyze').disabled = value || !prepared;
            el('Analyze').textContent = analyzing ? '正在分析…' : '发送并分析';
            el('Apply').disabled = value || !plan?.changes?.length;
            el('Apply').hidden = !plan?.changes?.length;
            const canContinue = !continuationBlocked && Boolean(plan?.readRequest || plan?.canContinue || plan?.canTriage);
            el('DescribeMore').hidden = stage !== 3 || !plan || Boolean(plan.changes.length) || canContinue;
            el('LocalRepair').hidden = stage !== 3 || !plan || Boolean(plan.changes.length) || canContinue;
            el('Continue').disabled = value || !canContinue;
            el('Continue').hidden = !canContinue;
            el('Continue').textContent = plan?.validationFeedback?.kind === 'response-format' && plan?.responseCorrection ? '继续校正回复' : plan?.readRequest ? '确认新增材料并继续' : '继续自动排查';
            el('Undo').disabled = value || !last?.pointId;
            el('Verified').disabled = value || !last || last.verified || last.uncertain;
            el('Reload').disabled = value || Boolean(last?.uncertain);
            host.querySelectorAll('[data-ai-unavailable]').forEach(item => { item.disabled = true; });
        };
        const invalidate = () => {
            prepared = plan = null;
            el('Material').value = '';
            el('SelectionSummary').textContent = '正在整理。';
            controls(working);
        };
        const run = async action => {
            if (working) return;
            const value = ++ticket;
            let focus = null;
            controls(true);
            startProgress();
            try { focus = await action(value); }
            catch (error) {
                if (current(value)) {
                    status('操作未完成。请查看具体原因，调整后重试；已填写的内容保留。', 'red');
                    el('Error').textContent = detail(error);
                    el('ErrorDetails').hidden = false;
                    el('ErrorDetails').open = true;
                    el('Status').focus();
                }
            }
            finally { if (current(value)) { stopProgress(); controls(false); focus?.focus({ preventScroll: true }); } }
        };
        const readTargets = async value => {
            status('正在读取已安装模组。');
            const targets = await api.listTargets();
            if (!current(value)) return;
            analysis = readLogs();
            const mentioned = targets.filter(item => (analysis.errorMods || []).includes(item.name));
            const enabled = targets.filter(item => item.enabled);
            const selected = targets.some(item => item.name === aiDraft.modName) ? aiDraft.modName
                : mentioned.length === 1 ? mentioned[0].name : enabled.length === 1 ? enabled[0].name : '';
            el('Target').innerHTML = '<option value="">不确定，先分析日志</option>' + targets.map(item => '<option value="' + escape(item.name) + '">' + escape(item.name) + ' ' + escape(item.bootJson?.version || '') + (item.error ? '（包体待核对）' : item.enabled ? '' : '（已禁用）') + '</option>').join('');
            el('Target').value = selected;
        };
        const connectionStatus = () => {
            const ready = aiConnection.endpoint.trim() && aiConnection.model.trim();
            el('ConnectionStatus').textContent = ready ? 'AI 服务已配置 · 模型：' + aiConnection.model : '尚未配置 AI 服务';
            el('ConnectionHint').textContent = ready ? '发送至：' + aiConnection.endpoint + ' · 模型：' + aiConnection.model : '尚未配置 AI 服务。请从上方“AI 连接设置”入口填写；整理材料不需要联网。';
        };
        const renderLogSummary = () => {
            const lines = (analysis.lines || []).filter(item => ['error', 'warn'].includes(item.level));
            const excerpts = aiDraft.error ? [{ message: aiDraft.error }, ...lines.filter(item => item.message !== aiDraft.error)] : lines;
            el('LogSummary').innerHTML = '<details class="modhub-help-topic"><summary>加载日志：' + (analysis.errorCount || 0) + ' 条错误，' + (analysis.warnCount || 0) + ' 条警告</summary>'
                + (aiDraft.error ? '<p class="grey">已保留您选择的完整错误。</p>' : '')
                + (excerpts.length ? excerpts.slice(0, 3).map(item => '<pre class="modhub-ai-error">' + escape(item.message) + '</pre>').join('') : '<p class="grey">暂无错误或警告，将结合您的描述与环境清单分析。</p>')
                + '<p class="grey">日志提及的模组不一定是问题原因；本次日志不能验证尚未重新载入的配置。</p></details>';
        };
        const allowedSources = next => {
            const scope = new Map((next.sourceCatalog || []).map(source => [source.name, new Set(source.files.map(file => file.path))]));
            if (next.name) {
                if (!scope.has(next.name)) scope.set(next.name, new Set());
                for (const file of next.files || []) scope.get(next.name).add(file.path);
            }
            for (const file of JSON.parse(next.material).sourceEvidence || []) {
                if (!scope.has(file.name)) scope.set(file.name, new Set());
                scope.get(file.name).add(file.path);
            }
            return scope;
        };
        const setMaterial = (next, review = true) => {
            prepared = next;
            needsPreparation = false;
            const evidenceCount = JSON.parse(next.material).sourceEvidence?.length || 0;
            const gameEvidence = JSON.parse(next.material).gameEvidence || [];
            el('Material').value = next.material;
            el('MaterialDetails').open = false;
            el('TargetSummary').textContent = next.name ? '【' + next.name + '】' + (next.bootJson?.version ? ' ' + next.bootJson.version : '') + '（待核对）' : '问题描述、环境清单与加载日志';
            el('SelectionSummary').textContent = next.files.length ? next.files.length + ' 个相关文件。可展开查看完整内容。'
                : evidenceCount ? evidenceCount + ' 份只读源码证据；不能直接应用修改。'
                : next.sourceCatalog?.length ? '已整理文件清单和补丁声明。分析时可补充相关源码。' : '本次不提供源码。';
            if (gameEvidence.length) el('SelectionSummary').textContent += ' 另附 ' + gameEvidence.length + ' 份游戏段落只读证据，可在完整材料中查看。';
            const scope = allowedSources(next);
            const maxRounds = JSON.parse(next.material).diagnosisContext?.maxRounds ?? aiConnection.maxRounds;
            el('AutoScope').textContent = scope.size ? '勾选后，将从下列 ' + scope.size + ' 个模组的声明文件自动核对问题来源并生成修改，您无需选择修复对象。' + roundLimitText(maxRounds) + '，每轮源码不超过 512 KiB；找到方案或没有新证据时提前停止。可随时取消，轮次增加可能产生更多服务费用；范围外材料需再次确认。大文件仅发送标明位置的只读片段。'
                : '本次没有可补充的已核验源码。将分析当前材料，不自动扩大范围。';
            el('AutoScopeDetails').hidden = !scope.size && !gameEvidence.length;
            el('AutoScopeList').innerHTML = [...scope].map(([name, paths]) => '<details class="modhub-help-topic"><summary>' + escape(name) + '（' + paths.size + ' 个文件）</summary><ul>' + [...paths].map(path => '<li>' + escape(path) + '</li>').join('') + '</ul></details>').join('');
            if (gameEvidence.length) el('AutoScopeList').innerHTML += '<details class="modhub-help-topic"><summary>游戏段落只读证据（' + gameEvidence.length + ' 份）</summary><ul>' + gameEvidence.map(item => '<li>' + escape(item.passage) + '（仅供核对，不能修改）</li>').join('') + '</ul></details>';
            el('ScopeDetails').open = false;
            el('Setup').hidden = false;
            if (review) {
                show(2);
                status('材料已整理。请确认后开始分析。');
            }
            if (next.sourceUnavailable?.length) {
                el('Error').textContent = next.sourceUnavailable.map(item => (item.name ? '【' + item.name + '】' : '') + item.reason).join('\n');
                el('ErrorDetails').hidden = false;
            }
        };
        const renderFiles = (next, paths) => {
            el('Files').innerHTML = (next?.fileNames || []).map(item => '<label class="modhub-ai-file"><input type="checkbox" data-ai-file="' + escape(item.path) + '"' + (paths.includes(item.path) ? ' checked' : '') + (item.size > 262144 ? ' disabled data-ai-unavailable' : '') + '><span>' + escape(item.path) + ' <span class="grey">(' + (item.size / 1024).toFixed(1) + ' KiB)</span></span></label>').join('');
            el('SelectionDetails').hidden = !next?.fileNames.length;
            el('Files').onchange = () => { invalidate(); status('分析范围已更改。请在高级选项中点击“按选择更新材料”。', 'gold'); };
            controls(working);
        };
        const prepareLogSources = value => api.prepareLogs(el('Description').value, {
            logError: aiDraft.error, includeSources: true, maxRounds: aiConnection.maxRounds,
            onProgress: () => { if (current(value)) status('正在核对已安装模组的源码清单；尚未发送。'); }
        });
        const prepareSelection = async value => {
            candidate = null;
            invalidate();
            el('Setup').hidden = true;
            el('TargetSummary').hidden = true;
            analysis = readLogs();
            renderLogSummary();
            status('正在根据问题与加载日志整理材料；不会联网或修改模组。');
            let reason = '未确定相关模组，先分析日志与环境，不改写文件。';
            let paths = [], packageError = '';
            if (el('Target').value) {
                try {
                    const next = await api.prepare(el('Target').value, el('Description').value, { paths: [], logError: aiDraft.error, maxRounds: aiConnection.maxRounds });
                    if (!current(value)) return;
                    candidate = next;
                    const selectedLog = aiDraft.error ? window.modHubAnalyzeLogs([{ level: 'error', message: aiDraft.error }]).lines || [] : [];
                    const recommended = api.recommendFiles(next, [...(analysis.lines || []), ...selectedLog]);
                    paths = recommended.paths;
                    reason = recommended.reason;
                } catch (error) {
                    if (!current(value)) return;
                    packageError = detail(error);
                    reason = '无法读取目标模组的源码，先分析日志与环境。';
                }
            }
            if (!current(value)) return;
            renderFiles(candidate, paths);
            let next;
            if (paths.length) {
                try { next = await api.prepare(candidate.name, candidate.description, { paths, logError: aiDraft.error, includeSources: true, maxRounds: aiConnection.maxRounds }); }
                catch (error) {
                    if (!current(value)) return;
                    packageError = detail(error);
                    reason = '无法读取推荐文件的完整文本，先分析日志与环境。';
                    paths = [];
                    host.querySelectorAll('[data-ai-file]').forEach(item => { item.checked = false; });
                }
            }
            if (!current(value)) return;
            if (!next) next = await prepareLogSources(value);
            if (!current(value)) return;
            el('SelectionReason').textContent = reason + (paths.length ? ' 将提供 ' + paths.length + ' 个声明文件，可展开查看完整材料。'
                : next.sourceCatalog?.length ? ' 已附可用源码清单，AI 可请求相关文件继续生成修复方案。本次不发送源码。' : ' 本次不提供源码；AI 仅给出排查建议。');
            if (!paths.length && JSON.parse(next.material).gameEvidence?.length) el('SelectionReason').textContent = reason + ' 本次未提供可修改源码，已附游戏段落只读证据供核对；可展开查看完整材料。';
            setMaterial(next);
            if (next.sourceUnavailable?.length) packageError = [packageError, ...next.sourceUnavailable.map(item => (item.name ? '【' + item.name + '】' : '') + item.reason)].filter(Boolean).join('\n');
            if (packageError) {
                el('Error').textContent = packageError;
                el('ErrorDetails').hidden = false;
            }
            return el('Status');
        };
        const testStatus = (message, color = 'grey') => {
            el('SettingsStatus').textContent = message;
            el('SettingsStatus').className = 'modhub-ai-status ' + color;
        };
        const cancelTest = () => {
            if (!testing) return;
            ++testTicket;
            testController?.abort();
            if (aiConnectionAbort === testController) aiConnectionAbort = null;
            testController = null;
            testing = false;
            controls(false);
            testStatus('已取消连接测试。', 'gold');
        };
        const closeSettings = () => {
            cancelTest();
            el('SettingsPanel').hidden = true;
            el('Workflow').hidden = false;
            el('Welcome').hidden = stage !== 1;
            el('Toolbar').hidden = false;
            el('Settings').setAttribute('aria-expanded', 'false');
            if (needsPreparation && stage === 2) {
                el('ScopeDetails').open = true;
                el('Prepare').focus();
            } else el('Settings').focus();
        };
        el('SettingsTest').onclick = async () => {
            if (working) return;
            const value = ++testTicket;
            const controller = new AbortController();
            testController = aiConnectionAbort = controller;
            const testCurrent = () => mounted === viewRevision && host.isConnected !== false && value === testTicket;
            testing = true;
            controls(true);
            el('SettingsError').textContent = '';
            testStatus('正在测试连接，最多等待 15 秒；您可以取消。');
            try {
                await api.testConnection({ endpoint: aiConnection.endpoint, model: aiConnection.model, key: aiConnection.key, signal: controller.signal });
                if (testCurrent()) testStatus('连接成功。可以继续进行分析与修复。', 'green');
            } catch (error) {
                if (testCurrent()) testStatus(detail(error), 'red');
            } finally {
                if (aiConnectionAbort === controller) aiConnectionAbort = null;
                if (testCurrent()) {
                    testing = false;
                    testController = null;
                    controls(false);
                    el('SettingsStatus').focus();
                }
            }
        };
        el('SettingsCancel').onclick = cancelTest;
        el('Settings').setAttribute('aria-controls', 'modHubAiSettingsPanel');
        el('Settings').setAttribute('aria-expanded', 'false');
        el('Settings').onclick = () => {
            el('SettingsPanel').hidden = false;
            el('Workflow').hidden = true;
            el('Welcome').hidden = el('Toolbar').hidden = true;
            el('Settings').setAttribute('aria-expanded', 'true');
            el('SettingsError').textContent = '';
            host.scrollIntoView?.({ block: 'start' });
            el('Endpoint').focus();
        };
        el('SettingsBack').onclick = closeSettings;
        el('SettingsSave').onclick = () => {
            try {
                if (!Number.isSafeInteger(aiConnection.maxRounds) || !el('UnlimitedRounds').checked && aiConnection.maxRounds < 1) throw new Error('分析轮次必须为正整数；如需不限轮次，请勾选“不限轮次”。');
                aiConnection.maxRounds = api.normalizeMaxRounds(aiConnection.maxRounds);
                api.validateConnection(aiConnection);
                localStorage.setItem('modhub_ai_connection', JSON.stringify({ endpoint: aiConnection.endpoint, model: aiConnection.model,
                    maxRounds: aiConnection.maxRounds,
                    ...(aiConnection.maxRounds === 0 ? { finiteRounds: aiConnection.finiteRounds } : {}),
                    ...(aiConnection.remember ? { remember: true, key: aiConnection.key } : {}) }));
                closeSettings();
                status('连接设置已保存，未发送请求。' + (aiConnection.remember ? '已在本机记住密钥。' : '密钥仅保留在本次页面内存，本机保存的密钥已移除。') + (needsPreparation ? '请点击“重新整理材料”以使用新的轮次设置。' : '请继续处理问题。'), 'gold');
            } catch (error) { el('SettingsError').textContent = detail(error); el('SettingsError').focus(); }
        };
        el('Endpoint').value = aiConnection.endpoint;
        el('Model').value = aiConnection.model;
        el('Key').value = aiConnection.key;
        el('MaxRounds').value = aiConnection.finiteRounds;
        el('UnlimitedRounds').checked = aiConnection.maxRounds === 0;
        const updateRoundsNotice = () => {
            el('RoundsNotice').hidden = !el('UnlimitedRounds').checked && !(aiConnection.finiteRounds >= 10);
            el('MaxRounds').disabled = working || el('UnlimitedRounds').checked;
        };
        const changeRounds = () => {
            if (working) return;
            aiConnection.finiteRounds = el('MaxRounds').value ? Number(el('MaxRounds').value) : NaN;
            if (el('UnlimitedRounds').checked && (!Number.isSafeInteger(aiConnection.finiteRounds) || aiConnection.finiteRounds < 1)) {
                aiConnection.finiteRounds = 5;
                el('MaxRounds').value = aiConnection.finiteRounds;
            }
            const maxRounds = el('UnlimitedRounds').checked ? 0 : Number.isSafeInteger(aiConnection.finiteRounds) && aiConnection.finiteRounds > 0 ? aiConnection.finiteRounds : NaN;
            updateRoundsNotice();
            if (maxRounds === aiConnection.maxRounds) return;
            const hadMaterial = Boolean(prepared || plan);
            aiConnection.maxRounds = maxRounds;
            candidate = null;
            invalidate();
            needsPreparation = true;
            el('Setup').hidden = true;
            el('SettingsError').textContent = '';
            if (hadMaterial) show(2);
            status('轮次设置已更改。请重新整理材料，确认后再发送。', 'gold');
        };
        el('MaxRounds').oninput = changeRounds;
        el('UnlimitedRounds').onchange = changeRounds;
        updateRoundsNotice();
        el('RememberMe').checked = aiConnection.remember;
        el('RememberMe').onchange = () => { aiConnection.remember = el('RememberMe').checked; };
        for (const id of ['Endpoint', 'Model', 'Key']) el(id).oninput = () => {
            cancelTest();
            aiConnection[id.toLowerCase()] = el(id).value;
            testStatus('');
            el('SettingsError').textContent = '';
            connectionStatus();
            controls(false);
        };
        el('Target').onchange = () => { aiDraft.modName = el('Target').value; return run(prepareSelection); };
        el('Description').oninput = () => {
            aiDraft.description = el('Description').value;
            candidate = null;
            invalidate();
            el('Setup').hidden = true;
            const length = el('Description').value.length;
            el('DescriptionCount').textContent = length + ' / 4000 字' + (length > 4000 ? '，请精简描述后继续' : '');
            el('DescriptionCount').className = length > 4000 ? 'red' : 'grey';
        };
        el('Start').onclick = () => run(async value => {
            const description = el('Description').value.trim();
            if (!description) throw new Error('请先描述遇到的问题，或选择常见问题查看排查步骤。');
            if (el('Description').value.length > 4000) throw new Error('问题描述超过 4000 字。原文已保留；请保留触发步骤和首处错误。加载日志会自动整理。');
            aiDraft.description = el('Description').value;
            el('Problem').textContent = el('Description').value;
            show(2);
            await readTargets(value);
            if (current(value)) return prepareSelection(value);
        });
        el('SuggestionList').onclick = event => {
            const button = event.target.closest?.('[data-ai-suggestion]');
            if (!button || button.disabled || working || stage !== 1) return;
            const index = Number(button.dataset.aiSuggestion);
            if (!Number.isInteger(index) || !suggestions[index]) return;
            const choice = suggestions[index];
            aiDraft.modName = choice.modName;
            aiDraft.error = choice.error;
            el('Description').value = choice.question;
            el('Description').oninput();
            return el('Start').onclick();
        };
        el('Refresh').onclick = () => run(async value => { await readTargets(value); if (current(value)) return prepareSelection(value); });
        el('Prepare').onclick = () => run(prepareSelection);
        el('Preview').onclick = () => run(async value => {
            const paths = [...host.querySelectorAll('[data-ai-file]:checked')].map(item => item.dataset.aiFile);
            invalidate();
            status('正在生成发送材料；此步骤不会联系 AI 服务。');
            const next = candidate && paths.length ? await api.prepare(candidate.name, candidate.description, { paths, logError: aiDraft.error, includeSources: true, maxRounds: aiConnection.maxRounds })
                : await prepareLogSources(value);
            if (!current(value)) return;
            el('SelectionReason').textContent = next.files.length ? '按您的选择提供 ' + paths.length + ' 个文件，可展开查看完整材料。' : '本次仅分析日志与环境，不提供源码。';
            setMaterial(next);
            return el('Status');
        });
        el('Back').onclick = () => { candidate = null; invalidate(); el('Setup').hidden = true; show(1); status('问题说明仍保留。可直接点击“获取帮助”整理当前日志与环境，也可按需要调整说明。'); };
        const renderPlan = (next, stoppedReason = '') => {
            plan = next;
            continuationBlocked = Boolean(stoppedReason);
            const hasChanges = Boolean(next.changes.length);
            const formatFeedback = next.validationFeedback?.kind === 'response-format';
            const correctingFormat = next.responseCorrection && formatFeedback;
            const title = hasChanges ? '找到待确认的代码修改' : stoppedReason ? '定位已暂停' : formatFeedback ? correctingFormat ? '需要校正分析回复' : '回复未通过校验' : next.readRequest ? '需要读取相关源码' : next.canContinue ? '还需定位问题来源' : '已获得排查建议';
            const summary = String(next.summary || '');
            el('Advice').innerHTML = '<h3>' + title + '</h3><p class="modhub-ai-advice-text">' + escape(summary.length > 240 ? summary.slice(0, 240) + '…' : summary) + '</p>';
            el('AdviceDetails').innerHTML = (summary.length > 240 ? '<details class="modhub-help-topic"><summary>查看完整分析</summary><p class="modhub-ai-advice-text">' + escape(summary) + '</p></details>' : '')
                + '<details class="modhub-help-topic"><summary>分析依据</summary><p class="modhub-ai-advice-text">' + escape(next.evidence) + '</p></details>'
                + '<details class="modhub-help-topic"><summary>如何验证结果</summary><p class="modhub-ai-advice-text">' + escape(next.verification) + '</p></details>'
                + (next.notice ? '<details class="modhub-help-topic"><summary>回复说明</summary><p>' + escape(next.notice) + '</p></details>' : '');
            if (next.readRequest) el('AdviceDetails').innerHTML += '<details class="modhub-help-topic"><summary>需要查看的文件（' + next.readRequest.paths.length + ' 个）</summary><p>【' + escape(next.readRequest.name) + '】：' + escape(next.readRequest.reason) + '</p><ul>'
                + next.readRequest.paths.map(path => '<li>' + escape(path) + '</li>').join('') + '</ul></details>';
            el('NextHint').textContent = stoppedReason || (hasChanges ? '请查看下方修改内容。确认后，将建立还原点并保存。'
                : correctingFormat ? '可使用已确认的材料校正回复，无需补充日志或源码。校正占用本次分析轮次。'
                : next.readRequest ? '继续后只在本机整理【' + next.readRequest.name + '】的 ' + next.readRequest.paths.length + ' 个文件。确认发送后，再生成修复方案。'
                : next.canContinue ? '尚无可应用的修改。可继续核对源码来源，再确认发送。'
                : next.continuationReason || '暂无可应用的修改。可返回调整分析范围，或按下方建议排查。');
            el('Diff').value = next.diff || 'AI 没有提出可应用的代码改动。可使用配置检查，或按上述建议处理。';
            el('Diff').hidden = !hasChanges;
            el('CodeRepairHint').hidden = hasChanges;
            el('CodeRepairHint').textContent = !stoppedReason && correctingFormat ? '系统将保留现有材料和已完成的诊断，在原范围与轮次上限内校正一次回复；尚未修改文件。'
                : !stoppedReason && (next.canContinue || next.canTriage || next.readRequest) ? '将根据日志和已读取的源码自动核对修复对象，您无需判断或选择模组。'
                : '本次尚未生成可应用的修改。当前日志、环境和已读源码均已保留，您无需再次提供这些材料。可先检查已有配置或查看具体分析依据；调整问题说明为可选操作。游戏本体、内嵌模组及大文件只读片段不在代码修改范围内；配置检查仅处理前置和加载顺序。';
            show(3);
            status(hasChanges ? '分析已完成。请审阅修改；尚未保存任何文件。' : '分析已结束，尚无可应用的代码修改。已保留具体原因和下一步，您无需选择修复对象。');
            el('Status').focus({ preventScroll: true });
        };
        const sourceFacts = next => {
            const material = JSON.parse(next.material);
            return [...(next.files || []).map(file => ({ ...file, name: next.name })), ...(material.sourceEvidence || [])];
        };
        const factKey = fact => JSON.stringify([fact.name, fact.path, fact.offset || 0, fact.content]);
        const gameFacts = next => JSON.parse(next.material).gameEvidence || [];
        const gameFactKey = fact => JSON.stringify([fact.passage, fact.source, fact.start, fact.end, fact.offset, fact.content]);
        const inScope = (next, scope, gameScope) => [...allowedSources(next)].every(([name, paths]) => scope.has(name) && [...paths].every(path => scope.get(name).has(path)))
            && sourceFacts(next).every(file => scope.get(file.name)?.has(file.path))
            && gameFacts(next).every(fact => gameScope.has(gameFactKey(fact)));
        el('Analyze').onclick = () => run(async value => {
            if (!prepared) throw new Error('材料尚未就绪。请重新整理材料后再试。');
            try { api.validateConnection(aiConnection); }
            catch (error) { el('Settings').onclick(); el('SettingsError').textContent = detail(error); return el('Endpoint'); }
            const controller = new AbortController();
            const connection = { ...aiConnection };
            const maxRounds = api.normalizeMaxRounds(JSON.parse(prepared.material).diagnosisContext?.maxRounds ?? connection.maxRounds);
            const roundText = round => '第 ' + round + (maxRounds === 0 ? ' 轮（不限轮次）' : ' / ' + maxRounds + ' 轮');
            const automatic = el('AutoContinue').checked;
            const scope = allowedSources(prepared);
            const gameScope = new Set(gameFacts(prepared).map(gameFactKey));
            const knownFacts = new Set(sourceFacts(prepared).map(factKey));
            const knownWritable = new Set(prepared.files.map(file => JSON.stringify([prepared.name, file.path])));
            let triaged = JSON.parse(prepared.material).repairIntent === 'select-code-repair';
            let sent = 0, stoppedReason = '';
            aiAbort = controller;
            analyzing = true;
            controls(true);
            status('正在核对发送材料；您可以取消。');
            el('Status').focus();
            let next;
            try {
                if (automatic) {
                    plan = null;
                    el('Advice').innerHTML = '<h3>正在分析问题</h3><p>将根据加载日志核对相关源码。找到修改方案或无法继续时，会显示结果。</p>';
                    el('AdviceDetails').innerHTML = '';
                    el('CodeRepairHint').hidden = true;
                    el('NextHint').textContent = '将自动核对问题来源并生成修改，' + roundLimitText(maxRounds) + '；找到方案或没有新证据时提前停止。可随时取消，代码修改需要单独确认。';
                    el('Diff').hidden = true;
                    show(3);
                    controls(true);
                }
                while (current(value) && !controller.signal.aborted) {
                    sent++;
                    const round = Number(JSON.parse(prepared.material).diagnosisContext?.round) || sent;
                    const received = await api.analyze(prepared, { ...connection, signal: controller.signal, onProgress: phase => {
                        if (!current(value) || controller.signal.aborted) return;
                        const messages = {
                            preflight: '正在核对发送材料；您可以取消。',
                            request: '正在等待 AI 回复，最多等待 90 秒；您可以取消。',
                            response: '已收到回复，正在读取分析结果；您可以取消。',
                            validate: '正在核对修复方案与原文件；尚未修改模组。'
                        };
                        if (messages[phase]) status(roundText(round) + '：' + messages[phase]);
                    } });
                    if (!current(value) || controller.signal.aborted) break;
                    next = received;
                    if (!automatic || next.changes.length || !next.readRequest && !next.canContinue && !next.canTriage) break;
                    if (maxRounds !== 0 && (sent >= maxRounds || round >= maxRounds)) { stoppedReason = '本次已完成 ' + maxRounds + ' 轮分析，尚无可应用的代码修改。现有材料与分析已保留；如需继续，可在 AI 连接设置中调整轮次后重新整理并确认发送。'; break; }
                    if (next.readRequest && !next.readRequest.paths.every(path => scope.get(next.readRequest.name)?.has(path))) {
                        stoppedReason = '需要补充未确认范围的源码。请点击“确认新增材料并继续”，查看将发送的信息后再确认。'; break;
                    }
                    status(roundText(round) + '已完成，正在自动核对问题来源；您可以取消。');
                    let following;
                    needsPreparation = true;
                    try { following = next.responseCorrection ? await api.prepareInvestigation(next) : next.readRequest ? await api.prepareRequestedSources(next) : next.canTriage ? await api.prepareTriage(next) : await api.prepareInvestigation(next); }
                    catch (error) { stoppedReason = '无法继续收集源码：' + detail(error) + ' 现有材料与分析已保留，可查看不可用原因或检查已有配置。'; break; }
                    if (!current(value)) break;
                    const selectedSource = JSON.parse(prepared.material).repairIntent === 'select-code-repair' && next.readRequest && following.files.length;
                    candidate = following.name ? following : null;
                    aiDraft.modName = following.name || '';
                    el('Target').value = following.name || '';
                    renderFiles(following, following.files.map(file => file.path));
                    setMaterial(following, false);
                    if (controller.signal.aborted) break;
                    if (!inScope(following, scope, gameScope)) { stoppedReason = '新材料超出已确认范围，已暂停发送。请返回分析材料，核对新增范围后继续。'; break; }
                    const facts = sourceFacts(following);
                    const writable = following.files.map(file => JSON.stringify([following.name, file.path]));
                    const selection = JSON.parse(following.material).repairIntent === 'select-code-repair' && !triaged;
                    const correction = next.responseCorrection && JSON.parse(following.material).diagnosisContext?.responseCorrection === true;
                    if (!facts.some(fact => !knownFacts.has(factKey(fact))) && !writable.some(file => !knownWritable.has(file)) && !selection && !selectedSource && !correction) { stoppedReason = '没有收集到新的源码证据，已停止重复分析。现有日志和源码已保留，可查看具体原因或检查已有配置，无需选择责任模组。'; break; }
                    if (selection) triaged = true;
                    facts.forEach(fact => knownFacts.add(factKey(fact)));
                    writable.forEach(file => knownWritable.add(file));
                }
            }
            catch (error) {
                if (!controller.signal.aborted) {
                    if (!next) { show(2); throw error; }
                    stoppedReason = '后续分析未完成：' + detail(error) + ' 已保留上次结果和当前材料。';
                }
            }
            finally { analyzing = false; if (aiAbort === controller) aiAbort = null; }
            if (!current(value)) return;
            if (controller.signal.aborted) {
                if (next) renderPlan(next, '已取消持续定位。已读材料和上次结果保留；尚未修改文件。');
                else show(2);
                status('已取消分析。材料仍保留，可再次发送。', 'gold');
                return next ? el('Retry') : el('Analyze');
            }
            renderPlan(next, stoppedReason);
            if (stoppedReason.startsWith('需要补充未确认范围')) continuationBlocked = false;
        });
        el('LocalRepair').onclick = async () => {
            if (working) return;
            const details = document.getElementById('modHubHelpLocalDetails');
            const check = document.getElementById('modHubHelpCheck');
            if (!details || !check) return;
            details.open = true;
            details.scrollIntoView?.({ block: 'start' });
            await check.onclick();
            details.querySelector('summary')?.focus();
        };
        el('DescribeMore').onclick = () => { el('Back').onclick(); el('Description').focus({ preventScroll: true }); };
        el('Continue').onclick = () => run(async value => {
            continuationBlocked = true;
            needsPreparation = true;
            if (!plan?.readRequest && !plan?.canContinue && !plan?.canTriage) throw new Error(plan?.continuationReason || '当前没有可继续核对的新证据。现有材料与分析已保留，可查看具体原因或检查已有配置。');
            status(plan.readRequest ? '正在核对并读取相关源码；不会联网或修改模组。' : '正在核对其他源码来源；不会联网或修改模组。');
            const next = plan.responseCorrection ? await api.prepareInvestigation(plan) : plan.readRequest ? await api.prepareRequestedSources(plan) : plan.canTriage ? await api.prepareTriage(plan) : await api.prepareInvestigation(plan);
            if (!current(value)) return;
            candidate = next.name ? next : null;
            plan = null;
            aiDraft.modName = next.name || '';
            el('Target').value = next.name || '';
            renderFiles(next, next.files.map(file => file.path));
            el('SelectionReason').textContent = next.name ? '已整理【' + next.name + '】的 ' + next.files.length + ' 个相关文件。已保留前次分析，确认发送后继续。'
                : '已保留前次分析与已核对文件记录。将继续从真实声明清单查找来源，本次不提供可修改源码。';
            setMaterial(next);
            status(next.name ? '相关源码已整理。请确认后继续分析。' : '来源清单已整理。请确认后继续定位。');
            return el('Status');
        });
        el('Cancel').onclick = () => { aiAbort?.abort(); status('已请求取消。请等待本次分析结束。', 'gold'); };
        el('Retry').onclick = () => {
            if (needsPreparation) return run(prepareSelection);
            plan = null;
            show(2);
            controls(false);
            status('材料仍保留。需要时可在高级选项调整范围，再点击“发送并分析”。');
        };
        const saved = () => {
            el('Saved').textContent = '【' + last.name + '】' + (last.uncertain ? '操作未完整通过核验。请先查看具体原因，核对或还原修复前状态。' : last.verified ? '已由您确认原问题解决。' : '代码修改已保存，等待重新载入并验证。') + ' 修复前还原点：' + last.pointId;
            el('Verified').disabled = Boolean(last.verified);
            show(4);
        };
        el('Apply').onclick = () => run(async value => {
            if (!plan?.changes?.length) throw new Error('当前没有可应用的方案，请重新分析。');
            if (!await window.modHubConfirm({ title: '确认应用 AI 代码修改', message: '将修改【' + plan.name + '】中的以下文件：\n' + [...new Set(plan.changes.map(item => item.path))].join('\n') + '\n\n保存前必须成功建立修复前时间点，启禁与顺序保留。AI 建议尚未验证，重新导入或更新模组会覆盖修改。是否应用已预览的方案？', confirmText: '建立还原点并应用', cancelText: '取消' })) return;
            status('正在建立还原点、保存包体并回读核验。');
            const resultHash = plan.data ? await window.modHubAiPackage.hash(plan.data) : null;
            const result = await api.apply(plan);
            if (!current(value)) return;
            if (!result.ok) {
                if (result.pointId) {
                    last = { name: plan.name, pointId: result.pointId, at: new Date().toISOString(), uncertain: true, verified: false };
                    try { localStorage.setItem('modhub_ai_last_repair', JSON.stringify(last)); } catch (_) {}
                    saved();
                }
                throw new Error(result.reason || '保存未完成，请重新分析。');
            }
            last = { name: plan.name, pointId: result.pointId, at: new Date().toISOString(), verification: plan.verification, verified: false,
                hash: resultHash };
            try { localStorage.setItem('modhub_ai_last_repair', JSON.stringify(last)); } catch (_) {}
            plan = prepared = null;
            saved();
            status(result.reason || '包体已保存并核验。请先保存游戏，再重新载入验证。', 'gold');
        });
        el('Last').onclick = () => run(async value => {
            if (!last) return;
            if (last.hash) {
                const installed = await window.modHubReadInstalledModPackage(last.name);
                if (installed.error) throw installed.error;
                const hash = installed.data && await window.modHubAiPackage.hash(installed.data);
                if (!current(value)) return;
                if (hash !== last.hash) {
                    last = null;
                    try { localStorage.removeItem('modhub_ai_last_repair'); } catch (_) {}
                    show(1);
                    status('上次修复包已被更新、替换或还原，记录不再对应当前包体。需要时可从时间点历史查看原记录。', 'gold');
                    return;
                }
            }
            saved();
            status('这是上次修复记录。请结合实际复现结果决定继续验证或还原。');
        });
        el('Reload').onclick = () => window.modHubOfferReload?.('AI 修改已保存。请先保存游戏进度，再重新载入并重复原操作验证。');
        el('Verified').onclick = () => {
            if (!last) return;
            last.verified = true;
            try { localStorage.setItem('modhub_ai_last_repair', JSON.stringify(last)); } catch (_) {}
            saved();
            status('已记录您的验证结果。修复前时间点仍按历史保留规则保存。', 'green');
        };
        el('Undo').onclick = () => run(async () => {
            status('正在核对修复前时间点。请在还原确认页查看影响；取消不会变更。');
            const id = last.pointId;
            if (!await window.modHubRestore.restore(id)) status('已取消还原。修复后的包体保留。', 'gold');
            else {
                try {
                    const record = JSON.parse(localStorage.getItem('modhub_ai_last_repair') || 'null');
                    if (record?.pointId === id) localStorage.removeItem('modhub_ai_last_repair');
                } catch (_) {}
            }
        });
        el('Again').onclick = () => { aiDraft.description = aiDraft.modName = aiDraft.error = ''; el('Description').value = ''; el('Description').oninput(); candidate = null; show(1); status('描述新的异常，或选择常见问题查看排查步骤。'); };
        el('Description').value = aiDraft.description;
        el('Description').oninput();
        show(1);
        controls(false);
        connectionStatus();
        status('描述问题后，将自动整理加载日志和分析材料。');
        if (aiOpenRequested) { aiOpenRequested = false; el('Start').onclick(); }
    }

    const MODHUB_HELP_TOPICS = [
        { title: '加载卡住或无法进入游戏', steps: ['先查看加载进度是否仍在变化；有实际进展时继续等待。', '若加载页出现救援入口，可查看原因并选择已有时间点；没有历史时不能通过时间点还原补回配置。', '无法进入 ModHub 时，使用游戏原生模组管理器核对最近安装或更新的模组。'], tabs: ['加载日志', '模组管理'], restore: true },
        { title: '出现报错或怀疑模组冲突', steps: ['先查看首处具体错误及其前后日志，避免只按日志中出现的名称判断责任模组。', '检查前置、版本要求与作者说明。补丁未匹配或警告不等于已经确定模组互斥。', '需要逐项禁用排查时，在模组管理中操作并重新载入，每次只改变一个可比较的条件。'], tabs: ['加载日志', '模组管理', '模组说明'] },
        { title: '模组安装后没有生效', steps: ['核对是否已导入正式安装包、处于启用状态，并满足作者要求的前置。', '安装、启禁或排序调整后，先保存游戏进度，再重新载入。', '查看模组说明中的触发条件与使用入口；安装成功不代表所有功能会立即出现。'], tabs: ['模组管理', '模组说明'] },
        { title: '图片缺失或美化显示异常', steps: ['使用分离图片的游戏本体时，核对原版图像包 GameOriginalImagePack 是否已安装、启用且适配当前游戏。', '查看美化图包的启用状态与覆盖顺序；可选美化不能代替原版基础图片。', '查看图像加载错误及作者适配说明，区分资源缺失与特定图包覆盖。'], tabs: ['加载日志', '模组管理', '模组说明'] },
        { title: '更新后出现异常', steps: ['核对当前游戏与实际安装模组版本，查看作者发布说明。', '先保存游戏进度；需要回退时可进入时间点还原，核对变更预览后再决定。', '时间点覆盖旁加载包与管理配置，不恢复游戏存档、游戏 HTML 或内嵌模组。'], tabs: ['模组说明', '模组市场'], restore: true },
        { title: '下载或导入失败', steps: ['保留具体错误原因，网络请求失败时可在原流程中重试。', '从正式 Release 附件获取安装包；GitHub 自动生成的 Source code 压缩包通常不能直接导入。', 'Zip 安装包根目录应包含 boot.json。只改文件名不能修复目录结构；其他格式需满足加载器原生校验要求。'], tabs: ['模组市场', '模组管理'] }
    ];

    function action(tab, query = '') {
        return '<button type="button" class="macro-button modhub-btn-secondary" data-help-tab="' + escape(tab)
            + '" data-help-query="' + escape(query) + '">查看' + escape(tab) + '</button>';
    }

    function renderResults(container, snapshot, checked) {
        if (snapshot.stale) {
            container.innerHTML = '<p class="gold" role="status">检查期间配置发生变化。请等待操作完成后重新检查。</p>';
            return;
        }
        const config = snapshot.issues.filter(issue => !issue.id.startsWith('log-'));
        const logs = snapshot.issues.filter(issue => issue.id.startsWith('log-'));
        const problem = config.some(issue => issue.status === 'problem');
        const review = config.some(issue => issue.status === 'review');
        const title = !checked ? '尚未检查已保存配置' : problem ? '发现配置问题' : review ? '配置需要核对' : '未发现已知配置问题';
        const cards = issues => issues.map(issue => '<article class="modhub-help-result"><strong class="' + (issue.status === 'problem' ? 'red' : 'gold')
                + '">' + escape(issue.title) + '</strong><p>依据：' + escape(issue.evidence)
                + '</p><p class="grey">建议：' + escape(issue.advice) + '</p><div class="modhub-help-actions">'
                + (issue.repair ? '<button type="button" class="macro-button modhub-btn-primary" data-help-repair="' + escape(issue.id) + '">预览修复</button>' : '')
                + action(issue.tab, issue.query) + '</div></article>').join('');
        container.innerHTML = '<p class="modhub-help-result-state ' + (problem ? 'red' : review || !checked ? 'gold' : 'green') + '">' + title + '</p>'
            + '<p class="grey">' + (!checked ? '开始检查后，将查找可确认的前置和顺序问题。检查不会修改配置。' : '可直接处理的项目提供“预览修复”；其余项目保留具体原因和处理入口。检查不代表全部兼容。') + '</p>'
            + cards(config) + (snapshot.different ? '<div class="modhub-help-actions"><button type="button" class="macro-button modhub-btn-primary" data-help-reload>重新载入以验证配置</button></div>' : '')
            + '<details id="modHubHelpLogDetails" class="modhub-help-topic"><summary>本次运行日志：错误 ' + snapshot.analysis.errorCount + ' 条，警告 ' + snapshot.analysis.warnCount + ' 条</summary>'
            + '<p class="grey">这些日志属于本次运行，不能验证尚未重新载入的配置。代码错误或资源缺失需要结合作者说明处理。</p>'
            + cards(logs) + action('加载日志') + '</details>';
    }

    function init() {
        const container = document.getElementById('modHubHelpContainer');
        if (!container) return;
        const mounted = ++viewRevision;
        let snapshot = null;
        let request = 0;
        const notice = MODHUB_AI_NOTICE.split('\n');
        container.innerHTML = '<section id="modHubHelpAi" class="modhub-help-section"></section><div class="modhub-help-footer"><details class="modhub-help-topic modhub-help-notice"><summary>使用声明、数据与撤销范围</summary><dl>'
            + ['发送内容', '密钥保存', '应用修改', '验证与撤销'].map((title, index) => '<dt>' + title + '</dt><dd>' + escape(notice[index]) + '</dd>').join('') + '</dl></details>'
            + '<details id="modHubHelpLocalDetails" class="modhub-help-section modhub-help-topic"><summary>常见问题与配置修复</summary><div class="modhub-help-local-content"><p class="grey">查看排查步骤，检查配置，再预览可以执行的修复。</p>'
            + '<section class="modhub-help-local-group" aria-labelledby="modHubHelpChoiceTitle"><h4 id="modHubHelpChoiceTitle">选择问题</h4><label class="modhub-help-choice" for="modHubHelpSymptom">遇到了什么问题？<select id="modHubHelpSymptom"><option value="">不确定，检查全部</option>'
            + MODHUB_HELP_TOPICS.map((topic, index) => '<option value="' + index + '">' + escape(topic.title) + '</option>').join('') + '</select></label></section>'
            + '<section id="modHubHelpTopic" class="modhub-help-local-group modhub-help-guidance" aria-label="排查步骤"></section><section class="modhub-help-local-group" aria-labelledby="modHubHelpResultsTitle"><div class="modhub-help-local-header"><h4 id="modHubHelpResultsTitle">检查结果</h4><button id="modHubHelpCheck" type="button" class="macro-button modhub-btn-primary">检查并查找可用修复</button></div>'
            + '<div id="modHubHelpStatus" role="status"></div><div id="modHubHelpResults" aria-live="polite"></div></section></div></details>'
            + '<details id="modHubHelpReportDetails" class="modhub-help-section modhub-help-topic"><summary>仍未解决？准备求助信息</summary><p class="grey">报告包含版本、模组清单、检查摘要及日志。请先预览，再自行选择交给作者或已有 AI 工具；不会自动上传。</p>'
            + '<label><input id="modHubHelpAllLogs" type="checkbox">附带全部已捕获日志</label><div class="modhub-help-actions modhub-help-actions-primary">'
            + '<button id="modHubHelpPreview" type="button" class="macro-button modhub-btn-primary">生成并预览求助信息</button>'
            + '<button id="modHubHelpCopy" type="button" class="macro-button modhub-btn-secondary" disabled>复制求助信息</button></div>'
            + '<textarea id="modHubHelpReport" class="modhub-help-report" aria-label="求助信息预览，可选择文本手动复制" readonly placeholder="生成报告后可在此预览和选择文本。"></textarea></details></div>';
        initAi(container.querySelector('#modHubHelpAi'), mounted);
        const results = container.querySelector('#modHubHelpResults');
        const preview = container.querySelector('#modHubHelpReport');
        const allLogs = container.querySelector('#modHubHelpAllLogs');
        const checkButton = container.querySelector('#modHubHelpCheck');
        const previewButton = container.querySelector('#modHubHelpPreview');
        const copyButton = container.querySelector('#modHubHelpCopy');
        const status = container.querySelector('#modHubHelpStatus');
        const symptom = container.querySelector('#modHubHelpSymptom');
        const topicView = container.querySelector('#modHubHelpTopic');
        const current = ticket => mounted === viewRevision && ticket === request && container.isConnected !== false;
        const disable = value => {
            checkButton.disabled = previewButton.disabled = symptom.disabled = value;
            container.querySelectorAll('[data-help-repair], [data-help-images], [data-help-reload]').forEach(button => { button.disabled = value; });
        };
        symptom.onchange = () => {
            const topic = symptom.value === '' ? null : MODHUB_HELP_TOPICS[Number(symptom.value)];
            topicView.innerHTML = topic ? '<h4>排查步骤</h4><details class="modhub-help-topic" open><summary>' + escape(topic.title) + '</summary><ol>'
                + topic.steps.map(step => '<li>' + escape(step) + '</li>').join('') + '</ol><div class="modhub-help-actions">'
                + (Number(symptom.value) === 3 ? '<button type="button" class="macro-button modhub-btn-primary" data-help-images>刷新图像缓存</button>' : '')
                + topic.tabs.map(tab => action(tab)).join('') + (topic.restore ? '<button type="button" class="macro-button modhub-btn-secondary" data-help-restore>时间点还原</button>' : '') + '</div></details>' : '';
        };
        const initial = { analysis: readLogs(), issues: [] };
        logIssues(initial);
        renderResults(results, initial, false);
        const run = async report => {
            const ticket = ++request;
            disable(true);
            copyButton.disabled = true;
            preview.value = '';
            status.textContent = '';
            results.innerHTML = window.modHubLoadingHtml('正在读取配置与安装包声明，请稍候。');
            try {
                const next = await check();
                if (!current(ticket)) return;
                snapshot = next;
                renderResults(results, next, true);
                checkButton.textContent = '重新检查';
                if (report && !next.stale) {
                    container.querySelector('#modHubHelpReportDetails').open = true;
                    preview.value = buildReport(next, { allLogs: allLogs.checked });
                    copyButton.disabled = !preview.value;
                    preview.focus();
                }
            } catch (error) {
                if (current(ticket)) results.textContent = '检查失败：' + detail(error);
            } finally {
                if (current(ticket)) disable(false);
            }
        };
        checkButton.onclick = () => run(false);
        previewButton.onclick = () => run(true);
        copyButton.onclick = () => copyReport(preview.value);
        allLogs.onchange = () => {
            if (snapshot && preview.value) preview.value = buildReport(snapshot, { allLogs: allLogs.checked });
        };
        container.onclick = async event => {
            const topicButton = event.target.closest?.('[data-help-topic]');
            if (topicButton) {
                symptom.value = topicButton.dataset.helpTopic;
                symptom.onchange();
                container.querySelector('#modHubHelpLocalDetails').open = true;
                topicView.scrollIntoView?.({ block: 'start' });
                topicView.querySelector('summary')?.focus();
                return;
            }
            const repairButton = event.target.closest?.('[data-help-repair]');
            if (repairButton) {
                if (repairButton.disabled) return;
                const ticket = ++request;
                disable(true);
                copyButton.disabled = true;
                preview.value = '';
                status.className = 'gold';
                status.innerHTML = window.modHubLoadingHtml('正在核对修复条件，请稍候。');
                const result = await repair(snapshot, repairButton.dataset.helpRepair);
                if (!current(ticket)) return;
                if (result.snapshot) { snapshot = result.snapshot; renderResults(results, snapshot, true); }
                status.className = result.ok ? 'green' : result.status === 'failed' ? 'red' : 'gold';
                status.textContent = result.reason;
                disable(false);
                return;
            }
            if (event.target.closest?.('[data-help-images]')) {
                if (busy() || repairing) { window.modHubShowToast('另一项模组操作尚未完成，请稍后再试。', 'warning'); return; }
                if (!await window.modHubConfirm({ title: '刷新图像缓存', message: '清除可读取的图像缓存并重绘当前已连接的画布，可能短暂重绘。此操作不会补回缺失的图片资源，也不会修改图包配置。', confirmText: '刷新缓存', cancelText: '取消' })) return;
                if (busy() || repairing) { window.modHubShowToast('模组状态已变化，请稍后再试。', 'warning'); return; }
                try {
                    const refreshed = window.modHubRefreshBeautyImages?.();
                    status.className = refreshed ? 'gold' : 'red';
                    status.textContent = refreshed ? '图像缓存已刷新。请检查图片是否恢复显示；如仍异常，请核对图像包和覆盖顺序。' : '图像缓存或画布未能完整刷新。请核对图像包，保存游戏进度后重新载入。';
                } catch (error) { status.className = 'red'; status.textContent = '刷新未完成：' + detail(error); }
                return;
            }
            if (event.target.closest?.('[data-help-reload]')) {
                await window.modHubOfferReload?.('请先保存游戏进度，再重新载入以验证已保存配置。');
                return;
            }
            const restore = event.target.closest?.('[data-help-restore]');
            if (restore) {
                if (window.modHubRestore?.showHistory) Promise.resolve().then(() => window.modHubRestore.showHistory())
                    .catch(error => window.modHubAlert(detail(error), '无法打开时间点还原'));
                else window.modHubShowToast('时间点还原尚未就绪，请稍后再试。', 'warning');
                return;
            }
            const button = event.target.closest?.('[data-help-tab]');
            if (button && !window.modHubOpenManager(button.dataset.helpTab, { logSearch: button.dataset.helpQuery || '' })) {
                window.modHubShowToast('当前无法打开对应页面，请使用顶部页签。', 'warning');
            }
        };
    }

    window.modHubHelp = { init, openProblem, suggestQuestions, check, buildRepairPlan, repair, buildReport, copyReport };
})();
