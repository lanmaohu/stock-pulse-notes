#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stockpulse}"
DATA_FILE="$APP_DIR/data/notes.json"
BACKUP_DIR="$APP_DIR/backups"

if [[ ! -f "$DATA_FILE" ]]; then
  echo "No notes file found at $DATA_FILE"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
cp "$DATA_FILE" "$BACKUP_DIR/notes-$(date +%Y%m%d-%H%M%S).json"
find "$BACKUP_DIR" -name 'notes-*.json' -mtime +30 -delete
