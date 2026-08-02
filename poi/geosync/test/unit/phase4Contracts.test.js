'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const modelModule = require('../../models');
const bus = require('../../lib/eventBus');

test('Phase 4 model and event contracts are registered', () => {
    const isolatedMongoose = new mongoose.Mongoose();
    const models = modelModule.registerModels(isolatedMongoose);
    const itinerarySchema = models.Itinerary.schema;
    const pendingType = itinerarySchema.path('pendingProposal').schema.path('type');
    const rerouteLog = itinerarySchema.path('rerouteLog').schema;

    assert.ok(pendingType.options.enum.includes('barrierReroute'));
    for (const field of [
        'proposalId', 'eventId', 'edgeId', 'barrierFingerprint', 'status', 'accepted'
    ]) {
        assert.ok(rerouteLog.path(field), `missing rerouteLog.${field}`);
    }
    assert.deepStrictEqual(rerouteLog.path('status').options.enum, [
        'shown', 'accepted', 'rejected', 'expired', 'failed'
    ]);
    assert.ok(itinerarySchema.indexes().some(([keys]) =>
        keys.scenicId === 1 && keys.state === 1 && keys['route.segments.edgeId'] === 1));
    assert.ok(models.WalkEdge.schema.indexes().some(([keys]) =>
        keys.scenicId === 1 && keys.status === 1));

    assert.equal(bus.EVENTS.OPS_IMPACT, 'ops:impact');
    assert.equal(bus.EVENTS.OPS_PROPOSAL_STATUS, 'ops:proposalStatus');
});

test('event bus subscriptions can be removed without leaking duplicate handlers', async () => {
    let calls = 0;
    const unsubscribe = bus.on(bus.EVENTS.OPS_IMPACT, () => { calls++; });
    assert.equal(typeof unsubscribe, 'function');

    bus.emit(bus.EVENTS.OPS_IMPACT, { eventId: 'impact-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);

    unsubscribe();
    bus.emit(bus.EVENTS.OPS_IMPACT, { eventId: 'impact-2' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
});
