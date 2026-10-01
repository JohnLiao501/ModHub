// 还原面板 DOM 契约：精确说明、设置保存、预览委托与加载期只读交互。
const { assert, createBaseSandbox, createStubElement, loadScripts } = require('./helpers');

function documentMock() {
    function node(tag) {
        const value = createStubElement(tag);
        let text = '';
        Object.defineProperty(value, 'textContent', { get: () => text + value.children.map(child => child.textContent).join(''), set: next => { text = String(next); value.children.forEach(child => { child.parentNode = null; }); value.children = []; } });
        value.appendChild = child => { child.parentNode?.removeChild(child); value.children.push(child); child.parentNode = value; return child; };
        value.contains = child => value === child || value.children.some(node => node.contains(child));
        value.querySelectorAll = () => value.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A'].includes(child.tagName) || child.tabIndex !== undefined);
        value.getClientRects = () => [{ width: 100, height: 32 }];
        value.focus = () => { doc.activeElement = value; };
        Object.defineProperty(value, 'isConnected', { get: () => doc.body.contains(value) || doc.head.contains(value) });
        return value;
    }
    const listeners = new Map();
    const doc = { body: node('body'), head: node('head'), createElement: node, createTextNode: text => { const value = node('#text'); value.textContent = text; return value; },
        addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name),
        getElementById(id) { const find = value => value.id === id ? value : value.children.map(find).find(Boolean); return find(doc.body) || find(doc.head) || null; },
        listeners,
    };
    return doc;
}

function fixture(options = {}) {
    const document = documentMock();
    const calls = [];
    const state = { config: { autoCreate: true, maxPoints: 20 }, points: [
        { id: 'new', label: '更新之后', at: 2000, modCount: 3, kind: 'auto', protected: false },
        { id: 'first', label: '本轮首次操作前', at: 1000, modCount: 2, kind: 'auto', protected: true, summary: { installed: ['故障模组'], beautyChanged: true } },
    ], usageBytes: 2097152, protectedIds: ['first'], recommendedId: 'first', restoring: false };
    const api = {
        async getPanelState() { return structuredClone(state); },
        async saveConfig(config) { calls.push(['config', config]); state.config = structuredClone(config); return true; },
        async createPoint(label) { calls.push(['create', label]); state.points.unshift({ id: 'manual', label, at: 3000, modCount: 3, kind: 'manual', protected: false }); return 'manual'; },
        async deletePoints(ids) { calls.push(['delete', [...ids]]); state.points = state.points.filter(point => !ids.includes(point.id)); return true; },
        async preview(id) { calls.push(['preview', id]); return { id, label: state.points.find(point => point.id === id)?.label, changes: { updated: ['包体甲'], removed: ['故障模组'] }, riskMessages: ['游戏环境风险示例'], canRestore: options.canRestore !== false, reason: options.canRestore === false ? '包体已损坏' : undefined }; },
        async restore(id) { calls.push(['restore', id]); return options.restore === true; },
        mountDialog(dialog, startup) { calls.push(['mount', startup]); let host = document.getElementById('modHubRestoreStartupHost'); if (!host) { host = document.createElement('section'); host.id = 'modHubRestoreStartupHost'; document.body.appendChild(host); } host.appendChild(dialog.parentNode); },
    };
    const sandbox = createBaseSandbox({ document, modHubRestore: api, modHubConfirm: async () => options.discard === true });
    loadScripts(sandbox, ['javascript/modhub-restore-panel.js']);
    return { sandbox, document, calls, state, get: id => document.getElementById(id), open: opts => sandbox.modHubShowRestorePanel(opts) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const all = node => [node, ...node.children.flatMap(all)];

async function run() {
    const h = fixture();
    const opened = h.open(); await tick();
    const expected = '时间点还原会将游戏的模组状态还原到所选还原点。在该还原点之后所做的任何更改都将丢失，包括：模组安装、启用状态、加载顺序与美化配置。 还原不会影响ModHub和游戏存档。\n如果游戏因为模组加载遇到问题，甚至无法启动，可以选择一个还原点，然后将游戏还原到该状态。游戏将重启并恢复到捕获还原点时的状态。还原前会保存当前模组状态，方便需要时撤销此次还原。';
    assert.equal(h.get('modHubRestoreDescription').textContent, expected, '说明原文、单空格与两段换行精确保持');
    assert.equal(h.get('modHubRestoreDescription').children.filter(node => node.tagName === 'P').length, 2, '说明使用两个有间距的段落');
    const highlights = all(h.get('modHubRestoreDescription')).filter(node => node.tagName === 'STRONG');
    assert.deepEqual(highlights.map(node => [node.textContent, node.className]), [
        ['任何更改都将丢失', 'red'], ['模组安装、启用状态、加载顺序与美化配置', 'gold'], ['还原不会影响ModHub和游戏存档', 'green'], ['游戏将重启', 'gold'], ['还原前会保存当前模组状态', 'gold'],
    ]);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /max-width:720px/);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /grid-template-columns:1fr/);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /60px \+ env\(safe-area-inset-bottom\)/);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /padding:16px 16px calc\(60px \+ env\(safe-area-inset-bottom\)\)/, '外框底部保留 60px 视口安全区');
    assert.match(h.get('modHubRestorePanelStyle').textContent, /max-height:calc\(100dvh - 76px - env\(safe-area-inset-bottom\)\)/, '固定页脚不会贴近底部状态栏');
    for (const color of ['gold', 'red', 'green']) assert.ok(h.get('modHubRestorePanelStyle').textContent.includes(`color:var(--${color},`), '强调色复用原生变量');

    const auto = h.get('modHubRestoreAutoCreate'); auto.checked = false; auto.onchange();
    assert.equal(h.get('modHubRestorePanelNext').disabled, true, '未保存设置阻断下一步');
    await h.get('modHubRestorePanelNext').onclick();
    assert.equal(h.get('modHubRestorePanelTitle').textContent, '时间点还原');
    h.get('modHubRestoreUndoConfig').onclick();
    assert.equal(auto.checked, true); assert.equal(h.get('modHubRestorePanelNext').disabled, false);
    const limit = h.get('modHubRestoreMaxPoints'); limit.value = '5'; limit.onchange();
    await h.get('modHubRestoreSaveConfig').onclick();
    assert.deepEqual(h.state.config, { autoCreate: true, maxPoints: 5 });
    assert.equal(h.get('modHubRestorePanelNext').disabled, false, '只有保存成功后放行');
    assert.equal(h.get('modHubRestorePointName').maxLength, 80);
    assert.equal(h.get('modHubRestorePointName').value, '手动还原点', '默认名称严格符合约定');
    h.get('modHubRestorePointName').value = '甲'.repeat(100);
    await h.get('modHubRestoreCreatePoint').onclick();
    assert.equal(h.calls.find(call => call[0] === 'create')[1].length, 80);
    await h.get('modHubRestorePanelNext').onclick();
    assert.equal(h.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('安装：故障模组；美化配置调整'), '历史列表显示实际操作和涉及模组');
    h.get('modHubRestorePoint_new').onchange();
    await h.get('modHubRestoreDeletePoint').onclick();
    assert.ok(!h.state.points.some(point => point.id === 'new'));
    await h.get('modHubRestoreClearPoints').onclick();
    assert.deepEqual(h.calls.filter(call => call[0] === 'delete').at(-1)[1], ['manual'], '清理只向核心提交未受保护点');
    await h.get('modHubRestorePanelNext').onclick();
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('回退包体：包体甲'));
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('移除后来安装的模组：故障模组'));
    assert.deepEqual(h.calls.filter(call => call[0] === 'preview').at(-1), ['preview', 'first']);
    await h.get('modHubRestorePanelNext').onclick();
    assert.deepEqual(h.calls.at(-1), ['restore', 'first'], '最终提交仍调用引擎原有确认');
    assert.ok(h.get('modHubRestorePanel'), '取消引擎确认时保留预览');
    await h.get('modHubRestorePanelCancel').onclick(); assert.equal(await opened, false);

    const rescue = fixture(); const rescueOpened = rescue.open({ startup: true, reason: '加载没有进展' }); await tick();
    assert.equal(rescue.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.ok(rescue.get('modHubRestorePanelBody').textContent.includes('加载没有进展'));
    assert.equal(rescue.get('modHubRestorePoint_first').checked, true, '默认选择引擎推荐的本轮首点');
    for (const id of ['modHubRestoreAutoCreate', 'modHubRestoreSaveConfig', 'modHubRestoreCreatePoint', 'modHubRestoreDeletePoint', 'modHubRestoreClearPoints']) assert.equal(rescue.get(id), null, '救援面板没有设置或清理写入入口');
    assert.ok(rescue.calls.some(call => call[0] === 'mount' && call[1] === true), '救援面板复用核心加载层挂载');
    await rescue.get('modHubRestorePanelCancel').onclick(); assert.equal(await rescueOpened, false);

    const invalid = fixture({ canRestore: false }); const invalidOpened = invalid.open({ startup: true }); await tick();
    await invalid.get('modHubRestorePanelNext').onclick();
    assert.equal(invalid.get('modHubRestorePanelNext').disabled, true);
    assert.ok(invalid.get('modHubRestorePanelBody').textContent.includes('包体已损坏'));
    await invalid.get('modHubRestorePanelCancel').onclick(); await invalidOpened;

    const empty = fixture(); empty.state.points = []; const emptyOpened = empty.open({ startup: true }); await tick();
    assert.ok(empty.get('modHubRestoreEmpty')); assert.equal(empty.get('modHubRestorePanelNext').disabled, true);
    await empty.get('modHubRestorePanelCancel').onclick(); await emptyOpened;

    const keys = fixture();
    const trigger = keys.document.createElement('button'); keys.document.body.appendChild(trigger); trigger.focus();
    const keysOpened = keys.open(); await tick();
    const key = (name, target, shiftKey = false) => {
        let prevented = false;
        keys.document.listeners.get('keydown')({ key: name, target, shiftKey, preventDefault() { prevented = true; } });
        return prevented;
    };
    keys.get('modHubRestorePanelCancel').focus();
    assert.equal(key('Tab', keys.document.activeElement), true);
    assert.equal(keys.document.activeElement, keys.get('modHubRestorePanelClose'), 'Tab 末端回到面板首控件');
    assert.equal(key('Tab', keys.document.activeElement, true), true);
    assert.equal(keys.document.activeElement, keys.get('modHubRestorePanelCancel'), '反向 Tab 首端回到末控件');
    trigger.focus(); keys.document.listeners.get('focusin')({ target: trigger });
    assert.equal(keys.document.activeElement, keys.get('modHubRestorePanelNext'), '焦点不能落到遮罩下方');
    assert.equal(key('Enter', keys.get('modHubRestorePanelClose')), false, '关闭按钮保留原生 Enter 点击');
    assert.equal(keys.get('modHubRestorePanelTitle').textContent, '时间点还原');
    assert.equal(key('Enter', keys.get('modHubRestorePanelBody')), true, '非控件区域 Enter 执行主操作');
    await tick(); await keys.get('modHubRestorePanelNext').onclick();
    const previous = keys.get('modHubRestorePanelBack'); previous.focus();
    assert.equal(key('Enter', previous), false, '上一步按钮不会误触最终还原');
    await previous.onclick();
    assert.equal(keys.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.equal(key('Enter', keys.get('modHubRestorePanelCancel')), false, '取消按钮不会跳转下一步');
    await keys.get('modHubRestorePanelCancel').onclick(); assert.equal(await keysOpened, false);
    assert.equal(keys.document.activeElement, trigger, '关闭后恢复原入口焦点');
    assert.equal(keys.document.listeners.has('focusin'), false, '关闭后清理焦点约束');
    console.log('时间点还原面板说明、设置与救援交互测试通过');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
