/** A recording or run can choose Local or BrowserStack for itself; with no choice, the server setting decides as before. */
const assert = require("assert");
const rp = require("../remote-provider");
const android = require("../session");
const ios = require("../ios-session");

let failed = 0;
function test(name, fn) { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }
const withEnv = (vars, fn) => { const keep = {}; for (const k of Object.keys(vars)) { keep[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { fn(); } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } } };
const BS = { TESTOPS_MOBILE_BROWSERSTACK_USER: "USER1", TESTOPS_MOBILE_BROWSERSTACK_KEY: "SECRETKEY9", TESTOPS_MOBILE_BROWSERSTACK_APP_URL: "bs://app1" };

test("no choice: the server setting decides, exactly as before", () => {
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: undefined }, () => assert.strictEqual(rp.provider(), "local"));
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack" }, () => assert.strictEqual(rp.provider(), "browserstack"));
});

test("a per-session choice beats the server setting, both ways", () => {
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack", ...BS }, () => {
    assert.strictEqual(rp.provider("local"), "local");
    assert.strictEqual(rp.buildConnectionConfig({ provider: "local" }).hostname, "127.0.0.1");
    assert.deepStrictEqual(rp.buildCapabilities({ platformName: "Android", "appium:app": "/x.apk" }, {}, { provider: "local" }), { platformName: "Android", "appium:app": "/x.apk" });
  });
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "local", ...BS }, () => {
    assert.strictEqual(rp.buildConnectionConfig({ provider: "browserstack" }).hostname, "hub-cloud.browserstack.com");
    const caps = rp.buildCapabilities({ platformName: "Android", "appium:app": "/x.apk" }, {}, { provider: "browserstack" });
    assert.strictEqual(caps["appium:app"], "bs://app1");
    assert.strictEqual(caps["bstack:options"].userName, "USER1");
  });
});

test("BrowserStack chosen without credentials: the existing plain error, nothing else", () => {
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "local", TESTOPS_MOBILE_BROWSERSTACK_USER: undefined, TESTOPS_MOBILE_BROWSERSTACK_KEY: undefined }, () => {
    assert.throws(() => rp.buildCapabilities({}, {}, { provider: "browserstack" }), /TESTOPS_MOBILE_BROWSERSTACK_USER/);
  });
  assert.throws(() => rp.provider("azure"), /Unknown/);
});

test("device and OS version can be chosen per session (Android and iOS); defaults follow the chosen provider", () => {
  withEnv({ TESTOPS_MOBILE_APPIUM_PROVIDER: "local", TESTOPS_MOBILE_APPIUM_DEVICE_NAME: undefined, ...BS }, () => {
    assert.strictEqual(android.buildCapabilities({}, { provider: "browserstack" })["appium:deviceName"], "Samsung Galaxy S23");
    assert.strictEqual(android.buildCapabilities({}, { provider: "local" })["appium:deviceName"], "emulator-5554");
    const c = android.buildCapabilities({}, { provider: "browserstack", device: "Google Pixel 8", osVersion: "14.0" });
    assert.strictEqual(c["appium:deviceName"], "Google Pixel 8");
    assert.strictEqual(c["appium:platformVersion"], "14.0");
    const i = ios.buildCapabilities({}, { provider: "browserstack", device: "iPhone 14", osVersion: "16" });
    assert.strictEqual(i["appium:deviceName"], "iPhone 14");
    assert.strictEqual(i["appium:platformVersion"], "16");
  });
});

test("chooseProvider and availability (no secrets)", () => {
  const { chooseProvider } = require("../core/run-target");
  assert.deepStrictEqual(["BrowserStack", "local", "", "x", undefined].map(chooseProvider), ["browserstack", "local", undefined, undefined, undefined]);
  const a = rp.availability({ TESTOPS_MOBILE_BROWSERSTACK_USER: "u", TESTOPS_MOBILE_BROWSERSTACK_KEY: "k", TESTOPS_MOBILE_APPIUM_PROVIDER: "browserstack" });
  assert.deepStrictEqual(a, { web: { local: true, browserstack: true }, mobile: { local: true, browserstack: true, default: "browserstack" } });
  assert.deepStrictEqual(rp.availability({}).mobile, { local: true, browserstack: false, default: "local" });
  assert.ok(!JSON.stringify(a).includes('"k"') && !JSON.stringify(a).includes('"u"'));
});

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nengine/per-session-provider tests passed");
