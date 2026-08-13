'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const modelModule = require('../../models');
const bus = require('../../lib/eventBus');
const barrierReroute = require('../../services/barrierReroute');

let currentItinerary;
let updateResult;
let updateCalls;
let findOneCalls;
let calls;
let rebuildImpl;
let rebuildArgs;
let decisionEvents;
let barrierSnapshotImpl;

const injectedRouteBetween = async () => ({
    durationSec: 60,
    distanceM: 80,
    geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
    segments: [],
    snap: { startDistanceM: 0, endDistanceM: 0 },
    gis: { source: 'iserver', mode: 'normal', degraded: false, dataVersion: 'v1' }
});

const Itinerary = {
    findOne(filter = {}) {
        findOneCalls.push(filter);
        if (filter?.state?.$in && filter._id === undefined) {
            return { sort: async () => currentItinerary };
        }
        if (filter?._id === 'malformed') {
            const error = new Error('invalid object id');
            error.name = 'CastError';
            return Promise.reject(error);
        }
        if (!currentItinerary) return Promise.resolve(null);
        if (filter._id !== undefined && String(filter._id) !== String(currentItinerary._id)) {
            return Promise.resolve(null);
        }
        if (filter.openId !== undefined && String(filter.openId) !== String(currentItinerary.openId)) {
            return Promise.resolve(null);
        }
        return Promise.resolve(currentItinerary);
    },
    async findOneAndUpdate(filter, update) {
        updateCalls.push({ filter, update });
        calls.push('cas');
        if (updateResult === null) return null;
        const next = {
            ...currentItinerary,
            ...update.$set,
            version: currentItinerary.version + (update.$inc?.version || 0),
            rerouteCount: currentItinerary.rerouteCount + (update.$inc?.rerouteCount || 0),
            savedMinutesTotal: currentItinerary.savedMinutesTotal +
                (update.$inc?.savedMinutesTotal || 0)
        };
        currentItinerary = next;
        return next;
    }
};

const ExternalPoi = {
    find() {
        return { lean: async () => [] };
    }
};

const originalGetModels = modelModule.getModels;
modelModule.getModels = () => ({ Itinerary, ExternalPoi, PhotoSpot: {}, WalkEdge: {} });

const antiHerding = require('../../services/antiHerding');
const engine = require('../../services/geosyncEngine');
const forecast = require('../../services/forecastService');
const timeline = require('../../services/itineraryTimeline');
const guideService = require('../../services/guideService');
let nlEditOps;

const originals = {
    claimTokens: antiHerding.claimTokens,
    claimedTokensActive: antiHerding.claimedTokensActive,
    rollbackClaimedTokens: antiHerding.rollbackClaimedTokens,
    finalizeClaimedTokens: antiHerding.finalizeClaimedTokens,
    releaseTokens: antiHerding.releaseTokens,
    applyProposal: engine.applyProposal,
    parseNlEdit: guideService.parseNlEdit,
    rebuildArrivalIndex: forecast.rebuildArrivalIndex,
    rebuildTimeline: timeline.rebuildTimeline,
    loadClosedBarrierSnapshot: barrierReroute.loadClosedBarrierSnapshot,
    busEmit: bus.emit
};

antiHerding.claimTokens = async () => {
    calls.push('claim');
    return true;
};
antiHerding.claimedTokensActive = async () => {
    calls.push('claim-check');
    return true;
};
antiHerding.rollbackClaimedTokens = async () => calls.push('rollback');
antiHerding.finalizeClaimedTokens = async () => calls.push('finalize');
antiHerding.releaseTokens = async () => calls.push('release');
engine.applyProposal = itinerary => itinerary.stops.map(stop => ({ ...stop }));
guideService.parseNlEdit = async () => nlEditOps;
forecast.rebuildArrivalIndex = async () => calls.push('arrival-index');
timeline.rebuildTimeline = (...args) => rebuildImpl(...args);
barrierReroute.loadClosedBarrierSnapshot = (...args) => barrierSnapshotImpl(...args);
bus.emit = (event, payload) => {
    if (event === bus.EVENTS.REROUTE_DECIDED) decisionEvents.push(payload);
};

delete require.cache[require.resolve('../../routes/itinerary')];
const router = require('../../routes/itinerary');
const currentLayer = router.stack.find(layer => layer.route?.path === '/current');
const currentHandler = currentLayer.route.stack[0].handle;
const detailLayer = router.stack.find(layer => layer.route?.path === '/:id');
const detailHandler = detailLayer.route.stack[0].handle;
const startLayer = router.stack.find(layer => layer.route?.path === '/:id/start');
const startHandler = startLayer.route.stack[0].handle;
const resumeLayer = router.stack.find(layer => layer.route?.path === '/:id/resume');
const resumeHandler = resumeLayer.route.stack[0].handle;
const decisionLayer = router.stack.find(layer =>
    layer.route?.path === '/:id/proposal/:proposalId/:decision(accept|reject)');
const decisionHandler = decisionLayer.route.stack[0].handle;
const nlEditLayer = router.stack.find(layer => layer.route?.path === '/:id/nl-edit');
const nlEditHandler = nlEditLayer.route.stack[0].handle;

test.after(() => {
    modelModule.getModels = originalGetModels;
    antiHerding.claimTokens = originals.claimTokens;
    antiHerding.claimedTokensActive = originals.claimedTokensActive;
    antiHerding.rollbackClaimedTokens = originals.rollbackClaimedTokens;
    antiHerding.finalizeClaimedTokens = originals.finalizeClaimedTokens;
    antiHerding.releaseTokens = originals.releaseTokens;
    engine.applyProposal = originals.applyProposal;
    guideService.parseNlEdit = originals.parseNlEdit;
    forecast.rebuildArrivalIndex = originals.rebuildArrivalIndex;
    timeline.rebuildTimeline = originals.rebuildTimeline;
    barrierReroute.loadClosedBarrierSnapshot = originals.loadClosedBarrierSnapshot;
    bus.emit = originals.busEmit;
});

function reset() {
    calls = [];
    updateCalls = [];
    findOneCalls = [];
    updateResult = undefined;
    rebuildArgs = null;
    decisionEvents = [];
    nlEditOps = [{ op: 'shift_time', minutes: 30 }];
    barrierSnapshotImpl = async () => ({
        barriers: [],
        edgeIds: [],
        fingerprint: 'sha256:empty'
    });
    currentItinerary = {
        _id: 'itinerary-1',
        openId: 'user-1',
        version: 4,
        state: 'active',
        rerouteCount: 0,
        savedMinutesTotal: 0,
        preferences: {},
        pendingProposal: {
            proposalId: 'proposal-1',
            type: 'replace',
            payload: {
                stopId: 'stop-1', newPoiId: 'poi-new', capacityTokenId: 'token-new',
                eventId: 'edge-event-1', edgeId: 'edge-closed', barrierFingerprint: 'barriers-v1'
            },
            gainMin: 8,
            tokenIds: ['token-new'],
            expireAt: new Date(Date.now() + 60000)
        },
        stops: [{
            _id: 'stop-1', poiId: 'poi-old', state: 'approaching',
            plannedArrive: new Date(), plannedLeave: new Date(Date.now() + 1200000),
            pathGeometry: ''
        }]
    };
    rebuildImpl = async args => {
        rebuildArgs = args;
        const { proposedStops } = args;
        calls.push('rebuild');
        return proposedStops.map(stop => ({
            ...stop,
            poiId: 'poi-new',
            capacityTokenId: 'token-new',
            state: 'approaching',
            geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
            distanceM: 80,
            durationSec: 60,
            gis: {
                source: 'iserver', mode: 'normal', degraded: false,
                requestId: 'gis-route', durationMs: 12, dataVersion: 'v1'
            },
            segments: [{ edgeId: 'edge-1', distanceM: 80, durationSec: 60 }],
            snap: { startDistanceM: 1, endDistanceM: 2 },
            pathGeometry: 'encoded-route'
        }));
    };
}

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

async function decide(decision = 'accept') {
    const req = {
        method: 'POST',
        originalUrl: `/api/itinerary/itinerary-1/proposal/proposal-1/${decision}`,
        openId: 'user-1',
        params: {
            id: 'itinerary-1', proposalId: 'proposal-1', decision
        },
        body: { version: 4 },
        app: { locals: { geosync: {
            routeBetween: injectedRouteBetween,
            dataVersion: () => 'v1'
        } } }
    };
    const res = response();
    await decisionHandler(req, res, () => {});
    return res;
}

async function startItinerary({ dataVersion = () => 'v1' } = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/itinerary-1/start',
        openId: 'user-1',
        params: { id: 'itinerary-1' },
        body: { version: currentItinerary.version },
        app: { locals: { geosync: { dataVersion } } }
    };
    const res = response();
    await startHandler(req, res, () => {});
    return res;
}

async function resumeItinerary({ dataVersion = () => 'v1' } = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/itinerary-1/resume',
        openId: 'user-1',
        params: { id: 'itinerary-1' },
        body: { version: currentItinerary.version },
        app: { locals: { geosync: { dataVersion } } }
    };
    const res = response();
    await resumeHandler(req, res, () => {});
    return res;
}

async function getCurrent() {
    const req = {
        method: 'GET',
        originalUrl: '/api/itinerary/current',
        openId: 'user-1'
    };
    const res = response();
    await currentHandler(req, res, () => {});
    return res;
}

async function getById(id = 'itinerary-1', openId = 'user-1') {
    const req = {
        method: 'GET',
        originalUrl: `/api/itinerary/${id}`,
        openId,
        params: { id }
    };
    const res = response();
    await detailHandler(req, res, () => {});
    return res;
}

async function previewNlEdit(text = '晚半小时出发') {
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/itinerary-1/nl-edit',
        openId: 'user-1',
        params: { id: 'itinerary-1' },
        body: { text, version: currentItinerary.version }
    };
    const res = response();
    await nlEditHandler(req, res, () => {});
    return res;
}

function proposalRoute({ coordinates, distanceM, durationSec }) {
    return {
        geometry: { type: 'LineString', coordinates },
        distanceM,
        durationSec,
        gis: {
            source: 'iserver', mode: 'normal', degraded: false,
            requestId: 'proposal-preview', durationMs: 9, dataVersion: 'v2'
        },
        segments: [{ edgeId: 'edge-preview', distanceM, durationSec }],
        snap: { startDistanceM: 1, endDistanceM: 2 },
        verifiedAccessible: true,
        pathGeometry: 'encoded-preview'
    };
}

test('itinerary detail returns the owner completed itinerary through the canonical serializer', async () => {
    reset();
    currentItinerary.state = 'completed';
    currentItinerary.date = '2026-08-04';
    currentItinerary.pendingProposal = null;
    currentItinerary.route = proposalRoute({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 900,
        durationSec: 600
    });

    const res = await getById();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepStrictEqual(findOneCalls, [{ _id: 'itinerary-1', openId: 'user-1' }]);
    assert.equal(res.body.data.itineraryId, 'itinerary-1');
    assert.equal(res.body.data.version, 4);
    assert.equal(res.body.data.state, 'completed');
    assert.equal(res.body.data.date, '2026-08-04');
    assert.equal(res.body.data.stops.length, 1);
    assert.equal(res.body.data.stops[0].stopId, 'stop-1');
    assert.deepStrictEqual(res.body.data.route.geometry.coordinates, [
        [118, 32], [118.001, 32.001]
    ]);
});

test('itinerary detail returns the same not-found response for another user and a missing id', async () => {
    reset();
    currentItinerary.state = 'completed';

    const crossUser = await getById('itinerary-1', 'user-2');
    const missing = await getById('507f1f77bcf86cd799439011', 'user-1');
    const malformed = await getById('malformed', 'user-1');

    for (const res of [crossUser, missing, malformed]) {
        assert.equal(res.statusCode, 404);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, 1204);
        assert.equal(res.body.data, null);
        assert.equal(res.body.message, '行程不存在');
    }
    assert.deepStrictEqual(crossUser.body, missing.body);
    assert.deepStrictEqual(crossUser.body, malformed.body);
    assert.deepStrictEqual(findOneCalls, [
        { _id: 'itinerary-1', openId: 'user-2' },
        { _id: '507f1f77bcf86cd799439011', openId: 'user-1' },
        { _id: 'malformed', openId: 'user-1' }
    ]);
});

test('current itinerary exposes an authoritative barrier proposal route preview', async () => {
    reset();
    currentItinerary.route = proposalRoute({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 900,
        durationSec: 600
    });
    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.tokenIds = [];
    currentItinerary.pendingProposal.payload = {
        eventId: 'edge-event-1',
        edgeId: 'edge-closed',
        stops: currentItinerary.stops.map(stop => ({ ...stop })),
        route: proposalRoute({
            coordinates: [[118, 32], [118.002, 32.002]],
            distanceM: 1080,
            durationSec: 720
        })
    };

    const res = await getCurrent();
    const proposal = res.body.data.pendingProposal;

    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(proposal.beforeRoute.geometry.coordinates, [
        [118, 32], [118.001, 32.001]
    ]);
    assert.deepStrictEqual(proposal.afterRoute.geometry.coordinates, [
        [118, 32], [118.002, 32.002]
    ]);
    assert.equal(proposal.beforeRoute.distanceM, 900);
    assert.equal(proposal.afterRoute.durationSec, 720);
    assert.equal(proposal.distanceDeltaM, 180);
    assert.equal(proposal.durationDeltaSec, 120);
});

test('barrier proposal preview uses the same aggregated route exposed for legacy itineraries', async () => {
    reset();
    currentItinerary.route = null;
    Object.assign(currentItinerary.stops[0], proposalRoute({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 900,
        durationSec: 600
    }));
    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.payload = {
        route: proposalRoute({
            coordinates: [[118, 32], [118.002, 32.002]],
            distanceM: 1080,
            durationSec: 720
        })
    };

    const data = (await getCurrent()).body.data;

    assert.deepStrictEqual(data.route.geometry, data.pendingProposal.beforeRoute.geometry);
    assert.equal(data.pendingProposal.distanceDeltaM, 180);
    assert.equal(data.pendingProposal.durationDeltaSec, 120);
});

test('itinerary detail endpoint rejects unauthenticated HTTP requests before data access', async t => {
    reset();
    const app = express();
    app.use('/api/itinerary', router);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/itinerary/itinerary-1`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.equal(findOneCalls.length, 0);
});

test('current itinerary omits a barrier proposal preview when its route is missing or invalid', async () => {
    reset();
    currentItinerary.route = proposalRoute({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 900,
        durationSec: 600
    });
    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.payload = { stops: [] };

    const missing = (await getCurrent()).body.data.pendingProposal;
    for (const field of ['beforeRoute', 'afterRoute', 'distanceDeltaM', 'durationDeltaSec']) {
        assert.equal(Object.hasOwn(missing, field), false);
    }

    currentItinerary.pendingProposal.payload.route = proposalRoute({
        coordinates: [[118, 32]],
        distanceM: 1080,
        durationSec: 720
    });
    const invalid = (await getCurrent()).body.data.pendingProposal;
    for (const field of ['beforeRoute', 'afterRoute', 'distanceDeltaM', 'durationDeltaSec']) {
        assert.equal(Object.hasOwn(invalid, field), false);
    }

    currentItinerary.pendingProposal.type = 'replace';
    currentItinerary.pendingProposal.payload.route = proposalRoute({
        coordinates: [[118, 32], [118.002, 32.002]],
        distanceM: 1080,
        durationSec: 720
    });
    const nonBarrier = (await getCurrent()).body.data.pendingProposal;
    for (const field of ['beforeRoute', 'afterRoute', 'distanceDeltaM', 'durationDeltaSec']) {
        assert.equal(Object.hasOwn(nonBarrier, field), false);
    }

    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.payload.route = proposalRoute({
        coordinates: [[118, 32], [118.002, 32.002]],
        distanceM: undefined,
        durationSec: undefined
    });
    const missingMetrics = (await getCurrent()).body.data.pendingProposal;
    assert.ok(missingMetrics.beforeRoute);
    assert.ok(missingMetrics.afterRoute);
    assert.equal(Object.hasOwn(missingMetrics, 'distanceDeltaM'), false);
    assert.equal(Object.hasOwn(missingMetrics, 'durationDeltaSec'), false);
});

test('barrier proposal preview never exposes raw payload data', async () => {
    reset();
    currentItinerary.route = proposalRoute({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 900,
        durationSec: 600
    });
    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.tokenIds = ['token-private-sentinel'];
    currentItinerary.pendingProposal.payload = {
        eventId: 'edge-event-1',
        barriers: [{ edgeId: 'barrier-private-sentinel' }],
        stops: [{
            ...currentItinerary.stops[0],
            capacityTokenId: 'capacity-private-sentinel'
        }],
        privateValue: 'payload-private-sentinel',
        route: {
            ...proposalRoute({
                coordinates: [[118, 32], [118.002, 32.002]],
                distanceM: 1080,
                durationSec: 720
            }),
            privateValue: 'route-private-sentinel'
        }
    };

    const proposal = (await getCurrent()).body.data.pendingProposal;
    const serialized = JSON.stringify(proposal);

    assert.equal(Object.hasOwn(proposal, 'payload'), false);
    assert.equal(Object.hasOwn(proposal, 'tokenIds'), false);
    for (const sentinel of [
        'token-private-sentinel',
        'barrier-private-sentinel',
        'capacity-private-sentinel',
        'payload-private-sentinel',
        'route-private-sentinel'
    ]) {
        assert.equal(serialized.includes(sentinel), false);
    }
});

function makeDraftWithSnapshot() {
    currentItinerary.state = 'draft';
    currentItinerary.pendingProposal = null;
    currentItinerary.stops[0].state = 'pending';
    currentItinerary.planningSnapshot = {
        barrierFingerprint: 'sha256:empty',
        barrierEdgeIds: [],
        dataVersion: 'v1',
        capturedAt: new Date(),
        invalidatedAt: null,
        invalidationReason: null
    };
}

test('draft starts only while its barrier and data-version snapshot still matches', async () => {
    reset();
    makeDraftWithSnapshot();

    const res = await startItinerary();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.state, 'active');
    assert.equal(currentItinerary.state, 'active');
    assert.equal(updateCalls.length, 1);
    assert.deepStrictEqual(updateCalls[0].filter, {
        'planningSnapshot.barrierFingerprint': 'sha256:empty',
        'planningSnapshot.dataVersion': 'v1',
        'planningSnapshot.invalidatedAt': null,
        _id: 'itinerary-1',
        version: 4,
        state: 'draft'
    });
});

test('draft is abandoned and releases tokens when barriers changed before start', async () => {
    reset();
    makeDraftWithSnapshot();
    currentItinerary.stops[0].capacityTokenId = 'token-draft';
    barrierSnapshotImpl = async () => ({
        barriers: [{
            edgeId: 'edge-closed',
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 9 }
        }],
        edgeIds: ['edge-closed'],
        fingerprint: 'sha256:changed'
    });

    const res = await startItinerary();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].update.$unset.activeOwner, 1);
    assert.equal(updateCalls[0].update.$set.pendingProposal, null);
    assert.equal(updateCalls[0].update.$set.stops[0].capacityTokenId, null);
    assert.deepStrictEqual(calls, ['cas', 'release']);
});

test('draft is abandoned when the GIS data version changed before start', async () => {
    reset();
    makeDraftWithSnapshot();

    const res = await startItinerary({ dataVersion: () => 'v2' });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
    assert.equal(updateCalls.length, 1);
});

test('legacy draft without a planning snapshot fails closed and frees the active slot', async () => {
    reset();
    currentItinerary.state = 'draft';
    currentItinerary.pendingProposal = null;
    currentItinerary.planningSnapshot = null;
    currentItinerary.stops[0].state = 'pending';
    currentItinerary.stops[0].capacityTokenId = 'token-legacy-draft';

    const res = await startItinerary();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
    assert.equal(updateCalls[0].filter.planningSnapshot, null);
    assert.equal(updateCalls[0].filter.version, 4);
    assert.deepStrictEqual(calls, ['cas', 'release']);
});

test('draft activated during a data-version change is immediately abandoned', async () => {
    reset();
    makeDraftWithSnapshot();
    currentItinerary.stops[0].capacityTokenId = 'token-start-race';
    const versions = ['v1', 'v2'];

    const res = await startItinerary({ dataVersion: () => versions.shift() || 'v2' });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0].update.$set.state, 'active');
    assert.equal(updateCalls[1].update.$set.state, 'abandoned');
    assert.deepStrictEqual(calls, ['cas', 'cas', 'release']);
});

function makePausedWithSnapshot() {
    currentItinerary.state = 'paused';
    currentItinerary.pendingProposal = null;
    currentItinerary.planningSnapshot = {
        barrierFingerprint: 'sha256:empty',
        barrierEdgeIds: [],
        dataVersion: 'v1',
        capturedAt: new Date(),
        invalidatedAt: null,
        invalidationReason: null
    };
}

test('paused itinerary resumes only while its routing snapshot remains current', async () => {
    reset();
    makePausedWithSnapshot();

    const res = await resumeItinerary();

    assert.equal(res.statusCode, 200);
    assert.equal(currentItinerary.state, 'active');
    assert.equal(currentItinerary.version, 5);
    assert.deepEqual(updateCalls[0].filter, {
        _id: 'itinerary-1',
        openId: 'user-1',
        version: 4,
        state: 'paused',
        'planningSnapshot.barrierFingerprint': 'sha256:empty',
        'planningSnapshot.dataVersion': 'v1',
        'planningSnapshot.invalidatedAt': null
    });
});

test('paused itinerary cannot resume while a barrier reroute proposal is pending', async () => {
    reset();
    makePausedWithSnapshot();
    currentItinerary.pendingProposal = {
        proposalId: 'barrier-paused',
        type: 'barrierReroute',
        payload: {},
        tokenIds: [],
        expireAt: new Date(Date.now() + 60000)
    };

    const res = await resumeItinerary();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 1205);
    assert.equal(currentItinerary.state, 'paused');
    assert.equal(updateCalls.length, 0);
});

test('paused itinerary is abandoned when its routing snapshot changed before resume', async () => {
    reset();
    makePausedWithSnapshot();
    currentItinerary.planningSnapshot.barrierFingerprint = 'sha256:stale';
    currentItinerary.planningSnapshot.barrierEdgeIds = ['edge-old'];

    const res = await resumeItinerary();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
});

test('resumed itinerary is immediately abandoned when the snapshot changes during resume', async () => {
    reset();
    makePausedWithSnapshot();
    let snapshotReads = 0;
    barrierSnapshotImpl = async () => {
        snapshotReads++;
        return snapshotReads === 1
            ? { barriers: [], edgeIds: [], fingerprint: 'sha256:empty' }
            : { barriers: [{ edgeId: 'edge-new' }], edgeIds: ['edge-new'], fingerprint: 'sha256:new' };
    };

    const res = await resumeItinerary();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 8205);
    assert.equal(currentItinerary.state, 'abandoned');
    assert.equal(updateCalls.length, 2);
});

test('paused barrier proposal acceptance preserves paused state and refreshes its snapshot', async () => {
    reset();
    makePausedWithSnapshot();
    currentItinerary.pendingProposal = {
        proposalId: 'proposal-1',
        type: 'barrierReroute',
        payload: {
            eventId: 'edge-event-1',
            edgeId: 'edge-closed',
            barrierFingerprint: 'sha256:empty'
        },
        gainMin: 0,
        tokenIds: [],
        expireAt: new Date(Date.now() + 60000)
    };

    const res = await decide();

    assert.equal(res.statusCode, 200);
    assert.equal(currentItinerary.state, 'paused');
    assert.equal(updateCalls[0].filter.state, 'paused');
    assert.equal(currentItinerary.planningSnapshot.dataVersion, 'v1');
});

test('proposal acceptance claims, rebuilds, commits, indexes, then finalizes', async () => {
    reset();
    const res = await decide();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(calls, [
        'claim', 'rebuild', 'claim-check', 'cas', 'arrival-index', 'finalize'
    ]);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].filter.openId, 'user-1');
    assert.equal(updateCalls[0].filter.version, 4);
    assert.equal(updateCalls[0].filter['pendingProposal.proposalId'], 'proposal-1');
    assert.ok(updateCalls[0].filter['pendingProposal.expireAt'].$gt instanceof Date);
    assert.equal(rebuildArgs.routeBetween, injectedRouteBetween);
    assert.equal(updateCalls[0].filter.state, 'active');
    assert.equal(updateCalls[0].update.$set.route.distanceM, 80);
    assert.equal(updateCalls[0].update.$set.route.durationSec, 60);
    assert.deepEqual(
        updateCalls[0].update.$set.route.geometry.coordinates,
        [[118, 32], [118.001, 32.001]]
    );
    assert.equal(updateCalls[0].update.$set.route.segments[0].edgeId, 'edge-1');
    assert.equal(res.body.data.route.distanceM, 80);
    assert.equal(res.body.data.stops[0].durationSec, 60);
    assert.equal(res.body.data.stops[0].pathGeometry, 'encoded-route');
    assert.deepStrictEqual(updateCalls[0].update.$push.rerouteLog, {
        at: updateCalls[0].update.$push.rerouteLog.at,
        type: 'replace',
        reason: undefined,
        savedMin: 8,
        accepted: true,
        status: 'accepted',
        proposalId: 'proposal-1',
        eventId: 'edge-event-1',
        edgeId: 'edge-closed',
        barrierFingerprint: 'barriers-v1'
    });
    assert.deepStrictEqual(decisionEvents, [{
        openId: 'user-1',
        itineraryId: 'itinerary-1',
        proposalId: 'proposal-1',
        status: 'accepted',
        accepted: true,
        version: 5,
        at: decisionEvents[0].at,
        eventId: 'edge-event-1'
    }]);
    assert.equal(new Date(decisionEvents[0].at).toISOString(), decisionEvents[0].at);
});

test('barrier acceptance reloads the current full barrier set before rebuilding and committing', async () => {
    reset();
    currentItinerary.scenicId = 'scenic-test';
    currentItinerary.pendingProposal.type = 'barrierReroute';
    currentItinerary.pendingProposal.tokenIds = [];
    currentItinerary.pendingProposal.payload = {
        eventId: 'edge-event-1',
        edgeId: 'edge-closed',
        barrierFingerprint: 'stale-fingerprint',
        barriers: [{ edgeId: 'stale-edge' }]
    };
    barrierSnapshotImpl = async ({ scenicId }) => {
        assert.equal(scenicId, 'scenic-test');
        return {
            barriers: [{
                edgeId: 'edge-closed',
                sourceRef: { datasetName: 'WalkEdge@Test', smId: 9 }
            }],
            edgeIds: ['edge-closed'],
            fingerprint: 'fresh-fingerprint'
        };
    };

    const res = await decide();

    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(rebuildArgs.routeContext, {
        barriers: [{
            edgeId: 'edge-closed',
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 9 }
        }],
        requestId: 'edge-event-1',
        eventId: 'edge-event-1',
        barrierFingerprint: 'fresh-fingerprint',
        dataVersion: 'v1'
    });
    assert.equal(updateCalls[0].update.$push.rerouteLog.status, 'accepted');
    assert.equal(updateCalls[0].update.$push.rerouteLog.barrierFingerprint, 'fresh-fingerprint');
    assert.equal(updateCalls[0].update.$set.route.segments[0].edgeId, 'edge-1');
    assert.equal(decisionEvents[0].eventId, 'edge-event-1');
});

test('aggregate route does not promote mixed verified and unknown accessibility evidence', async () => {
    reset();
    currentItinerary.stops.push({
        _id: 'stop-2', poiId: 'poi-next', state: 'pending',
        plannedArrive: new Date(), plannedLeave: new Date(Date.now() + 1200000),
        pathGeometry: ''
    });
    rebuildImpl = async ({ proposedStops }) => {
        calls.push('rebuild');
        return proposedStops.map((stop, index) => ({
            ...stop,
            geometry: {
                type: 'LineString',
                coordinates: index === 0
                    ? [[118, 32], [118.001, 32.001]]
                    : [[118.001, 32.001], [118.002, 32.002]]
            },
            distanceM: 80,
            durationSec: 60,
            gis: {
                source: 'local-fallback', mode: 'accessible', degraded: true,
                requestId: `gis-route-${index}`, durationMs: 12, dataVersion: 'v1'
            },
            segments: [{ edgeId: `edge-${index + 1}`, distanceM: 80, durationSec: 60 }],
            snap: { startDistanceM: 0, endDistanceM: 0 },
            ...(index === 0 ? { verifiedAccessible: true } : {}),
            pathGeometry: `encoded-route-${index}`
        }));
    };

    const res = await decide();

    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls[0].update.$set.route.verifiedAccessible, null);
    assert.equal(res.body.data.route.verifiedAccessible, null);
});

test('route rebuild failure rolls back the claim without writing itinerary', async () => {
    reset();
    rebuildImpl = async () => {
        calls.push('rebuild');
        throw new timeline.TimelineRebuildError('ROUTE_UNAVAILABLE', 'unavailable');
    };
    const res = await decide();

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 1205);
    assert.deepEqual(calls, ['claim', 'rebuild', 'rollback']);
    assert.equal(updateCalls.length, 0);
});

test('proposal CAS conflict rolls back the claim and leaves post-commit work untouched', async () => {
    reset();
    updateResult = null;
    const res = await decide();

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 1203);
    assert.deepEqual(calls, ['claim', 'rebuild', 'claim-check', 'cas', 'rollback']);
    assert.equal(calls.includes('arrival-index'), false);
    assert.equal(calls.includes('finalize'), false);
    assert.equal(decisionEvents.length, 0);
});

test('proposal rejection uses active-state CAS and emits committed lifecycle metadata', async () => {
    reset();
    const res = await decide('reject');

    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].filter.state, 'active');
    assert.equal(updateCalls[0].update.$push.rerouteLog.status, 'rejected');
    assert.equal(updateCalls[0].update.$push.rerouteLog.proposalId, 'proposal-1');
    assert.deepStrictEqual(decisionEvents, [{
        openId: 'user-1',
        itineraryId: 'itinerary-1',
        proposalId: 'proposal-1',
        status: 'rejected',
        accepted: false,
        version: 5,
        at: decisionEvents[0].at,
        eventId: 'edge-event-1'
    }]);
});

test('natural-language edits return an explicit preview without occupying pendingProposal', async () => {
    reset();
    currentItinerary.pendingProposal = null;
    const existingProposal = currentItinerary.pendingProposal;
    nlEditOps = [
        { op: 'shift_time', minutes: 30 },
        { op: 'set_preference', pace: 'relaxed' }
    ];

    const res = await previewNlEdit('晚半小时出发，走轻松一点');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.version, 4);
    assert.equal(res.body.data.previewOnly, true);
    assert.equal(res.body.data.applied, false);
    assert.equal(res.body.data.pendingProposal, null);
    assert.deepStrictEqual(res.body.data.preview.parsedOps, nlEditOps);
    assert.equal(res.body.data.preview.type, 'nlEdit');
    assert.equal(updateCalls.length, 0);
    assert.strictEqual(currentItinerary.pendingProposal, existingProposal);
});
