'use strict';
// 05文档 §2：CI 三分量预测（趋势 EWMA 外推 + 周期基线 + 行程流入）。

const { getModels } = require('../models');
const { clamp, timeSlotOf } = require('../lib/geo');
const memCache = require('../lib/memCache');

// 活跃行程到达索引：Map<poiIdStr, [{itineraryId, plannedArrive}]>（引擎/预测/antiHerding 共用）
let arrivalIndex = new Map();

async function rebuildArrivalIndex() {
    const { Itinerary } = getModels();
    const actives = await Itinerary.find(
        { state: 'active' },
        { stops: 1 }
    ).lean();
    const idx = new Map();
    for (const it of actives) {
        for (const s of it.stops) {
            if (s.state !== 'pending' && s.state !== 'approaching') continue;
            const key = String(s.poiId);
            if (!idx.has(key)) idx.set(key, []);
            idx.get(key).push({ itineraryId: it._id, plannedArrive: s.plannedArrive });
        }
    }
    arrivalIndex = idx;
}

function getArrivalIndex() { return arrivalIndex; }

// 到达数：plannedArrive ∈ [t−15min, t+15min]
function arrivingCount(poiId, t) {
    const list = arrivalIndex.get(String(poiId)) || [];
    const lo = t.getTime() - 15 * 60000, hi = t.getTime() + 15 * 60000;
    return list.filter(a => {
        const ts = new Date(a.plannedArrive).getTime();
        return ts >= lo && ts <= hi;
    }).length;
}

function dayTypeOf(date, holidaySet = null) {
    const d = new Date(date);
    const key = timeSlotOf(d).slice(0, 10);
    if (holidaySet?.has(key)) return 'holiday';
    const dow = d.getDay();
    return (dow === 0 || dow === 6) ? 'weekend' : 'workday';
}

// EWMA 平滑 + 线性外推（纯函数，单测覆盖）
function trendExtrapolate(recentCis, deltaSlots, alpha = 0.4) {
    if (!recentCis.length) return null;
    let ewma = recentCis[0], prev = recentCis[0];
    for (const v of recentCis.slice(1)) {
        prev = ewma;
        ewma = alpha * v + (1 - alpha) * ewma;
    }
    const slope = ewma - prev;
    return clamp(ewma + slope * deltaSlots, 0, 1);
}

/**
 * 预测单 POI 的 CI（deltaMin=30|60）
 * @param ctx { recentCis:[近6片ci 旧→新], seasonalMean:number|null, comfortCapacity, poiId, targetTime:Date }
 */
function predict(ctx, deltaMin) {
    const deltaSlots = deltaMin / 10;
    const trend = trendExtrapolate(ctx.recentCis || [], deltaSlots);
    const seasonal = ctx.seasonalMean != null ? ctx.seasonalMean : 0.3; // 退化链末端
    const rerouteRate = memCache.get('globalRerouteRate') ?? 0.2;
    const inflow = clamp(
        arrivingCount(ctx.poiId, ctx.targetTime) * (1 - rerouteRate) / Math.max(ctx.comfortCapacity || 50, 1),
        0, 1
    );
    const [l1, l2, l3] = deltaMin <= 30 ? [0.5, 0.3, 0.2] : [0.25, 0.5, 0.25];
    const t = trend != null ? trend : seasonal; // 无趋势数据（新POI）用周期项顶替
    return clamp(l1 * t + l2 * seasonal + l3 * inflow, 0, 1);
}

// 批量周期基线：近8周同 dayType 同时段均值（jobs/ciForecast 一次聚合出全部 POI）
async function seasonalMeans(poiIds, targetTime) {
    const { CrowdSnapshot } = getModels();
    const dt = dayTypeOf(targetTime);
    const hhmm = timeSlotOf(targetTime).slice(11);
    const since = new Date(Date.now() - 56 * 86400000);
    const rows = await CrowdSnapshot.aggregate([
        { $match: { poiId: { $in: poiIds }, slotStart: { $gte: since }, timeSlot: { $regex: `T${hhmm}$` } } },
        { $group: { _id: '$poiId', cis: { $push: '$crowdIndex' }, slots: { $push: '$slotStart' } } }
    ]);
    const map = new Map();
    for (const r of rows) {
        // 过滤同 dayType
        const vals = [];
        for (let i = 0; i < r.cis.length; i++) {
            if (dayTypeOf(r.slots[i]) === dt) vals.push(r.cis[i]);
        }
        if (vals.length >= 3) {
            map.set(String(r._id), vals.reduce((a, b) => a + b, 0) / vals.length);
        }
    }
    return map; // 缺失 POI → 调用方走退化链
}

// forecast 内存缓存（planner/引擎读）
function setForecastCache(map) { memCache.set('forecast', map); }
function getForecast(poiId) {
    const m = memCache.get('forecast');
    return m ? m.get(String(poiId)) || null : null; // {p30, p60}
}

// 预测某到达时刻的 CI：就近取 p30/p60，超1h 用周期项近似（当前实现取 p60）
function predictAtEta(poiId, eta) {
    const f = getForecast(poiId);
    if (!f) return null;
    const deltaMin = (new Date(eta).getTime() - Date.now()) / 60000;
    if (deltaMin <= 40) return f.p30;
    return f.p60;
}

module.exports = {
    rebuildArrivalIndex, getArrivalIndex, arrivingCount,
    dayTypeOf, trendExtrapolate, predict, seasonalMeans,
    setForecastCache, getForecast, predictAtEta
};
