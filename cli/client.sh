# shellcheck shell=bash
# fiddy client — command (2): the Fiddy client, reading from YOUR node.
#
# Writes go to your node too (submitMessage on a read node gossips to
# validators). App keys are gasless KEY_ADD messages — no ETH, no Optimism
# transaction. Your seed phrase is only ever used in the browser, only to
# authorize the client's app key — use a TEST account.

client_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up) client_up "$@" ;;
    -h|--help|"")
      cat <<'EOF'
fiddy client — run the Fiddy client against your node.

  up [--tunnel] [--build]
      Point the web client at your node and start it.
      --tunnel   Your node API is not public (default): open an SSH tunnel
                 local 3381 -> remote 3381 for the session.
      --build    Production build instead of the dev server.

Reads: your read node's HTTP API. No Neynar, no Alchemy, no API keys.
EOF
      ;;
    *) die "unknown client command: $sub" ;;
  esac
}

client_up() {
  local tunnel=0 build=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --tunnel) tunnel=1 ;;
      --build)  build=1 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  config_load
  require pnpm "install: https://pnpm.io/installation"

  local web_env="$FIDDY_REPO/apps/farcaster-web/.env.local"
  local node_url="${FIDDY_NODE_HTTP:-}"

  if [ "$tunnel" = 1 ] || [ -z "$node_url" ]; then
    require_target
    log "opening SSH tunnel: 127.0.0.1:$SNAP_HTTP_PORT → $FIDDY_TARGET:$SNAP_HTTP_PORT"
    ssh_opts_fill
    ssh "${FIDDY_SSH_OPTS[@]}" -N -L "$SNAP_HTTP_PORT:127.0.0.1:$SNAP_HTTP_PORT" "$FIDDY_TARGET" &
    local tunnel_pid=$!
    trap 'kill $tunnel_pid 2>/dev/null || true' EXIT
    sleep 2
    node_url="http://127.0.0.1:$SNAP_HTTP_PORT"
  fi

  wait_for_node "$node_url" 6

  step "Configuring the client"
  {
    [ -f "$FIDDY_REPO/apps/farcaster-web/.env.example" ] && grep -v '^#' "$FIDDY_REPO/apps/farcaster-web/.env.example" | grep '=' || true
    echo "VITE_SNAPCHAIN_HTTP_URL=$node_url"
    [ -n "${FIDDY_NODE_GRPC:-}" ] && echo "VITE_SNAPCHAIN_GRPC_URL=$FIDDY_NODE_GRPC"
  } > "$web_env"
  ok "wrote $web_env (node: $node_url)"

  # Say out loud where the client's reads actually come from. The env var above
  # is only useful once the web app consumes it; until then a newcomer would
  # otherwise believe the feed they see is served by the node they just built.
  if grep -rqs "VITE_SNAPCHAIN_HTTP_URL" "$FIDDY_REPO/apps/farcaster-web/src" 2>/dev/null; then
    ok "the client reads through your node: $node_url"
  else
    warn "this build of the web client does not consume VITE_SNAPCHAIN_HTTP_URL yet: its"
    warn "reads still go through the public Farcaster API. Your node is fine — prove it"
    warn "independently with: fiddy node status   (see README → Status for the wiring)"
  fi

  if [ ! -d "$FIDDY_REPO/node_modules" ]; then
    log "installing dependencies (first run takes a few minutes)…"
    ( cd "$FIDDY_REPO" && pnpm install )
  fi

  step "Starting Fiddy"
  if [ "$build" = 1 ]; then
    ( cd "$FIDDY_REPO" && pnpm --filter farcaster-web build && pnpm --filter farcaster-web preview )
  else
    log "the dev server serves HTTPS with a self-signed certificate (vite-plugin-basic-ssl)."
    log "open the URL vite prints — https://localhost:5173/ — and accept the certificate"
    log "warning; the http:// form of that address answers nothing."
    ( cd "$FIDDY_REPO" && pnpm --filter farcaster-web dev )
  fi
}
