'use strict';

require('dotenv').config();

const mongoose = require('mongoose');

const COLLECTION_NAME = 'adminusers';
const APPLY_CONFIRMATION = 'drop-adminusers';
const EXIT = Object.freeze({
    OK: 0,
    FAILURE: 1,
    INPUT_ERROR: 2
});

class CliInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CliInputError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const result = { apply: false, backupConfirmed: false, confirmation: '', help: false };
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') result.help = true;
        else if (arg === '--apply') result.apply = true;
        else if (arg === '--backup-confirmed') result.backupConfirmed = true;
        else if (arg.startsWith('--confirm=')) result.confirmation = arg.slice('--confirm='.length);
        else throw new CliInputError('UNKNOWN_ARGUMENT', 'Unsupported command-line argument.');
    }
    if (result.apply && (!result.backupConfirmed || result.confirmation !== APPLY_CONFIRMATION)) {
        throw new CliInputError(
            'APPLY_CONFIRMATION_REQUIRED',
            'Apply requires --backup-confirmed and --confirm=drop-adminusers.'
        );
    }
    return result;
}

function usage() {
    return [
        'Usage:',
        '  node geosync/scripts/cleanup-legacy-adminusers.js',
        '  node geosync/scripts/cleanup-legacy-adminusers.js --apply --backup-confirmed --confirm=drop-adminusers',
        '',
        'Dry-run is the default and reports only collection existence and document count.',
        'Apply drops only the historical adminusers collection and never reads or prints its documents.'
    ].join('\n');
}

async function cleanupLegacyAdminUsers(db, options = {}) {
    if (!db || typeof db.listCollections !== 'function' || typeof db.collection !== 'function') {
        throw new TypeError('MongoDB database handle is required');
    }
    const existing = await db.listCollections(
        { name: COLLECTION_NAME },
        { nameOnly: true }
    ).toArray();
    if (!existing.length) {
        return Object.freeze({
            mode: options.apply === true ? 'apply' : 'dry-run',
            collection: COLLECTION_NAME,
            exists: false,
            documentCount: 0,
            dropped: false
        });
    }

    const collection = db.collection(COLLECTION_NAME);
    const documentCount = await collection.estimatedDocumentCount({ maxTimeMS: 5000 });
    let dropped = false;
    if (options.apply === true) {
        await collection.drop();
        dropped = true;
    }
    return Object.freeze({
        mode: options.apply === true ? 'apply' : 'dry-run',
        collection: COLLECTION_NAME,
        exists: true,
        documentCount: Number(documentCount) || 0,
        dropped
    });
}

async function runCli({
    argv = process.argv.slice(2),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    mongooseInstance = mongoose
} = {}) {
    let connected = false;
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${usage()}\n`);
            return EXIT.OK;
        }
        const uri = String(env.MONGO_URI || '').trim();
        if (!uri) throw new CliInputError('MONGO_URI_REQUIRED', 'MONGO_URI must be configured explicitly.');

        if (typeof mongooseInstance.set === 'function') {
            mongooseInstance.set('autoIndex', false);
            mongooseInstance.set('autoCreate', false);
        }
        await mongooseInstance.connect(uri, {
            serverSelectionTimeoutMS: 5000,
            autoIndex: false,
            autoCreate: false
        });
        connected = true;
        const result = await cleanupLegacyAdminUsers(mongooseInstance.connection.db, args);
        stdout.write(`${JSON.stringify({ operation: 'cleanup-legacy-adminusers', ...result })}\n`);
        return EXIT.OK;
    } catch (error) {
        const inputError = error instanceof CliInputError;
        stderr.write(`${JSON.stringify({
            operation: 'cleanup-legacy-adminusers',
            code: inputError ? error.code : 'LEGACY_ADMIN_CLEANUP_FAILED',
            message: inputError ? error.message : 'Legacy administrator cleanup could not be completed.'
        })}\n`);
        return inputError ? EXIT.INPUT_ERROR : EXIT.FAILURE;
    } finally {
        if (connected) await mongooseInstance.disconnect().catch(() => {});
    }
}

if (require.main === module) {
    runCli().then(code => {
        process.exitCode = code;
    });
}

module.exports = {
    COLLECTION_NAME,
    APPLY_CONFIRMATION,
    EXIT,
    CliInputError,
    parseArgs,
    cleanupLegacyAdminUsers,
    runCli
};
