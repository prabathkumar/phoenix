/**
 * Boot-once CLI entry point for the original env-var-configured
 * workflow (docs/SETUP.md, CI, live-view/test-client.js): starts one
 * recording session against whatever TESTOPS_MOBILE_STAGE0_APP_PATH /
 * TESTOPS_MOBILE_IOS_APP_PATH / TESTOPS_MOBILE_BROWSERSTACK_APP_URL already point at,
 * then waits for a tester to connect and record.
 *
 * The actual session/live-view/recorder/generation wiring now lives in
 * engine/session-manager.js's startRecordingSession(), shared with the
 * on-demand path (a tester uploading an app through frontend/index.html,
 * handled by frontend/server.js's POST /api/sessions) — see README's
 * "Uploading an app directly" section for how the two relate.
 */

const { startRecordingSession } = require("./engine/session-manager");

async function main() {
  const { platform, port } = await startRecordingSession();
  console.log(`[run-session] waiting for a tester to connect and record on ws://localhost:${port}`);
  console.log(`[run-session] open frontend/index.html (served via frontend/server.js) to record as a real tester would,`);
  console.log("[run-session] or run `node live-view/test-client.js` in another terminal to simulate one.");
  console.log(`[run-session] platform: ${platform}`);
}

main().catch((err) => {
  console.error("[run-session] failed:", err);
  process.exit(1);
});
