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
 *   node run-semantic-action.js "tap the Login button" --visual   # fused text+screenshot resolution
 *
 * Same app/provider env vars as run-session.js:
 *   PHOENIX_PLATFORM=android|ios (default android)
 *   PHOENIX_APPIUM_PROVIDER=local|browserstack (default local)
 *   PHOENIX_STAGE0_APP_PATH / PHOENIX_IOS_APP_PATH / PHOENIX_IOS_BUNDLE_ID
 *     (local provider) or PHOENIX_BROWSERSTACK_APP_URL (browserstack
 *     provider) — see remote-provider.js / docs/SETUP.md.
 *
 * PHOENIX_STARTUP_DELAY_MS (default 5000): a freshly launched app is
 * typically still on a splash screen (a progress bar, no real controls
 * yet) the instant the session comes up. Found for real on this CLI's
 * first-ever run against a live BrowserStack session: it read the
 * screen immediately and correctly refused to guess ("every element is
 * a known non-clickable dead end") rather than tap something on the
 * my.yes.yes4g splash screen -- not a bug in the semantic layer, just
 * this CLI acting before the app had actually reached the target
 * screen. run-batch-executions.js already accounts for this
 * (STARTUP_DELAY_MS there); this CLI didn't, so it's the same fix here.
 */

const { executeSemanticAction } = require("./engine/semantic-act-executor");

const STARTUP_DELAY_MS = Number(process.env.PHOENIX_STARTUP_DELAY_MS) || 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const instruction = argv[0];
  let kind = "tap";
  let text;
  let useVisualGrounding = false;

  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--type") {
      kind = "type";
      text = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--visual") {
      useVisualGrounding = true;
    }
  }

  return { instruction, kind, text, useVisualGrounding };
}

async function main() {
  const { instruction, kind, text, useVisualGrounding } = parseArgs(process.argv.slice(2));

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
    console.log(`[run-semantic-action] waiting ${STARTUP_DELAY_MS}ms for the app to get past its splash screen (set PHOENIX_STARTUP_DELAY_MS to change)...`);
    await sleep(STARTUP_DELAY_MS);

    console.log(`[run-semantic-action] instruction: "${instruction}"${kind === "type" ? ` (typing: "${text}")` : ""}${useVisualGrounding ? " (fused text+screenshot resolution)" : ""}`);
    const result = await executeSemanticAction(driver, instruction, { kind, text, platform, useVisualGrounding });

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
