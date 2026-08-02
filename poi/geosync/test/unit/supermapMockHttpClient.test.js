'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MockHttpClient = require('../../integrations/supermap/mockHttpClient');
const { MissingMockFixtureError } = MockHttpClient;

function request(overrides = {}) {
    return {
        operation: 'status',
        method: 'get',
        path: '/private/status?token=must-not-be-recorded',
        requestId: 'req-001',
        timeoutMs: 2000,
        data: undefined,
        params: undefined,
        ...overrides
    };
}

test('returns an operation-keyed static response and records sanitized metadata', async () => {
    const response = { status: 200, data: { state: 'online' }, headers: {} };
    const client = new MockHttpClient({ fixtures: { status: response } });

    const actual = await client.request(request({
        method: 'post',
        data: {
            username: 'private-user',
            password: 'private-password',
            coordinates: [[118.123456, 32.123456], [118.2, 32.2]],
            nested: { authorization: 'Bearer private-token', enabled: true }
        },
        params: { apiKey: 'private-key', limit: 100 }
    }));

    assert.strictEqual(actual, response);
    assert.equal(client.history.length, 1);
    assert.equal(client.history[0].operation, 'status');
    assert.equal(client.history[0].method, 'POST');
    assert.equal(client.history[0].requestId, 'req-001');
    assert.deepEqual(client.history[0].payloadMetadata.data.fields.coordinates, {
        type: 'array', count: 2, itemTypes: ['array']
    });
    assert.equal(client.history[0].payloadMetadata.data.fields.username.type, 'redacted');
    assert.equal(client.history[0].payloadMetadata.data.fields.password.type, 'redacted');
    assert.equal(client.history[0].payloadMetadata.data.fields.nested.fields.authorization.type, 'redacted');
    assert.equal(client.history[0].payloadMetadata.params.fields.apiKey.type, 'redacted');

    const serializedHistory = JSON.stringify(client.history);
    for (const secret of [
        'private-user', 'private-password', 'private-token', 'private-key',
        '/private/status', '118.123456'
    ]) {
        assert.equal(serializedHistory.includes(secret), false);
    }
});

test('fixture functions receive the full request and may resolve asynchronously', async () => {
    let received;
    const client = new MockHttpClient({
        fixtures: {
            findPath: async input => {
                received = input;
                return { status: 200, data: { routeId: input.data.routeId }, headers: {} };
            }
        }
    });
    const input = request({
        operation: 'findPath',
        requestId: 'route-42',
        data: { routeId: 'fixture-route' }
    });

    const response = await client.request(input);

    assert.strictEqual(received, input);
    assert.deepEqual(response, {
        status: 200, data: { routeId: 'fixture-route' }, headers: {}
    });
});

test('throws configured Error fixtures without wrapping them', async () => {
    const expected = Object.assign(new Error('deterministic timeout'), { code: 'ETIMEDOUT' });
    const client = new MockHttpClient({ fixtures: { findPath: expected } });

    await assert.rejects(
        client.request(request({ operation: 'findPath' })),
        error => error === expected
    );
    assert.equal(client.history.length, 1);
});

test('uses injected sleep with deterministic per-operation latency', async () => {
    const sleeps = [];
    const client = new MockHttpClient({
        fixtures: { status: { status: 200, data: {}, headers: {} } },
        latencyMs: { status: 17, default: 3 },
        sleep: async ms => sleeps.push(ms)
    });

    await client.request(request());

    assert.deepEqual(sleeps, [17]);
});

test('missing fixtures fail clearly while retaining only sanitized request history', async () => {
    const client = new MockHttpClient();

    await assert.rejects(
        client.request(request({
            operation: 'queryFeatures',
            data: { credential: 'do-not-store' }
        })),
        error => error instanceof MissingMockFixtureError &&
            error.code === 'SUPERMAP_MOCK_FIXTURE_MISSING' &&
            error.operation === 'queryFeatures'
    );

    assert.equal(client.history.length, 1);
    assert.equal(JSON.stringify(client.history).includes('do-not-store'), false);
});

test('supports Map fixtures and explicit history reset', async () => {
    const client = new MockHttpClient({
        fixtures: new Map([['status', { status: 204, data: null, headers: {} }]])
    });

    await client.request(request());
    assert.equal(client.history.length, 1);
    client.clearHistory();
    assert.equal(client.history.length, 0);

    client.setFixture('status', { status: 200, data: { state: 'degraded' }, headers: {} });
    const response = await client.request(request());
    assert.equal(response.status, 200);
});
