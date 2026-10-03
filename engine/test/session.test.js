/**
 * Tests for session.js's Android capability building, specifically the
 * device-name default -- a real bug, found on a real BrowserStack run
 * (a "guided" recording session with PHOENIX_APPIUM_PROVIDER=browserstack
 * and no PHOENIX_APPIUM_DEVICE_NAME set): BrowserStack rejected the old
 * hardcoded default "emulator-5554" with BROWSERSTACK_INVALID_DEVICE,
 * looping failed session-creation retries forever. See session.js's
 * updated docstring for the full real-evidence writeup.
 *
 * Pure logic, no network and no real Appium/BrowserStack session.
 *
 * Run with: npm test (from engine/) or `node test/session.test.js`
 */

const assert = require("assert");

function freshSession() {
  delete require.cache[require.resolve("../session")];
  delete require.cache[require.resolve("../remote-provider")];
  return require("../session");
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("engine/session:");

test("local provider, no override: defaults to the local emulator serial (unchanged from before BrowserStack support)", () => {
  withEnv(
    { PHOENIX_APPIUM_PROVIDER: undefined, PHOENIX_APPIUM_DEVICE_NAME: undefined, PHOENIX_STAGE0_APP_PATH: "/x.apk" },
    () => {
      const session = freshSession();
      const caps = session.buildCapabilities();
      assert.strictEqual(caps["appium:deviceName"], "emulator-5554");
    }
  );
});

test("browserstack provider, no override: defaults to a real BrowserStack catalog name, NOT the local emulator serial", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_APPIUM_DEVICE_NAME: undefined,
      PHOENIX_BROWSERSTACK_USER: "user",
      PHOENIX_BROWSERSTACK_KEY: "key",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
    },
    () => {
      const session = freshSession();
      const caps = session.buildCapabilities();
      assert.notStrictEqual(caps["appium:deviceName"], "emulator-5554");
      assert.strictEqual(caps["appium:deviceName"], "Google Pixel 7");
    }
  );
});

test("an explicit PHOENIX_APPIUM_DEVICE_NAME always wins, on either provider", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_APPIUM_DEVICE_NAME: "Samsung Galaxy S23",
      PHOENIX_BROWSERSTACK_USER: "user",
      PHOENIX_BROWSERSTACK_KEY: "key",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
    },
    () => {
      const session = freshSession();
      const caps = session.buildCapabilities();
      assert.strictEqual(caps["appium:deviceName"], "Samsung Galaxy S23");
    }
  );
});
