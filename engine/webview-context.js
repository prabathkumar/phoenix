/**
 * WebView/browser-context detection -- the first piece of the opt-in
 * hybrid-app resolution module discussed and scoped (but deliberately
 * not built) earlier: "we can wire into the framework but opt it -- if
 * the need arises for the webview then the tester can enable the
 * option to the browser view", kept as "a module" behind Phoenix's
 * existing single resolution interface so nobody calling
 * executeSemanticAction() needs to know or care whether a given step
 * resolved natively or via a WebView's own DOM. Explicit follow-up
 * requirement: when a WebView/browser context genuinely IS available,
 * prioritize it automatically rather than requiring a tester to flip a
 * flag -- a real DOM gives far richer, more stable selectors (id, name,
 * aria-label, a real CSS path) than anything XCUITest/UiAutomator2 can
 * see of the same rendered content.
 *
 * Appium already exposes this natively -- `driver.getContexts()`
 * returns something like `["NATIVE_APP", "WEBVIEW_com.app.pkg"]`, and
 * `driver.switchContext(name)` moves the session into one of them. This
 * module only wraps the detection half in the same fail-safe contract
 * every other piece of this layer already follows (generation/llm.js,
 * generation/semantic-act.js): never throw, report what's actually
 * there. A driver with no WebView support at all (most native-only test
 * doubles, and a genuinely all-native app, which is every real app this
 * codebase has actually run against so far -- see test-cases/addons.json
 * and addons.ios.json, neither of which has ever shown a WEBVIEW_*
 * context in any real captured run) reports back `null`, exactly like
 * "no WebView here" should, so wiring this in changes nothing for an
 * app that doesn't have one.
 */

/**
 * @param {import('webdriverio').Browser} driver
 * @returns {Promise<string|null>} the first WEBVIEW_* context name
 *   reported by the live session, exactly as Appium names it (never
 *   invented/guessed), or null when there isn't one -- no WebView
 *   present, or the driver/platform doesn't support contexts at all.
 */
async function detectWebviewContext(driver) {
  if (!driver || typeof driver.getContexts !== "function") {
    return null;
  }
  try {
    const contexts = await driver.getContexts();
    if (!Array.isArray(contexts)) {
      return null;
    }
    const webview = contexts.find((c) => typeof c === "string" && c.startsWith("WEBVIEW"));
    return webview || null;
  } catch (err) {
    // A native-only app/driver throws here rather than returning
    // ["NATIVE_APP"] -- treated identically to "no WebView", not an
    // error, since "this app has no WebView" is the expected, common
    // case, not a failure of anything.
    return null;
  }
}

module.exports = { detectWebviewContext };
