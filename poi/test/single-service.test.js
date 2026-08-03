'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const POI_ROOT = path.resolve(__dirname, '..');
const TEST_ADMIN_PASSWORD = 'phase5-password-2026';
const TEST_ADMIN_PASSWORD_HASH = '$scrypt$v=1$ln=15,r=8,p=3$'
    + 'cGhhc2U1LXRlc3Qtc2FsdA$SfaAtmf0OyIUgNuRkV16XX6BdcUReNmk4eFLEPxP2a4';

function countOf(source, pattern) {
    return (source.match(pattern) || []).length;
}

function responseCookies(response) {
    if (typeof response.headers.getSetCookie === 'function') {
        return response.headers.getSetCookie();
    }
    const value = response.headers.get('set-cookie');
    return value ? [value] : [];
}

function cookiePair(setCookie) {
    return String(setCookie || '').split(';', 1)[0];
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
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    const timedOut = new Promise(resolve => setTimeout(() => resolve('timeout'), 3000));
    if (
        await Promise.race([exited, timedOut]) === 'timeout'
        && child.exitCode === null
        && child.signalCode === null
    ) {
        const forcedExit = once(child, 'exit');
        child.kill('SIGKILL');
        await forcedExit;
    }
}

test('POI server contains one production runtime and attaches GeoSync before listen', async () => {
    const source = await readFile(path.join(POI_ROOT, 'server.js'), 'utf8');
    const geosyncSource = await readFile(path.join(POI_ROOT, 'geosync', 'index.js'), 'utf8');
    const portalSource = await readFile(path.join(POI_ROOT, 'portal.html'), 'utf8');
    const legacyEntrySources = await Promise.all(
        ['index.html', 'admin.html', 'chat.html']
            .map(fileName => readFile(path.join(POI_ROOT, fileName), 'utf8'))
    );
    assert.equal(countOf(source, /mongoose\.connect\s*\(/g), 1);
    assert.match(
        source,
        /monitorInitialMongoConnection\(mongoose\.connect\(CONFIG\.mongoUri/,
        'the single Mongo connection must be covered by the startup failure policy'
    );
    assert.equal(countOf(source, /http\.createServer\s*\(/g), 1);
    assert.equal(countOf(source, /new Server\s*\(/g), 1);
    assert.equal(countOf(source, /server\.listen\s*\(/g), 1);
    assert.match(source, /nodeEnv:\s*String\(process\.env\.NODE_ENV[^\n]+toLowerCase\(\)/);
    assert.match(source, /production:\s*CONFIG\.nodeEnv\s*===\s*'production'/);

    const oauthCallbackAt = source.indexOf("app.get('/auth/wechat/callback'");
    const oauthQrAt = source.indexOf("app.get('/auth/wechat/qr'", oauthCallbackAt);
    assert.ok(oauthCallbackAt >= 0 && oauthQrAt > oauthCallbackAt);
    const oauthCallbackSource = source.slice(oauthCallbackAt, oauthQrAt);
    assert.equal(countOf(oauthCallbackSource, /oauthStateStore\.reserve\s*\(/g), 2);
    assert.equal(countOf(oauthCallbackSource, /oauthStateStore\.commit\s*\(/g), 2);
    assert.doesNotMatch(oauthCallbackSource, /oauthStateStore\.consume\s*\(/);
    const oauthUserValidationAt = oauthCallbackSource.indexOf('await ensureOAuthUser(openid)');
    const oauthFirstCommitAt = oauthCallbackSource.indexOf('oauthStateStore.commit(');
    assert.ok(
        oauthUserValidationAt >= 0 && oauthFirstCommitAt > oauthUserValidationAt,
        'OAuth state must not commit before upstream identity and user validation'
    );
    const oauthInvalidIdentityAt = oauthCallbackSource.indexOf('if (!openid');
    assert.doesNotMatch(
        oauthCallbackSource.slice(oauthInvalidIdentityAt, oauthUserValidationAt),
        /qrSessions\.delete/,
        'an upstream identity failure must not delete the retryable QR session'
    );
    const oauthCatchAt = oauthCallbackSource.indexOf('} catch (e) {');
    const oauthFinallyAt = oauthCallbackSource.indexOf('} finally {', oauthCatchAt);
    assert.ok(oauthCatchAt >= 0 && oauthFinallyAt > oauthCatchAt);
    assert.doesNotMatch(
        oauthCallbackSource.slice(oauthCatchAt, oauthFinallyAt),
        /qrSessions\.delete/,
        'an OAuth exception must not delete the retryable QR session'
    );
    assert.ok(
        oauthCallbackSource.indexOf('clearOAuthStateCookie(res)')
            > oauthCallbackSource.lastIndexOf('oauthStateStore.commit('),
        'the browser state cookie must remain available until commit succeeds'
    );
    assert.match(
        oauthCallbackSource,
        /finally\s*\{\s*if \(stateReservation\) oauthStateStore\.release\(stateReservation\)/,
        'failed OAuth exchanges must release their state reservation'
    );
    assert.doesNotMatch(source, /redirectWithOpenId/,
        'OAuth redirects must not serialize OpenID into the portal URL');
    assert.match(oauthCallbackSource, /res\.redirect\(committedFlow\.redirect\)/,
        'the browser callback must redirect only to the committed safe target');

    const authStatusAt = source.indexOf("app.get('/auth/status'");
    const socketAuthAt = source.indexOf('function normalizeSocketString', authStatusAt);
    assert.ok(authStatusAt >= 0 && socketAuthAt > authStatusAt);
    const authStatusSource = source.slice(authStatusAt, socketAuthAt);
    assert.match(authStatusSource, /res\.json\(\{\s*status:\s*'ok'\s*\}\)/,
        'QR completion must return only an opaque success status');
    assert.doesNotMatch(authStatusSource, /res\.json\(\{[^}]*openid/i,
        'QR polling must not serialize OpenID');

    assert.match(portalSource, /\/api\/auth\/session\?_t=/,
        'the portal must bootstrap identity from the signed server session');
    assert.doesNotMatch(portalSource, /params\.get\(\s*['"]openid['"]\s*\)/i);
    assert.doesNotMatch(portalSource, /searchParams\.set\(\s*['"]openid['"]/i);
    assert.doesNotMatch(
        portalSource,
        /localStorage\.(?:getItem|setItem)\(\s*['"]user_?openid['"]/i
    );
    assert.doesNotMatch(portalSource, /\bonOpenId\b|\bdata\.openid\b/);
    const portalLogoutAt = portalSource.indexOf('async function handleLogout()');
    const portalRenderAt = portalSource.indexOf('\n      return (', portalLogoutAt);
    assert.ok(portalLogoutAt >= 0 && portalRenderAt > portalLogoutAt,
        'portal must define a bounded async logout handler');
    const portalLogoutSource = portalSource.slice(portalLogoutAt, portalRenderAt);
    assert.match(portalLogoutSource, /fetch\(['"]\/api\/auth\/logout['"][\s\S]*?method:\s*['"]POST['"]/,
        'portal logout must ask the server to clear the signed session');
    assert.match(portalLogoutSource,
        /serverLogoutConfirmed\s*\?\s*['"]anonymous['"]\s*:\s*['"]unavailable['"]/,
        'an unconfirmed server logout must remain observable');
    assert.match(portalLogoutSource, /setOpenId\(['"]['"]\)/,
        'portal logout must clear the in-memory identity');
    assert.doesNotMatch(portalSource, /io\(\s*\{\s*query:\s*\{\s*openId/i,
        'Socket authentication must use the signed cookie, not an OpenID query');
    assert.doesNotMatch(portalSource,
        /\/api\/(?:poi\/my|notifications|chat\/rooms|chat\/history)[^\s'"`]*openId/i,
        'signed user APIs must not copy OpenID into request URLs');
    assert.doesNotMatch(portalSource, /formData\.append\(\s*['"]userOpenId['"]/i);
    assert.doesNotMatch(portalSource, /JSON\.stringify\(\{[^\n}]*\bopenId\b/i,
        'signed user APIs must not duplicate OpenID in JSON bodies');
    assert.doesNotMatch(portalSource, /emit\(\s*['"]chatMessage['"][^\n}]*\bopenId\b/i);
    for (const legacyEntrySource of legacyEntrySources) {
        assert.match(legacyEntrySource, /localStorage\.removeItem\(\s*['"]user_openid['"]\s*\)/);
        assert.match(legacyEntrySource, /localStorage\.removeItem\(\s*['"]userOpenId['"]\s*\)/);
        assert.doesNotMatch(legacyEntrySource, /params\.get\(\s*['"]openid['"]\s*\)/i);
        assert.doesNotMatch(legacyEntrySource, /searchParams\.set\(\s*['"]openid['"]/i);
        assert.doesNotMatch(
            legacyEntrySource,
            /localStorage\.(?:getItem|setItem)\(\s*['"]user_?openid['"]/i
        );
    }
    assert.match(portalSource, /serviceHost:\s*`\$\{window\.location\.origin\}\/\_AMapService`/);
    assert.doesNotMatch(portalSource, /securityJsCode|config\?\.amap\?\.securityCode/);
    assert.doesNotMatch(source, /AMAP_SEC|securityCode/);
    assert.match(
        portalSource,
        /sessionStatus === 'anonymous'[\s\S]+\/auth\/wechat/,
        'the portal must start OAuth only after session bootstrap confirms anonymity'
    );

    const requireAt = source.indexOf("require('./geosync')");
    const poiSchemaExtensionAt = source.indexOf('addHostPoiGeoSyncFields(poiSchema)');
    const poiModelAt = source.indexOf("mongoose.model('POI', poiSchema)");
    const attachAt = source.indexOf('geosync.attach({');
    const shutdownAt = source.indexOf('installGracefulShutdown({');
    const staticAt = source.indexOf('app.use(express.static(publicRoot');
    const listenAt = source.indexOf('server.listen(');
    assert.ok(requireAt >= 0, 'GeoSync must be loaded from poi/geosync');
    assert.match(source,
        /const runtimeAutoIndexEnabled = CONFIG\.nodeEnv !== 'production';/,
        'runtime index creation must remain enabled outside production');
    assert.match(source,
        /mongoose\.set\('autoIndex', runtimeAutoIndexEnabled\);/,
        'the global Mongoose autoIndex policy must use the environment gate');
    assert.match(source,
        /mongoose\.connect\(CONFIG\.mongoUri,\s*\{[\s\S]*?autoIndex: runtimeAutoIndexEnabled[\s\S]*?\}\)/,
        'the connection must receive the same production autoIndex policy');
    assert.ok(
        poiSchemaExtensionAt > requireAt && poiModelAt > poiSchemaExtensionAt,
        'the host POI schema must receive GeoSync fields before model compilation'
    );
    assert.doesNotMatch(source, /mongoose\.model\(['"]AdminUser['"]|adminUserSchema/,
        'the runtime must not compile a disconnected administrator credential store');
    assert.doesNotMatch(source, /@alicloud\/ocr20191230|RecognizeCharacterRequest|recognizeCharacter\(/,
        'the retired OCR SDK and its vulnerable dependency chain must not return');
    assert.match(source, /passwordHash:\s*process\.env\.ADMIN_PASSWORD_HASH/);
    assert.doesNotMatch(source, /timingSafeEqualText\([^\n]*password/,
        'administrator passwords must be verified by the configured KDF');
    assert.ok(attachAt > requireAt, 'GeoSync must be attached after it is loaded');
    assert.ok(attachAt < staticAt, 'GeoSync API routes must be mounted before static files');
    assert.doesNotMatch(source, /express\.static\(__dirname/,
        'the repository root must never be a generic public static directory');
    assert.match(source, /const publicRoot = path\.join\(__dirname, 'public'\)/);
    assert.ok(attachAt < listenAt, 'GeoSync must be attached before server.listen');
    assert.ok(
        shutdownAt > attachAt && shutdownAt < listenAt,
        'graceful shutdown must be installed after GeoSync attachment and before server.listen'
    );
    assert.match(source, /express\.json\(\{ limit: '1mb' \}\)/);
    assert.match(source, /express\.urlencoded\(\{ limit: '1mb', extended: true \}\)/);
    assert.doesNotMatch(source, /limit:\s*['"]50mb['"]/i);
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/admin\/geosync\/gis\/status', requireAdmin, wrap\(async/,
        'admin GIS status must use the async route error boundary'
    );
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/geosync\/health', wrap\(createHealthHandler\(/,
        'GeoSync health must use the async route error boundary'
    );
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/geosync\/health\/live', createLivenessHandler\(\)\)/,
        'GeoSync must expose a dependency-free liveness probe'
    );
    assert.match(
        geosyncSource,
        /app\.get\('\/api\/geosync\/health\/ready', wrap\(createReadinessHandler\(/,
        'GeoSync must expose the host-aware readiness probe'
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
            NODE_ENV: 'test',
            PUBLIC_HOST: `http://127.0.0.1:${port}`,
            CORS_ORIGIN: `http://127.0.0.1:${port}`,
            MONGO_URI: 'mongodb://127.0.0.1:1/poi_phase1_smoke',
            MONGO_STARTUP_FAIL_FAST: 'false',
            ADMIN_TOKEN: '',
            ADMIN_USERNAME: 'phase1-admin',
            ADMIN_PASSWORD: '',
            ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
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
            AMAP_KEY: 'public-amap-test-key',
            AMAP_SEC: 'legacy-jscode-must-not-be-exposed',
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
        const oldConfig = await oldConfigResponse.json();
        assert.equal(oldConfig.success, true);
        assert.deepEqual(oldConfig.amap, { key: 'public-amap-test-key' });
        const serializedOldConfig = JSON.stringify(oldConfig);
        for (const forbidden of [
            'securityCode', 'securityJsCode', 'AMAP_SEC', 'jscode',
            'legacy-jscode-must-not-be-exposed'
        ]) {
            assert.equal(serializedOldConfig.includes(forbidden), false);
        }

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
        assert.deepEqual(health, { state: 'offline' });

        const liveResponse = await fetch(`${base}/api/geosync/health/live`);
        assert.equal(liveResponse.status, 200);
        assert.deepEqual(await liveResponse.json(), { state: 'live', live: true });

        const readyResponse = await fetch(`${base}/api/geosync/health/ready`);
        assert.equal(readyResponse.status, 503);
        const ready = await readyResponse.json();
        assert.equal(ready.ready, false);
        assert.equal(ready.mongoReady, false);
        assert.equal(ready.geosyncReady, false);

        const adminResponse = await fetch(`${base}/api/admin/geosync/dashboard`);
        assert.equal(adminResponse.status, 403);
        const gisAdminResponse = await fetch(`${base}/api/admin/geosync/gis/status`);
        assert.equal(gisAdminResponse.status, 403);
        const gisRouteTestResponse = await fetch(`${base}/api/admin/geosync/gis/route-test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                start: [120, 30], end: [120.001, 30.001], mode: 'normal'
            })
        });
        assert.equal(gisRouteTestResponse.status, 403);
        const oversizedJsonResponse = await fetch(`${base}/api/admin/geosync/gis/route-test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })
        });
        assert.equal(oversizedJsonResponse.status, 413);
        const loginResponse = await fetch(`${base}/api/admin/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'phase1-admin', password: TEST_ADMIN_PASSWORD })
        });
        assert.equal(loginResponse.status, 503);
        assert.equal(Object.hasOwn(await loginResponse.json(), 'token'), false);

        for (const publicPath of ['/', '/index.html', '/portal.html?v=test', '/admin.html', '/chat.html']) {
            const response = await fetch(`${base}${publicPath}`);
            assert.equal(response.status, 200, `${publicPath} must remain publicly available`);
        }
        const portalHeadResponse = await fetch(`${base}/portal.html`, { method: 'HEAD' });
        assert.equal(portalHeadResponse.status, 200);
        const socketClientResponse = await fetch(`${base}/socket.io/socket.io.js`);
        assert.equal(socketClientResponse.status, 200);
        for (const privatePath of [
            '/server.js',
            '/package.json',
            '/geosync/index.js',
            '/test/fixtures/private.html',
            '/node_modules/bignumber.js/doc/API.html',
            '/login.png',
            '/focous.png'
        ]) {
            const response = await fetch(`${base}${privatePath}`);
            assert.equal(response.status, 404, `${privatePath} must not be publicly served`);
        }

        assert.doesNotMatch(output, /OverwriteModelError|Cannot find module|EADDRINUSE/);
    } finally {
        await stopChild(child);
    }
});

test('production refuses a non-origin public host or an explicit Secure-cookie downgrade', {
    timeout: 10000
}, async () => {
    const cases = [
        { publicHost: 'http://127.0.0.1:3000', cookieSecure: '' },
        { publicHost: 'https://example.test', cookieSecure: 'false' },
        { publicHost: 'https://reviewer:public-host-password@example.test', cookieSecure: '' },
        { publicHost: 'https://example.test/oauth', cookieSecure: '' },
        { publicHost: 'https://example.test?next=portal', cookieSecure: '' },
        { publicHost: 'https://example.test/#fragment', cookieSecure: '' }
    ];

    for (const [index, testCase] of cases.entries()) {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: POI_ROOT,
            windowsHide: true,
            env: {
                ...process.env,
                PORT: String(await reservePort()),
                HOST: '127.0.0.1',
                NODE_ENV: 'production',
                PUBLIC_HOST: testCase.publicHost,
                CORS_ORIGIN: testCase.publicHost,
                AUTH_COOKIE_SECURE: testCase.cookieSecure,
                AUTH_SESSION_SECRET: 'cookie-gate-session-secret-Q7m2V9x4K6p1R8c3N5h0',
                ADMIN_PASSWORD: '',
                ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
                MONGO_URI: `mongodb://127.0.0.1:1/poi_cookie_gate_${index}`
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });

        try {
            const exit = once(child, 'exit');
            const timeout = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('insecure production process did not exit')), 5000);
            });
            const [code, signal] = await Promise.race([exit, timeout]);
            assert.equal(code, 1);
            assert.equal(signal, null);
            assert.match(output, /AUTH_COOKIE_SECURE_REQUIRED/);
            assert.doesNotMatch(output,
                /cookie-gate-session-secret|poi_cookie_gate|public-host-password|next=portal/);
        } finally {
            await stopChild(child);
        }
    }
});

test('production Mongo initial connection failure exits with sanitized diagnostics by default', {
    timeout: 15000
}, async () => {
    const port = await reservePort();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: POI_ROOT,
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: 'production',
            PUBLIC_HOST: `https://127.0.0.1:${port}`,
            CORS_ORIGIN: `https://127.0.0.1:${port}`,
            MONGO_URI: 'mongodb://sensitive-user:sensitive-password@127.0.0.1:1/poi_fail_fast',
            MONGO_STARTUP_FAIL_FAST: '',
            AUTH_SESSION_SECRET: 'fail-fast-session-secret-Q7m2V9x4K6p1R8c3N5h0',
            AUTH_SIGN_REQUIRED: 'true',
            AUTH_COOKIE_SECURE: '',
            ADMIN_TOKEN: '',
            ADMIN_USERNAME: 'fail-fast-admin',
            ADMIN_PASSWORD: '',
            ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
            GEOSYNC_BACKGROUND_ENABLED: 'false',
            SUPERMAP_ENABLED: 'false',
            SCENIC_ID: 'fail-fast-test',
            SCENIC_CENTER: '120,30',
            POSITION_HMAC_SECRET: 'fail-fast-position-secret-N8p3V6c1Q9m4K7x2',
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
        const exit = once(child, 'exit');
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('production process did not fail fast')), 12000);
        });
        const [code, signal] = await Promise.race([exit, timeout]);
        assert.equal(code, 1);
        assert.equal(signal, null);
        assert.match(output, /MongoDB initial connection failed/);
        assert.match(output, /MONGO_STARTUP_FAILED/);
        assert.doesNotMatch(output, /sensitive-user|sensitive-password|poi_fail_fast/);
    } finally {
        await stopChild(child);
    }
});

test('legacy plaintext administrator password disables login without leaking secrets', {
    timeout: 20000
}, async () => {
    const port = await reservePort();
    const legacyPassword = 'legacy-admin-password-secret-sentinel';
    const adminCredential = 'legacy-test-admin-token-R8m3Q7v2N9x5K4p6D1s0F7h2';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: POI_ROOT,
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: 'test',
            PUBLIC_HOST: `http://127.0.0.1:${port}`,
            CORS_ORIGIN: `http://127.0.0.1:${port}`,
            MONGO_URI: 'mongodb://127.0.0.1:1/poi_legacy_admin_password_test',
            MONGO_STARTUP_FAIL_FAST: 'false',
            AUTH_SESSION_SECRET: 'legacy-password-session-secret-Q7m2V9x4K6p1R8c3',
            AUTH_SIGN_REQUIRED: 'true',
            AUTH_COOKIE_SECURE: 'false',
            ADMIN_TOKEN: adminCredential,
            ADMIN_USERNAME: 'legacy-password-admin',
            ADMIN_PASSWORD: legacyPassword,
            ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
            GEOSYNC_BACKGROUND_ENABLED: 'false',
            SUPERMAP_ENABLED: 'false',
            SCENIC_ID: 'legacy-password-test',
            SCENIC_CENTER: '120,30',
            POSITION_HMAC_SECRET: 'legacy-password-position-secret-N8p3V6c1Q9m4',
            WX_APPID: '',
            WX_SECRET: '',
            ALIYUN_AK: '',
            ALIYUN_SK: '',
            SMTP_HOST: '',
            SMTP_USER: '',
            SMTP_PASS: '',
            AMAP_KEY: '',
            AMAP_SEC: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        const base = `http://127.0.0.1:${port}`;
        await waitForResponse(`${base}/api/client-config`);
        const login = await fetch(`${base}/api/admin/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                username: 'legacy-password-admin',
                password: TEST_ADMIN_PASSWORD
            })
        });
        assert.equal(login.status, 503);
        assert.equal(Object.hasOwn(await login.json(), 'token'), false);

        const recovery = await fetch(`${base}/api/admin/geosync/gis/status`, {
            headers: { authorization: `Bearer ${adminCredential}` }
        });
        assert.equal(recovery.status, 200);
        assert.match(output, /ADMIN_PASSWORD_PLAINTEXT_FORBIDDEN/);
        assert.doesNotMatch(output, new RegExp(legacyPassword));
        assert.equal(output.includes(TEST_ADMIN_PASSWORD_HASH), false);
    } finally {
        await stopChild(child);
    }
});

test('configured host auth uses HttpOnly cookies and rejects unsafe credential transports', {
    timeout: 25000
}, async () => {
    const port = await reservePort();
    const adminCredential = 'integration-admin-cred-R8m3Q7v2N9x5K4p6D1s0';
    const screenCredential = 'integration-screen-cred-Q7n2C9v5B4m8L1s6H3k0';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: POI_ROOT,
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: 'test',
            PUBLIC_HOST: `http://127.0.0.1:${port}`,
            CORS_ORIGIN: `http://127.0.0.1:${port}`,
            MONGO_URI: 'mongodb://127.0.0.1:1/poi_phase5_auth_smoke',
            MONGO_STARTUP_FAIL_FAST: 'false',
            AUTH_SESSION_SECRET: 'integration-session-secret-Z9x4P2m8V6c1R7k5Q3h0',
            AUTH_SIGN_REQUIRED: 'true',
            AUTH_COOKIE_SECURE: '',
            AUTH_FLOW_MAX_PENDING_PER_NETWORK: '2',
            ADMIN_TOKEN: adminCredential,
            ADMIN_USERNAME: 'phase5-admin',
            ADMIN_PASSWORD: '',
            ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
            SCREEN_TOKEN: screenCredential,
            SCREEN_SESSION_TTL_S: '120',
            GEOSYNC_BACKGROUND_ENABLED: 'false',
            SUPERMAP_ENABLED: 'true',
            SUPERMAP_MANIFEST_PATH: './config/supermap-manifest.test-missing.json',
            SCENIC_ID: 'phase5-auth-test',
            SCENIC_CENTER: '120,30',
            POSITION_HMAC_SECRET: 'integration-position-secret-M8q2V4c7N9x1K5p3',
            WX_APPID: 'phase5-wechat-app',
            WX_SECRET: 'phase5-wechat-secret',
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
        await waitForResponse(`${base}/api/client-config`);

        const queryCredential = await fetch(
            `${base}/api/admin/geosync/gis/status?adminToken=${encodeURIComponent(adminCredential)}`
        );
        assert.equal(queryCredential.status, 403);

        const bodyCredential = await fetch(`${base}/api/admin/geosync/gis/route-test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                adminToken: adminCredential,
                start: [120, 30],
                end: [120.001, 30.001],
                mode: 'normal'
            })
        });
        assert.equal(bodyCredential.status, 403);

        const bearerResponse = await fetch(`${base}/api/admin/geosync/gis/status`, {
            headers: { authorization: `Bearer ${adminCredential}` }
        });
        assert.equal(bearerResponse.status, 200);

        const publicHealth = await fetch(`${base}/api/geosync/health`);
        assert.equal(publicHealth.status, 503);
        assert.deepEqual(await publicHealth.json(), { state: 'offline' });
        const privateHealthDenied = await fetch(`${base}/api/admin/geosync/health`);
        assert.equal(privateHealthDenied.status, 403);
        const privateHealth = await fetch(`${base}/api/admin/geosync/health`, {
            headers: { authorization: `Bearer ${adminCredential}` }
        });
        assert.equal(privateHealth.status, 503);
        const privateHealthBody = await privateHealth.json();
        assert.equal(['connecting', 'offline'].includes(privateHealthBody.mongo.state), true);
        assert.equal(privateHealthBody.gis.error.code, 'SUPERMAP_MANIFEST_NOT_FOUND');

        for (let attempt = 0; attempt < 10; attempt++) {
            const failedLogin = await fetch(`${base}/api/admin/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'unknown-admin', password: `wrong-${attempt}` })
            });
            assert.equal(failedLogin.status, 401);
        }
        const throttledLogin = await fetch(`${base}/api/admin/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'unknown-admin', password: 'wrong-final' })
        });
        assert.equal(throttledLogin.status, 429);
        assert.ok(Number(throttledLogin.headers.get('retry-after')) >= 1);

        const loginResponse = await fetch(`${base}/api/admin/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'phase5-admin', password: TEST_ADMIN_PASSWORD })
        });
        assert.equal(loginResponse.status, 200);
        const loginBody = await loginResponse.json();
        assert.equal(loginBody.success, true);
        assert.equal(loginBody.token, 'cookie-session');
        assert.equal(JSON.stringify(loginBody).includes(adminCredential), false);

        const adminSetCookie = responseCookies(loginResponse)
            .find(value => value.startsWith('poi_admin_session='));
        assert.ok(adminSetCookie);
        assert.match(adminSetCookie, /HttpOnly/);
        assert.match(adminSetCookie, /SameSite=Lax/);
        assert.doesNotMatch(adminSetCookie, /(?:^|;\s*)Secure(?:;|$)/i,
            'blank AUTH_COOKIE_SECURE must derive false from an HTTP PUBLIC_HOST');
        assert.doesNotMatch(adminSetCookie, new RegExp(adminCredential));
        const adminCookie = cookiePair(adminSetCookie);

        const markerOnly = await fetch(`${base}/api/admin/geosync/gis/status`, {
            headers: { authorization: 'Bearer cookie-session' }
        });
        assert.equal(markerOnly.status, 403);

        const cookieSession = await fetch(`${base}/api/admin/geosync/gis/status`, {
            headers: {
                authorization: 'Bearer cookie-session',
                cookie: adminCookie
            }
        });
        assert.equal(cookieSession.status, 503,
            'signed admin sessions must fail closed while revocation storage is unavailable');

        const screenBootstrap = await fetch(`${base}/api/admin/screen/session`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${adminCredential}`
            }
        });
        assert.equal(screenBootstrap.status, 200);
        const screenBody = await screenBootstrap.json();
        assert.deepEqual(screenBody, { success: true, expiresInSec: 120 });
        assert.equal(JSON.stringify(screenBody).includes(screenCredential), false);
        const screenSetCookie = responseCookies(screenBootstrap)
            .find(value => value.startsWith('poi_screen_token='));
        assert.ok(screenSetCookie);
        assert.match(screenSetCookie, /Path=\/api\/screen/);
        assert.match(screenSetCookie, /Max-Age=120/);
        assert.match(screenSetCookie, /HttpOnly/);
        assert.doesNotMatch(screenSetCookie, /(?:^|;\s*)Secure(?:;|$)/i);
        assert.doesNotMatch(screenSetCookie, new RegExp(screenCredential));
        const screenCookie = cookiePair(screenSetCookie);

        const queryScreen = await fetch(
            `${base}/api/screen/stream?screenToken=${encodeURIComponent(screenCredential)}`
        );
        assert.equal(queryScreen.status, 403);

        const streamResponse = await fetch(`${base}/api/screen/stream`, {
            headers: { cookie: screenCookie }
        });
        assert.equal(streamResponse.status, 200);
        assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
        await streamResponse.body.cancel();

        const screenHealth = await fetch(`${base}/api/screen/geosync/health`, {
            headers: { cookie: screenCookie }
        });
        assert.equal(screenHealth.status, 503);
        assert.equal(['connecting', 'offline'].includes(
            (await screenHealth.json()).mongo.state
        ), true);

        const screenLogout = await fetch(`${base}/api/admin/screen/logout`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${adminCredential}`
            }
        });
        assert.equal(screenLogout.status, 200);
        const clearedScreenCookie = responseCookies(screenLogout)
            .find(value => value.startsWith('poi_screen_token='));
        assert.ok(clearedScreenCookie);
        assert.match(clearedScreenCookie, /Path=\/api\/screen/);
        assert.match(clearedScreenCookie, /Max-Age=0/);

        const adminLogout = await fetch(`${base}/api/admin/logout`, {
            method: 'POST',
            headers: { cookie: adminCookie }
        });
        assert.equal(adminLogout.status, 503);
        assert.equal(responseCookies(adminLogout).some(value =>
            value.startsWith('poi_admin_session=')), false,
        'logout must not clear the browser cookie until persistent revocation succeeds');

        const oauthStart = await fetch(`${base}/auth/wechat?redirect=/portal.html`, {
            redirect: 'manual'
        });
        assert.equal(oauthStart.status, 302);
        const oauthCookieHeader = responseCookies(oauthStart)
            .find(value => value.startsWith('poi_oauth_state='));
        assert.ok(oauthCookieHeader);
        assert.match(oauthCookieHeader, /HttpOnly/);
        assert.match(oauthCookieHeader, /Path=\/auth\/wechat\/callback/);
        assert.doesNotMatch(oauthCookieHeader, /(?:^|;\s*)Secure(?:;|$)/i);
        const oauthLocation = new URL(oauthStart.headers.get('location'));
        const oauthState = oauthLocation.searchParams.get('state');
        assert.ok(oauthState && oauthState.length >= 32);
        assert.notEqual(oauthState, 'STATE');

        const wrongState = await fetch(
            `${base}/auth/wechat/callback?code=fake&state=wrong-state`,
            { headers: { cookie: cookiePair(oauthCookieHeader) } }
        );
        assert.equal(wrongState.status, 400);
        assert.equal(responseCookies(wrongState).length, 0);

        const qrResponse = await fetch(`${base}/auth/wechat/qr`);
        assert.equal(qrResponse.status, 200);
        assert.equal(qrResponse.headers.get('cache-control'), 'no-store');
        const qrClaimSetCookie = responseCookies(qrResponse)
            .find(value => value.startsWith('poi_qr_login_claim='));
        assert.ok(qrClaimSetCookie);
        assert.match(qrClaimSetCookie, /HttpOnly/);
        assert.match(qrClaimSetCookie, /SameSite=Strict/);
        assert.match(qrClaimSetCookie, /Path=\/auth\/status/);
        assert.doesNotMatch(qrClaimSetCookie, /(?:^|;\s*)Secure(?:;|$)/i);
        const qrBody = await qrResponse.json();
        assert.match(qrBody.sid, /^[a-f0-9]{32}$/);
        const qrAuthorizeUrl = new URL(qrBody.qrUrl);
        const qrState = qrAuthorizeUrl.searchParams.get('state');
        assert.ok(qrState && qrState.length >= 32);
        assert.notEqual(qrState, 'qr');
        const qrCallbackUrl = new URL(qrAuthorizeUrl.searchParams.get('redirect_uri'));
        assert.equal(qrCallbackUrl.searchParams.get('sid'), qrBody.sid);

        const unboundQrStatus = await fetch(
            `${base}/auth/status?sid=${encodeURIComponent(qrBody.sid)}`
        );
        assert.equal(unboundQrStatus.status, 403);
        const boundQrStatus = await fetch(
            `${base}/auth/status?sid=${encodeURIComponent(qrBody.sid)}`,
            { headers: { cookie: cookiePair(qrClaimSetCookie) } }
        );
        assert.equal(boundQrStatus.status, 200);
        assert.deepEqual(await boundQrStatus.json(), { status: 'pending' });

        const quotaBlocked = await fetch(`${base}/auth/wechat?redirect=/portal.html`, {
            redirect: 'manual'
        });
        assert.equal(quotaBlocked.status, 429,
            'browser and QR flows from one network must share the pending quota');
        const retryAfter = Number(quotaBlocked.headers.get('retry-after'));
        assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 300);

        assert.doesNotMatch(output, new RegExp(adminCredential));
        assert.doesNotMatch(output, new RegExp(screenCredential));
    } finally {
        await stopChild(child);
    }
});
