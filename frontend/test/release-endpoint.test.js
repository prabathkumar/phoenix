const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path"); const http = require("http");
const { createReleaseEndpoint } = require("../release-endpoint");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-")); fs.mkdirSync(path.join(dir, "p1"), { recursive: true }); fs.writeFileSync(path.join(dir, "p1", "demo.json"), JSON.stringify({ name: "demo", url: "https://s.my", cases: [{ id: "A", steps: ["x"] }] }));
function serve(ep) { return new Promise((ok) => { const srv = http.createServer((q, s) => (q.method === "POST" ? ep.start(q, s) : ep.get(q, s))); srv.listen(0, () => ok(srv)); }); }
const call = (srv, method, url, body, headers = {}) => new Promise((ok) => { const r = http.request({ port: srv.address().port, method, path: url, headers: { "content-type": "application/json", ...headers } }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => ok({ code: res.statusCode, body: JSON.parse(s) })); }); r.end(body ? JSON.stringify(body) : undefined); });
const wait = async (srv, id) => { for (let i = 0; i < 50; i += 1) { const r = await call(srv, "GET", `/api/releases/${id}`); if (r.body.status !== "running") return r; await new Promise((k) => setTimeout(k, 20)); } throw new Error("never finished"); };
(async () => {
  await test("starts a named suite, returns an id at once, result and audit are readable after", async () => {
    let seen; const ep = createReleaseEndpoint({ projectsDir: dir, dataDir: "", token: "", ask: null, runRelease: async (suite, o) => { seen = { suite, o }; o.auditSink({ agent: "planner" }); return { verdict: "PASS", passed: 1, total: 1, audit: [{ agent: "planner" }] }; } });
    const srv = await serve(ep);
    const r = await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo", changed: ["checkout"] });
    assert.strictEqual(r.code, 202);
    const done = await wait(srv, r.body.releaseId);
    assert.strictEqual(done.body.status, "done"); assert.strictEqual(done.body.result.verdict, "PASS"); assert.ok(!done.body.result.audit);
    assert.deepStrictEqual(seen.o.changed, ["checkout"]);
    assert.deepStrictEqual((await call(srv, "GET", `/api/releases/${r.body.releaseId}/audit`)).body.audit, [{ agent: "planner" }]);
    srv.close();
  });
  await test("refuses unknown or path-like suites, a second release at once, and a missing token", async () => {
    let release; const ep = createReleaseEndpoint({ projectsDir: dir, dataDir: "", token: "s3cret", ask: null, runRelease: () => new Promise((ok) => { release = ok; }) });
    const srv = await serve(ep); const auth = { authorization: "Bearer s3cret" };
    assert.strictEqual((await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" })).code, 401);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "../etc/passwd" }, auth)).code, 400);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "nope" }, auth)).code, 404);
    const first = await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" }, auth); assert.strictEqual(first.code, 202);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" }, auth)).code, 409);
    release({ verdict: "PASS", audit: [] }); await new Promise((k) => setTimeout(k, 30)); srv.close();
  });
  await test("project id is the key: required, history and suites are per project, one running release per project", async () => {
    const releasers = []; const out = fs.mkdtempSync(path.join(os.tmpdir(), "relout-")); fs.mkdirSync(path.join(dir, "p2"), { recursive: true }); fs.copyFileSync(path.join(dir, "p1", "demo.json"), path.join(dir, "p2", "demo.json"));
    const ep = createReleaseEndpoint({ projectsDir: dir, dataDir: out, token: "", ask: null, runRelease: (s, o) => new Promise((ok) => { o.onStatus("planner", { status: "done", message: "1 case(s) chosen" }); releasers.push(() => ok({ verdict: "PASS", passed: 1, total: 1, agents: { planner: { status: "done" } }, audit: [] })); }) });
    const srv = await serve(ep);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { suite: "demo" })).code, 400, "no project id, no run");
    const a = await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" }); assert.strictEqual(a.code, 202);
    assert.strictEqual((await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" })).code, 409);
    const b = await call(srv, "POST", "/api/releases", { projectId: "p2", suite: "demo" }); assert.strictEqual(b.code, 202, "another project is not blocked");
    const live = await call(srv, "GET", `/api/releases/${a.body.releaseId}`); assert.strictEqual(live.body.agents.planner.status, "done"); assert.strictEqual(live.body.agents.runner.status, "waiting");
    releasers.forEach((f) => f()); await new Promise((k) => setTimeout(k, 50));
    assert.strictEqual((await call(srv, "GET", "/api/releases?projectId=p1")).body.releases.length, 1);
    assert.strictEqual((await call(srv, "GET", "/api/releases?projectId=p3")).body.releases.length, 0);
    assert.strictEqual((await call(srv, "GET", "/api/projects/p1/suites")).body.suites[0].name, "demo");
    assert.strictEqual((await call(srv, "GET", "/api/projects/nope/suites")).code, 404);
    const ep2 = createReleaseEndpoint({ projectsDir: dir, dataDir: out, token: "", ask: null }); const srv2 = await serve(ep2); // a restart still lists history
    assert.ok((await call(srv2, "GET", "/api/releases?projectId=p1")).body.releases.some((r) => r.releaseId === a.body.releaseId));
    srv.close(); srv2.close();
  });
  await test("a crashing release is reported as an error, not lost", async () => {
    const ep = createReleaseEndpoint({ projectsDir: dir, dataDir: "", token: "", ask: null, runRelease: async () => { throw new Error("browser did not start"); } });
    const srv = await serve(ep); const r = await call(srv, "POST", "/api/releases", { projectId: "p1", suite: "demo" });
    const done = await wait(srv, r.body.releaseId); assert.strictEqual(done.body.status, "error"); assert.match(done.body.error, /browser did not start/); srv.close();
  });
  if (failed) process.exit(1); console.log("release-endpoint tests passed");
})();
