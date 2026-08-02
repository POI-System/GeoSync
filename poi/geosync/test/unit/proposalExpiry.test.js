'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { expirePendingProposals } = require('../../jobs');

const NOW = new Date('2026-08-02T09:30:00.000Z');

function clone(value) {
    return structuredClone(value);
}

function itinerary(overrides = {}) {
    return {
        _id: 'itinerary-1',
        openId: 'user-1',
        state: 'active',
        version: 3,
        rerouteLog: [],
        pendingProposal: {
            proposalId: 'proposal-1',
            type: 'barrierReroute',
            reason: 'road closed',
            gainMin: -2,
            tokenIds: ['token-1'],
            expireAt: new Date('2026-08-02T09:00:00.000Z'),
            payload: {
                eventId: 'closure-1',
                edgeId: 'edge-9',
                barrierFingerprint: 'fingerprint-1'
            }
        },
        ...overrides
    };
}

function createModel(initialDocs, options = {}) {
    const docs = initialDocs.map(clone);
    const calls = { find: [], limit: [], updates: [] };
    const order = options.order || [];

    return {
        docs,
        calls,
        order,
        find(filter) {
            calls.find.push(filter);
            const query = {
                limit(value) {
                    calls.limit.push(value);
                    return this;
                },
                async lean() {
                    return docs
                        .filter(doc => doc.state === filter.state)
                        .filter(doc => doc.pendingProposal?.expireAt <= filter['pendingProposal.expireAt'].$lte)
                        .map(clone);
                }
            };
            return query;
        },
        async findOneAndUpdate(filter, update, updateOptions) {
            order.push('cas');
            calls.updates.push({ filter, update, options: updateOptions });
            if (options.conflict) return null;
            const index = docs.findIndex(doc =>
                doc._id === filter._id
                && doc.version === filter.version
                && doc.state === filter.state
                && doc.pendingProposal?.proposalId === filter['pendingProposal.proposalId']
                && doc.pendingProposal?.expireAt <= filter['pendingProposal.expireAt'].$lte);
            if (index < 0) return null;

            const current = docs[index];
            const updated = {
                ...current,
                ...update.$set,
                version: current.version + (update.$inc?.version || 0),
                rerouteLog: [...(current.rerouteLog || []), clone(update.$push.rerouteLog)]
            };
            docs[index] = updated;
            return clone(updated);
        }
    };
}

function eventBus(order, events) {
    return {
        EVENTS: { REROUTE_DECIDED: 'reroute:decided' },
        emit(event, payload) {
            order.push('emit');
            events.push({ event, payload });
        }
    };
}

test('expiry uses the bounded active query, full CAS, atomic log update, then releases and emits', async () => {
    const order = [];
    const events = [];
    const releases = [];
    const model = createModel([itinerary()], { order });

    const result = await expirePendingProposals({
        Itinerary: model,
        clock: () => NOW,
        releaseTokens: async (tokenIds, itineraryId) => {
            order.push('release');
            releases.push({ tokenIds, itineraryId });
        },
        bus: eventBus(order, events)
    });

    assert.deepEqual(result, { scanned: 1, expired: 1 });
    assert.deepEqual(model.calls.find, [{
        state: 'active',
        'pendingProposal.expireAt': { $lte: NOW }
    }]);
    assert.deepEqual(model.calls.limit, [500]);
    assert.equal(model.calls.updates.length, 1);

    const call = model.calls.updates[0];
    assert.deepEqual(call.filter, {
        _id: 'itinerary-1',
        version: 3,
        state: 'active',
        'pendingProposal.proposalId': 'proposal-1',
        'pendingProposal.expireAt': { $lte: NOW }
    });
    assert.deepEqual(call.update.$set, { pendingProposal: null });
    assert.deepEqual(call.update.$inc, { version: 1 });
    assert.deepEqual(call.update.$push.rerouteLog, {
        at: NOW,
        type: 'barrierReroute',
        reason: 'road closed',
        savedMin: 0,
        accepted: false,
        status: 'expired',
        proposalId: 'proposal-1',
        eventId: 'closure-1',
        edgeId: 'edge-9',
        barrierFingerprint: 'fingerprint-1'
    });
    assert.deepEqual(call.options, { new: true });
    assert.deepEqual(order, ['cas', 'release', 'emit']);
    assert.deepEqual(releases, [{ tokenIds: ['token-1'], itineraryId: 'itinerary-1' }]);
    assert.deepEqual(events, [{
        event: 'reroute:decided',
        payload: {
            openId: 'user-1',
            itineraryId: 'itinerary-1',
            proposalId: 'proposal-1',
            status: 'expired',
            accepted: false,
            version: 4,
            at: NOW,
            eventId: 'closure-1'
        }
    }]);
});

test('CAS loss releases no tokens and emits no lifecycle event', async () => {
    const order = [];
    const events = [];
    let releaseCalls = 0;
    const model = createModel([itinerary()], { order, conflict: true });

    const result = await expirePendingProposals({
        Itinerary: model,
        clock: () => NOW,
        releaseTokens: async () => { releaseCalls++; },
        bus: eventBus(order, events)
    });

    assert.deepEqual(result, { scanned: 1, expired: 0 });
    assert.deepEqual(order, ['cas']);
    assert.equal(releaseCalls, 0);
    assert.deepEqual(events, []);
});

test('repeated runs are idempotent after the first durable expiry', async () => {
    const order = [];
    const events = [];
    let releaseCalls = 0;
    const model = createModel([itinerary()], { order });
    const deps = {
        Itinerary: model,
        clock: () => NOW,
        releaseTokens: async () => {
            order.push('release');
            releaseCalls++;
        },
        bus: eventBus(order, events)
    };

    const first = await expirePendingProposals(deps);
    const second = await expirePendingProposals(deps);

    assert.deepEqual(first, { scanned: 1, expired: 1 });
    assert.deepEqual(second, { scanned: 0, expired: 0 });
    assert.equal(model.calls.updates.length, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(model.docs[0].pendingProposal, null);
    assert.equal(model.docs[0].version, 4);
});

test('token-release failure is logged but does not suppress the durable expired event', async () => {
    const order = [];
    const events = [];
    const logs = [];
    const model = createModel([itinerary()], { order });

    const result = await expirePendingProposals({
        Itinerary: model,
        clock: () => NOW,
        releaseTokens: async () => {
            order.push('release');
            throw new Error('token store unavailable');
        },
        bus: eventBus(order, events),
        logger: { error: (...args) => logs.push(args.join(' ')) }
    });

    assert.deepEqual(result, { scanned: 1, expired: 1 });
    assert.deepEqual(order, ['cas', 'release', 'emit']);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.status, 'expired');
    assert.equal(events[0].payload.version, 4);
    assert.match(logs[0], /proposal token release failed/);
    assert.match(logs[0], /token store unavailable/);
});
