const DEFAULT_POLL_INTERVAL_MS = 15000;

function removeListener(target, event, handler) {
    if (!target) return;
    if (typeof target.off === 'function') target.off(event, handler);
    else if (typeof target.removeListener === 'function') target.removeListener(event, handler);
}

export class SocketClient extends EventTarget {
    constructor({
        scenicId = 'default',
        role = 'tourist',
        openId = '',
        demo = false,
        ioFactory,
        poll,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
    } = {}) {
        super();
        this.scenicId = scenicId;
        this.role = role;
        this.openId = String(openId || '');
        this.demo = demo;
        this.ioFactory = ioFactory || null;
        this.poll = typeof poll === 'function' ? poll : null;
        this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
        this.socket = null;
        this.manager = null;
        this.demoTimers = [];
        this.pollTimer = null;
        this.pollRunning = false;
        this.socketListeners = [];
        this.managerListeners = [];
        this.joinedForConnection = false;
        this.generation = 0;
    }

    connect() {
        this.disconnect();
        const generation = ++this.generation;
        if (this.demo) {
            queueMicrotask(() => {
                if (this.generation !== generation) return;
                this.emit('state', { state: 'connected' });
                this.emit('joined', { ok: true, rooms: [`scenic:${this.scenicId}`] });
            });
            return;
        }

        const factory = this.ioFactory || (typeof window.io === 'function' ? window.io : null);
        if (typeof factory !== 'function') {
            this.emit('state', { state: 'offline', message: 'Socket.io Client 未加载' });
            this.startPolling('client-unavailable');
            return;
        }

        let socket;
        try {
            socket = factory({
                path: '/socket.io',
                transports: ['websocket', 'polling'],
                withCredentials: true,
                reconnection: true,
                reconnectionDelay: 800,
                reconnectionDelayMax: 5000
            });
        } catch (error) {
            this.emit('state', { state: 'offline', message: error?.message || 'Socket.io Client 初始化失败' });
            this.startPolling('client-error');
            return;
        }
        if (!socket || typeof socket.on !== 'function') {
            this.emit('state', { state: 'offline', message: 'Socket.io Client 初始化失败' });
            this.startPolling('client-invalid');
            return;
        }
        this.socket = socket;
        this.manager = socket.io || null;

        this.onSocket('connect', () => {
            this.joinedForConnection = false;
            this.stopPolling();
            this.emit('state', { state: 'connected' });
            this.joinRoom();
        });
        this.onSocket('disconnect', () => {
            this.joinedForConnection = false;
            this.emit('state', { state: 'reconnecting' });
            this.startPolling('disconnect');
        });
        this.onSocket('connect_error', error => {
            this.emit('state', { state: 'reconnecting', message: error?.message });
            this.startPolling('connect-error');
        });
        this.onSocket('geosync:joined', payload => {
            if (payload?.ok === false) {
                this.emit('state', { state: 'offline', message: payload?.message || '实时房间加入失败' });
                this.startPolling('join-failed');
            } else {
                this.stopPolling();
            }
            this.emit('joined', payload);
        });
        for (const [socketEvent, eventName] of Object.entries({
            'itinerary:proposal': 'proposal',
            'itinerary:progress': 'progress',
            'crowd:update': 'crowd',
            'graph:update': 'graph',
            'rain:incoming': 'rain:incoming',
            'rain:cleared': 'rain:cleared'
        })) {
            this.onSocket(socketEvent, payload => this.emit(eventName, payload));
        }
        this.onManager('reconnect_attempt', () => {
            this.emit('state', { state: 'reconnecting' });
            this.startPolling('reconnect-attempt');
        });
        this.onManager('reconnect', () => {
            this.stopPolling();
            this.emit('reconnected', {});
        });
    }

    onSocket(event, handler) {
        this.socket.on(event, handler);
        this.socketListeners.push([event, handler]);
    }

    onManager(event, handler) {
        if (!this.manager || typeof this.manager.on !== 'function') return;
        this.manager.on(event, handler);
        this.managerListeners.push([event, handler]);
    }

    joinRoom() {
        if (!this.socket || this.joinedForConnection) return false;
        this.joinedForConnection = true;
        this.socket.emit('geosync:join', {
            role: this.role,
            openId: this.openId,
            scenicId: this.scenicId
        });
        return true;
    }

    startPolling(reason = 'offline') {
        if (!this.poll || this.pollTimer !== null) return;
        this.runPoll(reason);
        this.pollTimer = setInterval(() => this.runPoll('interval'), this.pollIntervalMs);
    }

    async runPoll(reason) {
        if (!this.poll || this.pollRunning) return;
        const generation = this.generation;
        this.pollRunning = true;
        try {
            await this.poll({ reason });
            if (generation === this.generation) this.emit('polled', { reason });
        } catch (error) {
            if (generation === this.generation) this.emit('poll:error', { reason, error });
        } finally {
            if (generation === this.generation) this.pollRunning = false;
        }
    }

    stopPolling() {
        if (this.pollTimer !== null) clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    demoProposal(payload, delayMs = 400) {
        this.demoEvent('proposal', payload, delayMs);
    }

    demoEvent(name, payload, delayMs = 0) {
        if (!this.demo) return;
        const generation = this.generation;
        const timer = setTimeout(() => {
            if (this.generation === generation) this.emit(name, payload);
        }, delayMs);
        this.demoTimers.push(timer);
    }

    emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    disconnect() {
        this.generation += 1;
        this.stopPolling();
        this.demoTimers.forEach(clearTimeout);
        this.demoTimers = [];

        const socket = this.socket;
        const manager = this.manager;
        for (const [event, handler] of this.socketListeners) removeListener(socket, event, handler);
        for (const [event, handler] of this.managerListeners) removeListener(manager, event, handler);
        if (socket && this.socketListeners.length && typeof socket.off !== 'function' && typeof socket.removeListener !== 'function') {
            socket.removeAllListeners?.();
        }
        if (manager && this.managerListeners.length && typeof manager.off !== 'function' && typeof manager.removeListener !== 'function') {
            manager.removeAllListeners?.();
        }
        socket?.disconnect?.();

        this.socketListeners = [];
        this.managerListeners = [];
        this.socket = null;
        this.manager = null;
        this.joinedForConnection = false;
        this.pollRunning = false;
    }

    destroy() {
        this.disconnect();
        this.poll = null;
        this.ioFactory = null;
        this.openId = '';
    }
}

export { DEFAULT_POLL_INTERVAL_MS };
