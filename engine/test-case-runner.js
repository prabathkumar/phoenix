/**
 * Generic, data-driven test-case runner -- the generalization of
 * run-batch-executions.js's original `login-script` mode. That mode
 * proved a real architectural point on real hardware (docs/STATUS.md
 * bugs 18-23): a known, fixed step sequence should never be left to
 * the autonomous loop's per-step model planning, because the model
 * doesn't reliably recognize "this sequence is done, do the next fixed
 * thing" even when every individual step resolves correctly. But that
 * mode's step sequence was still hardcoded JS (`LOGIN_SCRIPT_STEPS` in
 * run-batch-executions.js) -- a new flow meant a new array in a new
 * commit, not something a tester could write themselves.
 *
 * This module is the "test cases in, not hardcoded JS" piece of the
 * "Playwright for mobile, with Appium as the engine" direction: a test
 * case is a plain JSON file (see test-cases/login.json for the first
 * real one, extracted byte-for-byte from the proven LOGIN_SCRIPT_STEPS
 * sequence), and running it still goes through the exact same
 * per-instruction resolver (`executeSemanticAction`) that bugs 12/13/
 * 19/20/21/22/23 already proved correct -- nothing about HOW a single
 * step resolves against a live screen changes here. Only WHERE the
 * step sequence comes from changes: data, not code.
 */

const fs = require("fs");

// Matches "${ENV_VAR_NAME}" exactly (the whole string, not a
// substring) -- a test case's `text` field is either a literal string
// typed as-is, or a placeholder naming an environment variable to read
// at run time (for credentials/secrets that must never be committed to
// a test-case JSON file in the repo). Partial interpolation (e.g.
// "prefix-${VAR}") is deliberately NOT supported: it would silently
// invite exactly the kind of partial-credential-in-a-committed-file
// mistake this exists to prevent.
const ENV_PLACEHOLDER_RE = /^\$\{([A-Z0-9_]+)\}$/;

/**
 * Loads and validates a test-case JSON file. Each step must have a
 * `kind` ("tap" or "type") and an `instruction` (the plain-language
 * text handed to the same resolver `executeSemanticAction` already
 * uses); "type" steps also need a `text` field. `optional: true` marks
 * a step that's allowed to not match anything on screen without
 * failing the whole run (e.g. a system dialog that doesn't always
 * appear -- see test-cases/login.json's first step).
 *
 * @param {string} filePath - absolute or relative path to a .json file
 * @returns {Array<{kind: string, instruction: string, text?: string, optional?: boolean}>}
 */
function loadTestCaseSteps(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`test case file "${filePath}" is not valid JSON: ${err.message}`);
  }
  const steps = Array.isArray(parsed) ? parsed : parsed.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`test case file "${filePath}" must be a JSON array of steps, or an object with a "steps" array`);
  }
  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") throw new Error(`test case file "${filePath}": step ${i} is not an object`);
    if (step.kind !== "tap" && step.kind !== "type" && step.kind !== "scroll") {
      throw new Error(`test case file "${filePath}": step ${i} has invalid "kind" (must be "tap", "type", or "scroll"): ${step.kind}`);
    }
    if (typeof step.instruction !== "string" || !step.instruction) {
      throw new Error(`test case file "${filePath}": step ${i} is missing a non-empty "instruction"`);
    }
    if (step.kind === "type" && typeof step.text !== "string") {
      throw new Error(`test case file "${filePath}": step ${i} is a "type" step but has no "text"`);
    }
  });
  return steps;
}

/**
 * Resolves a step's `text` field: an "${ENV_VAR}" placeholder is read
 * from process.env at call time (never cached/baked in at load time,
 * so the same loaded steps work across runs with different env), any
 * other string is used literally. Returns undefined for a step with no
 * `text` (a "tap" step). Pure given its env-var input, unit-tested.
 *
 * @param {{kind: string, text?: string}} step
 * @returns {string|undefined}
 */
function resolveStepText(step) {
  if (typeof step.text !== "string") return undefined;
  const match = ENV_PLACEHOLDER_RE.exec(step.text);
  if (!match) return step.text;
  const value = process.env[match[1]];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`test case step references environment variable "${match[1]}", which is not set`);
  }
  return value;
}

/**
 * Lists every "${ENV_VAR}" placeholder referenced anywhere in a loaded
 * test case's steps, without resolving them -- used to give a single
 * clear "these env vars are required" error up front (same UX
 * run-batch-executions.js's original login-specific check already had)
 * instead of failing partway through a run on whichever step happens
 * to need the missing one.
 *
 * @param {Array<{text?: string}>} steps
 * @returns {string[]}
 */
function requiredEnvVars(steps) {
  const names = new Set();
  for (const step of steps) {
    if (typeof step.text !== "string") continue;
    const match = ENV_PLACEHOLDER_RE.exec(step.text);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/**
 * Resolves every step's `text` from process.env up front, returning a
 * new array of steps with literal text only (no more "${VAR}"
 * placeholders) -- see runScriptSteps' own doc comment for exactly why
 * this must happen synchronously, before the caller's first `await`,
 * rather than lazily during the step loop.
 *
 * @param {Array<{kind: string, instruction: string, text?: string, direction?: string, optional?: boolean}>} steps
 * @returns {Array<{kind: string, instruction: string, text?: string, optional?: boolean}>}
 */
function resolveSteps(steps) {
  return steps.map((step) => ({ ...step, text: resolveStepText(step) }));
}

/**
 * Runs a loaded test case's steps, in order, against an already-started
 * driver session -- the same executeSemanticAction() loop
 * run-batch-executions.js's original runOneLoginScriptIteration used
 * inline, now shared by both that mode and the generic `test-case`
 * mode. Stops and reports failure on the first non-optional step that
 * doesn't resolve; an optional step that fails to resolve is skipped,
 * not an error (see loadTestCaseSteps' doc comment).
 *
 * Every step's `text` is resolved from process.env up front, before
 * the first `await` -- not lazily inside the loop. Found necessary
 * from this module's own test suite: `node --test` runs the tests in
 * one file concurrently by default, and several tests here mutate
 * process.env for the duration of one async test function (see
 * test/run-batch-executions.test.js's withEnvAndFreshModule). A step
 * loop that reads process.env again after each `await
 * executeSemanticAction(...)` can resume after a *different*,
 * concurrently-running test has already restored/changed that same
 * env var -- resolving everything synchronously up front (same timing
 * the original hardcoded `text: () => LOGIN_PASSWORD` closures
 * effectively had) avoids that race entirely.
 *
 * @param {Object} driver - a started WebdriverIO session
 * @param {Array<{kind: string, instruction: string, text?: string, direction?: string, optional?: boolean}>} steps
 * @param {{platform: string, executeSemanticAction: Function}} options -
 *   `executeSemanticAction` is injected (not required() here) so
 *   callers/tests can fake it the same way existing tests already do
 *   for run-batch-executions.js.
 * @returns {Promise<{success: boolean, detail: string}>}
 */
async function runScriptSteps(driver, steps, { platform, executeSemanticAction }) {
  const resolvedSteps = steps.map((step) => ({ ...step, text: resolveStepText(step) }));
  let lastResult;
  for (const step of resolvedSteps) {
    const result = await executeSemanticAction(driver, step.instruction, { kind: step.kind, text: step.text, platform, direction: step.direction });
    if (!result.success) {
      if (step.optional) continue;
      return { success: false, detail: `step "${step.instruction}" failed: ${result.reason}` };
    }
    lastResult = result;
  }
  return { success: true, detail: lastResult ? lastResult.diffSummary : "test case completed with no steps run" };
}

module.exports = { loadTestCaseSteps, resolveStepText, resolveSteps, requiredEnvVars, runScriptSteps };
