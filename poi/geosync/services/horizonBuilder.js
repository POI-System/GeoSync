'use strict';
// 05文档 §6.3/§6.4：DEM 读取 + horizon 遮挡曲线离线预计算。
// SRTM .hgt 瓦片（30m, 1°×1°, 3601×3601 int16 大端）放 DEM_TILE_DIR。

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { destination } = require('../lib/geo');

const SIZE = 3601;
const tileCache = new Map(); // 'N32E118' → Buffer|null

function tileName(lat, lng) {
    const latP = Math.floor(lat), lngP = Math.floor(lng);
    const ns = latP >= 0 ? 'N' : 'S';
    const ew = lngP >= 0 ? 'E' : 'W';
    return `${ns}${String(Math.abs(latP)).padStart(2, '0')}${ew}${String(Math.abs(lngP)).padStart(3, '0')}`;
}

function loadTile(name) {
    if (tileCache.has(name)) return tileCache.get(name);
    const file = path.join(CONFIG.demTileDir, `${name}.hgt`);
    let buf = null;
    try {
        buf = fs.readFileSync(file);
        if (buf.length !== SIZE * SIZE * 2) {
            console.warn(`[GeoSync] [DEM] tile ${name} size mismatch, ignored`);
            buf = null;
        }
    } catch {
        console.warn(`[GeoSync] [DEM] tile ${name}.hgt missing — elevation=0 for this area`);
    }
    tileCache.set(name, buf);
    return buf;
}

// 双线性插值高程（米）；瓦片缺失 → 0
function demElevation(lat, lng) {
    const buf = loadTile(tileName(lat, lng));
    if (!buf) return 0;
    const latP = Math.floor(lat), lngP = Math.floor(lng);
    // .hgt 第一行是北缘：row 0 = latP+1
    const x = (lng - lngP) * (SIZE - 1);
    const y = (latP + 1 - lat) * (SIZE - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const read = (r, c) => {
        const rr = Math.min(Math.max(r, 0), SIZE - 1);
        const cc = Math.min(Math.max(c, 0), SIZE - 1);
        const v = buf.readInt16BE((rr * SIZE + cc) * 2);
        return v === -32768 ? 0 : v; // void 值按 0
    };
    const fx = x - x0, fy = y - y0;
    return read(y0, x0) * (1 - fx) * (1 - fy) +
        read(y0, x0 + 1) * fx * (1 - fy) +
        read(y0 + 1, x0) * (1 - fx) * fy +
        read(y0 + 1, x0 + 1) * fx * fy;
}

// 360° 每 1° 地平线扫描：100m 步长至 20km
function buildHorizonProfile([lng, lat]) {
    const spotElev = demElevation(lat, lng) + 2; // 人眼高度
    const profile = new Array(360);
    for (let az = 0; az < 360; az++) {
        let maxAngle = 0;
        for (let dist = 100; dist <= 20000; dist += 100) {
            const [lng2, lat2] = destination([lng, lat], az, dist);
            const h = demElevation(lat2, lng2);
            const angle = Math.atan2(h - spotElev, dist) * 180 / Math.PI;
            if (angle > maxAngle) maxAngle = angle;
        }
        profile[az] = Math.round(maxAngle * 10) / 10;
    }
    return profile;
}

// 串行队列：机位过审触发（SPOT_APPROVED 事件在 index.js 接线）
const queue = [];
let running = false;

function enqueue(spotId) {
    queue.push(spotId);
    drain();
}

async function drain() {
    if (running) return;
    running = true;
    const { PhotoSpot } = getModels();
    while (queue.length) {
        const spotId = queue.shift();
        try {
            const spot = await PhotoSpot.findById(spotId);
            if (!spot || spot.horizonProfile?.length === 360) continue;
            const t0 = Date.now();
            spot.horizonProfile = buildHorizonProfile(spot.geo.coordinates);
            spot.horizonBuiltAt = new Date();
            await spot.save();
            console.log(`[GeoSync] [HORIZON] spot ${spotId} built in ${Date.now() - t0}ms`);
        } catch (e) {
            console.error('[GeoSync] [HORIZON]', e.message);
        }
    }
    running = false;
}

module.exports = { demElevation, buildHorizonProfile, enqueue, tileName };
