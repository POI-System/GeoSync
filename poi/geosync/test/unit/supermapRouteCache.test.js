'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RouteCache = require('../../integrations/supermap/routeCache');
const {
    buildRouteCacheKey,
    buildRouteRequestSignature
} = RouteCache;

function request(overrides = {}) {
    return {
        dataVersion: 'test-data-v1',
        mode: 'normal',
        start: [120.0000004, 30.0000004],
        end: [120.0100004, 30.0100004],
        startNodeId: 'NODE_START',
        endNodeId: 'NODE_END',
        barriers: [
            { edgeId: 'EDGE_20' },
            { edgeId: 'EDGE_10' },
            { edgeId: 'EDGE_20' }
        ],
        ...overrides
    };
}

test('buildRouteCacheKey is stable, directional, and uses sorted unique barrier IDs', () => {
    const first = buildRouteCacheKey(request());
    const reordered = buildRouteCacheKey(request({
        barriers: ['EDGE_10', 'EDGE_20', 'EDGE_10']
    }));
    const reversed = buildRouteCacheKey(request({
        startNodeId: 'NODE_END',
        endNodeId: 'NODE_START'
    }));

    assert.equal(first, reordered);
    assert.notEqual(first, reversed);
    assert.match(first, /NODE_START/);
    assert.match(first, /NODE_END/);
    assert.equal((first.match(/EDGE_20/g) || []).length, 1);
});

test('canonical cache keys cannot be built without both snapped node IDs', () => {
    assert.throws(
        () => buildRouteCacheKey(request({ startNodeId: '' })),
        /startNodeId/
    );
    assert.throws(
        () => buildRouteCacheKey(request({ endNodeId: null })),
        /endNodeId/
    );
});

test('buildRouteRequestSignature normalizes coordinates and remains directional', () => {
    const first = buildRouteRequestSignature(request());
    const rounded = buildRouteRequestSignature(request({
        start: [120, 30],
        end: [120.01, 30.01],
        barriers: ['EDGE_20', 'EDGE_10']
    }));
    const reversed = buildRouteRequestSignature(request({
        start: [120.01, 30.01],
        end: [120, 30]
    }));

    assert.equal(first, rounded);
    assert.notEqual(first, reversed);
    assert.doesNotMatch(first, /NODE_START|NODE_END/);
});

test('RouteCache aliases a coordinate signature to a canonical snapped-node key', () => {
    const routeStore = new Map();
    const aliasStore = new Map();
    const cache = new RouteCache({ store: routeStore, aliasStore, clock: () => 1000, ttlMs: 5000 });
    const route = { distanceM: 42, geometry: { type: 'LineString', coordinates: [[120, 30], [120.01, 30.01]] } };

    const canonicalKey = cache.set(request(), route);

    assert.equal(routeStore.has(canonicalKey), true);
    assert.equal([...routeStore.keys()].every(key => key.startsWith('route:') && key.includes('NODE_START')), true);
    assert.equal(aliasStore.get(buildRouteRequestSignature(request())).canonicalKey, canonicalKey);
    assert.deepEqual(cache.get(request()), route);
    assert.deepEqual(cache.getByCanonicalKey(request()), route);
});

test('set and get isolate cached routes with deep clones', () => {
    const cache = new RouteCache({ clock: () => 1000 });
    const original = {
        segments: [{ edgeId: 'EDGE_10' }],
        geometry: { type: 'LineString', coordinates: [[120, 30], [120.01, 30.01]] }
    };

    cache.set(request(), original);
    original.segments[0].edgeId = 'MUTATED_ORIGINAL';
    original.geometry.coordinates[0][0] = 0;

    const firstRead = cache.get(request());
    assert.equal(firstRead.segments[0].edgeId, 'EDGE_10');
    assert.equal(firstRead.geometry.coordinates[0][0], 120);

    firstRead.segments[0].edgeId = 'MUTATED_READ';
    assert.equal(cache.get(request()).segments[0].edgeId, 'EDGE_10');
});

test('TTL expiry removes stale aliases and canonical entries', () => {
    let now = 1000;
    const routeStore = new Map();
    const aliasStore = new Map();
    const cache = new RouteCache({ store: routeStore, aliasStore, clock: () => now, ttlMs: 100 });

    cache.set(request(), { distanceM: 1 });
    assert.equal(cache.size, 1);
    now = 1100;

    assert.equal(cache.get(request()), undefined);
    assert.equal(cache.size, 0);
    assert.equal(aliasStore.size, 0);
    assert.equal(routeStore.size, 0);
});

test('clear records sanitized diagnostics without keys, coordinates, or route payloads', () => {
    const routeStore = new Map();
    const aliasStore = new Map();
    const cache = new RouteCache({
        store: routeStore,
        aliasStore,
        clock: () => new Date('2026-08-02T08:00:00.000Z'),
        ttlMs: 60000
    });
    cache.set(request(), {
        geometry: { type: 'LineString', coordinates: [[120.123456, 30.123456], [120.2, 30.2]] },
        privatePayload: 'must-not-appear'
    });

    assert.equal(cache.clear('manifest-data-version-changed'), 1);
    assert.deepEqual(cache.getDiagnostics(), {
        size: 0,
        aliasCount: 0,
        ttlMs: 60000,
        lastInvalidationReason: 'manifest-data-version-changed',
        lastInvalidatedAt: '2026-08-02T08:00:00.000Z'
    });

    const serialized = JSON.stringify(cache.diagnostics);
    for (const forbidden of ['NODE_START', '120.123456', 'must-not-appear']) {
        assert.equal(serialized.includes(forbidden), false);
    }

    cache.clear('token=placeholder-secret');
    assert.equal(cache.getDiagnostics().lastInvalidationReason, 'redacted');
});

test('constructor rejects invalid stores, clocks, and TTL values', () => {
    assert.throws(() => new RouteCache({ store: {} }), /Map-like/);
    assert.throws(() => new RouteCache({ clock: 'now' }), /clock/);
    assert.throws(() => new RouteCache({ ttlMs: 0 }), /ttlMs/);
});
