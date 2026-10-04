/**
 * Embedded session — Appium's driver logic running in-process, not
 * spawned as a separate `appium` server.
 *
 * session.js (used by stage0-session.js and run-session.js today) talks
 * to a separately-running `appium` CLI process over HTTP via
 * webdriverio's remote() client: our process -> HTTP -> appium server
 * process -> AndroidUiautomator2Driver -> HTTP -> on-device UiAutomator2
 * server -> ADB -> device. That's proven and works (see README Status),
 * but it's two processes and one extra HTTP hop we don't need.
 *
 * This module removes the middle process and hop: we `require()`
 * appium-uiautomator2-driver directly and call its methods on our own
 * driver instance, in this same Node process. What's left —
 * AndroidUiautomator2Driver -> HTTP -> on-device UiAutomator2 server ->
 * ADB -> device — can't be removed; that's how UiAutomator2 itself
 * works (a real APK Appium installs on the device, talked to over a
 * forwarded port), not an artifact of how we're calling it.
 *
 * Why this approach and not vendoring/forking the driver's own source:
 * appium-uiautomator2-driver's exports are entangled with the `appium`
 * package's own subpath exports (`appium/driver.js`, `appium/support.js`)
 * rather than the more decoupled `@appium/base-driver`, so a from-scratch
 * fork would mean also forking `appium-android-driver` and
 * `@appium/base-driver`'s session/capability machinery — a multi-week
 * effort with no upstream precedent for doing it this way. Requiring the
 * packages directly and skipping only the CLI/HTTP-server layer gets the
 * real goal (no separate process, no WebDriver-over-HTTP round trip to
 * our own server) without that cost. Revisit vendoring only if a
 * concrete need shows up that this can't satisfy (e.g. a protocol
 * extension the driver itself doesn't expose).
 *
 * Method names here are the driver's own command names (from
 * appium-uiautomator2-driver@8.7.0's lib/commands/*), not WebDriver
 * protocol endpoint names — e.g. the protocol's `GET /screenshot` maps
 * to the driver's `getScreenshot()`, and `mobile: clickGesture` maps to
 * `mobileClickGesture(elementId, x, y)`.
 */

const { buildCapabilities } = require("./session");

/**
 * appium-uiautomator2-driver ships ESM-only (its package.json "exports"
 * has no CommonJS entry), while the rest of TestOps Mobile's engine/ is
 * CommonJS — so it's loaded via a dynamic import() rather than
 * require(), which is the standard way to consume an ESM-only package
 * from CJS. This is the one thing about embedding that a spawned
 * `appium` server hides from its clients (it's a separate process, so
 * its module system is its own concern); calling the driver in-process
 * means we deal with this directly.
 */
async function loadDriverClass() {
  const { AndroidUiautomator2Driver } = await import("appium-uiautomator2-driver");
  return AndroidUiautomator2Driver;
}

/**
 * @param {object} [capabilityOverrides]
 * @returns {Promise<import('appium-uiautomator2-driver').AndroidUiautomator2Driver>}
 *   A driver instance with an active session — call its command methods
 *   directly (getScreenshot(), getPageSource(), mobileClickGesture(),
 *   deleteSession(), ...), then discard it. There is no server to stop.
 */
async function startEmbeddedSession(capabilityOverrides) {
  const AndroidUiautomator2Driver = await loadDriverClass();
  const driver = new AndroidUiautomator2Driver();
  const capabilities = buildCapabilities(capabilityOverrides);

  // BaseDriver#createSession scans its positional args for one shaped
  // like W3C capabilities ({ alwaysMatch, firstMatch }) — no outer
  // "capabilities" wrapper, unlike the JSON body webdriverio's remote()
  // sends over HTTP. See @appium/base-driver's isW3cCaps().
  await driver.createSession({ alwaysMatch: capabilities, firstMatch: [{}] });

  return driver;
}

module.exports = { startEmbeddedSession };
