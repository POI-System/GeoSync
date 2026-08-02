'use strict';
// 05文档 §7 A* + 01文档 §5 内存图。启动加载，graph:update 事件重载。

const memCache = require('../lib/memCache');
const { haversine, encodePolyline } = require('../lib/geo');
const { getModels } = require('../models');
const bus = require('../lib/eventBus');

const WALK_SPEED = 1.4; // m/s，可采纳启发式用

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
        g.nodes.set(n.nodeId, { lng: n.geo.coordinates[0], lat: n.geo.coordinates[1], kind: n.kind });
        g.adj.set(n.nodeId, []);
    }
    for (const e of edges) {
        if (!g.adj.has(e.from) || !g.nodes.has(e.to)) continue;
        g.adj.get(e.from).push({
            edgeId: e.edgeId, to: e.to,
            walkSec: e.walkSec, distanceM: e.distanceM || 0,
            slope: e.slope, stairs: e.stairs, shade: e.shade, covered: e.covered,
            accessible: e.accessible, accessibleVerified: e.accessibleVerified,
            geometry: e.geometry || [],
            dynamicFactor: e.status === 'closed' ? Infinity : 1
        });
    }
    graph = g;
    loaded = nodes.length > 0;
    console.log(`[GeoSync] [GRAPH] loaded ${nodes.length} nodes / ${edges.length} edges`);
}

bus.on(bus.EVENTS.EDGE_CLOSED, () => loadIntoMemory());
bus.on(bus.EVENTS.EDGE_OPENED, () => loadIntoMemory());

function isReady() { return loaded; }

// 模式代价系数（05文档 §7）
function modeFactor(edge, mode) {
    if (mode === 'accessible') {
        if (edge.stairs) return Infinity;
        let f = 1;
        if (edge.slope > 0.08) f *= 3;
        if (!edge.accessibleVerified && edge.accessible) f *= 1.2; // 仅人工标注未实证
        if (!edge.accessible && !edge.accessibleVerified) return Infinity;
        return f;
    }
    if (mode === 'shade') return 1.5 - (edge.shade ?? 0.5);
    return 1;
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

// A*：返回 {nodeIds, edgeIds, walkSec, distanceM, coords} | null（不可达）
function astar(fromNodeId, toNodeId, mode = 'standard') {
    if (!graph.nodes.has(fromNodeId) || !graph.nodes.has(toNodeId)) return null;
    if (fromNodeId === toNodeId) {
        return { nodeIds: [fromNodeId], edgeIds: [], walkSec: 0, distanceM: 0, coords: [] };
    }
    const target = graph.nodes.get(toNodeId);
    const h = id => {
        const n = graph.nodes.get(id);
        return haversine([n.lng, n.lat], [target.lng, target.lat]) / WALK_SPEED;
    };
    const open = new MinHeap();
    const gScore = new Map([[fromNodeId, 0]]);
    const cameFrom = new Map(); // nodeId → {prev, edge}
    open.push({ id: fromNodeId, f: h(fromNodeId) });
    const closed = new Set();

    while (open.size) {
        const { id: cur } = open.pop();
        if (cur === toNodeId) break;
        if (closed.has(cur)) continue;
        closed.add(cur);
        for (const edge of (graph.adj.get(cur) || [])) {
            const factor = edge.dynamicFactor * modeFactor(edge, mode);
            if (!Number.isFinite(factor)) continue;
            const tentative = gScore.get(cur) + edge.walkSec * factor;
            if (tentative < (gScore.get(edge.to) ?? Infinity)) {
                gScore.set(edge.to, tentative);
                cameFrom.set(edge.to, { prev: cur, edge });
                open.push({ id: edge.to, f: tentative + h(edge.to) });
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
        const geom = e.geometry.length ? e.geometry : segmentCoords(e);
        for (const c of geom) {
            if (!coords.length || coords[coords.length - 1][0] !== c[0] || coords[coords.length - 1][1] !== c[1]) {
                coords.push(c);
            }
        }
    }
    return { nodeIds, edgeIds: edges.map(e => e.edgeId), walkSec, distanceM, coords };
}

function segmentCoords(edge) {
    // 边无 geometry 时退化为端点直线
    const to = graph.nodes.get(edge.to);
    return to ? [[to.lng, to.lat]] : [];
}

// 最近节点查找（POI gateNodeId 缺失兜底 / 起点吸附）
function nearestNode(lng, lat) {
    let best = null, bestD = Infinity;
    for (const [id, n] of graph.nodes) {
        const d = haversine([lng, lat], [n.lng, n.lat]);
        if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { nodeId: best, distanceM: bestD } : null;
}

// 两 POI 间步行秒（打卡时间合理性/规划距离矩阵用）；图不可用 → haversine 直线兜底
function walkSecBetween(poiA, poiB, mode = 'standard') {
    const gateA = poiA.gateNodeId, gateB = poiB.gateNodeId;
    const cA = poiCoords(poiA), cB = poiCoords(poiB);
    if (loaded && gateA && gateB && graph.nodes.has(gateA) && graph.nodes.has(gateB)) {
        const r = astar(gateA, gateB, mode);
        if (r) return { ...r, fallback: false };
    }
    if (loaded && cA && cB) {
        const nA = nearestNode(cA[0], cA[1]), nB = nearestNode(cB[0], cB[1]);
        if (nA && nB && nA.distanceM < 200 && nB.distanceM < 200) {
            const r = astar(nA.nodeId, nB.nodeId, mode);
            if (r) {
                const fromNode = graph.nodes.get(nA.nodeId);
                const toNode = graph.nodes.get(nB.nodeId);
                const connectorDistanceM = nA.distanceM + nB.distanceM;
                const coords = dedupeCoords([
                    cA,
                    [fromNode.lng, fromNode.lat],
                    ...(r.coords || []),
                    [toNode.lng, toNode.lat],
                    cB
                ]);
                return {
                    ...r,
                    walkSec: r.walkSec + Math.round(connectorDistanceM / WALK_SPEED),
                    distanceM: r.distanceM + Math.round(connectorDistanceM),
                    coords,
                    fallback: nA.distanceM > 10 || nB.distanceM > 10
                };
            }
        }
    }
    if (!cA || !cB) return null;
    const d = haversine(cA, cB) * 1.3; // 直线×1.3 绕路系数兜底
    return {
        nodeIds: [], edgeIds: [], walkSec: Math.round(d / WALK_SPEED),
        distanceM: Math.round(d), coords: [cA, cB], fallback: true
    };
}

function dedupeCoords(coords) {
    return coords.filter((coord, index) =>
        index === 0 || coord[0] !== coords[index - 1][0] || coord[1] !== coords[index - 1][1]);
}

function poiCoords(poi) {
    if (poi.geo?.coordinates?.length === 2) return poi.geo.coordinates;
    if (poi.location?.lng != null) return [poi.location.lng, poi.location.lat];
    return null;
}

function pathPolyline(result) {
    return result && result.coords.length ? encodePolyline(result.coords) : '';
}

module.exports = { loadIntoMemory, isReady, astar, nearestNode, walkSecBetween, poiCoords, pathPolyline };
