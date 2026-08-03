'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OAuthStateStore } = require('../../services/oauthState');

function deterministicBytes() {
    let counter = 0;
    return size => Buffer.alloc(size, ++counter);
}

test('browser OAuth state is cookie-bound and commits exactly once', () => {
    const store = new OAuthStateStore({
        clock: () => 1000,
        randomBytes: deterministicBytes(),
        ttlMs: 5000
    });
    const issued = store.issue({ kind: 'browser', redirect: '/portal.html?v=1' });

    assert.equal(store.reserve(issued.state, {
        kind: 'browser', boundState: 'wrong-state'
    }), null);
    assert.equal(store.size, 1, 'a forged callback must not consume the valid state');

    const reservation = store.reserve(issued.state, {
        kind: 'browser', boundState: issued.state
    });
    assert.equal(reservation.redirect, '/portal.html?v=1');
    assert.equal(store.reserve(issued.state, {
        kind: 'browser', boundState: issued.state
    }), null, 'a concurrent callback must not reserve the same state');

    const record = store.commit(reservation);
    assert.equal(record.redirect, '/portal.html?v=1');
    assert.equal(store.size, 0);
    assert.equal(store.reserve(issued.state, {
        kind: 'browser', boundState: issued.state
    }), null, 'replayed state must fail');
    assert.equal(store.commit(reservation), null, 'a reservation cannot commit twice');
});

test('QR OAuth reservation is sid-bound, exclusive, and reusable after release', () => {
    const store = new OAuthStateStore({
        clock: () => 2000,
        randomBytes: deterministicBytes()
    });
    const issued = store.issue({ kind: 'qr', subject: 'sid-a' });

    assert.equal(store.reserve(issued.state, { kind: 'qr', subject: 'sid-b' }), null);
    assert.equal(store.size, 1);
    assert.equal(store.reserve(issued.state, { kind: 'browser', boundState: issued.state }), null);
    assert.equal(store.size, 1);

    const first = store.reserve(issued.state, { kind: 'qr', subject: 'sid-a' });
    assert.equal(first.subject, 'sid-a');
    assert.equal(store.reserve(issued.state, { kind: 'qr', subject: 'sid-a' }), null);
    assert.equal(store.commit({ ...first }), null, 'a copied reservation is not authoritative');
    assert.equal(store.release({ ...first }), false, 'a copied reservation cannot unlock the state');
    assert.equal(store.release(first), true);
    assert.equal(store.release(first), false, 'a released reservation cannot be released twice');

    const retry = store.reserve(issued.state, { kind: 'qr', subject: 'sid-a' });
    assert.ok(retry);
    assert.notEqual(retry, first);
    assert.equal(store.commit(first), null, 'an old reservation cannot commit after release');
    assert.equal(store.commit(retry).subject, 'sid-a');
    assert.equal(store.reserve(issued.state, { kind: 'qr', subject: 'sid-a' }), null);
});

test('expired and malformed OAuth states fail without leaving stale records', () => {
    let now = 3000;
    const store = new OAuthStateStore({
        clock: () => now,
        randomBytes: deterministicBytes(),
        ttlMs: 100
    });
    const issued = store.issue({ kind: 'browser', redirect: '/portal.html' });

    assert.equal(store.reserve('', { kind: 'browser', boundState: '' }), null);
    assert.equal(store.reserve(issued.state, { kind: 'invalid', boundState: issued.state }), null);
    now = 3100;
    assert.equal(store.reserve(issued.state, {
        kind: 'browser', boundState: issued.state
    }), null);
    assert.equal(store.size, 0);
});

test('expired reservations cannot commit or return to the available pool', () => {
    let now = 4000;
    const store = new OAuthStateStore({
        clock: () => now,
        randomBytes: deterministicBytes(),
        ttlMs: 100
    });
    const issued = store.issue({ kind: 'qr', subject: 'sid-a' });
    const reservation = store.reserve(issued.state, { kind: 'qr', subject: 'sid-a' });

    now = 4100;
    assert.equal(store.release(reservation), false);
    assert.equal(store.commit(reservation), null);
    assert.equal(store.size, 0);
});

test('issuance cancellation removes only an unreserved OAuth state', () => {
    const store = new OAuthStateStore({
        clock: () => 5000,
        randomBytes: deterministicBytes(),
        ttlMs: 5000
    });
    const browser = store.issue({ kind: 'browser', redirect: '/portal.html' });
    const qr = store.issue({ kind: 'qr', subject: 'sid-a' });

    const cancelled = store.cancel(browser.state);
    assert.equal(cancelled.kind, 'browser');
    assert.equal(cancelled.redirect, '/portal.html');
    assert.equal(store.cancel(browser.state), null);
    assert.equal(store.size, 1);

    const reservation = store.reserve(qr.state, { kind: 'qr', subject: 'sid-a' });
    assert.ok(reservation);
    assert.equal(store.cancel(qr.state), null,
        'an issuance rollback must not cancel an active callback reservation');
    assert.equal(store.size, 1);
    assert.equal(store.release(reservation), true);
    assert.equal(store.cancel(qr.state).subject, 'sid-a');
    assert.equal(store.size, 0);
});

test('constructor and issue reject unsafe configuration', () => {
    assert.throws(() => new OAuthStateStore({ ttlMs: 0 }), /ttlMs/);
    const store = new OAuthStateStore({ randomBytes: deterministicBytes() });
    assert.throws(() => store.issue({ kind: 'unknown' }), /kind/);
    assert.throws(() => store.issue({ kind: 'qr' }), /subject/);
});
