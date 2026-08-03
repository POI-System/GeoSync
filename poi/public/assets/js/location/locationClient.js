const UPLOAD_INTERVAL_MS = 30000;

export class LocationClient extends EventTarget {
    constructor({ upload } = {}) {
        super();
        this.upload = upload;
        this.watchId = null;
        this.lastUploadAt = 0;
        this.stoppedByFence = false;
    }

    start(mode = 'tour') {
        if (!navigator.geolocation) {
            this.emit('state', { state: 'unavailable' });
            return false;
        }
        if (this.watchId !== null) return true;
        this.stoppedByFence = false;
        this.emit('state', { state: 'requesting' });
        this.watchId = navigator.geolocation.watchPosition(
            position => void this.onPosition(position, mode),
            error => this.onError(error),
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
        );
        return true;
    }

    async onPosition(position, mode) {
        const location = {
            lng: position.coords.longitude,
            lat: position.coords.latitude,
            accuracy: position.coords.accuracy,
            ts: position.timestamp
        };
        const lowAccuracy = Number(location.accuracy) > 100;
        this.emit('location', { ...location, lowAccuracy });
        this.emit('state', { state: lowAccuracy ? 'low-accuracy' : 'ready' });
        if (!this.upload || this.stoppedByFence || Date.now() - this.lastUploadAt < UPLOAD_INTERVAL_MS) return;
        this.lastUploadAt = Date.now();
        try {
            const response = await this.upload({
                lng: location.lng,
                lat: location.lat,
                acc: location.accuracy,
                ts: location.ts,
                mode
            });
            if (response?.accepted === false && response?.outOfFence) {
                this.stoppedByFence = true;
                this.emit('state', { state: 'out-of-fence' });
                this.stop();
            }
        } catch (error) {
            if (Number(error?.code) === 2102) {
                this.stoppedByFence = true;
                this.emit('state', { state: 'out-of-fence' });
                this.stop();
            } else if (Number(error?.status) !== 429) {
                this.emit('upload:error', { error });
            }
        }
    }

    onError(error) {
        const denied = error?.code === 1;
        this.emit('state', { state: denied ? 'denied' : 'error', message: error?.message || '' });
        if (denied) this.stop();
    }

    emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    stop() {
        if (this.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
    }

    destroy() {
        this.stop();
        this.upload = null;
    }
}
