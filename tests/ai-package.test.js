// ModHub AI 安装包：真实 ZIP 字节、受限解压与不改动资源的文本替换。
const { assert, createBaseSandbox, loadScripts } = require('./helpers');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files, options = {}) {
    const locals = [];
    const central = [];
    let position = 0;
    for (const file of files) {
        const name = Buffer.from(file.name);
        const plain = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || '');
        const body = file.method === 8 ? zlib.deflateRawSync(plain) : plain;
        const flags = file.flags ?? (0x0800 | (file.descriptor ? 8 : 0));
        const extra = file.extra || Buffer.alloc(0);
        const crc = crc32(plain);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(file.method || 0, 8);
        if (!file.descriptor) {
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(body.length, 18);
            local.writeUInt32LE(plain.length, 22);
        }
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(extra.length, 28);
        const descriptor = Buffer.alloc(file.descriptor ? 16 : 0);
        if (file.descriptor) {
            descriptor.writeUInt32LE(0x08074b50);
            descriptor.writeUInt32LE(crc, 4);
            descriptor.writeUInt32LE(body.length, 8);
            descriptor.writeUInt32LE(plain.length, 12);
        }
        const item = Buffer.alloc(46);
        item.writeUInt32LE(0x02014b50);
        item.writeUInt16LE(20, 4);
        item.writeUInt16LE(20, 6);
        item.writeUInt16LE(flags, 8);
        item.writeUInt16LE(file.method || 0, 10);
        item.writeUInt32LE(crc, 16);
        item.writeUInt32LE(body.length, 20);
        item.writeUInt32LE(plain.length, 24);
        item.writeUInt16LE(name.length, 28);
        item.writeUInt16LE(extra.length, 30);
        item.writeUInt32LE(position, 42);
        locals.push(local, name, extra, body, descriptor);
        central.push(item, name, extra);
        position += local.length + name.length + extra.length + body.length + descriptor.length;
    }
    const directory = Buffer.concat(central);
    const comment = Buffer.from(options.comment || '');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(position, 16);
    end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...locals, directory, end, comment]);
}

function centralOffset(bytes) { return bytes.readUInt32LE(bytes.length - 6); }
function compressedBody(bytes, path) {
    let position = centralOffset(bytes);
    while (bytes.readUInt32LE(position) === 0x02014b50) {
        const nameSize = bytes.readUInt16LE(position + 28);
        const extraSize = bytes.readUInt16LE(position + 30);
        const commentSize = bytes.readUInt16LE(position + 32);
        if (bytes.subarray(position + 46, position + 46 + nameSize).toString() === path) {
            const local = bytes.readUInt32LE(position + 42);
            const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
            return bytes.subarray(start, start + bytes.readUInt32LE(position + 20));
        }
        position += 46 + nameSize + extraSize + commentSize;
    }
    throw new Error('测试未找到目标压缩条目');
}
function loadPackage(overrides = {}) {
    const sb = createBaseSandbox({ TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
        Blob, DecompressionStream, atob, crypto: crypto.webcrypto, ...overrides });
    loadScripts(sb, ['javascript/modhub-ai-package.js']);
    return sb.modHubAiPackage;
}

module.exports = async function() {
    const api = loadPackage();
    const source = 'window.测试名称 = "修复前";\n';
    const files = [
        { name: 'boot.json', content: '{"name":"测试模组","version":"1.0.0"}' },
        { name: 'javascript/修复.js', content: source, method: 8 },
        { name: 'stylesheet/中文.css', content: '.test { color: red; }', method: 8, descriptor: true },
        { name: 'images/raw.bin', content: Buffer.from([0, 1, 2, 255, 98, 124, 33]), method: 8 },
        { name: 'images/', content: '' },
    ];
    const bytes = makeZip(files);
    for (const data of [bytes, bytes.toString('base64'), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), new Blob([bytes])]) {
        const archive = await api.read(data);
        assert.equal(archive.entries.size, files.length, '所有支持的数据形态均应读取真实 ZIP 目录');
        assert.equal(archive.entries.get('javascript/修复.js').size, Buffer.byteLength(source));
        assert.equal(await archive.text('javascript/修复.js'), source);
        assert.equal(await archive.text('stylesheet/中文.css'), files[2].content, '数据描述符条目应支持解压');
        assert.equal(await archive.text('boot.json'), files[0].content, '普通未压缩文本应支持读取');
        assert.equal(await archive.text('javascript/修复.js'), source, '重复读取应复用同一结果');
    }
    assert.equal(await api.hash(bytes), crypto.createHash('sha256').update(bytes).digest('hex'), '基准哈希必须匹配标准 SHA-256');
    assert.equal(await api.hash(bytes.toString('base64')), await api.hash(bytes));
    const archive = await api.read(bytes);
    const changed = Buffer.from(await api.replace(archive, new Map([
        ['javascript/修复.js', 'window.测试名称 = "修复后";\n'], ['stylesheet/中文.css', ''],
    ])));
    const reopened = await api.read(changed);
    assert.equal(await reopened.text('javascript/修复.js'), 'window.测试名称 = "修复后";\n');
    assert.equal(await reopened.text('stylesheet/中文.css'), '', '替换为空文件也必须保留该条目');
    assert.equal(reopened.entries.get('javascript/修复.js').method, 0, '修改源码使用普通存储法写入');
    assert.deepEqual(compressedBody(changed, 'images/raw.bin'), compressedBody(bytes, 'images/raw.bin'), '未修改资源的压缩数据逐字节保留');
    assert.equal(await reopened.text('boot.json'), files[0].content, '模组声明不得变化');
    assert.notEqual(await api.hash(changed), await api.hash(bytes));
    const patchBoot = { name: '补丁模组', version: '1.0.0', dependenceInfo: [{ modName: 'TweeReplacer', version: '^2.0.0' }],
        addonPlugin: [{ modName: 'TweeReplacer', addonName: 'TweeReplacerAddon', params: [
            { passage: 'Ocean Breeze', findString: '<<if $money gte 300>>', replaceFile: 'patch.txt' },
        ] }] };
    const fixedBoot = structuredClone(patchBoot);
    fixedBoot.addonPlugin[0].params[0].findString = '<<if $money >= 300>>';
    assert.equal(api.validatePatchBoot(patchBoot, fixedBoot)[0].passage, 'Ocean Breeze');
    const patchBytes = makeZip([{ name: 'boot.json', content: JSON.stringify(patchBoot) },
        { name: 'patch.txt', content: '替换代码', method: 8 }, { name: 'images/raw.bin', content: files[3].content, method: 8 }]);
    const patched = Buffer.from(await api.replace(await api.read(patchBytes), new Map([['boot.json', JSON.stringify(fixedBoot)]])));
    assert.deepEqual(JSON.parse(await (await api.read(patched)).text('boot.json')), fixedBoot, '仅替换声明中的普通补丁查找串');
    assert.deepEqual(compressedBody(patched, 'patch.txt'), compressedBody(patchBytes, 'patch.txt'), '查找串修复保留替换源码原始字节');
    assert.deepEqual(compressedBody(patched, 'images/raw.bin'), compressedBody(patchBytes, 'images/raw.bin'));
    for (const mutateBoot of [
        value => { value.name = '另一模组'; }, value => { value.version = '2.0.0'; },
        value => { value.dependenceInfo = []; }, value => { value.scriptFileList = ['new.js']; },
        value => { value.addonPlugin[0].params[0].passage = '另一段落'; },
        value => { value.addonPlugin[0].params[0].replaceFile = 'other.txt'; },
        value => { value.addonPlugin[0].params[0].findRegex = '.*'; },
        value => { value.addonPlugin[0].params[0].findString = ''; },
        value => { value.addonPlugin[0].params[0].findString = 'x'.repeat(4097); },
        value => { value.addonPlugin[0].params.push({ passage: 'Start', findString: '新补丁' }); },
    ]) {
        const invalidBoot = structuredClone(fixedBoot); mutateBoot(invalidBoot);
        assert.throws(() => api.validatePatchBoot(patchBoot, invalidBoot), /boot.json/);
        await assert.rejects(api.replace(await api.read(patchBytes), new Map([['boot.json', JSON.stringify(invalidBoot)]])), /boot.json/);
    }
    assert.throws(() => api.validatePatchBoot(patchBoot, patchBoot), /boot.json/, '不能借无变化放宽清单写入权限');
    await assert.rejects(api.replace(await api.read(patchBytes), new Map([['boot.json', '{'] ])), /有效 JSON/);
    // 实际核心配合固定本机回复：验收真实 ZIP 链路，不调用云模型或实际游戏仓库。
    for (const metadata of [false, true]) {
        const name = metadata ? '真实补丁锚点验收' : '真实附加源码验收';
        const path = metadata ? 'boot.json' : 'modules/eden-cc.js';
        const boot = metadata ? { ...structuredClone(patchBoot), name }
            : { name, version: '1.0.0', scriptFileList: [], additionFile: [path] };
        const bootText = JSON.stringify(boot, null, 2);
        const moduleText = 'window.modHubAcceptanceCounter = undefined;\nwindow.modHubAcceptanceResult = window.modHubAcceptanceCounter.value;\n';
        const before = metadata ? '"findString": "<<if $money gte 300>>"' : 'window.modHubAcceptanceCounter = undefined;';
        const after = metadata ? '"findString": "<<if $money >= 300>>"' : 'window.modHubAcceptanceCounter = { value: 1 };';
        const entries = [{ name: 'boot.json', content: bootText, method: 8 },
            { name: metadata ? 'patch.txt' : path, content: metadata ? '替换代码保持原样' : moduleText, method: 8, descriptor: true },
            { name: 'images/raw.bin', content: files[3].content, method: 8 }];
        const original = makeZip(entries), originalHash = await api.hash(original);
        const requests = [], writes = [], passageReads = [];
        const gamePassages = metadata ? [{ name: 'Ocean Breeze', content: '<<if $money >= 300>>\n可消费内容。\n<</if>>' }] : [];
        const sb = createBaseSandbox({ TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
            Blob, DecompressionStream, atob, AbortController, crypto: crypto.webcrypto,
            modHubReadIndexDBModLists: async () => ({ ok: true, enabled: [name], disabled: [] }),
            modHubReadInstalledModPackage: async target => {
                assert.equal(target, name, '只读取本机虚构验收包');
                return { name, data: new Uint8Array(original), bootJson: boot };
            },
            modUtils: {
                getAllPassageData: () => gamePassages,
                getPassageData: passage => { passageReads.push(passage); return gamePassages.find(item => item.name === passage); },
            },
            fetch: async (url, request) => {
                assert.equal(url, 'https://example.invalid/v1/chat/completions', '固定回复不访问真实 AI 服务');
                assert.equal(Object.hasOwn(request.headers, 'Authorization'), false, '真实 ZIP 验收不使用密钥');
                const material = JSON.parse(JSON.parse(request.body).messages[1].content);
                requests.push(material);
                const answer = { summary: '本机固定回复：核对虚构原文并修复唯一位置。', evidence: '本机虚构安装包与只读游戏段落。',
                    verification: '本次仅验收核心生成与应用链路，不代表完整游戏或真实模型效果。',
                    changes: requests.length === 1 ? [] : [{ path, before, after, reason: '修正固定验收的唯一原文。' }],
                    readRequest: requests.length === 1 ? { name, paths: [path], reason: '核对已声明的原文后生成最小修改。' } : null };
                return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }) };
            },
            modHubApplyAiPackage: async payload => {
                writes.push(payload);
                return { ok: true, pointId: '真实ZIP受控还原点' };
            },
        });
        loadScripts(sb, ['javascript/modhub-ai-package.js', 'javascript/modhub-ai-repair.js']);
        const repair = sb.modHubAiRepair, connection = { endpoint: 'https://example.invalid/v1', model: '本机固定回复' };
        const description = metadata ? 'Ocean Breeze 的 TweeReplacer findString 查找串未命中。' : 'modules/eden-cc.js 的 modHubAcceptanceCounter.value 初始化报错。';
        const logs = await repair.prepareLogs(description, { includeSources: true });
        assert.equal(requests.length, 0, '真实 ZIP 清单整理不发送请求');
        assert.ok(JSON.parse(logs.material).sourceCatalog[0].files.some(file => file.path === path), '真实清单包含修复目标');
        if (metadata) {
            assert.ok(logs.gameEvidence.some(item => item.passage === 'Ocean Breeze' && item.content.includes('<<if $money >= 300>>') && item.writable === false));
            assert.deepEqual(JSON.parse(logs.material).gameEvidence, JSON.parse(JSON.stringify(logs.gameEvidence)), '预览材料携带同一份只读游戏原文');
            assert.ok(passageReads.includes('Ocean Breeze'));
        }
        const request = await repair.analyze(logs, connection);
        assert.equal(request.readRequest.name, name);
        const selected = await repair.prepareRequestedSources(request);
        assert.equal(requests.length, 1, '完整原文读取只在本机进行');
        assert.equal(selected.files[0].path, path);
        assert.equal(selected.files[0].content, metadata ? bootText : moduleText);
        const plan = await repair.analyze(selected, connection);
        assert.equal(requests.length, 2); assert.equal(plan.changes.length, 1);
        assert.equal(writes.length, 0, '代码预览生成真实 ZIP，但不会自动应用');
        const preview = await sb.modHubAiPackage.read(plan.data);
        assert.equal(await preview.text(path), (metadata ? bootText : moduleText).replace(before, after));
        assert.equal((await repair.apply(plan)).pointId, '真实ZIP受控还原点');
        assert.equal(writes.length, 1); assert.equal(writes[0].name, name);
        assert.deepEqual(Buffer.from(writes[0].baselineData), original, '受控应用携带完整原包基准');
        assert.deepEqual(Array.from(writes[0].enabled), [name]); assert.deepEqual(Array.from(writes[0].disabled), []);
        const applied = Buffer.from(writes[0].data), checked = await sb.modHubAiPackage.read(applied);
        assert.equal(await checked.text(path), (metadata ? bootText : moduleText).replace(before, after));
        for (const entry of entries.filter(item => item.name !== path)) {
            assert.deepEqual(compressedBody(applied, entry.name), compressedBody(original, entry.name), '修复保留其他文件原始压缩字节：' + entry.name);
        }
        if (metadata) {
            const expected = structuredClone(boot); expected.addonPlugin[0].params[0].findString = '<<if $money >= 300>>';
            assert.deepEqual(JSON.parse(await checked.text('boot.json')), expected, '元数据修复仅变更现有普通补丁的 findString');
        } else assert.equal(await checked.text('boot.json'), bootText, '附加模块修复保留完整声明原文');
        assert.equal(await api.hash(original), originalHash, '固定响应链路不改写原包内存');
    }
    const levelFlags = await api.read(makeZip([{ name: 'test.js', content: 'x', method: 8, flags: 0x0806 }]));
    assert.equal(await (await api.read(await api.replace(levelFlags, new Map([['test.js', 'y']])))).text('test.js'), 'y', '转为存储法时须清理 deflate 专属标志');
    const commented = await api.read(makeZip([{ name: 'test.js', content: 'x' }], { comment: '保留包备注' }));
    const commentOutput = Buffer.from(await api.replace(commented, new Map([['test.js', 'y']])));
    assert.ok(commentOutput.subarray(-Buffer.byteLength('保留包备注')).equals(Buffer.from('保留包备注')));

    for (const [data, reason] of [
        [Buffer.alloc(0), /ZIP 目录/], ['非 Base64', /Base64/], ['a', /Base64/], [{}, /数据类型/],
        [makeZip([{ name: '../escape.js' }]), /不安全/],
        [makeZip([{ name: '/absolute.js' }]), /不安全/],
        [makeZip([{ name: 'C:drive.js' }]), /不安全/],
        [makeZip([{ name: 'a\\b.js' }]), /不安全/],
        [makeZip([{ name: 'a//b.js' }]), /不安全/],
        [makeZip([{ name: 'a\u0000b.js' }]), /不安全/],
        [makeZip([{ name: 'a.js' }, { name: 'a.js' }]), /重复/],
        [makeZip([{ name: 'a.js', flags: 0x0801 }]), /加密/],
        [makeZip([{ name: 'a.js', method: 12 }]), /压缩方式/],
        [makeZip([{ name: '中文.js', flags: 0 }]), /未声明 UTF-8/],
        [makeZip([{ name: 'a.js', extra: Buffer.from([1, 0, 0, 0]) }]), /ZIP64/],
        [makeZip([{ name: 'a.js', extra: Buffer.from([1, 0, 1, 0]) }]), /边界/],
    ]) await assert.rejects(api.read(data), reason);

    const mutate = (change, pattern) => {
        const bad = Buffer.from(bytes);
        change(bad, centralOffset(bad), bad.length - 22);
        return assert.rejects(api.read(bad), pattern);
    };
    await mutate((bad, directory, end) => bad.writeUInt16LE(1, end + 4), /多卷/);
    await mutate((bad, directory, end) => bad.writeUInt16LE(0xffff, end + 10), /ZIP64/);
    await mutate((bad, directory, end) => { bad.writeUInt16LE(4097, end + 8); bad.writeUInt16LE(4097, end + 10); }, /4096/);
    await mutate((bad, directory, end) => bad.writeUInt32LE(1, end + 12), /目录大小/);
    await mutate((bad, directory) => bad.writeUInt32LE(0xfffffffe, directory + 42), /边界/);
    await mutate((bad, directory) => bad.writeUInt32LE(0xffffffff, directory + 24), /ZIP64/);
    await mutate((bad, directory) => bad.writeUInt16LE(45, directory + 6), /格式版本/);
    await mutate(bad => { bad[30] ^= 1; }, /本地文件名/);
    await mutate(bad => bad.writeUInt32LE(1, 14), /CRC/);
    const corrupted = makeZip([{ name: 'broken.js', content: 'bad CRC' }]);
    corrupted[30 + Buffer.byteLength('broken.js')] ^= 1;
    await assert.rejects((await api.read(corrupted)).text('broken.js'), /CRC 校验失败/);
    await assert.rejects((await api.read(corrupted)).sourceText('broken.js'), /CRC 校验失败/);
    const invalidUtf8 = await api.read(makeZip([{ name: 'broken.js', content: Buffer.from([0xc3, 0x28]) }]));
    await assert.rejects(invalidUtf8.text('broken.js'), /不是有效的 UTF-8/);
    await assert.rejects((await api.read(makeZip([{ name: 'broken.js', content: Buffer.from([0xc3, 0x28]) }]))).sourceText('broken.js'), /不是有效的 UTF-8/);
    const unsupported = loadPackage({ DecompressionStream: undefined });
    await assert.rejects((await unsupported.read(bytes)).text('javascript/修复.js'), /deflate-raw/);
    await assert.rejects((await unsupported.read(bytes)).sourceText('javascript/修复.js'), /deflate-raw/);
    const large = await api.read(makeZip([{ name: 'large.js', content: 'x'.repeat(256 * 1024 + 1), method: 8 }]));
    await assert.rejects(large.text('large.js'), /256 KiB/);
    assert.equal(await large.sourceText('large.js'), 'x'.repeat(256 * 1024 + 1), '大文件可在本机读取完整证据');
    await assert.rejects(large.text('large.js'), /256 KiB/, '只读缓存不能放宽原发送接口的单文件上限');
    await assert.rejects(api.replace(large, new Map([['large.js', '缩短后的源码']])), /256 KiB/, '读取大文件证据不能使该文件获得改写权限');
    const combined = await api.read(makeZip(['a', 'b', 'c'].map(name => ({ name: `${name}.js`, content: 'x'.repeat(180 * 1024), method: 8 }))));
    await combined.text('a.js'); await combined.text('b.js');
    await combined.sourceText('c.js');
    await assert.rejects(combined.text('c.js'), /512 KiB/);
    const readonly = await api.read(makeZip([
        { name: 'first.js', content: 'a'.repeat(8 * 1024 * 1024), method: 8 },
        { name: 'second.js', content: 'b'.repeat(8 * 1024 * 1024), method: 8 },
        { name: 'next.js', content: 'x' },
        { name: 'oversized.js', content: 'z'.repeat(8 * 1024 * 1024 + 1), method: 8 },
    ]));
    const readonlyHash = await api.hash(readonly.bytes);
    assert.equal(await readonly.text('next.js'), 'x');
    await assert.rejects(readonly.sourceText('oversized.js'), /8 MiB/, '超过本机单文件预算时不得解压');
    const [first, second] = await Promise.all([readonly.sourceText('first.js'), readonly.sourceText('second.js')]);
    assert.equal(Buffer.byteLength(first), 8 * 1024 * 1024);
    assert.equal(Buffer.byteLength(second), 8 * 1024 * 1024, '并发读取可恰好达到 16 MiB 总预算');
    assert.equal(await readonly.sourceText('first.js'), first, '重复读取同一文件不重复占预算');
    await assert.rejects(readonly.sourceText('next.js'), /16 MiB/, '原文本缓存也不能绕过只读总预算');
    await assert.rejects(readonly.text('first.js'), /256 KiB/);
    await assert.rejects(readonly.sourceText('missing.js'), /未找到/);
    await assert.rejects(archive.sourceText('images/'), /未找到/);
    assert.equal(await api.hash(readonly.bytes), readonlyHash, '源码只读检查不改写原包字节');
    const compressedBomb = makeZip([{ name: 'bomb.js', content: 'x'.repeat(1024), method: 8 }]);
    compressedBomb.writeUInt32LE(1, 22);
    compressedBomb.writeUInt32LE(1, centralOffset(compressedBomb) + 24);
    await assert.rejects((await api.read(compressedBomb)).text('bomb.js'), /解压后大小不符/);
    await assert.rejects((await api.read(compressedBomb)).sourceText('bomb.js'), /解压后大小不符/);
    for (const [changes, reason] of [
        [new Map([['boot.json', '{}']]), /boot.json/],
        [new Map([['new.js', 'x']]), /新增文件/],
        [new Map([['images/', 'x']]), /目录/],
        [new Map([['javascript/修复.js', 42]]), /必须为文本/],
        [new Map([['javascript/修复.js', '\ud800']]), /无效字符/],
        [new Map([['javascript/修复.js', 'x'.repeat(256 * 1024 + 1)]]), /256 KiB/],
        [new Map(), /缺少/],
    ]) await assert.rejects(api.replace(archive, changes), reason);
    await assert.rejects(api.replace({}, new Map([['x', 'y']])), /原始包/);
    console.log('AI 普通 ZIP 读取、本机只读源码预算、文本替换与边界校验通过');
};
