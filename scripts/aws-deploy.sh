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

AWS_ARGS=(--region "$REGION")
[ -n "${FIDDY_AWS_PROFILE:-}" ] && AWS_ARGS=("${AWS_ARGS[@]}" --profile "$FIDDY_AWS_PROFILE")

SNAPSHOT_ID=""; SNAP_AMI=""; SNAP_VOL_GB="0"; SNAP_DATE=""; SNAP_AGE=""; SNAP_MAX_AGE="14"
if [ -n "$PIN_FILE" ] && command -v fb_pin_get >/dev/null 2>&1; then
  SNAPSHOT_ID="$(fb_pin_get .aws.snapshotId "$PIN_FILE")"
  # The fast artifact is an AMI registered from that snapshot: EC2 will not
  # accept a snapshot id for the root device of a launch.
  SNAP_AMI="$(fb_pin_get .aws.amiId "$PIN_FILE")"
  SNAP_VOL_GB="$(fb_pin_get .aws.volumeGb "$PIN_FILE")"; SNAP_VOL_GB="${SNAP_VOL_GB:-0}"
  SNAP_DATE="$(fb_pin_get .aws.createdAt "$PIN_FILE")"
  SNAP_AGE="$(fb_age_days "$SNAP_DATE")"
  SNAP_MAX_AGE="$(fb_pin_get .maxAgeDays "$PIN_FILE")"; SNAP_MAX_AGE="${SNAP_MAX_AGE:-14}"
fi
[ "${FIDDY_AWS_FAST_BOOTSTRAP:-1}" = 1 ] || { SNAPSHOT_ID=""; SNAP_AMI=""; SNAP_DATE=""; SNAP_AGE=""; }

# Which artifact can THIS account actually use? Publishing is not the same as
# being launchable: AMI public sharing is blocked by default in many accounts,
# while a public snapshot always works (build a volume from it). So: use the AMI
# when it is launchable here, otherwise fall back to the snapshot as a volume.
FAST_MODE=""
if [ -n "$SNAP_AMI" ] && command -v fb_ami_usable >/dev/null 2>&1 && fb_ami_usable "$SNAP_AMI" "${AWS_ARGS[@]}"; then
  FAST_MODE="ami"
elif [ -n "$SNAPSHOT_ID" ] && command -v fb_snapshot_usable >/dev/null 2>&1 && fb_snapshot_usable "$SNAPSHOT_ID" "${AWS_ARGS[@]}"; then
  FAST_MODE="volume"
fi

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
echo "▸ region: $REGION · type: $ITYPE · disk: ${VOL_GB}GB gp3 · your IP: $MY_IP"
case "$FAST_MODE" in
  ami)
    echo "▸ pre-synced state: AMI $SNAP_AMI from snapshot $SNAPSHOT_ID (synced as of ${SNAP_DATE:-unknown}${SNAP_AGE:+, $SNAP_AGE day(s) old})"
    echo "  the box boots from that state: no bootstrap download, just the catch-up on recent blocks."
    ;;
  volume)
    echo "▸ pre-synced state: public snapshot $SNAPSHOT_ID (synced as of ${SNAP_DATE:-unknown}${SNAP_AGE:+, $SNAP_AGE day(s) old})"
    echo "  this account cannot launch someone else's AMI, so the copy is attached as a data disk:"
    echo "  a volume is created FROM the snapshot (that is what a public snapshot is for), mounted, and"
    echo "  ~/snapchain is pointed at the node data it carries. Same result: no bootstrap download."
    ;;
  "")
    if [ -n "$SNAP_AMI" ] || [ -n "$SNAPSHOT_ID" ]; then
      echo "▸ a pre-synced copy is pinned ($SNAPSHOT_ID) but this account cannot use it"
      echo "  (no launch permission on the AMI, no create-volume permission on the snapshot)."
    fi
    echo "▸ cold bootstrap: this box downloads ~470 GB of upstream chunks (overnight on HDD-class disks)."
    ;;
esac
# A volume is never smaller than the snapshot it came from.
if [ -n "$FAST_MODE" ] && [ "${SNAP_VOL_GB:-0}" -gt "$VOL_GB" ] 2>/dev/null; then VOL_GB="$SNAP_VOL_GB"; fi
if [ -n "$SNAP_AGE" ] && [ "$SNAP_AGE" -gt "$SNAP_MAX_AGE" ] 2>/dev/null; then
  echo "  ! that pin is older than ${SNAP_MAX_AGE} days, so the catch-up is longer than usual."
  echo "    refresh it: scripts/fast-bootstrap-refresh.sh --ssh user@host --volume vol-xxxx --push"
fi
[ "${FIDDY_AWS_FAST_BOOTSTRAP:-1}" = 1 ] ||   echo "▸ FIDDY_AWS_FAST_BOOTSTRAP=0: ignoring any pinned copy, bootstrapping from Farcaster's chunks."

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

DATA_VOL=""; DATA_VOL_NODASH=""; ROOT_GB="$VOL_GB"
if [ "$FAST_MODE" = volume ]; then
  # The volume has to live in the AZ the instance will land in, and that is where
  # the account's default subnet is (not simply the first available AZ).
  AZ="$(aws_cli ec2 describe-subnets --filters 'Name=default-for-az,Values=true' --query 'Subnets[0].AvailabilityZone' --output text 2>/dev/null || true)"
  [ -n "$AZ" ] && [ "$AZ" != "None" ] || AZ="$(aws_cli ec2 describe-availability-zones --query 'AvailabilityZones[?State==`available`]|[0].ZoneName' --output text)"
  echo "▸ building the data volume from snapshot $SNAPSHOT_ID in $AZ (${VOL_GB}GB gp3)"
  DATA_VOL="$(aws_cli ec2 create-volume --snapshot-id "$SNAPSHOT_ID" --availability-zone "$AZ" \
    --volume-type gp3 --size "$VOL_GB" \
    --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=$NAME-data},{Key=project,Value=fiddy},{Key=fiddy:snapshot,Value=$SNAPSHOT_ID}]" \
    --query 'VolumeId' --output text)" || { echo "create-volume failed"; exit 1; }
  echo "  volume $DATA_VOL created; waiting for it to be available (the data is copied lazily)"
  aws_cli ec2 wait volume-available --volume-ids "$DATA_VOL" || { echo "volume $DATA_VOL never became available"; exit 1; }
  DATA_VOL_NODASH="$(printf '%s' "$DATA_VOL" | tr -d '-')"
  ROOT_GB=30   # the node's own data lives on the attached volume
fi

UD="$(mktemp)"
BRING_UP=""
[ -n "$SNAP_AMI" ] && BRING_UP='
# The pre-synced volume already holds a stopped node: start it again.
if [ -d /home/ubuntu/snapchain ]; then
  cd /home/ubuntu/snapchain && docker compose up -d snapchain statsd >>/var/log/fiddy-boot.log 2>&1 || true
fi'
# A snapshot carries whatever SSH keys its source box trusted, and cloud-init on
# the new instance also injects the launch key pair. Appending is not good
# enough: the inherited keys must be GONE from a box someone else booted, so a
# oneshot service that runs after cloud-init rewrites the file deterministically.
KEY_REPLACE=""
[ -n "$PUBKEY" ] && KEY_REPLACE="
cat > /usr/local/sbin/fiddy-firstboot-keys.sh <<'EOS'
#!/bin/bash
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
printf '%s\n' '$PUBKEY' > /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
EOS
chmod 750 /usr/local/sbin/fiddy-firstboot-keys.sh
cat > /etc/systemd/system/fiddy-firstboot-keys.service <<'EOS'
[Unit]
Description=fiddy: replace SSH keys inherited from the pre-synced snapshot
After=cloud-init.service cloud-config.service cloud-final.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fiddy-firstboot-keys.sh
[Install]
WantedBy=multi-user.target
EOS
systemctl enable fiddy-firstboot-keys.service >/dev/null 2>&1 || true
# cloud-init writes its own key AFTER user-data runs, so run the replacement
# again a little later in this boot as well: the file must end up holding
# exactly one key, and it must not be one inherited from the snapshot.
systemd-run --on-active=90 --unit=fiddy-keys-once /usr/local/sbin/fiddy-firstboot-keys.sh >/dev/null 2>&1 || true"

# The data-volume mode (see below): mount the volume built from the pinned
# snapshot and make ~/snapchain point at the node data inside it. The volume was
# copied from a root disk, so its filesystem UUID can collide with this
# instance's own root: retune it before mounting, and mount by device path.
VOLUME_BRINGUP=""
if [ "$FAST_MODE" = volume ]; then
  VOLUME_BRINGUP="
DEV=\$(lsblk -o NAME,SERIAL -n -p 2>/dev/null | awk -v s='$DATA_VOL_NODASH' '\$2 == s {print \$1; exit}')
[ -z \"\$DEV\" ] && [ -b /dev/xvdf ] && DEV=/dev/xvdf
[ -z \"\$DEV\" ] && [ -b /dev/sdf ] && DEV=/dev/sdf
if [ -n \"\$DEV\" ]; then
  tune2fs -U random \"\$DEV\" >>/var/log/fiddy-boot.log 2>&1
  mkdir -p /mnt/fiddy-node
  mount \"\$DEV\" /mnt/fiddy-node >>/var/log/fiddy-boot.log 2>&1
  echo \"\$DEV /mnt/fiddy-node ext4 defaults,nofail 0 2\" >> /etc/fstab
  if [ -d /mnt/fiddy-node/home/ubuntu/snapchain ]; then
    rm -rf /home/ubuntu/snapchain
    ln -s /mnt/fiddy-node/home/ubuntu/snapchain /home/ubuntu/snapchain
    echo 'fiddy: ~/snapchain -> the pre-synced volume' >> /var/log/fiddy-boot.log
    cd /home/ubuntu/snapchain && docker compose up -d snapchain statsd >>/var/log/fiddy-boot.log 2>&1
  else
    echo 'fiddy: the volume has no node data at home/ubuntu/snapchain' >> /var/log/fiddy-boot.log
  fi
else
  echo 'fiddy: could not find the attached data volume' >> /var/log/fiddy-boot.log
fi"
fi
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
$VOLUME_BRINGUP
EOF

IID="$(aws_cli ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
# run-instances cannot attach an existing volume (Ebs.VolumeId is not a launch
# parameter), so only the root device is set here and the data volume is
# attached right after the instance is running.
BDA_ARGS=("DeviceName=/dev/sda1,Ebs={VolumeSize=$ROOT_GB,VolumeType=gp3,DeleteOnTermination=true}")
LAUNCH_AMI="$AMI"
[ "$FAST_MODE" = ami ] && LAUNCH_AMI="$SNAP_AMI"
if [ -z "$IID" ] || [ "$IID" = "None" ]; then
  echo "▸ launching the VM (billing starts now, ~\$285/mo until you terminate)"
  IID="$(aws_cli ec2 run-instances --region "$REGION" --image-id "$LAUNCH_AMI" --instance-type "$ITYPE" \
    --key-name "$NAME" --security-group-ids "$SG" --user-data "file://$UD" \
    --block-device-mappings "${BDA_ARGS[@]}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=fiddy}]" \
    --query 'Instances[0].InstanceId' --output text)"
else
  echo "▸ ($NAME already running — reusing)"
fi
aws_cli ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
if [ -n "$DATA_VOL" ]; then
  aws_cli ec2 attach-volume --volume-id "$DATA_VOL" --instance-id "$IID" --device /dev/sdf >/dev/null \
    || echo "  ! could not attach $DATA_VOL (attach it by hand: aws ec2 attach-volume --volume-id $DATA_VOL --instance-id $IID --device /dev/sdf)"
  aws_cli ec2 wait volume-in-use --volume-ids "$DATA_VOL" || true
  echo "  data volume $DATA_VOL attached to $IID as /dev/sdf"
fi
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
if [ "$FAST_MODE" = ami ]; then
cat <<EOF2
This box booted from the pre-synced AMI ($SNAP_AMI, as of ${SNAP_DATE:-unknown}), so there is
no bootstrap download to wait out: the copied database loads and the node syncs
the blocks it missed. Check it with: fiddy node status
Prefer the full download on your own box? FIDDY_AWS_FAST_BOOTSTRAP=0 shares
nothing, and the node bootstraps from Farcaster's public chunks instead.
EOF2
elif [ "$FAST_MODE" = volume ]; then
cat <<EOF2
This box carries the pre-synced copy on its attached volume ($DATA_VOL, built from
snapshot $SNAPSHOT_ID, synced as of ${SNAP_DATE:-unknown}), with ~/snapchain pointing at it. First boot
mounts it and starts the node, so there is no bootstrap download to wait out.
Check it with: fiddy node status   (and: df -h ~/snapchain should show the new volume)
This volume is yours now: it costs the same as any 2 TB gp3 disk (~\$164/mo), and it
is deleted with the instance unless you switch DeleteOnTermination off.
EOF2
else
cat <<EOF2
The node downloads ~470 GB of snapshot chunks before its API answers —
overnight is normal. fiddy node status shows progress.
EOF2
fi