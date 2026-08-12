import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    DATA_VERSION,
    MAX_WALK_EDGES,
    createPreviewConfig,
    createSxrPreview,
    mergeDuplicateEdges,
    normalizeFeature,
    normalizeFeatureResult,
    normalizeSnapshot,
    optionalBoolean,
    walkEdgeQuery
} = require('../../scripts/sxr-iserver-preview.js');

function feature(overrides = {}) {
    return {
        fieldNames: [
            'SmID', 'name', 'highway', 'edge_id', 'from_node', 'to_node',
            'length_m', 'walk_sec', 'slope_pct', 'stairs', 'shade',
            'accessible', 'status', 'direction', 'data_ver'
        ],
        fieldValues: [
            '7', '樱花大道', 'footway', 'WHU_E_8', 'WHU_N_1', 'WHU_N_2',
            '42.5', '35.4', '', 'false', '0.75', '', 'open', 'both', '2026.08.03-p0'
        ],
        geometry: {
            type: 'LINE', parts: [2, 2], points: [
                { x: 114.3592, y: 30.541 }, { x: 114.3595, y: 30.5412 },
                { x: 114.3596, y: 30.5413 }, { x: 114.361, y: 30.543 }
            ]
        },
        ...overrides
    };
}

test('SXR feature normalization preserves multipart geometry and stable business fields', () => {
    const edge = normalizeFeature(feature());
    assert.equal(edge.edgeId, 'WHU_E_8');
    assert.equal(edge.geometry.type, 'MultiLineString');
    assert.equal(edge.geometry.coordinates.length, 2);
    assert.equal(edge.distanceM, 42.5);
    assert.equal(edge.stairs, false);
    assert.equal(edge.shade, 0.75);
    assert.equal(edge.accessible, null);
    assert.deepEqual(edge.sourceRef, {
        datasetName: 'WalkEdge@GeoSync', smId: 7, dataVersion: '2026.08.03-p0'
    });
});

test('optional booleans do not turn missing accessibility evidence into false', () => {
    assert.equal(optionalBoolean('true'), true);
    assert.equal(optionalBoolean('false'), false);
    assert.equal(optionalBoolean(''), null);
    assert.equal(optionalBoolean('unknown'), null);
});

test('feature result rejects malformed or empty iServer responses', () => {
    assert.throws(() => normalizeFeatureResult({}), /SXR_WALK_EDGE_RESPONSE_INVALID/);
    assert.throws(() => normalizeFeatureResult({ features: [] }), /SXR_WALK_EDGE_EMPTY/);
    const graph = normalizeFeatureResult({ features: [feature()] });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.readOnly, true);
    assert.equal(graph.dataVersion, DATA_VERSION);
});

test('duplicate business edge IDs merge geometry without double-counting metrics', () => {
    const first = normalizeFeature(feature());
    const second = normalizeFeature(feature({
        fieldValues: [
            '8', '樱花大道', 'footway', 'WHU_E_8', 'WHU_N_1', 'WHU_N_2',
            '42.5', '36.1', '', 'false', '0.75', '', 'open', 'both', '2026.08.03-p0'
        ],
        geometry: {
            type: 'LINE', parts: [2], points: [
                { x: 114.3597, y: 30.5414 }, { x: 114.3612, y: 30.5432 }
            ]
        }
    }));
    const merged = mergeDuplicateEdges([first, second]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].distanceM, 42.5);
    assert.equal(merged[0].geometry.type, 'MultiLineString');
    assert.equal(merged[0].geometry.coordinates.length, 3);
    assert.deepEqual(merged[0].sourceRef.smIds, [7, 8]);
});

test('preview config exposes only public GIS URLs and marks the session read-only', () => {
    const config = createPreviewConfig('http://127.0.0.1:8090/');
    assert.equal(config.preview.readOnly, true);
    assert.equal(config.gis.crs, 'EPSG:4326');
    assert.equal(config.gis.publicServices.map,
        'http://127.0.0.1:8090/iserver/services/scenic-map/rest/maps/ScenicMap');
    assert.doesNotMatch(JSON.stringify(config), /password|username|token/i);

    const snapshotConfig = createPreviewConfig('http://127.0.0.1:8090/', 'local-snapshot');
    assert.equal(snapshotConfig.gis.source, 'local-snapshot');
    assert.deepEqual(snapshotConfig.gis.publicServices, {});
    assert.doesNotMatch(JSON.stringify(snapshotConfig), /scenic-map|scenic-terrain|scenic-scene/);
});

test('preview graph request uses the bounded SQL feature contract and caches success', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return {
            status: 201,
            async json() { return { features: [feature()] }; }
        };
    };
    const preview = createSxrPreview({ baseUrl: 'http://127.0.0.1:8090', fetchImpl });
    const first = await preview.getGraph();
    const second = await preview.getGraph();
    assert.equal(first, second);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /featureResults\.json\?returnContent=true$/);
    const request = JSON.parse(calls[0].options.body);
    assert.deepEqual(request, walkEdgeQuery());
    assert.equal(request.getFeatureMode, 'SQL');
    assert.equal(request.maxFeatures, MAX_WALK_EDGES);
    assert.deepEqual(request.datasetNames, ['GeoSync:WalkEdge']);
    assert.equal(request.queryParameter.attributeFilter, 'SmID>0');
});

test('preview falls back to a validated read-only road snapshot', async () => {
    const snapshot = normalizeSnapshot({
        scenicId: 'whu_core',
        dataVersion: DATA_VERSION,
        source: 'local-snapshot',
        edges: [normalizeFeature(feature())]
    });
    assert.equal(snapshot.source, 'local-snapshot');
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.edges.length, 1);
    assert.throws(() => normalizeSnapshot({ scenicId: 'other', dataVersion: DATA_VERSION, edges: [] }),
        /SXR_ROAD_SNAPSHOT_INVALID/);
});

test('preview config follows the graph source after snapshot fallback', async () => {
    const preview = createSxrPreview({
        baseUrl: 'http://127.0.0.1:8090',
        fetchImpl: async () => ({ status: 404, async json() { return {}; } }),
        snapshotPath: new URL('../../.cache/sxr-road-snapshot.json', import.meta.url).pathname.replace(/^\/(.:)/, '$1')
    });
    const config = await preview.getConfig();
    assert.equal(config.gis.source, 'local-snapshot');
    assert.deepEqual(config.gis.publicServices, {});
});
