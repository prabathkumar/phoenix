#!/usr/bin/env node
/**
 * Manual real-hardware validation harness for the "Record this step"
 * fallback (frontend/record-step-endpoint.js + apply-recorded-step-
 * endpoint.js) -- built and unit-tested, never yet run against a real
 * BrowserStack session. This script is the smallest real thing that
 * proves it: start a recording against a real (already-failed) session,
 * let a human pick where to tap by looking at a real screenshot, send
 * the real tap, show what it resolved to, and optionally write it into
 * a real test-cases/*.json file.
 *
 * Lives in live-view/ (not scripts/) so `require("ws")` resolves via
 * live-view/node_modules without needing a root package.json.
 *
 * PREREQUISITES (same ones already proven real-device/real-session, see
 * docs/STATUS.md's "TestOps integration contract" section):
 *   1. frontend/server.js running with BOTH:
 *        TESTOPS_MOBILE_ENABLE_EXECUTE_API=1
 *        TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1
 *      (cd frontend && TESTOPS_MOBILE_ENABLE_EXECUTE_API=1 TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1 node server.js)
 *   2. A REAL BrowserStack session already started (same as every real
 *      run earlier in this engagement) and a step already failed on it
 *      via POST /api/execute-test-case -- that call never tears the
 *      session down on failure, so it's still sitting on the real
 *      failing screen when this script attaches to it.
 *
 * Usage:
 *   node live-view/validate-record-step.js \
 *     --frontend-url http://localhost:8091 \
 *     --session-id <the real sessionId that just failed a step> \
 *     --platform android \
 *     --test-case-file addons.json \
 *     --step-index 20
 *
 * What it does, step by step:
 *   1. POST /api/record-step {sessionId, platform} -> {recordingId, port}
 *   2. Connects a WebSocket to ws://<frontend host>:<port>
 *   3. Saves the first real screenshot frame to
 *      live-view/validate-record-step-frame.png and asks you to open it
 *   4. Prompts for xRatio,yRatio (0..1 fractions of that image's width/
 *      height -- e.g. "0.5,0.82" for dead center, near the bottom) --
 *      look at the saved screenshot to pick where the element you want
 *      actually is
 *   5. Sends the real tap, shows exactly what resolvedElement it
 *      produced (the real {strategy, value, ...} from
 *      capture/recorder.js's resolveElementAtCoordinate against the
 *      real accessibility tree)
 *   6. Asks: apply it to --test-case-file / --step-index, retry with a
 *      different tap, or just stop without writing anything
 *
 * This is a one-off validation tool, not a product UI -- TestOps's real
 * "Record this step" button will drive the same two endpoints from a
 * proper live mirrored-screen click, not a human guessing a ratio from
 * a saved PNG. This script exists purely to prove the wiring is real
 * before that UI gets built.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const frontendUrl = args["frontend-url"] || "http://localhost:8091";
  const sessionId = args["session-id"];
  const platform = args.platform || "android";
  const testCaseFile = args["test-case-file"];
  const stepIndex = args["step-index"] !== undefined ? Number(args["step-index"]) : undefined;

  if (!sessionId) {
    console.error('Missing --session-id. Pass the REAL sessionId that just failed a step via /api/execute-test-case.');
    process.exit(1);
  }

  console.log(`[validate] POST ${frontendUrl}/api/record-step  { sessionId: "${sessionId}", platform: "${platform}" }`);
  const start = await postJson(`${frontendUrl}/api/record-step`, { sessionId, platform });
  if (!start.json.success) {
    console.error(`[validate] /api/record-step failed: ${start.json.error}`);
    process.exit(1);
  }
  const { recordingId, port } = start.json;
  console.log(`[validate] recordingId=${recordingId} port=${port}`);

  const wsHost = new URL(frontendUrl).hostname;
  const ws = new WebSocket(`ws://${wsHost}:${port}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let sawFirstFrame = false;

  await new Promise((resolve, reject) => {
    ws.on("open", () => console.log("[validate] WebSocket connected, waiting for first frame..."));
    ws.on("error", reject);

    ws.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === "frame" && !sawFirstFrame) {
        sawFirstFrame = true;
        const framePath = path.join(__dirname, "validate-record-step-frame.png");
        fs.writeFileSync(framePath, Buffer.from(message.screenshotBase64, "base64"));
        console.log(`[validate] real screenshot saved to ${framePath} -- open it and find your target element.`);
        await tapLoop();
      }

      if (message.type === "step-recorded") {
        console.log("[validate] step-recorded -- resolvedElement:");
        console.log(JSON.stringify(message.resolvedElement, null, 2));
        const choice = await ask(rl, "\nApply this to the test case? [y]es / [r]etry a different tap / [n]o, just stop: ");
        if (choice.trim().toLowerCase() === "y") {
          if (!testCaseFile || stepIndex === undefined) {
            console.error("[validate] --test-case-file and --step-index are required to apply. Stopping without applying.");
          } else {
            console.log(`[validate] POST ${frontendUrl}/api/apply-recorded-step  { recordingId, testCaseFile: "${testCaseFile}", stepIndex: ${stepIndex} }`);
            const applied = await postJson(`${frontendUrl}/api/apply-recorded-step`, { recordingId, testCaseFile, stepIndex });
            console.log("[validate] result:", JSON.stringify(applied.json, null, 2));
          }
          await stopAndExit();
        } else if (choice.trim().toLowerCase() === "r") {
          await tapLoop();
        } else {
          await stopAndExit();
        }
      }

      if (message.type === "type-error") {
        console.error("[validate] type-error:", message.message);
      }
    });

    async function tapLoop() {
      const answer = await ask(rl, "Enter xRatio,yRatio to tap (e.g. 0.5,0.82), based on the saved screenshot: ");
      const [xRatio, yRatio] = answer.split(",").map((s) => Number(s.trim()));
      if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) {
        console.error('[validate] could not parse that as "x,y" -- try again.');
        await tapLoop();
        return;
      }
      console.log(`[validate] sending real tap at xRatio=${xRatio} yRatio=${yRatio}...`);
      ws.send(JSON.stringify({ type: "tap", xRatio, yRatio }));
    }

    async function stopAndExit() {
      ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
      await postJson(`${frontendUrl}/api/record-step/${recordingId}/stop`, {});
      rl.close();
      resolve();
    }
  });

  console.log("[validate] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[validate] fatal:", err);
  process.exit(1);
});
