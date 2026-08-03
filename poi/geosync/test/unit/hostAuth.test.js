'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    DEFAULT_HEADER_NAMES,
    verifySessionToken
} = require('../../lib/sessionAuth');
const {
    LEGACY_ADMIN_SESSION_MARKER,
    createGlobalLogoutHandler,
    createHostAuth
} = require('../../services/hostAuth');
const { hashAdminSessionId } = require('../../services/adminSessionRevocation');
const { hashUserSessionId } = require('../../services/userSessionRevocation');

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

function fakeRevocations(options = {}) {
    const records = options.records || new Map();
    const writes = [];
    return {
        records,
        writes,
        findOne(filter) {
            return {
                lean: async () => {
                    if (options.readError) throw options.readError;
                    return records.has(filter._id) ? { _id: filter._id } : null;
                }
            };
        },
        async updateOne(filter, update) {
            if (options.writeError) throw options.writeError;
            writes.push({ filter, update });
            records.set(filter._id, { ...update.$setOnInsert });
            return { acknowledged: true, upsertedCount: 1 };
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
        AdminSessionRevocation: overrides.AdminSessionRevocation || fakeRevocations(),
        UserSessionRevocation: overrides.UserSessionRevocation || fakeRevocations(),
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

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

async function close(server) {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function request(server, { method = 'GET', path = '/', headers = {} } = {}) {
    const address = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            method,
            path,
            headers
        }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                let json = null;
                try {
                    json = body ? JSON.parse(body) : null;
                } catch {
                    json = null;
                }
                resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
            });
        });
        req.once('error', reject);
        req.end();
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
    for (const request of [{
        headers: { cookie }, body: { openId: 'reviewer-a' }
    }, {
        headers: { cookie }, query: { openid: 'reviewer-a' }
    }, {
        headers: { cookie }, body: { userOpenId: 'reviewer-a' }
    }]) {
        await assert.rejects(
            auth.authenticateUserRequest(request),
            error => error.code === 'USER_IDENTITY_MISMATCH' && error.httpStatus === 403
        );
    }
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

test('user logout persists a hashed jti and invalidates HTTP and Socket authorization', async () => {
    const revocations = fakeRevocations();
    const auth = makeAuth({ UserSessionRevocation: revocations });
    const res = response();
    const token = auth.issueUserSession(res, { openId: 'user-a', role: 'collector' });
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    const principal = await auth.authenticateUserRequest({ headers: { cookie } });
    const socketIdentity = await auth.authenticateSocket({
        handshake: { headers: { cookie }, auth: {}, query: { openId: 'user-a' } }
    });

    assert.equal(await auth.revokeUserSession({ headers: { cookie } }), true);
    assert.equal(revocations.writes.length, 1);
    assert.equal(revocations.writes[0].filter._id, hashUserSessionId(principal.sessionId));
    assert.equal(JSON.stringify(revocations.writes).includes(principal.sessionId), false);
    assert.equal(JSON.stringify(revocations.writes).includes(token), false);
    assert.ok(revocations.writes[0].update.$setOnInsert.expiresAt instanceof Date);

    await assert.rejects(
        auth.authenticateUserRequest({ headers: { cookie } }),
        error => error.code === 'USER_SESSION_REVOKED' && error.httpStatus === 401
    );
    await assert.rejects(
        auth.authenticateSocket({
            handshake: { headers: { cookie }, auth: {}, query: { openId: 'user-a' } }
        }),
        error => error.code === 'USER_SESSION_REVOKED'
    );
    assert.equal(await auth.getSocketIdentity({ authIdentity: socketIdentity }), null);

    const restartedAuth = makeAuth({ UserSessionRevocation: fakeRevocations({
        records: revocations.records
    }) });
    await assert.rejects(
        restartedAuth.authenticateUserRequest({ headers: { cookie } }),
        error => error.code === 'USER_SESSION_REVOKED'
    );
});

test('user signed sessions fail closed when revocation storage is unavailable', async () => {
    const readFailure = makeAuth({
        UserSessionRevocation: fakeRevocations({ readError: new Error('database detail') })
    });
    const res = response();
    readFailure.issueUserSession(res, { openId: 'user-a', role: 'collector' });
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    await assert.rejects(
        readFailure.authenticateUserRequest({ headers: { cookie } }),
        error => error.code === 'USER_SESSION_REVOCATION_UNAVAILABLE' && error.httpStatus === 503
    );

    const writeFailure = makeAuth({
        UserSessionRevocation: fakeRevocations({ writeError: new Error('database detail') })
    });
    const writeRes = response();
    writeFailure.issueUserSession(writeRes, { openId: 'user-a', role: 'collector' });
    await assert.rejects(
        writeFailure.revokeUserSession({
            headers: { cookie: cookieValue(writeRes.getHeader('Set-Cookie')[0]) }
        }),
        error => error.code === 'USER_SESSION_REVOCATION_UNAVAILABLE' && error.httpStatus === 503
    );
});

test('user logout revokes distinct cookie, header, and Bearer sessions', async () => {
    const revocations = fakeRevocations();
    const auth = makeAuth({ UserSessionRevocation: revocations });
    const cookieRes = response();
    const headerRes = response();
    const bearerRes = response();
    const cookieToken = auth.issueUserSession(cookieRes, { openId: 'user-a', role: 'collector' });
    const headerToken = auth.issueUserSession(headerRes, { openId: 'user-a', role: 'collector' });
    const bearerToken = auth.issueUserSession(bearerRes, { openId: 'user-a', role: 'collector' });
    const cookie = cookieValue(cookieRes.getHeader('Set-Cookie')[0]);
    const claims = [cookieToken, headerToken, bearerToken].map(token => verifySessionToken(token, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.USER,
        now: NOW
    }));

    assert.equal(await auth.revokeUserSession({
        headers: {
            cookie,
            [DEFAULT_HEADER_NAMES.user]: headerToken
        }
    }), true);
    assert.deepEqual(new Set(revocations.writes.map(write => write.filter._id)), new Set([
        hashUserSessionId(claims[0].sessionId),
        hashUserSessionId(claims[1].sessionId)
    ]));

    assert.equal(await auth.revokeUserSession({
        headers: { authorization: `Bearer ${bearerToken}` }
    }), true);
    assert.equal(revocations.records.has(hashUserSessionId(claims[2].sessionId)), true);

    await assert.rejects(
        auth.authenticateUserRequest({ headers: { cookie } }),
        error => error.code === 'USER_SESSION_REVOKED'
    );
    await assert.rejects(
        auth.authenticateUserRequest({
            headers: { [DEFAULT_HEADER_NAMES.user]: headerToken }
        }),
        error => error.code === 'USER_SESSION_REVOKED'
    );
});

test('POST /api/auth/logout revokes and rejects replayed user and admin sessions', async () => {
    const userRevocations = fakeRevocations();
    const adminRevocations = fakeRevocations();
    const auth = makeAuth({
        UserSessionRevocation: userRevocations,
        AdminSessionRevocation: adminRevocations
    });
    const cookieRes = response();
    const headerRes = response();
    const adminRes = response();
    const cookieToken = auth.issueUserSession(cookieRes, { openId: 'user-a', role: 'collector' });
    const headerToken = auth.issueUserSession(headerRes, { openId: 'user-a', role: 'collector' });
    const adminToken = auth.issueAdminSession(adminRes);
    const userCookie = cookieValue(cookieRes.getHeader('Set-Cookie')[0]);
    const adminCookie = cookieValue(adminRes.getHeader('Set-Cookie')[0]);
    const claims = [cookieToken, headerToken].map(token => verifySessionToken(token, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.USER,
        now: NOW
    }));
    const adminClaims = verifySessionToken(adminToken, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.ADMIN,
        now: NOW
    });

    const app = express();
    app.post('/api/auth/logout', createGlobalLogoutHandler(auth));
    app.get('/protected', auth.requireUser, (_req, res) => res.json({ success: true }));
    app.get('/admin-protected', auth.requireAdmin, (_req, res) => res.json({ success: true }));
    const server = http.createServer(app);
    await listen(server);
    try {
        const logout = await request(server, {
            method: 'POST',
            path: '/api/auth/logout',
            headers: {
                cookie: `${userCookie}; ${adminCookie}`,
                [DEFAULT_HEADER_NAMES.user]: headerToken
            }
        });
        assert.equal(logout.statusCode, 200);
        assert.deepEqual(logout.json, {
            success: true,
            userSessionRevoked: true,
            adminSessionRevoked: true
        });
        assert.equal(logout.headers['cache-control'], 'no-store');
        assert.ok(logout.headers['set-cookie']?.some(value =>
            value.startsWith(`${DEFAULT_COOKIE_NAMES.user}=`) && value.includes('Max-Age=0')));
        assert.ok(logout.headers['set-cookie']?.some(value =>
            value.startsWith(`${DEFAULT_COOKIE_NAMES.admin}=`) && value.includes('Max-Age=0')));
        assert.deepEqual(new Set(userRevocations.writes.map(write => write.filter._id)), new Set([
            hashUserSessionId(claims[0].sessionId),
            hashUserSessionId(claims[1].sessionId)
        ]));
        assert.equal(adminRevocations.writes[0].filter._id,
            hashAdminSessionId(adminClaims.sessionId));

        const cookieReplay = await request(server, {
            path: '/protected',
            headers: { cookie: userCookie }
        });
        assert.equal(cookieReplay.statusCode, 401);
        const headerReplay = await request(server, {
            path: '/protected',
            headers: { [DEFAULT_HEADER_NAMES.user]: headerToken }
        });
        assert.equal(headerReplay.statusCode, 401);
        const adminReplay = await request(server, {
            path: '/admin-protected',
            headers: { cookie: adminCookie }
        });
        assert.equal(adminReplay.statusCode, 403);
    } finally {
        await close(server);
    }
});

test('POST /api/auth/logout clears only the credential class whose revocation completed', async () => {
    const userRevocations = fakeRevocations({ writeError: new Error('private database detail') });
    const adminRevocations = fakeRevocations();
    const auth = makeAuth({
        UserSessionRevocation: userRevocations,
        AdminSessionRevocation: adminRevocations
    });
    const userRes = response();
    const adminRes = response();
    auth.issueUserSession(userRes, { openId: 'user-a', role: 'collector' });
    auth.issueAdminSession(adminRes);
    const userCookie = cookieValue(userRes.getHeader('Set-Cookie')[0]);
    const adminCookie = cookieValue(adminRes.getHeader('Set-Cookie')[0]);

    const app = express();
    app.post('/api/auth/logout', createGlobalLogoutHandler(auth));
    app.get('/protected', auth.requireUser, (_req, res) => res.json({ success: true }));
    app.get('/admin-protected', auth.requireAdmin, (_req, res) => res.json({ success: true }));
    const server = http.createServer(app);
    await listen(server);
    try {
        const logout = await request(server, {
            method: 'POST',
            path: '/api/auth/logout',
            headers: { cookie: `${userCookie}; ${adminCookie}` }
        });
        assert.equal(logout.statusCode, 503);
        assert.equal(logout.json.userSessionCleared, false);
        assert.equal(logout.json.adminSessionCleared, true);
        assert.equal(logout.body.includes('private database detail'), false);
        assert.equal(logout.headers['set-cookie']?.some(value =>
            value.startsWith(`${DEFAULT_COOKIE_NAMES.user}=`)), false);
        assert.equal(logout.headers['set-cookie']?.some(value =>
            value.startsWith(`${DEFAULT_COOKIE_NAMES.admin}=`) && value.includes('Max-Age=0')), true);

        const userStillValid = await request(server, {
            path: '/protected',
            headers: { cookie: userCookie }
        });
        assert.equal(userStillValid.statusCode, 200);
        const adminRevoked = await request(server, {
            path: '/admin-protected',
            headers: { cookie: adminCookie }
        });
        assert.equal(adminRevoked.statusCode, 403);
    } finally {
        await close(server);
    }
});

test('logout rejects malformed duplicate cookies without claiming revocation', async () => {
    const userRevocations = fakeRevocations();
    const adminRevocations = fakeRevocations();
    const auth = makeAuth({
        UserSessionRevocation: userRevocations,
        AdminSessionRevocation: adminRevocations
    });

    const userRes = response();
    auth.issueUserSession(userRes, { openId: 'user-a', role: 'collector' });
    const userCookie = cookieValue(userRes.getHeader('Set-Cookie')[0]);
    await assert.rejects(
        auth.revokeUserSession({
            headers: {
                cookie: `${userCookie}; ${DEFAULT_COOKIE_NAMES.user}=%E0%A4%A`
            }
        }),
        error => error.code === 'SESSION_INVALID' && error.httpStatus === 400
    );
    assert.equal(userRevocations.writes.length, 0);
    assert.equal((await auth.authenticateUserRequest({ headers: { cookie: userCookie } })).openId, 'user-a');

    const adminRes = response();
    auth.issueAdminSession(adminRes);
    const adminCookie = cookieValue(adminRes.getHeader('Set-Cookie')[0]);
    await assert.rejects(
        auth.revokeAdminSession({
            headers: {
                cookie: `${adminCookie}; ${DEFAULT_COOKIE_NAMES.admin}=%E0%A4%A`
            }
        }),
        error => error.code === 'ADMIN_CREDENTIAL_INVALID' && error.httpStatus === 403
    );
    assert.equal(adminRevocations.writes.length, 0);
    assert.equal((await auth.authenticateAdminRequest({ headers: { cookie: adminCookie } })).source, 'cookie');
});

test('admin auth accepts only a valid Bearer token or signed cookie, never the UI marker alone', async () => {
    const auth = makeAuth();
    assert.equal((await auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    })).source, 'bearer');

    const res = response();
    auth.issueAdminSession(res);
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    assert.equal((await auth.authenticateAdminRequest({ headers: { cookie } })).source, 'cookie');
    assert.equal((await auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}`, cookie }
    })).source, 'cookie');
    await assert.rejects(auth.authenticateAdminRequest({
        headers: { authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}` }
    }), error => error.code === 'ADMIN_AUTH_REQUIRED');
    await assert.rejects(auth.authenticateAdminRequest({
        headers: { authorization: 'Bearer wrong-token' }
    }), error => error.code === 'ADMIN_CREDENTIAL_INVALID');

    const weakTokenAuth = makeAuth({ adminToken: 'super-admin-token' });
    await assert.rejects(weakTokenAuth.authenticateAdminRequest({
        headers: { authorization: 'Bearer super-admin-token' }
    }), error => error.code === 'ADMIN_CREDENTIAL_INVALID');
});

test('admin query and body tokens are ignored', async () => {
    const auth = makeAuth();
    await assert.rejects(auth.authenticateAdminRequest({
        headers: {}, query: { adminToken: ADMIN_TOKEN }, body: { adminToken: ADMIN_TOKEN }
    }), error => error.code === 'ADMIN_AUTH_REQUIRED');
});

test('administrator logout persists a hashed jti and rejects the same cookie until expiry', async () => {
    const revocations = fakeRevocations();
    const auth = makeAuth({ AdminSessionRevocation: revocations });
    const res = response();
    const token = auth.issueAdminSession(res);
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    const principal = await auth.authenticateAdminRequest({ headers: { cookie } });

    assert.equal(await auth.revokeAdminSession({ headers: { cookie } }), true);
    assert.equal(revocations.writes.length, 1);
    assert.equal(revocations.writes[0].filter._id, hashAdminSessionId(principal.sessionId));
    assert.equal(JSON.stringify(revocations.writes).includes(principal.sessionId), false);
    assert.equal(JSON.stringify(revocations.writes).includes(token), false);
    assert.ok(revocations.writes[0].update.$setOnInsert.expiresAt instanceof Date);

    await assert.rejects(
        auth.authenticateAdminRequest({ headers: { cookie } }),
        error => error.code === 'ADMIN_SESSION_REVOKED' && error.httpStatus === 403
    );
    const restartedAuth = makeAuth({ AdminSessionRevocation: fakeRevocations({
        records: revocations.records
    }) });
    await assert.rejects(
        restartedAuth.authenticateAdminRequest({ headers: { cookie } }),
        error => error.code === 'ADMIN_SESSION_REVOKED'
    );
});

test('administrator signed sessions fail closed when revocation storage is unavailable', async () => {
    const readFailure = makeAuth({
        AdminSessionRevocation: fakeRevocations({ readError: new Error('database detail') })
    });
    const res = response();
    readFailure.issueAdminSession(res);
    const cookie = cookieValue(res.getHeader('Set-Cookie')[0]);
    await assert.rejects(
        readFailure.authenticateAdminRequest({ headers: { cookie } }),
        error => error.code === 'ADMIN_SESSION_REVOCATION_UNAVAILABLE' && error.httpStatus === 503
    );
    assert.equal((await readFailure.authenticateAdminRequest({
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    })).source, 'bearer', 'opaque ADMIN_TOKEN must not depend on the revocation database');

    const writeFailure = makeAuth({
        AdminSessionRevocation: fakeRevocations({ writeError: new Error('database detail') })
    });
    const writeRes = response();
    writeFailure.issueAdminSession(writeRes);
    await assert.rejects(
        writeFailure.revokeAdminSession({
            headers: { cookie: cookieValue(writeRes.getHeader('Set-Cookie')[0]) }
        }),
        error => error.code === 'ADMIN_SESSION_REVOCATION_UNAVAILABLE' && error.httpStatus === 503
    );
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

    let substringCookieNext = false;
    await auth.requireReviewerOrAdmin({
        headers: { cookie: `${reviewerCookie}; not_${DEFAULT_COOKIE_NAMES.admin}=invalid` }
    }, response(), () => { substringCookieNext = true; });
    assert.equal(substringCookieNext, true, 'cookie-name substrings must not force admin auth');

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

    await assert.rejects(auth.authenticateSocket({
        handshake: {
            headers: { cookie: cookieValue(res.getHeader('Set-Cookie')[0]) },
            auth: {},
            query: { openId: 'reviewer-a', openid: 'user-a' }
        }
    }), error => error.code === 'USER_IDENTITY_MISMATCH',
    'conflicting query aliases must not be hidden by first-value selection');

    await assert.rejects(auth.authenticateSocket({
        handshake: {
            headers: { cookie: cookieValue(res.getHeader('Set-Cookie')[0]) },
            auth: { userOpenId: 'user-a' },
            query: { openId: 'reviewer-a' }
        }
    }), error => error.code === 'USER_IDENTITY_MISMATCH',
    'identity hints in the Socket auth payload must match the signed principal');
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
