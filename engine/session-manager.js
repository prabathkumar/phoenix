/**
 * Orchestration for live recording sessions — start an Appium session,
 * wire it to live-view + the recorder, and hand back what's generated
 * when the tester stops. This is `run-session.js`'s original `main()`,
 * factored out so it can be *called on demand* (once per uploaded app,
 * via the /api/sessions endpoint in frontend/server.js) instead of
 * running exactly once at process boot.
 *
 * `run-session.js` still exists as the boot-once CLI entry point for
 * the original env-var-configured workflow (docs/SETUP.md, CI,
 * test-client.js) — it now just calls startRecordingSession() with no
 * app override, so both paths share one implementation.
 *
 * Concurrency: how many recording sessions can run at once is governed
 * by `session-pool.js`'s `SessionPool` (capacity via
 * `TESTOPS_MOBILE_SESSION_POOL_SIZE`, default **1** — unchanged default
 * behavior from before this pool existed). Each session gets its own
 * live-view port, allocated by the pool so two concurrent sessions
 * never collide on the same WebSocket port. A `startRecordingSession()`
 * call while the pool is already at capacity throws (same shape as the
 * old single-session guard) rather than silently colliding with an
 * existing session — callers (the upload endpoint) turn that into a
 * 409 for the tester.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { generateScript } = require("../generation/pipeline");
const { SessionRecorder } = require("../capture/recorder");
const { startLiveView } = require("../live-view/server");
const { SessionPool } = require("./session-pool");

const OUTPUT_DIR = path.join(__dirname, "..", "generated");

// One pool per process, created at module load so its slot/port
// bookkeeping persists across calls. Reads TESTOPS_MOBILE_SESSION_POOL_SIZE /
// TESTOPS_MOBILE_LIVE_VIEW_PORT at that point (same timing env vars are read
// everywhere else in this file's call sites) -- a test that needs a
// different capacity sets the env var before requiring this module
// fresh (see engine/test/session-manager.test.js and
// engine/test/session-pool.test.js).
const pool = new SessionPool();

function isSessionActive() {
  return !pool.hasCapacity();
}

/** Current pool occupancy, for callers (e.g. a status endpoint) that want more than a boolean. */
function getPoolStatus() {
  return { capacity: pool.capacity, active: pool.size() };
}

/**
 * Exposes an active session's driver + platform to callers outside the
 * guided-recording flow — specifically, an experimental semantic-
 * action endpoint (frontend/semantic-action-endpoint.js) that lets a
 * caller run engine/semantic-act-executor.js's executeSemanticAction()
 * against a session a tester is already recording, instead of
 * requiring its own separate session. Deliberately read-only: nothing
 * about the guided path's own lifecycle (recorder, live-view, "stop"
 * handling above) changes based on whether this is ever called.
 *
 * @param {string} [sessionId] - which session to fetch. When the pool
 *   holds more than one active session, this is required to disambiguate
 *   (omitting it returns null rather than guessing). When exactly one
 *   session is active, omitting it returns that one, matching this
 *   function's original single-session behavior.
 * @returns {{platform: string, driver: import('webdriverio').Browser}|null}
 */
function getActiveSession(sessionId) {
  if (sessionId) {
    const slot = pool.get(sessionId);
    return slot ? { platform: slot.platform, driver: slot.driver } : null;
  }
  const slots = pool.list();
  if (slots.length !== 1) return null; // none, or ambiguous with >1 — caller must pass sessionId
  return { platform: slots[0].platform, driver: slots[0].driver };
}

/** All active sessions' id/platform/port, for a caller that wants to list them (e.g. a future multi-session UI). */
function listActiveSessions() {
  return pool.list().map((slot) => ({ sessionId: slot.sessionKey, platform: slot.platform, port: slot.port }));
}

/**
 * @param {object} [options]
 * @param {"android"|"ios"} [options.platform] - defaults to
 *   TESTOPS_MOBILE_PLATFORM env var, then "android" — same default chain
 *   run-session.js always used.
 * @param {object} [options.capabilityOverrides] - passed straight
 *   through to engine/session.js or engine/ios-session.js's
 *   startSession(); this is how an uploaded app's path/bs:// URL
 *   replaces the env-var-configured one for just this session, without
 *   touching process.env (which a concurrent request could race on).
 * @param {number} [options.liveViewPort] - explicit port override
 *   (mainly for tests). Defaults to the pool's own allocator, which
 *   hands out the next free port starting at TESTOPS_MOBILE_LIVE_VIEW_PORT
 *   (default 8090) not already held by another concurrent session.
 * @param {boolean} [options.useLlm] - defaults to TESTOPS_MOBILE_USE_LLM=1.
 * @returns {Promise<{ platform: string, port: number, sessionId: string }>}
 */
async function startRecordingSession(options = {}) {
  // Reserve a slot BEFORE awaiting anything -- two concurrent calls
  // arriving a tick apart (two testers uploading at nearly the same
  // moment) must not both pass the capacity check and then both start
  // real Appium sessions. The slot is keyed by a temporary id until the
  // real driver.sessionId is known, then rekeyed (see below).
  const reservationKey = `pending-${crypto.randomUUID()}`;
  const platform = options.platform === "ios" ? "ios" : (options.platform === "android" ? "android" : (process.env.TESTOPS_MOBILE_PLATFORM === "ios" ? "ios" : "android"));
  const liveViewPort = options.liveViewPort || pool.allocatePort();

  // SessionPool.acquire() throws SessionPoolFullError (message includes
  // "full"/"capacity") when there's no room -- let it propagate as-is,
  // same contract the old `throw new Error(...)` here always had.
  pool.acquire(reservationKey, { port: liveViewPort, platform, driver: null, wss: null });

  let driver;
  try {
    const { startSession } = require(platform === "ios" ? "./ios-session" : "./session");
    const useLlm = options.useLlm !== undefined ? options.useLlm : process.env.TESTOPS_MOBILE_USE_LLM === "1";

    console.log(`[session-manager] starting Appium session (platform: ${platform}, port: ${liveViewPort})...`);
    driver = await startSession(options.capabilityOverrides);
    console.log("[session-manager] session started:", driver.sessionId);

    const recorder = new SessionRecorder(driver);
    const wss = startLiveView(driver, recorder, liveViewPort, platform);

    pool.update(reservationKey, { driver, wss });
    pool.rekey(reservationKey, driver.sessionId);
    const sessionKey = driver.sessionId;

    wss.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "stop") return;

        // Let live-view's own handler run first (clears its poll timer,
        // calls recorder.finish()) before we read recorder.steps.
        setImmediate(async () => {
          try {
            await finishSession({ sessionKey, steps: recorder.steps, driver, wss, socket, platform, useLlm });
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
  } catch (err) {
    // Starting the real session (or wiring live-view) failed after the
    // slot was reserved -- release it so a failed attempt doesn't
    // permanently eat a pool slot.
    pool.release(reservationKey);
    throw err;
  }
}

async function finishSession({ sessionKey, steps, driver, wss, socket, platform, useLlm }) {
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
  pool.release(sessionKey);
  console.log("[session-manager] done");
}

module.exports = { startRecordingSession, isSessionActive, getActiveSession, listActiveSessions, getPoolStatus };
