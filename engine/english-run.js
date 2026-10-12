/**
 * Runs a plain-English test case: each line is a goal the AI works toward on
 * the live screen (web page or mobile app). One runner interface, two
 * adapters - the orchestration below does not know which one it has.
 *
 *   runner.goal(text, {onProgress}) -> {success, reason, actions}
 *   runner.screenshot()             -> {base64, mime} | null
 *   runner.close()                  (optional)
 *
 * Stops at the first failed step (later steps depend on earlier ones) and
 * reports exactly which line failed and why. Secret test-data values never
 * appear in anything emitted (see engine/core/english.js).
 */
const { parseSteps, applyTestData, redact } = require("./core/english");

/**
 * @param {{steps:string, testData?:Object, runner:Object, onEvent?:Function, now?:Function}} opts
 */
async function runEnglish({ steps: stepsText, testData = {}, runner, onEvent = () => {}, now = Date.now }) {
  const lines = parseSteps(stepsText);
  const started = now();
  const emit = (e) => { try { onEvent(e); } catch { /* a bad listener must not break the run */ } };
  const results = [];

  if (!lines.length) {
    const out = { status: "failed", reason: "Write at least one step in English first.", steps: [], durationMs: 0 };
    emit({ type: "run-finished", ...out, passed: 0, failed: 0 });
    return out;
  }

  // Resolve every ${NAME} up front: a missing value should stop the run before anything is clicked.
  const prepared = lines.map((line) => applyTestData(line, testData));
  const missing = [...new Set(prepared.flatMap((p) => p.missing || []))];
  if (missing.length) {
    const out = { status: "failed", reason: `Test data is missing a value for: ${missing.map((m) => "${" + m + "}").join(", ")}.`, steps: [], durationMs: 0 };
    emit({ type: "run-finished", ...out, passed: 0, failed: 0 });
    return out;
  }

  let failed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const shown = lines[i]; // the English as written, with ${NAME} - never the filled-in secret
    if (failed) {
      results.push({ index: i, text: shown, status: "skipped" });
      emit({ type: "step-finished", index: i, text: shown, status: "skipped" });
      continue;
    }
    emit({ type: "step-started", index: i, text: shown });
    let outcome;
    try {
      outcome = await runner.goal(prepared[i].text, {
        onProgress: (p) => emit({ type: "step-progress", index: i, message: redact(p && p.message, testData) }),
      });
    } catch (err) {
      outcome = { success: false, reason: err.message, actions: [] };
    }
    let shot = null;
    try { shot = await runner.screenshot(); } catch { /* a missing screenshot is not a failed step */ }
    const status = outcome.success ? "passed" : "failed";
    const row = {
      index: i,
      text: shown,
      status,
      ...(outcome.success ? {} : { reason: redact(outcome.reason, testData) }),
      actions: (outcome.actions || []).map((a) => redact(a.label || a, testData)),
    };
    results.push(row);
    emit({ type: "step-finished", ...row, ...(shot ? { screenshot: shot.base64, mime: shot.mime } : {}) });
    if (!outcome.success) failed = true;
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const bad = results.filter((r) => r.status === "failed").length;
  const out = { status: bad ? "failed" : "passed", steps: results, passed, failed: bad, durationMs: now() - started };
  emit({ type: "run-finished", ...out });
  return out;
}

/** Web: the shared goal loop over a Playwright page. */
function webRunner(page, { runGoalLoop, createPlaywrightSurface, callModel, maxSteps = 8, vision = true } = {}) {
  const loop = runGoalLoop || require("./core/goal-loop").runGoalLoop;
  const mk = createPlaywrightSurface || require("../web/surface/playwright-surface").createPlaywrightSurface;
  return {
    async goal(text, { onProgress } = {}) {
      const r = await loop(mk(page), text, { vision, maxSteps, callModel, onProgress });
      return { success: r.success, reason: r.reason, actions: r.actions };
    },
    async screenshot() {
      return { base64: (await page.screenshot({ type: "jpeg", quality: 50 })).toString("base64"), mime: "image/jpeg" };
    },
  };
}

/** Mobile: the hardware-tested autonomous loop over an Appium driver. */
function mobileRunner(driver, platform, { runAutonomousLoop, maxSteps = 8 } = {}) {
  const loop = runAutonomousLoop || require("./semantic-loop").runAutonomousLoop;
  return {
    async goal(text, { onProgress } = {}) {
      const r = await loop(driver, text, { platform, maxSteps });
      (r.steps || []).forEach((s, n) => onProgress && onProgress({ message: s.instruction, step: n + 1 }));
      const ok = r.stoppedBecause === "goal-achieved";
      return {
        success: ok,
        reason: ok ? "" : `${r.stoppedBecause}${r.reason ? `: ${r.reason}` : ""}`,
        actions: (r.steps || []).map((s) => ({ label: s.instruction })),
      };
    },
    async screenshot() {
      return { base64: await driver.takeScreenshot(), mime: "image/png" };
    },
  };
}

module.exports = { runEnglish, webRunner, mobileRunner };
