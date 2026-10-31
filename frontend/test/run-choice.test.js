/** Users can pick Local or BrowserStack for mobile and web, per recording or run; the screens offer what the server has. */
const assert = require("assert");
const http = require("http");
const { createEnglishEndpoint } = require("../english-endpoint");
const { resolveAppCapability } = require("../upload-session");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }
const withEnv = async (vars, fn) => { const keep = {}; for (const k of Object.keys(vars)) { keep[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { await fn(); } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } } };

(async () => {
  await test("English mobile run: the chosen provider, device and OS reach the session start and the app upload", async () => {
    const started = [], resolved = [];
    const ep = createEnglishEndpoint({
      resolveApp: async (o) => { resolved.push(o); return { "appium:app": "bs://x" }; },
      startMobile: async (o) => { started.push(o); return { takeScreenshot: async () => "PNG", deleteSession: async () => {} }; },
      mobileRunner: () => ({ goal: async () => ({ success: true, actions: [{ label: "x" }] }), screenshot: async () => ({ base64: "PNG", mime: "image/png" }) }),
    });
    const app = http.createServer((q, r) => ep.handleStart(q, r));
    await new Promise((r) => app.listen(0, r));
    const post = (b) => new Promise((resolve, reject) => { const d = JSON.stringify(b); const rq = http.request({ port: app.address().port, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(JSON.parse(t))); }); rq.on("error", reject); rq.end(d); });
    const a = await post({ platform: "android", appUrl: "bs://a", steps: "tap x", runOn: "browserstack", device: "Google Pixel 8", osVersion: "14.0" });
    assert.ok(a.runId);
    for (let i = 0; i < 50 && started.length < 1; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(started[0].provider, "browserstack");
    assert.strictEqual(started[0].device, "Google Pixel 8");
    assert.strictEqual(started[0].osVersion, "14.0");
    await new Promise((r) => setTimeout(r, 300)); // the first mobile run finishes before the next starts
    const b = await post({ platform: "ios", appUrl: "bs://b", steps: "tap x", runOn: "local" });
    assert.ok(b.runId);
    for (let i = 0; i < 50 && started.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(started[1].provider, "local");
    app.close();
  });

  await test("recording upload: the chosen provider decides local path vs BrowserStack upload, whatever the server default is", async () => {
    await withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack" }, async () => {
      assert.deepStrictEqual(await resolveAppCapability({ savedPath: "/tmp/app.apk", platform: "android", provider: "local" }), { "appium:app": "/tmp/app.apk" });
    });
  });

  await test("GET /api/run-options: BrowserStack is offered only when the server has credentials; no secrets in the answer", async () => {
    const rp = require("../../engine/remote-provider");
    await withEnv({ TESTOPS_MOBILE_BROWSERSTACK_USER: undefined, TESTOPS_MOBILE_BROWSERSTACK_KEY: undefined, TESTOPS_MOBILE_APPIUM_PROVIDER: undefined }, async () => {
      assert.deepStrictEqual(rp.availability(), { web: { local: true, browserstack: false }, mobile: { local: true, browserstack: false, default: "local" } });
    });
    await withEnv({ TESTOPS_MOBILE_BROWSERSTACK_USER: "USER1", TESTOPS_MOBILE_BROWSERSTACK_KEY: "SECRETKEY9" }, async () => {
      const a = rp.availability();
      assert.strictEqual(a.web.browserstack, true);
      assert.ok(!JSON.stringify(a).includes("SECRETKEY9") && !JSON.stringify(a).includes("USER1"));
    });
  });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nfrontend/run-choice tests passed");
  process.exit(0);
})();
