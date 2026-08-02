'use strict';
// 01文档 §3：装配入口。attach({app, io, models, helpers}) 为唯一挂接点。
// 独立模式由 standalone.js 构造同样的参数调用。

const express = require('express');
const path = require('path');
const { CONFIG, validateOnBoot } = require('./config');
const { registerModels, getModels } = require('./models');
const bus = require('./lib/eventBus');
const memCache = require('./lib/memCache');
const geo = require('./lib/geo');
const { requireAdmin, screenOrAdmin } = require('./lib/auth');
const { wrap } = require('./lib/respond');
const { createSuperMapGateway } = require('./integrations/supermap');
const notifyBridge = require('./services/notifyBridge');
const walkGraph = require('./services/walkGraph');
const engine = require('./services/geosyncEngine');
const checkinService = require('./services/checkinService');
const horizonBuilder = require('./services/horizonBuilder');
const pairingService = require('./services/pairingService');
const crowdService = require('./services/crowdService');
const rainService = require('./services/rainService');
const antiHerding = require('./services/antiHerding');
const forecastService = require('./services/forecastService');
const { createItineraryRuntime } = require('./services/itineraryRuntime');
const { startJobs } = require('./jobs');

// ===================== SSE 连接池（04文档 §2）=====================
const sseClients = new Set();

function sseSend(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(frame); } catch { sseClients.delete(res); }
    }
}

function sseHandler(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    // 建连即推当前快照（避免大屏空窗）
    const snap = crowdService.getHeatmapSnapshot();
    if (snap) res.write(`event: heatmap\ndata: ${JSON.stringify(snap)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
}

let sseTimers = [];
function startSseLoops() {
    const hb = setInterval(() => {
        for (const res of sseClients) {
            try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
        }
    }, 25000);
    const stats = setInterval(async () => {
        if (!sseClients.size) return;
        try {
            const { Itinerary, Checkin } = getModels();
            const today = geo.dateStrOf(new Date());
            const [activeItineraries, todayCheckins] = await Promise.all([
                Itinerary.countDocuments({ state: 'active' }),
                Checkin.countDocuments({ date: today })
            ]);
            sseSend('stats', { activeItineraries, todayCheckins });
        } catch (e) {
            console.error('[GeoSync] [SSE] stats failed:', e.message);
        }
    }, 60000);
    hb.unref(); stats.unref();
    sseTimers = [hb, stats];
}

// ===================== Socket.io 房间协议（04文档 §1.1）=====================
function bindSocket(io, getSocketIdentity) {
    notifyBridge.setIo(io);
    io.on('connection', socket => {
        // 只新增事件监听，不动宿主已有 connection handler
        socket.on('geosync:join', async () => {
            try {
                const identity = await getSocketIdentity(socket);
                const openId = String(identity?.openId || '').trim();
                const scenicId = CONFIG.scenicId;
                const rooms = [];
                if (identity?.isAdmin === true) {
                    rooms.push(`admin:${scenicId}`);
                } else {
                    if (!openId) return socket.emit('geosync:joined', { ok: false, message: '缺少身份' });
                    const { ExternalUser } = getModels();
                    const user = await ExternalUser.findOne({ openId }).lean();
                    if (!user) return socket.emit('geosync:joined', { ok: false, message: '用户不存在' });
                    rooms.push(`scenic:${scenicId}`, `user:${openId}`);
                }
                for (const r of rooms) socket.join(r);
                socket.emit('geosync:joined', { ok: true, rooms });
            } catch (e) {
                console.error('[GeoSync] [SOCKET] join failed:', e.message);
                socket.emit('geosync:joined', { ok: false, message: '加入失败' });
            }
        });
    });
}

// ===================== 事件总线 → Socket/SSE 桥接（04文档 §1.2）=====================
function bridgeEvents(io) {
    const scenicRoom = `scenic:${CONFIG.scenicId}`;
    const adminRoom = `admin:${CONFIG.scenicId}`;

    // CI 快照帧（jobs/ciAggregate 完成后发）→ SSE heatmap
    bus.on(bus.EVENTS.CI_UPDATED, snap => sseSend('heatmap', snap));

    // CI 跨档 → scenic 房间（同 POI 60s 节流）
    bus.on(bus.EVENTS.CI_LEVEL_CHANGED, p => {
        if (!memCache.rateLimit(`sock:crowd:${p.poiId}`, 1, 60000)) return;
        io.to(scenicRoom).emit('crowd:update', {
            poiId: p.poiId, name: p.name, ci: p.ci, level: p.level, prevLevel: p.prevLevel
        });
    });

    // 降雨（同事件 30min 去重）
    bus.on(bus.EVENTS.RAIN_INCOMING, p => {
        if (!memCache.rateLimit('sock:rain', 1, 30 * 60000)) return;
        const startStr = new Date(p.startAt).toTimeString().slice(0, 5);
        io.to(scenicRoom).emit('rain:incoming', {
            ...p, text: `预计${startStr}开始降雨约${p.durationMin}分钟`
        });
    });
    bus.on(bus.EVENTS.RAIN_CLEARED, () => io.to(scenicRoom).emit('rain:cleared', {}));

    // 改道提案 → 用户房间（离线降级在 notifyBridge 内）
    bus.on(bus.EVENTS.REROUTE_PROPOSED, async ({ itinerary, proposal }) => {
        await notifyBridge.pushProposal(itinerary.openId, {
            itineraryId: itinerary._id, version: itinerary.version, ...proposal
        });
    });

    bus.on(bus.EVENTS.ITINERARY_PROGRESS, payload => {
        io.to(`user:${payload.openId}`).emit('itinerary:progress', payload);
    });

    // 打卡异步通过（人工审核）
    bus.on(bus.EVENTS.CHECKIN_VERIFIED, p => {
        io.to(`user:${p.openId}`).emit('checkin:verified', {
            checkinId: p.checkinId, status: 'verified', points: p.points, badge: p.badge || null
        });
        if (p.badge?.unlocked) {
            io.to(`user:${p.openId}`).emit('badge:unlock', { badgeId: p.badge.id, name: p.badge.name });
        }
    });

    // 帮拍：proposed 双方各推脱敏视图；confirmed 推双方
    bus.on(bus.EVENTS.PAIRING_PROPOSED, ({ pairing, confirmed }) => {
        for (const u of pairing.users) {
            const view = pairingService.publicView(pairing, u.openId);
            io.to(`user:${u.openId}`).emit(
                confirmed ? 'pairing:confirmed' : 'pairing:proposed',
                {
                    pairingId: pairing._id, spotId: pairing.spotId,
                    codename: view.other?.codename,
                    plannedArrive: view.other?.plannedArrive,
                    expireAt: pairing.expireAt
                }
            );
        }
    });

    // 封路/恢复 → scenic + admin
    const emitGraph = status => p => {
        const payload = { edgeId: p.edgeId, status };
        io.to(scenicRoom).emit('graph:update', payload);
        io.to(adminRoom).emit('graph:update', payload);
    };
    bus.on(bus.EVENTS.EDGE_CLOSED, emitGraph('closed'));
    bus.on(bus.EVENTS.EDGE_OPENED, emitGraph('open'));

    // 预警 → admin 房 + SSE + 最近10条环形缓冲（dashboard 用）
    bus.on(bus.EVENTS.ALERT_CROWD, p => {
        const alert = { ...p, at: new Date() };
        const buf = memCache.get('recentAlerts') || [];
        buf.unshift(alert);
        memCache.set('recentAlerts', buf.slice(0, 10));
        io.to(adminRoom).emit('alert:crowd', p);
        sseSend('alert', p);
    });

    // 机位过审 → horizon 预计算队列
    bus.on(bus.EVENTS.SPOT_APPROVED, ({ spotId }) => horizonBuilder.enqueue(spotId));

    // 围栏进入 → 已确认帮拍的 arrivedAt 回填（05文档 §9 履约）
    bus.on(bus.EVENTS.STAY_OPENED, async ({ poiId, userIdHash }) => {
        try {
            const { Pairing } = getModels();
            const pairs = await Pairing.find({ state: 'confirmed', poiId });
            for (const p of pairs) {
                let touched = false;
                for (const u of p.users) {
                    if (!u.arrivedAt && geo.userIdHash(u.openId, CONFIG.hmacSecret) === userIdHash) {
                        u.arrivedAt = new Date();
                        touched = true;
                    }
                }
                if (touched) await p.save();
            }
        } catch (e) {
            console.error('[GeoSync] [PAIRING] arrivedAt backfill:', e.message);
        }
    });
}

function initItineraryProgress() {
    const { Itinerary } = getModels();
    const queues = new Map();
    const runtime = createItineraryRuntime({
        Itinerary,
        onReleaseTokens: (tokenIds, context) =>
            antiHerding.releaseTokens(tokenIds, context.itinerary._id)
    });
    const publish = async result => {
        if (result.status !== 'updated') return;
        if (result.releaseError) {
            console.error('[GeoSync] [ITINERARY] token release failed:', result.releaseError.message);
        }
        await forecastService.rebuildArrivalIndex().catch(error =>
            console.error('[GeoSync] [ITINERARY] arrival index rebuild failed:', error.message));
        const itinerary = result.itinerary;
        bus.emit(bus.EVENTS.ITINERARY_PROGRESS, {
            openId: itinerary.openId,
            itineraryId: itinerary._id,
            version: itinerary.version,
            state: itinerary.state,
            stops: itinerary.stops.map(stop => ({
                stopId: stop._id,
                poiId: stop.poiId,
                state: stop.state,
                actualArrive: stop.actualArrive || null,
                actualLeave: stop.actualLeave || null
            }))
        });
    };
    const enqueue = async (payload, operation) => {
        const key = String(payload.openId || payload.itineraryId || 'unknown');
        const previous = queues.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        queues.set(key, next);
        try {
            return await next;
        } finally {
            if (queues.get(key) === next) queues.delete(key);
        }
    };
    bus.on(bus.EVENTS.STAY_OPENED, async payload => {
        if (!payload.openId && !payload.itineraryId) return;
        await enqueue(payload, async () => publish(await runtime.stayOpened(payload)));
    });
    bus.on(bus.EVENTS.STAY_CLOSED, async payload => {
        if (!payload.openId && !payload.itineraryId) return;
        await enqueue(payload, async () => publish(await runtime.stayClosed(payload)));
    });
}

// ===================== 仿真通道（07文档 §1.1，SIM_MODE 下才挂载）=====================
function simRouter() {
    const router = express.Router();
    let seq = 0;

    // 注册虚拟游客：返回 sim_<n> openId 并写入 users
    router.post('/register', async (req, res) => {
        const { ExternalUser } = getModels();
        const openId = `sim_${Date.now().toString(36)}_${++seq}`;
        await ExternalUser.create({ openId, nickname: `仿真游客${seq}`, isSim: true, createTime: new Date() });
        res.json({ success: true, code: 0, data: { openId }, message: '' });
    });

    // 注入假降雨事件（剧本 rain）
    router.post('/rain', async (req, res) => {
        const startInMin = Number(req.body?.startInMin) || 10;
        const durationMin = Number(req.body?.durationMin) || 30;
        await rainService.injectRain(startInMin, durationMin);
        res.json({ success: true, code: 0, data: { injected: true }, message: '' });
    });

    // 扫码打卡 token（仿真 agent 跳过 OCR 用）
    router.get('/qrtoken/:poiId', (req, res) => {
        const t = `${req.params.poiId}.${checkinService.qrTokenOf(req.params.poiId)}`;
        res.json({ success: true, code: 0, data: { qrToken: t }, message: '' });
    });

    return router;
}

function mongoStatusOf(mongoose) {
    const states = ['offline', 'online', 'connecting', 'disconnecting'];
    const readyState = Number(mongoose?.connection?.readyState);
    return {
        state: states[readyState] || 'offline',
        readyState: Number.isInteger(readyState) ? readyState : 0
    };
}

// ===================== attach（唯一挂接点）=====================
let attachmentResult = null;
let attachmentError = null;

async function defaultSocketIdentity(socket) {
    const openId = String(socket?.openId || '').trim();
    if (!openId) return null;
    const { ExternalUser } = getModels();
    const user = await ExternalUser.findOne({ openId }).lean();
    if (!user) return null;
    return { openId, role: user.role || '', isAdmin: user.role === 'admin' };
}

function attach({
    app,
    io,
    mongoose = require('mongoose'),
    models = {},
    helpers = {},
    options = {}
}) {
    if (attachmentResult) return attachmentResult;
    if (attachmentError) throw attachmentError;
    if (!app || typeof app.use !== 'function') throw new TypeError('GeoSync attach requires an Express app');
    if (!mongoose || typeof mongoose.model !== 'function') throw new TypeError('GeoSync attach requires Mongoose');

    const startBackground = options.startBackground !== false;
    const mountUploads = options.mountUploads !== false;
    const getSocketIdentity = helpers.getSocketIdentity || defaultSocketIdentity;

    validateOnBoot();
    registerModels(mongoose, models);
    if (helpers.uploadDir) CONFIG.uploadDir = path.resolve(helpers.uploadDir);
    const superMapGateway = options.superMapGateway || createSuperMapGateway({
        logger: helpers.gisLogger || console
    });

    try {
        // 宿主能力注入：微信模板/邮件/OCR（独立模式为空 → 自动降级）
        notifyBridge.setHelpers({ sendTemplate: helpers.sendTemplate, sendMail: helpers.sendMail });
        if (helpers.ocr) checkinService.setOcrFn(helpers.ocr);

        // ---- 路由（03文档路径前缀）----
        const crowdRoutes = require('./routes/crowd');
        const { pairingRouter, guideRouter } = require('./routes/pairing');
        app.use('/api/itinerary', require('./routes/itinerary'));
        app.post('/api/position', ...crowdRoutes.positionHandler);
        app.use('/api/crowd', crowdRoutes.router);
        app.use('/api/photospots', require('./routes/photospots'));
        app.use('/api/checkin', require('./routes/checkin'));
        app.use('/api/pairing', pairingRouter);
        app.use('/api/guide', guideRouter);
        app.get('/api/admin/geosync/gis/status', requireAdmin, wrap(async (req, res) => {
            const status = await superMapGateway.getStatus({
                force: req.query.force === 'true' || req.query.refresh === 'true',
                requestId: req.headers['x-request-id']
            });
            res.json({ success: true, code: 0, data: status, message: '' });
        }));
        app.use('/api/admin/geosync', require('./routes/admin'));
        app.get('/api/screen/stream', screenOrAdmin, sseHandler);
        if (mountUploads) app.use('/uploads', express.static(CONFIG.uploadDir));
        if (CONFIG.simMode) app.use('/api/sim', simRouter());

        // 健康端点（08文档 §4）
        app.get('/api/geosync/health', wrap(async (req, res) => {
            const snap = crowdService.getHeatmapSnapshot();
            const mongo = mongoStatusOf(mongoose);
            const gis = await superMapGateway.getStatus({ requestId: req.headers['x-request-id'] });
            const diagnostics = superMapGateway.getDiagnostics();
            const coreAvailable = mongo.state === 'online';
            res.status(coreAvailable ? 200 : 503).json({
                graphLoaded: walkGraph.isReady(),
                jobsRunning: startBackground,
                lastCiSlot: snap?.slot || null,
                rainSource: CONFIG.features.rain ? 'minute' : CONFIG.features.weather ? 'hourly' : 'off',
                llm: CONFIG.features.guide,
                simMode: CONFIG.simMode,
                mongo,
                gis,
                manifest: gis.manifest,
                cache: {
                    routeCount: diagnostics.routeCacheSize,
                    lastInvalidationReason: diagnostics.lastInvalidationReason
                },
                lastSuccessfulGisAt: diagnostics.lastSuccessAt
            });
        }));

        // client-config features 注入（前端降级链读取）
        app.get('/api/geosync/client-config', (req, res) => {
            const gis = superMapGateway.getPublicConfig();
            res.json({
                success: true, code: 0, message: '',
                data: {
                    scenicId: CONFIG.scenicId,
                    scenicCenter: CONFIG.scenicCenter,
                    features: {
                        ...CONFIG.features,
                        supermap: Boolean(gis.enabled && gis.features?.supermap)
                    },
                    gis
                }
            });
        });

        // ---- 实时 + 引擎 + 任务 ----
        if (io) {
            bindSocket(io, getSocketIdentity);
            bridgeEvents(io);
        }
        initItineraryProgress();
        engine.init();

        const readiness = [];
        readiness.push(superMapGateway.getStatus({ refresh: true }).then(status => {
            if (status.state === 'offline') {
                console.warn('[GeoSync] [GIS] offline at startup', status.error?.code || 'ISERVER_OFFLINE');
            }
            return status;
        }));
        if (startBackground) {
            startSseLoops();
            startJobs();
            readiness.push(walkGraph.loadIntoMemory().catch(e => {
                console.error('[GeoSync] [GRAPH] load failed (planner 将返回 1201):', e.message);
                throw e;
            }));
            readiness.push(crowdService.refreshPoiIndex().catch(e => {
                console.error('[GeoSync] [POI] index load failed:', e.message);
                throw e;
            }));
        }

        attachmentResult = {
            attached: true,
            backgroundStarted: startBackground,
            superMapGateway,
            readiness: Promise.allSettled(readiness)
        };
        console.log(`[GeoSync] attached — routes/socket ready, background=${startBackground}`);
        return attachmentResult;
    } catch (error) {
        attachmentError = error;
        throw error;
    }
}

module.exports = { attach, sseSend };
