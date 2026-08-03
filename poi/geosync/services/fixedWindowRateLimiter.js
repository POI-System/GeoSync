'use strict';

function createFixedWindowRateLimiter(options = {}) {
    const windowMs = Number(options.windowMs);
    const maxAttempts = Number(options.maxAttempts);
    const maxKeys = Number(options.maxKeys ?? 4096);
    const clock = typeof options.clock === 'function' ? options.clock : Date.now;
    if (!Number.isInteger(windowMs) || windowMs < 1000) {
        throw new TypeError('windowMs must be an integer of at least 1000');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new TypeError('maxAttempts must be a positive integer');
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 100000) {
        throw new TypeError('maxKeys must be an integer between 1 and 100000');
    }

    const records = new Map();

    function pruneExpired(now) {
        for (const [key, record] of records) {
            if (record.resetAt <= now) records.delete(key);
        }
    }

    function hasCapacity(now) {
        pruneExpired(now);
        return records.size < maxKeys;
    }

    function capacityRetryAfterSec(now) {
        let earliestResetAt = Infinity;
        for (const record of records.values()) {
            earliestResetAt = Math.min(earliestResetAt, record.resetAt);
        }
        return Number.isFinite(earliestResetAt)
            ? Math.max(1, Math.ceil((earliestResetAt - now) / 1000))
            : Math.max(1, Math.ceil(windowMs / 1000));
    }

    function consume(key) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) throw new TypeError('rate-limit key is required');
        const now = Number(clock());
        let record = records.get(normalizedKey);
        if (record?.resetAt <= now) {
            records.delete(normalizedKey);
            record = null;
        }
        if (!record) {
            if (!hasCapacity(now)) {
                return Object.freeze({
                    allowed: false,
                    remaining: 0,
                    retryAfterSec: capacityRetryAfterSec(now)
                });
            }
            record = { count: 0, resetAt: now + windowMs };
            records.set(normalizedKey, record);
        }
        if (record.count >= maxAttempts) {
            return Object.freeze({
                allowed: false,
                remaining: 0,
                retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000))
            });
        }
        record.count++;
        return Object.freeze({
            allowed: true,
            remaining: Math.max(0, maxAttempts - record.count),
            retryAfterSec: 0
        });
    }

    function clear(key) {
        records.delete(String(key || '').trim());
    }

    return Object.freeze({
        consume,
        clear,
        get size() {
            pruneExpired(Number(clock()));
            return records.size;
        }
    });
}

module.exports = { createFixedWindowRateLimiter };
