'use strict';

const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const systemBrowser = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(candidate => fs.existsSync(candidate));

module.exports = defineConfig({
    testDir: __dirname,
    testMatch: '*.spec.js',
    timeout: 30000,
    expect: { timeout: 7000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['line']],
    outputDir: path.join(__dirname, 'test-results'),
    use: {
        baseURL: 'http://127.0.0.1:4177',
        browserName: 'chromium',
        launchOptions: systemBrowser ? { executablePath: systemBrowser } : {},
        viewport: { width: 390, height: 844 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'node test/tour/server.js',
        cwd: path.resolve(__dirname, '..', '..'),
        url: 'http://127.0.0.1:4177/tour?demo=1',
        reuseExistingServer: true,
        timeout: 30000
    }
});
