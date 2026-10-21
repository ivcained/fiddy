# Together — work with your people

One project, one board, everyone on the same page. You bring your Farcaster
identity; the people you invite bring theirs. Nobody creates an account, because
membership **is** the FID you already have.

Two routes, both reachable signed out:

| Route | What it is |
|---|---|
| `/~together` | where a session starts: sign in with Farcaster, then create a space or open one you are in |
| `/~together/join/:token` | the other end of an invite link — says whose space it is, then asks for nothing but Farcaster |

The ELI5 in the page header is the spec: *"One project, one board, everyone on
the same page… Each of you works the cards in your own Hermes — nobody shares a
key."*

## Where the data lives

Not in this app. A collaboration service (`/spaces/*`, the `hermes-multiplayer`
alpha) owns the space, its members and its cards. `src/lib/together.ts` is the
whole client: plain `fetch` against that service's origin, so a self-hosted
space and a hosted one take the same code path. In production the client and the
API share an origin (`VITE_TOGETHER_API_URL=''` means "same origin"); the dev
probe proxies `/spaces` instead.

The **board** stays live over a websocket (`/spaces/stream`), and still
converges without one: see below. Each card carries its own conversation, and
that thread polls (2 seconds) — in the service's terms, *the board is pushed over
a websocket; a card's thread still polls*. Typing is a heartbeat that expires by
itself; unread activity is a per-member, per-card watermark that starts at the
join, so a board's history is never retroactively unread and your own moves are
never unread to you.

## How a board stays live

One socket per open page, per space. It is opened on the service's own origin —
in production that is the same origin as the app — and authenticated with **the
same member session token every REST call on the page carries**. A browser cannot
set a header on a websocket handshake, so the token travels in the query string;
the service answers one it will not accept with close `1008` and a sentence
(`Sign in with Farcaster first`, `Join a space first`, `Not a member of this
space`) and never subscribes it.

What a frame carries is a **hint**, never the board:

```jsonc
// service → page: subscribed. `cursor` is where REST should start reading.
{ "type": "ready", "space_id": "…", "fid": 1234, "cursor": 42 }
// service → page: something changed in this space (a space_events row).
{ "type": "event", "space_id": "…", "seq": 43, "kind": "card.moved",
  "actor_fid": 5678, "actor_name": "marcus", "created_at": 1761…,
  "card_id": "…", "title": "Ship the Together surface", "status": "done" }
// service → page: this socket fell behind; the backlog was dropped.
{ "type": "gap", "dropped": 2 }
```

Every frame (`ready`, `event`, `gap`) sends the page back to `GET /spaces/state`,
which stays the authority. So a lost frame costs a reading one refresh and never
a wrong board, a client that missed a hundred of them catches up by asking, and
the service can drop a backlog instead of replaying it — REST can answer "what
is true now", the socket cannot.

On the page (`src/lib/together.ts` → `openTogetherStream`), that means:

- **the header says which path the page is on** — `Live`, `Connecting`,
  `Disconnected — reconnecting`, `Not live` — instead of looking merely idle;
- **reconnecting is automatic**, backing off 400 ms → 3 s and never giving up, so
  an open page comes back when the service does;
- **polling is still there as the fallback**, and only runs while the socket is
  not carrying the board — a locked-down network or an old browser still
  converges, just a few seconds slower (this is the 3-second `/spaces/events` ask
  the surface started with);
- `?together-poll=off` turns the fallback off entirely. That switch exists for
  measurement: the probe opens every page with it, so a board that converges can
  only have done so over the socket.

A production deploy has to forward the websocket upgrade on `/spaces` (any
reverse proxy in front of fiddy.fun); without that the page sits in
`Disconnected — reconnecting` while the service is perfectly healthy.

## What the page does

- **Sign in with Farcaster**: the service creates the challenge, so the nonce it
  gets back is bound to the request it started. This app only carries the
  channel URL to the QR and polls for the answer.
- **Start a space**: a name and a channel (`#fiddy`). The space then has a board
  with To do / Doing / Done.
- **Invite someone**: the owner mints a link; it lands on `/~together/join/<token>`.
- **Work a card**: start it, finish it, or send it back. Every move carries the
  card's version, so a card somebody else moved answers `409` instead of
  overwriting their change.
- **Cast it to the channel**: a finished card can be queued for the channel. The
  space does not post it — a member's own Hermes does, with that member's own
  signer.
- **Talk on a card**: every card carries its own thread. A message is authored
  by the session's own Farcaster identity with the handle that identity signed
  in with — a forged `author_fid`/`author_name` in the request body is ignored.
  While you are typing the people looking at that card see "you are typing…",
  and it clears when you stop, because it is a heartbeat the service drops when
  it expires. A card that changed since you last opened it wears a marker
  (`2 new`); opening the card is what clears it.

## How it is verified

`scripts/verify-together-surface.mjs` drives a real browser against the real
service, at both widths the surface has to work at. Nothing in the page is
stubbed; the probe plays the phone for the sign-in handshake (the service's
dev-only approve endpoint) and reads back what actually rendered.

```sh
# 1. the app, with the probe's own vite config (own dep cache + /spaces proxy,
#    websocket upgrade included)
cd ~/Projects/fiddy/apps/farcaster-web
HTTPS=false VITE_TOGETHER_API_URL='' TOGETHER_SERVICE_URL=http://127.0.0.1:8767 \
  npx vite --config scripts/together.vite.config.mjs --port 5199 --strictPort

# 2. the probe. Two levels:
#
#    without TOGETHER_SERVICE_CMD it measures somebody else's service (start one
#    the way the probe header prints) and REPORTS the reconnect checks as
#    skipped — a check nobody ran is never counted as passed;
#
#    with it, the probe runs the service itself, so it can kill it mid-session
#    and bring it back, which is the only way to measure what a page does when
#    the service disappears under it.
TOGETHER_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
TOGETHER_SERVER=http://localhost:5199 TOGETHER_SERVICE_URL=http://127.0.0.1:8767 \
TOGETHER_SERVICE_CMD="$HOME/Projects/hermes-multiplayer/.venv-verified/bin/python -m uvicorn server.service:app --host 127.0.0.1 --port 8767 --no-access-log" \
TOGETHER_SERVICE_CWD="$HOME/Projects/hermes-multiplayer" \
TOGETHER_SERVICE_DB="$HOME/Projects/hermes-multiplayer/.runtime/together-live.db" \
  node scripts/verify-together-surface.mjs
```

A service the probe starts is given one database file and one session secret on
every start, so a restart is a restart: with a fresh key per start every member
would be signed out, and "the board came back" would be measuring a sign-in
instead of a reconnected socket.

Every page the probe opens carries `?together-poll=off` and its requests are
counted, which is what makes the socket claims measurable rather than
decorative: a board that converges while its page made **zero**
`/spaces/events` requests did so over the socket. The two timed convergences
(the member's join and the member's move) use a five-second window, not the boot
budget, because the claim is "<1000ms" — a slow box has to report a number and
fail the claim, not pass by patience.

On a loaded machine the dev server can take a minute to serve its first paint,
which is not an assertion about the feature: every wait in the probe rides
`TOGETHER_BOOT_TIMEOUT` (milliseconds, default 300000), and `TOGETHER_WIDTHS=390`
runs one viewport instead of both while you iterate. A cold start that timed out
is worth one retry before it is worth a bug report.

Each run derives its own three identities from one base, so the probe does not
need a fresh database: run it twice against the same service and both runs are
full first runs (sign-in → create → invite → join). `TOGETHER_FID_BASE` pins
that base when a transcript has to be replayed exactly.

Recorded 2026-10-22 04:03–04:05 IST: **106/106 checks**, at 390×844 and
1440×900, on the landed tree (the socket on main's probe, the service started by
the probe itself on the 600/min default) — zero failures and zero skipped, ~2
minutes for both widths against a warm dev server. The headline and the honest
note, no horizontal overflow, the dark brand ground, a real QR from the service,
the create-space form, three columns laid out per width, every visible button
≥40px, a card added by the owner, an invite link that really is a URL into this
app, a **second identity** in a second browser context joining and seeing **both
members and the owner's card**, that member moving the card to Done, and the
owner's never-reloaded page **converging on its own**.

What makes the live half of that measurable: every page was opened with
`?together-poll=off` and its requests counted. Both boards said `Live`, both
opened a socket, and **both pages made 0 `/spaces/events` requests**, so every
convergence below arrived over the socket. Timed on the owner's never-reloaded
page: the new member landed there **138 ms** (390) and **55 ms** (1440) after the
member's own page said the join had gone through, and the member's move to Done
**4 ms and 8 ms after the service accepted it** (283 ms and 151 ms from the
click; the rest is the member's own REST write, which no transport change can
shorten). Then the service was killed under both pages: both said
`Disconnected — reconnecting`, both came back `Live` by themselves once it
returned, the board followed a card moved while they were away in **24 ms and
52 ms**, the page re-read the whole board (its `Last read` line moved), and the
only console errors in that window were the dead port's own — judged apart from
the rest of the run, not forgiven with it.

Then the
conversation, in those same two browsers: the member moves the card and the
**owner's** open board grows a marker on that card (`2 new`) with nobody
reloading; opening it clears the marker; the owner comments and the **member's**
board grows a marker on that same card (`1 new`), the member opens it and reads
her words under `@elena`, and their marker is gone; the member types and the
owner's open card says `marcus is typing…` and then stops saying it when they
stop; the member sends and the owner's open card shows the reply under
`@marcus`. Then what a thread refuses: a member of a **different** space asking
for this card's thread is answered `404`, an unauthenticated request `401`, and
a member of this space still reads it `200`. Plus zero console and page errors
in either context.

The probe earned its keep twice. On its first green run it caught a real bug:
after creating a space the page kept the *sign-in* token, which carries no
space, so every write answered "Join a space first" even though the board
rendered. The fix swaps the session's token for the one the create call returns
(and persists it) before the board mounts.

The second time was the opposite: the probe was wrong, not the feature. It waited
for an unread marker on the member's board for a card that was created **before**
they joined, whose only later activity was the member's **own** two moves. The
service is deliberate about both — the watermark starts at the join, and your own
moves are never unread to you — so that expectation was unsatisfiable, and the
probe now measures one real cross-identity change per marker instead of a
premise nobody promised. Watch for that shape: a green feature plus a red
assertion is not always a feature bug.

Then a third fix, again to the probe rather than the feature: the owner-side
assertions *waited* on the page's own text (`document.body.innerText`) but then
*read* the card's thread element. A comment is also a board event, so the
activity feed quotes it about one poll before the card's 2s thread poll has it —
the wait passed, the assertion read a thread that was still empty, and the same
probe that was 40/40 at 390 came back 38/40 at 1440 on a feature that worked.
Every thread assertion now waits on the thread element itself
(`[data-testid^="thread-"]`). Watch for that shape too: one width red and the
other green is a probe race until proven otherwise.

`tests/test_spaces.py` in the service holds the same rules at the API level (42
tests: the 37 the board already had, plus 5 for the thread), including the
cross-space `404`, the anonymous `401`, the forged author being ignored, typing
expiring on a moved clock, and a removed member's typing and watermarks going
with them.

## Running it by hand

The service needs its offline verifier for local work
(`HERMES_MULTIPLAYER_SIWF_MODE=trusting`) — that mode accepts the FIDs a dev
endpoint asserts and is not a production identity path. Without it, sign-in goes
through Farcaster's relay. Do not expose the alpha service publicly: single
process, SQLite, no per-space quotas (one per-caller flood guard, sized in the
next paragraph).

It counts requests per address, and that budget is sized for this page: 600 a
minute, which is two members of one space behind one address with a card open
(~50 requests a minute each) and room left over. It was 120, which one space can
reach by itself — that is why a probe run used to answer 429s that the browser
reported as failed resources, and why a run could die at a sign-in. If you
script against this service, budget for `Retry-After: 60` rather than retrying
immediately.

## Not here yet (say "soon", not "done")

- The board socket in front of users: the client half is on main (this page
  listens, and falls back to asking), but the **deployed** service predates
  `/spaces/stream`, so until that service is deployed what a visitor gets is the
  3-second fallback. Nothing in this page has to change for the socket to switch
  on; the deploy does.
- Notifications that leave the page: the unread marker is in-app only. No push,
  no email, no Telegram, no webhooks.
- Switching between several spaces from the board (the space list exists; the
  switcher is not wired).
- Attachments and assignee pickers on a card; direct messages (a thread hangs
  off a card and the whole space sees it — that is the whole conversation
  surface, on purpose).
- Any Together panel inside the Hermes plugin's dashboard page — the plugin's
  surface today is its seven `fiddy_spaces_*` agent tools (see
  `plugins/fiddy/docs/MULTIPLAYER.md` in `ivcained/legitmate-farcaster`).
