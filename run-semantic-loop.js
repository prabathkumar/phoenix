/**
 * Standalone CLI entry point for proving engine/semantic-loop.js's
 * runAutonomousLoop() against a REAL session — the Phase 3 counterpart
 * to run-semantic-action.js, same shape and same env vars
 * (PHOENIX_PLATFORM/PHOENIX_APPIUM_PROVIDER/app path, see
 * docs/SETUP.md). Everything in engine/semantic-loop.js is unit-tested
 * against fakes only; this is what actually runs it.
 *
 * Per docs/PHOENIX_SPEC.md §6, Phase 3 is R&D-only and not customer-
 * facing until proven — point this at one of Phoenix's own messiest
 * internal apps (logins, OTP, payment flows) before anything else, and
 * expect it to stop early and often; that's the loop's safety valve
 * working as intended, not a bug to work around.
 *
 * Does NOT touch run-session.js, engine/session-manager.js, the upload
 * flow, or the experimental /api/semantic-action endpoint — it starts
 * its own plain session directly, runs the loop, prints the full step
 * log, and tears down. Nothing else is affected by running this.
 *
 * Usage:
 *   node run-semantic-loop.js "log in and reach the account settings screen"
 *   node run-semantic-loop.js "log in" --max-steps 5
 */

const { runAutonomousLoop } = require("./engine/semantic-loop");

function parseArgs(argv) {
  const goal = argv[0];
  let maxSteps;

  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--max-steps") {
      maxSteps = Number(argv[i + 1]);
      i += 1;
    }
  }

  return { goal, maxSteps };
}

async function main() {
  const { goal, maxSteps } = parseArgs(process.argv.slice(2));

  if (!goal) {
    console.error('Usage: node run-semantic-loop.js "<goal>" [--max-steps <n>]');
    console.error('Example: node run-semantic-loop.js "log in and reach the account settings screen"');
    process.exit(1);
  }

  const platform = process.env.PHOENIX_PLATFORM === "ios" ? "ios" : "android";
  const { startSession } = require(platform === "ios" ? "./engine/ios-session" : "./engine/session");

  console.log(`[run-semantic-loop] starting Appium session (platform: ${platform})...`);
  const driver = await startSession();
  console.log("[run-semantic-loop] session started:", driver.sessionId);

  try {
    console.log(`[run-semantic-loop] goal: "${goal}"`);
    const result = await runAutonomousLoop(driver, goal, { platform, maxSteps });

    console.log(`[run-semantic-loop] stopped because: ${result.stoppedBecause}`);
    if (result.reason) console.log(`[run-semantic-loop] reason: ${result.reason}`);
    console.log(`[run-semantic-loop] ${result.steps.length} step(s) completed:`);
    result.steps.forEach((step, i) => {
      const actionDesc = step.kind === "type" ? `${step.instruction} (typed: "${step.text}")` : step.instruction;
      console.log(`  ${i + 1}. ${actionDesc}`);
      console.log(`     selector: ${JSON.stringify(step.selector)}`);
      console.log(`     result:   ${step.diffSummary}`);
    });
  } finally {
    console.log("[run-semantic-loop] tearing down session...");
    await driver.deleteSession();
    console.log("[run-semantic-loop] done");
  }
}

main().catch((err) => {
  console.error("[run-semantic-loop] failed:", err);
  process.exit(1);
});
