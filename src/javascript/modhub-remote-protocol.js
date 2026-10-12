/** ModHub 远程协助协议工具：指令校验、限额读取、结果脱敏与操作说明。 */
(function() {
    'use strict';
    const MODHUB_REMOTE_LIMIT = 1024 * 1024;
    const labels = { runJavaScript: '快速 JS 指令', collectDiagnostics: '收集诊断', readSources: '读取源码', applyPatch: '应用补丁', applyConfiguration: '修复配置' };
    const json = value => JSON.stringify(value);
    const bytes = value => new TextEncoder().encode(value);
    const fail = message => { throw new Error(message); };

    const MODHUB_CODE_RISK_RULES = [
        ['网络相关文本', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, '文本中包含网络连接或数据发送相关名称。'],
        ['本机数据相关文本', /\b(?:localStorage|sessionStorage|indexedDB|caches)\b|\bdocument\s*(?:\.\s*cookie|\[\s*['"]cookie['"]\s*\])/, '文本中包含浏览器存储或 Cookie 相关名称，可能涉及本机数据。'],
        ['动态求值文本', /\b(?:eval|Function)\b|\bimport\s*\(/, '文本中包含动态执行或加载代码相关名称。'],
        ['脚本或 HTML 注入文本', /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*\.\s*write(?:ln)?\s*\(|<\s*script\b|\bon[a-z]+\s*=|\bjavascript\s*:|\bcreateElement\s*\(\s*['"`]script['"`]/i, '文本中包含页面内容写入、脚本或事件处理相关特征。'],
        ['异步调度文本', /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask|Promise|async|await)\b|\.\s*then\s*\(/, '文本中包含异步执行相关名称；同步返回不能证明后续任务已完成。']
    ];

    function inspectCodeSources(files) {
        if (!Array.isArray(files) || files.some(file => !file || typeof file.path !== 'string' || typeof file.content !== 'string')) fail('代码检查需要完整的文件路径和文本。');
        const findings = [];
        // shortcut: 仅匹配原文特征；需要限制代码权限时改用受限操作，不能将命中结果作为安全判定。
        for (const file of files) {
            for (const [category, pattern, reason] of MODHUB_CODE_RISK_RULES) {
                const match = pattern.exec(file.content);
                if (!match) continue;
                findings.push({ category, reason, path: file.path,
                    line: file.content.slice(0, match.index).split(/\r\n|\r|\n/).length,
                    excerpt: file.content.slice(Math.max(0, match.index - 60), match.index + 120) });
            }
        }
        return findings;
    }

    async function digest(value) {
        const result = await window.crypto.subtle.digest('SHA-256', bytes(json(value)));
        return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
    }

    async function readResponse(response) {
        if (!response.body?.getReader) {
            const raw = await response.text();
            if (bytes(raw).length > MODHUB_REMOTE_LIMIT) fail('协助服务返回的内容超过 1 MiB。');
            return raw;
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let length = 0, raw = '';
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done) return raw + decoder.decode();
                length += item.value.byteLength;
                if (length > MODHUB_REMOTE_LIMIT) fail('协助服务返回的内容超过 1 MiB。');
                raw += decoder.decode(item.value, { stream: true });
            }
        } finally { await reader.cancel().catch(() => {}); }
    }

    function redactResultText(value) {
        if (typeof window.modHubAiRepair?.sanitizeText !== 'function' || typeof window.modHubHelp?.redactRemoteCredentials !== 'function') fail('结果脱敏模块尚未就绪，请重新打开帮助中心后继续。');
        return window.modHubHelp.redactRemoteCredentials(window.modHubAiRepair.sanitizeText(String(value)));
    }

    async function validate(command) {
        if (!command || !Object.hasOwn(labels, command.kind) || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) fail('此协助操作不受支持。');
        if (await digest({ kind: command.kind, payload: command.payload }) !== command.digest) fail('操作内容与发布摘要不一致，已拒绝处理。');
        const p = command.payload;
        const allowed = { runJavaScript: ['summary', 'script', 'verification'], collectDiagnostics: ['allLogs'], readSources: ['name', 'paths'], applyPatch: ['name', 'version', 'baselineHash', 'summary', 'evidence', 'verification', 'changes'], applyConfiguration: ['issueId'] }[command.kind];
        if (Object.keys(p).some(key => !allowed.includes(key))) fail('操作包含未支持的字段，已拒绝处理。');
        if (command.kind === 'runJavaScript' && [['summary', 2000], ['script', 16000], ['verification', 2000]].some(([key, limit]) => typeof p[key] !== 'string' || !p[key].trim() || p[key].length > limit)) fail('快速指令须填写修复说明、纯 JS 正文与验证方法；限额分别为 2000、16000、2000 字。');
        if (command.kind === 'collectDiagnostics' && p.allLogs !== undefined && typeof p.allLogs !== 'boolean') fail('日志选择格式无效。');
        if (['readSources', 'applyPatch'].includes(command.kind) && (typeof p.name !== 'string' || !p.name || p.name.length > 256)) fail('操作缺少精确模组技术名。');
        if (command.kind === 'readSources' && (!Array.isArray(p.paths) || !p.paths.length || p.paths.length > 20 || p.paths.some(path => typeof path !== 'string'))) fail('源码请求必须包含 1 至 20 个已声明路径。');
        if (command.kind === 'applyPatch' && (typeof p.version !== 'string' || !p.version || !Array.isArray(p.changes) || !p.changes.length || p.changes.length > 8
            || p.changes.some(change => !change || typeof change.path !== 'string') || p.baselineHash !== undefined && !/^[a-f0-9]{64}$/.test(p.baselineHash))) fail('补丁的版本、路径或包体摘要格式无效。');
        if (command.kind === 'applyConfiguration' && (typeof p.issueId !== 'string' || !p.issueId || p.issueId.length > 1024)) fail('配置检查条目标识无效。');
    }

    function describeCommand(command) {
        const p = command.payload;
        let text = labels[command.kind];
        if (command.kind === 'runJavaScript') text += '：' + p.summary + '\n验证：' + p.verification + '\n须先备份游戏，再由玩家确认运行。';
        else if (command.kind === 'collectDiagnostics') text += '：版本、模组清单、检查摘要及' + (p.allLogs ? '全部已捕获日志。' : '错误和警告日志。');
        else if (command.kind === 'readSources') text += '：' + p.name + '\n文件：\n' + p.paths.join('\n');
        else if (command.kind === 'applyPatch') text += '：' + p.name + ' ' + p.version + '\n' + p.summary + '\n文件：\n' + [...new Set(p.changes.map(item => item.path))].join('\n');
        else text += '：根据本机重新检查，预览启用唯一前置或整理加载顺序的方案。';
        return text;
    }

    window.modHubRemoteProtocol = { validateCommand: validate, readResponse, redactResultText, describeCommand, inspectCodeSources };
})();
