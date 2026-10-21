# Making an account, holding more than one, and what leaves the device

Status: **landed on `main`** as merge `824a20c` (branch head `a8496ad` merged
into `cfdd902`; released to fiddy.fun — §7). This file is the design record: what
was built, what was deliberately not built, how it reconciles with the control
plane's onboarding design, and what a miniapp embed actually hits in this client
today. §6 records what the first review round found and what changed because of
it; §7 records what the merge and the release measured.

Everything below marked MEASURED was read off a live network, a live contract, a
live node, a real browser run against the dev server, or the committed source at
`d00b7a7` on 2026-10-21. Anything not measured says so.

---

## 1. What shipped

### 1.1 Create a Farcaster account, on this device

`apps/farcaster-web/src/snapchain/accounts/` — a new module with its own tests
(76 of them across six files, no network), and the copy that drives it:

| file | what it is |
| --- | --- |
| `phrase.ts` | twelve words generated in the browser, validated with the **real BIP-39 checksum**, derived on `m/44'/60'/0'/0/0` (the path Warpcast/Quorum/Quilcast use, so the account opens anywhere), plus a fresh Ed25519 device key |
| `optimism.ts` | the registration: `price()` and `idOf()` read from Optimism, an EIP-1559 transaction signed **on this device** and sent over plain JSON-RPC, with fee/price ceilings the client refuses to cross |
| `username.ts` | name shape, availability from the name registry, and the claim signed with the registry's own EIP-712 `UserNameProof` struct |
| `createAccount.ts` | the two halves — `readFundingState` (read-only, polled while somebody sends ETH) and `finishAccountSetup` (signing key **installed on the node and saved on this device**, @name, profile — each one confirmed by reading the node back) |
| `nodeAccountOps.ts` | the node side, using the client that already exists (`issueAppKey`, `buildUserDataAddMessage`) — no second signing path; the KEY_ADD is read back out of `/v1/signersByFid` before the step is called done |
| `localAccounts.ts` | the accounts this browser holds (see 1.2) |
| `session.ts` | signs the client in as one of them, using the same device-only session the SIWF sign-in produces |

UI: `components/fiddy/accounts/CreateAccountSheet.tsx` (pick a name → write the
words down → send the fee → progress → you're in) and
`components/fiddy/accounts/AccountSwitcher.tsx`. Both reuse the onboarding's own
`FiddySheet`, so a person cannot be told two different things about what Fiddy
is. Entry points: the sign-in modal (every existing mount of it) and the setup
flow's own front door.

#### The key is installed on the node, and kept on the device

A gasless KEY_ADD makes the account *accept* this device's key; it does not make
this device *hold* it. The write path signs with the key it reads from
`~/snapchain/appKeyStorage` for the session's FID (a miss answers `501
NO_APP_KEY`), so an installed-but-not-saved key leaves an account that can be read
and never written. The flow now does both, in this order:

1. `installSigner` submits the KEY_ADD, reads the key back out of
   `/v1/signersByFid`, and resolves with the nonce the **next** message for this
   FID must exceed (`max(nonce used, nonce the node reports) + 1`, so a stale read
   cannot hand back a spent nonce);
2. `finishAccountSetup` writes the key and that nonce to the device's own store
   (`AccountKeyStore`, whose real implementation is `appKeyStorage`) **before** it
   reports the `signer` step as done. If the device cannot save them, the step
   fails with a sentence that says so — an account that cannot post is never
   described as ready.

That device-side copy is what makes the done screen's promise ("this device can
post for you") and the switcher's per-account line ("this device can post" /
"no posting key on this device yet") true rather than hopeful: both read the same
store the write path reads. MEASURED, in the mocked-node suite: the key lands
under `snapchain_app_key_<fid>` and the nonce under `snapchain_app_nonce_<fid>`,
the nonce stored is the one the node reported after the KEY_ADD, and a store that
refuses the write fails the step rather than finishing.

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

"Forget on this device" now removes **everything** this device holds for that
account: the entry, the recovery phrase, and the per-FID posting key and nonce
(`clearAppKey`). It deliberately leaves the key alone while another entry in the
list still carries the same FID — one FID is one key, and forgetting a duplicate
entry must not disarm the account still held. An account with no FID yet has no
key to clear. What this cannot reach is the key record on the node: that stays
valid there until it is revoked, and what "forget" removes is this browser's
ability to use it. The confirm line says so in the client's own words ("The words
you saved are the only copy").

#### The switching probe (MEASURED in a real browser)

`apps/farcaster-web/scripts/verify-account-switching.mjs` — the probe this card
named and the first round found missing. It drives the real client against the
dev server and a live read node:

    HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
      VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
      npx vite --port 5177 --strictPort
    ACCOUNT_SWITCH_SERVER=https://localhost:5177 node scripts/verify-account-switching.mjs

Only the SIWF relay is stubbed, with a REAL SIWE message signed by a throwaway
key, naming fid 3 (`dwr`) — a real account, so the shell has a real feed. The two
accounts are put on the device through the app's **own** modules
(`localAccounts.saveLocalAccount`, `appKeyStorage.saveAppKey/saveAppNonce`)
imported over the dev server, not by hand-writing IndexedDB keys: the question is
what the app reads back, not whether a script can spell a localforage key. The
switch itself is done the way a person does it — the rail's entry, the sheet, the
"Sign in as …" button. Every non-GET request to anything but the dev server is
aborted and counted, so the probe cannot post anything, and the run asserts that
count is zero.

**RESULT, MEASURED 2026-10-21 on this branch: 18/18 checks, exit 0.** What it
records per account, before and after the switch:

| | account A (`@dwr`, fid 3) | after switching to B | after switching back |
| --- | --- | --- | --- |
| session FID (from the client's own auth token) | 3 | **4242** | **3** |
| rail entry | `@dwr` | **`@probe-two`** | **`@dwr`** |
| stored selection | A's custody address | **B's** | **A's** |
| per-account label | "this device can post" | both rows say it; exactly **one** row is "current", and it is the right one | same |
| key for each FID | both stored (`loadAppKey(3)`, `loadAppKey(4242)`) | both still stored | both still stored |
| a write attempt, as this account | recorded, not asserted (below) | recorded | — |

The write attempt is the one thing the probe measures rather than asserts, and it
says why in its own report. **Re-measured after the merge (§7): the row did not
change the way this section expected it to.** Pressing the client's write entry
point ("Cast") still opened no composer and issued **no write request** in that
run, on a merged tree that does carry node-backed writes — so the sentence the
probe prints ("this build has no node-backed write path") is now wrong about the
build, and right only about what that run observed. The likeliest reading, and it
is a reading rather than a measurement: the composer is opened lazily and the
probe allows 6 s after the click, which was not enough on a machine at load ~50
(the separate `verify-cast-submit.mjs` run on the same merged tree *did* open the
composer and take typed text — §7). What is measured, and what matters here, is
that the never-a-write-left-the-machine safety property holds in every run: 0
aborted writes, both times, in both sessions.

The phrase is still stored where §1.1 says it is (this device's localforage,
unencrypted), which is the trade the design made — stated here and at the
invariant in `appKeyStorage.ts`.

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
  the same. On the node side, what is read back is: the FID is looked up in the
  **IdRegistry** on chain (never taken from the node's word), the profile fields
  are read out of `/v1/userDataByFid` after they are written, and the KEY_ADD is
  confirmed from `/v1/signersByFid` — because a node can accept a message it never
  merges, and because the next message's nonce has to come from the node rather
  than from us.
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
  → **7 files, 86 tests, 86 pass**, no network. The accounts folder alone is 76
  across six files (username 12, localAccounts 16, optimism 11, createAccount 16,
  phrase 11, nodeAccountOps 10); `photoPrivacy` adds 10. (The earlier claim of
  "76/76" from this command did not reproduce — at that revision it answered 70.
  86 is what this revision measures, and §6 item 4 records the correction.)
- `node scripts/verify-account-switching.mjs` against a dev server on a live read
  node → **18/18 checks, exit 0** (§1.2). Needs a running dev server and
  network; it is not part of the unit suite.
- full app suite → 93 files pass, **6 files / 104 tests fail, and they fail
  identically at HEAD with this diff stashed**: `ExternalWalletSwap.test.tsx`
  fails 52/52 on `localStorage.clear()` — the Node-26-vs-pinned-20.19.5 finding of
  card `t_76707b08`, not a consequence of this work

---

## 6. What the first review round changed

Round 1 (artifact lens) found one functional break in the headline feature, one
missing probe, three smaller accuracy problems, and one open design item. All of
them are addressed here except the design item, which is filed rather than
decided in a fork:

1. **the key was installed and thrown away** — fixed: `installSigner` reads the
   key back from the node and returns the next nonce; `finishAccountSetup` saves
   both to `appKeyStorage` before it calls the step done, and fails the step (with
   a sentence, not a stack trace) if the device cannot save them. New tests assert
   the stored key/nonce, that the nonce is the one the node reported *after* the
   KEY_ADD, and that a store which refuses makes the flow refuse. §1.1.
2. **no account-switching probe** — fixed: `verify-account-switching.mjs`, 18/18
   on this branch. §1.2.
3. **"forget" left the posting key on the device** — fixed: `removeLocalAccount`
   clears the per-FID key and nonce, except when another entry still holds that
   FID. Three tests. §1.2.
4. **"76/76" did not reproduce** — fixed: the command returns 70, and the doc says
   70 with the per-file breakdown. §5.
5. **the signer step did not read the node back, though the doc said it did** —
   fixed in the code rather than in the prose: `installSigner` now re-reads
   `/v1/signersByFid` for its own key after `issueAppKey` and throws if the node is
   not showing it. `nodeAccountOps.test.ts` asserts the read happens after the
   submit.

Still open, named here rather than quietly absorbed: the **recovery address**
(§1.1 — this path sets `recovery = custody`, the control plane wants a dedicated
one). It is control-plane-shaped and belongs there, and a card is filed for it
when this branch lands (see the completion note on `t_bb61fcf8`).
---

## 7. When it landed: the merge, the gates, the release

### 7.1 The merge, and the one file the landing card did not name

Branch head `a8496ad` went into `origin/main` at `cfdd902` as merge **`824a20c`**
(a real merge commit, not a fast-forward: the branch was 21+ commits behind, with
the writes, the provider layer, the feed-read fix, the Together surface and the
two-step onboarding all landed while it waited).

One file conflicted, and it was **not** one of the two the landing card warned
about:

| file | what happened |
| --- | --- |
| `src/pages/fiddyOnboarding/FiddyOnboardingPage.tsx` | **conflicted.** `t_9a4759b7` (on main as `56c97b2`) rewrote this flow from four numbered steps into two, deleting the `apps` step and the `brain` screen this branch had added its "New to Farcaster? Make an account" entry and its note lines to. Resolution: main's two-step structure kept; this branch's entry button and note kept on the screens that survive (the front door and the `ready` step); the now-dead `AppsSheet, CHANNEL_ROWS` import dropped (nothing else in the file uses them, and lint would refuse it) |
| `src/index.css` | auto-merged: this branch's one `@import './styles/fiddy-accounts.css'`, on main's tail |
| `src/layouts/AuthedLeftSideBar.tsx` | auto-merged: `t_c9861884`'s rewrite is intact and this branch adds one import and one `<AccountSwitcherEntry className="fiddy-account-entry" />` — verified by diffing the merge against main: `+8 −0`, no line of main's version lost |
| `src/components/modals/LoginModal.tsx`, `src/layouts/MobileHeader.tsx` | auto-merged, both sides kept |

The conflict was textual, and the resolution is the one both cards' intent implies
(main's flow, this branch's door), so it was resolved directly rather than with an
arbiter.

### 7.2 The gates, on the merged tree, on the pinned node

Measured with **node 20.19.5** — the version `.node-version` pins and CI installs,
and the one this Mac did not have until this run — after `pnpm build:packages`
(a *stale workspace `dist`* is what makes `tsc` fail here with
`isMissingOnNode`/`linkById`: the app reads the packages' built `.d.ts`, so the
packages must be built from the same tree before typecheck means anything).

| gate | result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | 0 errors |
| `eslint --quiet --max-warnings 1080` | clean |
| `vitest run` | 116 files, **1244 passed**, 2 skipped, 0 failed — at `--maxWorkers=4` |
| `vite build` | exit 0 |
| CI (`39641016670` on `824a20c`) | typecheck 1m22s, test 1m59s, lint 1m42s — **all green** |

The `--maxWorkers=4` is the one caveat, and it is stated rather than papered over:
at vitest's default parallelism this box (6-16 concurrent cards, load 50-110, swap
exhausted) fails one to four **unrelated** UI files per run on their own 5-second
timeouts, a different set each time, and the same files pass in isolation. The
clean-runner CI run is what settles it: the full suite is green on the merge.

### 7.3 The branch's own probes, re-run after the merge

- `verify-account-switching.mjs` against a dev server serving the merged tree:
  **18/18, exit 0** — the §1.2 table reproduces (session `3 → 4242 → 3`, labels
  and stored selection follow, both keys stay on the device). The write-attempt row
  did **not** change the way §1.2 predicted; what that row says now, and why, is in
  §1.2 itself.
- `verify-cast-submit.mjs` on the same merged tree: **11/12**. The composer opens
  and takes typed text, `POST /v2/casts` is classified `write` and reaches the
  node writer, and a session with no posting key on the device is refused `501` in
  that path's own words — which the probe then finds **rendered to the person**
  ("The cast didn't post. This device has no key it may sign for you with yet…").
  The one red is the probe's own stale expectation from before the writes landed
  (it asserts the old adapter sentence); the merge touches no write-path file, so
  that expectation is stale on `main` too, and this card did not rewrite a probe to
  make a number green.

### 7.4 The release, and what the live client shows

