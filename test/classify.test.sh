#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '{"enabled":false}\n' > "$tmp/config"
CASPER_CONFIG="$tmp/config" CASPER_FORCE=1 bash --norc -ic '
source "$1"
[[ ${CASPER_HOOK_ACTIVE:-} == 1 ]] || exit 1
for raw in "npm run dev" "make build" "sleep 3" "pytest tests/example.py"; do
  __casper_classify "$raw" || exit 2
  printf "%s:%s\n" "$CASPER_FAMILY" "$CASPER_SUBCOMMAND"
done
__casper_classify "curl secret" && exit 3
__casper_classify "false | true" && exit 4
exit 0
' bash "$root/bin/casper-hook" > "$tmp/actual"
printf 'npm:run\nmake:\nsleep:\npytest:\n' > "$tmp/expected"
diff -u "$tmp/expected" "$tmp/actual"
echo 'argument classification and disabled-at-start installation passed'
