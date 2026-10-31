const assert = require("node:assert");
const { runExecution } = require("../exec-endpoint");
(async () => {
  const none = await runExecution({});
  assert.strictEqual(none.unavailable, true);
  const calls = [];
  const english = async (a) => { calls.push(a); return a.platform === "web" ? { status: "failed", passed: 1, failed: 1, steps: [{ status: "failed", text: "click Buy", reason: "not found" }], where: "local Chrome" } : { status: "passed", passed: 2, failed: 0, steps: [] }; };
  const r = await runExecution({ runId: "run-1", testData: { PW: "secret1234" }, web: { steps: "open the page", url: "http://x" }, mobile: { platform: "android", steps: "tap login" } }, { englishRun: english, env: { PHOENIX_DATA_DIR: require("os").tmpdir() } });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.failedCases.length, 1); assert.match(r.harPath, /run-1\.har$/);
  assert.ok(!JSON.stringify(r).includes("secret1234"), "test data values are never returned");
  assert.strictEqual(calls.length, 2);
  console.log("exec-endpoint tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
(async () => {
  const english = async (a) => a.steps.includes("bad") ? { status: "failed", steps: [{ status: "failed", reason: "no field" }], where: "local" } : { status: "passed", steps: [], where: "local" };
  const r = await runExecution({ web: { url: "http://x" }, cases: [{ id: "TC-1", name: "ok", platform: "web", steps: "open" }, { id: "TC-2", name: "bad one", platform: "web", steps: "bad step" }] }, { englishRun: english });
  assert.deepStrictEqual(r.results.map((x) => [x.id, x.result]), [["TC-1", "passed"], ["TC-2", "failed"]]);
  assert.strictEqual(r.failedCases[0].id, "TC-2"); assert.strictEqual(r.ok, false);
  console.log("exec-endpoint per-case tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
