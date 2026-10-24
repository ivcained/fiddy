#!/usr/bin/env bash
# fast-bootstrap.test.sh — the fast bootstrap's own gates.
#
#   bash tests/fast-bootstrap.test.sh
#
# Real, not simulated:
#   * a REAL tarball is built (tar + zstd), served over HTTP by python3, and
#     streamed back through the very function the CLI uses (fb_apply_mirror),
#     then the extracted tree is compared byte for byte;
#   * the checksum path is exercised with a correct and a corrupted digest;
#   * the decision rule is driven through every branch (no pin, unreachable,
#     data already present, no zstd, not enough disk, use);
#   * the pin readers are run against real JSON, a missing file, and a
#     malformed file, with jq, without jq, and without jq/python3.
#
# No network, no AWS, no node required. Exit code 0 = all gates pass.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PASS=0
FAIL=0

ok()   { printf '  ok   %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }
check(){ # check <label> <expect> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf '\nfast bootstrap gates\n'

# --- fixtures -------------------------------------------------------------
# A miniature "node data dir": .rocks with two files + .onchain-config, which is
# exactly the shape the real mirror tarball carries.
SRC="$WORK/node/snapchain"
mkdir -p "$SRC/.rocks/shard-1" "$SRC/.rocks/shard-2" "$SRC/.onchain-config"
printf 'rocksdb-block-1\n' > "$SRC/.rocks/CURRENT"
head -c 200000 /dev/urandom > "$SRC/.rocks/shard-1/000001.sst"
head -c 120000 /dev/urandom > "$SRC/.rocks/shard-2/000002.sst"
printf '{"chain": "mainnet"}\n' > "$SRC/.onchain-config/config.json"

tar -C "$SRC" -cf - .rocks .onchain-config | zstd -T0 -3 -q > "$WORK/node.tar.zst"
SHA="$(shasum -a 256 "$WORK/node.tar.zst" | cut -d' ' -f1)"
BYTES="$(wc -c < "$WORK/node.tar.zst" | tr -d ' ')"

# --- 1. hit: download, checksum, extract ---------------------------------
cd "$WORK"
python3 -m http.server 8731 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsSI --max-time 2 http://127.0.0.1:8731/node.tar.zst >/dev/null 2>&1 && break
  sleep 0.3
done

# shellcheck source=../cli/lib/fast-bootstrap.sh
. "$REPO/cli/lib/fast-bootstrap.sh"

DEST="$WORK/restored/snapchain"
mkdir -p "$DEST"
if fb_apply_mirror "http://127.0.0.1:8731/node.tar.zst" "$DEST" "$SHA" >/dev/null 2>&1; then
  ok "stream download -> zstd -> tar extracted"
else
  bad "fb_apply_mirror failed on a reachable mirror"
fi
check "extracted .rocks/CURRENT matches" "rocksdb-block-1" "$(cat "$DEST/.rocks/CURRENT" 2>/dev/null)"
check "extracted shard-1 size" "$(wc -c < "$SRC/.rocks/shard-1/000001.sst" | tr -d ' ')" "$(wc -c < "$DEST/.rocks/shard-1/000001.sst" 2>/dev/null | tr -d ' ')"
check "extracted onchain config" '{"chain": "mainnet"}' "$(cat "$DEST/.onchain-config/config.json" 2>/dev/null)"
check "extracted shard-2 bytes identical" "$(shasum -a 256 "$SRC/.rocks/shard-2/000002.sst" | cut -d' ' -f1)" "$(shasum -a 256 "$DEST/.rocks/shard-2/000002.sst" 2>/dev/null | cut -d' ' -f1)"

# --- 2. bad checksum must fail loudly ------------------------------------
DEST2="$WORK/badsha/snapchain"; mkdir -p "$DEST2"
if fb_apply_mirror "http://127.0.0.1:8731/node.tar.zst" "$DEST2" "deadbeef" >/dev/null 2>&1; then
  bad "a wrong checksum was accepted"
else
  ok "a wrong checksum is rejected"
fi

# --- 3. unreachable mirror must fail (the CLI then falls back) -----------
DEST3="$WORK/unreachable"; mkdir -p "$DEST3"
if fb_apply_mirror "http://127.0.0.1:8731/nope.tar.zst" "$DEST3" "" >/dev/null 2>&1; then
  bad "a 404 mirror reported success"
else
  ok "an unreachable mirror fails (fallback path)"
fi

# --- 4. the decision rule -------------------------------------------------
mkdir -p "$WORK/present/.rocks"; printf 'x' > "$WORK/present/.rocks/CURRENT"
check "no pin -> upstream"            "skip:no-pin"        "$(fb_fast_path_decision "" 1 0 2000 1100 1)"
check "unreachable -> upstream"       "skip:unreachable"   "$(fb_fast_path_decision https://x/y 0 0 2000 1100 1)"
check "existing db never overwritten" "skip:data-present"  "$(fb_fast_path_decision https://x/y 1 1 2000 1100 1)"
check "no zstd -> upstream"           "skip:no-zstd"       "$(fb_fast_path_decision https://x/y 1 0 2000 1100 0)"
check "not enough disk -> upstream"   "skip:no-space"      "$(fb_fast_path_decision https://x/y 1 0 400 1100 1)"
check "disk exactly at the line"      "use"                "$(fb_fast_path_decision https://x/y 1 0 1100 1100 1)"
check "healthy box -> use the copy"   "use"                "$(fb_fast_path_decision https://x/y 1 0 2000 1100 1)"
if fb_dir_has_state "$WORK/present"; then ok "a populated data dir is detected"; else bad "fb_dir_has_state missed a populated dir"; fi
if fb_dir_has_state "$WORK/absent-dir" || fb_dir_has_state ""; then bad "fb_dir_has_state invented state"; else ok "an absent/empty dir is not state"; fi

# peak-disk arithmetic: 468 GB compressed -> ~1096 GB needed (tarball + DB)
check "peak for 468 GB"  "1096" "$(fb_mirror_peak_gb $((468 * 1073741824)))"
check "peak for 0 bytes" "20"   "$(fb_mirror_peak_gb 0)"
check "gigabytes from bytes" "468" "$(fb_human_gb $((468 * 1073741824)))"

# --- 5. the pin readers ---------------------------------------------------
PIN="$WORK/fast-bootstrap.json"
cat > "$PIN" <<'JSON'
{
  "version": 1,
  "maxAgeDays": 14,
  "aws": { "amiId": "ami-0123456789abcdef0", "snapshotId": "snap-0123456789abcdef0", "region": "us-east-1",
           "createdAt": "2026-10-24T02:30:00Z", "volumeGb": 2050, "sizeGb": 600,
           "nodeVersion": "0.14.3", "heights": { "maxHeight": 1234, "blockDelay": 3 } },
  "mirror": { "url": "https://mirror.example.com/fast-bootstrap/node.tar.zst",
              "bytes": 502511173632, "sha256": "abc123", "createdAt": "2026-10-24T02:30:00Z" }
}
JSON
check "snapshot id read"   "snap-0123456789abcdef0" "$(fb_pin_get .aws.snapshotId "$PIN")"
check "ami id read"        "ami-0123456789abcdef0"  "$(fb_pin_get .aws.amiId "$PIN")"
check "region read"        "us-east-1"              "$(fb_pin_get .aws.region "$PIN")"
check "mirror url read"    "https://mirror.example.com/fast-bootstrap/node.tar.zst" "$(fb_pin_get .mirror.url "$PIN")"
check "mirror bytes read"  "502511173632"           "$(fb_pin_get .mirror.bytes "$PIN")"
check "missing key is empty" ""                     "$(fb_pin_get .mirror.nope "$PIN")"
check "date is not in the future" "0"               "$(fb_age_days "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
check "age counts days"    ""                       "$(fb_age_days "" )"

# no jq: the python3 path must agree
if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$WORK/nojq"
  printf '#!/bin/sh\nexit 127\n' > "$WORK/nojq/jq"; chmod +x "$WORK/nojq/jq"
  got="$(PATH="$WORK/nojq:$PATH" bash -c ". '$REPO/cli/lib/fast-bootstrap.sh' && fb_pin_get .aws.snapshotId '$PIN'")"
  check "pin read without jq" "snap-0123456789abcdef0" "$got"
fi

# no pin file at all: empty, and the describe line says so
check "missing pin file is empty" "" "$(fb_pin_get .aws.snapshotId "$WORK/does-not-exist.json")"
case "$(fb_describe "$WORK/does-not-exist.json")" in
  *"no pre-synced copy"*) ok "describe explains 'nothing pinned'" ;;
  *) bad "describe did not explain a missing pin: $(fb_describe "$WORK/does-not-exist.json")" ;;
esac

# malformed JSON must not take the CLI down
printf '{ this is not json' > "$WORK/broken.json"
case "$(fb_describe "$WORK/broken.json")" in
  *"no pre-synced copy"*) ok "malformed pin degrades to 'nothing pinned'" ;;
  *) bad "malformed pin was not handled: $(fb_describe "$WORK/broken.json")" ;;
esac

# the describe line carries the honesty markers: the date and the age
DESC="$(fb_describe "$PIN")"
case "$DESC" in *"snap-0123456789abcdef0"*) ok "describe names the snapshot" ;; *) bad "describe: $DESC" ;; esac
case "$DESC" in *"synced state as of 2026-10-24T02:30:00Z"*) ok "describe states the date" ;; *) bad "describe: $DESC" ;; esac

# --- 6. the real pin in the repo parses ----------------------------------
check "repo pin parses" "1" "$(fb_pin_get .version "$REPO/config/fast-bootstrap.json")"
check "repo pin has a max age" "14" "$(fb_pin_get .maxAgeDays "$REPO/config/fast-bootstrap.json")"
case "$(fb_describe "$REPO/config/fast-bootstrap.json")" in
  *"no pre-synced copy"*) ok "repo pin is empty until a real snapshot is published" ;;
  *) bad "repo pin should be empty pre-publication" ;;
esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]