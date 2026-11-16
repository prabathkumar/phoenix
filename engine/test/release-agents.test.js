const assert = require("node:assert");
const { plan, triage, report, createAudit, runRelease } = require("../agents/release");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
(async () => {
  await test("planner narrows to changed areas, falls back to all and says so", () => {
    const a = createAudit(); const suite = { cases: [{ id: "1", title: "Postpaid plan" }, { id: "2", title: "Device cart", tags: ["checkout"] }] };
    assert.deepStrictEqual(plan(suite, { changed: ["checkout"] }, a).cases.map((c) => c.id), ["2"]);
    assert.strictEqual(plan(suite, { changed: ["zzz"] }, a).cases.length, 2);
    assert.ok(a.trail.some((e) => e.action === "no-match-run-all"));
  });
  await test("triage explains by rule; model only for the unexplained", async () => {
    const a = createAudit(); let asked = 0;
    const rs = [{ id: "a", verdict: "blocked-by-site", reason: "" }, { id: "b", verdict: "failed", reason: "'NEXT' is disabled: something it needs is not filled in" }, { id: "c", verdict: "failed", reason: "weird" }, { id: "d", verdict: "passed" }];
    await triage(rs, { ask: async () => { asked += 1; return "site bug"; } }, a);
    assert.ok(rs[0].triage && /next button/.test(rs[1].triage) && rs[2].triage === "site bug" && !rs[3].triage && asked === 1);
  });
  await test("reporter: FAIL / PASS-WITH-GAPS / PASS", () => {
    const a = createAudit(); const v = (rs) => report({ results: rs, total: rs.length }, a).verdict;
    assert.strictEqual(v([{ verdict: "passed" }]), "PASS");
    assert.strictEqual(v([{ verdict: "passed" }, { verdict: "blocked-by-site" }]), "PASS-WITH-GAPS");
    assert.strictEqual(v([{ verdict: "failed" }]), "FAIL");
  });
  await test("healer: a failure that passes on retry is flaky and stays visible; audit records it", async () => {
    const { runSuite } = require("../suite-run"); void runSuite;
    let calls = 0; const mod = require("../suite-run"); const orig = mod.runSuite;
    // fake the runner through require cache: release.js captured runSuite at load, so test heal() directly
    const { heal } = require("../agents/release");
    const summary = { results: [{ id: "x", verdict: "failed", reason: "boom", failedStep: "s" }] };
    const a = createAudit();
    const fakeSuite = { name: "t", url: "https://s.my", cases: [{ id: "x", steps: ["Check that the page says Hello"] }] };
    const page = () => ({ goto: async () => {}, screenshot: async () => Buffer.from("x"), url: () => "https://s.my/", evaluate: async () => [], innerText: async () => "Hello", content: async () => "Hello", locator: () => ({ innerText: async () => "Hello" }), title: async () => "t" });
    const browser = { newContext: async () => ({ newPage: async () => page(), close: async () => {} }), close: async () => {} };
    await heal(summary, fakeSuite, { launch: async () => { calls += 1; return browser; }, log: () => {}, runCase: async () => ({ status: "passed", steps: [{ status: "passed", text: "s" }] }) }, a);
    assert.strictEqual(calls, 1);
    assert.ok(summary.results[0].flaky && summary.results[0].firstAttempt.reason === "boom");
    assert.ok(a.trail.some((e) => e.agent === "healer" && e.action === "flaky-passed-on-retry"));
  });
  await test("runRelease end to end writes an ordered audit trail", async () => {
    const page = () => ({ goto: async () => {}, screenshot: async () => Buffer.from("x"), url: () => "https://s.my/", evaluate: async () => [], innerText: async () => "Hello", content: async () => "Hello", locator: () => ({ innerText: async () => "Hello" }), title: async () => "t" });
    const browser = { newContext: async () => ({ newPage: async () => page(), close: async () => {} }), close: async () => {} };
    const res = await runRelease({ name: "t", url: "https://s.my", cases: [{ id: "A", steps: ["Check that the page says Hello"] }] }, { perf: false, security: false, runOpts: { launch: async () => browser, log: () => {}, runCase: async () => ({ status: "passed", steps: [] }) } });
    assert.strictEqual(res.verdict, "PASS");
    assert.strictEqual(res.agents.performance.status, "skipped");
    assert.ok(Object.values(res.agents).every((a) => a.status !== "working" && a.status !== "waiting"), "every agent ends with a status");
    assert.deepStrictEqual(res.audit.map((e) => e.agent), ["planner", "runner", "reporter"]);
  });
  await test("every agent reports status; performance and security warnings make a pass PASS-WITH-GAPS", async () => {
    const page = () => ({ goto: async () => {}, evaluate: async () => ({ ttfbMs: 200, loadMs: 7000, firstContentfulPaintMs: 900, transferKb: 5 }) });
    const browser = { newContext: async () => ({ newPage: async () => page(), close: async () => {} }), close: async () => {} };
    const seen = [];
    const headers = new Map([["content-type", "text/html"]]);
    const fetchImpl = async () => ({ status: 200, url: "https://s.my/", headers: { get: (n) => headers.get(n) || null, getSetCookie: () => ["sid=1; Path=/"] } });
    const res = await runRelease({ name: "t", url: "https://s.my", cases: [{ id: "A", steps: ["x"] }] }, { onStatus: (id, a) => seen.push(`${id}:${a.status}`), checkDeps: { security: { fetchImpl } }, runOpts: { launch: async () => browser, log: () => {}, runCase: async () => ({ status: "passed", steps: [] }) } });
    assert.strictEqual(res.verdict, "PASS-WITH-GAPS");
    assert.ok(res.gaps.some((g) => /page load took 7000/.test(g.why)) && res.gaps.some((g) => /Content-Security-Policy/.test(g.why)) && res.gaps.some((g) => /cookie sid is missing Secure/.test(g.why)));
    for (const id of ["planner", "runner", "performance", "security", "triage", "healer", "reporter"]) assert.ok(seen.includes(`${id}:working`) || seen.includes(`${id}:done`), `${id} reported`);
    assert.ok(res.agents.reporter.message.startsWith("PASS-WITH-GAPS"));
  });
  await test("a check that cannot run is reported as failed for that agent, not hidden, and does not stop the release", async () => {
    const browser = { newContext: async () => ({ newPage: async () => ({ goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } }), close: async () => {} }), close: async () => {} };
    const res = await runRelease({ name: "t", url: "https://s.my", cases: [{ id: "A", steps: ["x"] }] }, { security: false, runOpts: { launch: async () => browser, log: () => {}, runCase: async () => ({ status: "passed", steps: [] }) } });
    assert.strictEqual(res.agents.performance.status, "failed"); assert.match(res.agents.performance.message, /ERR_NAME_NOT_RESOLVED/); assert.strictEqual(res.total, 1); assert.ok(res.agents.reporter.status === "done");
  });
  await test("a mobile suite runs through the mobile runner: one fresh session per case, app resolved once, sessions closed, web-only checks skipped", async () => {
    const { runMobileSuite } = require("../agents/mobile");
    let started = 0, closed = 0, resolved = 0;
    const startMobile = async (o) => { started += 1; assert.strictEqual(o.capabilityOverrides["appium:app"], "bs://abc"); return { deleteSession: async () => { closed += 1; } }; };
    const resolveApp = async () => { resolved += 1; return { "appium:app": "bs://abc" }; };
    const suite = { name: "MyYes", platform: "android", app: { file: "myyes.apk" }, cases: [{ id: "M1", steps: ["a"] }, { id: "M2", steps: ["b"] }] };
    const runCase = async (c) => (c.id === "M1" ? { status: "passed", steps: [{ status: "passed", text: "a" }] } : { status: "failed", steps: [{ status: "failed", text: "b", reason: "no_match: Tap Login" }] });
    const res = await runRelease(suite, { heal: false, runOpts: { startMobile, resolveApp, appFile: "/x/myyes.apk", runCase, log: () => {}, runSuiteImpl: (su, o) => runMobileSuite(su, o) } });
    assert.strictEqual(started, 2); assert.strictEqual(closed, 2); assert.strictEqual(resolved, 1);
    assert.strictEqual(res.passed, 1); assert.strictEqual(res.failed, 1); assert.strictEqual(res.verdict, "FAIL");
    assert.strictEqual(res.agents.performance.status, "skipped"); assert.match(res.agents.performance.message, /web only/); assert.match(res.agents.security.message, /web only/);
    const none = await runMobileSuite({ name: "x", platform: "ios", cases: [{ id: "A", steps: ["x"] }] }, { log: () => {} });
    assert.strictEqual(none.failed, 1); assert.match(none.results[0].reason, /names no app/);
  });
  if (failed) process.exit(1); console.log("release-agents tests passed");
})();
