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

test("buildWebSelector prefers testid > label > id > text > css path", () => {
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
  try {
    const b = await require("playwright").chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    await b.close();
  } catch (err) {
    console.log("  skip - live browser tests (Chromium not available: " + err.message.split("\n")[0] + ")");
    console.log("\nweb recorder tests passed (browser tests skipped)");
    process.exit(failed ? 1 : 0);
  }
  const srv = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const net = require("net");
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const session = await startWebLiveView({ port, startUrl: url, name: "demo" });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on("open", r));
  const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const m = inbox.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

  await test("streams frames and records click, type and the resulting flow", async () => {
    await waitFor((m) => m.type === "frame");
    ws.send(JSON.stringify({ type: "click", xRatio: 250 / 1280, yRatio: 120 / 800 }));
    const field = await waitFor((m) => m.type === "step" && m.step.kind === "tap");
    assert.deepStrictEqual(field.step.selector, { strategy: "label", value: "Email" });
    ws.send(JSON.stringify({ type: "type", text: "a@b.c" }));
    const typed = await waitFor((m) => m.type === "step" && m.step.kind === "type");
    assert.strictEqual(typed.step.text, "a@b.c");
    assert.strictEqual(typed.index, field.index); // the focusing click is folded into the type step
    ws.send(JSON.stringify({ type: "click", xRatio: 200 / 1280, yRatio: 225 / 800 }));
    await waitFor((m) => m.type === "step" && m.step.selector && m.step.selector.value === "#go");
    ws.send(JSON.stringify({ type: "stop" }));
    const done = await waitFor((m) => m.type === "stopped");
    assert.deepStrictEqual(done.steps.map((s) => s.kind), ["navigate", "type", "tap"]);
    assert.deepStrictEqual(done.steps[2].expect, { appeared: ["Welcome back"] });
    assert.ok(done.script.includes("page.getByLabel(\"Email\")"));

    // The recorded test case must replay through the real runner and pass.
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    try {
      const page = await browser.newPage();
      const result = await runWebSteps(page, done.testCase.steps, { baseUrl: done.testCase.baseUrl });
      assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    } finally { await browser.close(); }
  });

  await test("Enter after typing is recorded as a press step, generated, and replays", async () => {
    const p3 = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const s3 = await startWebLiveView({ port: p3, startUrl: url });
    const w3 = new WebSocket(`ws://127.0.0.1:${p3}`);
    const got = [];
    w3.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => w3.on("open", r));
    const wf = async (pred) => { const t0 = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t0 > 8000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };
    w3.send(JSON.stringify({ type: "click", xRatio: 250 / 1280, yRatio: 120 / 800 }));
    await wf((m) => m.type === "step" && m.step.kind === "tap");
    w3.send(JSON.stringify({ type: "type", text: "q" }));
    await wf((m) => m.type === "step" && m.step.kind === "type");
    w3.send(JSON.stringify({ type: "press", key: "Enter" }));
    const pressed = await wf((m) => m.type === "step" && m.step.kind === "press");
    assert.deepStrictEqual(pressed.step.expect, { appeared: ["Submitted via enter"] });
    w3.send(JSON.stringify({ type: "stop" }));
    const done = await wf((m) => m.type === "stopped");
    assert.ok(done.script.includes('.press("Enter")'));
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    try {
      const result = await runWebSteps(await browser.newPage(), done.testCase.steps, { baseUrl: done.testCase.baseUrl });
      assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    } finally { await browser.close(); }
    w3.close();
  });

  await test("typing before clicking a field is refused with a message", async () => {
    const s2port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const s2 = await startWebLiveView({ port: s2port, startUrl: url });
    const w2 = new WebSocket(`ws://127.0.0.1:${s2port}`);
    const got = [];
    w2.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => w2.on("open", r));
    w2.send(JSON.stringify({ type: "type", text: "x" }));
    const t0 = Date.now();
    while (!got.find((m) => m.type === "error") && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.find((m) => m.type === "error"));
    w2.close(); await s2.close();
  });

  ws.close(); await session.close(); srv.close();
  if (failed) { console.error("\nweb recorder tests FAILED"); process.exit(1); }
  console.log("\nweb recorder tests passed"); process.exit(0);
})();
