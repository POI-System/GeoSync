import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CROWD_COLORS,
    MAP_LAYER_STYLES,
    ROUTE_COLORS,
    categoryIconId,
    categoryStyle,
    routePresentation
} from '../../../public/assets/js/map/styles.js';

test('map colors and category presentation remain stable public conventions', () => {
    assert.deepEqual(CROWD_COLORS, {
        low: '#34c759',
        medium: '#ffb020',
        high: '#ff453a',
        unknown: '#8e8e93'
    });
    assert.deepEqual(categoryStyle('photography'), { glyph: '摄', color: '#d95d39' });
    assert.deepEqual(categoryStyle('missing'), { glyph: '点', color: '#5e6a72' });
    assert.equal(categoryIconId('摄影'), 'geosync-poi-6444-5f71');
    assert.equal(categoryIconId('missing'), 'geosync-poi-default');
});

test('accessible local fallback is visibly degraded and never marked verified', () => {
    const presentation = routePresentation({
        gis: {
            source: 'local-fallback',
            mode: 'accessible',
            degraded: true
        },
        verifiedAccessible: false
    });

    assert.equal(presentation.color, ROUTE_COLORS.accessible);
    assert.deepEqual(presentation.dash, MAP_LAYER_STYLES.route.fallbackDash);
    assert.equal(presentation.source, 'local-fallback');
    assert.equal(presentation.mode, 'accessible');
    assert.equal(presentation.label, '离线路线');
    assert.equal(presentation.degraded, true);
    assert.equal(presentation.accessibleVerified, false);
});

test('only explicitly verified iServer accessible routes are presented as verified', () => {
    const verified = routePresentation({
        gis: { source: 'iserver', mode: 'accessible', degraded: false },
        verifiedAccessible: true
    });
    assert.deepEqual(verified.dash, MAP_LAYER_STYLES.route.solidDash);
    assert.equal(verified.degraded, false);
    assert.equal(verified.accessibleVerified, true);

    const unverified = routePresentation({
        gis: { source: 'iserver', mode: 'accessible' },
        verifiedAccessible: false
    });
    assert.equal(unverified.accessibleVerified, false);

    const cached = routePresentation({ gis: { source: 'cache', mode: 'normal' } });
    assert.equal(cached.degraded, true);
    assert.equal(cached.label, '缓存结果');
});
