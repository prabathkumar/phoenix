/**
 * Reusable session starter, factored out of stage0-session.js once that
 * milestone passed. Every other entry point (run-session.js, and the
 * eventual TestOps backend integration) starts an Appium session the
 * same way this does — one place to change capabilities/connection
 * details, not one per script.
 *
 * TESTOPS_MOBILE_APPIUM_PROVIDER selects where that session actually runs —
 * "local" (default, a local emulator via a local Appium server) or
 * "browserstack" (BrowserStack App Automate, no local Android SDK
 * needed at all) — see remote-provider.js for what that changes.
 *
 * TESTOPS_MOBILE_APPIUM_DEVICE_NAME overrides the device name. On the LOCAL
 * provider this targets a local emulator instance (default
 * "emulator-5554") -- needed to run two sessions against two different
 * local emulator instances at once (one Appium server can serve
 * multiple devices concurrently as long as each session names a
 * different one) -- e.g. testing two accounts in parallel: `emulator
 * -avd testops_mobile_stage0 -port 5554` and `emulator -avd testops_mobile_stage0
 * -port 5556` (or a second AVD) give you `emulator-5554` and
 * `emulator-5556`, and each run-batch-executions.js invocation sets
 * TESTOPS_MOBILE_APPIUM_DEVICE_NAME to target one of them.
 *
 * REAL BUG, found 2026-10-03 on a real BrowserStack run (a "guided"
 * recording session against TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack with
 * no TESTOPS_MOBILE_APPIUM_DEVICE_NAME set): the "ignored on BrowserStack"
 * claim this comment used to make was false. BrowserStack validates
 * appium:deviceName against its own device catalog and rejects
 * "emulator-5554" outright with BROWSERSTACK_INVALID_DEVICE ("Incorrect
 * device name 'emulator-5554' specified for the 'device' capability"),
 * retrying 3x and failing every session in a loop. This had never
 * surfaced before because every run-batch-executions.js BrowserStack
 * run against Android (test-cases/addons.json) happened to set
 * TESTOPS_MOBILE_APPIUM_DEVICE_NAME explicitly; nothing had exercised the
 * *default* on BrowserStack until this run-session.js recording
 * session did. ios-session.js's equivalent default ("iPhone 15") only
 * worked by coincidence -- it happens to be a real BrowserStack
 * catalog name too, not because deviceName is actually ignored there
 * either. Fixed by picking a provider-appropriate default instead of a
 * single hardcoded one, mirroring what ios-session.js already
 * (accidentally) got right.
 */

const { remote } = require("webdriverio");
const remoteProvider = require("./remote-provider");

// "emulator-5554" is a local ADB serial, meaningless to BrowserStack's
// device catalog; "Google Pixel 7" is a real BrowserStack App Automate
// catalog entry. Only used when TESTOPS_MOBILE_APPIUM_DEVICE_NAME isn't set --
// an explicit value is still passed through unchanged on either provider.
function defaultDeviceName() {
  return remoteProvider.provider() === remoteProvider.BROWSERSTACK ? "Google Pixel 7" : "emulator-5554";
}

function buildBaseCapabilities() {
  return {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": process.env.TESTOPS_MOBILE_APPIUM_DEVICE_NAME || defaultDeviceName(),
    "appium:app": process.env.TESTOPS_MOBILE_STAGE0_APP_PATH, // path to a .apk on disk
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
