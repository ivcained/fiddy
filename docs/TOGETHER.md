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

The board refreshes by asking what changed every 3 seconds (the event stream,
not a full re-read). Each card carries its own conversation, and that thread
polls the same way (2 seconds). Typing is a heartbeat that expires by itself;
unread activity is a per-member, per-card watermark that starts at the join, so
a board's history is never retroactively unread and your own moves are never
unread to you. Websockets are still **soon**: everything live rides that
polling, which is why a transport can be added later without touching any of
this.

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
# 1. the service, with its offline verifier, minting links back at the app
cd ~/Projects/hermes-multiplayer
HERMES_MULTIPLAYER_SIWF_MODE=trusting \
HERMES_MULTIPLAYER_DB_PATH="$PWD/.runtime/together-probe.db" \
HERMES_MULTIPLAYER_INVITE_BASE_URL="http://localhost:5199" \
  .venv-verified/bin/python -m uvicorn server.service:app \
  --host 127.0.0.1 --port 8767 --no-access-log

# 2. the app, with the probe's own vite config (own dep cache + /spaces proxy)
cd ~/Projects/fiddy/apps/farcaster-web
HTTPS=false VITE_TOGETHER_API_URL='' \
  npx vite --config scripts/together.vite.config.mjs --port 5199 --strictPort

# 3. the probe
TOGETHER_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
TOGETHER_SERVER=http://localhost:5199 TOGETHER_SERVICE_URL=http://127.0.0.1:8767 \
  node scripts/verify-together-surface.mjs
```

On a loaded machine the dev server can take a minute to serve its first paint,
which is not an assertion about the feature: every wait in the probe rides
`TOGETHER_LOAD_TIMEOUT_MS` (default 120s), and `TOGETHER_WIDTHS=390` runs one
viewport instead of both while you iterate. A cold start that timed out is worth
one retry before it is worth a bug report.

Recorded 2026-10-21/22: **80/80 checks**, at 390×844 and 1440×900 — the headline
and the honest note, no horizontal overflow, the dark brand ground, a real QR
from the service, the create-space form, three columns laid out per width, every
visible button ≥40px, a card added by the owner, an invite link that really is a
URL into this app, a **second identity** in a second browser context joining and
seeing **both members and the owner's card**, that member moving the card to
Done, and the owner's never-reloaded page **converging on its own**. Then the
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

`tests/test_spaces.py` in the service holds the same rules at the API level (32
tests), including the cross-space `404`, the anonymous `401`, the forged author
being ignored, typing expiring on a moved clock, and a removed member's typing
and watermarks going with them.

## Running it by hand

The service needs its offline verifier for local work
(`HERMES_MULTIPLAYER_SIWF_MODE=trusting`) — that mode accepts the FIDs a dev
endpoint asserts and is not a production identity path. Without it, sign-in goes
through Farcaster's relay. Do not expose the alpha service publicly: single
process, SQLite, no per-space rate limits.

## Not here yet (say "soon", not "done")

- Websockets — everything above rides polling, so a push transport is an
  optimisation, not a missing feature.
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
