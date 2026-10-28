const assert = require("assert");
const http = require("http");
const { runApiCases } = require("../core/api-cases");
const { stepsFromOpenApi, stepsFromPostman } = require("../core/api-import");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

const DOC = { openapi: "3.0.0", paths: { "/users": { post: { summary: "Create user", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/U" } } } }, responses: { 201: {} } } },
  "/users/{userId}": { get: { summary: "Get user", security: [{ bearer: [] }], responses: { 200: {} } } } },
  components: { schemas: { U: { type: "object", properties: { email: { type: "string", format: "email" }, age: { type: "integer", minimum: 18, maximum: 99 } } } } } };

(async () => {
  // A server that validates the body the way a correct API should (or not, when lax).
  let lax = false; const hits = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      let j; try { j = JSON.parse(b); } catch { /* none */ }
      hits.push({ url: req.url, auth: req.headers.authorization, body: j });
      const valid = lax || (j && typeof j.email === "string" && /@/.test(j.email) && Number.isInteger(j.age) && j.age >= 18 && j.age <= 99);
      res.writeHead(req.method === "GET" ? 200 : valid ? 201 : 422, { "Content-Type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;

  await test("openapi: operations become flagged steps; refs resolved, path params and bearer mapped", () => {
    const steps = stepsFromOpenApi(DOC);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].generateBody, true);
    assert.strictEqual(steps[0].schema.properties.age.minimum, 18);
    assert.deepStrictEqual(steps[0].expect.status, [201]);
    assert.strictEqual(steps[1].url, "/users/${USER_ID}");
    assert.strictEqual(steps[1].headers.Authorization, "Bearer ${API_TOKEN}");
    assert.throws(() => stepsFromOpenApi({}), /OpenAPI/);
  });

  await test("postman: variables become ${NAME}, base url dropped, body flagged", () => {
    const steps = stepsFromPostman({ item: [{ name: "f", item: [{ name: "Pay", request: { method: "POST", url: { raw: "{{baseUrl}}/pay/{{orderId}}" }, header: [{ key: "X-Key", value: "{{apiKey}}" }], body: { mode: "raw", raw: '{"amt":5,"tok":"{{token}}"}' } } }] }] });
    assert.strictEqual(steps[0].url, "/pay/${ORDER_ID}");
    assert.strictEqual(steps[0].headers["X-Key"], "${API_KEY}");
    assert.strictEqual(steps[0].body.tok, "${TOKEN}");
    assert.strictEqual(steps[0].generateBody, true);
    assert.throws(() => stepsFromPostman({}), /Postman/);
  });

  await test("a correct API passes the good case and every negative case", async () => {
    const steps = stepsFromOpenApi(DOC, { only: ["POST /users"] });
    const r = await runApiCases({ steps, baseUrl, negative: true, seed: "k" });
    assert.strictEqual(r.failed, 0, JSON.stringify(r));
    assert.strictEqual(r.negatives.length, 5);
    const good = hits.find((h) => h.body && h.body.email && Number.isInteger(h.body.age));
    assert.ok(good && good.body.age >= 18 && good.body.age <= 99);
  });

  await test("a lax API (accepts bad bodies) fails its negative cases, and says which", async () => {
    lax = true;
    const steps = stepsFromOpenApi(DOC, { only: ["POST /users"] });
    const r = await runApiCases({ steps, baseUrl, negative: true, seed: "k" });
    assert.strictEqual(r.main.success, true);
    assert.strictEqual(r.failed, 5);
    assert.match(r.negatives[0].detail, /expected status .*but got 201/);
    lax = false;
  });

  await test("a secured operation stops before running when the token is missing, and runs with it", async () => {
    delete process.env.API_TOKEN;
    const steps = stepsFromOpenApi(DOC, { only: ["GET /users/{userId}"] });
    const blocked = await runApiCases({ steps, baseUrl, testData: {} });
    assert.strictEqual(blocked.main.success, false);
    assert.match(blocked.main.detail, /need: USER_ID, API_TOKEN/);
    const ok = await runApiCases({ steps, baseUrl, testData: { USER_ID: "7", API_TOKEN: "tok-123" } });
    assert.strictEqual(ok.main.success, true, ok.main.detail);
    assert.strictEqual(hits[hits.length - 1].auth, "Bearer tok-123");
  });

  srv.close();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nengine/api-cases tests passed");
})();
