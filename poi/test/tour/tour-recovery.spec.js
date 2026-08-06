'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const mockRoot = path.resolve(__dirname, '..', '..', 'public', 'assets', 'mock');

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(mockRoot, name), 'utf8'));
}

function envelope(data) {
    return JSON.stringify({ success: true, code: 0, data, message: '' });
}

function invalidMapConfig() {
    const config = fixture('client-config.json');
    config.gis.center = [999, 999];
    return config;
}

function publicPois() {
    return fixture('pois.geojson').features.map(feature => ({
        id: feature.properties.poiId,
        poiName: feature.properties.name,
        category: feature.properties.category,
        description: feature.properties.description,
        status: feature.properties.status,
        suggestedStayMin: feature.properties.suggestedStayMin,
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1]
    }));
}

function activeItinerary() {
    const itinerary = fixture('itinerary.json');
    itinerary.state = 'active';
    itinerary.version = 1;
    itinerary.currentStopId = itinerary.stops[0].stopId;
    itinerary.stops = itinerary.stops.map((stop, index) => ({
        ...stop,
        state: index === 0 ? 'approaching' : 'pending'
    }));
    return itinerary;
}

function completedItinerary() {
    const itinerary = activeItinerary();
    itinerary.state = 'completed';
    itinerary.version = 2;
    itinerary.currentStopId = null;
    itinerary.pendingProposal = null;
    itinerary.stops = itinerary.stops.map(stop => ({ ...stop, state: 'done' }));
    return itinerary;
}

async function installBaseRoutes(page) {
    const config = invalidMapConfig();
    const pois = publicPois();
    const heatmap = fixture('heatmap.json');

    await page.route('**/api/geosync/client-config', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(config)
    }));
    await page.route('**/api/poi/all', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(pois)
    }));
    await page.route('**/api/crowd/heatmap', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(heatmap)
    }));
}

async function installStableSocketTransport(page) {
    await page.route('**/assets/vendor/socket.io/socket.io.min.js', route => route.fulfill({
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
                window.__tourSocketTest = {
                    incoming(name, payload) { socket.incoming(name, payload); },
                    reconnect() { manager.incoming('reconnect'); }
                };
                setTimeout(() => socket.incoming('connect'), 10);
                return socket;
            };
        })();`
    }));
}

async function installUnavailableSocketTransport(page) {
    await page.route('**/assets/vendor/socket.io/socket.io.min.js', route => route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'delete window.io;'
    }));
}

test('recovers an active itinerary after a failed and then invalid current snapshot', async ({ page }) => {
    const itinerary = activeItinerary();
    let currentRequests = 0;
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        if (currentRequests === 1) {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 8201, data: null, message: 'temporary outage' })
            });
        }
        if (currentRequests === 2) {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: envelope({ itineraryId: 'partial-only', version: 2 })
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(itinerary)
        });
    });

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible({ timeout: 12000 });
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '1');
    expect(currentRequests).toBeGreaterThan(2);
});

test('treats an unauthenticated current request as reachable browse-only state', async ({ page }) => {
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 0, data: null, message: 'authentication required' })
    }));

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-api-state', 'online');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '');
    await expect(page.getByRole('heading', { name: '现在出发', exact: true })).toBeVisible();
});

test('refreshes config, current itinerary, and heatmap together after socket reconnect', async ({ page }) => {
    const initialConfig = invalidMapConfig();
    initialConfig.scenicName = '重连前景区';
    const refreshedConfig = structuredClone(initialConfig);
    refreshedConfig.scenicName = '重连后景区';
    const refreshedItinerary = fixture('itinerary.json');
    refreshedItinerary.itineraryId = 'reconnected-itinerary';
    refreshedItinerary.state = 'draft';
    refreshedItinerary.version = 6;
    const counts = { config: 0, current: 0, heatmap: 0 };

    await installStableSocketTransport(page);
    await page.route('**/api/geosync/client-config', route => {
        counts.config += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(counts.config === 1 ? initialConfig : refreshedConfig)
        });
    });
    await page.route('**/api/poi/all', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(publicPois())
    }));
    await page.route('**/api/itinerary/current', route => {
        counts.current += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(counts.current === 1 ? null : refreshedItinerary)
        });
    });
    await page.route('**/api/crowd/heatmap', route => {
        counts.heatmap += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(counts.heatmap === 1
                ? { items: [], lowConfidence: false, generatedAt: '2026-08-05T00:00:00.000Z' }
                : {
                    items: [{ poiId: 'poi_photo', level: 'high', ci: 0.91 }],
                    lowConfidence: true,
                    generatedAt: '2026-08-05T00:01:00.000Z'
                })
        });
    });

    await page.goto('/tour');
    await expect(page.locator('#socket-status-dot')).toHaveAttribute('data-state', 'connected');
    await expect(page.locator('#scenic-name')).toHaveText('重连前景区');
    await page.evaluate(() => window.__tourSocketTest.reconnect());

    await expect(page.locator('#scenic-name')).toHaveText('重连后景区');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '6');
    await expect(page.locator('#crowd-confidence')).toHaveText('参考人流');
    await expect.poll(() => counts).toEqual({ config: 2, current: 2, heatmap: 2 });
    await expect(page.locator('#live-region')).toHaveText('实时连接已恢复，配置、行程和客流已同步');
});

test('keeps the API offline when every fallback poll request fails', async ({ page }) => {
    await installUnavailableSocketTransport(page);
    await page.route(/^http:\/\/127\.0\.0\.1:4177\/api\//, route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 0, data: null, message: 'private outage' })
    }));

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#connection-banner')).toBeVisible({ timeout: 7000 });
    await page.waitForTimeout(300);
    await expect(page.locator('#tour-app')).toHaveAttribute('data-api-state', 'offline');
});

test('keeps the API offline while current recovery fails even when other polling succeeds', async ({ page }) => {
    let currentRequests = 0;
    await installUnavailableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, code: 8201, data: null, message: 'temporary outage' })
        });
    });

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => currentRequests, { timeout: 7000 }).toBeGreaterThan(1);
    await expect(page.locator('#tour-app')).toHaveAttribute('data-api-state', 'offline');
});

test('does not let a delayed boot current response overwrite a newly planned itinerary', async ({ page }) => {
    const itinerary = fixture('itinerary.json');
    itinerary.state = 'draft';
    itinerary.version = 4;
    await installUnavailableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', async route => {
        await new Promise(resolve => setTimeout(resolve, 600));
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(null)
        });
    });
    await page.route('**/api/itinerary/plan', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(itinerary)
    }));

    await page.goto('/tour');
    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('heading', { name: '路线预览', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '4');
});

test('shows the three-second planning status and suppresses duplicate submission', async ({ page }) => {
    const itinerary = fixture('itinerary.json');
    itinerary.state = 'draft';
    itinerary.version = 2;
    let planRequests = 0;
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(null)
    }));
    await page.route('**/api/itinerary/plan', async route => {
        planRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 3250));
        await route.fulfill({ status: 200, contentType: 'application/json', body: envelope(itinerary) });
    });

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '帮我规划' }).click();
    const disabledAfterFirst = await page.locator('#submit-plan').evaluate(button => {
        button.click();
        const disabled = button.disabled;
        button.click();
        return disabled;
    });

    expect(disabledAfterFirst).toBe(true);
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#plan-message')).toHaveText('仍在规划，请稍候…', { timeout: 5000 });
    await expect(page.getByRole('heading', { name: '路线预览', exact: true })).toBeVisible();
    expect(planRequests).toBe(1);
});

test('offers both 1206 recovery choices and replans only after versioned abandon', async ({ page }) => {
    const existing = fixture('itinerary.json');
    existing.itineraryId = 'existing-itinerary';
    existing.state = 'draft';
    existing.version = 3;
    const routes = fixture('routes.json');
    existing.route = routes.before;
    existing.pendingProposal = {
        proposalId: 'existing-proposal',
        type: 'barrierReroute',
        reason: '已有行程存在待处理改道',
        expireAt: '2099-08-05T08:10:00.000Z',
        distanceDeltaM: 120,
        durationDeltaSec: 90,
        beforeRoute: routes.before,
        afterRoute: routes.after
    };
    const abandoned = { ...existing, pendingProposal: null, state: 'abandoned', version: 4 };
    const replacement = fixture('itinerary.json');
    replacement.itineraryId = 'replacement-itinerary';
    replacement.state = 'draft';
    replacement.version = 0;
    let currentRequests = 0;
    let planRequests = 0;
    let abandonBody = null;
    const planBodies = [];

    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(currentRequests === 1 ? null : existing)
        });
    });
    await page.route('**/api/itinerary/plan', route => {
        planRequests += 1;
        planBodies.push(route.request().postDataJSON());
        if (planRequests < 3) {
            return route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: false,
                    code: 1206,
                    data: { existingId: existing.itineraryId },
                    message: 'private existing itinerary detail'
                })
            });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(replacement) });
    });
    await page.route('**/api/itinerary/existing-itinerary/abandon', route => {
        abandonBody = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(abandoned) });
    });

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.locator('#plan-message')).toHaveText('已有未完成行程，请继续原行程或放弃后重新规划');
    await expect(page.getByRole('button', { name: '继续已有行程' })).toBeFocused();

    await page.getByRole('button', { name: '继续已有行程' }).click();
    await expect(page.getByRole('heading', { name: '路线调整建议', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '3');

    await page.evaluate(() => { window.location.hash = '#plan'; });
    await expect(page.getByRole('heading', { name: '规划行程', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('button', { name: '放弃并重新规划' })).toBeVisible();
    await page.getByRole('button', { name: '放弃并重新规划' }).click();

    await expect(page.getByRole('heading', { name: '路线预览', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '0');
    expect(planRequests).toBe(3);
    expect(abandonBody).toEqual({ version: 3 });
    expect(planBodies[2]).toEqual(expect.objectContaining({
        hours: 4,
        interests: ['photography'],
        pace: 'normal',
        accessible: false,
        shadeFirst: true
    }));
});

test('keeps the abandoned server state when replacement planning fails and allows a clean retry', async ({ page }) => {
    const existing = fixture('itinerary.json');
    existing.itineraryId = 'replace-failure-existing';
    existing.state = 'draft';
    existing.version = 7;
    const abandoned = { ...existing, state: 'abandoned', version: 8, pendingProposal: null };
    const replacement = { ...fixture('itinerary.json'), itineraryId: 'replace-failure-new', state: 'draft', version: 0 };
    let currentRequests = 0;
    let planRequests = 0;
    let abandonRequests = 0;

    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(currentRequests === 1 ? null : existing)
        });
    });
    await page.route('**/api/itinerary/plan', route => {
        planRequests += 1;
        if (planRequests === 1) {
            return route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 1206, data: null, message: 'private detail' })
            });
        }
        if (planRequests === 2) {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 9001, data: null, message: 'private detail' })
            });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(replacement) });
    });
    await page.route('**/api/itinerary/replace-failure-existing/abandon', route => {
        abandonRequests += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(abandoned) });
    });

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('button', { name: '生成路线' }).click();
    await page.getByRole('button', { name: '放弃并重新规划' }).click();

    await expect(page.locator('#plan-message')).toHaveText('服务暂时不可用，请稍后重试');
    await expect(page.locator('#existing-itinerary-choice')).toBeHidden();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-state', 'abandoned');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '8');

    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('heading', { name: '路线预览', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '0');
    expect(abandonRequests).toBe(1);
    expect(planRequests).toBe(3);
});

test('refreshes the authoritative itinerary when abandon reports a version conflict', async ({ page }) => {
    const existing = fixture('itinerary.json');
    existing.itineraryId = 'replace-conflict-existing';
    existing.state = 'draft';
    existing.version = 4;
    const authoritative = { ...existing, version: 5 };
    let currentRequests = 0;

    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        const current = currentRequests === 1 ? null : currentRequests === 2 ? existing : authoritative;
        return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(current) });
    });
    await page.route('**/api/itinerary/plan', route => route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 1206, data: null, message: 'private detail' })
    }));
    await page.route('**/api/itinerary/replace-conflict-existing/abandon', route => route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 1203, data: null, message: 'private detail' })
    }));

    await page.goto('/tour');
    await expect(page.locator('#tour-app')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('button', { name: '生成路线' }).click();
    await page.getByRole('button', { name: '放弃并重新规划' }).click();

    await expect(page.getByRole('heading', { name: '路线预览', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '5');
    await expect(page.locator('#existing-itinerary-choice')).toBeHidden();
    await expect(page.locator('#toast')).toHaveText('行程已在其他位置更新，已同步最新版本');
    expect(currentRequests).toBe(3);
});

test('ignores a current response that resolves after page destruction even when fetch ignores abort', async ({ page }) => {
    const initial = activeItinerary();
    const updated = activeItinerary();
    updated.version = 2;
    updated.state = 'paused';
    await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        window.__lateCurrentFetch = { armed: false, resolve: null };
        window.fetch = (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
            if (url.pathname === '/api/itinerary/current' && window.__lateCurrentFetch.armed) {
                return new Promise(resolve => {
                    window.__lateCurrentFetch.resolve = data => resolve(new Response(JSON.stringify({
                        success: true, code: 0, data, message: ''
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                    }));
                });
            }
            return nativeFetch(input, init);
        };
    });
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(initial)
    }));

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(window.__tourSocketTest))).toBe(true);
    await page.evaluate(() => {
        window.__lateCurrentFetch.armed = true;
        window.__tourSocketTest.incoming('itinerary:progress', { version: 2 });
    });
    await expect.poll(() => page.evaluate(() => typeof window.__lateCurrentFetch.resolve)).toBe('function');
    await page.evaluate(next => {
        window.dispatchEvent(new Event('pagehide'));
        window.__lateCurrentFetch.resolve(next);
    }, updated);
    await page.waitForTimeout(100);

    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '1');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-state', 'active');
});

test('retries current after a Socket proposal notification fails once', async ({ page }) => {
    const initial = activeItinerary();
    const proposed = activeItinerary();
    const rerouted = fixture('itinerary-rerouted.json');
    const routes = fixture('routes.json');
    initial.route = routes.before;
    proposed.route = routes.before;
    proposed.version = 2;
    proposed.pendingProposal = {
        proposalId: 'proposal-live-recovery',
        type: 'barrierReroute',
        reason: '当前路线检测到临时封路',
        gainMin: 0,
        expireAt: new Date(Date.now() + 60000).toISOString(),
        diff: {
            before: proposed.stops.map(stop => stop.poiId),
            after: rerouted.stops.map(stop => stop.poiId)
        },
        beforeRoute: routes.before,
        afterRoute: routes.after,
        distanceDeltaM: routes.after.distanceM - routes.before.distanceM,
        durationDeltaSec: routes.after.durationSec - routes.before.durationSec
    };
    let currentRequests = 0;
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        if (currentRequests === 1) {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: envelope(initial)
            });
        }
        if (currentRequests === 2) {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 8201, data: null, message: 'temporary outage' })
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(proposed)
        });
    });

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(window.__tourSocketTest))).toBe(true);
    await page.evaluate(() => window.__tourSocketTest.incoming('itinerary:proposal', {
        itineraryId: 'demo_itinerary',
        version: 2,
        proposalId: 'proposal-live-recovery'
    }));

    await expect(page.getByRole('heading', { name: '路线调整建议', exact: true }))
        .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2');
    await expect(page.locator('#proposal-reason')).toHaveText('当前路线检测到临时封路');
    expect(currentRequests).toBeGreaterThan(2);
});

test('automatically recovers after a 1203 current refresh fails once', async ({ page }) => {
    const initial = activeItinerary();
    const updated = activeItinerary();
    updated.version = 2;
    updated.state = 'paused';
    let currentRequests = 0;
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => {
        currentRequests += 1;
        if (currentRequests === 1) {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: envelope(initial)
            });
        }
        if (currentRequests === 2) {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 8201, data: null, message: 'temporary outage' })
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(updated)
        });
    });
    await page.route('**/api/itinerary/demo_itinerary/pause', route => route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 1203, data: null, message: 'version conflict' })
    }));

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '暂停', exact: true }).click();

    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2', { timeout: 8000 });
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-state', 'paused');
    await expect(page.locator('#tour-state-title')).toHaveText('游览已暂停');
    expect(currentRequests).toBeGreaterThan(2);
});

test('restores a completed itinerary from its owned detail and clears it on return home', async ({ page }) => {
    const active = activeItinerary();
    const completed = completedItinerary();
    let finished = false;
    let detailRequests = 0;
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(finished ? null : active)
    }));
    await page.route('**/api/itinerary/demo_itinerary/finish', route => {
        finished = true;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(completed)
        });
    });
    await page.route(/^http:\/\/127\.0\.0\.1:4177\/api\/itinerary\/demo_itinerary$/, route => {
        detailRequests += 1;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: envelope(completed)
        });
    });

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '结束游览' }).click();
    await expect(page.getByRole('heading', { name: '本次游览已结束', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2');
    expect(await page.evaluate(() => sessionStorage.getItem('geosync:tour:terminal-itinerary-id:v1')))
        .toBe('demo_itinerary');

    await page.reload();
    await expect(page.getByRole('heading', { name: '本次游览已结束', exact: true })).toBeVisible();
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '2');
    expect(detailRequests).toBe(1);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '现在出发', exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('geosync:tour:terminal-itinerary-id:v1')))
        .toBeNull();
    await page.reload();
    await expect(page.getByRole('heading', { name: '现在出发', exact: true })).toBeVisible();
    expect(detailRequests).toBe(1);
});

test('prefers an active current itinerary over a stored terminal itinerary id', async ({ page }) => {
    const active = activeItinerary();
    let detailRequests = 0;
    await page.addInitScript(() => {
        sessionStorage.setItem('geosync:tour:terminal-itinerary-id:v1', 'old-terminal');
    });
    await installStableSocketTransport(page);
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelope(active)
    }));
    await page.route('**/api/itinerary/old-terminal', route => {
        detailRequests += 1;
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    expect(detailRequests).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('geosync:tour:terminal-itinerary-id:v1')))
        .toBeNull();
});

test('does not report a successful conflict recovery when current refresh fails', async ({ page }) => {
    const itinerary = activeItinerary();
    let failCurrent = false;
    await installBaseRoutes(page);
    await page.route('**/api/itinerary/current', route => route.fulfill({
        status: failCurrent ? 503 : 200,
        contentType: 'application/json',
        body: failCurrent
            ? JSON.stringify({ success: false, code: 0, data: null, message: 'private outage' })
            : envelope(itinerary)
    }));
    await page.route('**/api/itinerary/demo_itinerary/pause', route => {
        failCurrent = true;
        return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, code: 1203, data: null, message: 'private conflict' })
        });
    });

    await page.goto('/tour');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.locator('#toast')).toHaveText('服务暂时不可用，请稍后重试');
    await expect(page.locator('#tour-app')).toHaveAttribute('data-itinerary-version', '1');
});
