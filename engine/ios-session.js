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
 */

const { remote } = require("webdriverio");

function buildCapabilities(overrides = {}) {
  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": process.env.PHOENIX_IOS_DEVICE_NAME || "iPhone 15",
    "appium:platformVersion": process.env.PHOENIX_IOS_PLATFORM_VERSION,
    "appium:app": process.env.PHOENIX_IOS_APP_PATH, // path to a .app (simulator) or .ipa (device)
    ...overrides,
  };
}

/**
 * @param {object} [capabilityOverrides]
 * @returns {Promise<import('webdriverio').Browser>}
 */
async function startSession(capabilityOverrides) {
  return remote({
    hostname: process.env.PHOENIX_APPIUM_HOST || "127.0.0.1",
    port: Number(process.env.PHOENIX_APPIUM_PORT) || 4723,
    path: "/",
    capabilities: buildCapabilities(capabilityOverrides),
  });
}

module.exports = { startSession, buildCapabilities };
