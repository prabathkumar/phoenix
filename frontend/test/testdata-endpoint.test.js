/** Test-data layer over HTTP: the plan route, and the English run refusing to start while a login is missing. */
const assert = require("assert");
const http = require("http");
const os = require("os"), path = require("path"), fs = require("fs");
const { handlePlan, handleApiPlan, handleApiRun, handleSave, handleSaved } = require("../testdata-endpoint");
const { createEnglishEndpoint } = require("../english-endpoint");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

const STEPS = "Enter ${LOGIN_PHONE} in the phone field\nEnter ${LOGIN_PASSWORD} in the password field\nEnter ${EMAIL} in the email field";

(async () => {
  const seen = [];
  const ep = createEnglishEndpoint({
    startMobile: async () => ({ takeScreenshot: async () => "PNG", deleteSession: async () => {} }),
    mobileRunner: () => ({ goal: async (t) => { seen.push(t); return { success: true, actions: [{ label: "x" }] }; }, screenshot: async () => ({ base64: "PNG", mime: "image/png" }) }),
  });
  const app = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/test-data/plan") return handlePlan(req, res);
    if (req.method === "POST" && req.url === "/api/test-data/api-plan") return handleApiPlan(req, res);
    if (req.method === "POST" && req.url === "/api/api-cases/run") return handleApiRun(req, res);
    if (req.method === "POST" && req.url === "/api/test-data/save") return handleSave(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/test-data/saved")) return handleSaved(req, res);
    if (req.method === "POST" && req.url === "/api/english-runs") return ep.handleStart(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  const post = (path, obj) => new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const r = http.request({ port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    r.on("error", reject); r.end(data);
  });
  const withEnvCleared = async (fn) => { const keep = { ...process.env }; for (const k of ["LOGIN_PHONE", "LOGIN_PASSWORD", "EMAIL"]) delete process.env[k]; try { await fn(); } finally { Object.assign(process.env, keep); } };

  await test("plan: generates the email, asks for the login", () => withEnvCleared(async () => {
    const r = await post("/api/test-data/plan", { steps: STEPS, seed: "s1" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ready, false);
    assert.deepStrictEqual(r.body.needsYou, ["LOGIN_PHONE", "LOGIN_PASSWORD"]);
    assert.strictEqual(r.body.fields.find((f) => f.name === "EMAIL").source, "generated");
    assert.match(r.body.fields.find((f) => f.name === "EMAIL").value, /@example\.com$/);
  }));

  await test("plan: same seed gives the same values", () => withEnvCleared(async () => {
    const a = await post("/api/test-data/plan", { steps: STEPS, seed: "s2" });
    const b = await post("/api/test-data/plan", { steps: STEPS, seed: "s2" });
    assert.deepStrictEqual(a.body, b.body);
  }));

  await test("plan: provided secrets are masked and a file can fill gaps", () => withEnvCleared(async () => {
    const r = await post("/api/test-data/plan", { steps: STEPS, seed: "s3", mode: "upload", upload: "LOGIN_PHONE,LOGIN_PASSWORD,EXTRA\n0116611,s3cret!,x" });
    assert.strictEqual(r.body.ready, true);
    assert.ok(!JSON.stringify(r.body).includes("s3cret!"));
    assert.deepStrictEqual(r.body.upload, { unused: ["EXTRA"], missing: ["EMAIL"] });
    assert.strictEqual(r.body.fields.find((f) => f.name === "EMAIL").source, "generated");
  }));

  await test("plan: bad upload and empty steps give plain errors", async () => {
    assert.strictEqual((await post("/api/test-data/plan", { steps: "  " })).status, 400);
    const r = await post("/api/test-data/plan", { steps: STEPS, mode: "upload", upload: "" });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /empty/);
  });

  await test("english run: refuses to start while a login is missing, and says which", () => withEnvCleared(async () => {
    const r = await post("/api/english-runs", { platform: "android", appUrl: "bs://x", steps: STEPS, dataMode: "generate", dataSeed: "s4" });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body.needsYou, ["LOGIN_PHONE", "LOGIN_PASSWORD"]);
    assert.match(r.body.error, /LOGIN_PHONE, LOGIN_PASSWORD/);
    assert.strictEqual(seen.length, 0);
  }));

  await test("english run: skip lets it start with deliberately wrong logins", () => withEnvCleared(async () => {
    const r = await post("/api/english-runs", {
      platform: "android", appUrl: "bs://x", steps: STEPS, dataMode: "generate", dataSeed: "s5",
      dataChoices: { LOGIN_PHONE: "skip", LOGIN_PASSWORD: "skip" },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.runId);
  }));

  await test("english run: without dataMode nothing changes (missing value still stops the run itself)", async () => {
    const r = await post("/api/english-runs", { platform: "android", appUrl: "bs://x", steps: "tap login", testData: {} });
    assert.strictEqual(r.status, 200);
  });

  const get = (p) => new Promise((resolve, reject) => http.get({ port, path: p }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) })); }).on("error", reject));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-"));
  process.env.TESTOPS_TESTDATA_DIR = dir;

  await test("save: Test Data file has no secrets; saved logins are encrypted and reused", () => withEnvCleared(async () => {
    process.env.TESTOPS_SECRETS_KEY = "a-long-test-passphrase";
    const body = { project: "P1", steps: STEPS, seed: "keep", provided: { LOGIN_PHONE: "0116611", LOGIN_PASSWORD: "s3cret!" }, saveLogins: true };
    const saved = await post("/api/test-data/save", body);
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.logins, ["LOGIN_PASSWORD"]);
    const onDisk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    assert.ok(!onDisk.includes("s3cret!"));
    assert.ok(fs.statSync(path.join(dir, "P1.secrets.json")).mode & 0o600);
    const list = await get("/api/test-data/saved?project=P1");
    assert.deepStrictEqual(list.body.logins, ["LOGIN_PASSWORD"]);
    assert.ok(!JSON.stringify(list.body).includes("s3cret!"));
    // a later plan needs nothing typed, and repeats the same seed/values
    const a = await post("/api/test-data/plan", { steps: STEPS, project: "P1" });
    assert.strictEqual(a.body.ready, true);
    assert.deepStrictEqual(a.body.saved, ["LOGIN_PASSWORD"]);
    assert.strictEqual(a.body.seed, "keep");
    assert.ok(!JSON.stringify(a.body).includes("s3cret!"));
    const b = await post("/api/test-data/plan", { steps: STEPS, project: "P1" });
    assert.deepStrictEqual(a.body, b.body);
  }));

  await test("save: skip beats a saved login; wrong key says so", () => withEnvCleared(async () => {
    const r = await post("/api/test-data/plan", { steps: STEPS, project: "P1", choices: { LOGIN_PASSWORD: "skip" } });
    assert.strictEqual(r.body.fields.find((f) => f.name === "LOGIN_PASSWORD").source, "negative-only");
    process.env.TESTOPS_SECRETS_KEY = "a-different-passphrase";
    const bad = await post("/api/test-data/plan", { steps: STEPS, project: "P1" });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /could not be unlocked/);
    process.env.TESTOPS_SECRETS_KEY = "a-long-test-passphrase";
  }));

  await test("save: without a key the file saves but logins are refused in plain words", () => withEnvCleared(async () => {
    delete process.env.TESTOPS_SECRETS_KEY;
    const r = await post("/api/test-data/save", { project: "P2", steps: STEPS, provided: { LOGIN_PASSWORD: "x1y2z3!!" }, saveLogins: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.file, true);
    assert.deepStrictEqual(r.body.logins, []);
    assert.match(r.body.note, /TESTOPS_SECRETS_KEY/);
    assert.ok(!fs.existsSync(path.join(dir, "P2.secrets.json")));
  }));

  await test("save: bad project names are refused", async () => {
    for (const p of ["../x", "a/b", "", " "]) assert.strictEqual((await post("/api/test-data/save", { project: p, steps: STEPS })).status, 400);
  });

  await test("api-plan: bodies filled, token asked for, negative cases listed", () => withEnvCleared(async () => {
    delete process.env.TOKEN;
    const steps = [{ kind: "api", method: "POST", url: "/pay", generateBody: true, negative: true, body: { email: "a@b.c", token: "t", note: "x" } }];
    const r = await post("/api/test-data/api-plan", { steps, seed: "s", negative: true });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.needsYou, ["TOKEN"]);
    assert.strictEqual(r.body.steps[0].body.token, "${TOKEN}");
    assert.match(r.body.steps[0].body.email, /@example\.com$/);
    assert.ok(r.body.negativeCases.some((c) => /missing email/.test(c.name)));
    assert.strictEqual((await post("/api/test-data/api-plan", { steps: [] })).status, 400);
  }));

  await test("api-cases/run: runs good and bad bodies from an OpenAPI file, asks first for missing values", () => withEnvCleared(async () => {
    const target = http.createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { let j; try { j = JSON.parse(b); } catch { /* none */ } const ok = j && typeof j.email === "string" && /@/.test(j.email); rs.writeHead(ok ? 201 : 422, { "Content-Type": "application/json" }); rs.end("{}"); }); });
    await new Promise((r) => target.listen(0, r));
    const baseUrl = `http://127.0.0.1:${target.address().port}`;
    const openapi = { openapi: "3.0.0", paths: { "/u": { post: { summary: "Create", requestBody: { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } } } } } }, responses: { 201: {} } } } } };
    const r = await post("/api/api-cases/run", { openapi, baseUrl, negative: true, seed: "z" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.failed, 0, JSON.stringify(r.body));
    assert.strictEqual(r.body.negatives.length, 3);
    const secured = { openapi: { openapi: "3.0.0", security: [{ b: [] }], paths: { "/me": { get: { responses: { 200: {} } } } } }, baseUrl };
    const blocked = await post("/api/api-cases/run", secured);
    assert.strictEqual(blocked.status, 400);
    assert.deepStrictEqual(blocked.body.needsYou, ["API_TOKEN"]);
    assert.strictEqual((await post("/api/api-cases/run", { ...secured, testData: { API_TOKEN: "t0ken-secret" } })).status, 200);
    assert.strictEqual((await post("/api/api-cases/run", { steps: [{ kind: "api", url: "/x" }] })).status, 400);
    assert.strictEqual((await post("/api/api-cases/run", { steps: [], baseUrl })).status, 400);
    target.close();
  }));

  await test("api: save a project with a token, then run it with nothing typed; openapi works for plan and save", () => withEnvCleared(async () => {
    process.env.TESTOPS_SECRETS_KEY = "a-long-test-passphrase";
    const seenAuth = [];
    const target = http.createServer((rq, rs) => { seenAuth.push(rq.headers.authorization); rs.writeHead(200, { "Content-Type": "application/json" }); rs.end("{}"); });
    await new Promise((r) => target.listen(0, r));
    const baseUrl = `http://127.0.0.1:${target.address().port}`;
    const openapi = { openapi: "3.0.0", security: [{ b: [] }], paths: { "/me": { get: { responses: { 200: {} } } } } };
    const plan = await post("/api/test-data/api-plan", { openapi });
    assert.deepStrictEqual(plan.body.needsYou, ["API_TOKEN"]);
    const saved = await post("/api/test-data/save", { project: "API1", openapi, provided: { API_TOKEN: "tok-9876" }, saveLogins: true });
    assert.deepStrictEqual(saved.body.logins, ["API_TOKEN"]);
    const onDisk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    assert.ok(!onDisk.includes("tok-9876"));
    const run = await post("/api/api-cases/run", { openapi, baseUrl, project: "API1" });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    assert.strictEqual(seenAuth[0], "Bearer tok-9876");
    assert.ok(!JSON.stringify(run.body).includes("tok-9876"));
    target.close();
  }));

  fs.rmSync(dir, { recursive: true, force: true });
  app.close();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nfrontend/testdata-endpoint tests passed");
})();
