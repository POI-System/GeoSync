#!/usr/bin/env bash
# ===================================================================
# POI 系统一键部署脚本(国外 Ubuntu 22.04)
# 假设代码已 scp/git 到 /opt/poi
# 使用: bash deploy.sh
# ===================================================================

set -e

PROJECT_DIR=/opt/poi
NGINX_CONF_SRC=$PROJECT_DIR/nginx.conf
NGINX_CONF_DST=/etc/nginx/sites-available/poi
ORIGIN_CERT=/etc/nginx/ssl/origin.pem
ORIGIN_KEY=/etc/nginx/ssl/origin.key

cd "$PROJECT_DIR"

echo "=== [1/7] 检查运行环境 ==="
command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node,请先安装 Node.js 20"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "❌ 未找到 npm"; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "❌ 未找到 pm2,请先 npm i -g pm2"; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "❌ 未找到 nginx"; exit 1; }

echo "=== [2/7] 安装依赖 ==="
npm install --omit=dev

echo "=== [3/7] 检查 .env 和 Origin Cert ==="
if [ ! -f .env ]; then
    echo "❌ 未找到 .env,请先 cp .env.example .env 并填好凭据"
    exit 1
fi
if [ ! -f "$ORIGIN_CERT" ] || [ ! -f "$ORIGIN_KEY" ]; then
    echo "❌ 未找到 Cloudflare Origin Certificate"
    echo "   需要: $ORIGIN_CERT 和 $ORIGIN_KEY"
    exit 1
fi

echo "=== [4/7] 创建 uploads 与 logs 目录 ==="
mkdir -p "$PROJECT_DIR/uploads" "$PROJECT_DIR/logs"

echo "=== [5/7] 初始化管理员账号 ==="
node init-admin.js || true

echo "=== [6/7] 部署 Nginx 配置 ==="
sudo cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
sudo ln -sf "$NGINX_CONF_DST" /etc/nginx/sites-enabled/poi
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo "=== [7/7] 启动/重启 pm2 ==="
pm2 startOrReload ecosystem.config.js --env production
pm2 save

pm2 list
echo ""
echo "✅ 部署完成"
echo "   测试: curl -i http://127.0.0.1:3000/api/poi/all"
echo "   自启: 首次部署后执行 pm2 startup,再按提示运行 systemd 命令"
echo "   日志: pm2 logs poi"
