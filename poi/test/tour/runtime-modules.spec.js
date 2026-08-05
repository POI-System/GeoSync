'use strict';

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    await page.goto('/tour?demo=1');
});

test('TourStore rejects partial or stale itineraries and de-duplicates handled proposals', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { TOUR_ACTIONS, TourStore } = await import('/assets/js/state/tourStore.js');
        let now = Date.parse('2026-08-03T10:00:00Z');
        const itinerary = (version, pendingProposal = null) => ({
            itineraryId: 'itinerary-1',
            version,
            state: 'active',
            stops: [{ stopId: 'stop-1', poiId: 'poi-1', state: 'approaching' }],
            route: {
                geometry: { type: 'LineString', coordinates: [[114.35, 30.54], [114.36, 30.55]] },
                distanceM: 500,
                durationSec: 420,
                gis: { source: 'iserver', mode: 'normal', degraded: false }
            },
            pendingProposal
        });
        const proposal = (proposalId, expireAt) => ({ proposalId, expireAt, reason: '临时封路' });
        const store = new TourStore({}, { now: () => now });
        const notifications = [];
        const unsubscribe = store.subscribe((_state, detail) => notifications.push(detail.action));

        store.replaceItinerary(itinerary(2));
        store.replaceItinerary(itinerary(1));
        const versionAfterStale = store.getState().itinerary.version;
        const notificationsAfterStale = notifications.length;

        const activeProposal = proposal('proposal-1', '2026-08-03T10:05:00Z');
        store.replaceItinerary(itinerary(2, activeProposal));
        const firstPending = store.getState().pendingProposal?.proposalId;
        store.markProposalHandled('proposal-1', 'accepted');
        const panelAfterHandled = store.getState().activePanel;
        store.replaceItinerary(itinerary(2, activeProposal));
        const replayedPending = store.getState().pendingProposal;
        const replayedStatus = store.getState().proposalStatus;

        now = Date.parse('2026-08-03T10:10:00Z');
        store.replaceItinerary(itinerary(3, proposal('proposal-2', '2026-08-03T10:09:59Z')));
        const expired = {
            pending: store.getState().pendingProposal,
            status: store.getState().proposalStatus,
            handledIds: [...store.getState().handledProposalIds]
        };

        let partialError = null;
        try {
            store.replaceItinerary({ itineraryId: 'partial', version: 4, state: 'active' });
        } catch (error) {
            partialError = { name: error.name, code: error.code };
        }

        store.dispatch(TOUR_ACTIONS.PANEL_CHANGED, { panel: 'home' });
        store.fail({
            code: 'MAP_SERVICE_UNAVAILABLE',
            category: 'map',
            httpStatus: 503,
            message: '地图服务不可用',
            retryable: true,
            requestId: 'request-1'
        });
        const lastError = { ...store.getState().lastError };
        const notificationsBeforeUnsubscribe = notifications.length;
        unsubscribe();
        store.set({ socketState: 'offline' }, 'socket:test');
        const notificationsAfterUnsubscribe = notifications.length;
        store.replaceItinerary(null);

        return {
            versionAfterStale,
            notificationsAfterStale,
            firstPending,
            panelAfterHandled,
            replayedPending,
            replayedStatus,
            expired,
            partialError,
            notificationsBeforeUnsubscribe,
            notificationsAfterUnsubscribe,
            lastError,
            finalItinerary: store.getState().itinerary,
            actions: notifications
        };
    });

    expect(result.versionAfterStale).toBe(2);
    expect(result.notificationsAfterStale).toBe(1);
    expect(result.firstPending).toBe('proposal-1');
    expect(result.panelAfterHandled).toBe('touring');
    expect(result.replayedPending).toBeNull();
    expect(result.replayedStatus).toBe('accepted');
    expect(result.expired).toEqual({
        pending: null,
        status: 'expired',
        handledIds: ['proposal-1', 'proposal-2']
    });
    expect(result.partialError).toEqual({ name: 'TypeError', code: 'ITINERARY_PARTIAL' });
    expect(result.lastError).toEqual({
        code: 'MAP_SERVICE_UNAVAILABLE',
        category: 'map',
        httpStatus: 503,
        status: 503,
        message: '地图服务不可用',
        retryable: true,
        requestId: 'request-1'
    });
    expect(result.notificationsAfterUnsubscribe).toBe(result.notificationsBeforeUnsubscribe);
    expect(result.finalItinerary).toBeNull();
    expect(result.actions).toContain('ITINERARY_REPLACED');
    expect(result.actions).toContain('PROPOSAL_HANDLED');
    expect(result.actions).toContain('PANEL_CHANGED');
});

test('SocketClient polls while offline, joins once per connection, and removes manager listeners', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { SocketClient } = await import('/assets/js/realtime/socketClient.js');
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const makeEmitter = () => {
            const handlers = new Map();
            const outgoing = [];
            return {
                handlers,
                outgoing,
                disconnected: false,
                on(name, handler) {
                    if (!handlers.has(name)) handlers.set(name, new Set());
                    handlers.get(name).add(handler);
                    return this;
                },
                off(name, handler) {
                    handlers.get(name)?.delete(handler);
                    return this;
                },
                emit(name, payload) {
                    outgoing.push({ name, payload });
                    return this;
                },
                trigger(name, payload) {
                    for (const handler of [...(handlers.get(name) || [])]) handler(payload);
                },
                listenerCount() {
                    return [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
                },
                disconnect() {
                    this.disconnected = true;
                }
            };
        };

        const manager = makeEmitter();
        const socket = makeEmitter();
        socket.io = manager;
        let polls = 0;
        let reconnected = 0;
        const client = new SocketClient({
            scenicId: 'scenic-test',
            openId: 'local-openid-test',
            ioFactory: () => socket,
            poll: async () => { polls += 1; },
            pollIntervalMs: 12
        });
        client.addEventListener('reconnected', () => { reconnected += 1; });
        client.connect();
        socket.trigger('connect');
        const initialJoinCount = socket.outgoing.filter(item => item.name === 'geosync:join').length;
        const initialJoinPayload = socket.outgoing.find(item => item.name === 'geosync:join')?.payload;

        socket.trigger('disconnect');
        await wait(40);
        const pollsWhileOffline = polls;
        manager.trigger('reconnect');
        const joinsBeforeNamespaceReconnect = socket.outgoing.filter(item => item.name === 'geosync:join').length;
        socket.trigger('connect');
        const reconnectJoinCount = socket.outgoing.filter(item => item.name === 'geosync:join').length;
        const pollsWhenConnected = polls;
        await wait(35);
        const pollsAfterConnectedWait = polls;

        socket.trigger('geosync:joined', { ok: false, message: 'denied' });
        await wait(30);
        const pollsAfterJoinFailure = polls;
        socket.trigger('geosync:joined', { ok: true, rooms: ['scenic:scenic-test'] });
        const pollsAfterJoinSuccess = polls;
        await wait(30);
        const pollsAfterJoinSuccessWait = polls;

        client.destroy();
        const listenersAfterDestroy = {
            socket: socket.listenerCount(),
            manager: manager.listenerCount()
        };
        manager.trigger('reconnect');
        await wait(20);

        return {
            initialJoinCount,
            initialJoinPayload,
            joinsBeforeNamespaceReconnect,
            reconnectJoinCount,
            reconnected,
            pollsWhileOffline,
            pollsWhenConnected,
            pollsAfterConnectedWait,
            pollsAfterJoinFailure,
            pollsAfterJoinSuccess,
            pollsAfterJoinSuccessWait,
            listenersAfterDestroy,
            disconnected: socket.disconnected,
            finalPolls: polls
        };
    });

    expect(result.initialJoinCount).toBe(1);
    expect(result.initialJoinPayload).toEqual({
        role: 'tourist',
        openId: 'local-openid-test',
        scenicId: 'scenic-test'
    });
    expect(result.joinsBeforeNamespaceReconnect).toBe(1);
    expect(result.reconnectJoinCount).toBe(2);
    expect(result.reconnected).toBe(1);
    expect(result.pollsWhileOffline).toBeGreaterThanOrEqual(2);
    expect(result.pollsAfterConnectedWait).toBe(result.pollsWhenConnected);
    expect(result.pollsAfterJoinFailure).toBeGreaterThan(result.pollsAfterConnectedWait);
    expect(result.pollsAfterJoinSuccessWait).toBe(result.pollsAfterJoinSuccess);
    expect(result.listenersAfterDestroy).toEqual({ socket: 0, manager: 0 });
    expect(result.disconnected).toBe(true);
    expect(result.finalPolls).toBe(result.pollsAfterJoinSuccessWait);
});

test('SocketClient ignores in-flight poll results after polling stops on reconnect', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { SocketClient } = await import('/assets/js/realtime/socketClient.js');
        const makeEmitter = () => {
            const handlers = new Map();
            return {
                on(name, handler) {
                    if (!handlers.has(name)) handlers.set(name, new Set());
                    handlers.get(name).add(handler);
                    return this;
                },
                off(name, handler) {
                    handlers.get(name)?.delete(handler);
                    return this;
                },
                emit() { return this; },
                trigger(name, payload) {
                    for (const handler of [...(handlers.get(name) || [])]) handler(payload);
                },
                disconnect() {}
            };
        };
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));
        const manager = makeEmitter();
        const socket = makeEmitter();
        socket.io = manager;
        const pending = [];
        const events = [];
        const client = new SocketClient({
            ioFactory: () => socket,
            poll: ({ reason }) => new Promise((resolve, reject) => {
                pending.push({ reason, resolve, reject });
            }),
            pollIntervalMs: 1000
        });
        client.addEventListener('polled', event => events.push({ type: 'polled', reason: event.detail.reason }));
        client.addEventListener('poll:error', event => events.push({ type: 'poll:error', reason: event.detail.reason }));

        client.connect();
        socket.trigger('connect');

        socket.trigger('disconnect');
        manager.trigger('reconnect');
        pending[0].resolve();
        await settle();
        const afterStaleSuccess = [...events];

        socket.trigger('disconnect');
        manager.trigger('reconnect');
        pending[1].reject(new Error('stale poll failure'));
        await settle();
        const afterStaleFailure = [...events];

        socket.trigger('disconnect');
        pending[2].resolve();
        await settle();
        const afterCurrentSuccess = [...events];

        client.destroy();
        return {
            pendingReasons: pending.map(item => item.reason),
            afterStaleSuccess,
            afterStaleFailure,
            afterCurrentSuccess
        };
    });

    expect(result.pendingReasons).toEqual(['disconnect', 'disconnect', 'disconnect']);
    expect(result.afterStaleSuccess).toEqual([]);
    expect(result.afterStaleFailure).toEqual([]);
    expect(result.afterCurrentSuccess).toEqual([{ type: 'polled', reason: 'disconnect' }]);
});

test('LocationClient uploads immediately after a stopped watch is started for a new tour', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { LocationClient } = await import('/assets/js/location/locationClient.js');
        let now = 1000;
        let nextWatchId = 1;
        const cleared = [];
        const uploads = [];
        const client = new LocationClient({
            clock: { now: () => now },
            geolocation: {
                watchPosition: () => nextWatchId++,
                clearWatch: id => cleared.push(id)
            },
            upload: async payload => { uploads.push({ now, payload }); return { accepted: true }; }
        });
        const position = {
            coords: { longitude: 114.35, latitude: 30.54, accuracy: 20 },
            timestamp: now
        };
        client.start('tour');
        await client.onPosition(position);
        client.stop();
        now = 1001;
        client.start('tour');
        await client.onPosition({ ...position, timestamp: now });
        client.destroy();
        return { uploadTimes: uploads.map(item => item.now), cleared };
    });

    expect(result.uploadTimes).toEqual([1000, 1001]);
    expect(result.cleared).toEqual([1, 2]);
});

test('LocationClient enforces 30-second uploads and handles low accuracy, 2102, and 2103', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { LocationClient } = await import('/assets/js/location/locationClient.js');
        let now = 0;
        let watchSuccess = null;
        let watchOptions = null;
        const cleared = [];
        const geolocation = {
            watchPosition(success, _failure, options) {
                watchSuccess = success;
                watchOptions = options;
                return 77;
            },
            clearWatch(id) {
                cleared.push(id);
            }
        };
        const uploads = [];
        const states = [];
        const rejected = [];
        const client = new LocationClient({
            geolocation,
            clock: { now: () => now },
            upload: async payload => {
                uploads.push({ at: now, ...payload });
                if (uploads.length === 2) return { accepted: false };
                if (uploads.length === 3) {
                    const error = new Error('定位精度过差');
                    error.code = 2103;
                    throw error;
                }
                if (uploads.length === 4) return { accepted: false, outOfFence: true };
                return { accepted: true };
            }
        });
        client.addEventListener('state', event => states.push(event.detail));
        client.addEventListener('upload:rejected', event => rejected.push(event.detail.code));
        const started = client.start('tour');

        const position = accuracy => ({
            coords: { longitude: 114.35, latitude: 30.54, accuracy },
            timestamp: now
        });
        await client.onPosition(position(20));
        now = 29999;
        await client.onPosition(position(150));
        now = 30000;
        await client.onPosition(position(150));
        now = 60000;
        await client.onPosition(position(20));
        now = 90000;
        await client.onPosition(position(20));
        now = 120000;
        await client.onPosition(position(20));

        const beforeDestroy = {
            watchId: client.watchId,
            stoppedByFence: client.stoppedByFence,
            uploadTimes: uploads.map(item => item.at),
            lowAccuracyStates: states.filter(item => item.state === 'low-accuracy').length,
            outOfFenceStates: states.filter(item => item.state === 'out-of-fence').length
        };
        client.destroy();

        return {
            started,
            hasWatchSuccess: typeof watchSuccess === 'function',
            watchOptions,
            cleared,
            rejected,
            beforeDestroy,
            uploadCount: uploads.length
        };
    });

    expect(result.started).toBe(true);
    expect(result.hasWatchSuccess).toBe(true);
    expect(result.watchOptions.enableHighAccuracy).toBe(true);
    expect(result.beforeDestroy.uploadTimes).toEqual([0, 30000, 60000, 90000]);
    expect(result.uploadCount).toBe(4);
    expect(result.rejected).toEqual([2103, 2103]);
    expect(result.beforeDestroy.lowAccuracyStates).toBeGreaterThanOrEqual(4);
    expect(result.beforeDestroy.outOfFenceStates).toBe(1);
    expect(result.beforeDestroy.watchId).toBeNull();
    expect(result.beforeDestroy.stoppedByFence).toBe(true);
    expect(result.cleared).toEqual([77]);
});
