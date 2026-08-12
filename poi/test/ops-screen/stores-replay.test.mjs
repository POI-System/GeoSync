import test from 'node:test';
import assert from 'node:assert/strict';

import { OpsStore } from '../../public/assets/js/state/opsStore.js';
import { ScreenStore } from '../../public/assets/js/state/screenStore.js';
import { ReplayEngine } from '../../public/assets/js/replay/replayEngine.js';
import {
    DEMO_GRAPH,
    DEMO_HEATMAP,
    DemoController,
    createDemoReplay
} from '../../public/assets/js/e2e/demoController.js';
import { ScreenStreamClient } from '../../public/assets/js/ops/screenStream.js';

function readyOpsStore() {
    const store = new OpsStore();
    store.ready({
        config: {}, health: { state: 'online' }, dashboard: {}, heatmap: DEMO_HEATMAP,
        graph: JSON.parse(JSON.stringify(DEMO_GRAPH))
    });
    return store;
}

test('ops store keeps the authoritative edge open after a 202 acceptance', () => {
    const store = readyOpsStore();
    store.startOperation({ edgeId: 'edge-demo-key', operation: 'close', reason: '临时施工' });
    store.acceptOperation({ eventId: 'evt-1', acceptedAt: '2026-08-07T06:10:00.000Z' });

    const edge = store.getState().graph.edges.find(item => item.edgeId === 'edge-demo-key');
    assert.equal(edge.status, 'open');
    assert.equal(store.getState().pendingOperation.status, 'processing');
    assert.deepEqual(store.getState().proposalStats, {
        shown: 0, accepted: 0, rejected: 0, expired: 0, failed: 0
    });
});

test('graph update finalizes closure and impact uses only reported counts', () => {
    const store = readyOpsStore();
    store.startOperation({ edgeId: 'edge-demo-key', operation: 'close', reason: '临时施工' });
    store.acceptOperation({ eventId: 'evt-1' });
    store.applyGraphUpdate({ eventId: 'evt-1', edgeId: 'edge-demo-key', status: 'closed', reason: '临时施工' });

    assert.equal(store.getState().pendingOperation, null);
    assert.equal(store.getState().graph.edges.find(item => item.edgeId === 'edge-demo-key').status, 'closed');
    store.applyImpact({
        eventId: 'evt-1', edgeId: 'edge-demo-key', affectedItineraries: 3,
        proposalsCreated: 2, failed: 1, completedAt: '2026-08-07T06:10:02.000Z'
    });
    store.applyImpact({
        eventId: 'evt-1', edgeId: 'edge-demo-key', affectedItineraries: 3,
        proposalsCreated: 2, failed: 1, completedAt: '2026-08-07T06:10:02.000Z'
    });
    assert.equal(store.getState().proposalStats.shown, 2);
    assert.equal(store.getState().proposalStats.failed, 1);
});

test('proposal status events are idempotent', () => {
    const store = readyOpsStore();
    const event = {
        eventId: 'evt-1', itineraryId: 'trip-1', proposalId: 'proposal-1',
        status: 'accepted', version: 2, at: '2026-08-07T06:10:03.000Z'
    };
    store.applyProposalStatus(event);
    store.applyProposalStatus(event);
    assert.equal(store.getState().proposalStats.accepted, 1);
});

test('screen store preserves live frames while replay is visible', () => {
    const store = new ScreenStore();
    store.ready({ config: {}, health: {}, dashboard: {}, frame: DEMO_HEATMAP });
    store.enterReplay('2026-08-07', 3);
    store.renderFrame({ slot: '2026-08-07T13:40', items: [], missing: true }, { realtime: false });
    store.renderFrame({ slot: '2026-08-07T14:20', items: [{ poiId: 'live', ci: .5 }] }, { realtime: true });

    assert.equal(store.getState().frame.slot, '2026-08-07T13:40');
    store.exitReplay();
    assert.equal(store.getState().frame.slot, '2026-08-07T14:20');
});

test('replay engine expands compressed payload and exposes missing slots', () => {
    const frames = [];
    const engine = new ReplayEngine({ onFrame: frame => frames.push(frame) });
    const total = engine.load(createDemoReplay());
    assert.equal(total, 7);
    const missingFrame = engine.seek(2);
    assert.equal(missingFrame.items.some(item => item.poiId === 'poi-garden'), false);
    assert.equal(missingFrame.missing, true);
    assert.equal(engine.step(999).slot.endsWith('14:40'), true);
    assert.throws(() => engine.play(2), /仅支持/);
    engine.destroy();
});

test('demo closure follows accepted, graph, impact and proposal sequence', () => {
    const store = readyOpsStore();
    const callbacks = [];
    const clock = {
        setTimeout(callback) { callbacks.push(callback); return callbacks.length; },
        clearTimeout() {}
    };
    const demo = new DemoController({ store, clock });
    store.startOperation({ edgeId: 'edge-demo-key', operation: 'close', reason: '临时施工' });
    demo.closeEdge('edge-demo-key', '临时施工', 60);
    assert.equal(store.getState().pendingOperation.status, 'processing');
    callbacks.forEach(callback => callback());
    assert.equal(store.getState().graph.edges.find(item => item.edgeId === 'edge-demo-key').status, 'closed');
    assert.equal(store.getState().proposalStats.accepted, 1);
    assert.equal(store.getState().proposalStats.failed, 1);
});

test('SSE parser accepts named JSON events and ignores malformed frames', () => {
    const events = [];
    const client = new ScreenStreamClient({ onEvent: (name, payload) => events.push([name, payload]) });
    client.parseBlock('event: stats\ndata: {"activeItineraries":18}');
    client.parseBlock('event: heatmap\ndata: not-json');
    assert.deepEqual(events, [['stats', { activeItineraries: 18 }]]);
});
