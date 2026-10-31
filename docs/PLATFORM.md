# Phoenix platform: React + Python + Node engine, PostgreSQL, ClickHouse

One AI-driven platform. The UI follows the "AI and Guided AI modes" designs.

| Part | Technology | Job |
|---|---|---|
| UI | React (Vite), `web-ui/` | AI Test Manager, requirements, journey and approvals, test cases, sign-off, run result, guided step, performance, security, defects, code analyzer, AI evaluation, **monitoring dashboard**, AI gateway |
| API | Python 3.13, FastAPI, `backend/phoenix_api/` | Pipeline, gateway (prompts, guardrails, MCP, call log), Jira, GitHub/GitLab, requirements loader, traceability, unit-test generation, DeepEval, sign-off, dashboard |
| Execution engine | Node, `frontend/exec-endpoint.js` (`POST /api/engine/exec`) | Drives Chromium, Appium and BrowserStack. Only runs steps and reports; no planning, no Jira |
| System of record | **PostgreSQL** | Prompts and versions, MCP servers, guardrail rules, run records, test cases, executions, sign-offs and their audit trail |
| AI telemetry | **ClickHouse** | Every model call (id, model, latency, sizes, guardrail hits, never the text), DeepEval scores, stage outcomes and timings, execution events |
| Scanners | Locust, Semgrep, Gitleaks, ZAP daemon | Called by the API; each says "not set up" plainly when missing |

The older Node pages (`/pipeline`, `/gateway`, `/english` on port 8091) still work; the React app and the Python API replace them.

## Run it (Docker on your Mac)

```
cd /Users/prabathkumar/android-sdk/cmdline-tools/phoenix
git pull
cp .env.example .env        # set OLLAMA_HOST, the Jira/GitHub values you want, and the three passwords
docker compose --profile platform up --build
```

Open http://localhost:8000. Then check every component:

```
python3 scripts/validate_platform.py http://localhost:8000
```

Each line is PASS, FAIL, NOT SET UP (a tool, key or service is missing) or NEEDS YOU. The script exits 1 only on FAIL.

## Sign-off

- **Test case**: draft → waiting for sign-off → approved / rejected / changes requested. Editing an approved case sends it back to draft.
- **Release (run)**: judged on computed checks: cases approved, every case executed, no unresolved failures, no failed security stage, requirements covered. Failing checks can only be accepted with a written reason ("approve with exceptions"), which is recorded.
- **Four eyes**: whoever asked cannot approve (the AI asks as "Phoenix AI", so any person can decide). `PHOENIX_ALLOW_SELF_SIGNOFF=true` turns this off for a one-person team.
- Rejecting or asking for changes needs a reason. Every action is appended to an audit trail that is never edited.
- **Limit today:** the person is whoever the `X-User` header / "signed in as" box says. There is no login or role check yet, so anyone who can reach the API can claim any name. Put it behind your SSO proxy before relying on sign-off for audit.

## Monitoring dashboard (`/dashboard`, `GET /api/dashboard?days=14`)

Execution (pass rate, per day, by AI vs person, cases that fail most), sign-off (funnel, waiting on a person), the AI (calls, p50/p95 latency, fallbacks, by model, guardrail hits, DeepEval scores) and pipeline stage reliability. Without `CLICKHOUSE_URL` the AI numbers are kept in memory and the page says so.

## What has been verified, and what has not

Verified here (sandbox): 42 API tests (all pass on SQLite and on a real PostgreSQL 16), 7 UI tests, a live browser run of requirement → cases → sign-off by a second person → run → result → dashboard against the real API and the built UI on PostgreSQL.

**Not verified here:** ClickHouse (no server in the sandbox; the in-memory fallback is tested, the ClickHouse queries are not), the Docker images and compose file (no Docker daemon), a real model, real Jira, GitHub/GitLab, MCP server, Locust, ZAP, Semgrep, Gitleaks, DeepEval with a real judge, BrowserStack, and the Node engine driving a real browser through this API (a stand-in engine was used in the live run). `validate_platform.py` is how you find out on your machine.
