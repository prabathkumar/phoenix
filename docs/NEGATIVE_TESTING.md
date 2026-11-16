# Negative testing

Bad, hostile and broken input, run against every component from scenario generation to the security scans. A negative test passes when the platform **refuses, fails clearly or says "unavailable"**; it fails when something crashes, passes silently, leaks a secret, runs foreign code or scans somewhere it must not.

Run all of it: `bash scripts/test-agents.sh` (the lines marked NEGATIVE), or per area:

| Area | File | What it throws at the component |
|---|---|---|
| Log ingest, masking, training gates, KPIs, connectors | `backend/tests/test_negative.py` | garbage and oversized events, SQL in filters, disguised secrets, forged metrics, self-approval, hostile clone URLs and folders |
| Scenarios, cases, test data, load test, performance, DAST, SAST, unit-test generation, sign-off, guardrails, pipeline, HTTP surface | `backend/tests/test_negative_pipeline.py` | useless model answers, hostile requirements, injection into the generated load-test code, missing and crashing tools, forbidden scan targets, forged sign-off |
| Release API | `frontend/test/negative.test.js` | path traversal in project/suite/app names, bad bodies, every token bypass, empty and wrong-type uploads, corrupt suites |
| Engine | `engine/test/negative.test.js` | error pages that argue back, unreadable pages, near-miss controls, empty suites, throwing agents, mobile with no app or device |
| Real browser | `engine/test/integration/...` | missing control, wrong expected text and URL, unreachable site: all end failed quickly |
| MCP | `mcp/test/negative.test.js` | unknown tools, wrong-typed arguments on every tool, path-like ids, Phoenix down |

## What negative testing found (all fixed)

1. **Arbitrary code execution:** `POST /api/unit-tests/run` ran tests in any folder the caller named. Now only folders under `PHOENIX_UNIT_ROOT` and clone URLs on `PHOENIX_UNIT_CLONE_HOSTS` (both empty by default) are allowed, symlinks and `..` resolved.
2. **An empty release passed:** a suite with no cases (or none that could run) read as PASS. Now it is FAIL with "no test case ran, so nothing is proven".
3. **Server-side request forgery:** the DAST scan and load test would aim at `http://169.254.169.254/` (cloud credentials), `file:`, `ftp:` and URLs with passwords. Now only plain http(s) is allowed and the metadata and link-local ranges are refused (localhost and private networks still work for your own apps).
4. **Crashes on bad input:** `POST /api/ingest` returned 500 for a non-object row; `POST /api/releases` crashed on a JSON `null` body; Semgrep output with unexpected shapes crashed the parser; the planner crashed on `changed: null`; the MCP server threw on missing arguments.
5. **Secrets missed:** GitHub tokens shorter than 30 characters, `github_pat_`, Google `AIza` keys and PEM private-key headers were not masked.

## Known limits

- The release API and the Python API trust an `X-User` header; real login is not built, so "who" is not proven.
- Negative tests cover the platform. They do not attack yes.my or any live site; that needs your Mac.
- The ZAP scan, Locust and Semgrep were tested with fakes of their output, not run for real.
