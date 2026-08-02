'use strict';

function nowIso(clock) {
    return new Date(clock()).toISOString();
}

function safeFailure(error, fallbackCode) {
    const rawCode = String(error?.code || fallbackCode || 'STARTUP_FAILED');
    const code = /^[A-Z0-9_:-]{1,64}$/.test(rawCode) ? rawCode : fallbackCode;
    const message = fallbackCode === 'GIS_STATUS_UNAVAILABLE'
        ? 'GIS status unavailable'
        : 'Startup component failed';
    return { code, message };
}

function createComponent(state, required, clock, extra = {}) {
    const at = nowIso(clock);
    return {
        state,
        required,
        startedAt: state === 'pending' ? at : null,
        completedAt: state === 'pending' ? null : at,
        error: null,
        ...extra
    };
}

function createRuntimeReadiness({ backgroundEnabled = true, clock = Date.now } = {}) {
    const startedAt = nowIso(clock);
    const components = {
        graph: createComponent('pending', true, clock, { ready: false }),
        poiIndex: createComponent('pending', true, clock, { ready: false, count: 0 }),
        jobs: backgroundEnabled
            ? createComponent('pending', true, clock, {
                enabled: true,
                running: false,
                reason: null,
                instance: null,
                scheduledJobs: []
            })
            : createComponent('disabled', false, clock, {
                enabled: false,
                running: false,
                reason: 'background-disabled',
                instance: null,
                scheduledJobs: []
            })
    };

    function replace(name, value) {
        components[name] = value;
        return value;
    }

    async function track(name, operation, options = {}) {
        if (!Object.hasOwn(components, name) || name === 'jobs') {
            throw new TypeError(`Unsupported readiness component: ${name}`);
        }
        const previous = components[name];
        replace(name, {
            ...previous,
            state: 'pending',
            ready: false,
            startedAt: nowIso(clock),
            completedAt: null,
            error: null
        });
        try {
            const result = await operation();
            if (options.assertReady && !options.assertReady(result)) {
                const error = new Error(options.notReadyMessage || `${name} is not ready`);
                error.code = options.notReadyCode || `${name.toUpperCase()}_NOT_READY`;
                throw error;
            }
            const details = options.details ? options.details(result) : {};
            replace(name, {
                ...components[name],
                ...details,
                state: 'ready',
                ready: true,
                completedAt: nowIso(clock),
                error: null
            });
            return result;
        } catch (error) {
            replace(name, {
                ...components[name],
                state: 'failed',
                ready: false,
                completedAt: nowIso(clock),
                error: safeFailure(error, `${name.toUpperCase()}_STARTUP_FAILED`)
            });
            throw error;
        }
    }

    function setJobs(status = {}) {
        const intentionallyDisabled = status.enabled === false
            && ['background-disabled', 'non-primary-instance'].includes(status.reason);
        const running = status.running === true;
        const state = running ? 'ready' : intentionallyDisabled ? 'disabled' : 'failed';
        return replace('jobs', {
            ...components.jobs,
            state,
            required: !intentionallyDisabled,
            enabled: status.enabled === true,
            running,
            reason: status.reason || (running ? null : 'scheduler-not-running'),
            instance: status.instance ?? null,
            scheduledJobs: Array.isArray(status.scheduledJobs) ? [...status.scheduledJobs] : [],
            completedAt: nowIso(clock),
            error: state === 'failed'
                ? { code: 'JOBS_NOT_RUNNING', message: 'Background scheduler did not start' }
                : null
        });
    }

    function failJobs(error) {
        return replace('jobs', {
            ...components.jobs,
            state: 'failed',
            required: true,
            enabled: true,
            running: false,
            reason: 'startup-failed',
            completedAt: nowIso(clock),
            error: safeFailure(error, 'JOBS_STARTUP_FAILED')
        });
    }

    function snapshot(runtime = {}) {
        const copy = Object.fromEntries(Object.entries(components).map(([name, component]) => [
            name,
            { ...component, scheduledJobs: component.scheduledJobs
                ? [...component.scheduledJobs]
                : undefined }
        ]));
        if (typeof runtime.graphReady === 'boolean') copy.graph.ready = runtime.graphReady;
        if (Number.isInteger(runtime.poiIndexCount) && runtime.poiIndexCount >= 0) {
            copy.poiIndex.count = runtime.poiIndexCount;
        }

        const required = Object.values(copy).filter(component => component.required);
        const runtimeNotReady = required.some(component => component.ready === false
            && component.state === 'ready');
        const state = required.some(component => component.state === 'failed') || runtimeNotReady
            ? 'failed'
            : required.some(component => component.state === 'pending')
                ? 'pending'
                : 'ready';
        const allSettled = required.every(component => component.state !== 'pending');
        return {
            state,
            ready: state === 'ready',
            startedAt,
            completedAt: allSettled
                ? required.reduce((latest, component) => {
                    if (!component.completedAt) return latest;
                    return !latest || component.completedAt > latest ? component.completedAt : latest;
                }, null)
                : null,
            components: copy
        };
    }

    return { track, setJobs, failJobs, snapshot };
}

function mongoStatusOf(mongoose) {
    const states = ['offline', 'online', 'connecting', 'disconnecting'];
    const readyState = Number(mongoose?.connection?.readyState);
    return {
        state: states[readyState] || 'offline',
        readyState: Number.isInteger(readyState) ? readyState : 0
    };
}

async function waitForMongoReady(mongoose) {
    const connection = mongoose?.connection;
    if (Number(connection?.readyState) === 1) return connection;
    if (!connection || typeof connection.asPromise !== 'function') {
        const error = new Error('MongoDB connection readiness is unavailable');
        error.code = 'MONGO_READINESS_UNAVAILABLE';
        throw error;
    }
    try {
        await connection.asPromise();
    } catch (cause) {
        const error = new Error('MongoDB did not become ready');
        error.code = 'MONGO_STARTUP_FAILED';
        error.cause = cause;
        throw error;
    }
    if (Number(connection.readyState) !== 1) {
        const error = new Error('MongoDB connection is not online');
        error.code = 'MONGO_NOT_READY';
        throw error;
    }
    return connection;
}

function offlineGisStatus(error) {
    return {
        enabled: true,
        state: 'offline',
        degraded: true,
        manifest: null,
        error: safeFailure(error, 'GIS_STATUS_UNAVAILABLE')
    };
}

function createHealthHandler({
    mongoose,
    superMapGateway,
    readiness,
    walkGraph,
    crowdService,
    config
}) {
    if (!readiness || typeof readiness.snapshot !== 'function') {
        throw new TypeError('Health handler requires a readiness tracker');
    }
    return async function healthHandler(req, res) {
        const snap = crowdService.getHeatmapSnapshot();
        const mongo = mongoStatusOf(mongoose);
        let gis;
        try {
            gis = await superMapGateway.getStatus({ requestId: req.headers['x-request-id'] });
        } catch (error) {
            gis = offlineGisStatus(error);
        }
        let diagnostics = {};
        try {
            diagnostics = superMapGateway.getDiagnostics?.() || {};
        } catch {
            diagnostics = {};
        }
        const graphLoaded = walkGraph.isReady();
        const poiIndexCount = crowdService.getPoiIndex().length;
        const startup = readiness.snapshot({ graphReady: graphLoaded, poiIndexCount });
        const coreAvailable = mongo.state === 'online' && startup.ready;
        const coreState = mongo.state === 'online'
            ? startup.state
            : mongo.state === 'connecting' ? 'pending' : 'failed';
        const state = coreAvailable
            ? (gis.state === 'online' ? 'online' : 'degraded')
            : 'offline';
        const jobs = startup.components.jobs;

        res.status(coreAvailable ? 200 : 503).json({
            state,
            core: {
                state: coreState,
                ready: coreAvailable
            },
            graphLoaded,
            poiIndexReady: startup.components.poiIndex.ready,
            poiIndexCount,
            jobsRunning: jobs.running,
            jobs,
            startup,
            lastCiSlot: snap?.slot || null,
            rainSource: config.features.rain ? 'minute' : config.features.weather ? 'hourly' : 'off',
            llm: config.features.guide,
            simMode: config.simMode,
            mongo,
            gis,
            manifest: gis.manifest || null,
            cache: {
                routeCount: diagnostics.routeCacheSize || 0,
                lastInvalidationReason: diagnostics.lastInvalidationReason || null
            },
            lastSuccessfulGisAt: diagnostics.lastSuccessAt || null
        });
    };
}

module.exports = {
    createRuntimeReadiness,
    createHealthHandler,
    mongoStatusOf,
    waitForMongoReady,
    safeFailure
};
