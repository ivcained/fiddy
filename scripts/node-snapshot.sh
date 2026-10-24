#!/usr/bin/env bash
# fiddy node snapshot — publish a pre-synced copy of a Snapchain read node.
#
#   scripts/node-snapshot.sh publish  --ssh ubuntu@HOST --volume vol-xxxx
#   scripts/node-snapshot.sh status   [--ssh ubuntu@HOST] [--volume vol-xxxx]
#   scripts/node-snapshot.sh prune-old --keep 2
#
# publish, in order:
#   1. read the node's sync state over SSH (refuses while it is still loading
#      chunks from upstream, unless you pass --allow-unsynced)
#   2. stop the node container cleanly (RocksDB closes; not a SIGKILL race) and
#      sync the filesystem
#   3. EBS snapshot of the node's volume, wait for it, then make it PUBLIC
#   4. optionally tar+zstd the data dir and stream it to object storage (the
#      mirror path, for every host that is not AWS)
#   5. write config/fast-bootstrap.json (the pin: id + date + sizes)
#   6. restart the node so it keeps syncing
#
# Reproduce-from-scratch proof: run this against any clean, fully synced node.
# Nothing about this script is special to our box; that is the point.
#
# Cost: a snapshot of the ~600 GB a synced mainnet node occupies is ~$30/mo at
# list ($0.05/GB-mo), which `status` prints honestly. `prune-old` keeps one.
#
# Secrets never touch the command line: object-storage keys are written to a
# mode-600 rclone config on the uploader host and referenced by remote name.

set -uo pipefail

FB_REPO="${FIDDY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../cli/lib/fast-bootstrap.sh
. "$FB_REPO/cli/lib/fast-bootstrap.sh"

REGION="${FIDDY_AWS_REGION:-us-east-1}"
AWS_PROFILE_ARG=()
SSH_TARGET="${FIDDY_TARGET:-}"
SSH_KEY="${FIDDY_SSH_KEY:-}"
VOLUME_ID="${FIDDY_AWS_VOLUME_ID:-}"
DATA_DIR="${FIDDY_NODE_DATA_DIR:-/home/ubuntu/snapchain}"
PIN_FILE="$(fb_pin_path "$FB_REPO")"
JSON_OUT=""
DRY_RUN=0
ALLOW_UNSYNCED=0
WAIT_FOR_SYNC=0
NO_QUIESCE=0
WRITE_PIN=1
KEEP=2
PUBLIC=1
MAX_WAIT_SNAPSHOT_S="${FB_MAX_WAIT_SNAPSHOT_S:-7200}"
MIRROR_MODE=auto   # auto | on | off
SHARE_WITH="${FIDDY_AMI_SHARE_WITH:-}"
ami_snapshot_hint=""
RCLONE_CONF_REMOTE="fiddy"

log()  { printf '▸ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die()  { printf '! %s\n' "$*" >&2; exit 1; }
dim()  { printf '  %s\n' "$*"; }

usage() {
  cat <<'EOF'
node-snapshot.sh — publish the pre-synced node state everyone bootstraps from.

  publish [options]      take the snapshot + AMI, publish both, update the pin
  register-ami           register (and publish) an AMI from an existing public
                         snapshot — the step publish runs internally, exposed
                         because that is how a launchable artifact is made
  status  [options]      what is running, what is pinned, what it costs
  prune-old [--keep N]   deregister + delete older fiddy artifacts (keep 2)

options common to publish/status:
  --ssh user@host        the node's host (default: $FIDDY_TARGET)
  --ssh-key path         private key for that host (default: $FIDDY_SSH_KEY)
  --volume vol-xxxxxxxx  the EBS volume holding the node data (required for
                         publish; status can read it from the pin)
  --region REGION        AWS region (default: $FIDDY_AWS_REGION or us-east-1)
  --profile NAME         AWS profile (default: honour $AWS_PROFILE)
  --data-dir PATH        data dir on the host (default: ~/snapchain)
  --pin PATH             pin file to read/write (default: config/fast-bootstrap.json)

publish only:
  --wait-for-sync        wait for the node to finish loading chunks first
  --allow-unsynced       publish even if the node has not finished loading
  --no-quiesce           do not stop the container (NOT crash-consistent; only
                         for a node you know is idle)
  --mirror               force the tarball mirror upload
  --no-mirror            EBS snapshot only
  --no-public            leave the snapshot private
  --no-write-pin         do not touch config/fast-bootstrap.json
  --json PATH            write a machine-readable result
  --dry-run              print every step, change nothing

mirror (Path B) environment:
  FB_MIRROR_S3_BUCKET=name            bucket to upload into
  FB_MIRROR_KEY=path/in/bucket.tar.zst (default: fast-bootstrap/node-<date>.tar.zst)
  FB_MIRROR_PUBLIC_BASE=https://...    public base URL the pin advertises
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (Cloudflare R2)
  FB_MIRROR_S3_ENDPOINT/_ACCESS_KEY/_SECRET_KEY/_PROVIDER (any S3-compatible)
  FB_MIRROR_UPLOADER=remote|local     run the upload on the node (default) or here
EOF
}

# --- arg parsing ----------------------------------------------------------

parse_common() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --ssh) SSH_TARGET="${2:-}"; shift 2 ;;
      --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
      --volume) VOLUME_ID="${2:-}"; shift 2 ;;
      --region) REGION="${2:-}"; shift 2 ;;
      --profile) AWS_PROFILE_ARG=(--profile "${2:-}"); shift 2 ;;
      --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
      --pin) PIN_FILE="${2:-}"; shift 2 ;;
      *) printf '%s' "$1"; return 1 ;;
    esac
  done
  return 0
}

# --- ssh ------------------------------------------------------------------

ssh_opts() {
  FB_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new)
  if [ -n "$SSH_KEY" ]; then FB_SSH_OPTS=("${FB_SSH_OPTS[@]}" -i "$SSH_KEY"); fi
}

host_run() { # host_run <command...>
  [ -n "$SSH_TARGET" ] || die "no host: pass --ssh user@host (or set FIDDY_TARGET)"
  ssh_opts
  ssh "${FB_SSH_OPTS[@]}" "$SSH_TARGET" "$@"
}

aws_cli() {
  command -v aws >/dev/null 2>&1 || die "aws CLI not found (the publisher needs it; CloudShell works too)"
  aws ${AWS_PROFILE_ARG[@]+"${AWS_PROFILE_ARG[@]}"} --region "$REGION" "$@"
}

# --- node state -----------------------------------------------------------

FB_N_HEIGHT=""; FB_N_DELAY=""; FB_N_VERSION=""; FB_N_ANSWER=0
FB_N_LOADING=0; FB_N_DATA_GB=0; FB_N_SHARDS=""

fb_read_node_state() {
  local out
  FB_N_ANSWER=0; FB_N_LOADING=0
  out="$(host_run 'curl -fsS --max-time 8 http://127.0.0.1:3381/v1/info' 2>/dev/null || true)"
  if [ -n "$out" ]; then
    FB_N_ANSWER=1
    if command -v jq >/dev/null 2>&1; then
      FB_N_HEIGHT="$(printf '%s' "$out" | jq -r '.maxHeight // 0')"
      FB_N_DELAY="$(printf '%s' "$out" | jq -r '.blockDelay // 0')"
      FB_N_VERSION="$(printf '%s' "$out" | jq -r '(.version.string // .version // "?")')"
      FB_N_SHARDS="$(printf '%s' "$out" | jq -c '{shardInfo: (.shardInfo // {}), maxHeight: (.maxHeight // 0), blockDelay: (.blockDelay // 0)}')"
    else
      FB_N_HEIGHT="$(printf '%s' "$out" | sed -n 's/.*"maxHeight"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
      FB_N_DELAY="$(printf '%s' "$out" | sed -n 's/.*"blockDelay"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
      FB_N_SHARDS="{}"
    fi
  fi
  # A node that is still assembling/unpacking chunks has .rocks.snapshot/shard-*
  # on disk and no HTTP API. Both signals matter: the API alone can answer for a
  # moment after the load with pruning/cleanup still running.
  local probe
  probe="$(host_run "du -sm '$DATA_DIR/.rocks' 2>/dev/null | cut -f1; find '$DATA_DIR/.rocks.snapshot' -name 'chunk_*.bin' 2>/dev/null | wc -l" 2>/dev/null || true)"
  FB_N_DATA_GB="$(printf '%s' "$probe" | sed -n '1p' | tr -d '[:space:]')"
  local chunks
  chunks="$(printf '%s' "$probe" | sed -n '2p' | tr -d '[:space:]')"
  [ -n "$chunks" ] && [ "$chunks" != "0" ] && FB_N_LOADING=1
  case "$FB_N_DATA_GB" in ''|*[!0-9]*) FB_N_DATA_GB=0 ;; esac
  return 0
}

fb_node_is_synced() {
  [ "$FB_N_ANSWER" = 1 ] || return 1
  [ "$FB_N_LOADING" = 0 ] || return 1
  [ "${FB_N_DATA_GB:-0}" -lt 50 ] && return 1
  # blockDelay is seconds behind the tip; a healthy read node sits in the low
  # seconds. Allow a generous window so a briefly busy node is not rejected.
  [ -n "$FB_N_DELAY" ] || return 1
  [ "$FB_N_DELAY" -le 300 ] 2>/dev/null || return 1
  return 0
}

fb_node_state_line() {
  printf 'node: api=%s data=%sGB loading_chunks=%s height=%s blockDelay=%ss version=%s\n' \
    "$([ "$FB_N_ANSWER" = 1 ] && echo yes || echo no)" \
    "${FB_N_DATA_GB:-0}" \
    "$([ "$FB_N_LOADING" = 1 ] && echo yes || echo no)" \
    "${FB_N_HEIGHT:-?}" "${FB_N_DELAY:-?}" "${FB_N_VERSION:-?}"
}

# --- quiesce / resume -----------------------------------------------------

fb_quiesce() {
  log "stopping the node container cleanly (RocksDB must close, not be killed)"
  host_run "cd '$DATA_DIR' && sudo -n docker compose stop -t 180 snapchain 2>/dev/null || docker compose stop -t 180 snapchain" \
    || die "could not stop the node container on $SSH_TARGET"
  # Confirm it is gone before trusting the snapshot's consistency.
  local i
  for i in 1 2 3 4 5 6; do
    if host_run "docker ps --filter name=snapchain-snapchain-1 --format '{{.Names}}' | grep -q . && exit 1 || exit 0" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  host_run "docker ps --filter name=snapchain-snapchain-1 --format '{{.Names}}'" | grep -q . \
    && die "the node container is still running; refusing to snapshot an open database"
  host_run 'sync' || true
  ok "container stopped, filesystem synced (consistent RocksDB on disk)"
}

fb_resume() {
  log "restarting the node (it keeps syncing from the snapshot's tip)"
  host_run "cd '$DATA_DIR' && (sudo -n docker compose up -d snapchain statsd 2>/dev/null || docker compose up -d snapchain statsd)" \
    || warn "could not restart the node container on $SSH_TARGET: start it by hand (fiddy node start)"
}

# --- EBS ------------------------------------------------------------------

fb_create_snapshot() { # → FB_SNAPSHOT_ID
  local date_tag="$1"
  FB_SNAPSHOT_ID="$(aws_cli ec2 create-snapshot \
    --volume-id "$VOLUME_ID" \
    --description "fiddy fast bootstrap: synced Snapchain mainnet read node ($date_tag)" \
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=project,Value=fiddy},{Key=Name,Value=fiddy-fast-bootstrap},{Key=fiddy:created,Value=$date_tag}]" \
    --query 'SnapshotId' --output text)"
  [ -n "$FB_SNAPSHOT_ID" ] && [ "$FB_SNAPSHOT_ID" != "None" ] || die "create-snapshot returned nothing for $VOLUME_ID"
  ok "snapshot $FB_SNAPSHOT_ID creating"
}

fb_wait_snapshot() { # fb_wait_snapshot <id> → 0 when completed
  local id="$1" waited=0 state progress
  while [ "$waited" -lt "$MAX_WAIT_SNAPSHOT_S" ]; do
    state="$(aws_cli ec2 describe-snapshots --snapshot-ids "$id" --query 'Snapshots[0].State' --output text 2>/dev/null || true)"
    progress="$(aws_cli ec2 describe-snapshots --snapshot-ids "$id" --query 'Snapshots[0].Progress' --output text 2>/dev/null || true)"
    printf '\r  %s %s (%ss)' "${state:-?}" "${progress:-?}" "$waited"
    case "$state" in
      completed) printf '\n'; return 0 ;;
      error)     printf '\n'; return 1 ;;
    esac
    sleep 20; waited=$((waited + 20))
  done
  printf '\n'
  return 1
}

fb_make_public() { # fb_make_public <id>
  local id="$1" perm
  aws_cli ec2 modify-snapshot-attribute --snapshot-id "$id" \
    --attribute createVolumePermission --operation-type add --group-names all >/dev/null
  perm="$(aws_cli ec2 describe-snapshot-attribute --snapshot-id "$id" \
    --attribute createVolumePermission --query 'CreateVolumePermissions' --output json)"
  case "$perm" in
    *'"Group": "all"'*|*'"Group":"all"'*) ok "snapshot $id is PUBLIC (anyone can launch from it)" ;;
    *) die "snapshot $id was not made public: $perm" ;;
  esac
}

fb_snapshot_size_gb() { # fb_snapshot_size_gb <id>
  aws_cli ec2 describe-snapshots --snapshot-ids "$1" --query 'Snapshots[0].VolumeSize' --output text 2>/dev/null || echo 0
}

# EC2 will not let you point a launch at a bare snapshot ("snapshotId cannot be
# modified on root device"): the root device of an AMI is fixed at registration
# time. So the published artifact is an AMI registered FROM the public snapshot,
# itself made public, and the pin carries its id. The snapshot stays pinned too:
# it is what the AMI is made of, and it is what `prune-old` cleans up behind it.
fb_register_ami() { # fb_register_ami <snapshot-id> <volume-gb> <date-tag> → FB_AMI_ID
  local snap="$1" vol_gb="$2" date_tag="$3" boot=""
  # Inherit the boot mode of the Ubuntu images this snapshot came from; guessing
  # wrong produces an instance that never boots.
  boot="$(aws_cli ec2 describe-images --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
    --query 'sort_by(Images,&CreationDate)[-1].BootMode' --output text 2>/dev/null || true)"
  case "$boot" in
    uefi-preferred|uefi|legacy-bios) ;;
    *) boot="uefi-preferred" ;;
  esac
  # AMI names are unique per account: reuse an existing one built from this very
  # snapshot (a re-publish), and clear a stale one built from an older snapshot.
  local existing existing_snap
  existing="$(aws_cli ec2 describe-images --owners self \
    --filters "Name=name,Values=fiddy-fast-bootstrap-$date_tag" \
    --query 'Images[0].ImageId' --output text 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    existing_snap="$(aws_cli ec2 describe-images --image-ids "$existing" \
      --query 'Images[0].BlockDeviceMappings[0].Ebs.SnapshotId' --output text 2>/dev/null || true)"
    if [ "$existing_snap" = "$snap" ]; then
      FB_AMI_ID="$existing"
      ok "AMI $FB_AMI_ID already registered from $snap (reusing it)"
      return 0
    fi
    warn "AMI name fiddy-fast-bootstrap-$date_tag is taken by $existing (from $existing_snap); deregistering it"
    aws_cli ec2 deregister-image --image-id "$existing" >/dev/null 2>&1 || true
  fi
  FB_AMI_ID="$(aws_cli ec2 register-image \
    --name "fiddy-fast-bootstrap-$date_tag" \
    --description "fiddy fast bootstrap: synced Snapchain mainnet read node ($date_tag)" \
    --architecture x86_64 --root-device-name /dev/sda1 --virtualization-type hvm \
    --boot-mode "$boot" --ena-support --sriov-net-support simple \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={SnapshotId=$snap,VolumeSize=$vol_gb,VolumeType=gp3}" \
    --tag-specifications "ResourceType=image,Tags=[{Key=project,Value=fiddy},{Key=Name,Value=fiddy-fast-bootstrap},{Key=fiddy:snapshot,Value=$snap},{Key=fiddy:created,Value=$date_tag}]" \
    --query 'ImageId' --output text)"
  [ -n "$FB_AMI_ID" ] && [ "$FB_AMI_ID" != "None" ] \
    || die "register-image returned nothing for snapshot $snap"
  ok "AMI $FB_AMI_ID registered from $snap (boot mode $boot)"
}

# Publishing an AMI has two independent switches in front of it:
#   * the account setting `imageBlockPublicAccess` (ON by default: "block-new-
#     sharing"), which no IAM permission can override from a script
#   * per-account sharing, which always works
# so this reports what actually happened instead of assuming it worked. The
# snapshot is published separately and stays the universal artifact: any account
# can build a volume from a public snapshot even when it cannot launch our AMI.
fb_publish_ami() { # fb_publish_ami <ami-id> [share-with-csv]
  local ami="$1" share="${2:-}" perm out rc a adds="" had_e=0
  FB_AMI_PUBLIC=0
  if [ -n "$share" ]; then
    for a in $(printf '%s' "$share" | tr ',' ' '); do adds="$adds{UserId=$a},"; done
    adds="${adds%,}"
    if aws_cli ec2 modify-image-attribute --image-id "$ami" --launch-permission "Add=[$adds]" >/dev/null 2>&1; then
      ok "AMI $ami shared with: $share"
    else
      warn "could not share AMI $ami with $share"
    fi
  fi
  case "$-" in *e*) had_e=1 ;; esac
  set +e
  out="$(aws_cli ec2 modify-image-attribute --image-id "$ami" --launch-permission "Add=[{Group=all}]" 2>&1)"
  rc=$?
  [ "$had_e" = 1 ] && set -e || set +e
  if [ "$rc" != 0 ]; then
    case "$out" in
      *BlockPublicAccess*|*"block public access"*|*OperationNotPermitted*)
        warn "this account blocks public AMI sharing (imageBlockPublicAccess = block-new-sharing):"
        warn "  $out"
        dim "the SNAPSHOT is still published and public, which is the artifact any account can use:"
        dim "  aws ec2 create-volume --snapshot-id ${ami_snapshot_hint:-<snapshot-id>} --availability-zone <az>   (then attach it)"
        dim "and aws-deploy.sh does that automatically when the AMI is not launchable."
        dim "to make the AMI itself public you have two options, both deliberate:"
        dim "  1. share it with specific accounts:  publish --share-with 123456789012,210987654321"
        dim "  2. allow public AMIs account-wide:  aws ec2 disable-image-block-public-access --image-block-public-access-state unblocked"
        return 0 ;;
      *) die "could not share AMI $ami: $out" ;;
    esac
  fi
  perm="$(aws_cli ec2 describe-image-attribute --image-id "$ami" \
    --attribute launchPermission --query 'LaunchPermissions' --output json)"
  case "$perm" in
    *'"Group": "all"'*|*'"Group":"all"'*)
      FB_AMI_PUBLIC=1
      ok "AMI $ami is PUBLIC (any account can launch it)" ;;
    *) warn "AMI $ami is not public: $perm" ;;
  esac
}

fb_wait_ami() { # fb_wait_ami <ami-id> — registration is async
  local ami="$1" waited=0 state
  while [ "$waited" -lt 600 ]; do
    state="$(aws_cli ec2 describe-images --image-ids "$ami" --query 'Images[0].State' --output text 2>/dev/null || true)"
    [ "$state" = "available" ] && { ok "AMI $ami is available"; return 0; }
    sleep 10; waited=$((waited + 10))
  done
  warn "AMI $ami did not reach 'available' in 10 min (state: ${state:-unknown})"
  return 1
}

fb_volume_size_gb() { # fb_volume_size_gb <volume-id>
  aws_cli ec2 describe-volumes --volume-ids "$1" --query 'Volumes[0].Size' --output text 2>/dev/null || echo 0
}

fb_snapshot_stored_gb() { # fb_snapshot_stored_gb <id> — real incremental bytes when AWS reports them
  local bytes
  bytes="$(aws_cli ec2 describe-snapshots --snapshot-ids "$1" --query 'Snapshots[0].FullSnapshotSizeInBytes' --output text 2>/dev/null || true)"
  case "$bytes" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  echo $(( bytes / 1073741824 ))
}

# --- mirror (Path B) ------------------------------------------------------

FB_MIRROR_DEST=""; FB_MIRROR_PUBLIC_URL=""; FB_MIRROR_ACTUAL_BYTES=0; FB_MIRROR_SHA=""

fb_mirror_configured() {
  [ -n "${FB_MIRROR_S3_BUCKET:-}" ] || return 1
  if [ -n "${R2_ACCESS_KEY_ID:-}" ] || [ -n "${FB_MIRROR_S3_ACCESS_KEY:-}" ]; then return 0; fi
  return 1
}

fb_mirror_provider() { printf '%s' "${FB_MIRROR_S3_PROVIDER:-Cloudflare}"; }

fb_mirror_endpoint() {
  if [ -n "${FB_MIRROR_S3_ENDPOINT:-}" ]; then printf '%s' "$FB_MIRROR_S3_ENDPOINT"; return 0; fi
  [ -n "${R2_ACCOUNT_ID:-}" ] && printf 'https://%s.r2.cloudflarestorage.com' "$R2_ACCOUNT_ID"
}

fb_mirror_keys() {
  FB_MIRROR_ACCESS="${FB_MIRROR_S3_ACCESS_KEY:-${R2_ACCESS_KEY_ID:-}}"
  FB_MIRROR_SECRET="${FB_MIRROR_S3_SECRET_KEY:-${R2_SECRET_ACCESS_KEY:-}}"
}

# rclone connection string, no secrets in it: the named remote reads them from
# the mode-600 config file this writes on the uploader host.
fb_write_rclone_conf() { # fb_write_rclone_conf <conf-path>
  local conf="$1"
  fb_mirror_keys
  mkdir -p "$(dirname "$conf")"
  umask 077
  {
    printf '[%s]\n' "$RCLONE_CONF_REMOTE"
    printf 'type = s3\n'
    printf 'provider = %s\n' "$(fb_mirror_provider)"
    printf 'access_key_id = %s\n' "$FB_MIRROR_ACCESS"
    printf 'secret_access_key = %s\n' "$FB_MIRROR_SECRET"
    printf 'region = auto\n'
    local ep; ep="$(fb_mirror_endpoint)"
    [ -n "$ep" ] && printf 'endpoint = %s\n' "$ep"
    printf 'acl = private\n'
  } > "$conf"
  chmod 600 "$conf"
}

# The one pipeline both the remote and local uploader run, so a local test
# exercises exactly what production runs.
fb_mirror_pipeline_cmd() { # fb_mirror_pipeline_cmd <data-dir> <conf> <dest> <sha-file>
  local data="$1" conf="$2" dest="$3" sha_file="$4"
  printf "tar -C '%s' -cf - .rocks .onchain-config 2>/dev/null | zstd -T0 -%s -q | tee >(sha256sum | cut -d' ' -f1 > '%s') | rclone --config '%s' rcat --s3-no-check-bucket --stats=120s --stats-one-line '%s' 2>>'%s'" \
    "$data" "$FB_ZSTD_LEVEL" "$sha_file" "$conf" "$dest" "$sha_file.upload.log"
}

fb_mirror_publish() { # fb_mirror_publish <date-tag>
  local date_tag="$1"
  local remote_conf sha_file uploader
  FB_MIRROR_KEY="${FB_MIRROR_KEY:-fast-bootstrap/node-$date_tag.tar.zst}"
  FB_MIRROR_DEST="${RCLONE_CONF_REMOTE}:${FB_MIRROR_S3_BUCKET}/${FB_MIRROR_KEY}"
  uploader="${FB_MIRROR_UPLOADER:-remote}"
  remote_conf="/home/ubuntu/.config/rclone/fiddy.conf"
  sha_file="/tmp/fiddy-mirror-$date_tag.sha256"

  log "mirror: tar+zstd the data dir and stream it to $FB_MIRROR_DEST ($uploader uploader)"
  fb_mirror_keys
  [ -n "$FB_MIRROR_ACCESS" ] && [ -n "$FB_MIRROR_SECRET" ] \
    || die "mirror keys missing: set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY (or FB_MIRROR_S3_ACCESS_KEY/_SECRET_KEY)"
  if [ "$uploader" = "remote" ]; then
    [ -n "$SSH_TARGET" ] || die "--mirror needs --ssh user@host"
    local tmp_local; tmp_local="$(mktemp)"
    fb_write_rclone_conf "$tmp_local"
    host_run "mkdir -p ~/.config/rclone" || die "cannot create ~/.config/rclone on the node"
    host_run "command -v rclone >/dev/null 2>&1 || (curl -fsSL https://rclone.org/install.sh | sudo -n bash)" \
      || die "could not install rclone on $SSH_TARGET"
    ssh_opts
    scp -q "${FB_SSH_OPTS[@]}" "$tmp_local" "$SSH_TARGET:$remote_conf" || die "could not copy the rclone config"
    rm -f "$tmp_local"
    host_run "bash -c \"$(fb_mirror_pipeline_cmd "$DATA_DIR" "$remote_conf" "$FB_MIRROR_DEST" "$sha_file")\"" \
      || die "mirror upload failed on the node (see $FB_MIRROR_DEST.log there)"
    FB_MIRROR_SHA="$(host_run "cat '$sha_file'" 2>/dev/null | tr -d '[:space:]')"
    FB_MIRROR_ACTUAL_BYTES="$(host_run "rclone --config '$remote_conf' lsl '$FB_MIRROR_DEST' 2>/dev/null | awk '{print \$1}' | head -1" | tr -d '[:space:]')"
  else
    local conf; conf="$(mktemp -d)/rclone.conf"
    fb_write_rclone_conf "$conf"
    command -v rclone >/dev/null 2>&1 || die "rclone missing locally (brew install rclone)"
    bash -c "$(fb_mirror_pipeline_cmd "$DATA_DIR" "$conf" "$FB_MIRROR_DEST" "$sha_file")" \
      || die "mirror upload failed locally"
    FB_MIRROR_SHA="$(cat "$sha_file" 2>/dev/null | tr -d '[:space:]')"
    FB_MIRROR_ACTUAL_BYTES="$(rclone --config "$conf" lsl "$FB_MIRROR_DEST" 2>/dev/null | awk '{print $1}' | head -1 | tr -d '[:space:]')"
  fi
  case "$FB_MIRROR_ACTUAL_BYTES" in ''|*[!0-9]*) FB_MIRROR_ACTUAL_BYTES=0 ;; esac
  [ "$FB_MIRROR_ACTUAL_BYTES" -gt 0 ] || warn "could not read the uploaded object's size back"
  FB_MIRROR_PUBLIC_URL="${FB_MIRROR_PUBLIC_BASE:-}"
  if [ -n "$FB_MIRROR_PUBLIC_URL" ]; then
    FB_MIRROR_PUBLIC_URL="${FB_MIRROR_PUBLIC_URL%/}/$FB_MIRROR_KEY"
  else
    warn "FB_MIRROR_PUBLIC_BASE is unset: the pin will carry the object key but no public URL,"
    warn "so the CLI fast path stays off until you set it (e.g. https://mirror.example.com)."
  fi
  ok "mirror uploaded: ${FB_MIRROR_ACTUAL_BYTES} bytes, sha256 ${FB_MIRROR_SHA:-?}"
}

# --- pin ------------------------------------------------------------------

fb_write_pin() { # fb_write_pin <snapshotId> <date> <storedGb> <heights-json> <amiId> <volumeGb>
  local snap="$1" date_tag="$2" size_gb="$3" heights="${4:-{}}" ami_id="${5:-}" vol_gb="${6:-0}"
  local tmp; tmp="$(mktemp)"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$PIN_FILE" "$tmp" "$snap" "$date_tag" "$size_gb" "$heights" "$REGION" "$VOLUME_ID" \
      "${FB_N_DATA_GB:-0}" "${FB_N_VERSION:-}" "$FB_MIRROR_PUBLIC_URL" "${FB_MIRROR_ACTUAL_BYTES:-0}" "${FB_MIRROR_SHA:-}" \
      "$ami_id" "$vol_gb" <<'PY'
import json, sys
(pin_path, out, snap, date_tag, size_gb, heights, region, volume_id,
 data_gb, version, murl, mbytes, msha, ami_id, vol_gb) = sys.argv[1:16]
try:
    with open(pin_path) as fh:
        doc = json.load(fh)
except Exception:
    doc = {"version": 1, "maxAgeDays": 14}
prev = doc.get("aws") or {}
doc.setdefault("version", 1)
doc.setdefault("maxAgeDays", 14)
doc["aws"] = {
    "amiId": ami_id or prev.get("amiId", ""),
    "snapshotId": snap,
    "region": region,
    "createdAt": date_tag,
    "volumeGb": int(vol_gb or 0) or int(prev.get("volumeGb") or 0),
    "volumeId": volume_id,
    "sourceInstance": prev.get("sourceInstance", ""),
    "storageGb": float(size_gb or 0),
    "usedGb": int(data_gb or 0),
    "nodeVersion": version,
    "heights": json.loads(heights or "{}"),
}
if murl or mbytes:
    doc["mirror"] = {
        "url": murl,
        "bytes": int(mbytes or 0),
        "sha256": msha,
        "createdAt": date_tag,
        "layout": ".rocks (RocksDB) + .onchain-config, tar + zstd, extracted into ~/snapchain",
    }
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=False)
    fh.write("\n")
PY
  elif command -v jq >/dev/null 2>&1; then
    jq --arg snap "$snap" --arg date "$date_tag" --arg region "$REGION" --arg vol "$VOLUME_ID" \
       --arg ver "$FB_N_VERSION" --arg url "$FB_MIRROR_PUBLIC_URL" --arg sha "$FB_MIRROR_SHA" \
       --arg ami "$ami_id" --argjson volgb "${vol_gb:-0}" --argjson used "${FB_N_DATA_GB:-0}" \
       --argjson size "${size_gb:-0}" --argjson bytes "${FB_MIRROR_ACTUAL_BYTES:-0}" \
       --argjson heights "$heights" \
      '.aws.amiId=$ami | .aws.snapshotId=$snap | .aws.region=$region | .aws.createdAt=$date | .aws.volumeId=$vol
       | .aws.volumeGb=$volgb | .aws.storageGb=$size | .aws.usedGb=$used | .aws.nodeVersion=$ver | .aws.heights=$heights
       | (if $url != "" then .mirror={url:$url, bytes:$bytes, sha256:$sha, createdAt:$date,
             layout:".rocks (RocksDB) + .onchain-config, tar + zstd, extracted into ~/snapchain"} else . end)' \
      "$PIN_FILE" > "$tmp" || die "could not update the pin with jq"
  else
    die "writing the pin needs python3 or jq (or pass --no-write-pin and pin it by hand)"
  fi
  mv "$tmp" "$PIN_FILE"
  ok "pin updated: $PIN_FILE"
}

fb_json_out() { # fb_json_out <path> <key=value...>
  local out="$1"; shift
  [ -n "$out" ] || return 0
  {
    printf '{\n'
    printf '  "task": "fiddy fast bootstrap publish",\n'
    while [ $# -gt 0 ]; do
      printf '  %s%s\n' "$1" "$([ $# -gt 1 ] && echo ,)"
      shift
    done
    printf '}\n'
  } > "$out"
}

# --- publish --------------------------------------------------------------

cmd_publish() {
  local extra
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait-for-sync) WAIT_FOR_SYNC=1; shift ;;
      --allow-unsynced) ALLOW_UNSYNCED=1; shift ;;
      --no-quiesce) NO_QUIESCE=1; shift ;;
      --mirror) MIRROR_MODE=on; shift ;;
      --no-mirror) MIRROR_MODE=off; shift ;;
      --no-public) PUBLIC=0; shift ;;
      --share-with) SHARE_WITH="${2:-}"; shift 2 ;;
      --no-write-pin) WRITE_PIN=0; shift ;;
      --json) JSON_OUT="${2:-}"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --) shift; break ;;
      *)
        extra="$(parse_common "$@" 2>/dev/null)" || die "unknown option: $1"
        [ -n "$extra" ] && die "unknown option: $extra"
        shift ;;
    esac
  done

  [ -n "$VOLUME_ID" ] || die "publish needs --volume vol-xxxxxxxx (the volume holding the node data)"
  local date_tag; date_tag="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local date_short; date_short="$(date -u +%Y-%m-%d)"

  log "publishing a pre-synced copy of $SSH_TARGET ($VOLUME_ID, $REGION)"
  fb_read_node_state
  dim "$(fb_node_state_line)"

  if [ "$WAIT_FOR_SYNC" = 1 ]; then
    local waited=0
    while ! fb_node_is_synced; do
      if [ "$waited" -ge "${FB_MAX_WAIT_SYNC_S:-43200}" ]; then
        die "node still not synced after $((waited / 3600))h: $(fb_node_state_line)"
      fi
      dim "not synced yet (${waited}s): $(fb_node_state_line)"
      sleep 300; waited=$((waited + 300)); fb_read_node_state
    done
    ok "node reports synced: $(fb_node_state_line)"
  elif ! fb_node_is_synced; then
    if [ "$ALLOW_UNSYNCED" = 1 ]; then
      warn "node does not look fully synced: $(fb_node_state_line)"
      warn "--allow-unsynced given: publishing anyway (the copy will be partial)"
    else
      die "node is not synced yet ($(fb_node_state_line)). Re-run with --wait-for-sync to block until it is, or --allow-unsynced to publish anyway."
    fi
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: would stop the node, snapshot $VOLUME_ID, make it public, restart it"
    log "dry run: pin would be written to $PIN_FILE for $date_tag"
    fb_describe "$PIN_FILE"
    return 0
  fi

  if [ "$NO_QUIESCE" = 1 ]; then
    warn "--no-quiesce: snapshotting with the database OPEN (crash-consistent at best)"
  else
    fb_quiesce
  fi

  fb_create_snapshot "$date_short"
  local snap_id="$FB_SNAPSHOT_ID"
  log "waiting for the snapshot to finish (a ~600 GB node takes a while; progress below)"
  if ! fb_wait_snapshot "$snap_id"; then
    warn "snapshot $snap_id did not reach 'completed' within $((MAX_WAIT_SNAPSHOT_S / 60)) min"
    warn "it is still being built server-side; re-run status later. Restarting the node."
    [ "$NO_QUIESCE" = 0 ] && fb_resume
    exit 1
  fi
  ok "snapshot $snap_id completed"

  if [ "$PUBLIC" = 1 ]; then
    fb_make_public "$snap_id"
  fi

  # The launchable artifact: an AMI registered from that (public) snapshot.
  local vol_gb
  vol_gb="$(fb_volume_size_gb "$VOLUME_ID")"
  case "$vol_gb" in ''|*[!0-9]*) vol_gb=0 ;; esac
  fb_register_ami "$snap_id" "$vol_gb" "$date_short"
  local ami_id="$FB_AMI_ID"
  local ami_public="false"
  if [ "$PUBLIC" = 1 ]; then
    ami_snapshot_hint="$snap_id"
    fb_publish_ami "$ami_id" "$SHARE_WITH"
    [ "$FB_AMI_PUBLIC" = 1 ] && ami_public="true"
    fb_wait_ami "$ami_id" || true
  fi

  local mirror_state="skipped (no bucket configured)"
  if [ "$MIRROR_MODE" = on ] || { [ "$MIRROR_MODE" = auto ] && fb_mirror_configured; }; then
    if fb_mirror_configured; then
      fb_mirror_publish "$date_short" && mirror_state="uploaded"
    else
      warn "--mirror asked for, but no bucket/keys are configured (see --help); skipping"
      mirror_state="skipped (keys missing)"
    fi
  fi

  if [ "$NO_QUIESCE" = 0 ]; then
    fb_resume
  fi

  local size_gb heights stored_gb vol_gb
  size_gb="$(fb_snapshot_size_gb "$snap_id")"
  stored_gb="$(fb_snapshot_stored_gb "$snap_id")"
  vol_gb="$(fb_volume_size_gb "$VOLUME_ID")"
  case "$vol_gb" in ''|*[!0-9]*) vol_gb=0 ;; esac
  heights="${FB_N_SHARDS:-{}}"

  if [ "$WRITE_PIN" = 1 ]; then
    fb_write_pin "$snap_id" "$date_tag" "$stored_gb" "$heights" "$ami_id" "$vol_gb"
  fi

  echo
  ok "published: snapshot $snap_id + AMI $ami_id (snapshot public: $PUBLIC, AMI public: $ami_public), synced state as of $date_tag"
  dim "consumers: scripts/aws-deploy.sh and fiddy provision --aws | fiddy node up (mirror)"
  dim "  the AMI is launched directly where it is shared; elsewhere aws-deploy.sh builds a volume from the" 
  dim "  public snapshot and attaches it, so the copy is usable from any account either way."
  if [ "${stored_gb:-0}" -gt 0 ] 2>/dev/null; then
    dim "monthly cost at list: \$$(( stored_gb * 5 / 100 )) of snapshot storage (${stored_gb} GB of incremental blocks, \$0.05/GB-mo)"
  else
    dim "monthly cost at list: \$0.05/GB-mo of snapshot storage for the blocks that changed (AWS did not report a size)"
  fi
  fb_json_out "$JSON_OUT" \
    "\"amiId\": \"$ami_id\"" \
    "\"snapshotId\": \"$snap_id\"" \
    "\"region\": \"$REGION\"" \
    "\"createdAt\": \"$date_tag\"" \
    "\"volumeId\": \"$VOLUME_ID\"" \
    "\"public\": $([ "$PUBLIC" = 1 ] && echo true || echo false)" \
    "\"dataGb\": ${FB_N_DATA_GB:-0}" \
    "\"snapshotVolumeGb\": ${size_gb:-0}" \
    "\"nodeVersion\": \"${FB_N_VERSION:-}\"" \
    "\"mirror\": \"$mirror_state\"" \
    "\"mirrorUrl\": \"${FB_MIRROR_PUBLIC_URL:-}\""
}

# --- status ---------------------------------------------------------------

cmd_status() {
  local extra
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      *)
        extra="$(parse_common "$@" 2>/dev/null)" || die "unknown option: $1"
        [ -n "$extra" ] && die "unknown option: $extra"; shift ;;
    esac
  done
  printf 'pin (%s)\n' "$PIN_FILE"
  dim "$(fb_describe "$PIN_FILE")"
  local pinned_snap pinned_age maxage
  pinned_snap="$(fb_pin_get .aws.snapshotId "$PIN_FILE")"
  pinned_age="$(fb_age_days "$(fb_pin_get .aws.createdAt "$PIN_FILE")")"
  maxage="$(fb_pin_get .maxAgeDays "$PIN_FILE")"; maxage="${maxage:-14}"
  [ -n "$pinned_age" ] && dim "age: ${pinned_age} day(s) (refresh at > ${maxage})"
  echo
  if [ -n "$SSH_TARGET" ]; then
    printf 'live node (%s)\n' "$SSH_TARGET"
    fb_read_node_state && dim "$(fb_node_state_line)"
  fi
  echo
  printf 'snapshots tagged project=fiddy\n'
  aws_cli ec2 describe-snapshots --owner-ids self \
    --filters 'Name=tag:project,Values=fiddy' \
    --query 'reverse(sort_by(Snapshots,&StartTime))[].{Id:SnapshotId,Started:StartTime,State:State,GB:VolumeSize,Progress:Progress}' \
    --output table 2>/dev/null || warn "could not list snapshots (missing ec2:DescribeSnapshots?)"
  if [ -n "$pinned_snap" ]; then
    local vg
    vg="$(fb_snapshot_stored_gb "$pinned_snap" 2>/dev/null || echo 0)"
    case "$vg" in ''|*[!0-9]*) vg=0 ;; esac
    [ "$vg" -gt 0 ] 2>/dev/null && dim "pinned snapshot ${pinned_snap}: \$$(( vg * 5 / 100 ))/mo of storage at list (${vg} GB incremental)"
    local pinned_ami; pinned_ami="$(fb_pin_get .aws.amiId "$PIN_FILE")"
    [ -n "$pinned_ami" ] && dim "pinned AMI ${pinned_ami}"
  fi
  aws_cli ec2 describe-images --owners self \
    --filters 'Name=tag:project,Values=fiddy' \
    --query 'reverse(sort_by(Images,&CreationDate))[].{Id:ImageId,Name:Name,Snap:BlockDeviceMappings[0].Ebs.SnapshotId,State:State}' \
    --output table 2>/dev/null || true
  return 0
}

# --- register-ami ---------------------------------------------------------

cmd_register_ami() {
  local snap="" vol_gb="" public=1 date_tag
  while [ $# -gt 0 ]; do
    case "$1" in
      --snapshot) snap="${2:-}"; shift 2 ;;
      --volume-gb) vol_gb="${2:-}"; shift 2 ;;
      --date) date_tag="${2:-}"; shift 2 ;;
      --no-public) public=0; shift ;;
      --) shift; break ;;
      *)
        local extra
        extra="$(parse_common "$@" 2>/dev/null)" || die "unknown option: $1"
        [ -n "$extra" ] && die "unknown option: $extra"; shift ;;
    esac
  done
  [ -n "$snap" ] || snap="$(fb_pin_get .aws.snapshotId "$PIN_FILE")"
  [ -n "$snap" ] || die "no snapshot: pass --snapshot snap-xxxxxxxx (or pin one first)"
  date_tag="${date_tag:-$(date -u +%Y-%m-%d)}"
  if [ -z "$vol_gb" ]; then
    vol_gb="$(fb_pin_get .aws.volumeGb "$PIN_FILE")"
  fi
  if [ -z "$vol_gb" ] || [ "$vol_gb" = "0" ]; then
    vol_gb="$(fb_snapshot_size_gb "$snap")"
  fi
  case "$vol_gb" in ''|*[!0-9]*) die "could not determine the volume size for $snap (pass --volume-gb)" ;; esac
  fb_register_ami "$snap" "$vol_gb" "$date_tag"
  if [ "$public" = 1 ]; then
    fb_publish_ami "$FB_AMI_ID"
    fb_wait_ami "$FB_AMI_ID" || true
  fi
  printf '%s\n' "$FB_AMI_ID"
}

# --- prune-old ------------------------------------------------------------

cmd_prune() {
  local keep="$KEEP"
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep) keep="${2:-2}"; shift 2 ;;
      --) shift; break ;;
      *)
        local extra
        extra="$(parse_common "$@" 2>/dev/null)" || die "unknown option: $1"
        [ -n "$extra" ] && die "unknown option: $extra"; shift ;;
    esac
  done
  local ids
  ids="$(aws_cli ec2 describe-snapshots --owner-ids self \
    --filters 'Name=tag:project,Values=fiddy' \
    --query 'reverse(sort_by(Snapshots,&StartTime))[].SnapshotId' --output text)"
  local i=0
  for id in $ids; do
    i=$((i + 1))
    if [ "$i" -le "$keep" ]; then
      dim "keep  $id"
      continue
    fi
    # An AMI pins its snapshot: deregister it first or the snapshot delete fails.
    local amis
    amis="$(aws_cli ec2 describe-images --owners self \
      --filters "Name=tag:fiddy:snapshot,Values=$id" \
      --query 'Images[].ImageId' --output text 2>/dev/null || true)"
    for ami in $amis; do
      log "deregister $ami (it is built from $id)"
      if [ "$DRY_RUN" = 1 ]; then dim "(dry run)"; else
        aws_cli ec2 deregister-image --image-id "$ami" >/dev/null && ok "deregistered $ami"
      fi
    done
    log "delete $id (older than the newest $keep)"
    if [ "$DRY_RUN" = 1 ]; then dim "(dry run)"; else
      aws_cli ec2 delete-snapshot --snapshot-id "$id" >/dev/null && ok "deleted $id"
    fi
  done
  return 0
}

# --- main -----------------------------------------------------------------

cmd="${1:-}"
shift || true
case "$cmd" in
  publish) cmd_publish "$@" ;;
  register-ami) cmd_register_ami "$@" ;;
  status)  cmd_status "$@" ;;
  prune-old|prune) cmd_prune "$@" ;;
  ""|-h|--help|help) usage ;;
  *) usage; die "unknown command: $cmd" ;;
esac