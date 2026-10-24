# Snapchain or Hypersnap — the network choice, and what is actually known

Two networks, same idea. They carry the same kind of social data and do not talk
to each other:

- **Snapchain** — Farcaster's own network. The one every account, cast and follow
  lives on. This is the one to pick.
- **Hypersnap** — an independent parallel network built by the Quilibrium
  community. Same kind of social data, different plumbing and different
  economics. It is for explorers, and it is not where a Farcaster account lives.

This document is the record of what was measured while building the choice into
the CLI and the client, because the whole feature turns on one question: what can
Fiddy honestly offer?

## 1. Where each network can be read right now

| Endpoint                          | Measured 2026-10-24                              | Verdict |
| --------------------------------- | ------------------------------------------------ | ------- |
| `https://haatz.quilibrium.com`    | `GET /v1/info` → **200**, version `0.13.5`, 914,322,172 messages, 2 shards (heights 48,822,452 / 49,477,354 / 49,328,400) | Hypersnap's own documentation names this host as their public node, and it answers. **Readable.** |
| `https://snapchain-api.neynar.com` | `GET /v1/info` → **402** `X-PAYMENT header or API key required` | Not readable without a paid key. |
| `https://hub-api.neynar.com`       | `GET /v1/info` → **402** (same)                  | Not readable without a paid key. |
| `https://hub.farcaster.standardcrypto.vc` | no answer within 10 s                     | Gone. |

So: **Hypersnap has a public read route; Snapchain has none for a stranger.**
A Snapchain read needs a node of your own, which is exactly what `fiddy node up`
installs — which is why the client only offers Snapchain where such a node exists
(see §4) and why the CLI defaults to it.

## 2. A node cannot be asked which network it is

This is the fact that shapes the whole UI. MEASURED 2026-10-24, `GET
https://haatz.quilibrium.com/v1/info` answers exactly:

```json
{ "dbStats": {...}, "numShards": 2, "shardInfos": [...], "version": "0.13.5",
  "peer_id": "12D3KooWMY…", "nextEngineVersionTimestamp": 0 }
```

No network name, and `version` is shared lineage with Snapchain (Hypersnap is a
fork of the same codebase), so it cannot separate them either. Therefore:

- the client **never infers** a network from a response;
- a network comes from (a) a listed public address whose network was measured
  when it was added, or (b) `VITE_FIDDY_NETWORK`, which is what
  `fiddy client up` writes for the node it just pointed the client at;
- anything else is reported as **"Not recorded"**, with the reason, rather than
  guessed. `~/snapchain/networks.ts` is the one place this lives.

## 3. The self-hosted Hypersnap install is real, and does not produce a working node

Upstream publishes a bootstrap, a compose file and an image:

```
curl -sSL https://raw.githubusercontent.com/farcasterorg/hypersnap/refs/heads/main/scripts/hypersnap-bootstrap.sh | bash
  → ~/hypersnap/hypersnap.sh upgrade → docker compose, image farcasterorg/hypersnap:latest
  → HTTP :3381 · gossip :3382/udp · gRPC :3383
  → same host as a Snapchain node: 16 GB RAM, 4 vCPU, 1.5 TB free disk
```

Measured 2026-10-24, on the published install path:

- The **stable** channel (the default) fetches the installer from GitHub's
  `@latest` tag — `v0.11.8`, published 2026-05-07. That copy neither fetches nor
  mounts a validator list: `.../@latest/scripts/hypersnap.sh` → 200,
  `.../@latest/validators.toml` → **404**.
- The **main**-branch installer does fetch `validators.toml`, whose newest entry
  takes effect at block `39_798_000` (`39_180_000` shard 0, `39_624_000` shard 0,
  `39_798_000` shard 1) while the live network is at **49.5M** — the validator set
  has rotated since, and the published file does not carry the new keys.
- Consequence, as reported upstream in
  [farcasterorg/hypersnap#41](https://github.com/farcasterorg/hypersnap/issues/41)
  (**open**; two independent operators reproduced it, a third confirmed the fix):
  the node answers `/v1/info` and then stops following shards 1 and 2 with
  `Block contained signatures from unexpected signers`. **The repair that worked
  for them is to replace `~/hypersnap/validators.toml` with the validator list
  from the other project, `farcasterxyz/snapchain`,** which carries the three
  newer rotations.

A fresh install is therefore not a working node: it is a node that reports itself
healthy while falling behind. Fiddy will not install one and call it done.

**What the CLI does instead** (`cli/networks.sh`, `hypersnap_install_report` +
`hypersnap_refuse`): `fiddy node up --network hypersnap` prints the whole record
above — the install path, the stale list with its block heights, the open issue,
the repair, the host requirements — and exits 1, pointing at the two things that
do work today: reading the public Hypersnap node, and the upstream issue that
would change the verdict.

`--network snapchain` (the default) is unchanged: it installs Snapchain on the
target exactly as before, and now records `FIDDY_NODE_NETWORK=snapchain` in
`~/.fiddy/config` so the network is known later rather than assumed.

## 4. What the client does

- **`~/snapchain/networks.ts`** owns the vocabulary and the honesty rules:
  `readNetwork()` (which network, and where that answer came from),
  `routeForNetwork()` (the address reads would go to), `networkOffers()` (both
  networks, each with a route or a reason it has none).
- **Settings → your node** (`/~/settings/node`) is where the reader meets it: a
  **Network** card above the server picker states which network this client is
  reading, words both in the ELI5 language, and offers a network **only when
  there is an address for it**. On a build with no node of its own, Snapchain is
  shown as unavailable with the exact reason and the one command that changes it
  (`fiddy node up --network snapchain`, then `fiddy client up`) — never as a
  button that fails after it is pressed.
- Picking a network is not a label: it saves that network's address as the
  reader's server (the existing node choice), which is what actually moves the
  reads. `Your setup` in the same page then names the network.
- `PUBLIC_READ_NODES` gained a `network` field, and the public entry's name is now
  honest about what it is ("The public Hypersnap node" — it always was one; the
  picker used to call it "a public Farcaster node").

## 5. The release carries the network

`scripts/release-client.sh` sets `VITE_FIDDY_NETWORK` alongside
`VITE_SNAPCHAIN_HTTP_URL`: `hypersnap` when the build targets the known public
Hypersnap node (the default), `FIDDY_BUILD_NETWORK` otherwise, and nothing when
neither applies (so the client says "not recorded" rather than something wrong).
Step 3 refuses a build that has lost the network card or, when a network was
declared, the declared name.

`fiddy client up --network snapchain|hypersnap` writes both into
`apps/farcaster-web/.env.local`, so a self-hoster never hand-edits them:
`--network hypersnap` points the client at the public Hypersnap node with nothing
of theirs running, and `--network snapchain` (default) points it at their node.

## 6. Verification that was run

- CLI: `fiddy node up --network bogus` → `unknown network` + exit 1;
  `--network hypersnap` → the full report + exit 1 (no install attempted);
  `--network snapchain` on a machine with no target → the real installer path
  (dies at `require_target`), and `--local` on this laptop dies at the disk
  preflight: the flag routes into the real install, it does not stub it.
- CLI: `fiddy client up --network hypersnap` wrote
  `VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com` and
  `VITE_FIDDY_NETWORK=hypersnap` into `.env.local`, and made no SSH attempt.
- Client: `pnpm --filter farcaster-web lint` clean; `tsc --noEmit` and the test
  suite hold parity with a pristine `origin/main` worktree (the only tsc errors
  are the known stale-`dist` ones from the shared clones' built packages, and CI
  builds the packages fresh); the new tests are
  `src/snapchain/__tests__/networks.test.ts` and
  `src/pages/settingsNode/Component/NetworkChoiceCard.test.tsx`.