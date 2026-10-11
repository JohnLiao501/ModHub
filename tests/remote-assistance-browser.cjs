// 双端浏览器验收：真实 D1 与隔离游戏，所有外网请求均在测试路由中拦截。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('C:/Users/JohnLiao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const { Miniflare, convertV4MiniflareOptions } = require(path.join(root, 'dolmod-site/node_modules/miniflare'));
const site = path.resolve(process.env.MODHUB_ASSIST_SITE_ROOT || path.join(root, 'dolmod-site'));
const evidence = path.join(root, 'plans/remote-assistance/evidence');
const targetName = 'ModHub验收AI故障';
const targetPath = 'javascript/modhub-acceptance-ai.js';
const report = { startedAt: new Date().toISOString(), boundary: '会话未提供 Browser 插件；使用 Playwright 独立浏览器上下文、本机真实 D1 与隔离游戏真实 ModLoader。开发者 Access 身份仅在本机夹具中注入，未验证线上 Access 登录；未操作年龄确认、未进入正常游戏，完整玩法未测试。', siteRoot: site, checks: [], layouts: [], consoleErrors: [], blockedExternal: [], requests: [] };
let mf, backend, gameServer, browser, player, developer, db;
let failure;
const check = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log('通过：' + name); };
const until = async (predicate, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error('等待超时：' + label);
};
const remote = action => player.locator('#modHubHelpRemoteContent [data-remote-action="' + action + '"]');

async function startBackend() {
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("本机测试数据库")}}',
        compatibilityDate: '2026-09-20', d1Databases: ['COMMUNITY_DB'] }));
    db = await mf.getD1Database('COMMUNITY_DB');
    const sql = fs.readFileSync(path.join(site, 'migrations/0011_remote_assistance.sql'), 'utf8');
    const statements = sql.match(/CREATE TRIGGER[\s\S]*?^END;|CREATE (?:TABLE|INDEX)[\s\S]*?;/gm);
    assert.ok(statements?.length >= 7, '远程协助迁移结构须包含表、索引和事务触发器');
    for (const statement of statements) await db.prepare(statement).run();
    const { modHubHandleRemoteAssistance } = await import(pathToFileURL(path.join(site, 'modhub-remote-assistance.js')).href);
    const env = { COMMUNITY_DB: db, SUPPORT_ACCESS_AUD: 'test-support', SUPPORT_EMAILS: 'helper@example.test',
        SUPPORT_HELPERS: '{"helper@example.test":"本机验收开发者"}', SUPPORT_RATE_LIMITER: { limit: async () => ({ success: true }) },
        SUPPORT_PAIR_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    backend = http.createServer(async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const url = 'http://127.0.0.1:' + backend.address().port + request.url;
            report.requests.push({ path: new URL(url).pathname, method: request.method, bytes: body.length });
            const result = await modHubHandleRemoteAssistance(new Request(url, { method: request.method, headers: request.headers,
                ...(body.length ? { body, duplex: 'half' } : {}) }), env,
            { access: { aud: 'test-support', getIdentity: async () => ({ email: 'helper@example.test' }) } });
            response.writeHead(result?.status || 404, Object.fromEntries(result?.headers || []));
            response.end(result ? Buffer.from(await result.arrayBuffer()) : '本机测试资源不存在');
        } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + backend.address().port;
}

async function startGame() {
    gameServer = spawn(process.execPath, [path.join(__dirname, 'restore-browser-server.cjs'), '--namespace', 'modhub_acceptance_remote'],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('真实游戏隔离服务启动超时')), 30000);
        const read = data => {
            output += data.toString();
            const found = output.match(/真实游戏验收：(http:\/\/127\.0\.0\.1:\d+)\/game/);
            if (found) { clearTimeout(timer); resolve(found[1]); }
        };
        gameServer.stdout.on('data', read); gameServer.stderr.on('data', read);
        gameServer.once('exit', code => { clearTimeout(timer); reject(new Error('隔离服务提前退出：' + code + '\n' + output)); });
    });
}

async function routeContext(context, localBackend, gameOrigin) {
    await context.addInitScript(() => {
        window.addEventListener('unhandledrejection', event => console.warn('[ModHub验收拒绝]', JSON.stringify({
            type: event.reason?.type, message: event.reason?.message, resource: event.reason?.target?.src || event.reason?.target?.href || null
        })));
    });
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === localBackend || url.origin === gameOrigin) return route.continue();
        if (url.hostname === 'dolmod-release-index.johnliao381658675.workers.dev' && url.pathname.startsWith('/remote-assistance')) {
            const response = await fetch(localBackend + url.pathname + url.search, { method: request.method(), headers: request.headers(),
                ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}) });
            return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        }
        if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
        report.blockedExternal.push({ host: url.host, path: url.pathname });
        return route.abort('blockedbyclient');
    });
    context.on('page', page => {
        page.on('pageerror', error => report.consoleErrors.push({ page: page === player ? 'player' : 'developer', text: error.message }));
        page.on('console', message => { if (message.type() === 'warning' && message.text().startsWith('[ModHub验收拒绝]')) report.consoleErrors.push({ page: page === player ? 'player' : 'developer', detail: message.text() }); });
    });
}

async function confirm(label) {
    const dialog = player.locator('.modhub-modal-dialog').last();
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: label, exact: true }).click();
}

async function openHelp() {
    await player.locator('#modHubAcceptancePanel').evaluate(node => { node.open = true; });
    await player.getByRole('button', { name: '帮助中心界面验收', exact: true }).click();
    await player.locator('#modHubHelpRemote').waitFor({ state: 'visible' });
    await player.locator('#modHubHelpRemote > summary').click();
    await player.locator('#modHubHelpRemoteContent .modhub-remote').waitFor({ state: 'visible' });
}

async function layout(page, selector, label) {
    const reading = await page.locator(selector).evaluate(node => {
        const r = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0).map(button => {
            const b = button.getBoundingClientRect(); return { label: button.textContent, width: b.width, height: b.height, left: b.left, right: b.right };
        });
        return { viewport: innerWidth, left: r.left, right: r.right, width: r.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, buttons };
    });
    assert.ok(reading.scrollWidth <= reading.clientWidth + 1, label + '：内容横向溢出');
    assert.ok(reading.left >= -1 && reading.right <= reading.viewport + 1, label + '：容器超出视口');
    assert.ok(reading.buttons.every(button => button.height >= 32 && button.width > 20 && button.left >= -1 && button.right <= reading.viewport + 1), label + '：按钮触控面积或边界');
    report.layouts.push({ label, ...reading });
    await page.screenshot({ path: path.join(evidence, label + '.png'), fullPage: false });
}

async function actualPackage() {
    return player.evaluate(async name => {
        const record = await window.modHubReadInstalledModPackage(name);
        return { hash: await window.modHubAiPackage.hash(record.data), boot: record.bootJson, lists: await window.modHubReadIndexDBModLists() };
    }, targetName);
}

async function resultCount() {
    return (await db.prepare("SELECT count(*) AS count FROM modhub_remote_messages WHERE type='result'").first()).count;
}

async function publish(kind, payload, sessionId) {
    await developer.bringToFront();
    await developer.locator('#modHubAssistRefresh').click();
    await until(async () => !await developer.locator('#modHubAssistSend').isDisabled(), '开发者刷新会话');
    await developer.locator('#modHubAssistKind').selectOption(kind);
    if (kind === 'readSources') {
        await developer.locator('#modHubAssistName').fill(payload.name);
        await developer.locator('#modHubAssistPaths').fill(payload.paths.join('\n'));
    } else if (kind === 'applyPatch') {
        for (const [id, key] of [['Name', 'name'], ['Version', 'version'], ['Baseline', 'baselineHash'], ['Summary', 'summary'], ['Evidence', 'evidence'], ['Verification', 'verification']]) {
            await developer.locator('#modHubAssist' + id).fill(payload[key] || '');
        }
        for (const [key, value] of Object.entries(payload.changes[0])) await developer.locator('#modHubAssistChanges [data-field="' + key + '"]').fill(value);
    }
    const previous = (await db.prepare("SELECT count(*) AS count FROM modhub_remote_messages WHERE type='command' AND session_id=?").bind(sessionId).first()).count;
    await developer.locator('#modHubAssistPreviewButton').click();
    assert.equal(JSON.parse(await developer.locator('#modHubAssistPreview').textContent()).kind, kind);
    await developer.locator('#modHubAssistSend').click();
    await developer.locator('#modHubAssistConfirmYes').click();
    await until(async () => (await db.prepare("SELECT count(*) AS count FROM modhub_remote_messages WHERE type='command' AND session_id=?").bind(sessionId).first()).count > previous, '开发者发布 ' + kind);
    await player.bringToFront();
    await until(() => remote('preview').isVisible(), '玩家收到 ' + kind, 15000);
}

async function run() {
    fs.mkdirSync(evidence, { recursive: true });
    const localBackend = await startBackend();
    const gameOrigin = await startGame();
    report.origins = { localBackend, gameOrigin };
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const playerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const developerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await routeContext(playerContext, localBackend, gameOrigin);
    await routeContext(developerContext, localBackend, gameOrigin);
    player = await playerContext.newPage(); developer = await developerContext.newPage();
    player.setDefaultTimeout(30000); developer.setDefaultTimeout(30000);
    await player.goto(gameOrigin + '/game', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await player.waitForFunction(() => window.modHubHelp && window.modHubRemoteHelp && window.modHubRestore, null, { timeout: 90000 });
    await player.locator('#modHubAcceptancePanel').evaluate(node => { node.open = true; });
    await Promise.all([player.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }),
        player.getByRole('button', { name: '安装 AI 故障模组并重载', exact: true }).click()]);
    await player.waitForFunction(() => typeof window.modHubAcceptanceAiProbe === 'function', null, { timeout: 90000 });
    assert.equal(await player.evaluate(() => { try { window.modHubAcceptanceAiProbe(); return false; } catch (error) { return error instanceof TypeError; } }), true);
    await openHelp();
    assert.equal(report.requests.length, 0, '仅进入帮助中心和展开远程协助不得联系服务');
    const baseline = await actualPackage();
    report.baseline = { hash: baseline.hash, enabled: baseline.lists.enabled, disabled: baseline.lists.disabled };
    check('真实游戏故障探针复现，进入远程帮助不联网');
    await developer.goto(localBackend + '/assist');
    await developer.getByText('本机验收开发者', { exact: false }).first().waitFor();
    // 开发者页面控件由实际页面提供，创建流程不用虚构客户端接口。
    await createRepairFromUi();
    const recipe = await db.prepare('SELECT id,code FROM modhub_remote_repairs ORDER BY created_at DESC LIMIT 1').first();
    await player.bringToFront();
    await player.locator('#modHubRemoteCode').fill(recipe.code);
    await remote('lookup').click();
    await remote('join').click(); await confirm('加入协助');
    await remote('preview').click();
    await player.locator('#modHubRemotePreview').waitFor();
    assert.equal(await resultCount(), 0, '本机初诊预览不得上传材料');
    for (const width of [360, 768, 1280]) {
        await player.setViewportSize({ width, height: 900 });
        await layout(player, '#modHubHelpRemoteContent', 'player-diagnostics-' + width);
        await developer.setViewportSize({ width, height: 900 });
        await developer.evaluate(() => scrollTo(0, 0));
        await layout(developer, 'main', 'developer-' + width);
    }
    await remote('execute').click(); await confirm('发送资料');
    await until(async () => await resultCount() === 1, '初诊回传');
    check('初诊材料经真实预览、独立确认后上传，三档视口通过');
    const continuation = (await player.locator('#modHubHelpRemoteContent').innerText()).match(/续接码：\s*(\d{10})/)?.[1];
    assert.ok(continuation);
    await pairFromUi(recipe.id, continuation);
    await player.bringToFront();
    const session = await db.prepare('SELECT id FROM modhub_remote_sessions WHERE repair_id=?').bind(recipe.id).first();
    await until(() => remote('pair').isVisible(), '玩家确认开发者配对', 15000);
    assert.equal((await db.prepare('SELECT pairing FROM modhub_remote_sessions WHERE id=?').bind(session.id).first()).pairing, 'pending');
    await remote('pair').click(); await confirm('允许连接');
    await until(async () => (await db.prepare('SELECT pairing FROM modhub_remote_sessions WHERE id=?').bind(session.id).first()).pairing === 'paired', '配对完成');
    check('开发者输入续接码后仍须玩家确认身份');
    await publish('readSources', { name: targetName, paths: [targetPath] }, session.id);
    await remote('preview').click(); await player.locator('#modHubRemotePreview').waitFor();
    assert.equal(await resultCount(), 1, '源码预览不得自动回传');
    const sources = JSON.parse(await player.locator('#modHubRemotePreview').inputValue());
    assert.equal(sources.baselineHash, baseline.hash); assert.equal(sources.files.length, 1);
    await remote('execute').click(); await confirm('发送资料');
    await until(async () => await resultCount() === 2, '源码回传');
    check('仅指定声明源码发送，ZIP 原包摘要与真实仓库一致');
    await publish('applyPatch', { name: targetName, version: baseline.boot.version, baselineHash: baseline.hash,
        summary: '修复隔离探针初始化', evidence: '指定源码中的 value 为 undefined', verification: '重载后调用隔离探针，须返回已修复。',
        changes: [{ path: targetPath, before: 'const value = undefined;', after: 'const value = { label: "已修复" };', reason: '给隔离探针明确的固定测试值。' }] }, session.id);
    await remote('preview').click(); await player.locator('#modHubRemotePreview').waitFor();
    assert.equal((await actualPackage()).hash, baseline.hash, '补丁预览不得写入实际仓库');
    await remote('execute').click(); await confirm('应用修复');
    await until(async () => await resultCount() === 3, '补丁结果回传');
    const changed = await actualPackage();
    assert.notEqual(changed.hash, baseline.hash);
    assert.deepEqual(changed.lists.enabled, baseline.lists.enabled); assert.deepEqual(changed.lists.disabled, baseline.lists.disabled);
    const point = await player.evaluate(async () => {
        const loader = window.modUtils.getModLoader().getIndexDBLoader();
        return loader.customStore('readonly', store => new Promise((resolve, reject) => {
            const request = store.get('modhub_restore_points_v1');
            request.onsuccess = () => resolve(request.result?.find(point => point.operation === 'remoteRepair'));
            request.onerror = () => reject(request.error);
        }));
    });
    assert.ok(point?.id, '真实历史须记录远程协助保护点');
    await player.screenshot({ path: path.join(evidence, 'player-patch-saved.png'), fullPage: false });
    check('补丁经逐次确认、强制还原点与真实事务保存，启禁列表保持', { beforeHash: baseline.hash, afterHash: changed.hash });
    await player.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await player.waitForFunction(() => typeof window.modHubAcceptanceAiProbe === 'function', null, { timeout: 90000 });
    assert.equal(await player.evaluate(() => window.modHubAcceptanceAiProbe()), '已修复');
    await openHelp();
    assert.equal(await remote('resume').isVisible(), true, '重载后协助必须暂停');
    const beforeResumeResults = await resultCount();
    await remote('resume').click();
    await until(() => remote('pause').isVisible(), '手动继续协助');
    assert.equal((await actualPackage()).hash, changed.hash);
    assert.equal(await resultCount(), beforeResumeResults, '继续协助不能重放已完成命令');
    await player.locator('#modHubHelpRemote > summary').click();
    await until(async () => (await db.prepare('SELECT status FROM modhub_remote_sessions WHERE id=?').bind(session.id).first()).status === 'paused', '折叠后服务会话暂停');
    await player.locator('#modHubHelpRemote > summary').click();
    assert.equal(await remote('resume').isVisible(), true);
    check('实际重载运行修复代码，重新进入及折叠会暂停，命令不重放');
    await remote('restore').click();
    await player.locator('#modHubRestorePanelNext').click();
    await player.locator('#modHubRestorePointList').waitFor({ state: 'visible' });
    const radio = player.locator('[name="modHubRestoreSelectedPoint"][value="' + point.id + '"]');
    await radio.evaluate(node => { node.closest('details').open = true; });
    await radio.check();
    await player.locator('#modHubRestorePanelNext').click();
    await player.getByRole('button', { name: '开始还原', exact: true }).click();
    await Promise.all([player.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }), confirm('确认还原并重新加载')]);
    await player.waitForFunction(() => typeof window.modHubAcceptanceAiProbe === 'function', null, { timeout: 90000 });
    await until(async () => (await actualPackage()).hash === baseline.hash, '还原原始包体');
    assert.equal(await player.evaluate(() => { try { window.modHubAcceptanceAiProbe(); return false; } catch (error) { return error instanceof TypeError; } }), true);
    check('玩家通过正式时间点面板还原，原始 ZIP 与故障探针一致');
    const storage = await player.evaluate(async () => ({ databases: (await indexedDB.databases()).map(item => item.name),
        loader: window.modHubRestore.getStorageIdentity() }));
    report.storage = storage;
    assert.equal(new URL(player.url()).origin, gameOrigin, '游戏始终位于本次本机隔离来源');
    assert.ok(storage.loader.dbName.startsWith('modhub_acceptance_remote_'), 'ModLoader 测试库必须使用独立命名空间');
    assert.ok(storage.databases.includes(storage.loader.dbName), '实际加载器数据库须存在于独立上下文');
    check('真实加载器使用隔离来源与独立存储身份', storage);
    await player.screenshot({ path: path.join(evidence, 'player-restored.png'), fullPage: false });
}

async function createRepairFromUi() {
    await developer.getByText('将当前操作发布为新修复方案', { exact: true }).click();
    await developer.locator('#modHubAssistTitle').fill('本机远程协助验收');
    await developer.locator('#modHubAssistDescription').fill('仅检查隔离测试游戏，不访问玩家实际资料。');
    await developer.locator('#modHubAssistPublish').click();
    await developer.locator('#modHubAssistConfirmYes').click();
    await until(async () => !!await db.prepare('SELECT id FROM modhub_remote_repairs LIMIT 1').first(), '开发者发布修复码');
}

async function pairFromUi(repairId, code) {
    await developer.bringToFront();
    await developer.locator('#modHubAssistContinuation').fill(code);
    await developer.locator('#modHubAssistPair').click();
    await until(async () => (await db.prepare('SELECT pairing FROM modhub_remote_sessions WHERE repair_id=?').bind(repairId).first()).pairing === 'pending', '开发者请求配对');
}

(async () => {
    try { await run(); }
    catch (error) {
        failure = error; report.failure = error.stack;
        if (player) await player.screenshot({ path: path.join(evidence, 'failure-player.png'), fullPage: false }).catch(() => {});
        if (developer) await developer.screenshot({ path: path.join(evidence, 'failure-developer.png'), fullPage: false }).catch(() => {});
    } finally {
        report.finishedAt = new Date().toISOString(); report.passed = !failure;
        fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, 'remote-assistance-report.json'), JSON.stringify(report, null, 2));
        await browser?.close(); await new Promise(resolve => backend ? backend.close(resolve) : resolve());
        await mf?.dispose(); gameServer?.kill();
    }
    if (failure) { console.error(failure); process.exitCode = 1; }
    else console.log('远程协助双端与隔离游戏验收通过：' + path.join(evidence, 'remote-assistance-report.json'));
})();
