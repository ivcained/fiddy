# Making an account, holding more than one, and what leaves the device

Status: **implemented on branch `t_bb61fcf8-quilcast-adopt`** (three commits,
pushed; `main` untouched — see "Why a branch" at the end). This file is the
design record: what was built, what was deliberately not built, how it reconciles
with the control plane's onboarding design, and what a miniapp embed actually
hits in this client today.

Everything below marked MEASURED was read off a live network, a live contract, a
live node or the committed source at `d00b7a7` on 2026-10-21. Anything not
measured says so.

---

## 1. What shipped

### 1.1 Create a Farcaster account, on this device

`apps/farcaster-web/src/snapchain/accounts/` — a new module, its own tests (76
of them, no network), and the copy that drives it:

| file | what it is |
| --- | --- |
| `phrase.ts` | twelve words generated in the browser, validated with the **real BIP-39 checksum**, derived on `m/44'/60'/0'/0/0` (the path Warpcast/Quorum/Quilcast use, so the account opens anywhere), plus a fresh Ed25519 device key |
| `optimism.ts` | the registration: `price()` and `idOf()` read from Optimism, an EIP-1559 transaction signed **on this device** and sent over plain JSON-RPC, with fee/price ceilings the client refuses to cross |
| `username.ts` | name shape, availability from the name registry, and the claim signed with the registry's own EIP-712 `UserNameProof` struct |
| `createAccount.ts` | the two halves — `readFundingState` (read-only, polled while somebody sends ETH) and `finishAccountSetup` (signing key, @name, profile, each confirmed by reading the node back) |
| `nodeAccountOps.ts` | the node side, using the client that already exists (`issueAppKey`, `buildUserDataAddMessage`) — no second signing path |
| `localAccounts.ts` | the accounts this browser holds (see 1.2) |
| `session.ts` | signs the client in as one of them, using the same device-only session the SIWF sign-in produces |

UI: `components/fiddy/accounts/CreateAccountSheet.tsx` (pick a name → write the
words down → send the fee → progress → you're in) and
`components/fiddy/accounts/AccountSwitcher.tsx`. Both reuse the onboarding's own
`FiddySheet`, so a person cannot be told two different things about what Fiddy
is. Entry points: the sign-in modal (every existing mount of it) and the setup
flow's own front door.

#### The numbers, measured (2026-10-21, `https://mainnet.optimism.io`)

- `eth_chainId` → `0xa` (Optimism) and gas price → `0xf5201` (0.001004033 gwei)
- `IdGateway.price()` **and** `price(uint256)` → `0x4a0910b5d25a` =
  **81 402 795 512 410 wei** (≈ $0.20) — so the fee the screen shows is read, not
  hard-coded, and the ceilings (0.02 ETH, 10 gwei) sit ~245× above reality
- `IdRegistry.idOf(address)` answers `0` for an address with no account
- the deployed IdGateway's **own bytecode** carries both `register(address)`
  (`0x4420e486`) and `register(address,uint256)` (`0x6d705ebb`); this client signs
  the two-argument form, which is what `legitmate-farcaster/docs/farcaster/REGISTRATION.md`
  pins and what can carry extra storage later
- the node we read from (`haatz.quilibrium.com`): `/v1/onChainSignersByFid?fid=3`
  and `?fid=4242` answer with on-chain signer events, while an unregistered FID
  answers `events: []` — that empty list is what "the node has not seen the
  account yet" is measured against before a signing key is added

#### Payer ≠ custody, reconciled (not forked)

The control plane's design (`docs/farcaster/REGISTRATION.md`) prepares an
**unsigned** registration server-side: `to` is a dedicated owner wallet,
`recovery` a *different* address, and the HTTP handler derives the owner from
`to` rather than trusting a second browser field.
`docs/fiddy/ONBOARDING-CONTROLS-AUDIT.md` §2 records the same rule as an open
item: "bind registration `to`/`recovery` to `verifiedEmbeddedWallet(subject)`,
add the dedicated-custody and recovery-review steps, and state in-flow that
external funding does not transfer FID ownership."

What was built here **deliberately keeps the payer distinct from the custody
owner**, and says so where it matters:

- the registration names `recovery = the custody address this device derived`.
  `registerFid` takes `recovery` separately from the signer, so a wallet, a
  sponsor or a relay can pay and sign while the account stays in the custody
  address's name. In the shipped flow the fee is sent from any wallet or exchange
  to the locally-held address, so the funding source is external and the custody
  key is never anywhere but this browser — which is the property the control
  plane's rule is protecting;
- **the difference that remains, stated plainly:** this path sets
  `recovery = custody`. The control plane wants a *dedicated, different* recovery
  address so a compromised custody key can be recovered without it. In-flight copy
  does not claim otherwise, and this is the one open item the two designs do not
  yet agree on. It is a control-plane-shaped decision (it needs an address the
  server can attest to), so it belongs there, not in a fresh fork of the design.

### 1.2 More than one account

`localAccounts.ts` keeps a list, not a variable: one entry per custody address,
one selected at a time, and per-account keys where they already lived
(`appKeyStorage` is keyed by FID, so a key can never be used for the wrong
account). The switcher names what is true — "signing in as @x", "this device can
post" / "no posting key on this device yet" — and switching re-signs-in and
reboots clean rather than trying to swap identities under a running feed.

### 1.3 What leaves the device inside a photo (or does not)

`snapchain/nodeApi/photoPrivacy.ts`, wired into `uploadMedia` so both upload
hooks get it:

- **JPEG/PNG/WebP → re-encoded** as a ≤2048px JPEG, quality 0.88. The output is
  drawn fresh, so the EXIF/GPS blocks are not in it — there is nothing to strip.
- **MP4/MOV → metadata boxes overwritten in place** (`udta`/`meta` → a zeroed
  `free` box). Sizes and offsets are untouched, so the file plays identically.
- **GIF/WebM → as-is** (re-encoding an animation here loses more than it saves).
- A file this browser cannot decode is **still sent** — losing somebody's post is
  worse than a photo carrying its camera's notes — and the upload result says
  which of the three happened (`privacy: re-encoded | metadata-stripped | unchanged`),
  so nothing claims a win it did not get.

The MP4 test builds a real container by hand (`ftyp`, `moov{mvhd,udta}`, `mdat`)
and asserts the location box is gone, the file is the **same length**, and the
stream atoms survive.

---

## 2. Mined from Quilcast (MIT) — the ledger

Adopted, with this repo's own plumbing rather than a copy:

- **local phrase + Optimism registration + gasless signing key + name claim** as
  one flow, in one place, resumed from chain state rather than from a wizard's
  progress flag. Their `eth.ts` registers with `register(address)`; we sign the
  two-argument overload the bytecode and our design doc both carry.
- **recovering from facts, not memory**: their Setup loop re-derives the FID,
  price and balance every few seconds and picks up wherever it stopped. Ours does
  the same (and adds the read-back of the node's own state, because a node can
  accept a KEY_ADD it never merges).
- **multi-account store**: list + selected pointer, one entry per identity,
  reload-on-switch. Ours borrows the shape, not the storage (they are on
  `localStorage` synchronously; this client already has `localforage` + a
  namespaced keys-per-FID convention).
- **the re-encode and the MP4 box scrub**: adopted nearly verbatim in intent,
  restructured around an injected decode/encode so it is testable without a
  browser.
- **"Posting…" until the node indexes** and **per-account tab sync** — noted, not
  built (see §3).
- Their **CSP discipline** (`frame-src 'none'`, `form-action 'none'`) is worth
  copying if we ever ship a page that hosts miniapps; see §4.

Skipped, deliberately:

- **their direct-cast (DC) token flow** — we do not do DCs.
- **their farcaster.xyz relay** — a hosted API by design, which this client
  refuses (every read we can serve ourselves is served by the node).
- **their `@noble/*` + hand-rolled protobuf in the browser** — this repo already
  has `farcaster-node-client` with the same protocol work behind a tested seam;
  a second implementation would be a second source of truth for signing bytes.

Not yet done from this card's "adopt where cheap" list, with what it needs:

- **CDN image sizing** (request the size actually shown): needs a pass over the
  embed/avatar renderers to find where a fixed size is requested; no measurement
  has been taken, so no claim is made.
- **websocket live updates**: our provider seam is request/response; whether the
  node offers a stream was **not** measured in this run.
- **"Posting…" pending state**: the fork already has an optimistic-cast path
  (`useOptimisticUploadCloudflareImage`, optimistic casts around submitMessage).
  A second mechanism built without first measuring that one would be the wrong
  move — this is a check-then-decide item, not a rewrite.

---

## 3. Miniapp / frame support audit

**Verdict: the chrome exists; the data behind it does not, and rendering an embed
in the feed is UNVERIFIED in this client today.** Nothing here was clicked
through a signed-in browser in this run, so no "works" claim is made.

What was measured, in the committed route table
(`snapchain/nodeApi/hostedRoutes.ts` at `d00b7a7`) — the three endpoints the
miniapp surfaces call are each refused by name, with a reason:

| endpoint | verdict in the table | reason |
| --- | --- | --- |
| `GET /v1/favorite-frames` | refused | "favorite mini apps are hosted account state" |
| `GET /v1/search-miniapps` | refused | "a read node keeps no search index" |
| `GET /v2/frame-blocklist` | refused | "nothing is blocked locally, and a blocklist is local state" |

What exists in the client: a full miniapp stack from the fork — `MiniApp.tsx`,
`components/frames/*`, `components/iframes/IFrameLoader`, a frame context, the
`launchMiniApp` and `miniApps` routes, and miniapp settings — plus
`FrameEmbedNext`, which renders an **`ApiFrameEmbedNextExtended`**: a frame-embed
*descriptor* that the hosted API resolves. A read node has no equivalent
endpoint, so an in-feed miniapp card is `NEEDS-NODE`, not a wiring bug.

Two things follow, and they are the next card:

1. **The list surfaces** (favourites, search, blocklist) need either a node
   equivalent or an honest "your setup cannot do this" panel, in the same voice as
   the device-only landing;
2. **the in-feed embed** needs a probe against a real miniapp cast from a
   signed-in session to decide between (a) rendering the descriptor from the
   cast's own embed metadata client-side, or (b) refusing it the same explicit
   way. Until that probe happens, the parity card `t_08e02638` (still `todo`,
   Phase 1 doc only) owns the answer and its miniapp row must stay marked
   "re-measure".

Note for whoever builds the host side: Quilcast's own miniapp/frame policy is
`frame-src 'none'`. Launching somebody else's miniapp inside our shell is a
security decision (sandboxed iframe, its own origin, CSP) before it is a feature.

---

## 4. Why a branch, and what landing needs

`/Users/lc/Projects/fiddy` was occupied while this ran: card `t_aa93f0c5` (writes)
was live in it with ~20 uncommitted paths, and this repo's `pre-commit` +
`apps/farcaster-web/.lintstagedrc.json` **autostash every unstaged change on each
commit**. Committing there can stash a sibling worker's in-flight work, so this
card's own rule ("never race the file") means: an isolated worktree at `d00b7a7`,
own `pnpm install`, own workspace builds, and a branch.

Landing needs one human or neutral-arbiter step when the shared tree is quiet —
my diff and the writes card's are largely disjoint, but two files are touched by
both sides:

- `apps/farcaster-web/src/index.css` — one `@import` line (mine);
- `apps/farcaster-web/src/layouts/AuthedLeftSideBar.tsx` — one import and one
  `<AccountSwitcherEntry/>` line (mine) vs a live rewrite by `t_c9861884`.

## 5. Gates, measured in the worktree

- `npx tsc -p tsconfig.json --noEmit` → **0 errors** (after building the
  workspace packages in that worktree: `farcaster-node-client`,
  `farcaster-client-hooks`, `farcaster-client-data`, `farcaster-analytics`,
  `farcaster-cryptography`, `farcaster-cryptography-web`)
- lint-staged's own `eslint --fix` gate → **clean on every commit** to this
  branch (it caught two real errors on the first attempt and reverted the commit
  rather than letting them in)
- `npx vitest run src/snapchain/accounts src/snapchain/nodeApi/__tests__/photoPrivacy.test.ts`
  → **76/76 pass**, no network
- full app suite → 93 files pass, **6 files / 104 tests fail, and they fail
  identically at HEAD with this diff stashed**: `ExternalWalletSwap.test.tsx`
  fails 52/52 on `localStorage.clear()` — the Node-26-vs-pinned-20.19.5 finding of
  card `t_76707b08`, not a consequence of this work