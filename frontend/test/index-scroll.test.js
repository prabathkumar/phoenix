/**
 * Real-browser test of the Act 1 recorder page's scroll controls (the page
 * testers actually use): mouse wheel + buttons send {type:"scroll"} and the
 * recorded step shows up. Stub WebSocket device; skips itself when
 * Playwright / ws / Chromium aren't available (e.g. CI).
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

function tryRequire(...c) { for (const x of c) { try { return require(x); } catch { /* next */ } } return null; }
const playwright = tryRequire("playwright", path.join(__dirname, "../../web/node_modules/playwright"));
const ws = tryRequire("ws", path.join(__dirname, "../../live-view/node_modules/ws"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  if (!playwright || !ws) { console.log("  skip - index scroll test (playwright/ws not installed)"); return; }
  let browser;
  try { browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }); }
  catch { console.log("  skip - index scroll test (no Chromium available)"); return; }

  const received = [];
  const wss = new ws.WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    const t = setInterval(() => sock.send(JSON.stringify({ type: "frame", screenshotBase64: PNG })), 100);
    sock.on("close", () => clearInterval(t));
    sock.on("message", (raw) => {
      const m = JSON.parse(raw.toString()); received.push(m);
      if (m.type === "scroll") sock.send(JSON.stringify({ type: "scroll-recorded", stepIndex: received.filter((x) => x.type === "scroll").length - 1, direction: m.direction }));
    });
  });
  await new Promise((r) => wss.on("listening", r));

  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const server = http.createServer((q, r) => { r.setHeader("Content-Type", "text/html"); r.end(html); });
  await new Promise((r) => server.listen(0, r));

  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.evaluate((port) => { document.getElementById("upload-screen").style.display = "none"; document.getElementById("recorder-main").style.display = "flex"; runRecorder("localhost", port); }, wss.address().port);
    await page.waitForSelector("#device-frame img");

    await page.click("#scroll-down-btn");
    await page.waitForFunction(() => document.getElementById("steps-list").textContent.includes("Scrolled down"));

    await page.waitForTimeout(1000); // the throttle window
    await page.hover("#device-frame img");
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => document.getElementById("steps-list").textContent.includes("Scrolled up"));

    assert.deepStrictEqual(received.filter((m) => m.type === "scroll").map((m) => m.direction), ["down", "up"]);
    console.log("  ok - index page: scroll button and mouse wheel send scroll, steps are listed");
  } finally { await browser.close(); server.close(); wss.close(); }
})().catch((e) => { console.error("  FAIL -", e.stack); process.exit(1); });
