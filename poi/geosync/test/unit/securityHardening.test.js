'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../../config');
const { SessionAuthConfigurationError } = require('../../lib/sessionAuth');
const { wrap } = require('../../lib/respond');
const checkinService = require('../../services/checkinService');

const QR_SECRET = 'Q8rH3mA9cT5kL1pN7vD2sF6jZ4xB0wE9uI3oP5yK';

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('generic route logging strips query credentials and raw error objects', async () => {
    const querySecret = 'screen-secret-sentinel';
    const password = 'password-sentinel';
    const rawBody = 'raw-upstream-body-sentinel';
    const error = new Error('message-secret-sentinel');
    error.name = 'AxiosError';
    error.code = 'ERR_BAD_RESPONSE';
    error.response = {
        data: rawBody,
        config: { auth: { username: 'user-sentinel', password } }
    };
    const req = {
        method: 'GET',
        originalUrl: `/api/test?screenToken=${querySecret}`
    };
    const res = response();
    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(args);
    try {
        await wrap(async () => { throw error; })(req, res, () => {});
    } finally {
        console.error = original;
    }

    const rendered = JSON.stringify(logs);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 9001);
    assert.match(rendered, /\/api\/test/);
    assert.match(rendered, /AxiosError/);
    assert.match(rendered, /ERR_BAD_RESPONSE/);
    for (const forbidden of [querySecret, password, rawBody, 'message-secret-sentinel', 'user-sentinel', '?']) {
        assert.equal(rendered.includes(forbidden), false, `log must omit ${forbidden}`);
    }
});

test('QR HMAC fails closed for blank and known placeholder secrets', () => {
    const previous = CONFIG.hmacSecret;
    try {
        for (const value of ['', 'change-me-to-random-hex']) {
            CONFIG.hmacSecret = value;
            assert.throws(() => checkinService.qrTokenOf('poi-1'), SessionAuthConfigurationError);
            assert.equal(checkinService.verifyQrToken('poi-1.0000000000000000'), null);
        }
    } finally {
        CONFIG.hmacSecret = previous;
    }
});

test('QR HMAC accepts only an exact current-day token with strict framing', () => {
    const previous = CONFIG.hmacSecret;
    const dayOne = new Date('2026-08-02T08:00:00.000Z');
    const dayTwo = new Date('2026-08-03T08:00:00.000Z');
    try {
        CONFIG.hmacSecret = QR_SECRET;
        const signature = checkinService.qrTokenOf('poi-1', dayOne);
        const token = `poi-1.${signature}`;
        assert.equal(checkinService.verifyQrToken(token, dayOne), 'poi-1');
        assert.equal(checkinService.verifyQrToken(token, dayTwo), null);
        assert.equal(checkinService.verifyQrToken(`${token}.extra`, dayOne), null);
        assert.equal(checkinService.verifyQrToken(`poi-1.${signature.slice(0, -1)}0`, dayOne), null);
        assert.equal(checkinService.verifyQrToken(`poi.1.${signature}`, dayOne), null);
    } finally {
        CONFIG.hmacSecret = previous;
    }
});
