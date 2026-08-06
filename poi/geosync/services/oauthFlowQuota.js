'use strict';

const VALID_KINDS = new Set(['browser', 'qr']);

class OAuthFlowQuota {
    constructor(options = {}) {
        this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
        this.ttlMs = Number(options.ttlMs);
        this.maxTotal = Number(options.maxTotal);
        this.maxPerNetwork = Number(options.maxPerNetwork);
        if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 60 * 60 * 1000) {
            throw new TypeError('OAuth flow quota ttlMs must be an integer between 1000 and 3600000');
        }
        if (!Number.isInteger(this.maxTotal) || this.maxTotal < 1 || this.maxTotal > 100000) {
            throw new TypeError('OAuth flow quota maxTotal must be an integer between 1 and 100000');
        }
        if (!Number.isInteger(this.maxPerNetwork)
            || this.maxPerNetwork < 1
            || this.maxPerNetwork > this.maxTotal) {
            throw new TypeError('OAuth flow quota maxPerNetwork must be between 1 and maxTotal');
        }
        this.leases = new Map();
        this.networkCounts = new Map();
    }

    _networkKey(value) {
        const key = String(value || '').trim().toLowerCase();
        if (!key || key.length > 128) throw new TypeError('OAuth flow network key is invalid');
        return key;
    }

    _retryAfterSec(networkKey, scope) {
        let earliest = Infinity;
        for (const record of this.leases.values()) {
            if (scope === 'network' && record.networkKey !== networkKey) continue;
            earliest = Math.min(earliest, record.expiresAt);
        }
        return Number.isFinite(earliest)
            ? Math.max(1, Math.ceil((earliest - Number(this.clock())) / 1000))
            : Math.max(1, Math.ceil(this.ttlMs / 1000));
    }

    tryAcquire({ networkKey, kind } = {}) {
        if (!VALID_KINDS.has(kind)) throw new TypeError('OAuth flow quota kind is invalid');
        const owner = this._networkKey(networkKey);
        this.prune();
        const ownerCount = this.networkCounts.get(owner) || 0;
        if (ownerCount >= this.maxPerNetwork) {
            return Object.freeze({
                allowed: false,
                reason: 'network',
                retryAfterSec: this._retryAfterSec(owner, 'network')
            });
        }
        if (this.leases.size >= this.maxTotal) {
            return Object.freeze({
                allowed: false,
                reason: 'global',
                retryAfterSec: this._retryAfterSec(owner, 'global')
            });
        }

        const expiresAt = Number(this.clock()) + this.ttlMs;
        const lease = Object.freeze({
            kind,
            networkKey: owner,
            expiresAt
        });
        this.leases.set(lease, lease);
        this.networkCounts.set(owner, ownerCount + 1);
        return Object.freeze({ allowed: true, lease, retryAfterSec: 0 });
    }

    release(lease) {
        const record = this.leases.get(lease);
        if (!record) return false;
        this.leases.delete(lease);
        const count = this.networkCounts.get(record.networkKey) || 0;
        if (count <= 1) this.networkCounts.delete(record.networkKey);
        else this.networkCounts.set(record.networkKey, count - 1);
        return true;
    }

    prune() {
        const now = Number(this.clock());
        for (const [lease, record] of this.leases) {
            if (record.expiresAt <= now) this.release(lease);
        }
    }

    countFor(networkKey) {
        const owner = this._networkKey(networkKey);
        this.prune();
        return this.networkCounts.get(owner) || 0;
    }

    get size() {
        this.prune();
        return this.leases.size;
    }
}

module.exports = {
    OAuthFlowQuota
};
