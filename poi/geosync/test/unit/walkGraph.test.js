'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const originalGetModels = models.getModels;
let currentNodes = [];
let currentEdges = [];
models.getModels = () => ({
    WalkNode: { find: () => ({ lean: async () => currentNodes }) },
    WalkEdge: { find: () => ({ lean: async () => currentEdges }) }
});

delete require.cache[require.resolve('../../services/walkGraph')];
const walkGraph = require('../../services/walkGraph');

test.after(() => {
    models.getModels = originalGetModels;
});

function node(nodeId, coordinates) {
    return { nodeId, kind: 'junction', geo: { type: 'Point', coordinates } };
}

function edge(edgeId, from, to, options = {}) {
    return {
        edgeId,
        from,
        to,
        walkSec: options.walkSec ?? 60,
        distanceM: options.distanceM ?? 80,
        geometry: options.geometry || [],
        status: options.status || 'open',
        slope: options.slope ?? 0,
        stairs: Boolean(options.stairs),
        shade: options.shade ?? 0.5,
        accessible: options.accessible !== false,
        accessibleVerified: options.accessibleVerified === true,
        sourceRef: options.sourceRef
    };
}

async function loadGraph(nodes, edges) {
    currentNodes = nodes;
    currentEdges = edges;
    await walkGraph.loadIntoMemory();
}

function point(coordinates, gateNodeId) {
    return { gateNodeId, geo: { type: 'Point', coordinates } };
}

test('nearest-node routing includes both connector segments and marks long snaps as fallback', async () => {
    await loadGraph([node('gate', [0, 0])], []);
    const route = walkGraph.walkSecBetween(
        point([0.0002, 0]),
        point([-0.0002, 0]),
        'standard'
    );

    assert.ok(route.walkSec > 0);
    assert.ok(route.distanceM >= 40);
    assert.strictEqual(route.fallback, true);
    assert.strictEqual(route.authoritative, false);
    assert.strictEqual(route.routeKind, 'graph');
    assert.strictEqual(route.snap.startNodeId, 'gate');
    assert.strictEqual(route.snap.endNodeId, 'gate');
    assert.ok(route.snap.startDistanceM > walkGraph.AUTHORITATIVE_SNAP_DISTANCE_M);
    assert.ok(route.snap.endDistanceM > walkGraph.AUTHORITATIVE_SNAP_DISTANCE_M);
    assert.deepStrictEqual(route.coords, [[0.0002, 0], [0, 0], [-0.0002, 0]]);
    assert.strictEqual(walkGraph.findLocalPath({
        start: [0.0002, 0], end: [-0.0002, 0], mode: 'normal'
    }), null);
});

test('small connector snaps remain graph routes but explicitly fail accessible verification', async () => {
    await loadGraph([node('gate', [0, 0])], []);
    const route = walkGraph.walkSecBetween(
        point([0.00002, 0]),
        point([-0.00002, 0]),
        'accessible'
    );

    assert.ok(route.walkSec > 0);
    assert.strictEqual(route.fallback, false);
    assert.strictEqual(route.authoritative, true);
    assert.strictEqual(route.verifiedAccessible, false);
    assert.deepStrictEqual(route.accessibility, {
        requested: true,
        graphEdgesVerified: true,
        connectorsVerified: false,
        verified: false,
        unverifiedEdgeIds: []
    });
    assert.strictEqual(walkGraph.findLocalPath({
        start: [0.00002, 0],
        end: [-0.00002, 0],
        mode: 'accessible',
        dataVersion: 'graph-v1'
    }), null, 'a same-node route cannot prove a graph data version without traversed edges');
});

test('barriers select an alternate graph route with canonical segments, sources, and snap metadata', async () => {
    const nodes = [
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.0005, 0.0005])
    ];
    const edges = [
        edge('AB', 'A', 'B', {
            walkSec: 90,
            distanceM: 111,
            geometry: [[0, 0], [0.001, 0]],
            sourceRef: {
                datasetName: 'WalkEdge@Test', smId: '1',
                sourceId: 'source-ab', dataVersion: 'graph-v1'
            }
        }),
        edge('AC', 'A', 'C', {
            walkSec: 70,
            distanceM: 80,
            geometry: [[0.0005, 0.0005], [0, 0]],
            accessibleVerified: true,
            sourceRef: {
                datasetName: 'WalkEdge@Test', smId: 2,
                sourceId: 'source-ac', dataVersion: 'graph-v1'
            }
        }),
        edge('CB', 'C', 'B', {
            walkSec: 70,
            distanceM: 80,
            accessibleVerified: true,
            sourceRef: {
                datasetName: 'WalkEdge@Test', smId: 3,
                sourceId: 'source-cb', dataVersion: 'graph-v1'
            }
        })
    ];
    await loadGraph(nodes, edges);

    const direct = walkGraph.walkSecBetween(point([0, 0], 'A'), point([0.001, 0], 'B'), 'normal');
    assert.deepStrictEqual(direct.edgeIds, ['AB']);
    assert.deepStrictEqual(direct.segments[0].sourceRef, {
        datasetName: 'WalkEdge@Test', smId: 1
    });

    const alternate = walkGraph.walkSecBetween(
        point([0, 0], 'A'),
        point([0.001, 0], 'B'),
        'normal',
        { barriers: [{ edgeId: 'AB' }] }
    );
    assert.deepStrictEqual(alternate.edgeIds, ['AC', 'CB']);
    assert.deepStrictEqual(alternate.coords, [[0, 0], [0.0005, 0.0005], [0.001, 0]]);
    assert.deepStrictEqual(alternate.snap, {
        startNodeId: 'A', endNodeId: 'B', startDistanceM: 0, endDistanceM: 0
    });
    assert.deepStrictEqual(alternate.segments, [
        {
            edgeId: 'AC', distanceM: 80, durationSec: 70,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 2 }
        },
        {
            edgeId: 'CB', distanceM: 80, durationSec: 70,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 3 }
        }
    ]);

    const canonical = walkGraph.findLocalPath({
        start: [0, 0],
        end: [0.001, 0],
        startNodeId: 'A',
        endNodeId: 'B',
        mode: 'normal',
        barriers: [{ edgeId: 'AB' }],
        dataVersion: 'graph-v1'
    });
    assert.strictEqual(canonical.dataVersion, 'graph-v1');
    assert.deepStrictEqual(canonical.geometry.coordinates, alternate.coords);
    assert.deepStrictEqual(canonical.segments, alternate.segments);
    assert.deepStrictEqual(canonical.snap, alternate.snap);

    const blockedAll = [{ edgeId: 'AB' }, { edgeId: 'AC' }, { edgeId: 'CB' }];
    const estimate = walkGraph.walkSecBetween(
        point([0, 0], 'A'), point([0.001, 0], 'B'), 'normal', { barriers: blockedAll }
    );
    assert.strictEqual(estimate.routeFound, false);
    assert.strictEqual(estimate.authoritative, false);
    assert.strictEqual(walkGraph.findLocalPath({
        start: [0, 0],
        end: [0.001, 0],
        startNodeId: 'A',
        endNodeId: 'B',
        mode: 'normal',
        barriers: blockedAll,
        dataVersion: 'graph-v1'
    }), null);
});

test('shade routing uses the true minimum weighted path when the old heuristic would overestimate', async () => {
    const nodes = [
        node('S', [0, 0]),
        node('A', [0.0005, 0.0006]),
        node('G', [0.001, 0])
    ];
    await loadGraph(nodes, [
        edge('SG', 'S', 'G', { walkSec: 80, distanceM: 111, shade: 0.5 }),
        edge('SA', 'S', 'A', { walkSec: 60, distanceM: 87, shade: 1 }),
        edge('AG', 'A', 'G', { walkSec: 60, distanceM: 87, shade: 1 })
    ]);

    const route = walkGraph.astar('S', 'G', 'shade');
    assert.deepStrictEqual(route.edgeIds, ['SA', 'AG']);
    assert.equal(route.walkSec, 120, 'reported duration remains the unweighted baseline');
});

test('standard routing remains optimal for unusually fast but still plausible positive edges', async () => {
    const nodes = [
        node('S', [0, 0]),
        node('A', [0.0005, 0.0006]),
        node('G', [0.001, 0])
    ];
    await loadGraph(nodes, [
        edge('SG', 'S', 'G', { walkSec: 80, distanceM: 111 }),
        edge('SA', 'S', 'A', { walkSec: 35, distanceM: 87 }),
        edge('AG', 'A', 'G', { walkSec: 35, distanceM: 87 })
    ]);

    const route = walkGraph.astar('S', 'G', 'standard');
    assert.deepStrictEqual(route.edgeIds, ['SA', 'AG']);
    assert.equal(route.walkSec, 70);
});

test('accessible slope threshold uses percentage units', async () => {
    const nodes = [
        node('S', [0, 0]),
        node('A', [0.0005, 0.0006]),
        node('G', [0.001, 0])
    ];
    const alternatives = [
        edge('SA', 'S', 'A', { walkSec: 35, distanceM: 87, accessibleVerified: true }),
        edge('AG', 'A', 'G', { walkSec: 35, distanceM: 87, accessibleVerified: true })
    ];

    await loadGraph(nodes, [
        edge('SG', 'S', 'G', {
            walkSec: 60,
            distanceM: 111,
            slope: 0.09,
            accessibleVerified: true
        }),
        ...alternatives
    ]);
    assert.deepStrictEqual(
        walkGraph.astar('S', 'G', 'accessible').edgeIds,
        ['SG'],
        '0.09 means 0.09%, not a 9% ratio'
    );

    await loadGraph(nodes, [
        edge('SG', 'S', 'G', {
            walkSec: 60,
            distanceM: 111,
            slope: 9,
            accessibleVerified: true
        }),
        ...alternatives
    ]);
    assert.deepStrictEqual(walkGraph.astar('S', 'G', 'accessible').edgeIds, ['SA', 'AG']);
});

test('graph loading rejects non-finite, negative, out-of-range, and unit-inconsistent edge weights', async () => {
    const nodes = [node('A', [0, 0]), node('B', [0.001, 0])];
    const invalidEdges = [
        edge('negative-time', 'A', 'B', { walkSec: -1, distanceM: 111 }),
        edge('nan-time', 'A', 'B', { walkSec: NaN, distanceM: 111 }),
        edge('infinite-time', 'A', 'B', { walkSec: Infinity, distanceM: 111 }),
        edge('negative-shade', 'A', 'B', { walkSec: 80, distanceM: 111, shade: -0.1 }),
        edge('excess-shade', 'A', 'B', { walkSec: 80, distanceM: 111, shade: 1.1 }),
        edge('nan-slope', 'A', 'B', { walkSec: 80, distanceM: 111, slope: NaN }),
        edge('meters-per-millisecond', 'A', 'B', { walkSec: 1, distanceM: 111 }),
        edge('milliseconds-not-seconds', 'A', 'B', { walkSec: 80000, distanceM: 111 }),
        edge('nan-distance', 'A', 'B', { walkSec: 80, distanceM: NaN }),
        edge('kilometers-not-meters', 'A', 'B', { walkSec: 80, distanceM: 0.111 })
    ];
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        await loadGraph(nodes, [
            ...invalidEdges,
            edge('valid', 'A', 'B', { walkSec: 80, distanceM: 111, shade: 0 })
        ]);
    } finally {
        console.warn = originalWarn;
    }

    assert.deepStrictEqual(walkGraph.astar('A', 'B', 'shade').edgeIds, ['valid']);
    assert.match(warnings.join('\n'), /skipped 10 invalid edges/);
});

test('local fallback trusts only traversed edges from the requested graph data version', async () => {
    const nodes = [
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.0005, 0.0005])
    ];
    const input = {
        start: [0, 0],
        end: [0.001, 0],
        startNodeId: 'A',
        endNodeId: 'B',
        mode: 'normal',
        dataVersion: 'graph-v1'
    };

    await loadGraph(nodes, [
        edge('AB', 'A', 'B', {
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1 }
        })
    ]);
    assert.strictEqual(walkGraph.findLocalPath(input), null, 'versionless edges are not trusted');

    await loadGraph(nodes, [
        edge('AB', 'A', 'B', {
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1, dataVersion: 'graph-v0' }
        })
    ]);
    assert.strictEqual(walkGraph.findLocalPath(input), null, 'mismatched edge versions are not trusted');

    await loadGraph(nodes, [
        edge('AC', 'A', 'C', {
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 2, dataVersion: 'graph-v1' }
        }),
        edge('CB', 'C', 'B', {
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 3, dataVersion: 'graph-v2' }
        })
    ]);
    assert.strictEqual(walkGraph.findLocalPath(input), null, 'mixed route versions are not trusted');

    await loadGraph(nodes, [
        edge('AC', 'A', 'C', {
            sourceRef: {
                datasetName: 'WalkEdge@Test', smId: 2,
                sourceId: 'source-ac', dataVersion: 'graph-v1'
            }
        }),
        edge('CB', 'C', 'B', {
            sourceRef: {
                datasetName: 'WalkEdge@Test', smId: 3,
                sourceId: 'source-cb', dataVersion: 'graph-v1'
            }
        })
    ]);
    const trusted = walkGraph.findLocalPath(input);
    assert.ok(trusted);
    assert.strictEqual(trusted.dataVersion, 'graph-v1');
    assert.deepStrictEqual(trusted.segments.map(segment => segment.sourceRef), [
        { datasetName: 'WalkEdge@Test', smId: 2 },
        { datasetName: 'WalkEdge@Test', smId: 3 }
    ]);
});

test('accessible provenance identifies unverified edges and becomes trusted only on a verified path', async () => {
    const nodes = [
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.0005, 0.0005])
    ];
    await loadGraph(nodes, [
        edge('AB', 'A', 'B', { walkSec: 60, accessible: true, accessibleVerified: false }),
        edge('AC', 'A', 'C', { walkSec: 50, accessibleVerified: true }),
        edge('CB', 'C', 'B', { walkSec: 50, accessibleVerified: true })
    ]);

    const unverified = walkGraph.walkSecBetween(
        point([0, 0], 'A'), point([0.001, 0], 'B'), 'accessible'
    );
    assert.deepStrictEqual(unverified.edgeIds, ['AB']);
    assert.strictEqual(unverified.verifiedAccessible, false);
    assert.deepStrictEqual(unverified.accessibility.unverifiedEdgeIds, ['AB']);

    const verified = walkGraph.walkSecBetween(
        point([0, 0], 'A'),
        point([0.001, 0], 'B'),
        'accessible',
        { blockedEdgeIds: new Set(['AB']) }
    );
    assert.deepStrictEqual(verified.edgeIds, ['AC', 'CB']);
    assert.strictEqual(verified.verifiedAccessible, true);
    assert.deepStrictEqual(verified.accessibility, {
        requested: true,
        graphEdgesVerified: true,
        connectorsVerified: true,
        verified: true,
        unverifiedEdgeIds: []
    });
});

test('disconnected straight-line estimates remain non-authoritative and are excluded from local fallback', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0])
    ], []);

    const estimate = walkGraph.walkSecBetween(
        point([0, 0], 'A'), point([0.001, 0], 'B'), 'standard'
    );
    assert.strictEqual(estimate.routeFound, false);
    assert.strictEqual(estimate.authoritative, false);
    assert.strictEqual(estimate.routeKind, 'direct-estimate');
    assert.strictEqual(estimate.estimated, true);
    assert.deepStrictEqual(estimate.segments, []);
    assert.equal(estimate.snap, undefined);
    assert.strictEqual(walkGraph.findLocalPath({
        start: [0, 0],
        end: [0.001, 0],
        startNodeId: 'A',
        endNodeId: 'B',
        mode: 'normal'
    }), null);
});
