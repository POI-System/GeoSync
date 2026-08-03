'use strict';

const crypto = require('node:crypto');

const MODEL_NAME = 'AdminSessionRevocation';
const COLLECTION_NAME = 'admin_session_revocations';
const REVOCATION_TTL_GRACE_SEC = 60;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class AdminSessionRevocationError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'AdminSessionRevocationError';
        this.code = code;
        Error.captureStackTrace?.(this, this.constructor);
    }
}

function requireSessionId(value) {
    const sessionId = String(value || '').trim();
    if (!sessionId || sessionId.length > 128) {
        throw new TypeError('admin session id is invalid');
    }
    return sessionId;
}

function hashAdminSessionId(sessionId) {
    return crypto.createHash('sha256')
        .update(`poi-admin-session-jti:${requireSessionId(sessionId)}`, 'utf8')
        .digest('hex');
}

function getAdminSessionRevocationModel(mongoose) {
    if (!mongoose || typeof mongoose.model !== 'function') {
        throw new TypeError('Mongoose is required for administrator session revocation');
    }
    if (mongoose.models?.[MODEL_NAME]) return mongoose.models[MODEL_NAME];

    const Schema = mongoose.Schema || mongoose.base?.Schema;
    if (typeof Schema !== 'function') {
        throw new TypeError('Mongoose Schema is unavailable');
    }
    const schema = new Schema({
        _id: {
            type: String,
            required: true,
            immutable: true,
            validate: value => HASH_PATTERN.test(String(value || ''))
        },
        expiresAt: { type: Date, required: true, immutable: true }
    }, {
        collection: COLLECTION_NAME,
        strict: 'throw',
        versionKey: false
    });
    schema.index({ expiresAt: 1 }, {
        expireAfterSeconds: 0,
        name: 'admin_session_revocation_expiry_ttl'
    });
    return mongoose.model(MODEL_NAME, schema);
}

function requireModel(model) {
    if (!model || typeof model.findOne !== 'function' || typeof model.updateOne !== 'function') {
        throw new TypeError('AdminSessionRevocation model is required');
    }
    return model;
}

async function leanResult(query) {
    return query && typeof query.lean === 'function' ? query.lean() : query;
}

function unavailable(cause) {
    return new AdminSessionRevocationError(
        'ADMIN_SESSION_REVOCATION_UNAVAILABLE',
        'Administrator session revocation state is unavailable.',
        { cause }
    );
}

async function isAdminSessionRevoked(model, sessionId) {
    const id = hashAdminSessionId(sessionId);
    try {
        const record = await leanResult(requireModel(model).findOne({ _id: id }, { _id: 1 }));
        return Boolean(record);
    } catch (error) {
        if (error instanceof TypeError) throw error;
        throw unavailable(error);
    }
}

async function revokeAdminSession(model, session, options = {}) {
    const id = hashAdminSessionId(session?.sessionId);
    const expiresAtSec = Number(session?.expiresAt);
    if (!Number.isInteger(expiresAtSec) || expiresAtSec <= 0) {
        throw new TypeError('administrator session expiry is invalid');
    }
    const graceSec = Number.isInteger(options.graceSec)
        && options.graceSec >= 0
        && options.graceSec <= 300
        ? options.graceSec
        : REVOCATION_TTL_GRACE_SEC;
    const expiresAt = new Date((expiresAtSec + graceSec) * 1000);

    try {
        await requireModel(model).updateOne(
            { _id: id },
            { $setOnInsert: { _id: id, expiresAt } },
            { upsert: true, runValidators: true }
        );
        return Object.freeze({ id, expiresAt });
    } catch (error) {
        if (error instanceof TypeError) throw error;
        throw unavailable(error);
    }
}

module.exports = {
    MODEL_NAME,
    COLLECTION_NAME,
    REVOCATION_TTL_GRACE_SEC,
    AdminSessionRevocationError,
    hashAdminSessionId,
    getAdminSessionRevocationModel,
    isAdminSessionRevoked,
    revokeAdminSession
};
