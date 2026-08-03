'use strict';

const path = require('node:path');
const SuperMapGateway = require('./gateway');
const createHttpClient = require('./httpClient');
const { IServerUnavailableError } = require('./errors');
const { loadManifestSafe } = require('./manifest');
const { DEFAULT_MAX_RESPONSE_BYTES } = createHttpClient;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function booleanValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return fallback;
}

function environmentBoolean(env, key, fallback, logger) {
    const value = env[key];
    const normalized = value === undefined || value === null
        ? ''
        : String(value).trim().toLowerCase();
    if (normalized && !TRUE_VALUES.has(normalized) && !FALSE_VALUES.has(normalized)) {
        logger.warn?.(`[GeoSync] [GIS] ${key} has an invalid boolean value; using the default`, {
            fallback
        });
    }
    return booleanValue(value, fallback);
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function manifestPathOf(value, cwd) {
    const configured = String(value || './config/supermap-manifest.json').trim();
    return path.resolve(cwd, configured);
}

function unavailableClient(error) {
    return {
        async request(request = {}) {
            throw new IServerUnavailableError('iServer 客户端未启用', {
                operation: request.operation,
                requestId: request.requestId,
                category: 'configuration',
                retryable: false,
                transportCode: error?.code
            });
        }
    };
}

function createSuperMapGateway(options = {}) {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const logger = options.logger || console;
    const manifestPath = options.manifestPath || manifestPathOf(env.SUPERMAP_MANIFEST_PATH, cwd);
    let enabled = options.enabled === undefined
        ? environmentBoolean(env, 'SUPERMAP_ENABLED', true, logger)
        : Boolean(options.enabled);
    let httpClient = options.httpClient;
    let clientConfigurationError = null;

    if (!httpClient && enabled) {
        try {
            httpClient = createHttpClient({
                axios: options.axios,
                sleep: options.sleep,
                baseURL: env.ISERVER_BASE || 'http://127.0.0.1:8090',
                username: env.ISERVER_USERNAME || '',
                password: env.ISERVER_PASSWORD || '',
                timeoutMs: positiveNumber(env.SUPERMAP_TIMEOUT_MS, 5000),
                maxResponseBytes: positiveNumber(
                    options.maxResponseBytes ?? env.SUPERMAP_MAX_RESPONSE_BYTES,
                    DEFAULT_MAX_RESPONSE_BYTES
                ),
                maxRetries: env.SUPERMAP_MAX_RETRIES === undefined ? 1 : env.SUPERMAP_MAX_RETRIES,
                retryDelayMs: options.retryDelayMs || 0
            });
        } catch (error) {
            enabled = false;
            clientConfigurationError = error;
            logger.error?.('[GeoSync] [GIS] HTTP client configuration is invalid; GIS is offline');
        }
    }

    return new SuperMapGateway({
        enabled,
        manifestPath,
        manifestLoader: options.manifestLoader || loadManifestSafe,
        httpClient: httpClient || unavailableClient(clientConfigurationError),
        clock: options.clock,
        requestIdFactory: options.requestIdFactory,
        logger,
        healthTimeoutMs: positiveNumber(env.SUPERMAP_HEALTH_TIMEOUT_MS, 2000),
        queryTimeoutMs: positiveNumber(env.SUPERMAP_TIMEOUT_MS, 5000),
        routeTimeoutMs: positiveNumber(options.routeTimeoutMs ?? env.SUPERMAP_TIMEOUT_MS, 5000),
        statusCacheMs: positiveNumber(options.statusCacheMs, 5000),
        manifestFailureTtlMs: nonNegativeNumber(
            options.manifestFailureTtlMs ?? env.SUPERMAP_MANIFEST_RETRY_MS,
            30_000
        ),
        routeCache: options.routeCache,
        routeCacheStore: options.routeCacheStore,
        routeAliasStore: options.routeAliasStore,
        routeCacheClock: options.routeCacheClock,
        routeCacheTtlMs: positiveNumber(
            options.routeCacheTtlMs,
            positiveNumber(env.SUPERMAP_CACHE_TTL_S, 60) * 1000
        ),
        localPathSource: options.localPathSource || options.localRouteSource,
        fallbackEnabled: options.fallbackEnabled === undefined
            ? environmentBoolean(env, 'SUPERMAP_FALLBACK_ENABLED', true, logger)
            : Boolean(options.fallbackEnabled),
        maxSnapDistanceM: positiveNumber(options.maxSnapDistanceM, 200),
        boundsBufferDeg: nonNegativeNumber(options.boundsBufferDeg, 0)
    });
}

module.exports = {
    createSuperMapGateway,
    booleanValue,
    environmentBoolean,
    positiveNumber,
    nonNegativeNumber,
    manifestPathOf,
    DEFAULT_MAX_RESPONSE_BYTES
};
