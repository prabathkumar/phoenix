/**
 * Closes the last still-open item from docs/PHOENIX_SPEC.md §6's Phase
 * 2 bullets: "state-diff reporting... feeds the assertion-inference
 * step directly." semantic-diff.js already computes what
 * appeared/disappeared; this module turns that into the same
 * {label, resourceId, stepIndex} assertion shape pipeline.js's
 * inferAssertions() already produces for the guided path, so a semantic
 * action's result can be reported/stored the same way a guided step's
 * assertion is, and so the existing opt-in LLM filter
 * (generation/llm.js's filterAssertions(), already built for the guided
 * path) can be reused as-is rather than duplicated.
 *
 * Deliberately narrow, matching inferAssertions()'s own philosophy
 * (see pipeline.js's comments): only elements that APPEARED are
 * candidate assertions ("this confirms the action worked") — a
 * disappeared element (a closed dialog, a screen navigated away from)
 * isn't something a generated script would assert is now displayed.
 * Within one diff, only the first element carrying a given label is
 * kept, for the same reason inferAssertions() dedups within a step:
 * nested accessibility nodes routinely expose the same text at
 * multiple positions (a button and its inner label child), which reads
 * as pure repetition rather than distinct confirmations.
 */

/**
 * @typedef {Object} SemanticAssertion
 * @property {number} [stepIndex] - present when passed in via options;
 *   omitted otherwise (a single ad-hoc semantic action, e.g.
 *   run-semantic-action.js, has no step index).
 * @property {string} label
 * @property {string} [resourceId]
 */

/**
 * @param {import('./semantic-diff').SemanticDiff} diff
 * @param {Object} [options]
 * @param {number} [options.stepIndex] - attached to every assertion
 *   produced, for a caller building up assertions across a multi-step
 *   run (engine/semantic-loop.js).
 * @returns {SemanticAssertion[]}
 */
function inferSemanticAssertions(diff, options = {}) {
  if (!diff || !diff.changed || diff.appeared.length === 0) return [];

  const assertions = [];
  const labelsSeen = new Set();

  for (const element of diff.appeared) {
    // Same fallback chain resolveSemanticAction's toSelector() uses,
    // but an assertion needs a label to be meaningful (asserting a
    // resource-id alone "is displayed" says nothing readable about
    // what changed) -- an appeared element with neither a label nor an
    // accessibility id worth showing is skipped, not asserted on.
    const label = element.label || element.accessibilityId;
    if (!label) continue;
    if (labelsSeen.has(label)) continue;
    labelsSeen.add(label);

    const assertion = { label, resourceId: element.resourceId };
    if (options.stepIndex !== undefined) assertion.stepIndex = options.stepIndex;
    assertions.push(assertion);
  }

  return assertions;
}

module.exports = { inferSemanticAssertions };
