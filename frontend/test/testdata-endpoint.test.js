/** Test-data layer over HTTP: the plan route, and the English run refusing to start while a login is missing. */
const assert = require("assert");
const http = require("http");
const { handlePlan } = require("../testdata-endpoint");
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

  app.close();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nfrontend/testdata-endpoint tests passed");
})();
