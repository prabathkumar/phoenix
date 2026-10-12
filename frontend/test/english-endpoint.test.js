/**
 * End to end for "Run from English": a REAL Chromium on a local login page, driven through
 * the HTTP endpoint and the event stream. Only the model is scripted (no Ollama needed);
 * everything else - snapshot, actions, test-data substitution, redaction, SSE - is the real code.
 */
const assert = require("assert");
const http = require("http");
const { createEnglishEndpoint, friendlyStartError } = require("../english-endpoint");
const { webRunner } = require("../../engine/english-run");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

const PAGE = `<!doctype html><title>Demo</title><body>
<input placeholder="Phone" id="p"><input type="password" placeholder="Password" id="w">
<button id="b" onclick="document.getElementById('o').textContent=(document.getElementById('p').value==='0116611'&&document.getElementById('w').value==='s3cret!')?'Welcome back':'Wrong details'">Log in</button>
<p id="o"></p></body>`;

// A tiny stand-in for the model: reads the prompt like the real one would and answers with JSON.
function scriptedModel() {
  const refOf = (prompt, word) => {
    const line = prompt.split("\n").find((l) => /^\[\d+\]/.test(l) && l.toLowerCase().includes(word));
    return line ? Number(line.match(/^\[(\d+)\]/)[1]) : null;
  };
  return async (prompt) => {
    const goal = (prompt.match(/^Goal: (.*)$/m) || [])[1] || "";
    const acted = !prompt.includes("No actions yet.");
    if (/^Check that/i.test(goal)) return prompt.includes("Welcome back") ? { action: "done", reason: "welcome text is showing" } : { action: "fail", reason: "the welcome text is not showing" };
    if (acted) return { action: "done", reason: "did it" };
    const typed = goal.match(/^Enter (\S+) in the (\w+) field/i);
    if (typed) return { action: "type", ref: refOf(prompt, typed[2].toLowerCase()), text: typed[1] };
    if (/login button/i.test(goal)) return { action: "tap", ref: refOf(prompt, "log in") };
    return { action: "fail", reason: `no idea how to ${goal}` };
  };
}

(async () => {
  // The web tests need a real Chromium. CI installs one; a machine without one skips them loudly.
  let haveBrowser = true;
  try { const b = await require("../english-endpoint").loadPlaywright().chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }); await b.close(); }
  catch (e) { haveBrowser = false; console.log(`  SKIPPED web tests - no browser available (${String(e.message).split("\n")[0]})`); }
  const webTest = (name, fn) => (haveBrowser ? test(name, fn) : Promise.resolve());

  const site = http.createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  let mobileStarts = 0; let mobileGate;
  const ep = createEnglishEndpoint({
    webRunner: (page) => webRunner(page, { callModel: scriptedModel(), vision: false }),
    startMobile: async () => { mobileStarts += 1; if (mobileGate) await mobileGate; return { takeScreenshot: async () => "PNG", deleteSession: async () => {} }; },
    mobileRunner: () => ({ goal: async (t) => ({ success: !/fail/.test(t), reason: "nope", actions: [{ label: "tap" }] }), screenshot: async () => ({ base64: "PNG", mime: "image/png" }) }),
  });
  const app = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/english-runs") return ep.handleStart(req, res);
    const m = req.url.match(/^\/api\/english-runs\/([^/]+)\/events$/);
    if (m) return ep.handleEvents(req, res, m[1]);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;

  const start = (body) => fetch(`${base}/api/english-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const events = async (id) => (await (await fetch(`${base}/api/english-runs/${id}/events`)).text())
    .split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
  const finish = (evs) => evs.find((e) => e.type === "run-finished");

  const STEPS = "Enter ${PHONE} in the phone field\nEnter ${PASSWORD} in the password field\nClick the login button\nCheck that the account page is showing";

  await webTest("web: the English runs in a real browser, passes, and the secret never crosses the wire", async () => {
    const r = await start({ platform: "web", url: siteUrl, steps: STEPS, testData: { PHONE: "0116611", PASSWORD: "s3cret!" } });
    assert.strictEqual(r.status, 200);
    const evs = await events((await r.json()).runId);
    const end = finish(evs);
    assert.strictEqual(end.status, "passed", JSON.stringify(end));
    assert.strictEqual(end.passed, 4);
    assert.ok(evs.some((e) => e.type === "step-finished" && e.screenshot), "each step carries a screenshot");
    assert.ok(!JSON.stringify(evs).includes("s3cret!"), "secret value must not be emitted");
    assert.deepStrictEqual(evs.filter((e) => e.type === "step-started").map((e) => e.text), STEPS.split("\n"));
  });

  await webTest("web: wrong test data fails at the check step, with the reason, and nothing after it runs", async () => {
    const r = await start({ platform: "web", url: siteUrl, steps: STEPS, testData: { PHONE: "0116611", PASSWORD: "wrong" } });
    const end = finish(await events((await r.json()).runId));
    assert.strictEqual(end.status, "failed");
    assert.deepStrictEqual(end.steps.map((s) => s.status), ["passed", "passed", "passed", "failed"]);
    assert.match(end.steps[3].reason, /welcome text is not showing/);
  });

  await webTest("web: a missing test-data value is reported before the browser does anything", async () => {
    const r = await start({ platform: "web", url: siteUrl, steps: STEPS, testData: { PHONE: "1" } });
    const end = finish(await events((await r.json()).runId));
    assert.strictEqual(end.status, "failed");
    assert.match(end.reason, /\$\{PASSWORD\}/);
  });

  await webTest("web: an unreachable URL fails the run with a message instead of hanging", async () => {
    const r = await start({ platform: "web", url: "http://127.0.0.1:1/", steps: "Click the login button", testData: {} });
    const end = finish(await events((await r.json()).runId));
    assert.strictEqual(end.status, "failed");
    assert.ok(end.reason.length > 0);
  });

  await test("bad requests are refused with a clear message", async () => {
    assert.strictEqual((await start({ platform: "web", steps: "x" })).status, 400);
    assert.strictEqual((await start({ platform: "web", url: siteUrl, steps: "  " })).status, 400);
    const r = await fetch(`${base}/api/english-runs/nope/events`);
    assert.strictEqual(r.status, 404);
  });

  const mobile = (steps, extra = {}) => {
    const fd = new FormData();
    fd.append("platform", "android"); fd.append("steps", steps); fd.append("testData", JSON.stringify({ PHONE: "1" }));
    fd.append("appUrl", "bs://abc123");
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fetch(`${base}/api/english-runs`, { method: "POST", body: fd });
  };

  await test("mobile: runs independently of web, from an already-uploaded app URL", async () => {
    const r = await mobile("Tap the login button\nEnter ${PHONE}");
    assert.strictEqual(r.status, 200);
    const end = finish(await events((await r.json()).runId));
    assert.strictEqual(end.status, "passed");
    assert.strictEqual(mobileStarts, 1);
  });

  await test("mobile: a second run while one is active is refused (a device session costs money)", async () => {
    let release; mobileGate = new Promise((r) => { release = r; });
    const first = await mobile("Tap it");
    assert.strictEqual(first.status, 200);
    const second = await mobile("Tap it");
    assert.strictEqual(second.status, 409);
    release(); mobileGate = null;
    finish(await events((await first.json()).runId));
    const third = await mobile("Tap it");
    assert.strictEqual(third.status, 200, "the slot is released when the run ends");
    finish(await events((await third.json()).runId));
  });

  await test("mobile: needs an app file or an app URL", async () => {
    const fd = new FormData(); fd.append("platform", "android"); fd.append("steps", "Tap it");
    assert.strictEqual((await fetch(`${base}/api/english-runs`, { method: "POST", body: fd })).status, 400);
  });

  await test("friendlyStartError explains the missing device service in plain words", () => {
    assert.match(friendlyStartError('Unable to connect to "http://127.0.0.1:4723/"'), /--env-file \.env/);
    assert.strictEqual(friendlyStartError("something else"), "something else");
  });

  app.close(); site.close();
  if (failed) process.exit(1);
  console.log("frontend/english-endpoint tests passed");
})();
