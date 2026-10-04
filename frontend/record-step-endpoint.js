/**
 * POST /api/record-step -- the first half of the "Record this step"
 * manual fallback (docs/TESTOPS_WORKFLOW_UX.md's Act 1 fallback,
 * surfaced inline on a failed test-case step). When a step fails to
 * resolve, TestOps's own session is still open (test-case-runner.js
 * never calls deleteSession() on a failure, same discipline as
 * execute-test-case-endpoint.js) -- this endpoint attaches to that SAME
 * live session and starts a live-view instance against it, so the
 * tester sees the real, currently-failing screen (not a fresh app
 * launch) and can tap the real element themselves.
 *
 * This is deliberately thin: every piece it wires together already
 * exists and is independently proven --
 *   - engine/attach-session.js: attach to TestOps's already-open session
 *     (the real bug found and fixed 2026-10-04 on real hardware)
 *   - capture/recorder.js's SessionRecorder: resolves a tap coordinate
 *     against the real accessibility tree into {strategy, value, ...} --
 *     the EXACT shape a test-case step's resolvedSelector already uses
 *     (see generation/pipeline.js's buildSelector())
 *   - live-view/server.js's startLiveView(): already session-agnostic,
 *     its own header comment says "against the same Appium session
 *     TestOps already started" -- built for exactly this
 * No new engine/capture/live-view logic -- this file is HTTP plumbing
 * over all three.
 *
 * Gated behind TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1, off by default,
 * same pattern as the other TestOps integration surfaces -- brand new,
 * never yet exercised against a real TestOps call or real hardware.
 *
 * Request body (JSON):
 *   {
 *     "sessionId": "abc123",          // required -- the SAME session id
 *                                     // that just failed a step
 *     "platform": "android" | "ios",  // required
 *     "hubUrl": { "hostname": ..., "port": ..., "path": ... }  // optional
 *   }
 *
 * Response (JSON):
 *   success: { success: true, recordingId: "...", port: 54321 }
 *     -- the caller connects a WebSocket to ws://<this-host>:<port> and
 *     speaks the same protocol live-view/server.js always has
 *     ({type:"tap",xRatio,yRatio}, {type:"stop"}, etc. -- see
 *     frontend/index.html for a reference client). Each "step-recorded"
 *     event now includes resolvedElement (see live-view/server.js's
 *     comment on that field) so the UI can show the tester what their
 *     tap resolved to immediately.
 *   failure: { success: false, error: "..." }
 *
 * The underlying session is NEVER closed here -- same rule as
 * execute-test-case-endpoint.js, it's TestOps's session to end, not
 * ours. Call POST /api/record-step/:recordingId/stop (see
 * apply-recorded-step-endpoint.js) when the tester is done, which stops
 * ONLY the live-view WebSocket server, not the underlying device
 * session itself.
 */

const crypto = require("crypto");
const { attachSession } = require("../engine/attach-session");
const { SessionRecorder } = require("../capture/recorder");
const { startLiveView } = require("../live-view/server");
const { recordings, pruneStale } = require("./recording-registry");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleRecordStep(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    respondJson(res, 400, { success: false, error: err.message });
    return;
  }

  const { sessionId, platform, hubUrl = {} } = body;

  if (!sessionId) {
    respondJson(res, 400, { success: false, error: "sessionId is required (the session that just failed a step)" });
    return;
  }
  if (platform !== "android" && platform !== "ios") {
    respondJson(res, 400, { success: false, error: 'platform must be "android" or "ios"' });
    return;
  }

  pruneStale();

  try {
    const driver = await attachSession({
      sessionId,
      hostname: hubUrl.hostname,
      port: hubUrl.port,
      path: hubUrl.path,
    });

    const recorder = new SessionRecorder(driver);
    // port 0 -- let the OS pick a free port so concurrent "Record this
    // step" sessions (different testers, different failures) never
    // collide on a fixed port the way run-session.js's single-session
    // CLI usage safely can (it only ever runs one at a time).
    const wss = startLiveView(driver, recorder, 0, platform);
    await new Promise((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const port = wss.address().port;

    const recordingId = crypto.randomUUID();
    recordings.set(recordingId, { wss, recorder, driver, platform, sessionId, createdAt: Date.now() });

    respondJson(res, 200, { success: true, recordingId, port });
  } catch (err) {
    respondJson(res, 200, { success: false, error: err.message });
  }
}

module.exports = { handleRecordStep };
