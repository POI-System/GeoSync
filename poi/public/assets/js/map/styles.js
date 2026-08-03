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

export const CATEGORY_STYLES = Object.freeze({
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
});

export function routePresentation(route = {}) {
    route = route || {};
    const gis = route.gis || {};
    const mode = gis.mode || 'normal';
    const source = gis.source || 'unknown';
    const isFallback = source === 'local-fallback';
    const accessibleUnverified = mode === 'accessible'
        && (isFallback || route.verifiedAccessible !== true);
    const label = source === 'cache'
        ? '缓存结果'
        : isFallback
            ? '离线路线'
            : source === 'iserver'
                ? 'iServer 路线'
                : '路线来源未知';

    return {
        color: ROUTE_COLORS[mode] || ROUTE_COLORS.normal,
        dash: isFallback ? [2, 2] : [1, 0],
        source,
        mode,
        label,
        degraded: Boolean(gis.degraded || source !== 'iserver'),
        accessibleVerified: !accessibleUnverified
    };
}

export function crowdLabel(level) {
    return ({ low: '舒适', medium: '较忙', high: '拥挤', unknown: '准备中' })[level] || '准备中';
}
