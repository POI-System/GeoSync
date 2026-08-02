'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decodePolyline } = require('../../lib/geo');
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
            return { walkSec: 60, pathGeometry: 'fresh-path', fallback: false };
        }
    });

    assert.deepStrictEqual(calls[0].from.geo.coordinates, [118.5, 32.5]);
    assert.strictEqual(calls[0].from._timelineAnchor, 'lastPosition');
    assert.strictEqual(calls[0].mode, 'standard');
    assert.strictEqual(rebuilt[4].plannedArrive.toISOString(), '2026-07-21T09:11:00.000Z');
    assert.strictEqual(rebuilt[4].pathGeometry, 'fresh-path');
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
    const routeBetween = async from => {
        seen.push(from._id || from._timelineAnchor);
        return { walkSec: 0, pathGeometry: '', fallback: false };
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
    const routes = [
        {
            durationSec: 120,
            walkSec: 9999,
            distanceM: 140,
            geometry: {
                type: 'LineString',
                coordinates: [[118, 32], [118.001, 32.001]]
            },
            segments: [{ edgeId: 'edge-a', distanceM: 140, durationSec: 120 }],
            snap: { startDistanceM: 1, endDistanceM: 2 },
            gis: {
                source: 'iserver', mode: 'shade', degraded: false,
                requestId: 'gis-a', durationMs: 10, dataVersion: 'v1'
            }
        },
        {
            durationSec: 180,
            walkSec: 9999,
            distanceM: 220,
            geometry: {
                type: 'LineString',
                coordinates: [[118.001, 32.001], [118.002, 32.002]]
            },
            segments: [{ edgeId: 'edge-b', distanceM: 220, durationSec: 180 }],
            snap: { startDistanceM: 3, endDistanceM: 4 },
            gis: {
                source: 'cache', mode: 'shade', degraded: true,
                requestId: 'gis-b', durationMs: 5, dataVersion: 'v1'
            }
        }
    ];
    const calls = [];
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { shadeFirst: true } },
        proposedStops: [
            stop('a', 'poi-a', 'pending', '2026-07-21T12:00:00.000Z', 10),
            stop('b', 'poi-b', 'approaching', '2026-07-21T13:00:00.000Z', 20)
        ],
        now: NOW,
        loadPois: loader([poi('poi-a'), poi('poi-b')]),
        routeBetween: async (from, to, mode) => {
            calls.push({ from: from._id || from._timelineAnchor, to: to._id, mode });
            return routes.shift();
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
    assert.deepStrictEqual(rebuilt[0].snap, { startDistanceM: 1, endDistanceM: 2 });
    assert.strictEqual(rebuilt[1].gis.source, 'cache');
    assert.deepStrictEqual(
        decodePolyline(rebuilt[0].pathGeometry),
        [[118, 32], [118.001, 32.001]]
    );
    assert.deepStrictEqual(rebuilt.map(item => item.state), ['approaching', 'pending']);
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
        loadPois: loader([poi('poi-current'), poi('poi-a'), poi('poi-b')]),
        routeBetween: async () => ({ walkSec: 60, pathGeometry: 'route', fallback: false })
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
        loadPois: loader([poi('poi-a'), poi('poi-b')]),
        routeBetween: async () => ({ walkSec: 5 * 60, pathGeometry: 'route', fallback: false })
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
        routeBetween: async () => ({ walkSec: 60, pathGeometry: 'new-route', fallback: false })
    });

    assert.strictEqual(rebuilt[0].plannedArrive.toISOString(), '2026-07-21T09:01:00.000Z');
    assert.strictEqual(rebuilt[0].plannedLeave.toISOString(), '2026-07-21T09:40:00.000Z');
});

test('accessible mode rejects unavailable and unverified fallback routes', async () => {
    const base = {
        itinerary: { startLocation: [118, 32], preferences: { accessible: true } },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a')])
    };

    await assert.rejects(
        rebuildTimeline({ ...base, routeBetween: async () => null }),
        error => error instanceof TimelineRebuildError && error.code === 'ACCESSIBLE_ROUTE_UNAVAILABLE'
    );

    for (const result of [
        { walkSec: 60, pathGeometry: 'direct', fallback: true },
        {
            durationSec: 60,
            distanceM: 80,
            geometry: { type: 'LineString', coordinates: [[118, 32], [118.001, 32.001]] },
            gis: { source: 'local-fallback', requestId: 'accessible-request' }
        }
    ]) {
        await assert.rejects(
            rebuildTimeline({ ...base, routeBetween: async () => result }),
            error => error instanceof SuperMapError
                && error.code === 8204
                && error.httpStatus === 422
                && error.retryable === false
        );
    }
});

test('accessible mode preserves a verified local fallback route', async () => {
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: { accessible: true } },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a', [118.001, 32.001])]),
        routeBetween: async () => ({
            durationSec: 60,
            distanceM: 80,
            geometry: {
                type: 'LineString',
                coordinates: [[118, 32], [118.001, 32.001]]
            },
            segments: [{ edgeId: 'verified-accessible-edge', distanceM: 80, durationSec: 60 }],
            snap: { startDistanceM: 0, endDistanceM: 0 },
            gis: {
                source: 'local-fallback', mode: 'accessible', degraded: true,
                requestId: 'accessible-verified', durationMs: 5, dataVersion: 'v1'
            },
            verifiedAccessible: true,
            accessibleVerified: true
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

test('standard mode accepts an explicit fallback route', async () => {
    const rebuilt = await rebuildTimeline({
        itinerary: { startLocation: [118, 32], preferences: {} },
        proposedStops: [stop('a', 'poi-a')],
        now: NOW,
        loadPois: loader([poi('poi-a')]),
        routeBetween: async () => ({ walkSec: 90, pathGeometry: 'direct', fallback: true })
    });

    assert.strictEqual(rebuilt[0].plannedArrive.toISOString(), '2026-07-21T09:01:30.000Z');
    assert.strictEqual(rebuilt[0].pathGeometry, 'direct');
});
