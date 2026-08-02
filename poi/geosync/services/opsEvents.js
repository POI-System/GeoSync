'use strict';

const ALLOWED_PROPOSAL_STATUSES = new Set([
    'shown', 'accepted', 'rejected', 'expired', 'failed'
]);

function nonEmptyString(value) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return text || null;
}

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function isoTimestamp(value, clock) {
    const date = value === undefined || value === null ? new Date(clock()) : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeImpact(payload, clock = Date.now) {
    const eventId = nonEmptyString(payload?.eventId);
    const edgeId = nonEmptyString(payload?.edgeId);
    const affectedItineraries = nonNegativeInteger(payload?.affectedItineraries);
    const proposalsCreated = nonNegativeInteger(payload?.proposalsCreated);
    const failed = nonNegativeInteger(payload?.failed);
    const completedAt = isoTimestamp(payload?.completedAt, clock);
    if (!eventId || !edgeId || affectedItineraries === null || proposalsCreated === null
        || failed === null || !completedAt) {
        return null;
    }
    return { eventId, edgeId, affectedItineraries, proposalsCreated, failed, completedAt };
}

function normalizeProposalStatus(payload, clock = Date.now) {
    const itineraryId = nonEmptyString(payload?.itineraryId);
    const proposalId = nonEmptyString(payload?.proposalId);
    const status = nonEmptyString(payload?.status);
    const version = nonNegativeInteger(payload?.version);
    const at = isoTimestamp(payload?.at, clock);
    if (!itineraryId || !proposalId || !ALLOWED_PROPOSAL_STATUSES.has(status)
        || version === null || !at) {
        return null;
    }
    const eventId = nonEmptyString(payload?.eventId);
    return {
        itineraryId,
        proposalId,
        status,
        version,
        at,
        ...(eventId ? { eventId } : {})
    };
}

function bindOpsEvents({ bus, io, scenicId, clock = Date.now, logger = console }) {
    if (!bus?.EVENTS || typeof bus.on !== 'function') {
        throw new TypeError('bindOpsEvents requires an event bus');
    }
    if (!io || typeof io.to !== 'function') {
        throw new TypeError('bindOpsEvents requires Socket.io');
    }
    const normalizedScenicId = nonEmptyString(scenicId);
    if (!normalizedScenicId) throw new TypeError('bindOpsEvents requires scenicId');
    const room = `admin:${normalizedScenicId}`;
    const subscriptions = [];

    subscriptions.push(bus.on(bus.EVENTS.OPS_IMPACT, payload => {
        const normalized = normalizeImpact(payload, clock);
        if (!normalized) {
            logger.warn?.('[GeoSync] [OPS] invalid impact payload dropped');
            return;
        }
        io.to(room).emit('ops:impact', normalized);
    }));

    subscriptions.push(bus.on(bus.EVENTS.OPS_PROPOSAL_STATUS, payload => {
        const normalized = normalizeProposalStatus(payload, clock);
        if (!normalized) {
            logger.warn?.('[GeoSync] [OPS] invalid proposal status dropped');
            return;
        }
        io.to(room).emit('ops:proposal-status', normalized);
    }));

    return () => {
        for (const unsubscribe of subscriptions) unsubscribe?.();
    };
}

module.exports = {
    ALLOWED_PROPOSAL_STATUSES,
    normalizeImpact,
    normalizeProposalStatus,
    bindOpsEvents
};
