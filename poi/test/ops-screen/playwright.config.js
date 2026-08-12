const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: __dirname,
    testMatch: 'pages.spec.js',
    timeout: 20000,
    use: {
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 1920, height: 1080 },
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'node scripts/serve-sjp-demo.js',
        cwd: path.resolve(__dirname, '../..'),
        port: 4173,
        reuseExistingServer: true
    }
});
