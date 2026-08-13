import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createTopologyRouter,
    TopologyNetworkError
} from '../../../public/assets/js/routing/topologyRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../public/assets/mock/demo-walk-network.json');
const poisFixturePath = path.resolve(__dirname, '../../../public/assets/mock/pois.geojson');
const demoNetwork = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const demoPois = JSON.parse(fs.readFileSync(poisFixturePath, 'utf8'));

const edge = ({
    id,
    from,
    to,
    walkSec = 1,
    distanceM = walkSec,
    shade = 0.5,
    accessible = true,
    stairs = false,
    direction = 'both',
    geometry,
    sourceEdgeIds
}) => ({
    id,
    from,
    to,
    walkSec,
    distanceM,
    shade,
    accessible,
    stairs,
    direction,
    geometry,
    ...(sourceEdgeIds ? { sourceEdgeIds } : {})
});

function smallNetwork() {
    return {
        nodes: [
            { id: 'a', coordinate: [114, 30] },
            { id: 'b', coordinate: [114.001, 30] },
            { id: 'c', coordinate: [114.001, 30.001] },
            { id: 'd', coordinate: [114.002, 30] },
            { id: 'x', coordinate: [114.003, 30] }
        ],
        edges: [
            edge({
                id: 'ab', from: 'a', to: 'b', walkSec: 5, shade: 0,
                geometry: [[114, 30], [114.0005, 30.0002], [114.001, 30]]
            }),
            edge({
                id: 'bd', from: 'b', to: 'd', walkSec: 5, shade: 0,
                geometry: [[114.001, 30], [114.0015, 29.9998], [114.002, 30]]
            }),
            edge({
                id: 'ac', from: 'a', to: 'c', walkSec: 6, shade: 1,
                geometry: [[114, 30], [114.0005, 30.0008], [114.001, 30.001]]
            }),
            edge({
                id: 'cd', from: 'c', to: 'd', walkSec: 6, shade: 1,
                geometry: [[114.001, 30.001], [114.0015, 30.0008], [114.002, 30]]
            }),
            edge({
                id: 'one-way', from: 'd', to: 'x', direction: 'forward',
                geometry: [[114.002, 30], [114.003, 30]]
            })
        ]
    };
}

test('Dijkstra follows topology, preserves turns, supports modes and blocked edges', () => {
    const router = createTopologyRouter(smallNetwork());
    const normal = router.routeBetween('a', 'd');
    assert.equal(normal.found, true);
    assert.deepEqual(normal.edgeIds, ['ab', 'bd']);
    assert.deepEqual(normal.nodeIds, ['a', 'b', 'd']);
    assert.deepEqual(normal.geometry.coordinates, [
        [114, 30],
        [114.0005, 30.0002],
        [114.001, 30],
        [114.0015, 29.9998],
        [114.002, 30]
    ]);
    assert.equal(normal.segments.length, 2);

    const shade = router.routeBetween('a', 'd', { mode: 'shade' });
    assert.deepEqual(shade.edgeIds, ['ac', 'cd']);

    const blocked = router.routeBetween('a', 'd', { blockedEdgeIds: ['ab'] });
    assert.deepEqual(blocked.edgeIds, ['ac', 'cd']);
    assert.equal(blocked.edgeIds.includes('ab'), false);
});

test('directed arcs are not reversible and unreachable routes fail explicitly', () => {
    const router = createTopologyRouter(smallNetwork());
    assert.equal(router.routeBetween('d', 'x').found, true);
    const reverse = router.routeBetween('x', 'd');
    assert.equal(reverse.found, false);
    assert.equal(reverse.code, 'NO_PATH');
    assert.equal(reverse.reason, 'unreachable');
    assert.equal(reverse.geometry, null);
    assert.deepEqual(reverse.edgeIds, []);
});

test('accessible mode rejects stairs and unverified edges', () => {
    const network = smallNetwork();
    network.edges.find(item => item.id === 'ab').stairs = true;
    network.edges.find(item => item.id === 'ac').accessible = false;
    const router = createTopologyRouter(network);
    const result = router.routeBetween('a', 'd', { mode: 'accessible' });
    assert.equal(result.found, false);
    assert.equal(result.code, 'NO_PATH');
});

test('equal-cost routing uses a stable edge-id tie-break', () => {
    const network = smallNetwork();
    network.edges.find(item => item.id === 'ac').walkSec = 5;
    network.edges.find(item => item.id === 'cd').walkSec = 5;
    const router = createTopologyRouter(network);
    const results = Array.from({ length: 5 }, () => router.routeBetween('a', 'd').edgeIds);
    assert.deepEqual(results, Array.from({ length: 5 }, () => ['ab', 'bd']));
});

test('multi-leg aggregation keeps adjacent legs continuous', () => {
    const router = createTopologyRouter(smallNetwork());
    const result = router.routeThrough(['a', 'b', 'd']);
    assert.equal(result.found, true);
    assert.equal(result.legs.length, 2);
    assert.deepEqual(result.edgeIds, ['ab', 'bd']);
    assert.deepEqual(result.geometry.coordinates, [
        [114, 30],
        [114.0005, 30.0002],
        [114.001, 30],
        [114.0015, 29.9998],
        [114.002, 30]
    ]);
});

test('invalid topology is rejected instead of drawing a connector across empty space', () => {
    assert.throws(() => createTopologyRouter({
        nodes: [{ id: 'a', coordinate: [114, 30] }, { id: 'b', coordinate: [114.001, 30] }],
        edges: [edge({
            id: 'bad', from: 'a', to: 'b',
            geometry: [[114, 30], [114.002, 30]]
        })]
    }), TopologyNetworkError);
});

test('stable GIS delivery fixture routes all demo legs and recomputes around edge 7', () => {
    const router = createTopologyRouter(demoNetwork);
    const waypoints = ['start', 'poi_photo', 'poi_history', 'poi_lake']
        .map(key => demoNetwork.poiNodes[key]);
    assert.equal(waypoints.every(nodeId => router.nodeCoordinate(nodeId)), true);

    const before = router.routeThrough(waypoints, { mode: 'normal' });
    const after = router.routeThrough(waypoints, {
        mode: 'normal',
        blockedEdgeIds: [demoNetwork.blockedDemoEdgeId]
    });
    assert.equal(before.found, true);
    assert.equal(after.found, true);
    assert(before.geometry.coordinates.length > waypoints.length);
    assert(after.geometry.coordinates.length > waypoints.length);
    assert(before.sourceEdgeIds.includes('7'));
    assert.equal(after.sourceEdgeIds.includes('7'), false);
    assert.notDeepEqual(after.geometry, before.geometry);
    assert(after.durationSec > before.durationSec);
    assert(before.segments.every(segment => segment.sourceEdgeIds.length > 0));
    assert(after.segments.every(segment => segment.sourceEdgeIds.length > 0));

    const poiCoordinates = waypoints.map(nodeId => router.nodeCoordinate(nodeId));
    assert.notDeepEqual(before.geometry.coordinates, poiCoordinates);
});

test('every approved demo POI maps to its real coordinate and the connected walk topology', () => {
    const router = createTopologyRouter(demoNetwork);
    const startNodeId = demoNetwork.poiNodes.start;
    const approvedPois = demoPois.features.filter(feature => feature.properties?.status === 'approved');

    assert(approvedPois.length > 0);
    for (const feature of approvedPois) {
        const poiId = feature.properties.poiId;
        const nodeId = demoNetwork.poiNodes[poiId];
        assert(nodeId, `${poiId} must have a topology node mapping`);
        assert.deepEqual(router.nodeCoordinate(nodeId), feature.geometry.coordinates,
            `${poiId} must map to its delivered walk-network coordinate`);
        const route = router.routeBetween(startNodeId, nodeId, { mode: 'normal' });
        assert.equal(route.found, true, `${poiId} must be connected to the demo start node`);
    }

    const familyRoute = router.routeBetween(
        demoNetwork.poiNodes.poi_family,
        demoNetwork.poiNodes.poi_lake,
        { mode: 'normal' }
    );
    assert.equal(familyRoute.found, true);
    assert(familyRoute.nodeIds.includes('388'));
    assert(familyRoute.sourceEdgeIds.includes('11'));
});
