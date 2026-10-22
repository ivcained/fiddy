# A cast URL and a profile URL, answered as themselves

fiddy.fun is a single-page app: nginx serves one static shell for every route,
and the client's per-page `og:` tags are written by JavaScript a crawler never
runs. So until this service existed, EVERY url on the host unfurled as the front
door — a shared cast or profile link said "fiddy — a Farcaster client with an
agent" and showed the site card. t_1e01f488 made that front door a real card
(`public/fiddy-share-card.png`); this is the other half.

## What answers what

`apps/farcaster-web/server/unfurl/` ships inside the client release (see
`CLIENT-RELEASE.md`) and runs as **fiddy-unfurl.service** on the host, loopback
`:3220`. nginx routes exactly two things to it
(`scripts/fiddy-unfurl.nginx.conf`):

| requested | answered with |
| --- | --- |
| `GET /~/conversations/<hash>` | the release's own shell, with that cast's `og:`/`twitter:` tags and a 1200×630 card drawn for it |
| `GET /~/profiles/<fid>` | the same, for that account: display name, handle, bio |
| `GET /unfurl/cards/{cast/<hash>,profile/<fid>}.png` | the card itself, 1200×630, drawn on demand |
| `GET /unfurl/cast-author/<hash>` | `{"hash":…,"fid":…}` — the index the CLIENT reads (below) |
| `GET /unfurl/health` | what the service loaded: shell size, whether the site card is there, cache sizes |
| anything else under `/~/` | the shell, unchanged (the client owns the rest of that prefix) |

If the service is down, `error_page 502 503 504 = @fiddy_shell` serves the shell:
the page is still the app, exactly as before this existed. A page the service
cannot read (an unknown hash, a node that is not answering) is also the shell —
never a broken page, never an invented fact.

## Where the facts come from

* The **Snapchain node** (`/v1/castById`, `/v1/userDataByFid`) — the same reads
  the client makes, so a card shows what the app shows.
* **Neynar**, for one thing only: turning a cast HASH into its author's FID. A
  Snapchain node shards by FID, so `castById` needs the author as well as the
  hash, and a cast URL carries only the hash. The key is copied to
  `/etc/fiddy-unfurl/unfurl.env` (root-only) from the control plane's own
  environment by `scripts/install-fiddy-unfurl-service.sh`; without it a cast
  page still answers, as the shell, and says so in the log.

No follower counts, no avatars, no engagement: a card is a claim about a page,
and a claim has to come from somewhere.

## The card is drawn by Pillow, the site card by Playwright

`scripts/render-share-card.mjs` draws the SITE card with the reader's own Chrome,
which is right for a script a person runs and wrong for a service (the host has no
Chromium). `server/unfurl/render-card.py` draws the per-page cards with Python 3
and Pillow, which the host has, from the same language: ground `#161715`, ink
`#eef0e8`, dim `#9ba193`, chartreuse `#d4ff3f`, the same mascot still
(`fiddy-mark-poster.png`, out of the release's own web root) in the same corner.
Both files carry the fuller story in their headers.

Emoji are dropped rather than drawn as empty boxes: the only emoji face on the
host is a colour bitmap font FreeType will not scale to a 54px line honestly.

## The client half: a shared link has to OPEN, not only unfurl

A card on the other end of the link is worth nothing if the page it names cannot
be read. `GET /~/conversations/<hash>` gives the reader a hash and nothing else,
and a node cannot address a cast by hash alone — so before this, opening a
hash-only link cold (a shared link IS a cold open) ended in the client's honest
refusal.

The same service answers that too: `GET /unfurl/cast-author/<hash>` is the
same-origin index the reader asks when it has never served the cast
(`src/snapchain/providers/castAuthorHandoff.ts`, wired into
`NodeBackedReads.readThread`). One same-origin read, no key in the page, no
cross-origin call (`connect-src 'self'`), and the node still does all the
reading — the index is an author lookup, not a copy of the network.

With that in place, sharing points at ourselves:
`getFiddyCastUrl` / `getFiddyProfileUrl` (`packages/farcaster-client-data/src/utils/FiddyUrlUtils.ts`)
are what the web share surfaces copy — `/~/conversations/<full hash>` and
`/~/profiles/<fid>`. The handle is deliberately NOT in the cast path: `/dwr/0xec0c8a22`
is the prefix route, which this client reads through `/v2/user-thread-casts` and
no Snapchain node can answer. `getCastURL` is untouched for quote casts, the
composer and the mobile app: those are canonical NETWORK links.

## Verifying it

Local, no network (and inside the release ritual, step 3):

    cd apps/farcaster-web
    node server/unfurl/self-check.mjs dist/index.html /tmp/unfurl-self-check

It renders both pages from the build with fixture data (a cast whose text holds
quotes and angle brackets, a profile with a bio) and asserts the page's own tags
exactly once, the site's tags gone, `</head>` onward byte-identical, no inline
script, and the hostile values escaped.

Live, the way a crawler asks:

    curl -s -A 'facebookexternalhit/1.1' https://fiddy.fun/~/profiles/3 | grep -o 'og:[a-z:]*" content="[^"]*"'
    curl -sI https://fiddy.fun/unfurl/cards/profile/3.png          # 200 image/png
    curl -s http://127.0.0.1:3220/unfurl/health                    # on the host

The release ritual's step 8 asks the origin for `/~/profiles/3` and requires that
page's own `og:url`, then fetches the card and requires a 1200×630 PNG — so a
release that breaks the per-page half does not stay live.

## Host state this needs (once, then it outlives any release)

`bash scripts/install-fiddy-unfurl-service.sh` installs the unit, the service
account, `/etc/fiddy-unfurl/unfurl.env` (the Neynar key, copied on the host and
never printed) and the two nginx locations, then restarts the service. The
release ships the CODE and restarts it; it does not touch nginx — the same
division the vhost already has.

## What is not done here

* The mobile app (`apps/farcaster-mobile`) still shares `farcaster.xyz` links.
* Only cast and profile pages are tagged; a channel, a list or a mini app URL
  still unfurls as the front door.