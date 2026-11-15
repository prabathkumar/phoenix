const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path"); const http = require("http");
const { createReleaseEndpoint } = require("../release-endpoint");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-")); fs.writeFileSync(path.join(dir, "demo.json"), JSON.stringify({ name: "demo", url: "https://s.my", cases: [{ id: "A", steps: ["x"] }] }));
function serve(ep) { return new Promise((ok) => { const srv = http.createServer((q, s) => (q.method === "POST" ? ep.start(q, s) : ep.get(q, s))); srv.listen(0, () => ok(srv)); }); }
const call = (srv, method, url, body, headers = {}) => new Promise((ok) => { const r = http.request({ port: srv.address().port, method, path: url, headers: { "content-type": "application/json", ...headers } }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => ok({ code: res.statusCode, body: JSON.parse(s) })); }); r.end(body ? JSON.stringify(body) : undefined); });
const wait = async (srv, id) => { for (let i = 0; i < 50; i += 1) { const r = await call(srv, "GET", `/api/releases/${id}`); if (r.body.status !== "running") return r; await new Promise((k) => setTimeout(k, 20)); } throw new Error("never finished"); };
(async () => {
  await test("starts a named suite, returns an id at once, result and audit are readable after", async () => {
    let seen; const ep = createReleaseEndpoint({ suiteDir: dir, dataDir: "", token: "", ask: null, runRelease: async (suite, o) => { seen = { suite, o }; o.auditSink({ agent: "planner" }); return { verdict: "PASS", passed: 1, total: 1, audit: [{ agent: "planner" }] }; } });
    const srv = await serve(ep);
    const r = await call(srv, "POST", "/api/releases", { suite: "demo", changed: ["checkout"] });
    assert.strictEqual(r.code, 202);
    const done = await wait(srv, r.body.releaseId);
    assert.strictEqual(done.body.status, "done"); assert.strictEqual(done.body.result.verdict, "PASS"); assert.ok(!done.body.result.audit);
    assert.deepStrictEqual(seen.o.changed, ["checkout"]);
    assert.deepStrictEqual((await call(srv, "GET", `/api/releases/${r.body.releaseId}/audit`)).body.audit, [{ agent: "planner" }]);
    srv.close();
  });
  await test("refuses unknown or path-like suites, a second release at once, and a missing token", async () => {
    let release; const ep = createReleaseEndpoint({ suiteDir: dir, dataDir: "", token: "s3cret", ask: null, runRelease: () => new Promise((ok) => { release = ok; }) });
    const srv = await serve(ep); const auth = { authorization: "Bearer s3cret" };
    assert.strictEqual((await call(srv, "POST", "/api/releases", { suite: "demo" })).code, 401);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { suite: "../etc/passwd" }, auth)).code, 400);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { suite: "nope" }, auth)).code, 404);
    const first = await call(srv, "POST", "/api/releases", { suite: "demo" }, auth); assert.strictEqual(first.code, 202);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { suite: "demo" }, auth)).code, 409);
    release({ verdict: "PASS", audit: [] }); await new Promise((k) => setTimeout(k, 30)); srv.close();
  });
  await test("a crashing release is reported as an error, not lost", async () => {
    const ep = createReleaseEndpoint({ suiteDir: dir, dataDir: "", token: "", ask: null, runRelease: async () => { throw new Error("browser did not start"); } });
    const srv = await serve(ep); const r = await call(srv, "POST", "/api/releases", { suite: "demo" });
    const done = await wait(srv, r.body.releaseId); assert.strictEqual(done.body.status, "error"); assert.match(done.body.error, /browser did not start/); srv.close();
  });
  if (failed) process.exit(1); console.log("release-endpoint tests passed");
})();
