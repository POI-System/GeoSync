'use strict';
// 03文档 §3：行程域。路由薄：校验 → service → respond。

const express = require('express');
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { ok, fail, wrap, BizError, safeErrorCode } = require('../lib/respond');
const { requireUser } = require('../lib/auth');
const bus = require('../lib/eventBus');
const memCache = require('../lib/memCache');
const planner = require('../services/planner');
const engine = require('../services/geosyncEngine');
const antiHerding = require('../services/antiHerding');
const forecast = require('../services/forecastService');
const guideService = require('../services/guideService');
const { createItineraryRuntime } = require('../services/itineraryRuntime');
const { rebuildTimeline, TimelineRebuildError } = require('../services/itineraryTimeline');
const {
    serializedRouteFields,
    aggregateRouteFromStops
} = require('../services/itineraryRouteData');
const {
    loadClosedBarrierSnapshot,
    routeAvoidsBarriers
} = require('../services/barrierReroute');
const geo = require('../lib/geo');

const router = express.Router();
router.use(requireUser);

let runtime;
function itineraryRuntime() {
    if (!runtime) {
        const { Itinerary } = getModels();
        runtime = createItineraryRuntime({
            Itinerary,
            onReleaseTokens: (tokenIds, context) =>
                antiHerding.releaseTokens(tokenIds, context.itinerary._id)
        });
    }
    return runtime;
}

function progressPayload(itinerary) {
    return {
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
    };
}

function emitProgress(itinerary) {
    bus.emit(bus.EVENTS.ITINERARY_PROGRESS, progressPayload(itinerary));
}

async function bestEffort(label, operation) {
    try {
        return await operation();
    } catch (error) {
        console.error(`[GeoSync] [ITINERARY] ${label}:`,
            safeErrorCode(error, 'ITINERARY_POST_COMMIT_FAILED'));
        return null;
    }
}

function startCoordinates(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) return null;
    return [value[0], value[1]];
}

const INVALID_START_AT = Symbol('invalid-start-at');

function normalizeStartAt(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (!['string', 'number'].includes(typeof value)) return INVALID_START_AT;
    if (typeof value === 'string' && !value.trim()) return INVALID_START_AT;
    if (typeof value === 'number' && !Number.isFinite(value)) return INVALID_START_AT;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : INVALID_START_AT;
}

function routeBetweenOf(req) {
    const routeBetween = req?.app?.locals?.geosync?.routeBetween;
    if (typeof routeBetween !== 'function') {
        throw new BizError(8201, 'GIS route provider is unavailable', 503);
    }
    return routeBetween;
}

function tokenIdsOf(itinerary) {
    return [...new Set([
        ...(itinerary.pendingProposal?.tokenIds || []),
        ...(itinerary.stops || []).map(stop => stop.capacityTokenId).filter(Boolean)
    ].map(String))];
}

function proposalEventId(proposal) {
    const eventId = proposal?.payload?.eventId;
    return eventId === undefined || eventId === null || !String(eventId).trim()
        ? null
        : String(eventId).trim();
}

function proposalEdgeId(proposal) {
    const edgeId = proposal?.payload?.edgeId;
    return edgeId === undefined || edgeId === null || !String(edgeId).trim()
        ? null
        : String(edgeId).trim();
}

function proposalBarrierFingerprint(proposal) {
    const fingerprint = proposal?.payload?.barrierFingerprint;
    return fingerprint === undefined || fingerprint === null || !String(fingerprint).trim()
        ? null
        : String(fingerprint).trim();
}

function proposalWithBarrierSnapshot(proposal, snapshot) {
    if (!snapshot) return proposal;
    const plain = proposal?.toObject ? proposal.toObject() : proposal;
    return {
        ...plain,
        payload: {
            ...(plain?.payload || {}),
            barrierFingerprint: snapshot.fingerprint,
            barrierEdgeIds: [...snapshot.edgeIds]
        }
    };
}

function rerouteLogEntry(proposal, status, at, savedMin, accepted) {
    return {
        at,
        type: proposal.type,
        reason: proposal.reason,
        savedMin,
        accepted,
        status,
        proposalId: proposal.proposalId,
        eventId: proposalEventId(proposal),
        edgeId: proposalEdgeId(proposal),
        barrierFingerprint: proposalBarrierFingerprint(proposal)
    };
}

function emitProposalDecision(itinerary, proposal, status, at) {
    bus.emit(bus.EVENTS.REROUTE_DECIDED, {
        openId: itinerary.openId,
        itineraryId: itinerary._id,
        proposalId: proposal.proposalId,
        status,
        accepted: status === 'accepted',
        version: itinerary.version,
        at: at.toISOString(),
        eventId: proposalEventId(proposal)
    });
}

// ---- 序列化 ----
async function serialize(it) {
    if (!it) return null;
    const { ExternalPoi } = getModels();
    const poiIds = it.stops.map(s => s.poiId);
    const pois = await ExternalPoi.find({ _id: { $in: poiIds } }).lean().catch(error => {
        console.error('[GeoSync] [ITINERARY] POI enrichment unavailable:',
            safeErrorCode(error, 'POI_ENRICHMENT_FAILED'));
        return [];
    });
    const poiMap = new Map(pois.map(p => [String(p._id), p]));
    const stops = it.stops.map(s => {
        const poi = poiMap.get(String(s.poiId));
        const f = forecast.getForecast(s.poiId);
        const route = serializedRouteFields(s);
        return {
            stopId: s._id, poiId: s.poiId,
            poiName: poi?.poiName || '',
            photoSpotId: s.photoSpotId,
            plannedArrive: s.plannedArrive, plannedLeave: s.plannedLeave,
            actualArrive: s.actualArrive || null,
            actualLeave: s.actualLeave || null,
            capacityTokenId: s.capacityTokenId || null,
            state: s.state,
            ci: f ? { predictedAtArrive: f.p30 } : null,
            geometry: route.geometry,
            distanceM: route.distanceM,
            durationSec: route.durationSec,
            gis: route.gis,
            segments: route.segments,
            snap: route.snap,
            verifiedAccessible: route.verifiedAccessible,
            pathGeometry: route.pathGeometry
        };
    });
    const cur = it.stops.find(s => ['approaching', 'arrived'].includes(s.state)) ||
        it.stops.find(s => s.state === 'pending');
    return {
        itineraryId: it._id, version: it.version, state: it.state,
        date: it.date, preferences: it.preferences,
        stops,
        route: it.route
            ? serializedRouteFields(it.route)
            : aggregateRouteFromStops(it.stops, it.preferences),
        currentStopId: cur?._id || null,
        pendingProposal: it.pendingProposal?.proposalId
            ? engine.publicProposalView(
                it.pendingProposal,
                engine.proposalDiff(it, it.pendingProposal)
            )
            : null,
        savedMinutesTotal: it.savedMinutesTotal,
        rerouteCount: it.rerouteCount
    };
}

// POST /plan
router.post('/plan', wrap(async (req, res) => {
    if (!memCache.rateLimit(`plan:${req.openId}`, 3, 60000)) {
        return fail(res, 429, 2101, '规划请求过频，请稍候');
    }
    const { startLocation, startAt, hours, interests, pace, accessible, shadeFirst } = req.body || {};
    const normalizedStartAt = normalizeStartAt(startAt);
    if (normalizedStartAt === INVALID_START_AT) {
        return fail(res, 400, 1102, 'startAt 必须是有效日期时间');
    }
    const { Itinerary } = getModels();
    const existing = await Itinerary.findOne({
        openId: req.openId, state: { $in: ['draft', 'active', 'paused'] }
    }).lean();
    if (existing) {
        return fail(res, 400, 1206, '存在未完成行程', { existingId: existing._id });
    }
    const origin = startCoordinates(startLocation) || CONFIG.scenicCenter;
    const routeBetween = routeBetweenOf(req);
    const result = await planner.plan({
        startLocation: origin, startAt: normalizedStartAt, hours: Number(hours),
        interests, pace, accessible: Boolean(accessible), shadeFirst: Boolean(shadeFirst),
        openId: req.openId,
        requestId: req.headers?.['x-request-id']
    }, { routeBetween });
    let it;
    try {
        it = await Itinerary.create({
            scenicId: CONFIG.scenicId, openId: req.openId, activeOwner: req.openId,
            date: geo.dateStrOf(normalizedStartAt || new Date()),
            startLocation: origin ? { type: 'Point', coordinates: origin } : null,
            preferences: { pace: pace || 'normal', interests: interests || [], hours: Number(hours), accessible: Boolean(accessible), shadeFirst: Boolean(shadeFirst) },
            stops: result.stops,
            route: result.route
        });
    } catch (error) {
        if (error?.code === 11000) {
            return fail(res, 400, 1206, '存在未完成行程');
        }
        throw error;
    }
    const data = await serialize(it);
    data.totalWalkMin = result.totalWalkMin;
    data.planNote = result.planNote;
    ok(res, data);
}));

// GET /current
router.get('/current', wrap(async (req, res) => {
    const { Itinerary } = getModels();
    const it = await Itinerary.findOne({
        openId: req.openId, state: { $in: ['draft', 'active', 'paused'] }
    }).sort({ createTime: -1 });
    ok(res, await serialize(it));
}));

// ---- 状态操作（乐观锁）----
router.post('/:id/start', wrap(async (req, res) => {
    const result = await itineraryRuntime().start({
        itineraryId: req.params.id,
        openId: req.openId,
        version: Number(req.body?.version)
    });
    if (result.status === 'conflict' || result.status === 'not_found') {
        return fail(res, 409, 1203, '行程版本已过期，请刷新');
    }
    if (result.releaseError) {
        console.error('[GeoSync] [ITINERARY] start token release failed:',
            safeErrorCode(result.releaseError, 'TOKEN_RELEASE_FAILED'));
    }
    if (result.status === 'updated') {
        await bestEffort('arrival index rebuild failed', () => forecast.rebuildArrivalIndex());
        emitProgress(result.itinerary);
    }
    ok(res, await serialize(result.itinerary));
}));

const TRANSITIONS = {
    pause: { from: ['active'], to: 'paused' },
    resume: { from: ['paused'], to: 'active' },
    finish: { from: ['active', 'paused'], to: 'completed' },
    abandon: { from: ['draft', 'active', 'paused'], to: 'abandoned' }
};

for (const [action, t] of Object.entries(TRANSITIONS)) {
    router.post(`/:id/${action}`, wrap(async (req, res) => {
        const { Itinerary } = getModels();
        const version = Number(req.body?.version);
        const filter = {
            _id: req.params.id, openId: req.openId, version, state: { $in: t.from }
        };
        const current = await Itinerary.findOne(filter);
        if (!current) return fail(res, 409, 1203, '行程版本已过期，请刷新');

        const terminal = action === 'finish' || action === 'abandon';
        const releaseTokenIds = terminal ? tokenIdsOf(current) : [];
        const set = { state: t.to };
        if (!terminal) set.activeOwner = current.openId;
        if (terminal) {
            set.pendingProposal = null;
            set.stops = current.stops.map(stop => ({
                ...(stop.toObject ? stop.toObject() : stop),
                capacityTokenId: null
            }));
        }
        const update = { $set: set, $inc: { version: 1 } };
        if (terminal) update.$unset = { activeOwner: 1 };
        const it = await Itinerary.findOneAndUpdate(filter, update, { new: true });
        if (!it) return fail(res, 409, 1203, '行程版本已过期，请刷新');
        if (releaseTokenIds.length) {
            await bestEffort('terminal token release failed', () =>
                antiHerding.releaseTokens(releaseTokenIds, it._id));
        }
        await bestEffort('arrival index rebuild failed', () => forecast.rebuildArrivalIndex());
        emitProgress(it);
        if (action === 'finish') {
            const data = await serialize(it);
            data.poster = { savedMinutes: it.savedMinutesTotal };
            return ok(res, data);
        }
        ok(res, await serialize(it));
    }));
}

// POST /:id/stops/:stopId/skip
router.post('/:id/stops/:stopId/skip', wrap(async (req, res) => {
    const result = await itineraryRuntime().skip({
        itineraryId: req.params.id,
        openId: req.openId,
        version: Number(req.body?.version),
        stopId: req.params.stopId
    });
    if (result.status === 'conflict' || result.status === 'not_found') {
        return fail(res, 409, 1203, '行程版本已过期或站点不可跳过');
    }
    if (result.releaseError) {
        console.error('[GeoSync] [ITINERARY] skip token release failed:',
            safeErrorCode(result.releaseError, 'TOKEN_RELEASE_FAILED'));
    }
    if (result.status === 'updated') {
        await bestEffort('arrival index rebuild failed', () => forecast.rebuildArrivalIndex());
        emitProgress(result.itinerary);
    }
    ok(res, await serialize(result.itinerary));
}));

// POST /:id/proposal/:proposalId/accept|reject
router.post('/:id/proposal/:proposalId/:decision(accept|reject)', wrap(async (req, res) => {
    const { Itinerary, WalkEdge } = getModels();
    const version = Number(req.body?.version);
    const it = await Itinerary.findOne({ _id: req.params.id, openId: req.openId });
    if (!it) return fail(res, 404, 1204, '行程不存在');
    if (Number(it.version) !== version) {
        return fail(res, 409, 1203, '行程版本已过期，请刷新');
    }
    const pp = it.pendingProposal;
    if (!pp?.proposalId || pp.proposalId !== req.params.proposalId) {
        return fail(res, 400, 1204, '提案不存在或已过期');
    }
    const now = new Date();
    if (new Date(pp.expireAt) <= now) {
        return fail(res, 400, 1204, '提案已过期');
    }
    const accepted = req.params.decision === 'accept';

    if (accepted) {
        const routeBetween = routeBetweenOf(req);
        let barrierSnapshot = null;
        let routeContext = {};
        if (pp.type === 'barrierReroute') {
            try {
                barrierSnapshot = await loadClosedBarrierSnapshot({
                    WalkEdge,
                    scenicId: String(it.scenicId || CONFIG.scenicId)
                });
            } catch (error) {
                return fail(res, 409, 8205, '当前封路数据缺少可验证的 GIS 映射');
            }
            const eventId = proposalEventId(pp) || `proposal-${pp.proposalId}`;
            routeContext = {
                barriers: barrierSnapshot.barriers,
                requestId: eventId,
                eventId,
                barrierFingerprint: barrierSnapshot.fingerprint
            };
        }
        const lifecycleProposal = proposalWithBarrierSnapshot(pp, barrierSnapshot);
        const claimId = 'c_' + crypto.randomBytes(8).toString('hex');
        const claimed = await antiHerding.claimTokens(pp.tokenIds, it._id, now, claimId);
        if (!claimed) {
            return fail(res, 409, 1205, '推荐名额已失效，请刷新行程');
        }

        const proposedStops = engine.applyProposal(it, pp);
        if (!proposedStops) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 400, 1205, '提案已无法应用');
        }

        let newStops;
        try {
            newStops = await rebuildTimeline({
                itinerary: it,
                proposedStops,
                proposal: pp,
                now,
                routeBetween,
                routeContext
            });
        } catch (error) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            if (error instanceof TimelineRebuildError) {
                return fail(res, 400, 1205, '剩余路线暂时无法重建');
            }
            throw error;
        }
        const newRoute = aggregateRouteFromStops(newStops, it.preferences, it.route);
        if (barrierSnapshot && !routeAvoidsBarriers(
            { stops: newStops, route: newRoute },
            barrierSnapshot.barriers
        )) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 409, 8205, '重建路线仍包含当前关闭路段');
        }

        const commitNow = new Date();
        const claimStillActive = await antiHerding.claimedTokensActive(
            pp.tokenIds, it._id, claimId, commitNow
        );
        if (new Date(pp.expireAt) <= commitNow || !claimStillActive) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 409, 1205, '提案或推荐名额已失效，请刷新行程');
        }

        let updated;
        try {
            updated = await Itinerary.findOneAndUpdate(
                {
                    _id: it._id,
                    openId: req.openId,
                    version,
                    state: 'active',
                    'pendingProposal.proposalId': pp.proposalId,
                    'pendingProposal.expireAt': { $gt: commitNow }
                },
                {
                    $set: { stops: newStops, route: newRoute, pendingProposal: null },
                    $inc: { version: 1, rerouteCount: 1, savedMinutesTotal: pp.gainMin || 0 },
                    $push: {
                        rerouteLog: rerouteLogEntry(
                            lifecycleProposal, 'accepted', commitNow, pp.gainMin || 0, true
                        )
                    }
                },
                { new: true }
            );
        } catch (error) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            throw error;
        }
        if (!updated) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 409, 1203, '行程版本已过期，请刷新');
        }

        const activeTokenIds = new Set(newStops
            .filter(stop => ['pending', 'approaching'].includes(stop.state) && stop.capacityTokenId)
            .map(stop => String(stop.capacityTokenId)));
        const displacedTokenIds = (it.stops || [])
            .map(stop => stop.capacityTokenId)
            .filter(id => id && !activeTokenIds.has(String(id)));
        if (displacedTokenIds.length) await bestEffort(
            'displaced token release failed',
            () => antiHerding.releaseTokens(displacedTokenIds, it._id)
        );

        let arrivalIndexReady = false;
        try {
            await forecast.rebuildArrivalIndex();
            arrivalIndexReady = true;
        } catch (error) {
            console.error('[GeoSync] [ITINERARY] arrival index rebuild failed:',
                safeErrorCode(error, 'ARRIVAL_INDEX_REBUILD_FAILED'));
        }
        if (arrivalIndexReady) {
            await antiHerding.finalizeClaimedTokens(pp.tokenIds, it._id, claimId).catch(error =>
                console.error('[GeoSync] [ITINERARY] token finalize failed:',
                    safeErrorCode(error, 'TOKEN_FINALIZE_FAILED')));
        }
        emitProposalDecision(updated, lifecycleProposal, 'accepted', commitNow);
        emitProgress(updated);
        return ok(res, await serialize(updated));
    }

    const updated = await Itinerary.findOneAndUpdate(
        {
            _id: it._id,
            openId: req.openId,
            version,
            state: 'active',
            'pendingProposal.proposalId': pp.proposalId,
            'pendingProposal.expireAt': { $gt: now }
        },
        {
            $set: { pendingProposal: null },
            $inc: { version: 1 },
            $push: {
                rerouteLog: rerouteLogEntry(pp, 'rejected', now, 0, false)
            }
        },
        { new: true }
    );
    if (!updated) return fail(res, 409, 1203, '行程版本已过期，请刷新');
    await bestEffort('rejected proposal token release failed', () =>
        antiHerding.releaseTokens(pp.tokenIds, it._id));
    emitProposalDecision(updated, pp, 'rejected', now);
    ok(res, { version: updated.version });
}));

// POST /:id/nl-edit
router.post('/:id/nl-edit', wrap(async (req, res) => {
    if (!memCache.rateLimit(`nl:${req.openId}`, 5, 60000)) {
        return fail(res, 429, 2101, '请求过频');
    }
    const { Itinerary, ExternalPoi } = getModels();
    const it = await Itinerary.findOne({ _id: req.params.id, openId: req.openId });
    if (!it) return fail(res, 404, 1204, '行程不存在');
    if (it.pendingProposal?.proposalId) {
        return fail(res, 409, 1205, '已有待处理提案');
    }
    const text = String(req.body?.text || '').slice(0, 200);
    if (!text) return fail(res, 400, 1101, '缺少编辑内容');

    const pois = await ExternalPoi.find({ _id: { $in: it.stops.map(s => s.poiId) } }, { poiName: 1 }).lean();
    const summary = it.stops.map(s => ({
        poiId: String(s.poiId),
        name: pois.find(p => String(p._id) === String(s.poiId))?.poiName,
        arrive: s.plannedArrive, state: s.state
    }));
    const ops = await guideService.parseNlEdit(text, summary);

    // Parsed operations remain preview-only until every op can be applied by the
    // versioned route rebuild and preference update contract.
    ok(res, {
        version: it.version,
        previewOnly: true,
        applied: false,
        pendingProposal: null,
        preview: {
            type: 'nlEdit',
            parsedOps: ops,
            reason: `根据你的要求"${text}"调整行程`,
            gainMin: 0
        }
    });
}));

// GET /:id/poster
router.get('/:id/poster', wrap(async (req, res) => {
    const { Itinerary, Checkin } = getModels();
    const it = await Itinerary.findOne({ _id: req.params.id, openId: req.openId }).lean();
    if (!it) return fail(res, 404, 1204, '行程不存在');
    const checkins = await Checkin.find({ openId: req.openId, date: it.date, status: 'verified' })
        .sort({ at: 1 }).limit(9).lean();
    ok(res, {
        checkinPhotos: checkins.map(c => c.proof?.photoUrl).filter(Boolean),
        stats: {
            poiVisited: it.stops.filter(s => s.state === 'done').length,
            savedMinutes: it.savedMinutesTotal,
            stops: it.stops.length
        },
        posterUrl: null // Server-side composite generation is outside the P0 contract.
    });
}));

module.exports = router;
