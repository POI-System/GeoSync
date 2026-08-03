'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SuperMapGateway = require('../../integrations/supermap/gateway');
const MockHttpClient = require('../../integrations/supermap/mockHttpClient');
const { validateManifest, createPublicConfig } = require('../../integrations/supermap/manifest');

function rawManifest() {
    return {
        contractVersion: '1.0.0',
        dataVersion: 'test-data-v1',
        scenicId: 'test-scenic',
        crs: 'EPSG:4326',
        center: [120, 30],
        extent: [119.9, 29.9, 120.1, 30.1],
        services: {
            map: {
                enabled: true,
                path: '/map',
                operations: { status: { method: 'GET', path: '/status' } }
            },
            data: {
                enabled: true,
                path: '/data',
                operations: {
                    status: { method: 'GET', path: '/status' },
                    queryFeatures: { method: 'POST', path: '/query' }
                }
            },
            network: {
                enabled: true,
                path: '/network',
                operations: {
                    status: { method: 'GET', path: '/status' },
                    findPath: { method: 'POST', path: '/route' },
                    findPathWithBarriers: { method: 'POST', path: '/route/barriers' }
                }
            },
            terrain: { enabled: false, operations: {} },
            scene: { enabled: false, operations: {} }
        },
        datasets: {
            poi: {
                service: 'data',
                name: 'TestPoi@TestDatasource',
                fields: ['SmID', 'poi_id', 'name', 'status', 'capacity'],
                propertyMap: {
                    poi_id: 'poiId',
                    name: 'name',
                    status: 'status',
                    capacity: 'capacity'
                }
            }
        },
        limits: { maxFeatures: 50 },
        public: {
            features: { supermap: true, threeD: false },
            services: { map: '/public/map' }
        }
    };
}

function validManifestResult() {
    const manifest = validateManifest(rawManifest());
    return {
        ok: true,
        state: 'online',
        manifest,
        publicConfig: createPublicConfig(manifest),
        error: null
    };
}

function statusFixtures(overrides = {}) {
    return {
        'map.status': { status: 200, data: { state: 'online' } },
        'data.status': { status: 200, data: { state: 'online' } },
        'network.status': { status: 200, data: { state: 'online' } },
        ...overrides
    };
}

function gateway(options = {}) {
    let requestSequence = 0;
    return new SuperMapGateway({
        manifestPath: '/not-read-by-test.json',
        manifestLoader: () => validManifestResult(),
        httpClient: options.httpClient || new MockHttpClient({ fixtures: statusFixtures() }),
        clock: options.clock || (() => new Date('2026-08-02T12:00:00.000Z')),
        requestIdFactory: () => `gis-test-${++requestSequence}`,
        logger: { info() {}, warn() {}, error() {} },
        statusCacheMs: options.statusCacheMs === undefined ? 5000 : options.statusCacheMs,
        enabled: options.enabled
    });
}

test('missing manifest reports offline without making HTTP requests', async () => {
    const client = new MockHttpClient();
    const instance = new SuperMapGateway({
        manifestPath: '/missing.json',
        manifestLoader: () => ({
            ok: false,
            state: 'offline',
            manifest: null,
            publicConfig: null,
            error: { code: 'SUPERMAP_MANIFEST_NOT_FOUND', message: 'manifest unavailable' }
        }),
        httpClient: client,
        logger: { info() {}, warn() {}, error() {} }
    });

    const status = await instance.getStatus();

    assert.equal(status.state, 'offline');
    assert.equal(status.error.code, 'SUPERMAP_MANIFEST_NOT_FOUND');
    assert.equal(status.contractVersion, null);
    assert.equal(status.dataVersion, null);
    assert.deepEqual(status.services, {
        map: 'offline', data: 'offline', network: 'offline', terrain: 'disabled', scene: 'disabled'
    });
    assert.equal(client.history.length, 0);
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8201
            && error.category === 'configuration'
            && error.retryable === false
    );
});

test('failed manifest loads are retried automatically after the failure TTL', async () => {
    let nowMs = Date.parse('2026-08-03T00:00:00.000Z');
    let available = false;
    let loads = 0;
    const client = new MockHttpClient({ fixtures: statusFixtures() });
    const instance = new SuperMapGateway({
        manifestPath: '/eventually-available.json',
        manifestLoader: () => {
            loads++;
            return available ? validManifestResult() : {
                ok: false,
                state: 'offline',
                manifest: null,
                publicConfig: null,
                error: { code: 'SUPERMAP_MANIFEST_READ_ERROR', message: 'manifest temporarily unavailable' }
            };
        },
        httpClient: client,
        clock: () => new Date(nowMs),
        logger: { info() {}, warn() {}, error() {} },
        manifestFailureTtlMs: 30_000,
        statusCacheMs: 0
    });

    assert.equal((await instance.getStatus()).state, 'offline');
    assert.equal(loads, 1);

    available = true;
    nowMs += 29_999;
    assert.equal((await instance.getStatus()).state, 'offline');
    assert.equal(loads, 1);

    nowMs += 1;
    const recovered = await instance.getStatus();
    assert.equal(recovered.state, 'online');
    assert.equal(loads, 2);
    assert.equal(client.history.length, 3);
});

test('disabled gateways reject feature queries as non-retryable configuration failures', async () => {
    const instance = gateway({ enabled: false });

    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8201
            && error.category === 'configuration'
            && error.retryable === false
    );
});

test('public Gateway methods classify explicit null inputs as parameter errors', async () => {
    const instance = gateway();

    for (const operation of [
        () => instance.getStatus(null),
        () => instance.queryFeatures(null)
    ]) {
        await assert.rejects(
            operation(),
            error => error.code === 8205
                && error.httpStatus === 409
                && error.category === 'parameter'
        );
    }
});

test('aggregates required service health and reuses a cached result', async () => {
    const client = new MockHttpClient({ fixtures: statusFixtures() });
    const instance = gateway({ httpClient: client });

    const first = await instance.getStatus({ requestId: 'status-1' });
    const second = await instance.getStatus({ requestId: 'status-2' });

    assert.equal(first.state, 'online');
    assert.equal(first.contractVersion, '1.0.0');
    assert.equal(first.dataVersion, 'test-data-v1');
    assert.deepEqual(first.services, {
        map: 'online', data: 'online', network: 'online', terrain: 'disabled', scene: 'disabled'
    });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.requestId, 'status-2');
    assert.equal(client.history.length, 3);
});

test('force refresh clears a stale online status when the manifest becomes unavailable', async () => {
    let available = true;
    const client = new MockHttpClient({ fixtures: statusFixtures() });
    const instance = new SuperMapGateway({
        manifestPath: '/dynamic.json',
        manifestLoader: () => available ? validManifestResult() : {
            ok: false,
            state: 'offline',
            manifest: null,
            publicConfig: null,
            error: { code: 'SUPERMAP_MANIFEST_NOT_FOUND', message: 'manifest unavailable' }
        },
        httpClient: client,
        logger: { info() {}, warn() {}, error() {} },
        statusCacheMs: 60000
    });

    assert.equal((await instance.getStatus()).state, 'online');
    available = false;
    assert.equal((await instance.getStatus({ force: true })).state, 'offline');
    const afterForce = await instance.getStatus();
    assert.equal(afterForce.state, 'offline');
    assert.equal(afterForce.cached, false);
    assert.equal(client.history.length, 3);
});

test('query-side manifest refresh clears stale health and public configuration state', async () => {
    let available = true;
    const client = new MockHttpClient({ fixtures: statusFixtures() });
    const instance = new SuperMapGateway({
        manifestPath: '/dynamic-query.json',
        manifestLoader: () => available ? validManifestResult() : {
            ok: false,
            state: 'offline',
            manifest: null,
            publicConfig: null,
            error: { code: 'SUPERMAP_MANIFEST_NOT_FOUND', message: 'manifest unavailable' }
        },
        httpClient: client,
        logger: { info() {}, warn() {}, error() {} },
        statusCacheMs: 60000
    });

    assert.equal((await instance.getStatus()).state, 'online');
    available = false;
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi', refreshManifest: true }),
        error => error.code === 8201
    );
    assert.equal(instance.getPublicConfig().state, 'offline');
    const afterQuery = await instance.getStatus();
    assert.equal(afterQuery.state, 'offline');
    assert.equal(afterQuery.cached, false);
    assert.equal(client.history.length, 3);
});

test('reports degraded when only part of the required service set is available', async () => {
    const client = new MockHttpClient({
        fixtures: statusFixtures({ 'network.status': Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) })
    });
    const status = await gateway({ httpClient: client, statusCacheMs: 0 }).getStatus({ force: true });

    assert.equal(status.state, 'degraded');
    assert.equal(status.services.network, 'offline');
    assert.equal(status.services.map, 'online');
});

test('queryFeatures enforces allowlists and returns only normalized fields', async () => {
    let transportRequest;
    const client = new MockHttpClient({
        fixtures: {
            queryFeatures: request => {
                transportRequest = request;
                return {
                    status: 200,
                    data: {
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            id: 'poi-1',
                            geometry: { type: 'Point', coordinates: [120, 30] },
                            properties: {
                                SmID: 12,
                                poi_id: 'poi-1',
                                name: 'Test POI',
                                secretInternalField: 'must-not-leak'
                            }
                        }]
                    }
                };
            }
        }
    });
    const result = await gateway({ httpClient: client }).queryFeatures({
        datasetKey: 'poi',
        fields: ['poi_id', 'name'],
        filter: {
            and: [
                { field: 'status', operator: 'eq', value: "open'quoted" },
                { field: 'capacity', operator: 'gte', value: 2 }
            ]
        },
        bounds: [119.95, 29.95, 120.05, 30.05],
        limit: 10,
        offset: 5,
        requestId: 'query-1'
    });

    assert.equal(transportRequest.path, '/data/query');
    assert.equal(transportRequest.data.datasetName, 'TestPoi@TestDatasource');
    assert.deepEqual(transportRequest.data.fields, ['poi_id', 'name', 'SmID']);
    assert.equal(transportRequest.data.filter, "(status = 'open''quoted' AND capacity >= 2)");
    assert.equal(transportRequest.data.offset, 5);
    assert.equal(result.type, 'FeatureCollection');
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].properties.poiId, 'poi-1');
    assert.equal(result.features[0].properties.name, 'Test POI');
    assert.equal(result.features[0].properties.SmID, undefined);
    assert.equal(result.features[0].properties.poi_id, undefined);
    assert.equal(result.features[0].properties.secretInternalField, undefined);
    assert.deepEqual(result.features[0].properties.sourceRef, {
        datasetName: 'TestPoi@TestDatasource', smId: 12
    });
    assert.deepEqual(result.gis, {
        source: 'iserver',
        degraded: false,
        requestId: 'query-1',
        durationMs: 0,
        dataVersion: 'test-data-v1'
    });
});

test('queryFeatures rejects raw filters, unknown datasets, fields, and out-of-range bounds', async () => {
    const instance = gateway();
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi', filter: "status = 'open'" }),
        error => error.code === 8205 && error.category === 'parameter'
    );
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'privateDataset' }),
        error => error.code === 8205
    );
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi', fields: ['password'] }),
        error => error.code === 8205
    );
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi', bounds: [100, 20, 101, 21] }),
        error => error.code === 8205
    );

    const clauses = Array.from({ length: 3 }, (_, group) => ({
        and: Array.from({ length: 20 }, (_, index) => ({
            field: 'capacity', operator: 'gte', value: group * 20 + index
        }))
    }));
    await assert.rejects(
        instance.queryFeatures({ datasetKey: 'poi', filter: { or: clauses } }),
        error => error.code === 8205 && error.category === 'parameter'
    );
});

test('queryFeatures caps page size and rejects non-normalized transport responses', async () => {
    let request;
    const cappedClient = new MockHttpClient({
        fixtures: {
            queryFeatures: input => {
                request = input;
                return { status: 200, data: { type: 'FeatureCollection', features: [] } };
            }
        }
    });
    await gateway({ httpClient: cappedClient }).queryFeatures({ datasetKey: 'poi', limit: 500 });
    assert.equal(request.data.limit, 50);

    const invalidClient = new MockHttpClient({
        fixtures: { queryFeatures: { status: 200, data: { records: [] } } }
    });
    await assert.rejects(
        gateway({ httpClient: invalidClient }).queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8205 && error.category === 'contract'
    );

    const invalidGeometryClient = new MockHttpClient({
        fixtures: {
            queryFeatures: {
                status: 200,
                data: {
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: { type: 'PrivateGeometry', coordinates: [120, 30] },
                        properties: {}
                    }]
                }
            }
        }
    });
    await assert.rejects(
        gateway({ httpClient: invalidGeometryClient }).queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8206
    );

    const outOfRangeGeometryClient = new MockHttpClient({
        fixtures: {
            queryFeatures: {
                status: 200,
                data: {
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [999, 999] },
                        properties: {}
                    }]
                }
            }
        }
    });
    await assert.rejects(
        gateway({ httpClient: outOfRangeGeometryClient }).queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8206
    );

    const invalidIdClient = new MockHttpClient({
        fixtures: {
            queryFeatures: {
                status: 200,
                data: {
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        id: { private: true },
                        geometry: { type: 'Point', coordinates: [120, 30] },
                        properties: {}
                    }]
                }
            }
        }
    });
    await assert.rejects(
        gateway({ httpClient: invalidIdClient }).queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8205 && error.category === 'contract'
    );

    const nonSuccessClient = new MockHttpClient({
        fixtures: {
            queryFeatures: {
                status: 500,
                data: { type: 'FeatureCollection', features: [] }
            }
        }
    });
    await assert.rejects(
        gateway({ httpClient: nonSuccessClient }).queryFeatures({ datasetKey: 'poi' }),
        error => error.code === 8201 && error.category === 'upstream-5xx'
    );

    const overflowClient = new MockHttpClient({
        fixtures: {
            queryFeatures: {
                status: 200,
                data: {
                    type: 'FeatureCollection',
                    features: [0, 1].map(index => ({
                        type: 'Feature',
                        id: `poi-${index}`,
                        geometry: { type: 'Point', coordinates: [120, 30] },
                        properties: {}
                    }))
                }
            }
        }
    });
    await assert.rejects(
        gateway({ httpClient: overflowClient }).queryFeatures({ datasetKey: 'poi', limit: 1 }),
        error => error.code === 8205 && error.category === 'contract'
    );
});

test('request IDs are sanitized before transport headers and logs', async () => {
    let request;
    const client = new MockHttpClient({
        fixtures: {
            queryFeatures: input => {
                request = input;
                return { status: 200, data: { type: 'FeatureCollection', features: [] } };
            }
        }
    });

    const result = await gateway({ httpClient: client }).queryFeatures({
        datasetKey: 'poi',
        requestId: 'unsafe\r\nrequest'
    });

    assert.equal(request.requestId, 'unsafe__request');
    assert.equal(result.gis.requestId, 'unsafe__request');
});

test('public configuration excludes internal operations and dataset names', () => {
    const publicConfig = gateway().getPublicConfig();
    const serialized = JSON.stringify(publicConfig);

    assert.equal(publicConfig.scenicId, 'test-scenic');
    assert.deepEqual(publicConfig.publicServices, { map: '/public/map' });
    for (const forbidden of ['TestPoi@TestDatasource', '/data/query', 'datasets', 'operations']) {
        assert.equal(serialized.includes(forbidden), false);
    }
});
