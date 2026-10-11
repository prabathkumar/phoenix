/**
 * Real-browser test of frontend/record-step.html against a STUB backend
 * (fake /api routes + a fake live-view WebSocket). Skips itself when
 * Playwright / ws / a Chromium aren't available (e.g. CI).
 * Local: TESTOPS_MOBILE_WEB_CHROMIUM_PATH=/path/to/chrome node test/record-step-page.test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

function tryRequire(...candidates) {
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  return null;
}
const playwright = tryRequire("playwright", path.join(__dirname, "../../web/node_modules/playwright"));
const ws = tryRequire("ws", path.join(__dirname, "../../live-view/node_modules/ws"));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  if (!playwright || !ws) { console.log("  skip - record-step page test (playwright/ws not installed)"); return; }
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
  } catch { console.log("  skip - record-step page test (no Chromium available)"); return; }

  const calls = [];
  const wss = new ws.WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    const t = setInterval(() => sock.send(JSON.stringify({ type: "frame", screenshotBase64: PNG })), 100);
    sock.on("close", () => clearInterval(t));
    sock.on("message", (raw) => {
      const m = JSON.parse(raw.toString()); calls.push(["ws", m.type]);
      if (m.type === "tap") {
        if (wss.failNext) { wss.failNext = false; return sock.send(JSON.stringify({ type: "action-error", message: "Unknown mobile command" })); }
        sock.send(JSON.stringify({ type: "step-recorded", stepIndex: 0, resolvedElement: { strategy: "id", value: "buyAddonLayout" } }));
      }
    });
  });
  await new Promise((r) => wss.on("listening", r));
  const wsPort = wss.address().port;

  const html = fs.readFileSync(path.join(__dirname, "../record-step.html"), "utf8");
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.setHeader("Content-Type", "text/html"); return res.end(html); }
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}; calls.push([req.url, body]);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/record-step") return res.end(JSON.stringify(body.sessionId === "dead" ? { success: false, error: "Session not started or terminated" } : { success: true, recordingId: "rec-1", port: wsPort }));
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  try {
    // 1) a dead session shows a clear error and re-enables Start
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(`${base}/?sessionId=dead&platform=android&testCaseFile=addons.json&stepIndex=20`);
    await page.click("#startBtn");
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("terminated"));
    assert.strictEqual(await page.isDisabled("#startBtn"), false);

    // 2) happy path: record -> tap (first one fails on device, shown, not fatal) -> tap -> apply
    wss.failNext = true;
    await page.fill("#sessionId", "live-1");
    await page.click("#startBtn");
    await page.waitForSelector("#device img");
    await page.click("#device img");
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("tap failed"));
    await page.click("#device img");
    await page.waitForFunction(() => document.getElementById("resolved").textContent.includes("buyAddonLayout"));
    await page.click("#applyBtn");
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("Saved to addons.json step 20"));

    const apply = calls.find((c) => c[0] === "/api/apply-recorded-step");
    assert.deepStrictEqual(apply[1], { recordingId: "rec-1", testCaseFile: "addons.json", stepIndex: 20 });
    assert.ok(calls.some((c) => c[0] === "/api/record-step/rec-1/stop"), "recording must be stopped after apply");
    const taps = calls.filter((c) => c[0] === "ws" && c[1] === "tap").length;
    assert.strictEqual(taps, 2);
    console.log("  ok - record-step page: error shown, failed tap recoverable, apply saves + stops");
  } finally { await browser.close(); server.close(); wss.close(); }
})().catch((e) => { console.error("  FAIL -", e.stack); process.exit(1); });
