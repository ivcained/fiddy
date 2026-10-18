# shellcheck shell=bash
# fiddy node — command (1): a Snapchain read node on your compute.
#
# A read node (read_node = true) follows the chain, stores full state, and
# serves the HTTP + gRPC APIs. Anyone can run one; no keys, no permission.
# It also accepts submitMessage and gossips valid messages to validators —
# it has no mempool of its own, so confirm inclusion via MERGE_MESSAGE events
# or by querying the message back.
#
# Install notes (these are the difference between "works over SSH" and not):
#   * snapchain-bootstrap.sh ends in `exec ./snapchain.sh upgrade < /dev/tty`,
#     so piping it into bash on a headless session dies with
#     "/dev/tty: No such device or address". We fetch snapchain.sh directly.
#   * snapchain.sh refuses to run without AGREE_NO_REWARDS_FOR_ME=true in .env
#     and, when it is not attached to a terminal, stops every container and
#     exits. We pre-seed .env, so the install is unattended.
#   * snapchain.sh `upgrade` ends by tailing container logs with -f, which
#     never returns over SSH. We run it detached and follow its log file.
#   * the auto-upgrade cron it installs runs `docker system prune --volumes -f`
#     against the whole Docker host — hostile on a server that runs anything
#     else, so we set SKIP_CRONTAB=true by default.

node_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up)      node_up "$@" ;;
    status)  node_status ;;
    verify)  node_verify ;;
    logs)    node_logs ;;
    stop)    node_stop ;;
    start)   node_start ;;
    upgrade) node_upgrade ;;
    -h|--help|"")
      cat <<'EOF'
fiddy node — manage your Snapchain read node.

  up [--local] [--force]
                 Install Snapchain on the target, start syncing, and wait
                 until the HTTP API answers. --local runs on this machine
                 instead of the provisioned target. --force installs on a
                 machine that fails the requirements preflight (it will stop
                 when the disk fills).
  status         Print sync status from /v1/info.
  verify [fid]   Run the acceptance checks against the node's HTTP API:
                 health, reads served by this node, signer list. Default FID
                 is 3 (dwr.eth); pass any FID you can check.
  logs           Tail node logs (Ctrl-C to stop).
  start | stop   Start / stop the node's containers (non-blocking).
  upgrade        Re-run the official installer, pulling the latest release.

Requirements for a mainnet read node: 4 vCPU, 16 GB RAM, 1.5 TB free disk,
public IP, ports 3381-3383 reachable (gossip uses 3382/udp).
EOF
      ;;
    *) die "unknown node command: $sub" ;;
  esac
}

node_up() {
  local local_mode=0 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --local) local_mode=1 ;;
      --force) force=1 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  [ "${FIDDY_ALLOW_UNDERSIZED:-0}" = 1 ] && force=1

  step "Setting up a Snapchain read node"
  log "What you're getting: a read node (read_node = true). It follows the chain,"
  log "stores full state, serves HTTP :$SNAP_HTTP_PORT + gRPC :$SNAP_GRPC_PORT, and"
  log "relays your writes to validators over gossip. No API keys. Your compute only."
  log "First boot downloads the historical snapshot from Farcaster's public bucket"
  log "(up to ~2h), then it syncs blocks."

  if [ "$local_mode" = 1 ]; then
    node_install_local "$force"
  else
    node_install_remote "$force"
  fi
}

node_install_remote() {
  local force="${1:-0}"
  require_target
  log "target: $FIDDY_TARGET"

  preflight_remote
  preflight_verdict "$force"

  log "ensuring Docker…"
  remote_ensure_docker

  # snapchain.sh gates on crontab; minimal cloud images (GCE Ubuntu) lack it
  # and the installer dies AFTER statsd/Grafana are already up, leaving a
  # confusing half-install. Install cron first.
  log "ensuring cron (snapchain.sh requires crontab)…"
  ssh_run 'command -v crontab >/dev/null 2>&1 || { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq cron >/dev/null && sudo systemctl enable --now cron >/dev/null 2>&1; }; command -v crontab >/dev/null 2>&1 && echo cron-ok' | grep -q cron-ok \
    || die "cron is missing on $FIDDY_TARGET and needs sudo to install (sudo apt-get install -y cron), then re-run."

  log "installing Snapchain (official snapchain.sh, fetched directly)…"
  remote_seed_snapchain_env
  local grafana_blocked=0
  case ",$PREFLIGHT_PORTS," in *",3000,"*) grafana_blocked=1 ;; esac
  remote_start_upgrade "$grafana_blocked"

  local host="${FIDDY_TARGET#*@}"
  node_wait_or_report "http://$host:$SNAP_HTTP_PORT" "$host"

  config_set FIDDY_NODE_HTTP "http://$host:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "$host:$SNAP_GRPC_PORT"
  echo ""
  ok "Read node installed: http://$host:$SNAP_HTTP_PORT (gRPC $host:$SNAP_GRPC_PORT)."
  ok "Next: fiddy client up"
}

# A brand new node does NOT serve HTTP while it downloads the snapshot — the
# API starts after the load (measured 2026-10-18: connections refused on
# :3381 for the whole bootstrap). So: report progress instead of blocking for
# hours. `fiddy node status` is the "is it up yet" command afterwards.
node_wait_or_report() {
  local base="$1" host="$2" tries="${3:-24}" i
  log "waiting up to $((tries * 5))s for the node API at ${base}…"
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS --max-time 5 "$base/v1/info" 2>/dev/null | node_info_summary; then
      printf '\n'
      ok "node API is up: $base"
      return 0
    fi
    printf '\r%s…%s attempt %d/%d' "$c_dim" "$c_reset" "$i" "$tries"
    sleep 5
  done
  printf '\n'
  warn "the API is not answering yet — a fresh read node refuses HTTP until the"
  warn "snapshot bootstrap finishes (up to ~2h, ~470 GB of chunks; see"
  warn "docs/NODE-REQUIREMENTS.md). This is expected on first boot."
  local status progress
  status="$(ssh_run 'docker ps --filter name=snapchain-snapchain-1 --format "{{.Status}}"' 2>/dev/null || true)"
  progress="$(ssh_run 'docker logs snapchain-snapchain-1 2>&1 | grep -oE "chunk_[0-9]+\.bin" | tail -1' 2>/dev/null || true)"
  if [ -n "$status" ]; then log "container: $status"; fi
  if [ -n "$progress" ]; then log "snapshot download at: $progress of 5690"; fi
  log "watch it: fiddy node logs      (or: fiddy node status once the bootstrap ends)"
  return 0
}

node_install_local() {
  local force="${1:-0}"
  require curl "install curl"

  preflight_local
  preflight_verdict "$force"

  if ! command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    local answer=""
    if [ -t 0 ]; then
      printf 'Docker is required for the node. Install Docker Desktop now? [y/N] '
      read -r answer || true
    fi
    case "$answer" in
      [yY]*) open -a Docker 2>/dev/null || true
             log "waiting for Docker Desktop…"
             local i
             for ((i = 1; i <= 60; i++)); do
               docker info >/dev/null 2>&1 && break
               sleep 5
             done ;;
      *) die "install Docker first: https://docs.docker.com/get-docker/  (or run: fiddy node up --ssh-target …)" ;;
    esac
  fi

  mkdir -p "$FIDDY_HOME/snapchain"
  ( cd "$FIDDY_HOME/snapchain" && fetch_snapchain_script && seed_env_file && start_upgrade_detached )
  wait_for_node "http://127.0.0.1:$SNAP_HTTP_PORT" 120 "node logs: fiddy node logs"
  config_set FIDDY_NODE_HTTP "http://127.0.0.1:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "127.0.0.1:$SNAP_GRPC_PORT"
  ok "Local read node running on http://127.0.0.1:$SNAP_HTTP_PORT. Next: fiddy client up"
}

# --- remote install steps -------------------------------------------------

remote_ensure_docker() {
  local probe
  probe="$(ssh_run 'command -v docker >/dev/null 2>&1 && echo docker-ok || echo no-docker')"
  case "$probe" in
    *docker-ok*)
      ssh_run 'docker --version' ;;
    *)
      log "Docker missing on the target — installing via get.docker.com…"
      if [ "$(ssh_run 'id -u')" = "0" ]; then
        ssh_run 'curl -fsSL https://get.docker.com | sh >/tmp/fiddy-docker-install.log 2>&1 && docker --version' \
          || die "Docker install failed on the target — see /tmp/fiddy-docker-install.log"
      else
        ssh_run 'sudo -n true' >/dev/null 2>&1 \
          || die "Docker is missing and sudo on $FIDDY_TARGET needs a password. Install it yourself (curl -fsSL https://get.docker.com | sudo sh), add your user to the docker group, then re-run."
        ssh_run 'curl -fsSL https://get.docker.com | sudo sh >/tmp/fiddy-docker-install.log 2>&1 && sudo usermod -aG docker $USER && sudo docker --version' \
          || die "Docker install failed on the target — see /tmp/fiddy-docker-install.log"
        warn "added $USER to the docker group — reconnect may be needed for passwordless docker"
      fi
      ;;
  esac
}

# .env must exist before snapchain.sh runs: it gates every command on the
# operator agreement and, with no tty, stops all containers instead of asking.
remote_seed_snapchain_env() {
  local fid="${FIDDY_OPERATOR_FID:-0}"
  # STATSD_*_PUBLISH: keep the node's metrics ports on loopback and out of the
  # way, so a shared host's 8125/8126 stay free (upstream default binds 0.0.0.0).
  ssh_run "mkdir -p ~/snapchain && cd ~/snapchain && fetch_script=\$(mktemp) &&
    curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh -o \"\$fetch_script\" &&
    mv \"\$fetch_script\" snapchain.sh && chmod +x snapchain.sh &&
    printf 'AGREE_NO_REWARDS_FOR_ME=true\nHUB_OPERATOR_FID=%s\nSKIP_CRONTAB=true\nSTATSD_PUBLISH=127.0.0.1:18125\nSTATSD_ADMIN_PUBLISH=127.0.0.1:18126\n' '$fid' > .env &&
    chmod 600 .env && grep -c . .env" \
    || die "could not fetch snapchain.sh / seed .env on $FIDDY_TARGET"
  local version
  version="$(ssh_run 'cd ~/snapchain && ./snapchain.sh help >/dev/null 2>&1 && echo snapchain.sh-ok')"
  case "$version" in
    *snapchain.sh-ok*) ok "snapchain.sh installed, .env seeded (no rewards agreement, no host-wide cron)" ;;
    *) die "snapchain.sh did not run on $FIDDY_TARGET" ;;
  esac
}

remote_start_upgrade() { # remote_start_upgrade [grafana_blocked 0|1]
  local blocked="${1:-0}"
  log "starting the node (detached; logs → ~/snapchain/upgrade.log)…"
  ssh_run 'cd ~/snapchain && (setsid ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &) ; sleep 2; echo started' \
    || die "could not start snapchain.sh upgrade on $FIDDY_TARGET"

  if [ "$blocked" = 1 ]; then
    # snapchain.sh waits on http://127.0.0.1:3000/api/health with no timeout.
    # If :3000 belongs to something else, that wait never ends and the node
    # container is never started. Start it from the compose file the script
    # already fetched, and stop the stalled script.
    warn "port 3000 is taken on $FIDDY_TARGET — snapchain.sh's Grafana step will wait forever."
    log "starting the node containers directly from the fetched compose file…"
    local waited=0
    while [ "$waited" -lt 90 ]; do
      if ssh_run 'test -s ~/snapchain/docker-compose.yml && test -s ~/snapchain/validators.toml'; then break; fi
      sleep 5; waited=$((waited + 5))
    done
    ssh_run 'cd ~/snapchain && docker compose up -d snapchain' \
      || die "could not start the node container on $FIDDY_TARGET"
    # Pattern is bracketed so pkill does not match the shell running it.
    ssh_run 'pkill -f "snapchain[.]sh upgrade" 2>/dev/null || sudo -n pkill -f "snapchain[.]sh upgrade" 2>/dev/null || true' || true
    ok "node container started without Grafana (no metrics dashboard on this host)"
  fi
}

# --- local install steps (used by --local and by the macOS path) ----------

fetch_snapchain_script() {
  local tmp
  tmp="$(mktemp)"
  curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh -o "$tmp" || die "could not fetch snapchain.sh"
  mv "$tmp" snapchain.sh && chmod +x snapchain.sh
}

seed_env_file() {
  local fid="${FIDDY_OPERATOR_FID:-0}"
  printf 'AGREE_NO_REWARDS_FOR_ME=true\nHUB_OPERATOR_FID=%s\nSKIP_CRONTAB=true\n' "$fid" > .env
  chmod 600 .env
}

start_upgrade_detached() {
  nohup ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &
  log "snapchain.sh upgrade started (logs → $PWD/upgrade.log)"
}

# --- status / lifecycle ---------------------------------------------------

node_status() {
  require_target
  config_load
  local host="${FIDDY_TARGET#*@}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  step "Node status ($base)"
  local body
  body="$(curl -fsS --max-time 10 "$base/v1/info")" || die "node not answering — try: fiddy node logs"
  printf '%s\n' "$body" | if command -v jq >/dev/null 2>&1; then jq '.'; else cat; fi
}

node_verify() { # the bounty's acceptance checks, against the node's HTTP API
  local fid="${1:-3}"
  require jq "install jq (snapchain.sh installs it on the node host)"
  require_target
  config_load
  local host="${FIDDY_TARGET#*@}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  local fails=0

  step "Verifying the node at $base (fid $fid)"

  # 1. Health / sync state
  local info
  if info="$(curl -fsS --max-time 10 "$base/v1/info")"; then
    printf '  %-26s %s\n' "/v1/info:" "OK"
    printf '%s\n' "$info" | jq -r '"    version=\(.version.string // "?" ) height=\(.maxHeight // 0) blockDelay=\(.blockDelay // 0)s shards=\((.shardInfo // {}) | length)"' 2>/dev/null \
      || printf '%s\n' "$info" | head -3
  else
    printf '  %-26s %s\n' "/v1/info:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  # 2. Reads served by this node (no third-party API involved)
  local casts count
  if casts="$(curl -fsS --max-time 15 "$base/v1/castsByFid?fid=$fid&pageSize=2&reverse=1")"; then
    count="$(printf '%s' "$casts" | jq -r '.messages | length' 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then
      printf '  %-26s %s\n' "/v1/castsByFid:" "OK — this node served ${count} cast(s) for fid $fid"
      printf '%s' "$casts" | jq -r '.messages[0].data.castAddBody.text' 2>/dev/null | sed 's/^/    "&/;s/$/"/' | head -3
    else
      printf '  %-26s %s\n' "/v1/castsByFid:" "EMPTY — node answered, no data for fid $fid yet"
      printf '    %s\n' "expected while the snapshot is still loading; re-run after sync"
      fails=$((fails + 1))
    fi
  else
    printf '  %-26s %s\n' "/v1/castsByFid:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  # 3. Signers (the gasless KEY_ADD surface lives here)
  local signers
  if signers="$(curl -fsS --max-time 15 "$base/v1/signersByFid?fid=$fid")"; then
    printf '  %-26s %s\n' "/v1/signersByFid:" "OK — $(printf '%s' "$signers" | jq -r '.messages | length') key(s) for fid $fid"
  else
    printf '  %-26s %s\n' "/v1/signersByFid:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  echo ""
  if [ "$fails" = 0 ]; then
    ok "reads and key lookups are served by this node."
  else
    warn "$fails check(s) not satisfied yet."
  fi
  log "writes: POST /v1/submitMessage accepts a signed message (gasless KEY_ADD included)"
  log "and gossips it to validators — a 200 means accepted for relay, not merged."
  log "confirm inclusion with MERGE_MESSAGE events or by querying the message back."
}

require_snapchain_remote() {
  require_target
  ssh_run 'test -d ~/snapchain && test -f ~/snapchain/snapchain.sh' \
    || die "no Snapchain install on $FIDDY_TARGET — run: fiddy node up"
}

node_logs() {
  require_snapchain_remote
  ssh_run_tty 'cd ~/snapchain && ./snapchain.sh logs'
}

node_stop() {
  require_snapchain_remote
  ssh_run 'cd ~/snapchain && ./snapchain.sh down' && ok "node containers stopped"
}

node_start() {
  require_snapchain_remote
  # snapchain.sh up tails logs with -f, so start the containers directly and
  # keep the command non-blocking.
  ssh_run 'cd ~/snapchain && docker compose up -d snapchain statsd' >/dev/null && ok "node containers started"
}

node_upgrade() {
  require_snapchain_remote
  log "running snapchain.sh upgrade (detached)…"
  ssh_run 'cd ~/snapchain && (setsid ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &) ; sleep 2; tail -n 5 upgrade.log' \
    || die "upgrade failed to start"
  ok "upgrade running in the background — fiddy node logs to follow"
}