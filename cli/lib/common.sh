# shellcheck shell=bash
# fiddy shared helpers: config, logging, ssh.

FIDDY_CONFIG="$FIDDY_HOME/config"
# Snapchain default ports: HTTP API 3381, gRPC 3383, gossip 3382/3384 (udp+tcp).
SNAP_HTTP_PORT="${SNAP_HTTP_PORT:-3381}"
SNAP_GRPC_PORT="${SNAP_GRPC_PORT:-3383}"

# Read-node minimums, straight from the snapchain docs (4 cores / 16 GB RAM /
# 2 TB free) and its README (1.5 TB). The mainnet snapshot is ~200 GB
# *compressed* and decompresses several times larger, and block pruning is off
# by default (`pruning.block_retention`), so a smaller disk fails mid-sync —
# hours in. `fiddy node up` checks these before it installs anything.
FIDDY_MIN_VCPU="${FIDDY_MIN_VCPU:-4}"
FIDDY_MIN_RAM_GB="${FIDDY_MIN_RAM_GB:-16}"
FIDDY_MIN_DISK_GB="${FIDDY_MIN_DISK_GB:-1500}"

# `fiddy` must run under bash, and macOS ships bash 3.2 at /bin/bash — so no
# `mapfile`/`readarray`, no `${var,,}`, no associative arrays anywhere below.
# Arrays + `+=` and process substitution are fine on 3.2; keep it that way.
bash_ok() {
  [ -n "${BASH_VERSION:-}" ] || die "run this with bash, not sh (e.g. bash bin/fiddy …)"
  return 0
}

c_reset=$'\033[0m'; c_lime=$'\033[38;5;154m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_bold=$'\033[1m'
log()  { printf '%s▸%s %s\n' "$c_lime" "$c_reset" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_lime" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_red" "$c_reset" "$*" >&2; }
die()  { warn "$*"; exit 1; }
step() { printf '\n%s%s%s\n' "$c_bold" "$*" "$c_reset"; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 — $2"; }

config_load() {
  [ -f "$FIDDY_CONFIG" ] || return 0
  # shellcheck disable=SC1090
  . "$FIDDY_CONFIG"
}

config_set() { # key value — upsert into $FIDDY_CONFIG (mode 0600)
  mkdir -p "$FIDDY_HOME"
  touch "$FIDDY_CONFIG"; chmod 600 "$FIDDY_CONFIG"
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$FIDDY_CONFIG" > "$tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$FIDDY_CONFIG"; chmod 600 "$FIDDY_CONFIG"
  config_load
}

config_show() {
  step "fiddy config ($FIDDY_CONFIG)"
  if [ -f "$FIDDY_CONFIG" ]; then cat "$FIDDY_CONFIG"; else echo "(empty — run: fiddy provision)"; fi
}

# --- remote helpers -------------------------------------------------------

require_target() {
  config_load
  [ -n "${FIDDY_TARGET:-}" ] || die "no node target configured. Run: fiddy provision --aws   (or: --ssh user@host)"
}

ssh_opts() {
  ssh_opts_fill
  printf '%s\n' "${FIDDY_SSH_OPTS[@]}"
}

# Fill $FIDDY_SSH_OPTS in place. (A `mapfile < <(ssh_opts)` idiom reads better
# but is bash 4+ only, and macOS developers run /bin/bash 3.2 — that combination
# used to kill every remote command with "mapfile: command not found".)
ssh_opts_fill() {
  FIDDY_SSH_OPTS=()
  FIDDY_SSH_OPTS+=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  if [ -n "${FIDDY_SSH_KEY:-}" ]; then FIDDY_SSH_OPTS+=(-i "$FIDDY_SSH_KEY"); fi
  return 0
}

ssh_run() { # ssh_run <remote command...>
  require_target
  ssh_opts_fill
  ssh "${FIDDY_SSH_OPTS[@]}" "$FIDDY_TARGET" "$@"
}

scp_to() { # scp_to <local> <remote-path>
  require_target
  ssh_opts_fill
  scp "${FIDDY_SSH_OPTS[@]}" "$1" "$FIDDY_TARGET:$2"
}

# Poll the node's HTTP info endpoint until it answers, printing sync progress.
wait_for_node() { # wait_for_node <base-url>
  local base="$1" tries="${2:-60}" i body
  log "waiting for node at $base (up to $((tries * 5))s)…"
  for ((i = 1; i <= tries; i++)); do
    if body="$(curl -fsS --max-time 5 "$base/v1/info" 2>/dev/null)"; then
      ok "node is up: $base"
      printf '%s\n' "$body" | grep -o '"[a-zA-Z]*":[0-9]*' | head -6 || true
      return 0
    fi
    printf '\r%s…%s attempt %d/%d' "$c_dim" "$c_reset" "$i" "$tries"
    sleep 5
  done
  printf '\n'
  die "node did not come up in time — check: fiddy node logs"
}

# --- sizing preflight -----------------------------------------------------
# Cheap read-only facts from a live box, as key=value lines. Coreutils only —
# a fresh Ubuntu server has no jq.
node_facts_remote() {
  ssh_run 'echo "cpu=$(nproc 2>/dev/null || echo 0)"
echo "ram_kb=$(grep MemTotal /proc/meminfo 2>/dev/null | tr -dc 0-9)"
echo "disk_kb=$(df -Pk "$HOME" 2>/dev/null | tail -1 | tr -s " " | cut -d" " -f4)"
echo "os=$(uname -sr)"
if [ -r /etc/os-release ]; then sed -n "s/^PRETTY_NAME=//p" /etc/os-release | tr -d "\""; fi'
}

node_facts_local() {
  local disk_kb ram_gb=0
  disk_kb="$(df -Pk "$FIDDY_HOME" 2>/dev/null | tail -1 | tr -s ' ' | cut -d' ' -f4)"
  if [ "$(uname -s)" = "Darwin" ]; then
    ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  else
    ram_gb=$(( $(grep MemTotal /proc/meminfo 2>/dev/null | tr -dc 0-9) / 1048576 ))
  fi
  printf 'cpu=%s\nram_gb=%s\ndisk_gb=%s\nos=%s\n' \
    "$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 0)" \
    "$ram_gb" "$(( ${disk_kb:-0} / 1048576 ))" "$(uname -sr)"
}

# Read the numbers, then fail loudly and *early* when a box cannot hold a read
# node — instead of pulling ~200 GB and dying three hours later.
check_node_sizing() { # check_node_sizing <key=value facts...>
  local facts="$1" cpu=0 ram_gb=0 disk_gb=0 os="unknown"
  local line k v short=""
  for line in $facts; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      cpu)     cpu="${v:-0}" ;;
      ram_gb)  ram_gb="${v:-0}" ;;
      ram_kb)  ram_gb=$(( ${v:-0} / 1048576 )) ;;
      disk_gb) disk_gb="${v:-0}" ;;
      disk_kb) disk_gb=$(( ${v:-0} / 1048576 )) ;;
      os)      os="${v:-unknown}" ;;
    esac
  done
  log "found: $os · ${cpu} vCPU · ${ram_gb} GB RAM · ${disk_gb} GB free for the node"
  [ "$cpu" -lt "$FIDDY_MIN_VCPU" ] && short="${short}cpu "
  [ "$ram_gb" -lt "$FIDDY_MIN_RAM_GB" ] && short="${short}ram "
  [ "$disk_gb" -lt "$FIDDY_MIN_DISK_GB" ] && short="${short}disk "
  if [ -z "$short" ]; then
    ok "meets the read-node minimum (${FIDDY_MIN_VCPU} vCPU / ${FIDDY_MIN_RAM_GB} GB RAM / ${FIDDY_MIN_DISK_GB} GB disk)"
    return 0
  fi
  if [ "${FIDDY_ALLOW_UNDERSIZED:-0}" = "1" ]; then
    warn "undersized for a read node (short: $short) — continuing because FIDDY_ALLOW_UNDERSIZED=1"
    return 0
  fi
  if [ "${FIDDY_SIZING_FATAL:-1}" = "0" ]; then
    warn "undersized for a read node (short: $short) — reporting only; fiddy node up will refuse this box"
    return 0
  fi
  warn "this box is undersized for a Snapchain read node (short: $short)"
  cat >&2 <<EOF

  needs:  ${FIDDY_MIN_VCPU} vCPU, ${FIDDY_MIN_RAM_GB} GB RAM, ${FIDDY_MIN_DISK_GB} GB free disk
  found:  ${cpu} vCPU, ${ram_gb} GB RAM, ${disk_gb} GB free where \$HOME lives  (${os})

  Why the disk: the mainnet snapshot is ~200 GB *compressed* and decompresses
  to several times that, and block pruning is off by default. Installing onto
  this box would spend hours pulling ~200 GB and then run out of space.

  Fix one of:
    * give this server a bigger volume (>= ${FIDDY_MIN_DISK_GB} GB free), then re-run
    * provision a bigger box:      fiddy provision --aws      (2 TB by default)
    * you know better than the check:
        FIDDY_ALLOW_UNDERSIZED=1 fiddy node up
EOF
  exit 1
}

# Turn /v1/info into a human verdict — the "did it work?" answer the tutorial
# currently leaves to guesswork.
node_info_verdict() { # node_info_verdict <base-url> <json>
  local base="$1" body="$2"
  case "$body" in
    *'<'*'html'*|*'<html'*|*'<!doctype'*)
      warn "$base answered HTML, not node JSON — that looks like a docs site or a web server, not a Snapchain node API"
      return 1 ;;
  esac
  case "$body" in
    *'"shardInfos"'*) ;;
    *) warn "$base answered something that is not a Snapchain /v1/info payload"; return 1 ;;
  esac
  local version shards height blocks msgs
  version="$(printf '%s' "$body" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
  shards="$(printf '%s' "$body" | grep -o '"shardId":[0-9]*' | wc -l | tr -d ' ')"
  height="$(printf '%s' "$body" | grep -o '"maxHeight":[0-9]*' | cut -d: -f2 | sort -n | tail -1)"
  msgs="$(printf '%s' "$body" | grep -o '"numMessages":[0-9]*' | head -1 | cut -d: -f2)"
  ok "the node API is answering — that is what \"working\" means for a read node"
  printf '  version %s · %s shards · max height %s · %s messages stored\n' \
    "${version:-?}" "${shards:-?}" "${height:-?}" "${msgs:-?}"
  printf '  %s\n' "run this again in a minute: a rising max height means it is still syncing (hours for a cold node)."
  printf '  %s\n' "reads you can make right now: $base/v1/castsByFid?fid=1  ·  errors: $base/v1/info"
}
