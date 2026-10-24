# shellcheck shell=bash
# fiddy networks — the two networks Fiddy can point at, and what is actually
# known about each.
#
# The rule this file exists to enforce: a network is only offered where the
# thing it needs really works. Reads are measurable (a node answers /v1/info or
# it does not); a self-hosted install is only offered when following the
# upstream instructions produces a node that follows the chain. Hypersnap's
# published install does not, so `fiddy node up --network hypersnap` prints
# what is known and stops. Nothing here is a stub: every claim carries the
# command that measured it.
#
# Measured 2026-10-24 (see docs/NETWORK-CHOICE.md for the full log):
#   * https://haatz.quilibrium.com/v1/info → 200, version 0.13.5,
#     914,322,172 messages, 2 shards (heights 48,822,452 / 49,477,354 /
#     49,328,400). This is the public Hypersnap node the client reads today.
#   * https://snapchain-api.neynar.com/v1/info and https://hub-api.neynar.com/
#     v1/info → 402 "X-PAYMENT header or API key required". No public Snapchain
#     node answers a stranger without a paid key.
#   * https://raw.githubusercontent.com/farcasterorg/hypersnap/@latest/
#     validators.toml → 404, and the @latest installer does not mount it.
#   * validators.toml on the main branch ends at effective_at = 39_798_000
#     while the live network is at 49.5M — before the last validator rotation.

FIDDY_DEFAULT_NETWORK="snapchain"

network_is_known() { # network_is_known <name>
  case "${1:-}" in
    snapchain|hypersnap) return 0 ;;
    *) return 1 ;;
  esac
}

network_require_known() { # network_require_known <name>
  network_is_known "${1:-}" || die "unknown network: ${1:-<empty>} — fiddy knows: snapchain, hypersnap"
}

network_plain_name() { # the name a person reads
  case "$1" in
    snapchain) printf 'Snapchain (Farcaster)' ;;
    hypersnap) printf 'Hypersnap' ;;
  esac
}

network_one_line() { # what it is, in one sentence, no jargon
  case "$1" in
    snapchain)
      printf "Farcaster's own network — the one every account, cast and follow lives on." ;;
    hypersnap)
      printf "An independent parallel network built by the Quilibrium community — same kind of social data, different plumbing and different economics." ;;
  esac
}

# Where reads for this network come from, and what measured that.
network_read_route() {
  case "$1" in
    snapchain)
      printf 'your own Snapchain read node (fiddy node up --network snapchain) or a hosted key you pay for; no public Snapchain node answers a stranger — measured 402 without a payment header at snapchain-api.neynar.com and hub-api.neynar.com' ;;
    hypersnap)
      printf 'the public Hypersnap node https://haatz.quilibrium.com — measured 200 with real shard info on 2026-10-24' ;;
  esac
}

network_install_supported() { # can fiddy install this network unattended, reproducibly?
  case "$1" in
    snapchain) return 0 ;;
    *) return 1 ;;
  esac
}

# --- the honest Hypersnap report ------------------------------------------
# Printed when someone asks fiddy to install a network fiddy will not install.
# Everything in it was checked on 2026-10-24; the sources are named so the
# reader can re-check them rather than trust this text.

hypersnap_install_report() {
  step "Hypersnap — what is known (checked 2026-10-24)"
  cat <<'EOF'
  The network is real and running, and upstream publishes an install path:

    curl -sSL https://raw.githubusercontent.com/farcasterorg/hypersnap/refs/heads/main/scripts/hypersnap-bootstrap.sh | bash
      → writes ~/hypersnap/hypersnap.sh, then runs  ./hypersnap.sh upgrade
      → docker compose, image farcasterorg/hypersnap:latest
      → HTTP :3381 · gossip :3382/udp · gRPC :3383
      → same host as a Snapchain node: 16 GB RAM, 4 vCPU, 1.5 TB free disk

  What that install leaves you with, measured today:

    * The default (stable) channel installs from GitHub's "@latest" tag, which
      is the v0.11.8 release of 2026-05-07 — and that copy neither fetches nor
      mounts a validator list at all:
          curl -sSL .../@latest/scripts/hypersnap.sh   → 200 (May-era script)
          curl -sSL .../@latest/validators.toml        → 404
    * The main-branch installer does fetch validators.toml, but the newest entry
      in it takes effect at block 39_798_000:
          effective_at = 39_180_000 (shard 0)
          effective_at = 39_624_000 (shard 0)
          effective_at = 39_798_000 (shard 1)
      The live network is at 48,822,452 / 49,477,354 / 49,328,400 — the
      validator set has rotated since, and upstream's published file does not
      carry the new keys.
    * Either way the node answers /v1/info and then stops following the chain:
      it drops decided blocks with "Block contained signatures from unexpected
      signers". Upstream issue farcasterorg/hypersnap#41 is open, two
      independent operators reproduced it, and the repair that worked for them
      was to replace ~/hypersnap/validators.toml with the validator list from
      the OTHER project (farcasterxyz/snapchain), which already carries the
      three newer rotations.

  So: a fresh install is not a working node — it is a node that will report
  itself healthy while falling behind, which is worse than no node. Fiddy will
  not install one and call it done.

  What works today:

    * Reading Hypersnap, right now, with no install: the public node
      https://haatz.quilibrium.com (the one Fiddy's client reads by default).
        fiddy client up --network hypersnap

  What would change this verdict:

    * validators.toml on upstream main updated with the missing rotations (or a
      node that syncs validator sets from the on-chain registry at startup —
      the fix upstream discusses in that same issue).
    * Then: fiddy node up --network hypersnap, re-run.
EOF
}

hypersnap_refuse() {
  warn "fiddy does not install a Hypersnap node: the published install does not produce a node that follows the chain."
  log "To read Hypersnap today, point the client at the public node instead:"
  log "  fiddy client up --network hypersnap"
  log "Details of upstream's install, the stall, and the repair: docs/NETWORK-CHOICE.md"
  exit 1
}