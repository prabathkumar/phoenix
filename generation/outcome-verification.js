/**
 * Outcome verification -- the first real piece of the
 * requirement-traceability layer flagged as a standing gap throughout
 * docs/STATUS.md (bugs #16, #18, and the whole #13-#18 "wrong but
 * functional click" class): every layer in this codebase is built to
 * report "unresolved" rather than guess, but none of them could tell
 * the difference between "the right button was clicked" and "a
 * different, equally real button was clicked" -- both produce a real,
 * non-empty diff, and "success: true" has only ever meant "no step
 * errored," never "the real-world goal was reached."
 *
 * Scope, stated plainly: this is deterministic, opt-in, per-step
 * assertion checking -- NOT a new judgment call handed to the model.
 * A test-case author declares what should be true after a step (an
 * element that should appear, one that should disappear) using the
 * same appeared/disappeared vocabulary generation/semantic-diff.js
 * already computes for every action; this module only compares that
 * already-computed diff against the declaration. Deliberately NOT an
 * LLM call: asking a model "did this succeed?" is exactly the kind of
 * confident-but-wrong judgment this whole codebase has spent 18+ bugs
 * learning not to trust (docs/STATUS.md). A plain string-containment
 * check against real, already-captured evidence can't hallucinate.
 *
 * What this does NOT close: it only catches a wrong outcome on a step
 * an author bothered to annotate with `expect`. Bugs #16/#18 happened
 * on steps nobody had written an assertion for yet -- this makes that
 * possible going forward, it doesn't retroactively protect every step
 * in every existing test case. Closing the gap everywhere still means
 * going through test cases and adding `expect` to the steps that
 * matter most (anything that navigates, confirms, or submits).
 */

/**
 * @param {import('./semantic-snapshot').SnapshotElement} element
 * @param {string} wanted
 * @returns {boolean} case-insensitive substring match against the
 *   element's own label, falling back to its accessibility id when it
 *   has no label (mirrors semantic-diff.js's own diffToText() fallback
 *   order, so "what counts as this element's name" stays consistent
 *   across the codebase).
 */
function elementMatches(element, wanted) {
  const text = (element.label || element.accessibilityId || "").toLowerCase();
  return text.includes(wanted.toLowerCase());
}

/**
 * Checks a captured diff against a step's declared `expect`.
 *
 * @param {import('./semantic-diff').SemanticDiff|undefined} diff - the
 *   diff executeSemanticAction() captured for this step, or undefined
 *   if none was captured (e.g. a post-action screen read failed).
 * @param {Object} [expect] - the step's own `expect` field. Undefined
 *   means "no assertion declared" -- always verifies ok, so a step
 *   with no `expect` behaves exactly as it did before this module
 *   existed.
 * @param {string[]} [expect.appeared] - substrings that must each match
 *   at least one element in diff.appeared.
 * @param {string[]} [expect.disappeared] - substrings that must each
 *   match at least one element in diff.disappeared.
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyExpectedOutcome(diff, expect) {
  if (!expect) return { ok: true };

  if (!diff) {
    return { ok: false, reason: "this step declared an expected outcome, but no screen diff was captured to check it against" };
  }

  const missingAppeared = (expect.appeared || []).filter(
    (wanted) => !diff.appeared.some((el) => elementMatches(el, wanted))
  );
  const missingDisappeared = (expect.disappeared || []).filter(
    (wanted) => !diff.disappeared.some((el) => elementMatches(el, wanted))
  );

  if (missingAppeared.length === 0 && missingDisappeared.length === 0) {
    return { ok: true };
  }

  const parts = [];
  if (missingAppeared.length > 0) {
    parts.push(`expected to appear but didn't: ${missingAppeared.map((s) => `"${s}"`).join(", ")}`);
  }
  if (missingDisappeared.length > 0) {
    parts.push(`expected to disappear but didn't: ${missingDisappeared.map((s) => `"${s}"`).join(", ")}`);
  }
  const actual = describeDiffForReason(diff);
  return { ok: false, reason: `outcome verification failed -- ${parts.join("; ")} (what actually happened: ${actual})` };
}

/**
 * A short, human-readable summary of what a diff actually contained --
 * deliberately not generation/semantic-diff.js's own diffToText() (that
 * one's tuned for the LLM resolver's prompt), just enough here to make
 * a verification-failure reason self-explanatory without a separate
 * log lookup.
 */
function describeDiffForReason(diff) {
  const describe = (el) => (el.label ? `"${el.label}"` : el.accessibilityId ? `"${el.accessibilityId}"` : el.role);
  const appeared = diff.appeared.length > 0 ? `appeared: ${diff.appeared.map(describe).join(", ")}` : "nothing appeared";
  const disappeared = diff.disappeared.length > 0 ? `disappeared: ${diff.disappeared.map(describe).join(", ")}` : "nothing disappeared";
  return `${appeared}; ${disappeared}`;
}

/**
 * Validates a step's `expect` field shape (loadTestCaseSteps calls this
 * so a malformed assertion is caught at load time, not three hours into
 * a real-device run). `expect`, if present, must be an object with at
 * least one of `appeared`/`disappeared` as a non-empty array of
 * non-empty strings -- an `expect: {}` with neither would always pass
 * trivially, which is almost certainly an authoring mistake (a forgotten
 * value), not an intentional "verify nothing" declaration.
 *
 * @param {*} expect
 * @returns {string|undefined} an error message if invalid, undefined if ok/absent.
 */
function validateExpectShape(expect) {
  if (expect === undefined) return undefined;
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
    return 'must be an object with an "appeared" and/or "disappeared" array of strings';
  }
  const isNonEmptyStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
  const hasAppeared = expect.appeared !== undefined;
  const hasDisappeared = expect.disappeared !== undefined;
  if (hasAppeared && !isNonEmptyStringArray(expect.appeared)) {
    return '"appeared" must be a non-empty array of non-empty strings';
  }
  if (hasDisappeared && !isNonEmptyStringArray(expect.disappeared)) {
    return '"disappeared" must be a non-empty array of non-empty strings';
  }
  if (!hasAppeared && !hasDisappeared) {
    return 'must declare at least one of "appeared" or "disappeared" (an empty {} would always pass trivially)';
  }
  return undefined;
}

module.exports = { verifyExpectedOutcome, validateExpectShape };
