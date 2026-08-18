#!/usr/bin/env bash
# Run the whole nam test suite and report a combined pass/fail.
#   ./test/run.sh    (or: bash test/run.sh)
# Exits 0 if every test passes, 1 otherwise.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failed=()
passed=()

run() {
  local name="$1"; shift
  echo "======================================================================"
  echo "  $name"
  echo "======================================================================"
  if "$@"; then
    passed+=("$name")
  else
    failed+=("$name")
  fi
  echo
}

run "nam_commands (Lua) — :Nam open/close/toggle" nvim --headless -l test/nam_commands_test.lua
run "scroll (Lua) — no scroll-to-bottom"          nvim --headless -l test/scroll_test.lua
run "retry (Lua) — /retry re-asks last query"     nvim --headless -l test/retry_test.lua
run "ensure_page (Node) — reuse-vs-new tab"       node test/ensure_page_test.js

echo "======================================================================"
echo "  Summary: ${#passed[@]} passed, ${#failed[@]} failed"
for t in "${passed[@]:-}"; do [ -n "$t" ] && echo "  PASS  $t"; done
for t in "${failed[@]:-}"; do [ -n "$t" ] && echo "  FAIL  $t"; done
echo "======================================================================"

[ ${#failed[@]} -eq 0 ]
