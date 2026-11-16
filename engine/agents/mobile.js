/**
 * Mobile counterpart of suite-run's runSuite: same result shape, so the release agents (Triage, Healer, Reporter) and the
 * /releases page work for a mobile app exactly as for a website.
 *
 * Suite format:
 *   { "name": "MyYes app", "platform": "android" | "ios",
 *     "app": { "file": "myyes.apk" }            // an app uploaded to the project (POST /api/projects/:id/apps)
 *         | { "url": "bs://<hash>" },           // an app already on BrowserStack
 *     "provider": "local" | "browserstack", "device": "Samsung Galaxy S23", "osVersion": "14",
 *     "cases": [ { "id", "title", "steps": ["Tap Login", ...] } ] }
 * One fresh session per case (a case never inherits the last case's screen). The app is uploaded to BrowserStack once per release.
 */
const { runEnglish, mobileRunner } = require("../english-run");
const { classify } = require("../suite-run");

const isMobileSuite = (suite) => suite && (suite.platform === "android" || suite.platform === "ios");

async function runMobileSuite(suite, { only, log = console.log, startMobile, resolveApp, appFile, runCase, perCaseTimeoutMs = 600000 } = {}) {
  const platform = suite.platform;
  const cases = (suite.cases || []).filter((c) => !only || only.includes(c.id));
  const start = startMobile || ((o) => require(platform === "ios" ? "../ios-session" : "../session").startSession(o.capabilityOverrides, o));
  const results = [];
  let capability;
  try {
    if (suite.app && suite.app.url) capability = { "appium:app": suite.app.url };
    else if (appFile) capability = await (resolveApp || ((a) => require("../../frontend/upload-session").resolveAppCapability(a)))({ savedPath: appFile, platform, provider: suite.provider });
    else throw new Error("This suite names no app. Upload one to the project and set app.file, or set app.url (bs://...).");
  } catch (err) {
    for (const c of cases) results.push({ id: c.id, title: c.title || "", verdict: "failed", steps: [], failedStep: "(app)", reason: err.message, seconds: 0 });
    return summary(suite, results);
  }
  for (const [n, c] of cases.entries()) {
    const started = Date.now();
    let driver; let out;
    try {
      driver = await start({ platform, capabilityOverrides: capability, provider: suite.provider, device: suite.device, osVersion: suite.osVersion });
      let timer;
      out = await Promise.race([
        runCase ? runCase(c, driver) : runEnglish({ steps: c.steps.join("\n"), runner: mobileRunner(driver, platform), testData: {} }),
        new Promise((ok) => { timer = setTimeout(() => ok({ status: "failed", steps: [{ status: "failed", text: "(case)", reason: `timed out after ${Math.round(perCaseTimeoutMs / 1000)}s` }] }), perCaseTimeoutMs); }),
      ]);
      clearTimeout(timer);
    } catch (err) {
      out = { status: "failed", steps: [{ status: "failed", text: "(start)", reason: err.message }] };
    } finally { if (driver) { try { await driver.deleteSession(); } catch { /* ignore */ } } }
    const bad = (out.steps || []).find((s) => s.status === "failed");
    const row = { id: c.id, title: c.title || "", verdict: classify(out), steps: (out.steps || []).map((s) => ({ text: s.text, status: s.status, ...(s.reason ? { reason: s.reason } : {}) })), failedStep: bad ? bad.text : "", reason: bad ? bad.reason : "", seconds: Math.round((Date.now() - started) / 1000) };
    results.push(row);
    log(`${String(n + 1).padStart(2)}/${cases.length}  ${row.verdict.padEnd(15)} ${row.id.padEnd(12)} ${row.seconds}s${bad ? `  ${bad.text}: ${String(bad.reason).slice(0, 110)}` : ""}`);
  }
  return summary(suite, results);
}

function summary(suite, results) {
  const count = (v) => results.filter((r) => r.verdict === v).length;
  return { suite: suite.name, url: suite.url || "", platform: suite.platform, at: new Date().toISOString(), total: results.length, passed: count("passed"), blockedBySite: count("blocked-by-site"), notRunNetwork: count("not-run-network"), failed: count("failed"), results };
}
module.exports = { runMobileSuite, isMobileSuite };
