/**
 * Generation pipeline (docs/PHOENIX_SPEC.md §4.3).
 *
 * Input: a finished CapturedStep[] from capture/recorder.js.
 * Output: a named, commented, parameterized script with inferred
 * assertions, saved as a TestOps test case.
 *
 * Runs once, after "Stop" — not live during recording. The model needs
 * the whole flow in view to write a coherent script and propose
 * meaningful assertions, not just react to isolated taps.
 *
 * v1 (this stage) is entirely deterministic/rule-based: it needs no LLM
 * call to produce a working, readable WebdriverIO script from the
 * resolved locators capture/recorder.js already hands it. generation/llm.js
 * adds an OPTIONAL refinement pass on top (better flow names, filtered
 * assertions) backed by a local Ollama instance — the rule-based logic
 * below remains the guaranteed output on its own, and stays the fallback
 * whenever refinement is unavailable or fails. The pipeline's shape and
 * output contract don't change when refinement is used, only the values
 * of `testName`/`assertions` before synthesizeCode() renders them.
 */

const { DOMParser } = require("@xmldom/xmldom");
const crypto = require("crypto");

// Zero-width space/non-joiner/joiner and the BOM/zero-width-no-break-space
// -- invisible characters JS's String.prototype.trim() does NOT strip
// (it only trims real whitespace). Seen for real in a BrowserStack
// recording (BitBar Sample App): an iOS accessibility container's rolled-up
// label was literally "​", which survived a plain .trim() check as a
// "real" label, non-empty and therefore truthy, but displayed as an empty
// string everywhere it was used -- a generated assertion on `label == ""`
// that looked meaningless in the script and told the tester nothing.
const INVISIBLE_CHARS_RE = /[​‌‍﻿]/g;

/** True for a value that's empty, only whitespace, or only invisible characters. */
function isBlank(value) {
  if (!value) return true;
  return value.replace(INVISIBLE_CHARS_RE, "").trim().length === 0;
}

/** Strips invisible characters and surrounding whitespace, same rule isBlank() checks by. */
function cleanLabel(value) {
  return value ? value.replace(INVISIBLE_CHARS_RE, "").trim() : value;
}

/**
 * @param {import('../capture/recorder').CapturedStep[]} steps
 * @param {object} [options]
 * @param {boolean} [options.useLlm] Refine testName/assertions via the
 *   local Ollama-backed layer in generation/llm.js. Defaults to false —
 *   v1's rule-based output is a complete, working result on its own;
 *   this is an opt-in improvement, not a requirement. When true, any
 *   refinement failure (Ollama not running, timeout, bad response)
 *   silently falls back to the rule-based value it would otherwise have
 *   used — generateScript() itself never throws because of this option.
 * @param {"android"|"ios"} [options.platform] Which platform these steps
 *   were captured against — determines which selector syntax
 *   synthesizeCode() emits for text-based locators/assertions (Android's
 *   UiSelector vs. iOS's predicate strings; resource-id/accessibility-id
 *   selectors are cross-platform in WebdriverIO and don't need this).
 *   Defaults to "android" — Phoenix's only proven platform so far; pass
 *   "ios" explicitly when calling this against a session started via
 *   engine/ios-session.js.
 * @returns {Promise<{ scriptSource: string, testName: string, assertions: string[] }>}
 */
async function generateScript(steps, options = {}) {
  const { useLlm = false, platform = "android" } = options;

  let testName = inferTestName(steps);
  let assertions = inferAssertions(steps);
  const parameters = extractParameters(steps);
  // Computed from the pre-refinement assertions: this flags steps that
  // had NO label-based assertion and NO accessible labels at all after
  // the tap, which is a property of what the accessibility tree could
  // see, not something an LLM refinement pass should be filtering.
  const visualChangeFlags = inferVisualChangeFlags(steps, assertions);

  if (useLlm) {
    // Lazily required so that generation/ has no hard dependency on
    // llm.js (or its fetch/Ollama usage) for callers who never opt in.
    const { refineTestName, filterAssertions } = require("./llm");
    [testName, assertions] = await Promise.all([
      refineTestName(steps, testName),
      filterAssertions(assertions),
    ]);
  }

  const scriptSource = synthesizeCode(steps, { testName, assertions, parameters, platform, visualChangeFlags });

  return { scriptSource, testName, assertions, parameters, visualChangeFlags };
}

/**
 * Collects every text/content-desc value in an accessibility tree, in
 * document order, alongside the element's resource-id (when present).
 *
 * Reads both Android's UiAutomator2 attribute names (text, content-desc,
 * resource-id, a single "bounds" string) and iOS's XCUITest attribute
 * names (label, name, x/y/width/height) — same dual-platform approach
 * as capture/recorder.js's resolveElementAtCoordinate(), so assertion
 * diffing works against a recorded iOS session's tree the same way it
 * already does for Android.
 */
function extractLabels(pageSourceXml) {
  if (!pageSourceXml) return [];
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString(pageSourceXml, "text/xml");

  const labels = [];
  const walk = (node) => {
    if (node.nodeType === 1 && node.getAttribute) {
      const text = node.getAttribute("text") || node.getAttribute("label") || node.getAttribute("value");
      const contentDesc = node.getAttribute("content-desc") || node.getAttribute("name");
      const resourceId = node.getAttribute("resource-id"); // Android only, absent on iOS
      const androidBounds = node.getAttribute("bounds");
      const x = node.getAttribute("x");
      const y = node.getAttribute("y");
      const width = node.getAttribute("width");
      const height = node.getAttribute("height");
      const bounds = androidBounds || (x && y && width && height ? `${x},${y},${width},${height}` : undefined);
      const label = (!isBlank(text) && cleanLabel(text)) || (!isBlank(contentDesc) && cleanLabel(contentDesc));
      if (label) labels.push({ label, resourceId: resourceId || undefined, bounds: bounds || undefined });
    }
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) walk(children[i]);
  };
  walk(doc.documentElement);
  return labels;
}

/**
 * Composite key identifying a specific labeled element, not just its
 * text. Text alone collides whenever two different screens happen to
 * use the same word for different things — e.g. ApiDemos' home screen
 * has an "Animation" category, and its Views submenu separately has an
 * "Animation" row; diffing by text alone would see "Animation" in both
 * before and after and wrongly conclude nothing new appeared. Position
 * (bounds) is what actually distinguishes them, since it's a different
 * element occupying a different part of the screen.
 */
function labelKey({ label, resourceId, bounds }) {
  return `${resourceId || ""}|${label}|${bounds || ""}`;
}

/**
 * Names the flow from the first screen title seen (the label of the
 * element resolved by the first step's before-state, or the first
 * distinct label in the whole session) — e.g. "API Demos" -> "api_demos".
 *
 * TODO(stage 2 follow-up): once generation/ has an LLM call available,
 * replace this with a summary of the whole flow ("login_then_view_profile")
 * rather than just the starting screen's title.
 */
function inferTestName(steps) {
  if (steps.length === 0) return "untitled_recorded_flow";

  const firstLabels = extractLabels(steps[0].pageSourceBefore);
  const candidate = firstLabels[0] && firstLabels[0].label;
  if (!candidate) return "untitled_recorded_flow";

  return (
    candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "untitled_recorded_flow"
  );
}

/**
 * Diffs each step's pageSourceAfter against everything the session has
 * shown so far and proposes one assertion per label that is genuinely
 * new to the whole session — the flow's own evidence that the tap did
 * something, without guessing at intent.
 *
 * Diffs by (resourceId, text, bounds) — see labelKey()'s note — not by
 * text alone, so a label that coincidentally repeats across two
 * different screens (a category name that's also a submenu row) is
 * still correctly recognized as a different, newly-appeared element.
 *
 * Tracks "seen" CUMULATIVELY across the whole session, not just against
 * the immediately preceding step's before-state. This matters for back
 * navigation: without it, tapping "back" to a screen shown earlier in
 * the flow re-floods the result with an assertion for every label on
 * that screen, mislabeled as "newly appeared" when it's really just
 * reappearing — the same bug that would otherwise fire every time a
 * flow revisits any screen it has already shown once. A label only
 * counts as new evidence the first time the session ever displays it;
 * seeing it again later (by going back, or by any other path returning
 * to that screen) is expected, not noteworthy, and no longer asserted
 * on a second time.
 *
 * TODO(stage 2 follow-up): screenshot-diff fallback for steps where the
 * accessibility tree doesn't change but the screen visibly did (custom
 * canvas UI) — see synthesizeCode()'s handling of label-less steps for
 * the current partial mitigation; LLM call to filter noisy/incidental
 * assertions (a clock widget ticking over) out of the meaningful ones.
 */
function inferAssertions(steps) {
  const assertions = [];
  if (steps.length === 0) return assertions;

  // Seeded from the very first screen the session shows, so nothing
  // visible before the flow even starts is later mistaken for "new".
  const seen = new Set(extractLabels(steps[0].pageSourceBefore).map(labelKey));

  steps.forEach((step, index) => {
    const after = extractLabels(step.pageSourceAfter);
    const appeared = after.filter((l) => !seen.has(labelKey(l)));

    // De-duplicate within the step by the same composite key (a label
    // can legitimately appear more than once at the same position, e.g.
    // a list row's text and its content-desc matching).
    //
    // A second, coarser pass then collapses by label text alone within
    // this one step. Nested accessibility nodes commonly expose the
    // same text at multiple bounds — e.g. a button and its inner
    // StaticText child both carry "Screen Time" — which the composite
    // key above correctly treats as distinct *elements* (needed for the
    // cross-screen "seen" logic below), but which reads as pure
    // repetition in a single step's assertions: three near-identical
    // `toBeDisplayed()` checks for the same visible words. Only the
    // first element carrying a given label is asserted per step; every
    // element's key still gets added to `seen` afterward, so this is
    // purely about not re-stating the same on-screen text three times,
    // not about which elements are tracked.
    const dedup = new Set();
    const labelsAssertedThisStep = new Set();
    for (const item of appeared) {
      const key = labelKey(item);
      if (dedup.has(key)) continue;
      dedup.add(key);

      if (labelsAssertedThisStep.has(item.label)) continue;
      labelsAssertedThisStep.add(item.label);

      assertions.push({ stepIndex: index, label: item.label, resourceId: item.resourceId });
    }

    // Everything visible after this step — not just what was flagged as
    // newly appeared — is now "seen", so a later step returning to this
    // same screen (via back navigation or any other path) won't re-flag
    // any of it either.
    for (const item of after) seen.add(labelKey(item));
  });

  return assertions;
}

/**
 * Cheap fingerprint of a screenshot, used only to answer "did the screen
 * visibly change at all" — not for any pixel-level comparison. Good
 * enough to tell two different base64 screenshots apart without pulling
 * in an image-diffing dependency.
 */
function screenshotHash(base64) {
  if (!base64) return null;
  return crypto.createHash("sha1").update(base64).digest("hex");
}

/**
 * Screens with no usable accessibility attributes at all — raw-drawn
 * Canvas/OpenGL content, some games, custom chart widgets — produce an
 * empty extractLabels() result, so inferAssertions() has nothing to diff
 * and silently proposes zero assertions for that step. That's easy to
 * mistake for "nothing happened", when really the step just wasn't
 * observable through the accessibility tree.
 *
 * This is the partial mitigation referenced by inferAssertions()'s TODO:
 * a full screenshot-diff (perceptual hashing, region comparison) is out
 * of scope for now, but a step whose screenshot changed while producing
 * zero label-based assertions and zero accessible labels afterward is
 * exactly the case worth flagging so it isn't mistaken for "no assertion
 * needed" — synthesizeCode() turns each flag into a visible TODO comment
 * (and a screenshot save) in the generated script rather than staying
 * silent about a screen Phoenix genuinely couldn't inspect.
 */
function inferVisualChangeFlags(steps, assertions) {
  const assertedSteps = new Set(assertions.map((a) => a.stepIndex));
  const flags = [];

  steps.forEach((step, index) => {
    if (assertedSteps.has(index)) return; // already has a real, locator-based assertion

    const afterLabels = extractLabels(step.pageSourceAfter);
    if (afterLabels.length > 0) return; // has labels, just none of them were "new" -- not this case

    const before = screenshotHash(step.screenshotBeforeBase64);
    const after = screenshotHash(step.screenshotAfterBase64);
    if (before && after && before !== after) {
      flags.push({ stepIndex: index });
    }
  });

  return flags;
}

/**
 * Flags typed values as candidate parameters so they can be pulled into
 * test data instead of hardcoded — named from the field's resolved
 * locator when available ("email_input" -> "email"), falling back to a
 * positional name.
 *
 * TODO(stage 2 follow-up): LLM call to pick better semantic names and to
 * detect values that are parameters even when not literally typed (e.g.
 * a value selected from a picker).
 */
function extractParameters(steps) {
  const parameters = [];

  steps.forEach((step, index) => {
    if (step.typedValue === undefined || step.typedValue === null) return;

    const el = step.resolvedElement || {};
    const rawName = el.resourceId || el.accessibilityId || el.text || `field_${index}`;
    const name = String(rawName)
      .split("/")
      .pop()
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/_?input$|_?field$|_?edit(text)?$/i, "")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || `field_${index}`;

    parameters.push({ stepIndex: index, name, value: step.typedValue });
  });

  return parameters;
}

/**
 * Escapes a value for embedding inside a double-quoted string in a
 * generated UiSelector/predicate expression (both use JS-style escaping
 * for embedded quotes/backslashes).
 */
function escapeForSelector(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Builds a platform-specific text/resource-id selector.
 *
 * Android: a UiSelector combining resource-id and text — list adapters
 * commonly reuse one resource-id across every row (e.g. Android's
 * "android:id/text1"), so resource-id alone is often *not* unique on
 * screen; combining it with the row's own text (when known) is what
 * actually pins one specific element.
 *
 * iOS has no resource-id equivalent — XCUITest identifies elements by
 * name (accessibility id, handled separately via `~value` — see
 * buildSelector) or by label/value, matched here with an
 * `-ios predicate string:` expression instead of a UiSelector.
 *
 * Falls back to whichever identifying piece is available.
 */
function buildResourceIdSelector(resourceId, label, platform = "android") {
  if (platform === "ios") {
    if (!label) return null;
    return `-ios predicate string:label == "${escapeForSelector(label)}" OR value == "${escapeForSelector(label)}"`;
  }

  const clauses = [];
  if (resourceId) clauses.push(`.resourceId("${escapeForSelector(resourceId)}")`);
  if (label) clauses.push(`.text("${escapeForSelector(label)}")`);
  if (clauses.length === 0) return null;
  return `android=new UiSelector()${clauses.join("")}`;
}

/**
 * Maps a resolved element to a WebdriverIO selector string, per the
 * same locator priority used to resolve it in the first place.
 * `~value` (WebdriverIO's "accessibility id" strategy) works identically
 * on both platforms, so only the "resource-id" (Android-only, always
 * false on iOS since recorder.js never sets it there) and "text" cases
 * need a platform branch.
 */
function buildSelector(resolvedElement, platform = "android") {
  if (!resolvedElement) return null;
  switch (resolvedElement.strategy) {
    case "resource-id":
      // Combine with text/content-desc when available — see
      // buildResourceIdSelector's note on why resource-id alone can be
      // ambiguous inside a list.
      return buildResourceIdSelector(resolvedElement.value, resolvedElement.text || resolvedElement.contentDesc, platform);
    case "accessibility-id":
      return `~${resolvedElement.value}`;
    case "text":
      return platform === "ios"
        ? `-ios predicate string:label == "${escapeForSelector(resolvedElement.value)}" OR value == "${escapeForSelector(resolvedElement.value)}"`
        : `android=new UiSelector().text("${escapeForSelector(resolvedElement.value)}")`;
    case "xpath":
      return resolvedElement.value;
    case "class-chain":
      // WebDriverAgent/XCUITestDriver's natively-supported locator for
      // an iOS element with no resource-id/accessibility-id/label of
      // its own -- see semantic-snapshot.js's buildIosClassChain() and
      // semantic-act.js's toSelector() for why this replaces a plain
      // structural xpath on iOS (a real BrowserStack run found the
      // native xpath finder unreliable for that shape of path, even
      // against an unchanged screen).
      return `-ios class chain:${resolvedElement.value}`;
    default:
      return null; // coordinate — handled separately, see synthesizeCode
  }
}

function toIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Turns the resolved step sequence into a runnable WebdriverIO script:
 * a selector-based tap/setValue per step (falling back to a flagged
 * coordinate tap only when no stable locator was resolved), inferred
 * assertions as `expect(...).toBeDisplayed()` calls, and typed values
 * lifted into named parameters at the top of the file.
 *
 * TODO(stage 2 follow-up): LLM call to turn this into more idiomatic,
 * commented code once names/assertions above are LLM-refined — the
 * synthesis logic itself (selectors, structure) doesn't need to change.
 */
function synthesizeCode(steps, meta) {
  const { testName, assertions, parameters, platform = "android", visualChangeFlags = [] } = meta;
  const fnName = toIdentifier(testName);
  // XCUITest's tap extension is `mobile: tap`, not UiAutomator2's
  // `mobile: clickGesture` — see engine/ios-stage0-session.js.
  const tapExtension = platform === "ios" ? "mobile: tap" : "mobile: clickGesture";

  const paramsByStep = new Map(parameters.map((p) => [p.stepIndex, p]));
  const assertionsByStep = new Map();
  for (const a of assertions) {
    if (!assertionsByStep.has(a.stepIndex)) assertionsByStep.set(a.stepIndex, []);
    assertionsByStep.get(a.stepIndex).push(a);
  }
  const visualChangeStepIndexes = new Set(visualChangeFlags.map((f) => f.stepIndex));

  const lines = [];
  lines.push(`// Generated by Phoenix from a recorded session — ${steps.length} step(s).`);
  lines.push(`// Locators use the priority resolved during capture: resource-id > accessibility-id > text > xpath > coordinate.`);
  lines.push("");

  if (parameters.length > 0) {
    lines.push("// Test data — lifted from values typed during recording.");
    for (const p of parameters) {
      lines.push(`const ${toIdentifier(p.name)} = ${JSON.stringify(p.value)};`);
    }
    lines.push("");
  }

  lines.push(`describe("${testName}", () => {`);
  lines.push(`  it("${fnName}", async () => {`);

  steps.forEach((step, index) => {
    lines.push(`    // Step ${index + 1}`);
    const selector = buildSelector(step.resolvedElement, platform);
    const param = paramsByStep.get(index);

    if (selector) {
      lines.push(`    const step${index}El = await $(${JSON.stringify(selector)});`);
      lines.push(`    await step${index}El.waitForDisplayed();`);
      lines.push(`    await step${index}El.click();`);
      if (param) {
        lines.push(`    await step${index}El.setValue(${toIdentifier(param.name)});`);
      }
    } else {
      const { x, y } = step.tapCoordinate || {};
      lines.push(`    // No stable locator resolved for this tap — falling back to a raw`);
      lines.push(`    // coordinate. Fragile: will break if this screen's layout changes.`);
      lines.push(`    await driver.execute(${JSON.stringify(tapExtension)}, { x: ${x}, y: ${y} });`);
    }

    const stepAssertions = assertionsByStep.get(index) || [];
    for (const assertion of stepAssertions) {
      // Combine resource-id with the label itself — see
      // buildResourceIdSelector's note: a shared list-row resource-id
      // (e.g. "android:id/text1") isn't unique on its own, so asserting
      // by resource-id alone can't tell "Custom View" from any other row.
      const assertSelector = buildResourceIdSelector(assertion.resourceId, assertion.label, platform);
      lines.push(`    await expect($(${JSON.stringify(assertSelector)})).toBeDisplayed(); // "${assertion.label}" appeared`);
    }

    if (visualChangeStepIndexes.has(index)) {
      // The screen changed after this tap but had no accessible labels
      // for Phoenix to assert on (likely a custom-drawn Canvas/OpenGL
      // view — see inferVisualChangeFlags()'s note). Left as a visible
      // TODO plus a saved screenshot rather than silently proposing zero
      // assertions, so this doesn't read as "nothing happened here".
      lines.push(`    // TODO(no accessible labels on this screen): the screen visibly changed after`);
      lines.push(`    // this step, but nothing here exposed a resource-id/label Phoenix could assert`);
      lines.push(`    // on automatically (custom-drawn UI?). Verify manually, or replace this with an`);
      lines.push(`    // image-based assertion once one is available.`);
      lines.push(`    await driver.saveScreenshot("${fnName}_step${index + 1}.png");`);
    }

    lines.push("");
  });

  lines.push("  });");
  lines.push("});");
  lines.push("");

  return lines.join("\n");
}

module.exports = {
  generateScript,
  inferTestName,
  inferAssertions,
  inferVisualChangeFlags,
  extractParameters,
  synthesizeCode,
  buildSelector,
  buildResourceIdSelector,
  extractLabels,
  labelKey,
  isBlank,
  cleanLabel,
};
