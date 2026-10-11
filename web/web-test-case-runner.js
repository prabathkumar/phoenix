/**
 * Web adapter: runs the SAME test-case JSON format the mobile runner
 * uses (engine/test-case-runner.js) in a Playwright page, and reports
 * through the SAME pass/fail contract (engine/test-result.js). One
 * framework, one result shape, three platforms (android | ios | web).
 *
 * Step kinds (superset of mobile; mobile kinds behave the same way):
 *   navigate     {url}                     -- web only; relative URLs join baseUrl
 *   tap          {instruction | selector}  -- click
 *   type         {instruction | selector, text}  -- fill ("${ENV}" placeholders supported)
 *   press        {key, selector?}          -- keyboard key (e.g. Enter) on the focused field / selector
 *   scroll       {direction?}              -- up|down, default down
 *   wait         {durationMs?}
 *   tapIfExists  {selector}                -- hand-authored locator, never guessed; skipped if absent
 *   assert       {assert: {urlContains?, titleContains?, textVisible?[], textHidden?[]}}
 *                                           -- absolute checks on the page; the web "expected result"
 *
 * Any tap/type step may also carry `expect: {appeared?, disappeared?}`
 * (same field the mobile runner uses): compared against the visible
 * text lines that actually appeared/disappeared as a result of the step.
 *
 * Locator resolution order for tap/type: step.selector (explicit) ->
 * step.resolvedSelector (pinned from an earlier proven run) -> semantic
 * resolution of `instruction` against the page's interactive elements
 * (generation/webview-act.js, same resolver the mobile WebView path
 * uses). A fresh semantic resolution that acted successfully and had
 * evidence (an `expect` that passed, or a visible page change) is
 * returned in `updatedSteps` as the new resolvedSelector, exactly like
 * mobile -- the caller decides whether to persist it.
 *
 * Selector strategies: css | xpath | text | label | testid.
 */

const path = require("path");
const { buildTestResult } = require("../engine/test-result");
const { resolveStepText } = require("../engine/test-case-runner");
const { verifyExpectedOutcome, validateExpectShape } = require("../generation/outcome-verification");
const { SERIALIZE_DOM_SCRIPT } = require("../generation/webview-snapshot");
const { resolveWebviewAction: defaultResolveAction } = require("../generation/webview-act");

const WEB_KINDS = new Set(["navigate", "tap", "type", "press", "scroll", "wait", "tapIfExists", "assert"]);
const DEFAULT_WAIT_MS = 1000;
const ACTION_TIMEOUT_MS = 10000;

const VISIBLE_LINES_SCRIPT = function () {
  var text = (document.body && document.body.innerText) || "";
  var seen = {};
  var out = [];
  text.split("\n").forEach(function (l) {
    l = l.trim();
    if (l && !seen[l]) { seen[l] = true; out.push(l.slice(0, 200)); }
  });
  return out.slice(0, 500);
};

/** Validates web steps. Throws on a malformed step (same style as mobile loader). */
function validateWebSteps(steps, label = "test case") {
  if (!Array.isArray(steps)) throw new Error(`${label}: steps must be an array`);
  steps.forEach((step, i) => {
    const where = `${label}: step ${i}`;
    if (!step || typeof step !== "object") throw new Error(`${where} is not an object`);
    if (!WEB_KINDS.has(step.kind)) throw new Error(`${where} has invalid "kind": ${step.kind}`);
    if (step.kind === "navigate" && typeof step.url !== "string") throw new Error(`${where} is a "navigate" step with no "url"`);
    if (step.kind === "assert") {
      const a = step.assert;
      if (!a || typeof a !== "object" || !(a.urlContains || a.titleContains || (a.textVisible && a.textVisible.length) || (a.textHidden && a.textHidden.length))) {
        throw new Error(`${where} is an "assert" step with no checks (urlContains/titleContains/textVisible/textHidden)`);
      }
    }
    if (["tap", "type"].includes(step.kind) && !step.instruction && !step.selector && !step.resolvedSelector) {
      throw new Error(`${where} needs an "instruction" or a "selector"`);
    }
    if (step.kind === "press" && typeof step.key !== "string") throw new Error(`${where} is a "press" step with no "key"`);
    if (step.kind === "type" && typeof step.text !== "string") throw new Error(`${where} is a "type" step with no "text"`);
    if (step.kind === "tapIfExists" && !(step.selector && step.selector.strategy && step.selector.value)) {
      throw new Error(`${where} is a "tapIfExists" step with no valid "selector"`);
    }
    const expectError = validateExpectShape(step.expect);
    if (expectError) throw new Error(`${where} has an invalid "expect": ${expectError}`);
  });
  return steps;
}

function locatorFor(page, sel) {
  switch (sel.strategy) {
    case "css": return page.locator(sel.value);
    case "xpath": return page.locator(`xpath=${sel.value}`);
    case "text": return page.getByText(sel.value, { exact: false }).first();
    case "label": return page.getByLabel(sel.value).first();
    case "testid": return page.getByTestId(sel.value);
    default: throw new Error(`unsupported web selector strategy "${sel.strategy}"`);
  }
}

async function visibleLines(page) {
  try { return await page.evaluate(VISIBLE_LINES_SCRIPT); } catch { return []; }
}

function diffLines(before, after) {
  const b = new Set(before); const a = new Set(after);
  return {
    appeared: after.filter((l) => !b.has(l)).map((label) => ({ label })),
    disappeared: before.filter((l) => !a.has(l)).map((label) => ({ label })),
  };
}

async function runAssert(page, a) {
  if (a.urlContains && !page.url().includes(a.urlContains)) {
    return `url "${page.url()}" does not contain "${a.urlContains}"`;
  }
  if (a.titleContains && !(await page.title()).includes(a.titleContains)) {
    return `title "${await page.title()}" does not contain "${a.titleContains}"`;
  }
  const lines = (await visibleLines(page)).join("\n").toLowerCase();
  for (const t of a.textVisible || []) {
    if (!lines.includes(t.toLowerCase())) return `expected text not visible: "${t}"`;
  }
  for (const t of a.textHidden || []) {
    if (lines.includes(t.toLowerCase())) return `text expected to be hidden is visible: "${t}"`;
  }
  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {Array<Object>} steps
 * @param {{baseUrl?: string, testCase?: string, resolveAction?: Function, sleepFn?: Function}} [options]
 * @returns {Promise<Object>} engine/test-result.js shape, plus `updatedSteps`
 */
async function runWebSteps(page, steps, options = {}) {
  const { baseUrl, testCase, resolveAction = defaultResolveAction, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const startedAt = Date.now();
  const results = [];
  const updatedSteps = steps.map((s) => ({ ...s }));
  let runError;

  try {
    validateWebSteps(steps, testCase || "web test case");
    // Resolve all ${ENV} text up front (same reason as the mobile runner).
    const resolved = steps.map((s) => ({ ...s, text: resolveStepText(s) }));

    for (let i = 0; i < resolved.length; i += 1) {
      const step = resolved[i];
      const t0 = Date.now();
      const record = (status, extra = {}) =>
        results.push({ index: i, kind: step.kind, instruction: step.instruction || step.url || step.kind, status, durationMs: Date.now() - t0, ...extra });

      try {
        if (step.kind === "wait") { await sleepFn(typeof step.durationMs === "number" ? step.durationMs : DEFAULT_WAIT_MS); record("pass"); continue; }

        if (step.kind === "navigate") {
          const url = baseUrl && !/^[a-z]+:/i.test(step.url) ? new URL(step.url, baseUrl).toString() : step.url;
          await page.goto(url, { waitUntil: "load", timeout: 30000 });
          record("pass");
          continue;
        }

        if (step.kind === "assert") {
          const problem = await runAssert(page, step.assert);
          if (problem) { if (step.optional) { record("skipped", { reason: problem }); continue; } record("fail", { reason: problem }); break; }
          record("pass");
          continue;
        }

        if (step.kind === "press") {
          const beforeLines = step.expect ? await visibleLines(page) : null;
          if (step.selector) await locatorFor(page, step.selector).first().press(step.key, { timeout: ACTION_TIMEOUT_MS });
          else await page.keyboard.press(step.key);
          try { await page.waitForLoadState("load", { timeout: 3000 }); } catch { /* no navigation */ }
          if (step.expect) {
            const v = verifyExpectedOutcome(diffLines(beforeLines, await visibleLines(page)), step.expect);
            if (!v.ok) { record("fail", { reason: v.reason }); break; }
          }
          record("pass");
          continue;
        }

        if (step.kind === "scroll") {
          await page.mouse.wheel(0, step.direction === "up" ? -600 : 600);
          record("pass");
          continue;
        }

        // tap | type | tapIfExists
        let selector = step.kind === "tapIfExists" ? step.selector : step.selector || step.resolvedSelector;
        let usedCache = Boolean(selector) && selector === step.resolvedSelector;
        if (!selector) {
          const dom = await page.evaluate(SERIALIZE_DOM_SCRIPT);
          const res = await resolveAction(dom, step.instruction, { kind: step.kind === "type" ? "type" : "tap" });
          if (!res.resolved) {
            if (step.optional) { record("skipped", { reason: res.reason }); continue; }
            record("fail", { reason: `could not resolve: ${res.reason}` });
            break;
          }
          selector = res.selector;
        }

        const locator = locatorFor(page, selector);
        if (step.kind === "tapIfExists" && (await locator.count()) === 0) { record("skipped", { reason: "element not present" }); continue; }
        if ((await locator.count()) === 0) {
          if (step.optional) { record("skipped", { reason: "element not present" }); continue; }
          record("fail", { selector, reason: `element not found (${selector.strategy}: ${selector.value})` });
          break;
        }

        const before = step.expect ? await visibleLines(page) : null;
        const beforeAny = await visibleLines(page);
        if (step.kind === "type") await locator.first().fill(step.text, { timeout: ACTION_TIMEOUT_MS });
        else await locator.first().click({ timeout: ACTION_TIMEOUT_MS });
        try { await page.waitForLoadState("load", { timeout: 3000 }); } catch { /* no navigation */ }
        const afterAny = await visibleLines(page);

        if (step.expect) {
          const verification = verifyExpectedOutcome(diffLines(before, afterAny), step.expect);
          if (!verification.ok) {
            if (step.optional) { record("skipped", { selector, reason: verification.reason }); continue; }
            record("fail", { selector, reason: verification.reason });
            break;
          }
        }
        const changed = JSON.stringify(beforeAny) !== JSON.stringify(afterAny);
        if (step.kind !== "tapIfExists" && (usedCache || step.expect || changed || step.kind === "type")) {
          updatedSteps[i] = { ...updatedSteps[i], resolvedSelector: selector };
        }
        record("pass", { selector });
      } catch (err) {
        if (step.optional) { record("skipped", { reason: err.message }); continue; }
        record("fail", { reason: err.message });
        break;
      }
    }
  } catch (err) {
    runError = err.message;
  }

  const result = buildTestResult({ platform: "web", testCase, steps: results, startedAt, finishedAt: Date.now(), error: runError });
  return { ...result, updatedSteps };
}

/**
 * Convenience: launch chromium, run, always close. Used by the CLI.
 */
async function runWebTestCase(steps, options = {}) {
  const { chromium } = require("playwright");
  // executablePath: lets a machine with its own Chromium (or a pinned older build)
  // skip `npx playwright install` -- option, or TESTOPS_MOBILE_WEB_CHROMIUM_PATH.
  const browser = await chromium.launch({
    headless: options.headless !== false,
    executablePath: options.executablePath || process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined,
  });
  try {
    const context = await browser.newContext(options.contextOptions || {});
    const page = await context.newPage();
    return await runWebSteps(page, steps, options);
  } finally {
    await browser.close();
  }
}

module.exports = { runWebSteps, runWebTestCase, validateWebSteps, WEB_KINDS };
