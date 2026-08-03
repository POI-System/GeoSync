import assert from 'node:assert/strict';
import test from 'node:test';

import {
    formatProposalCountdown,
    isProposalExpired,
    proposalRemainingMs
} from '../../../public/assets/js/state/proposalClock.js';

const NOW = Date.parse('2026-08-03T04:00:00.000Z');

test('proposal clock calculates future time without returning negative values', () => {
    const future = new Date(NOW + 125_999).toISOString();
    assert.equal(proposalRemainingMs(future, NOW), 125_999);
    assert.equal(formatProposalCountdown(future, NOW), '2:05');
    assert.equal(isProposalExpired(future, NOW), false);

    const expired = new Date(NOW - 1).toISOString();
    assert.equal(proposalRemainingMs(expired, NOW), 0);
    assert.equal(formatProposalCountdown(expired, NOW), '0:00');
    assert.equal(isProposalExpired(expired, NOW), true);
});

test('proposal clock treats malformed expiry values as expired', () => {
    assert.equal(proposalRemainingMs('invalid-date', NOW), 0);
    assert.equal(isProposalExpired('', NOW), true);
    assert.equal(formatProposalCountdown(null, NOW), '0:00');
});
