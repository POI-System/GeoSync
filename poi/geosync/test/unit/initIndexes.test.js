'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    EXIT,
    HOST_POI_INDEXES,
    initializeIndexes,
    runIndexInitialization
} = require('../../scripts/init-indexes');

function fakePoiModel() {
    const calls = [];
    return {
        calls,
        collection: {
            name: 'pois',
            async createIndex(key, options) {
                calls.push({ key: structuredClone(key), options: structuredClone(options) });
            }
        },
        async createIndexes() {
            throw new Error('ExternalPoi schema indexes are not registered in standalone mode');
        }
    };
}

test('index initialization explicitly creates the required host POI indexes', async () => {
    const ExternalPoi = fakePoiModel();
    let externalUserCalls = 0;
    let normalModelCalls = 0;
    const logs = [];
    const errors = [];

    const code = await initializeIndexes({
        models: {
            ExternalPoi,
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
    assert.deepEqual(ExternalPoi.calls, HOST_POI_INDEXES);
    assert.equal(externalUserCalls, 0);
    assert.equal(normalModelCalls, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(logs, [
        '[init-indexes] pois ok',
        '[init-indexes] walkgraph_edges ok'
    ]);
});

test('deployment index runner disables implicit index creation and disconnects', async () => {
    const ExternalPoi = fakePoiModel();
    const settings = [];
    let connectArgs;
    let disconnectCalls = 0;
    const logs = [];

    const code = await runIndexInitialization({
        env: { MONGO_URI: 'mongodb://example.invalid/poi' },
        mongooseInstance: {
            set: (key, value) => settings.push([key, value]),
            async connect(...args) { connectArgs = args; },
            async disconnect() { disconnectCalls++; }
        },
        registerModelsFn: () => ({ ExternalPoi }),
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
    assert.equal(ExternalPoi.calls.length, 2);
    assert.deepEqual(logs, ['[init-indexes] pois ok', '[init-indexes] done']);
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
