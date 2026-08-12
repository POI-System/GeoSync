function ensureSpeed(speed) {
    const value = Number(speed);
    if (![1, 8, 32].includes(value)) throw new RangeError('回放速度仅支持 1、8 或 32');
    return value;
}

function normalizeCompressedPayload(payload) {
    if (Array.isArray(payload?.frames)) {
        return payload.frames.map((frame, index) => ({
            slot: frame?.slot || payload.slots?.[index] || String(index),
            items: Array.isArray(frame?.items) ? frame.items : [],
            lowConfidence: Boolean(frame?.lowConfidence),
            missing: Boolean(frame?.missing)
        }));
    }
    const slots = Array.isArray(payload?.slots) ? payload.slots : [];
    const series = payload?.frames && typeof payload.frames === 'object' ? payload.frames : {};
    const pois = new Map((Array.isArray(payload?.pois) ? payload.pois : [])
        .map(poi => [String(poi.poiId), poi]));
    return slots.map((slot, index) => {
        const items = [];
        let missingCount = 0;
        for (const [poiId, values] of Object.entries(series)) {
            const ci = Array.isArray(values) ? values[index] : null;
            if (ci === null || ci === undefined || ci === '' || !Number.isFinite(Number(ci))) {
                missingCount += 1;
                continue;
            }
            const poi = pois.get(String(poiId)) || {};
            items.push({
                poiId: String(poiId),
                name: poi.name || String(poiId),
                lnglat: poi.lnglat || null,
                ci: Number(ci),
                level: Number(ci) >= 0.8 ? 'high' : Number(ci) >= 0.5 ? 'medium' : 'low'
            });
        }
        return {
            slot: `${payload.date || ''}T${slot}`,
            items,
            lowConfidence: false,
            missing: items.length === 0 || missingCount > 0
        };
    });
}

export class ReplayEngine {
    constructor({ onFrame = () => {}, onState = () => {}, clock = globalThis, frameDurationMs = 1000 } = {}) {
        this.onFrame = onFrame;
        this.onState = onState;
        this.clock = clock;
        this.frameDurationMs = frameDurationMs;
        this.frames = [];
        this.index = 0;
        this.speed = 1;
        this.timer = null;
    }

    load(payload) {
        this.pause();
        this.frames = normalizeCompressedPayload(payload);
        this.index = 0;
        this.emitState();
        if (this.frames.length) this.emitFrame();
        return this.frames.length;
    }

    play(speed = this.speed) {
        this.speed = ensureSpeed(speed);
        if (!this.frames.length) return false;
        if (this.index >= this.frames.length - 1) this.index = 0;
        this.schedule();
        this.emitState();
        return true;
    }

    schedule() {
        if (this.timer !== null) this.clock.clearInterval(this.timer);
        this.timer = this.clock.setInterval(() => {
            if (this.index >= this.frames.length - 1) {
                this.pause();
                return;
            }
            this.index += 1;
            this.emitFrame();
            this.emitState();
        }, Math.max(16, this.frameDurationMs / this.speed));
    }

    pause() {
        if (this.timer !== null) this.clock.clearInterval(this.timer);
        this.timer = null;
        this.emitState();
    }

    seek(slotIndex) {
        if (!this.frames.length) return null;
        const index = Math.max(0, Math.min(this.frames.length - 1, Math.trunc(Number(slotIndex) || 0)));
        this.index = index;
        this.emitFrame();
        this.emitState();
        return this.frames[index];
    }

    step(delta) {
        return this.seek(this.index + Math.trunc(Number(delta) || 0));
    }

    stop() {
        this.pause();
        this.index = 0;
        if (this.frames.length) this.emitFrame();
        this.emitState();
    }

    emitFrame() {
        this.onFrame(this.frames[this.index], this.index, this.frames.length);
    }

    emitState() {
        this.onState({
            playing: this.timer !== null,
            speed: this.speed,
            index: this.index,
            total: this.frames.length,
            missing: Boolean(this.frames[this.index]?.missing)
        });
    }

    destroy() {
        this.pause();
        this.frames = [];
    }
}
