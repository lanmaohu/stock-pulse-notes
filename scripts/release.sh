#!/usr/bin/env bash
set -euo pipefail

DEPLOY_TARGET="${DEPLOY_TARGET:-}"
APP_ROOT="${STOCKPULSE_APP_ROOT:-/opt/stockpulse}"
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=true; fi

if [[ -z "$DEPLOY_TARGET" ]]; then
  echo "DEPLOY_TARGET is required, for example user@example.com." >&2
  exit 2
fi
if [[ ! "$APP_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$APP_ROOT" == "/" ]]; then
  echo "STOCKPULSE_APP_ROOT must be a safe absolute path other than /." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree must be clean. Commit the intended release first." >&2
  exit 2
fi

COMMIT="$(git rev-parse --verify HEAD)"
SHORT_COMMIT="$(git rev-parse --short=12 HEAD)"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-$SHORT_COMMIT"
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"

if $DRY_RUN; then
  printf 'release=%s\ncommit=%s\ntarget=%s\nremote_directory=%s\n' "$RELEASE_ID" "$COMMIT" "$DEPLOY_TARGET" "$RELEASE_DIR"
  exit 0
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
git archive --format=tar HEAD | tar -xf - -C "$TEMP_DIR"

ssh "$DEPLOY_TARGET" "mkdir -p '$RELEASE_DIR'"
rsync -az --delete "$TEMP_DIR/" "$DEPLOY_TARGET:$RELEASE_DIR/"
ssh "$DEPLOY_TARGET" "STOCKPULSE_APP_ROOT='$APP_ROOT' bash '$RELEASE_DIR/deploy/stockpulse.sh' activate '$RELEASE_ID'"

echo "Released $RELEASE_ID to $DEPLOY_TARGET"
