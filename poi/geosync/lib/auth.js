'use strict';

const { CONFIG } = require('../config');
const { fail } = require('./respond');
const { getModels } = require('../models');
const {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    DEFAULT_HEADER_NAMES,
    SessionAuthConfigurationError,
    validateSessionSecret,
    verifySessionToken,
    extractRequestToken,
    timingSafeEqualText
} = require('./sessionAuth');
const {
    AdminSessionRevocationError,
    isAdminSessionRevoked
} = require('../services/adminSessionRevocation');
const {
    UserSessionRevocationError,
    isUserSessionRevoked
} = require('../services/userSessionRevocation');
const { hasMismatchedIdentityHint } = require('./identityHints');

const LEGACY_ADMIN_SESSION_MARKER = 'cookie-session';

function isProduction() {
    return CONFIG.isProduction === true || String(CONFIG.nodeEnv || '').toLowerCase() === 'production';
}

function legacyOpenIdAllowed() {
    return !isProduction() && CONFIG.authSignRequired === false && CONFIG.legacyOpenIdEnabled !== false;
}

function userIsRevoked(user) {
    return !user || user.enabled === false || user.disabled === true || user.banned === true;
}

function verifySignedCredential(token, expectedKind) {
    return verifySessionToken(token, {
        secret: CONFIG.sessionSecret,
        expectedKind
    });
}

function userCredential(req) {
    return extractRequestToken(req, {
        headerName: DEFAULT_HEADER_NAMES.user,
        cookieName: DEFAULT_COOKIE_NAMES.user,
        allowBearer: true
    });
}

async function requireUser(req, res, next) {
    let credential;
    try {
        credential = userCredential(req);
    } catch {
        return fail(res, 401, 9001, 'User session is invalid');
    }

    let openId = '';
    let session = null;
    if (credential) {
        try {
            session = verifySignedCredential(credential.token, SESSION_KINDS.USER);
            openId = session.subject;
        } catch (error) {
            if (error instanceof SessionAuthConfigurationError) {
                return fail(res, 503, 9001, 'User authentication is not configured securely');
            }
            return fail(res, 401, 9001, 'User session is invalid');
        }
    } else if (legacyOpenIdAllowed()) {
        openId = String(req.headers['x-open-id'] || '').trim();
    }
    if (!openId) return fail(res, 401, 9001, 'A valid user session is required');
    if (hasMismatchedIdentityHint(req, openId)) {
        return fail(res, 403, 9001, 'User identity does not match the session');
    }

    try {
        const { ExternalUser, UserSessionRevocation } = getModels();
        if (session && await isUserSessionRevoked(UserSessionRevocation, session.sessionId)) {
            return fail(res, 401, 9001, 'User session is invalid');
        }
        const user = await ExternalUser.findOne({ openId }).lean();
        if (userIsRevoked(user)) return fail(res, 401, 9001, 'User does not exist or is disabled');
        req.openId = openId;
        req.user = user;
        req.authSession = session;
        return next();
    } catch (error) {
        if (error instanceof UserSessionRevocationError) {
            return fail(res, 503, 9001, 'User authentication is unavailable');
        }
        console.error('[GeoSync] [AUTH]', error?.name || 'Error');
        return fail(res, 500, 9001, 'Authentication failed');
    }
}

function configuredOpaqueToken(value, name) {
    try {
        validateSessionSecret(value, { name });
        return String(value);
    } catch {
        return '';
    }
}

async function requireAdmin(req, res, next) {
    let bearerCredential;
    let cookieCredential;
    try {
        bearerCredential = extractRequestToken(req, { allowBearer: true });
        cookieCredential = extractRequestToken(req, { cookieName: DEFAULT_COOKIE_NAMES.admin });
    } catch {
        return fail(res, 403, 9001, 'Administrator permission is invalid');
    }

    if (bearerCredential && bearerCredential.token !== LEGACY_ADMIN_SESSION_MARKER) {
        const configuredToken = configuredOpaqueToken(CONFIG.adminToken, 'ADMIN_TOKEN');
        if (configuredToken && timingSafeEqualText(bearerCredential.token, configuredToken)) {
            req.adminAuth = Object.freeze({ source: 'bearer', kind: 'opaque-admin-token' });
            return next();
        }
        return fail(res, 403, 9001, 'Administrator permission is invalid');
    }
    if (!cookieCredential) return fail(res, 403, 9001, 'Administrator permission is invalid');

    try {
        const session = verifySignedCredential(cookieCredential.token, SESSION_KINDS.ADMIN);
        if (!timingSafeEqualText(session.subject, CONFIG.adminUsername)) {
            throw new Error('invalid administrator subject');
        }
        const { AdminSessionRevocation } = getModels();
        if (await isAdminSessionRevoked(AdminSessionRevocation, session.sessionId)) {
            return fail(res, 403, 9001, 'Administrator permission is invalid');
        }
        req.adminAuth = Object.freeze({ source: cookieCredential.source, kind: 'signed-session', session });
        return next();
    } catch (error) {
        if (error instanceof AdminSessionRevocationError) {
            return fail(res, 503, 9001, 'Administrator authentication is unavailable');
        }
        return fail(res, 403, 9001, 'Administrator permission is invalid');
    }
}

async function screenOrAdmin(req, res, next) {
    if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'screenToken')) {
        return fail(res, 403, 9001, 'Screen credentials must not be passed in the query string');
    }

    let headerCredential;
    let cookieCredential;
    try {
        headerCredential = extractRequestToken(req, {
            headerName: DEFAULT_HEADER_NAMES.screen
        });
        cookieCredential = extractRequestToken(req, {
            cookieName: DEFAULT_COOKIE_NAMES.screen
        });
    } catch {
        return fail(res, 403, 9001, 'Screen permission is invalid');
    }
    if (headerCredential) {
        const screenToken = configuredOpaqueToken(CONFIG.screenToken, 'SCREEN_TOKEN');
        if (screenToken && timingSafeEqualText(headerCredential.token, screenToken)) {
            req.screenAuth = Object.freeze({ source: headerCredential.source, kind: 'opaque-screen-token' });
            return next();
        }
        return fail(res, 403, 9001, 'Screen permission is invalid');
    }
    if (cookieCredential) {
        try {
            const session = verifySignedCredential(cookieCredential.token, SESSION_KINDS.SCREEN);
            if (session.subject !== 'screen') throw new Error('invalid screen subject');
            req.screenAuth = Object.freeze({
                source: cookieCredential.source,
                kind: 'signed-screen-session',
                session
            });
            return next();
        } catch {
            return requireAdmin(req, res, next);
        }
    }
    return requireAdmin(req, res, next);
}

module.exports = {
    LEGACY_ADMIN_SESSION_MARKER,
    requireUser,
    requireAdmin,
    screenOrAdmin,
    legacyOpenIdAllowed,
    userIsRevoked
};
