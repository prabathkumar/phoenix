const assert = require("assert");
const { toTestOpsStatus, validateRefs, buildExecutionPayload, pushResult } = require("../testops-adapter");
const { buildTestResult } = require("../test-result");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
const result = () => buildTestResult({ platform: "web", testCase: "t", startedAt: 1, finishedAt: 5, steps: [
  { index: 0, kind: "tap", instruction: "a", status: "pass" },
  { index: 1, kind: "tap", instruction: "b", status: "fail", reason: "nope" },
  { index: 2, kind: "tap", instruction: "c", status: "skipped" },
] });

(async () => {
  await test("status mapping, unknown -> NOT_RUN", () => {
    assert.deepStrictEqual(["pass", "fail", "skipped", undefined, "weird"].map(toTestOpsStatus), ["PASSED", "FAILED", "SKIPPED", "NOT_RUN", "NOT_RUN"]);
  });
  await test("ref validation", () => {
    assert.strictEqual(validateRefs({ testopsRef: "APP-TC-1" }), null);
    assert.strictEqual(validateRefs({ testopsRef: "APP-TC-1", cycleRef: "APP-TCY-1" }), null);
    assert.match(validateRefs({ testopsRef: "login" }), /APP-TC-1/);
    assert.match(validateRefs({ testopsRef: "APP-TC-1", cycleRef: "x" }), /APP-TCY-1/);
  });
  await test("payload carries mapped case + step statuses and reasons", () => {
    const p = buildExecutionPayload(result(), { testopsRef: "APP-TC-1", cycleRef: "APP-TCY-1" });
    assert.strictEqual(p.status, "FAILED");
    assert.deepStrictEqual(p.steps.map((s) => s.status), ["PASSED", "FAILED", "SKIPPED"]);
    assert.strictEqual(p.steps[1].reason, "nope");
    assert.strictEqual(p.testCaseRef, "APP-TC-1");
  });
  await test("push: bad ref / no URL -> not pushed, never throws, post never called", async () => {
    let called = 0; const post = async () => { called++; return { ok: true }; };
    assert.strictEqual((await pushResult(result(), { testopsRef: "bad", env: {}, post })).pushed, false);
    const r = await pushResult(result(), { testopsRef: "APP-TC-1", env: {}, post });
    assert.strictEqual(r.pushed, false); assert.match(r.reason, /TESTOPS_URL/);
    assert.strictEqual(called, 0);
  });
  await test("push: sends bearer token + payload; HTTP error and network error are reported, not thrown", async () => {
    let seen;
    const ok = await pushResult(result(), { testopsRef: "APP-TC-1", env: { TESTOPS_MOBILE_TESTOPS_URL: "http://t/x", TESTOPS_MOBILE_TESTOPS_TOKEN: "tok" }, post: async (u, t, b) => { seen = [u, t, b]; return { ok: true }; } });
    assert.strictEqual(ok.pushed, true); assert.deepStrictEqual(seen.slice(0, 2), ["http://t/x", "tok"]);
    const http = await pushResult(result(), { testopsRef: "APP-TC-1", env: { TESTOPS_MOBILE_TESTOPS_URL: "u" }, post: async () => ({ ok: false, status: 403, text: "no" }) });
    assert.match(http.error, /403/);
    const net = await pushResult(result(), { testopsRef: "APP-TC-1", env: { TESTOPS_MOBILE_TESTOPS_URL: "u" }, post: async () => { throw new Error("ECONNREFUSED"); } });
    assert.match(net.error, /ECONNREFUSED/);
  });
  console.log("\ntestops-adapter tests passed");
})();
