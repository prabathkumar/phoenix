# TestOps Integration Guide — Phoenix

This is the step-by-step guide for the TestOps dev team (Hemant's team)
to integrate Phoenix. It assumes no prior context beyond knowing
TestOps' own stack (Django 4.2.11 + DRF 3.14.0 backend, JS/React
frontend). It covers three things, in order: (1) the data model / fields
your UI needs to render — not how to design the screens, that's your
team's call, just what data exists and what shape it's in; (2) how to
point Phoenix's AI layer at frothAI instead of a local dev Ollama; (3)
how to actually install this on a server. For *why* the architecture is
built the way it is, see `docs/PHOENIX_SPEC.md` and the README.

**Status: the core engine (test-case execution, the semantic resolver,
selector self-healing) is proven end to end on real BrowserStack
hardware** — `test-cases/addons.json`, a full multi-screen flow (login →
dashboard → Add-ons → Profile → Logout), has had 18 real bugs found and
fixed against real devices; see `docs/STATUS.md` for the complete,
evidence-by-evidence trail. The single-action REST endpoint described in
§3 below (`POST /api/semantic-action`) is a separate, smaller surface
that is still unproven on real hardware in isolation — see "Rollout
posture" at the end for what that does and doesn't mean for you.

---

## 0. Data model — the fields your UI needs

Phoenix has no database and no user-facing API of its own for test cases
today — a test case is a JSON file, run by a Node script
(`run-batch-executions.js` / `engine/test-case-runner.js`). This section
is the exact shape of that data, so your team can design whatever
storage/UI you want around it without guessing at field names.

### A. Test Case (what a tester authors)

```json
{
  "name": "addons",
  "description": "free text, optional",
  "requiredEnv": ["PHOENIX_BATCH_LOGIN_PHONE", "PHOENIX_BATCH_LOGIN_PASSWORD"],
  "steps": [ /* Step objects, see below */ ]
}
```

**Step object fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | `"tap"` \| `"type"` \| `"scroll"` \| `"wait"` \| `"tapIfExists"` | yes | See table below for what each means and what else it needs. |
| `instruction` | string | yes (all kinds except `wait`) | Plain language, e.g. `"tap the LOGIN button"`. This is what a tester types — never a selector. |
| `text` | string | required when `kind` is `"type"` | Supports a literal value or a `"${ENV_VAR}"` placeholder (e.g. `"${PHOENIX_BATCH_LOGIN_PASSWORD}"`) resolved from the environment at run time — this is how credentials/test data stay out of the file itself. |
| `optional` | boolean | no, default `false` | A failed optional step is skipped, not a run failure (a dialog that doesn't always appear). |
| `durationMs` | number | only for `kind: "wait"` | Default 3000ms if omitted. |
| `selector` | `{strategy, value}` | required when `kind` is `"tapIfExists"` | A hand-authored, evidence-backed exact locator (see `docs/STATUS.md`'s `tapIfExists` sections for why this exists — not every "maybe present" step can be trusted to an AI resolver). `strategy` is one of `"resource-id"`, `"accessibility-id"`, `"text"`, `"xpath"`. |
| `resolvedSelector` | `{strategy, value}` | no — written BY Phoenix, not by a tester | A selector the engine proved correct on a prior real run; replayed directly (no AI call) until it misses. Your UI can show this read-only as "last known locator," but should never let a tester hand-edit it — it's machine-learned state, not authored content. |
| `note` | string | no | Free-text engineering commentary (why a step exists/was changed) — present throughout `test-cases/*.json` in this repo for audit-trail purposes; optional for your own authored test cases. |

### B. Execution result (what a run produces)

**Per-iteration result** (`run-batch-executions.js`'s `runOneTestCaseIteration`/`runIteration`):

| Field | Type | Notes |
|---|---|---|
| `mode` | string | `"test-case"` for this flow. |
| `success` | boolean | Whether the ENTIRE test case completed (every non-optional step succeeded). |
| `detail` | string | On success: the last executed step's diff summary (e.g. `"Appeared: \"Home\". Disappeared: \"LOGIN\"."`) or `"test case completed with no steps run"`. On failure: `step "<instruction>" failed: <reason>`. |
| `durationMs` | number | Wall-clock time for the whole run. |
| `startedAt` / `finishedAt` | ISO timestamp | When the iteration ran. |

**Known gap, stated plainly so your UI design accounts for it:** today's
result is a single success/fail + one text `detail` for the WHOLE test
case — there is **no structured per-step array** (step 1 result, step 2
result, …) persisted anywhere. `executeSemanticAction()` (the engine
function run per step) DOES return a rich per-step shape —

```json
{
  "success": true,
  "selector": { "strategy": "resource-id", "value": "..." },
  "diff": { "appeared": [...], "disappeared": [...] },
  "diffSummary": "Appeared: \"Home\".",
  "assertions": [{ "label": "Home", "resourceId": "..." }],
  "usedCache": true,
  "selfHealedNoOp": true
}
```

— but `runScriptSteps()` (`engine/test-case-runner.js`) only keeps the
LAST one (`lastResult`) and discards the rest. **If your "Run & Results"
screen needs a step-by-step breakdown (which test case UIs normally
do), this needs a small, contained engine change first: have
`runScriptSteps` accumulate an array of per-step results instead of
overwriting `lastResult`.** This is a few lines, not a redesign — flagging
it now so it's not discovered mid-integration. Ask if you want this built
before you start; it's a quick, well-scoped addition to a function that
already has full test coverage.

**Batch summary** (`summarizeBatchResults`, written by `writeReport` to
`batch-results/<timestamp>.json`):

```json
{
  "summary": {
    "total": 1, "succeeded": 1, "failed": 0,
    "byMode": { "test-case": { "total": 1, "succeeded": 1, "failed": 0, "successRate": 1.0, "avgDurationMs": 139449 } }
  },
  "results": [ /* array of per-iteration results, shape above */ ]
}
```

### C. The false-success caveat — read before building a pass/fail badge

A per-step `success: true` means "the WebDriver action completed without
error," not "the correct real-world thing happened." Two real, closed
bugs (`docs/STATUS.md` #16 and #18) were runs that reported
`Succeeded: 1` while the app was never actually in the end state the
test intended — caught only by a human looking at an actual screenshot,
not from the report. **There is currently no automated outcome
verification against an expected end state** (that's the
"requirement-traceability" layer referenced throughout `docs/STATUS.md`,
not yet built). If your UI shows a green checkmark from `success: true`
alone, be aware it is not yet a guarantee of correctness — treat it as
"nothing errored," and factor that into how much weight a pass/fail
badge should carry until that verification layer exists.

---

## 1. Wiring Phoenix's AI layer to frothAI

Confirmed: frothAI runs on Ollama, serving a Qwen 2.5 model (the "2.5
7B" in frothAI's naming is the Qwen size/version, not a Gemma one).
**This needs zero code changes** — every AI call in Phoenix (the
semantic resolver used by every tap/type/tapIfExists-adjacent step, the
live self-heal retry, and the optional script-naming/assertion-refinement
pass) goes through one function, `generation/llm.js`'s `callOllamaJson`,
configured entirely by two environment variables:

```bash
PHOENIX_OLLAMA_HOST=https://<frothAI's Ollama endpoint>
PHOENIX_OLLAMA_MODEL=qwen2.5:7b   # or qwen2.5-coder:7b -- confirm which of the two frothAI serves via `ollama list` on that host; both are the Qwen family FrothTestOps runs
PHOENIX_LLM_TIMEOUT_MS=8000   # raise if frothAI's network hop is slower than a local instance -- this is a hard per-call timeout, not a suggestion
```

Both are read by `generation/llm.js` at call time (not cached at
startup), so the same Phoenix instance can be pointed at a different
frothAI deployment per environment (dev/staging/prod) purely through
config. `PHOENIX_USE_LLM=1` additionally gates the OPTIONAL
script-naming/assertion-refinement pass used by guided recording (Act
1) — leave it unset if you only care about the semantic/test-case layer
(Act 2/3), which always calls the resolver regardless of that flag.

One real operational note from this project's own experience: a failed
or slow frothAI call doesn't crash a step — `generation/llm.js` and
`generation/semantic-act.js` are both built to fail soft (timeout/error
→ "unresolved," never a thrown exception) — but it does mean every tap
step's latency now includes a network round trip to wherever frothAI
runs. Keep it on the same network/region as whatever runs Phoenix if
run-to-run latency matters for your batch sizes.

---

## 2. Installing this on a server

- **Node version:** 18+ (the repo's own CI/Dockerfile use Node 20 —
  match that unless you have a reason not to).
- **Independent subprojects, not a monorepo workspace** — `engine/`,
  `generation/`, `capture/`, `frontend/`, `live-view/` each have their
  own `package.json`; install each with its own `npm install`.
- **A ready-made `Dockerfile`** already exists at the repo root and
  containerizes the Node-side pipeline (`run-session.js`,
  `frontend/server.js`, generation/capture/live-view) — it deliberately
  does **not** contain an Android emulator, a real device, or the
  `appium` server process itself (see the Dockerfile's own header
  comment for why: those need host-level hardware/USB access this
  container shouldn't own). Point the container at wherever your Appium
  server or BrowserStack account lives via env vars.
- **Full environment variable reference:** `.env.example` at the repo
  root — copy it, fill in the real values, every var is commented with
  what it does. `docs/SETUP.md` walks through the same setup
  interactively if a step-by-step is more useful than a flat reference.
- **Network access the server needs, whichever path you choose:**
  outbound to frothAI's Ollama endpoint (always), and either a local
  Appium server on the same network (`PHOENIX_APPIUM_HOST`/`PORT`) or
  outbound to `hub-cloud.browserstack.com` if running against
  BrowserStack App Automate (`PHOENIX_APPIUM_PROVIDER=browserstack` +
  the `PHOENIX_BROWSERSTACK_*` vars).
- **Process management:** nothing Phoenix-specific is prescribed here —
  `node run-batch-executions.js` for the batch/test-case runner, `node
  frontend/server.js` for the upload/session API, under whatever
  supervisor (pm2, systemd, your own container orchestrator) your infra
  already standardizes on.

---

## 1. What this API does, in one sentence

Given a Phoenix session that's already recording (a tester opened
TestOps, uploaded an app, and the live view is up), `POST
/api/semantic-action` lets your backend say *"tap the Login button"* in
plain English and have Phoenix figure out which element that means, act
on it, and report what changed — without your code ever touching a
selector, an accessibility tree, or a screen coordinate.

It does **not** start a session, upload an app, or replace the existing
upload/recording flow. It only acts on a session that's already active.

---

## 2. Turning it on

The endpoint doesn't exist unless the Phoenix instance is started with:

```bash
PHOENIX_ENABLE_SEMANTIC_API=1 node frontend/server.js
```

Without that env var, `POST /api/semantic-action` 404s like any
unregistered route (see `frontend/server.js`'s route registration). This
is intentional: it keeps the surface off by default until it's been
proven against real devices (see §6).

---

## 3. The request

```
POST /api/semantic-action
Content-Type: application/json
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `instruction` | string | yes | Plain-language description, e.g. `"tap the Login button"`, `"type into the email field"`. Non-empty after trimming. |
| `kind` | `"tap"` \| `"type"` | no (default `"tap"`) | |
| `text` | string | required when `kind` is `"type"` | The text to enter. |
| `useVisualGrounding` | boolean | no (default `false`) | Opt into sending a screenshot alongside the accessibility tree to the resolving model (fused mode). Off by default — see README's fusion section. Costs one extra screenshot capture per call; leave off unless text-only resolution is missing things. |

Example:

```json
{ "instruction": "tap the Login button" }
```

```json
{ "instruction": "type into the email field", "kind": "type", "text": "qa@example.com" }
```

---

## 4. The response

Phoenix's own status code tells you which of four outcomes happened —
don't collapse them into one shape on your side, they mean different
things:

| Status | Meaning | Body |
|---|---|---|
| `200` | Action resolved and executed | `{"success": true, "selector": {...}, "diff": {...}, "diffSummary": "...", "assertions": [...]}` |
| `422` | Understood the request, but couldn't resolve or execute the instruction | `{"success": false, "reason": "..."}` |
| `409` | No recording session is active right now | `{"error": "No recording session is active. ..."}` |
| `400` | Malformed request (missing/invalid `instruction`, bad `kind`, oversized body) | `{"error": "..."}` |
| `500` | Unexpected server-side error (should be rare — `executeSemanticAction` is designed to never throw) | `{"error": "Unexpected error: ..."}` |

`422` is a **normal, expected outcome** — Phoenix's semantic layer has a
hard "refuse rather than guess" contract (see `generation/semantic-act.js`).
Treat it as "couldn't do that," not as a bug to retry blindly.

`assertions` (on `200`) is the same `{label, resourceId}` shape the
guided-recording path already produces — if TestOps stores inferred
assertions against a test case today, this can feed the same table/field
with no new shape to handle.

---

## 5. Wiring it in — React frontend

Plain `fetch`, nothing Phoenix-specific needed:

```js
async function runSemanticAction(phoenixBaseUrl, instruction, opts = {}) {
  const response = await fetch(`${phoenixBaseUrl}/api/semantic-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, ...opts }),
  });
  return response.json(); // inspect response.status per the table above
}
```

## 6. Wiring it in — Django / DRF backend

Two files already exist to start from — copy them into TestOps' own app
structure rather than importing them as-is (they're commented as
starting points, not a package):

- **`docs/examples/testops_semantic_action_client.py`** — stdlib-only
  Python client (`run_semantic_action(...)`), handles the HTTP
  round-trip and the 200/422 both-are-normal-responses nuance
  (`urllib` treats 422 as an `HTTPError`; the client unwraps it the
  same as a 200 body).
- **`docs/examples/testops_drf_view_example.py`** — a DRF 3.14
  `APIView` (`SemanticActionView`) built on top of that client:
  validates the request, reads `PHOENIX_BASE_URL` from Django settings,
  and maps Phoenix's 200/422/409 onto the equivalent DRF response codes.

Minimum steps to adapt them:

1. Copy both files into the Django app that should own this (e.g.
   `testops/integrations/phoenix/`).
2. Add to Django settings:
   ```python
   PHOENIX_BASE_URL = env("PHOENIX_BASE_URL", default="http://localhost:8091")
   ```
3. Wire the URL:
   ```python
   path("phoenix/semantic-action/", SemanticActionView.as_view())
   ```
4. Swap `SemanticActionRequestSerializer` (a plain validation helper in
   the example) for a real `rest_framework.serializers.Serializer`
   subclass if that's TestOps' house convention — the validation rules
   are already written, just re-expressed.
5. Point `PHOENIX_BASE_URL` at wherever the Phoenix instance with
   `PHOENIX_ENABLE_SEMANTIC_API=1` is actually running (local dev,
   staging, or the eventual device-host VM — see README's "still open"
   notes on the Android VM / planned AWS iOS VM).

---

## 7. Error handling checklist for the integration

- **409 is not a retry-able error.** It means no tester has an active
  recording session — surface it as "start a recording session first,"
  not as a transient failure.
- **422 is not an exception on the Python client** — `SemanticActionError`
  is only raised for actual transport failures (Phoenix unreachable, a
  timeout, an unparseable response). A `{"success": false}` result is
  returned normally; check `result["success"]` like any other field.
- **Timeouts should stay generous.** Phoenix's own LLM call has an
  internal timeout (`PHOENIX_LLM_TIMEOUT_MS`, default 8s) plus real
  device action time on top. The example client defaults to 15s —
  don't tighten this without checking real device latency first.
- **This endpoint is single-session.** It acts on whichever session
  `engine/session-manager.js` considers active — there's no session ID
  in the request. If TestOps' model has multiple concurrent testers,
  this only works today for one active Phoenix instance per tester (or
  one at a time); a multi-session device pool is a known open item
  (README: "One session at a time... not started"), not something this
  endpoint already handles.

---

## 8. Rollout posture — read before pointing real testers at this

Prabath's explicit call: build TestOps' side of the integration now, in
parallel, but this specific API surface has **not been run against real
hardware yet** — only against faked WebDriver sessions in unit tests
(`frontend/test/semantic-action-endpoint.test.js`,
`engine/test/semantic-act-executor.test.js`). Recommended sequence:

1. TestOps team builds the integration now using this guide, against a
   **local** Phoenix instance with `PHOENIX_ENABLE_SEMANTIC_API=1` and a
   local/emulator session — proves the plumbing (auth, request shaping,
   response handling) without needing real-device proof yet.
2. In parallel, `run-batch-executions.js` (see repo root) gets run
   against real BrowserStack devices to get a real success-rate number
   for the semantic layer itself.
3. Once both are done, flip real testers onto it — at that point it's
   both wired correctly *and* proven to work on real screens, rather
   than just one or the other.

This keeps "TestOps integrates quickly" and "nothing ships unproven"
both true at once, rather than trading one off against the other.
