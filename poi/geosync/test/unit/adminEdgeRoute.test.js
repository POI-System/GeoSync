'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');
const bus = require('../../lib/eventBus');
const walkGraph = require('../../services/walkGraph');

let storedEdges;
let updateCalls;
let findCalls;
let emitted;
let invalidations;
let graphReloads;
let invalidationError;

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function leanQuery(value) {
    return {
        lean: async () => clone(value),
        session() { return this; }
    };
}

function matchesEdge(edge, filter) {
    if (Array.isArray(filter?.$or)) {
        if (!filter.$or.some(condition => matchesEdge(edge, condition))) return false;
    }
    for (const [key, expected] of Object.entries(filter || {})) {
        if (key === '$or') continue;
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if (Array.isArray(expected.$in)) {
                if (!expected.$in.includes(edge[key])) return false;
                continue;
            }
        }
        if (edge[key] !== expected) return false;
    }
    return true;
}

function applyUpdate(edge, update) {
    const next = { ...edge, ...(update.$set || {}) };
    for (const key of Object.keys(update.$unset || {})) delete next[key];
    return next;
}

const WalkEdge = {
    find(filter) {
        findCalls.push(filter);
        return leanQuery([...storedEdges.values()].filter(edge => matchesEdge(edge, filter)));
    },
    findOne(filter) {
        findCalls.push(filter);
        return leanQuery([...storedEdges.values()].find(edge => matchesEdge(edge, filter)) || null);
    },
    async updateMany(filter, update, options = {}) {
        updateCalls.push({ filter: clone(filter), update: clone(update), options: clone(options) });
        let matchedCount = 0;
        for (const [edgeId, edge] of storedEdges) {
            if (!matchesEdge(edge, filter)) continue;
            storedEdges.set(edgeId, applyUpdate(edge, update));
            matchedCount++;
        }
        return { matchedCount, modifiedCount: matchedCount };
    }
};

const originalGetModels = modelModule.getModels;
const originalEmit = bus.emit;
const originalLoadIntoMemory = walkGraph.loadIntoMemory;

modelModule.getModels = () => ({ WalkEdge });
bus.emit = (event, payload) => {
    emitted.push({ event, payload });
};
walkGraph.loadIntoMemory = async () => { graphReloads++; };

delete require.cache[require.resolve('../../routes/admin')];
const router = require('../../routes/admin');
const edgeLayer = router.stack.find(layer =>
    layer.route?.path === '/graph/edge/:edgeId/:op(close|open)');
const edgeHandler = edgeLayer.route.stack[0].handle;

test.after(() => {
    modelModule.getModels = originalGetModels;
    bus.emit = originalEmit;
    walkGraph.loadIntoMemory = originalLoadIntoMemory;
});

function reset(edges = null) {
    const values = Array.isArray(edges) ? edges : edges ? [edges] : [];
    storedEdges = new Map(values.map(edge => [edge.edgeId, clone(edge)]));
    updateCalls = [];
    findCalls = [];
    emitted = [];
    invalidations = [];
    graphReloads = 0;
    invalidationError = null;
    delete WalkEdge.db;
    bus.emit = (event, payload) => {
        emitted.push({ event, payload });
    };
}

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

function gateway() {
    return {
        async invalidateRouteCache(reason) {
            invalidations.push(reason);
            if (invalidationError) throw invalidationError;
            return { cleared: 1 };
        }
    };
}

async function transition(op, options = {}) {
    const edgeId = options.edgeId || 'edge-1';
    const req = {
        method: 'POST',
        originalUrl: `/api/admin/geosync/graph/edge/${edgeId}/${op}`,
        params: { edgeId, op },
        body: options.body || {},
        app: { locals: { geosync: { superMapGateway: options.gateway || gateway() } } }
    };
    const res = response();
    await edgeHandler(req, res, () => {});
    return res;
}

test('close persists sanitized metadata, invalidates once, emits the full event, and returns 202', async () => {
    reset({
        edgeId: 'edge-1',
        scenicId: 'scenic-test',
        status: 'open',
        sourceRef: { datasetName: ' WalkEdge@Test ', smId: '17', sourceId: 'private' }
    });
    bus.emit = (event, payload) => {
        emitted.push({ event, payload });
        return new Promise(() => {});
    };

    const res = await transition('close', {
        body: { reason: '  construction\r\nclosure  ' }
    });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(updateCalls[0].filter, {
        scenicId: 'scenic-test',
        $or: [{ edgeId: 'edge-1', status: 'open' }]
    });
    assert.equal(updateCalls[0].update.$set.status, 'closed');
    assert.equal(updateCalls[0].update.$set.physicalEdgeId, 'edge-1');
    assert.equal(updateCalls[0].update.$set.closedReason, 'construction closure');
    assert.ok(updateCalls[0].update.$set.closedAt instanceof Date);
    assert.equal(storedEdges.get('edge-1').status, 'closed');
    assert.equal(storedEdges.get('edge-1').closedReason, 'construction closure');
    assert.equal(invalidations.length, 1);
    assert.equal(graphReloads, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, bus.EVENTS.EDGE_CLOSED);

    const payload = emitted[0].payload;
    assert.match(payload.eventId, /^closure_[0-9a-f]{16}$/);
    assert.deepEqual(payload, {
        eventId: payload.eventId,
        scenicId: 'scenic-test',
        edgeId: 'edge-1',
        physicalEdgeId: 'edge-1',
        edgeIds: ['edge-1'],
        status: 'closed',
        reason: 'construction closure',
        sourceRef: { datasetName: 'WalkEdge@Test', smId: 17 },
        acceptedAt: payload.acceptedAt,
        cacheInvalidated: true
    });
    assert.equal(new Date(payload.acceptedAt).toISOString(), payload.acceptedAt);
    assert.equal(invalidations[0], `graph-closed:edge-1:${payload.eventId}`);
    assert.deepEqual(res.body, {
        success: true,
        code: 0,
        data: payload,
        message: ''
    });
});

test('open uses the closed-to-open filter and removes closure metadata', async () => {
    reset({
        edgeId: 'edge-1', scenicId: 'scenic-test', status: 'closed',
        closedReason: 'construction', closedAt: new Date(), sourceRef: null
    });

    const res = await transition('open');

    assert.equal(res.statusCode, 202);
    assert.deepEqual(updateCalls[0].filter, {
        scenicId: 'scenic-test',
        $or: [{ edgeId: 'edge-1', status: 'closed' }]
    });
    assert.deepEqual(updateCalls[0].update.$unset, { closedReason: 1, closedAt: 1 });
    assert.equal(storedEdges.get('edge-1').status, 'open');
    assert.equal(Object.hasOwn(storedEdges.get('edge-1'), 'closedReason'), false);
    assert.equal(Object.hasOwn(storedEdges.get('edge-1'), 'closedAt'), false);
    assert.equal(emitted[0].event, bus.EVENTS.EDGE_OPENED);
    assert.equal(emitted[0].payload.reason, null);
    assert.equal(emitted[0].payload.sourceRef, null);
    assert.equal(emitted[0].payload.cacheInvalidated, true);
    assert.equal(invalidations.length, 1);
    assert.equal(graphReloads, 0);
});

test('same-state retry returns a 200 no-op without invalidation or event emission', async () => {
    reset({ edgeId: 'edge-1', scenicId: 'scenic-test', status: 'closed' });

    const res = await transition('close', { body: { reason: 'construction' } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        success: true,
        code: 0,
        data: {
            accepted: false,
            edgeId: 'edge-1',
            physicalEdgeId: 'edge-1',
            edgeIds: ['edge-1'],
            status: 'closed'
        },
        message: ''
    });
    assert.equal(updateCalls.length, 1, 'legacy identity is backfilled on the first no-op retry');
    assert.equal(storedEdges.get('edge-1').physicalEdgeId, 'edge-1');
    assert.equal(invalidations.length, 0);
    assert.equal(emitted.length, 0);
    assert.equal(graphReloads, 0);
});

test('cache invalidation failure is observable but does not turn a durable transition into HTTP 500', async () => {
    reset({ edgeId: 'edge-1', scenicId: 'scenic-test', status: 'open' });
    invalidationError = new Error('cache unavailable');
    const originalConsoleError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    try {
        const res = await transition('close', { body: { reason: 'construction' } });
        assert.equal(res.statusCode, 202);
        assert.equal(storedEdges.get('edge-1').status, 'closed');
        assert.equal(invalidations.length, 1);
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].payload.cacheInvalidated, false);
        assert.equal(res.body.data.cacheInvalidated, false);
        assert.match(logs[0], /route-cache invalidation failed/);
    } finally {
        console.error = originalConsoleError;
    }
});

test('blank close reason is rejected before the edge write', async () => {
    reset({ edgeId: 'edge-1', scenicId: 'scenic-test', status: 'open' });

    const res = await transition('close', { body: { reason: ' \r\n ' } });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 1101);
    assert.equal(updateCalls.length, 0);
    assert.equal(invalidations.length, 0);
    assert.equal(emitted.length, 0);
});

test('missing edge returns 404 without invalidation or event emission', async () => {
    reset(null);

    const res = await transition('open');

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 8101);
    assert.equal(invalidations.length, 0);
    assert.equal(emitted.length, 0);
    assert.equal(graphReloads, 0);
});

test('closing either directed edge closes the whole physical road and emits one event', async () => {
    reset([
        {
            edgeId: 'road', physicalEdgeId: 'road', traversalDirection: 'forward',
            scenicId: 'scenic-test', from: 'A', to: 'B', status: 'open',
            geometry: [[120, 30], [120.001, 30]],
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 17 }
        },
        {
            edgeId: 'road_r', physicalEdgeId: 'road', traversalDirection: 'reverse',
            scenicId: 'scenic-test', from: 'B', to: 'A', status: 'open',
            geometry: [[120.001, 30], [120, 30]],
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 17 }
        }
    ]);

    const closed = await transition('close', {
        edgeId: 'road_r',
        body: { reason: 'maintenance' }
    });

    assert.equal(closed.statusCode, 202);
    assert.equal(storedEdges.get('road').status, 'closed');
    assert.equal(storedEdges.get('road_r').status, 'closed');
    assert.deepEqual(new Set(closed.body.data.edgeIds), new Set(['road', 'road_r']));
    assert.equal(closed.body.data.edgeId, 'road');
    assert.equal(closed.body.data.physicalEdgeId, 'road');
    assert.equal(emitted.length, 1);
    assert.equal(invalidations[0], `graph-closed:road:${closed.body.data.eventId}`);

    const opened = await transition('open', { edgeId: 'road_r' });
    assert.equal(opened.statusCode, 202);
    assert.equal(storedEdges.get('road').status, 'open');
    assert.equal(storedEdges.get('road_r').status, 'open');
    assert.equal(Object.hasOwn(storedEdges.get('road'), 'closedReason'), false);
    assert.equal(Object.hasOwn(storedEdges.get('road_r'), 'closedAt'), false);
});

test('standalone Mongo transaction rejection falls back to one physical-road update', async () => {
    reset([
        {
            edgeId: 'standalone-road', physicalEdgeId: 'standalone-road',
            traversalDirection: 'forward', scenicId: 'scenic-test',
            from: 'A', to: 'B', status: 'open',
            geometry: [[120, 30], [120.001, 30]]
        },
        {
            edgeId: 'standalone-road_r', physicalEdgeId: 'standalone-road',
            traversalDirection: 'reverse', scenicId: 'scenic-test',
            from: 'B', to: 'A', status: 'open',
            geometry: [[120.001, 30], [120, 30]]
        }
    ]);
    let sessionsEnded = 0;
    WalkEdge.db = {
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
                async endSession() {
                    sessionsEnded++;
                }
            };
        }
    };

    const res = await transition('close', {
        edgeId: 'standalone-road_r',
        body: { reason: 'standalone maintenance' }
    });

    assert.equal(res.statusCode, 202);
    assert.equal(sessionsEnded, 1);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].options, {});
    assert.equal(storedEdges.get('standalone-road').status, 'closed');
    assert.equal(storedEdges.get('standalone-road_r').status, 'closed');
    assert.equal(emitted.length, 1);
    assert.deepEqual(
        new Set(emitted[0].payload.edgeIds),
        new Set(['standalone-road', 'standalone-road_r'])
    );
});

test('transaction failures unrelated to deployment support do not fall back', async () => {
    reset({
        edgeId: 'transaction-error', scenicId: 'scenic-test', status: 'open'
    });
    let sessionsEnded = 0;
    WalkEdge.db = {
        async startSession() {
            return {
                async withTransaction() {
                    const error = new Error('primary stepped down');
                    error.code = 189;
                    throw error;
                },
                async endSession() {
                    sessionsEnded++;
                }
            };
        }
    };

    const res = await transition('close', {
        edgeId: 'transaction-error',
        body: { reason: 'must remain failed' }
    });

    assert.equal(res.statusCode, 500);
    assert.equal(sessionsEnded, 1);
    assert.equal(updateCalls.length, 0);
    assert.equal(storedEdges.get('transaction-error').status, 'open');
    assert.equal(emitted.length, 0);
});

test('legacy exact reverse pairs are linked, while an unpaired one-way _r edge stays independent', async () => {
    reset([
        {
            edgeId: 'legacy', scenicId: 'scenic-test', from: 'A', to: 'B', status: 'open',
            geometry: [[120, 30], [120.001, 30]]
        },
        {
            edgeId: 'legacy_r', scenicId: 'scenic-test', from: 'B', to: 'A', status: 'open',
            geometry: [[120.001, 30], [120, 30]]
        },
        {
            edgeId: 'oneway_r', scenicId: 'scenic-test', from: 'C', to: 'D', status: 'open',
            geometry: [[121, 31], [121.001, 31]]
        }
    ]);

    const legacy = await transition('close', {
        edgeId: 'legacy_r',
        body: { reason: 'legacy maintenance' }
    });
    assert.equal(legacy.statusCode, 202);
    assert.equal(legacy.body.data.physicalEdgeId, 'legacy');
    assert.equal(storedEdges.get('legacy').physicalEdgeId, 'legacy');
    assert.equal(storedEdges.get('legacy_r').physicalEdgeId, 'legacy');
    assert.equal(storedEdges.get('legacy').status, 'closed');
    assert.equal(storedEdges.get('legacy_r').status, 'closed');
    assert.equal(storedEdges.get('oneway_r').status, 'open');

    const oneWay = await transition('close', {
        edgeId: 'oneway_r',
        body: { reason: 'one-way maintenance' }
    });
    assert.equal(oneWay.statusCode, 202);
    assert.deepEqual(oneWay.body.data.edgeIds, ['oneway_r']);
    assert.equal(oneWay.body.data.physicalEdgeId, 'oneway_r');
    assert.equal(storedEdges.get('oneway_r').status, 'closed');
});
