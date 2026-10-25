#!/usr/bin/env bash
# Delete the Hetzner server AND its data volume, then read both back as gone.
# The volume is a separate bill: deleting only the server does not stop it.
set -euo pipefail

SERVER_ID="${1:-${FIDDY_HETZNER_SERVER_ID:-}}"
VOLUME_ID="${2:-${FIDDY_HETZNER_VOLUME_ID:-}}"
TOKEN="${HCLOUD_TOKEN:-${HETZNER_TOKEN:-}}"
API="https://api.hetzner.cloud/v1"
RETRY_DELAY="${FIDDY_TEARDOWN_RETRY_DELAY:-5}"
RESPONSE="$(mktemp)"
trap 'rm -f "$RESPONSE"' EXIT

log() { printf '▸ %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

[ -n "$SERVER_ID" ] || die "no Hetzner server id is recorded. Nothing was destroyed"
[ -n "$VOLUME_ID" ] || die "no Hetzner volume id is recorded. Delete the volume too, or it keeps billing"
[ -n "$TOKEN" ] || die "HCLOUD_TOKEN is required to destroy the Hetzner server and volume"
command -v curl >/dev/null 2>&1 || die "curl is required for Hetzner teardown"

hz_code() { # METHOD PATH
  curl -sS -o "$RESPONSE" -w '%{http_code}' -X "$1" "$API$2" \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json'
}

hz_delete() { # PATH LABEL
  local path="$1" label="$2" code attempt=0
  while [ "$attempt" -lt 12 ]; do
    attempt=$((attempt + 1))
    code="$(hz_code DELETE "$path")"
    case "$code" in
      204|404) return 0 ;;
      409) sleep "$RETRY_DELAY" ;;
      *) die "Hetzner refused to delete $label (HTTP $code). Nothing else will be deleted automatically" ;;
    esac
  done
  die "Hetzner is still detaching $label. Re-run fiddy destroy in a minute"
}

hz_assert_gone() { # PATH LABEL
  local code
  code="$(hz_code GET "$1")"
  [ "$code" = 404 ] || die "$2 still exists after deletion (HTTP $code). Check the Hetzner console before assuming billing stopped"
}

log "deleting Hetzner server $SERVER_ID"
hz_delete "/servers/$SERVER_ID" "server $SERVER_ID"
log "deleting Hetzner volume $VOLUME_ID"
hz_delete "/volumes/$VOLUME_ID" "volume $VOLUME_ID"
hz_assert_gone "/servers/$SERVER_ID" "server $SERVER_ID"
hz_assert_gone "/volumes/$VOLUME_ID" "volume $VOLUME_ID"
ok "billing stopped: Hetzner server and volume are gone"
