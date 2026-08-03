'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const screenshotDir = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

test('completes plan, start, reroute acceptance, and refresh recovery', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const mapStartedAt = Date.now();
    await page.goto('/tour?demo=1');
    await expect(page.locator('#map-status-dot')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('#tour-map canvas')).toBeVisible();
    expect(Date.now() - mapStartedAt).toBeLessThan(3000);

    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.locator('#hours-range').fill('4');
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('heading', { name: '路线预览' })).toBeVisible();
    await expect(page.locator('#preview-badges').getByText('遮荫模式')).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '0');
    await page.screenshot({ path: path.join(screenshotDir, 'tour-route-preview.png'), fullPage: true });

    const proposalStartedAt = Date.now();
    await page.getByRole('button', { name: '开始游览' }).click();
    await expect(page.getByRole('heading', { name: /游览/ })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '1');
    await expect(page.getByText(/检测到临时封路/)).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeVisible({ timeout: 6000 });
    expect(Date.now() - proposalStartedAt).toBeLessThan(5000);
    await expect(page.locator('#proposal-reason')).toContainText('道路临时关闭');
    await expect(page.getByText(/新旧路线已标注/)).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, 'tour-reroute-proposal.png'), fullPage: true });

    const acceptedAt = Date.now();
    await page.getByRole('button', { name: '接受新路线' }).click();
    await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2');
    expect(Date.now() - acceptedAt).toBeLessThan(2000);

    await page.reload();
    await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2');
    expect(consoleErrors).toEqual([]);
});

test('renders photo spot detail and gated 3D entry', async ({ page }) => {
    await page.goto('/tour?demo=1');
    await page.getByRole('button', { name: '摄影机位' }).click();
    await expect(page.getByText('樱顶西望')).toBeVisible();
    await page.locator('.spot-row').filter({ hasText: '樱顶西望' }).getByRole('button', { name: '详情' }).click();
    await expect(page.getByText(/今日窗口：17:12/)).toBeVisible();
    await expect(page.getByText(/焦段建议：26mm/)).toBeVisible();
    await expect(page.getByText(/当前客流：较忙/)).toBeVisible();
    await expect(page.getByRole('button', { name: '打开三维场景' })).toBeEnabled();
    await page.screenshot({ path: path.join(screenshotDir, 'tour-photo-spot.png'), fullPage: true });
});

test('handles API errors, cancellation, empty crowd, 2102, and socket reconnect', async ({ page }) => {
    const errorCases = {
        auth401: [401, 1001], forbidden403: [403, 1003], conflict409: [409, 1203],
        rate429: [429, 2101], iserver8201: [500, 8201], iserver8202: [503, 8202],
        accessible8204: [400, 8204], proposal1204: [400, 1204], proposal1205: [400, 1205]
    };
    await page.route('**/api/test-error-*', route => {
        const key = new URL(route.request().url()).pathname.replace('/api/test-error-', '');
        const [status, code] = errorCases[key];
        return route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, code, data: { key }, message: `error-${code}` })
        });
    });
    await page.route('**/api/test-malformed', route => route.fulfill({
        status: 200, contentType: 'text/plain', body: 'not-json'
    }));
    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async cases => {
        const [{ ApiClient }, { MapFacade }, { routePresentation }, storeModule, locationModule, socketModule] = await Promise.all([
            import('/assets/js/api/client.js'),
            import('/assets/js/map/mapFacade.js'),
            import('/assets/js/map/styles.js'),
            import('/assets/js/state/tourStore.js'),
            import('/assets/js/location/locationClient.js'),
            import('/assets/js/realtime/socketClient.js')
        ]);
        const client = new ApiClient();
        const errors = {};
        for (const key of Object.keys(cases)) {
            try { await client.request(`/api/test-error-${key}`); } catch (error) {
                errors[key] = { status: error.status, code: error.code, retryable: error.retryable };
            }
        }
        let malformed;
        try { await client.request('/api/test-malformed'); } catch (error) {
            malformed = { status: error.status, message: error.message, retryable: error.retryable };
        }
        const cancelledPromise = client.request('/api/test-slow', { key: 'slow' }).catch(error => ({
            message: error.message, retryable: error.retryable
        }));
        setTimeout(() => client.cancel('slow'), 20);
        const cancelled = await cancelledPromise;

        const routeLabels = ['iserver', 'cache', 'local-fallback'].map(source => routePresentation({
            verifiedAccessible: false,
            gis: { source, mode: 'accessible', degraded: source !== 'iserver' }
        })).map(item => ({ label: item.label, accessibleVerified: item.accessibleVerified }));

        const facadeHost = document.createElement('div');
        facadeHost.style.cssText = 'width:320px;height:240px;position:fixed;left:-10000px;top:0';
        document.body.append(facadeHost);
        const facade = new MapFacade();
        await facade.init(facadeHost, {
            demo: true,
            center: [114.35, 30.54],
            extent: [114.34, 30.53, 114.37, 30.56],
            zoom: 15,
            minZoom: 13,
            maxZoom: 20,
            crs: 'EPSG:4326'
        });
        facade.setPois({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', geometry: { type: 'Point', coordinates: [114, 30] },
                properties: { poiId: 'poi-1', name: '测试点', category: '自然', status: 'approved' }
            }]
        });
        facade.setCrowd([{ poiId: 'poi-1', level: 'high' }]);
        facade.setCrowd([]);
        facade.destroy();
        facadeHost.remove();

        const emptyStore = new storeModule.TourStore({ heatmap: [{ poiId: 'old' }] });
        emptyStore.applyHeatmap({ items: [], lowConfidence: true });
        const expiredProposal = storeModule.currentProposal({
            pendingProposal: { proposalId: 'expired', expireAt: '2026-08-03T09:59:59Z' }
        }, new Date('2026-08-03T10:00:00Z').getTime());

        const originalGeo = navigator.geolocation;
        let clearedWatch = null;
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                watchPosition: success => {
                    queueMicrotask(() => success({
                        coords: { longitude: 114.35, latitude: 30.54, accuracy: 18 }, timestamp: Date.now()
                    }));
                    return 11;
                },
                clearWatch: id => { clearedWatch = id; }
            }
        });
        const location = new locationModule.LocationClient({ upload: async () => {
            const error = new Error('out of fence');
            error.code = 2102;
            throw error;
        } });
        const fenceState = await new Promise(resolve => {
            location.addEventListener('state', event => {
                if (event.detail.state === 'out-of-fence') resolve(event.detail.state);
            });
            location.start();
        });
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: originalGeo });

        const originalIo = window.io;
        const emitted = [];
        const makeEmitter = () => {
            const handlers = new Map();
            return {
                handlers,
                on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); return this; },
                trigger(name, payload) { for (const handler of handlers.get(name) || []) handler(payload); },
                emit(name, payload) { emitted.push({ name, payload }); return this; },
                removeAllListeners() { handlers.clear(); },
                disconnect() {}
            };
        };
        const manager = makeEmitter();
        const fakeSocket = { ...makeEmitter(), io: manager };
        window.io = () => fakeSocket;
        const socketStates = [];
        let reconnected = false;
        const socket = new socketModule.SocketClient({ scenicId: 'scenic-test' });
        socket.addEventListener('state', event => socketStates.push(event.detail.state));
        socket.addEventListener('reconnected', () => { reconnected = true; });
        socket.connect();
        fakeSocket.trigger('connect');
        fakeSocket.trigger('disconnect');
        manager.trigger('reconnect');
        fakeSocket.trigger('connect');
        const joinCount = emitted.filter(item => item.name === 'geosync:join').length;
        socket.destroy();
        window.io = originalIo;

        return {
            errors, malformed, cancelled, routeLabels,
            emptyHeatmapLength: emptyStore.getState().heatmap.length,
            emptyLowConfidence: emptyStore.getState().heatmapMeta.lowConfidence,
            expiredProposal, fenceState, clearedWatch,
            socketStates, reconnected, joinCount
        };
    }, errorCases);

    for (const [key, [status, code]] of Object.entries(errorCases)) {
        expect(result.errors[key]).toEqual({ status, code, retryable: status === 429 || status >= 500 });
    }
    expect(result.malformed).toEqual({ status: 200, message: '服务返回了无法识别的数据', retryable: false });
    expect(result.cancelled).toEqual({ message: '请求已取消', retryable: false });
    expect(result.routeLabels).toEqual([
        { label: 'iServer 路线', accessibleVerified: false },
        { label: '缓存结果', accessibleVerified: false },
        { label: '离线路线', accessibleVerified: false }
    ]);
    expect(result.emptyHeatmapLength).toBe(0);
    expect(result.emptyLowConfidence).toBe(true);
    expect(result.expiredProposal).toBeNull();
    expect(result.fenceState).toBe('out-of-fence');
    expect(result.clearedWatch).toBe(11);
    expect(result.socketStates).toEqual(['connected', 'reconnecting', 'connected']);
    expect(result.reconnected).toBe(true);
    expect(result.joinCount).toBe(2);
});

test('does not reopen an expired proposal after refresh', async ({ page }) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('geosync:demo-itinerary', JSON.stringify({
            itineraryId: 'expired-demo', version: 6, state: 'active', currentStopId: 'stop-1',
            stops: [{ stopId: 'stop-1', poiId: 'poi_photo', poiName: '樱顶摄影点', state: 'approaching' }],
            route: {
                geometry: { type: 'LineString', coordinates: [[114.3518, 30.5374], [114.3558, 30.5404]] },
                distanceM: 420, durationSec: 360,
                gis: { source: 'iserver', mode: 'normal', degraded: false }
            },
            pendingProposal: {
                proposalId: 'expired-proposal', reason: '已过期建议',
                expireAt: new Date(Date.now() - 60000).toISOString()
            }
        }));
    });
    await page.goto('/tour?demo=1');
    await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '6');
});

test('maps API failures and preserves version discipline in browser modules', async ({ page }) => {
    await page.route('**/api/test-429', route => route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 2101, data: null, message: '请求过频' })
    }));
    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async () => {
        const [{ ApiClient }, { TourStore }, { routePresentation }, { MapFacade }, proposalClock, locationModule, socketModule] = await Promise.all([
            import('/assets/js/api/client.js'),
            import('/assets/js/state/tourStore.js'),
            import('/assets/js/map/styles.js'),
            import('/assets/js/map/mapFacade.js'),
            import('/assets/js/state/proposalClock.js'),
            import('/assets/js/location/locationClient.js'),
            import('/assets/js/realtime/socketClient.js')
        ]);
        const client = new ApiClient();
        let apiError;
        try { await client.request('/api/test-429'); } catch (error) {
            apiError = { code: error.code, status: error.status, retryable: error.retryable };
        }
        const store = new TourStore({ itinerary: { version: 4 } });
        const versions = [store.hasNewerVersion(5), store.hasNewerVersion(4), store.hasNewerVersion(3)];
        const fallback = routePresentation({
            verifiedAccessible: false,
            gis: { source: 'local-fallback', mode: 'accessible', degraded: true }
        });
        const savedSdk = window.maplibregl;
        delete window.maplibregl;
        let mapErrorCode;
        let mapErrorDetail;
        try {
            const host = document.createElement('div');
            document.body.append(host);
            const mapFacade = new MapFacade();
            mapFacade.addEventListener('map:error', event => { mapErrorDetail = event.detail; }, { once: true });
            await mapFacade.init(host, {
                mapUrl: '/fake', center: [114, 30], extent: [113, 29, 115, 31],
                zoom: 15, minZoom: 13, maxZoom: 20, crs: 'EPSG:4326'
            });
        } catch (error) {
            mapErrorCode = error.code;
        } finally {
            window.maplibregl = savedSdk;
        }
        const clock = {
            active: proposalClock.formatProposalCountdown('2026-08-03T10:01:05Z', new Date('2026-08-03T10:00:00Z').getTime()),
            expired: proposalClock.isProposalExpired('2026-08-03T09:59:59Z', new Date('2026-08-03T10:00:00Z').getTime())
        };
        const originalGeo = navigator.geolocation;
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                watchPosition: (_ok, fail) => { queueMicrotask(() => fail({ code: 1, message: 'denied' })); return 7; },
                clearWatch: () => {}
            }
        });
        const location = new locationModule.LocationClient();
        const locationState = await new Promise(resolve => {
            location.addEventListener('state', event => {
                if (event.detail.state === 'denied') resolve(event.detail.state);
            });
            location.start();
        });
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: originalGeo });
        const socket = new socketModule.SocketClient({ scenicId: 'demo', demo: true });
        const socketState = await new Promise(resolve => {
            socket.addEventListener('state', event => resolve(event.detail.state), { once: true });
            socket.connect();
        });
        socket.disconnect();
        return { apiError, versions, fallback, mapErrorCode, mapErrorDetail, clock, locationState, socketState };
    });
    expect(result.apiError).toEqual({ code: 2101, status: 429, retryable: true });
    expect(result.versions).toEqual([true, false, false]);
    expect(result.fallback.label).toBe('离线路线');
    expect(result.fallback.accessibleVerified).toBe(false);
    expect(result.mapErrorCode).toBe('MAP_SDK_LOAD_FAILED');
    expect(result.mapErrorDetail).toEqual({ code: 'MAP_SDK_LOAD_FAILED', message: 'SuperMap iClient 未加载' });
    expect(result.clock).toEqual({ active: '1:05', expired: true });
    expect(result.locationState).toBe('denied');
    expect(result.socketState).toBe('connected');
});

for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 }
]) {
    test(`fits viewport ${viewport.width}x${viewport.height} without overflow`, async ({ browser }) => {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.goto('/tour?demo=1');
        await expect(page.locator('#map-status-dot')).toHaveAttribute('data-state', 'online');
        const layout = await page.evaluate(() => ({
            bodyWidth: document.body.scrollWidth,
            viewportWidth: window.innerWidth,
            appHeight: document.getElementById('tour-app').getBoundingClientRect().height,
            viewportHeight: window.innerHeight,
            canvasWidth: document.querySelector('#tour-map canvas')?.getBoundingClientRect().width || 0,
            canvasHeight: document.querySelector('#tour-map canvas')?.getBoundingClientRect().height || 0
        }));
        expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
        expect(layout.appHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
        expect(layout.canvasWidth).toBeGreaterThan(100);
        expect(layout.canvasHeight).toBeGreaterThan(100);
        await page.screenshot({
            path: path.join(screenshotDir, `tour-${viewport.width}x${viewport.height}.png`),
            fullPage: true
        });
        if (viewport.width === 390) {
            const scaled = await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
                const longest = '路线调整建议已失效，正在重新同步最新的行程、预计到达时间和完整时刻表';
                const toast = document.getElementById('toast');
                toast.textContent = longest;
                toast.classList.remove('hidden');
                const rect = toast.getBoundingClientRect();
                return {
                    bodyWidth: document.body.scrollWidth,
                    viewportWidth: window.innerWidth,
                    toastLeft: rect.left,
                    toastRight: rect.right
                };
            });
            expect(scaled.bodyWidth).toBeLessThanOrEqual(scaled.viewportWidth);
            expect(scaled.toastLeft).toBeGreaterThanOrEqual(0);
            expect(scaled.toastRight).toBeLessThanOrEqual(scaled.viewportWidth);
        }
        await context.close();
    });
}
