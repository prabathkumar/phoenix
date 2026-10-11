/**
 * Records a manual browsing session as steps in the SAME format
 * web/web-test-case-runner.js replays. Works against any Playwright page.
 */
const { ELEMENT_AT_POINT, buildWebSelector, describeElement } = require("./dom-resolver");

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
    const appeared = after
      .filter((l) => !had.has(l) && l.length <= 80 && !NOISY_LINE_RE.test(l) && !typed.has(l))
      .slice(0, 4);
    return appeared.length ? { appeared } : undefined;
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: "load", timeout: 30000 });
    this.steps.push({ kind: "navigate", instruction: `Open ${url}`, url: this.page.url() });
    this._lastTap = null;
    return this.steps.length - 1;
  }

  /** @param {number} xRatio 0..1 of the rendered viewport  @param {number} yRatio */
  async click(xRatio, yRatio) {
    const vp = this.page.viewportSize();
    const point = { x: Math.round(xRatio * vp.width), y: Math.round(yRatio * vp.height) };
    const descriptor = await this.page.evaluate(ELEMENT_AT_POINT, point);
    const selector = descriptor ? buildWebSelector(descriptor) : null;
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
    const locatorFor = (sel) => {
      switch (sel.strategy) {
        case "testid": return this.page.getByTestId(sel.value);
        case "label": return this.page.getByLabel(sel.value).first();
        case "text": return this.page.getByText(sel.value).first();
        default: return this.page.locator(sel.value).first();
      }
    };
    await locatorFor(target.selector).fill(text, { timeout: 5000 });

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
