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
  persistResolvedSelectors,
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testops-mobile-test-case-")), "case.json");
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
    process.env.TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR = "resolved-value";
    try {
      assert.strictEqual(
        resolveStepText({ kind: "type", text: "${TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR}" }),
        "resolved-value"
      );
    } finally {
      delete process.env.TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR;
    }
  });

  await run("resolveStepText throws a clear error when the referenced env var isn't set", async () => {
    delete process.env.TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR;
    assert.throws(
      () => resolveStepText({ kind: "type", text: "${TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR}" }),
      /TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR.*not set/
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
    process.env.TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR = "typed-value";
    try {
      const resolved = resolveSteps([
        { kind: "tap", instruction: "tap X" },
        { kind: "type", instruction: "type Y", text: "${TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR}" },
      ]);
      assert.strictEqual(resolved[1].text, "typed-value");
      assert.strictEqual(resolved[0].text, undefined);
    } finally {
      delete process.env.TESTOPS_MOBILE_TEST_CASE_RUNNER_FIXTURE_VAR;
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

  await run("loadTestCaseSteps accepts a step with a valid resolvedSelector", async () => {
    const file = writeTempJson([
      { kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "accessibility-id", value: "Login" } },
    ]);
    const steps = loadTestCaseSteps(file);
    assert.deepStrictEqual(steps[0].resolvedSelector, { strategy: "accessibility-id", value: "Login" });
  });

  await run("loadTestCaseSteps rejects a step with a malformed resolvedSelector", async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "accessibility-id" } }]);
    assert.throws(() => loadTestCaseSteps(file), /invalid "resolvedSelector"/);
  });

  await run("runScriptSteps passes a step's resolvedSelector through to executeSemanticAction as cachedSelector", async () => {
    const calls = [];
    const steps = [
      { kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "accessibility-id", value: "Login" } },
    ];
    await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async (driver, instruction, options) => {
        calls.push(options.cachedSelector);
        return { success: true, diffSummary: "did it", selector: options.cachedSelector, usedCache: true };
      },
    });
    assert.deepStrictEqual(calls, [{ strategy: "accessibility-id", value: "Login" }]);
  });

  await run("runScriptSteps's updatedSteps records a freshly-resolved selector for a step that had none", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "did it",
        selector: { strategy: "xpath", value: "//View[1]" },
      }),
    });
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "xpath", value: "//View[1]" });
    // The original `steps` array passed in must never be mutated in place.
    assert.strictEqual(steps[0].resolvedSelector, undefined);
  });

  await run("runScriptSteps's updatedSteps preserves the original (unresolved) text, never a resolved secret", async () => {
    const steps = [
      { kind: "type", instruction: "type password", text: "${A_FIXTURE_SECRET}" },
    ];
    process.env.A_FIXTURE_SECRET = "literal-secret-value";
    try {
      const result = await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async (driver, instruction, options) => ({
          success: true,
          diffSummary: "did it",
          selector: { strategy: "accessibility-id", value: "password-field" },
        }),
      });
      assert.strictEqual(result.updatedSteps[0].text, "${A_FIXTURE_SECRET}");
      assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "password-field" });
    } finally {
      delete process.env.A_FIXTURE_SECRET;
    }
  });

  await run("runScriptSteps's updatedSteps leaves resolvedSelector unset for a step whose result carries no selector", async () => {
    const steps = [{ kind: "wait", instruction: "wait a bit", durationMs: 1 }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => {
        throw new Error("a wait step must never call executeSemanticAction");
      },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updatedSteps[0].resolvedSelector, undefined);
  });

  await run("persistResolvedSelectors writes updatedSteps back into a bare-array test case file", async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap LOGIN" }]);
    persistResolvedSelectors(file, [
      { kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "xpath", value: "//View[1]" } },
    ]);
    const steps = loadTestCaseSteps(file);
    assert.deepStrictEqual(steps[0].resolvedSelector, { strategy: "xpath", value: "//View[1]" });
  });

  await run('loadTestCaseSteps accepts a "tapIfExists" step with a valid selector', async () => {
    const file = writeTempJson([
      { kind: "tapIfExists", instruction: "tap More Close if open", selector: { strategy: "accessibility-id", value: "More Close" } },
    ]);
    const steps = loadTestCaseSteps(file);
    assert.strictEqual(steps[0].kind, "tapIfExists");
    assert.deepStrictEqual(steps[0].selector, { strategy: "accessibility-id", value: "More Close" });
  });

  await run('loadTestCaseSteps rejects a "tapIfExists" step with no selector', async () => {
    const file = writeTempJson([{ kind: "tapIfExists", instruction: "tap More Close if open" }]);
    assert.throws(() => loadTestCaseSteps(file), /"tapIfExists" step but has no valid "selector"/);
  });

  await run('loadTestCaseSteps rejects a "tapIfExists" step with a malformed selector', async () => {
    const file = writeTempJson([{ kind: "tapIfExists", instruction: "tap More Close if open", selector: { strategy: "accessibility-id" } }]);
    assert.throws(() => loadTestCaseSteps(file), /"tapIfExists" step but has no valid "selector"/);
  });

  await run('runScriptSteps passes a "tapIfExists" step\'s selector through as exactSelector, never as cachedSelector', async () => {
    const calls = [];
    const steps = [
      { kind: "tapIfExists", instruction: "tap More Close if open", selector: { strategy: "accessibility-id", value: "More Close" } },
    ];
    await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async (driver, instruction, options) => {
        calls.push(options);
        return { success: true, skipped: true, diffSummary: "skipped" };
      },
    });
    assert.deepStrictEqual(calls[0].exactSelector, { strategy: "accessibility-id", value: "More Close" });
    assert.strictEqual(calls[0].cachedSelector, undefined);
  });

  await run('runScriptSteps\'s updatedSteps never writes a "tapIfExists" step\'s hand-authored selector into resolvedSelector', async () => {
    const steps = [
      { kind: "tapIfExists", instruction: "tap More Close if open", selector: { strategy: "accessibility-id", value: "More Close" } },
    ];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        selector: { strategy: "accessibility-id", value: "More Close" },
        diffSummary: "did it",
      }),
    });
    assert.strictEqual(result.updatedSteps[0].resolvedSelector, undefined);
    assert.deepStrictEqual(result.updatedSteps[0].selector, { strategy: "accessibility-id", value: "More Close" });
  });

  await run('runScriptSteps treats a "tapIfExists" skip as success and continues to the next step', async () => {
    const calls = [];
    const steps = [
      { kind: "tapIfExists", instruction: "tap More Close if open", selector: { strategy: "accessibility-id", value: "More Close" } },
      { kind: "tap", instruction: "tap LOGIN" },
    ];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async (driver, instruction) => {
        calls.push(instruction);
        if (instruction.includes("More Close")) return { success: true, skipped: true, diffSummary: "skipped" };
        return { success: true, diffSummary: "did: " + instruction };
      },
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, ["tap More Close if open", "tap LOGIN"]);
  });

  await run("persistResolvedSelectors preserves other top-level keys on an object-shaped test case file", async () => {
    const file = writeTempJson({ name: "demo", description: "a demo case", steps: [{ kind: "tap", instruction: "tap LOGIN" }] });
    persistResolvedSelectors(file, [
      { kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "xpath", value: "//View[1]" } },
    ]);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.name, "demo");
    assert.strictEqual(raw.description, "a demo case");
    assert.deepStrictEqual(raw.steps[0].resolvedSelector, { strategy: "xpath", value: "//View[1]" });
  });

  // ---- outcome verification (generation/outcome-verification.js, wired
  // in here) -- the fix for docs/STATUS.md bugs #16/#18: a step can
  // report success (no WebDriver error) while hitting the wrong
  // element entirely, and nothing about `result.success` alone could
  // ever catch that. ----

  await run('loadTestCaseSteps accepts a step with a valid "expect" field', async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap Profile", expect: { appeared: ["Profile"], disappeared: ["Login"] } }]);
    const steps = loadTestCaseSteps(file);
    assert.deepStrictEqual(steps[0].expect, { appeared: ["Profile"], disappeared: ["Login"] });
  });

  await run('loadTestCaseSteps accepts "expect" with only "appeared" or only "disappeared"', async () => {
    const file = writeTempJson([
      { kind: "tap", instruction: "tap A", expect: { appeared: ["A"] } },
      { kind: "tap", instruction: "tap B", expect: { disappeared: ["B"] } },
    ]);
    const steps = loadTestCaseSteps(file);
    assert.deepStrictEqual(steps[0].expect, { appeared: ["A"] });
    assert.deepStrictEqual(steps[1].expect, { disappeared: ["B"] });
  });

  await run('loadTestCaseSteps rejects an "expect" with neither "appeared" nor "disappeared" (would always pass trivially)', async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap X", expect: {} }]);
    assert.throws(() => loadTestCaseSteps(file), /invalid "expect"/);
  });

  await run('loadTestCaseSteps rejects an "expect" field that is not an object', async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap X", expect: "Profile" }]);
    assert.throws(() => loadTestCaseSteps(file), /invalid "expect"/);
  });

  await run('loadTestCaseSteps rejects "expect.appeared" that is not a non-empty array of strings', async () => {
    const file = writeTempJson([{ kind: "tap", instruction: "tap X", expect: { appeared: [] } }]);
    assert.throws(() => loadTestCaseSteps(file), /invalid "expect"/);
    const file2 = writeTempJson([{ kind: "tap", instruction: "tap X", expect: { appeared: [123] } }]);
    assert.throws(() => loadTestCaseSteps(file2), /invalid "expect"/);
  });

  await run("runScriptSteps FAILS the run when a step reports success but its declared outcome never appeared (the false-success fix, bugs #16/#18)", async () => {
    const steps = [{ kind: "tap", instruction: "tap the Profile tab", expect: { appeared: ["Profile"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      // Simulates the real bug: the click "succeeds" (a real, wrong
      // element), but the diff shows something unrelated appeared --
      // "Profile" never shows up.
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "Appeared: \"Add-On Details\".",
        diff: { appeared: [{ label: "Add-On Details" }], disappeared: [] },
      }),
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.detail.includes("failed outcome verification"));
    assert.ok(result.detail.includes("Profile"));
  });

  await run("runScriptSteps succeeds when a step's declared outcome is found in the real diff (appeared and disappeared both checked)", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGOUT", expect: { appeared: ["login"], disappeared: ["Logout"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "ok",
        // Case-insensitive, substring match -- "Login" in the diff
        // satisfies a declared "login" expectation.
        diff: { appeared: [{ label: "Login" }], disappeared: [{ label: "Logout" }] },
      }),
    });
    assert.strictEqual(result.success, true);
  });

  await run("runScriptSteps fails outcome verification when the action succeeded but no diff was captured at all", async () => {
    const steps = [{ kind: "tap", instruction: "tap Submit", expect: { appeared: ["Confirmation"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      // Mirrors actAndDiff's own real "post-action read failed" shape:
      // success, but no diff field at all.
      executeSemanticAction: async () => ({ success: true }),
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.detail.includes("no screen diff was captured"));
  });

  await run("runScriptSteps honors optional:true on a step that fails outcome verification (skips rather than stopping the run)", async () => {
    const calls = [];
    const steps = [
      { kind: "tap", instruction: "tap maybe", optional: true, expect: { appeared: ["Never Happens"] } },
      { kind: "tap", instruction: "tap real step" },
    ];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async (driver, instruction) => {
        calls.push(instruction);
        return { success: true, diff: { appeared: [], disappeared: [] } };
      },
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, ["tap maybe", "tap real step"]);
  });

  await run('runScriptSteps does NOT run outcome verification on a "tapIfExists" step that was skipped (nothing happened, nothing to verify)', async () => {
    const steps = [{ kind: "tapIfExists", instruction: "close popup if open", selector: { strategy: "resource-id", value: "x" }, expect: { appeared: ["would never be checked"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({ success: true, skipped: true, diffSummary: "skipped" }),
    });
    assert.strictEqual(result.success, true);
  });

  await run("runScriptSteps never persists a resolvedSelector for a step that failed outcome verification (a wrong click never gets cached as proven-correct)", async () => {
    const steps = [{ kind: "tap", instruction: "tap Profile", expect: { appeared: ["Profile"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        selector: { strategy: "resource-id", value: "wrong_but_real_button" },
        diff: { appeared: [{ label: "Something Else" }], disappeared: [] },
      }),
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.updatedSteps[0].resolvedSelector, undefined);
  });

  await run("runScriptSteps logs an expectFailed execution-log record when a tap produces a real diff but never satisfies its declared expect", async () => {
    const tmpLogPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testops-mobile-runner-exec-log-")), "executions.jsonl");
    const originalPath = process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH;
    process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = tmpLogPath;
    try {
      const steps = [{ kind: "tap", instruction: "tap Profile", expect: { appeared: ["Profile"] } }];
      const result = await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async () => ({
          success: true,
          selector: { strategy: "resource-id", value: "wrong_but_real_button" },
          diffSummary: "Appeared: \"Add-On Details\".",
          diff: { appeared: [{ label: "Add-On Details" }], disappeared: [] },
        }),
      });
      assert.strictEqual(result.success, false);
      const lines = fs.readFileSync(tmpLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].instruction, "tap Profile");
      assert.strictEqual(lines[0].kind, "tap");
      assert.strictEqual(lines[0].expectFailed, true);
      assert.deepStrictEqual(lines[0].selector, { strategy: "resource-id", value: "wrong_but_real_button" });
    } finally {
      process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = originalPath;
    }
  });

  await run("runScriptSteps does NOT log an expectFailed record for a dead (\"No visible change.\") tap -- that's the OTHER bug class, logged elsewhere", async () => {
    const tmpLogPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testops-mobile-runner-exec-log-")), "executions.jsonl");
    const originalPath = process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH;
    process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = tmpLogPath;
    try {
      const steps = [{ kind: "tap", instruction: "tap Profile", expect: { appeared: ["Profile"] } }];
      const result = await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async () => ({
          success: true,
          selector: { strategy: "resource-id", value: "dead_button" },
          diffSummary: "No visible change.",
          diff: { appeared: [], disappeared: [] },
        }),
      });
      assert.strictEqual(result.success, false);
      assert.ok(!fs.existsSync(tmpLogPath) || fs.readFileSync(tmpLogPath, "utf8").trim() === "", "a dead-tap verification failure must not also be logged as expectFailed");
    } finally {
      process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = originalPath;
    }
  });

  await run("the real test-cases/addons.ios.json loads cleanly, is behaviorally parallel to addons.json, and is wired for iOS-generic execution", async () => {
    const iosFile = path.join(__dirname, "..", "..", "test-cases", "addons.ios.json");
    const androidFile = path.join(__dirname, "..", "..", "test-cases", "addons.json");
    const iosSteps = loadTestCaseSteps(iosFile);
    const androidSteps = loadTestCaseSteps(androidFile);

    // Same step count and same narrative sequence (login -> dismiss
    // dialogs/tutorial -> Add-ons -> logout) as the proven Android
    // file -- "behaviorally parallel", not a different flow. Wording
    // can differ slightly where iOS's own UI conventions genuinely
    // differ (e.g. iOS's native notification-permission alert vs.
    // Android's permissioncontroller dialog), so instructions aren't
    // required to match verbatim -- only the kind sequence (modulo the
    // tapIfExists->tap substitution below) and the step count.
    //
    // Kind can legitimately differ for a conditional dialog-dismiss
    // step: Android's hand-authored "tapIfExists" requires an exact,
    // already-confirmed selector (loadTestCaseSteps enforces this),
    // which no iOS run has produced yet, so those steps are authored
    // as optional "tap" (semantic-resolution, skippable) instead --
    // same intent (tap it if present, don't fail the run if not),
    // same position in the sequence.
    assert.strictEqual(iosSteps.length, androidSteps.length);
    iosSteps.forEach((step, i) => {
      const androidKind = androidSteps[i].kind;
      if (androidKind === "tapIfExists") {
        assert.strictEqual(step.kind, "tap", `step ${i} ("${step.instruction}") should be an optional "tap" on iOS, standing in for Android's selector-requiring "tapIfExists"`);
        assert.strictEqual(step.optional, true, `step ${i} ("${step.instruction}") must be optional, matching tapIfExists's skip-if-absent behavior`);
      } else {
        assert.strictEqual(step.kind, androidKind, `step ${i} ("${step.instruction}") kind should match the Android file`);
      }
    });

    // Authored, not evidence-backed: no Android-specific selector or
    // expect value is carried over -- every step relies purely on
    // `instruction` for semantic resolution, exactly like a
    // freshly-authored, never-yet-executed test case.
    for (const step of iosSteps) {
      assert.strictEqual(step.resolvedSelector, undefined, `step "${step.instruction}" must not carry a resolvedSelector before a real run`);
      assert.strictEqual(step.selector, undefined, `step "${step.instruction}" must not carry a selector before a real run`);
      assert.strictEqual(step.expect, undefined, `step "${step.instruction}" must not carry an expect before a real run`);
      assert.ok(typeof step.instruction === "string" && step.instruction.length > 0);
    }

    // requiredEnv (the login credentials) mirrors the Android file --
    // same app, same login flow, same env-var contract.
    assert.deepStrictEqual(requiredEnvVars(iosSteps), requiredEnvVars(androidSteps));
  });

  await run("runScriptSteps executes test-cases/addons.ios.json's steps end to end against a fake driver with platform: \"ios\" threaded through to every resolver call", async () => {
    const steps = loadTestCaseSteps(path.join(__dirname, "..", "..", "test-cases", "addons.ios.json"));
    const originalPhone = process.env.TESTOPS_MOBILE_BATCH_LOGIN_PHONE;
    const originalPassword = process.env.TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD;
    process.env.TESTOPS_MOBILE_BATCH_LOGIN_PHONE = "0123456789";
    process.env.TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD = "secret";
    let resolved;
    try {
      resolved = resolveSteps(steps);
    } finally {
      process.env.TESTOPS_MOBILE_BATCH_LOGIN_PHONE = originalPhone;
      process.env.TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD = originalPassword;
    }

    const seenPlatforms = [];
    const fakeExecuteSemanticAction = async (driver, instruction, options) => {
      seenPlatforms.push(options && options.platform);
      return {
        success: true,
        selector: { strategy: "accessibility-id", value: "whatever" },
        diffSummary: "Some change.",
        diff: { appeared: [], disappeared: [] },
      };
    };

    const result = await runScriptSteps({}, resolved, {
      platform: "ios",
      executeSemanticAction: fakeExecuteSemanticAction,
      sleepFn: async () => {},
    });

    assert.strictEqual(result.success, true);
    // Every resolver call for this file's tap/type/tapIfExists steps
    // (the scroll step doesn't call the resolver -- see
    // engine/semantic-act-executor.js's performScroll) was made with
    // platform: "ios", confirming the existing generic runner wiring
    // (no iOS-specific branch needed in the runner itself) actually
    // reaches the resolver for this test case.
    assert.ok(seenPlatforms.length > 0);
    assert.ok(seenPlatforms.every((p) => p === "ios"));
  });

  if (process.exitCode) {
    console.error("\nengine/test-case-runner tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/test-case-runner tests passed");
  }
})();
