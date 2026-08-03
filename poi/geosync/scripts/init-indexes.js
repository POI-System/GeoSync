'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { registerModels } = require('../models');

const EXIT = Object.freeze({
    OK: 0,
    FAILURE: 1
});

function hostIndex(key, options = {}) {
    return Object.freeze({
        key: Object.freeze({ ...key }),
        options: Object.freeze({ ...options })
    });
}

function hostCollection(collection, indexes) {
    return Object.freeze({
        collection,
        indexes: Object.freeze(indexes)
    });
}

// Host schemas live in server.js and are not compiled by the standalone
// GeoSync index runner. Keep their production indexes explicit here so the
// application can disable runtime autoIndex without relying on an old database.
const HOST_INDEX_MANIFEST = Object.freeze([
    hostCollection('users', [
        hostIndex({ openId: 1 }, { unique: true })
    ]),
    hostCollection('pois', [
        hostIndex({ userOpenId: 1 }),
        hostIndex({ status: 1 }),
        hostIndex({ geo: '2dsphere' }, { sparse: true }),
        hostIndex({ status: 1, 'visitMeta.tags': 1 })
    ]),
    hostCollection('notifications', [
        hostIndex({ recipientOpenId: 1 }),
        hostIndex({ type: 1 }),
        hostIndex({ read: 1 }),
        hostIndex({ createTime: 1 })
    ]),
    hostCollection('chatmessages', [
        hostIndex({ roomId: 1 }),
        hostIndex({ fromOpenId: 1 }),
        hostIndex({ createTime: 1 })
    ]),
    hostCollection('chatrooms', [
        hostIndex({ roomId: 1 }, { unique: true }),
        hostIndex({ type: 1 }),
        hostIndex({ poiId: 1 }),
        hostIndex({ collectorOpenId: 1 }),
        hostIndex({ reviewerOpenId: 1 }),
        hostIndex({ lastTime: 1 }),
        hostIndex({ createTime: 1 })
    ]),
    hostCollection('systemsettings', [
        hostIndex({ key: 1 }, { unique: true })
    ]),
    hostCollection('disputes', [
        hostIndex({ poiId: 1 }),
        hostIndex({ collectorOpenId: 1 }),
        hostIndex({ tokenHash: 1 }, { unique: true }),
        hostIndex({ status: 1 }),
        hostIndex({ createTime: 1 })
    ])
]);

function sanitizedIndexErrorCode(cause) {
    return /^[A-Z0-9_:-]{1,64}$/.test(String(cause?.code || ''))
        ? cause.code
        : 'INDEX_CREATE_FAILED';
}

async function initializeHostIndexes({ database, log, error }) {
    if (!database || typeof database.collection !== 'function') {
        throw new TypeError('MongoDB database with collection access is required');
    }
    let failed = false;
    for (const entry of HOST_INDEX_MANIFEST) {
        try {
            const collection = database.collection(entry.collection);
            if (!collection || typeof collection.createIndex !== 'function') {
                throw new TypeError(`Collection ${entry.collection} cannot create indexes`);
            }
            for (const index of entry.indexes) {
                await collection.createIndex(index.key, index.options);
            }
            log(`[init-indexes] ${entry.collection} ok`);
        } catch (cause) {
            error(`[init-indexes] ${entry.collection} FAILED: ${sanitizedIndexErrorCode(cause)}`);
            failed = true;
        }
    }
    return failed;
}

async function dropLegacyCapacityIndex(model, log) {
    const indexes = await model.collection.indexes().catch(error => {
        if (error.codeName === 'NamespaceNotFound') return [];
        throw error;
    });
    const legacy = indexes.find(index =>
        index.name !== 'capacity_slot_active_unique'
        && JSON.stringify(index.key) === JSON.stringify({
            scenicId: 1, poiId: 1, timeSlot: 1, capacitySlot: 1
        }));
    if (!legacy) return;
    await model.collection.dropIndex(legacy.name);
    log(`[init-indexes] dropped legacy index ${legacy.name}`);
}

async function initializeIndexes({
    models,
    database,
    log = console.log,
    error = console.error
}) {
    let failed = await initializeHostIndexes({ database, log, error });
    for (const [name, model] of Object.entries(models)) {
        if (name.startsWith('External')) continue;
        try {
            if (name === 'CapacityToken') await dropLegacyCapacityIndex(model, log);
            await model.createIndexes();
            log(`[init-indexes] ${model.collection.name} ok`);
        } catch (cause) {
            error(`[init-indexes] ${model.collection?.name || name} FAILED: ${sanitizedIndexErrorCode(cause)}`);
            failed = true;
        }
    }
    return failed ? EXIT.FAILURE : EXIT.OK;
}

async function runIndexInitialization({
    env = process.env,
    mongooseInstance = mongoose,
    registerModelsFn = registerModels,
    log = console.log,
    error = console.error
} = {}) {
    const uri = String(env.MONGO_URI || '').trim();
    if (!uri) throw new TypeError('MONGO_URI is required for index initialization');
    let connected = false;
    try {
        if (typeof mongooseInstance.set === 'function') {
            mongooseInstance.set('autoIndex', false);
            mongooseInstance.set('autoCreate', false);
        }
        await mongooseInstance.connect(uri, { autoIndex: false, autoCreate: false });
        connected = true;
        const models = registerModelsFn(mongooseInstance);
        const exitCode = await initializeIndexes({
            models,
            database: mongooseInstance.connection?.db,
            log,
            error
        });
        log('[init-indexes] done');
        return exitCode;
    } finally {
        if (connected) await mongooseInstance.disconnect();
    }
}

if (require.main === module) {
    runIndexInitialization()
        .then(code => {
            process.exitCode = code;
        })
        .catch(() => {
            console.error('[init-indexes] failed: INDEX_INITIALIZATION_FAILED');
            process.exitCode = EXIT.FAILURE;
        });
}

module.exports = {
    EXIT,
    HOST_INDEX_MANIFEST,
    initializeHostIndexes,
    initializeIndexes,
    runIndexInitialization
};
