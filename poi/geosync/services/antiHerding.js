'use strict';
// 05文档 §5：防羊群三层 —— 容量配额 + softmax 概率采样 + token 生命周期。
// （第三层负反馈在 forecastService.arrivingCount 内实现：已接受改道计入流入项）

const crypto = require('crypto');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const forecast = require('./forecastService');
const memCache = require('../lib/memCache');
const { safeErrorCode } = require('../lib/respond');

const CLAIM_TTL_MS = 2 * 60000;

function recommendationLimit({ comfortCapacity, currentOccupancy, naturalInflow }) {
    return Math.max(0, Math.floor(
        Math.max(Number(comfortCapacity) || 0, 0) -
        Math.max(Number(currentOccupancy) || 0, 0) -
        Math.max(Number(naturalInflow) || 0, 0)
    ));
}

function projectedInputs(poi, targetTime) {
    const comfort = poi.visitMeta?.comfortCapacity ?? 50;
    const inflow = forecast.arrivingCount(poi._id, targetTime);
    const heat = memCache.get('heatmap')?.items?.find(i => String(i.poiId) === String(poi._id));
    return {
        comfortCapacity: comfort,
        currentOccupancy: heat?.presentEst || 0,
        naturalInflow: inflow
    };
}

// 未来时间片可供“尚未接受的推荐”使用的配额。已接受推荐已进入 arrivalIndex，不重复扣 Token。
async function quota(poi, timeSlot, targetTime, deps = {}) {
    const CapacityToken = deps.CapacityToken || getModels().CapacityToken;
    const limit = recommendationLimit(projectedInputs(poi, targetTime));
    const now = deps.now || new Date();
    const held = await CapacityToken.countDocuments({
        scenicId: CONFIG.scenicId,
        poiId: poi._id,
        timeSlot,
        state: { $in: ['held', 'claiming'] },
        holdUntil: { $gt: now }
    });
    return { remaining: Math.max(0, limit - held), limit };
}

/**
 * 从候选替代点中概率化选一个并扣 token
 * @param candidates [{poi, gain, etaSlot, targetTime}] 按 gain 降序 ≤5
 * @param itineraryId
 * @returns {poi, tokenId, gain} | null
 */
async function pickAlternative(candidates, itineraryId) {
    const { CapacityToken } = getModels();

    // 第一层：配额过滤
    const viable = [];
    for (const c of candidates) {
        const q = await quota(c.poi, c.etaSlot, c.targetTime);
        if (q.remaining > 0) viable.push({ ...c, quota: q.remaining, reservationLimit: q.limit });
    }
    if (!viable.length) return null;

    // naive 策略（仿真对比用）：直接取 gain 最大
    if (CONFIG.simMode && CONFIG.simStrategy === 'naive') {
        return await holdToken(viable[0], itineraryId);
    }

    // 第二层：softmax 概率采样，τ 随近5分钟已推荐次数升高
    const weights = viable.map(c => {
        const pushed = memCache.countRecent(`push:${c.poi._id}`, 5 * 60000);
        const tau = 1 * (1 + pushed / 3);
        return Math.exp(c.gain / tau);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    let picked = viable[viable.length - 1];
    for (let i = 0; i < viable.length; i++) {
        r -= weights[i];
        if (r <= 0) { picked = viable[i]; break; }
    }
    return await holdToken(picked, itineraryId);
}

function slotSequence(limit, start = 0) {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const first = ((start % limit) + limit) % limit;
    return Array.from({ length: limit }, (_, i) => (first + i) % limit);
}

function duplicateKey(e) { return e?.code === 11000 || e?.code === 11001; }

async function holdToken(cand, itineraryId, deps = {}) {
    const CapacityToken = deps.CapacityToken || getModels().CapacityToken;
    const now = deps.now || new Date();
    const holdUntil = new Date(cand.holdUntil || now.getTime() + CONFIG.capacityTokenTtlS * 1000);
    const purgeAt = new Date(holdUntil.getTime() + 60000);
    const requestedLimit = Math.max(0, Math.floor(cand.reservationLimit || 0));
    const liveLimit = recommendationLimit(projectedInputs(cand.poi, cand.targetTime));
    const limit = Math.min(requestedLimit, liveLimit);

    await CapacityToken.deleteMany({
        scenicId: CONFIG.scenicId,
        poiId: cand.poi._id,
        timeSlot: cand.etaSlot,
        state: 'held',
        holdUntil: { $lte: now }
    });
    const legacyBase = {
        scenicId: CONFIG.scenicId,
        poiId: cand.poi._id,
        timeSlot: cand.etaSlot,
        capacitySlot: { $exists: false }
    };
    const [legacyHeld, legacyClaiming] = await Promise.all([
        CapacityToken.countDocuments({
            ...legacyBase, state: 'held', holdUntil: { $gt: now }
        }),
        CapacityToken.countDocuments({ ...legacyBase, state: 'claiming' })
    ]);
    const legacy = legacyHeld + legacyClaiming;
    const occupiedQuery = CapacityToken.find({
        scenicId: CONFIG.scenicId,
        poiId: cand.poi._id,
        timeSlot: cand.etaSlot,
        state: { $in: ['held', 'claiming'] },
        capacitySlot: { $exists: true }
    });
    const occupiedTokens = occupiedQuery && typeof occupiedQuery.lean === 'function'
        ? await occupiedQuery.lean()
        : await occupiedQuery;
    const occupiedSlots = new Set(occupiedTokens.map(token => Number(token.capacitySlot)));
    const available = Math.max(0, limit - legacy - occupiedTokens.length);
    const slots = slotSequence(limit).filter(slot => !occupiedSlots.has(slot)).slice(0, available);
    for (const capacitySlot of slots) {
        try {
            const token = await CapacityToken.create({
                scenicId: CONFIG.scenicId,
                poiId: cand.poi._id,
                timeSlot: cand.etaSlot,
                holderItineraryId: itineraryId,
                capacitySlot,
                targetAt: cand.targetTime,
                holdUntil,
                state: 'held',
                expireAt: purgeAt
            });
            memCache.bump(`push:${cand.poi._id}`);
            return { poi: cand.poi, tokenId: token._id, gain: cand.gain };
        } catch (e) {
            if (!duplicateKey(e)) throw e;
        }
    }
    return null;
}

async function claimTokens(tokenIds, itineraryId, now = new Date(), claimId = null) {
    if (!tokenIds?.length) return true;
    const { CapacityToken } = getModels();
    const ids = [...new Set(tokenIds.map(String))];
    claimId = claimId || 'c_' + crypto.randomBytes(8).toString('hex');
    const claimUntil = new Date(now.getTime() + CLAIM_TTL_MS);
    await CapacityToken.updateMany(
        {
            _id: { $in: ids },
            holderItineraryId: itineraryId,
            state: 'held',
            holdUntil: { $gt: now }
        },
        {
            $set: {
                state: 'claiming', claimId, claimUntil
            },
            $max: { expireAt: new Date(now.getTime() + 24 * 3600000) }
        }
    );
    const claimed = await CapacityToken.countDocuments({
        _id: { $in: ids }, holderItineraryId: itineraryId,
        state: 'claiming', claimId, claimUntil: { $gt: now }
    });
    if (claimed === ids.length) return true;
    await rollbackClaimedTokens(ids, itineraryId, claimId);
    return false;
}

async function claimedTokensActive(tokenIds, itineraryId, claimId, now = new Date()) {
    if (!tokenIds?.length) return true;
    const { CapacityToken } = getModels();
    const ids = [...new Set(tokenIds.map(String))];
    const count = await CapacityToken.countDocuments({
        _id: { $in: ids }, holderItineraryId: itineraryId,
        state: 'claiming', claimId, claimUntil: { $gt: now }
    });
    return count === ids.length;
}

async function rollbackClaimedTokens(tokenIds, itineraryId, claimId = null) {
    if (!tokenIds?.length) return;
    const { CapacityToken } = getModels();
    const query = {
        _id: { $in: tokenIds }, holderItineraryId: itineraryId, state: 'claiming'
    };
    if (claimId) query.claimId = claimId;
    await CapacityToken.updateMany(
        query,
        {
            $set: { state: 'held' },
            $unset: { claimId: 1, claimUntil: 1 }
        }
    );
}

async function finalizeClaimedTokens(tokenIds, itineraryId, claimId = null) {
    if (!tokenIds?.length) return;
    const { CapacityToken } = getModels();
    const query = {
        _id: { $in: tokenIds }, holderItineraryId: itineraryId, state: 'claiming'
    };
    if (claimId) query.claimId = claimId;
    const tokens = await CapacityToken.find(query);
    for (const token of tokens) {
        const targetAt = new Date(token.targetAt || Date.now());
        const expireAt = new Date(targetAt.getTime() + 2 * 3600000);
        const updateQuery = { _id: token._id, state: 'claiming' };
        if (claimId) updateQuery.claimId = claimId;
        await CapacityToken.updateOne(
            updateQuery,
            {
                $set: { state: 'confirmed', expireAt },
                $unset: { capacitySlot: 1, claimId: 1, claimUntil: 1 }
            }
        );
    }
}

async function releaseTokens(tokenIds, itineraryId = null) {
    if (!tokenIds?.length) return;
    const { CapacityToken } = getModels();
    const query = { _id: { $in: tokenIds } };
    if (itineraryId) query.holderItineraryId = itineraryId;
    await CapacityToken.deleteMany(query);
}

async function reconcileTokens(now = new Date()) {
    const { CapacityToken, Itinerary } = getModels();
    const stats = {
        expiredHeld: 0, restoredClaims: 0, finalizedClaims: 0, released: 0,
        arrivalIndexError: null
    };

    const expiredHeld = await CapacityToken.deleteMany({
        state: 'held', holdUntil: { $lte: now }
    });
    stats.expiredHeld = expiredHeld.deletedCount || 0;

    const staleClaims = await CapacityToken.find({
        state: 'claiming',
        $or: [{ claimUntil: { $lte: now } }, { claimUntil: null }]
    }).limit(500).lean();
    const itineraryIds = [...new Set(staleClaims.map(t => String(t.holderItineraryId)))];
    const itineraries = itineraryIds.length
        ? await Itinerary.find({ _id: { $in: itineraryIds } }, { state: 1, stops: 1, pendingProposal: 1 }).lean()
        : [];
    const itineraryMap = new Map(itineraries.map(it => [String(it._id), it]));
    const accepted = [];
    const restore = [];
    const release = [];

    for (const token of staleClaims) {
        const itinerary = itineraryMap.get(String(token.holderItineraryId));
        const linkedStop = itinerary?.stops?.find(s =>
            s.capacityTokenId && String(s.capacityTokenId) === String(token._id));
        if (linkedStop && ['pending', 'approaching'].includes(linkedStop.state)) {
            accepted.push(token);
            continue;
        }
        const proposalOwnsToken = itinerary?.pendingProposal?.tokenIds?.some(id =>
            String(id) === String(token._id));
        if (proposalOwnsToken && new Date(itinerary.pendingProposal.expireAt) > now &&
            new Date(token.holdUntil) > now) {
            restore.push(token);
        } else {
            release.push(token);
        }
    }

    if (accepted.length) {
        try {
            await forecast.rebuildArrivalIndex();
            for (const token of accepted) {
                const targetAt = new Date(token.targetAt || now);
                const r = await CapacityToken.updateOne(
                    { _id: token._id, state: 'claiming', claimId: token.claimId },
                    {
                        $set: { state: 'confirmed', expireAt: new Date(targetAt.getTime() + 2 * 3600000) },
                        $unset: { capacitySlot: 1, claimId: 1, claimUntil: 1 }
                    }
                );
                stats.finalizedClaims += r.modifiedCount || 0;
            }
        } catch (error) {
            stats.arrivalIndexError = safeErrorCode(error, 'ARRIVAL_INDEX_REBUILD_FAILED');
        }
    }
    for (const token of restore) {
        const r = await CapacityToken.updateOne(
            { _id: token._id, state: 'claiming', claimId: token.claimId },
            { $set: { state: 'held' }, $unset: { claimId: 1, claimUntil: 1 } }
        );
        stats.restoredClaims += r.modifiedCount || 0;
    }
    if (release.length) {
        for (const token of release) {
            const r = await CapacityToken.deleteMany({
                _id: token._id, state: 'claiming', claimId: token.claimId
            });
            stats.released += r.deletedCount || 0;
        }
    }

    const confirmed = await CapacityToken.find({ state: 'confirmed' }).limit(500).lean();
    const confirmedItineraryIds = [...new Set(confirmed.map(t => String(t.holderItineraryId)))];
    const confirmedItineraries = confirmedItineraryIds.length
        ? await Itinerary.find({ _id: { $in: confirmedItineraryIds } }, { state: 1, stops: 1 }).lean()
        : [];
    const confirmedItineraryMap = new Map(confirmedItineraries.map(it => [String(it._id), it]));
    const completedTokenIds = confirmed.filter(token => {
        const itinerary = confirmedItineraryMap.get(String(token.holderItineraryId));
        const linkedStop = itinerary?.stops?.find(s =>
            s.capacityTokenId && String(s.capacityTokenId) === String(token._id));
        return !linkedStop || !['pending', 'approaching'].includes(linkedStop.state) ||
            !['active', 'paused'].includes(itinerary.state);
    }).map(token => token._id);
    if (completedTokenIds.length) {
        const r = await CapacityToken.deleteMany({
            _id: { $in: completedTokenIds }, state: 'confirmed'
        });
        stats.released += r.deletedCount || 0;
    }
    return stats;
}

module.exports = {
    quota, pickAlternative, holdToken,
    claimTokens, claimedTokensActive,
    rollbackClaimedTokens, finalizeClaimedTokens, releaseTokens,
    reconcileTokens, recommendationLimit, slotSequence
};
