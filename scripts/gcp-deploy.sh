#!/usr/bin/env bash
# One-command Snapchain read node on Google Cloud — run this in Cloud Shell
# (gcloud is pre-authenticated there) or anywhere with an authenticated gcloud.
#
#   bash scripts/gcp-deploy.sh
#
# What it creates (idempotent — re-running is safe):
#   * firewall rule "snapchain-node": tcp 3381-3384 + udp 3382,3384 to tagged VMs
#   * VM "fiddy-node": e2-standard-4, Ubuntu 24.04, 2 TB pd-standard boot disk
#
# Why pd-standard (HDD): new GCP projects cap regional SSD at 500 GB — a 2 TB
# SSD boot disk is rejected. HDD has a separate, much larger quota and costs
# ~4x less. Trade-off: the snapshot bootstrap is overnight on HDD vs ~2h on SSD.
# Upgrade later: create with --boot-disk-type=pd-balanced after a quota bump.
set -euo pipefail

NAME="${FIDDY_GCP_NAME:-fiddy-node}"
ZONE="${FIDDY_GCP_ZONE:-us-central1-a}"
TYPE="${FIDDY_GCP_TYPE:-e2-standard-4}"
DISK_GB="${FIDDY_GCP_DISK_GB:-2048}"

command -v gcloud >/dev/null || { echo "gcloud not found — run this in Cloud Shell: https://shell.cloud.google.com"; exit 1; }
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] || { echo "no project set — run: gcloud config set project PROJECT_ID"; exit 1; }
echo "▸ project: $PROJECT · zone: $ZONE · type: $TYPE · disk: ${DISK_GB}GB pd-standard"

echo "▸ firewall rule (gossip must face the world; API ports are yours to guard)"
gcloud compute firewall-rules create snapchain-node \
  --allow tcp:3381-3384,udp:3382,udp:3384 \
  --target-tags snapchain-node \
  --description "Snapchain read node: HTTP/gRPC APIs + gossip" \
  --quiet 2>/dev/null || echo "  (rule already exists — fine)"

echo "▸ VM (Docker via startup script)"
if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "  ($NAME already exists in $ZONE — reusing)"
else
  gcloud compute instances create "$NAME" \
    --zone "$ZONE" \
    --machine-type "$TYPE" \
    --image-family ubuntu-2404-lts-amd64 \
    --image-project ubuntu-os-cloud \
    --boot-disk-size "${DISK_GB}GB" \
    --boot-disk-type pd-standard \
    --tags snapchain-node \
    --metadata startup-script='#!/bin/bash
curl -fsSL https://get.docker.com | sh
apt-get install -y cron
systemctl enable --now cron'
fi

IP="$(gcloud compute instances describe "$NAME" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[ -n "$IP" ] || { echo "no external IP assigned"; exit 1; }

echo "▸ waiting for the startup script (Docker + cron)…"
for i in $(seq 1 40); do
  if gcloud compute ssh "$NAME" --zone "$ZONE" --command 'command -v docker && command -v crontab' --quiet >/dev/null 2>&1; then
    break
  fi
  sleep 10
done

# Make plain ssh work for the fiddy CLI (gcloud already injected its own key;
# this adds the local default key too if one exists).
if [ -f "$HOME/.ssh/id_ed25519.pub" ] || [ -f "$HOME/.ssh/id_rsa.pub" ]; then
  PUB="$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || cat "$HOME/.ssh/id_rsa.pub")"
  USER_NAME="$(whoami)"
  gcloud compute instances add-metadata "$NAME" --zone "$ZONE" \
    --metadata "ssh-keys=${USER_NAME}:${PUB}" --quiet >/dev/null 2>&1 || true
fi

cat <<EOF

✓ node compute is ready.

  external IP:  $IP
  ssh:          gcloud compute ssh $NAME --zone $ZONE

Next — install the node (from any machine with the fiddy repo):

  fiddy provision --ssh $(whoami)@$IP
  fiddy node up
  fiddy client up

Reminder: the node needs ~470 GB of snapshot chunks before its API answers —
overnight on this HDD. fiddy node status shows progress. Delete everything with:

  gcloud compute instances delete $NAME --zone $ZONE --quiet
  gcloud compute firewall-rules delete snapchain-node --quiet
EOF
