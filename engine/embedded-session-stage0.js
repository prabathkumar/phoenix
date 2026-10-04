/**
 * The same Stage 0 milestone as stage0-session.js (session start ->
 * screenshot -> accessibility tree -> tap -> teardown), run through
 * embedded-session.js's in-process driver instead of a spawned `appium`
 * server + webdriverio client.
 *
 * Run this INSTEAD of the Appium-server + stage0-session.js pair — it
 * needs no `appium` server running (skip that terminal tab entirely),
 * only the emulator/device itself. It exercises the exact same four
 * steps as proof that the embedded path is a real, working replacement,
 * not just an isolated code path.
 *
 * Run: TESTOPS_MOBILE_STAGE0_APP_PATH=/path/to/app.apk node engine/embedded-session-stage0.js
 */

const { startEmbeddedSession } = require("./embedded-session");

async function main() {
  console.log("[embedded-stage0] starting in-process session (no appium server)...");
  const driver = await startEmbeddedSession();
  console.log("[embedded-stage0] session started:", driver.sessionId);

  const screenshotBase64 = await driver.getScreenshot();
  console.log("[embedded-stage0] screenshot captured:", screenshotBase64.length, "bytes (base64)");

  const pageSource = await driver.getPageSource();
  console.log("[embedded-stage0] accessibility tree captured:", pageSource.length, "chars");

  // Same command Stage 0's spawned-server path settled on
  // (mobile: clickGesture) — here called directly as the driver's own
  // method rather than through an execute-script round trip.
  await driver.mobileClickGesture(undefined, 200, 400);
  console.log("[embedded-stage0] tap injected");

  await driver.deleteSession();
  console.log("[embedded-stage0] milestone complete (no separate appium process was ever started)");
}

main().catch((err) => {
  console.error("[embedded-stage0] failed:", err);
  process.exit(1);
});
