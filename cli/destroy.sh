# shellcheck shell=bash
# shellcheck disable=SC1091
# Irreversible teardown always names its target and waits for a typed confirmation.

source "$FIDDY_REPO/cli/provision.sh"

destroy_clear_config() {
  local key
  for key in FIDDY_TARGET FIDDY_PROVIDER FIDDY_MONTHLY_COST FIDDY_NODE_HTTP FIDDY_NODE_GRPC FIDDY_WEB_URL \
    FIDDY_SSH_KEY FIDDY_AWS_INSTANCE_ID FIDDY_AWS_VOLUME_ID FIDDY_AWS_SG_ID FIDDY_AWS_KEY_NAME FIDDY_AWS_IP \
    FIDDY_HETZNER_SERVER_ID FIDDY_HETZNER_VOLUME_ID FIDDY_GCP_NAME FIDDY_GCP_ZONE; do
    config_set "$key" ""
  done
  rm -f "$FIDDY_HOME/snapshot-progress"
}

destroy_gcp() {
  local name="${FIDDY_GCP_NAME:-fiddy-node}" zone="${FIDDY_GCP_ZONE:-us-central1-a}"
  gcloud compute instances delete "$name" --zone "$zone" --quiet \
    || die "GCP did not delete $name in $zone. Check: gcloud compute instances describe $name --zone $zone"
  gcloud compute firewall-rules delete snapchain-node --quiet \
    || die "the VM is stopping, but its snapchain-node firewall rule is still there. Remove it in the GCP console"
  if gcloud compute instances describe "$name" --zone "$zone" >/dev/null 2>&1; then
    die "GCP still shows $name. Treat billing as still running until it is gone"
  fi
}

destroy_hetzner() {
  bash "$FIDDY_REPO/scripts/hetzner-teardown.sh" "$FIDDY_HETZNER_SERVER_ID" "$FIDDY_HETZNER_VOLUME_ID" \
    || die "Hetzner teardown did not finish cleanly. Your saved configuration was kept so you can re-run fiddy destroy"
}

destroy_main() {
  [ "$#" -eq 0 ] || die "fiddy destroy takes no flags. Run: fiddy destroy and read the confirmation"
  config_load
  local provider="${FIDDY_PROVIDER:-}" cost="${FIDDY_MONTHLY_COST:-}" target=""
  case "$provider" in
    aws)
      [ -n "${FIDDY_AWS_INSTANCE_ID:-}" ] || die "no AWS instance is recorded. Nothing was destroyed"
      target="AWS instance $FIDDY_AWS_INSTANCE_ID in ${FIDDY_AWS_REGION:-us-east-1}, its disk, key pair, and security group"
      ;;
    hetzner)
      if [ -z "${FIDDY_HETZNER_SERVER_ID:-}" ] || [ -z "${FIDDY_HETZNER_VOLUME_ID:-}" ]; then
        die "Hetzner server and volume ids are not both recorded. Delete both in the Hetzner console; the volume keeps billing"
      fi
      target="Hetzner server $FIDDY_HETZNER_SERVER_ID and volume $FIDDY_HETZNER_VOLUME_ID"
      ;;
    gcp)
      target="Google Cloud instance ${FIDDY_GCP_NAME:-fiddy-node} in ${FIDDY_GCP_ZONE:-us-central1-a}"
      ;;
    ssh) die "Fiddy did not create this server, so it will not destroy it. Use your provider's own console. Nothing was touched" ;;
    ovh) die "OVH teardown is not automated yet. Delete the instance AND its volume in the OVH console; the volume keeps billing. Nothing was touched" ;;
    *) die "no supported cloud server is recorded. Nothing was destroyed" ;;
  esac

  if [ -z "$cost" ]; then cost="$(monthly_cost_for_provider "$provider")"; fi
  step "Destroy this server?"
  printf 'This will terminate: %s\n' "$target"
  printf 'Monthly cost that stops: %s.\n' "$cost"
  printf 'This cannot be undone. Type DESTROY to continue: '
  local answer
  if ! read -r answer; then
    printf '\n'
    die "confirmation required. Nothing was destroyed"
  fi
  [ "$answer" = "DESTROY" ] || die "confirmation did not match. Nothing was destroyed"

  case "$provider" in
    aws) provision_teardown ;;
    gcp) destroy_gcp ;;
    hetzner) destroy_hetzner ;;
  esac
  destroy_clear_config
  ok "local configuration cleared. Fiddy no longer points at the destroyed server"
}
