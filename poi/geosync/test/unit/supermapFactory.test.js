'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSuperMapGateway } = require('../../integrations/supermap');
const RouteCache = require('../../integrations/supermap/routeCache');
const { validateManifest, createPublicConfig } = require('../../integrations/supermap/manifest');

function rawManifest() {
    return {
        contractVersion: '1.0.0',
        dataVersion: 'factory-data-v1',
        scenicId: 'factory-scenic',
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
                name: 'FactoryPoi@TestDatasource',
                fields: ['SmID', 'poi_id'],
                propertyMap: { poi_id: 'poiId' }
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

function inertHttpClient() {
    return {
        async request() {
            throw new Error('HTTP should not be used by this factory wiring test');
        }
    };
}

function baseOptions(overrides = {}) {
    return {
        env: {},
        cwd: 'D:\\factory-test',
        manifestLoader: () => validManifestResult(),
        httpClient: inertHttpClient(),
        logger: { info() {}, warn() {}, error() {} },
        ...overrides
    };
}

test('factory accepts common boolean forms and forwards route timing values', () => {
    const gateway = createSuperMapGateway(baseOptions({
        env: {
            SUPERMAP_ENABLED: '1',
            SUPERMAP_TIMEOUT_MS: '4321',
            SUPERMAP_MANIFEST_RETRY_MS: '23456',
            SUPERMAP_CACHE_TTL_S: '12.5',
            SUPERMAP_FALLBACK_ENABLED: 'off'
        }
    }));

    assert.equal(gateway.enabled, true);
    assert.equal(gateway.routeTimeoutMs, 4321);
    assert.equal(gateway.manifestFailureTtlMs, 23456);
    assert.equal(gateway.routeCache.ttlMs, 12500);
    assert.equal(gateway.fallbackEnabled, false);
});

test('factory warns and uses safe defaults for unknown boolean environment values', () => {
    const warnings = [];
    const gateway = createSuperMapGateway(baseOptions({
        env: {
            SUPERMAP_ENABLED: 'sometimes',
            SUPERMAP_FALLBACK_ENABLED: 'perhaps'
        },
        logger: {
            info() {},
            error() {},
            warn(message, metadata) { warnings.push({ message, metadata }); }
        }
    }));

    assert.equal(gateway.enabled, true);
    assert.equal(gateway.fallbackEnabled, true);
    assert.deepStrictEqual(warnings, [{
        message: '[GeoSync] [GIS] SUPERMAP_ENABLED has an invalid boolean value; using the default',
        metadata: { fallback: true }
    }, {
        message: '[GeoSync] [GIS] SUPERMAP_FALLBACK_ENABLED has an invalid boolean value; using the default',
        metadata: { fallback: true }
    }]);
});

test('explicit route options override environment defaults and reach the Gateway', () => {
    const localPathSource = async () => null;
    const gateway = createSuperMapGateway(baseOptions({
        env: {
            SUPERMAP_TIMEOUT_MS: '9000',
            SUPERMAP_CACHE_TTL_S: '60',
            SUPERMAP_FALLBACK_ENABLED: 'false'
        },
        routeTimeoutMs: 2345,
        routeCacheTtlMs: 7654,
        fallbackEnabled: true,
        localPathSource,
        maxSnapDistanceM: 37,
        boundsBufferDeg: 0.025
    }));

    assert.equal(gateway.routeTimeoutMs, 2345);
    assert.equal(gateway.routeCache.ttlMs, 7654);
    assert.equal(gateway.fallbackEnabled, true);
    assert.equal(gateway.localPathSource, localPathSource);
    assert.equal(gateway.maxSnapDistanceM, 37);
    assert.equal(gateway.boundsBufferDeg, 0.025);
});

test('factory preserves an injected route cache instead of replacing it', () => {
    const routeCache = new RouteCache({
        clock: () => new Date('2026-08-02T12:00:00.000Z'),
        ttlMs: 9876
    });
    const gateway = createSuperMapGateway(baseOptions({
        routeCache,
        routeCacheTtlMs: 1234
    }));

    assert.equal(gateway.routeCache, routeCache);
    assert.equal(gateway.routeCache.ttlMs, 9876);
});

test('invalid HTTP configuration keeps GIS offline without exposing credentials', async () => {
    const fakeBaseUrl = 'http://gis.invalid:8090';
    const fakeUsername = 'fixture-private-user';
    const fakePassword = 'fixture-private-password';
    let axiosCalls = 0;
    const logs = [];
    const gateway = createSuperMapGateway({
        env: {
            SUPERMAP_ENABLED: 'true',
            ISERVER_BASE: fakeBaseUrl,
            ISERVER_USERNAME: fakeUsername,
            ISERVER_PASSWORD: fakePassword
        },
        cwd: 'D:\\factory-test',
        manifestLoader: () => validManifestResult(),
        axios: {
            async request() {
                axiosCalls++;
                return { status: 200, data: {} };
            }
        },
        logger: {
            info(message, metadata) { logs.push({ level: 'info', message, metadata }); },
            warn(message, metadata) { logs.push({ level: 'warn', message, metadata }); },
            error(message, metadata) { logs.push({ level: 'error', message, metadata }); }
        }
    });

    const status = await gateway.getStatus({ requestId: 'invalid-http-config' });
    const publicConfig = gateway.getPublicConfig();
    let routeError;
    await assert.rejects(
        gateway.findPath({
            start: [120, 30],
            end: [120.01, 30.01],
            mode: 'normal',
            scenicId: 'factory-scenic'
        }),
        error => {
            routeError = error;
            return error.code === 8201
                && error.category === 'configuration'
                && error.retryable === false;
        }
    );

    assert.equal(gateway.enabled, false);
    assert.equal(status.state, 'offline');
    assert.equal(status.enabled, false);
    assert.deepEqual(status.services, {
        map: 'disabled',
        data: 'disabled',
        network: 'disabled',
        terrain: 'disabled',
        scene: 'disabled'
    });
    assert.equal(publicConfig.state, 'offline');
    assert.equal(publicConfig.enabled, false);
    assert.deepEqual(publicConfig.publicServices, { map: '/public/map' });
    assert.equal(axiosCalls, 0);
    assert.deepEqual(logs, [{
        level: 'error',
        message: '[GeoSync] [GIS] HTTP client configuration is invalid; GIS is offline',
        metadata: undefined
    }]);

    const serialized = JSON.stringify({
        status,
        publicConfig,
        logs,
        routeError: routeError.toJSON()
    });
    for (const forbidden of [fakeBaseUrl, fakeUsername, fakePassword, 'ISERVER_USERNAME', 'ISERVER_PASSWORD']) {
        assert.equal(serialized.includes(forbidden), false);
    }
});
