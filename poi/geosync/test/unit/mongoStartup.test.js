'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveMongoStartupPolicy,
    sanitizeMongoStartupFailure,
    monitorInitialMongoConnection
} = require('../../services/mongoStartup');

function captureLogger() {
    const entries = [];
    return {
        entries,
        logger: {
            info: (...args) => entries.push(['info', ...args]),
            warn: (...args) => entries.push(['warn', ...args]),
            error: (...args) => entries.push(['error', ...args])
        }
    };
}

test('Mongo startup fail-fast defaults to production and accepts only explicit booleans', () => {
    assert.equal(resolveMongoStartupPolicy({ nodeEnv: 'production' }).failFast, true);
    assert.equal(resolveMongoStartupPolicy({ nodeEnv: 'test' }).failFast, false);
    assert.equal(resolveMongoStartupPolicy({ nodeEnv: 'development' }).failFast, false);
    assert.deepEqual(
        resolveMongoStartupPolicy({ nodeEnv: 'production', override: ' false ' }),
        { failFast: false, source: 'explicit-override', invalidOverride: false }
    );
    assert.deepEqual(
        resolveMongoStartupPolicy({ nodeEnv: 'test', override: 'TRUE' }),
        { failFast: true, source: 'explicit-override', invalidOverride: false }
    );
    assert.deepEqual(
        resolveMongoStartupPolicy({ nodeEnv: 'production', override: 'not-a-boolean' }),
        { failFast: true, source: 'environment-default', invalidOverride: true }
    );
});

test('Mongo startup failure diagnostics never include messages or unsafe codes', () => {
    const error = new Error('mongodb://user:password@private.example/db');
    error.code = 'mongodb://user:password@private.example/db';
    assert.deepEqual(sanitizeMongoStartupFailure(error), {
        code: 'MONGO_STARTUP_FAILED'
    });

    const transportError = new Error('private host detail');
    transportError.code = 'ECONNREFUSED';
    assert.deepEqual(sanitizeMongoStartupFailure(transportError), {
        code: 'MONGO_STARTUP_FAILED',
        causeCode: 'ECONNREFUSED'
    });
});

test('production Mongo startup failure logs sanitized context and terminates', async () => {
    const { entries, logger } = captureLogger();
    const exits = [];
    const error = new Error('mongodb://private-user:private-password@db.internal/app');
    error.code = 'ECONNREFUSED';

    const result = await monitorInitialMongoConnection(Promise.reject(error), {
        nodeEnv: 'production',
        logger,
        terminate: code => exits.push(code)
    });

    assert.equal(result.connected, false);
    assert.equal(result.failFast, true);
    assert.deepEqual(exits, [1]);
    const serialized = JSON.stringify(entries);
    assert.match(serialized, /MONGO_STARTUP_FAILED/);
    assert.match(serialized, /ECONNREFUSED/);
    assert.doesNotMatch(serialized, /private-user|private-password|db\.internal/);
});

test('non-production Mongo startup failure remains observable without terminating', async () => {
    const { entries, logger } = captureLogger();
    const exits = [];
    const result = await monitorInitialMongoConnection(
        Promise.reject(Object.assign(new Error('test database unavailable'), { code: 'ECONNREFUSED' })),
        {
            nodeEnv: 'test',
            logger,
            terminate: code => exits.push(code)
        }
    );

    assert.equal(result.connected, false);
    assert.equal(result.failFast, false);
    assert.deepEqual(exits, []);
    assert.match(JSON.stringify(entries), /MONGO_STARTUP_FAILED/);
});

test('explicit override controls termination and invalid values are not logged', async () => {
    const disabled = captureLogger();
    const disabledExits = [];
    const disabledResult = await monitorInitialMongoConnection(Promise.reject(new Error('down')), {
        nodeEnv: 'production',
        failFastOverride: 'false',
        logger: disabled.logger,
        terminate: code => disabledExits.push(code)
    });
    assert.equal(disabledResult.failFast, false);
    assert.deepEqual(disabledExits, []);

    const invalid = captureLogger();
    const invalidExits = [];
    const invalidValue = 'secret-invalid-value';
    await monitorInitialMongoConnection(Promise.reject(new Error('down')), {
        nodeEnv: 'production',
        failFastOverride: invalidValue,
        logger: invalid.logger,
        terminate: code => invalidExits.push(code)
    });
    assert.deepEqual(invalidExits, [1]);
    assert.match(JSON.stringify(invalid.entries), /must be true or false/);
    assert.doesNotMatch(JSON.stringify(invalid.entries), new RegExp(invalidValue));
});
