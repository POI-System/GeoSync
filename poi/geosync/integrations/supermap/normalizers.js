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

module.exports = normalizeGeometry;
module.exports.normalizeGeometry = normalizeGeometry;
module.exports.normalizeGeoJsonGeometry = normalizeGeometry;
module.exports.normalizeGeoJSONGeometry = normalizeGeometry;
module.exports.SUPPORTED_TYPES = SUPPORTED_TYPES;
