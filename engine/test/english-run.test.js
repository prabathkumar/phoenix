const assert = require("assert");
const { parseSteps, placeholdersIn, applyTestData, redact, maskedData, isSecretName } = require("../core/english");
const { runEnglish, mobileRunner } = require("../english-run");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack}`); } }

(async () => {
  await test("parseSteps: one step per line, bullets/numbers stripped, comments and blanks dropped", () => {
    assert.deepStrictEqual(parseSteps("1. Open login\n\n- Tap Sign in\n# note\n  Enter ${A}  "), ["Open login", "Tap Sign in", "Enter ${A}"]);
  });
  await test("placeholders are listed once, in order; applyTestData fills them", () => {
    assert.deepStrictEqual(placeholdersIn(["x ${B} ${A}", "${B}"]), ["B", "A"]);
    assert.deepStrictEqual(applyTestData("Enter ${PHONE}", { PHONE: "0116" }), { text: "Enter 0116" });
  });
  await test("a missing or empty test-data value is reported, never filled with nothing", () => {
    assert.deepStrictEqual(applyTestData("Enter ${PHONE} ${PASSWORD}", { PHONE: "1", PASSWORD: "" }), { missing: ["PASSWORD"] });
  });
  await test("secret names are recognised; redact hides only secret values, longest first", () => {
    assert.ok(isSecretName("LOGIN_PASSWORD") && isSecretName("otp") && !isSecretName("LOGIN_PHONE"));
    const data = { LOGIN_PHONE: "0116611", LOGIN_PASSWORD: "@Ytlc1234", PIN: "@Ytlc" };
    assert.strictEqual(redact("typed @Ytlc1234 for 0116611", data), "typed ${LOGIN_PASSWORD} for 0116611");
    assert.deepStrictEqual(maskedData(data), { LOGIN_PHONE: "0116611", LOGIN_PASSWORD: "••••••", PIN: "••••••" });
  });

  const fake = (script) => ({
    calls: [],
    async goal(text, { onProgress }) {
      this.calls.push(text);
      onProgress({ message: `working on ${text}` });
      return script(text);
    },
    async screenshot() { return { base64: "AAAA", mime: "image/png" }; },
  });

  await test("runs each line as a goal with test data filled in, and the events show the English, not the secret", async () => {
    const r = fake(() => ({ success: true, actions: [{ label: "tap Login" }] }));
    const events = [];
    const out = await runEnglish({
      steps: "Enter ${LOGIN_PHONE} as phone\nEnter ${LOGIN_PASSWORD} as password",
      testData: { LOGIN_PHONE: "0116611", LOGIN_PASSWORD: "@Ytlc1234" },
      runner: r, onEvent: (e) => events.push(e),
    });
    assert.strictEqual(out.status, "passed");
    assert.deepStrictEqual(r.calls, ["Enter 0116611 as phone", "Enter @Ytlc1234 as password"]);
    const wire = JSON.stringify(events);
    assert.ok(!wire.includes("@Ytlc1234"), "secret must not be emitted");
    assert.ok(wire.includes("${LOGIN_PASSWORD}"));
    assert.ok(events.find((e) => e.type === "step-finished" && e.screenshot === "AAAA"));
  });
  await test("stops at the first failed step, marks the rest skipped, and redacts the failure reason", async () => {
    const r = fake((t) => (t.includes("two") ? { success: false, reason: "no field for @Ytlc1234", actions: [] } : { success: true, actions: [] }));
    const out = await runEnglish({ steps: "one\ntwo @Ytlc1234\nthree", testData: { PASSWORD: "@Ytlc1234" }, runner: r });
    assert.deepStrictEqual(out.steps.map((s) => s.status), ["passed", "failed", "skipped"]);
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.steps[1].reason, "no field for ${PASSWORD}");
    assert.strictEqual(r.calls.length, 2);
  });
  await test("missing test data stops the run before anything is attempted", async () => {
    const r = fake(() => ({ success: true }));
    const out = await runEnglish({ steps: "Enter ${PHONE}", testData: {}, runner: r });
    assert.strictEqual(out.status, "failed");
    assert.match(out.reason, /\$\{PHONE\}/);
    assert.strictEqual(r.calls.length, 0);
  });
  await test("an empty test case is refused with a clear message", async () => {
    const out = await runEnglish({ steps: "  \n# only a comment", runner: fake(() => ({ success: true })) });
    assert.strictEqual(out.status, "failed");
    assert.match(out.reason, /at least one step/);
  });
  await test("a runner that throws fails that step instead of crashing the run", async () => {
    const out = await runEnglish({ steps: "boom", runner: { goal: async () => { throw new Error("device lost"); }, screenshot: async () => null } });
    assert.strictEqual(out.steps[0].status, "failed");
    assert.strictEqual(out.steps[0].reason, "device lost");
  });
  await test("mobileRunner maps the autonomous loop's stop reasons to pass/fail", async () => {
    const mk = (res) => mobileRunner({ takeScreenshot: async () => "PNG" }, "android", { runAutonomousLoop: async (d, goal, o) => { assert.strictEqual(o.platform, "android"); return res; } });
    const ok = await mk({ stoppedBecause: "goal-achieved", steps: [{ instruction: "tap Login" }] }).goal("g", {});
    assert.deepStrictEqual([ok.success, ok.actions[0].label], [true, "tap Login"]);
    const bad = await mk({ stoppedBecause: "action-failed", reason: "stuck", steps: [] }).goal("g", {});
    assert.deepStrictEqual([bad.success, bad.reason], [false, "action-failed: stuck"]);
    assert.deepStrictEqual(await mk({ steps: [] }).screenshot(), { base64: "PNG", mime: "image/png" });
  });

  if (failed) process.exit(1);
  console.log("engine/english-run tests passed");
})();
