export class OpsApiError extends Error {
    constructor(message, { status = 0, code = 0, data = null } = {}) {
        super(message);
        this.name = 'OpsApiError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

function adminToken() {
    try { return sessionStorage.getItem('geosync.adminToken') || ''; } catch { return ''; }
}

export class OpsApi {
    constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
        this.fetchImpl = fetchImpl;
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.controllers = new Set();
    }

    async request(path, { method = 'GET', body, timeoutMs = 10000, headers = {} } = {}) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const token = adminToken();
        const requestHeaders = new Headers(headers);
        if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
        if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                credentials: 'same-origin',
                headers: requestHeaders,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
            let payload;
            try { payload = await response.json(); } catch { payload = null; }
            if (!response.ok || payload?.success === false) {
                throw new OpsApiError(payload?.message || `请求失败 (${response.status})`, {
                    status: response.status,
                    code: Number(payload?.code) || 0,
                    data: payload?.data ?? null
                });
            }
            return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
        } catch (error) {
            if (error instanceof OpsApiError) throw error;
            if (error?.name === 'AbortError') throw new OpsApiError('请求超时，请查询最新路网状态');
            throw new OpsApiError('网络连接失败');
        } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
        }
    }

    getConfig() { return this.request('/api/geosync/client-config'); }
    getHealth() { return this.request('/api/admin/geosync/health'); }
    getDashboard() { return this.request('/api/admin/geosync/dashboard'); }
    getHeatmap() { return this.request('/api/crowd/heatmap'); }
    getGraph() { return this.request('/api/admin/geosync/graph'); }
    getGisStatus() { return this.request('/api/admin/geosync/gis/status'); }
    getReplay(date) { return this.request(`/api/admin/geosync/replay?date=${encodeURIComponent(date)}`); }
    getManagedPois() { return this.request('/api/admin/geosync/pois'); }
    createPoi(poi) {
        return this.request('/api/admin/geosync/pois', { method: 'POST', body: poi, timeoutMs: 15000 });
    }
    updatePoi(poiId, poi) {
        return this.request(`/api/admin/geosync/pois/${encodeURIComponent(poiId)}`, {
            method: 'PUT', body: poi, timeoutMs: 15000
        });
    }
    deletePoi(poiId) {
        return this.request(`/api/admin/geosync/pois/${encodeURIComponent(poiId)}`, { method: 'DELETE' });
    }
    updateEdge(edgeId, patch) {
        return this.request(`/api/admin/geosync/graph/edge/${encodeURIComponent(edgeId)}/operations`, {
            method: 'PATCH', body: patch, timeoutMs: 12000
        });
    }
    closeEdge(edgeId, reason, durationMin) {
        return this.request(`/api/admin/geosync/graph/edge/${encodeURIComponent(edgeId)}/close`, {
            method: 'POST', body: { reason, durationMin }, timeoutMs: 12000
        });
    }
    openEdge(edgeId) {
        return this.request(`/api/admin/geosync/graph/edge/${encodeURIComponent(edgeId)}/open`, {
            method: 'POST', body: {}, timeoutMs: 12000
        });
    }
    destroy() {
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }
}
