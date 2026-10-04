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
 * REAL BUG, found 2026-10-04 on the first real-device validation of this
 * module: webdriverio's attach() does NOT take hostname/port/path/isSecure
 * at the top level (that's remote()'s shape, which this module's header
 * comment wrongly assumed was the same). attach() instead reads connection
 * details from a nested `options` object and a `protocol` string
 * ("https"/"http"), not an `isSecure` boolean -- see
 * node_modules/webdriverio/build/utils/detectBackend.js and
 * node_modules/webdriverio/build/index.js's `attach` export. Passing the
 * old flat shape left hostname/port effectively undefined, which
 * surfaced downstream as a generic "Invalid URL" on the first real
 * WebDriver call (getPageSource via the semantic-act executor), not as
 * an attach()-time error -- attach() itself never validates the session,
 * it just builds a client. Fixed by nesting under `options` and using
 * `protocol` instead of `isSecure`.
 *
 * @param {Object} params
 * @param {string} params.sessionId - the already-live session id TestOps's
 *   own BrowserStack/Appium session-start call returned.
 * @param {string} [params.hostname] - Appium/hub hostname. Defaults to
 *   BrowserStack's hub, since that's the only real caller today, but any
 *   WebDriver-protocol hub is accepted.
 * @param {number} [params.port]
 * @param {string} [params.path]
 * @param {string} [params.protocol] - defaults to "https", matching
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
  protocol = "https",
  capabilities,
}) {
  if (!sessionId) {
    throw new Error("attachSession requires sessionId -- the id of a session TestOps already started.");
  }
  return attach({
    sessionId,
    options: { hostname, port, path, protocol },
    capabilities,
  });
}

module.exports = { attachSession };
