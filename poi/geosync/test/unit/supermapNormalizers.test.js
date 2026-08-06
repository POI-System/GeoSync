'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const normalizeGeometry = require('../../integrations/supermap/normalizers');
const {
    normalizeRouteGeometry,
    normalizeRouteGeometryWithMeta,
    MAX_GEOMETRY_POSITIONS,
    MAX_ROUTE_INVALID_POSITIONS,
    MAX_ROUTE_INVALID_POSITION_RATIO
} = normalizeGeometry;
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
    assert.equal(MAX_ROUTE_INVALID_POSITIONS, 4);
    assert.equal(MAX_ROUTE_INVALID_POSITION_RATIO, 0.5);
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

test('geometry and route normalization reject inputs above the coordinate budget', () => {
    const tooManyPositions = new Array(MAX_GEOMETRY_POSITIONS + 1).fill([120, 30]);

    assert.throws(() => normalizeGeometry({
        type: 'MultiPoint',
        coordinates: tooManyPositions
    }), is8206);
    assert.throws(() => normalizeRouteGeometry(tooManyPositions), is8206);
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

test('route invalid-position budget accepts exact boundaries and rejects count or ratio overflow', () => {
    const valid = Array.from({ length: 6 }, (_value, index) => [
        120 + index * 0.001,
        30 + index * 0.001
    ]);
    const invalid = [
        null,
        ['private-coordinate', 30],
        [999, 999],
        [120],
        { lng: 120, lat: 30 }
    ];

    const exactCountBoundary = [
        valid[0], invalid[0], valid[1], invalid[1], valid[2],
        invalid[2], valid[3], invalid[3], valid[4]
    ];
    assert.equal(exactCountBoundary.length, 9);
    assert.equal(
        normalizeRouteGeometry(exactCountBoundary).coordinates.length,
        5,
        'four invalid positions remain within both limits'
    );

    const exactRatioBoundary = [valid[0], invalid[0], invalid[1], valid[1]];
    assert.equal(
        normalizeRouteGeometry(exactRatioBoundary).coordinates.length,
        2,
        'a 50% invalid ratio is accepted at the documented boundary'
    );

    const countOverflow = [
        valid[0], invalid[0], valid[1], invalid[1], valid[2], invalid[2],
        valid[3], invalid[3], valid[4], invalid[4], valid[5]
    ];
    let countError;
    try {
        normalizeRouteGeometry(countOverflow, {
            operation: 'findPath',
            requestId: 'invalid-count-budget'
        });
    } catch (error) {
        countError = error;
    }
    assert.equal(is8206(countError), true);
    assert.equal(countError.message, 'Route geometry contains too many invalid positions');

    const ratioOverflow = [valid[0], invalid[0], invalid[1], invalid[2], valid[1]];
    let ratioError;
    try {
        normalizeRouteGeometry(ratioOverflow, {
            operation: 'findPath',
            requestId: 'invalid-ratio-budget'
        });
    } catch (error) {
        ratioError = error;
    }
    assert.equal(is8206(ratioError), true);
    assert.equal(ratioError.message, 'Route geometry contains too many invalid positions');

    const serialized = JSON.stringify([countError.toJSON(), ratioError.toJSON()]);
    assert.doesNotMatch(serialized, /private-coordinate|999/);
    assert.match(serialized, /invalid-count-budget/);
    assert.match(serialized, /invalid-ratio-budget/);
});

test('invalid-position budget is evaluated for the selected axis order', () => {
    const raw = [
        [120, 30],
        [30, 120],
        [30.1, 120.1],
        [30.2, 120.2],
        [30.3, 120.3],
        [30.4, 120.4],
        [120.1, 30.1]
    ];

    const result = normalizeRouteGeometryWithMeta(raw);
    assert.equal(result.axisSwapped, true);
    assert.deepEqual(result.geometry.coordinates, [
        [120, 30],
        [120.1, 30.1],
        [120.2, 30.2],
        [120.3, 30.3],
        [120.4, 30.4]
    ]);
});

test('tolerated invalid positions do not change endpoint-based direction correction', () => {
    const result = normalizeRouteGeometryWithMeta([
        [120.2, 30.2],
        null,
        [120.1, 30.1],
        [120, 30]
    ], {
        start: [120, 30],
        end: [120.2, 30.2]
    });

    assert.equal(result.reversed, true);
    assert.equal(result.axisSwapped, false);
    assert.deepEqual(result.geometry.coordinates, [
        [120, 30], [120.1, 30.1], [120.2, 30.2]
    ]);
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
