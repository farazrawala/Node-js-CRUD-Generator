#!/bin/sh
# Root cron (recommended on shared hosting — SSH from GitHub Actions is often blocked):
#   */1 * * * * sh /home/demowebsitv3/public_html/pos_admin/deploy/watch-restart-trigger.sh >> /var/log/pos_admin_deploy.log 2>&1
set -e
APP_DIR=/home/demowebsitv3/public_html/pos_admin
TRIGGER="$APP_DIR/deploy/.restart-requested"

[ -f "$TRIGGER" ] || exit 0

echo "=== pos_admin deploy trigger $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
cat "$TRIGGER"
rm -f "$TRIGGER"
exec sh "$APP_DIR/deploy/restart-pos-admin.sh"
