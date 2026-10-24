#!/usr/bin/env bash
# aws-snapshot-roundtrip.sh — prove the fast-bootstrap AWS path end to end,
# without needing a synced node.
#
#   AWS_PROFILE=fiddy bash tests/aws-snapshot-roundtrip.sh
#
# It builds the smallest possible "pre-synced node": a throwaway t3.micro whose
# root volume carries a marker file, snapshotted while stopped, made public, and
# pinned exactly the way a real pin looks. Then it runs the real
# `scripts/aws-deploy.sh` against that pin and asserts what the tutorial promises:
#
#   1. the new instance's root volume was created FROM the pinned snapshot
#      (SourceSnapshotId in describe-volumes), not from the AMI
#   2. the box boots that copied filesystem (the marker file is there)
#   3. the launcher's own SSH key is the only one authorised (the first boot
#      replaces authorized_keys, so a public snapshot grants nobody access)
#   4. the pin's date and age are printed honestly by the script it was handed to
#
# Everything it creates is deleted at the end. Cost of a run: well under a
# dollar. Opt-in only: it is not part of CI, which has no AWS account.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../cli/lib/fast-bootstrap.sh
. "$REPO/cli/lib/fast-bootstrap.sh"

REGION="${FIDDY_AWS_REGION:-us-east-1}"
ITYPE="${FIDDY_AWS_INSTANCE_TYPE:-t3.micro}"
VOL_GB="${FIDDY_AWS_VOLUME_GB:-8}"
NAME="${FIDDY_AWS_NAME:-fiddy-fastboot-selftest}"
AWS_PROFILE_ARG=()
[ -n "${AWS_PROFILE:-}" ] && AWS_PROFILE_ARG=(--profile "$AWS_PROFILE")
aws_cli() { aws ${AWS_PROFILE_ARG[@]+"${AWS_PROFILE_ARG[@]}"} --region "$REGION" "$@"; }

PASS=0; FAIL=0
ok()  { printf '  ok   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }
log() { printf '▸ %s\n' "$*"; }

command -v aws >/dev/null || { echo "aws CLI required"; exit 1; }
aws_cli sts get-caller-identity >/dev/null || { echo "aws not authenticated"; exit 1; }

WORK="$(mktemp -d)"
CREATED_INSTANCES=""; CREATED_SNAPSHOTS=""; CREATED_KEYPAIRS=""; CREATED_SGS=""; CREATED_AMIS=""; CREATED_VOLUMES=""
cleanup() {
  for i in $CREATED_INSTANCES; do
    log "terminate $i"; aws_cli ec2 terminate-instances --instance-ids "$i" >/dev/null 2>&1 || true
  done
  for a in $CREATED_AMIS; do
    log "deregister $a"; aws_cli ec2 deregister-image --image-id "$a" >/dev/null 2>&1 || true
  done
  for s in $CREATED_SNAPSHOTS; do
    log "delete snapshot $s"; aws_cli ec2 delete-snapshot --snapshot-id "$s" >/dev/null 2>&1 || true
  done
  for k in $CREATED_KEYPAIRS; do
    log "delete key pair $k"; aws_cli ec2 delete-key-pair --key-name "$k" >/dev/null 2>&1 || true
  done
  for v in $CREATED_VOLUMES; do
    log "delete volume $v"; aws_cli ec2 delete-volume --volume-id "$v" >/dev/null 2>&1 || true
  done
  for g in $CREATED_SGS; do
    log "delete security group $g"
    aws_cli ec2 delete-security-group --group-id "$g" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
AMI="$(aws_cli ec2 describe-images --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { echo "no Ubuntu AMI in $REGION"; exit 1; }

# --- 1. the source box: a marker on its root volume, then a clean stop -----
SRC_SG="$(aws_cli ec2 create-security-group --group-name "$NAME-src" \
  --description "fiddy fast-bootstrap selftest (source)" --query 'GroupId' --output text)"
CREATED_SGS="$CREATED_SGS $SRC_SG"
aws_cli ec2 authorize-security-group-ingress --group-id "$SRC_SG" --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
SRC_KEY_NAME="$NAME-src-$(date +%s)"
aws_cli ec2 create-key-pair --key-name "$SRC_KEY_NAME" --query 'KeyMaterial' --output text > "$WORK/src.pem"
chmod 600 "$WORK/src.pem"; CREATED_KEYPAIRS="$CREATED_KEYPAIRS $SRC_KEY_NAME"

log "source box ($ITYPE, ${VOL_GB}GB) that will donate its volume"
SRC_IID="$(aws_cli ec2 run-instances --image-id "$AMI" --instance-type "$ITYPE" \
  --key-name "$SRC_KEY_NAME" --security-group-ids "$SRC_SG" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL_GB,VolumeType=gp3}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME-src},{Key=project,Value=fiddy}]" \
  --query 'Instances[0].InstanceId' --output text)"
CREATED_INSTANCES="$SRC_IID"
aws_cli ec2 wait instance-running --instance-ids "$SRC_IID"
SRC_IP="$(aws_cli ec2 describe-instances --instance-ids "$SRC_IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$WORK/src.pem" "ubuntu@$SRC_IP")
for _ in $(seq 1 30); do "${SSH[@]}" 'echo up' >/dev/null 2>&1 && break; sleep 5; done
"${SSH[@]}" 'echo fiddy-selftest-marker > /home/ubuntu/.fiddy-selftest' \
  || { echo "could not prepare the source box"; exit 1; }
SRC_VOL="$(aws_cli ec2 describe-instances --instance-ids "$SRC_IID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' --output text)"

# Stop it first: the same ordering the real publisher uses (quiesce, then
# snapshot), which is what makes the snapshot a consistent database.
aws_cli ec2 stop-instances --instance-ids "$SRC_IID" >/dev/null
aws_cli ec2 wait instance-stopped --instance-ids "$SRC_IID"
log "volume $SRC_VOL stopped; snapshotting it"
SNAP="$(aws_cli ec2 create-snapshot --volume-id "$SRC_VOL" \
  --description "fiddy fast-bootstrap selftest" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=project,Value=fiddy},{Key=Name,Value=fiddy-fast-bootstrap-selftest}]" \
  --query 'SnapshotId' --output text)"
CREATED_SNAPSHOTS="$CREATED_SNAPSHOTS $SNAP"
log "waiting for $SNAP to complete (an 8 GB root fills in about a minute)"
aws_cli ec2 wait snapshot-completed --snapshot-ids "$SNAP"
aws_cli ec2 modify-snapshot-attribute --snapshot-id "$SNAP" \
  --attribute createVolumePermission --operation-type add --group-names all >/dev/null
PERM="$(aws_cli ec2 describe-snapshot-attribute --snapshot-id "$SNAP" \
  --attribute createVolumePermission --query 'CreateVolumePermissions' --output json)"
case "$PERM" in
  *'"Group": "all"'*|*'"Group":"all"'*) ok "snapshot is public" ;;
  *) bad "snapshot $SNAP is not public: $PERM" ;;
esac

# --- 2. the launchable artifact: an AMI from that snapshot -----------------
# This drives the publisher's own registration path. A bare snapshot cannot be
# launched ("snapshotId cannot be modified on root device"), which is exactly
# why the pin carries an AMI.
log "registering an AMI from $SNAP (scripts/node-snapshot.sh register-ami)"
AMI_OUT="$(bash "$REPO/scripts/node-snapshot.sh" register-ami --snapshot "$SNAP" \
  --volume-gb "$VOL_GB" --date "$(date -u +%Y-%m-%d)" 2>&1)"
AMI_PIN="$(printf '%s\n' "$AMI_OUT" | grep -oE '^ami-[0-9a-f]+$' | tail -1)"
if [ -n "$AMI_PIN" ]; then
  CREATED_AMIS="$CREATED_AMIS $AMI_PIN"
  ok "register-ami produced $AMI_PIN"
else
  bad "register-ami produced no AMI id"; printf '%s\n' "$AMI_OUT" | tail -5
fi
AMI_STATE="$(aws_cli ec2 describe-images --image-ids "$AMI_PIN" --query 'Images[0].State' --output text 2>/dev/null || echo missing)"
AMI_PERM="$(aws_cli ec2 describe-image-attribute --image-id "$AMI_PIN" --attribute launchPermission --query 'LaunchPermissions' --output json 2>/dev/null || echo '[]')"
[ "$AMI_STATE" = "available" ] && ok "the AMI is available" || bad "AMI state is $AMI_STATE"
if fb_ami_usable "$AMI_PIN" --region "$REGION"; then
  ok "the AMI is launchable by this account"
else
  bad "the AMI is not launchable by this account (permissions: $AMI_PERM)"
fi
case "$AMI_PERM" in
  *'"Group": "all"'*|*'"Group":"all"'*) ok "the AMI is public as well" ;;
  *) ok "the AMI is not public (account policy: imageBlockPublicAccess) - the public snapshot covers other accounts" ;;
esac

# --- 3. a pin that looks exactly like the real one -------------------------
PIN="$WORK/fast-bootstrap.json"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$PIN" <<EOF
{
  "version": 1,
  "maxAgeDays": 14,
  "aws": { "amiId": "$AMI_PIN", "snapshotId": "$SNAP", "region": "$REGION",
           "createdAt": "$DATE", "volumeGb": $VOL_GB, "volumeId": "$SRC_VOL",
           "storageGb": $VOL_GB, "usedGb": 1, "nodeVersion": "selftest", "heights": {} }
}
EOF
log "pin: $(fb_describe "$PIN")"

# --- 4. the real deploy script, against that pin ---------------------------
log "running scripts/aws-deploy.sh with the pin (this is the code under test)"
DEPLOY_CWD="$WORK/deploy"; mkdir -p "$DEPLOY_CWD"
(
  cd "$DEPLOY_CWD" || exit 1
  AWS_PROFILE="${AWS_PROFILE:-}" FIDDY_AWS_REGION="$REGION" FIDDY_AWS_NAME="$NAME" \
  FIDDY_AWS_INSTANCE_TYPE="$ITYPE" FIDDY_AWS_VOLUME_GB="$VOL_GB" \
  FIDDY_HOME="$WORK/home" FIDDY_FAST_BOOTSTRAP_PIN="$PIN" \
  bash "$REPO/scripts/aws-deploy.sh"
) > "$WORK/deploy.log" 2>&1 || { bad "aws-deploy.sh exited non-zero"; tail -25 "$WORK/deploy.log"; }

if grep -q "pre-synced state: AMI $AMI_PIN" "$WORK/deploy.log"; then
  ok "the deploy script picked the pin up and said so"
else
  bad "the deploy script never mentioned the pinned AMI"; sed -n '1,20p' "$WORK/deploy.log"
fi
if grep -q "synced as of $DATE" "$WORK/deploy.log"; then
  ok "the pin's date is printed (honest age)"
else
  bad "the pin's date was not printed"
fi

# Track what the deploy created so nothing leaks.
DEP_SG="$(aws_cli ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
[ -n "$DEP_SG" ] && [ "$DEP_SG" != "None" ] && CREATED_SGS="$CREATED_SGS $DEP_SG"
CREATED_KEYPAIRS="$CREATED_KEYPAIRS $NAME"
DEP_IID="$(grep -oE -- '--instance-ids i-[0-9a-f]+' "$WORK/deploy.log" | awk '{print $2}' | tail -1)"

if [ -z "$DEP_IID" ]; then
  bad "could not find the launched instance in the deploy output"
else
  CREATED_INSTANCES="$CREATED_INSTANCES $DEP_IID"
  ROOT_VOL="$(aws_cli ec2 describe-instances --instance-ids "$DEP_IID" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' --output text)"
  SRC_SNAPSHOT="$(aws_cli ec2 describe-volumes --volume-ids "$ROOT_VOL" \
    --query 'Volumes[0].SnapshotId' --output text)"
  if [ "$SRC_SNAPSHOT" = "$SNAP" ]; then
    ok "the new root volume came from $SNAP (the pinned AMI's own snapshot)"
  else
    bad "root volume snapshot is $SRC_SNAPSHOT, expected $SNAP"
  fi
  DEP_IMAGE="$(aws_cli ec2 describe-instances --instance-ids "$DEP_IID" --query 'Reservations[0].Instances[0].ImageId' --output text)"
  if [ "$DEP_IMAGE" = "$AMI_PIN" ]; then
    ok "the instance launched the pinned AMI ($AMI_PIN), not a stock Ubuntu one"
  else
    bad "instance image is $DEP_IMAGE, expected $AMI_PIN"
  fi

  DEP_IP="$(aws_cli ec2 describe-instances --instance-ids "$DEP_IID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  DEP_KEY="$DEPLOY_CWD/$NAME.pem"
  [ -f "$DEP_KEY" ] || DEP_KEY="$WORK/home/$NAME.pem"
  DEP_SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$DEP_KEY" "ubuntu@$DEP_IP")
  up=0
  for _ in $(seq 1 24); do "${DEP_SSH[@]}" 'echo up' >/dev/null 2>&1 && { up=1; break; }; sleep 5; done
  if [ "$up" = 1 ]; then
    ok "the launcher's generated key reaches the box"
    if "${DEP_SSH[@]}" 'cat /home/ubuntu/.fiddy-selftest' 2>/dev/null | grep -q fiddy-selftest-marker; then
      ok "the box booted the copied filesystem (marker present)"
    else
      bad "the copied filesystem did not come through"
    fi
    if "${DEP_SSH[@]}" "grep -qF '$(ssh-keygen -y -f "$DEP_KEY" 2>/dev/null | awk '{print $2}')' /home/ubuntu/.ssh/authorized_keys"; then
      ok "the launcher's key is authorised"
    else
      bad "the launcher's key is missing from authorized_keys"
    fi
    # The source box's key must NOT survive on a box booted from its snapshot.
    SRC_PUB="$(ssh-keygen -y -f "$WORK/src.pem" 2>/dev/null | awk '{print $2}')"
    if "${DEP_SSH[@]}" "grep -qF '$SRC_PUB' /home/ubuntu/.ssh/authorized_keys"; then
      bad "the source box's SSH key is still authorised on the cloned box"
    else
      ok "the snapshot's inherited SSH key is gone (replaced, not appended)"
    fi
    KEYS="$("${DEP_SSH[@]}" 'wc -l < /home/ubuntu/.ssh/authorized_keys' 2>/dev/null | tr -d '[:space:]')"
    printf '    authorized_keys now holds %s line(s):\n' "${KEYS:-?}"
    "${DEP_SSH[@]}" 'cut -d" " -f3 /home/ubuntu/.ssh/authorized_keys' 2>/dev/null | sed 's/^/      /' | head -3
  else
    bad "the launcher's key could not reach the box"
  fi
fi

# --- 5. the same copy, for an account that cannot launch our AMI -----------
# This is the third-party case: the snapshot is public, the AMI is not launchable
# there (many accounts block public AMI sharing by default), so aws-deploy.sh has
# to build a volume FROM the snapshot, attach it, and hand the node the data it
# carries. Pinning no AMI at all is exactly how that account would see the pin.
VOL_NAME="$NAME-vol"
PIN_VOL="$WORK/fast-bootstrap-volume.json"
cat > "$PIN_VOL" <<EOF
{
  "version": 1,
  "maxAgeDays": 14,
  "aws": { "amiId": "", "snapshotId": "$SNAP", "region": "$REGION",
           "createdAt": "$DATE", "volumeGb": $VOL_GB, "volumeId": "$SRC_VOL",
           "storageGb": $VOL_GB, "usedGb": 1, "nodeVersion": "selftest", "heights": {} }
}
EOF
log "volume mode: deploying from the public snapshot alone (no AMI in the pin)"
VOL_CWD="$WORK/deploy-vol"; mkdir -p "$VOL_CWD"
(
  cd "$VOL_CWD" || exit 1
  AWS_PROFILE="${AWS_PROFILE:-}" FIDDY_AWS_REGION="$REGION" FIDDY_AWS_NAME="$VOL_NAME" \
  FIDDY_AWS_INSTANCE_TYPE="$ITYPE" FIDDY_AWS_VOLUME_GB="$VOL_GB" \
  FIDDY_HOME="$WORK/home-vol" FIDDY_FAST_BOOTSTRAP_PIN="$PIN_VOL" \
  bash "$REPO/scripts/aws-deploy.sh"
) > "$WORK/deploy-vol.log" 2>&1 || { bad "aws-deploy.sh (volume mode) exited non-zero"; tail -25 "$WORK/deploy-vol.log"; }
CREATED_SGS="$CREATED_SGS $(aws_cli ec2 describe-security-groups --filters "Name=group-name,Values=$VOL_NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
CREATED_KEYPAIRS="$CREATED_KEYPAIRS $VOL_NAME"
VOL_IID="$(grep -oE -- '--instance-ids i-[0-9a-f]+' "$WORK/deploy-vol.log" | awk '{print $2}' | tail -1)"
if grep -q "attached as a data disk" "$WORK/deploy-vol.log"; then
  ok "volume mode: the deploy script explained the attach path"
else
  bad "volume mode: the deploy script did not take the snapshot-as-volume path"; sed -n '1,12p' "$WORK/deploy-vol.log"
fi
if [ -n "$VOL_IID" ]; then
  CREATED_INSTANCES="$CREATED_INSTANCES $VOL_IID"
  VOLS="$(aws_cli ec2 describe-instances --instance-ids "$VOL_IID" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[].{D:DeviceName,V:Ebs.VolumeId}' --output text)"
  DATA_VOL=""
  for v in $(aws_cli ec2 describe-instances --instance-ids "$VOL_IID" \
      --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' --output text); do
    CREATED_VOLUMES="$CREATED_VOLUMES $v"
    src="$(aws_cli ec2 describe-volumes --volume-ids "$v" --query 'Volumes[0].SnapshotId' --output text)"
    [ "$src" = "$SNAP" ] && DATA_VOL="$v"
  done
  if [ -n "$DATA_VOL" ]; then
    ok "volume mode: a volume built from $SNAP is attached ($DATA_VOL)"
  else
    bad "volume mode: no attached volume came from $SNAP (volumes used: $VOLS)"
  fi

  VOL_IP="$(aws_cli ec2 describe-instances --instance-ids "$VOL_IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  VOL_KEY="$VOL_CWD/$VOL_NAME.pem"
  [ -f "$VOL_KEY" ] || VOL_KEY="$WORK/home-vol/$VOL_NAME.pem"
  VOL_SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$VOL_KEY" "ubuntu@$VOL_IP")
  upv=0
  for _ in $(seq 1 24); do "${VOL_SSH[@]}" 'echo up' >/dev/null 2>&1 && { upv=1; break; }; sleep 5; done
  if [ "$upv" = 1 ]; then
    if "${VOL_SSH[@]}" 'cat /mnt/fiddy-node/home/ubuntu/.fiddy-selftest' 2>/dev/null | grep -q fiddy-selftest-marker; then
      ok "volume mode: the pre-synced filesystem is mounted at /mnt/fiddy-node"
    else
      bad "volume mode: the mounted volume does not show the copied filesystem"
      "${VOL_SSH[@]}" 'cat /var/log/fiddy-boot.log | tail -20' 2>/dev/null | sed 's/^/    /'
    fi
    if [ "$("${VOL_SSH[@]}" 'readlink -f /home/ubuntu/snapchain' 2>/dev/null)" = "/mnt/fiddy-node/home/ubuntu/snapchain" ]; then
      ok "volume mode: ~/snapchain points at the volume (fiddy sees 2 TB of synced state)"
    else
      bad "volume mode: ~/snapchain does not point at the pre-synced volume ($("${VOL_SSH[@]}" 'readlink -f /home/ubuntu/snapchain' 2>/dev/null))"
    fi
    FREE="$("${VOL_SSH[@]}" 'df -Pk ~/snapchain 2>/dev/null | awk "NR==2 {print int(\$2/1048576)}"' 2>/dev/null | tr -d '[:space:]')"
    if [ "${FREE:-0}" -gt 1000 ] 2>/dev/null; then
      ok "volume mode: the node's data dir reports ${FREE} GB (the attached volume, not the 30 GB root)"
    else
      bad "volume mode: the data dir reports ${FREE:-?} GB, expected the attached volume"
    fi
  else
    bad "volume mode: the launcher's key could not reach the box"
  fi
else
  bad "volume mode: could not find the launched instance in the deploy output"
fi

printf '\n%d passed, %d failed (everything created is deleted now)\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]