/**
 * State-diff reporting (docs/TESTOPS_MOBILE_SPEC.md §6, Phase 2 — "AI-native
 * semantic layer", third bullet). Third and last of the three Phase 2
 * building blocks named in the spec (grounded snapshot →
 * semantic-snapshot.js, semantic action layer → semantic-act.js, state-
 * diff reporting → this module). Diffs two grounded snapshots (before
 * and after a semantic action) and reports what appeared/disappeared in
 * the same ref-indexed shape the rest of this layer already speaks, so
 * it can feed:
 *   - Phase 2's assertion-inference step, the same way
 *     pipeline.js's inferAssertions() already diffs accessibility-tree
 *     labels for the guided path (see extractLabels/labelKey there) --
 *     this is the semantic-layer analogue of that, operating on
 *     buildGroundedSnapshot() elements/refs instead of raw labels.
 *   - Eventually, Phase 3's autonomous loop, which needs to see the
 *     effect of the action it just took to decide whether to continue,
 *     retry, or stop and hand back to a human (spec §6's Phase 3
 *     bullet) -- state-diff reporting is what "sees" for that loop.
 *
 * Deliberately independent of pipeline.js's existing labelKey()/
 * inferAssertions(): those keep driving the guided (Act 1) path exactly
 * as before. This module is the Act 2 equivalent, not a replacement --
 * see semantic-snapshot.js's header for why the two tracks are kept
 * separate.
 */

const { buildGroundedSnapshot } = require("./semantic-snapshot");

/**
 * Composite identity for one grounded-snapshot element, stable across a
 * before/after pair as long as the element itself didn't move in the
 * tree. Mirrors pipeline.js's labelKey() in spirit (resourceId + label
 * disambiguate same-text elements) but swaps in accessibilityId and
 * depth instead of pixel bounds, since SnapshotElement doesn't carry
 * bounds (see semantic-snapshot.js -- a semantic action targets *what*,
 * not *where*). depth is included for the same reason labelKey()
 * includes bounds: two structurally distinct elements can otherwise
 * share an identical (resourceId, label, accessibilityId) triple (e.g.
 * a list row's text repeated at multiple nesting levels).
 *
 * @param {import('./semantic-snapshot').SnapshotElement} element
 * @returns {string}
 */
function elementKey(element) {
  return `${element.resourceId || ""}|${element.accessibilityId || ""}|${element.label || ""}|${element.role}|${element.depth}`;
}

/**
 * @typedef {Object} SemanticDiff
 * @property {import('./semantic-snapshot').SnapshotElement[]} appeared -
 *   elements present after but not before -- candidates for a "this
 *   confirms the action worked" assertion.
 * @property {import('./semantic-snapshot').SnapshotElement[]} disappeared -
 *   elements present before but not after -- e.g. a dismissed dialog, a
 *   screen that was navigated away from.
 * @property {boolean} changed - true iff appeared.length or
 *   disappeared.length is nonzero; a quick check for "did anything
 *   happen" without inspecting both arrays.
 */

/**
 * Diffs two captured screens (typically a semantic action's before/
 * after pageSourceXml) at the grounded-snapshot level.
 *
 * @param {string} beforeXml
 * @param {string} afterXml
 * @returns {SemanticDiff}
 */
function diffSnapshots(beforeXml, afterXml) {
  const before = buildGroundedSnapshot(beforeXml);
  const after = buildGroundedSnapshot(afterXml);

  const beforeKeys = new Set(before.map(elementKey));
  const afterKeys = new Set(after.map(elementKey));

  return {
    appeared: after.filter((el) => !beforeKeys.has(elementKey(el))),
    disappeared: before.filter((el) => !afterKeys.has(elementKey(el))),
    get changed() {
      return this.appeared.length > 0 || this.disappeared.length > 0;
    },
  };
}

/**
 * Renders a diff as a short plain-language summary suitable for an LLM
 * prompt (a Phase 3 loop deciding what to do next, or a future
 * assertion-inference pass) -- deliberately terse, since this is meant
 * to sit alongside a snapshotToText() block, not duplicate it.
 *
 * @param {SemanticDiff} diff
 * @returns {string} e.g. "Appeared: \"Welcome\". Disappeared: \"Log In\"."
 *   or "No visible change." when diff.changed is false.
 */
function diffToText(diff) {
  if (!diff.changed) return "No visible change.";

  const describe = (el) => (el.label ? `"${el.label}"` : el.accessibilityId ? `"${el.accessibilityId}"` : el.role);
  const parts = [];
  if (diff.appeared.length > 0) {
    parts.push(`Appeared: ${diff.appeared.map(describe).join(", ")}.`);
  }
  if (diff.disappeared.length > 0) {
    parts.push(`Disappeared: ${diff.disappeared.map(describe).join(", ")}.`);
  }
  return parts.join(" ");
}

module.exports = { diffSnapshots, diffToText, elementKey };
