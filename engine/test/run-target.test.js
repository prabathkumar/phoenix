const assert = require("assert");
const t = require("../core/run-target");
const { buildTestResult } = require("../test-result");
const { runScriptSteps } = require("../test-case-runner");
const fs = require("fs"), os = require("os"), path = require("path");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }
const BS = { "bstack:options": { userName: "USER1", accessKey: "SECRETKEY9", deviceName: "iPhone 15", osVersion: "17" } };

(async () => {
  await test("mobile: BrowserStack vs local, and no credentials ever in the label", () => {
    const b = t.mobileTarget({ platform: "ios", provider: "browserstack", capabilities: BS, sessionId: "s1" });
    assert.strictEqual(t.targetLabel(b), "BrowserStack · iPhone 15 · iOS 17");
    assert.match(b.sessionUrl, /app-automate\.browserstack\.com\/dashboard\/v2\/sessions\/s1$/);
    assert.ok(!JSON.stringify(b).includes("SECRETKEY9") && !JSON.stringify(b).includes("USER1"));
    const l = t.mobileTarget({ platform: "android", capabilities: { "appium:deviceName": "Pixel 7", "appium:platformVersion": "14" }, env: {} });
    assert.strictEqual(l.provider, "local");
    assert.strictEqual(t.targetLabel(l), "Local · Pixel 7 · Android 14");
    assert.strictEqual(l.host, "127.0.0.1:4723");
  });

  await test("provider comes from TESTOPS_MOBILE_APPIUM_PROVIDER when not given", () => {
    assert.strictEqual(t.mobileTarget({ platform: "android", env: { TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack" } }).provider, "browserstack");
    assert.strictEqual(t.mobileTarget({ platform: "android", env: {} }).provider, "local");
  });

  await test("targetFromDriver reads the live session", () => {
    const x = t.targetFromDriver({ sessionId: "abc", capabilities: { deviceName: "Galaxy S23", platformVersion: "13" } }, "android", { TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack" });
    assert.strictEqual(x.provider, "browserstack");
    assert.strictEqual(x.device, "Galaxy S23");
    assert.ok(x.sessionUrl);
  });

  await test("web (Playwright): local by default, BrowserStack when the endpoint says so; host only, no query", () => {
    const local = t.targetFromBrowser({ browserType: () => ({ name: () => "chromium" }), version: () => "131.0.6778.33" }, { headless: true });
    assert.strictEqual(t.targetLabel(local), "Local · Chromium 131");
    assert.strictEqual(local.engine, "playwright");
    const remote = t.webTarget({ wsEndpoint: "wss://cdp.browserstack.com/playwright?caps=%7B%22accessKey%22%3A%22SECRETKEY9%22%7D" });
    assert.strictEqual(remote.provider, "browserstack");
    assert.ok(!JSON.stringify(remote).includes("SECRETKEY9"));
  });

  await test("compareTargets: flags a different provider, device or browser; never blocks; unknown is silent", () => {
    const bs = t.mobileTarget({ platform: "ios", provider: "browserstack", capabilities: BS });
    const loc = t.mobileTarget({ platform: "ios", capabilities: { deviceName: "iPhone 15" }, env: {} });
    assert.match(t.compareTargets(bs, loc).message, /Recorded on BrowserStack.*ran on Local/);
    assert.strictEqual(t.compareTargets(bs, bs), null);
    assert.match(t.compareTargets(loc, { ...loc, device: "iPhone 12" }).message, /different device/);
    assert.match(t.compareTargets(t.webTarget({ browserName: "chromium" }), t.webTarget({ browserName: "firefox" })).message, /Recorded on/);
    assert.strictEqual(t.compareTargets(undefined, loc), null);
    assert.strictEqual(t.compareTargets({}, loc), null);
  });

  await test("buildTestResult: ranOn/recordedOn/warnings are additive and absent when not given", () => {
    const base = { platform: "web", steps: [{ index: 0, kind: "tap", instruction: "x", status: "pass" }] };
    const plain = buildTestResult(base);
    assert.ok(!("ranOn" in plain) && !("recordedOn" in plain) && !("warnings" in plain));
    const r = buildTestResult({ ...base, ranOn: { provider: "local" }, warnings: ["w"] });
    assert.deepStrictEqual(r.ranOn, { provider: "local" });
    assert.deepStrictEqual(r.warnings, ["w"]);
  });

  await test("mobile runner: result says where it ran, and warns when the test case was recorded elsewhere", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
    const file = path.join(dir, "case.json");
    const rec = t.mobileTarget({ platform: "android", provider: "browserstack", capabilities: { deviceName: "Pixel 7" } });
    fs.writeFileSync(file, JSON.stringify({ recordedOn: rec, steps: [] }));
    const ok = async () => ({ success: true, selector: { strategy: "id", value: "a" }, diffSummary: "d", diff: { appeared: [], disappeared: [] } });
    const driver = { sessionId: "L1", capabilities: { deviceName: "Pixel 7" } };
    const r = await runScriptSteps(driver, [{ kind: "tap", instruction: "tap a" }], { platform: "android", executeSemanticAction: ok, sleepFn: async () => {}, testCaseFile: file });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.ranOn.provider, "local");
    assert.strictEqual(r.recordedOn.provider, "browserstack");
    assert.match(r.warnings[0], /Recorded on BrowserStack/);
    // no driver session, no file: no label, no warning, nothing else changes
    const plain = await runScriptSteps({}, [{ kind: "tap", instruction: "tap a" }], { platform: "android", executeSemanticAction: ok, sleepFn: async () => {} });
    assert.ok(!("ranOn" in plain) && !("warnings" in plain));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("generated script carries a Recorded on header, and none when unknown", async () => {
    const { generateScript } = require("../../generation/pipeline");
    const steps = [{ stepIndex: 0, kind: "tap", instruction: "tap Login", resolvedElement: { text: "Login" } }];
    const withLabel = await generateScript(steps, { recordedOn: t.mobileTarget({ platform: "ios", provider: "browserstack", capabilities: BS }) });
    assert.match(withLabel.scriptSource, /\/\/ Recorded on: BrowserStack · iPhone 15 · iOS 17 \(provider=browserstack\)/);
    const none = await generateScript(steps, {});
    assert.ok(!/Recorded on/.test(none.scriptSource));
  });

  await test("normalizeTarget: keeps only plain whitelisted fields, drops credentials, needs a provider", () => {
    const n = t.normalizeTarget({ provider: "BrowserStack", engine: "appium", platform: "ios", device: "iPhone 15", osVersion: "17", sessionId: "s9", sessionUrl: "https://app-automate.browserstack.com/dashboard/v2/sessions/s9",
      accessKey: "SECRETKEY9", userName: "USER1", "bstack:options": { accessKey: "SECRETKEY9" }, device_extra: "x" });
    assert.strictEqual(n.provider, "browserstack");
    assert.strictEqual(n.device, "iPhone 15");
    assert.ok(!JSON.stringify(n).includes("SECRETKEY9") && !JSON.stringify(n).includes("USER1") && !("device_extra" in n));
    assert.ok(!("sessionUrl" in t.normalizeTarget({ provider: "local", sessionUrl: "javascript:alert(1)" })));
    assert.strictEqual(t.normalizeTarget({ device: "x" }), undefined);
    assert.strictEqual(t.normalizeTarget({ provider: "azure" }), undefined);
    assert.strictEqual(t.normalizeTarget("not json"), undefined);
    assert.strictEqual(t.normalizeTarget('{"provider":"local","browser":"chromium"}').browser, "chromium");
    assert.strictEqual(t.normalizeTarget({ provider: "local", device: "x".repeat(500) }).device.length, 200);
  });

  await test("mergeTarget: what TestOps passed wins, what the engine saw fills the gaps", () => {
    const m = t.mergeTarget({ provider: "browserstack", device: "iPhone 15" }, { provider: "local", device: "sim", host: "127.0.0.1:4723", osVersion: "17" });
    assert.strictEqual(m.provider, "browserstack");
    assert.strictEqual(m.device, "iPhone 15");
    assert.strictEqual(m.osVersion, "17");
    assert.deepStrictEqual(t.mergeTarget(undefined, { provider: "local" }), { provider: "local" });
  });

  await test("runner uses the target TestOps passed (no credentials needed), cleaned", async () => {
    const ok = async () => ({ success: true, selector: { strategy: "id", value: "a" }, diffSummary: "d", diff: { appeared: [], disappeared: [] } });
    const r = await runScriptSteps({}, [{ kind: "tap", instruction: "tap a" }], { platform: "ios", executeSemanticAction: ok, sleepFn: async () => {},
      ranOn: { provider: "browserstack", engine: "appium", platform: "ios", device: "iPhone 15", accessKey: "SECRETKEY9" } });
    assert.strictEqual(r.ranOn.provider, "browserstack");
    assert.ok(!JSON.stringify(r).includes("SECRETKEY9"));
  });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nengine/run-target tests passed");
})();
