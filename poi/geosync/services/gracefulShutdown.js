'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60000;
const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

function normalizeShutdownTimeoutMs(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_SHUTDOWN_TIMEOUT_MS
        ? parsed
        : DEFAULT_SHUTDOWN_TIMEOUT_MS;
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

function isAlreadyClosedError(error) {
    return error?.code === 'ERR_SERVER_NOT_RUNNING';
}

function closeWithCallback(target, methodName) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = error => {
            if (settled) return;
            settled = true;
            if (!error || isAlreadyClosedError(error)) resolve();
            else reject(error);
        };

        try {
            const returned = target[methodName](done);
            if (returned && typeof returned.then === 'function') {
                returned.then(() => done(), done);
            }
        } catch (error) {
            done(error);
        }
    });
}

function createGracefulShutdown({
    server,
    io,
    mongoose,
    timeoutMs,
    logger = console,
    processRef = process,
    terminate = defaultTerminate,
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    if (typeof server?.close !== 'function') {
        throw new TypeError('graceful shutdown requires server.close');
    }
    if (typeof io?.close !== 'function') {
        throw new TypeError('graceful shutdown requires io.close');
    }
    if (typeof mongoose?.disconnect !== 'function') {
        throw new TypeError('graceful shutdown requires mongoose.disconnect');
    }
    if (typeof processRef?.once !== 'function' || typeof processRef?.removeListener !== 'function') {
        throw new TypeError('graceful shutdown requires a process-like event target');
    }
    if (typeof terminate !== 'function') {
        throw new TypeError('graceful shutdown terminate must be a function');
    }
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
        throw new TypeError('graceful shutdown timer functions are required');
    }

    const effectiveTimeoutMs = normalizeShutdownTimeoutMs(timeoutMs);
    const handlers = new Map();
    let installed = false;
    let shutdownPromise = null;

    function removeSignalHandlers() {
        if (!installed) return false;
        for (const [signal, handler] of handlers) {
            processRef.removeListener(signal, handler);
        }
        installed = false;
        return true;
    }

    function shutdown(signal = 'manual') {
        if (shutdownPromise) return shutdownPromise;
        const safeSignal = SHUTDOWN_SIGNALS.includes(signal) ? signal : 'manual';

        shutdownPromise = new Promise(resolve => {
            let finished = false;
            let timer;

            const finish = ({ exitCode, forced, failures }) => {
                if (finished) return false;
                finished = true;
                if (timer !== undefined) clearTimer(timer);
                removeSignalHandlers();

                const result = Object.freeze({
                    signal: safeSignal,
                    exitCode,
                    forced,
                    failures: Object.freeze([...failures])
                });
                writeLog(
                    logger,
                    exitCode === 0 ? 'info' : 'error',
                    '[Shutdown] lifecycle complete',
                    {
                        signal: safeSignal,
                        exitCode,
                        forced,
                        failures: result.failures
                    }
                );
                resolve(result);
                terminate(exitCode);
                return true;
            };

            timer = setTimer(() => {
                writeLog(logger, 'error', '[Shutdown] total timeout exceeded', {
                    code: 'SHUTDOWN_TIMEOUT',
                    signal: safeSignal,
                    timeoutMs: effectiveTimeoutMs
                });
                finish({ exitCode: 1, forced: true, failures: ['timeout'] });
            }, effectiveTimeoutMs);
            if (typeof timer?.unref === 'function') timer.unref();

            writeLog(logger, 'info', '[Shutdown] draining connections', {
                signal: safeSignal,
                timeoutMs: effectiveTimeoutMs
            });

            void (async () => {
                const failures = [];
                const closeResults = await Promise.allSettled([
                    closeWithCallback(server, 'close'),
                    closeWithCallback(io, 'close')
                ]);
                if (finished) return;
                if (closeResults[0].status === 'rejected') failures.push('http');
                if (closeResults[1].status === 'rejected') failures.push('socket');
                if (failures.length) {
                    writeLog(logger, 'warn', '[Shutdown] connection drain failed', {
                        signal: safeSignal,
                        phases: [...failures]
                    });
                }

                try {
                    await mongoose.disconnect();
                } catch (_error) {
                    failures.push('mongo');
                    writeLog(logger, 'warn', '[Shutdown] database disconnect failed', {
                        signal: safeSignal,
                        phase: 'mongo'
                    });
                }
                if (finished) return;

                finish({
                    exitCode: failures.length ? 1 : 0,
                    forced: false,
                    failures
                });
            })();
        });

        return shutdownPromise;
    }

    function install() {
        if (installed || shutdownPromise) return false;
        for (const signal of SHUTDOWN_SIGNALS) {
            const handler = () => {
                void shutdown(signal);
            };
            handlers.set(signal, handler);
            processRef.once(signal, handler);
        }
        installed = true;
        return true;
    }

    return Object.freeze({
        install,
        dispose: removeSignalHandlers,
        shutdown,
        get installed() {
            return installed;
        }
    });
}

function installGracefulShutdown(options) {
    const lifecycle = createGracefulShutdown(options);
    lifecycle.install();
    return lifecycle;
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    MAX_SHUTDOWN_TIMEOUT_MS,
    SHUTDOWN_SIGNALS,
    normalizeShutdownTimeoutMs,
    createGracefulShutdown,
    installGracefulShutdown,
    defaultTerminate
};
