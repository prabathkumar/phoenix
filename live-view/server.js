/**
 * Live view server (docs/TESTOPS_MOBILE_SPEC.md §4.1).
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
 * @param {"android"|"ios"} [platform] - selects the tap-injection
 *   extension: UiAutomator2's `mobile: clickGesture` (Android, default)
 *   vs. XCUITest's `mobile: tap` (iOS) — see engine/ios-stage0-session.js.
 */
function startLiveView(driver, recorder, port = 8090, platform = "android") {
  const wss = new WebSocketServer({ port });
  const tapExtension = platform === "ios" ? "mobile: tap" : "mobile: clickGesture";

  wss.on("connection", (socket) => {
    // Guards against a screenshot request that was already in flight when
    // "stop" arrived: clearInterval() stops *future* ticks, but a promise
    // from a tick that already fired can still resolve afterwards, hit an
    // already-torn-down session, and log a scary (harmless) 404. This flag
    // makes that in-flight response a silent no-op instead.
    let stopped = false;

    const pollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        const screenshotBase64 = await driver.takeScreenshot();
        if (stopped) return;
        socket.send(JSON.stringify({ type: "frame", screenshotBase64 }));
      } catch (err) {
        if (!stopped) console.error("[live-view] screenshot poll failed:", err.message);
      }
    }, SCREENSHOT_POLL_INTERVAL_MS);

    socket.on("message", async (raw) => {
      try {
        await handleMessage(raw);
      } catch (err) {
        // REAL BUG, found 2026-10-04 on the first real-device validation
        // of the "Record this step" fallback: an uncaught rejection in
        // here (e.g. driver.execute(tapExtension, ...) throwing because
        // this specific device/driver build doesn't support the mobile
        // extension used -- confirmed live, BrowserStack rejected
        // "mobile: clickGesture" with "unknown command", listing a
        // supported-commands set with no plain tap/click gesture at
        // all) used to be a genuinely unhandled rejection inside an
        // async WebSocket message handler, which crashed the ENTIRE
        // Node process -- not just this one recording, every session
        // this frontend server was managing, including Act 1's
        // already-shipped recording flow (same tapExtension call, same
        // crash exposure). Catching it here turns a process-wide outage
        // into a clean per-tap error the client can show and recover
        // from, same spirit as the existing type-error handling below.
        console.error("[live-view] message handler failed:", err.message);
        try {
          socket.send(JSON.stringify({ type: "action-error", message: err.message }));
        } catch {
          // socket may already be closed -- nothing more to do
        }
      }
    });

    async function handleMessage(raw) {
      const message = JSON.parse(raw.toString());

      if (message.type === "tap") {
        // message.xRatio / yRatio are 0..1, relative to the rendered
        // image size on the tester's screen — not device pixels.
        const deviceCoordinate = await toDeviceCoordinate(message.xRatio, message.yRatio, driver);

        // Pass the ORIGINAL ratio through too, not just the device pixels
        // scaled from it -- capture/recorder.js's CapturedStep.tapRatio
        // doc comment explains why: it's what lets a coordinate-fallback
        // locator (no accessibility info at the tap point -- custom-drawn
        // Canvas/OpenGL content) replay correctly on a different device/
        // resolution than the one it was recorded on, instead of baking
        // in this device's absolute pixels as if they applied everywhere.
        const partialStep = await recorder.beginStep(deviceCoordinate, { xRatio: message.xRatio, yRatio: message.yRatio });
        // NOTE: WebdriverIO's touchAction()/touchPerform() sends the legacy
        // JSONWP touch-actions endpoint, which neither Appium 3 +
        // uiautomator2-driver 3.x nor xcuitest-driver implement (404 unknown
        // command — see Stage 0 fix in engine/stage0-session.js). Use each
        // platform's own execute-script tap extension instead.
        await injectTap(driver, platform, tapExtension, deviceCoordinate);
        const step = await recorder.completeStep(partialStep);

        // resolvedElement included so a UI can show the tester exactly
        // what their tap resolved to (e.g. a "Record this step" repair
        // flow displaying "resource-id: buyAddonLayout" immediately) --
        // purely additive, existing consumers (frontend/index.html,
        // live-view/test-client.js) only ever read .stepIndex off this
        // event and are unaffected by the extra field.
        socket.send(JSON.stringify({
          type: "step-recorded",
          stepIndex: recorder.steps.length - 1,
          resolvedElement: step.resolvedElement,
        }));
      }

      if (message.type === "type") {
        // Sends keystrokes to whatever element currently has focus — the
        // field the previous "tap" message just tapped. Attached to the
        // most recently recorded step so generation/pipeline.js's
        // extractParameters() can lift it into named test data.
        //
        // Two bugs fixed here (found while hardening capture edge cases):
        //
        // 1. Typing with no prior recorded step (recorder.steps.length ===
        //    0) used to silently call driver.keys() and then drop the
        //    value on the floor — nothing to attach it to, and the client
        //    got back stepIndex: -1 with no explanation. There's no tap
        //    coordinate to resolve a field from in this case, so instead
        //    of guessing we reject the keystroke outright and tell the
        //    tester why, rather than losing their input silently.
        if (recorder.steps.length === 0) {
          socket.send(JSON.stringify({
            type: "type-error",
            reason: "no-step-yet",
            message: "Tap a field before typing into it — there's no recorded step to attach this text to yet.",
          }));
          return;
        }

        const currentStep = recorder.steps[recorder.steps.length - 1];

        // 2. frontend/index.html's submitType() sends the FULL current
        //    value of the input box each time (not incremental
        //    keystrokes — see submitType()). driver.keys() just appends
        //    whatever it's given to the on-device field, so typing "foo"
        //    then correcting to "foobar" used to leave "foofoobar" on the
        //    device while step.typedValue recorded only the latest
        //    "foobar" — a real mismatch between the generated script's
        //    assumed value and what actually happened on hardware.
        //    Clearing out the previously-sent value first (one backspace
        //    per character) keeps the field's on-device state in sync
        //    with what we're about to record.
        // 3. driver.keys() drives XCUITest through W3C key actions
        //    (keyDown/keyUp pairs). WebDriverAgent on Appium 3 rejects
        //    those for plain character input — "Key Down action 's'
        //    must have a closing Key Up successor" — even though
        //    webdriverio built the pairs correctly; it's a WDA-side
        //    actions bug, not something fixable from this side.
        //
        //    First attempted fix was `mobile: type`, which bypasses the
        //    W3C actions endpoint — but this xcuitest-driver build
        //    doesn't implement that extension either ("405 Method is
        //    not implemented", confirmed live). Element Send Keys
        //    (`POST .../element/:id/value`, WebdriverIO's
        //    elementSendKeys) is a separate, older WebDriver endpoint
        //    that XCUITest does implement directly against WDA rather
        //    than through W3C actions, so it hits neither broken path.
        //    It targets a specific element rather than "whatever has
        //    focus", so the currently-focused field is looked up via
        //    the standard Get Active Element command first. Element
        //    Clear (`elementClear`) replaces the previous
        //    backspace-per-character approach for the same reason —
        //    it's the same non-actions endpoint family, and clearing a
        //    field outright is simpler and more reliable than counting
        //    backspaces. Android keeps the plain keys() path below
        //    since UiAutomator2 doesn't hit this bug.
        // 4. Get Active Element only resolves to something when XCUITest
        //    considers a field genuinely keyboard-focused (on-screen
        //    keyboard actually up). Tapping a non-editable row — a plain
        //    Settings cell, a disabled control — leaves nothing focused;
        //    confirmed live as WDA returning a "no such element" 404 for
        //    getActiveElement(), which this webdriver/appium version
        //    resolves as a value rather than throwing, so elementId came
        //    back undefined and elementSendKeys crashed the whole
        //    session instead of failing just this one keystroke. Treated
        //    the same way as the "no step yet" case above: tell the
        //    tester why and let the session keep running, rather than
        //    taking down `run-session.js` over one bad type attempt.
        if (platform === "ios") {
          let activeElement;
          try {
            activeElement = await driver.getActiveElement();
          } catch (err) {
            activeElement = null;
          }
          const elementId =
            activeElement &&
            (activeElement["element-6066-11e4-a52e-4f735466cecf"] || activeElement.ELEMENT);

          if (!elementId) {
            socket.send(JSON.stringify({
              type: "type-error",
              reason: "no-active-element",
              message: "No editable field is focused on the device — tap directly into a text field that brings up the on-screen keyboard, then try typing again.",
            }));
            return;
          }

          if (currentStep.typedValue) {
            await driver.elementClear(elementId);
          }
          await driver.elementSendKeys(elementId, message.value);
        } else {
          if (currentStep.typedValue) {
            const backspaces = Array(currentStep.typedValue.length).fill("");
            await driver.keys(backspaces);
          }
          await driver.keys(message.value);
        }
        currentStep.typedValue = message.value;
        socket.send(JSON.stringify({ type: "text-entered", stepIndex: recorder.steps.length - 1 }));
      }

      if (message.type === "stop") {
        stopped = true;
        clearInterval(pollTimer);
        const steps = recorder.finish();
        socket.send(JSON.stringify({ type: "session-finished", stepCount: steps.length }));
      }
    }

    socket.on("close", () => {
      stopped = true;
      clearInterval(pollTimer);
    });
  });

  console.log(`[live-view] listening on ws://localhost:${port}`);
  return wss;
}

/**
 * Android taps go through W3C pointer actions (driver.performActions), not
 * `mobile: clickGesture`: real BrowserStack Pixel 7 run (2026-10-04) rejected
 * clickGesture as "Unknown mobile command" -- its supported list has no plain
 * tap. W3C actions are the cross-driver standard, so they don't depend on
 * which mobile: extensions a given device-farm build exposes. Falls back to
 * the old execute-script path if performActions isn't available on the driver.
 * iOS keeps `mobile: tap` (proven on real hardware).
 */
async function injectTap(driver, platform, tapExtension, { x, y }) {
  if (platform !== "ios" && typeof driver.performActions === "function") {
    await driver.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x, y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 50 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    if (typeof driver.releaseActions === "function") await driver.releaseActions();
    return;
  }
  await driver.execute(tapExtension, { x, y });
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
