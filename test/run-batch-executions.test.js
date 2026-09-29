const assert = require("assert");
const { splitBatchCounts, summarizeBatchResults, computeModeCounts, parseBatchModes } = require("../run-batch-executions");

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
