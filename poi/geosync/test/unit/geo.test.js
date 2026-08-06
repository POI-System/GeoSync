'use strict';
// lib/geo 纯函数单测
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../../lib/geo');

test('haversine 已知距离', () => {
    // 南京鼓楼 → 新街口 约 2.2km
    const d = geo.haversine([118.7969, 32.0603], [118.7784, 32.0416]);
    assert.ok(d > 2000 && d < 3500, `got ${d}`);
    assert.strictEqual(geo.haversine([118, 32], [118, 32]), 0);
});

test('destination 往返一致', () => {
    const origin = [118.7969, 32.0603];
    const p = geo.destination(origin, 90, 1000);
    const d = geo.haversine(origin, p);
    assert.ok(Math.abs(d - 1000) < 1, `got ${d}`);
});

test('angleDiff 归一化', () => {
    assert.strictEqual(geo.angleDiff(350, 10), 20);
    assert.strictEqual(geo.angleDiff(0, 180), 180);
    assert.strictEqual(geo.angleDiff(90, 90), 0);
});

test('medianFilter 抗离群点', () => {
    const pts = [[118.1, 32.1], [118.1001, 32.1001], [119.5, 33.5], [118.1002, 32.1], [118.1001, 32.1002]];
    const m = geo.medianFilter(pts, 5);
    assert.ok(Math.abs(m[0] - 118.1001) < 0.001);
    assert.ok(Math.abs(m[1] - 32.1001) < 0.001);
});

test('timeSlotOf 对齐10分钟', () => {
    const d = new Date(2026, 6, 6, 14, 17, 42);
    assert.strictEqual(geo.timeSlotOf(d), '2026-07-06T14:10');
    assert.strictEqual(geo.timeSlotOf(new Date(2026, 6, 6, 14, 0, 0)), '2026-07-06T14:00');
});

test('polyline 编解码往返', () => {
    const coords = [[118.7969, 32.0603], [118.7984, 32.0611], [118.8001, 32.0587]];
    const back = geo.decodePolyline(geo.encodePolyline(coords));
    assert.strictEqual(back.length, 3);
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(back[i][0] - coords[i][0]) < 1e-5);
        assert.ok(Math.abs(back[i][1] - coords[i][1]) < 1e-5);
    }
});

test('userIdHash 日轮换', () => {
    const a = geo.userIdHash('u1', 's', new Date(2026, 6, 6));
    const b = geo.userIdHash('u1', 's', new Date(2026, 6, 7));
    const c = geo.userIdHash('u1', 's', new Date(2026, 6, 6));
    assert.notStrictEqual(a, b);
    assert.strictEqual(a, c);
    assert.strictEqual(a.length, 32);
});

test('distToPolyline 垂距', () => {
    const line = [[118.0, 32.0], [118.01, 32.0]];
    const d = geo.distToPolyline([118.005, 32.001], line);
    assert.ok(Math.abs(d - 111.32) < 5, `got ${d}`); // 0.001° 纬差 ≈ 111m
});
