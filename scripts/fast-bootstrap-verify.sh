#!/usr/bin/env bash
# fiddy fast-bootstrap verify — the acceptance test for a pinned snapshot.
#
#   scripts/fast-bootstrap-verify.sh [--pin config/fast-bootstrap.json] [--keep]
#
# Boots a throwaway EC2 instance whose root volume is created FROM the pinned
# public snapshot, then measures the thing the tutorial promises:
#
#   boot → the node's HTTP API answers /v1/info with ~current shard heights
#        → `fiddy node verify` passes against it
#
# Everything is printed with real timings and real heights; nothing is assumed.
# The box is terminated afterwards unless --keep is passed (a 15-minute run of
# an m5.xlarge-class instance costs cents; the volume dies with the instance).
#
# This is also the proof that the pinned snapshot is not a trust root: the
# instance re-joins gossip and syncs forward from the copied state.

set -uo pipefail

FB_REPO="${FIDDY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../cli/lib/fast-bootstrap.sh
. "$FB_REPO/cli/lib/fast-bootstrap.sh"

REGION="${FIDDY_AWS_REGION:-us-east-1}"
AWS_PROFILE_ARG=()
ITYPE="${FIDDY_AWS_INSTANCE_TYPE:-m5.xlarge}"
VOL_GB="${FIDDY_AWS_VOLUME_GB:-2050}"
NAME="${FB_VERIFY_NAME:-fiddy-node-verify}"
PIN_FILE="$(fb_pin_path "$FB_REPO")"
KEEP=0
TIMEOUT_MIN="${FB_VERIFY_TIMEOUT_MIN:-15}"
KEY_FILE="${FIDDY_VERIFY_KEY_FILE:-}"
SNAPSHOT_ID_OVERRIDE=""

fb_log()  { printf '▸ %s\n' "$*"; }
fb_ok()   { printf '✓ %s\n' "$*"; }
fb_dim()  { printf '  %s\n' "$*"; }

usage() {
  cat <<'EOF'
fast-bootstrap-verify.sh — boot a fresh box from the pinned snapshot and measure it.

  --pin PATH             pin file to read (default config/fast-bootstrap.json)
  --snapshot snap-xxxx   verify this snapshot instead of the pinned one
  --region REGION        AWS region (default us-east-1)
  --instance-type TYPE   default m5.xlarge
  --volume-gb N          root volume size (default 2050)
  --key-file path.pem    private key to authorise on the box (default: make one)
  --timeout-min N        how long to wait for the API (default 15)
  --keep                 leave the box running and print how to reach it
  --dry-run              print what would happen, create nothing
EOF
}

aws_cli() {
  command -v aws >/dev/null 2>&1 || { fb_log "aws CLI not found"; exit 1; }
  aws ${AWS_PROFILE_ARG[@]+"${AWS_PROFILE_ARG[@]}"} --region "$REGION" "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN_FILE="${2:-}"; shift 2 ;;
    --snapshot) SNAPSHOT_ID_OVERRIDE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=(--profile "${2:-}"); shift 2 ;;
    --instance-type) ITYPE="${2:-}"; shift 2 ;;
    --volume-gb) VOL_GB="${2:-}"; shift 2 ;;
    --key-file) KEY_FILE="${2:-}"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --dry-run) FB_DRY=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

SNAP="${SNAPSHOT_ID_OVERRIDE:-$(fb_pin_get .aws.snapshotId "$PIN_FILE")}"
[ -n "$SNAP" ] || { fb_log "nothing pinned in $PIN_FILE (and no --snapshot)"; exit 1; }
PIN_DATE="$(fb_pin_get .aws.createdAt "$PIN_FILE")"
PIN_AGE="$(fb_age_days "$PIN_DATE")"

fb_log "verifying snapshot $SNAP (synced state as of ${PIN_DATE:-unknown}$([ -n "$PIN_AGE" ] && printf ', %s day(s) old' "$PIN_AGE"))"

# --- the snapshot must actually be public, or a fresh account cannot use it ---
PERM="$(aws_cli ec2 describe-snapshot-attribute --snapshot-id "$SNAP" --attribute createVolumePermission --query 'CreateVolumePermissions' --output json 2>/dev/null || echo '[]')"
case "$PERM" in
  *'"Group": "all"'*|*'"Group":"all"'*) fb_ok "snapshot is public (usable from any account)" ;;
  *) fb_log "snapshot $SNAP is NOT public yet: $PERM"; exit 1 ;;
esac
SNAP_STATE="$(aws_cli ec2 describe-snapshots --snapshot-ids "$SNAP" --query 'Snapshots[0].State' --output text)"
SNAP_GB="$(aws_cli ec2 describe-snapshots --snapshot-ids "$SNAP" --query 'Snapshots[0].VolumeSize' --output text)"
[ "$SNAP_STATE" = "completed" ] || { fb_log "snapshot state is $SNAP_STATE, not completed"; exit 1; }
fb_dim "volume size ${SNAP_GB} GB · list cost \$$(( SNAP_GB * 5 / 100 ))/mo"

if [ "${FB_DRY:-0}" = 1 ]; then
  fb_log "dry run: would launch $ITYPE with /dev/sda1 from $SNAP, wait up to ${TIMEOUT_MIN}m, run fiddy node verify, then tear it down"
  exit 0
fi

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
[ -n "$MY_IP" ] || { fb_log "could not read this machine's public IP"; exit 1; }
fb_dim "your IP: $MY_IP (only this IP may reach SSH and :3381)"

AMI="$(aws_cli ec2 describe-images --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { fb_log "no Ubuntu 24.04 AMI in $REGION"; exit 1; }

# --- key pair -------------------------------------------------------------
TMPDIR_FB="$(mktemp -d)"
if [ -z "$KEY_FILE" ]; then
  KEY_FILE="$TMPDIR_FB/verify.pem"
  aws_cli ec2 create-key-pair --key-name "$NAME" --query 'KeyMaterial' --output text > "$KEY_FILE" \
    || { fb_log "could not create the key pair $NAME"; exit 1; }
  chmod 600 "$KEY_FILE"
  KEY_CLEANUP=1
fi
PUBKEY="$(ssh-keygen -y -f "$KEY_FILE")" || { fb_log "$KEY_FILE is not a usable private key"; exit 1; }
KEY_NAME="$(aws_cli ec2 describe-key-pairs --query "KeyPairs[?KeyName=='$NAME'].KeyName" --output text 2>/dev/null || true)"
if [ -z "$KEY_NAME" ]; then
  fb_log "no key pair named $NAME in $REGION; the instance and this key must match"
  exit 1
fi

# --- security group -------------------------------------------------------
user_data() {
  cat <<EOF
#!/bin/bash
set -x
# The snapshot carries whatever authorized_keys the source box trusted. Replace
# them with this launcher's key so a public snapshot never grants anyone else
# access to a box someone else booted from it.
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
printf '%s\n' "$PUBKEY" > /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
# The container was stopped for a consistent snapshot: start it again.
if [ -d /home/ubuntu/snapchain ]; then
  cd /home/ubuntu/snapchain || exit 0
  docker compose up -d snapchain statsd >>/var/log/fiddy-boot.log 2>&1 || true
fi
echo "fiddy verify boot: node containers started \$(date -u)" >> /var/log/fiddy-boot.log
EOF
}

UD="$TMPDIR_FB/user-data.sh"
user_data > "$UD"

SG="$(aws_cli ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG="$(aws_cli ec2 create-security-group --group-name "$NAME" --description "fiddy fast-bootstrap verification" --query 'GroupId' --output text)"
  for spec in "tcp 22 $MY_IP/32" "tcp 3381 $MY_IP/32" "tcp 3383 $MY_IP/32" \
              "tcp 3382 0.0.0.0/0" "udp 3382 0.0.0.0/0" "tcp 3384 0.0.0.0/0" "udp 3384 0.0.0.0/0"; do
    set -- $spec
    aws_cli ec2 authorize-security-group-ingress --group-id "$SG" --protocol "$1" --port "$2" --cidr "$3" >/dev/null
  done
fi

fb_log "launching a fresh $ITYPE, root device from $SNAP (this is the whole point: no bootstrap download)"
IID="$(aws_cli ec2 run-instances --image-id "$AMI" --instance-type "$ITYPE" \
  --key-name "$NAME" --security-group-ids "$SG" --user-data "file://$UD" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={SnapshotId=$SNAP,VolumeSize=$VOL_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=fiddy},{Key=fiddy:verify,Value=snapshot}]" \
  --query 'Instances[0].InstanceId' --output text)"
[ -n "$IID" ] && [ "$IID" != "None" ] || { fb_log "run-instances failed"; exit 1; }
aws_cli ec2 wait instance-running --instance-ids "$IID"

IP="$(aws_cli ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
T0="$(date -u +%s)"
fb_ok "instance $IID up at $IP (clock started)"

cleanup() {
  if [ "$KEEP" = 1 ]; then
    fb_dim "keeping $IID ($IP); ssh -i $KEY_FILE ubuntu@$IP"
    return 0
  fi
  fb_log "tearing down $IID (the root volume goes with it)"
  aws_cli ec2 terminate-instances --instance-ids "$IID" >/dev/null 2>&1 || true
  [ "${KEY_CLEANUP:-0}" = 1 ] && aws_cli ec2 delete-key-pair --key-name "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- wait for a real answer ----------------------------------------------
DEADLINE=$((T0 + TIMEOUT_MIN * 60))
INFO=""
while [ "$(date -u +%s)" -lt "$DEADLINE" ]; do
  INFO="$(curl -fsS --max-time 6 "http://$IP:3381/v1/info" 2>/dev/null || true)"
  if [ -n "$INFO" ]; then break; fi
  fb_dim "$(( $(date -u +%s) - T0 ))s: /v1/info not answering yet (the copy is loading into RocksDB)"
  sleep 15
done
SECS=$(( $(date -u +%s) - T0 ))
if [ -z "$INFO" ]; then
  fb_log "FAIL: no answer on :3381 within ${TIMEOUT_MIN} min of boot"
  exit 1
fi
fb_ok "the API answered $((SECS / 60))m $((SECS % 60))s after the instance came up"

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$INFO" | jq -r '"  height=\(.maxHeight) blockDelay=\(.blockDelay)s version=\(.version.string // .version // "?") shards=\((.shardInfo // {}) | keys | length)"'
  H="$(printf '%s' "$INFO" | jq -r '.maxHeight // 0')"
  D="$(printf '%s' "$INFO" | jq -r '.blockDelay // 0')"
else
  printf '  %s\n' "$INFO"
  H="$(printf '%s' "$INFO" | sed -n 's/.*"maxHeight"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
  D="$(printf '%s' "$INFO" | sed -n 's/.*"blockDelay"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
fi

PIN_H="$(fb_pin_get .aws.heights.maxHeight "$PIN_FILE")"
if [ -n "$PIN_H" ] && [ -n "$H" ] && [ "$H" -ge "$PIN_H" ] 2>/dev/null; then
  fb_ok "height $H >= the pinned state's $PIN_H (the copy is on/behind the tip and catching up)"
elif [ -n "$PIN_H" ]; then
  fb_log "note: height ${H:-?} is below the pinned ${PIN_H} (the copy may still be loading leftovers)"
fi
[ -n "$D" ] && [ "$D" -le 300 ] 2>/dev/null \
  && fb_ok "blockDelay ${D}s: it is following the tip, not stuck" \
  || fb_log "note: blockDelay ${D:-?}s is high; give the node a few minutes and re-check"

# --- the CLI's own acceptance checks, against THIS box --------------------
TMP_HOME="$TMPDIR_FB/home"
mkdir -p "$TMP_HOME"
{
  printf 'FIDDY_TARGET=%s\n' "ubuntu@$IP"
  printf 'FIDDY_NODE_HTTP=%s\n' "http://$IP:3381"
  printf 'FIDDY_NODE_GRPC=%s\n' "$IP:3383"
  printf 'FIDDY_SSH_KEY=%q\n' "$KEY_FILE"
} > "$TMP_HOME/config"
chmod 600 "$TMP_HOME/config"

fb_log "running the CLI's acceptance checks (fiddy node verify) against $IP"
set +e
FIDDY_HOME="$TMP_HOME" FIDDY_TARGET="ubuntu@$IP" FIDDY_SSH_KEY="$KEY_FILE" \
  FIDDY_NODE_HTTP="http://$IP:3381" bash "$FB_REPO/bin/fiddy" node verify 3
VERIFY_RC=$?
if [ "$VERIFY_RC" = 0 ]; then fb_ok "fiddy node verify passed"; else fb_log "fiddy node verify exited $VERIFY_RC"; fi

echo
printf 'fast bootstrap verified: snapshot %s\n' "$SNAP"
printf '  boot to answering API : %s\n' "$((SECS / 60))m $((SECS % 60))s"
printf '  height / blockDelay   : %s / %ss\n' "${H:-?}" "${D:-?}"
printf '  fiddy node verify     : %s\n' "$([ "$VERIFY_RC" = 0 ] && echo PASS || echo "exit $VERIFY_RC")"
[ "$KEEP" = 1 ] && printf '  (box kept: %s)\n' "$IP"
[ "$VERIFY_RC" = 0 ] || exit 1