'use strict';
// 03文档 §9：管理端 /api/admin/geosync/*（requireAdmin）。

const express = require('express');
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { ok, accepted, fail, wrap, BizError, safeErrorCode } = require('../lib/respond');
const { requireAdmin } = require('../lib/auth');
const memCache = require('../lib/memCache');
const geo = require('../lib/geo');
const {
    normalizeBoolean,
    normalizeCoordinate,
    normalizeDistanceM,
    normalizeLineCoordinates,
    normalizeSlopePct,
    normalizeUnitRatio,
    normalizeWalkEdgeMetrics,
    normalizeWalkSec,
    polylineDistanceM
} = require('../lib/walkEdgeContract');
const bus = require('../lib/eventBus');
const crowdService = require('../services/crowdService');
const forecastService = require('../services/forecastService');
const walkGraph = require('../services/walkGraph');

const router = express.Router();
router.use(requireAdmin);

function gatewayOf(req) {
    const gateway = req?.app?.locals?.geosync?.superMapGateway;
    if (!gateway
        || typeof gateway.findPath !== 'function'
        || typeof gateway.findPathWithBarriers !== 'function') {
        throw new BizError(8201, 'GIS route provider is unavailable', 503);
    }
    return gateway;
}

function sanitizeCloseReason(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
}

const EDGE_BOOLEAN_FIELDS = new Set([
    'stairs', 'accessible', 'accessibleVerified'
]);
const EDGE_ENDPOINT_TOLERANCE_M = 5;
const EDGE_PATCH_NORMALIZERS = Object.freeze({
    walkSec: value => normalizeWalkSec(value, { coerce: true }),
    distanceM: value => normalizeDistanceM(value, { coerce: true }),
    slope: value => normalizeSlopePct(value, { coerce: true, defaultValue: null }),
    shade: value => normalizeUnitRatio(value, { coerce: true }),
    covered: value => normalizeUnitRatio(value, { coerce: true }),
    stairs: value => normalizeBoolean(value, { coerce: true }),
    accessible: value => normalizeBoolean(value, { coerce: true }),
    accessibleVerified: value => normalizeBoolean(value, { coerce: true }),
    geometry: value => normalizeLineCoordinates(value, { coerce: true })
});

function normalizeEdgePatch(body) {
    const patch = {};
    for (const [field, normalize] of Object.entries(EDGE_PATCH_NORMALIZERS)) {
        if (body?.[field] === undefined) continue;
        const value = normalize(body[field]);
        if (value === null) return null;
        patch[field] = value;
    }
    return patch;
}

function edgeGeometryDistanceM(edge) {
    const coordinates = normalizeLineCoordinates(edge?.geometry, { coerce: true });
    if (coordinates) {
        const distanceM = polylineDistanceM(coordinates);
        if (distanceM !== null) return Math.round(distanceM);
    }
    return normalizeDistanceM(edge?.distanceM, { coerce: true });
}

function validMergedEdgeMetrics(edge) {
    const metrics = normalizeWalkEdgeMetrics(edge, {
        geometryDistanceM: edgeGeometryDistanceM(edge),
        coerce: true
    });
    if (!metrics) return false;
    for (const field of EDGE_BOOLEAN_FIELDS) {
        if (normalizeBoolean(edge?.[field], { coerce: true, defaultValue: false }) === null) {
            return false;
        }
    }
    return true;
}

function nodeCoordinate(node) {
    return normalizeCoordinate(node?.geo?.coordinates);
}

function geometryAnchorsEdge(coordinates, fromNode, toNode) {
    const from = nodeCoordinate(fromNode);
    const to = nodeCoordinate(toNode);
    const geometry = normalizeLineCoordinates(coordinates);
    if (!from || !to || !geometry) return false;
    const startDistanceM = geo.haversine(from, geometry[0]);
    const endDistanceM = geo.haversine(to, geometry[geometry.length - 1]);
    return Number.isFinite(startDistanceM)
        && Number.isFinite(endDistanceM)
        && startDistanceM <= EDGE_ENDPOINT_TOLERANCE_M
        && endDistanceM <= EDGE_ENDPOINT_TOLERANCE_M;
}

function canonicalSourceRef(value) {
    const datasetName = typeof value?.datasetName === 'string' ? value.datasetName.trim() : '';
    const smId = Number(value?.smId);
    if (!datasetName || !Number.isInteger(smId) || smId < 0) return null;
    return { datasetName, smId };
}

function graphEventId() {
    return `closure_${crypto.randomBytes(8).toString('hex')}`;
}

// POST /gis/route-test — 管理端 GIS 冒烟，不进入游客行程流程。
router.post('/gis/route-test', wrap(async (req, res) => {
    const gateway = gatewayOf(req);
    const barriers = req.body?.barriers ?? [];
    const input = {
        start: req.body?.start,
        end: req.body?.end,
        mode: req.body?.mode,
        barriers,
        scenicId: CONFIG.scenicId
    };
    const requestId = req.headers?.['x-request-id'];
    if (requestId !== undefined && requestId !== null && String(requestId).trim()) {
        input.requestId = String(requestId).trim();
    }
    const result = Array.isArray(barriers) && barriers.length > 0
        ? await gateway.findPathWithBarriers(input)
        : await gateway.findPath(input);
    ok(res, result);
}));

// ===================== 9.1 大屏与回放 =====================

// GET /dashboard
router.get('/dashboard', wrap(async (req, res) => {
    const { Itinerary, Checkin } = getModels();
    const today = geo.dateStrOf(new Date());
    const [activeItineraries, todayCheckins, doneToday] = await Promise.all([
        Itinerary.countDocuments({ state: 'active' }),
        Checkin.countDocuments({ date: today }),
        Itinerary.find({ state: 'completed', date: today }, { savedMinutesTotal: 1, rerouteLog: 1 }).lean()
    ]);
    // 提案接受率 + 平均省时（今日已完成行程口径）
    let accepted = 0, total = 0, savedSum = 0;
    for (const it of doneToday) {
        savedSum += it.savedMinutesTotal || 0;
        for (const log of it.rerouteLog || []) {
            if (log.status === 'accepted') {
                total++;
                accepted++;
            } else if (log.status === 'rejected') {
                total++;
            } else if (!log.status && typeof log.accepted === 'boolean') {
                total++;
                if (log.accepted) accepted++;
            }
        }
    }
    const snap = crowdService.getHeatmapSnapshot();
    const top10 = (snap?.items || [])
        .slice().sort((a, b) => b.ci - a.ci).slice(0, 10)
        .map(i => ({
            poiId: i.poiId, name: i.name, ci: i.ci, level: i.level,
            trend: i.predicted ? (i.predicted.p30 > i.ci + 0.05 ? 'up' : i.predicted.p30 < i.ci - 0.05 ? 'down' : 'flat') : 'flat'
        }));
    ok(res, {
        activeItineraries, todayCheckins,
        avgSavedMin: doneToday.length ? Math.round(savedSum / doneToday.length) : 0,
        rerouteAcceptRate: total ? Math.round(accepted / total * 100) / 100 : null,
        top10,
        alerts: memCache.get('recentAlerts') || []
    });
}));

// GET /replay?date=YYYY-MM-DD（列式压缩：frames[poiId] = [ci×144]）
router.get('/replay', wrap(async (req, res) => {
    const { CrowdSnapshot } = getModels();
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 1101, 'date 格式应为 YYYY-MM-DD');
    const rows = await CrowdSnapshot.find(
        { timeSlot: { $regex: `^${date}T` } },
        { poiId: 1, timeSlot: 1, crowdIndex: 1 }
    ).lean();
    if (!rows.length) return fail(res, 404, 8103, '该日期无回放数据');

    const slots = [];
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += CONFIG.ciSlotMinutes) {
            slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        }
    }
    const slotIdx = new Map(slots.map((s, i) => [s, i]));
    const frames = {};
    for (const r of rows) {
        const key = String(r.poiId);
        if (!frames[key]) frames[key] = new Array(slots.length).fill(null);
        const i = slotIdx.get(r.timeSlot.slice(11));
        if (i != null) frames[key][i] = Math.round(r.crowdIndex * 100) / 100;
    }
    await crowdService.refreshPoiIndex();
    const poiIndex = crowdService.getPoiIndex();
    const pois = Object.keys(frames).map(id => {
        const p = poiIndex.find(x => String(x._id) === id);
        return { poiId: id, name: p?.name || '', lnglat: p?.coords || null };
    });
    ok(res, { date, slots, frames, pois });
}));

// ===================== 9.2 路网管理 =====================

// GET /graph — 全部 nodes+edges（描图工具编辑态，含 candidate）
router.get('/graph', wrap(async (req, res) => {
    const { WalkNode, WalkEdge } = getModels();
    const [nodes, edges] = await Promise.all([
        WalkNode.find({}).lean(), WalkEdge.find({}).lean()
    ]);
    ok(res, { nodes, edges });
}));

// POST /graph/node
router.post('/graph/node', wrap(async (req, res) => {
    const { WalkNode } = getModels();
    const { lng, lat, kind } = req.body || {};
    const coordinates = normalizeCoordinate([lng, lat]);
    if (!coordinates) return fail(res, 400, 1101, '经纬度必须是有效的 WGS84 坐标');
    const nodeId = 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const node = await WalkNode.create({
        scenicId: CONFIG.scenicId, nodeId,
        geo: { type: 'Point', coordinates },
        kind: ['junction', 'poi-gate', 'facility'].includes(kind) ? kind : 'junction'
    });
    await walkGraph.loadIntoMemory();
    ok(res, { nodeId: node.nodeId });
}));

// POST /graph/edge（描图新增，自动算 distanceM/walkSec）
router.post('/graph/edge', wrap(async (req, res) => {
    const { WalkNode, WalkEdge } = getModels();
    const { from, to, geometry, stairs, slope, shade, covered, accessible, bidirectional = true } = req.body || {};
    const fromNodeId = typeof from === 'string' ? from.trim() : '';
    const toNodeId = typeof to === 'string' ? to.trim() : '';
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) {
        return fail(res, 400, 1101, '路段端点无效');
    }
    const [nFrom, nTo] = await Promise.all([
        WalkNode.findOne({ nodeId: fromNodeId }).lean(),
        WalkNode.findOne({ nodeId: toNodeId }).lean()
    ]);
    if (!nFrom || !nTo) return fail(res, 404, 8101, '端点节点不存在');
    const fromCoordinate = nodeCoordinate(nFrom);
    const toCoordinate = nodeCoordinate(nTo);
    if (!fromCoordinate || !toCoordinate) {
        return fail(res, 400, 1101, '端点节点坐标无效');
    }
    const fallbackGeometry = [fromCoordinate, toCoordinate];
    const coords = normalizeLineCoordinates(
        geometry === undefined ? fallbackGeometry : geometry,
        { coerce: true }
    );
    const normalizedStairs = normalizeBoolean(stairs, { coerce: true, defaultValue: false });
    const normalizedAccessible = normalizeBoolean(accessible, { coerce: true, defaultValue: false });
    const normalizedBidirectional = normalizeBoolean(bidirectional, { coerce: true, defaultValue: true });
    if (!coords || normalizedStairs === null || normalizedAccessible === null || normalizedBidirectional === null) {
        return fail(res, 400, 1101, '路段字段值无效');
    }
    if (!geometryAnchorsEdge(coords, nFrom, nTo)) {
        return fail(res, 400, 1101, '路段几何首尾未锚定到指定节点');
    }
    const rawDistanceM = polylineDistanceM(coords);
    if (rawDistanceM === null) return fail(res, 400, 1101, '路段几何无效');
    const distanceM = Math.round(rawDistanceM);
    const walkSec = Math.round(distanceM / 1.4 * (normalizedStairs ? 1.6 : 1));
    const metrics = normalizeWalkEdgeMetrics({
        distanceM,
        walkSec,
        slope,
        shade,
        covered
    }, { geometryDistanceM: distanceM, coerce: true });
    if (!metrics) return fail(res, 400, 1101, '路段数值超出允许范围');

    const mk = (a, b, geom) => ({
        scenicId: CONFIG.scenicId,
        edgeId: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: a,
        to: b,
        geometry: geom,
        distanceM: metrics.distanceM,
        walkSec: metrics.walkSec,
        slope: metrics.slope,
        stairs: normalizedStairs,
        shade: metrics.shade,
        covered: metrics.covered,
        accessible: normalizedAccessible,
        status: 'open',
        source: 'manual'
    });
    const docs = [mk(fromNodeId, toNodeId, coords)];
    if (normalizedBidirectional) docs.push(mk(toNodeId, fromNodeId, [...coords].reverse()));
    const created = await WalkEdge.insertMany(docs);
    await walkGraph.loadIntoMemory();
    ok(res, {
        edgeIds: created.map(e => e.edgeId),
        distanceM: metrics.distanceM,
        walkSec: metrics.walkSec
    });
}));

// PATCH /graph/edge/:edgeId
router.patch('/graph/edge/:edgeId', wrap(async (req, res) => {
    const { WalkNode, WalkEdge } = getModels();
    const patch = normalizeEdgePatch(req.body);
    if (!patch) return fail(res, 400, 1101, '路段字段值无效');
    if (!Object.keys(patch).length) return fail(res, 400, 1101, '无可更新字段');
    const current = await WalkEdge.findOne({ edgeId: req.params.edgeId }).lean();
    if (!current) return fail(res, 404, 8101, '边不存在');
    const [nFrom, nTo] = await Promise.all([
        WalkNode.findOne({ nodeId: current.from }).lean(),
        WalkNode.findOne({ nodeId: current.to }).lean()
    ]);
    if (!nFrom || !nTo) return fail(res, 400, 1101, '路段端点节点不存在');
    const merged = { ...current, ...patch };
    if (!geometryAnchorsEdge(merged.geometry, nFrom, nTo)) {
        return fail(res, 400, 1101, '路段几何首尾未锚定到指定节点');
    }
    if (!validMergedEdgeMetrics(merged)) {
        return fail(res, 400, 1101, '路段距离、耗时或属性单位不一致');
    }
    const metricSnapshot = {
        edgeId: req.params.edgeId,
        geometry: current.geometry,
        walkSec: current.walkSec,
        distanceM: Object.hasOwn(current, 'distanceM')
            ? current.distanceM
            : { $exists: false }
    };
    const edge = await WalkEdge.findOneAndUpdate(
        metricSnapshot,
        { $set: patch },
        { new: true, runValidators: true }
    );
    if (!edge) {
        const latest = await WalkEdge.findOne({ edgeId: req.params.edgeId }).lean();
        if (!latest) return fail(res, 404, 8101, '边不存在');
        return fail(res, 409, 8102, '路段已被其他请求修改，请重试');
    }
    await walkGraph.loadIntoMemory();
    ok(res, edge);
}));

// POST /graph/edge/:edgeId/close | open（秒级传导：eventBus → 图重载 + 行程重算 + Socket）
router.post('/graph/edge/:edgeId/:op(close|open)', wrap(async (req, res) => {
    const { WalkEdge } = getModels();
    const closing = req.params.op === 'close';
    const reason = closing ? sanitizeCloseReason(req.body?.reason) : null;
    if (closing && !reason) return fail(res, 400, 1101, '关闭原因不能为空');

    const acceptedAt = new Date();
    const targetStatus = closing ? 'closed' : 'open';
    const sourceStatus = closing ? 'open' : 'closed';
    const edge = await WalkEdge.findOneAndUpdate(
        { edgeId: req.params.edgeId, status: sourceStatus },
        closing
            ? { $set: { status: targetStatus, closedReason: reason, closedAt: acceptedAt } }
            : { $set: { status: 'open' }, $unset: { closedReason: 1, closedAt: 1 } },
        { new: true }
    );
    if (!edge) {
        const current = await WalkEdge.findOne({ edgeId: req.params.edgeId });
        if (!current) return fail(res, 404, 8101, '边不存在');
        if (current.status === targetStatus) {
            return ok(res, { accepted: false, edgeId: current.edgeId, status: current.status });
        }
        return fail(res, 409, 8102, '路段当前状态不允许该操作');
    }

    const eventId = graphEventId();
    let cacheInvalidated = true;
    try {
        const gateway = req?.app?.locals?.geosync?.superMapGateway;
        if (!gateway || typeof gateway.invalidateRouteCache !== 'function') {
            throw new Error('Gateway route-cache invalidation is unavailable');
        }
        await gateway.invalidateRouteCache(`graph-${targetStatus}:${edge.edgeId}:${eventId}`);
    } catch (error) {
        cacheInvalidated = false;
        console.error('[GeoSync] [GRAPH] route-cache invalidation failed:',
            safeErrorCode(error, 'ROUTE_CACHE_INVALIDATION_FAILED'));
    }

    const payload = {
        eventId,
        scenicId: String(edge.scenicId || CONFIG.scenicId),
        edgeId: edge.edgeId,
        status: edge.status,
        reason,
        sourceRef: canonicalSourceRef(edge.sourceRef),
        acceptedAt: acceptedAt.toISOString(),
        cacheInvalidated
    };
    bus.emit(closing ? bus.EVENTS.EDGE_CLOSED : bus.EVENTS.EDGE_OPENED, payload);
    accepted(res, 0, payload);
}));

// GET /graph/candidates — 众包修路候选
router.get('/graph/candidates', wrap(async (req, res) => {
    const { WalkEdge } = getModels();
    ok(res, { items: await WalkEdge.find({ status: 'candidate' }).lean() });
}));

// POST /graph/candidates/:edgeId/approve|reject
router.post('/graph/candidates/:edgeId/:action(approve|reject)', wrap(async (req, res) => {
    const { WalkEdge } = getModels();
    const approve = req.params.action === 'approve';
    if (approve) {
        const edge = await WalkEdge.findOneAndUpdate(
            { edgeId: req.params.edgeId, status: 'candidate' },
            { $set: { status: 'open' } }, { new: true }
        );
        if (!edge) return fail(res, 404, 8101, '候选边不存在');
        await walkGraph.loadIntoMemory();
        return ok(res, { edgeId: edge.edgeId, status: 'open' });
    }
    const r = await WalkEdge.deleteOne({ edgeId: req.params.edgeId, status: 'candidate' });
    if (!r.deletedCount) return fail(res, 404, 8101, '候选边不存在');
    ok(res, { edgeId: req.params.edgeId, deleted: true });
}));

// GET /graph/accessibility-issues — 无障碍疑似不可通行工单
router.get('/graph/accessibility-issues', wrap(async (req, res) => {
    const { AccessibleEvidence, WalkEdge } = getModels();
    const rows = await AccessibleEvidence.aggregate([
        { $match: { outcome: 'turnback' } },
        { $group: { _id: '$edgeId', users: { $addToSet: '$userIdHash' }, last: { $max: '$date' } } },
        { $match: { $expr: { $gte: [{ $size: '$users' }, 2] } } }
    ]);
    const edges = await WalkEdge.find({ edgeId: { $in: rows.map(r => r._id) } }).lean();
    const edgeMap = new Map(edges.map(e => [e.edgeId, e]));
    ok(res, {
        items: rows.map(r => ({
            edgeId: r._id, turnbackUsers: r.users.length, lastDate: r.last,
            accessible: edgeMap.get(r._id)?.accessible ?? null,
            accessibleVerified: edgeMap.get(r._id)?.accessibleVerified ?? null
        }))
    });
}));

// ===================== 9.3 运营 =====================

// POST /campaign — 创建分流活动
router.post('/campaign', wrap(async (req, res) => {
    const { Campaign } = getModels();
    const { name, areaPoiIds, multiplier, boostWeight, startAt, endAt } = req.body || {};
    if (!name || !Array.isArray(areaPoiIds) || !areaPoiIds.length || !startAt || !endAt) {
        return fail(res, 400, 1101, '参数不足');
    }
    const s = new Date(startAt), e = new Date(endAt);
    if (!(s < e)) return fail(res, 400, 8102, '时间区间无效');
    const overlap = await Campaign.findOne({
        state: { $in: ['draft', 'active'] },
        areaPoiIds: { $in: areaPoiIds },
        startAt: { $lt: e }, endAt: { $gt: s }
    }).lean();
    if (overlap) return fail(res, 400, 8102, `与活动"${overlap.name}"时间/区域冲突`);
    const camp = await Campaign.create({
        scenicId: CONFIG.scenicId, name: String(name).slice(0, 50),
        areaPoiIds, multiplier: geo.clamp(Number(multiplier) || 2, 1, 5),
        boostWeight: geo.clamp(Number(boostWeight) || 0.15, 0, 0.5),
        startAt: s, endAt: e, state: 'active'
    });
    ok(res, { campaignId: camp._id });
}));

// GET /campaign/:id/ab — 活动效果
router.get('/campaign/:id/ab', wrap(async (req, res) => {
    const { Campaign, Checkin, CrowdSnapshot } = getModels();
    const camp = await Campaign.findById(req.params.id).lean();
    if (!camp) return fail(res, 404, 8101, '活动不存在');
    const checkinsInArea = await Checkin.countDocuments({
        poiId: { $in: camp.areaPoiIds }, at: { $gte: camp.startAt, $lte: camp.endAt }
    });
    // 活动前后同长窗口的全景区 CI 方差对比
    const spanMs = camp.endAt - camp.startAt;
    const variance = async (from, to) => {
        const rows = await CrowdSnapshot.find(
            { slotStart: { $gte: from, $lte: to } }, { crowdIndex: 1 }
        ).lean();
        if (rows.length < 2) return null;
        const vals = rows.map(r => r.crowdIndex);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.round(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length * 10000) / 10000;
    };
    const [before, after] = await Promise.all([
        variance(new Date(camp.startAt.getTime() - spanMs), camp.startAt),
        variance(camp.startAt, camp.endAt)
    ]);
    const exposed = camp.stats?.exposed || 0;
    const adopted = camp.stats?.adopted || 0;
    ok(res, {
        exposed, adopted,
        adoptRate: exposed ? Math.round(adopted / exposed * 100) / 100 : null,
        checkinsInArea, ciVarianceBefore: before, ciVarianceAfter: after
    });
}));

// GET /schedule-advice — 未来4h 分区排班建议
router.get('/schedule-advice', wrap(async (req, res) => {
    const cached = memCache.get('scheduleAdvice');
    if (cached) return ok(res, cached);
    const snap = crowdService.getHeatmapSnapshot();
    if (!snap) return ok(res, []);
    const advice = [];
    const nowH = new Date().getHours();
    for (const item of snap.items) {
        const f = forecastService.getForecast(item.poiId);
        const peak = Math.max(item.ci, f?.p30 ?? 0, f?.p60 ?? 0);
        if (peak > 0.8) {
            advice.push({
                hour: (nowH + (f && f.p60 >= (f.p30 ?? 0) ? 1 : 0)) % 24,
                area: item.name, predictedPeakCi: Math.round(peak * 100) / 100,
                advice: `预计${item.name}人流峰值 CI=${peak.toFixed(2)}，建议增派引导人员/摆渡车`
            });
        }
    }
    advice.sort((a, b) => b.predictedPeakCi - a.predictedPeakCi);
    memCache.set('scheduleAdvice', advice, 10 * 60000);
    ok(res, advice);
}));

// POST /photospot/:id/review — 机位审核（approve 触发 horizon 预计算）
router.post('/photospot/:id/review', wrap(async (req, res) => {
    const { PhotoSpot } = getModels();
    const action = req.body?.action;
    if (!['approve', 'reject'].includes(action)) return fail(res, 400, 1101, 'action 应为 approve|reject');
    const status = action === 'approve' ? 'approved' : 'rejected';
    const spot = await PhotoSpot.findByIdAndUpdate(
        req.params.id,
        {
            $set: {
                status,
                'samplePhotos.$[p].status': status
            }
        },
        { new: true, arrayFilters: [{ 'p.status': 'pending' }] }
    );
    if (!spot) return fail(res, 404, 4101, '机位不存在');
    if (status === 'approved') bus.emit(bus.EVENTS.SPOT_APPROVED, { spotId: spot._id });
    ok(res, { spotId: spot._id, status });
}));

// GET /pairing/reports — 举报队列
router.get('/pairing/reports', wrap(async (req, res) => {
    const { GeoSetting } = getModels();
    const doc = await GeoSetting.findOne({ key: 'pairingReports' }).lean();
    ok(res, { items: doc?.value?.list || [] });
}));

// POST /pairing/ban
router.post('/pairing/ban', wrap(async (req, res) => {
    const { PairingProfile } = getModels();
    const openId = String(req.body?.openId || '').trim();
    if (!openId) return fail(res, 400, 1101, '缺少 openId');
    await PairingProfile.updateOne(
        { openId }, { $set: { banned: true, enabled: false } }, { upsert: true }
    );
    ok(res, { openId, banned: true });
}));

// POST /gate-total — ρ 校准输入：管理端每日填昨日闸机总量（08文档 §5）
router.post('/gate-total', wrap(async (req, res) => {
    const { GeoSetting } = getModels();
    const { date, total } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isFinite(Number(total))) {
        return fail(res, 400, 1101, '需 date(YYYY-MM-DD) 与 total(数字)');
    }
    await GeoSetting.updateOne(
        { key: 'gateTotal' },
        { $set: { [`value.${date}`]: Number(total), updateTime: new Date() } },
        { upsert: true }
    );
    ok(res, { date, total: Number(total) });
}));

// POST /checkin/:id/review — 转人工打卡的审核（202 流水线出口）
router.post('/checkin/:id/review', wrap(async (req, res) => {
    const { Checkin, ExternalPoi } = getModels();
    const action = req.body?.action;
    if (!['approve', 'reject'].includes(action)) return fail(res, 400, 1101, 'action 应为 approve|reject');
    const checkin = await Checkin.findOne({ _id: req.params.id, status: 'pending' });
    if (!checkin) return fail(res, 404, 8101, '待审打卡不存在');
    if (action === 'reject') {
        checkin.status = 'rejected';
        await checkin.save();
        return ok(res, { checkinId: checkin._id, status: 'rejected' });
    }
    const checkinService = require('../services/checkinService');
    const poi = await ExternalPoi.findById(checkin.poiId).lean();
    checkin.status = 'verified';
    checkin.points = checkin.viaQrCode ? 5 : 10;
    await checkin.save();
    await checkinService.addPoints(checkin.openId, checkin.points, 'checkin', checkin._id);
    const badge = poi ? await checkinService.badgeProgress(checkin.openId, poi) : null;
    bus.emit(bus.EVENTS.CHECKIN_VERIFIED, {
        openId: checkin.openId, checkinId: checkin._id, points: checkin.points, badge
    });
    ok(res, { checkinId: checkin._id, status: 'verified', points: checkin.points });
}));

module.exports = router;
