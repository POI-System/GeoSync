'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createLocalPathSource,
    createRouteBetween
} = require('../../services/gisRouting');

test('routing adapter factories reject missing dependencies and scenic identity', () => {
    assert.throws(() => createLocalPathSource(), TypeError);
    assert.throws(() => createLocalPathSource({}), TypeError);
    assert.throws(() => createRouteBetween(), TypeError);
    assert.throws(() => createRouteBetween({ findPath() {}, findPathWithBarriers() {} }), TypeError);
});

test('local path source validates canonical input and delegates without inventing a route', async () => {
    const calls = [];
    const expected = {
        routeFound: true,
        geometry: { type: 'LineString', coordinates: [[120, 30], [120.1, 30.1]] }
    };
    const source = createLocalPathSource({
        findLocalPath(input) {
            calls.push(input);
            return expected;
        }
    });
    const input = {
        start: [120, 30],
        end: [120.1, 30.1],
        mode: 'normal',
        barriers: [{ edgeId: 'E-1' }],
        startNodeId: 'A',
        endNodeId: 'B',
        requestId: 'route-1'
    };

    assert.strictEqual(await source(input), expected);
    assert.deepStrictEqual(calls, [input]);

    const unavailable = createLocalPathSource({ findLocalPath: () => null });
    assert.strictEqual(await unavailable({
        start: [120, 30], end: [120.1, 30.1], mode: 'shade', barriers: []
    }), null);
});

test('local path source rejects invalid canonical inputs before calling walkGraph', async () => {
    let calls = 0;
    const source = createLocalPathSource({ findLocalPath: () => { calls++; } });

    for (const input of [
        null,
        { start: null, end: [120, 30], mode: 'normal' },
        { start: [120, 30], end: [999, 30], mode: 'normal' },
        { start: [120, 30], end: [120.1, 30.1], mode: 'flying' },
        { start: [120, 30], end: [120.1, 30.1], mode: 'normal', barriers: {} }
    ]) {
        await assert.rejects(source(input), TypeError);
    }
    assert.equal(calls, 0);
});

test('routeBetween converts POI and anchor coordinates, maps standard mode, and preserves result identity', async () => {
    const calls = [];
    const expected = { distanceM: 100, durationSec: 80, gis: { source: 'iserver' } };
    const routeBetween = createRouteBetween({
        async findPath(input) {
            calls.push({ method: 'findPath', input });
            return expected;
        },
        async findPathWithBarriers(input) {
            calls.push({ method: 'findPathWithBarriers', input });
            return expected;
        }
    }, { scenicId: 'test-scenic' });

    const result = await routeBetween(
        { gateNodeId: 'GATE_A', location: { lng: 120, lat: 30 } },
        { gateNodeId: 'GATE_B', geo: { type: 'Point', coordinates: [120.1, 30.1] } },
        'standard',
        { requestId: 'route-42' }
    );

    assert.strictEqual(result, expected);
    assert.deepStrictEqual(calls, [{
        method: 'findPath',
        input: {
            start: [120, 30],
            end: [120.1, 30.1],
            mode: 'normal',
            scenicId: 'test-scenic',
            barriers: [],
            startNodeId: 'GATE_A',
            endNodeId: 'GATE_B',
            requestId: 'route-42'
        }
    }]);
});

test('routeBetween accepts anchor coordinate shapes and only uses barrier routing for a nonempty set', async () => {
    const calls = [];
    const gateway = {
        async findPath(input) {
            calls.push({ method: 'findPath', input });
            return { method: 'findPath' };
        },
        async findPathWithBarriers(input) {
            calls.push({ method: 'findPathWithBarriers', input });
            return { method: 'findPathWithBarriers' };
        }
    };
    const routeBetween = createRouteBetween(gateway, { scenicId: 'test-scenic' });

    await routeBetween([120, 30], { coordinates: [120.1, 30.1] }, 'shade', []);
    await routeBetween(
        { lng: 120, lat: 30 },
        { location: { lng: 120.1, lat: 30.1 } },
        'accessible',
        { barriers: [{ edgeId: 'E-2' }, { edgeId: 'E-1' }], requestId: 'barrier-route' }
    );

    assert.equal(calls[0].method, 'findPath');
    assert.deepStrictEqual(calls[0].input.barriers, []);
    assert.equal(calls[0].input.mode, 'shade');
    assert.equal(calls[1].method, 'findPathWithBarriers');
    assert.deepStrictEqual(calls[1].input.barriers, [{ edgeId: 'E-2' }, { edgeId: 'E-1' }]);
    assert.equal(calls[1].input.requestId, 'barrier-route');
    assert.equal(calls[1].input.mode, 'accessible');
});

test('routeBetween rejects invalid endpoints, modes, and barrier context without calling Gateway', async () => {
    let calls = 0;
    const routeBetween = createRouteBetween({
        async findPath() { calls++; },
        async findPathWithBarriers() { calls++; }
    }, { scenicId: 'test-scenic' });

    for (const args of [
        [{}, [120, 30], 'normal'],
        [[120, 30], [120], 'normal'],
        [[120, 30], [120.1, 30.1], 'teleport'],
        [[120, 30], [120.1, 30.1], 'normal', { barriers: {} }],
        [[120, 30], [120.1, 30.1], 'normal', 'invalid-context']
    ]) {
        await assert.rejects(routeBetween(...args), TypeError);
    }
    assert.equal(calls, 0);
});
