'use strict';
// 05文档 §4：GeoSync 重规划引擎 —— 事件消费、evaluate 主流程、收益函数、
// applyProposal 纯函数（accept 路由与前端 diff 共用）、文案模板。

const crypto = require('crypto');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const bus = require('../lib/eventBus');
const memCache = require('../lib/memCache');
const geo = require('../lib/geo');
const walkGraph = require('./walkGraph');
const forecast = require('./forecastService');
const antiHerding = require('./antiHerding');

const EVAL_COOLDOWN_MS = 3 * 60000; // 同行程 evaluate 间隔 ≥3min
const PROPOSAL_TTL_MS = 10 * 60000;

function tokenKey(value) {
    if (value === undefined || value === null) return null;
    const key = String(value);
    return key || null;
}

function createTokenTracker(releaseTokens) {
    const held = new Map();

    return {
        track(tokenIds) {
            for (const tokenId of tokenIds || []) {
                const key = tokenKey(tokenId);
                if (key) held.set(key, tokenId);
            }
        },
        async release(tokenIds = [...held.values()]) {
            const selected = new Map();
            for (const tokenId of tokenIds || []) {
                const key = tokenKey(tokenId);
                if (key && held.has(key)) selected.set(key, held.get(key));
            }
            if (!selected.size) return;
            await releaseTokens([...selected.values()]);
            for (const key of selected.keys()) held.delete(key);
        },
        async releaseAll() {
            await this.release([...held.values()]);
        },
        transferAll() {
            held.clear();
        }
    };
}

async function rethrowAfterCleanup(error, cleanup) {
    try {
        await cleanup();
    } catch (cleanupError) {
        throw new AggregateError(
            [error, cleanupError],
            'Proposal evaluation failed and capacity token cleanup also failed'
        );
    }
    throw error;
}

// ---------- 事件订阅（index.js 启动时调用 init） ----------
function init() {
    bus.on(bus.EVENTS.CI_LEVEL_CHANGED, async ({ poiId, level }) => {
        if (level !== 'high') return;
        const its = await affectedItineraries(poiId);
        for (const it of its) await safeEvaluate(it, 'crowd');
    });
    bus.on(bus.EVENTS.RAIN_INCOMING, async payload => {
        const { Itinerary } = getModels();
        const its = await Itinerary.find({ state: 'active' });
        for (const it of its) await safeEvaluate(it, 'rain', payload);
    });
    bus.on(bus.EVENTS.POSITION_REPORTED, async p => {
        const { Itinerary } = getModels();
        const it = await Itinerary.findOne({ openId: p.openId, state: 'active' });
        if (!it) return;
        // 更新 lastPosition（不走乐观锁，运行时字段）
        it.lastPosition = { lng: p.lng, lat: p.lat, at: new Date() };
        await it.save().catch(() => {}); // 与提案写入竞争时放弃本次位置更新
        // 偏离检测
        const cur = it.stops.find(s => s.state === 'approaching' || s.state === 'pending');
        if (cur?.pathGeometry) {
            const line = geo.decodePolyline(cur.pathGeometry);
            const d = geo.distToPolyline([p.lng, p.lat], line);
            if (d > 200) {
                bus.emit(bus.EVENTS.ITINERARY_DEVIATED, { itineraryId: it._id, distanceM: d });
                await safeEvaluate(it, 'deviation');
            }
        }
    });
    console.log('[GeoSync] [ENGINE] event consumers registered');
}

async function affectedItineraries(poiId) {
    const { Itinerary } = getModels();
    return Itinerary.find({
        state: 'active',
        stops: { $elemMatch: { poiId, state: { $in: ['pending', 'approaching'] } } }
    });
}

async function safeEvaluate(it, trigger, extra = null) {
    const key = `eval:${it._id}`;
    if (memCache.get(key)) return; // 冷却中
    if (it.pendingProposal?.proposalId) return; // 已有待决提案
    memCache.set(key, 1, EVAL_COOLDOWN_MS);
    try {
        await evaluate(it, trigger, extra);
    } catch (e) {
        console.error('[GeoSync] [ENGINE] evaluate failed:', e?.name || 'Error');
    }
}

// ---------- evaluate 主流程 ----------
async function evaluate(it, trigger, extra = null) {
    if (it.preferences?.noDisturb) {
        console.log(`[GeoSync] [ENGINE] ${it._id} noDisturb, skip (trigger=${trigger})`);
        return;
    }
    const tokenTracker = createTokenTracker(tokenIds =>
        antiHerding.releaseTokens(tokenIds, it._id));
    try {
        return await evaluateCandidates(it, trigger, extra, tokenTracker);
    } catch (error) {
        return rethrowAfterCleanup(error, () => tokenTracker.releaseAll());
    }
}

async function evaluateCandidates(it, trigger, extra, tokenTracker) {
    const { ExternalPoi } = getModels();
    const proposalExpireAt = new Date(Date.now() + PROPOSAL_TTL_MS);
    const remaining = it.stops.filter(s => ['pending', 'approaching'].includes(s.state));
    if (!remaining.length) return;

    const poiIds = [...new Set(it.stops.map(s => String(s.poiId)))];
    const pois = await ExternalPoi.find({ _id: { $in: poiIds } }).lean();
    const poiMap = new Map(pois.map(p => [String(p._id), p]));

    // 候选提案（每类型至多1个）
    const candidates = [];
    if (trigger === 'rain' && extra) {
        const c = buildRainShift(it, remaining, poiMap, extra);
        if (c) candidates.push(c);
    } else {
        const crowdedStop = remaining.find(s => {
            const heat = getHeat(s.poiId);
            return heat && heat.level === 'high';
        });
        if (crowdedStop) {
            const swap = buildSwap(it, remaining, crowdedStop, poiMap);
            if (swap) candidates.push(swap);
            const replace = await buildReplace(it, crowdedStop, poiMap, proposalExpireAt);
            if (replace) {
                tokenTracker.track(replace.tokenIds);
                candidates.push(replace);
            }
            const delay = buildDelay(it, crowdedStop, poiMap);
            if (delay) candidates.push(delay);
        }
        const drop = buildDrop(it, remaining, poiMap);
        if (drop) candidates.push(drop);
    }
    if (!candidates.length) return;

    // 择优 + 阈值
    const threshold = CONFIG.rerouteGainMin * (it.rerouteCount >= CONFIG.rerouteDailySoftLimit ? 2 : 1);
    const best = await selectCandidate(candidates, threshold, tokenIds =>
        tokenTracker.release(tokenIds));
    if (!best) return;

    // 写 pendingProposal（乐观锁）
    const { Itinerary } = getModels();
    const proposal = {
        proposalId: 'p_' + crypto.randomBytes(4).toString('hex'),
        type: best.type,
        payload: best.payload,
        reason: best.reason,
        gainMin: Math.round(best.gainMin),
        tokenIds: best.tokenIds || [],
        expireAt: proposalExpireAt
    };
    const updated = await Itinerary.findOneAndUpdate(
        { _id: it._id, version: it.version, 'pendingProposal.proposalId': null },
        { $set: { pendingProposal: proposal }, $inc: { version: 1 } },
        { new: true }
    ) || await Itinerary.findOneAndUpdate(
        { _id: it._id, version: it.version, pendingProposal: null },
        { $set: { pendingProposal: proposal }, $inc: { version: 1 } },
        { new: true }
    );
    if (!updated) {
        await tokenTracker.releaseAll();
        return;
    }
    tokenTracker.transferAll();
    bus.emit(bus.EVENTS.REROUTE_PROPOSED, { itinerary: updated, proposal });
    console.log(`[GeoSync] [ENGINE] proposal ${proposal.proposalId} (${proposal.type}, +${proposal.gainMin}min) itinerary=${it._id}`);
}

async function selectCandidate(candidates, threshold, release = antiHerding.releaseTokens) {
    if (!candidates?.length) return null;
    const ranked = [...candidates].sort((a, b) => b.gainMin - a.gainMin);
    const best = ranked[0];
    const allTokenIds = ranked.flatMap(candidate => candidate.tokenIds || []);
    if (best.gainMin <= threshold) {
        await release(allTokenIds);
        return null;
    }
    const bestTokenSet = new Set((best.tokenIds || []).map(String));
    await release(allTokenIds.filter(id => !bestTokenSet.has(String(id))));
    return best;
}

// ---------- 候选构造 ----------
function getHeat(poiId) {
    const snap = memCache.get('heatmap');
    return snap?.items?.find(i => String(i.poiId) === String(poiId)) || null;
}

function queueFullMin(poi) {
    const heat = getHeat(poi._id);
    if (heat?.queueEstMin) return heat.queueEstMin;
    return 30; // 缺数据默认
}

function ciNow(poiId) { return getHeat(poiId)?.ci ?? 0.3; }

function queueSaved(targetPoi, etaAlt) {
    const pred = forecast.predictAtEta(targetPoi._id, etaAlt) ?? ciNow(targetPoi._id) * 0.8;
    return Math.max(0, (ciNow(targetPoi._id) - pred) * queueFullMin(targetPoi));
}

// swap：拥挤站与后面一个不挤的站交换
function buildSwap(it, remaining, crowdedStop, poiMap) {
    const idx = remaining.indexOf(crowdedStop);
    const later = remaining.slice(idx + 1).find(s => {
        const h = getHeat(s.poiId);
        return !h || h.level === 'low';
    });
    if (!later) return null;
    const target = poiMap.get(String(crowdedStop.poiId));
    const alt = poiMap.get(String(later.poiId));
    if (!target || !alt) return null;
    const saved = queueSaved(target, later.plannedArrive);
    const walkDelta = 3; // 简化：交换顺序步行增量按小常数估计；精确重排在 accept 后做
    const gainMin = saved - walkDelta;
    return {
        type: 'swap', gainMin,
        payload: { stopIdA: crowdedStop._id, stopIdB: later._id },
        reason: `${target.poiName}现在排队约${queueFullMin(target)}分钟，建议先去${alt.poiName}（当前人少），预计省${Math.round(gainMin)}分钟`
    };
}

// replace：同类冷门替身（走 antiHerding）
async function buildReplace(it, crowdedStop, poiMap, holdUntil) {
    const { ExternalPoi } = getModels();
    const target = poiMap.get(String(crowdedStop.poiId));
    if (!target) return null;
    const coords = walkGraph.poiCoords(target);
    if (!coords) return null;

    const alts = await ExternalPoi.find({
        status: 'approved', category: target.category, _id: { $ne: target._id }
    }).lean();
    const candidates = [];
    const mode = it.preferences?.accessible
        ? 'accessible'
        : it.preferences?.shadeFirst ? 'shade' : 'standard';
    for (const alt of alts) {
        const c = walkGraph.poiCoords(alt);
        if (!c || geo.haversine(coords, c) > 1500) continue;
        const heat = getHeat(alt._id);
        if (heat?.level === 'high') continue;
        const eta = crowdedStop.plannedArrive;
        const route = walkGraph.walkSecBetween(target, alt, mode);
        if (!route || (mode === 'accessible' && route.fallback)) continue;
        const walkDelta = route.walkSec / 60;
        const gain = queueSaved(target, eta) - walkDelta;
        if (gain <= 0) continue;
        candidates.push({
            poi: alt, gain,
            etaSlot: geo.timeSlotOf(eta), targetTime: new Date(eta), holdUntil
        });
    }
    candidates.sort((a, b) => b.gain - a.gain);
    const picked = await antiHerding.pickAlternative(candidates.slice(0, 5), it._id);
    if (!picked) return null;
    try {
        const distM = Math.round(geo.haversine(coords, walkGraph.poiCoords(picked.poi)));
        return {
            type: 'replace', gainMin: picked.gain, tokenIds: [picked.tokenId],
            payload: {
                stopId: crowdedStop._id,
                newPoiId: picked.poi._id,
                newPhotoSpotId: null,
                capacityTokenId: picked.tokenId
            },
            reason: `${target.poiName}拥挤，${picked.poi.poiName}（${distM}m外）视野相近且空闲，预计省${Math.round(picked.gain)}分钟`
        };
    } catch (error) {
        return rethrowAfterCleanup(error, () =>
            antiHerding.releaseTokens([picked.tokenId], it._id));
    }
}

// delay：原地延后（预测回落）
function buildDelay(it, crowdedStop, poiMap) {
    const target = poiMap.get(String(crowdedStop.poiId));
    if (!target) return null;
    const f = forecast.getForecast(crowdedStop.poiId);
    if (!f || f.p30 >= ciNow(crowdedStop.poiId) - 0.15) return null; // 30min后无明显回落
    const saved = (ciNow(crowdedStop.poiId) - f.p30) * queueFullMin(target);
    return {
        type: 'delay', gainMin: saved,
        payload: { stopId: crowdedStop._id, delayMin: 25, fillPoiId: null },
        reason: `建议先在附近休息，${target.poiName}预计25分钟后人流回落，可省约${Math.round(saved)}分钟排队`
    };
}

// drop：时间预算不足时放弃末位低分站
function buildDrop(it, remaining, poiMap) {
    if (remaining.length < 2) return null;
    const last = remaining[remaining.length - 1];
    const overrun = (new Date(last.plannedLeave).getTime() - endOfPlan(it)) / 60000;
    if (overrun < 20) return null; // 无明显超时
    const poi = poiMap.get(String(last.poiId));
    return {
        type: 'drop', gainMin: overrun * 0.5,
        payload: { stopId: last._id },
        reason: `按当前进度行程将超时约${Math.round(overrun)}分钟，建议跳过${poi?.poiName || '末站'}`
    };
}

function endOfPlan(it) {
    const start = new Date(it.stops[0]?.plannedArrive || Date.now());
    return start.getTime() + (it.preferences?.hours || 6) * 3600000;
}

// rainShift：露天站挪出降雨窗口
function buildRainShift(it, remaining, poiMap, rain) {
    const rainStart = new Date(rain.startAt).getTime();
    const rainEnd = rainStart + rain.durationMin * 60000;
    const moves = [];
    const shelteredIdx = [], openIdx = [];
    remaining.forEach((s, i) => {
        const poi = poiMap.get(String(s.poiId));
        const inWindow = new Date(s.plannedArrive).getTime() < rainEnd &&
            new Date(s.plannedLeave).getTime() > rainStart;
        if (!inWindow) return;
        (poi?.visitMeta?.sheltered ? shelteredIdx : openIdx).push(i);
    });
    // 找窗口外/室内可交换对象：把窗口内露天站与窗口后的室内/任意站交换
    for (const oi of openIdx) {
        const swapWith = remaining.findIndex((s, i) =>
            i > oi && (new Date(s.plannedArrive).getTime() >= rainEnd ||
                poiMap.get(String(s.poiId))?.visitMeta?.sheltered));
        if (swapWith > -1) moves.push({ stopId: remaining[oi]._id, toIndex: swapWith });
    }
    if (!moves.length) return null;
    const startStr = new Date(rain.startAt).toTimeString().slice(0, 5);
    return {
        type: 'rainShift', gainMin: moves.length * 20, // 每站避雨等价20min
        payload: { moves, rainWindow: { startAt: rain.startAt, durationMin: rain.durationMin } },
        reason: `预计${startStr}开始降雨约${rain.durationMin}分钟，建议先去室内点位，雨停后再回露天站点`
    };
}

// ---------- applyProposal 纯函数（05文档 §4.4）----------
// 输入行程对象（lean）与提案 → 返回新 stops 数组；done/skipped 不可变。
function applyProposal(itinerary, proposal) {
    const stops = itinerary.stops.map(s => ({ ...(s.toObject ? s.toObject() : s) }));
    const mutable = s => ['pending', 'approaching'].includes(s.state);
    const byId = id => stops.findIndex(s => String(s._id) === String(id));
    const p = proposal.payload || {};

    switch (proposal.type) {
        case 'swap': {
            const i = byId(p.stopIdA), j = byId(p.stopIdB);
            if (i < 0 || j < 0 || !mutable(stops[i]) || !mutable(stops[j])) return null;
            [stops[i], stops[j]] = [stops[j], stops[i]];
            return retime(stops);
        }
        case 'replace': {
            const i = byId(p.stopId);
            if (i < 0 || !mutable(stops[i])) return null;
            stops[i] = {
                ...stops[i], poiId: p.newPoiId, photoSpotId: p.newPhotoSpotId || null,
                capacityTokenId: p.capacityTokenId || null,
                state: 'pending', pathGeometry: ''
            };
            return retime(stops);
        }
        case 'delay': {
            const i = byId(p.stopId);
            if (i < 0 || !mutable(stops[i])) return null;
            const delayMs = (p.delayMin || 25) * 60000;
            for (let k = i; k < stops.length; k++) {
                if (!mutable(stops[k])) continue;
                stops[k].plannedArrive = new Date(new Date(stops[k].plannedArrive).getTime() + delayMs);
                stops[k].plannedLeave = new Date(new Date(stops[k].plannedLeave).getTime() + delayMs);
            }
            return stops;
        }
        case 'drop': {
            const i = byId(p.stopId);
            if (i < 0 || !mutable(stops[i])) return null;
            stops[i].state = 'skipped';
            stops[i].capacityTokenId = null;
            return retime(stops);
        }
        case 'rainShift': {
            const mutableIndices = stops
                .map((stop, index) => mutable(stop) ? index : -1)
                .filter(index => index >= 0);
            const reordered = mutableIndices.map(index => stops[index]);
            for (const m of p.moves || []) {
                const i = reordered.findIndex(s => String(s._id) === String(m.stopId));
                if (i < 0) continue;
                const [moved] = reordered.splice(i, 1);
                reordered.splice(Math.min(Math.max(Number(m.toIndex) || 0, 0), reordered.length), 0, moved);
            }
            mutableIndices.forEach((index, i) => { stops[index] = reordered[i]; });
            return retime(stops);
        }
        case 'barrierReroute':
            return stops;
        default:
            return null;
    }
}

function proposalDiff(itinerary, proposal = itinerary?.pendingProposal) {
    if (!itinerary || !proposal) return null;
    const source = proposal?.toObject ? proposal.toObject() : proposal;
    const newStops = source?.type === 'barrierReroute' && Array.isArray(source.payload?.stops)
        ? source.payload.stops
        : applyProposal(itinerary, source);
    return newStops ? {
        before: (itinerary.stops || []).map(stop => String(stop.poiId)),
        after: newStops
            .filter(stop => stop.state !== 'skipped')
            .map(stop => String(stop.poiId))
    } : null;
}

function normalizePublicDiff(value) {
    if (!value || !Array.isArray(value.before) || !Array.isArray(value.after)) return null;
    return {
        before: value.before.map(String),
        after: value.after.map(String)
    };
}

function publicProposalView(proposal, diff = undefined) {
    const source = proposal?.toObject ? proposal.toObject() : proposal || {};
    return {
        proposalId: source.proposalId,
        type: source.type,
        reason: source.reason,
        gainMin: source.gainMin,
        expireAt: source.expireAt,
        diff: normalizePublicDiff(diff === undefined ? source.diff : diff)
    };
}

// 重排后按原停留时长顺延时刻表（保持 done/skipped 时刻不动）
function retime(stops) {
    let t = null;
    for (const s of stops) {
        if (!['pending', 'approaching'].includes(s.state)) {
            if (s.plannedLeave) t = new Date(s.plannedLeave);
            continue;
        }
        const stayMs = new Date(s.plannedLeave).getTime() - new Date(s.plannedArrive).getTime();
        if (t) {
            s.plannedArrive = new Date(t.getTime() + 10 * 60000); // 简化：站间步行按10min估，精确路径 accept 后异步补
            s.plannedLeave = new Date(s.plannedArrive.getTime() + stayMs);
        }
        t = new Date(s.plannedLeave);
    }
    return stops;
}

module.exports = {
    init,
    evaluate,
    safeEvaluate,
    applyProposal,
    proposalDiff,
    publicProposalView,
    affectedItineraries,
    selectCandidate
};
