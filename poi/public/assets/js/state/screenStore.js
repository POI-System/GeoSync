export function createInitialScreenState() {
    return {
        boot: 'loading',
        mode: 'realtime',
        config: null,
        health: null,
        connectionState: 'connecting',
        frame: { slot: null, items: [], lowConfidence: false, missing: false },
        dashboard: null,
        alerts: [],
        replay: {
            date: '',
            playing: false,
            speed: 1,
            index: 0,
            total: 0,
            missing: false
        },
        lastRealtimeFrame: null,
        lastUpdatedAt: null,
        lastError: null
    };
}

function normalizeFrame(frame) {
    return {
        slot: frame?.slot || null,
        items: Array.isArray(frame?.items) ? frame.items.map(item => ({ ...item })) : [],
        lowConfidence: Boolean(frame?.lowConfidence),
        missing: Boolean(frame?.missing)
    };
}

export class ScreenStore {
    constructor(initialState = {}) {
        this.state = { ...createInitialScreenState(), ...initialState };
        this.listeners = new Set();
    }

    getState() { return this.state; }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    update(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener(this.state);
        return this.state;
    }

    ready({ config, health, dashboard, frame }) {
        const normalized = normalizeFrame(frame);
        return this.update({
            boot: 'ready', config, health, dashboard, frame: normalized,
            lastRealtimeFrame: normalized,
            alerts: Array.isArray(dashboard?.alerts) ? dashboard.alerts.slice(0, 30) : [],
            lastUpdatedAt: new Date().toISOString(), lastError: null
        });
    }

    fail(error, { fatal = false } = {}) {
        return this.update({
            boot: fatal ? 'error' : this.state.boot,
            lastError: error?.message || String(error || '未知错误')
        });
    }

    setConnectionState(connectionState) { return this.update({ connectionState }); }
    setHealth(health) { return this.update({ health }); }
    setDashboard(dashboard) { return this.update({ dashboard, lastUpdatedAt: new Date().toISOString() }); }

    renderFrame(frame, { realtime = this.state.mode === 'realtime' } = {}) {
        const normalized = normalizeFrame(frame);
        return this.update({
            frame: realtime && this.state.mode === 'replay' ? this.state.frame : normalized,
            lastRealtimeFrame: realtime ? normalized : this.state.lastRealtimeFrame,
            lastUpdatedAt: new Date().toISOString()
        });
    }

    addAlert(alert) {
        return this.update({ alerts: [{ ...alert, at: alert?.at || new Date().toISOString() }, ...this.state.alerts].slice(0, 30) });
    }

    enterReplay(date, total) {
        return this.update({
            mode: 'replay',
            replay: { ...this.state.replay, date, index: 0, total, playing: false, missing: false },
            lastError: null
        });
    }

    updateReplay(patch) {
        return this.update({ replay: { ...this.state.replay, ...patch } });
    }

    exitReplay() {
        return this.update({
            mode: 'realtime',
            replay: { ...this.state.replay, playing: false, missing: false },
            frame: this.state.lastRealtimeFrame || this.state.frame
        });
    }
}
