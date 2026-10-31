/** The pipeline page against the real server: stages listed, tools shown, one stage run on its own, a gate approved. */
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const root = path.join(__dirname, "..", "..");
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  const env = { ...process.env, TESTOPS_MOBILE_FRONTEND_PORT: String(port), TESTOPS_MOBILE_LIVE_VIEW_PORT: String(await free()), TESTOPS_GATEWAY_DIR: path.join(tmp, "lib"), TESTOPS_GATEWAY_LOG: path.join(tmp, "g.jsonl"), TESTOPS_PIPELINE_LOG: path.join(tmp, "p.jsonl"), TESTOPS_RUNS_DIR: path.join(tmp, "runs"), TESTOPS_TESTDATA_DIR: path.join(tmp, "td"), ZAP_API_URL: "http://127.0.0.1:1" };
  const server = spawn("node", ["frontend/server.js"], { cwd: root, env, stdio: "ignore" });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    const { chromium } = require("../../web/node_modules/playwright");
    browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    const page = await browser.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`http://localhost:${port}/pipeline`);
    await page.waitForSelector("#stages .stage");
    assert.ok((await page.locator("#stages .stage").count()) >= 12);
    assert.ok((await page.textContent("#tools")).includes("locust"));
    await page.fill("#goal", "check the gate");
    const dast = page.locator("#stages .stage", { hasText: "DAST" });
    await dast.locator("text=Run just this").click();
    await page.waitForSelector("#stages .st.needs-you");                       // the live scan asks first
    await page.fill("#app", "http://127.0.0.1:1");
    await dast.locator("text=Approve and run").click();
    await page.waitForFunction(() => !/Running/.test(document.querySelector("#msg").textContent));
    assert.ok(!/needs-you/.test(await dast.locator(".st").first().getAttribute("class")));   // approved: it ran (and reports its own result)
    assert.ok((await page.textContent("#record")).includes('"id"'));          // the run record is shown
    assert.deepStrictEqual(errs, []);
    console.log("pipeline-page tests passed");
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
