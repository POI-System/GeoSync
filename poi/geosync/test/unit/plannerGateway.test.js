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

const ExternalPoi = {
    find() {
        return { lean: async () => fixturePois.map(poi => structuredClone(poi)) };
    }
};

const PhotoSpot = {
    find() {
        return {
            sort() { return this; },
            async lean() { return []; }
        };
    }
};

const Checkin = {
    async aggregate() {
        return [];
    }
};

const Campaign = {
    find() {
        return { lean: async () => [] };
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

function poi(id, coordinates, stayMin) {
    return {
        _id: id,
        poiName: id,
        category: 'history',
        geo: { type: 'Point', coordinates },
        visitMeta: { suggestedStayMin: stayMin, tags: [] }
    };
}

function idOf(value) {
    return value?._id || 'start';
}

function route({
    coordinates,
    durationSec,
    distanceM,
    source = 'iserver',
    edgeId,
    snap,
    verifiedAccessible
}) {
    return {
        durationSec,
        walkSec: 9999,
        distanceM,
        geometry: { type: 'LineString', coordinates },
        segments: [{ edgeId, distanceM, durationSec }],
        snap,
        gis: {
            source,
            mode: 'ignored-by-planner',
            degraded: source !== 'iserver',
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
        return {
            walkSec: estimateSeconds.get(key) ?? 600,
            coords: [from.geo.coordinates, to.geo.coordinates],
            fallback: false
        };
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
    assert.deepEqual(result.stops[0].snap, { startDistanceM: 1, endDistanceM: 2 });
    assert.deepEqual(decodePolyline(result.stops[0].pathGeometry), [[0, 0], [0.001, 0]]);

    assert.equal(result.route.distanceM, 300);
    assert.equal(result.route.durationSec, 240);
    assert.deepEqual(result.route.geometry.coordinates, [
        [0, 0], [0.001, 0], [0.0015, 0], [0.002, 0]
    ]);
    assert.deepEqual(result.route.segments.map(segment => segment.edgeId), ['edge-1', 'edge-2']);
    assert.deepEqual(result.route.snap, { startDistanceM: 1, endDistanceM: 4 });
    assert.equal(result.route.gis.source, 'cache');
    assert.equal(result.route.gis.degraded, true);
    assert.equal(result.route.gis.durationMs, 30);
    assert.equal(result.route.gis.mode, 'normal');
    assert.deepEqual(decodePolyline(result.route.pathGeometry), result.route.geometry.coordinates);
});

test('mode selection preserves accessible over shade, then shade, then normal', async () => {
    fixturePois = [poi('poi-a', [0.001, 0], 10)];
    const estimateBetween = (from, to) => ({
        walkSec: 60,
        coords: [from.geo.coordinates, to.geo.coordinates],
        fallback: false
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
        estimateBetween: (from, to) => ({
            walkSec: 60,
            coords: [from.geo.coordinates, to.geo.coordinates],
            fallback: false
        }),
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
            estimateBetween: (from, to) => ({
                walkSec: 60,
                coords: [from.geo.coordinates, to.geo.coordinates],
                fallback: false
            }),
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
                estimateBetween: (from, to) => ({
                    walkSec: 60,
                    coords: [from.geo.coordinates, to.geo.coordinates],
                    fallback: false
                }),
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

    const timeline = planner.buildTimeline(
        [to],
        [0, 0],
        new Date('2026-08-02T01:00:00.000Z'),
        1,
        'normal'
    );
    assert.ok(Array.isArray(timeline));
    assert.equal(typeof timeline.then, 'undefined');
    assert.equal(
        timeline[0].plannedArrive.getTime(),
        new Date('2026-08-02T01:00:00.000Z').getTime() + estimate.walkSec * 1000
    );
    assert.deepEqual(decodePolyline(timeline[0].polyline), [[0, 0], [0.001, 0]]);
});
