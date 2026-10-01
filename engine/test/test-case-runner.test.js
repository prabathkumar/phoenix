/**
 * Tests for engine/test-case-runner.js -- the generalization of
 * run-batch-executions.js's original, hardcoded `login-script` mode
 * into a data-driven one: a test case is a JSON file of steps (see
 * test-cases/login.json), run through the same per-instruction
 * resolver (executeSemanticAction, faked here) every other execution
 * path already uses. No real Appium/BrowserStack session -- a small
 * in-memory fake driver and a fake executeSemanticAction stand in.
 *
 * Run with: node --test engine/test/test-case-runner.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadTestCaseSteps,
  resolveStepText,
  resolveSteps,
  requiredEnvVars,
  runScriptSteps,
} = require("../test-case-runner");

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function writeTempJson(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-test-case-")), "case.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return file;
}

(async () => {
  await run("loadTestCaseSteps accepts a bare array of steps", async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap X" }]);
    const steps = loadTestCaseSteps(file);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].instruction, "tap X");
  });

  await run("loadTestCaseSteps accepts an object with a top-level \"steps\" array (the real test-cases/login.json shape)", async () => {
    const file = writeTempJson({ name: "demo", steps: [{ kind: "tap", instruction: "tap X" }] });
    const steps = loadTestCaseSteps(file);
    assert.strictEqual(steps.length, 1);
  });

  await run("loadTestCaseSteps rejects invalid JSON with a clear, file-naming error", async () => {
    const file = writeTempJson("{ not valid json");
    assert.throws(() => loadTestCaseSteps(file), /not valid JSON/);
  });

  await run("loadTestCaseSteps rejects a step with an invalid kind", async () => {
    const file = writeTempJson([{ kind: "swipe", instruction: "do something" }]);
    assert.throws(() => loadTestCaseSteps(file), /invalid "kind"/);
  });

  await run("loadTestCaseSteps accepts a \"scroll\" step with no text", async () => {
    const file = writeTempJson([{ kind: "scroll", instruction: "scroll down to find the Logout button" }]);
    const steps = loadTestCaseSteps(file);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].kind, "scroll");
  });

  await run("loadTestCaseSteps rejects a \"type\" step with no text", async () => {
    const file = writeTempJson([{ kind: "type", instruction: "type into X" }]);
    assert.throws(() => loadTestCaseSteps(file), /is a "type" step but has no "text"/);
  });

  await run("the real test-cases/login.json loads cleanly and matches the proven 7-step sequence", async () => {
    const steps = loadTestCaseSteps(path.join(__dirname, "..", "..", "test-cases", "login.json"));
    assert.deepStrictEqual(
      steps.map((s) => s.instruction),
      [
        "tap the Allow button to dismiss a system permission dialog",
        "tap the LOGIN button on the home screen to open the login form",
        "type the phone number into the phone/account number field",
        "tap the PASSWORD tab to switch the form into password-entry mode",
        "tap the password field to focus it",
        "type the password into the password field",
        "tap the LOGIN button to submit the login form",
      ]
    );
    assert.strictEqual(steps[0].optional, true);
  });

  await run("resolveStepText returns a literal text string unchanged", async () => {
    assert.strictEqual(resolveStepText({ kind: "type", text: "hello" }), "hello");
  });

  await run("resolveStepText returns undefined for a step with no text (a tap step)", async () => {
    assert.strictEqual(resolveStepText({ kind: "tap" }), undefined);
  });

  await run("resolveStepText resolves an \"${ENV_VAR}\" placeholder from process.env", async () => {
    process.env.PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR = "resolved-value";
    try {
      assert.strictEqual(
        resolveStepText({ kind: "type", text: "${PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR}" }),
        "resolved-value"
      );
    } finally {
      delete process.env.PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR;
    }
  });

  await run("resolveStepText throws a clear error when the referenced env var isn't set", async () => {
    delete process.env.PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR;
    assert.throws(
      () => resolveStepText({ kind: "type", text: "${PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR}" }),
      /PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR.*not set/
    );
  });

  await run("resolveStepText does NOT partially interpolate -- a non-exact placeholder is treated as a literal string", async () => {
    // Deliberate: partial interpolation (e.g. "prefix-${VAR}") would
    // invite committing a half-redacted credential into a test-case
    // JSON file in the repo. Only a whole-string "${VAR}" counts.
    assert.strictEqual(resolveStepText({ kind: "type", text: "prefix-${ANYTHING}-suffix" }), "prefix-${ANYTHING}-suffix");
  });

  await run("requiredEnvVars lists every distinct placeholder referenced across all steps, de-duplicated", async () => {
    const steps = [
      { kind: "type", text: "${A}" },
      { kind: "type", text: "${B}" },
      { kind: "type", text: "${A}" },
      { kind: "tap" },
      { kind: "type", text: "literal" },
    ];
    assert.deepStrictEqual(requiredEnvVars(steps).sort(), ["A", "B"]);
  });

  await run("resolveSteps resolves every step's text up front, returning literal values (no more placeholders)", async () => {
    process.env.PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR = "typed-value";
    try {
      const resolved = resolveSteps([
        { kind: "tap", instruction: "tap X" },
        { kind: "type", instruction: "type Y", text: "${PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR}" },
      ]);
      assert.strictEqual(resolved[1].text, "typed-value");
      assert.strictEqual(resolved[0].text, undefined);
    } finally {
      delete process.env.PHOENIX_TEST_CASE_RUNNER_FIXTURE_VAR;
    }
  });

  await run("runScriptSteps runs steps in order, passing each one's resolved text through to executeSemanticAction", async () => {
    const calls = [];
    const fakeDriver = {};
    const steps = [
      { kind: "tap", instruction: "tap A" },
      { kind: "type", instruction: "type B", text: "literal-text" },
    ];
    const result = await runScriptSteps(fakeDriver, steps, {
      platform: "android",
      executeSemanticAction: async (driver, instruction, options) => {
        calls.push({ driver, instruction, options });
        return { success: true, diffSummary: `did: ${instruction}` };
      },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.detail, "did: type B");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].driver, fakeDriver);
    assert.strictEqual(calls[1].options.text, "literal-text");
    assert.strictEqual(calls[1].options.platform, "android");
  });

  await run("runScriptSteps skips an optional step that fails to resolve, without stopping the run", async () => {
    const result = await runScriptSteps(
      {},
      [
        { kind: "tap", instruction: "optional dialog", optional: true },
        { kind: "tap", instruction: "real step" },
      ],
      {
        platform: "android",
        executeSemanticAction: async (driver, instruction) =>
          instruction === "optional dialog"
            ? { success: false, reason: "no confident match" }
            : { success: true, diffSummary: "done" },
      }
    );
    assert.strictEqual(result.success, true);
  });

  await run("runScriptSteps stops and reports failure on the first non-optional step that fails, without running later steps", async () => {
    const calls = [];
    const result = await runScriptSteps(
      {},
      [
        { kind: "tap", instruction: "required step" },
        { kind: "tap", instruction: "should never run" },
      ],
      {
        platform: "android",
        executeSemanticAction: async (driver, instruction) => {
          calls.push(instruction);
          return { success: false, reason: "resolved element is no longer on screen" };
        },
      }
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.detail.includes("required step"));
    assert.ok(result.detail.includes("resolved element is no longer on screen"));
    assert.deepStrictEqual(calls, ["required step"]);
  });

  await run("runScriptSteps performs a \"wait\" step as a pure pause -- no call to executeSemanticAction, default duration when none given", async () => {
    const sleepCalls = [];
    const executeCalls = [];
    const result = await runScriptSteps(
      {},
      [
        { kind: "tap", instruction: "tap LOGIN to submit" },
        { kind: "wait", instruction: "wait for the notification dialog to appear" },
        { kind: "tap", instruction: "tap the Allow button" },
      ],
      {
        platform: "android",
        executeSemanticAction: async (driver, instruction) => {
          executeCalls.push(instruction);
          return { success: true, diffSummary: `did: ${instruction}` };
        },
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      }
    );
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(sleepCalls, [3000]);
    assert.deepStrictEqual(executeCalls, ["tap LOGIN to submit", "tap the Allow button"]);
  });

  await run("runScriptSteps honors a \"wait\" step's own durationMs instead of the default", async () => {
    const sleepCalls = [];
    await runScriptSteps(
      {},
      [{ kind: "wait", instruction: "wait a custom amount", durationMs: 500 }],
      {
        platform: "android",
        executeSemanticAction: async () => ({ success: true }),
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      }
    );
    assert.deepStrictEqual(sleepCalls, [500]);
  });

  await run("loadTestCaseSteps accepts a \"wait\" step with no text", async () => {
    const file = writeTempJson([{ kind: "wait", instruction: "wait for the login submission to settle", durationMs: 3000 }]);
    const steps = loadTestCaseSteps(file);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].kind, "wait");
  });

  if (process.exitCode) {
    console.error("\nengine/test-case-runner tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/test-case-runner tests passed");
  }
})();
