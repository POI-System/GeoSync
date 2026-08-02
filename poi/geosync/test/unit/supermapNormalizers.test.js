'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const normalizeGeometry = require('../../integrations/supermap/normalizers');
const { normalizeRouteGeometry, normalizeRouteGeometryWithMeta } = normalizeGeometry;
const { GeometryNormalizationError } = require('../../integrations/supermap/errors');

function is8206(error) {
    return error instanceof GeometryNormalizationError
        && error.code === 8206
        && error.httpStatus === 502
        && error.retryable === false;
}

test('default and gateway-facing named exports share the same normalizer', () => {
    assert.strictEqual(normalizeGeometry.normalizeGeometry, normalizeGeometry);
    assert.strictEqual(normalizeGeometry.normalizeGeoJsonGeometry, normalizeGeometry);
    assert.strictEqual(normalizeGeometry.normalizeGeoJSONGeometry, normalizeGeometry);
    assert.equal(typeof normalizeRouteGeometry, 'function');
    assert.equal(typeof normalizeRouteGeometryWithMeta, 'function');
});

test('normalizes Points to EPSG:4326 pairs rounded to six decimals', () => {
    const input = {
        type: 'Point',
        coordinates: [120.123456789, -0.0000004],
        bbox: [0, 0, 1, 1]
    };

    const result = normalizeGeometry(input);

    assert.deepEqual(result, {
        type: 'Point',
        coordinates: [120.123457, 0]
    });
    assert.deepEqual(input.coordinates, [120.123456789, -0.0000004]);
    assert.equal(result.bbox, undefined);
});

test('rejects invalid Point ordinates, lengths, and geographic ranges', () => {
    for (const coordinates of [
        [120],
        [120, 30, 5],
        ['120', 30],
        [Number.NaN, 30],
        [Number.POSITIVE_INFINITY, 30],
        [180.000001, 30],
        [120, 90.000001]
    ]) {
        assert.throws(() => normalizeGeometry({ type: 'Point', coordinates }), is8206);
    }
});

test('normalizes nonempty MultiPoints while preserving point multiplicity', () => {
    assert.deepEqual(normalizeGeometry({
        type: 'MultiPoint',
        coordinates: [[120.0000004, 30], [120.0000004, 30], [-180, -90]]
    }), {
        type: 'MultiPoint',
        coordinates: [[120, 30], [120, 30], [-180, -90]]
    });

    assert.throws(() => normalizeGeometry({ type: 'MultiPoint', coordinates: [] }), is8206);
    assert.throws(() => normalizeGeometry({ type: 'MultiPoint', coordinates: [120, 30] }), is8206);
});

test('LineStrings remove consecutive duplicates after rounding and retain two points', () => {
    const result = normalizeGeometry({
        type: 'LineString',
        coordinates: [
            [120, 30],
            [120.0000004, 30.0000004],
            [120.1, 30.1],
            [120.1, 30.1]
        ]
    });

    assert.deepEqual(result.coordinates, [[120, 30], [120.1, 30.1]]);
    assert.throws(() => normalizeGeometry({
        type: 'LineString',
        coordinates: [[120, 30], [120.0000004, 30.0000004]]
    }), is8206);
});

test('MultiLineStrings require valid nonempty nested lines', () => {
    assert.deepEqual(normalizeGeometry({
        type: 'MultiLineString',
        coordinates: [
            [[120, 30], [120.1, 30.1]],
            [[121, 31], [121, 31], [121.1, 31.1]]
        ]
    }).coordinates, [
        [[120, 30], [120.1, 30.1]],
        [[121, 31], [121.1, 31.1]]
    ]);

    assert.throws(() => normalizeGeometry({ type: 'MultiLineString', coordinates: [] }), is8206);
    assert.throws(() => normalizeGeometry({
        type: 'MultiLineString', coordinates: [[[120, 30]]]
    }), is8206);
});

test('Polygons deduplicate and close exterior and interior rings', () => {
    const result = normalizeGeometry({
        type: 'Polygon',
        coordinates: [
            [[120, 30], [121, 30], [121, 31], [121, 31], [120, 31]],
            [[120.2, 30.2], [120.8, 30.2], [120.5, 30.8]]
        ]
    });

    assert.deepEqual(result.coordinates, [
        [[120, 30], [121, 30], [121, 31], [120, 31], [120, 30]],
        [[120.2, 30.2], [120.8, 30.2], [120.5, 30.8], [120.2, 30.2]]
    ]);
});

test('Polygons reject empty, malformed, and insufficiently distinct rings', () => {
    for (const coordinates of [
        [],
        [[120, 30], [121, 30], [120, 30]],
        [[[120, 30], [121, 30], [120, 30]]],
        [[[120, 30], [120, 30], [120, 30]]]
    ]) {
        assert.throws(() => normalizeGeometry({ type: 'Polygon', coordinates }), is8206);
    }
});

test('MultiPolygons normalize every polygon and reject invalid nesting', () => {
    const result = normalizeGeometry({
        type: 'MultiPolygon',
        coordinates: [
            [[[120, 30], [121, 30], [121, 31], [120, 30]]],
            [[[122, 32], [123, 32], [123, 33], [122, 32]]]
        ]
    });

    assert.equal(result.coordinates.length, 2);
    assert.deepEqual(result.coordinates[0][0][0], result.coordinates[0][0].at(-1));
    assert.deepEqual(result.coordinates[1][0][0], result.coordinates[1][0].at(-1));

    assert.throws(() => normalizeGeometry({ type: 'MultiPolygon', coordinates: [] }), is8206);
    assert.throws(() => normalizeGeometry({
        type: 'MultiPolygon', coordinates: [[[120, 30], [121, 31]]]
    }), is8206);
});

test('unsupported geometry types and circular coordinate arrays fail as sanitized 8206 errors', () => {
    const circular = [];
    circular.push(circular);

    assert.throws(() => normalizeGeometry({
        type: 'GeometryCollection', geometries: []
    }), is8206);
    assert.throws(() => normalizeGeometry({
        type: 'LineString', coordinates: circular
    }), is8206);
});

test('errors carry sanitized operation and requestId context without raw geometry details', () => {
    let thrown;
    try {
        normalizeGeometry({ type: 'Point', coordinates: [999, 999], secret: 'do-not-copy' }, {
            operation: 'findPath\r\nunsafe',
            requestId: 'gis request\r\n42'
        });
    } catch (error) {
        thrown = error;
    }

    assert.equal(is8206(thrown), true);
    assert.equal(thrown.operation, 'findPath__unsafe');
    assert.equal(thrown.requestId, 'gis_request__42');
    assert.equal(JSON.stringify(thrown.toJSON()).includes('do-not-copy'), false);
    assert.equal(JSON.stringify(thrown.toJSON()).includes('999'), false);
});

test('route normalizer accepts coordinate arrays, drops invalid points, rounds, and deduplicates', () => {
    const input = [
        [120.123456789, 30.123456789],
        null,
        [120.1234568, 30.1234568],
        ['120.2', 30.2],
        [999, 999],
        [120.2, 30.2]
    ];

    assert.deepEqual(normalizeRouteGeometry(input), {
        type: 'LineString',
        coordinates: [[120.123457, 30.123457], [120.2, 30.2]]
    });
    assert.deepEqual(input[0], [120.123456789, 30.123456789]);
});

test('route normalizer corrects axis order using WGS84 validity', () => {
    assert.deepEqual(normalizeRouteGeometry({
        type: 'LineString',
        coordinates: [[30, 120], [30.1, 120.1]]
    }), {
        type: 'LineString',
        coordinates: [[120, 30], [120.1, 30.1]]
    });
});

test('route normalizer uses extent context for ambiguous axis order', () => {
    const result = normalizeRouteGeometry([
        [30, 40],
        [30.5, 40.5],
        [31, 41]
    ], {
        extent: [39, 29, 42, 32]
    });

    assert.deepEqual(result.coordinates, [[40, 30], [40.5, 30.5], [41, 31]]);
});

test('route normalizer uses endpoint context for ambiguous axis order', () => {
    const result = normalizeRouteGeometry([
        [30, 40],
        [30.5, 40.5],
        [31, 41]
    ], {
        start: [40, 30],
        end: [41, 31]
    });

    assert.deepEqual(result.coordinates, [[40, 30], [40.5, 30.5], [41, 31]]);
});

test('route normalizer reverses a valid route when endpoint scoring favors reverse direction', () => {
    const result = normalizeRouteGeometry({
        type: 'LineString',
        coordinates: [[120.2, 30.2], [120.1, 30.1], [120, 30]]
    }, {
        start: [120, 30],
        end: [120.2, 30.2]
    });

    assert.deepEqual(result.coordinates, [[120, 30], [120.1, 30.1], [120.2, 30.2]]);
});

test('route normalization metadata identifies axis correction and direction reversal', () => {
    const axisResult = normalizeRouteGeometryWithMeta([
        [30, 120],
        [30.1, 120.1]
    ]);
    assert.deepEqual(axisResult, {
        geometry: {
            type: 'LineString',
            coordinates: [[120, 30], [120.1, 30.1]]
        },
        reversed: false,
        axisSwapped: true
    });

    const directionResult = normalizeRouteGeometryWithMeta([
        [120.2, 30.2],
        [120.1, 30.1],
        [120, 30]
    ], {
        start: [120, 30],
        end: [120.2, 30.2]
    });
    assert.deepEqual(directionResult, {
        geometry: {
            type: 'LineString',
            coordinates: [[120, 30], [120.1, 30.1], [120.2, 30.2]]
        },
        reversed: true,
        axisSwapped: false
    });
});

test('route normalizer rejects unusable routes and sanitizes error context', () => {
    for (const input of [
        null,
        { type: 'Point', coordinates: [120, 30] },
        [[120, 30], [120.0000004, 30.0000004]],
        [[999, 999], ['secret', 30]]
    ]) {
        assert.throws(() => normalizeRouteGeometry(input), is8206);
    }

    let thrown;
    try {
        normalizeRouteGeometry([[999, 999]], {
            operation: 'findPath\r\nunsafe',
            requestId: 'route request\r\n42',
            extent: [120, 30, 119, 31]
        });
    } catch (error) {
        thrown = error;
    }

    assert.equal(is8206(thrown), true);
    assert.equal(thrown.operation, 'findPath__unsafe');
    assert.equal(thrown.requestId, 'route_request__42');
    assert.equal(JSON.stringify(thrown.toJSON()).includes('secret'), false);
    assert.equal(JSON.stringify(thrown.toJSON()).includes('999'), false);
});
