'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_COOKIE_NAMES } = require('../../lib/sessionAuth');
const { LEGACY_ADMIN_SESSION_MARKER, createHostAuth } = require('../../services/hostAuth');

const SECRET = 'host-auth-secret-V9x7sQ2pL4mN8cR6tY1uI5oP3aS0';
const ADMIN_TOKEN = 'host-admin-token-R8m3Q7v2N9x5K4p6D1s0F7h2J8c5';
const NOW = Date.parse('2026-08-02T10:00:00.000Z');

function fakeUsers(rows = []) {
    const byOpenId = new Map(rows.map(row => [row.openId, { ...row }]));
    return {
        findOne(filter) {
            return { lean: async () => byOpenId.get(filter.openId) || null };
        }
    };
}

function response() {
    const headers = new Map();
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        getHeader(name) { return headers.get(name.toLowerCase()); },
        setHeader(name, value) { headers.set(name.toLowerCase(), value); },
        headers
    };
}

function cookieValue(setCookie) {
    return String(setCookie).split(';', 1)[0];
}

function makeAuth(overrides = {}) {
    return createHostAuth({
        User: overrides.User || fakeUsers([
            { openId: 'user-a', role: 'collector' },
            { openId: 'reviewer-a', role: 'reviewer' },
            { openId: 'disabled-a', role: 'collector', disabled: true }
        ]),
        sessionSecret: overrides.sessionSecret ?? SECRET,
        adminToken: overrides.adminToken ?? ADMIN_TOKEN,
        adminUsername: 'operator',
        reviewerOpenIds: overrides.reviewerOpenIds ?? ['reviewer-a'],
        cookieSecure: false,
        clock: overrides.clock || (() => NOW),
        production: overrides.production,
        allowLegacyUserHeader: overrides.allowLegacyUserHeader
    });
}

test('user sessions derive the principal server-side and reject identity spoofing', async () => {
    const auth = makeAuth();
    const res = response();
    auth.issueUserSession(res, { openId: 'user-a', role: 'collector' });
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);

    const principal = await auth.authenticateUserRequest({ headers: { cookie } });
    assert.equal(principal.openId, 'user-a');
    assert.equal(principal.role, 'collector');
    await assert.rejects(
        auth.authenticateUserRequest({ headers: { cookie, 'x-open-id': 'reviewer-a' } }),
        error => error.code === 'USER_IDENTITY_MISMATCH' && error.httpStatus === 403
    );
    await assert.rejects(
        auth.authenticateUserRequest({ headers: { 'x-open-id': 'user-a' } }),
        error => error.code === 'USER_AUTH_REQUIRED'
    );
});

test('legacy X-Open-Id requires an explicit non-production compatibility mode', async () => {
    const development = makeAuth({ allowLegacyUserHeader: true, sessionSecret: '' });
    assert.equal((await development.authenticateUserRequest({
        headers: { 'x-open-id': 'user-a' }
    })).openId, 'user-a');

    const production = makeAuth({
        allowLegacyUserHeader: true,
        production: true,
        sessionSecret: ''
    });
    await assert.rejects(
        production.authenticateUserRequest({ headers: { 'x-open-id': 'user-a' } }),
        error => error.code === 'SESSION_AUTH_UNAVAILABLE' && error.httpStatus === 503
    );
});

test('admin auth accepts only a valid Bearer token or signed cookie, never the UI marker alone', () => {
    const auth = makeAuth();
    assert.equal(auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    }).source, 'bearer');

    const res = response();
    auth.issueAdminSession(res);
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    assert.equal(auth.authenticateAdminRequest({ headers: { cookie } }).source, 'cookie');
    assert.equal(auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}`, cookie }
    }).source, 'cookie');
    assert.throws(() => auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}` }
    }), error => error.code === 'ADMIN_AUTH_REQUIRED');
    assert.throws(() => auth.authenticateAdminRequest({
        headers: { authorization: 'Bearer wrong-token' }
    }), error => error.code === 'ADMIN_CREDENTIAL_INVALID');

    const weakTokenAuth = makeAuth({ adminToken: 'super-admin-token' });
    assert.throws(() => weakTokenAuth.authenticateAdminRequest({
        headers: { authorization: 'Bearer super-admin-token' }
    }), error => error.code === 'ADMIN_CREDENTIAL_INVALID');
});

test('admin query and body tokens are ignored', () => {
    const auth = makeAuth();
    assert.throws(() => auth.authenticateAdminRequest({
        headers: {}, query: { adminToken: ADMIN_TOKEN }, body: { adminToken: ADMIN_TOKEN }
    }), error => error.code === 'ADMIN_AUTH_REQUIRED');
});

test('reviewer middleware rejects collectors and accepts verified reviewers or admins', async () => {
    const auth = makeAuth();
    const reviewerRes = response();
    auth.issueUserSession(reviewerRes, { openId: 'reviewer-a', role: 'reviewer' });
    const reviewerCookie = cookieValue(reviewerRes.getHeader('Set-Cookie')[0]);
    let reviewerNext = false;
    const reviewerReq = { headers: { cookie: reviewerCookie } };
    await auth.requireReviewerOrAdmin(reviewerReq, response(), () => { reviewerNext = true; });
    assert.equal(reviewerNext, true);
    assert.equal(reviewerReq.openId, 'reviewer-a');

    const collectorRes = response();
    auth.issueUserSession(collectorRes, { openId: 'user-a', role: 'collector' });
    const denied = response();
    await auth.requireReviewerOrAdmin({
        headers: { cookie: cookieValue(collectorRes.getHeader('Set-Cookie')[0]) }
    }, denied, () => assert.fail('collector must not pass reviewer auth'));
    assert.equal(denied.statusCode, 403);

    const untrusted = makeAuth({ reviewerOpenIds: [] });
    const untrustedRes = response();
    untrusted.issueUserSession(untrustedRes, { openId: 'reviewer-a', role: 'reviewer' });
    const untrustedPrincipal = await untrusted.authenticateUserRequest({
        headers: { cookie: cookieValue(untrustedRes.getHeader('Set-Cookie')[0]) }
    });
    assert.equal(untrustedPrincipal.role, 'collector');
    const reviewerDenied = response();
    await untrusted.requireReviewerOrAdmin({
        headers: { cookie: cookieValue(untrustedRes.getHeader('Set-Cookie')[0]) }
    }, reviewerDenied, () => assert.fail('non-allowlisted reviewer row must not pass'));
    assert.equal(reviewerDenied.statusCode, 403);
});

test('socket authentication rejects query-only identities and derives current DB roles', async () => {
    const auth = makeAuth();
    await assert.rejects(auth.authenticateSocket({
        handshake: { headers: {}, auth: {}, query: { openId: 'reviewer-a' } }
    }), error => error.code === 'SOCKET_AUTH_REQUIRED');

    const res = response();
    auth.issueUserSession(res, { openId: 'reviewer-a', role: 'collector' });
    const identity = await auth.authenticateSocket({
        handshake: {
            headers: { cookie: cookieValue(res.getHeader('Set-Cookie')[0]) },
            auth: {},
            query: { openId: 'reviewer-a' }
        }
    });
    assert.equal(identity.openId, 'reviewer-a');
    assert.equal(identity.role, 'reviewer', 'the session claim must not override the database role');

    await assert.rejects(auth.authenticateSocket({
        handshake: {
            headers: { cookie: cookieValue(res.getHeader('Set-Cookie')[0]) },
            auth: {},
            query: { openId: 'user-a' }
        }
    }), error => error.code === 'USER_IDENTITY_MISMATCH');
});

test('socket identities can carry both verified user and administrator authorization', async () => {
    const auth = makeAuth();
    const userRes = response();
    const adminRes = response();
    auth.issueUserSession(userRes, { openId: 'user-a', role: 'collector' });
    auth.issueAdminSession(adminRes);
    const userCookie = cookieValue(userRes.getHeader('Set-Cookie')[0]);
    const adminCookie = cookieValue(adminRes.getHeader('Set-Cookie')[0]);

    const identity = await auth.authenticateSocket({
        handshake: {
            headers: { cookie: `${userCookie}; ${adminCookie}` },
            auth: {},
            query: { openId: 'user-a' }
        }
    });
    assert.equal(identity.isAdmin, true);
    assert.equal(identity.openId, 'user-a');
    const refreshed = await auth.getSocketIdentity({ authIdentity: identity });
    assert.equal(refreshed.isAdmin, true);
    assert.equal(refreshed.role, 'collector');
});

test('socket identity refresh removes capabilities after signed sessions expire', async () => {
    let now = NOW;
    const auth = makeAuth({ clock: () => now });
    const userRes = response();
    const adminRes = response();
    auth.issueUserSession(userRes, { openId: 'user-a', role: 'collector' });
    auth.issueAdminSession(adminRes);
    const identity = await auth.authenticateSocket({
        handshake: {
            headers: {
                cookie: `${cookieValue(userRes.getHeader('Set-Cookie')[0])}; `
                    + cookieValue(adminRes.getHeader('Set-Cookie')[0])
            },
            auth: {},
            query: { openId: 'user-a' }
        }
    });

    now += 31 * 24 * 60 * 60 * 1000;
    assert.equal(await auth.getSocketIdentity({ authIdentity: identity }), null);
});

test('disabled or deleted users are rejected and session cookies clear safely', async () => {
    const auth = makeAuth();
    const disabledRes = response();
    auth.issueUserSession(disabledRes, { openId: 'disabled-a', role: 'collector' });
    await assert.rejects(auth.authenticateUserRequest({
        headers: { cookie: cookieValue(disabledRes.getHeader('Set-Cookie')[0]) }
    }), error => error.code === 'USER_AUTH_INVALID');

    const res = response();
    auth.clearUserSession(res);
    auth.clearAdminSession(res);
    const cookies = res.getHeader('Set-Cookie');
    assert.equal(cookies.length, 2);
    assert.match(cookies[0], new RegExp(`^${DEFAULT_COOKIE_NAMES.user}=`));
    assert.match(cookies[0], /Max-Age=0/);
    assert.match(cookies[1], new RegExp(`^${DEFAULT_COOKIE_NAMES.admin}=`));
});
