'use strict';
// 01文档：复用 poi 平台微信模板/邮件能力的桥接层。
// 挂载模式：attach 时注入 sendTemplate/sendMail；独立模式：仅日志。
const { publicProposalView } = require('./geosyncEngine');

let helpers = { sendTemplate: null, sendMail: null };
let ioRef = null;

function setHelpers(h) { helpers = { ...helpers, ...h }; }
function setIo(io) { ioRef = io; }
function getIo() { return ioRef; }

function proposalSocketPayload(itineraryId, version, proposal, diff) {
    const publicProposal = publicProposalView(proposal, diff);
    const contextualProposal = {
        proposalId: publicProposal.proposalId,
        itineraryId,
        version,
        type: publicProposal.type,
        reason: publicProposal.reason,
        gainMin: publicProposal.gainMin,
        expireAt: publicProposal.expireAt,
        diff: publicProposal.diff
    };
    return {
        ...contextualProposal,
        proposal: { ...contextualProposal }
    };
}

function progressSocketPayload(progress = {}) {
    return {
        itineraryId: progress.itineraryId,
        version: progress.version,
        state: progress.state,
        stops: Array.isArray(progress.stops) ? progress.stops.map(rawStop => {
            const stop = typeof rawStop?.toObject === 'function' ? rawStop.toObject() : rawStop || {};
            return {
                stopId: stop.stopId,
                poiId: stop.poiId,
                state: stop.state,
                actualArrive: stop.actualArrive || null,
                actualLeave: stop.actualLeave || null
            };
        }) : []
    };
}

// 提案离线降级（04文档 §1.4）：房间无活跃 socket 且 gain>15 → 微信模板
async function pushProposal(openId, itineraryId, version, proposal, diff) {
    const recipient = String(openId || '').trim();
    if (!ioRef || !recipient) return;
    const socketPayload = proposalSocketPayload(itineraryId, version, proposal, diff);
    const publicProposal = socketPayload.proposal;
    const room = `user:${recipient}`;
    ioRef.to(room).emit('itinerary:proposal', socketPayload);
    const sockets = await ioRef.in(room).fetchSockets();
    if (!sockets.length && publicProposal.gainMin > 15 && helpers.sendTemplate) {
        try {
            await helpers.sendTemplate(recipient, process.env.TPL_REROUTE || '', {
                first: { value: '行程改道建议' },
                keyword1: { value: publicProposal.reason?.slice(0, 40) || '' },
                keyword2: { value: `预计节省${publicProposal.gainMin}分钟` },
                remark: { value: '点击查看并确认' }
            });
        } catch (e) {
            console.error('[GeoSync] [NOTIFY] template failed:', e?.name || 'Error');
        }
    }
}

function pushProgress(openId, progress) {
    const recipient = String(openId || '').trim();
    if (!ioRef || !recipient) return;
    ioRef.to(`user:${recipient}`).emit('itinerary:progress', progressSocketPayload(progress));
}

async function alertAdmin(level, subject, body) {
    console.warn(`[GeoSync] [ALERT:${level}]`, subject, body);
    if (level === 'red' && helpers.sendMail) {
        try {
            await helpers.sendMail(process.env.ALERT_EMAIL || '', `[红色预警] ${subject}`, body);
        } catch (e) {
            console.error('[GeoSync] [NOTIFY] mail failed:', e?.name || 'Error');
        }
    }
}

module.exports = {
    setHelpers,
    setIo,
    getIo,
    progressSocketPayload,
    pushProposal,
    pushProgress,
    alertAdmin
};
