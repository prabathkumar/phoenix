# Release API: an agent plus an action is the event

An outside caller (ILMU Code, a CI job) sends an **event**: which saved agent, which action, the release, and what to work from. Phoenix runs that agent through the same pipeline, gates, approvals and sign-off as every other run. The saved agents are the base (`docs/AGENTS.md`). An action can only narrow an agent to some of its own stages. It cannot add a stage, lower autonomy or switch a disabled agent on.

## Set up (once, on the server)
```
python -m phoenix_api.api_keys ilmu-code          # prints the key (give it to the caller) and the line for PHOENIX_API_KEYS
PHOENIX_API_KEYS=ilmu-code:<sha256>,ci:<sha256>   # only hashes are stored
PHOENIX_WEBHOOK_SECRET=<long random>              # signs callbacks; without it no callback is sent
PHOENIX_API_MAX_RUNS=2                            # events running at once (default 2)
```
With no keys set the API is closed (503).

## Call it
```
curl -X POST https://PHOENIX/api/v1/events -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "agent": "team", "action": "release", "release": "R2026.11.3",
  "requirement": "Users can reset their password by email.",
  "repo": {"provider": "github", "project": "org/app", "base": "R2026.10", "head": "R2026.11.3"},
  "appUrl": "https://staging.example.com", "callbackUrl": "https://ilmu.example.com/hooks/phoenix"}'
```
Returns `202 {id, status:"queued", statusUrl, artifactsUrl}` at once.

| Call | What it does |
|---|---|
| `GET /api/v1/actions` | agents and the actions each one does |
| `POST /api/v1/events` | send an event |
| `GET /api/v1/events/{id}` | status: queued, running, needs-you, passed, failed, interrupted; each agent's result and run id |
| `GET /api/v1/events/{id}/artifacts` | what was created: scenarios, cases, test-data field names (never values), unit-test files, API cases, pull request |
| `POST /api/v1/events/{id}/approve` | `{"approvals": {"dast": true}}` continues an event that stopped at needs-you |

Body fields: `agent`, `action`, `release` (required); one of `requirement`, `requirementUrl`, `jiraKey`, `scenarios`, `cases`, `repo`; optional `appUrl`, `testData`, `task`, `approvals`, `callbackUrl`.

## Agents and actions
`agent: "team"` + `action: "release"` runs the roster in order: scout, scribe, mint, forge, runner, tracer, pacer, warden, prowler, judge, herald, mentor, measure. One agent: `run` (all its stages) or one of
scout `write-scenarios`; scribe `write-cases`; mint `make-test-data`; forge `link-repo`, `write-unit-tests`, `run-unit-tests`, `open-tests-pr`, `api-tests`; runner `execute`; tracer `capture-har`; pacer `performance-test`; warden `scan-secrets`, `scan-code`, `trace-requirements`, `revalidate`; prowler `check-deployment`, `security-test`; judge `evaluate-ai`; herald `raise-defects`, `request-signoff`; mentor `feedback`, `evidence`; measure `measure`, `confirm`.

Each agent's scenarios are handed to the next, so the runner runs the whole batch. A switched-off agent is skipped and reported. An agent that fails does not stop the others. An agent that needs a person (live security scan, anything aimed at production, Jira defects at the default level) stops the event at `needs-you`.

## Callback
When an event finishes or stops at needs-you, Phoenix POSTs `{eventId, release, status, needsYou, steps}` to `callbackUrl` with `X-Phoenix-Signature: sha256=<HMAC-SHA256 of the body with PHOENIX_WEBHOOK_SECRET>`. https and public addresses only, no redirects, three tries. Fetch `/artifacts` for the content.

## Limits
Events run inside the API process: a restart marks running events `interrupted` (send again). Progress is per agent, not per stage. A caller sees only its own events. Not yet run against a real ILMU Code, Jira, GitHub or a customer system; tested with a fake model.
