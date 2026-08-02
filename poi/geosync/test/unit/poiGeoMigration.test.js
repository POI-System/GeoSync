'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const { visitMetaDefaults } = require('../../services/hostPoiSchema');
const {
    planPoiGeoMigration,
    runPoiGeoMigration
} = require('../../services/poiGeoMigration');
const {
    EXIT,
    CliInputError,
    parseArgs,
    runCli
} = require('../../scripts/migrate-poi-geo');

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function setPath(target, path, value) {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index++) {
        cursor[parts[index]] ||= {};
        cursor = cursor[parts[index]];
    }
    cursor[parts.at(-1)] = copy(value);
}

function hasPath(target, path) {
    const parts = path.split('.');
    let cursor = target;
    for (const part of parts) {
        if (!cursor || !Object.prototype.hasOwnProperty.call(cursor, part)) return false;
        cursor = cursor[part];
    }
    return true;
}

function getPath(target, path) {
    return path.split('.').reduce((value, part) => value?.[part], target);
}

function matchesFilter(doc, filter) {
    return Object.entries(filter).every(([path, expected]) => {
        if (path === '_id') return String(doc?._id) === String(expected);
        if (expected && typeof expected === 'object'
            && Object.keys(expected).length === 1
            && Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return hasPath(doc, path) === expected.$exists;
        }
        return isDeepStrictEqual(getPath(doc, path), expected);
    });
}

function createModel(initialDocs, { failIds = [], beforeUpdate } = {}) {
    const docs = new Map(initialDocs.map(doc => [String(doc._id), copy(doc)]));
    const calls = { updates: [] };
    return {
        docs,
        calls,
        find() {
            return { lean: async () => [...docs.values()].map(copy) };
        },
        findOne(filter) {
            return { lean: async () => copy(docs.get(String(filter._id)) || null) };
        },
        async updateOne(filter, update) {
            const id = String(filter._id);
            calls.updates.push({ filter: copy(filter), update: copy(update) });
            if (failIds.includes(id)) throw new Error(`raw-db-error-${id}`);
            if (typeof beforeUpdate === 'function') {
                await beforeUpdate({ id, docs, filter: copy(filter), update: copy(update) });
            }
            const doc = docs.get(id);
            if (!doc || !matchesFilter(doc, filter)) return { matchedCount: 0 };
            for (const [path, value] of Object.entries(update.$set || {})) {
                setPath(doc, path, value);
            }
            return { matchedCount: 1 };
        }
    };
}

function completeVisitMeta(overrides = {}) {
    return { ...visitMetaDefaults({ category: 'history', scenicId: 'scenic-a' }), ...overrides };
}

function captureStream() {
    let value = '';
    return {
        stream: { write: chunk => { value += String(chunk); } },
        value: () => value
    };
}

test('POI migration planning reports updates, skips, failures, and deferred authoritative mappings', () => {
    const plan = planPoiGeoMigration({
        scenicId: 'scenic-a',
        pois: [{
            _id: 'poi-1',
            category: 'history',
            location: { lng: 120, lat: 30 }
        }, {
            _id: 'poi-2',
            geo: { type: 'Point', coordinates: [120.1, 30.1] },
            visitMeta: completeVisitMeta(),
            gateNodeId: 'gate-2',
            superMapRef: { datasetName: 'Poi@Test', smId: 2, dataVersion: 'v1' }
        }, {
            _id: 'poi-3',
            location: { lng: 220, lat: 30 },
            visitMeta: completeVisitMeta()
        }]
    });

    assert.deepEqual(plan.summary, {
        total: 3,
        success: 1,
        skipped: 1,
        failed: 1,
        gateNodeIdDeferred: 2,
        superMapRefDeferred: 2
    });
    assert.deepEqual(plan.operations[0].patch.geo, {
        type: 'Point', coordinates: [120, 30]
    });
    assert.equal(plan.operations[0].patch.visitMeta.category, 'history');
    assert.equal(plan.operations[0].patch.visitMeta.capacity, 50);
    assert.equal(plan.operations[0].patch.visitMeta.dwellMin, 20);
    assert.equal(plan.errors[0].code, 'INVALID_LOCATION');
});

test('dry-run performs no writes while apply is conditional and idempotent', async () => {
    const model = createModel([{
        _id: 'poi-1',
        category: 'museum',
        location: { lng: 120, lat: 30 }
    }]);

    const dryRun = await runPoiGeoMigration({ POI: model, scenicId: 'scenic-a' });
    assert.equal(dryRun.mode, 'dry-run');
    assert.deepEqual(dryRun.summary, {
        total: 1,
        success: 1,
        skipped: 0,
        failed: 0,
        gateNodeIdDeferred: 1,
        superMapRefDeferred: 1
    });
    assert.equal(model.calls.updates.length, 0);

    const applied = await runPoiGeoMigration({
        POI: model,
        scenicId: 'scenic-a',
        apply: true
    });
    assert.equal(applied.mode, 'apply');
    assert.deepEqual(applied.summary, {
        total: 1,
        success: 1,
        skipped: 0,
        failed: 0,
        gateNodeIdDeferred: 1,
        superMapRefDeferred: 1
    });
    assert.equal(model.calls.updates.length, 1);
    assert.deepEqual(model.docs.get('poi-1').geo.coordinates, [120, 30]);
    assert.equal(model.docs.get('poi-1').visitMeta.scenicId, 'scenic-a');

    const repeated = await runPoiGeoMigration({
        POI: model,
        scenicId: 'scenic-a',
        apply: true
    });
    assert.deepEqual(repeated.summary, {
        total: 1,
        success: 0,
        skipped: 1,
        failed: 0,
        gateNodeIdDeferred: 1,
        superMapRefDeferred: 1
    });
    assert.equal(model.calls.updates.length, 1);
});

test('apply continues after sanitized per-POI write failures', async () => {
    const model = createModel([{
        _id: 'poi-fail', location: { lng: 120, lat: 30 }
    }, {
        _id: 'poi-ok', location: { lng: 121, lat: 31 }
    }], { failIds: ['poi-fail'] });

    const result = await runPoiGeoMigration({ POI: model, apply: true });
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.success, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.errors[0].code, 'WRITE_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /raw-db-error/);
    assert.deepEqual(model.docs.get('poi-ok').geo.coordinates, [121, 31]);
});

test('apply rejects a concurrent source change without writing the stale plan', async () => {
    const model = createModel([{
        _id: 'poi-race',
        category: 'history',
        location: { lng: 120, lat: 30 }
    }], {
        beforeUpdate: ({ id, docs }) => {
            const current = docs.get(id);
            current.category = 'museum';
            current.location = { lng: 121, lat: 31 };
        }
    });

    const result = await runPoiGeoMigration({
        POI: model,
        scenicId: 'scenic-a',
        apply: true
    });

    assert.deepEqual(result.summary, {
        total: 1,
        success: 0,
        skipped: 0,
        failed: 1,
        gateNodeIdDeferred: 1,
        superMapRefDeferred: 1
    });
    assert.equal(result.errors[0].code, 'CONCURRENT_CHANGE');
    assert.equal(result.errors[0].message, 'POI changed after migration planning');
    assert.deepEqual(model.calls.updates[0].filter.location, { lng: 120, lat: 30 });
    assert.equal(model.calls.updates[0].filter.category, 'history');
    assert.deepEqual(model.docs.get('poi-race'), {
        _id: 'poi-race',
        category: 'museum',
        location: { lng: 121, lat: 31 }
    });
});

test('migration rejects malformed visit metadata without partial writes', async () => {
    const model = createModel([{
        _id: 'poi-bad-meta',
        location: { lng: 120, lat: 30 },
        visitMeta: { openHours: '09:00-17:00' }
    }]);
    const result = await runPoiGeoMigration({ POI: model, apply: true });
    assert.equal(result.summary.success, 0);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.errors[0].code, 'INVALID_VISIT_META_OPEN_HOURS');
    assert.equal(model.calls.updates.length, 0);
});

test('CLI defaults to dry-run, rejects unsafe input, and disables automatic DB writes', async () => {
    assert.deepEqual(parseArgs([]), { apply: false, help: false });
    assert.deepEqual(parseArgs(['--apply']), { apply: true, help: false });
    assert.throws(() => parseArgs(['--unknown']), error =>
        error instanceof CliInputError && error.code === 'UNKNOWN_ARGUMENT');

    const missingOut = captureStream();
    const missingErr = captureStream();
    let connectCalls = 0;
    const missingCode = await runCli({
        env: {},
        stdout: missingOut.stream,
        stderr: missingErr.stream,
        mongooseInstance: {
            async connect() { connectCalls++; },
            async disconnect() {}
        }
    });
    assert.equal(missingCode, EXIT.INPUT_ERROR);
    assert.equal(connectCalls, 0);
    assert.match(missingErr.value(), /MONGO_URI_REQUIRED/);

    const model = createModel([{
        _id: 'poi-1', location: { lng: 120, lat: 30 }
    }]);
    const settings = [];
    let connectOptions;
    let disconnectCalls = 0;
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({
        env: { MONGO_URI: 'mongodb://example.invalid/poi', SCENIC_ID: 'scenic-a' },
        stdout: stdout.stream,
        stderr: stderr.stream,
        mongooseInstance: {
            set: (key, value) => settings.push([key, value]),
            async connect(_uri, options) { connectOptions = options; },
            async disconnect() { disconnectCalls++; }
        },
        registerModelsFn: () => ({ ExternalPoi: model })
    });
    assert.equal(code, EXIT.OK);
    assert.deepEqual(settings, [['autoIndex', false], ['autoCreate', false]]);
    assert.equal(connectOptions.autoIndex, false);
    assert.equal(connectOptions.autoCreate, false);
    assert.equal(model.calls.updates.length, 0);
    assert.equal(disconnectCalls, 1);
    assert.equal(stderr.value(), '');
    const summary = JSON.parse(stdout.value());
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.success, 1);
    assert.equal(summary.gateNodeIdDeferred, 1);
    assert.equal(summary.superMapRefDeferred, 1);
});
