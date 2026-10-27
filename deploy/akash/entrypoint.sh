#!/bin/bash
# Fiddy node entrypoint: metrics are optional, never fatal.
# Upstream's read_node config points at a statsd service by name. On hosts
# without that service (single-service Akash deploys, plain docker run) the
# node exits with MetricError before it ever starts. Strip the section when
# no statsd host resolves; keep full metrics when one does.
set -e

if ! getent hosts statsd >/dev/null 2>&1; then
  echo "[fiddy] no statsd service in this deployment; metrics go to loopback (disabled)" >&2
  # The statsd prefix is mandatory config, so keep the section but send UDP
  # metrics nowhere instead of deleting it or crash-looping on DNS.
  sed -i 's/^addr="statsd:8125"$/addr="127.0.0.1:8125"/' /app/config.toml
fi

# Update notice (never blocks start, never rewrites the container): if a newer
# image exists, say so in the logs with the exact redeploy instruction.
if command -v curl >/dev/null 2>&1; then
  LATEST=$(curl -fsS -m 8 https://raw.githubusercontent.com/ivcained/fiddy/main/deploy/akash/VERSION 2>/dev/null || true)
  LATEST=$(printf '%s' "$LATEST" | tr -d '[:space:]')
  if [ -n "$LATEST" ] && [ "$LATEST" != "$FIDDY_IMAGE_VERSION" ]; then
    echo "[fiddy] UPDATE AVAILABLE: $LATEST (this image: ${FIDDY_IMAGE_VERSION:-unknown})." >&2
    echo "[fiddy] Redeploy with ghcr.io/ivcained/fiddy-node:$LATEST (or :latest). Chain data persists." >&2
  fi
fi

exec ./snapchain --config-path config.toml

