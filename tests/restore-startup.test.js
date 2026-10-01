// 加载救援按真实阶段计时；异常只显示入口，用户打开面板后才等待其选择。
const { assert } = require('./helpers');
const { harness } = require('./restore.test');

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
    console.log('启动异常入口、单调阶段计时与手动暂停测试通过');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
