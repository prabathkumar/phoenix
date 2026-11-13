const assert = require("node:assert");
const { classify, runSuite } = require("../suite-run");
let failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n    ${e.stack}`); } }

(async () => {
  await test("classify: passed / blocked-by-site / failed are kept apart", () => {
    assert.strictEqual(classify({ status: "passed", steps: [] }), "passed");
    assert.strictEqual(classify({ status: "failed", steps: [{ status: "failed", reason: 'no match - the page is showing: "Stock Temporarily Reserved"' }] }), "blocked-by-site");
    assert.strictEqual(classify({ status: "failed", steps: [{ status: "failed", reason: '"NEXT" is disabled' }] }), "failed");
    assert.strictEqual(classify({ status: "failed", steps: [{ status: "failed", reason: 'x - the page is showing: "Invalid input"' }] }), "failed");
    assert.strictEqual(classify({ status: "failed", steps: [{ status: "failed", text: "(start)", reason: "page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.yes.my/" }] }), "not-run-network");
  });

  await test("runSuite runs each case in a fresh context, counts verdicts, honours the case filter", async () => {
    const contexts = [];
    const fakePage = () => ({ goto: async () => {}, screenshot: async () => Buffer.from("x"), url: () => "https://s.my/", evaluate: async () => [], title: async () => "t" });
    const browser = { newContext: async () => { const c = { closed: false, newPage: async () => fakePage(), close: async () => { c.closed = true; } }; contexts.push(c); return c; }, close: async () => {} };
    const suite = { name: "t", url: "https://s.my", cases: [{ id: "A", steps: [] }, { id: "B", steps: [] }, { id: "C", steps: [] }] };
    const s = await runSuite(suite, { launch: async () => browser, only: ["A", "C"], log: () => {} });
    assert.strictEqual(s.total, 2);
    assert.strictEqual(contexts.length, 2);
    assert.ok(contexts.every((c) => c.closed));
    assert.strictEqual(s.passed + s.failed + s.blockedBySite + s.notRunNetwork, 2);
  });

  if (failed) process.exit(1);
  console.log("suite-run tests passed");
})();
