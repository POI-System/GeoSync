'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const modelModule = require('../../models');
const walkGraph = require('../../services/walkGraph');
const {
    normalizeWalkEdgeMetrics,
    polylineDistanceM
} = require('../../lib/walkEdgeContract');

const originalGetModels = modelModule.getModels;
const originalLoadIntoMemory = walkGraph.loadIntoMemory;

let nodeRows = new Map();
let createdNodes = [];
let storedEdge = null;
let insertedDocs = [];
let updateCalls = [];
let graphReloads = 0;

function leanQuery(value) {
    return { lean: async () => value == null ? value : structuredClone(value) };
}

function matchesFilter(document, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && !Array.isArray(expected)
            && Object.hasOwn(expected, '$exists')) {
            return Object.hasOwn(document, key) === expected.$exists;
        }
        return isDeepStrictEqual(document[key], expected);
    });
}

const WalkNode = {
    async create(document) {
        createdNodes.push(structuredClone(document));
        return { ...document };
    },
    findOne(filter) {
        return leanQuery(nodeRows.get(filter.nodeId) || null);
    }
};

const WalkEdge = {
    async insertMany(docs) {
        insertedDocs.push(...structuredClone(docs));
        return docs.map(doc => ({ ...doc }));
    },
    findOne(filter) {
        return leanQuery(storedEdge?.edgeId === filter.edgeId ? storedEdge : null);
    },
    async findOneAndUpdate(filter, update, options) {
        updateCalls.push({
            filter: structuredClone(filter),
            update: structuredClone(update),
            options: structuredClone(options)
        });
        if (!storedEdge || !matchesFilter(storedEdge, filter)) return null;
        storedEdge = { ...storedEdge, ...(update.$set || {}) };
        return { ...storedEdge };
    }
};

modelModule.getModels = () => ({ WalkNode, WalkEdge });
walkGraph.loadIntoMemory = async () => { graphReloads++; };

delete require.cache[require.resolve('../../routes/admin')];
const router = require('../../routes/admin');
const createNodeLayer = router.stack.find(layer => layer.route?.path === '/graph/node');
const createLayer = router.stack.find(layer => layer.route?.path === '/graph/edge');
const patchLayer = router.stack.find(layer => layer.route?.path === '/graph/edge/:edgeId');
const createNodeHandler = createNodeLayer.route.stack[0].handle;
const createHandler = createLayer.route.stack[0].handle;
const patchHandler = patchLayer.route.stack[0].handle;

test.after(() => {
    modelModule.getModels = originalGetModels;
    walkGraph.loadIntoMemory = originalLoadIntoMemory;
});

test.beforeEach(() => {
    nodeRows = new Map([
        ['A', { nodeId: 'A', geo: { type: 'Point', coordinates: [120, 30] } }],
        ['B', { nodeId: 'B', geo: { type: 'Point', coordinates: [120.001, 30] } }]
    ]);
    storedEdge = {
        edgeId: 'edge-1',
        from: 'A',
        to: 'B',
        geometry: [[120, 30], [120.001, 30]],
        distanceM: 96,
        walkSec: 70,
        slope: 0,
        stairs: false,
        shade: 0.5,
        covered: 0,
        accessible: true,
        accessibleVerified: true
    };
    createdNodes = [];
    insertedDocs = [];
    updateCalls = [];
    graphReloads = 0;
});

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

async function createEdge(body) {
    const req = { body, params: {}, method: 'POST', originalUrl: '/api/admin/geosync/graph/edge' };
    const res = response();
    await createHandler(req, res, () => {});
    return res;
}

async function createNode(body) {
    const req = { body, params: {}, method: 'POST', originalUrl: '/api/admin/geosync/graph/node' };
    const res = response();
    await createNodeHandler(req, res, () => {});
    return res;
}

async function patchEdge(body, edgeId = 'edge-1') {
    const req = {
        body,
        params: { edgeId },
        method: 'PATCH',
        originalUrl: `/api/admin/geosync/graph/edge/${edgeId}`
    };
    const res = response();
    await patchHandler(req, res, () => {});
    return res;
}

test('graph edge creation preserves zero shade and canonical slope-percent values', async () => {
    const res = await createEdge({
        from: ' A ',
        to: ' B ',
        stairs: 'false',
        slope: '0.09',
        shade: 0,
        covered: '1',
        accessible: 'true',
        bidirectional: 'false'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(insertedDocs.length, 1);
    assert.equal(insertedDocs[0].from, 'A');
    assert.equal(insertedDocs[0].to, 'B');
    assert.equal(insertedDocs[0].stairs, false);
    assert.equal(insertedDocs[0].accessible, true);
    assert.equal(insertedDocs[0].slope, 0.09);
    assert.equal(insertedDocs[0].shade, 0);
    assert.equal(insertedDocs[0].covered, 1);
    assert.ok(Number.isSafeInteger(insertedDocs[0].walkSec));
    assert.ok(insertedDocs[0].walkSec > 0);
    assert.ok(insertedDocs[0].distanceM > 0);
    assert.equal(graphReloads, 1);
});

test('graph node creation rejects coordinates outside the WGS84 range before writing', async t => {
    for (const [name, body] of [
        ['longitude above 180', { lng: 180.000001, lat: 30 }],
        ['longitude below -180', { lng: -180.000001, lat: 30 }],
        ['latitude above 90', { lng: 120, lat: 90.000001 }],
        ['latitude below -90', { lng: 120, lat: -90.000001 }]
    ]) {
        await t.test(name, async () => {
            createdNodes = [];
            graphReloads = 0;
            const res = await createNode(body);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 1101);
            assert.equal(createdNodes.length, 0);
            assert.equal(graphReloads, 0);
        });
    }
});

test('graph edge creation rejects plausible geometry that is not anchored to from/to nodes', async t => {
    for (const [name, geometry] of [
        ['same-length geometry in another location', [[121, 31], [121.001, 31]]],
        ['reversed geometry', [[120.001, 30], [120, 30]]],
        ['start endpoint beyond tolerance', [[120.0001, 30], [120.001, 30]]],
        ['end endpoint beyond tolerance', [[120, 30], [120.0009, 30]]]
    ]) {
        await t.test(name, async () => {
            insertedDocs = [];
            graphReloads = 0;
            const res = await createEdge({ from: 'A', to: 'B', geometry, bidirectional: false });
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 1101);
            assert.equal(insertedDocs.length, 0);
            assert.equal(graphReloads, 0);
        });
    }
});

test('graph edge creation and patch allow bounded endpoint offsets within five meters', async () => {
    const geometry = [[120.00002, 30], [120.00098, 30]];
    const created = await createEdge({
        from: 'A',
        to: 'B',
        geometry,
        bidirectional: false
    });
    assert.equal(created.statusCode, 200);
    assert.equal(insertedDocs.length, 1);

    const patched = await patchEdge({ geometry });
    assert.equal(patched.statusCode, 200);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].update.$set.geometry, geometry);
    assert.equal(graphReloads, 2);
});

test('graph edge creation rejects invalid coordinates, booleans, slope, and shade', async t => {
    for (const [name, body] of [
        ['same endpoint', { from: 'A', to: 'A' }],
        ['invalid geometry', { from: 'A', to: 'B', geometry: [[120, 30], [181, 30]] }],
        ['invalid stairs', { from: 'A', to: 'B', stairs: 'sometimes' }],
        ['invalid accessible', { from: 'A', to: 'B', accessible: 'sometimes' }],
        ['invalid slope', { from: 'A', to: 'B', slope: 101 }],
        ['invalid shade', { from: 'A', to: 'B', shade: 1.01 }],
        ['invalid covered', { from: 'A', to: 'B', covered: -0.01 }]
    ]) {
        await t.test(name, async () => {
            insertedDocs = [];
            graphReloads = 0;
            const res = await createEdge(body);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 1101);
            assert.equal(insertedDocs.length, 0);
            assert.equal(graphReloads, 0);
        });
    }
});

test('graph edge patch normalizes values and enables schema validators', async () => {
    const res = await patchEdge({
        walkSec: '80',
        slope: '8',
        shade: '0',
        covered: '1',
        stairs: 'false'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].update.$set, {
        walkSec: 80,
        slope: 8,
        shade: 0,
        covered: 1,
        stairs: false
    });
    assert.deepEqual(updateCalls[0].options, { new: true, runValidators: true });
    assert.equal(graphReloads, 1);
});

test('graph edge patch rejects non-finite, negative, and inconsistent units before writing', async t => {
    for (const [name, body] of [
        ['negative seconds', { walkSec: -1 }],
        ['fractional seconds', { walkSec: 1.5 }],
        ['meters per millisecond', { walkSec: 1 }],
        ['milliseconds instead of seconds', { walkSec: 80000 }],
        ['kilometers instead of meters', { distanceM: 0.096 }],
        ['blank slope patch', { slope: '' }],
        ['invalid slope percent', { slope: 100.1 }],
        ['invalid shade', { shade: NaN }],
        ['negative covered ratio', { covered: -0.1 }],
        ['invalid geometry', { geometry: [[120, 30], [120, Infinity]] }]
    ]) {
        await t.test(name, async () => {
            updateCalls = [];
            graphReloads = 0;
            const res = await patchEdge(body);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 1101);
            assert.equal(updateCalls.length, 0);
            assert.equal(graphReloads, 0);
        });
    }
});

test('graph edge patch rejects reversed, displaced, and endpoint-offset geometry before writing', async t => {
    for (const [name, geometry] of [
        ['same-length geometry in another location', [[121, 31], [121.001, 31]]],
        ['reversed geometry', [[120.001, 30], [120, 30]]],
        ['start endpoint beyond tolerance', [[120.0001, 30], [120.001, 30]]],
        ['end endpoint beyond tolerance', [[120, 30], [120.0009, 30]]]
    ]) {
        await t.test(name, async () => {
            updateCalls = [];
            graphReloads = 0;
            const res = await patchEdge({ geometry });
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 1101);
            assert.equal(updateCalls.length, 0);
            assert.equal(graphReloads, 0);
        });
    }
});

test('graph edge patch keeps missing-edge and empty-patch business errors', async () => {
    const empty = await patchEdge({ unknown: true });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.body.code, 1101);

    const missing = await patchEdge({ walkSec: 80 }, 'missing-edge');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.code, 8101);
    assert.equal(updateCalls.length, 0);
});

test('graph edge patch rejects a stale metric snapshot instead of creating an invalid combination', async () => {
    const stretchedGeometry = [[120, 30], [120.0005, 30.001], [120.001, 30]];
    const [geometryResult, durationResult] = await Promise.all([
        patchEdge({ geometry: stretchedGeometry }),
        patchEdge({ walkSec: 30 })
    ]);

    const statuses = [geometryResult, durationResult].map(result => result.statusCode).sort();
    assert.deepEqual(statuses, [200, 409]);
    const conflict = geometryResult.statusCode === 409 ? geometryResult : durationResult;
    assert.equal(conflict.body.code, 8102);
    assert.equal(updateCalls.length, 2);
    assert.equal(graphReloads, 1);

    const geometryDistanceM = polylineDistanceM(storedEdge.geometry);
    assert.ok(normalizeWalkEdgeMetrics(storedEdge, { geometryDistanceM }));
});
