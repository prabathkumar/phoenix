/**
 * Real-browser test of the unified recorder page: the Web/Mobile switch, test
 * data, the "Use NAME" chips, guided cards (Retry resends the same click), the
 * API check form and Undo. Stub WebSocket server; skips without Chromium.
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

function tryRequire(...c) { for (const x of c) { try { return require(x); } catch { /* next */ } } return null; }
const playwright = tryRequire("playwright", path.join(__dirname, "../../web/node_modules/playwright"));
const ws = tryRequire("ws", path.join(__dirname, "../../live-view/node_modules/ws"));
const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAGQAoADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDKooorUgKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==";

(async () => {
  if (!playwright || !ws) { console.log("  skip - unified page test (playwright/ws not installed)"); return; }
  let browser;
  try { browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }); }
  catch { console.log("  skip - unified page test (no Chromium available)"); return; }

  const received = [];
  let taps = 0;
  const wss = new ws.WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    const t = setInterval(() => { try { sock.send(JSON.stringify({ type: "frame", screenshotBase64: JPG, mime: "image/jpeg" })); } catch { /* closed */ } }, 100);
    sock.on("close", () => clearInterval(t));
    sock.on("message", (raw) => {
      const m = JSON.parse(raw.toString()); received.push(m);
      const reply = (o) => sock.send(JSON.stringify(o));
      if (m.type === "tap") {
        taps += 1;
        if (taps === 1) reply({ type: "action-error", message: "click was intercepted" });
        else reply({ type: "step-recorded", stepIndex: 0, kind: "tap", instruction: "Click Sign in", resolvedElement: { text: "Sign in" }, fragile: true });
      }
      if (m.type === "type") reply({ type: "text-entered", stepIndex: 0 });
      if (m.type === "undo") reply({ type: "step-undone", removed: 1, stepCount: 0 });
      if (m.type === "api") reply({ type: "api-result", ok: true, status: 200, durationMs: 12, recorded: !!m.record, stepIndex: 1, saved: { ORDER_ID: "A7" }, response: { bodyPreview: "{\"id\":\"A7\"}" } });
    });
  });
  await new Promise((r) => wss.on("listening", r));

  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const server = http.createServer((q, r) => { r.setHeader("Content-Type", "text/html"); r.end(html); });
  await new Promise((r) => server.listen(0, r));
  const waitMsg = async (pred) => { const t0 = Date.now(); for (;;) { const m = received.find(pred); if (m) return m; if (Date.now() - t0 > 5000) throw new Error("no message; got " + received.map((x) => x.type)); await new Promise((r) => setTimeout(r, 50)); } };

  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://localhost:${server.address().port}/`);

    // Start screen: Web is the default, Start needs a URL; Mobile needs a file.
    assert.strictEqual(await page.isDisabled("#upload-start-btn"), true);
    await page.fill("#web-url", "https://yes.my");
    assert.strictEqual(await page.isDisabled("#upload-start-btn"), false);
    await page.click("#tab-mobile");
    assert.strictEqual(await page.isVisible("#drop-zone"), true);
    assert.strictEqual(await page.isDisabled("#upload-start-btn"), true);
    await page.click("#tab-web");
    assert.strictEqual(await page.isVisible("#web-url"), true);
    await page.click("#td-add");
    await page.fill(".td-name", "username");
    await page.fill(".td-value", "bob");
    assert.deepStrictEqual(await page.evaluate(() => { const r = document.querySelector(".td-row"); return [r.querySelector(".td-name").value, r.querySelector(".td-value").value]; }), ["username", "bob"]);

    await page.evaluate((port) => { document.getElementById("upload-screen").style.display = "none"; document.getElementById("recorder-main").style.display = "flex"; runRecorder("localhost", port, { platform: "web", testData: { USERNAME: "bob" } }); }, wss.address().port);
    await page.waitForSelector("#device-frame img");
    assert.strictEqual(await page.isVisible("#browser-bar"), true);
    assert.ok((await page.getAttribute("#device-frame img", "src")).startsWith("data:image/jpeg;base64,"));
    await waitMsg((m) => m.type === "test-data" && m.data.USERNAME === "bob");

    // Start-failure guidance names the real cause (Appium not reachable is not "server down").
    const g = await page.evaluate(() => window.guidedStartFailure('Unable to connect to "http://127.0.0.1:4723/", make sure browser driver is running', "mobile"));
    assert.ok(/device service/.test(g.title) && /--env-file/.test(g.command), JSON.stringify(g));
    const g2 = await page.evaluate(() => window.guidedStartFailure("fetch failed", "web"));
    assert.ok(/server couldn't be reached/.test(g2.title));

    // A failed click shows a guided card; Retry resends the same click.
    await page.click("#device-frame img", { position: { x: 30, y: 30 } });
    await page.waitForSelector("#guide.show");
    assert.ok((await page.textContent("#guide")).includes("click was intercepted"));
    await page.click("#guide >> text=Retry");
    await page.waitForFunction(() => document.getElementById("steps-list").textContent.includes("Sign in"));
    const clicks = received.filter((m) => m.type === "tap");
    assert.strictEqual(clicks.length, 2);
    assert.deepStrictEqual([clicks[0].xRatio, clicks[0].yRatio], [clicks[1].xRatio, clicks[1].yRatio]);

    // The fragile step raises a card with Keep / Undo; undo removes the row.
    await page.waitForSelector("#guide.show");
    assert.ok((await page.textContent("#guide")).includes("fragile"));
    await page.click("#guide >> text=Undo this step");
    await waitMsg((m) => m.type === "undo");
    await page.waitForFunction(() => document.getElementById("steps-list").textContent.includes("Click the screen"));

    // "Use USERNAME" types the saved value as the named parameter.
    await page.click("#td-chips >> text=Use USERNAME");
    const typed = await waitMsg((m) => m.type === "type");
    assert.deepStrictEqual([typed.value, typed.param], ["bob", "USERNAME"]);

    // API check form builds the spec and shows the response.
    await page.click("#api-panel summary");
    await page.fill("#api-url", "/api/orders/1");
    await page.fill("#api-status", "200");
    await page.fill("#api-path", "$.status");
    await page.fill("#api-equals", "PAID");
    await page.fill("#api-save-name", "order_id");
    await page.fill("#api-save-path", "$.id");
    await page.click("#api-record");
    const api = await waitMsg((m) => m.type === "api");
    assert.deepStrictEqual(api.spec, { method: "GET", url: "/api/orders/1", expect: { status: 200, json: [{ path: "$.status", equals: "PAID" }] }, save: { ORDER_ID: "$.id" } });
    assert.strictEqual(api.record, true);
    await page.waitForFunction(() => document.getElementById("api-result").textContent.includes("HTTP 200"));
    console.log("  ok - unified page: platform switch, test data, guided cards, undo, API check");
  } finally { await browser.close(); server.close(); wss.close(); }
})().catch((e) => { console.error("  FAIL -", e.stack); process.exit(1); });
