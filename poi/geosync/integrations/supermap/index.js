'use strict';

const path = require('node:path');
const SuperMapGateway = require('./gateway');
const createHttpClient = require('./httpClient');
const { IServerUnavailableError } = require('./errors');
const { loadManifestSafe } = require('./manifest');

function booleanValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).trim().toLowerCase() === 'true';
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
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
        ? booleanValue(env.SUPERMAP_ENABLED, true)
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
        statusCacheMs: positiveNumber(options.statusCacheMs, 5000)
    });
}

module.exports = {
    createSuperMapGateway,
    booleanValue,
    positiveNumber,
    manifestPathOf
};
