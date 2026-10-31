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
| Scenarios, cases | Injected; the prompts live in the registry (`prompts/prompts.yaml`) |
| Defects (Jira) | Built: `defectsHandler` in `engine/core/jira.js` (see below); asks first at the default level |
| HAR, performance, DAST, AI feedback | `not-built` here; inject a handler (TestOps's, or new code) |

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

## AI decides, code enforces (`engine/core/ai-pipeline.js`)

`runAiPipeline({goal, requirement, handlers, callJson, autonomy})`:

1. **Plan.** The model reads the goal, the requirement and the last runs, and decides the platforms (web, api, mobile; only what the requirement mentions) and which stages to run, with a reason for each. Invented stages are dropped; a stage it forgets still runs, marked as the default.
2. **Run.** The chosen stages run through `runPipeline`. Gates stay in code: the model cannot lower the autonomy level, the live-scan rule or the production rule.
3. **Review.** The model writes a note on every stage (cause and next action).
4. **Remember.** Statuses and notes (never test-data values or requirement text) are appended to `logs/pipeline-runs.jsonl` (`TESTOPS_PIPELINE_LOG` to move it), and the next plan reads the last five runs.

If the model is down or answers badly, every stage runs in order and the plan says `source: "fallback"`. Each stage in the result carries `decided`, the AI's reason.

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

Not yet: an HTTP route or page for the pipeline, real handlers for HAR, performance (Locust) and DAST (ZAP), and a real model run (tested against a fake model; self-hosted Ollama not exercised here).
