'use strict';
// 03文档 §6：打卡域。

const express = require('express');
const multer = require('multer');
const path = require('path');
const { getModels } = require('../models');
const { ok, fail, accepted, wrap } = require('../lib/respond');
const { requireUser } = require('../lib/auth');
const memCache = require('../lib/memCache');
const checkinService = require('../services/checkinService');

const router = express.Router();
router.use(requireUser);

const upload = multer({
    dest: path.join(__dirname, '..', 'uploads'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype))
});

// POST /api/checkin
router.post('/', upload.single('photo'), wrap(async (req, res) => {
    if (!memCache.rateLimit(`checkin:${req.openId}`, 1, 10000)) {
        return fail(res, 429, 2101, '打卡过频，请稍候');
    }
    const { poiId, lng, lat } = req.body || {};
    if (!poiId || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
        return fail(res, 400, 1101, '参数不足');
    }
    const result = await checkinService.verify({
        openId: req.openId, poiId,
        lng: Number(lng), lat: Number(lat),
        photoUrl: req.file ? `/uploads/${req.file.filename}` : null
    });
    if (result.status === 'pending') {
        return accepted(res, 3106, { status: 'pending', checkinId: result.checkin._id });
    }
    ok(res, {
        status: 'verified', points: result.points, totalPoints: result.totalPoints,
        badge: result.badge,
        ocr: { matched: result.checkin.proof?.matched, confidence: result.checkin.proof?.ocrConfidence }
    });
}));

// POST /api/checkin/qr — 扫码打卡（GPS 拒绝授权降级）
router.post('/qr', wrap(async (req, res) => {
    if (!memCache.rateLimit(`checkin:${req.openId}`, 1, 10000)) {
        return fail(res, 429, 2101, '打卡过频，请稍候');
    }
    const poiId = checkinService.verifyQrToken(req.body?.qrToken);
    if (!poiId) return fail(res, 400, 3102, '二维码无效或已过期');
    const result = await checkinService.verify({
        openId: req.openId, poiId, lng: 0, lat: 0, photoUrl: null, viaQrCode: true
    });
    ok(res, { status: result.status, points: result.points, totalPoints: result.totalPoints, badge: result.badge });
}));

// GET /api/checkin/mine — 图鉴 + 统计
router.get('/mine', wrap(async (req, res) => {
    const { Checkin, UserPoints, Badge, ExternalPoi } = getModels();
    const [points, recent, badges] = await Promise.all([
        UserPoints.findOne({ openId: req.openId }).lean(),
        Checkin.find({ openId: req.openId }).sort({ at: -1 }).limit(20).lean(),
        Badge.find({ active: true }).lean()
    ]);
    const todayStr = new Date().toISOString().slice(0, 10);
    const verifiedPoiIds = new Set(
        (await Checkin.distinct('poiId', { openId: req.openId, status: 'verified' })).map(String)
    );
    const badgeViews = [];
    for (const b of badges) {
        const pois = await ExternalPoi.find({ _id: { $in: b.poiIds } }, { poiName: 1 }).lean();
        const checked = b.poiIds.filter(id => verifiedPoiIds.has(String(id))).length;
        badgeViews.push({
            id: b.badgeId, name: b.name,
            progress: `${checked}/${b.poiIds.length}`,
            unlocked: checked >= b.poiIds.length,
            pois: pois.map(p => ({ poiId: p._id, name: p.poiName, checked: verifiedPoiIds.has(String(p._id)) }))
        });
    }
    const poiNames = await ExternalPoi.find(
        { _id: { $in: recent.map(c => c.poiId) } }, { poiName: 1 }
    ).lean();
    const nameMap = new Map(poiNames.map(p => [String(p._id), p.poiName]));
    ok(res, {
        totalPoints: points?.balance || 0,
        todayCount: recent.filter(c => c.date === todayStr).length,
        badges: badgeViews,
        recent: recent.map(c => ({
            poiId: c.poiId, name: nameMap.get(String(c.poiId)) || '',
            at: c.at, status: c.status, points: c.points,
            photoUrl: c.proof?.photoUrl || null
        }))
    });
}));

module.exports = router;
