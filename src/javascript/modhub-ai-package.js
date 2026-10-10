/** ModHub AI 修复：受限普通 ZIP 读取与文本替换，不执行包内代码。 */
(function() {
    'use strict';

    const MODHUB_ZIP_LIMIT = 100 * 1024 * 1024;
    const MODHUB_TEXT_LIMIT = 256 * 1024;
    const MODHUB_SOURCE_LIMIT = 512 * 1024;
    const MODHUB_READONLY_TEXT_LIMIT = 8 * 1024 * 1024;
    const MODHUB_READONLY_SOURCE_LIMIT = 16 * 1024 * 1024;
    const archives = new WeakMap();
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let value = i;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        crcTable[i] = value >>> 0;
    }
    function crc32(bytes) {
        let value = 0xffffffff;
        for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
        return (value ^ 0xffffffff) >>> 0;
    }
    function fail(reason) { throw new Error(`无法处理安装包：${reason}`); }
    function bounds(offset, size, limit) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > limit) {
            fail('ZIP 条目超出文件边界');
        }
    }
    function equalBytes(first, second) {
        return first.length === second.length && first.every((byte, index) => byte === second[index]);
    }
    function decode(bytes, label) {
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch (_) { fail(`${label}不是有效的 UTF-8 文本`); }
    }
    function validPath(path) {
        const parts = path.replace(/\/$/, '').split('/');
        if (!path || path.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(path) ||
            parts.some(part => !part || part === '.' || part === '..')) fail('ZIP 包含不安全的文件路径');
    }
    function checkExtra(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 0; offset < bytes.length;) {
            bounds(offset, 4, bytes.length);
            const id = view.getUint16(offset, true);
            const size = view.getUint16(offset + 2, true);
            bounds(offset + 4, size, bytes.length);
            if (id === 1) fail('首版不支持 ZIP64 安装包');
            if (id === 0x9901) fail('首版不支持加密安装包');
            offset += 4 + size;
        }
    }
    async function bytesOf(data) {
        let bytes;
        if (typeof data === 'string') {
            const raw = data.trim();
            if (raw.length > Math.ceil(MODHUB_ZIP_LIMIT / 3) * 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
                fail('安装包 Base64 数据无效或超过 100 MiB');
            }
            try { bytes = Uint8Array.from(atob(raw), char => char.charCodeAt(0)); }
            catch (_) { fail('安装包 Base64 数据无效'); }
        } else if (ArrayBuffer.isView(data)) {
            if (data.byteLength > MODHUB_ZIP_LIMIT) fail('安装包超过 100 MiB');
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        } else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
            if (data.byteLength > MODHUB_ZIP_LIMIT) fail('安装包超过 100 MiB');
            bytes = new Uint8Array(data).slice();
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
            if (data.size > MODHUB_ZIP_LIMIT) fail('安装包超过 100 MiB');
            bytes = new Uint8Array(await data.arrayBuffer());
        } else { fail('安装包数据类型不受支持'); }
        if (bytes.length > MODHUB_ZIP_LIMIT) fail('安装包超过 100 MiB');
        return bytes;
    }

    async function read(data) {
        const bytes = await bytesOf(data);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
            if (view.getUint32(offset, true) === 0x06054b50 &&
                offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
        }
        if (end < 0) fail('未找到完整的 ZIP 目录');
        const count = view.getUint16(end + 10, true);
        const directorySize = view.getUint32(end + 12, true);
        const directoryOffset = view.getUint32(end + 16, true);
        if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('首版不支持 ZIP64 安装包');
        if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) {
            fail('首版不支持多卷安装包');
        }
        if (count > 4096) fail('安装包条目超过 4096 项');
        bounds(directoryOffset, directorySize, end);
        if (directoryOffset + directorySize !== end) fail('ZIP 目录大小与边界不一致');
        const entries = new Map();
        const items = [];
        let offset = directoryOffset;
        for (let index = 0; index < count; index++) {
            bounds(offset, 46, end);
            if (view.getUint32(offset, true) !== 0x02014b50) fail('ZIP 目录条目损坏');
            const flags = view.getUint16(offset + 8, true);
            const method = view.getUint16(offset + 10, true);
            const crc = view.getUint32(offset + 16, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const size = view.getUint32(offset + 24, true);
            const nameSize = view.getUint16(offset + 28, true);
            const extraSize = view.getUint16(offset + 30, true);
            const commentSize = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) fail('首版不支持 ZIP64 安装包');
            if (view.getUint16(offset + 34, true)) fail('首版不支持多卷安装包');
            if (flags & 0x2041) fail('首版不支持加密安装包');
            if ((method !== 0 && method !== 8) || (flags & ~(method === 8 ? 0x080e : 0x0808))) fail('ZIP 压缩方式或标志不受支持');
            if (view.getUint16(offset + 6, true) > 20) fail('ZIP 要求的格式版本不受支持');
            bounds(offset + 46, nameSize + extraSize + commentSize, end);
            const nameBytes = bytes.slice(offset + 46, offset + 46 + nameSize);
            if (!(flags & 0x0800) && nameBytes.some(byte => byte > 127)) fail('ZIP 文件名未声明 UTF-8 编码');
            const path = decode(nameBytes, 'ZIP 文件名');
            validPath(path);
            if (entries.has(path)) fail(`ZIP 包含重复条目【${path}】`);
            const extra = bytes.slice(offset + 46 + nameSize, offset + 46 + nameSize + extraSize);
            checkExtra(extra);
            bounds(localOffset, 30, directoryOffset);
            if (view.getUint32(localOffset, true) !== 0x04034b50 ||
                view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) fail('ZIP 本地条目与目录不一致');
            const localNameSize = view.getUint16(localOffset + 26, true);
            const localExtraSize = view.getUint16(localOffset + 28, true);
            bounds(localOffset + 30, localNameSize + localExtraSize, directoryOffset);
            if (!equalBytes(nameBytes, bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize))) fail('ZIP 本地文件名与目录不一致');
            const localExtra = bytes.slice(localOffset + 30 + localNameSize, localOffset + 30 + localNameSize + localExtraSize);
            checkExtra(localExtra);
            const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
            bounds(dataOffset, compressedSize, directoryOffset);
            if (method === 0 && compressedSize !== size) fail('未压缩条目大小不一致');
            const localValues = [view.getUint32(localOffset + 14, true), view.getUint32(localOffset + 18, true), view.getUint32(localOffset + 22, true)];
            if (localValues.some((value, position) => value !== [crc, compressedSize, size][position] && (!(flags & 8) || value !== 0))) {
                fail('ZIP 本地大小或 CRC 与目录不一致');
            }
            let dataEnd = dataOffset + compressedSize;
            if (flags & 8) {
                bounds(dataEnd, 12, directoryOffset);
                const unsigned = view.getUint32(dataEnd, true) === crc &&
                    view.getUint32(dataEnd + 4, true) === compressedSize && view.getUint32(dataEnd + 8, true) === size;
                const descriptor = !unsigned && view.getUint32(dataEnd, true) === 0x08074b50 ? dataEnd + 4 : dataEnd;
                bounds(descriptor, 12, directoryOffset);
                if (view.getUint32(descriptor, true) !== crc || view.getUint32(descriptor + 4, true) !== compressedSize ||
                    view.getUint32(descriptor + 8, true) !== size) fail('ZIP 数据描述符与目录不一致');
                dataEnd = descriptor + 12;
            }
            const entry = Object.freeze({ path, name: path, directory: path.endsWith('/'), size, compressedSize, method, crc });
            entries.set(path, entry);
            items.push({ ...entry, flags, nameBytes, extra, localExtra, localOffset, dataOffset, dataEnd,
                madeBy: view.getUint16(offset + 4, true), time: view.getUint16(offset + 12, true), date: view.getUint16(offset + 14, true),
                attributes: view.getUint32(offset + 38, true), internalAttributes: view.getUint16(offset + 36, true),
                comment: bytes.slice(offset + 46 + nameSize + extraSize, offset + 46 + nameSize + extraSize + commentSize) });
            offset += 46 + nameSize + extraSize + commentSize;
        }
        if (offset !== end) fail('ZIP 目录条目数量与大小不一致');
        const sorted = [...items].sort((first, second) => first.localOffset - second.localOffset);
        for (let index = 1; index < sorted.length; index++) {
            if (sorted[index].localOffset < sorted[index - 1].dataEnd) fail('ZIP 本地条目互相重叠');
        }
        const cache = new Map();
        const textBudget = { paths: new Set(), used: 0, fileLimit: MODHUB_TEXT_LIMIT, totalLimit: MODHUB_SOURCE_LIMIT,
            fileReason: '超过 256 KiB，不能作为修复源码', totalReason: '本次读取源码超过 512 KiB' };
        const sourceBudget = { paths: new Set(), used: 0, fileLimit: MODHUB_READONLY_TEXT_LIMIT, totalLimit: MODHUB_READONLY_SOURCE_LIMIT,
            fileReason: '超过本机只读检查的 8 MiB 上限', totalReason: '本次本机只读源码超过 16 MiB' };
        const readText = async (path, budget) => {
            const item = items.find(entry => entry.path === path);
            if (!item || item.directory) fail(`未找到可读取文件【${path}】`);
            // 两种入口分别核验并登记预算，命中共享解压缓存也不能绕过限制。
            if (item.size > budget.fileLimit) fail(`文件【${path}】${budget.fileReason}`);
            if (!budget.paths.has(path)) {
                if (budget.used + item.size > budget.totalLimit) fail(budget.totalReason);
                budget.paths.add(path);
                budget.used += item.size;
            }
            if (cache.has(path)) return cache.get(path);
            const pending = (async () => {
                let plain = bytes.subarray(item.dataOffset, item.dataOffset + item.compressedSize);
                if (item.method === 8) {
                    let stream;
                    try { stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
                    catch (_) { fail('当前浏览器未提供 deflate-raw 解压能力'); }
                    const reader = stream.getReader();
                    const chunks = [];
                    let length = 0;
                    try {
                        while (true) {
                            const part = await reader.read();
                            if (part.done) break;
                            length += part.value.length;
                            if (length > item.size || length > MODHUB_READONLY_TEXT_LIMIT) fail(`文件【${path}】解压后大小不符`);
                            chunks.push(part.value);
                        }
                    } catch (error) {
                        await reader.cancel().catch(() => {});
                        throw new Error(`无法读取文件【${path}】：${error.message || error}`);
                    } finally { reader.releaseLock(); }
                    plain = new Uint8Array(length);
                    let position = 0;
                    for (const chunk of chunks) { plain.set(chunk, position); position += chunk.length; }
                }
                if (plain.length !== item.size || crc32(plain) !== item.crc) fail(`文件【${path}】大小或 CRC 校验失败`);
                return decode(plain, `文件【${path}】`);
            })();
            cache.set(path, pending);
            return pending;
        };
        const archive = { bytes, entries, text: path => readText(path, textBudget), sourceText: path => readText(path, sourceBudget) };
        archives.set(archive, { items, bytes, comment: bytes.slice(end + 22) });
        return archive;
    }

    function validatePatchBoot(before, after) {
        const clone = value => JSON.parse(JSON.stringify(value));
        if (!before || !after || Array.isArray(before) || Array.isArray(after)
            || typeof before !== 'object' || typeof after !== 'object') fail('boot.json 必须是有效的模组声明');
        const normalized = clone(after), anchors = [];
        for (const [pluginIndex, plugin] of (Array.isArray(before.addonPlugin) ? before.addonPlugin : []).entries()) {
            if (plugin?.modName !== 'TweeReplacer' || plugin.addonName !== 'TweeReplacerAddon' || !Array.isArray(plugin.params)) continue;
            const nextPlugin = normalized.addonPlugin?.[pluginIndex];
            if (!Array.isArray(nextPlugin?.params)) continue;
            for (const [index, parameter] of plugin.params.entries()) {
                const next = nextPlugin.params[index];
                if (!parameter || !next || parameter.findString === next.findString) continue;
                if (typeof parameter.passage !== 'string' || !parameter.passage.trim()
                    || typeof parameter.findString !== 'string' || !parameter.findString.length
                    || typeof next.findString !== 'string' || !next.findString.trim()
                    || new TextEncoder().encode(next.findString).length > 4096
                    || parameter.findRegex !== undefined || parameter.regexFlag !== undefined) fail('boot.json 仅允许修改普通 TweeReplacer findString 查找串');
                anchors.push({ passage: parameter.passage, before: parameter.findString, after: next.findString });
                next.findString = parameter.findString;
            }
        }
        if (!anchors.length || anchors.length > 8 || JSON.stringify(before) !== JSON.stringify(normalized)) fail('boot.json 仅允许修改 TweeReplacer findString，模组身份、版本、依赖及其他清单字段必须保持原样');
        return anchors;
    }

    async function replace(archive, changes) {
        const original = archives.get(archive);
        if (!original || Object.prototype.toString.call(changes) !== '[object Map]' || !changes.size) fail('缺少有效的原始包或文本改动');
        const updated = new Map();
        let sourceSize = 0;
        for (const [path, text] of changes) {
            if (typeof path !== 'string' || path !== 'boot.json' && /(^|\/)boot\.json$/i.test(path)) fail('修复不能修改此 boot.json 路径');
            const item = original.items.find(entry => entry.path === path);
            if (!item || item.directory) fail('修复不能新增文件或修改目录');
            if (typeof text !== 'string') fail('修复内容必须为文本');
            const before = await archive.text(path);
            if (path === 'boot.json') {
                let oldBoot, newBoot;
                try { oldBoot = JSON.parse(before); newBoot = JSON.parse(text); }
                catch (_) { fail('修复后的 boot.json 不是有效 JSON'); }
                validatePatchBoot(oldBoot, newBoot);
            }
            const bytes = new TextEncoder().encode(text);
            if (bytes.length > MODHUB_TEXT_LIMIT || decode(bytes, '修复内容') !== text) fail('修复内容超过 256 KiB 或包含无效字符');
            sourceSize += bytes.length;
            if (sourceSize > MODHUB_SOURCE_LIMIT) fail('修复源码总量超过 512 KiB');
            updated.set(path, bytes);
        }
        const items = original.items.map(item => {
            const body = updated.get(item.path);
            return { ...item, body: body || original.bytes.subarray(item.dataOffset, item.dataOffset + item.compressedSize),
                method: body ? 0 : item.method, size: body ? body.length : item.size,
                compressedSize: body ? body.length : item.compressedSize, crc: body ? crc32(body) : item.crc,
                flags: (item.flags & ~(body ? 14 : 8)) | 0x0800 };
        });
        const localSize = items.reduce((sum, item) => sum + 30 + item.nameBytes.length + item.localExtra.length + item.compressedSize, 0);
        const directorySize = items.reduce((sum, item) => sum + 46 + item.nameBytes.length + item.extra.length + item.comment.length, 0);
        const total = localSize + directorySize + 22 + original.comment.length;
        if (total > MODHUB_ZIP_LIMIT) fail('修复后的安装包超过 100 MiB');
        const output = new Uint8Array(total);
        const view = new DataView(output.buffer);
        let offset = 0;
        for (const item of items) {
            item.outputOffset = offset;
            view.setUint32(offset, 0x04034b50, true);
            view.setUint16(offset + 4, item.method === 8 ? 20 : 10, true);
            view.setUint16(offset + 6, item.flags, true);
            view.setUint16(offset + 8, item.method, true);
            view.setUint16(offset + 10, item.time, true);
            view.setUint16(offset + 12, item.date, true);
            view.setUint32(offset + 14, item.crc, true);
            view.setUint32(offset + 18, item.compressedSize, true);
            view.setUint32(offset + 22, item.size, true);
            view.setUint16(offset + 26, item.nameBytes.length, true);
            view.setUint16(offset + 28, item.localExtra.length, true);
            output.set(item.nameBytes, offset + 30);
            output.set(item.localExtra, offset + 30 + item.nameBytes.length);
            output.set(item.body, offset + 30 + item.nameBytes.length + item.localExtra.length);
            offset += 30 + item.nameBytes.length + item.localExtra.length + item.compressedSize;
        }
        for (const item of items) {
            view.setUint32(offset, 0x02014b50, true);
            view.setUint16(offset + 4, item.madeBy, true);
            view.setUint16(offset + 6, item.method === 8 ? 20 : 10, true);
            view.setUint16(offset + 8, item.flags, true);
            view.setUint16(offset + 10, item.method, true);
            view.setUint16(offset + 12, item.time, true);
            view.setUint16(offset + 14, item.date, true);
            view.setUint32(offset + 16, item.crc, true);
            view.setUint32(offset + 20, item.compressedSize, true);
            view.setUint32(offset + 24, item.size, true);
            view.setUint16(offset + 28, item.nameBytes.length, true);
            view.setUint16(offset + 30, item.extra.length, true);
            view.setUint16(offset + 32, item.comment.length, true);
            view.setUint16(offset + 36, item.internalAttributes, true);
            view.setUint32(offset + 38, item.attributes, true);
            view.setUint32(offset + 42, item.outputOffset, true);
            output.set(item.nameBytes, offset + 46);
            output.set(item.extra, offset + 46 + item.nameBytes.length);
            output.set(item.comment, offset + 46 + item.nameBytes.length + item.extra.length);
            offset += 46 + item.nameBytes.length + item.extra.length + item.comment.length;
        }
        view.setUint32(offset, 0x06054b50, true);
        view.setUint16(offset + 8, items.length, true);
        view.setUint16(offset + 10, items.length, true);
        view.setUint32(offset + 12, directorySize, true);
        view.setUint32(offset + 16, localSize, true);
        view.setUint16(offset + 20, original.comment.length, true);
        output.set(original.comment, offset + 22);
        return output;
    }

    async function hash(data) {
        if (!window.crypto?.subtle) throw new Error('当前浏览器未提供 SHA-256 校验能力');
        const digest = await window.crypto.subtle.digest('SHA-256', await bytesOf(data));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    window.modHubAiPackage = { read, replace, hash, validatePatchBoot };
})();
