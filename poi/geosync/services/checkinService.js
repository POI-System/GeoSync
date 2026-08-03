'use strict';
// 05文档 §8：打卡四重校验流水线（fail-fast）+ 积分账本 + 徽章。

const crypto = require('crypto');
const {
    SessionAuthConfigurationError,
    validateSessionSecret,
    timingSafeEqualText
} = require('../lib/sessionAuth');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { BizError, safeErrorCode } = require('../lib/respond');
const geo = require('../lib/geo');
const walkGraph = require('./walkGraph');
const bus = require('../lib/eventBus');

// OCR 函数注入位：挂载模式传入 poi 平台的阿里云 OCR；独立模式为 null（全部转人工）
let ocrFn = null;
function setOcrFn(fn) { ocrFn = fn; }

/**
 * 四重校验
 * @returns {status:'verified'|'pending', checkin, points, badge}
 */
async function verify({
    openId,
    poiId,
    lng,
    lat,
    photoUrl,
    viaQrCode = false,
    onUploadReferencePersisted = null
}) {
    const { ExternalPoi, Checkin } = getModels();
    const poi = await ExternalPoi.findById(poiId).lean();
    if (!poi || poi.status !== 'approved') throw new BizError(3101, '点位不存在');
    const date = geo.dateStrOf(new Date());

    // 幂等（3104）
    const dup = await Checkin.findOne({ openId, poiId, date }).lean();
    if (dup) throw new BizError(3104, '今日该点位已打卡');

    // 当日上限（3105）
    const todayCount = await Checkin.countDocuments({ openId, date });
    if (todayCount >= 30) throw new BizError(3105, '已达当日打卡上限');

    // ① GPS 距离（3101，扫码跳过）
    let gpsDistanceM = null;
    if (!viaQrCode) {
        const coords = walkGraph.poiCoords(poi);
        if (!coords) throw new BizError(3101, '点位坐标缺失');
        gpsDistanceM = Math.round(geo.haversine([lng, lat], coords));
        if (gpsDistanceM > 100) throw new BizError(3101, `距离点位${gpsDistanceM}米，需在100米内打卡`);
    }

    // ② 时间合理性（3103）：与上次 verified 打卡的间隔 ≥ 路网最短步行 × 0.8
    const prev = await Checkin.findOne({ openId, date, status: 'verified' }).sort({ at: -1 }).lean();
    if (prev) {
        const prevPoi = await ExternalPoi.findById(prev.poiId).lean();
        if (prevPoi) {
            const route = walkGraph.walkSecBetween(prevPoi, poi);
            if (route) {
                const minSec = route.walkSec * 0.8;
                const elapsedSec = (Date.now() - new Date(prev.at).getTime()) / 1000;
                if (elapsedSec < minSec) {
                    throw new BizError(3103, '打卡间隔过短，疑似异常');
                }
            }
        }
    }

    // ③ OCR（扫码通道跳过；无 OCR 能力 → 转人工）
    let ocrResult = { matched: false, confidence: 0, text: '' };
    let status = 'pending';
    if (viaQrCode) {
        status = 'verified';
    } else if (ocrFn && photoUrl) {
        try {
            ocrResult = await runOcr(photoUrl, poi);
            status = (ocrResult.matched && ocrResult.confidence >= 0.75) ? 'verified' : 'pending';
        } catch (e) {
            console.error('[GeoSync] [CHECKIN] OCR failed:', safeErrorCode(e, 'OCR_FAILED'));
            status = 'pending'; // 超时/失败 → 202 人工
        }
    }

    // ④ 计分 + 落库
    const points = status === 'verified' ? await computePoints(poi, viaQrCode) : 0;
    const checkin = await Checkin.create({
        scenicId: CONFIG.scenicId, openId, poiId, date,
        proof: {
            photoUrl, ocrText: ocrResult.text, ocrConfidence: ocrResult.confidence,
            matched: ocrResult.matched, gpsDistanceM
        },
        status, points, viaQrCode
    });
    if (photoUrl && typeof onUploadReferencePersisted === 'function') {
        onUploadReferencePersisted(checkin);
    }

    let badge = null, totalPoints = 0;
    if (status === 'verified') {
        totalPoints = await addPoints(openId, points, 'checkin', checkin._id);
        badge = await badgeProgress(openId, poi);
        bus.emit(bus.EVENTS.CHECKIN_VERIFIED, { openId, checkinId: checkin._id, points, badge });
    }
    return { status, checkin, points, totalPoints, badge };
}

async function runOcr(photoUrl, poi) {
    const raw = await ocrFn(photoUrl); // 期望返回识别文本 string
    const text = String(raw || '');
    const aliases = [poi.poiName, ...(poi.aliases || [])].filter(Boolean);
    let matched = false, matchedAlias = '', best = 0;
    for (const alias of aliases) {
        if (text.includes(alias)) { matched = true; matchedAlias = alias; best = 1; break; }
        const sim = similarity(alias, text);
        if (sim > best) { best = sim; matchedAlias = alias; }
    }
    if (best >= 0.6) matched = true;
    return { matched, confidence: best, text: text.slice(0, 200), matchedAlias };
}

// 归一化编辑距离相似度（在 OCR 全文中滑窗找 alias 最佳匹配）
function similarity(needle, haystack) {
    if (!needle || !haystack) return 0;
    const n = needle.length;
    let best = 0;
    for (let i = 0; i + n <= haystack.length; i++) {
        const window = haystack.slice(i, i + n);
        const d = editDistance(needle, window);
        best = Math.max(best, 1 - d / n);
        if (best === 1) break;
    }
    return best;
}

function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[a.length][b.length];
}

async function computePoints(poi, viaQrCode) {
    const { Campaign } = getModels();
    let base = viaQrCode ? 5 : 10; // 扫码减半（03文档 §6.3）
    const now = new Date();
    const camp = await Campaign.findOne({
        state: 'active', startAt: { $lte: now }, endAt: { $gte: now },
        areaPoiIds: poi._id
    }).lean();
    if (camp) base *= camp.multiplier;
    return base;
}

// 积分账本：refId 查重幂等 + 原子 $inc（02文档 §12）
async function addPoints(openId, delta, reason, refId) {
    const { UserPoints } = getModels();
    const existing = await UserPoints.findOne({ openId, 'ledger.refId': refId }).lean();
    if (existing) return existing.balance;
    const doc = await UserPoints.findOneAndUpdate(
        { openId },
        {
            $inc: { balance: delta },
            $push: { ledger: { at: new Date(), delta, reason, refId } }
        },
        { upsert: true, new: true }
    );
    return doc.balance;
}

async function badgeProgress(openId, poi) {
    const { Badge, Checkin } = getModels();
    const badges = await Badge.find({ active: true, poiIds: poi._id }).lean();
    if (!badges.length) return null;
    const b = badges[0];
    const checked = await Checkin.distinct('poiId', {
        openId, status: 'verified', poiId: { $in: b.poiIds }
    });
    const unlocked = checked.length >= b.poiIds.length;
    return {
        id: b.badgeId, name: b.name,
        progress: `${checked.length}/${b.poiIds.length}`, unlocked
    };
}

// 扫码 token：HMAC(poiId+日期)，日轮换（03文档 §6.3）
function qrTokenOf(poiId, date = new Date()) {
    const key = validateSessionSecret(CONFIG.hmacSecret, {
        name: 'POSITION_HMAC_SECRET',
        minBytes: 32
    });
    const day = geo.dateStrOf(date);
    return crypto.createHmac('sha256', key)
        .update(`qr:${poiId}:${day}`).digest('hex').slice(0, 16);
}

function verifyQrToken(token, date = new Date()) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [poiId, sig] = parts;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(poiId) || !/^[a-f0-9]{16}$/.test(sig)) return null;
    try {
        return timingSafeEqualText(sig, qrTokenOf(poiId, date)) ? poiId : null;
    } catch (error) {
        if (error instanceof SessionAuthConfigurationError) return null;
        throw error;
    }
}

module.exports = { verify, setOcrFn, addPoints, badgeProgress, similarity, editDistance, qrTokenOf, verifyQrToken };
