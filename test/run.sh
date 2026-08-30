#!/usr/bin/env bash
# Run the whole ham test suite and report a combined pass/fail.
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

run "ham_commands (Lua) — :Ham open/close/toggle" nvim --headless -l test/ham_commands_test.lua
run "scroll (Lua) — no scroll-to-bottom"          nvim --headless -l test/scroll_test.lua
run "retry (Lua) — /retry re-asks last query"     nvim --headless -l test/retry_test.lua
run "cancel (Lua) — /cancel abandons in-flight"   nvim --headless -l test/cancel_test.lua
run "explain (Lua) — /explain the yank register"  nvim --headless -l test/explain_test.lua
run "captcha_teardown (Lua) — clear/crash mid-solve" nvim --headless -l test/captcha_teardown_test.lua
run "health (Lua) — query-mode status line"        nvim --headless -l test/health_test.lua
run "ensure_page (Node) — reuse-vs-new tab"       node test/ensure_page_test.js
run "fill_composer (Node) — multi-line query"     node test/fill_composer_test.js
run "keep_awake (Node) — visibility spoof"        node test/keep_awake_test.js
run "captcha_detect (Node) — bot-check detection"  node test/captcha_detect_test.js
run "first_turn_baseline (Node) — no early truncate" node test/first_turn_baseline_test.js
run "await_captcha (Node) — solved-detection"      node test/await_captcha_test.js
run "http_fetcher (Node) — token chaining"         node test/http_fetcher_test.js
run "cancel_abort (Node) — fetch abort wiring"     node test/cancel_abort_test.js
run "html_markdown (Node) — HTML→Markdown"         node test/html_markdown_test.js
run "profile_cookies (Node) — cookies.sqlite read" node test/profile_cookies_test.js

echo "======================================================================"
echo "  Summary: ${#passed[@]} passed, ${#failed[@]} failed"
for t in "${passed[@]:-}"; do [ -n "$t" ] && echo "  PASS  $t"; done
for t in "${failed[@]:-}"; do [ -n "$t" ] && echo "  FAIL  $t"; done
echo "======================================================================"

[ ${#failed[@]} -eq 0 ]
