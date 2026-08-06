'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
    normalizeWalkEdgeMetrics,
    normalizeWalkSec,
    normalizeDistanceM,
    normalizeSlopePct,
    normalizeUnitRatio,
    normalizeBoolean,
    normalizeLineCoordinates
} = require('../../lib/walkEdgeContract');
const { registerModels } = require('../../models');

test('walk edge scalar contract uses seconds, meters, slope percent, and unit ratios', () => {
    assert.equal(normalizeWalkSec(60), 60);
    assert.equal(normalizeWalkSec('60', { coerce: true }), 60);
    assert.equal(normalizeWalkSec(1.5), null);
    assert.equal(normalizeWalkSec(-1), null);
    assert.equal(normalizeWalkSec(Infinity), null);

    assert.equal(normalizeDistanceM(80.5), 80.5);
    assert.equal(normalizeDistanceM(-0.1), null);
    assert.equal(normalizeDistanceM(NaN), null);

    assert.equal(normalizeSlopePct(8), 8);
    assert.equal(normalizeSlopePct(0.08), 0.08);
    assert.equal(normalizeSlopePct(100), 100);
    assert.equal(normalizeSlopePct(100.1), null);
    assert.equal(normalizeSlopePct(-100.1), null);

    assert.equal(normalizeUnitRatio(0), 0);
    assert.equal(normalizeUnitRatio(1), 1);
    assert.equal(normalizeUnitRatio(-0.01), null);
    assert.equal(normalizeUnitRatio(1.01), null);
    assert.equal(normalizeBoolean('false', { coerce: true }), false);
    assert.equal(normalizeBoolean('unexpected', { coerce: true }), null);
});

test('walk edge metric contract rejects implausible time and distance units', () => {
    const valid = normalizeWalkEdgeMetrics({
        walkSec: 80,
        distanceM: 111,
        slope: 8,
        shade: 0,
        covered: 1
    }, { geometryDistanceM: 111 });
    assert.deepEqual(valid, {
        walkSec: 80,
        distanceM: 111,
        slope: 8,
        shade: 0,
        covered: 1
    });

    assert.equal(normalizeWalkEdgeMetrics({
        walkSec: 1,
        distanceM: 111
    }, { geometryDistanceM: 111 }), null, 'more than 4m/s is not a walking edge');
    assert.equal(normalizeWalkEdgeMetrics({
        walkSec: 80000,
        distanceM: 111
    }, { geometryDistanceM: 111 }), null, 'millisecond-like durations are rejected');
    assert.equal(normalizeWalkEdgeMetrics({
        walkSec: 80,
        distanceM: 0.111
    }, { geometryDistanceM: 111 }), null, 'kilometers cannot be supplied as meters');
    assert.equal(normalizeWalkEdgeMetrics({
        walkSec: 80,
        distanceM: 11100
    }, { geometryDistanceM: 111 }), null, 'centimeters cannot be supplied as meters');
    assert.equal(normalizeWalkEdgeMetrics({
        walkSec: 30,
        distanceM: 400
    }, { geometryDistanceM: 100 }), null,
    'declared distance cannot imply a non-walking speed at the geometry-ratio boundary');
});

test('walk edge geometry accepts only finite WGS84 line coordinates', () => {
    assert.deepEqual(normalizeLineCoordinates([
        ['120', '30'], [120.001, 30.001]
    ], { coerce: true }), [[120, 30], [120.001, 30.001]]);
    assert.equal(normalizeLineCoordinates([[120, 30]]), null);
    assert.equal(normalizeLineCoordinates([[181, 30], [120, 30]]), null);
    assert.equal(normalizeLineCoordinates([[120, NaN], [120, 30]]), null);
});

test('WalkEdge schema rejects invalid finite/range values before persistence', async t => {
    const isolatedMongoose = new mongoose.Mongoose();
    const { WalkEdge } = registerModels(isolatedMongoose);
    const valid = {
        scenicId: 'test',
        edgeId: 'edge-valid',
        from: 'A',
        to: 'B',
        geometry: [[120, 30], [120.001, 30]],
        distanceM: 96.5,
        walkSec: 70,
        slope: 0.09,
        shade: 0,
        covered: 1
    };
    await new WalkEdge(valid).validate();

    for (const [field, value] of [
        ['walkSec', -1],
        ['walkSec', 1.5],
        ['walkSec', Infinity],
        ['distanceM', -1],
        ['distanceM', NaN],
        ['slope', 101],
        ['slope', -101],
        ['shade', -0.01],
        ['shade', 1.01],
        ['covered', -0.01],
        ['covered', 1.01]
    ]) {
        await t.test(`${field}=${String(value)}`, async () => {
            await assert.rejects(new WalkEdge({
                ...valid,
                edgeId: `edge-${field}-${String(value)}`,
                [field]: value
            }).validate());
        });
    }
});
