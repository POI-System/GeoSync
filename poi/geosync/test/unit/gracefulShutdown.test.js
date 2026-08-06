'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { Server } = require('socket.io');
const {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    normalizeShutdownTimeoutMs,
    createGracefulShutdown
} = require('../../services/gracefulShutdown');

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

function processDouble() {
    return new EventEmitter();
}

test('shutdown timeout accepts a bounded positive integer and otherwise uses the default', () => {
    assert.equal(normalizeShutdownTimeoutMs('2500'), 2500);
    assert.equal(normalizeShutdownTimeoutMs(60000), 60000);
    assert.equal(normalizeShutdownTimeoutMs(0), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(normalizeShutdownTimeoutMs(60001), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(normalizeShutdownTimeoutMs('secret-invalid-value'), DEFAULT_SHUTDOWN_TIMEOUT_MS);
});

test('SIGTERM and SIGINT share one idempotent drain before Mongo disconnect', async () => {
    const events = [];
    const exits = [];
    const processRef = processDouble();
    const lifecycle = createGracefulShutdown({
        server: {
            close(callback) {
                events.push('http-close-start');
                queueMicrotask(() => {
                    events.push('http-close-end');
                    callback();
                });
            }
        },
        io: {
            close(callback) {
                events.push('socket-close-start');
                queueMicrotask(() => {
                    events.push('socket-close-end');
                    callback();
                });
            }
        },
        mongoose: {
            async disconnect() {
                events.push('mongo-disconnect');
            }
        },
        processRef,
        terminate: code => exits.push(code),
        logger: {},
        timeoutMs: 1000
    });

    assert.equal(lifecycle.install(), true);
    assert.equal(lifecycle.install(), false);
    processRef.emit('SIGTERM');
    processRef.emit('SIGINT');
    const result = await lifecycle.shutdown('SIGINT');

    assert.deepEqual(result, {
        signal: 'SIGTERM',
        exitCode: 0,
        forced: false,
        failures: []
    });
    assert.deepEqual(exits, [0]);
    assert.equal(events.filter(event => event === 'http-close-start').length, 1);
    assert.equal(events.filter(event => event === 'socket-close-start').length, 1);
    assert.ok(events.indexOf('mongo-disconnect') > events.indexOf('http-close-end'));
    assert.ok(events.indexOf('mongo-disconnect') > events.indexOf('socket-close-end'));
    assert.equal(processRef.listenerCount('SIGTERM'), 0);
    assert.equal(processRef.listenerCount('SIGINT'), 0);
    assert.equal(lifecycle.installed, false);
});

test('real HTTP and Socket.IO servers close cleanly through the shared lifecycle', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const io = new Server(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const exits = [];
    const lifecycle = createGracefulShutdown({
        server,
        io,
        mongoose: { disconnect: async () => {} },
        terminate: code => exits.push(code),
        logger: {},
        timeoutMs: 1000
    });

    const result = await lifecycle.shutdown('manual');

    assert.equal(server.listening, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.forced, false);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(exits, [0]);
});

test('shutdown reports only failed phases and still disconnects Mongo', async () => {
    const secret = 'mongodb://private-user:private-password@db.internal/app';
    const exits = [];
    const { entries, logger } = captureLogger();
    const lifecycle = createGracefulShutdown({
        server: {
            close(callback) {
                callback(Object.assign(new Error(secret), { code: 'PRIVATE_FAILURE' }));
            }
        },
        io: {
            close(callback) {
                callback();
            }
        },
        mongoose: {
            async disconnect() {
                throw new Error(secret);
            }
        },
        processRef: processDouble(),
        terminate: code => exits.push(code),
        logger,
        timeoutMs: 1000
    });

    const first = lifecycle.shutdown('SIGTERM');
    const second = lifecycle.shutdown('SIGINT');
    assert.strictEqual(second, first);
    const result = await first;

    assert.equal(result.exitCode, 1);
    assert.equal(result.forced, false);
    assert.deepEqual(result.failures, ['http', 'mongo']);
    assert.deepEqual(exits, [1]);
    const serialized = JSON.stringify(entries);
    assert.match(serialized, /connection drain failed/);
    assert.match(serialized, /database disconnect failed/);
    assert.doesNotMatch(serialized, /private-user|private-password|db\.internal|PRIVATE_FAILURE/);
});

test('already-closed HTTP server is harmless and total timeout forces one termination', async t => {
    await t.test('already closed server remains a successful idempotent shutdown', async () => {
        const exits = [];
        const lifecycle = createGracefulShutdown({
            server: {
                close(callback) {
                    callback(Object.assign(new Error('not running'), {
                        code: 'ERR_SERVER_NOT_RUNNING'
                    }));
                }
            },
            io: { close: callback => callback() },
            mongoose: { disconnect: async () => {} },
            processRef: processDouble(),
            terminate: code => exits.push(code),
            logger: {},
            timeoutMs: 1000
        });

        const result = await lifecycle.shutdown('manual');
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.failures, []);
        assert.deepEqual(exits, [0]);
    });

    await t.test('hung connection drain is bounded by the total timeout', async () => {
        const exits = [];
        const { entries, logger } = captureLogger();
        let timerCallback;
        let timerDelay;
        let timerCleared = false;
        let timerUnrefed = false;
        let mongoDisconnects = 0;
        const timerHandle = {
            unref() {
                timerUnrefed = true;
            }
        };
        const lifecycle = createGracefulShutdown({
            server: { close() {} },
            io: { close() {} },
            mongoose: {
                async disconnect() {
                    mongoDisconnects++;
                }
            },
            processRef: processDouble(),
            terminate: code => exits.push(code),
            logger,
            timeoutMs: 2500,
            setTimer(callback, delay) {
                timerCallback = callback;
                timerDelay = delay;
                return timerHandle;
            },
            clearTimer(handle) {
                assert.strictEqual(handle, timerHandle);
                timerCleared = true;
            }
        });

        const pending = lifecycle.shutdown('SIGINT');
        assert.equal(timerDelay, 2500);
        assert.equal(timerUnrefed, true);
        timerCallback();
        const result = await pending;

        assert.deepEqual(result, {
            signal: 'SIGINT',
            exitCode: 1,
            forced: true,
            failures: ['timeout']
        });
        assert.equal(timerCleared, true);
        assert.equal(mongoDisconnects, 0);
        assert.deepEqual(exits, [1]);
        assert.match(JSON.stringify(entries), /SHUTDOWN_TIMEOUT/);
    });
});
