const BUSINESS_MESSAGES = Object.freeze({
    1101: '输入信息格式不正确，请检查后重试',
    1102: '开始时间无效，请重新选择',
    1203: '行程已更新，正在同步最新状态',
    1204: '路线建议不存在或已失效',
    1205: '路线建议已失效，请刷新行程',
    1206: '已有未完成行程，正在恢复',
    2101: '操作过于频繁，请稍后重试',
    2102: '已离开景区范围',
    2103: '定位精度较低',
    8201: '地图路径服务暂时不可用',
    8202: '地图路径服务响应超时',
    8203: '起点或终点无法连接步行路网，请调整起点后重试',
    8204: '没有已验证的无障碍路线',
    8205: '地图服务契约或数据版本不一致，请刷新配置后重试',
    8206: '地图返回的路线几何无效，未显示该路线',
    9001: '服务暂时不可用，请稍后重试'
});

const CATEGORY_MESSAGES = Object.freeze({
    authentication: '登录状态已失效，请重新进入',
    authorization: '当前账号无权执行此操作',
    conflict: '状态已更新，正在同步最新数据',
    rate_limit: '操作过于频繁，请稍后重试',
    timeout: '请求超时，请稍后重试',
    cancelled: '请求已取消',
    network: '网络连接失败，请检查连接后重试',
    response: '服务返回了无法识别的数据',
    server: '服务暂时不可用，请稍后重试',
    business: '操作未完成，请稍后重试',
    unknown: '操作失败，请稍后重试'
});

function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function apiErrorCategory({ status = 0, code = 0, kind = '' } = {}) {
    if (kind === 'timeout') return 'timeout';
    if (kind === 'cancelled') return 'cancelled';
    if (kind === 'network') return 'network';
    if (kind === 'response') return 'response';
    const httpStatus = numeric(status);
    if (httpStatus === 401) return 'authentication';
    if (httpStatus === 403) return 'authorization';
    if (httpStatus === 409 || numeric(code) === 1203) return 'conflict';
    if (httpStatus === 429 || numeric(code) === 2101) return 'rate_limit';
    if (httpStatus >= 500) return 'server';
    if (numeric(code)) return 'business';
    return 'unknown';
}

export function safeApiMessage({ status = 0, code = 0, category = '' } = {}) {
    const businessMessage = BUSINESS_MESSAGES[numeric(code)];
    if (businessMessage) return businessMessage;
    const resolvedCategory = category || apiErrorCategory({ status, code });
    return CATEGORY_MESSAGES[resolvedCategory] || CATEGORY_MESSAGES.unknown;
}

export function summarizeCause(cause) {
    if (!cause) return '';
    const name = String(cause.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'Error';
    const code = String(cause.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    return code ? `${name}:${code}` : name;
}

export class ApiError extends Error {
    constructor(message, {
        category = 'unknown',
        httpStatus,
        status,
        code = 0,
        data = null,
        retryable = false,
        requestId = '',
        cause = null,
        causeSummary = ''
    } = {}) {
        super(message || CATEGORY_MESSAGES.unknown, cause ? { cause } : undefined);
        this.name = 'ApiError';
        this.category = category;
        this.httpStatus = numeric(httpStatus ?? status);
        this.status = this.httpStatus;
        this.code = numeric(code);
        this.data = data;
        this.retryable = Boolean(retryable);
        this.requestId = String(requestId || '').slice(0, 128);
        this.causeSummary = causeSummary || summarizeCause(cause);
    }
}

export class MapFacadeError extends Error {
    constructor(code, message, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = 'MapFacadeError';
        this.code = String(code || 'MAP_SERVICE_UNAVAILABLE');
        this.causeSummary = summarizeCause(cause);
    }
}

export const API_BUSINESS_MESSAGES = BUSINESS_MESSAGES;
export const API_CATEGORY_MESSAGES = CATEGORY_MESSAGES;
