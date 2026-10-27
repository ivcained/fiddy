# Fiddy's Snapchain read node, packaged for Akash (and any container host).
# Base image is upstream's; we bake the read_node config so no host files are needed.
FROM farcasterxyz/snapchain:latest

# curl powers the startup update check and is handy for /v1/info in the shell.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY config.toml /app/config.toml
COPY entrypoint.sh /app/entrypoint.sh
COPY fiddy-status /usr/local/bin/fiddy-status
RUN chmod +x /app/entrypoint.sh /usr/local/bin/fiddy-status

# Node data lives here; mount persistent storage at these paths.
# /app/.rocks          chain state (2 TiB recommended)
# /app/.rocks.snapshot snapshot download scratch (1 TiB recommended)
ENV RUST_BACKTRACE=full
ENV FIDDY_IMAGE_VERSION=0.1.3

EXPOSE 3381/tcp 3382/udp 3383/tcp

ENTRYPOINT ["/app/entrypoint.sh"]
