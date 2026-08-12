function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function screenToken() {
    try { return sessionStorage.getItem('geosync.screenToken') || ''; } catch { return ''; }
}

function adminToken() {
    try { return sessionStorage.getItem('geosync.adminToken') || ''; } catch { return ''; }
}

export class ScreenApi {
    constructor({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
        this.fetchImpl = fetchImpl;
    }

    async request(path, { protectedScreen = false, protectedAdmin = false } = {}) {
        const headers = new Headers({ Accept: 'application/json' });
        const screenCredential = screenToken();
        const adminCredential = adminToken();
        if (protectedScreen && screenCredential) headers.set('X-Screen-Token', screenCredential);
        if (protectedAdmin && adminCredential) headers.set('Authorization', `Bearer ${adminCredential}`);
        const response = await this.fetchImpl(path, { credentials: 'same-origin', headers });
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        if (!response.ok || payload?.success === false) {
            throw new Error(payload?.message || `请求失败 (${response.status})`);
        }
        return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
    }

    getConfig() { return this.request('/api/geosync/client-config'); }
    getHealth() { return this.request('/api/screen/geosync/health', { protectedScreen: true }); }
    getHeatmap() { return this.request('/api/crowd/heatmap'); }
    getDashboard() { return this.request('/api/admin/geosync/dashboard', { protectedAdmin: true }); }
    getGraph() { return this.request('/api/admin/geosync/graph', { protectedAdmin: true }); }
    getManagedPois() { return this.request('/api/admin/geosync/pois', { protectedAdmin: true }); }
    getReplay(date) {
        return this.request(`/api/admin/geosync/replay?date=${encodeURIComponent(date)}`, { protectedAdmin: true });
    }
}

export class ScreenStreamClient {
    constructor({
        fetchImpl = globalThis.fetch?.bind(globalThis),
        onEvent = () => {},
        onState = () => {},
        path = '/api/screen/stream'
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.onEvent = onEvent;
        this.onState = onState;
        this.path = path;
        this.controller = null;
        this.running = false;
        this.retryCount = 0;
    }

    connect() {
        if (this.running) return;
        this.running = true;
        void this.loop();
    }

    async loop() {
        while (this.running) {
            this.controller = new AbortController();
            try {
                this.onState(this.retryCount ? 'reconnecting' : 'connecting');
                const headers = new Headers({ Accept: 'text/event-stream' });
                const token = screenToken();
                if (token) headers.set('X-Screen-Token', token);
                const response = await this.fetchImpl(this.path, {
                    credentials: 'same-origin', headers, signal: this.controller.signal
                });
                if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
                this.retryCount = 0;
                this.onState('connected');
                await this.consume(response.body);
                if (this.running) throw new Error('SSE ended');
            } catch (error) {
                if (!this.running || error?.name === 'AbortError') break;
                this.retryCount += 1;
                this.onState('reconnecting');
                await sleep(Math.min(1000 * 2 ** Math.min(this.retryCount, 4), 15000));
            }
        }
    }

    async consume(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (this.running) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                this.parseBlock(block);
            }
        }
    }

    parseBlock(block) {
        if (!block || block.startsWith(':')) return;
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) return;
        try { this.onEvent(event, JSON.parse(data.join('\n'))); } catch { /* Ignore malformed frames. */ }
    }

    disconnect() {
        this.running = false;
        this.controller?.abort();
        this.controller = null;
        this.onState('offline');
    }
}
