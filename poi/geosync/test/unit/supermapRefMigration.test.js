'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    MAX_MAPPING_ENTRIES,
    SuperMapRefMappingError,
    normalizeMappingArray,
    planSuperMapRefMigration,
    runSuperMapRefMigration
} = require('../../services/supermapRefMigration');
const {
    EXIT,
    parseArgs,
    runCli
} = require('../../scripts/migrate-supermap-refs');

function mapping(edgeId, smId, overrides = {}) {
    return {
        edgeId,
        datasetName: 'WalkEdge@Test',
        smId,
        sourceId: `source-${smId}`,
        dataVersion: 'graph-v1',
        ...overrides
    };
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

class FakeWalkEdgeModel {
    constructor(edges = [], failEdgeIds = []) {
        this.edges = new Map(edges.map(edge => [edge.edgeId, clone(edge)]));
        this.failEdgeIds = new Set(failEdgeIds);
        this.updateCalls = [];
        this.findCalls = [];
    }

    find(filter) {
        this.findCalls.push(clone(filter));
        const edgeIds = filter?.edgeId?.$in || [];
        return {
            lean: async () => edgeIds
                .map(edgeId => this.edges.get(edgeId))
                .filter(Boolean)
                .map(clone)
        };
    }

    findOne(filter) {
        return {
            lean: async () => clone(this.edges.get(filter.edgeId) || null)
        };
    }

    async updateOne(filter, update) {
        this.updateCalls.push({ filter: clone(filter), update: clone(update) });
        if (this.failEdgeIds.has(filter.edgeId)) {
            throw new Error('private database details must not escape');
        }
        const edge = this.edges.get(filter.edgeId);
        if (!edge || (filter._id != null && String(edge._id) !== String(filter._id))) {
            return { matchedCount: 0, modifiedCount: 0 };
        }
        if (!sourceRefFilterMatches(edge.sourceRef, filter.sourceRef)) {
            return { matchedCount: 0, modifiedCount: 0 };
        }
        edge.sourceRef = clone(update.$set.sourceRef);
        return { matchedCount: 1, modifiedCount: 1 };
    }
}

function sourceRefFilterMatches(actual, expected) {
    return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

function captureStream() {
    let value = '';
    return {
        stream: { write: chunk => { value += String(chunk); } },
        value: () => value
    };
}

test('mapping validation preserves only explicit authoritative sourceRef values', () => {
    const normalized = normalizeMappingArray([{
        edgeId: ' edge-1 ',
        datasetName: ' WalkEdge@Test ',
        smId: 0,
        sourceId: ' source-1 ',
        dataVersion: ' graph-v1 '
    }]);

    assert.deepStrictEqual(normalized, [{
        index: 0,
        edgeId: 'edge-1',
        datasetName: 'WalkEdge@Test',
        smId: 0,
        sourceId: 'source-1',
        dataVersion: 'graph-v1'
    }]);

    for (const invalid of [
        [{ edgeId: '', datasetName: 'WalkEdge@Test', smId: 1, dataVersion: 'v1' }],
        [{ edgeId: 'edge-1', datasetName: '', smId: 1, dataVersion: 'v1' }],
        [{ edgeId: 'edge-1', datasetName: 'WalkEdge@Test', smId: -1, dataVersion: 'v1' }],
        [{ edgeId: 'edge-1', datasetName: 'WalkEdge@Test', smId: 1.5, dataVersion: 'v1' }],
        [{ edgeId: 'edge-1', datasetName: 'WalkEdge@Test', smId: 1, dataVersion: '' }],
        [{ edgeId: 'edge-1', datasetName: 'WalkEdge@Test', smId: 1, sourceId: '', dataVersion: 'v1' }]
    ]) {
        assert.throws(
            () => normalizeMappingArray(invalid),
            error => error instanceof SuperMapRefMappingError
                && error.code === 'INVALID_SUPERMAP_REF_MAPPING'
                && error.errors.length === 1
        );
    }
});

test('duplicate and conflicting edge mappings are both rejected before planning', () => {
    assert.throws(
        () => normalizeMappingArray([mapping('edge-1', 1), mapping('edge-1', 1)]),
        error => error instanceof SuperMapRefMappingError
            && error.errors[0].code === 'DUPLICATE_EDGE_ID'
    );
    assert.throws(
        () => normalizeMappingArray([mapping('edge-1', 1), mapping('edge-1', 2)]),
        error => error instanceof SuperMapRefMappingError
            && error.errors[0].code === 'CONFLICTING_EDGE_ID'
    );
});

test('mapping normalization rejects input above the hard entry limit', () => {
    assert.throws(
        () => normalizeMappingArray(new Array(MAX_MAPPING_ENTRIES + 1).fill(null)),
        error => error instanceof SuperMapRefMappingError
            && error.summary.total === MAX_MAPPING_ENTRIES + 1
            && error.summary.failed === MAX_MAPPING_ENTRIES + 1
            && error.summary.total === error.summary.success
                + error.summary.skipped + error.summary.failed
            && error.errors[0].code === 'MAPPING_LIMIT_EXCEEDED'
    );
});

test('batch validation failure accounts for every rejected mapping entry', () => {
    assert.throws(
        () => normalizeMappingArray([
            mapping('edge-valid', 1),
            { edgeId: '', datasetName: 'WalkEdge@Test', smId: 2, dataVersion: 'graph-v1' }
        ]),
        error => error instanceof SuperMapRefMappingError
            && error.summary.total === 2
            && error.summary.success === 0
            && error.summary.skipped === 0
            && error.summary.failed === 2
            && error.errors.length === 1
    );
});

test('pure planner reports updates, idempotent skips, and missing edges', () => {
    const matching = mapping('edge-match', 2);
    const plan = planSuperMapRefMigration({
        mappings: [mapping('edge-update', 1), matching, mapping('edge-missing', 3)],
        existingEdges: [
            { _id: 'db-1', edgeId: 'edge-update', sourceRef: null },
            {
                _id: 'db-2', edgeId: 'edge-match',
                sourceRef: {
                    datasetName: matching.datasetName,
                    smId: matching.smId,
                    sourceId: matching.sourceId,
                    dataVersion: matching.dataVersion
                }
            }
        ]
    });

    assert.deepStrictEqual(plan.summary, { total: 3, success: 1, skipped: 1, failed: 1 });
    assert.equal(plan.operations[0].edgeId, 'edge-update');
    assert.deepStrictEqual(plan.operations[0].targetSourceRef, {
        datasetName: 'WalkEdge@Test',
        smId: 1,
        sourceId: 'source-1',
        dataVersion: 'graph-v1'
    });
    assert.deepStrictEqual(plan.errors, [{
        index: 2,
        edgeId: 'edge-missing',
        code: 'EDGE_NOT_FOUND',
        message: 'WalkEdge was not found'
    }]);
});

test('dry-run reports planned changes without writing', async () => {
    const WalkEdge = new FakeWalkEdgeModel([
        { _id: 'db-1', edgeId: 'edge-1', sourceRef: null }
    ]);

    const result = await runSuperMapRefMigration({
        WalkEdge,
        mappings: [mapping('edge-1', 1)]
    });

    assert.equal(result.mode, 'dry-run');
    assert.deepStrictEqual(result.summary, { total: 1, success: 1, skipped: 0, failed: 0 });
    assert.equal(WalkEdge.updateCalls.length, 0);
});

test('apply uses conditional updates and becomes an idempotent skip on rerun', async () => {
    const WalkEdge = new FakeWalkEdgeModel([
        { _id: 'db-1', edgeId: 'edge-1', sourceRef: null }
    ]);
    const mappings = [mapping('edge-1', 1)];

    const first = await runSuperMapRefMigration({ WalkEdge, mappings, apply: true });
    const second = await runSuperMapRefMigration({ WalkEdge, mappings, apply: true });

    assert.deepStrictEqual(first.summary, { total: 1, success: 1, skipped: 0, failed: 0 });
    assert.deepStrictEqual(second.summary, { total: 1, success: 0, skipped: 1, failed: 0 });
    assert.equal(WalkEdge.updateCalls.length, 1);
    assert.deepStrictEqual(WalkEdge.updateCalls[0], {
        filter: { _id: 'db-1', edgeId: 'edge-1', sourceRef: null },
        update: {
            $set: {
                sourceRef: {
                    datasetName: 'WalkEdge@Test',
                    smId: 1,
                    sourceId: 'source-1',
                    dataVersion: 'graph-v1'
                }
            }
        }
    });
});

test('apply continues after per-edge failures and sanitizes write errors', async () => {
    const WalkEdge = new FakeWalkEdgeModel([
        { _id: 'db-1', edgeId: 'edge-1', sourceRef: null },
        { _id: 'db-2', edgeId: 'edge-2', sourceRef: null }
    ], ['edge-2']);

    const result = await runSuperMapRefMigration({
        WalkEdge,
        mappings: [
            mapping('edge-1', 1),
            mapping('edge-2', 2),
            mapping('edge-missing', 3)
        ],
        apply: true
    });

    assert.deepStrictEqual(result.summary, { total: 3, success: 1, skipped: 0, failed: 2 });
    assert.deepStrictEqual(result.errors.map(error => error.code).sort(), [
        'EDGE_NOT_FOUND', 'WRITE_FAILED'
    ]);
    assert.equal(JSON.stringify(result.errors).includes('private database details'), false);
    assert.deepStrictEqual(WalkEdge.edges.get('edge-1').sourceRef, {
        datasetName: 'WalkEdge@Test',
        smId: 1,
        sourceId: 'source-1',
        dataVersion: 'graph-v1'
    });
});

test('CLI requires an explicit mapping path and MONGO_URI before either mode connects', async () => {
    assert.throws(
        () => parseArgs([]),
        error => error.code === 'MAPPING_PATH_REQUIRED'
    );
    assert.deepStrictEqual(parseArgs(['--mapping', 'mapping.json']), {
        apply: false,
        help: false,
        mappingPath: 'mapping.json'
    });

    for (const argv of [
        ['--mapping', 'mapping.json'],
        ['--mapping', 'mapping.json', '--apply']
    ]) {
        const stderr = captureStream();
        let connectCalls = 0;
        const code = await runCli({
            argv,
            env: {},
            stderr: stderr.stream,
            stdout: captureStream().stream,
            mongooseInstance: {
                connect: async () => { connectCalls++; },
                disconnect: async () => {}
            }
        });

        assert.equal(code, EXIT.INPUT_ERROR);
        assert.equal(connectCalls, 0);
        assert.equal(JSON.parse(stderr.value()).code, 'MONGO_URI_REQUIRED');
    }

    const oversizedMappings = JSON.stringify(new Array(MAX_MAPPING_ENTRIES + 1).fill(null));
    const invalidErr = captureStream();
    let invalidConnectCalls = 0;
    const invalidCode = await runCli({
        argv: ['--mapping', 'mapping.json'],
        env: { MONGO_URI: 'mongodb://db.internal/poi-test' },
        stderr: invalidErr.stream,
        stdout: captureStream().stream,
        fileSystem: {
            statSync: () => ({ isFile: () => true, size: Buffer.byteLength(oversizedMappings) }),
            readFileSync: () => oversizedMappings
        },
        mongooseInstance: {
            connect: async () => { invalidConnectCalls++; },
            disconnect: async () => {}
        }
    });
    assert.equal(invalidCode, EXIT.INPUT_ERROR);
    assert.equal(invalidConnectCalls, 0);
    const invalidBody = JSON.parse(invalidErr.value());
    assert.equal(invalidBody.code, 'INVALID_SUPERMAP_REF_MAPPING');
    assert.equal(invalidBody.total, MAX_MAPPING_ENTRIES + 1);
    assert.equal(invalidBody.failed, MAX_MAPPING_ENTRIES + 1);
});

test('SuperMap dry-run disables automatic collection and index creation', async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const settings = [];
    let connectUri;
    let connectOptions;
    let disconnectCalls = 0;
    let migrationInput;
    const code = await runCli({
        argv: ['--mapping', 'mapping.json'],
        env: { MONGO_URI: 'mongodb://db.internal/poi-test' },
        stdout: stdout.stream,
        stderr: stderr.stream,
        fileSystem: {
            statSync: () => ({ isFile: () => true, size: 64 }),
            readFileSync: () => JSON.stringify([mapping('edge-1', 1)])
        },
        mongooseInstance: {
            set: (key, value) => settings.push([key, value]),
            async connect(uri, options) {
                connectUri = uri;
                connectOptions = options;
            },
            async disconnect() { disconnectCalls++; }
        },
        registerModelsFn: () => ({ WalkEdge: { sentinel: true } }),
        runMigrationFn: async input => {
            migrationInput = input;
            return {
                mode: 'dry-run',
                summary: { total: 1, success: 1, skipped: 0, failed: 0 },
                errors: []
            };
        }
    });

    assert.equal(code, EXIT.OK);
    assert.equal(connectUri, 'mongodb://db.internal/poi-test');
    assert.deepEqual(settings, [['autoIndex', false], ['autoCreate', false]]);
    assert.equal(connectOptions.autoIndex, false);
    assert.equal(connectOptions.autoCreate, false);
    assert.equal(migrationInput.apply, false);
    assert.equal(migrationInput.WalkEdge.sentinel, true);
    assert.equal(disconnectCalls, 1);
    assert.equal(stderr.value(), '');
    assert.equal(JSON.parse(stdout.value()).mode, 'dry-run');
});
