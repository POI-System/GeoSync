'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const POI_ROOT = path.resolve(__dirname, '..');

function locationBlock(source, route) {
    const marker = `location ${route} {`;
    const start = source.lastIndexOf(marker);
    assert.ok(start >= 0, `missing nginx ${marker}`);
    let depth = 0;
    for (let index = source.indexOf('{', start); index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`unterminated nginx ${marker}`);
}

test('production nginx delegates public files to the Node allowlist', async () => {
    const source = await readFile(path.join(POI_ROOT, 'nginx.conf'), 'utf8');
    const fallback = locationBlock(source, '/');
    const uploads = locationBlock(source, '/uploads/');

    assert.match(fallback, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
    assert.doesNotMatch(fallback, /\broot\s+\/opt\/poi\b|try_files\s+\$uri/);
    assert.doesNotMatch(source, /\broot\s+\/opt\/poi\s*;/);
    assert.match(uploads, /alias\s+\/opt\/poi\/uploads\/;/);
    assert.doesNotMatch(uploads, /autoindex\s+on/);

    for (const privatePath of [
        '/server.js', '/package.json', '/.env', '/geosync/index.js', '/logs/app.log'
    ]) {
        assert.equal(
            source.includes(`try_files ${privatePath}`),
            false,
            `${privatePath} must not receive a direct nginx filesystem rule`
        );
    }
});

test('deployment preflight matches the fixed PM2/Nginx topology and hides private endpoints', async () => {
    const [deploy, nginx, ecosystem, standalone, envTemplate] = await Promise.all([
        readFile(path.join(POI_ROOT, 'deploy.sh'), 'utf8'),
        readFile(path.join(POI_ROOT, 'nginx.conf'), 'utf8'),
        readFile(path.join(POI_ROOT, 'ecosystem.config.js'), 'utf8'),
        readFile(path.join(POI_ROOT, 'geosync', 'standalone.js'), 'utf8'),
        readFile(path.join(POI_ROOT, '.env.example'), 'utf8')
    ]);

    assert.match(deploy, /^readonly PROJECT_DIR=\/opt\/poi$/m);
    assert.doesNotMatch(deploy, /PROJECT_DIR=\$\{PROJECT_DIR/);
    assert.match(ecosystem, /cwd:\s*['"]\/opt\/poi['"]/);
    assert.match(deploy, /TLS_CERT=\/etc\/letsencrypt\/live\/8688988\.xyz\/fullchain\.pem/);
    assert.match(deploy, /TLS_KEY=\/etc\/letsencrypt\/live\/8688988\.xyz\/privkey\.pem/);
    assert.match(nginx, /ssl_certificate\s+\/etc\/letsencrypt\/live\/8688988\.xyz\/fullchain\.pem;/);
    assert.match(nginx, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/8688988\.xyz\/privkey\.pem;/);
    assert.match(deploy, /process\.versions\.node[\s\S]*major < 20/);

    assert.match(standalone, /console\.log\('\[GeoSync\] \[DB\] connected'\)/);
    assert.doesNotMatch(standalone, /console\.(?:log|warn|error)[^\n]*MONGO_URI|MONGO_URI\.replace/);

    for (const name of [
        'GEOSYNC_BACKGROUND_ENABLED', 'TPL_REROUTE', 'ALERT_EMAIL',
        'POSITION_MIN_INTERVAL_S', 'PRESENCE_LEASE_MINUTES', 'CI_SLOT_MINUTES',
        'CI_ALPHA', 'CI_BETA', 'CI_GAMMA', 'REROUTE_GAIN_MIN',
        'REROUTE_DAILY_SOFT_LIMIT', 'CAPACITY_TOKEN_TTL_S',
        'RAIN_API_URL', 'RAIN_API_KEY', 'WEATHER_API_URL', 'WEATHER_API_KEY',
        'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'GEOSYNC_UPLOAD_DIR',
        'DEM_TILE_DIR', 'SIM_MODE', 'SIM_STRATEGY'
    ]) {
        assert.match(envTemplate, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.example`);
    }
});
