/**
 * Records a manual browsing session as steps in the SAME format
 * web/web-test-case-runner.js replays. Works against any Playwright page.
 */
const { ELEMENT_AT_POINT, buildWebSelectorCandidates, describeElement } = require("./dom-resolver");
const { locatorFor } = require("../web-test-case-runner");

const SCROLL_PIXELS = 600;
const SETTLE_MS = 350;

const VISIBLE_LINES = function () {
  var text = (document.body && document.body.innerText) || "";
  var seen = {}, out = [];
  text.split("\n").forEach(function (l) {
    l = l.trim();
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
  }

  async _lines() {
    try { return await this.page.evaluate(VISIBLE_LINES); } catch { return []; }
  }

  async _settle() {
    try { await this.page.waitForLoadState("load", { timeout: 3000 }); } catch { /* no navigation */ }
    await this.sleep(SETTLE_MS);
  }

  _expectFrom(before, after, typedValues = []) {
    const had = new Set(before);
    const typed = new Set(typedValues);
    // Keep only lines that read like real, stable copy: not fragments of a
    // wrapped heading ("phones, always the"), not tiny words ("RM", "All"),
    // not prices, clocks or what the tester typed. Longest lines first.
    const appeared = after
      .filter((l) => !had.has(l) && l.length >= 6 && l.length <= 60 && !/[?]\s*$/.test(l) && /^[A-Z0-9]/.test(l) &&
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
  async _resolveSelector(descriptor, point) {
    const candidates = buildWebSelectorCandidates(descriptor);
    if (!candidates.length) return null;
    try {
      let bestPinned = null;
      for (let i = 0; i < candidates.length; i += 1) {
        const cand = candidates[i];
        // The last candidate is a positional css path: only worth using when no
        // semantic locator (role/label/id/text) matched the element at all.
        if (i === candidates.length - 1 && bestPinned) break;
        // count matches and where the target sits among them
        const loc = this._allMatches(cand);
        const info = await loc.evaluateAll((els) => ({ count: els.length, index: els.findIndex((e) => e.hasAttribute("data-tm-target")) })).catch(() => null);
        if (!info || info.index < 0) continue;
        if (info.count === 1) return cand;
        if (!bestPinned || info.count < bestPinned.count) bestPinned = { cand, count: info.count, index: info.index };
      }
      return bestPinned ? { ...bestPinned.cand, nth: bestPinned.index } : candidates[candidates.length - 1];
    } finally {
      await this.page.evaluate(() => document.querySelectorAll("[data-tm-target]").forEach((n) => n.removeAttribute("data-tm-target"))).catch(() => {});
    }
  }

  /** Locator for ALL matches of a candidate (no nth/first applied). */
  _allMatches(sel) {
    const page = this.page;
    switch (sel.strategy) {
      case "css": return page.locator(sel.value);
      case "text": return page.getByText(sel.value, { exact: false });
      case "label": return page.getByLabel(sel.value);
      case "testid": return page.getByTestId(sel.value);
      case "role": return page.getByRole(sel.role, { name: sel.value, exact: sel.exact === true });
      default: return page.locator(sel.value);
    }
  }

  /** @param {number} xRatio 0..1 of the rendered viewport  @param {number} yRatio */
  async click(xRatio, yRatio) {
    const vp = this.page.viewportSize();
    const point = { x: Math.round(xRatio * vp.width), y: Math.round(yRatio * vp.height) };
    const descriptor = await this.page.evaluate(ELEMENT_AT_POINT, point);
    const selector = descriptor ? await this._resolveSelector(descriptor, point) : null;
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
    return { index, step, descriptor };
  }

  /** Types the FULL current value into the focused field (idempotent: replaces, never appends). */
  async type(text) {
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
      return { index: target.index, step: existing };
    }
    const step = {
      kind: "type",
      instruction: describeElement(target.descriptor, "Type into"),
      selector: target.selector,
      text,
    };
    this.steps[target.index] = step; // replaces the focusing click
    return { index: target.index, step };
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
