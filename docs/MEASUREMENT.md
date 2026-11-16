# Logs, measurement, unit tests and training

How the platform watches itself, and how a requirement is followed from the first line to the last test.

## One log store (ClickHouse)

Everything the framework does is logged, masked, and keyed by project id. `engine`, the release agents, the MCP server and the Python API all send events to one door, `POST /api/ingest`, which masks secrets (keys, tokens, passwords, card numbers, emails, phone numbers) and writes in batches (one insert per second or 1000 rows; if ClickHouse is down the batch is spooled to disk and replayed). Reads are `GET /api/logs/<table>?project=` and the **Logs** page.

| Table | What it holds | Written by |
|---|---|---|
| `gateway_calls`, `ai_eval`, `stage_events`, `executions` | model calls (no text), evaluation scores, pipeline stages, case results | the Python API |
| `agent_events` | every status change, note, verdict and model call of every agent | release agents, runner, pipeline feedback stage |
| `mcp_calls` | tool, caller, status, timing, masked arguments | MCP server |
| `user_actions` | who started a release, uploaded an app, generated or ran tests, labelled data, promoted a model | release API, Python API |
| `release_results` | one row per case per release: verdict, flaky, seconds, failed step, reason | release agents |
| `defects` | defects with the phase they were found in (unit, integration, system, UAT, production) | pipeline defects stage, `POST /api/defects` |
| `unit_results` | every unit or integration test with its requirement key, language, run id | unit-test connectors |
| `training_examples` | masked prompt and answer pairs, **only when `PHOENIX_TRAIN_CAPTURE=1`** | gateway, runner, release Triage |

## Measure agent: KPIs, leakage and TMMI

`measure` (stage `measure`, always runs) and the **Quality and TMMI** page (`GET /api/kpi`) compute, from those logs only:

- pass rate, flaky rate, blocked-by-site rate, release verdicts, case time p50/p95, auto-heal rate, model-call and MCP error rates
- **defect leakage** (defects that reached production / all defects), **defect detection percentage**, **leakage per phase**, **unit-test leakage** (unit-testable defects found after the unit phase), test case effectiveness, severity mix
- an **indicative TMMI level**: the 16 TMMI process areas of levels 2 to 5, each rated N / P / L / F from platform evidence, with what is missing and the next steps

A number with no data is `null` and says why (no defects logged is not the same as no defects). The TMMI view is a readiness check, not a certified assessment: a level is formally awarded by an accredited assessor. Code quality comes from Semgrep (the `sast` stage), which TestOps already has; no second code-quality tool is added.

## Unit and integration tests (a developer feature)

Unit tests were never part of TestOps. Developers can now:

1. **Write them from a requirement and the changed code**: `POST /api/unit-tests/generate` (page: *Unit Tests*). Give the repo, a requirement key and text, and `base`/`head` refs; the AI reads the diff, tests the changed behaviour first, and names every test with the requirement key. Languages: Java, PHP, Python, JavaScript, TypeScript, Go, C#. With `openPr` it raises a pull request; it never merges.
2. **Run them per language**: `POST /api/unit-tests/run` with a checkout folder or https clone URL. Each language uses its own toolchain (pytest, node:test, vitest, Maven, go test, phpunit, dotnet test) and the unit/integration split is a convention per language (see `GET /api/unit-tests/connectors`). A missing toolchain is reported, never counted as a pass.
3. **Run again and again**: every run has its own id. The latest run decides pass or fail; earlier runs show history and flaky tests.

## A requirement, end to end

`GET /api/lifecycle?project=` (and the bottom of the Quality page) follows each requirement key through nine stages: requirement, scenarios, test cases, case sign-off, unit tests exist, unit tests pass, integration tests pass, executed in a release, no open defects. A requirement is **done** only when every stage is reached. Tests that carry no requirement key are counted and listed as unlinked. The key goes in the case and in each test's name (`PROJ-123`, or `PROJ_123` where the language forbids a dash).

## Training the 8B model (people decide)

capture (opt-in, masked) -> a person labels examples good / bad / corrected (**Model Training** page) -> export train, eval and preference pairs -> `scripts/train/qlora_train.py` (QLoRA on Qwen3-8B, run on the GPU box) reports progress and held-out scores -> an **evaluation gate** (must beat the live model by 0.02, score at least 0.6, 95% well-formed answers) -> a **second person promotes it** with a written reason. The AI never trains, promotes or switches a model by itself. Starting a job needs at least 200 usable examples (`PHOENIX_TRAIN_MIN_EXAMPLES`) and a held-out set.

## Settings

`PHOENIX_API_URL` (engine and MCP: where logs go), `PHOENIX_INGEST_TOKEN` (optional shared token for ingest), `PHOENIX_TRAIN_CAPTURE=1`, `PHOENIX_TRAIN_MIN_EXAMPLES`, `PHOENIX_TRAIN_LAUNCH=1` (launch the job on the API host instead of printing the command), `PHOENIX_TRAIN_FOUR_EYES=0` (switch off the second-person rule), `PHOENIX_LOG_BATCH_ROWS`, `PHOENIX_LOG_FLUSH_SECONDS`, `PHOENIX_LOG_SPOOL_DIR`.

## Not built yet

- real login and roles (promotion and sign-off trust the `X-User` header)
- a Postgres or CI trigger that records production defects automatically (today: `POST /api/defects` or the Jira sync of the defects stage)
- recording how long a defect stays open, root-cause categories (Defect Prevention is rated from Triage only)
- the training script has not been run on a GPU from here; it is unit-tested for its scoring and reporting only
- coverage percentages from the unit-test runs (counts and pass rates only)
