# Client parity: the fork's surfaces vs where Fiddy is (Phase 1 audit)

Status: **first pass, 2026-10-20**, measured against commit `041c593` (branch
`main`). This document exists so the client work has one honest map: what the
fork can do, what our shell can do today, and what each gap costs.

Read the "How this was measured" section before trusting any verdict in the
table — the shared working tree had three other cards in flight while this was
written, and one window of measurements is contaminated (it is marked).

## How this was measured

Two lenses, both signed in with a real Sign In With Farcaster session: a
throwaway key signs a real SIWE message (`viem/accounts` +
`viem/siwe`), only the SIWF relay is stubbed, so the app's own verifier accepts
the sign-in for real (`@fiddy`, `fid 4242`).

| Lens | Backend | What it proves |
| --- | --- | --- |
| **real** | `https://farcaster.xyz/~api` (what a third-party session actually has) | what a Fiddy user can reach today, and the exact refusal they get |
| **mock** | the fork's own dev backend on `localhost:8080` (`localStorage['farcasterApi.local']='true'`) | that the client's surfaces and code paths still exist and run, independent of the hosted API's gate |

Probe (Playwright, headless Chrome, `ignoreHTTPSErrors` on the context):
sign in → visit each surface → record landed path, rendered copy, every request
the surface made to the data layer and its status, and whether an error
boundary came up. Screenshots and raw JSON for both lenses are attached to
kanban card `t_08e02638`.

**Measurement window A** (~16:52 IST, `041c593`, tree dirty only with another
card's `snapchain/nodeEnv.ts` + its test) — this is the window the table's
verdicts come from.

**Measurement window B** (~17:05 IST, same commit, tree now also dirty with
another card's `contexts/WebFarcasterApiClientProvider.tsx`) — in this window
the client itself throws: the home feed and `/~/compose` both render the shell's
error boundary, console cause
`TypeError: Cannot read properties of undefined (reading 'length') at TrendingTopics (src/components/rightSidebar/TrendingTopics.tsx:149)`.
Window B is **not** a property of the commit; it is a neighbour's in-flight edit
in the shared tree. Any verdict measured in window B is void and has to be
re-measured on a quiet tree.

## The two things the audit found, before the table

1. **A real third-party session cannot reach a single authed surface.** With a
   genuine device-only SIWF session, all 13 surfaces probed (`/`,
   `/~/following`, `/~/apps/trending`, `/~/profiles/4242`, `/~/notifications`,
   `/~/channel/cast`, `/~/inbox`, `/miniapps`, `/~/settings`, `/~/bookmarks`,
   `/~/channels`, `/~/agent`, `/~/compose`) render the honest device-only
   landing ("Farcaster signed this device in…") and make **zero** data calls.
   The client is not broken — it is gated, correctly, by the absence of the
   hosted API's server session. That gate is the whole gap.
2. **The fork's surfaces are intact.** With the fork's own dev backend the full
   Fiddy shell renders on every one of those routes, issuing 14–22 requests
   each, all `200`. So parity work is *rewiring the data layer*, not rebuilding
   UI.

## Surfaces, where their data comes from, and status

"Status" is at `041c593`, measured in window A: **gated** = third-party session
sees the device-only landing; **renders (mock)** = the surface's own code path
runs against a working backend.

| Surface | Route | Where its data comes from | Status | What parity needs |
| --- | --- | --- | --- | --- |
| Home feed | `/` | `farcaster-client-hooks` → hosted `/v2/feed-items`, `/v2/feed` | gated; renders (mock, 20 calls) | node-backed feed (see `docs/CLIENT-NODE-GAP.md`) |
| Following feed | `/~/following` | hosted `/v2/feed` + `/v2/following` | gated; renders (mock) | same node feed, follow-graph filtered |
| Trending / discover | `/~/apps/trending` | hosted feed + `rightSidebar/TrendingTopics.tsx` | gated; renders (mock) — window B threw here | re-measure; trending has no node endpoint today |
| Cast detail + threads | `/~/conversations/:castHash` | hosted `/v2/casts` (conversation) | gated | node `castsByFid`/cast-by-hash reads already in `farcaster-node-client` |
| Composer (text) | `/~/compose` | `mutation/useCreateCast.ts` → `POST /v2/casts` (`FarcasterApiClient.ts:…createCast`) | gated in window A; **error boundary in window B** | route on `submitMessage` (`packages/farcaster-node-client`) — the app-key path that already exists |
| Composer — image | composer picker | `MediaComposerPicker` → `useFetchImageUploadUrl` → `POST /v1/generate-image-upload-url` (`FarcasterApiClient.ts:5019`), then upload to the returned host | **unusable** — endpoint is 401 for a third party (measured, see media section) | a media seam of our own; see "Media upload" |
| Composer — video | composer picker | `useCastComposerEmbeds.ts:1253` → `POST /v1/upload-video-with-tus` (`FarcasterApiClient.ts:11719`) | **unusable** — same hosted gate | same media seam |
| Quote / recast / reply | cast actions, `QuoteCastComposer` | hosted `/v2/casts` with embed | gated | node writes (`submitMessage`) |
| Reactions (like / recast) | cast actions | `useCreateCastLike.ts` → hosted `/v2/cast-reactions`, `/v2/cast-recasters` | gated | node reactions (already in the node client) |
| Follows | profile / lists | `useCreateFollow.ts` → hosted `/v2/follows`, `/v2/followers` | gated | node follows (already in the node client) |
| Profiles — view | `/~/profiles/:fid` | hosted `/v2/user` | gated; renders (mock, 19 calls) | node `userData` reads |
| Profiles — edit | settings/profile | hosted user update | gated | node `userData` writes (`submitMessage`) |
| Notifications | `/~/notifications` | hosted `/v2/notification-group*` | gated | no node endpoint yet → derive from mentions/reactions/follows (NEEDS-NODE) |
| Channels — browse | `/~/channels` | hosted `/v2/all-channels`, `/v2/highlighted-channels` | gated; renders (mock) | node channel reads; browse needs a channel list source |
| Channels — page / post into | `/~/channel/:channelKey` | hosted `/v2/channel`, `/v2/channel-followers`, `/v2/casts` | gated; renders (mock, 22 calls) | node reads + `submitMessage` with channel parent |
| Channels — join / create | channel settings | `useCreateChannel.ts`, join-by-code hooks | gated | `farcaster-node-client` as-is |
| Search | `/~/search*`, top bar | hosted `searchUsers`, `searchChannels`, `searchMiniApps` | gated | NEEDS-NODE (no search endpoint on the node) |
| Direct messages | `/~/inbox`, `/~/inbox/:conversationId` | hosted direct-cast endpoints (plaintext DC hooks) | gated; renders (mock, 16 calls) | no node endpoint exists for DMs → hide with an honest note rather than fake it |
| Mini apps — browse | `/miniapps` | hosted app catalog (`/v2/…mini-app…`) | gated; renders (mock, 21 calls) | NEEDS-NODE for the catalog; launching is client-side |
| Mini app / frame rendering in feed | cast embeds, `components/frames/`, `components/iframes/` | embed URL in the cast itself | renders (mock) — **unverified with a live frame** | verify once the feed is node-backed |
| Wallet surfaces | `/~/settings/preferred-wallet`, mint, pay-user | wallet-connect + hosted wallet endpoints | gated; `Reown Config` fetch failed `403` in console (project id unset) | operator key + a decision on whether Fiddy ships a wallet at all |
| Settings | `/~/settings`, `/settings/developer-tools`, `/settings/node` | local + hosted prefs | gated (hosted parts) | mostly local already; `/settings/node` is ours |
| Agent extras (ours) | `/~/agent`, `/~/agent/brains`, `/~/agent/apps` | local shell state | **works signed-out and device-only** (verified by `t_891e6995`) | the two sheets are the licensed exception on the device-only landing |

Also logged but not a Fiddy surface: `ph.neynar.com/array/REPLACE_ME/config.js`
404 (an unset third-party analytics placeholder) and a `ws://localhost:8080/stream`
handshake failure against the mock backend — both cosmetic noise from the fork,
both worth removing before a judge sees the console.

## Media upload: the fork's path is unusable, and the choice that follows

Measured, not assumed:

```
$ curl -sS -o /dev/null -w '%{http_code}' -X POST \
    https://farcaster.xyz/~api/v1/generate-image-upload-url \
    -H 'content-type: application/json' -d '{}'
401
{"errors":[{"message":"Authentication required"}]}
```

So image upload dies at the first hop (`/v1/generate-image-upload-url` needs
Warpcast's own session) and video upload dies at `/v1/upload-video-with-tus`
for the same reason. The upload URL the picker receives is also handed out by
that same gated endpoint, so there is nothing to fall back to client-side.

**Decision (recorded here as the card requires):**

* Chosen: **direct-to-IPFS through an operator-configured pinning endpoint**,
  called by a small `uploadMedia()` seam on our side. The browser sends the file
  to our endpoint; the endpoint pins it (or otherwise stores it) and returns a
  public `https` URL; the cast embed references that URL. This keeps any pinning
  credential **server-side** — the alternative, pinning straight from the
  browser, would ship a write-scoped key to every visitor.
* Rejected: doing nothing and leaving the buttons live (that is a fake success
  path: the user picks an image, watches it upload, and the cast silently can't
  carry it).
* Rejected: hosting media *on the node*. A Snapchain node has no media endpoint —
  `packages/farcaster-node-client` writes `submitMessage` and reads `/v1/*`, and
  the cast embed is just a URL. Media must be pinned somewhere public.

**What this needs before it can be implemented** (this is why it is not done in
this pass): either a pinning endpoint + credential from the operator, or a
go-ahead to add a small upload service on the VPS (that is a `services/` change,
explicitly out of scope for this card → it wants its own card). Until then the
honest state for both media buttons is a plain "media isn't ready yet" — not a
hosted-API error toast.

## Fix order for Phase 2 (posting loop first)

1. Text posting: composer → `packages/farcaster-node-client.submitMessage`
   (gasless app-key path already built; no new signing path). Include the
   channel picker in the same write (`parent_url`), since "channels work" is a
   must-have and it is the same message.
2. Feed reads behind the adapter so a posted cast is visible again after reload
   (a write you cannot see is not a working loop).
3. Frame / mini-app embed rendering + launch in-feed, verified against a live
   frame URL, not just the mock.
4. Media: the seam above, once the storage decision has an owner.
5. Notifications and DMs: honest states (derive from the node where possible,
   hide the rest with a note) — do not fake either.

Overlap warning: another live card (`t_c9861884`) is rewiring the same surfaces
(reads, notifications, posting) through the same node client. Whoever lands
second rebases on the first; the parity table above is the shared map.

## Measurement hygiene (why some cells say "re-measure")

`/Users/lc/Projects/fiddy` is one working tree shared by several concurrent
cards. During this audit HEAD moved (`ad2193d` → `041c593`), a neighbour's
untracked modules appeared under `src/snapchain/nodeApi/`, and a neighbour's
in-flight edit to `WebFarcasterApiClientProvider.tsx` broke the running client
mid-audit — which is exactly the contamination recorded above.

Verdicts are only as good as a quiet tree. Before trusting a live verdict:
confirm `git status` shows nothing in flight, record `git rev-parse HEAD`, and
re-run the probe.