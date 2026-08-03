'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const screenshotDir = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

const VIEWPORTS = [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 }
];

const LONG_PROPOSAL_REASON =
    '游客中心通往湖畔摄影点的主步道因临时管制已关闭，建议绕行山北林荫步道并同步更新预计到达时间与完整时刻表';

function screenshotPath(state, viewport) {
    return path.join(
        screenshotDir,
        `tour-viewport-${state}-${viewport.width}x${viewport.height}.png`
    );
}

async function capture(page, state, viewport) {
    await page.screenshot({
        path: screenshotPath(state, viewport),
        animations: 'disabled'
    });
}

async function assertNoHorizontalOverflow(page, label) {
    const layout = await page.evaluate(() => {
        const app = document.getElementById('tour-app').getBoundingClientRect();
        const activePanel = document.querySelector('.panel:not(.hidden)')?.getBoundingClientRect();
        const textSelectors = [
            '.panel:not(.hidden) h2',
            '.panel:not(.hidden) .panel-subtitle',
            '.panel:not(.hidden) .notice',
            '.panel:not(.hidden) .metric',
            '.panel:not(.hidden) .row-title',
            '.panel:not(.hidden) .row-meta',
            '.panel:not(.hidden) .btn'
        ];
        const textOutsideViewport = document.querySelectorAll(textSelectors.join(','));
        const offenders = [...textOutsideViewport]
            .filter(element => {
                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
            })
            .map(element => ({
                selector: element.id || element.className || element.tagName,
                text: element.textContent.trim().slice(0, 40)
            }));
        return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            htmlWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            app: { left: app.left, right: app.right, top: app.top, bottom: app.bottom },
            activePanel: activePanel && {
                left: activePanel.left,
                right: activePanel.right,
                top: activePanel.top,
                bottom: activePanel.bottom
            },
            offenders
        };
    });

    expect(layout.htmlWidth, `${label}: html horizontal overflow`).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.bodyWidth, `${label}: body horizontal overflow`).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.app.left, `${label}: app left edge`).toBeGreaterThanOrEqual(-1);
    expect(layout.app.right, `${label}: app right edge`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.app.top, `${label}: app top edge`).toBeGreaterThanOrEqual(-1);
    expect(layout.app.bottom, `${label}: app bottom edge`).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.activePanel, `${label}: active panel exists`).not.toBeNull();
    expect(layout.activePanel.left, `${label}: active panel left edge`).toBeGreaterThanOrEqual(-1);
    expect(layout.activePanel.right, `${label}: active panel right edge`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.offenders, `${label}: text outside viewport`).toEqual([]);
}

async function assertActivePanelUsable(page, label, { safeBottom = 0 } = {}) {
    const activePanel = page.locator('.panel:not(.hidden)');
    await expect(activePanel, `${label}: one active panel`).toHaveCount(1);

    const targets = await activePanel.locator('button, .choice span, .switch-row').evaluateAll(elements =>
        elements.map(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
                text: element.textContent.trim().slice(0, 40) || element.getAttribute('aria-label') || element.tagName,
                visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
                width: rect.width,
                height: rect.height
            };
        }).filter(item => item.visible)
    );
    expect(targets.length, `${label}: visible touch targets`).toBeGreaterThan(0);
    for (const target of targets) {
        expect(target.width, `${label}: ${target.text} touch width`).toBeGreaterThanOrEqual(44);
        expect(target.height, `${label}: ${target.text} touch height`).toBeGreaterThanOrEqual(44);
    }

    const lastAction = activePanel.locator('button:visible').last();
    await expect(lastAction, `${label}: visible command`).toBeVisible();
    await lastAction.evaluate(element => {
        const panel = element.closest('.panel');
        panel.scrollTop = panel.scrollHeight;
    });
    const actionPlacement = await lastAction.evaluate((element, requiredSafeBottom) => {
        const rect = element.getBoundingClientRect();
        const panel = element.closest('.panel');
        const panelRect = panel.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return {
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
            viewportHeight: window.innerHeight,
            bottomClearance: panelRect.bottom - rect.bottom,
            paddingBottom: parseFloat(getComputedStyle(panel).paddingBottom),
            unobstructed: Boolean(hit && (element.contains(hit) || hit.contains(element))),
            requiredSafeBottom
        };
    }, safeBottom);
    expect(actionPlacement.rect.left, `${label}: action left edge`).toBeGreaterThanOrEqual(actionPlacement.panel.left - 1);
    expect(actionPlacement.rect.right, `${label}: action right edge`).toBeLessThanOrEqual(actionPlacement.panel.right + 1);
    expect(actionPlacement.rect.top, `${label}: action top edge`).toBeGreaterThanOrEqual(actionPlacement.panel.top - 1);
    expect(actionPlacement.rect.bottom, `${label}: action viewport edge`).toBeLessThanOrEqual(actionPlacement.viewportHeight + 1);
    expect(actionPlacement.unobstructed, `${label}: action is not occluded`).toBe(true);
    if (safeBottom) {
        expect(actionPlacement.paddingBottom, `${label}: safe-area padding`).toBeGreaterThanOrEqual(safeBottom + 13);
        expect(actionPlacement.bottomClearance, `${label}: command clears safe area`).toBeGreaterThanOrEqual(safeBottom - 1);
    }
}

async function assertStateLayout(page, label, options) {
    await assertNoHorizontalOverflow(page, label);
    await assertActivePanelUsable(page, label, options);
    await assertFloatingLayersDoNotOverlap(page, label);
}

async function assertFloatingLayersDoNotOverlap(page, label) {
    const collisions = await page.evaluate(() => {
        const pairs = [
            ['#map-fallback', '.brand-block'],
            ['#map-fallback', '.status-row'],
            ['#map-fallback', '#crowd-legend'],
            ['#map-fallback', '.bottom-sheet'],
            ['#map-fallback', '#rain-banner'],
            ['#map-fallback', '#road-banner'],
            ['#map-fallback', '#connection-banner'],
            ['#rain-banner', '.brand-block'],
            ['#rain-banner', '.status-row'],
            ['#rain-banner', '#crowd-legend'],
            ['#rain-banner', '.bottom-sheet'],
            ['#road-banner', '.brand-block'],
            ['#road-banner', '.status-row'],
            ['#road-banner', '#crowd-legend'],
            ['#road-banner', '.bottom-sheet'],
            ['#connection-banner', '.brand-block'],
            ['#connection-banner', '.status-row'],
            ['#connection-banner', '#crowd-legend'],
            ['#connection-banner', '.bottom-sheet'],
            ['#rain-banner', '#road-banner'],
            ['#rain-banner', '#connection-banner'],
            ['#road-banner', '#connection-banner']
        ];
        const visibleRect = selector => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
                return null;
            }
            return rect;
        };
        return pairs.flatMap(([first, second]) => {
            const a = visibleRect(first);
            const b = visibleRect(second);
            if (!a || !b) return [];
            const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            return width > 1 && height > 1
                ? [{ first, second, overlapWidth: Math.round(width), overlapHeight: Math.round(height) }]
                : [];
        });
    });
    expect(collisions, `${label}: floating UI layers overlap`).toEqual([]);
}

async function mockProductionApis(page) {
    const config = {
        scenicId: 'viewport_socket_test',
        scenicName: '视口矩阵测试景区',
        scenicCenter: [114.3592, 30.541],
        gis: {
            center: [114.3592, 30.541],
            extent: [114.3468, 30.5332, 114.3722, 30.5486],
            crs: 'EPSG:4326',
            publicServices: {}
        }
    };
    const dataByPath = new Map([
        ['/api/geosync/client-config', config],
        ['/api/poi/all', [
            {
                id: 'socket-poi-1',
                poiName: '实时连接中断时仍可浏览的湖畔摄影点',
                category: '摄影',
                status: 'approved',
                lng: 114.3592,
                lat: 30.541
            }
        ]],
        ['/api/crowd/heatmap', { items: [], lowConfidence: true, generatedAt: new Date().toISOString() }],
        ['/api/itinerary/current', null]
    ]);
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (!pathname.startsWith('/api/')) return route.continue();
        if (!dataByPath.has(pathname)) {
            return route.fulfill({
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, code: 404, data: null, message: 'Not found' })
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, code: 0, data: dataByPath.get(pathname), message: '' })
        });
    });
}

async function installDisconnectingSocketTransport(page) {
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
                socket.emit = (name) => {
                    if (name === 'geosync:join') {
                        setTimeout(() => socket.incoming('geosync:joined', { ok: true }), 10);
                    }
                    return socket;
                };
                socket.disconnect = () => {};
                setTimeout(() => socket.incoming('connect'), 20);
                setTimeout(() => socket.incoming('disconnect', 'transport close'), 240);
                return socket;
            };
        })();`
    }));
}

test.describe('tour mobile and desktop viewport matrix', () => {
    for (const viewport of VIEWPORTS) {
        test(`${viewport.width}x${viewport.height} covers workflow and degradation states`, async ({ page }) => {
            test.setTimeout(45000);
            const label = `${viewport.width}x${viewport.height}`;
            await page.setViewportSize(viewport);
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'geolocation', {
                    configurable: true,
                    value: {
                        watchPosition(_success, failure) {
                            queueMicrotask(() => failure({ code: 1, message: 'permission denied by viewport test' }));
                            return 91;
                        },
                        clearWatch() {}
                    }
                });
            });

            await page.goto('/tour?demo=1');
            await expect(page.locator('#map-status-dot')).toHaveAttribute('data-state', 'online');
            await expect(page.getByRole('heading', { name: '现在出发' })).toBeVisible();
            await assertStateLayout(page, `${label} home`);
            await capture(page, 'home', viewport);

            await page.getByRole('button', { name: '帮我规划' }).click();
            await expect(page.getByRole('heading', { name: '规划行程' })).toBeVisible();
            await assertStateLayout(page, `${label} plan`);
            await capture(page, 'plan', viewport);

            await page.locator('#hours-range').fill('4');
            await page.getByRole('button', { name: '生成路线' }).click();
            await expect(page.getByRole('heading', { name: '路线预览' })).toBeVisible();
            await assertStateLayout(page, `${label} preview`);
            await capture(page, 'preview', viewport);

            await page.evaluate(async () => {
                const { SocketClient } = await import('/assets/js/realtime/socketClient.js');
                const original = SocketClient.prototype.demoProposal;
                SocketClient.prototype.demoProposal = function delayedProposal(payload) {
                    return original.call(this, payload, 2500);
                };
            });
            await page.getByRole('button', { name: '开始游览' }).click();
            await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
            await expect(page.locator('#location-status-dot')).toHaveAttribute('data-state', 'denied');
            await assertStateLayout(page, `${label} touring with location denied`);
            await capture(page, 'touring-location-denied', viewport);

            await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeVisible({ timeout: 6000 });
            await assertStateLayout(page, `${label} proposal`);
            await capture(page, 'proposal', viewport);

            await page.locator('#proposal-reason').evaluate((element, text) => {
                element.textContent = text;
                document.documentElement.style.fontSize = '200%';
            }, LONG_PROPOSAL_REASON);
            await expect(page.locator('#proposal-reason')).toHaveText(LONG_PROPOSAL_REASON);
            await assertStateLayout(page, `${label} proposal at 200 percent font`);
            await capture(page, 'proposal-font-200', viewport);

            await page.evaluate(() => {
                document.documentElement.style.fontSize = '';
                document.documentElement.style.setProperty('--safe-bottom', '34px');
            });
            await assertStateLayout(page, `${label} proposal with safe area`, { safeBottom: 34 });
            await capture(page, 'proposal-safe-area', viewport);

            await page.getByRole('button', { name: '接受新路线' }).click();
            await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
            await page.evaluate(() => document.documentElement.style.removeProperty('--safe-bottom'));

            await page.route('**/assets/vendor/maplibre/maplibre-gl.js', route => route.abort());
            await page.route('**/assets/vendor/supermap-iclient/iclient-maplibregl.min.js', route => route.abort());
            await page.goto('/tour?demo=1&mapFailure=1');
            await expect(page.locator('#map-fallback')).toBeVisible();
            await expect(page.locator('#map-stage')).toHaveAttribute('data-list-only', 'true');
            await expect(page.getByRole('heading', { name: '游览中' })).toBeVisible();
            await expect(page.getByRole('button', { name: '暂停' })).toBeEnabled();
            await assertStateLayout(page, `${label} map failure list mode`);
            await capture(page, 'map-fallback-list', viewport);

            await page.evaluate(() => sessionStorage.clear());
            await mockProductionApis(page);
            await installDisconnectingSocketTransport(page);
            await page.goto('/tour?viewportSocketTest=1');
            await expect(page.locator('#socket-status-dot')).toHaveAttribute('data-state', 'reconnecting');
            await expect(page.locator('#connection-banner')).toBeVisible();
            await expect(page.locator('#connection-banner')).toContainText('正在恢复');
            await expect(page.getByRole('button', { name: '帮我规划' })).toBeEnabled();
            await assertStateLayout(page, `${label} socket disconnected`);
            await capture(page, 'socket-disconnected', viewport);
        });
    }
});
