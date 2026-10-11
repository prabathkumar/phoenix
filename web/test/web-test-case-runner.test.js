const assert = require("assert");
const http = require("http");
const { runWebSteps, validateWebSteps } = require("../web-test-case-runner");

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); }
}

// ---- a minimal fake Playwright page (no browser needed in CI) ----
function makeFakePage({ lines = ["Home"], onClick = {}, elements = ["#login"], url = "http://x.test/" } = {}) {
  const page = {
    _lines: [...lines], _url: url, clicks: [], fills: [],
    url() { return this._url; },
    async title() { return "Fake"; },
    async goto(u) { this._url = u; },
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("innerText")) return [...this._lines];
      return [{ tag: "button", text: "Login", id: "login" }]; // SERIALIZE_DOM_SCRIPT
    },
    async waitForLoadState() {},
    mouse: { async wheel() {} },
    locator(sel) {
      const exists = elements.includes(sel);
      return {
        async count() { return exists ? 1 : 0; },
        first() { return this; },
        async click() { page.clicks.push(sel); if (onClick[sel]) page._lines = onClick[sel]; },
        async fill(t) { page.fills.push([sel, t]); },
      };
    },
    getByText() { return page.locator("__text__"); },
    getByLabel() { return page.locator("__label__"); },
    getByTestId() { return page.locator("__testid__"); },
  };
  return page;
}
const resolveLogin = async () => ({ resolved: true, selector: { strategy: "css", value: "#login" } });

(async () => {
  await test("validateWebSteps rejects malformed steps", () => {
    assert.throws(() => validateWebSteps([{ kind: "teleport" }]), /invalid "kind"/);
    assert.throws(() => validateWebSteps([{ kind: "navigate" }]), /no "url"/);
    assert.throws(() => validateWebSteps([{ kind: "assert", assert: {} }]), /no checks/);
    assert.throws(() => validateWebSteps([{ kind: "tap" }]), /instruction.*or.*selector/);
    assert.throws(() => validateWebSteps([{ kind: "type", instruction: "x" }]), /no "text"/);
  });

  await test("navigate + tap + assert all pass -> status pass, shared contract shape", async () => {
    const page = makeFakePage({ onClick: { "#login": ["Welcome back"] } });
    const r = await runWebSteps(page, [
      { kind: "navigate", url: "/home" },
      { kind: "tap", instruction: "tap login", expect: { appeared: ["Welcome"] } },
      { kind: "assert", assert: { textVisible: ["welcome back"], urlContains: "/home" } },
    ], { baseUrl: "http://x.test", testCase: "t", resolveAction: resolveLogin });
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.platform, "web");
    assert.deepStrictEqual(r.summary, { total: 3, passed: 3, failed: 0, skipped: 0 });
    assert.deepStrictEqual(r.updatedSteps[1].resolvedSelector, { strategy: "css", value: "#login" });
  });

  await test("failed expect -> the step and the whole case FAIL (tap succeeded but outcome wrong)", async () => {
    const page = makeFakePage({ onClick: { "#login": ["Something else"] } });
    const r = await runWebSteps(page, [
      { kind: "tap", instruction: "tap login", expect: { appeared: ["Welcome"] } },
    ], { resolveAction: resolveLogin });
    assert.strictEqual(r.status, "fail");
    assert.match(r.detail, /expected to appear but didn't/);
    assert.strictEqual(r.updatedSteps[0].resolvedSelector, undefined, "a failed step must not pin a selector");
  });

  await test("failing assert fails the case and stops later steps", async () => {
    const page = makeFakePage();
    const r = await runWebSteps(page, [
      { kind: "assert", assert: { textVisible: ["Dashboard"] } },
      { kind: "tap", instruction: "tap login" },
    ], { resolveAction: resolveLogin });
    assert.strictEqual(r.status, "fail");
    assert.strictEqual(r.steps.length, 1);
    assert.strictEqual(page.clicks.length, 0);
  });

  await test("unresolvable instruction fails; optional unresolvable is skipped", async () => {
    const decline = async () => ({ resolved: false, reason: "no confident match" });
    const page = makeFakePage();
    const fail = await runWebSteps(page, [{ kind: "tap", instruction: "tap ghost" }], { resolveAction: decline });
    assert.strictEqual(fail.status, "fail");
    assert.match(fail.detail, /could not resolve: no confident match/);
    const opt = await runWebSteps(page, [
      { kind: "tap", instruction: "tap ghost", optional: true },
      { kind: "assert", assert: { textVisible: ["Home"] } },
    ], { resolveAction: decline });
    assert.strictEqual(opt.status, "pass");
    assert.strictEqual(opt.summary.skipped, 1);
  });

  await test("pinned resolvedSelector is used without calling the resolver", async () => {
    const page = makeFakePage();
    let called = 0;
    const r = await runWebSteps(page, [
      { kind: "tap", instruction: "tap login", resolvedSelector: { strategy: "css", value: "#login" } },
    ], { resolveAction: async () => { called++; return { resolved: false, reason: "x" }; } });
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(called, 0);
  });

  await test("tapIfExists skips when absent, taps when present; type fills with ${ENV} text", async () => {
    process.env.TESTOPS_WEB_TEST_PW = "s3cret";
    const page = makeFakePage({ elements: ["#login", "#pw"] });
    const r = await runWebSteps(page, [
      { kind: "tapIfExists", instruction: "close banner", selector: { strategy: "css", value: "#banner" } },
      { kind: "type", instruction: "pw", selector: { strategy: "css", value: "#pw" }, text: "${TESTOPS_WEB_TEST_PW}" },
    ], {});
    delete process.env.TESTOPS_WEB_TEST_PW;
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.steps[0].status, "skipped");
    assert.deepStrictEqual(page.fills, [["#pw", "s3cret"]]);
    assert.strictEqual(r.updatedSteps[1].text, "${TESTOPS_WEB_TEST_PW}", "placeholder must never be persisted as the secret");
  });

  await test("missing env var for a type step -> whole run fails cleanly (no throw)", async () => {
    delete process.env.TESTOPS_WEB_MISSING;
    const r = await runWebSteps(makeFakePage(), [
      { kind: "type", instruction: "pw", selector: { strategy: "css", value: "#pw" }, text: "${TESTOPS_WEB_MISSING}" },
    ], {});
    assert.strictEqual(r.status, "fail");
    assert.match(r.detail, /TESTOPS_WEB_MISSING/);
  });

  // ---- real Chromium smoke test (skipped when no browser is installed, e.g. CI) ----
  let chromium;
  try { chromium = require("playwright").chromium; } catch { /* not installed */ }
  let browser;
  if (chromium) { try { browser = await chromium.launch({ headless: true, executablePath: process.env.TESTOPS_WEB_CHROMIUM_PATH || undefined }); } catch { browser = null; } }
  if (!browser) {
    skipped++;
    console.log("  skip - real Chromium test (no browser available)");
  } else {
    await test("REAL Chromium: login-style flow passes; wrong expectation fails", async () => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        if (req.url === "/welcome") return res.end("<h1>Welcome back</h1>");
        res.end(`<input id="user" placeholder="user"><button id="go" onclick="location='/welcome'">Sign in</button>`);
      });
      await new Promise((r) => server.listen(0, r));
      const baseUrl = `http://localhost:${server.address().port}`;
      try {
        const steps = [
          { kind: "navigate", url: "/" },
          { kind: "type", instruction: "user", selector: { strategy: "css", value: "#user" }, text: "abc" },
          { kind: "tap", instruction: "sign in", selector: { strategy: "css", value: "#go" }, expect: { appeared: ["Welcome back"] } },
          { kind: "assert", assert: { urlContains: "/welcome", textVisible: ["Welcome back"] } },
        ];
        const ctx = await browser.newContext();
        const ok = await runWebSteps(await ctx.newPage(), steps, { baseUrl });
        assert.strictEqual(ok.status, "pass", ok.detail);

        const bad = JSON.parse(JSON.stringify(steps));
        bad[2].expect = { appeared: ["Goodbye"] };
        const ctx2 = await browser.newContext();
        const res = await runWebSteps(await ctx2.newPage(), bad, { baseUrl });
        assert.strictEqual(res.status, "fail");
      } finally { server.close(); await browser.close(); }
    });
  }

  console.log(`\nweb runner: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
