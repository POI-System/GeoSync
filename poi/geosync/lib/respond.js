'use strict';
// 03文档 §1：统一响应格式 {success, code, data, message} 与错误码。

const { SuperMapError } = require('../integrations/supermap/errors');

class BizError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function safeLogText(value, fallback = null, maxLength = 128) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, maxLength);
    return normalized || fallback;
}

function requestRoute(req) {
    const routePath = req?.route?.path;
    if (typeof routePath === 'string' && routePath) {
        return safeLogText(`${req.baseUrl || ''}${routePath}`, '/', 256);
    }
    const raw = String(req?.path || req?.originalUrl || req?.url || '/');
    return safeLogText(raw.split(/[?#]/, 1)[0], '/', 256);
}

function buildErrorLogContext(req, error) {
    const status = Number(error?.status || error?.statusCode || error?.httpStatus);
    return {
        method: safeLogText(req?.method, 'UNKNOWN', 16),
        path: requestRoute(req),
        error: {
            name: safeLogText(error?.name, 'Error', 64),
            code: safeLogText(error?.code, null, 64),
            category: safeLogText(error?.category, null, 64),
            status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
            requestId: safeLogText(error?.requestId, null, 128)
        }
    };
}

function ok(res, data = null) {
    res.json({ success: true, code: 0, data, message: '' });
}

function accepted(res, code, data = null) {
    res.status(202).json({ success: true, code, data, message: '' });
}

function fail(res, httpStatus, code, message, data = null) {
    res.status(httpStatus).json({ success: false, code, data, message });
}

// async 路由包装：BizError → fail；其余 → 500/9001
function wrap(handler) {
    return async (req, res, next) => {
        try {
            await handler(req, res, next);
        } catch (e) {
            if (e instanceof BizError) {
                return fail(res, e.httpStatus, e.code, e.message);
            }
            if (e instanceof SuperMapError) {
                return fail(res, e.httpStatus, e.code, e.message);
            }
            console.error('[GeoSync] [ERROR]', buildErrorLogContext(req, e));
            fail(res, 500, 9001, '内部错误');
        }
    };
}

module.exports = { BizError, ok, accepted, fail, wrap, buildErrorLogContext };
