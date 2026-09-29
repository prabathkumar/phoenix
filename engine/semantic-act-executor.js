/**
 * Wires generation/semantic-act.js's resolution up to a live Appium
 * session — the piece explicitly called out as not-yet-built in
 * docs/PHOENIX_SPEC.md §6/README's Act 2 section: "actually issuing the
 * resulting tap/setValue against a live Appium session." Everything
 * upstream of this file (buildGroundedSnapshot, resolveSemanticAction,
 * diffSnapshots) only reads an already-captured pageSourceXml string;
 * this is the first module that takes a live `driver` and does
 * something to the device.
 *
 * Scope, deliberately narrow: `executeSemanticAction()` captures the
 * current screen, resolves the instruction against it, performs
 * exactly one WebDriver action (tap or type) via the SAME selector
 * strings pipeline.js's buildSelector() already produces for the guided
 * path (resource-id / accessibility-id / text), and reports what
 * changed. It does not decide *what* to do next, retry, or loop — that
 * decision logic is Phase 3's autonomous loop (spec §6), still
 * unbuilt. This module only answers "given one instruction, can I
 * carry it out on the real device, and what happened."
 *
 * Fail-safe by the same contract as the rest of this layer
 * (generation/llm.js, generation/semantic-act.js): every failure mode
 * — no confident match, element vanished before the action could run,
 * an unsupported action kind, any WebDriver error — is reported as
 * `{success: false, reason}` rather than thrown. A caller (eventually,
 * a Phase 3 loop) can treat "unsuccessful" uniformly as "stop and hand
 * back to a human," without a try/catch of its own.
 */

const { resolveSemanticAction } = require("../generation/semantic-act");
const { diffSnapshots, diffToText } = require("../generation/semantic-diff");
const { inferSemanticAssertions } = require("../generation/semantic-assertions");
const { buildSelector } = require("../generation/pipeline");

const SUPPORTED_KINDS = new Set(["tap", "type"]);

/**
 * @typedef {Object} SemanticActionExecutionResult
 * @property {boolean} success
 * @property {string} [reason] - present when !success.
 * @property {{strategy: string, value: string}} [selector] - present on success.
 * @property {import('../generation/semantic-diff').SemanticDiff} [diff] - present on success.
 * @property {string} [diffSummary] - present on success; diffToText(diff).
 * @property {import('../generation/semantic-assertions').SemanticAssertion[]} [assertions] -
 *   present when `diff` is (i.e. success and the post-action screen
 *   read worked); inferSemanticAssertions(diff) -- see that module.
 */

/**
 * @param {import('webdriverio').Browser} driver - an already-started
 *   session, e.g. from engine/session-manager.js's `active.driver`.
 * @param {string} instruction - e.g. "tap the Login button".
 * @param {Object} [options]
 * @param {"tap"|"type"} [options.kind] - defaults to "tap". "type"
 *   requires options.text.
 * @param {string} [options.text] - text to send when kind is "type".
 * @param {"android"|"ios"} [options.platform] - defaults to "android",
 *   same default chain session-manager.js uses -- selects selector
 *   syntax via pipeline.js's buildSelector().
 * @param {boolean} [options.useVisualGrounding] - when true, also
 *   captures a screenshot (`driver.takeScreenshot()`) and passes it to
 *   `resolveSemanticAction()` for fused (text + image) resolution --
 *   docs/PHOENIX_SPEC.md §6's "merge accessibility tree + screenshot"
 *   bullet. Off by default: text-only resolution is cheaper, faster,
 *   and is what's been exercised so far; this is opt-in for whenever
 *   text alone proves ambiguous enough to be worth the extra cost. A
 *   screenshot failure here falls back to text-only rather than
 *   failing the whole action -- the point of the screenshot is to help
 *   resolution, not to be a new way for it to fail.
 * @returns {Promise<SemanticActionExecutionResult>}
 */
async function executeSemanticAction(driver, instruction, options = {}) {
  const kind = options.kind || "tap";
  const platform = options.platform === "ios" ? "ios" : "android";

  if (!SUPPORTED_KINDS.has(kind)) {
    return { success: false, reason: `unsupported action kind "${kind}" (expected "tap" or "type")` };
  }
  if (kind === "type" && typeof options.text !== "string") {
    return { success: false, reason: 'kind "type" requires options.text' };
  }

  let pageSourceBefore;
  try {
    pageSourceBefore = await driver.getPageSource();
  } catch (err) {
    return { success: false, reason: `couldn't read the current screen: ${err.message}` };
  }

  let screenshotBase64;
  if (options.useVisualGrounding) {
    try {
      screenshotBase64 = await driver.takeScreenshot();
    } catch (err) {
      // Fall back to text-only resolution -- see the option's doc
      // comment above for why this doesn't fail the action outright.
      console.warn("[engine/semantic-act-executor] couldn't capture a screenshot for fused resolution, falling back to text-only:", err.message);
    }
  }

  const resolution = await resolveSemanticAction(pageSourceBefore, instruction, { screenshotBase64 });
  if (!resolution.resolved) {
    return { success: false, reason: resolution.reason };
  }

  const selectorString = buildSelector(resolution.selector, platform);
  if (!selectorString) {
    // Shouldn't happen -- resolveSemanticAction only ever returns
    // resource-id/accessibility-id/text strategies, all of which
    // buildSelector() handles -- but stay unresolved rather than
    // silently doing nothing.
    return { success: false, reason: `couldn't build a selector for ${JSON.stringify(resolution.selector)}` };
  }

  try {
    const element = await driver.$(selectorString);
    // Confirm the element is actually there before acting on it -- the
    // screen may have moved on between the snapshot and now (an
    // animation finishing, a toast dismissing itself), and a stale
    // resolution acting blind is exactly the kind of wrong guess spec
    // §2 argues an unattended agent must not make.
    const exists = await element.isExisting();
    if (!exists) {
      return { success: false, reason: `resolved element (${selectorString}) is no longer on screen` };
    }

    if (kind === "tap") {
      await element.click();
    } else {
      await element.setValue(options.text);
    }
  } catch (err) {
    return { success: false, reason: `action failed: ${err.message}` };
  }

  let pageSourceAfter;
  try {
    pageSourceAfter = await driver.getPageSource();
  } catch (err) {
    // The action itself succeeded; only the post-action read failed
    // (e.g. the app crashed, or a transition is mid-flight). Report
    // success with what we know rather than failing an action that did
    // work -- but without a diff, since there's nothing to diff against.
    return { success: true, selector: resolution.selector };
  }

  const diff = diffSnapshots(pageSourceBefore, pageSourceAfter);
  return {
    success: true,
    selector: resolution.selector,
    diff,
    diffSummary: diffToText(diff),
    // Closes spec §6's "state-diff reporting... feeds the assertion-
    // inference step directly" -- see generation/semantic-assertions.js.
    // Always computed (cheap, pure) so a caller building up a test case
    // or a report doesn't need its own separate call for it.
    assertions: inferSemanticAssertions(diff),
  };
}

module.exports = { executeSemanticAction };
