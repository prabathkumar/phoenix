/**
 * Tests for the two typed-input edge cases fixed in server.js's "type"
 * handler:
 *   1. Typing before any tap has been recorded used to silently call
 *      driver.keys() and drop the value (nothing to attach it to).
 *   2. Retyping into the same field used to just append to whatever was
 *      already on the device, since driver.keys() sends the full current
 *      value each time (see frontend/index.html's submitType()) — the
 *      on-device text and the recorded step.typedValue would diverge.
 *
 * Runs against a real WebSocketServer (on an ephemeral port) with a fake
 * Appium driver and a minimal fake recorder, so no emulator/simulator is
 * needed — same synthetic-fixture approach as generation/test/pipeline.test.js.
 *
 * Run with: npm test (from live-view/) or `node test/server.test.js`
 */

const assert = require("assert");
const WebSocket = require("ws");
const { startLiveView } = require("../server");

function makeFakeDriver() {
  return {
    keysCalls: [],
    async takeScreenshot() {
      return "ZmFrZS1zY3JlZW5zaG90"; // "fake-screenshot" base64, content unused by these tests
    },
    async getWindowSize() {
      return { width: 1080, height: 2400 };
    },
    async keys(value) {
      this.keysCalls.push(value);
    },
    executeCalls: [],
    async execute(script, args) {
      this.executeCalls.push([script, args]);
      return null;
    },
    activeElementId: "elem-active-1",
    async getActiveElement() {
      // A real WDA response when nothing is keyboard-focused: {} with no
      // element key (or, in the bug this models, an error-shaped body
      // that resolves rather than throws) -- confirmed live by tapping a
      // non-editable Settings row and trying to type into it.
      if (this.activeElementId === null) return {};
      return { "element-6066-11e4-a52e-4f735466cecf": this.activeElementId };
    },
    elementClearCalls: [],
    async elementClear(elementId) {
      this.elementClearCalls.push(elementId);
    },
    elementSendKeysCalls: [],
    async elementSendKeys(elementId, text) {
      this.elementSendKeysCalls.push([elementId, text]);
    },
  };
}

function makeFakeRecorder() {
  return {
    steps: [],
    beginStepCalls: [],
    async beginStep(tapCoordinate, tapRatio) {
      this.beginStepCalls.push([tapCoordinate, tapRatio]);
      return { tapCoordinate, tapRatio };
    },
    async completeStep(partialStep) {
      const step = { ...partialStep, resolvedElement: { strategy: "coordinate", value: "0,0" } };
      this.steps.push(step);
      return step;
    },
    async recordScroll(direction, perform) {
      await perform();
      const step = { kind: "scroll", direction };
      this.steps.push(step);
      return step;
    },
    finish() {
      return this.steps;
    },
  };
}

/** Connects a ws client, waits for open, and returns it. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Resolves with the next parsed message of the given type from a socket. */
function nextMessageOfType(socket, type) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) {
        socket.off("message", handler);
        resolve(message);
      }
    };
    socket.on("message", handler);
  });
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  console.log("live-view/server:");

  await testAsync("typing before any tap is recorded rejects the keystroke instead of dropping it", async () => {
    const driver = makeFakeDriver();
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port);
    try {
      const socket = await connect(port);
      const errorPromise = nextMessageOfType(socket, "type-error");
      socket.send(JSON.stringify({ type: "type", value: "too-soon" }));
      const error = await errorPromise;

      assert.strictEqual(error.reason, "no-step-yet");
      assert.strictEqual(driver.keysCalls.length, 0, "driver.keys() must not be called with no recorded step");
      assert.strictEqual(recorder.steps.length, 0);
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("a tap passes its original xRatio/yRatio through to the recorder, not just the scaled device pixels", async () => {
    // capture/recorder.js's CapturedStep.tapRatio doc comment explains why:
    // it's what lets generation/pipeline.js re-scale a coordinate-fallback
    // tap against a DIFFERENT replay device's screen size, instead of
    // baking in this (recording) device's absolute pixels. If this ratio
    // stops reaching the recorder, that fix silently goes dead even though
    // nothing here would fail loudly -- it would just quietly fall back to
    // the fragile, device-specific pixel path again.
    const driver = makeFakeDriver();
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port);
    try {
      const socket = await connect(port);
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.25, yRatio: 0.75 }));
      await stepRecorded;

      assert.strictEqual(recorder.beginStepCalls.length, 1);
      const [deviceCoordinate, tapRatio] = recorder.beginStepCalls[0];
      // driver.getWindowSize() fakes {width: 1080, height: 2400} above.
      assert.deepStrictEqual(deviceCoordinate, { x: 270, y: 1800 });
      assert.deepStrictEqual(tapRatio, { xRatio: 0.25, yRatio: 0.75 });
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("typing after a tap attaches the value to the most recent step", async () => {
    const driver = makeFakeDriver();
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port);
    try {
      const socket = await connect(port);
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      await stepRecorded;

      const textEntered = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "prabath@example.com" }));
      await textEntered;

      assert.strictEqual(recorder.steps[0].typedValue, "prabath@example.com");
      assert.deepStrictEqual(driver.keysCalls, ["prabath@example.com"]);
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("retyping into the same field clears the previous value with backspaces before sending the new one", async () => {
    const driver = makeFakeDriver();
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port);
    try {
      const socket = await connect(port);
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      await stepRecorded;

      const firstEntry = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "foo" }));
      await firstEntry;

      const secondEntry = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "foobar" }));
      await secondEntry;

      // 3 backspaces (one per character of "foo") sent before the new
      // value, so the on-device field ends up as "foobar" -- not
      // "foofoobar" -- matching the recorded typedValue.
      assert.deepStrictEqual(driver.keysCalls, [
        "foo",
        ["", "", ""],
        "foobar",
      ]);
      assert.strictEqual(recorder.steps[0].typedValue, "foobar");
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("iOS platform types via elementSendKeys on the active element, avoiding both broken WDA paths", async () => {
    // Confirmed live against a real Simulator: driver.keys() fails with
    // WDA's "Key Down action ... must have a closing Key Up successor",
    // and the first fix attempt (`mobile: type`) failed too, with a
    // separate "405 Method is not implemented" — this xcuitest-driver
    // build doesn't expose that extension. elementSendKeys/elementClear
    // against the active element is the fix that actually lands: an
    // older, non-actions WebDriver endpoint XCUITest does implement.
    const driver = makeFakeDriver();
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port, "ios");
    try {
      const socket = await connect(port);
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      await stepRecorded;

      const firstEntry = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "foo" }));
      await firstEntry;

      const secondEntry = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "foobar" }));
      await secondEntry;

      assert.strictEqual(driver.keysCalls.length, 0, "iOS typing must not call driver.keys() (WDA rejects its key actions)");
      assert.strictEqual(
        driver.executeCalls.filter(([script]) => script === "mobile: type").length,
        0,
        "iOS typing must not use mobile: type (not implemented on this xcuitest-driver build)"
      );
      // First "type" (no prior value) clears nothing; second one clears
      // the field before sending the corrected text.
      assert.deepStrictEqual(driver.elementClearCalls, [driver.activeElementId]);
      assert.deepStrictEqual(driver.elementSendKeysCalls, [
        [driver.activeElementId, "foo"],
        [driver.activeElementId, "foobar"],
      ]);
      assert.strictEqual(recorder.steps[0].typedValue, "foobar");
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("iOS typing into an unfocused field reports an error instead of crashing the session", async () => {
    // Regression test for a real crash found on a live Simulator: tapping
    // a non-editable Settings row (no on-screen keyboard came up) left
    // nothing keyboard-focused, so getActiveElement() resolved with no
    // usable element id -- and elementSendKeys(undefined, ...) then threw
    // "Malformed type for elementId parameter", taking down the whole
    // run-session.js process over one bad keystroke.
    const driver = makeFakeDriver();
    driver.activeElementId = null; // nothing focused, as WDA reported live
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port, "ios");
    try {
      const socket = await connect(port);
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      await stepRecorded;

      const errorPromise = nextMessageOfType(socket, "type-error");
      socket.send(JSON.stringify({ type: "type", value: "test" }));
      const error = await errorPromise;

      assert.strictEqual(error.reason, "no-active-element");
      assert.strictEqual(driver.elementSendKeysCalls.length, 0, "must not call elementSendKeys with no resolvable element");
      assert.strictEqual(driver.elementClearCalls.length, 0);
      assert.strictEqual(recorder.steps[0].typedValue, undefined, "typedValue must not be set when typing failed");
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("android taps use W3C pointer actions (not mobile: clickGesture) when the driver supports performActions", async () => {
    const driver = makeFakeDriver();
    driver.performCalls = [];
    driver.performActions = async (a) => { driver.performCalls.push(a); };
    driver.releaseActions = async () => {};
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port, "android");
    try {
      const socket = await connect(port);
      const recorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.25 }));
      await recorded;
      assert.strictEqual(driver.performCalls.length, 1);
      const moveAction = driver.performCalls[0][0].actions[0];
      assert.deepStrictEqual([moveAction.x, moveAction.y], [540, 600]);
      assert.strictEqual(driver.executeCalls.filter(([s]) => s === "mobile: clickGesture").length, 0);
      socket.close();
    } finally {
      wss.close();
    }
  });

  await testAsync("a tap-injection failure (e.g. an unsupported mobile command) reports an error instead of crashing the whole server", async () => {
    // Regression test for a real crash found 2026-10-04 on the first
    // real-device validation of the "Record this step" fallback:
    // BrowserStack rejected "mobile: clickGesture" with "unknown
    // command" (this device/driver build's supported-commands list had
    // no plain tap/click gesture at all) -- and since the WebSocket
    // message handler had no try/catch, that rejection was a genuinely
    // unhandled rejection inside an async handler, which crashed the
    // ENTIRE Node process. Not just this one recording -- every session
    // the frontend server was managing, including Act 1's own
    // already-shipped recording flow (same driver.execute(tapExtension)
    // call, same exposure). The fix wraps the whole handler so any
    // failure here becomes a clean per-tap "action-error" event.
    const driver = makeFakeDriver();
    driver.execute = async () => {
      throw new Error('unknown command: Unknown mobile command "clickGesture". Only shell,dragGesture,... commands are supported.');
    };
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port);
    try {
      const socket = await connect(port);
      const errorPromise = nextMessageOfType(socket, "action-error");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      const error = await errorPromise;

      assert.match(error.message, /clickGesture/);
      assert.strictEqual(recorder.steps.length, 0, "a failed tap must not be recorded as a completed step");

      // The process (and this WebSocket server) must still be alive --
      // a second, successful tap after the failed one proves the
      // connection and the server survived rather than having crashed.
      driver.execute = async () => null;
      const stepRecorded = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.3, yRatio: 0.3 }));
      await stepRecorded;
      assert.strictEqual(recorder.steps.length, 1);

      socket.close();
    } finally {
      wss.close();
    }
  });

  async function withLiveView(platform, driverSetup, body) {
    const driver = makeFakeDriver();
    if (driverSetup) driverSetup(driver);
    const recorder = makeFakeRecorder();
    const port = 18090 + Math.floor(Math.random() * 1000);
    const wss = startLiveView(driver, recorder, port, platform);
    try {
      const socket = await connect(port);
      await body({ driver, recorder, socket });
      socket.close();
    } finally {
      wss.close();
    }
  }

  await testAsync("android scroll 'down' swipes the finger UP with mobile: swipeGesture, and is recorded as a scroll step", async () => {
    await withLiveView("android", null, async ({ driver, recorder, socket }) => {
      const done = nextMessageOfType(socket, "scroll-recorded");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      const evt = await done;
      assert.strictEqual(evt.direction, "down");
      assert.strictEqual(evt.stepIndex, 0);
      const [script, args] = driver.executeCalls.find(([s]) => s === "mobile: swipeGesture");
      assert.strictEqual(script, "mobile: swipeGesture");
      assert.strictEqual(args.direction, "up", "content scrolls down when the finger swipes up");
      assert.deepStrictEqual(recorder.steps.map((s) => [s.kind, s.direction]), [["scroll", "down"]]);
    });
  });

  await testAsync("android scroll falls back to W3C pointer actions when swipeGesture is unsupported", async () => {
    await withLiveView("android", (d) => {
      d.execute = async () => { throw new Error('Unknown mobile command "swipeGesture"'); };
      d.performCalls = [];
      d.performActions = async (a) => { d.performCalls.push(a); };
    }, async ({ driver, socket }) => {
      const done = nextMessageOfType(socket, "scroll-recorded");
      socket.send(JSON.stringify({ type: "scroll", direction: "up" }));
      await done;
      const acts = driver.performCalls[0][0].actions;
      const move = acts.find((a) => a.type === "pointerMove" && a.duration === 400);
      assert.ok(move.y > acts[0].y, "scrolling up = finger swipes DOWN, so the end y is below the start y");
    });
  });

  await testAsync("iOS scroll uses mobile: dragFromToForDuration", async () => {
    await withLiveView("ios", null, async ({ driver, socket }) => {
      const done = nextMessageOfType(socket, "scroll-recorded");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      await done;
      const [script, args] = driver.executeCalls.find(([s]) => s === "mobile: dragFromToForDuration");
      assert.strictEqual(script, "mobile: dragFromToForDuration");
      assert.ok(args.toY < args.fromY, "finger moves up to scroll content down");
    });
  });

  await testAsync("an invalid scroll direction, or a device-side failure, reports action-error and records nothing", async () => {
    await withLiveView("android", null, async ({ driver, recorder, socket }) => {
      let err = nextMessageOfType(socket, "action-error");
      socket.send(JSON.stringify({ type: "scroll", direction: "sideways" }));
      assert.match((await err).message, /unknown scroll direction/);
      driver.execute = async () => { throw new Error("device gone"); };
      err = nextMessageOfType(socket, "action-error");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      assert.match((await err).message, /device gone/);
      assert.strictEqual(recorder.steps.length, 0, "a failed scroll must not be recorded as a step");
    });
  });

  await testAsync("typed text attaches to the last TAP step even after scrolls, never to a scroll step (real bug: values were silently dropped from the script)", async () => {
    await withLiveView("android", null, async ({ recorder, socket }) => {
      let ev = nextMessageOfType(socket, "step-recorded");
      socket.send(JSON.stringify({ type: "tap", xRatio: 0.5, yRatio: 0.5 }));
      await ev;
      ev = nextMessageOfType(socket, "scroll-recorded");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      await ev;
      const typed = nextMessageOfType(socket, "text-entered");
      socket.send(JSON.stringify({ type: "type", value: "hello" }));
      await typed;
      assert.strictEqual(recorder.steps[0].typedValue, "hello", "attached to the tap step");
      assert.strictEqual(recorder.steps[1].typedValue, undefined, "NOT attached to the scroll step");
    });
  });

  await testAsync("typing when only scrolls have been recorded is rejected with a clear message (nothing to attach it to)", async () => {
    await withLiveView("android", null, async ({ recorder, socket }) => {
      const ev = nextMessageOfType(socket, "scroll-recorded");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      await ev;
      const err = nextMessageOfType(socket, "type-error");
      socket.send(JSON.stringify({ type: "type", value: "x" }));
      assert.match((await err).message, /Tap a field/);
      assert.strictEqual(recorder.steps[0].typedValue, undefined);
    });
  });

  await testAsync("Stop sent right after two slow scrolls still waits for BOTH to be recorded (real run lost them: 0 steps)", async () => {
    await withLiveView("android", null, async ({ recorder, socket }) => {
      const slowScroll = recorder.recordScroll.bind(recorder);
      recorder.recordScroll = async (direction, perform) => {
        await new Promise((r) => setTimeout(r, 120)); // a slow BrowserStack capture
        return slowScroll(direction, perform);
      };
      const finished = nextMessageOfType(socket, "session-finished");
      socket.send(JSON.stringify({ type: "scroll", direction: "down" }));
      socket.send(JSON.stringify({ type: "scroll", direction: "up" }));
      socket.send(JSON.stringify({ type: "stop" }));
      const evt = await finished;
      assert.strictEqual(evt.stepCount, 2, "both scrolls must be recorded before the session finishes");
      assert.deepStrictEqual(recorder.steps.map((s) => s.direction), ["down", "up"], "actions run in arrival order");
    });
  });

  if (process.exitCode) {
    console.error("\nlive-view/server tests FAILED");
    process.exit(1);
  } else {
    console.log("\nlive-view/server tests passed");
  }
}

main();
