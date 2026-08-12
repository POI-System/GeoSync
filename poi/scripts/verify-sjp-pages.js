'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const baseUrl = process.env.SJP_DEMO_URL || 'http://127.0.0.1:4173';
const outputDir = path.resolve(__dirname, '../../outputs/sjp');

async function openCheckedPage(browser, route, viewport) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-boot="ready"]');
    return { page, errors };
}

async function verify() {
    await fs.mkdir(outputDir, { recursive: true });
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.SJP_BROWSER_EXECUTABLE
            ? { executablePath: process.env.SJP_BROWSER_EXECUTABLE }
            : {})
    });
    try {
        const opsDesktop = await openCheckedPage(browser, '/ops?demo=1', { width: 1920, height: 1080 });
        await opsDesktop.page.getByRole('button', { name: /选择路段 樱花大道关键段/ }).click();
        await opsDesktop.page.locator('[data-action="close"]').click();
        await opsDesktop.page.locator('textarea[name="reason"]').fill('临时施工');
        await opsDesktop.page.locator('[data-dialog-submit]').click();
        await opsDesktop.page.waitForFunction(() => document.querySelector('[data-edge-status]')?.textContent === '已关闭');
        await opsDesktop.page.waitForFunction(() => document.querySelector('[data-proposal="accepted"]')?.textContent === '1');
        const opsSize = await opsDesktop.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            width: innerWidth,
            height: innerHeight
        }));
        assert.deepEqual(opsSize, { scrollWidth: 1920, scrollHeight: 1080, width: 1920, height: 1080 });
        assert.deepEqual(opsDesktop.errors, []);
        await opsDesktop.page.screenshot({ path: path.join(outputDir, 'ops-1920x1080.png') });
        await opsDesktop.page.locator('[data-action="open"]').click();
        await opsDesktop.page.locator('[data-dialog-submit]').click();
        await opsDesktop.page.waitForFunction(() => document.querySelector('[data-edge-status]')?.textContent === '正常通行');
        await opsDesktop.page.close();

        const screenDesktop = await openCheckedPage(browser, '/screen?demo=1', { width: 1920, height: 1080 });
        await screenDesktop.page.locator('[data-screen-mode="replay"]').click();
        await screenDesktop.page.waitForTimeout(600);
        const replayStatus = await screenDesktop.page.evaluate(() => ({
            max: document.querySelector('[data-replay-range]')?.max,
            mode: document.querySelector('.screen-shell')?.dataset.mode,
            error: document.querySelector('[data-screen-error]')?.textContent
        }));
        assert.equal(replayStatus.max, '6', JSON.stringify({ replayStatus, errors: screenDesktop.errors }));
        await screenDesktop.page.locator('[data-replay-range]').fill('2');
        assert.equal(await screenDesktop.page.locator('[data-frame-missing]').isVisible(), true);
        const screenSize = await screenDesktop.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            width: innerWidth,
            height: innerHeight
        }));
        assert.deepEqual(screenSize, { scrollWidth: 1920, scrollHeight: 1080, width: 1920, height: 1080 });
        assert.deepEqual(screenDesktop.errors, []);
        await screenDesktop.page.screenshot({ path: path.join(outputDir, 'screen-1920x1080.png') });
        await screenDesktop.page.close();

        for (const [name, route] of [['ops', '/ops?demo=1'], ['screen', '/screen?demo=1']]) {
            const mobile = await openCheckedPage(browser, route, { width: 390, height: 844 });
            const mobileLayout = await mobile.page.evaluate(() => ({
                horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
                scrollHeight: document.documentElement.scrollHeight,
                bodyScrollHeight: document.body.scrollHeight,
                shellHeight: document.querySelector('.screen-shell, .ops-shell')?.getBoundingClientRect().height,
                contentHeight: document.querySelector('.screen-content, .ops-workspace')?.getBoundingClientRect().height,
                railHeight: document.querySelector('.screen-rail, .ops-sidebar')?.getBoundingClientRect().height,
                offenders: [...document.querySelectorAll('*')].map(element => {
                    const rect = element.getBoundingClientRect();
                    return { tag: element.tagName, className: String(element.className || ''), right: Math.round(rect.right), width: Math.round(rect.width) };
                }).filter(item => item.right > innerWidth + 1).sort((a, b) => b.right - a.right).slice(0, 5)
            }));
            const horizontalOverflow = mobileLayout.horizontalOverflow;
            assert.ok(horizontalOverflow <= 1, `${name} mobile horizontal overflow: ${JSON.stringify(mobileLayout)}`);
            assert.ok(mobileLayout.scrollHeight > 844, `${name} mobile content was unexpectedly clipped: ${JSON.stringify(mobileLayout)}`);
            assert.deepEqual(mobile.errors, []);
            await mobile.page.screenshot({ path: path.join(outputDir, `${name}-390x844.png`), fullPage: true });
            await mobile.page.close();
        }
        console.log('Browser verification passed: ops/screen desktop and mobile');
    } finally {
        await browser.close();
    }
}

verify().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
