'use strict';
// Minutely rain events use the configured provider probability-array contract.
// No unconfigured hourly source is invented when that provider is unavailable.

const axios = require('axios');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const bus = require('../lib/eventBus');

let consecutiveFails = 0;

/**
 * 拉取未来2h逐分钟降雨概率曲线。
 * Configured-provider example:
 *   GET {RAIN_API_URL}/{lng},{lat}/minutely → result.minutely.probability [每分钟0~1 ×120]
 */
async function fetchMinutely() {
    if (!CONFIG.features.rain || !CONFIG.scenicCenter) return null;
    const [lng, lat] = CONFIG.scenicCenter;
    const url = `${CONFIG.rain.url.replace(/\/$/, '')}/${lng},${lat}/minutely`;
    const r = await axios.get(url, { timeout: 8000 });
    const prob = r.data?.result?.minutely?.probability;
    if (!Array.isArray(prob)) throw new Error('unexpected rain API response');
    return prob; // [0~1 ×120]
}

// 判定纯函数（单测覆盖）：返回 {incoming:{startInMin,durationMin,probability}} | {cleared:true} | null
function judge(probCurve, currentState) {
    if (!probCurve) return null;
    const idx = probCurve.findIndex(p => p > 0.6);
    if (!currentState?.incoming) {
        if (idx > -1 && idx <= 30) {
            let end = idx;
            while (end < probCurve.length && probCurve[end] > 0.3) end++;
            return {
                incoming: {
                    startInMin: idx,
                    durationMin: Math.max(end - idx, 10),
                    probability: Math.round(probCurve[idx] * 100)
                }
            };
        }
        return null;
    }
    // 已在 incoming 态：当前及未来30min P<0.3 → cleared
    if (probCurve.slice(0, 30).every(p => p < 0.3)) return { cleared: true };
    return null;
}

// jobs/rainPoll 每10min调用
async function poll() {
    const { GeoSetting } = getModels();

    let curve = null;
    try {
        curve = await fetchMinutely();
        consecutiveFails = 0;
    } catch (e) {
        consecutiveFails++;
        const code = /^[A-Z0-9_:-]{1,64}$/.test(String(e?.code || ''))
            ? e.code
            : 'RAIN_FETCH_FAILED';
        console.error(`[GeoSync] [RAIN] fetch failed (${consecutiveFails}):`, code);
        if (consecutiveFails === 3) {
            console.error('[GeoSync] [RAIN] minutely source unavailable; no hourly fallback configured');
        }
        return;
    }

    const stateDoc = await GeoSetting.findOne({ key: 'rainState' }).lean();
    const state = stateDoc?.value || { incoming: false };
    const verdict = judge(curve, state);
    if (!verdict) return;

    if (verdict.incoming) {
        const startAt = new Date(Date.now() + verdict.incoming.startInMin * 60000);
        await GeoSetting.updateOne(
            { key: 'rainState' },
            { $set: { value: { incoming: true, startAt, durationMin: verdict.incoming.durationMin }, updateTime: new Date() } },
            { upsert: true }
        );
        bus.emit(bus.EVENTS.RAIN_INCOMING, {
            startAt: startAt.toISOString(),
            durationMin: verdict.incoming.durationMin,
            probability: verdict.incoming.probability
        });
        console.log(`[GeoSync] [RAIN] incoming in ${verdict.incoming.startInMin}min, ~${verdict.incoming.durationMin}min`);
    } else if (verdict.cleared) {
        await GeoSetting.updateOne(
            { key: 'rainState' },
            { $set: { value: { incoming: false }, updateTime: new Date() } },
            { upsert: true }
        );
        bus.emit(bus.EVENTS.RAIN_CLEARED, {});
        console.log('[GeoSync] [RAIN] cleared');
    }
}

// 仿真注入口（SIM_MODE 下 routes/sim 调用）
async function injectRain(startInMin, durationMin) {
    const { GeoSetting } = getModels();
    const startAt = new Date(Date.now() + startInMin * 60000);
    await GeoSetting.updateOne(
        { key: 'rainState' },
        { $set: { value: { incoming: true, startAt, durationMin }, updateTime: new Date() } },
        { upsert: true }
    );
    bus.emit(bus.EVENTS.RAIN_INCOMING, {
        startAt: startAt.toISOString(), durationMin, probability: 90, simulated: true
    });
}

module.exports = { poll, judge, injectRain };
