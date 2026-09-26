/**
 * Capture layer (docs/PHOENIX_SPEC.md §4.2).
 *
 * Records what happens during a guided session: every tap, the element
 * it resolved to, and a before/after screenshot + accessibility tree.
 * This is the sole input to generation/ — it never decides what the
 * script should look like, it just captures ground truth.
 */

/** @typedef {{ resourceId?: string, accessibilityId?: string, text?: string, contentDesc?: string, className?: string, bounds?: string, xpath?: string }} ResolvedElement */

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
 * Maps a tap coordinate to the element in the accessibility tree whose
 * bounds contain it, then picks the most stable identifier available.
 *
 * TODO(stage 1): implement against real UIAutomator2/XCUITest XML.
 * TODO(stage 1): screenshot-based fallback for elements with no usable
 * accessibility attributes (custom-drawn views) — see spec §4.2/§6.
 */
function resolveElementAtCoordinate(coordinate, pageSourceXml) {
  throw new Error("resolveElementAtCoordinate: not yet implemented");
}

module.exports = { SessionRecorder, resolveElementAtCoordinate };
