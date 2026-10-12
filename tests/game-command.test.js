// 原生游戏备份先提交、回读，再运行纯 JS；测试不接触网络或存档槽。
const { assert, createBaseSandbox, createDocumentStub, loadScripts, vm } = require('./helpers');
const { webcrypto } = require('node:crypto');

function harness(options = {}) {
    const rows = new Map();
    const events = [];
    const stats = { serializes: 0, executions: 0, uploads: 0, commits: 0 };
    let hasStore = false;
    const indexedDB = { open(name, version) {
        assert.equal(name, 'modhub_game_command_backups');
        assert.equal(version, 1);
        const request = {};
        setImmediate(() => {
            if (options.openError) { request.error = options.openError; request.onerror?.(); return; }
            const db = {
                objectStoreNames: { contains: name => hasStore && name === 'backups' },
                createObjectStore(name, config) { assert.equal(name, 'backups'); assert.equal(config.keyPath, 'id'); hasStore = true; },
                close() {},
                transaction(name, mode) {
                    assert.equal(name, 'backups');
                    const staged = new Map(rows);
                    let closed = false;
                    const tx = { error: null, abort() { if (!closed) { closed = true; setImmediate(() => tx.onabort?.()); } } };
                    const makeRequest = action => {
                        const req = {};
                        setImmediate(() => {
                            if (closed) return;
                            try { req.result = action(); req.onsuccess?.(); }
                            catch (error) { req.error = tx.error = error; req.onerror?.(); tx.onerror?.(); tx.abort(); return; }
                            setImmediate(() => {
                                if (closed) return;
                                closed = true;
                                if (mode === 'readwrite') {
                                    rows.clear(); staged.forEach((value, key) => rows.set(key, value));
                                    stats.commits++; events.push('备份提交'); options.afterCommit?.();
                                } else events.push('备份回读完成');
                                tx.oncomplete?.();
                            });
                        });
                        return req;
                    };
                    tx.objectStore = () => ({
                        add(value) { return makeRequest(() => {
                            assert.equal(mode, 'readwrite');
                            if (options.writeError) throw options.writeError;
                            if (staged.has(value.id)) throw new Error('ConstraintError');
                            staged.set(value.id, structuredClone(value));
                            return value.id;
                        }); },
                        get(key) { return makeRequest(() => {
                            if (options.readError || stats.commits && options.readbackError) throw options.readError || options.readbackError;
                            const value = structuredClone(staged.get(key));
                            if (value && stats.commits && options.corruptReadback) value.data += '错误内容';
                            return value;
                        }); }
                    });
                    return tx;
                }
            };
            request.result = db;
            request.transaction = { abort() { request.error = new Error('升级失败'); request.onerror?.(); } };
            if (!hasStore) request.onupgradeneeded?.();
            request.onsuccess?.();
        });
        return request;
    } };
    const document = createDocumentStub();
    const downloads = [];
    const blobs = [];
    const originalCreate = document.createElement;
    document.createElement = tag => {
        const link = originalCreate(tag);
        link.click = () => downloads.push({ href: link.href, filename: link.download });
        return link;
    };
    const sb = createBaseSandbox({
        document, indexedDB, crypto: webcrypto, TextEncoder, Uint8Array, Blob,
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:本机备份'; }, revokeObjectURL() {} },
        fetch: async () => { stats.uploads++; throw new Error('不得上传'); },
        modHubRestore: { createPoint() { throw new Error('不得创建模组还原点'); } }
    });
    const state = { passage: '开始', turns: 1, variables: { value: 1, saveCount: 0, privateText: '本机私有内容' } };
    const nativeData = '原生压缩存档范围字符串';
    sb.SugarCube = {
        State: state,
        Config: { saves: { isAllowed: () => options.allowed !== false } },
        Save: { serialize() {
            stats.serializes++; events.push('原生存档生成'); state.variables.saveCount++;
            if (options.serializeError) throw options.serializeError;
            return options.serializeValue === undefined ? nativeData : options.serializeValue;
        }, slots: { save() { throw new Error('不得覆盖存档槽'); } } },
        Scripting: {
            evalJavaScript(script) { stats.executions++; events.push('运行 JS'); return vm.runInContext(script, sb); },
            evalTwineScript() { throw new Error('不得求值 Twine 宏'); }
        }
    };
    sb.V = state.variables; sb.State = state;
    sb.eval = () => { throw new Error('应使用游戏原生纯 JS 词法作用域'); };
    loadScripts(sb, ['javascript/modhub-game-command.js']);
    return { sb, api: sb.modHubGameCommand, state, rows, stats, events, downloads, blobs, nativeData };
}

const payload = script => ({ summary: '调整玩家状态以排查问题', script: script || 'V.value += 1;', verification: '检查当前数值是否符合预期。' });
const operationId = command => JSON.stringify(['modhub_remote_assist:["游戏库","模组库"]', '会话一', command || '操作一']);

module.exports = async function() {
    {
        const f = harness();
        const preview = await f.api.prepare(payload());
        assert.equal(f.stats.serializes, 0, '预览不能生成存档或触发保存回调');
        assert.equal(f.stats.executions, 0, '语法检查不能运行脚本');
        assert.equal(f.stats.uploads, 0, '状态摘要只在本机使用');
        assert.match(preview.text, /原生正常游戏存档/);
        assert.match(preview.text, /不覆盖整页/);
        assert.match(preview.text, /异步任务不受控/);
        assert.doesNotMatch(JSON.stringify(preview.stamp), /本机私有内容/);
        await assert.rejects(f.api.prepare({ ...payload(), extra: true }), /只能包含/);
        await assert.rejects(f.api.prepare(payload('<<set $value = 3>>')), { name: 'SyntaxError' });
        await assert.rejects(f.api.prepare({ ...payload(), summary: '字'.repeat(2001) }), /长度限制/);
        await assert.rejects(f.api.prepare({ ...payload(), script: ' '.repeat(16001) }), /长度限制/);
        await assert.rejects(f.api.prepare({ ...payload(), verification: '' }), /内容为空/);
        await f.api.prepare({ summary: '字'.repeat(2000), script: ' '.repeat(15999) + ';', verification: '字'.repeat(2000) });
    }
    {
        const f = harness({ allowed: false });
        await assert.rejects(f.api.prepare(payload()), /不允许保存/);
        assert.equal(f.stats.serializes, 0, '禁止保存时不能调用会触发原生提示的 serialize');
        f.state.passage = '';
        await assert.rejects(f.api.prepare(payload()), /尚未开始/);
    }
    {
        const f = harness();
        delete f.sb.SugarCube.Scripting.evalJavaScript;
        await assert.rejects(f.api.prepare(payload()), /纯 JS 求值接口/);
    }
    for (const change of [f => { f.state.variables.value++; }, f => { f.state.passage = '下一页'; }, f => { f.state.turns++; }]) {
        const f = harness();
        const preview = await f.api.prepare(payload());
        change(f);
        const result = await f.api.run(payload(), preview.stamp, operationId(), () => true);
        assert.equal(result.ok, false);
        assert.match(result.error, /状态或 JS 操作已变化/);
        assert.equal(f.stats.serializes + f.stats.executions, 0);
    }
    {
        const f = harness();
        const preview = await f.api.prepare(payload());
        const changed = await f.api.run(payload('V.value += 2;'), preview.stamp, operationId(), () => true);
        assert.equal(changed.ok, false, '确认后替换脚本必须重新预览');
        const guardKeys = [];
        const result = await f.api.run(payload(), preview.stamp, operationId(), key => { guardKeys.push(key); if (key) f.events.push('持久记录备份编号'); });
        assert.equal(result.ok, true, '正常保存回调修改变量不使本次操作误判过期');
        assert.match(result.backupId, /^modhub-game-[a-f0-9]{64}$/);
        assert.equal(f.state.variables.value, 2);
        assert.equal(f.state.variables.saveCount, 1);
        assert.equal(f.stats.executions, 1);
        assert.equal(guardKeys.filter(Boolean).length, 1);
        assert.equal(guardKeys.at(-1), result.backupId);
        assert.ok(f.events.indexOf('备份提交') < f.events.lastIndexOf('备份回读完成'));
        assert.ok(f.events.lastIndexOf('备份回读完成') < f.events.indexOf('持久记录备份编号'));
        assert.ok(f.events.indexOf('持久记录备份编号') < f.events.indexOf('运行 JS'));
        const backup = await f.api.getBackup(result.backupId);
        assert.equal(backup.data, f.nativeData);
        assert.equal(backup.requestId, operationId());
        assert.doesNotMatch(JSON.stringify(backup), /V\.value|调整玩家状态/);
        const latest = await f.api.prepare(payload());
        const duplicate = await f.api.run(payload(), latest.stamp, operationId(), () => true);
        assert.equal(duplicate.ok, false);
        assert.equal(duplicate.backupId, result.backupId);
        assert.equal(f.stats.serializes, 1, '重复 ID 不再次触发原生保存回调');
        assert.equal(f.stats.executions, 1, '重复 ID 不再次执行');
        assert.equal(f.rows.size, 1);
        await f.api.download(result.backupId);
        assert.equal(f.downloads[0].filename, result.backupId + '.save');
        assert.equal(await f.blobs[0].text(), f.nativeData, '下载保留原生存档原文');
        assert.equal(f.blobs[0].type, 'text/plain;charset=utf-8');
        assert.equal(f.stats.uploads, 0, '备份查看及下载均不得上传');
    }
    for (const options of [{ openError: new Error('数据库不可用') }, { writeError: new Error('磁盘已满') }, { readbackError: new Error('回读失败') }, { corruptReadback: true }, { serializeValue: null }]) {
        const f = harness(options);
        const preview = await f.api.prepare(payload());
        const result = await f.api.run(payload(), preview.stamp, operationId(), () => true);
        assert.equal(result.ok, false);
        assert.equal(f.stats.executions, 0, '备份生成、提交或回读失败均不运行 JS');
        assert.match(result.message, /JS 未运行/);
    }
    {
        const options = {};
        const f = harness(options);
        options.afterCommit = () => { f.state.variables.value = 9; };
        const preview = await f.api.prepare(payload());
        const result = await f.api.run(payload(), preview.stamp, operationId(), () => true);
        assert.equal(result.ok, false);
        assert.ok(result.backupId, '等待期间状态变化仍保留已验证的备份编号');
        assert.match(result.error, /保存备份期间游戏状态已变化/);
        assert.equal(f.stats.executions, 0);
    }
    {
        const f = harness();
        const preview = await f.api.prepare(payload());
        const result = await f.api.run(payload(), preview.stamp, operationId(), key => { if (key) throw new Error('前台记录保存失败'); });
        assert.equal(result.ok, false);
        assert.ok(result.backupId);
        assert.equal(f.stats.executions, 0, '正在运行记录保存失败时不得运行 JS');
        assert.equal((await f.api.getBackup(result.backupId)).data, f.nativeData);
    }
    {
        const options = {};
        const f = harness(options);
        let active = true;
        options.afterCommit = () => { active = false; };
        const preview = await f.api.prepare(payload());
        const result = await f.api.run(payload(), preview.stamp, operationId(), () => active);
        assert.equal(result.ok, false);
        assert.ok(result.backupId, '离开前台后保留已完成的备份编号');
        assert.equal(f.stats.executions, 0, '保存等待期间离开前台不得运行 JS');
    }
    {
        const f = harness();
        const value = payload('V.value = 5; throw new Error(V.privateText);');
        const preview = await f.api.prepare(value);
        const result = await f.api.run(value, preview.stamp, operationId(), () => true);
        assert.equal(result.ok, false);
        assert.equal(f.stats.executions, 1, '同步异常不重试');
        assert.equal(f.state.variables.value, 5, '异常不擅自撤销已发生的游戏变化');
        assert.match(result.error, /本机私有内容/, '具体异常仅供调用方本机呈现');
        assert.doesNotMatch(result.message, /本机私有内容/);
        assert.ok(await f.api.getBackup(result.backupId));
    }
    for (const script of ['(function() { V.value = 99; })', '({ then() { V.value = 99; } })']) {
        const f = harness();
        const value = payload(script);
        const preview = await f.api.prepare(value);
        const result = await f.api.run(value, preview.stamp, operationId(), () => true);
        assert.equal(result.ok, true);
        assert.equal(f.state.variables.value, 1, '脚本返回的函数或 Promise 风格对象不得自动调用');
        assert.deepEqual(Object.keys(result).sort(), ['backupId', 'message', 'ok']);
    }
    console.log('原生游戏备份、状态核验与纯 JS 一次执行测试通过');
};
