const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { splitBatchCounts, summarizeBatchResults, computeModeCounts, parseBatchModes, writeReport, OUTPUT_DIR, mergeResolvedSelectors } = require("../run-batch-executions");

const modulePath = require.resolve("../run-batch-executions");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failed += 1;
  }
}

/**
 * buildEffectiveGoal/redactSecrets read PHOENIX_BATCH_LOGIN_PHONE/
 * PASSWORD once, at module load time (see run-batch-executions.js's
 * header comment on why: never re-read per call, so nothing about a
 * running batch's behavior can change mid-run from a stray env
 * mutation). Tests therefore need to set the env vars and force a
 * fresh require, then restore both afterward -- same require.cache
 * technique used throughout this repo's other tests.
 */
// `fn` may be async (several callers now read process.env at run time,
// not just at module-load time -- see engine/test-case-runner.js's
// resolveStepText -- so env must stay in place for fn's entire
// execution, not just until it starts). Always `await`s fn()'s result
// before restoring env in `finally`, whether or not fn itself is an
// async function, so a synchronous fn (most existing callers) is
// unaffected and an async one no longer has its env pulled out from
// under it while still running.
async function withEnvAndFreshModule(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete require.cache[modulePath];
  try {
    await fn(require(modulePath));
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    delete require.cache[modulePath];
  }
}

test("splitBatchCounts splits 100 into even thirds, remainder to guided", () => {
  const counts = splitBatchCounts(100);
  assert.strictEqual(counts.semantic, 33);
  assert.strictEqual(counts.loop, 33);
  assert.strictEqual(counts.guided, 34);
  assert.strictEqual(counts.guided + counts.semantic + counts.loop, 100);
});

test("splitBatchCounts divides evenly when total is a multiple of 3", () => {
  const counts = splitBatchCounts(99);
  assert.deepStrictEqual(counts, { guided: 33, semantic: 33, loop: 33 });
});

test("splitBatchCounts handles zero total", () => {
  assert.deepStrictEqual(splitBatchCounts(0), { guided: 0, semantic: 0, loop: 0 });
});

test("splitBatchCounts handles negative total", () => {
  assert.deepStrictEqual(splitBatchCounts(-5), { guided: 0, semantic: 0, loop: 0 });
});

test("splitBatchCounts respects custom ratios", () => {
  const counts = splitBatchCounts(10, { guided: 8, semantic: 1, loop: 1 });
  assert.strictEqual(counts.semantic, 1);
  assert.strictEqual(counts.loop, 1);
  assert.strictEqual(counts.guided, 8);
});

test("splitBatchCounts never loses items to rounding", () => {
  for (const total of [1, 2, 4, 5, 7, 10, 50, 100, 137]) {
    const counts = splitBatchCounts(total);
    assert.strictEqual(counts.guided + counts.semantic + counts.loop, total, `total mismatch for ${total}`);
  }
});

test("summarizeBatchResults computes totals and per-mode stats", () => {
  const results = [
    { mode: "guided", success: true, durationMs: 100 },
    { mode: "guided", success: false, durationMs: 200 },
    { mode: "semantic", success: true, durationMs: 300 },
  ];
  const summary = summarizeBatchResults(results);
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.succeeded, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.byMode.guided.total, 2);
  assert.strictEqual(summary.byMode.guided.succeeded, 1);
  assert.strictEqual(summary.byMode.guided.failed, 1);
  assert.strictEqual(summary.byMode.guided.successRate, 0.5);
  assert.strictEqual(summary.byMode.guided.avgDurationMs, 150);
  assert.strictEqual(summary.byMode.semantic.successRate, 1);
});

test("summarizeBatchResults handles empty results", () => {
  const summary = summarizeBatchResults([]);
  assert.strictEqual(summary.total, 0);
  assert.strictEqual(summary.succeeded, 0);
  assert.strictEqual(summary.failed, 0);
  assert.deepStrictEqual(summary.byMode, {});
});

test("buildEffectiveGoal leaves the goal unchanged when no credentials are configured", () => {
  withEnvAndFreshModule({ PHOENIX_BATCH_LOGIN_PHONE: undefined, PHOENIX_BATCH_LOGIN_PASSWORD: undefined }, (mod) => {
    assert.strictEqual(mod.buildEffectiveGoal("reach the login screen"), "reach the login screen");
  });
});

test("buildEffectiveGoal appends both credentials when both are configured", () => {
  withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0183400351", PHOENIX_BATCH_LOGIN_PASSWORD: "p@P1B@6vbu" },
    (mod) => {
      const goal = mod.buildEffectiveGoal("log in");
      assert.ok(goal.includes("0183400351"));
      assert.ok(goal.includes("p@P1B@6vbu"));
      assert.ok(goal.startsWith("log in"));
    }
  );
});

test("buildEffectiveGoal appends only the credential that's actually set", () => {
  withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0183400351", PHOENIX_BATCH_LOGIN_PASSWORD: undefined },
    (mod) => {
      const goal = mod.buildEffectiveGoal("log in");
      assert.ok(goal.includes("0183400351"));
      assert.ok(!goal.includes("password"));
    }
  );
});

test("redactSecrets is a no-op when no credentials are configured", () => {
  withEnvAndFreshModule({ PHOENIX_BATCH_LOGIN_PHONE: undefined, PHOENIX_BATCH_LOGIN_PASSWORD: undefined }, (mod) => {
    assert.strictEqual(mod.redactSecrets("Cannot set the element to 'p@P1B@6vbu'"), "Cannot set the element to 'p@P1B@6vbu'");
  });
});

test("redactSecrets replaces a leaked credential in an error/diff message", () => {
  withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0183400351", PHOENIX_BATCH_LOGIN_PASSWORD: "p@P1B@6vbu" },
    (mod) => {
      const redacted = mod.redactSecrets("Cannot set the element to 'p@P1B@6vbu'. Did you interact with the correct element?");
      assert.ok(!redacted.includes("p@P1B@6vbu"));
      assert.ok(redacted.includes("[REDACTED]"));
    }
  );
});

test("redactSecrets passes non-string values through unchanged", () => {
  withEnvAndFreshModule({ PHOENIX_BATCH_LOGIN_PHONE: "0183400351", PHOENIX_BATCH_LOGIN_PASSWORD: undefined }, (mod) => {
    assert.strictEqual(mod.redactSecrets(undefined), undefined);
    assert.strictEqual(mod.redactSecrets(42), 42);
  });
});

test("sanitizeStepsForReport always redacts a type step's text, even with no credentials configured", () => {
  withEnvAndFreshModule({ PHOENIX_BATCH_LOGIN_PHONE: undefined, PHOENIX_BATCH_LOGIN_PASSWORD: undefined }, (mod) => {
    const sanitized = mod.sanitizeStepsForReport([
      { instruction: "type the phone number", kind: "type", text: "0183400351", diffSummary: "Appeared: \"Password\"." },
    ]);
    assert.strictEqual(sanitized[0].text, "[REDACTED]");
    assert.strictEqual(sanitized[0].instruction, "type the phone number");
    assert.strictEqual(sanitized[0].diffSummary, "Appeared: \"Password\".");
  });
});

test("sanitizeStepsForReport omits the text field entirely for a tap step", () => {
  withEnvAndFreshModule({ PHOENIX_BATCH_LOGIN_PHONE: undefined, PHOENIX_BATCH_LOGIN_PASSWORD: undefined }, (mod) => {
    const sanitized = mod.sanitizeStepsForReport([
      { instruction: "tap the Login button", kind: "tap", diffSummary: "Appeared: \"Yes Number\"." },
    ]);
    assert.strictEqual(sanitized[0].text, undefined);
    assert.ok(!("text" in sanitized[0]));
  });
});

test("sanitizeStepsForReport redacts a configured credential if it leaks into instruction/diffSummary", () => {
  withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0183400351", PHOENIX_BATCH_LOGIN_PASSWORD: undefined },
    (mod) => {
      const sanitized = mod.sanitizeStepsForReport([
        { instruction: "tap the button", kind: "tap", diffSummary: "Cannot set the element to '0183400351'" },
      ]);
      assert.ok(!sanitized[0].diffSummary.includes("0183400351"));
    }
  );
});

test("computeModeCounts matches splitBatchCounts when all three modes are requested", () => {
  assert.deepStrictEqual(computeModeCounts(100, ["guided", "semantic", "loop"]), splitBatchCounts(100));
});

test("computeModeCounts gives a single requested mode the entire total (the bug this fixes)", () => {
  // Found for real: PHOENIX_BATCH_TOTAL=1 with only "loop" requested
  // must yield one loop iteration, not zero -- zeroing "loop" out of
  // splitBatchCounts(1)'s own ratio split (which puts total 1 into
  // "guided" by its remainder rule) would silently run nothing.
  assert.deepStrictEqual(computeModeCounts(1, ["loop"]), { guided: 0, semantic: 0, loop: 1 });
  assert.deepStrictEqual(computeModeCounts(10, ["loop"]), { guided: 0, semantic: 0, loop: 10 });
});

test("computeModeCounts splits evenly across a subset of modes, remainder to the first requested", () => {
  assert.deepStrictEqual(computeModeCounts(5, ["semantic", "loop"]), { guided: 0, semantic: 3, loop: 2 });
});

test("computeModeCounts handles zero total and empty modes safely", () => {
  assert.deepStrictEqual(computeModeCounts(0, ["loop"]), { guided: 0, semantic: 0, loop: 0 });
  assert.deepStrictEqual(computeModeCounts(10, []), { guided: 0, semantic: 0, loop: 0 });
});

test("parseBatchModes defaults to all three modes when unset", () => {
  const previous = process.env.PHOENIX_BATCH_MODES;
  delete process.env.PHOENIX_BATCH_MODES;
  try {
    assert.deepStrictEqual(parseBatchModes(), ["guided", "semantic", "loop"]);
  } finally {
    if (previous !== undefined) process.env.PHOENIX_BATCH_MODES = previous;
  }
});

test("parseBatchModes parses a comma-separated subset, case-insensitively", () => {
  const previous = process.env.PHOENIX_BATCH_MODES;
  process.env.PHOENIX_BATCH_MODES = "Loop, SEMANTIC";
  try {
    assert.deepStrictEqual(parseBatchModes(), ["loop", "semantic"]);
  } finally {
    if (previous === undefined) delete process.env.PHOENIX_BATCH_MODES;
    else process.env.PHOENIX_BATCH_MODES = previous;
  }
});

test("parseBatchModes falls back to all three when every named mode is invalid", () => {
  const previous = process.env.PHOENIX_BATCH_MODES;
  process.env.PHOENIX_BATCH_MODES = "bogus";
  try {
    assert.deepStrictEqual(parseBatchModes(), ["guided", "semantic", "loop"]);
  } finally {
    if (previous === undefined) delete process.env.PHOENIX_BATCH_MODES;
    else process.env.PHOENIX_BATCH_MODES = previous;
  }
});

/**
 * runOneLoginScriptIteration() is the fixed, deterministic replacement
 * for asking the "loop" mode's model to plan the login sequence itself
 * -- added after real iOS runs (ios7, ios10) got stuck right at "both
 * fields are filled in, now submit" twice in a row despite goal-wording
 * fixes (see docs/STATUS.md bugs 15/17). These tests fake both
 * engine/semantic-act-executor's executeSemanticAction (same
 * require.cache-injection technique as engine/test/semantic-loop.test.js)
 * and engine/session's startSession, so the fixed step sequence can be
 * exercised without a real driver or BrowserStack session.
 */
const EXECUTOR_PATH = require.resolve("../engine/semantic-act-executor");
const SESSION_PATH = require.resolve("../engine/session");

function freshBatchModuleWithFakes({ executeSemanticAction, deleteSessionCalls = [] } = {}) {
  for (const p of [modulePath, EXECUTOR_PATH, SESSION_PATH]) delete require.cache[p];

  require.cache[EXECUTOR_PATH] = {
    id: EXECUTOR_PATH,
    filename: EXECUTOR_PATH,
    loaded: true,
    exports: { executeSemanticAction },
  };

  const fakeDriver = {
    deleteSession: async () => {
      deleteSessionCalls.push(true);
    },
  };
  require.cache[SESSION_PATH] = {
    id: SESSION_PATH,
    filename: SESSION_PATH,
    loaded: true,
    exports: { startSession: async () => fakeDriver },
  };

  return require(modulePath);
}

test("mergeResolvedSelectors overlays a learned resolvedSelector onto the matching original (placeholder-carrying) step", () => {
  const original = [
    { kind: "type", instruction: "type password", text: "${SECRET}" },
    { kind: "tap", instruction: "tap LOGIN" },
  ];
  const updated = [
    { kind: "type", instruction: "type password", text: "literal-secret-value", resolvedSelector: { strategy: "accessibility-id", value: "pw" } },
    { kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "xpath", value: "//View[1]" } },
  ];
  const merged = mergeResolvedSelectors(original, updated);
  assert.strictEqual(merged[0].text, "${SECRET}", "the original placeholder text must survive, never the resolved literal");
  assert.deepStrictEqual(merged[0].resolvedSelector, { strategy: "accessibility-id", value: "pw" });
  assert.deepStrictEqual(merged[1].resolvedSelector, { strategy: "xpath", value: "//View[1]" });
});

test("mergeResolvedSelectors leaves a step unchanged when updatedSteps has no resolvedSelector for it", () => {
  const original = [{ kind: "tap", instruction: "tap LOGIN" }];
  const updated = [{ kind: "tap", instruction: "tap LOGIN" }];
  const merged = mergeResolvedSelectors(original, updated);
  assert.deepStrictEqual(merged[0], original[0]);
});

test("mergeResolvedSelectors returns undefined when updatedSteps is undefined (a failed run before any step ran)", () => {
  assert.strictEqual(mergeResolvedSelectors([{ kind: "tap", instruction: "x" }], undefined), undefined);
});

test("runOneLoginScriptIteration's default persist writes only merged (placeholder-safe) selectors, never a resolved-steps copy, to the real login test case path", async () => {
  await withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0123456789", PHOENIX_BATCH_LOGIN_PASSWORD: "secret123" },
    async (freshModule) => {
      const deleteSessionCalls = [];
      const testFreshModule = freshBatchModuleWithFakes({
        deleteSessionCalls,
        executeSemanticAction: async (driver, instruction) => ({
          success: true,
          diffSummary: `did: ${instruction}`,
          selector: { strategy: "xpath", value: "//View[1]" },
        }),
      });
      let persistedPath;
      let persistedSteps;
      const result = await testFreshModule.runOneLoginScriptIteration("android", {
        persist: (filePath, steps) => {
          persistedPath = filePath;
          persistedSteps = steps;
        },
      });
      assert.strictEqual(result.success, true);
      assert.ok(persistedPath.endsWith(path.join("test-cases", "login.json")));
      // Every step got the same fake selector; credentials must still be
      // the original "${...}" placeholders, never "0123456789"/"secret123".
      const typeSteps = persistedSteps.filter((s) => s.kind === "type");
      assert.ok(typeSteps.length > 0);
      for (const step of typeSteps) {
        assert.ok(/^\$\{[A-Z0-9_]+\}$/.test(step.text), `expected a placeholder, got "${step.text}"`);
      }
      for (const step of persistedSteps) {
        if (step.kind !== "wait") {
          assert.deepStrictEqual(step.resolvedSelector, { strategy: "xpath", value: "//View[1]" });
        }
      }
    }
  );
});

// Every runOneLoginScriptIteration() call in this test file passes a
// no-op `persist` override: that function's default behavior writes
// any learned selectors back to the REAL test-cases/login.json on
// disk (see run-batch-executions.js), which a test run must never do
// to a tracked repo file.
const noopPersist = () => {};

test("runOneLoginScriptIteration fails fast with a clear message when no credentials are configured", async () => {
  await withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: undefined, PHOENIX_BATCH_LOGIN_PASSWORD: undefined },
    async (freshModule) => {
      const result = await freshModule.runOneLoginScriptIteration("android", { persist: noopPersist });
      assert.strictEqual(result.success, false);
      assert.ok(/PHOENIX_BATCH_LOGIN_PHONE/.test(result.detail));
    }
  );
});

test("runOneLoginScriptIteration runs the fixed sequence in order and reports success from the final step", async () => {
  await withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0123456789", PHOENIX_BATCH_LOGIN_PASSWORD: "secret123" },
    async () => {
      const calls = [];
      const deleteSessionCalls = [];
      const freshModule = freshBatchModuleWithFakes({
        deleteSessionCalls,
        executeSemanticAction: async (driver, instruction, options = {}) => {
          calls.push({ instruction, kind: options.kind, text: options.text });
          // First step (the optional "Allow" dialog) isn't present this
          // run -- the resolver reports unresolved, same as a real
          // screen with no such dialog on it.
          if (instruction.includes("Allow")) return { success: false, reason: "no confident match" };
          return { success: true, diffSummary: `did: ${instruction}` };
        },
      });

      const result = await freshModule.runOneLoginScriptIteration("android", { persist: noopPersist });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.detail, "did: tap the LOGIN button to submit the login form");
      assert.deepStrictEqual(
        calls.map((c) => c.instruction),
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
      // The two "type" steps get the real credentials, in order --
      // confirms the fixed sequence (not a model) decided what to type
      // where.
      assert.strictEqual(calls[2].text, "0123456789");
      assert.strictEqual(calls[5].text, "secret123");
      assert.strictEqual(deleteSessionCalls.length, 1, "session must be torn down exactly once");
    }
  );
});

test("runOneLoginScriptIteration stops and reports failure on the first non-optional step that fails, without running later steps", async () => {
  await withEnvAndFreshModule(
    { PHOENIX_BATCH_LOGIN_PHONE: "0123456789", PHOENIX_BATCH_LOGIN_PASSWORD: "secret123" },
    async () => {
      const calls = [];
      const deleteSessionCalls = [];
      const freshModule = freshBatchModuleWithFakes({
        deleteSessionCalls,
        executeSemanticAction: async (driver, instruction) => {
          calls.push(instruction);
          if (instruction.includes("Allow")) return { success: false, reason: "no confident match" };
          if (instruction.includes("open the login form")) {
            return { success: false, reason: "resolved element is no longer on screen" };
          }
          throw new Error("should not reach a later step after a required step fails");
        },
      });

      const result = await freshModule.runOneLoginScriptIteration("android", { persist: noopPersist });

      assert.strictEqual(result.success, false);
      assert.ok(result.detail.includes("open the login form"));
      assert.ok(result.detail.includes("resolved element is no longer on screen"));
      assert.strictEqual(calls.length, 2, "must stop right after the failing required step, not continue to type/submit");
      assert.strictEqual(deleteSessionCalls.length, 1, "session must still be torn down after a failed step");
    }
  );
});

test("parseBatchModes accepts the opt-in login-script mode by itself", () => {
  const previous = process.env.PHOENIX_BATCH_MODES;
  process.env.PHOENIX_BATCH_MODES = "login-script";
  try {
    assert.deepStrictEqual(parseBatchModes(), ["login-script"]);
  } finally {
    if (previous === undefined) delete process.env.PHOENIX_BATCH_MODES;
    else process.env.PHOENIX_BATCH_MODES = previous;
  }
});

test("computeModeCounts gives login-script the entire total when requested alone (opt-in, not part of the default three-way split)", () => {
  assert.deepStrictEqual(computeModeCounts(1, ["login-script"]), { guided: 0, semantic: 0, loop: 0, "login-script": 1 });
});

test("computeModeCounts still matches splitBatchCounts for the real default three modes (login-script never silently included)", () => {
  assert.deepStrictEqual(computeModeCounts(100, ["guided", "semantic", "loop"]), splitBatchCounts(100));
});

test("parseBatchModes accepts the opt-in test-case mode by itself", () => {
  const previous = process.env.PHOENIX_BATCH_MODES;
  process.env.PHOENIX_BATCH_MODES = "test-case";
  try {
    assert.deepStrictEqual(parseBatchModes(), ["test-case"]);
  } finally {
    if (previous === undefined) delete process.env.PHOENIX_BATCH_MODES;
    else process.env.PHOENIX_BATCH_MODES = previous;
  }
});

test("computeModeCounts gives test-case the entire total when requested alone", () => {
  assert.deepStrictEqual(computeModeCounts(1, ["test-case"]), { guided: 0, semantic: 0, loop: 0, "test-case": 1 });
});

/**
 * runOneTestCaseIteration() is the generalized, data-driven counterpart
 * to runOneLoginScriptIteration() above -- same fixed-sequence-over-
 * fixed-resolver approach (engine/test-case-runner.js), but reading an
 * arbitrary test-case JSON file instead of the one built-in login
 * sequence. These tests write a small temp JSON file rather than
 * exercising test-cases/login.json itself (already covered by
 * engine/test/test-case-runner.test.js and the login-script tests
 * above).
 */
const os = require("os");

function writeTempTestCase(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-run-batch-test-case-")), "case.json");
  fs.writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

test("runOneTestCaseIteration fails fast with a clear message when PHOENIX_TEST_CASE_FILE isn't set", async () => {
  await withEnvAndFreshModule({}, async (freshModule) => {
    const result = await freshModule.runOneTestCaseIteration("android", undefined);
    assert.strictEqual(result.success, false);
    assert.ok(/PHOENIX_TEST_CASE_FILE/.test(result.detail));
  });
});

test("runOneTestCaseIteration fails fast with a clear message when the file doesn't parse", async () => {
  const badFile = writeTempTestCase("not json at all");
  fs.writeFileSync(badFile, "{ not valid json", "utf8");
  await withEnvAndFreshModule({}, async (freshModule) => {
    const result = await freshModule.runOneTestCaseIteration("android", badFile);
    assert.strictEqual(result.success, false);
    assert.ok(/not valid JSON/.test(result.detail));
  });
});

test("runOneTestCaseIteration runs an arbitrary test case's steps in order, resolving a placeholder from the environment", async () => {
  const file = writeTempTestCase({
    name: "demo-flow",
    steps: [
      { kind: "tap", instruction: "tap the Add-ons tab" },
      { kind: "type", instruction: "type the promo code", text: "${PHOENIX_DEMO_PROMO_CODE}" },
      { kind: "tap", instruction: "tap Apply" },
    ],
  });
  await withEnvAndFreshModule({ PHOENIX_DEMO_PROMO_CODE: "SAVE10" }, async () => {
    const calls = [];
    const deleteSessionCalls = [];
    const freshModule = freshBatchModuleWithFakes({
      deleteSessionCalls,
      executeSemanticAction: async (driver, instruction, options = {}) => {
        calls.push({ instruction, text: options.text });
        return { success: true, diffSummary: `did: ${instruction}` };
      },
    });

    const result = await freshModule.runOneTestCaseIteration("android", file);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.detail, "did: tap Apply");
    assert.deepStrictEqual(
      calls.map((c) => c.instruction),
      ["tap the Add-ons tab", "type the promo code", "tap Apply"]
    );
    assert.strictEqual(calls[1].text, "SAVE10");
    assert.strictEqual(deleteSessionCalls.length, 1);
  });
});

test("runOneTestCaseIteration fails fast, before starting a session, when a referenced env var isn't set", async () => {
  const file = writeTempTestCase({
    steps: [{ kind: "type", instruction: "type the promo code", text: "${PHOENIX_DEMO_PROMO_CODE_MISSING}" }],
  });
  await withEnvAndFreshModule({ PHOENIX_DEMO_PROMO_CODE_MISSING: undefined }, async (freshModule) => {
    const result = await freshModule.runOneTestCaseIteration("android", file);
    assert.strictEqual(result.success, false);
    assert.ok(result.detail.includes("PHOENIX_DEMO_PROMO_CODE_MISSING"));
  });
});

// Real bug found on a live BrowserStack iOS run (ios6): an infra-level
// library crash (an unhandled rejection from WebdriverIO's own HTTP
// client, raced by a slow/flaky BrowserStack response -- not a Phoenix
// selector bug) killed the whole process with no "FAILED" line, no
// summary, and NO REPORT FILE WRITTEN AT ALL, silently losing every
// iteration's result that had already completed. writeReport() is the
// fix: pulled out of main() so both a clean finish and the new crash
// handlers (process.on("unhandledRejection"/"uncaughtException")) can
// call the same code path and never lose what's already been collected.
test("writeReport writes a normal (non-crashed) report with no crashed/crashReason fields", () => {
  const results = [{ mode: "loop", success: true, durationMs: 100 }];
  const reportPath = writeReport(results);
  try {
    assert.ok(reportPath.startsWith(OUTPUT_DIR));
    const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.deepStrictEqual(written.results, results);
    assert.strictEqual(written.crashed, undefined);
    assert.strictEqual(written.crashReason, undefined);
    assert.strictEqual(written.summary.total, 1);
  } finally {
    fs.unlinkSync(reportPath);
  }
});

test("writeReport marks a crash-salvaged report as crashed and includes the (redacted) reason, without losing the results collected before the crash", () => {
  const results = [
    { mode: "loop", success: true, durationMs: 100 },
    { mode: "loop", success: true, durationMs: 150 },
  ];
  const reportPath = writeReport(results, new Error("onCancel handler was attached after the promise settled"));
  try {
    const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.strictEqual(written.crashed, true);
    assert.ok(written.crashReason.includes("onCancel handler was attached after the promise settled"));
    // The whole point: nothing collected before the crash is lost.
    assert.deepStrictEqual(written.results, results);
    assert.strictEqual(written.summary.total, 2);
  } finally {
    fs.unlinkSync(reportPath);
  }
});

test("writeReport redacts a configured credential if it leaks into the crash error message", () => {
  const previous = { phone: process.env.PHOENIX_BATCH_LOGIN_PHONE };
  process.env.PHOENIX_BATCH_LOGIN_PHONE = "0123456789";
  delete require.cache[modulePath];
  const freshModule = require(modulePath);
  try {
    const reportPath = freshModule.writeReport([], new Error("failed while typing 0123456789 into the field"));
    try {
      const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.ok(!written.crashReason.includes("0123456789"), "leaked credential must be redacted from the saved crash reason");
      assert.ok(written.crashReason.includes("[REDACTED]"));
    } finally {
      fs.unlinkSync(reportPath);
    }
  } finally {
    if (previous.phone === undefined) delete process.env.PHOENIX_BATCH_LOGIN_PHONE;
    else process.env.PHOENIX_BATCH_LOGIN_PHONE = previous.phone;
    delete require.cache[modulePath];
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
