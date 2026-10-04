/**
 * Batch execution harness for validating the semantic layer (and the
 * guided path's underlying session lifecycle) against REAL BrowserStack
 * devices — requested explicitly: "100 executions on real devices from
 * browser stack", split across three modes since a single "execution"
 * means different things for Act 1 vs. Act 2 vs. Phase 3.
 *
 * IMPORTANT — this cannot run from a sandboxed cloud environment with
 * no BrowserStack credentials and no egress to BrowserStack's API
 * (confirmed: api-cloud.browserstack.com is blocked from this session's
 * network). Run this from a machine that has real BROWSERSTACK_USERNAME/
 * BROWSERSTACK_ACCESS_KEY configured (docs/SETUP.md) and, for the
 * "semantic"/"loop" modes, a reachable Ollama instance.
 *
 * Three modes, run this many times each (default split: even thirds of
 * PHOENIX_BATCH_TOTAL, remainder to "guided"):
 *
 *   guided  — starts a real session, takes a screenshot, reads the
 *             accessibility tree, tears down. This validates Act 1's
 *             underlying session lifecycle (engine/session.js or
 *             ios-session.js + BrowserStack) holds up over N real
 *             device sessions — it does NOT replay a specific generated
 *             .test.js script (there's no wdio/mocha test runner wired
 *             into this repo to do that yet); it's a liveness/stability
 *             smoke test of the same session machinery Act 1 depends on.
 *   semantic — starts a session, runs ONE semantic action
 *             (executeSemanticAction) against PHOENIX_BATCH_INSTRUCTION,
 *             tears down. Validates resolution accuracy and auto-heal
 *             behavior against real screens, not fakes.
 *   loop    — starts a session, runs engine/semantic-loop.js's
 *             runAutonomousLoop() toward PHOENIX_BATCH_GOAL (capped at a
 *             small step count per run — see PHOENIX_BATCH_LOOP_MAX_STEPS),
 *             tears down. The actual Phase 3 real-hardware proof.
 *
 * Every iteration is independent (its own session, start to teardown)
 * and wrapped so one failure doesn't abort the batch — the point is a
 * real success-rate number, which needs every attempt counted, not just
 * the ones that happened to work.
 *
 * Usage:
 *   PHOENIX_APPIUM_PROVIDER=browserstack \
 *   PHOENIX_BROWSERSTACK_APP_URL=bs://... \
 *   PHOENIX_BATCH_TOTAL=100 \
 *   PHOENIX_BATCH_INSTRUCTION="tap the Login button" \
 *   PHOENIX_BATCH_GOAL="log in and reach the account settings screen" \
 *   node run-batch-executions.js
 *
 * Writes a JSON report to batch-results/<timestamp>.json and prints a
 * summary to stdout. Device minutes add up fast at this volume — check
 * your BrowserStack plan's concurrency/minutes before running 100.
 */

const fs = require("fs");
const path = require("path");

const { executeSemanticAction } = require("./engine/semantic-act-executor");
const { runAutonomousLoop } = require("./engine/semantic-loop");
const { loadTestCaseSteps, requiredEnvVars, resolveSteps, runScriptSteps, persistResolvedSelectors } = require("./engine/test-case-runner");
const { openLocatorStore } = require("./engine/locator-store");
const { buildGroundedSnapshot } = require("./generation/semantic-snapshot");

const TEST_CASES_DIR = path.join(__dirname, "test-cases");

const OUTPUT_DIR = path.join(__dirname, "batch-results");

// Optional login credentials, read from the environment only -- never
// hardcoded, never accepted as a CLI arg (which would land in shell
// history the same way), and never written verbatim into this script,
// a commit, or the repo. Used to let the "loop" mode actually complete
// a real login instead of stopping at the login screen. If unset, loop
// iterations behave exactly as before (goal text unchanged).
const LOGIN_PHONE = process.env.PHOENIX_BATCH_LOGIN_PHONE;
const LOGIN_PASSWORD = process.env.PHOENIX_BATCH_LOGIN_PASSWORD;
const SECRETS = [LOGIN_PHONE, LOGIN_PASSWORD].filter((v) => typeof v === "string" && v.length > 0);

/**
 * Appends a credential-fulfillment instruction to a goal string, IN
 * MEMORY ONLY -- the caller must keep using the original `goal` for
 * anything printed to the console or written to the JSON report (see
 * redactSecrets below for the belt-and-suspenders case where a
 * credential leaks into an error/diff message instead of the goal
 * text itself, e.g. a failed setValue echoing back what it tried to
 * type). Pure function, unit-tested.
 *
 * @param {string} goal
 * @returns {string}
 */
function buildEffectiveGoal(goal) {
  if (!LOGIN_PHONE && !LOGIN_PASSWORD) return goal;
  const parts = [goal, "When the app asks you to log in, use these exact credentials:"];
  if (LOGIN_PHONE) parts.push(`phone/account number "${LOGIN_PHONE}"`);
  if (LOGIN_PASSWORD) parts.push(`password "${LOGIN_PASSWORD}"`);
  return parts.join(" ");
}

/**
 * Replaces any configured secret value found in `text` with
 * "[REDACTED]" before it's logged to the console or written to the
 * JSON report. Belt-and-suspenders: even though buildEffectiveGoal()
 * keeps the raw goal out of logs, a failed WebDriver action can still
 * echo back the literal text it tried to type (e.g. "Cannot set the
 * element to '<value>'") in its own error message -- this catches that
 * case too, not just the goal string itself. A no-op when no
 * credentials are configured. Pure function, unit-tested.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (typeof text !== "string" || SECRETS.length === 0) return text;
  let redacted = text;
  for (const secret of SECRETS) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Splits `total` into three counts (guided/semantic/loop) as evenly as
 * possible, putting any remainder into `guided` (the cheapest, least
 * failure-prone mode) rather than losing it to rounding. Pure function,
 * unit-tested in run-batch-executions.test.js.
 *
 * @param {number} total
 * @param {{guided?: number, semantic?: number, loop?: number}} [ratios] -
 *   relative weights; default even thirds.
 * @returns {{guided: number, semantic: number, loop: number}}
 */
function splitBatchCounts(total, ratios = {}) {
  const { guided = 1, semantic = 1, loop = 1 } = ratios;
  const totalRatio = guided + semantic + loop;
  if (total <= 0 || totalRatio <= 0) return { guided: 0, semantic: 0, loop: 0 };

  const semanticCount = Math.floor((total * semantic) / totalRatio);
  const loopCount = Math.floor((total * loop) / totalRatio);
  const guidedCount = total - semanticCount - loopCount; // remainder absorbed here

  return { guided: guidedCount, semantic: semanticCount, loop: loopCount };
}

/**
 * Builds the summary object written to the JSON report and printed to
 * stdout. Pure function over already-collected results, unit-tested.
 *
 * @param {Array<{mode: string, success: boolean, durationMs: number, detail?: string}>} results
 * @returns {Object}
 */
function summarizeBatchResults(results) {
  const byMode = {};
  for (const r of results) {
    if (!byMode[r.mode]) byMode[r.mode] = { total: 0, succeeded: 0, failed: 0, totalDurationMs: 0 };
    byMode[r.mode].total += 1;
    byMode[r.mode][r.success ? "succeeded" : "failed"] += 1;
    byMode[r.mode].totalDurationMs += r.durationMs;
  }
  for (const mode of Object.keys(byMode)) {
    const m = byMode[mode];
    m.successRate = m.total === 0 ? null : Number((m.succeeded / m.total).toFixed(4));
    m.avgDurationMs = m.total === 0 ? null : Math.round(m.totalDurationMs / m.total);
  }

  return {
    total: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    byMode,
  };
}

async function runOneGuidedIteration(platform) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await driver.takeScreenshot();
    const pageSource = await driver.getPageSource();
    return { success: true, detail: `read ${pageSource.length} chars of page source` };
  } finally {
    await driver.deleteSession();
  }
}

// A freshly launched app is typically still on a splash screen (a
// progress bar, no real controls yet) the instant the session comes up
// -- acting immediately against that snapshot isn't a timing bug in the
// semantic layer, it's the semantic layer correctly refusing to guess
// against a screen that genuinely doesn't have what was asked for yet.
// Real device/CI runs of a guided recording have a human naturally
// providing this gap by looking at the screen before tapping; batch/
// unattended runs need it made explicit instead. Configurable because
// splash duration varies a lot by app.
// `Number(x) || fallback` can't distinguish "unset" from a deliberately
// configured 0 (Number("0") is falsy too) -- matters here specifically
// because the test suite needs to set these to 0 to run fast, and a real
// deployment may legitimately want 0 for one of them (e.g. an app with
// no splash screen at all). Same fix already applied to
// PHOENIX_ACT_SETTLE_MS in engine/semantic-act-executor.js.
function envIntOrDefault(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

const STARTUP_DELAY_MS = envIntOrDefault("PHOENIX_BATCH_STARTUP_DELAY_MS", 5000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The flat STARTUP_DELAY_MS above is a floor, not a guarantee -- real
// BrowserStack runs showed it isn't enough: session init itself (queueing
// + device boot) can take 20-30s on its own, so a fixed 5s sleep after
// that still lands on the splash screen (confirmed live: "tap the LOGIN
// button" failed with "every [element] is a known non-clickable dead
// end" because the only things on screen were the splash's ImageView/
// ProgressBar/version text, all non-clickable with no clickable
// ancestor -- a generic, app-agnostic signal of "nothing to act on yet",
// not specific to this app's splash screen). Rather than guess a bigger
// fixed number (splash duration varies by app, device, and BrowserStack
// queue state), poll the actual page source after the floor delay until
// at least one element a tap could plausibly land on shows up, capped at
// a timeout so a genuinely broken/stuck app doesn't hang the batch
// forever -- if the timeout is hit, proceed anyway and let the existing
// dead-end check in generation/semantic-act.js refuse to guess, exactly
// as it already does today, rather than silently waiting past the limit.
const STARTUP_SETTLE_TIMEOUT_MS = envIntOrDefault("PHOENIX_BATCH_STARTUP_SETTLE_TIMEOUT_MS", 20000);
const STARTUP_SETTLE_POLL_MS = envIntOrDefault("PHOENIX_BATCH_STARTUP_SETTLE_POLL_MS", 1500);

/**
 * Waits past the app's launch splash screen before the first real step
 * runs. Applies the existing flat STARTUP_DELAY_MS floor first (keeps
 * today's behavior as a minimum), then polls getPageSource() with the
 * same "any non-dead-end element" test generation/semantic-act.js
 * already uses, up to STARTUP_SETTLE_TIMEOUT_MS. A snapshot/driver error
 * during polling is treated as "not ready yet" and retried rather than
 * thrown, since a mid-launch getPageSource() call failing outright is
 * expected, not fatal.
 *
 * @param {import('webdriverio').Browser} driver
 * @param {{timeoutMs?: number, pollMs?: number, sleepFn?: (ms: number) => Promise<void>}} [options]
 */
async function waitForAppReady(driver, options = {}) {
  const timeoutMs = options.timeoutMs ?? STARTUP_SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? STARTUP_SETTLE_POLL_MS;
  const sleepFn = options.sleepFn || sleep;

  await sleepFn(STARTUP_DELAY_MS);

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const pageSource = await driver.getPageSource();
      const snapshot = buildGroundedSnapshot(pageSource);
      const hasTappableElement = snapshot.some((el) => !(el.clickable === false && !el.clickableAncestorXPath));
      if (hasTappableElement) return;
    } catch (_err) {
      // mid-launch getPageSource() failures are expected -- keep polling.
    }
    if (Date.now() >= deadline) return;
    await sleepFn(pollMs);
  }
}

async function runOneSemanticIteration(platform, instruction) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await waitForAppReady(driver);
    const result = await executeSemanticAction(driver, instruction, {
      platform,
      useVisualGrounding: process.env.PHOENIX_ENABLE_VISUAL_GROUNDING === "1",
    });
    return { success: result.success, detail: result.success ? result.diffSummary : result.reason };
  } finally {
    await driver.deleteSession();
  }
}

/**
 * Turns runAutonomousLoop()'s step list into something safe to write
 * into the JSON report: every "type" step's actual typed text is
 * dropped entirely (replaced with "[REDACTED]") regardless of whether
 * it matches a configured secret, since a type step's text is
 * arbitrary user input at execution time and may be sensitive even
 * when no PHOENIX_BATCH_LOGIN_* credentials are set. instruction/
 * diffSummary still go through redactSecrets() as a second pass, in
 * case a credential shows up somewhere unexpected (a screen echoing a
 * typed value back, for instance). Found necessary after debugging a
 * real max-steps-reached run required pasting raw console logs back
 * and forth -- the JSON report alone should be enough to diagnose a
 * stalled loop without that. Pure function, unit-tested.
 *
 * @param {import('./engine/semantic-loop').LoopStep[]} steps
 * @returns {Array<{instruction: string, kind: string, diffSummary: string}>}
 */
function sanitizeStepsForReport(steps) {
  return steps.map((step) => ({
    instruction: redactSecrets(step.instruction),
    kind: step.kind,
    ...(step.kind === "type" ? { text: "[REDACTED]" } : {}),
    diffSummary: redactSecrets(step.diffSummary),
  }));
}

async function runOneLoopIteration(platform, goal, maxSteps) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await waitForAppReady(driver);
    const result = await runAutonomousLoop(driver, goal, { platform, maxSteps });
    return {
      success: result.stoppedBecause === "goal-achieved",
      detail: `${result.stoppedBecause}${result.reason ? `: ${result.reason}` : ""} (${result.steps.length} step(s))`,
      steps: sanitizeStepsForReport(result.steps),
    };
  } finally {
    await driver.deleteSession();
  }
}

// Fixed, deterministic step sequences -- NOT a goal handed to the
// autonomous loop for the model to plan its own way through. Added
// after the "loop" mode repeatedly got stuck at the exact same point
// on real iOS hardware (ios7, ios10 -- see docs/STATUS.md bugs 15/17):
// once both fields were correctly filled in, the model would not
// reliably recognize "data entry is done, submit now" and instead
// wandered into a decoy element, re-verified already-correct field
// values, or re-tapped the home screen's own LOGIN button (which
// shares its exact name with the form's submit button) before the
// password was even typed. Prompt wording changes didn't fix this
// across two separate attempts, so instead of asking the model to
// decide the sequence, each step still uses executeSemanticAction()'s
// existing per-instruction resolver (the same resolver already proven
// correct for iOS classChain/secure-field selectors, bugs 12/13), but
// which step runs next is now fixed DATA, not even fixed code: a step
// sequence is a JSON file under test-cases/ (engine/test-case-runner.js
// loads and runs it), so a new flow is a new file, not a new commit to
// this script. `login-script` mode keeps its original name/behavior
// for backward compatibility (existing docs/scripts/env-var habits all
// still work unchanged) but is now just the one built-in test case that
// happens to be requestable by a dedicated mode name; `test-case` mode
// (below) runs any test case file at all via PHOENIX_TEST_CASE_FILE.
const LOGIN_TEST_CASE_PATH = path.join(TEST_CASES_DIR, "login.json");
// Loaded once at module scope (not per-iteration) so a malformed
// test-cases/login.json fails fast at startup with a clear stack trace
// pointing at the file, rather than surfacing as a confusing per-
// iteration failure deep in a batch run.
const LOGIN_SCRIPT_STEPS = loadTestCaseSteps(LOGIN_TEST_CASE_PATH);

async function runOneLoginScriptIteration(platform, { persist = persistUpdatedSelectors } = {}) {
  const missing = requiredEnvVars(LOGIN_SCRIPT_STEPS).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return {
      success: false,
      detail: `login-script mode requires ${missing.join(" and ")} to be set`,
    };
  }
  // Resolved synchronously, here, before the first `await` below -- see
  // runScriptSteps' doc comment in engine/test-case-runner.js for why
  // reading process.env must not be deferred until after an await
  // (concurrently-running test code mutating process.env is the
  // concrete case this guards against, but it's just as real a risk for
  // any other concurrent env mutation during a real batch run). This
  // means `resolvedSteps` (passed into runScriptSteps so it actually
  // runs) carries literal secret text, not "${VAR}" placeholders -- so
  // when persisting selectors learned this run, we must NOT write
  // runScriptSteps's own `updatedSteps` (built from `resolvedSteps`,
  // literal secrets and all) straight to disk. Instead we merge just
  // the `resolvedSelector` field it learned back onto the original,
  // placeholder-carrying `LOGIN_SCRIPT_STEPS` before persisting -- see
  // mergeResolvedSelectors below.
  const resolvedSteps = resolveSteps(LOGIN_SCRIPT_STEPS);
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await waitForAppReady(driver);
    const result = await runScriptSteps(driver, resolvedSteps, { platform, executeSemanticAction });
    persist(LOGIN_TEST_CASE_PATH, mergeResolvedSelectors(LOGIN_SCRIPT_STEPS, result.updatedSteps));
    return result;
  } finally {
    await driver.deleteSession();
  }
}

/**
 * Merges runScriptSteps()'s `updatedSteps` (whatever text it actually
 * ran with, which may be a resolved literal secret) back onto the
 * ORIGINAL, placeholder-carrying steps array loaded straight from a
 * test-case JSON file, taking ONLY the `resolvedSelector` field --
 * never `text` or anything else. This is what makes it safe for the
 * selector-caching architecture to coexist with "${ENV_VAR}"
 * credential placeholders: whatever gets persisted back to disk is
 * always byte-for-byte the original step plus (at most) a learned
 * `resolvedSelector`, regardless of what runScriptSteps was actually
 * given to execute with.
 *
 * @param {Array<Object>} originalSteps - as loaded from the JSON file (placeholders intact)
 * @param {Array<Object>|undefined} updatedSteps - runScriptSteps()'s return value
 * @returns {Array<Object>|undefined}
 */
function mergeResolvedSelectors(originalSteps, updatedSteps) {
  if (!updatedSteps) return undefined;
  return originalSteps.map((step, i) =>
    updatedSteps[i] && updatedSteps[i].resolvedSelector
      ? { ...step, resolvedSelector: updatedSteps[i].resolvedSelector }
      : step
  );
}

/**
 * Best-effort wrapper around persistResolvedSelectors: a selector-cache
 * write failing (e.g. a read-only filesystem, a concurrent edit) must
 * never turn an otherwise-successful real-device run into a reported
 * failure -- it only means the next run re-resolves fresh instead of
 * replaying from cache, same as before this architecture existed.
 */
function persistUpdatedSelectors(filePath, stepsToPersist) {
  if (!stepsToPersist) return;
  try {
    persistResolvedSelectors(filePath, stepsToPersist);
  } catch (err) {
    console.error(`[run-batch-executions] couldn't persist resolved selectors to "${filePath}": ${err.message}`);
  }
}

/**
 * Runs any test-case JSON file (see engine/test-case-runner.js and
 * test-cases/login.json for the format) via PHOENIX_TEST_CASE_FILE --
 * the generalized counterpart to `login-script` above, for a flow that
 * isn't the built-in login one. Same fixed-sequence-over-fixed-
 * resolver approach, just not hardwired to a single named file.
 */
async function runOneTestCaseIteration(platform, filePath) {
  if (!filePath) {
    return { success: false, detail: "test-case mode requires PHOENIX_TEST_CASE_FILE to be set" };
  }
  let steps;
  try {
    steps = loadTestCaseSteps(filePath);
  } catch (err) {
    return { success: false, detail: err.message };
  }
  const missing = requiredEnvVars(steps).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return { success: false, detail: `test case "${filePath}" requires ${missing.join(" and ")} to be set` };
  }
  // See runOneLoginScriptIteration's matching comment: `steps` is
  // resolved synchronously, before the first await, into
  // `resolvedSteps` (literal secrets and all) for actually running --
  // and when persisting, only the learned `resolvedSelector` fields get
  // merged back onto the original, placeholder-carrying `steps`, never
  // `resolvedSteps` itself.
  const resolvedSteps = resolveSteps(steps);
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await waitForAppReady(driver);
    // Opt-in: only touches anything (opens/creates a .db file) when
    // PHOENIX_LOCATOR_DB_PATH or PHOENIX_ENABLE_LOCATOR_STORE is set --
    // a deployment that never sets either sees zero behavior change
    // from before this store existed.
    let locatorStore;
    if (process.env.PHOENIX_ENABLE_LOCATOR_STORE || process.env.PHOENIX_LOCATOR_DB_PATH) {
      try {
        const dbPath = process.env.PHOENIX_LOCATOR_DB_PATH || require("./engine/locator-store").dbPath();
        locatorStore = openLocatorStore();
        // Real gap found on a real run (addons-run-ios-docker-16.log):
        // with no confirmation either way, the store silently failed to
        // open (node:sqlite missing pre-Node-22.5) and nobody could tell
        // from the log alone. Always print the outcome explicitly now --
        // success AND failure -- so "is this actually recording data" is
        // never a silent question again. Also a reminder that inside a
        // container, this path is only real evidence if it's on a
        // mounted volume -- a bare `docker run --rm` with no matching
        // `-v` loses it the moment the container exits.
        console.log(`[run-batch-executions] locator store enabled: ${dbPath}`);
      } catch (err) {
        console.warn(`[run-batch-executions] couldn't open locator store (continuing without it): ${err.message}`);
      }
    }
    try {
      const result = await runScriptSteps(driver, resolvedSteps, {
        platform,
        executeSemanticAction,
        testCaseFile: filePath,
        locatorStore,
      });
      persistUpdatedSelectors(filePath, mergeResolvedSelectors(steps, result.updatedSteps));
      return result;
    } finally {
      if (locatorStore) locatorStore.close();
    }
  } finally {
    await driver.deleteSession();
  }
}

async function runIteration(mode, index, { platform, instruction, goal, maxSteps, testCaseFile }) {
  const startedAt = Date.now();
  console.log(`[run-batch-executions] [${mode} ${index}] starting...`);
  try {
    const { success, detail: rawDetail, steps } = await (mode === "guided"
      ? runOneGuidedIteration(platform)
      : mode === "semantic"
      ? runOneSemanticIteration(platform, instruction)
      : mode === "login-script"
      ? runOneLoginScriptIteration(platform)
      : mode === "test-case"
      ? runOneTestCaseIteration(platform, testCaseFile)
      : runOneLoopIteration(platform, buildEffectiveGoal(goal), maxSteps));
    const detail = redactSecrets(rawDetail);
    const durationMs = Date.now() - startedAt;
    console.log(`[run-batch-executions] [${mode} ${index}] ${success ? "OK" : "FAILED"} (${durationMs}ms) - ${detail}`);
    // `steps` is only present for loop iterations (see
    // runOneLoopIteration/sanitizeStepsForReport) -- guided/semantic
    // results are unaffected and stay exactly as before.
    return { mode, index, success, durationMs, detail, ...(steps ? { steps } : {}) };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const detail = redactSecrets(err.message);
    console.error(`[run-batch-executions] [${mode} ${index}] ERROR (${durationMs}ms):`, detail);
    return { mode, index, success: false, durationMs, detail };
  }
}

// Restricts which mode(s) actually run, e.g. PHOENIX_BATCH_MODES=loop
// for a focused debug run. Without this, PHOENIX_BATCH_TOTAL=1 doesn't
// reliably give you a loop iteration -- splitBatchCounts() puts any
// remainder into "guided" (see its own doc comment), so a total of 1
// silently ran one guided iteration instead of the loop iteration that
// was actually wanted. Defaults to all three modes, unchanged from
// before this existed. Invalid mode names are ignored with a warning
// rather than silently running nothing.
// "login-script"/"test-case" are deliberately NOT part of the default
// ALL_MODES split (splitBatchCounts() keeps its existing guided/
// semantic/loop ratio, untouched and still unit-tested the same way)
// -- they only run when explicitly requested via
// PHOENIX_BATCH_MODES=login-script or =test-case, matching how a 1-off
// debug run already has to request "loop" explicitly to get one (see
// the comment on parseBatchModes below).
const ALL_MODES = ["guided", "semantic", "loop"];
const REQUESTABLE_MODES = [...ALL_MODES, "login-script", "test-case"];
function parseBatchModes() {
  const raw = process.env.PHOENIX_BATCH_MODES;
  if (!raw) return ALL_MODES;
  const requested = raw.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  const valid = requested.filter((m) => REQUESTABLE_MODES.includes(m));
  const invalid = requested.filter((m) => !REQUESTABLE_MODES.includes(m));
  if (invalid.length > 0) {
    console.warn(`[run-batch-executions] ignoring unknown mode(s) in PHOENIX_BATCH_MODES: ${invalid.join(", ")}`);
  }
  return valid.length > 0 ? valid : ALL_MODES;
}

/**
 * Splits `total` across only the requested `modes`. When all three
 * modes are requested (the default), this is exactly
 * splitBatchCounts(total) -- unchanged behavior. When a subset is
 * requested (PHOENIX_BATCH_MODES=loop, say), the total is divided
 * evenly across just those modes instead, with any remainder going to
 * the first requested mode -- simply zeroing out excluded modes from
 * splitBatchCounts()'s own ratio split would NOT redistribute the
 * total to what's left (its remainder always goes to "guided"
 * specifically, by design), so a modes=["loop"] request would
 * otherwise silently run zero iterations for a small total. Pure
 * function, unit-tested.
 *
 * @param {number} total
 * @param {string[]} modes - non-empty subset of ["guided", "semantic", "loop"]
 * @returns {{guided: number, semantic: number, loop: number}}
 */
function computeModeCounts(total, modes) {
  if (modes.length === ALL_MODES.length && ALL_MODES.every((m) => modes.includes(m))) {
    return splitBatchCounts(total);
  }

  const counts = { guided: 0, semantic: 0, loop: 0 };
  if (total <= 0 || modes.length === 0) return counts;

  const each = Math.floor(total / modes.length);
  let remainder = total - each * modes.length;
  for (const mode of modes) {
    counts[mode] = each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return counts;
}

async function main() {
  const total = Number(process.env.PHOENIX_BATCH_TOTAL) || 100;
  const platform = process.env.PHOENIX_PLATFORM === "ios" ? "ios" : "android";
  const instruction = process.env.PHOENIX_BATCH_INSTRUCTION || "tap the first visible button";
  const goal = process.env.PHOENIX_BATCH_GOAL || "explore the app's first screen";
  const maxSteps = Number(process.env.PHOENIX_BATCH_LOOP_MAX_STEPS) || 3;
  const testCaseFile = process.env.PHOENIX_TEST_CASE_FILE;
  const modes = parseBatchModes();

  if (process.env.PHOENIX_APPIUM_PROVIDER !== "browserstack") {
    console.warn(
      "[run-batch-executions] WARNING: PHOENIX_APPIUM_PROVIDER is not \"browserstack\" -- " +
        "this will run against a local Appium server/emulator instead of real BrowserStack devices."
    );
  }

  const counts = computeModeCounts(total, modes);
  console.log(
    `[run-batch-executions] plan: ${counts.guided} guided, ${counts.semantic} semantic, ${counts.loop} loop, ` +
      `${counts["login-script"] || 0} login-script, ${counts["test-case"] || 0} test-case (total ${total})`
  );
  console.log(`[run-batch-executions] platform: ${platform}, instruction: "${instruction}", goal: "${goal}"`);
  if (counts["test-case"] > 0) {
    console.log(`[run-batch-executions] test-case file: ${testCaseFile || "(none set -- PHOENIX_TEST_CASE_FILE is required)"}`);
  }
  // `loop` is R&D-only exploration (see this file's header and
  // docs/STATUS.md's "Data-driven test cases" section): it's for a goal
  // whose exact step sequence isn't known ahead of time, never for
  // authoring an actual repeatable test, even a first draft of one --
  // that's what `test-case` mode is for. Printed whenever `loop` is
  // requested (not just the default split, which already includes a
  // small loop share for exploration) so running it for test authoring
  // by habit doesn't go unnoticed.
  if (counts.loop > 0) {
    console.log(
      "[run-batch-executions] NOTE: \"loop\" mode is R&D/exploration only -- a model decides each step live and has repeatedly " +
        "failed to reliably finish a known, fixed sequence (docs/STATUS.md bug 18). To write or run an actual test case, use " +
        "\"test-case\" mode (PHOENIX_BATCH_MODES=test-case, PHOENIX_TEST_CASE_FILE=<path>) instead."
    );
  }
  if (SECRETS.length > 0) {
    console.log("[run-batch-executions] login credentials supplied via env for loop/login-script mode (not logged, not written to the report)");
  }

  // Module-level (not a local const) so the crash handlers below can
  // still see and salvage whatever's been collected so far if the
  // process dies mid-batch -- see their comment for why that matters.
  for (let i = 1; i <= counts.guided; i += 1) {
    resultsSoFar.push(await runIteration("guided", i, { platform }));
  }
  for (let i = 1; i <= counts.semantic; i += 1) {
    resultsSoFar.push(await runIteration("semantic", i, { platform, instruction }));
  }
  for (let i = 1; i <= counts.loop; i += 1) {
    resultsSoFar.push(await runIteration("loop", i, { platform, goal, maxSteps }));
  }
  for (let i = 1; i <= (counts["login-script"] || 0); i += 1) {
    resultsSoFar.push(await runIteration("login-script", i, { platform }));
  }
  for (let i = 1; i <= (counts["test-case"] || 0); i += 1) {
    resultsSoFar.push(await runIteration("test-case", i, { platform, testCaseFile }));
  }

  const reportPath = writeReport(resultsSoFar);
  const summary = summarizeBatchResults(resultsSoFar);

  console.log("\n[run-batch-executions] ==== SUMMARY ====");
  console.log(`Total: ${summary.total}  Succeeded: ${summary.succeeded}  Failed: ${summary.failed}`);
  for (const [mode, m] of Object.entries(summary.byMode)) {
    console.log(`  ${mode}: ${m.succeeded}/${m.total} succeeded (${(m.successRate * 100).toFixed(1)}%), avg ${m.avgDurationMs}ms`);
  }
  console.log(`[run-batch-executions] full report: ${reportPath}`);
}

// Accumulates every iteration's result as main() produces it (not just
// returned at the end) -- see writeReport()/the crash handlers below
// for why a batch needs this to survive a mid-run crash rather than
// losing everything.
const resultsSoFar = [];

/**
 * Writes whatever's in `results` to a timestamped report file, same
 * shape whether the batch finished cleanly or was cut short by a
 * crash (see `crashed`/`crashReason`, both omitted on a clean finish).
 * Pulled out of main() so the crash handlers below can call it too.
 */
function writeReport(results, crashInfo) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, `${Date.now()}.json`);
  const summary = summarizeBatchResults(results);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ summary, results, ...(crashInfo ? { crashed: true, crashReason: redactSecrets(String(crashInfo)) } : {}) }, null, 2),
    "utf8"
  );
  return reportPath;
}

// Real bug found on a live BrowserStack iOS run (ios6): a slow/flaky
// BrowserStack response raced WebdriverIO's own HTTP client's request-
// cancellation logic ("got"/"p-cancelable" -- an infra-level library
// issue, not a Phoenix selector bug) and threw an unhandled rejection
// well outside main()'s own await chain, which main().catch() below
// can't see at all. Node's default behavior for an unhandled rejection
// is to crash the process immediately -- which it did here, with a raw
// stack trace, no "FAILED" line, no summary, and (critically) NO
// REPORT FILE WRITTEN AT ALL, silently losing every iteration's result
// that had already completed. Harmless for a 1-iteration debug run,
// but this harness exists specifically to run batches of up to 100
// real-device iterations (see this file's header) -- losing all of
// them to one flaky network blip partway through is a real problem a
// bigger batch WILL eventually hit. These handlers can't make the
// crashed iteration succeed (the promise/connection state is already
// corrupted), but they can make sure nothing already collected is lost
// and that the person running this sees a clear reason instead of a
// raw library stack trace.
function handleFatalCrash(err) {
  console.error("[run-batch-executions] fatal error (likely an infra/network issue, not a Phoenix bug) -- salvaging results collected so far:", err);
  if (resultsSoFar.length > 0) {
    const reportPath = writeReport(resultsSoFar, err);
    console.error(`[run-batch-executions] partial report (${resultsSoFar.length} iteration(s)) written to: ${reportPath}`);
  } else {
    console.error("[run-batch-executions] no iterations had completed yet -- nothing to salvage.");
  }
  process.exit(1);
}
if (require.main === module) {
  // Registered only when actually running as the batch script, not
  // when required as a library (e.g. by this file's own tests, which
  // reload the module repeatedly via require.cache -- registering
  // these unconditionally at module scope would pile up a fresh global
  // listener on every such reload).
  process.on("unhandledRejection", handleFatalCrash);
  process.on("uncaughtException", handleFatalCrash);
  // A rejection that propagates through main()'s own await chain (e.g.
  // runIteration() itself throwing) hits this handler, not the
  // unhandledRejection one above -- same "don't lose whatever's
  // already in resultsSoFar" fix applies here too.
  main().catch((err) => handleFatalCrash(err));
}

module.exports = {
  splitBatchCounts,
  summarizeBatchResults,
  buildEffectiveGoal,
  redactSecrets,
  sanitizeStepsForReport,
  parseBatchModes,
  computeModeCounts,
  writeReport,
  OUTPUT_DIR,
  runOneLoginScriptIteration,
  runOneTestCaseIteration,
  mergeResolvedSelectors,
  LOGIN_SCRIPT_STEPS,
  waitForAppReady,
};
