# Fiddy's Snapchain read node, packaged for Akash (and any container host).
# Base image is upstream's; we bake the read_node config so no host files are needed.
FROM farcasterxyz/snapchain:latest

WORKDIR /app
COPY config.toml /app/config.toml
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Node data lives here; mount persistent storage at these paths.
# /app/.rocks          chain state (2 TiB recommended)
# /app/.rocks.snapshot snapshot download scratch (1 TiB recommended)
ENV RUST_BACKTRACE=full

EXPOSE 3381/tcp 3382/udp 3383/tcp

ENTRYPOINT ["/app/entrypoint.sh"]
