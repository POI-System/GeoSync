'use strict';
// 05文档 §6：太阳光位 + horizon 查表 + 黄金窗口。纯计算，可单测。

const SunCalc = require('suncalc');
const { angleDiff, clamp } = require('../lib/geo');

// suncalc 方位角（南=0，西为正，弧度）→ 北0顺时针度
function sunPos(date, lat, lng) {
    const p = SunCalc.getPosition(date, lat, lng);
    return {
        azimuthDeg: ((p.azimuth * 180 / Math.PI) + 180) % 360,
        elevationDeg: p.altitude * 180 / Math.PI
    };
}

// horizon 曲线线性插值查表；无 profile → 0（几何地平线）
function horizonAt(profile, azDeg) {
    if (!profile || profile.length !== 360) return 0;
    const az = ((azDeg % 360) + 360) % 360;
    const i = Math.floor(az), j = (i + 1) % 360, t = az - i;
    return profile[i] * (1 - t) + profile[j] * t;
}

function lightOf(delta) {
    if (delta >= 150 && delta <= 180) return 'back';
    if (delta >= 30 && delta <= 60) return 'side';
    if (delta >= 0 && delta < 30) return 'front';
    return null;
}

const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * 当日光位窗口（05文档 §6.2）
 * @param spot {geo:{coordinates:[lng,lat]}, heading, horizonProfile}
 * @param date Date（当日任意时刻）
 * @param weather {cloudy:boolean}|null
 * @returns {windows:[{start,end,light,trueSunset?}], trueSunset, geometricSunset, cloudy}
 */
function computeWindows(spot, date, weather = null) {
    const [lng, lat] = spot.geo.coordinates;
    if (weather?.cloudy) return { windows: [], cloudy: true, trueSunset: null, geometricSunset: null };

    const times = SunCalc.getTimes(date, lat, lng);
    const sunrise = times.sunrise, sunset = times.sunset;
    if (!sunrise || !sunset || isNaN(sunrise)) {
        return { windows: [], cloudy: false, trueSunset: null, geometricSunset: null };
    }
    const from = new Date(sunrise.getTime() - 30 * 60000);
    const to = new Date(sunset.getTime() + 30 * 60000);
    const STEP = 5 * 60000;

    const segments = []; // {t, light}
    const hasProfile = Array.isArray(spot.horizonProfile) && spot.horizonProfile.length === 360;
    let trueSunset = null;
    let prevVisible = false;

    for (let t = from.getTime(); t <= to.getTime(); t += STEP) {
        const d = new Date(t);
        const { azimuthDeg, elevationDeg } = sunPos(d, lat, lng);
        const visible = elevationDeg > horizonAt(spot.horizonProfile, azimuthDeg);
        // 黄昏侧首次下穿 horizon → 真日落（无遮挡曲线时直接用几何日落，避免采样量化误差）
        if (hasProfile && prevVisible && !visible && t > (sunrise.getTime() + sunset.getTime()) / 2) {
            trueSunset = trueSunset || d;
        }
        prevVisible = visible;
        if (!visible) { segments.push({ t: d, light: null }); continue; }
        let light = lightOf(angleDiff(azimuthDeg, spot.heading));
        if (elevationDeg < 10) light = 'golden'; // 黄金时刻覆盖
        segments.push({ t: d, light });
    }
    if (!trueSunset) trueSunset = sunset; // 无遮挡 → 几何日落

    // 相邻同 light 合并；<15min 丢弃
    const windows = [];
    let cur = null;
    for (const s of segments) {
        if (s.light && cur && cur.light === s.light) {
            cur.end = s.t;
        } else {
            if (cur && cur.end - cur.start >= 15 * 60000) windows.push(cur);
            cur = s.light ? { light: s.light, start: s.t, end: s.t } : null;
        }
    }
    if (cur && cur.end - cur.start >= 15 * 60000) windows.push(cur);

    return {
        windows: windows.map(w => ({
            start: hhmm(w.start), end: hhmm(w.end), light: w.light,
            startDate: w.start, endDate: w.end,
            ...(w.light === 'golden' && w.end >= trueSunset ? { trueSunset: hhmm(trueSunset) } : {})
        })),
        cloudy: false,
        trueSunset: hhmm(trueSunset),
        geometricSunset: hhmm(sunset)
    };
}

// 到达时刻与窗口的契合度 0~1（planner photoWindowFit 用）
function windowFit(windows, eta) {
    if (!windows?.length) return 0.5; // 无机位/无窗口 → 中性
    const t = eta instanceof Date ? eta : new Date(eta);
    const mins = t.getHours() * 60 + t.getMinutes();
    let best = 0;
    for (const w of windows) {
        const [sh, sm] = w.start.split(':').map(Number);
        const [eh, em] = w.end.split(':').map(Number);
        const s = sh * 60 + sm, e = eh * 60 + em;
        if (mins >= s && mins <= e) return 1;
        const dist = Math.min(Math.abs(mins - s), Math.abs(mins - e));
        best = Math.max(best, clamp(1 - dist / 120, 0, 1) * 0.8);
    }
    return best;
}

module.exports = { sunPos, horizonAt, lightOf, computeWindows, windowFit };
