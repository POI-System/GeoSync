'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('sunlight calculations use the scenic time zone when the host runs in UTC', () => {
    const sunlightPath = path.resolve(__dirname, '..', '..', 'services', 'sunlight.js');
    const script = `
        'use strict';
        const assert = require('node:assert/strict');
        const sunlight = require(${JSON.stringify(sunlightPath)});
        const instant = new Date('2026-07-06T01:45:00.000Z');
        const scenicDayStart = new Date('2026-07-05T16:30:00.000Z');
        const scenicDayNoon = new Date('2026-07-06T04:00:00.000Z');
        const windows = [{ start: '09:30', end: '10:10' }];
        const spot = {
            geo: { coordinates: [118.7969, 32.0603] },
            heading: 285,
            horizonProfile: []
        };

        assert.equal(sunlight.dateStr(scenicDayStart), '2026-07-06');
        assert.equal(sunlight.dateStrOffset(scenicDayStart, -1), '2026-07-05');
        assert.equal(
            sunlight.dateStrOffset(
                new Date('2026-03-09T04:30:00.000Z'),
                -1,
                'America/New_York'
            ),
            '2026-03-08'
        );
        assert.equal(sunlight.hhmm(instant), '09:45');
        assert.equal(sunlight.minuteOfDay(instant), 9 * 60 + 45);
        assert.equal(sunlight.windowFit(windows, instant), 1);

        const earlyResult = sunlight.computeWindows(spot, scenicDayStart, null);
        const noonResult = sunlight.computeWindows(spot, scenicDayNoon, null);
        const publicShape = result => ({
            windows: result.windows.map(window => ({
                start: window.start,
                end: window.end,
                light: window.light,
                trueSunset: window.trueSunset || null
            })),
            trueSunset: result.trueSunset,
            geometricSunset: result.geometricSunset
        });

        assert.deepEqual(publicShape(earlyResult), publicShape(noonResult));
        assert.ok(earlyResult.windows.length > 0);
        assert.match(earlyResult.trueSunset, /^\\d{2}:\\d{2}$/);
        assert.match(earlyResult.geometricSunset, /^\\d{2}:\\d{2}$/);
        for (const window of earlyResult.windows) {
            assert.match(window.start, /^\\d{2}:\\d{2}$/);
            assert.match(window.end, /^\\d{2}:\\d{2}$/);
        }
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '..', '..', '..'),
        env: {
            ...process.env,
            TZ: 'UTC',
            SCENIC_TIME_ZONE: 'Asia/Shanghai'
        },
        encoding: 'utf8',
        windowsHide: true
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
});
