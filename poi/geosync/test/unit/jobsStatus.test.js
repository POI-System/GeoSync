'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../../config');
const { startJobs } = require('../../jobs');

test('primary scheduler returns its actual running status and omits placeholder jobs', () => {
    const scheduled = [];
    let flushStarts = 0;
    let warmups = 0;
    let unrefs = 0;
    const status = startJobs({
        env: { NODE_APP_INSTANCE: '0' },
        scheduler: {
            schedule(expression, fn, options) {
                scheduled.push({ expression, fn, options });
                return { stop() {} };
            }
        },
        crowdService: { startFlushLoop() { flushStarts++; } },
        setTimeoutFn(fn, delay) {
            warmups++;
            assert.equal(typeof fn, 'function');
            assert.equal(delay, 5000);
            return { unref() { unrefs++; } };
        },
        logger: { log() {} }
    });

    assert.deepEqual(status, {
        enabled: true,
        running: true,
        reason: null,
        instance: '0',
        scheduledJobs: [
            'ciAggregate', 'rainPoll', 'pairingScan',
            'spotScoreDaily', 'rhoCalibrate', 'minuteSweep'
        ]
    });
    assert.equal(scheduled.length, 6);
    assert.equal(flushStarts, 1);
    assert.equal(warmups, 1);
    assert.equal(unrefs, 1);
    assert.equal(status.scheduledJobs.includes('trailMining'), false);
    const spotScoreSchedule = scheduled.find(item => item.expression === '30 3 * * *');
    assert.deepEqual(spotScoreSchedule.options, { timezone: CONFIG.scenicTimeZone });
    const rhoSchedule = scheduled.find(item => item.expression === '0 4 * * *');
    assert.deepEqual(rhoSchedule.options, { timezone: CONFIG.scenicTimeZone });
});

test('non-primary scheduler reports intentional disablement and schedules nothing', () => {
    let schedules = 0;
    let flushStarts = 0;
    let warmups = 0;
    const status = startJobs({
        env: { NODE_APP_INSTANCE: '3' },
        scheduler: { schedule() { schedules++; } },
        crowdService: { startFlushLoop() { flushStarts++; } },
        setTimeoutFn() { warmups++; },
        logger: { log() {} }
    });

    assert.deepEqual(status, {
        enabled: false,
        running: false,
        reason: 'non-primary-instance',
        instance: '3',
        scheduledJobs: []
    });
    assert.equal(schedules, 0);
    assert.equal(flushStarts, 0);
    assert.equal(warmups, 0);
});
