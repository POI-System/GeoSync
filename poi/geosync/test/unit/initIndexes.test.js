'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    EXIT,
    HOST_INDEX_MANIFEST,
    initializeIndexes,
    runIndexInitialization
} = require('../../scripts/init-indexes');

function fakeDatabase({ failCollection = '', failCode = '' } = {}) {
    const calls = new Map();
    return {
        calls,
        database: {
            collection(name) {
                if (!calls.has(name)) calls.set(name, []);
                return {
                    async createIndex(key, options) {
                        if (name === failCollection) {
                            const error = new Error('index failure');
                            if (failCode) error.code = failCode;
                            throw error;
                        }
                        calls.get(name).push({
                            key: structuredClone(key),
                            options: structuredClone(options)
                        });
                    }
                };
            }
        }
    };
}

function expectedHostManifest() {
    return [
        {
            collection: 'users',
            indexes: [
                { key: { openId: 1 }, options: { unique: true } }
            ]
        },
        {
            collection: 'pois',
            indexes: [
                { key: { userOpenId: 1 }, options: {} },
                { key: { status: 1 }, options: {} },
                { key: { geo: '2dsphere' }, options: { sparse: true } },
                { key: { status: 1, 'visitMeta.tags': 1 }, options: {} }
            ]
        },
        {
            collection: 'notifications',
            indexes: [
                { key: { recipientOpenId: 1 }, options: {} },
                { key: { type: 1 }, options: {} },
                { key: { read: 1 }, options: {} },
                { key: { createTime: 1 }, options: {} }
            ]
        },
        {
            collection: 'chatmessages',
            indexes: [
                { key: { roomId: 1 }, options: {} },
                { key: { fromOpenId: 1 }, options: {} },
                { key: { createTime: 1 }, options: {} }
            ]
        },
        {
            collection: 'chatrooms',
            indexes: [
                { key: { roomId: 1 }, options: { unique: true } },
                { key: { type: 1 }, options: {} },
                { key: { poiId: 1 }, options: {} },
                { key: { collectorOpenId: 1 }, options: {} },
                { key: { reviewerOpenId: 1 }, options: {} },
                { key: { lastTime: 1 }, options: {} },
                { key: { createTime: 1 }, options: {} }
            ]
        },
        {
            collection: 'systemsettings',
            indexes: [
                { key: { key: 1 }, options: { unique: true } }
            ]
        },
        {
            collection: 'disputes',
            indexes: [
                { key: { poiId: 1 }, options: {} },
                { key: { collectorOpenId: 1 }, options: {} },
                { key: { tokenHash: 1 }, options: { unique: true } },
                { key: { status: 1 }, options: {} },
                { key: { createTime: 1 }, options: {} }
            ]
        }
    ];
}

test('host index manifest covers every server-owned schema index', () => {
    assert.deepEqual(HOST_INDEX_MANIFEST, expectedHostManifest());
    assert.equal(HOST_INDEX_MANIFEST.reduce((total, entry) => total + entry.indexes.length, 0), 25);
    assert.equal(Object.isFrozen(HOST_INDEX_MANIFEST), true);
    for (const entry of HOST_INDEX_MANIFEST) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.indexes), true);
        for (const index of entry.indexes) {
            assert.equal(Object.isFrozen(index), true);
            assert.equal(Object.isFrozen(index.key), true);
            assert.equal(Object.isFrozen(index.options), true);
        }
    }
});

test('index initialization creates host indexes incrementally and skips external models', async () => {
    const host = fakeDatabase();
    let externalPoiCalls = 0;
    let externalUserCalls = 0;
    let normalModelCalls = 0;
    const logs = [];
    const errors = [];

    const code = await initializeIndexes({
        database: host.database,
        models: {
            ExternalPoi: {
                collection: { name: 'pois' },
                async createIndexes() { externalPoiCalls++; }
            },
            ExternalUser: {
                collection: { name: 'users' },
                async createIndexes() { externalUserCalls++; }
            },
            WalkEdge: {
                collection: { name: 'walkgraph_edges' },
                async createIndexes() { normalModelCalls++; }
            }
        },
        log: message => logs.push(message),
        error: message => errors.push(message)
    });

    assert.equal(code, EXIT.OK);
    for (const entry of HOST_INDEX_MANIFEST) {
        assert.deepEqual(host.calls.get(entry.collection), entry.indexes);
    }
    assert.equal(externalPoiCalls, 0);
    assert.equal(externalUserCalls, 0);
    assert.equal(normalModelCalls, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(logs, [
        ...HOST_INDEX_MANIFEST.map(entry => `[init-indexes] ${entry.collection} ok`),
        '[init-indexes] walkgraph_edges ok'
    ]);
});

test('one host collection failure is sanitized, reported, and does not stop remaining indexes', async () => {
    const host = fakeDatabase({
        failCollection: 'notifications',
        failCode: 'INDEX_OPTIONS_CONFLICT'
    });
    let modelCalls = 0;
    const logs = [];
    const errors = [];

    const code = await initializeIndexes({
        database: host.database,
        models: {
            WalkEdge: {
                collection: { name: 'walkgraph_edges' },
                async createIndexes() { modelCalls++; }
            }
        },
        log: message => logs.push(message),
        error: message => errors.push(message)
    });

    assert.equal(code, EXIT.FAILURE);
    assert.equal(modelCalls, 1);
    assert.deepEqual(host.calls.get('notifications'), []);
    assert.equal(host.calls.get('disputes').length, 5,
        'collections after the failed one must still be initialized');
    assert.deepEqual(errors, [
        '[init-indexes] notifications FAILED: INDEX_OPTIONS_CONFLICT'
    ]);
    assert.equal(logs.includes('[init-indexes] walkgraph_edges ok'), true);
});

test('deployment index runner disables implicit index creation and disconnects', async () => {
    const host = fakeDatabase();
    const settings = [];
    let connectArgs;
    let disconnectCalls = 0;
    const logs = [];

    const mongooseInstance = {
        connection: { db: host.database },
        set: (key, value) => settings.push([key, value]),
        async connect(...args) { connectArgs = args; },
        async disconnect() { disconnectCalls++; }
    };
    const code = await runIndexInitialization({
        env: { MONGO_URI: 'mongodb://example.invalid/poi' },
        mongooseInstance,
        registerModelsFn: () => ({}),
        log: message => logs.push(message),
        error: () => assert.fail('index initialization should not report an error')
    });

    assert.equal(code, EXIT.OK);
    assert.deepEqual(settings, [['autoIndex', false], ['autoCreate', false]]);
    assert.deepEqual(connectArgs, [
        'mongodb://example.invalid/poi',
        { autoIndex: false, autoCreate: false }
    ]);
    assert.equal(disconnectCalls, 1);
    for (const entry of HOST_INDEX_MANIFEST) {
        assert.deepEqual(host.calls.get(entry.collection), entry.indexes);
    }
    assert.deepEqual(logs, [
        ...HOST_INDEX_MANIFEST.map(entry => `[init-indexes] ${entry.collection} ok`),
        '[init-indexes] done'
    ]);
});

test('deployment index runner requires an explicit MongoDB target before writing indexes', async () => {
    let connectCalls = 0;
    await assert.rejects(
        runIndexInitialization({
            env: {},
            mongooseInstance: {
                async connect() { connectCalls++; }
            }
        }),
        /MONGO_URI is required/
    );
    assert.equal(connectCalls, 0);
});
