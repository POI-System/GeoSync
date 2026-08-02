'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const modelModule = require('../../models');
const { CONFIG, validateOnBoot, bool } = require('../../config');
const {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    DEFAULT_HEADER_NAMES,
    createSessionToken
} = require('../../lib/sessionAuth');

const users = new Map([
    ['user-1', { openId: 'user-1', role: 'collector' }],
    ['user-2', { openId: 'user-2', role: 'reviewer' }],
    ['disabled-user', { openId: 'disabled-user', role: 'collector', enabled: false }]
]);

const ExternalUser = {
    findOne(filter) {
        return { lean: async () => users.get(String(filter.openId)) || null };
    }
};

modelModule.registerModels(new mongoose.Mongoose(), { User: ExternalUser });
const {
    LEGACY_ADMIN_SESSION_MARKER,
    requireUser,
    requireAdmin,
    screenOrAdmin,
    legacyOpenIdAllowed
} = require('../../lib/auth');

const SESSION_SECRET = 'M7pQ2xR9vT4cN8kL1sD6fG3hJ0zX5bW2aE9uI7oP';
const ADMIN_TOKEN = 'A8mD3nT9kR5pQ1xV7cL2sF6hJ4zB0wE9uI3oP5yK';
const SCREEN_TOKEN = 'S4cR8eN2tK7pQ1xV9mL5dF3hJ6zB0wE2uI8oP4yA';
const NOW = Date.now();

test('signed auth is disabled only by an explicit false configuration value', () => {
    assert.equal(bool('false', true), false);
    assert.equal(bool(' FALSE ', true), false);
    assert.equal(bool('true', false), true);
    assert.equal(bool('0', true), true);
    assert.equal(bool('tru', true), true);
    assert.equal(bool('', true), true);
});

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function snapshotConfig() {
    return {
        nodeEnv: CONFIG.nodeEnv,
        isProduction: CONFIG.isProduction,
        authSignRequired: CONFIG.authSignRequired,
        legacyOpenIdEnabled: CONFIG.legacyOpenIdEnabled,
        sessionSecret: CONFIG.sessionSecret,
        adminToken: CONFIG.adminToken,
        adminUsername: CONFIG.adminUsername,
        screenToken: CONFIG.screenToken,
        simMode: CONFIG.simMode
    };
}

function restoreConfig(snapshot) {
    Object.assign(CONFIG, snapshot);
}

function userToken(subject = 'user-1') {
    return createSessionToken({
        secret: SESSION_SECRET,
        kind: SESSION_KINDS.USER,
        subject,
        role: 'collector',
        ttlSec: 600,
        now: NOW,
        sessionId: `session-${subject}`
    });
}

function adminToken(subject = 'operator-1') {
    return createSessionToken({
        secret: SESSION_SECRET,
        kind: SESSION_KINDS.ADMIN,
        subject,
        role: 'admin',
        ttlSec: 600,
        now: NOW,
        sessionId: 'admin-session-1'
    });
}

function screenSessionToken(now = NOW, ttlSec = 600) {
    return createSessionToken({
        secret: SESSION_SECRET,
        kind: SESSION_KINDS.SCREEN,
        subject: 'screen',
        role: 'viewer',
        ttlSec,
        now,
        sessionId: `screen-session-${now}`
    });
}

test('signed user session is authoritative over a forged X-Open-Id header', async () => {
    const previous = snapshotConfig();
    Object.assign(CONFIG, {
        nodeEnv: 'production', isProduction: true,
        authSignRequired: true, legacyOpenIdEnabled: false,
        sessionSecret: SESSION_SECRET
    });
    const req = {
        headers: {
            [DEFAULT_HEADER_NAMES.user]: userToken('user-1'),
            'x-open-id': 'user-2'
        }
    };
    const res = response();
    let nextCalled = false;
    try {
        await requireUser(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(req.openId, 'user-1');
        assert.equal(req.user.role, 'collector');
        assert.equal(req.authSession.subject, 'user-1');
    } finally {
        restoreConfig(previous);
    }
});

test('signed user authentication rejects missing, malformed, and revoked sessions', async () => {
    const previous = snapshotConfig();
    Object.assign(CONFIG, {
        nodeEnv: 'production', isProduction: true,
        authSignRequired: true, legacyOpenIdEnabled: false,
        sessionSecret: SESSION_SECRET
    });
    try {
        for (const headers of [{}, { [DEFAULT_HEADER_NAMES.user]: 'forged-token' }]) {
            const res = response();
            await requireUser({ headers }, res, () => assert.fail('next must not run'));
            assert.equal(res.statusCode, 401);
        }
        const res = response();
        await requireUser({ headers: { [DEFAULT_HEADER_NAMES.user]: userToken('disabled-user') } }, res,
            () => assert.fail('next must not run'));
        assert.equal(res.statusCode, 401);
    } finally {
        restoreConfig(previous);
    }
});

test('legacy X-Open-Id works only when explicitly enabled outside production', async () => {
    const previous = snapshotConfig();
    try {
        Object.assign(CONFIG, {
            nodeEnv: 'development', isProduction: false,
            authSignRequired: false, legacyOpenIdEnabled: true
        });
        assert.equal(legacyOpenIdAllowed(), true);
        const devReq = { headers: { 'x-open-id': 'user-1' } };
        const devRes = response();
        let devNext = false;
        await requireUser(devReq, devRes, () => { devNext = true; });
        assert.equal(devNext, true);

        Object.assign(CONFIG, { nodeEnv: 'production', isProduction: true });
        assert.equal(legacyOpenIdAllowed(), false);
        const prodRes = response();
        await requireUser({ headers: { 'x-open-id': 'user-1' } }, prodRes,
            () => assert.fail('next must not run'));
        assert.equal(prodRes.statusCode, 401);
    } finally {
        restoreConfig(previous);
    }
});

test('admin accepts only a strong Bearer token or signed admin session cookie', () => {
    const previous = snapshotConfig();
    Object.assign(CONFIG, {
        sessionSecret: SESSION_SECRET,
        adminToken: ADMIN_TOKEN,
        adminUsername: 'operator-1'
    });
    try {
        const bearerReq = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
        let bearerNext = false;
        requireAdmin(bearerReq, response(), () => { bearerNext = true; });
        assert.equal(bearerNext, true);
        assert.equal(bearerReq.adminAuth.kind, 'opaque-admin-token');

        const signed = adminToken();
        const cookieReq = { headers: { cookie: `${DEFAULT_COOKIE_NAMES.admin}=${signed}` } };
        let cookieNext = false;
        requireAdmin(cookieReq, response(), () => { cookieNext = true; });
        assert.equal(cookieNext, true);
        assert.equal(cookieReq.adminAuth.kind, 'signed-session');

        const browserReq = {
            headers: {
                authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}`,
                cookie: `${DEFAULT_COOKIE_NAMES.admin}=${signed}`
            }
        };
        let browserNext = false;
        requireAdmin(browserReq, response(), () => { browserNext = true; });
        assert.equal(browserNext, true);
        assert.equal(browserReq.adminAuth.kind, 'signed-session');

        const staleSubjectRes = response();
        requireAdmin({
            headers: {
                cookie: `${DEFAULT_COOKIE_NAMES.admin}=${adminToken('former-operator')}`
            }
        }, staleSubjectRes, () => assert.fail('stale administrator subject must not pass'));
        assert.equal(staleSubjectRes.statusCode, 403);

        for (const req of [
            { headers: { authorization: `Bearer ${LEGACY_ADMIN_SESSION_MARKER}` } },
            { headers: { authorization: `Bearer ${signed}` } }
        ]) {
            const res = response();
            requireAdmin(req, res, () => assert.fail('next must not run'));
            assert.equal(res.statusCode, 403);
        }

        for (const req of [
            { headers: {}, query: { adminToken: ADMIN_TOKEN } },
            { headers: {}, body: { adminToken: ADMIN_TOKEN } }
        ]) {
            const res = response();
            requireAdmin(req, res, () => assert.fail('next must not run'));
            assert.equal(res.statusCode, 403);
        }

        CONFIG.adminToken = 'super-admin-token';
        const weakRes = response();
        requireAdmin({ headers: { authorization: 'Bearer super-admin-token' } }, weakRes,
            () => assert.fail('next must not run'));
        assert.equal(weakRes.statusCode, 403);
    } finally {
        restoreConfig(previous);
    }
});

test('screen authentication rejects query tokens and accepts only a strong header or cookie', () => {
    const previous = snapshotConfig();
    Object.assign(CONFIG, {
        sessionSecret: SESSION_SECRET,
        adminToken: ADMIN_TOKEN,
        adminUsername: 'operator-1',
        screenToken: SCREEN_TOKEN
    });
    try {
        const queryRes = response();
        screenOrAdmin({ headers: {}, query: { screenToken: SCREEN_TOKEN } }, queryRes,
            () => assert.fail('next must not run'));
        assert.equal(queryRes.statusCode, 403);

        for (const req of [
            { headers: { [DEFAULT_HEADER_NAMES.screen]: SCREEN_TOKEN }, query: {} },
            {
                headers: {
                    cookie: `${DEFAULT_COOKIE_NAMES.screen}=${screenSessionToken()}`
                },
                query: {}
            }
        ]) {
            let nextCalled = false;
            screenOrAdmin(req, response(), () => { nextCalled = true; });
            assert.equal(nextCalled, true);
            assert.ok(req.screenAuth);
        }

        const expiredRes = response();
        screenOrAdmin({
            headers: {
                cookie: `${DEFAULT_COOKIE_NAMES.screen}=${screenSessionToken(NOW - 3600 * 1000, 60)}`
            },
            query: {}
        }, expiredRes, () => assert.fail('expired screen session must not pass'));
        assert.equal(expiredRes.statusCode, 403);

        const adminFallbackReq = {
            headers: {
                cookie: [
                    `${DEFAULT_COOKIE_NAMES.screen}=${screenSessionToken(NOW - 3600 * 1000, 60)}`,
                    `${DEFAULT_COOKIE_NAMES.admin}=${adminToken()}`
                ].join('; ')
            },
            query: {}
        };
        let adminFallbackNext = false;
        screenOrAdmin(adminFallbackReq, response(), () => { adminFallbackNext = true; });
        assert.equal(adminFallbackNext, true);
        assert.equal(adminFallbackReq.adminAuth.kind, 'signed-session');

        const adminReq = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, query: {} };
        let adminNext = false;
        screenOrAdmin(adminReq, response(), () => { adminNext = true; });
        assert.equal(adminNext, true);
    } finally {
        restoreConfig(previous);
    }
});

test('production boot rejects SIM_MODE', () => {
    const previous = snapshotConfig();
    Object.assign(CONFIG, {
        nodeEnv: 'production', isProduction: true, simMode: true,
        authSignRequired: true, sessionSecret: SESSION_SECRET
    });
    try {
        assert.throws(() => validateOnBoot(), error => error.code === 'GEOSYNC_SIM_MODE_FORBIDDEN');
    } finally {
        restoreConfig(previous);
    }
});
