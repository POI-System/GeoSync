'use strict';

const { test, expect } = require('@playwright/test');

const APP = '#tour-app';
const ITINERARY_ID = 'prod-itinerary';
const PROPOSAL_ID = 'prod-barrier-proposal';

function envelope(data) {
    return JSON.stringify({ success: true, code: 0, data, message: '' });
}

function route({ coordinates, distanceM, durationSec, reason } = {}) {
    return {
        geometry: { type: 'LineString', coordinates },
        ...(distanceM === undefined ? {} : { distanceM }),
        ...(durationSec === undefined ? {} : { durationSec }),
        ...(reason ? { reason } : {}),
        gis: { source: 'iserver', mode: 'shade', degraded: false }
    };
}

function itineraryWithProposal({ includeMetrics = true } = {}) {
    const beforeRoute = route({
        coordinates: [[114.3518, 30.5374], [114.3558, 30.5404], [114.3615, 30.5394], [114.3648, 30.5441]],
        ...(includeMetrics ? { distanceM: 900, durationSec: 600 } : {})
    });
    const afterRoute = route({
        coordinates: [[114.3518, 30.5374], [114.3572, 30.542], [114.3648, 30.5441]],
        ...(includeMetrics ? { distanceM: 1080, durationSec: 720 } : {}),
        reason: '当前路线临时封闭，建议绕行湖畔步道'
    });
    const proposal = {
        proposalId: PROPOSAL_ID,
        type: 'barrierReroute',
        reason: '当前路线临时封闭，建议绕行湖畔步道',
        expireAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        diff: {
            before: ['poi_photo', 'poi_history', 'poi_lake'],
            after: ['poi_photo', 'poi_lake']
        },
        beforeRoute,
        afterRoute,
        ...(includeMetrics ? {
            gainMin: -2,
            distanceDeltaM: 180,
            durationDeltaSec: 120
        } : {})
    };
    return {
        itineraryId: ITINERARY_ID,
        version: 7,
        state: 'active',
        date: '2026-08-04',
        preferences: {
            hours: 4,
            interests: ['photography'],
            pace: 'normal',
            accessible: false,
            shadeFirst: true
        },
        stops: [
            {
                stopId: 'stop_photo', poiId: 'poi_photo', poiName: '樱顶摄影点', state: 'approaching',
                plannedArrive: '2026-08-04T02:20:00.000Z', plannedLeave: '2026-08-04T02:45:00.000Z'
            },
            {
                stopId: 'stop_history', poiId: 'poi_history', poiName: '老图书馆', state: 'pending',
                plannedArrive: '2026-08-04T03:15:00.000Z', plannedLeave: '2026-08-04T03:40:00.000Z'
            },
            {
                stopId: 'stop_lake', poiId: 'poi_lake', poiName: '珞珈湖步道', state: 'pending',
                plannedArrive: '2026-08-04T04:10:00.000Z', plannedLeave: '2026-08-04T04:35:00.000Z'
            }
        ],
        route: beforeRoute,
        currentStopId: 'stop_photo',
        pendingProposal: proposal,
        savedMinutesTotal: 0,
        rerouteCount: 0,
        planNote: '生产 REST 提案验收行程'
    };
}

function acceptedItinerary(current) {
    return {
        ...current,
        version: current.version + 1,
        stops: current.stops
            .filter(stop => stop.poiId !== 'poi_history')
            .map(stop => stop.poiId === 'poi_lake'
                ? {
                    ...stop,
                    plannedArrive: '2026-08-04T05:55:00.000Z',
                    plannedLeave: '2026-08-04T06:20:00.000Z'
                }
                : stop),
        route: current.pendingProposal.afterRoute,
        pendingProposal: null,
        savedMinutesTotal: 0,
        rerouteCount: 1,
        planNote: '已按封路状态重建剩余行程'
    };
}

async function installLocalMap(page) {
    await page.route('**/assets/vendor/supermap-iclient/iclient-maplibregl.min.js', routeRequest => routeRequest.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `(() => {
            const clone = value => JSON.parse(JSON.stringify(value));
            window.__productionProposalMapProbe = { sources: {}, fitBoundsCalls: 0 };
            window.maplibregl.supermap = {
                async initMap(_url, options) {
                    const map = new window.maplibregl.Map({
                        ...options.mapOptions,
                        style: {
                            version: 8,
                            sources: {},
                            layers: [{
                                id: 'test-background',
                                type: 'background',
                                paint: { 'background-color': '#dbe6e1' }
                            }]
                        }
                    });
                    const probe = window.__productionProposalMapProbe;
                    const originalAddSource = map.addSource.bind(map);
                    map.addSource = function addSource(id, source) {
                        const result = originalAddSource(id, source);
                        if (source?.type === 'geojson') {
                            probe.sources[id] = clone(source.data);
                            const instance = this.getSource(id);
                            if (instance?.setData) {
                                const originalSetData = instance.setData.bind(instance);
                                instance.setData = data => {
                                    probe.sources[id] = clone(data);
                                    return originalSetData(data);
                                };
                            }
                        }
                        return result;
                    };
                    const originalFitBounds = map.fitBounds.bind(map);
                    map.fitBounds = (...args) => {
                        probe.fitBoundsCalls += 1;
                        return originalFitBounds(...args);
                    };
                    return { map };
                }
            };
        })();`
    }));
}

async function installStableSocket(page) {
    await page.route('**/assets/vendor/socket.io/socket.io.min.js', routeRequest => routeRequest.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `(() => {
            function emitter() {
                const handlers = new Map();
                return {
                    on(name, handler) {
                        if (!handlers.has(name)) handlers.set(name, new Set());
                        handlers.get(name).add(handler);
                        return this;
                    },
                    off(name, handler) { handlers.get(name)?.delete(handler); return this; },
                    incoming(name, payload) {
                        for (const handler of handlers.get(name) || []) handler(payload);
                    }
                };
            }
            window.io = () => {
                const manager = emitter();
                const socket = emitter();
                socket.io = manager;
                socket.emit = name => {
                    if (name === 'geosync:join') {
                        setTimeout(() => socket.incoming('geosync:joined', { ok: true }), 10);
                    }
                    return socket;
                };
                socket.disconnect = () => {};
                setTimeout(() => socket.incoming('connect'), 10);
                return socket;
            };
        })();`
    }));
}

async function installApiRoutes(page, current, { onAccept } = {}) {
    const config = {
        scenicId: 'production-proposal-test',
        scenicName: '生产提案验收景区',
        features: { supermap: true, threeD: false, rain: false },
        gis: {
            center: [114.3592, 30.541],
            extent: [114.3468, 30.5332, 114.3722, 30.5486],
            crs: 'EPSG:4326',
            publicServices: { map: '/test-supermap-service' }
        }
    };
    const pois = current.stops.map(stop => ({
        id: stop.poiId,
        _id: stop.poiId,
        poiName: stop.poiName,
        category: stop.poiId === 'poi_photo' ? 'photography' : stop.poiId === 'poi_lake' ? 'nature' : 'history',
        description: `${stop.poiName}测试数据`,
        status: 'approved',
        suggestedStayMin: 25,
        lng: stop.poiId === 'poi_photo' ? 114.3558 : stop.poiId === 'poi_lake' ? 114.3648 : 114.3615,
        lat: stop.poiId === 'poi_photo' ? 30.5404 : stop.poiId === 'poi_lake' ? 30.5441 : 30.5394
    }));
    const heatmap = {
        slot: new Date().toISOString(),
        lowConfidence: false,
        items: pois.map((poi, index) => ({
            poiId: poi.id,
            ci: [0.56, 0.83, 0.38][index],
            level: ['medium', 'high', 'low'][index],
            queueEstMin: [9, 24, 4][index]
        }))
    };

    await page.route('**/api/geosync/client-config', routeRequest => routeRequest.fulfill({
        status: 200, contentType: 'application/json', body: envelope(config)
    }));
    await page.route('**/api/poi/all', routeRequest => routeRequest.fulfill({
        status: 200, contentType: 'application/json', body: envelope(pois)
    }));
    await page.route('**/api/crowd/heatmap', routeRequest => routeRequest.fulfill({
        status: 200, contentType: 'application/json', body: envelope(heatmap)
    }));
    await page.route('**/api/itinerary/current', routeRequest => routeRequest.fulfill({
        status: 200, contentType: 'application/json', body: envelope(current)
    }));
    if (onAccept) {
        await page.route(`**/api/itinerary/${ITINERARY_ID}/proposal/${PROPOSAL_ID}/accept`, async routeRequest => {
            await onAccept(routeRequest.request());
            await routeRequest.fulfill({
                status: 200,
                contentType: 'application/json',
                body: envelope(acceptedItinerary(current))
            });
        });
    }
}

async function openProductionProposal(page, current, options) {
    await installLocalMap(page);
    await installStableSocket(page);
    await installApiRoutes(page, current, options);
    await page.goto('/tour');
    await expect(page.locator(APP)).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByText('开发 Mock 模式')).toBeHidden();
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeVisible();
    await expect(page.locator('#map-status-text')).toHaveText('GIS 在线');
    await page.waitForFunction(() => {
        const sources = window.__productionProposalMapProbe?.sources;
        return sources?.['geosync-route-old']?.features?.length === 1
            && sources?.['geosync-route-new']?.features?.length === 1;
    });
}

test('renders and accepts a production-shaped barrier proposal without private payload data', async ({ page }) => {
    const current = itineraryWithProposal();
    let acceptRequest = null;
    await openProductionProposal(page, current, {
        onAccept: request => { acceptRequest = request; }
    });

    expect(current.pendingProposal).not.toHaveProperty('payload');
    await expect(page.locator('#proposal-reason')).toHaveText('当前路线临时封闭，建议绕行湖畔步道');
    await expect(page.locator('#proposal-countdown')).toContainText('新旧路线已标注');
    const metrics = page.locator('#proposal-metrics .metric');
    await expect(metrics.nth(0).locator('strong')).toHaveText('+2 分钟');
    await expect(metrics.nth(0).locator('span')).toHaveText('预计增加');
    await expect(metrics.nth(1).locator('strong')).toHaveText('+180 米');
    await expect(metrics.nth(1).locator('span')).toHaveText('额外步行');
    await expect(metrics.nth(3).locator('strong')).toHaveText('2');
    await expect(page.locator('#proposal-before-stops li')).toHaveText(['樱顶摄影点', '老图书馆', '珞珈湖步道']);
    await expect(page.locator('#proposal-after-stops li')).toHaveText(['樱顶摄影点', '珞珈湖步道']);

    const mapProbe = await page.evaluate(() => window.__productionProposalMapProbe);
    expect(mapProbe.sources['geosync-route-old'].features[0].geometry)
        .toEqual(current.pendingProposal.beforeRoute.geometry);
    expect(mapProbe.sources['geosync-route-new'].features[0].geometry)
        .toEqual(current.pendingProposal.afterRoute.geometry);
    expect(mapProbe.fitBoundsCalls).toBeGreaterThan(0);

    await page.getByRole('button', { name: '接受新路线' }).click();
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await expect(page.locator(APP)).toHaveAttribute('data-itinerary-version', '8');
    await expect(page.locator('#tour-next')).toHaveText('当前站：樱顶摄影点 · 下一站：珞珈湖步道');
    const tourMetrics = page.locator('#tour-metrics .metric strong');
    await expect(tourMetrics).toHaveText(['1.1 公里', '12 分钟', '2']);
    const timeline = page.locator('#tour-timeline .timeline-row');
    await expect(timeline).toHaveCount(2);
    await expect(page.locator('#tour-timeline')).not.toContainText('老图书馆');
    await expect(timeline.nth(1)).toContainText('珞珈湖步道');
    const expectedEta = await page.evaluate(value => new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(value)), '2026-08-04T05:55:00.000Z');
    await expect(timeline.nth(1).locator('.row-meta')).toContainText(expectedEta);
    await page.waitForFunction(expectedGeometry => {
        const sources = window.__productionProposalMapProbe?.sources;
        return JSON.stringify(sources?.['geosync-route']?.features?.[0]?.geometry) === JSON.stringify(expectedGeometry)
            && sources?.['geosync-route-old']?.features?.length === 0
            && sources?.['geosync-route-new']?.features?.length === 0;
    }, current.pendingProposal.afterRoute.geometry);
    expect(acceptRequest).not.toBeNull();
    expect(acceptRequest.method()).toBe('POST');
    expect(acceptRequest.postDataJSON()).toEqual({ version: 7 });
});

test('does not render or announce zero when production proposal route metrics are absent', async ({ page }) => {
    const current = itineraryWithProposal({ includeMetrics: false });
    current.pendingProposal.gainMin = null;
    await openProductionProposal(page, current);

    const metrics = page.locator('#proposal-metrics .metric');
    await expect(metrics.nth(0).locator('strong')).toHaveText('服务端暂未提供');
    await expect(metrics.nth(1).locator('strong')).toHaveText('服务端暂未提供');
    await expect(page.locator('#proposal-metrics')).not.toContainText('0 分钟');
    await expect(page.locator('#proposal-metrics')).not.toContainText('0 米');
    await expect(page.locator('#live-region')).toHaveText('新旧路线已显示');
    await expect(page.locator('#live-region')).not.toContainText('距离变化 0 米');
});
