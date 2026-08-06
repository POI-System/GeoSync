'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');
const bus = require('../../lib/eventBus');
const walkGraph = require('../../services/walkGraph');

let storedEdge;
let updateCalls;
let findCalls;
let emitted;
let invalidations;
let graphReloads;
let invalidationError;

const WalkEdge = {
    async findOneAndUpdate(filter, update) {
        updateCalls.push({ filter, update });
        if (!storedEdge
            || storedEdge.edgeId !== filter.edgeId
            || storedEdge.status !== filter.status) {
            return null;
        }
        const next = { ...storedEdge, ...(update.$set || {}) };
        for (const key of Object.keys(update.$unset || {})) delete next[key];
        storedEdge = next;
        return { ...next };
    },
    async findOne(filter) {
        findCalls.push(filter);
        return storedEdge && storedEdge.edgeId === filter.edgeId ? { ...storedEdge } : null;
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

function reset(edge = null) {
    storedEdge = edge ? { ...edge } : null;
    updateCalls = [];
    findCalls = [];
    emitted = [];
    invalidations = [];
    graphReloads = 0;
    invalidationError = null;
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
    const req = {
        method: 'POST',
        originalUrl: `/api/admin/geosync/graph/edge/edge-1/${op}`,
        params: { edgeId: 'edge-1', op },
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
    assert.deepEqual(updateCalls[0].filter, { edgeId: 'edge-1', status: 'open' });
    assert.equal(updateCalls[0].update.$set.status, 'closed');
    assert.equal(updateCalls[0].update.$set.closedReason, 'construction closure');
    assert.ok(updateCalls[0].update.$set.closedAt instanceof Date);
    assert.equal(storedEdge.status, 'closed');
    assert.equal(storedEdge.closedReason, 'construction closure');
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
    assert.deepEqual(updateCalls[0].filter, { edgeId: 'edge-1', status: 'closed' });
    assert.deepEqual(updateCalls[0].update.$unset, { closedReason: 1, closedAt: 1 });
    assert.equal(storedEdge.status, 'open');
    assert.equal(Object.hasOwn(storedEdge, 'closedReason'), false);
    assert.equal(Object.hasOwn(storedEdge, 'closedAt'), false);
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
        data: { accepted: false, edgeId: 'edge-1', status: 'closed' },
        message: ''
    });
    assert.equal(updateCalls.length, 1);
    assert.equal(findCalls.length, 1);
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
        assert.equal(storedEdge.status, 'closed');
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
