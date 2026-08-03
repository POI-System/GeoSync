export const INITIAL_STATE = Object.freeze({
    boot: 'loading',
    config: null,
    mapState: 'loading',
    apiState: 'online',
    socketState: 'connecting',
    locationState: 'idle',
    openId: null,
    heatmap: [],
    pois: [],
    photoSpots: [],
    itinerary: null,
    pendingProposal: null,
    selectedPoiId: null,
    selectedSpotId: null,
    activePanel: 'home',
    rain: null,
    closedEdges: [],
    busyAction: null,
    lastError: null
});

function currentProposal(itinerary, now = Date.now()) {
    const proposal = itinerary?.pendingProposal;
    if (!proposal) return null;
    const expiresAt = new Date(proposal.expireAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= now ? null : proposal;
}

function panelForItinerary(itinerary) {
    if (!itinerary) return 'home';
    if (currentProposal(itinerary)) return 'proposal';
    if (itinerary.state === 'draft') return 'preview';
    if (['active', 'paused'].includes(itinerary.state)) return 'touring';
    if (['completed', 'abandoned'].includes(itinerary.state)) return 'completed';
    return 'home';
}

export class TourStore extends EventTarget {
    constructor(initial = {}) {
        super();
        this.state = { ...INITIAL_STATE, ...initial };
    }

    getState() {
        return this.state;
    }

    set(patch, reason = 'state') {
        const previous = this.state;
        this.state = { ...previous, ...patch };
        this.dispatchEvent(new CustomEvent('change', { detail: { state: this.state, previous, reason } }));
        return this.state;
    }

    replaceItinerary(itinerary, { navigate = true } = {}) {
        const pendingProposal = currentProposal(itinerary);
        return this.set({
            itinerary: itinerary || null,
            pendingProposal,
            ...(navigate ? { activePanel: panelForItinerary(itinerary) } : {}),
            lastError: null
        }, 'itinerary:replace');
    }

    applyHeatmap(snapshot) {
        const items = Array.isArray(snapshot) ? snapshot : snapshot?.items || [];
        return this.set({ heatmap: items, heatmapMeta: Array.isArray(snapshot) ? null : snapshot }, 'heatmap');
    }

    applyCrowdUpdate(update) {
        if (!update?.poiId) return this.state;
        const items = [...this.state.heatmap];
        const index = items.findIndex(item => String(item.poiId) === String(update.poiId));
        if (index >= 0) items[index] = { ...items[index], ...update };
        else items.push(update);
        return this.set({ heatmap: items }, 'crowd:update');
    }

    hasNewerVersion(version) {
        return Number.isFinite(Number(version))
            && Number(version) > Number(this.state.itinerary?.version ?? -1);
    }

    navigate(panel, patch = {}) {
        return this.set({ activePanel: panel, ...patch }, 'navigate');
    }

    fail(error, patch = {}) {
        return this.set({
            lastError: {
                code: Number(error?.code) || 0,
                status: Number(error?.status) || 0,
                message: error?.message || '操作失败',
                retryable: Boolean(error?.retryable)
            },
            ...patch
        }, 'error');
    }
}

export { currentProposal, panelForItinerary };
