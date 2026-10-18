# shellcheck shell=bash
# fiddy provision — command (0): furnish the compute.
#
# Two paths:
#   --aws            create a fresh EC2 instance with Docker preinstalled via user-data
#   --ssh user@host  register any server you already have (validated, then saved)

provision_main() {
  local mode=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --aws)  mode=aws ;;
      --ssh)  mode=ssh; shift; FIDDY_SSH_TARGET_ARG="${1:-}" ;;
      -h|--help)
        cat <<'EOF'
fiddy provision — furnish the compute your node will run on.

  --aws             Create an AWS EC2 instance with Docker preinstalled.
                    Needs: aws CLI configured (aws configure).
                    Options: FIDDY_AWS_REGION (default us-east-1)
                             FIDDY_AWS_INSTANCE_TYPE
                             FIDDY_AWS_VOLUME_GB (>= 1500 is the read-node floor)
                    Cost: a read-node-sized box is ~$285/month on AWS list price
                    (instance ~$121 + 2 TB gp3 ~$164/mo); a 2 TB VPS from a
                    Hetzner/Contabo/OVH-class host is usually $50-80/month.
  --ssh user@host   Skip creation — use a server you already have.
                    Needs: SSH key auth already working, sudo on the remote,
                    and 1.5-2 TB of free disk (checked before install).

The target is saved to ~/.fiddy/config (mode 0600).
EOF
        return 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  case "$mode" in
    aws) provision_aws ;;
    ssh) provision_ssh "${FIDDY_SSH_TARGET_ARG:?missing user@host after --ssh}" ;;
    *)
      step "fiddy provision"
      echo "Pick your compute:"
      echo "  1. AWS (scripted, ~\$285/mo at list price):  fiddy provision --aws"
      echo "  2. Any server you have:        fiddy provision --ssh user@host"
      echo ""
      echo "Minimum for a Snapchain read node: 4 vCPU, 16 GB RAM, 1.5-2 TB free disk, Ubuntu 22.04+."
      echo "The ~200 GB mainnet snapshot is *compressed*; it decompresses several times larger."
      echo "A 2 TB VPS from a Hetzner/Contabo/OVH-class host is usually \$50-80/month."
      ;;
  esac
}

provision_ssh() {
  local target="$1"
  require ssh "install openssh"
  step "Registering existing server: $target"
  log "checking SSH (BatchMode, 10s timeout)…"
  ssh_opts_fill
  ssh "${FIDDY_SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
      "$target" 'echo fiddy-ok && uname -sm && (command -v docker >/dev/null && docker --version || echo no-docker)' \
    | tee /tmp/fiddy-provision-ssh.$$
  grep -q fiddy-ok /tmp/fiddy-provision-ssh.$$ || die "cannot reach $target — fix key auth first (ssh-copy-id $target)"
  rm -f /tmp/fiddy-provision-ssh.$$
  config_set FIDDY_TARGET "$target"
  config_set FIDDY_PROVIDER "ssh"
  ok "target saved. Next: fiddy node up"
  # Report sizing now, while the user is still picking a box: a read node needs
  # 1.5-2 TB free and a small disk only shows up hours into a snapshot pull.
  echo ""
  FIDDY_SIZING_FATAL=0 check_node_sizing "$(node_facts_remote)" || true
}

provision_aws() {
  require aws "install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  require ssh "install openssh"

  local region="${FIDDY_AWS_REGION:-us-east-1}"
  local itype="${FIDDY_AWS_INSTANCE_TYPE:-t3.xlarge}"
  local name="fiddy-node-$(date +%s)"
  local sg_name="fiddy-node"
  local my_ip

  step "Provisioning AWS EC2 ($itype in $region)"
  my_ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" \
    || die "could not determine your public IP"
  log "your IP: $my_ip (SSH + node API will be restricted to it)"

  # AMI: latest Ubuntu 24.04 LTS amd64 from Canonical's public SSM parameter.
  local ami
  ami="$(aws ec2 describe-images --region "$region" --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
              'Name=state,Values=available' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)" \
    || die "AMI lookup failed — check aws credentials (aws sts get-caller-identity)"
  [ "$ami" != "None" ] && [ -n "$ami" ] || die "no Ubuntu 24.04 AMI found in $region"
  log "AMI: $ami"

  # Key pair
  local key_path="$FIDDY_HOME/${name}.pem"
  mkdir -p "$FIDDY_HOME"
  aws ec2 create-key-pair --region "$region" --key-name "$name" \
    --query 'KeyMaterial' --output text > "$key_path" || die "key pair creation failed"
  chmod 600 "$key_path"
  ok "SSH key saved: $key_path"

  # Security group: SSH + node HTTP/gRPC from your IP only; gossip open to the network.
  local sg_id
  sg_id="$(aws ec2 create-security-group --region "$region" --group-name "$sg_name-$name" \
    --description "fiddy snapchain read node" --query 'GroupId' --output text)" || die "security group failed"
  for spec in "tcp 22 $my_ip/32" "tcp $SNAP_HTTP_PORT $my_ip/32" "tcp $SNAP_GRPC_PORT $my_ip/32" \
              "tcp 3382 0.0.0.0/0" "udp 3382 0.0.0.0/0" "tcp 3384 0.0.0.0/0" "udp 3384 0.0.0.0/0"; do
    set -- $spec
    aws ec2 authorize-security-group-ingress --region "$region" --group-id "$sg_id" \
      --protocol "$1" --port "$2" --cidr "$3" >/dev/null
  done
  ok "security group: $sg_id (SSH/API → you only; gossip → world)"

  # user-data: Docker preinstalled so `fiddy node up` is fast.
  local ud="$FIDDY_HOME/user-data.sh"
  cat > "$ud" <<'UD'
#!/bin/bash
curl -fsSL https://get.docker.com | bash
usermod -aG docker ubuntu
UD

  local iid
  iid="$(aws ec2 run-instances --region "$region" \
    --image-id "$ami" --instance-type "$itype" --key-name "$name" \
    --security-group-ids "$sg_id" --user-data "file://$ud" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name},{Key=project,Value=fiddy}]" \
    --query 'Instances[0].InstanceId' --output text)" || die "run-instances failed"
  log "instance: $iid — waiting for running state…"
  aws ec2 wait instance-running --region "$region" --instance-ids "$iid"

  local ip
  ip="$(aws ec2 describe-instances --region "$region" --instance-ids "$iid" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  [ -n "$ip" ] && [ "$ip" != "None" ] || die "instance has no public IP"

  config_set FIDDY_TARGET "ubuntu@$ip"
  config_set FIDDY_PROVIDER "aws"
  config_set FIDDY_SSH_KEY "$key_path"
  config_set FIDDY_AWS_REGION "$region"
  config_set FIDDY_AWS_INSTANCE_ID "$iid"

  log "waiting for cloud-init (Docker install)…"
  local i
  for ((i = 1; i <= 40; i++)); do
    if ssh -i "$key_path" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
        "ubuntu@$ip" 'command -v docker' >/dev/null 2>&1; then
      ok "compute ready: ubuntu@$ip"
      ok "Next: fiddy node up"
      return 0
    fi
    sleep 10
  done
  die "instance is running but Docker never appeared — ssh -i $key_path ubuntu@$ip and check /var/log/cloud-init-output.log"
}
