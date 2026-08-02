'use strict';

const crypto = require('node:crypto');
const {
    ContractMismatchError,
    IServerUnavailableError,
    toSuperMapError
} = require('./errors');
const { loadManifestSafe } = require('./manifest');
const { normalizeGeoJsonGeometry } = require('./normalizers');

const STATUS_VALUES = new Set(['online', 'degraded', 'offline']);
const REQUIRED_STATUS_SERVICES = ['map', 'data', 'network'];
const OPTIONAL_STATUS_SERVICES = ['terrain', 'scene'];
const MAX_FILTER_CLAUSES = 50;
const MAX_FILTER_LENGTH = 4096;
const FILTER_OPERATORS = Object.freeze({
    eq: '=',
    ne: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    in: 'IN'
});

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asDate(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function joinPaths(basePath, operationPath) {
    const left = String(basePath || '').replace(/\/+$/, '');
    const right = String(operationPath || '').replace(/^\/+/, '');
    return `${left}/${right}`;
}

function requestIdOf(value, factory) {
    const explicit = value === undefined || value === null ? '' : String(value).trim();
    const generated = String(explicit || factory()).trim();
    return generated.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

function contractError(message, context = {}) {
    return new ContractMismatchError(message, {
        operation: context.operation,
        requestId: context.requestId,
        category: context.category || 'parameter',
        retryable: false
    });
}

function filterLiteral(value, context) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw contractError('筛选值必须是有限数字', context);
        return String(value);
    }
    if (typeof value === 'string') {
        if (value.length > 256) throw contractError('筛选字符串过长', context);
        if (/[\u0000-\u001f\u007f]/.test(value)) throw contractError('筛选字符串包含控制字符', context);
        return `'${value.replace(/'/g, "''")}'`;
    }
    throw contractError('筛选值类型不受支持', context);
}

function buildFilterNode(node, allowedFields, context, depth = 0, budget = { clauses: 0 }) {
    if (!isPlainObject(node) || depth > 3) throw contractError('筛选条件结构无效', context);

    if (Array.isArray(node.and) || Array.isArray(node.or)) {
        const key = Array.isArray(node.and) ? 'and' : 'or';
        if (Object.keys(node).length !== 1) throw contractError('组合筛选条件不能包含其他字段', context);
        const clauses = node[key];
        if (clauses.length < 1 || clauses.length > 20) throw contractError('组合筛选条件数量无效', context);
        const joiner = key === 'and' ? ' AND ' : ' OR ';
        return `(${clauses.map(item =>
            buildFilterNode(item, allowedFields, context, depth + 1, budget)).join(joiner)})`;
    }

    const keys = Object.keys(node).sort();
    if (keys.join(',') !== 'field,operator,value') throw contractError('筛选条件必须包含 field、operator 和 value', context);
    const field = String(node.field || '').trim();
    const operator = String(node.operator || '').trim().toLowerCase();
    if (!allowedFields.has(field)) throw contractError(`筛选字段不在白名单中: ${field}`, context);
    if (!FILTER_OPERATORS[operator]) throw contractError(`筛选操作符不受支持: ${operator}`, context);
    budget.clauses++;
    if (budget.clauses > MAX_FILTER_CLAUSES) throw contractError('筛选条件数量超过限制', context);

    if (operator === 'in') {
        if (!Array.isArray(node.value) || node.value.length < 1 || node.value.length > 50) {
            throw contractError('IN 筛选值必须是 1 至 50 项数组', context);
        }
        return `${field} IN (${node.value.map(value => filterLiteral(value, context)).join(', ')})`;
    }
    return `${field} ${FILTER_OPERATORS[operator]} ${filterLiteral(node.value, context)}`;
}

function buildFilter(filter, allowedFields, context) {
    if (filter === undefined || filter === null) return '';
    if (typeof filter === 'string') throw contractError('不接受未经验证的原始筛选表达式', context);
    const expression = buildFilterNode(filter, allowedFields, context);
    if (expression.length > MAX_FILTER_LENGTH) throw contractError('筛选表达式长度超过限制', context);
    return expression;
}

function normalizeBounds(value, manifestExtent, context) {
    const bounds = value === undefined || value === null ? manifestExtent : value;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
        throw contractError('bounds 必须是四个有限数字', context);
    }
    const [minLng, minLat, maxLng, maxLat] = bounds;
    if (minLng >= maxLng || minLat >= maxLat || minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
        throw contractError('bounds 不是有效的 EPSG:4326 范围', context);
    }
    if (
        minLng < manifestExtent[0] || minLat < manifestExtent[1]
        || maxLng > manifestExtent[2] || maxLat > manifestExtent[3]
    ) {
        throw contractError('bounds 超出 manifest 景区范围', context);
    }
    return [...bounds];
}

function normalizeFields(value, dataset, context) {
    const requested = value === undefined || value === null ? dataset.fields : value;
    if (!Array.isArray(requested) || requested.length === 0) throw contractError('fields 必须是非空数组', context);
    const allowlist = new Set(dataset.fields);
    const fields = [];
    for (const item of requested) {
        const field = String(item || '').trim();
        if (!allowlist.has(field)) throw contractError(`查询字段不在白名单中: ${field}`, context);
        if (!fields.includes(field)) fields.push(field);
    }
    return fields;
}

function normalizeFeatureId(value, fallback, context) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
            throw contractError('iServer 要素 id 无效', { ...context, category: 'contract' });
        }
        return value;
    }
    throw contractError('iServer 要素 id 类型无效', { ...context, category: 'contract' });
}

function normalizeFeature(feature, index, datasetKey, dataset, fields, context) {
    if (!isPlainObject(feature) || feature.type !== 'Feature' || !isPlainObject(feature.geometry)) {
        throw contractError('iServer 要素不是有效的 GeoJSON Feature', { ...context, category: 'contract' });
    }

    const rawProperties = isPlainObject(feature.properties) ? feature.properties : {};
    const properties = {};
    for (const field of fields) {
        const publicField = dataset.propertyMap?.[field];
        if (publicField && Object.prototype.hasOwnProperty.call(rawProperties, field)) {
            properties[publicField] = rawProperties[field];
        }
    }
    const smIdField = dataset.fields.find(field => field.toLowerCase() === 'smid');
    const smId = smIdField && Number.isFinite(Number(rawProperties[smIdField]))
        ? Number(rawProperties[smIdField])
        : null;
    properties.sourceRef = { datasetName: dataset.name, ...(smId === null ? {} : { smId }) };

    return {
        type: 'Feature',
        id: normalizeFeatureId(feature.id, `${datasetKey}_${index}`, context),
        geometry: normalizeGeoJsonGeometry(feature.geometry, context),
        properties
    };
}

function normalizeManifestFailure(error) {
    return {
        ok: false,
        state: 'offline',
        manifest: null,
        publicConfig: null,
        error: {
            code: 'SUPERMAP_MANIFEST_UNAVAILABLE',
            message: 'SuperMap manifest is unavailable.'
        },
        internalError: error
    };
}

function assertSuccessfulResponse(response, context) {
    const status = Number(response?.status);
    if (!Number.isInteger(status)) {
        throw contractError('iServer 响应缺少有效 HTTP 状态码', { ...context, category: 'contract' });
    }
    if (status < 200 || status >= 300) {
        const error = new Error('iServer returned a non-success HTTP status');
        error.response = { status };
        error.request = { sent: true };
        throw error;
    }
}

function manifestQueryError(manifestResult, context) {
    const code = manifestResult?.error?.code;
    if ([
        'SUPERMAP_MANIFEST_NOT_FOUND',
        'SUPERMAP_MANIFEST_READ_ERROR',
        'SUPERMAP_MANIFEST_UNAVAILABLE'
    ].includes(code)) {
        return new IServerUnavailableError('SuperMap manifest 不可用', {
            ...context,
            category: 'configuration',
            retryable: false
        });
    }
    return contractError('SuperMap manifest 契约不可用', { ...context, category: 'contract' });
}

class SuperMapGateway {
    constructor(options = {}) {
        if (!options.httpClient || typeof options.httpClient.request !== 'function') {
            throw new TypeError('SuperMapGateway requires an HTTP client');
        }
        if (options.manifestLoader !== undefined && typeof options.manifestLoader !== 'function') {
            throw new TypeError('SuperMapGateway manifestLoader must be a function');
        }

        this.enabled = options.enabled !== false;
        this.manifestPath = options.manifestPath || '';
        this.manifestLoader = options.manifestLoader || loadManifestSafe;
        this.httpClient = options.httpClient;
        this.clock = options.clock || (() => new Date());
        this.requestIdFactory = options.requestIdFactory || (() => `gis_${crypto.randomUUID()}`);
        this.logger = options.logger || console;
        this.healthTimeoutMs = finitePositive(options.healthTimeoutMs, 2000);
        this.queryTimeoutMs = finitePositive(options.queryTimeoutMs, 5000);
        this.statusCacheMs = Math.max(0, Number(options.statusCacheMs) || 0);
        this.manifestResult = null;
        this.statusCache = null;
        this.diagnostics = {
            lastSuccessAt: null,
            lastOperation: null,
            lastStatus: null,
            routeCacheSize: 0,
            lastInvalidationReason: null
        };
    }

    _now() {
        return asDate(this.clock());
    }

    _loadManifest(refresh = false) {
        if (this.manifestResult && !refresh) return this.manifestResult;
        try {
            this.manifestResult = this.manifestLoader(this.manifestPath);
        } catch (error) {
            this.manifestResult = normalizeManifestFailure(error);
        }
        return this.manifestResult;
    }

    _manifestSummary(manifest) {
        return manifest ? {
            contractVersion: manifest.contractVersion,
            dataVersion: manifest.dataVersion,
            scenicId: manifest.scenicId,
            crs: manifest.crs
        } : null;
    }

    _offlineStatus(requestId, checkedAt, manifestResult, enabled = this.enabled) {
        const manifest = manifestResult?.manifest || null;
        const manifestSummary = this._manifestSummary(manifest);
        const services = {};
        const serviceKeys = manifest
            ? Object.keys(manifest.services)
            : [...REQUIRED_STATUS_SERVICES, ...OPTIONAL_STATUS_SERVICES];
        for (const key of serviceKeys) {
            if (!enabled) services[key] = 'disabled';
            else if (!manifest) services[key] = REQUIRED_STATUS_SERVICES.includes(key) ? 'offline' : 'disabled';
            else services[key] = manifest.services[key]?.enabled ? 'offline' : 'disabled';
        }
        return {
            state: 'offline',
            enabled,
            contractVersion: manifestSummary?.contractVersion || null,
            dataVersion: manifestSummary?.dataVersion || null,
            requestId,
            checkedAt: checkedAt.toISOString(),
            durationMs: 0,
            manifest: manifestSummary,
            services,
            cached: false,
            ...(manifestResult?.error ? { error: { ...manifestResult.error } } : {})
        };
    }

    async getStatus(options = {}) {
        if (!isPlainObject(options)) {
            throw contractError('getStatus options 必须是对象', {
                operation: 'getStatus',
                requestId: requestIdOf(undefined, this.requestIdFactory),
                category: 'parameter'
            });
        }
        const requestId = requestIdOf(options.requestId, this.requestIdFactory);
        const startedAt = this._now();
        const refresh = Boolean(options.force || options.refresh);
        if (refresh) this.statusCache = null;
        if (!this.enabled) {
            const status = this._offlineStatus(requestId, startedAt, this._loadManifest(refresh), false);
            this.diagnostics.lastStatus = status;
            return status;
        }

        if (!refresh && this.statusCache && startedAt.getTime() < this.statusCache.expiresAt) {
            return { ...this.statusCache.value, requestId, cached: true };
        }

        const manifestResult = this._loadManifest(refresh);
        if (!manifestResult?.ok || !manifestResult.manifest) {
            this.statusCache = null;
            const status = this._offlineStatus(requestId, startedAt, manifestResult);
            this.diagnostics.lastStatus = status;
            return status;
        }

        const manifest = manifestResult.manifest;
        const serviceEntries = await Promise.all(Object.entries(manifest.services).map(async ([serviceKey, service]) => {
            if (!service.enabled) return [serviceKey, 'disabled'];
            const operation = service.operations.status;
            if (!operation) return [serviceKey, 'disabled'];
            try {
                const response = await this.httpClient.request({
                    operation: `${serviceKey}.status`,
                    method: operation.method,
                    path: joinPaths(service.path, operation.path),
                    requestId,
                    timeoutMs: this.healthTimeoutMs
                });
                assertSuccessfulResponse(response, { operation: `${serviceKey}.status`, requestId });
                const declared = response?.data?.state;
                return [serviceKey, STATUS_VALUES.has(declared) ? declared : 'online'];
            } catch (error) {
                const mapped = toSuperMapError(error, { operation: `${serviceKey}.status`, requestId });
                this.logger.warn?.('[GeoSync] [GIS] service health check failed', {
                    requestId,
                    service: serviceKey,
                    code: mapped.code,
                    category: mapped.category
                });
                return [serviceKey, 'offline'];
            }
        }));
        const services = Object.fromEntries(serviceEntries);
        const requiredStates = REQUIRED_STATUS_SERVICES.map(key => services[key] || 'offline');
        const state = requiredStates.every(value => value === 'online')
            ? 'online'
            : requiredStates.every(value => value === 'offline')
                ? 'offline'
                : 'degraded';
        const finishedAt = this._now();
        const status = {
            state,
            enabled: true,
            contractVersion: manifest.contractVersion,
            dataVersion: manifest.dataVersion,
            requestId,
            checkedAt: finishedAt.toISOString(),
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            manifest: this._manifestSummary(manifest),
            services,
            cached: false
        };
        this.statusCache = {
            value: status,
            expiresAt: finishedAt.getTime() + this.statusCacheMs
        };
        this.diagnostics.lastStatus = status;
        if (state !== 'offline') {
            this.diagnostics.lastSuccessAt = finishedAt.toISOString();
            this.diagnostics.lastOperation = 'getStatus';
        }
        return status;
    }

    async queryFeatures(input = {}) {
        if (!isPlainObject(input)) {
            throw contractError('queryFeatures input 必须是对象', {
                operation: 'queryFeatures',
                requestId: requestIdOf(undefined, this.requestIdFactory),
                category: 'parameter'
            });
        }
        const requestId = requestIdOf(input.requestId, this.requestIdFactory);
        const operationContext = { operation: 'queryFeatures', requestId };
        const startedAt = this._now();
        const refreshManifest = Boolean(input.refreshManifest);
        if (refreshManifest) this.statusCache = null;
        const manifestResult = this._loadManifest(refreshManifest);
        if (!this.enabled) {
            throw new IServerUnavailableError('SuperMapGateway 未启用', {
                ...operationContext,
                category: 'configuration',
                retryable: false
            });
        }
        if (!manifestResult?.ok || !manifestResult.manifest) {
            const status = this._offlineStatus(requestId, startedAt, manifestResult);
            this.statusCache = null;
            this.diagnostics.lastStatus = status;
            throw manifestQueryError(manifestResult, operationContext);
        }

        const manifest = manifestResult.manifest;
        const datasetKey = String(input.datasetKey || '').trim();
        const dataset = manifest.datasets[datasetKey];
        if (!dataset) throw contractError(`数据集不在 manifest 白名单中: ${datasetKey}`, operationContext);
        const service = manifest.services[dataset.service];
        const operation = service?.operations?.queryFeatures;
        if (!service?.enabled || !operation) {
            throw contractError('manifest 未提供可用的要素查询操作', { ...operationContext, category: 'contract' });
        }

        const fields = normalizeFields(input.fields, dataset, operationContext);
        const smIdField = dataset.fields.find(field => field.toLowerCase() === 'smid');
        const transportFields = smIdField && !fields.includes(smIdField)
            ? [...fields, smIdField]
            : fields;
        const fieldAllowlist = new Set(dataset.fields);
        const filter = buildFilter(input.filter, fieldAllowlist, operationContext);
        const bounds = normalizeBounds(input.bounds, manifest.extent, operationContext);
        const requestedLimit = input.limit === undefined ? manifest.limits.maxFeatures : Number(input.limit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw contractError('limit 必须是正整数', operationContext);
        const limit = Math.min(requestedLimit, manifest.limits.maxFeatures);
        const offset = input.offset === undefined ? 0 : Number(input.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) {
            throw contractError('offset 必须是 0 至 1000000 的整数', operationContext);
        }

        try {
            const response = await this.httpClient.request({
                operation: 'queryFeatures',
                method: operation.method,
                path: joinPaths(service.path, operation.path),
                requestId,
                timeoutMs: this.queryTimeoutMs,
                data: {
                    datasetKey,
                    datasetName: dataset.name,
                    fields: transportFields,
                    filter,
                    bounds,
                    offset,
                    limit
                }
            });
            assertSuccessfulResponse(response, operationContext);
            const payload = response?.data;
            if (!isPlainObject(payload) || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
                throw contractError('iServer 要素查询响应不符合归一化契约', {
                    ...operationContext,
                    category: 'contract'
                });
            }
            if (payload.features.length > limit) {
                throw contractError('iServer 返回要素数量超过本次分页上限', {
                    ...operationContext,
                    category: 'contract'
                });
            }

            const features = payload.features.map((feature, index) =>
                normalizeFeature(feature, offset + index, datasetKey, dataset, fields, operationContext));
            const finishedAt = this._now();
            const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
            this.diagnostics.lastSuccessAt = finishedAt.toISOString();
            this.diagnostics.lastOperation = 'queryFeatures';
            this.logger.info?.('[GeoSync] [GIS] operation completed', {
                requestId,
                operation: 'queryFeatures',
                source: 'iserver',
                durationMs,
                status: 'ok',
                dataVersion: manifest.dataVersion,
                resultCount: features.length
            });
            return {
                type: 'FeatureCollection',
                features,
                gis: {
                    source: 'iserver',
                    degraded: false,
                    requestId,
                    durationMs,
                    dataVersion: manifest.dataVersion
                }
            };
        } catch (error) {
            const mapped = toSuperMapError(error, operationContext);
            this.logger.warn?.('[GeoSync] [GIS] operation failed', {
                requestId,
                operation: 'queryFeatures',
                code: mapped.code,
                category: mapped.category,
                status: 'failed',
                dataVersion: manifest.dataVersion
            });
            throw mapped;
        }
    }

    getPublicConfig() {
        const result = this._loadManifest(false);
        return {
            state: this.diagnostics.lastStatus?.state || 'offline',
            enabled: this.enabled,
            ...(result?.publicConfig ? result.publicConfig : {}),
            ...(!result?.ok && result?.error ? { error: { ...result.error } } : {})
        };
    }

    getDiagnostics() {
        return {
            lastSuccessAt: this.diagnostics.lastSuccessAt,
            lastOperation: this.diagnostics.lastOperation,
            lastStatus: this.diagnostics.lastStatus ? { ...this.diagnostics.lastStatus } : null,
            routeCacheSize: this.diagnostics.routeCacheSize,
            lastInvalidationReason: this.diagnostics.lastInvalidationReason
        };
    }
}

module.exports = SuperMapGateway;
module.exports.SuperMapGateway = SuperMapGateway;
module.exports.buildFilter = buildFilter;
module.exports.joinPaths = joinPaths;
