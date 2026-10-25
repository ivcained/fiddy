#!/usr/bin/env bash
# Hermetic acceptance tests for the beginner CLI. No cloud, SSH, Docker, or
# client process is real: every external side effect stays in a temp sandbox.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0

new_case() {
  CASE_DIR="$TMP_ROOT/case-$((PASS + FAIL + 1))-${RANDOM}"
  FIDDY_HOME="$CASE_DIR/home"
  STUB_BIN="$CASE_DIR/bin"
  CALLS="$CASE_DIR/calls"
  OUT="$CASE_DIR/output"
  mkdir -p "$FIDDY_HOME" "$STUB_BIN"
  : > "$CALLS"
}

stub() { # stub NAME, script on stdin
  cat > "$STUB_BIN/$1"
  chmod +x "$STUB_BIN/$1"
}

run_fiddy() {
  set +e
  PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" CALLS="$CALLS" \
    bash "$ROOT/bin/fiddy" "$@" > "$OUT" 2>&1
  STATUS=$?
  set -e
  OUTPUT="$(cat "$OUT")"
}

run_fiddy_input() { # input first, then CLI args
  local input="$1"
  shift
  set +e
  printf '%b' "$input" | PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" CALLS="$CALLS" \
    bash "$ROOT/bin/fiddy" "$@" > "$OUT" 2>&1
  STATUS=$?
  set -e
  OUTPUT="$(cat "$OUT")"
}

record() { # test name; increments after its assertions
  TEST_NAME="$1"
}

check() { # check CONDITION_COMMAND... -- DESCRIPTION
  local description="${!#}"
  local command=("${@:1:$#-1}")
  if "${command[@]}"; then
    PASS=$((PASS + 1))
    printf 'ok %d - %s\n' "$PASS" "$description"
  else
    FAIL=$((FAIL + 1))
    printf 'not ok - %s\n' "$description" >&2
    printf '  status=%s\n  output:\n%s\n' "${STATUS:-unset}" "${OUTPUT:-}" >&2
  fi
}

assert_status() { [ "$STATUS" -eq "$1" ]; }
assert_output_contains() { case "$OUTPUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
assert_output_not_contains() { ! assert_output_contains "$1"; }
assert_file_contains() { grep -Fq -- "$2" "$1"; }
assert_config_value() { local key="$1" expected="$2"; ( . "$FIDDY_HOME/config"; [ "${!key}" = "$expected" ] ); }
assert_calls_contain() { grep -Fq "$1" "$CALLS"; }
assert_calls_empty() { [ ! -s "$CALLS" ]; }
assert_output_one_line() { [[ "$OUTPUT" != *$'\n'* ]]; }

write_status_config() {
  cat > "$FIDDY_HOME/config" <<'CONFIG'
FIDDY_TARGET=ubuntu@203.0.113.10
FIDDY_PROVIDER=aws
FIDDY_NODE_HTTP=http://203.0.113.10:3381
FIDDY_MONTHLY_COST='~$304/mo'
FIDDY_WEB_URL=http://localhost:3000
CONFIG
}

write_aws_destroy_config() {
  cat > "$FIDDY_HOME/config" <<'CONFIG'
FIDDY_TARGET=ubuntu@203.0.113.10
FIDDY_PROVIDER=aws
FIDDY_AWS_INSTANCE_ID=i-0123456789abcdef0
FIDDY_AWS_REGION=us-east-1
FIDDY_MONTHLY_COST='~$304/mo'
CONFIG
}

write_hetzner_destroy_config() {
  cat > "$FIDDY_HOME/config" <<'CONFIG'
FIDDY_TARGET=root@203.0.113.11
FIDDY_PROVIDER=hetzner
FIDDY_HETZNER_SERVER_ID=12345
FIDDY_HETZNER_VOLUME_ID=67890
FIDDY_MONTHLY_COST='~€230/mo'
CONFIG
}

write_gcp_destroy_config() {
  cat > "$FIDDY_HOME/config" <<'CONFIG'
FIDDY_TARGET=ubuntu@203.0.113.12
FIDDY_PROVIDER=gcp
FIDDY_GCP_NAME=fiddy-node
FIDDY_GCP_ZONE=us-central1-a
FIDDY_MONTHLY_COST='~$180/mo'
CONFIG
}

run_start_with_stubs() { # input first, then start args
  local input="$1"
  shift
  set +e
  printf '%b' "$input" | PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" CALLS="$CALLS" \
    bash -c '
      source "$FIDDY_REPO/cli/lib/common.sh"
      source "$FIDDY_REPO/cli/provision.sh"
      source "$FIDDY_REPO/cli/start.sh"
      provision_main() { printf "provision %s\\n" "$*" >> "$CALLS"; }
      start_run_up() { printf "doctor-node-client\\n" >> "$CALLS"; }
      start_main "$@"
    ' _ "$@" > "$OUT" 2>&1
  STATUS=$?
  set -e
  OUTPUT="$(cat "$OUT")"
}

run_start_mock_ssh() {
  local input="$1"
  stub ssh <<'SSH'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$CALLS"
case "$*" in
  *fiddy-ok*) printf 'fiddy-ok\nLinux x86_64\nDocker version 28.0.0\n' ;;
  *nproc*) printf '8 32 2048\n' ;;
esac
SSH
  set +e
  printf '%b' "$input" | PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" CALLS="$CALLS" \
    bash -c '
      source "$FIDDY_REPO/cli/lib/common.sh"
      source "$FIDDY_REPO/cli/start.sh"
      start_run_up() { printf "doctor-node-client\\n" >> "$CALLS"; }
      start_main
    ' > "$OUT" 2>&1
  STATUS=$?
  set -e
  OUTPUT="$(cat "$OUT")"
}

run_destroy_with_stubs() {
  local input="$1"
  shift
  set +e
  printf '%b' "$input" | PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" CALLS="$CALLS" HCLOUD_TOKEN=test-token \
    bash -c '
      set -e
      source "$FIDDY_REPO/cli/lib/common.sh"
      source "$FIDDY_REPO/cli/provision.sh"
      source "$FIDDY_REPO/cli/destroy.sh"
      provision_teardown() { printf "aws-teardown\\n" >> "$CALLS"; }
      destroy_main "$@"
    ' _ "$@" > "$OUT" 2>&1
  STATUS=$?
  set -e
  OUTPUT="$(cat "$OUT")"
}

record 'fiddy start cannot bypass its cost gate with a flag'
new_case
run_fiddy start --yes
check assert_status 1 -- 'start rejects --yes'
check assert_output_contains 'fiddy start is interactive and takes no flags' -- 'start names the safe interface'

record 'cloud creation stops unless Enter confirms the monthly cost'
new_case
run_start_with_stubs 'n\n1\n'
check assert_status 1 -- 'an interrupted cost prompt fails closed'
check assert_output_contains 'Monthly cost:' -- 'the gate names a monthly cost'
check assert_output_contains 'Press Enter to create' -- 'the gate asks for Enter'
check assert_calls_empty -- 'nothing is provisioned without confirmation'

record 'an empty line confirms the displayed price and runs the existing up chain'
new_case
run_start_with_stubs 'n\n1\n\n'
check assert_status 0 -- 'confirmed setup succeeds'
check assert_calls_contain 'provision --aws' -- 'the selected provider is provisioned'
check assert_calls_contain 'doctor-node-client' -- 'doctor, node, and client run after provisioning'

record 'typing at the cost gate cancels instead of provisioning'
new_case
run_start_with_stubs 'n\n2\nyes\n'
check assert_status 1 -- 'a non-empty cost answer cancels'
check assert_output_contains '~€230/mo' -- 'Hetzner shows its monthly price'
check assert_calls_empty -- 'a mistaken answer cannot spend money'

record 'the existing-server path runs against a mock SSH target'
new_case
run_start_mock_ssh 'y\nubuntu@203.0.113.10\n'
check assert_status 0 -- 'mock SSH setup succeeds'
check assert_output_contains 'Do you already have a server?' -- 'the first question uses plain language'
check assert_output_contains "What's the user@IP?" -- 'the server question asks for user@IP'
check assert_file_contains "$FIDDY_HOME/config" 'FIDDY_TARGET=ubuntu@203.0.113.10' -- 'the validated SSH target is saved'
check assert_file_contains "$FIDDY_HOME/config" 'FIDDY_PROVIDER=ssh' -- 'the existing server is not labelled as a cloud server'
check assert_calls_contain 'doctor-node-client' -- 'the SSH path also runs doctor, node, and client'

record 'an invalid SSH address stops before any SSH call'
new_case
run_start_mock_ssh 'y\nnot-an-address\n'
check assert_status 1 -- 'invalid SSH input fails'
check assert_output_contains 'user@IP' -- 'the error shows the expected shape'
check assert_calls_empty -- 'invalid input has no side effects'

record 'fiddy status turns a healthy info response into one useful sentence'
new_case
write_status_config
stub curl <<'CURL'
#!/usr/bin/env bash
printf '%s\n' '{"shardInfos":[{"shardId":1,"maxHeight":100,"blockDelay":4}],"version":"0.14.3"}'
CURL
run_fiddy status
check assert_status 0 -- 'healthy status succeeds'
check assert_output_one_line -- 'healthy status is one line'
check assert_output_contains 'Your node is answering and keeping up. Web: http://localhost:3000. Cost: ~$304/mo. Everything is fine.' -- 'healthy status uses plain English'
check assert_output_not_contains 'shardInfos' -- 'status never prints raw JSON'

record 'fiddy status explains snapshot progress and reuses the measured ETA'
new_case
write_status_config
now="$(date +%s)"
printf '938 %s\n' "$((now - 4800))" > "$FIDDY_HOME/snapshot-progress"
stub curl <<'CURL'
#!/usr/bin/env bash
exit 1
CURL
stub ssh <<'SSH'
#!/usr/bin/env bash
case "$*" in
  *'docker ps'*) printf 'Up 12 minutes\n' ;;
  *'docker logs'*) printf 'chunk_1938.bin\n' ;;
esac
SSH
run_fiddy status
check assert_status 0 -- 'an expected snapshot bootstrap is not a failure'
check assert_output_one_line -- 'bootstrap status is one line'
check assert_output_contains 'Your node is 34% synced (~5 h left).' -- 'bootstrap status includes percentage and measured ETA'
check assert_output_contains 'Web: http://localhost:3000. Cost: ~$304/mo. First download on this SSD usually takes 2-4 h. Everything is fine.' -- 'bootstrap status still includes web, cost, and reassurance'
check assert_output_not_contains 'chunk_1938' -- 'bootstrap status hides log noise'

record 'fiddy destroy names the machine and cost before refusing an unconfirmed teardown'
new_case
write_aws_destroy_config
run_destroy_with_stubs ''
check assert_status 1 -- 'destroy fails closed without confirmation'
check assert_output_contains 'i-0123456789abcdef0' -- 'destroy names the instance it would terminate'
check assert_output_contains 'Monthly cost that stops: ~$304/mo.' -- 'destroy names the bill that stops'
check assert_calls_empty -- 'no teardown runs without confirmation'

record 'typing DESTROY is the only AWS teardown confirmation'
new_case
write_aws_destroy_config
run_destroy_with_stubs 'DESTROY\n'
check assert_status 0 -- 'confirmed AWS destroy succeeds'
check assert_calls_contain 'aws-teardown' -- 'confirmation reaches the existing AWS teardown path'

record 'destroy has no force flag'
new_case
write_aws_destroy_config
run_destroy_with_stubs '' --yes
check assert_status 1 -- 'destroy rejects --yes'
check assert_output_contains 'takes no flags' -- 'destroy explains its safe interface'
check assert_calls_empty -- 'the flag cannot terminate anything'

record 'Hetzner destroy deletes both billing resources and verifies they are gone'
new_case
write_hetzner_destroy_config
stub curl <<'CURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CALLS"
method=GET
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$method" = DELETE ]; then printf '204'; else printf '404'; fi
CURL
run_destroy_with_stubs 'DESTROY\n'
check assert_status 0 -- 'confirmed Hetzner destroy succeeds'
check assert_output_contains 'server 12345 and volume 67890' -- 'Hetzner confirmation names both resources'
check assert_output_contains 'Monthly cost that stops: ~€230/mo.' -- 'Hetzner confirmation names the monthly bill'
check assert_calls_contain 'Authorization: Bearer' -- 'Hetzner teardown authenticates to the API'
check assert_calls_contain 'DELETE https://api.hetzner.cloud/v1/servers/12345' -- 'Hetzner server is deleted'
check assert_calls_contain 'DELETE https://api.hetzner.cloud/v1/volumes/67890' -- 'Hetzner volume is deleted too'
check assert_file_contains "$FIDDY_HOME/config" "FIDDY_TARGET=''" -- 'the stale target is cleared after teardown'

record 'Hetzner provisioning saves the ids and price needed by status and destroy'
new_case
stub bash <<'BASH'
#!/bin/bash
printf '203.0.113.11\n' > "$FIDDY_HOME/hetzner-last-ip"
printf '12345\n' > "$FIDDY_HOME/hetzner-last-server-id"
printf '67890\n' > "$FIDDY_HOME/hetzner-last-volume-id"
BASH
set +e
PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" CALLS="$CALLS" \
  /bin/bash -c 'source "$FIDDY_REPO/cli/lib/common.sh"; source "$FIDDY_REPO/cli/provision.sh"; provision_hetzner' > "$OUT" 2>&1
STATUS=$?
set -e
OUTPUT="$(cat "$OUT")"
check assert_status 0 -- 'mock Hetzner provisioning succeeds'
check assert_file_contains "$FIDDY_HOME/config" 'FIDDY_HETZNER_SERVER_ID=12345' -- 'the server id is saved'
check assert_file_contains "$FIDDY_HOME/config" 'FIDDY_HETZNER_VOLUME_ID=67890' -- 'the volume id is saved'
check assert_config_value FIDDY_MONTHLY_COST '~€230/mo' -- 'the monthly price is saved'
check assert_file_contains "$ROOT/scripts/hetzner-deploy.sh" 'hetzner-last-server-id' -- 'the real deploy script records the server id'
check assert_file_contains "$ROOT/scripts/hetzner-deploy.sh" 'hetzner-last-volume-id' -- 'the real deploy script records the volume id'
check assert_file_contains "$ROOT/scripts/hetzner-deploy.sh" 'Authorization: Bearer $TOKEN' -- 'the real deploy script sends the token instead of a redaction placeholder'

record 'the GCP provisioner records the measured price used by status'
new_case
stub gcloud <<'GCLOUD'
#!/usr/bin/env bash
case "$*" in
  *'instances describe'*) printf '203.0.113.12\n' ;;
  *'config get-value project'*) printf 'fiddy-test\n' ;;
  *) printf '%s\n' "$*" >> "$CALLS" ;;
esac
exit 0
GCLOUD
set +e
PATH="$STUB_BIN:$PATH" FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" CALLS="$CALLS" \
  /bin/bash -c 'source "$FIDDY_REPO/cli/lib/common.sh"; source "$FIDDY_REPO/cli/provision.sh"; provision_gcp' > "$OUT" 2>&1
STATUS=$?
set -e
OUTPUT="$(cat "$OUT")"
check assert_status 0 -- 'mock GCP provisioning succeeds'
check assert_config_value FIDDY_MONTHLY_COST '~$180/mo' -- 'the recorded GCP price is updated'

record 'the AWS cost gate uses the same calculated list estimate as provisioning'
new_case
export FIDDY_AWS_INSTANCE_HOURLY=0.192 FIDDY_AWS_VOLUME_GB=2048 FIDDY_AWS_GP3_GB_MONTH=0.08
run_start_with_stubs 'n\n1\n'
unset FIDDY_AWS_INSTANCE_HOURLY FIDDY_AWS_VOLUME_GB FIDDY_AWS_GP3_GB_MONTH
check assert_output_contains 'Monthly cost: ~$304/mo' -- 'the gate shows the real AWS instance-plus-disk estimate'
check assert_calls_empty -- 'showing the calculated estimate still creates nothing'

record 'the start menu offers six provider paths with updated prices'
new_case
run_start_with_stubs 'n\n9\n'
check assert_status 1 -- 'an unknown provider choice stops'
check assert_output_contains '1. AWS (~$304/mo)' -- 'the menu shows the AWS estimate'
check assert_output_contains '2. Hetzner (~€230/mo)' -- 'the menu shows the Hetzner estimate'
check assert_output_contains '5. BuyVM ($80/mo, manual order)' -- 'the menu shows the BuyVM estimate'
check assert_output_contains '6. Hetzner auction (dynamic price, manual order)' -- 'the menu shows the Hetzner auction path'
check assert_calls_empty -- 'an unknown provider choice creates nothing'

record 'GCP destroy deletes its recorded instance and names the stop'
new_case
write_gcp_destroy_config
stub gcloud <<'GCLOUD'
#!/usr/bin/env bash
printf 'gcloud %s\n' "$*" >> "$CALLS"
case "$*" in
  *'instances delete'*) ;;
  *'instances describe'*) exit 1 ;;
esac
exit 0
GCLOUD
run_destroy_with_stubs 'DESTROY\n'
check assert_status 0 -- 'confirmed GCP destroy succeeds'
check assert_output_contains 'fiddy-node in us-central1-a' -- 'GCP confirmation names the recorded instance'
check assert_output_contains 'Monthly cost that stops: ~$180/mo.' -- 'GCP confirmation names the monthly bill'
check assert_calls_contain 'instances delete fiddy-node' -- 'GCP deletes the recorded instance'
check assert_calls_contain 'firewall-rules delete snapchain-node' -- 'GCP removes the Fiddy firewall rule'
check assert_config_value FIDDY_TARGET '' -- 'GCP teardown clears the target'

record 'the remote installer does not claim a safe quit point before the first chunk'
new_case
set +e
FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" FIDDY_TARGET=ubuntu@203.0.113.10 \
  /bin/bash -c 'source "$FIDDY_REPO/cli/lib/common.sh"; source "$FIDDY_REPO/cli/networks.sh"; source "$FIDDY_REPO/cli/node.sh"; ssh_run(){ return 0; }; remote_start_upgrade 0' > "$OUT" 2>&1
STATUS=$?
set -e
OUTPUT="$(cat "$OUT")"
check assert_status 0 -- 'mock detached install succeeds'
check assert_output_not_contains 'you can close your laptop now, it keeps going' -- 'detaching alone is not enough to promise a working download'

record 'node-up announces the safe quit point only after the first chunk appears'
new_case
set +e
FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" FIDDY_TARGET=ubuntu@203.0.113.10 \
  /bin/bash -c 'source "$FIDDY_REPO/cli/lib/common.sh"; source "$FIDDY_REPO/cli/networks.sh"; source "$FIDDY_REPO/cli/node.sh"; curl(){ printf "still-waiting"; return 1; }; snapshot_progress(){ printf "downloading snapshot: chunk 1938/5690 (34%%)"; }; ssh_run(){ printf "Up\n"; }; sleep(){ :; }; pipefail(){ :; }; node_wait_or_report http://203.0.113.10:3381 203.0.113.10 1' > "$OUT" 2>&1
STATUS=$?
set -e
OUTPUT="$(cat "$OUT")"
check assert_status 0 -- 'mock remote wait completes'
check assert_output_contains 'you can close your laptop now, it keeps going' -- 'the honest quit point appears at the first chunk'

record 'a node-up wait without any chunk does not tell the laptop to close'
new_case
set +e
FIDDY_HOME="$FIDDY_HOME" FIDDY_REPO="$ROOT" FIDDY_TARGET=ubuntu@203.0.113.10 \
  /bin/bash -c 'source "$FIDDY_REPO/cli/lib/common.sh"; source "$FIDDY_REPO/cli/networks.sh"; source "$FIDDY_REPO/cli/node.sh"; curl(){ return 1; }; snapshot_progress(){ printf "preparing the snapshot download"; }; ssh_run(){ printf "Up\n"; }; sleep(){ :; }; node_wait_or_report http://203.0.113.10:3381 203.0.113.10 1' > "$OUT" 2>&1
STATUS=$?
set -e
OUTPUT="$(cat "$OUT")"
check assert_status 0 -- 'mock wait without a chunk completes'
check assert_output_not_contains 'you can close your laptop now, it keeps going' -- 'the safe quit point is withheld until a chunk exists'

record 'the client records and serves the web URL status prints'
new_case
check assert_file_contains "$ROOT/cli/client.sh" 'FIDDY_WEB_URL' -- 'client up records its web URL'
check assert_file_contains "$ROOT/cli/client.sh" '--port "$web_port" --strictPort' -- 'client up uses the recorded port instead of a guessed default'

printf '\n%d checks, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
