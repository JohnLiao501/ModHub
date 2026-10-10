/** ModHub - 显式语言变体目录与展示分组。 */
(function () {
    'use strict';

    const text = (value, limit) => typeof value === 'string' && value.trim().length <= limit
        && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
    const groupId = value => {
        const id = text(value, 128);
        return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id.toLowerCase() : '';
    };

    function normalizeVariant(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'language') return null;
        const group = groupId(value.groupId), groupName = text(value.groupName, 200);
        const id = text(value.id, 48), label = text(value.label, 80);
        if (!group || !groupName || !label || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(id)) return null;
        return { groupId: group, groupName, type: 'language', id, label };
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
            valid.set(id, { isLanguageGroup: true, variantGroupId: id, name: variants[0].groupName, variants: members });
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

    window.modHubMarketVariants = { normalizeVariant, normalizeRequiredDependencies, groupMods, getMembers, getDisplayName };
})();
