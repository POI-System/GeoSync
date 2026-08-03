'use strict';
// 07文档 §1：人流仿真器。独立进程，作为纯 HTTP 客户端压真实服务端。
// node sim/crowd-sim.js --base http://localhost:3100 --users 300 --speed 10 \
//   --strategy anti-herding --script scripts/demo-day.json --report out/sim-x --seed 42 [--pairing]
//
// 服务端需 SIM_MODE=true（开放 /api/sim/register、/api/sim/rain、/api/sim/qrtoken）。
// 提案获取：REST 轮询 GET /api/itinerary/current（不依赖 socket.io-client；
// p95ProposalLatencyMs 为"提案写库→agent 轮询看到"的口径，粒度=虚拟30s一轮）。

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { decodePolyline } = require('../lib/geo');
const { safeErrorCode } = require('../lib/respond');

// ---------- CLI ----------
function parseArgs(argv) {
    const out = {
        base: 'http://localhost:3100', users: 300, speed: 10,
        strategy: 'anti-herding', script: null, report: null, seed: 42, pairing: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--pairing') { out.pairing = true; continue; }
        const v = argv[++i];
        if (k === '--base') out.base = v;
        else if (k === '--users') out.users = Number(v);
        else if (k === '--speed') out.speed = Number(v);
        else if (k === '--strategy') out.strategy = v;
        else if (k === '--script') out.script = v;
        else if (k === '--report') out.report = v;
        else if (k === '--seed') out.seed = Number(v);
    }
    return out;
}
const ARGS = parseArgs(process.argv);

// ---------- 可复现随机（mulberry32）----------
function rngOf(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = rngOf(ARGS.seed);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const gauss = (mu, sigma) => { // Box-Muller
    const u = Math.max(rand(), 1e-9), v = rand();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// 虚拟分钟 → 真实毫秒
const vMin = m => m * 60000 / ARGS.speed;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- HTTP ----------
const http = axios.create({ baseURL: ARGS.base, timeout: 15000, validateStatus: () => true });

// ---------- 指标 ----------
const metrics = {
    startedAt: Date.now(),
    agentsDone: 0, agentsFailed: 0,
    proposalsSeen: 0, proposalsAccepted: 0, proposalsRejected: 0,
    planMs: [], proposalLatencyMs: [],
    checkins: 0, checkinFails: 0
};
function p95(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const INTERESTS = ['photo', 'history', 'nature', 'family', 'food', 'climb'];

// ---------- 虚拟游客 ----------
async function runAgent(n, endAtReal) {
    // 1. register
    const reg = await http.post('/api/sim/register');
    if (reg.status !== 200 || !reg.data?.data?.openId) {
        metrics.agentsFailed++;
        if (reg.status === 404) throw new Error('服务端未开 SIM_MODE（/api/sim/register 404）');
        return;
    }
    const openId = reg.data.data.openId;
    const H = { 'X-Open-Id': openId };
    const paceRoll = rand();
    const prefs = {
        interests: [pick(INTERESTS), pick(INTERESTS)],
        pace: paceRoll < 0.3 ? 'relaxed' : paceRoll < 0.8 ? 'normal' : 'tight',
        accessible: rand() < 0.1
    };
    const speedMps = 1.1 + rand() * 0.5;

    // 帮拍 optin（--pairing 时 30%）
    if (ARGS.pairing && rand() < 0.3) {
        await http.post('/api/pairing/optin', { enabled: true }, { headers: H });
    }

    // 2. plan → start
    const t0 = Date.now();
    const planR = await http.post('/api/itinerary/plan', { hours: 4 + Math.floor(rand() * 4), ...prefs }, { headers: H });
    metrics.planMs.push(Date.now() - t0);
    if (planR.status !== 200 || !planR.data?.success) { metrics.agentsFailed++; return; }
    let it = planR.data.data;
    await http.post(`/api/itinerary/${it.itineraryId}/start`, { version: it.version }, { headers: H });
    let version = it.version + 1;
    let rerouted = 0;

    // 位置上报（每虚拟30s）+ 提案轮询共用节拍
    let pos = null;
    const report = async () => {
        if (!pos) return;
        const drift = rand() < 0.05 ? (50 + rand() * 100) / 111320 : 0; // 5% 峡谷漂移
        await http.post('/api/position', {
            lng: pos[0] + drift * (rand() - 0.5) * 2,
            lat: pos[1] + drift * (rand() - 0.5) * 2,
            acc: Math.max(3, 10 + (rand() - 0.5) * 10),
            ts: Date.now(), mode: 'tour'
        }, { headers: H }).catch(() => {});
    };
    const pollProposal = async () => {
        const r = await http.get('/api/itinerary/current', { headers: H }).catch(() => null);
        const cur = r?.data?.data;
        if (!cur) return false;
        version = cur.version;
        const pp = cur.pendingProposal;
        if (pp?.proposalId) {
            metrics.proposalsSeen++;
            metrics.proposalLatencyMs.push(vMin(0.5)); // 轮询口径下限
            const acceptProb = 0.55 - 0.1 * rerouted;
            const decision = rand() < acceptProb ? 'accept' : 'reject';
            const dr = await http.post(
                `/api/itinerary/${cur.itineraryId}/proposal/${pp.proposalId}/${decision}`,
                { version }, { headers: H }
            );
            if (dr.status === 200 && dr.data?.success) {
                if (decision === 'accept') { metrics.proposalsAccepted++; rerouted++; }
                else metrics.proposalsRejected++;
                version = dr.data.data.version ?? version + 1;
                return decision === 'accept';
            }
        }
        return false;
    };

    // 3~4. 逐站移动 + 停留 + 打卡
    let stops = it.stops;
    for (let si = 0; si < stops.length && Date.now() < endAtReal; si++) {
        // accept 后行程变了 → 重新对齐
        const cr = await http.get('/api/itinerary/current', { headers: H }).catch(() => null);
        const cur = cr?.data?.data;
        if (!cur || ['completed', 'abandoned'].includes(cur.state)) break;
        stops = cur.stops;
        version = cur.version;
        const stop = stops.find(s => s.state === 'pending' || s.state === 'approaching');
        if (!stop) break;

        // 沿 pathGeometry 折线移动
        const line = stop.pathGeometry ? decodePolyline(stop.pathGeometry) : [];
        if (line.length >= 2) {
            let total = 0;
            const segs = [];
            for (let i = 0; i < line.length - 1; i++) {
                const dx = (line[i + 1][0] - line[i][0]) * 111320 * Math.cos(line[i][1] * Math.PI / 180);
                const dy = (line[i + 1][1] - line[i][1]) * 111320;
                const d = Math.sqrt(dx * dx + dy * dy);
                segs.push(d); total += d;
            }
            const walkVirtMin = total / speedMps / 60;
            const steps = Math.max(1, Math.round(walkVirtMin * 2)); // 每虚拟30s一步
            for (let k = 1; k <= steps && Date.now() < endAtReal; k++) {
                // 按弧长插值
                let target = (k / steps) * total, acc = 0, p = line[0];
                for (let i = 0; i < segs.length; i++) {
                    if (acc + segs[i] >= target) {
                        const t = segs[i] ? (target - acc) / segs[i] : 0;
                        p = [line[i][0] + (line[i + 1][0] - line[i][0]) * t,
                             line[i][1] + (line[i + 1][1] - line[i][1]) * t];
                        break;
                    }
                    acc += segs[i]; p = line[i + 1];
                }
                pos = p;
                await report();
                if (await pollProposal()) break; // 接受改道 → 外层重取行程
                await sleep(vMin(0.5));
            }
        } else {
            await sleep(vMin(2));
        }

        // 到站停留 N(suggestedStay, 0.3σ)，截断 ≥5
        const stayVirtMin = Math.max(5, gauss(20, 6));
        // 停留中 70% 概率扫码打卡
        if (rand() < 0.7) {
            const qt = await http.get(`/api/sim/qrtoken/${stop.poiId}`).catch(() => null);
            const token = qt?.data?.data?.qrToken;
            if (token) {
                const ck = await http.post('/api/checkin/qr', { qrToken: token }, { headers: H });
                if (ck.status === 200 && ck.data?.success) metrics.checkins++;
                else metrics.checkinFails++;
            }
        }
        const stayEnd = Date.now() + vMin(stayVirtMin);
        while (Date.now() < Math.min(stayEnd, endAtReal)) {
            await report();
            await pollProposal();
            await sleep(vMin(0.5));
        }
    }

    // 6. finish
    const fin = await http.get('/api/itinerary/current', { headers: H }).catch(() => null);
    const cur = fin?.data?.data;
    if (cur && ['active', 'paused', 'draft'].includes(cur.state)) {
        await http.post(`/api/itinerary/${cur.itineraryId}/finish`, { version: cur.version }, { headers: H }).catch(() => {});
    }
    metrics.agentsDone++;
}

// ---------- 剧本事件 ----------
async function runScript(script, startReal, adminToken) {
    for (const ev of script.events || []) {
        const fireAt = startReal + vMin(ev.atMin);
        setTimeout(async () => {
            try {
                console.log(`[SIM] 剧本事件: ${ev.type} @虚拟${ev.atMin}min`);
                if (ev.type === 'rain') {
                    await http.post('/api/sim/rain', { startInMin: ev.startInMin, durationMin: ev.durationMin });
                } else if (ev.type === 'closeEdge') {
                    await http.post(`/api/admin/geosync/graph/edge/${ev.edgeId}/close`,
                        { reason: ev.note || '剧本封路' },
                        { headers: { Authorization: `Bearer ${adminToken}` } });
                } else if (ev.type === 'surge') {
                    // 直接投放 N 个即时 agent 冲击指定点位（不规划，直接持续上报该点位置）
                    const heat = await http.get('/api/crowd/heatmap');
                    const item = heat.data?.data?.items?.find(i => i.name === ev.poiName);
                    if (!item?.lnglat) return console.warn(`[SIM] surge 目标"${ev.poiName}"无坐标`);
                    for (let i = 0; i < (ev.users || 50); i++) surgeAgent(item.lnglat).catch(() => {});
                }
            } catch (e) {
                console.error('[SIM] 剧本事件失败:', safeErrorCode(e, 'SIM_EVENT_FAILED'));
            }
        }, Math.max(0, fireAt - Date.now())).unref?.();
    }
}

async function surgeAgent(lnglat) {
    const reg = await http.post('/api/sim/register');
    const openId = reg.data?.data?.openId;
    if (!openId) return;
    const H = { 'X-Open-Id': openId };
    for (let i = 0; i < 20; i++) { // 持续10虚拟分钟停留
        await http.post('/api/position', {
            lng: lnglat[0] + (rand() - 0.5) * 0.0003,
            lat: lnglat[1] + (rand() - 0.5) * 0.0003,
            acc: 10, ts: Date.now(), mode: 'tour'
        }, { headers: H }).catch(() => {});
        await sleep(vMin(0.5));
    }
}

// ---------- CI 时间线采样（报告用）----------
const ciTimeline = []; // {slot, poiId, name, ci}
async function sampleHeatmap() {
    const r = await http.get('/api/crowd/heatmap').catch(() => null);
    const d = r?.data?.data;
    if (!d?.items) return;
    for (const i of d.items) {
        ciTimeline.push({ slot: d.slot, poiId: String(i.poiId), name: i.name, ci: i.ci });
    }
}

// ---------- 报告 ----------
function writeReport(dir) {
    fs.mkdirSync(dir, { recursive: true });
    // ci-timeline.csv
    const csv = ['slot,poiId,name,ci',
        ...ciTimeline.map(r => `${r.slot},${r.poiId},"${r.name}",${r.ci}`)].join('\n');
    fs.writeFileSync(path.join(dir, 'ci-timeline.csv'), csv);

    // 全局 CI 方差（各时间片方差的均值）与峰值
    const bySlot = new Map();
    for (const r of ciTimeline) {
        if (!bySlot.has(r.slot)) bySlot.set(r.slot, []);
        bySlot.get(r.slot).push(r.ci);
    }
    let varSum = 0, varN = 0, peakCi = 0;
    for (const [, cis] of bySlot) {
        peakCi = Math.max(peakCi, ...cis);
        if (cis.length < 2) continue;
        const mean = cis.reduce((a, b) => a + b, 0) / cis.length;
        varSum += cis.reduce((a, v) => a + (v - mean) ** 2, 0) / cis.length;
        varN++;
    }
    const summary = {
        strategy: ARGS.strategy, users: ARGS.users, speed: ARGS.speed, seed: ARGS.seed,
        durationRealMin: Math.round((Date.now() - metrics.startedAt) / 60000),
        agentsDone: metrics.agentsDone, agentsFailed: metrics.agentsFailed,
        ciVarianceGlobal: varN ? Math.round(varSum / varN * 10000) / 10000 : null,
        peakCi,
        proposalsSent: metrics.proposalsSeen,
        acceptRate: metrics.proposalsSeen
            ? Math.round(metrics.proposalsAccepted / metrics.proposalsSeen * 100) / 100 : null,
        checkins: metrics.checkins, checkinFails: metrics.checkinFails,
        p95PlanMs: p95(metrics.planMs),
        p95ProposalLatencyMs: p95(metrics.proposalLatencyMs)
    };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    writeCompareHtml(dir);
    console.log('[SIM] 报告已写入', dir);
    console.log(JSON.stringify(summary, null, 2));
}

// compare.html：读取同目录下 summary-naive.json / summary-anti-herding.json（两次运行后手动改名）
// 或以本次 csv 画单策略曲线。Chart.js CDN 单文件。
function writeCompareHtml(dir) {
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>GeoSync 仿真对比</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body{font-family:system-ui;margin:24px;background:#0f172a;color:#e2e8f0}
h1{font-size:20px}.card{background:#1e293b;border-radius:12px;padding:16px;margin:16px 0}</style>
</head><body>
<h1>双策略 CI 方差对比（naive vs anti-herding）</h1>
<div class="card"><canvas id="chart" height="120"></canvas></div>
<div class="card" id="meta"></div>
<script>
async function loadCsv(name){
  try{const t=await (await fetch(name)).text();
    const rows=t.trim().split('\\n').slice(1).map(l=>{const c=l.split(',');return {slot:c[0],ci:parseFloat(c[c.length-1])}});
    const bySlot=new Map();
    for(const r of rows){if(!bySlot.has(r.slot))bySlot.set(r.slot,[]);bySlot.get(r.slot).push(r.ci)}
    return [...bySlot.entries()].map(([slot,cis])=>{
      const m=cis.reduce((a,b)=>a+b,0)/cis.length;
      return {slot,v:cis.reduce((a,x)=>a+(x-m)**2,0)/cis.length}});
  }catch{return null}}
(async()=>{
  const cur=await loadCsv('ci-timeline.csv');
  const naive=await loadCsv('../sim-naive/ci-timeline.csv'); // 双跑约定目录
  const labels=(cur||naive||[]).map(r=>r.slot.slice(11));
  new Chart(document.getElementById('chart'),{type:'line',data:{labels,
    datasets:[
      cur&&{label:'本次(${ARGS.strategy})',data:cur.map(r=>r.v),borderColor:'#38bdf8',tension:.3},
      naive&&{label:'naive',data:naive.map(r=>r.v),borderColor:'#f87171',tension:.3}
    ].filter(Boolean)},
    options:{scales:{y:{title:{display:true,text:'CI 方差'}}},plugins:{legend:{labels:{color:'#e2e8f0'}}}}});
  const s=await (await fetch('summary.json')).json();
  document.getElementById('meta').innerHTML='<pre>'+JSON.stringify(s,null,2)+'</pre>';
})();
</script></body></html>`;
    fs.writeFileSync(path.join(dir, 'compare.html'), html);
}

// ---------- 主流程 ----------
async function main() {
    console.log(`[SIM] base=${ARGS.base} users=${ARGS.users} speed=${ARGS.speed}x strategy=${ARGS.strategy} seed=${ARGS.seed}`);
    const script = ARGS.script ? JSON.parse(fs.readFileSync(ARGS.script, 'utf8')) : null;
    const durVirtMin = script?.durationVirtualMin || 480;
    const endAtReal = Date.now() + vMin(durVirtMin);
    const reportDir = ARGS.report || `out/sim-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

    // 健康检查
    const healthAdminToken = String(process.env.ADMIN_TOKEN || '').trim();
    if (!healthAdminToken) {
        console.error('[SIM] ADMIN_TOKEN is required for the protected health preflight');
        process.exit(1);
    }
    const h = await http.get('/api/admin/geosync/health', {
        headers: {
            authorization: `Bearer ${healthAdminToken}`
        }
    }).catch(() => null);
    if (!h || h.status !== 200) {
        console.error('[SIM] 服务端不可达:', ARGS.base);
        process.exit(1);
    }
    if (!h.data.simMode) {
        console.error('[SIM] 服务端未开启 SIM_MODE，无法注册虚拟游客');
        process.exit(1);
    }

    const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
    if (script && !adminToken) {
        console.error('[SIM] ADMIN_TOKEN 未配置，无法执行管理端剧本事件');
        process.exit(1);
    }
    if (script) runScript(script, Date.now(), adminToken);

    // heatmap 采样（每虚拟10分钟一帧）
    const sampler = setInterval(sampleHeatmap, vMin(10));

    // agent 泊松到达：前 1/4 时长内均匀入场
    const spawnWindow = vMin(durVirtMin / 4);
    const tasks = [];
    for (let i = 0; i < ARGS.users; i++) {
        const delay = rand() * spawnWindow;
        tasks.push((async () => {
            await sleep(delay);
            await runAgent(i, endAtReal).catch(e => {
                metrics.agentsFailed++;
                if (String(e.message).includes('SIM_MODE')) throw e;
            });
        })());
    }
    // 进度输出
    const progress = setInterval(() => {
        console.log(`[SIM] done=${metrics.agentsDone} failed=${metrics.agentsFailed} ` +
            `proposals=${metrics.proposalsSeen} accepted=${metrics.proposalsAccepted} checkins=${metrics.checkins}`);
    }, 15000);

    try {
        await Promise.all(tasks);
    } finally {
        clearInterval(sampler);
        clearInterval(progress);
        await sampleHeatmap();
        writeReport(reportDir);
    }
}

main().catch(e => {
    console.error('[SIM] fatal:', safeErrorCode(e, 'SIM_FATAL'));
    process.exit(1);
});
