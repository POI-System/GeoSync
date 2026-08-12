export const CROWD_LABELS = Object.freeze({
    low: '舒适',
    medium: '较忙',
    high: '拥挤',
    unknown: '准备中'
});

export function formatDistance(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return '--';
    const absolute = Math.abs(value);
    return absolute >= 1000 ? `${(absolute / 1000).toFixed(1)} 公里` : `${Math.round(absolute)} 米`;
}

export function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return '--';
    const minutes = Math.max(0, Math.round(value / 60));
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function formatCrowdLevel(level, { lowConfidence = false } = {}) {
    const label = CROWD_LABELS[level] || CROWD_LABELS.unknown;
    return lowConfidence ? `参考人流 · ${label}` : label;
}

export function formatRouteSource(source) {
    return ({
        iserver: 'iServer 路线',
        cache: '缓存结果',
        'local-fallback': '离线路线'
    })[source] || '路线来源未知';
}

export function formatRouteMode(mode) {
    return ({ normal: '普通模式', accessible: '无障碍模式', shade: '遮荫模式' })[mode] || '普通模式';
}
