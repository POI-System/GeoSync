'use strict';
// 01文档 §4：新增配置项集中读取。缺必填项 → 警告并禁用对应子功能，不崩溃。

const path = require('path');
const { validateSessionSecret } = require('./lib/sessionAuth');

function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function parseCenter(raw) {
    if (!raw) return null;
    const parts = String(raw).split(',').map(Number);
    if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) return null;
    return parts; // [lng, lat]
}

function bool(v, def) {
    if (v === undefined || v === null || v === '') return def;
    const value = String(v).trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return def;
}

const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const requestedSignedAuth = bool(process.env.AUTH_SIGN_REQUIRED, true);

const CONFIG = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    scenicId: process.env.SCENIC_ID || 'default',
    scenicCenter: parseCenter(process.env.SCENIC_CENTER),          // [lng,lat] | null
    fenceRadiusM: num(process.env.SCENIC_FENCE_RADIUS_M, 3000),
    positionMinIntervalS: num(process.env.POSITION_MIN_INTERVAL_S, 30),
    presenceLeaseMinutes: Math.min(10, Math.max(5, num(process.env.PRESENCE_LEASE_MINUTES, 10))),
    ciSlotMinutes: num(process.env.CI_SLOT_MINUTES, 10),
    ci: {
        alpha: num(process.env.CI_ALPHA, 0.5),
        beta: num(process.env.CI_BETA, 0.3),
        gamma: num(process.env.CI_GAMMA, 0.2)
    },
    rerouteGainMin: num(process.env.REROUTE_GAIN_MIN, 5),
    rerouteDailySoftLimit: num(process.env.REROUTE_DAILY_SOFT_LIMIT, 3),
    barrierRerouteConcurrency: num(process.env.BARRIER_REROUTE_CONCURRENCY, 6),
    capacityTokenTtlS: num(process.env.CAPACITY_TOKEN_TTL_S, 300),
    hmacSecret: process.env.POSITION_HMAC_SECRET || '',
    sessionSecret: String(process.env.AUTH_SESSION_SECRET || ''),
    screenToken: String(process.env.SCREEN_TOKEN || '').trim(),
    adminToken: String(process.env.ADMIN_TOKEN || '').trim(),
    adminUsername: String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin',
    uploadDir: process.env.GEOSYNC_UPLOAD_DIR
        ? path.resolve(process.env.GEOSYNC_UPLOAD_DIR)
        : path.join(__dirname, 'uploads'),
    rain: { url: process.env.RAIN_API_URL || '', key: process.env.RAIN_API_KEY || '' },
    weather: { url: process.env.WEATHER_API_URL || '', key: process.env.WEATHER_API_KEY || '' },
    llm: {
        url: process.env.LLM_API_URL || '',
        key: process.env.LLM_API_KEY || '',
        model: process.env.LLM_MODEL || 'claude-sonnet-5'
    },
    demTileDir: process.env.DEM_TILE_DIR || './dem',
    holidayApiUrl: process.env.HOLIDAY_API_URL || '',
    simMode: process.env.SIM_MODE === 'true',
    simStrategy: process.env.SIM_STRATEGY || 'anti-herding',
    authSignRequired: nodeEnv === 'production' ? true : requestedSignedAuth,
    legacyOpenIdEnabled: nodeEnv !== 'production' && requestedSignedAuth === false
};

// features：client-config 注入 + 启动自检（08文档 §4 health 也读这里）
CONFIG.features = {
    rain: Boolean(CONFIG.rain.url && CONFIG.rain.key),
    weather: Boolean(CONFIG.weather.url && CONFIG.weather.key),
    nlEdit: Boolean(CONFIG.llm.url && CONFIG.llm.key),
    guide: Boolean(CONFIG.llm.url && CONFIG.llm.key),
    pairing: true
};

function validateOnBoot() {
    const warn = m => console.warn('[GeoSync] [CONFIG]', m);
    if (CONFIG.isProduction && CONFIG.simMode) {
        const error = new Error('SIM_MODE is forbidden when NODE_ENV=production');
        error.code = 'GEOSYNC_SIM_MODE_FORBIDDEN';
        throw error;
    }
    if (CONFIG.isProduction && requestedSignedAuth === false) {
        warn('AUTH_SIGN_REQUIRED=false is ignored in production');
    }
    if (CONFIG.authSignRequired) {
        try {
            validateSessionSecret(CONFIG.sessionSecret, { name: 'AUTH_SESSION_SECRET' });
        } catch {
            warn('AUTH_SESSION_SECRET is missing or unsafe; signed user authentication will fail closed');
        }
    } else {
        warn('legacy X-Open-Id compatibility is enabled for non-production use only');
    }
    if (!CONFIG.scenicCenter) warn('SCENIC_CENTER 未配置，围栏/降雨功能受限');
    if (!CONFIG.hmacSecret || CONFIG.hmacSecret === 'change-me-to-random-hex') {
        warn('POSITION_HMAC_SECRET 未配置或为默认值，位置采集将被禁用');
    }
    for (const [k, v] of Object.entries(CONFIG.features)) {
        if (!v) warn(`功能 ${k} 未配置，已禁用`);
    }
    if (CONFIG.simMode) warn('SIM_MODE 已开启 —— 生产环境必须关闭！');
}

module.exports = { CONFIG, validateOnBoot, bool };
