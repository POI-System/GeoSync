'use strict';
// 05文档 §7：初始行程生成 —— 候选打分 → 贪心装载 → 2-opt → 黄金窗口对齐 → 时刻表。

const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { BizError } = require('../lib/respond');
const walkGraph = require('./walkGraph');
const forecast = require('./forecastService');
const sunlight = require('./sunlight');
const { clamp, dateStrOf } = require('../lib/geo');

const PACE_FACTOR = { relaxed: 1.3, normal: 1.0, tight: 0.8 };

/**
 * 生成行程（不落库，routes 层负责保存）
 * @returns { stops:[...], totalWalkMin, planNote }
 */
async function plan({ startLocation, startAt, hours, interests = [], pace = 'normal', accessible = false, shadeFirst = false, openId }) {
    if (!hours || hours < 1) throw new BizError(1102, '预算时长过短（至少1小时）');
    const { ExternalPoi, PhotoSpot, Checkin, Campaign } = getModels();
    const mode = accessible ? 'accessible' : shadeFirst ? 'shade' : 'standard';
    const t0 = startAt ? new Date(startAt) : new Date(Date.now() + 10 * 60000);
    const deadline = Date.now() + 3000; // 3s 熔断（05文档性能预算）

    // 0. 候选池 ≤80
    let pois = await ExternalPoi.find({ status: 'approved' }).lean();
    pois = pois.filter(p => walkGraph.poiCoords(p));
    if (!pois.length) throw new BizError(1202, '无可用候选POI');
    if (interests.length) {
        pois.sort((a, b) => interestMatch(b, interests) - interestMatch(a, interests));
    }
    pois = pois.slice(0, 80);

    // 热度（近30天打卡数）与活动加成，一次聚合
    const since = new Date(Date.now() - 30 * 86400000);
    const popRows = await Checkin.aggregate([
        { $match: { at: { $gte: since }, status: 'verified' } },
        { $group: { _id: '$poiId', n: { $sum: 1 } } }
    ]);
    const popMax = Math.max(1, ...popRows.map(r => r.n));
    const popMap = new Map(popRows.map(r => [String(r._id), r.n / popMax]));

    const now = new Date();
    const campaigns = await Campaign.find({ state: 'active', startAt: { $lte: now }, endAt: { $gte: now } }).lean();
    const boostMap = new Map();
    for (const c of campaigns) for (const pid of c.areaPoiIds) boostMap.set(String(pid), c.boostWeight);

    // 摄影窗口（best spot per poi）
    const spots = await PhotoSpot.find({ status: 'approved' }).sort({ score: -1 }).lean();
    const spotMap = new Map(); // poiIdStr → best spot
    for (const s of spots) {
        const k = String(s.poiId);
        if (!spotMap.has(k)) spotMap.set(k, s);
    }
    const todayStr = dateStrOf(t0);
    const windowsOf = poi => {
        const spot = spotMap.get(String(poi._id));
        if (!spot) return null;
        return (spot.goldenWindows || []).filter(w => w.date === todayStr);
    };

    // 1+2. 贪心装载
    const budgetMin = hours * 60 * 0.85; // 15% 弹性
    const paceF = PACE_FACTOR[pace] || 1;
    const chosen = [];
    const remaining = new Set(pois.map(p => String(p._id)));
    const poiById = new Map(pois.map(p => [String(p._id), p]));
    let cursor = { gateNodeId: '', geo: { coordinates: startLocation || CONFIG.scenicCenter } };
    let t = new Date(t0);
    let usedMin = 0;

    while (remaining.size && Date.now() < deadline) {
        let best = null, bestRatio = -Infinity;
        for (const id of remaining) {
            const poi = poiById.get(id);
            if (!withinOpenHours(poi, t)) continue;
            const route = walkGraph.walkSecBetween(cursor, poi, mode);
            if (!routeUsable(route, mode)) continue;
            const walkMin = route.walkSec / 60;
            const stayMin = (poi.visitMeta?.suggestedStayMin || 20) * paceF;
            const eta = new Date(t.getTime() + walkMin * 60000);
            const ciPred = forecast.predictAtEta(poi._id, eta) ?? 0.3;
            const queueMin = ciPred > 0.7 ? 15 : ciPred > 0.4 ? 5 : 0;
            const cost = walkMin + stayMin + queueMin;
            if (usedMin + cost > budgetMin) continue;

            const base =
                0.30 * (popMap.get(id) || 0) +
                0.25 * interestMatch(poi, interests) +
                0.20 * (1 - ciPred) +
                0.15 * sunlight.windowFit(windowsOf(poi), eta) +
                0.10 * 0.5 + // rating 占位：POI 平台暂无评分字段，中性 0.5
                (boostMap.get(id) || 0);
            const ratio = base / Math.max(cost, 1);
            if (ratio > bestRatio) {
                bestRatio = ratio;
                best = { poi, route, walkMin, stayMin, queueMin, cost, eta };
            }
        }
        if (!best) break;
        remaining.delete(String(best.poi._id));
        chosen.push(best);
        usedMin += best.cost;
        cursor = best.poi;
        t = new Date(best.eta.getTime() + (best.stayMin + best.queueMin) * 60000);
    }
    if (!chosen.length) throw new BizError(1202, '预算内无可安排的POI');

    // 3. 2-opt：交换降低总步行时间（≤200 次）
    let order = chosen.map(c => c.poi);
    let bestWalk = totalWalkSec(order, startLocation, mode);
    let iter = 0;
    outer:
    for (let round = 0; round < 20 && Date.now() < deadline; round++) {
        let improved = false;
        for (let i = 0; i < order.length - 1; i++) {
            for (let j = i + 1; j < order.length; j++) {
                if (++iter > 200) break outer;
                const cand = [...order];
                [cand[i], cand[j]] = [cand[j], cand[i]];
                const w = totalWalkSec(cand, startLocation, mode);
                if (w < bestWalk) { order = cand; bestWalk = w; improved = true; }
            }
        }
        if (!improved) break;
    }

    // 4. 黄金窗口对齐：摄影站偏窗 >30min → 尝试相邻交换
    const timeline = buildTimeline(order, startLocation, t0, paceF, mode);
    for (let i = 0; i < order.length; i++) {
        const wins = windowsOf(order[i]);
        if (!wins?.length) continue;
        if (offWindowMin(wins, timeline[i].plannedArrive) <= 30) continue;
        for (const j of [i - 1, i + 1]) {
            if (j < 0 || j >= order.length) continue;
            const cand = [...order];
            [cand[i], cand[j]] = [cand[j], cand[i]];
            const tl2 = buildTimeline(cand, startLocation, t0, paceF, mode);
            const iNew = cand.indexOf(order[i]);
            if (offWindowMin(wins, tl2[iNew].plannedArrive) < offWindowMin(wins, timeline[i].plannedArrive)) {
                order = cand;
                break;
            }
        }
    }

    // 5. 最终时刻表 + 路径
    const finalTl = buildTimeline(order, startLocation, t0, paceF, mode);
    const stops = order.map((poi, i) => ({
        poiId: poi._id,
        photoSpotId: spotMap.get(String(poi._id))?._id || null,
        plannedArrive: finalTl[i].plannedArrive,
        plannedLeave: finalTl[i].plannedLeave,
        state: 'pending',
        pathGeometry: finalTl[i].polyline
    }));
    const photoStop = order.find(p => {
        const w = windowsOf(p);
        return w?.length && offWindowMin(w, finalTl[order.indexOf(p)].plannedArrive) <= 30;
    });
    const planNote = photoStop
        ? `已为你把${photoStop.poiName}安排在光位窗口内`
        : `按${interests.join('/') || '综合'}偏好生成 ${stops.length} 站行程`;

    return {
        stops,
        totalWalkMin: Math.round(bestWalk / 60),
        planNote,
        enriched: finalTl.map((tl, i) => ({
            poiName: order[i].poiName,
            walkFromPrevMin: tl.walkFromPrevMin,
            goldenWindows: windowsOf(order[i]) || []
        }))
    };
}

function interestMatch(poi, interests) {
    if (!interests?.length) return 0.5;
    const tags = new Set([...(poi.visitMeta?.tags || []), poi.category].filter(Boolean));
    if (!tags.size) return 0.3;
    const hit = interests.filter(i => [...tags].some(t => String(t).includes(i) || i.includes(String(t)))).length;
    const union = new Set([...tags, ...interests]).size;
    return hit / Math.max(union, 1) + (hit ? 0.4 : 0); // Jaccard + 命中奖励
}

function withinOpenHours(poi, t) {
    const hrs = poi.visitMeta?.openHours;
    if (!hrs?.length) return true;
    const mins = t.getHours() * 60 + t.getMinutes();
    return hrs.some(h => {
        const [sh, sm] = h.start.split(':').map(Number);
        const [eh, em] = h.end.split(':').map(Number);
        return mins >= sh * 60 + sm && mins <= eh * 60 + em;
    });
}

function totalWalkSec(order, startLocation, mode) {
    let cursor = { gateNodeId: '', geo: { coordinates: startLocation || CONFIG.scenicCenter } };
    let sec = 0;
    for (const poi of order) {
        const r = walkGraph.walkSecBetween(cursor, poi, mode);
        if (!routeUsable(r, mode)) return Infinity;
        sec += r.walkSec;
        cursor = poi;
    }
    return sec;
}

function buildTimeline(order, startLocation, t0, paceF, mode) {
    let cursor = { gateNodeId: '', geo: { coordinates: startLocation || CONFIG.scenicCenter } };
    let t = new Date(t0);
    const out = [];
    for (const poi of order) {
        const r = walkGraph.walkSecBetween(cursor, poi, mode);
        if (!routeUsable(r, mode)) {
            throw new BizError(1201, '步行路网无法生成所需路线');
        }
        const walkMin = r.walkSec / 60;
        const arrive = new Date(t.getTime() + walkMin * 60000);
        const stayMin = (poi.visitMeta?.suggestedStayMin || 20) * paceF;
        const leave = new Date(arrive.getTime() + stayMin * 60000);
        out.push({
            plannedArrive: arrive, plannedLeave: leave,
            walkFromPrevMin: Math.round(walkMin),
            polyline: walkGraph.pathPolyline(r)
        });
        cursor = poi;
        t = leave;
    }
    return out;
}

function routeUsable(route, mode) {
    return Boolean(route) && !(mode === 'accessible' && route.fallback === true);
}

function offWindowMin(windows, eta) {
    const t = new Date(eta);
    const mins = t.getHours() * 60 + t.getMinutes();
    let best = Infinity;
    for (const w of windows) {
        const [sh, sm] = w.start.split(':').map(Number);
        const [eh, em] = w.end.split(':').map(Number);
        const s = sh * 60 + sm, e = eh * 60 + em;
        if (mins >= s && mins <= e) return 0;
        best = Math.min(best, Math.abs(mins - (s + e) / 2));
    }
    return best;
}

module.exports = { plan, interestMatch, offWindowMin, buildTimeline, routeUsable };
