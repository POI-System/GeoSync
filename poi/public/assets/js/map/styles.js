import { formatCrowdLevel, formatRouteSource } from '../shared/formatters.js';

export const CROWD_COLORS = Object.freeze({
    low: '#34c759',
    medium: '#ffb020',
    high: '#ff453a',
    unknown: '#8e8e93'
});

export const ROUTE_COLORS = Object.freeze({
    normal: '#087f73',
    accessible: '#2774ae',
    shade: '#167c45',
    old: '#707a80',
    closed: '#b42318'
});

export const MAP_COLORS = Object.freeze({
    boundary: '#087f73',
    road: '#6b8178',
    user: '#2774ae',
    text: '#17222a',
    white: '#ffffff'
});

export const MAP_LAYER_STYLES = Object.freeze({
    boundary: Object.freeze({ fillOpacity: 0.06, lineWidth: 2, dash: [3, 2] }),
    road: Object.freeze({ width: 2.2, opacity: 0.72 }),
    route: Object.freeze({ width: 6, opacity: 0.92, solidDash: [1, 0], fallbackDash: [2, 2] }),
    routeOld: Object.freeze({ width: 6, opacity: 0.65, dash: [2, 2] }),
    routeNew: Object.freeze({ width: 5, opacity: 0.9 }),
    closedEdge: Object.freeze({ width: 5, selectedWidth: 8, dash: [1, 1] }),
    poi: Object.freeze({ minRadius: 10, maxRadius: 17, limitedOpacity: 0.5, opacity: 0.92, strokeWidth: 3 }),
    user: Object.freeze({ accuracyRadius: 18, accuracyOpacity: 0.14, pointRadius: 7, strokeWidth: 3 })
});

const categories = {
    photography: { glyph: '摄', color: '#d95d39' },
    '摄影': { glyph: '摄', color: '#d95d39' },
    history: { glyph: '文', color: '#8b5e34' },
    '人文': { glyph: '文', color: '#8b5e34' },
    nature: { glyph: '景', color: '#167c45' },
    '自然': { glyph: '景', color: '#167c45' },
    family: { glyph: '亲', color: '#a96200' },
    '亲子': { glyph: '亲', color: '#a96200' },
    '旅游景点': { glyph: '游', color: '#087f73' },
    default: { glyph: '点', color: '#5e6a72' }
};

for (const style of Object.values(categories)) Object.freeze(style);
export const CATEGORY_STYLES = Object.freeze(categories);

export function categoryStyle(category) {
    return CATEGORY_STYLES[category] || CATEGORY_STYLES.default;
}

export function categoryIconId(category) {
    const key = Object.prototype.hasOwnProperty.call(CATEGORY_STYLES, category) ? String(category) : 'default';
    if (key === 'default') return 'geosync-poi-default';
    const encoded = [...key].map(character => character.codePointAt(0).toString(16)).join('-');
    return `geosync-poi-${encoded}`;
}

export function routePresentation(route = {}) {
    route = route || {};
    const gis = route.gis || {};
    const mode = gis.mode || 'normal';
    const source = gis.source || 'unknown';
    const isFallback = source === 'local-fallback';
    const accessibleUnverified = mode === 'accessible'
        && (isFallback || route.verifiedAccessible !== true);

    return {
        color: ROUTE_COLORS[mode] || ROUTE_COLORS.normal,
        dash: isFallback ? MAP_LAYER_STYLES.route.fallbackDash : MAP_LAYER_STYLES.route.solidDash,
        source,
        mode,
        label: formatRouteSource(source),
        degraded: Boolean(gis.degraded || source !== 'iserver'),
        accessibleVerified: !accessibleUnverified
    };
}

export function crowdLabel(level, lowConfidence = false) {
    return formatCrowdLevel(level, { lowConfidence });
}
