/**
 * ModHub - 模组说明、Markdown 与内置图片浏览。
 * 共享接口由 modhub-manager.js 提供；市场服务在打开说明时读取。
 */

let modHubReadmeRequestId = 0;

// Shields.io 颜色映射表
const MODHUB_SHIELDS_COLORS = {
    brightgreen: '#4c1',
    green: '#97ca00',
    yellowgreen: '#a4a61d',
    yellow: '#dfb317',
    orange: '#fe7d37',
    red: '#e05d44',
    blue: '#007ec6',
    lightgrey: '#9f9f9f',
    lightgray: '#9f9f9f',
    grey: '#555555',
    gray: '#555555',
    purple: '#795298',
    violet: '#795298',
    black: '#24292e',
    informational: '#007ec6',
    success: '#4c1',
    critical: '#e05d44',
    important: '#fe7d37',
    inactive: '#9f9f9f'
};

// 预估字符渲染宽度（Verdana / 类似系统无衬线字体，字号 11px）
window.modHubEstimateBadgeTextWidth = function(text) {
    if (!text) return 0;
    const str = String(text);
    let width = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code > 0x7f) {
            width += 12;
        } else if (/[ilj|!:',. ]/i.test(str[i])) {
            width += 4.5;
        } else if (/[mwWM@%]/i.test(str[i])) {
            width += 9.2;
        } else if (/[A-Z]/.test(str[i])) {
            width += 7.2;
        } else {
            width += 6.5;
        }
    }
    return Math.ceil(width);
};

// 构建标准 Shields.io 扁平矢量 SVG Data URL（离线即用，免网络请求）
window.modHubBuildShieldsSvgDataUrl = function(label, message, colorKey) {
    const rawLabel = String(label || '').trim();
    const rawMsg = String(message || '').trim();
    const cleanColor = String(colorKey || 'blue').toLowerCase().trim();
    const colorHex = MODHUB_SHIELDS_COLORS[cleanColor] ||
        (/^[0-9a-f]{3,6}$/i.test(cleanColor) ? '#' + cleanColor : (cleanColor.startsWith('#') ? cleanColor : '#007ec6'));

    const labelW = rawLabel ? Math.max(16, window.modHubEstimateBadgeTextWidth(rawLabel) + 12) : 0;
    const msgW = Math.max(16, window.modHubEstimateBadgeTextWidth(rawMsg) + 12);
    const totalW = labelW + msgW;

    const labelX = Math.round((labelW / 2) * 10);
    const msgX = Math.round((labelW + msgW / 2) * 10);
    const labelLen = Math.max(10, Math.round((labelW - 10) * 10));
    const msgLen = Math.max(10, Math.round((msgW - 10) * 10));

    const escLabel = window.modHubEscapeHtml(rawLabel);
    const escMsg = window.modHubEscapeHtml(rawMsg);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escLabel ? escLabel + ': ' : ''}${escMsg}">` +
        `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
        `<clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>` +
        `<g clip-path="url(#r)">` +
            (labelW > 0 ? `<rect width="${labelW}" height="20" fill="#555"/>` : '') +
            `<rect x="${labelW}" width="${msgW}" height="20" fill="${colorHex}"/>` +
            `<rect width="${totalW}" height="20" fill="url(#s)"/>` +
        `</g>` +
        `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
            (labelW > 0 ? `<text aria-hidden="true" x="${labelX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelLen}">${escLabel}</text>` +
            `<text x="${labelX}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelLen}">${escLabel}</text>` : '') +
            `<text aria-hidden="true" x="${msgX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${msgLen}">${escMsg}</text>` +
            `<text x="${msgX}" y="140" transform="scale(.1)" fill="#fff" textLength="${msgLen}">${escMsg}</text>` +
        `</g>` +
    `</svg>`;

    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

// 解析 Shields.io 静态 Badge 链接并生成本地 SVG Data URL
window.modHubGenerateShieldsSvg = function(url, fallbackAlt) {
    if (typeof url !== 'string' || !url.includes('img.shields.io/badge/')) return null;

    try {
        const cleanUrl = url.split('?')[0];
        const match = cleanUrl.match(/img\.shields\.io\/badge\/([^/?#]+)/i);
        if (!match) return null;

        let badgeStr = match[1];
        // 遵循 shields.io 转义规则：-- 代表 -, __ 代表 _
        badgeStr = badgeStr.replace(/--/g, '\u0001').replace(/__/g, '\u0002');
        const parts = badgeStr.split('-');
        if (parts.length < 2) return null;

        const color = parts.pop().replace(/\u0001/g, '-').replace(/\u0002/g, '_');
        const message = parts.pop().replace(/\u0001/g, '-').replace(/\u0002/g, '_').replace(/_/g, ' ');
        const label = parts.join('-').replace(/\u0001/g, '-').replace(/\u0002/g, '_').replace(/_/g, ' ');

        return window.modHubBuildShieldsSvgDataUrl(
            decodeURIComponent(label || fallbackAlt || ''),
            decodeURIComponent(message || ''),
            decodeURIComponent(color || 'blue')
        );
    } catch (_) {
        return null;
    }
};

// 动态徽章（如 github release/stars/issues）网络加载失败时的降级离线 SVG
window.modHubGenerateFallbackBadgeSvg = function(label, originalUrl) {
    let tag = label || 'badge';
    let status = 'latest';
    let color = 'blue';

    try {
        const urlObj = new URL(originalUrl, 'https://img.shields.io');
        const labelParam = urlObj.searchParams.get('label');
        if (labelParam) tag = labelParam;
        if (urlObj.pathname.includes('/downloads/')) {
            tag = tag || 'downloads';
            status = 'offline';
            color = 'lightgrey';
        } else if (urlObj.pathname.includes('/stars/')) {
            tag = tag || 'stars';
            status = 'star';
            color = 'orange';
        } else if (urlObj.pathname.includes('/issues')) {
            tag = tag || 'issues';
            status = 'open';
            color = 'green';
        } else if (urlObj.pathname.includes('/release/')) {
            tag = tag || 'release';
            status = 'latest';
            color = 'blue';
        }
    } catch (_) {}

    return window.modHubBuildShieldsSvgDataUrl(tag, status, color);
};

// 增强 Markdown 解析器（用于 ReadMe 渲染）
window.modHubRenderMarkdown = function(md, options = {}) {
    if (!md) return '';

    const placeholders = [];
    const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    const resolveRemoteUrl = (value, baseUrl) => {
        const raw = String(value || '').trim();
        if (!raw || !baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
        try {
            return new URL(raw, baseUrl).toString();
        } catch (_) {
            return raw;
        }
    };
    const renderImage = (source, alt, extraAttrs = '') => {
        const originalSrc = resolveRemoteUrl(source, options.remoteImageBaseUrl);
        if (!originalSrc || /^javascript:/i.test(originalSrc)) return '';

        let renderedSrc = originalSrc;
        let isBadge = false;
        if (originalSrc.includes('img.shields.io/badge/')) {
            const svg = window.modHubGenerateShieldsSvg(originalSrc, alt);
            if (svg) {
                renderedSrc = svg;
                isBadge = true;
            }
        } else if (originalSrc.includes('img.shields.io/')) {
            isBadge = true;
        }

        const proxyUrl = /^https?:\/\//i.test(originalSrc)
            ? window.modHubMarket?.getReadmeImageProxyUrl?.(options.repositoryUrl, originalSrc) || ''
            : '';
        const isDataUrl = renderedSrc.startsWith('data:');
        const isLocal = !proxyUrl && !/^https?:\/\//i.test(renderedSrc) && !isDataUrl;
        const localAttr = isLocal ? ` data-local-mod-path="${window.modHubEscapeHtml(originalSrc)}"` : '';
        const remoteUrl = proxyUrl || (/^https?:\/\//i.test(originalSrc) ? originalSrc : '');
        const remoteAttr = !isDataUrl && remoteUrl ? ` data-remote-image-url="${window.modHubEscapeHtml(remoteUrl)}"` : '';
        const fallbackAttr = isBadge ? ' data-fallback="badge"' : (isLocal ? '' : ' data-fallback="image"');
        const imgClass = isBadge ? 'modhub-readme-image modhub-readme-badge' : 'modhub-readme-image';
        const initialSrc = isDataUrl ? renderedSrc : emptyImage;

        return `<img class="${imgClass}" src="${window.modHubEscapeHtml(initialSrc)}" alt="${window.modHubEscapeHtml(alt)}" loading="lazy"${fallbackAttr}${localAttr}${remoteAttr} data-original-src="${window.modHubEscapeHtml(originalSrc)}"${extraAttrs}>`;
    };
    let text = String(md);

    // 1. 保护多行代码块
    text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
        const idx = placeholders.length;
        placeholders.push(`<pre class="modhub-code-block"><code>${window.modHubEscapeHtml(code)}</code></pre>`);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 2. 保护单行行内代码
    text = text.replace(/`([^`\n]+)`/g, (match, inline) => {
        const idx = placeholders.length;
        placeholders.push(`<code class="modhub-inline-code">${window.modHubEscapeHtml(inline)}</code>`);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 3. 安全放行合法 HTML <img> 标签（如头像或说明配图）
    text = text.replace(/<img\s+([^>]+)>/gi, (match, attrs) => {
        const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
        if (!srcMatch) return '';
        const src = srcMatch[1].trim();

        const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
        const alt = altMatch ? altMatch[1] : '';
        const widthMatch = attrs.match(/width=["']?(\d+[%a-z]*)["']?/i);
        const heightMatch = attrs.match(/height=["']?(\d+[%a-z]*)["']?/i);

        const widthAttr = widthMatch ? ` width="${window.modHubEscapeHtml(widthMatch[1])}"` : '';
        const heightAttr = heightMatch ? ` height="${window.modHubEscapeHtml(heightMatch[1])}"` : '';
        const tag = renderImage(src, alt, `${widthAttr}${heightAttr}`);
        if (!tag) return '';
        const idx = placeholders.length;
        placeholders.push(tag);
        return `%%DOL_HOLDER_${idx}%%`;
    });

    // 远程 README 属于不可信输入，只保留上面已净化的图片标签。
    if (options.escapeRawHtml) {
        text = text.replace(/<[^>]*>/g, tag => window.modHubEscapeHtml(tag));
    }

    // 4. 复合超链接图片解析：[![alt](imgUrl)](linkUrl)
    text = text.replace(/\[\s*!\[([^\]]*)\]\(([^)]+)\)\s*\]\(([^)]+)\)/g, (match, alt, imgUrl, linkUrl) => {
        const cleanImgUrl = imgUrl.trim();
        const cleanLinkUrl = resolveRemoteUrl(linkUrl, options.remoteLinkBaseUrl);
        const isSafeLink = /^(?:https?:\/\/|mailto:|#|\.\/|\/)/i.test(cleanLinkUrl) && !/^javascript:/i.test(cleanLinkUrl);
        const image = renderImage(cleanImgUrl, alt);
        if (!image) return '';

        return `<a class="modhub-readme-link modhub-readme-badge-link" href="${window.modHubEscapeHtml(isSafeLink ? cleanLinkUrl : '#')}" target="_blank" rel="noopener noreferrer">${image}</a>`;
    });

    // 5. 独立图片解析：![alt](imgUrl)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imgUrl) => {
        return renderImage(imgUrl.trim(), alt);
    });

    // 6. 独立超链接解析：[text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, linkUrl) => {
        const cleanLink = resolveRemoteUrl(linkUrl, options.remoteLinkBaseUrl);
        const isSafe = /^(?:https?:\/\/|mailto:|#|\.\/|\/)/i.test(cleanLink) && !/^javascript:/i.test(cleanLink);
        if (!isSafe) {
            return window.modHubEscapeHtml(label);
        }
        return `<a class="modhub-readme-link" href="${window.modHubEscapeHtml(cleanLink)}" target="_blank" rel="noopener noreferrer">${window.modHubEscapeHtml(label)}</a>`;
    });

    // 7. 聚合连续的徽章超链接（横向流式排列，避免被换行规则垂直切断）
    text = text.replace(/(?:<a class="modhub-readme-link modhub-readme-badge-link"[\s\S]*?<\/a>\s*){2,}/g, match => {
        const compacted = match.replace(/\r?\n\s*/g, ' ');
        return `<div class="modhub-readme-badge-row">${compacted}</div>\n`;
    });

    // 8. 标题解析
    text = text.replace(/^### (.*$)/gim, '<h4 class="modhub-h4 gold">$1</h4>');
    text = text.replace(/^## (.*$)/gim, '<h3 class="modhub-h3 gold">$1</h3>');
    text = text.replace(/^# (.*$)/gim, '<h2 class="modhub-h2 gold">$1</h2>');

    // 9. 水平分隔线
    text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gim, '<hr class="modhub-readme-rule">');

    // 10. 粗体与斜体
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 11. 无序列表
    text = text.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="modhub-li">$1</li>');
    text = text.replace(/(<li class="modhub-li">[\s\S]*?<\/li>)(?=(?:(?!<li class="modhub-li">)[\s\S])*?(?:<h|<div class="modhub-|<p|<pre|$))/g, '<ul class="modhub-ul">$1</ul>');

    // 12. 换行与段落
    text = text.replace(/\n\n+/g, '<br><br>');
    text = text.replace(/\n/g, '<br>');

    // 消除块级元素闭合后紧贴的多余 <br>
    text = text.replace(/(<\/(?:div|h2|h3|h4|ul|pre)>)<br\s*\/?>/gi, '$1');
    text = text.replace(/<hr class="modhub-readme-rule"><br\s*\/?>/gi, '<hr class="modhub-readme-rule">');

    // 13. 还原代码块与受保护占位符
    text = text.replace(/%%DOL_HOLDER_(\d+)%%/g, (match, idx) => {
        return placeholders[Number(idx)] || '';
    });

    return text;
};

/* =========================================================================
 * 4. Mod ReadMe 文档浏览器 (ReadMe Viewer)
 * ========================================================================= */
// 直接读取声明的本地说明，避免旧 GUI 把可选文件缺失打印为整份模组错误。
function modHubGetReadmeZip(modName) {
    const mod = window.modHubGetModInfo(modName);
    const localZip = typeof mod?.getZipFile === 'function' ? mod.getZipFile() : mod?.zip;
    if (localZip) return localZip;
    const utils = window.modHubGetGui()?.gModUtils;
    const cache = utils?.getModLoader?.()?.getModCacheArray?.()
        || window.modSC2DataManager?.getModLoader?.()?.getModCacheArray?.() || [];
    const key = String(modName).trim().toLowerCase();
    const cached = Array.from(cache).reverse().find(item =>
        String(item?.mod?.bootJson?.name || item?.mod?.name || '').trim().toLowerCase() === key);
    const reader = cached?.zip || utils?.getModZip?.(modName);
    const readerMod = typeof reader?.getModInfo === 'function' ? reader.getModInfo() : reader?.modInfo;
    if (readerMod && String(readerMod.bootJson?.name || readerMod.name || '').trim().toLowerCase() !== key) return null;
    // ModLoader 的 zip getter 会在包体释放后报错；getZipFile 可安全返回空值。
    return typeof reader?.getZipFile === 'function' ? reader.getZipFile() : reader?.zip;
}

window.modHubReadLocalReadme = async function(modName) {
    const mod = window.modHubGetModInfo(modName);
    const files = mod?.bootJson?.additionFile;
    if (!Array.isArray(files)) return null;
    const readmePath = files.find(path => typeof path === 'string' && /(?:^|\/)readme/i.test(path));
    if (!readmePath) return null;
    const zip = modHubGetReadmeZip(modName);
    if (typeof zip?.file === 'function') {
        const file = zip.file(readmePath);
        return file && !file.dir && typeof file.async === 'function' ? file.async('string') : null;
    }
    return null;
};

window.initModReadMe = async function() {
    const container = document.getElementById('modHubReadmeContainer');
    if (!container) return;
    const requestId = ++modHubReadmeRequestId;
    container.innerHTML = window.modHubLoadingHtml('正在读取模组说明列表，请稍候。');

    const gui = window.modHubGetGui();
    if (!gui) {
        container.innerHTML = '<div class="mod-empty grey">无法获取 ModLoader 实例。</div>';
        return;
    }

    const loadedMods = window.modHubUniqueModNames(gui.gModUtils ? (gui.gModUtils.getModListNameNoAlias() || []) : []);
    let sideMods = [];
    try {
        if (typeof gui.listSideLoadModNameOnly === 'function') {
            sideMods = await gui.listSideLoadModNameOnly();
        }
    } catch (_) {}
    if (requestId !== modHubReadmeRequestId || document.getElementById('modHubReadmeContainer') !== container) return;
    const allMods = window.modHubUniqueModNames([...loadedMods, ...sideMods]);
    window._modHubReadmeMods = allMods;
    if (!window._modHubSelectedMod || !allMods.includes(window._modHubSelectedMod)) {
        window._modHubSelectedMod = allMods[0] || null;
    }

    container.innerHTML = `
        <div class="modhub-group-header" style="margin-top: 0; margin-bottom: 10px;">
            <span class="gold">模组说明文档 (ReadMe)</span>
            <button type="button" class="macro-button modhub-btn-primary" onclick="window.modHubSwitchTab('模组管理')">返回模组管理</button>
        </div>
        <div class="modhub-readme-layout">
            <div class="modhub-readme-sidebar">
                <input type="text" id="modHubReadmeSearch" class="modhub-search-input" placeholder="搜索模组..." />
                <ul id="modHubReadmeModList" class="modhub-readme-list"></ul>
            </div>
            <div class="modhub-readme-content">
                <div id="modHubReadmeBody" class="modhub-readme-body">
                    <div class="mod-empty grey">请从左侧选择要查看说明的模组</div>
                </div>
            </div>
        </div>
    `;

    const searchInput = document.getElementById('modHubReadmeSearch');
    if (searchInput) {
        searchInput.oninput = () => {
            window.modHubFilterReadmeList(searchInput.value.trim());
        };
    }
    const listEl = document.getElementById('modHubReadmeModList');
    if (listEl) {
        listEl.onclick = event => {
            const item = event.target?.closest?.('[data-mod-name]');
            if (item?.dataset.modName) window.modHubSelectReadmeMod(item.dataset.modName);
        };
    }

    window.modHubFilterReadmeList('');
    if (window._modHubSelectedMod) {
        window.modHubLoadReadme(window._modHubSelectedMod);
    }
};

window.modHubFilterReadmeList = function(keyword) {
    const listEl = document.getElementById('modHubReadmeModList');
    if (!listEl || !window._modHubReadmeMods) return;

    const filtered = window._modHubReadmeMods.filter(name => {
        if (!keyword) return true;
        return name.toLowerCase().includes(keyword.toLowerCase());
    });

    if (filtered.length === 0) {
        listEl.innerHTML = '<li class="mod-empty grey">无匹配模组</li>';
        return;
    }

    listEl.innerHTML = filtered.map(name => {
        const isSelected = name === window._modHubSelectedMod;
        return `
            <li class="modhub-readme-mod-item ${isSelected ? 'active gold' : ''}" data-mod-name="${window.modHubEscapeHtml(name)}">
                <span class="mod-name" title="${window.modHubEscapeHtml(name)}">${window.modHubEscapeHtml(name)}</span>
            </li>
        `;
    }).join('');
};

window.modHubSelectReadmeMod = function(modName) {
    window._modHubSelectedMod = modName;
    const searchInput = document.getElementById('modHubReadmeSearch');
    window.modHubFilterReadmeList(searchInput ? searchInput.value.trim() : '');
    window.modHubLoadReadme(modName);
};

// 辅助：根据文件后缀获取合法图片 MIME 类型
window.modHubGetMimeTypeByExt = function(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'svg': return 'image/svg+xml';
        case 'bmp': return 'image/bmp';
        case 'ico': return 'image/x-icon';
        default: return 'image/png';
    }
};

// 辅助：在模组 Zip 中智能多级查找图片 entry（支持 URI 解码、大小写容错、纯文件名容错与常见子目录）
window.modHubFindZipImageEntry = function(zip, rawPath) {
    if (!zip || !rawPath) return null;
    let decoded = '';
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (_) {
        decoded = rawPath;
    }
    const cleanPath = decoded.replace(/^\.?\//, '').trim();
    if (!cleanPath) return null;

    // 1. 精确路径匹配
    if (typeof zip.file === 'function') {
        const directEntry = zip.file(cleanPath);
        if (directEntry) return { entry: directEntry, path: cleanPath };
    }

    if (!zip.files) return null;

    const lowerClean = cleanPath.toLowerCase();
    const fileNameOnly = lowerClean.split('/').pop();

    // 2. 大小写不敏感全路径匹配
    for (const relPath in zip.files) {
        if (!zip.files[relPath].dir && relPath.toLowerCase() === lowerClean) {
            return { entry: zip.files[relPath], path: relPath };
        }
    }

    // 3. 常见资源子目录补全匹配
    const commonPrefixes = ['img/', 'guide/', 'images/', 'photo/', 'assets/'];
    for (const prefix of commonPrefixes) {
        const candidate = prefix + lowerClean;
        for (const relPath in zip.files) {
            if (!zip.files[relPath].dir && relPath.toLowerCase() === candidate) {
                return { entry: zip.files[relPath], path: relPath };
            }
        }
    }

    // 4. 纯文件名跨目录匹配
    for (const relPath in zip.files) {
        if (!zip.files[relPath].dir) {
            const fileLower = relPath.toLowerCase();
            if (fileLower === fileNameOnly || fileLower.endsWith('/' + fileNameOnly)) {
                return { entry: zip.files[relPath], path: relPath };
            }
        }
    }

    return null;
};

// 为 ReadMe 视图中的图片设置本地 Zip 资源解析与加载失败容灾兜底
window.modHubSetupReadmeImages = async function(container, modName, isCurrent = () => true) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    const replaceWithFallback = img => {
        if (!img || img.dataset.hasFailed) return;
        img.dataset.hasFailed = 'true';

        const fallbackType = img.dataset.fallback;
        const alt = img.alt || '';
        const origSrc = img.dataset.originalSrc || img.src;
        if (fallbackType === 'badge' || img.classList.contains('modhub-readme-badge')) {
            img.src = window.modHubGenerateFallbackBadgeSvg(alt, origSrc);
            img.classList.add('modhub-badge-fallback');
            return;
        }

        const placeholder = document.createElement('span');
        placeholder.className = 'modhub-image-fallback';
        placeholder.innerHTML = `
            <span class="fallback-icon">[图片]</span>
            <span class="fallback-content">
                <strong class="fallback-title">${window.modHubEscapeHtml(alt || '网络图片未能加载')}</strong>
                <span class="fallback-tip grey">（可能受限于当前网络环境）</span>
                ${origSrc && /^https?:\/\//i.test(origSrc) ? `
                    <a class="fallback-link gold" href="${window.modHubEscapeHtml(origSrc)}" target="_blank" rel="noopener noreferrer">在新窗口中打开原图</a>
                ` : ''}
            </span>
        `;
        img.replaceWith(placeholder);
    };

    // 捕获阶段可覆盖浏览器 CSP 与普通网络错误。
    if (!container._modHubReadmeImageErrorHandler) {
        container._modHubReadmeImageErrorHandler = event => {
            const img = event.target;
            if (img?.tagName === 'IMG') replaceWithFallback(img);
        };
        container.addEventListener('error', container._modHubReadmeImageErrorHandler, true);
    }

    const zip = modHubGetReadmeZip(modName);

    // 1. 解析模组内置相对路径图片（转为合规 data: Base64 URL 彻底消除 CSP 与 404 限制）
    const localImgs = container.querySelectorAll('img[data-local-mod-path]');
    const remoteImgs = container.querySelectorAll('img[data-remote-image-url]');
    if (localImgs && localImgs.length > 0) {
        try {
            for (const img of localImgs) {
                if (!isCurrent()) return;
                const rawPath = img.getAttribute('data-local-mod-path');
                if (!rawPath) continue;

                const found = window.modHubFindZipImageEntry(zip, rawPath);
                if (found && found.entry && typeof found.entry.async === 'function') {
                    try {
                        let dataUrl = '';
                        const mime = window.modHubGetMimeTypeByExt(found.path || rawPath);
                        try {
                            const base64 = await found.entry.async('base64');
                            if (base64) dataUrl = `data:${mime};base64,${base64}`;
                        } catch (_) {}

                        if (!dataUrl) {
                            const blob = await found.entry.async('blob');
                            if (blob && typeof FileReader !== 'undefined') {
                                dataUrl = await new Promise((resolve, reject) => {
                                    const reader = new FileReader();
                                    reader.onload = () => resolve(reader.result);
                                    reader.onerror = () => reject(reader.error || new Error('图片转码失败'));
                                    reader.readAsDataURL(blob);
                                });
                            }
                        }

                        if (!isCurrent()) return;
                        if (dataUrl) {
                            img.src = dataUrl;
                            img.removeAttribute('data-local-mod-path');
                        } else {
                            replaceWithFallback(img);
                        }
                    } catch (err) {
                        if (!isCurrent()) return;
                        console.warn('[ModHub] 解码模组内置图片失败:', rawPath, err);
                        replaceWithFallback(img);
                    }
                } else {
                    replaceWithFallback(img);
                }
            }
        } catch (err) {
            console.warn('[ModHub] 提取模组内置资源时异常:', err);
        }
    }

    // 2. 远程图片：优先尝试本地 Zip 容灾匹配，次选 Worker 代理转 data: URL，最后优雅降级
    for (const img of remoteImgs) {
        if (!isCurrent()) return;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timeoutId;
        try {
            const originalSrc = img.dataset.originalSrc || '';
            // 2.1 检查本地 Zip 是否自带同名资源（秒开且免疫外网断联）
            if (zip && originalSrc) {
                const localMatch = window.modHubFindZipImageEntry(zip, originalSrc);
                if (localMatch && localMatch.entry && typeof localMatch.entry.async === 'function') {
                    try {
                        const mime = window.modHubGetMimeTypeByExt(localMatch.path || originalSrc);
                        const base64 = await localMatch.entry.async('base64');
                        if (!isCurrent()) return;
                        if (base64) {
                            img.src = `data:${mime};base64,${base64}`;
                            img.removeAttribute('data-remote-image-url');
                            continue;
                        }
                    } catch (_) {}
                }
            }

            // 2.2 请求 Worker 代理接口或远程原图并转为 CSP 允许的 data: URL
            if (!isCurrent()) return;
            const remoteUrl = img.getAttribute('data-remote-image-url');
            if (!remoteUrl) throw new Error('缺少远程图片加载地址');
            const dataUrl = await Promise.race([
                (async () => {
                    const response = await fetch(remoteUrl, controller ? { signal: controller.signal } : undefined);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    return new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
                        reader.readAsDataURL(blob);
                    });
                })(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(new Error('说明图片读取超时'));
                        controller?.abort();
                    }, 8000);
                })
            ]);
            if (!isCurrent()) return;
            img.src = dataUrl;
            img.removeAttribute('data-remote-image-url');
        } catch (err) {
            if (!isCurrent()) return;
            console.warn('[ModHub] README 网络图片代理失败:', img.dataset.originalSrc, err);
            replaceWithFallback(img);
        } finally {
            clearTimeout(timeoutId);
        }
    }
};

window.modHubLoadReadme = async function(modName) {
    const bodyEl = document.getElementById('modHubReadmeBody');
    if (!bodyEl) return;

    const requestId = ++modHubReadmeRequestId;
    const isCurrent = () => requestId === modHubReadmeRequestId && document.getElementById('modHubReadmeBody') === bodyEl;
    bodyEl.innerHTML = window.modHubLoadingHtml('正在读取文档...');

    try {
        let readme = null;
        let readmeUnavailable = false;
        try {
            readme = await window.modHubReadLocalReadme(modName);
        } catch (error) {
            readmeUnavailable = true;
            console.warn('[ModHub] 本地说明读取失败，尝试在线说明:', modName, error);
        }
        if (!isCurrent()) return;

        const modInfo = window.modHubGetModInfo(modName);
        const boot = modInfo?.bootJson || {};
        let marketInfo = window.modHubMarket?.findMarketModByLocalName?.(modName) || null;
        if (!marketInfo && window.modHubMarket?.loadMarketData) {
            try {
                const marketMods = await window.modHubMarket.loadMarketData();
                marketInfo = window.modHubMarket.findMarketModByLocalName?.(modName, marketMods) || null;
            } catch (_) {}
        }
        const author = boot.author || marketInfo?.author;
        const description = marketInfo?.description && marketInfo.description !== '暂无说明'
            ? marketInfo.description
            : '';
        const bootRepository = typeof boot.repository === 'string' ? boot.repository : boot.repository?.url;
        const repositoryUrl = [bootRepository, marketInfo?.githubUrl]
            .find(url => /^https?:\/\/github\.com\//i.test(url || '')) || '';
        const category = marketInfo?.primaryCategory || marketInfo?.category || '';
        const hasLocalReadme = window.modHubHasReadmeContent(readme);
        let githubReadme = null;
        if (!isCurrent()) return;
        if (!hasLocalReadme && repositoryUrl && window.modHubMarket?.fetchGithubReadme) {
            try {
                githubReadme = await window.modHubMarket.fetchGithubReadme(repositoryUrl);
            } catch (err) {
                readmeUnavailable = true;
                console.warn('[ModHub] GitHub README 获取失败:', err);
            }
        }
        if (!isCurrent()) return;
        const effectiveReadme = hasLocalReadme ? readme : githubReadme?.markdown;

        let marketHtml = '';
        if (description || repositoryUrl || category) {
            marketHtml = `
                <div class="childItem modhub-readme-market-summary">
                    <div class="modhub-readme-market-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <strong class="gold">模组市场资料</strong>
                        ${category ? `<span class="dep-tag gold">[${window.modHubEscapeHtml(category)}]</span>` : ''}
                    </div>
                    ${description ? `<p style="margin: 4px 0 8px 0; line-height: 1.5;">${window.modHubEscapeHtml(description)}</p>` : ''}
                    ${repositoryUrl ? `<a class="macro-button modhub-btn-primary modhub-readme-repo" href="${window.modHubEscapeHtml(repositoryUrl)}" target="_blank" rel="noopener noreferrer">访问模组仓库</a>` : ''}
                </div>
            `;
        }

        let contentHtml = `
            <div class="modhub-readme-header">
                <h3 class="gold" style="margin: 0 0 6px 0;">${window.modHubEscapeHtml(modName)}</h3>
                <div class="modhub-readme-meta grey">
                    <span>版本: <strong class="def">${window.modHubEscapeHtml(boot.version || '未知')}</strong></span>
                    ${author ? `<span>作者: <strong class="def">${window.modHubEscapeHtml(author)}</strong></span>` : ''}
                </div>
            </div>
            ${marketHtml}
        `;

        if (window.modHubHasReadmeContent(effectiveReadme)) {
            if (githubReadme) {
                contentHtml += `<p class="grey modhub-readme-source">以下说明来自 <a class="modhub-readme-link" href="${window.modHubEscapeHtml(githubReadme.sourceUrl || repositoryUrl)}" target="_blank" rel="noopener noreferrer">GitHub 仓库 README</a>。</p>`;
                if (githubReadme.isStale) contentHtml += '<p class="grey">网络暂不可用，显示上次成功读取的说明，内容可能不是最新版本。</p>';
            }
            contentHtml += `<div class="modhub-markdown-view">${window.modHubRenderMarkdown(effectiveReadme, {
                modName,
                repositoryUrl,
                remoteImageBaseUrl: githubReadme?.downloadUrl || '',
                remoteLinkBaseUrl: githubReadme?.sourceUrl || '',
                escapeRawHtml: Boolean(githubReadme)
            })}</div>`;
            if ((boot.dependenceInfo && boot.dependenceInfo.length) || (boot.addonPlugin && boot.addonPlugin.length)) {
                contentHtml += `
                    <div class="modhub-meta-view" style="margin-top: 20px; border-top: 1px solid var(--750); padding-top: 12px;">
                        <h4 class="gold" style="margin: 0 0 10px 0;">模组技术信息</h4>
                        <div class="modhub-meta-grid">
                            ${boot.dependenceInfo && boot.dependenceInfo.length ? `
                                <div class="childItem meta-item full-width">
                                    <span class="grey meta-key">依赖项</span>
                                    <span class="meta-val">
                                        ${boot.dependenceInfo.map(d => `<span class="dep-tag grey">[依赖] ${window.modHubEscapeHtml(d.modName)} (${window.modHubEscapeHtml(d.version)})</span>`).join(' ')}
                                    </span>
                                </div>
                            ` : ''}
                            ${boot.addonPlugin && boot.addonPlugin.length ? `
                                <div class="childItem meta-item full-width">
                                    <span class="grey meta-key">插件扩展 (AddonPlugin)</span>
                                    <span class="meta-val">
                                        ${boot.addonPlugin.map(a => `<span class="dep-tag grey">[扩展] ${window.modHubEscapeHtml(a.modName)} / ${window.modHubEscapeHtml(a.addonName)}</span>`).join(' ')}
                                    </span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }
        } else {
            contentHtml += `
                <div class="modhub-meta-view">
                    <p class="modhub-readme-empty">${readmeUnavailable ? '说明文档暂时无法读取，请检查网络后重新选择此模组重试。' : '此模组没有说明文档。'}</p>
                    ${!marketHtml ? '<p class="grey">当前仅能显示模组自身的 boot.json 信息。</p>' : ''}
                    <div class="modhub-meta-grid">
                        <div class="childItem meta-item">
                            <span class="grey meta-key">模组名称</span>
                            <span class="meta-val def">${window.modHubEscapeHtml(boot.name || modName)}</span>
                        </div>
                        <div class="childItem meta-item">
                            <span class="grey meta-key">版本号</span>
                            <span class="meta-val def">${window.modHubEscapeHtml(boot.version || '未知')}</span>
                        </div>
                        ${boot.dependenceInfo && boot.dependenceInfo.length ? `
                            <div class="childItem meta-item full-width">
                                <span class="grey meta-key">依赖项</span>
                                <span class="meta-val">
                                    ${boot.dependenceInfo.map(d => `<span class="dep-tag grey">[依赖] ${window.modHubEscapeHtml(d.modName)} (${window.modHubEscapeHtml(d.version)})</span>`).join(' ')}
                                </span>
                            </div>
                        ` : ''}
                        ${boot.addonPlugin && boot.addonPlugin.length ? `
                            <div class="childItem meta-item full-width">
                                <span class="grey meta-key">插件扩展 (AddonPlugin)</span>
                                <span class="meta-val">
                                    ${boot.addonPlugin.map(a => `<span class="dep-tag grey">[扩展] ${window.modHubEscapeHtml(a.modName)} / ${window.modHubEscapeHtml(a.addonName)}</span>`).join(' ')}
                                </span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        bodyEl.innerHTML = contentHtml;
        await window.modHubSetupReadmeImages(bodyEl, modName, isCurrent);
    } catch (e) {
        if (!isCurrent()) return;
        console.error('[ModHub] 读取 ReadMe 失败', e);
        bodyEl.innerHTML = `<div class="mod-empty red">读取文档失败：${window.modHubEscapeHtml(e.message)}</div>`;
    }
};
