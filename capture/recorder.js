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
 * Parses a UIAutomator2/XCUITest style bounds string, e.g. "[0,275][1080,401]",
 * into a rectangle. Returns null if the string doesn't match.
 */
function parseBounds(boundsAttr) {
  if (!boundsAttr) return null;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(boundsAttr.trim());
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
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
    if (node.nodeType === 1) {
      const boundsAttr = node.getAttribute && node.getAttribute("bounds");
      const rect = parseBounds(boundsAttr);
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

  const get = (name) => {
    const value = element.getAttribute && element.getAttribute(name);
    return value ? value : undefined;
  };

  const resourceId = get("resource-id");
  const contentDesc = get("content-desc");
  const text = get("text");
  const className = element.tagName;
  const bounds = `[${rect.x1},${rect.y1}][${rect.x2},${rect.y2}]`;
  const xpath = buildXPath(element);

  /** @type {ResolvedElement} */
  const base = { resourceId, accessibilityId: contentDesc, text, contentDesc, className, bounds, xpath };

  if (resourceId) return { ...base, strategy: "resource-id", value: resourceId };
  if (contentDesc) return { ...base, strategy: "accessibility-id", value: contentDesc };
  if (text) return { ...base, strategy: "text", value: text };
  return { ...base, strategy: "xpath", value: xpath };
}

module.exports = { SessionRecorder, resolveElementAtCoordinate, parseBounds, buildXPath };
