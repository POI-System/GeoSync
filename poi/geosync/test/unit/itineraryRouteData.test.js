'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decodePolyline } = require('../../lib/geo');
const {
    routeMode,
    serializedRouteFields,
    aggregateRouteFromStops
} = require('../../services/itineraryRouteData');

function routeLeg({
    state = 'pending',
    coordinates,
    distanceM,
    durationSec,
    source = 'iserver',
    degraded = false,
    requestId,
    durationMs,
    dataVersion = 'v1',
    verifiedAccessible,
    edgeId,
    snap
}) {
    return {
        state,
        geometry: { type: 'LineString', coordinates },
        distanceM,
        durationSec,
        gis: {
            source,
            mode: 'normal',
            degraded,
            requestId,
            durationMs,
            dataVersion
        },
        segments: [{ edgeId, distanceM, durationSec }],
        snap,
        ...(verifiedAccessible === undefined ? {} : { verifiedAccessible })
    };
}

test('route data helpers preserve canonical fields and route-mode precedence', () => {
    const serialized = serializedRouteFields({
        toObject: () => ({
            geometry: {
                type: 'LineString',
                coordinates: [[118, 32], ['invalid', 32], [118.001, 32.001]]
            },
            distanceM: 80,
            durationSec: 60,
            gis: {
                source: 'local-fallback', mode: 'accessible', degraded: true,
                requestId: 'route-1', durationMs: 8, dataVersion: 'v1'
            },
            segments: [{
                edgeId: 'edge-1', distanceM: 80, durationSec: 60,
                sourceRef: { datasetName: 'walk-network', smId: 7 }
            }],
            snap: { startDistanceM: 1, endDistanceM: 2 },
            accessibleVerified: true,
            pathGeometry: 'encoded-route'
        })
    });

    assert.deepStrictEqual(serialized.geometry.coordinates, [[118, 32], [118.001, 32.001]]);
    assert.equal(serialized.verifiedAccessible, true);
    assert.deepStrictEqual(serialized.segments[0].sourceRef, {
        datasetName: 'walk-network', smId: 7
    });
    assert.equal(routeMode({ accessible: true, shadeFirst: true }), 'accessible');
    assert.equal(routeMode({ shadeFirst: true }), 'shade');
    assert.equal(routeMode({}), 'normal');
});

test('aggregate route joins mutable legs and combines route provenance', () => {
    const first = routeLeg({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 140,
        durationSec: 120,
        requestId: 'route-a',
        durationMs: 10,
        verifiedAccessible: true,
        edgeId: 'edge-a',
        snap: { startDistanceM: 1, endDistanceM: 2 }
    });
    const ignored = routeLeg({
        state: 'skipped',
        coordinates: [[0, 0], [1, 1]],
        distanceM: 999,
        durationSec: 999,
        requestId: 'ignored',
        durationMs: 999,
        verifiedAccessible: true,
        edgeId: 'edge-ignored',
        snap: { startDistanceM: 99, endDistanceM: 99 }
    });
    const second = routeLeg({
        coordinates: [[118.001, 32.001], [118.002, 32.002]],
        distanceM: 220,
        durationSec: 180,
        source: 'local-fallback',
        degraded: true,
        requestId: 'route-b',
        durationMs: 5,
        verifiedAccessible: false,
        edgeId: 'edge-b',
        snap: { startDistanceM: 3, endDistanceM: 4 }
    });

    const aggregate = aggregateRouteFromStops(
        [first, ignored, second],
        { accessible: true, shadeFirst: true }
    );

    assert.deepStrictEqual(aggregate.geometry.coordinates, [
        [118, 32], [118.001, 32.001], [118.002, 32.002]
    ]);
    assert.equal(aggregate.distanceM, 360);
    assert.equal(aggregate.durationSec, 300);
    assert.deepStrictEqual(aggregate.segments.map(segment => segment.edgeId), ['edge-a', 'edge-b']);
    assert.deepStrictEqual(aggregate.snap, { startDistanceM: 1, endDistanceM: 4 });
    assert.deepStrictEqual(aggregate.gis, {
        source: 'local-fallback',
        mode: 'accessible',
        degraded: true,
        requestId: 'route-a',
        durationMs: 15,
        dataVersion: 'v1'
    });
    assert.equal(aggregate.verifiedAccessible, false);
    assert.deepStrictEqual(decodePolyline(aggregate.pathGeometry), aggregate.geometry.coordinates);
});

test('aggregate accessibility verification remains tri-state', () => {
    const leg = verifiedAccessible => routeLeg({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 80,
        durationSec: 60,
        requestId: 'route',
        durationMs: 1,
        verifiedAccessible,
        edgeId: 'edge',
        snap: null
    });

    assert.equal(aggregateRouteFromStops([leg(true), leg(true)], {}).verifiedAccessible, true);
    assert.equal(aggregateRouteFromStops([leg(true), leg(undefined)], {}).verifiedAccessible, null);
    assert.equal(aggregateRouteFromStops([leg(true), leg(false)], {}).verifiedAccessible, false);
});
