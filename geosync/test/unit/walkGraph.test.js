'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const originalGetModels = models.getModels;
const nodes = [{
    nodeId: 'gate', kind: 'poi-gate',
    geo: { type: 'Point', coordinates: [0, 0] }
}];
models.getModels = () => ({
    WalkNode: { find: () => ({ lean: async () => nodes }) },
    WalkEdge: { find: () => ({ lean: async () => [] }) }
});

delete require.cache[require.resolve('../../services/walkGraph')];
const walkGraph = require('../../services/walkGraph');

test.after(() => {
    models.getModels = originalGetModels;
});

test('nearest-node routing includes both connector segments and marks long snaps as fallback', async () => {
    await walkGraph.loadIntoMemory();
    const route = walkGraph.walkSecBetween(
        { geo: { coordinates: [0.0002, 0] } },
        { geo: { coordinates: [-0.0002, 0] } },
        'standard'
    );

    assert.ok(route.walkSec > 0);
    assert.ok(route.distanceM >= 40);
    assert.strictEqual(route.fallback, true);
    assert.deepStrictEqual(route.coords, [[0.0002, 0], [0, 0], [-0.0002, 0]]);
});

test('a small GPS snap is timed but does not invalidate an accessible graph route', async () => {
    await walkGraph.loadIntoMemory();
    const route = walkGraph.walkSecBetween(
        { geo: { coordinates: [0.00002, 0] } },
        { geo: { coordinates: [-0.00002, 0] } },
        'accessible'
    );

    assert.ok(route.walkSec > 0);
    assert.strictEqual(route.fallback, false);
});
