# Continue as @you: the middle state between "signed in" and "signed out"

Status: **built and verified locally**, released with this card. This file is the
design record: what the problem was, what the host's word is worth, what the
surface does, and what was measured rather than assumed.

Everything marked MEASURED was read off a real browser run against a real public
node on 2026-11-14, or off the build this card ships. Anything not measured says
so.

---

## 1. What was wrong

Fiddy already had both ends of the mini app. Inside a Farcaster client,
`src/lib/miniAppSession.ts` asks `sdk.isInMiniApp`, calls `ready()`, signs in with
`sdk.actions.signIn`, verifies the SIWF message locally, and reboots into a real
session. `MiniAppAutoSignIn` runs that once per tab. Signed out, `/feed` and
`/explore` are the anchored public window.

What was missing is the middle. When the host REFUSED, or a previous attempt in
this tab had already failed, the component rendered a small line at the top of the
page — "…Use the sign-in button instead" — and left the person on the signed-out
wall. That wall is the t_da9c23b2 finding: `/feed` and `/explore` show a stranger's
stale profile, so a person who had just been named by their own Farcaster client
was told the network looked dead, and was offered a QR code for the device they
were already holding.

The host had already told us who this is. Ignoring that was the bug.

## 2. What the host's word is worth

`src/lib/miniAppHost.ts` is the whole of what Fiddy believes about the host's
identity, and it is deliberately small. The FID arrives over a postMessage bridge
from a third party and is UNVERIFIED, so:

- It may drive **public reads** only: somebody's Following feed, a name on a card.
- It may never drive a session, a scope, a key, a write, or a signature.

`fidOfContext()` enforces the shape: a positive safe integer or nothing. `0`,
`-1`, `1.5`, `'3'`, `NaN` and `2 ** 53` are all rejected — a host that is
confused is not a host that said "fid 0".

The other three ideas, ported in shape from quilcast #660's `src/host.ts` and
reimplemented for this stack:

- `offered(host, signedIn)` never re-offers an account that is already signed in
  and finished. An account still mid-setup does not count as signed in, and an
  account book holding a DIFFERENT signed-in account does not suppress the offer:
  that is exactly the case the offer exists for.
- `hostIdentity()` keeps one in-flight promise, and a failed or unanswered lookup
  is dropped from the cache so the next page asks again. A found account is kept
  for the tab (`fiddy.miniapp.host`), because a reload is not a new person.
- `useHost()` is the component hook, and it starts from what the tab already knows
  so a front door that painted early still gains the card when the answer lands.

The host's context is not asked for twice: `miniAppSession.ts` already awaits
`sdk.context` before it signs, so the refused outcome now carries the account it
saw, and the wall can say who it is looking at.

## 3. What the surface does

**The refusal is a line, not a screen.** `MiniAppAutoSignIn` renders it at the
foot of the page, `pointer-events: none` on the container, one sentence, a
"Continue as @you" press and a dismiss. MEASURED: 64 px of a 900 px viewport,
nothing at the centre point of the page, no full-screen child.

**The front door changes order inside a host, and only inside one.** The host
account card is first ("Continue as @you", avatar, "That is who the Farcaster app
you opened this in says is here"), the host's own sign-in second ("Sign in to
post"), and a new account last, labelled as what it is: "Make a new, empty
account". The note says the part that matters — carrying on only reads, and a new
account is a separate, empty one with a name you pick, not theirs.

**Continue-as is a read, through the reader that already exists.**
`/feed?as=<fid>` reads ONE account's Following feed from public protocol data. It
is the same seam, the same hook and the same paging rule as the anchored public
window; only the feed key changes (`as:<fid>`, `publicFeedWindow.ts`), and it is
answered by `NodeBackedReads.readFollowingFeedFor` — which is
`followingFeedMessages` pointed at the host's fid with `withViewer: false`, so no
reaction context, no mutes and nothing to sign with. No key in the browser, no
signer minted, no `/api/fiddy/connect`.

The surface says what it is: heading "Following", the note "Carrying on as @you.
Reading only: nothing here posts, likes or follows until you say so.", and a
"Sign in to post" press that re-runs the host's own sign-in (`retryHostSignIn`
clears the one-shot mark so one deliberate press is enough), never the QR sheet.

A key that is not an account (`as:0`, `as:1.5`, `as:abc`) is not a feed: the page
reads the anchored window instead of inventing an empty one.

**The agent has nothing to sign.** The read-only entry is the first-run surface
that needs zero scopes; it may suggest, it stays behind the ask card, and
continue-as never widens the session's scopes because it has no session.

## 4. What is verified, and how

`apps/farcaster-web/scripts/verify-continue-as.mjs` drives two dev servers: one
whose `@farcaster/miniapp-sdk` is `scripts/probe-miniapp-sdk.mjs` (in a host,
names fid 3 / @dwr, refuses the sign-in), and one ordinary dev server. Nothing
mints a signer; the refused path never reaches `/api/fiddy/connect`.

MEASURED, 390 px and 1440 px, 78 checks, 0 failures:

- the front door offers the host account FIRST, sign-in second, a new account
  last, with a real avatar;
- the refusal is one plain sentence, cannot swallow a tap, covers 64 px of 900,
  and does not sit over the feed;
- no session was written (`auth-token` absent), no account was created on the
  device, and the host account is remembered for the tab;
- `/feed?as=3` renders as "Following" with the read-only note, one shape of feed
  and no ranked tabs;
- REAL content: the page asks the node for `linksByFid?fid=3` (dwr's follow
  graph), then `castsByFid` for the accounts it named — 60 account reads in this
  run — and the first cast is on the page and clickable, not under an overlay.
  MEASURED: the first card lands about 16 s after the surface paints against the
  public node from a laptop; that is the same follow-graph walk the signed-in home
  feed does, not a new cost;
- no write was submitted and no signer was asked for;
- outside a host: the shipped front door ("Look around first"), no host card, no
  refusal line, `/feed` is the anchored window with its own tabs, prompt and
  title.

`apps/farcaster-web/scripts/check-miniapp-sdk-is-lazy.mjs` is the bundle guard,
and `scripts/release-client.sh` now refuses to ship without it. Grepping the
minified output for the package name proves nothing (nothing carries it) and
grepping for `AddMiniApp.RejectedByUser` finds `@farcaster/miniapp-core`, which the
client legitimately imports — so the checker reads each chunk's source map
`sources`, which name the real files. MEASURED on this build:

- `@farcaster/miniapp-sdk/dist/*.js` appear in exactly ONE chunk (22,527 B) and
  that chunk is not in `index.html`'s upfront graph — on `main` (36105b56) and
  here, same size;
- the entry chunk is 3,489.5 kB against 3,488.4–3,489.9 kB on `main`, i.e. inside
  this build's own run-to-run spread (two builds of the same tree differ by ~1.3
  kB), so there is no measurable entry growth to report — which is the honest
  version of "the entry delta".

Unit tests: 69 in the five touched files (`fidOfContext` table, `offered` dedupe,
one in-flight lookup and its dropped failure, the session's refused outcome, the
front door order, the copy). The full web suite is 2,493 passing; the 119 failures
in 9 wallet/looks/binding files are pre-existing on 36105b56 under this machine's
Node 26 (`localStorage` is undefined), verified by running them with this card's
work stashed.

## 5. What a failure looks like

- The host card appears outside a host → `hostIdentity` is not asking
  `isInMiniApp` first.
- "Continue as @you" leads to an empty feed → the read walked the wrong graph, or
  `as:<fid>` was not carried into the feed key. Read
  `window.__nodeBackedRequests` for the feed-items path and look at the network
  for `linksByFid?fid=<the host's fid>`.
- The refusal covers the feed → the container lost `pointer-events-none` or grew
  a full-height child.
- A signer was minted → `writes.length` in the probe is not 0; the refusal path
  reached the connect route, which it must never do.
- The entry chunk grows by ~650 kB → the SDK was imported eagerly. The release
  gate refuses that build.

## 6. Still open

- **The key registry check.** `siwfSession.ts` documents an honest limit: nothing
  proves the signing address controls the FID, because that binding lives on
  Optimism. quilcast's `keyState()` is ~15 lines of raw `eth_call` with a keccak
  selector, which is exactly how that could be done client-side. Not this card.
- **The continue-as read's cost.** One follow graph plus a cast read per account.
  Fine on the laptop (16 s to first card against the public node); worth a
  measurement against the production provider chain before calling it cheap on a
  phone.
- **No "Continue as" for a hand-typed `/feed?as=<fid>`.** The read works, and the
  note says "that account's Following feed" rather than claiming to know them,
  but nothing offers it. Deliberate: a URL someone typed is not a host naming
  them.

## 7. Attribution

The middle state, the four ideas in `miniAppHost.ts` and the three-action order
are backmeupplz/quilcast #660 (MIT), quilcast.com. Read, reimplemented in this
stack, not vendored: no upstream file exists here verbatim. The SKIP in the same
upstream jump (#661, KeyRegistry on Optimism) is not ported; Fiddy reads Farcaster
through Neynar and the node adapter, so the Hypersnap indexing gap it fixes is not
a bug this client has.
