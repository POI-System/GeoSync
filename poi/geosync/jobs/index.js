'use strict';
// 04文档 §3：定时任务注册。全部幂等，runJob 包装（互斥+日志+容错）。

const cron = require('node-cron');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const geo = require('../lib/geo');
const memCache = require('../lib/memCache');
const bus = require('../lib/eventBus');
const crowdService = require('../services/crowdService');
const forecastService = require('../services/forecastService');
const rainService = require('../services/rainService');
const pairingService = require('../services/pairingService');
const antiHerding = require('../services/antiHerding');
const itineraryRuntime = require('../services/itineraryRuntime');
const sunlight = require('../services/sunlight');
const notifyBridge = require('../services/notifyBridge');

const running = new Set();

async function runJob(name, fn) {
    if (running.has(name)) {
        console.warn(`[JOB] ${name} skipped (previous run still active)`);
        return;
    }
    running.add(name);
    const t0 = Date.now();
    try {
        await fn();
        console.log(`[JOB] ${name} ok in ${Date.now() - t0}ms`);
    } catch (e) {
        console.error(`[JOB] ${name} FAILED:`, e.message);
    } finally {
        running.delete(name);
    }
}

// ===== ciAggregate（04文档 §3.1）=====
async function ciAggregate() {
    const { ExternalPoi, StaySample, Checkin, CrowdSnapshot } = getModels();
    await crowdService.refreshPoiIndex();
    const pois = crowdService.getPoiIndex();
    if (!pois.length) return;

    const now = new Date();
    const activePresence = crowdService.activePresenceMatch(now);
    const timeSlot = geo.timeSlotOf(now, CONFIG.ciSlotMinutes);
    const slotStart = geo.slotStartOf(now, CONFIG.ciSlotMinutes);
    const hourAgo = new Date(now - 3600000);
    const halfHourAgo = new Date(now - 1800000);
    const rho = (await crowdService.getRho()) || null;
    const poiIds = pois.map(p => p._id);

    // 一次聚合出全部 POI 的三分量原料
    const [presentRows, stayRows, checkinRows] = await Promise.all([
        StaySample.aggregate([
            { $match: { poiId: { $in: poiIds }, leaveAt: null, ...activePresence } },
            { $group: { _id: '$poiId', users: { $addToSet: '$userIdHash' } } }
        ]),
        StaySample.aggregate([
            { $match: { poiId: { $in: poiIds }, leaveAt: { $gte: hourAgo } } },
            { $group: { _id: '$poiId', avgStay: { $avg: '$stayMinutes' }, closed: { $sum: 1 } } }
        ]),
        Checkin.aggregate([
            { $match: { poiId: { $in: poiIds }, at: { $gte: halfHourAgo } } },
            { $group: { _id: '$poiId', n: { $sum: 1 } } }
        ])
    ]);
    const presentMap = new Map(presentRows.map(r => [String(r._id), r.users.length]));
    const stayMap = new Map(stayRows.map(r => [String(r._id), r]));
    const checkinMap = new Map(checkinRows.map(r => [String(r._id), r.n]));

    const prevSnap = crowdService.getHeatmapSnapshot();
    const prevLevels = new Map((prevSnap?.items || []).map(i => [String(i.poiId), i.level]));

    const items = [];
    const alertBuf = [];
    for (const p of pois) {
        const key = String(p._id);
        const presentCount = presentMap.get(key) || 0;
        const presentEst = rho ? presentCount / rho : presentCount;
        const stay = stayMap.get(key);
        const avgStay = stay?.avgStay || 0;
        const baselineStay = p.poi.visitMeta?.baselineStayMin || p.poi.visitMeta?.suggestedStayMin || 20;
        const checkinRate = checkinMap.get(key) || 0;
        const p95 = memCache.get(`p95:${key}`) || p.poi.visitMeta?.comfortCapacity || 50;

        const ci = crowdService.computeCI({
            presentEst, avgStay, baselineStay, checkinRate,
            baseRate: memCache.get(`baseRate:${key}`) || 1, p95Present: p95
        });
        const level = crowdService.levelOf(ci);
        const leaveRate = (stay?.closed || 0) / 60 / (rho || 1);
        const queueEstMin = crowdService.queueEst(presentEst, leaveRate);

        await CrowdSnapshot.updateOne(
            { poiId: p._id, timeSlot },
            {
                $set: {
                    scenicId: CONFIG.scenicId, slotStart,
                    presentCount, presentEst, avgStay, checkinRate,
                    crowdIndex: ci, level, queueEstMin
                }
            },
            { upsert: true }
        );

        const prevLevel = prevLevels.get(key);
        if (prevLevel && prevLevel !== level) {
            bus.emit(bus.EVENTS.CI_LEVEL_CHANGED, { poiId: p._id, name: p.name, ci, level, prevLevel });
        }
        // 三级预警：连续3片>0.8 / >0.9
        const histKey = `cihist:${key}`;
        const hist = memCache.get(histKey) || [];
        hist.push(ci);
        if (hist.length > 3) hist.shift();
        memCache.set(histKey, hist);
        if (hist.length === 3) {
            if (hist.every(v => v > 0.9)) alertBuf.push({ poi: p, level: 'red', ci });
            else if (hist.every(v => v > 0.8)) alertBuf.push({ poi: p, level: 'yellow', ci });
        }

        items.push({
            poiId: p._id, name: p.name, lnglat: p.coords,
            ci: Math.round(ci * 100) / 100, level, queueEstMin, presentEst,
            predicted: null // ciForecast 回填
        });
    }

    const snapshot = { slot: timeSlot, items, rho: rho || 1, lowConfidence: !rho };
    crowdService.setHeatmapSnapshot(snapshot);
    bus.emit(bus.EVENTS.CI_UPDATED, snapshot); // SSE heatmap 帧（index.js 桥接）

    for (const a of alertBuf) {
        const dedupKey = `alert:${a.poi._id}:${a.level}`;
        if (memCache.get(dedupKey)) continue;
        memCache.set(dedupKey, 1, 30 * 60000);
        bus.emit(bus.EVENTS.ALERT_CROWD, { poiId: a.poi._id, name: a.poi.name, level: a.level, ci: a.ci });
        await notifyBridge.alertAdmin(a.level, `${a.poi.name} 拥挤${a.level === 'red' ? '红色' : '黄色'}预警`, `CI=${a.ci.toFixed(2)}`);
    }

    // 尾部触发预测（04文档 §3.2 错峰）
    await ciForecast();
}

// ===== ciForecast =====
async function ciForecast() {
    const { CrowdSnapshot } = getModels();
    await forecastService.rebuildArrivalIndex();
    const snap = crowdService.getHeatmapSnapshot();
    if (!snap) return;

    const poiIds = snap.items.map(i => i.poiId);
    const now = new Date();
    const t30 = new Date(now.getTime() + 30 * 60000);
    const t60 = new Date(now.getTime() + 60 * 60000);
    const [means30, means60] = await Promise.all([
        forecastService.seasonalMeans(poiIds, t30),
        forecastService.seasonalMeans(poiIds, t60)
    ]);

    // 近6片趋势
    const since = new Date(now - 70 * 60000);
    const recent = await CrowdSnapshot.aggregate([
        { $match: { poiId: { $in: poiIds }, slotStart: { $gte: since } } },
        { $sort: { slotStart: 1 } },
        { $group: { _id: '$poiId', cis: { $push: '$crowdIndex' } } }
    ]);
    const recentMap = new Map(recent.map(r => [String(r._id), r.cis.slice(-6)]));

    const forecastMap = new Map();
    for (const item of snap.items) {
        const key = String(item.poiId);
        const ctxBase = {
            recentCis: recentMap.get(key) || [],
            comfortCapacity: 50,
            poiId: item.poiId
        };
        const p30 = forecastService.predict({ ...ctxBase, seasonalMean: means30.get(key) ?? null, targetTime: t30 }, 30);
        const p60 = forecastService.predict({ ...ctxBase, seasonalMean: means60.get(key) ?? null, targetTime: t60 }, 60);
        forecastMap.set(key, { p30: round2(p30), p60: round2(p60) });
        item.predicted = forecastMap.get(key);

        await CrowdSnapshot.updateOne(
            { poiId: item.poiId, timeSlot: snap.slot },
            { $set: { predicted: forecastMap.get(key) } }
        );
    }
    forecastService.setForecastCache(forecastMap);
}

const round2 = v => Math.round(v * 100) / 100;

// ===== spotScoreDaily（04文档 §3.5）=====
async function spotScoreDaily() {
    const { PhotoSpot } = getModels();
    const horizonBuilder = require('../services/horizonBuilder');
    const spots = await PhotoSpot.find({ status: 'approved' });
    const today = new Date();
    const todayStr = geo.dateStrOf(today);

    for (const spot of spots) {
        const result = sunlight.computeWindows(spot, today, null); // TODO(P5)：接天气后传 {cloudy}
        spot.goldenWindows = result.windows.map(w => ({
            date: todayStr, start: w.start, end: w.end, light: w.light,
            trueSunset: w.trueSunset || undefined
        }));
        spot.score = computeSpotScore(spot, result);
        await spot.save();
        if (!spot.horizonProfile?.length) horizonBuilder.enqueue(spot._id);
    }
}

function computeSpotScore(spot, windowResult) {
    const approved = (spot.samplePhotos || []).filter(s => s.status === 'approved');
    const likesSum = approved.reduce((a, s) => a + (s.likes || 0) * 0.6 + (s.adoptRate || 0) * 0.4, 0);
    const sampleQuality = Math.min(likesSum / 50, 1);
    const lightW = { golden: 1.0, side: 0.9, back: 0.7, front: 0.5 };
    const bestLight = windowResult.windows.reduce((best, w) => Math.max(best, lightW[w.light] || 0), 0);
    const lightFit = windowResult.windows.length ? bestLight : 0.2;
    const season = require('../services/guideService').seasonOf();
    const seasonMap = { spring: 'sakura', autumn: 'autumn-leaves', winter: 'snow' };
    const seasonFit = !spot.seasonTags?.length ? 0.7 :
        spot.seasonTags.includes(seasonMap[season]) ? 1 : 0.5;
    const weekAgo = Date.now() - 7 * 86400000;
    const freshness = approved.some(s => s.exif?.time && new Date(s.exif.time).getTime() > weekAgo) ? 1 : 0.4;
    const heat = crowdService.getHeatmapSnapshot()?.items?.find(i => String(i.poiId) === String(spot.poiId));
    const avgCi = heat?.ci ?? 0.3;
    return round2(0.35 * sampleQuality + 0.25 * lightFit + 0.20 * (1 - avgCi) + 0.10 * seasonFit + 0.10 * freshness);
}

// ===== rhoCalibrate（04文档 §3.6）=====
async function rhoCalibrate() {
    const { Checkin, GeoSetting } = getModels();
    const y = new Date(Date.now() - 86400000);
    const yStr = geo.dateStrOf(y);
    const setting = await GeoSetting.findOne({ key: 'gateTotal' }).lean();
    const gateTotal = setting?.value?.[yStr];
    if (!gateTotal) return; // 无票务数据 → ρ 保持
    const verifiedUsers = (await Checkin.distinct('openId', { date: yStr, status: 'verified' })).length;
    let rho = verifiedUsers / gateTotal;
    const prev = (await GeoSetting.findOne({ key: 'rho' }).lean())?.value?.rho;
    if (prev) rho = geo.clamp(rho, prev * 0.5, prev * 1.5); // 单日变幅 ≤±50%
    rho = geo.clamp(rho, 0.01, 1);
    await GeoSetting.updateOne(
        { key: 'rho' },
        { $set: { value: { rho, calibratedAt: new Date(), gateTotal, verifiedCheckins: verifiedUsers } } },
        { upsert: true }
    );
    console.log(`[JOB] rhoCalibrate ρ=${rho.toFixed(3)}`);
}

// ===== 分钟 sweep（04文档 §3.9）=====
async function minuteSweep() {
    const { Itinerary, StaySample, Pairing } = getModels();
    // 过期提案清理 + token 回滚
    const now = new Date();
    const expired = await Itinerary.find({
        'pendingProposal.expireAt': { $lte: now }
    }).limit(500).lean();
    for (const it of expired) {
        const proposalId = it.pendingProposal?.proposalId;
        const updated = await Itinerary.findOneAndUpdate(
            {
                _id: it._id,
                'pendingProposal.proposalId': proposalId,
                'pendingProposal.expireAt': { $lte: now }
            },
            { $set: { pendingProposal: null }, $inc: { version: 1 } }
        );
        if (updated) {
            await antiHerding.releaseTokens(
                it.pendingProposal?.tokenIds || [], it._id
            ).catch(error => console.error(
                `[JOB] proposal token release failed (${it._id}):`, error.message));
        }
    }
    const tokenStats = await antiHerding.reconcileTokens(now).catch(error => {
        console.error('[JOB] capacity token reconcile failed:', error.message);
        return null;
    });
    if (tokenStats?.arrivalIndexError) {
        console.error('[JOB] capacity token arrival index retry failed:', tokenStats.arrivalIndexError);
    }
    // 停留兜底关闭
    await crowdService.sweepStaleSamples();
    const presence = await itineraryRuntime.reconcilePresence({
        Itinerary,
        StaySample,
        hmacSecret: CONFIG.hmacSecret,
        now,
        onReleaseTokens: (tokenIds, context) =>
            antiHerding.releaseTokens(tokenIds, context.itinerary._id)
    }).catch(error => {
        console.error('[JOB] itinerary presence reconcile failed:', error.message);
        return null;
    });
    if (presence?.updated) {
        await forecastService.rebuildArrivalIndex().catch(error =>
            console.error('[JOB] arrival index rebuild failed:', error.message));
        for (const itinerary of presence.itineraries) {
            bus.emit(bus.EVENTS.ITINERARY_PROGRESS, {
                openId: itinerary.openId,
                itineraryId: itinerary._id,
                version: itinerary.version,
                state: itinerary.state,
                stops: itinerary.stops.map(stop => ({
                    stopId: stop._id,
                    poiId: stop.poiId,
                    state: stop.state,
                    actualArrive: stop.actualArrive || null,
                    actualLeave: stop.actualLeave || null
                }))
            });
        }
    }
    // pairing proposed 超时
    await Pairing.updateMany(
        { state: 'proposed', createdAt: { $lt: new Date(Date.now() - 30 * 60000) } },
        { $set: { state: 'expired' } }
    );
}

// ===== 注册 =====
function startJobs() {
    // PM2 cluster 下仅实例0跑 cron（01文档 §7）
    const inst = process.env.NODE_APP_INSTANCE;
    if (inst !== undefined && inst !== '0') {
        console.log('[GeoSync] [JOBS] non-primary instance, cron disabled');
        return;
    }
    cron.schedule('*/10 * * * *', () => runJob('ciAggregate', ciAggregate));
    cron.schedule('*/10 * * * *', () => runJob('rainPoll', () => rainService.poll()));
    cron.schedule('*/10 * * * *', () => runJob('pairingScan', async () => {
        const n = await pairingService.scan();
        if (n) console.log(`[JOB] pairingScan created ${n} pairings`);
    }));
    cron.schedule('30 3 * * *', () => runJob('spotScoreDaily', spotScoreDaily));
    cron.schedule('0 4 * * *', () => runJob('rhoCalibrate', rhoCalibrate));
    cron.schedule('* * * * *', () => runJob('minuteSweep', minuteSweep));
    // trailMining（0 2 * * *）：P5 实现，先注册占位
    cron.schedule('0 2 * * *', () => runJob('trailMining', async () => {
        // TODO(P5)：05文档 §trailMining —— 轨迹地图匹配 + 无障碍实证 + DBSCAN 修路
    }));
    crowdService.startFlushLoop();
    // 启动即跑一轮聚合（避免冷启动 heatmap 空窗）
    setTimeout(() => runJob('ciAggregate', ciAggregate), 5000);
    console.log('[GeoSync] [JOBS] cron started');
}

module.exports = { startJobs, ciAggregate, ciForecast, spotScoreDaily, rhoCalibrate, minuteSweep, computeSpotScore };
