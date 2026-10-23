#!/bin/bash
# Deploy `site/` to /var/www/fiddy-client/ — the /client microsite and the
# "Deploy a Node" mini app that launches from it.
#
# WHY THIS EXISTS
#
# `/client/` is not part of the client release (`scripts/release-client.sh` ships
# `releases/<sha>/web/`, and docs/CLIENT-RELEASE.md lists `/client`, `/FSSC/` and
# `/start` as "elsewhere, untouched"). Its deploy was a one-line `ssh` pipe in
# docs/CLIENT-MICROSITE-HOSTING.md — no gate, no served check, and nothing that
# could tell a good upload from a bad one. Measured 2026-10-22 (card t_5890479d):
# the mini app's `splashImageUrl` had been shipping a 512x512 picture, on a cream
# ground the page does not declare, its drawing 28px right of centre, and the
# drawing was the SIBLING FSSC app's judge-baby rather than Fiddy's mark — for as
# long as the file existed, because nothing ever looked inside it.
#
# The ritual, in order:
#
#   1. a FROZEN tree at the sha under deploy (`git archive`) — the microsite's
#      own rule already was "pin the content hash, not the branch";
#   2. a LOCAL gate over that tree (`scripts/check-microsite-assets.mjs`): every
#      page's `fc:miniapp` must name pictures this tree really carries, at the
#      sizes the spec asks, with the splash's ground matching the colour the
#      page declares and its drawing centred in its own square. A tree that
#      fails it is never uploaded;
#   3. upload by tar over ssh, ADDITIVE — `site/` is not the whole of
#      /var/www/fiddy-client/ (the page's own `fiddy-59s.mp4` and `.vtt` live
#      there and are not in this repo), so nothing is deleted;
#   4. a DISK gate on the box: sha256 of each uploaded file read back from the
#      VPS, compared with the frozen tree — not the upload command's exit code;
#   5. a SERVED gate: every file fetched back from the ORIGIN by IP
#      (`--resolve`, the CDN out of the path) into a mirror of the tree, byte-
#      compared with the frozen tree, and then the SAME gate run over that
#      mirror — so what is checked is what the host answers, including the
#      splash's pixels as served;
#   6. a REPORTED edge fetch (plain and cache-busted): a CDN's copy of a URL
#      whose name never changes is a TTL, not a broken deploy.
#
# nginx is not touched. The vhost's `/client` and `/client/` locations must
# already alias /var/www/fiddy-client (they do; step 5 fails loudly if not).
#
#   scripts/deploy-microsite.sh                 # deploy origin/main
#   scripts/deploy-microsite.sh <sha>           # deploy a commit
#   scripts/deploy-microsite.sh --gate-only     # gate the working tree, upload nothing
#
# The stage is a per-run directory ($FIDDY_MICROSITE_STAGE_ROOT), printed first
# and last, so two concurrent deploys never share a tree.
set -euo pipefail

HOST=${FIDDY_HOST:-root@100.111.203.78}
TARGET=${FIDDY_MICROSITE_ROOT:-/var/www/fiddy-client}
STAGE_ROOT=${FIDDY_MICROSITE_STAGE_ROOT:-$HOME/.hermes/cache/scratch}
ORIGIN_HOST=${FIDDY_ORIGIN_HOST:-fiddy.fun}
ORIGIN_IP=${FIDDY_ORIGIN_IP:-187.127.148.194}
# The one file in `site/` that is NOT deployed: the lint policy for the page
# (`site/ui-policy.json` is lintapple's input, not a served asset).
SKIP='./ui-policy.json'

REPO=$(cd "$(dirname "$0")/.." && pwd)
say() { printf '\n== %s\n' "$*"; }
ssh_() { ssh -o BatchMode=yes "$HOST" "$@"; }

GATE_ONLY=
if [ "${1:-}" = "--gate-only" ]; then
  GATE_ONLY=1
  SHA=$(git -C "$REPO" rev-parse HEAD)
else
  SHA=${1:-$(git -C "$REPO" rev-parse origin/main)}
fi
git -C "$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "no such commit: $SHA" >&2; exit 1; }
FULL_SHA=$(git -C "$REPO" rev-parse "$SHA^{commit}")
SHORT=${FULL_SHA:0:9}

mkdir -p "$STAGE_ROOT"
STAGE=$(mktemp -d "$STAGE_ROOT/fiddy-microsite-$SHORT.XXXXXX")
cleanup() { [ -n "${KEEP_STAGE:-}" ] || rm -rf "$STAGE"; }
trap cleanup EXIT
printf '{"sha":"%s","short":"%s","pid":%s,"host":"%s","started":"%s"}\n' \
  "$FULL_SHA" "$SHORT" "$$" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/run.json"

say "deploy $FULL_SHA ($(git -C "$REPO" log -1 --format=%s "$FULL_SHA"))"
say "stage (per run): $STAGE"
say "1/5 frozen tree at $SHORT"
git -C "$REPO" archive "$FULL_SHA" site | tar -x -C "$STAGE"
[ -f "$STAGE/site/deploy/index.html" ] || { echo "the tree has no site/deploy/index.html" >&2; exit 1; }

say "2/5 local gate over the frozen tree"
node "$REPO/scripts/check-microsite-assets.mjs" "$STAGE/site"

if [ -n "$GATE_ONLY" ]; then
  say "gate only — nothing uploaded"
  exit 0
fi

say "3/5 upload to $HOST:$TARGET (additive: site/ is not the whole directory)"
ssh_ "mkdir -p $TARGET"
# `--no-xattrs`: macOS stamps `com.apple.provenance` on the files it just wrote,
# and without this bsdtar carries each one as a `LIBARCHIVE.xattr` pax header,
# which makes the remote GNU tar print a warning per entry. Step 4 must stay
# readable — a real tar failure prints the same way.
tar czf - --no-xattrs -C "$STAGE/site" --exclude="$SKIP" . | ssh_ "tar xzf - -C $TARGET"
ssh_ "chmod -R a+rX $TARGET"

say "4/5 disk gate on the box: sha256 of every uploaded file, read back"
fail=0
count=0
while IFS= read -r -d '' file; do
  rel=${file#"$STAGE/site/"}
  [ "./$rel" = "$SKIP" ] && continue
  local_sha=$(shasum -a 256 "$file" | cut -d' ' -f1)
  # `-n`, because ssh reads its own stdin: without it the first call eats the
  # rest of the file list and this gate silently checks ONE file (measured while
  # writing this script — it reported a single row and looked like a pass).
  remote_sha=$(ssh -n -o BatchMode=yes "$HOST" "sha256sum '$TARGET/$rel' | cut -d' ' -f1")
  count=$((count + 1))
  if [ "$local_sha" = "$remote_sha" ]; then
    printf '   %s  %s  %s\n' "${local_sha:0:12}" "$(du -h "$file" | cut -f1)" "$rel"
  else
    printf '   MISMATCH %s: box has %s\n' "$rel" "${remote_sha:0:12}" >&2
    fail=1
  fi
done < <(find "$STAGE/site" -type f -print0 | sort -z)
[ "$count" -gt 0 ] || { echo "no file was checked — the tree is empty" >&2; exit 1; }
echo "   $count files, byte-for-byte the frozen tree"
[ "$fail" = 0 ] || { echo "the box does not hold the frozen tree — upload incomplete" >&2; exit 1; }

say "5/5 served gate against the ORIGIN ($ORIGIN_IP, no cache in the path)"
mkdir -p "$STAGE/live"
while IFS= read -r -d '' file; do
  rel=${file#"$STAGE/site/"}
  [ "./$rel" = "$SKIP" ] && continue
  # The URL a reader asks for: `/client/` for the root page, a directory URL for
  # a page inside a directory, the file's own path for anything else — the same
  # mapping nginx's `try_files $uri $uri/` answers.
  case "$rel" in
    index.html) url="https://$ORIGIN_HOST/client/" ;;
    */index.html) url="https://$ORIGIN_HOST/client/${rel%index.html}" ;;
    *) url="https://$ORIGIN_HOST/client/$rel" ;;
  esac
  mkdir -p "$(dirname "$STAGE/live/$rel")"
  code=$(curl -sk --resolve "$ORIGIN_HOST:443:$ORIGIN_IP" -o "$STAGE/live/$rel" -w '%{http_code}' "$url" < /dev/null)
  [ "$code" = 200 ] || { echo "the origin answers $code for $url" >&2; exit 1; }
  if cmp -s "$file" "$STAGE/live/$rel"; then
    printf '   origin  %s  %s  %s\n' "$code" "$(shasum -a 256 "$STAGE/live/$rel" | cut -c1-12)" "$url"
  else
    printf '   DIFFERS from the frozen tree: %s\n' "$url" >&2
    exit 1
  fi
done < <(find "$STAGE/site" -type f -print0 | sort -z)
echo "   every served byte is the frozen tree's byte"

# The gate, run over what the host ANSWERS: the live page's own declarations
# against the live splash's own pixels. This is the check the old pipe never had.
node "$REPO/scripts/check-microsite-assets.mjs" "$STAGE/live"

# The splash's size, read from the live PNG's own IHDR rather than from a header
# nobody verifies, and the same bytes measured through the CDN (cache-busted, so
# no earlier copy can answer) and plainly (reported, never judged — the edge's
# copy of a URL whose name never changes is a TTL).
say "edge (reported): the same bytes through the CDN"
live_splash="$STAGE/live/assets/fiddy-splash.png"
size=$(node -e "const b=require('fs').readFileSync('$live_splash');console.log(b.readUInt32BE(16)+'x'+b.readUInt32BE(20))")
echo "   this PNG's own header says $size ($(wc -c < "$live_splash" | tr -d ' ') bytes)"
for label in "cb=$(date +%s)" ""; do
  code=$(curl -s -o "$STAGE/edge.png" -w '%{http_code}' "https://$ORIGIN_HOST/client/assets/fiddy-splash.png?$label")
  printf '   edge %s %s  sha %s\n' "$code" "${label:-plain}" "$(shasum -a 256 "$STAGE/edge.png" | cut -c1-12)"
done

say "deployed $FULL_SHA to $TARGET"
echo "   stage: $STAGE"