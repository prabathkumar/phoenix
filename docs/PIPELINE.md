# One AI-driven pipeline

`engine/core/pipeline.js` runs one flow, in the order of the AI Test Manager page:
scenarios, cases, test data, execution, HAR, performance (Locust), secrets (Gitleaks), SAST (Semgrep, source code), DAST (ZAP, running app), defects (Jira), and AI feedback.

Every stage reports `passed`, `failed`, `needs-you`, `skipped`, `not-built` or `unavailable`. A stage with no handler says `not-built`; nothing is shown as passed that did not run.

## Stage status today

| Stage | State in Phoenix |
|---|---|
| Test data | Built in (`testdata.js`); stops while a must-exist value is missing |
| Secrets, SAST | Runs `gitleaks` / `semgrep` when installed on the machine, else `unavailable` |
| Execution | Handler is injected by the caller (English run, test-case runner) |
| Scenarios, cases, HAR, performance, DAST, feedback | Built in `engine/core/handlers.js`; each says `unavailable` when its model or tool is missing |
| Defects (Jira) | Built: `defectsHandler` in `engine/core/jira.js` (see below); asks first at the default level |

## How much the AI asks

`autonomy`: `ask-everything`, `ask-when-matters` (default: asks before logging defects in Jira), `run-everything`.
Whatever the level, a live security scan (DAST) and anything aimed at production (execution, HAR, performance, DAST) always wait for an approval. Pass `approvals: {dast: true}` once the person approves; production still asks every time.
A stage waiting on a person is `needs-you`; the stages that depend on it wait.

## AI on every stage

Pass `ai: llmReviewer()` (self-hosted Ollama through `generation/llm.js`). After the run the model reads each stage's id, status and short detail and writes a note: likely cause, next action. It never sees a stage's `data` (which can hold test-data values), and a model failure never fails the run.

```js
const { runPipeline, llmReviewer } = require("./engine/core/pipeline");
const r = await runPipeline({ ctx: { steps, dir: "." }, handlers: { execution }, autonomy: "ask-when-matters", ai: llmReviewer() });
// r.stages, r.summary, r.needsYou
```

## One platform: what the TestOps guide has, and where it lives here

From the TestOps user guide (roboticodigital.gitbook.io). Phoenix now has an equivalent for each lab; the pipeline runs them as one flow.

| TestOps module | Phoenix | Notes |
|---|---|---|
| Requirement, Test Management (scenarios, cases) | `scenarios`, `cases` stages: model + `prompts/prompts.yaml` | Reads requirements from Jira (`readRequirement`) |
| Test Automation (record and play) | Recorder + English run, `execution` stage for API | Web and mobile runs start from the English page |
| API Testing | API steps, `runApiCases`, negative cases | Runs with no device |
| Performance Test Lab (script from a HAR) | `har` then `performance`: Locust file built from the HAR (or API steps), run headless | Pass/fail on failure rate; Locust must be installed |
| Security Test Lab (target, mode, Ajax Spider, HTML report) | `dast`: ZAP baseline with `-j` for Ajax Spider, HTML and JSON reports | Always asks first |
| Code Analyzer: SAST quick scan (ruleset Auto or Security Audit) | `sast`: Semgrep, `ruleset: "security-audit"` picks `p/security-audit` | |
| Code Analyzer: Secret scan | `secrets`: Gitleaks | |
| Defect Management + Jira (Bug type; one-way or two-way mapping) | `defects`: `defectsHandler({syncType})` | One-way only sends; two-way also reads status back |
| FrothAI | the planner and reviewer (`ai-pipeline.js`) | |
| BrowserStack integration | Run targets (Local or BrowserStack) | |

Not built from the guide: GitHub, GitLab and Plane integrations, Conversation and Live Chat evaluation (AI Evaluation), Scheduler, the report types (traceability, cycle comparison), roles and email notifications. Those stay in TestOps.

One request runs it all: `POST /api/pipeline/run` (`frontend/pipeline-endpoint.js`) with `{goal, requirement | jiraKey, steps, baseUrl, appUrl, autonomy, approvals}`. Stages waiting on you come back in `needsYou`; send the same request with `approvals: {dast: true}` to let them run. Secrets and stage data are never returned.

## AI decides, code enforces (`engine/core/ai-pipeline.js`)

`runAiPipeline({goal, requirement, handlers, callJson, autonomy})`:

1. **Plan.** The model reads the goal, the requirement and the last runs, and decides the platforms (web, api, mobile; only what the requirement mentions) and which stages to run, with a reason for each. Invented stages are dropped; a stage it forgets still runs, marked as the default.
2. **Run.** The chosen stages run through `runPipeline`. Gates stay in code: the model cannot lower the autonomy level, the live-scan rule or the production rule.
3. **Review.** The model writes a note on every stage (cause and next action).
4. **Remember.** Statuses and notes (never test-data values or requirement text) are appended to `logs/pipeline-runs.jsonl` (`TESTOPS_PIPELINE_LOG` to move it), and the next plan reads the last five runs.

If the model is down or answers badly, every stage runs in order and the plan says `source: "fallback"`. Each stage in the result carries `decided`, the AI's reason.

## Gateway: prompts, guardrails, MCP, call log (Portkey-style)

Every model call goes through `engine/gateway/`. The page is `/gateway` (linked from the English page); the routes are `/api/gateway/*`.

| Part | What | Where |
|---|---|---|
| Prompt library | Every prompt stored with versions, `{{variables}}`, notes and who saved it. Edit = new version; make any version live, so a bad edit is rolled back in one click. One JSON file per prompt in `prompt-library/` (commit it). "Import from prompts.yaml" loads the registry as version 1. | `prompt-store.js` |
| Guardrails | Input and output checks: secrets (keys, tokens, `password=`, known values), personal data (email, Luhn-checked cards, phone), prompt injection, JSON shape, length, banned phrases. Each rule blocks, redacts or warns; set per prompt or for everyone; edited on the page. Common-case heuristics, not guarantees. | `guardrails.js` |
| MCP registry | Add MCP servers by web address, fetch their tools, switch on or off. A prompt may call a tool only if it lists `server/tool`. Header values are saved but never shown again. HTTP only; no stdio. | `mcp-registry.js` |
| Routing and fallback | A prompt lists models in order; if one fails the next answers, and the log says it fell back. | `gateway.js` |
| Call log | Prompt, version, model, time, sizes, which guardrails fired, status. Never the prompt text, input or answer. | `logs/gateway-calls.jsonl` |

The pipeline's scenario and case prompts come from the library (YAML is the fallback), and its planner and reviewer calls are wrapped by the gateway.

Not built: cost in money (no price table), per-user keys and budgets, an MCP tool-calling loop inside a prompt (the registry and allow-list are there; a prompt does not call tools by itself yet), caching, A/B comparison of versions, and a real run against Ollama or an MCP server (tested with fakes).

## Jira, both ways (`engine/core/jira.js`)

| Direction | What |
|---|---|
| In | `readRequirement(key)`: the story and its linked change requests as one text block for scenario writing |
| In | `defectsToRetest(keys)`: defects we logged that Jira now shows Done/Resolved/Closed, ready to re-test |
| Out | `draftDefect` from a failed result (step, error, where it ran, requirement); secret values replaced with `***` |
| Out | `logDefect`: creates a Bug, or comments on the open one for the same case (label `testops-case-<id>`), so no duplicates |
| Out | `comment`, `transition(key, "Done")` |

Settings: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_DEFECT_TYPE` (see `.env.example`). Errors never repeat Jira's response, and the token only goes in the Authorization header. Not yet verified against a real Jira (no network from the build sandbox); tested against a fake Jira (`engine/test/jira.test.js`). Not built: Azure DevOps, a page or route for it, syncing Jira comments back into the AI.

Tests: `engine/test/pipeline.test.js`, `jira.test.js`, `ai-pipeline.test.js`.

Not yet: a page for the pipeline (the route exists), web and mobile execution inside the pipeline request, and any real run of Locust, ZAP, Semgrep, Gitleaks, Jira or the model (all tested against fakes; none installed or reachable from the build sandbox).
