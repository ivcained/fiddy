# shellcheck shell=bash
# One-line, plain-English health. JSON is an implementation detail, not a UI.

status_web_and_cost() {
  config_load
  local web="${FIDDY_WEB_URL:-http://localhost:3000}" cost="${FIDDY_MONTHLY_COST:-}"
  if [ -z "$cost" ]; then cost="$(monthly_cost_for_provider "${FIDDY_PROVIDER:-}")"; fi
  printf 'Web: %s. Cost: %s.' "$web" "$cost"
}

status_info_facts() { # /v1/info on stdin -> healthy|answering|behind:SECONDS|syncing:SECONDS
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except (ValueError, TypeError):
    print("answering")
    raise SystemExit(0)
shards = data.get("shardInfos") or data.get("shardInfo") or []
if isinstance(shards, dict):
    shards = list(shards.values())
delays = [s.get("blockDelay") for s in shards if isinstance(s.get("blockDelay"), (int, float))]
syncing = bool(data.get("isSyncing")) or any(s.get("isSyncing") is True for s in shards)
oldest = max(delays) if delays else 0
if syncing:
    print("syncing:%d" % oldest)
elif delays and oldest > 120:
    print("behind:%d" % oldest)
elif delays:
    print("healthy")
else:
    print("answering")
'
}

status_container_visible() { # host -> 0 when the bootstrap container exists
  local host="$1" status=""
  case "$host" in
    localhost|127.0.0.1|::1)
      if command -v docker >/dev/null 2>&1; then
        status="$(docker ps --filter name=snapchain-snapchain-1 --format '{{.Status}}' 2>/dev/null || true)"
      fi
      ;;
    *) status="$(ssh_run 'docker ps --filter name=snapchain-snapchain-1 --format "{{.Status}}"' 2>/dev/null || true)" ;;
  esac
  [ -n "$status" ]
}

status_main() {
  [ "$#" -eq 0 ] || die "fiddy status takes no flags. Run: fiddy status"
  config_load
  local host="${FIDDY_TARGET#*@}"
  host="${host:-127.0.0.1}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  local body facts
  if ! body="$(curl -fsS --max-time 10 "$base/v1/info" 2>/dev/null)"; then
    if ! status_container_visible "$host"; then
      printf 'Your node is not answering - run fiddy node logs. %s\n' "$(status_web_and_cost)"
      return 1
    fi
    local progress pct eta
    progress="$(snapshot_progress)"
    if [[ "$progress" =~ \(([0-9]+)%\) ]]; then
      pct="${BASH_REMATCH[1]}"
      if [[ "$progress" =~ ~([0-9]+)(h|m)\ left ]]; then
        eta="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
        printf 'Your node is %s%% synced (~%s left). %s Everything is fine.\n' "$pct" "$eta" "$(status_web_and_cost)"
      else
        printf 'Your node is %s%% through the first download. %s Time left is still being measured.\n' "$pct" "$(status_web_and_cost)"
      fi
    else
      printf 'Your node is preparing its first download. %s Everything is fine.\n' "$(status_web_and_cost)"
    fi
    return 0
  fi
  facts="$(printf '%s\n' "$body" | status_info_facts)"
  case "$facts" in
    healthy) printf 'Your node is answering and keeping up. %s Everything is fine.\n' "$(status_web_and_cost)" ;;
    answering) printf 'Your node is answering. %s Sync freshness was not reported.\n' "$(status_web_and_cost)" ;;
    behind:*|syncing:*)
      local hours=$(( (${facts#*:} + 3599) / 3600 ))
      printf 'Your node is answering, but its newest block is about %s h old. %s It is still catching up.\n' "$hours" "$(status_web_and_cost)"
      ;;
    *) printf 'Your node is answering. %s Sync freshness was not reported.\n' "$(status_web_and_cost)" ;;
  esac
}
