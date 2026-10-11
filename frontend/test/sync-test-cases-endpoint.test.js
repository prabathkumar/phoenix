const assert = require("assert");
const http = require("http");
const { handleSyncTestCases, handleTestCaseHistory } = require("../sync-test-cases-endpoint");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, () => r(s)); });
const url = (s, p) => `http://localhost:${s.address().port}${p}`;

(async () => {
  await test("sync passes files/message through; failure maps to 422", async () => {
    let seen;
    const ok = await serve((q, r) => handleSyncTestCases(q, r, { syncTestCases: async (a) => { seen = a; return { success: true, committed: true, pushed: true, files: ["a.json"] }; } }));
    const res = await fetch(url(ok, "/"), { method: "POST", body: JSON.stringify({ files: ["a.json"], message: "m" }) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([seen.files, seen.message, seen.push], [["a.json"], "m", true]);
    ok.close();
    const bad = await serve((q, r) => handleSyncTestCases(q, r, { syncTestCases: async () => ({ success: false, error: "secret" }) }));
    assert.strictEqual((await fetch(url(bad, "/"), { method: "POST", body: "{}" })).status, 422);
    bad.close();
  });
  await test("sync rejects a non-array files value with 400", async () => {
    const s = await serve((q, r) => handleSyncTestCases(q, r, { syncTestCases: async () => { throw new Error("must not run"); } }));
    assert.strictEqual((await fetch(url(s, "/"), { method: "POST", body: JSON.stringify({ files: "a.json" }) })).status, 400);
    s.close();
  });
  await test("history requires ?file and returns the list", async () => {
    const s = await serve((q, r) => handleTestCaseHistory(q, r, { testCaseHistory: async ({ file }) => [{ commit: "c1", subject: file }] }));
    assert.strictEqual((await fetch(url(s, "/h"))).status, 400);
    const j = await (await fetch(url(s, "/h?file=login.json"))).json();
    assert.strictEqual(j.history[0].subject, "login.json");
    s.close();
  });
  console.log("\nsync-test-cases-endpoint tests passed");
})();
