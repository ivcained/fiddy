# People to follow (`/~/people`)

A ranked list of accounts the viewer might follow, each with one plain reason
and their latest casts, and Follow working straight from the list. The engine
is a 1:1 port of phunk-client's recommendation module.

## Attribution

- Source: [phunk-client](https://github.com/Ramitphi/phunk-client) by
  Ramitphi, **MIT license**. Only `src/phunk/recommend.py` was taken (148
  lines: `score`, `suggest`, and the channel helpers).
- Ported 1:1 into `apps/farcaster-web/src/snapchain/nodeApi/recommend.ts`
  (`scoreSuggestions`, `CHANNEL_POINTS = 2`). Same inputs, same outputs, same
  tie-breaks (score desc, mutuals desc, channel posts desc, older account
  first). No casting/UI code was taken — the surface around it is Fiddy's own.
- Parity is TESTED, not asserted: `fixtures/gen-score-parity.py` copies
  phunk's `score()` verbatim, runs it over hand cases (min_followed_by,
  channel-only, every tie-break) plus 60 seeded random graphs, and writes
  `src/snapchain/nodeApi/__tests__/fixtures/scoreParity.json`;
  `recommend.test.ts` asserts the TypeScript port answers with the same
  output for every case.

## How it works

Two signals, both read straight off the node — no model, no AI, no embedding
anywhere. The score is a plain count: 1 point per followed friend who follows
the candidate, plus 2 per shared channel.

| Read | Endpoint | Notes |
|---|---|---|
| Viewer's follow list | `/v1/linksByFid?reverse` | skip set + the newest-40 sample |
| Sampled accounts' follows | `/v1/linksByFid?reverse` | one page each, ~40 requests |
| Viewer's channels | `/v1/castsByFid?reverse` | top 3 parent URLs in the latest 100 casts |
| Channel authors | `/v1/castsByParent` | `{fid: posts}` per channel, newest 100 |

About 45 node requests per list, same order of cost as one feed page; the
answer is cached for a minute. A friend-of-friend needs `min_followed_by = 2`
mutuals unless they also share a channel. People already followed, and the
viewer, are never suggested.

The reason line is phunk's vocabulary: "Followed by @a, @b and 2 more you
follow · posts in #founders, a channel you read". Unresolved names read as
their fid, never an invented handle.

## Surface

- Route `peopleToFollow` → `/~/people` (`apps/farcaster-web/src/pages/peopleToFollow/PeopleToFollowPage.tsx`), tabbed from the feed header.
- Read: `GET /v2/people-suggestions` (client-owned route, answered by the node seam in `nodeBackedFetch.ts`; not a hosted-API endpoint).
- Follow: the `User` component's existing button — the same signed write path (`nodeWrites.ts`, POST /v1/submitMessage) as every other follow in the client. Nothing new on the write path.

## Honesty rule

The page carries the line "Ranked by counts from your node: who your follows
follow, and the channels you read. No AI involved." This must stay true: no
model or AI ranking may be added to this surface. If the ranking ever changes,
change the copy with it.

## Verification

- Offline suite: `apps/farcaster-web/src/snapchain/nodeApi/__tests__/recommend.test.ts` (71-case Python parity fixture + reason strings + channel names) and `peopleSuggestions.test.ts` (the read: sampling, skip set, per-account/per-channel failure isolation, adapter envelope, signed-out sentence).
- Browser probe: `apps/farcaster-web/scripts/verify-people-suggestions.mjs` — signs in through the stubbed SIWF relay (real SIWE, throwaway key), opens `/~/people` against the live public relay, and asserts the tab, the honesty line, the ranked list, one non-empty reason per suggestion, latest casts, a Follow button on every card, the node fan-out behind the read, and no uncaught page error. It NEVER presses Follow (no mainnet writes from a probe; the button is the app's stock `FollowButton`, the same live write path the right sidebar already uses). Recipe:

  ```
  cd apps/farcaster-web
  SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  VITE_SNAPCHAIN_DEBUG=true \
  PROBE_VITE_CACHE_DIR=/tmp/people-vite \
  npx vite --config scripts/probe.vite.config.mjs --port 5213 --strictPort
  PEOPLE_SERVER=https://localhost:5213 node scripts/verify-people-suggestions.mjs
  ```

  Measured 2026-10-28 against https://haatz.quilibrium.com signed in as fid 3: 10/10 — 20 suggestions with reasons ("Followed by @lsankar.eth, @corbin.eth, @mikedemarais.eth you follow"), 18 with casts, 20/20 Follow buttons, 42 linksByFid reads (41 `reverse=true`) behind the answer. First read ≈ 10–45 s against the public relay; the list then holds for a minute.
- Direct engine check against the relay (one-off, offline CI never does this): drive `readPeopleSuggestions({ fid: 3, limit: 10 })` from a scratch vitest file — fid 3 answered sampled=40, 10 ranked suggestions (top: @shawmakesmagic score 21) with resolved names, in ~10 s.

## Wiring note

The route lives in THREE places, and the third is not generated: `routes.ts` (the table + its `Component`), `lazy/pages.tsx` (the lazy export), and **`Router.tsx`'s explicit `<Route>` list** — a table entry alone falls through to the vanity profile route for the handle `people` and renders "username proof not found". Measured, not assumed.
