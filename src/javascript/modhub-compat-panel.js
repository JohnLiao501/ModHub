/** ModHub 兼容性检查面板：只展示本地检查结果，不修改模组配置。 */
(function () {
    'use strict';
    const api = window.modHubCompatibility || (window.modHubCompatibility = {});
    const escape = value => window.modHubEscapeHtml(String(value ?? ''));
    const detail = error => String(error?.message || error || '未提供具体原因');
    let active = null;

    function render(snapshot, { compact = false } = {}) {
        const compatibility = snapshot?.compatibility || {};
        const findings = Array.isArray(compatibility.findings) ? compatibility.findings : (snapshot?.issues || []).map(issue => ({
            ...issue, kind: issue.id?.startsWith('log-') ? 'runtime' : 'configuration', mods: [], logs: []
        }));
        const visibleFindings = findings.filter(item => item.id !== 'configuration-different');
        const confirmed = visibleFindings.filter(item => item.kind === 'configuration' && item.status === 'problem');
        const runtime = visibleFindings.filter(item => item.kind === 'runtime');
        const related = visibleFindings.filter(item => item.kind !== 'runtime' && !confirmed.includes(item));
        const coverage = Array.isArray(compatibility.coverage) ? compatibility.coverage : [];
        const projected = Boolean(compatibility.projected);
        const text = value => {
            const original = String(value ?? '');
            return escape(original.slice(0, 16384)) + (original.length > 16384 ? '（正文过长，后续内容未展示）' : '');
        };
        const names = item => Array.isArray(item.mods) && item.mods.length ? item.mods
            : item.query ? [item.query] : [...String(item.evidence || '').slice(0, 16384).matchAll(/【([^】]+)】/g)].slice(0, 2).map(match => match[1]);
        const labels = {
            '插件提供者版本不满足要求': '前置插件版本不符合要求',
            '声明中存在循环依赖': '模组的加载要求互相矛盾',
            '本次运行未查到所需插件注册': '本次运行未确认所需插件已加载',
            '多个模组声明修改同一目标': '多个模组修改了相同内容'
        };
        const evidence = item => {
            const logs = Array.isArray(item.logs) ? item.logs : [];
            const rules = Array.isArray(item.rules) ? item.rules : [];
            const mods = names(item);
            const target = typeof item.target === 'string' ? item.target : item.target?.name || '';
            return '<div class="modhub-compat-evidence"><p><strong>' + text(mods.join('、') || item.title) + '</strong></p><p><strong>依据：</strong>' + text(item.evidence) + '</p>'
                + (mods.length ? '<p><strong>相关模组：</strong>' + mods.slice(0, 50).map(text).join('、') + (mods.length > 50 ? '（另有 ' + (mods.length - 50) + ' 项未展示）' : '') + '</p>' : '')
                + (target ? '<p><strong>目标：</strong>' + text(target) + '</p>' : '')
                + '<p class="grey"><strong>建议：</strong>' + text(item.advice) + '</p>'
                + (rules.length ? '<details class="modhub-compat-rules"><summary>查看补丁声明（' + rules.length + ' 条）</summary><ol tabindex="0" aria-label="相关补丁声明">'
                    + rules.slice(0, 200).map(rule => '<li><strong>' + text(rule.modName) + '</strong><p>引擎：' + text(rule.engine)
                        + '</p><p>声明位置：' + text(rule.field) + '</p><p>查找声明：</p><pre>' + text(rule.find)
                        + '</pre><p>替换来源：' + text(rule.replacement) + '</p></li>').join('') + '</ol>'
                    + (rules.length > 200 ? '<p class="grey">另有 ' + (rules.length - 200) + ' 条声明未展示，请缩小问题范围后核对。</p>' : '') + '</details>' : '')
                + (logs.length ? '<details class="modhub-compat-logs"><summary>查看日志（' + logs.length + ' 条）</summary><ol tabindex="0" aria-label="相关日志">'
                    + logs.slice(0, 20).map(log => '<li><strong>' + (Number.isInteger(log.index) ? '第 ' + (log.index + 1) + ' 条日志' : '日志位置未识别')
                        + '</strong><pre>' + text(log.message) + '</pre></li>').join('') + '</ol>'
                    + (logs.length > 20 ? '<p class="grey">另有 ' + (logs.length - 20) + ' 条日志未展示，可在求助报告中查看。</p>' : '') + '</details>' : '')
                + '</div>';
        };
        const rows = (items, confirmedGroup) => {
            const groups = new Map();
            for (const item of items) {
                const key = JSON.stringify([item.kind, item.title]);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            }
            let budget = 200;
            return [...groups.values()].slice(0, 200).map(group => {
                const item = group[0], mods = [...new Set(group.flatMap(names))];
                const shown = group.slice(0, budget);
                budget -= shown.length;
                const shortNames = mods.slice(0, 3).map(text).join('、') + (mods.length > 3 ? ' 等 ' + mods.length + ' 个模组' : '');
                const advice = item.kind === 'overlap' ? '请查看作者的兼容说明。若游戏出现异常，可从以下模组开始排查。'
                    : group.every(entry => entry.advice === item.advice) ? item.advice : '';
                const adviceHtml = advice ? '<p class="modhub-conflict-advice">' + text(advice) + '</p>'
                    : shown.map(entry => '<p class="modhub-conflict-advice">' + text(names(entry).join('、') || entry.title) + '：' + text(entry.advice) + '</p>').join('');
                return '<section class="modhub-compat-finding"><div class="modhub-compat-finding-heading"><strong class="' + (confirmedGroup ? 'red' : 'gold') + '">'
                    + text(labels[item.title] || item.title) + '</strong><span class="modhub-compat-count grey">' + group.length + (item.kind === 'overlap' ? ' 处内容' : ' 项') + '</span></div>'
                    + '<div class="modhub-compat-finding-body modhub-conflict-item">'
                    + (shortNames ? '<div class="modhub-conflict-title-row"><strong class="modhub-conflict-name">' + shortNames + '</strong></div>' : '')
                    + adviceHtml
                    + '<details class="modhub-compat-technical"><summary>查看依据</summary><div class="modhub-compat-detail-list" tabindex="0" aria-label="问题依据">'
                    + shown.map(evidence).join('') + (group.length > shown.length ? '<p class="grey">另有 ' + (group.length - shown.length) + ' 项结果未展示，请缩小问题范围后核对。</p>' : '')
                    + '</div></details></div></section>';
            }).join('') + (groups.size > 200 ? '<p class="grey">另有 ' + (groups.size - 200) + ' 项结果未展示，请缩小问题范围后核对。</p>' : '');
        };
        const coverageGroups = new Map();
        for (const item of coverage) {
            if (!coverageGroups.has(item.reason)) coverageGroups.set(item.reason, []);
            coverageGroups.get(item.reason).push(item);
        }
        const coverageHtml = [...coverageGroups].slice(0, 200).map(([reason, entries]) => {
            const mods = [...new Set(entries.map(item => item.modName).filter(Boolean))];
            return '<div class="modhub-compat-coverage-reason"><p>' + text(reason) + '</p>'
                + (mods.length ? '<p class="grey">' + mods.slice(0, 50).map(text).join('、') + (mods.length > 50 ? ' 等 ' + mods.length + ' 个模组' : '') + '</p>' : '')
                + '<details class="modhub-compat-technical"><summary>涉及的模组</summary><ul class="modhub-compat-detail-list" tabindex="0" aria-label="未核对项目">'
                + entries.slice(0, 200).map(item => '<li>' + text(item.modName) + '：' + text([item.source, item.field].filter(Boolean).join(' · ')) + '</li>').join('') + '</ul>'
                + (entries.length > 200 ? '<p class="grey">另有 ' + (entries.length - 200) + ' 项未核对内容未展示。</p>' : '') + '</details></div>';
        }).join('') + (coverageGroups.size > 200 ? '<p class="grey">另有 ' + (coverageGroups.size - 200) + ' 类未核对内容未展示。</p>' : '');
        const oldRuntime = projected || Boolean(snapshot?.different);
        const runtimeProblem = !oldRuntime && runtime.some(item => item.status === 'problem');
        const overlapsOnly = related.length > 0 && related.every(item => item.kind === 'overlap');
        const headline = snapshot?.stale ? '检查内容已更改，请重新检查'
            : confirmed.length ? confirmed.every(item => /缺少/.test(item.title)) ? '请注意：部分模组缺少前置'
                : confirmed.every(item => /未启用/.test(item.title)) ? '请注意：部分前置尚未启用'
                : confirmed.every(item => /加载器或运行库/.test(item.title)) ? '请注意：加载器或运行库版本不符合要求'
                : confirmed.every(item => /版本/.test(item.title)) ? '请注意：部分前置版本不符合要求'
                : confirmed.every(item => /顺序/.test(item.title)) ? '请注意：需要调整模组加载顺序'
                : '请注意：有 ' + confirmed.length + ' 项模组要求尚未满足'
            : overlapsOnly ? '请注意：部分模组可能存在冲突' : related.length ? '请注意：部分模组要求尚未确认'
            : runtimeProblem ? '请注意：部分模组功能可能未生效' : '未发现需要您处理的问题';
        const summary = snapshot?.stale ? '模组配置或安装包已更改，请重新检查。'
            : confirmed.length ? '请按以下建议处理，再重新检查。'
            : related.length ? ''
            : runtimeProblem ? '请展开“运行日志”，查看涉及的模组和处理建议。'
            : projected ? '已按安装计划核对可读取的模组要求。安装后需重新载入游戏。'
            : '已完成可读取内容的检查。如游戏仍有异常，可复制求助报告。';
        const runtimeSource = projected ? '以下日志来自安装前。安装后请重新载入游戏，查看最新结果。'
            : snapshot?.different ? '模组配置已更改。以下日志来自更改前，请重新载入游戏后再检查。'
            : '以下内容来自本次运行日志。请结合异常出现的场景和作者说明排查。';
        const headlineColor = snapshot?.stale ? 'gold' : confirmed.length || related.length || runtimeProblem ? 'red' : '';
        return '<div class="modhub-compat-report' + (compact ? ' modhub-compat-compact' : '') + '">'
            + '<details class="modhub-compat-details"><summary class="modhub-compat-summary' + (headlineColor ? ' ' + headlineColor : '') + '"><strong class="modhub-conflict-heading ' + headlineColor + '">' + text(headline) + '</strong></summary>'
            + '<div class="modhub-compat-report-body">' + (summary ? '<p class="grey">' + text(summary) + '</p>' : '')
            + (confirmed.length ? '<section class="modhub-compat-section" data-compat-group="configuration"><div class="modhub-compat-group-heading"><strong>需要处理的问题</strong><span class="modhub-compat-count red">' + confirmed.length + ' 项</span></div>'
                + '<div class="modhub-conflict-list">' + rows(confirmed, true) + '</div></section>' : '')
            + (related.length ? '<section class="modhub-compat-section" data-compat-group="related">' + (overlapsOnly ? '' : '<div class="modhub-compat-group-heading"><strong>需要核对的内容</strong><span class="modhub-compat-count gold">' + related.length + ' 项</span></div>')
                + '<div class="modhub-conflict-list">' + rows(related, false) + '</div></section>' : '')
            + (runtime.length ? '<details class="modhub-compat-section" data-compat-group="runtime"><summary><span>' + (oldRuntime ? '之前的运行日志' : '运行日志') + '</span><span class="modhub-compat-count grey">' + runtime.length + ' 项</span></summary>'
                + '<div class="modhub-conflict-list"><p class="modhub-compat-context grey">' + text(runtimeSource) + '</p>' + rows(runtime, false) + '</div></details>' : '')
            + '<details class="modhub-compat-section" data-compat-group="coverage"><summary><span>检查说明</span><span class="modhub-compat-count grey">' + (coverage.length ? '有未确认内容' : '') + '</span></summary>'
            + '<div class="modhub-compat-coverage">' + (coverageHtml || '<p class="grey">已完成可读取内容的检查。</p>')
            + '<p class="grey">已检查模组的前置要求和可读取的补丁内容。' + (projected ? '安装后请重新载入游戏。' : '如需帮助，可复制求助报告。') + '</p></div></details></div></details></div>';
    }

    function show(snapshot) {
        if (active) return active.promise;
        if (typeof api.check !== 'function' || typeof window.modHubConfirm !== 'function') {
            return Promise.resolve(window.modHubAlert?.('兼容性检查尚未就绪，请等待模组加载完成后重试。', '无法开始检查')).then(() => false);
        }
        const previousFocus = document.activeElement;
        const state = { controller: null, snapshot: null, closed: false };
        active = state;
        const open = () => !state.closed && active === state;
        state.promise = Promise.resolve(window.modHubConfirm({
            title: '兼容性检查', confirmText: '关闭', cancelText: '', dialogClass: 'modhub-compat-dialog',
            trustedMessageHtml: '<div class="modhub-compat-toolbar"><span class="grey">本地检查，不更改配置。</span>'
                + '<div class="modhub-compat-actions"><button type="button" class="macro-button modhub-btn-secondary" data-compat-check>重新检查</button>'
                + '<button type="button" class="macro-button modhub-btn-secondary" data-compat-cancel hidden>取消检查</button></div></div>'
                + '<p data-compat-status class="grey" role="status" aria-live="polite"></p>'
                + '<div data-compat-results class="modhub-compat-results" tabindex="0" role="region" aria-label="兼容性检查结果"></div>'
                + '<details class="modhub-compat-tools"><summary>求助报告</summary><div class="modhub-compat-actions">'
                + '<button type="button" class="macro-button modhub-btn-secondary" data-compat-preview disabled>预览报告</button>'
                + '<button type="button" class="macro-button modhub-btn-secondary" data-compat-copy disabled>复制报告</button></div>'
                + '<details data-compat-report hidden><summary>报告内容</summary><textarea class="modhub-compat-report-text" aria-label="求助报告，可选择文本手动复制" readonly></textarea></details></details>',
            onRender(dialog) {
                const status = dialog.querySelector('[data-compat-status]');
                const results = dialog.querySelector('[data-compat-results]');
                const checkButton = dialog.querySelector('[data-compat-check]');
                const cancelButton = dialog.querySelector('[data-compat-cancel]');
                const previewButton = dialog.querySelector('[data-compat-preview]');
                const copyButton = dialog.querySelector('[data-compat-copy]');
                const report = dialog.querySelector('[data-compat-report]');
                const reportText = dialog.querySelector('.modhub-compat-report-text');
                const present = result => {
                    state.snapshot = result;
                    results.innerHTML = render(result);
                    previewButton.disabled = copyButton.disabled = Boolean(result.stale);
                    status.className = result.stale ? 'gold' : 'grey';
                    status.textContent = result.stale ? '请重新检查。' : '';
                };
                const run = async () => {
                    if (state.controller) return;
                    const controller = new AbortController();
                    state.controller = controller;
                    state.snapshot = null;
                    results.innerHTML = '';
                    report.hidden = true; reportText.value = '';
                    checkButton.disabled = previewButton.disabled = copyButton.disabled = true;
                    cancelButton.hidden = false;
                    status.className = 'grey';
                    status.innerHTML = window.modHubLoadingHtml('正在检查已安装的模组组合，请稍候。');
                    try {
                        const result = await api.check({ signal: controller.signal, onProgress(progress) {
                            if (!open() || controller.signal.aborted) return;
                            status.textContent = typeof progress === 'string' ? progress : progress?.message || '正在核对模组声明与本次日志，请稍候。';
                        } });
                        if (!open() || controller.signal.aborted) return;
                        present(result);
                        results.focus?.({ preventScroll: true });
                    } catch (error) {
                        if (!open()) return;
                        status.className = controller.signal.aborted || error?.name === 'AbortError' ? 'gold' : 'red';
                        status.textContent = controller.signal.aborted || error?.name === 'AbortError'
                            ? '已取消检查。模组配置未更改。' : '检查未完成。具体原因：' + detail(error);
                    } finally {
                        if (state.controller === controller) state.controller = null;
                        if (open()) { checkButton.disabled = false; cancelButton.hidden = true; }
                    }
                };
                const buildReport = async () => {
                    if (!state.snapshot || state.snapshot.stale) return '';
                    const currentSnapshot = state.snapshot;
                    try {
                        await api.assertCurrent?.(currentSnapshot);
                        if (!open() || state.snapshot !== currentSnapshot) return '';
                    } catch (error) {
                        if (!open() || state.snapshot !== currentSnapshot) return '';
                        currentSnapshot.stale = true;
                        present(currentSnapshot);
                        report.hidden = true; reportText.value = '';
                        status.className = 'gold';
                        status.textContent = '检查结果已过期。具体原因：' + detail(error) + ' 请重新检查后生成报告。';
                        return '';
                    }
                    if (typeof window.modHubHelp?.buildReport !== 'function') {
                        await window.modHubAlert?.('求助报告尚未就绪，请等待帮助中心加载完成后重试。', '无法生成报告');
                        return '';
                    }
                    const value = window.modHubHelp.buildReport(currentSnapshot);
                    reportText.value = value;
                    report.hidden = false; report.open = true;
                    return value;
                };
                checkButton.onclick = run;
                cancelButton.onclick = () => {
                    state.controller?.abort();
                    status.className = 'gold'; status.textContent = '已取消检查。模组配置未更改。';
                };
                previewButton.onclick = async () => { if (await buildReport()) reportText.focus?.(); };
                copyButton.onclick = async () => {
                    const value = await buildReport();
                    if (value && typeof window.modHubHelp?.copyReport === 'function') await window.modHubHelp.copyReport(value);
                    else if (value) { reportText.focus?.(); reportText.select?.(); status.textContent = '请在预览框中选择文本并手动复制。'; }
                };
                if (snapshot) present(snapshot);
                else void run();
            }
        })).finally(() => {
            state.closed = true;
            state.controller?.abort();
            if (active === state) active = null;
            if (previousFocus?.isConnected !== false) previousFocus?.focus?.({ preventScroll: true });
        });
        return state.promise;
    }

    Object.assign(api, { render, show });
})();
