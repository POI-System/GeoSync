'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
let activeCapacityToken;
const originalGetModels = models.getModels;
models.getModels = () => ({ CapacityToken: activeCapacityToken });

const antiHerding = require('../../services/antiHerding');

test.after(() => {
    models.getModels = originalGetModels;
});

function sameValue(left, right) {
    if (left instanceof Date || right instanceof Date) {
        return new Date(left).getTime() === new Date(right).getTime();
    }
    return String(left) === String(right);
}

function compareValue(left, right) {
    const a = left instanceof Date || right instanceof Date ? new Date(left).getTime() : left;
    const b = left instanceof Date || right instanceof Date ? new Date(right).getTime() : right;
    return { a, b };
}

function matchesCondition(value, condition) {
    if (!condition || typeof condition !== 'object' || condition instanceof Date) {
        return sameValue(value, condition);
    }
    if ('$in' in condition && !condition.$in.some(item => sameValue(value, item))) return false;
    if ('$exists' in condition && (value !== undefined) !== Boolean(condition.$exists)) return false;
    if ('$gt' in condition) {
        const { a, b } = compareValue(value, condition.$gt);
        if (!(a > b)) return false;
    }
    if ('$lte' in condition) {
        const { a, b } = compareValue(value, condition.$lte);
        if (!(a <= b)) return false;
    }
    return true;
}

function matches(document, query) {
    return Object.entries(query).every(([field, condition]) =>
        matchesCondition(document[field], condition));
}

function applyUpdate(document, update) {
    let changed = false;
    for (const [field, value] of Object.entries(update.$set || {})) {
        if (!sameValue(document[field], value)) {
            document[field] = value;
            changed = true;
        }
    }
    for (const [field, value] of Object.entries(update.$max || {})) {
        if (document[field] == null || compareValue(document[field], value).a <
            compareValue(document[field], value).b) {
            document[field] = value;
            changed = true;
        }
    }
    for (const field of Object.keys(update.$unset || {})) {
        if (field in document) {
            delete document[field];
            changed = true;
        }
    }
    return changed;
}

function createFakeCapacityToken(seed = []) {
    let nextId = 1;
    const documents = seed.map(document => ({ ...document }));

    const model = {
        documents,

        async countDocuments(query) {
            return documents.filter(document => matches(document, query)).length;
        },

        async deleteMany(query) {
            let deletedCount = 0;
            for (let i = documents.length - 1; i >= 0; i--) {
                if (!matches(documents[i], query)) continue;
                documents.splice(i, 1);
                deletedCount++;
            }
            return { deletedCount };
        },

        async create(document) {
            await new Promise(resolve => setImmediate(resolve));
            const duplicate = document.capacitySlot !== undefined && documents.some(existing =>
                existing.capacitySlot !== undefined &&
                sameValue(existing.scenicId, document.scenicId) &&
                sameValue(existing.poiId, document.poiId) &&
                sameValue(existing.timeSlot, document.timeSlot) &&
                existing.capacitySlot === document.capacitySlot);
            if (duplicate) {
                const error = new Error('duplicate capacity slot');
                error.code = 11000;
                throw error;
            }
            const created = { ...document, _id: document._id || `token-${nextId++}` };
            documents.push(created);
            return created;
        },

        async updateMany(query, update) {
            let matchedCount = 0;
            let modifiedCount = 0;
            for (const document of documents) {
                if (!matches(document, query)) continue;
                matchedCount++;
                if (applyUpdate(document, update)) modifiedCount++;
            }
            return { matchedCount, modifiedCount };
        },

        async find(query) {
            return documents.filter(document => matches(document, query));
        },

        async updateOne(query, update) {
            const document = documents.find(item => matches(item, query));
            if (!document) return { matchedCount: 0, modifiedCount: 0 };
            return {
                matchedCount: 1,
                modifiedCount: applyUpdate(document, update) ? 1 : 0
            };
        }
    };

    return model;
}

test('recommendationLimit uses one occupancy unit and clamps invalid deficits', () => {
    assert.equal(antiHerding.recommendationLimit({
        comfortCapacity: 50,
        currentOccupancy: 17,
        naturalInflow: 8
    }), 25);
    assert.equal(antiHerding.recommendationLimit({
        comfortCapacity: '12.8',
        currentOccupancy: '2.2',
        naturalInflow: 1
    }), 9);
    assert.equal(antiHerding.recommendationLimit({
        comfortCapacity: 5,
        currentOccupancy: 8,
        naturalInflow: 3
    }), 0);
    assert.equal(antiHerding.recommendationLimit({
        comfortCapacity: -10,
        currentOccupancy: -2,
        naturalInflow: -1
    }), 0);
});

test('slotSequence visits every slot once from a wrapped start', () => {
    assert.deepEqual(antiHerding.slotSequence(4, 2), [2, 3, 0, 1]);
    assert.deepEqual(antiHerding.slotSequence(4, -1), [3, 0, 1, 2]);
    assert.deepEqual(antiHerding.slotSequence(1, 20), [0]);
    assert.deepEqual(antiHerding.slotSequence(0, 0), []);
    assert.deepEqual(antiHerding.slotSequence(2.5, 0), []);
});

test('concurrent holdToken calls cannot claim more unique slots than the limit', async () => {
    const CapacityToken = createFakeCapacityToken();
    const now = new Date('2026-07-21T02:00:00.000Z');
    const candidate = {
        poi: { _id: 'poi-a' },
        etaSlot: '2026-07-21T10:30',
        targetTime: new Date('2026-07-21T02:30:00.000Z'),
        holdUntil: new Date('2026-07-21T02:10:00.000Z'),
        gain: 12,
        reservationLimit: 4
    };

    const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        antiHerding.holdToken(candidate, `itinerary-${index}`, {
            CapacityToken,
            now,
            slotStart: index
        })));

    const held = results.filter(Boolean);
    assert.equal(held.length, 4);
    assert.equal(CapacityToken.documents.length, 4);
    assert.deepEqual(
        CapacityToken.documents.map(token => token.capacitySlot).sort((a, b) => a - b),
        [0, 1, 2, 3]
    );
    assert.equal(new Set(held.map(result => String(result.tokenId))).size, 4);
});

test('holdToken does not delete an in-flight claim after its original hold expires', async () => {
    const now = new Date('2026-07-21T02:00:00.000Z');
    const CapacityToken = createFakeCapacityToken([{
        _id: 'claimed', scenicId: 'default', poiId: 'poi-a',
        timeSlot: '2026-07-21T10:30', state: 'claiming', capacitySlot: 0,
        holdUntil: new Date('2026-07-21T01:59:00.000Z'),
        claimUntil: new Date('2026-07-21T02:01:00.000Z')
    }]);
    const result = await antiHerding.holdToken({
        poi: { _id: 'poi-a' }, etaSlot: '2026-07-21T10:30',
        targetTime: new Date('2026-07-21T02:30:00.000Z'),
        gain: 10, reservationLimit: 1
    }, 'itinerary-2', { CapacityToken, now, slotStart: 0 });

    assert.strictEqual(result, null);
    assert.strictEqual(CapacityToken.documents.length, 1);
    assert.strictEqual(CapacityToken.documents[0].state, 'claiming');
});

test('a lower live limit counts occupied slots outside the new slot range', async () => {
    const now = new Date('2026-07-21T02:00:00.000Z');
    const CapacityToken = createFakeCapacityToken([{
        _id: 'old-high-slot', scenicId: 'default', poiId: 'poi-a',
        timeSlot: '2026-07-21T10:30', state: 'held', capacitySlot: 4,
        holdUntil: new Date('2026-07-21T02:10:00.000Z')
    }]);
    const candidate = {
        poi: { _id: 'poi-a', visitMeta: { comfortCapacity: 2 } },
        etaSlot: '2026-07-21T10:30',
        targetTime: new Date('2026-07-21T02:30:00.000Z'),
        gain: 10, reservationLimit: 2
    };

    const results = await Promise.all([
        antiHerding.holdToken(candidate, 'itinerary-1', { CapacityToken, now }),
        antiHerding.holdToken(candidate, 'itinerary-2', { CapacityToken, now })
    ]);

    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual(CapacityToken.documents.length, 2);
});

test('claim, rollback, and finalize complete a successful token lifecycle', async () => {
    const now = new Date('2026-07-21T02:00:00.000Z');
    const targetA = new Date('2026-07-21T03:00:00.000Z');
    const targetB = new Date('2026-07-21T03:10:00.000Z');
    activeCapacityToken = createFakeCapacityToken([
        {
            _id: 'a', holderItineraryId: 'itinerary-1', state: 'held', capacitySlot: 0,
            holdUntil: new Date('2026-07-21T02:10:00.000Z'), targetAt: targetA
        },
        {
            _id: 'b', holderItineraryId: 'itinerary-1', state: 'held', capacitySlot: 1,
            holdUntil: new Date('2026-07-21T02:10:00.000Z'), targetAt: targetB
        }
    ]);

    assert.equal(await antiHerding.claimTokens(['a', 'b'], 'itinerary-1', now), true);
    assert.deepEqual(activeCapacityToken.documents.map(token => token.state), ['claiming', 'claiming']);

    await antiHerding.rollbackClaimedTokens(['a', 'b'], 'itinerary-1');
    assert.deepEqual(activeCapacityToken.documents.map(token => token.state), ['held', 'held']);

    assert.equal(await antiHerding.claimTokens(['a', 'b'], 'itinerary-1', now), true);
    await antiHerding.finalizeClaimedTokens(['a', 'b'], 'itinerary-1');

    assert.deepEqual(activeCapacityToken.documents.map(token => token.state), ['confirmed', 'confirmed']);
    assert.equal(activeCapacityToken.documents[0].capacitySlot, undefined);
    assert.equal(activeCapacityToken.documents[1].capacitySlot, undefined);
    assert.equal(activeCapacityToken.documents[0].expireAt.getTime(), targetA.getTime() + 2 * 3600000);
    assert.equal(activeCapacityToken.documents[1].expireAt.getTime(), targetB.getTime() + 2 * 3600000);
});

test('claim rolls back every partial match when another token is expired', async () => {
    const now = new Date('2026-07-21T02:00:00.000Z');
    activeCapacityToken = createFakeCapacityToken([
        {
            _id: 'valid', holderItineraryId: 'itinerary-1', state: 'held',
            holdUntil: new Date('2026-07-21T02:10:00.000Z')
        },
        {
            _id: 'expired', holderItineraryId: 'itinerary-1', state: 'held',
            holdUntil: new Date('2026-07-21T01:59:59.000Z')
        }
    ]);

    assert.equal(await antiHerding.claimTokens(
        ['valid', 'expired'], 'itinerary-1', now), false);
    assert.equal(activeCapacityToken.documents.find(token => token._id === 'valid').state, 'held');
    assert.equal(activeCapacityToken.documents.find(token => token._id === 'expired').state, 'held');
    assert.equal(activeCapacityToken.documents.some(token => token.state === 'claiming'), false);
});

test('a failed concurrent claim cannot roll back another request claim', async () => {
    const now = new Date('2026-07-21T02:00:00.000Z');
    activeCapacityToken = createFakeCapacityToken([{
        _id: 'only-token', holderItineraryId: 'itinerary-1', state: 'held',
        holdUntil: new Date('2026-07-21T02:10:00.000Z')
    }]);

    assert.equal(await antiHerding.claimTokens(
        ['only-token'], 'itinerary-1', now, 'claim-a'), true);
    assert.equal(await antiHerding.claimTokens(
        ['only-token'], 'itinerary-1', now, 'claim-b'), false);
    assert.equal(activeCapacityToken.documents[0].state, 'claiming');
    assert.equal(activeCapacityToken.documents[0].claimId, 'claim-a');

    await antiHerding.rollbackClaimedTokens(
        ['only-token'], 'itinerary-1', 'claim-b');
    assert.equal(activeCapacityToken.documents[0].state, 'claiming');
    await antiHerding.rollbackClaimedTokens(
        ['only-token'], 'itinerary-1', 'claim-a');
    assert.equal(activeCapacityToken.documents[0].state, 'held');
});

test('rollback and finalize only mutate claiming tokens owned by the itinerary', async () => {
    const targetAt = new Date('2026-07-21T03:00:00.000Z');
    activeCapacityToken = createFakeCapacityToken([
        {
            _id: 'owned-claim', holderItineraryId: 'itinerary-1', state: 'claiming',
            capacitySlot: 0, targetAt
        },
        {
            _id: 'owned-held', holderItineraryId: 'itinerary-1', state: 'held',
            capacitySlot: 1, targetAt
        },
        {
            _id: 'other-claim', holderItineraryId: 'itinerary-2', state: 'claiming',
            capacitySlot: 2, targetAt
        }
    ]);

    await antiHerding.finalizeClaimedTokens(
        ['owned-claim', 'owned-held', 'other-claim'], 'itinerary-1');
    assert.equal(activeCapacityToken.documents[0].state, 'confirmed');
    assert.equal(activeCapacityToken.documents[0].capacitySlot, undefined);
    assert.equal(activeCapacityToken.documents[1].state, 'held');
    assert.equal(activeCapacityToken.documents[2].state, 'claiming');

    await antiHerding.rollbackClaimedTokens(
        ['owned-claim', 'owned-held', 'other-claim'], 'itinerary-2');
    assert.equal(activeCapacityToken.documents[0].state, 'confirmed');
    assert.equal(activeCapacityToken.documents[1].state, 'held');
    assert.equal(activeCapacityToken.documents[2].state, 'held');
});
