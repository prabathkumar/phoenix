/**
 * Attaches to a WebDriver/Appium session that something OTHER than
 * Phoenix already opened, instead of session.js/ios-session.js's
 * startSession() which always creates a brand-new one.
 *
 * Why this exists: TestOps already holds the BrowserStack credentials
 * and already does device selection + app upload + session creation
 * (decided 2026-10-04 -- see README's element-identification section
 * for the equivalent decision on WebView snapshotting; this is the
 * execution-ownership equivalent). So for a TestOps-triggered run,
 * Phoenix must never create its own BrowserStack session or hold
 * BrowserStack credentials at all -- it only needs the session TestOps
 * already started (its id and hub URL) to drive it.
 *
 * This is deliberately a THIN wrapper: webdriverio's own `attach()`
 * already does the real work (reconnects to an existing remote
 * session by id, same protocol detection as `remote()`). Once
 * attached, the returned Browser object is indistinguishable from one
 * started by remote() to everything else in the pipeline
 * (capture/generation/live-view/engine only ever see a normal
 * WebdriverIO Browser) -- same reasoning remote-provider.js's own
 * header comment makes for BrowserStack vs local.
 *
 * Ownership rule: a session Phoenix attached to (rather than started)
 * must NEVER be torn down by Phoenix (`driver.deleteSession()`) --
 * that is TestOps's session to close, not Phoenix's. Callers must not
 * call deleteSession on the object this returns; see
 * frontend/execute-test-case-endpoint.js, the only current caller, for
 * how that's honored.
 */

const { attach } = require("webdriverio");

/**
 * @param {Object} params
 * @param {string} params.sessionId - the already-live session id TestOps's
 *   own BrowserStack/Appium session-start call returned.
 * @param {string} [params.hostname] - Appium/hub hostname. Defaults to
 *   BrowserStack's hub, since that's the only real caller today, but any
 *   WebDriver-protocol hub is accepted.
 * @param {number} [params.port]
 * @param {string} [params.path]
 * @param {boolean} [params.isSecure] - defaults to true (https), matching
 *   BrowserStack.
 * @param {Object} [params.capabilities] - optional; only needed if a
 *   caller wants attach() to know the platform up front rather than
 *   querying it, mirrors webdriverio's own `attach()` options.
 * @returns {Promise<import('webdriverio').Browser>}
 */
async function attachSession({
  sessionId,
  hostname = "hub-cloud.browserstack.com",
  port = 443,
  path = "/wd/hub",
  isSecure = true,
  capabilities,
}) {
  if (!sessionId) {
    throw new Error("attachSession requires sessionId -- the id of a session TestOps already started.");
  }
  return attach({
    sessionId,
    hostname,
    port,
    path,
    isSecure,
    capabilities,
  });
}

module.exports = { attachSession };
