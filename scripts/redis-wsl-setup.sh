#!/usr/bin/env bash
# Run inside WSL (Ubuntu): bash scripts/redis-wsl-setup.sh
set -euo pipefail

echo "==> Installing Redis..."
sudo apt-get update -qq
sudo apt-get install -y redis-server

echo "==> Enabling Redis on boot (WSL)..."
sudo sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf 2>/dev/null || true
# Listen on all interfaces so Windows Node can reach WSL Redis via 127.0.0.1 (WSL2 port forward)
if grep -q '^bind 127.0.0.1' /etc/redis/redis.conf; then
  sudo sed -i 's/^bind 127.0.0.1.*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
fi

echo "==> Starting Redis..."
sudo service redis-server start

if redis-cli ping | grep -q PONG; then
  echo "✅ Redis is running. From Windows use: REDIS_URL=redis://127.0.0.1:6379"
else
  echo "❌ Redis did not respond to PING"
  exit 1
fi
