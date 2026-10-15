/** ModHub 兼容性检查：读取声明、关联证据，不执行补丁或修改配置。 */
(function() {
    'use strict';

    const api = window.modHubCompatibility || (window.modHubCompatibility = {});
    const records = new WeakMap();
    const MODHUB_COMPAT_RULE_LIMIT = 20000;
    const parseJson5 = window.modHubParseJson5;
    const namesOf = boot => [boot?.name, ...(Array.isArray(boot?.alias) ? boot.alias : [])].filter(name => typeof name === 'string' && name.length);
    const reason = error => String(error?.message || error || '未提供具体原因');
    const stamp = value => JSON.stringify(value);
    const listStamp = lists => stamp([lists?.ok, lists?.enabled, lists?.disabled]);
    const bootStamp = boot => stamp(boot || null);
    const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('已取消兼容性检查'), { name: 'AbortError' }); };
    const busy = () => Boolean(window.modHubIsReloadBusy?.() || window._modHubManagerBusy || window._modHubModLoading);
    const yieldToBrowser = async signal => { cancelled(signal); await window.modHubYieldToBrowser?.(); cancelled(signal); };

    async function hashPackage(data) {
        if (typeof window.modHubMarket?.getPackageDigest !== 'function') return window.modHubAiPackage.hash(data);
        const digest = await window.modHubMarket.getPackageDigest(data);
        if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('当前浏览器未提供可靠的 SHA-256 包体校验能力');
        return digest.slice(7).toLowerCase();
    }

    function addFinding(snapshot, value) {
        const finding = { status: 'review', kind: 'configuration', mods: [], logs: [], ...value };
        if (!snapshot.compatibility.findings.some(item => item.id === finding.id)) snapshot.compatibility.findings.push(finding);
        if (!snapshot.issues.some(item => item.id === finding.id)) snapshot.issues.push({ ...finding, tab: '模组说明', query: finding.mods[0] || '' });
    }

    function uncovered(snapshot, modName, field, message) {
        const entry = { modName, field, reason: message };
        if (!snapshot.compatibility.coverage.some(item => stamp(item) === stamp(entry))) snapshot.compatibility.coverage.push(entry);
    }

    function activeProfiles(snapshot) {
        return window.modHubHelp.getDependencyContext(snapshot).active;
    }

    function declarationChecks(snapshot) {
        const { active, providers, complete } = window.modHubHelp.getDependencyContext(snapshot);
        const edges = new Map(active.map(item => [item.name, []]));
        const utils = window.modHubGetGui?.()?.gModUtils || window.modUtils;
        const registry = utils?.getAddonPluginManager?.();
        for (const item of active) {
            const dependencies = Array.isArray(item.bootJson.dependenceInfo) ? item.bootJson.dependenceInfo : [];
            for (const [index, dependency] of dependencies.entries()) {
                const matches = providers.get(dependency?.modName) || [];
                if (complete && matches.length) edges.get(item.name).push({ name: matches[matches.length - 1].name, field: 'dependenceInfo[' + index + ']' });
            }
            const addons = item.bootJson.addonPlugin;
            if (addons !== undefined && !Array.isArray(addons)) {
                uncovered(snapshot, item.name, 'addonPlugin', '插件声明不是列表，无法完整核对。');
                continue;
            }
            for (const [index, addon] of (addons || []).entries()) {
                const field = 'addonPlugin[' + index + ']';
                if (!addon || typeof addon.modName !== 'string' || !addon.modName.trim() || typeof addon.addonName !== 'string' || !addon.addonName.trim()) {
                    uncovered(snapshot, item.name, field, '插件声明缺少有效的提供者或插件名称。');
                    continue;
                }
                const matches = providers.get(addon.modName) || [];
                const prefix = 'compat-addon-' + item.name + '-' + index;
                const evidence = '【' + item.name + '】的 ' + field + ' 要求【' + addon.modName + '】提供插件【' + addon.addonName + '】' + (addon.modVersion ? '，版本 ' + addon.modVersion : '') + '。';
                if (typeof addon.modVersion === 'string' && addon.modVersion.trim() && addon.modVersion.trim() !== '*') {
                    uncovered(snapshot, item.name, field, '加载器未提供插件接口版本，尚不能核对声明要求【' + addon.modName + ' / ' + addon.addonName + '】' + addon.modVersion + '。');
                }
                if (!matches.length) {
                    addFinding(snapshot, { id: prefix, status: complete ? 'problem' : 'review', title: complete ? '缺少已启用的插件提供者' : '插件提供者尚不能确认',
                        evidence, advice: '请核对提供者的安装、启用状态及作者声明。', mods: [item.name, addon.modName] });
                    continue;
                }
                const runtimeItem = snapshot.runtime?.find(run => run.name === item.name);
                const corresponds = !snapshot.compatibility.projected && !snapshot.different && runtimeItem
                    && bootStamp(runtimeItem.bootJson) === bootStamp(item.bootJson) && matches.every(profile => {
                        const runtimeProvider = snapshot.runtime?.find(run => run.name === profile.name);
                        return runtimeProvider && bootStamp(runtimeProvider.bootJson) === bootStamp(profile.bootJson);
                    });
                if (!corresponds || typeof registry?.getAddonPlugin !== 'function') {
                    uncovered(snapshot, item.name, field, '插件注册状态需重新载入游戏后确认。');
                } else {
                    try {
                        if (!registry.getAddonPlugin(addon.modName, addon.addonName)) addFinding(snapshot, { id: prefix + '-registration', status: 'review', kind: 'runtime',
                            title: '本次运行未查到所需插件注册', evidence: evidence + '当前注册表未返回该精确名称组合。',
                            advice: '请查看提供者的启动日志。调整配置后，请重新载入游戏并再次检查。', mods: [item.name, ...matches.map(profile => profile.name)] });
                    } catch (error) { uncovered(snapshot, item.name, field, '读取插件注册表失败：' + reason(error)); }
                }
            }
        }
        const colors = new Map(), path = [], seen = new Set();
        function visit(name) {
            colors.set(name, 1); path.push(name);
            for (const edge of edges.get(name) || []) {
                if (colors.get(edge.name) === 1) {
                    const cycle = [...path.slice(path.indexOf(edge.name)), edge.name];
                    const id = cycle.slice(0, -1).sort().join('\u0000');
                    if (!seen.has(id)) {
                        seen.add(id);
                        const sources = cycle.slice(0, -1).map((from, index) => '【' + from + '】' + edges.get(from).find(item => item.name === cycle[index + 1]).field);
                        addFinding(snapshot, { id: 'compat-cycle-' + id, status: 'problem', title: '声明中存在循环依赖', mods: cycle.slice(0, -1),
                            evidence: cycle.join(' → ') + '。来源：' + sources.join('；') + '。', advice: '这些顺序要求不能同时满足，请核对作者声明；智能排序不能消除循环。' });
                    }
                } else if (!colors.has(edge.name)) visit(edge.name);
            }
            path.pop(); colors.set(name, 2);
        }
        for (const item of active) if (!colors.has(item.name)) visit(item.name);
    }

    function catalogDependencyChecks(snapshot) {
        const read = window.modHubMarket?.getCatalogRequiredDependencies;
        if (typeof read !== 'function') return [];
        const { active, providers, complete } = window.modHubHelp.getDependencyContext(snapshot);
        const order = new Map(active.map((item, index) => [item.name, index]));
        const declarations = [];
        for (const item of active) {
            const requirements = read(item.bootJson);
            declarations.push({ bootJson: item.bootJson, signature: stamp(requirements) });
            for (const requirement of requirements) {
                const target = requirement.modName, matches = providers.get(target) || [];
                if ((item.bootJson.dependenceInfo || []).some?.(dependency => dependency.modName === target
                    && (requirement.version === '*' || dependency.version === requirement.version))) continue;
                const evidence = '【' + item.name + '】的' + (requirement.source || '目录声明') + '要求【' + target + '】'
                    + (requirement.version && requirement.version !== '*' ? ' ' + requirement.version : '') + '。'
                    + (requirement.evidence ? '原文：' + requirement.evidence : '');
                const finding = { id: 'compat-catalog-' + item.name + '-' + target + '-' + requirement.version,
                    evidence, mods: [item.name, target], advice: '请安装并启用作者要求的前置，再重新检查。' };
                if (!matches.length) {
                    const disabled = snapshot.packages.some(profile => !profile.enabled && namesOf(profile.bootJson).includes(target));
                    addFinding(snapshot, { ...finding, status: disabled || complete ? 'problem' : 'review',
                        title: disabled ? '作者要求的前置未启用' : complete ? '缺少作者要求的前置' : '作者要求的前置尚未确认' });
                } else if (!complete) {
                    addFinding(snapshot, { ...finding, status: 'review', title: '作者要求的前置尚未确认', advice: '请先处理未能读取的包体资料，再重新检查。' });
                } else {
                    const provider = matches[matches.length - 1];
                    if (provider.name !== item.name && order.get(provider.name) >= order.get(item.name)) addFinding(snapshot, { ...finding, id: finding.id + '-order', status: 'problem',
                        title: '作者要求的前置加载顺序需要调整', advice: '请将【' + provider.name + '】移至【' + item.name + '】之前，再重新检查。' });
                    if (requirement.version && requirement.version !== '*') {
                        const checked = window.modHubMarketVersions?.assessVersionRange?.(provider.bootJson.version, requirement.version);
                        if (checked?.status !== 'compatible') addFinding(snapshot, { ...finding,
                            status: checked?.status === 'incompatible' ? 'problem' : 'review',
                            title: checked?.status === 'incompatible' ? '前置版本不满足作者说明' : '作者说明中的版本要求尚未确认',
                            evidence: evidence + '当前版本：' + (provider.bootJson.version || '未识别') + '。' + (checked?.reason || '') });
                    }
                }
            }
        }
        return declarations;
    }

    async function packageRecord(name, cache, signal) {
        cancelled(signal);
        if (cache.has(name)) return cache.get(name);
        let result;
        try { result = { ...await window.modHubReadInstalledModPackage(name) }; }
        catch (error) { result = { name, error }; }
        cancelled(signal);
        if (result.data != null) {
            try { result.hash = await hashPackage(result.data); }
            catch (error) { result.hashError = reason(error); }
        }
        cache.set(name, result);
        return result;
    }

    async function targetChecks(snapshot, options, cache) {
        const targets = [];
        let examined = 0;
        const takeRule = () => {
            if (examined < MODHUB_COMPAT_RULE_LIMIT) { examined++; return true; }
            uncovered(snapshot, '检查范围', '规则数量', '已达到本次 20000 条补丁规则的检查上限，后续规则尚未核对。');
            return false;
        };
        const candidates = options.candidates || new Map();
        const add = (item, type, target, engine, field, rule) => targets.push({ modName: item.name, type, target, engine, field,
            find: typeof rule.findString === 'string' ? '字符串：' + rule.findString : typeof rule.findRegex === 'string' ? '正则声明：' + rule.findRegex
                + (rule.regexFlag ? ' /' + rule.regexFlag : '') : '字符串：' + rule.from,
            replacement: typeof rule.replaceFile === 'string' ? '文件：' + rule.replaceFile : '内联替换' });
        for (const item of activeProfiles(snapshot)) {
            if (examined >= MODHUB_COMPAT_RULE_LIMIT) { takeRule(); break; }
            cancelled(options.signal);
            options.onProgress?.('正在核对【' + item.name + '】的补丁声明');
            const boot = item.bootJson;
            if (!boot) continue;
            let archive;
            const readFile = async (path, field) => {
                if (typeof path !== 'string' || !path.length || path.startsWith('/') || /[\\:\u0000-\u001f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
                    throw new Error(field + ' 中的声明路径无效');
                }
                if (!archive) {
                    const installed = candidates.get(item.name) || await packageRecord(item.name, cache, options.signal);
                    if (!installed?.data) throw new Error(installed?.missing ? '安装包不存在' : reason(installed?.error || '当前来源未提供原始包体'));
                    archive = await window.modHubAiPackage.read(installed.data);
                }
                cancelled(options.signal);
                if (typeof parseJson5 !== 'function') throw new Error('本地 JSON5 解析器尚未就绪');
                const content = await archive.sourceText(path);
                await yieldToBrowser(options.signal);
                return parseJson5(content);
            };
            const tweeRules = (rules, field) => {
                if (!Array.isArray(rules)) throw new Error(field + ' 不是补丁参数列表');
                for (const [index, rule] of rules.entries()) {
                    if (!takeRule()) break;
                    const position = field + '[' + index + ']';
                    if (!rule || typeof rule.passage !== 'string' || !rule.passage.length
                        || (typeof rule.findString !== 'string' && typeof rule.findRegex !== 'string')
                        || (typeof rule.replace !== 'string' && typeof rule.replaceFile !== 'string')) {
                        uncovered(snapshot, item.name, position, 'TweeReplacer 规则缺少有效目标、查找方式或替换来源。');
                        continue;
                    }
                    add(item, 'passage', rule.passage, 'TweeReplacer', position, rule);
                }
            };
            const replaceRules = (info, field, engine) => {
                if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error(field + ' 不是补丁规则对象');
                for (const type of ['js', 'css', 'twee']) {
                    if (info[type] === undefined) continue;
                    if (!Array.isArray(info[type])) { uncovered(snapshot, item.name, field + '.' + type, '规则集合不是列表。'); continue; }
                    for (const [index, rule] of info[type].entries()) {
                        if (!takeRule()) break;
                        const position = field + '.' + type + '[' + index + ']';
                        const target = type === 'twee' ? rule?.passageName : rule?.fileName;
                        if (typeof target !== 'string' || !target.length || typeof rule?.from !== 'string' || typeof rule?.to !== 'string') {
                            uncovered(snapshot, item.name, position, 'ReplacePatch 规则缺少有效目标或字符串替换声明。');
                            continue;
                        }
                        add(item, type === 'twee' ? 'passage' : type, target, engine, position, rule);
                    }
                }
            };
            if (boot.replacePatchList !== undefined) {
                if (!Array.isArray(boot.replacePatchList)) uncovered(snapshot, item.name, 'replacePatchList', '外置补丁清单不是列表。');
                else for (const [index, path] of boot.replacePatchList.entries()) {
                    try { replaceRules(await readFile(path, 'replacePatchList[' + index + ']'), String(path), '原生 ReplacePatch'); }
                    catch (error) { if (error.name === 'AbortError') throw error; uncovered(snapshot, item.name, 'replacePatchList[' + index + ']', reason(error)); }
                }
            }
            const seen = new Set();
            for (const [index, addon] of (Array.isArray(boot.addonPlugin) ? boot.addonPlugin : []).entries()) {
                const field = 'addonPlugin[' + index + ']';
                const id = stamp([addon?.modName, addon?.addonName]);
                if (seen.has(id)) { uncovered(snapshot, item.name, field, '同一插件重复声明，仅核对首项，不推测其余声明的执行情况。'); continue; }
                seen.add(id);
                try {
                    if (addon?.modName === 'TweeReplacer' && addon.addonName === 'TweeReplacerAddon') {
                        tweeRules(addon.params, field + '.params');
                        if (addon.paramsFiles !== undefined) {
                            if (!Array.isArray(addon.paramsFiles) || addon.paramsFiles.some(path => typeof path !== 'string')) throw new Error(field + '.paramsFiles 不是有效路径列表');
                            for (const path of addon.paramsFiles) {
                                try { tweeRules(await readFile(path, field + '.paramsFiles'), String(path)); }
                                catch (error) { if (error.name === 'AbortError') throw error; uncovered(snapshot, item.name, field + '.paramsFiles', String(path) + '：' + reason(error)); }
                            }
                        }
                    } else if (addon?.modName === 'ReplacePatcher' && addon.addonName === 'ReplacePatcherAddon') replaceRules(addon.params, field + '.params', 'ReplacePatcherAddon');
                    else uncovered(snapshot, item.name, field, '未分析此插件对游戏内容的修改；提供者与版本仍按可读声明核对。');
                } catch (error) { if (error.name === 'AbortError') throw error; uncovered(snapshot, item.name, field, reason(error)); }
            }
            await yieldToBrowser(options.signal);
        }
        snapshot.compatibility.targets = targets;
        const groups = new Map();
        for (const target of targets) {
            const id = stamp([target.type, target.target]);
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(target);
        }
        for (const [id, rules] of groups) {
            const mods = [...new Set(rules.map(item => item.modName))];
            if (mods.length < 2) continue;
            const target = rules[0];
            const logs = (snapshot.analysis?.lines || []).filter(line => ['error', 'warn'].includes(line.level)
                && (line.mods || []).some(name => mods.includes(name))
                && ((line.files || []).includes(target.target) || ['[' + target.target + ']', '【' + target.target + '】', '"' + target.target + '"', "'" + target.target + "'"].some(token => line.message?.includes(token))));
            addFinding(snapshot, { id: 'compat-overlap-' + id, kind: 'overlap', status: 'review', title: '多个模组声明修改同一目标', mods,
                target: { type: target.type, name: target.target }, rules, logs,
                evidence: mods.map(name => '【' + name + '】').join('、') + ' 均声明修改 ' + (target.type === 'passage' ? 'Passage' : target.type.toUpperCase()) + '【' + target.target + '】。'
                    + (logs.length ? '本次运行有 ' + logs.length + ' 条相关错误或警告。' : ''),
                advice: '请查看作者说明中的兼容设置；如果游戏出现异常，再逐项排查。' });
        }
        uncovered(snapshot, '检查范围', '动态行为', '动态脚本修改和补丁执行效果需在游戏中确认。');
    }

    function signature(snapshot) {
        const result = snapshot?.compatibility;
        if (!result) return '';
        return stamp([result.findings.map(({ id, status, kind, evidence }) => [id, status, kind, evidence]).sort((a, b) => a[0].localeCompare(b[0])),
            result.coverage.map(item => [item.modName, item.field, item.reason]).sort((a, b) => stamp(a).localeCompare(stamp(b)))]);
    }

    async function assertCurrent(snapshot, { ignoreNames = [], expectedPackages = [], expectedLists, allowBusy = false, signal } = {}) {
        cancelled(signal);
        const record = records.get(snapshot);
        if (!record || snapshot.stale) throw new Error('兼容性检查结果已过期，请重新检查。');
        if (!allowBusy && busy()) throw new Error('另一项模组操作尚未完成，请等待完成后重新检查。');
        const ignored = new Set(ignoreNames);
        if (ignored.size && !expectedLists) throw new Error('已处理项目必须同时核对明确的启禁状态和加载顺序，请重新生成安装计划。');
        const current = await window.modHubReadIndexDBModLists();
        cancelled(signal);
        const expected = expectedLists ? { ok: true, ...expectedLists } : record.lists;
        if (listStamp(current) !== listStamp(expected) || (!ignored.size && record.revision !== window._modHubReloadRevision)) throw new Error('启禁配置或加载顺序已改变，请重新核对兼容性。');
        for (const fingerprint of record.fingerprints) {
            if (ignored.has(fingerprint.name)) continue;
            const installed = await window.modHubReadInstalledModPackage(fingerprint.name);
            cancelled(signal);
            if (bootStamp(installed.bootJson) !== fingerprint.boot || Boolean(installed.missing) !== fingerprint.missing
                || Boolean(installed.error) !== fingerprint.error || (fingerprint.hash && await hashPackage(installed.data) !== fingerprint.hash)) {
                throw new Error('模组【' + fingerprint.name + '】的包体或声明已改变，请重新核对兼容性。');
            }
            await yieldToBrowser(signal);
        }
        for (const expected of expectedPackages) {
            const installed = await window.modHubReadInstalledModPackage(expected.name);
            if (!expected.hash || !installed.data || await hashPackage(installed.data) !== expected.hash) throw new Error('本批已处理的模组【' + expected.name + '】包体已改变，请重新核对安装计划。');
            cancelled(signal);
        }
        for (const candidate of record.candidates) {
            if (candidate.hash && await hashPackage(candidate.data) !== candidate.hash) throw new Error('待安装包【' + candidate.name + '】已改变，请重新核对兼容性。');
            cancelled(signal);
        }
        for (const entry of record.catalogDeclarations || []) {
            if (stamp(window.modHubMarket?.getCatalogRequiredDependencies?.(entry.bootJson) || []) !== entry.signature) {
                throw new Error('目录中的前置说明已改变，请重新核对兼容性。');
            }
        }
        const after = await window.modHubReadIndexDBModLists();
        if (listStamp(after) !== listStamp(current)) throw new Error('核对期间启禁配置已改变，请重新检查。');
        return true;
    }

    async function enrich(snapshot, options = {}) {
        cancelled(options.signal);
        const projected = Boolean(options.projected);
        const originalLists = options.baselineLists || snapshot.lists;
        snapshot.compatibility = { findings: [], coverage: [], targets: [], fingerprints: [], projected,
            baselineLists: { ...originalLists, enabled: [...(originalLists?.enabled || [])], disabled: [...(originalLists?.disabled || [])] } };
        snapshot.issues = (snapshot.issues || []).filter(issue => !issue.id.startsWith('compat-'));
        for (const issue of snapshot.issues) {
            const runtime = issue.id.startsWith('log-');
            snapshot.compatibility.findings.push({ ...issue, kind: runtime ? 'runtime' : 'configuration', mods: [],
                logs: runtime ? (snapshot.analysis?.lines || []).filter(line => line.issueIds?.includes(issue.id.slice(4))) : [] });
        }
        const cache = options.cache || new Map();
        const baselinePackages = options.baselinePackages || snapshot.packages || [];
        const fingerprints = [];
        for (const item of baselinePackages) {
            options.onProgress?.('正在读取【' + item.name + '】的包体身份');
            const installed = await packageRecord(item.name, cache, options.signal);
            fingerprints.push({ name: item.name, hash: installed.hash || '', boot: bootStamp(installed.bootJson), missing: Boolean(installed.missing), error: Boolean(installed.error) });
            if (installed.hashError) uncovered(snapshot, item.name, '包体身份', installed.hashError);
            if (bootStamp(installed.bootJson) !== bootStamp(item.bootJson) || Boolean(installed.missing) !== Boolean(item.missing)) snapshot.stale = true;
            await yieldToBrowser(options.signal);
        }
        snapshot.compatibility.fingerprints = fingerprints.map(({ name, hash }) => ({ name, hash }));
        if (!snapshot.lists?.ok) uncovered(snapshot, '已保存配置', '启禁列表', '启禁列表未能完整读取。');
        if (!snapshot.builtinKnown) uncovered(snapshot, '本次运行', '内置模组', '内置模组或其来源未能完整核对。');
        declarationChecks(snapshot);
        const catalogDeclarations = catalogDependencyChecks(snapshot);
        await targetChecks(snapshot, options, cache);
        const candidates = [];
        for (const item of (options.candidates || new Map()).values()) if (item.data != null) {
            try { candidates.push({ name: item.name, data: item.data, hash: await hashPackage(item.data) }); }
            catch (error) { uncovered(snapshot, item.name, '待安装包体身份', reason(error)); }
        }
        records.set(snapshot, { lists: options.baselineLists || { ...snapshot.lists, enabled: [...snapshot.lists.enabled], disabled: [...snapshot.lists.disabled] }, fingerprints,
            candidates, catalogDeclarations, revision: window._modHubReloadRevision });
        if (!options.skipAssert && snapshot.lists?.ok && !snapshot.stale) {
            try { await assertCurrent(snapshot, options); }
            catch (error) { if (error.name === 'AbortError') throw error; snapshot.stale = true; uncovered(snapshot, '检查结果', '环境变化', reason(error)); }
        }
        cancelled(options.signal);
        return snapshot;
    }

    async function check(options = {}) {
        cancelled(options.signal);
        if (typeof window.modHubHelp?.check !== 'function') throw new Error('本地环境检查尚未就绪，请重新载入后重试。');
        const snapshot = await window.modHubHelp.check({ ...options, compatibility: false });
        cancelled(options.signal);
        const candidates = options.candidates || [];
        if (!candidates.length && !options.enabledNames && !options.disabledNames) return enrich(snapshot, options);
        const cache = new Map();
        const baselinePackages = snapshot.packages;
        const baselineLists = { ...snapshot.lists, enabled: [...snapshot.lists.enabled], disabled: [...snapshot.lists.disabled] };
        await enrich(snapshot, { ...options, candidates: new Map(), cache, skipAssert: true });
        const baselineSignature = signature(snapshot);
        const candidateMap = new Map();
        for (const candidate of candidates) {
            if (!candidate || typeof candidate.name !== 'string' || candidate.name !== candidate.bootJson?.name || candidateMap.has(candidate.name)) throw new Error('待检查安装包的技术名无效或重复，请重新生成安装计划。');
            candidateMap.set(candidate.name, candidate);
        }
        const enabled = [...(options.enabledNames || snapshot.lists.enabled)];
        const disabled = [...(options.disabledNames || snapshot.lists.disabled)];
        for (const candidate of candidates) {
            if (!enabled.includes(candidate.name) && !disabled.includes(candidate.name)) (candidate.enabled === false ? disabled : enabled).push(candidate.name);
        }
        if ([...enabled, ...disabled].some(name => typeof name !== 'string' || !name.length) || new Set([...enabled, ...disabled]).size !== enabled.length + disabled.length) throw new Error('拟安装组合的启禁列表无效或重复。');
        snapshot.lists = { ...snapshot.lists, enabled, disabled };
        const profiles = new Map(snapshot.packages.map(item => [item.name, item]));
        for (const candidate of candidates) profiles.set(candidate.name, candidate);
        snapshot.packages = [...profiles.values()].map(item => ({ ...item, enabled: enabled.includes(item.name) }));
        snapshot.issues = snapshot.issues.filter(issue => issue.id.startsWith('log-') || ['read-failed', 'runtime-unknown', 'comparison-unknown'].includes(issue.id));
        window.modHubHelp.checkDeclarations(snapshot, { builtins: snapshot.builtins || [], builtinKnown: snapshot.builtinKnown });
        await enrich(snapshot, { ...options, candidates: candidateMap, projected: true, cache, baselineLists, baselinePackages });
        snapshot.compatibility.baselineSignature = baselineSignature;
        return snapshot;
    }

    Object.assign(api, { check, enrich, signature, assertCurrent, hashPackage });
})();
