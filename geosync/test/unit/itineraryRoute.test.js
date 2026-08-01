'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');

let currentItinerary;
let updateResult;
let updateCalls;
let calls;
let rebuildImpl;

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
modelModule.getModels = () => ({ Itinerary, ExternalPoi, PhotoSpot: {} });

const antiHerding = require('../../services/antiHerding');
const engine = require('../../services/geosyncEngine');
const forecast = require('../../services/forecastService');
const timeline = require('../../services/itineraryTimeline');

const originals = {
    claimTokens: antiHerding.claimTokens,
    claimedTokensActive: antiHerding.claimedTokensActive,
    rollbackClaimedTokens: antiHerding.rollbackClaimedTokens,
    finalizeClaimedTokens: antiHerding.finalizeClaimedTokens,
    releaseTokens: antiHerding.releaseTokens,
    applyProposal: engine.applyProposal,
    rebuildArrivalIndex: forecast.rebuildArrivalIndex,
    rebuildTimeline: timeline.rebuildTimeline
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
forecast.rebuildArrivalIndex = async () => calls.push('arrival-index');
timeline.rebuildTimeline = (...args) => rebuildImpl(...args);

delete require.cache[require.resolve('../../routes/itinerary')];
const router = require('../../routes/itinerary');
const decisionLayer = router.stack.find(layer =>
    layer.route?.path === '/:id/proposal/:proposalId/:decision(accept|reject)');
const decisionHandler = decisionLayer.route.stack[0].handle;

test.after(() => {
    modelModule.getModels = originalGetModels;
    antiHerding.claimTokens = originals.claimTokens;
    antiHerding.claimedTokensActive = originals.claimedTokensActive;
    antiHerding.rollbackClaimedTokens = originals.rollbackClaimedTokens;
    antiHerding.finalizeClaimedTokens = originals.finalizeClaimedTokens;
    antiHerding.releaseTokens = originals.releaseTokens;
    engine.applyProposal = originals.applyProposal;
    forecast.rebuildArrivalIndex = originals.rebuildArrivalIndex;
    timeline.rebuildTimeline = originals.rebuildTimeline;
});

function reset() {
    calls = [];
    updateCalls = [];
    updateResult = undefined;
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
            payload: { stopId: 'stop-1', newPoiId: 'poi-new', capacityTokenId: 'token-new' },
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
    rebuildImpl = async ({ proposedStops }) => {
        calls.push('rebuild');
        return proposedStops.map(stop => ({
            ...stop,
            poiId: 'poi-new',
            capacityTokenId: 'token-new',
            state: 'approaching'
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

async function decide() {
    const req = {
        method: 'POST',
        originalUrl: '/api/itinerary/itinerary-1/proposal/proposal-1/accept',
        openId: 'user-1',
        params: {
            id: 'itinerary-1', proposalId: 'proposal-1', decision: 'accept'
        },
        body: { version: 4 }
    };
    const res = response();
    await decisionHandler(req, res, () => {});
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
});
