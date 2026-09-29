# TestOps Integration Guide — Phoenix Semantic Action API

This is the step-by-step guide for the TestOps team to wire into Phoenix's
experimental semantic-action layer. It assumes no prior context beyond
knowing TestOps' own stack (Django 4.2.11 + DRF 3.14.0 backend, JS/React
frontend). For *why* this layer exists and what it's built from, see
`docs/PHOENIX_SPEC.md` §6 and the README's "Act 2" section — this doc is
only about the *how* of integrating with it.

**Status: opt-in, unproven on real hardware.** This is deliberate — see
"Rollout posture" at the end before pointing real testers at it.

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
