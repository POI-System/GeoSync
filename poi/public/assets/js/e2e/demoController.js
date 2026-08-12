const BASE_TIME = '2026-08-07T14:10:00.000+08:00';

export const DEMO_CONFIG = Object.freeze({
    scenicId: 'east-lake-demo',
    scenicCenter: [114.3592, 30.541],
    gis: {
        enabled: false,
        source: 'demo',
        publicServices: { map: '' },
        center: [114.3592, 30.541],
        extent: [114.352, 30.536, 114.367, 30.547],
        crs: 'EPSG:4326'
    },
    features: { supermap: false }
});

export const DEMO_GRAPH = Object.freeze({
    nodes: [
        { nodeId: 'n_west', geo: { coordinates: [114.3532, 30.5401] } },
        { nodeId: 'n_cherry_w', geo: { coordinates: [114.3561, 30.541] } },
        { nodeId: 'n_cherry_e', geo: { coordinates: [114.3618, 30.5422] } },
        { nodeId: 'n_lake', geo: { coordinates: [114.3651, 30.5439] } },
        { nodeId: 'n_south', geo: { coordinates: [114.3594, 30.5375] } }
    ],
    edges: [
        { edgeId: 'edge-demo-01', name: '樱花大道西段', type: '景区主路', from: 'n_west', to: 'n_cherry_w', geometry: [[114.3532, 30.5401], [114.3561, 30.541]], distanceM: 310, walkSec: 230, stairs: false, slope: 1.2, shade: 0.82, accessible: true, status: 'open', sourceRef: { source: 'iserver', dataset: 'walk_network' } },
        { edgeId: 'edge-demo-key', name: '樱花大道关键段', type: '景区主路', from: 'n_cherry_w', to: 'n_cherry_e', geometry: [[114.3561, 30.541], [114.3587, 30.5415], [114.3618, 30.5422]], distanceM: 580, walkSec: 430, stairs: false, slope: 1.8, shade: 0.9, accessible: true, status: 'open', sourceRef: { source: 'iserver', dataset: 'walk_network' } },
        { edgeId: 'edge-demo-03', name: '湖畔连廊', type: '滨水步道', from: 'n_cherry_e', to: 'n_lake', geometry: [[114.3618, 30.5422], [114.3651, 30.5439]], distanceM: 390, walkSec: 300, stairs: false, slope: 0.7, shade: 0.45, accessible: true, status: 'open', sourceRef: { source: 'iserver', dataset: 'walk_network' } },
        { edgeId: 'edge-demo-04', name: '南侧台阶路', type: '支路', from: 'n_south', to: 'n_cherry_e', geometry: [[114.3594, 30.5375], [114.3618, 30.5422]], distanceM: 610, walkSec: 590, stairs: true, slope: 7.6, shade: 0.3, accessible: false, status: 'open', sourceRef: { source: 'iserver', dataset: 'walk_network' } }
    ]
});

export const DEMO_HEATMAP = Object.freeze({
    slot: '2026-08-07T14:10',
    lowConfidence: false,
    items: [
        { poiId: 'poi-cherry', name: '樱花大道', lnglat: [114.3592, 30.541], ci: 0.82, level: 'high', predicted: { p30: 0.88, p60: 0.72 } },
        { poiId: 'poi-lake', name: '湖心广场', lnglat: [114.3641, 30.5434], ci: 0.67, level: 'medium', predicted: { p30: 0.72, p60: 0.76 } },
        { poiId: 'poi-gate', name: '西门服务区', lnglat: [114.3538, 30.5398], ci: 0.36, level: 'low', predicted: { p30: 0.4, p60: 0.45 } },
        { poiId: 'poi-garden', name: '南园', lnglat: [114.3594, 30.5378], ci: 0.51, level: 'medium', predicted: { p30: 0.48, p60: 0.43 } }
    ]
});

export const DEMO_DASHBOARD = Object.freeze({
    activeItineraries: 18,
    todayCheckins: 46,
    avgSavedMin: 12,
    rerouteAcceptRate: 0.75,
    top10: DEMO_HEATMAP.items.map(item => ({ ...item, trend: item.predicted.p30 > item.ci ? 'up' : 'down' })),
    alerts: [{ poiId: 'poi-cherry', name: '樱花大道', level: 'high', ci: 0.82, at: BASE_TIME }]
});

export const DEMO_HEALTH = Object.freeze({
    state: 'online',
    gis: { state: 'online', source: 'iserver' },
    mongo: { state: 'online' },
    graph: { state: 'online', edges: 4 },
    jobs: { state: 'online' },
    dataVersion: 'demo-2026.08.07'
});

export function createDemoReplay() {
    const slots = ['13:40', '13:50', '14:00', '14:10', '14:20', '14:30', '14:40'];
    const frames = {};
    for (const [itemIndex, item] of DEMO_HEATMAP.items.entries()) {
        frames[item.poiId] = slots.map((_, slotIndex) => {
            if (itemIndex === 3 && slotIndex === 2) return null;
            const wave = (slotIndex - 3) * (itemIndex % 2 ? 0.025 : 0.035);
            return Math.max(0.1, Math.min(0.96, Math.round((item.ci + wave) * 100) / 100));
        });
    }
    return {
        date: '2026-08-07', slots, frames,
        pois: DEMO_HEATMAP.items.map(({ poiId, name, lnglat }) => ({ poiId, name, lnglat }))
    };
}

export class DemoController {
    constructor({ store, clock = globalThis } = {}) {
        this.store = store;
        this.clock = clock;
        this.timers = [];
        this.operationSequence = 0;
    }

    bootstrap() {
        return {
            config: DEMO_CONFIG,
            health: DEMO_HEALTH,
            dashboard: DEMO_DASHBOARD,
            heatmap: DEMO_HEATMAP,
            graph: JSON.parse(JSON.stringify(DEMO_GRAPH))
        };
    }

    closeEdge(edgeId, reason, durationMin) {
        const eventId = `demo-event-${++this.operationSequence}`;
        const acceptedAt = new Date().toISOString();
        this.store?.acceptOperation({ eventId, edgeId, status: 'closed', acceptedAt });
        this.after(700, () => this.store?.applyGraphUpdate({ eventId, edgeId, status: 'closed', reason, at: new Date().toISOString() }));
        this.after(1300, () => this.store?.applyImpact({ eventId, edgeId, affectedItineraries: 3, proposalsCreated: 2, failed: 1, completedAt: new Date().toISOString() }));
        this.after(2100, () => this.store?.applyProposalStatus({ eventId, itineraryId: 'demo-trip-01', proposalId: 'demo-proposal-01', status: 'accepted', version: 2, at: new Date().toISOString() }));
        return Promise.resolve({ eventId, edgeId, status: 'closed', acceptedAt, durationMin });
    }

    openEdge(edgeId) {
        const eventId = `demo-event-${++this.operationSequence}`;
        const acceptedAt = new Date().toISOString();
        this.store?.acceptOperation({ eventId, edgeId, status: 'open', acceptedAt });
        this.after(650, () => this.store?.applyGraphUpdate({ eventId, edgeId, status: 'open', at: new Date().toISOString() }));
        return Promise.resolve({ eventId, edgeId, status: 'open', acceptedAt });
    }

    after(ms, callback) {
        const timer = this.clock.setTimeout(callback, ms);
        this.timers.push(timer);
    }

    destroy() {
        this.timers.forEach(timer => this.clock.clearTimeout(timer));
        this.timers = [];
    }
}
