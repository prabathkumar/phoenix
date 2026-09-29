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
 *   resolve and a semantic fallback found the element instead.
 * @property {{strategy: string, value: string}} [healedSelector] -
 *   present when healed is true: what actually worked, so a caller can
 *   log/report "the recorded selector broke, this is what replaced it"
 *   rather than silently moving on.
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
 * @returns {Promise<HealResult>}
 */
async function resolveElementWithHealing(driver, { selector, description, platform } = {}) {
  const resolvedPlatform = platform === "ios" ? "ios" : "android";

  if (!selector) {
    return { element: null, healed: false, reason: "no selector given to resolveElementWithHealing" };
  }

  let originalElement;
  try {
    originalElement = await driver.$(selector);
    if (await originalElement.isExisting()) {
      return { element: originalElement, healed: false };
    }
  } catch (err) {
    // A selector string WebdriverIO can't even evaluate (malformed
    // xpath, etc.) is treated the same as "not found" -- healing still
    // gets a chance, rather than propagating a low-level driver error.
    console.warn(`[engine/auto-heal] original selector threw, attempting to heal: ${err.message}`);
  }

  if (!description) {
    return { element: null, healed: false, reason: `selector ${JSON.stringify(selector)} did not resolve, and no description was given to heal from` };
  }

  let pageSource;
  try {
    pageSource = await driver.getPageSource();
  } catch (err) {
    return { element: null, healed: false, reason: `selector ${JSON.stringify(selector)} did not resolve, and the screen couldn't be read to attempt healing: ${err.message}` };
  }

  const resolution = await resolveSemanticAction(pageSource, description);
  if (!resolution.resolved) {
    return {
      element: null,
      healed: false,
      reason: `selector ${JSON.stringify(selector)} did not resolve, and healing against "${description}" also failed: ${resolution.reason}`,
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
        reason: `selector ${JSON.stringify(selector)} did not resolve, and healing's own resolved selector (${healedSelectorString}) also isn't on screen`,
      };
    }
    return { element: healedElement, healed: true, healedSelector: resolution.selector };
  } catch (err) {
    return { element: null, healed: false, reason: `selector ${JSON.stringify(selector)} did not resolve, and healing's resolved selector threw: ${err.message}` };
  }
}

module.exports = { resolveElementWithHealing };
