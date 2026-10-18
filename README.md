# Fiddy — your own Farcaster client, on your own node, in three commands

Fiddy is a forkable Farcaster client with external wallet support that reads
and writes through **your own Snapchain read node** — no API keys, no Neynar,
no Alchemy. You furnish the compute; the node syncs the network.

Full tutorial (mobile + desktop, protocol concepts explained as you go):
**https://fiddy.fun/client** — or open `site/index.html` locally.

## Quickstart

```bash
git clone https://github.com/ivcained/fiddy && cd fiddy
export PATH="$PWD/bin:$PATH"       # makes `fiddy` resolve (or use `bash bin/fiddy …`)

fiddy provision   # (0) compute: AWS EC2 via the aws CLI, or register any server (--ssh user@host)
fiddy node up     # (1) Snapchain read node on that compute — sizing check, install, sync
fiddy client up   # (2) the Fiddy web client, SSH-tunneled to your node by default
```

`fiddy doctor` checks your local prerequisites (and tells you whether this
machine could host a node itself); `fiddy node status` answers "is it working?"
in plain words instead of dumping JSON; `fiddy client up --tunnel` is the
default because node APIs should not be public.

**Before you buy anything:** a read node needs **4 vCPU, 16 GB RAM and 1.5–2 TB
of free disk** on Ubuntu 22.04+, with ports 3381–3383 reachable. The ~200 GB
mainnet snapshot is the *compressed* size — it decompresses to several times
that, and block pruning is off by default, so a smaller disk fails halfway
through a multi-hour sync. `fiddy node up` reads the box's CPU, RAM and free
disk first and refuses to install when it cannot hold the node, printing what
it found and what to change. On AWS list price that box is ~$285/month
(instance ~$121 + 2 TB gp3 ~$164); a 2 TB VPS from a Hetzner/Contabo/OVH-class
host is usually $50–80/month.

## Verify it works

Three checks, in the order the commands run. A brand-new node that passes all
three is exactly as "working" as a node can be before it finishes syncing —
full sync takes hours, and everything below answers immediately.

```bash
fiddy node status      # (1) the API answers, and what the node knows
curl -fsS http://127.0.0.1:3381/v1/info   # (2) same thing by hand, for a tunneled node
fiddy client up        # (3) the web client boots at https://localhost:5173/
```

(1) prints a verdict like this when the node is healthy — compare it against
the live public read node, which needs no provisioning at all:

```text
$ fiddy node status
Node status (https://haatz.quilibrium.com)
✓ the node API is answering — that is what "working" means for a read node
  version 0.13.5 · 3 shards · max height 49002434 · 914248045 messages stored
```

(2) returns the same `/v1/info` JSON: `"shardInfos"`, `"maxHeight"`,
`"version"`. Run it minute to minute — a **rising** `maxHeight` means the node
is still syncing, which is what you want to see. Anything HTML back means you
pointed the CLI at a docs site rather than a node.

(3) starts the client on **HTTPS with a self-signed certificate** (`https://localhost:5173/`):
accept the browser warning, or the page will look broken — `http://` answers
nothing. The CLI also prints which API the client's reads come from; today that
is the public Farcaster API, not your node (see **Status** below for the
wiring, which is in progress).

**Posting is gasless.** The client issues itself an app key with a `KEY_ADD`
message signed by your custody address — no ETH, no Optimism transaction,
live in about a second. Import a seed phrase from a **test account** that
already has storage: the seed never leaves your browser, and it only ever
authorizes the app key. Read
[the seed-phrase safety section](https://fiddy.fun/client#safety) before
importing anything.

## Status

Two things are honest-must-knows before a clean run means what it says, both
dated 2026-10-18 and both tracked in this repo:

- **The web client's read path does not consume your node URL yet.** The CLI
  writes `VITE_SNAPCHAIN_HTTP_URL` into `apps/farcaster-web/.env.local`, and
  `fiddy client up` prints a warning when the build does not read it: until the
  node-backed read path lands, the client's feed comes from the public
  Farcaster API. Your node is unaffected — verify it with `fiddy node status`.
- **`fiddy node up --local` needs the same 1.5–2 TB free** as a server, so on a
  laptop it is a check, not a shortcut: `fiddy doctor` tells you which side of
  the line this machine is on. Provisioning a 2 TB box is the real path.

## What you get

- **Your reads and writes, your infra** — feed, casts, follows, reactions and
  include/exclude of other clients' casts, all served by your node.
- **External wallets, non-custodial** — WalletConnect (EVM + Solana),
  EIP-6963 discovery, optional unified MetaMask Connect. No seed phrase is
  created, requested, or stored by the client beyond the local import above.
- **The Fiddy Agent (optional)** — one click hatches your own Hermes agent on
  Agent37 cloud that lives in the client and can connect to every channel
  you approve.

---

# Farcaster Wallet Client (upstream)

A fork of the [Farcaster client snapshot](https://github.com/farcasterxyz/client)
that adds a non-custodial wallet experience to the web client.

The original snapshot intentionally excludes the Farcaster Wallet
implementation. This fork fills that gap with external wallets: users keep
control of their keys and approve every connection, signature, and transaction
in their own wallet.

## Wallet features

- WalletConnect support for EVM and Solana QR, mobile, browser, and
  wallet-directory flows
- Optional Unified MetaMask mode that connects EVM and Solana atomically
  through MetaMask Connect
- Automatic discovery of modern EIP-6963 browser wallets
- Persistent EVM and Solana connections shared by the dashboard and Farcaster
  miniapps
- EIP-1193 EVM and Farcaster Solana provider support for miniapp connections,
  signatures, and transactions
- Connected address, native balance, and token portfolio on eight EVM networks
- Receive address with QR code and copy action
- Native-asset and ERC-20 sending with live balance checks
- Same-chain swaps between native assets and arbitrary ERC-20 contracts
- Quote, route, minimum received, allowance, approval, and transaction handling
- Chain-aware token embeds that open Trade with the selected token prefilled
- Five-item network activity page with transaction and explorer links
- Explicit disconnect and reconnect flow
- Independent Solana wallet support through Wallet Standard discovery and
  WalletConnect: SOL and SPL/Token-2022 portfolio, receive, send, same-chain
  swaps, and a five-item activity feed classified from real on-chain data.
  Solana connects, restores, and disconnects without affecting the EVM wallet

## How it works

The web client uses Wagmi for EVM connection state and Wallet Standard for
Solana connection state, then exposes each selected external wallet through the
client's wallet contexts. Miniapps and the corresponding EVM or Solana
dashboard flows consume the same provider and address. A Solana miniapp can
connect, sign messages, sign transactions, and sign and submit transactions
through the selected external Solana wallet.

WalletConnect is the universal fallback for both wallet families. EVM and
Solana WalletConnect sessions use isolated storage and remain independent, so
both can stay connected at the same time. A remembered Solana WalletConnect
session restores silently after refresh without opening a new pairing prompt.
Compatible EVM browser extensions are discovered through EIP-6963, while
compatible Solana extensions are discovered through Wallet Standard. No seed
phrase or private key is created, requested, or stored by this client.

Unified MetaMask is an alternative to those independent connections. It asks
MetaMask Connect for the supported EVM networks and Solana Mainnet together,
then exposes the resulting EVM provider and Solana Wallet Standard signer
through the same dashboard and miniapp pipes. The connection is atomic: both
an EVM address and a Solana address must be available and the Solana signer
must be ready before either side is published. An incomplete attempt is
disconnected instead of leaving a hidden partial wallet. Unified and
independent modes are mutually exclusive, while independent EVM and Solana
wallets may still coexist with each other.

Swap quotes and transaction requests come from the public LI.FI quote API.
The connected wallet remains responsible for approvals and transaction signing.
Structured Farcaster token embeds can pass their existing chain and contract
metadata into the external-wallet dashboard. The dashboard selects the matching
EVM or Solana family, requests an EVM network change when necessary, and opens
Trade with that token as the buy asset. It never guesses the chain for a raw
contract address or automatically requests a quote, signature, or transaction.

LI.FI also supplies wallet token discovery, token metadata, and estimated prices.
Portfolio, Send, and Trade share one cache keyed by chain + wallet + token contract.
Displayed quantities are checked onchain rather than trusting indexed holdings;
preflight reads update that same cache before sending or swapping. Farcaster's
wallet positions API is not used by these screens. See the web README for
[wallet data sources and limitations](apps/farcaster-web/README.md#wallet-data-sources).

The wallet currently supports Base, Ethereum, Arbitrum One, BNB Smart Chain,
Celo, Monad, HyperEVM, and Robinhood Chain. Base remains the default network.
Solana Mainnet is supported as a fully independent wallet family alongside
these EVM networks, using Solana RPC rather than Wagmi. See the web README's
[wallet behavior](apps/farcaster-web/README.md#wallet-behavior) section for
what Solana currently supports.

## Requirements

- Node.js 20.19.5 (see `.node-version`)
- pnpm 10.8.1 (declared in `package.json`)
- A Reown project ID for WalletConnect
- Etherscan and Alchemy API keys for complete multichain EVM activity
- A Solana RPC endpoint for hosted deployments (see the web README's
  `SOLANA_RPC_URL` documentation)

## Web quick start

Clone your fork and install the workspace:

```sh
git clone https://github.com/ivcained/fiddy && cd fiddy
pnpm install --frozen-lockfile
pnpm build:packages
```

`pnpm` 10.8.1+ is required (declared in `package.json`). `corepack enable` was
the old way to get it and is no longer shipped with Node 25+, so install pnpm
directly (`npm install -g pnpm@10`). `pnpm install` resolves the whole
workspace (~4 GB of `node_modules`) in a few minutes; `pnpm build:packages` is
only needed when you are changing the shared packages.

Configure WalletConnect:

```sh
cp apps/farcaster-web/.env.example apps/farcaster-web/.env.local
```

Set the public Reown project identifier in `.env.local`:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_reown_project_id
```

Then start the web client:

```sh
pnpm --filter farcaster-web dev
```

Open the local URL printed by Vite. When actively changing shared packages, run
`pnpm watch` in another terminal.

See [`apps/farcaster-web/README.md`](./apps/farcaster-web/README.md) for web-only
commands and configuration details.

## Cloudflare Pages deployment

Demo: [farcaster-wallet-client.pages.dev](https://farcaster-wallet-client.pages.dev/).

The hosted client needs both the web build and the same-origin API relay in
`functions/~api/[[path]].ts`. Uploading only the static build is not enough for
hosted Farcaster login. The relay forwards API requests to Farcaster; this fork
does not include an independent Farcaster backend.

Use Cloudflare Pages Git integration with the repository root as the build
root. See the [deployment guide](./apps/farcaster-web/README.md#cloudflare-pages-deployment)
for exact build settings, environment variables, login checks, and limitations.

## Validation

```sh
pnpm --filter farcaster-web typecheck
pnpm --filter farcaster-web lint
pnpm --filter farcaster-web test
pnpm --filter farcaster-web build
```

The wallet flows have also been exercised manually with EVM and Solana
WalletConnect, Unified MetaMask Connect on mobile, a browser with no injected
wallet, detected browser wallets, page refreshes, cancelled pairings, miniapp
transactions, sends, swaps, rejected approvals, and disconnect/reconnect
cycles.

## Security notes

- Never enter a seed phrase or private key into this client.
- Verify token contract addresses before requesting swap quotes.
- Review the destination, value, chain, allowance, and calldata in the connected
  wallet before approving.
- Arbitrary tokens and external routing APIs may be unavailable, illiquid, or
  malicious.
- Use a low-value wallet while developing or testing.

## Current scope

- Wallet additions currently target the web client; the mobile client remains
  the upstream snapshot implementation.
- Portfolio, receive guidance, sends, same-chain swaps, and recent activity
  target the eight documented EVM networks, plus Solana Mainnet with the same
  feature set. EVM and Solana can connect independently or together through
  Unified MetaMask. Miniapps use the shared EVM or Solana connection according
  to the provider interface they request.
- Token discovery/pricing depends on LI.FI coverage; unknown tokens or prices may
  be unavailable. Complete recent EVM history depends on Etherscan or Alchemy;
  locally submitted EVM transactions remain visible while an indexer catches
  up. Solana Activity reads directly from Solana RPC instead of an indexer, so
  it has no equivalent local/optimistic fallback; see the web README's
  [Recent activity](apps/farcaster-web/README.md#recent-activity) section.
- Swap execution depends on LI.FI route availability and downstream liquidity.
- Local development uses the production Farcaster API directly by default;
  hosted builds use it through the same-origin relay. This is not a sandbox.
- Some miniapps restrict embedding or trusted client origins. The API relay
  does not remove those restrictions; compatibility depends on each miniapp.

## Upstream snapshot

This repository began as a snapshot of the Farcaster client monorepo. The
original snapshot is a one-way generated reference whose `main` branch may be
replaced by future snapshots. This fork maintains its wallet changes separately;
review upstream snapshot updates before merging them.

## License

MIT. See [`LICENSE`](./LICENSE).
