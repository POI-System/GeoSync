#!/usr/bin/env bash

set -euo pipefail

readonly PROJECT_DIR=/opt/poi
NGINX_CONF_SRC=$PROJECT_DIR/nginx.conf
NGINX_CONF_DST=/etc/nginx/sites-available/poi
TLS_CERT=/etc/letsencrypt/live/8688988.xyz/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/8688988.xyz/privkey.pem
AMAP_JSCODE_SNIPPET=/etc/nginx/snippets/poi-amap-jscode.conf

cd "$PROJECT_DIR"

echo "=== [1/8] Check runtime dependencies ==="
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "pm2 is required"; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "nginx is required"; exit 1; }
node -e "const major=Number(process.versions.node.split('.')[0]); if (!Number.isInteger(major) || major < 20) { console.error('Node.js 20 or newer is required'); process.exit(1); }"

echo "=== [2/8] Install production dependencies from the lockfile ==="
npm ci --omit=dev

echo "=== [3/8] Check environment and origin certificate ==="
if [ ! -f .env ]; then
    echo ".env is required; provision it from the deployment secret system"
    exit 1
fi
if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
    echo "TLS certificate files are required at $TLS_CERT and $TLS_KEY"
    exit 1
fi
if ! sudo test -f "$AMAP_JSCODE_SNIPPET"; then
    echo "Provision the AMap jscode snippet at $AMAP_JSCODE_SNIPPET"
    exit 1
fi
if [ "$(sudo stat -c '%U:%G %a' "$AMAP_JSCODE_SNIPPET")" != "root:root 600" ]; then
    echo "The AMap jscode snippet must be owned by root:root with mode 600"
    exit 1
fi
if ! sudo grep -Eq '^[[:space:]]*set[[:space:]]+\$poi_amap_jscode[[:space:]]+"[A-Za-z0-9_-]{16,256}"[[:space:]]*;[[:space:]]*$' "$AMAP_JSCODE_SNIPPET"; then
    echo "The AMap jscode snippet has an invalid format"
    exit 1
fi

echo "=== [4/8] Create runtime directories ==="
mkdir -p "$PROJECT_DIR/uploads" "$PROJECT_DIR/logs"

echo "=== [5/8] Validate database and administrator session configuration ==="
node -e "require('dotenv').config(); const { parseAdminPasswordHash }=require('./geosync/services/adminPassword'); const missing=['MONGO_URI','PUBLIC_HOST','ADMIN_USERNAME','ADMIN_PASSWORD_HASH','AUTH_SESSION_SECRET','AMAP_KEY'].filter(k => !String(process.env[k] || '').trim()); if (missing.length) { console.error('Missing required production configuration: ' + missing.join(', ')); process.exit(1); } let publicHost; try { publicHost = new URL(String(process.env.PUBLIC_HOST).trim()); } catch { console.error('PUBLIC_HOST must be an exact HTTPS origin'); process.exit(1); } if (publicHost.protocol !== 'https:' || !publicHost.hostname || publicHost.username || publicHost.password || publicHost.pathname !== '/' || publicHost.search || publicHost.hash) { console.error('PUBLIC_HOST must be an exact HTTPS origin'); process.exit(1); } const cookieMode=String(process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase(); if (cookieMode && cookieMode !== 'true') { console.error('AUTH_COOKIE_SECURE must be blank or true in production'); process.exit(1); } if (String(process.env.ADMIN_PASSWORD || '').trim()) { console.error('Legacy ADMIN_PASSWORD is forbidden'); process.exit(1); } try { parseAdminPasswordHash(process.env.ADMIN_PASSWORD_HASH); } catch { console.error('ADMIN_PASSWORD_HASH is invalid'); process.exit(1); }"

echo "=== [6/8] Create required database indexes ==="
npm run init:indexes

echo "=== [7/8] Deploy nginx configuration ==="
sudo cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
sudo ln -sf "$NGINX_CONF_DST" /etc/nginx/sites-enabled/poi
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo "=== [8/8] Start or reload the single POI service ==="
pm2 startOrReload ecosystem.config.js --env production
pm2 save
pm2 list

echo "Deployment complete"
echo "Smoke test: curl -i http://127.0.0.1:3000/api/poi/all"
echo "Logs: pm2 logs poi"
