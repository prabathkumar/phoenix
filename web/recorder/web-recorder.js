/**
 * Records a manual browsing session as steps in the SAME format
 * web/web-test-case-runner.js replays. Works against any Playwright page.
 */
const { resolveSelector, allMatches } = require("./locate");
const { ELEMENT_AT_POINT, buildWebSelectorCandidates, describeElement } = require("./dom-resolver");
const { locatorFor } = require("../web-test-case-runner");
const { executeApiStep, validateApiStep } = require("../../engine/core/api-step");

const SCROLL_PIXELS = 600;
const SETTLE_MS = 350;

const VISIBLE_LINES = function () {
  var text = (document.body && document.body.innerText) || "";
  var seen = {}, out = [];
  text.split("\n").forEach(function (l) {
    l = l.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    if (l && !seen[l]) { seen[l] = true; out.push(l.slice(0, 200)); }
  });
  return out.slice(0, 500);
};

const NOISY_LINE_RE = /^[\d\s:.,/%-]+$|^[•*●·]+$/; // clocks, counters, masked values
const PRICE_RE = /(\bRM|\$|€|£|S\$|USD|MYR|SGD)\s?\d|\d\s?\/\s?(mth|month|yr|year)/i; // prices change; don't pin tests to them
const MAX_ASSERTIONS_PER_STEP = 3;

class WebRecorder {
  /** @param {import('playwright').Page} page */
  constructor(page, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.page = page;
    this.sleep = sleep;
    this.steps = [];
    this._lastTap = null; // { index, selector, descriptor }
    this.vars = {}; // test data + values saved by api steps (for ${NAME} in later api calls)
  }

  async _lines() {
    try { return await this.page.evaluate(VISIBLE_LINES); } catch { return []; }
  }

  async _settle() {
    try { await this.page.waitForLoadState("load", { timeout: 3000 }); } catch { /* no navigation */ }
    // Let XHR-driven results (search, filters) land before the "after" snapshot.
    try { await this.page.waitForLoadState("networkidle", { timeout: 2000 }); } catch { /* chatty page: carry on */ }
    await this.sleep(SETTLE_MS);
  }

  _expectFrom(before, after, typedValues = []) {
    const had = new Set(before);
    const typed = new Set(typedValues);
    // Keep only lines that read like real, stable copy: not fragments of a
    // wrapped heading ("phones, always the"), not tiny words ("RM", "All"),
    // not prices, clocks or what the tester typed. Longest lines first.
    const appeared = after
      .filter((l) => !had.has(l) && !/\d{4,}/.test(l) && (l.match(/,/g) || []).length < 2 && l.length >= 6 && l.length <= 60 && !/[?]\s*$/.test(l) && /^[A-Z0-9]/.test(l) &&
        (l.match(/[A-Za-z]/g) || []).length >= 4 && !NOISY_LINE_RE.test(l) && !PRICE_RE.test(l) && !typed.has(l))
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_ASSERTIONS_PER_STEP);
    return appeared.length ? { appeared } : undefined;
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: "load", timeout: 30000 });
    this.steps.push({ kind: "navigate", instruction: `Open ${url}`, url: this.page.url() });
    this._lastTap = null;
    return this.steps.length - 1;
  }

  /**
   * Picks the most stable selector that points at exactly the element the
   * tester clicked. Candidates are tried best-first against the live page; a
   * non-unique match is pinned with `nth` rather than silently clicking the
   * wrong twin (nav link vs. page link with the same text, duplicate ids...).
   */
  async _resolveSelector(descriptor) {
    return resolveSelector(this.page, descriptor);
  }

  _allMatches(sel) {
    return allMatches(this.page, sel);
  }

  /** @param {number} xRatio 0..1 of the rendered viewport  @param {number} yRatio */
  async click(xRatio, yRatio) {
    const vp = this.page.viewportSize();
    const point = { x: Math.round(xRatio * vp.width), y: Math.round(yRatio * vp.height) };
    const descriptor = await this.page.evaluate(ELEMENT_AT_POINT, point);
    const resolved = descriptor ? await this._resolveSelector(descriptor, point) : { selector: null, fragile: true };
    const selector = resolved.selector;
    // A native <select> popup is drawn by the browser, not the page, so it never
    // appears in the mirror. Hand the options to the tester to pick from instead.
    if (descriptor && descriptor.tag === "select" && selector) {
      this._pendingSelect = { descriptor, selector };
      this._lastTap = null;
      return {
        pendingSelect: {
          instruction: describeElement(descriptor, "Select in"),
          options: (descriptor.options || []).filter((o) => o.label),
        },
      };
    }

    // Clicks INSIDE an embedded frame (a chat widget, a payment form) cannot be recorded:
    // the page can't see into it. Still perform the click so the mirror stays in step with
    // what the tester is doing, but record nothing and say why.
    if (descriptor && descriptor.tag === "iframe") {
      await this.page.mouse.click(point.x, point.y);
      await this._settle();
      this._lastTap = null;
      return { iframe: true, descriptor };
    }

    const urlBefore = this.page.url();
    const before = await this._lines();

    await this.page.mouse.click(point.x, point.y);
    await this._settle();

    const after = await this._lines();
    const step = {
      kind: "tap",
      instruction: describeElement(descriptor, "Click"),
      ...(selector ? { selector } : {}),
    };
    if (!selector) step.instruction = `Click at ${point.x},${point.y}`;
    const expect = this._expectFrom(before, after);
    if (expect) step.expect = expect;
    this.steps.push(step);
    const index = this.steps.length - 1;

    const urlAfter = this.page.url();
    if (urlAfter !== urlBefore) {
      let pathname = "";
      try { pathname = new URL(urlAfter).pathname; } catch { /* ignore */ }
      if (pathname && pathname !== "/" && pathname !== new URL(urlBefore).pathname) {
        this.steps.push({ kind: "assert", instruction: `Landed on ${pathname}`, assert: { urlContains: pathname } });
      }
    }
    this._lastTap = descriptor && descriptor.editable ? { index, selector, descriptor } : null;
    return { index, step, descriptor, fragile: resolved.fragile };
  }

  /** Types the FULL current value into the focused field (idempotent: replaces, never appends). */
  async type(text, { param } = {}) {
    const target = this._lastTap;
    if (!target) {
      const err = new Error("Click a field before typing into it — there's no focused field to type into yet.");
      err.code = "no-field";
      throw err;
    }
    await locatorFor(this.page, target.selector).first().fill(text, { timeout: 5000 });

    // Replace (not stack) typed steps for the same field, and fold the click
    // that focused it into the type step: replay's fill() focuses by itself.
    const existing = this.steps[target.index];
    if (existing && existing.kind === "type") {
      existing.text = text;
      if (param) existing.param = param; else delete existing.param;
      return { index: target.index, step: existing };
    }
    const step = {
      kind: "type",
      instruction: describeElement(target.descriptor, "Type into"),
      selector: target.selector,
      text,
      ...(param ? { param } : {}),
    };
    this.steps[target.index] = step; // replaces the focusing click
    return { index: target.index, step };
  }

  setTestData(data) {
    this.vars = { ...this.vars, ...(data && typeof data === "object" ? data : {}) };
  }

  /**
   * Runs an API call now (so the tester sees the real response) and, when
   * `record` is set and the checks pass (or `force`), records it as a step.
   * Values it `save`s become ${NAME} for later steps.
   */
  async api(spec, { record = false, force = false } = {}) {
    const step = { kind: "api", ...spec };
    delete step.record;
    const problem = validateApiStep(step);
    if (problem) return { result: { ok: false, reason: `api step ${problem}`, saved: {}, request: {} }, recorded: false };
    let origin;
    try { origin = new URL(this.page.url()).origin; } catch { origin = undefined; }
    const result = await executeApiStep(step, { vars: this.vars, baseUrl: origin });
    let index;
    if (record && (result.ok || force)) {
      if (!step.instruction) step.instruction = `${step.method || "GET"} ${step.url}`;
      this.steps.push(step);
      index = this.steps.length - 1;
      this._lastTap = null;
    }
    return { result, recorded: index !== undefined, index, step };
  }

  /** Removes the last recorded action (and the "Landed on" assert that followed it, if any). */
  undo() {
    let removed = 0;
    while (this.steps.length && this.steps[this.steps.length - 1].kind === "assert") { this.steps.pop(); removed += 1; }
    if (this.steps.length) { this.steps.pop(); removed += 1; }
    this._lastTap = null;
    this._pendingSelect = null;
    return removed;
  }

  /** Chooses an option (by visible label) in the <select> the tester last clicked. */
  async select(label) {
    const target = this._pendingSelect;
    if (!target) {
      const err = new Error("Click a dropdown first, then pick one of its options.");
      err.code = "no-select";
      throw err;
    }
    const before = await this._lines();
    await locatorFor(this.page, target.selector).first().selectOption({ label }, { timeout: 5000 });
    await this._settle();
    const after = await this._lines();
    const step = {
      kind: "select",
      instruction: `${describeElement(target.descriptor, "Select")} → "${label}"`.replace(/^Select "/, 'Select "'),
      selector: target.selector,
      option: label,
    };
    const expect = this._expectFrom(before, after, [label]);
    if (expect) step.expect = expect;
    this.steps.push(step);
    this._pendingSelect = null;
    return { index: this.steps.length - 1, step };
  }

  /** Presses a key (e.g. Enter) in the field that was last typed into. */
  async press(key = "Enter") {
    const target = this._lastTap;
    if (!target) {
      const err = new Error("Click and type in a field before pressing a key.");
      err.code = "no-field";
      throw err;
    }
    const urlBefore = this.page.url();
    const before = await this._lines();
    await this.page.keyboard.press(key);
    await this._settle();
    const after = await this._lines();
    const step = { kind: "press", instruction: `Press ${key}`, key, selector: target.selector };
    const expect = this._expectFrom(before, after);
    if (expect) step.expect = expect;
    this.steps.push(step);
    const index = this.steps.length - 1;
    const urlAfter = this.page.url();
    if (urlAfter !== urlBefore) {
      try {
        const pathname = new URL(urlAfter).pathname;
        if (pathname && pathname !== "/" && pathname !== new URL(urlBefore).pathname) {
          this.steps.push({ kind: "assert", instruction: `Landed on ${pathname}`, assert: { urlContains: pathname } });
        }
      } catch { /* ignore */ }
    }
    return { index, step };
  }

  async scroll(direction) {
    const dy = direction === "up" ? -SCROLL_PIXELS : SCROLL_PIXELS;
    await this.page.mouse.wheel(0, dy);
    await this.sleep(SETTLE_MS);
    const step = { kind: "scroll", instruction: `Scroll ${direction}`, direction: direction === "up" ? "up" : "down" };
    this.steps.push(step);
    this._lastTap = null;
    return { index: this.steps.length - 1, step };
  }
}

module.exports = { WebRecorder };
