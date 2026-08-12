export class OpsRealtime {
    constructor({ scenicId, onEvent = () => {}, onState = () => {}, poll = null } = {}) {
        this.scenicId = scenicId || 'default';
        this.onEvent = onEvent;
        this.onState = onState;
        this.poll = poll;
        this.client = null;
        this.extraSocket = null;
        this.extraListeners = [];
    }

    async connect() {
        try {
            const { SocketClient } = await import('../realtime/socketClient.js');
            await this.ensureSocketIo();
            const factory = options => {
                if (typeof window.io !== 'function') throw new Error('Socket.io Client 未加载');
                const socket = window.io(options);
                this.extraSocket = socket;
                for (const name of ['alert:crowd', 'ops:impact', 'ops:proposal-status']) {
                    const handler = payload => this.onEvent(name, payload);
                    socket.on(name, handler);
                    this.extraListeners.push([name, handler]);
                }
                return socket;
            };
            const client = new SocketClient({
                scenicId: this.scenicId,
                role: 'admin',
                ioFactory: factory,
                poll: this.poll,
                pollIntervalMs: 30000
            });
            for (const [clientEvent, serverEvent] of [
                ['crowd', 'crowd:update'], ['graph', 'graph:update'], ['joined', 'geosync:joined']
            ]) {
                client.addEventListener(clientEvent, event => this.onEvent(serverEvent, event.detail));
            }
            client.addEventListener('state', event => this.onState(event.detail?.state || 'offline'));
            client.addEventListener('poll:error', () => this.onState('reconnecting'));
            this.client = client;
            client.connect();
        } catch {
            this.onState('offline');
            await this.poll?.({ reason: 'shared-client-unavailable' });
        }
    }

    async ensureSocketIo() {
        if (typeof window.io === 'function') return;
        await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-geosync-socket-client]');
            if (existing) {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = '/assets/vendor/socket.io/socket.io.min.js';
            script.dataset.geosyncSocketClient = 'true';
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', reject, { once: true });
            document.head.append(script);
        });
    }

    destroy() {
        for (const [name, handler] of this.extraListeners) this.extraSocket?.off?.(name, handler);
        this.extraListeners = [];
        this.extraSocket = null;
        this.client?.destroy?.();
        this.client = null;
    }
}
