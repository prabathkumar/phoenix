/**
 * Auto-heal: when a locator a script was written with stops resolving
 * (an id got renamed, a layout shifted, a resource-id got obfuscated
 * differently in a new build), fall back to the semantic layer instead
 * of failing outright. This is the natural fusion of the two acts —
 * see README's Act 1/Act 2 framing and docs/PHOENIX_SPEC.md §6: Act 1's
 * guided scripts get Act 2's resolution as a safety net, not a
 * replacement for their normal (fast, deterministic) selector.
 *
 * Scope: this module heals ONE locator lookup at test-run time. It does
 * not change how scripts are recorded or generated (capture/recorder.js,
 * generation/pipeline.js, and every guided-path test are untouched) —
 * a generated script keeps using its normal `$(selector)` calls exactly
 * as before. Auto-heal is something a script (or a future test-runner
 * wrapper) OPTS INTO by calling resolveElementWithHealing() instead of
 * `driver.$(selector)` directly, passing along the human-readable
 * description already captured for that step (the same label/text
 * pipeline.js's extractLabels() already resolves from the accessibility
 * tree) as what to fall back to resolving semantically. Nothing here is
 * wired into the guided pipeline's own code generation yet — this is
 * the capability, not (yet) the default.
 *
 * Fail-safe by the same contract as the rest of this layer: this never
 * throws. The normal-path failure ("element with this selector isn't
 * there") is not swallowed silently either — the result always says
 * plainly whether healing was needed, and if healing itself couldn't
 * find anything, the original reason is preserved so a test failure
 * still explains what actually went wrong, not just "auto-heal failed".
 */

const { resolveSemanticAction } = require("../generation/semantic-act");
const { buildSelector } = require("../generation/pipeline");

/**
 * @typedef {Object} HealResult
 * @property {import('webdriverio').Element|null} element - the resolved
 *   element, ready to `.click()`/`.setValue()`/etc., or null if neither
 *   the original selector nor healing found anything.
 * @property {boolean} healed - true iff the ORIGINAL selector did not
 *   resolve (or resolved to the wrong element, see `mismatchReason`) and
 *   a semantic fallback found the element instead.
 * @property {{strategy: string, value: string}} [healedSelector] -
 *   present when healed is true: what actually worked, so a caller can
 *   log/report "the recorded selector broke, this is what replaced it"
 *   rather than silently moving on.
 * @property {string} [mismatchReason] - present when healed is true AND
 *   the original selector DID find something, but it verified as the
 *   wrong element (see `expectedLabel`) rather than finding nothing at
 *   all -- distinguishes "the id changed" from "the id still resolves,
 *   but to a different element now" (a structural/xpath path shift),
 *   which is a meaningfully different failure to have logged.
 * @property {string} [reason] - present when element is null: why
 *   neither path found anything.
 */

/**
 * @param {import('webdriverio').Browser} driver
 * @param {Object} params
 * @param {string} params.selector - the original, recorded selector
 *   string (e.g. from a generated script — same format buildSelector()
 *   in pipeline.js produces).
 * @param {string} [params.description] - a human-readable description
 *   of the element to fall back to resolving semantically if `selector`
 *   doesn't resolve, e.g. "the Login button" or the label captured at
 *   recording time. Without this, healing can't be attempted at all
 *   (there is nothing semantic to resolve against) and a miss on the
 *   original selector reports as unhealed.
 * @param {"android"|"ios"} [params.platform] - defaults to "android",
 *   same as the rest of this layer; only affects how a healed
 *   resolution's selector is rendered back for reporting.
 * @param {string} [params.expectedLabel] - when given, an existing
 *   element found by `selector` isn't trusted on existence alone: its
 *   own visible text (`element.getText()`) is compared against this
 *   (case-insensitive, trimmed, substring match either direction) to
 *   catch the case explicitly asked for -- "if the path changes" (an
 *   xpath/structural selector that still matches *something* after the
 *   tree shifted, just not the right node anymore) or "if the element
 *   changes" (a resource-id got reused for a different control). A
 *   mismatch is treated exactly like a missing element: healing is
 *   attempted. Without this, only an outright missing/throwing selector
 *   triggers healing -- a wrong-but-present match is trusted as-is,
 *   same as before this option existed.
 * @returns {Promise<HealResult>}
 */
async function resolveElementWithHealing(driver, { selector, description, platform, expectedLabel } = {}) {
  const resolvedPlatform = platform === "ios" ? "ios" : "android";

  if (!selector) {
    return { element: null, healed: false, reason: "no selector given to resolveElementWithHealing" };
  }

  let originalElement;
  let mismatchReason;
  try {
    originalElement = await driver.$(selector);
    if (await originalElement.isExisting()) {
      const mismatch = expectedLabel ? await elementLabelMismatches(originalElement, expectedLabel) : false;
      if (!mismatch) {
        return { element: originalElement, healed: false };
      }
      mismatchReason = `selector ${JSON.stringify(selector)} resolved to an element whose text ("${mismatch}") doesn't match the expected "${expectedLabel}" -- likely a path/structural change pointing it at the wrong element`;
      console.warn(`[engine/auto-heal] ${mismatchReason}, attempting to heal`);
    }
  } catch (err) {
    // A selector string WebdriverIO can't even evaluate (malformed
    // xpath, etc.) is treated the same as "not found" -- healing still
    // gets a chance, rather than propagating a low-level driver error.
    console.warn(`[engine/auto-heal] original selector threw, attempting to heal: ${err.message}`);
  }

  // Everything below shares one framing whether we got here via a
  // missing/throwing selector or a verified wrong-element match --
  // `problem` is just which of those it was, for the failure messages.
  const problem = mismatchReason || `selector ${JSON.stringify(selector)} did not resolve`;

  if (!description) {
    return { element: null, healed: false, reason: `${problem}, and no description was given to heal from` };
  }

  let pageSource;
  try {
    pageSource = await driver.getPageSource();
  } catch (err) {
    return { element: null, healed: false, reason: `${problem}, and the screen couldn't be read to attempt healing: ${err.message}` };
  }

  const resolution = await resolveSemanticAction(pageSource, description);
  if (!resolution.resolved) {
    return {
      element: null,
      healed: false,
      reason: `${problem}, and healing against "${description}" also failed: ${resolution.reason}`,
    };
  }

  const healedSelectorString = buildSelector(resolution.selector, resolvedPlatform);
  if (!healedSelectorString) {
    return { element: null, healed: false, reason: `healing resolved a match but couldn't build a selector for ${JSON.stringify(resolution.selector)}` };
  }

  try {
    const healedElement = await driver.$(healedSelectorString);
    if (!(await healedElement.isExisting())) {
      return {
        element: null,
        healed: false,
        reason: `${problem}, and healing's own resolved selector (${healedSelectorString}) also isn't on screen`,
      };
    }
    const result = { element: healedElement, healed: true, healedSelector: resolution.selector };
    if (mismatchReason) result.mismatchReason = mismatchReason;
    return result;
  } catch (err) {
    return { element: null, healed: false, reason: `${problem}, and healing's resolved selector threw: ${err.message}` };
  }
}

/**
 * Compares an already-found element's own visible text against the
 * label it was expected to have, to catch a selector that still
 * resolves to SOMETHING after a structural/path change, just not the
 * right node anymore. Case-insensitive, trimmed, substring match either
 * direction (an element's text is often a superset or subset of the
 * recorded label -- e.g. a row's text including extra state).
 *
 * @returns {Promise<string|false>} the element's actual (mismatched)
 *   text if it doesn't match, or false if it matches (or couldn't be
 *   read at all -- a verification that can't run doesn't block
 *   trusting the element, it just doesn't add any extra confidence).
 */
async function elementLabelMismatches(element, expectedLabel) {
  let actualText;
  try {
    actualText = await element.getText();
  } catch (_err) {
    return false; // can't verify -- don't treat that as a mismatch
  }

  const normalize = (s) => (s || "").trim().toLowerCase();
  const actual = normalize(actualText);
  const expected = normalize(expectedLabel);
  if (!actual || !expected) return false;

  const matches = actual.includes(expected) || expected.includes(actual);
  return matches ? false : actualText;
}

module.exports = { resolveElementWithHealing };
