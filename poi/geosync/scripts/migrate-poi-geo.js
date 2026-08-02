'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const { registerModels } = require('../models');
const { runPoiGeoMigration } = require('../services/poiGeoMigration');

const EXIT = {
    OK: 0,
    RUNTIME_ERROR: 1,
    INPUT_ERROR: 2,
    PARTIAL_FAILURE: 3
};

class CliInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CliInputError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const result = { apply: false, help: false };
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            result.help = true;
        } else if (arg === '--apply') {
            if (result.apply) throw new CliInputError('DUPLICATE_APPLY', '--apply may be specified once');
            result.apply = true;
        } else {
            throw new CliInputError('UNKNOWN_ARGUMENT', 'unsupported command-line argument');
        }
    }
    return result;
}

function usage() {
    return [
        'Usage:',
        '  node geosync/scripts/migrate-poi-geo.js',
        '  node geosync/scripts/migrate-poi-geo.js --apply',
        '',
        'Dry-run is the default. Both modes require an explicitly configured MONGO_URI.',
        'Apply mode conditionally backfills POI geo and visitMeta fields only.'
    ].join('\n');
}

function safeErrors(errors) {
    return (errors || []).map(error => ({
        ...(Number.isInteger(error.index) ? { index: error.index } : {}),
        ...(error.poiId ? { poiId: String(error.poiId).slice(0, 128) } : {}),
        code: error.code || 'MIGRATION_ERROR',
        message: error.message || 'Migration item failed'
    }));
}

function writeJson(stream, value) {
    stream.write(`${JSON.stringify(value)}\n`);
}

async function runCli({
    argv = process.argv.slice(2),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    mongooseInstance = mongoose,
    registerModelsFn = registerModels
} = {}) {
    let connected = false;
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${usage()}\n`);
            return EXIT.OK;
        }

        const uri = String(env.MONGO_URI || '').trim();
        if (!uri) {
            throw new CliInputError(
                'MONGO_URI_REQUIRED',
                'migration requires an explicitly configured MONGO_URI'
            );
        }
        const scenicId = String(env.SCENIC_ID || 'default').trim() || 'default';

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
        const { ExternalPoi } = registerModelsFn(mongooseInstance);
        const result = await runPoiGeoMigration({
            POI: ExternalPoi,
            apply: args.apply,
            scenicId
        });
        writeJson(stdout, {
            operation: 'migrate-poi-geo',
            mode: result.mode,
            ...result.summary,
            errors: safeErrors(result.errors)
        });
        return result.summary.failed > 0 ? EXIT.PARTIAL_FAILURE : EXIT.OK;
    } catch (error) {
        if (error instanceof CliInputError) {
            writeJson(stderr, {
                operation: 'migrate-poi-geo',
                code: error.code,
                message: error.message
            });
            return EXIT.INPUT_ERROR;
        }
        writeJson(stderr, {
            operation: 'migrate-poi-geo',
            code: 'MIGRATION_RUNTIME_ERROR',
            message: 'Migration could not be completed'
        });
        return EXIT.RUNTIME_ERROR;
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
    EXIT,
    CliInputError,
    parseArgs,
    runCli
};
