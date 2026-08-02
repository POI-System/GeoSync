'use strict';
// 01文档：复用 poi 平台微信模板/邮件能力的桥接层。
// 挂载模式：attach 时注入 sendTemplate/sendMail；独立模式：仅日志。

let helpers = { sendTemplate: null, sendMail: null };
let ioRef = null;

function setHelpers(h) { helpers = { ...helpers, ...h }; }
function setIo(io) { ioRef = io; }
function getIo() { return ioRef; }

// 提案离线降级（04文档 §1.4）：房间无活跃 socket 且 gain>15 → 微信模板
async function pushProposal(openId, proposal) {
    if (!ioRef) return;
    const room = `user:${openId}`;
    ioRef.to(room).emit('itinerary:proposal', { proposal });
    const sockets = await ioRef.in(room).fetchSockets();
    if (!sockets.length && proposal.gainMin > 15 && helpers.sendTemplate) {
        try {
            await helpers.sendTemplate(openId, process.env.TPL_REROUTE || '', {
                first: { value: '行程改道建议' },
                keyword1: { value: proposal.reason?.slice(0, 40) || '' },
                keyword2: { value: `预计节省${proposal.gainMin}分钟` },
                remark: { value: '点击查看并确认' }
            });
        } catch (e) {
            console.error('[GeoSync] [NOTIFY] template failed:', e.message);
        }
    }
}

async function alertAdmin(level, subject, body) {
    console.warn(`[GeoSync] [ALERT:${level}]`, subject, body);
    if (level === 'red' && helpers.sendMail) {
        try {
            await helpers.sendMail(process.env.ALERT_EMAIL || '', `[红色预警] ${subject}`, body);
        } catch (e) {
            console.error('[GeoSync] [NOTIFY] mail failed:', e.message);
        }
    }
}

module.exports = { setHelpers, setIo, getIo, pushProposal, alertAdmin };
