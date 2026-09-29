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
const STARTUP_DELAY_MS = Number(process.env.PHOENIX_BATCH_STARTUP_DELAY_MS) || 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOneSemanticIteration(platform, instruction) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    await sleep(STARTUP_DELAY_MS);
    const result = await executeSemanticAction(driver, instruction, { platform });
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
    await sleep(STARTUP_DELAY_MS);
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

async function runIteration(mode, index, { platform, instruction, goal, maxSteps }) {
  const startedAt = Date.now();
  console.log(`[run-batch-executions] [${mode} ${index}] starting...`);
  try {
    const { success, detail: rawDetail, steps } = await (mode === "guided"
      ? runOneGuidedIteration(platform)
      : mode === "semantic"
      ? runOneSemanticIteration(platform, instruction)
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

async function main() {
  const total = Number(process.env.PHOENIX_BATCH_TOTAL) || 100;
  const platform = process.env.PHOENIX_PLATFORM === "ios" ? "ios" : "android";
  const instruction = process.env.PHOENIX_BATCH_INSTRUCTION || "tap the first visible button";
  const goal = process.env.PHOENIX_BATCH_GOAL || "explore the app's first screen";
  const maxSteps = Number(process.env.PHOENIX_BATCH_LOOP_MAX_STEPS) || 3;

  if (process.env.PHOENIX_APPIUM_PROVIDER !== "browserstack") {
    console.warn(
      "[run-batch-executions] WARNING: PHOENIX_APPIUM_PROVIDER is not \"browserstack\" -- " +
        "this will run against a local Appium server/emulator instead of real BrowserStack devices."
    );
  }

  const counts = splitBatchCounts(total);
  console.log(`[run-batch-executions] plan: ${counts.guided} guided, ${counts.semantic} semantic, ${counts.loop} loop (total ${total})`);
  console.log(`[run-batch-executions] platform: ${platform}, instruction: "${instruction}", goal: "${goal}"`);
  if (SECRETS.length > 0) {
    console.log("[run-batch-executions] login credentials supplied via env for loop mode (not logged, not written to the report)");
  }

  const results = [];

  for (let i = 1; i <= counts.guided; i += 1) {
    results.push(await runIteration("guided", i, { platform }));
  }
  for (let i = 1; i <= counts.semantic; i += 1) {
    results.push(await runIteration("semantic", i, { platform, instruction }));
  }
  for (let i = 1; i <= counts.loop; i += 1) {
    results.push(await runIteration("loop", i, { platform, goal, maxSteps }));
  }

  const summary = summarizeBatchResults(results);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, `${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("\n[run-batch-executions] ==== SUMMARY ====");
  console.log(`Total: ${summary.total}  Succeeded: ${summary.succeeded}  Failed: ${summary.failed}`);
  for (const [mode, m] of Object.entries(summary.byMode)) {
    console.log(`  ${mode}: ${m.succeeded}/${m.total} succeeded (${(m.successRate * 100).toFixed(1)}%), avg ${m.avgDurationMs}ms`);
  }
  console.log(`[run-batch-executions] full report: ${reportPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[run-batch-executions] failed:", err);
    process.exit(1);
  });
}

module.exports = { splitBatchCounts, summarizeBatchResults, buildEffectiveGoal, redactSecrets, sanitizeStepsForReport };
