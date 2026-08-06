'use strict';
// 04文档 §5：单实例内存缓存 + 滑动窗口限流。进程重启丢失可接受。

const store = new Map(); // key → {value, expireAt|null}

function set(key, value, ttlMs = null) {
    store.set(key, { value, expireAt: ttlMs ? Date.now() + ttlMs : null });
}

function get(key) {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expireAt && Date.now() > e.expireAt) { store.delete(key); return undefined; }
    return e.value;
}

function del(key) { store.delete(key); }

// 滑动窗口限流：windowMs 内 ≤ limit 次 → true 放行
const windows = new Map(); // key → timestamps[]
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let ts = windows.get(key);
    if (!ts) { ts = []; windows.set(key, ts); }
    while (ts.length && ts[0] <= now - windowMs) ts.shift();
    if (ts.length >= limit) return false;
    ts.push(now);
    return true;
}

// 近 N ms 内某 key 的计数（antiHerding recentPushCount 用）
const counters = new Map(); // key → timestamps[]
function bump(key) {
    let ts = counters.get(key);
    if (!ts) { ts = []; counters.set(key, ts); }
    ts.push(Date.now());
}
function countRecent(key, windowMs) {
    const now = Date.now();
    const ts = counters.get(key) || [];
    while (ts.length && ts[0] <= now - windowMs) ts.shift();
    return ts.length;
}

// 定期清扫（防 Map 无限增长）
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of store) if (e.expireAt && now > e.expireAt) store.delete(k);
    for (const [k, ts] of windows) if (!ts.length || ts[ts.length - 1] < now - 3600000) windows.delete(k);
    for (const [k, ts] of counters) if (!ts.length || ts[ts.length - 1] < now - 3600000) counters.delete(k);
}, 60000).unref();

module.exports = { set, get, del, rateLimit, bump, countRecent };
