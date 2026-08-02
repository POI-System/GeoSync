'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    SessionAuthError,
    SessionAuthConfigurationError,
    validateSessionSecret,
    createSessionToken,
    verifySessionToken,
    extractRequestToken,
    serializeSessionCookie,
    serializeExpiredCookie,
    timingSafeEqualText
} = require('../../lib/sessionAuth');

const SECRET = 'V9x7sQ2pL4mN8cR6tY1uI5oP3aS0dF2gH7jK9zX4';
const NOW = Date.parse('2026-08-02T08:00:00.000Z');

test('signed user session round-trips normalized bounded claims', () => {
    const token = createSessionToken({
        secret: SECRET,
        kind: SESSION_KINDS.USER,
        subject: 'wechat_user_1',
        role: 'tourist',
        ttlSec: 600,
        now: NOW,
        sessionId: 'session-1'
    });
    const claims = verifySessionToken(token, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.USER,
        now: NOW + 60_000,
        clockSkewSec: 0
    });
    assert.deepEqual(claims, {
        kind: 'user',
        subject: 'wechat_user_1',
        role: 'tourist',
        issuedAt: NOW / 1000,
        expiresAt: NOW / 1000 + 600,
        sessionId: 'session-1'
    });
    assert.equal(Object.isFrozen(claims), true);
});

test('signed screen sessions use a distinct credential kind', () => {
    const token = createSessionToken({
        secret: SECRET,
        kind: SESSION_KINDS.SCREEN,
        subject: 'screen',
        role: 'viewer',
        ttlSec: 300,
        now: NOW,
        sessionId: 'screen-session-1'
    });
    const claims = verifySessionToken(token, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.SCREEN,
        now: NOW + 1000
    });
    assert.equal(claims.kind, SESSION_KINDS.SCREEN);
    assert.equal(claims.subject, 'screen');
    assert.throws(() => verifySessionToken(token, {
        secret: SECRET,
        expectedKind: SESSION_KINDS.ADMIN,
        now: NOW + 1000
    }), error => error.code === 'SESSION_KIND_MISMATCH');
});

test('verification rejects tampering, wrong kind, expiry, and future issuance', () => {
    const token = createSessionToken({
        secret: SECRET,
        kind: 'admin',
        subject: 'operator',
        ttlSec: 60,
        now: NOW,
        sessionId: 'admin-session'
    });
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.throws(() => verifySessionToken(tampered, { secret: SECRET, expectedKind: 'admin', now: NOW }),
        error => error instanceof SessionAuthError && error.code === 'SESSION_SIGNATURE_INVALID');
    assert.throws(() => verifySessionToken(token, { secret: SECRET, expectedKind: 'user', now: NOW }),
        error => error.code === 'SESSION_KIND_MISMATCH');
    assert.throws(() => verifySessionToken(token, {
        secret: SECRET, expectedKind: 'admin', now: NOW + 61_000, clockSkewSec: 0
    }), error => error.code === 'SESSION_EXPIRED');
    assert.throws(() => verifySessionToken(token, {
        secret: SECRET, expectedKind: 'admin', now: NOW - 31_000, clockSkewSec: 30
    }), error => error.code === 'SESSION_NOT_ACTIVE');
});

test('session secret validation rejects missing, short, repeated, and placeholder secrets', () => {
    for (const value of ['', 'short-secret', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'change-me-to-random-hex-change-me-now']) {
        assert.throws(() => validateSessionSecret(value), SessionAuthConfigurationError);
    }
    const validated = validateSessionSecret(Buffer.from(SECRET));
    assert.notEqual(validated, Buffer.from(SECRET));
    assert.equal(validated.toString('utf8'), SECRET);
});

test('request token extraction supports a header, Bearer, or cookie and rejects conflicts', () => {
    assert.deepEqual(extractRequestToken({ headers: { 'x-poi-session': 'header-token' } }, {
        headerName: 'x-poi-session'
    }), { token: 'header-token', source: 'header' });
    assert.deepEqual(extractRequestToken({ headers: { authorization: 'Bearer bearer-token' } }, {
        allowBearer: true
    }), { token: 'bearer-token', source: 'bearer' });
    assert.deepEqual(extractRequestToken({
        headers: { cookie: `${DEFAULT_COOKIE_NAMES.user}=cookie-token; theme=dark` }
    }, { cookieName: DEFAULT_COOKIE_NAMES.user }), { token: 'cookie-token', source: 'cookie' });
    assert.throws(() => extractRequestToken({
        headers: {
            'x-poi-session': 'one',
            cookie: `${DEFAULT_COOKIE_NAMES.user}=two`
        }
    }, {
        headerName: 'x-poi-session',
        cookieName: DEFAULT_COOKIE_NAMES.user
    }), error => error.code === 'SESSION_CREDENTIAL_CONFLICT');
});

test('request token extraction rejects malformed Bearer credentials', () => {
    assert.throws(() => extractRequestToken({ headers: { authorization: 'Basic abc' } }, {
        allowBearer: true
    }), error => error.code === 'SESSION_FORMAT_INVALID');
});

test('session cookie serialization is HttpOnly, bounded, and injection resistant', () => {
    const cookie = serializeSessionCookie(DEFAULT_COOKIE_NAMES.user, 'v1.payload.signature', {
        maxAgeSec: 600,
        secure: true,
        sameSite: 'Strict'
    });
    assert.match(cookie, /^poi_user_session=v1.payload.signature; /);
    assert.match(cookie, /Max-Age=600/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.throws(() => serializeSessionCookie('bad\r\nname', 'token'), TypeError);
    assert.throws(() => serializeSessionCookie(DEFAULT_COOKIE_NAMES.user, 'bad;token'), TypeError);
    assert.throws(() => serializeSessionCookie(DEFAULT_COOKIE_NAMES.user, 'token', { httpOnly: false }), TypeError);
});

test('expired cookie serialization clears the credential with matching safety attributes', () => {
    const cookie = serializeExpiredCookie(DEFAULT_COOKIE_NAMES.admin, { secure: false, sameSite: 'Lax' });
    assert.match(cookie, /^poi_admin_session=;/);
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.match(cookie, /HttpOnly/);
    assert.doesNotMatch(cookie, /; Secure/);
});

test('timing-safe text comparison preserves equality semantics', () => {
    assert.equal(timingSafeEqualText('same-value', 'same-value'), true);
    assert.equal(timingSafeEqualText('same-value', 'different-value'), false);
    assert.equal(timingSafeEqualText('', ''), false);
});
