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
    const api = locationBlock(source, '/api/');
    const auth = locationBlock(source, '/auth/');
    const amap = locationBlock(source, '/_AMapService/');

    assert.match(fallback, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
    assert.doesNotMatch(fallback, /\broot\s+\/opt\/poi\b|try_files\s+\$uri/);
    assert.doesNotMatch(source, /\broot\s+\/opt\/poi\s*;/);
    assert.match(uploads, /alias\s+\/opt\/poi\/uploads\/;/);
    assert.doesNotMatch(uploads, /autoindex\s+on/);
    assert.match(source, /client_max_body_size\s+12m;/);
    assert.doesNotMatch(source, /client_max_body_size\s+50m;/);
    assert.match(source, /limit_req_zone\s+\$binary_remote_addr\s+zone=poi_api_per_ip:10m\s+rate=30r\/s;/);
    assert.match(source, /limit_req_zone\s+\$binary_remote_addr\s+zone=poi_auth_per_ip:10m\s+rate=10r\/s;/);
    assert.match(source, /limit_req_status\s+429;/);
    assert.match(api, /limit_req\s+zone=poi_api_per_ip\s+burst=60\s+nodelay;/);
    assert.match(auth, /limit_req\s+zone=poi_auth_per_ip\s+burst=20\s+nodelay;/);
    assert.match(source, /include\s+\/etc\/nginx\/snippets\/poi-amap-jscode\.conf;/);
    assert.match(amap, /set\s+\$args\s+"\$args&jscode=\$poi_amap_jscode";/);
    assert.match(amap, /proxy_pass\s+https:\/\/restapi\.amap\.com\/;/);
    assert.match(amap, /proxy_ssl_server_name\s+on;/);
    assert.match(amap, /proxy_set_header\s+Host\s+restapi\.amap\.com;/);
    assert.match(amap, /proxy_set_header\s+Cookie\s+"";/);
    assert.match(amap, /proxy_set_header\s+Authorization\s+"";/);
    assert.match(amap, /proxy_set_header\s+Referer\s+"\$scheme:\/\/\$host\/";/);
    assert.match(amap, /access_log\s+off;/);
    assert.match(amap, /add_header\s+Cache-Control\s+"no-store"\s+always;/);

    for (const header of [
        /Strict-Transport-Security\s+"max-age=31536000; includeSubDomains"\s+always;/,
        /X-Content-Type-Options\s+"nosniff"\s+always;/,
        /X-Frame-Options\s+"DENY"\s+always;/,
        /Content-Security-Policy\s+"frame-ancestors 'none'"\s+always;/,
        /Referrer-Policy\s+"strict-origin-when-cross-origin"\s+always;/
    ]) {
        assert.match(source, header);
        assert.match(uploads, header);
    }

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
    assert.match(ecosystem, /kill_timeout:\s*12000/);
    assert.match(deploy, /TLS_CERT=\/etc\/letsencrypt\/live\/8688988\.xyz\/fullchain\.pem/);
    assert.match(deploy, /TLS_KEY=\/etc\/letsencrypt\/live\/8688988\.xyz\/privkey\.pem/);
    assert.match(deploy, /AMAP_JSCODE_SNIPPET=\/etc\/nginx\/snippets\/poi-amap-jscode\.conf/);
    assert.match(deploy, /root:root 600/);
    assert.match(deploy, /\$poi_amap_jscode/);
    assert.match(deploy, /ADMIN_PASSWORD_HASH/);
    assert.match(deploy, /Legacy ADMIN_PASSWORD is forbidden/);
    assert.match(deploy, /publicHost\.username/);
    assert.match(deploy, /publicHost\.password/);
    assert.match(deploy, /publicHost\.pathname !== '\/'/);
    assert.match(deploy, /publicHost\.search/);
    assert.match(deploy, /publicHost\.hash/);
    assert.doesNotMatch(deploy, /\['MONGO_URI','ADMIN_USERNAME','ADMIN_PASSWORD','AUTH_SESSION_SECRET'\]/);
    assert.match(nginx, /ssl_certificate\s+\/etc\/letsencrypt\/live\/8688988\.xyz\/fullchain\.pem;/);
    assert.match(nginx, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/8688988\.xyz\/privkey\.pem;/);
    assert.match(deploy, /process\.versions\.node[\s\S]*major < 20/);
    const indexInitializationAt = deploy.indexOf('npm run init:indexes');
    const applicationStartAt = deploy.indexOf('pm2 startOrReload');
    assert.ok(indexInitializationAt >= 0 && applicationStartAt > indexInitializationAt,
        'production indexes must finish before PM2 starts or reloads the application');

    assert.match(standalone, /console\.log\('\[GeoSync\] \[DB\] connected'\)/);
    assert.doesNotMatch(standalone, /console\.(?:log|warn|error)[^\n]*MONGO_URI|MONGO_URI\.replace/);

    for (const name of [
        'GEOSYNC_BACKGROUND_ENABLED', 'SHUTDOWN_TIMEOUT_MS', 'TPL_REROUTE', 'ALERT_EMAIL',
        'POSITION_MIN_INTERVAL_S', 'PRESENCE_LEASE_MINUTES', 'CI_SLOT_MINUTES',
        'CI_ALPHA', 'CI_BETA', 'CI_GAMMA', 'REROUTE_GAIN_MIN',
        'REROUTE_DAILY_SOFT_LIMIT', 'BARRIER_REROUTE_CONCURRENCY', 'CAPACITY_TOKEN_TTL_S',
        'RAIN_API_URL', 'RAIN_API_KEY', 'WEATHER_API_URL', 'WEATHER_API_KEY',
        'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'GEOSYNC_UPLOAD_DIR',
        'DEM_TILE_DIR', 'SIM_MODE', 'SIM_STRATEGY', 'SUPERMAP_MAX_RESPONSE_BYTES',
        'SCENIC_TIME_ZONE'
    ]) {
        assert.match(envTemplate, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.example`);
    }
    assert.doesNotMatch(envTemplate, /^AMAP_SEC=/m);
    assert.match(envTemplate, /^LLM_MODEL=$/m);
});
