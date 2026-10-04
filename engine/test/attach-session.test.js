/**
 * Regression test for the real bug found 2026-10-04 on the first
 * real-device validation of attach-session.js: webdriverio's attach()
 * takes connection details nested under an `options` object with a
 * `protocol` string, not flat hostname/port/isSecure -- passing the
 * wrong shape left hostname/port effectively undefined and surfaced
 * downstream as a generic "Invalid URL" on the first real WebDriver
 * call, not as an attach()-time error. See attach-session.js's own
 * header comment for the full story.
 *
 * Fakes webdriverio's `attach` via require.cache injection (no real
 * network/session needed) and asserts the exact shape attachSession()
 * passes it.
 *
 * Run with: node test/attach-session.test.js (from engine/)
 */

const assert = require("assert");

const WEBDRIVERIO_PATH = require.resolve("webdriverio");
const ATTACH_SESSION_PATH = require.resolve("../attach-session");

function freshAttachSessionWithFake(attachImpl) {
  for (const p of [WEBDRIVERIO_PATH, ATTACH_SESSION_PATH]) {
    delete require.cache[p];
  }
  const calls = [];
  require.cache[WEBDRIVERIO_PATH] = {
    loaded: true,
    exports: {
      attach: async (opts) => {
        calls.push(opts);
        return attachImpl ? attachImpl(opts) : { sessionId: opts.sessionId };
      },
    },
  };
  const { attachSession } = require(ATTACH_SESSION_PATH);
  return { attachSession, calls };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    failed += 1;
  }
}

async function main() {
  console.log("engine/attach-session.js:");

  await test("passes connection details nested under options, with protocol (not isSecure)", async () => {
    const { attachSession, calls } = freshAttachSessionWithFake();
    await attachSession({ sessionId: "real-session-123" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sessionId, "real-session-123");
    assert.deepStrictEqual(calls[0].options, {
      hostname: "hub-cloud.browserstack.com",
      port: 443,
      path: "/wd/hub",
      protocol: "https",
    });
    assert.strictEqual(calls[0].isSecure, undefined, "isSecure is not a real webdriverio attach() option -- must not be passed");
    assert.strictEqual(calls[0].hostname, undefined, "hostname must be nested under options, not top-level");
  });

  await test("honors caller overrides for hostname/port/path/protocol, still nested correctly", async () => {
    const { attachSession, calls } = freshAttachSessionWithFake();
    await attachSession({
      sessionId: "s2",
      hostname: "custom-appium-host.example.com",
      port: 4723,
      path: "/",
      protocol: "http",
    });
    assert.deepStrictEqual(calls[0].options, {
      hostname: "custom-appium-host.example.com",
      port: 4723,
      path: "/",
      protocol: "http",
    });
  });

  await test("throws a clear error when sessionId is missing", async () => {
    const { attachSession } = freshAttachSessionWithFake();
    await assert.rejects(() => attachSession({}), /requires sessionId/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
