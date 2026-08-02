'use strict';

const ALLOWED_AUDIENCES = new Set(['all', 'collector', 'reviewer']);
const COLLECTOR_TEMPLATE_LABEL = '已认证采集者';

function normalizeAudience(value) {
    return ALLOWED_AUDIENCES.has(value) ? value : 'all';
}

function normalizedReviewerOpenIds(values) {
    const source = values instanceof Set ? [...values] : Array.isArray(values) ? values : [];
    return [...new Set(source.map(value => String(value || '').trim()).filter(Boolean))];
}

function activeAudienceQuery(audience, reviewerOpenIds = []) {
    const normalized = normalizeAudience(audience);
    if (normalized === 'reviewer') {
        return {
            role: 'reviewer',
            openId: { $in: normalizedReviewerOpenIds(reviewerOpenIds) },
            disabled: { $ne: true }
        };
    }
    return normalized === 'all'
        ? { disabled: { $ne: true } }
        : { role: normalized, disabled: { $ne: true } };
}

function activeReviewerQuery(reviewerOpenIds = []) {
    return {
        openId: { $in: normalizedReviewerOpenIds(reviewerOpenIds) },
        disabled: { $ne: true },
    };
}

function publishAnnouncementRefresh(io, notifications, audience) {
    if (!io) return;
    const normalized = normalizeAudience(audience);
    for (const item of notifications || []) {
        const openId = String(item?.recipientOpenId || '').trim();
        if (!openId) continue;
        const room = `user_${openId}`;
        io.to(room).emit('notification', item);
        io.to(room).emit('announcement', { audience: normalized });
    }
}

module.exports = {
    COLLECTOR_TEMPLATE_LABEL,
    normalizeAudience,
    activeAudienceQuery,
    activeReviewerQuery,
    publishAnnouncementRefresh
};
