#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stockpulse}"
DATA_FILE="$APP_DIR/data/stockpulse.sqlite"
BACKUP_DIR="$APP_DIR/backups"

if [[ ! -f "$DATA_FILE" ]]; then
  echo "No database file found at $DATA_FILE"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
cp "$DATA_FILE" "$BACKUP_DIR/stockpulse-$(date +%Y%m%d-%H%M%S).sqlite"
find "$BACKUP_DIR" -name 'stockpulse-*.sqlite' -mtime +30 -delete
