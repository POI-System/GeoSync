import { ApiClient, ApiError } from '../api/client.js';
import { DemoApiClient, demoClosedEdge, demoProposal } from '../api/demoClient.js';
import { LocationClient } from '../location/locationClient.js';
import { MapFacade, MapFacadeError } from '../map/mapFacade.js';
import { crowdLabel, routePresentation } from '../map/styles.js';
import { SocketClient } from '../realtime/socketClient.js';
import { formatProposalCountdown, proposalRemainingMs } from '../state/proposalClock.js';
import { TourStore } from '../state/tourStore.js';

const params = new URLSearchParams(window.location.search);
const demo = params.get('demo') === '1';
const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const api = demo
    ? new DemoApiClient()
    : new ApiClient({ openId: params.get('openid') || '', allowLegacyOpenId: localHost && params.get('legacyAuth') === '1' });
const store = new TourStore();
const mapFacade = new MapFacade();
let socketClient = null;
let locationClient = null;
let lastLocation = null;
let proposalTimer = null;
let proposalTimerId = null;
let mapConfig = null;
let toastTimer = null;

const byId = id => document.getElementById(id);
const elements = {
    app: byId('tour-app'),
    activePanel: byId('active-panel'),
    mapStage: byId('map-stage'),
    map: byId('tour-map'),
    mapLoading: byId('map-loading'),
    mapFallback: byId('map-fallback'),
    mapFallbackMessage: byId('map-fallback-message'),
    retryMap: byId('retry-map'),
    rainBanner: byId('rain-banner'),
    connectionBanner: byId('connection-banner'),
    crowdConfidence: byId('crowd-confidence'),
    mapStatusDot: byId('map-status-dot'),
    mapStatusText: byId('map-status-text'),
    socketStatusDot: byId('socket-status-dot'),
    socketStatusText: byId('socket-status-text'),
    locationStatusDot: byId('location-status-dot'),
    locationStatusText: byId('location-status-text'),
    scenicName: byId('scenic-name'),
    poiCount: byId('poi-count'),
    crowdUpdated: byId('crowd-updated'),
    activeState: byId('active-state'),
    poiList: byId('poi-list'),
    planForm: byId('plan-form'),
    hoursRange: byId('hours-range'),
    hoursOutput: byId('hours-output'),
    planMessage: byId('plan-message'),
    submitPlan: byId('submit-plan'),
    previewNote: byId('preview-note'),
    previewMetrics: byId('preview-metrics'),
    previewBadges: byId('preview-badges'),
    previewTimeline: byId('preview-timeline'),
    startTour: byId('start-tour'),
    tourStateTitle: byId('tour-state-title'),
    tourNext: byId('tour-next'),
    tourMetrics: byId('tour-metrics'),
    tourBadges: byId('tour-badges'),
    tourTimeline: byId('tour-timeline'),
    pauseTour: byId('pause-tour'),
    resumeTour: byId('resume-tour'),
    skipStop: byId('skip-stop'),
    finishTour: byId('finish-tour'),
    proposalReason: byId('proposal-reason'),
    proposalCountdown: byId('proposal-countdown'),
    proposalMetrics: byId('proposal-metrics'),
    acceptProposal: byId('accept-proposal'),
    rejectProposal: byId('reject-proposal'),
    completedMetrics: byId('completed-metrics'),
    returnHome: byId('return-home'),
    spotTitle: byId('spot-title'),
    spotSubtitle: byId('spot-subtitle'),
    spotDetail: byId('spot-detail'),
    spotList: byId('spot-list'),
    openScene: byId('open-scene'),
    toast: byId('toast'),
    liveRegion: byId('live-region')
};

function setText(element, value) {
    if (element) element.textContent = value == null ? '' : String(value);
}

function announce(message) {
    setText(elements.liveRegion, message);
}

function showToast(message, timeout = 4200) {
    clearTimeout(toastTimer);
    setText(elements.toast, message);
    elements.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), timeout);
}

function formatTime(value) {
    if (!value) return '--:--';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '--:--' : new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
}

function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
}

function formatDistance(meters) {
    const value = Number(meters || 0);
    return value >= 1000 ? `${(value / 1000).toFixed(1)} 公里` : `${Math.round(value)} 米`;
}

function createMetric(value, label) {
    const item = document.createElement('div');
    item.className = 'metric';
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    setText(strong, value);
    setText(span, label);
    item.append(strong, span);
    return item;
}

function renderMetrics(container, metrics) {
    container.replaceChildren(...metrics.map(([value, label]) => createMetric(value, label)));
}

function createBadge(text, warning = false) {
    const badge = document.createElement('span');
    badge.className = `route-badge${warning ? ' warning' : ''}`;
    setText(badge, text);
    return badge;
}

function renderRouteBadges(container, route) {
    if (!route) {
        container.replaceChildren(createBadge('路线数据准备中', true));
        return;
    }
    const presentation = routePresentation(route);
    const modeLabel = ({ normal: '普通模式', accessible: '无障碍模式', shade: '遮荫模式' })[presentation.mode] || '普通模式';
    const badges = [
        createBadge(modeLabel, !presentation.accessibleVerified),
        createBadge(presentation.label, presentation.degraded)
    ];
    if (!presentation.accessibleVerified) badges.push(createBadge('未验证无障碍通行', true));
    container.replaceChildren(...badges);
}

function renderTimeline(container, itinerary) {
    const crowd = new Map(store.getState().heatmap.map(item => [String(item.poiId), item]));
    const rows = (itinerary?.stops || []).map((stop, index) => {
        const row = document.createElement('li');
        row.className = 'timeline-row';
        const main = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'row-title';
        setText(title, `${index + 1}. ${stop.poiName || `景点 ${index + 1}`}`);
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        const heat = crowd.get(String(stop.poiId));
        const state = ({ pending: '待到达', approaching: '前往中', arrived: '已到达', done: '已完成', skipped: '已跳过', rerouted: '已改道' })[stop.state] || stop.state;
        setText(meta, `${formatTime(stop.plannedArrive)}–${formatTime(stop.plannedLeave)} · ${state}${heat ? ` · ${crowdLabel(heat.level)}` : ''}`);
        main.append(title, meta);
        const status = document.createElement('span');
        status.className = 'route-badge';
        setText(status, state);
        row.append(main, status);
        return row;
    });
    if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        setText(empty, '时刻表准备中');
        rows.push(empty);
    }
    container.replaceChildren(...rows);
}

function renderPois(state) {
    const heat = new Map(state.heatmap.map(item => [String(item.poiId), item]));
    const rows = state.pois.map(poi => {
        const row = document.createElement('li');
        row.className = 'poi-row';
        const main = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'row-title';
        setText(title, poi.poiName || poi.name || '未命名景点');
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        const crowd = heat.get(String(poi.id || poi._id));
        setText(meta, `${poi.category || '景点'} · ${crowd ? crowdLabel(crowd.level) : '人流准备中'}${crowd?.queueEstMin ? ` · 预计等待 ${crowd.queueEstMin} 分钟` : ''}`);
        main.append(title, meta);
        const button = document.createElement('button');
        button.className = 'btn btn-secondary';
        button.type = 'button';
        setText(button, '查看');
        button.addEventListener('click', () => selectPoi(poi));
        row.append(main, button);
        return row;
    });
    if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        setText(empty, '景点数据准备中');
        rows.push(empty);
    }
    elements.poiList.replaceChildren(...rows);
}

function selectPoi(poi) {
    const id = poi.id || poi._id || poi.poiId;
    store.set({ selectedPoiId: String(id) }, 'poi:selected');
    const lng = Number(poi.lng ?? poi.location?.lng);
    const lat = Number(poi.lat ?? poi.location?.lat);
    if (Number.isFinite(lng) && Number.isFinite(lat) && mapFacade.map) {
        mapFacade.fitToGeometry({ type: 'Point', coordinates: [lng, lat] });
    }
    showToast(`${poi.poiName || poi.name || '景点'}：${poi.description || '暂无详情'}`);
}

function stateLabel(itinerary) {
    return ({ draft: '待开始', active: '游览中', paused: '已暂停', completed: '已完成', abandoned: '已结束' })[itinerary?.state] || '未规划';
}

function renderItinerary(state) {
    const itinerary = state.itinerary;
    setText(elements.activeState, stateLabel(itinerary));
    if (!itinerary) return;
    const route = itinerary.route;
    const metrics = [
        [formatDistance(route?.distanceM), '总步行'],
        [formatDuration(route?.durationSec), '路线耗时'],
        [String(itinerary.stops?.length || 0), '站点']
    ];
    renderMetrics(elements.previewMetrics, metrics);
    renderMetrics(elements.tourMetrics, metrics);
    renderRouteBadges(elements.previewBadges, route);
    renderRouteBadges(elements.tourBadges, route);
    renderTimeline(elements.previewTimeline, itinerary);
    renderTimeline(elements.tourTimeline, itinerary);
    setText(elements.previewNote, itinerary.planNote || '路线已按当前服务状态生成');
    const current = itinerary.stops?.find(stop => String(stop.stopId) === String(itinerary.currentStopId))
        || itinerary.stops?.find(stop => ['approaching', 'arrived', 'pending'].includes(stop.state));
    setText(elements.tourStateTitle, itinerary.state === 'paused' ? '游览已暂停' : '游览中');
    setText(elements.tourNext, current ? `当前目标：${current.poiName || '下一站'}` : '行程即将完成');
    elements.pauseTour.classList.toggle('hidden', itinerary.state !== 'active');
    elements.resumeTour.classList.toggle('hidden', itinerary.state !== 'paused');
    elements.skipStop.disabled = !current || !['active', 'paused'].includes(itinerary.state);
    renderMetrics(elements.completedMetrics, [
        [String(itinerary.stops?.filter(stop => stop.state === 'done').length || 0), '完成站点'],
        [formatDistance(route?.distanceM), '总步行'],
        [`${Number(itinerary.savedMinutesTotal || 0)} 分钟`, '累计节省']
    ]);
}

function renderProposal(state) {
    const proposal = state.pendingProposal;
    if (!proposal) {
        clearInterval(proposalTimer);
        proposalTimer = null;
        proposalTimerId = null;
        return;
    }
    setText(elements.proposalReason, proposal.reason || '路线条件发生变化');
    const distanceDelta = Number(proposal.distanceDeltaM ?? proposal.diff?.distanceDeltaM ?? 0);
    const durationDelta = Number(proposal.durationDeltaSec ?? proposal.diff?.durationDeltaSec ?? -(Number(proposal.gainMin || 0) * 60));
    renderMetrics(elements.proposalMetrics, [
        [`${Number(proposal.gainMin || Math.max(0, -durationDelta / 60)).toFixed(0)} 分钟`, '预计节省'],
        [`${distanceDelta >= 0 ? '+' : ''}${formatDistance(Math.abs(distanceDelta))}`, distanceDelta >= 0 ? '额外步行' : '减少步行'],
        [formatTime(proposal.expireAt), '建议到期'],
        [proposal.diff?.after?.length ?? '--', '调整后站点']
    ]);
    const beforeRoute = proposal.beforeRoute || state.itinerary?.route;
    const afterRoute = proposal.afterRoute || proposal.route || proposal.proposedRoute;
    if (beforeRoute?.geometry && afterRoute?.geometry && mapFacade.map) {
        mapFacade.compareRoutes(beforeRoute, afterRoute);
        elements.proposalCountdown.classList.remove('error');
    } else {
        elements.proposalCountdown.classList.add('error');
    }
    startProposalTimer(proposal);
}

function startProposalTimer(proposal) {
    const timerKey = `${proposal.proposalId}:${proposal.expireAt}`;
    if (proposalTimerId === timerKey) return;
    clearInterval(proposalTimer);
    proposalTimerId = timerKey;
    const update = () => {
        const remaining = proposalRemainingMs(proposal.expireAt);
        const hasComparison = Boolean((proposal.afterRoute || proposal.route || proposal.proposedRoute)?.geometry);
        setText(elements.proposalCountdown, remaining
            ? `${hasComparison ? '新旧路线已标注' : '服务端暂未提供新路线几何'} · 剩余 ${formatProposalCountdown(proposal.expireAt)}`
            : '建议已到期，正在同步最新行程');
        if (!remaining) {
            clearInterval(proposalTimer);
            proposalTimer = null;
            elements.acceptProposal.disabled = true;
            elements.rejectProposal.disabled = true;
            void refreshCurrent({ announceChange: true });
        }
    };
    update();
    proposalTimer = setInterval(update, 1000);
}

function renderStatus(state) {
    const mapStates = {
        loading: ['connecting', '地图加载中'], online: ['online', 'GIS 在线'],
        fallback: ['offline', '列表模式'], error: ['error', '地图异常']
    };
    const socketStates = {
        connecting: ['connecting', '实时连接中'], connected: ['connected', '实时已连接'],
        reconnecting: ['reconnecting', '实时重连中'], offline: ['offline', '实时已断开']
    };
    const locationStates = {
        idle: ['idle', '未定位'], requesting: ['connecting', '请求定位'], ready: ['ready', '定位正常'],
        'low-accuracy': ['low-accuracy', '定位精度较低'], denied: ['denied', '定位已拒绝'],
        unavailable: ['offline', '定位不可用'], error: ['error', '定位异常'], 'out-of-fence': ['offline', '已离开景区']
    };
    const [mapDot, mapText] = mapStates[state.mapState] || mapStates.error;
    const [socketDot, socketText] = socketStates[state.socketState] || socketStates.offline;
    const [locationDot, locationText] = locationStates[state.locationState] || locationStates.error;
    elements.mapStatusDot.dataset.state = mapDot;
    elements.socketStatusDot.dataset.state = socketDot;
    elements.locationStatusDot.dataset.state = locationDot;
    setText(elements.mapStatusText, mapText);
    setText(elements.socketStatusText, socketText);
    setText(elements.locationStatusText, locationText);
    elements.connectionBanner.classList.toggle('hidden', !['reconnecting', 'offline'].includes(state.socketState));
    elements.rainBanner.classList.toggle('hidden', !state.rain);
    setText(elements.rainBanner, state.rain?.text || '降雨提醒');
}

function renderPanels(state) {
    document.querySelectorAll('[data-panel]').forEach(panel => {
        const active = panel.dataset.panel === state.activePanel;
        panel.classList.toggle('hidden', !active);
        if (active) panel.setAttribute('tabindex', '-1');
        else panel.removeAttribute('tabindex');
    });
}

function render(state) {
    renderPanels(state);
    renderStatus(state);
    renderPois(state);
    renderItinerary(state);
    renderProposal(state);
    setText(elements.poiCount, state.pois.length);
    const slot = state.heatmapMeta?.slot;
    setText(elements.crowdUpdated, slot ? formatTime(slot) : state.heatmap.length ? formatTime(Date.now()) : '--:--');
    const lowConfidence = Boolean(state.heatmapMeta?.lowConfidence || state.heatmap.some(item => item.lowConfidence));
    setText(elements.crowdConfidence, lowConfidence ? '参考人流' : '实时人流');
    setText(elements.scenicName, demo ? '武汉大学演示景区' : state.config?.scenicName || '游客行程');
    const busy = Boolean(state.busyAction);
    const proposalExpired = Boolean(state.pendingProposal) && !proposalRemainingMs(state.pendingProposal.expireAt);
    for (const button of [elements.submitPlan, elements.startTour, elements.pauseTour, elements.resumeTour, elements.skipStop, elements.finishTour, elements.acceptProposal, elements.rejectProposal]) {
        if (button) {
            const proposalAction = button === elements.acceptProposal || button === elements.rejectProposal;
            button.disabled = busy || (proposalAction && proposalExpired);
        }
    }
    elements.app.setAttribute('aria-busy', String(state.boot === 'loading' || busy));
    elements.app.dataset.itineraryVersion = state.itinerary?.version ?? '';
    elements.app.dataset.itineraryState = state.itinerary?.state || '';
    syncHash(state.activePanel, state.selectedSpotId);
}

function syncHash(panel, selectedSpotId) {
    const target = panel === 'spot' && selectedSpotId ? `#spot/${encodeURIComponent(selectedSpotId)}` : `#${panel}`;
    if (window.location.hash !== target) history.replaceState(null, '', target);
}

function panelFromHash() {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (hash === 'spot') return { panel: 'spot', spotId: null };
    if (hash.startsWith('spot/')) return { panel: 'spot', spotId: hash.slice(5) };
    const panel = ['home', 'plan', 'preview', 'touring', 'proposal', 'completed'].includes(hash) ? hash : 'home';
    return { panel };
}

function navigate(panel, patch = {}) {
    store.navigate(panel, patch);
}

function extentBoundary(extent) {
    if (!Array.isArray(extent) || extent.length !== 4) return { type: 'FeatureCollection', features: [] };
    const [west, south, east, north] = extent.map(Number);
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature', properties: { source: 'config-extent' },
            geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }
        }]
    };
}

function poisToGeoJson(pois) {
    return {
        type: 'FeatureCollection',
        features: pois.map(poi => {
            const lng = Number(poi.lng ?? poi.location?.lng);
            const lat = Number(poi.lat ?? poi.location?.lat);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
            return {
                type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: {
                    poiId: String(poi.id || poi._id), name: poi.poiName || poi.name || '',
                    category: poi.category || 'default', status: poi.status || 'approved'
                }
            };
        }).filter(Boolean)
    };
}

function resolveMapConfig(config) {
    const gis = config?.gis || {};
    const center = gis.center || config?.scenicCenter;
    const extent = gis.extent;
    return {
        mapUrl: gis.publicServices?.map,
        center,
        extent,
        zoom: 15,
        minZoom: 13,
        maxZoom: 20,
        crs: gis.crs || 'EPSG:4326',
        demo
    };
}

async function initMap() {
    elements.mapLoading.classList.remove('hidden');
    elements.mapFallback.classList.add('hidden');
    elements.mapStage.dataset.listOnly = 'false';
    store.set({ mapState: 'loading' }, 'map:loading');
    try {
        await mapFacade.init(elements.map, mapConfig);
        mapFacade.setBoundary(extentBoundary(mapConfig.extent));
        updateMap(store.getState());
        elements.mapLoading.classList.add('hidden');
        store.set({ mapState: 'online' }, 'map:online');
    } catch (error) {
        const code = error instanceof MapFacadeError ? error.code : 'MAP_SERVICE_UNAVAILABLE';
        elements.mapLoading.classList.add('hidden');
        elements.mapFallback.classList.remove('hidden');
        elements.mapStage.dataset.listOnly = 'true';
        setText(elements.mapFallbackMessage, `${error.message || '地图服务不可用'}（${code}），行程列表仍可操作。`);
        store.fail(error, { mapState: 'fallback' });
    }
}

function updateMap(state) {
    if (!mapFacade.map) return;
    mapFacade.setPois(poisToGeoJson(state.pois));
    mapFacade.setCrowd(state.heatmap);
    mapFacade.setClosedEdges(state.closedEdges);
    if (state.itinerary?.route) mapFacade.setRoute(state.itinerary.route, { fit: ['preview', 'touring'].includes(state.activePanel) });
    else mapFacade.setRoute(null, { fit: false });
    if (state.activePanel !== 'proposal') mapFacade.clearRouteComparison();
    mapFacade.setConnectionState(state.socketState);
}

async function refreshCurrent({ announceChange = false } = {}) {
    try {
        const itinerary = await api.getCurrentItinerary();
        store.replaceItinerary(itinerary);
        if (announceChange) announce('行程已与服务端同步');
        return itinerary;
    } catch (error) {
        store.fail(error, { apiState: error.status >= 500 ? 'offline' : 'online' });
        if (error.status !== 401) showToast(error.message);
        return null;
    }
}

async function refreshAfterReconnect() {
    const results = await Promise.allSettled([api.getClientConfig(), api.getCurrentItinerary(), api.getHeatmap()]);
    const patch = { socketState: 'connected' };
    if (results[0].status === 'fulfilled') patch.config = results[0].value;
    if (results[2].status === 'fulfilled') store.applyHeatmap(results[2].value);
    store.set(patch, 'socket:recovered');
    if (results[1].status === 'fulfilled') store.replaceItinerary(results[1].value);
    announce('实时连接已恢复，数据已同步');
}

function initSocket(config) {
    socketClient?.disconnect();
    socketClient = new SocketClient({ scenicId: config?.scenicId || 'default', demo });
    socketClient.addEventListener('state', event => store.set({ socketState: event.detail.state }, 'socket:state'));
    socketClient.addEventListener('joined', event => {
        store.set({ socketState: event.detail?.ok === false ? 'offline' : 'connected' }, 'socket:joined');
    });
    socketClient.addEventListener('reconnected', () => void refreshAfterReconnect());
    socketClient.addEventListener('crowd', event => store.applyCrowdUpdate(event.detail));
    socketClient.addEventListener('progress', event => {
        if (store.hasNewerVersion(event.detail?.version)) void refreshCurrent({ announceChange: true });
    });
    socketClient.addEventListener('proposal', event => void receiveProposal(event.detail));
    socketClient.addEventListener('graph', event => {
        const item = event.detail;
        const closedEdges = store.getState().closedEdges.filter(edge => String(edge.edgeId) !== String(item.edgeId));
        if (item.status === 'closed') closedEdges.push(item);
        store.set({ closedEdges }, 'graph:update');
        showToast(item.status === 'closed' ? '检测到临时封路，正在等待改道建议' : '道路已恢复开放');
    });
    socketClient.addEventListener('rain:incoming', event => store.set({ rain: event.detail }, 'rain:incoming'));
    socketClient.addEventListener('rain:cleared', () => store.set({ rain: null }, 'rain:cleared'));
    socketClient.connect();
}

async function receiveProposal(payload) {
    const current = await api.getCurrentItinerary().catch(() => null);
    if (!current) {
        showToast('收到路线调整通知，服务端状态暂未同步');
        return;
    }
    store.replaceItinerary(current);
    if (current.pendingProposal && proposalRemainingMs(current.pendingProposal.expireAt)) {
        announce('收到新的路线调整建议');
    } else if (payload?.proposalId || payload?.proposal?.proposalId) {
        showToast('路线调整通知已处理或已过期');
    }
}

function initLocation() {
    locationClient = new LocationClient({ upload: payload => api.reportPosition(payload) });
    locationClient.addEventListener('state', event => {
        store.set({ locationState: event.detail.state }, 'location:state');
        if (event.detail.state === 'denied') showToast('定位已拒绝，可继续使用列表和行程操作');
        if (event.detail.state === 'out-of-fence') showToast('已离开景区范围，位置上报已停止');
    });
    locationClient.addEventListener('location', event => {
        lastLocation = event.detail;
        mapFacade.setUserLocation(event.detail);
        if (event.detail.lowAccuracy) showToast('定位精度较低，地图不会自动移动到该点');
    });
}

async function submitPlan(event) {
    event.preventDefault();
    if (store.getState().busyAction) return;
    const form = new FormData(elements.planForm);
    const payload = {
        startLocation: lastLocation ? [lastLocation.lng, lastLocation.lat] : mapConfig.center,
        startAt: new Date().toISOString(),
        hours: Number(form.get('hours')),
        interests: form.getAll('interests'),
        pace: form.get('pace') || 'normal',
        accessible: form.has('accessible'),
        shadeFirst: form.has('shadeFirst')
    };
    store.set({ busyAction: 'plan', lastError: null }, 'plan:start');
    elements.planMessage.classList.add('hidden');
    const slowTimer = setTimeout(() => {
        setText(elements.planMessage, '仍在规划，请稍候…');
        elements.planMessage.classList.remove('hidden');
    }, 3000);
    try {
        const itinerary = await api.plan(payload);
        store.replaceItinerary(itinerary);
        announce('路线规划完成');
    } catch (error) {
        if (error.code === 1206) {
            const existing = await refreshCurrent();
            showToast(existing ? '已恢复未完成行程' : error.message);
        } else {
            const message = error.code === 8204 ? '没有已验证的无障碍路线，请关闭无障碍模式后主动重试' : error.message;
            setText(elements.planMessage, message);
            elements.planMessage.classList.remove('hidden');
            elements.planMessage.classList.toggle('error', true);
            store.fail(error);
        }
    } finally {
        clearTimeout(slowTimer);
        store.set({ busyAction: null }, 'plan:end');
    }
}

async function startTour() {
    const itinerary = store.getState().itinerary;
    if (!itinerary || store.getState().busyAction) return;
    store.set({ busyAction: 'start' }, 'tour:start');
    try {
        const updated = await api.start(itinerary.itineraryId, itinerary.version);
        store.replaceItinerary(updated);
        locationClient.start('tour');
        if (demo) {
            const proposal = demoProposal(updated.version);
            api.setProposal(proposal);
            socketClient.demoEvent('graph', demoClosedEdge(), 650);
            socketClient.demoProposal(proposal, 1500);
        }
    } catch (error) {
        await handleWriteError(error);
    } finally {
        store.set({ busyAction: null }, 'tour:start:end');
    }
}

async function itineraryAction(action) {
    const itinerary = store.getState().itinerary;
    if (!itinerary || store.getState().busyAction) return;
    store.set({ busyAction: action }, `itinerary:${action}:start`);
    try {
        const updated = await api[action](itinerary.itineraryId, itinerary.version);
        store.replaceItinerary(updated);
        if (action === 'finish') locationClient.stop();
    } catch (error) {
        await handleWriteError(error);
    } finally {
        store.set({ busyAction: null }, `itinerary:${action}:end`);
    }
}

async function skipCurrentStop() {
    const itinerary = store.getState().itinerary;
    const stop = itinerary?.stops?.find(item => String(item.stopId) === String(itinerary.currentStopId))
        || itinerary?.stops?.find(item => ['approaching', 'arrived', 'pending'].includes(item.state));
    if (!itinerary || !stop || store.getState().busyAction) return;
    store.set({ busyAction: 'skip' }, 'itinerary:skip:start');
    try {
        store.replaceItinerary(await api.skip(itinerary.itineraryId, stop.stopId, itinerary.version));
    } catch (error) {
        await handleWriteError(error);
    } finally {
        store.set({ busyAction: null }, 'itinerary:skip:end');
    }
}

async function decideProposal(decision) {
    const state = store.getState();
    const itinerary = state.itinerary;
    const proposal = state.pendingProposal;
    if (!itinerary || !proposal || state.busyAction) return;
    store.set({ busyAction: `proposal:${decision}` }, 'proposal:decision:start');
    try {
        const updated = await api.decideProposal(itinerary.itineraryId, proposal.proposalId, decision, itinerary.version);
        clearInterval(proposalTimer);
        proposalTimer = null;
        proposalTimerId = null;
        mapFacade.clearRouteComparison();
        store.replaceItinerary(updated);
        announce(decision === 'accept' ? '已接受新路线' : '已保留原路线');
    } catch (error) {
        await handleWriteError(error, { closeProposal: [1203, 1204, 1205].includes(error.code) });
    } finally {
        store.set({ busyAction: null }, 'proposal:decision:end');
    }
}

async function handleWriteError(error, { closeProposal = false } = {}) {
    if ([1203, 1204, 1205].includes(Number(error.code))) {
        if (closeProposal) store.set({ pendingProposal: null }, 'proposal:close');
        await refreshCurrent({ announceChange: true });
        showToast(Number(error.code) === 1203 ? '行程已在其他位置更新，已同步最新版本' : '路线建议已失效，已刷新行程');
    } else {
        store.fail(error);
        showToast(error.message);
    }
}

async function openPhotoSpots(spotId = null) {
    navigate('spot', { selectedSpotId: spotId });
    if (!store.getState().photoSpots.length) {
        try {
            const near = lastLocation ? [lastLocation.lng, lastLocation.lat] : null;
            const result = await api.getPhotoSpots({ near, radius: 5000, sort: 'score' });
            store.set({ photoSpots: result?.items || [] }, 'photospots');
        } catch (error) {
            store.fail(error);
            showToast(error.message);
        }
    }
    renderPhotoSpots();
    if (spotId) await selectPhotoSpot(spotId);
}

function renderPhotoSpots() {
    const spots = store.getState().photoSpots;
    const rows = spots.map(spot => {
        const row = document.createElement('li');
        row.className = 'spot-row';
        const main = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'row-title';
        setText(title, spot.name || '摄影机位');
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        const windowText = spot.todayWindows?.[0] ? `${spot.todayWindows[0].start}–${spot.todayWindows[0].end}` : '今日窗口待定';
        setText(meta, `${windowText} · ${spot.distanceM == null ? '景区内' : formatDistance(spot.distanceM)}`);
        main.append(title, meta);
        const button = document.createElement('button');
        button.className = 'btn btn-secondary';
        button.type = 'button';
        setText(button, '详情');
        button.addEventListener('click', () => void selectPhotoSpot(spot.spotId));
        row.append(main, button);
        return row;
    });
    if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        setText(empty, '暂无已审核摄影机位');
        rows.push(empty);
    }
    elements.spotList.replaceChildren(...rows);
    configureSceneButton();
}

async function selectPhotoSpot(spotId) {
    const spot = store.getState().photoSpots.find(item => String(item.spotId) === String(spotId));
    if (!spot) return;
    const selectedSpotId = String(spotId);
    store.set({ selectedSpotId }, 'photospot:selected');
    setText(elements.spotTitle, spot.name || '摄影机位');
    setText(elements.spotSubtitle, `朝向 ${spot.heading ?? '--'}° · 推荐指数 ${Number(spot.score || 0).toFixed(2)}`);
    elements.spotDetail.replaceChildren(createNotice('正在读取今日光线…'));
    if (spot.lnglat && mapFacade.map) mapFacade.fitToGeometry({ type: 'Point', coordinates: spot.lnglat });
    const [goldenResult, arResult] = await Promise.allSettled([api.getGoldenWindow(spotId), api.getArData(spotId)]);
    if (store.getState().selectedSpotId !== selectedSpotId) return;
    const golden = goldenResult.status === 'fulfilled' ? goldenResult.value : null;
    const ar = arResult.status === 'fulfilled' ? arResult.value : null;
    const parts = [];
    if (spot.coverPhoto) {
        const image = document.createElement('img');
        image.className = 'spot-cover';
        image.src = spot.coverPhoto;
        image.alt = `${spot.name} 样片`;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.remove(), { once: true });
        parts.push(image);
    }
    const windowText = golden?.windows?.length
        ? golden.windows.map(item => `${item.start}–${item.end}（${item.light || '推荐光线'}）`).join('，')
        : golden?.cloudy ? '天气条件不适合固定光位' : '今日无可用光位窗口';
    parts.push(createNotice(`今日窗口：${windowText}`));
    const heat = store.getState().heatmap.find(item => String(item.poiId) === String(spot.poiId));
    const ciNow = heat?.ci ?? ar?.ciNow ?? spot.ciNow;
    const crowdText = heat?.level
        ? crowdLabel(heat.level)
        : Number.isFinite(Number(ciNow))
            ? `客流指数 ${Number(ciNow).toFixed(2)}`
            : '数据准备中';
    parts.push(createNotice(`当前客流：${heat?.lowConfidence ? `参考人流 · ${crowdText}` : crowdText}`));
    parts.push(createNotice(ar?.fallbackCard?.text || `面朝 ${spot.heading ?? '--'}° 方向取景`));
    if (ar?.focalHint) parts.push(createNotice(`焦段建议：${ar.focalHint}`));
    elements.spotDetail.replaceChildren(...parts);
    renderPhotoSpots();
}

function createNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    setText(notice, text);
    return notice;
}

function configureSceneButton() {
    const config = store.getState().config;
    const sceneUrl = String(config?.gis?.publicServices?.scene || '').trim();
    const enabled = Boolean((config?.features?.threeD || config?.gis?.features?.threeD) && sceneUrl);
    elements.openScene.disabled = !enabled;
    elements.openScene.setAttribute('aria-disabled', String(!enabled));
    setText(elements.openScene, enabled ? '打开三维场景' : '三维场景不可用');
    elements.openScene.dataset.sceneUrl = enabled ? sceneUrl : '';
}

function bindUi() {
    mapFacade.addEventListener('poi:selected', event => {
        const poi = store.getState().pois.find(item => String(item.id || item._id) === String(event.detail.poiId));
        if (poi) selectPoi(poi);
    });
    mapFacade.addEventListener('route:compared', event => {
        announce(`路线差异：距离变化 ${Math.round(event.detail.distanceDeltaM)} 米`);
    });
    mapFacade.addEventListener('map:error', event => announce(`地图不可用：${event.detail.message}`));
    byId('open-plan').addEventListener('click', () => navigate('plan'));
    byId('open-spots').addEventListener('click', () => void openPhotoSpots());
    document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.back)));
    elements.hoursRange.addEventListener('input', () => setText(elements.hoursOutput, `${elements.hoursRange.value} 小时`));
    elements.planForm.addEventListener('submit', submitPlan);
    elements.startTour.addEventListener('click', () => void startTour());
    elements.pauseTour.addEventListener('click', () => void itineraryAction('pause'));
    elements.resumeTour.addEventListener('click', () => void itineraryAction('resume'));
    elements.finishTour.addEventListener('click', () => void itineraryAction('finish'));
    elements.skipStop.addEventListener('click', () => void skipCurrentStop());
    elements.acceptProposal.addEventListener('click', () => void decideProposal('accept'));
    elements.rejectProposal.addEventListener('click', () => void decideProposal('reject'));
    elements.returnHome.addEventListener('click', () => {
        store.replaceItinerary(null, { navigate: false });
        navigate('home');
    });
    elements.retryMap.addEventListener('click', () => void initMap());
    elements.openScene.addEventListener('click', () => {
        const raw = elements.openScene.dataset.sceneUrl;
        if (!raw) return;
        try {
            const url = new URL(raw, window.location.origin);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid scene URL');
            window.location.assign(url.href);
        } catch {
            showToast('三维场景地址无效');
        }
    });
    window.addEventListener('hashchange', () => {
        if (window.location.hash === '#active-panel') {
            elements.activePanel.focus();
            return;
        }
        const route = panelFromHash();
        if (route.panel === 'spot') void openPhotoSpots(route.spotId);
        else navigate(route.panel);
    });
}

async function boot() {
    bindUi();
    initLocation();
    const results = await Promise.allSettled([
        api.getClientConfig(), api.getPois(), api.getHeatmap(), api.getCurrentItinerary()
    ]);
    const config = results[0].status === 'fulfilled' ? results[0].value : null;
    if (!config) {
        const error = results[0].reason instanceof Error ? results[0].reason : new ApiError('启动配置不可用');
        store.fail(error, { boot: 'error', apiState: 'offline', mapState: 'fallback' });
        elements.mapLoading.classList.add('hidden');
        elements.mapFallback.classList.remove('hidden');
        elements.mapStage.dataset.listOnly = 'true';
        setText(elements.mapFallbackMessage, '启动配置不可用，请检查服务后重试。');
        showToast(error.message);
        return;
    }
    const pois = results[1].status === 'fulfilled' ? results[1].value || [] : [];
    const heatmap = results[2].status === 'fulfilled' ? results[2].value : { items: [] };
    const itinerary = results[3].status === 'fulfilled' ? results[3].value : null;
    store.set({ config, pois, boot: 'ready', apiState: 'online' }, 'boot');
    store.applyHeatmap(heatmap);
    store.replaceItinerary(itinerary, { navigate: false });
    const initialRoute = panelFromHash();
    const initialPanel = store.getState().pendingProposal ? 'proposal'
        : initialRoute.panel === 'home' && itinerary ? ({ draft: 'preview', active: 'touring', paused: 'touring', completed: 'completed' })[itinerary.state] || 'home'
            : initialRoute.panel;
    store.navigate(initialPanel, { selectedSpotId: initialRoute.spotId || null });
    mapConfig = resolveMapConfig(config);
    initSocket(config);
    await initMap();
    if (initialRoute.panel === 'spot') await openPhotoSpots(initialRoute.spotId);
    if (results[3].status === 'rejected' && results[3].reason?.status === 401) {
        showToast('当前未登录，可浏览景点；规划行程前请完成微信授权');
    }
}

store.addEventListener('change', event => {
    render(event.detail.state);
    updateMap(event.detail.state);
    if (event.detail.reason === 'photospots') renderPhotoSpots();
});

window.addEventListener('pagehide', () => {
    clearInterval(proposalTimer);
    clearTimeout(toastTimer);
    api.cancelAll?.();
    socketClient?.disconnect();
    locationClient?.destroy();
    mapFacade.destroy();
}, { once: true });

void boot();
