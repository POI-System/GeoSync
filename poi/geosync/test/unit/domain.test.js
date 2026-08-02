'use strict';
// 光位 / 打卡相似度 / applyProposal / planner 纯函数
const test = require('node:test');
const assert = require('node:assert');
const sunlight = require('../../services/sunlight');
const checkin = require('../../services/checkinService');
const engine = require('../../services/geosyncEngine');
const planner = require('../../services/planner');

test('lightOf 光位分类', () => {
    assert.strictEqual(sunlight.lightOf(45), 'side');
    assert.strictEqual(sunlight.lightOf(170), 'back');
    assert.strictEqual(sunlight.lightOf(10), 'front');
    assert.strictEqual(sunlight.lightOf(100), null);
});

test('horizonAt 插值与缺省', () => {
    assert.strictEqual(sunlight.horizonAt(null, 90), 0);
    const profile = new Array(360).fill(0);
    profile[90] = 10; profile[91] = 20;
    assert.strictEqual(sunlight.horizonAt(profile, 90.5), 15);
    assert.strictEqual(sunlight.horizonAt(profile, 450.0), 10); // 90+360
});

test('computeWindows 平地日落=几何日落', () => {
    const spot = { geo: { coordinates: [118.7969, 32.0603] }, heading: 285, horizonProfile: [] };
    const r = sunlight.computeWindows(spot, new Date(2026, 6, 6));
    assert.strictEqual(r.cloudy, false);
    assert.strictEqual(r.trueSunset, r.geometricSunset);
    assert.ok(r.windows.length > 0, '夏至前后应有光位窗口');
});

test('computeWindows 西侧高山 → 真日落早于几何日落', () => {
    const profile = new Array(360).fill(0);
    for (let az = 250; az < 300; az++) profile[az] = 15; // 西侧15°遮挡
    const spot = { geo: { coordinates: [118.7969, 32.0603] }, heading: 285, horizonProfile: profile };
    const r = sunlight.computeWindows(spot, new Date(2026, 6, 6));
    assert.ok(r.trueSunset < r.geometricSunset, `${r.trueSunset} !< ${r.geometricSunset}`);
});

test('computeWindows 阴天空窗', () => {
    const spot = { geo: { coordinates: [118.79, 32.06] }, heading: 0, horizonProfile: [] };
    const r = sunlight.computeWindows(spot, new Date(), { cloudy: true });
    assert.deepStrictEqual(r.windows, []);
    assert.strictEqual(r.cloudy, true);
});

test('editDistance / similarity OCR 容错', () => {
    assert.strictEqual(checkin.editDistance('abc', 'abc'), 0);
    assert.strictEqual(checkin.editDistance('abc', 'axc'), 1);
    assert.ok(checkin.similarity('玻璃栈道', '欢迎来到玻璃栈道景区') === 1);
    assert.ok(checkin.similarity('玻璃栈道', '玻璃桟道观光') >= 0.7); // 一字之差
    assert.ok(checkin.similarity('玻璃栈道', '完全无关文本') < 0.5);
});

// ---- applyProposal ----
function mkStops() {
    const base = new Date(2026, 6, 6, 9, 0);
    const mk = (id, i, state = 'pending') => ({
        _id: id, poiId: `poi${i}`, state,
        plannedArrive: new Date(base.getTime() + i * 3600000),
        plannedLeave: new Date(base.getTime() + i * 3600000 + 30 * 60000),
        pathGeometry: ''
    });
    return [mk('s0', 0, 'done'), mk('s1', 1), mk('s2', 2), mk('s3', 3)];
}

test('applyProposal swap 交换并顺延时刻', () => {
    const it = { stops: mkStops() };
    const out = engine.applyProposal(it, { type: 'swap', payload: { stopIdA: 's1', stopIdB: 's3' } });
    assert.strictEqual(String(out[1]._id), 's3');
    assert.strictEqual(String(out[3]._id), 's1');
    // done 站不动
    assert.strictEqual(String(out[0]._id), 's0');
    // 时刻表单调
    for (let i = 2; i < out.length; i++) {
        assert.ok(new Date(out[i].plannedArrive) > new Date(out[i - 1].plannedLeave));
    }
});

test('applyProposal 不可变状态拒绝', () => {
    const it = { stops: mkStops() };
    assert.strictEqual(
        engine.applyProposal(it, { type: 'swap', payload: { stopIdA: 's0', stopIdB: 's1' } }),
        null); // s0 已 done
    assert.strictEqual(
        engine.applyProposal(it, { type: 'drop', payload: { stopId: 'missing' } }),
        null);
    assert.strictEqual(engine.applyProposal(it, { type: 'unknown', payload: {} }), null);
});

test('applyProposal delay 整体顺延', () => {
    const it = { stops: mkStops() };
    const before = new Date(it.stops[2].plannedArrive).getTime();
    const out = engine.applyProposal(it, { type: 'delay', payload: { stopId: 's2', delayMin: 25 } });
    assert.strictEqual(new Date(out[2].plannedArrive).getTime() - before, 25 * 60000);
    // 前面的站不动
    assert.strictEqual(new Date(out[1].plannedArrive).getTime(),
        new Date(it.stops[1].plannedArrive).getTime());
});

test('applyProposal replace 换点重置状态', () => {
    const it = { stops: mkStops() };
    const out = engine.applyProposal(it, { type: 'replace', payload: { stopId: 's2', newPoiId: 'poiX' } });
    assert.strictEqual(String(out[2].poiId), 'poiX');
    assert.strictEqual(out[2].pathGeometry, '');
});

test('applyProposal drop 标记跳过', () => {
    const it = { stops: mkStops() };
    it.stops[3].capacityTokenId = 'token-3';
    const out = engine.applyProposal(it, { type: 'drop', payload: { stopId: 's3' } });
    assert.strictEqual(out[3].state, 'skipped');
    assert.strictEqual(out[3].capacityTokenId, null);
});

test('applyProposal rainShift 只重排可变站点，不跨过 arrived', () => {
    const stops = mkStops();
    stops[1].state = 'arrived';
    const out = engine.applyProposal({ stops }, {
        type: 'rainShift', payload: { moves: [{ stopId: 's2', toIndex: 1 }] }
    });

    assert.deepStrictEqual(out.map(stop => String(stop._id)), ['s0', 's1', 's3', 's2']);
    assert.strictEqual(out[0].state, 'done');
    assert.strictEqual(out[1].state, 'arrived');
});

test('selectCandidate 只保留最终候选的容量 token', async () => {
    const released = [];
    const best = await engine.selectCandidate([
        { type: 'replace', gainMin: 12, tokenIds: ['winner'] },
        { type: 'replace', gainMin: 8, tokenIds: ['loser-a', 'loser-b'] },
        { type: 'delay', gainMin: 6 }
    ], 5, async ids => released.push(...ids));

    assert.strictEqual(best.gainMin, 12);
    assert.deepStrictEqual(released, ['loser-a', 'loser-b']);
});

test('selectCandidate 收益未过阈值时释放全部 token', async () => {
    const released = [];
    const best = await engine.selectCandidate([
        { type: 'replace', gainMin: 5, tokenIds: ['a'] },
        { type: 'replace', gainMin: 4, tokenIds: ['b'] }
    ], 5, async ids => released.push(...ids));

    assert.strictEqual(best, null);
    assert.deepStrictEqual(released, ['a', 'b']);
});

// ---- planner 纯函数 ----
test('interestMatch 命中奖励', () => {
    const poi = { visitMeta: { tags: ['photo', 'nature'] }, category: '观景台' };
    assert.ok(planner.interestMatch(poi, ['photo']) > planner.interestMatch(poi, ['food']));
    assert.strictEqual(planner.interestMatch(poi, []), 0.5);
});

test('offWindowMin 窗口内为0', () => {
    const wins = [{ start: '09:30', end: '10:10' }];
    assert.strictEqual(planner.offWindowMin(wins, new Date(2026, 6, 6, 9, 45)), 0);
    assert.ok(planner.offWindowMin(wins, new Date(2026, 6, 6, 12, 0)) > 60);
});

test('windowFit 契合度', () => {
    const wins = [{ start: '16:40', end: '17:25' }];
    assert.strictEqual(sunlight.windowFit(wins, new Date(2026, 6, 6, 17, 0)), 1);
    assert.strictEqual(sunlight.windowFit(null, new Date()), 0.5);
    assert.ok(sunlight.windowFit(wins, new Date(2026, 6, 6, 12, 0)) < 0.5);
});

test('accessible planner rejects graph fallback routes', () => {
    assert.strictEqual(planner.routeUsable({ walkSec: 60, fallback: false }, 'accessible'), true);
    assert.strictEqual(planner.routeUsable({ walkSec: 60, fallback: true }, 'accessible'), false);
    assert.strictEqual(planner.routeUsable({ walkSec: 60, fallback: true }, 'standard'), true);
    assert.strictEqual(planner.routeUsable(null, 'standard'), false);
});
