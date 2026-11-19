# Release API: an agent plus an action is the event

An outside caller (ILMU Code, a CI job) sends an **event**: which saved agent, which action, the release, and what to work from. Phoenix runs that agent through the same pipeline, gates, approvals and sign-off as every other run. The saved agents are the base (`docs/AGENTS.md`). An action can only narrow an agent to some of its own stages. It cannot add a stage, lower autonomy or switch a disabled agent on.

## Set up (once, on the server)
```
python -m phoenix_api.api_keys ilmu-code          # prints the key (give it to the caller) and the line for PHOENIX_API_KEYS
PHOENIX_API_KEYS=ilmu-code:<sha256>,ci:<sha256>   # only hashes are stored
PHOENIX_WEBHOOK_SECRET=<long random>              # signs callbacks; without it no callback is sent
PHOENIX_API_TARGETS=*.staging.example.com,10.1.0.0/16   # the only addresses a caller may aim tests and scans at (none set = no targets allowed)
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

**One agent, several agents, or the team: the caller chooses.** One: `agent` + `action`. Several, in your order: `"steps": [{"agent":"scout","action":"write-scenarios"},{"agent":"forge","action":"write-unit-tests"}]` (up to 13, no repeats). Everything: `agent:"team"`, `action:"release"`.

Body fields: `release` (required) and `agent`+`action` or `steps`; one of `requirement`, `requirementUrl`, `jiraKey`, `scenarios`, `cases`, `repo`; optional `appUrl`, `testData`, `task`, `approvals`, `callbackUrl`.

## Agents and actions
`agent: "team"` + `action: "release"` runs the roster in order: scout, scribe, mint, forge, runner, tracer, pacer, warden, prowler, judge, herald, mentor, measure. One agent: `run` (all its stages) or one of
scout `write-scenarios`; scribe `write-cases`; mint `make-test-data`; forge `link-repo`, `write-unit-tests`, `run-unit-tests`, `open-tests-pr`, `api-tests`; runner `execute`; tracer `capture-har`; pacer `performance-test`; warden `scan` (secrets + sast together), `secrets`, `sast`, `trace-requirements`, `revalidate`; prowler `dast`, `check-deployment`; judge `evaluate-ai`; herald `raise-defects`, `request-signoff`; mentor `feedback`, `evidence`; measure `measure`, `confirm`.

Each agent's scenarios are handed to the next, so the runner runs the whole batch. A switched-off agent is skipped and reported. An agent that fails does not stop the others. An agent that needs a person (live security scan, anything aimed at production, Jira defects at the default level) stops the event at `needs-you`.

## Callback
When an event finishes or stops at needs-you, Phoenix POSTs `{eventId, release, status, needsYou, steps}` to `callbackUrl` with `X-Phoenix-Signature: sha256=<HMAC-SHA256 of the body with PHOENIX_WEBHOOK_SECRET>`. https and public addresses only, no redirects, three tries. Fetch `/artifacts` for the content.

## Checks and balances
**On what comes in** (a bad request is refused with a plain reason; `warnings` lists things allowed but worth knowing):
- Size: body up to 1 MB, requirement up to 60,000 characters, task 4,000, at most 200 scenarios or cases.
- No secrets or passwords in requirement or task text; credentials go in `testData`, which must be up to 50 short name: value pairs.
- `appUrl`, `baseUrl`, `apiBaseUrl` must be http(s), without a username, and on `PHOENIX_API_TARGETS`. With none set, no target is allowed, so a caller cannot aim a scan or load at an arbitrary site.
- `repo` must be github or gitlab with an `org/app` project and valid refs. `production` can never be set from the outside. Text that looks like an instruction to the AI is kept as data and flagged.
- Approvals: only a key written `name:<hash>:approve` may send `approvals` or call `/approve`, so an AI caller cannot approve its own live security scan or Jira defects. The approver is recorded (`approvedBy`).

**On what the agents create** (before it is stored or returned): secrets are redacted, strings and lists are capped, items that are not in the expected shape are dropped, and any address outside the allowed targets is flagged. All of it appears in `flags` on the status and artifacts. Test-data values are never returned, only the field names. The existing gates still apply on top: guardrails on model calls, review of generated tests, sign-off.

## Code repo, scans and unit tests
- **Pass the repo on the call:** `"repo": {"provider":"github|gitlab","project":"org/app","base":"R2026.10","head":"R2026.11.3"}`. Before the event is accepted, Phoenix connects to it with the server's repo token and lists the files; if that fails the call returns 422 with the reason. No repo, no scan: `secrets` and `sast` say "no code repo linked" and never scan the server's own folder.
- **Names follow TestOps:** the actions and the stage names in results are `secrets` (Gitleaks, leaks), `sast` (Semgrep, code quality and security) and `dast` (ZAP, after a deployment check). `warden` + `scan` runs `secrets` and `sast` together; the team release runs both, and `dast` always waits for an approving key. (Older names `scan-secrets`, `scan-code`, `security-test` still work.)
- **Semgrep and Gitleaks:** the files are fetched through the repo API into a private temporary folder, scanned there and the folder is deleted. Paths that try to leave the folder are skipped.
- **Who defines the unit tests:** the forge agent's AI model writes them, from two inputs: the **requirement** (text, link or Jira key) and the **code changes** (with `base` and `head`, only the changed source files; otherwise up to 5 source files, those Semgrep flagged first). The requirement is mandatory for `write-unit-tests`, `open-tests-pr` and `run-unit-tests`; the call is refused without it. Tests are not trusted just because the AI wrote them: they go out as a pull request for a person to review (`open-tests-pr`), and each test result is logged against the requirement key.
- **Running them:** `run-unit-tests` runs the repo's own toolchain per language through the test connectors. Because that runs the repo's code, it only runs in folders under `PHOENIX_UNIT_ROOT` or clones from hosts in `PHOENIX_UNIT_CLONE_HOSTS`; with neither set it says unavailable.

## Limits
Events run inside the API process: a restart marks running events `interrupted` (send again). Progress is per agent, not per stage. A caller sees only its own events. Not yet run against a real ILMU Code, Jira, GitHub or a customer system; tested with a fake model.
