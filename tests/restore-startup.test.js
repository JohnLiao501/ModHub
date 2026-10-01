// 加载救援按真实阶段计时；异常只显示入口，用户打开面板后才等待其选择。
const { assert, createStubElement } = require('./helpers');
const { harness } = require('./restore.test');

const successKey = 'modhub_restore_success_v1';
const pointKey = 'modhub_restore_points_v1';
const journalKey = 'modhub_restore_journal_v1';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function waitUntil(test) {
    for (let i = 0; i < 100 && !test(); i++) await nextTurn();
    assert.ok(test(), '异步提示应完成当前阶段');
}

async function restoredFixture(label = '验收还原点') {
    const h = harness();
    await h.api.startupReady;
    const id = await h.api.createPoint(label);
    h.mod.data.set('package-custom:A', new Uint8Array(Buffer.from('A 完成提示测试')));
    await h.api.restore(id);
    return h;
}

function ready(h) {
    h.sandbox.SugarCube = { State: { passage: '首界面' } };
    h.document.getElementById('init-screen').style.display = 'none';
}

async function successNotifications() {
    const saved = await restoredFixture('目标 <img src=x> & 测试');
    const notice = structuredClone(saved.mod.data.get(successKey));
    ready(saved);
    await saved.intervals[0]();
    assert.ok(!saved.dialogs.some(item => item.title === '时间点还原已成功完成'), '还原后旧首屏不提前显示启动成功');
    let closeNotice;
    const next = harness({ mod: saved.mod, beauty: saved.beauty, storage: saved.storage, progressLog: true, confirm: opts => opts.title === '时间点还原已成功完成' ? new Promise(resolve => { closeNotice = resolve; }) : false });
    await next.api.startupReady;
    assert.equal(next.dialogs.length, 0, '读取完成记录不阻塞早期加载或自动提前弹窗');
    await next.hooks.get('modHubRestore').Load_start('普通模组', '后续脚本.js');
    next.sandbox.SugarCube = { State: { passage: '首界面' } };
    await next.intervals[0]();
    assert.equal(next.dialogs.length, 0, '段落存在但遮罩尚未关闭不显示成功');
    ready(next);
    await next.intervals[0]();
    assert.equal(next.dialogs.length, 0, '独立可见的加载日志层仍是遮罩');
    const log = next.document.getElementById('LoadingProgressLog');
    log.parentNode.removeChild(log);
    next.document.getElementById('init-screen').appendChild(log);
    const modal = createStubElement('div');
    next.document.querySelector = selector => selector.includes('modhub-modal-backdrop') ? modal : null;
    await next.intervals[0]();
    assert.equal(next.dialogs.length, 0, '等待已有模态窗口关闭');
    assert.equal(next.mod.data.has(successKey), true, '等待窗口时不消费完成记录');
    next.document.querySelector = () => null;
    const prompting = next.intervals[0]();
    await waitUntil(() => !!closeNotice);
    const shown = next.dialogs.at(-1);
    assert.equal(shown.title, '时间点还原已成功完成', '父加载遮罩隐藏后子日志display仍block不阻碍完成');
    assert.equal(shown.confirmText, '关闭');
    assert.equal(shown.cancelText, '');
    assert.ok(shown.message.includes('游戏存档未受影响'));
    assert.ok(shown.message.includes('还原前状态'));
    assert.ok(shown.trustedMessageHtml.includes('&lt;img src=x&gt; &amp; 测试'));
    assert.ok(shown.trustedMessageHtml.includes('class="green">时间点还原已成功完成'));
    assert.ok(!shown.trustedMessageHtml.includes('<img'));
    assert.ok(next.mod.data.has(successKey), '用户关闭之前记录仍在');
    await next.intervals[0]();
    assert.equal(next.dialogs.length, 1, '轮询期间同页不重复弹成功提示');
    closeNotice(false);
    await prompting;
    assert.equal(next.mod.data.has(successKey), false, '关闭或取消按钮均原子消费已展示通知');
    assert.equal(next.reloads(), 0, '完成提示不再次重启');
    await next.intervals[0]();
    assert.equal(next.dialogs.length, 1);
    const again = harness({ mod: next.mod, beauty: next.beauty, storage: next.storage });
    await again.api.startupReady;
    ready(again); await again.intervals[0]();
    assert.equal(again.dialogs.length, 0, '刷新已消费的通知不再弹出');

    const retrySaved = await restoredFixture();
    const ackRetry = harness({ mod: retrySaved.mod, beauty: retrySaved.beauty, storage: retrySaved.storage });
    await ackRetry.api.startupReady;
    ready(ackRetry);
    ackRetry.mod.failDelete = key => key === successKey ? new Error('消费通知事务失败') : null;
    await ackRetry.intervals[0]();
    assert.equal(ackRetry.dialogs.length, 1);
    assert.ok(ackRetry.mod.data.has(successKey), '消费事务失败保留完成通知');
    ackRetry.mod.failDelete = null;
    await ackRetry.intervals[0]();
    assert.equal(ackRetry.dialogs.length, 1, '本页重试消费不再次打断用户');
    assert.equal(ackRetry.mod.data.has(successKey), false);

    const parallelSaved = await restoredFixture();
    let closeFirstWindow;
    const firstWindow = harness({ mod: parallelSaved.mod, beauty: parallelSaved.beauty, storage: parallelSaved.storage, confirm: () => new Promise(resolve => { closeFirstWindow = resolve; }) });
    await firstWindow.api.startupReady;
    ready(firstWindow);
    const firstPrompt = firstWindow.intervals[0]();
    await waitUntil(() => !!closeFirstWindow);
    const secondWindow = harness({ mod: firstWindow.mod, beauty: firstWindow.beauty, storage: firstWindow.storage });
    await secondWindow.api.startupReady;
    ready(secondWindow); await secondWindow.intervals[0]();
    await secondWindow.hooks.get('modHubRestore').Load_start('普通模组', '继续加载.js');
    assert.equal(secondWindow.dialogs.length, 0, '同仓库的另一页面等待已有完成提示，正常加载不被提示锁阻塞');
    closeFirstWindow(true); await firstPrompt;
    await secondWindow.intervals[0]();
    assert.equal(secondWindow.dialogs.length, 0, '另一页面关闭消费后本页面不再重复显示');

    const racedSaved = await restoredFixture();
    let closeRace;
    const race = harness({ mod: racedSaved.mod, beauty: racedSaved.beauty, storage: racedSaved.storage, confirm: () => new Promise(resolve => { closeRace = resolve; }) });
    await race.api.startupReady;
    ready(race);
    const racedPrompt = race.intervals[0]();
    await waitUntil(() => !!closeRace);
    const replacement = { ...structuredClone(race.mod.data.get(successKey)), id: '另一页面的新完成记录', label: '另一次还原' };
    race.mod.data.set(successKey, replacement);
    closeRace(true); await racedPrompt;
    assert.deepEqual(race.mod.data.get(successKey), replacement, '关闭旧提示不能删除其他页面后来写入的完成记录');

    const expiredSaved = await restoredFixture();
    expiredSaved.mod.data.set(pointKey, expiredSaved.mod.data.get(pointKey).filter(point => point.id !== expiredSaved.mod.data.get(successKey).safetyPointId));
    const expired = harness({ mod: expiredSaved.mod, beauty: expiredSaved.beauty, storage: expiredSaved.storage });
    await expired.api.startupReady;
    ready(expired); await expired.intervals[0]();
    assert.ok(!expired.dialogs.at(-1).message.includes('撤销此次还原'), '还原前状态不存在时不能承诺撤销');

    const legacy = harness();
    await legacy.api.startupReady;
    const legacyId = await legacy.api.createPoint('旧恢复');
    legacy.mod.data.set('package-custom:A', new Uint8Array(Buffer.from('A 旧记录测试')));
    legacy.mod.failPut = key => key === successKey ? new Error('模拟旧版中断') : null;
    await assert.rejects(legacy.api.restore(legacyId), /模拟旧版中断/);
    const journal = legacy.mod.data.get(journalKey);
    delete journal.pointId; delete journal.pointLabel; delete journal.pointAt; delete journal.safetyPointId;
    legacy.mod.failPut = null;
    legacy.mod.lockRegistry.clear();
    const replay = harness({ mod: legacy.mod, beauty: legacy.beauty, storage: legacy.storage });
    await replay.api.startupReady;
    assert.equal(replay.reloads(), 1);
    assert.equal(replay.mod.data.get(successKey).at, null, '缺失旧目标时间不冒充当前时间');
    const legacyNotice = harness({ mod: replay.mod, beauty: replay.beauty, storage: replay.storage });
    await legacyNotice.api.startupReady;
    ready(legacyNotice); await legacyNotice.intervals[0]();
    assert.ok(legacyNotice.dialogs.at(-1).message.includes('所选还原点'));
    assert.ok(!legacyNotice.dialogs.at(-1).message.includes('时间未记录'));
    assert.ok(!legacyNotice.dialogs.at(-1).message.includes('撤销此次还原'));

    const unrelated = harness();
    await unrelated.api.startupReady;
    ready(unrelated); await unrelated.intervals[0]();
    assert.equal(unrelated.dialogs.length, 0, '其他加载器存储身份的完成记录不会重放到本仓库');
    assert.ok(notice.at && notice.safetyPointId);
    console.log('还原完成通知的启动门槛、一次消费、失败重试与旧记录兼容测试通过');
}

async function run() {
    let clock = 0;
    let closePanel;
    const panelCalls = [];
    const h = harness({ performance: { now: () => clock }, panel: options => { panelCalls.push(options); return new Promise(resolve => { closePanel = resolve; }); } });
    await h.api.startupReady;
    const button = h.document.getElementById('modHubRestoreStartupButton');
    const hook = h.hooks.get('modHubRestore');
    assert.equal(button.textContent, '加载遇到问题？尝试时间点恢复');
    assert.equal(button.style.display, 'none', '正常加载不展示恢复按钮');
    await hook.Load_start('A', 'a.js');
    clock = 30000; hook.logWarning('不断重复的警告');
    clock = 59000; hook.logWarning('不断重复的警告');
    clock = 61000; await h.intervals[0]();
    assert.equal(button.style.display, '', '警告日志不能重置真实阶段进度计时');
    assert.equal(panelCalls.length, 0, '异常入口出现时不自动打开面板');
    assert.ok(h.document.getElementById('modHubRestoreStartupReason').textContent.includes('60 秒'));
    let completed = false;
    await hook.Load_end('A', 'a.js');
    assert.equal(h.api.isRestoring(), false, '显示异常按钮不触发恢复或暂停');
    const panelPromise = button.onclick();
    const loading = hook.Load_start('B', 'b.js').then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panelCalls.length, 1);
    assert.equal(panelCalls[0].startup, true);
    assert.equal(completed, false, '用户打开面板后后续脚本 hook 才暂停');
    closePanel(false); await panelPromise; await loading;
    assert.equal(completed, true, '取消救援面板后继续加载');
    assert.equal(h.reloads(), 0);

    let stageClock = 0;
    const progress = harness({ performance: { now: () => stageClock } });
    await progress.api.startupReady;
    const progressHook = progress.hooks.get('modHubRestore');
    stageClock = 59000; await progressHook.Load_start('A', '真实新阶段.js');
    stageClock = 118000; await progress.intervals[0]();
    assert.equal(progress.document.getElementById('modHubRestoreStartupButton').style.display, 'none', '真实新阶段更新无进展计时');
    await progressHook.Load_start('A', '真实新阶段.js');
    stageClock = 120000; await progress.intervals[0]();
    assert.equal(progress.document.getElementById('modHubRestoreStartupButton').style.display, '', '相同阶段重复通知不伪造进展');

    const cached = [{ type: 'error', message: '注册前的加载异常', time: new Date(1000) }];
    const previous = harness({ cachedLogs: cached });
    await previous.api.startupReady;
    assert.equal(cached.length, 1, '只读采集已有错误，不重新写入上游缓存');
    assert.equal(previous.api.getStartupLogs()[0].message, '注册前的加载异常');
    assert.equal(previous.document.getElementById('modHubRestoreStartupButton').style.display, '');
    assert.equal(previous.dialogs.length, 0, '旧缓存错误不自动弹窗');
    const retry = harness({ mod: previous.mod, beauty: previous.beauty, storage: previous.storage });
    await retry.api.startupReady;
    assert.equal(retry.document.getElementById('modHubRestoreStartupButton').style.display, '', '上次未完成即使无还原点也显示说明入口');
    assert.equal(retry.dialogs.length, 0);
    retry.sandbox.SugarCube = { State: { passage: '首界面' } };
    retry.sandbox.getComputedStyle = () => ({ display: 'none' });
    await retry.intervals[0]();
    assert.equal(retry.document.getElementById('modHubRestoreStartupButton'), null, '正式首屏就绪后移除异常入口');
    await successNotifications();
    console.log('启动异常入口、单调阶段计时与手动暂停测试通过');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
