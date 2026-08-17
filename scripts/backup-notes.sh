#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/stockpulse}"
if [[ -L "$APP_ROOT/current" ]]; then
  cd "$APP_ROOT/current"
else
  cd "$APP_ROOT"
fi

echo "backup-notes.sh is retained as a compatibility wrapper; use 'npm run ops -- backup' for new automation." >&2
node dist-server/server/ops.js backup --reason compatibility-wrapper
