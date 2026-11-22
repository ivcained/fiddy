#!/usr/bin/env bash
# Smoke-test a built fiddy-node image.
#
# Fails if the image lost its shell or tools, if the node binary cannot run or
# its shared libraries do not resolve, or if the baked config does not parse.
# The --check-config flag loads and validates the config, then exits without
# starting the node, so this needs no network and no chain data.
#
#   ./deploy/akash/smoke-test.sh ghcr.io/ivcained/fiddy-node:0.1.4
#   docker build -t fiddy-node:test deploy/akash && ./deploy/akash/smoke-test.sh fiddy-node:test
set -euo pipefail

IMAGE=${1:?usage: smoke-test.sh <image>}

docker run --rm --entrypoint /bin/bash "$IMAGE" -c '
set -euo pipefail

for t in bash curl sed grep awk find getent tr; do
  command -v "$t" >/dev/null || { echo "FAIL: missing tool: $t"; exit 1; }
done

[ -x /app/snapchain ] || { echo "FAIL: /app/snapchain is missing or not executable"; exit 1; }

if ldd /app/snapchain | grep -q "not found"; then
  echo "FAIL: unresolved shared libraries"
  ldd /app/snapchain
  exit 1
fi

cd /app
/app/snapchain --config-path /app/config.toml --check-config

# fiddy-status is what a user runs in the deployment shell; with no node on
# loopback it must still explain itself instead of erroring out.
/usr/local/bin/fiddy-status | grep -q "Still downloading" \
  || { echo "FAIL: fiddy-status did not print its waiting message"; exit 1; }

echo "smoke: ok"
'