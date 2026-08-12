'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const baseUrl = process.env.SJP_DEMO_URL || 'http://127.0.0.1:4174';
const screenshot = path.resolve(__dirname, '../../outputs/sjp/management.png');

async function selectRoad(page) {
    const map = page.locator('#ops-map');
    const box = await map.boundingBox();
    for (let y = 80; y < box.height - 60; y += 45) {
        for (let x = 70; x < box.width - 70; x += 55) {
            await map.click({ position: { x, y } });
            if (await page.locator('[data-edge-id]').textContent() !== '--') return;
        }
    }
    throw new Error('No rendered road could be selected');
}

async function verify() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.SJP_BROWSER_EXECUTABLE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('dialog', dialog => dialog.accept());
    try {
        await page.goto(`${baseUrl}/ops?gis=1`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-boot="ready"]');
        await page.waitForFunction(() => document.querySelector('#ops-map')?.dataset.roadMode === 'native');

        await page.locator('[data-poi-manager]').click();
        await page.locator('[data-poi-pick]').click();
        await page.locator('#ops-map').click({ position: { x: 520, y: 320 } });
        await page.locator('[data-poi-form] input[name="name"]').fill('自动验收景点');
        await page.locator('[data-poi-form] textarea[name="note"]').fill('地图选点验收');
        await page.locator('[data-poi-form] input[name="photo"]').setInputFiles({
            name: 'spot.png', type: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
        });
        await page.locator('[data-poi-form] button[type="submit"]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('.poi-list-item strong')]
            .some(element => element.textContent === '自动验收景点'));
        assert.notEqual(await page.locator('[data-poi-form] input[name="lng"]').inputValue(), '');
        assert.notEqual(await page.locator('[data-poi-form] input[name="lat"]').inputValue(), '');
        assert.equal(await page.locator('[data-photo-preview]').isVisible(), true);
        await page.screenshot({ path: screenshot });
        await page.locator('[data-poi-delete]').click();
        await page.waitForFunction(() => ![...document.querySelectorAll('.poi-list-item strong')]
            .some(element => element.textContent === '自动验收景点'));
        await page.locator('[data-poi-close]').click();

        await selectRoad(page);
        await page.locator('[data-action="edit-edge"]').click();
        const originalStatus = await page.locator('[data-road-form] select[name="status"]').inputValue();
        const originalCongestion = await page.locator('[data-road-form] select[name="congestion"]').inputValue();
        const originalWarning = await page.locator('[data-road-form] textarea[name="warning"]').inputValue();
        await page.locator('[data-road-form] select[name="congestion"]').selectOption('busy');
        await page.locator('[data-road-form] textarea[name="warning"]').fill('自动验收警告');
        await page.locator('[data-road-form] button[type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('[data-edge-note]')?.textContent.includes('自动验收警告'));
        assert.match(await page.locator('[data-edge-status]').textContent(), /较忙/);

        await page.locator('[data-action="edit-edge"]').click();
        await page.locator('[data-road-form] select[name="status"]').selectOption(originalStatus);
        await page.locator('[data-road-form] select[name="congestion"]').selectOption(originalCongestion);
        await page.locator('[data-road-form] textarea[name="warning"]').fill(originalWarning);
        await page.locator('[data-road-form] button[type="submit"]').click();
        await page.waitForFunction(expected => !document.querySelector('[data-edge-note]')?.textContent.includes('自动验收警告'), originalWarning);
        console.log('Management browser verification passed');
    } finally {
        await page.close();
    }
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
        await mobile.goto(`${baseUrl}/ops?gis=1`, { waitUntil: 'networkidle' });
        await mobile.waitForSelector('[data-boot="ready"]');
        await mobile.locator('[data-poi-manager]').click();
        const layout = await mobile.evaluate(() => {
            const rect = document.querySelector('[data-poi-dialog]').getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
        });
        assert.ok(layout.left >= 0 && layout.right <= layout.width, JSON.stringify(layout));
        assert.ok(layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout));
    } finally {
        await mobile.close();
        await browser.close();
    }
}

verify().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
