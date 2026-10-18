# shellcheck shell=bash
# fiddy node — command (1): a Snapchain read node on your compute.
#
# A read node (read_node = true) follows the chain, stores full state, and
# serves the HTTP + gRPC APIs. Anyone can run one; no keys, no permission.
# It also accepts submitMessage and gossips valid messages to validators —
# it has no mempool of its own, so confirm inclusion via MERGE_MESSAGE events
# or by querying the message back.

node_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up)      node_up "$@" ;;
    status)  node_status ;;
    logs)    ssh_run 'cd ~/snapchain && ./snapchain.sh logs' ;;
    stop)    ssh_run 'cd ~/snapchain && ./snapchain.sh stop'  && ok "node stopped" ;;
    start)   ssh_run 'cd ~/snapchain && ./snapchain.sh start' && ok "node started" ;;
    upgrade) ssh_run 'cd ~/snapchain && ./snapchain.sh upgrade' && ok "node upgraded" ;;
    -h|--help|"")
      cat <<'EOF'
fiddy node — manage your Snapchain read node.

  up [--local]   Install Docker + Snapchain on the target, start syncing, and
                 wait until the HTTP API answers. Checks CPU / RAM / free disk
                 first and refuses an undersized box
                 (override: FIDDY_ALLOW_UNDERSIZED=1). --local runs on this
                 machine instead of the provisioned target.
  status         Read /v1/info and say plainly whether the node works.
  logs           Tail node logs (Ctrl-C to stop).
  stop | start | upgrade
                 Wrap snapchain.sh on the remote.
EOF
      ;;
    *) die "unknown node command: $sub" ;;
  esac
}

node_up() {
  local local_mode=0
  [ "${1:-}" = "--local" ] && local_mode=1

  step "Setting up a Snapchain read node"
  log "What you're getting: a read node (read_node = true). It follows the chain,"
  log "stores full state, serves HTTP :$SNAP_HTTP_PORT + gRPC :$SNAP_GRPC_PORT, and"
  log "relays your writes to validators over gossip. No API keys. Your compute only."

  if [ "$local_mode" = 1 ]; then
    node_install_local
  else
    node_install_remote
  fi
}

node_install_remote() {
  require_target
  log "target: $FIDDY_TARGET"

  # Check the box can hold a read node *before* installing anything: the
  # bootstrap pulls a ~200 GB compressed snapshot, and a small disk fails hours
  # in rather than at the start.
  check_node_sizing "$(node_facts_remote)" || die "could not read facts from $FIDDY_TARGET — check SSH access"

  log "ensuring Docker…"
  ssh_run 'command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sudo bash && sudo usermod -aG docker $USER; }; docker --version'

  log "installing Snapchain (official bootstrap)…"
  ssh_run 'mkdir -p ~/snapchain && cd ~/snapchain && curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh | bash'

  log "starting sync…"
  ssh_run 'cd ~/snapchain && (./snapchain.sh start || true)'

  local host="${FIDDY_TARGET#*@}"
  wait_for_node "http://$host:$SNAP_HTTP_PORT" 120

  config_set FIDDY_NODE_HTTP "http://$host:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "$host:$SNAP_GRPC_PORT"
  echo ""
  ok "Read node syncing. Full sync takes hours; the API answers immediately."
  node_status
  ok "Next: fiddy client up"
}

node_install_local() {
  require docker "install: https://docs.docker.com/get-docker/"
  require curl "install curl"
  mkdir -p "$FIDDY_HOME"
  check_node_sizing "$(node_facts_local)"
  mkdir -p "$FIDDY_HOME/snapchain"
  ( cd "$FIDDY_HOME/snapchain"
    curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh | bash
    ./snapchain.sh start || true )
  wait_for_node "http://127.0.0.1:$SNAP_HTTP_PORT" 120
  config_set FIDDY_NODE_HTTP "http://127.0.0.1:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "127.0.0.1:$SNAP_GRPC_PORT"
  ok "Local read node up. Next: fiddy client up"
}

node_status() {
  require_target
  config_load
  local host="${FIDDY_TARGET#*@}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  step "Node status ($base)"
  local body
  body="$(curl -fsS --max-time 10 "$base/v1/info")" || die "node not answering at $base/v1/info — if the node is up, check the SSH tunnel or the firewall; logs: fiddy node logs"
  node_info_verdict "$base" "$body"
}
