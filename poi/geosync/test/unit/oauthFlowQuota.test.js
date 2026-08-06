'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OAuthFlowQuota } = require('../../services/oauthFlowQuota');

test('browser and QR flows share the per-network pending quota', () => {
    let now = 1000;
    const quota = new OAuthFlowQuota({
        clock: () => now,
        ttlMs: 5000,
        maxTotal: 4,
        maxPerNetwork: 2
    });

    const browser = quota.tryAcquire({ networkKey: 'NETWORK-A', kind: 'browser' });
    const qr = quota.tryAcquire({ networkKey: 'network-a', kind: 'qr' });
    const blocked = quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' });

    assert.equal(browser.allowed, true);
    assert.equal(qr.allowed, true);
    assert.deepEqual(blocked, {
        allowed: false,
        reason: 'network',
        retryAfterSec: 5
    });
    assert.equal(quota.countFor('network-a'), 2);

    now = 1500;
    const independent = quota.tryAcquire({ networkKey: 'network-b', kind: 'qr' });
    assert.equal(independent.allowed, true);
    assert.equal(quota.countFor('network-b'), 1);
    assert.equal(quota.size, 3);
});

test('global pending quota applies across independent networks', () => {
    const quota = new OAuthFlowQuota({
        clock: () => 2000,
        ttlMs: 5000,
        maxTotal: 2,
        maxPerNetwork: 2
    });

    assert.equal(quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' }).allowed, true);
    assert.equal(quota.tryAcquire({ networkKey: 'network-b', kind: 'qr' }).allowed, true);
    assert.deepEqual(
        quota.tryAcquire({ networkKey: 'network-c', kind: 'browser' }),
        { allowed: false, reason: 'global', retryAfterSec: 5 }
    );
});

test('only the exact lease releases one pending flow', () => {
    const quota = new OAuthFlowQuota({
        clock: () => 3000,
        ttlMs: 5000,
        maxTotal: 3,
        maxPerNetwork: 2
    });
    const acquired = quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' });

    assert.equal(quota.release({ ...acquired.lease }), false,
        'a copied lease must not release the authoritative flow');
    assert.equal(quota.size, 1);
    assert.equal(quota.countFor('network-a'), 1);
    assert.equal(quota.release(acquired.lease), true);
    assert.equal(quota.release(acquired.lease), false,
        'an authoritative lease can be released only once');
    assert.equal(quota.size, 0);
    assert.equal(quota.countFor('network-a'), 0);
});

test('expiry pruning decrements total and per-network counts', () => {
    let now = 4000;
    const quota = new OAuthFlowQuota({
        clock: () => now,
        ttlMs: 1000,
        maxTotal: 3,
        maxPerNetwork: 2
    });
    quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' });
    quota.tryAcquire({ networkKey: 'network-a', kind: 'qr' });

    now = 5000;
    assert.equal(quota.size, 0);
    assert.equal(quota.countFor('network-a'), 0);
    assert.equal(quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' }).allowed, true);
});

test('Retry-After uses the earliest relevant expiry and remains bounded', () => {
    let now = 6000;
    const quota = new OAuthFlowQuota({
        clock: () => now,
        ttlMs: 5000,
        maxTotal: 4,
        maxPerNetwork: 2
    });
    quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' });
    now = 7500;
    quota.tryAcquire({ networkKey: 'network-a', kind: 'qr' });
    now = 8500;

    const blocked = quota.tryAcquire({ networkKey: 'network-a', kind: 'browser' });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSec, 3);
    assert.ok(blocked.retryAfterSec >= 1);
    assert.ok(blocked.retryAfterSec <= 5);
});

test('invalid quota configuration and acquisition input fail closed', () => {
    assert.throws(() => new OAuthFlowQuota({
        ttlMs: 999, maxTotal: 1, maxPerNetwork: 1
    }), /ttlMs/);
    assert.throws(() => new OAuthFlowQuota({
        ttlMs: 1000, maxTotal: 0, maxPerNetwork: 1
    }), /maxTotal/);
    assert.throws(() => new OAuthFlowQuota({
        ttlMs: 1000, maxTotal: 2, maxPerNetwork: 3
    }), /maxPerNetwork/);

    const quota = new OAuthFlowQuota({
        ttlMs: 1000,
        maxTotal: 2,
        maxPerNetwork: 1
    });
    assert.throws(() => quota.tryAcquire({ networkKey: 'network-a', kind: 'invalid' }), /kind/);
    assert.throws(() => quota.tryAcquire({ networkKey: '', kind: 'browser' }), /network key/);
    assert.throws(() => quota.tryAcquire({ networkKey: 'x'.repeat(129), kind: 'qr' }), /network key/);
    assert.equal(quota.size, 0);
});
