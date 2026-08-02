'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wrap } = require('../../lib/respond');
const { IServerTimeoutError, NoRouteError } = require('../../integrations/supermap/errors');

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        }
    };
}

test('wrap preserves typed SuperMap error codes and HTTP statuses', async () => {
    const cases = [
        [new IServerTimeoutError(), 504, 8202],
        [new NoRouteError(), 422, 8204]
    ];

    for (const [error, httpStatus, code] of cases) {
        const res = responseRecorder();
        await wrap(async () => { throw error; })({
            method: 'POST',
            originalUrl: '/api/itinerary/plan'
        }, res, () => {});

        assert.equal(res.statusCode, httpStatus);
        assert.deepEqual(res.body, {
            success: false,
            code,
            data: null,
            message: error.message
        });
    }
});
