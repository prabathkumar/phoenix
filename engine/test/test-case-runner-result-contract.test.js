const assert = require("assert");
const { runScriptSteps } = require("../test-case-runner");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
const fakeOk = async () => ({ success: true, selector: { strategy: "id", value: "a" }, diffSummary: "Something changed.", diff: { appeared: [], disappeared: [] } });

(async () => {
  await test("mobile runScriptSteps also reports the shared pass/fail contract (additive)", async () => {
    const r = await runScriptSteps({}, [
      { kind: "tap", instruction: "one" },
      { kind: "wait", durationMs: 0 },
      { kind: "tap", instruction: "two" },
    ], { platform: "android", executeSemanticAction: fakeOk, sleepFn: async () => {}, testCaseFile: "x.json" });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.platform, "android");
    assert.deepStrictEqual(r.summary, { total: 3, passed: 3, failed: 0, skipped: 0 });
    assert.ok(Array.isArray(r.updatedSteps));
  });

  await test("a failing step -> status fail with that step's reason; optional failure is skipped", async () => {
    let n = 0;
    const exec = async () => { n += 1; return n === 1 ? { success: false, reason: "nope" } : n === 2 ? { success: false, reason: "real" } : fakeOk(); };
    const r = await runScriptSteps({}, [
      { kind: "tap", instruction: "opt", optional: true },
      { kind: "tap", instruction: "must" },
      { kind: "tap", instruction: "never reached" },
    ], { platform: "ios", executeSemanticAction: exec, sleepFn: async () => {} });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.status, "fail");
    assert.deepStrictEqual(r.steps.map((s) => s.status), ["skipped", "fail"]);
    assert.match(r.steps[1].reason, /real/);
  });
  console.log("\nresult-contract tests passed");
})();
