#!/bin/sh
# Run on the server when you see: Cannot find module '../encodings' (iconv-lite)
set -e
cd "$(dirname "$0")/.." || exit 1
echo "Reinstalling dependencies in $(pwd) ..."
rm -rf node_modules
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --production
fi
echo "Done. Restart Node: pm2 restart pos-api"
