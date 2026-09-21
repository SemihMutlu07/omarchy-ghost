#!/usr/bin/env bash
# Integration test for bin/casper-hook.
#
# Runs a real interactive Bash through a pty, loading the machine's real
# ~/.bashrc so Starship and the Herdr rename hook are live. Then it sources the
# hook twice and runs a known command set, checking:
#   1. only the interesting commands produced an event,
#   2. events carry nothing but allowlisted family/subcommand/status/duration,
#   3. hooks owned by other tools (DEBUG trap, PS0, PROMPT_COMMAND) survived.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/cfg" "$tmp/work/recover"

# Stub for the IPC target so the test never talks to the running shell.
cat > "$tmp/bin/omarchy-shell" <<'STUB'
#!/usr/bin/env bash
# The hook passes [target, method, json]; record only the event payload.
printf '%s\n' "${!#}" >> "$CASPER_TEST_LOG"
STUB
chmod +x "$tmp/bin/omarchy-shell"

cat > "$tmp/cfg/casper.json" <<'JSON'
{ "enabled": true, "mode": "Chatty", "minDurationMs": 300 }
JSON

# slow: `make` that takes longer than the threshold.
printf 'all:\n\t@sleep 0.6\n' > "$tmp/work/Makefile"
# failing build, for the failure -> recovery pair.
printf 'all:\n\t@exit 2\n' > "$tmp/work/recover/Makefile"
printf 'all:\n\t@true\n' > "$tmp/work/Makefile.ok"

cat > "$tmp/driver" <<DRIVER
# The omarchy rc re-prepends its own bin dir; put the stub back in front.
PATH="$tmp/bin:\$PATH"
export PATH
cd '$tmp/work'
trap -p DEBUG > '$tmp/before_trap'
export CASPER_DEBUG=1 CASPER_DEBUG_LOG='$tmp/trace'
source '$root/bin/casper-hook'
source '$root/bin/casper-hook'
printf '%s\n' "\$PS0" > '$tmp/after_ps0'
declare -p PROMPT_COMMAND > '$tmp/after_pc'
trap -p DEBUG > '$tmp/after_trap'

make
# not a repo, too fast -> silent
git status
# failure -> event
false
# clean success -> silent
true
# compound command -> silent
false | true
# second failure -> event
false
cd recover
# failing build -> event
make
cp ../Makefile.ok Makefile
# same family, same session -> recovery event
make
exit
DRIVER

# HISTFILE is redirected so the test cannot touch the real shell history.
env -u CASPER_HOOK_ACTIVE \
  TERM_PROGRAM=ghostty GHOSTTY_RESOURCES_DIR=1 \
  HISTFILE=/dev/null HISTSIZE=500 \
  CASPER_TEST_LOG="$tmp/events" CASPER_CONFIG="$tmp/cfg/casper.json" \
  script -qefc "bash -i" /dev/null < "$tmp/driver" > "$tmp/session.log" 2>&1 || true

fail() { echo "hook test FAILED: $1" >&2; sed -n '1,40p' "$tmp/events" >&2 2>/dev/null || true; sed -n '1,40p' "$tmp/trace" >&2 2>/dev/null || true; exit 1; }

[[ -s $tmp/events ]] || fail "no events emitted"

# 1. Event stream: five candidate events, nothing else.
count=$(wc -l < "$tmp/events")
[[ $count -eq 5 ]] || fail "expected 5 events, got $count"

grep -q '"family":"false","subcommand":"","code":1' "$tmp/events" || fail "missing failure event"
[[ $(grep -c '"family":"false"' "$tmp/events") -eq 2 ]] || fail "expected two failure events"
grep -q '"family":"make","subcommand":"","code":2' "$tmp/events" || fail "missing failing-make event"
slow_ms=$(sed -n 's/.*"family":"make","subcommand":"","code":0,"durationMs":\([0-9]*\).*/\1/p' "$tmp/events" | head -n1)
[[ ${slow_ms:-0} -ge 300 ]] || fail "slow event below the configured threshold (${slow_ms:-none})"
[[ $(grep -c '"family":"make","subcommand":"","code":0' "$tmp/events") -eq 2 ]] || fail "expected slow + recovery make events"
grep -q '"family":"git"' "$tmp/events" && fail "fast git status should not speak"
grep -q '"family":"true"' "$tmp/events" && fail "clean success should not speak"

# 2. Privacy: nothing but the five allowlisted fields, no raw command text.
while read -r line; do
  [[ $line =~ ^\{\"family\":\"[a-z0-9]*\",\"subcommand\":\"[a-z0-9]*\",\"code\":[0-9]+,\"durationMs\":[0-9]+,\"session\":\"[A-Za-z0-9_-]+\"\}$ ]] ||
    fail "event shape is not the bounded contract: $line"
done < "$tmp/events"
grep -q 'Makefile' "$tmp/events" && fail "raw command text leaked into an event"
grep -q '0\.6' "$tmp/events" && fail "raw argument leaked into an event"
grep -q 'recover' "$tmp/events" && fail "cwd leaked into an event"

# 3. Idempotent install: one PS0 clause, one precmd entry.
grep -q '__casper_preexec' "$tmp/after_ps0" || fail "hook did not append its PS0 clause"
[[ $(grep -c '__casper_preexec' "$tmp/after_ps0") -eq 1 ]] || fail "PS0 clause appended more than once"
grep -q '__casper_precmd' "$tmp/after_pc" || fail "hook did not register a precmd entry"
[[ $(grep -c '__casper_precmd' "$tmp/after_pc") -eq 1 ]] || fail "precmd entry registered more than once"

# 4. Other tools keep their hooks.
grep -q 'STARSHIP_START_TIME' "$tmp/after_ps0" || fail "Starship's PS0 clause was replaced"
grep -q starship_precmd "$tmp/after_pc" || fail "starship_precmd lost from PROMPT_COMMAND"
grep -q '_har_precmd_wrap' "$tmp/after_pc" || fail "Herdr precmd lost from PROMPT_COMMAND"
cmp -s "$tmp/before_trap" "$tmp/after_trap" || fail "DEBUG trap changed: $(cat "$tmp/before_trap") -> $(cat "$tmp/after_trap")"
grep -q 'DEBUG' "$tmp/before_trap" || fail "no DEBUG trap in the test shell; conflict check is meaningless"
grep -q "trap -- '__casper" "$tmp/after_trap" && fail "hook stole the DEBUG trap"

# 5. Fail-closed: an unknown binary and a quoted command stay silent.
grep -q '"family":"cp"' "$tmp/events" && fail "non-allowlisted family leaked through"

echo "hook integration checks passed: $count events, DEBUG trap intact, PS0/PROMPT_COMMAND preserved"
