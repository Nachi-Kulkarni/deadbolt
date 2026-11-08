#!/bin/bash
# Runs the checks against dist/Deadbolt.app. One log per suite, each suite in its own empty dir.
#   scripts/check.sh            quick: selftest, matcher, ui --smoke (about 10s)
#   scripts/check.sh full       quick + e2e, e2e_ui, escape files+launchd, escape browser (about 6.5 min)
#   scripts/check.sh e2e ui     just the named suites (quick e2e ui esc browser)
# Prints one line per suite and exits non-zero if any failed.
set -u
cd "$(dirname "$0")/.."
export CHROME="${CHROME:-$HOME/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
export PW="${PW:-$HOME/.claude/skills/dev-browser/node_modules/playwright}"
[ -x "$CHROME" ] || { echo "CHROME not found: $CHROME"; exit 2; }
[ -d "$PW" ] || { echo "PW not found: $PW"; exit 2; }
BIN=dist/Deadbolt.app/Contents/MacOS/Deadbolt
[ -x "$BIN" ] || { echo "no build, run scripts/build.sh"; exit 2; }

RUN=logs/check-$(date +%Y%m%d-%H%M%S)
mkdir -p "$RUN"
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(quick)
[ "${suites[0]}" = full ] && suites=(quick e2e ui esc browser)
failed=0

run() { # name, command...
  local name=$1; shift
  local start=$SECONDS
  "$@" > "$RUN/$name.log" 2>&1
  local code=$?
  [ $code -ne 0 ] && failed=1
  printf '%-8s exit=%d %4ds  %s\n' "$name" $code $((SECONDS - start)) "$(grep -E 'passed|OK|ok' "$RUN/$name.log" | tail -1)"
  [ $code -ne 0 ] && grep -E 'FAIL' "$RUN/$name.log" | head -5
}

smoke() {
  local h="$RUN/smoke-home" ap
  mkdir -p "$h"
  DEADBOLT_HOME="$h" DEADBOLT_TEST_BROWSER_APP=/nonexistent DEADBOLT_DRY_DEVICE=1 "$BIN" agent > /dev/null 2>&1 &
  ap=$!
  sleep 1.5
  DEADBOLT_HOME="$h" "$BIN" ui --smoke
  local code=$?
  kill $ap; wait $ap 2>/dev/null
  return $code
}

suite_dir() { mkdir -p "$RUN/$1-dir"; echo "$PWD/$RUN/$1-dir"; }

for s in "${suites[@]}"; do
  case $s in
    quick)
      run selftest "$BIN" selftest
      run matcher node scripts/matcher_check.js
      run smoke smoke ;;
    e2e) run e2e env E2E_DIR="$(suite_dir e2e)" node scripts/e2e.js ;;
    ui) run ui env E2E_DIR="$(suite_dir ui)" node scripts/e2e_ui.js ;;
    esc) run esc env E2E_DIR="$(suite_dir esc)" node scripts/e2e_escape.js files launchd ;;
    browser) run browser env E2E_DIR="$(suite_dir browser)" node scripts/e2e_escape.js browser ;;
    *) echo "unknown suite $s"; failed=1 ;;
  esac
done

left=$(launchctl list | grep -c deadbolt)
[ "$left" -ne 0 ] && { echo "leftover deadbolt launchd jobs: $left"; failed=1; }
echo "logs: $RUN"
exit $failed
