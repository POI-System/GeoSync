'use strict';

const MODES = new Set(['normal', 'accessible', 'shade']);
const DEFAULT_TTL_MS = 60_000;
const SENSITIVE_REASON = /(?:authorization|credential|password|passwd|secret|token|api[-_]?key|username)/i;

function requireObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${field} must be an object`);
    }
    return value;
}

function nonEmptyString(value, field) {
    if (value === undefined || value === null) throw new TypeError(`${field} is required`);
    const text = String(value).trim();
    if (!text) throw new TypeError(`${field} must be a non-empty string`);
    if (text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new TypeError(`${field} contains invalid characters`);
    }
    return text;
}

function normalizeMode(value) {
    const mode = nonEmptyString(value, 'mode').toLowerCase();
    if (!MODES.has(mode)) throw new TypeError('mode must be normal, accessible, or shade');
    return mode;
}

function nodeIdOf(input, side) {
    const capitalized = side[0].toUpperCase() + side.slice(1);
    const value = input[`${side}NodeId`]
        ?? input[`snapped${capitalized}NodeId`]
        ?? input[`${side}SnapNodeId`]
        ?? input.snap?.[`${side}NodeId`];
    return nonEmptyString(value, `${side}NodeId`);
}

function barrierEdgeIdsOf(input) {
    const rawBarriers = input.barrierEdgeIds ?? input.barriers ?? [];
    if (!Array.isArray(rawBarriers)) throw new TypeError('barriers must be an array');

    const unique = new Set();
    for (let index = 0; index < rawBarriers.length; index++) {
        const barrier = rawBarriers[index];
        const edgeId = barrier && typeof barrier === 'object' && !Array.isArray(barrier)
            ? barrier.edgeId
            : barrier;
        unique.add(nonEmptyString(edgeId, `barriers[${index}].edgeId`));
    }
    return [...unique].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function roundSix(value) {
    const rounded = Math.round((value + Number.EPSILON) * 1e6) / 1e6;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function coordinateOf(value, field) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
        throw new TypeError(`${field} must be a finite [lng, lat] coordinate`);
    }
    const [lng, lat] = value;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new TypeError(`${field} must be within EPSG:4326 ranges`);
    }
    return [roundSix(lng), roundSix(lat)];
}

function identityParts(input) {
    requireObject(input, 'route cache identity');
    return {
        dataVersion: nonEmptyString(input.dataVersion, 'dataVersion'),
        mode: normalizeMode(input.mode),
        barrierEdgeIds: barrierEdgeIdsOf(input)
    };
}

function stableKey(prefix, parts) {
    return `${prefix}:${JSON.stringify(parts)}`;
}

function buildRouteCacheKey(input) {
    const identity = identityParts(input);
    return stableKey('route', {
        version: 1,
        dataVersion: identity.dataVersion,
        mode: identity.mode,
        startNodeId: nodeIdOf(input, 'start'),
        endNodeId: nodeIdOf(input, 'end'),
        barrierEdgeIds: identity.barrierEdgeIds
    });
}

function buildRouteRequestSignature(input) {
    const identity = identityParts(input);
    return stableKey('route-request', {
        version: 1,
        dataVersion: identity.dataVersion,
        mode: identity.mode,
        start: coordinateOf(input.start, 'start'),
        end: coordinateOf(input.end, 'end'),
        barrierEdgeIds: identity.barrierEdgeIds
    });
}

function assertMapLike(store, field) {
    if (!store || ['get', 'set', 'delete', 'clear', 'entries'].some(method => typeof store[method] !== 'function')) {
        throw new TypeError(`${field} must be Map-like`);
    }
    return store;
}

function ttlValue(value) {
    const ttlMs = value === undefined ? DEFAULT_TTL_MS : Number(value);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive finite number');
    return ttlMs;
}

function clone(value) {
    return structuredClone(value);
}

function diagnosticReason(value) {
    if (typeof value !== 'string') return 'manual';
    const reason = value.trim();
    if (!reason) return 'manual';
    if (SENSITIVE_REASON.test(reason)) return 'redacted';
    const normalized = reason.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64);
    return normalized || 'manual';
}

class RouteCache {
    constructor(options = {}) {
        if (options.clock !== undefined && typeof options.clock !== 'function') {
            throw new TypeError('clock must be a function');
        }
        this.store = assertMapLike(options.store || options.routeStore || new Map(), 'store');
        this.aliasStore = assertMapLike(
            options.aliasStore || options.requestAliasStore || new Map(),
            'aliasStore'
        );
        this.clock = options.clock || Date.now;
        this.ttlMs = ttlValue(options.ttlMs);
        this.lastInvalidationReason = null;
        this.lastInvalidatedAt = null;
    }

    _now() {
        const value = this.clock();
        const timestamp = value instanceof Date ? value.getTime() : Number(value);
        if (!Number.isFinite(timestamp)) throw new TypeError('clock must return a Date or finite timestamp');
        return timestamp;
    }

    _expired(entry, now) {
        return !entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now;
    }

    _pruneExpired(now = this._now()) {
        for (const [key, entry] of this.store.entries()) {
            if (this._expired(entry, now)) this.store.delete(key);
        }
        for (const [signature, alias] of this.aliasStore.entries()) {
            if (this._expired(alias, now) || !this.store.get(alias.canonicalKey)) {
                this.aliasStore.delete(signature);
            }
        }
    }

    set(request, value) {
        const canonicalKey = buildRouteCacheKey(request);
        const requestSignature = buildRouteRequestSignature(request);
        const now = this._now();
        const expiresAt = now + this.ttlMs;

        this.store.set(canonicalKey, {
            value: clone(value),
            createdAt: now,
            expiresAt
        });
        this.aliasStore.set(requestSignature, { canonicalKey, expiresAt });
        return canonicalKey;
    }

    get(requestOrSignature) {
        const requestSignature = typeof requestOrSignature === 'string'
            ? requestOrSignature
            : buildRouteRequestSignature(requestOrSignature);
        const now = this._now();
        const alias = this.aliasStore.get(requestSignature);
        if (this._expired(alias, now)) {
            if (alias) this.aliasStore.delete(requestSignature);
            return undefined;
        }

        const entry = this.store.get(alias.canonicalKey);
        if (this._expired(entry, now)) {
            this.aliasStore.delete(requestSignature);
            if (entry) this.store.delete(alias.canonicalKey);
            return undefined;
        }
        return clone(entry.value);
    }

    getByCanonicalKey(keyOrIdentity) {
        const canonicalKey = typeof keyOrIdentity === 'string'
            ? keyOrIdentity
            : buildRouteCacheKey(keyOrIdentity);
        const now = this._now();
        const entry = this.store.get(canonicalKey);
        if (this._expired(entry, now)) {
            if (entry) this.store.delete(canonicalKey);
            return undefined;
        }
        return clone(entry.value);
    }

    clear(reason = 'manual') {
        const now = this._now();
        this._pruneExpired(now);
        const cleared = this.store.size;
        this.store.clear();
        this.aliasStore.clear();
        this.lastInvalidationReason = diagnosticReason(reason);
        this.lastInvalidatedAt = new Date(now).toISOString();
        return cleared;
    }

    get size() {
        this._pruneExpired();
        return Number(this.store.size) || 0;
    }

    getDiagnostics() {
        this._pruneExpired();
        return {
            size: Number(this.store.size) || 0,
            aliasCount: Number(this.aliasStore.size) || 0,
            ttlMs: this.ttlMs,
            lastInvalidationReason: this.lastInvalidationReason,
            lastInvalidatedAt: this.lastInvalidatedAt
        };
    }

    get diagnostics() {
        return this.getDiagnostics();
    }
}

module.exports = RouteCache;
module.exports.RouteCache = RouteCache;
module.exports.buildRouteCacheKey = buildRouteCacheKey;
module.exports.buildRouteRequestSignature = buildRouteRequestSignature;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
