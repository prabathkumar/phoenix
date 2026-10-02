# Real-device batch testing runbook

This is the "start from a cold Mac" checklist for running
`run-batch-executions.js` against a local Android emulator (or a real
device over `adb`). Written after a long real-device debugging session
that found and fixed several resolver bugs — see the git log for
`generation/semantic-snapshot.js`, `generation/semantic-act.js`, and
`engine/semantic-loop.js` for the specifics. Use this doc instead of
reconstructing the steps from scratch every time the machine restarts.

For standing up Phoenix's services generally (not just this batch
harness), see [`SETUP.md`](SETUP.md) — this doc assumes that's already
done once and Node deps are installed.

## 1. Start the Android side

```bash
# Terminal 1 — Appium server
npx appium
```

If port 4723 is already in use, check whether a healthy server is
already running before killing anything:

```bash
curl http://127.0.0.1:4723/status
# {"value":{"ready":true, ...}} -> reuse it, nothing to restart
```

```bash
# Terminal 2 — emulator
emulator -list-avds        # confirm the AVD name (e.g. phoenix_stage0)
emulator -avd phoenix_stage0
```

Wait for it to fully boot, then confirm it's visible:

```bash
adb devices   # should list it as "device", not "offline"/"unauthorized"
```

## 2. Point Phoenix at the app under test

```bash
export PHOENIX_STAGE0_APP_PATH="/Users/prabathkumar/Downloads/<the .apk>"
```

Use an absolute path. If you're running two emulators/devices in
parallel, also set a distinct device per terminal:

```bash
export PHOENIX_APPIUM_DEVICE_NAME="emulator-5556"   # default is emulator-5554
```

## 3. Reset app state before each run

Batch runs do **not** force-stop or clear the app between iterations,
so leftover state from a previous run (already logged in, mid-flow,
etc.) will confuse the resolver and looks like a resolver bug when it
isn't — every action's diff will read "No visible change" because
nothing you expect is actually on screen. Reset before a fresh run,
especially after debugging a failure:

```bash
adb shell am force-stop <package.name>   # e.g. my.yes.yes4g
adb shell pm clear <package.name>
```

## 4. Run the batch harness

Full mixed batch (guided + semantic + loop, default 100 total, split
evenly):

```bash
node run-batch-executions.js
```

### Useful env vars

| Var | Default | Purpose |
|---|---|---|
| `PHOENIX_BATCH_TOTAL` | `100` | how many iterations total |
| `PHOENIX_BATCH_MODES` | all three | comma-separated subset of `guided,semantic,loop` — use this instead of `PHOENIX_BATCH_TOTAL=1` alone to force a single mode; with all three modes requested, `PHOENIX_BATCH_TOTAL=1` still runs `guided` only (see `computeModeCounts()`'s docstring for why). A fourth mode, `login-script`, is opt-in only — it's never included by `all three` and must be named explicitly. |
| `PHOENIX_BATCH_INSTRUCTION` | `"tap the first visible button"` | the single instruction `semantic`/`guided` iterations act on |
| `PHOENIX_BATCH_GOAL` | `"explore the app's first screen"` | the plain-language goal `loop` iterations pursue |
| `PHOENIX_BATCH_LOOP_MAX_STEPS` | `3` | hard step cap per `loop` iteration |
| `PHOENIX_BATCH_STARTUP_DELAY_MS` | `5000` | pause before the first action, so a cold-start splash screen doesn't get mistaken for the real first screen |
| `PHOENIX_BATCH_LOGIN_PHONE` / `PHOENIX_BATCH_LOGIN_PASSWORD` | unset | opt-in credentials appended to the `loop` goal ("...use these exact credentials..."); typed text and any leaked credential value are unconditionally redacted from the JSON report — **never commit these to a shell script in the repo**, export them in your own shell session only |
| `PHOENIX_PLATFORM` | `android` | set to `ios` to target the iOS path instead |

### Example: a single, clean loop-only debug run

```bash
export PHOENIX_BATCH_LOGIN_PHONE="<phone>"
export PHOENIX_BATCH_LOGIN_PASSWORD="<password>"

PHOENIX_BATCH_TOTAL=1 \
PHOENIX_BATCH_MODES=loop \
PHOENIX_BATCH_LOOP_MAX_STEPS=12 \
PHOENIX_BATCH_INSTRUCTION="tap the Login button" \
PHOENIX_BATCH_GOAL="type the Yes Number, then tap the PASSWORD tab, then type the password into the field that appears, then tap Login" \
node run-batch-executions.js
```

### `login-script` mode: the proven, deterministic path for an actual login (recommended over `loop`)

`loop`'s per-step model planning is a poor fit for a known, fixed sequence like login — it can get every step right and still fail to recognize "both fields are now correct, submit" as a terminal condition (see `docs/STATUS.md`, bug 18). `login-script` mode runs a hardcoded step order instead (dismiss an optional system dialog → tap LOGIN to open the form → type phone → tap the PASSWORD tab → tap the password field to focus it → type password → tap LOGIN to submit), with each individual step still going through the same proven per-instruction resolver. This is the mode that closed out login automation end to end on real hardware for both Android and iOS:

```bash
export PHOENIX_BATCH_LOGIN_PHONE="<phone>"
export PHOENIX_BATCH_LOGIN_PASSWORD="<password>"

PHOENIX_BATCH_TOTAL=1 \
PHOENIX_BATCH_MODES=login-script \
PHOENIX_PLATFORM=ios \
node run-batch-executions.js
```

Set `PHOENIX_PLATFORM=android` (or omit it, since `android` is the default) for the Android path. A successful run's report line reads `OK (...) - Appeared: "...", "Home", "Rewards", "Profile", ... Disappeared: "...", "LOGIN", "LOGIN", ...` — the login screen's own elements disappearing and the post-login home screen's elements appearing in the same diff is the confirmation the submit tap actually landed, not just that no WebDriver error was thrown.

### `test-case` mode: the same approach for ANY flow, as data instead of code (the recommended way to adopt Phoenix)

`login-script` mode's step sequence is hardcoded JS (`run-batch-executions.js`'s `LOGIN_SCRIPT_STEPS`) — a new flow meant a new array and a new commit. `test-case` mode generalizes it: a test case is a plain JSON file (`engine/test-case-runner.js` loads and runs it), run through the exact same per-instruction resolver. `test-cases/login.json` is the proven login sequence above, unchanged, now just data; `login-script` mode is kept as a convenience alias pointed at that one file.

**This is the recommended starting point for a new test case, not `loop` and not guided recording** — write the steps as JSON, let the resolver self-heal against the live screen, and only fall back to guided recording (Act 1) for a specific flow if the semantic layer genuinely can't resolve something on it.

Write a test case as a JSON file with a `steps` array:

```json
{
  "name": "add-a-voucher",
  "steps": [
    { "kind": "tap", "instruction": "tap the Add-ons tab" },
    { "kind": "type", "instruction": "type the promo code", "text": "${PHOENIX_PROMO_CODE}" },
    { "kind": "tap", "instruction": "tap the Apply button" }
  ]
}
```

- `kind`: `"tap"`, `"type"`, `"scroll"`, `"wait"`, or `"tapIfExists"`.
- `instruction`: plain language, resolved exactly the way a standalone `executeSemanticAction` call already is — no selector, no element reference. For a `"scroll"` step this is still required (for readability/logging) but isn't resolved against anything on screen — a scroll has no single target element, it just moves the viewport.
- `text` (type steps only): a literal string, or a whole-string `"${ENV_VAR_NAME}"` placeholder resolved from the environment at run time — never commit a real credential into a test-case file; reference it by env var name instead, the same way `test-cases/login.json` does for `PHOENIX_BATCH_LOGIN_PHONE`/`PHOENIX_BATCH_LOGIN_PASSWORD`. Partial interpolation (`"prefix-${VAR}"`) is deliberately not supported, to keep a half-written credential from ever looking like it belongs in a committed file.
- `direction` (scroll steps only): `"down"` (default) or `"up"`. Issues a native `mobile: scrollGesture` (Android) / `mobile: scroll` (iOS) gesture — no element resolution involved. Added after a real run found an element (Logout, in `test-cases/addons.json`) sitting below the fold in a scrollable screen, which nothing in the engine could previously reach.
- `durationMs` (wait steps only): milliseconds to pause, default `3000`. A `"wait"` step is a pure timing pause — no screen resolution, no device action, not even a call into `executeSemanticAction`. Added after a real run found that the post-login-submit notification-permission dialog appears at a variable delay: fast enough in one run for the following "tap Allow" steps to catch it, still not up by the next step in another (`addons.json`). No step-sequence rewording can fix a timing race; an explicit pause can.
- `optional` (any kind): `true` if the step is allowed to not match/do anything without failing the run (a system dialog that doesn't always appear, or a scroll that's a no-op when the target is already on screen).
- `resolvedSelector` (tap/type/scroll steps only, usually never hand-written): `{ "strategy": "...", "value": "..." }`, a concrete WebDriver selector this exact step previously resolved to on real hardware. See "Selector caching and self-healing" below.
- `selector` (`tapIfExists` steps only, REQUIRED, always hand-written): `{ "strategy": "...", "value": "..." }`, a literal selector from real evidence (never a guess). See "Conditional steps: `tapIfExists`" below.

### Selector caching and self-healing

Every step above still describes WHAT to do in plain language, resolved by the same AI-based resolver (`executeSemanticAction`) on every run. Left alone, that means a step that resolved correctly on one run is re-resolved from scratch — a fresh LLM call against a fresh accessibility-tree snapshot — on every subsequent run, with no memory of the prior success. On real hardware this independence produced the exact same step mis-resolving a *different* wrong way across different runs (`docs/STATUS.md` bugs #6, #7, #11, #12) — proof that re-prompting isn't converging, it's rolling dice.

`resolvedSelector` is the fix, and it's filled in automatically, never by hand:

1. If a step has a `resolvedSelector`, `executeSemanticAction` tries it FIRST via a direct WebDriver lookup — no LLM call at all. If the element is there, the step runs deterministically, exactly like a normal Playwright selector replay.
2. If the cached selector doesn't resolve (the element genuinely isn't there — the screen changed, the cache is stale), the code falls back to full AI-based resolution, same as a step with no cache at all. This is the "self-healing" half: a broken cache never fails the run, it just pays for one fresh resolution and learns the new answer.
3. After a run, whatever selector a step actually used (fresh, healed, or simply reconfirmed from cache) is written back into the test-case JSON file on disk — see `engine/test-case-runner.js`'s `runScriptSteps`/`persistResolvedSelectors`, wired up in `run-batch-executions.js`'s `runOneLoginScriptIteration`/`runOneTestCaseIteration`. The next run then replays from cache instead of re-asking the model.

This is deliberately the same architecture mature browser/mobile test tools (Playwright-style selector replay, Testim, mabl) already use, applied here with a self-heal fallback so a genuine UI change never leaves a test case permanently stuck on a stale selector.

A `"${ENV_VAR}"`-style credential placeholder is always safe here: persisting selectors only ever overlays the `resolvedSelector` field onto the ORIGINAL step loaded from disk (placeholder intact) — the literal, resolved secret value a run actually typed is never the thing written back to the file. See `run-batch-executions.js`'s `mergeResolvedSelectors` and its test coverage if you're changing this code.

A fresh test case (hand-written, no `resolvedSelector` anywhere) works exactly as before — this is purely additive. The very first run against a new or changed screen always resolves everything fresh; every run after that gets cheaper and more deterministic for whichever steps already proved out.

### Conditional steps: `tapIfExists`

Caching and self-healing still only matter for a step that's supposed to run. A different class of step — "tap X if some dialog/overlay happens to be open, otherwise do nothing" — turned out to be the wrong kind of thing to hand to an AI resolver at all, even with caching: the first run against a conditional step has no cache yet, so it still goes through full semantic resolution, and resolution for a *maybe-absent* target means asking the model to confidently say "nothing here" — which on real hardware it kept failing to do, no matter how the instruction was worded (`docs/STATUS.md`'s "Thirteenth bug": the same two elements misread as something else, across three separate rounds of rewording and prompt hardening).

`tapIfExists` is a step kind with no judgment call in it at all:

```json
{
  "kind": "tapIfExists",
  "instruction": "close the More-menu overlay if it's open (More Close icon)",
  "selector": { "strategy": "accessibility-id", "value": "More Close" }
}
```

- `selector` is REQUIRED and always hand-written from real evidence (a page-source dump that actually shows the element) — never a guess, and never filled in automatically the way `resolvedSelector` is.
- `executeSemanticAction` never calls the LLM resolver for this kind, not even as a fallback. It does one direct WebDriver existence check against `selector`: found → tap it, diff, report success; not found → report success anyway (`skipped: true`), no fallback, no guess.
- Use it for exactly the steps that used to be "optional" plain-language recovery instructions — a dialog or overlay that only sometimes appears, where you already know its real selector from a prior run's evidence. Don't use it for a step that must succeed and has no selector yet; that's what the AI resolver (optionally backed by `resolvedSelector` caching) is for.

Run it:

```bash
export PHOENIX_PROMO_CODE="<value>"

PHOENIX_BATCH_TOTAL=1 \
PHOENIX_BATCH_MODES=test-case \
PHOENIX_TEST_CASE_FILE=test-cases/add-a-voucher.json \
PHOENIX_PLATFORM=ios \
node run-batch-executions.js
```

Missing env vars referenced by a `"${...}"` placeholder are checked up front, before a session even starts, with a single clear error naming every missing variable.

The plan line printed at the top should read
`plan: 0 guided, 0 semantic, 1 loop (total 1)` — if it doesn't, the
mode filter isn't taking effect and the run isn't testing what you
think it is.

### Reading a failed run

```bash
cat <path from "full report:" line>
```

or, to see just the step trace (safe to paste anywhere — typed text
and credentials are redacted):

```bash
node -e "console.log(JSON.stringify(require('<path>').results[0].steps, null, 2))"
```

Each step's `diffSummary` tells you what actually changed on screen.
`"No visible change."` on a `tap`/`type` that should have done
something is the single most useful signal for diagnosing a stale
session vs. a real resolver bug — see step 3 above before assuming
the code is wrong.

## 5. iOS (currently blocked)

iOS batch runs need either:
- an `.ipa`/`.app` built for the **Simulator** (check with
  `file`/`lipo -info` — an arm64-only slice with no simulator tag means
  real-device-only, and Simulator runs will fail with "does not exist
  or is not accessible" even though the file is real), or
- a provisioned physical device.

Relevant env vars once one of those is available:
`PHOENIX_IOS_APP_PATH`, `PHOENIX_IOS_BUNDLE_ID`,
`PHOENIX_IOS_DEVICE_NAME`, `PHOENIX_IOS_PLATFORM_VERSION` (must match
an installed runtime — `xcrun simctl list runtimes` to check).

## 6. Known non-bugs (don't re-report these as new issues)

- **`error: model chose kind "type" without "text"`** — the local
  Ollama model occasionally drops a required field. `semantic-loop.js`
  already retries once with a sharper prompt; if it still fails after
  the retry, that's the model being genuinely unreliable that run, not
  a resolver bug. Just re-run.
- **A `loop` iteration stopping with `action-failed: refusing to type
  into the same element...`** — this is a safety guard doing its job
  (see `engine/semantic-act-executor.js`'s `beforeAct` hook), not a
  crash. It means the model tried to type into a field a previous step
  in the same run already set to something different — usually because
  the real target field wasn't revealed yet (a tab/toggle needed
  tapping first). Check the step trace for what happened right before
  it.
