#!/usr/bin/env bash

set -euo pipefail

readonly PROJECT_DIR=/opt/poi
NGINX_CONF_SRC=$PROJECT_DIR/nginx.conf
NGINX_CONF_DST=/etc/nginx/sites-available/poi
TLS_CERT=/etc/letsencrypt/live/8688988.xyz/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/8688988.xyz/privkey.pem

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

echo "=== [4/8] Create runtime directories ==="
mkdir -p "$PROJECT_DIR/uploads" "$PROJECT_DIR/logs"

echo "=== [5/8] Validate database and administrator session configuration ==="
node -e "require('dotenv').config(); const missing=['MONGO_URI','ADMIN_USERNAME','ADMIN_PASSWORD','AUTH_SESSION_SECRET'].filter(k => !String(process.env[k] || '').trim()); if (missing.length) { console.error('Missing required production configuration: ' + missing.join(', ')); process.exit(1); }"

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
