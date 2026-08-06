'use strict';

const geo = require('../lib/geo');

const EVENT_TYPES = Object.freeze({
    START: 'START',
    STAY_OPENED: 'STAY_OPENED',
    STAY_CLOSED: 'STAY_CLOSED',
    SKIP: 'SKIP'
});

const MUTABLE_STOP_STATES = new Set(['pending', 'approaching']);
const TERMINAL_ITINERARY_STATES = new Set(['completed', 'abandoned']);

function plain(value) {
    return value && typeof value.toObject === 'function'
        ? value.toObject({ depopulate: true })
        : value;
}

function cloneStops(stops) {
    return (stops || []).map(stop => ({ ...plain(stop) }));
}

function sameId(a, b) {
    return a != null && b != null && String(a) === String(b);
}

function requiredDate(value, eventType) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) {
        throw new TypeError(`${eventType} requires a valid at timestamp`);
    }
    return date;
}

function uniqueIds(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
        if (id == null) continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
}

// Keep one current stop. An arrived stop owns the current slot; otherwise the
// first mutable stop is approaching and the rest remain pending.
function normalizeCurrent(stops, enabled) {
    if (!enabled) return false;
    const hasArrived = stops.some(stop => stop.state === 'arrived');
    let selected = false;
    let changed = false;

    for (const stop of stops) {
        if (!MUTABLE_STOP_STATES.has(stop.state)) continue;
        const nextState = !hasArrived && !selected ? 'approaching' : 'pending';
        selected = selected || nextState === 'approaching';
        if (stop.state !== nextState) {
            stop.state = nextState;
            changed = true;
        }
    }
    return changed;
}

function noChange(source) {
    return {
        changed: false,
        state: source.state,
        stops: source.stops || [],
        clearPendingProposal: false,
        invalidatedProposalId: null,
        releaseTokenIds: []
    };
}

/**
 * Pure itinerary state reducer. It performs no model access and never mutates
 * the supplied itinerary or stops.
 */
function reduceItinerary(itinerary, event) {
    const source = plain(itinerary) || {};
    if (!event || !Object.values(EVENT_TYPES).includes(event.type)) {
        throw new TypeError(`Unsupported itinerary runtime event: ${event?.type}`);
    }
    if (TERMINAL_ITINERARY_STATES.has(source.state)) return noChange(source);

    const stops = cloneStops(source.stops);
    let state = source.state;
    let changed = false;
    const releaseTokenIds = [];

    switch (event.type) {
        case EVENT_TYPES.START: {
            if (state !== 'draft' && state !== 'active') return noChange(source);
            if (state === 'draft') {
                state = 'active';
                changed = true;
            }
            changed = normalizeCurrent(stops, true) || changed;
            break;
        }

        case EVENT_TYPES.STAY_OPENED: {
            if (state !== 'active' && state !== 'paused') return noChange(source);
            let current = stops.find(stop => stop.state === 'approaching');
            if (!current) {
                const firstPending = stops.find(stop => stop.state === 'pending');
                if (firstPending && sameId(firstPending.poiId, event.poiId)) {
                    firstPending.state = 'approaching';
                    current = firstPending;
                }
            }
            if (current && sameId(current.poiId, event.poiId)) {
                current.state = 'arrived';
                if (!current.actualArrive) {
                    current.actualArrive = requiredDate(event.at, event.type);
                }
                if (current.capacityTokenId) {
                    releaseTokenIds.push(current.capacityTokenId);
                    current.capacityTokenId = null;
                }
                changed = true;
            }
            break;
        }

        case EVENT_TYPES.STAY_CLOSED: {
            if (state !== 'active' && state !== 'paused') return noChange(source);
            const current = stops.find(stop =>
                stop.state === 'arrived' && sameId(stop.poiId, event.poiId));
            if (!current) return noChange(source);
            current.state = 'done';
            if (!current.actualLeave) {
                current.actualLeave = requiredDate(event.at, event.type);
            }
            if (current.capacityTokenId) {
                releaseTokenIds.push(current.capacityTokenId);
                current.capacityTokenId = null;
            }
            changed = true;
            normalizeCurrent(stops, true);
            break;
        }

        case EVENT_TYPES.SKIP: {
            const target = stops.find(stop => sameId(stop._id, event.stopId));
            if (!target || !MUTABLE_STOP_STATES.has(target.state)) return noChange(source);
            target.state = 'skipped';
            if (target.capacityTokenId) {
                releaseTokenIds.push(target.capacityTokenId);
                target.capacityTokenId = null;
            }
            changed = true;
            normalizeCurrent(stops, state === 'active' || state === 'paused');
            break;
        }
    }

    const invalidateProposal = changed && event.type !== EVENT_TYPES.START &&
        Boolean(source.pendingProposal?.proposalId);
    if (invalidateProposal) {
        releaseTokenIds.push(...(source.pendingProposal.tokenIds || []));
    }

    return {
        changed,
        state,
        stops,
        clearPendingProposal: invalidateProposal,
        invalidatedProposalId: invalidateProposal ? source.pendingProposal.proposalId : null,
        releaseTokenIds: uniqueIds(releaseTokenIds)
    };
}

async function findLean(Itinerary, filter) {
    const query = Itinerary.findOne(filter);
    return query && typeof query.lean === 'function' ? query.lean() : query;
}

function eventWithTimestamp(event, clock) {
    if (!event || typeof event !== 'object') {
        throw new TypeError('itinerary runtime event is required');
    }
    if ((event.type === EVENT_TYPES.STAY_OPENED || event.type === EVENT_TYPES.STAY_CLOSED) && !event.at) {
        return { ...event, at: clock() };
    }
    return { ...event };
}

/**
 * Read-reduce-CAS wrapper. The write filter always contains _id, version and
 * the state that was reduced. A failed CAS is re-read and retried once by
 * default. Token release happens only after the itinerary write commits.
 */
async function applyRuntimeEvent({
    Itinerary,
    lookup,
    event,
    allowedStates,
    expectedVersion,
    onReleaseTokens,
    clock = () => new Date(),
    maxRetries = 1
}) {
    if (!Itinerary || typeof Itinerary.findOne !== 'function' ||
        typeof Itinerary.findOneAndUpdate !== 'function') {
        throw new TypeError('Itinerary model with findOne/findOneAndUpdate is required');
    }
    if (!lookup || (!lookup._id && !lookup.openId)) {
        throw new TypeError('lookup requires _id or openId');
    }

    const normalizedEvent = eventWithTimestamp(event, clock);
    const stateFilter = allowedStates?.length ? { state: { $in: allowedStates } } : {};
    const retries = Math.max(0, Number(maxRetries) || 0);
    let sawCasConflict = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const current = await findLean(Itinerary, { ...lookup, ...stateFilter });
        if (!current) {
            return {
                status: sawCasConflict ? 'conflict' : 'not_found',
                changed: false, attempts: attempt + 1,
                itinerary: null, releaseTokenIds: []
            };
        }
        if (expectedVersion != null && Number(current.version) !== Number(expectedVersion)) {
            return {
                status: 'conflict', changed: false, attempts: attempt + 1,
                itinerary: current, version: current.version, releaseTokenIds: []
            };
        }

        const reduced = reduceItinerary(current, normalizedEvent);
        if (!reduced.changed) {
            return {
                status: 'noop', changed: false, attempts: attempt + 1,
                itinerary: current, version: current.version, releaseTokenIds: []
            };
        }

        const set = { stops: reduced.stops, state: reduced.state };
        if (normalizedEvent.type === EVENT_TYPES.START && current.openId) {
            set.activeOwner = current.openId;
        }
        if (reduced.clearPendingProposal) set.pendingProposal = null;
        const updated = await Itinerary.findOneAndUpdate(
            { _id: current._id, version: current.version, state: current.state },
            { $set: set, $inc: { version: 1 } },
            { new: true }
        );

        if (!updated) {
            sawCasConflict = true;
            if (attempt < retries) continue;
            return {
                status: 'conflict', changed: false, attempts: attempt + 1,
                itinerary: current, version: current.version, releaseTokenIds: []
            };
        }

        let releaseError = null;
        if (reduced.releaseTokenIds.length && typeof onReleaseTokens === 'function') {
            try {
                await onReleaseTokens(reduced.releaseTokenIds, {
                    event: normalizedEvent,
                    itinerary: updated,
                    invalidatedProposalId: reduced.invalidatedProposalId
                });
            } catch (error) {
                releaseError = error;
            }
        }
        return {
            status: 'updated', changed: true, attempts: attempt + 1,
            itinerary: updated, version: updated.version,
            invalidatedProposalId: reduced.invalidatedProposalId,
            releaseTokenIds: reduced.releaseTokenIds,
            releaseError
        };
    }

    throw new Error('Unreachable itinerary runtime state');
}

function createItineraryRuntime({ Itinerary, onReleaseTokens, clock, maxRetries = 1 }) {
    const apply = options => applyRuntimeEvent({
        Itinerary, onReleaseTokens, clock, maxRetries, ...options
    });
    const identity = ({ itineraryId, openId }) => ({
        ...(itineraryId ? { _id: itineraryId } : {}),
        ...(openId ? { openId } : {})
    });

    return {
        apply,
        start(args) {
            return apply({
                lookup: identity(args), expectedVersion: args.version,
                allowedStates: ['draft', 'active'], event: { type: EVENT_TYPES.START }
            });
        },
        skip(args) {
            return apply({
                lookup: identity(args), expectedVersion: args.version,
                allowedStates: ['draft', 'active', 'paused'],
                event: { type: EVENT_TYPES.SKIP, stopId: args.stopId }
            });
        },
        stayOpened(args) {
            return apply({
                lookup: identity(args), allowedStates: ['active', 'paused'],
                event: { type: EVENT_TYPES.STAY_OPENED, poiId: args.poiId, at: args.at }
            });
        },
        stayClosed(args) {
            return apply({
                lookup: identity(args), allowedStates: ['active', 'paused'],
                event: { type: EVENT_TYPES.STAY_CLOSED, poiId: args.poiId, at: args.at }
            });
        }
    };
}

async function reconcilePresence({
    Itinerary,
    StaySample,
    hmacSecret,
    now = new Date(),
    onReleaseTokens
}) {
    if (!hmacSecret) return { checked: 0, updated: 0, itineraries: [] };
    const runtime = createItineraryRuntime({ Itinerary, onReleaseTokens });
    const itineraries = await Itinerary.find(
        { state: { $in: ['active', 'paused'] } },
        { openId: 1, state: 1, stops: 1, createTime: 1 }
    ).limit(500).lean();
    const changed = new Map();

    for (const itinerary of itineraries) {
        const current = itinerary.stops.find(stop =>
            stop.state === 'arrived' || stop.state === 'approaching');
        if (!current) continue;
        const lastDone = [...itinerary.stops].reverse().find(stop => stop.state === 'done');
        const lowerBound = lastDone?.actualLeave || itinerary.createTime ||
            new Date(new Date(now).getTime() - 24 * 3600000);
        const hashDates = [
            new Date(now),
            new Date(new Date(now).getTime() - 24 * 3600000),
            current.actualArrive ? new Date(current.actualArrive) : null
        ].filter(Boolean);
        const hashes = [...new Set(hashDates.map(date =>
            geo.userIdHash(itinerary.openId, hmacSecret, date)))];

        let sample;
        if (current.state === 'approaching') {
            sample = await StaySample.findOne({
                userIdHash: { $in: hashes },
                poiId: current.poiId,
                enterAt: { $gt: new Date(lowerBound) }
            }).sort({ enterAt: -1 }).lean();
            if (!sample) continue;
            const opened = await runtime.stayOpened({
                itineraryId: itinerary._id,
                openId: itinerary.openId,
                poiId: current.poiId,
                at: sample.enterAt
            });
            if (opened.status === 'updated') changed.set(String(itinerary._id), opened.itinerary);
            if (sample.leaveAt) {
                const closed = await runtime.stayClosed({
                    itineraryId: itinerary._id,
                    openId: itinerary.openId,
                    poiId: current.poiId,
                    at: sample.leaveAt
                });
                if (closed.status === 'updated') changed.set(String(itinerary._id), closed.itinerary);
            }
            continue;
        }

        sample = await StaySample.findOne({
            userIdHash: { $in: hashes },
            poiId: current.poiId,
            enterAt: { $gt: new Date(lowerBound) },
            leaveAt: { $ne: null }
        }).sort({ leaveAt: -1 }).lean();
        if (!sample) continue;
        const closed = await runtime.stayClosed({
            itineraryId: itinerary._id,
            openId: itinerary.openId,
            poiId: current.poiId,
            at: sample.leaveAt
        });
        if (closed.status === 'updated') changed.set(String(itinerary._id), closed.itinerary);
    }

    return {
        checked: itineraries.length,
        updated: changed.size,
        itineraries: [...changed.values()]
    };
}

module.exports = {
    EVENT_TYPES,
    reduceItinerary,
    applyRuntimeEvent,
    createItineraryRuntime,
    reconcilePresence
};
