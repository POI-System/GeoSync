import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CROWD_LABELS,
    formatCrowdLevel,
    formatDistance,
    formatDuration,
    formatRouteMode,
    formatRouteSource
} from '../../../public/assets/js/shared/formatters.js';

test('distance and duration formatters handle boundaries and invalid values', () => {
    assert.equal(formatDistance(undefined), '--');
    assert.equal(formatDistance('not-a-number'), '--');
    assert.equal(formatDistance(-499.6), '500 米');
    assert.equal(formatDistance(999.4), '999 米');
    assert.equal(formatDistance(1000), '1.0 公里');
    assert.equal(formatDistance(12_349), '12.3 公里');

    assert.equal(formatDuration(undefined), '--');
    assert.equal(formatDuration(-60), '0 分钟');
    assert.equal(formatDuration(89), '1 分钟');
    assert.equal(formatDuration(3_599), '1 小时 0 分');
    assert.equal(formatDuration(7_500), '2 小时 5 分');
});

test('crowd labels always expose a textual level and mark low-confidence data', () => {
    assert.deepEqual(CROWD_LABELS, {
        low: '舒适',
        medium: '较忙',
        high: '拥挤',
        unknown: '准备中'
    });
    assert.equal(formatCrowdLevel('high'), '拥挤');
    assert.equal(formatCrowdLevel('low', { lowConfidence: true }), '参考人流 · 舒适');
    assert.equal(formatCrowdLevel('unexpected'), '准备中');
});

test('route source and mode formatters use stable public labels', () => {
    assert.equal(formatRouteSource('iserver'), 'iServer 路线');
    assert.equal(formatRouteSource('cache'), '缓存结果');
    assert.equal(formatRouteSource('local-fallback'), '离线路线');
    assert.equal(formatRouteSource('other'), '路线来源未知');

    assert.equal(formatRouteMode('normal'), '普通模式');
    assert.equal(formatRouteMode('accessible'), '无障碍模式');
    assert.equal(formatRouteMode('shade'), '遮荫模式');
    assert.equal(formatRouteMode('other'), '普通模式');
});
