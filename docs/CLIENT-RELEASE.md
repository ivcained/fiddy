# Releasing the client to fiddy.fun

Status 2026-10-21. The node-backed client (`apps/farcaster-web`) is live at
**https://fiddy.fun**, release `89cdd016b5001f75548d92550ab7fa5b8b2d4ee1`.
Everything in the tables below was run, not reasoned about.

## What fiddy.fun serves now

| URL | What answers | Where it comes from |
| --- | --- | --- |
| `/` | the node-backed client | `releases/89cdd01…/web/` (this release) |
| `/assets/*` | the client's hashed bundle | same |
| `/preview/` | the read-only preview, byte-identical to what used to be at `/` | `releases/89cdd01…/web/preview/` |
| `/farcaster` | the same preview page (the miniapp's launch URL is unchanged) | `releases/89cdd01…/web/preview/index.html` |
| `/snapchain-api/*` | the Snapchain node, relayed | nginx → `https://haatz.quilibrium.com` |
| `/api/fiddy/media`, `/api/fiddy/media/<sha256>.<ext>` | our media host | nginx → `:3219` (`fiddy-auth`) |
| `/api/farcaster/status`, `/api/farcaster/poidh/bounties` | the preview's read API | nginx → `:3218` (`fiddy-preview.service`) |
| `/client`, `/client/`, `/FSSC/`, `/start` | unchanged | elsewhere, untouched |

The release tree keeps three things the vhost and systemd depend on:

- `web/` — the client bundle;
- `server/server.mjs` — `fiddy-preview.service` runs
  `/var/www/fiddy.fun/current/server/server.mjs`, so a release without it kills
  that service the next time it restarts. The release copies the previous
  release's file verbatim (sha256 `493e1637…`);
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
was reachable at fiddy.fun until this release.

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
   media path and the configured node, or nothing ships.
4. **Assemble** `web/` + `server/` + `web/preview/` as described above.
   Sourcemaps are left out: they are 44 MB of source for a public host.
5. **Upload and extract** into a new immutable `releases/<sha>/`; the running
   release is never written to.
6. **Disk gate on the VPS** — grep the extracted tree, and check the vhost still
   carries the client's locations. Not the deploy command's exit code.
7. **Cut over by symlink only** (`ln -sfn … && mv -Tf …`) plus one nginx reload
   in the same command; the previous release stays where it is.
8. **Served gate** — fetch `/`, follow the asset it names, and compare it
   byte-for-byte (`cmp`) with the build. Any mismatch rolls the symlink back.

nginx is **not** touched by the script. The client needs three locations that
exist now and are checked in step 6:

- `location ^~ /snapchain-api/` → `https://haatz.quilibrium.com/` with
  `client_max_body_size 2m` (the server-level limit is 1 KB, and a browser
  cannot POST `application/octet-stream` across origins — hence the relay);
- `location /` with `try_files $uri $uri/ /index.html` (a SPA needs route
  fallback) and the client's CSP;
- `location ^~ /preview/` and `location = /farcaster` → the preview page.

### Rollback

```bash
ssh root@100.111.203.78 'ln -sfn /var/www/fiddy.fun/releases/9047c21de4b8bdf3aec52c5a92eb0fb7a4559505 \
  /var/www/fiddy.fun/current.new && mv -Tf /var/www/fiddy.fun/current.new /var/www/fiddy.fun/current'
```

The Oct 17 release (`9047c21…`, the read-only preview, with its `server/`) is
still on disk and byte-intact; the symlink is the whole switch. The vhost change
is backed up at `/root/nginx-backups/fiddy.fun.*.bak`.

### The client's CSP is deliberately wider than the preview's

`script-src 'self' 'unsafe-inline'` (the app's own inline theme bootstrap is in
`index.html`), `img-src … https:`, `media-src … blob: https:`,
`font-src … https://fonts.gstatic.com`, `connect-src 'self' https: wss:`,
`frame-src 'self' https:`. The client talks to the SIWF relay
(`relay.farcaster.xyz`), the Farcaster websocket (`wss://ws.farcaster.xyz`) and
**whatever node the reader picks in the picker** — an arbitrary https host, which
is the point of the picker. The preview keeps its own strict CSP.

## Verified on the live host (2026-10-21)

| Check | Result |
| --- | --- |
| Served bundle carries the adapter + media path | `grep` of the extracted web root **and** of the asset fetched through https://fiddy.fun |
| Served bytes are the built bytes | `cmp` equal, sha256 `62e57d73a278db24…` (7,619,175 bytes) |
| `/release.json` | `{"revision":"89cdd016b5001f…","mode":"node-backed-client","node":"https://haatz.quilibrium.com","media":"https://fiddy.fun"}` |
| Node relay through the public host | `GET https://fiddy.fun/snapchain-api/v1/info` → 200 with the node's `dbStats` |
| Composer, real browser, public site | `scripts/verify-media-upload.mjs` against `https://fiddy.fun`: sign-in lands in the client, the composer opens over the feed, the picked bytes are **POSTed to `https://fiddy.fun/api/fiddy/media` → 201**, the URL comes back on that host, the stored photo is readable by anyone (200, `image/jpeg`, 227,384 bytes), the served bytes hash to the name in the URL, the composer shows the photo with no failure copy, and nothing was posted to Farcaster |
| Preview / neighbour surfaces | `/preview/` 200, `/farcaster` 200, `/client` 200, `/FSSC/` 200, `/start` 200, `/fiddy-card.png` 200, `/fiddy-splash.png` 200, `/manifest.json` 200, `mate.legitclub.com/api/health` 200 |

Three of the probe's fourteen checks are not satisfied against the production
build, and each says why:

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

- The client still makes a few hosted calls the public origin cannot serve:
  `api.farcaster.xyz/v1/audio-rooms` and `/v2/unseen` fail CORS, and PostHog
  analytics posts to `ph.neynar.com` with the fork's placeholder key
  (`REPLACE_ME`). None of them touches the composer or the media path.
- `VITE_WALLETCONNECT_PROJECT_ID` is not set in the release build (the working
  clone's `.env.local` holds a placeholder), so WalletConnect-based wallets
  stay unavailable; the node picker and the public relay work without it.
- The miniapp's launch URL still opens the read-only preview at `/farcaster`.
  Pointing it at the client is a product decision, not a deploy detail.