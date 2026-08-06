'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    COLLECTOR_TEMPLATE_LABEL,
    activeAudienceQuery,
    activeReviewerQuery,
    publishAnnouncementRefresh
} = require('../../services/hostNotificationPolicy');

test('notification audience queries exclude disabled identities', () => {
    assert.deepEqual(activeAudienceQuery('all'), { disabled: { $ne: true } });
    assert.deepEqual(activeAudienceQuery('reviewer', ['reviewer-a']), {
        role: 'reviewer',
        openId: { $in: ['reviewer-a'] },
        disabled: { $ne: true }
    });
    assert.deepEqual(activeReviewerQuery(new Set(['reviewer-a', 'reviewer-a'])), {
        openId: { $in: ['reviewer-a'] },
        disabled: { $ne: true }
    });
    assert.equal(COLLECTOR_TEMPLATE_LABEL.includes('openId'), false);
});

test('announcement refreshes are scoped to recipients and omit message content', () => {
    const emissions = [];
    const io = {
        to(room) {
            return {
                emit(event, payload) { emissions.push({ room, event, payload }); }
            };
        },
        emit() { assert.fail('audience notifications must not use a global Socket broadcast'); }
    };
    publishAnnouncementRefresh(io, [{
        recipientOpenId: 'reviewer-a',
        title: 'private-title',
        content: 'private-content'
    }], 'reviewer');

    assert.deepEqual(emissions, [
        {
            room: 'user_reviewer-a',
            event: 'notification',
            payload: {
                recipientOpenId: 'reviewer-a',
                title: 'private-title',
                content: 'private-content'
            }
        },
        {
            room: 'user_reviewer-a',
            event: 'announcement',
            payload: { audience: 'reviewer' }
        }
    ]);
    assert.equal(JSON.stringify(emissions[1]).includes('private-content'), false);
});
