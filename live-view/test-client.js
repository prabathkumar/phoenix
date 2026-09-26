/**
 * Simulates a tester's browser driving a recording session through
 * live-view/server.js's WebSocket protocol — until TestOps has a real
 * front-end for this, this is how the end-to-end path (live-view ->
 * capture -> generation) gets exercised against a real device instead
 * of just unit-tested in isolation.
 *
 * Defaults to tapping the "Accessibility" row on ApiDemos' home screen
 * (the same app Stage 0 uses) at its known position ratio, then stops
 * the session. Override PHOENIX_TAP_X_RATIO / PHOENIX_TAP_Y_RATIO to
 * tap somewhere else once you're recording a different app/screen.
 *
 * Run: node live-view/test-client.js   (with run-session.js already running)
 */

const WebSocket = require("ws");

const PORT = Number(process.env.PHOENIX_LIVE_VIEW_PORT) || 8090;
const TAP_X_RATIO = Number(process.env.PHOENIX_TAP_X_RATIO) || 0.46; // "Accessibility" row, ApiDemos home screen
const TAP_Y_RATIO = Number(process.env.PHOENIX_TAP_Y_RATIO) || 0.19;

const socket = new WebSocket(`ws://localhost:${PORT}`);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

socket.on("open", async () => {
  console.log("[test-client] connected, waiting for a frame before tapping...");
});

let tapped = false;

socket.on("message", async (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === "frame" && !tapped) {
    tapped = true;
    console.log("[test-client] got a frame, sending a tap...");
    socket.send(JSON.stringify({ type: "tap", xRatio: TAP_X_RATIO, yRatio: TAP_Y_RATIO }));
  }

  if (message.type === "step-recorded") {
    console.log(`[test-client] step ${message.stepIndex} recorded, stopping session in 1s...`);
    await wait(1000);
    socket.send(JSON.stringify({ type: "stop" }));
  }

  if (message.type === "session-finished") {
    console.log(`[test-client] session finished: ${message.stepCount} step(s). Check generated/ for the script.`);
    socket.close();
  }
});

socket.on("error", (err) => {
  console.error("[test-client] error:", err.message);
  console.error("[test-client] is run-session.js running?");
  process.exit(1);
});
