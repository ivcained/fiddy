# shellcheck shell=bash
# shellcheck disable=SC1091
# Guided setup for people who should never need to know the command inventory.

source "$FIDDY_REPO/cli/provision.sh"

start_monthly_cost() { # provider -> display string, never a silently free guess
  monthly_cost_for_provider "$1"
}

start_confirm_cost() { # provider; only an empty line authorizes creation
  local provider="$1" answer
  step "Cost before anything is created"
  printf 'Monthly cost: %s\n' "$(start_monthly_cost "$provider")"
  printf 'Press Enter to create the %s server, or type anything else to cancel. ' "$provider"
  if ! read -r answer; then
    printf '\n'
    die "cost confirmation required. Nothing was created"
  fi
  [ -z "$answer" ] || die "cost was not confirmed. Nothing was created"
}

start_run_up() {
  source "$FIDDY_REPO/cli/doctor.sh"
  source "$FIDDY_REPO/cli/node.sh"
  source "$FIDDY_REPO/cli/client.sh"
  doctor_main
  node_main up
  client_main up --tunnel
}

start_main() {
  [ "$#" -eq 0 ] || die "fiddy start is interactive and takes no flags. Run: fiddy start"
  config_load

  step "Welcome to Fiddy"
  printf 'I will help you run your own Farcaster client and node.\n'
  printf 'The first download takes hours. Your provider bills you directly.\n\n'

  local has_server provider choice target
  printf 'Do you already have a server? [y/N] '
  read -r has_server || die "setup cancelled before anything changed"

  case "$has_server" in
    [yY]*)
      printf "What's the user@IP? "
      read -r target || die "setup cancelled before anything changed"
      if [[ ! "$target" =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$ ]]; then
        die "use the SSH address in the form user@IP, for example ubuntu@203.0.113.10"
      fi
      provision_main --ssh "$target"
      ;;
    *)
      step "Pick your cloud provider"
      printf "  1. AWS (~\$285/mo)\n"
      printf '  2. Hetzner (~€120/mo)\n'
      printf "  3. OVHcloud (~\$190/mo)\n"
      printf "  4. Google Cloud (~\$350/mo)\n"
      printf 'Choose 1-4 [1]: '
      read -r choice || die "setup cancelled before anything was created"
      case "${choice:-1}" in
        1) provider=aws ;;
        2) provider=hetzner ;;
        3) provider=ovh ;;
        4) provider=gcp ;;
        *) die "choose a provider from 1 to 4. Nothing was created" ;;
      esac
      start_confirm_cost "$provider"
      provision_main "--$provider"
      ;;
  esac

  start_run_up
}
