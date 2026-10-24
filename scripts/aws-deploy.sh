#!/usr/bin/env bash
# One-command Snapchain read node on AWS — run in AWS CloudShell
# (console.aws.amazon.com → the CloudShell icon — pre-authenticated, free)
# or anywhere with an aws CLI configured.
#
#   bash scripts/aws-deploy.sh
#
# Creates (idempotent — safe to re-run):
#   * key pair "fiddy-node" (private key saved to ./fiddy-node.pem — guard it)
#   * security group "fiddy-node": SSH + node APIs from YOUR ip only, gossip open
#   * EC2 m5.xlarge, Ubuntu 24.04, 2048 GB gp3 (~$285/mo list) with Docker
#
# FAST BOOTSTRAP: when config/fast-bootstrap.json pins a snapshot (the stopped,
# consistent state of a fully synced node, made public by
# scripts/node-snapshot.sh) the root volume is created FROM it. The box boots
# already synced and only catches up on the blocks it missed: the wait becomes
# the catch-up, not the ~470 GB download. The pin carries the date it was taken and its age is
# printed below. With nothing pinned, or FIDDY_AWS_FAST_BOOTSTRAP=0, this
# script behaves exactly as before. The snapshot is a convenience, never a trust
# root: the node re-validates everything over gossip and keeps syncing the tip.
set -euo pipefail

REGION="${FIDDY_AWS_REGION:-us-east-1}"
ITYPE="${FIDDY_AWS_INSTANCE_TYPE:-m5.xlarge}"
VOL_GB="${FIDDY_AWS_VOLUME_GB:-2048}"
NAME="${FIDDY_AWS_NAME:-fiddy-node}"
AWS_PROFILE_ARG=()
[ -n "${FIDDY_AWS_PROFILE:-}" ] && AWS_PROFILE_ARG=(--profile "$FIDDY_AWS_PROFILE")
aws_cli() { aws ${AWS_PROFILE_ARG[@]+"${AWS_PROFILE_ARG[@]}"} "$@"; }

command -v aws >/dev/null || { echo "aws CLI not found — run this in CloudShell (console.aws.amazon.com → CloudShell icon)"; exit 1; }
aws_cli sts get-caller-identity >/dev/null || { echo "aws not authenticated — CloudShell is pre-authed; locally: aws configure"; exit 1; }

# --- the pin: where the pre-synced state lives ---------------------------
# Used from a checkout when this script runs from one; fetched from the repo
# when the script is piped straight into bash (the CloudShell one-liner).
FB_LIB=""; REPO_ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
  [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/cli/lib/fast-bootstrap.sh" ] && FB_LIB="$REPO_ROOT/cli/lib/fast-bootstrap.sh"
fi
if [ -z "$FB_LIB" ]; then
  FB_LIB="$(mktemp)"
  curl -fsSL --max-time 20 "https://raw.githubusercontent.com/ivcained/fiddy/main/cli/lib/fast-bootstrap.sh" -o "$FB_LIB" 2>/dev/null || FB_LIB=""
fi
# shellcheck source=../cli/lib/fast-bootstrap.sh
[ -n "$FB_LIB" ] && . "$FB_LIB"

PIN_FILE=""
if [ -n "${FIDDY_FAST_BOOTSTRAP_PIN:-}" ]; then
  PIN_FILE="$FIDDY_FAST_BOOTSTRAP_PIN"
elif [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/config/fast-bootstrap.json" ]; then
  PIN_FILE="$REPO_ROOT/config/fast-bootstrap.json"
else
  PIN_FILE="$(mktemp)"
  curl -fsSL --max-time 20 "${FIDDY_FAST_BOOTSTRAP_PIN_URL:-https://raw.githubusercontent.com/ivcained/fiddy/main/config/fast-bootstrap.json}" \
    -o "$PIN_FILE" 2>/dev/null || PIN_FILE=""
fi

SNAPSHOT_ID=""; SNAP_DATE=""; SNAP_AGE=""; SNAP_MAX_AGE="14"
if [ -n "$PIN_FILE" ] && command -v fb_pin_get >/dev/null 2>&1; then
  SNAPSHOT_ID="$(fb_pin_get .aws.snapshotId "$PIN_FILE")"
  SNAP_DATE="$(fb_pin_get .aws.createdAt "$PIN_FILE")"
  SNAP_AGE="$(fb_age_days "$SNAP_DATE")"
  SNAP_MAX_AGE="$(fb_pin_get .maxAgeDays "$PIN_FILE")"; SNAP_MAX_AGE="${SNAP_MAX_AGE:-14}"
fi
[ "${FIDDY_AWS_FAST_BOOTSTRAP:-1}" = 1 ] || { SNAPSHOT_ID=""; SNAP_DATE=""; SNAP_AGE=""; }

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
echo "▸ region: $REGION · type: $ITYPE · disk: ${VOL_GB}GB gp3 · your IP: $MY_IP"
if [ -n "$SNAPSHOT_ID" ]; then
  echo "▸ pre-synced state: snapshot $SNAPSHOT_ID (synced as of ${SNAP_DATE:-unknown}${SNAP_AGE:+, $SNAP_AGE day(s) old})"
  echo "  the box boots from that state: no bootstrap download, just the catch-up on recent blocks."
  if [ -n "$SNAP_AGE" ] && [ "$SNAP_AGE" -gt "$SNAP_MAX_AGE" ] 2>/dev/null; then
    echo "  ! that pin is older than ${SNAP_MAX_AGE} days, so the catch-up is longer than usual."
    echo "    refresh it: scripts/fast-bootstrap-refresh.sh --ssh user@host --volume vol-xxxx --push"
  fi
  SNAP_STATE="$(aws_cli --region "$REGION" ec2 describe-snapshots --snapshot-ids "$SNAPSHOT_ID" --query 'Snapshots[0].State' --output text 2>/dev/null || echo '?')"
  if [ "$SNAP_STATE" != "completed" ]; then
    echo "  ! snapshot $SNAPSHOT_ID is '$SNAP_STATE', not completed — falling back to the cold bootstrap."
    SNAPSHOT_ID=""
  fi
else
  echo "▸ no pre-synced copy pinned: this box downloads ~470 GB of upstream chunks (overnight on HDD-class disks)."
fi

AMI="$(aws_cli ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { echo "no Ubuntu 24.04 AMI in $REGION"; exit 1; }

echo "▸ key pair"
if [ ! -f "$NAME.pem" ]; then
  aws_cli ec2 create-key-pair --region "$REGION" --key-name "$NAME" --query 'KeyMaterial' --output text > "$NAME.pem"
  chmod 600 "$NAME.pem"
  echo "  saved ./$NAME.pem — this is the only copy. Guard it."
else
  echo "  ($NAME.pem exists — reusing)"
fi
# A snapshot carries whatever SSH keys the source box trusted. First boot
# replaces them with this launcher's key, so booting from a public snapshot
# never grants anyone else access to your instance.
PUBKEY=""
command -v ssh-keygen >/dev/null 2>&1 && PUBKEY="$(ssh-keygen -y -f "$NAME.pem" 2>/dev/null || true)"

echo "▸ security group (SSH + APIs → you only; gossip → world)"
SG="$(aws_cli ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG="$(aws_cli ec2 create-security-group --region "$REGION" --group-name "$NAME" --description "fiddy snapchain read node" --query 'GroupId' --output text)"
  for spec in "tcp 22 $MY_IP/32" "tcp 3381 $MY_IP/32" "tcp 3383 $MY_IP/32" \
              "tcp 3382 0.0.0.0/0" "udp 3382 0.0.0.0/0" "tcp 3384 0.0.0.0/0" "udp 3384 0.0.0.0/0"; do
    set -- $spec
    aws_cli ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --protocol "$1" --port "$2" --cidr "$3" >/dev/null
  done
fi

UD="$(mktemp)"
BRING_UP=""
[ -n "$SNAPSHOT_ID" ] && BRING_UP='
# The pre-synced volume already holds a stopped node: start it again.
if [ -d /home/ubuntu/snapchain ]; then
  cd /home/ubuntu/snapchain && docker compose up -d snapchain statsd >>/var/log/fiddy-boot.log 2>&1 || true
fi'
KEY_REPLACE=""
[ -n "$PUBKEY" ] && KEY_REPLACE="
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
printf '%s\n' '$PUBKEY' > /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys"
cat > "$UD" <<EOF
#!/bin/bash
curl -fsSL https://get.docker.com | bash
usermod -aG docker ubuntu
apt-get install -y cron
systemctl enable --now cron
# Install the fiddy CLI system-wide so \`fiddy\` resolves from any shell/session.
apt-get install -y git
git clone https://github.com/ivcained/fiddy /opt/fiddy 2>/dev/null || git -C /opt/fiddy pull --ff-only
chmod +x /opt/fiddy/bin/fiddy
ln -sf /opt/fiddy/bin/fiddy /usr/local/bin/fiddy
$KEY_REPLACE
$BRING_UP
EOF

IID="$(aws_cli ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
BDA="DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL_GB,VolumeType=gp3}"
if [ -n "$SNAPSHOT_ID" ]; then
  BDA="DeviceName=/dev/sda1,Ebs={SnapshotId=$SNAPSHOT_ID,VolumeSize=$VOL_GB,VolumeType=gp3,DeleteOnTermination=true}"
fi
if [ -z "$IID" ] || [ "$IID" = "None" ]; then
  echo "▸ launching the VM (billing starts now, ~\$285/mo until you terminate)"
  IID="$(aws_cli ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$ITYPE" \
    --key-name "$NAME" --security-group-ids "$SG" --user-data "file://$UD" \
    --block-device-mappings "$BDA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=fiddy}]" \
    --query 'Instances[0].InstanceId' --output text)"
else
  echo "▸ ($NAME already running — reusing)"
fi
aws_cli ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
IP="$(aws_cli ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

mkdir -p "${FIDDY_HOME:-$HOME/.fiddy}"
printf '%s\n' "$IP" > "${FIDDY_HOME:-$HOME/.fiddy}/aws-last-ip"
cp -f "$NAME.pem" "${FIDDY_HOME:-$HOME/.fiddy}/$NAME.pem" 2>/dev/null || true

cat <<EOF2

✓ node compute is ready.

  external IP:  $IP
  ssh:          ssh -i $NAME.pem ubuntu@$IP

Cost honesty: ~\$285/mo at list price while this runs. Stop billing with:
  aws ec2 terminate-instances --region $REGION --instance-ids $IID

Next — install the node (from any machine with the fiddy repo cloned):

  git clone https://github.com/ivcained/fiddy && cd fiddy
  export PATH="$PWD/bin:$PATH"
  fiddy provision --ssh ubuntu@$IP
  fiddy node up
  fiddy client up

EOF2
if [ -n "$SNAPSHOT_ID" ]; then
cat <<EOF2
This box booted from the pre-synced snapshot (as of ${SNAP_DATE:-unknown}), so
there is no bootstrap download to wait out: the copied database loads and the
node syncs the blocks it missed. Check it with: fiddy node status
Prefer the full download on your own box? FIDDY_AWS_FAST_BOOTSTRAP=0 shares
nothing, and the node bootstraps from Farcaster's public chunks instead.
EOF2
else
cat <<EOF2
The node downloads ~470 GB of snapshot chunks before its API answers —
overnight is normal. fiddy node status shows progress.
EOF2
fi