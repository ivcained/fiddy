#!/usr/bin/env bash
# fiddy fast-bootstrap refresh — keep the pinned snapshot young.
#
# The pin in config/fast-bootstrap.json must stay <= 2 weeks old, or a new node
# spends its "minutes" catching up on two weeks of blocks instead. One run:
#
#   1. publish a fresh snapshot (+ mirror) from the live node
#   2. (optional) verify it end to end by booting a fresh box from it
#   3. (optional) commit + push the updated pin
#
#   scripts/fast-bootstrap-refresh.sh --ssh ubuntu@HOST --volume vol-xxxx --verify --push
#   scripts/fast-bootstrap-refresh.sh --check-age        # for a monitoring cron
#   scripts/fast-bootstrap-refresh.sh --cron-line        # print the weekly job
#
# Credentials: publishing needs the AWS CLI and (for the mirror) R2 keys. The
# node box itself holds no AWS credentials on purpose, so today this runs from
# the operator's machine, or from any host where those credentials exist. The
# pin is honest about its own age either way: `fiddy node status` and the
# tutorial show "synced state as of <date>".

set -uo pipefail

FB_REPO="${FIDDY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../cli/lib/fast-bootstrap.sh
. "$FB_REPO/cli/lib/fast-bootstrap.sh"

PIN_FILE="$(fb_pin_path "$FB_REPO")"
SSH_TARGET="${FIDDY_TARGET:-}"
VOLUME_ID="${FIDDY_AWS_VOLUME_ID:-}"
MIRROR_FLAG=""
VERIFY=0
PUSH=0
CHECK_AGE=0
WAIT_FOR_SYNC=0
DRY_RUN=0
BRANCH="${FB_PIN_BRANCH:-main}"
BUMP=""
PASSTHRU=""

log()  { printf '▸ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh) SSH_TARGET="${2:-}"; shift 2 ;;
    --volume) VOLUME_ID="${2:-}"; shift 2 ;;
    --mirror) MIRROR_FLAG=--mirror; shift ;;
    --write-pin) shift ;;  # publish writes the pin by default
    --no-mirror) MIRROR_FLAG=--no-mirror; shift ;;
    --wait-for-sync) WAIT_FOR_SYNC=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --push) PUSH=1; shift ;;
    --no-push) PUSH=0; shift ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    --check-age) CHECK_AGE=1; shift ;;
    --cron-line) BUMP=cron; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help|help)
      cat <<'EOF'
fast-bootstrap-refresh.sh — refresh the pinned pre-synced node state.

  --ssh user@host      the live node (default: $FIDDY_TARGET)
  --volume vol-xxxx    its EBS volume (required to publish)
  --mirror             also refresh the object-storage mirror
  --wait-for-sync      wait for the node to finish loading chunks first
  --verify             boot a fresh box from the new snapshot and measure it
  --push               commit + push the updated pin (default: leave it staged)
  --branch NAME        branch to push to (default: main)
  --check-age          exit 1 if the pin is older than maxAgeDays (for a monitor)
  --cron-line          print the weekly crontab / launchd job, change nothing
  --dry-run            show what would run
EOF
      exit 0 ;;
    --) shift; break ;;
    *) PASSTHRU="$PASSTHRU $1"; shift ;;
  esac
done

pin_age() { fb_age_days "$(fb_pin_get .aws.createdAt "$PIN_FILE")"; }
pin_max_age() { local m; m="$(fb_pin_get .maxAgeDays "$PIN_FILE")"; printf '%s' "${m:-14}"; }

cron_line() {
  local cmd="cd $FB_REPO && scripts/fast-bootstrap-refresh.sh"
  [ -n "$SSH_TARGET" ] && cmd="$cmd --ssh $SSH_TARGET"
  [ -n "$VOLUME_ID" ] && cmd="$cmd --volume $VOLUME_ID"
  [ -n "$MIRROR_FLAG" ] && cmd="$cmd $MIRROR_FLAG"
  [ "$PUSH" = 1 ] && cmd="$cmd --push"
  echo "# weekly: keeps the pinned snapshot <= 2 weeks old"
  echo "17 4 * * 0  $cmd --wait-for-sync >> \$HOME/.fiddy/fast-bootstrap-refresh.log 2>&1"
  echo
  echo "# macOS (launchd, survives reboots; the Mac must be awake at 04:17 Sunday):"
  echo "#   save as ~/Library/LaunchAgents/fun.fiddy.fast-bootstrap.plist"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>fun.fiddy.fast-bootstrap</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$FB_REPO/scripts/fast-bootstrap-refresh.sh</string>
    <string>--wait-for-sync</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$HOME/.fiddy/fast-bootstrap-refresh.log</string>
  <key>StandardErrorPath</key><string>$HOME/.fiddy/fast-bootstrap-refresh.log</string>
</dict></plist>
EOF
}

if [ -n "$BUMP" ]; then
  cron_line
  exit 0
fi

if [ "$CHECK_AGE" = 1 ]; then
  age="$(pin_age)"; max="$(pin_max_age)"
  if [ -z "$age" ]; then
    warn "no pinned snapshot at all ($PIN_FILE): every bootstrap pays the full download"
    exit 1
  fi
  if [ "$age" -gt "$max" ] 2>/dev/null; then
    warn "pinned snapshot is $age day(s) old (max $max): refresh it"
    exit 1
  fi
  ok "pinned snapshot is $age day(s) old (max $max)"
  exit 0
fi

[ -n "$VOLUME_ID" ] || die "publishing needs --volume vol-xxxxxxxx (the node's EBS volume)"
[ -n "$SSH_TARGET" ] || die "publishing needs --ssh user@host (the live node)"

log "pin before: $(fb_describe "$PIN_FILE")"
PUBLISH_ARGS=(publish --ssh "$SSH_TARGET" --volume "$VOLUME_ID" --pin "$PIN_FILE" --json "$FB_REPO/.fast-bootstrap-last.json")
[ "$WAIT_FOR_SYNC" = 1 ] && PUBLISH_ARGS+=(--wait-for-sync)
[ -n "$MIRROR_FLAG" ] && PUBLISH_ARGS+=("$MIRROR_FLAG")
[ "$DRY_RUN" = 1 ] && PUBLISH_ARGS+=(--dry-run)
# shellcheck disable=SC2086,SC2206
[ -n "$PASSTHRU" ] && PUBLISH_ARGS+=($PASSTHRU)

"$FB_REPO/scripts/node-snapshot.sh" "${PUBLISH_ARGS[@]}" || die "publish failed"

if [ "$VERIFY" = 1 ]; then
  log "verifying the new snapshot end to end (boots a throwaway box)"
  "$FB_REPO/scripts/fast-bootstrap-verify.sh" --pin "$PIN_FILE" || die "verification failed: do NOT advertise this pin"
  ok "verified"
fi

if [ "$PUSH" = 1 ]; then
  log "committing the pin to $BRANCH"
  ( cd "$FB_REPO" \
    && git add "$PIN_FILE" \
    && git commit -q -m "chore(fast-bootstrap): refresh pinned snapshot $(fb_pin_get .aws.snapshotId "$PIN_FILE") ($(fb_pin_get .aws.createdAt "$PIN_FILE"))" \
    && git push -q origin "$BRANCH" ) || die "could not commit/push the pin"
  ok "pin pushed to $BRANCH"
else
  log "pin updated locally; review and commit it (or re-run with --push)"
fi

log "pin after: $(fb_describe "$PIN_FILE")"