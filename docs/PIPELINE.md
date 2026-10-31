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
| HAR, performance, DAST, defects, AI feedback | `not-built` here; inject a handler (TestOps's, or new code) |

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

Tests: `engine/test/pipeline.test.js`. Not yet: an HTTP route or a page for it, the real handlers for HAR, performance, DAST and Jira, and feeding results back into the prompts.
