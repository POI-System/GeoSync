'use strict';

const { getModels } = require('../models');
const { NoRouteError, SuperMapError } = require('../integrations/supermap/errors');
const { encodePolyline } = require('../lib/geo');
const walkGraph = require('./walkGraph');

const RECENT_POSITION_MAX_AGE_MS = 5 * 60000;
const MUTABLE_STATES = new Set(['pending', 'approaching']);
const PACE_FACTOR = { relaxed: 1.3, normal: 1, tight: 0.8 };

class TimelineRebuildError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'TimelineRebuildError';
        this.code = code;
        this.details = details;
    }
}

/**
 * Rebuild route geometry and ETA for the mutable remainder of an itinerary.
 * Injected routeBetween receives (fromPoi, toPoi, mode, routeContext) and may be async.
 */
async function rebuildTimeline({
    itinerary,
    proposedStops,
    proposal = null,
    now = new Date(),
    loadPois = defaultLoadPois,
    routeBetween = defaultRouteBetween,
    routeContext = {}
}) {
    if (!itinerary || !Array.isArray(proposedStops)) {
        throw new TimelineRebuildError('INVALID_INPUT', 'itinerary and proposedStops are required');
    }
    if (typeof loadPois !== 'function' || typeof routeBetween !== 'function') {
        throw new TimelineRebuildError('INVALID_INPUT', 'loadPois and routeBetween must be functions');
    }

    const nowDate = validDate(now, 'now');
    const stops = proposedStops.map(toPlainStop);
    normalizeCurrentStop(stops);
    const mutableStops = stops.filter(stop => MUTABLE_STATES.has(stop.state));
    if (!mutableStops.length) return stops;

    const poiIds = [...new Set(stops.map(stop => idOf(stop.poiId)).filter(Boolean))];
    const poiMap = normalizePoiMap(await loadPois(poiIds));
    for (const stop of mutableStops) requirePoi(poiMap, stop.poiId);

    const anchor = selectAnchor({ itinerary, stops, poiMap, now: nowDate });
    const mode = routeMode(itinerary.preferences);
    const delay = delaySpec(proposal);
    const replaceStopId = proposal?.type === 'replace' ? idOf(proposal.payload?.stopId) : '';
    let delayApplied = false;
    let cursorPoi = anchor.poi;
    let cursorAt = anchor.at;

    for (const stop of stops) {
        if (!MUTABLE_STATES.has(stop.state)) continue;

        if (delay && !delayApplied && idOf(stop._id || stop.stopId) === delay.stopId) {
            cursorAt = new Date(cursorAt.getTime() + delay.ms);
            delayApplied = true;
        }

        const poi = requirePoi(poiMap, stop.poiId);
        const route = await resolveRoute(routeBetween, cursorPoi, poi, mode, stop, routeContext);
        const arrive = new Date(cursorAt.getTime() + route.durationSec * 1000);
        const usePoiStay = replaceStopId && idOf(stop._id || stop.stopId) === replaceStopId;
        const leave = new Date(arrive.getTime() + stayDurationMs(stop, poi, itinerary.preferences, usePoiStay));

        stop.plannedArrive = arrive;
        stop.plannedLeave = leave;
        stop.durationSec = route.durationSec;
        stop.distanceM = route.distanceM;
        stop.geometry = route.geometry;
        stop.segments = route.segments;
        stop.snap = route.snap;
        stop.gis = route.gis;
        stop.verifiedAccessible = route.verifiedAccessible;
        stop.pathGeometry = route.pathGeometry;
        cursorPoi = poi;
        cursorAt = leave;
    }

    if (delay && !delayApplied) {
        throw new TimelineRebuildError('INVALID_DELAY_TARGET', 'delay target is not mutable or is missing', {
            stopId: delay.stopId
        });
    }
    return stops;
}

function normalizeCurrentStop(stops) {
    const hasArrived = stops.some(stop => stop.state === 'arrived');
    let selected = false;
    for (const stop of stops) {
        if (!MUTABLE_STATES.has(stop.state)) continue;
        if (!hasArrived && !selected) {
            stop.state = 'approaching';
            selected = true;
        } else {
            stop.state = 'pending';
        }
    }
}

async function defaultLoadPois(poiIds) {
    const { ExternalPoi } = getModels();
    return ExternalPoi.find({ _id: { $in: poiIds } }).lean();
}

function defaultRouteBetween(fromPoi, toPoi, mode) {
    return walkGraph.walkSecBetween(fromPoi, toPoi, mode);
}

async function resolveRoute(routeBetween, fromPoi, toPoi, mode, stop, routeContext) {
    let route;
    try {
        route = await routeBetween(fromPoi, toPoi, mode, routeContext);
    } catch (error) {
        if (error instanceof SuperMapError) throw error;
        throw new TimelineRebuildError('ROUTE_FAILED', `route calculation failed for stop ${idOf(stop._id || stop.stopId)}`, {
            stopId: idOf(stop._id || stop.stopId),
            cause: error
        });
    }

    const legacyFallback = route?.fallback == null &&
        Array.isArray(route?.nodeIds) && route.nodeIds.length === 0 &&
        Number(route?.distanceM) > 0;
    if (!route) {
        const code = mode === 'accessible' ? 'ACCESSIBLE_ROUTE_UNAVAILABLE' : 'ROUTE_UNAVAILABLE';
        throw new TimelineRebuildError(code, `route unavailable for stop ${idOf(stop._id || stop.stopId)}`, {
            stopId: idOf(stop._id || stop.stopId), mode
        });
    }
    const localFallback = route.fallback === true
        || legacyFallback
        || route.gis?.source === 'local-fallback';
    const verifiedAccessible = route.verifiedAccessible === true || route.accessibleVerified === true;
    if (mode === 'accessible' && localFallback && !verifiedAccessible) {
        throw new NoRouteError(undefined, {
            operation: 'findPath',
            requestId: route.gis?.requestId,
            category: 'no-route',
            retryable: false
        });
    }

    const stopId = idOf(stop._id || stop.stopId);
    const durationSec = durationSecOf(route, stopId);
    const distanceM = distanceMOf(route, stopId);
    const geometry = geometryOf(route, stopId);
    const pathGeometry = typeof route.pathGeometry === 'string'
        ? route.pathGeometry
        : typeof route.polyline === 'string'
            ? route.polyline
            : geometry ? encodePolyline(geometry.coordinates) : '';
    return {
        durationSec,
        distanceM,
        geometry,
        segments: Array.isArray(route.segments)
            ? route.segments.map(segment => ({ ...segment }))
            : [],
        snap: route.snap && typeof route.snap === 'object' ? { ...route.snap } : null,
        gis: route.gis && typeof route.gis === 'object' ? { ...route.gis } : null,
        verifiedAccessible,
        pathGeometry
    };
}

function durationSecOf(route, stopId) {
    const durationSec = route.durationSec === undefined ? route.walkSec : route.durationSec;
    if (!Number.isFinite(durationSec) || durationSec < 0) {
        throw new TimelineRebuildError(
            'INVALID_ROUTE',
            'route durationSec must be a non-negative number',
            { stopId }
        );
    }
    return durationSec;
}

function distanceMOf(route, stopId) {
    if (route.distanceM === undefined || route.distanceM === null) return null;
    if (!Number.isFinite(route.distanceM) || route.distanceM < 0) {
        throw new TimelineRebuildError(
            'INVALID_ROUTE',
            'route distanceM must be a non-negative number',
            { stopId }
        );
    }
    return route.distanceM;
}

function geometryOf(route, stopId) {
    if (route.geometry !== undefined && route.geometry !== null) {
        return normalizeLineString(route.geometry, stopId);
    }
    if (Array.isArray(route.coords) && route.coords.length >= 2) {
        return normalizeLineString({ type: 'LineString', coordinates: route.coords }, stopId);
    }
    return null;
}

function normalizeLineString(geometry, stopId) {
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
        throw new TimelineRebuildError(
            'INVALID_ROUTE',
            'route geometry must be a GeoJSON LineString',
            { stopId }
        );
    }
    const coordinates = geometry.coordinates.map(position => {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
            throw new TimelineRebuildError(
                'INVALID_ROUTE',
                'route geometry contains an invalid coordinate',
                { stopId }
            );
        }
        return [position[0], position[1]];
    });
    if (coordinates.length < 2) {
        throw new TimelineRebuildError(
            'INVALID_ROUTE',
            'route geometry must contain at least two coordinates',
            { stopId }
        );
    }
    return { type: 'LineString', coordinates };
}

function selectAnchor({ itinerary, stops, poiMap, now }) {
    const arrived = [...stops].reverse().find(stop => stop.state === 'arrived');
    const departureAt = arrived
        ? laterDate(now, arrived.plannedLeave)
        : now;
    const lastPosition = itinerary.lastPosition;
    if (isRecentPosition(lastPosition, now)) {
        return {
            source: 'lastPosition',
            poi: pointAnchor('lastPosition', [lastPosition.lng, lastPosition.lat]),
            at: departureAt
        };
    }
    if (arrived) {
        return {
            source: 'arrived',
            poi: requirePoi(poiMap, arrived.poiId),
            at: departureAt
        };
    }

    const done = [...stops].reverse().find(stop => stop.state === 'done');
    if (done) {
        return { source: 'done', poi: requirePoi(poiMap, done.poiId), at: now };
    }

    const startCoords = coordinatesOf(itinerary.startLocation);
    if (startCoords) {
        return { source: 'startLocation', poi: pointAnchor('startLocation', startCoords), at: now };
    }
    throw new TimelineRebuildError('ANCHOR_UNAVAILABLE', 'no recent position, visited POI, or startLocation is available');
}

function isRecentPosition(position, now) {
    if (!coordinatesOf(position)) return false;
    const at = dateMs(position?.at);
    if (at == null) return false;
    const age = now.getTime() - at;
    return age >= 0 && age <= RECENT_POSITION_MAX_AGE_MS;
}

function delaySpec(proposal) {
    if (proposal?.type !== 'delay') return null;
    const stopId = idOf(proposal.payload?.stopId);
    const raw = proposal.payload?.delayMin == null ? 25 : Number(proposal.payload.delayMin);
    if (!stopId || !Number.isFinite(raw) || raw < 0) {
        throw new TimelineRebuildError('INVALID_DELAY', 'delay proposal requires a stopId and non-negative delayMin');
    }
    return { stopId, ms: raw * 60000 };
}

function stayDurationMs(stop, poi, preferences = {}, usePoiStay = false) {
    const arrive = dateMs(stop.plannedArrive);
    const leave = dateMs(stop.plannedLeave);
    if (!usePoiStay && arrive != null && leave != null && leave >= arrive) return leave - arrive;

    const suggested = Number(poi.visitMeta?.suggestedStayMin);
    const stayMin = Number.isFinite(suggested) && suggested >= 0 ? suggested : 20;
    return stayMin * (PACE_FACTOR[preferences?.pace] || 1) * 60000;
}

function routeMode(preferences = {}) {
    if (preferences?.accessible) return 'accessible';
    if (preferences?.shadeFirst) return 'shade';
    return 'standard';
}

function normalizePoiMap(pois) {
    if (pois instanceof Map) {
        return new Map([...pois].map(([key, poi]) => [idOf(poi?._id || key), poi]));
    }
    if (Array.isArray(pois)) {
        return new Map(pois.map(poi => [idOf(poi?._id), poi]));
    }
    throw new TimelineRebuildError('INVALID_POI_LOADER', 'loadPois must return an array or Map');
}

function requirePoi(poiMap, poiId) {
    const id = idOf(poiId);
    const poi = poiMap.get(id);
    if (!poi) throw new TimelineRebuildError('POI_NOT_FOUND', `POI ${id} was not loaded`, { poiId: id });
    return poi;
}

function pointAnchor(source, coordinates) {
    return {
        _timelineAnchor: source,
        geo: { type: 'Point', coordinates }
    };
}

function coordinatesOf(value) {
    const coords = Array.isArray(value)
        ? value
        : value?.geo?.coordinates || value?.coordinates ||
            (value?.lng != null && value?.lat != null ? [value.lng, value.lat] : null);
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return null;
    return [coords[0], coords[1]];
}

function toPlainStop(stop) {
    const plain = stop?.toObject ? stop.toObject() : stop;
    if (!plain || typeof plain !== 'object') {
        throw new TimelineRebuildError('INVALID_STOP', 'each proposed stop must be an object');
    }
    return { ...plain };
}

function validDate(value, name) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new TimelineRebuildError('INVALID_DATE', `${name} must be a valid date`);
    }
    return date;
}

function laterDate(left, right) {
    const rightMs = dateMs(right);
    return rightMs == null || rightMs < left.getTime() ? left : new Date(rightMs);
}

function dateMs(value) {
    if (value == null) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function idOf(value) {
    return value == null ? '' : String(value);
}

module.exports = {
    rebuildTimeline,
    TimelineRebuildError,
    RECENT_POSITION_MAX_AGE_MS
};
