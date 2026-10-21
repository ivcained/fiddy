# A mini app in the feed: what actually renders, and the policy before anyone frames one

Follow-up to `t_bb61fcf8` (which audited the miniapp stack and deliberately claimed
nothing, having run no signed-in probe). This is the probe that card asked for,
plus the decision it deferred, plus the security policy it said had to be written
down **before** an iframe is wired.

Everything below is one of three things, and each line says which: **measured**
(a command ran and this is its output), **read** (this is what the committed
source says), or **not verified** (this is what follows from the other two, and
it has not been watched happen).

## In plain words

A cast in your feed that links to a mini app now shows the app's own picture and
a button with the app's name on it. It does **not** show the words the app's page
asked for ("Beep @topp-airdrop"), and nothing from that page runs inside Fiddy: no
iframe is created, at either width. The picture and the button come from an index
that has already read the app's page, because a web page is not allowed to read
another site's page directly — the browser refuses, and the refusal is in the
evidence below. Nothing is broken about mini apps in the feed; they render, from
the second of the two sources.

---

## 0. Provenance: which head served the run

A measurement without its head is not a measurement, so this comes first. Every
number in §2 is from **one complete run** of
`apps/farcaster-web/scripts/verify-miniapp-in-feed.mjs`, whose report is attached
to this card verbatim as `miniapp-in-feed.txt`.

| | |
| --- | --- |
| the run | 2026-10-22, 02:11–02:26 IST (first screenshot to written report), both viewports — `── checks ──` reached twice and the report written: `5/9 checks passed`, and the four failures are §2's two negative results at each width, not a crash |
| the tree the probe itself lives in | `b3bdd7c` (this branch: `55a4ddd` + the probe's files) |
| the tree the **dev server served** | the same worktree, `b3bdd7c`, at `https://localhost:5183` — the probe could not serve it, so the head is env-stated (`MINIAPP_SERVED_HEAD`) and echoed in the report's first block |
| `main` at the time | `63bc576`. `git diff --stat main..b3bdd7c -- apps/farcaster-web/src/snapchain/` is **empty**, so every miniapp read and write path measured here is byte-identical between the head served and `main` |
| read node | `https://haatz.quilibrium.com` (stated in the report) |
| signed in as | fid 259576 (`ogmaro`), a real SIWE sign-in — only `relay.farcaster.xyz` is stubbed, which is the same stub the sibling probes use |
| budgets the run used | sign-in 480 s · feed 480 s · surface 240 s · warm-up 240 s · screenshot 30 s then 240 s (all stated in the report's first block; MEASURED: this machine ran at load average 74–114 on 10 cores during the run, which is why the budgets are large and why the probe logs them) |

**One difference between the committed probe and the probe that ran**, stated
because the probe's own text is part of the evidence: the run printed one check
label as `the card carries an image from the app's own host (undefined)` — the
interpolation read `FIXTURE.host`, a field the fixture object does not carry.
That label is fixed in the committed probe and **nothing else changed**: same
predicates, same thresholds, same assertions, same report. **It cannot be
confirmed with `git diff`**, and an earlier revision of this doc said it could: the
working copy the probe ran from was never committed and is gone, and the only diff
on offer for that file (`b3bdd7c..a9f7555`) is `9cc0ed1`'s 240-line probe rewrite,
which reads as the opposite of "one string". It was confirmed the only way it can
be — by **re-running the committed probe** on the same head and the same server and
diffing its output against the attached report (review round 2; its report is in
this card's comment thread). The re-run prints `(beep.works)` where the attached
report prints `(undefined)`, and every predicate, threshold, count and check
outcome is identical: `5/9 checks passed`, the same four negative results, the
arrival slice number for number. That re-run is the reproducible check. What the
run that produced *this* report did with the label is **not recoverable from git**,
and the doc says so rather than implying a `git diff` that cannot be run.

The probe's request table now has three slices — **arrival** (the client arriving:
bundler plus the feed's warm-up render), **feed** (the measured pass) and
**detail** — because in the first complete run of this probe, before that marker
existed, the requests that BUILD the fixture's card fell between the slices and
the table could not say where the card came from. §2 leans on the arrival slice,
and it is the reason §2 can answer "from which source" at all.

---

## 1. The fixture, found by reading, not by guessing

The card asked for a cast found **through the node** whose embed URL answers
`fc:miniapp`, and one recent enough to be inside the window a feed renders.
Finding one is not a search a read node can do — a node keeps no search index,
which is one of the three endpoints this repo refuses in writing
(`snapchain/nodeApi/hostedRoutes.ts`). So it was read out:

1. Neynar's frame catalog listed 50 miniapp hosts (`GET /v2/farcaster/frame/catalog`).
2. Each host's author FID was read **on the node** (`GET /v1/castsByFid`), and
   every embed URL those authors had posted was fetched and grepped for
   `fc:miniapp`. That gave 19 frame/miniapp casts — all **326–536 days old**. The
   catalog's authors are not the people posting miniapps this week.
3. So the search was inverted — recent casts embedding a known miniapp URL, each
   confirmed back **on the node** with `GET /v1/castById` before use.

The fixture, measured on `https://haatz.quilibrium.com`:

| | |
| --- | --- |
| cast | `0x8b3019a85bdbd946bab5f1105f62f7b926746ace`, fid 1062481, **top-level** (a reply never reaches a home feed), 6 hours old at the time of the run |
| text | `ask me anything for $0.05` |
| embed | `https://beep.works/send/cmi8mtgn500afiolnh4qelc53` |
| why this account | a home feed is the newest casts of **your follows**, so the probe signs in as fid 259576 (`ogmaro`, 151 follows), who follows the cast's author — `/v1/linksByTargetFid?target_fid=1062481` returned them. fid 3 (`dwr`) does not follow that author at all. |
| what the page declares (**measured**, curl, 2026-10-22) | `<meta name="fc:miniapp" content='{"version":"1","imageUrl":"https://beep.works/send/cmi8mtgn500afiolnh4qelc53/opengraph-image","button":{"title":"Beep @topp-airdrop","action":{"type":"launch_miniapp", …}}}'>` — and separately `og:title` = `Send a Beep to Wish me luck 🧬 (@topp-airdrop)`, `og:image` = the same `…/opengraph-image` |

A second, **aged** fixture is reported alongside and never asserted: fid 17
(`sds`), `0xac298f3555e453c7b7e0a9338bb9ba065339418b`, embedding
`https://thefirm.biz/employees/17`, whose page declares `button.title` =
`Inspect e-ID` and `imageUrl` = `https://thefirm.biz/api/employees/17/og-image`.
It is a genuine `fc:miniapp` cast in `dwr`'s follow graph, 326 days old, so it is
inside the follow graph but past the end of the newest-first feed the client
renders. Its value here is that it is a second real `fc:miniapp` cast from a
different host, so the cast-page reading is not a one-off property of one site.

Probes: `apps/farcaster-web/scripts/verify-miniapp-in-feed.mjs` (the evidence
run), `scripts/probe-miniapp-embed-cors.mjs` (the browser read of the two real
miniapp pages) and `scripts/shot-miniapp-in-feed.mjs` (the picture, §2.4).

```
SNAPCHAIN_HTTP_URL=https://<node> npx vite --port 5183
MINIAPP_SERVER=https://localhost:5183 \
MINIAPP_SERVED_HEAD=<sha of the tree the server serves> \
MINIAPP_NODE=https://<node> \
  node scripts/verify-miniapp-in-feed.mjs

# the picture (§2.4) — same server, same head, scrolls the fixture into view
MINIAPP_SERVER=https://localhost:5183 \
MINIAPP_SHOT_DIR=<dir> \
  node scripts/shot-miniapp-in-feed.mjs
```

---

## 2. What actually rendered

**Measured**, one complete run, both viewports, signed in, on the heads named in
§0. The cast, the card, the reads behind it and the refusals, in the client's own
words:

| surface | what the client did |
| --- | --- |
| `/` — the ranked feed's refusal | measured, in the client's own console: `HandledFetchError: getExploreFeed 501 - explore is a ranking, and ranking is an indexer's job`; the desktop column carries the same sentence as its own text, verbatim. The ranked feed is not served on a read node. |
| `/` — the column itself | **the fixture cast is in the column at both viewports**: its text, and its hash `0x8b3019a85b…` in the feed's cast list (`fixtureTextOnScreen=true` at `mobile-390` and `desktop-1440`). Measured with `followingTabClicked=false` — the probe's tab locator (`a[title="Following"]`) no longer matches this build, and that turned out not to matter: the column carries the follows' casts without it. (The previous revision of this doc said the column "sits on a spinner until the reader presses **Following**". That is not what this run shows, and the row is corrected.) |
| the fixture cast's card in the feed | **a mini-app card DOES render**, at both viewports, identically: one image, `https://beep.works/images/beeper-og-0326.png`, and one control named **`Open Beeper`**. No iframe (`iframes=0`). |
| — but not the page's own words | the card does **not** carry the page's declared art (`…/send/cmi8…/opengraph-image`) nor the page's declared button (`Beep @topp-airdrop`). Both checks fail at both viewports, with the offending sources printed next to them. |
| the cast's own page, fresh fixture | the card there carries the page's **own** descriptor: image `https://beep.works/send/cmi8mtgn500afiolnh4qelc53/opengraph-image` and button `Beep @topp-airdrop` — both exactly the page's `fc:miniapp` values (§1). No iframe. |
| the aged fixture's page | the card carries that page's declared image (`thefirm.biz/api/employees/17/og-image`), and a control reading **`Join The Firm`** — which is neither the page's declared button (`Inspect e-ID`) nor its `og:title` (`@sds is Performing Business at The Firm`). Where that word comes from is **not verified** (§2.3). |
| the embed URL itself | the browser **tried to read the page and was refused**: `GET https://beep.works/send/cmi8… → failed` — 8 times in the arrival window and 4 more in the measured feed window, with the client's own console line: `Access to fetch at 'https://beep.works/…' from origin 'https://localhost:5183' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` The same refusal appears in the same run for `warpletbox.xyz/embed`, a railway-hosted podium embed and a Neynar-hosted miniapp. |

### 2.1 Where the in-feed card's data actually came from — measured, from the arrival slice

This is the whole answer to "should we render it, or refuse it by name", and it is
two requests, both in the run's own table:

```
8× arrival · GET /send/cmi8mtgn500afiolnh4qelc53 @ beep.works → failed   ← the page read, refused
42× arrival · GET /v2/farcaster/frame/search/ @ api.neynar.com → 200      ← the index, answering
             (8 more of the same route answered 400 and were not used)
```

and one request that explains the second one, fetched separately
(**measured**, 2026-10-22):

```
GET https://api.neynar.com/v2/farcaster/frame/search/?q=beep&limit=20
  → an app named "Beeper", home_url https://beep.works,
    image_url https://beep.works/images/beeper-og-0326.png
```

That is the card on screen, field for field: the image is the index's
`image_url` for `beep.works`, and the control is the client's own
`Open ${app.name}` — which is why it reads **`Open Beeper`** and not the
`[ ! ] BEEP` button the app's manifest carries, and not the page's
`Beep @topp-airdrop` either.

**Why the cast page differs** (read, from the source, and consistent with the same
run's own table): the cast-detail surface asks Neynar for the conversation
(`2× detail · GET /v2/farcaster/cast/conversation @ api.neynar.com → 200`), and
Neynar's cast payload carries the page's own tags — which is exactly the
`openGraphFromNeynarEmbed` path that landed in `ecc6127`/`9cd530e`. The feed, by
contrast, reads its casts from **the node** (`castsByFid`, `castsByParent`, …),
and a node's cast carries a bare URL, so the descriptor has to come from the page
read (refused) or from the index (which answered).

### 2.2 The reads behind the feed, attributed — and a correction

The previous revision of this doc said "every read behind it is the node's". That
was wrong, and the run that said it was not the run the doc claimed. Measured, per
slice, for the fixture's feed:

| slice | node reads (`haatz.quilibrium.com`, all `200`) | index reads (`api.neynar.com`) |
| --- | --- | --- |
| arrival | `castsByFid` ×126, `linksByFid` ×258, `linksByTargetFid` ×176, `reactionsByCast` ×140, `userDataByFid` ×108, `castsByParent` ×40, `castsByMention` ×28, `info` ×12, `reactionsByFid` ×4 | `frame/search/` ×42 `200` + ×8 `400`, `frame/relevant/` ×8, `feed/channels` ×12, `user/bulk` ×12, `by_username` ×4, `cast/conversation` ×2 |
| feed (measured) | `castsByFid` ×124, `linksByFid` ×170, `linksByTargetFid` ×114, `reactionsByCast` ×120, `userDataByFid` ×70, `castsByParent` ×20, `castsByMention` ×4, `info` ×2, `reactionsByFid` ×4 — and `GET /send/cmi8… @ beep.works → failed` ×4, the refused page read retried in this window | `frame/relevant/` ×4, `feed/channels` ×2, `user/bulk` ×6, `by_username` ×2 — **and no `frame/search/` at all**, because the arrival window had already answered and the resolver caches per URL |

The two halves are both load-bearing: the node serves the feed, the index serves
the *card*, and the feed slice on its own cannot see the second — which is why the
arrival slice exists.

### 2.3 What this measurement does NOT establish

- **The launch itself.** No card put an iframe on screen and no launch button was
  pressed in this run: what is measured is that the card renders and carries a
  control named by the app. Whether pressing it opens the app is `t_93fa5c59`'s
  measurement (it pressed its own fixture's button and watched the mini-app host
  open), not this card's.
- **The camera/microphone deduction** in §4 item 3 is derived from two measured
  values (`Permissions-Policy` and the iframe's `allow=`), not watched in a
  browser.
- **The aged fixture's `Join The Firm`** — the word is measured on screen; which
  source supplies it is not.
- **The no-index case.** `VITE_NEYNAR_API_KEY` is configured in this tree's
  `.env.local`, so the index answered. What a reader sees with no key at all is
  read from the code (the page read alone — refused — so the embed stays a link),
  not measured.
- **The client's own two surfaces that list apps** (`/miniapps`, "your apps"):
  this card measured the feed's own card. The catalog/relevant reads are visible
  in the same report (`frame/relevant/` ×8 in the arrival window) but their
  surfaces are not part of this card's question.

### 2.4 The pictures, and what each one is

The run writes screenshots at both widths, and one of them is worth description
rather than a caption, because the last review of this card was right about it:

| file (all in this card's attachments) | what it is |
| --- | --- |
| `miniapp-in-feed.txt` | the run's report, verbatim. Every number in §2 comes from it. |
| `mobile-390-feed-fixture-in-view.png`, `desktop-1440-feed-fixture-in-view.png` | **the picture the card asked for**: the fixture cast scrolled into the middle of the viewport with its mini-app card under it (the app's art and the control reading `Open Beeper`), the shell's own "Let Fiddy post as you?" sheet dismissed first. Taken by `scripts/shot-miniapp-in-feed.mjs`, a companion to the probe, on the **same head and the same dev server** (`b3bdd7c`, `https://localhost:5183`) — because the probe's own feed screenshot lands on the top of the column with that sheet over it. That is measured, and it is why the companion exists. |
| `mobile-390-3-cast-detail.png`, `desktop-1440-3-cast-detail.png` (from the run) | the cast's own page, rendered, with the card's **button** carrying the page's own words, `Beep @topp-airdrop` — the difference §2.1 explains. The card's **image area is an unpainted flat grey rectangle in both**: `rgb(56, 56, 56)`, measured on the attached files just now — the mobile one's image area is a single distinct value (`250 × 82` sample, no artwork at all), and the desktop one's is 92% that one grey plus 7% page background caught by the sample box's edges, with **not one pixel brighter than 90 on any channel**. The descriptor *was* there: the report's own DOM row for that pass carries the page's `…/send/cmi8…/opengraph-image` src. So these two pictures show the shutter firing before the image painted, not a card that failed to build — and the next row is the control, from the same run and the same surface, where the art had painted. The shell's sheet covers the lower half of the mobile one. |
| `desktop-1440-4-aged-fixture-detail.png` (from the run) | the aged second fixture's page: a rendered cast with a card whose image area **has** painted — measured on the attached file: 11,118 distinct colours and 60% of that area brighter than 90 on some channel, i.e. real art — carrying that page's declared image, plus a control reading `Join The Firm`. It is the control for the row above: same surface, same run, art painted here. |
| `mobile-390-2-feed.png` (from the run) | **the top of the column only** — the fixture's row is below the fold and the shell's sheet covers the lower half. It is attached because it is what the run's own feed screenshot is; it is **not** a picture of the card, and the fixture's presence at that moment is the report's `fixtureTextOnScreen=true` rather than this image. |

Attachment names: the card's store kept the previous attempt's files and suffixed
the new ones, so four of these arrive as `miniapp-in-feed_1.txt`,
`mobile-390-3-cast-detail_1.png`, `desktop-1440-3-cast-detail_1.png` and
`mobile-390-2-feed_1.png`. The names in the table are the ones the probe and this
doc use; size is the quickest tell between an old file and this run's.

---

## 3. The decision, in three parts

The card offered (a) render the descriptor from the cast's own embed metadata
client-side, (b) refuse it by name, (c) a node-backed equivalent for the three
refused endpoints. Measured against §2:

### (a) — yes, and it is *already* the landed shape: two sources, in order

The literal (a) — fetch the page in the browser and parse `fc:miniapp` — is
**measured impossible for real miniapps**: no `Access-Control-Allow-Origin`, so
the read is refused before any parsing happens (8 refusals in the arrival window
alone). That is not a bug to fix; it is what cross-origin means. Quilcast's unfurl
is a **server module** (`server/unfurl.mjs`) for exactly this reason.

What the client actually does, and what §2 watched happen
(`src/snapchain/nodeApi/embedCards.ts`, `ecc6127` + `9cd530e`):

1. **one bounded `GET` of the page** — `<head>` only, `text/html` only, 192 KB
   cap, 4 s per read, concurrency 3, `credentials: 'omit'`, cached per URL for the
   session and persisted for the next one. This is what answers for the pages that
   *do* allow a cross-origin read.
2. **only when that read was refused or said nothing about an app**, an index that
   has already read the page — this client's is Neynar's frame search. **Measured:
   this is the source of the in-feed card**, and it produces an app-level card
   (the app's art, and a button the client names `Open <app>`) rather than the
   page's own descriptor.

So (a) is honest and it works, with one product consequence now measured rather
than assumed: **the in-feed card's button is not the button the app declared**.
A page's `fc:miniapp` button title only appears where the descriptor comes from a
read that carries the page's own tags — the cast-detail surface, in this client.
Whether the feed should say `Open Beeper` or `Beep @topp-airdrop` is a product
decision, not a bug, and it is recorded here as open rather than settled.

### (b) — kept for what neither source can answer

The refusal is not removed where it is still the truth, and the copy exists
already: the ranked **Home** feed answers `explore is a ranking, and ranking is an
indexer's job` (measured, in the console), and a surface with no reader answers
`This page isn't on your node` / `no node-backed reader has been written for this
endpoint yet`. When no index key is configured, `embedCards` degrades to the
browser read alone and a CORS-refused page stays a plain link — silence, not an
empty card.

### (c) — no node equivalent exists for two of the three, and the third was never a refusal

- `GET /v1/favorite-frames` — **no node equivalent.** Favourites are hosted
  account state. On `main` this route is now `catalog`: answered from Neynar's
  index (`/v1/new-frameapps` likewise), because an app is a web page with an
  `fc:miniapp` tag, not a protocol message a node could index.
- `GET /v1/search-miniapps` — **no node equivalent**; a read node keeps no search
  index. Same `catalog` answer.
- `GET /v2/frame-blocklist` — **not a refusal at all** on `main`: it is `local`.
  Nothing is blocked locally, and a blocklist is local state; the truthful answer
  is "nothing is blocked", which is what a local answer is.

There is no route in the table for the descriptor the fork's own renderer asks for
(`GET /v1/frame`, `FarcasterApiClient.getFrameDetails`) — which is exactly why the
descriptor is built from what the page (or the index) says instead of requested
from a server that does not exist.

---

## 4. The policy, before anyone frames a miniapp

The card's own words: launching somebody else's miniapp inside our shell needs its
own origin, a sandboxed iframe and a CSP, and **the policy is written down first**.
Here it is, with what the shipped build does today next to it.

**Measured, the shipped client** (`curl -sSI https://fiddy.fun/`, 2026-10-21):

```
content-security-policy: … connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'
permissions-policy: camera=(), microphone=(), geolocation=()
```

**Read, the miniapp host** (`components/miniApp/MiniApp.tsx:1477` and the
`IFrameLoader` it uses):

```jsx
<IFrameLoader
  src={url}                                              // the app's own origin
  allow="microphone; camera; clipboard-write"
  sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
/>
```

The policy this client holds, and the reasons:

1. **A miniapp's content never runs on our origin.** It is framed from its own
   origin, always. Nothing proxies a miniapp's HTML through `fiddy.fun` — the
   unfurl reads tags, it does not serve the app. This is the one rule that makes
   everything else survivable: on its own origin, the app has no access to our
   storage, our session or our app key.
2. **`sandbox` is the control, not a host allowlist.** `frame-src https:` is
   *required* — miniapp origins are arbitrary and cannot be enumerated — so the
   containment has to come from the sandbox. Keep `allow-forms allow-scripts
   allow-same-origin allow-popups`, and keep **not** adding
   `allow-popups-to-escape-sandbox`, `allow-top-navigation`, `allow-modals` or
   `allow-downloads`. `allow-same-origin` is safe here *only* because the frame is
   cross-origin; it must never be used to frame same-origin content.
3. **Camera and microphone: DECIDED — both stay denied.** This was open, and the
   card asked for one answer rather than a list of options. The answer is *denied*,
   for three reasons, in order of weight:
   - the shell's own document denies both for everything on `fiddy.fun`
     (`permissions-policy: camera=(), microphone=()`), and per the
     Permissions-Policy spec **a child frame cannot be granted a feature its
     parent denies** — so no miniapp can have them today without changing the
     whole client's document policy, not one launch *(spec-derived from the two
     measured values above; not watched in a browser)*;
   - a miniapp is somebody else's page, unenumerated and unaudited, and media
     access is a live-room capability, not a card capability. Nothing in the
     miniapp surface this client implements (wallet, signer, compose,
     notifications) needs media;
   - and the loop is closeable honestly: the iframe's `allow="microphone; camera;
     …"` is a **dead grant** today — it asks for what the parent already refuses.
     A follow-up card (`t_f5143ed9`, filed from this card) removes `microphone; camera`
     from that attribute, keeping `clipboard-write` (copy buttons need it), and
     puts the sentence in the settings copy: *"Mini apps run on their own site, in
     a sandbox. They cannot use your camera or microphone, and they cannot see
     your Fiddy session."* The copy is the part that matters: a capability that is
     denied should say so where a reader can find it.
4. **Everything that touches identity is mediated and confirmed.** Wallet,
   signer, compose and notifications are shell capabilities reached over
   `postMessage`; every request is untrusted input, and none of it happens
   silently. The app key stays in the shell's own storage, is never handed to a
   miniapp, and its scopes stay the protocol minimum (the repo's `KEY_ADD` asks
   cast/reaction/link/user-data scopes for 90 sliding days — a miniapp must not be
   able to spend those on its own).
5. **The unfurl read is a privacy surface, and its second half is now LANDED.**
   Reading a page from the reader's browser tells that page's host the reader's
   IP, and with a referrer it would also tell them *which cast the reader was
   looking at*. `credentials: 'omit'` was already set; **`referrerPolicy:
   'no-referrer'` is now set too** (`embedCards.ts`, with its own test —
   `22/22` in `embedCards.test.ts`). Where an index key exists, the index answer
   costs the reader nothing extra; where it does not, the browser read is what
   remains, and it now carries no referrer and no credentials. The settings copy
   should still say that a link in your feed may be read for its card.

---

## 5. Scope, and what this card did not do

- **Not duplicated:** the build (catalog reads via Neynar, the in-feed card, the
  launch) is card `t_93fa5c59`'s, on `main` at 22:54 (`5d90216`, `ecc6127`,
  `9cd530e`, `55a4ddd`). This card measures it, decides the shape and writes the
  policy — it does not re-implement any of it.
- **Not touched:** `docs/CLIENT-PARITY.md` — `git diff main..a9f7555 --
  docs/CLIENT-PARITY.md` is empty. Card `t_08e02638` owns that file and its
  miniapp rows, so this doc does not edit it, not even to point at this
  measurement. What the file actually says today, **quoted rather than
  paraphrased**, because an earlier revision of this doc paraphrased it wrongly —
  the cells, verbatim:
  - line 109, `Mini app / frame rendering in feed`, status cell: `renders (mock) —
    unverified with a live frame`; next-step cell: `verify once the feed is
    node-backed`;
  - line 108, `Mini apps — browse`, status cell: `gated; renders (mock, 21 calls)`;
    next-step cell: `NEEDS-NODE for the catalog; launching is client-side`.
  §2 of this doc is what can fill line 109's `verify once the feed is node-backed`
  cell in; making that edit is `t_08e02638`'s, not this card's. **The correction:**
  this doc used to say the row is left as it is "(`re-measure`)" — the word
  `re-measure` appears **nowhere** in `CLIENT-PARITY.md`. It is this card's own
  body's shorthand for "re-do the measurement", and the cells quoted above are the
  file's real words.
- **Filed from this card:** `t_f5143ed9` — the iframe-grant + settings-copy
  follow-up of §4 item 3 (removing the dead `microphone; camera` grant and saying
  in the copy that miniapps cannot use them).
- **Not verified, and said so above:** the launch itself; the Permissions-Policy
  deduction in a real browser; the aged fixture's `Join The Firm` source; the
  no-index-key case; and the button-words difference between the feed and the cast
  page, which is recorded as an open product question rather than a defect.