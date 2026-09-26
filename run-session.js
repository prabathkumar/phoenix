/**
 * Wires engine/ + capture/ + live-view/ + generation/ into one live,
 * end-to-end recording session — the actual product loop, not each
 * stage tested in isolation the way stage0-session.js and the
 * capture/generation test suites do.
 *
 * Flow:
 *   1. Start a real Appium session against the local emulator (engine/).
 *   2. Start the live-view WebSocket server against that session,
 *      wired to a SessionRecorder (capture/).
 *   3. A tester's browser (or, for now, live-view/test-client.js
 *      simulating one) connects, taps forward through the socket, and
 *      each tap is captured with a resolved locator.
 *   4. On "stop", the captured steps are handed to generation/, and the
 *      resulting script is written to generated/<test-name>.test.js.
 *
 * Run this, then in another terminal run:
 *   node live-view/test-client.js
 * to simulate a tester recording a flow, and watch a real script land
 * in generated/.
 */

const fs = require("fs");
const path = require("path");

const { startSession } = require("./engine/session");
const { SessionRecorder } = require("./capture/recorder");
const { startLiveView } = require("./live-view/server");
const { generateScript } = require("./generation/pipeline");

const LIVE_VIEW_PORT = Number(process.env.PHOENIX_LIVE_VIEW_PORT) || 8090;
const OUTPUT_DIR = path.join(__dirname, "generated");

async function main() {
  console.log("[run-session] starting Appium session...");
  const driver = await startSession();
  console.log("[run-session] session started:", driver.sessionId);

  const recorder = new SessionRecorder(driver);
  const wss = startLiveView(driver, recorder, LIVE_VIEW_PORT);

  // startLiveView's own "stop" handling clears the screenshot poll timer
  // and calls recorder.finish(), but generation + file output is
  // orchestration-level, not live-view's job — so we listen for the same
  // event here rather than have live-view depend on generation/.
  wss.on("connection", (socket) => {
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "stop") return;

      // Let live-view's own handler run first (clears its poll timer,
      // calls recorder.finish()) before we read recorder.steps.
      setImmediate(async () => {
        try {
          await onSessionFinished(recorder.steps, driver, wss);
        } catch (err) {
          console.error("[run-session] failed to finish session:", err);
        }
      });
    });
  });

  console.log(`[run-session] waiting for a tester to connect and record on ws://localhost:${LIVE_VIEW_PORT}`);
  console.log("[run-session] (run `node live-view/test-client.js` in another terminal to simulate one)");
}

async function onSessionFinished(steps, driver, wss) {
  console.log(`[run-session] session finished: ${steps.length} step(s) recorded`);

  const result = await generateScript(steps);
  console.log(`[run-session] generated script: "${result.testName}" (${result.assertions.length} assertion(s), ${result.parameters.length} parameter(s))`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${result.testName}.test.js`);
  fs.writeFileSync(outputPath, result.scriptSource, "utf8");
  console.log("[run-session] wrote", outputPath);

  await driver.deleteSession();
  wss.close();
  console.log("[run-session] done");
}

main().catch((err) => {
  console.error("[run-session] failed:", err);
  process.exit(1);
});
