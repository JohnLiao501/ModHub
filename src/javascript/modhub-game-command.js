/** ModHub 纯 JS 操作：先保存原生游戏存档，再由玩家确认运行。 */
(function() {
    'use strict';
    const MODHUB_GAME_BACKUP_DB = 'modhub_game_command_backups';
    const MODHUB_GAME_BACKUP_STORE = 'backups';
    const MODHUB_GAME_BACKUP_PREFIX = 'modhub-game-';
    const fail = message => { throw new Error(message); };
    const errorText = error => error?.name && error?.message ? error.name + ': ' + error.message : String(error);

    function validate(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('JS 操作内容无效。');
        const fields = { summary: { label: '说明', limit: 2000 }, script: { label: '脚本', limit: 16000 }, verification: { label: '验证步骤', limit: 2000 } };
        if (Reflect.ownKeys(payload).length !== 3) fail('JS 操作只能包含说明、脚本和验证步骤。');
        const value = {};
        for (const [key, field] of Object.entries(fields)) {
            const item = Object.getOwnPropertyDescriptor(payload, key);
            if (!item || typeof item.value !== 'string' || !item.value.trim() || item.value.length > field.limit) fail('JS 操作的' + field.label + '内容为空或超过长度限制。');
            value[key] = item.value;
        }
        return value;
    }

    function game() {
        const sc = window.SugarCube;
        if (!sc?.State?.passage || !Number.isSafeInteger(sc.State.turns) || sc.State.turns < 1) fail('游戏尚未开始，请进入游戏后重新预览。');
        if (typeof sc.Save?.serialize !== 'function' || typeof sc.Config?.saves?.isAllowed !== 'function') fail('当前游戏缺少原生存档接口，不能运行 JS 操作。');
        if (typeof sc.Scripting?.evalJavaScript !== 'function') fail('当前游戏缺少原生纯 JS 求值接口，不能运行此操作。');
        if (!sc.Config.saves.isAllowed()) fail('当前游戏状态不允许保存。请返回允许存档的页面后重新预览。');
        return sc;
    }

    function snapshot(sc) {
        const variables = JSON.stringify(sc.State.variables);
        if (typeof variables !== 'string') fail('当前游戏变量无法生成本机状态摘要。');
        return { passage: sc.State.passage, turns: sc.State.turns, variables };
    }

    const sameState = (left, right) => left.passage === right.passage && left.turns === right.turns && left.variables === right.variables;
    async function hash(value) {
        if (!window.crypto?.subtle) fail('当前浏览器缺少 SHA-256，无法核验操作与备份编号。');
        const bytes = new TextEncoder().encode(value);
        return [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function stampFor(payload, state) {
        const [variablesDigest, payloadDigest] = await Promise.all([hash(state.variables), hash(JSON.stringify(payload))]);
        return { version: 1, passage: state.passage, turns: state.turns, variablesDigest, payloadDigest };
    }

    async function prepare(payload) {
        const value = validate(payload);
        new Function(value.script);
        const state = snapshot(game());
        const stamp = await stampFor(value, state);
        if (!sameState(state, snapshot(game()))) fail('游戏状态已变化，请重新预览 JS 操作。');
        return {
            text: '操作说明\n' + value.summary + '\n\n纯 JS 脚本\n' + value.script + '\n\n验证步骤\n' + value.verification
                + '\n\n执行前将保存原生正常游戏存档，可下载 .save 后通过游戏存档界面导入。备份遵循原生存档范围，不覆盖整页、浏览器环境或所有即时副作用。'
                + '\n仅运行纯 JS，不解释 Twine 宏。异步任务不受控，不能保证完成；执行后请按验证步骤核验。',
            stamp
        };
    }

    function openDatabase() {
        if (!window.indexedDB) return Promise.reject(new Error('当前浏览器无法使用 IndexedDB 保存游戏备份。'));
        return new Promise((resolve, reject) => {
            let request, settled = false;
            const stop = error => { if (!settled) { settled = true; reject(error); } };
            try { request = window.indexedDB.open(MODHUB_GAME_BACKUP_DB, 1); }
            catch (error) { stop(error); return; }
            request.onupgradeneeded = () => {
                try {
                    if (!request.result.objectStoreNames.contains(MODHUB_GAME_BACKUP_STORE)) request.result.createObjectStore(MODHUB_GAME_BACKUP_STORE, { keyPath: 'id' });
                } catch (error) { request.transaction.abort(); stop(error); }
            };
            request.onerror = () => stop(request.error || new Error('游戏备份数据库无法打开。'));
            request.onblocked = () => stop(new Error('游戏备份数据库被其他页面占用，请关闭占用页面后重试。'));
            request.onsuccess = () => {
                if (settled) { request.result.close(); return; }
                if (!request.result.objectStoreNames.contains(MODHUB_GAME_BACKUP_STORE)) { request.result.close(); stop(new Error('游戏备份数据库结构无效。')); return; }
                settled = true; resolve(request.result);
            };
        });
    }

    async function transaction(mode, action) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            let tx, request, value;
            const stop = error => { db.close(); reject(error); };
            try {
                tx = db.transaction(MODHUB_GAME_BACKUP_STORE, mode);
                tx.oncomplete = () => { db.close(); resolve(value); };
                tx.onabort = tx.onerror = () => stop(tx.error || request?.error || new Error('游戏备份事务未完成。'));
                request = action(tx.objectStore(MODHUB_GAME_BACKUP_STORE));
                request.onsuccess = () => { value = request.result; };
            } catch (error) { tx?.abort(); stop(error); }
        });
    }

    function validBackupId(id) {
        if (typeof id !== 'string' || !/^modhub-game-[a-f0-9]{64}$/.test(id)) fail('游戏备份编号无效。');
        return id;
    }

    async function getBackup(backupId) {
        const id = validBackupId(backupId);
        const value = await transaction('readonly', store => store.get(id));
        if (value === undefined) return null;
        if (!value || value.id !== id || typeof value.data !== 'string' || !value.data) fail('游戏备份内容无效，请保留本机数据。');
        return value;
    }

    async function run(payload, stamp, id, assertActive) {
        let backupId = null, started = false;
        try {
            const value = validate(payload);
            new Function(value.script);
            if (typeof id !== 'string' || !id || id.length > 16000) fail('本机操作编号无效。');
            if (typeof assertActive !== 'function') fail('缺少当前操作的前台确认检查。');
            const active = key => { if (assertActive(key) === false) fail('请返回当前操作并重新预览确认。'); };
            active();
            const state = snapshot(game());
            const freshStamp = await stampFor(value, state);
            if (JSON.stringify(freshStamp) !== JSON.stringify(stamp) || !sameState(state, snapshot(game()))) fail('游戏状态或 JS 操作已变化，请重新预览确认。');
            const key = MODHUB_GAME_BACKUP_PREFIX + await hash(id);
            const existing = await getBackup(key);
            active();
            if (existing) { backupId = key; fail('该操作已有游戏备份。请使用已有记录核验，不能重复运行。'); }
            if (!sameState(state, snapshot(game()))) fail('游戏状态已变化，请重新预览确认。');
            const data = game().Save.serialize();
            if (typeof data !== 'string' || !data) fail('原生游戏存档未生成，JS 未运行。');
            // 原生保存回调会更新游戏变量；以保存后状态核验异步等待期间的变化。
            const savedState = snapshot(game());
            const record = { id: key, requestId: id, createdAt: Date.now(), passage: savedState.passage, turns: savedState.turns, data };
            await transaction('readwrite', store => store.add(record));
            const readback = await getBackup(key);
            if (JSON.stringify(readback) !== JSON.stringify(record)) fail('游戏备份回读内容不一致，JS 未运行。');
            backupId = key;
            active();
            if (!sameState(savedState, snapshot(game()))) fail('保存备份期间游戏状态已变化，请重新预览确认。');
            // 最终检查同时让调用方持久保存备份编号和正在运行记录。
            active(backupId);
            if (!sameState(savedState, snapshot(game()))) fail('游戏状态已变化，JS 未运行。');
            started = true;
            window.SugarCube.Scripting.evalJavaScript(value.script);
            return { ok: true, backupId, message: 'JS 已运行。异步任务不受控，不能保证完成；请按验证步骤核验。' };
        } catch (error) {
            return {
                ok: false, backupId,
                message: started ? 'JS 执行异常。备份已保留，请核验游戏状态；不会自动重试。' : 'JS 未运行。请查看本机错误详情。',
                error: errorText(error)
            };
        }
    }

    async function download(backupId) {
        const value = await getBackup(backupId);
        if (!value) fail('未找到此游戏备份。');
        const blob = new Blob([value.data], { type: 'text/plain;charset=UTF-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = value.id + '.save';
        document.body.appendChild(link);
        try { link.click(); }
        finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
        return true;
    }

    window.modHubGameCommand = Object.freeze({ prepare, run, download, getBackup });
})();
