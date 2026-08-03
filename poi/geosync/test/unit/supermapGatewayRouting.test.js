'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SuperMapGateway = require('../../integrations/supermap/gateway');
const MockHttpClient = require('../../integrations/supermap/mockHttpClient');
const RouteCache = require('../../integrations/supermap/routeCache');
const { validateManifest, createPublicConfig } = require('../../integrations/supermap/manifest');

const START = [120, 30];
const END = [120.01, 30.01];
const WALK_EDGE_DATASET = 'TestWalkEdge@TestDatasource';

function rawManifest(dataVersion = 'test-data-v1') {
    return {
        contractVersion: '1.0.0',
        dataVersion,
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
                fields: ['SmID', 'poi_id', 'name'],
                propertyMap: { poi_id: 'poiId', name: 'name' }
            },
            walkEdge: {
                service: 'data',
                name: WALK_EDGE_DATASET,
                fields: ['SmID', 'edge_id'],
                propertyMap: { edge_id: 'edgeId' }
            }
        },
        limits: { maxFeatures: 50 },
        public: {
            features: { supermap: true, threeD: false },
            services: { map: '/public/map' }
        }
    };
}

function manifestResult(dataVersion = 'test-data-v1') {
    const manifest = validateManifest(rawManifest(dataVersion));
    return {
        ok: true,
        state: 'online',
        manifest,
        publicConfig: createPublicConfig(manifest),
        error: null
    };
}

function routeResponse(overrides = {}) {
    const base = {
        dataVersion: 'test-data-v1',
        routeFound: true,
        distanceM: 842,
        durationSec: 662,
        geometry: {
            type: 'LineString',
            coordinates: [START, [120.005, 30.005], END]
        },
        segments: [{
            edgeId: 'EDGE_1',
            distanceM: 842,
            durationSec: 662,
            sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 1 }
        }],
        snap: {
            startDistanceM: 3,
            endDistanceM: 4,
            startNodeId: 'NODE_START',
            endNodeId: 'NODE_END'
        },
        verifiedAccessible: true
    };
    return {
        status: 200,
        data: {
            ...base,
            ...overrides,
            geometry: overrides.geometry === undefined ? base.geometry : overrides.geometry,
            segments: overrides.segments === undefined ? base.segments : overrides.segments,
            snap: overrides.snap === undefined ? base.snap : { ...base.snap, ...overrides.snap }
        },
        headers: {}
    };
}

function statusFixtures() {
    return {
        'map.status': { status: 200, data: { state: 'online' } },
        'data.status': { status: 200, data: { state: 'online' } },
        'network.status': { status: 200, data: { state: 'online' } }
    };
}

function transportError(code, name = 'Error') {
    const error = new Error(code);
    error.name = name;
    error.code = code;
    error.request = { sent: true };
    return error;
}

function createHarness(options = {}) {
    let requestSequence = 0;
    const logs = { info: [], warn: [], error: [] };
    const client = options.httpClient || new MockHttpClient({ fixtures: options.fixtures || {} });
    const clock = options.clock || (() => new Date('2026-08-02T12:00:00.000Z'));
    const gateway = new SuperMapGateway({
        manifestPath: '/not-read-by-routing-tests.json',
        manifestLoader: options.manifestLoader || (() => manifestResult(options.dataVersion)),
        httpClient: client,
        clock,
        routeCacheClock: options.routeCacheClock || clock,
        routeCache: options.routeCache,
        requestIdFactory: () => `gis-route-${++requestSequence}`,
        logger: options.logger || {
            info(message, metadata) { logs.info.push({ message, metadata }); },
            warn(message, metadata) { logs.warn.push({ message, metadata }); },
            error(message, metadata) { logs.error.push({ message, metadata }); }
        },
        routeTimeoutMs: options.routeTimeoutMs || 4321,
        routeCacheTtlMs: options.routeCacheTtlMs || 60000,
        maxSnapDistanceM: options.maxSnapDistanceM || 50,
        fallbackEnabled: options.fallbackEnabled,
        localPathSource: options.localPathSource
    });
    return { gateway, client, logs };
}

function routeInput(overrides = {}) {
    return {
        start: START,
        end: END,
        mode: 'normal',
        scenicId: 'test-scenic',
        requestId: 'route-request',
        ...overrides
    };
}

test('findPath supports normal, accessible, and shade with the normalized Mock transport contract', async t => {
    for (const mode of ['normal', 'accessible', 'shade']) {
        await t.test(mode, async () => {
            let transportRequest;
            const { gateway } = createHarness({
                fixtures: {
                    findPath: request => {
                        transportRequest = request;
                        return routeResponse();
                    }
                }
            });

            const result = await gateway.findPath(routeInput({
                mode,
                requestId: `route-${mode}`
            }));

            assert.deepEqual(transportRequest, {
                operation: 'findPath',
                method: 'POST',
                path: '/network/route',
                requestId: `route-${mode}`,
                timeoutMs: 4321,
                data: {
                    start: START,
                    end: END,
                    mode,
                    scenicId: 'test-scenic',
                    barriers: [],
                    dataVersion: 'test-data-v1'
                }
            });
            assert.equal(result.gis.source, 'iserver');
            assert.equal(result.gis.mode, mode);
            assert.equal(result.gis.degraded, false);
            assert.equal(result.gis.requestId, `route-${mode}`);
            assert.equal(result.distanceM, 842);
            assert.equal(result.durationSec, 662);
            assert.deepEqual(result.geometry.coordinates, [START, [120.005, 30.005], END]);
            assert.deepEqual(result.snap, { startDistanceM: 3, endDistanceM: 4 });
            assert.deepEqual(result.coords, result.geometry.coordinates);
            assert.equal(result.walkSec, result.durationSec);
            assert.equal(typeof result.pathGeometry, 'string');
            assert.equal(result.fallback, false);
        });
    }
});

test('findPathWithBarriers requires barriers and sends sorted unique normalized barrier objects', async () => {
    let transportRequest;
    const { gateway, client } = createHarness({
        fixtures: {
            findPathWithBarriers: request => {
                transportRequest = request;
                return routeResponse({
                    segments: [{
                        edgeId: 'EDGE_3',
                        distanceM: 842,
                        durationSec: 662,
                        sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 3 }
                    }]
                });
            }
        }
    });

    await assert.rejects(
        gateway.findPathWithBarriers(routeInput({ barriers: [] })),
        error => error.code === 8205 && error.category === 'parameter'
    );
    assert.equal(client.history.length, 0);

    for (const smId of [null, '', ' ', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
            gateway.findPathWithBarriers(routeInput({
                barriers: [{
                    edgeId: 'EDGE_INVALID',
                    sourceRef: { datasetName: WALK_EDGE_DATASET, smId }
                }]
            })),
            error => error.code === 8205 && error.category === 'parameter'
        );
    }
    assert.equal(client.history.length, 0);

    const sourceRef1 = { datasetName: WALK_EDGE_DATASET, smId: 1 };
    const sourceRef2 = { datasetName: WALK_EDGE_DATASET, smId: 2 };
    const result = await gateway.findPathWithBarriers(routeInput({
        requestId: 'route-barriers',
        barriers: [
            { edgeId: 'EDGE_2', sourceRef: sourceRef2 },
            { edgeId: 'EDGE_1', sourceRef: sourceRef1 },
            { edgeId: 'EDGE_2', sourceRef: sourceRef2 }
        ]
    }));

    assert.equal(transportRequest.operation, 'findPathWithBarriers');
    assert.equal(transportRequest.path, '/network/route/barriers');
    assert.deepEqual(transportRequest.data.barriers, [
        { edgeId: 'EDGE_1', sourceRef: sourceRef1 },
        { edgeId: 'EDGE_2', sourceRef: sourceRef2 }
    ]);
    assert.equal(result.gis.source, 'iserver');
});

test('barrier routes reject responses that still traverse a requested closed edge', async () => {
    const sourceRef = { datasetName: WALK_EDGE_DATASET, smId: 1 };
    const { gateway } = createHarness({ fixtures: { findPathWithBarriers: routeResponse() } });

    await assert.rejects(
        gateway.findPathWithBarriers(routeInput({
            barriers: [{ edgeId: 'EDGE_1', sourceRef }]
        })),
        error => error.code === 8205
            && error.httpStatus === 409
            && error.category === 'contract'
    );
    assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
});

test('barrier routes also reject matching canonical source references and missing provenance', async t => {
    const barrier = {
        edgeId: 'EDGE_1',
        sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 1 }
    };

    await t.test('matching sourceRef under a different edgeId', async () => {
        const { gateway } = createHarness({
            fixtures: {
                findPathWithBarriers: routeResponse({
                    segments: [{
                        edgeId: 'EDGE_DIFFERENT',
                        distanceM: 842,
                        durationSec: 662,
                        sourceRef: barrier.sourceRef
                    }]
                })
            }
        });

        await assert.rejects(
            gateway.findPathWithBarriers(routeInput({ barriers: [barrier] })),
            error => error.code === 8205 && error.category === 'contract'
        );
        assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
    });

    await t.test('empty segment provenance', async () => {
        const { gateway } = createHarness({
            fixtures: { findPathWithBarriers: routeResponse({ segments: [] }) }
        });

        await assert.rejects(
            gateway.findPathWithBarriers(routeInput({ barriers: [barrier] })),
            error => error.code === 8205 && error.category === 'contract'
        );
        assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
    });
});

test('route responses reject excessive snap distance, data-version mismatch, and invalid geometry', async t => {
    await t.test('snap distance', async () => {
        const { gateway } = createHarness({
            fixtures: { findPath: routeResponse({ snap: { startDistanceM: 51 } }) }
        });
        await assert.rejects(
            gateway.findPath(routeInput()),
            error => error.code === 8203 && error.category === 'snap'
        );
    });

    await t.test('data version', async () => {
        const { gateway } = createHarness({
            fixtures: { findPath: routeResponse({ dataVersion: 'unexpected-version' }) }
        });
        await assert.rejects(
            gateway.findPath(routeInput()),
            error => error.code === 8205 && error.category === 'contract'
        );
    });

    await t.test('missing data version', async () => {
        const response = routeResponse();
        delete response.data.dataVersion;
        const { gateway } = createHarness({ fixtures: { findPath: response } });
        await assert.rejects(
            gateway.findPath(routeInput()),
            error => error.code === 8205 && error.category === 'contract'
        );
        assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
    });

    await t.test('geometry', async () => {
        const { gateway } = createHarness({
            fixtures: {
                findPath: routeResponse({
                    geometry: { type: 'LineString', coordinates: [[120, 30]] }
                })
            }
        });
        await assert.rejects(
            gateway.findPath(routeInput()),
            error => error.code === 8206 && error.category === 'geometry'
        );
    });
});

test('a timeout can degrade to the canonical route cache with a fresh request ID', async () => {
    let requestCount = 0;
    const { gateway, client } = createHarness({
        fixtures: {
            findPath: () => {
                requestCount++;
                return requestCount === 1
                    ? routeResponse()
                    : transportError('ETIMEDOUT');
            }
        }
    });

    const first = await gateway.findPath(routeInput({ requestId: 'route-prime' }));
    const cached = await gateway.findPath(routeInput({ requestId: 'route-cache-hit' }));

    assert.equal(first.gis.source, 'iserver');
    assert.equal(cached.gis.source, 'cache');
    assert.equal(cached.gis.degraded, true);
    assert.equal(cached.gis.requestId, 'route-cache-hit');
    assert.notEqual(cached.gis.requestId, first.gis.requestId);
    assert.deepEqual(cached.geometry, first.geometry);
    assert.equal(client.history.length, 2);
    assert.equal(gateway.getDiagnostics().routeCacheSize, 1);
});

test('normal and shade modes use an explicitly marked local fallback after iServer failure', async t => {
    for (const mode of ['normal', 'shade']) {
        await t.test(mode, async () => {
            const localRequests = [];
            const { gateway } = createHarness({
                fixtures: { findPath: transportError('ECONNREFUSED') },
                localPathSource: async request => {
                    localRequests.push(request);
                    return routeResponse({ verifiedAccessible: false }).data;
                }
            });

            const result = await gateway.findPath(routeInput({
                mode,
                requestId: `local-${mode}`
            }));

            assert.equal(result.gis.source, 'local-fallback');
            assert.equal(result.gis.degraded, true);
            assert.equal(result.gis.mode, mode);
            assert.equal(result.fallback, true);
            assert.equal(localRequests.length, 1);
            assert.deepEqual(localRequests[0], {
                start: START,
                end: END,
                mode,
                scenicId: 'test-scenic',
                barriers: [],
                dataVersion: 'test-data-v1',
                requestId: `local-${mode}`
            });
        });
    }
});

test('accessible mode rejects an unverified local fallback with 8204', async () => {
    let localCalls = 0;
    const { gateway } = createHarness({
        fixtures: { findPath: transportError('ECONNREFUSED') },
        localPathSource: async () => {
            localCalls++;
            return routeResponse({ verifiedAccessible: false }).data;
        }
    });

    await assert.rejects(
        gateway.findPath(routeInput({ mode: 'accessible' })),
        error => error.code === 8204
            && error.httpStatus === 422
            && error.category === 'no-route'
    );
    assert.equal(localCalls, 1);
});

test('accessible mode accepts and preserves a verified local fallback', async () => {
    const { gateway } = createHarness({
        fixtures: { findPath: transportError('ECONNREFUSED') },
        localPathSource: async () => routeResponse({ verifiedAccessible: true }).data
    });

    const result = await gateway.findPath(routeInput({ mode: 'accessible' }));
    assert.equal(result.gis.source, 'local-fallback');
    assert.equal(result.gis.degraded, true);
    assert.equal(result.fallback, true);
    assert.equal(result.verifiedAccessible, true);
    assert.equal(result.accessibleVerified, true);
});

test('non-degradable failures do not consume cache or invoke local fallback', async t => {
    const cases = [
        {
            name: 'auth',
            failure: { status: 401, data: { message: 'unauthorized' } },
            code: 8201,
            category: 'auth'
        },
        {
            name: 'contract',
            failure: { status: 409, data: { message: 'version conflict' } },
            code: 8205,
            category: 'contract'
        },
        {
            name: 'cancellation',
            failure: transportError('ERR_CANCELED', 'CanceledError'),
            code: 8201,
            category: 'cancelled'
        },
        {
            name: 'rate-limit',
            failure: { status: 429, data: { message: 'rate limited' } },
            code: 8201,
            category: 'rate-limit'
        }
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            let requestCount = 0;
            let localCalls = 0;
            const { gateway } = createHarness({
                fixtures: {
                    findPath: () => {
                        requestCount++;
                        return requestCount === 1 ? routeResponse() : scenario.failure;
                    }
                },
                localPathSource: async () => {
                    localCalls++;
                    return routeResponse().data;
                }
            });

            await gateway.findPath(routeInput({ requestId: `${scenario.name}-prime` }));
            await assert.rejects(
                gateway.findPath(routeInput({ requestId: `${scenario.name}-failure` })),
                error => error.code === scenario.code && error.category === scenario.category
            );
            assert.equal(localCalls, 0);
            assert.equal(gateway.getDiagnostics().routeCacheSize, 1);
        });
    }
});

test('explicit invalidation clears canonical routes and aliases with safe diagnostics', async () => {
    const { gateway } = createHarness({ fixtures: { findPath: routeResponse() } });
    await gateway.findPath(routeInput());
    assert.equal(gateway.getDiagnostics().routeCacheSize, 1);
    assert.equal(gateway.getDiagnostics().routeCacheAliasCount, 1);

    const invalidation = await gateway.invalidateRouteCache('road-closed');

    assert.deepEqual(invalidation, {
        cleared: 1,
        routeCacheSize: 0,
        lastInvalidationReason: 'road-closed',
        lastInvalidatedAt: '2026-08-02T12:00:00.000Z'
    });
    assert.equal(gateway.getDiagnostics().routeCacheAliasCount, 0);
});

test('manifest data-version refresh invalidates the existing route cache', async () => {
    let dataVersion = 'test-data-v1';
    const client = new MockHttpClient({
        fixtures: {
            ...statusFixtures(),
            findPath: request => routeResponse({ dataVersion: request.data.dataVersion })
        }
    });
    const { gateway } = createHarness({
        httpClient: client,
        manifestLoader: () => manifestResult(dataVersion)
    });

    await gateway.findPath(routeInput());
    assert.equal(gateway.getDiagnostics().routeCacheSize, 1);

    dataVersion = 'test-data-v2';
    const status = await gateway.getStatus({ force: true, requestId: 'manifest-refresh' });
    const diagnostics = gateway.getDiagnostics();

    assert.equal(status.dataVersion, 'test-data-v2');
    assert.equal(diagnostics.routeCacheSize, 0);
    assert.equal(diagnostics.routeCacheAliasCount, 0);
    assert.equal(diagnostics.lastInvalidationReason, 'manifest-data-version-changed');
    assert.equal(diagnostics.lastInvalidatedAt, '2026-08-02T12:00:00.000Z');
});

test('getDiagnostics reads the injected route cache state live', () => {
    const clock = () => new Date('2026-08-02T12:00:00.000Z');
    const routeCache = new RouteCache({ clock, ttlMs: 12345 });
    const { gateway } = createHarness({ routeCache, clock });

    routeCache.set({
        dataVersion: 'test-data-v1',
        mode: 'normal',
        start: START,
        end: END,
        startNodeId: 'NODE_START',
        endNodeId: 'NODE_END',
        barriers: []
    }, { distanceM: 1 });

    assert.equal(gateway.getDiagnostics().routeCacheSize, 1);
    assert.equal(gateway.getDiagnostics().routeCacheAliasCount, 1);
    assert.equal(gateway.getDiagnostics().routeCacheTtlMs, 12345);

    routeCache.clear('network-republished');
    assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
    assert.equal(gateway.getDiagnostics().lastInvalidationReason, 'network-republished');
});

test('successful route logs contain only sanitized operational metadata', async () => {
    const { gateway, logs } = createHarness({ fixtures: { findPath: routeResponse() } });
    const sourceRef = { datasetName: WALK_EDGE_DATASET, smId: 7 };

    const result = await gateway.findPath(routeInput({
        requestId: 'unsafe\r\nrequest',
        barriers: [{ edgeId: 'EDGE_PRIVATE_7', sourceRef }]
    }));

    assert.equal(result.gis.requestId, 'unsafe__request');
    assert.equal(logs.info.length, 1);
    assert.equal(logs.warn.length, 0);
    assert.equal(logs.info[0].message, '[GeoSync] [GIS] operation completed');
    assert.deepEqual(Object.keys(logs.info[0].metadata).sort(), [
        'barrierCount',
        'dataVersion',
        'degraded',
        'durationMs',
        'mode',
        'operation',
        'requestId',
        'source',
        'status'
    ]);
    assert.deepEqual(logs.info[0].metadata, {
        requestId: 'unsafe__request',
        operation: 'findPath',
        mode: 'normal',
        barrierCount: 1,
        source: 'iserver',
        durationMs: 0,
        status: 'ok',
        dataVersion: 'test-data-v1',
        degraded: false
    });

    const serialized = JSON.stringify(logs);
    for (const forbidden of [
        'EDGE_PRIVATE_7',
        WALK_EDGE_DATASET,
        '120.005',
        'coordinates',
        'geometry',
        'password',
        'authorization'
    ]) {
        assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
    }
});
