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
            console.error('[GeoSync] [ERROR]', req.method, req.originalUrl, e);
            fail(res, 500, 9001, '内部错误');
        }
    };
}

module.exports = { BizError, ok, accepted, fail, wrap };
