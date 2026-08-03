export class SocketClient extends EventTarget {
    constructor({ scenicId = 'default', role = 'tourist', demo = false } = {}) {
        super();
        this.scenicId = scenicId;
        this.role = role;
        this.demo = demo;
        this.socket = null;
        this.timers = [];
    }

    connect() {
        this.disconnect();
        if (this.demo) {
            queueMicrotask(() => {
                this.emit('state', { state: 'connected' });
                this.emit('joined', { ok: true, rooms: [`scenic:${this.scenicId}`] });
            });
            return;
        }
        if (typeof window.io !== 'function') {
            this.emit('state', { state: 'offline', message: 'Socket.io Client 未加载' });
            return;
        }
        const socket = window.io({
            path: '/socket.io',
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
            reconnectionDelay: 800,
            reconnectionDelayMax: 5000
        });
        this.socket = socket;
        socket.on('connect', () => {
            this.emit('state', { state: 'connected' });
            socket.emit('geosync:join', { role: this.role, scenicId: this.scenicId });
        });
        socket.on('disconnect', () => this.emit('state', { state: 'reconnecting' }));
        socket.on('connect_error', error => this.emit('state', { state: 'reconnecting', message: error?.message }));
        socket.io.on('reconnect_attempt', () => this.emit('state', { state: 'reconnecting' }));
        socket.io.on('reconnect', () => {
            socket.emit('geosync:join', { role: this.role, scenicId: this.scenicId });
            this.emit('reconnected', {});
        });
        for (const [socketEvent, eventName] of Object.entries({
            'geosync:joined': 'joined',
            'itinerary:proposal': 'proposal',
            'itinerary:progress': 'progress',
            'crowd:update': 'crowd',
            'graph:update': 'graph',
            'rain:incoming': 'rain:incoming',
            'rain:cleared': 'rain:cleared'
        })) {
            socket.on(socketEvent, payload => this.emit(eventName, payload));
        }
    }

    demoProposal(payload, delayMs = 400) {
        this.demoEvent('proposal', payload, delayMs);
    }

    demoEvent(name, payload, delayMs = 0) {
        if (!this.demo) return;
        const timer = setTimeout(() => this.emit(name, payload), delayMs);
        this.timers.push(timer);
    }

    emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    disconnect() {
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.socket?.removeAllListeners();
        this.socket?.disconnect();
        this.socket = null;
    }
}
