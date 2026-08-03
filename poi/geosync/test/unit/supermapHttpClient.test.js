'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ERROR_DEFINITIONS,
    SuperMapError,
    IServerTimeoutError,
    NoRouteError,
    GeometryNormalizationError,
    toSuperMapError
} = require('../../integrations/supermap/errors');
const {
    SuperMapHttpClient,
    DEFAULT_MAX_RESPONSE_BYTES
} = require('../../integrations/supermap/httpClient');

function axiosError({ code, status, data, request = true, message = 'transport failed' } = {}) {
    const error = new Error(message);
    if (code !== undefined) error.code = code;
    if (status !== undefined) error.response = { status, data };
    if (request) error.request = { sent: true };
    return error;
}

function fakeAxios(sequence) {
    const steps = [...sequence];
    const calls = [];
    return {
        calls,
        async request(config) {
            calls.push(config);
            const step = steps.shift();
            if (step instanceof Error) throw step;
            return typeof step === 'function' ? step(config) : step;
        }
    };
}

function makeClient(axios, overrides = {}) {
    return new SuperMapHttpClient({
        axios,
        baseURL: 'http://127.0.0.1:8090/iserver',
        timeoutMs: 5000,
        maxRetries: 1,
        retryDelayMs: 25,
        sleep: async () => {},
        ...overrides
    });
}

test('8201-8206 definitions expose the required HTTP statuses', () => {
    assert.deepEqual(
        Object.fromEntries(Object.entries(ERROR_DEFINITIONS).map(([code, value]) => [code, value.httpStatus])),
        { 8201: 503, 8202: 504, 8203: 422, 8204: 422, 8205: 409, 8206: 502 }
    );
    assert.equal(new NoRouteError().code, 8204);
    assert.equal(new GeometryNormalizationError().httpStatus, 502);
});

test('toSuperMapError preserves typed errors and maps explicit upstream codes', () => {
    const existing = new IServerTimeoutError();
    assert.equal(toSuperMapError(existing), existing);

    const mapped = toSuperMapError(axiosError({
        status: 422,
        data: { code: 8204, message: 'raw upstream body must not escape' }
    }), { operation: 'findPath', requestId: 'gis-1' });
    assert.equal(mapped.code, 8204);
    assert.equal(mapped.httpStatus, 422);
    assert.equal(mapped.retryable, false);
    assert.equal(mapped.operation, 'findPath');
    assert.equal(mapped.requestId, 'gis-1');
    assert.equal(JSON.stringify(mapped).includes('raw upstream body'), false);

    for (const [code, status] of [[8203, 422], [8206, 502]]) {
        const rawMarker = `raw-upstream-${code}`;
        const domainError = toSuperMapError(axiosError({
            status,
            data: { code, detail: rawMarker }
        }), { operation: 'findPath', requestId: `gis-${code}` });
        assert.equal(domainError.code, code);
        assert.equal(domainError.retryable, false);
        assert.equal(JSON.stringify(domainError).includes(rawMarker), false);
    }
});

test('transport mapping distinguishes retryable timeout and non-retryable failures', () => {
    const timeout = toSuperMapError(axiosError({ code: 'ETIMEDOUT' }));
    assert.equal(timeout.code, 8202);
    assert.equal(timeout.retryable, true);

    const auth = toSuperMapError(axiosError({ status: 401, data: { token: 'do-not-copy' } }));
    assert.equal(auth.code, 8201);
    assert.equal(auth.category, 'auth');
    assert.equal(auth.retryable, false);
    assert.equal(JSON.stringify(auth).includes('do-not-copy'), false);

    const parameter = toSuperMapError(axiosError({ status: 400 }));
    assert.equal(parameter.code, 8205);
    assert.equal(parameter.category, 'parameter');
    assert.equal(parameter.retryable, false);
});

test('request sends base URL, Basic auth, requestId, timeout and payload only through Axios config', async () => {
    const response = { status: 200, data: { ok: true }, headers: {} };
    const axios = fakeAxios([response]);
    const client = makeClient(axios, { username: 'server-user', password: 'server-pass' });

    const result = await client.request({
        operation: 'queryFeatures',
        method: 'post',
        path: '/services/data/query',
        requestId: 'gis-req-1',
        timeoutMs: 1234,
        data: { dataset: 'poi' },
        params: { returnContent: true }
    });

    assert.equal(result, response);
    assert.equal(axios.calls.length, 1);
    assert.deepEqual(axios.calls[0], {
        baseURL: 'http://127.0.0.1:8090/iserver',
        url: '/services/data/query',
        method: 'POST',
        timeout: 1234,
        maxRedirects: 0,
        maxContentLength: DEFAULT_MAX_RESPONSE_BYTES,
        headers: { 'X-Request-Id': 'gis-req-1' },
        data: { dataset: 'poi' },
        params: { returnContent: true },
        auth: { username: 'server-user', password: 'server-pass' }
    });
    assert.equal(Object.hasOwn(axios.calls[0].headers, 'Authorization'), false);
});

test('response size limits are configurable while redirects always remain disabled', async () => {
    const axios = fakeAxios([{ status: 200, data: {} }]);
    const client = makeClient(axios, { maxResponseBytes: 2048 });

    await client.request({ operation: 'health', path: '/health' });

    assert.equal(axios.calls[0].maxContentLength, 2048);
    assert.equal(axios.calls[0].maxRedirects, 0);
});

test('credentials are omitted when server-side Basic auth is not configured', async () => {
    const axios = fakeAxios([{ status: 200, data: {} }]);
    const client = makeClient(axios, { username: '', password: '' });
    await client.request({ operation: 'health', path: '/health' });
    assert.equal(Object.hasOwn(axios.calls[0], 'auth'), false);
});

test('remote cleartext HTTP endpoints cannot receive Basic credentials', () => {
    const axios = fakeAxios([]);
    assert.throws(
        () => makeClient(axios, {
            baseURL: 'http://iserver.example.invalid',
            username: 'server-user',
            password: 'server-pass'
        }),
        /requires HTTPS/
    );
    assert.equal(axios.calls.length, 0);
});

test('request IDs are normalized before being placed in HTTP headers', async () => {
    const axios = fakeAxios([{ status: 200, data: {} }]);
    const client = makeClient(axios);

    await client.request({
        operation: 'health',
        path: '/health',
        requestId: 'unsafe\r\nrequest id'
    });

    assert.equal(axios.calls[0].headers['X-Request-Id'], 'unsafe__request_id');
});

test('connection errors retry once using injected sleep and then return the successful response', async () => {
    const axios = fakeAxios([
        axiosError({ code: 'ECONNRESET' }),
        { status: 200, data: { recovered: true } }
    ]);
    const sleeps = [];
    const client = makeClient(axios, {
        maxRetries: 9,
        sleep: async ms => sleeps.push(ms)
    });

    const response = await client.request({ operation: 'getStatus', path: '/status' });
    assert.equal(response.data.recovered, true);
    assert.equal(axios.calls.length, 2);
    assert.deepEqual(sleeps, [25]);
});

test('retry attempts receive only the remaining total timeout budget', async () => {
    let now = 100;
    const timeouts = [];
    const sleeps = [];
    const axios = {
        async request(config) {
            timeouts.push(config.timeout);
            if (timeouts.length === 1) {
                now = 450;
                throw axiosError({ code: 'ECONNRESET' });
            }
            return { status: 200, data: { recovered: true } };
        }
    };
    const client = makeClient(axios, {
        now: () => now,
        retryDelayMs: 50,
        sleep: async ms => {
            sleeps.push(ms);
            now += ms;
        }
    });

    const response = await client.request({
        operation: 'queryFeatures',
        path: '/data/query',
        timeoutMs: 1000
    });

    assert.equal(response.data.recovered, true);
    assert.deepEqual(timeouts, [1000, 600]);
    assert.deepEqual(sleeps, [50]);
});

test('an exhausted first attempt does not start a retry after the total deadline', async () => {
    let now = 0;
    let calls = 0;
    let sleeps = 0;
    const axios = {
        async request(config) {
            calls++;
            assert.equal(config.timeout, 100);
            now = 100;
            throw axiosError({ code: 'ECONNRESET' });
        }
    };
    const client = makeClient(axios, {
        now: () => now,
        retryDelayMs: 0,
        sleep: async () => { sleeps++; }
    });

    await assert.rejects(
        client.request({ operation: 'queryFeatures', path: '/data/query', timeoutMs: 100 }),
        error => error.code === 8202
            && error.category === 'timeout-budget'
            && error.retryable === false
    );
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
});

test('one retry is enabled by default and ordinary 5xx failures are classified separately', async () => {
    const axios = fakeAxios([
        axiosError({ status: 500 }),
        axiosError({ status: 500 })
    ]);
    const client = new SuperMapHttpClient({
        axios,
        baseURL: 'http://127.0.0.1:8090',
        sleep: async () => {}
    });

    await assert.rejects(
        client.request({ operation: 'queryFeatures', path: '/data/query' }),
        error => error.code === 8201 && error.category === 'upstream-5xx'
    );
    assert.equal(axios.calls.length, 2);
});

test('timeout retries at most once and throws sanitized 8202', async () => {
    const secret = 'credential-that-must-not-escape';
    const axios = fakeAxios([
        axiosError({ code: 'ECONNABORTED', message: secret }),
        axiosError({ status: 504, data: { raw: secret } })
    ]);
    const client = makeClient(axios);

    await assert.rejects(
        client.request({ operation: 'findPath', path: '/network/path', requestId: 'gis-timeout' }),
        error => {
            assert.equal(error.code, 8202);
            assert.equal(error.httpStatus, 504);
            assert.equal(error.retryable, true);
            assert.equal(error.requestId, 'gis-timeout');
            assert.equal(JSON.stringify(error).includes(secret), false);
            return true;
        }
    );
    assert.equal(axios.calls.length, 2);
});

test('5xx retries once while cancellation and domain failures never retry', async t => {
    await t.test('503 gateway failure retries', async () => {
        const axios = fakeAxios([
            axiosError({ status: 503 }),
            { status: 200, data: { ok: true } }
        ]);
        const response = await makeClient(axios).request({ operation: 'getStatus', path: '/status' });
        assert.equal(response.status, 200);
        assert.equal(axios.calls.length, 2);
    });

    for (const scenario of [
        { name: 'cancellation', error: axiosError({ code: 'ERR_CANCELED' }), code: 8201 },
        { name: 'auth', error: axiosError({ status: 403 }), code: 8201 },
        { name: 'parameter', error: axiosError({ status: 400 }), code: 8205 },
        { name: 'contract', error: axiosError({ status: 409 }), code: 8205 },
        { name: 'snap', error: axiosError({ status: 422, data: { code: 8203 } }), code: 8203 },
        { name: 'no-route', error: axiosError({ status: 422, data: { code: 8204 } }), code: 8204 },
        { name: 'geometry', error: axiosError({ status: 502, data: { code: 8206 } }), code: 8206 }
    ]) {
        await t.test(`${scenario.name} failure does not retry`, async () => {
            const axios = fakeAxios([scenario.error, { status: 200 }]);
            await assert.rejects(
                makeClient(axios).request({ operation: 'findPath', path: '/network/path' }),
                error => error instanceof SuperMapError && error.code === scenario.code
            );
            assert.equal(axios.calls.length, 1);
        });
    }
});

test('absolute or protocol-relative request paths are rejected before Axios receives credentials', async () => {
    for (const path of ['https://attacker.invalid/collect', '//attacker.invalid/collect']) {
        const axios = fakeAxios([{ status: 200 }]);
        const client = makeClient(axios, { username: 'server-user', password: 'server-pass' });
        await assert.rejects(
            client.request({ operation: 'queryFeatures', path }),
            error => error.code === 8205 && error.retryable === false
        );
        assert.equal(axios.calls.length, 0);
    }
});
