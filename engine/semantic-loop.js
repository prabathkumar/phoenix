/**
 * Phase 3 — autonomous exploration (docs/PHOENIX_SPEC.md §6, "R&D
 * track, not customer-facing until proven"). First skeleton of the
 * autonomous loop: takes a goal in plain language, reads the grounded
 * snapshot, asks the local Ollama model to decide the next single
 * action (or to stop), executes it via engine/semantic-act-executor.js,
 * feeds the resulting diff back in as context for the next decision,
 * and repeats — until the model says the goal is reached, the model
 * itself asks to stop, an action fails/can't be resolved, or a hard
 * step limit is hit.
 *
 * This is explicitly NOT wired into any product surface, the guided
 * recording path, or run-session.js/session-manager.js. Per the spec's
 * own framing, this stays an R&D-only capability, exercised against
 * internal apps, until it's proven — it is not something a customer
 * or even a Phoenix tester triggers today. `run-semantic-loop.js` (if
 * and when that's built) would be its own separate CLI, mirroring how
 * run-semantic-action.js sits apart from run-session.js.
 *
 * Stopping discipline (the entire point of spec §2's guided-first
 * argument, carried through to here): every stop reason is explicit
 * and reported, nothing is silently retried, and there is no default
 * "keep going" — a step the model can't confidently resolve, or that
 * fails to execute, ends the loop rather than being retried or worked
 * around. A human reviews the step log and decides what happens next.
 */

const { executeSemanticAction } = require("./semantic-act-executor");
const { callOllamaJson } = require("../generation/llm");
const { buildGroundedSnapshot, snapshotToText } = require("../generation/semantic-snapshot");

const DEFAULT_MAX_STEPS = 10;

/**
 * @typedef {Object} LoopStep
 * @property {string} instruction - the instruction the model chose for this step.
 * @property {"tap"|"type"} kind
 * @property {string} [text] - present when kind is "type".
 * @property {{strategy: string, value: string}} selector - what was actually acted on.
 * @property {string} diffSummary - what visibly changed as a result.
 * @property {import('../generation/semantic-assertions').SemanticAssertion[]} assertions -
 *   candidate assertions inferred from this step's diff (see
 *   generation/semantic-assertions.js), stamped with this step's index.
 */

/**
 * @typedef {Object} LoopResult
 * @property {"goal-achieved"|"model-requested-stop"|"action-failed"|"max-steps-reached"|"error"} stoppedBecause
 * @property {string} [reason] - present for every stop reason except
 *   "goal-achieved" and "max-steps-reached" (self-explanatory).
 * @property {LoopStep[]} steps - every action successfully carried out
 *   before stopping, in order. Empty if the very first decision was to
 *   stop, or the first action failed.
 */

/**
 * Asks the model to decide the single next action toward `goal`, given
 * the current screen and what's happened so far. Distinct response
 * shapes, all through the same "respond with ONLY JSON" contract the
 * rest of this layer uses:
 *   {"done": true} - the model believes the goal is already achieved.
 *   {"stop": true, "reason": "..."} - the model can't/won't continue
 *     (goal unclear, stuck, needs a human judgment call -- spec §2).
 *   {"instruction": "...", "kind": "tap"|"type", "text": "..."} - the
 *     next single action to take (text only required for "type").
 *
 * @returns {Promise<{decision: "done"}|{decision: "stop", reason: string}|{decision: "act", instruction: string, kind: "tap"|"type", text?: string}>}
 */
async function decideNextAction(goal, snapshotText, history) {
  const historyLines = history.length === 0
    ? "(none yet -- this is the first step)"
    : history.map((step, i) => `${i + 1}. ${step.instruction} -> ${step.diffSummary}`).join("\n");

  const prompt = [
    "You are operating a mobile app autonomously to achieve a goal, one",
    "action at a time. You will be told the goal, the current screen (as",
    "a list of elements), and the actions taken so far with their effect.",
    "",
    `Goal: "${goal}"`,
    "",
    "Actions taken so far:",
    historyLines,
    "",
    "Current screen:",
    snapshotText || "(no labeled/identified elements on screen)",
    "",
    "Decide ONE of the following and respond with ONLY that JSON object:",
    '  - Goal already achieved: {"done": true}',
    '  - You should not continue (goal is unclear, you\'re stuck in a loop,',
    "    or this requires a human judgment call -- e.g. an OTP screen, a",
    '    payment confirmation, anything irreversible): {"stop": true, "reason": "..."}',
    '  - The next single action to take: {"instruction": "tap the ... button",',
    '    "kind": "tap"} or {"instruction": "type ... into ...", "kind": "type",',
    '    "text": "..."}',
    "",
    "Never propose more than one action at a time, and never guess at an",
    "irreversible or judgment-requiring step -- stop and hand back instead.",
  ].join("\n");

  const result = await callOllamaJson(prompt);

  if (result && result.done === true) return { decision: "done" };
  if (result && result.stop === true) {
    return { decision: "stop", reason: typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : "model requested stop" };
  }
  if (result && typeof result.instruction === "string" && (result.kind === "tap" || result.kind === "type")) {
    if (result.kind === "type" && typeof result.text !== "string") {
      throw new Error('model chose kind "type" without "text"');
    }
    return { decision: "act", instruction: result.instruction, kind: result.kind, text: result.text };
  }

  throw new Error("model response didn't match any expected decision shape");
}

/**
 * Runs the autonomous loop against a live session.
 *
 * @param {import('webdriverio').Browser} driver - an already-started session.
 * @param {string} goal - e.g. "log in and reach the account settings screen".
 * @param {Object} [options]
 * @param {number} [options.maxSteps] - hard cap, default 10. Never
 *   raised automatically -- a loop that needs more steps than this to
 *   reach a goal is itself a signal worth a human looking at, not
 *   something to paper over with a bigger number.
 * @param {"android"|"ios"} [options.platform] - defaults to "android".
 * @returns {Promise<LoopResult>}
 */
async function runAutonomousLoop(driver, goal, options = {}) {
  const maxSteps = options.maxSteps || DEFAULT_MAX_STEPS;
  const platform = options.platform === "ios" ? "ios" : "android";
  const steps = [];

  try {
    for (let i = 0; i < maxSteps; i += 1) {
      let pageSource;
      try {
        pageSource = await driver.getPageSource();
      } catch (err) {
        return { stoppedBecause: "action-failed", reason: `couldn't read the current screen: ${err.message}`, steps };
      }

      const snapshot = buildGroundedSnapshot(pageSource);
      const decision = await decideNextAction(goal, snapshotToText(snapshot), steps);

      if (decision.decision === "done") {
        return { stoppedBecause: "goal-achieved", steps };
      }
      if (decision.decision === "stop") {
        return { stoppedBecause: "model-requested-stop", reason: decision.reason, steps };
      }

      const result = await executeSemanticAction(driver, decision.instruction, {
        kind: decision.kind,
        text: decision.text,
        platform,
      });

      if (!result.success) {
        return { stoppedBecause: "action-failed", reason: result.reason, steps };
      }

      const stepIndex = steps.length;
      steps.push({
        instruction: decision.instruction,
        kind: decision.kind,
        text: decision.text,
        selector: result.selector,
        diffSummary: result.diffSummary || "(couldn't read the screen after acting)",
        // Reuses executeSemanticAction's own inferSemanticAssertions()
        // call (spec §6's "state-diff reporting... feeds the assertion-
        // inference step directly") -- just stamped with this step's
        // index so a multi-step run's assertions are attributable.
        assertions: (result.assertions || []).map((a) => ({ ...a, stepIndex })),
      });
    }

    return { stoppedBecause: "max-steps-reached", steps };
  } catch (err) {
    // Same fail-safe contract as the rest of this layer: an unexpected
    // failure (a malformed model response, a thrown error anywhere in
    // the decision loop) stops and reports rather than propagating --
    // callers never need their own try/catch around this.
    return { stoppedBecause: "error", reason: err.message, steps };
  }
}

module.exports = { runAutonomousLoop, decideNextAction };
