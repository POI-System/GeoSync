'use strict';
// 05文档 §9：帮拍匹配 —— 扫描、双向确认、履约、互评。

const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { BizError } = require('../lib/respond');
const bus = require('../lib/eventBus');
const checkinService = require('./checkinService');

const COLORS = ['蓝色', '橙色', '青色', '紫色', '银色', '金色', '绿色', '绯色'];
const BIRDS = ['山雀', '翠鸟', '云雀', '夜莺', '画眉', '白鹭', '燕子', '雨燕'];
const QUICK_MSGS = ['我到了', '稍等5分钟', '抱歉来不了了'];

function codename() {
    return COLORS[Math.floor(Math.random() * COLORS.length)] +
        BIRDS[Math.floor(Math.random() * BIRDS.length)];
}

// jobs/pairingScan 调用：全量扫描 optIn 活跃行程的摄影站交集
async function scan() {
    const { Itinerary, Pairing, PairingProfile } = getModels();
    const its = await Itinerary.find({
        state: 'active', 'preferences.pairingOptIn': true
    }).lean();
    if (its.length < 2) return 0;

    const openIds = its.map(i => i.openId);
    const profiles = await PairingProfile.find({ openId: { $in: openIds } }).lean();
    const profMap = new Map(profiles.map(p => [p.openId, p]));

    // 已有当日 pairing 的用户排除
    const busy = new Set();
    const activePairs = await Pairing.find({
        state: { $in: ['proposed', 'confirmed'] }, 'users.openId': { $in: openIds }
    }).lean();
    for (const p of activePairs) for (const u of p.users) busy.add(u.openId);

    // 按 spotId 分组收集 (user, spot, arrive)
    const bySpot = new Map();
    for (const it of its) {
        if (busy.has(it.openId)) continue;
        const prof = profMap.get(it.openId);
        if (prof?.banned || prof?.enabled === false) continue;
        for (const s of it.stops) {
            if (!s.photoSpotId || !['pending', 'approaching'].includes(s.state)) continue;
            const key = String(s.photoSpotId);
            if (!bySpot.has(key)) bySpot.set(key, []);
            bySpot.get(key).push({
                openId: it.openId, itineraryId: it._id,
                spotId: s.photoSpotId, poiId: s.poiId,
                plannedArrive: s.plannedArrive, profile: prof || {}
            });
        }
    }

    // 组内两两配对 → 贪心取全局 matchScore 最大不相交集合
    const pairs = [];
    const windowMin = its.length < 20 ? 30 : 15; // 池小放宽（附录A风险对策）
    for (const [, users] of bySpot) {
        for (let i = 0; i < users.length; i++) {
            for (let j = i + 1; j < users.length; j++) {
                const a = users[i], b = users[j];
                if (a.openId === b.openId) continue;
                const dtMin = Math.abs(new Date(a.plannedArrive) - new Date(b.plannedArrive)) / 60000;
                if (dtMin > windowMin) continue;
                if (!genderOk(a, b)) continue;
                const score =
                    0.5 * (1 - dtMin / windowMin) +
                    0.3 * avgStarsNorm(a.profile, b.profile) +
                    0.2 * fulfillRateNorm(a.profile, b.profile);
                pairs.push({ a, b, score });
            }
        }
    }
    pairs.sort((x, y) => y.score - x.score);
    const used = new Set();
    let created = 0;
    for (const p of pairs) {
        if (used.has(p.a.openId) || used.has(p.b.openId)) continue;
        used.add(p.a.openId);
        used.add(p.b.openId);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const doc = await Pairing.create({
            scenicId: CONFIG.scenicId,
            spotId: p.a.spotId, poiId: p.a.poiId,
            users: [p.a, p.b].map(u => ({
                openId: u.openId, codename: codename(),
                itineraryId: u.itineraryId, plannedArrive: u.plannedArrive
            })),
            matchScore: p.score,
            expireAt: endOfDay
        });
        bus.emit(bus.EVENTS.PAIRING_PROPOSED, { pairing: doc });
        created++;
    }
    return created;
}

function genderOk(a, b) {
    const check = (x, y) => x.profile?.genderFilter !== 'female' || y.profile?.gender === 'female';
    return check(a, b) && check(b, a);
}
function avgStarsNorm(pa, pb) {
    const s = ((pa.avgStars || 3.5) + (pb.avgStars || 3.5)) / 2;
    return s / 5;
}
function fulfillRateNorm(pa, pb) {
    const rate = p => {
        const total = (p.fulfillCount || 0) + (p.noShowCount || 0);
        return total ? (p.fulfillCount || 0) / total : 0.7; // 新用户默认0.7
    };
    return (rate(pa) + rate(pb)) / 2;
}

async function respond(pairingId, openId, accept) {
    const { Pairing } = getModels();
    const p = await Pairing.findById(pairingId);
    if (!p || p.state !== 'proposed') throw new BizError(5102, '匹配已失效');
    const me = p.users.find(u => u.openId === openId);
    if (!me) throw new BizError(5102, '非本人匹配');
    me.accepted = accept;
    if (!accept) {
        p.state = 'declined'; // 对方表现为静默过期，不发拒绝事件
    } else if (p.users.every(u => u.accepted === true)) {
        p.state = 'confirmed';
    }
    await p.save();
    if (p.state === 'confirmed') {
        bus.emit(bus.EVENTS.PAIRING_PROPOSED, { pairing: p, confirmed: true });
    }
    return p;
}

// 履约：双方围栏内打卡（arrivedAt 由 STAY_OPENED 事件回填）或任一方传凭证照
async function fulfill(pairingId, openId, proofPhotoUrl = null) {
    const { Pairing, PairingProfile } = getModels();
    const p = await Pairing.findById(pairingId);
    if (!p || p.state !== 'confirmed') throw new BizError(5102, '匹配未确认或已失效');
    const me = p.users.find(u => u.openId === openId);
    if (!me) throw new BizError(5102, '非本人匹配');
    if (proofPhotoUrl) me.proofPhotoUrl = proofPhotoUrl;
    me.arrivedAt = me.arrivedAt || new Date();

    const bothArrived = p.users.every(u => u.arrivedAt);
    const hasProof = p.users.some(u => u.proofPhotoUrl);
    if ((bothArrived || hasProof) && !p.pointsAwarded) {
        p.state = 'fulfilled';
        p.pointsAwarded = true;
        for (const u of p.users) {
            await checkinService.addPoints(u.openId, 20, 'pairing', p._id);
            await PairingProfile.updateOne(
                { openId: u.openId },
                { $inc: { fulfillCount: 1 } },
                { upsert: true }
            );
        }
    }
    await p.save();
    return p;
}

async function rate(pairingId, openId, stars) {
    const { Pairing, PairingProfile } = getModels();
    const p = await Pairing.findById(pairingId);
    if (!p) throw new BizError(5102, '匹配不存在');
    const other = p.users.find(u => u.openId !== openId);
    if (!other) throw new BizError(5102, '匹配数据异常');
    if (p.ratings.some(r => r.from === openId)) return p;
    p.ratings.push({ from: openId, to: other.openId, stars });
    await p.save();
    // 更新对方 avgStars（增量均值）
    const prof = await PairingProfile.findOneAndUpdate(
        { openId: other.openId }, {}, { upsert: true, new: true }
    );
    const n = (prof.fulfillCount || 0) + 1;
    prof.avgStars = ((prof.avgStars || 3.5) * (n - 1) + stars) / n;
    await prof.save();
    return p;
}

// 对外脱敏视图：只露 codename（03文档 §7）
function publicView(pairing, myOpenId) {
    const other = pairing.users.find(u => u.openId !== myOpenId);
    const me = pairing.users.find(u => u.openId === myOpenId);
    return {
        pairingId: pairing._id,
        spotId: pairing.spotId,
        state: pairing.state,
        myAccepted: me?.accepted,
        other: other ? {
            codename: other.codename,
            plannedArrive: other.plannedArrive,
            arrived: Boolean(other.arrivedAt)
        } : null,
        quickMessages: pairing.quickMessages.map(m => ({
            mine: m.from === myOpenId, text: QUICK_MSGS[m.preset], at: m.at
        }))
    };
}

module.exports = { scan, respond, fulfill, rate, publicView, QUICK_MSGS };
