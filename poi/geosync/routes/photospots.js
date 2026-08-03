'use strict';
// 03文档 §5：摄影域。

const express = require('express');
const multer = require('multer');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { ok, fail, wrap, BizError } = require('../lib/respond');
const { requireUser } = require('../lib/auth');
const sunlight = require('../services/sunlight');
const forecast = require('../services/forecastService');
const crowdService = require('../services/crowdService');
const geo = require('../lib/geo');

const router = express.Router();

const upload = multer({
    dest: CONFIG.uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype));
    }
});

// GET /api/photospots?near=lng,lat&radius=500&sort=score
router.get('/', wrap(async (req, res) => {
    const { PhotoSpot } = getModels();
    const q = { status: 'approved' };
    const near = String(req.query.near || '').split(',').map(Number);
    const radius = Math.min(Number(req.query.radius) || 500, 5000);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    if (req.query.seasonTag) q.seasonTags = req.query.seasonTag;

    let spots;
    if (near.length === 2 && near.every(Number.isFinite)) {
        spots = await PhotoSpot.find({
            ...q,
            geo: { $near: { $geometry: { type: 'Point', coordinates: near }, $maxDistance: radius } }
        }).limit(limit).lean();
    } else {
        spots = await PhotoSpot.find(q).sort({ score: -1 }).limit(limit).lean();
    }
    if (req.query.sort === 'score') spots.sort((a, b) => b.score - a.score);

    const todayStr = sunlight.dateStr(new Date(), CONFIG.scenicTimeZone);
    const heat = crowdService.getHeatmapSnapshot();
    ok(res, {
        items: spots.map(s => ({
            spotId: s._id, poiId: s.poiId, name: s.name,
            lnglat: s.geo.coordinates, heading: s.heading, score: s.score,
            coverPhoto: s.samplePhotos?.find(p => p.status === 'approved')?.url || null,
            todayWindows: (s.goldenWindows || []).filter(w => w.date === todayStr)
                .map(({ start, end, light }) => ({ start, end, light })),
            ciNow: heat?.items?.find(i => String(i.poiId) === String(s.poiId))?.ci ?? null,
            distanceM: near.length === 2 && near.every(Number.isFinite)
                ? Math.round(geo.haversine(near, s.geo.coordinates)) : null
        }))
    });
}));

// GET /api/photospots/:id/golden
router.get('/:id/golden', wrap(async (req, res) => {
    const { PhotoSpot } = getModels();
    const spot = await PhotoSpot.findById(req.params.id).lean();
    if (!spot || spot.status !== 'approved') throw new BizError(4101, '机位不存在或未过审', 404);

    // Null keeps the documented no-weather correction without provider context.
    const now = new Date();
    const result = sunlight.computeWindows(spot, now, null, { timeZone: CONFIG.scenicTimeZone });
    if (!result.windows.length && !result.cloudy) {
        return fail(res, 400, 4102, '今日无光位窗口');
    }
    ok(res, {
        date: sunlight.dateStr(now, CONFIG.scenicTimeZone),
        windows: result.windows.map(w => ({
            start: w.start, end: w.end, light: w.light,
            ...(w.trueSunset ? { trueSunset: w.trueSunset, geometricSunset: result.geometricSunset } : {}),
            ciPredicted: forecast.getForecast(spot.poiId)?.p30 ?? null
        })),
        trueSunset: result.trueSunset,
        geometricSunset: result.geometricSunset,
        weatherAdjusted: false,
        cloudy: result.cloudy
    });
}));

// GET /api/photospots/:id/ar
router.get('/:id/ar', wrap(async (req, res) => {
    const { PhotoSpot } = getModels();
    const spot = await PhotoSpot.findById(req.params.id).lean();
    if (!spot || spot.status !== 'approved') throw new BizError(4101, '机位不存在或未过审', 404);
    const best = (spot.samplePhotos || []).filter(p => p.status === 'approved')
        .sort((a, b) => (b.likes || 0) - (a.likes || 0))[0];
    const heat = crowdService.getHeatmapSnapshot()?.items?.find(i => String(i.poiId) === String(spot.poiId));
    ok(res, {
        heading: spot.heading, tolerance: 10,
        overlayPhoto: best?.url || null,
        focalHint: best?.exif?.focal || '',
        ciNow: heat?.ci ?? null,
        fallbackCard: {
            text: spot.elevationHint || `面朝${headingText(spot.heading)}方向拍摄`,
            photos: (spot.samplePhotos || []).filter(p => p.status === 'approved').map(p => p.url).slice(0, 3)
        }
    });
}));

function headingText(h) {
    const dirs = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
    return dirs[Math.round(h / 45) % 8];
}

// POST /api/photospots（众包上报，进审核流）
router.post('/', requireUser, upload.single('photo'), wrap(async (req, res) => {
    if (!req.file) return fail(res, 400, 3107, '请上传样片');
    const { PhotoSpot } = getModels();
    const { poiId, name, heading, lng, lat, elevationHint, seasonTags } = req.body || {};
    const h = Number(heading), lo = Number(lng), la = Number(lat);
    if (!poiId || !name || !Number.isFinite(h) || !Number.isFinite(lo) || !Number.isFinite(la)) {
        return fail(res, 400, 1101, '参数不足');
    }
    const spot = await PhotoSpot.create({
        scenicId: CONFIG.scenicId, poiId, name: String(name).slice(0, 50),
        geo: { type: 'Point', coordinates: [lo, la] },
        heading: ((Math.round(h) % 360) + 360) % 360,
        elevationHint: String(elevationHint || '').slice(0, 100),
        seasonTags: String(seasonTags || '').split(',').filter(Boolean),
        samplePhotos: [{ url: `/uploads/${req.file.filename}`, status: 'pending' }],
        status: 'pending',
        contributorOpenId: req.openId
    });
    ok(res, { spotId: spot._id, status: 'pending' });
}));

module.exports = router;
