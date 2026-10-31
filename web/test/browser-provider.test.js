const assert = require("assert");
const { launchWebBrowser, browserStackEndpoint, normalizeRunOn } = require("../browser-provider");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }
const ENV = { TESTOPS_MOBILE_BROWSERSTACK_USER: "USER1", TESTOPS_MOBILE_BROWSERSTACK_KEY: "SECRETKEY9" };
const fakeChromium = () => { const calls = {}; return { calls, launch: async (o) => { calls.launch = o; return { fake: "local" }; }, connect: async (ws, o) => { calls.connect = { ws, o }; return { fake: "remote" }; } }; };

(async () => {
  await test("local: launches here, unchanged defaults, labelled Local", async () => {
    const c = fakeChromium();
    const r = await launchWebBrowser({ runOn: "local", chromium: c, env: {} });
    assert.deepStrictEqual(r.browser, { fake: "local" });
    assert.strictEqual(c.calls.launch.headless, true);
    assert.strictEqual(r.where.provider, "local");
    assert.ok(!c.calls.connect);
  });

  await test("browserstack: connects to the Playwright endpoint with the server's credentials, labelled BrowserStack with no secrets", async () => {
    const c = fakeChromium();
    const r = await launchWebBrowser({ runOn: "browserstack", chromium: c, env: ENV, target: { provider: "browserstack", browser: "edge", osVersion: "10", browserVersion: "latest" } });
    assert.deepStrictEqual(r.browser, { fake: "remote" });
    assert.match(c.calls.connect.ws, /^wss:\/\/cdp\.browserstack\.com\/playwright\?caps=/);
    const caps = JSON.parse(decodeURIComponent(c.calls.connect.ws.split("caps=")[1]));
    assert.strictEqual(caps["browserstack.username"], "USER1");
    assert.strictEqual(caps.browser, "edge");
    assert.strictEqual(caps.os_version, "10");
    assert.strictEqual(r.where.provider, "browserstack");
    assert.ok(!JSON.stringify(r.where).includes("SECRETKEY9") && !JSON.stringify(r.where).includes("USER1"));
    assert.ok(!c.calls.launch);
  });

  await test("browserstack: missing credentials give a plain message and connect nothing", async () => {
    const c = fakeChromium();
    await assert.rejects(() => launchWebBrowser({ runOn: "browserstack", chromium: c, env: {} }), /TESTOPS_MOBILE_BROWSERSTACK_USER and TESTOPS_MOBILE_BROWSERSTACK_KEY/);
    assert.ok(!c.calls.connect);
  });

  await test("defaults are chrome latest on Windows 11; runOn is normalised to local unless browserstack", () => {
    const caps = JSON.parse(decodeURIComponent(browserStackEndpoint({ env: ENV }).split("caps=")[1]));
    assert.deepStrictEqual([caps.browser, caps.browser_version, caps.os, caps.os_version], ["chrome", "latest", "Windows", "11"]);
    assert.deepStrictEqual(["x", undefined, "BrowserStack", "local"].map(normalizeRunOn), ["local", "local", "browserstack", "local"]);
  });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nweb/browser-provider tests passed");
})();
