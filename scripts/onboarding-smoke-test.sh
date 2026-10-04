#!/usr/bin/env bash
# One-command automated half of docs/DEV_ONBOARDING_CHECKLIST.md.
#
# Runs, in the same order as the architecture diagram's blocks:
#   check-env.js (pre-flight, zero cost) -> capture -> generation -> engine
#   -> live-view -> frontend -> mcp
#
# This does NOT replace the manual, real-device test cases in the
# checklist doc -- those need an actual BrowserStack/device session and
# are listed individually there. This script only proves the code-level
# half: "does every unit suite for every block still pass."
#
# Usage: ./scripts/onboarding-smoke-test.sh [path-to-.env] [test-case-file]
#   Both args optional. If given, check-env.js also validates that env
#   file against that test case's required vars; otherwise only the
#   basic provider/credential checks run.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${1:-.env}"
TEST_CASE_FILE="${2:-}"

PASS=0
FAIL=0
RESULTS=()

run_block() {
  local name="$1"
  shift
  echo ""
  echo "=== ${name} ==="
  if "$@"; then
    RESULTS+=("PASS  ${name}")
    PASS=$((PASS + 1))
  else
    RESULTS+=("FAIL  ${name}")
    FAIL=$((FAIL + 1))
  fi
}

# --- Pre-flight ------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  if [ -n "$TEST_CASE_FILE" ]; then
    run_block "Pre-flight (check-env.js)" node check-env.js --env-file "$ENV_FILE" "$TEST_CASE_FILE"
  else
    run_block "Pre-flight (check-env.js)" node check-env.js --env-file "$ENV_FILE"
  fi
else
  echo ""
  echo "=== Pre-flight (check-env.js) ==="
  echo "SKIPPED -- no $ENV_FILE found. Pass one explicitly: ./scripts/onboarding-smoke-test.sh /path/to/.env"
  RESULTS+=("SKIP  Pre-flight (check-env.js)")
fi

# --- Layer 1: Guided recording ---------------------------------------------
run_block "Layer 1 - Guided recording (capture/)" bash -c "cd '$ROOT/capture' && npm test"
run_block "Layer 1 - Script generation (generation/)" bash -c "cd '$ROOT/generation' && npm test"

# --- Layer 2/4/integration: engine ------------------------------------------
run_block "Layer 2/4 + integration (engine/)" bash -c "cd '$ROOT/engine' && npm test"

# --- Wiring: live-view + frontend -------------------------------------------
run_block "Live-view wiring (live-view/)" bash -c "cd '$ROOT/live-view' && npm test"
run_block "Frontend upload/endpoint (frontend/)" bash -c "cd '$ROOT/frontend' && npm test"

# --- Supporting infra: MCP connector -----------------------------------------
run_block "MCP connector (mcp/)" bash -c "cd '$ROOT/mcp' && npm test"

# --- Summary -----------------------------------------------------------------
echo ""
echo "=================================================================="
echo " Onboarding smoke test summary"
echo "=================================================================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "  $PASS passed, $FAIL failed"
echo ""
echo "This covers the automated half only. See docs/DEV_ONBOARDING_CHECKLIST.md"
echo "for the manual, real-device test case that goes with each block --"
echo "those are not (and cannot safely be) automated here."

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
