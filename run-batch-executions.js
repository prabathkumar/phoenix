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

async function runOneSemanticIteration(platform, instruction) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    const result = await executeSemanticAction(driver, instruction, { platform });
    return { success: result.success, detail: result.success ? result.diffSummary : result.reason };
  } finally {
    await driver.deleteSession();
  }
}

async function runOneLoopIteration(platform, goal, maxSteps) {
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");
  const driver = await startSession();
  try {
    const result = await runAutonomousLoop(driver, goal, { platform, maxSteps });
    return {
      success: result.stoppedBecause === "goal-achieved",
      detail: `${result.stoppedBecause}${result.reason ? `: ${result.reason}` : ""} (${result.steps.length} step(s))`,
    };
  } finally {
    await driver.deleteSession();
  }
}

async function runIteration(mode, index, { platform, instruction, goal, maxSteps }) {
  const startedAt = Date.now();
  console.log(`[run-batch-executions] [${mode} ${index}] starting...`);
  try {
    const { success, detail } = await (mode === "guided"
      ? runOneGuidedIteration(platform)
      : mode === "semantic"
      ? runOneSemanticIteration(platform, instruction)
      : runOneLoopIteration(platform, goal, maxSteps));
    const durationMs = Date.now() - startedAt;
    console.log(`[run-batch-executions] [${mode} ${index}] ${success ? "OK" : "FAILED"} (${durationMs}ms) - ${detail}`);
    return { mode, index, success, durationMs, detail };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[run-batch-executions] [${mode} ${index}] ERROR (${durationMs}ms):`, err.message);
    return { mode, index, success: false, durationMs, detail: err.message };
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

module.exports = { splitBatchCounts, summarizeBatchResults };
