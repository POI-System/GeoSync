'use strict';
// CI 公式 / 分级 / 排队估计 / 预测纯函数
const test = require('node:test');
const assert = require('node:assert');
const crowdService = require('../../services/crowdService');
const forecast = require('../../services/forecastService');
const rain = require('../../services/rainService');

test('computeCI 边界钳制', () => {
    const ci0 = crowdService.computeCI({
        presentEst: 0, avgStay: 0, baselineStay: 20, checkinRate: 0, baseRate: 1, p95Present: 50
    });
    assert.strictEqual(ci0, 0);
    const ci1 = crowdService.computeCI({
        presentEst: 500, avgStay: 200, baselineStay: 20, checkinRate: 100, baseRate: 1, p95Present: 50
    });
    assert.ok(ci1 <= 1 && ci1 > 0.9, `got ${ci1}`);
});

test('computeCI 单调性：人越多 CI 越高', () => {
    const at = n => crowdService.computeCI({
        presentEst: n, avgStay: 20, baselineStay: 20, checkinRate: 2, baseRate: 1, p95Present: 50
    });
    assert.ok(at(10) < at(30));
    assert.ok(at(30) < at(50));
});

test('levelOf 阈值', () => {
    assert.strictEqual(crowdService.levelOf(0.39), 'low');
    assert.strictEqual(crowdService.levelOf(0.4), 'medium');
    assert.strictEqual(crowdService.levelOf(0.7), 'high');
});

test('queueEst Little 定律', () => {
    assert.strictEqual(crowdService.queueEst(60, 2), 30);
    assert.strictEqual(crowdService.queueEst(60, 0.05), null); // 离开率过低不可信
    assert.strictEqual(crowdService.queueEst(10000, 1), 120);  // 上限
});

test('presence lease 使用最后服务端心跳并按半开区间过期', () => {
    const now = new Date('2026-07-21T10:00:00.000Z');
    const cutoff = crowdService.presenceCutoff(now);
    assert.strictEqual(cutoff.toISOString(), '2026-07-21T09:50:00.000Z');
    assert.strictEqual(crowdService.isPresenceActive({
        enterAt: new Date('2026-07-21T09:00:00.000Z'),
        lastSeenAt: new Date('2026-07-21T09:50:00.001Z'),
        leaveAt: null
    }, now), true);
    assert.strictEqual(crowdService.isPresenceActive({
        enterAt: new Date('2026-07-21T09:00:00.000Z'),
        lastSeenAt: cutoff,
        leaveAt: null
    }, now), false);
});

test('presence lease 兼容没有 lastSeenAt 的旧样本', () => {
    const now = new Date('2026-07-21T10:00:00.000Z');
    assert.strictEqual(crowdService.isPresenceActive({
        enterAt: new Date('2026-07-21T09:55:00.000Z'), leaveAt: null
    }, now), true);
    assert.strictEqual(crowdService.isPresenceActive({
        enterAt: new Date('2026-07-21T09:45:00.000Z'), leaveAt: null
    }, now), false);
});

test('trendExtrapolate EWMA 外推', () => {
    assert.strictEqual(forecast.trendExtrapolate([], 3), null);
    const up = forecast.trendExtrapolate([0.2, 0.3, 0.4, 0.5], 3);
    assert.ok(up > 0.5, `上升趋势应外推更高 got ${up}`);
    const flat = forecast.trendExtrapolate([0.5, 0.5, 0.5], 3);
    assert.ok(Math.abs(flat - 0.5) < 0.01);
    const capped = forecast.trendExtrapolate([0.7, 0.9, 1.0, 1.0], 6);
    assert.ok(capped <= 1);
});

test('dayTypeOf 周末/工作日/节假日', () => {
    assert.strictEqual(forecast.dayTypeOf(new Date(2026, 6, 6)), 'workday'); // 周一
    assert.strictEqual(forecast.dayTypeOf(new Date(2026, 6, 5)), 'weekend'); // 周日
    assert.strictEqual(forecast.dayTypeOf(new Date(2026, 6, 6), new Set(['2026-07-06'])), 'holiday');
});

test('rain judge 状态机', () => {
    const calm = new Array(120).fill(0.1);
    assert.strictEqual(rain.judge(calm, { incoming: false }), null);

    const storm = [...new Array(20).fill(0.2), ...new Array(50).fill(0.8), ...new Array(50).fill(0.1)];
    const v = rain.judge(storm, { incoming: false });
    assert.ok(v?.incoming);
    assert.strictEqual(v.incoming.startInMin, 20);
    assert.ok(v.incoming.durationMin >= 50);

    // 太远（>30min）不触发
    const far = [...new Array(40).fill(0.2), ...new Array(30).fill(0.9)];
    assert.strictEqual(rain.judge(far, { incoming: false }), null);

    // incoming 态 → 前30min全 <0.3 → cleared
    assert.deepStrictEqual(rain.judge(calm, { incoming: true }), { cleared: true });
    assert.strictEqual(rain.judge(storm, { incoming: true }), null);
});
