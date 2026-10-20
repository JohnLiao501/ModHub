/** ModHub - 显式发行分支、包型与附加资源目录。 */
(function () {
    'use strict';

    const text = (value, limit) => typeof value === 'string' && value.trim().length <= limit
        && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
    const groupId = value => {
        const id = text(value, 128);
        return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id.toLowerCase() : '';
    };

    function normalizeVariant(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !['language', 'edition'].includes(value.type)) return null;
        const group = groupId(value.groupId), groupName = text(value.groupName, 200);
        const id = text(value.id, 48), label = text(value.label, 80);
        const validId = value.type === 'language' ? /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i : /^[a-z0-9][a-z0-9._-]*$/i;
        if (!group || !groupName || !label || !validId.test(id)) return null;
        return { groupId: group, groupName, type: value.type, id, label };
    }

    function normalizePackageLanguages(value) {
        if (!Array.isArray(value)) return [];
        const result = [];
        for (const item of value) {
            const locale = text(item, 48);
            if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) continue;
            try {
                const normalized = Intl.getCanonicalLocales(locale)[0];
                if (normalized && !result.includes(normalized)) result.push(normalized);
            } catch (_) {}
        }
        return result;
    }

    const assetUrl = value => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password
                && /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) && !url.search && !url.hash ? url.href : '';
        } catch (_) { return ''; }
    };
    function normalizePackageEditions(value) {
        if (!Array.isArray(value)) return [];
        const ids = new Set();
        const result = [];
        for (const item of value) {
            const id = groupId(item?.id), label = text(item?.label, 80), bootName = text(item?.bootName, 200), assetSeries = text(item?.assetSeries, 200);
            if (!id || ids.has(id) || !label || !bootName || !assetSeries || typeof item.exclusive !== 'boolean') return [];
            const bootEdition = item.bootEdition === undefined ? '' : text(item.bootEdition, 80);
            if (item.bootEdition !== undefined && !bootEdition) return [];
            const verifiedAssets = (Array.isArray(item.verifiedAssets) ? item.verifiedAssets : []).flatMap(record => {
                const sourceUrl = assetUrl(record?.sourceUrl), sha256 = text(record?.sha256, 64).toLowerCase(), version = text(record?.version, 200);
                return sourceUrl && /^[a-f0-9]{64}$/.test(sha256) ? [{ sourceUrl, sha256, ...(version ? { version } : {}) }] : [];
            });
            ids.add(id);
            result.push({ id, label, bootName, assetSeries, exclusive: item.exclusive, ...(bootEdition ? { bootEdition } : {}),
                ...(verifiedAssets.length ? { verifiedAssets } : {}) });
        }
        return result;
    }
    function normalizeOptionalResources(value) {
        if (!Array.isArray(value)) return [];
        const names = new Set();
        return value.flatMap(item => {
            const bootName = text(item?.bootName, 200), label = text(item?.label, 80), assetSeries = text(item?.assetSeries, 200);
            const sourceUrl = item?.sourceUrl === undefined ? '' : assetUrl(item.sourceUrl);
            if (!bootName || names.has(bootName.toLowerCase()) || !label || !assetSeries || !['audio', 'resource'].includes(item.packageRole)
                || item.sourceUrl !== undefined && !sourceUrl) return [];
            names.add(bootName.toLowerCase());
            const sha256 = text(item.sha256, 64).toLowerCase(), version = text(item.version, 200), evidenceUrl = text(item.evidenceUrl, 2000);
            return [{ bootName, label, assetSeries, packageRole: item.packageRole, ...(sourceUrl ? { sourceUrl } : {}),
                ...(version ? { version } : {}), ...(/^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}),
                ...(Number.isSafeInteger(item.size) && item.size > 0 ? { size: item.size } : {}),
                ...(evidenceUrl ? { evidenceUrl } : {}) }];
        });
    }
    function getPackageEdition(mod, profile) {
        if (!profile) return null;
        const boot = profile.bootJson || profile;
        const digest = String(profile.packageDigest || '').replace(/^sha256:/i, '').toLowerCase();
        const editions = normalizePackageEditions(mod?.packageEditions);
        const sameName = editions.filter(item => item.bootName.toLowerCase() === String(boot.name || profile.name || '').trim().toLowerCase());
        const matches = sameName.filter(item => item.verifiedAssets?.some(record => record.sha256 === digest)
            || (item.bootEdition ? item.bootEdition === boot.edition : sameName.length === 1));
        return matches.length === 1 ? matches[0] : null;
    }

    /** 作者说明中的必需前置独立于安装包的依赖声明，保留范围供安装器核验。 */
    function normalizeRequiredDependencies(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.flatMap(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const modName = text(item.modName, 200);
            if (item.version !== undefined && (typeof item.version !== 'string' || item.version.length > 200
                || /[\u0000-\u001f\u007f]/u.test(item.version))) return [];
            const version = item.version === undefined ? '*' : text(item.version, 200);
            const key = `${modName.toLowerCase()}\n${version || '*'}`;
            if (!modName || seen.has(key)) return [];
            seen.add(key);
            return [{ modName, version: version || '*' }];
        });
    }

    function groupMods(mods) {
        if (!Array.isArray(mods)) return [];
        const groups = new Map();
        for (const mod of mods) {
            const id = groupId(mod?.variant?.groupId);
            if (!id) continue;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(mod);
        }
        const valid = new Map();
        for (const [id, members] of groups) {
            const variants = members.map(mod => normalizeVariant(mod.variant));
            if (members.length < 2 || variants.some(variant => !variant)
                || new Set(variants.map(variant => variant.groupName)).size !== 1
                || new Set(variants.map(variant => variant.type)).size !== 1
                || new Set(variants.map(variant => variant.id.toLowerCase())).size !== members.length) continue;
            const identities = members.map(mod => mod.identityId === null ? '' : text(mod.identityId || mod.id, 200).toLowerCase());
            const names = members.map(mod => Array.isArray(mod.bootNames)
                ? mod.bootNames.map(name => text(name, 200).toLowerCase()).filter(Boolean) : []);
            if (identities.some(identity => !identity) || new Set(identities).size !== members.length
                || names.some(bootNames => !bootNames.length)) continue;
            const owners = new Map();
            let overlapping = false;
            names.forEach((bootNames, index) => bootNames.forEach(name => {
                if (owners.has(name) && owners.get(name) !== index) overlapping = true;
                owners.set(name, index);
            }));
            if (overlapping) continue;
            valid.set(id, { isLanguageGroup: true, variantGroupId: id, name: variants[0].groupName, variants: members,
                ...(variants[0].type === 'edition' ? { variantType: 'edition', isEditionGroup: true } : {}) });
        }
        const emitted = new Set();
        return mods.flatMap(mod => {
            const id = groupId(mod?.variant?.groupId), group = valid.get(id);
            if (!group) return [mod];
            if (emitted.has(id)) return [];
            emitted.add(id);
            return [group];
        });
    }

    function getMembers(mod) {
        return mod?.isLanguageGroup && Array.isArray(mod.variants) ? mod.variants : mod ? [mod] : [];
    }

    function getDisplayName(mod) {
        const name = text(mod?.name, 500) || '未命名模组';
        const variant = normalizeVariant(mod?.variant);
        return variant ? `${name}（${variant.label}）` : name;
    }

    function getLabelText(label, locale) {
        const source = typeof label === 'string' ? label : '';
        if (!source) return source;
        return window.modHubGetMarketCardText?.({ name: source }, 'name', locale)?.text || source;
    }

    window.modHubMarketVariants = { normalizeVariant, normalizePackageLanguages, normalizeRequiredDependencies, normalizePackageEditions,
        normalizeOptionalResources, getPackageEdition, groupMods, getMembers, getDisplayName, getLabelText };
})();
