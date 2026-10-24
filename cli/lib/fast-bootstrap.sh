# shellcheck shell=bash
# fiddy fast bootstrap — shared logic for pre-synced node state.
#
# WHAT THIS IS
# A mainnet read node spends its first hours (overnight on HDD-class disks)
# downloading ~470 GB of gzipped snapshot chunks from Farcaster's public bucket
# before its API answers. That download is the same for everybody, so fiddy
# keeps ONE copy of a synced node and hands it out:
#
#   * AWS:  a public EBS snapshot of the node's volume (scripts/node-snapshot.sh,
#           consumed by scripts/aws-deploy.sh)
#   * else: a tar+zstd tarball in object storage (consumed by `fiddy node up`)
#
# Both are pinned in config/fast-bootstrap.json with the date they were taken.
#
# WHAT THIS IS NOT
# A trust root. It saves the download, nothing else: the node re-validates
# everything it reads from gossip and syncs the gap from the network tip. With
# nothing pinned (or an unreachable mirror) every path silently falls back to
# Farcaster's own chunks.
#
# Portability: macOS ships bash 3.2 — no mapfile, no ${var,,}, no associative
# arrays. jq/python3 are optional: flat pin keys have a sed fallback.

FB_PIN_DEFAULT_NAME="fast-bootstrap.json"
FB_ZSTD_LEVEL="${FB_ZSTD_LEVEL:-3}"

# shellcheck disable=SC2120  # the repo-root argument is optional and is passed by callers in other files
fb_pin_path() { # fb_pin_path [repo-root] → path to the pin file
  local repo="${1:-${FIDDY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}"
  if [ -n "${FIDDY_FAST_BOOTSTRAP_PIN:-}" ]; then
    printf '%s' "$FIDDY_FAST_BOOTSTRAP_PIN"
  else
    printf '%s/config/%s' "$repo" "$FB_PIN_DEFAULT_NAME"
  fi
}

fb_pin_get() { # fb_pin_get <dotted-path> [pin-file]
  local path="$1" pin="${2:-$(fb_pin_path)}"
  [ -f "$pin" ] || return 0
  if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1; then
    jq -r "(${path}) // empty | if type == \"object\" then tojson else tostring end" "$pin" 2>/dev/null
    return 0
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then
    python3 - "$pin" "$path" <<'PY' 2>/dev/null
import json, sys
try:
    node = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for key in sys.argv[2].strip(".").split("."):
    if isinstance(node, dict) and key in node:
        node = node[key]
    else:
        sys.exit(0)
if node is None:
    sys.exit(0)
print(json.dumps(node) if isinstance(node, (dict, list)) else node)
PY
    return 0
  fi
  # Last resort: pin keys are unique enough to grep by leaf name.
  local leaf="${path##*.}"
  sed -n "s/.*\"${leaf}\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$pin" | head -1
}

fb_age_days() { # fb_age_days <iso8601|""> → whole days ("": now)
  local stamp="$1"
  [ -n "$stamp" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -rn --arg t "$stamp" '((now - ($t|fromdateiso8601)) / 86400) | floor' 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$stamp" <<'PY' 2>/dev/null
import datetime, sys
try:
    t = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
except Exception:
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
print(int((now - t).total_seconds() // 86400))
PY
    return 0
  fi
  local epoch_now epoch_then
  epoch_now="$(date -u +%s 2>/dev/null || echo 0)"
  epoch_then="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$stamp" +%s 2>/dev/null || date -u -d "$stamp" +%s 2>/dev/null || echo 0)"
  if [ "$epoch_now" -gt 0 ] 2>/dev/null && [ "$epoch_then" -gt 0 ] 2>/dev/null; then
    echo $(( (epoch_now - epoch_then) / 86400 ))
  fi
  return 0
}

# One honest line about what is pinned, including its age.
fb_describe() { # fb_describe [pin-file]
  local pin="${1:-$(fb_pin_path)}"
  local snap mirror sdate mdate age maxage=""
  snap="$(fb_pin_get .aws.snapshotId "$pin")"
  mirror="$(fb_pin_get .mirror.url "$pin")"
  sdate="$(fb_pin_get .aws.createdAt "$pin")"
  mdate="$(fb_pin_get .mirror.createdAt "$pin")"
  maxage="$(fb_pin_get .maxAgeDays "$pin")"; maxage="${maxage:-14}"
  if [ -z "$snap" ] && [ -z "$mirror" ]; then
    printf 'no pre-synced copy pinned yet: every node bootstraps from the upstream Farcaster snapshot chunks'
    return 0
  fi
  if [ -n "$snap" ]; then
    age="$(fb_age_days "$sdate")"
    printf 'EBS snapshot %s (synced state as of %s%s)' "$snap" "${sdate:-unknown}" \
      "$(if [ -n "$age" ]; then printf ', %s day(s) old' "$age"; fi)"
  fi
  if [ -n "$mirror" ]; then
    age="$(fb_age_days "$mdate")"
    if [ -n "$snap" ]; then printf ' | '; fi
    printf 'tarball mirror %s (as of %s%s)' "$mirror" "${mdate:-unknown}" \
      "$(if [ -n "$age" ]; then printf ', %s day(s) old' "$age"; fi)"
  fi
  if [ -n "$age" ] && [ "$age" -gt "$maxage" ] 2>/dev/null; then
    printf ' ⚠ older than %s days: refresh it (scripts/fast-bootstrap-refresh.sh)' "$maxage"
  fi
  return 0
}

fb_trust_note() {
  cat <<'EOF'
Convenience, not a trust root: it only skips the slow download. Your node still
re-validates every message it reads over gossip and syncs the gap from the
network tip. Prefer to skip it? Bootstrap from Farcaster's public chunks
instead, which is exactly what happens when no copy is pinned.
EOF
}

# --- mirror plumbing ------------------------------------------------------
#
# Compressed tarball of the node's data dir (RocksDB + onchain config), laid out
# so it extracts straight into the data dir. Peak disk during a fast install is
# the compressed tarball plus the unpacked DB, which is why the guard below is
# ~2.3x the tarball size (measured: 468 GB compressed -> 597 GB unpacked).

fb_mirror_fields() { # fb_mirror_fields [pin-file] → FB_MIRROR_{URL,SHA256,BYTES,DATE}
  local pin="${1:-$(fb_pin_path)}"
  FB_MIRROR_URL="$(fb_pin_get .mirror.url "$pin")"
  FB_MIRROR_SHA256="$(fb_pin_get .mirror.sha256 "$pin")"
  FB_MIRROR_BYTES="$(fb_pin_get .mirror.bytes "$pin")"
  FB_MIRROR_DATE="$(fb_pin_get .mirror.createdAt "$pin")"
  FB_MIRROR_URL="${FB_MIRROR_URL:-}"
  FB_MIRROR_SHA256="${FB_MIRROR_SHA256:-}"
  FB_MIRROR_BYTES="${FB_MIRROR_BYTES:-0}"
  FB_MIRROR_DATE="${FB_MIRROR_DATE:-}"
  case "$FB_MIRROR_BYTES" in ''|*[!0-9]*) FB_MIRROR_BYTES=0 ;; esac
  return 0
}

fb_human_gb() { # fb_human_gb <bytes> → "470" (whole GB)
  local bytes="${1:-0}"
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  echo $(( bytes / 1073741824 ))
}

fb_mirror_reachable() { # fb_mirror_reachable <url> → 0 when a HEAD answers
  local url="$1"
  [ -n "$url" ] || return 1
  curl -fsSI --max-time 15 "$url" >/dev/null 2>&1
}

# Extract a mirror tarball into <dest>. Real download, real checksum, real
# extraction: nothing here is simulated, so the tests drive this exact function.
fb_apply_mirror() { # fb_apply_mirror <url> <dest-dir> [sha256]
  local url="$1" dest="$2" want_sha="${3:-}"
  local tmp_sha got_sha rc=0 had_e=0
  case "$-" in *e*) had_e=1 ;; esac
  [ -n "$url" ] || return 1
  [ -n "$dest" ] || return 1
  mkdir -p "$dest" || return 1
  if ! command -v zstd >/dev/null 2>&1; then
    echo "fast-bootstrap: zstd not installed on this host" >&2
    return 1
  fi
  tmp_sha="$(mktemp)"
  # Stream: download -> hash -> decompress -> extract. Nothing is buffered to
  # disk twice, so the peak footprint stays the tarball's own size at most.
  set +e
  if command -v bash >/dev/null 2>&1; then
    bash -c 'set -o pipefail; curl -fsSL --max-time "${FB_CURL_TIMEOUT:-0}" "$1" | tee >(sha256sum | cut -d" " -f1 > "$3") | zstd -dc -T0 -q | tar -xf - -C "$2"' _ "$url" "$dest" "$tmp_sha"
  else
    set -o pipefail
    curl -fsSL "$url" | zstd -dc -T0 -q | tar -xf - -C "$dest"
  fi
  rc=$?
  [ "$had_e" = 1 ] && set -e || set +e
  if [ "$rc" != 0 ]; then
    rm -f "$tmp_sha"
    echo "fast-bootstrap: mirror download/extract failed (curl/zstd/tar exit $rc)" >&2
    return 1
  fi
  if [ -n "$want_sha" ]; then
    got_sha="$(cat "$tmp_sha" 2>/dev/null || true)"
    rm -f "$tmp_sha"
    if [ "$got_sha" != "$want_sha" ]; then
      echo "fast-bootstrap: checksum mismatch (got ${got_sha:-none}, want $want_sha)" >&2
      return 1
    fi
  else
    rm -f "$tmp_sha"
  fi
  return 0
}

# Same pipeline, run on the node's own host (bandwidth matters: the box is in
# the cloud, the laptop may not be).
fb_apply_mirror_remote() { # fb_apply_mirror_remote <ssh-target> <url> <dest-dir> [sha] [ssh-key]
  local target="$1" url="$2" dest="$3" want_sha="${4:-}" key="${5:-}"
  local opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  [ -n "$key" ] && opts=("${opts[@]}" -i "$key")
  ssh "${opts[@]}" "$target" "
    set -eo pipefail
    command -v zstd >/dev/null 2>&1 || { echo 'fast-bootstrap: no zstd on the target' >&2; exit 3; }
    mkdir -p '$dest'
    sha_tmp=\$(mktemp)
    curl -fsSL '$url' | tee >(sha256sum | cut -d' ' -f1 > \"\$sha_tmp\") | zstd -dc -T0 -q | tar -xf - -C '$dest'
    got=\$(cat \"\$sha_tmp\"); rm -f \"\$sha_tmp\"
    if [ -n '$want_sha' ] && [ \"\$got\" != '$want_sha' ]; then
      echo \"fast-bootstrap: checksum mismatch (got \$got, want $want_sha)\" >&2
      exit 4
    fi
    echo \"fast-bootstrap: extracted into $dest (\$got)\"
  "
}

# Disk guard. Peak = tarball + unpacked DB ≈ 2.3x compressed (measured on a real
# bootstrap: 468 GB compressed, 597 GB unpacked). Still far cheaper than the
# upstream path's 1.66 TB peak, but not free.
fb_mirror_peak_gb() { # fb_mirror_peak_gb <bytes> → whole GB needed
  local bytes="${1:-0}"
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  echo $(( (bytes / 1073741824) * 23 / 10 + 20 ))
}

# Does this directory already hold node state? (a real install, or a retry
# after a successful fast path: either way, never overwrite it)
fb_dir_has_state() { # fb_dir_has_state <dir> → 0 when it holds something
  [ -n "${1:-}" ] || return 1
  [ -d "$1" ] || return 1
  [ -n "$(ls -A "$1" 2>/dev/null | head -n 1)" ]
}

# Should we use the mirror? Every input is explicit, so the rule is testable and
# the CLI cannot invent a fast path the tooling did not intend:
#   * nothing pinned                      -> skip:no-pin        (upstream chunks)
#   * unreachable/failed HEAD             -> skip:unreachable
#   * the data dir already has a database -> skip:data-present
#   * no zstd on this host                -> skip:no-zstd
#   * not enough free disk                -> skip:no-space
#   * otherwise                           -> use
# Prints exactly one of those tokens.
fb_fast_path_decision() { # fb_fast_path_decision <url> <reachable 0|1> <data-present 0|1> <free-gb> <needed-gb> <have-zstd 0|1>
  local url="$1" reachable="$2" data_present="$3" free_gb="$4" need_gb="$5" have_zstd="$6"
  [ -n "$url" ] || { echo skip:no-pin; return 0; }
  [ "$reachable" = 1 ] || { echo skip:unreachable; return 0; }
  [ "$data_present" = 0 ] || { echo skip:data-present; return 0; }
  [ "$have_zstd" = 1 ] || { echo skip:no-zstd; return 0; }
  case "$free_gb" in ''|*[!0-9]*) echo skip:no-space; return 0 ;; esac
  [ "$free_gb" -ge "$need_gb" ] 2>/dev/null || { echo skip:no-space; return 0; }
  echo use
  return 0
}


# --- can THIS account actually launch the published artifacts? -------------
# Sharing has account-level switches in front of it (AMI block public access is
# ON by default on new accounts; snapshot block public access is a separate
# switch), so "we published it" is not the same as "you can use it". These two
# ask AWS instead of assuming. They take the aws argument list so callers can
# pass --region/--profile.
fb_ami_usable() { # fb_ami_usable <ami-id> <aws-args...> → 0 when launchable here
  local ami="$1"; shift
  local json owner me state
  state="$(aws "$@" ec2 describe-images --image-ids "$ami" --query 'Images[0].State' --output text 2>/dev/null || echo missing)"
  [ "$state" = "available" ] || return 1
  owner="$(aws "$@" ec2 describe-images --image-ids "$ami" --query 'Images[0].OwnerId' --output text 2>/dev/null || true)"
  me="$(aws "$@" sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ "$owner" = "$me" ] && return 0
  json="$(aws "$@" ec2 describe-image-attribute --image-id "$ami" --attribute launchPermission --query 'LaunchPermissions' --output json 2>/dev/null || echo '[]')"
  case "$json" in
    *'"Group": "all"'*|*'"Group":"all"'*) return 0 ;;
  esac
  case "$json" in
    *"\"UserId\": \"$me\""*|*"\"UserId\":\"$me\""*) return 0 ;;
  esac
  return 1
}

fb_snapshot_usable() { # fb_snapshot_usable <snapshot-id> <aws-args...> → 0 when a volume can be made from it
  local snap="$1"; shift
  local state owner me json
  state="$(aws "$@" ec2 describe-snapshots --snapshot-ids "$snap" --query 'Snapshots[0].State' --output text 2>/dev/null || echo missing)"
  [ "$state" = "completed" ] || return 1
  owner="$(aws "$@" ec2 describe-snapshots --snapshot-ids "$snap" --query 'Snapshots[0].OwnerId' --output text 2>/dev/null || true)"
  me="$(aws "$@" sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ "$owner" = "$me" ] && return 0
  json="$(aws "$@" ec2 describe-snapshot-attribute --snapshot-id "$snap" --attribute createVolumePermission --query 'CreateVolumePermissions' --output json 2>/dev/null || echo '[]')"
  case "$json" in
    *'"Group": "all"'*|*'"Group":"all"'*) return 0 ;;
  esac
  case "$json" in
    *"\"UserId\": \"$me\""*|*"\"UserId\":\"$me\""*) return 0 ;;
  esac
  return 1
}
