import {
    ApiError,
    apiErrorCategory,
    safeApiMessage,
    summarizeCause
} from '../shared/errors.js';

export { ApiError } from '../shared/errors.js';

const DEFAULT_TIMEOUT_MS = 8000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const encode = value => encodeURIComponent(String(value));

export const ENDPOINTS = Object.freeze({
    clientConfig: '/api/geosync/client-config',
    pois: '/api/poi/all',
    currentItinerary: '/api/itinerary/current',
    itineraryDetail: id => `/api/itinerary/${encode(id)}`,
    heatmap: '/api/crowd/heatmap',
    planItinerary: '/api/itinerary/plan',
    position: '/api/position',
    photoSpots: '/api/photospots',
    itineraryAction: (id, action) => `/api/itinerary/${encode(id)}/${action}`,
    skipStop: (id, stopId) => `/api/itinerary/${encode(id)}/stops/${encode(stopId)}/skip`,
    proposalDecision: (id, proposalId, decision) =>
        `/api/itinerary/${encode(id)}/proposal/${encode(proposalId)}/${decision}`,
    goldenWindow: id => `/api/photospots/${encode(id)}/golden`,
    arData: id => `/api/photospots/${encode(id)}/ar`
});

function isFormData(value) {
    return typeof FormData !== 'undefined' && value instanceof FormData;
}

function isSearchParams(value) {
    return typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams;
}

function requestBody(body) {
    if (body === undefined || body === null) return undefined;
    if (isFormData(body) || isSearchParams(body) || typeof body === 'string') return body;
    return JSON.stringify(body);
}

function retryableFailure(status, code) {
    if ([8203, 8204, 8205, 8206].includes(Number(code))) return false;
    return status === 408 || status === 425 || status === 429 || status >= 500
        || [8201, 8202].includes(Number(code));
}

function requestIdOf(response, payload) {
    return response?.headers?.get?.('x-request-id')
        || payload?.requestId
        || payload?.data?.requestId
        || '';
}

function isEnvelope(payload) {
    return Boolean(payload && typeof payload === 'object'
        && (own(payload, 'success') || own(payload, 'code')));
}

function successData(payload) {
    if (!isEnvelope(payload)) return payload;
    return own(payload, 'data') ? payload.data : payload;
}

function successWithCode(payload) {
    const data = successData(payload);
    const code = Number(payload?.code) || 0;
    if (!code) return data;
    const message = safeApiMessage({ code, category: 'business' });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { ...data, code, message };
    }
    return { data, code, message };
}

function isCompleteItinerary(value) {
    return Boolean(value && typeof value === 'object'
        && value.itineraryId
        && Number.isFinite(Number(value.version))
        && Array.isArray(value.stops));
}

function abortReason(message = 'Request cancelled') {
    if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export class ApiClient {
    constructor({
        baseUrl = '',
        openId = '',
        allowLegacyOpenId = false,
        fetchImpl = globalThis.fetch?.bind(globalThis),
        clock = globalThis,
        location = globalThis.location
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.fetchImpl = fetchImpl;
        this.clock = clock;
        this.controllers = new Map();
        const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location?.hostname);
        this.legacyOpenId = allowLegacyOpenId && localHost ? String(openId).trim() : '';
    }

    register(key, controller) {
        if (!this.controllers.has(key)) this.controllers.set(key, new Set());
        this.controllers.get(key).add(controller);
    }

    unregister(key, controller) {
        const controllers = this.controllers.get(key);
        controllers?.delete(controller);
        if (!controllers?.size) this.controllers.delete(key);
    }

    async request(path, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const key = options.key || `${method}:${path}`;
        if (options.cancelPrevious !== false) this.cancel(key);
        const controller = new AbortController();
        this.register(key, controller);

        const timeoutValue = Number(options.timeoutMs);
        const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS;
        let timedOut = false;
        const timeout = this.clock.setTimeout(() => {
            timedOut = true;
            controller.abort(abortReason('Request timed out'));
        }, timeoutMs);
        const externalSignal = options.signal;
        const onExternalAbort = () => controller.abort(externalSignal.reason || abortReason());
        if (externalSignal) {
            if (externalSignal.aborted) onExternalAbort();
            else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        const headers = new Headers(options.headers || {});
        const body = requestBody(options.body);
        if (body && !isFormData(options.body) && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        if (this.legacyOpenId) headers.set('X-Open-Id', this.legacyOpenId);

        try {
            if (typeof this.fetchImpl !== 'function') throw new TypeError('fetch unavailable');
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
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
                    const category = response.ok
                        ? 'response'
                        : apiErrorCategory({ status: response.status });
                    throw new ApiError(safeApiMessage({ status: response.status, category }), {
                        category,
                        httpStatus: response.status,
                        retryable: retryableFailure(response.status, 0),
                        requestId: requestIdOf(response, null),
                        cause,
                        causeSummary: summarizeCause(cause)
                    });
                }
            }

            if (!response.ok || payload?.success === false) {
                const code = Number(payload?.code) || 0;
                const category = apiErrorCategory({ status: response.status, code });
                throw new ApiError(safeApiMessage({ status: response.status, code, category }), {
                    category,
                    httpStatus: response.status,
                    code,
                    data: payload?.data ?? null,
                    retryable: retryableFailure(response.status, code),
                    requestId: requestIdOf(response, payload)
                });
            }
            return successWithCode(payload);
        } catch (error) {
            if (error instanceof ApiError) throw error;
            const cancelled = controller.signal.aborted || externalSignal?.aborted
                || error?.name === 'AbortError' || error?.name === 'TimeoutError';
            if (cancelled) {
                const category = timedOut ? 'timeout' : 'cancelled';
                throw new ApiError(safeApiMessage({ category }), {
                    category,
                    retryable: timedOut,
                    cause: error,
                    causeSummary: summarizeCause(error)
                });
            }
            throw new ApiError(safeApiMessage({ category: 'network' }), {
                category: 'network',
                retryable: true,
                cause: error,
                causeSummary: summarizeCause(error)
            });
        } finally {
            this.clock.clearTimeout(timeout);
            externalSignal?.removeEventListener?.('abort', onExternalAbort);
            this.unregister(key, controller);
        }
    }

    cancel(key) {
        const controllers = this.controllers.get(key);
        for (const controller of controllers || []) controller.abort(abortReason());
        this.controllers.delete(key);
    }

    cancelAll() {
        for (const key of [...this.controllers.keys()]) this.cancel(key);
    }

    destroy() {
        this.cancelAll();
    }

    getClientConfig() { return this.request(ENDPOINTS.clientConfig, { key: 'config' }); }
    getPois() { return this.request(ENDPOINTS.pois, { key: 'pois' }); }
    getCurrentItinerary() {
        return this.request(ENDPOINTS.currentItinerary, { key: 'current', cancelPrevious: false });
    }
    async getItinerary(id) {
        try {
            return await this.request(ENDPOINTS.itineraryDetail(id), { key: 'itinerary-detail' });
        } catch (error) {
            if (error instanceof ApiError && error.httpStatus === 404 && error.code === 1204) {
                throw new ApiError('行程不存在或已失效', {
                    category: error.category,
                    httpStatus: error.httpStatus,
                    code: error.code,
                    data: error.data,
                    retryable: error.retryable,
                    requestId: error.requestId,
                    cause: error
                });
            }
            throw error;
        }
    }
    getHeatmap() { return this.request(ENDPOINTS.heatmap, { key: 'heatmap' }); }
    getPhotoSpots(params = {}) {
        const query = new URLSearchParams();
        if (params.near) query.set('near', params.near.join(','));
        if (params.radius) query.set('radius', params.radius);
        query.set('sort', params.sort || 'score');
        return this.request(`${ENDPOINTS.photoSpots}?${query}`, { key: 'photospots' });
    }
    getGoldenWindow(id) { return this.request(ENDPOINTS.goldenWindow(id), { key: `golden:${id}` }); }
    getArData(id) { return this.request(ENDPOINTS.arData(id), { key: `ar:${id}` }); }

    plan(payload) {
        return this.request(ENDPOINTS.planItinerary, {
            method: 'POST', body: payload, timeoutMs: 6500, key: 'plan'
        });
    }
    planItinerary(payload) { return this.plan(payload); }
    start(id, version) { return this.writeItinerary(id, 'start', { version }); }
    startItinerary(id, version) { return this.start(id, version); }
    pause(id, version) { return this.writeItinerary(id, 'pause', { version }); }
    pauseItinerary(id, version) { return this.pause(id, version); }
    resume(id, version) { return this.writeItinerary(id, 'resume', { version }); }
    resumeItinerary(id, version) { return this.resume(id, version); }
    finish(id, version) { return this.writeItinerary(id, 'finish', { version }); }
    endItinerary(id, version) { return this.finish(id, version); }
    abandon(id, version) { return this.writeItinerary(id, 'abandon', { version }); }
    abandonItinerary(id, version) { return this.abandon(id, version); }
    skip(id, stopId, version) {
        return this.request(ENDPOINTS.skipStop(id, stopId), {
            method: 'POST', body: { version }, key: 'itinerary-write'
        });
    }
    skipStop(id, stopId, version) { return this.skip(id, stopId, version); }

    async decideProposal(id, proposalId, decision, version) {
        const normalizedDecision = String(decision);
        if (!['accept', 'reject'].includes(normalizedDecision)) {
            throw new ApiError('路线建议操作无效', { category: 'business' });
        }
        const result = await this.request(ENDPOINTS.proposalDecision(id, proposalId, normalizedDecision), {
            method: 'POST', body: { version }, key: 'itinerary-write'
        });
        if (normalizedDecision === 'accept' && isCompleteItinerary(result)) return result;
        const current = await this.getCurrentItinerary();
        if (!isCompleteItinerary(current)) {
            throw new ApiError('未能同步最新行程，请刷新后重试', {
                category: 'response',
                retryable: true
            });
        }
        return current;
    }
    acceptProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'accept', version);
    }
    rejectProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'reject', version);
    }

    reportPosition(payload) {
        return this.request(ENDPOINTS.position, {
            method: 'POST', body: payload, key: 'position', cancelPrevious: false
        });
    }
    writeItinerary(id, action, body) {
        return this.request(ENDPOINTS.itineraryAction(id, action), {
            method: 'POST', body, key: 'itinerary-write'
        });
    }
}
