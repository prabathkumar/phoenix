/**
 * Shared connection-config builder for both platforms' startSession().
 *
 * Phoenix's engine has always talked to Appium over a plain
 * hostname/port (PHOENIX_APPIUM_HOST/PORT) rather than assuming
 * localhost, so pointing it at a *remote* Appium server was already
 * possible with zero code changes — see session.js's and
 * ios-session.js's original docstrings. What this module adds is the
 * one thing that isn't just "point at a different host": BrowserStack
 * App Automate's specific connection shape (HTTPS, a fixed hub
 * hostname, account auth, and a `bstack:options` capability block
 * instead of bare `appium:*` vendor caps) and its app-reference format
 * (an app already uploaded to BrowserStack, referenced by its `bs://`
 * URL — not a local file path or a bundle id already installed on a
 * Simulator/emulator, since BrowserStack has no concept of either).
 *
 * Why this exists at all: TestOps runs on Linux VMs, and Xcode/the iOS
 * Simulator only run on macOS — Apple's license also prohibits running
 * macOS on non-Apple hardware, so there is no way to stand that up
 * directly on the same Linux VM. BrowserStack App Automate is an
 * already-licensed way to get a real Appium session against real
 * hardware without operating a Mac at all; this module is what lets
 * `PHOENIX_APPIUM_PROVIDER=browserstack` redirect an existing Phoenix
 * session there instead of a local Appium server, with no changes
 * needed anywhere else in the pipeline (capture/generation/live-view
 * only ever see a normal WebdriverIO `Browser`, regardless of where
 * its session actually runs).
 */

const LOCAL = "local";
const BROWSERSTACK = "browserstack";

function provider() {
  const value = (process.env.PHOENIX_APPIUM_PROVIDER || LOCAL).toLowerCase();
  if (value !== LOCAL && value !== BROWSERSTACK) {
    throw new Error(
      `Unknown PHOENIX_APPIUM_PROVIDER "${value}" — expected "${LOCAL}" or "${BROWSERSTACK}".`
    );
  }
  return value;
}

/**
 * Connection details (protocol/hostname/port/path) — the same shape
 * for Android and iOS on either provider, since only the capabilities
 * differ by platform.
 */
function buildConnectionConfig() {
  if (provider() === BROWSERSTACK) {
    return {
      protocol: "https",
      hostname: "hub-cloud.browserstack.com",
      port: 443,
      path: "/wd/hub",
    };
  }

  return {
    hostname: process.env.PHOENIX_APPIUM_HOST || "127.0.0.1",
    port: Number(process.env.PHOENIX_APPIUM_PORT) || 4723,
    path: "/",
  };
}

/**
 * Wraps a platform module's base capabilities (platformName,
 * automationName, device selection, and whichever local app-reference
 * capability it built) with whatever the selected provider
 * additionally requires, then applies caller-supplied overrides last
 * so a specific session can still pin something ad hoc on top.
 *
 * On BROWSERSTACK, the local-only app reference (`appium:app` pointing
 * at a file on this machine, or `appium:bundleId` naming something
 * already installed on a local Simulator/emulator) is replaced
 * entirely with PHOENIX_BROWSERSTACK_APP_URL — carrying the local one
 * over alongside it would be actively misleading even though
 * BrowserStack ignores capability keys it doesn't recognize.
 */
function buildCapabilities(baseCapabilities, overrides = {}) {
  if (provider() !== BROWSERSTACK) {
    return { ...baseCapabilities, ...overrides };
  }

  if (!process.env.PHOENIX_BROWSERSTACK_USER || !process.env.PHOENIX_BROWSERSTACK_KEY) {
    throw new Error(
      "PHOENIX_APPIUM_PROVIDER=browserstack requires PHOENIX_BROWSERSTACK_USER and " +
        "PHOENIX_BROWSERSTACK_KEY (an Automate access key from your BrowserStack account " +
        "settings — not your account password)."
    );
  }
  if (!process.env.PHOENIX_BROWSERSTACK_APP_URL) {
    throw new Error(
      "PHOENIX_APPIUM_PROVIDER=browserstack requires PHOENIX_BROWSERSTACK_APP_URL. " +
        "Upload the app first with `node engine/browserstack-upload.js <path-to-app>` " +
        "and set its bs:// URL here — BrowserStack doesn't accept a local file path or a " +
        "bundle id the way a local Appium server does."
    );
  }

  const { "appium:app": _localApp, "appium:bundleId": _localBundleId, ...platformCapabilities } =
    baseCapabilities;

  return {
    ...platformCapabilities,
    "appium:app": process.env.PHOENIX_BROWSERSTACK_APP_URL,
    "bstack:options": {
      userName: process.env.PHOENIX_BROWSERSTACK_USER,
      accessKey: process.env.PHOENIX_BROWSERSTACK_KEY,
      projectName: process.env.PHOENIX_BROWSERSTACK_PROJECT || "Phoenix",
      buildName: process.env.PHOENIX_BROWSERSTACK_BUILD || "phoenix-recording",
      sessionName: process.env.PHOENIX_BROWSERSTACK_SESSION_NAME || "Phoenix recording session",
    },
    ...overrides,
  };
}

module.exports = { LOCAL, BROWSERSTACK, provider, buildConnectionConfig, buildCapabilities };
