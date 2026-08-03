'use strict';

const MODES = new Set(['normal', 'accessible', 'shade']);
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;
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

function maxEntriesValue(value) {
    const maxEntries = value === undefined ? DEFAULT_MAX_ENTRIES : Number(value);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
        throw new TypeError('maxEntries must be a positive safe integer');
    }
    return maxEntries;
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
        this.maxEntries = maxEntriesValue(options.maxEntries);
        this.expiryHeap = [];
        this.expirySequence = 0;
        this.aliasGeneration = 0;
        this.lastInvalidationReason = null;
        this.lastInvalidatedAt = null;
        this._indexExistingAliases();
        this._evictToLimit();
    }

    _indexExistingAliases() {
        const aliasesByCanonicalKey = new Map();
        for (const [signature, existing] of this.aliasStore.entries()) {
            if (!existing || typeof existing !== 'object' || Array.isArray(existing)) continue;
            const canonical = this.store.get(existing.canonicalKey);
            const alias = {
                ...existing,
                ...(Object.prototype.hasOwnProperty.call(existing, 'value')
                    ? {}
                    : canonical && Object.prototype.hasOwnProperty.call(canonical, 'value')
                        ? { value: canonical.value }
                        : {}),
                generation: ++this.aliasGeneration
            };
            this.aliasStore.set(signature, alias);
            this._pushExpiry(signature, alias);
            if (!aliasesByCanonicalKey.has(alias.canonicalKey)) {
                aliasesByCanonicalKey.set(alias.canonicalKey, new Set());
            }
            aliasesByCanonicalKey.get(alias.canonicalKey).add(signature);
        }

        for (const [canonicalKey, aliases] of aliasesByCanonicalKey.entries()) {
            const entry = this.store.get(canonicalKey);
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            let latestSignature = null;
            for (const signature of aliases) latestSignature = signature;
            this.store.set(canonicalKey, {
                ...entry,
                aliases,
                latestSignature
            });
        }
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

    _heapBefore(left, right) {
        return left.expiresAt < right.expiresAt
            || (left.expiresAt === right.expiresAt && left.sequence < right.sequence);
    }

    _pushExpiry(signature, alias) {
        if (!Number.isFinite(alias?.expiresAt)) return;
        const node = {
            signature,
            expiresAt: alias.expiresAt,
            generation: alias.generation,
            sequence: ++this.expirySequence
        };
        this.expiryHeap.push(node);
        let index = this.expiryHeap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (!this._heapBefore(node, this.expiryHeap[parent])) break;
            this.expiryHeap[index] = this.expiryHeap[parent];
            index = parent;
        }
        this.expiryHeap[index] = node;
    }

    _popExpiry() {
        if (!this.expiryHeap.length) return null;
        const first = this.expiryHeap[0];
        const last = this.expiryHeap.pop();
        if (!this.expiryHeap.length) return first;

        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            if (left >= this.expiryHeap.length) break;
            let child = left;
            if (right < this.expiryHeap.length
                && this._heapBefore(this.expiryHeap[right], this.expiryHeap[left])) {
                child = right;
            }
            if (!this._heapBefore(this.expiryHeap[child], last)) break;
            this.expiryHeap[index] = this.expiryHeap[child];
            index = child;
        }
        this.expiryHeap[index] = last;
        return first;
    }

    _latestSignature(aliases) {
        let latest = null;
        for (const signature of aliases) latest = signature;
        return latest;
    }

    _removeAlias(signature, providedAlias) {
        const alias = providedAlias || this.aliasStore.get(signature);
        if (!alias) return false;
        this.aliasStore.delete(signature);

        const entry = this.store.get(alias.canonicalKey);
        if (!entry) return true;
        if (!(entry.aliases instanceof Set)) {
            this.store.delete(alias.canonicalKey);
            return true;
        }

        entry.aliases.delete(signature);
        if (!entry.aliases.size) {
            this.store.delete(alias.canonicalKey);
            return true;
        }

        if (entry.latestSignature === signature || !entry.aliases.has(entry.latestSignature)) {
            entry.latestSignature = this._latestSignature(entry.aliases);
            const latestAlias = this.aliasStore.get(entry.latestSignature);
            if (latestAlias && Object.prototype.hasOwnProperty.call(latestAlias, 'value')) {
                entry.value = latestAlias.value;
            }
        }
        this.store.set(alias.canonicalKey, entry);
        return true;
    }

    _touchAlias(signature, alias) {
        this.aliasStore.delete(signature);
        this.aliasStore.set(signature, alias);
    }

    _pruneExpired(now = this._now()) {
        while (this.expiryHeap.length && this.expiryHeap[0].expiresAt <= now) {
            const due = this._popExpiry();
            const alias = this.aliasStore.get(due.signature);
            if (!alias || alias.generation !== due.generation) continue;
            if (this._expired(alias, now)) this._removeAlias(due.signature, alias);
        }
    }

    _evictToLimit() {
        while ((Number(this.aliasStore.size) || 0) > this.maxEntries) {
            const oldest = this.aliasStore.entries().next();
            if (oldest.done) break;
            this._removeAlias(oldest.value[0], oldest.value[1]);
        }
    }

    _compactExpiryHeap() {
        if (this.expiryHeap.length <= Math.max(64, this.maxEntries * 2)) return;
        this.expiryHeap = [];
        for (const [signature, alias] of this.aliasStore.entries()) {
            this._pushExpiry(signature, alias);
        }
    }

    set(request, value) {
        const canonicalKey = buildRouteCacheKey(request);
        const requestSignature = buildRouteRequestSignature(request);
        const now = this._now();
        const expiresAt = now + this.ttlMs;
        this._pruneExpired(now);

        const existingAlias = this.aliasStore.get(requestSignature);
        if (existingAlias) this._removeAlias(requestSignature, existingAlias);

        const cachedValue = clone(value);
        const existingEntry = this.store.get(canonicalKey);
        const aliases = existingEntry?.aliases instanceof Set
            ? existingEntry.aliases
            : new Set();
        aliases.delete(requestSignature);
        aliases.add(requestSignature);
        const alias = {
            canonicalKey,
            value: cachedValue,
            createdAt: now,
            expiresAt,
            generation: ++this.aliasGeneration
        };

        this.store.set(canonicalKey, {
            value: cachedValue,
            createdAt: existingEntry?.createdAt ?? now,
            expiresAt: Math.max(Number(existingEntry?.expiresAt) || 0, expiresAt),
            aliases,
            latestSignature: requestSignature
        });
        this.aliasStore.set(requestSignature, alias);
        this._pushExpiry(requestSignature, alias);
        this._evictToLimit();
        this._compactExpiryHeap();
        return canonicalKey;
    }

    get(requestOrSignature) {
        const requestSignature = typeof requestOrSignature === 'string'
            ? requestOrSignature
            : buildRouteRequestSignature(requestOrSignature);
        const now = this._now();
        const alias = this.aliasStore.get(requestSignature);
        if (this._expired(alias, now)) {
            if (alias) this._removeAlias(requestSignature, alias);
            return undefined;
        }

        const entry = this.store.get(alias.canonicalKey);
        if (!entry || (!(entry.aliases instanceof Set) && this._expired(entry, now))) {
            this._removeAlias(requestSignature, alias);
            return undefined;
        }
        this._touchAlias(requestSignature, alias);
        const cachedValue = Object.prototype.hasOwnProperty.call(alias, 'value')
            ? alias.value
            : entry.value;
        return clone(cachedValue);
    }

    getByCanonicalKey(keyOrIdentity) {
        const canonicalKey = typeof keyOrIdentity === 'string'
            ? keyOrIdentity
            : buildRouteCacheKey(keyOrIdentity);
        const now = this._now();
        this._pruneExpired(now);
        const entry = this.store.get(canonicalKey);
        if (!entry) return undefined;
        if (entry.aliases instanceof Set) {
            while (entry.aliases.size) {
                const requestSignature = entry.aliases.has(entry.latestSignature)
                    ? entry.latestSignature
                    : this._latestSignature(entry.aliases);
                const alias = this.aliasStore.get(requestSignature);
                if (alias && !this._expired(alias, now)) {
                    this._touchAlias(requestSignature, alias);
                    return clone(Object.prototype.hasOwnProperty.call(alias, 'value') ? alias.value : entry.value);
                }
                if (alias) {
                    this._removeAlias(requestSignature, alias);
                } else {
                    entry.aliases.delete(requestSignature);
                    entry.latestSignature = this._latestSignature(entry.aliases);
                }
            }
            this.store.delete(canonicalKey);
            return undefined;
        }
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
        this.expiryHeap = [];
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
module.exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
