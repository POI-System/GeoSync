'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const modelModule = require('../../models');

const isolatedMongoose = new mongoose.Mongoose();
const registeredModels = modelModule.registerModels(isolatedMongoose);
const itinerarySchema = registeredModels.Itinerary.schema;
const stopSchema = itinerarySchema.path('stops').schema;
const aggregateRouteSchema = itinerarySchema.path('route').schema;
const WalkEdge = registeredModels.WalkEdge;

const originalGetModels = modelModule.getModels;
const planner = require('../../services/planner');
const originalPlan = planner.plan;

let planCall;
let createdPayload;
let barrierSnapshotCalls = 0;

const canonicalStop = {
    poiId: 'poi-a',
    photoSpotId: null,
    plannedArrive: new Date('2026-08-02T01:01:00.000Z'),
    plannedLeave: new Date('2026-08-02T01:21:00.000Z'),
    state: 'pending',
    geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
    distanceM: 90,
    durationSec: 60,
    gis: {
        source: 'iserver', mode: 'shade', degraded: false,
        requestId: 'request-plan', durationMs: 15, dataVersion: 'v1'
    },
    segments: [{
        edgeId: 'edge-1', physicalEdgeId: 'physical-edge-1',
        fromNodeId: 'node-a', toNodeId: 'node-b',
        distanceM: 90, durationSec: 60,
        sourceRef: { datasetName: 'WalkEdge@GeoSync', smId: 1 }
    }],
    nodeIds: ['node-a', 'node-b'],
    edgeIds: ['edge-1'],
    snap: { startDistanceM: 1, endDistanceM: 2 },
    available: true,
    authoritative: true,
    routeFound: true,
    routeKind: 'topology',
    topology: true,
    verifiedAccessible: true,
    pathGeometry: 'legacy-stop-path'
};

const aggregateRoute = {
    geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
    distanceM: 90,
    durationSec: 60,
    gis: {
        source: 'iserver', mode: 'shade', degraded: false,
        requestId: 'request-plan', durationMs: 15, dataVersion: 'v1'
    },
    segments: canonicalStop.segments,
    snap: canonicalStop.snap,
    verifiedAccessible: true,
    pathGeometry: 'legacy-full-path'
};

const Itinerary = {
    findOne() {
        return { lean: async () => null };
    },
    async create(payload) {
        createdPayload = payload;
        return {
            ...payload,
            _id: 'itinerary-plan',
            version: 1,
            state: 'draft',
            pendingProposal: null,
            savedMinutesTotal: 0,
            rerouteCount: 0,
            stops: payload.stops.map((stop, index) => ({ ...stop, _id: `stop-${index + 1}` }))
        };
    }
};

const ExternalPoi = {
    find() {
        return { lean: async () => [{ _id: 'poi-a', poiName: 'POI A' }] };
    }
};

const closedBarriers = [{
    edgeId: 'edge-closed',
    sourceRef: { datasetName: 'WalkEdge@GeoSync', smId: 9 }
}];
const WalkEdgeModel = {
    find(filter) {
        assert.deepEqual(filter, { scenicId: 'default', status: 'closed' });
        barrierSnapshotCalls++;
        return { lean: async () => structuredClone(closedBarriers) };
    }
};

modelModule.getModels = () => ({ Itinerary, ExternalPoi, WalkEdge: WalkEdgeModel });

planner.plan = async (input, deps) => {
    planCall = { input, deps };
    return {
        stops: [structuredClone(canonicalStop)],
        route: structuredClone(aggregateRoute),
        totalWalkMin: 1,
        planNote: 'planned'
    };
};

delete require.cache[require.resolve('../../routes/itinerary')];
const router = require('../../routes/itinerary');
const planLayer = router.stack.find(layer => layer.route?.path === '/plan');
const planHandler = planLayer.route.stack[0].handle;

test.after(() => {
    modelModule.getModels = originalGetModels;
    planner.plan = originalPlan;
});

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test('itinerary schema persists canonical stop and aggregate route fields', () => {
    for (const field of [
        'geometry', 'distanceM', 'durationSec', 'gis', 'segments', 'snap',
        'nodeIds', 'edgeIds', 'topologyProof', 'verifiedAccessible', 'pathGeometry'
    ]) {
        assert.ok(stopSchema.path(field), `missing stop schema field ${field}`);
        assert.ok(aggregateRouteSchema.path(field), `missing aggregate route schema field ${field}`);
    }
    assert.equal(stopSchema.path('geometry').schema.path('type').options.enum[0], 'LineString');
    assert.deepEqual(
        stopSchema.path('gis').schema.path('source').options.enum,
        ['iserver', 'cache', 'local-fallback']
    );
    for (const field of ['physicalEdgeId', 'fromNodeId', 'toNodeId']) {
        assert.ok(stopSchema.path('segments').schema.path(field), `missing segment field ${field}`);
    }
    for (const field of ['startNodeId', 'endNodeId']) {
        assert.ok(stopSchema.path('snap').schema.path(field), `missing snap field ${field}`);
    }
    for (const field of ['geometryDigest', 'nodeIds', 'edgeIds', 'segments', 'digest']) {
        assert.ok(stopSchema.path('topologyProof').schema.path(field), `missing proof field ${field}`);
    }
});

test('WalkEdge schema retains complete local graph provenance', () => {
    const document = new WalkEdge({
        edgeId: 'edge-provenance',
        from: 'node-a',
        to: 'node-b',
        walkSec: 60,
        sourceRef: {
            datasetName: 'WalkEdge@GeoSync',
            smId: 17,
            sourceId: 'source-edge-17',
            dataVersion: 'graph-v1'
        }
    });

    assert.deepStrictEqual(document.toObject().sourceRef, {
        datasetName: 'WalkEdge@GeoSync',
        smId: 17,
        sourceId: 'source-edge-17',
        dataVersion: 'graph-v1'
    });
});

test('plan injects the request-scoped resolver and serializes canonical plus legacy route fields', async () => {
    const routeBetween = async () => canonicalStop;
    const estimateBetween = () => null;
    barrierSnapshotCalls = 0;
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/plan',
        openId: 'user-1',
        headers: { 'x-request-id': 'request-plan' },
        body: {
            startLocation: [118, 32],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 2,
            interests: ['history'],
            pace: 'normal',
            accessible: false,
            shadeFirst: true
        },
        app: { locals: { geosync: {
            routeBetween,
            estimateBetween,
            dataVersion: () => 'v1'
        } } }
    };
    const res = response();
    await planHandler(req, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(planCall.deps.routeBetween, routeBetween);
    assert.equal(planCall.deps.estimateBetween, estimateBetween);
    assert.equal(barrierSnapshotCalls, 3);
    assert.deepEqual(planCall.deps.routeContext.barriers, closedBarriers.map(barrier => ({
        ...barrier,
        physicalEdgeId: barrier.edgeId
    })));
    assert.match(planCall.deps.routeContext.barrierFingerprint, /^sha256:/);
    assert.equal(planCall.deps.routeContext.dataVersion, 'v1');
    assert.equal(planCall.input.openId, 'user-1');
    assert.equal(planCall.input.requestId, 'request-plan');
    assert.deepEqual(planCall.input.startLocation, [118, 32]);
    assert.equal(planCall.input.shadeFirst, true);
    assert.equal(planCall.input.startAt.toISOString(), '2026-08-02T01:00:00.000Z');

    assert.equal(createdPayload.openId, 'user-1');
    assert.equal(createdPayload.activeOwner, 'user-1');
    assert.equal(createdPayload.route.distanceM, 90);
    assert.equal(createdPayload.stops[0].pathGeometry, 'legacy-stop-path');

    const data = res.body.data;
    assert.equal(data.totalWalkMin, 1);
    assert.equal(data.planNote, 'planned');
    assert.equal(data.route.distanceM, 90);
    assert.equal(data.route.durationSec, 60);
    assert.equal(data.route.verifiedAccessible, true);
    assert.equal(data.route.pathGeometry, 'legacy-full-path');
    assert.deepEqual(data.route.geometry.coordinates, [[118, 32], [118.001, 32.001]]);
    assert.equal(data.stops[0].poiName, 'POI A');
    assert.equal(data.stops[0].durationSec, 60);
    assert.equal(data.stops[0].distanceM, 90);
    assert.equal(data.stops[0].verifiedAccessible, true);
    assert.equal(data.stops[0].gis.source, 'iserver');
    assert.equal(data.stops[0].segments[0].sourceRef.datasetName, 'WalkEdge@GeoSync');
    assert.deepEqual(data.stops[0].snap, { startDistanceM: 1, endDistanceM: 2 });
    assert.equal(data.stops[0].pathGeometry, 'legacy-stop-path');
});

test('plan rejects an invalid startAt before planner or persistence work', async () => {
    planCall = null;
    createdPayload = null;
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/plan',
        openId: 'user-invalid-start-at',
        headers: {},
        body: {
            startLocation: [118, 32],
            startAt: 'not-a-date',
            hours: 2
        },
        app: { locals: { geosync: { routeBetween: async () => canonicalStop } } }
    };
    const res = response();
    let nextError;

    await planHandler(req, res, error => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 1102);
    assert.equal(planCall, null);
    assert.equal(createdPayload, null);
});

test('plan fails closed when the request-scoped GIS data version is unavailable', async () => {
    planCall = null;
    createdPayload = null;
    barrierSnapshotCalls = 0;
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/plan',
        openId: 'user-no-version',
        headers: { 'x-request-id': 'request-no-version' },
        body: {
            startLocation: [118, 32],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 2
        },
        app: { locals: { geosync: {
            routeBetween: async () => canonicalStop,
            estimateBetween: () => null,
            dataVersion: () => null
        } } }
    };
    const res = response();
    let nextError;

    await planHandler(req, res, error => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(barrierSnapshotCalls, 1);
    assert.equal(planCall, null);
    assert.equal(createdPayload, null);
});

test('plan loads one barrier snapshot and forwards it through topology estimates and final routing', async () => {
    planner.plan = originalPlan;
    planCall = null;
    createdPayload = null;
    barrierSnapshotCalls = 0;
    const estimateContexts = [];
    const routeContexts = [];
    const originalPlannerQueries = {
        externalPoiFind: registeredModels.ExternalPoi.find,
        photoSpotFind: registeredModels.PhotoSpot.find,
        checkinAggregate: registeredModels.Checkin.aggregate,
        campaignFind: registeredModels.Campaign.find
    };
    registeredModels.ExternalPoi.find = () => ({ lean: async () => [{
        _id: 'poi-a',
        poiName: 'POI A',
        gateNodeId: 'node-b',
        category: 'history',
        geo: { type: 'Point', coordinates: [118.001, 32.001] },
        visitMeta: { suggestedStayMin: 10, tags: ['history'] }
    }] });
    registeredModels.PhotoSpot.find = () => ({
        sort() { return this; },
        lean: async () => []
    });
    registeredModels.Checkin.aggregate = async () => [];
    registeredModels.Campaign.find = () => ({ lean: async () => [] });
    const estimateBetween = (from, to, mode, context) => {
        estimateContexts.push({ mode, context });
        return {
            walkSec: 60,
            durationSec: 60,
            distanceM: 90,
            coords: [from.geo.coordinates, to.geo.coordinates],
            geometry: { type: 'LineString', coordinates: [from.geo.coordinates, to.geo.coordinates] },
            nodeIds: ['node-a', 'node-b'],
            edgeIds: ['edge-open'],
            edgeDataVersions: ['v1'],
            segments: [{
                edgeId: 'edge-open',
                fromNodeId: 'node-a',
                toNodeId: 'node-b',
                distanceM: 90,
                durationSec: 60,
                sourceRef: { datasetName: 'WalkEdge@GeoSync', smId: 1 }
            }],
            gis: { source: 'iserver', mode, dataVersion: 'v1' },
            fallback: false,
            available: true,
            authoritative: true,
            routeFound: true,
            routeKind: 'graph'
        };
    };
    const routeBetween = async (from, to, mode, context) => {
        routeContexts.push({ mode, context });
        return structuredClone(canonicalStop);
    };
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/plan',
        openId: 'user-full-snapshot',
        headers: { 'x-request-id': 'request-full-snapshot' },
        body: {
            startLocation: [118, 32],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            interests: ['history'],
            shadeFirst: true
        },
        app: { locals: { geosync: {
            routeBetween,
            estimateBetween,
            dataVersion: () => 'v1'
        } } }
    };
    const res = response();

    try {
        await planHandler(req, res, () => {});
    } finally {
        registeredModels.ExternalPoi.find = originalPlannerQueries.externalPoiFind;
        registeredModels.PhotoSpot.find = originalPlannerQueries.photoSpotFind;
        registeredModels.Checkin.aggregate = originalPlannerQueries.checkinAggregate;
        registeredModels.Campaign.find = originalPlannerQueries.campaignFind;
        planner.plan = async (input, deps) => {
            planCall = { input, deps };
            return {
                stops: [structuredClone(canonicalStop)],
                route: structuredClone(aggregateRoute),
                totalWalkMin: 1,
                planNote: 'planned'
            };
        };
    }

    assert.equal(res.statusCode, 200);
    assert.equal(barrierSnapshotCalls, 3);
    assert.ok(estimateContexts.length >= 1);
    assert.equal(routeContexts.length, 1);
    for (const call of [...estimateContexts, ...routeContexts]) {
        assert.equal(call.mode, 'shade');
        assert.equal(call.context.dataVersion, 'v1');
        assert.match(call.context.barrierFingerprint, /^sha256:/);
        assert.deepEqual(call.context.barriers, closedBarriers.map(barrier => ({
            ...barrier,
            physicalEdgeId: barrier.edgeId
        })));
    }
});
