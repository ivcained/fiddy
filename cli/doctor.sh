# shellcheck shell=bash
# fiddy doctor — local prerequisite check.

doctor_main() {
  step "fiddy doctor"
  local fail=0
  check() { # cmd, install hint, required(1)/optional(0)
    if command -v "$1" >/dev/null 2>&1; then
      ok "$1 — $(command -v "$1")"
    elif [ "$3" = 1 ]; then
      warn "$1 missing — $2"; fail=1
    else
      warn "$1 missing (optional) — $2"
    fi
  }
  check ssh    "install openssh" 1
  check curl   "install curl" 1
  check pnpm   "https://pnpm.io/installation (need 10.8.1+)" 1
  check node   "https://nodejs.org (need 20.19.5+)" 1
  check aws    "only for: fiddy provision --aws" 0
  check docker "only for: fiddy node up --local" 0

  # Informational: the CLI runs on macOS's bash 3.2 as well as bash 5 — but say
  # which one you're on, because the remote helpers used to need 4+.
  if [ -n "${BASH_VERSION:-}" ]; then
    ok "bash $BASH_VERSION — $(command -v bash)"
  else
    warn "not running under bash (BASH_VERSION unset) — use: bash bin/fiddy doctor"; fail=1
  fi

  if command -v node >/dev/null 2>&1; then
    local nv; nv="$(node -v | tr -d v)"
    [ "$(printf '%s\n20.19.5\n' "$nv" | sort -V | head -1)" = "20.19.5" ] \
      && ok "node $nv ≥ 20.19.5" || warn "node $nv too old — need ≥ 20.19.5"
  fi

  # Sizing, reported never fatal: the *target* is checked for real by
  # `fiddy node up`, and this line is what tells you whether `--local` is even
  # worth trying on this machine.
  if command -v df >/dev/null 2>&1; then
    echo ""
    FIDDY_SIZING_FATAL=0 check_node_sizing "$(node_facts_local)" || true
    log "(--local needs this machine to have ${FIDDY_MIN_DISK_GB}+ GB free; the remote target is checked by fiddy node up)"
  fi

  echo ""
  if [ -f "$FIDDY_CONFIG" ]; then config_show; else log "no config yet — run: fiddy provision"; fi
  [ "$fail" = 0 ] && ok "ready" || die "fix the missing requirements above"
}
