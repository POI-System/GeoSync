const UPLOAD_INTERVAL_MS = 30000;

function errorCode(value) {
    return Number(value?.code ?? value?.data?.code) || 0;
}

export class LocationClient extends EventTarget {
    constructor({ upload, geolocation, clock } = {}) {
        super();
        this.upload = typeof upload === 'function' ? upload : null;
        this.geolocation = geolocation === undefined ? globalThis.navigator?.geolocation : geolocation;
        this.now = typeof clock === 'function'
            ? clock
            : typeof clock?.now === 'function'
                ? () => clock.now()
                : () => Date.now();
        this.watchId = null;
        this.lastUploadAt = null;
        this.stoppedByFence = false;
        this.generation = 0;
    }

    start(mode = 'tour') {
        if (!this.geolocation || typeof this.geolocation.watchPosition !== 'function') {
            this.emit('state', { state: 'unavailable' });
            return false;
        }
        if (this.watchId !== null) return true;
        this.stoppedByFence = false;
        const generation = ++this.generation;
        this.emit('state', { state: 'requesting' });
        try {
            this.watchId = this.geolocation.watchPosition(
                position => void this.onPosition(position, mode, generation),
                error => this.onError(error, generation),
                { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
            );
            return true;
        } catch (error) {
            this.watchId = null;
            this.emit('state', { state: 'error', message: error?.message || '' });
            return false;
        }
    }

    shouldUpload(now) {
        if (this.lastUploadAt === null) return true;
        const elapsed = Number(now) - Number(this.lastUploadAt);
        return elapsed < 0 || elapsed >= UPLOAD_INTERVAL_MS;
    }

    async onPosition(position, mode = 'tour', generation = this.generation) {
        if (generation !== this.generation || this.stoppedByFence) return;
        const clockNow = Number(this.now());
        const now = Number.isFinite(clockNow) ? clockNow : Date.now();
        const location = {
            lng: Number(position?.coords?.longitude),
            lat: Number(position?.coords?.latitude),
            accuracy: Number(position?.coords?.accuracy),
            ts: Number(position?.timestamp) || now
        };
        if (!Number.isFinite(location.lng) || !Number.isFinite(location.lat)) {
            this.emit('state', { state: 'error', message: '定位坐标无效' });
            return;
        }
        const lowAccuracy = !Number.isFinite(location.accuracy) || location.accuracy > 100;
        this.emit('location', { ...location, lowAccuracy });
        this.emit('state', { state: lowAccuracy ? 'low-accuracy' : 'ready' });
        if (!this.upload || !this.shouldUpload(now)) return;

        this.lastUploadAt = now;
        try {
            const response = await this.upload({
                lng: location.lng,
                lat: location.lat,
                acc: location.accuracy,
                ts: location.ts,
                mode
            });
            if (generation !== this.generation) return;
            this.handleUploadResult(response);
        } catch (error) {
            if (generation !== this.generation) return;
            this.handleUploadError(error);
        }
    }

    handleUploadResult(response) {
        const code = errorCode(response);
        if (code === 2102 || (response?.accepted === false && response?.outOfFence)) {
            this.stopOutsideFence();
            return;
        }
        if (code === 2103 || response?.accepted === false) {
            this.emit('state', { state: 'low-accuracy', code: 2103, uploadRejected: true });
            this.emit('upload:rejected', { code: 2103, reason: 'low-accuracy' });
        }
    }

    handleUploadError(error) {
        const code = errorCode(error);
        if (code === 2102) {
            this.stopOutsideFence();
        } else if (code === 2103) {
            this.emit('state', { state: 'low-accuracy', code: 2103, uploadRejected: true });
            this.emit('upload:rejected', { code: 2103, reason: 'low-accuracy', error });
        } else if (Number(error?.status) !== 429) {
            this.emit('upload:error', { error });
        }
    }

    stopOutsideFence() {
        this.stoppedByFence = true;
        this.emit('state', { state: 'out-of-fence', code: 2102 });
        this.stop();
    }

    onError(error, generation = this.generation) {
        if (generation !== this.generation) return;
        const denied = Number(error?.code) === 1;
        this.emit('state', { state: denied ? 'denied' : 'error', message: error?.message || '' });
        if (denied) this.stop();
    }

    emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    stop() {
        const watchId = this.watchId;
        this.watchId = null;
        this.lastUploadAt = null;
        this.generation += 1;
        if (watchId !== null && this.geolocation && typeof this.geolocation.clearWatch === 'function') {
            this.geolocation.clearWatch(watchId);
        }
    }

    destroy() {
        this.stop();
        this.upload = null;
        this.geolocation = null;
    }
}

export { UPLOAD_INTERVAL_MS };
