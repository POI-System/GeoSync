'use strict';

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|username)/i;
const MAX_METADATA_DEPTH = 4;

class MissingMockFixtureError extends Error {
    constructor(operation) {
        super(`No mock HTTP fixture registered for operation "${operation}"`);
        this.name = 'MissingMockFixtureError';
        this.code = 'SUPERMAP_MOCK_FIXTURE_MISSING';
        this.operation = operation;
    }
}

function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return 'buffer';
    return typeof value;
}

function summarizeValue(value, depth = 0, seen = new WeakSet()) {
    const type = valueType(value);

    if (type === 'string') return { type, length: value.length };
    if (type === 'buffer') return { type, bytes: value.length };
    if (type !== 'array' && type !== 'object') return { type };

    if (seen.has(value)) return { type, circular: true };
    seen.add(value);

    if (type === 'array') {
        const itemTypes = [...new Set(value.map(valueType))].sort();
        return { type, count: value.length, itemTypes };
    }

    const keys = Object.keys(value).sort();
    if (depth >= MAX_METADATA_DEPTH) return { type, count: keys.length, truncated: true };

    const fields = {};
    let redactedCount = 0;
    for (const key of keys) {
        if (SENSITIVE_KEY.test(key)) {
            fields[key] = { type: 'redacted' };
            redactedCount++;
            continue;
        }
        fields[key] = summarizeValue(value[key], depth + 1, seen);
    }

    const metadata = { type, count: keys.length, fields };
    if (redactedCount) metadata.redactedCount = redactedCount;
    return metadata;
}

function safeIdentifier(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value).slice(0, 128);
    }
    return valueType(value);
}

function normalizeLatency(value) {
    const latency = Number(value);
    if (!Number.isFinite(latency) || latency < 0) {
        throw new TypeError('Mock HTTP latency must be a non-negative finite number');
    }
    return latency;
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class MockHttpClient {
    constructor({ fixtures = {}, latencyMs = 0, sleep = defaultSleep } = {}) {
        if (!(fixtures instanceof Map) && (fixtures === null || typeof fixtures !== 'object')) {
            throw new TypeError('Mock HTTP fixtures must be an object or Map');
        }
        if (typeof sleep !== 'function') throw new TypeError('Mock HTTP sleep must be a function');

        this.fixtures = fixtures instanceof Map
            ? new Map(fixtures)
            : Object.assign(Object.create(null), fixtures);
        this.latencyMs = latencyMs;
        this.sleep = sleep;
        this.history = [];
    }

    setFixture(operation, fixture) {
        const key = this._operationKey(operation);
        if (this.fixtures instanceof Map) this.fixtures.set(key, fixture);
        else this.fixtures[key] = fixture;
        return this;
    }

    clearHistory() {
        this.history.length = 0;
    }

    async request(request) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new TypeError('Mock HTTP request must be an object');
        }

        const operation = this._operationKey(request.operation);
        const historyEntry = {
            operation,
            method: request.method ? String(request.method).toUpperCase() : null,
            requestId: safeIdentifier(request.requestId),
            payloadMetadata: {
                data: summarizeValue(request.data),
                params: summarizeValue(request.params)
            }
        };
        this.history.push(historyEntry);

        const latency = this._latencyFor(request);
        if (latency > 0) await this.sleep(latency);

        if (!this._hasFixture(operation)) throw new MissingMockFixtureError(operation);
        const fixture = this._getFixture(operation);
        if (fixture instanceof Error) throw fixture;

        const result = typeof fixture === 'function' ? await fixture(request) : fixture;
        if (result instanceof Error) throw result;
        return result;
    }

    _operationKey(operation) {
        if (typeof operation !== 'string' || !operation.trim()) {
            throw new TypeError('Mock HTTP request operation must be a non-empty string');
        }
        return operation.trim();
    }

    _hasFixture(operation) {
        return this.fixtures instanceof Map
            ? this.fixtures.has(operation)
            : Object.prototype.hasOwnProperty.call(this.fixtures, operation);
    }

    _getFixture(operation) {
        return this.fixtures instanceof Map
            ? this.fixtures.get(operation)
            : this.fixtures[operation];
    }

    _latencyFor(request) {
        if (typeof this.latencyMs === 'function') {
            return normalizeLatency(this.latencyMs(request));
        }
        if (this.latencyMs && typeof this.latencyMs === 'object') {
            const value = Object.prototype.hasOwnProperty.call(this.latencyMs, request.operation)
                ? this.latencyMs[request.operation]
                : this.latencyMs.default || 0;
            return normalizeLatency(value);
        }
        return normalizeLatency(this.latencyMs);
    }
}

module.exports = MockHttpClient;
module.exports.MockHttpClient = MockHttpClient;
module.exports.MissingMockFixtureError = MissingMockFixtureError;
module.exports.summarizeValue = summarizeValue;
