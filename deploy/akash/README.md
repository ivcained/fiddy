# Fiddy on Akash

A Snapchain read node, packaged as a container deployment: `fiddy-node` image +
`sdl.yaml` (snapchain + statsd + grafana, persistent chain data).

## Image

`ghcr.io/ivcained/fiddy-node:0.1.1` (also `:latest`). Built from
`farcasterxyz/snapchain:latest` with the read-node config baked in
(`read_node = true`, mainnet, upstream validator sets and snapshot endpoint),
so no host files are needed. Built and smoke-tested on 2026-10-27: the
container boots and starts downloading the snapshot.

Rebuilds publish automatically via `.github/workflows/akash-image.yml`
(on every change to `deploy/akash/`, or manual dispatch).

**The GHCR package must be public for providers to pull it.**
One-time: https://github.com/users/ivcained/packages/container/fiddy-node/settings
→ Danger Zone → Change visibility → Public.

## Deploy

```sh
# with the akash skill (CC/Codex/OpenCode) or the Console:
#   deploy this SDL, then watch the bids before you accept anything
cat deploy/akash/sdl.yaml
```

- Persistent volumes (class `beta3`, SSD): `/app/.rocks` = 2 TiB (chain state),
  `/app/.rocks.snapshot` = 1 TiB (download scratch). Both survive redeploys.
- Ports: 3381 HTTP API (exposed as 80), 3382/udp gossip, 3383 gRPC.
- Grafana is optional: delete that service to save a compute line; the node
  API works without it. statsd is optional too: when no statsd service
  exists, the entrypoint sends metrics to loopback instead of crash-looping
  (0.1.1). Keep statsd + grafana if you want the dashboard.

## Costs — read this before accepting a lease

Akash has no fixed price list: **providers bid, and you see each bid's monthly
cost in the Console before you accept.** That bid is the real number; do not
budget from anyone's blog post.

- The `pricing` amounts in `sdl.yaml` are **ceilings, not quotes** — lower them
  and fewer providers bid; raise them and more do. 1 AKT/block for the node is
  deliberately generous so the first deploy finds bidders.
- The big cost drivers here are the 3 TiB of persistent SSD and 16 GiB RAM.
  Dropping Grafana saves a little; the disk is the bill.
- First sync downloads ~470 GB and takes hours; that is time, not extra
  compute. After it settles, steady-state is much lighter than bootstrap.

## Verify after deploy

```sh
curl http://<provider-host>/v1/info   # the exposed 3381-as-80 endpoint
# shard heights should climb; grafana (if kept) is on its own exposed host.
```
