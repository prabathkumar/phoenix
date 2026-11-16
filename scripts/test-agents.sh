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
run "engine: logger (batching, retry, masking-ready capture)" node engine/test/logger.test.js
run "backend: logs, masking, batching, training gate, KPIs, leakage, TMMI, connectors" bash -c 'cd backend && python3 -m pytest tests/test_logs_training.py -q'
run "backend integration: real unit and integration runs per language" bash -c 'cd backend && python3 -m pytest tests/integration -q -rs'
run "NEGATIVE backend: ingest, masking, training gates, connectors, scans, sign-off, guardrails, pipeline" bash -c 'cd backend && python3 -m pytest tests/test_negative.py tests/test_negative_pipeline.py -q'
run "NEGATIVE engine: checks, named targets, verdicts, agents, mobile, logger" node engine/test/negative.test.js
run "NEGATIVE frontend: release API (traversal, token, uploads, bad bodies)" node frontend/test/negative.test.js
run "NEGATIVE mcp: unknown tools, bad arguments, Phoenix down" node mcp/test/negative.test.js
run "backend: saved agents, roster, avatars, run by name" bash -c 'cd backend && python3 -m pytest tests/test_agents.py -q'
run "mcp: agent and avatar tools" bash -c 'cd mcp && node test/server.test.js'
if [ "${1:-}" != "--unit-only" ]; then
run "integration: all agents on a real browser against a fake store (needs Chromium)" node engine/test/integration/release-agents.integration.test.js
fi
[ $fail -eq 0 ] && echo "ALL AGENT TESTS PASSED" || { echo "SOME AGENT TESTS FAILED"; exit 1; }
