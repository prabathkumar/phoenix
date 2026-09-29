/**
 * Reusable session starter, factored out of stage0-session.js once that
 * milestone passed. Every other entry point (run-session.js, and the
 * eventual TestOps backend integration) starts an Appium session the
 * same way this does — one place to change capabilities/connection
 * details, not one per script.
 *
 * PHOENIX_APPIUM_PROVIDER selects where that session actually runs —
 * "local" (default, a local emulator via a local Appium server) or
 * "browserstack" (BrowserStack App Automate, no local Android SDK
 * needed at all) — see remote-provider.js for what that changes.
 *
 * PHOENIX_APPIUM_DEVICE_NAME overrides the local-emulator device name
 * (default "emulator-5554", ignored on BrowserStack, where the device
 * comes from BrowserStack's own catalog instead). Needed to run two
 * sessions against two different local emulator instances at once (one
 * Appium server can serve multiple devices concurrently as long as
 * each session names a different one) -- e.g. testing two accounts in
 * parallel: `emulator -avd phoenix_stage0 -port 5554` and `emulator
 * -avd phoenix_stage0 -port 5556` (or a second AVD) give you
 * `emulator-5554` and `emulator-5556`, and each run-batch-executions.js
 * invocation sets PHOENIX_APPIUM_DEVICE_NAME to target one of them.
 */

const { remote } = require("webdriverio");
const remoteProvider = require("./remote-provider");

function buildBaseCapabilities() {
  return {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": process.env.PHOENIX_APPIUM_DEVICE_NAME || "emulator-5554", // ignored on BrowserStack
    "appium:app": process.env.PHOENIX_STAGE0_APP_PATH, // path to a .apk on disk
  };
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
