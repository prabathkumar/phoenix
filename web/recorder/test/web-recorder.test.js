const assert = require("assert");
const http = require("http");
const { startWebLiveView } = require("../web-live-view");
const { toTestCase, toPlaywrightScript } = require("../web-codegen");
const { runWebSteps } = require("../../web-test-case-runner");
const { buildWebSelector } = require("../dom-resolver");
const WebSocket = require("ws");

const PAGE = `<!doctype html><title>Demo</title><body style="margin:0;font:20px sans-serif">
<form onsubmit="return false"><label for="email">Email</label><input id="email" style="position:absolute;left:100px;top:100px;width:300px;height:40px">
<button id="go" type="button" style="position:absolute;left:100px;top:200px;width:200px;height:50px" onclick="document.getElementById('msg').textContent='Welcome back'">Sign in</button></form>
<script>document.addEventListener("keydown",e=>{if(e.key==="Enter"&&document.activeElement.id==="email")document.getElementById("msg").textContent="Submitted via enter"})</script><p id="msg" style="position:absolute;left:100px;top:300px"></p></body>`;

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

test("buildWebSelector prefers testid > role+name > label > id > text > css path", () => {
  assert.deepStrictEqual(buildWebSelector({ role: "button", text: "Go", id: "go" }), { strategy: "role", role: "button", value: "Go", exact: true });
  assert.deepStrictEqual(buildWebSelector({ testid: "t", id: "x" }), { strategy: "testid", value: "t" });
  assert.deepStrictEqual(buildWebSelector({ labelText: "Email", id: "x" }), { strategy: "label", value: "Email" });
  assert.deepStrictEqual(buildWebSelector({ id: "go", text: "Go" }), { strategy: "css", value: "#go" });
  assert.deepStrictEqual(buildWebSelector({ text: "Sign in" }), { strategy: "text", value: "Sign in" });
  assert.deepStrictEqual(buildWebSelector({ cssPath: "div > a" }), { strategy: "css", value: "div > a" });
});

test("codegen emits parameters, locators and assertions", () => {
  const steps = [
    { kind: "navigate", instruction: "Open", url: "http://x.test/" },
    { kind: "type", instruction: "Type", selector: { strategy: "label", value: "Email" }, text: "a@b.c" },
    { kind: "tap", instruction: "Click", selector: { strategy: "text", value: "Sign in" }, expect: { appeared: ["Welcome back"] } },
  ];
  const src = toPlaywrightScript(steps, { name: "login" });
  assert.ok(src.includes('const field_1 = "a@b.c";'));
  assert.ok(src.includes('page.getByLabel("Email").first().fill(field_1)'));
  assert.ok(src.includes('"Welcome back"'));
  assert.strictEqual(toTestCase(steps).baseUrl, "http://x.test");
});

(async () => {
  const CHROMIUM = process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined;
  try {
    const b = await require("playwright").chromium.launch({ executablePath: CHROMIUM });
    await b.close();
  } catch (err) {
    console.log("  skip - live browser tests (Chromium not available: " + err.message.split("\n")[0] + ")");
    console.log("\nweb recorder tests passed (browser tests skipped)");
    process.exit(failed ? 1 : 0);
  }
  const net = require("net");
  const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const serve = async (html, handler) => {
    const server = http.createServer((req, res) => {
      if (handler && handler(req, res)) return;
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(html);
    });
    await new Promise((r) => server.listen(0, r));
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  };
  // Opens a live view on `html` and returns a small client for the mobile-compatible protocol.
  async function open(html, handler, extra = {}) {
    const site = await serve(html, handler);
    const port = await freePort();
    const session = await startWebLiveView({ port, startUrl: site.url, ...extra });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const m = inbox.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error("timeout; got " + inbox.map((x) => x.type).join(",")); await new Promise((r) => setTimeout(r, 50)); } };
    const send = (m) => ws.send(JSON.stringify(m));
    const tap = (x, y) => send({ type: "tap", xRatio: x / 1280, yRatio: y / 800 });
    const finish = async () => { send({ type: "stop" }); return waitFor((m) => m.type === "script-generated"); };
    const close = async () => { ws.close(); await session.close(); site.server.close(); };
    return { site, session, ws, inbox, waitFor, send, tap, finish, close, steps: () => session.recorder.steps };
  }
  async function replay(testCase, options = {}) {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    try { return await runWebSteps(await browser.newPage(), testCase.steps, { baseUrl: testCase.baseUrl, ...options }); } finally { await browser.close(); }
  }

  await test("streams frames and records click, type and the resulting flow (mobile protocol)", async () => {
    const c = await open(PAGE, null, { name: "demo" });
    const frame = await c.waitFor((m) => m.type === "frame");
    assert.strictEqual(frame.mime, "image/jpeg");
    c.tap(250, 120);
    const field = await c.waitFor((m) => m.type === "step-recorded" && m.kind === "tap");
    assert.strictEqual(field.resolvedElement.text, "Email");
    c.send({ type: "type", value: "a@b.c" });
    const typed = await c.waitFor((m) => m.type === "text-entered");
    assert.strictEqual(typed.stepIndex, field.stepIndex); // focusing click folded into the type step
    c.tap(200, 225);
    await c.waitFor((m) => m.type === "step-recorded" && m.stepIndex === 2);
    const done = await c.finish();
    await c.waitFor((m) => m.type === "session-finished");
    assert.deepStrictEqual(c.steps().map((x) => x.kind), ["navigate", "type", "tap"]);
    assert.deepStrictEqual(c.steps()[2].expect, { appeared: ["Welcome back"] });
    assert.strictEqual(done.testName, "demo");
    assert.ok(done.scriptSource.includes('getByLabel("Email")'));
    assert.ok(done.assertionCount >= 1);
    const result = await replay(done.testCaseJson);
    assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    c.ws.close(); c.site.server.close();
  });

  await test("a named test-data value becomes a parameter in the script and the test case", async () => {
    const c = await open(PAGE);
    c.send({ type: "test-data", data: { USERNAME: "bob" } });
    c.tap(250, 120);
    await c.waitFor((m) => m.type === "step-recorded" && m.kind === "tap");
    c.send({ type: "type", value: "bob", param: "USERNAME" });
    await c.waitFor((m) => m.type === "text-entered");
    const done = await c.finish();
    assert.ok(done.scriptSource.includes('const USERNAME = process.env.USERNAME ?? "bob";'), done.scriptSource);
    assert.strictEqual(done.testCaseJson.testData.USERNAME, "bob");
    assert.ok(done.testCaseJson.steps.some((x) => x.text === "${USERNAME}"));
    c.ws.close(); c.site.server.close();
  });

  await test("undo removes the last recorded step", async () => {
    const c = await open(PAGE);
    c.tap(200, 225);
    await c.waitFor((m) => m.type === "step-recorded" && m.kind === "tap");
    c.send({ type: "undo" });
    const undone = await c.waitFor((m) => m.type === "step-undone");
    assert.ok(undone.removed >= 1);
    assert.deepStrictEqual(c.steps().map((x) => x.kind), ["navigate"]);
    c.ws.close(); await c.session.close(); c.site.server.close();
  });

  await test("an API check runs live, reports the response, and records as a step that saves a value", async () => {
    const c = await open(PAGE, (req, res) => {
      if (req.url.startsWith("/api/orders")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "A7", status: "PAID" })); return true; }
      return false;
    });
    c.send({ type: "api", record: true, spec: { method: "GET", url: "/api/orders/1", expect: { status: 200, json: [{ path: "$.status", equals: "PAID" }] }, save: { ORDER_ID: "$.id" } } });
    const r = await c.waitFor((m) => m.type === "api-result");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.recorded, true);
    assert.strictEqual(r.saved.ORDER_ID, "A7");
    const failing = (c.send({ type: "api", record: true, spec: { method: "GET", url: "/api/orders/1", expect: { json: [{ path: "$.status", equals: "NOPE" }] } } }), await c.waitFor((m) => m.type === "api-result" && m.ok === false));
    assert.strictEqual(failing.recorded, false); // failing checks are shown, not recorded, unless forced
    const done = await c.finish();
    assert.ok(done.scriptSource.includes("ORDER_ID"));
    const result = await replay(done.testCaseJson);
    assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    c.ws.close(); c.site.server.close();
  });

  await test("Enter after typing is recorded as a press step, generated, and replays", async () => {
    const c = await open(PAGE);
    c.tap(250, 120);
    await c.waitFor((m) => m.type === "step-recorded" && m.kind === "tap");
    c.send({ type: "type", value: "q" });
    await c.waitFor((m) => m.type === "text-entered");
    c.send({ type: "press", key: "Enter" });
    await c.waitFor((m) => m.type === "step-recorded" && m.kind === "press");
    assert.deepStrictEqual(c.steps()[2].expect, { appeared: ["Submitted via enter"] });
    const done = await c.finish();
    assert.ok(done.scriptSource.includes('.press("Enter")'));
    const result = await replay(done.testCaseJson);
    assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    c.ws.close(); c.site.server.close();
  });

  await test("duplicate links are pinned with nth, scrolls dropped from output, noisy lines not asserted", async () => {
    const DUP = `<!doctype html><title>Dup</title><body style="margin:0;font:20px sans-serif;height:3000px">
<a href="#nav" style="position:absolute;left:20px;top:20px">Pricing</a>
<a href="#body" onclick="document.getElementById('o').innerHTML='<p>Compare every plan today</p><p>RM 99/mth</p><p>All</p><p>phones, always the</p><p>Welcome to the pricing page</p><p>Who is eligible to register for this plan?</p>'" style="position:absolute;left:20px;top:300px">Pricing</a>
<div id="o" style="position:absolute;left:20px;top:400px"></div></body>`;
    const c = await open(DUP);
    c.send({ type: "scroll", direction: "down" });
    await c.waitFor((m) => m.type === "scroll-recorded");
    c.send({ type: "scroll", direction: "up" });
    await new Promise((r) => setTimeout(r, 700));
    c.tap(40, 310);
    await c.waitFor((m) => m.type === "step-recorded" && m.kind === "tap");
    const click = c.steps().find((x) => x.kind === "tap");
    assert.strictEqual(click.selector.nth, 1, JSON.stringify(click.selector));
    assert.ok(!click.expect.appeared.some((l) => l.endsWith("?")), "FAQ questions are not asserted");
    assert.deepStrictEqual(click.expect.appeared, ["Welcome to the pricing page", "Compare every plan today"].sort((a, b) => b.length - a.length));
    const done = await c.finish();
    assert.ok(!done.scriptSource.includes("mouse.wheel"));
    assert.ok(!done.testCaseJson.steps.some((x) => x.kind === "scroll"));
    assert.ok(done.scriptSource.includes(".nth(1)"));
    const result = await replay(done.testCaseJson);
    assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    c.ws.close(); c.site.server.close();
  });

  await test("a <select> click offers its options; picking one records a select step that replays", async () => {
    const SEL = `<!doctype html><title>Sel</title><body style="margin:0;font:20px sans-serif">
<label for="idt" style="position:absolute;left:20px;top:10px">ID Type</label>
<select id="idt" style="position:absolute;left:20px;top:50px;width:300px;height:40px" onchange="document.getElementById('o').textContent='Chosen '+this.options[this.selectedIndex].text"><option>Choose</option><option>NRIC</option><option>Passport</option></select>
<p id="o" style="position:absolute;left:20px;top:200px"></p></body>`;
    const c = await open(SEL);
    c.tap(100, 70);
    const offered = await c.waitFor((m) => m.type === "select-options");
    assert.deepStrictEqual(offered.options.map((o) => o.label), ["Choose", "NRIC", "Passport"]);
    c.send({ type: "select", label: "Passport" });
    const chosen = await c.waitFor((m) => m.type === "step-recorded" && m.kind === "select");
    assert.strictEqual(chosen.option, "Passport");
    const done = await c.finish();
    assert.ok(done.scriptSource.includes('.selectOption({ label: "Passport" })'));
    const result = await replay(done.testCaseJson);
    assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    c.ws.close(); c.site.server.close();
  });

  test("repeated clicks on the same element collapse into one step", () => {
    const sel = { strategy: "role", role: "button", value: "Go", exact: true };
    const out = toTestCase([
      { kind: "navigate", url: "http://x.test/" },
      { kind: "tap", selector: sel, instruction: "a" },
      { kind: "tap", selector: sel, instruction: "b" },
      { kind: "tap", selector: sel, instruction: "c" },
    ]);
    assert.strictEqual(out.steps.filter((s) => s.kind === "tap").length, 1);
  });

  await test("typing before clicking a field is refused with a type-error and nothing runs after stop", async () => {
    const c = await open(PAGE);
    c.send({ type: "type", value: "x" });
    const err = await c.waitFor((m) => m.type === "type-error");
    assert.strictEqual(err.code, "no-field");
    await c.finish();
    const before = c.inbox.length;
    c.send({ type: "tap", xRatio: 0.2, yRatio: 0.3 });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!c.inbox.slice(before).some((m) => m.type === "step-recorded"));
    c.ws.close(); c.site.server.close();
  });

  if (failed) { console.error("\nweb recorder tests FAILED"); process.exit(1); }
  console.log("\nweb recorder tests passed"); process.exit(0);
})();
