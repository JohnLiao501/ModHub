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
        const attributes = new Map();
        value.setAttribute = (name, text) => attributes.set(name, String(text));
        value.getAttribute = name => attributes.get(name) ?? null;
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
        { id: 'new', label: '更新之后', at: 2000, modCount: 3, kind: 'auto', protected: false, userProtected: false, systemProtected: false, protectionReasons: [] },
        { id: 'first', label: '本轮首次操作前', at: 1000, modCount: 2, kind: 'auto', protected: true, userProtected: false, systemProtected: true, protectionReasons: ['本轮首次操作前状态待启动验证'], summary: { installed: ['故障模组'], beautyChanged: true } },
    ], usageBytes: 2097152, protectedIds: ['first'], recommendedId: 'first', restoring: false };
    const api = {
        async getPanelState() { return structuredClone(state); },
        async saveConfig(config) { calls.push(['config', config]); state.config = structuredClone(config); return true; },
        async createPoint(label) { calls.push(['create', label]); state.points.unshift({ id: 'manual', label, at: 3000, modCount: 3, kind: 'manual', protected: false }); return 'manual'; },
        async deletePoints(ids) { calls.push(['delete', [...ids]]); state.points = state.points.filter(point => !ids.includes(point.id)); return true; },
        async setPointProtection(id, enabled) {
            calls.push(['protect', id, enabled]);
            if (options.protectionFailure) throw new Error('保护设置事务失败');
            const point = state.points.find(point => point.id === id);
            point.userProtected = enabled;
            point.protected = enabled || point.systemProtected;
            point.protectionReasons = [...(enabled ? ['手动保护'] : []), ...(point.systemProtected ? ['本轮首次操作前状态待启动验证'] : [])];
            return true;
        },
        async preview(id) { calls.push(['preview', id]); return { id, label: state.points.find(point => point.id === id)?.label, changes: options.changes || { updated: ['包体甲'], removed: ['故障模组'] }, packageVersions: options.packageVersions, riskMessages: options.riskMessages || ['游戏环境风险示例'], canRestore: options.canRestore !== false, reason: options.canRestore === false ? '包体已损坏' : undefined }; },
        async restore(id) { calls.push(['restore', id]); return options.restore === true; },
        mountDialog(dialog, startup) { calls.push(['mount', startup]); let host = document.getElementById('modHubRestoreStartupHost'); if (!host) { host = document.createElement('section'); host.id = 'modHubRestoreStartupHost'; document.body.appendChild(host); } host.appendChild(dialog.parentNode); },
    };
    const sandbox = createBaseSandbox({ document, modHubRestore: api, modHubConfirm: async () => options.discard === true });
    loadScripts(sandbox, ['javascript/modhub-restore-panel.js']);
    return { sandbox, document, calls, state, get: id => document.getElementById(id), open: opts => sandbox.modHubShowRestorePanel(opts) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const all = node => [node, ...node.children.flatMap(all)];
const selectPoint = (fixture, id) => { const radio = fixture.get(`modHubRestorePoint_${id}`); radio.checked = true; radio.onchange(); };

async function run() {
    const h = fixture();
    const opened = h.open(); await tick();
    assert.equal(h.get('modHubRestorePanelClose').textContent, '×', '右上角使用现有弹窗叉号');
    assert.equal(h.get('modHubRestorePanelClose').className, 'modhub-modal-close');
    assert.equal(h.get('modHubRestorePanelClose').getAttribute('aria-label'), '关闭', '图形关闭按钮保留无障碍名称');
    const expected = '时间点还原会将游戏的模组状态还原到所选还原点。在该还原点之后所做的任何更改都将丢失，包括：模组安装、启用状态、加载顺序与美化配置。 还原不会影响ModHub和游戏存档。\n如果游戏因为模组加载遇到问题，甚至无法启动，可以选择一个还原点，然后将游戏还原到该状态。游戏将重启并恢复到捕获还原点时的状态。还原前会保存当前模组状态，方便需要时撤销此次还原。';
    assert.equal(h.get('modHubRestoreDescription').textContent, expected, '说明原文、单空格与两段换行精确保持');
    assert.equal(h.get('modHubRestoreDescription').children.filter(node => node.tagName === 'P').length, 2, '说明使用两个有间距的段落');
    const highlights = all(h.get('modHubRestoreDescription')).filter(node => node.tagName === 'STRONG');
    assert.deepEqual(highlights.map(node => [node.textContent, node.className]), [
        ['任何更改都将丢失', 'red'], ['模组安装、启用状态、加载顺序与美化配置', 'gold'], ['还原不会影响ModHub和游戏存档', 'green'], ['游戏将重启', 'gold'], ['还原前会保存当前模组状态', 'gold'],
    ]);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /max-width:720px/);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /grid-template-columns:1fr/);
    const panelButtonStyle = h.get('modHubRestorePanelStyle').textContent.match(/\.modhub-restore-panel button:not\(\.modhub-modal-close\)\{([^}]+)\}/)?.[1] || '';
    for (const rule of ['box-sizing:border-box', 'min-width:0!important', 'max-width:100%', 'height:auto!important', 'white-space:normal!important', 'overflow-wrap:anywhere', 'line-height:1.4!important']) {
        assert.ok(panelButtonStyle.includes(rule), `面板长按钮必须完整换行，且不改变关闭按钮：${rule}`);
    }
    assert.match(h.get('modHubRestorePanelStyle').textContent, /\.modhub-restore-panel button\{[^}]*min-height:32px/, '面板操作保留最小触控高度');
    const radioFocusStyle = h.get('modHubRestorePanelStyle').textContent.match(/\.modhub-restore-panel-point input(?:\[type=(?:radio|"radio"|'radio')\])?:focus\{([^}]+)\}/)?.[1] || '';
    assert.match(radioFocusStyle, /outline:none(?:!important)?/, '单选焦点不显示游戏原有虚线轮廓');
    assert.match(radioFocusStyle, /box-shadow:none(?:!important)?/, '单选焦点不显示游戏原有阴影');
    assert.match(h.get('modHubRestorePanelStyle').textContent, /point:focus-within[^}]*border-color:var\(--gold/, '键盘焦点仍通过整行金色边框显示');
    assert.match(h.get('modHubRestorePanelStyle').textContent, /60px \+ env\(safe-area-inset-bottom\)/);
    assert.match(h.get('modHubRestorePanelStyle').textContent, /padding:16px 16px calc\(60px \+ env\(safe-area-inset-bottom\)\)/, '外框底部保留 60px 视口安全区');
    assert.match(h.get('modHubRestorePanelStyle').textContent, /max-height:calc\(100dvh - 76px - env\(safe-area-inset-bottom\)\)/, '固定页脚不会贴近底部状态栏');
    for (const color of ['gold', 'red', 'green']) assert.ok(h.get('modHubRestorePanelStyle').textContent.includes(`color:var(--${color},`), '强调色复用原生变量');
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('保留上限只限制普通历史，受保护点额外保留'), '明确普通历史配额与额外保护点');

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
    const pointInstructions = h.get('modHubRestorePanelBody').children.find(node => node.textContent === '选择一个还原点。可先扫描受影响的模组，或选择“下一步”确认还原。');
    assert.ok(pointInstructions && !h.get('modHubRestorePointList').contains(pointInstructions), '选点操作说明固定显示在历史列表外');
    const firstInfo = h.get('modHubRestorePoint_first').parentNode.children[1];
    assert.equal(firstInfo.children[0].tagName, 'STRONG', '还原点描述作为主标题显示');
    assert.equal(firstInfo.children[0].textContent, '本轮首次操作前');
    const pointFields = firstInfo.children.find(node => node.className === 'modhub-restore-panel-point-fields');
    assert.deepEqual(pointFields.children.map(field => field.children.map(node => node.textContent)), [
        ['创建时间', new Date(1000).toLocaleString('zh-CN', { hour12: false })], ['类型', '自动创建'], ['包含模组', '2 个'],
    ], '创建时间保留用户本地时间，类型和模组数量使用独立字段');
    assert.ok(pointFields.children.every(field => field.children[0].tagName === 'SMALL' && field.children[1].tagName === 'SPAN'), '字段名使用次要文字，字段值独立显示');
    assert.ok(firstInfo.textContent.includes('相关操作：安装：故障模组；美化配置调整'), '操作摘要与创建点描述区分');
    assert.equal(h.get('modHubRestorePoint_manual').parentNode.children[1].children.find(node => node.className === 'modhub-restore-panel-point-fields').children[1].children[1].textContent, '手动创建', '手动创建点明确显示类型');
    assert.equal(h.get('modHubRestorePanelNext').disabled, true, '手动建点不会隐式选择新点');
    selectPoint(h, 'new');
    await h.get('modHubRestoreDeletePoint').onclick();
    assert.ok(!h.state.points.some(point => point.id === 'new'));
    for (const id of ['modHubRestoreProtectPoint', 'modHubRestoreDeletePoint', 'modHubRestoreScanPoint', 'modHubRestorePanelNext']) assert.equal(h.get(id).disabled, true, '删除所选点后不改选其他点');
    await h.get('modHubRestoreClearPoints').onclick();
    assert.deepEqual(h.calls.filter(call => call[0] === 'delete').at(-1)[1], ['manual'], '清理只向核心提交未受保护点');
    selectPoint(h, 'first');
    await h.get('modHubRestoreScanPoint').onclick();
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('回退包体：包体甲'));
    assert.ok(h.get('modHubRestorePanelBody').textContent.includes('移除后来安装的模组：故障模组'));
    assert.deepEqual(h.calls.filter(call => call[0] === 'preview').at(-1), ['preview', 'first']);
    await h.get('modHubRestorePanelBack').onclick();
    await h.get('modHubRestorePanelNext').onclick();
    assert.equal(h.get('modHubRestorePanelTitle').textContent, '确认还原点与变更');
    await h.get('modHubRestorePanelNext').onclick();
    assert.deepEqual(h.calls.at(-1), ['restore', 'first'], '最终提交仍调用引擎原有确认');
    assert.ok(h.get('modHubRestorePanel'), '取消引擎确认时保留预览');
    await h.get('modHubRestorePanelCancel').onclick(); assert.equal(await opened, false);

    const protection = fixture(); const protectionOpened = protection.open(); await tick();
    await protection.get('modHubRestorePanelNext').onclick();
    selectPoint(protection, 'new');
    await protection.get('modHubRestoreProtectPoint').onclick();
    assert.deepEqual(protection.calls.at(-1), ['protect', 'new', true]);
    assert.equal(protection.get('modHubRestoreProtectPoint').textContent, '取消手动保护');
    assert.equal(protection.get('modHubRestoreDeletePoint').disabled, true);
    const manualProtection = all(protection.get('modHubRestorePoint_new').parentNode).find(node => node.className === 'modhub-restore-panel-protection');
    assert.deepEqual(manualProtection.children.map(node => [node.tagName, node.textContent, node.className]), [
        ['STRONG', '手动保护', 'gold'], ['SMALL', '此还原点已设为保留，不会自动清理。可使用“取消手动保护”解除此项保护。', 'grey'],
    ], '手动保护使用明确标题和解除方式');
    assert.equal(protection.get('modHubRestoreClearPoints').disabled, true, '全部点受保护时不能清理');
    await protection.get('modHubRestoreProtectPoint').onclick();
    assert.equal(protection.get('modHubRestoreDeletePoint').disabled, false);
    assert.ok(protection.get('modHubRestorePanelStatus').textContent.includes('参与后续普通历史清理'));
    selectPoint(protection, 'first');
    await protection.get('modHubRestoreProtectPoint').onclick();
    const firstProtections = all(protection.get('modHubRestorePoint_first').parentNode).filter(node => node.className === 'modhub-restore-panel-protection');
    assert.deepEqual(firstProtections.map(node => node.children[0].textContent), ['手动保护', '系统保护'], '手动与系统保护原因分别显示');
    assert.deepEqual(firstProtections[1].children.map(node => [node.tagName, node.textContent, node.className]), [
        ['STRONG', '系统保护', 'gold'], ['SMALL', '此还原点保留了本次模组调整前的状态。重新载入并成功进入游戏后，系统将自动解除此保护。', 'grey'],
    ], '系统保护说明保留目的和自动解除条件');
    await protection.get('modHubRestoreProtectPoint').onclick();
    assert.equal(protection.get('modHubRestoreDeletePoint').disabled, true, '取消手动保护不能解除系统保护');
    assert.ok(protection.get('modHubRestorePanelStatus').textContent.includes('仍受系统保护'));
    await protection.get('modHubRestorePanelCancel').onclick(); await protectionOpened;

    const reasonCases = fixture();
    reasonCases.state.points = [{ id: 'pending', label: '还原前状态', at: 3000, modCount: 2, kind: 'preRestore', protected: true, userProtected: false, systemProtected: true, protectionReasons: ['未完成还原引用的状态', '<img src=x onerror=alert(1)>'] }];
    const reasonOpened = reasonCases.open({ startup: true }); await tick();
    const pendingInfo = reasonCases.get('modHubRestorePoint_pending').parentNode.children[1];
    assert.equal(pendingInfo.children.find(node => node.className === 'modhub-restore-panel-point-fields').children[1].children[1].textContent, '还原前状态', '还原前保护点明确显示类型');
    const pendingReasons = all(pendingInfo).filter(node => node.className === 'modhub-restore-panel-protection');
    assert.deepEqual(pendingReasons[0].children.map(node => [node.tagName, node.textContent, node.className]), [
        ['STRONG', '还原未完成', 'gold'], ['SMALL', '此还原点正用于完成尚未结束的还原。还原完成后，系统将自动解除此保护。', 'grey'],
    ], '未完成还原说明正在使用的用途和解除条件');
    assert.ok(pendingReasons[1].textContent.includes('<img src=x onerror=alert(1)>'), '未知保护原因保留为普通文本');
    assert.equal(all(pendingInfo).some(node => node.tagName === 'IMG'), false, '保护原因不作为 HTML 插入');
    await reasonCases.get('modHubRestorePanelCancel').onclick(); await reasonOpened;

    const failedProtection = fixture({ protectionFailure: true }); const failedOpened = failedProtection.open(); await tick();
    await failedProtection.get('modHubRestorePanelNext').onclick(); selectPoint(failedProtection, 'new');
    await failedProtection.get('modHubRestoreProtectPoint').onclick();
    assert.equal(failedProtection.get('modHubRestoreProtectPoint').textContent, '保护所选还原点', '失败时不假装已保护');
    assert.ok(failedProtection.get('modHubRestorePanelStatus').textContent.includes('保护设置事务失败'));
    await failedProtection.get('modHubRestorePanelCancel').onclick(); await failedOpened;

    const explicit = fixture(); const explicitOpened = explicit.open(); await tick();
    await explicit.get('modHubRestorePanelNext').onclick();
    const selectionButtons = ['modHubRestoreProtectPoint', 'modHubRestoreDeletePoint', 'modHubRestoreScanPoint', 'modHubRestorePanelNext'];
    const noSelection = () => {
        selectionButtons.forEach(id => assert.equal(explicit.get(id).disabled, true, '未明确选点时禁用目标操作'));
        assert.ok(all(explicit.get('modHubRestorePointList')).filter(node => node.type === 'radio').every(node => !node.checked));
    };
    noSelection();
    const untouched = explicit.calls.length;
    for (const id of selectionButtons) await explicit.get(id).onclick();
    assert.equal(explicit.calls.length, untouched, '直接调用未选点按钮也不会写入或预览');
    let dateGroup = explicit.get('modHubRestorePointList').children[0];
    dateGroup.open = false; dateGroup.ontoggle();
    dateGroup.open = true; dateGroup.ontoggle();
    noSelection();
    explicit.get('modHubRestorePoint_new').onchange();
    noSelection();
    selectPoint(explicit, 'new');
    selectionButtons.forEach(id => assert.equal(explicit.get(id).disabled, false, '显式选中普通点后启用目标操作'));
    const staleProtect = explicit.get('modHubRestoreProtectPoint'), staleDelete = explicit.get('modHubRestoreDeletePoint'), staleScan = explicit.get('modHubRestoreScanPoint');
    dateGroup = explicit.get('modHubRestorePointList').children[0]; dateGroup.open = false;
    for (const id of selectionButtons) await explicit.get(id).onclick();
    assert.equal(explicit.calls.length, untouched, '原生 toggle 尚未派发时也不能操作已隐藏的目标');
    dateGroup.ontoggle(); noSelection();
    assert.equal(explicit.document.activeElement, explicit.get('modHubRestorePointList').children[0].children[0], '折叠所选组后焦点保留在日期标题');
    await staleProtect.onclick(); await staleDelete.onclick(); await staleScan.onclick();
    assert.equal(explicit.calls.length, untouched, '旧按钮引用不能操作已清空的目标');
    dateGroup = explicit.get('modHubRestorePointList').children[0];
    selectPoint(explicit, 'new');
    selectionButtons.forEach(id => assert.equal(explicit.get(id).disabled, true, '隐藏条目的 change 不能选择目标'));
    explicit.get('modHubRestorePoint_new').checked = false;
    dateGroup.open = true; dateGroup.ontoggle(); noSelection();
    selectPoint(explicit, 'new'); await explicit.get('modHubRestoreProtectPoint').onclick();
    assert.deepEqual(explicit.calls.at(-1), ['protect', 'new', true], '重新显式选点后只保护该点');
    selectPoint(explicit, 'first');
    explicit.state.points = explicit.state.points.filter(point => point.id !== 'first');
    await explicit.get('modHubRestorePanelBack').onclick();
    await explicit.get('modHubRestoreCreatePoint').onclick();
    await explicit.get('modHubRestorePanelNext').onclick();
    noSelection();
    await explicit.get('modHubRestorePanelCancel').onclick(); await explicitOpened;

    const rescue = fixture(); const rescueOpened = rescue.open({ startup: true, reason: '加载没有进展' }); await tick();
    assert.equal(rescue.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.ok(rescue.get('modHubRestorePanelBody').textContent.includes('加载没有进展'));
    assert.equal(rescue.get('modHubRestorePoint_first').checked, false, '救援入口也须由用户明确选点');
    assert.equal(rescue.get('modHubRestorePanelNext').disabled, true);
    assert.equal(rescue.get('modHubRestoreScanPoint').disabled, true, '救援面板未选点时也不能扫描');
    await rescue.get('modHubRestorePanelNext').onclick();
    await rescue.get('modHubRestoreScanPoint').onclick();
    assert.equal(rescue.calls.some(call => call[0] === 'preview'), false, '未选点时不能查看还原目标');
    for (const id of ['modHubRestoreAutoCreate', 'modHubRestoreSaveConfig', 'modHubRestoreCreatePoint', 'modHubRestoreProtectPoint', 'modHubRestoreDeletePoint', 'modHubRestoreClearPoints']) assert.equal(rescue.get(id), null, '救援面板没有设置、保护或清理写入入口');
    assert.ok(rescue.calls.some(call => call[0] === 'mount' && call[1] === true), '救援面板复用核心加载层挂载');
    selectPoint(rescue, 'first'); await rescue.get('modHubRestoreScanPoint').onclick();
    assert.equal(rescue.get('modHubRestorePanelTitle').textContent, '受影响的模组', '救援模式允许按需查看扫描结果');
    await rescue.get('modHubRestorePanelCancel').onclick();
    assert.equal(rescue.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.equal(rescue.get('modHubRestorePoint_first').checked, true, '关闭救援扫描保留显式选择');
    assert.equal(rescue.calls.some(call => ['config', 'create', 'delete', 'protect', 'restore'].includes(call[0])), false, '扫描不写入历史或执行还原');
    await rescue.get('modHubRestorePanelCancel').onclick(); assert.equal(await rescueOpened, false);

    const invalid = fixture({ canRestore: false, changes: {} }); const invalidOpened = invalid.open({ startup: true }); await tick();
    selectPoint(invalid, 'first');
    await invalid.get('modHubRestorePanelNext').onclick();
    assert.equal(invalid.get('modHubRestorePanelNext').disabled, true);
    assert.ok(invalid.get('modHubRestorePanelBody').textContent.includes('包体已损坏'));
    await invalid.get('modHubRestoreScanPoint').onclick();
    assert.equal(invalid.get('modHubRestorePanelTitle').textContent, '受影响的模组', '无法还原的点仍允许查看扫描原因');
    assert.ok(invalid.get('modHubRestorePanelBody').textContent.includes('包体已损坏'));
    assert.equal(invalid.get('modHubRestorePanelBody').textContent.includes('目标与当前模组状态一致'), false, '无法还原时不声称状态一致');
    await invalid.get('modHubRestorePanelCancel').onclick();
    assert.equal(invalid.get('modHubRestorePanelTitle').textContent, '确认还原点与变更');
    assert.equal(invalid.get('modHubRestorePanelNext').disabled, true, '查看扫描不会解除无法还原的限制');
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
    await tick();
    assert.equal(key('Enter', keys.get('modHubRestorePanelBody')), false, '未选点时 Enter 不跳过选择');
    selectPoint(keys, 'first'); await keys.get('modHubRestorePanelNext').onclick();
    assert.equal(keys.get('modHubRestorePanelTitle').textContent, '确认还原点与变更', '不扫描也可直接进入确认页');
    assert.equal(keys.get('modHubRestoreChangeList'), null, '下一步不强制显示完整扫描名单');
    assert.ok(keys.get('modHubRestoreSummaryList'), '确认页显示还原影响摘要');
    const previous = keys.get('modHubRestorePanelBack'); previous.focus();
    assert.equal(key('Enter', previous), false, '上一步按钮不会误触最终还原');
    await previous.onclick();
    assert.equal(keys.get('modHubRestorePanelTitle').textContent, '选择还原点');
    assert.equal(key('Enter', keys.get('modHubRestorePanelCancel')), false, '取消按钮不会跳转下一步');
    await keys.get('modHubRestorePanelCancel').onclick(); assert.equal(await keysOpened, false);
    assert.equal(keys.document.activeElement, trigger, '关闭后恢复原入口焦点');
    assert.equal(keys.document.listeners.has('focusin'), false, '关闭后清理焦点约束');

    const dates = fixture();
    dates.state.points = [
        { id: 'sameA', label: '同日第一轮', at: new Date(2026, 9, 1, 10).getTime(), roundId: 'roundA', modCount: 1 },
        { id: 'latest', label: '次日变更', at: new Date(2026, 9, 2, 9).getTime(), roundId: 'roundA', modCount: 2 },
        { id: 'sameB', label: '同日第二轮', at: new Date(2026, 9, 1, 16).getTime(), roundId: 'roundB', modCount: 2 },
        { id: 'old', label: '前一日变更', at: new Date(2026, 8, 30, 22).getTime(), roundId: 'roundB', modCount: 1 },
    ];
    dates.state.recommendedId = 'sameA';
    const dateOpened = dates.open(); await tick(); await dates.get('modHubRestorePanelNext').onclick();
    const groups = () => dates.get('modHubRestorePointList').children;
    assert.deepEqual(groups().map(group => group.children[0].children[0].textContent), ['2026/10/2 · 1个还原点', '2026/10/1 · 2个还原点', '2026/9/30 · 1个还原点'], '按本地日期跨操作轮次合并，按最新日期排列，标题不含起始时间');
    assert.equal(groups()[0].open, true, '最新日期默认展开');
    assert.equal(groups()[1].open, true, '推荐日期默认展开但不自动选点');
    assert.equal(groups()[2].open, false, '其他日期默认收起');
    const summary = groups()[0].children[0];
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    assert.equal(summary.textContent, '2026/10/2 · 1个还原点', '日期标题仅显示日期与数量，不追加展开或收起文字');
    assert.equal(summary.children.length, 1);
    groups()[0].open = false; groups()[0].ontoggle();
    assert.equal(summary.textContent, '2026/10/2 · 1个还原点', '原生 toggle 不改动可见标题');
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(summary.getAttribute('aria-label'), '2026/10/2 · 1个还原点');
    dates.get('modHubRestorePointList').scrollTop = 234;
    selectPoint(dates, 'sameB');
    assert.equal(groups()[0].open, false, '选点不会重新打开用户收起的最新日期');
    assert.equal(dates.get('modHubRestorePointList').scrollTop, 234, '选点保持列表滚动位置');
    assert.equal(dates.document.activeElement, dates.get('modHubRestorePoint_sameB'), '选点后保留对应项键盘焦点');
    await dates.get('modHubRestoreProtectPoint').onclick();
    assert.equal(groups()[0].open, false, '保护刷新仍保留收起状态');
    assert.equal(dates.get('modHubRestorePointList').scrollTop, 234, '保护刷新保持列表滚动位置');
    groups()[2].open = false; groups()[2].ontoggle();
    assert.equal(dates.get('modHubRestorePoint_sameB').checked, true, '折叠其他日期不清除显式选择');
    assert.equal(dates.get('modHubRestorePointList').tabIndex, 0, '历史列表可聚焦后使用原生方向键滚动');
    assert.match(dates.get('modHubRestorePointList').getAttribute('aria-label'), /按日期分组/);
    assert.match(dates.get('modHubRestorePanelBody').className, /body-list/);
    assert.match(dates.get('modHubRestorePanel').className, /list-step/);
    const dateStyle = dates.get('modHubRestorePanelStyle').textContent;
    assert.match(dateStyle, /body-list\{[^}]*min-height:0;overflow:hidden/, '选点和预览外层内容不整体滚动');
    assert.match(dateStyle, /panel-scroll\{[^}]*min-height:0;overflow:auto;overscroll-behavior:contain/, '仅条目区局部滚动并阻止滚动链');
    assert.match(dateStyle, /group-summary::before\{[^}]*border-top:4px solid transparent;[^}]*border-bottom:4px solid transparent;[^}]*border-left:6px solid var\(--gold,#ffcc00\)/, '日期 summary 使用管理页同款金色朝右三角');
    assert.match(dateStyle, /details\[open\]>\.modhub-restore-panel-group-summary::before\{transform:rotate\(90deg\)/, '展开状态三角朝下');
    assert.match(dateStyle, /group-summary::-webkit-details-marker\{display:none\}/, '隐藏浏览器标记避免出现双三角');
    assert.doesNotMatch(dateStyle, /group-action/, '不再保留展开或收起文字样式');
    assert.match(dateStyle, /group-summary:hover[^}]*group-summary:focus-visible[^}]*border-color:var\(--gold/, '日期分类有可点击的 hover 和键盘焦点金色边框');
    assert.match(dateStyle, /@media\(max-height:560px\)/, '短高度压缩固定区间距，保留局部列表和操作区');
    await dates.get('modHubRestoreScanPoint').onclick();
    assert.equal(dates.get('modHubRestorePanelTitle').textContent, '受影响的模组');
    assert.equal(dates.get('modHubRestorePanelNext').hidden, true, '扫描结果没有下一步操作');
    assert.match(dateStyle, /button\[hidden\]\{display:none!important\}/, '隐藏的扫描页下一步不受游戏按钮样式覆盖');
    assert.equal(dates.get('modHubRestorePanelNext').disabled, true, '扫描结果不能直接执行还原');
    assert.equal(dates.get('modHubRestorePanelBack').textContent, '返回');
    assert.equal(dates.get('modHubRestorePanelCancel').textContent, '关闭');
    const scanCalls = dates.calls.length; await dates.get('modHubRestorePanelNext').onclick();
    assert.equal(dates.calls.length, scanCalls, '直接调用扫描页下一步也不执行还原');
    await dates.get('modHubRestorePanelClose').onclick();
    assert.equal(dates.get('modHubRestorePanelTitle').textContent, '选择还原点', '扫描叉号返回打开扫描的选点页');
    assert.equal(dates.get('modHubRestorePoint_sameB').checked, true, '关闭扫描保留所选还原点');
    assert.equal(groups()[0].open, false, '关闭扫描保留日期折叠状态');
    assert.equal(dates.get('modHubRestorePointList').scrollTop, 234, '关闭扫描保留历史列表位置');
    assert.equal(dates.document.activeElement, dates.get('modHubRestoreScanPoint'), '关闭扫描恢复扫描入口焦点');
    await dates.get('modHubRestorePanelNext').onclick();
    const selection = dates.get('modHubRestorePreviewSelection');
    assert.equal(selection.children.find(node => node.tagName === 'STRONG').textContent, '同日第二轮');
    assert.equal(selection.children.find(node => node.tagName === 'STRONG').className, 'gold');
    assert.equal(selection.children.at(-1).textContent, new Date(dates.state.points.find(point => point.id === 'sameB').at).toLocaleString('zh-CN', { hour12: false }), '预览显示所选点捕获日期和时间');
    assert.equal(dates.get('modHubRestoreSummaryList').tabIndex, 0, '确认摘要可聚焦并独立滚动');
    await dates.get('modHubRestoreScanPoint').onclick();
    await dates.get('modHubRestorePanelCancel').onclick();
    assert.equal(dates.get('modHubRestorePanelTitle').textContent, '确认还原点与变更', '关闭扫描返回打开扫描的确认页');
    assert.equal(dates.get('modHubRestorePreviewSelection').children.find(node => node.tagName === 'STRONG').textContent, '同日第二轮');
    await dates.get('modHubRestoreScanPoint').onclick();
    let escaped = false;
    dates.document.listeners.get('keydown')({ key: 'Escape', target: dates.get('modHubRestorePanelBody'), preventDefault() { escaped = true; } });
    await tick();
    assert.equal(escaped, true);
    assert.equal(dates.get('modHubRestorePanelTitle').textContent, '确认还原点与变更', 'Escape 关闭扫描但保留确认页');
    assert.equal(dates.document.activeElement, dates.get('modHubRestoreScanPoint'), 'Escape 返回扫描入口焦点');
    await dates.get('modHubRestorePanelBack').onclick();
    assert.equal(groups()[0].open, false, '返回选点保持折叠状态');
    assert.equal(dates.get('modHubRestorePointList').scrollTop, 234, '返回选点保持列表位置');
    await dates.get('modHubRestorePanelCancel').onclick(); await dateOpened;

    const maliciousName = '<img src=x onerror=alert(1)>', maliciousVersion = '<svg onload=alert(1)>', longVersion = '长版本'.repeat(100);
    const versions = fixture({ changes: { installed: ['恢复安装', '空版本'], updated: ['回退版本', '缺失字段', maliciousName], removed: ['移除模组'], enabled: ['启用模组'], disabled: ['禁用模组'] }, packageVersions: {
        '恢复安装': { current: null, target: '1.2.3' }, '空版本': { current: '', target: '' }, '回退版本': { current: '2.0.0', target: '1.0.0' }, '缺失字段': { current: '3.0.0' },
        [maliciousName]: { current: maliciousVersion, target: longVersion }, '移除模组': { current: '4.0.0', target: null },
    } });
    const versionsOpened = versions.open({ startup: true }); await tick(); selectPoint(versions, 'first'); await versions.get('modHubRestoreScanPoint').onclick();
    const versionList = versions.get('modHubRestoreChangeList'), versionItems = all(versionList).filter(node => node.tagName === 'LI');
    assert.deepEqual(versionItems.slice(0, 6).map(item => item.children.find(node => node.tagName === 'SMALL')?.textContent), [
        '当前版本：未安装；还原后版本：1.2.3', '当前版本：未识别；还原后版本：未识别', '当前版本：2.0.0；还原后版本：1.0.0', '当前版本：3.0.0；还原后版本：未识别',
        `当前版本：${maliciousVersion}；还原后版本：${longVersion}`, '当前版本：4.0.0；还原后版本：未安装',
    ], '安装、回退、移除逐项显示当前与目标版本，区分未安装和未识别');
    assert.ok(versionItems.slice(0, 6).every(item => item.children.find(node => node.tagName === 'SMALL')?.className === 'grey'), '版本详情使用次要文字，不遮盖模组名称');
    assert.ok(versionItems[4].textContent.startsWith(maliciousName), '恶意模组名称原样显示为文字，版本在独立小字行显示');
    assert.equal(all(versionList).some(node => ['IMG', 'SVG'].includes(node.tagName)), false, '名称和版本不插入 HTML 节点');
    assert.deepEqual(versionItems.slice(6).map(item => [item.textContent, item.children.some(node => node.tagName === 'SMALL')]), [['启用模组', false], ['禁用模组', false]], '启禁变更保持模组名称展示');
    assert.match(versions.get('modHubRestorePanelStyle').textContent, /changes li\{[^}]*overflow-wrap:anywhere/, '长版本行继承条目的换行规则');
    assert.match(versions.get('modHubRestorePanelStyle').textContent, /changes li small\{[^}]*display:block/, '版本详情独立成行');
    await versions.get('modHubRestorePanelCancel').onclick();
    await versions.get('modHubRestorePanelCancel').onclick(); await versionsOpened;

    const longNames = Array.from({ length: 100 }, (_, index) => `模组${index}_${'长名称'.repeat(12)}`);
    const longPreview = fixture({ changes: { installed: ['已删除模组'], updated: ['旧版包体'], removed: longNames, enabled: ['启用模组'], disabled: ['禁用模组'], orderChanged: true, beautyChanged: true, settingsChanged: true }, riskMessages: Array.from({ length: 20 }, (_, index) => `风险说明${index}`) });
    const longOpened = longPreview.open({ startup: true }); await tick(); selectPoint(longPreview, 'first'); await longPreview.get('modHubRestoreScanPoint').onclick();
    const changeList = longPreview.get('modHubRestoreChangeList');
    assert.equal(changeList.tabIndex, 0);
    assert.match(changeList.getAttribute('aria-label'), /变更与风险列表/);
    assert.equal(all(changeList).filter(node => node.tagName === 'LI').length, 104, '长模组名单逐项显示，均在局部滚动区');
    assert.equal(all(changeList).filter(node => node.tagName === 'SMALL' && node.textContent === '当前版本：未识别；还原后版本：未识别').length, 102, '旧名称数组没有版本数据时仍展示全部条目，并明确版本未识别');
    assert.equal(all(changeList).filter(node => node.textContent.startsWith('风险说明') && node.tagName === 'P').length, 20, '限制与风险说明跟随列表滚动，不挤掉页尾');
    assert.deepEqual(changeList.children.filter(node => node.tagName === 'SECTION').map(node => [node.children[0].textContent, node.children[0].className]), [
        ['恢复已删除模组：', 'green'], ['回退包体：', 'gold'], ['移除后来安装的模组：', 'red'], ['恢复启用：', 'green'], ['恢复禁用：', 'red'],
    ], '变更分类按恢复、回退、移除和启禁突出重点');
    for (const text of ['恢复加载顺序', '恢复美化配置', '恢复管理配置']) assert.equal(changeList.children.find(node => node.textContent === text).className, 'gold');
    await longPreview.get('modHubRestorePanelCancel').onclick();
    await longPreview.get('modHubRestorePanelNext').onclick();
    assert.equal(longPreview.get('modHubRestoreChangeList'), null, '确认页不重复展示长扫描名单');
    const summaryList = longPreview.get('modHubRestoreSummaryList');
    assert.equal(all(summaryList).filter(node => node.tagName === 'LI').length, 0, '确认页只显示统计和风险');
    assert.deepEqual(summaryList.children.slice(0, 5).map(node => [node.textContent, node.className]), [
        ['恢复已删除模组：1 个', 'green'], ['回退包体：1 个', 'gold'], ['移除后来安装的模组：100 个', 'red'], ['恢复启用：1 个', 'green'], ['恢复禁用：1 个', 'red'],
    ], '确认页保持各类变更数量和强调色');
    assert.equal(all(summaryList).filter(node => node.textContent.startsWith('风险说明') && node.tagName === 'P').length, 20, '确认页保留全部风险说明');
    const fixedNotice = longPreview.get('modHubRestorePanelBody').children.find(node => node.className === 'modhub-restore-panel-notice');
    assert.ok(fixedNotice && !changeList.contains(fixedNotice), '执行结果和保护措施固定显示于滚动区之外');
    assert.deepEqual(fixedNotice.children.filter(node => node.tagName === 'STRONG').map(node => [node.textContent, node.className]), [
        ['还原前保存当前模组状态', 'gold'], ['当前 ModHub 与游戏存档保留', 'green'], ['游戏重新加载', 'gold'],
    ]);
    assert.equal(longPreview.get('modHubRestorePanelNext').disabled, false, '长列表不改变还原按钮可用状态');
    await longPreview.get('modHubRestorePanelCancel').onclick(); await longOpened;
    console.log('时间点还原面板说明、设置与救援交互测试通过');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
