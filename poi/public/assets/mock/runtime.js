export const DEMO_PROPOSAL_TEMPLATE = Object.freeze({
    itineraryId: 'demo_itinerary',
    proposalId: 'demo_proposal',
    eventId: 'demo_barrier',
    edgeId: '7',
    type: 'barrierReroute',
    reason: '演示路网检测到道路临时关闭，建议按拓扑绕行',
    diff: { before: ['poi_photo', 'poi_history', 'poi_lake'], after: ['poi_photo', 'poi_history', 'poi_lake'] }
});

export const DEMO_CLOSED_EDGE = Object.freeze({
    eventId: 'demo_barrier',
    edgeId: '7',
    status: 'closed',
    reason: '道路临时关闭',
    geometry: { type: 'LineString', coordinates: [[114.3616301001, 30.542118200026927], [114.3615779001, 30.542113700026952]] }
});
