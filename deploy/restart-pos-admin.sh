#!/bin/sh
# Run on the server as root after every deploy (GitHub Actions / cron trigger).
# IMPORTANT: always restart PM2 even if npm ci fails — otherwise new routes never load.
set -u
APP_DIR=/home/demowebsitv3/public_html/pos_admin
APP_USER=demowebsitv3
export PATH="/usr/local/bin:/usr/bin:$PATH"

cd "$APP_DIR" || exit 1

echo "=== pos_admin restart $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

NPM_OK=0
if [ -f package-lock.json ]; then
  if npm ci --omit=dev; then
    NPM_OK=1
  else
    echo "WARNING: npm ci failed — will still restart PM2 with existing node_modules"
  fi
else
  if npm install --omit=dev; then
    NPM_OK=1
  else
    echo "WARNING: npm install failed — will still restart PM2 with existing node_modules"
  fi
fi

if [ "$NPM_OK" = "1" ]; then
  node -e "require('iconv-lite').encodingExists('utf8')" || \
    echo "WARNING: iconv-lite check failed"
fi

chown -R "${APP_USER}:${APP_USER}" "$APP_DIR" 2>/dev/null || true

pm2 delete pos-api 2>/dev/null || true

if pm2 describe pos_admin >/dev/null 2>&1; then
  pm2 restart pos_admin --update-env
else
  pm2 start index.js --name pos_admin
fi

pm2 save || true

echo "=== pm2 pos_admin ==="
pm2 describe pos_admin | grep -E 'status|uptime|restarts|script path' || pm2 list

if [ -f deploy/build-info.json ]; then
  echo "=== deploy/build-info.json ==="
  cat deploy/build-info.json
fi

echo "=== restart complete ==="
