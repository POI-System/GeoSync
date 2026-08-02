'use strict';

const { GeometryNormalizationError } = require('./errors');

const SUPPORTED_TYPES = new Set([
    'Point',
    'MultiPoint',
    'LineString',
    'MultiLineString',
    'Polygon',
    'MultiPolygon'
]);

function safeContextValue(value, fallback = '') {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return (text || fallback).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

function normalizationError(context = {}) {
    return new GeometryNormalizationError(undefined, {
        operation: safeContextValue(context.operation, 'normalizeGeometry'),
        requestId: safeContextValue(context.requestId),
        category: 'geometry',
        retryable: false
    });
}

function fail(context) {
    throw normalizationError(context);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function roundSix(value) {
    const rounded = Math.round((value + Number.EPSILON) * 1e6) / 1e6;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function samePosition(left, right) {
    return left[0] === right[0] && left[1] === right[1];
}

function isWgs84Position(value) {
    return Array.isArray(value)
        && value.length === 2
        && value.every(Number.isFinite)
        && value[0] >= -180
        && value[0] <= 180
        && value[1] >= -90
        && value[1] <= 90;
}

function routeReferencePosition(value, context) {
    if (value === undefined || value === null) return null;
    if (!isWgs84Position(value)) fail(context);
    return [roundSix(value[0]), roundSix(value[1])];
}

function routeExtent(value, context) {
    if (value === undefined || value === null) return null;
    if (
        !Array.isArray(value)
        || value.length !== 4
        || !value.every(Number.isFinite)
        || value[0] < -180
        || value[2] > 180
        || value[1] < -90
        || value[3] > 90
        || value[0] >= value[2]
        || value[1] >= value[3]
    ) {
        fail(context);
    }
    return value.map(roundSix);
}

function planarDistanceSquared(left, right) {
    const meanLatitude = (left[1] + right[1]) * Math.PI / 360;
    const longitudeDelta = (left[0] - right[0]) * Math.cos(meanLatitude);
    const latitudeDelta = left[1] - right[1];
    return longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta;
}

function routeEndpointScore(coordinates, start, end) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const forward = (start ? planarDistanceSquared(start, first) : 0)
        + (end ? planarDistanceSquared(end, last) : 0);
    const reverse = (start ? planarDistanceSquared(start, last) : 0)
        + (end ? planarDistanceSquared(end, first) : 0);
    return { forward, reverse, best: Math.min(forward, reverse) };
}

function routeExtentScore(coordinates, extent) {
    if (!extent) return { outsideCount: 0, distance: 0 };
    let outsideCount = 0;
    let distance = 0;
    for (const coordinate of coordinates) {
        const clamped = [
            Math.min(extent[2], Math.max(extent[0], coordinate[0])),
            Math.min(extent[3], Math.max(extent[1], coordinate[1]))
        ];
        if (!samePosition(coordinate, clamped)) outsideCount++;
        distance += planarDistanceSquared(coordinate, clamped);
    }
    return { outsideCount, distance };
}

function routeAxisCandidate(rawCoordinates, swapped, start, end, extent) {
    const coordinates = [];
    let validCount = 0;
    for (const rawPosition of rawCoordinates) {
        if (!Array.isArray(rawPosition) || rawPosition.length !== 2 || !rawPosition.every(Number.isFinite)) {
            continue;
        }
        const candidate = swapped
            ? [rawPosition[1], rawPosition[0]]
            : [rawPosition[0], rawPosition[1]];
        if (!isWgs84Position(candidate)) continue;
        validCount++;
        const rounded = [roundSix(candidate[0]), roundSix(candidate[1])];
        if (!coordinates.length || !samePosition(coordinates[coordinates.length - 1], rounded)) {
            coordinates.push(rounded);
        }
    }

    if (coordinates.length < 2) return null;
    return {
        coordinates,
        validCount,
        extentScore: routeExtentScore(coordinates, extent),
        endpointScore: routeEndpointScore(coordinates, start, end)
    };
}

function routeCandidateIsBetter(candidate, current, hasExtent, hasEndpointContext) {
    if (!current) return true;
    if (hasExtent) {
        if (candidate.extentScore.outsideCount !== current.extentScore.outsideCount) {
            return candidate.extentScore.outsideCount < current.extentScore.outsideCount;
        }
        if (candidate.extentScore.distance !== current.extentScore.distance) {
            return candidate.extentScore.distance < current.extentScore.distance;
        }
    }
    if (hasEndpointContext && candidate.endpointScore.best !== current.endpointScore.best) {
        return candidate.endpointScore.best < current.endpointScore.best;
    }
    if (candidate.validCount !== current.validCount) return candidate.validCount > current.validCount;
    return candidate.coordinates.length > current.coordinates.length;
}

function arrayScope(value, state, context, operation) {
    if (!Array.isArray(value) || state.ancestors.has(value)) fail(context);
    state.ancestors.add(value);
    try {
        return operation(value);
    } finally {
        state.ancestors.delete(value);
    }
}

function normalizePosition(value, state, context) {
    return arrayScope(value, state, context, position => {
        if (position.length !== 2 || !position.every(Number.isFinite)) fail(context);
        const [lng, lat] = position;
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) fail(context);
        state.positionCount++;
        return [roundSix(lng), roundSix(lat)];
    });
}

function normalizePositionList(value, state, context, minimum, dedupeConsecutive) {
    return arrayScope(value, state, context, positions => {
        const normalized = [];
        for (const position of positions) {
            const point = normalizePosition(position, state, context);
            if (!dedupeConsecutive || !normalized.length || !samePosition(normalized[normalized.length - 1], point)) {
                normalized.push(point);
            }
        }
        if (normalized.length < minimum) fail(context);
        return normalized;
    });
}

function normalizeLineStringCoordinates(value, state, context) {
    return normalizePositionList(value, state, context, 2, true);
}

function normalizeLinearRing(value, state, context) {
    const ring = normalizePositionList(value, state, context, 3, true);
    if (!samePosition(ring[0], ring[ring.length - 1])) ring.push([...ring[0]]);
    if (ring.length < 4) fail(context);

    const distinct = new Set(ring.slice(0, -1).map(position => `${position[0]},${position[1]}`));
    if (distinct.size < 3) fail(context);
    return ring;
}

function normalizeMultiPoint(value, state, context) {
    return normalizePositionList(value, state, context, 1, false);
}

function normalizeMultiLineString(value, state, context) {
    return arrayScope(value, state, context, lines => {
        if (!lines.length) fail(context);
        return lines.map(line => normalizeLineStringCoordinates(line, state, context));
    });
}

function normalizePolygonCoordinates(value, state, context) {
    return arrayScope(value, state, context, rings => {
        if (!rings.length) fail(context);
        return rings.map(ring => normalizeLinearRing(ring, state, context));
    });
}

function normalizeMultiPolygon(value, state, context) {
    return arrayScope(value, state, context, polygons => {
        if (!polygons.length) fail(context);
        return polygons.map(polygon => normalizePolygonCoordinates(polygon, state, context));
    });
}

function normalizeByType(type, coordinates, state, context) {
    switch (type) {
        case 'Point':
            return normalizePosition(coordinates, state, context);
        case 'MultiPoint':
            return normalizeMultiPoint(coordinates, state, context);
        case 'LineString':
            return normalizeLineStringCoordinates(coordinates, state, context);
        case 'MultiLineString':
            return normalizeMultiLineString(coordinates, state, context);
        case 'Polygon':
            return normalizePolygonCoordinates(coordinates, state, context);
        case 'MultiPolygon':
            return normalizeMultiPolygon(coordinates, state, context);
        default:
            fail(context);
    }
}

function normalizeGeometry(rawGeometry, context = {}) {
    try {
        if (!isPlainObject(rawGeometry) || !SUPPORTED_TYPES.has(rawGeometry.type)) fail(context);
        const state = { ancestors: new WeakSet(), positionCount: 0 };
        const coordinates = normalizeByType(rawGeometry.type, rawGeometry.coordinates, state, context);
        if (!state.positionCount) fail(context);
        return { type: rawGeometry.type, coordinates };
    } catch (error) {
        if (error instanceof GeometryNormalizationError) throw error;
        throw normalizationError(context);
    }
}

function normalizeRouteGeometryWithMeta(rawGeometry, context = {}) {
    try {
        const routeContext = isPlainObject(context) ? context : {};
        const rawCoordinates = Array.isArray(rawGeometry)
            ? rawGeometry
            : isPlainObject(rawGeometry) && rawGeometry.type === 'LineString'
                ? rawGeometry.coordinates
                : null;
        if (!Array.isArray(rawCoordinates)) fail(routeContext);

        const start = routeReferencePosition(routeContext.start, routeContext);
        const end = routeReferencePosition(routeContext.end, routeContext);
        const extent = routeExtent(routeContext.extent, routeContext);
        const canonical = routeAxisCandidate(rawCoordinates, false, start, end, extent);
        const swapped = routeAxisCandidate(rawCoordinates, true, start, end, extent);
        let selected = canonical;
        let axisSwapped = false;
        if (swapped && routeCandidateIsBetter(swapped, selected, Boolean(extent), Boolean(start || end))) {
            selected = swapped;
            axisSwapped = true;
        }
        if (!selected) fail(routeContext);

        const coordinates = selected.coordinates.map(position => [...position]);
        const reversed = selected.endpointScore.reverse < selected.endpointScore.forward;
        if (reversed) coordinates.reverse();
        return {
            geometry: { type: 'LineString', coordinates },
            reversed,
            axisSwapped
        };
    } catch (error) {
        if (error instanceof GeometryNormalizationError) throw error;
        throw normalizationError(isPlainObject(context) ? context : {});
    }
}

function normalizeRouteGeometry(rawGeometry, context = {}) {
    return normalizeRouteGeometryWithMeta(rawGeometry, context).geometry;
}

module.exports = normalizeGeometry;
module.exports.normalizeGeometry = normalizeGeometry;
module.exports.normalizeGeoJsonGeometry = normalizeGeometry;
module.exports.normalizeGeoJSONGeometry = normalizeGeometry;
module.exports.normalizeRouteGeometry = normalizeRouteGeometry;
module.exports.normalizeRouteGeometryWithMeta = normalizeRouteGeometryWithMeta;
module.exports.SUPPORTED_TYPES = SUPPORTED_TYPES;
