import { ApiError, apiErrorCategory, safeApiMessage } from '../shared/errors.js';
import { DEMO_CLOSED_EDGE, DEMO_PROPOSAL_TEMPLATE, DEMO_ROUTES } from '../../mock/runtime.js';

const FIXTURE_BASE = '/assets/mock';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

const SCENARIO_STATUS = Object.freeze({
    1203: 409,
    1204: 400,
    1205: 400,
    8201: 503,
    8202: 503,
    8204: 400
});

function scenarioOperation(code) {
    if ([8201, 8202, 8204].includes(Number(code))) return 'plan';
    if ([1204, 1205].includes(Number(code))) return 'proposal';
    if (Number(code) === 1203) return 'write';
    if ([2102, 2103].includes(Number(code))) return 'position';
    return 'all';
}

function cancelledError(cause = null) {
    return new ApiError('请求已取消', {
        category: 'cancelled',
        retryable: false,
        cause
    });
}

function nowOf(clock) {
    return typeof clock.now === 'function' ? Number(clock.now()) : Date.now();
}

export class DemoApiClient {
    constructor({
        scenario = '',
        fetchImpl = globalThis.fetch?.bind(globalThis),
        clock = globalThis,
        storage = globalThis.sessionStorage
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.clock = clock;
        this.storage = storage;
        this.controllers = new Map();
        this.fixtureCache = new Map();
        this.scenarios = new Map();
        this.itinerary = this.readStoredItinerary();
        if (scenario && typeof scenario === 'object') {
            for (const [operation, code] of Object.entries(scenario)) this.setScenario(operation, code);
        } else if (scenario) {
            this.setScenario(Number(scenario));
        }
    }

    readStoredItinerary() {
        try {
            return JSON.parse(this.storage?.getItem('geosync:demo-itinerary')) || null;
        } catch {
            return null;
        }
    }

    persist() {
        if (!this.storage) return;
        if (this.itinerary) this.storage.setItem('geosync:demo-itinerary', JSON.stringify(this.itinerary));
        else this.storage.removeItem('geosync:demo-itinerary');
    }

    setScenario(operation, code) {
        if (code === undefined) {
            code = Number(operation);
            operation = scenarioOperation(code);
        }
        const numericCode = Number(code);
        if (numericCode) this.scenarios.set(String(operation), numericCode);
        return this;
    }

    clearScenario(operation) {
        if (operation) this.scenarios.delete(String(operation));
        else this.scenarios.clear();
        return this;
    }

    scenarioCode(operation) {
        return this.scenarios.get(operation)
            || (operation === 'proposal' ? this.scenarios.get('write') : 0)
            || this.scenarios.get('all')
            || 0;
    }

    throwScenario(operation) {
        const code = this.scenarioCode(operation);
        if (!code || [2102, 2103].includes(code)) return;
        const status = SCENARIO_STATUS[code] || 400;
        const category = apiErrorCategory({ status, code });
        throw new ApiError(safeApiMessage({ status, code, category }), {
            category,
            httpStatus: status,
            code,
            retryable: status >= 500
        });
    }

    register(key, controller) {
        if (!this.controllers.has(key)) this.controllers.set(key, new Set());
        this.controllers.get(key).add(controller);
    }

    unregister(key, controller) {
        const controllers = this.controllers.get(key);
        controllers?.delete(controller);
        if (!controllers?.size) this.controllers.delete(key);
    }

    cancel(key) {
        for (const controller of this.controllers.get(key) || []) controller.abort();
        this.controllers.delete(key);
    }

    cancelAll() {
        for (const key of [...this.controllers.keys()]) this.cancel(key);
    }

    destroy() {
        this.cancelAll();
    }

    wait(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(cancelledError(signal.reason));
            const timer = this.clock.setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
            const onAbort = () => {
                cleanup();
                reject(cancelledError(signal.reason));
            };
            const cleanup = () => {
                this.clock.clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    async run(key, operation, { delayMs = 90, cancelPrevious = true } = {}) {
        if (cancelPrevious) this.cancel(key);
        const controller = new AbortController();
        this.register(key, controller);
        try {
            await this.wait(delayMs, controller.signal);
            if (controller.signal.aborted) throw cancelledError(controller.signal.reason);
            return clone(await operation(controller.signal));
        } catch (error) {
            if (error instanceof ApiError) throw error;
            if (controller.signal.aborted || error?.name === 'AbortError') throw cancelledError(error);
            throw new ApiError('演示数据暂时不可用', {
                category: 'response',
                retryable: true,
                cause: error
            });
        } finally {
            this.unregister(key, controller);
        }
    }

    delay(value, ms = 90) {
        return this.run(`delay:${Math.random()}`, () => value, { delayMs: ms, cancelPrevious: false });
    }

    async fixture(name, signal) {
        if (this.fixtureCache.has(name)) return clone(this.fixtureCache.get(name));
        if (typeof this.fetchImpl !== 'function') throw new TypeError('fetch unavailable');
        const response = await this.fetchImpl(`${FIXTURE_BASE}/${name}`, {
            credentials: 'same-origin',
            signal
        });
        if (!response.ok) throw new Error(`fixture ${name} unavailable`);
        const value = await response.json();
        this.fixtureCache.set(name, value);
        return clone(value);
    }

    getClientConfig() {
        return this.run('config', signal => this.fixture('client-config.json', signal));
    }

    getBoundary() {
        return this.run('boundary', signal => this.fixture('boundary.geojson', signal));
    }

    getPois() {
        return this.run('pois', async signal => {
            const collection = await this.fixture('pois.geojson', signal);
            return collection.features.map(feature => ({
                id: feature.properties.poiId,
                poiName: feature.properties.name,
                category: feature.properties.category,
                description: feature.properties.description,
                status: feature.properties.status,
                lng: feature.geometry.coordinates[0],
                lat: feature.geometry.coordinates[1]
            }));
        });
    }

    getHeatmap() {
        return this.run('heatmap', signal => this.fixture('heatmap.json', signal));
    }

    getCurrentItinerary() {
        return this.run('current', () => this.itinerary);
    }

    getClosedEdges() {
        return this.run('closed-edges', signal => this.fixture('closed-edges.json', signal));
    }

    getPhotoSpots() {
        return this.run('photospots', signal => this.fixture('photospots.json', signal));
    }

    getGoldenWindow(id) {
        return this.run(`golden:${id}`, async signal => {
            const fixture = await this.fixture('photospots.json', signal);
            return fixture.items.find(item => String(item.spotId) === String(id))?.golden || null;
        });
    }

    getArData(id) {
        return this.run(`ar:${id}`, async signal => {
            const fixture = await this.fixture('photospots.json', signal);
            return fixture.items.find(item => String(item.spotId) === String(id))?.ar || null;
        });
    }

    async plan(payload) {
        return this.run('plan', async signal => {
            this.throwScenario('plan');
            const [template, routes] = await Promise.all([
                this.fixture('itinerary.json', signal),
                this.fixture('routes.json', signal)
            ]);
            const mode = payload.accessible ? 'accessible' : payload.shadeFirst ? 'shade' : 'normal';
            const now = nowOf(this.clock);
            template.date = new Date(now).toISOString().slice(0, 10);
            template.preferences = { ...payload };
            template.stops = template.stops.map((stop, index) => ({
                ...stop,
                plannedArrive: new Date(now + (index * 55 + 20) * 60000).toISOString(),
                plannedLeave: new Date(now + (index * 55 + 45) * 60000).toISOString()
            }));
            template.route = {
                ...routes.before,
                gis: { ...routes.before.gis, mode },
                verifiedAccessible: mode === 'accessible' ? true : null
            };
            this.itinerary = template;
            this.persist();
            return this.itinerary;
        }, { delayMs: 320 });
    }

    planItinerary(payload) { return this.plan(payload); }

    requireItinerary(id, version) {
        if (!this.itinerary
            || String(this.itinerary.itineraryId) !== String(id)
            || Number(this.itinerary.version) !== Number(version)) {
            const status = 409;
            throw new ApiError(safeApiMessage({ status, code: 1203 }), {
                category: 'conflict', httpStatus: status, code: 1203
            });
        }
    }

    transition(id, version, state, key) {
        return this.run('itinerary-write', () => {
            this.throwScenario('write');
            this.requireItinerary(id, version);
            this.itinerary = { ...this.itinerary, state, version: this.itinerary.version + 1 };
            this.persist();
            return this.itinerary;
        }, { delayMs: 90, cancelPrevious: true, key });
    }

    start(id, version) { return this.transition(id, version, 'active'); }
    startItinerary(id, version) { return this.start(id, version); }
    pause(id, version) { return this.transition(id, version, 'paused'); }
    pauseItinerary(id, version) { return this.pause(id, version); }
    resume(id, version) { return this.transition(id, version, 'active'); }
    resumeItinerary(id, version) { return this.resume(id, version); }
    finish(id, version) { return this.transition(id, version, 'completed'); }
    endItinerary(id, version) { return this.finish(id, version); }

    skip(id, stopId, version) {
        return this.run('itinerary-write', () => {
            this.throwScenario('write');
            this.requireItinerary(id, version);
            if (!this.itinerary.stops.some(stop => String(stop.stopId) === String(stopId))) {
                throw new ApiError(safeApiMessage({ status: 409, code: 1203 }), {
                    category: 'conflict', httpStatus: 409, code: 1203
                });
            }
            this.itinerary = {
                ...this.itinerary,
                version: this.itinerary.version + 1,
                stops: this.itinerary.stops.map(stop =>
                    String(stop.stopId) === String(stopId) ? { ...stop, state: 'skipped' } : stop)
            };
            this.persist();
            return this.itinerary;
        });
    }

    skipStop(id, stopId, version) { return this.skip(id, stopId, version); }

    reportPosition() {
        return this.run('position', () => {
            const code = this.scenarioCode('position');
            if (code === 2102) return { accepted: false, outOfFence: true, code, message: safeApiMessage({ code }) };
            if (code === 2103) return { accepted: false, code, message: safeApiMessage({ code }) };
            return { accepted: true, code: 0, message: '' };
        }, { delayMs: 20, cancelPrevious: false });
    }

    setProposal(proposal) {
        if (!this.itinerary) return;
        this.itinerary = { ...this.itinerary, pendingProposal: clone(proposal) };
        this.persist();
    }

    decideProposal(id, proposalId, decision, version) {
        return this.run('itinerary-write', async signal => {
            this.throwScenario('proposal');
            this.requireItinerary(id, version);
            const proposal = this.itinerary.pendingProposal;
            if (!proposal || String(proposal.proposalId) !== String(proposalId)
                || new Date(proposal.expireAt).getTime() <= nowOf(this.clock)) {
                throw new ApiError(safeApiMessage({ status: 400, code: 1204 }), {
                    category: 'business', httpStatus: 400, code: 1204
                });
            }
            if (!['accept', 'reject'].includes(String(decision))) {
                throw new ApiError('路线建议操作无效', { category: 'business' });
            }
            let route = this.itinerary.route;
            let stops = this.itinerary.stops;
            let currentStopId = this.itinerary.currentStopId;
            let planNote = this.itinerary.planNote;
            let rerouteCount = this.itinerary.rerouteCount;
            let savedMinutesTotal = this.itinerary.savedMinutesTotal;
            if (decision === 'accept') {
                const acceptedSnapshot = await this.fixture('itinerary-rerouted.json', signal);
                route = acceptedSnapshot.route;
                stops = acceptedSnapshot.stops;
                currentStopId = acceptedSnapshot.currentStopId;
                planNote = acceptedSnapshot.planNote;
                rerouteCount = Number(rerouteCount || 0) + 1;
                savedMinutesTotal = Number(savedMinutesTotal || 0) + Number(proposal.gainMin || 0);
            }
            this.itinerary = {
                ...this.itinerary,
                version: this.itinerary.version + 1,
                route,
                stops,
                currentStopId,
                planNote,
                pendingProposal: null,
                rerouteCount,
                savedMinutesTotal
            };
            this.persist();
            return this.itinerary;
        });
    }

    acceptProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'accept', version);
    }

    rejectProposal(id, proposalId, version) {
        return this.decideProposal(id, proposalId, 'reject', version);
    }
}

export function demoProposal(version = 1) {
    return {
        ...clone(DEMO_PROPOSAL_TEMPLATE),
        version,
        expireAt: new Date(Date.now() + 8 * 60000).toISOString(),
        beforeRoute: clone(DEMO_ROUTES.before),
        afterRoute: clone(DEMO_ROUTES.after)
    };
}

export function demoClosedEdge() {
    return { ...clone(DEMO_CLOSED_EDGE), at: new Date().toISOString() };
}
