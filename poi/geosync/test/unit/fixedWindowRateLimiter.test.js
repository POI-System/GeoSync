'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixedWindowRateLimiter } = require('../../services/fixedWindowRateLimiter');

test('fixed-window limiter rejects excess attempts and resets after the window', () => {
    let now = Date.parse('2026-08-02T12:00:00.000Z');
    const limiter = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxAttempts: 2,
        clock: () => now
    });

    assert.deepEqual(limiter.consume('client-a'), {
        allowed: true, remaining: 1, retryAfterSec: 0
    });
    assert.deepEqual(limiter.consume('client-a'), {
        allowed: true, remaining: 0, retryAfterSec: 0
    });
    const rejected = limiter.consume('client-a');
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterSec, 60);

    now += 60 * 1000;
    assert.equal(limiter.consume('client-a').allowed, true);
});

test('fixed-window limiter fails closed at key capacity without evicting existing counters', () => {
    let now = Date.parse('2026-08-03T12:00:00.000Z');
    const limiter = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxAttempts: 1,
        maxKeys: 2,
        clock: () => now
    });
    assert.equal(limiter.consume('client-a').allowed, true);
    assert.equal(limiter.consume('client-b').allowed, true);
    assert.deepEqual(limiter.consume('client-c'), {
        allowed: false,
        remaining: 0,
        retryAfterSec: 60
    });
    assert.equal(limiter.size, 2);
    assert.equal(limiter.consume('client-a').allowed, false, 'client-a was not evicted');

    limiter.clear('client-a');
    assert.equal(limiter.size, 1);
    assert.equal(limiter.consume('client-c').allowed, true);
    assert.equal(limiter.size, 2);

    now += 60 * 1000;
    assert.equal(limiter.size, 0);
    assert.equal(limiter.consume('client-d').allowed, true);
});
