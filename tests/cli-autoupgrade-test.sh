#!/usr/bin/env bash
# Regression: local auto-upgrade must not delete Snapchain while adding CLI updates.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fiddy-autoupgrade-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/repo" "$WORK/bin" "$WORK/fiddy-home/snapchain" "$WORK/home"
(
  cd "$ROOT"
  tar --exclude=.git -cf - .
) | (
  cd "$WORK/repo"
  tar -xf -
)
# bin/fiddy enables CLI self-update only for a repository with a .git directory.
mkdir "$WORK/repo/.git"
printf '%s\n' 'SKIP_CRONTAB=true' > "$WORK/fiddy-home/snapchain/.env"

export HOME="$WORK/home"
export FIDDY_HOME="$WORK/fiddy-home"
export CRON_STATE="$WORK/crontab"
export PATH="$WORK/bin:$PATH"

cat > "$CRON_STATE" <<'CRON'
17 2 * * 1 /opt/keep/me
0 3 * * 2 /old/snapchain.sh autoupgrade >> /old/snapchain.log 2>&1
0 * * * * git -C /old/repo pull --ff-only >> /old/self-update.log 2>&1 # fiddy self-update
CRON

cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -l)
    if [ -f "$CRON_STATE" ]; then
      /bin/cat "$CRON_STATE"
    else
      exit 1
    fi
    ;;
  -)
    /bin/cat > "$CRON_STATE.next"
    /bin/mv "$CRON_STATE.next" "$CRON_STATE"
    ;;
  *)
    printf 'unexpected crontab arguments: %s\n' "$*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$WORK/bin/crontab"

bash "$WORK/repo/bin/fiddy" node autoupgrade on --every hourly > "$WORK/output" 2>&1
REPO_REAL=$(cd "$WORK/repo" && pwd -P)

assert_line_count() {
  local expected=$1
  local line=$2
  local actual
  actual=$(grep -Fxc "$line" "$CRON_STATE" || true)
  if [ "$actual" -ne "$expected" ]; then
    printf 'FAIL: expected %d copies of <%s>, got %d\n' "$expected" "$line" "$actual" >&2
    printf '%s\n' '--- resulting crontab ---' >&2
    /bin/cat "$CRON_STATE" >&2
    printf '%s\n' '--- CLI output ---' >&2
    /bin/cat "$WORK/output" >&2
    exit 1
  fi
}

assert_line_count 1 '17 2 * * 1 /opt/keep/me'
assert_line_count 1 "0 * * * * $FIDDY_HOME/snapchain/snapchain.sh autoupgrade >> $FIDDY_HOME/snapchain/snapchain-autoupgrade.log 2>&1"
assert_line_count 1 "0 * * * * git -C $REPO_REAL pull --ff-only >> $FIDDY_HOME/self-update.log 2>&1 # fiddy self-update"
assert_line_count 0 '0 3 * * 2 /old/snapchain.sh autoupgrade >> /old/snapchain.log 2>&1'
assert_line_count 0 '0 * * * * git -C /old/repo pull --ff-only >> /old/self-update.log 2>&1 # fiddy self-update'

printf '%s\n' 'PASS: local auto-upgrade preserves Snapchain, CLI self-update, and unrelated cron entries'
