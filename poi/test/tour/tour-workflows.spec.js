'use strict';

const { test, expect } = require('@playwright/test');

const APP = '#tour-app';
const DEMO_STORAGE_KEY = 'geosync:demo-itinerary';

async function waitForBoot(page) {
    await expect(page.locator(APP)).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByText('开发 Mock 模式')).toBeVisible();
}

async function readDemoItinerary(page) {
    return page.evaluate(key => {
        const value = sessionStorage.getItem(key);
        return value ? JSON.parse(value) : null;
    }, DEMO_STORAGE_KEY);
}

function expectCompleteItinerary(snapshot, { version, state } = {}) {
    expect(snapshot).not.toBeNull();
    expect(snapshot).toEqual(expect.objectContaining({
        itineraryId: expect.any(String),
        version: version === undefined ? expect.any(Number) : version,
        state: state === undefined ? expect.any(String) : state,
        date: expect.any(String),
        preferences: expect.any(Object),
        stops: expect.any(Array),
        route: expect.objectContaining({
            geometry: expect.objectContaining({
                type: 'LineString',
                coordinates: expect.any(Array)
            }),
            distanceM: expect.any(Number),
            durationSec: expect.any(Number),
            gis: expect.objectContaining({
                source: expect.any(String),
                mode: expect.any(String),
                degraded: expect.any(Boolean)
            })
        }),
        currentStopId: expect.any(String),
        pendingProposal: snapshot.pendingProposal === null ? null : expect.any(Object),
        savedMinutesTotal: expect.any(Number),
        rerouteCount: expect.any(Number)
    }));
    expect(snapshot.stops.length).toBeGreaterThan(0);
    for (const stop of snapshot.stops) {
        expect(stop).toEqual(expect.objectContaining({
            stopId: expect.any(String),
            poiId: expect.any(String),
            poiName: expect.any(String),
            state: expect.any(String),
            plannedArrive: expect.any(String),
            plannedLeave: expect.any(String)
        }));
    }
}

function formatDistance(meters) {
    const value = Math.abs(Number(meters));
    return value >= 1000 ? `${(value / 1000).toFixed(1)} 公里` : `${Math.round(value)} 米`;
}

function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds) / 60));
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function expectTimelineMatchesSnapshot(page, selector, snapshot) {
    const expected = await page.evaluate(stops => {
        const format = value => new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit', minute: '2-digit', hour12: false
        }).format(new Date(value));
        return stops.map((stop, index) => ({
            title: `${index + 1}. ${stop.poiName}`,
            timeRange: `${format(stop.plannedArrive)}–${format(stop.plannedLeave)}`
        }));
    }, snapshot.stops);
    const rows = page.locator(`${selector} .timeline-row`);
    await expect(rows).toHaveCount(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
        await expect(rows.nth(index).locator('.row-title')).toHaveText(expected[index].title);
        await expect(rows.nth(index).locator('.row-meta')).toContainText(expected[index].timeRange);
    }
}

async function expectSnapshotVersion(page, version, state) {
    await expect(page.locator(APP)).toHaveAttribute('data-itinerary-version', String(version));
    await expect(page.locator(APP)).toHaveAttribute('data-itinerary-state', state);
    const snapshot = await readDemoItinerary(page);
    expectCompleteItinerary(snapshot, { version, state });
    return snapshot;
}

async function planFourHourPhotoShade(page, url = '/tour?demo=1') {
    await page.goto(url);
    await waitForBoot(page);
    await page.getByRole('button', { name: '帮我规划' }).click();
    await expect(page.getByRole('heading', { name: '规划行程' })).toBeVisible();
    await page.locator('#hours-range').fill('4');
    await expect(page.locator('#hours-output')).toHaveText('4 小时');
    await expect(page.getByRole('checkbox', { name: '摄影' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '遮荫优先' })).toBeChecked();
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('heading', { name: '路线预览' })).toBeVisible();
    const snapshot = await expectSnapshotVersion(page, 0, 'draft');
    expect(snapshot.preferences).toEqual(expect.objectContaining({
        hours: 4,
        interests: ['photography'],
        pace: 'normal',
        accessible: false,
        shadeFirst: true
    }));
    await expect(page.locator('#preview-badges')).toContainText('遮荫模式');
    await expectTimelineMatchesSnapshot(page, '#preview-timeline', snapshot);
    return snapshot;
}

async function startAndWaitForProposal(page) {
    await page.getByRole('button', { name: '开始游览' }).click();
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    const started = await expectSnapshotVersion(page, 1, 'active');
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeVisible({ timeout: 6000 });
    return { started, proposed: await readDemoItinerary(page) };
}

async function installFakeGeolocation(page, mode) {
    await page.addInitScript(selectedMode => {
        window.__tourGeoProbe = { clearCalls: [], options: null };
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                watchPosition(success, failure, options) {
                    window.__tourGeoProbe.options = options;
                    setTimeout(() => {
                        if (selectedMode === 'denied') {
                            failure({ code: 1, message: 'permission denied by test' });
                            return;
                        }
                        success({
                            coords: { longitude: 114.3592, latitude: 30.541, accuracy: 180 },
                            timestamp: Date.now()
                        });
                    }, 0);
                    return 37;
                },
                clearWatch(id) {
                    window.__tourGeoProbe.clearCalls.push(id);
                }
            }
        });
    }, mode);
}

test('runs the full plan, pause, resume, skip, reject, finish, and refresh workflow', async ({ page }) => {
    const planned = await planFourHourPhotoShade(page);
    const itineraryKeys = Object.keys(planned).sort();

    await page.getByRole('button', { name: '开始游览' }).click();
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    const started = await expectSnapshotVersion(page, 1, 'active');
    expect(Object.keys(started).sort()).toEqual(itineraryKeys);

    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeVisible({ timeout: 6000 });
    await expect(page.locator('#proposal-before-stops li')).toHaveText(['樱顶摄影点', '老图书馆', '珞珈湖步道']);
    await expect(page.locator('#proposal-after-stops li')).toHaveText(['樱顶摄影点', '珞珈湖步道']);
    const beforeReject = await readDemoItinerary(page);
    expectCompleteItinerary(beforeReject, { version: 1, state: 'active' });
    expect(beforeReject.pendingProposal).not.toBeNull();
    await page.getByRole('button', { name: '保留原路线' }).click();
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    const rejected = await expectSnapshotVersion(page, 2, 'active');
    expect(Object.keys(rejected).sort()).toEqual(itineraryKeys);
    expect(rejected.pendingProposal).toBeNull();
    expect(rejected.route).toEqual(beforeReject.route);
    await page.waitForTimeout(1800);
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const paused = await expectSnapshotVersion(page, 3, 'paused');
    await expect(page.locator('#tour-state-title')).toHaveText('游览已暂停');
    expect(Object.keys(paused).sort()).toEqual(itineraryKeys);

    await page.getByRole('button', { name: '继续', exact: true }).click();
    const resumed = await expectSnapshotVersion(page, 4, 'active');
    await expect(page.locator('#tour-state-title')).toHaveText('游览中');
    expect(Object.keys(resumed).sort()).toEqual(itineraryKeys);

    await page.getByRole('button', { name: '跳过当前站' }).click();
    const skipped = await expectSnapshotVersion(page, 5, 'active');
    expect(Object.keys(skipped).sort()).toEqual(itineraryKeys);
    expect(skipped.stops.find(stop => stop.stopId === skipped.currentStopId)?.state).toBe('skipped');
    await expect(page.locator('#tour-timeline .timeline-row').first()).toContainText('已跳过');

    await page.getByRole('button', { name: '结束游览' }).click();
    await expect(page.getByRole('heading', { name: '本次游览已结束' })).toBeVisible();
    const completed = await expectSnapshotVersion(page, 6, 'completed');
    expect(Object.keys(completed).sort()).toEqual(itineraryKeys);
    await expectTimelineMatchesSnapshot(page, '#completed-timeline', completed);
    const completedPanel = page.locator('[data-panel="completed"]');
    await expect(completedPanel.locator('input, select, textarea')).toHaveCount(0);
    await expect(completedPanel.getByRole('button')).toHaveCount(1);
    await expect(completedPanel.getByRole('button', { name: '返回首页' })).toBeVisible();

    await page.reload();
    await waitForBoot(page);
    await expect(page.getByRole('heading', { name: '本次游览已结束' })).toBeVisible();
    const restored = await expectSnapshotVersion(page, 6, 'completed');
    expect(restored).toEqual(completed);
    await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();
    await expectTimelineMatchesSnapshot(page, '#completed-timeline', restored);
});

test('accepts a proposal and renders the complete returned route, ETA, stops, and version', async ({ page }) => {
    await planFourHourPhotoShade(page);
    const { proposed } = await startAndWaitForProposal(page);
    expectCompleteItinerary(proposed, { version: 1, state: 'active' });
    expect(proposed.pendingProposal).not.toBeNull();

    await page.getByRole('button', { name: '接受新路线' }).click();
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    const accepted = await expectSnapshotVersion(page, 2, 'active');
    expect(accepted.pendingProposal).toBeNull();
    expect(accepted.route).not.toEqual(proposed.route);
    expect(accepted.route.distanceM).not.toBe(proposed.route.distanceM);
    expect(accepted.route.durationSec).not.toBe(proposed.route.durationSec);
    expect(accepted.stops.map(stop => stop.poiId)).toEqual(proposed.pendingProposal.diff.after);
    expect(accepted.stops.length).toBeLessThan(proposed.stops.length);
    const previousLake = proposed.stops.find(stop => stop.poiId === 'poi_lake');
    const reroutedLake = accepted.stops.find(stop => stop.poiId === 'poi_lake');
    expect(reroutedLake.plannedArrive).not.toBe(previousLake.plannedArrive);
    expect(reroutedLake.plannedLeave).not.toBe(previousLake.plannedLeave);

    const metricValues = await page.locator('#tour-metrics .metric strong').allTextContents();
    expect(metricValues).toEqual([
        formatDistance(accepted.route.distanceM),
        formatDuration(accepted.route.durationSec),
        String(accepted.stops.length)
    ]);
    await expectTimelineMatchesSnapshot(page, '#tour-timeline', accepted);
    expect(await page.locator('#tour-timeline .timeline-row').count()).toBe(accepted.stops.length);
});

test('shows the actionable 8204 planning state without creating a partial itinerary', async ({ page }) => {
    await page.goto('/tour?demo=1&scenario=8204');
    await waitForBoot(page);
    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('checkbox', { name: '无障碍路线' }).check();
    await page.getByRole('button', { name: '生成路线' }).click();

    await expect(page.getByRole('heading', { name: '规划行程' })).toBeVisible();
    await expect(page.locator('#plan-message')).toHaveText('没有已验证的无障碍路线，请关闭无障碍模式后主动重试');
    await expect(page.locator('#plan-message')).toBeVisible();
    await expect(page.locator(APP)).toHaveAttribute('data-itinerary-version', '');
    expect(await readDemoItinerary(page)).toBeNull();
});

for (const gisFailure of [
    { code: 8201, message: '地图路径服务暂时不可用' },
    { code: 8202, message: '地图路径服务响应超时' },
    { code: 8203, message: '起点或终点无法连接步行路网，请调整起点后重试' },
    { code: 8205, message: '地图服务契约或数据版本不一致，请刷新配置后重试' },
    { code: 8206, message: '地图返回的路线几何无效，未显示该路线' }
]) {
    test(`shows the safe ${gisFailure.code} planning failure without a partial itinerary`, async ({ page }) => {
        await page.goto(`/tour?demo=1&scenario=${gisFailure.code}`);
        await waitForBoot(page);
        await page.getByRole('button', { name: '帮我规划' }).click();
        await page.getByRole('button', { name: '生成路线' }).click();

        await expect(page.getByRole('heading', { name: '规划行程' })).toBeVisible();
        await expect(page.locator('#plan-message')).toHaveText(gisFailure.message);
        await expect(page.locator('#plan-message')).toBeVisible();
        await expect(page.locator(APP)).toHaveAttribute('data-itinerary-version', '');
        expect(await readDemoItinerary(page)).toBeNull();
    });
}

test('shows 1203 conflict recovery and keeps the complete current version', async ({ page }) => {
    await planFourHourPhotoShade(page, '/tour?demo=1&scenario=1203');
    await page.getByRole('button', { name: '开始游览' }).click();

    await expect(page.locator('#toast')).toHaveText('行程已在其他位置更新，已同步最新版本');
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.getByRole('heading', { name: '路线预览' })).toBeVisible();
    await expectSnapshotVersion(page, 0, 'draft');
});

for (const code of [1204, 1205]) {
    test(`shows ${code} proposal expiry recovery without duplicating the handled panel`, async ({ page }) => {
        await planFourHourPhotoShade(page, `/tour?demo=1&scenario=${code}`);
        await startAndWaitForProposal(page);
        await page.getByRole('button', { name: '接受新路线' }).click();

        await expect(page.locator('#toast')).toHaveText('路线建议已失效，已刷新行程');
        await expect(page.locator('#toast')).toBeVisible();
        await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();
        await expect(page.locator(APP)).toHaveAttribute('data-itinerary-version', '1');
        await page.waitForTimeout(1800);
        await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();
        await page.reload();
        await waitForBoot(page);
        await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: '路线调整建议' })).toBeHidden();
    });
}

test('keeps planning and itinerary lists usable when map initialization fails', async ({ page }) => {
    await page.route('**/assets/mock/client-config.json', async route => {
        const response = await route.fetch();
        const config = await response.json();
        config.gis.center = [999, 999];
        await route.fulfill({
            status: response.status(),
            headers: response.headers(),
            contentType: 'application/json',
            body: JSON.stringify(config)
        });
    });
    await page.goto('/tour?demo=1');
    await waitForBoot(page);

    await expect(page.locator('#map-status-text')).toHaveText('列表模式');
    await expect(page.locator('#map-fallback')).toBeVisible();
    await expect(page.locator('#map-fallback-message')).toContainText('MAP_CONFIG_INVALID');
    await expect(page.locator('#map-fallback-message')).toContainText('规划、时刻表和行程操作仍可使用');
    expect(await page.locator('#poi-list .poi-row').count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: '帮我规划' }).click();
    await page.getByRole('button', { name: '生成路线' }).click();
    await expect(page.getByRole('heading', { name: '路线预览' })).toBeVisible();
    const snapshot = await expectSnapshotVersion(page, 0, 'draft');
    await expectTimelineMatchesSnapshot(page, '#preview-timeline', snapshot);
});

test('keeps itinerary operations available after geolocation permission is denied', async ({ page }) => {
    await installFakeGeolocation(page, 'denied');
    await planFourHourPhotoShade(page);
    await page.getByRole('button', { name: '开始游览' }).click();

    await expect(page.locator('#location-status-text')).toHaveText('定位已拒绝');
    await expect(page.locator('#toast')).toHaveText('定位已拒绝，可继续使用列表和行程操作');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
    const probe = await page.evaluate(() => window.__tourGeoProbe);
    expect(probe.options).toEqual(expect.objectContaining({ enableHighAccuracy: true }));
    expect(probe.clearCalls).toContain(37);
});

test('labels low-accuracy positioning and surfaces the 2103 soft rejection', async ({ page }) => {
    await installFakeGeolocation(page, 'low-accuracy');
    await planFourHourPhotoShade(page, '/tour?demo=1&scenario=2103');
    await page.getByRole('button', { name: '开始游览' }).click();

    await expect(page.locator('#location-status-text')).toHaveText('定位精度较低');
    await expect(page.locator('#toast')).toHaveText('定位精度过低，本次位置未被服务端接受');
    await expect(page.getByRole('heading', { name: '游览中', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
    const probe = await page.evaluate(() => window.__tourGeoProbe);
    expect(probe.options).toEqual(expect.objectContaining({ enableHighAccuracy: true }));
    expect(probe.clearCalls).toEqual([]);
});
