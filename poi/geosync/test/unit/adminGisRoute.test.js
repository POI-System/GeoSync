'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../../config');
const { ERROR_DEFINITIONS, createSuperMapError } = require('../../integrations/supermap/errors');

delete require.cache[require.resolve('../../routes/admin')];
const router = require('../../routes/admin');
const routeLayer = router.stack.find(layer => layer.route?.path === '/gis/route-test');
const routeHandler = routeLayer.route.stack[0].handle;
const adminMiddleware = router.stack.find(layer => !layer.route && layer.handle?.name === 'requireAdmin').handle;

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

async function routeTest(gateway, body = {}, headers = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/admin/geosync/gis/route-test',
        body,
        headers,
        app: { locals: { geosync: { superMapGateway: gateway } } }
    };
    const res = response();
    await routeHandler(req, res, () => {});
    return res;
}

function routeResult(mode = 'normal') {
    return {
        geometry: { type: 'LineString', coordinates: [[120, 30], [120.001, 30.001]] },
        distanceM: 150,
        durationSec: 120,
        segments: [{
            edgeId: 'edge-1', distanceM: 150, durationSec: 120,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1 }
        }],
        snap: { startDistanceM: 1, endDistanceM: 2 },
        gis: {
            source: 'iserver', mode, degraded: false,
            requestId: 'gis-test', durationMs: 12, dataVersion: 'v1'
        },
        pathGeometry: 'encoded-route'
    };
}

test('route-test uses findPath for an empty barrier set and forwards only server-approved fields', async () => {
    const calls = [];
    const result = routeResult('shade');
    const gateway = {
        async findPath(input) {
            calls.push({ method: 'findPath', input });
            return result;
        },
        async findPathWithBarriers(input) {
            calls.push({ method: 'findPathWithBarriers', input });
            return result;
        }
    };

    const res = await routeTest(gateway, {
        start: [120, 30],
        end: [120.001, 30.001],
        mode: 'shade',
        barriers: [],
        scenicId: 'client-scenic',
        requestId: 'body-request',
        unexpected: 'discard-me'
    }, { 'x-request-id': ' admin-smoke-1 ' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{
        method: 'findPath',
        input: {
            start: [120, 30],
            end: [120.001, 30.001],
            mode: 'shade',
            barriers: [],
            scenicId: CONFIG.scenicId,
            requestId: 'admin-smoke-1'
        }
    }]);
    assert.deepEqual(res.body, { success: true, code: 0, data: result, message: '' });
});

test('route-test uses findPathWithBarriers only for a nonempty barrier array', async () => {
    const calls = [];
    const barriers = [{
        edgeId: 'edge-closed',
        sourceRef: { datasetName: 'WalkEdge@Test', smId: 9 }
    }];
    const gateway = {
        async findPath(input) {
            calls.push({ method: 'findPath', input });
            return routeResult();
        },
        async findPathWithBarriers(input) {
            calls.push({ method: 'findPathWithBarriers', input });
            return routeResult();
        }
    };

    const res = await routeTest(gateway, {
        start: [120, 30], end: [120.002, 30.002], mode: 'normal', barriers
    });

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'findPathWithBarriers');
    assert.deepEqual(calls[0].input.barriers, barriers);
    assert.equal(calls[0].input.scenicId, CONFIG.scenicId);
});

test('route-test preserves typed SuperMap HTTP and error-code mappings', async () => {
    for (const [rawCode, definition] of Object.entries(ERROR_DEFINITIONS)) {
        const code = Number(rawCode);
        const gateway = {
            async findPath() { throw createSuperMapError(code); },
            async findPathWithBarriers() { throw createSuperMapError(code); }
        };
        const res = await routeTest(gateway, {
            start: [120, 30], end: [120.001, 30.001], mode: 'normal', barriers: []
        });
        assert.equal(res.statusCode, definition.httpStatus, `HTTP mapping for ${code}`);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, code);
        assert.equal(res.body.message, definition.message);
    }
});

test('route-test reports an unavailable injected Gateway as 8201', async () => {
    const res = await routeTest({}, {
        start: [120, 30], end: [120.001, 30.001], mode: 'normal'
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 8201);
    assert.equal(res.body.success, false);
});

test('admin middleware rejects an unauthenticated route-test request before Gateway use', () => {
    const previousToken = CONFIG.adminToken;
    CONFIG.adminToken = 'test-admin-token';
    const res = response();
    let nextCalled = false;
    try {
        adminMiddleware({ headers: {} }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 9001);
    } finally {
        CONFIG.adminToken = previousToken;
    }
});
