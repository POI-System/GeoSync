import { ScreenStore } from '../state/screenStore.js';
import { ReplayEngine } from '../replay/replayEngine.js';
import { ScreenApi, ScreenStreamClient } from '../ops/screenStream.js';
import { OpsMapView } from '../ops/opsMap.js';
import {
    DEMO_CONFIG,
    DEMO_DASHBOARD,
    DEMO_HEALTH,
    DEMO_HEATMAP,
    createDemoReplay
} from '../e2e/demoController.js';

const store = new ScreenStore();
const api = new ScreenApi();
const query = new URLSearchParams(location.search);
const demoMode = query.get('demo') === '1';
const gisPreviewMode = !demoMode && query.get('gis') === '1';
const mapView = new OpsMapView(document.querySelector('#screen-map'));
let stream = null;
let recoveryTimer = null;
let clockTimer = null;
let renderedFrame = null;
let errorTimer = null;
let disposing = false;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function displayTime(value, withSeconds = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '--:--';
    return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false
    }).format(date);
}

function frameSlot(value) {
    const slot = String(value || '');
    const match = slot.match(/T(\d{2}:\d{2})/);
    return match ? match[1] : slot.slice(-5) || '--:--';
}

function healthState(health) {
    const value = String(health?.state || health?.status || '').toLowerCase();
    if (['online', 'healthy', 'ready', 'ok'].includes(value)) return 'online';
    if (['degraded', 'warning', 'pending'].includes(value)) return 'degraded';
    if (['offline', 'error', 'failed', 'unavailable'].includes(value)) return 'offline';
    return 'checking';
}

function showError(message) {
    const element = $('[data-screen-error]');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { element.hidden = true; }, 6000);
}

function renderMetrics(dashboard) {
    $('[data-screen-metric="active"]').textContent = dashboard?.activeItineraries ?? '--';
    $('[data-screen-metric="checkins"]').textContent = dashboard?.todayCheckins ?? '--';
    $('[data-screen-metric="saved"]').textContent = dashboard?.avgSavedMin ?? '--';
    const rate = Number(dashboard?.rerouteAcceptRate);
    $('[data-screen-metric="acceptance"]').textContent = Number.isFinite(rate) ? Math.round(rate * 100) : '--';
}

function renderRanking(frame) {
    const list = $('[data-screen-ranking]');
    list.replaceChildren();
    const items = frame.items.slice().sort((a, b) => Number(b.ci) - Number(a.ci)).slice(0, 7);
    if (!items.length) {
        const empty = document.createElement('li');
        empty.textContent = frame.missing ? '当前区间无快照' : '数据准备中';
        list.append(empty);
        return;
    }
    items.forEach((item, index) => {
        const row = document.createElement('li');
        const rank = document.createElement('span');
        const name = document.createElement('b');
        const ci = document.createElement('strong');
        const level = document.createElement('em');
        rank.textContent = String(index + 1).padStart(2, '0');
        name.textContent = item.name || item.poiId || '--';
        ci.textContent = Number(item.ci || 0).toFixed(2);
        level.textContent = { high: '拥挤', medium: '较忙', low: '舒适' }[item.level] || '待定';
        row.append(rank, name, ci, level);
        list.append(row);
    });
}

function renderAlerts(alerts) {
    const items = alerts.slice(0, 7);
    $('[data-screen-alert-count]').textContent = String(items.length);
    const list = $('[data-screen-alerts]');
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('p');
        empty.textContent = '暂无告警';
        list.append(empty);
        return;
    }
    for (const alert of items) {
        const item = document.createElement('article');
        const dot = document.createElement('i');
        const text = document.createElement('div');
        const title = document.createElement('b');
        const detail = document.createElement('span');
        const time = document.createElement('time');
        title.textContent = alert.name || alert.poiId || '景区告警';
        detail.textContent = `拥挤指数 ${Number(alert.ci || 0).toFixed(2)} · ${alert.level === 'high' ? '高等级' : '关注'}`;
        time.textContent = displayTime(alert.at);
        text.append(title, detail);
        item.append(dot, text, time);
        list.append(item);
    }
}

function renderTimeline(state) {
    const range = $('[data-replay-range]');
    range.max = String(Math.max(0, state.replay.total - 1));
    range.value = String(Math.min(state.replay.index, Math.max(0, state.replay.total - 1)));
    $('[data-timeline-start]').textContent = frameSlot(replay.frames[0]?.slot);
    $('[data-timeline-current]').textContent = frameSlot(state.frame.slot);
    $('[data-timeline-end]').textContent = frameSlot(replay.frames.at(-1)?.slot);
    const play = $('[data-replay-play]');
    play.textContent = state.replay.playing ? 'Ⅱ' : '▶';
    play.setAttribute('aria-label', state.replay.playing ? '暂停' : '播放');
    play.title = state.replay.playing ? '暂停' : '播放';
    $('[data-replay-speed]').value = String(state.replay.speed);
}

function render(state) {
    const shell = document.querySelector('.screen-shell');
    shell.dataset.mode = state.mode;
    shell.dataset.boot = state.boot;
    $('[data-subtitle]').textContent = state.mode === 'replay' ? '历史客流回放与运营复盘' : '实时客流与调度反馈';
    $('[data-frame-mode]').textContent = state.mode === 'replay' ? '历史帧' : '实时帧';
    $('[data-frame-time]').textContent = frameSlot(state.frame.slot);
    $('[data-screen-slot]').textContent = frameSlot(state.frame.slot);
    $('[data-screen-confidence]').hidden = !state.frame.lowConfidence;
    $('[data-frame-missing]').hidden = !state.frame.missing;
    $('[data-reconnect]').hidden = state.connectionState !== 'reconnecting';
    $$('[data-screen-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.screenMode === state.mode)));

    const health = healthState(state.health);
    const healthElement = $('[data-screen-health]');
    healthElement.dataset.state = health;
    healthElement.lastChild.textContent = health === 'online' ? '系统在线' : health === 'degraded' ? '系统降级' : health === 'offline' ? '系统离线' : '系统检查中';
    const connection = $('[data-screen-connection]');
    connection.dataset.state = state.connectionState;
    connection.lastChild.textContent = {
        connected: '实时已连接', connecting: '实时连接中', reconnecting: '实时重连中', offline: '实时离线', preview: 'GIS 只读预览'
    }[state.connectionState] || '实时未知';

    renderMetrics(state.dashboard);
    renderRanking(state.frame);
    renderAlerts(state.alerts);
    renderTimeline(state);
    if (renderedFrame !== state.frame) {
        renderedFrame = state.frame;
        mapView.setCrowd(state.frame);
    }
    if (state.lastError) showError(state.lastError);
}

function renderFrame(frame, { realtime = false } = {}) {
    store.renderFrame(frame, { realtime });
}

const replay = new ReplayEngine({
    onFrame: frame => renderFrame(frame, { realtime: false }),
    onState: replayState => store.updateReplay(replayState),
    frameDurationMs: 1100
});

async function getDashboardOptional() {
    try { return await api.getDashboard(); } catch { return null; }
}

async function recoverSnapshot() {
    if (demoMode || disposing) return;
    try {
        const [frame, dashboard] = await Promise.all([api.getHeatmap(), getDashboardOptional()]);
        renderFrame(frame, { realtime: true });
        if (dashboard) store.setDashboard(dashboard);
    } catch (error) {
        store.fail(error);
    }
}

function streamStateChanged(state) {
    if (disposing) return;
    store.setConnectionState(state);
    if (state === 'connected') {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
    } else if (state === 'reconnecting' && recoveryTimer === null) {
        recoveryTimer = setTimeout(() => {
            recoveryTimer = null;
            void recoverSnapshot();
        }, 30000);
    }
}

function streamEvent(name, payload) {
    if (name === 'heatmap') renderFrame(payload, { realtime: true });
    if (name === 'alert') store.addAlert(payload);
    if (name === 'stats') store.setDashboard({ ...(store.getState().dashboard || {}), ...payload });
}

async function loadReplay() {
    const date = $('[data-replay-date]').value;
    if (!date) return;
    store.enterReplay(date, 0);
    replay.pause();
    try {
        const payload = demoMode ? createDemoReplay() : await api.getReplay(date);
        const total = replay.load(payload);
        store.updateReplay({ date, total, missing: total === 0 });
        if (!total) store.fail(new Error('该日期无回放数据'));
    } catch (error) {
        replay.stop();
        store.updateReplay({ total: 0, missing: true });
        store.fail(error);
    }
}

async function enterRealtime() {
    replay.pause();
    store.exitReplay();
    try {
        const frame = demoMode ? DEMO_HEATMAP : await api.getHeatmap();
        renderFrame(frame, { realtime: true });
    } catch (error) {
        store.fail(error);
    }
}

async function bootstrap() {
    store.subscribe(render);
    $$('[data-screen-mode]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.screenMode === 'realtime') void enterRealtime();
        else void loadReplay();
    }));
    $('[data-replay-load]').addEventListener('click', loadReplay);
    $('[data-replay-play]').addEventListener('click', () => {
        if (store.getState().replay.playing) replay.pause();
        else replay.play(Number($('[data-replay-speed]').value));
    });
    $$('[data-replay-step]').forEach(button => button.addEventListener('click', () => replay.step(Number(button.dataset.replayStep))));
    $('[data-replay-range]').addEventListener('input', event => replay.seek(Number(event.target.value)));
    $('[data-replay-speed]').addEventListener('change', event => {
        const speed = Number(event.target.value);
        store.updateReplay({ speed });
        if (store.getState().replay.playing) replay.play(speed);
    });
    clockTimer = setInterval(() => { $('[data-wall-clock]').textContent = displayTime(new Date(), true); }, 1000);
    $('[data-wall-clock]').textContent = displayTime(new Date(), true);

    try {
        const [config, health, frame, dashboard, graph, managedPois] = demoMode
            ? [DEMO_CONFIG, DEMO_HEALTH, DEMO_HEATMAP, DEMO_DASHBOARD, null, []]
            : await Promise.all([
                api.getConfig(), api.getHealth(), api.getHeatmap(), getDashboardOptional(),
                gisPreviewMode ? api.getGraph() : Promise.resolve(null),
                gisPreviewMode ? api.getManagedPois().then(result => result?.items || []).catch(() => []) : Promise.resolve([])
            ]);
        store.ready({ config, health, frame, dashboard });
        await mapView.init(config);
        if (graph) mapView.setGraph(graph);
        mapView.setCrowd(frame);
        mapView.setManagedPois(managedPois);
        if (demoMode) {
            store.setConnectionState('connected');
        } else if (gisPreviewMode) {
            store.setConnectionState('preview');
        } else {
            stream = new ScreenStreamClient({ onEvent: streamEvent, onState: streamStateChanged });
            stream.connect();
        }
    } catch (error) {
        store.fail(error, { fatal: true });
    }
}

function dispose() {
    disposing = true;
    clearInterval(clockTimer);
    clearTimeout(recoveryTimer);
    clearTimeout(errorTimer);
    stream?.disconnect();
    replay.destroy();
    mapView.destroy();
}

window.addEventListener('pagehide', dispose, { once: true });
void bootstrap();
