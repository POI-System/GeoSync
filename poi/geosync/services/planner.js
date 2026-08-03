'use strict';
// 05文档 §7：初始行程生成 —— 候选打分 → 贪心装载 → 2-opt → 黄金窗口对齐 → 时刻表。

const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { BizError } = require('../lib/respond');
const { NoRouteError } = require('../integrations/supermap/errors');
const forecast = require('./forecastService');
const sunlight = require('./sunlight');
const { dateStrOf, encodePolyline, haversine } = require('../lib/geo');

const PACE_FACTOR = { relaxed: 1.3, normal: 1.0, tight: 0.8 };
const WALK_SPEED_MPS = 1.4;
const PLANNER_OPTIMIZATION_BUDGET_MS = 3000;

/**
 * 生成行程（不落库，routes 层负责保存）
 * @returns { stops:[...], totalWalkMin, planNote }
 */
async function plan({
    startLocation,
    startAt,
    hours,
    interests = [],
    pace = 'normal',
    accessible = false,
    shadeFirst = false,
    openId,
    requestId
}, deps = {}) {
    if (!hours || hours < 1) throw new BizError(1102, '预算时长过短（至少1小时）');
    const estimateBetween = deps.estimateBetween || defaultEstimateBetween;
    const routeBetween = deps.routeBetween;
    const budgetNow = deps.budgetNow || Date.now;
    if (typeof estimateBetween !== 'function') {
        throw new TypeError('planner estimateBetween must be a function');
    }
    if (typeof routeBetween !== 'function') {
        throw new TypeError('planner routeBetween must be an async function');
    }
    if (typeof budgetNow !== 'function') {
        throw new TypeError('planner budgetNow must be a function');
    }
    const { ExternalPoi, PhotoSpot, Checkin, Campaign } = getModels();
    const mode = accessible ? 'accessible' : shadeFirst ? 'shade' : 'normal';
    const t0 = startAt ? new Date(startAt) : new Date(Date.now() + 10 * 60000);

    // 0. 候选池 ≤80
    let pois = await ExternalPoi.find({ status: 'approved' }).lean();
    pois = pois.filter(p => coordinatesOf(p));
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

    // Mongo 候选数据准备不占用启发式优化的 3 秒计算预算。
    const deadline = budgetNow() + PLANNER_OPTIMIZATION_BUDGET_MS;

    // 1+2. 贪心装载
    const budgetMin = hours * 60 * 0.85; // 15% 弹性
    const paceF = PACE_FACTOR[pace] || 1;
    const chosen = [];
    const remaining = new Set(pois.map(p => String(p._id)));
    const poiById = new Map(pois.map(p => [String(p._id), p]));
    let cursor = startAnchor(startLocation);
    let t = new Date(t0);
    let usedMin = 0;

    while (remaining.size && budgetNow() < deadline) {
        let best = null, bestRatio = -Infinity;
        for (const id of remaining) {
            const poi = poiById.get(id);
            if (!withinOpenHours(poi, t)) continue;
            const route = syncEstimate(estimateBetween, cursor, poi, mode);
            if (!routeUsable(route, mode)) continue;
            const walkMin = route.walkSec / 60;
            const stayMin = (poi.visitMeta?.suggestedStayMin || 20) * paceF;
            const eta = new Date(t.getTime() + walkMin * 60000);
            const ciPred = forecast.predictAtEta(poi._id, eta) ?? 0.3;
            const queueMin = queueMinutes(ciPred);
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
    let bestWalk = totalWalkSec(order, startLocation, mode, estimateBetween);
    let iter = 0;
    outer:
    for (let round = 0; round < 20 && budgetNow() < deadline; round++) {
        let improved = false;
        for (let i = 0; i < order.length - 1; i++) {
            for (let j = i + 1; j < order.length; j++) {
                if (++iter > 200) break outer;
                const cand = [...order];
                [cand[i], cand[j]] = [cand[j], cand[i]];
                const w = totalWalkSec(cand, startLocation, mode, estimateBetween);
                if (w < bestWalk) { order = cand; bestWalk = w; improved = true; }
            }
        }
        if (!improved) break;
    }

    // 4. 黄金窗口对齐：摄影站偏窗 >30min → 尝试相邻交换
    const timeline = buildTimeline(order, startLocation, t0, paceF, mode, estimateBetween);
    for (let i = 0; i < order.length; i++) {
        const wins = windowsOf(order[i]);
        if (!wins?.length) continue;
        if (offWindowMin(wins, timeline[i].plannedArrive) <= 30) continue;
        for (const j of [i - 1, i + 1]) {
            if (j < 0 || j >= order.length) continue;
            const cand = [...order];
            [cand[i], cand[j]] = [cand[j], cand[i]];
            const tl2 = buildTimeline(cand, startLocation, t0, paceF, mode, estimateBetween);
            const iNew = cand.indexOf(order[i]);
            if (offWindowMin(wins, tl2[iNew].plannedArrive) < offWindowMin(wins, timeline[i].plannedArrive)) {
                order = cand;
                break;
            }
        }
    }

    // 5. 最终时刻表 + 路径
    const authoritative = await buildAuthoritativeTimeline(
        order,
        startLocation,
        t0,
        paceF,
        mode,
        { routeBetween, openId, requestId, budgetMin }
    );
    if (!authoritative.timeline.length) {
        throw new BizError(1202, '权威路径超出行程预算');
    }
    if (authoritative.timeline.length < order.length) {
        order = order.slice(0, authoritative.timeline.length);
    }
    const finalTl = authoritative.timeline;
    const stops = order.map((poi, i) => ({
        poiId: poi._id,
        photoSpotId: spotMap.get(String(poi._id))?._id || null,
        plannedArrive: finalTl[i].plannedArrive,
        plannedLeave: finalTl[i].plannedLeave,
        state: 'pending',
        geometry: finalTl[i].geometry,
        distanceM: finalTl[i].distanceM,
        durationSec: finalTl[i].durationSec,
        gis: finalTl[i].gis,
        segments: finalTl[i].segments,
        snap: finalTl[i].snap,
        verifiedAccessible: finalTl[i].verifiedAccessible,
        pathGeometry: finalTl[i].pathGeometry
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
        route: authoritative.route,
        totalWalkMin: Math.round(authoritative.route.durationSec / 60),
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

function totalWalkSec(order, startLocation, mode, estimateBetween = defaultEstimateBetween) {
    let cursor = startAnchor(startLocation);
    let sec = 0;
    for (const poi of order) {
        const r = syncEstimate(estimateBetween, cursor, poi, mode);
        if (!routeUsable(r, mode)) return Infinity;
        sec += r.walkSec;
        cursor = poi;
    }
    return sec;
}

function buildTimeline(order, startLocation, t0, paceF, mode, estimateBetween = defaultEstimateBetween) {
    let cursor = startAnchor(startLocation);
    let t = new Date(t0);
    const out = [];
    for (const poi of order) {
        const r = syncEstimate(estimateBetween, cursor, poi, mode);
        if (!routeUsable(r, mode)) {
            throw new BizError(1201, '步行路网无法生成所需路线');
        }
        const walkMin = r.walkSec / 60;
        const arrive = new Date(t.getTime() + walkMin * 60000);
        const stayMin = (poi.visitMeta?.suggestedStayMin || 20) * paceF;
        const queueMin = queueMinutes(forecast.predictAtEta(poi._id, arrive) ?? 0.3);
        const leave = new Date(arrive.getTime() + (stayMin + queueMin) * 60000);
        out.push({
            plannedArrive: arrive, plannedLeave: leave,
            walkFromPrevMin: Math.round(walkMin),
            polyline: estimatePolyline(r)
        });
        cursor = poi;
        t = leave;
    }
    return out;
}

function routeUsable(route, mode) {
    return Boolean(route)
        && Number.isFinite(route.walkSec)
        && route.walkSec >= 0
        && !(mode === 'accessible' && (
            route.fallback === true || route.gis?.source === 'local-fallback'
        ));
}

function coordinatesOf(value) {
    const raw = Array.isArray(value)
        ? value
        : value?.geo?.coordinates || value?.coordinates ||
            (value?.location?.lng != null && value?.location?.lat != null
                ? [value.location.lng, value.location.lat]
                : null);
    if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(Number.isFinite)) return null;
    return [raw[0], raw[1]];
}

function startAnchor(startLocation) {
    return {
        gateNodeId: '',
        geo: {
            type: 'Point',
            coordinates: coordinatesOf(startLocation) || [...CONFIG.scenicCenter]
        }
    };
}

function defaultEstimateBetween(fromPoi, toPoi) {
    const start = coordinatesOf(fromPoi);
    const end = coordinatesOf(toPoi);
    if (!start || !end) return null;
    const distanceM = haversine(start, end);
    return {
        walkSec: Math.round(distanceM / WALK_SPEED_MPS),
        distanceM,
        coords: [start, end],
        fallback: false
    };
}

function syncEstimate(estimateBetween, fromPoi, toPoi, mode) {
    const route = estimateBetween(fromPoi, toPoi, mode);
    if (route && typeof route.then === 'function') {
        throw new TypeError('planner estimateBetween must be synchronous');
    }
    return route;
}

function estimatePolyline(route) {
    if (typeof route?.pathGeometry === 'string') return route.pathGeometry;
    const coordinates = route?.geometry?.type === 'LineString'
        ? route.geometry.coordinates
        : route?.coords;
    return Array.isArray(coordinates) && coordinates.length
        ? encodePolyline(coordinates)
        : '';
}

async function buildAuthoritativeTimeline(
    order,
    startLocation,
    t0,
    paceF,
    mode,
    { routeBetween, openId, requestId, budgetMin } = {}
) {
    if (typeof routeBetween !== 'function') {
        throw new TypeError('planner routeBetween must be an async function');
    }

    let cursor = startAnchor(startLocation);
    const legs = order.map((poi, legIndex) => {
        const leg = { fromPoi: cursor, toPoi: poi, legIndex };
        cursor = poi;
        return leg;
    });
    const rawRoutes = await Promise.all(legs.map(leg => routeBetween(
        leg.fromPoi,
        leg.toPoi,
        mode,
        { legIndex: leg.legIndex, openId, requestId }
    )));
    const routes = rawRoutes.map((route, legIndex) =>
        normalizeAuthoritativeRoute(route, mode, { legIndex, requestId }));

    let cursorAt = new Date(t0);
    const budgetDeadline = Number.isFinite(budgetMin) && budgetMin > 0
        ? new Date(cursorAt.getTime() + budgetMin * 60000)
        : null;
    const timeline = [];
    const acceptedRoutes = [];
    for (let index = 0; index < routes.length; index++) {
        const route = routes[index];
        const poi = order[index];
        const arrive = new Date(cursorAt.getTime() + route.durationSec * 1000);
        const stayMin = (poi.visitMeta?.suggestedStayMin || 20) * paceF;
        const queueMin = queueMinutes(forecast.predictAtEta(poi._id, arrive) ?? 0.3);
        const leave = new Date(arrive.getTime() + (stayMin + queueMin) * 60000);
        if (budgetDeadline && leave > budgetDeadline) break;
        cursorAt = leave;
        acceptedRoutes.push(route);
        timeline.push({
            plannedArrive: arrive,
            plannedLeave: leave,
            walkFromPrevMin: Math.round(route.durationSec / 60),
            geometry: route.geometry,
            distanceM: route.distanceM,
            durationSec: route.durationSec,
            gis: route.gis,
            segments: route.segments,
            snap: route.snap,
            verifiedAccessible: route.verifiedAccessible,
            pathGeometry: route.pathGeometry,
            polyline: route.pathGeometry
        });
    }

    return {
        timeline,
        route: aggregateAuthoritativeRoutes(acceptedRoutes, mode)
    };
}

function queueMinutes(ciPrediction) {
    return ciPrediction > 0.7 ? 15 : ciPrediction > 0.4 ? 5 : 0;
}

function normalizeAuthoritativeRoute(route, mode, context = {}) {
    const localFallback = route?.fallback === true || route?.gis?.source === 'local-fallback';
    const verifiedAccessible = route?.verifiedAccessible === true || route?.accessibleVerified === true;
    if (mode === 'accessible' && localFallback && !verifiedAccessible) {
        throw new NoRouteError(undefined, {
            operation: 'findPath',
            requestId: context.requestId,
            category: 'no-route',
            retryable: false
        });
    }
    if (!route || !Number.isFinite(route.durationSec) || route.durationSec < 0) {
        throw new BizError(1201, 'authoritative route durationSec must be a non-negative number');
    }
    if (!Number.isFinite(route.distanceM) || route.distanceM < 0) {
        throw new BizError(1201, 'authoritative route distanceM must be a non-negative number');
    }

    const geometry = normalizeLineString(route.geometry);
    const pathGeometry = encodePolyline(geometry.coordinates);
    return {
        geometry,
        distanceM: route.distanceM,
        durationSec: route.durationSec,
        gis: route.gis && typeof route.gis === 'object' ? { ...route.gis } : null,
        segments: Array.isArray(route.segments)
            ? route.segments.map(segment => ({ ...segment }))
            : [],
        snap: route.snap && typeof route.snap === 'object' ? { ...route.snap } : null,
        verifiedAccessible,
        pathGeometry
    };
}

function normalizeLineString(geometry) {
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
        throw new BizError(1201, 'authoritative route geometry must be a GeoJSON LineString');
    }
    const coordinates = geometry.coordinates.map(position => {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
            throw new BizError(1201, 'authoritative route geometry contains an invalid coordinate');
        }
        return [position[0], position[1]];
    });
    if (coordinates.length < 2) {
        throw new BizError(1201, 'authoritative route geometry must contain at least two coordinates');
    }
    return { type: 'LineString', coordinates };
}

function aggregateAuthoritativeRoutes(routes, mode) {
    const coordinates = [];
    const segments = [];
    let distanceM = 0;
    let durationSec = 0;
    for (const route of routes) {
        distanceM += route.distanceM;
        durationSec += route.durationSec;
        segments.push(...route.segments.map(segment => ({ ...segment })));
        for (const position of route.geometry.coordinates) {
            if (!coordinates.length || !samePosition(coordinates[coordinates.length - 1], position)) {
                coordinates.push([...position]);
            }
        }
    }

    const geometry = { type: 'LineString', coordinates };
    const firstSnap = routes[0]?.snap;
    const lastSnap = routes[routes.length - 1]?.snap;
    const snap = firstSnap || lastSnap ? {
        startDistanceM: firstSnap?.startDistanceM ?? null,
        endDistanceM: lastSnap?.endDistanceM ?? null
    } : null;
    return {
        geometry,
        distanceM,
        durationSec,
        gis: aggregateGis(routes, mode),
        segments,
        snap,
        verifiedAccessible: routes.length > 0 && routes.every(route => route.verifiedAccessible === true),
        pathGeometry: coordinates.length ? encodePolyline(coordinates) : ''
    };
}

function aggregateGis(routes, mode) {
    const entries = routes.map(route => route.gis).filter(Boolean);
    if (!entries.length) return null;
    const first = entries[0];
    const source = entries.some(gis => gis.source === 'local-fallback')
        ? 'local-fallback'
        : entries.some(gis => gis.source === 'cache')
            ? 'cache'
            : first.source;
    const dataVersions = [...new Set(entries.map(gis => gis.dataVersion).filter(Boolean))];
    const durationMs = entries.reduce((sum, gis) =>
        sum + (Number.isFinite(gis.durationMs) ? gis.durationMs : 0), 0);
    return {
        ...first,
        source,
        mode,
        degraded: entries.some(gis => gis.degraded === true || gis.source === 'local-fallback'),
        durationMs,
        dataVersion: dataVersions.length === 1 ? dataVersions[0] : null
    };
}

function samePosition(left, right) {
    return left[0] === right[0] && left[1] === right[1];
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

module.exports = {
    plan,
    interestMatch,
    offWindowMin,
    buildTimeline,
    buildAuthoritativeTimeline,
    defaultEstimateBetween,
    aggregateAuthoritativeRoutes,
    routeUsable
};
