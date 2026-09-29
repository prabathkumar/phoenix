const assert = require("assert");
const { splitBatchCounts, summarizeBatchResults } = require("../run-batch-executions");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failed += 1;
  }
}

test("splitBatchCounts splits 100 into even thirds, remainder to guided", () => {
  const counts = splitBatchCounts(100);
  assert.strictEqual(counts.semantic, 33);
  assert.strictEqual(counts.loop, 33);
  assert.strictEqual(counts.guided, 34);
  assert.strictEqual(counts.guided + counts.semantic + counts.loop, 100);
});

test("splitBatchCounts divides evenly when total is a multiple of 3", () => {
  const counts = splitBatchCounts(99);
  assert.deepStrictEqual(counts, { guided: 33, semantic: 33, loop: 33 });
});

test("splitBatchCounts handles zero total", () => {
  assert.deepStrictEqual(splitBatchCounts(0), { guided: 0, semantic: 0, loop: 0 });
});

test("splitBatchCounts handles negative total", () => {
  assert.deepStrictEqual(splitBatchCounts(-5), { guided: 0, semantic: 0, loop: 0 });
});

test("splitBatchCounts respects custom ratios", () => {
  const counts = splitBatchCounts(10, { guided: 8, semantic: 1, loop: 1 });
  assert.strictEqual(counts.semantic, 1);
  assert.strictEqual(counts.loop, 1);
  assert.strictEqual(counts.guided, 8);
});

test("splitBatchCounts never loses items to rounding", () => {
  for (const total of [1, 2, 4, 5, 7, 10, 50, 100, 137]) {
    const counts = splitBatchCounts(total);
    assert.strictEqual(counts.guided + counts.semantic + counts.loop, total, `total mismatch for ${total}`);
  }
});

test("summarizeBatchResults computes totals and per-mode stats", () => {
  const results = [
    { mode: "guided", success: true, durationMs: 100 },
    { mode: "guided", success: false, durationMs: 200 },
    { mode: "semantic", success: true, durationMs: 300 },
  ];
  const summary = summarizeBatchResults(results);
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.succeeded, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.byMode.guided.total, 2);
  assert.strictEqual(summary.byMode.guided.succeeded, 1);
  assert.strictEqual(summary.byMode.guided.failed, 1);
  assert.strictEqual(summary.byMode.guided.successRate, 0.5);
  assert.strictEqual(summary.byMode.guided.avgDurationMs, 150);
  assert.strictEqual(summary.byMode.semantic.successRate, 1);
});

test("summarizeBatchResults handles empty results", () => {
  const summary = summarizeBatchResults([]);
  assert.strictEqual(summary.total, 0);
  assert.strictEqual(summary.succeeded, 0);
  assert.strictEqual(summary.failed, 0);
  assert.deepStrictEqual(summary.byMode, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
