#!/bin/sh
# Run on the server as root after every deploy (GitHub Actions calls this via SSH).
set -e
APP_DIR=/home/demowebsitv3/public_html/pos_admin
APP_USER=demowebsitv3
export PATH="/usr/local/bin:/usr/bin:$PATH"

cd "$APP_DIR"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

node -e "require('iconv-lite').encodingExists('utf8')"

chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"

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
