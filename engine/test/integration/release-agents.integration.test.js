/**
 * Integration tests: real Chromium + real page reading + real goal loop + real agents + real release API,
 * against the local fake store (no internet, no live shop). Rules only: the model is pointed at a closed port, so any step that
 * would need it fails fast instead of hanging.
 *   node engine/test/integration/release-agents.integration.test.js
 */
process.env.TESTOPS_MOBILE_OLLAMA_HOST = "http://127.0.0.1:9";
process.env.TESTOPS_MOBILE_LLM_TIMEOUT_MS = "1500";
process.env.PHOENIX_DATA_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "phx-int-"));
const assert = require("node:assert");
const fs = require("fs"); const path = require("path"); const http = require("http");
const { start } = require("./fake-store");
const { runSuite } = require("../../suite-run");
const { runRelease } = require("../../agents/release");
const { createReleaseEndpoint } = require("../../../frontend/release-endpoint");

let failed = 0; async function test(n, f) { const t = Date.now(); try { await f(); console.log(`  ok - ${n} (${Math.round((Date.now() - t) / 1000)}s)`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }

const journey = (device, extra = []) => ["Click the Devices menu", "Click Explore Devices", `Click Buy now on the ${device}`, "Select 256GB", "Click New Line", "Select the Infinite+ payment plan", "Select 24 Months", "Select Infinite+ Ultra", "Click Next", ...extra];
const suiteFor = (url, cases) => ({ name: "fake store", url, cases });

(async () => {
  const store = await start();
  try {
    await test("page reader: a short product card (name + Buy now) is still a card, so Buy now on a named product finds its own button", async () => {
      const { chromium } = require("../../../web/node_modules/playwright");
      const { createPlaywrightSurface } = require("../../../web/surface/playwright-surface");
      const { domMatch } = require("../../core/named-target");
      const b = await chromium.launch(); try {
        const p = await b.newPage(); await p.goto(store.url + "/devices");
        const els = await createPlaywrightSurface(p).snapshot();
        assert.ok(els.every((e) => e.within), "every Buy now knows its card");
        const m = domMatch("Click Buy now on the Cirrus X3", els); assert.ok(m && m.element, JSON.stringify(m));
        assert.match(m.element.within, /Cirrus X3/);
      } finally { await b.close(); }
    });

    await test("runSuite on a real browser: pass, blocked-by-site, failed, and a banner on the home page does not stop the journey", async () => {
      const suite = suiteFor(store.url, [
        { id: "OK", steps: journey("Aurora X1", ["Check that the page says Order summary", "Check that no error is showing"]) },
        { id: "SOLD", steps: journey("Borealis X2") },
        { id: "MISSING", steps: ["Click the Devices menu", "Click Explore Devices", "Click Buy now on the Aurora X1", "Select 999GB"] },
      ]);
      const r = await runSuite(suite, { log: () => {} });
      const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
      assert.strictEqual(by.OK.verdict, "passed", JSON.stringify(by.OK.steps.filter((s) => s.status !== "passed")));
      assert.strictEqual(by.SOLD.verdict, "blocked-by-site", by.SOLD.reason); assert.match(by.SOLD.reason, /Sold out online/);
      assert.strictEqual(by.MISSING.verdict, "failed"); assert.strictEqual(by.MISSING.failedStep, "Select 999GB");
      assert.ok(by.SOLD.seconds < 40, "a sold-out product stops quickly");
    });

    await test("a check step catches a page that ends in an error although every tap worked", async () => {
      const r = await runSuite(suiteFor(store.url, [{ id: "ERR", steps: journey("Delta X4", ["Check that no error is showing"]) }]), { log: () => {} });
      assert.strictEqual(r.results[0].verdict, "failed"); assert.match(r.results[0].reason, /Something went wrong/);
      assert.strictEqual(r.results[0].steps.filter((s) => s.status === "passed").length, 9, "every tap before the check passed");
    });

    await test("full release: all agents report, Healer turns a one-off failure into flaky, Performance and Security warn, audit trail is complete", async () => {
      store.hits.three = 0; const statuses = [];
      const res = await runRelease(suiteFor(store.url, [
        { id: "OK", steps: journey("Aurora X1", ["Check that no error is showing"]) },
        { id: "FLAKY", steps: journey("Cirrus X3", ["Check that no error is showing"]) },
        { id: "SOLD", steps: journey("Borealis X2") },
      ]), { onStatus: (id, a) => statuses.push(`${id}:${a.status}`), runOpts: { log: () => {} } });
      const by = Object.fromEntries(res.results.map((x) => [x.id, x]));
      assert.strictEqual(by.OK.verdict, "passed");
      assert.strictEqual(by.FLAKY.verdict, "passed", JSON.stringify([by.FLAKY.reason, by.FLAKY.failedStep, by.FLAKY.firstAttempt])); assert.ok(by.FLAKY.flaky, "passed only on the Healer's retry"); assert.match(by.FLAKY.firstAttempt.reason, /Something went wrong|not found|disabled|no match/i);
      assert.strictEqual(by.SOLD.verdict, "blocked-by-site"); assert.match(by.SOLD.triage, /live site (itself said|refused the journey)/);
      assert.strictEqual(res.verdict, "PASS-WITH-GAPS");
      for (const id of ["planner", "runner", "performance", "security", "triage", "healer", "reporter"]) assert.ok(["done"].includes(res.agents[id].status), `${id}: ${res.agents[id].status} ${res.agents[id].message}`);
      assert.ok(res.checks.find((c) => c.agent === "performance").metrics.loadMs >= 0);
      assert.ok(res.gaps.some((g) => g.id === "security" && /Content-Security-Policy/.test(g.why)), "the local store sends no security headers");
      assert.ok(res.gaps.some((g) => g.id === "security" && /cookie sid is missing Secure/.test(g.why)));
      assert.deepStrictEqual([...new Set(res.audit.map((e) => e.agent))].sort(), ["healer", "performance", "planner", "reporter", "runner", "security", "triage"]);
      assert.ok(statuses.indexOf("planner:done") < statuses.indexOf("runner:done") && statuses.indexOf("runner:done") < statuses.indexOf("reporter:done"), "agents report in order");
    });

    await test("release API end to end: project-keyed suite on disk, started with one POST, polled to the verdict, history and audit read back", async () => {
      const projects = fs.mkdtempSync(path.join(require("os").tmpdir(), "phx-proj-")); fs.mkdirSync(path.join(projects, "fakeshop"));
      fs.writeFileSync(path.join(projects, "fakeshop", "smoke.json"), JSON.stringify(suiteFor(store.url, [{ id: "OK", steps: journey("Aurora X1", ["Check that the page says Order summary"]) }])));
      const ep = createReleaseEndpoint({ projectsDir: projects, dataDir: path.join(process.env.PHOENIX_DATA_DIR, "release-runs"), token: "tok", ask: null });
      const srv = await new Promise((ok) => { const s = http.createServer((q, r) => (q.method === "POST" ? ep.start(q, r) : ep.get(q, r))); s.listen(0, "127.0.0.1", () => ok(s)); });
      const call = (method, url, body, auth = true) => new Promise((ok) => { const r = http.request({ port: srv.address().port, method, path: url, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer tok" } : {}) } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ code: res.statusCode, body: JSON.parse(b) })); }); r.end(body ? JSON.stringify(body) : undefined); });
      try {
        assert.strictEqual((await call("POST", "/api/releases", { projectId: "fakeshop", suite: "smoke" }, false)).code, 401);
        const started = await call("POST", "/api/releases", { projectId: "fakeshop", suite: "smoke", security: false });
        assert.strictEqual(started.code, 202);
        let rec; for (let i = 0; i < 120; i += 1) { rec = (await call("GET", `/api/releases/${started.body.releaseId}`)).body; if (rec.status !== "running") break; await new Promise((k) => setTimeout(k, 500)); }
        assert.strictEqual(rec.status, "done", rec.error); assert.strictEqual(rec.result.verdict, "PASS", JSON.stringify(rec.result.gaps)); assert.strictEqual(rec.agents.security.status, "skipped"); assert.strictEqual(rec.agents.runner.roster.name, "runner");
        const hist = (await call("GET", "/api/releases?projectId=fakeshop")).body.releases; assert.strictEqual(hist.length, 1); assert.strictEqual(hist[0].verdict, "PASS");
        const audit = (await call("GET", `/api/releases/${started.body.releaseId}/audit`)).body.audit; assert.ok(audit.some((e) => e.agent === "reporter"));
        assert.ok(fs.existsSync(path.join(process.env.PHOENIX_DATA_DIR, "release-runs", "fakeshop", `release-${started.body.releaseId}.json`)), "result saved under the project");
      } finally { srv.close(); }
    });
  } finally { await store.close(); }
  if (failed) process.exit(1); console.log("integration tests passed");
})();
