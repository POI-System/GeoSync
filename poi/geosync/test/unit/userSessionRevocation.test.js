'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
    COLLECTION_NAME,
    REVOCATION_TTL_GRACE_SEC,
    hashUserSessionId,
    getUserSessionRevocationModel,
    isUserSessionRevoked,
    revokeUserSession
} = require('../../services/userSessionRevocation');

test('user revocation model stores only a hashed id and TTL expiry', () => {
    const isolatedMongoose = new mongoose.Mongoose();
    const Model = getUserSessionRevocationModel(isolatedMongoose);
    const applicationPaths = Object.keys(Model.schema.paths)
        .filter(path => path !== '__v')
        .sort();
    const ttlIndex = Model.schema.indexes().find(([keys]) => keys.expiresAt === 1);

    assert.deepEqual(applicationPaths, ['_id', 'expiresAt']);
    assert.equal(Model.collection.collectionName, COLLECTION_NAME);
    assert.deepEqual(ttlIndex, [
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'user_session_revocation_expiry_ttl', background: true }
    ]);
});

test('user revocation operations never persist the raw jti', async () => {
    const records = new Map();
    const calls = [];
    const Model = {
        findOne(filter) {
            calls.push({ operation: 'findOne', filter });
            return { lean: async () => records.get(filter._id) || null };
        },
        async updateOne(filter, update, options) {
            calls.push({ operation: 'updateOne', filter, update, options });
            records.set(filter._id, update.$setOnInsert);
        }
    };
    const session = {
        sessionId: 'user-session-sensitive-value',
        expiresAt: Math.floor(Date.parse('2026-08-03T12:00:00.000Z') / 1000)
    };
    const expectedHash = hashUserSessionId(session.sessionId);

    assert.equal(await isUserSessionRevoked(Model, session.sessionId), false);
    const stored = await revokeUserSession(Model, session);
    assert.equal(stored.id, expectedHash);
    assert.equal(stored.expiresAt.getTime(), (session.expiresAt + REVOCATION_TTL_GRACE_SEC) * 1000);
    assert.equal(await isUserSessionRevoked(Model, session.sessionId), true);
    assert.equal(JSON.stringify(calls).includes(session.sessionId), false);
    assert.match(expectedHash, /^[a-f0-9]{64}$/);
});

test('user revocation storage failures are sanitized and fail closed', async () => {
    const { UserSessionRevocationError } = require('../../services/userSessionRevocation');
    const readFailure = {
        findOne() { return { lean: async () => { throw new Error('private read detail'); } }; },
        async updateOne() {}
    };
    await assert.rejects(
        isUserSessionRevoked(readFailure, 'user-session-1'),
        error => error instanceof UserSessionRevocationError
            && error.code === 'USER_SESSION_REVOCATION_UNAVAILABLE'
            && !error.message.includes('private')
    );

    const writeFailure = {
        findOne() { return { lean: async () => null }; },
        async updateOne() { throw new Error('private write detail'); }
    };
    await assert.rejects(
        revokeUserSession(writeFailure, { sessionId: 'user-session-1', expiresAt: 1785758400 }),
        error => error instanceof UserSessionRevocationError
            && error.code === 'USER_SESSION_REVOCATION_UNAVAILABLE'
            && !error.message.includes('private')
    );
});
