'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeWalkEdgeDirection,
    expandWalkEdgeDirections
} = require('../../lib/walkEdgeDirection');

const coordinates = [
    [120, 30],
    [120.0005, 30.0002],
    [120.001, 30]
];

test('walk edge direction uses both as the backward-compatible missing-value default', () => {
    for (const value of [undefined, null, '', '   ']) {
        assert.equal(normalizeWalkEdgeDirection(value), 'both');
    }
});

test('walk edge direction accepts only the GIS contract values after case and whitespace normalization', () => {
    assert.equal(normalizeWalkEdgeDirection(' FORWARD '), 'forward');
    assert.equal(normalizeWalkEdgeDirection('Reverse'), 'reverse');
    assert.equal(normalizeWalkEdgeDirection('both'), 'both');

    for (const value of ['bidirectional', 'oneway', 'sideways', 1, true, {}, []]) {
        assert.equal(normalizeWalkEdgeDirection(value), null);
    }
});

test('forward creates one edge whose geometry follows from to to', () => {
    assert.deepEqual(expandWalkEdgeDirections({
        from: 'A', to: 'B', coordinates, direction: 'forward'
    }), [{
        from: 'A',
        to: 'B',
        geometry: coordinates,
        edgeIdSuffix: '',
        traversalDirection: 'forward'
    }]);
});

test('reverse creates one reversed edge whose geometry follows its swapped endpoints', () => {
    assert.deepEqual(expandWalkEdgeDirections({
        from: 'A', to: 'B', coordinates, direction: 'reverse'
    }), [{
        from: 'B',
        to: 'A',
        geometry: [...coordinates].reverse(),
        edgeIdSuffix: '_r',
        traversalDirection: 'reverse'
    }]);
});

test('both creates exactly one edge per direction with endpoint-aligned geometry', () => {
    const result = expandWalkEdgeDirections({
        from: 'A', to: 'B', coordinates, direction: 'both'
    });

    assert.equal(result.length, 2);
    assert.deepEqual(result.map(edge => [edge.from, edge.to]), [
        ['A', 'B'],
        ['B', 'A']
    ]);
    for (const edge of result) {
        assert.deepEqual(edge.geometry[0], edge.from === 'A' ? coordinates[0] : coordinates.at(-1));
        assert.deepEqual(edge.geometry.at(-1), edge.to === 'B' ? coordinates.at(-1) : coordinates[0]);
    }
});

test('invalid directions are rejected instead of silently creating bidirectional edges', () => {
    assert.equal(expandWalkEdgeDirections({
        from: 'A', to: 'B', coordinates, direction: 'oneway'
    }), null);
});
