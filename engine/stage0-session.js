/**
 * Stage 0 milestone script.
 *
 * Goal (per docs/PHOENIX_SPEC.md §4.1): one clean session, end to end —
 * launch an app on an Android emulator, take a screenshot, read the
 * accessibility tree, inject a tap. Nothing else. This is the equivalent
 * of Strata's first lexer -> parser -> AST pass: proof the pipe works
 * before building anything on top of it.
 *
 * Once this runs reliably against a local emulator, the actual Appium
 * fork work starts: vendor appium-uiautomator2-driver and
 * appium-xcuitest-driver into this directory, strip what Phoenix
 * doesn't need, and replace these raw calls with the fork's internals.
 */

const { remote } = require("webdriverio");

const STAGE0_CAPABILITIES = {
  platformName: "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "emulator-5554", // local Android emulator, not BrowserStack
  "appium:app": process.env.PHOENIX_STAGE0_APP_PATH, // path to a .apk on disk
};

async function stage0() {
  const driver = await remote({
    hostname: "127.0.0.1",
    port: 4723,
    path: "/",
    capabilities: STAGE0_CAPABILITIES,
  });

  console.log("[stage0] session started:", driver.sessionId);

  const screenshotBase64 = await driver.takeScreenshot();
  console.log("[stage0] screenshot captured:", screenshotBase64.length, "bytes (base64)");

  const pageSource = await driver.getPageSource();
  console.log("[stage0] accessibility tree captured:", pageSource.length, "chars");

  // Naive tap at a fixed point, purely to prove the command round-trips.
  // Real element resolution belongs in capture/ once this milestone passes.
  //
  // NOTE: WebdriverIO's touchAction()/touchPerform() sends the legacy
  // JSONWP touch-actions endpoint, which Appium 3 + uiautomator2-driver 3.x
  // no longer implement (404 unknown command). The current UiAutomator2
  // driver exposes taps via the `mobile: clickGesture` execute-script
  // extension instead, so Phoenix uses that going forward.
  await driver.execute("mobile: clickGesture", { x: 200, y: 400 });
  console.log("[stage0] tap injected");

  await driver.deleteSession();
  console.log("[stage0] milestone complete");
}

stage0().catch((err) => {
  console.error("[stage0] failed:", err);
  process.exit(1);
});
