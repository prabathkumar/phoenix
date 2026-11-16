#!/usr/bin/env bash
# Runs only the AI-agent tests, kept separate from the rest of the suite.
#   bash scripts/test-agents.sh
set -u
cd "$(dirname "$0")/.."
fail=0
run() { echo "== $1"; shift; "$@" || fail=1; }
run "engine: release agents (planner, runner, triage, healer, reporter, performance, security, mobile)" node engine/test/release-agents.test.js
run "engine: check steps (no error showing, page says, URL contains)" node engine/test/check-step.test.js
run "engine: suite runner and verdicts" node engine/test/suite-run.test.js
run "engine: page read first / named targets / blockers" node engine/test/named-target.test.js
run "frontend: release API, project keying, mobile apps, agent status" node frontend/test/release-endpoint.test.js
run "backend: saved agents, roster, avatars, run by name" bash -c 'cd backend && python3 -m pytest tests/test_agents.py -q'
run "mcp: agent and avatar tools" bash -c 'cd mcp && node test/server.test.js'
if [ "${1:-}" != "--unit-only" ]; then
run "integration: all agents on a real browser against a fake store (needs Chromium)" node engine/test/integration/release-agents.integration.test.js
fi
[ $fail -eq 0 ] && echo "ALL AGENT TESTS PASSED" || { echo "SOME AGENT TESTS FAILED"; exit 1; }
