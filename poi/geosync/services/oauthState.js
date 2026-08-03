'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const VALID_KINDS = new Set(['browser', 'qr']);

class OAuthStateStore {
    constructor(options = {}) {
        this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
        this.randomBytes = typeof options.randomBytes === 'function'
            ? options.randomBytes
            : crypto.randomBytes;
        this.ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
        if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
            throw new TypeError('OAuth state ttlMs must be positive');
        }
        this.records = new Map();
    }

    issue({ kind, subject = '', redirect = '' } = {}) {
        if (!VALID_KINDS.has(kind)) throw new TypeError('OAuth state kind is invalid');
        const normalizedSubject = String(subject || '').trim();
        if (kind === 'qr' && !normalizedSubject) {
            throw new TypeError('QR OAuth state requires a subject');
        }

        this.prune();
        let state;
        do {
            state = this.randomBytes(24).toString('base64url');
        } while (!state || this.records.has(state));

        const issuedAt = Number(this.clock());
        const record = Object.freeze({
            kind,
            subject: normalizedSubject,
            redirect: String(redirect || ''),
            issuedAt,
            expiresAt: issuedAt + this.ttlMs
        });
        this.records.set(state, {
            record,
            reservation: null
        });
        return Object.freeze({ state, expiresAt: record.expiresAt });
    }

    reserve(state, { kind, subject = '', boundState = '' } = {}) {
        const normalizedState = String(state || '').trim();
        if (!normalizedState || !VALID_KINDS.has(kind)) return null;
        const entry = this.records.get(normalizedState);
        if (!entry) return null;

        const now = Number(this.clock());
        const { record } = entry;
        if (record.expiresAt <= now) {
            this.records.delete(normalizedState);
            return null;
        }
        if (record.kind !== kind) return null;
        if (record.subject !== String(subject || '').trim()) return null;
        if (kind === 'browser' && String(boundState || '').trim() !== normalizedState) return null;
        if (entry.reservation) return null;

        const reservation = Object.freeze({
            state: normalizedState,
            kind: record.kind,
            subject: record.subject,
            redirect: record.redirect,
            issuedAt: record.issuedAt,
            expiresAt: record.expiresAt
        });
        entry.reservation = reservation;
        return reservation;
    }

    commit(reservation) {
        const entry = this._reservedEntry(reservation);
        if (!entry) return null;
        if (entry.record.expiresAt <= Number(this.clock())) {
            this.records.delete(reservation.state);
            return null;
        }

        this.records.delete(reservation.state);
        return entry.record;
    }

    release(reservation) {
        const entry = this._reservedEntry(reservation);
        if (!entry) return false;
        if (entry.record.expiresAt <= Number(this.clock())) {
            this.records.delete(reservation.state);
            return false;
        }

        entry.reservation = null;
        return true;
    }

    cancel(state) {
        const normalizedState = String(state || '').trim();
        const entry = this.records.get(normalizedState);
        if (!entry || entry.reservation) return null;
        this.records.delete(normalizedState);
        return entry.record;
    }

    _reservedEntry(reservation) {
        if (!reservation || typeof reservation !== 'object') return null;
        const entry = this.records.get(reservation.state);
        return entry?.reservation === reservation ? entry : null;
    }

    prune() {
        const now = Number(this.clock());
        for (const [state, entry] of this.records) {
            if (entry.record.expiresAt <= now) this.records.delete(state);
        }
    }

    get size() {
        this.prune();
        return this.records.size;
    }
}

module.exports = {
    DEFAULT_TTL_MS,
    OAuthStateStore
};
