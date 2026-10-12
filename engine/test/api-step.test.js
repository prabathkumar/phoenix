const assert = require("assert");
const http = require("http");
const { executeApiStep, validateApiStep } = require("../core/api-step");
const { readPath } = require("../core/json-path");
const { interpolate } = require("../core/vars");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

(async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/orders/42") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: 42, status: "PAID", items: [{ sku: "A1" }], email: "a@b.c" })); }
      else if (req.url === "/orders") { res.writeHead(201, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: 7 })); }
      else if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 500); }
      else { res.writeHead(500); res.end("boom"); }
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  await test("readPath reads nested keys and indexes, not wildcards", () => {
    const o = { a: { b: [{ c: 5 }] } };
    assert.deepStrictEqual(readPath(o, "$.a.b[0].c"), { found: true, value: 5 });
    assert.deepStrictEqual(readPath(o, "a.b[0].c"), { found: true, value: 5 });
    assert.strictEqual(readPath(o, "$.a.x").found, false);
  });

  await test("interpolate uses saved vars first, then env, and names what is missing", () => {
    assert.strictEqual(interpolate("/o/${ID}", { vars: { ID: 9 }, env: {} }), "/o/9");
    assert.strictEqual(interpolate("Bearer ${T}", { vars: {}, env: { T: "x" } }), "Bearer x");
    assert.throws(() => interpolate("${MISSING}", { vars: {}, env: {} }), /MISSING/);
  });

  await test("a DB-validation style call passes: status + json checks, secret header is redacted in the result", async () => {
    const r = await executeApiStep({
      method: "GET", url: "/orders/${ORDER_ID}", headers: { Authorization: "Bearer ${TOKEN}" },
      expect: { status: 200, json: [{ path: "$.status", equals: "PAID" }, { path: "$.items", exists: true }, { path: "$.email", contains: "@" }] },
    }, { baseUrl: base, vars: { ORDER_ID: 42, TOKEN: "s3cret" } });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(seen.at(-1).auth, "Bearer s3cret");
    assert.strictEqual(r.request.headers.Authorization, "***");
  });

  await test("a wrong value fails with a precise reason", async () => {
    const r = await executeApiStep({ url: `${base}/orders/42`, expect: { json: [{ path: "$.status", equals: "REFUNDED" }] } });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /\$\.status: expected "REFUNDED" but got "PAID"/);
  });

  await test("save writes response values into vars for later steps; POST sends JSON", async () => {
    const ctx = { baseUrl: base, vars: {} };
    const r = await executeApiStep({ method: "POST", url: "/orders", body: { sku: "A1" }, expect: { status: 201 }, save: { ORDER_ID: "$.id" } }, ctx);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(ctx.vars.ORDER_ID, 7);
    assert.strictEqual(seen.at(-1).body, '{"sku":"A1"}');
  });

  await test("with no checks a 5xx still fails; a timeout is reported", async () => {
    assert.strictEqual((await executeApiStep({ url: `${base}/nope` })).ok, false);
    const t = await executeApiStep({ url: `${base}/slow`, timeoutMs: 100 });
    assert.strictEqual(t.ok, false);
    assert.match(t.reason, /timed out/);
  });

  await test("unset variable and malformed steps fail cleanly (no throw)", async () => {
    const r = await executeApiStep({ url: `${base}/orders/\${NOPE}` }, { vars: {}, env: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /NOPE/);
    assert.match(validateApiStep({ method: "GET" }), /no "url"/);
    assert.match(validateApiStep({ url: "x", save: { "bad name": "$.a" } }), /invalid "save"/);
  });

  srv.close();
  if (failed) { console.error("\napi-step tests FAILED"); process.exit(1); }
  console.log("\napi-step tests passed"); process.exit(0);
})();
