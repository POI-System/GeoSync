import { ApiError, apiErrorCategory, safeApiMessage } from '../shared/errors.js';
import { DEMO_CLOSED_EDGE, DEMO_PROPOSAL_TEMPLATE } from '../../mock/runtime.js';
import { createTopologyRouter } from '../routing/topologyRouter.js';

const FIXTURE_BASE = '/assets/mock';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

const SCENARIO_STATUS = Object.freeze({
    1203: 409,
    1204: 400,
    1205: 400,
    1206: 400,
    8201: 503,
    8202: 504,
    8203: 422,
    8204: 422,
    8205: 409,
    8206: 502
});

function scenarioOperation(code) {
    if ([1206, 8201, 8202, 8203, 8204, 8205, 8206].includes(Number(code))) return 'plan';
    if ([1204, 1205].includes(Number(code))) return 'proposal';
    if (Number(code) === 1203) return 'write';
    if ([2102, 2103].includes(Number(code))) return 'position';
    return 'all';
}

function cancelledError(cause = null) {
    return new ApiError('请求已取消', {
        category: 'cancelled',
        retryable: false,
        cause
    });
}

function nowOf(clock) {
    return typeof clock.now === 'function' ? Number(clock.now()) : Date.now();
}

function routeMode(payload = {}) {
    return payload.accessible ? 'accessible' : payload.shadeFirst ? 'shade' : 'normal';
}

function routeResponse(result, network, { reason = null } = {}) {
    if (!result?.found) return null;
    return {
        geometry: clone(result.geometry),
        distanceM: Math.round(result.distanceM),
        durationSec: Math.round(result.durationSec),
        ...(reason ? { reason } : {}),
        edgeIds: [...result.edgeIds],
        sourceEdgeIds: [...result.sourceEdgeIds],
        nodeIds: [...result.nodeIds],
        segments: clone(result.segments),
        legs: clone(result.legs || []),
        gis: {
            source: 'demo-topology',
            mode: result.mode,
            degraded: true,
            dataVersion: network.source?.dataVersion || 'demo-topology-v1'
        },
        verifiedAccessible: result.mode === 'accessible' ? result.accessibleVerified === true : null
    };
}

function unreachableRouteError() {
    const code = 8204;
    const status = SCENARIO_STATUS[code] || 422;
    throw new ApiError(safeApiMessage({ status, code }), {
        category: apiErrorCategory({ status, code }),
        httpStatus: status,
        code,
        retryable: false
    });
}

function scheduledStops(stops, routeResult, now) {
    let elapsedSec = 0;
    return stops.map((stop, index) => {
        const leg = routeResult.legs[index];
        elapsedSec += Math.max(0, Number(leg?.durationSec || 0));
        const arriveAt = now + elapsedSec * 1000;
        const staySec = Math.max(1, Number(stop.suggestedStayMin || 25)) * 60;
        elapsedSec += staySec;
        return {
            ...stop,
            plannedArrive: new Date(arriveAt).toISOString(),
            plannedLeave: new Date(now + elapsedSec * 1000).toISOString()
        };
    });
}

function proposalForRoutes(version, beforeRoute, afterRoute, blockedEdgeId, now) {
    const distanceDeltaM = afterRoute.distanceM - beforeRoute.distanceM;
    const durationDeltaSec = afterRoute.durationSec - beforeRoute.durationSec;
    return {
        ...clone(DEMO_PROPOSAL_TEMPLATE),
        version,
        reason: `道路临时关闭（边 ${blockedEdgeId}），已按真实拓扑计算绕行路线`,
        gainMin: Math.max(0, Math.round((beforeRoute.durationSec - afterRoute.durationSec) / 60)),
        distanceDeltaM,
        durationDeltaSec,
        expireAt: new Date(now + 8 * 60000).toISOString(),
        beforeRoute: clone(beforeRoute),
        afterRoute: clone(afterRoute)
    };
}

function validateDemoTopology(network, router) {
    if (String(network.blockedDemoEdgeId ?? '') !== String(DEMO_CLOSED_EDGE.edgeId)
        || String(DEMO_PROPOSAL_TEMPLATE.edgeId) !== String(DEMO_CLOSED_EDGE.edgeId)
        || String(DEMO_PROPOSAL_TEMPLATE.eventId) !== String(DEMO_CLOSED_EDGE.eventId)) {
        throw new Error('demo barrier event, proposal and topology fixtures must reference the same edge');
    }
    const requiredKeys = ['start', 'poi_gate', 'poi_photo', 'poi_history', 'poi_lake', 'poi_family'];
    for (const key of requiredKeys) {
        const nodeId = network.poiNodes?.[key];
        if (!nodeId || !router.nodeCoordinate(nodeId)) {
            throw new Error(`demo topology is missing a connected node mapping for ${key}`);
        }
    }
    const startNodeId = network.poiNodes.start;
    for (const key of requiredKeys.filter(key => key !== 'start')) {
        if (!router.routeBetween(startNodeId, network.poiNodes[key], { mode: 'normal' }).found) {
            throw new Error(`demo topology node mapping for ${key} is not connected to the start node`);
        }
    }
    const waypoints = ['start', 'poi_photo', 'poi_history', 'poi_lake']
        .map(key => network.poiNodes[key]);
    const before = router.routeThrough(waypoints, { mode: 'normal' });
    const after = router.routeThrough(waypoints, {
        mode: 'normal',
        blockedEdgeIds: [network.blockedDemoEdgeId]
    });
    if (!before.found || !after.found
        || !before.sourceEdgeIds.includes(String(network.blockedDemoEdgeId))
        || after.sourceEdgeIds.includes(String(network.blockedDemoEdgeId))) {
        throw new Error('demo topology does not provide the required open and barrier-reroute paths');
    }
}

export class DemoApiClient {
    constructor({
        scenario = '',
        fetchImpl = globalThis.fetch?.bind(globalThis),
        clock = globalThis,
        storage = globalThis.sessionStorage
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.clock = clock;
        this.storage = storage;
        this.controllers = new Map();
        this.fixtureCache = new Map();
        this.scenarios = new Map();
        this.itinerary = this.readStoredItinerary();
        this.closedEdgeState = null;
        this.network = null;
        this.router = null;
        if (scenario && typeof scenario === 'object') {
            for (const [operation, code] of Object.entries(scenario)) this.setScenario(operation, code);
        } else if (scenario) {
            this.setScenario(Number(scenario));
        }
    }

    readStoredItinerary() {
        try {
            return JSON.parse(this.storage?.getItem('geosync:demo-itinerary')) || null;
        } catch {
            return null;
        }
    }

    persist() {
        if (!this.storage) return;
        if (this.itinerary) this.storage.setItem('geosync:demo-itinerary', JSON.stringify(this.itinerary));
        else this.storage.removeItem('geosync:demo-itinerary');
    }

    setScenario(operation, code) {
        if (code === undefined) {
            code = Number(operation);
            operation = scenarioOperation(code);
        }
        const numericCode = Number(code);
        if (numericCode) this.scenarios.set(String(operation), numericCode);
        return this;
    }

    clearScenario(operation) {
        if (operation) this.scenarios.delete(String(operation));
        else this.scenarios.clear();
        return this;
    }

    scenarioCode(operation) {
        return this.scenarios.get(operation)
            || (operation === 'proposal' ? this.scenarios.get('write') : 0)
            || this.scenarios.get('all')
            || 0;
    }

    throwScenario(operation) {
        const code = this.scenarioCode(operation);
        if (!code || [2102, 2103].includes(code)) return;
        const status = SCENARIO_STATUS[code] || 400;
        const category = apiErrorCategory({ status, code });
        throw new ApiError(safeApiMessage({ status, code, category }), {
            category,
            httpStatus: status,
            code,
            retryable: status >= 500 && code !== 8206
        });
    }

    register(key, controller) {
        if (!this.controllers.has(key)) this.controllers.set(key, new Set());
        this.controllers.get(key).add(controller);
    }

    unregister(key, controller) {
        const controllers = this.controllers.get(key);
        controllers?.delete(controller);
        if (!controllers?.size) this.controllers.delete(key);
    }

    cancel(key) {
        for (const controller of this.controllers.get(key) || []) controller.abort();
        this.controllers.delete(key);
    }

    cancelAll() {
        for (const key of [...this.controllers.keys()]) this.cancel(key);
    }

    destroy() {
        this.cancelAll();
    }

    wait(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(cancelledError(signal.reason));
            const timer = this.clock.setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
            const onAbort = () => {
                cleanup();
                reject(cancelledError(signal.reason));
            };
            const cleanup = () => {
                this.clock.clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    async run(key, operation, { delayMs = 90, cancelPrevious = true } = {}) {
        if (cancelPrevious) this.cancel(key);
        const controller = new AbortController();
        this.register(key, controller);
        try {
            await this.wait(delayMs, controller.signal);
            if (controller.signal.aborted) throw cancelledError(controller.signal.reason);
            return clone(await operation(controller.signal));
        } catch (error) {
            if (error instanceof ApiError) throw error;
            if (controller.signal.aborted || error?.name === 'AbortError') throw cancelledError(error);
            throw new ApiError('演示数据暂时不可用', {
                category: 'response',
                retryable: true,
                cause: error
            });
        } finally {
            this.unregister(key, controller);
        }
    }

    delay(value, ms = 90) {
        return this.run(`delay:${Math.random()}`, () => value, { delayMs: ms, cancelPrevious: false });
    }

    async fixture(name, signal) {
        if (this.fixtureCache.has(name)) return clone(this.fixtureCache.get(name));
        if (typeof this.fetchImpl !== 'function') throw new TypeError('fetch unavailable');
        const response = await this.fetchImpl(`${FIXTURE_BASE}/${name}`, {
            credentials: 'same-origin',
            signal
        });
        if (!response.ok) throw new Error(`fixture ${name} unavailable`);
        const value = await response.json();
        this.fixtureCache.set(name, value);
        return clone(value);
    }

    async topology(signal) {
        if (!this.network) {
            this.network = await this.fixture('demo-walk-network.json', signal);
            this.router = createTopologyRouter(this.network);
            validateDemoTopology(this.network, this.router);
        }
        return { network: this.network, router: this.router };
    }

    async closedEdgesSnapshot(signal) {
        if (!this.closedEdgeState) {
            const snapshot = await this.fixture('closed-edges.json', signal);
            this.closedEdgeState = {
                ...snapshot,
                items: Array.isArray(snapshot?.items) ? snapshot.items : []
            };
        }
        return clone(this.closedEdgeState);
    }

    applyGraphEvent(item) {
        const edgeId = String(item?.edgeId ?? '').trim();
        if (!edgeId) return clone(this.closedEdgeState || { items: [] });
        const current = this.closedEdgeState || { items: [] };
        const items = (Array.isArray(current.items) ? current.items : [])
            .filter(edge => String(edge?.edgeId) !== edgeId);
        if (item.status === 'closed') items.push(clone(item));
        this.closedEdgeState = { ...current, items };
        return clone(this.closedEdgeState);
    }

    getClientConfig() {
        return this.run('config', signal => this.fixture('client-config.json', signal));
    }

    getBoundary() {
        return this.run('boundary', signal => this.fixture('boundary.geojson', signal));
    }

    getRoadNetwork() {
        return this.run('road-network', async signal => {
            if (typeof this.fetchImpl !== 'function') return { type: 'FeatureCollection', features: [] };
            const response = await this.fetchImpl('/api/geosync/road-network', {
                credentials: 'same-origin', signal
            });
            if (!response.ok) return { type: 'FeatureCollection', features: [] };
            const payload = await response.json();
            return payload?.data || payload;
        });
    }

    getPois() {
        return this.run('pois', async signal => {
            const collection = await this.fixture('pois.geojson', signal);
            return collection.features.map(feature => ({
                id: feature.properties.poiId,
                poiName: feature.properties.name,
                category: feature.properties.category,
                description: feature.properties.description,
                status: feature.properties.status,
                suggestedStayMin: feature.properties.suggestedStayMin,
                lng: feature.geometry.coordinates[0],
                lat: feature.geometry.coordinates[1]
            }));
        });
    }

    getHeatmap() {
        return this.run('heatmap', signal => this.fixture('heatmap.json', signal));
    }

    getCurrentItinerary() {
        return this.run('current', () => this.itinerary);
    }

    getClosedEdges() {
        return this.run('closed-edges', signal => this.closedEdgesSnapshot(signal));
    }

    getPhotoSpots() {
        return this.run('photospots', signal => this.fixture('photospots.json', signal));
    }

    getGoldenWindow(id) {
        return this.run(`golden:${id}`, async signal => {
            const fixture = await this.fixture('photospots.json', signal);
            return fixture.items.find(item => String(item.spotId) === String(id))?.golden || null;
        });
    }

    getArData(id) {
        return this.run(`ar:${id}`, async signal => {
            const fixture = await this.fixture('photospots.json', signal);
            return fixture.items.find(item => String(item.spotId) === String(id))?.ar || null;
        });
    }

    async plan(payload) {
        return this.run('plan', async signal => {
            this.throwScenario('plan');
            const [template, topology, closedEdges] = await Promise.all([
                this.fixture('itinerary.json', signal),
                this.topology(signal),
                this.closedEdgesSnapshot(signal)
            ]);
            const mode = routeMode(payload);
            const now = nowOf(this.clock);
            const stopIds = template.stops.map(stop => stop.poiId);
            const startNodeId = topology.network.poiNodes.start;
            const stopNodeIds = stopIds.map(poiId => topology.network.poiNodes[poiId]);
            if (!startNodeId || stopNodeIds.some(nodeId => !nodeId)) {
                throw new Error('demo topology does not define every planned stop');
            }
            const blockedEdgeIds = closedEdges.items
                .filter(edge => edge?.status === 'closed')
                .map(edge => String(edge.edgeId));
            const routeResult = topology.router.routeThrough(
                [startNodeId, ...stopNodeIds],
                { mode, blockedEdgeIds }
            );
            if (!routeResult.found) unreachableRouteError();
            template.date = new Date(now).toISOString().slice(0, 10);
            template.preferences = { ...payload };
            template.stops = scheduledStops(template.stops, routeResult, now);
            template.route = routeResponse(routeResult, topology.network);
            template.totalWalkMin = Math.max(1, Math.round(template.route.durationSec / 60));
            template.planNote = '路线由演示路网拓扑计算；正式模式仍由后端 Gateway 调用 iServer';
            this.itinerary = template;
            this.persist();
            return this.itinerary;
        }, { delayMs: 320 });
    }

    planItinerary(payload) { return this.plan(payload); }

    requireItinerary(id, version) {
        if (!this.itinerary
            || String(this.itinerary.itineraryId) !== String(id)
            || Number(this.itinerary.version) !== Number(version)) {
            const status = 409;
            throw new ApiError(safeApiMessage({ status, code: 1203 }), {
                category: 'conflict', httpStatus: status, code: 1203
            });
        }
    }

    transition(id, version, state, key) {
        return this.run('itinerary-write', () => {
            this.throwScenario('write');
            this.requireItinerary(id, version);
            this.itinerary = { ...this.itinerary, state, version: this.itinerary.version + 1 };
            this.persist();
            return this.itinerary;
        }, { delayMs: 90, cancelPrevious: true, key });
    }

    start(id, version) { return this.transition(id, version, 'active'); }
    startItinerary(id, version) { return this.start(id, version); }
    pause(id, version) { return this.transition(id, version, 'paused'); }
    pauseItinerary(id, version) { return this.pause(id, version); }
    resume(id, version) { return this.transition(id, version, 'active'); }
    resumeItinerary(id, version) { return this.resume(id, version); }
    finish(id, version) { return this.transition(id, version, 'completed'); }
    endItinerary(id, version) { return this.finish(id, version); }
    abandon(id, version) { return this.transition(id, version, 'abandoned'); }
    abandonItinerary(id, version) { return this.abandon(id, version); }

    skip(id, stopId, version) {
        return this.run('itinerary-write', () => {
            this.throwScenario('write');
            this.requireItinerary(id, version);
            if (!this.itinerary.stops.some(stop => String(stop.stopId) === String(stopId))) {
                throw new ApiError(safeApiMessage({ status: 409, code: 1203 }), {
                    category: 'conflict', httpStatus: 409, code: 1203
                });
            }
            this.itinerary = {
                ...this.itinerary,
                version: this.itinerary.version + 1,
                stops: this.itinerary.stops.map(stop =>
                    String(stop.stopId) === String(stopId) ? { ...stop, state: 'skipped' } : stop)
            };
            this.persist();
            return this.itinerary;
        });
    }

    skipStop(id, stopId, version) { return this.skip(id, stopId, version); }

    reportPosition() {
        return this.run('position', () => {
            const code = this.scenarioCode('position');
            if (code === 2102) return { accepted: false, outOfFence: true, code, message: safeApiMessage({ code }) };
            if (code === 2103) return { accepted: false, code, message: safeApiMessage({ code }) };
            return { accepted: true, code: 0, message: '' };
        }, { delayMs: 20, cancelPrevious: false });
    }

    setProposal(proposal) {
        if (!this.itinerary) return;
        this.itinerary = { ...this.itinerary, pendingProposal: clone(proposal) };
        this.persist();
    }

    decideProposal(id, proposalId, decision, version) {
        return this.run('itinerary-write', async signal => {
            this.throwScenario('proposal');
            this.requireItinerary(id, version);
            const proposal = this.itinerary.pendingProposal;
            if (!proposal || String(proposal.proposalId) !== String(proposalId)
                || new Date(proposal.expireAt).getTime() <= nowOf(this.clock)) {
                throw new ApiError(safeApiMessage({ status: 400, code: 1204 }), {
                    category: 'business', httpStatus: 400, code: 1204
                });
            }
            if (!['accept', 'reject'].includes(String(decision))) {
                throw new ApiError('路线建议操作无效', { category: 'business' });
            }
            let route = this.itinerary.route;
            let stops = this.itinerary.stops;
            let currentStopId = this.itinerary.currentStopId;
            let planNote = this.itinerary.planNote;
            let rerouteCount = this.itinerary.rerouteCount;
            let savedMinutesTotal = this.itinerary.savedMinutesTotal;
            if (decision === 'accept') {
                route = clone(proposal.afterRoute);
                const retainedPoiIds = Array.isArray(proposal.diff?.after) ? proposal.diff.after : stops.map(stop => stop.poiId);
                stops = stops.filter(stop => retainedPoiIds.includes(stop.poiId));
                const now = nowOf(this.clock);
                const rerouteLegs = Array.isArray(route.legs) ? route.legs : [];
                let elapsedSec = 0;
                stops = stops.map((stop, index) => {
                    elapsedSec += Number(rerouteLegs[index]?.durationSec || 0);
                    const staySec = Math.max(1, Number(stop.suggestedStayMin || 25)) * 60;
                    const scheduled = {
                        ...stop,
                        plannedArrive: new Date(now + elapsedSec * 1000).toISOString(),
                        plannedLeave: new Date(now + (elapsedSec + staySec) * 1000).toISOString()
                    };
                    elapsedSec += staySec;
                    return scheduled;
                });
                currentStopId = stops[0]?.stopId || currentStopId;
                planNote = '已根据封路边重新运行演示拓扑寻路';
                rerouteCount = Number(rerouteCount || 0) + 1;
                savedMinutesTotal = Number(savedMinutesTotal || 0) + Math.max(0, Number(proposal.gainMin || 0));
            }
            this.itinerary = {
                ...this.itinerary,
                version: this.itinerary.version + 1,
                route,
                stops,
                currentStopId,
                planNote,
                pendingProposal: null,
                rerouteCount,
                savedMinutesTotal
            };
            this.persist();
            return this.itinerary;
        });
    }

    acceptProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'accept', version);
    }

    rejectProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'reject', version);
    }
}

export async function demoProposal(version = 1, client = null) {
    const api = client instanceof DemoApiClient ? client : new DemoApiClient();
    const topology = await api.topology();
    const mode = routeMode(api.itinerary?.preferences || {});
    const plannedStopIds = Array.isArray(api.itinerary?.stops)
        ? api.itinerary.stops.map(stop => stop.poiId)
        : ['poi_photo', 'poi_history', 'poi_lake'];
    const beforeStopIds = plannedStopIds.filter(poiId => topology.network.poiNodes[poiId]);
    const afterStopIds = [...beforeStopIds];
    const beforeWaypointIds = [
        topology.network.poiNodes.start,
        ...beforeStopIds.map(poiId => topology.network.poiNodes[poiId])
    ];
    const beforeResult = topology.router.routeThrough([
        ...beforeWaypointIds
    ], { mode });
    const afterResult = topology.router.routeThrough([
        ...beforeWaypointIds
    ], { mode, blockedEdgeIds: [topology.network.blockedDemoEdgeId] });
    if (!beforeResult.found || !afterResult.found) unreachableRouteError();
    const proposal = proposalForRoutes(
        version,
        routeResponse(beforeResult, topology.network),
        routeResponse(afterResult, topology.network, { reason: '临时封路拓扑绕行' }),
        topology.network.blockedDemoEdgeId,
        nowOf(api.clock)
    );
    proposal.diff = { before: beforeStopIds, after: afterStopIds };
    return proposal;
}

export function demoClosedEdge() {
    return { ...clone(DEMO_CLOSED_EDGE), at: new Date().toISOString() };
}
