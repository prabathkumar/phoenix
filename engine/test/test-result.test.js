const assert = require("assert");
const { buildTestResult } = require("../test-result");

const step = (i, status, extra = {}) => ({ index: i, kind: "tap", instruction: `s${i}`, status, ...extra });

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }

test("all pass -> pass", () => {
  const r = buildTestResult({ platform: "web", steps: [step(0, "pass"), step(1, "pass")] });
  assert.strictEqual(r.status, "pass");
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.summary, { total: 2, passed: 2, failed: 0, skipped: 0 });
});
test("any fail -> fail, detail names the first failing step", () => {
  const r = buildTestResult({ platform: "ios", steps: [step(0, "pass"), step(1, "fail", { reason: "boom" }), step(2, "fail", { reason: "later" })] });
  assert.strictEqual(r.status, "fail");
  assert.match(r.detail, /step 1 "s1" failed: boom/);
});
test("skipped steps do not fail the case", () => {
  const r = buildTestResult({ platform: "android", steps: [step(0, "skipped"), step(1, "pass")] });
  assert.strictEqual(r.status, "pass");
  assert.match(r.detail, /1 skipped/);
});
test("zero steps, or only skipped steps -> fail (nothing proven)", () => {
  assert.strictEqual(buildTestResult({ platform: "web", steps: [] }).status, "fail");
  assert.strictEqual(buildTestResult({ platform: "web", steps: [step(0, "skipped")] }).status, "fail");
});
test("run-level error -> fail even if steps passed", () => {
  const r = buildTestResult({ platform: "web", steps: [step(0, "pass")], error: "session lost" });
  assert.strictEqual(r.status, "fail");
  assert.match(r.detail, /session lost/);
});
test("durationMs computed; invalid status rejected", () => {
  assert.strictEqual(buildTestResult({ platform: "web", steps: [step(0, "pass")], startedAt: 10, finishedAt: 50 }).durationMs, 40);
  assert.throws(() => buildTestResult({ platform: "web", steps: [step(0, "maybe")] }), /invalid step status/);
});
test("a lone failing step reports ITS reason, not 'nothing was proven'", () => {
  const r = buildTestResult({ platform: "web", steps: [step(0, "fail", { reason: "real reason" })] });
  assert.match(r.detail, /real reason/);
});
console.log("\nengine/test-result tests passed");
