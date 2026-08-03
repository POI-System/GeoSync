import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ApiError,
    MapFacadeError,
    apiErrorCategory,
    safeApiMessage,
    summarizeCause
} from '../../../public/assets/js/shared/errors.js';

test('API error categories account for transport, authorization, conflict and retry status', () => {
    assert.equal(apiErrorCategory({ kind: 'timeout', status: 401 }), 'timeout');
    assert.equal(apiErrorCategory({ kind: 'cancelled' }), 'cancelled');
    assert.equal(apiErrorCategory({ kind: 'network' }), 'network');
    assert.equal(apiErrorCategory({ kind: 'response' }), 'response');
    assert.equal(apiErrorCategory({ status: 401 }), 'authentication');
    assert.equal(apiErrorCategory({ status: 403 }), 'authorization');
    assert.equal(apiErrorCategory({ status: 409 }), 'conflict');
    assert.equal(apiErrorCategory({ code: 1203 }), 'conflict');
    assert.equal(apiErrorCategory({ status: 429 }), 'rate_limit');
    assert.equal(apiErrorCategory({ status: 503 }), 'server');
    assert.equal(apiErrorCategory({ code: 8204 }), 'business');
    assert.equal(apiErrorCategory(), 'unknown');
});

test('safe API messages expose controlled copy instead of raw server messages', () => {
    assert.equal(safeApiMessage({ code: 1205 }), '路线建议已失效，请刷新行程');
    assert.equal(safeApiMessage({ code: 8204 }), '没有已验证的无障碍路线');
    assert.equal(safeApiMessage({ status: 401 }), '登录状态已失效，请重新进入');
    assert.equal(safeApiMessage({ category: 'response' }), '服务返回了无法识别的数据');
    assert.equal(safeApiMessage({ category: 'missing-category' }), '操作失败，请稍后重试');
});

test('ApiError keeps structured diagnostics and sanitizes the cause summary', () => {
    const cause = Object.assign(new Error('secret upstream response'), {
        name: 'Fetch Error<script>',
        code: 'ECONN RESET/token'
    });
    const error = new ApiError('请求超时，请稍后重试', {
        category: 'timeout',
        status: '504',
        code: '8202',
        data: { retryAfterSec: 2 },
        retryable: true,
        requestId: 'request-123',
        cause
    });

    assert.equal(error.name, 'ApiError');
    assert.equal(error.category, 'timeout');
    assert.equal(error.httpStatus, 504);
    assert.equal(error.status, 504);
    assert.equal(error.code, 8202);
    assert.deepEqual(error.data, { retryAfterSec: 2 });
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, 'request-123');
    assert.equal(error.cause, cause);
    assert.equal(error.causeSummary, 'FetchErrorscript:ECONNRESETtoken');
    assert.equal(error.causeSummary.includes('secret'), false);
    assert.equal(summarizeCause(null), '');
});

test('MapFacadeError uses a stable fallback code and sanitized cause metadata', () => {
    const cause = Object.assign(new Error('private URL'), { code: 'ECONNREFUSED' });
    const explicit = new MapFacadeError('MAP_CONFIG_INVALID', '地图配置无效', cause);
    assert.equal(explicit.name, 'MapFacadeError');
    assert.equal(explicit.code, 'MAP_CONFIG_INVALID');
    assert.equal(explicit.causeSummary, 'Error:ECONNREFUSED');

    const fallback = new MapFacadeError('', '地图不可用');
    assert.equal(fallback.code, 'MAP_SERVICE_UNAVAILABLE');
});
