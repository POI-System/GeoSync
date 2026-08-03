'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');
const antiHerding = require('../../services/antiHerding');
const walkGraph = require('../../services/walkGraph');
const forecast = require('../../services/forecastService');
const memCache = require('../../lib/memCache');
const bus = require('../../lib/eventBus');

const originalGetModels = modelModule.getModels;
let modelsProvider = () => ({});
modelModule.getModels = () => modelsProvider();

const enginePath = require.resolve('../../services/geosyncEngine');
delete require.cache[enginePath];
const engine = require(enginePath);

const originals = {
    pickAlternative: antiHerding.pickAlternative,
    releaseTokens: antiHerding.releaseTokens,
    poiCoords: walkGraph.poiCoords,
    walkSecBetween: walkGraph.walkSecBetween,
    predictAtEta: forecast.predictAtEta,
    getForecast: forecast.getForecast,
    busEmit: bus.emit
};

test.after(() => {
    modelModule.getModels = originalGetModels;
    antiHerding.pickAlternative = originals.pickAlternative;
    antiHerding.releaseTokens = originals.releaseTokens;
    walkGraph.poiCoords = originals.poiCoords;
    walkGraph.walkSecBetween = originals.walkSecBetween;
    forecast.predictAtEta = originals.predictAtEta;
    forecast.getForecast = originals.getForecast;
    bus.emit = originals.busEmit;
    memCache.del('heatmap');
    delete require.cache[enginePath];
});

function leanQuery(rows) {
    return { lean: async () => rows };
}

function fixtures() {
    const target = {
        _id: 'poi-target',
        poiName: 'Crowded Viewpoint',
        category: 'viewpoint',
        geo: { coordinates: [120, 30] }
    };
    const alternate = {
        _id: 'poi-alternate',
        poiName: 'Quiet Viewpoint',
        category: 'viewpoint',
        geo: { coordinates: [120.001, 30] }
    };
    const crowdedStop = {
        _id: 'stop-target',
        poiId: target._id,
        state: 'approaching',
        plannedArrive: new Date('2026-08-03T08:30:00.000Z'),
        plannedLeave: new Date('2026-08-03T09:00:00.000Z')
    };
    return { target, alternate, crowdedStop };
}

function prepareRouting(target, alternate) {
    memCache.set('heatmap', {
        items: [
            { poiId: target._id, ci: 0.9, level: 'high', queueEstMin: 60 },
            { poiId: alternate._id, ci: 0.1, level: 'low', queueEstMin: 5 }
        ]
    });
    walkGraph.walkSecBetween = () => ({ walkSec: 60, fallback: false });
    forecast.predictAtEta = () => 0;
    forecast.getForecast = () => null;
}

function externalPoiModel(target, alternate) {
    return {
        find(filter) {
            return filter?._id?.$in ? leanQuery([target]) : leanQuery([alternate]);
        }
    };
}

function itinerary(crowdedStop, id) {
    return {
        _id: id,
        version: 7,
        rerouteCount: 0,
        preferences: { hours: 6 },
        stops: [crowdedStop]
    };
}

test('evaluate releases a token when buildReplace post-pick proposal assembly throws', async () => {
    const { target, alternate, crowdedStop } = fixtures();
    prepareRouting(target, alternate);
    const ExternalPoi = externalPoiModel(target, alternate);
    modelsProvider = () => ({ ExternalPoi });

    let alternateCoordinateReads = 0;
    walkGraph.poiCoords = poi => {
        if (poi._id === target._id) return target.geo.coordinates;
        alternateCoordinateReads++;
        if (alternateCoordinateReads === 1) return alternate.geo.coordinates;
        throw new Error('post-pick proposal assembly failed');
    };
    antiHerding.pickAlternative = async candidates => ({
        ...candidates[0],
        tokenId: 'token-held'
    });
    const releases = [];
    antiHerding.releaseTokens = async (tokenIds, itineraryId) => {
        releases.push({ tokenIds, itineraryId });
    };

    await assert.rejects(
        engine.evaluate(itinerary(crowdedStop, 'itinerary-1'), 'crowd'),
        /post-pick proposal assembly failed/
    );
    assert.deepStrictEqual(releases, [{
        tokenIds: ['token-held'],
        itineraryId: 'itinerary-1'
    }]);
});

test('evaluate releases the selected token when a later proposal persistence step throws', async () => {
    const { target, alternate, crowdedStop } = fixtures();
    prepareRouting(target, alternate);
    walkGraph.poiCoords = poi => poi.geo.coordinates;
    antiHerding.pickAlternative = async candidates => ({
        ...candidates[0],
        tokenId: 'token-selected'
    });
    const releases = [];
    antiHerding.releaseTokens = async (tokenIds, itineraryId) => {
        releases.push({ tokenIds, itineraryId });
    };

    const ExternalPoi = externalPoiModel(target, alternate);
    let modelReads = 0;
    modelsProvider = () => {
        modelReads++;
        if (modelReads === 3) throw new Error('post-selection persistence setup failed');
        return { ExternalPoi };
    };

    await assert.rejects(
        engine.evaluate(itinerary(crowdedStop, 'itinerary-2'), 'crowd'),
        /post-selection persistence setup failed/
    );
    assert.deepStrictEqual(releases, [{
        tokenIds: ['token-selected'],
        itineraryId: 'itinerary-2'
    }]);
});

test('evaluate releases the selected token when the pendingProposal CAS loses', async () => {
    const { target, alternate, crowdedStop } = fixtures();
    prepareRouting(target, alternate);
    walkGraph.poiCoords = poi => poi.geo.coordinates;
    antiHerding.pickAlternative = async candidates => ({
        ...candidates[0],
        tokenId: 'token-cas-lost'
    });
    const releases = [];
    antiHerding.releaseTokens = async (tokenIds, itineraryId) => {
        releases.push({ tokenIds, itineraryId });
    };
    const ExternalPoi = externalPoiModel(target, alternate);
    const Itinerary = { findOneAndUpdate: async () => null };
    modelsProvider = () => ({ ExternalPoi, Itinerary });

    const result = await engine.evaluate(itinerary(crowdedStop, 'itinerary-cas-lost'), 'crowd');

    assert.equal(result, undefined);
    assert.deepStrictEqual(releases, [{
        tokenIds: ['token-cas-lost'],
        itineraryId: 'itinerary-cas-lost'
    }]);
});

test('evaluate transfers the selected token only after pendingProposal persistence succeeds', async () => {
    const { target, alternate, crowdedStop } = fixtures();
    prepareRouting(target, alternate);
    walkGraph.poiCoords = poi => poi.geo.coordinates;
    antiHerding.pickAlternative = async candidates => ({
        ...candidates[0],
        tokenId: 'token-persisted'
    });
    const releases = [];
    antiHerding.releaseTokens = async (tokenIds, itineraryId) => {
        releases.push({ tokenIds, itineraryId });
    };
    const emitted = [];
    bus.emit = (event, payload) => emitted.push({ event, payload });
    const ExternalPoi = externalPoiModel(target, alternate);
    let persistedProposal;
    const Itinerary = {
        async findOneAndUpdate(filter, update) {
            persistedProposal = update.$set.pendingProposal;
            return {
                ...itinerary(crowdedStop, 'itinerary-persisted'),
                version: 8,
                pendingProposal: persistedProposal
            };
        }
    };
    modelsProvider = () => ({ ExternalPoi, Itinerary });

    await engine.evaluate(itinerary(crowdedStop, 'itinerary-persisted'), 'crowd');

    assert.deepStrictEqual(releases, []);
    assert.deepStrictEqual(persistedProposal.tokenIds, ['token-persisted']);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, bus.EVENTS.REROUTE_PROPOSED);
    assert.strictEqual(emitted[0].payload.proposal, persistedProposal);
});

test('nlEdit is preview-only and is not an applicable engine proposal type', () => {
    const stop = {
        _id: 'stop-1',
        poiId: 'poi-1',
        state: 'pending',
        plannedArrive: new Date('2026-08-03T08:00:00.000Z'),
        plannedLeave: new Date('2026-08-03T08:30:00.000Z')
    };
    assert.equal(engine.applyProposal({ stops: [stop] }, {
        type: 'nlEdit',
        payload: { ops: [{ op: 'shift_time', minutes: 30 }] }
    }), null);
});
