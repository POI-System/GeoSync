const CENTER = [114.3592, 30.541];
const EXTENT = [114.3468, 30.5332, 114.3722, 30.5486];

const POIS = [
    { id: 'poi_gate', poiName: '珞珈门游客中心', category: '旅游景点', description: '行程起点与服务中心', lng: 114.3518, lat: 30.5374, status: 'approved' },
    { id: 'poi_photo', poiName: '樱顶摄影点', category: '摄影', description: '适合远眺与建筑摄影', lng: 114.3558, lat: 30.5404, status: 'approved' },
    { id: 'poi_history', poiName: '老图书馆', category: '人文', description: '校园历史建筑', lng: 114.3596, lat: 30.5421, status: 'approved' },
    { id: 'poi_lake', poiName: '珞珈湖步道', category: '自然', description: '林荫步道与湖景', lng: 114.3648, lat: 30.5441, status: 'approved' },
    { id: 'poi_family', poiName: '自然观察园', category: '亲子', description: '适合亲子自然观察', lng: 114.3692, lat: 30.5405, status: 'approved' }
];

const HEATMAP = {
    slot: new Date().toISOString(),
    lowConfidence: false,
    items: [
        { poiId: 'poi_gate', ci: 0.26, level: 'low', queueEstMin: 2, lowConfidence: false },
        { poiId: 'poi_photo', ci: 0.56, level: 'medium', queueEstMin: 9, lowConfidence: false },
        { poiId: 'poi_history', ci: 0.83, level: 'high', queueEstMin: 24, lowConfidence: false },
        { poiId: 'poi_lake', ci: 0.38, level: 'low', queueEstMin: 4, lowConfidence: false },
        { poiId: 'poi_family', ci: 0.45, level: 'medium', queueEstMin: 6, lowConfidence: false }
    ]
};

const route = (coordinates, mode = 'shade', source = 'iserver') => ({
    geometry: { type: 'LineString', coordinates },
    distanceM: Math.round(coordinates.length * 238),
    durationSec: Math.round(coordinates.length * 196),
    gis: { source, mode, degraded: source !== 'iserver', durationMs: 148, dataVersion: 'demo-v1' },
    verifiedAccessible: mode === 'accessible' ? source === 'iserver' : null
});

const OLD_ROUTE = route([
    [114.3518, 30.5374], [114.3558, 30.5404], [114.3596, 30.5421], [114.3648, 30.5441]
]);

const NEW_ROUTE = route([
    [114.3518, 30.5374], [114.3558, 30.5404], [114.3615, 30.5394], [114.3648, 30.5441]
]);

function stops() {
    const now = Date.now();
    return [
        ['stop_photo', 'poi_photo', '樱顶摄影点'],
        ['stop_history', 'poi_history', '老图书馆'],
        ['stop_lake', 'poi_lake', '珞珈湖步道']
    ].map(([stopId, poiId, poiName], index) => ({
        stopId, poiId, poiName,
        state: index === 0 ? 'approaching' : 'pending',
        plannedArrive: new Date(now + (index * 55 + 20) * 60000).toISOString(),
        plannedLeave: new Date(now + (index * 55 + 45) * 60000).toISOString(),
        ci: { predictedAtArrive: [0.56, 0.83, 0.38][index] }
    }));
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function photoSpots() {
    return {
        items: [
            {
                spotId: 'spot_roof', poiId: 'poi_photo', name: '樱顶西望',
                lnglat: [114.3558, 30.5404], heading: 285, score: 0.91,
                coverPhoto: null, todayWindows: [{ start: '17:12', end: '17:48', light: 'golden' }],
                ciNow: 0.56, distanceM: 420
            },
            {
                spotId: 'spot_lake', poiId: 'poi_lake', name: '湖畔倒影',
                lnglat: [114.3648, 30.5441], heading: 110, score: 0.84,
                coverPhoto: null, todayWindows: [{ start: '08:10', end: '08:42', light: 'side' }],
                ciNow: 0.38, distanceM: 780
            }
        ]
    };
}

export class DemoApiClient {
    constructor() {
        try {
            this.itinerary = JSON.parse(sessionStorage.getItem('geosync:demo-itinerary')) || null;
        } catch {
            this.itinerary = null;
        }
    }

    persist() {
        if (this.itinerary) sessionStorage.setItem('geosync:demo-itinerary', JSON.stringify(this.itinerary));
        else sessionStorage.removeItem('geosync:demo-itinerary');
    }

    delay(value, ms = 90) {
        return new Promise(resolve => setTimeout(() => resolve(clone(value)), ms));
    }

    getClientConfig() {
        return this.delay({
            scenicId: 'whu_demo', scenicCenter: CENTER,
            features: { supermap: true, threeD: true, rain: true },
            gis: {
                enabled: true, state: 'online', center: CENTER, extent: EXTENT, crs: 'EPSG:4326',
                features: { supermap: true, threeD: true },
                publicServices: { map: 'demo://map', scene: '/tour?demo=1#spot/spot_roof' }
            }
        });
    }

    getPois() { return this.delay(POIS); }
    getHeatmap() { return this.delay(HEATMAP); }
    getCurrentItinerary() { return this.delay(this.itinerary); }
    getPhotoSpots() { return this.delay(photoSpots()); }
    getGoldenWindow() {
        return this.delay({
            date: new Date().toISOString().slice(0, 10), weatherAdjusted: false, cloudy: false,
            windows: [{ start: '17:12', end: '17:48', light: 'golden', trueSunset: '18:52', geometricSunset: '19:08', ciPredicted: 0.47 }]
        });
    }
    getArData() {
        return this.delay({ heading: 285, tolerance: 10, focalHint: '26mm 等效', ciNow: 0.56, fallbackCard: { text: '面朝西北，主楼置于画面右三分之一', photos: [] } });
    }

    async plan(payload) {
        const mode = payload.accessible ? 'accessible' : payload.shadeFirst ? 'shade' : 'normal';
        this.itinerary = {
            itineraryId: 'demo_itinerary', version: 0, state: 'draft',
            date: new Date().toISOString().slice(0, 10),
            preferences: { ...payload }, stops: stops(), route: { ...clone(OLD_ROUTE), gis: { ...OLD_ROUTE.gis, mode } },
            currentStopId: 'stop_photo', pendingProposal: null, savedMinutesTotal: 0, rerouteCount: 0,
            totalWalkMin: 34, planNote: '已优先安排摄影和林荫路段'
        };
        this.persist();
        return this.delay(this.itinerary, 320);
    }

    mutate(state) {
        this.itinerary = { ...this.itinerary, state, version: this.itinerary.version + 1 };
        this.persist();
        return this.delay(this.itinerary);
    }

    start() { return this.mutate('active'); }
    pause() { return this.mutate('paused'); }
    resume() { return this.mutate('active'); }
    finish() { return this.mutate('completed'); }
    reportPosition() { return this.delay({ accepted: true }, 20); }

    skip(_id, stopId) {
        this.itinerary = {
            ...this.itinerary,
            version: this.itinerary.version + 1,
            stops: this.itinerary.stops.map(stop => stop.stopId === stopId ? { ...stop, state: 'skipped' } : stop)
        };
        this.persist();
        return this.delay(this.itinerary);
    }

    setProposal(proposal) {
        this.itinerary = { ...this.itinerary, pendingProposal: clone(proposal) };
        this.persist();
    }

    decideProposal(_id, _proposalId, decision) {
        if (decision === 'accept') {
            this.itinerary = {
                ...this.itinerary,
                version: this.itinerary.version + 1,
                route: clone(NEW_ROUTE), pendingProposal: null, rerouteCount: 1, savedMinutesTotal: 11
            };
        } else {
            this.itinerary = { ...this.itinerary, version: this.itinerary.version + 1, pendingProposal: null };
        }
        this.persist();
        return this.delay(this.itinerary);
    }

    cancelAll() {}
}

export function demoProposal(version = 1) {
    return {
        itineraryId: 'demo_itinerary', version,
        proposalId: 'demo_proposal', type: 'barrierReroute',
        reason: '老图书馆东侧道路临时关闭，建议绕行林荫路', gainMin: 11,
        distanceDeltaM: 126,
        expireAt: new Date(Date.now() + 8 * 60000).toISOString(),
        diff: { before: ['poi_photo', 'poi_history', 'poi_lake'], after: ['poi_photo', 'poi_lake'] },
        beforeRoute: clone(OLD_ROUTE), afterRoute: { ...clone(NEW_ROUTE), reason: '临时封路绕行' }
    };
}

export function demoClosedEdge() {
    return {
        eventId: 'demo_barrier',
        edgeId: 'edge_library_east',
        status: 'closed',
        reason: '道路临时关闭',
        at: new Date().toISOString(),
        geometry: {
            type: 'LineString',
            coordinates: [[114.3582, 30.5414], [114.3608, 30.5427]]
        }
    };
}
