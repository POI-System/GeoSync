'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ALLOWED_PROPOSAL_STATUSES,
    normalizeImpact,
    normalizeProposalStatus,
    bindOpsEvents
} = require('../../services/opsEvents');

function fakeBus() {
    const handlers = new Map();
    return {
        EVENTS: {
            OPS_IMPACT: 'ops:impact',
            OPS_PROPOSAL_STATUS: 'ops:proposalStatus'
        },
        on(event, handler) {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        },
        async publish(event, payload) {
            await handlers.get(event)?.(payload);
        },
        handlers
    };
}

function fakeIo() {
    const emissions = [];
    return {
        emissions,
        to(room) {
            return {
                emit(event, payload) { emissions.push({ room, event, payload }); }
            };
        }
    };
}

test('normalizes the exact impact and proposal-status contracts', () => {
    assert.deepStrictEqual(normalizeImpact({
        eventId: 'event-1', edgeId: 'edge-1', affectedItineraries: 3,
        proposalsCreated: 2, failed: 1, completedAt: '2026-08-02T12:00:00.000Z'
    }), {
        eventId: 'event-1', edgeId: 'edge-1', affectedItineraries: 3,
        proposalsCreated: 2, failed: 1, completedAt: '2026-08-02T12:00:00.000Z'
    });
    assert.equal(normalizeImpact({ eventId: 'event-1' }), null);

    for (const status of ALLOWED_PROPOSAL_STATUSES) {
        assert.deepStrictEqual(normalizeProposalStatus({
            itineraryId: 'itinerary-1', proposalId: 'proposal-1', status,
            version: 5, at: '2026-08-02T12:00:00.000Z', eventId: 'event-1'
        }), {
            itineraryId: 'itinerary-1', proposalId: 'proposal-1', status,
            version: 5, at: '2026-08-02T12:00:00.000Z', eventId: 'event-1'
        });
    }
    assert.equal(normalizeProposalStatus({
        itineraryId: 'itinerary-1', proposalId: 'proposal-1', status: 'queued', version: 5
    }), null);
});

test('bridges valid operations events only to the scenic admin room', async () => {
    const bus = fakeBus();
    const io = fakeIo();
    const warnings = [];
    const unsubscribe = bindOpsEvents({
        bus,
        io,
        scenicId: 'scenic-1',
        logger: { warn(message) { warnings.push(message); } }
    });

    await bus.publish(bus.EVENTS.OPS_IMPACT, {
        eventId: 'event-1', edgeId: 'edge-1', affectedItineraries: 2,
        proposalsCreated: 1, failed: 1, completedAt: '2026-08-02T12:00:00.000Z'
    });
    await bus.publish(bus.EVENTS.OPS_PROPOSAL_STATUS, {
        itineraryId: 'itinerary-1', proposalId: 'proposal-1', status: 'shown',
        version: 2, at: '2026-08-02T12:00:01.000Z'
    });
    await bus.publish(bus.EVENTS.OPS_PROPOSAL_STATUS, {
        itineraryId: 'itinerary-1', proposalId: 'proposal-1', status: 'invalid', version: 2
    });

    assert.deepStrictEqual(io.emissions.map(item => [item.room, item.event]), [
        ['admin:scenic-1', 'ops:impact'],
        ['admin:scenic-1', 'ops:proposal-status']
    ]);
    assert.equal(warnings.length, 1);

    unsubscribe();
    assert.equal(bus.handlers.size, 0);
});
