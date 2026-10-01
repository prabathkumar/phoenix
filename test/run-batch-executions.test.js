const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { splitBatchCounts, summarizeBatchResults, computeModeCounts, parseBatchModes, writeReport, OUTPUT_DIR } = require("../run-batch-executions");

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
function withEnvAndFreshModule(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete require.cache[modulePath];
  try {
    fn(require(modulePath));
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
