/** ModHub 本地化：只绑定明确拥有的界面文本，不改写来源资料与业务数据。 */
(function () {
    'use strict';
    const MODHUB_LANGUAGE_KEY = 'modhub_language';
    const locales = ['zh-CN', 'zh-TW', 'en'];
    const dictionary = new Map();
    const exactMessages = new Map();
    const messageCache = new Map();
    const rendered = new WeakMap();
    let patterns = null;
    const interpolate = (text, params = {}) => String(text).replace(/\{([\w]+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] ?? '') : token);

    function browserLanguage() {
        // 无浏览器的本地沙箱沿用中文；真实浏览器无匹配语言时使用英语。
        if (typeof navigator === 'undefined') return 'zh-CN';
        for (const raw of navigator.languages?.length ? navigator.languages : [navigator.language]) {
            const tag = String(raw || '').toLowerCase();
            if (/^zh(?:-|$)/.test(tag)) {
                if (tag.includes('-hans')) return 'zh-CN';
                return /-(?:hant|tw|hk|mo)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
            }
            if (/^en(?:-|$)/.test(tag)) return 'en';
        }
        return 'en';
    }
    let language;
    try { language = window.localStorage?.getItem(MODHUB_LANGUAGE_KEY); } catch (_) {}
    if (!locales.includes(language)) language = browserLanguage();

    window.modHubRegisterTranslations = function (entries) {
        for (const [key, values] of Object.entries(entries)) {
            if (Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string' && value.length)) {
                dictionary.set(key, [key, ...values]);
                for (const value of [key, ...values]) exactMessages.set(value, key);
            }
        }
        patterns = null;
        messageCache.clear();
    };

    function getPatterns() {
        if (patterns) return patterns;
        patterns = [];
        for (const [key, values] of dictionary) {
            for (const value of values) {
                if (!/[a-zA-Z0-9\u3400-\u9fff]/.test(value.replace(/\{[\w]+\}/g, ''))) continue;
                const names = [];
                let expression = '', cursor = 0;
                for (const match of value.matchAll(/\{([\w]+)\}/g)) {
                    expression += value.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        + (/^(?:count|total|index|number|size|n|seconds|percent)$/i.test(match[1]) ? '(-?\\d+(?:[.,]\\d+)?)' : '([\\s\\S]*?)');
                    names.push(match[1]); cursor = match.index + match[0].length;
                }
                if (!names.length) continue;
                expression += value.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const first = value.indexOf('{'), last = value.lastIndexOf('}');
                patterns.push({ key, names, regex: new RegExp('^' + expression + '$'), prefix: value.slice(0, first), suffix: value.slice(last + 1), weight: value.length - names.length * 3 });
            }
        }
        patterns.sort((a, b) => b.weight - a.weight);
        return patterns;
    }

    function matchMessage(text) {
        if (dictionary.has(text)) return { key: text, params: {} };
        if (exactMessages.has(text)) return { key: exactMessages.get(text), params: {} };
        if (messageCache.has(text)) return messageCache.get(text);
        for (const pattern of getPatterns()) {
            if (!text.startsWith(pattern.prefix) || !text.endsWith(pattern.suffix)) continue;
            const match = pattern.regex.exec(text);
            if (match) {
                const params = {};
                let consistent = true;
                pattern.names.forEach((name, index) => {
                    if (Object.prototype.hasOwnProperty.call(params, name) && params[name] !== match[index + 1]) consistent = false;
                    params[name] = match[index + 1];
                });
                if (!consistent) continue;
                const result = { key: pattern.key, params };
                if (messageCache.size >= 2048) messageCache.clear();
                messageCache.set(text, result);
                return result;
            }
        }
        if (messageCache.size >= 2048) messageCache.clear();
        messageCache.set(text, null);
        return null;
    }

    window.modHubGetLanguage = () => language;
    window.modHubT = function (key, params) {
        const source = String(key ?? '');
        const found = dictionary.has(source) ? { key: source, params: params || {} } : params ? null : matchMessage(source);
        const entry = found && dictionary.get(found.key);
        return interpolate(entry ? entry[locales.indexOf(language)] : source, params || found?.params);
    };
    window.modHubTranslateText = text => window.modHubT(text);
    window.modHubFormatDate = (value, options = {}) => new Date(value).toLocaleString(language, options);

    function remember(node, attribute, key, params = {}) {
        const suffix = attribute ? '-' + attribute : '-key';
        node.setAttribute('data-modhub-i18n' + suffix, key);
        node.setAttribute('data-modhub-i18n' + suffix + '-params', JSON.stringify(params));
        update(node, attribute);
    }

    function update(node, attribute = '') {
        const suffix = attribute ? '-' + attribute : '-key';
        const key = node.getAttribute?.('data-modhub-i18n' + suffix);
        if (key === null || key === undefined) return;
        let params = {};
        try { params = JSON.parse(node.getAttribute('data-modhub-i18n' + suffix + '-params') || '{}'); } catch (_) {}
        const value = window.modHubT(key, params);
        if (attribute) node.setAttribute(attribute, value);
        else node.textContent = value;
        const previous = rendered.get(node) || {};
        previous[attribute] = value; rendered.set(node, previous);
    }

    window.modHubBindText = function (node, key, params) {
        const message = params === undefined ? matchMessage(String(key ?? '')) : null;
        // 按钮的文案独立绑定，给进度圆环、图标和角标保留节点。
        if (node?.nodeType === 1 && node.tagName === 'BUTTON') {
            let label = node.querySelector('.modhub-i18n-label,[data-modhub-i18n-key]');
            if (!label) {
                const holder = node.querySelector('.modhub-button-busy-label') || node;
                for (const child of [...holder.childNodes]) if (child.nodeType === 3) holder.removeChild(child);
                label = document.createElement('span'); label.className = 'modhub-i18n-label'; holder.appendChild(label);
            }
            node = label;
        }
        if (node) {
            node.textContent = window.modHubT(message?.key || key, params || message?.params || {});
            remember(node, '', message?.key || key, params || message?.params || {});
        }
        return node;
    };
    const attributes = ['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label'];
    const ignored = node => node?.nodeType === 1 && (node.hasAttribute?.('data-modhub-i18n-ignore') || node.hasAttribute?.('data-modhub-no-translate'));
    const rawBody = node => ['PRE', 'CODE', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(node.tagName);

    window.modHubLocalizeOwned = function (root) {
        if (!root?.childNodes) return root;
        if (root.nodeType === 1) { root.setAttribute('data-modhub-i18n-root', ''); root.setAttribute('lang', language); }
        function visit(node) {
            if (ignored(node)) return;
            if (node.nodeType === 1) {
                for (const attribute of attributes) {
                    if (attribute === 'label' && node.tagName !== 'OPTGROUP') continue;
                    const value = node.getAttribute(attribute);
                    if (!value) continue;
                    const message = matchMessage(value);
                    if (message) remember(node, attribute, message.key, message.params);
                }
                if (rawBody(node)) return;
                if (node.hasAttribute('data-modhub-i18n-key')) {
                    const current = node.textContent;
                    const previous = rendered.get(node)?.[''];
                    if (previous !== undefined && current !== previous) {
                        const message = matchMessage(current);
                        if (message) remember(node, '', message.key, message.params);
                        else { node.removeAttribute('data-modhub-i18n-key'); node.removeAttribute('data-modhub-i18n-key-params'); }
                    } else update(node);
                    return;
                }
            }
            for (const child of [...node.childNodes]) {
                if (child.nodeType !== 3) { visit(child); continue; }
                const text = child.nodeValue || '';
                const clean = text.trim();
                if (!clean) continue;
                const exact = matchMessage(text);
                const message = exact || matchMessage(clean);
                if (!message) continue;
                const prefix = exact ? '' : text.slice(0, text.indexOf(clean)), tail = exact ? '' : text.slice(text.indexOf(clean) + clean.length);
                const params = message.params;
                if (!prefix && !tail && node.nodeType === 1 && node.tagName !== 'BUTTON' && node.childNodes.length === 1) {
                    remember(node, '', message.key, params);
                } else {
                    const label = document.createElement('span');
                    label.className = 'modhub-i18n-label';
                    remember(label, '', message.key, params);
                    if (prefix) node.insertBefore(document.createTextNode(prefix), child);
                    node.insertBefore(label, child);
                    if (tail) node.insertBefore(document.createTextNode(tail), child);
                    node.removeChild(child);
                }
            }
        }
        visit(root);
        return root;
    };

    window.modHubTranslateHtml = function (html) {
        const template = document.createElement('template');
        // 老测试沙箱没有 HTML 解析器，仍由显式文案接口验证翻译。
        if (!template.content) return String(html);
        template.innerHTML = String(html);
        window.modHubLocalizeOwned(template.content);
        return template.innerHTML;
    };

    window.modHubApplyLanguage = function (root = document) {
        if (!root?.querySelectorAll) return;
        const selector = ['[data-modhub-i18n-key]', ...attributes.map(attribute => '[data-modhub-i18n-' + attribute + ']')].join(',');
        const nodes = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
        for (const node of nodes) {
            if (node.closest?.('[data-modhub-i18n-ignore],[data-modhub-no-translate]')) continue;
            if (!rawBody(node) && !node.parentElement?.closest?.('pre,code,textarea,script,style')) update(node);
            for (const attribute of attributes) update(node, attribute);
        }
        for (const node of [...(root.hasAttribute?.('data-modhub-i18n-root') ? [root] : []), ...root.querySelectorAll('[data-modhub-i18n-root]')]) node.setAttribute('lang', language);
        root.querySelectorAll('[data-modhub-language-control]').forEach(control => refreshLanguageControl(control));
    };

    window.modHubIsLanguageBusy = function () {
        return !!(window.modHubIsReloadBusy?.() || window.modHubHelp?.isBusy?.() || window.modHubRemoteAssist?.isBusy?.() || window.modHubCompatibility?.isBusy?.()
            || document.querySelector?.('.modhub-modal-backdrop,[data-modhub-language-busy="true"],.modhub-restore-panel[aria-busy="true"]'));
    };
    window.modHubRefreshLanguageSelectors = function () {
        const busy = window.modHubIsLanguageBusy();
        for (const control of document.querySelectorAll?.('[data-modhub-language-control]') || []) refreshLanguageControl(control, busy);
    };
    window.modHubSetLanguage = function (next) {
        if (!locales.includes(next)) return false;
        if (window.modHubIsLanguageBusy()) {
            window.modHubShowToast?.(window.modHubT('当前操作尚未完成。请等待操作完成或取消后再切换语言。'), 'warning');
            window.modHubRefreshLanguageSelectors(); return false;
        }
        if (next === language) return true;
        const previousLanguage = language;
        language = next;
        let storageError;
        try { window.localStorage.setItem(MODHUB_LANGUAGE_KEY, next); } catch (error) { storageError = error; }
        window.modHubApplyLanguage();
        const detail = { language, previousLanguage };
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(typeof CustomEvent === 'function' ? new CustomEvent('modhub:languagechange', { detail }) : { type: 'modhub:languagechange', detail });
        window.modHubApplyLanguage();
        window.modHubRefreshLanguageSelectors();
        if (storageError) window.modHubShowToast?.(window.modHubT('语言已切换，但无法保存偏好：{reason}。本次页面关闭后可能需要重新选择。', { reason: storageError.message || String(storageError) }), 'warning');
        return true;
    };

    const languageNames = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' };
    let languageControlCount = 0;
    function closeLanguageControl(control, focus = false) {
        if (!control) return;
        control.open = false;
        const panel = control.querySelector('.modhub-language-popover');
        if (typeof panel?.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
        const toggle = control.querySelector('.modhub-language-toggle');
        toggle?.setAttribute('aria-expanded', 'false');
        if (focus) toggle?.focus();
    }
    function refreshLanguageControl(control, busy = window.modHubIsLanguageBusy()) {
        for (const option of control.querySelectorAll('[data-modhub-language-option]')) {
            option.checked = option.value === language;
            option.disabled = busy;
        }
        const toggle = control.querySelector('.modhub-language-toggle');
        const name = toggle?.querySelector('[data-modhub-language-name]');
        if (name) name.textContent = languageNames[language];
        const label = window.modHubT('界面语言') + '：' + languageNames[language];
        toggle?.setAttribute('aria-label', label);
        toggle?.setAttribute('aria-disabled', String(busy));
        if (toggle) toggle.title = busy ? window.modHubT('当前操作尚未完成。请等待操作完成或取消后再切换语言。') : label;
        if (busy) closeLanguageControl(control);
    }
    function positionLanguageControl(control) {
        const panel = control.querySelector('.modhub-language-popover');
        const rect = control.querySelector('.modhub-language-toggle').getBoundingClientRect();
        const width = document.documentElement.clientWidth || window.innerWidth;
        const height = window.innerHeight || document.documentElement.clientHeight;
        panel.style.left = '0px'; panel.style.top = '0px';
        const box = panel.getBoundingClientRect();
        // 旧浏览器的固定定位可能以带滤镜的浮层为包含块。
        panel.style.left = (Math.max(8, Math.min(rect.right - box.width, width - box.width - 8)) - box.left) + 'px';
        panel.style.top = (Math.max(8, Math.min(rect.bottom + 6, height - box.height - 8)) - box.top) + 'px';
    }
    function languageControls() { return document.querySelectorAll?.('.modhub-language-control[open]') || []; }
    document.addEventListener('pointerdown', event => {
        for (const control of languageControls()) if (!control.contains(event.target)) closeLanguageControl(control);
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const controls = [...languageControls()];
        if (!controls.length) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
        for (const control of controls) closeLanguageControl(control, true);
    }, true);
    window.addEventListener?.('resize', () => { for (const control of languageControls()) positionLanguageControl(control); });
    document.addEventListener('scroll', () => { for (const control of languageControls()) positionLanguageControl(control); }, true);

    window.modHubCreateLanguageSelector = function () {
        // 早期救援也使用同一控件，不等待普通样式表加载。
        if (!document.getElementById('modHubLanguageControlStyle')) {
            const style = document.createElement('style'); style.id = 'modHubLanguageControlStyle';
            style.textContent = `.modhub-language-control{display:inline-block;flex:0 0 auto;position:relative;max-width:100%;margin:0;font:inherit;color:var(--300,#bbb)}
.modhub-language-control>.modhub-language-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:32px;max-width:100%;padding:4px 9px;border:1px solid var(--600,#666);border-radius:3px;background:var(--850,#222);color:var(--200,#ddd);font:inherit;font-size:.875rem;line-height:1.35;white-space:nowrap;list-style:none;cursor:pointer}
.modhub-language-toggle::-webkit-details-marker{display:none}.modhub-language-toggle::after{content:'';width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:translateY(-2px) rotate(45deg)}
.modhub-language-toggle:hover,.modhub-language-toggle:focus-visible{border-color:var(--gold,#d6b365);outline:none}.modhub-language-toggle[aria-disabled=true]{opacity:.55;cursor:default}
.modhub-language-control>.modhub-language-popover{position:fixed;inset:auto;z-index:100010;box-sizing:border-box;width:max-content;min-width:160px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;margin:0;padding:4px;background:var(--850,#222);color:var(--200,#ddd);border:1px solid var(--600,#666);border-radius:4px;box-shadow:0 6px 18px #0009;font:14px/1.4 sans-serif;text-align:left;white-space:normal}
.modhub-language-control:not([open])>.modhub-language-popover{display:none!important}.modhub-language-popover>.modhub-language-option{display:flex;align-items:center;gap:9px;box-sizing:border-box;min-height:36px;margin:0;padding:6px 10px;border:1px solid transparent;border-radius:2px;color:inherit;font:inherit;cursor:pointer}.modhub-language-option:hover,.modhub-language-option:focus-within{background:var(--800,#333);border-color:var(--600,#666)}.modhub-language-option>input{flex:0 0 auto;width:14px;height:14px;margin:0;accent-color:var(--gold,#d6b365)}`;
            document.head?.appendChild(style);
        }
        const control = document.createElement('details');
        control.className = 'modhub-language-control';
        control.setAttribute('data-modhub-language-control', '');
        const toggle = document.createElement('summary'); toggle.className = 'modhub-language-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        const name = document.createElement('span'); name.setAttribute('data-modhub-language-name', '');
        name.setAttribute('data-modhub-no-translate', ''); name.textContent = languageNames[language]; toggle.appendChild(name);
        control.appendChild(toggle);
        const panel = document.createElement('div'); panel.className = 'modhub-language-popover';
        if (typeof panel.showPopover === 'function') panel.setAttribute('popover', 'manual');
        panel.setAttribute('role', 'radiogroup');
        panel.setAttribute('aria-label', window.modHubT('界面语言'));
        panel.setAttribute('data-modhub-i18n-aria-label', '界面语言');
        const groupName = 'modHubLanguage' + (++languageControlCount);
        for (const value of locales) {
            const label = document.createElement('label'); label.className = 'modhub-language-option';
            const option = document.createElement('input'); option.type = 'radio'; option.name = groupName; option.value = value;
            option.setAttribute('data-modhub-language-option', '');
            option.addEventListener('change', () => {
                if (!option.checked) return;
                window.modHubSetLanguage(value);
                closeLanguageControl(control, true);
            });
            option.addEventListener('click', () => { if (option.checked && value === language) closeLanguageControl(control, true); });
            const text = document.createElement('span'); text.textContent = languageNames[value];
            text.setAttribute('data-modhub-no-translate', ''); text.setAttribute('lang', value);
            label.appendChild(option); label.appendChild(text); panel.appendChild(label);
        }
        control.appendChild(panel);
        toggle.addEventListener('click', event => {
            if (window.modHubIsLanguageBusy()) { event.preventDefault(); window.modHubRefreshLanguageSelectors(); }
        });
        control.addEventListener('toggle', () => {
            if (!control.open) { closeLanguageControl(control); return; }
            for (const other of languageControls()) if (other !== control) closeLanguageControl(other);
            if (window.modHubIsLanguageBusy()) { closeLanguageControl(control); return; }
            toggle.setAttribute('aria-expanded', 'true');
            if (typeof panel.showPopover === 'function' && !panel.matches(':popover-open')) panel.showPopover();
            positionLanguageControl(control);
            panel.querySelector('[data-modhub-language-option]:checked')?.focus();
        });
        refreshLanguageControl(control);
        return control;
    };

    window.modHubRegisterTranslations({
        '界面语言': ['介面語言', 'Interface language'],
        '当前操作尚未完成。请等待操作完成或取消后再切换语言。': ['目前操作尚未完成。請等待操作完成或取消後再切換語言。', 'An operation is still in progress. Wait for it to finish or cancel it before changing languages.'],
        '语言已切换，但无法保存偏好：{reason}。本次页面关闭后可能需要重新选择。': ['語言已切換，但無法儲存偏好：{reason}。本次頁面關閉後可能需要重新選擇。', 'Language changed, but the preference could not be saved: {reason}. You may need to select it again after closing this page.']
    });
    // 字典只读快照用于检查三语完整性，不向界面暴露内部键。
    window.modHubGetTranslations = () => Object.fromEntries([...dictionary].map(([key, values]) => [key, values.slice()]));
})();
