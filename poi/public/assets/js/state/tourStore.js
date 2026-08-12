export const TOUR_ACTIONS = Object.freeze({
    STATE_PATCHED: 'STATE_PATCHED',
    ITINERARY_REPLACED: 'ITINERARY_REPLACED',
    HEATMAP_REPLACED: 'HEATMAP_REPLACED',
    CROWD_ITEM_UPDATED: 'CROWD_ITEM_UPDATED',
    PANEL_CHANGED: 'PANEL_CHANGED',
    ERROR_SET: 'ERROR_SET',
    PROPOSAL_HANDLED: 'PROPOSAL_HANDLED',
    PROPOSAL_CLEARED: 'PROPOSAL_CLEARED'
});

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
    proposalStatus: null,
    handledProposalIds: [],
    lastHandledProposalId: null,
    selectedPoiId: null,
    selectedSpotId: null,
    activePanel: 'home',
    rain: null,
    closedEdges: [],
    busyAction: null,
    lastError: null
});

export const HANDLED_PROPOSALS_STORAGE_KEY = 'geosync:tour:handled-proposals:v1';

function readHandledProposals(storage, key) {
    try {
        const parsed = JSON.parse(storage?.getItem(key) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.slice(-32).flatMap(item => {
            const id = typeof item === 'string' ? item : item?.id;
            if (id == null || !String(id).trim()) return [];
            return [[String(id), typeof item === 'string' ? 'handled' : String(item.status || 'handled')]];
        });
    } catch (error) {
        void error;
        return [];
    }
}

function proposalId(proposal) {
    const id = proposal?.proposalId;
    return id == null || String(id).trim() === '' ? null : String(id);
}

function proposalExpired(proposal, now = Date.now()) {
    const expiresAt = new Date(proposal?.expireAt).getTime();
    return !Number.isFinite(expiresAt) || expiresAt <= Number(now);
}

function currentProposal(itinerary, now = Date.now(), handledProposalIds = []) {
    const proposal = itinerary?.pendingProposal;
    const id = proposalId(proposal);
    if (!proposal || !id || proposalExpired(proposal, now)) return null;
    const handled = handledProposalIds instanceof Set
        ? handledProposalIds
        : new Set(Array.from(handledProposalIds || [], String));
    return handled.has(id) ? null : proposal;
}

function panelForItinerary(itinerary, { now = Date.now(), handledProposalIds = [] } = {}) {
    if (!itinerary) return 'home';
    if (currentProposal(itinerary, now, handledProposalIds)) return 'proposal';
    if (itinerary.state === 'draft') return 'preview';
    if (['active', 'paused'].includes(itinerary.state)) return 'touring';
    if (['completed', 'abandoned'].includes(itinerary.state)) return 'completed';
    return 'home';
}

function isCompleteItinerary(itinerary) {
    return Boolean(
        itinerary
        && typeof itinerary === 'object'
        && !Array.isArray(itinerary)
        && String(itinerary.itineraryId || '').trim()
        && Number.isFinite(Number(itinerary.version))
        && String(itinerary.state || '').trim()
        && Array.isArray(itinerary.stops)
        && Object.prototype.hasOwnProperty.call(itinerary, 'route')
    );
}

function itineraryVersion(itinerary) {
    return Number(itinerary?.version);
}

function normalizedErrorCode(code) {
    if (code == null || code === '') return 0;
    const numeric = Number(code);
    return Number.isFinite(numeric) ? numeric : String(code);
}

function freshInitialState(initial) {
    return {
        ...INITIAL_STATE,
        heatmap: [],
        pois: [],
        photoSpots: [],
        handledProposalIds: [],
        closedEdges: [],
        ...initial
    };
}

function getSessionStorage() {
    try {
        return globalThis.sessionStorage || null;
    } catch (error) {
        void error;
        return null;
    }
}

export class TourStore extends EventTarget {
    constructor(initial = {}, {
        now = () => Date.now(),
        storage,
        handledStorageKey = HANDLED_PROPOSALS_STORAGE_KEY
    } = {}) {
        super();
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.storage = storage === undefined ? getSessionStorage() : storage || null;
        this.handledStorageKey = String(handledStorageKey || HANDLED_PROPOSALS_STORAGE_KEY);
        this.handledProposals = new Map(readHandledProposals(this.storage, this.handledStorageKey));
        for (const id of initial.handledProposalIds || []) {
            this.handledProposals.set(String(id), 'handled');
        }
        this.state = freshInitialState({
            ...initial,
            handledProposalIds: [...this.handledProposals.keys()]
        });
    }

    persistHandledProposals() {
        try {
            const records = [...this.handledProposals.entries()].slice(-32)
                .map(([id, status]) => ({ id, status }));
            this.storage?.setItem(this.handledStorageKey, JSON.stringify(records));
        } catch (error) {
            void error;
        }
    }

    getState() {
        return this.state;
    }

    subscribe(listener, { emitCurrent = false } = {}) {
        if (typeof listener !== 'function') throw new TypeError('Store subscriber must be a function');
        const handler = event => listener(event.detail.state, event.detail);
        this.addEventListener('change', handler);
        if (emitCurrent) {
            listener(this.state, {
                state: this.state,
                previous: this.state,
                action: 'SUBSCRIBED',
                reason: 'subscribe'
            });
        }
        return () => this.removeEventListener('change', handler);
    }

    commit(patch, { action = TOUR_ACTIONS.STATE_PATCHED, reason = 'state' } = {}) {
        const previous = this.state;
        this.state = { ...previous, ...patch };
        this.dispatchEvent(new CustomEvent('change', {
            detail: { state: this.state, previous, action, reason }
        }));
        return this.state;
    }

    set(patch, reason = 'state') {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new TypeError('Store patch must be an object');
        }
        return this.commit(patch, { action: TOUR_ACTIONS.STATE_PATCHED, reason });
    }

    dispatch(action, payload = {}) {
        switch (action) {
        case TOUR_ACTIONS.STATE_PATCHED:
            return this.set(payload.patch || payload, payload.reason || 'state');
        case TOUR_ACTIONS.ITINERARY_REPLACED:
            return this.replaceItinerary(payload.itinerary ?? null, payload.options);
        case TOUR_ACTIONS.HEATMAP_REPLACED:
            return this.applyHeatmap(payload.snapshot ?? payload);
        case TOUR_ACTIONS.CROWD_ITEM_UPDATED:
            return this.applyCrowdUpdate(payload.update ?? payload);
        case TOUR_ACTIONS.PANEL_CHANGED:
            return this.navigate(payload.panel, payload.patch);
        case TOUR_ACTIONS.ERROR_SET:
            return this.fail(payload.error ?? payload, payload.patch);
        case TOUR_ACTIONS.PROPOSAL_HANDLED:
            return this.markProposalHandled(payload.proposalId, payload.status);
        case TOUR_ACTIONS.PROPOSAL_CLEARED:
            return this.clearProposal(payload.status);
        default:
            throw new TypeError(`Unknown tour action: ${action}`);
        }
    }

    replaceItinerary(itinerary, { navigate = true } = {}) {
        if (itinerary === null) {
            return this.commit({
                itinerary: null,
                pendingProposal: null,
                proposalStatus: null,
                ...(navigate ? { activePanel: 'home' } : {}),
                lastError: null
            }, { action: TOUR_ACTIONS.ITINERARY_REPLACED, reason: 'itinerary:replace' });
        }
        if (!isCompleteItinerary(itinerary)) {
            const error = new TypeError('Server itinerary must be a complete itinerary document');
            error.code = 'ITINERARY_PARTIAL';
            throw error;
        }

        const current = this.state.itinerary;
        if (current
            && String(current.itineraryId) === String(itinerary.itineraryId)
            && itineraryVersion(itinerary) < itineraryVersion(current)) {
            return this.state;
        }

        const incomingProposal = itinerary.pendingProposal;
        const incomingProposalId = proposalId(incomingProposal);
        let pendingProposal = currentProposal(itinerary, this.now(), this.handledProposals.keys());
        let proposalStatus = pendingProposal ? 'pending' : null;
        if (incomingProposalId && proposalExpired(incomingProposal, this.now())) {
            this.handledProposals.set(incomingProposalId, 'expired');
            this.persistHandledProposals();
            pendingProposal = null;
            proposalStatus = 'expired';
        } else if (incomingProposalId && this.handledProposals.has(incomingProposalId)) {
            proposalStatus = this.handledProposals.get(incomingProposalId);
        }

        const samePendingProposal = Boolean(incomingProposalId)
            && proposalId(this.state.pendingProposal) === incomingProposalId;
        return this.commit({
            itinerary,
            pendingProposal,
            proposalStatus,
            handledProposalIds: [...this.handledProposals.keys()],
            ...(proposalStatus && proposalStatus !== 'pending' ? { lastHandledProposalId: incomingProposalId } : {}),
            ...(navigate && !samePendingProposal
                ? { activePanel: panelForItinerary(itinerary, { now: this.now(), handledProposalIds: this.handledProposals.keys() }) }
                : {}),
            lastError: null
        }, { action: TOUR_ACTIONS.ITINERARY_REPLACED, reason: 'itinerary:replace' });
    }

    markProposalHandled(id, status = 'handled') {
        const resolvedId = id == null
            ? proposalId(this.state.pendingProposal) || proposalId(this.state.itinerary?.pendingProposal)
            : String(id).trim();
        if (!resolvedId) return this.state;
        const resolvedStatus = String(status || 'handled');
        this.handledProposals.set(resolvedId, resolvedStatus);
        this.persistHandledProposals();
        const currentProposalId = proposalId(this.state.pendingProposal)
            || proposalId(this.state.itinerary?.pendingProposal);
        const clearsCurrent = currentProposalId === resolvedId;
        const leaveProposalPanel = clearsCurrent && this.state.activePanel === 'proposal';
        return this.commit({
            ...(clearsCurrent ? { pendingProposal: null } : {}),
            ...(leaveProposalPanel ? {
                activePanel: panelForItinerary(this.state.itinerary, {
                    now: this.now(),
                    handledProposalIds: this.handledProposals.keys()
                })
            } : {}),
            proposalStatus: resolvedStatus,
            handledProposalIds: [...this.handledProposals.keys()],
            lastHandledProposalId: resolvedId
        }, { action: TOUR_ACTIONS.PROPOSAL_HANDLED, reason: `proposal:${resolvedStatus}` });
    }

    clearProposal(status = 'cleared') {
        const id = proposalId(this.state.pendingProposal) || proposalId(this.state.itinerary?.pendingProposal);
        if (id) return this.markProposalHandled(id, status);
        return this.commit({
            pendingProposal: null,
            proposalStatus: String(status || 'cleared'),
            ...(this.state.activePanel === 'proposal' ? {
                activePanel: panelForItinerary(this.state.itinerary, {
                    now: this.now(),
                    handledProposalIds: this.handledProposals.keys()
                })
            } : {})
        }, {
            action: TOUR_ACTIONS.PROPOSAL_CLEARED,
            reason: 'proposal:clear'
        });
    }

    applyHeatmap(snapshot) {
        const items = Array.isArray(snapshot) ? snapshot : snapshot?.items || [];
        return this.commit({ heatmap: items, heatmapMeta: Array.isArray(snapshot) ? null : snapshot }, {
            action: TOUR_ACTIONS.HEATMAP_REPLACED,
            reason: 'heatmap'
        });
    }

    applyCrowdUpdate(update) {
        if (!update?.poiId) return this.state;
        const items = [...this.state.heatmap];
        const index = items.findIndex(item => String(item.poiId) === String(update.poiId));
        if (index >= 0) items[index] = { ...items[index], ...update };
        else items.push(update);
        return this.commit({ heatmap: items }, {
            action: TOUR_ACTIONS.CROWD_ITEM_UPDATED,
            reason: 'crowd:update'
        });
    }

    hasNewerVersion(version) {
        return Number.isFinite(Number(version))
            && Number(version) > Number(this.state.itinerary?.version ?? -1);
    }

    navigate(panel, patch = {}) {
        return this.commit({ activePanel: panel, ...(patch || {}) }, {
            action: TOUR_ACTIONS.PANEL_CHANGED,
            reason: 'navigate'
        });
    }

    fail(error, patch = {}) {
        const httpStatus = Number(error?.httpStatus ?? error?.status) || 0;
        return this.commit({
            lastError: {
                code: normalizedErrorCode(error?.code),
                category: error?.category || 'unknown',
                httpStatus,
                status: httpStatus,
                message: error?.message || '操作失败',
                retryable: Boolean(error?.retryable),
                requestId: error?.requestId || null
            },
            ...(patch || {})
        }, { action: TOUR_ACTIONS.ERROR_SET, reason: 'error' });
    }
}

export { currentProposal, isCompleteItinerary, panelForItinerary, proposalExpired };
