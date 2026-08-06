'use strict';

const {
    SESSION_KINDS,
    DEFAULT_COOKIE_NAMES,
    DEFAULT_HEADER_NAMES,
    SessionAuthConfigurationError,
    validateSessionSecret,
    createSessionToken,
    verifySessionToken,
    extractRequestToken,
    serializeSessionCookie,
    serializeExpiredCookie,
    timingSafeEqualText
} = require('../lib/sessionAuth');
const {
    AdminSessionRevocationError,
    isAdminSessionRevoked,
    revokeAdminSession
} = require('./adminSessionRevocation');
const {
    UserSessionRevocationError,
    isUserSessionRevoked,
    revokeUserSession
} = require('./userSessionRevocation');
const { hasMismatchedIdentityHint } = require('../lib/identityHints');

const LEGACY_ADMIN_SESSION_MARKER = 'cookie-session';
const VALID_USER_ROLES = new Set(['collector', 'reviewer', 'thirdParty']);

class HostAuthError extends Error {
    constructor(code, httpStatus, message) {
        super(message);
        this.name = 'HostAuthError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function createGlobalLogoutHandler(hostAuth) {
    if (!hostAuth
        || typeof hostAuth.revokeUserSession !== 'function'
        || typeof hostAuth.revokeAdminSession !== 'function') {
        throw new TypeError('A configured hostAuth service is required.');
    }
    return async function globalLogout(req, res) {
        res.set('Cache-Control', 'no-store');
        const [userResult, adminResult] = await Promise.allSettled([
            hostAuth.revokeUserSession(req),
            hostAuth.revokeAdminSession(req)
        ]);
        const userCompleted = userResult.status === 'fulfilled';
        const adminCompleted = adminResult.status === 'fulfilled';
        if (userCompleted) hostAuth.clearUserSession(res);
        if (adminCompleted) hostAuth.clearAdminSession(res);

        const failure = [userResult, adminResult]
            .find(result => result.status === 'rejected')?.reason;
        if (!failure) {
            return res.json({
                success: true,
                userSessionRevoked: userResult.value,
                adminSessionRevoked: adminResult.value
            });
        }

        if (failure instanceof HostAuthError) {
            return res.status(failure.httpStatus).json({
                success: false,
                userSessionCleared: userCompleted,
                adminSessionCleared: adminCompleted,
                message: 'Logout is temporarily unavailable'
            });
        }
        return res.status(500).json({
            success: false,
            userSessionCleared: userCompleted,
            adminSessionCleared: adminCompleted,
            message: 'Logout failed'
        });
    };
}

function boundedSeconds(value, fallback, max = 30 * 24 * 60 * 60) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 && number <= max ? number : fallback;
}

function queryResult(value) {
    return value && typeof value.lean === 'function' ? value.lean() : value;
}

function appendSetCookie(res, cookie) {
    const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
    const values = current === undefined
        ? []
        : Array.isArray(current) ? current : [current];
    res.setHeader('Set-Cookie', [...values, cookie]);
}

function bearerCredential(req) {
    const value = req?.headers?.authorization;
    if (value === undefined || value === null || value === '') return '';
    const match = /^Bearer ([^\s]+)$/i.exec(String(value).trim());
    if (!match) throw new HostAuthError('ADMIN_CREDENTIAL_INVALID', 403, 'Administrator authorization is invalid.');
    return match[1];
}

function createHostAuth(options = {}) {
    const User = options.User;
    if (!User || typeof User.findOne !== 'function') {
        throw new TypeError('createHostAuth requires User.findOne');
    }
    const AdminSessionRevocation = options.AdminSessionRevocation;
    if (!AdminSessionRevocation
        || typeof AdminSessionRevocation.findOne !== 'function'
        || typeof AdminSessionRevocation.updateOne !== 'function') {
        throw new TypeError('createHostAuth requires AdminSessionRevocation.findOne/updateOne');
    }
    const UserSessionRevocation = options.UserSessionRevocation;
    if (!UserSessionRevocation
        || typeof UserSessionRevocation.findOne !== 'function'
        || typeof UserSessionRevocation.updateOne !== 'function') {
        throw new TypeError('createHostAuth requires UserSessionRevocation.findOne/updateOne');
    }

    let adminToken = '';
    try {
        validateSessionSecret(options.adminToken, { name: 'ADMIN_TOKEN' });
        adminToken = String(options.adminToken);
    } catch {
        adminToken = '';
    }
    const adminUsername = String(options.adminUsername || 'admin').trim() || 'admin';
    const reviewerValues = options.reviewerOpenIds instanceof Set
        ? [...options.reviewerOpenIds]
        : Array.isArray(options.reviewerOpenIds)
            ? options.reviewerOpenIds
            : String(options.reviewerOpenIds || '').split(',');
    const reviewerOpenIds = new Set(
        reviewerValues.map(value => String(value || '').trim()).filter(Boolean)
    );
    const allowLegacyUserHeader = options.allowLegacyUserHeader === true
        && options.production !== true;
    const cookieSecure = options.cookieSecure !== false;
    const cookieDomain = options.cookieDomain === undefined
        ? undefined
        : String(options.cookieDomain).trim();
    const userSessionTtlSec = boundedSeconds(options.userSessionTtlSec, 7 * 24 * 60 * 60);
    const adminSessionTtlSec = boundedSeconds(options.adminSessionTtlSec, 8 * 60 * 60);
    const clock = typeof options.clock === 'function' ? options.clock : Date.now;

    let sessionSecret = null;
    let sessionConfigurationError = null;
    try {
        sessionSecret = validateSessionSecret(options.sessionSecret, { name: 'AUTH_SESSION_SECRET' });
    } catch (error) {
        if (!(error instanceof SessionAuthConfigurationError)) throw error;
        sessionConfigurationError = error;
    }

    const cookieOptions = ttlSec => ({
        maxAgeSec: ttlSec,
        secure: cookieSecure,
        sameSite: 'Lax',
        ...(cookieDomain ? { domain: cookieDomain } : {})
    });
    const expiredCookieOptions = {
        secure: cookieSecure,
        sameSite: 'Lax',
        ...(cookieDomain ? { domain: cookieDomain } : {})
    };

    function requireSessionConfiguration() {
        if (!sessionSecret) {
            throw new HostAuthError(
                'SESSION_AUTH_UNAVAILABLE',
                503,
                sessionConfigurationError?.message || 'Session authentication is unavailable.'
            );
        }
        return sessionSecret;
    }

    async function loadUser(openId) {
        const result = await queryResult(User.findOne({ openId }));
        if (!result || result.disabled === true) return null;
        const storedRole = VALID_USER_ROLES.has(result.role) ? result.role : 'collector';
        const role = storedRole === 'reviewer' && !reviewerOpenIds.has(String(result.openId || openId))
            ? 'collector'
            : storedRole;
        return {
            document: result,
            openId: String(result.openId || openId),
            role
        };
    }

    function verifySignedCredential(credential, expectedKind) {
        try {
            return verifySessionToken(credential.token, {
                secret: requireSessionConfiguration(),
                expectedKind,
                now: clock()
            });
        } catch (error) {
            if (error instanceof HostAuthError) throw error;
            throw new HostAuthError('SESSION_INVALID', 401, 'Session authorization is invalid.');
        }
    }

    function userSessionRequest(req) {
        try {
            return extractRequestToken(req, {
                headerName: DEFAULT_HEADER_NAMES.user,
                cookieName: DEFAULT_COOKIE_NAMES.user
            });
        } catch {
            throw new HostAuthError('SESSION_INVALID', 401, 'Session authorization is invalid.');
        }
    }

    function userLogoutCredentials(req) {
        const credentials = [];
        for (const options of [
            { headerName: DEFAULT_HEADER_NAMES.user },
            { cookieName: DEFAULT_COOKIE_NAMES.user },
            { allowBearer: true }
        ]) {
            try {
                const credential = extractRequestToken(req, options);
                if (credential) credentials.push(credential);
            } catch (error) {
                if (error?.code === 'SESSION_CREDENTIAL_CONFLICT') {
                    throw new HostAuthError(
                        'SESSION_CREDENTIAL_CONFLICT',
                        400,
                        'Conflicting session credentials cannot be logged out safely.'
                    );
                }
                throw new HostAuthError(
                    'SESSION_INVALID',
                    400,
                    'Invalid session credentials cannot be logged out safely.'
                );
            }
        }
        return [...new Map(credentials.map(credential => [credential.token, credential])).values()];
    }

    async function assertUserSessionActive(claims) {
        try {
            if (await isUserSessionRevoked(UserSessionRevocation, claims.sessionId)) {
                throw new HostAuthError(
                    'USER_SESSION_REVOKED',
                    401,
                    'User session has been revoked.'
                );
            }
        } catch (error) {
            if (error instanceof HostAuthError) throw error;
            if (error instanceof UserSessionRevocationError) {
                throw new HostAuthError(
                    error.code,
                    503,
                    'User authentication is unavailable.'
                );
            }
            throw error;
        }
    }

    async function authenticateUserRequest(req) {
        let credential = null;
        if (sessionSecret) {
            credential = userSessionRequest(req);
        }

        let openId;
        let claims = null;
        if (credential) {
            claims = verifySignedCredential(credential, SESSION_KINDS.USER);
            openId = claims.subject;
        } else if (allowLegacyUserHeader) {
            openId = String(req?.headers?.['x-open-id'] || '').trim();
            if (!openId) throw new HostAuthError('USER_AUTH_REQUIRED', 401, 'User authorization is required.');
        } else {
            requireSessionConfiguration();
            throw new HostAuthError('USER_AUTH_REQUIRED', 401, 'User authorization is required.');
        }

        if (hasMismatchedIdentityHint(req, openId)) {
            throw new HostAuthError('USER_IDENTITY_MISMATCH', 403, 'User identity does not match the session.');
        }
        if (claims) await assertUserSessionActive(claims);
        const user = await loadUser(openId);
        if (!user) throw new HostAuthError('USER_AUTH_INVALID', 401, 'User authorization is invalid.');
        return Object.freeze({
            kind: SESSION_KINDS.USER,
            openId: user.openId,
            role: user.role,
            user: user.document,
            sessionId: claims?.sessionId || null
        });
    }

    function adminCookieRequest(req) {
        try {
            return extractRequestToken(req, { cookieName: DEFAULT_COOKIE_NAMES.admin });
        } catch {
            throw new HostAuthError('ADMIN_CREDENTIAL_INVALID', 403, 'Administrator authorization is invalid.');
        }
    }

    async function assertAdminSessionActive(claims) {
        try {
            if (await isAdminSessionRevoked(AdminSessionRevocation, claims.sessionId)) {
                throw new HostAuthError(
                    'ADMIN_SESSION_REVOKED',
                    403,
                    'Administrator session has been revoked.'
                );
            }
        } catch (error) {
            if (error instanceof HostAuthError) throw error;
            if (error instanceof AdminSessionRevocationError) {
                throw new HostAuthError(
                    error.code,
                    503,
                    'Administrator authentication is unavailable.'
                );
            }
            throw error;
        }
    }

    async function authenticateAdminRequest(req) {
        const bearer = bearerCredential(req);
        const cookieCredential = adminCookieRequest(req);

        if (bearer && bearer !== LEGACY_ADMIN_SESSION_MARKER) {
            if (!adminToken || !timingSafeEqualText(bearer, adminToken)) {
                throw new HostAuthError('ADMIN_CREDENTIAL_INVALID', 403, 'Administrator authorization is invalid.');
            }
            return Object.freeze({
                kind: SESSION_KINDS.ADMIN,
                username: adminUsername,
                source: 'bearer',
                sessionId: null
            });
        }
        if (!cookieCredential) {
            throw new HostAuthError('ADMIN_AUTH_REQUIRED', 403, 'Administrator authorization is required.');
        }

        const claims = verifySignedCredential(cookieCredential, SESSION_KINDS.ADMIN);
        if (!timingSafeEqualText(claims.subject, adminUsername)) {
            throw new HostAuthError('ADMIN_CREDENTIAL_INVALID', 403, 'Administrator authorization is invalid.');
        }
        await assertAdminSessionActive(claims);
        return Object.freeze({
            kind: SESSION_KINDS.ADMIN,
            username: claims.subject,
            source: cookieCredential.source,
            sessionId: claims.sessionId
        });
    }

    function sendAuthFailure(res, error) {
        const status = error instanceof HostAuthError ? error.httpStatus : 500;
        const message = status >= 500
            ? 'Authentication service is unavailable.'
            : error.message;
        return res.status(status).json({ success: false, message });
    }

    async function requireUser(req, res, next) {
        try {
            const principal = await authenticateUserRequest(req);
            req.principal = principal;
            req.openId = principal.openId;
            req.user = principal.user;
            next();
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }

    async function requireAdmin(req, res, next) {
        try {
            const principal = await authenticateAdminRequest(req);
            req.principal = principal;
            req.admin = principal;
            next();
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }

    async function requireReviewerOrAdmin(req, res, next) {
        let hasAdminCredential = Boolean(req?.headers?.authorization);
        if (!hasAdminCredential) {
            try {
                hasAdminCredential = Boolean(adminCookieRequest(req));
            } catch {
                hasAdminCredential = true;
            }
        }
        if (hasAdminCredential) return requireAdmin(req, res, next);
        try {
            const principal = await authenticateUserRequest(req);
            if (principal.role !== 'reviewer') {
                throw new HostAuthError('REVIEWER_AUTH_REQUIRED', 403, 'Reviewer authorization is required.');
            }
            req.principal = principal;
            req.openId = principal.openId;
            req.user = principal.user;
            next();
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }

    function issueUserSession(res, user) {
        const openId = String(user?.openId || '').trim();
        const role = VALID_USER_ROLES.has(user?.role) ? user.role : 'collector';
        const token = createSessionToken({
            secret: requireSessionConfiguration(),
            kind: SESSION_KINDS.USER,
            subject: openId,
            role,
            ttlSec: userSessionTtlSec,
            now: clock()
        });
        appendSetCookie(res, serializeSessionCookie(
            DEFAULT_COOKIE_NAMES.user,
            token,
            cookieOptions(userSessionTtlSec)
        ));
        return token;
    }

    function issueAdminSession(res) {
        const token = createSessionToken({
            secret: requireSessionConfiguration(),
            kind: SESSION_KINDS.ADMIN,
            subject: adminUsername,
            ttlSec: adminSessionTtlSec,
            now: clock()
        });
        appendSetCookie(res, serializeSessionCookie(
            DEFAULT_COOKIE_NAMES.admin,
            token,
            cookieOptions(adminSessionTtlSec)
        ));
        return token;
    }

    function clearUserSession(res) {
        appendSetCookie(res, serializeExpiredCookie(DEFAULT_COOKIE_NAMES.user, expiredCookieOptions));
    }

    function clearAdminSession(res) {
        appendSetCookie(res, serializeExpiredCookie(DEFAULT_COOKIE_NAMES.admin, expiredCookieOptions));
    }

    async function revokeAdminSessionRequest(req) {
        const credential = adminCookieRequest(req);
        if (!credential) return false;

        let claims;
        try {
            claims = verifySignedCredential(credential, SESSION_KINDS.ADMIN);
            if (!timingSafeEqualText(claims.subject, adminUsername)) return false;
        } catch (error) {
            if (error instanceof HostAuthError && error.httpStatus >= 500) throw error;
            return false;
        }

        try {
            await revokeAdminSession(AdminSessionRevocation, claims);
            return true;
        } catch (error) {
            if (error instanceof AdminSessionRevocationError) {
                throw new HostAuthError(
                    error.code,
                    503,
                    'Administrator authentication is unavailable.'
                );
            }
            throw error;
        }
    }

    async function revokeUserSessionRequest(req) {
        const credentials = userLogoutCredentials(req);
        let revoked = false;
        for (const credential of credentials) {
            let claims;
            try {
                claims = verifySignedCredential(credential, SESSION_KINDS.USER);
            } catch (error) {
                if (error instanceof HostAuthError && error.httpStatus >= 500) throw error;
                continue;
            }

            try {
                await revokeUserSession(UserSessionRevocation, claims);
                revoked = true;
            } catch (error) {
                if (error instanceof UserSessionRevocationError) {
                    throw new HostAuthError(
                        error.code,
                        503,
                        'User authentication is unavailable.'
                    );
                }
                throw error;
            }
        }
        return revoked;
    }

    async function authenticateSocket(socket) {
        const headers = socket?.handshake?.headers || {};
        const request = { headers: { ...headers } };
        const auth = socket?.handshake?.auth || {};

        const adminCookie = adminCookieRequest(request);
        let admin = null;
        if (auth.adminSession) {
            admin = verifySignedCredential({ token: String(auth.adminSession), source: 'socket-auth' }, SESSION_KINDS.ADMIN);
        } else if (adminCookie) {
            admin = verifySignedCredential(adminCookie, SESSION_KINDS.ADMIN);
        }
        if (admin && !timingSafeEqualText(admin.subject, adminUsername)) {
            throw new HostAuthError('ADMIN_CREDENTIAL_INVALID', 403, 'Administrator authorization is invalid.');
        }
        if (admin) await assertAdminSessionActive(admin);

        let userCredential = null;
        if (auth.sessionToken) {
            userCredential = { token: String(auth.sessionToken), source: 'socket-auth' };
        } else if (sessionSecret) {
            try {
                userCredential = extractRequestToken(request, {
                    cookieName: DEFAULT_COOKIE_NAMES.user
                });
            } catch {
                throw new HostAuthError('SESSION_INVALID', 401, 'Session authorization is invalid.');
            }
        }

        let user = null;
        let userClaims = null;
        if (userCredential) {
            userClaims = verifySignedCredential(userCredential, SESSION_KINDS.USER);
            await assertUserSessionActive(userClaims);
            user = await loadUser(userClaims.subject);
            if (!user) throw new HostAuthError('USER_AUTH_INVALID', 401, 'User authorization is invalid.');
            if (hasMismatchedIdentityHint({
                headers,
                body: auth,
                query: socket?.handshake?.query
            }, user.openId)) {
                throw new HostAuthError('USER_IDENTITY_MISMATCH', 403, 'User identity does not match the session.');
            }
        }

        if (!admin && !user) {
            if (allowLegacyUserHeader) {
                const query = socket?.handshake?.query || {};
                const queryOpenId = String(
                    query.openId || query.openid || query.userOpenId || ''
                ).trim();
                if (queryOpenId && hasMismatchedIdentityHint({ query }, queryOpenId)) {
                    throw new HostAuthError(
                        'USER_IDENTITY_MISMATCH',
                        403,
                        'User identity does not match the session.'
                    );
                }
                if (queryOpenId) user = await loadUser(queryOpenId);
            }
            if (!user) throw new HostAuthError('SOCKET_AUTH_REQUIRED', 401, 'Socket authorization is required.');
        }

        return Object.freeze({
            isAdmin: Boolean(admin),
            adminUsername: admin?.subject || null,
            adminSessionId: admin?.sessionId || null,
            adminExpiresAt: admin?.expiresAt || null,
            openId: user?.openId || null,
            role: user?.role || null,
            user: user?.document || null,
            userSessionId: userClaims?.sessionId || null,
            userExpiresAt: userClaims?.expiresAt || null,
            userAuthSource: userClaims ? 'session' : user ? 'legacy' : null
        });
    }

    async function socketMiddleware(socket, next) {
        try {
            const identity = await authenticateSocket(socket);
            socket.authIdentity = identity;
            socket.isAdmin = identity.isAdmin;
            socket.openId = identity.openId;
            socket.role = identity.role;
            next();
        } catch {
            next(new Error('unauthorized'));
        }
    }

    async function getSocketIdentity(socket) {
        const identity = socket?.authIdentity;
        if (!identity) return null;
        const nowSec = Math.floor(Number(clock()) / 1000);
        let adminValid = identity.isAdmin
            && Number.isInteger(identity.adminExpiresAt)
            && identity.adminExpiresAt > nowSec
            && timingSafeEqualText(String(identity.adminUsername || ''), adminUsername);
        if (adminValid) {
            try {
                adminValid = !(await isAdminSessionRevoked(
                    AdminSessionRevocation,
                    identity.adminSessionId
                ));
            } catch {
                adminValid = false;
            }
        }
        let user = null;
        let userSessionValid = identity.userAuthSource === 'legacy'
            ? allowLegacyUserHeader
            : Number.isInteger(identity.userExpiresAt) && identity.userExpiresAt > nowSec;
        if (userSessionValid && identity.userAuthSource !== 'legacy') {
            try {
                userSessionValid = !(await isUserSessionRevoked(
                    UserSessionRevocation,
                    identity.userSessionId
                ));
            } catch {
                userSessionValid = false;
            }
        }
        if (identity.openId && userSessionValid) user = await loadUser(identity.openId);
        if (!adminValid && !user) return null;
        return {
            isAdmin: adminValid,
            ...(adminValid ? { adminUsername } : {}),
            ...(user ? { openId: user.openId, role: user.role, user: user.document } : {})
        };
    }

    return Object.freeze({
        configured: Boolean(sessionSecret),
        configurationError: sessionConfigurationError,
        userSessionTtlSec,
        adminSessionTtlSec,
        authenticateUserRequest,
        authenticateAdminRequest,
        requireUser,
        requireAdmin,
        requireReviewerOrAdmin,
        issueUserSession,
        issueAdminSession,
        clearUserSession,
        clearAdminSession,
        revokeUserSession: revokeUserSessionRequest,
        revokeAdminSession: revokeAdminSessionRequest,
        authenticateSocket,
        socketMiddleware,
        getSocketIdentity
    });
}

module.exports = {
    LEGACY_ADMIN_SESSION_MARKER,
    HostAuthError,
    createGlobalLogoutHandler,
    createHostAuth
};
