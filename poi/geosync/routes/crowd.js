'use strict';
// 03文档 §3.6 + §4：位置上报（最热写路径）与人流查询。

const express = require('express');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { ok, fail, wrap } = require('../lib/respond');
const { requireUser } = require('../lib/auth');
const memCache = require('../lib/memCache');
const crowdService = require('../services/crowdService');
const geo = require('../lib/geo');

const router = express.Router();

// POST /api/position（挂在根，不在 /crowd 下）
const positionHandler = [requireUser, wrap(async (req, res) => {
    if (!memCache.rateLimit(`pos:${req.openId}`, 1, CONFIG.positionMinIntervalS * 1000)) {
        return fail(res, 429, 2101, '上报过频');
    }
    const { lng, lat, acc, ts, mode } = req.body || {};
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return fail(res, 400, 1101, '经纬度格式错误');
    }
    const r = crowdService.enqueue({
        openId: req.openId, lng, lat,
        acc: Number(acc) || 999, ts: Number(ts) || Date.now(), mode
    });
    if (r.code === 2102) {
        return res.json({ success: true, code: 2102, data: { accepted: false, outOfFence: true }, message: '' });
    }
    if (r.code === 2103) {
        return res.json({ success: true, code: 2103, data: { accepted: false }, message: '定位精度过差' });
    }
    ok(res, { accepted: true });
})];

// GET /api/crowd/heatmap
router.get('/heatmap', wrap(async (req, res) => {
    const snap = crowdService.getHeatmapSnapshot();
    if (!snap) return ok(res, { slot: null, items: [], lowConfidence: true });
    ok(res, snap);
}));

// GET /api/crowd/poi/:id
router.get('/poi/:id', wrap(async (req, res) => {
    const { CrowdSnapshot } = getModels();
    const poiId = req.params.id;
    const snap = crowdService.getHeatmapSnapshot();
    const now = snap?.items?.find(i => String(i.poiId) === poiId) || null;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = await CrowdSnapshot.find(
        { poiId, slotStart: { $gte: dayStart } },
        { timeSlot: 1, crowdIndex: 1, predicted: 1 }
    ).sort({ slotStart: 1 }).lean();

    ok(res, {
        now: now ? { ci: now.ci, level: now.level, queueEstMin: now.queueEstMin } : null,
        todayCurve: today.map(s => ({ slot: s.timeSlot.slice(11), ci: s.crowdIndex })),
        forecast: now?.predicted ? [
            { slot: '+30min', ci: now.predicted.p30 },
            { slot: '+60min', ci: now.predicted.p60 }
        ] : []
    });
}));

module.exports = { router, positionHandler };
