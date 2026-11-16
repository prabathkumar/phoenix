const assert = require("node:assert");
const { parseCheck, runCheck } = require("../core/check-step");
const { runGoalLoop } = require("../core/goal-loop");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
const surf = (lines, url = "https://store.yes.my/iphone-18-pro/cart") => ({ lines: async () => lines, url: () => url });
(async () => {
  await test("parses the check phrasings and leaves normal steps alone", () => {
    assert.deepStrictEqual(parseCheck("Check that no error is showing"), { kind: "no-error" });
    assert.deepStrictEqual(parseCheck("Verify there is no error message"), { kind: "no-error" });
    assert.deepStrictEqual(parseCheck('Check that the page says "Order summary".'), { kind: "text", value: "Order summary" });
    assert.deepStrictEqual(parseCheck("Check the URL contains /cart"), { kind: "url", value: "/cart" });
    assert.strictEqual(parseCheck("Click Next"), null);
    assert.strictEqual(parseCheck("Select the error report option"), null);
  });
  await test("no-error passes on a clean page and fails with the page's own words", async () => {
    assert.ok((await runCheck(surf(["APPLE - iPhone 18 Pro", "In Stock", "NEXT"]), "Check that no error is showing", { settleMs: 1, tries: 2 })).success);
    const r = await runCheck(surf(["Something went wrong", "NEXT"]), "Check that no error is showing", { settleMs: 1, tries: 2 });
    assert.ok(!r.success && /Something went wrong/.test(r.reason));
    const s = await runCheck(surf(["Sold out online. Visit your nearest Yes Store."]), "Check that no error is showing", { settleMs: 1, tries: 1 });
    assert.ok(!s.success, "a stop message counts as not-clean");
  });
  await test("text and url checks wait briefly for a slow page, then fail clearly", async () => {
    let n = 0; const slow = { lines: async () => (++n < 2 ? ["Loading"] : ["Order summary", "RM 0"]), url: () => "https://store.yes.my/x/cart" };
    assert.ok((await runCheck(slow, 'Check that the page says "order summary"', { settleMs: 1, tries: 3 })).success);
    const miss = await runCheck(surf(["Hello"]), "Check that the page says Order summary", { settleMs: 1, tries: 2 });
    assert.ok(!miss.success && /does not show/.test(miss.reason));
    assert.ok((await runCheck(surf([]), "Check the URL contains /CART", { settleMs: 1 })).success);
    assert.ok(!(await runCheck(surf([], "https://www.yes.my/"), "Check the URL contains /cart", { settleMs: 1, tries: 1 })).success);
  });
  await test("the goal loop runs a check without asking the model or touching the page", async () => {
    let asked = 0, acted = 0; const s = { ...surf(["All good"]), platform: "web", snapshot: async () => [], screenshot: async () => Buffer.from("x"), perform: async () => { acted += 1; }, selectorFor: async () => "" };
    const r = await runGoalLoop(s, "Check that no error is showing", { blockedWaitMs: 1, callModel: async () => { asked += 1; return { action: "none" }; } });
    assert.ok(r.success && asked === 0 && acted === 0, JSON.stringify(r));
  });
  if (failed) process.exit(1); console.log("check-step tests passed");
})();
