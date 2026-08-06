'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');
const bus = require('../../lib/eventBus');
const barrierReroute = require('../../services/barrierReroute');

let currentItinerary;
let updateResult;
let updateCalls;
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
    gis: { source: 'iserver', mode: 'normal', degraded: false }
});

const Itinerary = {
    async findOne() {
        return currentItinerary;
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
        app: { locals: { geosync: { routeBetween: injectedRouteBetween } } }
    };
    const res = response();
    await decisionHandler(req, res, () => {});
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
        barrierFingerprint: 'fresh-fingerprint'
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
