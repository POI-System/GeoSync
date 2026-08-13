'use strict';

const { test, expect } = require('@playwright/test');

test('ApiClient preserves null data, safe errors, success codes, timeout, cancellation, and proposal refresh', async ({ page }) => {
    const fullItinerary = {
        itineraryId: 'it-1', version: 8, state: 'active', stops: [], route: null, pendingProposal: null
    };
    await page.route('**/api/module-*', route => {
        const path = new URL(route.request().url()).pathname;
        const responses = {
            '/api/module-null': [200, { success: true, code: 0, data: null, message: '' }],
            '/api/module-2102': [200, { success: true, code: 2102, data: { accepted: false, outOfFence: true }, message: '' }],
            '/api/module-2103': [200, { success: true, code: 2103, data: { accepted: false }, message: 'raw server text' }],
            '/api/module-401': [401, { success: false, code: 1001, data: null, message: '<script>unsafe</script>' }],
            '/api/module-403': [403, { success: false, code: 1003, data: null, message: 'private detail' }],
            '/api/module-409': [409, { success: false, code: 1203, data: null, message: 'private detail' }],
            '/api/module-429': [429, { success: false, code: 2101, data: null, message: 'private detail' }],
            '/api/module-500': [500, { success: false, code: 9001, data: null, message: 'stack trace' }],
            '/api/module-8203': [422, { success: false, code: 8203, data: null, message: 'internal gis detail' }],
            '/api/module-8204': [422, { success: false, code: 8204, data: null, message: 'internal gis detail' }],
            '/api/module-8205': [409, { success: false, code: 8205, data: null, message: 'internal gis detail' }],
            '/api/module-8206': [502, { success: false, code: 8206, data: null, message: 'internal gis detail' }]
        };
        const [status, body] = responses[path];
        return route.fulfill({
            status,
            headers: { 'content-type': 'application/json', 'x-request-id': `request-${status}` },
            body: JSON.stringify(body)
        });
    });
    await page.route('**/api/module-malformed', route => route.fulfill({
        status: 200, contentType: 'text/plain', body: 'not-json'
    }));
    await page.route('**/api/itinerary/it-1/proposal/p-1/reject', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, code: 0, data: { version: 8 }, message: '' })
    }));
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, code: 0, data: fullItinerary, message: '' })
    }));
    await page.route('**/api/itinerary/missing', route => route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 1204, data: null, message: 'private detail' })
    }));
    let abandonBody = null;
    await page.route('**/api/itinerary/it-1/abandon', async route => {
        abandonBody = route.request().postDataJSON();
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                code: 0,
                data: { ...fullItinerary, state: 'abandoned', version: 9 },
                message: ''
            })
        });
    });

    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async () => {
        const { ApiClient, ENDPOINTS } = await import('/assets/js/api/client.js');
        const client = new ApiClient();
        const nullData = await client.request('/api/module-null');
        const code2102 = await client.request('/api/module-2102');
        const code2103 = await client.request('/api/module-2103');
        const errors = {};
        for (const key of ['401', '403', '409', '429', '500', '8203', '8204', '8205', '8206']) {
            try {
                await client.request(`/api/module-${key}`);
            } catch (error) {
                errors[key] = {
                    name: error.name,
                    category: error.category,
                    httpStatus: error.httpStatus,
                    status: error.status,
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                    requestId: error.requestId,
                    causeSummary: error.causeSummary
                };
            }
        }
        let malformed;
        try {
            await client.request('/api/module-malformed');
        } catch (error) {
            malformed = { category: error.category, message: error.message, causeSummary: error.causeSummary };
        }
        let timeout;
        try {
            await client.request('/api/test-slow', { key: 'module-timeout', timeoutMs: 25 });
        } catch (error) {
            timeout = { category: error.category, retryable: error.retryable, message: error.message };
        }
        const cancelledPromise = client.request('/api/test-slow', { key: 'module-cancel' }).catch(error => ({
            category: error.category, retryable: error.retryable, message: error.message
        }));
        client.cancel('module-cancel');
        const cancelled = await cancelledPromise;
        const rejected = await client.rejectProposal('it-1', 'p-1', 7);
        const abandoned = await client.abandonItinerary('it-1', 8);
        let detailError;
        try {
            await client.getItinerary('missing');
        } catch (error) {
            detailError = {
                category: error.category,
                httpStatus: error.httpStatus,
                code: error.code,
                message: error.message
            };
        }
        client.destroy();
        return {
            nullData,
            code2102,
            code2103,
            errors,
            malformed,
            timeout,
            cancelled,
            rejected,
            abandoned,
            detailError,
            endpoints: {
                currentItinerary: ENDPOINTS.currentItinerary,
                itineraryDetail: ENDPOINTS.itineraryDetail('it 1')
            }
        };
    });

    expect(result.nullData).toBeNull();
    expect(result.code2102).toMatchObject({ accepted: false, outOfFence: true, code: 2102, message: '已离开景区范围' });
    expect(result.code2103).toMatchObject({ accepted: false, code: 2103, message: '定位精度较低' });
    expect(result.errors['401']).toMatchObject({ name: 'ApiError', category: 'authentication', httpStatus: 401, status: 401, retryable: false });
    expect(result.errors['403'].category).toBe('authorization');
    expect(result.errors['409']).toMatchObject({ category: 'conflict', code: 1203 });
    expect(result.errors['429']).toMatchObject({ category: 'rate_limit', retryable: true });
    expect(result.errors['500']).toMatchObject({ category: 'server', retryable: true });
    expect(result.errors['8203']).toMatchObject({
        category: 'business', code: 8203, retryable: false,
        message: '起点或终点无法连接步行路网，请调整起点后重试'
    });
    expect(result.errors['8204']).toMatchObject({ category: 'business', code: 8204, message: '当前路线模式没有可达路径' });
    expect(result.errors['8205']).toMatchObject({
        category: 'conflict', code: 8205, retryable: false,
        message: '地图服务契约或数据版本不一致，请刷新配置后重试'
    });
    expect(result.errors['8206']).toMatchObject({
        category: 'server', code: 8206, retryable: false,
        message: '地图返回的路线几何无效，未显示该路线'
    });
    expect(Object.values(result.errors).every(item => !item.message.includes('private') && !item.message.includes('script') && !item.message.includes('stack'))).toBe(true);
    expect(result.errors['401'].requestId).toBe('request-401');
    expect(result.malformed).toMatchObject({ category: 'response', message: '服务返回了无法识别的数据', causeSummary: 'SyntaxError' });
    expect(result.timeout).toEqual({ category: 'timeout', retryable: true, message: '请求超时，请稍后重试' });
    expect(result.cancelled).toEqual({ category: 'cancelled', retryable: false, message: '请求已取消' });
    expect(result.rejected).toEqual(fullItinerary);
    expect(result.abandoned).toEqual({ ...fullItinerary, state: 'abandoned', version: 9 });
    expect(abandonBody).toEqual({ version: 8 });
    expect(result.detailError).toEqual({
        category: 'business',
        httpStatus: 404,
        code: 1204,
        message: '行程不存在或已失效'
    });
    expect(result.endpoints.currentItinerary).toBe('/api/itinerary/current');
    expect(result.endpoints.itineraryDetail).toBe('/api/itinerary/it%201');
});

test('ApiClient keeps concurrent current reads alive for coordinated recovery', async ({ page }) => {
    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async () => {
        const { ApiClient } = await import('/assets/js/api/client.js');
        const pending = [];
        const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
            const request = {
                aborted: false,
                resolve(version) {
                    resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        text: async () => JSON.stringify({
                            success: true,
                            code: 0,
                            data: {
                                itineraryId: `it-${version}`,
                                version,
                                state: 'active',
                                stops: [],
                                route: null,
                                pendingProposal: null
                            },
                            message: ''
                        })
                    });
                }
            };
            signal.addEventListener('abort', () => {
                request.aborted = true;
                reject(new DOMException('cancelled', 'AbortError'));
            }, { once: true });
            pending.push(request);
        });
        const client = new ApiClient({ fetchImpl });
        const first = client.getCurrentItinerary().then(value => value.version, error => error.category);
        const second = client.getCurrentItinerary().then(value => value.version, error => error.category);
        await Promise.resolve();
        pending[1].resolve(2);
        pending[0].resolve(1);
        const values = await Promise.all([first, second]);
        const aborted = pending.map(request => request.aborted);
        client.destroy();
        return { values, aborted };
    });

    expect(result.values).toEqual([1, 2]);
    expect(result.aborted).toEqual([false, false]);
});

test('DemoApiClient uses external fixtures, validates versions, supports scenarios, and cancels', async ({ page }) => {
    const fixtureRequests = [];
    page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/assets/mock/')) fixtureRequests.push(pathname);
    });
    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async () => {
        sessionStorage.removeItem('geosync:demo-itinerary');
        const { DemoApiClient, demoClosedEdge, demoProposal } = await import('/assets/js/api/demoClient.js');
        const demo = new DemoApiClient();
        const [config, boundary, pois, heatmap, closedEdges] = await Promise.all([
            demo.getClientConfig(), demo.getBoundary(), demo.getPois(), demo.getHeatmap(), demo.getClosedEdges()
        ]);
        const planned = await demo.planItinerary({ hours: 4, interests: ['摄影'], pace: 'normal', accessible: false, shadeFirst: true });
        const poiById = new Map(pois.map(poi => [poi.id, [poi.lng, poi.lat]]));
        const directPoiCoordinates = [poiById.get('poi_gate'), ...planned.stops.map(stop => poiById.get(stop.poiId))];
        let versionError;
        try {
            await demo.startItinerary(planned.itineraryId, planned.version + 1);
        } catch (error) {
            versionError = error.code;
        }
        const started = await demo.startItinerary(planned.itineraryId, planned.version);
        const topologyProposal = await demoProposal(started.version, demo);
        demo.setProposal(topologyProposal);
        demo.setScenario('proposal', 1205);
        let proposalError;
        try {
            await demo.acceptProposal(started.itineraryId, 'demo_proposal', started.version);
        } catch (error) {
            proposalError = error.code;
        }
        demo.clearScenario('proposal');
        const rejected = await demo.rejectProposal(started.itineraryId, 'demo_proposal', started.version);
        const abandoned = await demo.abandonItinerary(rejected.itineraryId, rejected.version);
        demo.setScenario('position', 2103);
        const position = await demo.reportPosition({ lng: 114.35, lat: 30.54 });
        const planErrors = {};
        for (const code of [8201, 8202, 8203, 8204, 8205, 8206]) {
            demo.setScenario('plan', code);
            try {
                await demo.plan({ hours: 4 });
            } catch (error) {
                planErrors[code] = { code: error.code, category: error.category, retryable: error.retryable };
            }
        }
        demo.clearScenario();
        let accessibleTopologyError;
        try {
            await demo.plan({ hours: 4, accessible: true });
        } catch (error) {
            accessibleTopologyError = {
                code: error.code,
                httpStatus: error.httpStatus,
                retryable: error.retryable
            };
        }
        const unreachableDemo = new DemoApiClient({ storage: null });
        const unreachableTopology = await unreachableDemo.topology();
        for (const edge of unreachableTopology.network.edges) {
            unreachableDemo.applyGraphEvent({ edgeId: edge.id, status: 'closed' });
        }
        let normalTopologyError;
        try {
            await unreachableDemo.plan({ hours: 4, accessible: false, shadeFirst: false });
        } catch (error) {
            normalTopologyError = {
                code: error.code,
                httpStatus: error.httpStatus,
                retryable: error.retryable
            };
        }
        unreachableDemo.destroy();
        const pending = demo.plan({ hours: 4 }).catch(error => ({ category: error.category }));
        demo.cancel('plan');
        const cancelled = await pending;
        const barrierDemo = new DemoApiClient({ storage: null });
        const initialClosedEdges = await barrierDemo.getClosedEdges();
        const appliedClosedEdges = barrierDemo.applyGraphEvent(demoClosedEdge());
        const closedEdgesAfterEvent = await barrierDemo.getClosedEdges();
        const plannedAfterBarrier = await barrierDemo.plan({
            hours: 4, interests: ['摄影'], pace: 'normal', accessible: false, shadeFirst: true
        });
        barrierDemo.destroy();
        demo.destroy();
        return {
            config, boundaryType: boundary.type, poiCount: pois.length,
            firstSuggestedStayMin: pois[0]?.suggestedStayMin,
            heatmapCount: heatmap.items.length, closedCount: closedEdges.items.length,
            planned, directPoiCoordinates, topologyProposal, closedEdge: demoClosedEdge(),
            versionError, proposalError, rejected, abandoned, position, planErrors,
            accessibleTopologyError, normalTopologyError, cancelled,
            initialClosedEdges, appliedClosedEdges,
            closedEdgesAfterEvent, plannedAfterBarrier
        };
    });

    expect(result.config.scenicId).toBe('whu_demo');
    expect(result.boundaryType).toBe('FeatureCollection');
    expect(result.poiCount).toBe(5);
    expect(result.firstSuggestedStayMin).toBe(10);
    expect(result.heatmapCount).toBe(5);
    expect(result.closedCount).toBe(0);
    expect(result.planned.route.gis.mode).toBe('shade');
    expect(result.planned.route.gis.source).toBe('demo-topology');
    expect(result.planned.route.gis.degraded).toBe(true);
    expect(result.planned.route.geometry.coordinates.length).toBeGreaterThan(result.planned.stops.length + 1);
    expect(result.planned.route.geometry.coordinates).not.toEqual(result.directPoiCoordinates);
    expect(result.planned.route.sourceEdgeIds).toContain('7');
    expect(result.planned.route.segments.length).toBeGreaterThan(result.planned.stops.length);
    expect(result.planned.route.segments.every(segment => segment.sourceEdgeIds.length > 0)).toBe(true);
    expect(result.topologyProposal.beforeRoute.gis.source).toBe('demo-topology');
    expect(result.topologyProposal.afterRoute.gis.source).toBe('demo-topology');
    expect(result.topologyProposal).toMatchObject({ eventId: 'demo_barrier', edgeId: '7' });
    expect(result.topologyProposal.beforeRoute.sourceEdgeIds).toContain('7');
    expect(result.topologyProposal.afterRoute.sourceEdgeIds).not.toContain('7');
    expect(result.closedEdge.edgeId).toBe('7');
    expect(result.closedEdge.eventId).toBe(result.topologyProposal.eventId);
    expect(result.closedEdge.edgeId).toBe(result.topologyProposal.beforeRoute.sourceEdgeIds.find(edgeId => edgeId === '7'));
    expect(result.topologyProposal.afterRoute.geometry).not.toEqual(result.topologyProposal.beforeRoute.geometry);
    expect(result.topologyProposal.afterRoute.durationSec).toBeGreaterThan(result.topologyProposal.beforeRoute.durationSec);
    expect(result.initialClosedEdges.items).toEqual([]);
    expect(result.appliedClosedEdges.items).toEqual([expect.objectContaining({ edgeId: '7', status: 'closed' })]);
    expect(result.closedEdgesAfterEvent).toEqual(result.appliedClosedEdges);
    expect(result.plannedAfterBarrier.route.sourceEdgeIds).not.toContain('7');
    expect(result.plannedAfterBarrier.route.geometry).toEqual(result.topologyProposal.afterRoute.geometry);
    expect(result.plannedAfterBarrier.route.geometry).not.toEqual(result.planned.route.geometry);
    expect(result.versionError).toBe(1203);
    expect(result.proposalError).toBe(1205);
    expect(result.rejected).toMatchObject({ state: 'active', version: 2, pendingProposal: null });
    expect(result.abandoned).toMatchObject({ state: 'abandoned', version: 3, pendingProposal: null });
    expect(result.position).toMatchObject({ accepted: false, code: 2103 });
    expect(result.planErrors['8201']).toEqual({ code: 8201, category: 'server', retryable: true });
    expect(result.planErrors['8202']).toEqual({ code: 8202, category: 'server', retryable: true });
    expect(result.planErrors['8203']).toEqual({ code: 8203, category: 'business', retryable: false });
    expect(result.planErrors['8204']).toEqual({ code: 8204, category: 'business', retryable: false });
    expect(result.planErrors['8205']).toEqual({ code: 8205, category: 'conflict', retryable: false });
    expect(result.planErrors['8206']).toEqual({ code: 8206, category: 'server', retryable: false });
    expect(result.accessibleTopologyError).toEqual({ code: 8204, httpStatus: 422, retryable: false });
    expect(result.normalTopologyError).toEqual({ code: 8204, httpStatus: 422, retryable: false });
    expect(result.cancelled).toEqual({ category: 'cancelled' });
    expect(fixtureRequests).toContain('/assets/mock/itinerary.json');
    expect(fixtureRequests).toContain('/assets/mock/demo-walk-network.json');
    expect(fixtureRequests).not.toContain('/assets/mock/routes.json');
});

test('MapFacade adapter covers strict lifecycle, route compatibility, styles, events, and cleanup', async ({ page }) => {
    await page.goto('/tour?demo=1');
    const result = await page.evaluate(async () => {
        const [{ MapFacade, routeGeometry }, layersModule, stylesModule] = await Promise.all([
            import('/assets/js/map/mapFacade.js'),
            import('/assets/js/map/layers.js'),
            import('/assets/js/map/styles.js')
        ]);
        const { installSourcesAndLayers } = layersModule;

        class FakeMap {
            constructor(name) {
                this.name = name;
                this.sources = new Map();
                this.layers = new Map();
                this.images = new Set();
                this.handlers = [];
                this.paintUpdates = [];
                this.removed = false;
                this.fitCalls = [];
                this.failNextFit = false;
                this.easeCalls = [];
                this.canvas = { style: {} };
            }
            loaded() { return true; }
            getSource(id) { return this.sources.get(id); }
            addSource(id, spec) {
                const source = {
                    data: spec.data,
                    updates: 0,
                    setData(value) { this.data = value; this.updates += 1; }
                };
                this.sources.set(id, source);
            }
            getLayer(id) { return this.layers.get(id); }
            addLayer(layer) { this.layers.set(layer.id, structuredClone(layer)); }
            getStyle() { return { glyphs: '/assets/vendor/fonts/{fontstack}/{range}.pbf' }; }
            hasImage(id) { return this.images.has(id); }
            addImage(id) { this.images.add(id); }
            on(event, layerOrHandler, maybeHandler) {
                const layer = maybeHandler ? layerOrHandler : null;
                const handler = maybeHandler || layerOrHandler;
                this.handlers.push({ event, layer, handler });
            }
            once(event, handler) { this.on(event, handler); }
            off(event, layerOrHandler, maybeHandler) {
                const layer = maybeHandler ? layerOrHandler : null;
                const handler = maybeHandler || layerOrHandler;
                this.handlers = this.handlers.filter(item => !(item.event === event && item.layer === layer && item.handler === handler));
            }
            trigger(event, payload, layer = null) {
                for (const item of [...this.handlers]) {
                    if (item.event === event && item.layer === layer) item.handler(payload);
                }
            }
            getCanvas() { return this.canvas; }
            setPaintProperty(layer, property, value) { this.paintUpdates.push({ layer, property, value }); }
            fitBounds(bounds, options) {
                if (this.failNextFit) {
                    this.failNextFit = false;
                    throw new Error('fit failed');
                }
                this.fitCalls.push({ bounds, options });
            }
            easeTo(options) { this.easeCalls.push(options); }
            getZoom() { return 15; }
            resize() {}
            remove() { this.removed = true; }
        }

        class FakeResizeObserver {
            constructor(callback) { this.callback = callback; this.disconnected = false; FakeResizeObserver.instances.push(this); }
            observe(target) { this.target = target; }
            disconnect() { this.disconnected = true; }
        }
        FakeResizeObserver.instances = [];

        let notReadyCode;
        try {
            new MapFacade().setPois({ type: 'FeatureCollection', features: [] });
        } catch (error) {
            notReadyCode = error.code;
        }

        const maps = [];
        const facade = new MapFacade({
            adapter: { init: () => ({ map: maps[maps.push(new FakeMap(`map-${maps.length + 1}`)) - 1] }) },
            ResizeObserver: FakeResizeObserver,
            timeoutMs: 100
        });
        const host = document.createElement('div');
        document.body.append(host);
        const config = {
            mapUrl: '/fake-map', center: [114.3592, 30.541], extent: [114.3468, 30.5332, 114.3722, 30.5486],
            zoom: 15, minZoom: 13, maxZoom: 20, crs: 'EPSG:4326'
        };

        const pendingMap = new FakeMap('pending-map');
        pendingMap.loaded = () => false;
        const pendingFacade = new MapFacade({
            adapter: { init: () => ({ map: pendingMap }) },
            ResizeObserver: FakeResizeObserver,
            timeoutMs: 100
        });
        const pendingInit = pendingFacade.init(host, config);
        await new Promise(resolve => setTimeout(resolve, 0));
        const readyDuringLoad = pendingFacade.isReady();
        let updateDuringLoadCode;
        try {
            pendingFacade.setPois({ type: 'FeatureCollection', features: [] });
        } catch (error) {
            updateDuringLoadCode = error.code;
        }
        pendingMap.trigger('load', {});
        await pendingInit;
        const readyAfterLoad = pendingFacade.isReady();
        pendingFacade.destroy();

        await facade.init(host, config);
        const first = maps[0];
        const firstObserver = FakeResizeObserver.instances.at(-1);
        const countsBeforeReinstall = { sources: first.sources.size, layers: first.layers.size };
        const layerAccess = installSourcesAndLayers(first);
        const countsAfterReinstall = { sources: first.sources.size, layers: first.layers.size };
        const poiLabelLayer = [...first.layers.values()].find(layer =>
            layer.type === 'symbol' && layer.layout?.['text-field']);
        const poiCrowdEntry = [...first.layers.entries()].find(([, layer]) =>
            layer.type === 'circle' && JSON.stringify(layer.filter || []).includes('status'));
        const closedLabelFilter = poiLabelLayer.filter;
        const poiSource = first.sources.get(poiCrowdEntry[1].source);

        facade.setBoundary({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { name: '验收范围' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[114.34, 30.53], [114.37, 30.53], [114.37, 30.55], [114.34, 30.55], [114.34, 30.53]]]
                }
            }]
        });
        const boundarySnapshot = structuredClone(layerAccess.getSource('boundary').data);
        facade.setUserLocation({ lng: 114.351, lat: 30.541, accuracy: 24 });
        const userSnapshot = structuredClone(layerAccess.getSource('user').data);
        facade.setUserLocation({ lng: 999, lat: 999 });
        const invalidUserFeatureCount = layerAccess.getSource('user').data.features.length;
        facade.setClosedEdges([
            {
                edgeId: 'edge-1', status: 'closed', reason: '施工',
                geometry: { type: 'LineString', coordinates: [[114.35, 30.54], [114.351, 30.541]] }
            },
            {
                edgeId: 'edge-2', status: 'closed', reason: '积水',
                geometry: { type: 'LineString', coordinates: [[114.352, 30.542], [114.353, 30.543]] }
            }
        ]);
        facade.selectEdge('edge-2');
        const closedEdgesSnapshot = structuredClone(layerAccess.getSource('closedEdges').data);
        facade.setConnectionState('reconnecting');
        const connectionState = host.dataset.connectionState;
        const easeCallsBeforeDirectFit = first.easeCalls.length;
        facade.fitToGeometry({ type: 'Point', coordinates: [114.354, 30.544] });
        const directFitEase = first.easeCalls.at(-1);
        const directFitUsedEase = first.easeCalls.length === easeCallsBeforeDirectFit + 1;

        const poi = {
            type: 'Feature', geometry: { type: 'Point', coordinates: [114.35, 30.54] },
            properties: { poiId: 'poi-1', name: '测试点', category: '自然', status: 'approved' }
        };
        facade.setPois({ type: 'FeatureCollection', features: [poi] });
        facade.setCrowd({ lowConfidence: true, items: [{ poiId: 'poi-1', level: 'medium' }] });
        const crowdSnapshot = structuredClone(poiSource.data);
        const layerCountBeforeSingleUpdate = first.layers.size;
        facade.setCrowd({ poiId: 'poi-1', level: 'high', lowConfidence: false });
        const crowdAfterSingle = structuredClone(poiSource.data);
        const layerCountAfterSingleUpdate = first.layers.size;
        facade.setPois([{
            id: 'poi-api-1', poiName: '接口景点', category: '摄影', status: 'approved',
            location: { lng: 114.352, lat: 30.542 }
        }]);
        const apiPoiCollection = structuredClone(poiSource.data);
        facade.setPois({ type: 'FeatureCollection', features: [poi] });

        let selected;
        facade.addEventListener('poi:selected', event => { selected = event.detail; }, { once: true });
        first.trigger('click', { features: [poi] }, poiCrowdEntry[0]);

        const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
        const decoded = routeGeometry({ pathGeometry: encoded });
        const routeBefore = {
            geometry: { type: 'LineString', coordinates: [[114.35, 30.54], [114.36, 30.545]] },
            distanceM: 500, durationSec: 420,
            gis: { source: 'cache', mode: 'normal', degraded: true }
        };
        const routeAfter = {
            pathGeometry: encoded,
            distanceM: 620, durationSec: 390, reason: '封路绕行',
            gis: { source: 'local-fallback', mode: 'accessible', degraded: true },
            verifiedAccessible: false
        };
        const presentation = facade.setRoute(routeAfter, { fit: false });
        let comparisonEvent;
        facade.addEventListener('route:compared', event => { comparisonEvent = event.detail; }, { once: true });
        const comparison = facade.compareRoutes(routeBefore, routeAfter);
        const routeOpacityDuringComparison = first.paintUpdates
            .filter(update => update.property === 'line-opacity')
            .at(-1)?.value;
        const comparisonFeatureCounts = [
            layerAccess.getSource('routeOld').data.features.length,
            layerAccess.getSource('routeNew').data.features.length
        ];
        facade.clearRouteComparison();
        const routeOpacityAfterClear = first.paintUpdates
            .filter(update => update.property === 'line-opacity')
            .at(-1)?.value;
        const clearedComparisonFeatureCounts = [
            layerAccess.getSource('routeOld').data.features.length,
            layerAccess.getSource('routeNew').data.features.length
        ];
        const mainRouteFeatureCountAfterClear = layerAccess.getSource('route').data.features.length;
        const missingMetricComparison = facade.compareRoutes(
            { ...routeBefore, distanceM: null, durationSec: undefined },
            { ...routeAfter, distanceM: undefined, durationSec: null }
        );
        facade.clearRouteComparison();

        const mapErrors = [];
        facade.addEventListener('map:error', event => mapErrors.push(event.detail));
        first.failNextFit = true;
        let comparisonFailureCode;
        try {
            facade.compareRoutes(routeBefore, routeAfter);
        } catch (error) {
            comparisonFailureCode = error.code;
        }
        const routeOpacityAfterComparisonFailure = first.paintUpdates
            .filter(update => update.property === 'line-opacity')
            .at(-1)?.value;
        const failedComparisonFeatureCounts = [
            layerAccess.getSource('routeOld').data.features.length,
            layerAccess.getSource('routeNew').data.features.length
        ];
        first.trigger('error', { error: new Error('tile failed') });
        let invalidRouteCode;
        try {
            facade.setRoute({ geometry: { type: 'Polygon', coordinates: [] } });
        } catch (error) {
            invalidRouteCode = error.code;
        }

        await facade.init(host, config);
        const second = maps[1];
        const secondObserver = FakeResizeObserver.instances.at(-1);
        const firstRemovedOnReinit = first.removed;
        const firstObserverDisconnected = firstObserver.disconnected;
        const readyAfterReinit = facade.isReady();
        facade.destroy();

        let timeoutError;
        let timeoutEvent;
        const timeoutFacade = new MapFacade({
            adapter: { init: () => new Promise(() => {}) },
            timeoutMs: 20
        });
        timeoutFacade.addEventListener('map:error', event => { timeoutEvent = event.detail; });
        try {
            await timeoutFacade.init(host, config);
        } catch (error) {
            timeoutError = { code: error.code, message: error.message };
        }

        let resolveLateMap;
        const lateMap = new FakeMap('late-timeout-map');
        const lateFacade = new MapFacade({
            adapter: { init: () => new Promise(resolve => { resolveLateMap = resolve; }) },
            timeoutMs: 20
        });
        const lateInit = lateFacade.init(host, config).catch(error => error.code);
        await new Promise(resolve => setTimeout(resolve, 30));
        resolveLateMap({ map: lateMap });
        const lateErrorCode = await lateInit;
        await new Promise(resolve => setTimeout(resolve, 0));

        let resolveDestroyedMap;
        const destroyedMap = new FakeMap('destroyed-pending-map');
        const destroyedFacade = new MapFacade({
            adapter: { init: () => new Promise(resolve => { resolveDestroyedMap = resolve; }) },
            timeoutMs: 1000
        });
        const destroyedInit = destroyedFacade.init(host, config).catch(error => error.code);
        await Promise.resolve();
        destroyedFacade.destroy();
        resolveDestroyedMap({ map: destroyedMap });
        const destroyedErrorCode = await destroyedInit;
        await new Promise(resolve => setTimeout(resolve, 0));

        return {
            notReadyCode,
            readyDuringLoad,
            updateDuringLoadCode,
            readyAfterLoad,
            pendingMapRemoved: pendingMap.removed,
            countsBeforeReinstall,
            countsAfterReinstall,
            closedLabelFilter,
            boundarySnapshot,
            userSnapshot,
            invalidUserFeatureCount,
            closedEdgesSnapshot,
            connectionState,
            directFitEase,
            directFitUsedEase,
            crowdSnapshot,
            crowdAfterSingle,
            apiPoiCollection,
            layerCountBeforeSingleUpdate,
            layerCountAfterSingleUpdate,
            selected,
            decoded,
            presentation,
            comparison,
            comparisonEvent,
            routeOpacityDuringComparison,
            routeOpacityAfterClear,
            comparisonFeatureCounts,
            clearedComparisonFeatureCounts,
            mainRouteFeatureCountAfterClear,
            missingMetricComparison,
            comparisonFailureCode,
            routeOpacityAfterComparisonFailure,
            failedComparisonFeatureCounts,
            mapErrors,
            invalidRouteCode,
            firstRemovedOnReinit,
            firstObserverDisconnected,
            readyAfterReinit,
            secondRemoved: second.removed,
            secondHandlers: second.handlers.length,
            secondObserverDisconnected: secondObserver.disconnected,
            timeoutError,
            timeoutEvent,
            lateErrorCode,
            lateMapRemoved: lateMap.removed,
            destroyedErrorCode,
            destroyedPendingMapRemoved: destroyedMap.removed,
            routeStyle: stylesModule.MAP_LAYER_STYLES.route,
            exportedIdNames: Object.keys(layersModule).filter(key => /(?:SOURCE|LAYER)_IDS/.test(key)),
            layerAccessKeys: Object.keys(layerAccess).sort()
        };
    });

    expect(result.notReadyCode).toBe('MAP_NOT_INITIALIZED');
    expect(result.readyDuringLoad).toBe(false);
    expect(result.updateDuringLoadCode).toBe('MAP_NOT_INITIALIZED');
    expect(result.readyAfterLoad).toBe(true);
    expect(result.pendingMapRemoved).toBe(true);
    expect(result.countsAfterReinstall).toEqual(result.countsBeforeReinstall);
    expect(result.closedLabelFilter).toEqual(['!=', ['get', 'status'], 'closed']);
    expect(result.boundarySnapshot.features).toHaveLength(1);
    expect(result.boundarySnapshot.features[0]).toMatchObject({
        properties: { name: '验收范围' },
        geometry: { type: 'Polygon' }
    });
    expect(result.userSnapshot.features[0]).toMatchObject({
        geometry: { type: 'Point', coordinates: [114.351, 30.541] },
        properties: { accuracy: 24 }
    });
    expect(result.invalidUserFeatureCount).toBe(0);
    expect(result.closedEdgesSnapshot.features).toHaveLength(2);
    expect(result.closedEdgesSnapshot.features.map(feature => [feature.properties.edgeId, feature.properties.selected])).toEqual([
        ['edge-1', false],
        ['edge-2', true]
    ]);
    expect(result.connectionState).toBe('reconnecting');
    expect(result.directFitUsedEase).toBe(true);
    expect(result.directFitEase).toMatchObject({ center: [114.354, 30.544], zoom: 16 });
    expect(result.crowdSnapshot.features[0].properties).toMatchObject({
        crowdLevel: 'medium', lowConfidence: true, crowdLabel: '参考人流 · 较忙'
    });
    expect(result.crowdAfterSingle.features[0].properties).toMatchObject({
        crowdLevel: 'high', lowConfidence: false, crowdLabel: '拥挤'
    });
    expect(result.apiPoiCollection.features).toEqual([expect.objectContaining({
        geometry: { type: 'Point', coordinates: [114.352, 30.542] },
        properties: expect.objectContaining({
            poiId: 'poi-api-1', name: '接口景点', category: '摄影', status: 'approved'
        })
    })]);
    expect(result.layerCountAfterSingleUpdate).toBe(result.layerCountBeforeSingleUpdate);
    expect(result.selected.poiId).toBe('poi-1');
    expect(result.decoded.type).toBe('LineString');
    expect(result.decoded.coordinates).toHaveLength(3);
    expect(result.presentation).toMatchObject({ label: '离线路线', accessibleVerified: false });
    expect(result.comparison).toEqual({
        distanceDeltaM: 120,
        durationDeltaSec: -30,
        reason: '封路绕行'
    });
    expect(result.comparisonEvent).toEqual(result.comparison);
    expect(result.routeOpacityDuringComparison).toBe(0);
    expect(result.comparisonFeatureCounts).toEqual([1, 1]);
    expect(result.routeOpacityAfterClear).toBe(result.routeStyle.opacity);
    expect(result.clearedComparisonFeatureCounts).toEqual([0, 0]);
    expect(result.mainRouteFeatureCountAfterClear).toBe(1);
    expect(result.missingMetricComparison).toMatchObject({
        distanceDeltaM: null,
        durationDeltaSec: null
    });
    expect(result.comparisonFailureCode).toBe('MAP_SERVICE_UNAVAILABLE');
    expect(result.routeOpacityAfterComparisonFailure).toBe(result.routeStyle.opacity);
    expect(result.failedComparisonFeatureCounts).toEqual([0, 0]);
    expect(result.mapErrors[0].code).toBe('MAP_SERVICE_UNAVAILABLE');
    expect(result.invalidRouteCode).toBe('MAP_GEOMETRY_INVALID');
    expect(result.mapErrors.some(error => error.code === 'MAP_GEOMETRY_INVALID')).toBe(true);
    expect(result.firstRemovedOnReinit).toBe(true);
    expect(result.firstObserverDisconnected).toBe(true);
    expect(result.readyAfterReinit).toBe(true);
    expect(result.secondRemoved).toBe(true);
    expect(result.secondHandlers).toBe(0);
    expect(result.secondObserverDisconnected).toBe(true);
    expect(result.timeoutError).toMatchObject({ code: 'MAP_SERVICE_UNAVAILABLE' });
    expect(result.timeoutEvent).toEqual(result.timeoutError);
    expect(result.lateErrorCode).toBe('MAP_SERVICE_UNAVAILABLE');
    expect(result.lateMapRemoved).toBe(true);
    expect(result.destroyedErrorCode).toBe('MAP_SERVICE_UNAVAILABLE');
    expect(result.destroyedPendingMapRemoved).toBe(true);
    expect(result.routeStyle).toMatchObject({ width: 6, opacity: 0.92 });
    expect(result.exportedIdNames).toEqual([]);
    expect(result.layerAccessKeys).toEqual([
        'getLayer', 'getSource', 'offLayer', 'onLayer', 'setPaintProperty'
    ]);
});
