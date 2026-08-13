'use strict';
// 05文档 §7 A* + 01文档 §5 内存图。启动加载，graph:update 事件重载。

const { haversine, encodePolyline } = require('../lib/geo');
const {
    normalizeBoolean,
    normalizeWalkEdgeMetrics
} = require('../lib/walkEdgeContract');
const { physicalEdgeIdOf } = require('../lib/walkEdgeIdentity');
const { getModels } = require('../models');

const WALK_SPEED = 1.4; // m/s，连接段和直线估算使用
const MAX_SNAP_DISTANCE_M = 200;
const AUTHORITATIVE_SNAP_DISTANCE_M = 10;
const VERIFIED_CONNECTOR_DISTANCE_M = 0.01;

let graph = { nodes: new Map(), adj: new Map() };
let loaded = false;

async function loadIntoMemory() {
    const { WalkNode, WalkEdge } = getModels();
    const [nodes, edges] = await Promise.all([
        WalkNode.find({}).lean(),
        WalkEdge.find({ status: { $ne: 'candidate' } }).lean()
    ]);
    const g = { nodes: new Map(), adj: new Map() };
    for (const n of nodes) {
        const coordinate = validCoordinate(n.geo?.coordinates);
        const nodeId = typeof n.nodeId === 'string' ? n.nodeId.trim() : '';
        if (!coordinate || !nodeId) continue;
        g.nodes.set(nodeId, { lng: coordinate[0], lat: coordinate[1], kind: n.kind });
        g.adj.set(nodeId, []);
    }
    let acceptedEdges = 0;
    let skippedEdges = 0;
    for (const e of edges) {
        const from = typeof e.from === 'string' ? e.from.trim() : '';
        const to = typeof e.to === 'string' ? e.to.trim() : '';
        const edgeId = typeof e.edgeId === 'string' ? e.edgeId.trim() : '';
        const physicalEdgeId = physicalEdgeIdOf(e);
        const status = typeof e.status === 'string' ? e.status.trim() : '';
        const fromNode = g.nodes.get(from);
        const toNode = g.nodes.get(to);
        if (!fromNode || !toNode || !edgeId || !physicalEdgeId || !['open', 'closed'].includes(status)) {
            skippedEdges++;
            continue;
        }
        const geometry = edgeGeometry(e.geometry, fromNode, toNode);
        const metrics = normalizeWalkEdgeMetrics(e, {
            geometryDistanceM: polylineDistance(geometry)
        });
        const stairs = normalizeBoolean(e.stairs, { defaultValue: false });
        const accessible = normalizeBoolean(e.accessible, { defaultValue: false });
        const accessibleVerified = normalizeBoolean(e.accessibleVerified, { defaultValue: false });
        if (!metrics || stairs === null || accessible === null || accessibleVerified === null) {
            skippedEdges++;
            continue;
        }
        g.adj.get(from).push({
            edgeId, physicalEdgeId, from, to,
            walkSec: metrics.walkSec,
            distanceM: metrics.distanceM,
            slope: metrics.slope,
            stairs,
            shade: metrics.shade,
            covered: metrics.covered,
            accessible,
            accessibleVerified,
            geometry,
            sourceRef: loadedSourceRef(e.sourceRef),
            dynamicFactor: status === 'closed' ? Infinity : 1
        });
        acceptedEdges++;
    }
    graph = g;
    loaded = g.nodes.size > 0;
    console.log(`[GeoSync] [GRAPH] loaded ${g.nodes.size} nodes / ${acceptedEdges} edges`);
    if (skippedEdges) {
        console.warn(`[GeoSync] [GRAPH] skipped ${skippedEdges} invalid edges`);
    }
}

function isReady() { return loaded; }

function validCoordinate(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) return null;
    if (value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) return null;
    return [value[0], value[1]];
}

function nodeCoordinate(node) {
    return node ? [node.lng, node.lat] : null;
}

function canonicalSourceRef(value) {
    const datasetName = typeof value?.datasetName === 'string' ? value.datasetName.trim() : '';
    const smId = Number(value?.smId);
    return datasetName && Number.isInteger(smId) && smId >= 0
        ? { datasetName, smId }
        : null;
}

function loadedSourceRef(value) {
    if (!value || typeof value !== 'object') return null;
    const sourceRef = canonicalSourceRef(value) || {};
    const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
    const dataVersion = typeof value.dataVersion === 'string' ? value.dataVersion.trim() : '';
    if (sourceId) sourceRef.sourceId = sourceId;
    if (dataVersion) sourceRef.dataVersion = dataVersion;
    return Object.keys(sourceRef).length ? sourceRef : null;
}

function sourceDataVersion(value) {
    const dataVersion = typeof value?.dataVersion === 'string' ? value.dataVersion.trim() : '';
    return dataVersion || null;
}

function edgeGeometry(rawGeometry, fromNode, toNode) {
    const from = nodeCoordinate(fromNode);
    const to = nodeCoordinate(toNode);
    const positions = Array.isArray(rawGeometry)
        ? rawGeometry.map(validCoordinate).filter(Boolean)
        : [];
    if (positions.length > 1 && from && to) {
        const forward = haversine(from, positions[0]) + haversine(positions[positions.length - 1], to);
        const reverse = haversine(from, positions[positions.length - 1]) + haversine(positions[0], to);
        if (reverse < forward) positions.reverse();
    }
    return dedupeCoords([from, ...positions, to].filter(Boolean));
}

function polylineDistance(coordinates) {
    let distanceM = 0;
    for (let index = 1; index < coordinates.length; index++) {
        distanceM += haversine(coordinates[index - 1], coordinates[index]);
    }
    return Math.round(distanceM);
}

function barrierEdgeIds(options = {}) {
    const ids = new Set();
    const add = value => {
        const edgeId = typeof value === 'string' ? value : value?.edgeId;
        if (edgeId !== undefined && edgeId !== null && String(edgeId).trim()) {
            ids.add(String(edgeId).trim());
        }
        const physicalEdgeId = typeof value === 'object' ? value?.physicalEdgeId : null;
        if (physicalEdgeId !== undefined && physicalEdgeId !== null && String(physicalEdgeId).trim()) {
            ids.add(String(physicalEdgeId).trim());
        }
    };
    const addMany = values => {
        if (values instanceof Set || Array.isArray(values)) {
            for (const value of values) add(value);
        }
    };
    if (options instanceof Set || Array.isArray(options)) addMany(options);
    else if (options && typeof options === 'object') {
        addMany(options.blockedEdgeIds);
        addMany(options.barrierEdgeIds);
        addMany(options.barriers);
    }
    return ids;
}

// 模式代价系数（05文档 §7）
function modeFactor(edge, mode) {
    if (mode === 'accessible') {
        if (edge.stairs) return Infinity;
        let f = 1;
        if (edge.slope > 8) f *= 3; // slope 的契约单位是百分比
        if (!edge.accessibleVerified && edge.accessible) f *= 1.2; // 仅人工标注未实证
        if (!edge.accessible && !edge.accessibleVerified) return Infinity;
        return f;
    }
    if (mode === 'shade') return 1.5 - (edge.shade ?? 0.5);
    return 1;
}

function weightedEdgeCost(edge, mode) {
    const factor = edge.dynamicFactor * modeFactor(edge, mode);
    if (!Number.isFinite(factor) || factor < 0) return null;
    const cost = edge.walkSec * factor;
    return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

// 最小堆（简单二叉堆，图规模 ~300 节点足够）
class MinHeap {
    constructor() { this.a = []; }
    push(item) {
        this.a.push(item);
        let i = this.a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.a[p].f <= this.a[i].f) break;
            [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
            i = p;
        }
    }
    pop() {
        const top = this.a[0], last = this.a.pop();
        if (this.a.length) {
            this.a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < this.a.length && this.a[l].f < this.a[m].f) m = l;
                if (r < this.a.length && this.a[r].f < this.a[m].f) m = r;
                if (m === i) break;
                [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
                i = m;
            }
        }
        return top;
    }
    get size() { return this.a.length; }
}

// Dijkstra（A* 的 h=0 特例）：所有模式只需保证边权非负即可获得最短路。
// options 可携带完整 barrier edgeId 集合；保留 astar 导出名以兼容既有调用方。
function astar(fromNodeId, toNodeId, mode = 'standard', options = {}) {
    if (!graph.nodes.has(fromNodeId) || !graph.nodes.has(toNodeId)) return null;
    const blockedEdgeIds = barrierEdgeIds(options);
    if (fromNodeId === toNodeId) {
        return {
            nodeIds: [fromNodeId], edgeIds: [], walkSec: 0, distanceM: 0, coords: [], segments: [],
            edgeDataVersions: [],
            verifiedAccessible: true,
            accessibility: { graphEdgesVerified: true, unverifiedEdgeIds: [] }
        };
    }
    const open = new MinHeap();
    const gScore = new Map([[fromNodeId, 0]]);
    const cameFrom = new Map(); // nodeId → {prev, edge}
    open.push({ id: fromNodeId, f: 0 });
    const closed = new Set();

    while (open.size) {
        const { id: cur } = open.pop();
        if (cur === toNodeId) break;
        if (closed.has(cur)) continue;
        closed.add(cur);
        for (const edge of (graph.adj.get(cur) || [])) {
            if (blockedEdgeIds.has(edge.edgeId) || blockedEdgeIds.has(edge.physicalEdgeId)) continue;
            const edgeCost = weightedEdgeCost(edge, mode);
            if (edgeCost === null) continue;
            const tentative = gScore.get(cur) + edgeCost;
            if (!Number.isFinite(tentative)) continue;
            if (tentative < (gScore.get(edge.to) ?? Infinity)) {
                gScore.set(edge.to, tentative);
                cameFrom.set(edge.to, { prev: cur, edge });
                open.push({ id: edge.to, f: tentative });
            }
        }
    }
    if (!cameFrom.has(toNodeId)) return null;

    const nodeIds = [toNodeId], edges = [];
    let cur = toNodeId;
    while (cur !== fromNodeId) {
        const { prev, edge } = cameFrom.get(cur);
        edges.unshift(edge);
        nodeIds.unshift(prev);
        cur = prev;
    }
    let walkSec = 0, distanceM = 0;
    const coords = [];
    for (const e of edges) {
        walkSec += e.walkSec; // 报告基准时间（不含模式惩罚，惩罚只影响选路）
        distanceM += e.distanceM;
        for (const c of e.geometry) {
            if (!coords.length || coords[coords.length - 1][0] !== c[0] || coords[coords.length - 1][1] !== c[1]) {
                coords.push(c);
            }
        }
    }
    const unverifiedEdgeIds = edges
        .filter(edge => edge.accessibleVerified !== true || edge.stairs === true)
        .map(edge => edge.edgeId);
    const segments = edges.map(edge => {
        const sourceRef = canonicalSourceRef(edge.sourceRef);
        return {
            edgeId: edge.edgeId,
            physicalEdgeId: edge.physicalEdgeId,
            fromNodeId: edge.from,
            toNodeId: edge.to,
            distanceM: edge.distanceM,
            durationSec: edge.walkSec,
            ...(sourceRef ? { sourceRef } : {})
        };
    });
    return {
        nodeIds,
        edgeIds: edges.map(e => e.edgeId),
        edgeDataVersions: edges.map(edge => sourceDataVersion(edge.sourceRef)),
        walkSec,
        distanceM,
        coords,
        segments,
        verifiedAccessible: unverifiedEdgeIds.length === 0,
        accessibility: {
            graphEdgesVerified: unverifiedEdgeIds.length === 0,
            unverifiedEdgeIds
        }
    };
}

// 最近节点查找（POI gateNodeId 缺失兜底 / 起点吸附）
function nearestNode(lng, lat) {
    if (!validCoordinate([lng, lat])) return null;
    let best = null, bestD = Infinity;
    for (const [id, n] of graph.nodes) {
        const d = haversine([lng, lat], [n.lng, n.lat]);
        if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { nodeId: best, distanceM: bestD } : null;
}

function graphRoute(route, startCoordinate, endCoordinate, startSnap, endSnap, mode) {
    const startNode = graph.nodes.get(startSnap.nodeId);
    const endNode = graph.nodes.get(endSnap.nodeId);
    const connectorDistanceM = startSnap.distanceM + endSnap.distanceM;
    const sameNodeZeroLeg = route.edgeIds.length === 0
        && startSnap.nodeId === endSnap.nodeId
        && startSnap.distanceM === 0
        && endSnap.distanceM === 0
        && startCoordinate[0] === endCoordinate[0]
        && startCoordinate[1] === endCoordinate[1];
    const dedupedCoords = dedupeCoords([
        startCoordinate,
        nodeCoordinate(startNode),
        ...(route.coords || []),
        nodeCoordinate(endNode),
        endCoordinate
    ].filter(Boolean));
    const coords = sameNodeZeroLeg
        ? [[...startCoordinate], [...startCoordinate]]
        : dedupedCoords;
    const connectorsVerified = startSnap.distanceM <= VERIFIED_CONNECTOR_DISTANCE_M
        && endSnap.distanceM <= VERIFIED_CONNECTOR_DISTANCE_M;
    const verifiedAccessible = route.accessibility.graphEdgesVerified && connectorsVerified;
    const fallback = startSnap.distanceM > AUTHORITATIVE_SNAP_DISTANCE_M
        || endSnap.distanceM > AUTHORITATIVE_SNAP_DISTANCE_M;
    return {
        ...route,
        walkSec: route.walkSec + Math.round(connectorDistanceM / WALK_SPEED),
        durationSec: route.walkSec + Math.round(connectorDistanceM / WALK_SPEED),
        distanceM: route.distanceM + Math.round(connectorDistanceM),
        coords,
        geometry: { type: 'LineString', coordinates: coords.map(coordinate => [...coordinate]) },
        snap: {
            startNodeId: startSnap.nodeId,
            endNodeId: endSnap.nodeId,
            startDistanceM: startSnap.distanceM,
            endDistanceM: endSnap.distanceM
        },
        fallback,
        authoritative: !fallback && coords.length >= 2 && (route.edgeIds.length > 0 || sameNodeZeroLeg),
        routeFound: true,
        routeKind: 'graph',
        verifiedAccessible,
        accessibleVerified: verifiedAccessible,
        accessibility: {
            requested: mode === 'accessible',
            graphEdgesVerified: route.accessibility.graphEdgesVerified,
            connectorsVerified,
            verified: verifiedAccessible,
            unverifiedEdgeIds: [...route.accessibility.unverifiedEdgeIds]
        }
    };
}

function directEstimate(startCoordinate, endCoordinate, mode) {
    if (!startCoordinate || !endCoordinate) return null;
    const distanceM = haversine(startCoordinate, endCoordinate) * 1.3;
    const coords = dedupeCoords([startCoordinate, endCoordinate]);
    return {
        nodeIds: [],
        edgeIds: [],
        segments: [],
        walkSec: Math.round(distanceM / WALK_SPEED),
        durationSec: Math.round(distanceM / WALK_SPEED),
        distanceM: Math.round(distanceM),
        coords,
        geometry: { type: 'LineString', coordinates: coords.map(coordinate => [...coordinate]) },
        fallback: true,
        authoritative: false,
        routeFound: false,
        routeKind: 'direct-estimate',
        estimated: true,
        verifiedAccessible: false,
        accessibleVerified: false,
        accessibility: {
            requested: mode === 'accessible',
            graphEdgesVerified: false,
            connectorsVerified: false,
            verified: false,
            unverifiedEdgeIds: []
        }
    };
}

// 两 POI 间步行秒；图不可用时保留非权威直线估算，仅供旧内部合理性判断。
function walkSecBetween(poiA, poiB, mode = 'standard', options = {}) {
    const cA = poiCoords(poiA), cB = poiCoords(poiB);
    if (loaded && cA && cB) {
        const nA = resolveEndpointSnap(poiA, cA);
        const nB = resolveEndpointSnap(poiB, cB);
        if (nA && nB) {
            const r = astar(nA.nodeId, nB.nodeId, mode, options);
            if (r) return graphRoute(r, cA, cB, nA, nB, mode);
        }
    }
    return directEstimate(cA, cB, mode);
}

function resolveEndpointSnap(poi, coordinates) {
    const rawGateNodeId = poi?.gateNodeId;
    const gateNodeId = rawGateNodeId === undefined || rawGateNodeId === null
        ? ''
        : String(rawGateNodeId).trim();
    if (gateNodeId) {
        const gateNode = graph.nodes.get(gateNodeId);
        if (!gateNode) return null;
        return {
            nodeId: gateNodeId,
            distanceM: haversine(coordinates, nodeCoordinate(gateNode))
        };
    }
    const nearest = nearestNode(coordinates[0], coordinates[1]);
    return nearest && nearest.distanceM < MAX_SNAP_DISTANCE_M ? nearest : null;
}

function dedupeCoords(coords) {
    const deduped = [];
    for (const value of coords) {
        const coordinate = validCoordinate(value);
        if (!coordinate) continue;
        const previous = deduped[deduped.length - 1];
        if (!previous || coordinate[0] !== previous[0] || coordinate[1] !== previous[1]) {
            deduped.push(coordinate);
        }
    }
    return deduped;
}

function poiCoords(poi) {
    if (!poi || typeof poi !== 'object') return null;
    return validCoordinate(poi.geo?.coordinates)
        || validCoordinate([poi.location?.lng, poi.location?.lat]);
}

function pathPolyline(result) {
    return result && result.coords.length ? encodePolyline(result.coords) : '';
}

function findLocalPath(input = {}) {
    const start = validCoordinate(input.start);
    const end = validCoordinate(input.end);
    const dataVersion = typeof input.dataVersion === 'string' ? input.dataVersion.trim() : '';
    if (!start || !end || !dataVersion) return null;
    const mode = input.mode === 'normal' ? 'standard' : input.mode || 'standard';
    const route = walkSecBetween({
        gateNodeId: input.startNodeId,
        geo: { type: 'Point', coordinates: start }
    }, {
        gateNodeId: input.endNodeId,
        geo: { type: 'Point', coordinates: end }
    }, mode, { barriers: input.barriers });
    const sameNodeZeroLeg = route?.distanceM === 0
        && route?.walkSec === 0
        && route?.edgeIds.length === 0
        && route?.nodeIds.length === 1
        && route?.snap?.startNodeId === route?.snap?.endNodeId
        && route?.snap?.startDistanceM === 0
        && route?.snap?.endDistanceM === 0
        && start[0] === end[0]
        && start[1] === end[1]
        && route?.coords.length === 2
        && route.coords.every(coordinate => coordinate[0] === start[0] && coordinate[1] === start[1]);
    if (!route?.authoritative
        || route.routeFound === false
        || route.coords.length < 2
        || (!route.edgeIds.length && !sameNodeZeroLeg)
        || route.edgeDataVersions.length !== route.edgeIds.length
        || route.edgeDataVersions.some(version => version !== dataVersion)) {
        return null;
    }
    return {
        dataVersion,
        routeFound: true,
        distanceM: route.distanceM,
        durationSec: route.walkSec,
        geometry: { type: 'LineString', coordinates: route.coords.map(coordinate => [...coordinate]) },
        nodeIds: [...route.nodeIds],
        edgeIds: [...route.edgeIds],
        edgeDataVersions: [...route.edgeDataVersions],
        segments: route.segments.map(segment => ({
            ...segment,
            ...(segment.sourceRef ? { sourceRef: { ...segment.sourceRef } } : {})
        })),
        snap: { ...route.snap },
        verifiedAccessible: route.verifiedAccessible,
        accessibleVerified: route.verifiedAccessible,
        accessibility: {
            ...route.accessibility,
            unverifiedEdgeIds: [...route.accessibility.unverifiedEdgeIds]
        }
    };
}

module.exports = {
    loadIntoMemory,
    isReady,
    astar,
    nearestNode,
    walkSecBetween,
    findLocalPath,
    poiCoords,
    pathPolyline,
    MAX_SNAP_DISTANCE_M,
    AUTHORITATIVE_SNAP_DISTANCE_M
};
