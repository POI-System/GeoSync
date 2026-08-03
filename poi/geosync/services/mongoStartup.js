'use strict';

const SAFE_ERROR_CODE = /^[A-Z0-9_:-]{1,64}$/;

function resolveMongoStartupPolicy({ nodeEnv, override } = {}) {
    const productionDefault = String(nodeEnv || '').trim().toLowerCase() === 'production';
    const value = override === undefined || override === null
        ? ''
        : String(override).trim().toLowerCase();

    if (!value) {
        return Object.freeze({
            failFast: productionDefault,
            source: 'environment-default',
            invalidOverride: false
        });
    }
    if (value === 'true' || value === 'false') {
        return Object.freeze({
            failFast: value === 'true',
            source: 'explicit-override',
            invalidOverride: false
        });
    }
    return Object.freeze({
        failFast: productionDefault,
        source: 'environment-default',
        invalidOverride: true
    });
}

function sanitizeMongoStartupFailure(error) {
    const rawCode = String(error?.code || '').trim().toUpperCase();
    return Object.freeze({
        code: 'MONGO_STARTUP_FAILED',
        ...(SAFE_ERROR_CODE.test(rawCode) ? { causeCode: rawCode } : {})
    });
}

function writeLog(logger, method, message, details) {
    const target = typeof logger?.[method] === 'function'
        ? logger[method]
        : typeof logger?.log === 'function'
            ? logger.log
            : null;
    if (!target) return;
    if (details === undefined) target.call(logger, message);
    else target.call(logger, message, details);
}

function defaultTerminate(exitCode) {
    process.exitCode = exitCode;
    setImmediate(() => process.exit(exitCode));
}

function monitorInitialMongoConnection(connectionPromise, {
    nodeEnv,
    failFastOverride,
    logger = console,
    terminate = defaultTerminate
} = {}) {
    if (!connectionPromise || typeof connectionPromise.then !== 'function') {
        throw new TypeError('monitorInitialMongoConnection requires a Promise-like connection');
    }
    if (typeof terminate !== 'function') {
        throw new TypeError('terminate must be a function');
    }

    const policy = resolveMongoStartupPolicy({
        nodeEnv,
        override: failFastOverride
    });
    if (policy.invalidOverride) {
        writeLog(
            logger,
            'warn',
            '[DB] MONGO_STARTUP_FAIL_FAST must be true or false; using the environment default'
        );
    }

    return Promise.resolve(connectionPromise).then(
        connection => {
            writeLog(logger, 'info', '[DB] MongoDB connected');
            return Object.freeze({
                connected: true,
                failFast: policy.failFast,
                policySource: policy.source,
                connection
            });
        },
        error => {
            const failure = sanitizeMongoStartupFailure(error);
            writeLog(logger, 'error', '[DB] MongoDB initial connection failed', {
                ...failure,
                failFast: policy.failFast
            });
            if (policy.failFast) terminate(1);
            return Object.freeze({
                connected: false,
                failFast: policy.failFast,
                policySource: policy.source,
                error: failure
            });
        }
    );
}

module.exports = {
    resolveMongoStartupPolicy,
    sanitizeMongoStartupFailure,
    monitorInitialMongoConnection,
    defaultTerminate
};
