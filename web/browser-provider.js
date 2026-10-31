/**
 * Where a web (Playwright) run happens: Chromium on this TestOps server, or a
 * browser on BrowserStack. One helper for the English page and the CLI runner.
 *
 *   runOn "local"        chromium.launch() here (default; unchanged behaviour)
 *   runOn "browserstack" chromium.connect() to BrowserStack's Playwright endpoint,
 *                        with the same TESTOPS_MOBILE_BROWSERSTACK_USER / _KEY the
 *                        mobile path uses. The credentials travel only inside the
 *                        connection URL; they are never returned or labelled.
 */
const { webTarget, normalizeTarget } = require("../engine/core/run-target");

const DEFAULT_BS = { browser: "chrome", browser_version: "latest", os: "Windows", os_version: "11" };

function browserStackEndpoint({ target, env = process.env, name = "TestOps ai-automate web run" } = {}) {
  const user = env.TESTOPS_MOBILE_BROWSERSTACK_USER, key = env.TESTOPS_MOBILE_BROWSERSTACK_KEY;
  if (!user || !key) {
    throw new Error("BrowserStack needs TESTOPS_MOBILE_BROWSERSTACK_USER and TESTOPS_MOBILE_BROWSERSTACK_KEY in the server settings (the same ones the mobile runs use).");
  }
  const t = normalizeTarget(target) || {};
  const caps = {
    browser: t.browser && t.browser !== "chromium" ? t.browser : DEFAULT_BS.browser,
    browser_version: t.browserVersion || DEFAULT_BS.browser_version,
    os: t.platformOs || DEFAULT_BS.os,
    os_version: t.osVersion || DEFAULT_BS.os_version,
    name,
    build: env.TESTOPS_MOBILE_BROWSERSTACK_BUILD || "testops-web",
    project: env.TESTOPS_MOBILE_BROWSERSTACK_PROJECT || "TestOps ai-automate",
    "browserstack.username": user,
    "browserstack.accessKey": key,
  };
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}

/**
 * @returns {Promise<{browser:Object, where:Object}>} `where` is the safe label (no credentials).
 */
async function launchWebBrowser({ runOn = "local", headless = true, executablePath, target, env = process.env, chromium, name } = {}) {
  if (!chromium) ({ chromium } = require("playwright"));
  if (runOn === "browserstack") {
    const wsEndpoint = browserStackEndpoint({ target, env, name });
    const browser = await chromium.connect(wsEndpoint, { timeout: 60000 });
    return { browser, where: webTarget({ browserName: "chromium", wsEndpoint }) };
  }
  const browser = await chromium.launch({ headless, executablePath: executablePath || env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
  return { browser, where: webTarget({ browserName: "chromium", headless }) };
}

const normalizeRunOn = (v) => (String(v || "").toLowerCase() === "browserstack" ? "browserstack" : "local");

module.exports = { launchWebBrowser, browserStackEndpoint, normalizeRunOn };
