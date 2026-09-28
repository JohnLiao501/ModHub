// ModHub 安装计划、批量安装与来源状态。
const {
    assert, fs, path, vm, srcRoot,
    bootJson, createStubElement, loadScripts, loadManager, loadMarket,
    createMockController,
} = require('./helpers');

module.exports = async function() {
    /* =========================================================================
     * 17. 批量计划与队列：使用真实公开接口验证依赖、版本与执行结果
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const makeMod = (id, dependencies = [], version = '1.0.0') => ({
            id, identityId: id, name: id, dependencies, version,
            githubUrl: `https://github.com/ModHubTests/${id}`
        });
        const key = mod => market.getMarketModKey(mod);
        const shared = makeMod('SharedFixture');
        const middle = makeMod('MiddleFixture', [{ id: shared.id }]);
        const alpha = makeMod('AlphaFixture', [{ id: middle.id }]);
        const beta = makeMod('BetaFixture', [{ id: shared.id }]);
        const independent = makeMod('IndependentFixture');
        const catalog = [alpha, beta, middle, shared, independent];
        const build = (targets, mods = catalog, profiles = [], disabled = new Set(), skipped = new Set(), releases = new Map(), excluded = new Map()) =>
            market.buildBatchInstallPlan(targets, mods, profiles, disabled, skipped, releases, excluded);
        const plainKeys = plan => Array.from(plan.actions, action => action.key);
        const plan = build([alpha, beta, independent]);
        assert.deepEqual(plainKeys(plan), [shared, middle, alpha, beta, independent].map(key), '共享前置只安装一次，递归前置必须先于使用它的目标');
        assert.equal(plan.blocked.size, 0, '完整依赖链不得被阻断');
        assert.ok(plan.dependencies.get(key(alpha)).has(key(middle)), '计划保留直接依赖边用于失败传播');
        assert.deepEqual(Array.from(plan.requirements.find(req => req.key === key(shared)).requiredBy).sort(), [alpha.name, beta.name].sort(), '共享前置说明必须列出全部受影响目标');

        const targetAndDependency = build([alpha, shared, shared], catalog, [], new Set(), new Set([key(shared)]));
        assert.equal(targetAndDependency.targets.length, 2, '重复目标按稳定身份合并');
        assert.equal(targetAndDependency.actions.filter(action => action.key === key(shared)).length, 1, '所选目标同时作为前置时只处理一次');
        assert.equal(targetAndDependency.requirements.find(req => req.key === key(shared)).skipped, false, '顶层目标不能通过取消前置间接跳过');

        const skippedPlan = build([alpha, beta], catalog, [], new Set(), new Set([key(shared)]));
        assert.deepEqual(plainKeys(skippedPlan), [middle, alpha, beta].map(key), '显式取消共享前置后仍保留使用它的目标');
        assert.ok(!skippedPlan.dependencies.get(key(middle)).has(key(shared)), '显式取消前置不得留下会传播执行失败的依赖边');
        assert.equal(skippedPlan.blocked.size, 0, '显式取消前置代表玩家自行处理');

        const incompatibleShared = makeMod('VersionFixture', [], '2.0.0');
        const oldConsumer = makeMod('OldConsumerFixture', [{ id: incompatibleShared.id, version: '^1.0.0' }]);
        const newConsumer = makeMod('NewConsumerFixture', [{ id: incompatibleShared.id, version: '^2.0.0' }]);
        const versionCatalog = [oldConsumer, newConsumer, incompatibleShared, independent];
        const versionPlan = build([oldConsumer, newConsumer, independent], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.ok(versionPlan.blocked.has(key(oldConsumer)) && versionPlan.blocked.has(key(newConsumer)), '共享前置的最终版本不能满足全部要求时，整组受影响目标必须跳过');
        assert.deepEqual(plainKeys(versionPlan), [key(independent)], '版本冲突不能阻止独立目标');
        assert.ok(versionPlan.allActions.some(action => action.key === key(newConsumer)), '版本冲突分支仍须预读实际发布信息，不能只凭市场摘要阻断');
        const structurallyBroken = makeMod('BrokenVersionFixture', [{ id: incompatibleShared.id, version: '^2.0.0' }, { id: 'MissingVersionDependency' }]);
        const viableVersionPlan = build([structurallyBroken, oldConsumer], [structurallyBroken, oldConsumer, incompatibleShared], [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.equal(viableVersionPlan.blocked.size, 1, '缺失前置的分支不得推动共享框架升级并连带阻断其他目标');
        assert.ok(viableVersionPlan.blocked.has(key(structurallyBroken)), '结构缺失分支仍需准确报告不可执行');
        assert.deepEqual(plainKeys(viableVersionPlan), [key(oldConsumer)], '独立目标应复用已满足的本地框架版本继续安装');
        const singleVersionPlan = build([newConsumer], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }]);
        assert.equal(singleVersionPlan.actions[0].type, 'update', '本地版本不满足而新发布版本满足时必须更新前置');
        const actualVersionPlan = build([newConsumer], versionCatalog, [], new Set(), new Set(), new Map([[key(incompatibleShared), { version: '1.5.0' }]]));
        assert.ok(actualVersionPlan.blocked.has(key(newConsumer)), '版本校验必须采用实际选择的发布版本');

        const missing = makeMod('MissingConsumerFixture', [{ id: 'AbsentFixture' }]);
        const unavailable = { ...makeMod('ExternalFixture'), githubUrl: '', otherUrl: 'https://example.com/download' };
        const externalConsumer = makeMod('ExternalConsumerFixture', [{ id: unavailable.id }]);
        const cycleA = makeMod('CycleAlphaFixture', [{ id: 'CycleBetaFixture' }]);
        const cycleB = makeMod('CycleBetaFixture', [{ id: cycleA.id }]);
        const brokenPlan = build([missing, externalConsumer, cycleA, independent], [missing, unavailable, externalConsumer, cycleA, cycleB, independent]);
        assert.equal(brokenPlan.blocked.size, 3, '缺失、外部下载和循环依赖只阻断对应目标');
        assert.equal(brokenPlan.cycles.length, 2, '循环依赖报告必须包含循环上的各项');
        assert.deepEqual(plainKeys(brokenPlan), [key(independent)], '不可执行分支不得残留多余安装任务');
        const excludedPlan = build([alpha, beta, independent], catalog, [], new Set(), new Set(), new Map(), new Map([[key(shared), '已取消选择发布包']]));
        assert.equal(excludedPlan.blocked.size, 2, '取消共享前置选包必须跳过全部下游');

        const attempted = [];
        const executed = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {},
            confirm: async () => true,
            install: async action => { attempted.push(action.key); return action.key !== key(shared); }
        });
        assert.deepEqual(attempted, [key(shared), key(independent)], '前置失败必须阻断所有下游，同时继续独立分支');
        assert.equal(executed.results.get(key(shared)).status, 'failed', '实际失败必须记为失败');
        for (const mod of [middle, alpha, beta]) assert.equal(executed.results.get(key(mod)).status, 'skipped', '前置失败的后续模组必须记为跳过');
        assert.equal(executed.results.get(key(independent)).status, 'success', '独立项目必须成功完成');
        assert.deepEqual(Array.from(executed.changedMods), [independent.name], '只有成功产生的配置变更计入重载集合');

        const explicitSkipResult = await market.executeBatchInstallPlan(skippedPlan, { refresh: async () => {}, install: async () => true });
        assert.ok([alpha, beta].every(mod => explicitSkipResult.results.get(key(mod)).status === 'success'), '显式取消前置不会作为失败阻断目标');
        const duplicateCalls = [];
        await market.executeBatchInstallPlan(targetAndDependency, { refresh: async () => {}, install: async action => { duplicateCalls.push(action.key); return true; } });
        assert.equal(duplicateCalls.filter(value => value === key(shared)).length, 1, '目标兼前置在执行队列中只能导入一次');

        let stopped = false;
        const stopCalls = [];
        const stopResult = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {}, shouldStop: () => stopped,
            install: async action => { stopCalls.push(action.key); stopped = true; return true; }
        });
        assert.deepEqual(stopCalls, [key(shared)], '停止后续应保留当前安装成功并停止剩余队列');
        assert.equal(stopResult.results.get(key(shared)).status, 'success', '停止不撤销当前已完成安装');
        assert.ok([alpha, beta, independent].every(mod => stopResult.results.get(key(mod)).status === 'skipped'), '停止后的目标统一标记跳过');

        let refreshes = 0;
        let conflictInstalls = 0;
        const denied = await market.executeBatchInstallPlan(plan, {
            refresh: async () => { refreshes++; },
            confirm: async () => false,
            install: async () => { conflictInstalls++; return true; }
        });
        assert.equal(refreshes, 1, '执行前必须重新读取状态再进行冲突确认');
        assert.equal(conflictInstalls, 0, '取消冲突风险确认不得开始安装');
        assert.ok(Array.from(denied.results.values()).every(result => result.status === 'skipped'), '取消风险确认后剩余队列全部跳过');

        const enablePlan = build([beta], catalog, [{ name: shared.name, version: '1.0.0' }], new Set([shared.name]));
        assert.equal(enablePlan.actions[0].type, 'enable', '已安装但禁用的前置必须加入启用操作');
        sb._modHubModState = { sideMods: [{ name: shared.name, enabled: false }], sideDisabled: [shared.name] };
        const failedEnable = await market.executeBatchInstallPlan(enablePlan, { refresh: async () => {}, enable: async () => false, install: async () => true });
        assert.equal(failedEnable.results.get(key(shared)).status, 'failed', '启用返回 false 且仍禁用时不能假报成功');
        assert.equal(failedEnable.results.get(key(beta)).status, 'skipped', '前置启用失败必须阻断目标');
        const unverifiedEnable = await market.executeBatchInstallPlan(enablePlan, { refresh: async () => {}, enable: async () => true, install: async () => true });
        assert.equal(unverifiedEnable.results.get(key(shared)).status, 'failed', '启用接口返回 true 但实际仍禁用时也不能假报成功');
        assert.equal(unverifiedEnable.results.get(key(beta)).status, 'skipped', '实际启用状态未确认前不能继续下游');
        const alreadyEnabled = await market.executeBatchInstallPlan(enablePlan, {
            refresh: async () => {}, install: async () => true,
            enable: async () => { sb._modHubModState.sideMods[0].enabled = true; return false; }
        });
        assert.equal(alreadyEnabled.results.get(key(shared)).status, 'success', '接口返回 false 但实际已启用时不得误判前置失败');
        assert.equal(alreadyEnabled.results.get(key(beta)).status, 'success', '已核实前置启用后才能继续下游');
        assert.ok(!alreadyEnabled.changedMods.has(shared.name), '本次未执行的启用变更不能重复计数');

        const disabledUpdatePlan = build([newConsumer], versionCatalog, [{ name: incompatibleShared.name, version: '1.0.0' }], new Set([incompatibleShared.name]));
        const updateAction = disabledUpdatePlan.actions[0];
        assert.equal(updateAction.type, 'update', '禁用前置版本过低时仍需先更新');
        assert.equal(updateAction.enableAfter, true, '更新禁用前置必须标记更新后核实启用');
        sb._modHubModState = { sideMods: [{ name: incompatibleShared.name, enabled: false }], sideDisabled: [incompatibleShared.name] };
        const updateSteps = [];
        const failedUpdateEnable = await market.executeBatchInstallPlan(disabledUpdatePlan, {
            refresh: async () => {},
            install: async action => { updateSteps.push(`安装:${action.key}`); return true; },
            enable: async action => { updateSteps.push(`启用:${action.key}`); return false; }
        });
        assert.deepEqual(updateSteps, [`安装:${key(incompatibleShared)}`, `启用:${key(incompatibleShared)}`], '更新成功但仍禁用时必须调用启用，失败后不能继续目标');
        assert.equal(failedUpdateEnable.results.get(key(incompatibleShared)).status, 'failed', '更新完成但启用失败的前置应整体记为未完成');
        assert.equal(failedUpdateEnable.results.get(key(newConsumer)).status, 'skipped', '前置更新后的启用失败也必须阻断下游');
        assert.ok(failedUpdateEnable.changedMods.has(incompatibleShared.name), '启用失败不能抹掉已完成更新，仍需汇总实际配置变更');
        const verifiedUpdateEnable = await market.executeBatchInstallPlan(disabledUpdatePlan, {
            refresh: async () => {}, install: async () => true,
            enable: async () => { sb._modHubModState.sideMods[0].enabled = true; return true; }
        });
        assert.equal(verifiedUpdateEnable.results.get(key(newConsumer)).status, 'success', '更新并实际启用前置后才能安装目标');

        let unpreparedDownloads = 0;
        sb.modHubGetGui = () => { unpreparedDownloads++; return {}; };
        const missingRelease = await market.executeBatchInstallPlan(build([independent]), { refresh: async () => {}, releaseInfos: new Map() });
        assert.equal(unpreparedDownloads, 0, '计划变化产生的未预读操作不得直接进入下载器');
        assert.equal(missingRelease.results.get(key(independent)).status, 'failed', '缺少已确认发布信息必须拒绝执行');
        assert.ok(missingRelease.results.get(key(independent)).reason.includes('重新核对安装包'), '缺少发布信息要提示重新确认安装包');

        for (const [dependent, prerequisite, testCatalog] of [[beta, shared, catalog], [newConsumer, incompatibleShared, versionCatalog]]) {
            const local = [{ name: prerequisite.name, version: '1.0.0' }];
            const disabledNames = new Set([prerequisite.name]);
            let currentPlan = build([dependent, independent], testCatalog, local, disabledNames);
            const originalPlan = currentPlan;
            const calls = [];
            const revised = await market.executeBatchInstallPlan(originalPlan, {
                refresh: async () => {}, getPlan: () => currentPlan,
                confirm: async (_plan, action) => {
                    if (action.key === key(prerequisite)) currentPlan = build([dependent, independent], testCatalog, local, disabledNames, new Set([key(prerequisite)]));
                    return true;
                },
                enable: async action => { calls.push(`启用:${action.key}`); return true; },
                install: async action => { calls.push(action.key); return true; }
            });
            assert.deepEqual(calls, [key(dependent), key(independent)], '确认期间移除旧启用或更新动作后不得继续执行，明确取消前置后的下游和独立项继续');
            assert.equal(revised.results.get(key(prerequisite)).status, 'skipped', '从当前计划移除的旧动作必须标记跳过');
            assert.equal(revised.results.get(key(dependent)).status, 'success', '更新后的依赖图不能仍用旧边阻断明确取消前置的目标');
            assert.ok(!revised.changedMods.has(prerequisite.name), '被取消的更新或启用不能被计入实际变更');
        }

        const exceptionResult = await market.executeBatchInstallPlan(plan, {
            refresh: async () => {}, install: async action => { if (action.key === key(shared)) throw new Error('模拟校验失败'); return true; }
        });
        assert.equal(exceptionResult.results.get(key(shared)).reason, '模拟校验失败', '校验与下载异常必须保留真实原因');
        assert.equal(exceptionResult.results.get(key(independent)).status, 'success', '异常不能中断独立分支');
    }

    /* =========================================================================
     * 18. 批量选择：身份、准入、重绘、刷新与清空
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const available = { id: 'selection-alpha', name: '选择甲', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/SelectionAlpha' };
        const another = { id: 'selection-beta', name: '选择乙', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/SelectionBeta' };
        const external = { id: 'selection-external', name: '外部下载', otherUrl: 'https://example.com/mod' };
        const dead = { id: 'selection-dead', name: '失效来源', githubUrl: 'https://github.com/ModHubTests/DeadFixture', _isDeadRepo: true };
        assert.equal(market.isBatchInstallEligible(available, []), true, '未安装且支持页面内安装的模组可以多选');
        assert.equal(market.isBatchInstallEligible(available, [{ name: available.name, version: '1.0.0' }]), false, '已安装模组不可多选');
        assert.equal(market.isBatchInstallEligible(external, []), false, '仅外部下载项不可多选');
        assert.equal(market.isBatchInstallEligible(dead, []), false, '失效来源不可多选');
        assert.equal(market.getMarketModKey({ ...available, identityId: 'StableIdentity', name: '新名称' }), 'stableidentity', '身份优先于可变名称');
        let currentMods = [available, another, external];
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods: currentMods }) });
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected(market.getMarketModKey(available), true);
        market.setBatchModSelected(market.getMarketModKey(external), true);
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-alpha'], '非法下载项不能通过公共选择入口加入');
        market.filterInstalledOnly();
        market.selectAllVisibleMods();
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-alpha'], '筛选与重绘不能丢失已选项，全选仅增加当前可选项');
        market.resetFilters();
        market.selectAllVisibleMods();
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected).sort(), ['selection-alpha', 'selection-beta'], '全选当前筛选仅加入自动安装项');
        currentMods = [another, external];
        await market.loadMarketData(true);
        assert.deepEqual(Array.from(market.getBatchSelectionState().selected), ['selection-beta'], '刷新目录后清除已不存在的选择');
        market.clearBatchSelection();
        assert.equal(market.getBatchSelectionState().selected.length, 0, '清空选择必须移除全部勾选');
        market.setBatchModSelected('selection-beta', true);
        market.toggleBatchSelection(false);
        assert.equal(market.getBatchSelectionState().selecting, false, '退出多选恢复普通安装模式');
        assert.equal(market.getBatchSelectionState().selected.length, 0, '退出多选必须清空勾选');
        market.setBatchModSelected('selection-beta', true);
        assert.equal(market.getBatchSelectionState().selected.length, 0, '普通安装模式不能通过过期事件增加选择');
    }

    /* =========================================================================
     * 19. 批量冲突：目标、前置、本地及动态二次确认
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const maple = { id: 'maplebirch', name: '秋枫白桦框架' };
        const simple = { id: 'simple-framework', name: '简易框架' };
        const action = (mod, role = '目标模组', type = 'install') => ({ mod, role, type });
        for (const roles of [['目标模组', '目标模组'], ['目标模组', '前置依赖'], ['前置依赖', '前置依赖']]) {
            const conflicts = market.detectModInstallationConflicts(null, [action(maple, roles[0]), action(simple, roles[1])], [], new Set());
            assert.equal(conflicts.length, 1, '目标与前置的任意批次内部互斥组合都必须检出');
            assert.equal(conflicts[0].localConflictMod.isIncoming, true, '内部互斥不能伪装成本地项');
            const html = market.formatConflictWarningHtml(conflicts);
            assert.ok(html.includes('安装项间互斥'), '内部冲突必须明确标记安装项间互斥');
            assert.ok(!html.includes('modhub-conflict-disable-btn'), '批次内部项不能展示无效快捷禁用按钮');
        }
        const local = { name: 'maplebirch', version: '1.0.0', displayNames: ['maplebirch', '秋枫白桦框架'] };
        const enableAction = { ...action(maple, '前置依赖', 'enable'), local };
        const reenabled = market.detectModInstallationConflicts(null, [action(simple), enableAction], [local], new Set(['maplebirch']));
        assert.equal(reenabled.length, 1, '禁用项重新进入启用计划时只显示一次真实冲突');
        assert.equal(reenabled[0].localConflictMod.isIncoming, true, '本地禁用项即将重新启用时必须视为内部活跃冲突');
        assert.ok(!market.formatConflictWarningHtml(reenabled).includes('检查通过'), '快捷禁用不能掩盖计划内重新启用的冲突');
        const unchecked = market.detectModInstallationConflicts(null, [action(simple)], [local], new Set(['maplebirch']));
        assert.equal(unchecked[0].localConflictMod.isEnabled, false, '取消重新启用后才能识别为当前禁用');
        assert.ok(market.formatConflictWarningHtml(unchecked).includes('检查通过'), '取消冲突前置后实时恢复安全提示');
        const deduped = market.detectModInstallationConflicts(null, [action(simple), { ...enableAction, type: 'update' }, enableAction], [], new Set());
        assert.equal(deduped.length, 1, '同一模组的更新与启用不得重复显示互斥');

        let confirmations = 0;
        sb.modHubConfirm = async options => {
            confirmations++;
            assert.equal(options.confirmDelay, 5, '批量与单装冲突必须共用 5 秒倒计时');
            assert.equal(options.confirmText, '继续安装', '风险按钮必须明确表示继续安装');
            assert.ok(options.trustedMessageHtml.includes('安装项间互斥'), '二次确认必须展示内部互斥明细');
            return false;
        };
        const activePlan = { targetMod: null, actions: [action(maple), action(simple)] };
        assert.equal(await market.confirmInstallConflicts(() => activePlan), false, '取消二次确认必须终止批量安装');
        assert.equal(confirmations, 1, '取消后不能重复弹出风险提示');
        sb.modHubConfirm = async () => true;
        assert.equal(await market.confirmInstallConflicts(() => activePlan), true, '玩家明确确认后可继续处理冲突批次');
        sb.modHubConfirm = async () => { throw new Error('无冲突时不应弹窗'); };
        assert.equal(await market.confirmInstallConflicts(() => ({ targetMod: null, actions: [action(simple)] })), true, '无活跃冲突不应要求额外确认');

        let dynamicActions = [action(maple), action(simple)];
        let dynamicConfirmations = 0;
        sb.modHubConfirm = async options => {
            assert.equal(options.confirmDelay, 5, '新增风险同样需要完整倒计时');
            dynamicConfirmations++;
            if (dynamicConfirmations === 1) {
                dynamicActions = [...dynamicActions, action({ id: 'extra-maple', name: 'maplebirch' })];
                return true;
            }
            return false;
        };
        assert.equal(await market.confirmInstallConflicts(() => ({ targetMod: null, actions: dynamicActions })), false, '确认期间新增互斥不能沿用旧确认结果');
        assert.equal(dynamicConfirmations, 2, '新增冲突必须重新展示并等待确认');

        let riskVisible = true;
        let restoredRiskConfirmations = 0;
        let clearedDelays = 0;
        sb.modHubConfirm = async options => {
            restoredRiskConfirmations++;
            assert.equal(options.confirmDelay, 5, '已解除倒计时的风险重新出现后必须重新等待 5 秒');
            if (restoredRiskConfirmations > 1) return false;
            riskVisible = false;
            const dialog = createStubElement();
            dialog.modHubClearDelay = () => { clearedDelays++; };
            options.onRender(dialog);
            riskVisible = true;
            return true;
        };
        const restored = await market.confirmInstallConflicts(() => ({ targetMod: null, actions: riskVisible ? [action(maple), action(simple)] : [action(simple)] }));
        assert.equal(clearedDelays, 1, '冲突临时排除时会解除当前倒计时');
        assert.equal(restoredRiskConfirmations, 2, '同一冲突重新出现不能复用已经解锁的风险确认');
        assert.equal(restored, false, '重新出现的风险必须尊重第二次取消');
    }

    /* =========================================================================
     * 20. 批量下载的真实导入结果与浏览器线路限制
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const mod = { id: 'download-fixture', name: '下载检查项', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/DownloadFixture' };
        const releaseInfo = { version: '1.0.0', assetName: 'DownloadFixture.zip', assetUrl: `${mod.githubUrl}/releases/download/v1.0.0/DownloadFixture.zip` };
        sb.modHubGetGui = () => ({});
        sb.modHubShowToast = () => {};
        sb.modHubConfirm = async () => { throw new Error('批量下载不得弹出逐项提示'); };
        let failureReason = '';
        const options = { releaseInfo, batchMode: true, askRestart: false, skipReloadOffer: true, onFailure: reason => { failureReason = reason; } };
        assert.equal(await market.downloadAndInstallMod(mod, 'github', options), false, '浏览器直连下载不能统计为批量安装成功');
        assert.ok(failureReason.includes('手动下载'), '不支持页面内导入的线路必须返回明确原因');
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', { ...options, releaseInfo: { version: '1.0.0' } }), false, '无可用安装包必须返回失败');
        assert.ok(failureReason.includes('发布包'), '无包失败必须进入结果汇总');
        sb.Blob = Blob;
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob(['安装包测试数据']) });
        const importedOptions = [];
        sb.modHubHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return false; };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), false, '导入器明确失败不能被下载成功覆盖');
        sb.modHubHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return undefined; };
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), false, '导入器无成功返回值不能算批量成功');
        sb.modHubHandleAddMod = async (_input, installOptions) => { importedOptions.push(installOptions); return true; };
        sb._modHubModState = { sideMods: [{ name: mod.name, enabled: true }] };
        sb.modHubGetModInfo = () => ({ bootJson: { name: mod.name, version: mod.version } });
        assert.equal(await market.downloadAndInstallMod(mod, 'ddlc', options), true, '下载并得到导入器确认后才统计成功');
        assert.equal(importedOptions.length, 3, '每项安装只应调用一次导入器');
        for (const installOptions of importedOptions) {
            assert.equal(installOptions.keepCurrentTab, true, '批量导入必须保持市场页签');
            assert.equal(installOptions.askRestart, false, '批量导入必须关闭逐项重载确认');
            assert.equal(installOptions.skipReloadOffer, true, '批量导入必须关闭框架逐项重载提示');
        }
    }

    /* =========================================================================
     * 21. 批量准备期间的重复提交与市场安装互斥锁
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const mod = { id: 'lock-fixture', name: '互斥锁检查项', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/LockFixture' };
        let releaseReads = 0;
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
            releaseReads++;
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'LockFixture.zip', browser_download_url: `${mod.githubUrl}/releases/download/v1.0.0/LockFixture.zip` }] }) };
        };
        const warnings = [];
        sb.modHubShowToast = (message, type) => { if (type === 'warning') warnings.push(message); };
        sb.modHubEscapeHtml = text => String(text);
        sb.modHubConfirm = async () => false;
        sb.modHubAlert = async () => {};
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected('lock-fixture', true);
        let releasePreparation;
        sb.modHubLoadModManageState = async () => new Promise(resolve => { releasePreparation = resolve; });
        const pendingBatch = market.installSelectedMods();
        assert.equal(market.getBatchSelectionState().running, true, '读取安装清单前就必须锁定批量状态');
        assert.equal(await market.installSelectedMods(), false, '准备阶段重复点击不得发起第二个批次');
        assert.equal(await market.promptDownloadMirrorAndInstall(mod), false, '批量准备阶段不能并行启动单项安装');
        assert.equal(await market.updateAllMods(), false, '批量准备阶段不能并行启动全部更新');
        assert.equal(warnings.length, 3, '被拒绝的入口应明确提示已有任务');
        market.clearBatchSelection();
        market.toggleBatchSelection(false);
        assert.equal(market.getBatchSelectionState().selected.length, 1, '执行期间旧事件不能清空当前批次选择');
        releasePreparation();
        assert.equal(await pendingBatch, false, '取消总确认必须安全退出');
        assert.equal(releaseReads, 1, '重复提交不得重复读取发布信息');
        assert.equal(market.getBatchSelectionState().running, false, '取消后必须释放运行状态');
        assert.equal(market.getBatchSelectionState().selected.length, 1, '取消安装应保留未完成选择供重试');
        let externalOpened = '';
        sb.open = url => { externalOpened = url; };
        const external = { name: '单装回归项', otherUrl: 'https://example.com/manual' };
        assert.equal(await market.promptDownloadMirrorAndInstall(external), true, '取消批量后单项入口必须恢复，原外部下载流程保持兼容');
        assert.equal(externalOpened, external.otherUrl, '单装外部链接仍由原流程打开');
    }

    /* =========================================================================
     * 22. 取消问题前置恢复分支后，补读发布包并重新确认
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const broken = { id: 'replan-broken', name: '问题前置', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/ReplanBroken', dependencies: [{ id: 'absent-replan' }] };
        const target = { id: 'replan-target', name: '恢复安装目标', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/ReplanTarget', dependencies: [{ id: broken.id }] };
        const events = [];
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [target, broken] }) };
            events.push('预读发布包');
            assert.ok(String(url).includes('/ReplanTarget/releases/latest'), '取消问题前置后只需为恢复的目标补读发布信息');
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: ['Replan-branch-a.zip', 'Replan-branch-b.zip'].map(name => ({ name, browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/${name}` })) }) };
        };
        sb.modHubEscapeHtml = value => String(value);
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        sb.modHubLoadModManageState = async () => {};
        let totalConfirmations = 0;
        sb.modHubConfirm = async options => {
            if (options.title === '批量安装确认') {
                totalConfirmations++;
                events.push(`总确认${totalConfirmations}`);
                if (totalConfirmations > 1) return false;
                const checkbox = createStubElement('input');
                Object.assign(checkbox, { name: 'modHubBatchDependency', checked: true, dataset: { key: 'replan-broken' } });
                const area = createStubElement();
                area.querySelectorAll = selector => selector.includes('modHubBatchDependency') ? [checkbox] : [];
                const dialog = createStubElement();
                dialog.querySelector = () => area;
                options.onRender(dialog);
                checkbox.checked = false;
                checkbox.onchange();
                return true;
            }
            assert.equal(options.title, `选择【${target.name}】的安装包`, '重新规划后的多个发布包仍须由玩家选择');
            events.push('手选安装包');
            assert.equal(options.requireSelection, true, '兼容包不能绕过显式选择');
            return 'asset:1';
        };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        market.setBatchModSelected('replan-target', true);
        assert.equal(await market.installSelectedMods(), false, '补读后重新确认时仍可安全取消');
        assert.deepEqual(events, ['总确认1', '预读发布包', '手选安装包', '总确认2'], '恢复分支必须先补读真实发布、手选候选包，再重开总确认');
        assert.equal(market.getBatchSelectionState().selected.length, 1, '重规划后取消仍保留未完成目标');
    }

    /* =========================================================================
     * 23. 批量确认区分真正满足的前置，并优先展示冲突警告
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const makeMod = (id, version = '1.0.0', dependencies = []) => ({ id, name: id, version, dependencies, githubUrl: `https://github.com/ModHubTests/${id}` });
        const satisfied = makeMod('SatisfiedFixture');
        const disabled = makeMod('DisabledFixture');
        const outdated = makeMod('OutdatedFixture', '2.0.0');
        const absent = makeMod('AbsentFixture');
        const blockedOld = makeMod('BlockedOldFixture', '2.0.0');
        const target = makeMod('SatisfiedConsumerFixture', '1.0.0', [
            { id: satisfied.id, version: '^1.0.0' }, { id: disabled.id }, { id: outdated.id, version: '^2.0.0' }, { id: absent.id }
        ]);
        const blockedTarget = makeMod('BlockedSatisfiedConsumerFixture', '1.0.0', [{ id: blockedOld.id, version: '^2.0.0' }, { id: 'unknown-required-fixture' }]);
        const simple = { ...makeMod('simple-framework'), name: '简易框架' };
        const maple = { ...makeMod('maplebirch'), name: '秋枫白桦框架' };
        const mods = [target, blockedTarget, satisfied, disabled, outdated, absent, blockedOld, simple, maple];
        const profiles = [satisfied, disabled, outdated, blockedOld].map(mod => ({ name: mod.name, version: '1.0.0' }));
        const plan = market.buildBatchInstallPlan([target, blockedTarget], mods, profiles, new Set([disabled.name]));
        const requirement = mod => plan.requirements.find(item => item.key === market.getMarketModKey(mod));
        assert.equal(requirement(satisfied).satisfied, true, '已安装、启用且版本满足全部约束的前置应标记已满足');
        for (const mod of [disabled, outdated, absent, blockedOld]) {
            assert.equal(requirement(mod).satisfied, false, '禁用、版本不足、未安装或因分支阻塞移除操作的前置都不能误标已满足');
        }
        assert.ok(!plan.actions.some(action => action.key === market.getMarketModKey(blockedOld)), '本用例必须覆盖动作已移除但本地版本仍不满足的分支');

        sb._modHubModState = { sideMods: profiles.map(profile => ({ name: profile.name, enabled: profile.name !== disabled.name })), sideDisabled: [disabled.name] };
        sb.modHubGetModInfo = name => ({ bootJson: profiles.find(profile => profile.name === name) });
        sb.modHubLoadModManageState = async () => {};
        sb.modHubEscapeHtml = value => String(value);
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods }) };
            const mod = mods.find(item => String(url).includes(`/${item.id}/releases/latest`));
            assert.ok(mod, '确认页测试只能预读模拟目录中的发布包');
            return { ok: true, json: async () => ({ tag_name: `v${mod.version}`, assets: [{ name: `${mod.id}.zip`, browser_download_url: `${mod.githubUrl}/releases/download/v${mod.version}/${mod.id}.zip` }] }) };
        };
        let html = '';
        sb.modHubConfirm = async options => { assert.equal(options.title, '批量安装确认'); html = options.trustedMessageHtml; return false; };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        for (const mod of [target, blockedTarget, simple, maple]) market.setBatchModSelected(market.getMarketModKey(mod), true);
        await market.installSelectedMods();
        assert.ok(html.includes('<div class="modhub-dep-item modhub-dep-satisfied">') && html.includes('<span class="green">已满足，无需下载</span>'), '真正满足的前置使用只读行和绿色的无需下载说明');
        const checkboxFor = mod => new RegExp(`<input\\b(?=[^>]*name="modHubBatchDependency")(?=[^>]*data-key="${market.getMarketModKey(mod)}")[^>]*>`).test(html);
        assert.equal(checkboxFor(satisfied), false, '已满足前置不能出现需要勾选安装的控件');
        for (const mod of [disabled, outdated, absent, blockedOld]) assert.equal(checkboxFor(mod), true, '待启用、更新、安装与阻塞的前置仍保留处理复选框');
        assert.ok(html.indexOf('modhub-install-conflict-card') >= 0 && html.indexOf('modhub-install-conflict-card') < html.indexOf('所选目标'), '冲突警告必须位于所选目标列表之前');
        const targetListOffset = html.indexOf('modhub-batch-target-list');
        assert.ok(html.indexOf('modhub-install-conflict-card') < html.indexOf('前置依赖') && html.indexOf('前置依赖') < targetListOffset && targetListOffset < html.indexOf('modhub-batch-summary'), '确认页必须按冲突、前置、滚动目标列表、汇总的顺序展示');
        assert.ok(html.includes('modhub-batch-target-dependencies') && html.includes(`需要前置：${satisfied.name}（^1.0.0）`), '每项目标必须展示其直接前置名称与版本要求');
        assert.match(html, /<div>将串行处理 <strong class="gold">\d+ 项操作<\/strong>/, '操作数量必须明确高亮');
        assert.ok(html.includes('<div>下载线路：<strong class="gold">'), '下载线路必须独立成行并高亮');
    }

    /* =========================================================================
     * 24. 批量快捷禁用：实际成功才取消重新处理前置，取消与失败保持原计划
     * ========================================================================= */
    for (const mode of ['success', 'cancel', 'failed', 'unverified']) {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const maple = { id: 'maplebirch', name: '秋枫白桦框架', version: '1.0.0', githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' };
        const simple = { id: 'simple-framework', name: '简易框架', version: '1.0.0', githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework' };
        const target = { id: 'disable-consumer', name: '本批框架使用者', version: '1.0.0', githubUrl: 'https://github.com/ModHubTests/DisableConsumer', dependencies: [{ id: maple.id }] };
        const mods = [maple, simple, target];
        const localConsumerName = '本地框架使用者';
        sb._modHubModState = { sideMods: [{ name: maple.id, enabled: true }, { name: localConsumerName, enabled: true }], sideDisabled: [] };
        sb.modHubGetModInfo = name => ({ bootJson: { name, version: '1.0.0', ...(name === localConsumerName ? { dependenceInfo: [{ modName: maple.id }] } : {}) } });
        let refreshCount = 0;
        sb.modHubLoadModManageState = async () => { refreshCount++; };
        sb.modHubEscapeHtml = value => String(value);
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        let reloadOffers = 0;
        sb.modHubOfferReload = async () => { reloadOffers++; };
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods }) };
            return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'DisableConsumer.zip', browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/DisableConsumer.zip` }] }) };
        };
        let toggles = 0;
        sb.modHubToggleSideMod = async (rawName, enabled) => {
            toggles++;
            assert.equal(rawName, maple.id, '快捷禁用必须使用真实本地名称');
            assert.equal(enabled, false, '快捷禁用不得意外启用框架');
            if (mode === 'success') {
                sb._modHubModState.sideMods[0].enabled = false;
                sb._modHubModState.sideDisabled = [maple.id];
            }
            return mode !== 'failed';
        };
        let refreshedHtml = '', impactHtml = '';
        sb.modHubConfirm = async options => {
            if (options.title !== '批量安装确认') {
                assert.ok(options.title.includes('确认快捷禁用'), '快捷禁用应先提示其影响');
                assert.equal(options.confirmType, 'danger', '存在本地或本批依赖影响时必须使用危险确认');
                impactHtml = `${options.message || ''}${options.trustedMessageHtml || ''}`;
                return mode !== 'cancel';
            }
            const area = createStubElement();
            const button = createStubElement('button');
            button.dataset = { conflictRaw: maple.id, conflictName: maple.name };
            area.querySelectorAll = selector => selector === '.modhub-conflict-disable-btn' && area.innerHTML.includes('modhub-conflict-disable-btn') ? [button] : [];
            const dialog = createStubElement();
            dialog.querySelector = () => area;
            options.onRender(dialog);
            assert.equal(typeof button.onclick, 'function', '总确认中的实际快捷禁用按钮必须绑定处理流程');
            await button.onclick({ preventDefault() {}, stopPropagation() {} });
            refreshedHtml = area.innerHTML;
            return false;
        };
        await market.loadMarketData(true);
        market.toggleBatchSelection(true);
        for (const mod of [target, simple]) market.setBatchModSelected(market.getMarketModKey(mod), true);
        await market.installSelectedMods();
        assert.ok(impactHtml.includes(target.name) && impactHtml.includes(localConsumerName), '禁用确认必须同时说明本地与本批依赖该框架的模组');
        assert.ok(impactHtml.includes('modhub-modal-affected-box') && impactHtml.includes('本地受影响模组') && impactHtml.includes('本次安装受影响目标'), '本地与本批影响应分区突出呈现');
        assert.equal(toggles, mode === 'cancel' ? 0 : 1, '取消快捷禁用不得写入控制器，其余场景只尝试一次');
        assert.equal(refreshedHtml.includes('自行处理'), mode === 'success', '只有已核实禁用成功才把该前置改为自行处理，失败与取消不能偷改勾选');
        assert.equal(reloadOffers, mode === 'success' ? 1 : 0, '总确认取消后仍需为真实禁用变更提示一次重载，未变更不得提示');
        if (mode === 'success') assert.ok(refreshCount >= 2, '快捷禁用成功后必须重新读取持久化状态再宣告成功');
    }

    /* =========================================================================
     * 25. 单装确认不能越过仍在持久化的快捷禁用
     * ========================================================================= */
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const framework = { id: 'maplebirch', name: '秋枫白桦框架', version: '1.0.0', githubUrl: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' };
        const target = { id: 'simple-framework', name: '简易框架', version: '1.0.0', githubUrl: 'https://github.com/emicoto/SCMLSimpleFramework', dependencies: [{ id: framework.id }] };
        sb._modHubModState = { sideMods: [{ name: framework.id, enabled: true }], sideDisabled: [] };
        sb.modHubGetModInfo = name => ({ bootJson: { name, version: '1.0.0' } });
        sb.modHubLoadModManageState = async () => {};
        sb.modHubEscapeHtml = value => String(value);
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        sb.modHubGetGui = () => ({});
        sb.Blob = Blob;
        let downloads = 0;
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [framework, target] }) };
            if (String(url).includes('/releases?')) return { ok: true, json: async () => [] };
            if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'SingleRace.zip', browser_download_url: `${target.githubUrl}/releases/download/v1.0.0/SingleRace.zip` }] }) };
            downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () => new Blob(['单装测试包']) };
        };
        let finishPersistence, signalPersistenceStarted;
        const persistence = new Promise(resolve => { finishPersistence = resolve; });
        const persistenceStarted = new Promise(resolve => { signalPersistenceStarted = resolve; });
        const toggles = [];
        sb.modHubToggleSideMod = async (name, enabled) => {
            toggles.push({ name, enabled });
            if (enabled) {
                sb._modHubModState.sideMods[0].enabled = true;
                return true;
            }
            signalPersistenceStarted();
            await persistence;
            sb._modHubModState.sideMods[0].enabled = false;
            sb._modHubModState.sideDisabled = [framework.id];
            return true;
        };
        const installed = [];
        sb.modHubHandleAddMod = async (_input, options) => {
            installed.push(options.displayName);
            sb._modHubModState.sideMods.push({ name: 'SimpleFramework', enabled: true });
            return true;
        };
        let pendingDisable;
        sb.modHubConfirm = async options => {
            if (options.title === `下载并安装【${target.name}】`) {
                const conflictArea = createStubElement();
                const button = createStubElement('button');
                button.dataset = { conflictRaw: framework.id, conflictName: framework.name };
                conflictArea.querySelectorAll = selector => selector === '.modhub-conflict-disable-btn' && conflictArea.innerHTML.includes('modhub-conflict-disable-btn') ? [button] : [];
                const dialog = createStubElement();
                const query = dialog.querySelector;
                dialog.querySelector = selector => selector === '#modHubInstallConflictArea' ? conflictArea : query(selector);
                options.onRender(dialog);
                assert.equal(typeof button.onclick, 'function', '单装初次确认必须提供可执行的快捷禁用按钮');
                pendingDisable = button.onclick({ preventDefault() {}, stopPropagation() {} });
                // 模拟用户已确认禁用，在保存尚未结束时立即确认主安装弹窗。
                return { selectValue: '', selectedReqIndices: vm.runInContext('new Set([0])', sb) };
            }
            return true;
        };
        await market.loadMarketData(true);
        const pendingInstall = market.promptDownloadMirrorAndInstall(target);
        await persistenceStarted;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(downloads, 0, '快捷禁用尚未持久化时不能开始下载');
        assert.equal(installed.length, 0, '快捷禁用尚未持久化时不能开始导入');
        assert.equal(toggles.filter(item => item.enabled).length, 0, '保存期间不能执行旧计划中的启用操作');
        finishPersistence();
        await pendingDisable;
        assert.equal(await pendingInstall, true, '禁用核验完成后单装应继续安装目标');
        assert.deepEqual(installed, [target.name], '快捷禁用完成后只安装目标，不能重装已明确跳过的框架');
        assert.deepEqual(toggles, [{ name: framework.id, enabled: false }], '过期勾选快照不能覆盖禁用意图并重新启用框架');
        assert.equal(sb._modHubModState.sideMods[0].enabled, false, '单装完成后被快捷禁用的框架必须保持禁用');
    }

    /* =========================================================================
     * 26. 尚未重载的新模组不得被运行时对手别名污染
     * ========================================================================= */
    {
        const createAliasFixture = (simpleInstalled = true) => {
            const maple = { name: 'maplebirch', bootJson: { name: 'maplebirch', version: '5.0.4', nickName: { chs: '秋枫白桦框架' }, alias: ['Simple Frameworks'], repository: 'https://github.com/MaplebirchLeaf/SCML-DOL-maplebirchframework' } };
            const simpleBoot = { name: 'Simple Frameworks', version: '2.0.5', nickName: { chs: '简易框架' }, repository: 'https://github.com/emicoto/SCMLSimpleFramework' };
            const data = new Map([['maplebirch', new Uint8Array([1])], ...(simpleInstalled ? [['Simple Frameworks', new Uint8Array([2])]] : [])]);
            const controller = createMockController({ enabled: simpleInstalled ? ['Simple Frameworks'] : [], disabled: ['maplebirch'], zips: Array.from(data.keys()) });
            controller.checkModZipFileIndexDB = async bytes => bytes[0] === 2 ? simpleBoot : maple.bootJson;
            controller.addModIndexDB = async (name, bytes) => { data.set(name, bytes); controller.store.zips.add(name); if (!controller.store.enabled.includes(name)) controller.store.enabled.push(name); };
            const cache = [{ mod: maple }];
            const reads = [];
            const utils = {
                getModLoader: () => ({ getModCacheArray: () => cache, getIndexDBLoader: () => ({ customStore: {}, constructor: { calcModNameKey: name => name } }) }),
                getIdbKeyValRef: () => ({ get: async name => { reads.push(name); return data.get(name); } }),
                getAnyModByNameNoAlias: name => name === 'maplebirch' ? maple : null,
                getMod: name => ['maplebirch', 'Simple Frameworks'].includes(name) ? maple : null,
                getModList: () => [maple], getModListNameNoAlias: () => ['maplebirch']
            };
            const sb = loadManager({ modModLoadController: controller, modUtils: utils });
            loadScripts(sb, ['javascript/modhub-market.js']);
            return { sb, controller, maple, simpleBoot, cache, reads, data, utils };
        };
        const fixture = createAliasFixture();
        const { sb, maple, simpleBoot, cache, reads, data, utils } = fixture;
        assert.equal(sb.modHubGetModInfo('Simple Frameworks'), null, '尚未读取安装包时不得把运行时别名指向的秋枫当成简易框架');
        await sb.modHubLoadModManageState(true);
        assert.ok(reads.includes('Simple Frameworks'), '已启用但尚未进入运行时的模组必须补读 IndexedDB 档案');
        const info = sb.modHubGetModInfo('Simple Frameworks');
        assert.equal(info.bootJson.name, simpleBoot.name, '新安装模组必须返回其真实技术名');
        assert.equal(info.bootJson.version, '2.0.5', '管理页必须显示真实安装版本，不能借用秋枫的 5.0.4');
        assert.equal(sb.modHubGetModSubtext('Simple Frameworks', info, false), '简易框架', '管理副标题必须来自真实简易框架档案');
        assert.equal(sb.modHubGetModInfo(' simple frameworks ').bootJson.version, '2.0.5', '精确身份仍允许首尾空格与大小写差异');
        const profile = sb.modHubMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks');
        assert.equal(profile.version, '2.0.5', '市场本地版本不能被运行时对手别名污染');
        assert.ok(!profile.displayNames.includes('maplebirch') && !profile.displayNames.includes('秋枫白桦框架'), '简易框架的市场身份不能混入秋枫名称');
        assert.ok(!profile.repositoryKeys.includes('maplebirchleaf/scml-dol-maplebirchframework'), '简易框架不能携带秋枫仓库身份');
        const simpleMarket = { id: 'simple-framework', name: '简易框架', version: '2.0.6', githubUrl: simpleBoot.repository };
        assert.equal(sb.modHubMarket.checkModInstallStatus(simpleMarket, sb.modHubMarket.getLocalInstalledProfiles()), 'update_available', '市场必须依据真实 2.0.5 识别 2.0.6 更新，不能被错误 5.0.4 压住');
        assert.equal(sb.modHubGetModInfo('maplebirch').bootJson.version, '5.0.4', '修复简易框架不能改写真实秋枫档案');

        const newer = { name: 'Simple Frameworks', bootJson: { ...simpleBoot, version: '2.0.7' } };
        cache.push({ mod: { name: 'Simple Frameworks', bootJson: simpleBoot } }, { mod: newer });
        assert.equal(sb.modHubGetModInfo('Simple Frameworks'), newer, '最新的精确运行时档案仍优先于旧缓存与存储档案');
        cache.splice(1);
        const spoof = { name: 'Simple Frameworks', bootJson: maple.bootJson };
        cache.push({ mod: spoof });
        utils.getAnyModByNameNoAlias = () => spoof;
        assert.equal(sb.modHubGetModInfo('Simple Frameworks').bootJson.name, simpleBoot.name, '即使包装层名称正确，也必须拒绝 boot.name 属于其他模组的缓存与无别名接口结果');
        cache.splice(1);
        utils.getAnyModByNameNoAlias = name => name === 'maplebirch' ? maple : null;
        data.set('WrongStorageKey', new Uint8Array([1]));
        assert.equal(await sb.modHubLoadDisabledModInfo(['WrongStorageKey'], true), 0, '存储键与 boot.name 不一致时不能缓存错名档案');
        assert.equal(sb._modHubDisabledModInfo.has('wrongstoragekey'), false, '错名安装包不能污染其他技术名的元数据缓存');
        sb._modHubDisabledModInfo.set('simple frameworks', { name: 'Simple Frameworks', bootJson: maple.bootJson });
        assert.equal(sb.modHubGetModInfo('Simple Frameworks'), null, '已有缓存也必须核验 boot.name，不能信任键名与外层 name');
        assert.equal(await sb.modHubLoadDisabledModInfo(['Simple Frameworks'], false), 1, '非强制刷新也必须替换已有的错名缓存');
        assert.equal(sb.modHubGetModInfo('Simple Frameworks').bootJson.version, '2.0.5', '错误缓存应通过精确存储档案恢复');
        sb._modHubDisabledModInfo.delete('simple frameworks');
        const missingProfile = sb.modHubMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks');
        assert.equal(missingProfile.version, '', '精确档案暂缺时市场不得绕过校验再次 getMod 别名回退');
        assert.ok(!missingProfile.displayNames.includes('maplebirch'), '档案暂缺时保留未知状态，不能引入对手身份');

        const fresh = createAliasFixture(false);
        const installed = await fresh.sb.modHubInstallModZip({ name: 'SimpleFramework.zip', arrayBuffer: async () => new Uint8Array([2]).buffer });
        assert.equal(installed.verified, true, '安装回退路径必须先确认真实落盘');
        assert.equal(fresh.sb.modHubGetModInfo('Simple Frameworks').bootJson.version, '2.0.5', '直接安装完成后应立即缓存已核验 boot，无需等待重载或刷新');

        for (const mode of ['single', 'batch']) {
            const { sb: run, simpleBoot: boot } = createAliasFixture(false);
            const mod = { id: 'simple-framework', name: '简易框架', version: boot.version, githubUrl: boot.repository };
            run.Blob = Blob;
            run.modHubConfirm = async () => true;
            run.modHubAlert = async () => {};
            run.fetch = async url => {
                if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, mods: [mod] }) };
                if (String(url).includes('/releases?')) return { ok: true, json: async () => [] };
                if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: `v${boot.version}`, assets: [{ name: 'SimpleFramework.zip', browser_download_url: `${mod.githubUrl}/releases/download/v${boot.version}/SimpleFramework.zip` }] }) };
                return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([2])]) };
            };
            run.modHubHandleAddMod = async input => {
                for (const file of input.files || input) await run.modHubInstallModZip(file);
                await run.modHubLoadModManageState(true);
                return true;
            };
            await run.modHubLoadModManageState(true);
            await run.modHubMarket.loadMarketData(true);
            if (mode === 'single') assert.equal(await run.modHubMarket.promptDownloadMirrorAndInstall(mod), true, '单装公开入口应完成真实存储写入');
            else {
                run.modHubMarket.toggleBatchSelection(true);
                run.modHubMarket.setBatchModSelected('simple-framework', true);
                const result = await run.modHubMarket.installSelectedMods();
                assert.equal(result.results.get('simple-framework').status, 'success', '批量公开入口应完成真实存储写入');
            }
            const installedInfo = run.modHubGetModInfo('Simple Frameworks');
            assert.equal(installedInfo.bootJson.version, boot.version, '单装与批量安装在尚未重载时都必须展示真实版本');
            assert.equal(run.modHubGetModSubtext('Simple Frameworks', installedInfo, false), '简易框架', '单装与批量都不能从旧运行时别名拿到秋枫副标题');
            assert.equal(run.modHubMarket.getLocalInstalledProfiles().find(item => item.name === 'Simple Frameworks').version, boot.version, '两条安装路径都必须向市场提供正确本地版本');
        }
    }

    // 市场导入前核对真实清单，任何包校验失败都不得调用写入接口。
    {
        const sb = loadMarket();
        sb.Blob = Blob;
        const mod = { name: '主模组显示名', bootNames: ['FixtureMain'], githubUrl: 'https://github.com/ModHubTests/PackageCheck' };
        const bootByByte = new Map([[1, { name: 'FixtureMain' }], [2, { name: 'FixtureResources' }]]);
        sb.modHubGetGui = () => ({});
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => bootByByte.get(data[0]) });
        sb.modHubShowToast = () => {};
        const alerts = [];
        sb.modHubAlert = async message => { alerts.push(message); };
        sb.modHubConfirm = async () => { throw new Error('包内容校验失败不应弹出换线重试'); };
        let imports = 0;
        sb.modHubHandleAddMod = async () => { imports++; return true; };
        sb._modHubModState = { sideMods: [{ name: 'FixtureMain', enabled: true }] };
        sb.modHubGetModInfo = () => ({ bootJson: { name: 'FixtureMain' } });
        let downloads = 0;
        sb.fetch = async url => {
            downloads++;
            return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([String(url).includes('companion.zip') ? 2 : 1])]) };
        };
        let reason = '';
        const releaseInfo = { assets: ['main.zip', 'companion.zip'].map(name => ({ name, downloadUrl: `${mod.githubUrl}/releases/download/v1/${name}` })) };
        const options = { releaseInfo, batchMode: true, askRestart: false, onFailure: value => { reason = value; } };
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(mod, 'ddlc', options), true, '可信主包与有效附属包应正常导入');
        assert.equal(imports, 1);

        bootByByte.set(1, { name: 'UnrelatedExtension' });
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(mod, 'ddlc', { ...options, batchMode: false }), false, '主包身份错配必须在写入前阻止');
        assert.ok(reason.includes('UnrelatedExtension'));
        assert.equal(alerts.length, 1, '单项错误应直接说明实际包名');
        assert.equal(imports, 1, '不能写入不相关模组');
        assert.equal(downloads, 4, '内容错误不得触发换线反复下载');

        bootByByte.set(1, { name: 'FixtureMain' });
        bootByByte.set(2, false);
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(mod, 'ddlc', options), false, '附属ZIP缺少清单也必须阻止整组导入');
        assert.ok(reason.includes('companion.zip'));
        assert.equal(imports, 1, '后续包无效时不能先写入主包');

        bootByByte.set(2, { name: 'FixtureResources' });
        bootByByte.set(1, { name: 'UnmappedTechnicalName' });
        assert.equal(await sb.modHubMarket.downloadAndInstallMod({ ...mod, bootNames: [], _matchedLocal: null }, 'ddlc', options), true, '未知中文显示名不得被猜测为技术名从而误拦有效包');
        assert.equal(imports, 2);

        const communityRelease = `${mod.githubUrl}/releases/latest`;
        const [community] = sb.modHubMarket.normalizeReleaseIndex({ schemaVersion: 1, mods: [{
            ...mod, id: 'community-package-check', identityId: 'fixture-main',
            catalogSource: 'community', sourcePlatform: 'github', sourceUrl: communityRelease,
            githubUrl: communityRelease, autoInstall: true
        }] });
        bootByByte.set(1, { name: 'FixtureMain' });
        assert.equal(await sb.modHubMarket.downloadAndInstallMod({
            ...community, sourceUrl: mod.githubUrl, githubUrl: mod.githubUrl
        }, 'ddlc', options), false, '直接调用安装入口也不能绕过社区 Release 链接核验');
        assert.equal(imports, 2);
        sb.modHubGetController = () => ({});
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(community, 'ddlc', options), false,
            '社区安装缺少 ModLoader 包体校验接口时必须失败');
        assert.ok(reason.includes('无法核验社区模组安装包'));
        assert.equal(imports, 2, '无法校验时不得导入任何包');

        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async data => bootByByte.get(data[0]) });
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(community, 'ddlc', options), false,
            '社区多包安装的附属包也必须符合已核验技术名');
        assert.ok(reason.includes('FixtureResources'));
        assert.equal(imports, 2, '附属包身份错配时整组不得写入');

        bootByByte.set(2, { name: 'FixtureMain' });
        assert.equal(await sb.modHubMarket.downloadAndInstallMod(community, 'ddlc', options), true,
            '社区多包均通过包体身份校验后才能安装');
        assert.equal(imports, 3);
    }

    // AU 三模型为可替代前置，各自版本要求必须贯穿单装、批装和包体预检。
    {
        const sb = loadMarket();
        const market = sb.modHubMarket;
        const identities = JSON.parse(fs.readFileSync(path.join(srcRoot, '..', 'mod-identities.json'), 'utf8')).mods;
        market.applyIdentityCatalog(identities);
        const au = identities.find(mod => mod.id === 'au-beautification');
        const face = identities.find(mod => mod.id === 'au-facial-expansion');
        const hair = identities.find(mod => mod.id === 'au-hair-optimization');
        for (const mod of [au, face, hair]) mod.githubUrl = `https://github.com/AOKIUTAGE/UTAGEsDOL3.0/releases/tag/${mod === au ? 'mod' : mod === face ? 'facemod' : 'hairmod'}`;
        const catalog = [au, face, hair];
        const variants = [['【AUfemale】model', '0.6.6', '0.6.5', 'AUfemale.model'], ['【AUmale】model', '0.3.1', '0.3.0', 'AUmale.model'], ['【AUandrogynous】model', '0.0.3', '0.0.2', 'AUandrogynous.model']];
        const key = market.getMarketModKey(au);
        const single = (profiles, disabled = []) => market.buildDependencyPlan(face, catalog, profiles, disabled);
        const batch = (profiles, disabled = [], releases = new Map()) => market.buildBatchInstallPlan([face, hair], catalog, profiles, disabled, new Set(), releases);
        assert.deepEqual(Array.from(single([]).actions, action => action.type), ['install'], '缺少 AU 主包时仅添加一个可选模型前置');
        assert.equal(batch([]).actions.filter(action => action.key === key).length, 1, '多个 AU 扩展共享主包且只安装一次');
        for (const [name, minimum, older, assetPrefix] of variants) {
            const installed = [{ name, version: minimum }];
            assert.equal(single(installed).actions.length, 0, `${name} 达到自身最低版本即可满足前置`);
            assert.equal(batch(installed).actions.filter(action => action.key === key).length, 0, `${name} 批量安装不得额外安装其他模型`);
            assert.deepEqual(Array.from(single(installed, [name]).actions, action => action.type), ['enable'], `${name} 禁用时只需启用`);
            assert.equal(batch(installed, [name]).actions.find(action => action.key === key).type, 'enable', '批量应复用启用动作');
            assert.equal(single([{ name, version: older }]).actions[0].type, 'update', `${name} 低版必须更新`);
            const oldRelease = { version: older, assets: [{ name: `${assetPrefix}_v${older}.zip`, downloadUrl: 'https://example.com/au.zip' }] };
            const blocked = batch([], [], new Map([[key, oldRelease]]));
            assert.ok(blocked.blocked.has(market.getMarketModKey(face)), '已选低版本主包必须阻止依赖该版本的面扩');
            const validRelease = { version: minimum, assets: [{ name: `${assetPrefix}_v${minimum}.zip`, downloadUrl: 'https://example.com/au.zip' }] };
            assert.equal(batch([], [], new Map([[key, validRelease]])).blocked.size, 0, '满足对应模型版本的候选可正常批量安装');
        }
        const onlyFace = [{ name: '【AUsDoL】facial expansion', version: '9.0.0' }];
        assert.equal(single(onlyFace).actions[0].type, 'install', '面部扩展自身绝不能被误认成 AU 主包');
        const twoModels = variants.slice(0, 2).map(([name, version]) => ({ name, version }));
        assert.equal(single(twoModels).actions.length, 0, '多个有效模型并存不能被并列身份误判为未安装');
        single(twoModels, [twoModels[0].name]);
        assert.equal(au._matchedLocal.name, twoModels[1].name, '单装应按显式禁用列表优先选择已启用模型');
        batch(twoModels, [twoModels[0].name]);
        assert.equal(au._matchedLocal.name, twoModels[1].name, '批装应按显式禁用列表优先选择已启用模型');
        const freshNormalized = market.normalizeReleaseIndex({ schemaVersion: 1, identities, mods: catalog });
        assert.equal(freshNormalized.find(mod => mod.id === face.id).dependencies[0].bootVersions['【AUmale】model'], '>=0.3.1', '统一索引必须保留按模型技术名设置的版本约束');
        const oldIndex = market.normalizeReleaseIndex({ schemaVersion: 1, identities: identities.filter(mod => !mod.id.startsWith('au-')), mods: catalog.map(mod => ({ id: `legacy-${mod.name}`, identityId: null, name: mod.name, githubUrl: mod.githubUrl })) });
        const oldPlan = market.buildDependencyPlan(oldIndex.find(mod => mod.name === face.name), oldIndex, []);
        assert.equal(oldPlan.unavailable.length, 0, '旧索引缺 AU 身份时内置回退仍必须找到主包前置');
        assert.equal(oldPlan.actions[0].mod.identityId, au.id, '旧索引需补上明确身份供依赖查找');

        sb.Blob = Blob;
        sb.modHubGetGui = () => ({});
        au._matchedLocal = null;
        let actualBoot = { name: variants[0][0], version: variants[0][2] };
        sb.modHubGetController = () => ({ checkModZipFileIndexDB: async () => actualBoot });
        sb.modHubShowToast = () => {};
        sb.modHubAlert = async () => {};
        let imports = 0, failure = '';
        sb.modHubHandleAddMod = async () => { imports++; return true; };
        sb.fetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([1])]) });
        const options = { batchMode: true, askRestart: false, dependencyRequirements: face.dependencies,
            releaseInfo: { assets: [{ name: 'AUfemale.model_v9.0.0.zip', downloadUrl: 'https://example.com/au.zip' }] }, onFailure: reason => { failure = reason; } };
        assert.equal(await market.downloadAndInstallMod(au, 'ddlc', options), false, '文件名虚高但真实 boot 版本过低时必须阻止导入');
        assert.equal(imports, 0, '前置不满足时不能写入包体');
        assert.ok(failure.includes('0.6.6'), '错误应列出实际所需版本');
        actualBoot = { name: variants[0][0], version: variants[0][1] };
        assert.equal(await market.downloadAndInstallMod(au, 'ddlc', options), true, '真实主包达到对应版本后允许导入');
        assert.equal(imports, 1);
        au._matchedLocal = { name: variants[0][0], version: variants[0][2] };
        actualBoot = { name: variants[1][0], version: '0.4.2' };
        assert.equal(await market.downloadAndInstallMod(au, 'ddlc', options), false, '升级已有女体时即使文件名伪装成女体，也必须拒绝实际男体主包');
        assert.equal(imports, 1, '模型错配必须在导入前阻止');

        const manualHair = { ...hair, githubUrl: 'https://github.com/AOKIUTAGE/UTAGEsDOL3.0', sharedRepository: true };
        const prompts = [];
        sb.modHubEscapeHtml = value => String(value);
        let opened = 0;
        sb.open = () => { opened++; };
        sb.modHubConfirm = async options => { prompts.push(options); return false; };
        sb.fetch = async url => {
            if (String(url).includes('release-index.json')) return { ok: true, json: async () => ({ schemaVersion: 1, identities, mods: [au, face, manualHair] }) };
            if (String(url).includes('mod-identities.json')) return { ok: true, json: async () => ({ mods: identities }) };
            return { ok: true, json: async () => [{ tag_name: 'facemod', assets: [{ name: 'AUsDoL.facial.expansion.mod.zip', browser_download_url: `${face.githubUrl.replace('/tag/', '/download/')}/AUsDoL.facial.expansion.mod.zip` }] }] };
        };
        await market.loadMarketData(true);
        assert.equal(await market.promptDownloadMirrorAndInstall(manualHair), false, '取消手动下载前置确认必须停止安装');
        assert.ok(prompts.some(prompt => prompt.trustedMessageHtml?.includes('AU美化') && prompt.trustedMessageHtml?.includes('modhub-dep-item')), '无匹配自动发布的染发优化也必须先展示 AU 主包前置');
        assert.equal(opened, 0, '取消依赖确认不能先跳转下载页');
    }

    // 失效来源默认隐藏，偏好跨初始化保留；手动来源和无发布项不能误隐藏。
    {
        const sb = loadMarket();
        const elements = new Map(['modHubModMarketContainer', 'modHubMarketCardsContainer', 'modHubHideDeadSources', 'modHubDeadSourceCount', 'modHubCategoryCapsules'].map(id => [id, createStubElement()]));
        sb.document.getElementById = id => elements.get(id) || null;
        sb.modHubEscapeHtml = value => String(value);
        const mods = [
            { name: '有效来源测试', githubUrl: 'https://github.com/ModHubTests/Alive' },
            { name: '失效来源测试', githubUrl: 'https://github.com/Kanna-hanabi/WovenRealm' },
            { name: '手动来源测试', otherUrl: 'https://example.com/mod' },
            { name: '暂无发布测试', githubUrl: 'https://github.com/ModHubTests/NoRelease' }
        ];
        sb.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, mods }) });
        await sb.modHubInitMarket(true);
        const cards = () => elements.get('modHubMarketCardsContainer').innerHTML;
        assert.ok(!cards().includes('失效来源测试'), '市场默认隐藏确认失效的来源');
        for (const name of ['有效来源测试', '手动来源测试', '暂无发布测试']) assert.ok(cards().includes(name), `${name} 不应误隐藏`);
        assert.ok(elements.get('modHubModMarketContainer').innerHTML.includes('type="checkbox" checked>隐藏失效来源'), '开关默认勾选');
        assert.equal(elements.get('modHubDeadSourceCount').textContent, '（1）', '明确显示被隐藏的数量');
        assert.ok(elements.get('modHubCategoryCapsules').innerHTML.includes('全部分类（3）'), '分类数量应与可见来源一致');
        const toggle = elements.get('modHubHideDeadSources');
        toggle.checked = false;
        toggle.onchange();
        assert.ok(cards().includes('失效来源测试'), '关闭开关可重新查看失效条目');
        sb.modHubMarket.resetFilters();
        assert.ok(cards().includes('失效来源测试'), '清除分类和搜索不得覆盖来源偏好');
        loadScripts(sb, ['javascript/modhub-market.js']);
        await sb.modHubInitMarket();
        assert.ok(cards().includes('失效来源测试'), '重新初始化市场必须读取已保存的开关状态');
        toggle.checked = true;
        toggle.onchange();
        assert.ok(!cards().includes('失效来源测试'), '重新启用隐藏应立即更新卡片');
        sb.localStorage.getItem = () => { throw new Error('存储受限'); };
        sb.localStorage.setItem = () => { throw new Error('存储受限'); };
        loadScripts(sb, ['javascript/modhub-market.js']);
        await sb.modHubInitMarket(true);
        assert.ok(!cards().includes('失效来源测试'), '存储不可用仍默认隐藏且可正常初始化');
        toggle.checked = false;
        toggle.onchange();
        assert.ok(cards().includes('失效来源测试'), '存储不可用也应允许本次会话切换');
    }

};
