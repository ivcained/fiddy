#!/bin/bash
# Release the node-backed Fiddy client (apps/farcaster-web) to fiddy.fun.
#
# The ritual, in order, and why each step is here:
#
#   1. a FROZEN tree at the sha under release (git archive) — a release is a
#      commit, not whatever the working clone happens to hold;
#   2. a build that CARRIES the three env values the client needs in production:
#        VITE_SNAPCHAIN_HTTP_URL  the node the client reads through. Without it
#                                 `isNodeConfigured()` is false and a signed-in
#                                 session lands on the device-only landing.
#        VITE_FIDDY_MEDIA_URL     the media host the composer uploads to
#                                 (default https://fiddy.fun, named anyway);
#        VITE_TOGETHER_API_URL    the collaboration service's origin, for the
#                                 Together surface (/~/together). It is BAKED on
#                                 purpose: `src/lib/together.ts` falls back to
#                                 http://127.0.0.1:8766 when the variable is
#                                 UNDEFINED, so a release that merely omits it
#                                 ships a client that asks the visitor's own
#                                 laptop for the board. The value is the empty
#                                 string — "same origin as this app" — because
#                                 the vhost rewrites /spaces onto the hosted
#                                 service (docs/TOGETHER.md);
#   3. a LOCAL gate: the built bundle must contain the adapter's 501 sentence,
#      the media path and the Together route — and must NOT contain the laptop
#      fallback above, or we do not ship it at all (the surface ships itself, so
#      a dropped route string is a release that quietly loses a feature) — and
#      the built shell must carry no inline script, because the host serves
#      script-src 'self' (the theme bootstrap lives at public/shell-bootstrap.js);
#   4. assemble the release tree the vhost expects — web/ (the client) plus
#      server/ (the read-only preview's API, which systemd runs from
#      /var/www/fiddy.fun/current/server/server.mjs, so a release without it
#      kills that service on its next restart) and web/preview/ (the preview
#      page itself, kept byte-identical and reachable at /preview/);
#   5. copy the artifact to the VPS and extract it into a NEW immutable
#      releases/<sha>/ — the running release is never written to;
#   6. a DISK gate on the VPS: grep the extracted web root (not the deploy
#      command's exit code);
#   7. cut over by symlink ONLY (ln -sfn … && mv -T), with the previous
#      release left in place; any failure after the swap rolls back by itself;
#   8. a SERVED gate that asks the ORIGIN: the built shell and the entry chunk
#      this build produced, compared byte-for-byte against what the host
#      answers when no cache can stand in for it; then one cache-busted fetch
#      through the edge as a gate, and a plain edge fetch that is REPORTED and
#      never judged (a stale edge copy is a TTL, not a broken release).
#
# It does not touch nginx. The vhost must already carry the client's locations
# (`/snapchain-api/`, the SPA fallback, `/preview/`); step 6 refuses to cut over
# if they are missing. See docs/CLIENT-RELEASE.md.
#
#   scripts/release-client.sh [sha]            # build, upload, cut over
#   scripts/release-client.sh [sha] --no-cutover
#   scripts/release-client.sh --rollback       # point current at the previous release
#
# The stage is a per-run directory ($STAGE_ROOT/fiddy-client-release-<sha>.XXXXXX).
# It used to be one fixed path whose first act was `rm -rf`, so two concurrent
# releases shared it and whichever started second deleted the other run's frozen
# tree, dist/, release/, tarball and served-gate artifacts mid-flight — a silent
# mix in which one tree's bytes are extracted/verified under another tree's sha
# (measured 2026-10-21: cards t_49d63304 and t_000ea7a9). KEEP FIDDY_RELEASE_STAGE
# for callers that want a pinned path, but a pinned path is shared by definition:
# pin it only when one release runs at a time. The chosen stage is printed as the
# first line of the run and again at the end.
set -euo pipefail

HOST=${FIDDY_HOST:-root@100.111.203.78}
RELEASES=${FIDDY_RELEASES:-/var/www/fiddy.fun/releases}
CURRENT=${FIDDY_CURRENT:-/var/www/fiddy.fun/current}
STAGE_ROOT=${FIDDY_RELEASE_STAGE_ROOT:-$HOME/.hermes/cache/scratch}
# A pinned path (FIDDY_RELEASE_STAGE set) is honoured as-is; the default is
# created per run, below, once the sha under release is known.
STAGE_PINNED=${FIDDY_RELEASE_STAGE:-}
NODE_URL=${FIDDY_BUILD_NODE_URL:-https://haatz.quilibrium.com}
MEDIA_URL=${FIDDY_BUILD_MEDIA_URL:-https://fiddy.fun}
# The collaboration service's origin for the Together surface. Empty string is
# the production shape: the client and the service share fiddy.fun's origin, and
# the vhost rewrites /spaces onto the hosted service. Never leave it out — see
# the header (an undefined value is the laptop fallback).
TOGETHER_URL=${FIDDY_BUILD_TOGETHER_API_URL-}
# Strings only this client build has (the adapter's sentence and our media path).
GATE_ADAPTER='no node-backed reader has been written'
GATE_MEDIA='api/fiddy/media'
# The Together surface's route literal, and the fallback that must never ship.
GATE_TOGETHER='/together'
GATE_TOGETHER_FALLBACK='127.0.0.1:8766'
# The public origin behind the host name — the box this script deploys to. Step
# 8 asks the ORIGIN what it serves, because that is the only answer a gate can
# trust: a CDN in front of it holds a copy of any URL whose name does not change
# between releases (index.html), and that copy may belong to another release.
ORIGIN_HOST=${FIDDY_ORIGIN_HOST:-fiddy.fun}
ORIGIN_IP=${FIDDY_ORIGIN_IP:-187.127.148.194}
# Fault injection for the gate itself: point the entry-chunk fetch at another
# path on purpose, to prove a release whose served chunk is wrong still fails
# and still rolls back. Used by the card that fixed step 8. Never set it in a
# real release.
GATE_ASSET_OVERRIDE=${FIDDY_GATE_ASSET:-}
# How long to keep re-checking a stale edge copy before calling it what it is (a
# CDN's TTL) instead of a broken release. Defaults to the max-age the host sets.
EDGE_SETTLE_WAIT=${FIDDY_EDGE_SETTLE_WAIT:-}

REPO=$(cd "$(dirname "$0")/.." && pwd)
say() { printf '\n== %s\n' "$*"; }
ssh_() { ssh -o BatchMode=yes "$HOST" "$@"; }

if [ "${1:-}" = "--rollback" ]; then
  PREV=$(ssh_ "readlink -f $CURRENT")
  PRIOR=$(ssh_ "ls -1dt $RELEASES/*/ | sed -n 2p")
  [ -n "$PRIOR" ] || { echo "no previous release to roll back to" >&2; exit 1; }
  echo "rolling $CURRENT back to $PRIOR (from $PREV)"
  ssh_ "ln -sfn $PRIOR $CURRENT.rollback && mv -Tf $CURRENT.rollback $CURRENT && readlink -f $CURRENT"
  exit $?
fi

SHA=${1:-$(git -C "$REPO" rev-parse origin/main)}
NO_CUTOVER=${2:-}
SHORT=${SHA:0:9}
git -C "$REPO" cat-file -e "$SHA^{commit}" || { echo "no such commit: $SHA" >&2; exit 1; }
# The full commit, for anything that has to MATCH a sha rather than name a
# directory (`--rollback`-style callers may pass a short sha, and /release.json
# always carries the 40-character one).
FULL_SHA=$(git -C "$REPO" rev-parse "$SHA^{commit}")

# The stage is created HERE, after the sha is known, so a default run gets a
# directory of its own and can never be the run that deletes another run's tree.
if [ -n "$STAGE_PINNED" ]; then
  STAGE=$STAGE_PINNED
  say "stage (pinned by FIDDY_RELEASE_STAGE, shared by any concurrent run): $STAGE"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
else
  mkdir -p "$STAGE_ROOT"
  STAGE=$(mktemp -d "$STAGE_ROOT/fiddy-client-release-$SHORT.XXXXXX")
  say "stage (per run): $STAGE"
fi
mkdir -p "$STAGE/base" "$STAGE/release"
# Which run owns this stage — the first question asked of a stage after the fact.
printf '{"sha":"%s","short":"%s","pid":%s,"host":"%s","started":"%s"}\n' \
  "$SHA" "$SHORT" "$$" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/run.json"

say "release $SHA ($(git -C "$REPO" log -1 --format=%s "$SHA"))"
say "1/8 frozen tree at $SHA"
git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE/base"
ln -s "$REPO/node_modules" "$STAGE/base/node_modules"
ln -s "$REPO/apps/farcaster-web/node_modules" "$STAGE/base/apps/farcaster-web/node_modules"

say "2/8 vite build (node $NODE_URL, media $MEDIA_URL, together '${TOGETHER_URL}' = same origin)"
( cd "$STAGE/base/apps/farcaster-web" && rm -rf dist && \
  VITE_SNAPCHAIN_HTTP_URL="$NODE_URL" VITE_FIDDY_MEDIA_URL="$MEDIA_URL" \
  VITE_TOGETHER_API_URL="$TOGETHER_URL" \
  NODE_OPTIONS=--max-old-space-size=8192 npx vite build > "$STAGE/build.log" 2>&1 ) \
  || { tail -30 "$STAGE/build.log"; exit 1; }

say "3/8 local gate: the bundle carries the adapter, the media path and Together"
APP="$STAGE/base/apps/farcaster-web/dist"
grep -rqs "$GATE_ADAPTER" "$APP/assets" || { echo "MISSING adapter sentence in the build" >&2; exit 1; }
grep -rqs "$GATE_MEDIA" "$APP/assets" || { echo "MISSING media path in the build" >&2; exit 1; }
grep -rqs "$NODE_URL" "$APP/assets" || { echo "MISSING the configured node in the build" >&2; exit 1; }
# `--include='*.js'`: vite writes a sourcemap per chunk and a sourcemap carries
# the ORIGINAL source text, so a plain `grep -r` over assets finds strings the
# shipped JavaScript does not contain (measured 2026-10-21: the fallback below in
# `together-*.js.map` only, while the chunk itself had folded it away). Check
# the code that ships, not the code the map remembers.
grep -rqs --include='*.js' "$GATE_TOGETHER" "$APP/assets" || { echo "MISSING the Together route in the build" >&2; exit 1; }
# The Together surface ships itself: /~/together is reachable signed out, and
# the page asks the collaboration service for a board. `src/lib/together.ts`
# answers http://127.0.0.1:8766 when VITE_TOGETHER_API_URL is UNDEFINED, which in
# a visitor's browser means their own laptop — the page renders and every call
# fails. That is a shipping bug, so refuse it here rather than measure it live.
if grep -rqs --include='*.js' "$GATE_TOGETHER_FALLBACK" "$APP/assets"; then
  echo "REFUSING to ship: the built JavaScript carries $GATE_TOGETHER_FALLBACK, so VITE_TOGETHER_API_URL was never set" >&2
  exit 1
fi
echo "  adapter  ok"
echo "  media    ok"
echo "  node     ok ($NODE_URL)"
echo "  together ok (route literal; no laptop fallback in the chunks, api = '${TOGETHER_URL}' same origin)"
# The shell the host serves runs under script-src 'self'. An inline <script> in
# index.html (the theme bootstrap used to be one) or an inline on*= handler (the
# font sheet used to have one) is inline script, and that CSP refuses it — in
# the browser, on the live page, after the release. Refuse to ship it instead.
# The checker is taken from the FROZEN tree, not the working clone: the rule
# that governs a release is the rule at the commit being released.
CHECK_SHELL="$STAGE/base/apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs"
node "$CHECK_SHELL" "$APP/index.html" \
  || { echo "REFUSING to ship: the built shell needs script-src 'unsafe-inline'" >&2; exit 1; }
# The entry chunk the release ships, resolved from the shell THIS BUILD wrote.
# Never from a served shell: a served `index.html` may belong to another release
# (or to a CDN's copy of one), and a path derived from it names a file this build
# never produced — measured 2026-10-21, when step 8 derived
# `dist/assets/index-xFMI6dSv.js` from the edge's cached HTML while the build
# under release had produced `index-BZPuaWpC.js`, and the comparison died on a
# local `No such file or directory` instead of naming a real difference (card
# t_62596c9c). Step 8 fetches THIS path and compares the bytes it gets back.
BUILT_ASSET=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$APP/index.html" | head -1)
[ -n "$BUILT_ASSET" ] || { echo "REFUSING to ship: the built shell names no /assets/index-*.js entry chunk" >&2; exit 1; }
[ -f "$APP$BUILT_ASSET" ] || { echo "REFUSING to ship: the built shell names $BUILT_ASSET and the build has no such file" >&2; exit 1; }

say "4/8 assemble web/ + server/ + the preview it must keep"
WEB="$STAGE/release/web"
mkdir -p "$WEB"
# Sourcemaps stay out of the release: they are 44 MB of source for a public host.
( cd "$APP" && find . -name '*.map' -prune -o -type f -print | tar -cf - -T - ) | tar -xf - -C "$WEB"
# The previous release supplies the preview page and its API, unchanged.
PRIOR=$(ssh_ "readlink -f $CURRENT")
rsync -a "$HOST:$PRIOR/web/index.html" "$STAGE/prior-index.html"
rsync -a "$HOST:$PRIOR/server/" "$STAGE/server/"
mkdir -p "$WEB/preview" "$STAGE/release/server"
# The preview keeps the URLs that are already live under the release root…
for f in fiddy-card.png fiddy-splash.png fiddy-icon.png fiddy-mark-180.png fiddy-favicon.svg fiddy-baby.glb ROBOT-HEADS-NOTICE.txt; do
  rsync -a "$HOST:$PRIOR/web/$f" "$WEB/$f"
done
# …and moves to /preview/, with its own asset references made relative so both
# the page and its chunks resolve inside that directory.
sed 's#"/assets/#"assets/#g' "$STAGE/prior-index.html" > "$WEB/preview/index.html"
rsync -a --delete "$HOST:$PRIOR/web/assets/" "$WEB/preview/assets/"
cp -a "$STAGE/server/." "$STAGE/release/server/"
rm -rf "$STAGE/preview-assets" "$STAGE/prior-index.html"
printf 'User-agent: *\nDisallow: /api/\n' > "$WEB/robots.txt"
printf '{"revision":"%s","mode":"node-backed-client","node":"%s","media":"%s"}\n' \
  "$FULL_SHA" "$NODE_URL" "$MEDIA_URL" > "$WEB/release.json"

say "5/8 upload"
tar -czf "$STAGE/fiddy-client-$SHORT.tar.gz" -C "$STAGE/release" .
ssh_ "install -d -m 0755 $RELEASES/$SHA"
ssh_ "tar -xzf - -C $RELEASES/$SHA" < "$STAGE/fiddy-client-$SHORT.tar.gz"
scp -q "$STAGE/fiddy-client-$SHORT.tar.gz" "$HOST:/var/www/fiddy.fun/" 

say "6/8 disk gate on the VPS (the extracted web root, and the vhost it needs)"
ssh_ "set -e
  grep -rqs '$GATE_ADAPTER' $RELEASES/$SHA/web/assets
  grep -rqs '$GATE_MEDIA' $RELEASES/$SHA/web/assets
  grep -rqs '$NODE_URL' $RELEASES/$SHA/web
  grep -rqs --include='*.js' '$GATE_TOGETHER' $RELEASES/$SHA/web/assets
  if grep -rqs --include='*.js' '$GATE_TOGETHER_FALLBACK' $RELEASES/$SHA/web/assets; then
    echo 'the extracted bundle carries the laptop fallback'; exit 1
  fi
  test -f $RELEASES/$SHA/web/preview/index.html
  test -f $RELEASES/$SHA/server/server.mjs
  grep -q 'snapchain-api' /etc/nginx/sites-available/fiddy.fun
  grep -q 'location ^~ /preview/' /etc/nginx/sites-available/fiddy.fun
  grep -q 'proxy_pass http://127.0.0.1:8787;' /etc/nginx/sites-available/fiddy.fun
  echo '  disk gate ok: bundle (adapter, media, node, together), preview, server, vhost locations'"

if [ "$NO_CUTOVER" = "--no-cutover" ]; then
  say "staged at $RELEASES/$SHA (not cut over)"
  echo "  stage (kept for this run only): $STAGE"
  exit 0
fi

say "7/8 cut over (symlink only; the previous release stays where it is)"
PREV_TARGET=$(ssh_ "readlink -f $CURRENT")
# Swap and reload in one call: the vhost was already replaced and tested, so the
# window where nginx still holds the old config is the length of one command.
ssh_ "ln -sfn $RELEASES/$SHA $CURRENT.new && mv -Tf $CURRENT.new $CURRENT && nginx -t && systemctl reload nginx"
echo "  $CURRENT -> $(ssh_ "readlink -f $CURRENT")"
echo "  previous release kept: $PREV_TARGET"
echo "  rollback: $0 --rollback   (or: ssh $HOST 'ln -sfn $PREV_TARGET $CURRENT.new && mv -Tf $CURRENT.new $CURRENT')"

rollback_on_failure() {
  echo "VERIFY FAILED — rolling $CURRENT back to $PREV_TARGET" >&2
  ssh_ "ln -sfn $PREV_TARGET $CURRENT.new && mv -Tf $CURRENT.new $CURRENT"
  echo "rolled back: $(ssh_ "readlink -f $CURRENT")" >&2
}

say "8/8 served gate: the ORIGIN's answer is the gate, the edge's copy is a report"
set +e

# What this step is FOR: prove the bytes fiddy.fun serves ARE the bytes this
# build produced. What it must never do again is judge a release on a CDN's copy
# of a URL whose name does not change between releases. Measured 2026-10-21 (card
# t_62596c9c): a release cut over seconds after a sibling's cutover was judged
# against the edge's cached index.html, which named the PREVIOUS release's entry
# chunk; the built-side path was derived from that served name, so the
# comparison aborted on a local `No such file or directory` and the ritual rolled
# a good release back by itself — while the origin had been serving the new
# release correctly the whole time, and the edge agreed a few minutes later.
# Three rules follow, and this block is written to them:
#
#   * the entry chunk is resolved from the BUILT shell (step 3, $BUILT_ASSET),
#     and it is THAT path the gate fetches;
#   * the shell-and-chunk comparison is made against the ORIGIN — by IP, with
#     TLS SNI still the host name — so no cache copy can stand in for it;
#   * the edge gets a cache-busted fetch (`?cb=<sha>`, a fresh key that no older
#     release can satisfy) as a gate, and the plain edge fetch as a REPORT: when
#     it is stale the answer is to wait for the TTL, never to roll back.
GATE_ASSET=${GATE_ASSET_OVERRIDE:-$BUILT_ASSET}
if [ -n "$GATE_ASSET_OVERRIDE" ]; then
  echo "  FAULT INJECTION: the chunk fetch is pointed at $GATE_ASSET, not at this release's $BUILT_ASSET" >&2
fi

# The origin, by IP: the same vhost a browser reaches, with no CDN in the path.
# Sets ORIGIN_CODE to the HTTP status it got. The loopback + `Host:` fallback is
# for a host this machine cannot reach on its public IP (and it reads exactly
# what that vhost serves).
origin_get() {  # origin_get <path> <outfile>
  ORIGIN_CODE=$(curl -sk --connect-timeout 10 --max-time 60 --resolve "$ORIGIN_HOST:443:$ORIGIN_IP" -o "$2" -w '%{http_code}' "https://$ORIGIN_HOST$1" || true)
  if [ -z "${ORIGIN_CODE:-}" ] || [ "${ORIGIN_CODE:-000}" = 000 ]; then
    # Fallback: read it from the box itself — HTTPS with SNI, resolved to the
    # loopback (the port-80 block on this vhost only 308-redirects to https).
    # Two calls, deliberately: the status code is fetched to /dev/null and the
    # body on its own, because an appended `-w` code would leave a stray newline
    # in the bytes this gate compares.
    ORIGIN_CODE=000
    FALLBACK_CODE=$(ssh_ "curl -sk --resolve $ORIGIN_HOST:443:127.0.0.1 -H 'Host: $ORIGIN_HOST' -o /dev/null -w '%{http_code}' https://$ORIGIN_HOST$1" 2>/dev/null || true)
    if [ -n "$FALLBACK_CODE" ]; then
      ORIGIN_CODE=$FALLBACK_CODE
      ssh_ "curl -sk --resolve $ORIGIN_HOST:443:127.0.0.1 -H 'Host: $ORIGIN_HOST' https://$ORIGIN_HOST$1" > "$2" || true
    fi
  fi
  [ "${ORIGIN_CODE:-000}" != 000 ]
}
origin_revision() {
  origin_get /release.json "$STAGE/origin-release.json" || return 1
  grep -o '"revision":"[0-9a-f]\{7,\}"' "$STAGE/origin-release.json" | head -1 | cut -d'"' -f4
}
# Every failure below names WHAT it compared, so the next reader does not have to
# guess which side was wrong.
gate_fail() {
  echo "GATE FAILED: $*" >&2
  rollback_on_failure
  exit 1
}
sha16() { shasum -a 256 "$1" | cut -c1-16; }

echo "  built entry chunk: $BUILT_ASSET  $(wc -c < "$APP$BUILT_ASSET") bytes  sha256 $(sha16 "$APP$BUILT_ASSET")…"

# 1. The shell, from the origin. index.html is the one URL whose name is the
#    same in every release, so it is the one a CDN can answer with somebody
#    else's bytes; only the origin can say what this host serves.
origin_get / "$STAGE/origin-index.html" \
  || gate_fail "the origin did not answer at all for GET / (tried $ORIGIN_IP:443 and 127.0.0.1 with Host: $ORIGIN_HOST)"
[ "$ORIGIN_CODE" = 200 ] || gate_fail "the origin answered HTTP $ORIGIN_CODE for /"
ORIGIN_ASSET=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$STAGE/origin-index.html" | head -1)
echo "  origin GET / → ${ORIGIN_ASSET:-nothing}"
if [ "$ORIGIN_ASSET" != "$BUILT_ASSET" ]; then
  # Distinguish "another release is live" from "the host is serving something
  # wrong": the first is a race with a sibling release, and rolling back would
  # revert THEIR cutover, so this run stops and says so instead.
  REV=$(origin_revision || true)
  if [ -n "$REV" ]; then
    case "$REV" in
      *"$SHA"*) ;;
      *) echo "OVERTAKEN: the origin is serving release $REV, not $SHA — another release cut over while this one ran." >&2
         echo "NOT rolling back: $CURRENT stays on $REV. Re-run this release when the host is free." >&2
         exit 2 ;;
    esac
  fi
  gate_fail "the origin's shell names $ORIGIN_ASSET; this build produced $BUILT_ASSET"
fi
cmp -s "$STAGE/origin-index.html" "$APP/index.html" \
  || gate_fail "the origin's shell is not this build's shell (origin sha256 $(sha16 "$STAGE/origin-index.html")…, built sha256 $(sha16 "$APP/index.html")…)"
# The served shell is what the browser runs, so check THAT file and not only the
# one the build produced: an inline <script> or an inline on*= handler in it is
# refused by the host's script-src 'self'.
node "$CHECK_SHELL" "$STAGE/origin-index.html" \
  || gate_fail "the origin's shell needs script-src 'unsafe-inline'"
echo "  origin shell: byte-identical to the built shell, no inline script"

# 2. The entry chunk at the path THIS BUILD produced, from the origin, compared
#    byte-for-byte. This is the heart of the check.
origin_get "$GATE_ASSET" "$STAGE/origin-entry.js" \
  || gate_fail "the origin did not answer at all for $GATE_ASSET"
[ "$ORIGIN_CODE" = 200 ] || gate_fail "the origin answered HTTP $ORIGIN_CODE for $GATE_ASSET (this build's entry chunk path)"
echo "  origin GET $GATE_ASSET → HTTP 200, $(wc -c < "$STAGE/origin-entry.js") bytes  sha256 $(sha16 "$STAGE/origin-entry.js")…"
cmp -s "$STAGE/origin-entry.js" "$APP$BUILT_ASSET" \
  || gate_fail "the bytes the origin serves at $GATE_ASSET are not the entry chunk this build produced ($BUILT_ASSET): origin sha256 $(sha16 "$STAGE/origin-entry.js")…, built sha256 $(sha16 "$APP$BUILT_ASSET")…"
# The served chunk IS the release's own bytes (cmp above), so the strings are
# read on the bytes a browser actually downloads.
for s in "$GATE_ADAPTER" "$GATE_MEDIA" "$NODE_URL"; do
  grep -q "$s" "$STAGE/origin-entry.js" || gate_fail "the served entry chunk does not carry '$s'"
done
if grep -q "$GATE_TOGETHER_FALLBACK" "$STAGE/origin-entry.js"; then
  gate_fail "the served entry chunk carries $GATE_TOGETHER_FALLBACK"
fi
echo "  served entry chunk carries: the adapter sentence, the media path, the configured node; no laptop fallback"

# 3. One cache-busted fetch through the edge. `?cb=<sha>` is a cache key no
#    earlier release can have populated, so this asks the question a browser on
#    a cold cache asks — can the edge pass on what the origin is serving?
curl -fsS "https://fiddy.fun/?cb=$SHORT" -o "$STAGE/edge-cb-index.html" \
  || gate_fail "the edge did not answer GET /?cb=$SHORT"
cmp -s "$STAGE/edge-cb-index.html" "$STAGE/origin-index.html" \
  || gate_fail "the edge's cache-busted shell differs from the origin's (edge sha256 $(sha16 "$STAGE/edge-cb-index.html")…, origin sha256 $(sha16 "$STAGE/origin-index.html")…)"
node "$CHECK_SHELL" "$STAGE/edge-cb-index.html" \
  || gate_fail "the edge's shell needs script-src 'unsafe-inline'"
curl -fsS "https://fiddy.fun$GATE_ASSET?cb=$SHORT" -o "$STAGE/edge-cb-entry.js" \
  || gate_fail "the edge did not answer GET $GATE_ASSET?cb=$SHORT"
cmp -s "$STAGE/edge-cb-entry.js" "$STAGE/origin-entry.js" \
  || gate_fail "the edge's cache-busted copy of $GATE_ASSET differs from the origin's bytes (edge sha256 $(sha16 "$STAGE/edge-cb-entry.js")…, origin sha256 $(sha16 "$STAGE/origin-entry.js")…)"
echo "  edge /?cb=$SHORT and $GATE_ASSET?cb=$SHORT: this release's bytes"

# 4. What the host says it is serving. release.json is sent `no-store`, so this
#    is the origin's answer even through the edge.
curl -fsS https://fiddy.fun/release.json -o "$STAGE/served-release.json" \
  || gate_fail "the host did not serve /release.json"
grep -q "\"revision\":\"$FULL_SHA\"" "$STAGE/served-release.json" \
  || gate_fail "/release.json does not name $FULL_SHA: $(tr -d '\n' < "$STAGE/served-release.json" | head -c 160)"
echo "  GET /release.json → $(tr -d '\n' < "$STAGE/served-release.json")"

# 5. The PLAIN edge fetch — reported, never judged. This is the fetch that used
#    to decide the release. It is allowed to hand back a cached copy of an
#    earlier release (Cloudflare honours the host's `max-age` for index.html,
#    serves chunk bytes with `max-age=604800`, and caches a chunk 404 for four
#    hours — all measured), so a mismatch here means "the CDN still has the old
#    copy", and the answer is to wait for its TTL, never to roll back.
#    `FIDDY_EDGE_PROBE_ASSET=<path>` points this probe at another URL on purpose
#    (a test knob: point it at a path the edge has cached from an earlier
#    release); a real release probes its own entry chunk.
EDGE_PROBE_ASSET=${FIDDY_EDGE_PROBE_ASSET:-$BUILT_ASSET}
edge_report() {
  curl -sS -D "$STAGE/edge-index.hdr" -o "$STAGE/edge-index.html" https://fiddy.fun/ || return 1
  EDGE_TTL=$(grep -i '^cache-control:' "$STAGE/edge-index.hdr" | grep -o 'max-age=[0-9]*' | head -1 | cut -d= -f2)
  EDGE_TTL=${EDGE_TTL:-300}
  EDGE_STATE=$(grep -i '^cf-cache-status:' "$STAGE/edge-index.hdr" | tr -d '\r' | awk '{print $2}')
  EDGE_AGE=$(grep -i '^age:' "$STAGE/edge-index.hdr" | tr -d '\r' | awk '{print $2}')
  EDGE_ASSET=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$STAGE/edge-index.html" | head -1)
  EDGE_CHUNK_CODE=$(curl -sS -D "$STAGE/edge-chunk.hdr" -o "$STAGE/edge-chunk.bin" -w '%{http_code}' "https://fiddy.fun$EDGE_PROBE_ASSET")
  EDGE_CHUNK_STATE=$(grep -i '^cf-cache-status:' "$STAGE/edge-chunk.hdr" | tr -d '\r' | awk '{print $2}')
  EDGE_CHUNK_TTL=$(grep -i '^cache-control:' "$STAGE/edge-chunk.hdr" | grep -o 'max-age=[0-9]*' | head -1 | cut -d= -f2)
  # What the ORIGIN answers for the same URL: "the edge still has an older
  # release's copy" and "this URL is simply not served" are different things.
  origin_get "$EDGE_PROBE_ASSET" "$STAGE/origin-probe.bin" || true
  ORIGIN_PROBE_CODE=${ORIGIN_CODE:-000}
  EDGE_AGREE=yes
  [ "$EDGE_ASSET" = "$BUILT_ASSET" ] || EDGE_AGREE=no
  if [ "$EDGE_CHUNK_CODE" != "$ORIGIN_PROBE_CODE" ]; then
    EDGE_AGREE=no
  elif [ "$EDGE_CHUNK_CODE" = 200 ]; then
    cmp -s "$STAGE/edge-chunk.bin" "$STAGE/origin-probe.bin" || EDGE_AGREE=no
  fi
  printf '  edge (informational): GET / → %s [cf-cache-status %s%s]; GET %s → HTTP %s from the edge [cf-cache-status %s%s], HTTP %s from the origin\n' \
    "${EDGE_ASSET:-nothing}" "${EDGE_STATE:-?}" "${EDGE_AGE:+, age ${EDGE_AGE}s}" \
    "$EDGE_PROBE_ASSET" "${EDGE_CHUNK_CODE:-?}" "${EDGE_CHUNK_STATE:-?}" \
    "${EDGE_CHUNK_TTL:+, max-age ${EDGE_CHUNK_TTL}s}" "${ORIGIN_PROBE_CODE:-?}"
  [ "$EDGE_AGREE" = yes ]
}

if edge_report; then
  echo "  the edge agrees: a browser on a cold cache is served this release"
else
  echo "  ^ the edge is serving something OTHER than this release at one of those URLs." >&2
  echo "    That is a CDN TTL, not a broken release — the origin above serves these bytes." >&2
  WANT=${EDGE_SETTLE_WAIT:-$EDGE_TTL}
  [ "$WANT" -ge "$EDGE_TTL" ] || echo "    (wait budget ${WANT}s < the host's max-age ${EDGE_TTL}s: shortened on purpose, FIDDY_EDGE_SETTLE_WAIT)" >&2
  echo "    waiting up to ${WANT}s for the edge to catch up (no rollback in the meantime)…" >&2
  WAITED=0
  while [ "$WAITED" -lt "$WANT" ]; do
    STEP=15
    [ $((WANT - WAITED)) -lt "$STEP" ] && STEP=$((WANT - WAITED))
    sleep "$STEP"
    WAITED=$((WAITED + STEP))
    if edge_report; then
      echo "  the edge caught up after ${WAITED}s — no rollback was needed" >&2
      break
    fi
  done
  if [ "$EDGE_AGREE" != yes ]; then
    echo "  the edge is still serving the old copy after ${WAITED}s. NOT rolling back: the origin serves this" >&2
    echo "  release's bytes (proved above), so the release stays cut over and the edge will catch up on its own." >&2
  fi
fi
echo
echo "  the bytes fiddy.fun's ORIGIN serves ARE the bytes this build produced"
set -e
echo
echo "release live: https://fiddy.fun  (release $SHA)"
echo "stage (this run's own): $STAGE"