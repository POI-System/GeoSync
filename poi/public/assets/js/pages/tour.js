import { ApiClient, ApiError } from '../api/client.js';
import { DemoApiClient, demoClosedEdge, demoProposal } from '../api/demoClient.js';
import { LocationClient } from '../location/locationClient.js';
import { MapFacade, MapFacadeError } from '../map/mapFacade.js';
import { routePresentation } from '../map/styles.js';
import { SocketClient } from '../realtime/socketClient.js';
import {
    formatCrowdLevel,
    formatDistance,
    formatDuration,
    formatRouteMode
} from '../shared/formatters.js';
import { formatProposalCountdown, proposalRemainingMs } from '../state/proposalClock.js';
import { TourStore } from '../state/tourStore.js';

const params = new URLSearchParams(window.location.search);
const demo = params.get('demo') === '1';
const demoScenario = params.get('scenario') || '';
const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const legacyOpenId = localHost && params.get('legacyAuth') === '1' ? params.get('openid') || '' : '';
const api = demo
    ? new DemoApiClient({ scenario: demoScenario })
    : new ApiClient({ openId: legacyOpenId, allowLegacyOpenId: Boolean(legacyOpenId) });
const store = new TourStore();
const mapFacade = new MapFacade();
let socketClient = null;
let locationClient = null;
let lastLocation = null;
let proposalTimer = null;
let proposalTimerId = null;
let mapConfig = null;
let boundaryData = null;
let toastTimer = null;
let planRequestGeneration = 0;
let lastRouteKey = '';
let lastComparedProposalKey = '';
let unsubscribeStore = null;
let socketListenerCleanup = [];
let locationListenerCleanup = [];
let uiListenerCleanup = [];
let socketScenicId = null;
let pageDestroyed = false;
let bootStarted = false;
let lowAccuracyNoticeShown = false;
let poiDialogReturnFocus = null;

const byId = id => document.getElementById(id);
const elements = {
    app: byId('tour-app'),
    mockMode: byId('mock-mode'),
    activePanel: byId('active-panel'),
    mapStage: byId('map-stage'),
    map: byId('tour-map'),
    mapLoading: byId('map-loading'),
    mapFallback: byId('map-fallback'),
    mapFallbackMessage: byId('map-fallback-message'),
    retryMap: byId('retry-map'),
    rainBanner: byId('rain-banner'),
    roadBanner: byId('road-banner'),
    connectionBanner: byId('connection-banner'),
    crowdConfidence: byId('crowd-confidence'),
    mapStatusDot: byId('map-status-dot'),
    mapStatusText: byId('map-status-text'),
    mapStatusPill: byId('map-status-pill'),
    socketStatusDot: byId('socket-status-dot'),
    socketStatusText: byId('socket-status-text'),
    socketStatusPill: byId('socket-status-pill'),
    locationStatusDot: byId('location-status-dot'),
    locationStatusText: byId('location-status-text'),
    locationStatusPill: byId('location-status-pill'),
    scenicName: byId('scenic-name'),
    poiCount: byId('poi-count'),
    crowdUpdated: byId('crowd-updated'),
    activeState: byId('active-state'),
    poiList: byId('poi-list'),
    planForm: byId('plan-form'),
    hoursRange: byId('hours-range'),
    hoursOutput: byId('hours-output'),
    planMessage: byId('plan-message'),
    planStartSource: byId('plan-start-source'),
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
    completedBadges: byId('completed-badges'),
    completedTimeline: byId('completed-timeline'),
    returnHome: byId('return-home'),
    spotTitle: byId('spot-title'),
    spotSubtitle: byId('spot-subtitle'),
    spotDetail: byId('spot-detail'),
    spotList: byId('spot-list'),
    openScene: byId('open-scene'),
    poiDialog: byId('poi-dialog'),
    poiDialogTitle: byId('poi-dialog-title'),
    poiDialogMeta: byId('poi-dialog-meta'),
    poiDialogDescription: byId('poi-dialog-description'),
    poiDialogFacts: byId('poi-dialog-facts'),
    toast: byId('toast'),
    liveRegion: byId('live-region')
};

function listen(target, type, handler, options, bucket = uiListenerCleanup) {
    target.addEventListener(type, handler, options);
    bucket.push(() => target.removeEventListener(type, handler, options));
    return handler;
}

function clearListeners(bucket) {
    for (const cleanup of bucket.splice(0)) cleanup();
}

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
    const badges = [
        createBadge(formatRouteMode(presentation.mode), !presentation.accessibleVerified),
        createBadge(presentation.label, presentation.degraded)
    ];
    if (!presentation.accessibleVerified) badges.push(createBadge('未验证无障碍通行', true));
    container.replaceChildren(...badges);
}

function renderTimeline(container, itinerary) {
    const state = store.getState();
    const crowd = new Map(state.heatmap.map(item => [String(item.poiId), item]));
    const snapshotLowConfidence = Boolean(state.heatmapMeta?.lowConfidence);
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
        setText(meta, `${formatTime(stop.plannedArrive)}–${formatTime(stop.plannedLeave)} · ${state}${heat ? ` · ${formatCrowdLevel(heat.level, { lowConfidence: snapshotLowConfidence || heat.lowConfidence })}` : ''}`);
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
    const snapshotLowConfidence = Boolean(state.heatmapMeta?.lowConfidence);
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
        setText(meta, `${poi.category || '景点'} · ${crowd ? formatCrowdLevel(crowd.level, { lowConfidence: snapshotLowConfidence || crowd.lowConfidence }) : '人流数据准备中'}${crowd?.queueEstMin ? ` · 预计等待 ${crowd.queueEstMin} 分钟` : ''}`);
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
    poiDialogReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    const id = poi.id || poi._id || poi.poiId;
    store.set({ selectedPoiId: String(id) }, 'poi:selected');
    const lng = Number(poi.lng ?? poi.location?.lng);
    const lat = Number(poi.lat ?? poi.location?.lat);
    if (Number.isFinite(lng) && Number.isFinite(lat) && mapFacade.isReady()) {
        try {
            mapFacade.fitToGeometry({ type: 'Point', coordinates: [lng, lat] });
        } catch (error) {
            // The list and dialog remain usable if the map was destroyed concurrently.
            void error;
            announce('地图定位暂不可用，景点详情已打开');
        }
    }
    const state = store.getState();
    const crowd = state.heatmap.find(item => String(item.poiId) === String(id));
    const lowConfidence = Boolean(state.heatmapMeta?.lowConfidence || crowd?.lowConfidence);
    setText(elements.poiDialogTitle, poi.poiName || poi.name || '景点详情');
    setText(elements.poiDialogMeta, poi.category || '景点');
    setText(elements.poiDialogDescription, poi.description || '暂无详情');
    const facts = [
        ['开放状态', poi.status === 'closed' ? '暂时关闭' : poi.status === 'limited' ? '限流开放' : '正常开放'],
        ['当前客流', crowd ? formatCrowdLevel(crowd.level, { lowConfidence }) : '数据准备中'],
        ['预计等待', Number.isFinite(Number(crowd?.queueEstMin)) ? `${Math.max(0, Number(crowd.queueEstMin))} 分钟` : '服务端暂未提供'],
        ['建议停留', Number.isFinite(Number(poi.suggestedStayMin)) ? `${Math.max(0, Number(poi.suggestedStayMin))} 分钟` : '服务端暂未提供']
    ];
    elements.poiDialogFacts.replaceChildren(...facts.flatMap(([label, value]) => {
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        setText(term, label);
        setText(detail, value);
        return [term, detail];
    }));
    if (!elements.poiDialog.open) {
        if (typeof elements.poiDialog.showModal === 'function') elements.poiDialog.showModal();
        else elements.poiDialog.setAttribute('open', '');
        queueMicrotask(() => elements.poiDialog.querySelector('[aria-label="关闭景点详情"]')?.focus());
    }
}

function closePoiDialog() {
    if (!elements.poiDialog.hasAttribute('open') && !elements.poiDialog.open) return;
    if (typeof elements.poiDialog.close === 'function') {
        elements.poiDialog.close();
    } else {
        elements.poiDialog.removeAttribute('open');
        elements.poiDialog.dispatchEvent(new Event('close'));
    }
}

function stateLabel(itinerary) {
    return ({ draft: '待开始', active: '游览中', paused: '已暂停', completed: '已完成', abandoned: '已结束' })[itinerary?.state] || '未规划';
}

function renderItinerary(state) {
    const itinerary = state.itinerary;
    setText(elements.activeState, stateLabel(itinerary));
    if (!itinerary) {
        renderMetrics(elements.previewMetrics, [['--', '总步行'], ['--', '路线耗时'], ['0', '站点']]);
        renderMetrics(elements.tourMetrics, [['--', '总步行'], ['--', '路线耗时'], ['0', '站点']]);
        renderMetrics(elements.completedMetrics, [['0', '完成站点'], ['--', '总步行'], ['0 分钟', '累计节省']]);
        renderRouteBadges(elements.previewBadges, null);
        renderRouteBadges(elements.tourBadges, null);
        renderRouteBadges(elements.completedBadges, null);
        renderTimeline(elements.previewTimeline, null);
        renderTimeline(elements.tourTimeline, null);
        renderTimeline(elements.completedTimeline, null);
        return;
    }
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
    renderRouteBadges(elements.completedBadges, route);
    renderTimeline(elements.previewTimeline, itinerary);
    renderTimeline(elements.tourTimeline, itinerary);
    renderTimeline(elements.completedTimeline, itinerary);
    setText(elements.previewNote, itinerary.planNote || '路线已按当前服务状态生成');
    const current = itinerary.stops?.find(stop => String(stop.stopId) === String(itinerary.currentStopId))
        || itinerary.stops?.find(stop => ['approaching', 'arrived', 'pending'].includes(stop.state));
    const currentIndex = current ? itinerary.stops?.findIndex(stop => String(stop.stopId) === String(current.stopId)) : -1;
    const next = itinerary.stops?.slice(Math.max(0, currentIndex + 1))
        .find(stop => ['pending', 'approaching'].includes(stop.state));
    setText(elements.tourStateTitle, itinerary.state === 'paused' ? '游览已暂停' : '游览中');
    setText(elements.tourNext, current
        ? `当前站：${current.poiName || '当前景点'}${next ? ` · 下一站：${next.poiName || '下一景点'}` : ' · 已是最后一站'}`
        : '行程即将完成');
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
        lastComparedProposalKey = '';
        return;
    }
    setText(elements.proposalReason, proposal.reason || '路线条件发生变化');
    const rawDistanceDelta = proposal.distanceDeltaM ?? proposal.diff?.distanceDeltaM;
    const rawDurationDelta = proposal.durationDeltaSec ?? proposal.diff?.durationDeltaSec;
    const distanceDelta = Number(rawDistanceDelta);
    const durationDelta = Number(rawDurationDelta);
    const hasDistanceDelta = rawDistanceDelta !== null && rawDistanceDelta !== undefined && Number.isFinite(distanceDelta);
    const hasDurationDelta = rawDurationDelta !== null && rawDurationDelta !== undefined && Number.isFinite(durationDelta);
    const gainMin = Number(proposal.gainMin);
    const timeValue = hasDurationDelta
        ? `${durationDelta > 0 ? '+' : durationDelta < 0 ? '-' : ''}${formatDuration(Math.abs(durationDelta))}`
        : Number.isFinite(gainMin)
            ? `${Math.abs(gainMin)} 分钟`
            : '服务端暂未提供';
    const timeLabel = hasDurationDelta
        ? '路线时间变化'
        : Number.isFinite(gainMin) && gainMin >= 0 ? '预计节省' : '预计时间变化';
    renderMetrics(elements.proposalMetrics, [
        [timeValue, timeLabel],
        [hasDistanceDelta ? `${distanceDelta > 0 ? '+' : distanceDelta < 0 ? '-' : ''}${formatDistance(Math.abs(distanceDelta))}` : '服务端暂未提供', hasDistanceDelta && distanceDelta < 0 ? '减少步行' : '额外步行'],
        [formatTime(proposal.expireAt), '建议到期'],
        [proposal.diff?.after?.length ?? '服务端暂未提供', '调整后站点']
    ]);
    const beforeRoute = proposal.beforeRoute || state.itinerary?.route;
    const afterRoute = proposal.afterRoute || proposal.route || proposal.proposedRoute;
    const comparisonKey = `${proposal.proposalId || ''}:${state.itinerary?.version ?? ''}`;
    if (beforeRoute && afterRoute && mapFacade.isReady()) {
        try {
            if (lastComparedProposalKey !== comparisonKey) {
                mapFacade.compareRoutes(beforeRoute, { ...afterRoute, reason: afterRoute.reason || proposal.reason || '' });
                lastComparedProposalKey = comparisonKey;
            }
            elements.proposalCountdown.classList.remove('error');
        } catch {
            elements.proposalCountdown.classList.add('error');
        }
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
            store.markProposalHandled(proposal.proposalId, 'expired');
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
    elements.mapStatusPill.setAttribute('aria-label', `GIS：${mapText}`);
    elements.socketStatusPill.setAttribute('aria-label', `实时连接：${socketText}`);
    elements.locationStatusPill.setAttribute('aria-label', `定位：${locationText}`);
    elements.mapStatusPill.title = `GIS：${mapText}`;
    elements.socketStatusPill.title = `实时连接：${socketText}`;
    elements.locationStatusPill.title = `定位：${locationText}`;
    elements.connectionBanner.classList.toggle('hidden', !['reconnecting', 'offline'].includes(state.socketState));
    setText(elements.connectionBanner, state.socketState === 'offline'
        ? '实时连接已断开，正在通过低频同步保持行程可用'
        : '实时连接中断，正在恢复');
    elements.rainBanner.classList.toggle('hidden', !state.rain);
    setText(elements.rainBanner, state.rain?.text || '降雨提醒');
    const closedEdge = state.closedEdges.find(item => item.status === 'closed');
    elements.roadBanner.classList.toggle('hidden', !closedEdge);
    setText(elements.roadBanner, closedEdge
        ? `${closedEdge.reason || '检测到临时封路'}${closedEdge.geometry ? '' : '，路段位置暂未提供'}`
        : '');
}

function renderPanels(state) {
    document.querySelectorAll('[data-panel]').forEach(panel => {
        const active = panel.dataset.panel === state.activePanel;
        panel.classList.toggle('hidden', !active);
        if (active) panel.setAttribute('tabindex', '-1');
        else panel.removeAttribute('tabindex');
    });
}

function focusPanel(panelName) {
    queueMicrotask(() => {
        const panel = Array.from(document.querySelectorAll('[data-panel]'))
            .find(candidate => candidate.dataset.panel === panelName);
        if (!panel || panel.classList.contains('hidden')) return;
        panel.focus({ preventScroll: true });
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
    elements.mockMode.classList.toggle('hidden', !demo);
    setText(elements.planStartSource, lastLocation && !lastLocation.lowAccuracy
        ? `起点：当前位置（精度约 ${Math.round(Number(lastLocation.accuracy) || 0)} 米）`
        : lastLocation?.lowAccuracy
            ? '起点：景区入口；当前定位精度不足 100 米要求'
            : '起点：景区入口；定位将在开始游览后申请');
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
    const currentPanel = store.getState().activePanel;
    if (currentPanel === 'plan' && panel !== 'plan') {
        planRequestGeneration += 1;
        api.cancel?.('plan');
        elements.planMessage.classList.add('hidden');
        if (store.getState().busyAction === 'plan') store.set({ busyAction: null }, 'plan:cancelled');
    }
    if (currentPanel === 'spot' && panel !== 'spot') {
        api.cancel?.('photospots');
        api.cancel?.(`golden:${store.getState().selectedSpotId || ''}`);
        api.cancel?.(`ar:${store.getState().selectedSpotId || ''}`);
    }
    store.navigate(panel, patch);
    focusPanel(panel);
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

function normalizePois(value) {
    if (Array.isArray(value)) return value;
    if (value?.type !== 'FeatureCollection') return [];
    return value.features.map(feature => {
        const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : [];
        return {
            ...(feature?.properties || {}),
            poiId: feature?.properties?.poiId,
            id: feature?.properties?.poiId,
            poiName: feature?.properties?.name || feature?.properties?.poiName || '',
            lng: Number(coordinates[0]),
            lat: Number(coordinates[1])
        };
    }).filter(poi => poi.poiId && Number.isFinite(poi.lng) && Number.isFinite(poi.lat));
}

function poisToGeoJson(pois) {
    return {
        type: 'FeatureCollection',
        features: pois.map(poi => {
            const lng = Number(poi.lng ?? poi.location?.lng);
            const lat = Number(poi.lat ?? poi.location?.lat);
            const poiId = poi.poiId ?? poi.id ?? poi._id;
            if (!Number.isFinite(lng) || !Number.isFinite(lat) || poiId == null) return null;
            return {
                type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: {
                    poiId: String(poiId), name: poi.poiName || poi.name || '',
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

function enterMapFallback(error) {
    const code = error?.code || 'MAP_SERVICE_UNAVAILABLE';
    elements.mapLoading.classList.add('hidden');
    elements.mapFallback.classList.remove('hidden');
    elements.mapStage.dataset.listOnly = 'true';
    setText(elements.mapFallbackMessage, `${error?.message || '地图服务不可用'}（${code}），规划、时刻表和行程操作仍可使用。`);
    if (mapFacade.isReady()) mapFacade.destroy();
    store.fail(error || new MapFacadeError(code, '地图服务不可用'), { mapState: 'fallback' });
}

async function initMap() {
    if (!mapConfig) {
        enterMapFallback(new MapFacadeError('MAP_CONFIG_INVALID', '启动配置中缺少公开地图信息'));
        return false;
    }
    elements.mapLoading.classList.remove('hidden');
    elements.mapFallback.classList.add('hidden');
    elements.mapStage.dataset.listOnly = 'false';
    store.set({ mapState: 'loading' }, 'map:loading');
    try {
        await mapFacade.init(elements.map, mapConfig);
        try {
            mapFacade.setBoundary(boundaryData || extentBoundary(mapConfig.extent));
        } catch (error) {
            mapFacade.setBoundary(extentBoundary(mapConfig.extent));
            void error;
            announce('景区边界数据不可用，已显示配置范围');
        }
        updateMap(store.getState(), 'map:init', null, { force: true });
        if (lastLocation) mapFacade.setUserLocation(lastLocation);
        elements.mapLoading.classList.add('hidden');
        store.set({ mapState: 'online' }, 'map:online');
        return true;
    } catch (error) {
        enterMapFallback(error instanceof MapFacadeError
            ? error
            : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '景区地图服务不可用', error));
        return false;
    }
}

function updateMap(state, reason = 'state', previous = null, { force = false } = {}) {
    if (!mapFacade.isReady()) return;
    try {
        if (force || state.pois !== previous?.pois) {
            mapFacade.setPois(poisToGeoJson(state.pois));
        }
        if (force || state.heatmap !== previous?.heatmap || state.heatmapMeta !== previous?.heatmapMeta) {
            mapFacade.setCrowd({
                items: state.heatmap,
                lowConfidence: Boolean(state.heatmapMeta?.lowConfidence),
                slot: state.heatmapMeta?.slot || null
            });
        }
        if (force || state.closedEdges !== previous?.closedEdges) {
            mapFacade.setClosedEdges(state.closedEdges);
        }

        const routeKey = state.itinerary
            ? `${state.itinerary.itineraryId}:${state.itinerary.version}`
            : 'none';
        const itineraryChanged = routeKey !== lastRouteKey;
        const panelEnteredRoute = previous?.activePanel !== state.activePanel
            && ['preview', 'touring', 'completed'].includes(state.activePanel);
        if (force || itineraryChanged || panelEnteredRoute) {
            mapFacade.setRoute(state.itinerary?.route || null, {
                fit: Boolean(state.itinerary?.route) && (itineraryChanged || panelEnteredRoute)
                    && ['preview', 'touring'].includes(state.activePanel)
            });
            lastRouteKey = routeKey;
        }
        if (state.activePanel !== 'proposal' && (force || lastComparedProposalKey)) {
            mapFacade.clearRouteComparison();
            lastComparedProposalKey = '';
        }
        if (force || state.socketState !== previous?.socketState) {
            mapFacade.setConnectionState(state.socketState);
        }
    } catch (error) {
        enterMapFallback(error instanceof MapFacadeError
            ? error
            : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '地图数据无法显示', error));
    }
}

async function refreshCurrent({ announceChange = false, navigate = true } = {}) {
    try {
        const itinerary = await api.getCurrentItinerary();
        const local = store.getState().itinerary;
        const preserveTerminal = itinerary === null && ['completed', 'abandoned'].includes(local?.state);
        if (!preserveTerminal) store.replaceItinerary(itinerary, { navigate });
        if (announceChange) announce('行程已与服务端同步');
        return preserveTerminal ? local : itinerary;
    } catch (error) {
        store.fail(error, { apiState: error.httpStatus >= 500 || error.category === 'network' ? 'offline' : 'online' });
        if (error.httpStatus !== 401) showToast(error.message);
        return null;
    }
}

function mapConfigSignature(value) {
    return JSON.stringify([value?.mapUrl || '', value?.center || null, value?.extent || null, value?.crs || '']);
}

async function synchronizeSnapshot({ setConnected = false, announceChange = false } = {}) {
    const results = await Promise.allSettled([api.getClientConfig(), api.getCurrentItinerary(), api.getHeatmap()]);
    const oldMapSignature = mapConfigSignature(mapConfig);
    const oldScenicId = socketScenicId;
    const patch = { apiState: results.some(result => result.status === 'fulfilled') ? 'online' : 'offline' };
    if (setConnected) patch.socketState = 'connected';
    if (results[0].status === 'fulfilled') {
        patch.config = results[0].value;
        mapConfig = resolveMapConfig(results[0].value);
    }
    if (results[2].status === 'fulfilled') store.applyHeatmap(results[2].value);
    store.set(patch, setConnected ? 'socket:recovered' : 'socket:poll');
    if (results[1].status === 'fulfilled') {
        const incoming = results[1].value;
        const shouldNavigate = Boolean(incoming?.pendingProposal);
        const local = store.getState().itinerary;
        if (!(incoming === null && ['completed', 'abandoned'].includes(local?.state))) {
            store.replaceItinerary(incoming, { navigate: shouldNavigate });
        }
    }
    const refreshedConfig = results[0].status === 'fulfilled' ? results[0].value : null;
    if (refreshedConfig && (!socketClient || oldScenicId !== String(refreshedConfig.scenicId || 'default'))) {
        initSocket(refreshedConfig);
    }
    const newMapSignature = mapConfigSignature(mapConfig);
    if (mapConfig && (oldMapSignature !== newMapSignature || store.getState().mapState === 'fallback')) {
        await initMap();
    }
    if (announceChange) announce('实时连接已恢复，配置、行程和客流已同步');
    return results;
}

async function refreshAfterReconnect() {
    return synchronizeSnapshot({ setConnected: true, announceChange: true });
}

function initSocket(config) {
    clearListeners(socketListenerCleanup);
    socketClient?.destroy();
    socketScenicId = String(config?.scenicId || 'default');
    socketClient = new SocketClient({
        scenicId: socketScenicId,
        openId: legacyOpenId,
        demo,
        poll: demo ? null : () => synchronizeSnapshot({ setConnected: false, announceChange: false }),
        pollIntervalMs: 30000
    });
    listen(socketClient, 'state', event => store.set({ socketState: event.detail.state }, 'socket:state'), undefined, socketListenerCleanup);
    listen(socketClient, 'joined', event => {
        store.set({ socketState: event.detail?.ok === false ? 'offline' : 'connected' }, 'socket:joined');
    }, undefined, socketListenerCleanup);
    listen(socketClient, 'reconnected', () => void refreshAfterReconnect(), undefined, socketListenerCleanup);
    listen(socketClient, 'polled', () => store.set({ apiState: 'online' }, 'socket:poll:ok'), undefined, socketListenerCleanup);
    listen(socketClient, 'poll:error', () => store.set({ apiState: 'offline' }, 'socket:poll:error'), undefined, socketListenerCleanup);
    listen(socketClient, 'crowd', event => store.applyCrowdUpdate(event.detail), undefined, socketListenerCleanup);
    listen(socketClient, 'progress', event => {
        if (store.hasNewerVersion(event.detail?.version)) void refreshCurrent({ announceChange: true });
    }, undefined, socketListenerCleanup);
    listen(socketClient, 'proposal', event => void receiveProposal(event.detail), undefined, socketListenerCleanup);
    listen(socketClient, 'graph', event => {
        const item = event.detail;
        const closedEdges = store.getState().closedEdges.filter(edge => String(edge.edgeId) !== String(item.edgeId));
        if (item.status === 'closed') closedEdges.push(item);
        store.set({ closedEdges }, 'graph:update');
        showToast(item.status === 'closed' ? '检测到临时封路，正在等待改道建议' : '道路已恢复开放');
    }, undefined, socketListenerCleanup);
    listen(socketClient, 'rain:incoming', event => store.set({ rain: event.detail }, 'rain:incoming'), undefined, socketListenerCleanup);
    listen(socketClient, 'rain:cleared', () => store.set({ rain: null }, 'rain:cleared'), undefined, socketListenerCleanup);
    socketClient.connect();
}

async function receiveProposal(payload) {
    const notifiedProposalId = String(payload?.proposalId || payload?.proposal?.proposalId || '');
    if (notifiedProposalId && store.getState().handledProposalIds.includes(notifiedProposalId)) return;
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
    clearListeners(locationListenerCleanup);
    locationClient?.destroy();
    locationClient = new LocationClient({ upload: payload => api.reportPosition(payload) });
    listen(locationClient, 'state', event => {
        store.set({ locationState: event.detail.state }, 'location:state');
        if (event.detail.state === 'denied') showToast('定位已拒绝，可继续使用列表和行程操作');
        if (event.detail.state === 'out-of-fence') showToast('已离开景区范围，位置上报已停止');
        if (event.detail.state === 'low-accuracy' && event.detail.code === 2103) {
            showToast('定位精度过低，本次位置未被服务端接受');
        }
    }, undefined, locationListenerCleanup);
    listen(locationClient, 'location', event => {
        lastLocation = event.detail;
        if (mapFacade.isReady()) mapFacade.setUserLocation(event.detail);
        if (event.detail.lowAccuracy && !lowAccuracyNoticeShown) {
            lowAccuracyNoticeShown = true;
            showToast('定位精度较低，将继续使用景区入口作为规划起点');
        } else if (!event.detail.lowAccuracy) {
            lowAccuracyNoticeShown = false;
        }
    }, undefined, locationListenerCleanup);
    listen(locationClient, 'upload:error', () => {
        showToast('位置同步暂时失败，不影响行程操作');
    }, undefined, locationListenerCleanup);
}

async function submitPlan(event) {
    event.preventDefault();
    if (store.getState().busyAction) return;
    const form = new FormData(elements.planForm);
    const currentStart = lastLocation && !lastLocation.lowAccuracy
        ? [lastLocation.lng, lastLocation.lat]
        : mapConfig?.center;
    const payload = {
        startAt: new Date().toISOString(),
        hours: Number(form.get('hours')),
        interests: form.getAll('interests'),
        pace: form.get('pace') || 'normal',
        accessible: form.has('accessible'),
        shadeFirst: form.has('shadeFirst')
    };
    if (Array.isArray(currentStart)) payload.startLocation = currentStart;
    const requestGeneration = ++planRequestGeneration;
    store.set({ busyAction: 'plan', lastError: null }, 'plan:start');
    elements.planMessage.classList.add('hidden');
    const slowTimer = setTimeout(() => {
        setText(elements.planMessage, '仍在规划，请稍候…');
        elements.planMessage.classList.remove('hidden');
    }, 3000);
    try {
        const itinerary = await api.planItinerary(payload);
        if (requestGeneration !== planRequestGeneration || store.getState().activePanel !== 'plan') return;
        store.replaceItinerary(itinerary);
        announce('路线规划完成');
    } catch (error) {
        if (requestGeneration !== planRequestGeneration || error.category === 'cancelled') return;
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
        if (requestGeneration === planRequestGeneration && store.getState().busyAction === 'plan') {
            store.set({ busyAction: null }, 'plan:end');
        }
    }
}

async function startTour() {
    const itinerary = store.getState().itinerary;
    if (!itinerary || store.getState().busyAction) return;
    store.set({ busyAction: 'start' }, 'tour:start');
    try {
        const updated = await api.startItinerary(itinerary.itineraryId, itinerary.version);
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
        const method = ({
            pause: 'pauseItinerary',
            resume: 'resumeItinerary',
            finish: 'endItinerary'
        })[action];
        if (!method || typeof api[method] !== 'function') throw new ApiError('不支持的行程操作');
        const updated = await api[method](itinerary.itineraryId, itinerary.version);
        store.replaceItinerary(updated);
        if (action === 'finish') {
            locationClient.stop();
            clearInterval(proposalTimer);
            proposalTimer = null;
            proposalTimerId = null;
        }
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
        store.replaceItinerary(await api.skipStop(itinerary.itineraryId, stop.stopId, itinerary.version));
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
        const method = decision === 'accept' ? 'acceptProposal' : 'rejectProposal';
        const updated = await api[method](itinerary.itineraryId, proposal.proposalId, itinerary.version);
        clearInterval(proposalTimer);
        proposalTimer = null;
        proposalTimerId = null;
        if (mapFacade.isReady()) mapFacade.clearRouteComparison();
        store.markProposalHandled(proposal.proposalId, decision === 'accept' ? 'accepted' : 'rejected');
        store.replaceItinerary(updated);
        announce(decision === 'accept' ? '已接受新路线' : '已保留原路线');
    } catch (error) {
        await handleWriteError(error, {
            closeProposal: [1203, 1204, 1205].includes(Number(error.code)),
            proposalId: proposal.proposalId
        });
    } finally {
        store.set({ busyAction: null }, 'proposal:decision:end');
    }
}

async function handleWriteError(error, { closeProposal = false, proposalId = null } = {}) {
    if ([1203, 1204, 1205].includes(Number(error.code))) {
        if (closeProposal) store.markProposalHandled(proposalId, Number(error.code) === 1203 ? 'conflict' : 'expired');
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
    if (spot.lnglat && mapFacade.isReady()) mapFacade.fitToGeometry({ type: 'Point', coordinates: spot.lnglat });
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
    const lowConfidence = Boolean(store.getState().heatmapMeta?.lowConfidence || heat?.lowConfidence);
    const crowdText = heat?.level
        ? formatCrowdLevel(heat.level, { lowConfidence })
        : Number.isFinite(Number(ciNow))
            ? `客流指数 ${Number(ciNow).toFixed(2)}`
            : '数据准备中';
    parts.push(createNotice(`当前客流：${crowdText}`));
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

async function retryMapOrConfig() {
    if (mapConfig) {
        await initMap();
        return;
    }
    const results = await synchronizeSnapshot({ setConnected: false, announceChange: false });
    if (results[0].status === 'rejected') {
        const error = results[0].reason;
        enterMapFallback(error instanceof Error
            ? error
            : new MapFacadeError('MAP_CONFIG_INVALID', '启动配置仍不可用'));
        showToast(error?.message || '启动配置仍不可用');
    }
}

function bindUi() {
    listen(mapFacade, 'poi:selected', event => {
        const poi = store.getState().pois.find(item => String(item.poiId ?? item.id ?? item._id) === String(event.detail.poiId));
        if (poi) selectPoi(poi);
    });
    listen(mapFacade, 'route:compared', event => {
        const distance = Number(event.detail.distanceDeltaM);
        announce(Number.isFinite(distance)
            ? `路线差异：距离变化 ${Math.round(distance)} 米`
            : '新旧路线已显示');
    });
    listen(mapFacade, 'map:error', event => {
        announce(`地图不可用：${event.detail.message}`);
        if (store.getState().mapState === 'online') {
            enterMapFallback(new MapFacadeError(event.detail.code, event.detail.message));
        }
    });
    listen(byId('open-plan'), 'click', () => navigate('plan'));
    listen(byId('open-spots'), 'click', () => void openPhotoSpots());
    document.querySelectorAll('[data-back]').forEach(button => listen(button, 'click', () => navigate(button.dataset.back)));
    listen(elements.hoursRange, 'input', () => setText(elements.hoursOutput, `${elements.hoursRange.value} 小时`));
    listen(elements.planForm, 'submit', submitPlan);
    listen(elements.startTour, 'click', () => void startTour());
    listen(elements.pauseTour, 'click', () => void itineraryAction('pause'));
    listen(elements.resumeTour, 'click', () => void itineraryAction('resume'));
    listen(elements.finishTour, 'click', () => void itineraryAction('finish'));
    listen(elements.skipStop, 'click', () => void skipCurrentStop());
    listen(elements.acceptProposal, 'click', () => void decideProposal('accept'));
    listen(elements.rejectProposal, 'click', () => void decideProposal('reject'));
    listen(elements.returnHome, 'click', () => {
        store.replaceItinerary(null, { navigate: false });
        navigate('home');
    });
    listen(elements.retryMap, 'click', () => void retryMapOrConfig());
    listen(elements.openScene, 'click', () => {
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
    listen(elements.poiDialog, 'click', event => {
        if (event.target === elements.poiDialog) closePoiDialog();
    });
    listen(elements.poiDialog.querySelector('form'), 'submit', event => {
        if (typeof elements.poiDialog.close !== 'function') {
            event.preventDefault();
            closePoiDialog();
        }
    });
    listen(elements.poiDialog, 'close', () => {
        store.set({ selectedPoiId: null }, 'poi:closed');
        const target = poiDialogReturnFocus?.isConnected ? poiDialogReturnFocus : elements.activePanel;
        poiDialogReturnFocus = null;
        queueMicrotask(() => target?.focus({ preventScroll: true }));
    });
    listen(window, 'hashchange', () => {
        if (window.location.hash === '#active-panel') {
            elements.activePanel.focus();
            return;
        }
        const route = panelFromHash();
        if (route.panel === 'spot') void openPhotoSpots(route.spotId);
        else navigate(route.panel);
    });
    listen(window, 'keydown', event => {
        if (event.key !== 'Escape') return;
        if (elements.poiDialog.hasAttribute('open') || elements.poiDialog.open) {
            if (typeof elements.poiDialog.close !== 'function') {
                event.preventDefault();
                closePoiDialog();
            }
            return;
        }
        const panel = store.getState().activePanel;
        const back = ({ plan: 'home', preview: 'plan', spot: 'home', completed: 'home' })[panel];
        if (!back) return;
        event.preventDefault();
        navigate(back);
    });
}

async function boot() {
    if (bootStarted) return;
    bootStarted = true;
    bindUi();
    initLocation();
    unsubscribeStore = store.subscribe((state, detail) => {
        if (pageDestroyed) return;
        render(state);
        updateMap(state, detail.reason, detail.previous);
        if (detail.reason === 'photospots') renderPhotoSpots();
        if (detail.previous?.activePanel !== state.activePanel) focusPanel(state.activePanel);
        const wasRunning = ['active', 'paused'].includes(detail.previous?.itinerary?.state);
        const isRunning = ['active', 'paused'].includes(state.itinerary?.state);
        if (wasRunning && !isRunning) locationClient?.stop();
    }, { emitCurrent: true });

    const results = await Promise.allSettled([
        api.getClientConfig(), api.getPois(), api.getHeatmap(), api.getCurrentItinerary(),
        typeof api.getBoundary === 'function' ? api.getBoundary() : Promise.resolve(null)
    ]);
    if (pageDestroyed) return;
    const config = results[0].status === 'fulfilled' ? results[0].value : null;
    const pois = results[1].status === 'fulfilled' ? normalizePois(results[1].value) : [];
    const heatmap = results[2].status === 'fulfilled' ? results[2].value : { items: [] };
    const itinerary = results[3].status === 'fulfilled' ? results[3].value : null;
    boundaryData = results[4].status === 'fulfilled' ? results[4].value : null;
    const anyApiAvailable = results.slice(0, 4).some(result => result.status === 'fulfilled');
    store.set({ config, pois, boot: 'ready', apiState: anyApiAvailable ? 'online' : 'offline' }, 'boot');
    store.applyHeatmap(heatmap);
    try {
        store.replaceItinerary(itinerary, { navigate: false });
    } catch (error) {
        store.fail(error);
    }
    const initialRoute = panelFromHash();
    const restoredItinerary = store.getState().itinerary;
    const itineraryPanel = ({ draft: 'preview', active: 'touring', paused: 'touring', completed: 'completed', abandoned: 'completed' })[restoredItinerary?.state];
    const requiresItinerary = ['preview', 'touring', 'proposal', 'completed'].includes(initialRoute.panel);
    const initialPanel = store.getState().pendingProposal ? 'proposal'
        : initialRoute.panel === 'home' && itineraryPanel ? itineraryPanel
            : requiresItinerary && !restoredItinerary ? 'home'
                : initialRoute.panel;
    store.navigate(initialPanel, { selectedSpotId: initialRoute.spotId || null });
    initSocket(config);
    if (config) {
        mapConfig = resolveMapConfig(config);
        await initMap();
    } else {
        const configError = results[0].reason instanceof Error
            ? results[0].reason
            : new ApiError('启动配置不可用');
        enterMapFallback(new MapFacadeError('MAP_CONFIG_INVALID', '启动配置不可用'));
        store.fail(configError, { boot: 'ready', apiState: anyApiAvailable ? 'online' : 'offline' });
        showToast(`${configError.message}；景点列表和行程操作仍可使用`);
    }
    if (['active', 'paused'].includes(restoredItinerary?.state)) locationClient.start('tour');
    if (initialRoute.panel === 'spot') await openPhotoSpots(initialRoute.spotId);
    if (results[3].status === 'rejected' && Number(results[3].reason?.httpStatus ?? results[3].reason?.status) === 401) {
        showToast('当前未登录，可浏览景点；规划行程前请完成微信授权');
    }
}

function destroyPage() {
    if (pageDestroyed) return;
    pageDestroyed = true;
    planRequestGeneration += 1;
    clearInterval(proposalTimer);
    proposalTimer = null;
    proposalTimerId = null;
    clearTimeout(toastTimer);
    toastTimer = null;
    clearListeners(uiListenerCleanup);
    clearListeners(socketListenerCleanup);
    clearListeners(locationListenerCleanup);
    unsubscribeStore?.();
    unsubscribeStore = null;
    api.cancelAll?.();
    api.destroy?.();
    socketClient?.destroy();
    socketClient = null;
    socketScenicId = null;
    locationClient?.destroy();
    locationClient = null;
    mapFacade.destroy();
    if (elements.poiDialog?.open || elements.poiDialog?.hasAttribute('open')) closePoiDialog();
}

window.addEventListener('pagehide', destroyPage);
window.addEventListener('pageshow', event => {
    if (event.persisted && pageDestroyed) window.location.reload();
});

void boot().catch(error => {
    if (pageDestroyed) return;
    const failure = error instanceof Error ? error : new ApiError('游客端初始化失败');
    store.fail(failure, { boot: 'error', apiState: 'offline' });
    enterMapFallback(new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '游客端初始化失败', failure));
    showToast(failure.message);
});
