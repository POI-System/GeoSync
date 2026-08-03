'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
    createRuntimeReadiness,
    createLivenessHandler,
    createReadinessHandler,
    createHealthHandler,
    createDetailedHealthHandler
} = require('../geosync/services/runtimeHealth');

async function readyRuntime() {
    const readiness = createRuntimeReadiness({ backgroundEnabled: false });
    await readiness.track('graph', async () => true, {
        assertReady: value => value === true
    });
    await readiness.track('poiIndex', async () => 2, {
        details: count => ({ count })
    });
    return readiness;
}

async function listen(app) {
    const server = await new Promise((resolve, reject) => {
        const value = app.listen(0, '127.0.0.1', () => resolve(value));
        value.once('error', reject);
    });
    return {
        server,
        base: `http://127.0.0.1:${server.address().port}`
    };
}

async function close(server) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('health endpoint distinguishes core readiness from GIS online, degraded, and offline states', async () => {
    const readiness = await readyRuntime();
    const mongoose = { connection: { readyState: 1 } };
    const gisState = { value: 'online', throws: false };
    const gateway = {
        async getStatus() {
            if (gisState.throws) throw new Error('private upstream detail');
            return {
                enabled: true,
                state: gisState.value,
                degraded: gisState.value !== 'online',
                manifest: { contractVersion: '1.0.0', dataVersion: 'fixture-v1' }
            };
        },
        getDiagnostics() {
            return {
                routeCacheSize: 2,
                lastInvalidationReason: 'fixture-refresh',
                lastSuccessAt: '2026-08-02T00:00:00.000Z'
            };
        }
    };
    const walkGraph = { isReady: () => true };
    const crowdService = {
        getPoiIndex: () => [{ _id: 'poi-1' }, { _id: 'poi-2' }],
        getHeatmapSnapshot: () => ({ slot: '2026-08-02T00:00' })
    };
    const app = express();
    app.get('/api/geosync/health/live', createLivenessHandler());
    app.get('/api/geosync/health/ready', createReadinessHandler({
        mongoose,
        readiness,
        walkGraph,
        crowdService
    }));
    const healthDependencies = {
        mongoose,
        superMapGateway: gateway,
        readiness,
        walkGraph,
        crowdService,
        config: {
            features: { rain: true, weather: false, guide: false },
            simMode: false
        }
    };
    app.get('/api/geosync/health', createHealthHandler(healthDependencies));
    app.get('/api/admin/geosync/health', createDetailedHealthHandler(healthDependencies));
    const { server, base } = await listen(app);

    try {
        let response = await fetch(`${base}/api/geosync/health/live`);
        let body = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(body, { state: 'live', live: true });

        response = await fetch(`${base}/api/geosync/health/ready`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'ready');
        assert.equal(body.ready, true);
        assert.equal(body.mongoReady, true);
        assert.equal(body.geosyncReady, true);

        response = await fetch(`${base}/api/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(body, { state: 'online' });
        assert.equal(JSON.stringify(body).includes('mongo'), false);
        assert.equal(JSON.stringify(body).includes('manifest'), false);

        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'online');
        assert.equal(body.core.ready, true);
        assert.equal(body.jobsRunning, false);
        assert.equal(body.jobs.reason, 'background-disabled');
        assert.equal(body.graphLoaded, true);
        assert.equal(body.poiIndexCount, 2);

        gisState.value = 'degraded';
        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'degraded');
        assert.equal(body.gis.state, 'degraded');

        gisState.value = 'offline';
        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'degraded');
        assert.equal(body.gis.state, 'offline');

        gisState.throws = true;
        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.gis.state, 'offline');
        assert.equal(body.gis.error.code, 'GIS_STATUS_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(body), /private upstream detail/);

        mongoose.connection.readyState = 0;
        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.state, 'offline');
        assert.equal(body.core.ready, false);

        response = await fetch(`${base}/api/geosync/health/ready`);
        body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.state, 'not-ready');
        assert.equal(body.ready, false);
        assert.equal(body.mongoReady, false);
        assert.equal(body.geosyncReady, false);

        response = await fetch(`${base}/api/geosync/health/live`);
        assert.equal(response.status, 200);
    } finally {
        await close(server);
    }
});

test('health endpoint returns 503 while a required startup component is pending or failed', async () => {
    const readiness = createRuntimeReadiness({ backgroundEnabled: false });
    const mongoose = { connection: { readyState: 1 } };
    const walkGraph = { isReady: () => false };
    const crowdService = {
        getPoiIndex: () => [],
        getHeatmapSnapshot: () => null
    };
    const app = express();
    app.get('/api/geosync/health/ready', createReadinessHandler({
        mongoose,
        readiness,
        walkGraph,
        crowdService
    }));
    const healthDependencies = {
        mongoose,
        superMapGateway: {
            async getStatus() { return { state: 'online', manifest: null }; },
            getDiagnostics() { return {}; }
        },
        readiness,
        walkGraph,
        crowdService,
        config: { features: {}, simMode: false }
    };
    app.get('/api/geosync/health', createHealthHandler(healthDependencies));
    app.get('/api/admin/geosync/health', createDetailedHealthHandler(healthDependencies));
    const { server, base } = await listen(app);

    try {
        let response = await fetch(`${base}/api/geosync/health/ready`);
        let body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'degraded');
        assert.equal(body.ready, true);
        assert.equal(body.mongoReady, true);
        assert.equal(body.geosyncReady, false);
        assert.equal(body.geosync.state, 'pending');

        response = await fetch(`${base}/api/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 503);
        assert.deepEqual(body, { state: 'offline' });

        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.startup.state, 'pending');

        await assert.rejects(readiness.track('graph', async () => {
            const error = new Error('graph load failed');
            error.code = 'GRAPH_LOAD_FAILED';
            throw error;
        }));
        await readiness.track('poiIndex', async () => 0, {
            details: count => ({ count })
        });
        response = await fetch(`${base}/api/admin/geosync/health`);
        body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.startup.state, 'failed');
        assert.equal(body.startup.components.graph.error.code, 'GRAPH_LOAD_FAILED');

        response = await fetch(`${base}/api/geosync/health/ready`);
        body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.state, 'degraded');
        assert.equal(body.ready, true);
        assert.equal(body.geosyncReady, false);
        assert.equal(body.geosync.state, 'failed');
    } finally {
        await close(server);
    }
});
