'use strict';

const { performance } = require('node:perf_hooks');
const {
    ContractMismatchError,
    IServerTimeoutError,
    toSuperMapError
} = require('./errors');

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultNow() {
    return performance.now();
}

function isLoopbackHostname(value) {
    const hostname = String(value || '').toLowerCase();
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname === '[::1]';
}

function normalizeBaseURL(value, hasCredentials = false) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError('SuperMap HTTP baseURL must be a non-empty string');
    }

    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        throw new TypeError('SuperMap HTTP baseURL must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new TypeError('SuperMap HTTP baseURL must use HTTP or HTTPS');
    }
    if (parsed.username || parsed.password) {
        throw new TypeError('SuperMap HTTP credentials must not be embedded in baseURL');
    }
    if (hasCredentials && parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
        throw new TypeError('SuperMap HTTP Basic auth requires HTTPS for non-loopback hosts');
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

function normalizePath(value, context) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ContractMismatchError('iServer 请求路径无效', {
            ...context,
            category: 'parameter',
            retryable: false
        });
    }
    const path = value.trim();
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
        throw new ContractMismatchError('iServer 请求路径必须相对于已配置的服务地址', {
            ...context,
            category: 'contract',
            retryable: false
        });
    }
    return path.startsWith('/') ? path : `/${path}`;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requestIdValue(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .trim()
        .replace(/[^A-Za-z0-9._:-]/g, '_')
        .slice(0, 128);
}

function retryCount(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(number, 1);
}

class SuperMapHttpClient {
    constructor(options = {}) {
        const axios = options.axios || require('axios');
        if (!axios || typeof axios.request !== 'function') {
            throw new TypeError('SuperMap HTTP client requires an Axios-compatible request function');
        }
        if (options.sleep !== undefined && typeof options.sleep !== 'function') {
            throw new TypeError('SuperMap HTTP sleep must be a function');
        }
        if (options.now !== undefined && typeof options.now !== 'function') {
            throw new TypeError('SuperMap HTTP now must be a function');
        }

        this.axios = axios;
        this.username = String(options.username || '');
        this.password = String(options.password || '');
        this.baseURL = normalizeBaseURL(
            options.baseURL ?? options.baseUrl,
            Boolean(this.username || this.password)
        );
        this.timeoutMs = positiveNumber(options.timeoutMs, 5000);
        this.maxRetries = retryCount(options.maxRetries === undefined ? 1 : options.maxRetries);
        this.retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
        this.sleep = options.sleep || defaultSleep;
        this.now = options.now || defaultNow;
    }

    async request(request = {}) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new TypeError('SuperMap HTTP request must be an object');
        }

        const operation = typeof request.operation === 'string' && request.operation.trim()
            ? request.operation.trim()
            : 'request';
        const requestId = requestIdValue(request.requestId);
        const context = { operation, requestId };
        const path = normalizePath(request.path, context);
        const totalTimeoutMs = Math.max(1, Math.floor(positiveNumber(request.timeoutMs, this.timeoutMs)));
        const deadline = this._now() + totalTimeoutMs;

        for (let attempt = 0; ; attempt++) {
            const timeout = attempt === 0
                ? totalTimeoutMs
                : this._remainingTimeout(deadline);
            if (timeout <= 0) throw this._budgetTimeout(context);

            try {
                return await this.axios.request(this._axiosConfig({
                    method: request.method,
                    path,
                    requestId,
                    timeout,
                    data: request.data,
                    params: request.params
                }));
            } catch (error) {
                const mapped = toSuperMapError(error, context);
                if (!mapped.retryable || attempt >= this.maxRetries) throw mapped;

                const remainingBeforeDelay = this._remainingTimeout(deadline);
                if (remainingBeforeDelay <= 0 || this.retryDelayMs >= remainingBeforeDelay) {
                    throw this._budgetTimeout(context);
                }
                if (this.retryDelayMs > 0) await this.sleep(this.retryDelayMs);
            }
        }
    }

    _now() {
        const value = Number(this.now());
        if (!Number.isFinite(value)) {
            throw new TypeError('SuperMap HTTP now must return a finite monotonic value');
        }
        return value;
    }

    _remainingTimeout(deadline) {
        return Math.max(0, Math.floor(deadline - this._now()));
    }

    _budgetTimeout(context) {
        return new IServerTimeoutError('iServer 请求总超时预算已耗尽', {
            ...context,
            category: 'timeout-budget',
            retryable: false
        });
    }

    _axiosConfig({ method, path, requestId, timeout, data, params }) {
        const config = {
            baseURL: this.baseURL,
            url: path,
            method: String(method || 'GET').toUpperCase(),
            timeout,
            headers: {},
            data,
            params
        };
        if (requestId) config.headers['X-Request-Id'] = requestId;
        if (this.username || this.password) {
            config.auth = {
                username: this.username,
                password: this.password
            };
        }
        return config;
    }
}

function createHttpClient(options) {
    return new SuperMapHttpClient(options);
}

module.exports = createHttpClient;
module.exports.createHttpClient = createHttpClient;
module.exports.SuperMapHttpClient = SuperMapHttpClient;
module.exports.defaultSleep = defaultSleep;
module.exports.defaultNow = defaultNow;
