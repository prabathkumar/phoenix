/**
 * Capture layer (docs/PHOENIX_SPEC.md §4.2).
 *
 * Records what happens during a guided session: every tap, the element
 * it resolved to, and a before/after screenshot + accessibility tree.
 * This is the sole input to generation/ — it never decides what the
 * script should look like, it just captures ground truth.
 */

const { DOMParser } = require("@xmldom/xmldom");

/** @typedef {{ strategy: "resource-id"|"accessibility-id"|"text"|"xpath"|"coordinate", value: string, resourceId?: string, accessibilityId?: string, text?: string, contentDesc?: string, className?: string, bounds?: string, xpath?: string }} ResolvedElement */

// Zero-width space/non-joiner/joiner and the BOM/zero-width-no-break-space
// -- invisible characters String.prototype.trim() does NOT strip. Seen for
// real in a BrowserStack recording (BitBar Sample App): an iOS element's
// accessibility identifier was literally "​", which survives a plain
// .trim() check as a "real" value (non-empty, truthy) but renders as an
// empty selector (`~` with nothing visible after it) everywhere it's used.
// Same rule generation/pipeline.js's isBlank()/cleanLabel() apply to labels
// pulled from the same accessibility trees for assertions.
const INVISIBLE_CHARS_RE = /[​‌‍﻿]/g;

/**
 * @typedef {Object} CapturedStep
 * @property {number} timestamp
 * @property {{ x: number, y: number }} tapCoordinate
 * @property {ResolvedElement} resolvedElement - chosen per the locator
 *   priority in the spec: resource-id/accessibility-id first, then
 *   text/content-desc, then structural xpath, coordinates as last resort.
 * @property {string} screenshotBeforeBase64
 * @property {string} screenshotAfterBase64
 * @property {string} pageSourceBefore
 * @property {string} pageSourceAfter
 * @property {string} [typedValue] - set when the step was text entry, not a tap
 */

class SessionRecorder {
  constructor(driver) {
    this.driver = driver;
    /** @type {CapturedStep[]} */
    this.steps = [];
  }

  /**
   * Call this immediately before forwarding a tester's tap to the device.
   * Captures pre-state; caller is responsible for capturing post-state
   * once the tap has been injected and the UI has settled.
   */
  async beginStep(tapCoordinate) {
    const screenshotBeforeBase64 = await this.driver.takeScreenshot();
    const pageSourceBefore = await this.driver.getPageSource();
    return { tapCoordinate, screenshotBeforeBase64, pageSourceBefore, timestamp: Date.now() };
  }

  /**
   * Call this after the tap has been injected and the UI has settled.
   * Resolves the tapped element against pageSourceBefore and records
   * the completed step.
   */
  async completeStep(partialStep) {
    const screenshotAfterBase64 = await this.driver.takeScreenshot();
    const pageSourceAfter = await this.driver.getPageSource();
    const resolvedElement = resolveElementAtCoordinate(
      partialStep.tapCoordinate,
      partialStep.pageSourceBefore
    );

    /** @type {CapturedStep} */
    const step = { ...partialStep, screenshotAfterBase64, pageSourceAfter, resolvedElement };
    this.steps.push(step);
    return step;
  }

  /** Called on "Stop" — hands the full session to generation/. */
  finish() {
    return this.steps;
  }
}

/**
 * Parses a UiAutomator2-style bounds string, e.g. "[0,275][1080,401]",
 * into a rectangle. Returns null if the string doesn't match.
 */
function parseAndroidBounds(boundsAttr) {
  if (!boundsAttr) return null;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(boundsAttr.trim());
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

/**
 * Reads XCUITest-style x/y/width/height attributes into the same
 * rectangle shape parseAndroidBounds() produces. XCUITest's page source
 * has no single "bounds" attribute — each element carries its own x, y,
 * width, height instead. Returns null if the element has none of these
 * (not every XCUITest element does, e.g. the root Application node).
 */
function parseIOSBounds(element) {
  const get = (name) => {
    const value = element.getAttribute && element.getAttribute(name);
    return value !== null && value !== undefined && value !== "" ? Number(value) : null;
  };
  const x = get("x");
  const y = get("y");
  const width = get("width");
  const height = get("height");
  if (x === null || y === null || width === null || height === null) return null;
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return null;
  return { x1: x, y1: y, x2: x + width, y2: y + height };
}

/**
 * Tries both platforms' bounds representations against one element node
 * — Android's single "bounds" attribute string first (cheap to check
 * and rule out), then XCUITest's x/y/width/height attributes. This lets
 * resolveElementAtCoordinate() work against either tree shape without
 * needing to know up front which platform captured it (the session
 * already knows, via platformName, but the recorder itself stays
 * platform-agnostic — same as it always intentionally has been for
 * Android's own UiAutomator2 tree).
 */
function parseBounds(element) {
  const androidBounds = element.getAttribute && parseAndroidBounds(element.getAttribute("bounds"));
  if (androidBounds) return androidBounds;
  return parseIOSBounds(element);
}

function containsPoint(rect, x, y) {
  return x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
}

function rectArea(rect) {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

/**
 * Builds a structural xpath for an element by walking up to the root and
 * recording each ancestor's tag name plus its 1-based position among
 * same-tag siblings — the fallback locator when nothing else is stable.
 */
function buildXPath(element) {
  const segments = [];
  let node = element;
  while (node && node.nodeType === 1 && node.tagName) {
    const tagName = node.tagName;
    let position = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && sibling.tagName === tagName) position += 1;
      sibling = sibling.previousSibling;
    }
    segments.unshift(`${tagName}[${position}]`);
    node = node.parentNode;
  }
  return "/" + segments.join("/");
}

/**
 * Maps a tap coordinate to the element in the accessibility tree whose
 * bounds contain it, then picks the most stable identifier available.
 *
 * Locator priority (docs/PHOENIX_SPEC.md §4.2):
 *   1. resource-id           — stable across app builds, when present
 *   2. accessibility-id      — content-desc, the WebDriver "accessibility id" strategy
 *   3. text / content-desc   — human-readable, can change with copy edits
 *   4. structural xpath      — brittle but always available
 *   5. raw coordinate        — last resort, breaks on any layout change
 *
 * Among all elements whose bounds contain the tap point (there will
 * usually be several nested ones — a ListView, then a row, then a
 * TextView), the smallest-area match is preferred: it's the most
 * specific element actually under the tester's finger, not a large
 * ancestor container that happens to contain it too.
 *
 * TODO(stage 1 follow-up): screenshot-based fallback for elements with
 * no usable accessibility attributes (custom-drawn views, e.g. raw
 * Canvas/OpenGL content) — see spec §4.2/§6. Not needed for standard
 * native widgets, which is everything Stage 1 targets.
 */
function resolveElementAtCoordinate(coordinate, pageSourceXml) {
  const { x, y } = coordinate;
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString(pageSourceXml, "text/xml");

  const candidates = [];
  const walk = (node) => {
    if (node.nodeType === 1 && node.getAttribute) {
      const rect = parseBounds(node);
      if (rect && containsPoint(rect, x, y)) {
        candidates.push({ node, rect });
      }
    }
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) walk(children[i]);
  };
  walk(doc.documentElement);

  if (candidates.length === 0) {
    return { strategy: "coordinate", value: `${x},${y}`, bounds: null };
  }

  candidates.sort((a, b) => rectArea(a.rect) - rectArea(b.rect));
  const { node: element, rect } = candidates[0];

  // Trims and treats a whitespace-only value the same as a missing one --
  // seen for real against a BrowserStack-recorded iOS app (BitBar Sample
  // App's biometrics screen): a couple of elements carried a `name`
  // attribute that was present but blank/whitespace-only rather than
  // simply absent, which a plain truthiness check lets through as a
  // "real" accessibility-id, producing an unusable `~` selector (nothing
  // after the tilde) instead of falling through to text or xpath as
  // designed. A bare falsy check on the raw attribute value doesn't catch
  // this -- a non-empty string of only spaces is truthy in JS.
  const get = (name) => {
    const value = element.getAttribute && element.getAttribute(name);
    const trimmed = typeof value === "string" ? value.replace(INVISIBLE_CHARS_RE, "").trim() : value;
    return trimmed ? trimmed : undefined;
  };

  // Android's UiAutomator2 tree uses resource-id/content-desc/text.
  // XCUITest's tree has no resource-id equivalent — it uses "name" as
  // its accessibility identifier (the WebDriver "accessibility id"
  // strategy on iOS) and "label"/"value" for human-readable text. Try
  // both attribute sets; whichever the platform actually populated wins,
  // the other set is simply absent on that tree.
  const resourceId = get("resource-id"); // Android only
  const contentDesc = get("content-desc") || get("name"); // Android content-desc, or iOS accessibility id
  const text = get("text") || get("label") || get("value"); // Android text, or iOS label/value
  const className = element.tagName;
  const bounds = rect.x1 !== undefined ? `[${rect.x1},${rect.y1}][${rect.x2},${rect.y2}]` : undefined;
  const xpath = buildXPath(element);

  /** @type {ResolvedElement} */
  const base = { resourceId, accessibilityId: contentDesc, text, contentDesc, className, bounds, xpath };

  if (resourceId) return { ...base, strategy: "resource-id", value: resourceId };
  if (contentDesc) return { ...base, strategy: "accessibility-id", value: contentDesc };
  if (text) return { ...base, strategy: "text", value: text };
  return { ...base, strategy: "xpath", value: xpath };
}

module.exports = {
  SessionRecorder,
  resolveElementAtCoordinate,
  parseBounds,
  parseAndroidBounds,
  parseIOSBounds,
  buildXPath,
};
