# Fiddy on Akash

A Snapchain read node, packaged as a container deployment: `fiddy-node` image +
`sdl.yaml` (snapchain + statsd + grafana, persistent chain data).

## Image

**Use `ghcr.io/ivcained/fiddy-node:latest` when deploying** — every redeploy
or pod restart then pulls the newest image, and the chain data persists.
Pin a version tag (e.g. `0.1.2`) only if you want a frozen setup. Built from
`farcasterxyz/snapchain:latest` with the read-node config baked in
(`read_node = true`, mainnet, upstream validator sets and snapshot endpoint),
so no host files are needed. Built and smoke-tested on 2026-10-27: the
container boots and starts downloading the snapshot.

Rebuilds publish automatically via `.github/workflows/akash-image.yml`
(on every change to `deploy/akash/`, or manual dispatch). The package is public,
so any provider can pull it.

## Deploy, step by step

**The Console way (no terminal needed):**

1. Get the deployment file: download [`sdl.yaml`](./sdl.yaml)
   (or copy its contents). It already has the right image, ports, and storage.
2. Open the [Akash Console](https://console.akash.network) and sign in.
   Make sure you have credits (Console shows your balance).
3. Create a new deployment and paste the SDL (or upload the file).
4. Wait ~30 seconds for provider bids. **Each bid shows its monthly price.**
   Nothing is spent until you accept one.
5. Accept the bid you want (cheapest is fine). Your node starts.
6. In the deployment's shell, run `fiddy-status` to watch it in plain words:
   "downloading history, X of 5700 chunks" first, then "LIVE" with shard heights.

**The agent way (CC, Codex, OpenCode):**

1. Install the Akash skill: `npx skills add akash-network/akash-skill --skill akash`
2. Tell your agent: "Deploy `deploy/akash/sdl.yaml` from
   https://github.com/ivcained/fiddy/tree/main/deploy/akash to Akash, and show me
   the monthly price of each bid before accepting anything."
3. Accept a bid, then check `fiddy-status` in the deployment shell.

Notes that apply either way:
- Persistent volumes (class `beta3`, SSD): `/app/.rocks` = 2 TiB (chain state),
  `/app/.rocks.snapshot` = 1 TiB (download scratch). Both survive redeploys.
- Ports — **declare all of these at deploy time; Akash cannot add ports to a
  running deployment.** Forgetting one means redeploying. The exact setup:

  | Container port | Exposed as | Protocol | Notes |
  |---|---|---|---|
  | 3381 | 80 | TCP | HTTP API (`/v1/info`, reads/writes). The ONLY mapping to external 80. |
  | 3382 | 3382 | UDP | Gossip. Required; without it the node is an island. |
  | 3383 | 3383 | TCP | gRPC API. |
  | 3000 | 3000 | TCP | Only if you deploy Grafana. Keep private/tunneled. |
  | ~~80 → 80~~ | — | — | Do NOT add this: a second mapping to external 80 conflicts. |

  The HTTP/gRPC APIs are public read/write by design: anyone can read and
  relay casts through your node.
- Grafana is optional: delete that service to save a compute line; the node
  API works without it. statsd is optional too: when no statsd service
  exists, the entrypoint sends metrics to loopback instead of crash-looping
  (0.1.1). Keep statsd + grafana if you want the dashboard.

## Budget options (if the persistent price stings)

1. **Persistent only where it matters most:** keep the 2 TiB `/app/.rocks`
   volume but make `/app/.rocks.snapshot` ephemeral. The snapshot scratch is
   only used during the first download; after that, the chain data is what
   matters. This cuts roughly a third of the persistent bill.
2. **Fully ephemeral (`sdl-budget.yaml`):** no persistent volumes at all.
   Cheapest possible. The trade: a pod reschedule wipes the chain and you
   re-download ~470 GB (hours). If the pod just runs, nothing re-downloads —
   this is a real, reasonable budget choice, not a broken one. Do NOT use it
   if you plan frequent redeploys.

## Storage: ephemeral vs persistent (and how to migrate)

- **Persistent (what our SDL uses):** `/app/.rocks` = 2 TiB, `/app/.rocks.snapshot` = 1 TiB,
  class `beta3`. Survives restarts and redeploys, so an image upgrade never
  re-downloads the chain. This is what you want.
- **Ephemeral:** fine only for the root filesystem (our config is tiny).
  On ephemeral chain storage, every pod reschedule means downloading ~470 GB again.
- **Pricing:** persistent storage costs more per GB than ephemeral, and the
  price is provider-specific — you see it inside each bid before accepting.
  The real number for our exact spec is in the live feed on fiddy.fun/client
  (Akash row) once the feed has bids; there is no honest flat rate to quote.
- **Already on ephemeral?** You cannot convert a volume in place. Create a new
  deployment with the persistent SDL, let it sync once (last full download),
  then close the old deployment. Copying 2 TiB between pods is slower and
  fiddlier than one clean resync, so resync is the recommended path.

## Updates

- On start, the image checks `deploy/akash/VERSION` on main and prints an
  `UPDATE AVAILABLE` line with the redeploy command when a newer image exists.
  `:latest` (the default in sdl.yaml) means every redeploy/restart upgrades you.
  It never rewrites itself: redeploying with the new tag (or `:latest`) is the
  upgrade, and the persistent volumes carry your chain data forward.

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
