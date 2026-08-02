'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { registerModels } = require('../models');
const {
    SuperMapRefMappingError,
    runSuperMapRefMigration
} = require('../services/supermapRefMigration');

const DEFAULT_DRY_RUN_URI = 'mongodb://127.0.0.1:27017/poi_db';
const MAX_MAPPING_BYTES = 10 * 1024 * 1024;
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
    const result = { apply: false, help: false, mappingPath: '' };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            result.help = true;
            continue;
        }
        if (arg === '--apply') {
            if (result.apply) throw new CliInputError('DUPLICATE_APPLY', '--apply may be specified once');
            result.apply = true;
            continue;
        }
        if (arg === '--mapping') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) {
                throw new CliInputError('MAPPING_PATH_REQUIRED', '--mapping requires a JSON file path');
            }
            if (result.mappingPath) {
                throw new CliInputError('DUPLICATE_MAPPING', '--mapping may be specified once');
            }
            result.mappingPath = value;
            continue;
        }
        throw new CliInputError('UNKNOWN_ARGUMENT', 'unsupported command-line argument');
    }
    if (!result.help && !result.mappingPath) {
        throw new CliInputError('MAPPING_PATH_REQUIRED', '--mapping <json> is required');
    }
    return result;
}

function readMappings(mappingPath, fileSystem = fs) {
    const resolved = path.resolve(mappingPath);
    let stat;
    try {
        stat = fileSystem.statSync(resolved);
    } catch (_error) {
        throw new CliInputError('MAPPING_FILE_UNREADABLE', 'mapping file could not be read');
    }
    if (!stat.isFile() || stat.size > MAX_MAPPING_BYTES) {
        throw new CliInputError(
            'MAPPING_FILE_INVALID',
            `mapping file must be a JSON file no larger than ${MAX_MAPPING_BYTES} bytes`
        );
    }
    try {
        return JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
    } catch (_error) {
        throw new CliInputError('MAPPING_JSON_INVALID', 'mapping file must contain valid JSON');
    }
}

function usage() {
    return [
        'Usage:',
        '  node geosync/scripts/migrate-supermap-refs.js --mapping <json>',
        '  node geosync/scripts/migrate-supermap-refs.js --mapping <json> --apply',
        '',
        'Dry-run is the default. Apply mode also requires MONGO_URI to be explicitly configured.',
        'Mapping JSON must be an array of {edgeId,datasetName,smId,sourceId?,dataVersion}.'
    ].join('\n');
}

function safeErrors(errors) {
    return (errors || []).map(error => ({
        ...(Number.isInteger(error.index) ? { index: error.index } : {}),
        ...(error.edgeId ? { edgeId: String(error.edgeId).slice(0, 256) } : {}),
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
    fileSystem = fs,
    mongooseInstance = mongoose
} = {}) {
    let connected = false;
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${usage()}\n`);
            return EXIT.OK;
        }
        const explicitUri = String(env.MONGO_URI || '').trim();
        if (args.apply && !explicitUri) {
            throw new CliInputError(
                'MONGO_URI_REQUIRED',
                'apply mode requires an explicitly configured MONGO_URI'
            );
        }

        const mappings = readMappings(args.mappingPath, fileSystem);
        await mongooseInstance.connect(explicitUri || DEFAULT_DRY_RUN_URI, {
            serverSelectionTimeoutMS: 5000
        });
        connected = true;
        const { WalkEdge } = registerModels(mongooseInstance);
        const result = await runSuperMapRefMigration({
            WalkEdge,
            mappings,
            apply: args.apply
        });
        writeJson(stdout, {
            operation: 'migrate-supermap-refs',
            mode: result.mode,
            ...result.summary,
            errors: safeErrors(result.errors)
        });
        return result.summary.failed > 0 ? EXIT.PARTIAL_FAILURE : EXIT.OK;
    } catch (error) {
        if (error instanceof SuperMapRefMappingError) {
            writeJson(stderr, {
                operation: 'migrate-supermap-refs',
                code: error.code,
                ...error.summary,
                errors: safeErrors(error.errors)
            });
            return EXIT.INPUT_ERROR;
        }
        if (error instanceof CliInputError) {
            writeJson(stderr, {
                operation: 'migrate-supermap-refs',
                code: error.code,
                message: error.message
            });
            return EXIT.INPUT_ERROR;
        }
        writeJson(stderr, {
            operation: 'migrate-supermap-refs',
            code: 'MIGRATION_RUNTIME_ERROR',
            message: 'Migration could not be completed'
        });
        return EXIT.RUNTIME_ERROR;
    } finally {
        if (connected) {
            await mongooseInstance.disconnect().catch(() => {});
        }
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
    readMappings,
    runCli
};
