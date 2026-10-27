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

exec ./snapchain --config-path config.toml
