'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decodePolyline } = require('../../lib/geo');
const { createTopologyProof, validateRouteTopology } = require('../../lib/routeTopologyProvenance');
const {
    IServerTimeoutError,
    SuperMapError
} = require('../../integrations/supermap/errors');
const {
    rebuildTimeline,
    TimelineRebuildError,
    RECENT_POSITION_MAX_AGE_MS
} = require('../../services/itineraryTimeline');

const MINUTE = 60000;
const NOW = new Date('2026-07-21T09:00:00.000Z');

function stop(id, poiId, state = 'pending', arrive = NOW, stayMin = 20, pathGeometry = 'old-path') {
    const plannedArrive = new Date(arrive);
    return {
        _id: id,
        poiId,
        state,
        plannedArrive,
        plannedLeave: new Date(plannedArrive.getTime() + stayMin * MINUTE),
        pathGeometry
    };
}

function poi(id, coordinates = [118, 32], suggestedStayMin = 20) {
    return {
        _id: id,
        geo: { type: 'Point', coordinates },
        visitMeta: { suggestedStayMin }
    };
}

function loader(pois) {
    const byId = new Map(pois.map(item => [String(item._id), item]));
    return async ids => ids.map(id => byId.get(String(id))).filter(Boolean);
}

let routeSequence = 0;

function topologyRoute(from, to, mode = 'standard', options = {}) {
    const source = options.source || 'iserver';
    const normalizedMode = mode === 'standard' ? 'normal' : mode;
    const fromCoordinates = options.coordinates?.[0] || from.geo.coordinates;
    const toCoordinates = options.coordinates?.[1] || to.geo.coordinates;
    const coordinatesMatch = fromCoordinates[0] === toCoordinates[0]
        && fromCoordinates[1] === toCoordinates[1];
    const distanceM = options.distanceM ?? (coordinatesMatch ? 0 : 80);
    const durationSec = options.durationSec ?? options.walkSec ?? (coordinatesMatch ? 0 : 60);
    const sameNode = distanceM === 0 && durationSec === 0 && coordinatesMatch;
    const suffix = ++routeSequence;
    const fromNodeId = options.fromNodeId || `timeline-node-${suffix}-from`;
    const toNodeId = sameNode
        ? fromNodeId
        : options.toNodeId || `timeline-node-${suffix}-to`;
    const edgeId = options.edgeId || `timeline-edge-${suffix}`;
    const segments = sameNode ? [] : [{
        edgeId,
        fromNodeId,
        toNodeId,
        distanceM,
        durationSec,
        sourceRef: { datasetName: 'WalkEdge@Test', smId: suffix }
    }];
    const nodeIds = sameNode ? [fromNodeId] : [fromNodeId, toNodeId];
    const geometry = {
        type: 'LineString',
        coordinates: sameNode
            ? [[...fromCoordinates], [...fromCoordinates]]
            : [[...fromCoordinates], [...toCoordinates]]
    };
    const dataVersion = Object.prototype.hasOwnProperty.call(options, 'dataVersion')
        ? options.dataVersion
        : 'v1';
    const route = {
        available: true,
        authoritative: true,
        routeFound: true,
        routeKind: 'topology',
        topology: true,
        durationSec,
        walkSec: durationSec,
        distanceM,
        geometry,
        nodeIds,
        edgeIds: segments.map(segment => segment.edgeId),
        edgeDataVersions: segments.map(() => dataVersion),
        segments,
        snap: {
            startNodeId: nodeIds[0],
            endNodeId: nodeIds[nodeIds.length - 1],
            startDistanceM: 0,
            endDistanceM: 0
        },
        gis: {
            source,
            mode: normalizedMode,
            degraded: source !== 'iserver',
            requestId: options.requestId || `timeline-route-${suffix}`,
            durationMs: 1,
            dataVersion
        },
        ...(options.verifiedAccessible === undefined ? {} : {
            verifiedAccessible: options.verifiedAccessible,
            accessibleVerified: options.verifiedAccessible
        })
    };
    const topologyProof = typeof dataVersion === 'string' && dataVersion.trim()
        ? createTopologyProof({
            authority: source === 'local-fallback'
                ? 'local-walk-graph'
                : 'iserver-network-analysis',
            dataVersion,
            geometry,
            nodeIds,
            segments,
            distanceM,
            durationSec
        })
        : null;
    return {
        ...route,
        topologyProof,
        ...(options.overrides || {})
    };
}

test('recent lastPosition wins and immutable states keep their timeline and geometry', async () => {
    const immutable = [
        stop('done', 'done-poi', 'done', '2026-07-21T07:00:00.000Z', 20, 'done-path'),
        stop('arrived', 'arrived-poi', 'arrived', '2026-07-21T08:50:00.000Z', 20, 'arrived-path'),
        stop('skipped', 'skipped-poi', 'skipped', '2026-07-21T10:00:00.000Z', 20, 'skipped-path'),
        stop('rerouted', 'rerouted-poi', 'rerouted', '2026-07-21T10:30:00.000Z', 20, 'rerouted-path')
    ];
    const pending = stop('next', 'next-poi', 'pending', '2026-07-21T11:00:00.000Z', 15);
    const proposedStops = [...immutable, pending];
    const calls = [];

    const rebuilt = await rebuildTimeline({
        itinerary: {
            startLocation: [117, 31],
            lastPosition: { lng: 118.5, lat: 32.5, at: new Date(NOW.getTime() - 2 * MINUTE) },
            preferences: {}
        },
        proposedStops,
        now: NOW,
        loadPois: loader([
            poi('done-poi'), poi('arrived-poi'), poi('skipped-poi'),
            poi('rerouted-poi'), poi('next-poi')
        ]),
        routeBetween: async (from, to, mode) => {
            calls.push({ from, to, mode });
            return topologyRoute(from, to, mode, { durationSec: 60, distanceM: 80 });
        }
    });

    assert.deepStrictEqual(calls[0].from.geo.coordinates, [118.5, 32.5]);
    assert.strictEqual(calls[0].from._timelineAnchor, 'lastPosition');
    assert.strictEqual(calls[0].mode, 'standard');
    assert.strictEqual(rebuilt[4].plannedArrive.toISOString(), '2026-07-21T09:11:00.000Z');
    assert.deepStrictEqual(
        decodePolyline(rebuilt[4].pathGeometry),
        [[118.5, 32.5], [118, 32]]
    );
    for (let i = 0; i < immutable.length; i++) {
        assert.strictEqual(rebuilt[i].plannedArrive.getTime(), immutable[i].plannedArrive.getTime());
        assert.strictEqual(rebuilt[i].plannedLeave.getTime(), immutable[i].plannedLeave.getTime());
        assert.strictEqual(rebuilt[i].pathGeometry, immutable[i].pathGeometry);
    }
    assert.strictEqual(proposedStops[4].pathGeometry, 'old-path', 'input stops must not be mutated');
});

test('anchor falls back from stale position to arrived, last done, then startLocation', async () => {
    const allPois = [poi('arrived-poi'), poi('done-poi'), poi('next-poi')];
    const seen = [];
    const routeBetween = async (from, to, mode) => {
        seen.push(from._id || from._timelineAnchor);
        return topologyRoute(from, to, mode);
    };
    const stalePosition = {
        lng: 120,
        lat: 30,
        at: new Date(NOW.getTime() - RECENT_POSITION_MAX_AGE_MS - 1)
    };

    await rebuildTimeline({
        itinerary: { lastPosition: stalePosition, startLocation: [117, 31], preferences: {} },
        proposedStops: [
            stop('arrived', 'arrived-poi', 'arrived', NOW, 0),
            stop('next', 'next-poi')
        ],
        now: NOW,
        loadPois: loader(allPois),
        routeBetween
    });
    await rebuildTimeline({
        itinerary: { startLocation: [117, 31], preferences: {} },
        proposedStops: [stop('done', 'done-poi', 'done'), stop('next', 'next-poi')],
        now: NOW,
        loadPois: loader(allPois),
        routeBetween
    });
    await rebuildTimeline({
        itinerary: { startLocation: [117, 31], preferences: {} },
        proposedStops: [stop('next', 'next-poi')],
        now: NOW,
        loadPois: loader(allPois),
        routeBetween
    });

    assert.deepStrictEqual(seen, ['arrived-poi', 'done-poi', 'startLocation']);
});

test('rebuilds every mutable segment with route ETA, geometry, and original stay duration', async () => {
    const calls = [];
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { shadeFirst: true } },
        proposedStops: [
            stop('a', 'poi-a', 'pending', '2026-07-21T12:00:00.000Z', 10),
            stop('b', 'poi-b', 'approaching', '2026-07-21T13:00:00.000Z', 20)
        ],
        now: NOW,
        loadPois: loader([
            poi('poi-a', [118.001, 32.001]),
            poi('poi-b', [118.002, 32.002])
        ]),
        routeBetween: async (from, to, mode) => {
            calls.push({ from: from._id || from._timelineAnchor, to: to._id, mode });
            return topologyRoute(from, to, mode, to._id === 'poi-a'
                ? { durationSec: 120, distanceM: 140, edgeId: 'edge-a', requestId: 'gis-a' }
                : { durationSec: 180, distanceM: 220, edgeId: 'edge-b', source: 'cache', requestId: 'gis-b' });
        }
    });

    assert.deepStrictEqual(calls, [
        { from: 'startLocation', to: 'poi-a', mode: 'shade' },
        { from: 'poi-a', to: 'poi-b', mode: 'shade' }
    ]);
    assert.strictEqual(rebuilt[0].plannedArrive.toISOString(), '2026-07-21T09:02:00.000Z');
    assert.strictEqual(rebuilt[0].plannedLeave.toISOString(), '2026-07-21T09:12:00.000Z');
    assert.strictEqual(rebuilt[1].plannedArrive.toISOString(), '2026-07-21T09:15:00.000Z');
    assert.strictEqual(rebuilt[1].plannedLeave.toISOString(), '2026-07-21T09:35:00.000Z');
    assert.deepStrictEqual(rebuilt.map(item => item.durationSec), [120, 180]);
    assert.deepStrictEqual(rebuilt.map(item => item.distanceM), [140, 220]);
    assert.deepStrictEqual(rebuilt[0].geometry.coordinates, [[118, 32], [118.001, 32.001]]);
    assert.deepStrictEqual(rebuilt.map(item => item.segments[0].edgeId), ['edge-a', 'edge-b']);
    assert.equal(rebuilt[0].snap.startDistanceM, 0);
    assert.equal(rebuilt[0].snap.endDistanceM, 0);
    assert.strictEqual(rebuilt[1].gis.source, 'cache');
    assert.deepStrictEqual(
        decodePolyline(rebuilt[0].pathGeometry),
        [[118, 32], [118.001, 32.001]]
    );
    assert.deepStrictEqual(rebuilt.map(item => item.state), ['approaching', 'pending']);
});

test('timeline rebuild preserves canonical topology proof, nodes, physical edge, and snap nodes', async () => {
    const geometry = {
        type: 'LineString',
        coordinates: [[118, 32], [118.001, 32.001]]
    };
    const segments = [{
        edgeId: 'AB',
        physicalEdgeId: 'physical-AB',
        fromNodeId: 'A',
        toNodeId: 'B',
        distanceM: 80,
        durationSec: 60,
        sourceRef: { datasetName: 'WalkEdge@Test', smId: 1 }
    }];
    const nodeIds = ['A', 'B'];
    const topologyProof = createTopologyProof({
        authority: 'iserver-network-analysis',
        dataVersion: 'v1',
        geometry,
        nodeIds,
        segments,
        distanceM: 80,
        durationSec: 60
    });
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])]),
        routeBetween: async () => ({
            available: true,
            authoritative: true,
            routeFound: true,
            routeKind: 'topology',
            topology: true,
            durationSec: 60,
            distanceM: 80,
            geometry,
            segments,
            nodeIds,
            edgeIds: ['AB'],
            topologyProof,
            snap: {
                startNodeId: 'A', endNodeId: 'B',
                startDistanceM: 0, endDistanceM: 0
            },
            gis: {
                source: 'iserver', mode: 'normal', degraded: false,
                requestId: 'timeline-proof', durationMs: 1, dataVersion: 'v1'
            }
        })
    });

    assert.equal(rebuilt[0].segments[0].physicalEdgeId, 'physical-AB');
    assert.deepStrictEqual(rebuilt[0].nodeIds, ['A', 'B']);
    assert.deepStrictEqual(rebuilt[0].edgeIds, ['AB']);
    assert.deepStrictEqual(rebuilt[0].snap, {
        startNodeId: 'A', endNodeId: 'B', startDistanceM: 0, endDistanceM: 0
    });
    assert.equal(validateRouteTopology(rebuilt[0], {
        authority: 'iserver-network-analysis', expectedDataVersion: 'v1'
    }).valid, true);
});

test('forwards the exact route context to every mutable route leg', async () => {
    const barriers = Object.freeze([
        Object.freeze({
            edgeId: 'closed-edge',
            sourceRef: Object.freeze({ datasetName: 'walk-network', smId: 7 })
        })
    ]);
    const routeContext = Object.freeze({
        barriers,
        eventId: 'edge-event-1',
        requestId: 'reroute-request-1',
        barrierFingerprint: 'barriers-v1'
    });
    const contexts = [];

    await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [
            stop('a', 'poi-a', 'pending', NOW, 10),
            stop('b', 'poi-b', 'pending', NOW, 10)
        ],
        now: NOW,
        loadPois: loader([poi('poi-a'), poi('poi-b')]),
        routeContext,
        routeBetween: async (from, to, mode, context) => {
            contexts.push(context);
            return topologyRoute(from, to, mode);
        }
    });

    assert.equal(contexts.length, 2);
    for (const context of contexts) assert.strictEqual(context, routeContext);
    assert.deepStrictEqual(contexts[0], {
        barriers: [{
            edgeId: 'closed-edge',
            sourceRef: { datasetName: 'walk-network', smId: 7 }
        }],
        eventId: 'edge-event-1',
        requestId: 'reroute-request-1',
        barrierFingerprint: 'barriers-v1'
    });
});

test('versioned timeline rebuild rejects a missing or mixed leg data version', async () => {
    const base = {
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])]),
        routeContext: {
            barriers: [],
            barrierFingerprint: 'sha256:empty',
            dataVersion: 'v1'
        }
    };

    for (const actualDataVersion of [null, '', 'v2']) {
        await assert.rejects(
            rebuildTimeline({
                ...base,
                routeBetween: async (from, to, mode) => topologyRoute(from, to, mode, {
                    dataVersion: actualDataVersion,
                    requestId: 'versioned-rebuild'
                })
            }),
            error => error instanceof SuperMapError
                && error.code === 8205
                && error.httpStatus === 409
        );
    }
});

test('an arrived stop owns current progress while all future stops remain pending', async () => {
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [
            stop('current', 'poi-current', 'arrived', NOW, 20),
            stop('a', 'poi-a', 'approaching'),
            stop('b', 'poi-b', 'pending')
        ],
        now: NOW,
        loadPois: loader([
            poi('poi-current', [118, 32]),
            poi('poi-a', [118.001, 32.001]),
            poi('poi-b', [118.002, 32.002])
        ]),
        routeBetween: async (from, to, mode) => topologyRoute(from, to, mode)
    });

    assert.deepStrictEqual(rebuilt.map(item => item.state), ['arrived', 'pending', 'pending']);
});

test('delay proposal adds one wait even when proposedStops already contain shifted times', async () => {
    const alreadyShifted = new Date(NOW.getTime() + 25 * MINUTE);
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [
            stop('target', 'poi-a', 'pending', alreadyShifted, 20),
            stop('after', 'poi-b', 'pending', new Date(alreadyShifted.getTime() + 30 * MINUTE), 10)
        ],
        proposal: { type: 'delay', payload: { stopId: 'target', delayMin: 25 } },
        now: NOW,
        loadPois: loader([
            poi('poi-a', [118.001, 32.001]),
            poi('poi-b', [118.002, 32.002])
        ]),
        routeBetween: async (from, to, mode) => topologyRoute(from, to, mode, {
            durationSec: 5 * 60,
            distanceM: 300
        })
    });

    assert.strictEqual(rebuilt[0].plannedArrive.toISOString(), '2026-07-21T09:30:00.000Z');
    assert.strictEqual(rebuilt[0].plannedLeave.toISOString(), '2026-07-21T09:50:00.000Z');
    assert.strictEqual(rebuilt[1].plannedArrive.toISOString(), '2026-07-21T09:55:00.000Z');
});

test('replace uses the new POI suggested stay with itinerary pace', async () => {
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { pace: 'relaxed' } },
        proposedStops: [stop('target', 'new-poi', 'pending', NOW, 10)],
        proposal: { type: 'replace', payload: { stopId: 'target', newPoiId: 'new-poi' } },
        now: NOW,
        loadPois: loader([poi('new-poi', [118.1, 32.1], 30)]),
        routeBetween: async (from, to, mode) => topologyRoute(from, to, mode)
    });

    assert.strictEqual(rebuilt[0].plannedArrive.toISOString(), '2026-07-21T09:01:00.000Z');
    assert.strictEqual(rebuilt[0].plannedLeave.toISOString(), '2026-07-21T09:40:00.000Z');
});

test('all route modes reject unavailable, direct, non-authoritative, and unmarked routes with 8204', async () => {
    const base = {
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])])
    };

    const cases = [
        null,
        { routeFound: false },
        { routeFound: true, available: false },
        { routeFound: true, available: true, authoritative: false },
        {
            routeFound: true,
            available: true,
            authoritative: true,
            routeKind: 'direct-estimate',
            gis: { source: 'direct-estimate' }
        },
        {
            routeFound: true,
            available: true,
            authoritative: true,
            durationSec: 60,
            distanceM: 80,
            geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
            gis: { source: 'iserver', mode: 'normal', dataVersion: 'v1' }
        }
    ];

    for (const [preferences, mode] of [
        [{}, 'normal'],
        [{ shadeFirst: true }, 'shade'],
        [{ accessible: true }, 'accessible']
    ]) {
        for (const result of cases) {
            await assert.rejects(
                rebuildTimeline({
                    ...base,
                    itinerary: { ...base.itinerary, preferences },
                    routeBetween: async () => result
                }),
                error => error instanceof SuperMapError
                    && error.code === 8204
                    && error.httpStatus === 422
                    && error.retryable === false,
                `${mode} must reject ${JSON.stringify(result)}`
            );
        }
    }
});

test('accessible mode preserves a verified local fallback route', async () => {
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { accessible: true } },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])]),
        routeBetween: async (from, to, mode) => topologyRoute(from, to, mode, {
            source: 'local-fallback',
            edgeId: 'verified-accessible-edge',
            requestId: 'accessible-verified',
            verifiedAccessible: true
        })
    });

    assert.equal(rebuilt[0].verifiedAccessible, true);
    assert.equal(rebuilt[0].gis.source, 'local-fallback');
    assert.deepStrictEqual(
        decodePolyline(rebuilt[0].pathGeometry),
        [[118, 32], [118.001, 32.001]]
    );
});

test('typed SuperMap route failures are preserved without TimelineRebuildError wrapping', async () => {
    const typed = new IServerTimeoutError(undefined, {
        operation: 'findPath',
        requestId: 'gis-timeout'
    });

    await assert.rejects(
        rebuildTimeline({
            itinerary: { startLocation: [118, 32], preferences: {} },
            proposedStops: [stop('a', 'poi-a')],
            now: NOW,
            loadPois: loader([poi('poi-a')]),
            routeBetween: async () => { throw typed; }
        }),
        error => error === typed
    );
});

test('accessible mode rejects an unverified topological local fallback with 8204', async () => {
    await assert.rejects(rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { accessible: true } },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])]),
        routeBetween: async (from, to, mode) => topologyRoute(from, to, mode, {
            source: 'local-fallback',
            verifiedAccessible: false
        })
    }), error => error instanceof SuperMapError
        && error.code === 8204
        && error.httpStatus === 422);
});

test('normal and shade preserve a valid topological local fallback', async () => {
    for (const preferences of [{}, { shadeFirst: true }]) {
        const rebuilt = await rebuildTimeline({
            itinerary: { startLocation: [118, 32], preferences },
            proposedStops: [stop('a', 'poi-a')],
            now: NOW,
            loadPois: loader([poi('poi-a', [118.001, 32.001])]),
            routeBetween: async (from, to, mode) => topologyRoute(from, to, mode, {
                source: 'local-fallback'
            })
        });

        assert.strictEqual(rebuilt[0].gis.source, 'local-fallback');
        assert.equal(validateRouteTopology(rebuilt[0], {
            authority: 'local-walk-graph', expectedDataVersion: 'v1'
        }).valid, true);
    }
});

test('timeline returns 8205 for mode, canonical chain, proof, and authority mismatches', async () => {
    const base = {
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])])
    };
    const valid = topologyRoute(
        { geo: { coordinates: [118, 32] } },
        { geo: { coordinates: [118.001, 32.001] } },
        'standard'
    );
    const cases = [
        { ...valid, gis: { ...valid.gis, mode: 'shade' } },
        {
            ...valid,
            segments: [{ ...valid.segments[0], toNodeId: 'broken-node' }],
            topologyProof: null
        },
        { ...valid, topologyProof: { ...valid.topologyProof, digest: 'sha256:broken' } },
        {
            ...valid,
            gis: { ...valid.gis, source: 'local-fallback' }
        }
    ];

    for (const result of cases) {
        await assert.rejects(
            rebuildTimeline({ ...base, routeBetween: async () => result }),
            error => error instanceof SuperMapError
                && error.code === 8205
                && error.httpStatus === 409
        );
    }
});
