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
        edgeId: 'edge-1', distanceM: 90, durationSec: 60,
        sourceRef: { datasetName: 'WalkEdge@GeoSync', smId: 1 }
    }],
    snap: { startDistanceM: 1, endDistanceM: 2 },
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

modelModule.getModels = () => ({ Itinerary, ExternalPoi });

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
        'verifiedAccessible', 'pathGeometry'
    ]) {
        assert.ok(stopSchema.path(field), `missing stop schema field ${field}`);
        assert.ok(aggregateRouteSchema.path(field), `missing aggregate route schema field ${field}`);
    }
    assert.equal(stopSchema.path('geometry').schema.path('type').options.enum[0], 'LineString');
    assert.deepEqual(
        stopSchema.path('gis').schema.path('source').options.enum,
        ['iserver', 'cache', 'local-fallback']
    );
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
        app: { locals: { geosync: { routeBetween } } }
    };
    const res = response();
    await planHandler(req, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(planCall.deps.routeBetween, routeBetween);
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
