/**
 * iOS counterpart to session.js — starts an Appium session against a
 * local iOS Simulator via appium-xcuitest-driver, using the same
 * spawn-a-server-and-talk-over-HTTP model as session.js's Android path
 * (see engine/embedded-session.js's header for why the Android path
 * also has an in-process alternative; iOS doesn't have one yet, see
 * README).
 *
 * platformName/automationName differ from Android, and so does what
 * "app" and "deviceName" mean:
 *   - appium:app is a path to a built .app bundle (simulator) or .ipa
 *     (real device) — not a .apk.
 *   - appium:deviceName + appium:platformVersion together select which
 *     installed Simulator runtime to boot (e.g. "iPhone 15", "17.5") —
 *     there's no single always-correct default the way Android's fixed
 *     emulator-5554 AVD name is; both must be set to match a Simulator
 *     actually installed via Xcode on this machine (`xcrun simctl list
 *     devices` shows what's available).
 *
 * A local iOS Simulator can only run on macOS at all (Apple's license
 * rules out virtualizing it on a Linux TestOps VM), so
 * TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack is how a Linux-hosted TestOps Mobile
 * points this same startSession() at BrowserStack App Automate's real
 * iOS devices instead of a Simulator on this machine — see
 * remote-provider.js. deviceName/platformVersion then mean "which of
 * BrowserStack's real-device catalog entries to request", not "which
 * Simulator to boot".
 */

const { remote } = require("webdriverio");
const remoteProvider = require("./remote-provider");

function buildBaseCapabilities() {
  const base = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": process.env.TESTOPS_MOBILE_IOS_DEVICE_NAME || "iPhone 15",
    "appium:platformVersion": process.env.TESTOPS_MOBILE_IOS_PLATFORM_VERSION,
  };

  // Either a path to a .app/.ipa to install and launch (the normal case
  // — see TESTOPS_MOBILE_IOS_APP_PATH), or a bundle id of an app already on the
  // simulator (e.g. "com.apple.mobilesafari") when you want to smoke-test
  // the session/driver plumbing itself without building anything first.
  // TESTOPS_MOBILE_IOS_BUNDLE_ID takes priority if both are set. Both are
  // local-only concepts — remote-provider.js replaces this entirely
  // with TESTOPS_MOBILE_BROWSERSTACK_APP_URL when the provider is browserstack.
  if (process.env.TESTOPS_MOBILE_IOS_BUNDLE_ID) {
    base["appium:bundleId"] = process.env.TESTOPS_MOBILE_IOS_BUNDLE_ID;
  } else {
    base["appium:app"] = process.env.TESTOPS_MOBILE_IOS_APP_PATH;
  }

  return base;
}

function buildCapabilities(overrides = {}) {
  return remoteProvider.buildCapabilities(buildBaseCapabilities(), overrides);
}

/**
 * @param {object} [capabilityOverrides]
 * @returns {Promise<import('webdriverio').Browser>}
 */
async function startSession(capabilityOverrides) {
  return remote({
    ...remoteProvider.buildConnectionConfig(),
    capabilities: buildCapabilities(capabilityOverrides),
  });
}

module.exports = { startSession, buildCapabilities };
