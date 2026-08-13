'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { seedWalkGraphFeatures } = require('../../scripts/seed-walkgraph');

function featureSet(direction) {
    return [
        {
            type: 'Feature',
            properties: { nodeId: 'A' },
            geometry: { type: 'Point', coordinates: [120, 30] }
        },
        {
            type: 'Feature',
            properties: { nodeId: 'B' },
            geometry: { type: 'Point', coordinates: [120.001, 30] }
        },
        {
            type: 'Feature',
            properties: {
                edgeId: 'road',
                from: 'A',
                to: 'B',
                ...(direction === undefined ? {} : { direction })
            },
            geometry: {
                type: 'LineString',
                coordinates: [[120, 30], [120.0005, 30.0002], [120.001, 30]]
            }
        }
    ];
}

function memoryModels(options = {}) {
    const nodes = new Map();
    const edges = new Map();
    let edgeUpdateCalls = 0;
    let failEdgeUpdateAt = options.failEdgeUpdateAt || null;
    const matches = (id, document, filter = {}) => {
        if (filter.scenicId !== undefined && document.scenicId !== filter.scenicId) return false;
        if (filter.source !== undefined && document.source !== filter.source) return false;
        if (filter.nodeId?.$in && !filter.nodeId.$in.includes(id)) return false;
        if (filter.edgeId?.$in && !filter.edgeId.$in.includes(id)) return false;
        if (filter.edgeId?.$nin && filter.edgeId.$nin.includes(id)) return false;
        if (typeof filter.nodeId === 'string' && filter.nodeId !== id) return false;
        if (typeof filter.edgeId === 'string' && filter.edgeId !== id) return false;
        return true;
    };
    const applyUpdate = (current, update, inserted) => {
        const next = { ...(current || {}) };
        Object.assign(next, structuredClone(update.$set || {}));
        if (inserted) Object.assign(next, structuredClone(update.$setOnInsert || {}));
        for (const key of Object.keys(update.$unset || {})) delete next[key];
        return next;
    };
    const WalkNode = {
        find(filter) {
            const rows = [...nodes.entries()]
                .filter(([nodeId, node]) => matches(nodeId, node, filter))
                .map(([nodeId, node]) => ({ nodeId, ...structuredClone(node) }));
            return { lean: async () => rows };
        },
        async updateOne(filter, update) {
            nodes.set(
                filter.nodeId,
                applyUpdate(nodes.get(filter.nodeId), update, !nodes.has(filter.nodeId))
            );
        },
        async deleteMany(filter = {}) {
            for (const [nodeId, node] of [...nodes.entries()]) {
                if (matches(nodeId, node, filter)) nodes.delete(nodeId);
            }
        }
    };
    const WalkEdge = {
        find(filter) {
            const rows = [...edges.entries()]
                .filter(([edgeId, edge]) => matches(edgeId, edge, filter))
                .map(([edgeId, edge]) => ({ edgeId, ...structuredClone(edge) }));
            return { lean: async () => rows };
        },
        async updateOne(filter, update) {
            edgeUpdateCalls++;
            if (failEdgeUpdateAt === edgeUpdateCalls) {
                failEdgeUpdateAt = null;
                throw new Error('injected edge write failure');
            }
            edges.set(
                filter.edgeId,
                applyUpdate(edges.get(filter.edgeId), update, !edges.has(filter.edgeId))
            );
        },
        async deleteMany(filter = {}) {
            for (const [edgeId, edge] of [...edges.entries()]) {
                if (matches(edgeId, edge, filter)) edges.delete(edgeId);
            }
        }
    };
    return { WalkNode, WalkEdge, nodes, edges };
}

async function importDirection(direction, models = memoryModels()) {
    const messages = [];
    const result = await seedWalkGraphFeatures({
        features: featureSet(direction),
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log: message => messages.push(message) }
    });
    return { ...models, result, messages };
}

test('GeoJSON importer persists forward as exactly one endpoint-aligned edge', async () => {
    const imported = await importDirection('forward');

    assert.deepEqual(imported.result, { nodes: 2, edges: 1, skippedLines: 0 });
    assert.deepEqual([...imported.edges.keys()], ['road']);
    assert.equal(imported.edges.get('road').from, 'A');
    assert.equal(imported.edges.get('road').to, 'B');
    assert.equal(imported.edges.get('road').physicalEdgeId, 'road');
    assert.equal(imported.edges.get('road').traversalDirection, 'forward');
    assert.deepEqual(imported.edges.get('road').geometry, featureSet('forward')[2].geometry.coordinates);
});

test('GeoJSON importer persists reverse as exactly one swapped, reversed edge', async () => {
    const imported = await importDirection('reverse');

    assert.deepEqual(imported.result, { nodes: 2, edges: 1, skippedLines: 0 });
    assert.deepEqual([...imported.edges.keys()], ['road_r']);
    assert.equal(imported.edges.get('road_r').from, 'B');
    assert.equal(imported.edges.get('road_r').to, 'A');
    assert.equal(imported.edges.get('road_r').physicalEdgeId, 'road');
    assert.equal(imported.edges.get('road_r').traversalDirection, 'reverse');
    assert.deepEqual(
        imported.edges.get('road_r').geometry,
        [...featureSet('reverse')[2].geometry.coordinates].reverse()
    );
});

test('GeoJSON importer persists both and missing direction as exactly two directed edges', async t => {
    for (const direction of ['both', undefined]) {
        await t.test(direction ?? 'missing', async () => {
            const imported = await importDirection(direction);
            assert.deepEqual(imported.result, { nodes: 2, edges: 2, skippedLines: 0 });
            assert.deepEqual([...imported.edges.keys()], ['road', 'road_r']);
            assert.deepEqual(
                [...imported.edges.values()].map(edge => [edge.from, edge.to]),
                [['A', 'B'], ['B', 'A']]
            );
            assert.deepEqual(
                [...imported.edges.values()].map(edge => edge.physicalEdgeId),
                ['road', 'road']
            );
        });
    }
});

test('an invalid direction rejects the complete delivery before changing the stored graph', async () => {
    const models = memoryModels();
    await importDirection('forward', models);
    const beforeNodes = structuredClone([...models.nodes.entries()]);
    const beforeEdges = structuredClone([...models.edges.entries()]);

    await assert.rejects(
        importDirection('oneway', models),
        /LineString feature at index 2 has invalid direction/
    );
    assert.deepEqual([...models.nodes.entries()], beforeNodes);
    assert.deepEqual([...models.edges.entries()], beforeEdges);
});

test('explicit edge endpoints must exist in the imported or retained scenic graph', async () => {
    const models = memoryModels();
    const features = featureSet('forward');
    const scenicId = 'test-scenic';
    features.splice(1, 1);

    await assert.rejects(
        seedWalkGraphFeatures({
            features,
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            scenicId,
            logger: { log() {} }
        }),
        /edge endpoint B is missing from the imported scenic graph/
    );
    assert.equal(models.nodes.size, 0);
    assert.equal(models.edges.size, 0);

    models.nodes.set('B', {
        scenicId,
        geo: { type: 'Point', coordinates: [120.001, 30] },
        kind: 'junction'
    });
    await seedWalkGraphFeatures({
        features,
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        scenicId,
        logger: { log() {} }
    });
    assert.ok(models.edges.has('road'));

    await assert.rejects(
        seedWalkGraphFeatures({
            features,
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            scenicId,
            wipe: true,
            logger: { log() {} }
        }),
        /edge endpoint B is missing from the imported scenic graph/
    );
    assert.ok(models.edges.has('road'), 'wipe validation must happen before deleting the graph');
});

test('reimport removes obsolete imported directions for a stable source edge id', async () => {
    const models = memoryModels();
    await importDirection('both', models);
    assert.deepEqual([...models.edges.keys()], ['road', 'road_r']);

    await importDirection('forward', models);
    assert.deepEqual([...models.edges.keys()], ['road']);

    await importDirection('reverse', models);
    assert.deepEqual([...models.edges.keys()], ['road_r']);
});

test('reimport preserves a closed physical road and propagates it to a newly added reverse direction', async () => {
    const models = memoryModels();
    await importDirection('forward', models);
    Object.assign(models.edges.get('road'), {
        status: 'closed',
        closedReason: 'maintenance',
        closedAt: new Date('2026-08-12T01:00:00.000Z')
    });

    await importDirection('both', models);

    for (const edgeId of ['road', 'road_r']) {
        const edge = models.edges.get(edgeId);
        assert.equal(edge.status, 'closed');
        assert.equal(edge.closedReason, 'maintenance');
        assert.equal(new Date(edge.closedAt).toISOString(), '2026-08-12T01:00:00.000Z');
    }
});

test('any closed direction makes an inconsistent legacy physical pair closed after reimport', async () => {
    const models = memoryModels();
    await importDirection('both', models);
    Object.assign(models.edges.get('road'), {
        status: 'open',
        closedReason: undefined,
        closedAt: undefined
    });
    Object.assign(models.edges.get('road_r'), {
        status: 'closed',
        closedReason: 'barrier',
        closedAt: new Date('2026-08-12T02:00:00.000Z')
    });

    await importDirection('both', models);

    assert.equal(models.edges.get('road').status, 'closed');
    assert.equal(models.edges.get('road_r').status, 'closed');
    assert.equal(models.edges.get('road').closedReason, 'barrier');
    assert.equal(models.edges.get('road_r').closedReason, 'barrier');
});

test('derived IDs stay stable when anonymous GeoJSON feature order changes', async () => {
    const anonymous = [
        {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [120, 30] }
        },
        {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [120.001, 30] }
        },
        {
            type: 'Feature',
            properties: { direction: 'both' },
            geometry: { type: 'LineString', coordinates: [[120, 30], [120.001, 30]] }
        }
    ];
    const first = memoryModels();
    const second = memoryModels();
    for (const [models, features] of [
        [first, anonymous],
        [second, [anonymous[2], anonymous[1], anonymous[0]]]
    ]) {
        await seedWalkGraphFeatures({
            features,
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            logger: { log() {} }
        });
    }

    assert.deepEqual([...first.nodes.keys()].sort(), [...second.nodes.keys()].sort());
    assert.deepEqual([...first.edges.keys()].sort(), [...second.edges.keys()].sort());
    assert.ok([...first.nodes.keys()].every(nodeId => nodeId.startsWith('n_geo_')));
    assert.ok([...first.edges.keys()].some(edgeId => edgeId.startsWith('e_geo_')));
});

test('full delivery synchronization removes deleted and superseded anonymous imported edges', async () => {
    const models = memoryModels();
    const points = [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [120, 30] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [120.002, 30] } }
    ];
    const road = middle => ({
        type: 'Feature',
        properties: { direction: 'forward' },
        geometry: { type: 'LineString', coordinates: [[120, 30], middle, [120.002, 30]] }
    });

    await seedWalkGraphFeatures({
        features: [...points, road([120.001, 30.001])],
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log() {} }
    });
    const firstId = [...models.edges.keys()][0];

    await seedWalkGraphFeatures({
        features: [...points, road([120.001, 29.999])],
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log() {} }
    });
    const secondIds = [...models.edges.keys()];
    assert.equal(secondIds.length, 1);
    assert.notEqual(secondIds[0], firstId);

    await seedWalkGraphFeatures({
        features: points,
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log() {} }
    });
    assert.equal(models.edges.size, 0);
});

test('duplicate explicit physical IDs are deduplicated only when their complete directed payloads match', async () => {
    const identical = featureSet('forward');
    const sameTwice = [...identical, structuredClone(identical[2])];
    const models = memoryModels();
    const result = await seedWalkGraphFeatures({
        features: sameTwice,
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log() {} }
    });
    assert.equal(result.edges, 1);
    assert.deepEqual([...models.edges.keys()], ['road']);

    const conflicting = featureSet('forward');
    conflicting.push({
        ...structuredClone(conflicting[2]),
        properties: { ...conflicting[2].properties, shade: 0.9 },
        geometry: {
            type: 'LineString',
            coordinates: [[120, 30], [120.0005, 29.9998], [120.001, 30]]
        }
    });
    const before = structuredClone([...models.edges.entries()]);
    await assert.rejects(
        seedWalkGraphFeatures({
            features: conflicting,
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            logger: { log() {} }
        }),
        /physicalEdgeId road maps to conflicting imported edges/
    );
    assert.deepEqual([...models.edges.entries()], before, 'validation must finish before database writes');
});

test('a mid-write failure rolls the imported graph back to the previous complete snapshot', async () => {
    const models = memoryModels();
    await importDirection('forward', models);
    Object.assign(models.edges.get('road'), {
        status: 'closed',
        closedReason: 'keep-closed',
        closedAt: new Date('2026-08-12T03:00:00.000Z')
    });
    const beforeNodes = structuredClone([...models.nodes.entries()]);
    const beforeEdges = structuredClone([...models.edges.entries()]);

    const secondRoad = structuredClone(featureSet('forward'));
    secondRoad[0].properties.nodeId = 'C';
    secondRoad[0].geometry.coordinates = [120.002, 30];
    secondRoad[1].properties.nodeId = 'D';
    secondRoad[1].geometry.coordinates = [120.003, 30];
    secondRoad[2].properties.edgeId = 'road-2';
    secondRoad[2].properties.from = 'C';
    secondRoad[2].properties.to = 'D';
    secondRoad[2].geometry.coordinates = [[120.002, 30], [120.0025, 30.0002], [120.003, 30]];
    models.WalkEdge.failNextUpdate = true;

    let updates = 0;
    const originalUpdate = models.WalkEdge.updateOne;
    models.WalkEdge.updateOne = async (...args) => {
        updates++;
        if (updates === 2) throw new Error('injected edge write failure');
        return originalUpdate(...args);
    };
    await assert.rejects(
        seedWalkGraphFeatures({
            features: [...featureSet('forward'), ...secondRoad],
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            logger: { log() {} }
        }),
        /injected edge write failure/
    );

    assert.deepEqual([...models.nodes.entries()], beforeNodes);
    assert.deepEqual([...models.edges.entries()], beforeEdges);
});

test('transaction fallback is limited to explicit standalone MongoDB unsupported errors', async () => {
    const standalone = memoryModels();
    standalone.WalkEdge.db = {
        async startSession() {
            return {
                async withTransaction() {
                    const error = new Error(
                        'Transaction numbers are only allowed on a replica set member or mongos'
                    );
                    error.code = 20;
                    error.codeName = 'IllegalOperation';
                    throw error;
                },
                async endSession() {}
            };
        }
    };
    await importDirection('forward', standalone);
    assert.ok(standalone.edges.has('road'));

    const unrelated = memoryModels();
    unrelated.WalkEdge.db = {
        async startSession() {
            return {
                async withTransaction() {
                    const error = new Error('Illegal operation for an unrelated write policy');
                    error.code = 20;
                    error.codeName = 'IllegalOperation';
                    throw error;
                },
                async endSession() {}
            };
        }
    };
    await assert.rejects(
        importDirection('forward', unrelated),
        /unrelated write policy/
    );
    assert.equal(unrelated.nodes.size, 0);
    assert.equal(unrelated.edges.size, 0);
});

test('snake-case authority fields win and invalid explicit IDs fail closed', async () => {
    const models = memoryModels();
    await seedWalkGraphFeatures({
        features: [
            {
                type: 'Feature',
                properties: { node_id: 'node_a' },
                geometry: { type: 'Point', coordinates: [120, 30] }
            },
            {
                type: 'Feature',
                properties: { node_id: 'node_b' },
                geometry: { type: 'Point', coordinates: [120.001, 30] }
            },
            {
                type: 'Feature',
                properties: {
                    edge_id: 'edge_authority',
                    from_node: 'node_a',
                    to_node: 'node_b',
                    direction: 'forward'
                },
                geometry: { type: 'LineString', coordinates: [[120, 30], [120.001, 30]] }
            }
        ],
        WalkNode: models.WalkNode,
        WalkEdge: models.WalkEdge,
        logger: { log() {} }
    });
    assert.deepEqual([...models.nodes.keys()], ['node_a', 'node_b']);
    assert.deepEqual([...models.edges.keys()], ['edge_authority']);

    await assert.rejects(
        seedWalkGraphFeatures({
            features: [{
                type: 'Feature',
                properties: { node_id: 'invalid id' },
                geometry: { type: 'Point', coordinates: [120, 30] }
            }],
            WalkNode: models.WalkNode,
            WalkEdge: models.WalkEdge,
            logger: { log() {} }
        }),
        /stable graph identifier/
    );
});

test('full import synchronization never deletes an unrelated manual one-way edge ending in _r', async () => {
    const models = memoryModels();
    models.edges.set('road_r', {
        scenicId: 'default',
        edgeId: 'road_r',
        physicalEdgeId: 'road_r',
        traversalDirection: 'forward',
        from: 'B',
        to: 'A',
        geometry: [...featureSet('forward')[2].geometry.coordinates].reverse(),
        source: 'manual',
        status: 'open'
    });

    await importDirection('forward', models);

    assert.ok(models.edges.has('road'));
    assert.ok(models.edges.has('road_r'));
    assert.equal(models.edges.get('road_r').physicalEdgeId, 'road_r');
});
