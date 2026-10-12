/**
 * WebdriverIO compatibility guard. Starts a tiny fake W3C WebDriver server and drives the
 * calls TestOps ai-automate makes on a session (session.js remote(), then screenshot, page
 * source, window size, pointer actions, execute, keys, element lookup). If a WebdriverIO
 * upgrade changes how any of them reaches the wire, or how we import it, this fails.
 * Real-device behaviour still needs one BrowserStack smoke (docs/UPGRADING.md).
 */
const assert = require("assert");
const http = require("http");
const { remote } = require("webdriverio");

const hits = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const entry = { method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined };
    hits.push(entry);
    const ok = (value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ value })); };
    const u = req.url.replace(/^\/session\/s1/, "");
    if (req.method === "POST" && req.url === "/session") return ok({ sessionId: "s1", capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2" } });
    if (u === "/screenshot") return ok(PNG);
    if (u === "/source") return ok("<hierarchy/>");
    if (u === "/window/rect") return ok({ x: 0, y: 0, width: 1080, height: 2400 });
    if (u === "/actions" || u === "/execute/sync" || u === "/appium/device/keyevent") return ok(null);
    if (u === "/element/active") return ok({ "element-6066-11e4-a52e-4f735466cecf": "e1" });
    if (u === "/elements") return ok([{ "element-6066-11e4-a52e-4f735466cecf": "e2" }]);
    if (u === "/element/e1/clear" || u === "/element/e1/value") return ok(null);
    if (req.method === "DELETE") return ok(null);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: { error: "unknown command", message: `${req.method} ${req.url}`, stacktrace: "" } }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // Same shape engine/remote-provider.js builds for a local Appium host.
  const driver = await remote({ hostname: "127.0.0.1", port, path: "/", logLevel: "silent", capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2" } });
  try {
    assert.strictEqual(driver.sessionId, "s1");
    assert.strictEqual(await driver.takeScreenshot(), PNG);
    assert.strictEqual(await driver.getPageSource(), "<hierarchy/>");
    const size = await driver.getWindowSize();
    assert.deepStrictEqual([size.width, size.height], [1080, 2400]);
    await driver.performActions([{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [{ type: "pointerMove", duration: 0, x: 10, y: 20 }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 50 }, { type: "pointerUp", button: 0 }] }]);
    await driver.releaseActions().catch(() => {});
    await driver.execute("mobile: swipeGesture", { direction: "up", percent: 0.75 });
    const active = await driver.getActiveElement();
    const id = active["element-6066-11e4-a52e-4f735466cecf"] || active.ELEMENT;
    assert.strictEqual(id, "e1");
    await driver.elementClear(id);
    await driver.elementSendKeys(id, "hello");
    await driver.keys(["a", "b"]);
    const el = await driver.$("id=com.example:id/login");
    assert.ok(el.elementId === "e2" || (await el.elementId) === "e2", "$() resolves an element through POST /elements");
  } finally {
    await driver.deleteSession().catch(() => {});
    server.close();
  }
  const seen = hits.map((h) => `${h.method} ${h.url.replace(/^\/session\/s1/, "")}`);
  for (const want of ["POST /session", "GET /screenshot", "GET /source", "POST /actions", "POST /execute/sync", "GET /element/active", "POST /element/e1/clear", "POST /element/e1/value"]) {
    assert.ok(seen.includes(want), `expected a request "${want}", saw: ${[...new Set(seen)].join(", ")}`);
  }
  const act = hits.find((h) => h.url.endsWith("/actions") && h.method === "POST");
  assert.strictEqual(act.body.actions[0].type, "pointer", "pointer actions reach the wire in W3C shape");
  const exec = hits.find((h) => h.url.endsWith("/execute/sync"));
  assert.strictEqual(exec.body.script, "mobile: swipeGesture");
  console.log("  ok - webdriverio client: session, screenshot, source, window size, pointer actions, execute, keys, element lookup");
})().catch((e) => { console.error("  FAIL -", e.stack); server.close(); process.exit(1); });
