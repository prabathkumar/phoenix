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
async function decideNextAction(goal, snapshotText, history, refusedAttempt) {
  const historyLines = history.length === 0
    ? "(none yet -- this is the first step)"
    : history.map((step, i) => `${i + 1}. ${step.instruction} -> ${step.diffSummary}`).join("\n");

  const buildPrompt = (extraReminder) => [
    "You are operating a mobile app autonomously to achieve a goal, one",
    "action at a time. You will be told the goal, the current screen (as",
    "a list of elements), and the actions taken so far with their effect.",
    "",
    `Goal: "${goal}"`,
    "",
    "Actions taken so far:",
    historyLines,
    "",
    // Found for real, and enough on its own to matter: a written
    // reminder in the instructions below ("tap a matching tab before
    // typing over an already-filled field") did NOT reliably change
    // what the model actually chose -- it still picked the same wrong
    // action 3/3 on a live run. Telling it, after the fact, exactly
    // which specific action it just tried and why THIS device refused
    // it is a much stronger, situated signal than a general instruction
    // -- the same reason `decideNextAction`'s "type" without "text"
    // case already gets one bounded retry with pointed feedback rather
    // than just a better general reminder up front.
    ...(refusedAttempt
      ? [
          "IMPORTANT -- your last proposed action was rejected before it",
          `reached the device: you proposed {"instruction": ${JSON.stringify(refusedAttempt.instruction)}, "kind": ${JSON.stringify(refusedAttempt.kind)}}, `
            + `and it was refused because: ${refusedAttempt.reason}`,
          "Do not propose that same action again. Choose a genuinely",
          "different action instead -- if the refusal mentions a field",
          "likely being hidden behind a tab/toggle, tap that tab/toggle now.",
          "",
        ]
      : []),
    "Current screen:",
    snapshotText || "(no labeled/identified elements on screen)",
    "",
    "Decide ONE of the following and respond with ONLY that JSON object:",
    '  - Goal already achieved: {"done": true}',
    "  - You should not continue (goal is unclear, you're stuck in a loop,",
    "    or this requires a human judgment call -- e.g. an OTP screen, a",
    '    payment confirmation, anything irreversible): {"stop": true, "reason":',
    '    "waiting for OTP screen, needs a human"}',
    '  - The next single action to take: {"instruction": "tap the Login button",',
    '    "kind": "tap"} or {"instruction": "type the phone number into the Yes',
    '    Number field", "kind": "type", "text": "0123456789"}',
    "",
    // Found for real on a live BrowserStack run: the model's own
    // "instruction" field came back as the literal strings "type ... into
    // ..." and "type ... into [18]" -- not garbled output, but the
    // EXAMPLE FORMAT above (which used to show literal "..." placeholders)
    // and the snapshot's own "[18]"-style ref bracket copied verbatim,
    // instead of a real description being written. The examples above are
    // now concrete rather than "..."-shaped for exactly this reason; this
    // reminder is the second line of defense.
    "The two examples above are illustrations, not templates -- write your",
    'own real instruction and text; never output literal "..." or copy a',
    'snapshot ref like "[18]" into your instruction text. Describe the',
    "element in plain words instead (e.g. \"the empty input near 'Yes",
    "Number'\", not its ref number).",
    "",
    "Never propose more than one action at a time, and never guess at an",
    "irreversible or judgment-requiring step -- stop and hand back instead.",
    'A "type" action is INVALID without a non-empty "text" field -- if you',
    "mean to type something, you must include the exact text to type.",
    // Found for real on a live BrowserStack run: given a goal that
    // explicitly stated the phone number to log in with, the model typed
    // the literal string "Yes Number" into the (correctly resolved,
    // genuinely empty) Yes Number field -- copying the screen's own
    // "(empty input near: \"Yes Number\")" annotation instead of reading
    // the actual credential value out of the goal text above it. The
    // field-targeting was correct; only the chosen text was wrong. Spell
    // out the distinction explicitly rather than relying on the model to
    // infer it.
    'The "text" for a "type" action must be an actual value to enter --',
    'e.g. a credential explicitly given in the goal above. Never use a',
    'field\'s own label, placeholder, or its "(empty input near: ...)"',
    "hint text as the value to type -- that hint identifies WHICH field",
    "is empty, it is not something to type INTO it.",
    // Found for real on a live BrowserStack run: after a correct tap on
    // LOGIN with correct credentials already typed, the app showed an
    // "Invalid username/password entered" dialog (an OK button, no
    // input field). The model's next decision was still "type" -- but
    // the only thing on screen was a dismiss button, so resolution
    // correctly refused with "No editable input field found" and the
    // loop stopped on that failure instead of ever considering the
    // dialog itself. The model needs to actually look at what just
    // happened, not keep pursuing the original plan blindly.
    "If the current screen shows a dialog/alert reporting an error or",
    "validation failure (e.g. an \"Invalid username/password\" message,",
    "with only a dismiss/OK button and no input field), typing further is",
    "not possible there. Either tap that dialog's own button to dismiss",
    "it, or -- if the message indicates the goal cannot succeed as given",
    "(e.g. the credentials themselves were rejected, not just an ordinary",
    "step failure) -- stop and report that exact message as the reason,",
    "rather than guessing another action against fields that are no",
    "longer on screen.",
    // Found for real on a live BrowserStack run: a login screen showed
    // one phone-number input (already filled in by the previous step)
    // plus two unlabeled-looking tabs, "PASSWORD" and "USE TAC", for
    // choosing how to log in -- no password input field existed on
    // screen at all until one of those tabs was tapped. The model went
    // straight from "type the phone number" to "type the password"
    // without ever tapping "PASSWORD" first, so resolution had nothing
    // to bind "type the password" to except the one field that already
    // existed (the phone number field) -- correctly refused by the
    // anti-clobber check above, but the loop still failed because the
    // right prior action (tap the tab) was never taken.
    "Before typing a value, make sure a field for it is actually visible",
    "and empty (or otherwise appropriate to overwrite) on the CURRENT",
    "screen. If the only editable field you can see already holds a",
    "different value you already typed for something else, that is a sign",
    "the field you need isn't showing yet -- look for a tab, toggle, or",
    "button whose label matches what you're about to type (e.g. a",
    '"PASSWORD" tab before typing a password) and tap that first, rather',
    "than typing over a field that belongs to something else.",
    extraReminder,
  ].filter((line) => line !== undefined).join("\n");

  // Found for real: the local model would occasionally decide kind
  // "type" and simply omit "text" (most often right after a step whose
  // goal-supplied instruction embeds a literal credential value) --
  // reproduced on consecutive real-device runs at the exact same step,
  // not a one-off fluke. This is a malformed response, not an ambiguous
  // situation the model was right to hedge on, so one bounded retry with
  // a sharper reminder is a fair chance to comply before treating it as
  // a genuine stop -- we're not guessing the missing text ourselves,
  // only asking the model to actually answer the question it was asked.
  let result = await callOllamaJson(buildPrompt(undefined));
  if (result && typeof result.instruction === "string" && result.kind === "type" && typeof result.text !== "string") {
    result = await callOllamaJson(buildPrompt(
      'Your previous response chose kind "type" but left out "text" -- that is invalid. ' +
      'Either include the exact "text" to type, or choose a different decision (done/stop/tap) instead.'
    ));
  }

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
  // Found for real: a plain prompt reminder telling the model to tap a
  // tab/toggle before typing over an already-filled field did NOT
  // change its behavior -- it repeated the exact same refused action
  // 3/3 on a live run. Rather than fail the whole loop on the FIRST
  // veto, give the model a bounded number of chances to course-correct
  // once it's told, concretely, which action it tried and why the
  // device refused it (see decideNextAction's refusedAttempt param).
  // Capped (not unlimited) so a model that never adapts still fails
  // fast rather than burning the entire maxSteps budget retrying the
  // same mistake.
  const MAX_VETO_RETRIES = 2;
  let vetoRetries = 0;
  let refusedAttempt;

  try {
    for (let i = 0; i < maxSteps; i += 1) {
      let pageSource;
      try {
        pageSource = await driver.getPageSource();
      } catch (err) {
        return { stoppedBecause: "action-failed", reason: `couldn't read the current screen: ${err.message}`, steps };
      }

      const snapshot = buildGroundedSnapshot(pageSource);
      const decision = await decideNextAction(goal, snapshotToText(snapshot), steps, refusedAttempt);

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
        // Refuse to silently overwrite a field an earlier "type" step
        // in THIS run already set with different text -- see the
        // comment in semantic-act-executor.js for the real failure
        // this guards against (password instruction resolving to the
        // Yes Number field because no password input was visible yet,
        // clobbering it and turning "tap Login" into a no-op).
        beforeAct: ({ selector, kind: actKind, text }) => {
          if (actKind !== "type") return undefined;
          const selectorKey = `${selector.strategy}:${selector.value}`;
          const priorTypeStep = steps.find(
            (s) => s.kind === "type" && s.selector && `${s.selector.strategy}:${s.selector.value}` === selectorKey
          );
          if (priorTypeStep && priorTypeStep.text !== text) {
            return `refusing to type into the same element a previous step already typed a different value into (${selectorKey}) -- the intended target field is likely not visible yet (e.g. behind a tab/toggle that needs tapping first)`;
          }
          return undefined;
        },
      });

      if (!result.success) {
        if (vetoRetries < MAX_VETO_RETRIES) {
          vetoRetries += 1;
          refusedAttempt = { instruction: decision.instruction, kind: decision.kind, reason: result.reason };
          continue;
        }
        return { stoppedBecause: "action-failed", reason: result.reason, steps };
      }
      refusedAttempt = undefined;

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
