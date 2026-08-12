const { test, expect } = require('@playwright/test');

test('ops closure waits for graph update and completes the observable loop', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/ops?demo=1');
    await expect(page.locator('[data-status="health"] em')).toHaveText('正常');
    await page.getByRole('button', { name: /选择路段 樱花大道关键段/ }).click();
    await expect(page.locator('[data-edge-name]')).toHaveText('樱花大道关键段');
    await page.locator('[data-action="close"]').click();
    await page.locator('textarea[name="reason"]').fill('临时施工');
    await page.locator('[data-dialog-submit]').click();
    await expect(page.locator('[data-edge-status]')).toHaveText('处理中');
    await expect(page.locator('[data-edge-status]')).toHaveText('已关闭', { timeout: 3000 });
    await expect(page.locator('[data-proposal="accepted"]')).toHaveText('1', { timeout: 4000 });
    await page.locator('[data-action="open"]').click();
    await page.locator('[data-dialog-submit]').click();
    await expect(page.locator('[data-edge-status]')).toHaveText('正常通行', { timeout: 3000 });
    expect(await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
    }))).toEqual({ width: 1920, height: 1080, viewportWidth: 1920, viewportHeight: 1080 });
    expect(errors).toEqual([]);
});

test('screen uses one frame renderer for replay and fits 1920 by 1080', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/screen?demo=1');
    await expect(page.locator('[data-screen-connection]')).toContainText('实时已连接');
    await page.locator('[data-screen-mode="replay"]').click();
    await expect(page.locator('.screen-shell')).toHaveAttribute('data-mode', 'replay');
    await expect(page.locator('[data-replay-range]')).toHaveAttribute('max', '6');
    await page.locator('[data-replay-range]').fill('2');
    await expect(page.locator('[data-frame-missing]')).toBeVisible();
    await page.locator('[data-replay-play]').click();
    await expect(page.locator('[data-replay-play]')).toHaveAttribute('aria-label', '暂停');
    expect(await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
    }))).toEqual({ width: 1920, height: 1080, viewportWidth: 1920, viewportHeight: 1080 });
    expect(errors).toEqual([]);
});
