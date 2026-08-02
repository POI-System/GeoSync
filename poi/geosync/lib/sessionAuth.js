'use strict';

const crypto = require('node:crypto');

const TOKEN_VERSION = 'v1';
const TOKEN_MAX_LENGTH = 4096;
const MAX_SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@+-]+$/;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER_SECRET = /(?:change[-_ ]?me|replace[-_ ]?me|super-admin-token|your[-_ ]?(?:secret|token)|placeholder)/i;

const SESSION_KINDS = Object.freeze({
    USER: 'user',
    ADMIN: 'admin',
    SCREEN: 'screen'
});

const DEFAULT_COOKIE_NAMES = Object.freeze({
    user: 'poi_user_session',
    admin: 'poi_admin_session',
    screen: 'poi_screen_token'
});

const DEFAULT_HEADER_NAMES = Object.freeze({
    user: 'x-poi-session',
    screen: 'x-screen-token'
});

class SessionAuthError extends Error {
    constructor(code, message = 'Session credential is invalid.') {
        super(message);
        this.name = 'SessionAuthError';
        this.code = code || 'SESSION_INVALID';
        Error.captureStackTrace?.(this, this.constructor);
    }
}

class SessionAuthConfigurationError extends SessionAuthError {
    constructor(message = 'Session authentication is not configured securely.') {
        super('SESSION_SECRET_INVALID', message);
        this.name = 'SessionAuthConfigurationError';
    }
}

function validateSessionSecret(secret, options = {}) {
    const name = String(options.name || 'SESSION_SECRET');
    const minBytes = options.minBytes === undefined ? 32 : Number(options.minBytes);
    if (!Number.isInteger(minBytes) || minBytes < 16 || minBytes > 1024) {
        throw new TypeError('minBytes must be an integer between 16 and 1024');
    }

    let value;
    if (Buffer.isBuffer(secret)) {
        value = Buffer.from(secret);
    } else if (typeof secret === 'string') {
        if (secret !== secret.trim()) {
            throw new SessionAuthConfigurationError(`${name} must not contain leading or trailing whitespace.`);
        }
        value = Buffer.from(secret, 'utf8');
    } else {
        throw new SessionAuthConfigurationError(`${name} must be configured.`);
    }

    if (value.length < minBytes) {
        throw new SessionAuthConfigurationError(`${name} must contain at least ${minBytes} bytes.`);
    }
    if (value.length > 4096) {
        throw new SessionAuthConfigurationError(`${name} is too long.`);
    }

    const text = value.toString('utf8');
    if (/[\x00-\x1f\x7f]/.test(text) || PLACEHOLDER_SECRET.test(text)) {
        throw new SessionAuthConfigurationError(`${name} contains an unsafe placeholder value.`);
    }
    if (text.length > 0 && new Set(text).size < 6) {
        throw new SessionAuthConfigurationError(`${name} does not contain enough variation.`);
    }
    return value;
}

function timingSafeEqualText(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
    const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
    const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requireKind(value) {
    const kind = String(value || '').trim().toLowerCase();
    if (!Object.values(SESSION_KINDS).includes(kind)) {
        throw new SessionAuthError('SESSION_KIND_INVALID', 'Session kind is invalid.');
    }
    return kind;
}

function requireIdentifier(value, field, maxLength = 128, allowEmpty = false) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (!text) {
        if (allowEmpty) return '';
        throw new SessionAuthError('SESSION_CLAIMS_INVALID', `${field} is required.`);
    }
    if (text.length > maxLength || !SAFE_IDENTIFIER_PATTERN.test(text)) {
        throw new SessionAuthError('SESSION_CLAIMS_INVALID', `${field} is invalid.`);
    }
    return text;
}

function epochSeconds(value, field = 'now') {
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) {
        throw new TypeError(`${field} must be a Date or finite millisecond timestamp`);
    }
    return Math.floor(milliseconds / 1000);
}

function ttlSeconds(value) {
    const ttlSec = Number(value);
    if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_SESSION_TTL_SEC) {
        throw new SessionAuthError(
            'SESSION_TTL_INVALID',
            `Session ttlSec must be an integer between 1 and ${MAX_SESSION_TTL_SEC}.`
        );
    }
    return ttlSec;
}

function sign(secret, input) {
    return crypto.createHmac('sha256', secret)
        .update(`poi-geosync-session:${input}`, 'utf8')
        .digest();
}

function createSessionToken({
    secret,
    kind,
    subject,
    role = '',
    ttlSec = 3600,
    now = Date.now(),
    sessionId = crypto.randomUUID()
} = {}) {
    const key = validateSessionSecret(secret);
    const issuedAt = epochSeconds(now);
    const lifetime = ttlSeconds(ttlSec);
    const payload = {
        v: 1,
        k: requireKind(kind),
        sub: requireIdentifier(subject, 'subject'),
        role: requireIdentifier(role, 'role', 64, true),
        iat: issuedAt,
        exp: issuedAt + lifetime,
        jti: requireIdentifier(sessionId, 'sessionId')
    };
    const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `${TOKEN_VERSION}.${payloadSegment}`;
    return `${signingInput}.${sign(key, signingInput).toString('base64url')}`;
}

function invalidToken(code = 'SESSION_INVALID', message = 'Session credential is invalid.') {
    return new SessionAuthError(code, message);
}

function decodeCanonicalBase64Url(segment, field) {
    if (!segment || !BASE64URL_PATTERN.test(segment)) throw invalidToken('SESSION_FORMAT_INVALID');
    let decoded;
    try {
        decoded = Buffer.from(segment, 'base64url');
    } catch {
        throw invalidToken('SESSION_FORMAT_INVALID');
    }
    if (!decoded.length || decoded.toString('base64url') !== segment) {
        throw invalidToken('SESSION_FORMAT_INVALID', `${field} encoding is invalid.`);
    }
    return decoded;
}

function verifySessionToken(token, {
    secret,
    expectedKind,
    now = Date.now(),
    clockSkewSec = 30
} = {}) {
    const key = validateSessionSecret(secret);
    if (typeof token !== 'string' || !token || token.length > TOKEN_MAX_LENGTH || token !== token.trim()) {
        throw invalidToken('SESSION_FORMAT_INVALID');
    }
    const segments = token.split('.');
    if (segments.length !== 3 || segments[0] !== TOKEN_VERSION) {
        throw invalidToken('SESSION_FORMAT_INVALID');
    }

    const payloadBytes = decodeCanonicalBase64Url(segments[1], 'payload');
    const signature = decodeCanonicalBase64Url(segments[2], 'signature');
    if (signature.length !== 32) throw invalidToken('SESSION_SIGNATURE_INVALID');
    const signingInput = `${segments[0]}.${segments[1]}`;
    const expectedSignature = sign(key, signingInput);
    if (!crypto.timingSafeEqual(signature, expectedSignature)) {
        throw invalidToken('SESSION_SIGNATURE_INVALID');
    }

    let payload;
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        throw invalidToken('SESSION_CLAIMS_INVALID');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw invalidToken('SESSION_CLAIMS_INVALID');
    }
    const allowedKeys = new Set(['v', 'k', 'sub', 'role', 'iat', 'exp', 'jti']);
    if (Object.keys(payload).some(keyName => !allowedKeys.has(keyName)) || payload.v !== 1) {
        throw invalidToken('SESSION_CLAIMS_INVALID');
    }

    const kind = requireKind(payload.k);
    if (expectedKind !== undefined && kind !== requireKind(expectedKind)) {
        throw invalidToken('SESSION_KIND_MISMATCH', 'Session kind is not authorized for this operation.');
    }
    const subject = requireIdentifier(payload.sub, 'subject');
    const role = requireIdentifier(payload.role, 'role', 64, true);
    const sessionId = requireIdentifier(payload.jti, 'sessionId');
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
        || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_SESSION_TTL_SEC) {
        throw invalidToken('SESSION_CLAIMS_INVALID');
    }

    const skew = Number(clockSkewSec);
    if (!Number.isInteger(skew) || skew < 0 || skew > 300) {
        throw new TypeError('clockSkewSec must be an integer between 0 and 300');
    }
    const nowSec = epochSeconds(now);
    if (payload.iat > nowSec + skew) throw invalidToken('SESSION_NOT_ACTIVE', 'Session is not active yet.');
    if (nowSec - skew >= payload.exp) throw invalidToken('SESSION_EXPIRED', 'Session has expired.');

    return Object.freeze({
        kind,
        subject,
        role,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        sessionId
    });
}

function singleHeaderValue(req, headerName) {
    const raw = req?.headers?.[headerName.toLowerCase()];
    if (raw === undefined || raw === null || raw === '') return '';
    if (Array.isArray(raw)) {
        if (raw.length !== 1) throw invalidToken('SESSION_CREDENTIAL_CONFLICT');
        return String(raw[0]).trim();
    }
    return String(raw).trim();
}

function cookieValues(req, cookieName) {
    const header = singleHeaderValue(req, 'cookie');
    if (!header) return [];
    const values = [];
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        const name = part.slice(0, separator).trim();
        if (name !== cookieName) continue;
        const encoded = part.slice(separator + 1).trim();
        let value;
        try {
            value = decodeURIComponent(encoded);
        } catch {
            throw invalidToken('SESSION_FORMAT_INVALID');
        }
        values.push(value);
    }
    return values;
}

function bearerValue(req) {
    const authorization = singleHeaderValue(req, 'authorization');
    if (!authorization) return '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) throw invalidToken('SESSION_FORMAT_INVALID');
    return match[1];
}

function extractRequestToken(req, {
    headerName,
    cookieName,
    allowBearer = false
} = {}) {
    const candidates = [];
    if (headerName) {
        const value = singleHeaderValue(req, String(headerName));
        if (value) candidates.push({ token: value, source: 'header' });
    }
    if (allowBearer) {
        const value = bearerValue(req);
        if (value) candidates.push({ token: value, source: 'bearer' });
    }
    if (cookieName) {
        const values = cookieValues(req, String(cookieName));
        for (const value of values) {
            if (value) candidates.push({ token: value, source: 'cookie' });
        }
    }
    if (!candidates.length) return null;

    const tokens = new Set(candidates.map(candidate => candidate.token));
    if (tokens.size !== 1) throw invalidToken('SESSION_CREDENTIAL_CONFLICT');
    return Object.freeze({ token: candidates[0].token, source: candidates[0].source });
}

function safeCookieName(name) {
    const value = String(name || '');
    if (!COOKIE_NAME_PATTERN.test(value)) throw new TypeError('cookie name is invalid');
    return value;
}

function cookieOptions(options = {}, expired = false) {
    if (options.httpOnly === false) throw new TypeError('session cookies must be HttpOnly');
    const secure = options.secure === undefined ? true : Boolean(options.secure);
    const sameSiteInput = String(options.sameSite || 'Lax').toLowerCase();
    const sameSite = sameSiteInput === 'strict' ? 'Strict'
        : sameSiteInput === 'none' ? 'None'
            : sameSiteInput === 'lax' ? 'Lax' : null;
    if (!sameSite) throw new TypeError('sameSite must be Lax, Strict, or None');
    if (sameSite === 'None' && !secure) throw new TypeError('SameSite=None cookies must be Secure');

    const path = String(options.path || '/');
    if (!path.startsWith('/') || /[;\r\n]/.test(path)) throw new TypeError('cookie path is invalid');
    const attributes = [`Path=${path}`];
    if (expired) {
        attributes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } else if (options.maxAgeSec !== undefined) {
        const maxAgeSec = Number(options.maxAgeSec);
        if (!Number.isInteger(maxAgeSec) || maxAgeSec < 1 || maxAgeSec > MAX_SESSION_TTL_SEC) {
            throw new TypeError('maxAgeSec must be a positive bounded integer');
        }
        attributes.push(`Max-Age=${maxAgeSec}`);
    }
    if (options.domain !== undefined) {
        const domain = String(options.domain).trim();
        if (!domain || /[;\s\r\n]/.test(domain)) throw new TypeError('cookie domain is invalid');
        attributes.push(`Domain=${domain}`);
    }
    attributes.push('HttpOnly');
    if (secure) attributes.push('Secure');
    attributes.push(`SameSite=${sameSite}`);
    return attributes;
}

function serializeSessionCookie(name, token, options = {}) {
    const cookieName = safeCookieName(name);
    if (typeof token !== 'string' || !token || /[;\r\n\u0000]/.test(token)) {
        throw new TypeError('cookie token is invalid');
    }
    return [`${cookieName}=${encodeURIComponent(token)}`, ...cookieOptions(options)].join('; ');
}

function serializeExpiredCookie(name, options = {}) {
    return [`${safeCookieName(name)}=`, ...cookieOptions(options, true)].join('; ');
}

module.exports = {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    DEFAULT_HEADER_NAMES,
    MAX_SESSION_TTL_SEC,
    SessionAuthError,
    SessionAuthConfigurationError,
    validateSessionSecret,
    createSessionToken,
    verifySessionToken,
    extractRequestToken,
    serializeSessionCookie,
    serializeExpiredCookie,
    timingSafeEqualText
};
