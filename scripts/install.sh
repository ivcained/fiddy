#!/usr/bin/env bash
# fiddy one-command installer:
#   curl -fsSL https://fiddy.fun/client/install.sh | bash
# Clones the repo, puts `fiddy` on PATH permanently, and starts your
# Snapchain read node on this machine. Provision a server first
# (https://fiddy.fun/client/deploy/) or run this on a machine with
# 4 vCPU / 16 GB RAM / 2 TB free disk.
set -euo pipefail

REPO_URL="${FIDDY_REPO_URL:-https://github.com/ivcained/fiddy}"
DEST="${FIDDY_INSTALL_DIR:-$HOME/fiddy}"

echo "▸ fiddy install — your own Farcaster node + client"
command -v git >/dev/null 2>&1 || {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y git
  else
    echo "git is required — install it and re-run." >&2; exit 1
  fi
}

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
else
  git clone "$REPO_URL" "$DEST"
fi

echo "▸ putting fiddy on PATH"
"$DEST/bin/fiddy" install || sudo ln -sf "$DEST/bin/fiddy" /usr/local/bin/fiddy

echo "▸ starting your read node (preflight runs first — it refuses an undersized box)"
fiddy node up --local
