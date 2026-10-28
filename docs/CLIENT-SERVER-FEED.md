# Server-drawn public feed

`/feed` arrives with real recent casts already in its HTML. A reader with
JavaScript disabled can read the public window, and the normal client hydrates
from exactly those casts instead of making a duplicate first-page request.
`/`, `/explore`, and the signed-in feed surfaces are unchanged.

## Source and attribution

The integration pattern is adapted from
[backmeupplz/quilcast](https://github.com/backmeupplz/quilcast), MIT license,
commit [`f63c7bdcbb99`](https://github.com/backmeupplz/quilcast/commit/f63c7bdcbb99e74a68faee2e55ad0f1fc5b13817).
Quilcast's signed-out server page, bounded refresh cache, boot seed, and stable
initial order informed this implementation. Fiddy's public-window reader,
routes, styling, provider rules, and privacy boundary are our own. No upstream
code is merged automatically.

## How it works

- `server/public-feed/service.mjs` holds one recent page in a bounded
  stale-while-refresh cache. A cold request waits up to two seconds, then gets
  the ordinary shell while the read continues. A stuck read has a hard
  deadline, and an empty or failed read is never cached as a successful page.
- `src/snapchain/nodeApi/publicFeedServer.ts` constructs the client's existing
  `NodeBackedReads` against the release's configured public node. The same
  handle anchors, bounded follow-graph fan-out, top-level-cast rule, real
  timestamps, and count semantics therefore apply on both server and client.
  It does not call Neynar or probe embed hosts.
- `scripts/build-public-feed-server.mjs` bundles that reader for plain Node.
  The output is ignored in source and built into every release. It is never
  imported by the browser bundle.
- `server/public-feed/page.mjs` escapes cast and profile content, permits only
  public HTTP(S) embed links, removes account addresses and viewer-only fields
  from the boot JSON, and preserves the shell's CSP and external stylesheet.
- `src/lib/publicFeedBoot.ts` captures the JSON before the SPA clears the
  static root. `usePublicWindow` supplies it to the existing infinite query and
  keeps the initial cast order when fresher values arrive. The seed is used
  once and only for `/feed`'s opening Recent window.
- The unfurl service answers exact `/feed` requests. nginx proxies that route
  to the service and falls back to the ordinary shell if it is unavailable.
  `scripts/fiddy-unfurl.nginx.conf` carries the host location and security
  headers.

## Verification

From `apps/farcaster-web`, with dependencies and workspace packages built:

```bash
pnpm exec vitest run \
  src/__tests__/serverPublicFeed.test.ts \
  src/__tests__/publicFeedBoot.test.ts \
  src/hooks/data/__tests__/usePublicWindow.test.tsx
node scripts/build-public-feed-server.mjs
node server/unfurl/self-check.mjs dist/index.html /tmp/fiddy-unfurl-check
```

The browser probe uses the real unfurl document and the real public node. Run
the unfurl service on `3233`, then the Vite config that transforms that
document through the normal dev pipeline:

```bash
PORT=3233 HOST=127.0.0.1 \
  FIDDY_WEB_ROOT="$PWD" FIDDY_ORIGIN=https://localhost:5234 \
  SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  node server/unfurl/server.mjs

PROBE_VITE_CACHE_DIR=/tmp/fiddy-server-feed-cache \
  SERVER_FEED_PROBE_SERVICE=http://127.0.0.1:3233 \
  VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  VITE_SNAPCHAIN_DEBUG=true VITE_FIDDY_MEDIA_URL=https://fiddy.fun \
  HTTPS=true npx vite --config scripts/server-feed.vite.config.mjs \
  --port 5234 --strictPort

SERVER_FEED_PROBE_SERVER=https://localhost:5234 \
  SERVER_FEED_PROBE_SERVICE=http://127.0.0.1:3233 \
  node scripts/verify-server-feed.mjs
```

The probe covers both 390px and 1440px, JavaScript-disabled rendering,
hydration order and duplicate-read prevention, Recent and Getting attention,
sign-in, error/retry, empty/retry, unexpected browser errors, and off-site
feed-provider reads. Existing cast embed probes and their CORS console noise
are explicitly distinguished from feed-provider reads.

After a release, fetch `/feed` itself. The HTML must contain
`data-fiddy-server-feed`, real cast articles, canonical
`https://fiddy.fun/feed`, and a matching `fiddy-public-feed-boot` JSON seed.
Also inspect the served entry and public-browse chunks, not only the merged
commit or `release.json`.
