# Releasing the client to fiddy.fun

Status 2026-10-21. The node-backed client (`apps/farcaster-web`) is live at
**https://fiddy.fun**, release `a0e53d5eda61f76b16c50e56a2179f71b7922fff`. The
release before it (`89cdd01…`) is still on disk, so a rollback is one command.
Everything below was run, not reasoned about — and every table row says which
release it was run against.

## What fiddy.fun serves now

| URL | What answers | Where it comes from |
| --- | --- | --- |
| `/` | the node-backed client | `releases/a0e53d5…/web/` (this release) |
| `/assets/*` | the client's hashed bundle | same |
| `/shell-bootstrap.js` | the shell's theme bootstrap — a same-origin classic script | same; this file is why `script-src` can be `'self'` (see the CSP section) |
| `/preview/` | the read-only preview, byte-identical to what used to be at `/` | `releases/a0e53d5…/web/preview/` |
| `/farcaster` | the same preview page (the miniapp's launch URL is unchanged) | `releases/a0e53d5…/web/preview/index.html` |
| `/snapchain-api/*` | the Snapchain node, relayed | nginx → `https://haatz.quilibrium.com` |
| `/api/fiddy/media`, `/api/fiddy/media/<sha256>.<ext>` | our media host | nginx → `:3219` (`fiddy-auth`) |
| `/api/farcaster/status`, `/api/farcaster/poidh/bounties` | the preview's read API | nginx → `:3218` (`fiddy-preview.service`) |
| `/client`, `/client/`, `/FSSC/`, `/start` | unchanged | elsewhere, untouched |

The release tree keeps three things the vhost and systemd depend on:

- `web/` — the client bundle;
- `server/server.mjs` — `fiddy-preview.service` runs
  `/var/www/fiddy.fun/current/server/server.mjs`, so a release without it kills
  that service the next time it restarts. The release copies the previous
  release's file verbatim (sha256 `493e1637…`, unchanged in this release);
- `web/preview/` — the previous release's page and assets, with its
  `/assets/…` references made relative so it resolves inside its own directory.

## Where the live 501 came from

The reported string was:

```
Image upload failed — generateImageUploadUrl 501 - no node-backed reader has been written
for this endpoint yet … Request: POST /v1/generate-image-upload-url Response: 501
```

It could not have come from fiddy.fun, and it did not: it came from the user's
own dev client on this machine, **`https://localhost:5173/`**.

Evidence, all measured:

1. The two halves of that message exist only in the node-backed adapter:
   `why: 'no node-backed reader has been written for this endpoint yet'`
   (`src/snapchain/nodeApi/hostedRoutes.ts:311`, returned as a 501 by
   `nodeBackedFetch.ts:371`) and the `Response: <status>` footer
   (`packages/farcaster-client-data/src/types/errors.ts:136`). Neither string is
   in any build on the VPS: `grep -r` over `/var/www`, `/opt` and `/srv` finds
   nothing.
2. What the VPS was serving at `/` was the **read-only preview** built by
   `legitmate-farcaster/scripts/build-fiddy-preview.mjs` (`mode:
   read-only-preview`, Privy stubbed out). Its three served chunks contain no
   composer at all — `grep -ci` for `composer`, `upload` and `warpcast` over
   `index-BVixwEz_.js`, `dist-DGLX_Xlr.js` and `fiddy-scene-BAcdTRgI.js` is 0 —
   so that surface had no code path to that error either.
3. The dev server on this machine is a node-backed client and says so: its
   transformed module carries
   `import.meta.env = {… "VITE_SNAPCHAIN_HTTP_URL": "https://haatz.quilibrium.com" …}`
   (`curl -k https://localhost:5173/src/snapchain/nodeApi/nodeBackedFetch.ts`),
   and it serves `src/snapchain/nodeApi/mediaUpload.ts` (which names
   `/api/fiddy/media`) and `src/constants/api.ts` (the fork's own hosted-API
   base).
4. The user reported the error at 2026-10-21 01:26 IST in the desktop session
   and was told, in the same thread, "refresh `https://localhost:5173/`" — the
   surface they were testing on.

So: the composer that failed was a locally served node-backed build; the fix in
`t_54ee6c54` was already live in that surface after a refresh, and nothing of it
was reachable at fiddy.fun until the first client release.

## The ritual

```bash
cd /Users/lc/Projects/fiddy
scripts/release-client.sh                    # build origin/main, upload, cut over, verify
scripts/release-client.sh <sha> --no-cutover # stage a release without switching
scripts/release-client.sh --rollback         # point current at the previous release
```

What it does, and why each step is not optional:

1. **Frozen tree.** `git archive <sha>` into a scratch tree with `node_modules`
   symlinked from the working clone — a release is a commit, not whatever the
   checkout holds.
2. **The build must carry the env.** `VITE_SNAPCHAIN_HTTP_URL` (the node the
   client reads through — without it `isNodeConfigured()` is false and a
   signed-in session lands on the device-only landing) and `VITE_FIDDY_MEDIA_URL`
   (the media host, named even though `https://fiddy.fun` is the default).
   Current release: node `https://haatz.quilibrium.com`, media
   `https://fiddy.fun`.
3. **Local gate.** The built bundle must contain the adapter's 501 sentence, the
   media path and the configured node, **and the built shell must carry no
   inline script** — the host serves `script-src 'self'`, so an inline
   `<script>` or an inline `on*=…` handler in `index.html` would be refused in
   the browser after the release. A build that needs one does not ship
   (`apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs`, taken from
   the frozen tree).
4. **Assemble** `web/` + `server/` + `web/preview/` as described above.
   Sourcemaps are left out: they are 44 MB of source for a public host.
5. **Upload and extract** into a new immutable `releases/<sha>/`; the running
   release is never written to.
6. **Disk gate on the VPS** — grep the extracted tree, and check the vhost still
   carries the client's locations. Not the deploy command's exit code.
7. **Cut over by symlink only** (`ln -sfn … && mv -Tf …`) plus one nginx reload
   in the same command; the previous release stays where it is.
8. **Served gate on fiddy.fun** — fetch the build's two strings through the
   public host, check the **served** `index.html` for inline script (the file the
   browser actually runs, not the one the build wrote), and compare the served
   asset byte-for-byte (`cmp`) with the build. Any mismatch rolls the symlink
   back.

nginx is **not** touched by the script. The client needs three locations that
exist now and are checked in step 6:

- `location ^~ /snapchain-api/` → `https://haatz.quilibrium.com/` with
  `client_max_body_size 2m` (the server-level limit is 1 KB, and a browser
  cannot POST `application/octet-stream` across origins — hence the relay);
- `location /` with `try_files $uri $uri/ /index.html` (a SPA needs route
  fallback) and the client's CSP — the one header in this vhost that changes
  when the shell changes, documented below;
- `location ^~ /preview/` and `location = /farcaster` → the preview page, under
  the preview's own stricter CSP.

### Rollback

```bash
cd /Users/lc/Projects/fiddy && scripts/release-client.sh --rollback   # → releases/89cdd01…/
ssh root@100.111.203.78 'ln -sfn /var/www/fiddy.fun/releases/89cdd016b5001f75548d92550ab7fa5b8b2d4ee1 \
  /var/www/fiddy.fun/current.new && mv -Tf /var/www/fiddy.fun/current.new /var/www/fiddy.fun/current'
```

The Oct 17 release (`9047c21…`, the read-only preview, with its `server/`) and
the first client release (`89cdd01…`) are both still on disk and byte-intact; the
symlink is the whole switch. The vhost change is backed up at
`/root/nginx-backups/fiddy.fun.*.bak`.

## The client's CSP: `script-src 'self'`, plus one host for Cloudflare's beacon

As served — `curl -sSI https://fiddy.fun/` on 2026-10-21, from `location /` in
`/etc/nginx/sites-available/fiddy.fun`:

```
default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'
```

One token of that header changed on 2026-10-21 (vhost backed up at
`/root/nginx-backups/fiddy.fun.20261021-031207.csp-self.bak`):

```diff
- script-src 'self' 'unsafe-inline';
+ script-src 'self' https://static.cloudflareinsights.com;
```

Nothing else in the header moved.

### Why `script-src` has no `'unsafe-inline'`

Two things in `apps/farcaster-web/index.html` used to need it, and both are gone
(commit `7cd04fd`):

1. **The theme bootstrap** — the `user-saved-theme` block that sets `html.dark`
   before first paint, so the shell never flashes the fork's light ground. It
   moved to `apps/farcaster-web/public/shell-bootstrap.js`, referenced as
   `<script src="/shell-bootstrap.js">`. It stays a **classic** (non-deferred)
   script on purpose: a module script is deferred, and a deferred bootstrap runs
   after the body is parsed, which is exactly the flash it exists to prevent. The
   served file is the repo's file, byte for byte (sha256 `f9ae13d9…`).
2. **The font sheet's `onload="this.media='all'"`** — an inline event-handler
   attribute is inline script, so moving only the `<script>` would have left the
   CSP just as wide. The Inter sheet is now a normal render-blocking stylesheet;
   the two preconnects above it are what keep the third-party fetch cheap.

### The one third-party allowance, and why it is written down

Cloudflare's zone injects `<script src="https://static.cloudflareinsights.com/beacon.min.js/…">`
into the HTML at the edge (measured: present on `/` for a browser-like request,
absent for curl's default UA; the injected tag carries its own `integrity=` SRI
hash and `crossorigin`). With `'self'` alone the browser refuses it and
logs a console error on every single load. The decision is to **allow that one
host** by name rather than keep a permanent console error, and it is measured in
a browser rather than assumed: the beacon is fetched and nothing about it is
refused (probe check 6b below).

### Why the rest of the header stays as wide as it is

Each allowance was measured, not guessed:

- `connect-src 'self' https: wss:` — the SIWF relay `relay.farcaster.xyz`, the
  Farcaster websocket `wss://ws.farcaster.xyz`, and **whichever node the reader
  picks in the node picker**, an arbitrary https host. Do not narrow this to
  `'self'`: the picker breaks, and the relay alone is not enough for a reader on
  their own node.
- `img-src … https:` — avatars served through `wrpcd.net`.
- `media-src … blob: https:` — the picked photo before it is uploaded (`blob:`)
  and the uploaded one after.
- `style-src https://fonts.googleapis.com` + `font-src https://fonts.gstatic.com`
  — Inter.
- `frame-src 'self' https:` — Farcaster's own sign-in frame.
- `style-src 'unsafe-inline'` — **deliberately kept**: the document carries two
  inline `<style>` blocks of its own (the ground colours, and the shell skeleton
  that keeps a signed-in cold load from painting an empty body). Inline *style*
  is not script; `style-src` is a different directive with a much smaller blast
  radius, and hashing it would mean rebuilding the document for a cosmetic gain.

### What holds the shape

- `apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs` — cheap, no
  browser: refuses a shell with an inline `<script>` or an inline `on*=`
  handler. Runs in the ritual at step 3 **and** on the served page at step 8.
- `apps/farcaster-web/scripts/verify-csp-script-src.mjs` — a real browser, ten
  checks: no inline script, no inline handler, `script-src` exactly `'self'` +
  the beacon host with no `unsafe-inline`/`unsafe-eval`, the bootstrap fetched
  200, the beacon not refused, nothing of the page's own refused, nothing newly
  refused hiding among the documented pre-existing refusals, and — with the app
  bundle blocked, so only the document can run — the shell still paints dark,
  and light for a reader who saved `light`.

### Re-checking it

```bash
curl -fsS https://fiddy.fun/ -o /tmp/served-index.html
node apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs /tmp/served-index.html
node apps/farcaster-web/scripts/verify-csp-script-src.mjs      # https://fiddy.fun by default
```

The first two are seconds; the third is the measurement behind every claim in
this section.

## Verified on the live host (2026-10-21)

Every row names the release it was measured on.

| Check | Result |
| --- | --- |
| Served shell carries no inline script | `check-shell-has-no-inline-script.mjs` on the fetched `/` (12,489 bytes): *"no inline script, no inline handler — script-src 'self' is enough"* — on `a0e53d5` |
| The CSP the browser is handed | the header above: `script-src 'self' https://static.cloudflareinsights.com`, no `'unsafe-inline'`, no `'unsafe-eval'` — on `a0e53d5` |
| The CSP in a real browser, live page | `verify-csp-script-src.mjs` against `https://fiddy.fun`: **10/10** — the bootstrap fetched 200, the beacon fetched and not refused, the document alone still dark (and light for a saved `light`), 1 console error total and it is the documented PostHog one — on `a0e53d5` |
| Served bytes ARE the built bytes | a fresh `git archive a0e53d5…` build reproduces them exactly: `/` `cmp` equal, sha256 `2a5fd7e1…` (12,489 bytes); the index chunk `/assets/index-DI2v8EDP.js` `cmp` equal, sha256 `873b279a…` (7,628,004 bytes); `/shell-bootstrap.js` sha256 `f9ae13d9…` (1,610 bytes) — on `a0e53d5` |
| `/release.json` | `{"revision":"a0e53d5eda61f76b16c50e56a2179f71b7922fff","mode":"node-backed-client","node":"https://haatz.quilibrium.com","media":"https://fiddy.fun"}` — on `a0e53d5` |
| A real sign-in, real browser, public site | the SIWF relay stubbed with a real SIWE message signed by a throwaway key: the ready step renders its own control, the click lands **in the client** — `path=/`, shell frame mounted, Cast control visible, no onboarding sheet, no device-only landing — on `a0e53d5` |
| Node relay through the public host | `GET https://fiddy.fun/snapchain-api/v1/info` → 200 with the node's `dbStats` |
| Composer, real browser, public site | `scripts/verify-media-upload.mjs` against `https://fiddy.fun`: **11/14** — sign-in lands in the client, the composer opens over the feed, the picked bytes are **POSTed to `https://fiddy.fun/api/fiddy/media` → 201**, the URL comes back on that host, the stored photo is readable (200, `image/jpeg`, 227,384 bytes), the served bytes hash to the name in the URL, the composer shows the photo with no failure copy, and nothing was posted to Farcaster. **Measured on `89cdd01`; not re-run on `a0e53d5`** — see the gap below |
| Preview / neighbour surfaces | on `a0e53d5`: `/preview/` 200, `/farcaster` 200, `/client` 200, `/client/` 200, `/FSSC/` 200, `/start` 200, `/manifest.json` 200, `/fiddy-card.png` 200, `/fiddy-splash.png` 200, `/shell-bootstrap.js` 200, `/robots.txt` 200, `mate.legitclub.com/api/health` 200 |

Three of the composer probe's fourteen checks were not satisfied on `89cdd01`,
and each says why:

- **"the upload-URL request … was answered by the MEDIA route"** and **"the cast
  payload … references the media URL"** read `window.__nodeBackedRequests`,
  which is published only under `VITE_SNAPCHAIN_DEBUG`; the release build does
  not set it. The same probe on the same commit with that flag (t_54ee6c54) is
  14/14. The live evidence for the same fact: the composer asked for an upload
  URL, no such request appears in the requests that left the page (the adapter
  answers it inside the page), a 201 upload followed, and no failure copy was
  shown — a 501 would have produced the failure copy and no upload.
- **"the photo is served immutable, with nosniff"** — the probe re-uses one
  deterministic photo, and its CDN entry was cached (immutable, one year) while
  nginx and the media service both sent `X-Content-Type-Options`. That duplicate
  is fixed (`proxy_hide_header x-content-type-options` in the media location,
  one header on 200 and 404 alike); the stale cache entry still shows two, and
  every freshly uploaded photo shows one.

## Known gaps (not this release's job)

- **The composer row was measured on the previous release.** `a0e53d5` carries
  other cards' composer and media-upload work, so that row is not evidence for
  it. Re-running `scripts/verify-media-upload.mjs` against `a0e53d5` fails in
  *the probe*, not in the client: it reads the page surface
  (`document.body.innerText`) while the sign-in's own navigation replaces the
  document, and throws on the null body
  (`Execution context was destroyed, most likely because of a navigation` — the
  same race `verify-cast-submit.mjs` was fixed for). That the client itself is
  fine is measured above: a real sign-in on `a0e53d5` lands in the client.
- `/client` and `/client/` (the static landing pages) keep
  `script-src 'self' 'unsafe-inline'` in their own locations: their HTML carries
  an inline `<script>` and no inline handler. Different page, different CSP —
  tightening it means moving that script out, which is not the client's shell.
- The client still makes a few hosted calls the public origin cannot serve:
  `api.farcaster.xyz/v1/audio-rooms` and `/v2/unseen` fail CORS, and PostHog
  analytics posts to `ph.neynar.com` with the fork's placeholder key
  (`REPLACE_ME`), which the CSP also refuses (`script-src-elem`). None of them
  touches the composer or the media path.
- `VITE_WALLETCONNECT_PROJECT_ID` is not set in the release build (the working
  clone's `.env.local` holds a placeholder), so WalletConnect-based wallets
  stay unavailable; the node picker and the public relay work without it.
- The miniapp's launch URL still opens the read-only preview at `/farcaster`.
  Pointing it at the client is a product decision, not a deploy detail.