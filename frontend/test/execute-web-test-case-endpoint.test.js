const assert = require("assert");
const http = require("http");
const { handleExecuteWebTestCase } = require("../execute-web-test-case-endpoint");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }

function serve(deps) {
  const server = http.createServer((req, res) => handleExecuteWebTestCase(req, res, deps));
  return new Promise((r) => server.listen(0, () => r(server)));
}
async function post(server, body) {
  const res = await fetch(`http://localhost:${server.address().port}/`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

(async () => {
  await test("rejects a missing/invalid testCase with 400", async () => {
    const s = await serve({ runWebTestCase: async () => { throw new Error("must not run"); } });
    try { const r = await post(s, {}); assert.strictEqual(r.status, 400); } finally { s.close(); }
  });
  await test("returns the runner's shared-contract result and exposes testData only during the run", async () => {
    let seen;
    const s = await serve({ runWebTestCase: async (steps, opts) => { seen = { steps, opts, env: process.env.TESTOPS_WEB_EP_X }; return { status: "pass", success: true, platform: "web" }; } });
    try {
      const r = await post(s, { testCase: { name: "t1", steps: [{ kind: "wait" }] }, baseUrl: "http://x", testData: { TESTOPS_WEB_EP_X: "v" } });
      assert.strictEqual(r.json.status, "pass");
      assert.strictEqual(seen.env, "v");
      assert.strictEqual(seen.opts.baseUrl, "http://x");
      assert.strictEqual(process.env.TESTOPS_WEB_EP_X, undefined, "testData must be restored after the run");
    } finally { s.close(); }
  });
  await test("a runner crash becomes a clean fail result, not a thrown error", async () => {
    const s = await serve({ runWebTestCase: async () => { throw new Error("browser died"); } });
    try { const r = await post(s, { testCase: [{ kind: "wait" }] }); assert.strictEqual(r.json.status, "fail"); assert.match(r.json.detail, /browser died/); } finally { s.close(); }
  });
  await test("with a testopsRef the result is pushed and reported; the outcome is unchanged even if the push fails", async () => {
    let pushed;
    const s = await serve({
      runWebTestCase: async () => ({ status: "fail", success: false, platform: "web", steps: [] }),
      pushResult: async (r, a) => { pushed = [r.status, a]; return { pushed: false, error: "TestOps responded 403" }; },
    });
    try {
      const r = await post(s, { testCase: { testopsRef: "APP-TC-1", steps: [{ kind: "wait" }] }, cycleRef: "APP-TCY-1" });
      assert.strictEqual(r.json.status, "fail");
      assert.deepStrictEqual(pushed, ["fail", { testopsRef: "APP-TC-1", cycleRef: "APP-TCY-1" }]);
      assert.match(r.json.testopsPush.error, /403/);
    } finally { s.close(); }
  });
  await test("no testopsRef -> no push attempted", async () => {
    const s = await serve({ runWebTestCase: async () => ({ status: "pass", success: true }), pushResult: async () => { throw new Error("must not push"); } });
    try { const r = await post(s, { testCase: [{ kind: "wait" }] }); assert.strictEqual(r.json.status, "pass"); assert.strictEqual(r.json.testopsPush, undefined); } finally { s.close(); }
  });
  console.log("\nexecute-web-test-case-endpoint tests passed");
})();
