/**
 * Tests for the confidence gate added to runScriptSteps()
 * (engine/test-case-runner.js) and its wiring into engine/locator-store.js.
 *
 * The real risk this closes: before this gate, ANY fresh resolution
 * that didn't throw a WebDriver error got pinned into the test case's
 * `resolvedSelector` unconditionally -- including a confidently
 * wrong-but-plausible click with no declared `expect` and no real
 * visible effect ("No visible change."). Once pinned, every future
 * regression run would replay that wrong selector with zero further
 * scrutiny (no LLM call on a cache hit, by design). This gate requires
 * concrete evidence -- a verified `expect`, or a real non-empty diff --
 * before trusting a FRESH resolution enough to pin it. A cache HIT
 * (replaying an already-pinned selector) is always re-pinned as a
 * no-op, since it was already vetted when first written (or predates
 * this gate and is the existing trusted baseline).
 *
 * Kept separate from test/test-case-runner.test.js (which has one
 * pre-existing, unrelated content-mismatch failure between
 * addons.json/addons.ios.json -- a real test-case-authoring gap
 * requiring actual device evidence to fix, not something to paper over
 * here) so this new coverage runs cleanly in CI on its own.
 *
 * Run with: node test/test-case-runner-confidence-gate.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runScriptSteps } = require("../test-case-runner");
const { openLocatorStore, getLocatorStats } = require("../locator-store");

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

function tmpDbPath() {
  return path.join(os.tmpdir(), `phoenix-gate-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

(async () => {
  await run("a FRESH resolution with a real (non-dead) diff and no `expect` IS pinned", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "Login screen appeared.",
        selector: { strategy: "accessibility-id", value: "login_button" },
      }),
    });
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "login_button" });
  });

  await run("a FRESH resolution with 'No visible change.' and no `expect` is NOT pinned (no evidence it was right)", async () => {
    const steps = [{ kind: "tap", instruction: "tap something" }];
    const originalLogPath = process.env.PHOENIX_TRAINING_LOG_PATH;
    const tmpLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-gate-log-")), "executions.jsonl");
    process.env.PHOENIX_TRAINING_LOG_PATH = tmpLog;
    try {
      const result = await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async () => ({
          success: true,
          diffSummary: "No visible change.",
          selector: { strategy: "accessibility-id", value: "maybe_wrong" },
        }),
      });
      assert.strictEqual(result.updatedSteps[0].resolvedSelector, undefined, "an unverified dead-tap resolution must not be pinned");
      // It IS logged, so the gap is visible, not silent.
      const logged = fs.existsSync(tmpLog) ? fs.readFileSync(tmpLog, "utf8").trim() : "";
      assert.ok(logged.length > 0, "the held-back resolution should still be logged");
      const record = JSON.parse(logged.split("\n")[0]);
      assert.strictEqual(record.unverifiedResolution, true);
    } finally {
      if (originalLogPath === undefined) delete process.env.PHOENIX_TRAINING_LOG_PATH;
      else process.env.PHOENIX_TRAINING_LOG_PATH = originalLogPath;
    }
  });

  await run("a FRESH resolution with a declared `expect` that's verified IS pinned, even with 'No visible change.' diffSummary text", async () => {
    // Deliberately contrived diffSummary text to prove it's the `expect`
    // declaration (and its verification) driving trust here, not the
    // diffSummary string itself.
    const steps = [{ kind: "tap", instruction: "tap LOGIN", expect: { appeared: ["Password"] } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "No visible change.",
        diff: { appeared: [{ label: "Password" }], disappeared: [] },
        selector: { strategy: "accessibility-id", value: "login_button" },
      }),
    });
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "login_button" });
  });

  await run("a CACHE HIT is always re-pinned as a no-op, even with 'No visible change.' and no `expect`", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGIN", resolvedSelector: { strategy: "accessibility-id", value: "login_button" } }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "No visible change.",
        usedCache: true,
        selector: { strategy: "accessibility-id", value: "login_button" },
      }),
    });
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "login_button" });
  });

  await run("locatorStore records a verified hit for a fresh, evidenced resolution", async () => {
    const dbPath = tmpDbPath();
    const store = openLocatorStore(dbPath);
    try {
      const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
      await runScriptSteps({}, steps, {
        platform: "android",
        testCaseFile: "fixture.json",
        locatorStore: store,
        executeSemanticAction: async () => ({
          success: true,
          diffSummary: "Login screen appeared.",
          selector: { strategy: "accessibility-id", value: "login_button" },
        }),
      });
      const rows = getLocatorStats(store, "fixture.json");
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].verified_hits, 1);
      assert.strictEqual(rows[0].unverified_hits, 0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  await run("locatorStore records an UNVERIFIED hit for a fresh, unevidenced resolution (even though it's not pinned to the JSON file)", async () => {
    const dbPath = tmpDbPath();
    const store = openLocatorStore(dbPath);
    const originalLogPath = process.env.PHOENIX_TRAINING_LOG_PATH;
    process.env.PHOENIX_TRAINING_LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-gate-log-")), "executions.jsonl");
    try {
      const steps = [{ kind: "tap", instruction: "tap something" }];
      await runScriptSteps({}, steps, {
        platform: "android",
        testCaseFile: "fixture.json",
        locatorStore: store,
        executeSemanticAction: async () => ({
          success: true,
          diffSummary: "No visible change.",
          selector: { strategy: "accessibility-id", value: "maybe_wrong" },
        }),
      });
      const rows = getLocatorStats(store, "fixture.json");
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].verified_hits, 0);
      assert.strictEqual(rows[0].unverified_hits, 1);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
      if (originalLogPath === undefined) delete process.env.PHOENIX_TRAINING_LOG_PATH;
      else process.env.PHOENIX_TRAINING_LOG_PATH = originalLogPath;
    }
  });

  await run("a locatorStore write failure never breaks the actual run", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
    const brokenStore = { db: { prepare: () => { throw new Error("disk full"); } } };
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      testCaseFile: "fixture.json",
      locatorStore: brokenStore,
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "Login screen appeared.",
        selector: { strategy: "accessibility-id", value: "login_button" },
      }),
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "login_button" });
  });

  await run("no locatorStore given: behavior is identical to before the store existed", async () => {
    const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
    const result = await runScriptSteps({}, steps, {
      platform: "android",
      executeSemanticAction: async () => ({
        success: true,
        diffSummary: "Login screen appeared.",
        selector: { strategy: "accessibility-id", value: "login_button" },
      }),
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.updatedSteps[0].resolvedSelector, { strategy: "accessibility-id", value: "login_button" });
  });

  await run("PHOENIX_ENABLE_VISUAL_GROUNDING=1 passes useVisualGrounding:true to executeSemanticAction (vision fusion can now actually be turned on from a real run)", async () => {
    const previous = process.env.PHOENIX_ENABLE_VISUAL_GROUNDING;
    process.env.PHOENIX_ENABLE_VISUAL_GROUNDING = "1";
    try {
      const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
      const calls = [];
      await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async (driver, instruction, options) => {
          calls.push(options);
          return { success: true, diffSummary: "Login screen appeared.", selector: { strategy: "accessibility-id", value: "login_button" } };
        },
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].useVisualGrounding, true);
    } finally {
      if (previous === undefined) delete process.env.PHOENIX_ENABLE_VISUAL_GROUNDING;
      else process.env.PHOENIX_ENABLE_VISUAL_GROUNDING = previous;
    }
  });

  await run("useVisualGrounding defaults to false when PHOENIX_ENABLE_VISUAL_GROUNDING isn't set to \"1\"", async () => {
    const previous = process.env.PHOENIX_ENABLE_VISUAL_GROUNDING;
    delete process.env.PHOENIX_ENABLE_VISUAL_GROUNDING;
    try {
      const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
      const calls = [];
      await runScriptSteps({}, steps, {
        platform: "android",
        executeSemanticAction: async (driver, instruction, options) => {
          calls.push(options);
          return { success: true, diffSummary: "Login screen appeared.", selector: { strategy: "accessibility-id", value: "login_button" } };
        },
      });
      assert.strictEqual(calls[0].useVisualGrounding, false);
    } finally {
      if (previous === undefined) delete process.env.PHOENIX_ENABLE_VISUAL_GROUNDING;
      else process.env.PHOENIX_ENABLE_VISUAL_GROUNDING = previous;
    }
  });
})();
