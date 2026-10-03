/**
 * Tests for engine/webview-context.js -- detectWebviewContext()'s
 * fail-safe contract: never throw, report a real WEBVIEW_* context
 * name when one exists, null otherwise (no WebView, no getContexts()
 * support, or the call itself throws).
 *
 * Run with: npm test (from engine/) or `node test/webview-context.test.js`
 */

const assert = require("assert");
const { detectWebviewContext } = require("../webview-context");

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("engine/webview-context:");

  await test("detectWebviewContext returns the first WEBVIEW_* context when one is present", async () => {
    const driver = { getContexts: async () => ["NATIVE_APP", "WEBVIEW_com.app.pkg"] };
    assert.strictEqual(await detectWebviewContext(driver), "WEBVIEW_com.app.pkg");
  });

  await test("detectWebviewContext returns null when only NATIVE_APP is reported (the common, all-native-app case)", async () => {
    const driver = { getContexts: async () => ["NATIVE_APP"] };
    assert.strictEqual(await detectWebviewContext(driver), null);
  });

  await test("detectWebviewContext returns null (not throws) when getContexts() itself throws", async () => {
    const driver = { getContexts: async () => { throw new Error("not supported on this platform"); } };
    assert.strictEqual(await detectWebviewContext(driver), null);
  });

  await test("detectWebviewContext returns null when the driver has no getContexts() at all", async () => {
    assert.strictEqual(await detectWebviewContext({}), null);
  });

  await test("detectWebviewContext returns null for a missing/undefined driver", async () => {
    assert.strictEqual(await detectWebviewContext(undefined), null);
  });

  await test("detectWebviewContext returns null when getContexts() resolves to something that isn't an array", async () => {
    const driver = { getContexts: async () => "WEBVIEW_com.app.pkg" };
    assert.strictEqual(await detectWebviewContext(driver), null);
  });
})();
