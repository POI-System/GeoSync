'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modelModule = require('../../models');
const forecast = require('../../services/forecastService');
const sunlight = require('../../services/sunlight');
const { decodePolyline, haversine } = require('../../lib/geo');

const originalGetModels = modelModule.getModels;
const originalPredictAtEta = forecast.predictAtEta;
const originalWindowFit = sunlight.windowFit;

let fixturePois = [];
let onCandidateQuery = async () => {};

const ExternalPoi = {
    find() {
        return {
            async lean() {
                await onCandidateQuery('ExternalPoi');
                return fixturePois.map(poi => structuredClone(poi));
            }
        };
    }
};

const PhotoSpot = {
    find() {
        return {
            sort() { return this; },
            async lean() {
                await onCandidateQuery('PhotoSpot');
                return [];
            }
        };
    }
};

const Checkin = {
    async aggregate() {
        await onCandidateQuery('Checkin');
        return [];
    }
};

const Campaign = {
    find() {
        return {
            async lean() {
                await onCandidateQuery('Campaign');
                return [];
            }
        };
    }
};

modelModule.getModels = () => ({ ExternalPoi, PhotoSpot, Checkin, Campaign });
forecast.predictAtEta = () => 0.3;
sunlight.windowFit = () => 0.5;

delete require.cache[require.resolve('../../services/planner')];
const planner = require('../../services/planner');

test.after(() => {
    modelModule.getModels = originalGetModels;
    forecast.predictAtEta = originalPredictAtEta;
    sunlight.windowFit = originalWindowFit;
});

test.afterEach(() => {
    onCandidateQuery = async () => {};
});

function poi(id, coordinates, stayMin) {
    return {
        _id: id,
        poiName: id,
        category: 'history',
        geo: { type: 'Point', coordinates },
        visitMeta: { suggestedStayMin: stayMin, tags: [] }
    };
}

test('planner preserves zero stay time and falls back through dwell metadata', () => {
    assert.equal(planner.suggestedStayMinutes({
        visitMeta: { suggestedStayMin: 0, dwellMin: 15 }
    }), 0);
    assert.equal(planner.suggestedStayMinutes({
        visitMeta: { suggestedStayMin: null, dwellMin: 15 }
    }), 15);
    assert.equal(planner.suggestedStayMinutes({ visitMeta: {} }), 20);
});

function idOf(value) {
    return value?._id || 'start';
}

function nodeIdFor(coordinate) {
    return `node:${coordinate[0]}:${coordinate[1]}`;
}

function route({
    coordinates,
    durationSec,
    distanceM,
    source = 'iserver',
    degraded,
    edgeId,
    snap,
    verifiedAccessible
}) {
    const fromNodeId = nodeIdFor(coordinates[0]);
    const toNodeId = nodeIdFor(coordinates[coordinates.length - 1]);
    return {
        available: true,
        authoritative: true,
        routeFound: true,
        routeKind: 'topology',
        topology: true,
        durationSec,
        walkSec: 9999,
        distanceM,
        geometry: { type: 'LineString', coordinates },
        nodeIds: [fromNodeId, toNodeId],
        edgeIds: [edgeId],
        segments: [{
            edgeId,
            fromNodeId,
            toNodeId,
            distanceM,
            durationSec,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1 }
        }],
        snap,
        gis: {
            source,
            mode: 'ignored-by-planner',
            degraded: degraded ?? source !== 'iserver',
            requestId: 'gis-test',
            durationMs: source === 'iserver' ? 10 : 20,
            dataVersion: 'v1'
        },
        ...(verifiedAccessible === undefined ? {} : {
            verifiedAccessible,
            accessibleVerified: verifiedAccessible
        })
    };
}

function authoritativeEstimate(from, to, walkSec, extra = {}) {
    const fromNodeId = nodeIdFor(from.geo.coordinates);
    const toNodeId = nodeIdFor(to.geo.coordinates);
    const dataVersion = extra.gis?.dataVersion
        || (Array.isArray(extra.edgeDataVersions) && extra.edgeDataVersions[0])
        || 'v1';
    const edgeId = Array.isArray(extra.edgeIds) && extra.edgeIds.length === 1
        ? extra.edgeIds[0]
        : `estimate-edge-${idOf(from)}-${idOf(to)}`;
    return {
        walkSec,
        durationSec: walkSec,
        distanceM: walkSec,
        coords: [from.geo.coordinates, to.geo.coordinates],
        geometry: { type: 'LineString', coordinates: [from.geo.coordinates, to.geo.coordinates] },
        nodeIds: [fromNodeId, toNodeId],
        edgeIds: [edgeId],
        edgeDataVersions: [dataVersion],
        segments: [{
            edgeId,
            fromNodeId,
            toNodeId,
            distanceM: walkSec,
            durationSec: walkSec,
            sourceRef: { datasetName: 'WalkEdge@Test', smId: 1 }
        }],
        gis: {
            source: 'iserver',
            mode: extra.gis?.mode || 'normal',
            dataVersion,
            ...(extra.gis || {})
        },
        fallback: false,
        authoritative: true,
        routeFound: true,
        available: true,
        routeKind: 'graph',
        topology: true,
        ...extra,
        gis: {
            source: 'iserver',
            mode: extra.gis?.mode || 'normal',
            dataVersion,
            ...(extra.gis || {})
        }
    };
}

test('planner rejects an invalid startAt before querying candidates', async () => {
    fixturePois = [poi('poi-a', [0.001, 0], 10)];
    let queryCount = 0;
    onCandidateQuery = async () => { queryCount++; };

    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: 'not-a-date',
            hours: 2,
            openId: 'user-invalid-start-at'
        }, {
            estimateBetween: () => ({ walkSec: 60 }),
            routeBetween: async () => {
                throw new Error('routeBetween must not run');
            }
        }),
        error => error.code === 1102 && error.httpStatus === 400
    );
    assert.equal(queryCount, 0);
});

test('plan uses synchronous estimates for optimization and one authoritative route per final leg', async () => {
    fixturePois = [
        poi('poi-a', [0.001, 0], 10),
        poi('poi-b', [0.002, 0], 20)
    ];
    const estimateCalls = [];
    const estimateSeconds = new Map([
        ['start:poi-a', 60],
        ['start:poi-b', 600],
        ['poi-a:poi-b', 60],
        ['poi-b:poi-a', 600]
    ]);
    const estimateBetween = (from, to, mode) => {
        const key = `${idOf(from)}:${idOf(to)}`;
        estimateCalls.push({ key, mode });
        return authoritativeEstimate(from, to, estimateSeconds.get(key) ?? 600);
    };

    const routeCalls = [];
    const routeBetween = async (from, to, mode, context) => {
        routeCalls.push({ from: idOf(from), to: idOf(to), mode, context });
        if (context.legIndex === 0) {
            return route({
                coordinates: [[0, 0], [0.001, 0]],
                durationSec: 90,
                distanceM: 100,
                edgeId: 'edge-1',
                snap: { startDistanceM: 1, endDistanceM: 2 }
            });
        }
        return route({
            coordinates: [[0.001, 0], [0.0015, 0], [0.002, 0]],
            durationSec: 150,
            distanceM: 200,
            source: 'cache',
            degraded: false,
            edgeId: 'edge-2',
            snap: { startDistanceM: 3, endDistanceM: 4 }
        });
    };

    const result = await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 2,
        interests: [],
        pace: 'normal',
        openId: 'user-1',
        requestId: 'request-1'
    }, { estimateBetween, routeBetween });

    assert.deepEqual(result.stops.map(stop => stop.poiId), ['poi-a', 'poi-b']);
    assert.equal(routeCalls.length, result.stops.length);
    assert.ok(estimateCalls.length > routeCalls.length);
    assert.deepEqual(routeCalls.map(call => [call.from, call.to]), [
        ['start', 'poi-a'],
        ['poi-a', 'poi-b']
    ]);
    assert.ok(routeCalls.every(call => call.mode === 'normal'));
    assert.deepEqual(routeCalls.map(call => call.context.legIndex), [0, 1]);
    assert.ok(routeCalls.every(call => call.context.requestId === 'request-1'));

    assert.equal(result.stops[0].plannedArrive.toISOString(), '2026-08-02T01:01:30.000Z');
    assert.equal(result.stops[0].plannedLeave.toISOString(), '2026-08-02T01:11:30.000Z');
    assert.equal(result.stops[1].plannedArrive.toISOString(), '2026-08-02T01:14:00.000Z');
    assert.equal(result.stops[1].plannedLeave.toISOString(), '2026-08-02T01:34:00.000Z');
    assert.equal(result.totalWalkMin, 4);

    assert.deepEqual(result.stops[0].geometry.coordinates, [[0, 0], [0.001, 0]]);
    assert.equal(result.stops[0].distanceM, 100);
    assert.equal(result.stops[0].durationSec, 90);
    assert.equal(result.stops[0].segments[0].edgeId, 'edge-1');
    assert.deepEqual(result.stops[0].snap, {
        startDistanceM: 1,
        endDistanceM: 2,
        startNodeId: 'node:0:0',
        endNodeId: 'node:0.001:0'
    });
    assert.deepEqual(decodePolyline(result.stops[0].pathGeometry), [[0, 0], [0.001, 0]]);

    assert.equal(result.route.distanceM, 300);
    assert.equal(result.route.durationSec, 240);
    assert.deepEqual(result.route.geometry.coordinates, [
        [0, 0], [0.001, 0], [0.0015, 0], [0.002, 0]
    ]);
    assert.deepEqual(result.route.segments.map(segment => segment.edgeId), ['edge-1', 'edge-2']);
    assert.deepEqual(result.route.snap, {
        startDistanceM: 1,
        endDistanceM: 4,
        startNodeId: 'node:0:0',
        endNodeId: 'node:0.002:0'
    });
    assert.equal(result.route.gis.source, 'cache');
    assert.equal(result.route.gis.degraded, true);
    assert.equal(result.route.gis.durationMs, 30);
    assert.equal(result.route.gis.mode, 'normal');
    assert.deepEqual(decodePolyline(result.route.pathGeometry), result.route.geometry.coordinates);
});

test('planner final legs reject unproven straight lines and accept canonical topology routes', async t => {
    const order = [poi('poi-provenance', [0.001, 0], 10)];
    const argumentsFor = routeBetween => [
        order,
        [0, 0],
        new Date('2026-08-02T01:00:00.000Z'),
        1,
        'normal',
        { requestId: 'planner-provenance', routeBetween }
    ];

    await t.test('missing provenance', async () => {
        await assert.rejects(
            planner.buildAuthoritativeTimeline(...argumentsFor(async () => ({
                durationSec: 60,
                walkSec: 60,
                distanceM: 80,
                geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
                segments: [],
                snap: { startDistanceM: 0, endDistanceM: 0 },
                gis: { source: 'iserver', mode: 'normal', dataVersion: 'v1' },
                available: true,
                authoritative: true,
                routeFound: true,
                routeKind: 'topology',
                topology: true
            }))),
            error => error.code === 8205 && error.httpStatus === 409
        );
    });

    await t.test('canonical chain', async () => {
        const result = await planner.buildAuthoritativeTimeline(...argumentsFor(async () => route({
            coordinates: [[0, 0], [0.001, 0]],
            durationSec: 60,
            distanceM: 80,
            edgeId: 'planner-proof-edge',
            snap: { startDistanceM: 0, endDistanceM: 0 }
        })));
        assert.equal(result.timeline.length, 1);
        assert.deepEqual(result.timeline[0].nodeIds, ['node:0:0', 'node:0.001:0']);
        assert.match(result.timeline[0].topologyProof.digest, /^sha256:[a-f0-9]{64}$/);
        assert.equal(result.route.topologyProof.authority, 'planner-aggregate');
    });

    await t.test('missing explicit authority marker', async () => {
        const candidate = route({
            coordinates: [[0, 0], [0.001, 0]],
            durationSec: 60,
            distanceM: 80,
            edgeId: 'planner-marker-edge',
            snap: { startDistanceM: 0, endDistanceM: 0 }
        });
        delete candidate.authoritative;
        await assert.rejects(
            planner.buildAuthoritativeTimeline(...argumentsFor(async () => candidate)),
            error => error.code === 8204 && error.httpStatus === 422
        );
    });

    await t.test('target gate does not match topology endpoint', async () => {
        const gatedPoi = { ...poi('poi-gated', [0.001, 0], 10), gateNodeId: 'EXPECTED_GATE' };
        await assert.rejects(
            planner.buildAuthoritativeTimeline(
                [gatedPoi],
                [0, 0],
                new Date('2026-08-02T01:00:00.000Z'),
                1,
                'normal',
                {
                    requestId: 'planner-gate-mismatch',
                    routeBetween: async () => route({
                        coordinates: [[0, 0], [0.001, 0]],
                        durationSec: 60,
                        distanceM: 80,
                        edgeId: 'planner-wrong-gate-edge',
                        snap: { startDistanceM: 0, endDistanceM: 0 }
                    })
                }
            ),
            error => error.code === 8205 && error.httpStatus === 409
        );
    });
});

test('planner accepts only an exact same-node zero leg as the empty-segment exception', async t => {
    const samePointPoi = poi('poi-zero', [0, 0], 0);
    const zeroRoute = {
        durationSec: 0,
        walkSec: 0,
        distanceM: 0,
        geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0]] },
        nodeIds: ['NODE_ZERO'],
        edgeIds: [],
        segments: [],
        snap: {
            startNodeId: 'NODE_ZERO',
            endNodeId: 'NODE_ZERO',
            startDistanceM: 0,
            endDistanceM: 0
        },
        gis: { source: 'iserver', mode: 'normal', dataVersion: 'v1' },
        available: true,
        authoritative: true,
        routeFound: true,
        routeKind: 'topology',
        topology: true
    };
    const result = await planner.buildAuthoritativeTimeline(
        [samePointPoi],
        [0, 0],
        new Date('2026-08-02T01:00:00.000Z'),
        1,
        'normal',
        { requestId: 'planner-zero', routeBetween: async () => zeroRoute }
    );
    assert.equal(result.timeline[0].durationSec, 0);
    assert.deepEqual(result.timeline[0].segments, []);
    assert.equal(result.timeline[0].topologyProof.kind, 'same-node-zero-leg');

    await t.test('zero metrics with moving geometry', async () => {
        await assert.rejects(
            planner.buildAuthoritativeTimeline(
                [poi('poi-invalid-zero', [0.001, 0], 0)],
                [0, 0],
                new Date('2026-08-02T01:00:00.000Z'),
                1,
                'normal',
                {
                    requestId: 'planner-invalid-zero',
                    routeBetween: async () => ({
                        ...zeroRoute,
                        geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] }
                    })
                }
            ),
            error => error.code === 8205 && error.httpStatus === 409
        );
    });
});

test('planner starts its optimization budget after all candidate queries are ready', async () => {
    fixturePois = [poi('poi-slow-db', [0.001, 0], 10)];
    const queryOrder = [];
    let elapsedMs = 0;
    onCandidateQuery = async modelName => {
        queryOrder.push(modelName);
        elapsedMs += 1000;
    };
    const budgetReadings = [];

    const result = await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 1,
        requestId: 'slow-candidate-queries'
    }, {
        budgetNow() {
            budgetReadings.push(elapsedMs);
            return elapsedMs;
        },
        estimateBetween: (from, to) => authoritativeEstimate(from, to, 60),
        routeBetween: async (from, to) => route({
            coordinates: [from.geo.coordinates, to.geo.coordinates],
            durationSec: 60,
            distanceM: 80,
            edgeId: 'slow-db-edge',
            snap: { startDistanceM: 0, endDistanceM: 0 }
        })
    });

    assert.deepEqual(queryOrder, ['ExternalPoi', 'Checkin', 'Campaign', 'PhotoSpot']);
    assert.ok(budgetReadings.length >= 2);
    assert.equal(budgetReadings[0], 4000);
    assert.deepEqual(result.stops.map(stop => stop.poiId), ['poi-slow-db']);
});

test('planner returns 8204 when every ready candidate is topologically unreachable', async () => {
    fixturePois = [poi('poi-unroutable', [0.001, 0], 10)];
    let authoritativeCalls = 0;

    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            requestId: 'unroutable-candidate'
        }, {
            budgetNow: () => 0,
            estimateBetween: () => null,
            routeBetween: async () => {
                authoritativeCalls++;
                throw new Error('must not request an authoritative route');
            }
        }),
        error => error.code === 8204 && error.httpStatus === 422
    );
    assert.equal(authoritativeCalls, 0);
});

test('planner treats explicit no-path estimate shapes as 8204', async () => {
    fixturePois = [poi('poi-no-path-shape', [0.001, 0], 10)];
    const cases = [
        { routeFound: false },
        {
            walkSec: 60,
            routeFound: true,
            available: true,
            authoritative: true,
            routeKind: 'direct-estimate',
            gis: { source: 'direct-estimate', mode: 'normal' }
        },
        {
            walkSec: 60,
            routeFound: true,
            available: true,
            authoritative: true,
            gis: { source: 'iserver', mode: 'normal', dataVersion: 'v1' }
        }
    ];

    for (const estimate of cases) {
        await assert.rejects(
            planner.plan({
                startLocation: [0, 0],
                startAt: '2026-08-02T01:00:00.000Z',
                hours: 1,
                requestId: 'no-path-shapes'
            }, {
                budgetNow: () => 0,
                estimateBetween: () => estimate,
                routeBetween: async () => {
                    throw new Error('no-path estimates must not reach final routing');
                }
            }),
            error => error.code === 8204 && error.httpStatus === 422
        );
    }
});

test('planner preserves 1202 when a reachable candidate is over budget and another is unreachable', async () => {
    fixturePois = [
        poi('poi-over-budget', [0.001, 0], 55),
        poi('poi-unreachable', [0.002, 0], 10)
    ];

    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            requestId: 'mixed-budget-no-path'
        }, {
            budgetNow: () => 0,
            estimateBetween: (from, to) => to._id === 'poi-over-budget'
                ? authoritativeEstimate(from, to, 10 * 60)
                : { routeFound: false },
            routeBetween: async () => {
                throw new Error('no candidate fits the budget');
            }
        }),
        error => error.code === 1202
    );
});

test('planner preserves 1202 when every candidate is closed at the planning time', async () => {
    fixturePois = [{
        ...poi('poi-closed', [0.001, 0], 10),
        visitMeta: {
            suggestedStayMin: 10,
            tags: [],
            openHours: [{ start: '08:00', end: '09:00' }]
        }
    }];
    let estimateCalls = 0;

    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T05:00:00.000Z',
            hours: 1,
            requestId: 'all-closed'
        }, {
            budgetNow: () => 0,
            estimateBetween: () => {
                estimateCalls++;
                return null;
            },
            routeBetween: async () => {
                throw new Error('closed candidates must not reach final routing');
            }
        }),
        error => error.code === 1202
    );
    assert.equal(estimateCalls, 0);
});

test('planner skips a geometrically near but topologically unreachable POI', async () => {
    fixturePois = [
        poi('poi-near-unreachable', [0.0001, 0], 10),
        poi('poi-far-reachable', [0.01, 0], 10)
    ];
    const routeCalls = [];
    const result = await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 1,
        requestId: 'topology-unreachable'
    }, {
        estimateBetween: (from, to) => to._id === 'poi-near-unreachable'
            ? {
                walkSec: 5,
                coords: [from.geo.coordinates, to.geo.coordinates],
                fallback: true,
                authoritative: false,
                routeFound: false,
                routeKind: 'direct-estimate'
            }
            : authoritativeEstimate(from, to, 120),
        routeBetween: async (from, to) => {
            routeCalls.push(idOf(to));
            return route({
                coordinates: [from.geo.coordinates, to.geo.coordinates],
                durationSec: 120,
                distanceM: 160,
                edgeId: 'reachable-edge',
                snap: { startDistanceM: 0, endDistanceM: 0 }
            });
        }
    });

    assert.deepEqual(result.stops.map(stop => stop.poiId), ['poi-far-reachable']);
    assert.deepEqual(routeCalls, ['poi-far-reachable']);
});

test('planner falls back to a reachable in-budget candidate when a preferred candidate exceeds topology cost', async () => {
    fixturePois = [
        {
            ...poi('poi-preferred-over-budget', [0.001, 0], 10),
            visitMeta: { suggestedStayMin: 10, tags: ['photo'] }
        },
        poi('poi-reachable-budget', [0.02, 0], 10)
    ];
    const result = await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 1,
        interests: ['photo'],
        requestId: 'topology-budget-fallback'
    }, {
        estimateBetween: (from, to) => authoritativeEstimate(
            from,
            to,
            to._id === 'poi-preferred-over-budget' ? 50 * 60 : 5 * 60
        ),
        routeBetween: async (from, to) => {
            assert.equal(to._id, 'poi-reachable-budget');
            return route({
                coordinates: [from.geo.coordinates, to.geo.coordinates],
                durationSec: 5 * 60,
                distanceM: 350,
                edgeId: 'budget-reachable-edge',
                snap: { startDistanceM: 0, endDistanceM: 0 }
            });
        }
    });

    assert.deepEqual(result.stops.map(stop => stop.poiId), ['poi-reachable-budget']);
});

test('planner reuses one mode, barrier snapshot, and data version for estimates and final routes', async () => {
    fixturePois = [poi('poi-snapshot', [0.001, 0], 10)];
    const barriers = [{
        edgeId: 'edge-closed',
        sourceRef: { datasetName: 'WalkEdge@Test', smId: 9 }
    }];
    const routeContext = {
        barriers,
        barrierFingerprint: 'sha256:snapshot',
        dataVersion: 'v1'
    };
    const estimateContexts = [];
    const routeContexts = [];

    await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 1,
        shadeFirst: true,
        requestId: 'same-snapshot'
    }, {
        routeContext,
        estimateBetween(from, to, mode, context) {
            estimateContexts.push({ mode, context });
            return authoritativeEstimate(from, to, 60, {
                edgeIds: ['edge-open'],
                edgeDataVersions: ['v1'],
                gis: { mode, dataVersion: 'v1' }
            });
        },
        async routeBetween(from, to, mode, context) {
            routeContexts.push({ mode, context });
            return route({
                coordinates: [from.geo.coordinates, to.geo.coordinates],
                durationSec: 60,
                distanceM: 80,
                edgeId: 'edge-open',
                snap: { startDistanceM: 0, endDistanceM: 0 }
            });
        }
    });

    assert.ok(estimateContexts.length >= 1);
    assert.ok(estimateContexts.every(call => call.mode === 'shade'));
    assert.ok(routeContexts.every(call => call.mode === 'shade'));
    for (const call of [...estimateContexts, ...routeContexts]) {
        assert.equal(call.context.barrierFingerprint, 'sha256:snapshot');
        assert.equal(call.context.dataVersion, 'v1');
        assert.deepEqual(call.context.barriers, barriers);
    }
});

test('memoized topology estimator bounds repeated optimization lookups', async () => {
    fixturePois = [
        poi('poi-a', [0.001, 0], 10),
        poi('poi-b', [0.002, 0], 10),
        poi('poi-c', [0.003, 0], 10)
    ];
    let estimateCalls = 0;
    await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 2,
        requestId: 'memoized-estimates'
    }, {
        estimateBetween(from, to) {
            estimateCalls++;
            return authoritativeEstimate(from, to, 60);
        },
        routeBetween: async (from, to) => route({
            coordinates: [from.geo.coordinates, to.geo.coordinates],
            durationSec: 60,
            distanceM: 80,
            edgeId: `edge-${idOf(from)}-${idOf(to)}`,
            snap: { startDistanceM: 0, endDistanceM: 0 }
        })
    });

    assert.ok(estimateCalls <= 12, `expected bounded unique pair estimates, got ${estimateCalls}`);
});

test('versioned planning rejects missing, stale, and mixed topology edge versions before final routing', async () => {
    fixturePois = [poi('poi-versioned', [0.001, 0], 10)];
    for (const edgeDataVersions of [[], ['v0'], ['v1', 'v2']]) {
        let routeCalls = 0;
        await assert.rejects(
            planner.plan({
                startLocation: [0, 0],
                startAt: '2026-08-02T01:00:00.000Z',
                hours: 1,
                requestId: `invalid-version-${edgeDataVersions.join('-') || 'missing'}`
            }, {
                routeContext: {
                    barriers: [],
                    barrierFingerprint: 'sha256:empty',
                    dataVersion: 'v1'
                },
                estimateBetween(from, to) {
                    return authoritativeEstimate(from, to, 60, {
                        edgeIds: edgeDataVersions.length > 1 ? ['edge-a', 'edge-b'] : ['edge-a'],
                        edgeDataVersions
                    });
                },
                routeBetween: async () => {
                    routeCalls++;
                    throw new Error('version-invalid estimates must not reach final routing');
                }
            }),
            error => error.code === 8205 && error.httpStatus === 409
        );
        assert.equal(routeCalls, 0);
    }
});

test('planner rejects estimate mode and canonical topology mismatches with 8205', async () => {
    fixturePois = [poi('poi-contract-mismatch', [0.001, 0], 10)];
    const from = { geo: { coordinates: [0, 0] } };
    const to = fixturePois[0];
    const valid = authoritativeEstimate(from, to, 60);
    const cases = [
        { ...valid, gis: { ...valid.gis, mode: 'shade' } },
        {
            ...valid,
            segments: [{ ...valid.segments[0], toNodeId: 'broken-node' }]
        },
        {
            ...valid,
            topologyProof: {
                schema: 'geosync.topology/v1',
                authority: 'local-walk-graph',
                dataVersion: 'v1',
                kind: 'node-edge-chain',
                geometryDigest: 'sha256:broken',
                nodeIds: valid.nodeIds,
                edgeIds: valid.edgeIds,
                sourceRefs: valid.segments.map(segment => segment.sourceRef),
                segmentCount: 1,
                distanceM: valid.distanceM,
                durationSec: valid.durationSec,
                segments: valid.segments,
                digest: 'sha256:broken'
            }
        }
    ];

    for (const estimate of cases) {
        await assert.rejects(
            planner.plan({
                startLocation: [0, 0],
                startAt: '2026-08-02T01:00:00.000Z',
                hours: 1,
                requestId: 'estimate-contract-mismatch'
            }, {
                estimateBetween: () => estimate,
                routeBetween: async () => {
                    throw new Error('contract-invalid estimates must not reach final routing');
                }
            }),
            error => error.code === 8205 && error.httpStatus === 409
        );
    }
});

test('final route data version must match the planning snapshot', async () => {
    fixturePois = [poi('poi-version-mismatch', [0.001, 0], 10)];
    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            requestId: 'final-version-mismatch'
        }, {
            routeContext: {
                barriers: [],
                barrierFingerprint: 'sha256:empty',
                dataVersion: 'v1'
            },
            estimateBetween(from, to) {
                return authoritativeEstimate(from, to, 60, {
                    edgeIds: ['edge-a'],
                    edgeDataVersions: ['v1']
                });
            },
            routeBetween: async (from, to) => ({
                ...route({
                    coordinates: [from.geo.coordinates, to.geo.coordinates],
                    durationSec: 60,
                    distanceM: 80,
                    edgeId: 'edge-a',
                    snap: { startDistanceM: 0, endDistanceM: 0 }
                }),
                gis: {
                    source: 'iserver',
                    mode: 'normal',
                    degraded: false,
                    requestId: 'final-version-mismatch',
                    durationMs: 1,
                    dataVersion: 'v2'
                }
            })
        }),
        error => error.code === 8205 && error.httpStatus === 409
    );
});

test('mode selection preserves accessible over shade, then shade, then normal', async () => {
    fixturePois = [poi('poi-a', [0.001, 0], 10)];
    const estimateBetween = (from, to, mode) => authoritativeEstimate(from, to, 60, {
        gis: { mode, dataVersion: 'v1' }
    });

    async function observedMode(input) {
        const modes = [];
        await planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            ...input
        }, {
            estimateBetween,
            routeBetween: async (from, to, mode) => {
                modes.push(mode);
                return route({
                    coordinates: [from.geo.coordinates, to.geo.coordinates],
                    durationSec: 60,
                    distanceM: 80,
                    edgeId: `edge-${mode}`,
                    snap: { startDistanceM: 0, endDistanceM: 0 }
                });
            }
        });
        return modes;
    }

    assert.deepEqual(await observedMode({}), ['normal']);
    assert.deepEqual(await observedMode({ shadeFirst: true }), ['shade']);
    assert.deepEqual(await observedMode({ accessible: true, shadeFirst: true }), ['accessible']);
});

test('authoritative accessible routes reject unverified local fallback with 8204', async () => {
    const order = [poi('poi-a', [0.001, 0], 10)];
    let calls = 0;

    await assert.rejects(
        planner.buildAuthoritativeTimeline(
            order,
            [0, 0],
            new Date('2026-08-02T01:00:00.000Z'),
            1,
            'accessible',
            {
                requestId: 'accessible-request',
                routeBetween: async () => {
                    calls++;
                    return route({
                        coordinates: [[0, 0], [0.001, 0]],
                        durationSec: 60,
                        distanceM: 80,
                        source: 'local-fallback',
                        edgeId: 'fallback-edge',
                        snap: { startDistanceM: 0, endDistanceM: 0 }
                    });
                }
            }
        ),
        error => error.code === 8204
            && error.httpStatus === 422
            && error.retryable === false
            && error.requestId === 'accessible-request'
    );
    assert.equal(calls, 1);
});

test('authoritative accessible routes preserve verified local fallback', async () => {
    const order = [poi('poi-a', [0.001, 0], 10)];
    const result = await planner.buildAuthoritativeTimeline(
        order,
        [0, 0],
        new Date('2026-08-02T01:00:00.000Z'),
        1,
        'accessible',
        {
            requestId: 'accessible-verified',
            routeBetween: async () => route({
                coordinates: [[0, 0], [0.001, 0]],
                durationSec: 60,
                distanceM: 80,
                source: 'local-fallback',
                edgeId: 'verified-fallback-edge',
                snap: { startDistanceM: 0, endDistanceM: 0 },
                verifiedAccessible: true
            })
        }
    );

    assert.equal(result.timeline[0].verifiedAccessible, true);
    assert.equal(result.timeline[0].gis.source, 'local-fallback');
    assert.equal(result.route.verifiedAccessible, true);
    assert.equal(result.route.gis.source, 'local-fallback');
});

test('plan trims authoritative tail legs that exceed the itinerary budget', async () => {
    fixturePois = [
        poi('poi-a', [0.001, 0], 10),
        poi('poi-b', [0.002, 0], 10)
    ];
    const routeCalls = [];
    const result = await planner.plan({
        startLocation: [0, 0],
        startAt: '2026-08-02T01:00:00.000Z',
        hours: 1,
        openId: 'budget-user',
        requestId: 'budget-trim'
    }, {
        estimateBetween: (from, to) => authoritativeEstimate(from, to, 60),
        routeBetween: async (from, to, mode, context) => {
            routeCalls.push({ from: idOf(from), to: idOf(to), mode, context });
            return route({
                coordinates: [from.geo.coordinates, to.geo.coordinates],
                durationSec: context.legIndex === 0 ? 60 : 40 * 60,
                distanceM: context.legIndex === 0 ? 80 : 2400,
                edgeId: `budget-edge-${context.legIndex}`,
                snap: { startDistanceM: 0, endDistanceM: 0 }
            });
        }
    });

    assert.deepStrictEqual(result.stops.map(stop => stop.poiId), ['poi-a']);
    assert.equal(result.route.durationSec, 60);
    assert.deepStrictEqual(result.route.segments.map(segment => segment.edgeId), ['budget-edge-0']);
    assert.equal(result.enriched.length, 1);
    assert.equal(routeCalls.length, 2);
});

test('plan returns 1202 when the first authoritative stop cannot fit', async () => {
    fixturePois = [poi('poi-a', [0.001, 0], 10)];

    await assert.rejects(
        planner.plan({
            startLocation: [0, 0],
            startAt: '2026-08-02T01:00:00.000Z',
            hours: 1,
            requestId: 'budget-empty'
        }, {
            estimateBetween: (from, to) => authoritativeEstimate(from, to, 60),
            routeBetween: async (from, to) => route({
                coordinates: [from.geo.coordinates, to.geo.coordinates],
                durationSec: 42 * 60,
                distanceM: 2500,
                edgeId: 'over-budget-edge',
                snap: { startDistanceM: 0, endDistanceM: 0 }
            })
        }),
        error => error.code === 1202
    );
});

test('authoritative budget reconciliation includes forecast queue time', async () => {
    fixturePois = [poi('poi-crowded', [0.001, 0], 30)];
    forecast.predictAtEta = () => 0.8;

    try {
        await assert.rejects(
            planner.plan({
                startLocation: [0, 0],
                startAt: '2026-08-02T01:00:00.000Z',
                hours: 1,
                requestId: 'budget-queue'
            }, {
                estimateBetween: (from, to) => authoritativeEstimate(from, to, 60),
                routeBetween: async (from, to) => route({
                    coordinates: [from.geo.coordinates, to.geo.coordinates],
                    durationSec: 10 * 60,
                    distanceM: 700,
                    edgeId: 'queue-budget-edge',
                    snap: { startDistanceM: 0, endDistanceM: 0 }
                })
            }),
            error => error.code === 1202
        );
    } finally {
        forecast.predictAtEta = () => 0.3;
    }
});

test('default estimator is pure haversine and heuristic buildTimeline remains synchronous', () => {
    const from = { geo: { coordinates: [0, 0] } };
    const to = poi('poi-a', [0.001, 0], 10);
    const estimate = planner.defaultEstimateBetween(from, to, 'normal');
    assert.equal(estimate.walkSec, Math.round(haversine([0, 0], [0.001, 0]) / 1.4));
    assert.deepEqual(estimate.coords, [[0, 0], [0.001, 0]]);
    assert.equal(estimate.authoritative, false);
    assert.equal(estimate.routeFound, false);
    assert.equal(estimate.routeKind, 'direct-estimate');

    assert.throws(
        () => planner.buildTimeline(
            [to],
            [0, 0],
            new Date('2026-08-02T01:00:00.000Z'),
            1,
            'normal'
        ),
        error => error.code === 1201
    );
});
