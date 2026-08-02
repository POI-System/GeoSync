'use strict';

const ROUTE_MODES = new Set(['normal', 'accessible', 'shade']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCoordinate(value) {
    return Array.isArray(value)
        && value.length === 2
        && value.every(Number.isFinite)
        && value[0] >= -180
        && value[0] <= 180
        && value[1] >= -90
        && value[1] <= 90;
}

function coordinatesOf(value, name) {
    const coordinates = Array.isArray(value)
        ? value
        : value?.geo?.coordinates
            || value?.coordinates
            || (value?.location?.lng !== undefined && value?.location?.lat !== undefined
                ? [value.location.lng, value.location.lat]
                : value?.lng !== undefined && value?.lat !== undefined
                    ? [value.lng, value.lat]
                    : null);
    if (!validCoordinate(coordinates)) {
        throw new TypeError(`${name} must provide a finite WGS84 [lng, lat] coordinate`);
    }
    return [coordinates[0], coordinates[1]];
}

function nodeIdOf(value) {
    if (value?.gateNodeId === undefined || value?.gateNodeId === null) return undefined;
    const nodeId = String(value.gateNodeId).trim();
    return nodeId || undefined;
}

function routeMode(value) {
    const mode = value === undefined || value === null || value === ''
        ? 'normal'
        : String(value).trim().toLowerCase();
    const normalized = mode === 'standard' ? 'normal' : mode;
    if (!ROUTE_MODES.has(normalized)) {
        throw new TypeError('route mode must be standard, normal, accessible, or shade');
    }
    return normalized;
}

function callContext(value) {
    if (value === undefined || value === null) return {};
    if (Array.isArray(value)) return { barriers: value };
    if (!isObject(value)) throw new TypeError('route call context must be an object');
    return value;
}

function barriersOf(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TypeError('barriers must be an array');
    return value;
}

function createLocalPathSource(walkGraph) {
    if (!walkGraph || typeof walkGraph.findLocalPath !== 'function') {
        throw new TypeError('createLocalPathSource requires walkGraph.findLocalPath');
    }

    return async function localPathSource(input) {
        if (!isObject(input)) throw new TypeError('local path input must be an object');
        coordinatesOf(input.start, 'start');
        coordinatesOf(input.end, 'end');
        routeMode(input.mode);
        barriersOf(input.barriers);
        return walkGraph.findLocalPath(input);
    };
}

function createRouteBetween(gateway, options = {}) {
    if (
        !gateway
        || typeof gateway.findPath !== 'function'
        || typeof gateway.findPathWithBarriers !== 'function'
    ) {
        throw new TypeError('createRouteBetween requires Gateway path methods');
    }
    if (!isObject(options)) throw new TypeError('route adapter options must be an object');
    const scenicId = String(options.scenicId || '').trim();
    if (!scenicId) throw new TypeError('createRouteBetween requires scenicId');

    return async function routeBetween(from, to, mode = 'normal', rawContext = {}) {
        const context = callContext(rawContext);
        const barriers = barriersOf(context.barriers);
        const input = {
            start: coordinatesOf(from, 'route start'),
            end: coordinatesOf(to, 'route end'),
            mode: routeMode(mode),
            scenicId,
            barriers
        };
        const startNodeId = nodeIdOf(from);
        const endNodeId = nodeIdOf(to);
        if (startNodeId) input.startNodeId = startNodeId;
        if (endNodeId) input.endNodeId = endNodeId;
        if (context.requestId !== undefined && context.requestId !== null) {
            input.requestId = context.requestId;
        }

        return barriers.length > 0
            ? gateway.findPathWithBarriers(input)
            : gateway.findPath(input);
    };
}

module.exports = {
    createLocalPathSource,
    createRouteBetween
};
