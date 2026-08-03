const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
    constructor(message, { code = 0, status = 0, data = null, cause = null, retryable = false } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ApiError';
        this.code = Number(code) || 0;
        this.status = Number(status) || 0;
        this.data = data;
        this.retryable = retryable;
    }
}

function requestBody(body) {
    if (body === undefined || body === null) return undefined;
    if (body instanceof FormData || body instanceof URLSearchParams || typeof body === 'string') return body;
    return JSON.stringify(body);
}

function retryableStatus(status) {
    return status === 429 || status >= 500;
}

export class ApiClient {
    constructor({ baseUrl = '', openId = '', allowLegacyOpenId = false } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.controllers = new Map();
        const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        this.legacyOpenId = allowLegacyOpenId && localHost ? String(openId).trim() : '';
    }

    async request(path, options = {}) {
        const key = options.key || `${options.method || 'GET'}:${path}`;
        if (options.cancelPrevious !== false) this.cancel(key);
        const controller = new AbortController();
        this.controllers.set(key, controller);
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
        const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
        const headers = new Headers(options.headers || {});
        const body = requestBody(options.body);
        if (body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        if (this.legacyOpenId) headers.set('X-Open-Id', this.legacyOpenId);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: options.method || 'GET',
                credentials: 'same-origin',
                headers,
                body,
                signal: controller.signal
            });
            const text = await response.text();
            let payload = null;
            if (text) {
                try {
                    payload = JSON.parse(text);
                } catch (cause) {
                    throw new ApiError('服务返回了无法识别的数据', { status: response.status, cause, retryable: response.status >= 500 });
                }
            }
            if (!response.ok || payload?.success === false) {
                throw new ApiError(payload?.message || `请求失败（${response.status}）`, {
                    code: payload?.code,
                    status: response.status,
                    data: payload?.data,
                    retryable: retryableStatus(response.status)
                });
            }
            return payload?.data ?? payload;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
                throw new ApiError(error?.name === 'TimeoutError' ? '请求超时，请稍后重试' : '请求已取消', {
                    cause: error,
                    retryable: error?.name === 'TimeoutError'
                });
            }
            throw new ApiError('网络连接失败，请检查连接后重试', { cause: error, retryable: true });
        } finally {
            clearTimeout(timeout);
            if (this.controllers.get(key) === controller) this.controllers.delete(key);
        }
    }

    cancel(key) {
        const controller = this.controllers.get(key);
        if (controller) controller.abort();
        this.controllers.delete(key);
    }

    cancelAll() {
        for (const controller of this.controllers.values()) controller.abort();
        this.controllers.clear();
    }

    getClientConfig() { return this.request('/api/geosync/client-config', { key: 'config' }); }
    getPois() { return this.request('/api/poi/all', { key: 'pois' }); }
    getCurrentItinerary() { return this.request('/api/itinerary/current', { key: 'current' }); }
    getHeatmap() { return this.request('/api/crowd/heatmap', { key: 'heatmap' }); }
    getPhotoSpots(params = {}) {
        const query = new URLSearchParams();
        if (params.near) query.set('near', params.near.join(','));
        if (params.radius) query.set('radius', params.radius);
        query.set('sort', params.sort || 'score');
        return this.request(`/api/photospots?${query}`, { key: 'photospots' });
    }
    getGoldenWindow(id) { return this.request(`/api/photospots/${encodeURIComponent(id)}/golden`, { key: `golden:${id}` }); }
    getArData(id) { return this.request(`/api/photospots/${encodeURIComponent(id)}/ar`, { key: `ar:${id}` }); }
    plan(payload) { return this.request('/api/itinerary/plan', { method: 'POST', body: payload, timeoutMs: 6500, key: 'plan' }); }
    start(id, version) { return this.writeItinerary(id, 'start', { version }); }
    pause(id, version) { return this.writeItinerary(id, 'pause', { version }); }
    resume(id, version) { return this.writeItinerary(id, 'resume', { version }); }
    finish(id, version) { return this.writeItinerary(id, 'finish', { version }); }
    skip(id, stopId, version) {
        return this.request(`/api/itinerary/${encodeURIComponent(id)}/stops/${encodeURIComponent(stopId)}/skip`, {
            method: 'POST', body: { version }, key: 'itinerary-write'
        });
    }
    decideProposal(id, proposalId, decision, version) {
        return this.request(`/api/itinerary/${encodeURIComponent(id)}/proposal/${encodeURIComponent(proposalId)}/${decision}`, {
            method: 'POST', body: { version }, key: 'itinerary-write'
        });
    }
    reportPosition(payload) {
        return this.request('/api/position', { method: 'POST', body: payload, key: 'position', cancelPrevious: false });
    }
    writeItinerary(id, action, body) {
        return this.request(`/api/itinerary/${encodeURIComponent(id)}/${action}`, {
            method: 'POST', body, key: 'itinerary-write'
        });
    }
}
