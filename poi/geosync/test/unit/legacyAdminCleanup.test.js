'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    COLLECTION_NAME,
    parseArgs,
    cleanupLegacyAdminUsers
} = require('../../scripts/cleanup-legacy-adminusers');

function fakeDb({ exists = true, documentCount = 2 } = {}) {
    const calls = [];
    return {
        calls,
        listCollections(filter, options) {
            calls.push({ operation: 'listCollections', filter, options });
            return { toArray: async () => exists ? [{ name: COLLECTION_NAME }] : [] };
        },
        collection(name) {
            calls.push({ operation: 'collection', name });
            return {
                async estimatedDocumentCount(options) {
                    calls.push({ operation: 'estimatedDocumentCount', options });
                    return documentCount;
                },
                async drop() {
                    calls.push({ operation: 'drop' });
                }
            };
        }
    };
}

test('legacy administrator cleanup is dry-run by default and never reads documents', async () => {
    const db = fakeDb({ documentCount: 7 });
    const result = await cleanupLegacyAdminUsers(db, parseArgs([]));
    assert.deepEqual(result, {
        mode: 'dry-run',
        collection: COLLECTION_NAME,
        exists: true,
        documentCount: 7,
        dropped: false
    });
    assert.equal(db.calls.some(call => call.operation === 'drop'), false);
    assert.equal(db.calls.some(call => /find/i.test(call.operation)), false);
    assert.deepEqual(db.calls[0], {
        operation: 'listCollections',
        filter: { name: COLLECTION_NAME },
        options: { nameOnly: true }
    });
});

test('legacy administrator cleanup requires backup and exact destructive confirmation', async () => {
    for (const argv of [
        ['--apply'],
        ['--apply', '--backup-confirmed'],
        ['--apply', '--confirm=drop-adminusers']
    ]) {
        assert.throws(
            () => parseArgs(argv),
            error => error.code === 'APPLY_CONFIRMATION_REQUIRED'
        );
    }

    const options = parseArgs([
        '--apply',
        '--backup-confirmed',
        '--confirm=drop-adminusers'
    ]);
    const db = fakeDb({ documentCount: 3 });
    const result = await cleanupLegacyAdminUsers(db, options);
    assert.equal(result.mode, 'apply');
    assert.equal(result.dropped, true);
    assert.equal(db.calls.filter(call => call.operation === 'drop').length, 1);
    assert.equal(db.calls.find(call => call.operation === 'collection').name, COLLECTION_NAME);
});

test('legacy cleanup is a no-op when adminusers is already absent', async () => {
    const db = fakeDb({ exists: false });
    const result = await cleanupLegacyAdminUsers(db, parseArgs([]));
    assert.deepEqual(result, {
        mode: 'dry-run',
        collection: COLLECTION_NAME,
        exists: false,
        documentCount: 0,
        dropped: false
    });
    assert.equal(db.calls.some(call => call.operation === 'collection'), false);
});
