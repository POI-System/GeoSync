'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    EVENT_TYPES,
    reduceItinerary,
    createItineraryRuntime,
    reconcilePresence
} = require('../../services/itineraryRuntime');

function applyReduction(itinerary, reduced) {
    return {
        ...itinerary,
        state: reduced.state,
        stops: reduced.stops,
        pendingProposal: reduced.clearPendingProposal ? null : itinerary.pendingProposal
    };
}

function matches(doc, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        const actual = doc[key];
        if (expected && typeof expected === 'object' && '$in' in expected) {
            return expected.$in.includes(actual);
        }
        return String(actual) === String(expected);
    });
}

class FakeItineraryModel {
    constructor(doc, casConflicts = 0) {
        this.doc = structuredClone(doc);
        this.casConflicts = casConflicts;
        this.casCalls = 0;
    }

    findOne(filter) {
        const value = matches(this.doc, filter) ? structuredClone(this.doc) : null;
        return { lean: async () => value };
    }

    find(filter) {
        const values = matches(this.doc, filter) ? [structuredClone(this.doc)] : [];
        return {
            limit() { return this; },
            async lean() { return values; }
        };
    }

    async findOneAndUpdate(filter, update) {
        this.casCalls++;
        if (this.casConflicts > 0) {
            this.casConflicts--;
            this.doc.version++;
            return null;
        }
        if (!matches(this.doc, filter)) return null;
        Object.assign(this.doc, structuredClone(update.$set));
        this.doc.version += update.$inc?.version || 0;
        return structuredClone(this.doc);
    }
}

test('START activates a draft and selects exactly one approaching stop', () => {
    const itinerary = {
        state: 'draft',
        stops: [
            { _id: 's0', poiId: 'p0', state: 'skipped' },
            { _id: 's1', poiId: 'p1', state: 'pending' },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };

    const first = reduceItinerary(itinerary, { type: EVENT_TYPES.START });
    assert.equal(first.changed, true);
    assert.equal(first.state, 'active');
    assert.deepEqual(first.stops.map(stop => stop.state), ['skipped', 'approaching', 'pending']);
    assert.equal(itinerary.state, 'draft');
    assert.equal(itinerary.stops[1].state, 'pending');

    const second = reduceItinerary(applyReduction(itinerary, first), { type: EVENT_TYPES.START });
    assert.equal(second.changed, false);
});

test('STAY events advance the current stop and are idempotent', () => {
    const enterAt = new Date('2026-07-21T01:00:00.000Z');
    const leaveAt = new Date('2026-07-21T01:20:00.000Z');
    let itinerary = {
        state: 'active',
        pendingProposal: { proposalId: 'proposal-1', tokenIds: ['proposal-token'] },
        stops: [
            {
                _id: 's1', poiId: 'p1', state: 'approaching',
                capacityTokenId: 'arrival-token'
            },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };

    const opened = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_OPENED, poiId: 'p1', at: enterAt
    });
    assert.equal(opened.stops[0].state, 'arrived');
    assert.deepEqual(opened.stops[0].actualArrive, enterAt);
    assert.equal(opened.stops[0].capacityTokenId, null);
    assert.equal(opened.clearPendingProposal, true);
    assert.deepEqual(opened.releaseTokenIds, ['arrival-token', 'proposal-token']);
    itinerary = applyReduction(itinerary, opened);

    const duplicateOpen = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_OPENED, poiId: 'p1', at: new Date(enterAt.getTime() + 1000)
    });
    assert.equal(duplicateOpen.changed, false);

    const closed = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_CLOSED, poiId: 'p1', at: leaveAt
    });
    assert.deepEqual(closed.stops.map(stop => stop.state), ['done', 'approaching']);
    assert.deepEqual(closed.stops[0].actualLeave, leaveAt);
    itinerary = applyReduction(itinerary, closed);

    const duplicateClose = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_CLOSED, poiId: 'p1', at: new Date(leaveAt.getTime() + 1000)
    });
    assert.equal(duplicateClose.changed, false);

    const reopenDone = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_OPENED, poiId: 'p1', at: new Date(leaveAt.getTime() + 2000)
    });
    assert.equal(reopenDone.changed, false);
    assert.equal(reopenDone.stops[0].state, 'done');
});

test('STAY_OPENED does not jump to a future stop', () => {
    const itinerary = {
        state: 'active',
        stops: [
            { _id: 's1', poiId: 'p1', state: 'approaching' },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };
    const reduced = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_OPENED,
        poiId: 'p2',
        at: new Date('2026-07-21T01:00:00.000Z')
    });
    assert.equal(reduced.changed, false);
    assert.deepEqual(reduced.stops.map(stop => stop.state), ['approaching', 'pending']);
});

test('STAY events keep progressing stops while the itinerary is paused', () => {
    const paused = {
        state: 'paused',
        stops: [
            { _id: 's1', poiId: 'p1', state: 'approaching' },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };
    const opened = reduceItinerary(paused, {
        type: EVENT_TYPES.STAY_OPENED,
        poiId: 'p1',
        at: new Date('2026-07-21T01:00:00.000Z')
    });
    assert.strictEqual(opened.state, 'paused');
    assert.strictEqual(opened.stops[0].state, 'arrived');

    const closed = reduceItinerary(applyReduction(paused, opened), {
        type: EVENT_TYPES.STAY_CLOSED,
        poiId: 'p1',
        at: new Date('2026-07-21T01:20:00.000Z')
    });
    assert.strictEqual(closed.state, 'paused');
    assert.deepStrictEqual(closed.stops.map(stop => stop.state), ['done', 'approaching']);
});

test('out-of-order STAY_OPENED is a no-op even when an active legacy itinerary has no current stop', () => {
    const itinerary = {
        state: 'active',
        stops: [
            { _id: 's1', poiId: 'p1', state: 'pending' },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };
    const reduced = reduceItinerary(itinerary, {
        type: EVENT_TYPES.STAY_OPENED,
        poiId: 'p2',
        at: new Date('2026-07-21T01:00:00.000Z')
    });
    assert.equal(reduced.changed, false);
    assert.deepEqual(reduced.stops.map(stop => stop.state), ['pending', 'pending']);
});

test('terminal itinerary and stop states never regress', () => {
    const completed = {
        state: 'completed',
        stops: [{ _id: 's1', poiId: 'p1', state: 'done' }]
    };
    const startCompleted = reduceItinerary(completed, { type: EVENT_TYPES.START });
    assert.equal(startCompleted.changed, false);
    assert.equal(startCompleted.state, 'completed');

    const active = {
        state: 'active',
        stops: [
            { _id: 's1', poiId: 'p1', state: 'done' },
            { _id: 's2', poiId: 'p2', state: 'skipped' },
            { _id: 's3', poiId: 'p3', state: 'rerouted' },
            { _id: 's4', poiId: 'p4', state: 'approaching' }
        ]
    };
    for (const stopId of ['s1', 's2', 's3']) {
        const skipped = reduceItinerary(active, { type: EVENT_TYPES.SKIP, stopId });
        assert.equal(skipped.changed, false);
        assert.deepEqual(
            skipped.stops.slice(0, 3).map(stop => stop.state),
            ['done', 'skipped', 'rerouted']
        );
    }
});

test('SKIP advances the next stop and returns unique token ids to release', () => {
    const itinerary = {
        state: 'active',
        pendingProposal: {
            proposalId: 'proposal-1',
            tokenIds: ['proposal-token', 'stop-token']
        },
        stops: [
            {
                _id: 's1', poiId: 'p1', state: 'approaching',
                capacityTokenId: 'stop-token'
            },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    };

    const reduced = reduceItinerary(itinerary, {
        type: EVENT_TYPES.SKIP, stopId: 's1'
    });
    assert.deepEqual(reduced.stops.map(stop => stop.state), ['skipped', 'approaching']);
    assert.equal(reduced.stops[0].capacityTokenId, null);
    assert.equal(reduced.clearPendingProposal, true);
    assert.deepEqual(reduced.releaseTokenIds, ['stop-token', 'proposal-token']);

    const duplicate = reduceItinerary(applyReduction(itinerary, reduced), {
        type: EVENT_TYPES.SKIP, stopId: 's1'
    });
    assert.equal(duplicate.changed, false);
    assert.deepEqual(duplicate.releaseTokenIds, []);
});

test('runtime wrapper retries one _id+version+state CAS conflict', async () => {
    const model = new FakeItineraryModel({
        _id: 'it-1', openId: 'user-1', version: 1, state: 'active',
        pendingProposal: { proposalId: 'proposal-1', tokenIds: ['token-1'] },
        stops: [{ _id: 's1', poiId: 'p1', state: 'approaching' }]
    }, 1);
    const releases = [];
    const runtime = createItineraryRuntime({
        Itinerary: model,
        onReleaseTokens: async (ids, context) => releases.push({ ids, context })
    });

    const result = await runtime.stayOpened({
        openId: 'user-1', poiId: 'p1', at: new Date('2026-07-21T01:00:00.000Z')
    });

    assert.equal(result.status, 'updated');
    assert.equal(result.attempts, 2);
    assert.equal(result.version, 3);
    assert.equal(model.casCalls, 2);
    assert.equal(model.doc.stops[0].state, 'arrived');
    assert.equal(model.doc.pendingProposal, null);
    assert.deepEqual(result.releaseTokenIds, ['token-1']);
    assert.equal(releases.length, 1);
    assert.deepEqual(releases[0].ids, ['token-1']);
    assert.equal(releases[0].context.invalidatedProposalId, 'proposal-1');
});

test('route-facing expectedVersion remains authoritative after a concurrent change', async () => {
    const model = new FakeItineraryModel({
        _id: 'it-1', openId: 'user-1', version: 2, state: 'draft',
        pendingProposal: null,
        stops: [{ _id: 's1', poiId: 'p1', state: 'pending' }]
    });
    const runtime = createItineraryRuntime({ Itinerary: model });

    const stale = await runtime.start({
        itineraryId: 'it-1', openId: 'user-1', version: 1
    });
    assert.equal(stale.status, 'conflict');
    assert.equal(model.casCalls, 0);
    assert.equal(model.doc.state, 'draft');

    const started = await runtime.start({
        itineraryId: 'it-1', openId: 'user-1', version: 2
    });
    assert.equal(started.status, 'updated');
    assert.equal(started.version, 3);
    assert.equal(model.doc.state, 'active');
    assert.equal(model.doc.stops[0].state, 'approaching');
});

test('presence reconciliation replays a closed durable sample after an event loss', async () => {
    const model = new FakeItineraryModel({
        _id: 'it-1', openId: 'user-1', version: 1, state: 'active',
        createTime: new Date('2026-07-21T00:00:00.000Z'),
        stops: [
            { _id: 's1', poiId: 'p1', state: 'approaching' },
            { _id: 's2', poiId: 'p2', state: 'pending' }
        ]
    });
    const sample = {
        enterAt: new Date('2026-07-21T01:00:00.000Z'),
        leaveAt: new Date('2026-07-21T01:20:00.000Z')
    };
    const StaySample = {
        findOne() {
            return {
                sort() { return this; },
                async lean() { return sample; }
            };
        }
    };

    const result = await reconcilePresence({
        Itinerary: model,
        StaySample,
        hmacSecret: 'test-secret',
        now: new Date('2026-07-21T01:21:00.000Z')
    });

    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(model.doc.version, 3);
    assert.deepStrictEqual(model.doc.stops.map(stop => stop.state), ['done', 'approaching']);
    assert.strictEqual(
        new Date(model.doc.stops[0].actualArrive).toISOString(), sample.enterAt.toISOString());
    assert.strictEqual(
        new Date(model.doc.stops[0].actualLeave).toISOString(), sample.leaveAt.toISOString());
});
