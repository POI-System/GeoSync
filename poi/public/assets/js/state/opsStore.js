const INITIAL_PROPOSAL_STATS = Object.freeze({
    shown: 0,
    accepted: 0,
    rejected: 0,
    expired: 0,
    failed: 0
});

export function createInitialOpsState() {
    return {
        boot: 'loading',
        config: null,
        health: null,
        dashboard: null,
        heatmap: [],
        heatmapMeta: { slot: null, lowConfidence: false },
        graph: { nodes: [], edges: [] },
        selectedEdgeId: null,
        pendingOperation: null,
        operationEvents: [],
        proposalStats: { ...INITIAL_PROPOSAL_STATS },
        socketState: 'connecting',
        joinedRooms: [],
        alerts: [],
        lastUpdatedAt: null,
        lastError: null
    };
}

function nowIso() {
    return new Date().toISOString();
}

function normalizedHeatmap(snapshot) {
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    return items
        .filter(item => item && item.poiId != null)
        .map(item => ({ ...item, poiId: String(item.poiId), ci: Number(item.ci) || 0 }));
}

function mergeHeatmapItem(items, update) {
    if (!update || update.poiId == null) return items;
    const poiId = String(update.poiId);
    const index = items.findIndex(item => String(item.poiId) === poiId);
    if (index < 0) return [{ ...update, poiId }, ...items];
    const next = items.slice();
    next[index] = { ...next[index], ...update, poiId };
    return next;
}

function normalizedGraph(graph) {
    return {
        nodes: Array.isArray(graph?.nodes) ? graph.nodes.map(node => ({ ...node })) : [],
        edges: Array.isArray(graph?.edges) ? graph.edges.map(edge => ({ ...edge })) : []
    };
}

export class OpsStore {
    constructor(initialState = {}) {
        this.state = { ...createInitialOpsState(), ...initialState };
        this.listeners = new Set();
        this.proposalEventKeys = new Set();
        this.impactEventKeys = new Set();
    }

    getState() {
        return this.state;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    update(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener(this.state);
        return this.state;
    }

    ready(payload) {
        return this.update({
            boot: 'ready',
            config: payload.config ?? this.state.config,
            health: payload.health ?? this.state.health,
            dashboard: payload.dashboard ?? this.state.dashboard,
            heatmap: normalizedHeatmap(payload.heatmap),
            heatmapMeta: {
                slot: payload.heatmap?.slot || null,
                lowConfidence: Boolean(payload.heatmap?.lowConfidence)
            },
            graph: normalizedGraph(payload.graph),
            alerts: Array.isArray(payload.dashboard?.alerts) ? payload.dashboard.alerts.slice(0, 20) : [],
            lastUpdatedAt: nowIso(),
            lastError: null
        });
    }

    fail(error, { fatal = false } = {}) {
        return this.update({
            boot: fatal ? 'error' : this.state.boot,
            lastError: error?.message || String(error || '未知错误')
        });
    }

    setHealth(health) {
        return this.update({ health, lastUpdatedAt: nowIso() });
    }

    setDashboard(dashboard) {
        return this.update({
            dashboard,
            alerts: Array.isArray(dashboard?.alerts) ? dashboard.alerts.slice(0, 20) : this.state.alerts,
            lastUpdatedAt: nowIso(),
            lastError: null
        });
    }

    setHeatmap(snapshot) {
        return this.update({
            heatmap: normalizedHeatmap(snapshot),
            heatmapMeta: {
                slot: snapshot?.slot || null,
                lowConfidence: Boolean(snapshot?.lowConfidence)
            },
            lastUpdatedAt: nowIso()
        });
    }

    applyCrowdUpdate(update) {
        return this.update({
            heatmap: mergeHeatmapItem(this.state.heatmap, update),
            lastUpdatedAt: nowIso()
        });
    }

    setGraph(graph) {
        const nextGraph = normalizedGraph(graph);
        const selectedExists = nextGraph.edges.some(edge => String(edge.edgeId) === this.state.selectedEdgeId);
        return this.update({
            graph: nextGraph,
            selectedEdgeId: selectedExists ? this.state.selectedEdgeId : null,
            lastUpdatedAt: nowIso()
        });
    }

    selectEdge(edgeId) {
        const normalized = edgeId == null ? null : String(edgeId);
        const exists = normalized && this.state.graph.edges.some(edge => String(edge.edgeId) === normalized);
        return this.update({ selectedEdgeId: exists ? normalized : null });
    }

    startOperation({ edgeId, operation, reason = '', durationMin = null }) {
        return this.update({
            pendingOperation: {
                edgeId: String(edgeId),
                operation,
                reason,
                durationMin,
                status: 'submitting',
                eventId: null,
                startedAt: nowIso()
            },
            lastError: null
        });
    }

    acceptOperation(payload) {
        if (!this.state.pendingOperation) return this.state;
        const pendingOperation = {
            ...this.state.pendingOperation,
            status: 'processing',
            eventId: payload?.eventId || null,
            acceptedAt: payload?.acceptedAt || nowIso()
        };
        return this.update({ pendingOperation });
    }

    rejectOperation(error) {
        return this.update({
            pendingOperation: null,
            lastError: error?.message || String(error || '操作失败')
        });
    }

    applyGraphUpdate(payload) {
        if (!payload?.edgeId || !payload?.status) return this.state;
        const edgeId = String(payload.edgeId);
        const edges = this.state.graph.edges.map(edge => String(edge.edgeId) === edgeId
            ? {
                ...edge,
                status: payload.status,
                closedReason: payload.status === 'closed' ? payload.reason || edge.closedReason : null,
                closedAt: payload.status === 'closed' ? payload.at || nowIso() : null,
                reopenedAt: payload.status === 'open' ? payload.at || nowIso() : edge.reopenedAt
            }
            : edge);
        const matchesPending = this.state.pendingOperation?.edgeId === edgeId
            && (!this.state.pendingOperation.eventId || !payload.eventId
                || this.state.pendingOperation.eventId === payload.eventId);
        const operationEvents = [{
            type: 'graph',
            ...payload,
            edgeId,
            at: payload.at || nowIso()
        }, ...this.state.operationEvents].slice(0, 30);
        return this.update({
            graph: { ...this.state.graph, edges },
            pendingOperation: matchesPending ? null : this.state.pendingOperation,
            operationEvents,
            lastUpdatedAt: nowIso()
        });
    }

    applyImpact(payload) {
        if (!payload?.eventId || !payload?.edgeId) return this.state;
        const key = `${payload.eventId}:${payload.edgeId}`;
        if (this.impactEventKeys.has(key)) return this.state;
        this.impactEventKeys.add(key);
        const operationEvents = [{
            type: 'impact',
            ...payload,
            at: payload.completedAt || nowIso()
        }, ...this.state.operationEvents].slice(0, 30);
        return this.update({
            operationEvents,
            proposalStats: {
                ...this.state.proposalStats,
                shown: this.state.proposalStats.shown + (Number(payload.proposalsCreated) || 0),
                failed: this.state.proposalStats.failed + (Number(payload.failed) || 0)
            },
            lastUpdatedAt: nowIso()
        });
    }

    applyProposalStatus(payload) {
        const status = String(payload?.status || '');
        if (!(status in INITIAL_PROPOSAL_STATS)) return this.state;
        const key = [payload.eventId, payload.itineraryId, payload.proposalId, status, payload.version].join(':');
        if (this.proposalEventKeys.has(key)) return this.state;
        this.proposalEventKeys.add(key);
        const operationEvents = [{ type: 'proposal', ...payload, at: payload.at || nowIso() },
            ...this.state.operationEvents].slice(0, 30);
        return this.update({
            proposalStats: {
                ...this.state.proposalStats,
                [status]: this.state.proposalStats[status] + 1
            },
            operationEvents,
            lastUpdatedAt: nowIso()
        });
    }

    addAlert(alert) {
        if (!alert) return this.state;
        return this.update({ alerts: [{ ...alert, at: alert.at || nowIso() }, ...this.state.alerts].slice(0, 20) });
    }

    setSocketState(socketState, joinedRooms = this.state.joinedRooms) {
        return this.update({ socketState, joinedRooms });
    }
}
