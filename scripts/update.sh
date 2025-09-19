#!/usr/bin/env bash
set -euo pipefail

# DayZ Discord bot updater for Debian/Ubuntu hosts
# Usage:
#   bash scripts/update.sh           # pull latest, install deps, (re)start pm2
#   bash scripts/update.sh --reset   # also reset offsets (remove data/state.json)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[update] Working dir: $ROOT_DIR"

if [[ ! -f package.json ]]; then
  echo "[update] package.json not found. Are you in the project root?" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "[update] .env missing. Copy .env.example to .env and configure it." >&2
  exit 1
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "[update] Stopping pm2 process if running..."
  pm2 stop dayz-bot || true
fi

echo "[update] Pulling latest code..."
git pull --rebase --autostash || true

echo "[update] Installing deps..."
npm install --omit=dev || npm install

if [[ "${1:-}" == "--reset" ]]; then
  echo "[update] Resetting offsets (data/state.json)"
  rm -f data/state.json || true
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "[update] Starting with pm2..."
  pm2 start index.js --name dayz-bot || pm2 restart dayz-bot
  pm2 save || true
  pm2 status dayz-bot
  echo "[update] Tailing last logs (Ctrl+C to exit)"
  pm2 logs dayz-bot --lines 20
else
  echo "[update] pm2 not found. Start manually:"
  echo "         DEBUG=true node index.js"
fi

