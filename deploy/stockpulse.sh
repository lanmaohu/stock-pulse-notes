#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${STOCKPULSE_APP_ROOT:-/opt/stockpulse}"
COMMAND="${1:-}"
RELEASE_ID="${2:-}"

if [[ ! "$APP_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$APP_ROOT" == "/" ]]; then
  echo "Unsafe STOCKPULSE_APP_ROOT: $APP_ROOT" >&2
  exit 2
fi

api_port() {
  local value
  value="$(awk -F= '/^PORT=/ { print $2; exit }' "$APP_ROOT/.env" 2>/dev/null || true)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf '3000'; fi
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary="${link}.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

pm2_has_app() {
  pm2 describe "$1" >/dev/null 2>&1
}

start_current() {
  local release
  release="$(basename "$(readlink -f "$APP_ROOT/current")")"
  STOCKPULSE_RELEASE="$release" pm2 startOrReload "$APP_ROOT/current/deploy/ecosystem.config.cjs" --update-env
}

wait_until_ready() {
  local port response_code
  port="$(api_port)"
  for _ in $(seq 1 60); do
    response_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health/ready" || true)"
    if [[ "$response_code" == "200" ]]; then return 0; fi
    sleep 1
  done
  echo "Readiness did not become healthy within 60 seconds." >&2
  return 1
}

smoke_test() {
  local port protected_code
  port="$(api_port)"
  curl -fsS "http://127.0.0.1:$port/api/health/live" >/dev/null
  curl -fsS "http://127.0.0.1:$port/api/content-insights?pageSize=10" >/dev/null
  protected_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/platform-accounts")"
  [[ "$protected_code" == "401" ]] || { echo "Expected anonymous management request to return 401, got $protected_code." >&2; return 1; }
}

rollback_to_previous() {
  if [[ ! -L "$APP_ROOT/previous" ]]; then
    echo "No previous release is available." >&2
    exit 1
  fi
  local old_current previous_target
  old_current="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
  previous_target="$(readlink -f "$APP_ROOT/previous")"
  atomic_link "$previous_target" "$APP_ROOT/current"
  if [[ -n "$old_current" ]]; then atomic_link "$old_current" "$APP_ROOT/previous"; fi
  start_current
  wait_until_ready
  smoke_test
  pm2 save
  echo "Rolled back to $(basename "$previous_target"). Database migrations were not reverted."
}

status() {
  pm2 status
  local port
  port="$(api_port)"
  curl -fsS "http://127.0.0.1:$port/api/health/live"
  echo
  curl -fsS "http://127.0.0.1:$port/api/health/ready"
  echo
  (cd "$APP_ROOT/current" && node dist-server/server/ops.js doctor)
}

activate() {
  if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "A safe release ID is required." >&2
    exit 2
  fi
  local release_dir="$APP_ROOT/releases/$RELEASE_ID"
  [[ -d "$release_dir" ]] || { echo "Release directory does not exist: $release_dir" >&2; exit 2; }
  [[ -f "$APP_ROOT/.env" ]] || { echo "Shared environment file is missing: $APP_ROOT/.env" >&2; exit 2; }
  command -v flock >/dev/null
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v pm2 >/dev/null
  command -v curl >/dev/null
  command -v rsync >/dev/null
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major !== 22 || minor < 16) { console.error("Node >=22.16 <23 is required."); process.exit(1); }'

  mkdir -p "$APP_ROOT/releases" "$APP_ROOT/data" "$APP_ROOT/backups"
  chmod 700 "$APP_ROOT/backups"
  ln -sfn "$APP_ROOT/.env" "$release_dir/.env"
  ln -sfn "$APP_ROOT/data" "$release_dir/data"
  ln -sfn "$APP_ROOT/backups" "$release_dir/backups"

  (
    flock -n 9 || { echo "Another Stockpulse deployment is running." >&2; exit 1; }
    cd "$release_dir"
    npm ci
    npm run typecheck
    npm test
    npm run build

    local old_current="" legacy_layout=false stopped=false switched=false
    if [[ -L "$APP_ROOT/current" ]]; then
      old_current="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
    fi
    if [[ -z "$old_current" || ! -d "$old_current" ]]; then
      old_current=""
      legacy_layout=true
    fi
    recover() {
      local exit_code=$?
      if $switched; then
        if [[ -n "$old_current" ]]; then atomic_link "$old_current" "$APP_ROOT/current"
        else rm -f -- "$APP_ROOT/current"
        fi
      fi
      if $stopped; then
        if [[ -n "$old_current" && -L "$APP_ROOT/current" ]]; then start_current || true
        elif $legacy_layout && [[ -f "$APP_ROOT/deploy/ecosystem.config.cjs" ]]; then
          pm2 delete stockpulse-worker stockpulse >/dev/null 2>&1 || true
          pm2 start "$APP_ROOT/deploy/ecosystem.config.cjs" --update-env || true
        else
          pm2 restart stockpulse stockpulse-worker --update-env || true
        fi
      fi
      echo "Deployment failed; the previous code was restarted. Database backups were retained." >&2
      exit "$exit_code"
    }
    trap recover ERR

    if pm2_has_app stockpulse-worker; then pm2 stop stockpulse-worker; fi
    if pm2_has_app stockpulse; then pm2 stop stockpulse; fi
    stopped=true

    local backup_output backup_id
    backup_output="$(node dist-server/server/ops.js backup --reason "pre-deploy-$RELEASE_ID")"
    backup_id="$(node -e 'const chunks=[]; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => console.log(JSON.parse(Buffer.concat(chunks)).backupId));' <<<"$backup_output")"
    STOCKPULSE_MIGRATION_BACKUP_ID="$backup_id" node dist-server/server/migrate.js

    if [[ -n "$old_current" ]]; then atomic_link "$old_current" "$APP_ROOT/previous"
    else rm -f -- "$APP_ROOT/previous"
    fi
    atomic_link "$release_dir" "$APP_ROOT/current"
    switched=true
    if $legacy_layout; then pm2 delete stockpulse-worker stockpulse >/dev/null 2>&1 || true; fi
    start_current
    wait_until_ready
    smoke_test
    pm2 save
    trap - ERR

    local current_target previous_target kept=0
    current_target="$(readlink -f "$APP_ROOT/current")"
    previous_target="$(readlink -f "$APP_ROOT/previous" 2>/dev/null || true)"
    while IFS= read -r directory; do
      [[ "$directory" == "$current_target" || "$directory" == "$previous_target" ]] && continue
      kept=$((kept + 1))
      if (( kept > 3 )); then rm -rf -- "$directory"; fi
    done < <(find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -print | sort -r)
    echo "$backup_output"
    echo "Activated release $RELEASE_ID"
  ) 9>"$APP_ROOT/.deploy.lock"
}

case "$COMMAND" in
  activate) activate ;;
  rollback)
    (flock -n 9 || { echo "Another Stockpulse operation is running." >&2; exit 1; }; rollback_to_previous) 9>"$APP_ROOT/.deploy.lock"
    ;;
  status) status ;;
  *) echo "Usage: stockpulse.sh activate <release-id> | rollback | status" >&2; exit 2 ;;
esac
