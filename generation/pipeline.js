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
 * @returns {Promise<{ scriptSource: string, testName: string, assertions: string[] }>}
 */
async function generateScript(steps, options = {}) {
  const { useLlm = false } = options;

  let testName = inferTestName(steps);
  let assertions = inferAssertions(steps);
  const parameters = extractParameters(steps);

  if (useLlm) {
    // Lazily required so that generation/ has no hard dependency on
    // llm.js (or its fetch/Ollama usage) for callers who never opt in.
    const { refineTestName, filterAssertions } = require("./llm");
    [testName, assertions] = await Promise.all([
      refineTestName(steps, testName),
      filterAssertions(assertions),
    ]);
  }

  const scriptSource = synthesizeCode(steps, { testName, assertions, parameters });

  return { scriptSource, testName, assertions, parameters };
}

/**
 * Collects every text/content-desc value in an accessibility tree, in
 * document order, alongside the element's resource-id (when present).
 */
function extractLabels(pageSourceXml) {
  if (!pageSourceXml) return [];
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString(pageSourceXml, "text/xml");

  const labels = [];
  const walk = (node) => {
    if (node.nodeType === 1 && node.getAttribute) {
      const text = node.getAttribute("text");
      const contentDesc = node.getAttribute("content-desc");
      const resourceId = node.getAttribute("resource-id");
      const bounds = node.getAttribute("bounds");
      const label = (text && text.trim()) || (contentDesc && contentDesc.trim());
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
 * Diffs each step's pageSourceBefore against its pageSourceAfter and
 * proposes one assertion per newly-appeared label — the flow's own
 * evidence that the tap did something, without guessing at intent.
 *
 * Diffs by (resourceId, text, bounds) — see labelKey()'s note — not by
 * text alone, so a label that coincidentally repeats across two
 * different screens (a category name that's also a submenu row) is
 * still correctly recognized as a different, newly-appeared element.
 *
 * TODO(stage 2 follow-up): screenshot-diff fallback for steps where the
 * accessibility tree doesn't change but the screen visibly did (custom
 * canvas UI); LLM call to filter noisy/incidental assertions (a clock
 * widget ticking over) out of the meaningful ones.
 */
function inferAssertions(steps) {
  const assertions = [];

  steps.forEach((step, index) => {
    const before = new Set(extractLabels(step.pageSourceBefore).map(labelKey));
    const after = extractLabels(step.pageSourceAfter);
    const appeared = after.filter((l) => !before.has(labelKey(l)));

    // De-duplicate within the step by the same composite key (a label
    // can legitimately appear more than once at the same position, e.g.
    // a list row's text and its content-desc matching).
    const seen = new Set();
    for (const item of appeared) {
      const key = labelKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      assertions.push({ stepIndex: index, label: item.label, resourceId: item.resourceId });
    }
  });

  return assertions;
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
 * Builds a UiSelector string from a resource-id and/or text/content-desc.
 * List adapters commonly reuse one resource-id across every row (e.g.
 * Android's "android:id/text1"), so resource-id alone is often *not*
 * unique on screen — combining it with the row's own text/content-desc
 * (when known) is what actually pins one specific element. Falls back
 * to whichever of the two is available on its own.
 */
function buildResourceIdSelector(resourceId, label) {
  const clauses = [];
  if (resourceId) clauses.push(`.resourceId("${resourceId}")`);
  if (label) clauses.push(`.text("${label}")`);
  if (clauses.length === 0) return null;
  return `android=new UiSelector()${clauses.join("")}`;
}

/**
 * Maps a resolved element to a WebdriverIO selector string, per the
 * same locator priority used to resolve it in the first place.
 */
function buildSelector(resolvedElement) {
  if (!resolvedElement) return null;
  switch (resolvedElement.strategy) {
    case "resource-id":
      // Combine with text/content-desc when available — see
      // buildResourceIdSelector's note on why resource-id alone can be
      // ambiguous inside a list.
      return buildResourceIdSelector(resolvedElement.value, resolvedElement.text || resolvedElement.contentDesc);
    case "accessibility-id":
      return `~${resolvedElement.value}`;
    case "text":
      return `android=new UiSelector().text("${resolvedElement.value}")`;
    case "xpath":
      return resolvedElement.value;
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
  const { testName, assertions, parameters } = meta;
  const fnName = toIdentifier(testName);

  const paramsByStep = new Map(parameters.map((p) => [p.stepIndex, p]));
  const assertionsByStep = new Map();
  for (const a of assertions) {
    if (!assertionsByStep.has(a.stepIndex)) assertionsByStep.set(a.stepIndex, []);
    assertionsByStep.get(a.stepIndex).push(a);
  }

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
    const selector = buildSelector(step.resolvedElement);
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
      lines.push(`    await driver.execute("mobile: clickGesture", { x: ${x}, y: ${y} });`);
    }

    const stepAssertions = assertionsByStep.get(index) || [];
    for (const assertion of stepAssertions) {
      // Combine resource-id with the label itself — see
      // buildResourceIdSelector's note: a shared list-row resource-id
      // (e.g. "android:id/text1") isn't unique on its own, so asserting
      // by resource-id alone can't tell "Custom View" from any other row.
      const assertSelector = buildResourceIdSelector(assertion.resourceId, assertion.label);
      lines.push(`    await expect($(${JSON.stringify(assertSelector)})).toBeDisplayed(); // "${assertion.label}" appeared`);
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
  extractParameters,
  synthesizeCode,
  buildSelector,
  buildResourceIdSelector,
  extractLabels,
  labelKey,
};
