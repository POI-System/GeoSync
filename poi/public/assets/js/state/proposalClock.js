export function proposalRemainingMs(expireAt, now = Date.now()) {
    const expires = new Date(expireAt).getTime();
    return Number.isFinite(expires) ? Math.max(0, expires - Number(now)) : 0;
}

export function isProposalExpired(expireAt, now = Date.now()) {
    return proposalRemainingMs(expireAt, now) === 0;
}

export function formatProposalCountdown(expireAt, now = Date.now()) {
    const remaining = proposalRemainingMs(expireAt, now);
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
