/**
 * Tests for remote-provider.js's local-vs-BrowserStack switch. Pure
 * logic, no network and no real Appium/BrowserStack session — the
 * point is the shape of the config each provider produces, not
 * whether a session can actually be opened.
 *
 * Run with: npm test (from engine/) or `node test/remote-provider.test.js`
 */

const assert = require("assert");

// Each test manipulates process.env directly and restores it
// afterward, and re-requires the module fresh each time in case
// something were ever cached module-level (it isn't today, but this
// keeps the tests robust if that changes).
function freshProvider() {
  delete require.cache[require.resolve("../remote-provider")];
  return require("../remote-provider");
}

function withEnv(vars, fn) {
  // Setting process.env[key] = undefined coerces to the string
  // "undefined" rather than clearing the variable -- delete instead,
  // both when applying the requested value and when restoring.
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

console.log("engine/remote-provider:");

test("defaults to the local provider when PHOENIX_APPIUM_PROVIDER is unset", () => {
  withEnv({ PHOENIX_APPIUM_PROVIDER: undefined }, () => {
    const remoteProvider = freshProvider();
    assert.strictEqual(remoteProvider.provider(), remoteProvider.LOCAL);
  });
});

test("local connection config is unchanged from before BrowserStack support existed", () => {
  withEnv(
    { PHOENIX_APPIUM_PROVIDER: undefined, PHOENIX_APPIUM_HOST: undefined, PHOENIX_APPIUM_PORT: undefined },
    () => {
      const remoteProvider = freshProvider();
      assert.deepStrictEqual(remoteProvider.buildConnectionConfig(), {
        hostname: "127.0.0.1",
        port: 4723,
        path: "/",
      });
    }
  );
});

test("local capabilities pass through with overrides applied last, unchanged from before BrowserStack support existed", () => {
  withEnv({ PHOENIX_APPIUM_PROVIDER: undefined }, () => {
    const remoteProvider = freshProvider();
    const base = { platformName: "Android", "appium:app": "/path/to.apk" };
    const result = remoteProvider.buildCapabilities(base, { "appium:app": "/other.apk" });
    assert.deepStrictEqual(result, { platformName: "Android", "appium:app": "/other.apk" });
  });
});

test("rejects an unrecognized provider value", () => {
  withEnv({ PHOENIX_APPIUM_PROVIDER: "sauce-labs" }, () => {
    const remoteProvider = freshProvider();
    assert.throws(() => remoteProvider.provider(), /Unknown PHOENIX_APPIUM_PROVIDER/);
  });
});

test("browserstack connection config points at the App Automate hub over HTTPS", () => {
  withEnv({ PHOENIX_APPIUM_PROVIDER: "browserstack" }, () => {
    const remoteProvider = freshProvider();
    assert.deepStrictEqual(remoteProvider.buildConnectionConfig(), {
      protocol: "https",
      hostname: "hub-cloud.browserstack.com",
      port: 443,
      path: "/wd/hub",
    });
  });
});

test("browserstack capabilities require auth env vars", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: undefined,
      PHOENIX_BROWSERSTACK_KEY: undefined,
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
    },
    () => {
      const remoteProvider = freshProvider();
      assert.throws(
        () => remoteProvider.buildCapabilities({ platformName: "iOS" }),
        /PHOENIX_BROWSERSTACK_USER and PHOENIX_BROWSERSTACK_KEY/
      );
    }
  );
});

test("browserstack capabilities require an uploaded app URL", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: "someuser",
      PHOENIX_BROWSERSTACK_KEY: "somekey",
      PHOENIX_BROWSERSTACK_APP_URL: undefined,
    },
    () => {
      const remoteProvider = freshProvider();
      assert.throws(
        () => remoteProvider.buildCapabilities({ platformName: "iOS" }),
        /PHOENIX_BROWSERSTACK_APP_URL/
      );
    }
  );
});

test("browserstack capabilities replace the local app reference with the uploaded app's bs:// URL, wrapped in bstack:options", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: "someuser",
      PHOENIX_BROWSERSTACK_KEY: "somekey",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
      PHOENIX_BROWSERSTACK_PROJECT: undefined,
      PHOENIX_BROWSERSTACK_BUILD: undefined,
      PHOENIX_BROWSERSTACK_SESSION_NAME: undefined,
    },
    () => {
      const remoteProvider = freshProvider();
      const base = {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": "iPhone 15 Pro",
        "appium:bundleId": "com.apple.mobilesafari", // a local-only concept
      };

      const result = remoteProvider.buildCapabilities(base);

      assert.strictEqual(result["appium:app"], "bs://abc123");
      assert.strictEqual(result["appium:bundleId"], undefined, "local bundle id must not carry over to BrowserStack");
      assert.strictEqual(result.platformName, "iOS");
      assert.strictEqual(result["appium:deviceName"], "iPhone 15 Pro");
      assert.deepStrictEqual(result["bstack:options"], {
        userName: "someuser",
        accessKey: "somekey",
        projectName: "Phoenix",
        buildName: "phoenix-recording",
        sessionName: "Phoenix recording session",
      });
    }
  );
});

test("browserstack capabilities omit local/localIdentifier when PHOENIX_BROWSERSTACK_LOCAL is unset", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: "someuser",
      PHOENIX_BROWSERSTACK_KEY: "somekey",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
      PHOENIX_BROWSERSTACK_LOCAL: undefined,
      PHOENIX_BROWSERSTACK_LOCAL_IDENTIFIER: undefined,
    },
    () => {
      const remoteProvider = freshProvider();
      const result = remoteProvider.buildCapabilities({ platformName: "iOS" });
      assert.strictEqual(result["bstack:options"].local, undefined);
      assert.strictEqual(result["bstack:options"].localIdentifier, undefined);
    }
  );
});

test("browserstack capabilities set local:true when PHOENIX_BROWSERSTACK_LOCAL=1, with an optional localIdentifier", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: "someuser",
      PHOENIX_BROWSERSTACK_KEY: "somekey",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
      PHOENIX_BROWSERSTACK_LOCAL: "1",
      PHOENIX_BROWSERSTACK_LOCAL_IDENTIFIER: "phoenix-tunnel-1",
    },
    () => {
      const remoteProvider = freshProvider();
      const result = remoteProvider.buildCapabilities({ platformName: "iOS" });
      assert.strictEqual(result["bstack:options"].local, true);
      assert.strictEqual(result["bstack:options"].localIdentifier, "phoenix-tunnel-1");
    }
  );
});

test("browserstack capability overrides still apply last, on top of the provider's own additions", () => {
  withEnv(
    {
      PHOENIX_APPIUM_PROVIDER: "browserstack",
      PHOENIX_BROWSERSTACK_USER: "someuser",
      PHOENIX_BROWSERSTACK_KEY: "somekey",
      PHOENIX_BROWSERSTACK_APP_URL: "bs://abc123",
    },
    () => {
      const remoteProvider = freshProvider();
      const result = remoteProvider.buildCapabilities(
        { platformName: "iOS" },
        { "appium:deviceName": "iPhone 14" }
      );
      assert.strictEqual(result["appium:deviceName"], "iPhone 14");
    }
  );
});

if (process.exitCode) {
  console.error("\nengine/remote-provider tests FAILED");
  process.exit(1);
} else {
  console.log("\nengine/remote-provider tests passed");
}
