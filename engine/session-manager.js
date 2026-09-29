/**
 * Orchestration for a single live recording session — start an Appium
 * session, wire it to live-view + the recorder, and hand back what's
 * generated when the tester stops. This is `run-session.js`'s original
 * `main()`, factored out so it can be *called on demand* (once per
 * uploaded app, via the /api/sessions endpoint in frontend/server.js)
 * instead of running exactly once at process boot.
 *
 * `run-session.js` still exists as the boot-once CLI entry point for
 * the original env-var-configured workflow (docs/SETUP.md, CI,
 * test-client.js) — it now just calls startRecordingSession() with no
 * app override, so both paths share one implementation.
 *
 * Only one recording session runs at a time (see docs/SETUP.md and
 * README's upload-flow section for why: today's live-view server binds
 * a single port and capture/recorder.js assumes one driver). A second
 * startRecordingSession() call while one is active throws rather than
 * silently colliding with it — callers (the upload endpoint) turn that
 * into a 409 for the tester.
 */

const fs = require("fs");
const path = require("path");

const { generateScript } = require("../generation/pipeline");
const { SessionRecorder } = require("../capture/recorder");
const { startLiveView } = require("../live-view/server");

const OUTPUT_DIR = path.join(__dirname, "..", "generated");

/** @type {{ platform: string, driver: import('webdriverio').Browser, wss: import('ws').WebSocketServer } | null} */
let active = null;

function isSessionActive() {
  return active !== null;
}

/**
 * Exposes the active session's driver + platform to callers outside
 * the guided-recording flow — specifically, an experimental semantic-
 * action endpoint (frontend/semantic-action-endpoint.js) that lets a
 * caller run engine/semantic-act-executor.js's executeSemanticAction()
 * against whatever session a tester is already recording, instead of
 * requiring its own separate session. Deliberately read-only: nothing
 * about the guided path's own lifecycle (recorder, live-view, "stop"
 * handling above) changes based on whether this is ever called.
 *
 * @returns {{platform: string, driver: import('webdriverio').Browser}|null}
 */
function getActiveSession() {
  if (!active) return null;
  return { platform: active.platform, driver: active.driver };
}

/**
 * @param {object} [options]
 * @param {"android"|"ios"} [options.platform] - defaults to
 *   PHOENIX_PLATFORM env var, then "android" — same default chain
 *   run-session.js always used.
 * @param {object} [options.capabilityOverrides] - passed straight
 *   through to engine/session.js or engine/ios-session.js's
 *   startSession(); this is how an uploaded app's path/bs:// URL
 *   replaces the env-var-configured one for just this session, without
 *   touching process.env (which a concurrent request could race on).
 * @param {number} [options.liveViewPort] - defaults to
 *   PHOENIX_LIVE_VIEW_PORT env var, then 8090.
 * @param {boolean} [options.useLlm] - defaults to PHOENIX_USE_LLM=1.
 * @returns {Promise<{ platform: string, port: number, sessionId: string }>}
 */
async function startRecordingSession(options = {}) {
  if (active) {
    throw new Error(
      "A recording session is already active (sessionId: " +
        active.driver.sessionId +
        "). Stop it before starting another — Phoenix supports one " +
        "concurrent session today."
    );
  }

  const platform = options.platform === "ios" ? "ios" : (options.platform === "android" ? "android" : (process.env.PHOENIX_PLATFORM === "ios" ? "ios" : "android"));
  const { startSession } = require(platform === "ios" ? "./ios-session" : "./session");
  const liveViewPort = options.liveViewPort || Number(process.env.PHOENIX_LIVE_VIEW_PORT) || 8090;
  const useLlm = options.useLlm !== undefined ? options.useLlm : process.env.PHOENIX_USE_LLM === "1";

  console.log(`[session-manager] starting Appium session (platform: ${platform})...`);
  const driver = await startSession(options.capabilityOverrides);
  console.log("[session-manager] session started:", driver.sessionId);

  const recorder = new SessionRecorder(driver);
  const wss = startLiveView(driver, recorder, liveViewPort, platform);

  active = { platform, driver, wss };

  wss.on("connection", (socket) => {
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "stop") return;

      // Let live-view's own handler run first (clears its poll timer,
      // calls recorder.finish()) before we read recorder.steps.
      setImmediate(async () => {
        try {
          await finishSession({ steps: recorder.steps, driver, wss, socket, platform, useLlm });
        } catch (err) {
          console.error("[session-manager] failed to finish session:", err);
          try {
            socket.send(JSON.stringify({ type: "generation-failed", message: err.message }));
          } catch (_sendErr) {
            // socket may already be gone — nothing more useful to do
          }
        }
      });
    });
  });

  return { platform, port: liveViewPort, sessionId: driver.sessionId };
}

async function finishSession({ steps, driver, wss, socket, platform, useLlm }) {
  console.log(`[session-manager] session finished: ${steps.length} step(s) recorded`);

  const result = await generateScript(steps, { useLlm, platform });
  console.log(`[session-manager] generated script: "${result.testName}" (${result.assertions.length} assertion(s), ${result.parameters.length} parameter(s))`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${result.testName}.test.js`);
  fs.writeFileSync(outputPath, result.scriptSource, "utf8");
  console.log("[session-manager] wrote", outputPath);

  // Send the result back to whoever was recording (the frontend, or
  // test-client.js) before tearing down, so it can be shown/downloaded
  // without reading the filesystem directly.
  socket.send(JSON.stringify({
    type: "script-generated",
    testName: result.testName,
    scriptSource: result.scriptSource,
    assertionCount: result.assertions.length,
    parameterCount: result.parameters.length,
  }));

  await driver.deleteSession();
  wss.close();
  active = null;
  console.log("[session-manager] done");
}

module.exports = { startRecordingSession, isSessionActive, getActiveSession };
