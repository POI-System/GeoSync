'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createRuntimeReadiness,
    mongoStatusOf,
    waitForMongoReady
} = require('../../services/runtimeHealth');

test('runtime readiness stays pending until required startup components settle', async () => {
    const readiness = createRuntimeReadiness({ backgroundEnabled: true });
    assert.equal(readiness.snapshot().state, 'pending');
    assert.equal(readiness.snapshot().components.jobs.running, false);

    readiness.setJobs({
        enabled: true,
        running: true,
        scheduledJobs: ['ciAggregate', 'minuteSweep']
    });
    await readiness.track('graph', async () => true, {
        assertReady: value => value === true
    });
    await readiness.track('poiIndex', async () => 3, {
        details: count => ({ count })
    });

    const snapshot = readiness.snapshot({ graphReady: true, poiIndexCount: 3 });
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.components.jobs.running, true);
    assert.deepEqual(snapshot.components.jobs.scheduledJobs, ['ciAggregate', 'minuteSweep']);
    assert.equal(snapshot.components.poiIndex.count, 3);
});

test('intentional scheduler disablement is reported without failing core readiness', async () => {
    const readiness = createRuntimeReadiness({ backgroundEnabled: true });
    readiness.setJobs({
        enabled: false,
        running: false,
        reason: 'non-primary-instance',
        instance: '2',
        scheduledJobs: []
    });
    await readiness.track('graph', async () => true, {
        assertReady: value => value === true
    });
    await readiness.track('poiIndex', async () => 0, {
        details: count => ({ count })
    });

    const snapshot = readiness.snapshot({ graphReady: true, poiIndexCount: 0 });
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.components.jobs.state, 'disabled');
    assert.equal(snapshot.components.jobs.reason, 'non-primary-instance');
    assert.equal(snapshot.components.jobs.running, false);
});

test('failed or no-longer-ready core components make readiness fail with sanitized diagnostics', async () => {
    const readiness = createRuntimeReadiness({ backgroundEnabled: false });
    const failure = new Error('database password=secret\nconnection failed');
    failure.code = 'unsafe code';
    await assert.rejects(
        readiness.track('graph', async () => { throw failure; }),
        error => error === failure
    );
    await readiness.track('poiIndex', async () => 1, {
        details: count => ({ count })
    });

    const failed = readiness.snapshot({ graphReady: false, poiIndexCount: 1 });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.components.graph.error.code, 'GRAPH_STARTUP_FAILED');
    assert.doesNotMatch(failed.components.graph.error.message, /[\r\n]/);

    const ready = createRuntimeReadiness({ backgroundEnabled: false });
    await ready.track('graph', async () => true, { assertReady: Boolean });
    await ready.track('poiIndex', async () => 1, { details: count => ({ count }) });
    assert.equal(ready.snapshot({ graphReady: false }).state, 'failed');
});

test('mongo status maps Mongoose connection states without assuming connectivity', () => {
    assert.deepEqual(mongoStatusOf({ connection: { readyState: 1 } }), {
        state: 'online', readyState: 1
    });
    assert.deepEqual(mongoStatusOf({ connection: { readyState: 2 } }), {
        state: 'connecting', readyState: 2
    });
    assert.deepEqual(mongoStatusOf({ connection: { readyState: 99 } }), {
        state: 'offline', readyState: 99
    });
});

test('startup loaders wait for the in-flight Mongoose connection', async () => {
    let release;
    const connection = {
        readyState: 2,
        asPromise() {
            return new Promise(resolve => { release = resolve; });
        }
    };
    const waiting = waitForMongoReady({ connection });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    connection.readyState = 1;
    release(connection);
    assert.equal(await waiting, connection);

    await assert.rejects(
        waitForMongoReady({ connection: {
            readyState: 2,
            async asPromise() { throw new Error('private connection detail'); }
        } }),
        error => error.code === 'MONGO_STARTUP_FAILED'
            && !error.message.includes('private connection detail')
    );
});
