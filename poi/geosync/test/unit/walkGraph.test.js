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
        physicalEdgeId: options.physicalEdgeId || edgeId,
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

test('same-node connector-only paths remain non-authoritative and fail accessible verification', async () => {
    await loadGraph([node('gate', [0, 0])], []);
    const route = walkGraph.walkSecBetween(
        point([0.00002, 0]),
        point([-0.00002, 0]),
        'accessible'
    );

    assert.ok(route.walkSec > 0);
    assert.strictEqual(route.fallback, false);
    assert.strictEqual(route.authoritative, false);
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
            edgeId: 'AC', physicalEdgeId: 'AC', fromNodeId: 'A', toNodeId: 'C', distanceM: 80, durationSec: 70,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 2 }
        },
        {
            edgeId: 'CB', physicalEdgeId: 'CB', fromNodeId: 'C', toNodeId: 'B', distanceM: 80, durationSec: 70,
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

test('endpoint snapping preserves a valid target gate when the start has no gate', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.00091, 0])
    ], [
        edge('AB', 'A', 'B', {
            walkSec: 80,
            distanceM: 111,
            geometry: [[0, 0], [0.001, 0]],
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1, dataVersion: 'graph-v1' }
        }),
        edge('AC', 'A', 'C', {
            walkSec: 10,
            distanceM: 101,
            geometry: [[0, 0], [0.00091, 0]],
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 2, dataVersion: 'graph-v1' }
        })
    ]);

    const route = walkGraph.walkSecBetween(
        point([0, 0]),
        point([0.00091, 0], 'B'),
        'normal'
    );

    assert.deepStrictEqual(route.edgeIds, ['AB']);
    assert.equal(route.snap.startNodeId, 'A');
    assert.equal(route.snap.endNodeId, 'B');
});

test('explicit target gates fail closed instead of silently snapping to a nearby reachable node', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.00091, 0])
    ], [
        edge('AC', 'A', 'C', {
            walkSec: 10,
            distanceM: 101,
            geometry: [[0, 0], [0.00091, 0]]
        })
    ]);

    for (const targetGate of ['B', 'missing-gate']) {
        const route = walkGraph.walkSecBetween(
            point([0, 0]),
            point([0.00091, 0], targetGate),
            'normal'
        );
        assert.equal(route.routeFound, false);
        assert.equal(route.authoritative, false);
        assert.equal(route.routeKind, 'direct-estimate');
    }
});

test('blocked or reverse-only target gate paths never fall through to a nearby node', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.00091, 0])
    ], [
        edge('BA', 'B', 'A', { walkSec: 80, distanceM: 111 }),
        edge('AC', 'A', 'C', { walkSec: 10, distanceM: 101 })
    ]);
    const reverseOnly = walkGraph.walkSecBetween(
        point([0, 0]),
        point([0.00091, 0], 'B'),
        'normal'
    );
    assert.equal(reverseOnly.routeFound, false);

    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0]),
        node('C', [0.00091, 0])
    ], [
        edge('AB', 'A', 'B', { walkSec: 80, distanceM: 111 }),
        edge('AC', 'A', 'C', { walkSec: 10, distanceM: 101 })
    ]);
    const blocked = walkGraph.walkSecBetween(
        point([0, 0]),
        point([0.00091, 0], 'B'),
        'normal',
        { barriers: [{ edgeId: 'AB' }] }
    );
    assert.equal(blocked.routeFound, false);
    assert.equal(blocked.authoritative, false);
});

test('directed graph edges permit forward travel but never imply a reverse edge', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0])
    ], [
        edge('AB', 'A', 'B', {
            walkSec: 80,
            distanceM: 111,
            geometry: [[0, 0], [0.001, 0]]
        })
    ]);

    assert.deepStrictEqual(walkGraph.astar('A', 'B', 'standard').edgeIds, ['AB']);
    assert.strictEqual(walkGraph.astar('B', 'A', 'standard'), null);
});

test('a physical-road barrier blocks both derived directions without changing one-way semantics', async () => {
    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0])
    ], [
        edge('road', 'A', 'B', {
            physicalEdgeId: 'road',
            walkSec: 80,
            distanceM: 111,
            geometry: [[0, 0], [0.001, 0]]
        }),
        edge('road_r', 'B', 'A', {
            physicalEdgeId: 'road',
            walkSec: 80,
            distanceM: 111,
            geometry: [[0.001, 0], [0, 0]]
        })
    ]);

    assert.deepStrictEqual(walkGraph.astar('A', 'B', 'standard').edgeIds, ['road']);
    assert.deepStrictEqual(walkGraph.astar('B', 'A', 'standard').edgeIds, ['road_r']);
    assert.strictEqual(walkGraph.astar('A', 'B', 'standard', {
        barriers: [{ edgeId: 'road' }]
    }), null);
    assert.strictEqual(walkGraph.astar('B', 'A', 'standard', {
        barriers: [{ edgeId: 'road' }]
    }), null);

    await loadGraph([
        node('A', [0, 0]),
        node('B', [0.001, 0])
    ], [edge('oneway_r', 'B', 'A', {
        physicalEdgeId: 'oneway_r',
        walkSec: 80,
        distanceM: 111
    })]);
    assert.strictEqual(walkGraph.astar('A', 'B', 'standard'), null);
    assert.deepStrictEqual(walkGraph.astar('B', 'A', 'standard').edgeIds, ['oneway_r']);
});

test('crossing geometries remain disconnected until the intersection is represented by a shared node', async () => {
    const endpoints = [
        node('A', [0, 0]),
        node('B', [0.001, 0.001]),
        node('C', [0, 0.001]),
        node('D', [0.001, 0])
    ];
    await loadGraph(endpoints, [
        edge('AB', 'A', 'B', {
            walkSec: 112,
            distanceM: 157,
            geometry: [[0, 0], [0.001, 0.001]]
        }),
        edge('CD', 'C', 'D', {
            walkSec: 112,
            distanceM: 157,
            geometry: [[0, 0.001], [0.001, 0]]
        })
    ]);

    assert.strictEqual(
        walkGraph.astar('A', 'D', 'standard'),
        null,
        'a visual line intersection is not a topological junction'
    );

    await loadGraph([...endpoints, node('X', [0.0005, 0.0005])], [
        edge('AX', 'A', 'X', {
            walkSec: 56,
            distanceM: 79,
            geometry: [[0, 0], [0.0005, 0.0005]]
        }),
        edge('XB', 'X', 'B', {
            walkSec: 56,
            distanceM: 79,
            geometry: [[0.0005, 0.0005], [0.001, 0.001]]
        }),
        edge('CX', 'C', 'X', {
            walkSec: 56,
            distanceM: 79,
            geometry: [[0, 0.001], [0.0005, 0.0005]]
        }),
        edge('XD', 'X', 'D', {
            walkSec: 56,
            distanceM: 79,
            geometry: [[0.0005, 0.0005], [0.001, 0]]
        })
    ]);

    assert.deepStrictEqual(walkGraph.astar('A', 'D', 'standard').edgeIds, ['AX', 'XD']);
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

test('local fallback accepts only an exact same-node zero leg without traversed edges', async () => {
    await loadGraph([node('A', [0, 0])], []);

    const exact = walkGraph.findLocalPath({
        start: [0, 0],
        end: [0, 0],
        startNodeId: 'A',
        endNodeId: 'A',
        mode: 'normal',
        dataVersion: 'graph-v1'
    });
    assert.ok(exact);
    assert.deepStrictEqual(exact.geometry.coordinates, [[0, 0], [0, 0]]);
    assert.deepStrictEqual(exact.nodeIds, ['A']);
    assert.deepStrictEqual(exact.edgeIds, []);
    assert.deepStrictEqual(exact.segments, []);

    assert.strictEqual(walkGraph.findLocalPath({
        start: [0.00001, 0],
        end: [-0.00001, 0],
        startNodeId: 'A',
        endNodeId: 'A',
        mode: 'normal',
        dataVersion: 'graph-v1'
    }), null);
});
