// 样式兼容防护只恢复本次加载的完整 ModHub 样式，不修改其他模组。
const { assert, fs, path, srcRoot, createStubElement, createBaseSandbox, loadScripts } = require('./helpers');

const markers = ['--modhub-base-styles', '--modhub-market-styles', '--modhub-overrides-styles'];
const files = ['stylesheet/modhub.css', 'stylesheet/modhub-market.css', 'stylesheet/modhub-overrides.css'];
const items = files.map((name, index) => ({ name, content: `:root { ${markers[index]}: 1; }\n.modhub-style-${index} { order: ${index}; }` }));
const fullText = items.map(item => item.content).join('\n');

function harness(options = {}) {
    const head = createStubElement('head');
    const appendChild = head.appendChild;
    head.appendChild = child => {
        child.parentNode?.removeChild(child);
        return appendChild(child);
    };
    Object.defineProperty(head, 'lastChild', { get: () => head.children.at(-1) || null });
    const story = createStubElement('style');
    story.textContent = options.story ?? fullText;
    const thirdParty = createStubElement('style');
    thirdParty.id = '第三方样式';
    thirdParty.textContent = '.third-party { color: red; }';
    head.appendChild(thirdParty);
    const hooks = new Map();
    const events = new Map();
    const warnings = [];
    const mod = Object.hasOwn(options, 'mod') ? options.mod : {
        name: 'ModHub', bootJson: { name: 'ModHub', styleFileList: [...files] },
        cache: { styleFileItems: { items: items.map(item => ({ ...item })) } },
    };
    const controller = { addLifeTimeCircleHook: (name, hook) => hooks.set(name, hook) };
    const sandbox = createBaseSandbox({
        console: { warn: (...args) => warnings.push(args) },
        modUtils: options.utils || { getMod: () => mod, getModLoadController: () => controller },
        getComputedStyle: () => ({ getPropertyValue: name => {
            const content = [options.active ?? '', ...head.children.filter(node => node.tagName === 'STYLE' && !node.disabled && !node.media).map(node => node.textContent)].join('\n');
            return new RegExp(`${name}\\s*:\\s*1\\s*;`).test(content) ? ' 1 ' : '';
        } }),
    });
    sandbox.jQuery = () => ({ one: (name, handler) => events.set(name, handler) });
    sandbox.document.head = head;
    sandbox.document.getElementById = id => head.children.find(node => node.id === id) || null;
    sandbox.document.querySelectorAll = selector => selector === 'tw-storydata style' ? [story] : [];
    loadScripts(sandbox, ['javascript/modhub-style.js']);
    return { sandbox, head, story, thirdParty, hooks, events, warnings, mod,
        ensure: sandbox.modHubEnsureStyles, fallback: () => sandbox.document.getElementById('modHubStylesFallback') };
}

module.exports = function() {
    files.forEach((file, index) => {
        assert.match(fs.readFileSync(path.join(srcRoot, file), 'utf8'), new RegExp(`:root\\s*\\{\\s*${markers[index]}\\s*:\\s*1\\s*;\\s*\\}`), '实际样式文件必须声明对应的生效标记');
    });
    // 加载器结束时原合并样式尚未应用，不能因此误判缺失。
    {
        const h = harness();
        assert.equal(h.fallback(), null, '早期注册不得提前插入样式');
        assert.deepEqual([...h.hooks.keys()], ['modHubStyles']);
        assert.deepEqual([...h.events.keys()], [':storyready.modHubStyles']);
        assert.equal(h.hooks.get('modHubStyles').ModLoaderLoadEnd(), true);
        assert.equal(h.fallback(), null, '正常合并样式不创建恢复节点');
        assert.equal(h.warnings.length, 0);
        assert.equal(h.thirdParty.textContent, '.third-party { color: red; }');
    }
    {
        const h = harness({ story: '', active: fullText });
        const originalOrder = [...h.head.children];
        assert.equal(h.events.get(':storyready.modHubStyles')(), true);
        assert.equal(h.ensure({ active: true }), true);
        assert.equal(h.fallback(), null, '正常活跃样式不创建恢复节点');
        assert.deepEqual(h.head.children, originalOrder, '正常无恢复节点时不移动已有样式');
    }
    {
        const h = harness({ story: '' });
        assert.equal(h.ensure({ active: false }), true);
        const fallback = h.fallback();
        const residual = createStubElement('style');
        residual.textContent = items[0].content;
        h.head.appendChild(residual);
        assert.equal(h.head.lastChild, residual, '模拟 SugarCube 在恢复节点后生成残余样式');
        assert.equal(h.ensure({ active: true }), true);
        assert.equal(h.head.lastChild, fallback, '标记已生效时仍将恢复样式移到末尾，保持完整层叠顺序');
        assert.equal(h.head.children.length, 3);
        assert.equal(h.head.children.filter(node => node === fallback).length, 1, '移动节点不生成重复样式');
        assert.equal(residual.textContent, items[0].content, '移动恢复节点不修改残余样式');
        assert.equal(h.ensure({ active: true }), true);
        assert.equal(h.head.lastChild, fallback);
        assert.equal(h.head.children.length, 3);
    }

    // 整组或任意一份丢失都按完整清单一次恢复，保留层叠顺序。
    for (const story of ['', ...items.map((_, missing) => items.filter((_, index) => index !== missing).map(item => item.content).join('\n'))]) {
        const h = harness({ story });
        const thirdParty = h.thirdParty.textContent;
        assert.equal(h.ensure({ active: false }), true);
        assert.equal(h.fallback().textContent, fullText);
        assert.equal(h.head.children.length, 2);
        const fallback = h.fallback();
        assert.equal(h.ensure({ active: false }), true);
        assert.equal(h.ensure({ active: true }), true);
        assert.equal(h.fallback(), fallback, '重复核验复用恢复节点');
        assert.equal(h.head.children.length, 2);
        assert.equal(h.story.textContent, story, '不改写原合并样式');
        assert.equal(h.thirdParty.textContent, thirdParty, '不改写第三方节点');
    }
    {
        const mod = { name: 'ModHub', bootJson: { name: 'ModHub', styleFileList: [...files].reverse() },
            cache: { styleFileItems: { items: items.map(item => ({ ...item })) } } };
        const h = harness({ mod, story: '' });
        mod.cache.styleFileItems.items.length = 0;
        assert.equal(h.ensure(), true, '后续缓存释放不影响早期快照');
        assert.equal(h.fallback().textContent, [...items].reverse().map(item => item.content).join('\n'), '遵循实际 boot 清单顺序');
    }
    {
        const h = harness({ story: '' });
        assert.equal(h.ensure({ active: true }), true);
        const first = h.fallback();
        first.remove();
        assert.equal(h.ensure({ active: true }), true);
        assert.notEqual(h.fallback(), first, '恢复节点被移除后重新建立');
        h.fallback().textContent = '被改写的样式';
        h.fallback().disabled = true;
        h.fallback().media = 'not all';
        assert.equal(h.ensure({ active: true }), true);
        assert.equal(h.fallback().textContent, fullText);
        assert.equal(h.fallback().disabled, false);
        assert.equal(h.fallback().media, '');
        assert.equal(h.head.children.length, 2);
    }

    // 源不可读或不完整时不注入半份样式，也不阻断加载。
    const invalidSources = [null,
        { name: 'Other', bootJson: { name: 'Other', styleFileList: files }, cache: { styleFileItems: { items } } },
        { name: 'ModHub', bootJson: { name: 'Other', styleFileList: files }, cache: { styleFileItems: { items } } },
        { name: 'ModHub', bootJson: { name: 'ModHub', styleFileList: files }, cache: { styleFileItems: { items: items.slice(1) } } },
        { name: 'ModHub', bootJson: { name: 'ModHub', styleFileList: files.slice(1) }, cache: { styleFileItems: { items } } },
    ];
    for (const mod of invalidSources) {
        const h = harness({ mod, story: '' });
        assert.doesNotThrow(() => h.hooks.get('modHubStyles').ModLoaderLoadEnd());
        assert.equal(h.ensure({ active: true }), false);
        assert.equal(h.fallback(), null);
        assert.equal(h.head.children.length, 1);
        assert.equal(h.warnings.length, 1, '同一来源错误只记录一次');
        assert.ok(h.warnings[0][1].message.includes('ModHub'), '警告保留具体来源原因');
    }
    {
        const h = harness({ story: '', utils: { getMod() { throw new Error('档案读取失败'); }, getModLoadController: () => null } });
        assert.equal(h.ensure(), false);
        assert.equal(h.fallback(), null);
        assert.equal(h.warnings[0][1].message, '档案读取失败');
    }
    {
        const mod = { name: 'ModHub', bootJson: { name: 'ModHub', styleFileList: files }, cache: { styleFileItems: { items } } };
        const h = harness({ story: '', utils: { getMod: () => ({ name: 'Other', bootJson: { name: 'Other' } }),
            getModLoader: () => ({ getModReadCache: () => ({ get_Array: () => [{ name: 'ModHub', zip: { getModInfo: () => mod } }] }) }) } });
        assert.equal(h.ensure(), true, '早期普通档案未就绪时允许读取精确的原始包缓存');
        assert.equal(h.fallback().textContent, fullText);
    }
};
