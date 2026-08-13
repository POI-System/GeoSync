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
    RouteDataVersionError,
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

function estimateBetweenOf(req) {
    const estimateBetween = req?.app?.locals?.geosync?.estimateBetween;
    if (typeof estimateBetween !== 'function') {
        throw new BizError(8201, 'GIS topology estimator is unavailable', 503);
    }
    return estimateBetween;
}

function dataVersionOf(req) {
    const value = req?.app?.locals?.geosync?.dataVersion;
    return typeof value === 'function' ? value() : value;
}

function normalizedDataVersion(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function loadRoutingSnapshot(req, WalkEdge, scenicId = CONFIG.scenicId) {
    let barrierSnapshot;
    try {
        barrierSnapshot = await loadClosedBarrierSnapshot({ WalkEdge, scenicId });
    } catch {
        throw new BizError(8205, '当前封路状态不可验证，路径操作已安全停止', 409);
    }
    const dataVersion = normalizedDataVersion(await dataVersionOf(req));
    if (!dataVersion) {
        throw new BizError(8205, '当前 GIS 数据版本不可验证，路径操作已安全停止', 409);
    }
    return {
        barriers: barrierSnapshot.barriers,
        edgeIds: [...barrierSnapshot.edgeIds],
        fingerprint: barrierSnapshot.fingerprint,
        dataVersion,
        capturedAt: new Date()
    };
}

function persistedPlanningSnapshot(snapshot) {
    return {
        barrierFingerprint: snapshot.fingerprint,
        barrierEdgeIds: [...snapshot.edgeIds],
        dataVersion: snapshot.dataVersion,
        capturedAt: snapshot.capturedAt || new Date(),
        invalidatedAt: null,
        invalidationReason: null
    };
}

function storedPlanningSnapshot(itinerary) {
    const snapshot = itinerary?.planningSnapshot?.toObject
        ? itinerary.planningSnapshot.toObject()
        : itinerary?.planningSnapshot;
    const barrierFingerprint = typeof snapshot?.barrierFingerprint === 'string'
        ? snapshot.barrierFingerprint.trim()
        : '';
    const dataVersion = normalizedDataVersion(snapshot?.dataVersion);
    if (!barrierFingerprint || !dataVersion || snapshot?.invalidatedAt) return null;
    return { barrierFingerprint, dataVersion };
}

function routingSnapshotMatchesStored(current, stored) {
    return Boolean(
        current
        && stored
        && current.fingerprint === stored.barrierFingerprint
        && current.dataVersion === stored.dataVersion
    );
}

function routingSnapshotsEqual(left, right) {
    return Boolean(
        left
        && right
        && left.fingerprint === right.fingerprint
        && left.dataVersion === right.dataVersion
    );
}

function planningSnapshotCasFilter(snapshot) {
    return {
        'planningSnapshot.barrierFingerprint': snapshot.barrierFingerprint,
        'planningSnapshot.dataVersion': snapshot.dataVersion,
        'planningSnapshot.invalidatedAt': null
    };
}

function stopsWithoutCapacityTokens(stops) {
    return (stops || []).map(stop => ({
        ...(stop?.toObject ? stop.toObject() : stop),
        capacityTokenId: null
    }));
}

async function invalidateStaleItinerary({
    Itinerary,
    itinerary,
    openId,
    reason,
    allowMissingSnapshot = false,
    extraTokenIds = []
}) {
    const expectedSnapshot = storedPlanningSnapshot(itinerary);
    if (!expectedSnapshot && !allowMissingSnapshot) return null;
    const tokenIds = new Set((extraTokenIds || []).map(String));
    let candidate = itinerary;
    const mutableStates = ['draft', 'active', 'paused'];
    const snapshotFilter = expectedSnapshot
        ? planningSnapshotCasFilter(expectedSnapshot)
        : { planningSnapshot: null };

    function invalidationUpdate(source) {
        const invalidatedAt = new Date();
        return {
            $set: {
                state: 'abandoned',
                stops: stopsWithoutCapacityTokens(source.stops),
                pendingProposal: null,
                ...(expectedSnapshot ? {
                    'planningSnapshot.invalidatedAt': invalidatedAt,
                    'planningSnapshot.invalidationReason': reason
                } : {
                    planningSnapshot: null
                })
            },
            $unset: { activeOwner: 1 },
            $inc: { version: 1 }
        };
    }

    function finalInvalidationUpdate() {
        const invalidatedAt = new Date();
        return {
            $set: {
                state: 'abandoned',
                pendingProposal: null,
                'stops.$[].capacityTokenId': null,
                ...(expectedSnapshot ? {
                    'planningSnapshot.invalidatedAt': invalidatedAt,
                    'planningSnapshot.invalidationReason': reason
                } : {
                    planningSnapshot: null
                })
            },
            $unset: { activeOwner: 1 },
            $inc: { version: 1 }
        };
    }

    async function releaseInvalidatedTokens(source) {
        for (const tokenId of tokenIdsOf(source)) tokenIds.add(String(tokenId));
        if (tokenIds.size) {
            await bestEffort('stale itinerary token release failed', () =>
                antiHerding.releaseTokens([...tokenIds], source._id));
        }
    }

    for (let attempt = 0; attempt < 3 && candidate; attempt++) {
        for (const tokenId of tokenIdsOf(candidate)) tokenIds.add(String(tokenId));
        const invalidated = await Itinerary.findOneAndUpdate(
            {
                _id: candidate._id,
                openId,
                state: { $in: mutableStates },
                version: Number(candidate.version),
                ...snapshotFilter
            },
            invalidationUpdate(candidate),
            { new: true }
        );
        if (invalidated) {
            await releaseInvalidatedTokens(candidate);
            return invalidated;
        }
        if (typeof Itinerary.findOne !== 'function') break;

        const latest = await Itinerary.findOne({
            _id: candidate._id,
            openId,
            state: { $in: mutableStates }
        });
        if (!latest) return candidate;
        const latestSnapshot = storedPlanningSnapshot(latest);
        if (expectedSnapshot) {
            if (!latestSnapshot
                || latestSnapshot.barrierFingerprint !== expectedSnapshot.barrierFingerprint
                || latestSnapshot.dataVersion !== expectedSnapshot.dataVersion) {
                throw new BizError(
                    8205,
                    '行程在失效处理期间发生并发变化，无法确认旧路线已安全停用',
                    409
                );
            }
        } else if (latestSnapshot) {
            throw new BizError(
                8205,
                '行程在失效处理期间获得了未知规划快照，无法确认旧路线已安全停用',
                409
            );
        }
        candidate = latest;
    }

    // A final snapshot-guarded update removes the version race. It can only
    // abandon an itinerary that still carries the exact stale snapshot.
    const invalidated = await Itinerary.findOneAndUpdate(
        {
            _id: itinerary._id,
            openId,
            state: { $in: mutableStates },
            ...snapshotFilter
        },
        finalInvalidationUpdate(),
        { new: false }
    );
    if (invalidated) {
        await releaseInvalidatedTokens(invalidated);
        return invalidated;
    }

    if (typeof Itinerary.findOne === 'function') {
        const remaining = await Itinerary.findOne({
            _id: itinerary._id,
            openId,
            state: { $in: mutableStates },
            ...snapshotFilter
        });
        if (!remaining) return candidate || itinerary;
    }
    throw new BizError(8205, '旧路线无法被安全停用，请立即刷新行程状态', 409);
}

function routeContextFromSnapshot(snapshot, extra = {}) {
    return {
        barriers: snapshot.barriers,
        barrierFingerprint: snapshot.fingerprint,
        dataVersion: snapshot.dataVersion,
        ...extra
    };
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
            barrierEdgeIds: [...snapshot.edgeIds],
            dataVersion: snapshot.dataVersion
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

function publicBarrierProposalPreview(publicRoute, proposal) {
    const source = proposal?.toObject ? proposal.toObject() : proposal;
    const payload = source?.payload?.toObject ? source.payload.toObject() : source?.payload;
    if (source?.type !== 'barrierReroute' || !payload?.route) return {};

    const beforeRoute = serializedRouteFields(publicRoute);
    const afterRoute = serializedRouteFields(payload.route);
    if (!beforeRoute.geometry || !afterRoute.geometry) return {};

    const preview = { beforeRoute, afterRoute };
    const beforeDistance = beforeRoute.distanceM;
    const afterDistance = afterRoute.distanceM;
    if (Number.isFinite(beforeDistance) && beforeDistance >= 0
        && Number.isFinite(afterDistance) && afterDistance >= 0) {
        preview.distanceDeltaM = afterDistance - beforeDistance;
    }
    const beforeDuration = beforeRoute.durationSec;
    const afterDuration = afterRoute.durationSec;
    if (Number.isFinite(beforeDuration) && beforeDuration >= 0
        && Number.isFinite(afterDuration) && afterDuration >= 0) {
        preview.durationDeltaSec = afterDuration - beforeDuration;
    }
    return preview;
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
    const publicRoute = it.route
        ? serializedRouteFields(it.route)
        : aggregateRouteFromStops(it.stops, it.preferences);
    const pendingProposal = it.pendingProposal?.proposalId
        ? {
            ...engine.publicProposalView(
                it.pendingProposal,
                engine.proposalDiff(it, it.pendingProposal)
            ),
            ...publicBarrierProposalPreview(publicRoute, it.pendingProposal)
        }
        : null;
    return {
        itineraryId: it._id, version: it.version, state: it.state,
        date: it.date, preferences: it.preferences,
        stops,
        route: publicRoute,
        currentStopId: cur?._id || null,
        pendingProposal,
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
    const { Itinerary, WalkEdge } = getModels();
    const existing = await Itinerary.findOne({
        openId: req.openId, state: { $in: ['draft', 'active', 'paused'] }
    }).lean();
    if (existing) {
        return fail(res, 400, 1206, '存在未完成行程', { existingId: existing._id });
    }
    const origin = startCoordinates(startLocation) || CONFIG.scenicCenter;
    const routeBetween = routeBetweenOf(req);
    const estimateBetween = estimateBetweenOf(req);
    const planningSnapshot = await loadRoutingSnapshot(req, WalkEdge, CONFIG.scenicId);
    const routeContext = routeContextFromSnapshot(planningSnapshot);
    const result = await planner.plan({
        startLocation: origin, startAt: normalizedStartAt, hours: Number(hours),
        interests, pace, accessible: Boolean(accessible), shadeFirst: Boolean(shadeFirst),
        openId: req.openId,
        requestId: req.headers?.['x-request-id']
    }, { routeBetween, estimateBetween, routeContext });
    const commitSnapshot = await loadRoutingSnapshot(req, WalkEdge, CONFIG.scenicId);
    if (!routingSnapshotsEqual(planningSnapshot, commitSnapshot)) {
        throw new BizError(8205, '规划期间封路状态或 GIS 数据版本已变化，请重新规划', 409);
    }
    let it;
    try {
        it = await Itinerary.create({
            scenicId: CONFIG.scenicId, openId: req.openId, activeOwner: req.openId,
            date: geo.dateStrOf(normalizedStartAt || new Date()),
            startLocation: origin ? { type: 'Point', coordinates: origin } : null,
            preferences: { pace: pace || 'normal', interests: interests || [], hours: Number(hours), accessible: Boolean(accessible), shadeFirst: Boolean(shadeFirst) },
            stops: result.stops,
            route: result.route,
            planningSnapshot: persistedPlanningSnapshot(commitSnapshot)
        });
    } catch (error) {
        if (error?.code === 11000) {
            return fail(res, 400, 1206, '存在未完成行程');
        }
        throw error;
    }
    const persistedSnapshot = storedPlanningSnapshot(it);
    let postCreateSnapshot;
    try {
        postCreateSnapshot = await loadRoutingSnapshot(req, WalkEdge, CONFIG.scenicId);
    } catch (error) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: it,
            openId: req.openId,
            reason: 'routing snapshot verification failed after plan persistence'
        });
        throw error;
    }
    if (!routingSnapshotMatchesStored(postCreateSnapshot, persistedSnapshot)) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: it,
            openId: req.openId,
            reason: 'routing snapshot changed during plan persistence'
        });
        throw new BizError(8205, '规划写入期间封路状态或 GIS 数据版本已变化，请重新规划', 409);
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

// GET /:id
router.get('/:id', wrap(async (req, res) => {
    const { Itinerary } = getModels();
    let it;
    try {
        it = await Itinerary.findOne({ _id: req.params.id, openId: req.openId });
    } catch (error) {
        if (error?.name === 'CastError') return fail(res, 404, 1204, '行程不存在');
        throw error;
    }
    if (!it) return fail(res, 404, 1204, '行程不存在');
    ok(res, await serialize(it));
}));

// ---- 状态操作（乐观锁）----
router.post('/:id/start', wrap(async (req, res) => {
    const { Itinerary, WalkEdge } = getModels();
    const version = Number(req.body?.version);
    const current = await Itinerary.findOne({
        _id: req.params.id,
        openId: req.openId,
        version,
        state: { $in: ['draft', 'active'] }
    });
    if (!current) return fail(res, 409, 1203, '行程版本已过期，请刷新');
    if (current.state === 'draft') {
        const storedSnapshot = storedPlanningSnapshot(current);
        if (!storedSnapshot) {
            await invalidateStaleItinerary({
                Itinerary,
                itinerary: current,
                openId: req.openId,
                reason: 'draft is missing a verifiable routing snapshot',
                allowMissingSnapshot: true
            });
            return fail(res, 409, 8205, '行程缺少可验证的规划快照，请重新规划');
        }
        let beforeStart;
        try {
            beforeStart = await loadRoutingSnapshot(
                req,
                WalkEdge,
                String(current.scenicId || CONFIG.scenicId)
            );
        } catch (error) {
            await invalidateStaleItinerary({
                Itinerary,
                itinerary: current,
                openId: req.openId,
                reason: 'routing snapshot verification failed before start'
            });
            if (error instanceof BizError && error.code === 8205) {
                return fail(res, 409, 8205, error.message);
            }
            throw error;
        }
        if (!routingSnapshotMatchesStored(beforeStart, storedSnapshot)) {
            await invalidateStaleItinerary({
                Itinerary,
                itinerary: current,
                openId: req.openId,
                reason: 'routing snapshot changed before start'
            });
            return fail(res, 409, 8205, '封路状态或 GIS 数据版本已变化，请重新规划');
        }
        const result = await itineraryRuntime().start({
            itineraryId: req.params.id,
            openId: req.openId,
            version,
            casFilter: planningSnapshotCasFilter(storedSnapshot)
        });
        if (result.status === 'conflict' || result.status === 'not_found') {
            return fail(res, 409, 1203, '行程版本已过期，请刷新');
        }
        if (result.status === 'updated') {
            let afterStart;
            try {
                afterStart = await loadRoutingSnapshot(
                    req,
                    WalkEdge,
                    String(current.scenicId || CONFIG.scenicId)
                );
            } catch (error) {
                await invalidateStaleItinerary({
                    Itinerary,
                    itinerary: result.itinerary,
                    openId: req.openId,
                    reason: 'routing snapshot verification failed during start'
                });
                if (error instanceof BizError && error.code === 8205) {
                    return fail(res, 409, 8205, error.message);
                }
                throw error;
            }
            if (!routingSnapshotMatchesStored(afterStart, storedSnapshot)) {
                await invalidateStaleItinerary({
                    Itinerary,
                    itinerary: result.itinerary,
                    openId: req.openId,
                    reason: 'routing snapshot changed during start'
                });
                return fail(res, 409, 8205, '启动期间封路状态或 GIS 数据版本已变化，请重新规划');
            }
        }
        if (result.releaseError) {
            console.error('[GeoSync] [ITINERARY] start token release failed:',
                safeErrorCode(result.releaseError, 'TOKEN_RELEASE_FAILED'));
        }
        if (result.status === 'updated') {
            await bestEffort('arrival index rebuild failed', () => forecast.rebuildArrivalIndex());
            emitProgress(result.itinerary);
        }
        return ok(res, await serialize(result.itinerary));
    }
    const result = await itineraryRuntime().start({
        itineraryId: req.params.id,
        openId: req.openId,
        version
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
    finish: { from: ['active', 'paused'], to: 'completed' },
    abandon: { from: ['draft', 'active', 'paused'], to: 'abandoned' }
};

router.post('/:id/resume', wrap(async (req, res) => {
    const { Itinerary, WalkEdge } = getModels();
    const version = Number(req.body?.version);
    const current = await Itinerary.findOne({
        _id: req.params.id,
        openId: req.openId,
        version,
        state: 'paused'
    });
    if (!current) return fail(res, 409, 1203, '行程版本已过期，请刷新');
    if (current.pendingProposal?.type === 'barrierReroute') {
        return fail(res, 409, 1205, '存在待处理的封路改道建议，请先处理后再恢复行程');
    }

    const storedSnapshot = storedPlanningSnapshot(current);
    if (!storedSnapshot) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: current,
            openId: req.openId,
            reason: 'paused itinerary is missing a verifiable routing snapshot',
            allowMissingSnapshot: true
        });
        return fail(res, 409, 8205, '行程缺少可验证的规划快照，请重新规划');
    }

    let beforeResume;
    try {
        beforeResume = await loadRoutingSnapshot(
            req,
            WalkEdge,
            String(current.scenicId || CONFIG.scenicId)
        );
    } catch (error) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: current,
            openId: req.openId,
            reason: 'routing snapshot verification failed before resume'
        });
        if (error instanceof BizError && error.code === 8205) {
            return fail(res, 409, 8205, error.message);
        }
        throw error;
    }
    if (!routingSnapshotMatchesStored(beforeResume, storedSnapshot)) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: current,
            openId: req.openId,
            reason: 'routing snapshot changed before resume'
        });
        return fail(res, 409, 8205, '暂停期间封路状态或 GIS 数据版本已变化，请重新规划');
    }

    const resumed = await Itinerary.findOneAndUpdate(
        {
            _id: current._id,
            openId: req.openId,
            version,
            state: 'paused',
            ...planningSnapshotCasFilter(storedSnapshot)
        },
        {
            $set: { state: 'active', activeOwner: current.openId },
            $inc: { version: 1 }
        },
        { new: true }
    );
    if (!resumed) return fail(res, 409, 1203, '行程版本已过期，请刷新');

    let afterResume;
    try {
        afterResume = await loadRoutingSnapshot(
            req,
            WalkEdge,
            String(current.scenicId || CONFIG.scenicId)
        );
    } catch (error) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: resumed,
            openId: req.openId,
            reason: 'routing snapshot verification failed during resume'
        });
        if (error instanceof BizError && error.code === 8205) {
            return fail(res, 409, 8205, error.message);
        }
        throw error;
    }
    if (!routingSnapshotMatchesStored(afterResume, storedSnapshot)) {
        await invalidateStaleItinerary({
            Itinerary,
            itinerary: resumed,
            openId: req.openId,
            reason: 'routing snapshot changed during resume'
        });
        return fail(res, 409, 8205, '恢复期间封路状态或 GIS 数据版本已变化，请重新规划');
    }

    await bestEffort('arrival index rebuild failed', () => forecast.rebuildArrivalIndex());
    emitProgress(resumed);
    ok(res, await serialize(resumed));
}));

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
    const proposalState = ['active', 'paused'].includes(it.state) ? it.state : null;
    if (!proposalState) return fail(res, 409, 1203, '当前行程状态无法处理路线建议');

    if (accepted) {
        const routeBetween = routeBetweenOf(req);
        let routingSnapshot;
        try {
            routingSnapshot = await loadRoutingSnapshot(
                req,
                WalkEdge,
                String(it.scenicId || CONFIG.scenicId)
            );
        } catch (error) {
            if (error instanceof BizError && error.code === 8205) {
                return fail(res, 409, 8205, error.message);
            }
            throw error;
        }
        const eventId = proposalEventId(pp) || `proposal-${pp.proposalId}`;
        const routeContext = routeContextFromSnapshot(routingSnapshot, {
            requestId: eventId,
            eventId
        });
        const lifecycleProposal = pp.type === 'barrierReroute'
            ? proposalWithBarrierSnapshot(pp, routingSnapshot)
            : pp;
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
            if (error instanceof TimelineRebuildError && error.code === 'DATA_VERSION_MISMATCH') {
                return fail(res, 409, 8205, '重建路线的 GIS 数据版本与当前快照不一致');
            }
            if (error instanceof TimelineRebuildError) {
                return fail(res, 400, 1205, '剩余路线暂时无法重建');
            }
            throw error;
        }
        let newRoute;
        try {
            newRoute = aggregateRouteFromStops(newStops, it.preferences, it.route, {
                expectedDataVersion: routingSnapshot.dataVersion
            });
        } catch (error) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            if (error instanceof RouteDataVersionError) {
                return fail(res, 409, 8205, '重建路线包含缺失或混合的 GIS 数据版本');
            }
            throw error;
        }
        if (!routeAvoidsBarriers(
            { stops: newStops, route: newRoute },
            routingSnapshot.barriers
        )) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 409, 8205, '重建路线仍包含当前关闭路段');
        }

        let commitSnapshot;
        try {
            commitSnapshot = await loadRoutingSnapshot(
                req,
                WalkEdge,
                String(it.scenicId || CONFIG.scenicId)
            );
        } catch (error) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            if (error instanceof BizError && error.code === 8205) {
                return fail(res, 409, 8205, error.message);
            }
            throw error;
        }
        if (!routingSnapshotsEqual(routingSnapshot, commitSnapshot)) {
            await antiHerding.rollbackClaimedTokens(pp.tokenIds, it._id, claimId);
            return fail(res, 409, 8205, '重建期间封路状态或 GIS 数据版本已变化，请重试');
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
                    state: proposalState,
                    'pendingProposal.proposalId': pp.proposalId,
                    'pendingProposal.expireAt': { $gt: commitNow }
                },
                {
                    $set: {
                        stops: newStops,
                        route: newRoute,
                        pendingProposal: null,
                        planningSnapshot: persistedPlanningSnapshot(commitSnapshot)
                    },
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

        let postCommitSnapshot;
        try {
            postCommitSnapshot = await loadRoutingSnapshot(
                req,
                WalkEdge,
                String(it.scenicId || CONFIG.scenicId)
            );
        } catch (error) {
            await invalidateStaleItinerary({
                Itinerary,
                itinerary: updated,
                openId: req.openId,
                reason: 'routing snapshot verification failed after proposal commit',
                extraTokenIds: tokenIdsOf(it)
            });
            if (error instanceof BizError && error.code === 8205) {
                return fail(res, 409, 8205, error.message);
            }
            throw error;
        }
        if (!routingSnapshotMatchesStored(postCommitSnapshot, storedPlanningSnapshot(updated))) {
            await invalidateStaleItinerary({
                Itinerary,
                itinerary: updated,
                openId: req.openId,
                reason: 'routing snapshot changed during proposal persistence',
                extraTokenIds: tokenIdsOf(it)
            });
            return fail(res, 409, 8205, '改道写入期间封路状态或 GIS 数据版本已变化，请重试');
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
            state: proposalState,
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
