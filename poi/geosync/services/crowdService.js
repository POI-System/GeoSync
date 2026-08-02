'use strict';
// 05文档 §1 + 04文档 §3.10：位置队列、围栏状态机、CI 公式、排队估计。

const { CONFIG } = require('../config');
const { getModels } = require('../models');
const geo = require('../lib/geo');
const memCache = require('../lib/memCache');
const bus = require('../lib/eventBus');

// ---- 位置内存队列（POST /api/position 只入队，5s flush）----
const posQueue = [];
// 围栏状态机内存态：userIdHash → {points:[[lng,lat]...], insidePoiId, consecutiveIn, consecutiveOut, openSampleId, lastTs}
const fenceState = new Map();

// POI 空间索引缓存（内存，10min 刷新）：[{_id, coords, radius, name}]
let poiIndex = [];
async function refreshPoiIndex() {
    const { ExternalPoi } = getModels();
    const pois = await ExternalPoi.find({ status: 'approved' }).lean();
    poiIndex = pois
        .map(p => {
            const coords = p.geo?.coordinates || (p.location?.lng != null ? [p.location.lng, p.location.lat] : null);
            if (!coords) return null;
            return { _id: p._id, coords, radius: fenceRadius(p), name: p.poiName, poi: p };
        })
        .filter(Boolean);
}

function fenceRadius(poi) {
    // R 按类型：观景台30 / 广场100 / 默认50（05文档 §1.1）
    const c = String(poi.category || '');
    if (c.includes('观景')) return 30;
    if (c.includes('广场')) return 100;
    return 50;
}

function getPoiIndex() { return poiIndex; }

function presenceCutoff(now = new Date()) {
    return new Date(new Date(now).getTime() - CONFIG.presenceLeaseMinutes * 60000);
}

function effectiveLastSeen(sample) {
    return new Date(sample.lastSeenAt || sample.enterAt);
}

function isPresenceActive(sample, now = new Date()) {
    return !sample.leaveAt && effectiveLastSeen(sample) > presenceCutoff(now);
}

function activePresenceMatch(now = new Date()) {
    const cutoff = presenceCutoff(now);
    return {
        $or: [
            { lastSeenAt: { $gt: cutoff } },
            { lastSeenAt: null, enterAt: { $gt: cutoff } }
        ]
    };
}

function expiredPresenceMatch(now = new Date()) {
    const cutoff = presenceCutoff(now);
    return {
        $or: [
            { lastSeenAt: { $lte: cutoff } },
            { lastSeenAt: null, enterAt: { $lte: cutoff } }
        ]
    };
}

// 入队（position 路由调用）：秒回，不做任何 IO
function enqueue({ openId, lng, lat, acc, ts, mode }) {
    if (acc > 100) return { accepted: false, code: 2103 };
    if (CONFIG.scenicCenter) {
        const d = geo.haversine([lng, lat], CONFIG.scenicCenter);
        if (d > CONFIG.fenceRadiusM) return { accepted: false, code: 2102, outOfFence: true };
    }
    posQueue.push({
        openId, lng, lat,
        ts: ts || Date.now(),
        receivedAt: Date.now(),
        mode: mode || 'tour'
    });
    return { accepted: true };
}

// 5s flush：滤波 → 围栏状态机 → 事件
async function flush() {
    if (!posQueue.length) return;
    const batch = posQueue.splice(0, posQueue.length);
    for (const p of batch) {
        try {
            await advanceGeofence(p);
            bus.emit(bus.EVENTS.POSITION_REPORTED, p);
        } catch (e) {
            console.error('[GeoSync] [FENCE]', e.message);
        }
    }
}

async function advanceGeofence(p) {
    if (!CONFIG.hmacSecret) return;
    const { StaySample } = getModels();
    const hash = geo.userIdHash(p.openId, CONFIG.hmacSecret);
    const observedAt = new Date(p.receivedAt || Date.now());

    let st = fenceState.get(hash);
    if (!st) {
        st = {
            points: [], insidePoiId: null, consecutiveIn: 0, consecutiveOut: 0,
            openSampleId: null, lastTs: 0, openId: p.openId
        };
        fenceState.set(hash, st);
    }
    st.openId = p.openId;
    st.lastTs = observedAt.getTime();
    st.points.push([p.lng, p.lat]);
    if (st.points.length > 5) st.points.shift();
    const filtered = geo.medianFilter(st.points, 5);

    // 命中判定
    let hit = null;
    for (const poi of poiIndex) {
        if (geo.haversine(filtered, poi.coords) <= poi.radius) { hit = poi; break; }
    }

    if (!st.openSampleId) {
        if (hit && String(hit._id) === String(st.insidePoiId)) {
            st.consecutiveIn++;
            if (st.consecutiveIn >= 2) { // 连续2次 → 开样本
                const { doc, resumed } = await openOrResumeSample({
                    StaySample, hit, hash, observedAt,
                    source: p.mode === 'passive' ? 'passive' : 'geofence'
                });
                st.openSampleId = doc._id;
                st.consecutiveOut = 0;
                if (!resumed) {
                    bus.emit(bus.EVENTS.STAY_OPENED, {
                        poiId: hit._id, userIdHash: hash,
                        openId: p.openId, at: observedAt
                    });
                }
            }
        } else {
            st.insidePoiId = hit ? hit._id : null;
            st.consecutiveIn = hit ? 1 : 0;
        }
    } else {
        const stillIn = hit && String(hit._id) === String(st.insidePoiId);
        if (stillIn) {
            st.consecutiveOut = 0;
            const renewed = await StaySample.findOneAndUpdate(
                { _id: st.openSampleId, leaveAt: null, ...activePresenceMatch(observedAt) },
                { $max: { lastSeenAt: observedAt } },
                { new: true }
            );
            if (!renewed) {
                st.openSampleId = null;
                st.consecutiveIn = 1;
                st.insidePoiId = hit._id;
            }
        } else {
            st.consecutiveOut++;
            if (st.consecutiveOut >= 3) await closeSample(st, hash, p.openId, observedAt);
        }
    }
}

async function openOrResumeSample({ StaySample, hit, hash, observedAt, source }) {
    const active = await StaySample.findOneAndUpdate(
        {
            scenicId: CONFIG.scenicId,
            poiId: hit._id,
            userIdHash: hash,
            leaveAt: null,
            ...activePresenceMatch(observedAt)
        },
        { $max: { lastSeenAt: observedAt } },
        { new: true, sort: { lastSeenAt: -1, enterAt: -1 } }
    );
    if (active) return { doc: active, resumed: true };

    const previous = await StaySample.find({
        scenicId: CONFIG.scenicId,
        userIdHash: hash,
        leaveAt: null
    }).limit(20);
    for (const doc of previous) await closeSampleDocument(StaySample, doc, effectiveLastSeen(doc));

    const doc = await StaySample.create({
        scenicId: CONFIG.scenicId,
        poiId: hit._id,
        userIdHash: hash,
        enterAt: observedAt,
        lastSeenAt: observedAt,
        source,
        expireAt: new Date(observedAt.getTime() + 7 * 86400000)
    });
    return { doc, resumed: false };
}

async function closeSampleDocument(StaySample, doc, leaveAt) {
    const lastSeenAt = effectiveLastSeen(doc);
    const observedLeave = new Date(Math.max(
        new Date(doc.enterAt).getTime(),
        Math.min(new Date(leaveAt).getTime(), lastSeenAt.getTime())
    ));
    return StaySample.findOneAndUpdate(
        {
            _id: doc._id,
            leaveAt: null,
            ...(doc.lastSeenAt ? { lastSeenAt: doc.lastSeenAt } : { lastSeenAt: null, enterAt: doc.enterAt })
        },
        {
            $set: {
                leaveAt: observedLeave,
                stayMinutes: Math.max(0, Math.round((observedLeave - new Date(doc.enterAt)) / 60000))
            }
        },
        { new: true }
    );
}

async function closeSample(st, hash, openId, observedAt) {
    const { StaySample } = getModels();
    const doc = await StaySample.findById(st.openSampleId);
    if (doc && !doc.leaveAt) {
        const closed = await closeSampleDocument(StaySample, doc, observedAt);
        if (closed) {
            bus.emit(bus.EVENTS.STAY_CLOSED, {
                poiId: closed.poiId,
                userIdHash: hash,
                openId,
                at: closed.leaveAt,
                stayMinutes: closed.stayMinutes
            });
        }
    }
    st.openSampleId = null;
    st.insidePoiId = null;
    st.consecutiveIn = 0;
    st.consecutiveOut = 0;
}

// 租约过期关单；CI 查询本身也过滤过期样本，不依赖 sweep 时序。
async function sweepStaleSamples(now = new Date()) {
    const { StaySample } = getModels();
    const stale = await StaySample.find({
        leaveAt: null,
        ...expiredPresenceMatch(now)
    }).limit(500);
    let closedCount = 0;
    for (const doc of stale) {
        const closed = await closeSampleDocument(StaySample, doc, effectiveLastSeen(doc));
        if (closed) {
            closedCount++;
            const state = fenceState.get(doc.userIdHash);
            if (state?.openId) {
                bus.emit(bus.EVENTS.STAY_CLOSED, {
                    poiId: closed.poiId,
                    userIdHash: closed.userIdHash,
                    openId: state.openId,
                    at: closed.leaveAt,
                    stayMinutes: closed.stayMinutes
                });
            }
        }
    }
    // 内存态清理
    const nowMs = new Date(now).getTime();
    const leaseMs = CONFIG.presenceLeaseMinutes * 60000;
    for (const [k, st] of fenceState) {
        if (nowMs - st.lastTs >= leaseMs) fenceState.delete(k);
    }
    return closedCount;
}

// ---- CI 公式（05文档 §1.2，纯函数便于单测）----
function computeCI({ presentEst, avgStay, baselineStay, checkinRate, baseRate, p95Present }) {
    const { alpha, beta, gamma } = CONFIG.ci;
    const a = geo.clamp(presentEst / Math.max(p95Present || 0, 5), 0, 1);
    const b = geo.clamp(avgStay / Math.max(baselineStay || 0, 1), 0, 2) / 2;
    const c = geo.clamp(checkinRate / Math.max(baseRate || 0, 0.5), 0, 2) / 2;
    return geo.clamp(alpha * a + beta * b + gamma * c, 0, 1);
}

function levelOf(ci) {
    return ci < 0.4 ? 'low' : ci < 0.7 ? 'medium' : 'high';
}

// Little's Law（05文档 §3）
function queueEst(presentEst, leaveRatePerMin) {
    if (!leaveRatePerMin || leaveRatePerMin < 0.1) return null;
    return Math.round(geo.clamp(presentEst / leaveRatePerMin, 0, 120));
}

// 渗透率 ρ 读取
async function getRho() {
    const { GeoSetting } = getModels();
    const s = await GeoSetting.findOne({ key: 'rho' }).lean();
    return s?.value?.rho || null; // null → 调用方按 ρ=1 + lowConfidence 处理
}

// heatmap 内存快照读写（ciAggregate 写，crowd 路由读）
function setHeatmapSnapshot(snap) { memCache.set('heatmap', snap); }
function getHeatmapSnapshot() { return memCache.get('heatmap') || null; }

let flushTimer = null;
function startFlushLoop() {
    if (flushTimer) return;
    flushTimer = setInterval(() => flush().catch(e => console.error('[GeoSync] [FLUSH]', e.message)), 5000);
    flushTimer.unref();
}

module.exports = {
    enqueue, flush, startFlushLoop, advanceGeofence, sweepStaleSamples,
    computeCI, levelOf, queueEst, getRho,
    refreshPoiIndex, getPoiIndex, fenceRadius,
    setHeatmapSnapshot, getHeatmapSnapshot,
    presenceCutoff, effectiveLastSeen, isPresenceActive,
    activePresenceMatch, expiredPresenceMatch
};
