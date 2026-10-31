/**
 * Where a recording or a run happened: local or BrowserStack, and on what
 * (Appium device, or a Playwright browser). One small label, shared by both
 * engines, written next to results and recordings. Purely informational:
 * nothing here changes how a script replays, and it never carries credentials.
 *
 *   { engine:"appium"|"playwright", provider:"local"|"browserstack", platform,
 *     device?, osVersion?, browser?, browserVersion?, headless?, host?,
 *     sessionId?, sessionUrl? }
 */
const LOCAL = "local";
const BROWSERSTACK = "browserstack";
const SESSION_URL = (id) => `https://app-automate.browserstack.com/dashboard/v2/sessions/${encodeURIComponent(id)}`;

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const pickCap = (caps, ...keys) => { for (const k of keys) { const v = caps[k] ?? caps[`appium:${k}`]; if (v) return String(v); } return undefined; };

/**
 * Mobile (Appium). `capabilities` may be the requested or the session-returned ones.
 * @param {{platform:string, provider?:string, capabilities?:Object, sessionId?:string, env?:Object}} o
 */
function mobileTarget({ platform, provider, capabilities = {}, sessionId, env = process.env }) {
  const p = provider || String(env.TESTOPS_MOBILE_APPIUM_PROVIDER || LOCAL).toLowerCase();
  const bs = capabilities["bstack:options"] || {};
  const device = pickCap(capabilities, "deviceName", "device") || bs.deviceName;
  const osVersion = pickCap(capabilities, "platformVersion", "os_version") || bs.osVersion;
  return clean({
    engine: "appium", provider: p === BROWSERSTACK ? BROWSERSTACK : LOCAL, platform,
    device, osVersion,
    host: p === BROWSERSTACK ? "hub-cloud.browserstack.com" : `${env.TESTOPS_MOBILE_APPIUM_HOST || "127.0.0.1"}:${env.TESTOPS_MOBILE_APPIUM_PORT || 4723}`,
    sessionId,
    sessionUrl: p === BROWSERSTACK && sessionId ? SESSION_URL(sessionId) : undefined,
  });
}

/** From a live WebdriverIO driver (uses its returned capabilities and session id). */
function targetFromDriver(driver, platform, env = process.env) {
  return mobileTarget({ platform, capabilities: (driver && driver.capabilities) || {}, sessionId: driver && driver.sessionId, env });
}

/**
 * Web (Playwright). A browser launched here is "local"; one reached through a
 * BrowserStack websocket endpoint is "browserstack".
 * @param {{browserName?:string, browserVersion?:string, headless?:boolean, wsEndpoint?:string, sessionId?:string}} o
 */
function webTarget({ browserName = "chromium", browserVersion, headless, wsEndpoint, sessionId } = {}) {
  const remote = typeof wsEndpoint === "string" && /browserstack\.com/i.test(wsEndpoint);
  let host;
  if (remote) { try { host = new URL(wsEndpoint).host; } catch { host = "browserstack.com"; } }
  return clean({
    engine: "playwright", provider: remote ? BROWSERSTACK : LOCAL, platform: "web",
    browser: browserName, browserVersion, headless, host, sessionId,
  });
}

/** From a Playwright Browser object (name and version); `opts` adds headless / wsEndpoint. */
function targetFromBrowser(browser, opts = {}) {
  let name = "chromium", version;
  try { const bt = browser && typeof browser.browserType === "function" ? browser.browserType() : null; if (bt && bt.name) name = bt.name(); } catch { /* keep default */ }
  try { if (browser && typeof browser.version === "function") version = browser.version(); } catch { /* unknown */ }
  return webTarget({ browserName: name, browserVersion: version, ...opts });
}

/** "BrowserStack · iPhone 15 · iOS 17" / "Local · Chromium 131". */
function targetLabel(t) {
  if (!t || !t.provider) return "Unknown";
  const where = t.provider === BROWSERSTACK ? "BrowserStack" : "Local";
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const what = t.engine === "playwright"
    ? [cap(t.browser), t.browserVersion && String(t.browserVersion).split(".")[0]].filter(Boolean).join(" ")
    : [t.device, t.osVersion && `${t.platform === "ios" ? "iOS" : "Android"} ${t.osVersion}`].filter(Boolean).join(" · ");
  return [where, what].filter(Boolean).join(" · ");
}

/**
 * A flag, never a block: replaying where it was not recorded. Locators proven
 * on one provider or device can differ on another.
 * @returns {{message:string}|null}
 */
function compareTargets(recorded, ran) {
  if (!recorded || !ran || !recorded.provider || !ran.provider) return null;
  if (recorded.provider !== ran.provider) return { message: `Recorded on ${targetLabel(recorded)} but ran on ${targetLabel(ran)}. Locators proven on one provider can differ on the other.` };
  if (recorded.engine === "appium" && ran.engine === "appium" && recorded.device && ran.device && recorded.device !== ran.device) return { message: `Recorded on ${targetLabel(recorded)} but ran on ${targetLabel(ran)}. A different device can lay the screen out differently.` };
  if (recorded.engine === "playwright" && ran.engine === "playwright" && recorded.browser && ran.browser && recorded.browser !== ran.browser) return { message: `Recorded on ${targetLabel(recorded)} but ran on ${targetLabel(ran)}.` };
  return null;
}

const ALLOWED = ["engine", "provider", "platform", "device", "osVersion", "browser", "browserVersion", "headless", "host", "sessionId", "sessionUrl", "label"];

/**
 * A target handed in by the caller (TestOps already knows the BrowserStack
 * device and session from its own integration, so it can pass them instead of
 * the engine working them out). Only the fields above survive, as short plain
 * values; anything else, credentials included, is dropped. Returns undefined
 * when there is no usable provider.
 */
function normalizeTarget(input) {
  let o = input;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return undefined; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const provider = String(o.provider || "").toLowerCase();
  if (provider !== LOCAL && provider !== BROWSERSTACK) return undefined;
  const out = { provider };
  for (const k of ALLOWED) {
    if (k === "provider" || o[k] === undefined || o[k] === null || o[k] === "") continue;
    const v = o[k];
    if (k === "headless") { if (typeof v === "boolean") out.headless = v; continue; }
    if (typeof v !== "string" && typeof v !== "number") continue;
    const text = String(v).slice(0, 200);
    if (k === "sessionUrl" && !/^https:\/\//i.test(text)) continue;
    if (k === "engine" && text !== "appium" && text !== "playwright") continue;
    out[k] = text;
  }
  return out;
}

/** Passed values win; what the engine can see for itself fills the gaps. */
function mergeTarget(passed, derived) {
  if (!passed) return derived;
  return clean({ ...(derived || {}), ...passed });
}

module.exports = { normalizeTarget, mergeTarget, mobileTarget, targetFromDriver, webTarget, targetFromBrowser, targetLabel, compareTargets, LOCAL, BROWSERSTACK };
