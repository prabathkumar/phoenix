/**
 * Simulates a tester's browser driving a recording session through
 * live-view/server.js's WebSocket protocol — until TestOps has a real
 * front-end for this, this is how the end-to-end path (live-view ->
 * capture -> generation) gets exercised against a real device instead
 * of just unit-tested in isolation.
 *
 * Default flow, against ApiDemos (the same app Stage 0 uses): tap
 * "Views" on the home screen, wait for the transition, tap the first
 * row of the Views submenu, then stop. Two real, sequential taps across
 * two different screens — proves step-chaining, not just a single tap.
 *
 * Override via TESTOPS_MOBILE_TAP_SEQUENCE, a JSON array of {xRatio, yRatio}
 * (and optional typedValue to send a "type" message after that tap),
 * to record a different flow without editing this file, e.g.:
 *   TESTOPS_MOBILE_TAP_SEQUENCE='[{"xRatio":0.5,"yRatio":0.14}]' node live-view/test-client.js
 *
 * Run: node live-view/test-client.js   (with run-session.js already running)
 */

const WebSocket = require("ws");

const PORT = Number(process.env.TESTOPS_MOBILE_LIVE_VIEW_PORT) || 8090;
const SETTLE_MS = Number(process.env.TESTOPS_MOBILE_TAP_SETTLE_MS) || 1200; // time for a screen transition to finish before the next tap

const DEFAULT_SEQUENCE = [
  { xRatio: 0.5, yRatio: 0.732 }, // "Views" row, ApiDemos home screen
  { xRatio: 0.5, yRatio: 0.14 }, // first row of the Views submenu
];

const sequence = process.env.TESTOPS_MOBILE_TAP_SEQUENCE
  ? JSON.parse(process.env.TESTOPS_MOBILE_TAP_SEQUENCE)
  : DEFAULT_SEQUENCE;

const socket = new WebSocket(`ws://localhost:${PORT}`);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sawFirstFrame = false;
let nextTapIndex = 0;
let sending = false;

async function sendNextTap() {
  if (sending || nextTapIndex >= sequence.length) return;
  sending = true;

  const step = sequence[nextTapIndex];
  console.log(`[test-client] tap ${nextTapIndex + 1}/${sequence.length}: (${step.xRatio}, ${step.yRatio})`);
  socket.send(JSON.stringify({ type: "tap", xRatio: step.xRatio, yRatio: step.yRatio }));
}

socket.on("open", () => {
  console.log("[test-client] connected, waiting for a frame before tapping...");
});

socket.on("message", async (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === "frame" && !sawFirstFrame) {
    sawFirstFrame = true;
    await sendNextTap();
  }

  if (message.type === "step-recorded") {
    const step = sequence[nextTapIndex];
    nextTapIndex += 1;

    if (step.typedValue) {
      console.log(`[test-client] step ${message.stepIndex} recorded, typing "${step.typedValue}"...`);
      socket.send(JSON.stringify({ type: "type", value: step.typedValue }));
      return; // wait for "text-entered" before moving on
    }

    await afterStep(message.stepIndex);
  }

  if (message.type === "text-entered") {
    await afterStep(message.stepIndex);
  }

  if (message.type === "session-finished") {
    console.log(`[test-client] session finished: ${message.stepCount} step(s). Waiting for the generated script...`);
  }

  if (message.type === "script-generated") {
    console.log(`[test-client] generated "${message.testName}" (${message.assertionCount} assertion(s), ${message.parameterCount} parameter(s)). Also written to generated/.`);
    socket.close();
  }

  if (message.type === "generation-failed") {
    console.error("[test-client] generation failed:", message.message);
    socket.close();
    process.exit(1);
  }
});

async function afterStep(stepIndex) {
  sending = false;

  if (nextTapIndex < sequence.length) {
    console.log(`[test-client] step ${stepIndex} done, waiting ${SETTLE_MS}ms for the screen to settle...`);
    await wait(SETTLE_MS);
    await sendNextTap();
  } else {
    console.log(`[test-client] step ${stepIndex} done, sequence complete, stopping session...`);
    await wait(500);
    socket.send(JSON.stringify({ type: "stop" }));
  }
}

socket.on("error", (err) => {
  console.error("[test-client] error:", err.message);
  console.error("[test-client] is run-session.js running?");
  process.exit(1);
});
