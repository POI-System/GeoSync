'use strict';
// 地理工具：haversine、方位/目的地大圆公式、中位数滤波、角度差、timeSlot、userIdHash。

const crypto = require('crypto');

const EARTH_R = 6371000; // m

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

// [lng,lat] × 2 → 米
function haversine(a, b) {
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// 从 [lng,lat] 沿方位角 bearingDeg 走 distM 米 → [lng,lat]（05文档 §6.3 horizon 扫描用）
function destination(origin, bearingDeg, distM) {
    const [lng, lat] = origin;
    const br = toRad(bearingDeg);
    const dr = distM / EARTH_R;
    const lat1 = toRad(lat);
    const lng1 = toRad(lng);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
    const lng2 = lng1 + Math.atan2(
        Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
        Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [toDeg(lng2), toDeg(lat2)];
}

// 两角差归一到 [0,180]
function angleDiff(a, b) {
    let d = Math.abs(((a % 360) + 360) % 360 - ((b % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
}

// 滑动中位数滤波（05文档 §1.1，window=5）：对最近 N 点经纬度分别取中位数
function medianFilter(points, window = 5) {
    const win = points.slice(-window);
    if (!win.length) return null;
    const med = arr => {
        const s = [...arr].sort((x, y) => x - y);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    return [med(win.map(p => p[0])), med(win.map(p => p[1]))];
}

// 点到折线（[[lng,lat],...]）最小距离（米）——偏离检测用；小尺度下用平面近似
function distToPolyline(pt, line) {
    if (!line || line.length === 0) return Infinity;
    if (line.length === 1) return haversine(pt, line[0]);
    const cosLat = Math.cos(toRad(pt[1]));
    const px = pt[0] * cosLat, py = pt[1];
    let min = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const ax = line[i][0] * cosLat, ay = line[i][1];
        const bx = line[i + 1][0] * cosLat, by = line[i + 1][1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * dx, qy = ay + t * dy;
        const dDeg = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2);
        min = Math.min(min, dDeg * 111320); // 1° ≈ 111.32km
    }
    return min;
}

// 本地时区 timeSlot：'YYYY-MM-DDTHH:mm'，mm 对齐 slotMinutes
function timeSlotOf(date, slotMinutes = 10) {
    const d = new Date(date);
    d.setMinutes(Math.floor(d.getMinutes() / slotMinutes) * slotMinutes, 0, 0);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function slotStartOf(date, slotMinutes = 10) {
    const d = new Date(date);
    d.setMinutes(Math.floor(d.getMinutes() / slotMinutes) * slotMinutes, 0, 0);
    return d;
}

function dateStrOf(date) {
    const d = new Date(date);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 02文档 §0：日轮换盐 HMAC，跨天不可关联
function userIdHash(openId, secret, date = new Date()) {
    const day = dateStrOf(date).replace(/-/g, '');
    return crypto.createHmac('sha256', `${secret}:${day}`).update(String(openId)).digest('hex').slice(0, 32);
}

// polyline 编码/解码（Google 格式，精度5）——pathGeometry 存储用
function encodePolyline(coords) {
    let lastLat = 0, lastLng = 0, out = '';
    const enc = v => {
        let n = v < 0 ? ~(v << 1) : v << 1;
        let s = '';
        while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
        return s + String.fromCharCode(n + 63);
    };
    for (const [lng, lat] of coords) {
        const iLat = Math.round(lat * 1e5), iLng = Math.round(lng * 1e5);
        out += enc(iLat - lastLat) + enc(iLng - lastLng);
        lastLat = iLat; lastLng = iLng;
    }
    return out;
}

function decodePolyline(str) {
    let idx = 0, lat = 0, lng = 0;
    const out = [];
    const dec = () => {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        return (result & 1) ? ~(result >> 1) : result >> 1;
    };
    while (idx < str.length) {
        lat += dec(); lng += dec();
        out.push([lng / 1e5, lat / 1e5]);
    }
    return out;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

module.exports = {
    haversine, destination, angleDiff, medianFilter, distToPolyline,
    timeSlotOf, slotStartOf, dateStrOf, userIdHash,
    encodePolyline, decodePolyline, clamp
};
