'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createSxrPreview, DATA_VERSION } = require('./sxr-iserver-preview');
const { createManagementStore } = require('./sxr-management-store');

const root = path.resolve(__dirname, '../public');
const port = Number(process.env.SJP_DEMO_PORT) || 4173;
const sxr = createSxrPreview();
const management = createManagementStore();
const backendBase = String(process.env.SJP_BACKEND_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const backendAdminToken = String(process.env.ADMIN_TOKEN || '').trim();
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(payload));
}

function ok(data) {
    return { success: true, code: 0, message: '', data };
}

function roadFeatureCollection(graph) {
    const features = (graph?.edges || []).flatMap(edge => {
        const geometry = edge?.geometry;
        if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) return [];
        return [{
            type: 'Feature',
            properties: {
                edgeId: String(edge.edgeId || ''),
                name: String(edge.name || edge.edgeId || ''),
                status: String(edge.status || 'open'),
                congestion: String(edge.congestion || 'smooth')
            },
            geometry
        }];
    });
    return {
        type: 'FeatureCollection',
        source: graph?.source || 'unknown',
        dataVersion: graph?.dataVersion || DATA_VERSION,
        features
    };
}

async function readBackendHealth() {
    const headers = { Accept: 'application/json' };
    if (backendAdminToken) headers.Authorization = `Bearer ${backendAdminToken}`;
    const response = await fetch(`${backendBase}/api/admin/geosync/health`, {
        headers,
        signal: AbortSignal.timeout(3000)
    });
    const payload = await response.json();
    if (![200, 503].includes(response.status) || !payload || typeof payload !== 'object') {
        throw new Error(`BACKEND_HEALTH_HTTP_${response.status}`);
    }
    return payload;
}

async function createPreviewHealth() {
    try {
        const [backend, graph] = await Promise.all([readBackendHealth(), sxr.getGraph()]);
        const mongo = backend.mongo || { state: 'offline' };
        const jobs = backend.jobs || { state: 'offline', running: false };
        const mongoOnline = mongo.state === 'online';
        const jobsOnline = jobs.running === true || ['online', 'ready'].includes(jobs.state);
        return {
            state: mongoOnline && jobsOnline ? 'online' : 'degraded',
            gis: {
                state: 'online',
                source: graph.source,
                readOnly: graph.readOnly === true,
                fallbackReason: graph.fallbackReason || null
            },
            mongo,
            jobs: { ...jobs, state: jobsOnline ? 'online' : jobs.state },
            dataVersion: DATA_VERSION,
            backend: { state: backend.state || 'unknown', baseUrl: backendBase },
            preview: { readOnly: false, sourceDataReadOnly: true, localManagement: true }
        };
    } catch (error) {
        let graph = null;
        try { graph = await sxr.getGraph(); } catch { /* Report both dependencies below. */ }
        return {
            state: 'degraded',
            gis: graph
                ? { state: 'online', source: graph.source, readOnly: graph.readOnly === true,
                    fallbackReason: graph.fallbackReason || null }
                : { state: 'offline', source: 'unavailable' },
            mongo: { state: 'offline', reason: 'backend-unavailable' },
            jobs: { state: 'offline', running: false, reason: 'backend-unavailable' },
            dataVersion: DATA_VERSION,
            backend: {
                state: 'offline',
                baseUrl: backendBase,
                error: String(error?.message || 'BACKEND_HEALTH_FAILED').slice(0, 80)
            },
            preview: { readOnly: false, sourceDataReadOnly: true, localManagement: true }
        };
    }
}

function readJson(request, maxBytes = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('REQUEST_TOO_LARGE'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch { reject(new Error('JSON_INVALID')); }
        });
        request.on('error', reject);
    });
}

function managementError(response, error) {
    const code = String(error?.message || 'MANAGEMENT_FAILED');
    const notFound = code === 'POI_NOT_FOUND' || code === 'EDGE_NOT_FOUND';
    const messages = {
        POI_NAME_REQUIRED: '景点名称不能为空',
        POI_COORDINATE_INVALID: '经纬度必须是有效的 WGS84 坐标',
        POI_PHOTO_INVALID: '照片必须是 3MB 以内的 JPG、PNG 或 WebP 图片',
        POI_NOT_FOUND: '景点不存在',
        EDGE_NOT_FOUND: '路段不存在',
        EDGE_STATUS_INVALID: '道路状态无效',
        EDGE_CONGESTION_INVALID: '拥堵状态无效',
        EDGE_PATCH_EMPTY: '没有可更新的道路字段',
        REQUEST_TOO_LARGE: '请求内容超过大小限制',
        JSON_INVALID: '请求内容不是有效 JSON'
    };
    sendJson(response, notFound ? 404 : 400, {
        success: false, code: notFound ? 8101 : 1101,
        message: messages[code] || '管理操作失败', data: { errorCode: code }
    });
}

async function servePreviewApi(url, request, response) {
    const { pathname } = url;
    if (pathname === '/api/geosync/client-config') {
        try {
            const config = await sxr.getConfig();
            sendJson(response, 200, ok({
                ...config,
                preview: {
                    ...config.preview,
                    readOnly: false,
                    sourceDataReadOnly: true,
                    localManagement: true
                }
            }));
        } catch (error) {
            sendJson(response, 502, {
                success: false, code: 8201, message: 'SXR GIS 配置读取失败',
                data: { errorCode: String(error?.message || 'SXR_PREVIEW_FAILED').slice(0, 80) }
            });
        }
        return true;
    }
    if (pathname === '/api/admin/geosync/graph') {
        try {
            sendJson(response, 200, ok(management.applyGraph(await sxr.getGraph())));
        } catch (error) {
            sendJson(response, 502, {
                success: false, code: 8201, message: 'SXR iServer 路网读取失败',
                data: { errorCode: String(error?.message || 'SXR_PREVIEW_FAILED').slice(0, 80) }
            });
        }
        return true;
    }
    if (pathname === '/api/geosync/road-network') {
        try {
            sendJson(response, 200, ok(roadFeatureCollection(management.applyGraph(await sxr.getGraph()))));
        } catch (error) {
            sendJson(response, 502, {
                success: false, code: 8201, message: '路网读取失败',
                data: { errorCode: String(error?.message || 'ROAD_NETWORK_FAILED').slice(0, 80) }
            });
        }
        return true;
    }
    if (pathname === '/api/admin/geosync/pois') {
        try {
            if (request.method === 'GET') sendJson(response, 200, ok({ items: management.listPois() }));
            else if (request.method === 'POST') sendJson(response, 201, ok(management.createPoi(await readJson(request))));
            else return false;
        } catch (error) { managementError(response, error); }
        return true;
    }
    const poiMatch = pathname.match(/^\/api\/admin\/geosync\/pois\/([^/]+)$/);
    if (poiMatch && ['PUT', 'DELETE'].includes(request.method)) {
        try {
            const poiId = decodeURIComponent(poiMatch[1]);
            const result = request.method === 'DELETE'
                ? management.deletePoi(poiId)
                : management.updatePoi(poiId, await readJson(request));
            sendJson(response, 200, ok(result));
        } catch (error) { managementError(response, error); }
        return true;
    }
    const edgeEditMatch = pathname.match(/^\/api\/admin\/geosync\/graph\/edge\/([^/]+)\/operations$/);
    if (edgeEditMatch && request.method === 'PATCH') {
        try {
            const edgeId = decodeURIComponent(edgeEditMatch[1]);
            const graph = await sxr.getGraph();
            if (!graph.edges.some(edge => String(edge.edgeId) === edgeId)) throw new Error('EDGE_NOT_FOUND');
            sendJson(response, 200, ok(management.updateEdge(edgeId, await readJson(request))));
        } catch (error) { managementError(response, error); }
        return true;
    }
    const edgeStateMatch = pathname.match(/^\/api\/admin\/geosync\/graph\/edge\/([^/]+)\/(close|open)$/);
    if (edgeStateMatch && request.method === 'POST') {
        try {
            const edgeId = decodeURIComponent(edgeStateMatch[1]);
            const status = edgeStateMatch[2] === 'close' ? 'closed' : 'open';
            const graph = await sxr.getGraph();
            if (!graph.edges.some(edge => String(edge.edgeId) === edgeId)) throw new Error('EDGE_NOT_FOUND');
            const body = await readJson(request);
            const result = management.updateEdge(edgeId, {
                status,
                ...(status === 'closed' && body.reason ? { warning: body.reason } : {})
            });
            sendJson(response, 202, ok({
                ...result,
                eventId: `local_${Date.now().toString(36)}`,
                acceptedAt: new Date().toISOString()
            }));
        } catch (error) { managementError(response, error); }
        return true;
    }
    if (pathname === '/api/admin/geosync/health' || pathname === '/api/screen/geosync/health'
        || pathname === '/api/geosync/health') {
        sendJson(response, 200, ok(await createPreviewHealth()));
        return true;
    }
    if (pathname === '/api/admin/geosync/dashboard') {
        sendJson(response, 200, ok({
            activeItineraries: null, todayCheckins: null, avgSavedMin: null,
            rerouteAcceptRate: null, top10: [], alerts: []
        }));
        return true;
    }
    if (pathname === '/api/crowd/heatmap') {
        sendJson(response, 200, ok({
            slot: new Date().toISOString().slice(0, 16), items: [], lowConfidence: true
        }));
        return true;
    }
    if (pathname === '/api/admin/geosync/replay') {
        sendJson(response, 200, ok({ date: '', slots: [], frames: {}, pois: [] }));
        return true;
    }
    return false;
}

http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
    }
    if (await servePreviewApi(url, request, response)) return;
    const entries = {
        '/ops': '/ops.html',
        '/screen': '/screen.html',
        '/tour': '/tour.html',
        '/workspace': '/workspace.html',
        '/': '/workspace.html'
    };
    const pathname = entries[url.pathname] || url.pathname;
    const target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(target, (error, data) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
            return;
        }
        response.writeHead(200, {
            'Content-Type': types[path.extname(target)] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        response.end(data);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(`SJP demo: http://127.0.0.1:${port}/ops?demo=1`);
    console.log(`SXR GIS preview: http://127.0.0.1:${port}/ops?gis=1`);
    console.log(`ZZX tourist demo: http://127.0.0.1:${port}/tour?demo=1`);
    console.log(`Three-client workspace: http://127.0.0.1:${port}/workspace`);
});
