'use strict';
// 05文档 §10：LLM 网关 —— AI 讲解（缓存优先）+ NL 行程编辑（JSON Schema 强校验）。
// LLM 未配置 → BizError 6101，路由层转降级。

const axios = require('axios');
const { CONFIG } = require('../config');
const { getModels } = require('../models');
const { BizError } = require('../lib/respond');

const LLM_TIMEOUT_MS = 8000;

function seasonOf(d = new Date()) {
    const m = d.getMonth() + 1;
    return m <= 2 || m === 12 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
}
function daypartOf(d = new Date()) {
    const h = d.getHours();
    return h < 11 ? 'morning' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : 'evening';
}

// ---- A. 情境化讲解 ----
async function getGuide(poiId, daypart = null) {
    const { AiGuideCache, ExternalPoi } = getModels();
    const season = seasonOf();
    const dp = daypart || daypartOf();
    const weatherKind = 'any'; // TODO(P6)：接天气 API 后细分 sunny/rainy/cloudy

    const cached = await AiGuideCache.findOneAndUpdate(
        { poiId, season, daypart: dp, weatherKind },
        { $inc: { hits: 1 } },
        { new: true }
    ).lean();
    if (cached) return { text: cached.text, ttsUrl: cached.ttsUrl || null, cached: true };

    if (!CONFIG.features.guide) throw new BizError(6101, 'AI讲解暂不可用', 503);
    const poi = await ExternalPoi.findById(poiId).lean();
    if (!poi) throw new BizError(6102, '点位不存在', 404);

    const prompt = [
        '你是景区讲解员。用中文写一段约150字的60秒口播讲解词，口吻亲切自然，不要开头问候语。',
        `点位名称：${poi.poiName}`,
        `点位介绍（众包审核库）：${poi.description || '暂无'}`,
        `当前季节：${season}，时段：${dp}`,
        '只依据以上介绍内容展开，不要编造史实细节。'
    ].join('\n');
    const text = await callLLM(prompt, 500);
    await AiGuideCache.create({ poiId, season, daypart: dp, weatherKind, text, ttsUrl: null });
    return { text, ttsUrl: null, cached: false };
}

// ---- B. NL 行程编辑 → 结构化 ops ----
const VALID_OPS = new Set(['pin_window', 'set_preference', 'add_poi', 'remove_poi', 'shift_time', 'end_early']);

async function parseNlEdit(text, itinerarySummary) {
    if (!CONFIG.features.nlEdit) throw new BizError(6101, '自然语言编辑暂不可用', 503);
    const prompt = [
        '把游客的行程修改请求解析为 JSON 操作指令。只输出 JSON，不要其他文字。',
        '可用操作（ops 数组，每项含 op 字段）：',
        '{"op":"pin_window","target":"<photoSpotId|sunset|sunrise>","window":"golden-evening"}',
        '{"op":"set_preference","pace":"relaxed|normal|tight","avoidTags":[],"preferTags":[]}',
        '{"op":"add_poi","poiId":"...","position":"auto"}',
        '{"op":"remove_poi","poiId":"..."}',
        '{"op":"shift_time","minutes":30}',
        '{"op":"end_early","at":"16:00"}',
        `当前行程：${JSON.stringify(itinerarySummary)}`,
        `游客请求：${text}`,
        '输出格式：{"ops":[...]}'
    ].join('\n');

    let raw;
    for (let attempt = 0; attempt < 2; attempt++) {
        raw = await callLLM(prompt, 400);
        try {
            const m = raw.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(m ? m[0] : raw);
            const ops = (parsed.ops || []).filter(validateOp); // 非法 op 静默丢弃
            if (ops.length) return ops;
        } catch { /* retry */ }
    }
    throw new BizError(1207, '未能理解该请求，试试"下午想看日落"或"少安排点爬山的"');
}

function validateOp(op) {
    if (!op || !VALID_OPS.has(op.op)) return false;
    switch (op.op) {
        case 'pin_window': return typeof op.target === 'string';
        case 'set_preference':
            return ['relaxed', 'normal', 'tight', undefined].includes(op.pace) &&
                (!op.avoidTags || Array.isArray(op.avoidTags)) &&
                (!op.preferTags || Array.isArray(op.preferTags));
        case 'add_poi': case 'remove_poi': return typeof op.poiId === 'string';
        case 'shift_time': return Number.isFinite(op.minutes) && Math.abs(op.minutes) <= 240;
        case 'end_early': return /^\d{2}:\d{2}$/.test(op.at || '');
        default: return false;
    }
}

// Anthropic Messages API 形状（LLM_API_URL 可指向兼容网关）
async function callLLM(prompt, maxTokens) {
    try {
        const r = await axios.post(CONFIG.llm.url, {
            model: CONFIG.llm.model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: {
                'x-api-key': CONFIG.llm.key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            timeout: LLM_TIMEOUT_MS
        });
        const text = r.data?.content?.[0]?.text;
        if (!text) throw new Error('empty LLM response');
        return text;
    } catch (e) {
        if (e instanceof BizError) throw e;
        console.error('[GeoSync] [LLM]', e.message);
        throw new BizError(6101, 'AI服务暂不可用', 503);
    }
}

module.exports = { getGuide, parseNlEdit, validateOp, seasonOf, daypartOf };
