import { OpsStore } from '../state/opsStore.js';
import { OpsApi } from '../ops/opsApi.js';
import { OpsMapView } from '../ops/opsMap.js';
import { OpsRealtime } from '../ops/opsRealtime.js';
import { DemoController } from '../e2e/demoController.js';

const store = new OpsStore();
const api = new OpsApi();
const query = new URLSearchParams(location.search);
const demoMode = query.get('demo') === '1';
const gisPreviewMode = !demoMode && query.get('gis') === '1';
const demo = demoMode ? new DemoController({ store }) : null;
const mapView = new OpsMapView(document.querySelector('#ops-map'), {
    onEdgeSelected: edgeId => store.selectEdge(edgeId)
});
let realtime = null;
let dashboardTimer = null;
let toastTimer = null;
let renderedGraph = null;
let renderedHeatmap = null;
let dialogOperation = null;
let managedPois = [];
let currentPoiPhoto = '';
let poiPhotoDirty = false;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeText(value, fallback = '--') {
    const text = value === undefined || value === null || value === '' ? fallback : String(value);
    return text;
}

function timeText(value, { includeDate = false } = {}) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '--:--:--';
    return new Intl.DateTimeFormat('zh-CN', {
        ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
}

function percent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number * 100)}` : '--';
}

function healthState(health, key) {
    const raw = key ? health?.[key]?.state ?? health?.[key]?.status : health?.state ?? health?.status;
    const value = String(raw || '').toLowerCase();
    if (['online', 'healthy', 'ready', 'ok', 'connected'].includes(value)) return 'online';
    if (['degraded', 'warning', 'pending'].includes(value)) return 'degraded';
    if (['offline', 'error', 'failed', 'unavailable'].includes(value)) return 'offline';
    return 'checking';
}

function healthLabel(state, onlineLabel = '在线') {
    return state === 'online' ? onlineLabel : state === 'degraded' ? '降级' : state === 'offline' ? '离线' : '检查中';
}

function setStatus(name, state, label) {
    const element = $(`[data-status="${name}"]`);
    if (!element) return;
    element.dataset.state = state;
    element.querySelector('em').textContent = label;
}

function showToast(message) {
    const toast = $('[data-toast]');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function selectedEdge(state) {
    return state.graph.edges.find(edge => String(edge.edgeId) === state.selectedEdgeId) || null;
}

function renderMetrics(dashboard) {
    $('[data-metric="active"]').textContent = escapeText(dashboard?.activeItineraries);
    $('[data-metric="checkins"]').textContent = escapeText(dashboard?.todayCheckins);
    $('[data-metric="saved"]').textContent = escapeText(dashboard?.avgSavedMin);
    $('[data-metric="acceptance"]').textContent = percent(dashboard?.rerouteAcceptRate);
}

function renderRanking(state) {
    const items = (state.heatmap.length ? state.heatmap : state.dashboard?.top10 || [])
        .slice().sort((a, b) => Number(b.ci) - Number(a.ci)).slice(0, 6);
    const list = $('[data-ranking]');
    list.replaceChildren();
    if (!items.length) {
        const row = document.createElement('li');
        row.className = 'empty-row';
        row.textContent = '数据准备中';
        list.append(row);
        return;
    }
    const trendLabels = { up: '上升', down: '回落', flat: '平稳' };
    items.forEach((item, index) => {
        const row = document.createElement('li');
        const rank = document.createElement('span');
        const name = document.createElement('b');
        const ci = document.createElement('strong');
        const trend = document.createElement('em');
        rank.textContent = String(index + 1).padStart(2, '0');
        name.textContent = escapeText(item.name, escapeText(item.poiId));
        ci.textContent = Number(item.ci).toFixed(2);
        trend.textContent = trendLabels[item.trend] || trendLabels[
            item.predicted?.p30 > item.ci + .05 ? 'up' : item.predicted?.p30 < item.ci - .05 ? 'down' : 'flat'
        ];
        row.append(rank, name, ci, trend);
        list.append(row);
    });
}

function eventPresentation(event) {
    if (event.type === 'impact') return {
        title: `影响评估完成 · ${event.edgeId}`,
        detail: `受影响 ${event.affectedItineraries}，提案 ${event.proposalsCreated}，失败 ${event.failed}`,
        kind: 'impact'
    };
    if (event.type === 'proposal') return {
        title: `提案状态 · ${event.status}`,
        detail: `行程 ${event.itineraryId} · v${event.version}`,
        kind: 'proposal'
    };
    if (event.type === 'graph') return {
        title: `${event.status === 'closed' ? '路段已关闭' : '路段已恢复'} · ${event.edgeId}`,
        detail: event.reason || '路网状态已同步',
        kind: 'graph'
    };
    return {
        title: `${event.name || event.poiId || '客流'}拥挤告警`,
        detail: `拥挤指数 ${Number(event.ci || 0).toFixed(2)}`,
        kind: 'alert'
    };
}

function renderEvents(state) {
    const events = [
        ...state.operationEvents,
        ...state.alerts.map(alert => ({ ...alert, type: 'alert' }))
    ].sort((a, b) => new Date(b.at || b.completedAt) - new Date(a.at || a.completedAt)).slice(0, 12);
    $('[data-event-count]').textContent = String(events.length);
    const list = $('[data-events]');
    list.replaceChildren();
    if (!events.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-row';
        empty.textContent = '暂无运营事件';
        list.append(empty);
        return;
    }
    for (const event of events) {
        const item = document.createElement('article');
        const presentation = eventPresentation(event);
        item.className = `event-item event-item--${presentation.kind}`;
        const dot = document.createElement('i');
        const text = document.createElement('div');
        const title = document.createElement('b');
        const detail = document.createElement('span');
        const time = document.createElement('time');
        title.textContent = presentation.title;
        detail.textContent = presentation.detail;
        time.textContent = timeText(event.at || event.completedAt);
        text.append(title, detail);
        item.append(dot, text, time);
        list.append(item);
    }
}

function renderEdge(state) {
    const edge = selectedEdge(state);
    $('[data-edge-name]').textContent = edge?.name || '请选择可运营路段';
    $('[data-edge-id]').textContent = edge?.edgeId || '--';
    const values = edge ? [
        edge.type || edge.kind || '步行路',
        Number.isFinite(Number(edge.distanceM)) ? `${Math.round(edge.distanceM)} m` : '--',
        edge.stairs ? '有' : '无',
        Number.isFinite(Number(edge.slope)) ? `${Number(edge.slope).toFixed(1)}%` : '--',
        Number.isFinite(Number(edge.shade)) ? `${Math.round(Number(edge.shade) * 100)}%` : '--',
        edge.accessible === true ? '可通行' : edge.accessible === false ? '受限' : '未标注'
    ] : Array(6).fill('--');
    $$('[data-edge-details] dd').forEach((element, index) => { element.textContent = values[index]; });

    const pending = state.pendingOperation?.edgeId === edge?.edgeId ? state.pendingOperation : null;
    const status = pending ? 'processing' : edge?.status || 'none';
    const statusLabels = { processing: '处理中', open: '正常通行', closed: '已关闭', none: '未选择' };
    const congestionLabels = { smooth: '畅通', busy: '较忙', congested: '拥堵' };
    const statusElement = $('[data-edge-status]');
    statusElement.textContent = edge && !pending
        ? `${statusLabels[status] || escapeText(status)} · ${congestionLabels[edge.congestion] || '畅通'}`
        : statusLabels[status] || escapeText(status);
    statusElement.dataset.state = status;
    $('[data-edge-note]').textContent = pending
        ? `事件 ${pending.eventId || '等待受理'} · 不预估影响人数`
        : edge?.warning
            ? `警告：${edge.warning}`
            : edge?.status === 'closed' && edge.closedReason
                ? `原因：${edge.closedReason}`
            : '仅带 edgeId 的正式路网边可操作';
    const gisAvailable = !['offline'].includes(healthState(state.health, 'gis'));
    const readOnly = Boolean(state.config?.preview?.readOnly);
    if (readOnly && edge) $('[data-edge-note]').textContent = 'SXR iServer 真实路网只读预览';
    $('[data-action="close"]').disabled = readOnly || !edge || edge.status !== 'open' || Boolean(pending) || !gisAvailable;
    $('[data-action="open"]').disabled = readOnly || !edge || edge.status !== 'closed' || Boolean(pending) || !gisAvailable;
    $('[data-action="edit-edge"]').disabled = !state.config?.preview?.localManagement || !edge || Boolean(pending);
}

function render(state) {
    document.querySelector('.ops-shell').dataset.boot = state.boot;
    renderMetrics(state.dashboard);
    renderRanking(state);
    renderEvents(state);
    renderEdge(state);
    $('[data-last-updated]').textContent = timeText(state.lastUpdatedAt);
    $('[data-heatmap-slot]').textContent = state.heatmapMeta.slot?.slice(-5) || '--';
    $('[data-confidence]').hidden = !state.heatmapMeta.lowConfidence;
    for (const key of Object.keys(state.proposalStats)) {
        $(`[data-proposal="${key}"]`).textContent = String(state.proposalStats[key]);
    }

    const overall = healthState(state.health);
    const gis = healthState(state.health, 'gis');
    const mongo = state.health?.mongo
        ? healthState(state.health, 'mongo')
        : healthState({ state: state.health?.database?.state || state.health?.database?.status });
    const jobs = healthState(state.health, 'jobs');
    setStatus('health', overall, healthLabel(overall, '正常'));
    setStatus('gis', gis, healthLabel(gis));
    setStatus('mongo', mongo, healthLabel(mongo));
    setStatus('jobs', jobs, healthLabel(jobs, '正常'));
    const socketLabels = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', offline: '轮询中', preview: '只读预览' };
    setStatus('socket', state.socketState, socketLabels[state.socketState] || '未知');
    $('[data-version]').textContent = `数据版本 ${state.health?.dataVersion || state.health?.data?.version || state.config?.gis?.dataVersion || '--'}`;
    mapView.setConnectionState(state.socketState);

    if (renderedGraph !== state.graph) {
        renderedGraph = state.graph;
        mapView.setGraph(state.graph);
    }
    if (renderedHeatmap !== state.heatmap) {
        renderedHeatmap = state.heatmap;
        mapView.setCrowd({ ...state.heatmapMeta, items: state.heatmap });
    }
    mapView.selectEdge(state.selectedEdgeId);
    if (state.lastError) showToast(state.lastError);
}

async function refreshDashboard() {
    if (demoMode) return;
    try {
        const [dashboard, heatmap, health] = await Promise.all([
            api.getDashboard(), api.getHeatmap(), api.getHealth()
        ]);
        store.setDashboard(dashboard);
        store.setHeatmap(heatmap);
        store.setHealth(health);
    } catch (error) {
        store.fail(error);
    }
}

async function refreshGraph() {
    if (demoMode) return;
    try { store.setGraph(await api.getGraph()); } catch (error) { store.fail(error); }
}

function renderPoiPhoto(photo) {
    const preview = $('[data-photo-preview]');
    const image = preview.querySelector('img');
    image.src = photo || '';
    preview.hidden = !photo;
}

function renderPoiList() {
    const list = $('[data-poi-list]');
    list.replaceChildren();
    const activeId = $('[data-poi-form]').elements.poiId.value;
    if (!managedPois.length) {
        const empty = document.createElement('p');
        empty.className = 'poi-list-empty';
        empty.textContent = '暂无景点';
        list.append(empty);
        return;
    }
    for (const poi of managedPois) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `poi-list-item${poi.poiId === activeId ? ' is-active' : ''}`;
        const name = document.createElement('strong');
        const coordinate = document.createElement('span');
        name.textContent = poi.name;
        coordinate.textContent = `${Number(poi.lng).toFixed(6)}, ${Number(poi.lat).toFixed(6)}`;
        button.append(name, coordinate);
        if (poi.photo) {
            const image = document.createElement('img');
            image.src = poi.photo;
            image.alt = '';
            button.append(image);
        }
        button.addEventListener('click', () => openPoiManager(poi));
        list.append(button);
    }
}

function openPoiManager(poi = null) {
    const form = $('[data-poi-form]');
    form.reset();
    form.elements.poiId.value = poi?.poiId || '';
    form.elements.name.value = poi?.name || '';
    form.elements.lng.value = poi?.lng ?? '';
    form.elements.lat.value = poi?.lat ?? '';
    form.elements.note.value = poi?.note || '';
    currentPoiPhoto = poi?.photo || '';
    poiPhotoDirty = false;
    renderPoiPhoto(currentPoiPhoto);
    $('[data-poi-delete]').hidden = !poi;
    renderPoiList();
    const dialog = $('[data-poi-dialog]');
    if (!dialog.open) dialog.showModal();
}

async function refreshManagedPois() {
    const payload = await api.getManagedPois();
    managedPois = Array.isArray(payload?.items) ? payload.items : [];
    mapView.setManagedPois(managedPois);
    renderPoiList();
    return managedPois;
}

function readPhoto(file) {
    if (!file) return Promise.resolve('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
        return Promise.reject(new Error('照片须为 2MB 以内的 JPG、PNG 或 WebP 图片'));
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('照片读取失败'));
        reader.readAsDataURL(file);
    });
}

async function submitPoi(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const payload = {
        name: form.elements.name.value.trim(),
        lng: Number(form.elements.lng.value),
        lat: Number(form.elements.lat.value),
        note: form.elements.note.value.trim(),
        ...(poiPhotoDirty ? { photo: currentPoiPhoto } : {})
    };
    const poiId = form.elements.poiId.value;
    try {
        const saved = poiId ? await api.updatePoi(poiId, payload) : await api.createPoi(payload);
        await refreshManagedPois();
        openPoiManager(saved);
        showToast(poiId ? '景点已更新' : '景点已创建');
    } catch (error) { showToast(error.message); }
}

async function deleteCurrentPoi() {
    const poiId = $('[data-poi-form]').elements.poiId.value;
    if (!poiId || !window.confirm('确认删除这个景点？')) return;
    try {
        await api.deletePoi(poiId);
        await refreshManagedPois();
        openPoiManager(null);
        showToast('景点已删除');
    } catch (error) { showToast(error.message); }
}

function startPoiPick() {
    const dialog = $('[data-poi-dialog]');
    dialog.close();
    const notice = $('[data-map-notice]');
    notice.textContent = '单击地图确定景点坐标';
    notice.hidden = false;
    mapView.pickPoint(([lng, lat]) => {
        const form = $('[data-poi-form]');
        form.elements.lng.value = lng.toFixed(6);
        form.elements.lat.value = lat.toFixed(6);
        notice.hidden = true;
        dialog.showModal();
    });
}

function openRoadEditor() {
    const edge = selectedEdge(store.getState());
    if (!edge) return;
    const form = $('[data-road-form]');
    form.elements.status.value = edge.status === 'closed' ? 'closed' : 'open';
    form.elements.congestion.value = edge.congestion || 'smooth';
    form.elements.warning.value = edge.warning || edge.closedReason || '';
    $('[data-road-edge]').textContent = edge.name || edge.edgeId;
    $('[data-road-edge-id]').textContent = edge.edgeId;
    $('[data-road-dialog]').showModal();
}

async function submitRoadEdit(event) {
    event.preventDefault();
    const edge = selectedEdge(store.getState());
    if (!edge) return;
    const form = event.currentTarget;
    try {
        await api.updateEdge(edge.edgeId, {
            status: form.elements.status.value,
            congestion: form.elements.congestion.value,
            warning: form.elements.warning.value.trim()
        });
        $('[data-road-dialog]').close();
        await refreshGraph();
        showToast('路段状态已保存');
    } catch (error) { showToast(error.message); }
}

function handleRealtimeEvent(name, payload) {
    if (name === 'geosync:joined') {
        store.setSocketState(payload?.ok === false ? 'offline' : 'connected', payload?.rooms || []);
    } else if (name === 'crowd:update') store.applyCrowdUpdate(payload);
    else if (name === 'graph:update') store.applyGraphUpdate(payload);
    else if (name === 'alert:crowd') {
        store.addAlert(payload);
        mapView.flashAlert();
    }
    else if (name === 'ops:impact') store.applyImpact(payload);
    else if (name === 'ops:proposal-status') store.applyProposalStatus(payload);
}

function openOperationDialog(operation) {
    const edge = selectedEdge(store.getState());
    if (!edge) return;
    dialogOperation = operation;
    $('[data-dialog-kicker]').textContent = operation === 'close' ? '道路管制' : '恢复通行';
    $('[data-dialog-title]').textContent = operation === 'close' ? '确认关闭路段' : '确认恢复通行';
    $('[data-dialog-edge]').textContent = edge.name || edge.edgeId;
    $('[data-dialog-edge-id]').textContent = edge.edgeId;
    $('[data-reason-field]').hidden = operation !== 'close';
    $('[data-duration-field]').hidden = operation !== 'close';
    $('[data-operation-form]').elements.reason.disabled = operation !== 'close';
    $('[data-operation-form]').elements.reason.required = operation === 'close';
    $('[data-operation-form]').elements.duration.disabled = operation !== 'close';
    $('[data-dialog-warning]').textContent = operation === 'close'
        ? '关闭后可能触发游客改道。影响人数仅在评估完成后显示。'
        : '恢复后不会自动撤回游客已经接受的改道路线。';
    const submit = $('[data-dialog-submit]');
    submit.textContent = operation === 'close' ? '确认关闭' : '确认恢复';
    submit.className = `button ${operation === 'close' ? 'button--danger' : 'button--primary'}`;
    $('[data-operation-form]').reset();
    $('[data-reason-count]').textContent = '0';
    $('[data-operation-dialog]').showModal();
}

async function submitOperation(event) {
    event.preventDefault();
    const edge = selectedEdge(store.getState());
    if (!edge || !dialogOperation) return;
    const form = event.currentTarget;
    const reason = form.elements.reason.value.trim();
    const durationValue = form.elements.duration.value;
    if (dialogOperation === 'close' && !reason) {
        form.elements.reason.reportValidity();
        return;
    }
    const durationMin = durationValue ? Number(durationValue) : null;
    store.startOperation({ edgeId: edge.edgeId, operation: dialogOperation, reason, durationMin });
    $('[data-operation-dialog]').close();
    try {
        const response = demoMode
            ? await demo[dialogOperation === 'close' ? 'closeEdge' : 'openEdge'](edge.edgeId, reason, durationMin)
            : await api[dialogOperation === 'close' ? 'closeEdge' : 'openEdge'](edge.edgeId, reason, durationMin);
        store.acceptOperation(response);
        if (gisPreviewMode) {
            store.applyGraphUpdate({
                eventId: response.eventId,
                edgeId: edge.edgeId,
                status: response.status,
                reason,
                at: response.acceptedAt
            });
            await refreshGraph();
            showToast('路段状态已保存');
        } else showToast('请求已受理，等待路网事件确认');
    } catch (error) {
        store.rejectOperation(error);
        await refreshGraph();
    }
}

async function bootstrap() {
    store.subscribe(render);
    $('[data-action="close"]').addEventListener('click', () => openOperationDialog('close'));
    $('[data-action="open"]').addEventListener('click', () => openOperationDialog('open'));
    $('[data-action="edit-edge"]').addEventListener('click', openRoadEditor);
    $('[data-road-close]').addEventListener('click', () => $('[data-road-dialog]').close());
    $('[data-road-form]').addEventListener('submit', submitRoadEdit);
    $('[data-poi-manager]').addEventListener('click', () => openPoiManager(null));
    $('[data-poi-close]').addEventListener('click', () => {
        mapView.cancelPointSelection();
        $('[data-map-notice]').hidden = true;
        $('[data-poi-dialog]').close();
    });
    $('[data-poi-new]').addEventListener('click', () => openPoiManager(null));
    $('[data-poi-pick]').addEventListener('click', startPoiPick);
    $('[data-poi-form]').addEventListener('submit', submitPoi);
    $('[data-poi-delete]').addEventListener('click', deleteCurrentPoi);
    $('[data-photo-remove]').addEventListener('click', () => {
        currentPoiPhoto = '';
        poiPhotoDirty = true;
        $('[data-poi-form]').elements.photo.value = '';
        renderPoiPhoto('');
    });
    $('[data-poi-form]').elements.photo.addEventListener('change', async event => {
        try {
            currentPoiPhoto = await readPhoto(event.target.files?.[0]);
            poiPhotoDirty = true;
            renderPoiPhoto(currentPoiPhoto);
        } catch (error) {
            event.target.value = '';
            showToast(error.message);
        }
    });
    $('[data-dialog-close]').addEventListener('click', () => $('[data-operation-dialog]').close());
    $('[data-dialog-cancel]').addEventListener('click', () => $('[data-operation-dialog]').close());
    $('[data-operation-form]').addEventListener('submit', submitOperation);
    $('[data-operation-form] textarea').addEventListener('input', event => {
        $('[data-reason-count]').textContent = String(event.target.value.length);
    });

    try {
        const payload = demoMode ? demo.bootstrap() : await (async () => {
            const [config, health, dashboard, heatmap, graph, pois] = await Promise.all([
                api.getConfig(), api.getHealth(), api.getDashboard(), api.getHeatmap(), api.getGraph(),
                gisPreviewMode ? api.getManagedPois().catch(() => ({ items: [] })) : Promise.resolve({ items: [] })
            ]);
            return { config, health, dashboard, heatmap, graph, managedPois: pois?.items || [] };
        })();
        store.ready(payload);
        managedPois = Array.isArray(payload.managedPois) ? payload.managedPois : [];
        await mapView.init(payload.config);
        mapView.setGraph(store.getState().graph);
        mapView.setCrowd({ ...store.getState().heatmapMeta, items: store.getState().heatmap });
        mapView.setManagedPois(managedPois);
        $('[data-poi-manager]').hidden = !payload.config?.preview?.localManagement;
        renderPoiList();
        if (demoMode) {
            store.setSocketState('connected', [`admin:${payload.config.scenicId}`]);
        } else if (gisPreviewMode) {
            store.setSocketState('preview', []);
        } else {
            realtime = new OpsRealtime({
                scenicId: payload.config.scenicId,
                onEvent: handleRealtimeEvent,
                onState: state => store.setSocketState(state),
                poll: refreshDashboard
            });
            await realtime.connect();
            dashboardTimer = setInterval(refreshDashboard, 30000);
        }
    } catch (error) {
        store.fail(error, { fatal: true });
    }
}

function dispose() {
    clearInterval(dashboardTimer);
    clearTimeout(toastTimer);
    realtime?.destroy();
    demo?.destroy();
    api.destroy();
    mapView.destroy();
}

window.addEventListener('pagehide', dispose, { once: true });
void bootstrap();
