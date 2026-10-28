const assert = require("assert");
const http = require("http");
const { runScriptSteps } = require("../test-case-runner");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
const ok = async () => ({ success: true, selector: { strategy: "id", value: "a" }, diffSummary: "Something changed.", diff: { appeared: [], disappeared: [] } });

(async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/create" ? { id: 99 } : { id: 99, status: "PAID" }));
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  await test("mobile flow: a UI step, then an api step that saves a value, then a typed ${NAME} from it", async () => {
    const typed = [];
    const exec = async (_d, _i, opts) => { if (opts.kind === "type") typed.push(opts.text); return ok(); };
    const r = await runScriptSteps({}, [
      { kind: "tap", instruction: "tap Pay" },
      { kind: "api", method: "POST", url: "/create", expect: { status: 200 }, save: { ORDER_ID: "$.id" } },
      { kind: "type", instruction: "type the order id", text: "${ORDER_ID}" },
      { kind: "api", instruction: "DB says paid", url: "/orders", expect: { json: [{ path: "$.status", equals: "PAID" }] } },
    ], { platform: "android", executeSemanticAction: exec, sleepFn: async () => {}, apiBaseUrl: base });
    assert.strictEqual(r.success, true, r.detail);
    assert.deepStrictEqual(r.steps.map((s) => s.status), ["pass", "pass", "pass", "pass"]);
    assert.deepStrictEqual(typed, ["99"]);
  });

  await test("a failing api check fails the case with the reason and stops", async () => {
    const r = await runScriptSteps({}, [
      { kind: "api", instruction: "must be refunded", url: `${base}/orders`, expect: { json: [{ path: "$.status", equals: "REFUNDED" }] } },
      { kind: "tap", instruction: "never reached" },
    ], { platform: "android", executeSemanticAction: ok, sleepFn: async () => {} });
    assert.strictEqual(r.success, false);
    assert.match(r.detail, /must be refunded.*REFUNDED/);
    assert.strictEqual(r.steps.length, 1);
  });

  await test("test-data layer: fills a flagged body, refuses to start while a must-exist value is missing", async () => {
    let seen;
    const srv2 = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen = b; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); }); });
    await new Promise((r) => srv2.listen(0, r));
    const base2 = `http://127.0.0.1:${srv2.address().port}`;
    const steps = [{ kind: "api", method: "POST", url: "/signup", generateBody: true, body: { email: "a@b.c", token: "t" }, expect: { status: 200 } }];
    const run = (testData) => runScriptSteps({}, steps, { platform: "android", executeSemanticAction: ok, sleepFn: async () => {}, apiBaseUrl: base2, testData, testDataLayer: { seed: "s" } });
    delete process.env.TOKEN;
    const blocked = await run({});
    assert.strictEqual(blocked.success, false);
    assert.match(blocked.detail, /need: TOKEN/);
    assert.strictEqual(seen, undefined);
    const done = await run({ TOKEN: "abc" });
    assert.strictEqual(done.success, true, done.detail);
    const sent = JSON.parse(seen);
    assert.strictEqual(sent.token, "abc");
    assert.match(sent.email, /@example\.com$/);
    assert.ok("generateBody" in done.updatedSteps[0]); // the file's steps keep the flag, never the generated values
    assert.strictEqual(done.updatedSteps[0].body.email, "a@b.c");
    srv2.close();
  });

  await test("without testDataLayer a flagged step is untouched", async () => {
    const r = await runScriptSteps({}, [{ kind: "api", method: "POST", url: `${base}/create`, generateBody: true, body: { email: "a@b.c" }, expect: { status: 200 } }], { platform: "android", executeSemanticAction: ok, sleepFn: async () => {} });
    assert.strictEqual(r.success, true, r.detail);
  });

  srv.close();
  console.log("\nmobile api-step tests passed");
  process.exit(0);
})();
