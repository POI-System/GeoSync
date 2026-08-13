'use strict';

const crypto = require('crypto');

const SAFE_EDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MUTABLE_STATES = new Set(['pending', 'approaching']);
const DEFAULT_PROPOSAL_TTL_MS = 10 * 60000;
const DEFAULT_ITINERARY_CONCURRENCY = 6;
const DEFAULT_EVENT_LEASE_MS = 60 * 1000;
const DEFAULT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function barrierError(code, message, details = null) {
    const error = new Error(message);
    error.name = 'BarrierRerouteError';
    error.code = code;
    error.details = details;
    return error;
}

function toPlain(value) {
    return value?.toObject ? value.toObject() : value;
}

function normalizeClosedBarrier(value) {
    const edge = toPlain(value);
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
        throw barrierError('INVALID_BARRIER_MAPPING', 'closed barrier must be an object');
    }

    const edgeId = typeof edge.edgeId === 'string' ? edge.edgeId.trim() : '';
    if (!SAFE_EDGE_ID.test(edgeId)) {
        throw barrierError('INVALID_BARRIER_MAPPING', 'closed barrier edgeId is invalid', {
            edgeId: edge.edgeId ?? null
        });
    }

    const rawPhysicalEdgeId = edge.physicalEdgeId ?? edgeId;
    const physicalEdgeId = typeof rawPhysicalEdgeId === 'string'
        ? rawPhysicalEdgeId.trim()
        : '';
    if (!SAFE_EDGE_ID.test(physicalEdgeId)) {
        throw barrierError('INVALID_BARRIER_MAPPING', 'closed barrier physicalEdgeId is invalid', {
            edgeId,
            physicalEdgeId: edge.physicalEdgeId ?? null
        });
    }

    const sourceRef = toPlain(edge.sourceRef);
    const datasetName = typeof sourceRef?.datasetName === 'string'
        ? sourceRef.datasetName.trim()
        : '';
    const smId = sourceRef?.smId;
    if (!datasetName || !Number.isInteger(smId) || smId < 0) {
        throw barrierError(
            'INVALID_BARRIER_MAPPING',
            `closed barrier ${edgeId} requires sourceRef.datasetName and a non-negative integer smId`,
            { edgeId }
        );
    }

    return {
        edgeId,
        physicalEdgeId,
        sourceRef: { datasetName, smId }
    };
}

function compareEdgeIds(left, right) {
    if (left.edgeId < right.edgeId) return -1;
    if (left.edgeId > right.edgeId) return 1;
    return 0;
}

function normalizeBarrierSet(values) {
    if (!Array.isArray(values)) {
        throw barrierError('INVALID_BARRIER_MAPPING', 'barriers must be an array');
    }

    const byEdgeId = new Map();
    for (const value of values) {
        const barrier = normalizeClosedBarrier(value);
        const previous = byEdgeId.get(barrier.edgeId);
        if (
            previous
            && (
                previous.sourceRef.datasetName !== barrier.sourceRef.datasetName
                || previous.sourceRef.smId !== barrier.sourceRef.smId
                || previous.physicalEdgeId !== barrier.physicalEdgeId
            )
        ) {
            throw barrierError(
                'CONFLICTING_BARRIER_MAPPING',
                `closed barrier ${barrier.edgeId} has conflicting sourceRef mappings`,
                { edgeId: barrier.edgeId }
            );
        }
        byEdgeId.set(barrier.edgeId, barrier);
    }
    return [...byEdgeId.values()].sort(compareEdgeIds);
}

function fingerprintNormalizedBarriers(barriers) {
    const canonical = barriers.map(barrier => [
        barrier.edgeId,
        barrier.physicalEdgeId,
        barrier.sourceRef.datasetName,
        barrier.sourceRef.smId
    ]);
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function barrierFingerprint(barriers) {
    return fingerprintNormalizedBarriers(normalizeBarrierSet(barriers));
}

async function resolveLeanQuery(query) {
    if (query && typeof query.lean === 'function') return query.lean();
    return query;
}

async function settleWithConcurrency(items, concurrency, operation) {
    const settled = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                settled[index] = {
                    status: 'fulfilled',
                    value: await operation(items[index], index)
                };
            } catch (reason) {
                settled[index] = { status: 'rejected', reason };
            }
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return settled;
}

async function loadClosedBarrierSnapshot({ WalkEdge, scenicId }) {
    if (!WalkEdge || typeof WalkEdge.find !== 'function') {
        throw new TypeError('loadClosedBarrierSnapshot requires WalkEdge.find');
    }
    const normalizedScenicId = typeof scenicId === 'string' ? scenicId.trim() : '';
    if (!normalizedScenicId) {
        throw new TypeError('loadClosedBarrierSnapshot requires scenicId');
    }

    const rows = await resolveLeanQuery(WalkEdge.find({
        scenicId: normalizedScenicId,
        status: 'closed'
    }));
    if (!Array.isArray(rows)) {
        throw barrierError('INVALID_BARRIER_SNAPSHOT', 'WalkEdge.find must resolve to an array');
    }

    const barriers = normalizeBarrierSet(rows);
    return {
        barriers,
        edgeIds: barriers.map(barrier => barrier.edgeId),
        physicalEdgeIds: [...new Set(barriers.map(barrier => barrier.physicalEdgeId))].sort(),
        fingerprint: fingerprintNormalizedBarriers(barriers)
    };
}

function sourceRefKey(value) {
    const sourceRef = toPlain(value);
    const datasetName = typeof sourceRef?.datasetName === 'string'
        ? sourceRef.datasetName.trim()
        : '';
    const smId = sourceRef?.smId;
    return datasetName && Number.isInteger(smId) && smId >= 0
        ? `${datasetName}\u0000${smId}`
        : null;
}

function collectRouteSegments(value, output, seen) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const item of value) collectRouteSegments(item, output, seen);
        return;
    }
    const plain = toPlain(value);
    if (!plain || typeof plain !== 'object') return;
    if (seen.has(plain)) return;
    seen.add(plain);

    if (plain.edgeId !== undefined
        || plain.physicalEdgeId !== undefined
        || plain.sourceRef !== undefined) {
        output.push(plain);
    }
    if (Array.isArray(plain.edgeIds)) {
        for (const edgeId of plain.edgeIds) output.push({ edgeId });
    }
    collectRouteSegments(plain.segments, output, seen);
    collectRouteSegments(plain.stops, output, seen);
    collectRouteSegments(plain.route, output, seen);
}

function routeSegmentGroups(candidate) {
    const plain = toPlain(candidate);
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return [];

    const groups = [];
    if (Array.isArray(plain.stops)) {
        for (const stop of plain.stops) {
            const normalizedStop = toPlain(stop);
            if (!MUTABLE_STATES.has(normalizedStop?.state)) continue;
            groups.push(Array.isArray(normalizedStop.segments) ? normalizedStop.segments : []);
        }
    }
    if (Array.isArray(plain.segments)) groups.push(plain.segments);
    const route = toPlain(plain.route);
    if (Array.isArray(route?.segments)) groups.push(route.segments);
    return groups;
}

function routeAvoidsBarriers(candidate, barriers) {
    const normalizedBarriers = normalizeBarrierSet(barriers);
    if (!normalizedBarriers.length) return true;

    const blockedEdgeIds = new Set(normalizedBarriers.map(barrier => barrier.edgeId));
    const blockedPhysicalEdgeIds = new Set(
        normalizedBarriers.map(barrier => barrier.physicalEdgeId)
    );
    const blockedSourceRefs = new Set(
        normalizedBarriers.map(barrier => sourceRefKey(barrier.sourceRef))
    );
    const groups = routeSegmentGroups(candidate);
    if (!groups.length || groups.some(group => group.length === 0)) return false;

    for (const group of groups) {
        for (const value of group) {
            const segment = toPlain(value);
            const edgeId = typeof segment?.edgeId === 'string' ? segment.edgeId.trim() : '';
            const physicalEdgeId = typeof segment?.physicalEdgeId === 'string'
                ? segment.physicalEdgeId.trim()
                : '';
            const sourceKey = sourceRefKey(segment?.sourceRef);
            if (!SAFE_EDGE_ID.test(edgeId)
                && !SAFE_EDGE_ID.test(physicalEdgeId)
                && sourceKey === null) {
                return false;
            }
            if (edgeId && blockedEdgeIds.has(edgeId)) return false;
            if (physicalEdgeId && blockedPhysicalEdgeIds.has(physicalEdgeId)) return false;
            if (sourceKey !== null && blockedSourceRefs.has(sourceKey)) return false;
        }
    }
    return true;
}

function explicitSegmentEdgeIds(value) {
    if (!Array.isArray(value) || value.length === 0) return null;
    const edgeIds = value.map(segment => {
        const plain = toPlain(segment);
        return typeof plain?.edgeId === 'string' ? plain.edgeId.trim() : '';
    });
    return edgeIds.every(Boolean) ? edgeIds : null;
}

function targetEdgeIds(value) {
    const target = typeof value === 'string' ? { edgeId: value } : toPlain(value);
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new TypeError('remainingRouteUsesEdge requires a valid edge target');
    }
    const ids = new Set();
    for (const raw of [target.edgeId, target.physicalEdgeId, ...(target.edgeIds || [])]) {
        if (raw === undefined || raw === null || raw === '') continue;
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (!SAFE_EDGE_ID.test(id)) {
            throw new TypeError('remainingRouteUsesEdge requires valid edge identifiers');
        }
        ids.add(id);
    }
    if (!ids.size) {
        throw new TypeError('remainingRouteUsesEdge requires a valid edge target');
    }
    return ids;
}

function segmentUsesTarget(segment, targetIds) {
    const plain = toPlain(segment);
    const edgeId = typeof plain?.edgeId === 'string' ? plain.edgeId.trim() : '';
    const physicalEdgeId = typeof plain?.physicalEdgeId === 'string'
        ? plain.physicalEdgeId.trim()
        : '';
    return targetIds.has(edgeId) || targetIds.has(physicalEdgeId);
}

function explicitSegmentIdentities(value) {
    if (!Array.isArray(value) || value.length === 0) return null;
    const segments = value.map(segment => toPlain(segment));
    return segments.every(segment => {
        const edgeId = typeof segment?.edgeId === 'string' ? segment.edgeId.trim() : '';
        const physicalEdgeId = typeof segment?.physicalEdgeId === 'string'
            ? segment.physicalEdgeId.trim()
            : '';
        return SAFE_EDGE_ID.test(edgeId) || SAFE_EDGE_ID.test(physicalEdgeId);
    }) ? segments : null;
}

function remainingRouteUsesEdge(itinerary, target) {
    const targetIds = targetEdgeIds(target);

    const source = toPlain(itinerary) || {};
    const mutableStops = mutableStopsOf(source.stops);
    if (!mutableStops.length) return false;

    let everyMutableLegHasProvenance = true;
    for (const stop of mutableStops) {
        const segments = explicitSegmentIdentities(toPlain(stop)?.segments);
        if (!segments) {
            everyMutableLegHasProvenance = false;
            continue;
        }
        if (segments.some(segment => segmentUsesTarget(segment, targetIds))) return true;
    }
    if (everyMutableLegHasProvenance) return false;

    const aggregateSegments = explicitSegmentIdentities(toPlain(source.route)?.segments);
    if (aggregateSegments) {
        return aggregateSegments.some(segment => segmentUsesTarget(segment, targetIds));
    }
    return null;
}

function routeSegmentIdentity(segment) {
    const plain = toPlain(segment);
    const edgeId = typeof plain?.edgeId === 'string' ? plain.edgeId.trim() : '';
    if (edgeId) return `edge:${edgeId}`;
    const sourceKey = sourceRefKey(plain?.sourceRef);
    return sourceKey ? `source:${sourceKey}` : null;
}

function routeCoordinates(value) {
    const coordinates = toPlain(value)?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const normalized = [];
    for (const position of coordinates) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
            return null;
        }
        normalized.push(position.map(number => Number(number.toFixed(6))));
    }
    return normalized;
}

function routeMaterialSignature(value) {
    const segments = [];
    collectRouteSegments(value, segments, new Set());
    if (segments.length) {
        const identities = segments.map(routeSegmentIdentity);
        if (identities.every(Boolean)) return `segments:${JSON.stringify(identities)}`;
    }

    const plain = toPlain(value);
    const coordinates = routeCoordinates(plain) || routeCoordinates(plain?.route);
    if (coordinates) return `geometry:${JSON.stringify(coordinates)}`;

    const pathGeometry = typeof plain?.pathGeometry === 'string'
        ? plain.pathGeometry
        : typeof plain?.route?.pathGeometry === 'string'
            ? plain.route.pathGeometry
            : '';
    return pathGeometry ? `path:${pathGeometry}` : null;
}

function routesMateriallyEqual(left, right) {
    const leftSignature = routeMaterialSignature(left);
    const rightSignature = routeMaterialSignature(right);
    return leftSignature !== null && leftSignature === rightSignature;
}

function validDate(value, name) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must return a valid date`);
    return date;
}

function normalizeOperation(event) {
    const raw = event.operation ?? event.op ?? event.action ?? event.status ?? event.type;
    const compact = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (compact === 'close' || compact === 'closed' || compact.endsWith('edgeclosed')) return 'close';
    if (compact === 'open' || compact === 'opened' || compact.endsWith('edgeopened')) return 'open';
    throw barrierError('INVALID_GRAPH_EVENT', 'graph event operation must be close or open');
}

function normalizeGraphEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw barrierError('INVALID_GRAPH_EVENT', 'graph event must be an object');
    }
    const eventId = typeof value.eventId === 'string' ? value.eventId.trim() : '';
    const scenicId = typeof value.scenicId === 'string' ? value.scenicId.trim() : '';
    const edgeId = typeof value.edgeId === 'string' ? value.edgeId.trim() : '';
    if (!eventId) throw barrierError('INVALID_GRAPH_EVENT', 'graph event eventId is required');
    if (!scenicId) throw barrierError('INVALID_GRAPH_EVENT', 'graph event scenicId is required');
    if (!SAFE_EDGE_ID.test(edgeId)) {
        throw barrierError('INVALID_GRAPH_EVENT', 'graph event edgeId is invalid');
    }
    return {
        ...value,
        eventId,
        scenicId,
        edgeId,
        operation: normalizeOperation(value),
        cacheInvalidated: value.cacheInvalidated === true
    };
}

function graphEventPayloadHash(event) {
    const canonical = [
        event.eventId,
        event.scenicId,
        event.edgeId,
        event.operation,
        event.cacheInvalidated === true
    ];
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function duplicateKeyError(error) {
    return Number(error?.code) === 11000 || error?.codeName === 'DuplicateKey';
}

function persistedErrorCode(error) {
    const value = String(error?.code || error?.name || 'UNEXPECTED_ERROR');
    return /^[A-Z0-9_:-]{1,64}$/.test(value) ? value : 'UNEXPECTED_ERROR';
}

function errorRecord(scope, error, itineraryId = null) {
    return {
        scope,
        ...(itineraryId ? { itineraryId } : {}),
        code: error?.code || 'UNEXPECTED_ERROR',
        message: error?.message || String(error)
    };
}

function hasPendingProposal(itinerary) {
    const proposal = toPlain(itinerary?.pendingProposal);
    if (proposal === null || proposal === undefined) return false;
    if (typeof proposal !== 'object') return true;
    return Object.keys(proposal).length > 0;
}

function mutableStopsOf(stops) {
    return Array.isArray(stops)
        ? stops.filter(stop => MUTABLE_STATES.has(toPlain(stop)?.state))
        : [];
}

function normalizedDataVersion(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function capacityTokenIdsOf(itinerary) {
    const proposal = toPlain(itinerary?.pendingProposal);
    const values = [
        ...(Array.isArray(proposal?.tokenIds) ? proposal.tokenIds : []),
        ...(Array.isArray(itinerary?.stops)
            ? itinerary.stops.map(stop => toPlain(stop)?.capacityTokenId)
            : [])
    ];
    const byId = new Map();
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const key = String(value).trim();
        if (key && !byId.has(key)) byId.set(key, value);
    }
    return [...byId.values()];
}

function stopsWithoutCapacityTokens(stops) {
    return Array.isArray(stops)
        ? stops.map(stop => ({ ...toPlain(stop), capacityTokenId: null }))
        : [];
}

function invalidatedPlanningSnapshot(value, invalidatedAt, reason) {
    const snapshot = toPlain(value);
    const barrierFingerprint = typeof snapshot?.barrierFingerprint === 'string'
        ? snapshot.barrierFingerprint.trim()
        : '';
    const dataVersion = normalizedDataVersion(snapshot?.dataVersion);
    const capturedAt = new Date(snapshot?.capturedAt);
    if (!barrierFingerprint || !dataVersion || !Number.isFinite(capturedAt.getTime())) return null;
    return {
        ...snapshot,
        barrierFingerprint,
        barrierEdgeIds: Array.isArray(snapshot.barrierEdgeIds)
            ? [...snapshot.barrierEdgeIds]
            : [],
        dataVersion,
        capturedAt,
        invalidatedAt,
        invalidationReason: reason
    };
}

function itineraryIdOf(itinerary) {
    return itinerary?._id === undefined || itinerary?._id === null
        ? ''
        : String(itinerary._id);
}

function resolveImpactEmitter(deps) {
    if (typeof deps.emitOpsImpact === 'function') return deps.emitOpsImpact;

    const eventName = deps.OPS_IMPACT
        || deps.events?.OPS_IMPACT
        || deps.eventBus?.EVENTS?.OPS_IMPACT
        || deps.opsImpactEvent
        || 'ops:impact';
    if (typeof deps.emit === 'function') {
        return payload => deps.emit(eventName, payload);
    }
    if (deps.eventBus && typeof deps.eventBus.emit === 'function') {
        return payload => deps.eventBus.emit(eventName, payload);
    }
    throw new TypeError('createBarrierRerouteCoordinator requires an OPS_IMPACT emitter');
}

function resolveProposalPublisher(deps) {
    if (typeof deps.emitRerouteProposed === 'function') return deps.emitRerouteProposed;
    if (typeof deps.eventBus?.REROUTE_PROPOSED === 'function') {
        return deps.eventBus.REROUTE_PROPOSED.bind(deps.eventBus);
    }

    const eventName = deps.REROUTE_PROPOSED
        || deps.events?.REROUTE_PROPOSED
        || deps.eventBus?.EVENTS?.REROUTE_PROPOSED
        || (typeof deps.eventBus?.REROUTE_PROPOSED === 'string'
            ? deps.eventBus.REROUTE_PROPOSED
            : null);
    if (eventName && deps.eventBus && typeof deps.eventBus.emit === 'function') {
        return payload => deps.eventBus.emit(eventName, payload);
    }
    if (eventName && deps.eventBus && typeof deps.eventBus.publish === 'function') {
        return payload => deps.eventBus.publish(eventName, payload);
    }
    throw new TypeError('createBarrierRerouteCoordinator requires a REROUTE_PROPOSED publisher');
}

function resolveDecisionPublisher(deps) {
    if (typeof deps.emitRerouteDecided === 'function') return deps.emitRerouteDecided;

    const eventName = deps.REROUTE_DECIDED
        || deps.events?.REROUTE_DECIDED
        || deps.eventBus?.EVENTS?.REROUTE_DECIDED;
    if (eventName && deps.eventBus && typeof deps.eventBus.emit === 'function') {
        return payload => deps.eventBus.emit(eventName, payload);
    }
    if (eventName && deps.eventBus && typeof deps.eventBus.publish === 'function') {
        return payload => deps.eventBus.publish(eventName, payload);
    }
    throw new TypeError('createBarrierRerouteCoordinator requires a REROUTE_DECIDED publisher');
}

function proposalMetadata(value) {
    const proposal = toPlain(value) || {};
    const payload = toPlain(proposal.payload) || {};
    return {
        proposal,
        proposalId: typeof proposal.proposalId === 'string' ? proposal.proposalId.trim() : '',
        eventId: typeof payload.eventId === 'string' && payload.eventId.trim()
            ? payload.eventId.trim()
            : null,
        edgeId: typeof payload.edgeId === 'string' && payload.edgeId.trim()
            ? payload.edgeId.trim()
            : null,
        barrierFingerprint: typeof payload.barrierFingerprint === 'string'
            && payload.barrierFingerprint.trim()
            ? payload.barrierFingerprint.trim()
            : null
    };
}

function priorBarrierEvent(itinerary, eventId) {
    if (itinerary?.pendingProposal) {
        const pending = proposalMetadata(itinerary.pendingProposal);
        if (pending.eventId === eventId) return pending;
    }
    const logs = Array.isArray(itinerary?.rerouteLog) ? itinerary.rerouteLog : [];
    for (let index = logs.length - 1; index >= 0; index--) {
        const entry = toPlain(logs[index]);
        if (String(entry?.eventId || '').trim() !== eventId) continue;
        return {
            proposalId: String(entry?.proposalId || '').trim() || null,
            eventId,
            edgeId: String(entry?.edgeId || '').trim() || null,
            barrierFingerprint: String(entry?.barrierFingerprint || '').trim() || null
        };
    }
    return null;
}

function createBarrierRerouteCoordinator(deps = {}) {
    const { models, gateway, walkGraph, rebuildTimeline, routeBetween } = deps;
    if (!models?.WalkEdge || !models?.Itinerary || !models?.BarrierEventRecord) {
        throw new TypeError(
            'createBarrierRerouteCoordinator requires WalkEdge, Itinerary, and BarrierEventRecord models'
        );
    }
    if (!gateway || typeof gateway.invalidateRouteCache !== 'function') {
        throw new TypeError('createBarrierRerouteCoordinator requires gateway.invalidateRouteCache');
    }
    const reloadWalkGraph = typeof deps.reloadWalkGraph === 'function'
        ? deps.reloadWalkGraph
        : typeof walkGraph?.loadIntoMemory === 'function'
            ? () => walkGraph.loadIntoMemory()
            : typeof walkGraph?.reload === 'function'
                ? () => walkGraph.reload()
                : null;
    if (!reloadWalkGraph) {
        throw new TypeError('createBarrierRerouteCoordinator requires a walkGraph reload function');
    }
    if (typeof rebuildTimeline !== 'function') {
        throw new TypeError('createBarrierRerouteCoordinator requires rebuildTimeline');
    }
    if (typeof routeBetween !== 'function') {
        throw new TypeError('createBarrierRerouteCoordinator requires routeBetween');
    }
    if (typeof models.Itinerary.find !== 'function' || typeof models.Itinerary.findOneAndUpdate !== 'function') {
        throw new TypeError('Itinerary model must provide find and findOneAndUpdate');
    }
    if (
        typeof models.BarrierEventRecord.findOne !== 'function'
        || typeof models.BarrierEventRecord.findOneAndUpdate !== 'function'
    ) {
        throw new TypeError('BarrierEventRecord model must provide findOne and findOneAndUpdate');
    }

    const emitOpsImpact = resolveImpactEmitter(deps);
    const emitRerouteProposed = resolveProposalPublisher(deps);
    const emitRerouteDecided = resolveDecisionPublisher(deps);
    if (typeof deps.releaseProposalTokens !== 'function') {
        throw new TypeError('createBarrierRerouteCoordinator requires releaseProposalTokens');
    }
    const releaseProposalTokens = deps.releaseProposalTokens;
    const clock = typeof deps.clock === 'function'
        ? deps.clock
        : typeof deps.clock?.now === 'function'
            ? () => deps.clock.now()
            : () => new Date();
    const idFactory = typeof deps.idFactory === 'function'
        ? deps.idFactory
        : () => `br_${crypto.randomBytes(8).toString('hex')}`;
    const aggregateRouteFromStops = typeof deps.aggregateRouteFromStops === 'function'
        ? deps.aggregateRouteFromStops
        : null;
    const dataVersionSource = deps.dataVersion;
    const proposalTtlMs = deps.proposalTtlMs === undefined
        ? DEFAULT_PROPOSAL_TTL_MS
        : Number(deps.proposalTtlMs);
    if (!Number.isFinite(proposalTtlMs) || proposalTtlMs <= 0) {
        throw new TypeError('proposalTtlMs must be a positive number');
    }
    const itineraryConcurrency = deps.itineraryConcurrency === undefined
        ? DEFAULT_ITINERARY_CONCURRENCY
        : Number(deps.itineraryConcurrency);
    if (!Number.isInteger(itineraryConcurrency) || itineraryConcurrency <= 0) {
        throw new TypeError('itineraryConcurrency must be a positive integer');
    }
    const eventLeaseMs = deps.eventLeaseMs === undefined
        ? DEFAULT_EVENT_LEASE_MS
        : Number(deps.eventLeaseMs);
    if (!Number.isInteger(eventLeaseMs) || eventLeaseMs < 3000) {
        throw new TypeError('eventLeaseMs must be an integer of at least 3000');
    }
    const eventRetentionMs = deps.eventRetentionMs === undefined
        ? DEFAULT_EVENT_RETENTION_MS
        : Number(deps.eventRetentionMs);
    if (!Number.isInteger(eventRetentionMs) || eventRetentionMs < eventLeaseMs) {
        throw new TypeError('eventRetentionMs must be an integer greater than or equal to eventLeaseMs');
    }
    const eventHeartbeatMs = deps.eventHeartbeatMs === undefined
        ? Math.max(1000, Math.floor(eventLeaseMs / 3))
        : Number(deps.eventHeartbeatMs);
    if (
        !Number.isInteger(eventHeartbeatMs)
        || eventHeartbeatMs <= 0
        || eventHeartbeatMs >= eventLeaseMs
    ) {
        throw new TypeError('eventHeartbeatMs must be a positive integer smaller than eventLeaseMs');
    }
    const eventOwnerId = String(deps.eventOwnerId
        || `barrier:${process.pid}:${crypto.randomBytes(8).toString('hex')}`).trim();
    if (!eventOwnerId) throw new TypeError('eventOwnerId must not be empty');

    const eventRecords = new Map();
    const scenicQueues = new Map();

    async function readDataVersion() {
        const value = typeof dataVersionSource === 'function'
            ? await dataVersionSource()
            : dataVersionSource;
        const dataVersion = normalizedDataVersion(value);
        if (!dataVersion) {
            throw barrierError(
                'BARRIER_DATA_VERSION_UNAVAILABLE',
                'GIS dataVersion is unavailable for barrier rerouting'
            );
        }
        return dataVersion;
    }

    async function assertCurrentRoutingSnapshot(snapshot, scenicId, itineraryId) {
        let actualDataVersion = null;
        try {
            actualDataVersion = await readDataVersion();
        } catch {
            throw barrierError(
                'BARRIER_ROUTING_SNAPSHOT_CHANGED',
                'GIS dataVersion could not be verified before barrier proposal persistence',
                {
                    expectedDataVersion: snapshot.dataVersion,
                    actualDataVersion: null,
                    itineraryId
                }
            );
        }
        if (actualDataVersion !== snapshot.dataVersion) {
            throw barrierError(
                'BARRIER_ROUTING_SNAPSHOT_CHANGED',
                'GIS dataVersion changed before barrier proposal persistence',
                {
                    expectedDataVersion: snapshot.dataVersion,
                    actualDataVersion,
                    itineraryId
                }
            );
        }

        let actualBarrierSnapshot;
        try {
            actualBarrierSnapshot = await loadClosedBarrierSnapshot({
                WalkEdge: models.WalkEdge,
                scenicId
            });
        } catch (cause) {
            const error = barrierError(
                'BARRIER_ROUTING_SNAPSHOT_CHANGED',
                'closed barrier set could not be verified before barrier proposal persistence',
                {
                    expectedBarrierFingerprint: snapshot.fingerprint,
                    actualBarrierFingerprint: null,
                    itineraryId
                }
            );
            error.cause = cause;
            throw error;
        }
        const actualSnapshot = {
            ...actualBarrierSnapshot,
            dataVersion: actualDataVersion
        };
        if (actualSnapshot.fingerprint !== snapshot.fingerprint) {
            const error = barrierError(
                'BARRIER_ROUTING_SNAPSHOT_CHANGED',
                'closed barrier set changed before barrier proposal persistence',
                {
                    expectedBarrierFingerprint: snapshot.fingerprint,
                    actualBarrierFingerprint: actualSnapshot.fingerprint,
                    expectedDataVersion: snapshot.dataVersion,
                    actualDataVersion,
                    itineraryId
                }
            );
            error.currentRoutingSnapshot = actualSnapshot;
            throw error;
        }
        return actualSnapshot;
    }

    async function loadEventRecord(eventId) {
        return toPlain(await resolveLeanQuery(models.BarrierEventRecord.findOne({ eventId })));
    }

    async function claimEventLease(event) {
        const payloadHash = graphEventPayloadHash(event);
        for (let attempt = 0; attempt < 3; attempt++) {
            const now = validDate(clock(), 'clock');
            const leaseUntil = new Date(now.getTime() + eventLeaseMs);
            const expireAt = new Date(now.getTime() + eventRetentionMs);
            try {
                const claimed = toPlain(await models.BarrierEventRecord.findOneAndUpdate(
                    {
                        eventId: event.eventId,
                        payloadHash,
                        $or: [
                            { state: 'failed' },
                            { state: 'processing', leaseUntil: { $lte: now } }
                        ]
                    },
                    {
                        $setOnInsert: {
                            eventId: event.eventId,
                            payloadHash,
                            scenicId: event.scenicId,
                            edgeId: event.edgeId,
                            operation: event.operation,
                            createdAt: now
                        },
                        $set: {
                            state: 'processing',
                            ownerId: eventOwnerId,
                            leaseUntil,
                            updatedAt: now,
                            completedAt: null,
                            outcome: null,
                            lastErrorCode: null,
                            expireAt
                        },
                        $inc: { attempts: 1 }
                    },
                    { new: true, upsert: true, setDefaultsOnInsert: true }
                ));
                if (claimed?.state === 'processing' && claimed.ownerId === eventOwnerId) {
                    return { acquired: true, ownerId: eventOwnerId, payloadHash };
                }
            } catch (error) {
                if (!duplicateKeyError(error)) throw error;
            }

            const existing = await loadEventRecord(event.eventId);
            if (!existing) continue;
            if (existing.payloadHash !== payloadHash) {
                throw barrierError(
                    'BARRIER_EVENT_ID_CONFLICT',
                    'barrier eventId was reused with a different payload'
                );
            }
            if (existing.state === 'completed') {
                return { acquired: false, state: 'completed' };
            }
            const existingLease = new Date(existing.leaseUntil || 0);
            if (existing.state === 'processing' && existingLease.getTime() > now.getTime()) {
                return { acquired: false, state: 'processing' };
            }
        }
        return { acquired: false, state: 'processing' };
    }

    function startEventHeartbeat(event) {
        let stopped = false;
        let renewal = null;
        let ownershipError = null;

        async function renew() {
            const now = validDate(clock(), 'clock');
            const updated = await models.BarrierEventRecord.findOneAndUpdate(
                {
                    eventId: event.eventId,
                    ownerId: eventOwnerId,
                    state: 'processing'
                },
                {
                    $set: {
                        leaseUntil: new Date(now.getTime() + eventLeaseMs),
                        updatedAt: now,
                        expireAt: new Date(now.getTime() + eventRetentionMs)
                    }
                },
                { new: true }
            );
            if (!updated) {
                throw barrierError('BARRIER_EVENT_LEASE_LOST', 'barrier event lease ownership was lost');
            }
        }

        function tick() {
            if (stopped || renewal) return;
            renewal = renew()
                .catch(error => {
                    ownershipError = error?.code
                        ? error
                        : barrierError(
                            'BARRIER_EVENT_LEASE_RENEW_FAILED',
                            'barrier event lease could not be renewed'
                        );
                })
                .finally(() => { renewal = null; });
        }

        const timer = setInterval(tick, eventHeartbeatMs);
        timer.unref?.();
        return {
            assertOwned() {
                if (ownershipError) throw ownershipError;
            },
            async stop() {
                if (stopped) return;
                stopped = true;
                clearInterval(timer);
                if (renewal) await renewal;
            }
        };
    }

    async function completeEventLease(event, impact) {
        const now = validDate(clock(), 'clock');
        const updated = await models.BarrierEventRecord.findOneAndUpdate(
            { eventId: event.eventId, ownerId: eventOwnerId, state: 'processing' },
            {
                $set: {
                    state: 'completed',
                    ownerId: null,
                    leaseUntil: null,
                    completedAt: now,
                    updatedAt: now,
                    outcome: impact.outcome,
                    lastErrorCode: null,
                    expireAt: new Date(now.getTime() + eventRetentionMs)
                }
            },
            { new: true }
        );
        if (!updated) {
            throw barrierError('BARRIER_EVENT_LEASE_LOST', 'barrier event completion lost its lease');
        }
    }

    async function failEventLease(event, error) {
        const now = validDate(clock(), 'clock');
        await models.BarrierEventRecord.findOneAndUpdate(
            { eventId: event.eventId, ownerId: eventOwnerId, state: 'processing' },
            {
                $set: {
                    state: 'failed',
                    ownerId: null,
                    leaseUntil: now,
                    completedAt: null,
                    updatedAt: now,
                    outcome: null,
                    lastErrorCode: persistedErrorCode(error),
                    expireAt: new Date(now.getTime() + eventRetentionMs)
                }
            },
            { new: true }
        );
    }

    async function emitFinalImpact(impact) {
        const failed = impact.failedCount + impact.operationalFailureCount;
        impact.partialFailure = (impact.proposedCount + impact.invalidatedDraftCount) > 0
            && failed > 0;
        impact.success = failed === 0;
        impact.outcome = impact.success
            ? 'completed'
            : impact.partialFailure
                ? 'partial'
                : 'failed';
        impact.completedAt = validDate(clock(), 'clock').toISOString();
        impact.emittedImpact = {
            eventId: impact.eventId,
            edgeId: impact.edgeId,
            affectedItineraries: impact.affectedItineraryCount,
            proposalsCreated: impact.proposedCount,
            failed,
            completedAt: impact.completedAt
        };
        await emitOpsImpact(impact.emittedImpact);
        return impact;
    }

    async function comparableMutableRoute(
        stops,
        preferences,
        fallbackRoute = null,
        expectedDataVersion = null
    ) {
        const mutableStops = mutableStopsOf(stops);
        if (aggregateRouteFromStops) {
            const aggregate = await aggregateRouteFromStops(
                mutableStops,
                preferences,
                null,
                { expectedDataVersion }
            );
            if (routeMaterialSignature(aggregate)) return aggregate;
        }
        const stopRoute = { stops: mutableStops };
        if (routeMaterialSignature(stopRoute)) return stopRoute;
        return fallbackRoute || stopRoute;
    }

    async function processItinerary({ itinerary, event, snapshot, now, assertEventOwnership }) {
        let affected = false;
        let attempted = false;
        try {
            assertEventOwnership();
            const itineraryId = itineraryIdOf(itinerary);
            if (!itineraryId) {
                throw barrierError('INVALID_ITINERARY', 'active itinerary is missing _id');
            }

            const proposedStops = Array.isArray(itinerary.stops) ? itinerary.stops : [];
            if (!mutableStopsOf(proposedStops).length) {
                return {
                    itineraryId,
                    status: 'skipped',
                    code: 'NO_MUTABLE_STOPS',
                    affected,
                    attempted
                };
            }
            const eventPhysicalEdgeIds = new Set([
                event.edgeId,
                ...(Array.isArray(event.edgeIds) ? event.edgeIds : [])
            ]);
            for (const barrier of snapshot.barriers) {
                if (barrier.physicalEdgeId === event.edgeId
                    || barrier.edgeId === event.edgeId
                    || eventPhysicalEdgeIds.has(barrier.edgeId)) {
                    eventPhysicalEdgeIds.add(barrier.edgeId);
                    eventPhysicalEdgeIds.add(barrier.physicalEdgeId);
                }
            }
            if (event.operation === 'close' && remainingRouteUsesEdge(itinerary, {
                edgeId: event.edgeId,
                physicalEdgeId: event.physicalEdgeId || event.edgeId,
                edgeIds: [...eventPhysicalEdgeIds]
            }) === false) {
                return {
                    itineraryId,
                    status: 'skipped',
                    code: 'CLOSED_EDGE_NOT_USED',
                    affected,
                    attempted
                };
            }

            affected = true;
            const existingProposal = hasPendingProposal(itinerary)
                ? proposalMetadata(itinerary.pendingProposal)
                : null;
            const priorEvent = priorBarrierEvent(itinerary, event.eventId);
            if (priorEvent) {
                return {
                    itineraryId,
                    status: 'proposed',
                    code: 'EVENT_ALREADY_APPLIED',
                    proposalId: priorEvent.proposalId,
                    replayed: true,
                    affected,
                    attempted
                };
            }
            if (existingProposal && event.operation !== 'close') {
                return {
                    itineraryId,
                    status: 'skipped',
                    code: 'PENDING_PROPOSAL_EXISTS',
                    affected,
                    attempted
                };
            }
            if (existingProposal && !existingProposal.proposalId) {
                throw barrierError(
                    'INVALID_PENDING_PROPOSAL',
                    'existing pending proposal is missing proposalId',
                    { itineraryId }
                );
            }
            if (!snapshot.dataVersion) {
                throw barrierError(
                    'BARRIER_DATA_VERSION_UNAVAILABLE',
                    'GIS dataVersion is unavailable for barrier rerouting',
                    { itineraryId }
                );
            }

            attempted = true;
            assertEventOwnership();
            const routeContext = {
                barriers: snapshot.barriers.map(barrier => ({
                    edgeId: barrier.edgeId,
                    physicalEdgeId: barrier.physicalEdgeId,
                    sourceRef: { ...barrier.sourceRef }
                })),
                requestId: event.eventId,
                eventId: event.eventId,
                barrierFingerprint: snapshot.fingerprint,
                dataVersion: snapshot.dataVersion
            };
            const rebuilt = await rebuildTimeline({
                itinerary,
                proposedStops,
                proposal: null,
                now,
                routeBetween,
                routeContext
            });
            const candidateStops = Array.isArray(rebuilt) ? rebuilt : rebuilt?.stops;
            if (!Array.isArray(candidateStops)) {
                throw barrierError('INVALID_REBUILD_RESULT', 'rebuildTimeline must return stops or { stops }');
            }
            const explicitRoute = !Array.isArray(rebuilt) ? rebuilt?.route : null;
            if (!routeAvoidsBarriers({
                stops: mutableStopsOf(candidateStops),
                ...(explicitRoute ? { route: explicitRoute } : {})
            }, snapshot.barriers)) {
                throw barrierError(
                    'BARRIER_ROUTE_CONFLICT',
                    'rebuilt mutable route still contains a closed barrier',
                    { itineraryId }
                );
            }

            const route = explicitRoute !== null && explicitRoute !== undefined
                ? explicitRoute
                : aggregateRouteFromStops
                    ? await aggregateRouteFromStops(
                        candidateStops,
                        itinerary.preferences,
                        itinerary.route,
                        { expectedDataVersion: snapshot.dataVersion }
                    )
                    : null;
            if (event.operation === 'open') {
                const currentMutableRoute = await comparableMutableRoute(
                    proposedStops,
                    itinerary.preferences,
                    itinerary.route,
                    snapshot.dataVersion
                );
                const candidateMutableRoute = await comparableMutableRoute(
                    candidateStops,
                    itinerary.preferences,
                    explicitRoute,
                    snapshot.dataVersion
                );
                if (routesMateriallyEqual(currentMutableRoute, candidateMutableRoute)) {
                    affected = false;
                    return {
                        itineraryId,
                        status: 'skipped',
                        code: 'ROUTE_UNCHANGED',
                        affected,
                        attempted
                    };
                }
            }

            const proposalId = String(idFactory({
                type: 'barrierReroute',
                event,
                itinerary,
                now
            }) || '').trim();
            if (!proposalId) throw barrierError('INVALID_PROPOSAL_ID', 'idFactory returned an empty proposal id');

            const proposal = {
                proposalId,
                type: 'barrierReroute',
                payload: {
                    eventId: event.eventId,
                    operation: event.operation,
                    edgeId: event.edgeId,
                    barrierFingerprint: snapshot.fingerprint,
                    barrierEdgeIds: [...snapshot.edgeIds],
                    dataVersion: snapshot.dataVersion,
                    barriers: routeContext.barriers,
                    stops: candidateStops,
                    ...(route !== null && route !== undefined ? { route } : {})
                },
                reason: event.operation === 'close'
                    ? `Route review required after edge ${event.edgeId} closed`
                    : `Route review required after edge ${event.edgeId} opened`,
                gainMin: 0,
                tokenIds: [],
                expireAt: new Date(now.getTime() + proposalTtlMs)
            };

            assertEventOwnership();
            await assertCurrentRoutingSnapshot(snapshot, event.scenicId, itineraryId);
            assertEventOwnership();
            const updated = await models.Itinerary.findOneAndUpdate(
                {
                    _id: itinerary._id,
                    version: itinerary.version,
                    state: itinerary.state === 'paused' ? 'paused' : 'active',
                    ...(existingProposal
                        ? { 'pendingProposal.proposalId': existingProposal.proposalId }
                        : { pendingProposal: null })
                },
                {
                    $set: { pendingProposal: proposal },
                    $inc: { version: 1 },
                    ...(existingProposal ? {
                        $push: {
                            rerouteLog: {
                                at: now,
                                type: existingProposal.proposal.type,
                                reason: existingProposal.proposal.reason,
                                savedMin: 0,
                                accepted: false,
                                status: 'failed',
                                proposalId: existingProposal.proposalId,
                                eventId: existingProposal.eventId,
                                edgeId: existingProposal.edgeId,
                                barrierFingerprint: existingProposal.barrierFingerprint
                            }
                        }
                    } : {})
                },
                { new: true }
            );
            if (!updated) {
                throw barrierError(
                    'ITINERARY_CAS_CONFLICT',
                    'itinerary changed before barrier reroute proposal could be stored',
                    { itineraryId }
                );
            }

            const operationalErrors = [];
            assertEventOwnership();
            if (existingProposal) {
                try {
                    await releaseProposalTokens(
                        existingProposal.proposal.tokenIds || [],
                        itinerary._id
                    );
                } catch (error) {
                    operationalErrors.push({ scope: 'superseded-proposal-token-release', error });
                }
                try {
                    await emitRerouteDecided({
                        openId: updated.openId || itinerary.openId,
                        itineraryId: updated._id || itinerary._id,
                        proposalId: existingProposal.proposalId,
                        status: 'failed',
                        accepted: false,
                        version: updated.version,
                        at: now.toISOString(),
                        eventId: existingProposal.eventId
                    });
                } catch (error) {
                    operationalErrors.push({ scope: 'superseded-proposal-status', error });
                }
            }
            try {
                await emitRerouteProposed({ itinerary: updated, proposal });
            } catch (error) {
                operationalErrors.push({ scope: 'reroute-proposal-publish', error });
            }
            return {
                itineraryId,
                status: 'proposed',
                proposalId,
                affected,
                attempted,
                ...(existingProposal ? {
                    supersededProposalId: existingProposal.proposalId
                } : {}),
                ...(operationalErrors.length ? { operationalErrors } : {})
            };
        } catch (error) {
            error.barrierReroute = { affected, attempted };
            throw error;
        }
    }

    async function invalidateDraftItinerary({ itinerary, event, now, assertEventOwnership }) {
        const affected = true;
        const attempted = false;
        try {
            assertEventOwnership();
            const itineraryId = itineraryIdOf(itinerary);
            if (!itineraryId) {
                throw barrierError('INVALID_ITINERARY', 'draft itinerary is missing _id');
            }

            const reason = `graph ${event.operation} event ${event.eventId} invalidated draft routing snapshot`;
            const planningSnapshot = invalidatedPlanningSnapshot(
                itinerary.planningSnapshot,
                now,
                reason
            );
            const tokenIds = capacityTokenIdsOf(itinerary);
            const updated = await models.Itinerary.findOneAndUpdate(
                {
                    _id: itinerary._id,
                    version: itinerary.version,
                    state: 'draft'
                },
                {
                    $set: {
                        state: 'abandoned',
                        stops: stopsWithoutCapacityTokens(itinerary.stops),
                        pendingProposal: null,
                        planningSnapshot
                    },
                    $unset: { activeOwner: 1 },
                    $inc: { version: 1 }
                },
                { new: true }
            );
            if (!updated) {
                throw barrierError(
                    'ITINERARY_CAS_CONFLICT',
                    'draft itinerary changed before it could be invalidated',
                    { itineraryId }
                );
            }

            const operationalErrors = [];
            if (tokenIds.length) {
                try {
                    await releaseProposalTokens(tokenIds, itinerary._id);
                } catch (error) {
                    operationalErrors.push({ scope: 'invalidated-draft-token-release', error });
                }
            }
            return {
                itineraryId,
                status: 'invalidated',
                code: 'DRAFT_INVALIDATED_BY_GRAPH_CHANGE',
                affected,
                attempted,
                ...(operationalErrors.length ? { operationalErrors } : {})
            };
        } catch (error) {
            error.barrierReroute = { affected, attempted };
            throw error;
        }
    }

    async function runAcceptedEvent(event, assertEventOwnership) {
        assertEventOwnership();
        const now = validDate(clock(), 'clock');
        const impact = {
            eventId: event.eventId,
            requestId: event.eventId,
            scenicId: event.scenicId,
            edgeId: event.edgeId,
            operation: event.operation,
            edgeStatus: event.operation === 'close' ? 'closed' : 'open',
            dataVersion: null,
            accepted: true,
            duplicate: false,
            acceptedAt: now,
            cacheInvalidatedBeforeEnqueue: event.cacheInvalidated,
            cacheInvalidationAttempts: 0,
            graphReloadAttempts: 0,
            barrierCount: 0,
            barrierEdgeIds: [],
            barrierFingerprint: null,
            itineraryCount: 0,
            affectedItineraryCount: 0,
            attemptedCount: 0,
            proposedCount: 0,
            invalidatedDraftCount: 0,
            skippedCount: 0,
            failedCount: 0,
            operationalFailureCount: 0,
            outcomes: [],
            failures: []
        };

        assertEventOwnership();
        let eventDataVersion;
        try {
            eventDataVersion = await readDataVersion();
            impact.dataVersion = eventDataVersion;
        } catch (error) {
            impact.operationalFailureCount++;
            impact.failures.push(errorRecord('data-version-snapshot', error));
        }

        assertEventOwnership();
        if (!event.cacheInvalidated) {
            impact.cacheInvalidationAttempts++;
            try {
                await gateway.invalidateRouteCache(
                    `barrier-${event.operation}:${event.scenicId}:${event.eventId}`
                );
            } catch (error) {
                impact.operationalFailureCount++;
                impact.failures.push(errorRecord('route-cache-invalidation', error));
            }
        }
        assertEventOwnership();
        impact.graphReloadAttempts++;
        try {
            await reloadWalkGraph();
        } catch (error) {
            impact.operationalFailureCount++;
            impact.failures.push(errorRecord('walk-graph-reload', error));
        }

        assertEventOwnership();
        let snapshot;
        try {
            const barrierSnapshot = await loadClosedBarrierSnapshot({
                WalkEdge: models.WalkEdge,
                scenicId: event.scenicId
            });
            snapshot = { ...barrierSnapshot, dataVersion: eventDataVersion };
            impact.barrierCount = snapshot.barriers.length;
            impact.barrierEdgeIds = [...snapshot.edgeIds];
            impact.barrierFingerprint = snapshot.fingerprint;
        } catch (error) {
            impact.operationalFailureCount++;
            impact.failures.push(errorRecord('barrier-snapshot', error));
            return emitFinalImpact(impact);
        }

        assertEventOwnership();
        let itineraries;
        try {
            itineraries = await resolveLeanQuery(models.Itinerary.find({
                scenicId: event.scenicId,
                state: { $in: ['draft', 'active', 'paused'] }
            }));
            if (!Array.isArray(itineraries)) {
                throw barrierError('INVALID_ITINERARY_QUERY', 'Itinerary.find must resolve to an array');
            }
        } catch (error) {
            impact.operationalFailureCount++;
            impact.failures.push(errorRecord('active-itinerary-query', error));
            return emitFinalImpact(impact);
        }

        impact.itineraryCount = itineraries.length;
        const settled = await settleWithConcurrency(
            itineraries,
            itineraryConcurrency,
            itinerary => itinerary?.state === 'draft'
                ? invalidateDraftItinerary({
                    itinerary,
                    event,
                    now,
                    assertEventOwnership
                })
                : processItinerary({
                    itinerary,
                    event,
                    snapshot,
                    now,
                    assertEventOwnership
                })
        );
        settled.forEach((result, index) => {
            const itineraryId = itineraryIdOf(itineraries[index]);
            if (result.status === 'rejected') {
                if (result.reason?.barrierReroute?.affected) impact.affectedItineraryCount++;
                if (result.reason?.barrierReroute?.attempted) impact.attemptedCount++;
                impact.failedCount++;
                impact.failures.push(errorRecord('itinerary-reroute', result.reason, itineraryId));
                impact.outcomes.push({
                    itineraryId,
                    status: 'failed',
                    code: result.reason?.code || 'UNEXPECTED_ERROR'
                });
                return;
            }
            const { operationalErrors = [], ...outcome } = result.value;
            impact.outcomes.push({
                ...outcome,
                ...(operationalErrors.length ? {
                    operationalFailureCount: operationalErrors.length
                } : {})
            });
            if (result.value.affected) impact.affectedItineraryCount++;
            if (result.value.attempted) impact.attemptedCount++;
            if (result.value.status === 'proposed') impact.proposedCount++;
            if (result.value.status === 'invalidated') impact.invalidatedDraftCount++;
            if (result.value.status === 'skipped') impact.skippedCount++;
            for (const operationalError of operationalErrors) {
                impact.operationalFailureCount++;
                impact.failures.push(errorRecord(
                    operationalError.scope,
                    operationalError.error,
                    itineraryId
                ));
            }
        });

        assertEventOwnership();
        return emitFinalImpact(impact);
    }

    async function runPersistedEvent(event) {
        const claim = await claimEventLease(event);
        if (!claim.acquired) {
            return {
                eventId: event.eventId,
                requestId: event.eventId,
                scenicId: event.scenicId,
                edgeId: event.edgeId,
                operation: event.operation,
                accepted: false,
                duplicate: true,
                persisted: true,
                ...(claim.state === 'processing' ? { inProgress: true } : { completed: true })
            };
        }

        const heartbeat = startEventHeartbeat(event);
        try {
            heartbeat.assertOwned();
            const impact = await runAcceptedEvent(event, () => heartbeat.assertOwned());
            await heartbeat.stop();
            heartbeat.assertOwned();
            await completeEventLease(event, impact);
            return impact;
        } catch (error) {
            let failure = error;
            try {
                await heartbeat.stop();
                heartbeat.assertOwned();
            } catch (heartbeatError) {
                if (heartbeatError !== failure) {
                    failure = new AggregateError(
                        [failure, heartbeatError],
                        'Barrier event processing and lease renewal both failed'
                    );
                }
            }
            try {
                await failEventLease(event, failure);
            } catch (persistenceError) {
                throw new AggregateError(
                    [failure, persistenceError],
                    'Barrier event failed and its persistent lease could not be updated'
                );
            }
            throw failure;
        }
    }

    async function processGraphEvent(rawEvent) {
        const event = normalizeGraphEvent(rawEvent);
        const payloadHash = graphEventPayloadHash(event);
        const existing = eventRecords.get(event.eventId);
        if (existing) {
            if (existing.payloadHash !== payloadHash) {
                throw barrierError(
                    'BARRIER_EVENT_ID_CONFLICT',
                    'barrier eventId was reused with a different payload'
                );
            }
            await existing.promise;
            return {
                eventId: event.eventId,
                requestId: event.eventId,
                scenicId: event.scenicId,
                edgeId: event.edgeId,
                operation: event.operation,
                accepted: false,
                duplicate: true
            };
        }

        const promise = runPersistedEvent(event);
        eventRecords.set(event.eventId, { promise, payloadHash });
        try {
            return await promise;
        } finally {
            if (eventRecords.get(event.eventId)?.promise === promise) {
                eventRecords.delete(event.eventId);
            }
        }
    }

    function enqueueGraphEvent(rawEvent) {
        const event = normalizeGraphEvent(rawEvent);
        const previous = scenicQueues.get(event.scenicId) || Promise.resolve();
        const task = previous
            .catch(() => undefined)
            .then(() => processGraphEvent(event));
        scenicQueues.set(event.scenicId, task);
        task.finally(() => {
            if (scenicQueues.get(event.scenicId) === task) scenicQueues.delete(event.scenicId);
        }).catch(() => undefined);
        return task;
    }

    return {
        processGraphEvent,
        enqueueGraphEvent
    };
}

module.exports = {
    normalizeClosedBarrier,
    loadClosedBarrierSnapshot,
    barrierFingerprint,
    routeAvoidsBarriers,
    remainingRouteUsesEdge,
    createBarrierRerouteCoordinator,
    DEFAULT_ITINERARY_CONCURRENCY
};
