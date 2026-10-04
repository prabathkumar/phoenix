/**
 * iOS counterpart to stage0-session.js — the same four-step milestone
 * (session start -> screenshot -> accessibility tree -> tap -> teardown)
 * against a local iOS Simulator via appium-xcuitest-driver, proving the
 * spawn path works on iOS the same way it was proven on Android.
 *
 * XCUITest's tap gesture extension is `mobile: tap` (x, y) — different
 * from UiAutomator2's `mobile: clickGesture` used in stage0-session.js.
 *
 * Run: TESTOPS_MOBILE_IOS_APP_PATH=/path/to/YourApp.app node engine/ios-stage0-session.js
 * (with `appium` running separately and `appium driver install xcuitest`
 * already done — same spawn model as stage0-session.js, see its header)
 */

const { startSession } = require("./ios-session");

async function stage0() {
  const driver = await startSession();

  console.log("[ios-stage0] session started:", driver.sessionId);

  const screenshotBase64 = await driver.takeScreenshot();
  console.log("[ios-stage0] screenshot captured:", screenshotBase64.length, "bytes (base64)");

  const pageSource = await driver.getPageSource();
  console.log("[ios-stage0] accessibility tree captured:", pageSource.length, "chars");

  // XCUITest's tap extension, not UiAutomator2's `mobile: clickGesture`.
  await driver.execute("mobile: tap", { x: 200, y: 400 });
  console.log("[ios-stage0] tap injected");

  await driver.deleteSession();
  console.log("[ios-stage0] milestone complete");
}

stage0().catch((err) => {
  console.error("[ios-stage0] failed:", err);
  process.exit(1);
});
