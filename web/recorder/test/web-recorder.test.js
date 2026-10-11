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
    await waitFor((m) => m.type === "step" && m.step.selector && m.step.selector.strategy === "role" && m.step.selector.value === "Sign in");
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

  await test("duplicate links are pinned with nth, scrolls are dropped from output, and noisy lines are not asserted", async () => {
    const DUP = `<!doctype html><title>Dup</title><body style="margin:0;font:20px sans-serif;height:3000px">
<a href="#nav" style="position:absolute;left:20px;top:20px">Pricing</a>
<a href="#body" onclick="document.getElementById('o').innerHTML='<p>Compare every plan today</p><p>RM 99/mth</p><p>All</p><p>phones, always the</p><p>Welcome to the pricing page</p><p>Who is eligible to register for this plan?</p>'" style="position:absolute;left:20px;top:300px">Pricing</a>
<div id="o" style="position:absolute;left:20px;top:400px"></div></body>`;
    const dsrv = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(DUP); });
    await new Promise((r) => dsrv.listen(0, r));
    const durl = `http://127.0.0.1:${dsrv.address().port}/`;
    const p4 = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const s4 = await startWebLiveView({ port: p4, startUrl: durl });
    const w4 = new WebSocket(`ws://127.0.0.1:${p4}`);
    const got = [];
    w4.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => w4.on("open", r));
    const wf = async (pred) => { const t0 = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t0 > 8000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };
    w4.send(JSON.stringify({ type: "scroll", direction: "down" }));
    await wf((m) => m.type === "step" && m.step.kind === "scroll");
    w4.send(JSON.stringify({ type: "scroll", direction: "up" }));
    await new Promise((r) => setTimeout(r, 700));
    w4.send(JSON.stringify({ type: "click", xRatio: 40 / 1280, yRatio: 310 / 800 }));
    const click = await wf((m) => m.type === "step" && m.step.kind === "tap");
    assert.strictEqual(click.step.selector.nth, 1, JSON.stringify(click.step.selector));
    assert.ok(!click.step.expect.appeared.some((l) => l.endsWith("?")), "FAQ questions are not asserted");
    assert.deepStrictEqual(click.step.expect.appeared, ["Welcome to the pricing page", "Compare every plan today"].sort((a, b) => b.length - a.length));
    w4.send(JSON.stringify({ type: "stop" }));
    const done = await wf((m) => m.type === "stopped");
    assert.ok(!done.script.includes("mouse.wheel"));
    assert.ok(!done.testCase.steps.some((x) => x.kind === "scroll"));
    assert.ok(done.script.includes(".nth(1)"));
    assert.ok(/test\("127_0_0_1_web_flow"/.test(done.script));
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    try {
      const result = await runWebSteps(await browser.newPage(), done.testCase.steps, { baseUrl: done.testCase.baseUrl });
      assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    } finally { await browser.close(); }
    w4.close(); dsrv.close();
  });

  await test("a <select> click offers its options; picking one records a select step that replays", async () => {
    const SEL = `<!doctype html><title>Sel</title><body style="margin:0;font:20px sans-serif">
<label for="idt" style="position:absolute;left:20px;top:10px">ID Type</label>
<select id="idt" style="position:absolute;left:20px;top:50px;width:300px;height:40px" onchange="document.getElementById('o').textContent='Chosen '+this.options[this.selectedIndex].text"><option>Choose</option><option>NRIC</option><option>Passport</option></select>
<p id="o" style="position:absolute;left:20px;top:200px"></p></body>`;
    const ssrv = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(SEL); });
    await new Promise((r) => ssrv.listen(0, r));
    const surl = `http://127.0.0.1:${ssrv.address().port}/`;
    const p5 = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const s5 = await startWebLiveView({ port: p5, startUrl: surl });
    const w5 = new WebSocket(`ws://127.0.0.1:${p5}`);
    const got = [];
    w5.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => w5.on("open", r));
    const wf = async (pred) => { const t0 = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t0 > 8000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };
    w5.send(JSON.stringify({ type: "click", xRatio: 100 / 1280, yRatio: 70 / 800 }));
    const offered = await wf((m) => m.type === "select-options");
    assert.deepStrictEqual(offered.options.map((o) => o.label), ["Choose", "NRIC", "Passport"]);
    w5.send(JSON.stringify({ type: "select", label: "Passport" }));
    const chosen = await wf((m) => m.type === "step" && m.step.kind === "select");
    assert.strictEqual(chosen.step.option, "Passport");
    w5.send(JSON.stringify({ type: "stop" }));
    const done = await wf((m) => m.type === "stopped");
    assert.ok(done.script.includes('.selectOption({ label: "Passport" })'));
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
    try {
      const result = await runWebSteps(await browser.newPage(), done.testCase.steps, { baseUrl: done.testCase.baseUrl });
      assert.strictEqual(result.success, true, JSON.stringify(result.steps || result));
    } finally { await browser.close(); }
    w5.close(); ssrv.close();
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
