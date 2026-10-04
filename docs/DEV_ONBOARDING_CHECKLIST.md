# Developer onboarding — end-to-end test checklist, block by block

For the team starting on this codebase Wednesday. This maps directly onto
the architecture diagram (`docs/diagrams/architecture.svg`): one section per
block, each with (1) the automated tests that already exist and how to run
them, (2) a **manual test case with real evidence** — an actual bug this
exact block caused in production use, so "why does this check matter" has a
real answer instead of a hypothetical, and (3) what "this block works"
means in practice. Run `scripts/onboarding-smoke-test.sh` for the automated
half of every block in one command (see the bottom of this file).

Every piece of evidence below is cited to its real BrowserStack run log —
cross-reference `docs/STATUS.md` for the full writeup if you want more than
the one-paragraph summary here.

---

## Layer 1 — Guided recording (`capture/recorder.js`, `generation/pipeline.js`)

**What it does:** a human drives the app once, live, in a browser-connected
session. Every tap/type/scroll is captured as an exact selector
(resource-id / accessibility-id), and `generation/pipeline.js` turns the
recorded sequence into a runnable WebDriver script. No model call at
runtime — this is the only layer that never touches the LLM.

### Automated tests
```bash
cd capture && npm test   # test/resolveElementAtCoordinate.test.js
cd generation && npm test   # test/pipeline.test.js (+ 8 others, see below)
```

### Manual test case (real evidence)
**Setup:** record a login flow on the Android `MyYes` app (or any app with
at least one Compose-rendered input field with no `resource-id`/label).

**Steps:**
1. Start a recording session: `node run-session.js` (or via Docker — see
   `docs/TESTOPS_MOBILE_DOCKER.md`).
2. Open `frontend/index.html`, connect, and tap through a login form.
3. Stop the recording and inspect the generated script.

**Expected result (and the real bug this guards against):** every tapped
element — including unlabeled Compose inputs — appears in the generated
script with a selector that actually resolves on replay, not a blank/null
selector. `docs/PHOENIX_SPEC.md`'s "Real-hardware proof" section documents
the real bug this check exists for: a Compose-rendered input with no
resource-id was originally invisible to the snapshot builder entirely,
producing a script that silently skipped a real step.

**Pass/fail:** FAIL if any tapped element in the recording produces a step
with no selector, or if replaying the generated script (`PHOENIX_BATCH_MODES=test-case`)
fails on a step that visibly worked during recording.

---

## Layer 2 — Semantic resolution (`generation/semantic-act.js`, `engine/semantic-act-executor.js`)

**What it does:** replaces a hand-authored selector with a plain-language
instruction ("tap the LOGIN button"). `resolveSemanticAction()` grounds the
live accessibility tree into a numbered candidate list and asks the model
to pick one, or say "unresolved" — never guess. `semantic-act-executor.js`
then acts on the live WebDriver session and diffs the screen before/after
to know what actually happened.

### Automated tests
```bash
cd generation && npm test   # semantic-snapshot.test.js, semantic-act.test.js, semantic-diff.test.js, semantic-assertions.test.js
cd engine && npm test       # semantic-act-executor.test.js
```

### Manual test case (real evidence)
**Setup:** use `test-cases/addons.ios.json` step 2 (phone-number field,
unlabeled on iOS) against a real device/BrowserStack session.

**Steps:**
1. Run the batch test: `PHOENIX_TEST_CASE_FILE=test-cases/addons.ios.json node run-batch-executions.js`
2. Watch the step that types into the phone-number field.

**Expected result (and the real bug class this guards against):** the
field resolves and the real phone number is typed and echoed back
correctly (read-back verification). The real bug class here — found and
fixed three separate times (bugs #5, #8/#9, #10 in `docs/STATUS.md`) — is
the model declining a genuinely correct, unambiguous match because the
field has no accessibility label of its own, even though the real captured
XML shows exactly the described element. This is why that step is now
pinned via `resolvedSelector` rather than re-litigated by the model every
run — the fix pattern itself is the thing to understand, since it recurs
on any unlabeled field, not just this one.

**Pass/fail:** FAIL if the step resolves to the wrong element (check via
read-back verification's length-only mismatch report) or if a
single-label-missing field causes an "unresolved" decline despite the
instruction correctly describing the only matching element on screen —
that's the signal to pin the selector from real evidence, not reword the
instruction again.

---

## Layer 3 — Vision fusion (`generation/semantic-act.js`'s multimodal path)

**What it does:** when a screenshot is available, `semantic-act.js` sends it
alongside the element list via Ollama's multimodal `images` field, so the
model confirms its match against what the screen actually looks like —
needed for icon-only controls where text alone is ambiguous (an unlabeled
"Right Icon" that's actually Logout; two sibling buttons sharing a generic
id pattern).

### Automated tests
No dedicated suite yet (opt-in path, exercised indirectly through
`semantic-act.test.js`'s fixtures). **This is a real gap new developers
should close** — see "what's genuinely untested" at the bottom.

### Manual test case (real evidence)
**Setup:** `test-cases/addons.json` step 24 (Android) — the LOGOUT control,
which is an icon with content-desc `"Right Icon"`, no text relating it to
"logout" anywhere in the accessibility tree.

**Steps:**
1. Run the Android batch test against the real app.
2. Confirm the tap on the Profile screen's top-right icon.

**Expected result (and the real bug this is for):** without vision fusion,
a plain-language instruction has zero semantic signal to match "LOGOUT or
Log Out button" against a control labeled only "Right Icon" — this is
exactly bug #17 in `docs/STATUS.md`, found only because a developer sent a
screenshot of the real screen. The fix that actually works today is a
pinned selector (the text-only resolver can't be trusted here at all); the
open question for this layer is whether vision fusion, turned on, would
have resolved this correctly on the first try without needing a human to
eyeball a screenshot and hand-pin a selector.

**Pass/fail:** treat this block as "needs its own first real test" — the
checklist item for new developers is literally to run this exact case with
vision fusion enabled and record whether it resolves `"Right Icon"`
correctly from the instruction alone.

---

## Layer 4 — Autonomous loop (`engine/semantic-loop.js`)

**What it does:** takes a goal instead of a step list. Reads the snapshot,
asks the model to decide the single next action (or stop), executes it
through the same executor Layer 2 uses, feeds the diff back in, repeats.
Stops on: goal reached, model asks to stop, a failed/unresolved action, or
a hard step limit.

### Automated tests
```bash
cd engine && npm test   # semantic-loop.test.js
```

### Manual test case (real evidence)
**Setup:** wire a simple goal ("log in and reach the home screen") via
`run-batch-executions.js`'s `loop` mode against a real device.

**Steps:**
1. `PHOENIX_BATCH_MODES=loop PHOENIX_LOOP_GOAL="log in and reach the home screen" node run-batch-executions.js`
2. Watch the step-by-step decisions in the log.

**Expected result:** the loop makes forward progress each iteration
(no repeated identical action against an unchanged screen) and stops
cleanly at one of its four defined stop conditions — never runs past the
step limit without stopping, and never loops the same failed action twice
in a row without declining.

**Pass/fail:** this mode predates `test-case` mode in the adoption order
documented in `docs/STATUS.md`'s "Data-driven test cases" section —
`test-case` mode (explicit steps) is what's actually proven end to end on
real hardware; `loop` mode's real-hardware track record is thinner. New
developers should treat any `loop` mode run as needing the same
real-evidence scrutiny as the early `addons.json` runs got, not assume it's
already battle-tested.

---

## Shared AI runtime (`generation/llm.js`, `generation/execution-log.js`)

**What it does:** `callOllamaJson()` is the only place any layer talks to a
model — a self-hosted Ollama server (local today; pointing it at frothAI
is a config change, not a code change). Layers 2–4 all call it; Layer 1
never does. `execution-log.js` logs every call automatically so future
resolutions can read past failures back as prompt context.

### Automated tests
```bash
cd generation && npm test   # execution-log.test.js, outcome-verification.test.js
cd mcp && npm test          # get_recent_executions reads this log
```

### Manual test case (real evidence)
**Setup:** kill the Ollama server mid-run (simulate a real infra hiccup).

**Steps:**
1. Start a batch run with a step that requires semantic resolution.
2. Stop the Ollama process while that step is in flight.

**Expected result (and the real bug this is for):** the call fails with a
clean "unresolved"/thrown-error path, never a silent hang or a false
success. This is exactly bug #7 in `docs/STATUS.md`: an **optional** step
hit a genuine Ollama fetch abort, and because it was optional, the failure
was silently swallowed, cascading into a real failure two steps later with
no indication of the actual root cause in the log. The fix was twofold —
pin the step so it doesn't depend on Ollama being reachable at all, AND
make sure the log always states explicitly what happened (success/failure),
never relies on absence-of-error-message as a signal.

**Pass/fail:** FAIL if any Ollama-dependent step's failure is silently
absorbed by `optional: true` with no trace in the log of *why* it didn't
fire.

---

## Integration glue — self-heal and outcome verification (`engine/auto-heal.js`, `generation/outcome-verification.js`)

**What it does:** `auto-heal.js` is where Layer 1 (recorded exact selector)
and Layer 2 (semantic resolution) meet — a recorded selector falls back to
a fresh semantic resolution if it stops matching, or matches the wrong
element, self-healing live during the run with no human in the loop.
`outcome-verification.js` checks a step's declared outcome (`expect`)
against the real diff — "succeeded" alone only means no step *errored*,
not that the real goal was reached.

### Automated tests
```bash
cd engine && npm test       # auto-heal.test.js, test-case-runner-confidence-gate.test.js
cd generation && npm test   # outcome-verification.test.js
```

### Manual test case (real evidence)
**Setup:** `test-cases/addons.json` step 20 (the Add-ons tap) on a build
where the dashboard layout has shifted slightly.

**Steps:**
1. Run the batch test.
2. Confirm the Add-ons tap's `expect: { appeared: ["Add-On"] }` block.

**Expected result (and the real bug this is for):** bug #16 in
`docs/STATUS.md` — a required step reported `success: true` on a click that
actually hit the wrong element (a purchase-popup card instead of real
navigation), and the run was reported `Succeeded: 1` even though the app
never reached the real Add-ons screen. Only a user manually checking the
actual device screen caught it — the report alone was misleading. This is
exactly the gap `outcome-verification.js` exists to close: a step with a
declared `expect` FAILS loudly when the real diff doesn't match, instead of
reporting a hollow "succeeded."

**Pass/fail:** FAIL if a step with a declared `expect` ever reports success
while the declared `appeared`/`disappeared` elements don't match the real
diff. Also: treat any step WITHOUT a declared `expect` as unverified by
definition — `docs/STATUS.md` is explicit that this coverage is "opt-in per
step, not yet applied everywhere."

---

## Supporting infrastructure

### Locator confidence + store (`engine/locator-store.js`, confidence gate in `engine/test-case-runner.js`)

**What it does:** a fresh self-heal is only pinned into a test case's JSON
cache when there's real evidence it was right (a verified `expect`, or a
real diff) — never on "didn't throw" alone. The store (embedded SQLite,
`node:sqlite`, zero server) tracks verified/unverified hits and drift per
step, across runs.

**Automated tests:** `cd engine && npm test` — `locator-store.test.js`,
`test-case-runner-confidence-gate.test.js`.

**Manual test case (real evidence):** this is the newest piece and, as of
this checklist, **has never successfully recorded a row from a real device
run** — see `docs/STATUS.md`'s two real blockers: (1) Node 20's image
lacked `node:sqlite` (fixed, Node 22 now), (2) a Docker bind-mount to a
non-existent host path gets auto-created as a directory, breaking the
database open (fixed: `touch locator-store.db` before the first mounted
run). **Checklist item: be the first to confirm a row actually lands** —
run a batch test with `PHOENIX_ENABLE_LOCATOR_STORE=1` and
`PHOENIX_LOCATOR_DB_PATH` pointed at a touched, mounted file, then query it
(`getAllLocatorStats` via a short script, or the MCP connector's
`get_suite_health` tool) and confirm non-zero rows.

### Pre-flight (`check-env.js`)

**What it does:** any tester runs `node check-env.js` before a real
BrowserStack run — zero Docker, zero device session, zero cost. Parses
`.env` exactly like Docker's `--env-file` does, reporting MISSING vs EMPTY
vs SET (never printing a credential's real value).

**Automated tests:** none yet (pure script, validated manually against
synthetic `.env` fixtures during development — see conversation history).
**Checklist item:** add a real `check-env.test.js` covering the
MISSING/EMPTY/SET three-way distinction before this is considered
"tested," not just "worked when I tried it."

**Manual test case (real evidence):** this tool exists because of a real,
repeated failure mode: a tester's `.env` had a credential variable declared
with no value (`PHOENIX_BATCH_LOGIN_PASSWORD=`), which is silently
different from the variable being absent entirely, and both looked
identical in a plain `cat .env`. Run `node check-env.js test-cases/addons.ios.json`
against a `.env` with one var set to empty and confirm it reports `EMPTY`,
not `MISSING` or a false "all good."

### External MCP connector (`mcp/server.js`)

**What it does:** a standard MCP server (stdio) for an external client
(TestOps's own MCP, Claude) to query locator history/suite health, test
cases, and the execution log. `run_test_case` is gated behind
`confirm: true` AND the server's own `PHOENIX_MCP_ALLOW_RUN=1` — no
credential field exists on the tool schema at all.

**Automated tests:**
```bash
cd mcp && npm test   # 15 tests against handleToolCall directly
```

**Manual test case (real evidence):** this has been proven via a real
stdio smoke test (spawning the actual server process and talking to it
through the SDK's own `Client`/`StdioClientTransport`) but **never used by
a real external MCP client** yet. Checklist item: connect this server to an
actual MCP-capable client (Claude Desktop, or TestOps's own MCP once
integrated) and confirm `list_test_cases`/`get_suite_health` return real
data, and that `run_test_case` is correctly refused without both the
`confirm:true` argument AND the server env var set.

---

## What's genuinely untested — don't assume otherwise

Be direct about this with the team: the architecture diagram shows four
layers as "shipped," but shipped code and *real-device-proven* code are not
the same claim everywhere.

| Block | Real-device proof |
|---|---|
| Layer 1 (recording) | ✅ Proven, Android |
| Layer 2 (semantic resolution) | ✅ Proven, both platforms (Android fully closed end to end; iOS partially — see `docs/E2E_CHECKLIST.md`) |
| Layer 3 (vision fusion) | ❌ Never exercised on a real failing case — see the Layer 3 section above |
| Layer 4 (autonomous loop) | ⚠️ Exists, unit-tested, thinner real-hardware track record than `test-case` mode |
| Self-heal / outcome verification | ✅ Proven (bugs #13–#18), but `expect` coverage is opt-in per step, not universal |
| Locator store | ❌ Never recorded a row from a real run (two blockers now fixed, unverified) |
| `check-env.js` | ✅ Run for real against a real `.env`, no automated test yet |
| `mcp/server.js` | ⚠️ Unit + local stdio smoke-tested, never used by a real external client |

iOS end-to-end closure specifically is the active focus (`docs/E2E_CHECKLIST.md`)
— Android's `addons.json` is the only fully-closed real-device proof point
in this whole system today. Treat it as the reference example of "what
proven looks like," and everything else as somewhere short of that until
it has its own equivalent evidence trail.

---

## Running it all in one command

```bash
./scripts/onboarding-smoke-test.sh
```

Runs `check-env.js`'s self-check, then every package's unit suite in the
same order as the blocks above, printing a clear PASS/FAIL per block. This
covers the "automated tests" column of every section above in one pass —
it does NOT replace the manual, real-device test cases, which need an
actual device/BrowserStack session and are listed individually above.
