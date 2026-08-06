'use strict';

const { haversine } = require('./geo');

const WALK_EDGE_LIMITS = Object.freeze({
    MIN_SLOPE_PCT: -100,
    MAX_SLOPE_PCT: 100,
    MIN_SPEED_MPS: 0.05,
    MAX_SPEED_MPS: 4,
    MIN_DISTANCE_RATIO: 0.25,
    MAX_DISTANCE_RATIO: 4
});

function numericValue(value, coerce) {
    if (typeof value === 'number') return value;
    if (coerce && typeof value === 'string' && value.trim()) return Number(value);
    return NaN;
}

function normalizeWalkSec(value, { coerce = false } = {}) {
    const number = numericValue(value, coerce);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeDistanceM(value, { coerce = false } = {}) {
    const number = numericValue(value, coerce);
    return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
        ? number
        : null;
}

function normalizeSlopePct(value, { coerce = false, defaultValue = 0 } = {}) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const number = numericValue(value, coerce);
    return Number.isFinite(number)
        && number >= WALK_EDGE_LIMITS.MIN_SLOPE_PCT
        && number <= WALK_EDGE_LIMITS.MAX_SLOPE_PCT
        ? number
        : null;
}

function normalizeUnitRatio(value, { coerce = false, defaultValue } = {}) {
    if (value === undefined || value === null || value === '') {
        return defaultValue === undefined ? null : defaultValue;
    }
    const number = numericValue(value, coerce);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function normalizeBoolean(value, { coerce = false, defaultValue } = {}) {
    if (value === undefined || value === null || value === '') {
        return defaultValue === undefined ? null : defaultValue;
    }
    if (typeof value === 'boolean') return value;
    if (coerce && (value === 1 || String(value).trim().toLowerCase() === 'true')) return true;
    if (coerce && (value === 0 || String(value).trim().toLowerCase() === 'false')) return false;
    return null;
}

function normalizeCoordinate(value, { coerce = false } = {}) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const lng = numericValue(value[0], coerce);
    const lat = numericValue(value[1], coerce);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [lng, lat];
}

function normalizeLineCoordinates(value, { coerce = false, minPoints = 2 } = {}) {
    if (!Array.isArray(value) || value.length < minPoints) return null;
    const coordinates = value.map(position => normalizeCoordinate(position, { coerce }));
    return coordinates.every(Boolean) ? coordinates : null;
}

function polylineDistanceM(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    let distanceM = 0;
    for (let index = 1; index < coordinates.length; index++) {
        const segmentM = haversine(coordinates[index - 1], coordinates[index]);
        if (!Number.isFinite(segmentM) || segmentM < 0) return null;
        distanceM += segmentM;
    }
    return Number.isFinite(distanceM) ? distanceM : null;
}

function plausibleEdgeMetrics({ walkSec, distanceM, geometryDistanceM }) {
    if (walkSec === null || distanceM === null || geometryDistanceM === null) return false;
    if (geometryDistanceM === 0) return distanceM === 0 && walkSec === 0;
    if (walkSec === 0 || distanceM === 0) return false;

    const distanceRatio = distanceM / geometryDistanceM;
    const speedMps = distanceM / walkSec;
    return Number.isFinite(distanceRatio)
        && distanceRatio >= WALK_EDGE_LIMITS.MIN_DISTANCE_RATIO
        && distanceRatio <= WALK_EDGE_LIMITS.MAX_DISTANCE_RATIO
        && Number.isFinite(speedMps)
        && speedMps >= WALK_EDGE_LIMITS.MIN_SPEED_MPS
        && speedMps <= WALK_EDGE_LIMITS.MAX_SPEED_MPS;
}

function normalizeWalkEdgeMetrics(raw = {}, {
    geometryDistanceM,
    coerce = false
} = {}) {
    const normalizedGeometryDistanceM = normalizeDistanceM(geometryDistanceM, { coerce });
    const walkSec = normalizeWalkSec(raw.walkSec, { coerce });
    const distanceM = raw.distanceM === undefined || raw.distanceM === null
        ? normalizedGeometryDistanceM
        : normalizeDistanceM(raw.distanceM, { coerce });
    const slope = normalizeSlopePct(raw.slope, { coerce, defaultValue: 0 });
    const shade = normalizeUnitRatio(raw.shade, { coerce, defaultValue: 0.5 });
    const covered = normalizeUnitRatio(raw.covered, { coerce, defaultValue: 0 });

    if (slope === null || shade === null || covered === null) return null;
    if (!plausibleEdgeMetrics({
        walkSec,
        distanceM,
        geometryDistanceM: normalizedGeometryDistanceM
    })) return null;
    return Object.freeze({ walkSec, distanceM, slope, shade, covered });
}

module.exports = {
    WALK_EDGE_LIMITS,
    normalizeWalkSec,
    normalizeDistanceM,
    normalizeSlopePct,
    normalizeUnitRatio,
    normalizeBoolean,
    normalizeCoordinate,
    normalizeLineCoordinates,
    polylineDistanceM,
    plausibleEdgeMetrics,
    normalizeWalkEdgeMetrics
};
