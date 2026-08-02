'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { registerModels } = require('../models');

const EXIT = Object.freeze({
    OK: 0,
    FAILURE: 1
});

const HOST_POI_INDEXES = Object.freeze([
    Object.freeze({
        key: Object.freeze({ geo: '2dsphere' }),
        options: Object.freeze({ sparse: true })
    }),
    Object.freeze({
        key: Object.freeze({ status: 1, 'visitMeta.tags': 1 }),
        options: Object.freeze({})
    })
]);

async function createHostPoiIndexes(ExternalPoi) {
    if (!ExternalPoi?.collection || typeof ExternalPoi.collection.createIndex !== 'function') {
        throw new TypeError('ExternalPoi collection with createIndex is required');
    }
    for (const index of HOST_POI_INDEXES) {
        await ExternalPoi.collection.createIndex(index.key, index.options);
    }
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

async function initializeIndexes({ models, log = console.log, error = console.error }) {
    let failed = false;
    for (const [name, model] of Object.entries(models)) {
        if (name.startsWith('External') && name !== 'ExternalPoi') continue;
        try {
            if (name === 'ExternalPoi') {
                await createHostPoiIndexes(model);
            } else {
                if (name === 'CapacityToken') await dropLegacyCapacityIndex(model, log);
                await model.createIndexes();
            }
            log(`[init-indexes] ${model.collection.name} ok`);
        } catch (cause) {
            const code = /^[A-Z0-9_:-]{1,64}$/.test(String(cause?.code || ''))
                ? cause.code
                : 'INDEX_CREATE_FAILED';
            error(`[init-indexes] ${model.collection?.name || name} FAILED: ${code}`);
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
        const exitCode = await initializeIndexes({ models, log, error });
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
    HOST_POI_INDEXES,
    createHostPoiIndexes,
    initializeIndexes,
    runIndexInitialization
};
