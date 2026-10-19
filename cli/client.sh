# shellcheck shell=bash
# fiddy client — command (2): the Fiddy client, pointed at your node.
#
# What is wired up today, and what is not:
#   * The client's data layer (apps/farcaster-web/src/contexts/
#     WebFarcasterApiClientProvider.tsx → farcaster-client-data) talks to
#     Farcaster's hosted API at https://farcaster.xyz/~api. Its ~700 routes
#     are that API's surface, not the Snapchain HTTP API.
#   * The Snapchain API is the Hubble-compatible /v1/* surface, so pointing
#     the client at the node needs an adapter; the app's own escape hatch for
#     one is `farcasterApi.local` → http://localhost:8080 (see
#     apps/farcaster-web/src/constants/api.ts).
#   * Writes are meant to go to the node's POST /v1/submitMessage — read nodes
#     accept them and gossip to validators.
#
# So `client up` writes the node URL into .env.local for the node-backed data
# layer and says plainly which upstream the app uses today. See
# docs/CLIENT-NODE-GAP.md for the adapter plan and the route inventory.
#
# App keys are gasless KEY_ADD messages — no ETH, no Optimism transaction.
# A seed phrase is only ever used in the browser, only to authorize the
# client's app key — use a TEST account.

client_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up) client_up "$@" ;;
    check) client_check ;;
    -h|--help|"")
      cat <<'EOF'
fiddy client — run the Fiddy client against your node.

  up [--tunnel] [--build]
      Point the web client at your node and start it.
      --tunnel   Your node API is not public (default): open an SSH tunnel
                 local 3381/3383 → remote 3381/3383 for the session.
      --build    Production build instead of the dev server.
  check          Verify the node API answers and report where the client's
                 reads go today.

Reads: the node serves them at /v1/* (Hubble-compatible). The client's own
data layer still uses Farcaster's hosted API — see docs/CLIENT-NODE-GAP.md.
EOF
      ;;
    *) die "unknown client command: $sub" ;;
  esac
}

client_node_layer_state() { # "wired" | "not wired" — detect, don't assume
  if grep -rqs "farcaster-node-client" "$FIDDY_REPO/apps/farcaster-web/src" 2>/dev/null \
     || grep -qs '"farcaster-node-client"' "$FIDDY_REPO/apps/farcaster-web/package.json" 2>/dev/null; then
    printf 'wired'
  else
    printf 'not wired'
  fi
}

client_check() {
  config_load
  local node_url="${FIDDY_NODE_HTTP:-}"
  step "Node"
  if [ -z "$node_url" ]; then
    warn "no node URL recorded yet — run: fiddy node up (or fiddy client up --tunnel)"
  else
    curl -fsS --max-time 10 "$node_url/v1/info" | node_info_summary \
      || warn "node at $node_url is not answering (a fresh node serves HTTP only after its snapshot bootstrap)"
  fi
  step "Client data layer"
  if [ "$(client_node_layer_state)" = wired ]; then
    ok "node-backed data layer present (farcaster-node-client is imported by the web app)"
    log "verify it: block farcaster.xyz / client.farcaster.xyz and check the feed still renders"
  else
    warn "node-backed data layer NOT wired into the web app yet"
    log "upstream API in use: https://farcaster.xyz/~api (farcaster-client-data)"
    log "details: docs/CLIENT-NODE-GAP.md"
  fi
  return 0
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
  local ssh_host=""

  if [ "$tunnel" = 1 ] || [ -z "$node_url" ]; then
    require_target
    if tunnel_forward_active "$SNAP_HTTP_PORT"; then
      log "127.0.0.1:$SNAP_HTTP_PORT is already forwarded — reusing the open tunnel"
      ssh_host=""
    else
      ssh_host="$FIDDY_TARGET"
    fi
    if [ -n "$ssh_host" ]; then
      # Prefer the recorded node address; fall back to HTTP on the target host.
      local host
      host="$(printf '%s' "$node_url" | sed -e 's#^http://##' -e 's#^https://##' -e 's#:.*$##')"
      [ -n "$host" ] || host="${FIDDY_TARGET#*@}"
      log "opening SSH tunnel: 127.0.0.1:$SNAP_HTTP_PORT/$SNAP_GRPC_PORT → $host:$SNAP_HTTP_PORT/$SNAP_GRPC_PORT"
      build_ssh_args
      ssh "${FIDDY_SSH_ARGS[@]}" -N \
        -L "$SNAP_HTTP_PORT:127.0.0.1:$SNAP_HTTP_PORT" \
        -L "$SNAP_GRPC_PORT:127.0.0.1:$SNAP_GRPC_PORT" \
        "$ssh_host" &
      local tunnel_pid=$!
      trap 'kill $tunnel_pid 2>/dev/null || true' EXIT
      config_set FIDDY_TUNNEL_PID "$tunnel_pid"
      sleep 2
    fi
    node_url="http://127.0.0.1:$SNAP_HTTP_PORT"
  fi

  # The node refuses HTTP for the whole snapshot bootstrap (up to ~2h), so do
  # not treat "not answering yet" as fatal here.
  if ! node_api_reachable "$node_url"; then
    warn "node at $node_url is not answering yet — a fresh read node only serves"
    warn "HTTP after its snapshot bootstrap finishes (up to ~2h). Starting the"
    warn "client anyway; check later with: fiddy node status"
  fi

  step "Configuring the client"
  {
    [ -f "$FIDDY_REPO/apps/farcaster-web/.env.example" ] && grep -v '^#' "$FIDDY_REPO/apps/farcaster-web/.env.example" | grep '=' || true
    echo "VITE_SNAPCHAIN_HTTP_URL=$node_url"
    [ -n "${FIDDY_NODE_GRPC:-}" ] && echo "VITE_SNAPCHAIN_GRPC_URL=$FIDDY_NODE_GRPC"
  } > "$web_env"
  ok "wrote $web_env (node: $node_url)"

  if [ "$(client_node_layer_state)" = wired ]; then
    ok "node-backed data layer present — the web app imports farcaster-node-client"
    log "confirm it with third-party APIs blocked: farcaster.xyz / client.farcaster.xyz off, feed still renders"
  else
    warn "reads and writes still go to Farcaster's hosted API (farcaster.xyz/~api):"
    warn "the node-backed data layer is not wired into the web app in this checkout."
    warn "the node URL above is recorded for it; details: docs/CLIENT-NODE-GAP.md"
  fi

  if [ ! -d "$FIDDY_REPO/node_modules" ]; then
    log "installing dependencies (first run takes a few minutes)…"
    ( cd "$FIDDY_REPO" && pnpm install )
  fi

  # The shared packages the web client imports expose dist/ builds, so a fresh
  # clone fails in vite with "Failed to resolve entry for package …" until they
  # are built.
  local need_build=0 d
  for d in farcaster-analytics farcaster-client-data farcaster-client-hooks farcaster-cryptography farcaster-cryptography-web; do
    if [ -f "$FIDDY_REPO/packages/$d/package.json" ] && [ ! -d "$FIDDY_REPO/packages/$d/dist" ]; then
      need_build=1
    fi
  done
  if [ "$need_build" = 1 ]; then
    log "building workspace packages (takes a few minutes on a fresh clone)…"
    ( cd "$FIDDY_REPO" && NODE_OPTIONS="--max_old_space_size=8192" pnpm build:packages ) \
      || die "workspace package build failed — run: cd $FIDDY_REPO && pnpm build:packages"
    ok "workspace packages built"
  fi

  step "Starting Fiddy"
  # The upstream dev server forces a self-signed HTTPS cert, which greets every
  # first-time user with a browser security warning. localhost is a secure
  # context over plain HTTP, so nothing needs it — default off, opt back in
  # with HTTPS=true.
  if [ "$build" = 1 ]; then
    ( cd "$FIDDY_REPO" && pnpm --filter farcaster-web build && pnpm --filter farcaster-web preview )
  else
    log "serving plain HTTP on localhost (set HTTPS=true to restore the self-signed cert)"
    ( cd "$FIDDY_REPO" && HTTPS="${HTTPS:-false}" pnpm --filter farcaster-web dev )
  fi
}