/**
 * Standalone CLI entry point for proving engine/semantic-act-executor.js
 * against a REAL session — Android emulator/device, iOS Simulator, or
 * BrowserStack, same PHOENIX_APPIUM_PROVIDER/PHOENIX_PLATFORM env vars
 * every other entry point here uses (see docs/SETUP.md). Everything
 * upstream of this file (semantic-snapshot.js, semantic-act.js,
 * semantic-diff.js, semantic-act-executor.js) is unit-tested against
 * fakes only — this is the first thing that actually runs it against a
 * live device, mirroring what run-session.js already does for the
 * guided-recording path.
 *
 * This does NOT touch run-session.js, engine/session-manager.js, or the
 * frontend upload flow — it starts its own plain session via
 * engine/session.js or engine/ios-session.js directly (no live-view, no
 * recorder, no script generation), runs exactly one semantic action,
 * prints the result, and tears down. Nothing shipping Friday's guided-
 * recording path is affected by running (or not running) this.
 *
 * Usage:
 *   node run-semantic-action.js "tap the Login button"
 *   node run-semantic-action.js "type into the username field" --type "prabath@example.com"
 *
 * Same app/provider env vars as run-session.js:
 *   PHOENIX_PLATFORM=android|ios (default android)
 *   PHOENIX_APPIUM_PROVIDER=local|browserstack (default local)
 *   PHOENIX_STAGE0_APP_PATH / PHOENIX_IOS_APP_PATH / PHOENIX_IOS_BUNDLE_ID
 *     (local provider) or PHOENIX_BROWSERSTACK_APP_URL (browserstack
 *     provider) — see remote-provider.js / docs/SETUP.md.
 */

const { executeSemanticAction } = require("./engine/semantic-act-executor");

function parseArgs(argv) {
  const instruction = argv[0];
  let kind = "tap";
  let text;

  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--type") {
      kind = "type";
      text = argv[i + 1];
      i += 1;
    }
  }

  return { instruction, kind, text };
}

async function main() {
  const { instruction, kind, text } = parseArgs(process.argv.slice(2));

  if (!instruction) {
    console.error('Usage: node run-semantic-action.js "<instruction>" [--type "<text>"]');
    console.error('Example: node run-semantic-action.js "tap the Login button"');
    process.exit(1);
  }
  if (kind === "type" && !text) {
    console.error('--type requires a value, e.g. --type "prabath@example.com"');
    process.exit(1);
  }

  const platform = process.env.PHOENIX_PLATFORM === "ios" ? "ios" : "android";
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");

  console.log(`[run-semantic-action] starting Appium session (platform: ${platform})...`);
  const driver = await startSession();
  console.log("[run-semantic-action] session started:", driver.sessionId);

  try {
    console.log(`[run-semantic-action] instruction: "${instruction}"${kind === "type" ? ` (typing: "${text}")` : ""}`);
    const result = await executeSemanticAction(driver, instruction, { kind, text, platform });

    if (result.success) {
      console.log("[run-semantic-action] SUCCESS");
      console.log("  selector:", JSON.stringify(result.selector));
      console.log("  what changed:", result.diffSummary || "(couldn't read the screen after acting)");
    } else {
      console.log("[run-semantic-action] NOT RESOLVED / FAILED");
      console.log("  reason:", result.reason);
    }
  } finally {
    console.log("[run-semantic-action] tearing down session...");
    await driver.deleteSession();
    console.log("[run-semantic-action] done");
  }
}

main().catch((err) => {
  console.error("[run-semantic-action] failed:", err);
  process.exit(1);
});
