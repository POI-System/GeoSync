'use strict';
// 02文档 §13：从 GeoJSON 导入路网（官方 GIS 数据通道）。
// 用法：node scripts/seed-walkgraph.js path/to/walkgraph.geojson [--wipe]
// GeoJSON 约定：
//   Point Feature   → 节点，properties: {nodeId?, kind?}
//   LineString      → 边（双向），properties: {from?, to?, stairs?, slope?, shade?, covered?, accessible?}
//   from/to 缺省时按端点坐标就近吸附（<5m）到已导入节点。

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { registerModels } = require('../models');
const geo = require('../lib/geo');

const SCENIC_ID = process.env.SCENIC_ID || 'default';

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('用法: node scripts/seed-walkgraph.js <walkgraph.geojson> [--wipe]');
        process.exit(1);
    }
    const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const features = gj.features || [];

    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';
    await mongoose.connect(uri);
    const { WalkNode, WalkEdge } = registerModels(mongoose);

    if (process.argv.includes('--wipe')) {
        await WalkNode.deleteMany({ scenicId: SCENIC_ID });
        await WalkEdge.deleteMany({ scenicId: SCENIC_ID });
        console.log('[seed-walkgraph] wiped existing graph');
    }

    // 1. 节点
    let nSeq = 0, eSeq = 0;
    const nodes = []; // {nodeId, coords}
    for (const f of features) {
        if (f.geometry?.type !== 'Point') continue;
        const nodeId = f.properties?.nodeId || `n_${String(++nSeq).padStart(3, '0')}`;
        const coords = f.geometry.coordinates;
        await WalkNode.updateOne(
            { nodeId },
            {
                $set: {
                    scenicId: SCENIC_ID,
                    geo: { type: 'Point', coordinates: coords },
                    kind: f.properties?.kind || 'junction'
                }
            },
            { upsert: true }
        );
        nodes.push({ nodeId, coords });
    }

    const snap = pt => {
        let best = null, bestD = Infinity;
        for (const n of nodes) {
            const d = geo.haversine(pt, n.coords);
            if (d < bestD) { bestD = d; best = n; }
        }
        return bestD < 5 ? best.nodeId : null;
    };

    // 2. 边（LineString → 双向两条）
    let edges = 0, skipped = 0;
    for (const f of features) {
        if (f.geometry?.type !== 'LineString') continue;
        const coords = f.geometry.coordinates;
        const p = f.properties || {};
        const from = p.from || snap(coords[0]);
        const to = p.to || snap(coords[coords.length - 1]);
        if (!from || !to || from === to) { skipped++; continue; }
        let distanceM = 0;
        for (let i = 0; i < coords.length - 1; i++) distanceM += geo.haversine(coords[i], coords[i + 1]);
        distanceM = Math.round(distanceM);
        const walkSec = Math.round(distanceM / 1.4 * (p.stairs ? 1.6 : 1));
        const base = {
            scenicId: SCENIC_ID, distanceM, walkSec,
            slope: Number(p.slope) || 0, stairs: Boolean(p.stairs),
            shade: p.shade != null ? Number(p.shade) : 0.5,
            covered: p.covered != null ? Number(p.covered) : 0,
            accessible: Boolean(p.accessible),
            status: 'open', source: 'import'
        };
        for (const [a, b, geom] of [[from, to, coords], [to, from, [...coords].reverse()]]) {
            const edgeId = p.edgeId ? `${p.edgeId}${a === from ? '' : '_r'}` : `e_${String(++eSeq).padStart(3, '0')}`;
            await WalkEdge.updateOne(
                { edgeId },
                { $set: { ...base, from: a, to: b, geometry: geom } },
                { upsert: true }
            );
            edges++;
        }
    }
    console.log(`[seed-walkgraph] nodes=${nodes.length} edges=${edges} skippedLines=${skipped}`);
    await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
