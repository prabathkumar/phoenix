/**
 * The ladder against a real page with a scripted "model": the recorded locator
 * is dead, so the step falls Synthetic -> Semantic (vision) -> AI -> Guided and
 * each rescue proposes a promotion patch. Skips without Chromium.
 */
const assert = require("assert");
const http = require("http");
const { runWebSteps } = require("../web-test-case-runner");
const { createPlaywrightSurface } = require("../surface/playwright-surface");
const { runGoalLoop } = require("../../engine/core/goal-loop");

const PAGE = `<!doctype html><title>Shop</title><body style="font:18px sans-serif">
<input id="email" placeholder="Email" style="display:block;margin:10px;width:240px;height:30px">
<button id="cta-7f" style="display:block;margin:10px;width:200px;height:40px" onclick="document.getElementById('msg').textContent='Welcome back'">Sign in</button>
<button style="display:block;margin:10px;width:200px;height:40px" onclick="document.getElementById('msg').textContent='Registered'">Register</button>
<button style="display:block;margin:10px;width:200px;height:40px" onclick="document.getElementById('msg').textContent='Gone'">Delete account</button>
<p id="msg"></p></body>`;

const refOf = (prompt, role, name) => {
  const m = prompt.match(new RegExp(`\\[(\\d+)\\] ${role} "${name}"`));
  return m ? Number(m[1]) : null;
};

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

(async () => {
  const { chromium } = require("playwright");
  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }); }
  catch (e) { console.log("  skip - ladder tests (Chromium not available)"); return; }
  const srv = http.createServer((_, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const fresh = async () => { const page = await browser.newPage(); await page.goto(url); return page; };

  const DEAD = { strategy: "testid", value: "gone-testid" };
  const steps = [{ kind: "tap", instruction: "Click Sign in", selector: DEAD, expect: { appeared: ["Welcome back"] } }];

  await test("Synthetic fails -> Semantic rescues (with vision) and proposes a promotable patch", async () => {
    const seen = [];
    const callModel = async (prompt, opts = {}) => {
      seen.push({ prompt, images: opts.images });
      return { ref: refOf(prompt, "button", "Sign in") };
    };
    const r = await runWebSteps(await fresh(), steps, { callModel });
    assert.strictEqual(r.success, true, JSON.stringify(r.steps));
    assert.strictEqual(r.steps[0].resolvedBy, "semantic");
    assert.deepStrictEqual(r.resolvedBy, { semantic: 1 });
    assert.ok(seen[0].images && seen[0].images.length === 1, "vision: screenshot sent with the element list");
    assert.ok(seen[0].prompt.includes("gone-testid"), "model is told which locator failed");
    const p = r.patches[0];
    assert.strictEqual(p.layer, "semantic");
    assert.strictEqual(p.promotable, true);
    assert.notDeepStrictEqual(p.to, DEAD);
    assert.deepStrictEqual(r.healedSteps[0].selector, p.to);
    assert.strictEqual(r.healedSteps[0].resolvedBy, "semantic");
    // The promoted step now passes on the Synthetic layer by itself.
    const again = await runWebSteps(await fresh(), r.healedSteps, { callModel: async () => { throw new Error("model must not be called"); } });
    assert.strictEqual(again.success, true, JSON.stringify(again.steps));
    assert.deepStrictEqual(again.resolvedBy, { synthetic: 1 });
  });

  await test("a model without vision still works (falls back to text only)", async () => {
    const callModel = async (prompt, opts = {}) => {
      if (opts.images) throw new Error("model does not accept images");
      return { ref: refOf(prompt, "button", "Sign in") };
    };
    const r = await runWebSteps(await fresh(), steps, { callModel });
    assert.strictEqual(r.success, true, JSON.stringify(r.steps));
    assert.strictEqual(r.steps[0].resolvedBy, "semantic");
  });

  await test("a wrong pick is caught by the step's expectation and retried without it", async () => {
    let calls = 0;
    const callModel = async (prompt) => {
      calls += 1;
      return { ref: calls === 1 ? refOf(prompt, "button", "Register") : refOf(prompt, "button", "Sign in") };
    };
    const r = await runWebSteps(await fresh(), steps, { callModel });
    assert.strictEqual(r.success, true, JSON.stringify(r.steps));
    assert.strictEqual(calls, 2);
  });

  await test("Semantic declines -> Guided: the person's selector rescues the step and becomes the patch", async () => {
    const callModel = async () => ({ ref: null, reason: "not sure" });
    let asked;
    const onGuided = async (info) => { asked = info; return { selector: { strategy: "role", role: "button", value: "Sign in", exact: true } }; };
    const r = await runWebSteps(await fresh(), steps, { callModel, onGuided });
    assert.strictEqual(r.success, true, JSON.stringify(r.steps));
    assert.strictEqual(r.steps[0].resolvedBy, "guided");
    assert.ok(asked.reason.includes("semantic: not sure"));
    assert.strictEqual(r.patches[0].layer, "guided");
  });

  await test("with nobody to ask, the failure names every rung that was tried", async () => {
    const r = await runWebSteps(await fresh(), steps, { callModel: async () => ({ ref: null, reason: "not sure" }) });
    assert.strictEqual(r.success, false);
    assert.ok(/tried semantic: semantic: not sure/.test(r.steps[0].reason), r.steps[0].reason);
  });

  await test("Semantic declines -> AI loop reaches the goal and proposes new steps", async () => {
    let loopCalls = 0;
    const callModel = async (prompt) => {
      if (prompt.startsWith("You resolve")) return { ref: null, reason: "not sure" };
      loopCalls += 1;
      return loopCalls === 1 ? { action: "tap", ref: refOf(prompt, "button", "Sign in") } : { action: "done", reason: "welcome shown" };
    };
    const r = await runWebSteps(await fresh(), steps, { callModel, ai: true });
    assert.strictEqual(r.success, true, JSON.stringify(r.steps));
    assert.strictEqual(r.steps[0].resolvedBy, "ai");
    assert.strictEqual(r.patches[0].layer, "ai");
    assert.strictEqual(r.patches[0].replaceWith.length, 1);
    assert.strictEqual(r.patches[0].replaceWith[0].kind, "tap");
    assert.ok(r.patches[0].replaceWith[0].selector);
  });

  await test("goal loop refuses an irreversible action and stops for a person", async () => {
    const surface = createPlaywrightSurface(await fresh());
    const callModel = async (prompt) => ({ action: "tap", ref: refOf(prompt, "button", "Delete account") });
    const r = await runGoalLoop(surface, "clean up", { callModel });
    assert.strictEqual(r.success, false);
    assert.ok(/irreversible/.test(r.reason), r.reason);
    assert.strictEqual(await surface.page.textContent("#msg"), "", "nothing was clicked");
  });

  await test("goal loop notices it is stuck and stops; it never navigates off-site", async () => {
    const surface = createPlaywrightSurface(await fresh());
    const stuck = await runGoalLoop(surface, "x", { callModel: async (p) => ({ action: "scroll", direction: "down" }), maxSteps: 6 });
    assert.strictEqual(stuck.success, false);
    assert.ok(/stuck/.test(stuck.reason), stuck.reason);
    const away = await runGoalLoop(surface, "x", { callModel: async () => ({ action: "navigate", url: "https://evil.example/" }) });
    assert.ok(/refused to navigate/.test(away.reason), away.reason);
  });

  await browser.close(); srv.close();
  if (failed) { console.error("\nladder tests FAILED"); process.exit(1); }
  console.log("\nladder tests passed");
})();
