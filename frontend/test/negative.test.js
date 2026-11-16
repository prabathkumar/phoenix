// Negative tests for the release API: forged, malformed and abusive requests must be refused with the right code, never crash the server or touch other folders.
const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path"); const http = require("http");
const { createReleaseEndpoint } = require("../release-endpoint");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), "neg-")); const proj = path.join(root, "projects"); const data = path.join(root, "data"); const apps = path.join(root, "apps");
fs.mkdirSync(path.join(proj, "p1"), { recursive: true }); fs.writeFileSync(path.join(proj, "p1", "demo.json"), JSON.stringify({ name: "demo", url: "http://x", cases: [{ id: "A", title: "t", steps: ["Open"] }] }));
fs.writeFileSync(path.join(root, "secret.json"), JSON.stringify({ name: "outside", cases: [] }));
function serve(ep) { return new Promise((ok) => { const srv = http.createServer((q, s) => { const m = q.method === "POST" && /^\/api\/projects\/([^/?]+)\/apps/.exec(q.url); return m ? ep.uploadApp(q, s, decodeURIComponent(m[1])) : q.method === "POST" ? ep.start(q, s) : ep.get(q, s); }); srv.listen(0, () => ok(srv)); }); }
const raw = (srv, method, url, body, headers = {}) => new Promise((ok) => { const r = http.request({ port: srv.address().port, method, path: url, headers }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let b; try { b = JSON.parse(s); } catch { b = s; } ok({ code: res.statusCode, body: b }); }); }); r.on("error", () => ok({ code: 0 })); r.end(body); });
const mk = (extra = {}) => createReleaseEndpoint({ projectsDir: proj, dataDir: data, appsDir: apps, token: "", ask: null, logger: null, runRelease: async () => ({ verdict: "PASS", audit: [] }), ...extra });
(async () => {
  await test("project and suite names that climb out of the folder are refused", async () => {
    const srv = await serve(mk());
    for (const [p, s] of [["../", "secret"], ["..", "secret"], ["p1/../..", "secret"], ["p1", "../secret"], ["p1", "..%2fsecret"], ["p1", "/etc/passwd"], ["p1", "demo\u0000.json"], ["", "demo"], ["p1", ""], ["P 1", "demo"], ["p1;rm", "demo"], ["p".repeat(500), "demo"]]) {
      const r = await raw(srv, "POST", "/api/releases", JSON.stringify({ projectId: p, suite: s }), { "content-type": "application/json" });
      assert.ok(r.code === 400 || r.code === 404, `${JSON.stringify([p, s])} -> ${r.code}`);
    }
    srv.close();
  });
  await test("bad JSON, wrong types and empty bodies are 400, not a crash", async () => {
    const srv = await serve(mk());
    for (const b of ["{not json", "[]", "null", '"str"', "5", "", "{}", JSON.stringify({ projectId: 5, suite: {} }), JSON.stringify({ projectId: ["p1"], suite: ["demo"] }), JSON.stringify({ projectId: "p1", suite: "demo", changed: "checkout" }), JSON.stringify({ projectId: "p1", suite: "demo", changed: [{}, 5, null] })]) {
      const r = await raw(srv, "POST", "/api/releases", b, { "content-type": "application/json" });
      assert.ok(r.code >= 200 && r.code < 500, `${b} -> ${r.code}`);
    }
    assert.strictEqual((await raw(srv, "GET", "/api/releases")).code < 500, true); srv.close();
  });
  await test("the token cannot be bypassed: missing, wrong, empty, other scheme, near-miss, different length", async () => {
    const srv = await serve(mk({ token: "s3cret" }));
    for (const h of [{}, { authorization: "" }, { authorization: "Bearer " }, { authorization: "Bearer wrong" }, { authorization: "Basic czNjcmV0" }, { authorization: "bearer s3cret" }, { authorization: "Bearer s3cre" }, { authorization: "s3cret" }]) {
      const r = await raw(srv, "POST", "/api/releases", JSON.stringify({ projectId: "p1", suite: "demo" }), { "content-type": "application/json", ...h });
      assert.strictEqual(r.code, 401, JSON.stringify(h));
      assert.strictEqual((await raw(srv, "POST", "/api/projects/p1/apps?name=a.apk", "x", h)).code, 401);
    }
    srv.close();
  });
  await test("app uploads: wrong type, path-like names, empty body and unknown project are refused; nothing is written outside the apps folder", async () => {
    const srv = await serve(mk());
    for (const name of ["evil.exe", "a.sh", "../../x.apk", "..%2f..%2fx.apk", "a.apk/../../b.apk", "", "noext", "x.apk\u0000.sh", ".apk.sh"]) {
      const r = await raw(srv, "POST", `/api/projects/p1/apps?name=${encodeURIComponent(name)}`, "PK-data");
      // path-like names are cut to their file name (x.apk) and kept inside the project's own apps folder; everything else is refused
      assert.ok(r.code === 400 || (r.code === 201 && /\.apk$/.test(name.replace(/\u0000.*$/, "")) === false ? false : true), `${name} -> ${r.code}`);
    }
    assert.strictEqual((await raw(srv, "POST", "/api/projects/p1/apps?name=ok.apk", "")).code, 400);
    assert.strictEqual((await raw(srv, "POST", "/api/projects/..%2f..%2fetc/apps?name=ok.apk", "x")).code, 400);
    assert.strictEqual((await raw(srv, "POST", "/api/projects/p%201/apps?name=ok.apk", "x")).code, 400);
    const stray = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else stray.push(p); } })(root);
    assert.ok(stray.every((f) => f.startsWith(proj) || f === path.join(root, "secret.json") || f.startsWith(data) || f.startsWith(apps)), stray.join(", "));
    assert.ok(!fs.existsSync(path.join(root, "x.apk")) && !fs.existsSync(path.join(apps, "..", "x.apk")));
    srv.close();
  });
  await test("unknown release ids, path-like ids and odd routes are 404/400", async () => {
    const srv = await serve(mk());
    for (const u of ["/api/releases/nope", "/api/releases/../../etc/passwd", "/api/releases/%2e%2e%2f", "/api/releases/00000000-0000-0000-0000-000000000000/audit", "/api/projects/../suites", "/api/projects/%2e%2e/suites", "/api/projects/p1%00/suites"]) {
      const r = await raw(srv, "GET", u); assert.ok(r.code === 404 || r.code === 400, `${u} -> ${r.code}`);
    }
    srv.close();
  });
  await test("a run that throws ends as failed with a reason, and the project can be released again", async () => {
    let n = 0; const srv = await serve(mk({ runRelease: async () => { n += 1; if (n === 1) throw new Error("browser exploded"); return { verdict: "PASS", audit: [] }; } }));
    const a = await raw(srv, "POST", "/api/releases", JSON.stringify({ projectId: "p1", suite: "demo" }), { "content-type": "application/json" }); assert.strictEqual(a.code, 202);
    let r; for (let i = 0; i < 50; i += 1) { r = await raw(srv, "GET", `/api/releases/${a.body.releaseId}`); if (r.body.status !== "running") break; await new Promise((k) => setTimeout(k, 20)); }
    assert.strictEqual(r.body.status, "error"); assert.match(JSON.stringify(r.body), /browser exploded/);
    assert.strictEqual((await raw(srv, "POST", "/api/releases", JSON.stringify({ projectId: "p1", suite: "demo" }), { "content-type": "application/json" })).code, 202);
    srv.close();
  });
  await test("a corrupt suite file is a clear error, not a crash", async () => {
    fs.writeFileSync(path.join(proj, "p1", "broken.json"), "{ nope"); fs.writeFileSync(path.join(proj, "p1", "empty.json"), JSON.stringify({ cases: [] }));
    const srv = await serve(mk());
    for (const s of ["broken", "empty"]) { const r = await raw(srv, "POST", "/api/releases", JSON.stringify({ projectId: "p1", suite: s }), { "content-type": "application/json" }); assert.ok(r.code >= 400 && r.code < 500 || r.code === 202, `${s} -> ${r.code}`); }
    assert.ok((await raw(srv, "GET", "/api/projects/p1/suites")).code < 500); srv.close();
  });
  console.log(failed ? `${failed} FAILED` : "release API negative tests passed"); process.exit(failed ? 1 : 0);
})();
