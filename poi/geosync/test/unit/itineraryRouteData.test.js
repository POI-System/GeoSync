'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decodePolyline } = require('../../lib/geo');
const { createTopologyProof, validateRouteTopology } = require('../../lib/routeTopologyProvenance');
const {
    RouteDataVersionError,
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

test('route serialization and aggregation preserve verifiable topology provenance', () => {
    const provenLeg = ({ from, to, fromNodeId, toNodeId, edgeId, smId, distanceM, durationSec }) => {
        const geometry = { type: 'LineString', coordinates: [from, to] };
        const segments = [{
            edgeId,
            physicalEdgeId: `physical-${edgeId}`,
            fromNodeId,
            toNodeId,
            distanceM,
            durationSec,
            sourceRef: { datasetName: 'WalkEdge@Test', smId }
        }];
        const nodeIds = [fromNodeId, toNodeId];
        return {
            state: 'pending',
            geometry,
            distanceM,
            durationSec,
            gis: {
                source: 'iserver', mode: 'normal', degraded: false,
                requestId: edgeId, durationMs: 1, dataVersion: 'v1'
            },
            segments,
            nodeIds,
            edgeIds: [edgeId],
            topologyProof: createTopologyProof({
                authority: 'iserver-network-analysis',
                dataVersion: 'v1',
                geometry,
                nodeIds,
                segments,
                distanceM,
                durationSec
            }),
            snap: {
                startNodeId: fromNodeId,
                endNodeId: toNodeId,
                startDistanceM: 0,
                endDistanceM: 0
            }
        };
    };
    const first = provenLeg({
        from: [118, 32], to: [118.001, 32.001],
        fromNodeId: 'A', toNodeId: 'B', edgeId: 'AB', smId: 1,
        distanceM: 80, durationSec: 60
    });
    const second = provenLeg({
        from: [118.001, 32.001], to: [118.002, 32.002],
        fromNodeId: 'B', toNodeId: 'C', edgeId: 'BC', smId: 2,
        distanceM: 90, durationSec: 70
    });

    const serialized = serializedRouteFields({ toObject: () => first });
    assert.equal(serialized.segments[0].physicalEdgeId, 'physical-AB');
    assert.deepStrictEqual(serialized.nodeIds, ['A', 'B']);
    assert.deepStrictEqual(serialized.snap, {
        startNodeId: 'A', endNodeId: 'B', startDistanceM: 0, endDistanceM: 0
    });
    assert.equal(validateRouteTopology(serialized, {
        authority: 'iserver-network-analysis', expectedDataVersion: 'v1'
    }).valid, true);

    const aggregate = aggregateRouteFromStops([first, second], {});
    assert.equal(aggregate.topologyProof.authority, 'planner-aggregate');
    assert.deepStrictEqual(aggregate.nodeIds, ['A', 'B', 'C']);
    assert.deepStrictEqual(aggregate.edgeIds, ['AB', 'BC']);
    assert.equal(validateRouteTopology(aggregate, {
        authority: 'planner-aggregate', expectedDataVersion: 'v1'
    }).valid, true);
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

test('versioned aggregation rejects missing and mixed route data versions', () => {
    const leg = dataVersion => routeLeg({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 80,
        durationSec: 60,
        requestId: 'route-versioned',
        durationMs: 1,
        dataVersion,
        edgeId: 'edge-versioned',
        snap: null
    });

    for (const actualVersion of [null, '', 'v2']) {
        assert.throws(
            () => aggregateRouteFromStops(
                [leg('v1'), leg(actualVersion)],
                {},
                null,
                { expectedDataVersion: 'v1' }
            ),
            error => error instanceof RouteDataVersionError
                && error.code === 'ROUTE_DATA_VERSION_MISMATCH'
                && error.details.expectedDataVersion === 'v1'
        );
    }

    const aggregate = aggregateRouteFromStops(
        [leg('v1'), leg('v1')],
        {},
        null,
        { expectedDataVersion: 'v1' }
    );
    assert.equal(aggregate.gis.dataVersion, 'v1');
});

test('versioned fallback aggregation also fails closed on an unknown version', () => {
    const fallback = routeLeg({
        coordinates: [[118, 32], [118.001, 32.001]],
        distanceM: 80,
        durationSec: 60,
        requestId: 'fallback-versioned',
        durationMs: 1,
        dataVersion: null,
        edgeId: 'edge-fallback',
        snap: null
    });

    assert.throws(
        () => aggregateRouteFromStops([], {}, fallback, { expectedDataVersion: 'v1' }),
        error => error instanceof RouteDataVersionError
            && error.details.actualDataVersion === null
    );
});
