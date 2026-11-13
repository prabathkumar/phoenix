/**
 * suite-run.js -- runs a whole suite of English test cases against a site, one fresh browser
 * context per case, and prints one result table. One command per release:
 *   node engine/suite-run.js test-cases/yes-my-release-web.json
 * Results are also written to $PHOENIX_DATA_DIR/suite-results/<suite>-<time>.json (default ./suite-results).
 *
 * A case fails for one of three reasons, kept apart so a release verdict is honest:
 *   passed          every step did what it said
 *   blocked-by-site the site itself stopped the journey (e.g. "Stock Temporarily Reserved"): not a Phoenix or test fault
 *   failed          a step could not be done / a control was missing, disabled or wrong
 */
const fs = require("fs");
const path = require("path");
const { runEnglish, webRunner } = require("./english-run");

/** Classify one finished run. */
function classify(out) {
  if (out.status === "passed") return "passed";
  const failedStep = (out.steps || []).find((s) => s.status === "failed");
  return failedStep && /the page is showing:/i.test(failedStep.reason || "") && /(reserved|out of stock|sold out|unavailable|maintenance|check again|try again)/i.test(failedStep.reason) ? "blocked-by-site" : "failed";
}

function loadPlaywright() {
  try { return require(require.resolve("playwright", { paths: [path.join(__dirname, "..", "web")] })); } catch { return require("playwright"); }
}

async function runSuite(suite, { launch, only, log = console.log, perCaseTimeoutMs = 300000 } = {}) {
  const results = [];
  const cases = (suite.cases || []).filter((c) => !only || only.includes(c.id));
  let browser;
  const launchBrowser = launch || (async () => {
    const { chromium } = loadPlaywright();
    return (await require("../web/browser-provider").launchWebBrowser({ runOn: "local", chromium })).browser;
  });
  try {
    browser = await launchBrowser();
    for (const [n, c] of cases.entries()) {
      const started = Date.now();
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      let out;
      try {
        const page = await context.newPage();
        await page.goto(suite.url, { waitUntil: "load", timeout: 45000 });
        let timer;
        out = await Promise.race([
          runEnglish({ steps: c.steps.join("\n"), runner: webRunner(page), testData: {} }),
          new Promise((ok) => { timer = setTimeout(() => ok({ status: "failed", steps: [{ status: "failed", text: "(case)", reason: `timed out after ${Math.round(perCaseTimeoutMs / 1000)}s` }] }), perCaseTimeoutMs); }),
        ]);
        clearTimeout(timer);
      } catch (err) {
        out = { status: "failed", steps: [{ status: "failed", text: "(start)", reason: err.message }] };
      } finally { try { await context.close(); } catch { /* ignore */ } }
      const verdict = classify(out);
      const bad = (out.steps || []).find((s) => s.status === "failed");
      const row = { id: c.id, title: c.title || "", verdict, steps: (out.steps || []).map((s) => ({ text: s.text, status: s.status, ...(s.reason ? { reason: s.reason } : {}), ...(s.actions && s.actions.length ? { actions: s.actions } : {}) })), failedStep: bad ? bad.text : "", reason: bad ? bad.reason : "", seconds: Math.round((Date.now() - started) / 1000) };
      results.push(row);
      log(`${String(n + 1).padStart(2)}/${cases.length}  ${row.verdict.padEnd(15)} ${row.id.padEnd(12)} ${row.seconds}s${bad ? `  ${bad.text}: ${String(bad.reason).slice(0, 110)}` : ""}`);
    }
  } finally { if (browser) { try { await browser.close(); } catch { /* ignore */ } } }
  const count = (v) => results.filter((r) => r.verdict === v).length;
  return { suite: suite.name, url: suite.url, at: new Date().toISOString(), total: results.length, passed: count("passed"), blockedBySite: count("blocked-by-site"), failed: count("failed"), results };
}

async function main(argv) {
  const file = argv[2];
  if (!file) { console.error("Usage: node engine/suite-run.js <suite.json> [CASE-ID ...]"); process.exit(2); }
  const suite = JSON.parse(fs.readFileSync(file, "utf8"));
  const summary = await runSuite(suite, { only: argv.length > 3 ? argv.slice(3) : undefined });
  const dir = path.join(process.env.PHOENIX_DATA_DIR || ".", "suite-results");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${(suite.name || "suite").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${summary.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\n${summary.suite}\n  passed ${summary.passed} / ${summary.total}   blocked by site ${summary.blockedBySite}   failed ${summary.failed}\n  saved: ${out}`);
  process.exit(summary.failed ? 1 : 0);
}

if (require.main === module) main(process.argv).catch((e) => { console.error(e); process.exit(2); });
module.exports = { runSuite, classify };
