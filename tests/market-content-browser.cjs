// 使用真实 DoL 样式与模拟目录核对市场布局；不运行游戏剧情或第三方模组。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('C:/Users/JohnLiao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modhub-market-content-'));
const boot = JSON.parse(fs.readFileSync(path.join(root, 'src/boot.json'), 'utf8'));
const nativeCssPath = process.env.MODHUB_NATIVE_GAME_CSS || path.join(root, '资料/compat-v1.2.2/0.5.12.13/game-styles.css');
const nativeCss = fs.readFileSync(nativeCssPath, 'utf8');
const nativeCssSha256 = crypto.createHash('sha256').update(nativeCss).digest('hex');
const spellBody = '<<set $x to "<script>正文不执行</script>">>\n  原始换行\n';
const versionCases = [
    { id: 'version-uninstalled', name: '未安装有最新版', version: '1.20', latest: 'v1.20' },
    { id: 'version-different', name: '已安装不同版本', local: '1.0', version: '2.0', latest: 'v2.0' },
    { id: 'version-same', name: '已安装相同版本', local: '2.0', version: '2.0', latest: 'v2.0' },
    { id: 'version-unknown', name: '已安装远端未知', local: '7.0', version: '', latest: '未知' },
    { id: 'version-both-unknown', name: '已安装版本未识别', local: '', version: '', latest: '未知' },
    { id: 'version-registered', name: '登记真实包版本', local: '1.0.0', version: '1.0.20', assetVersion: '1.0.19', latest: 'v1.0.19' }
];
const index = { schemaVersion: 1, communityRevision: 21, mods: [{ id: 'external-layout', name: '外部资源', author: '作者',
    contentType: 'package', catalogSource: 'community', sourcePlatform: 'tieba', sourceUrl: 'https://tieba.baidu.com/p/123',
    autoInstall: false, sources: [{ platform: 'tieba', url: 'https://tieba.baidu.com/p/123',
        extractionCode: '1234', archivePassword: '密码', instructions: '作者原文\n下载后按说明导入。' }],
    packageRecords: [{ id: 'old-layout', fileName: 'history.zip', format: 'ModLoader Zip', bootName: 'History', version: '1.0',
        sourceUrl: 'https://tieba.baidu.com/p/123', downloadUrl: 'https://tieba.baidu.com/p/123', evidenceUrl: 'https://tieba.baidu.com/p/123',
        dependencies: [{ id: 'Replace', version: '^1.0' }], gameVersionRange: '',
        instructions: ('保留原始版本与兼容说明。\n').repeat(32) }] },
    { id: 'github-layout', name: '直接下载', githubUrl: 'https://github.com/Owner/Direct', author: '作者' },
    { id: 'multi-source-layout', name: '多平台来源', author: '作者', contentType: 'package', catalogSource: 'wiki',
        githubUrl: 'https://github.com/Owner/Multiple', sourcePlatform: 'github',
        sourceUrl: 'https://github.com/Owner/Multiple/releases/download/v3/main.zip',
        sources: [{ platform: 'github', url: 'https://github.com/Owner/Multiple/releases/download/v3/main.zip' },
            { platform: 'github', url: 'https://github.com/Owner/Multiple' },
            { platform: 'discord', url: 'https://discord.com/channels/1103864219620884560/1197809298902896731' },
            { platform: 'discord', url: 'https://discord.com/channels/1103864219620884560/1197809298902896731/123' },
            { platform: 'discord', url: 'https://discord.com/channels/1103864219620884560/1197809298902896731/456' }] },
    { id: 'no-source-layout', name: '没有来源链接', author: '作者', contentType: 'package', catalogSource: 'community',
        sourcePlatform: 'unknown', autoInstall: false, sources: [] },
    ...versionCases.map(item => ({ id: item.id, identityId: item.id, bootNames: [item.id], name: item.name, author: '作者',
        githubUrl: `https://github.com/VersionTests/${item.id}`, version: item.version, releaseAssetVersion: item.assetVersion, versionSource: 'github' }))],
    spells: [{ id: 'spell-layout', name: '咒语正文', contentType: 'spell', description: '按指定位置复制使用。',
        spell: { body: spellBody, inputLocation: '原作者指定位置', instructions: '第一步\n第二步' } }] };
let browser;
const results = [];
(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const width of [360, 768, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        const sourceInteractions = [];
        const consoleErrors = [], isolatedRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (['error', 'warning'].includes(message.type()) && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
        });
        page.on('requestfailed', request => isolatedRequests.push(request.url()));
        await context.route('**/*', route => route.request().url() === 'http://modhub-fixture.test/'
            ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ModHub 市场测试</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="modHubModMarketContainer"></main></body></html>' })
            : route.abort());
        await page.goto('http://modhub-fixture.test/');
        await page.addStyleTag({ content: nativeCss });
        for (const file of boot.styleFileList) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'src', file), 'utf8') });
        await page.addStyleTag({ content: 'body{margin:0;padding:12px;box-sizing:border-box;background:var(--850,#181818)}#modHubModMarketContainer{width:100%;max-width:1200px;margin:0 auto;box-sizing:border-box}' });
        await page.evaluate(data => {
            window.modHubEscapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
            window.fetch = async () => ({ ok: true, json: async () => data });
            window.modHubNotifyUpdateState = () => {};
            window.StartConfig = { version: '' };
            window.modHubShowToast = () => {};
            window.modHubFixtureCopied = null;
            Object.defineProperty(navigator, 'clipboard', { configurable: true,
                value: { writeText: async body => { window.modHubFixtureCopied = body; } } });
        }, index);
        await page.evaluate(cases => {
            const local = cases.filter(item => Object.hasOwn(item, 'local')).map(item => ({ name: item.id,
                bootJson: { name: item.id, version: item.local, repository: `https://github.com/VersionTests/${item.id}` } }));
            window.modHubGetGui = () => ({ gModUtils: { getModList: () => local, getModListNameNoAlias: () => local.map(item => item.name) } });
            window.modHubGetModInfo = name => local.find(item => item.name === name) || null;
        }, versionCases);
        for (const file of ['modhub-dialog.js', 'modhub-market.js', 'modhub-market-spells.js', 'modhub-market-versions.js']) {
            await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'src/javascript', file), 'utf8') });
        }
        await page.evaluate(() => window.modHubInitMarket(true));
        assert.equal(page.url(), 'http://modhub-fixture.test/');
        assert.equal(await page.title(), 'ModHub 市场测试');
        assert.ok(await page.locator('.modhub-market-card').count());
        assert.equal(await page.locator('.modhub-market-details').count(), 0, '卡片不再内联展开长资料');
        assert.equal(await page.locator('.modhub-market-source-button').count(), 0, '来源使用文字链接，不再显示查看来源按钮');
        assert.equal(await page.locator('.modhub-market-source-bar').count(), await page.locator('.modhub-market-card').count(), '所有卡片保留同位置的来源行');
        const fixtureIndexes = await page.evaluate(() => Object.fromEntries(window.modHubMarket.getMarketMods().map((mod, index) => [mod.id, index])));
        const sourceCard = id => page.locator(`.modhub-market-card[data-mod-index="${fixtureIndexes[id]}"]`);
        const multiSource = sourceCard('multi-source-layout').locator('.modhub-market-source-bar');
        assert.equal(await multiSource.locator('.modhub-market-source-link').count(), 2);
        assert.match(await multiSource.innerText(), /来源：\s*GitHub\s*·\s*Discord/);
        assert.equal(await multiSource.locator('.modhub-market-source-link').first().getAttribute('href'), 'https://github.com/Owner/Multiple', 'GitHub 优先使用已有仓库主页');
        assert.equal(await multiSource.locator('.modhub-market-source-link').nth(1).getAttribute('href'), 'https://discord.com/channels/1103864219620884560/1197809298902896731', 'Discord 保留首个原帖');
        assert.equal(await multiSource.locator('.modhub-market-acquisition-link').count(), 1, '合并同平台其他原帖后仍提供完整安装说明入口');
        const sourceNames = await page.locator('.modhub-market-source-bar').evaluateAll(bars => bars.map(bar =>
            [...bar.querySelectorAll('.modhub-market-source-link')].map(link => link.textContent)));
        assert.ok(sourceNames.every(names => names.length === new Set(names).size), '每张卡片来源行的平台名称只出现一次');
        const noSource = sourceCard('no-source-layout').locator('.modhub-market-source-bar');
        assert.match(await noSource.innerText(), /暂无来源链接/);
        assert.equal(await noSource.locator('a').count(), 0, '没有有效URL时不伪造来源入口');
        const directSource = sourceCard('github-layout');
        assert.equal(await directSource.locator('.modhub-market-source-link').getAttribute('href'), 'https://github.com/Owner/Direct');
        assert.equal(await directSource.locator('.modhub-market-acquisition-link').count(), 0, '没有额外资料时不显示安装说明入口');
        for (const item of versionCases) {
            const card = page.locator(`[data-mod-name="${item.name}"]`);
            const versions = card.locator('.modhub-market-versions');
            assert.ok((await versions.innerText()).includes(`最新版本：${item.latest}`));
            if (Object.hasOwn(item, 'local')) assert.ok((await versions.innerText()).includes(`已安装版本：${item.local ? 'v' + item.local : '未知'}`));
            else assert.ok(!(await versions.innerText()).includes('已安装版本：'));
            const bounds = await versions.locator('span').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
            }));
            assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width + 1 && rect.width > 40 && rect.height > 10), '当前与最新版本信息应在视口内完整换行');
        }
        const external = page.locator('[data-mod-name="外部资源"]');
        assert.equal(await external.locator('.modhub-market-actions a').count(), 0, '主页访问统一由来源文字链接承担');
        assert.equal(await external.locator('.modhub-market-actions button').count(), 0);
        assert.equal(await external.locator('.modhub-market-source-link').getAttribute('href'), 'https://tieba.baidu.com/p/123');
        const acquisitionLink = external.locator('.modhub-market-acquisition-link');
        assert.equal(await acquisitionLink.innerText(), '安装说明');
        await acquisitionLink.focus();
        await page.keyboard.press('Enter');
        const sourceDialog = page.locator('.modhub-acquisition-dialog');
        await sourceDialog.evaluate(async dialog => { await Promise.all(dialog.getAnimations().map(animation => animation.finished.catch(() => {}))); });
        const sourcePanel = sourceDialog.locator('.modhub-acquisition');
        assert.match(await sourcePanel.innerText(), /提取码：\s*1234/);
        assert.match(await sourcePanel.innerText(), /前置要求：\s*Replace \^1.0/);
        assert.equal(await sourcePanel.locator('.modhub-detail-footer').count(), 1, '通用导入说明只在资料面板内显示一次');
        assert.equal(await sourcePanel.locator('.modhub-acquisition-package .modhub-detail-links a').count(), 1, '同一包来源、下载、核验的相同URL合并为一条明确入口');
        assert.match(await sourcePanel.locator('.modhub-acquisition-package .modhub-detail-links').innerText(), /版本来源.*下载此版本.*核验来源/);
        await page.screenshot({ path: path.join(evidenceDir, `sources-${width}.png`), fullPage: false });
        const reading = sourcePanel.locator('.modhub-detail-readme').last();
        await reading.focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction(() => [...document.querySelectorAll('.modhub-detail-readme')].some(element => element.scrollTop > 0));
        const modalState = await sourceDialog.evaluate(dialog => {
            const panel = dialog.querySelector('.modhub-acquisition');
            const rect = element => { const value = element.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
            return { dialog: rect(dialog), header: rect(dialog.querySelector('.modhub-modal-header')), footer: rect(dialog.querySelector('.modhub-modal-footer')),
                links: [...panel.querySelectorAll('a')].map(element => ({ text: element.textContent, ...rect(element) })),
                panel: { height: panel.clientHeight, scrollHeight: panel.scrollHeight, focusable: panel.tabIndex === 0 },
                readings: [...panel.querySelectorAll('.modhub-detail-readme')].map(element => ({ text: element.textContent, height: element.clientHeight,
                    scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, focusable: element.tabIndex === 0,
                    fontSize: getComputedStyle(element).fontSize, color: getComputedStyle(element).color, marginBottom: getComputedStyle(element).marginBottom })) };
        });
        assert.ok(modalState.dialog.left >= 0 && modalState.dialog.right <= width + 1 && modalState.header.top >= 0 && modalState.footer.bottom <= 901, '资料面板标题和底部操作在视口内');
        assert.ok(modalState.links.every(link => link.width > 20 && link.height >= 32), '来源链接有足够触控面积');
        assert.ok(modalState.readings.some(value => value.scrollHeight > value.height && value.focusable && value.scrollTop > 0), '作者长原文可聚焦并由键盘局部滚动');
        assert.ok(modalState.readings.every(value => value.marginBottom === '0px'), '游戏全局段落边距不会撑高阅读区');
        await page.screenshot({ path: path.join(evidenceDir, `sources-keyboard-${width}.png`), fullPage: false });
        await page.keyboard.press('Escape');
        await sourceDialog.waitFor({ state: 'detached' });
        assert.equal(await page.locator('.modhub-acquisition-dialog').count(), 0);
        const packageState = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('.modhub-market-section-button, .modhub-market-actions a, .modhub-market-actions button, .modhub-market-source-link, .modhub-market-acquisition-link')]
                .map(element => { const rect = element.getBoundingClientRect(); return { text: element.textContent, width: rect.width, height: rect.height, left: rect.left, right: rect.right }; });
            return { width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
                buttons, body: { color: getComputedStyle(document.body).color, background: getComputedStyle(document.body).backgroundColor },
                sourceRows: [...document.querySelectorAll('.modhub-market-source-bar')].map(bar =>
                    [...bar.querySelectorAll('.modhub-market-source-link')].map(link => ({ text: link.textContent, href: link.getAttribute('href') }))),
                cardColors: [...document.querySelectorAll('.modhub-market-card')].map(card => ({ name: card.dataset.modName,
                    color: getComputedStyle(card).color, background: getComputedStyle(card).backgroundColor,
                    title: getComputedStyle(card.querySelector('.modhub-market-title')).color,
                    meta: getComputedStyle(card.querySelector('.modhub-market-meta')).color })) };
        });
        assert.ok(packageState.scrollWidth <= packageState.clientWidth + 1, 'MOD 板块不得横向溢出');
        assert.ok(packageState.buttons.every(button => button.height >= 32 && button.width > 20 && button.left >= 0 && button.right <= width + 1), '操作区应在视口内且触控高度足够');
        await page.screenshot({ path: path.join(evidenceDir, `packages-${width}.png`), fullPage: true });
        await page.locator('#modHubBatchToggle').click();
        await page.locator('.modhub-market-select[data-mod-key="github-layout"]').check();
        for (const input of ['鼠标', '键盘']) {
            const multiCard = sourceCard('multi-source-layout');
            const checkbox = multiCard.locator('.modhub-market-select');
            assert.equal(await checkbox.isChecked(), false);
            const platformLink = multiCard.locator('.modhub-market-source-link').first();
            const popupReady = page.waitForEvent('popup');
            if (input === '鼠标') await platformLink.click();
            else { await platformLink.focus(); await page.keyboard.press('Enter'); }
            const popup = await popupReady;
            await popup.close();
            assert.equal(await checkbox.isChecked(), false, `${input}访问平台不触发卡片多选`);
            const notesLink = multiCard.locator('.modhub-market-acquisition-link');
            if (input === '鼠标') await notesLink.click();
            else { await notesLink.focus(); await page.keyboard.press('Enter'); }
            const notesDialog = page.locator('.modhub-acquisition-dialog');
            await notesDialog.waitFor({ state: 'visible' });
            const originalUrls = index.mods.find(mod => mod.id === 'multi-source-layout').sources.map(source => source.url);
            const reachableUrls = await notesDialog.locator('.modhub-acquisition-source a').evaluateAll(links => links.map(link => link.getAttribute('href')));
            assert.ok(originalUrls.every(url => reachableUrls.includes(url)), '仓库、发布附件和三个 Discord 原帖都仍在安装说明可达');
            assert.equal(await checkbox.isChecked(), false, `${input}打开安装说明不触发卡片多选`);
            sourceInteractions.push({ input, selected: await checkbox.isChecked(), reachableUrls });
            await page.keyboard.press('Escape');
            await notesDialog.waitFor({ state: 'detached' });
        }
        await page.locator('[data-section="spells"]').click();
        await page.locator('[data-section="packages"]').click();
        assert.equal(await page.locator('.modhub-market-select[data-mod-key="github-layout"]').isChecked(), true, '同一会话切回 MOD 保留原勾选');
        await page.locator('[data-section="spells"]').click();
        await page.evaluate(() => {
            window.modHubFixtureReadStarted = false;
            window.modHubLoadModManageState = () => { window.modHubFixtureReadStarted = true;
                return new Promise(resolve => { window.modHubFixtureFinishRead = resolve; }); };
            window.modHubFixtureReopening = window.modHubInitMarket();
        });
        await page.waitForFunction(() => window.modHubFixtureReadStarted);
        assert.equal(await page.locator('#modHubMarketBatchToolbar').isVisible(), false, '咒语重开且管理状态读取延迟时也立即隐藏批量操作');
        assert.equal(await page.evaluate(() => window.modHubMarket.installSelectedMods()), false, '隐藏期间不能执行之前选择的 MOD 安装');
        await page.evaluate(async () => { window.modHubFixtureFinishRead(); await window.modHubFixtureReopening; });
        assert.equal(await page.locator('[data-section="spells"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#modHubMarketBatchToolbar').isVisible(), false);
        assert.equal(await page.locator('#modHubStatusSelect').isVisible(), false);
        assert.equal(await page.locator('#modHubCategoryCapsules').isVisible(), false);
        await page.locator('.modhub-spell-detail-button').click();
        assert.equal(await page.locator('.modhub-spell-body').textContent(), spellBody);
        assert.equal(await page.locator('.modhub-spell-body script').count(), 0);
        await page.locator('.modhub-modal-btn-confirm').click();
        assert.equal(await page.evaluate(() => window.modHubFixtureCopied), spellBody);
        const spellState = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth, modCount: window.modHubMarket.getMarketMods().length,
            actions: [...document.querySelectorAll('.modhub-spell-card button')].map(button => ({ text: button.textContent, height: button.getBoundingClientRect().height })) }));
        assert.ok(spellState.scrollWidth <= spellState.clientWidth + 1, '咒语板块不得横向溢出');
        assert.ok(spellState.actions.every(button => button.height >= 32));
        assert.equal(spellState.modCount, index.mods.length, '复制不会安装正文或改变模组目录');
        await page.screenshot({ path: path.join(evidenceDir, `spells-${width}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        assert.deepEqual(consoleErrors, []);
        results.push({ width, nativeCssPath, nativeCssSha256, browserPath: 'Browser plugin not available', packageState, modalState, spellState, sourceInteractions,
            pageErrors: errors, consoleErrors, isolatedRequests, fixtureOnly: true });
        await context.close();
        console.log(`${width}px 市场资料与咒语布局通过`);
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(results, null, 2));
    await browser?.close();
    console.log(`测试页面证据：${evidenceDir}`);
});
