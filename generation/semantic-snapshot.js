/**
 * Grounded snapshot layer (docs/PHOENIX_SPEC.md §6, Phase 2 — "AI-native
 * semantic layer"). First building block of the unattended/semantic
 * track: everything else Phase 2 needs (`act("tap the Login button")`,
 * and eventually Phase 3's autonomous loop) depends on turning a raw
 * accessibility tree into something an LLM can read and reference
 * directly, which is what this module does. The mobile equivalent of
 * the grounded ARIA-snapshot approach already common for web agents.
 *
 * This is intentionally separate from pipeline.js's rule-based
 * extraction (extractLabels/resolveElementAtCoordinate): those stay
 * exactly as they are, driving the guided-recording path (Act 1 — see
 * README's "AI" section) untouched. This module is additive
 * groundwork for Act 2 (unattended AI) and isn't wired into the live
 * recording session or run-session.js yet — it operates on a captured
 * pageSourceXml string, same input pipeline.js's extractLabels() takes,
 * so it can be exercised against any already-captured accessibility
 * tree (live or from a fixture) without touching the guided pipeline.
 *
 * Design: assign every interactive/labeled element a short, stable
 * (for one snapshot) integer ref, and render a compact indented text
 * block an LLM can read in a handful of lines instead of raw XML that
 * can run to tens of thousands of characters. semantic-act.js is what
 * actually asks an LLM to pick a ref from this text; this module only
 * builds and renders the snapshot itself.
 */

const { DOMParser } = require("@xmldom/xmldom");

// Same invisible-character rule generation/pipeline.js's isBlank()/
// cleanLabel() apply -- a rolled-up-empty label (e.g. a zero-width
// space) must not appear as a "real" element in the snapshot either.
const INVISIBLE_CHARS_RE = /[​‌‍﻿]/g;
function isBlank(value) {
  if (!value) return true;
  return value.replace(INVISIBLE_CHARS_RE, "").trim().length === 0;
}
function clean(value) {
  return value ? value.replace(INVISIBLE_CHARS_RE, "").trim() : undefined;
}

/**
 * @typedef {Object} SnapshotElement
 * @property {number} ref - stable within this one snapshot only; a
 *   fresh call to buildGroundedSnapshot() may assign different refs
 *   even for the "same" element if the tree shape changed at all, so
 *   callers must resolve a ref against the snapshot it came from, not
 *   cache it across snapshots.
 * @property {string} role - the element's tag name (e.g. "Button",
 *   "android.widget.EditText", "XCUIElementTypeButton") -- kept as the
 *   raw platform tag rather than normalized, so the text an LLM reads
 *   still carries real platform detail (a model can tell a Button from
 *   a Switch from a tag name even without further normalization).
 * @property {string} [label] - visible text/label/value/content-desc,
 *   whichever the tree populated -- see pipeline.js's extractLabels()
 *   for why this same attribute set covers both Android and iOS trees.
 * @property {string} [resourceId] - Android only.
 * @property {string} [accessibilityId] - content-desc (Android) or name
 *   (iOS) -- the WebDriver "accessibility id" strategy's value.
 * @property {number} depth - nesting depth from the tree root, purely
 *   for indentation when rendering; not semantically meaningful.
 */

/**
 * Walks a captured accessibility tree and produces a flat, ref-indexed
 * list of every element that carries a usable label and/or identifier
 * -- the elements a semantic action could plausibly target. Purely
 * structural containers with no label/id of their own are walked
 * (their children still appear) but not included as their own entry;
 * they add noise without adding anything an LLM could act on.
 *
 * @param {string} pageSourceXml
 * @returns {SnapshotElement[]}
 */
function buildGroundedSnapshot(pageSourceXml) {
  if (!pageSourceXml) return [];

  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString(pageSourceXml, "text/xml");

  const elements = [];
  let nextRef = 1;

  const walk = (node, depth) => {
    if (node.nodeType === 1 && node.getAttribute) {
      const text = node.getAttribute("text") || node.getAttribute("label") || node.getAttribute("value");
      const contentDesc = node.getAttribute("content-desc") || node.getAttribute("name");
      const resourceId = node.getAttribute("resource-id") || undefined; // Android only

      const label = (!isBlank(text) && clean(text)) || undefined;
      const accessibilityId = (!isBlank(contentDesc) && clean(contentDesc)) || undefined;

      if (label || accessibilityId || resourceId) {
        elements.push({
          ref: nextRef++,
          role: node.tagName,
          label,
          resourceId,
          accessibilityId,
          depth,
        });
      }
    }
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) walk(children[i], depth + 1);
  };
  walk(doc.documentElement, 0);

  return elements;
}

/**
 * Renders a snapshot as the compact indented text block an LLM reads,
 * e.g.:
 *   [1] Button "Log In" (id: login_button)
 *   [2] EditText "Username" (id: username_input)
 *   [3] StaticText "Welcome"
 *
 * Kept deliberately plain (no XML, no bounds/coordinates -- a semantic
 * action targets *what* to interact with, not *where*; engine/ and
 * capture/ already own coordinate-level concerns for the guided path).
 *
 * @param {SnapshotElement[]} elements
 * @returns {string}
 */
function snapshotToText(elements) {
  return elements
    .map((el) => {
      const indent = "  ".repeat(el.depth);
      const quoted = el.label ? ` "${el.label}"` : "";
      const idParts = [];
      if (el.resourceId) idParts.push(`id: ${el.resourceId}`);
      if (el.accessibilityId && el.accessibilityId !== el.label) idParts.push(`a11y: ${el.accessibilityId}`);
      const idSuffix = idParts.length ? ` (${idParts.join(", ")})` : "";
      return `${indent}[${el.ref}] ${el.role}${quoted}${idSuffix}`;
    })
    .join("\n");
}

/**
 * Looks up one element by its ref within a specific snapshot. Returns
 * undefined for an unknown ref (e.g. a stale ref from a previous
 * snapshot) -- callers must treat that as "couldn't resolve," not
 * guess at a fallback, per the same guided-then-autonomous caution
 * this whole layer is built around.
 *
 * @param {SnapshotElement[]} elements
 * @param {number} ref
 * @returns {SnapshotElement|undefined}
 */
function findByRef(elements, ref) {
  return elements.find((el) => el.ref === ref);
}

module.exports = { buildGroundedSnapshot, snapshotToText, findByRef };
