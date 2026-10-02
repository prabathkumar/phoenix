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
const { verifyExpectedOutcome, validateExpectShape } = require("../generation/outcome-verification");

// Default pause for a "wait" step when the step doesn't specify its own
// durationMs. Exists for a real timing gap found on real hardware
// (docs/STATUS.md, addons.json bug: the post-login-submit notification
// permission dialog appeared at a variable delay across two otherwise
// identical runs -- fast enough for two "tap Allow" steps to catch it
// in one run, and still not up by the time of the following step in
// another). 3s matches the slower observed delay with headroom.
const DEFAULT_WAIT_MS = 3000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * `kind` ("tap", "type", "scroll", "wait", or "tapIfExists") and an
 * `instruction` (the plain-language text handed to the same resolver
 * `executeSemanticAction` already uses); "type" steps also need a
 * `text` field. `optional: true` marks a step that's allowed to not
 * match anything on screen without failing the whole run (e.g. a
 * system dialog that doesn't always appear -- see
 * test-cases/login.json's first step).
 *
 * An optional `resolvedSelector: {strategy, value}` field is this
 * module's half of the selector-caching/self-healing architecture
 * (docs/STATUS.md): when present, it's a concrete WebDriver selector
 * previously proven correct on real hardware for this exact step, and
 * runScriptSteps() tries it FIRST (no LLM call) before falling back to
 * full semantic resolution -- see executeSemanticAction's
 * `cachedSelector` option in engine/semantic-act-executor.js. A step
 * with no `resolvedSelector` simply always resolves fresh, same as
 * before this field existed.
 *
 * A "tapIfExists" step is different in kind, not degree: it requires a
 * `selector: {strategy, value}` field (NOT resolved/learned -- a
 * literal, hand-authored locator from real evidence) and NEVER goes
 * through the LLM resolver, not even as a fallback. It exists because
 * recovery/conditional steps phrased as plain-language instructions
 * ("tap CLOSE if a dialog is showing") kept getting confidently
 * mis-resolved to an unrelated element on real hardware, across
 * multiple rounds of rewording the instruction and hardening the
 * resolver's prompt (docs/STATUS.md bugs #6/#7/#9/#11/#12/"Thirteenth" --
 * all the same two elements misread as something else). A `tapIfExists`
 * step cannot guess: the exact element either exists (tapped) or
 * doesn't (silently skipped) -- see executeSemanticAction's
 * `exactSelector` option for the implementation.
 *
 * An optional `expect: {appeared?: string[], disappeared?: string[]}`
 * field is the outcome-verification layer (generation/outcome-
 * verification.js): a step can report `success: true` (no WebDriver
 * error, a real element was clicked) while still hitting the WRONG
 * element -- the dominant real-bug class in this file's whole history
 * (docs/STATUS.md bugs #13-#18), invisible from the run summary alone.
 * `expect` lets a test-case author declare what should actually appear
 * or disappear on screen after this step, checked by plain substring
 * matching against the real, already-captured diff -- no model
 * judgment involved, so it can't itself be confidently wrong. A step
 * whose action "succeeds" but whose declared outcome doesn't show up
 * is now reported as a FAILURE, not a false success. See that module's
 * own doc comment for the full rationale and what this does and
 * doesn't close.
 *
 * @param {string} filePath - absolute or relative path to a .json file
 * @returns {Array<{kind: string, instruction: string, text?: string, optional?: boolean, resolvedSelector?: {strategy: string, value: string}, selector?: {strategy: string, value: string}, expect?: {appeared?: string[], disappeared?: string[]}}>}
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
  const VALID_KINDS = new Set(["tap", "type", "scroll", "wait", "tapIfExists"]);
  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") throw new Error(`test case file "${filePath}": step ${i} is not an object`);
    if (!VALID_KINDS.has(step.kind)) {
      throw new Error(`test case file "${filePath}": step ${i} has invalid "kind" (must be "tap", "type", "scroll", "wait", or "tapIfExists"): ${step.kind}`);
    }
    if (typeof step.instruction !== "string" || !step.instruction) {
      throw new Error(`test case file "${filePath}": step ${i} is missing a non-empty "instruction"`);
    }
    if (step.kind === "type" && typeof step.text !== "string") {
      throw new Error(`test case file "${filePath}": step ${i} is a "type" step but has no "text"`);
    }
    if (step.kind === "tapIfExists") {
      const sel = step.selector;
      if (!sel || typeof sel !== "object" || typeof sel.strategy !== "string" || typeof sel.value !== "string") {
        throw new Error(`test case file "${filePath}": step ${i} is a "tapIfExists" step but has no valid "selector" ({strategy, value} strings)`);
      }
    }
    if (step.resolvedSelector !== undefined) {
      const sel = step.resolvedSelector;
      if (!sel || typeof sel !== "object" || typeof sel.strategy !== "string" || typeof sel.value !== "string") {
        throw new Error(`test case file "${filePath}": step ${i} has an invalid "resolvedSelector" (must be {strategy, value} strings)`);
      }
    }
    const expectError = validateExpectShape(step.expect);
    if (expectError) {
      throw new Error(`test case file "${filePath}": step ${i} has an invalid "expect" field: ${expectError}`);
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
 * A `"wait"` step is a pure timing pause -- no instruction resolution,
 * no device action, and so no call to `executeSemanticAction` at all.
 * It exists for a real race found on real hardware: the post-submit
 * notification-permission dialog appeared at a variable delay across
 * two otherwise-identical runs, fast enough in one for the following
 * "tap Allow" steps to catch it, and still not up by the next step in
 * another -- a step sequence has no way to out-guess that without an
 * explicit pause. `durationMs` defaults to `DEFAULT_WAIT_MS` (3000) if
 * not given. `sleepFn` is injected the same way `executeSemanticAction`
 * is, so tests can run a "wait" step without actually waiting.
 *
 * Each step's optional `resolvedSelector` (see loadTestCaseSteps) is
 * passed through to executeSemanticAction as `cachedSelector`, so a
 * step proven correct on a prior run replays deterministically instead
 * of re-asking the model to guess again from scratch -- the fix for
 * docs/STATUS.md bugs #6/#7/#11/#12 (the same correctly-resolving step
 * independently mis-resolving a different way on a later run). The
 * returned `updatedSteps` is the original `steps` array (same shape,
 * placeholders unresolved) with `resolvedSelector` filled in or updated
 * for every step that successfully resolved -- a fresh resolution
 * (cache miss or no cache yet) records the newly-proven selector, and a
 * cache hit simply confirms the existing one is still correct. The
 * caller is responsible for persisting `updatedSteps` back to the
 * test-case JSON file if it wants that selector reused on the next run;
 * this function never touches the filesystem itself.
 *
 * @param {Object} driver - a started WebdriverIO session
 * @param {Array<{kind: string, instruction: string, text?: string, direction?: string, durationMs?: number, optional?: boolean, resolvedSelector?: {strategy: string, value: string}, selector?: {strategy: string, value: string}}>} steps
 * @param {{platform: string, executeSemanticAction: Function, sleepFn?: Function}} options -
 *   `executeSemanticAction` is injected (not required() here) so
 *   callers/tests can fake it the same way existing tests already do
 *   for run-batch-executions.js.
 * @returns {Promise<{success: boolean, detail: string, updatedSteps: Array<Object>}>}
 */
async function runScriptSteps(driver, steps, { platform, executeSemanticAction, sleepFn = defaultSleep }) {
  const resolvedSteps = steps.map((step) => ({ ...step, text: resolveStepText(step) }));
  // Carry the ORIGINAL (unresolved-text) steps forward for the
  // updatedSteps return value -- we must never write a resolved
  // "${PASSWORD}"-style secret's literal value back out to disk.
  const updatedSteps = steps.map((step) => ({ ...step }));
  let lastResult;
  for (let i = 0; i < resolvedSteps.length; i += 1) {
    const step = resolvedSteps[i];
    if (step.kind === "wait") {
      await sleepFn(typeof step.durationMs === "number" ? step.durationMs : DEFAULT_WAIT_MS);
      continue;
    }
    const result = await executeSemanticAction(driver, step.instruction, {
      kind: step.kind,
      text: step.text,
      platform,
      direction: step.direction,
      // "tapIfExists" is given a literal, hand-authored selector and
      // never the AI-learned cache -- see loadTestCaseSteps' doc
      // comment on why these two are deliberately different fields.
      cachedSelector: step.kind === "tapIfExists" ? undefined : step.resolvedSelector,
      exactSelector: step.kind === "tapIfExists" ? step.selector : undefined,
    });
    if (!result.success) {
      if (step.optional) continue;
      return { success: false, detail: `step "${step.instruction}" failed: ${result.reason}`, updatedSteps };
    }
    // Outcome verification: a step can report success (no WebDriver
    // error) while having hit the wrong element entirely -- this is
    // the check that catches that class instead of trusting the raw
    // success flag. Skipped for a "tapIfExists" step that found
    // nothing to do (result.skipped) -- there's no action outcome to
    // verify when the step correctly did nothing. A step that fails
    // verification is treated exactly like any other failure (honors
    // `optional`, never silently persists a selector that just proved
    // wrong -- see the resolvedSelector-write below, deliberately
    // unreached on this path).
    if (!result.skipped && step.expect) {
      const verification = verifyExpectedOutcome(result.diff, step.expect);
      if (!verification.ok) {
        if (step.optional) continue;
        return {
          success: false,
          detail: `step "${step.instruction}" reported success but failed outcome verification: ${verification.reason}`,
          updatedSteps,
        };
      }
    }
    // A "tapIfExists" step's selector is hand-authored evidence, not a
    // learned cache entry -- never let it get overwritten/duplicated
    // into `resolvedSelector` by the generic selector-learning below.
    if (result.selector && step.kind !== "tapIfExists") {
      updatedSteps[i] = { ...updatedSteps[i], resolvedSelector: result.selector };
    }
    lastResult = result;
  }
  return {
    success: true,
    detail: lastResult ? lastResult.diffSummary : "test case completed with no steps run",
    updatedSteps,
  };
}

/**
 * Writes runScriptSteps()'s `updatedSteps` back into a test-case JSON
 * file on disk -- the other half of the read side wired up in
 * loadTestCaseSteps/runScriptSteps above. Preserves the file's original
 * top-level shape (a bare steps array, or an object with a "steps"
 * array plus whatever other keys it had, e.g. a "description"). Only
 * ever writes `resolvedSelector`/other step fields exactly as given in
 * `updatedSteps` -- callers must pass the ORIGINAL (unresolved-text)
 * steps here, never resolveSteps()'s output, or a real credential typed
 * as a literal "${ENV_VAR}" placeholder in the file would get baked in
 * as its resolved secret value on disk.
 *
 * Deliberately synchronous (writeFileSync): this runs once, after a
 * single real-device iteration completes, never in a hot loop or
 * concurrently with another write to the same file, so there's no
 * reason to pay async complexity for it.
 *
 * @param {string} filePath - the same path loadTestCaseSteps() read
 * @param {Array<Object>} updatedSteps - runScriptSteps()'s updatedSteps
 */
function persistResolvedSelectors(filePath, updatedSteps) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    fs.writeFileSync(filePath, JSON.stringify(updatedSteps, null, 2) + "\n");
  } else {
    parsed.steps = updatedSteps;
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n");
  }
}

module.exports = {
  loadTestCaseSteps,
  resolveStepText,
  resolveSteps,
  requiredEnvVars,
  runScriptSteps,
  persistResolvedSelectors,
};
