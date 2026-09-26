/**
 * Live view server (docs/PHOENIX_SPEC.md §4.1).
 *
 * Two responsibilities, both against the same Appium session TestOps
 * already started:
 *  1. Poll a screenshot on an interval and push it to the connected
 *     TestOps client over WebSocket, so the tester sees a live mirror
 *     of the device with no local app installed.
 *  2. Receive click events from that same client, translate the click's
 *     pixel position (relative to the rendered image) into real device
 *     coordinates, and forward them to capture/recorder.js, which
 *     begins/completes a step and injects the tap via the session.
 *
 * This file is intentionally thin — it is transport plumbing, not
 * where element resolution or generation happens.
 */

const { WebSocketServer } = require("ws");

const SCREENSHOT_POLL_INTERVAL_MS = 300;

/**
 * @param {import('webdriverio').Browser} driver - the live Appium session
 * @param {import('../capture/recorder').SessionRecorder} recorder
 * @param {number} port
 */
function startLiveView(driver, recorder, port = 8090) {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (socket) => {
    const pollTimer = setInterval(async () => {
      try {
        const screenshotBase64 = await driver.takeScreenshot();
        socket.send(JSON.stringify({ type: "frame", screenshotBase64 }));
      } catch (err) {
        console.error("[live-view] screenshot poll failed:", err.message);
      }
    }, SCREENSHOT_POLL_INTERVAL_MS);

    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === "tap") {
        // message.xRatio / yRatio are 0..1, relative to the rendered
        // image size on the tester's screen — not device pixels.
        const deviceCoordinate = await toDeviceCoordinate(message.xRatio, message.yRatio, driver);

        const partialStep = await recorder.beginStep(deviceCoordinate);
        // NOTE: WebdriverIO's touchAction()/touchPerform() sends the legacy
        // JSONWP touch-actions endpoint, which Appium 3 + uiautomator2-driver
        // 3.x no longer implement (404 unknown command — see Stage 0 fix in
        // engine/stage0-session.js). Use the execute-script extension the
        // current driver actually supports.
        await driver.execute("mobile: clickGesture", deviceCoordinate);
        const step = await recorder.completeStep(partialStep);

        socket.send(JSON.stringify({ type: "step-recorded", stepIndex: recorder.steps.length - 1 }));
      }

      if (message.type === "stop") {
        clearInterval(pollTimer);
        const steps = recorder.finish();
        socket.send(JSON.stringify({ type: "session-finished", stepCount: steps.length }));
      }
    });

    socket.on("close", () => clearInterval(pollTimer));
  });

  console.log(`[live-view] listening on ws://localhost:${port}`);
  return wss;
}

// Cached per driver instance so we don't hit the WebDriver endpoint on
// every single tap — device screen size doesn't change mid-session.
const windowSizeCache = new WeakMap();

/**
 * Converts a tap expressed as a 0..1 ratio of the rendered image on the
 * tester's screen into real device pixel coordinates, using the actual
 * device window size (not the image's own dimensions, which may be
 * scaled or letterboxed differently than the physical screen).
 */
async function toDeviceCoordinate(xRatio, yRatio, driver) {
  let size = windowSizeCache.get(driver);
  if (!size) {
    size = await driver.getWindowSize();
    windowSizeCache.set(driver, size);
  }
  return {
    x: Math.round(xRatio * size.width),
    y: Math.round(yRatio * size.height),
  };
}

module.exports = { startLiveView };
