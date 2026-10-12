/** The "Run from English" page, driven in a real browser: fill it in, press Run, read what a developer would see. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { createEnglishEndpoint, loadPlaywright } = require("../english-endpoint");
const { chromium } = loadPlaywright();
const { webRunner } = require("../../engine/english-run");

const PAGE = `<!doctype html><title>Demo</title><body><input placeholder="Phone"><input type="password" placeholder="Password">
<button onclick="document.getElementById('o').textContent='Welcome back'">Log in</button><p id="o"></p></body>`;

const model = async (prompt) => {
  const goal = (prompt.match(/^Goal: (.*)$/m) || [])[1] || "";
  const ref = (w) => Number(prompt.split("\n").find((l) => /^\[\d+\]/.test(l) && l.toLowerCase().includes(w)).match(/^\[(\d+)\]/)[1]);
  if (/^Check that/i.test(goal)) return prompt.includes("Welcome back") ? { action: "done", reason: "ok" } : { action: "fail", reason: "no welcome text" };
  if (!prompt.includes("No actions yet.")) return { action: "done", reason: "ok" };
  const t = goal.match(/^Enter (\S+) in the (\w+) field/i);
  if (t) return { action: "type", ref: ref(t[2].toLowerCase()), text: t[1] };
  return { action: "tap", ref: ref("log in") };
};

(async () => {
  const site = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
  await new Promise((r) => site.listen(0, r));
  const ep = createEnglishEndpoint({ webRunner: (page) => webRunner(page, { callModel: model, vision: false }) });
  const app = http.createServer((req, res) => {
    if (req.url === "/english") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(path.join(__dirname, "..", "english.html"))); }
    if (req.method === "POST" && req.url === "/api/english-runs") return ep.handleStart(req, res);
    const m = req.url.match(/^\/api\/english-runs\/([^/]+)\/events$/);
    if (m) return ep.handleEvents(req, res, m[1]);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => app.listen(0, r));

  const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${app.address().port}/english`);

    // Two independent cards, each with English, target and test data.
    assert.strictEqual(await page.locator(".card").count(), 2);
    assert.strictEqual(await page.locator("#web .data-row").count(), 2);
    assert.strictEqual(await page.locator("#web .data-row input[type=password]").count(), 1, "the password value is masked");

    await page.fill("#web-url", `http://127.0.0.1:${site.address().port}/`);
    await page.fill("#web-steps", "Enter ${LOGIN_PHONE} in the phone field\nEnter ${LOGIN_PASSWORD} in the password field\nClick the login button\nCheck that the account page is showing");
    await page.click("#web .run");
    await page.waitForSelector("#web .verdict", { timeout: 60000 });

    assert.match(await page.textContent("#web .verdict"), /Passed — 4 of 4 steps/);
    assert.strictEqual(await page.locator("#web .step.passed").count(), 4);
    assert.ok(await page.locator("#web .step img").count() >= 1, "a screenshot is shown per step");
    const shownText = await page.textContent("#web");
    assert.ok(shownText.includes("${LOGIN_PASSWORD}") && !shownText.includes("@Ytlc1234"), "English shows the name, never the secret value");
    assert.strictEqual(await page.isEnabled("#web .run"), true, "Run is available again");

    // The mobile card is untouched by the web run.
    assert.strictEqual(await page.locator("#mobile .step").count(), 0);

    // Starting mobile with nothing to run on says so in plain words.
    await page.click("#mobile .run");
    await page.waitForSelector("#mobile .verdict.failed");
    assert.match(await page.textContent("#mobile .verdict"), /Upload the app/);

    assert.deepStrictEqual(errors, []);
    console.log("  ok - english page: web run end to end, secrets masked, mobile card independent");
  } finally { await browser.close(); app.close(); site.close(); }
  console.log("frontend/english-page tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
