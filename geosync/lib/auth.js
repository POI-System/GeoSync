'use strict';
// 03文档 §2：鉴权中间件。requireUser 校验 X-Open-Id；requireAdmin Bearer token；screenOrAdmin 大屏只读。

const { CONFIG } = require('../config');
const { fail } = require('./respond');
const { getModels } = require('../models');

async function requireUser(req, res, next) {
    const openId = String(req.headers['x-open-id'] || '').trim();
    if (!openId) return fail(res, 401, 9001, '缺少身份标识');
    try {
        const { ExternalUser } = getModels();
        const user = await ExternalUser.findOne({ openId }).lean();
        if (!user) return fail(res, 401, 9001, '用户不存在，请先完成微信授权');
        req.openId = openId;
        req.user = user;
        next();
    } catch (e) {
        console.error('[GeoSync] [AUTH]', e.message);
        fail(res, 500, 9001, '鉴权失败');
    }
}

function getBearer(req) {
    const auth = String(req.headers.authorization || '').trim();
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return String(req.query.adminToken || req.body?.adminToken || '').trim();
}

function requireAdmin(req, res, next) {
    if (getBearer(req) !== CONFIG.adminToken) {
        return fail(res, 403, 9001, '管理员权限无效');
    }
    next();
}

// 大屏 token 或 admin token 均可（只读接口）
function screenOrAdmin(req, res, next) {
    const st = String(req.query.screenToken || '').trim();
    if (CONFIG.screenToken && st === CONFIG.screenToken) return next();
    return requireAdmin(req, res, next);
}

module.exports = { requireUser, requireAdmin, screenOrAdmin };
