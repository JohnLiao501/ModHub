// 使用真实 DoL 样式与模拟目录核对市场布局；不运行游戏剧情或第三方模组。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('C:/Users/JohnLiao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const evidenceDir = process.env.MODHUB_BROWSER_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'modhub-market-content-'));
fs.mkdirSync(evidenceDir, { recursive: true });
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
const updateCase = { id: 'wraith-reflection', identityId: 'wraith-reflection', name: '怨灵的倒影',
    bootNames: ["Wraith'sReflection"], repositoryKeys: ['Water2311/WraithsReflection'],
    githubUrl: 'https://github.com/Water2311/WraithsReflection', version: '1.3.3', versionSource: 'github',
    author: '水墨儿（悠飘过去了）', category: '玩法与内容', tags: ['恋爱'], updateDate: '2026-10-05',
    description: '象牙怨灵的恋爱拓展，详细内容请在 GitHub 查看。（区别于外网的幽灵恋爱）' };
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
    updateCase,
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
            window.modHubFixtureHistoryRequests = [];
            window.fetch = async value => {
                const url = new URL(String(value));
                if (url.pathname !== '/mod-releases') return { ok: true, json: async () => data };
                const mod = data.mods.find(item => item.id === url.searchParams.get('id'));
                window.modHubFixtureHistoryRequests.push(mod.id);
                const assetName = 'WraithsReflection-v1.3.3.zip';
                const releases = mod.id === 'wraith-reflection' ? [{ tagName: 'v1.3.3', name: 'v1.3.3', version: '1.3.3',
                    htmlUrl: `${mod.githubUrl}/releases/tag/v1.3.3`, publishedAt: '2026-10-05T00:00:00Z',
                    assets: [{ name: assetName, size: 100, downloadUrl: `${mod.githubUrl}/releases/download/v1.3.3/${assetName}` }] }] : [];
                return { ok: true, json: async () => ({ schemaVersion: 1, id: mod.id, sourceUrl: mod.githubUrl,
                    page: Number(url.searchParams.get('page')), hasMore: false, communityRevision: data.communityRevision,
                    fetchedAt: new Date().toISOString(), releases }) };
            };
            window.modHubNotifyUpdateState = () => {};
            window.StartConfig = { version: '' };
            window.modHubShowToast = () => {};
            window.modHubFixtureCopied = null;
            Object.defineProperty(navigator, 'clipboard', { configurable: true,
                value: { writeText: async body => { window.modHubFixtureCopied = body; } } });
        }, index);
        await page.evaluate(({ cases, update }) => {
            const local = cases.filter(item => Object.hasOwn(item, 'local')).map(item => ({ name: item.id,
                bootJson: { name: item.id, version: item.local, repository: `https://github.com/VersionTests/${item.id}` } }));
            local.push({ name: update.bootNames[0], bootJson: { name: update.bootNames[0], version: '1.3.2', repository: update.githubUrl } });
            window.modHubGetGui = () => ({ gModUtils: { getModList: () => local, getModListNameNoAlias: () => local.map(item => item.name) } });
            window.modHubGetModInfo = name => local.find(item => item.name === name) || null;
        }, { cases: versionCases, update: updateCase });
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
        assert.equal(await page.locator('.modhub-market-acquisition-link').count(), 0, '市场卡片移除安装说明入口');
        const sourceNames = await page.locator('.modhub-market-source-bar').evaluateAll(bars => bars.map(bar =>
            [...bar.querySelectorAll('.modhub-market-source-link')].map(link => link.textContent)));
        assert.ok(sourceNames.every(names => names.length === new Set(names).size), '每张卡片来源行的平台名称只出现一次');
        const noSource = sourceCard('no-source-layout').locator('.modhub-market-source-bar');
        assert.match(await noSource.innerText(), /暂无来源链接/);
        assert.equal(await noSource.locator('a').count(), 0, '没有有效URL时不伪造来源入口');
        const directSource = sourceCard('github-layout');
        assert.equal(await directSource.locator('.modhub-market-source-link').getAttribute('href'), 'https://github.com/Owner/Direct');
        assert.equal(await directSource.locator('.modhub-market-acquisition-link').count(), 0, '没有额外资料时不显示安装说明入口');
        const versionPalette = await page.evaluate(() => Object.fromEntries(['gold', 'green', 'purple'].map(tone => {
            const element = document.createElement('span'); element.className = tone; document.body.appendChild(element);
            const color = getComputedStyle(element).color; element.remove(); return [tone, color];
        }).concat([['body', getComputedStyle(document.body).color]])));
        assert.notEqual(versionPalette.purple, versionPalette.body, '最新版本紫色区别于普通正文');
        for (const item of versionCases) {
            const card = page.locator(`[data-mod-name="${item.name}"]`);
            const versions = card.locator('.modhub-market-versions');
            assert.ok((await versions.innerText()).includes(`最新版本：${item.latest}`));
            if (Object.hasOwn(item, 'local')) assert.ok((await versions.innerText()).includes(`已安装版本：${item.local ? 'v' + item.local : '未知'}`));
            else assert.ok(!(await versions.innerText()).includes('已安装版本：'));
            const bounds = await versions.locator('span').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
                    tone: element.className, color: getComputedStyle(element).color };
            }));
            assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width + 1 && rect.width > 40 && rect.height > 10), '当前与最新版本信息应在视口内完整换行');
            assert.equal(bounds.at(-1).tone, 'purple');
            assert.equal(bounds.at(-1).color, versionPalette.purple, '最新版本字段使用真实 DoL 紫色');
            if (Object.hasOwn(item, 'local')) {
                const tone = item.id === 'version-same' ? 'green' : 'gold';
                assert.equal(bounds[0].tone, tone);
                assert.equal(bounds[0].color, versionPalette[tone], '仅目录最新版相同的已安装字段使用绿色，其他状态使用金色');
            }
        }
        const external = page.locator('[data-mod-name="外部资源"]');
        assert.equal(await external.locator('.modhub-market-actions a').count(), 0, '主页访问统一由来源文字链接承担');
        assert.equal(await external.locator('.modhub-market-actions button').count(), 0);
        assert.equal(await external.locator('.modhub-market-source-link').getAttribute('href'), 'https://tieba.baidu.com/p/123');
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
            sourceInteractions.push({ input, selected: await checkbox.isChecked(), href: await platformLink.getAttribute('href') });
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
        await page.locator('#modHubToast').waitFor({ state: 'hidden' });
        await page.evaluate(() => {
            window.StartConfig.version = '0.5.12.13';
            window.modHubFixtureInstalls = [];
            window.modHubMarketInstaller = { install: async (mod, options) => {
                window.modHubFixtureInstalls.push({ id: mod.id, name: mod._matchedLocal?.name,
                    localVersion: mod._matchedLocal?.version, hasRestoreContext: Boolean(options.restoreContext) });
                return false;
            } };
        });
        await page.locator('[data-section="packages"]').click();
        await page.evaluate(async () => {
            await Promise.all(window.modHubMarket.getMarketMods().map(mod => window.modHubMarket.getModUpdateInfo(mod).promise));
            window.modHubMarket.renderMarketCards();
        });
        const updateCard = page.locator('[data-mod-name="怨灵的倒影"]');
        const updateButton = updateCard.locator('.btn-market-update');
        assert.equal(await updateCard.locator('.badge-update').innerText(), '发现新版，适配待核对');
        assert.equal(await updateButton.innerText(), '选择更新版本');
        assert.ok(await updateButton.isEnabled());
        assert.match(await updateCard.locator('.modhub-market-versions').innerText(), /已安装版本：v1\.3\.2/);
        assert.match(await updateCard.locator('.modhub-market-versions').innerText(), /最新版本：v1\.3\.3/);
        assert.match(await updateCard.innerText(), /适用的游戏版本尚未确定/);
        assert.ok(!(await updateCard.innerText()).includes('未找到适配当前游戏的版本'));
        await updateCard.scrollIntoViewIfNeeded();
        const updateState = await updateCard.evaluate(card => {
            const mod = window.modHubMarket.getMarketMods().find(item => item.id === 'wraith-reflection');
            const release = window.modHubMarket.getModUpdateInfo(mod).release;
            const rect = element => { const value = element.getBoundingClientRect(); return {
                left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
            return { gameVersion: window.modHubMarketVersions.getGameVersion(), status: window.modHubMarket.checkModInstallStatus(mod),
                candidateVersion: release?.version, candidateAsset: release?.assetName, compatibility: release?.compatibility,
                card: rect(card), badge: rect(card.querySelector('.badge-update')), button: rect(card.querySelector('.btn-market-update')),
                versions: [...card.querySelectorAll('.modhub-market-versions span')].map(element => ({ ...rect(element),
                    tone: element.className, color: getComputedStyle(element).color })),
                clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
                historyRequests: window.modHubFixtureHistoryRequests };
        });
        assert.equal(updateState.gameVersion, '0.5.12.13');
        assert.equal(updateState.status, 'update_available');
        assert.equal(updateState.candidateVersion, '1.3.3');
        assert.equal(updateState.candidateAsset, 'WraithsReflection-v1.3.3.zip');
        assert.equal(updateState.compatibility.evidence, 'unknown', '真实候选构建不能把无声明包识别为名称适配');
        assert.ok(updateState.historyRequests.includes(updateCase.id), '新版发现应读取历史发布');
        assert.ok(updateState.scrollWidth <= updateState.clientWidth + 1, '未知适配新版卡片不得横向溢出');
        assert.ok([updateState.badge, updateState.button, ...updateState.versions].every(rect =>
            rect.left >= updateState.card.left && rect.right <= updateState.card.right + 1 && rect.width > 20 && rect.height > 10
            && rect.top >= 0 && rect.bottom <= 901), '新版徽章、按钮和两份版本字样完整可见');
        assert.ok(updateState.button.height >= 32, '更新按钮保留触控面积');
        assert.equal(updateState.versions[0].tone, 'gold');
        assert.equal(updateState.versions[0].color, versionPalette.gold, '有新版时已安装版本显示金色');
        assert.equal(updateState.versions[1].tone, 'purple');
        assert.equal(updateState.versions[1].color, versionPalette.purple);
        await updateCard.screenshot({ path: path.join(evidenceDir, `unknown-update-${width}.png`) });
        await updateButton.click();
        await page.waitForFunction(() => window.modHubFixtureInstalls.length === 1 && !window.modHubMarket.isInstallBusy());
        const updateInteractions = await page.evaluate(() => window.modHubFixtureInstalls);
        assert.deepEqual(updateInteractions, [{ id: updateCase.id, name: "Wraith'sReflection", localVersion: '1.3.2', hasRestoreContext: true }],
            '选择更新版本通过原有安装器和同一还原上下文路由，不真实下载安装');
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'src/javascript/modhub-market-install.js'), 'utf8') });
        await page.locator('.modhub-market-update-all').click();
        const batchDialog = page.locator('.modhub-version-dialog');
        await page.waitForFunction(() => {
            const select = document.querySelector('.modhub-version-batch-select');
            return select?.value && !select.disabled && !document.querySelector('.modhub-modal-btn-confirm')?.disabled;
        });
        assert.equal(await batchDialog.locator('.modhub-modal-title').innerText(), '选择全部更新版本');
        assert.equal(await batchDialog.locator('.modhub-version-batch-select').count(), 1);
        assert.match(await batchDialog.innerText(), /作者未声明支持的游戏版本，已默认选择最新版本；安装前需确认适配风险/);
        assert.ok(await batchDialog.locator('.modhub-modal-btn-confirm').isEnabled());
        await batchDialog.evaluate(async dialog => { await Promise.all(dialog.getAnimations().map(animation => animation.finished.catch(() => {}))); });
        const batchUpdateState = await batchDialog.evaluate(dialog => {
            const rect = element => { const value = element.getBoundingClientRect(); return {
                left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
            const select = dialog.querySelector('.modhub-version-batch-select');
            return { selectedKey: select.value, selectedText: select.selectedOptions[0].textContent,
                dialog: rect(dialog), header: rect(dialog.querySelector('.modhub-modal-header')), footer: rect(dialog.querySelector('.modhub-modal-footer')),
                select: rect(select), clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
        });
        assert.match(batchUpdateState.selectedText, /1\.3\.3.*适配待核对/);
        assert.ok(batchUpdateState.selectedKey.includes('WraithsReflection-v1.3.3.zip'), '全部更新自动预选单一无声明新版');
        assert.ok([batchUpdateState.dialog, batchUpdateState.header, batchUpdateState.footer, batchUpdateState.select].every(rect =>
            rect.left >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= 901), '全部更新弹窗和预选控件完整位于视口内');
        assert.ok(batchUpdateState.scrollWidth <= batchUpdateState.clientWidth + 1, '全部更新预选弹窗不得横向溢出');
        await page.screenshot({ path: path.join(evidenceDir, `batch-update-default-${width}.png`), fullPage: false });
        await batchDialog.locator('.modhub-modal-btn-cancel').click();
        await batchDialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => !window.modHubMarket.isInstallBusy());
        assert.equal(await page.evaluate(() => window.modHubMarket.batchInstallState.running), false, '取消全部更新后释放批量操作锁');
        await updateCard.locator('.btn-market-ignore[data-ignore-mode="once"]').click();
        assert.equal(await updateCard.locator('.badge-ignored').innerText(), '已忽略本次');
        const ignoredUpdate = await updateCard.locator('.modhub-market-versions span').first().evaluate(element => ({
            tone: element.className, color: getComputedStyle(element).color }));
        assert.equal(ignoredUpdate.tone, 'gold');
        assert.equal(ignoredUpdate.color, versionPalette.gold, '忽略更新不能把旧版显示为绿色');
        assert.deepEqual(errors, []);
        assert.deepEqual(consoleErrors, []);
        results.push({ width, nativeCssPath, nativeCssSha256, browserPath: 'Browser plugin not available', packageState, spellState, sourceInteractions,
            versionPalette, updateState, updateInteractions, batchUpdateState, ignoredUpdate, pageErrors: errors, consoleErrors, isolatedRequests, fixtureOnly: true });
        await context.close();
        console.log(`${width}px 市场资料、咒语、未知适配新版与全部更新预选通过`);
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(results, null, 2));
    await browser?.close();
    console.log(`测试页面证据：${evidenceDir}`);
});
