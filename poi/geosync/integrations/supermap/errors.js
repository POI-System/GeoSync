'use strict';

const ERROR_DEFINITIONS = Object.freeze({
    8201: Object.freeze({
        code: 8201,
        httpStatus: 503,
        message: 'iServer 不可用且无降级结果',
        category: 'unavailable',
        retryable: true
    }),
    8202: Object.freeze({
        code: 8202,
        httpStatus: 504,
        message: 'iServer 路径分析超时',
        category: 'timeout',
        retryable: true
    }),
    8203: Object.freeze({
        code: 8203,
        httpStatus: 422,
        message: '起终点无法吸附到路网',
        category: 'snap',
        retryable: false
    }),
    8204: Object.freeze({
        code: 8204,
        httpStatus: 422,
        message: '指定模式无可达路径',
        category: 'no-route',
        retryable: false
    }),
    8205: Object.freeze({
        code: 8205,
        httpStatus: 409,
        message: '服务契约或数据版本不一致',
        category: 'contract',
        retryable: false
    }),
    8206: Object.freeze({
        code: 8206,
        httpStatus: 502,
        message: 'iServer 几何无法归一化',
        category: 'geometry',
        retryable: false
    })
});

const ERROR_CLASS_BY_CODE = new Map();
const CANCELLATION_CODES = new Set(['ERR_CANCELED', 'ECANCELED', 'ABORT_ERR']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const CONNECTION_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_NETWORK'
]);

function safeText(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value).slice(0, 128);
}

function finiteStatus(value) {
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
}

function normalizeSuperMapCode(value) {
    const code = Number(value);
    return Number.isInteger(code) && ERROR_DEFINITIONS[code] ? code : null;
}

class SuperMapError extends Error {
    constructor(code, message, options = {}) {
        const normalizedCode = normalizeSuperMapCode(code);
        if (!normalizedCode) throw new RangeError(`Unsupported SuperMap error code: ${code}`);

        const definition = ERROR_DEFINITIONS[normalizedCode];
        super(message || definition.message);
        this.name = options.name || 'SuperMapError';
        this.code = normalizedCode;
        this.httpStatus = definition.httpStatus;
        this.status = definition.httpStatus;
        this.category = options.category || definition.category;
        this.retryable = options.retryable === undefined
            ? definition.retryable
            : Boolean(options.retryable);

        const operation = safeText(options.operation);
        const requestId = safeText(options.requestId);
        const transportCode = safeText(options.transportCode);
        const upstreamStatus = finiteStatus(options.upstreamStatus);
        if (operation) this.operation = operation;
        if (requestId) this.requestId = requestId;
        if (transportCode) this.transportCode = transportCode;
        if (upstreamStatus) this.upstreamStatus = upstreamStatus;

        Error.captureStackTrace?.(this, this.constructor);
    }

    toJSON() {
        const result = {
            name: this.name,
            code: this.code,
            httpStatus: this.httpStatus,
            message: this.message,
            category: this.category,
            retryable: this.retryable
        };
        if (this.operation) result.operation = this.operation;
        if (this.requestId) result.requestId = this.requestId;
        if (this.transportCode) result.transportCode = this.transportCode;
        if (this.upstreamStatus) result.upstreamStatus = this.upstreamStatus;
        return result;
    }
}

function defineErrorClass(name, code) {
    const ErrorClass = class extends SuperMapError {
        constructor(message, options = {}) {
            super(code, message, { ...options, name });
        }
    };
    Object.defineProperty(ErrorClass, 'name', { value: name });
    ERROR_CLASS_BY_CODE.set(code, ErrorClass);
    return ErrorClass;
}

const IServerUnavailableError = defineErrorClass('IServerUnavailableError', 8201);
const IServerTimeoutError = defineErrorClass('IServerTimeoutError', 8202);
const RouteSnapError = defineErrorClass('RouteSnapError', 8203);
const NoRouteError = defineErrorClass('NoRouteError', 8204);
const ContractMismatchError = defineErrorClass('ContractMismatchError', 8205);
const GeometryNormalizationError = defineErrorClass('GeometryNormalizationError', 8206);

function createSuperMapError(code, message, options = {}) {
    const normalizedCode = normalizeSuperMapCode(code);
    if (!normalizedCode) return new SuperMapError(8201, undefined, options);
    const ErrorClass = ERROR_CLASS_BY_CODE.get(normalizedCode) || SuperMapError;
    return ErrorClass === SuperMapError
        ? new SuperMapError(normalizedCode, message, options)
        : new ErrorClass(message, options);
}

function upstreamCodeOf(error) {
    const candidates = [
        error?.superMapCode,
        error?.response?.data?.code,
        error?.response?.data?.errorCode,
        error?.response?.data?.error?.code,
        error?.code
    ];
    for (const candidate of candidates) {
        const code = normalizeSuperMapCode(candidate);
        if (code) return code;
    }
    return null;
}

function transportCodeOf(error) {
    return typeof error?.code === 'string' ? error.code.toUpperCase() : '';
}

function mappedOptions(error, context, overrides = {}) {
    return {
        operation: context.operation,
        requestId: context.requestId,
        upstreamStatus: finiteStatus(error?.response?.status),
        transportCode: transportCodeOf(error),
        ...overrides
    };
}

function toSuperMapError(error, context = {}) {
    if (error instanceof SuperMapError) return error;

    const status = finiteStatus(error?.response?.status);
    const transportCode = transportCodeOf(error);
    const upstreamCode = upstreamCodeOf(error);

    // Transport rate limiting is authoritative even when the upstream body
    // contains a domain code such as 8201.
    if (status === 429) {
        return new IServerUnavailableError(undefined, mappedOptions(error, context, {
            category: 'rate-limit',
            retryable: false
        }));
    }

    if (upstreamCode) {
        const nonRetryableStatus = status && [400, 401, 403, 404, 409, 422].includes(status);
        return createSuperMapError(upstreamCode, undefined, mappedOptions(error, context, {
            retryable: nonRetryableStatus
                ? false
                : ERROR_DEFINITIONS[upstreamCode].retryable
        }));
    }

    if (
        CANCELLATION_CODES.has(transportCode)
        || error?.name === 'CanceledError'
        || error?.name === 'AbortError'
    ) {
        return new IServerUnavailableError(undefined, mappedOptions(error, context, {
            category: 'cancelled',
            retryable: false
        }));
    }

    if (TIMEOUT_CODES.has(transportCode) || status === 408 || status === 504) {
        return new IServerTimeoutError(undefined, mappedOptions(error, context, {
            category: 'timeout',
            retryable: true
        }));
    }

    if (status === 401 || status === 403) {
        return new IServerUnavailableError(undefined, mappedOptions(error, context, {
            category: 'auth',
            retryable: false
        }));
    }

    if (status === 400) {
        return new ContractMismatchError(undefined, mappedOptions(error, context, {
            category: 'parameter',
            retryable: false
        }));
    }

    if (status === 404 || status === 409) {
        return new ContractMismatchError(undefined, mappedOptions(error, context, {
            category: 'contract',
            retryable: false
        }));
    }

    if (status === 422) {
        return new RouteSnapError(undefined, mappedOptions(error, context, {
            category: 'parameter',
            retryable: false
        }));
    }

    if ((status && status >= 500) || CONNECTION_CODES.has(transportCode) || (error?.request && !status)) {
        const category = status
            ? ([502, 503].includes(status) ? 'gateway' : 'upstream-5xx')
            : 'connection';
        return new IServerUnavailableError(undefined, mappedOptions(error, context, {
            category,
            retryable: true
        }));
    }

    return new ContractMismatchError(undefined, mappedOptions(error, context, {
        category: 'client',
        retryable: false
    }));
}

module.exports = {
    ERROR_DEFINITIONS,
    SuperMapError,
    IServerUnavailableError,
    IServerTimeoutError,
    RouteSnapError,
    NoRouteError,
    ContractMismatchError,
    GeometryNormalizationError,
    createSuperMapError,
    toSuperMapError
};
