# TestOps Mobile — developer handoff

One framework runs the same test-case JSON on **Android, iOS (Appium / BrowserStack) and web (Playwright)** and reports every run through **one pass/fail contract**. This page is the starting point; deeper history is in `docs/STATUS.md`.

## The lifecycle, and where each stage lives

| # | Stage | Where | State |
|---|---|---|---|
| 1 | Test cases (JSON) from scenarios | `test-cases/*.json`, `generation/` | built |
| 2 | Version them in Git | `engine/git-sync.js`, `POST /api/sync-test-cases` | built, unit-tested (real git repos) |
| 3 | Push scripts + results to FrothAI | — | **not built** (needs the FrothAI contract) |
| 4 | App upload, BrowserStack session | `engine/browserstack-upload.js`, `engine/remote-provider.js` | built, proven on real hardware |
| 5 | Regression cycle: many cases + parameterised data | `run-batch-executions.js` (`test-case` mode), `testData` on the execute endpoints | built; the cycle-builder UI is TestOps's |
| 6 | Execute (mobile) | `engine/test-case-runner.js`, `POST /api/execute-test-case` | built, proven on real hardware |
| 7 | Execute (web) | `web/web-test-case-runner.js`, `POST /api/execute-web-test-case`, `web/run-web-test-case.js` | built, proven on real Chromium locally |
| 8 | Failure → tester picks the element | `frontend/record-step.html` + `/api/record-step`, `/api/apply-recorded-step` | built; **tap on real Android not yet proven** (see gaps) |
| 9 | Pass/fail per case, summary | `engine/test-result.js` | built |
| 10 | Locator confidence/analytics | `engine/locator-store.js` (SQLite) | built, **on by default** |

## Pass/fail — the one rule (`engine/test-result.js`)

A test case is **pass** only if every non-optional step passes (an optional or `tapIfExists` step that finds nothing is `skipped`, not a failure). Any failed step → **fail**. Zero executed steps → **fail** (nothing proven). A run-level error (lost session, bad test case, missing env var) → **fail**.

Result shape, identical for android / ios / web:

```json
{ "status": "pass|fail", "success": true, "detail": "…", "platform": "web",
  "summary": {"total": 4, "passed": 4, "failed": 0, "skipped": 0},
  "steps": [{"index": 0, "kind": "navigate", "instruction": "…", "status": "pass", "reason": "(on fail/skip)", "durationMs": 120}],
  "durationMs": 1800 }
```

What makes a step fail, beyond an error: an `expect` that doesn't show up. `expect: {appeared:[…], disappeared:[…]}` is checked against what really changed on screen (no model judgment), so "the click worked but hit the wrong thing" fails. On web, `assert` steps add absolute checks (`urlContains`, `titleContains`, `textVisible`, `textHidden`).

## Test-case format

Shared: `kind`, `instruction`, `text` (`"${ENV_VAR}"` placeholders only — never commit a literal secret; Git sync refuses it), `optional`, `expect`, `resolvedSelector` (pinned from a proven run), `tapIfExists` + `selector` (hand-authored, never guessed).
Web adds `navigate {url}` and `assert {…}`; selector strategies `css | xpath | text | label | testid`. Example: `test-cases/web-example.json`.

## Run it

```bash
# web — exit code 0 = pass, 1 = fail
(cd web && npm install && npx playwright install chromium)
node web/run-web-test-case.js test-cases/web-example.json --base-url https://example.com [--headed] [--persist] [--out result.json]

# mobile — start the frontend with the opt-in APIs you need
cd frontend && npm install
TESTOPS_MOBILE_ENABLE_EXECUTE_API=1 TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1 \
TESTOPS_MOBILE_ENABLE_WEB_API=1 TESTOPS_MOBILE_ENABLE_GIT_SYNC=1 node server.js
# manual-fallback page:  http://localhost:8091/record-step?sessionId=…&platform=android&testCaseFile=login.json&stepIndex=3
```

| Env var | Effect |
|---|---|
| `TESTOPS_MOBILE_ENABLE_EXECUTE_API=1` | `POST /api/execute-test-case` (TestOps owns the session; we attach by `sessionId`) |
| `TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1` | `/api/record-step`, `/api/apply-recorded-step`, `/api/record-step/:id/stop` |
| `TESTOPS_MOBILE_ENABLE_WEB_API=1` | `POST /api/execute-web-test-case` |
| `TESTOPS_MOBILE_ENABLE_GIT_SYNC=1` | `POST /api/sync-test-cases`, `GET /api/test-case-history?file=` |
| `TESTOPS_MOBILE_GIT_REMOTE` / `_BRANCH` | Git sync target (default `origin` / current branch; never force-pushes) |
| `TESTOPS_MOBILE_DISABLE_LOCATOR_STORE=1` | opt out of the SQLite locator store; path via `TESTOPS_MOBILE_LOCATOR_DB_PATH` |
| `TESTOPS_MOBILE_WEB_CHROMIUM_PATH` | use an existing Chromium instead of `playwright install` |

Tests: `npm test` in each of `capture generation engine live-view frontend web`, plus `node test/check-env.test.js && node test/run-batch-executions.test.js` at the root. CI runs all of them. The `.env.example` and `docs/SETUP.md` cover Appium/BrowserStack credentials.

## Honest status — read before you rely on it

**Proven on real hardware:** BrowserStack session + app upload; fixed-sequence test cases on Android and iOS (login); attach-to-existing-session; record-step endpoint, WebSocket and live screenshot.

**Unit-tested only — NOT yet proven on a real device:**
- Android tap via W3C pointer actions in `live-view/server.js`. The BrowserStack Pixel 7 rejects `mobile: clickGesture`, so until one real run confirms the replacement, the manual-fallback tap (and Act 1's recorder) is unproven end to end on Android. Harness: `live-view/validate-record-step.js`.
- Dockerfile changes for `frontend` + `web` deps (the sandbox can't reach Docker Hub — run `docker build .` once).

**Not built:** FrothAI push of scripts/logs/results (needs its ingestion contract — build it behind an adapter); the TestOps-side UI that links a failed step to `/record-step`.

**Known bugs, need a real failing log to reproduce:** iOS harness crash (`got`/`p-cancelable` after a slow `getPageSource()`); iOS loop repeatedly resolving a deep index-based xpath after the screen changed (the loop already re-reads the page source each retry, so the cause isn't a plain re-resolve gap).

**Open gaps:** the autonomous loop can still stop on max-steps / repeated no-ops / "goal unclear"; the iOS end-to-end Add-ons run has never completed on real hardware; Flutter element identification.
