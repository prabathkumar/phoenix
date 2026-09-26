/**
 * Reusable session starter, factored out of stage0-session.js once that
 * milestone passed. Every other entry point (run-session.js, and the
 * eventual TestOps backend integration) starts an Appium session the
 * same way this does — one place to change capabilities/connection
 * details, not one per script.
 */

const { remote } = require("webdriverio");

function buildCapabilities(overrides = {}) {
  return {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "emulator-5554", // local Android emulator, not BrowserStack
    "appium:app": process.env.PHOENIX_STAGE0_APP_PATH, // path to a .apk on disk
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
