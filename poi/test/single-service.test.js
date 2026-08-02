'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const POI_ROOT = path.resolve(__dirname, '..');

function countOf(source, pattern) {
    return (source.match(pattern) || []).length;
}

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForResponse(url, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await fetch(url);
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 75));
        }
    }
    throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForStatus(url, expectedStatus, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let response;
    while (Date.now() < deadline) {
        response = await fetch(url);
        if (response.status === expectedStatus) return response;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for HTTP ${expectedStatus} from ${url}; last status=${response?.status}`);
}

async function stopChild(child) {
    if (child.exitCode !== null) return;
    child.kill();
    const exited = once(child, 'exit');
    const timedOut = new Promise(resolve => setTimeout(() => resolve('timeout'), 3000));
    if (await Promise.race([exited, timedOut]) === 'timeout' && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
    }
}

test('POI server contains one production runtime and attaches GeoSync before listen', async () => {
    const source = await readFile(path.join(POI_ROOT, 'server.js'), 'utf8');
    const geosyncSource = await readFile(path.join(POI_ROOT, 'geosync', 'index.js'), 'utf8');
    assert.equal(countOf(source, /mongoose\.connect\s*\(/g), 1);
    assert.equal(countOf(source, /http\.createServer\s*\(/g), 1);
    assert.equal(countOf(source, /new Server\s*\(/g), 1);
    assert.equal(countOf(source, /server\.listen\s*\(/g), 1);

    const requireAt = source.indexOf("require('./geosync')");
    const attachAt = source.indexOf('geosync.attach({');
    const staticAt = source.indexOf('app.use(express.static(__dirname');
    const listenAt = source.indexOf('server.listen(');
    assert.ok(requireAt >= 0, 'GeoSync must be loaded from poi/geosync');
    assert.ok(attachAt > requireAt, 'GeoSync must be attached after it is loaded');
    assert.ok(attachAt < staticAt, 'GeoSync API routes must be mounted before static files');
    assert.ok(attachAt < listenAt, 'GeoSync must be attached before server.listen');
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/admin\/geosync\/gis\/status', requireAdmin, wrap\(async/,
        'admin GIS status must use the async route error boundary'
    );
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/geosync\/health', wrap\(async/,
        'GeoSync health must use the async route error boundary'
    );
});

test('single POI process serves old and GeoSync endpoints without exposing backend files', {
    timeout: 20000
}, async () => {
    const port = await reservePort();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: POI_ROOT,
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            PUBLIC_HOST: `http://127.0.0.1:${port}`,
            CORS_ORIGIN: `http://127.0.0.1:${port}`,
            MONGO_URI: 'mongodb://127.0.0.1:1/poi_phase1_smoke',
            ADMIN_TOKEN: '',
            ADMIN_USERNAME: 'phase1-admin',
            ADMIN_PASSWORD: 'phase1-password',
            GEOSYNC_BACKGROUND_ENABLED: 'false',
            SUPERMAP_ENABLED: 'true',
            SUPERMAP_MANIFEST_PATH: './config/supermap-manifest.test-missing.json',
            SCENIC_ID: 'phase1-test',
            SCENIC_CENTER: '120,30',
            POSITION_HMAC_SECRET: 'phase1-test-hmac',
            SCREEN_TOKEN: 'phase1-test-screen',
            WX_APPID: '',
            WX_SECRET: '',
            ALIYUN_AK: '',
            ALIYUN_SK: '',
            SMTP_HOST: '',
            SMTP_USER: '',
            SMTP_PASS: '',
            AMAP_KEY: '',
            AMAP_SEC: '',
            ISERVER_USERNAME: '',
            ISERVER_PASSWORD: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        const base = `http://127.0.0.1:${port}`;
        const oldConfigResponse = await waitForResponse(`${base}/api/client-config`);
        assert.equal(oldConfigResponse.status, 200);
        assert.equal((await oldConfigResponse.json()).success, true);

        const geoConfigResponse = await fetch(`${base}/api/geosync/client-config`);
        assert.equal(geoConfigResponse.status, 200);
        const geoConfig = await geoConfigResponse.json();
        assert.equal(geoConfig.success, true);
        assert.equal(geoConfig.data.gis.state, 'offline');
        assert.equal(geoConfig.data.features.supermap, false);
        const serializedConfig = JSON.stringify(geoConfig);
        for (const forbidden of [
            'adminToken', 'mongoUri', 'ISERVER_BASE', 'ISERVER_USERNAME', 'ISERVER_PASSWORD'
        ]) {
            assert.equal(serializedConfig.includes(forbidden), false, `${forbidden} must stay server-side`);
        }

        const healthResponse = await waitForStatus(`${base}/api/geosync/health`, 503);
        const health = await healthResponse.json();
        assert.equal(health.jobsRunning, false);
        assert.equal(['connecting', 'offline'].includes(health.mongo.state), true);
        assert.equal(health.gis.state, 'offline');
        assert.equal(health.gis.error.code, 'SUPERMAP_MANIFEST_NOT_FOUND');

        const adminResponse = await fetch(`${base}/api/admin/geosync/dashboard`);
        assert.equal(adminResponse.status, 403);
        const gisAdminResponse = await fetch(`${base}/api/admin/geosync/gis/status`);
        assert.equal(gisAdminResponse.status, 403);
        const loginResponse = await fetch(`${base}/api/admin/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'phase1-admin', password: 'phase1-password' })
        });
        assert.equal(loginResponse.status, 500);
        assert.equal(Object.hasOwn(await loginResponse.json(), 'token'), false);

        const portalResponse = await fetch(`${base}/portal.html`);
        assert.equal(portalResponse.status, 200);
        const socketClientResponse = await fetch(`${base}/socket.io/socket.io.js`);
        assert.equal(socketClientResponse.status, 200);
        for (const privatePath of ['/server.js', '/package.json', '/geosync/index.js']) {
            const response = await fetch(`${base}${privatePath}`);
            assert.equal(response.status, 404, `${privatePath} must not be publicly served`);
        }

        assert.doesNotMatch(output, /OverwriteModelError|Cannot find module|EADDRINUSE/);
    } finally {
        await stopChild(child);
    }
});
