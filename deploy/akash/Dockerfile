# Fiddy's Snapchain read node, packaged for Akash (and any container host).
#
# Build it with deploy/akash as the context — the config and scripts it bakes in
# live there, so the repo root is the wrong context:
#   docker build -t fiddy-node:test deploy/akash
#   ./deploy/akash/smoke-test.sh fiddy-node:test
#
# Upstream publishes a distroless image only (Dockerfile.distroless ->
# gcr.io/distroless/cc-debian13: no shell, no apt, no coreutils). Building ON
# that base is not possible — the first RUN cannot start — and the moving
# `latest` tag turned into exactly that image on 2026-10-28, breaking this
# build. So instead of inheriting it, we copy the node out of the pinned
# upstream image into a slim Debian runtime that has the shell and tools
# entrypoint.sh and fiddy-status need.
#
# Pin by digest, not tag. Tags move; this digest is snapchain 0.16.0 (built
# from upstream's Dockerfile.distroless). Bump it deliberately, then rerun the
# smoke test in .github/workflows/akash-image.yml before deploying.
FROM farcasterxyz/snapchain:0.16.0@sha256:f3e5810189aa2543329948311810472aadc21e6c9e1c48d5129afe7eb550251b AS upstream

# Debian 13 (trixie) is the same glibc/libssl lineage as the distroless base
# upstream ships, plus the shell this image works in. The lib* packages mirror
# what upstream's distroless base bundles for the node — installed explicitly so
# the runtime surface matches upstream instead of depending on base-image luck.
FROM debian:trixie-slim

# curl powers the startup update check and is handy for /v1/info in the shell.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        libssl3t64 \
        libzstd1 \
        zlib1g \
        libgomp1 \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# snapchain, fc and upstream's onchain-config scripts, straight from the
# pinned image. Nothing else in it is needed (or runnable) here.
COPY --from=upstream /app/ /app/

COPY config.toml /app/config.toml
COPY entrypoint.sh /app/entrypoint.sh
COPY fiddy-status /usr/local/bin/fiddy-status
# Plain `chmod`, not COPY --chmod: the files are not executable in git, and
# this keeps `docker build` working on the legacy builder as well as buildx.
RUN chmod 0755 /app/entrypoint.sh /usr/local/bin/fiddy-status

# Node data lives here; mount persistent storage at these paths.
# /app/.rocks          chain state (2 TiB recommended)
# /app/.rocks.snapshot snapshot download scratch (1 TiB recommended)
ENV RUST_BACKTRACE=full
ENV FIDDY_IMAGE_VERSION=0.1.4

EXPOSE 3381/tcp 3382/udp 3383/tcp

ENTRYPOINT ["/app/entrypoint.sh"]