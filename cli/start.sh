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

start_register_server() { # validated SSH target -> provision_ssh
  local target="$1"
  if [[ ! "$target" =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$ ]]; then
    die "use the SSH address in the form user@IP, for example ubuntu@203.0.113.10"
  fi
  provision_main --ssh "$target"
}

start_manual_path() { # provider target-prompt; 0 only when a server is registered
  local provider="$1" prompt="$2"
  step "Order the $provider server first"
  printf 'This one is a manual order: Fiddy cannot create it for you.\n'
  printf 'Buy 4 vCPU, 16 GB RAM, and at least 2 TB of disk that stays mounted.\n'
  printf "What's the user@IP? (leave blank to stop here) "
  local target
  read -r target || die "setup cancelled before anything changed"
  [ -n "$target" ] || { ok "$prompt"; return 1; }
  start_register_server "$target"
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
  provider=""
  printf 'Do you already have a server? [y/N] '
  read -r has_server || die "setup cancelled before anything changed"

  case "$has_server" in
    [yY]*)
      printf "What's the user@IP? "
      read -r target || die "setup cancelled before anything changed"
      start_register_server "$target"
      ;;
    *)
      step "Pick your cloud provider"
      printf "  1. AWS (~\$304/mo)\n"
      printf '  2. Hetzner (~€230/mo)\n'
      printf "  3. OVHcloud (~\$190/mo)\n"
      printf "  4. Google Cloud (~\$180/mo)\n"
      printf "  5. BuyVM (\$80/mo, manual order)\n"
      printf '  6. Hetzner auction (dynamic price, manual order)\n'
      printf 'Choose 1-6 [1]: '
      read -r choice || die "setup cancelled before anything was created"
      case "${choice:-1}" in
        1) provider=aws ;;
        2) provider=hetzner ;;
        3) provider=ovh ;;
        4) provider=gcp ;;
        5)
          step "BuyVM manual order"
          printf 'Order Slice 16384 (%s/mo: 4 cores, 16 GB RAM) plus a 4 TB Performance slab (%s/mo).\n' "\$60" "\$20"
          printf 'Confirm the Performance tier and stock before paying; Classic slabs cap at 200 IOPS.\n'
          printf 'Order links: https://buyvm.net/kvm-dedicated-server-slices/ and https://buyvm.net/block-storage-slabs/\n'
          start_manual_path BuyVM "BuyVM costs about \$80/mo before tax. Nothing was ordered or created" || return 0
          ;;
        6)
          step "Hetzner auction manual order"
          printf 'Pick a server with 4 CPU cores, 16 GB RAM, and two disks.\n'
          printf 'A recent auction listing was an i7-6700 with 32 GB RAM and 2x4 TB disks at EUR 72.70/mo before VAT.\n'
          printf 'Prices and stock change constantly, so verify the actual listing at checkout: https://www.hetzner.com/sb/\n'
          start_manual_path "Hetzner auction" "auction pricing changes, so no price was confirmed. Nothing was ordered or created" || return 0
          ;;
        *) die "choose a provider from 1 to 6. Nothing was created" ;;
      esac
      if [ -z "${provider:-}" ]; then start_run_up; return 0; fi
      start_confirm_cost "$provider"
      provision_main "--$provider"
      ;;
  esac

  start_run_up
}
