// ModHub 说明、美化、长按与拖拽交互。
const {
    assert, path, bootJson, createStubElement, createBaseSandbox,
    loadScripts, loadManager, createMockController,
} = require('./helpers');

module.exports = async function() {
    // 说明模块独立加载后仍使用管理器工具、市场回退与 Zip 内置资源。
    {
        const sb = createBaseSandbox({ console: { ...console, warn() {} } });
        loadScripts(sb);
        const body = createStubElement();
        sb.document.getElementById = id => id === 'modHubReadmeBody' ? body : null;
        let localReadme = '# 本地说明', remoteReads = 0;
        const repository = 'https://github.com/ModHubTests/Readme';
        const sourceUrl = `${repository}/blob/main/README.md`;
        const downloadUrl = 'https://raw.githubusercontent.com/ModHubTests/Readme/main/README.md';
        sb.modHubGetGui = () => ({ getModTReadMe: async () => { throw new Error('不得调用旧 GUI 读取可选说明'); } });
        sb.modHubGetModInfo = () => ({
            bootJson: { name: '说明测试', version: '2.3.4', author: '<测试者>', additionFile: ['README.md'] },
            zip: { file: () => ({ async: async () => localReadme }) },
        });
        sb.modHubMarket.findMarketModByLocalName = () => ({ githubUrl: repository });
        sb.modHubMarket.fetchGithubReadme = async url => {
            remoteReads++;
            assert.equal(url, repository, '线上回退必须请求当前模组仓库');
            return { markdown: '# 线上说明\n[帮助](./guide.md)\n![配图](./images/demo.png)', sourceUrl, downloadUrl };
        };
        await sb.modHubLoadReadme('说明测试');
        assert.ok(body.innerHTML.includes('本地说明'), '本地说明优先展示');
        assert.ok(body.innerHTML.includes('&lt;测试者&gt;'), '说明模块必须继续使用共享 HTML 转义');
        assert.equal(remoteReads, 0, '有本地说明时不请求线上 README');
        for (const emptyReadme of [null, '<<no ReadMe>>']) {
            localReadme = emptyReadme;
            await sb.modHubLoadReadme('说明测试');
            assert.ok(body.innerHTML.includes('线上说明') && body.innerHTML.includes('GitHub 仓库 README'), '无说明及占位说明必须回退线上来源');
            assert.ok(body.innerHTML.includes(`${repository}/blob/main/guide.md`), '线上相对链接以来源页面解析');
            assert.ok(body.innerHTML.includes('data-original-src="https://raw.githubusercontent.com/ModHubTests/Readme/main/images/demo.png"'), '线上相对配图以下载地址解析');
        }
        assert.equal(remoteReads, 2, '两种空说明均执行线上回退');
        sb.modHubMarket.fetchGithubReadme = async () => { throw new Error('测试离线'); };
        await sb.modHubLoadReadme('说明测试');
        assert.ok(body.innerHTML.includes('说明文档暂时无法读取') && body.innerHTML.includes('2.3.4'), '线上读取失败后仍展示本地模组元数据并区分读取失败与文档不存在');
        assert.ok(!body.innerHTML.includes('读取文档失败'), '网络故障不能中断整份说明视图');

        const markdown = sb.modHubRenderMarkdown([
            '<script>不可信内容</script>',
            '`<行内代码>`',
            '```\n<代码块>\n```',
            '![状态](https://img.shields.io/badge/ModHub-ready-blue)',
            '<img src="./images/demo.png" alt="配图" onerror="危险操作()">',
            '[帮助](./guide.md)',
        ].join('\n'), { escapeRawHtml: true, repositoryUrl: repository, remoteImageBaseUrl: downloadUrl, remoteLinkBaseUrl: sourceUrl });
        assert.ok(markdown.includes('&lt;script&gt;') && !markdown.includes('<script>'), '远程原始 HTML 必须转义');
        assert.ok(markdown.includes('&lt;行内代码&gt;') && markdown.includes('&lt;代码块&gt;'), '代码保护仍使用跨模块转义工具');
        assert.ok(markdown.includes('data:image/svg+xml;utf8,'), '静态徽章必须通过模块内颜色常量生成离线 SVG');
        const badge = sb.modHubRenderMarkdown('![状态](https://img.shields.io/badge/ModHub-ready-blue)');
        assert.ok(!badge.includes('data-remote-image-url'), '已经离线生成的徽章不得再次请求外网');
        assert.ok(markdown.includes('<img ') && !markdown.includes('onerror='), '远程图片标签必须净化后保留');
        assert.ok(markdown.includes(`${repository}/blob/main/guide.md`), 'Markdown 相对链接解析保持有效');

        const imageEntry = { dir: false, async: async () => 'aW1hZ2U=' };
        const zip = { file: () => null, files: { 'images/示例.PNG': imageEntry } };
        const imagePath = './images/%E7%A4%BA%E4%BE%8B.png';
        assert.equal(sb.modHubFindZipImageEntry(zip, imagePath).entry, imageEntry, 'Zip 图片查找保留 URI 解码和大小写容错');
        const image = createStubElement('img');
        image.getAttribute = name => name === 'data-local-mod-path' ? imagePath : null;
        body.querySelectorAll = selector => selector === 'img[data-local-mod-path]' ? [image] : [];
        sb.modHubGetModInfo = () => ({ zip });
        await sb.modHubSetupReadmeImages(body, '说明测试');
        assert.equal(image.src, 'data:image/png;base64,aW1hZ2U=', '本地图片应跨模块解析为 Base64，无需网络');
        assert.equal(body._listeners.error.length, 1, '反复切换说明不得累积图片错误监听');
    }

    // 空声明、其他附加文件和已释放包都属于无本地说明，不能调用会输出整份模组的旧 GUI。
    {
        const sb = loadManager({ console: { error() {}, warn() {} } });
        let guiReads = 0, zipReads = 0;
        let additionFile;
        const reader = {
            getModInfo: () => ({ name: '说明测试' }),
            getZipFile: () => ({ file: path => path === 'docs/ReadMe.zh.md' ? { async: async () => '# 包内说明' } : null }),
            get zip() { throw new Error('不得触发已释放包的 zip getter'); },
        };
        sb.modHubGetGui = () => ({
            gModUtils: { getModZip: () => { zipReads++; return reader; } },
            getModTReadMe: () => { guiReads++; throw new Error('旧 GUI 不应调用'); },
        });
        sb.modHubGetModInfo = () => ({ bootJson: { name: '说明测试', additionFile } });
        for (const files of [undefined, null, [], {}, 'README.md', [null, 1, {}, 'LICENSE']]) {
            additionFile = files;
            assert.equal(await sb.modHubReadLocalReadme('说明测试'), null);
        }
        assert.equal(zipReads, 0, '无说明声明时也无需查找包体');
        additionFile = ['docs/ReadMe.zh.md'];
        assert.equal(await sb.modHubReadLocalReadme('说明测试'), '# 包内说明', '说明应支持子目录与大小写变体');
        reader.getModInfo = () => ({ bootJson: { name: '另一模组' } });
        assert.equal(await sb.modHubReadLocalReadme('说明测试'), null, '别名重定向不得读取其他模组的说明');
        reader.getModInfo = () => ({ name: '说明测试' });
        reader.getZipFile = () => null;
        assert.equal(await sb.modHubReadLocalReadme('说明测试'), null, '包体释放后不能再调用带报错副作用的 getter');
        assert.equal(guiReads, 0);
        assert.equal(sb._modHubStartupErrors.length, 0, '可选说明缺失不得污染启动日志');
    }

    // 慢请求失败或完成时，不能覆盖后来选择的说明；本地读取失败仍可在线回退。
    {
        const sb = createBaseSandbox({ console: { error() {}, warn() {} } });
        loadScripts(sb);
        const body = createStubElement();
        sb.document.getElementById = () => body;
        sb.modHubGetModInfo = name => ({ bootJson: { name, repository: `https://github.com/ModHubTests/${name}` } });
        sb.modHubMarket.findMarketModByLocalName = () => null;
        sb.modHubMarket.loadMarketData = async () => [];
        sb.modHubReadLocalReadme = async () => { throw new Error('说明解压失败'); };
        let finishFirst, startedFirst;
        const started = new Promise(resolve => { startedFirst = resolve; });
        sb.modHubMarket.fetchGithubReadme = url => url.endsWith('/First')
            ? new Promise(resolve => { finishFirst = resolve; startedFirst(); })
            : Promise.resolve({ markdown: '# 当前说明', isStale: true });
        const first = sb.modHubLoadReadme('First');
        await started;
        await sb.modHubLoadReadme('Second');
        const current = body.innerHTML;
        assert.ok(current.includes('当前说明') && current.includes('上次成功读取'), '本地失败后从 boot 仓库回退且标明过期缓存');
        finishFirst({ markdown: '# 已过时的选择' });
        await first;
        assert.equal(body.innerHTML, current, '迟到的请求不能覆盖当前选择');
        assert.equal(sb._modHubStartupErrors.length, 0);
    }

    // 旧说明的本地图片解码完成后，不得再查询或处理后来文档里的远程图片。
    {
        const sb = loadManager({ console: { error() {}, warn() {}, log() {} } });
        let finishImage, current = true, remoteReads = 0;
        const pendingImage = new Promise(resolve => { finishImage = resolve; });
        const zip = {
            file: path => path === 'slow.png' ? { async: () => pendingImage } : null,
            files: { 'logo.png': { dir: false, async: async () => 'OLD_MOD_IMAGE' } },
        };
        sb.modHubGetModInfo = () => ({ zip });
        sb.fetch = async () => { remoteReads++; throw new Error('旧文档不得继续请求图片'); };
        const body = createStubElement();
        const oldImage = createStubElement('img');
        oldImage.getAttribute = () => 'slow.png';
        const newImage = createStubElement('img');
        newImage.src = '新文档原图';
        newImage.dataset.originalSrc = 'https://example.test/logo.png';
        newImage.getAttribute = () => 'https://example.test/logo.png';
        let remoteImages = [];
        body.querySelectorAll = selector => selector === 'img[data-local-mod-path]' ? [oldImage] : remoteImages;
        const previous = sb.modHubSetupReadmeImages(body, '旧模组', () => current);
        await new Promise(setImmediate);
        current = false;
        remoteImages = [newImage];
        finishImage('OLD_LOCAL_IMAGE');
        await previous;
        assert.equal(newImage.src, '新文档原图', '旧 Zip 不得污染新说明的同名图片');
        assert.equal(oldImage.src, undefined, '失效文档的延迟解码不得继续更新图片');
        assert.equal(remoteReads, 0, '切换模组后旧任务不得开始新的网络请求');
    }

    // 图片拒绝和受控超时都只降级为占位，不能污染启动错误；旧浏览器也须结束等待。
    for (const timeout of [false, true]) {
        const sb = loadManager({ console: { error() {}, warn() {}, log() {} } });
        const body = createStubElement();
        const image = createStubElement('img');
        let fallbackCount = 0, rejectFetch;
        image.dataset.originalSrc = 'https://example.test/image.png';
        image.getAttribute = () => 'https://example.test/image.png';
        image.replaceWith = () => { fallbackCount++; };
        body.querySelectorAll = selector => selector === 'img[data-remote-image-url]' ? [image] : [];
        sb.modHubGetModInfo = () => null;
        sb.modHubGetGui = () => null;
        sb.AbortController = undefined;
        const timers = [];
        let cleared = 0;
        sb.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timers.push(callback); return timers.length; };
        sb.clearTimeout = () => { cleared++; };
        sb.fetch = () => timeout ? new Promise((_, reject) => { rejectFetch = reject; }) : Promise.reject(new TypeError('Failed to fetch'));
        const pending = sb.modHubSetupReadmeImages(body, '图片测试');
        if (timeout) {
            await new Promise(setImmediate);
            assert.equal(timers.length, 1, '缺少 AbortController 时图片仍须安装超时计时器');
            timers[0]();
        }
        await pending;
        if (timeout) {
            rejectFetch(new Error('超时后底层请求才失败'));
            await new Promise(setImmediate);
        }
        assert.equal(fallbackCount, 1, '图片失败只能替换一次占位');
        assert.equal(sb._modHubStartupErrors.length, 0, '图片网络故障不得升级为加载错误');
        assert.equal(cleared, 1, '图片完成或失败都必须清理超时计时器');
    }

    // 美化模块沿用主文件的操作锁与失败恢复，并保留可选 Addon 的降级行为。
    {
        const controller = createMockController({ enabled: ['ModA'], disabled: ['ModB'] });
        const sb = loadManager({ modModLoadController: controller, console: { error() {}, warn() {}, log() {} } });
        await sb.modHubLoadModManageState();
        assert.equal(await sb.modHubLoadBeautyState(), false, '缺少美化 Addon 时应正常降级');
        assert.equal(sb._modHubBeautyState, null, '缺少 Addon 不得留下失效美化状态');
        assert.equal(sb._modHubBeautyLoaded, true, '缺少 Addon 仍应结束本次初始化');

        const items = [
            { type: '基础图像', modRef: { name: 'Builtin' } },
            { type: '已启用模组图像', modRef: { name: 'ModA' } },
            { type: '未启用模组图像', modRef: { name: 'ModB' } },
        ];
        let savedOrder = ['基础图像'], saves = 0, failSave = false;
        const addon = sb.addonBeautySelectorAddon = {
            getTypeOrder: () => items,
            typeOrderUsed: [items[0]],
            saveOrder(order) {
                saves++;
                if (failSave) return false;
                savedOrder = Array.from(order);
                return true;
            },
        };
        assert.equal(await sb.modHubLoadBeautyState(), true, '美化模块应能读取主文件提供的启用列表');
        assert.deepEqual(savedOrder, ['基础图像', '已启用模组图像'], '只自动启用已启用模组所属的美化并保存');
        assert.deepEqual(Array.from(sb._modHubBeautyState.disabledList, item => item.type), ['未启用模组图像'], '禁用模组所属美化不得自动启用');
        assert.equal(await sb.modHubToggleBeauty('已启用模组图像', false), false, '自动管理的美化不得手动禁用');
        assert.equal(saves, 1, '拒绝手动禁用后不得额外写入美化顺序');

        assert.equal(await sb.modHubMoveBeauty(1, 'top'), true, '跨模块移动应成功提交');
        assert.deepEqual(savedOrder, ['已启用模组图像', '基础图像'], '移动后按覆盖优先级保存正确顺序');
        assert.deepEqual(Array.from(addon.typeOrderUsed, item => item.type), savedOrder, 'Addon 的生效顺序必须与保存结果同步');
        failSave = true;
        assert.equal(await sb.modHubMoveBeauty(0, 'bottom'), false, '美化保存失败必须返回失败');
        assert.equal(sb._modHubManagerBusy, false, '美化保存失败后必须释放共享操作锁');
        assert.equal(sb._modHubManagerSaveFailed, true, '美化保存失败必须保留失败状态');
        assert.equal(sb._modHubManagerStateUncertain, false, '成功重读实际配置后不应标记为未知状态');
        assert.deepEqual(savedOrder, ['已启用模组图像', '基础图像'], '失败写入不得改变已保存顺序');
        assert.deepEqual(Array.from(sb._modHubBeautyState.enabledList, item => item.type), savedOrder, '失败后必须从 Addon 恢复已保存顺序');
        assert.deepEqual(Array.from(addon.typeOrderUsed, item => item.type), savedOrder, '失败后 Addon 顺序也必须保持原样');
    }

    // 长按消费本次手势，释放与浏览器随后合成的点击不能再触发短按。
    {
        const sb = createBaseSandbox();
        loadScripts(sb);
        const timers = new Map();
        let timerId = 0;
        sb.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
        sb.clearTimeout = id => timers.delete(id);
        for (const [start, end, event] of [
            ['mousedown', 'mouseup', { button: 0, clientX: 0, clientY: 0 }],
            ['touchstart', 'touchend', { touches: [{ clientX: 0, clientY: 0 }], cancelable: true }],
        ]) {
            const button = createStubElement('button');
            let shortPresses = 0, longPresses = 0;
            sb._modHubLongPressActive = false;
            sb._modHubLastLongPressTimestamp = 0;
            timers.clear();
            sb.modHubBindLongPressMove(button, () => shortPresses++, () => longPresses++);
            button.dispatch(start, event);
            button.dispatch(end, event);
            assert.equal(shortPresses, 1, `${start} 正常短按应生效`);
            assert.equal(timers.size, 0, '短按释放必须清理长按定时器');
            button.dispatch(start, event);
            const timer = [...timers.values()].find(item => item.delay === 450);
            assert.ok(timer, '按下后应启动长按判定');
            timer.callback();
            button.dispatch(end, event);
            button.dispatch('click');
            assert.equal(longPresses, 1, `${start} 应只触发一次长按`);
            assert.equal(shortPresses, 1, `${end} 与合成点击不能重复触发短按`);
        }
    }

    // 每种拖拽结束事件都清理持续滚动；只有完成投放才提交重排。
    for (const [end, listType, touch, shouldReorder] of [
        ['drop', 'side', false, true], ['dragend', 'side', false, false],
        ['touchend', 'beauty', true, true], ['touchcancel', 'beauty', true, false],
    ]) {
        const sb = createBaseSandbox();
        loadScripts(sb);
        const frames = new Map(), reordered = [];
        let frameId = 0, scrollDistance = 0;
        sb.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
        sb.cancelAnimationFrame = id => frames.delete(id);
        sb.innerHeight = 800;
        sb.scrollBy = (x, y) => { scrollDistance += y; };
        sb.modHubReorderList = async (...args) => { reordered.push(args); };
        const list = createStubElement('ul'), handle = createStubElement('span');
        const items = [0, 1].map(index => {
            const item = createStubElement('li');
            item.dataset.index = String(index);
            item.closest = selector => selector.startsWith('li.modhub-item') ? item : null;
            item.getBoundingClientRect = () => ({ top: touch ? 0 : 740, height: 40 });
            return item;
        });
        list.querySelectorAll = selector => selector === '.modhub-drag-handle' ? [handle] : items;
        handle.closest = () => items[0];
        sb.document.elementFromPoint = () => items[1];
        const emit = async (element, type, event = {}) => {
            for (const callback of element._listeners[type] || []) await callback({ target: element, preventDefault() {}, ...event });
        };
        sb.modHubBindDragSort(list, listType);
        if (touch) {
            await emit(handle, 'touchstart', { touches: [{ clientX: 0, clientY: 100 }] });
            await emit(handle, 'touchmove', { touches: [{ clientX: 0, clientY: 10 }], cancelable: true });
        } else {
            await emit(list, 'dragstart', { target: items[0] });
            await emit(list, 'dragover', { target: items[1], clientY: 790 });
        }
        assert.equal(frames.size, 1, `${end} 前应启动边缘自动滚动`);
        const [pendingId, frame] = frames.entries().next().value;
        frames.delete(pendingId);
        frame();
        assert.ok(Math.abs(scrollDistance) > 0 && frames.size === 1, '指针静止在边缘时仍须滚动并继续调度 RAF');
        await emit(touch ? handle : list, end);
        assert.equal(frames.size, 0, `${end} 必须清理 RAF`);
        assert.deepEqual(reordered, shouldReorder ? [[listType, 0, 1, !touch]] : [], `${end} 必须正确提交或取消重排`);
    }

};
