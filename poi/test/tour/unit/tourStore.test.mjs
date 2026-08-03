import assert from 'node:assert/strict';
import test from 'node:test';

if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(type, init = {}) {
            super(type, init);
            this.detail = init.detail;
        }
    };
}

const { TourStore } = await import('../../../public/assets/js/state/tourStore.js');

const NOW = Date.parse('2026-08-03T04:00:00.000Z');

function itinerary(overrides = {}) {
    return {
        itineraryId: 'trip-1',
        version: 1,
        state: 'active',
        stops: [{ poiId: 'poi-1', state: 'current' }],
        route: {
            distanceM: 1_200,
            durationSec: 1_800,
            gis: { source: 'iserver', mode: 'normal' }
        },
        pendingProposal: null,
        ...overrides
    };
}

test('itinerary replacement ignores a lower version of the same itinerary', () => {
    const store = new TourStore({}, { now: () => NOW });
    store.replaceItinerary(itinerary({ version: 5 }));
    const acceptedState = store.getState();

    const ignoredState = store.replaceItinerary(itinerary({
        version: 4,
        state: 'paused',
        stops: [{ poiId: 'stale-poi', state: 'current' }]
    }));
    assert.equal(ignoredState, acceptedState);
    assert.equal(store.getState().itinerary.version, 5);
    assert.equal(store.getState().itinerary.state, 'active');

    store.replaceItinerary(itinerary({ version: 6, state: 'paused' }));
    assert.equal(store.getState().itinerary.version, 6);
    assert.equal(store.getState().itinerary.state, 'paused');
    assert.equal(store.hasNewerVersion(7), true);
    assert.equal(store.hasNewerVersion(6), false);
});

test('partial server itinerary documents are rejected instead of merged locally', () => {
    const store = new TourStore({}, { now: () => NOW });
    assert.throws(
        () => store.replaceItinerary({ itineraryId: 'trip-1', version: 2 }),
        error => error instanceof TypeError && error.code === 'ITINERARY_PARTIAL'
    );
    assert.equal(store.getState().itinerary, null);
});

test('a handled proposal does not reappear when socket-driven refresh returns it again', () => {
    const proposal = {
        proposalId: 'proposal-1',
        expireAt: new Date(NOW + 60_000).toISOString()
    };
    const store = new TourStore({}, { now: () => NOW });
    store.replaceItinerary(itinerary({ version: 2, pendingProposal: proposal }));
    assert.equal(store.getState().activePanel, 'proposal');
    assert.equal(store.getState().pendingProposal.proposalId, 'proposal-1');

    store.markProposalHandled('proposal-1', 'accepted');
    assert.equal(store.getState().pendingProposal, null);
    assert.equal(store.getState().activePanel, 'touring');
    assert.equal(store.getState().proposalStatus, 'accepted');

    store.replaceItinerary(itinerary({ version: 3, pendingProposal: proposal }));
    assert.equal(store.getState().pendingProposal, null);
    assert.equal(store.getState().activePanel, 'touring');
    assert.equal(store.getState().proposalStatus, 'accepted');
    assert.deepEqual(store.getState().handledProposalIds, ['proposal-1']);
});

test('handled proposal ids survive a same-tab store recreation', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };
    const proposal = {
        proposalId: 'proposal-reload',
        expireAt: new Date(NOW + 60_000).toISOString()
    };
    const firstStore = new TourStore({}, { now: () => NOW, storage });
    firstStore.replaceItinerary(itinerary({ version: 2, pendingProposal: proposal }));
    firstStore.markProposalHandled(proposal.proposalId, 'expired');

    const restoredStore = new TourStore({}, { now: () => NOW, storage });
    restoredStore.replaceItinerary(itinerary({ version: 3, pendingProposal: proposal }));
    assert.equal(restoredStore.getState().pendingProposal, null);
    assert.equal(restoredStore.getState().activePanel, 'touring');
    assert.equal(restoredStore.getState().proposalStatus, 'expired');
    assert.deepEqual(restoredStore.getState().handledProposalIds, ['proposal-reload']);
});

test('crowd updates replace only the matching POI and preserve the rest of the snapshot', () => {
    const first = { poiId: 'poi-1', level: 'low', density: 0.2 };
    const second = { poiId: 'poi-2', level: 'medium', density: 0.5 };
    const store = new TourStore();
    store.applyHeatmap({ items: [first, second], lowConfidence: false });

    store.applyCrowdUpdate({ poiId: 'poi-1', level: 'high' });
    const updated = store.getState().heatmap;
    assert.deepEqual(updated, [
        { poiId: 'poi-1', level: 'high', density: 0.2 },
        second
    ]);
    assert.equal(updated[1], second);

    store.applyCrowdUpdate({ poiId: 'poi-3', level: 'unknown' });
    assert.equal(store.getState().heatmap.length, 3);
    assert.deepEqual(store.getState().heatmap[2], { poiId: 'poi-3', level: 'unknown' });
});
