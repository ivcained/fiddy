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
#   8. a SERVED gate: fetch the bundle through https://fiddy.fun and grep THAT.
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
  "$SHA" "$NODE_URL" "$MEDIA_URL" > "$WEB/release.json"

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

say "8/8 served gate: the same two strings, fetched through https://fiddy.fun"
set +e
# Download first, grep second: a pipe with `grep -q` closes early, and with
# `set -o pipefail` that SIGPIPE reads as a failed check even when the string is
# there.
curl -fsS https://fiddy.fun/ -o "$STAGE/served-index.html"
# The served shell is what the browser runs, so check THAT file and not the one
# the build produced: an inline <script> or an inline on*= handler in it is
# refused by the host's script-src 'self'.
node "$CHECK_SHELL" "$STAGE/served-index.html" \
  || { rollback_on_failure; exit 1; }
ASSET=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$STAGE/served-index.html" | head -1)
echo "  index.html names $ASSET"
curl -fsS "https://fiddy.fun$ASSET" -o "$STAGE/served-$SHORT.js"
grep -q "$GATE_ADAPTER" "$STAGE/served-$SHORT.js" || { rollback_on_failure; exit 1; }
grep -q "$GATE_MEDIA" "$STAGE/served-$SHORT.js" || { rollback_on_failure; exit 1; }
grep -q "$NODE_URL" "$STAGE/served-$SHORT.js" || { rollback_on_failure; exit 1; }
# Belt and braces for Together: the route literal and the absent laptop fallback
# are asserted over EVERY built asset in step 3 and over the extracted tree in
# step 6, and the `cmp` below ties the served entry chunk to those same bytes.
# Checking the served chunk too costs one grep and catches a host serving a
# different index than the one we just published.
if grep -q "$GATE_TOGETHER_FALLBACK" "$STAGE/served-$SHORT.js"; then
  echo "REFUSING: the served bundle carries $GATE_TOGETHER_FALLBACK" >&2
  rollback_on_failure; exit 1
fi
echo "  served bundle: $(wc -c < "$STAGE/served-$SHORT.js") bytes, sha256 $(shasum -a 256 "$STAGE/served-$SHORT.js" | cut -c1-16)…"
echo "  built bundle:  $(wc -c < "$STAGE/base/apps/farcaster-web/dist$ASSET") bytes, sha256 $(shasum -a 256 "$STAGE/base/apps/farcaster-web/dist$ASSET" | cut -c1-16)…"
cmp -s "$STAGE/served-$SHORT.js" "$STAGE/base/apps/farcaster-web/dist$ASSET" || { rollback_on_failure; exit 1; }
curl -fsS https://fiddy.fun/release.json
echo
echo "  the bytes fiddy.fun serves ARE the bytes this build produced"
set -e
echo
echo "release live: https://fiddy.fun  (release $SHA)"
echo "stage (this run's own): $STAGE"