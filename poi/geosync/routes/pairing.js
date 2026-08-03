'use strict';
// 03文档 §7 帮拍域 + §8 AI 导游。

const express = require('express');
const { getModels } = require('../models');
const { ok, fail, wrap, BizError } = require('../lib/respond');
const { requireUser } = require('../lib/auth');
const {
    cleanupRequestUploads,
    rejectMismatchedMultipartIdentity
} = require('../lib/identityHints');
const { createImageUpload } = require('../lib/imageUpload');
const memCache = require('../lib/memCache');
const pairingService = require('../services/pairingService');
const guideService = require('../services/guideService');

const pairingRouter = express.Router();
pairingRouter.use(requireUser);

const uploadPhoto = createImageUpload('photo');

// POST /api/pairing/optin
pairingRouter.post('/optin', wrap(async (req, res) => {
    const { PairingProfile, Itinerary } = getModels();
    const enabled = Boolean(req.body?.enabled);
    const genderFilter = req.body?.genderFilter === 'female' ? 'female' : 'any';
    const prof = await PairingProfile.findOneAndUpdate(
        { openId: req.openId },
        { $set: { enabled, genderFilter } },
        { upsert: true, new: true }
    );
    if (prof.banned) throw new BizError(5103, '帮拍功能不可用', 403);
    // 同步冗余到当前行程（扫描高频读）
    await Itinerary.updateMany(
        { openId: req.openId, state: { $in: ['draft', 'active', 'paused'] } },
        { $set: { 'preferences.pairingOptIn': enabled } }
    );
    ok(res, { enabled });
}));

// GET /api/pairing/mine
pairingRouter.get('/mine', wrap(async (req, res) => {
    const { Pairing } = getModels();
    const list = await Pairing.find({
        'users.openId': req.openId, state: { $in: ['proposed', 'confirmed'] }
    }).lean();
    ok(res, { items: list.map(p => pairingService.publicView(p, req.openId)) });
}));

pairingRouter.post('/:id/accept', wrap(async (req, res) => {
    const p = await pairingService.respond(req.params.id, req.openId, true);
    ok(res, pairingService.publicView(p, req.openId));
}));

pairingRouter.post('/:id/reject', wrap(async (req, res) => {
    await pairingService.respond(req.params.id, req.openId, false);
    ok(res, { declined: true });
}));

pairingRouter.post('/:id/quickmsg', wrap(async (req, res) => {
    const { Pairing } = getModels();
    const preset = Number(req.body?.preset);
    if (![0, 1, 2].includes(preset)) return fail(res, 400, 1101, '仅支持预设语句');
    const p = await Pairing.findById(req.params.id);
    if (!p || !p.users.some(u => u.openId === req.openId)) throw new BizError(5102, '匹配不存在');
    p.quickMessages.push({ from: req.openId, preset, at: new Date() });
    await p.save();
    // Socket 推送给对方（notifyBridge io）
    const other = p.users.find(u => u.openId !== req.openId);
    const io = require('../services/notifyBridge').getIo();
    if (io && other) {
        io.to(`user:${other.openId}`).emit('pairing:quickmsg', {
            pairingId: p._id, preset, text: pairingService.QUICK_MSGS[preset]
        });
    }
    ok(res, { sent: true });
}));

pairingRouter.post('/:id/fulfill', uploadPhoto, wrap(async (req, res) => {
    let uploadCommitted = false;
    try {
        if (await rejectMismatchedMultipartIdentity(req, req.openId)) {
            return fail(res, 403, 9001, 'User identity does not match the session');
        }
        const p = await pairingService.fulfill(
            req.params.id, req.openId,
            req.file ? `/uploads/${req.file.filename}` : null
        );
        uploadCommitted = Boolean(req.file);
        ok(res, { fulfilled: p.state === 'fulfilled', pointsEach: p.state === 'fulfilled' ? 20 : 0 });
    } catch (error) {
        if (!uploadCommitted) await cleanupRequestUploads(req);
        throw error;
    }
}));

pairingRouter.post('/:id/rate', wrap(async (req, res) => {
    const stars = Number(req.body?.stars);
    if (!(stars >= 1 && stars <= 5)) return fail(res, 400, 1101, '评分1~5星');
    await pairingService.rate(req.params.id, req.openId, stars);
    ok(res, { rated: true });
}));

pairingRouter.post('/:id/report', wrap(async (req, res) => {
    const { Pairing, GeoSetting } = getModels();
    const p = await Pairing.findById(req.params.id).lean();
    if (!p || !p.users.some(u => u.openId === req.openId)) throw new BizError(5102, '匹配不存在');
    const other = p.users.find(u => u.openId !== req.openId);
    await GeoSetting.updateOne(
        { key: 'pairingReports' },
        {
            $push: {
                'value.list': {
                    at: new Date(), from: req.openId, against: other?.openId,
                    pairingId: p._id, reason: String(req.body?.reason || '').slice(0, 200)
                }
            }
        },
        { upsert: true }
    );
    ok(res, { reported: true });
}));

// ===== AI 导游 =====
const guideRouter = express.Router();
guideRouter.use(requireUser);

// GET /api/guide/:poiId?daypart=
guideRouter.get('/:poiId', wrap(async (req, res) => {
    if (!memCache.rateLimit(`guide:${req.openId}`, 5, 60000)) {
        return fail(res, 429, 2101, '请求过频');
    }
    const g = await guideService.getGuide(req.params.poiId, req.query.daypart);
    ok(res, g);
}));

module.exports = { pairingRouter, guideRouter };
