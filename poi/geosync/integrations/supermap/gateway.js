'use strict';

const crypto = require('node:crypto');
const {
    ContractMismatchError,
    IServerUnavailableError,
    RouteSnapError,
    NoRouteError,
    toSuperMapError
} = require('./errors');
const { loadManifestSafe } = require('./manifest');
const {
    normalizeGeoJsonGeometry,
    normalizeRouteGeometry,
    normalizeRouteGeometryWithMeta
} = require('./normalizers');
const {
    RouteCache,
    buildRouteRequestSignature
} = require('./routeCache');
const { encodePolyline } = require('../../lib/geo');

const STATUS_VALUES = new Set(['online', 'degraded', 'offline']);
const REQUIRED_STATUS_SERVICES = ['map', 'data', 'network'];
const OPTIONAL_STATUS_SERVICES = ['terrain', 'scene'];
const MAX_FILTER_CLAUSES = 50;
const MAX_FILTER_LENGTH = 4096;
const ROUTE_MODES = new Set(['normal', 'accessible', 'shade']);
const MAX_BARRIERS = 500;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

function normalizeRouteCoordinate(value, field, manifest, bufferDeg, context) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
        throw contractError(`${field} 必须是有限数字组成的 [lng, lat]`, context);
    }
    const coordinate = [value[0], value[1]];
    if (coordinate[0] < -180 || coordinate[0] > 180 || coordinate[1] < -90 || coordinate[1] > 90) {
        throw contractError(`${field} 超出 EPSG:4326 范围`, context);
    }
    const extent = manifest?.extent;
    if (extent && (
        coordinate[0] < extent[0] - bufferDeg
        || coordinate[1] < extent[1] - bufferDeg
        || coordinate[0] > extent[2] + bufferDeg
        || coordinate[1] > extent[3] + bufferDeg
    )) {
        throw contractError(`${field} 超出景区允许范围`, context);
    }
    return coordinate;
}

function normalizeNodeId(value, field, context) {
    if (value === undefined || value === null || value === '') return null;
    const nodeId = String(value).trim();
    if (!SAFE_IDENTIFIER.test(nodeId)) throw contractError(`${field} 无效`, context);
    return nodeId;
}

function normalizeBarrierSourceRef(value, manifest, field, context) {
    if (!isPlainObject(value)) throw contractError(`${field} 必须是对象`, context);
    const datasetName = String(value.datasetName || '').trim();
    const smId = Number(value.smId);
    const datasetNames = new Set(Object.values(manifest?.datasets || {}).map(dataset => dataset.name));
    if (!datasetName || !datasetNames.has(datasetName)) {
        throw contractError(`${field}.datasetName 不在 manifest 白名单中`, context);
    }
    if (!Number.isInteger(smId) || smId < 0) throw contractError(`${field}.smId 必须是非负整数`, context);
    return { datasetName, smId };
}

function normalizeBarriers(value, manifest, required, context) {
    const barriers = value === undefined || value === null ? [] : value;
    if (!Array.isArray(barriers)) throw contractError('barriers 必须是数组', context);
    if (required && barriers.length === 0) throw contractError('findPathWithBarriers 要求非空 barriers', context);
    if (barriers.length > MAX_BARRIERS) throw contractError(`barriers 不能超过 ${MAX_BARRIERS} 项`, context);

    const byEdgeId = new Map();
    for (let index = 0; index < barriers.length; index++) {
        const barrier = barriers[index];
        if (!isPlainObject(barrier)) throw contractError(`barriers[${index}] 必须是对象`, context);
        const edgeId = String(barrier.edgeId || '').trim();
        if (!SAFE_IDENTIFIER.test(edgeId)) throw contractError(`barriers[${index}].edgeId 无效`, context);
        const normalized = {
            edgeId,
            sourceRef: normalizeBarrierSourceRef(
                barrier.sourceRef,
                manifest,
                `barriers[${index}].sourceRef`,
                context
            )
        };
        const previous = byEdgeId.get(edgeId);
        if (previous && JSON.stringify(previous.sourceRef) !== JSON.stringify(normalized.sourceRef)) {
            throw contractError(`barrier ${edgeId} 的 sourceRef 冲突`, context);
        }
        byEdgeId.set(edgeId, normalized);
    }
    return [...byEdgeId.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function normalizeRouteInput(input, manifest, options = {}) {
    const context = options.context || {};
    const scenicId = input.scenicId === undefined || input.scenicId === null || input.scenicId === ''
        ? manifest?.scenicId || ''
        : String(input.scenicId).trim();
    if (manifest && scenicId !== manifest.scenicId) {
        throw contractError('scenicId 与 manifest 不一致', { ...context, category: 'contract' });
    }
    const mode = input.mode === undefined || input.mode === null || input.mode === ''
        ? 'normal'
        : String(input.mode).trim().toLowerCase();
    if (!ROUTE_MODES.has(mode)) throw contractError('mode 只允许 normal、accessible 或 shade', context);
    const bufferDeg = Math.max(0, Number(options.boundsBufferDeg) || 0);
    const start = normalizeRouteCoordinate(input.start, 'start', manifest, bufferDeg, context);
    const end = normalizeRouteCoordinate(input.end, 'end', manifest, bufferDeg, context);
    const barriers = normalizeBarriers(input.barriers, manifest, Boolean(options.requireBarriers), context);
    return {
        start,
        end,
        mode,
        scenicId,
        barriers,
        startNodeId: normalizeNodeId(input.startNodeId, 'startNodeId', context),
        endNodeId: normalizeNodeId(input.endNodeId, 'endNodeId', context)
    };
}

function nonNegativeNumber(value, field, context) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw contractError(`${field} 必须是非负有限数字`, { ...context, category: 'contract' });
    }
    return value;
}

function normalizeRouteSegments(value, manifest, context, options = {}) {
    const segments = value === undefined || value === null ? [] : value;
    if (!Array.isArray(segments) || segments.length > 5000) {
        throw contractError('segments 结构或数量无效', { ...context, category: 'contract' });
    }
    const datasetNames = new Set(Object.values(manifest?.datasets || {}).map(dataset => dataset.name));
    const normalized = segments.map((segment, index) => {
        if (!isPlainObject(segment)) throw contractError(`segments[${index}] 必须是对象`, context);
        const edgeId = String(segment.edgeId || '').trim();
        if (!SAFE_IDENTIFIER.test(edgeId)) throw contractError(`segments[${index}].edgeId 无效`, context);
        let sourceRef;
        if (segment.sourceRef !== undefined && segment.sourceRef !== null) {
            if (!isPlainObject(segment.sourceRef)) throw contractError(`segments[${index}].sourceRef 无效`, context);
            const datasetName = String(segment.sourceRef.datasetName || '').trim();
            const smId = Number(segment.sourceRef.smId);
            if (!datasetName || (datasetNames.size && !datasetNames.has(datasetName))) {
                throw contractError(`segments[${index}].sourceRef.datasetName 无效`, context);
            }
            if (!Number.isInteger(smId) || smId < 0) {
                throw contractError(`segments[${index}].sourceRef.smId 无效`, context);
            }
            sourceRef = { datasetName, smId };
        } else if (!options.allowMissingSourceRef) {
            throw contractError(`segments[${index}].sourceRef 缺失`, context);
        }
        return {
            edgeId,
            distanceM: nonNegativeNumber(segment.distanceM, `segments[${index}].distanceM`, context),
            durationSec: nonNegativeNumber(segment.durationSec, `segments[${index}].durationSec`, context),
            ...(sourceRef ? { sourceRef } : {})
        };
    });
    return options.reversed ? normalized.reverse() : normalized;
}

function normalizeRouteSnap(value, input, context, maxSnapDistanceM) {
    if (!isPlainObject(value)) throw contractError('snap 必须是对象', { ...context, category: 'contract' });
    const startDistanceM = nonNegativeNumber(value.startDistanceM, 'snap.startDistanceM', context);
    const endDistanceM = nonNegativeNumber(value.endDistanceM, 'snap.endDistanceM', context);
    if (startDistanceM > maxSnapDistanceM || endDistanceM > maxSnapDistanceM) {
        throw new RouteSnapError(undefined, {
            ...context,
            category: 'snap',
            retryable: false
        });
    }
    const startNodeId = normalizeNodeId(value.startNodeId, 'snap.startNodeId', context) || input.startNodeId;
    const endNodeId = normalizeNodeId(value.endNodeId, 'snap.endNodeId', context) || input.endNodeId;
    if (!startNodeId || !endNodeId) {
        throw contractError('snap 必须包含起终点吸附节点标识', { ...context, category: 'contract' });
    }
    return {
        public: { startDistanceM, endDistanceM },
        startNodeId,
        endNodeId
    };
}

function normalizeRoutePayload(payload, input, manifest, context, options = {}) {
    if (payload === null || payload === undefined || payload?.routeFound === false || payload?.available === false) {
        throw new NoRouteError(undefined, { ...context, category: 'no-route', retryable: false });
    }
    if (!isPlainObject(payload)) throw contractError('iServer 路径响应必须是对象', { ...context, category: 'contract' });
    const declaredVersion = payload.dataVersion || payload.gis?.dataVersion;
    if (!declaredVersion) {
        throw contractError('iServer 路径响应缺少 dataVersion', { ...context, category: 'contract' });
    }
    if (declaredVersion !== manifest.dataVersion) {
        throw contractError('iServer 路径数据版本与 manifest 不一致', { ...context, category: 'contract' });
    }
    const geometryMeta = normalizeRouteGeometryWithMeta
        ? normalizeRouteGeometryWithMeta(payload.geometry, {
            start: input.start,
            end: input.end,
            extent: manifest.extent,
            operation: context.operation,
            requestId: context.requestId
        })
        : {
            geometry: normalizeRouteGeometry(payload.geometry, {
                start: input.start,
                end: input.end,
                extent: manifest.extent,
                operation: context.operation,
                requestId: context.requestId
            }),
            reversed: false
        };
    const snap = normalizeRouteSnap(payload.snap, input, context, options.maxSnapDistanceM);
    const segments = normalizeRouteSegments(payload.segments, manifest, context, {
        allowMissingSourceRef: options.source === 'local-fallback',
        reversed: Boolean(geometryMeta.reversed)
    });
    if (input.barriers.length) {
        if (!segments.length) {
            throw contractError('障碍路径响应缺少可验证的路段来源', {
                ...context,
                category: 'contract'
            });
        }
        const blockedEdgeIds = new Set(input.barriers.map(barrier => barrier.edgeId));
        const blockedSourceRefs = new Set(input.barriers.map(barrier =>
            `${barrier.sourceRef.datasetName}\u0000${barrier.sourceRef.smId}`));
        const blockedSegment = segments.find(segment =>
            blockedEdgeIds.has(segment.edgeId)
            || (segment.sourceRef && blockedSourceRefs.has(
                `${segment.sourceRef.datasetName}\u0000${segment.sourceRef.smId}`
            )));
        if (blockedSegment) {
            throw contractError('路径响应仍包含请求中声明的障碍路段', {
                ...context,
                category: 'contract'
            });
        }
    }
    const distanceM = nonNegativeNumber(payload.distanceM, 'distanceM', context);
    const durationSec = nonNegativeNumber(payload.durationSec, 'durationSec', context);
    const geometry = geometryMeta.geometry;
    const verifiedAccessible = payload.verifiedAccessible === true || payload.accessibleVerified === true;
    return {
        route: {
            distanceM,
            durationSec,
            geometry,
            segments,
            snap: snap.public,
            pathGeometry: encodePolyline(geometry.coordinates),
            walkSec: durationSec,
            coords: geometry.coordinates,
            fallback: options.source === 'local-fallback',
            verifiedAccessible,
            accessibleVerified: verifiedAccessible
        },
        startNodeId: snap.startNodeId,
        endNodeId: snap.endNodeId,
        verifiedAccessible
    };
}

function withRouteGis(route, metadata) {
    return {
        ...route,
        geometry: { type: route.geometry.type, coordinates: route.geometry.coordinates.map(point => [...point]) },
        segments: route.segments.map(segment => ({
            ...segment,
            ...(segment.sourceRef ? { sourceRef: { ...segment.sourceRef } } : {})
        })),
        snap: { ...route.snap },
        coords: route.geometry.coordinates.map(point => [...point]),
        walkSec: route.durationSec,
        fallback: metadata.source === 'local-fallback',
        gis: {
            source: metadata.source,
            mode: metadata.mode,
            degraded: metadata.source !== 'iserver',
            requestId: metadata.requestId,
            durationMs: metadata.durationMs,
            dataVersion: metadata.dataVersion
        }
    };
}

function routeCacheLike(value) {
    return value
        && typeof value.get === 'function'
        && typeof value.set === 'function'
        && typeof value.clear === 'function'
        && typeof value.getDiagnostics === 'function';
}

function localPathSourceLike(value) {
    return typeof value === 'function'
        || Boolean(value && (
            typeof value.findPath === 'function'
            || typeof value.findPathWithBarriers === 'function'
        ));
}

function routeCacheIdentity(input, dataVersion, snap = {}) {
    return {
        dataVersion,
        mode: input.mode,
        start: input.start,
        end: input.end,
        barriers: input.barriers,
        startNodeId: snap.startNodeId,
        endNodeId: snap.endNodeId
    };
}

function canUseDegradation(error) {
    if (![8201, 8202].includes(error?.code)) return false;
    if (['auth', 'cancelled', 'configuration', 'parameter', 'contract', 'rate-limit'].includes(error.category)) {
        return false;
    }
    return error.retryable === true
        || (error.code === 8202 && error.category === 'timeout-budget');
}

function localPayloadOf(value) {
    if (!isPlainObject(value)) return value;
    if (!isPlainObject(value.route)) return value;
    return {
        ...value.route,
        ...(value.verifiedAccessible === true ? { verifiedAccessible: true } : {}),
        ...(value.accessibleVerified === true ? { accessibleVerified: true } : {})
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
        error.response = { status, data: response?.data };
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
        if (options.routeCache !== undefined && !routeCacheLike(options.routeCache)) {
            throw new TypeError('SuperMapGateway routeCache must implement get, set, clear, and getDiagnostics');
        }
        if (options.localPathSource !== undefined
            && options.localPathSource !== null
            && !localPathSourceLike(options.localPathSource)) {
            throw new TypeError('SuperMapGateway localPathSource must be a function or route source object');
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
        this.routeTimeoutMs = finitePositive(options.routeTimeoutMs, 5000);
        this.statusCacheMs = Math.max(0, Number(options.statusCacheMs) || 0);
        this.boundsBufferDeg = Math.max(0, Number(options.boundsBufferDeg) || 0);
        this.maxSnapDistanceM = finitePositive(options.maxSnapDistanceM, 200);
        this.fallbackEnabled = options.fallbackEnabled !== false;
        this.localPathSource = options.localPathSource || null;
        this.routeCache = options.routeCache || new RouteCache({
            store: options.routeCacheStore,
            aliasStore: options.routeAliasStore,
            clock: options.routeCacheClock || this.clock,
            ttlMs: finitePositive(options.routeCacheTtlMs, 60_000)
        });
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
        const previousDataVersion = this.manifestResult?.manifest?.dataVersion || null;
        try {
            this.manifestResult = this.manifestLoader(this.manifestPath);
        } catch (error) {
            this.manifestResult = normalizeManifestFailure(error);
        }
        const nextDataVersion = this.manifestResult?.manifest?.dataVersion || null;
        if (previousDataVersion && nextDataVersion && previousDataVersion !== nextDataVersion) {
            this._invalidateRouteCache('manifest-data-version-changed');
        }
        return this.manifestResult;
    }

    _invalidateRouteCache(reason) {
        const cleared = this.routeCache.clear(reason);
        const cacheDiagnostics = this.routeCache.getDiagnostics();
        this.diagnostics.routeCacheSize = cacheDiagnostics.size;
        this.diagnostics.lastInvalidationReason = cacheDiagnostics.lastInvalidationReason;
        this.statusCache = null;
        return {
            cleared,
            routeCacheSize: cacheDiagnostics.size,
            lastInvalidationReason: cacheDiagnostics.lastInvalidationReason,
            lastInvalidatedAt: cacheDiagnostics.lastInvalidatedAt
        };
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

    _routeOperation(manifest, operationName, context) {
        const service = manifest.services.network;
        const operation = service?.operations?.[operationName];
        if (!service?.enabled || !operation) {
            throw contractError(`manifest 未提供可用的 ${operationName} 操作`, {
                ...context,
                category: 'contract'
            });
        }
        return { service, operation };
    }

    _routeRequestData(input, manifest) {
        return {
            start: [...input.start],
            end: [...input.end],
            mode: input.mode,
            scenicId: input.scenicId,
            barriers: input.barriers.map(barrier => ({
                edgeId: barrier.edgeId,
                sourceRef: { ...barrier.sourceRef }
            })),
            dataVersion: manifest.dataVersion,
            ...(input.startNodeId ? { startNodeId: input.startNodeId } : {}),
            ...(input.endNodeId ? { endNodeId: input.endNodeId } : {})
        };
    }

    _recordRouteSuccess({ route, input, operation, requestId, source, startedAt, dataVersion }) {
        const finishedAt = this._now();
        const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
        const cacheDiagnostics = this.routeCache.getDiagnostics();
        this.diagnostics.lastSuccessAt = finishedAt.toISOString();
        this.diagnostics.lastOperation = operation;
        this.diagnostics.routeCacheSize = cacheDiagnostics.size;
        this.diagnostics.lastInvalidationReason = cacheDiagnostics.lastInvalidationReason;
        this.logger.info?.('[GeoSync] [GIS] operation completed', {
            requestId,
            operation,
            mode: input.mode,
            barrierCount: input.barriers.length,
            source,
            durationMs,
            status: 'ok',
            dataVersion,
            degraded: source !== 'iserver'
        });
        return withRouteGis(route, {
            source,
            mode: input.mode,
            requestId,
            durationMs,
            dataVersion
        });
    }

    _logRouteFailure({ input, operation, requestId, error, startedAt, dataVersion, source = 'iserver' }) {
        const finishedAt = this._now();
        this.logger.warn?.('[GeoSync] [GIS] operation failed', {
            requestId,
            operation,
            mode: input?.mode || null,
            barrierCount: Array.isArray(input?.barriers) ? input.barriers.length : 0,
            source,
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            status: 'failed',
            code: error.code,
            category: error.category,
            dataVersion,
            degraded: source !== 'iserver'
        });
    }

    async _requestNetworkRoute({ input, manifest, operationName, context }) {
        const { service, operation } = this._routeOperation(manifest, operationName, context);
        const response = await this.httpClient.request({
            operation: operationName,
            method: operation.method,
            path: joinPaths(service.path, operation.path),
            requestId: context.requestId,
            timeoutMs: this.routeTimeoutMs,
            data: this._routeRequestData(input, manifest)
        });
        assertSuccessfulResponse(response, context);
        const normalized = normalizeRoutePayload(response?.data, input, manifest, context, {
            source: 'iserver',
            maxSnapDistanceM: this.maxSnapDistanceM
        });
        const identity = routeCacheIdentity(input, manifest.dataVersion, normalized);
        try {
            this.routeCache.set(identity, normalized.route);
        } catch (error) {
            this.logger.warn?.('[GeoSync] [GIS] route cache write failed', {
                requestId: context.requestId,
                operation: operationName,
                mode: input.mode,
                barrierCount: input.barriers.length,
                status: 'cache-write-failed',
                dataVersion: manifest.dataVersion
            });
        }
        return normalized.route;
    }

    _cachedRoute(input, manifest) {
        const identity = routeCacheIdentity(input, manifest.dataVersion);
        const signature = buildRouteRequestSignature(identity);
        return this.routeCache.get(signature);
    }

    async _localRoute({ input, manifest, operationName, context }) {
        if (!this.fallbackEnabled || !this.localPathSource) return null;
        const source = this.localPathSource;
        let resolver;
        if (typeof source === 'function') resolver = source;
        else if (operationName === 'findPathWithBarriers' && typeof source.findPathWithBarriers === 'function') {
            resolver = source.findPathWithBarriers.bind(source);
        } else if (typeof source.findPath === 'function') {
            resolver = source.findPath.bind(source);
        }
        if (!resolver) return null;

        const response = await resolver({
            ...this._routeRequestData(input, manifest),
            requestId: context.requestId
        });
        if (response === undefined || response === null) return null;
        const payload = localPayloadOf(response);
        const normalized = normalizeRoutePayload(payload, input, manifest, context, {
            source: 'local-fallback',
            maxSnapDistanceM: this.maxSnapDistanceM
        });
        if (input.mode === 'accessible' && !normalized.verifiedAccessible) {
            throw new NoRouteError('无障碍本地降级路线缺少完整验证', {
                ...context,
                category: 'no-route',
                retryable: false
            });
        }
        return normalized.route;
    }

    async _findPath(input, options = {}) {
        const operationName = options.requireBarriers ? 'findPathWithBarriers' : 'findPath';
        if (!isPlainObject(input)) {
            throw contractError(`${operationName} input 必须是对象`, {
                operation: operationName,
                requestId: requestIdOf(undefined, this.requestIdFactory),
                category: 'parameter'
            });
        }
        const requestId = requestIdOf(input.requestId, this.requestIdFactory);
        const context = { operation: operationName, requestId };
        const startedAt = this._now();
        const refreshManifest = Boolean(input.refreshManifest);
        if (refreshManifest) this.statusCache = null;
        const manifestResult = this._loadManifest(refreshManifest);
        if (!this.enabled) {
            throw new IServerUnavailableError('SuperMapGateway 未启用', {
                ...context,
                category: 'configuration',
                retryable: false
            });
        }
        if (!manifestResult?.ok || !manifestResult.manifest) {
            const status = this._offlineStatus(requestId, startedAt, manifestResult);
            this.statusCache = null;
            this.diagnostics.lastStatus = status;
            throw manifestQueryError(manifestResult, context);
        }

        const manifest = manifestResult.manifest;
        const normalizedInput = normalizeRouteInput(input, manifest, {
            context,
            requireBarriers: options.requireBarriers,
            boundsBufferDeg: this.boundsBufferDeg
        });
        let networkError;
        try {
            const route = await this._requestNetworkRoute({
                input: normalizedInput,
                manifest,
                operationName,
                context
            });
            return this._recordRouteSuccess({
                route,
                input: normalizedInput,
                operation: operationName,
                requestId,
                source: 'iserver',
                startedAt,
                dataVersion: manifest.dataVersion
            });
        } catch (error) {
            networkError = toSuperMapError(error, context);
            if (!canUseDegradation(networkError)) {
                this._logRouteFailure({
                    input: normalizedInput,
                    operation: operationName,
                    requestId,
                    error: networkError,
                    startedAt,
                    dataVersion: manifest.dataVersion
                });
                throw networkError;
            }
        }

        const cached = this._cachedRoute(normalizedInput, manifest);
        if (cached) {
            return this._recordRouteSuccess({
                route: cached,
                input: normalizedInput,
                operation: operationName,
                requestId,
                source: 'cache',
                startedAt,
                dataVersion: manifest.dataVersion
            });
        }

        try {
            const localRoute = await this._localRoute({
                input: normalizedInput,
                manifest,
                operationName,
                context
            });
            if (localRoute) {
                return this._recordRouteSuccess({
                    route: localRoute,
                    input: normalizedInput,
                    operation: operationName,
                    requestId,
                    source: 'local-fallback',
                    startedAt,
                    dataVersion: manifest.dataVersion
                });
            }
        } catch (error) {
            const localError = toSuperMapError(error, context);
            this._logRouteFailure({
                input: normalizedInput,
                operation: operationName,
                requestId,
                error: localError,
                startedAt,
                dataVersion: manifest.dataVersion,
                source: 'local-fallback'
            });
            if (normalizedInput.mode === 'accessible' && localError.code === 8204) throw localError;
        }

        this._logRouteFailure({
            input: normalizedInput,
            operation: operationName,
            requestId,
            error: networkError,
            startedAt,
            dataVersion: manifest.dataVersion
        });
        throw networkError;
    }

    async findPath(input = {}) {
        return this._findPath(input, { requireBarriers: false });
    }

    async findPathWithBarriers(input = {}) {
        return this._findPath(input, { requireBarriers: true });
    }

    async normalizeGeometry(rawGeometry, context = {}) {
        const normalizedContext = isPlainObject(context) ? context : {};
        return normalizeRouteGeometry(rawGeometry, normalizedContext);
    }

    async invalidateRouteCache(reason = 'manual') {
        return this._invalidateRouteCache(reason);
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
        const cacheDiagnostics = this.routeCache.getDiagnostics();
        this.diagnostics.routeCacheSize = cacheDiagnostics.size;
        this.diagnostics.lastInvalidationReason = cacheDiagnostics.lastInvalidationReason;
        return {
            lastSuccessAt: this.diagnostics.lastSuccessAt,
            lastOperation: this.diagnostics.lastOperation,
            lastStatus: this.diagnostics.lastStatus ? { ...this.diagnostics.lastStatus } : null,
            routeCacheSize: cacheDiagnostics.size,
            routeCacheAliasCount: cacheDiagnostics.aliasCount,
            routeCacheTtlMs: cacheDiagnostics.ttlMs,
            lastInvalidationReason: cacheDiagnostics.lastInvalidationReason,
            lastInvalidatedAt: cacheDiagnostics.lastInvalidatedAt
        };
    }
}

module.exports = SuperMapGateway;
module.exports.SuperMapGateway = SuperMapGateway;
module.exports.buildFilter = buildFilter;
module.exports.joinPaths = joinPaths;
