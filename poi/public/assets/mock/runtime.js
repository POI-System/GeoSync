export const DEMO_ROUTES = Object.freeze({
    before: {
        geometry: { type: 'LineString', coordinates: [[114.3518, 30.5374], [114.3558, 30.5404], [114.3596, 30.5421], [114.3648, 30.5441]] },
        distanceM: 952,
        durationSec: 784,
        gis: { source: 'iserver', mode: 'shade', degraded: false, durationMs: 148, dataVersion: 'demo-v1' },
        verifiedAccessible: null
    },
    after: {
        geometry: { type: 'LineString', coordinates: [[114.3518, 30.5374], [114.3558, 30.5404], [114.3615, 30.5394], [114.3648, 30.5441]] },
        distanceM: 1078,
        durationSec: 724,
        reason: '临时封路绕行',
        gis: { source: 'iserver', mode: 'shade', degraded: false, durationMs: 166, dataVersion: 'demo-v1' },
        verifiedAccessible: null
    }
});

export const DEMO_PROPOSAL_TEMPLATE = Object.freeze({
    itineraryId: 'demo_itinerary',
    proposalId: 'demo_proposal',
    type: 'barrierReroute',
    reason: '老图书馆东侧道路临时关闭，建议绕行林荫路',
    gainMin: 11,
    distanceDeltaM: 126,
    durationDeltaSec: -60,
    diff: { before: ['poi_photo', 'poi_history', 'poi_lake'], after: ['poi_photo', 'poi_lake'] }
});

export const DEMO_CLOSED_EDGE = Object.freeze({
    eventId: 'demo_barrier',
    edgeId: 'edge_library_east',
    status: 'closed',
    reason: '道路临时关闭',
    geometry: { type: 'LineString', coordinates: [[114.3582, 30.5414], [114.3608, 30.5427]] }
});
