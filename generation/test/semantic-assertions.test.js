/**
 * Tests for generation/semantic-assertions.js -- closes spec §6's
 * "state-diff reporting... feeds the assertion-inference step directly"
 * bullet. Exercised against plain SemanticDiff-shaped objects rather
 * than running semantic-diff.js itself, since the point here is
 * inferSemanticAssertions()'s own logic (which appeared elements become
 * assertions, dedup, stepIndex tagging), not diffing.
 *
 * Run with: npm test (from generation/) or `node test/semantic-assertions.test.js`
 */

const assert = require("assert");
const { inferSemanticAssertions } = require("../semantic-assertions");

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("generation/semantic-assertions:");

test("returns [] when nothing changed", () => {
  assert.deepStrictEqual(inferSemanticAssertions({ changed: false, appeared: [], disappeared: [] }), []);
});

test("returns [] when changed but nothing appeared (only disappeared)", () => {
  const diff = { changed: true, appeared: [], disappeared: [{ label: "Log In" }] };
  assert.deepStrictEqual(inferSemanticAssertions(diff), []);
});

test("returns [] for a null/undefined diff rather than throwing", () => {
  assert.deepStrictEqual(inferSemanticAssertions(null), []);
  assert.deepStrictEqual(inferSemanticAssertions(undefined), []);
});

test("turns each appeared element into a {label, resourceId} assertion", () => {
  const diff = {
    changed: true,
    disappeared: [],
    appeared: [
      { label: "Welcome", resourceId: "com.testopsmobile.demo:id/welcome_text" },
      { label: "Settings" },
    ],
  };
  assert.deepStrictEqual(inferSemanticAssertions(diff), [
    { label: "Welcome", resourceId: "com.testopsmobile.demo:id/welcome_text" },
    { label: "Settings", resourceId: undefined },
  ]);
});

test("falls back to accessibilityId when an appeared element has no label", () => {
  const diff = { changed: true, disappeared: [], appeared: [{ accessibilityId: "loginButton" }] };
  assert.deepStrictEqual(inferSemanticAssertions(diff), [{ label: "loginButton", resourceId: undefined }]);
});

test("skips an appeared element with neither a label nor an accessibilityId", () => {
  const diff = { changed: true, disappeared: [], appeared: [{ resourceId: "some_id" }, { label: "Welcome" }] };
  assert.deepStrictEqual(inferSemanticAssertions(diff), [{ label: "Welcome", resourceId: undefined }]);
});

test("dedups repeated labels within the same diff, keeping the first", () => {
  const diff = {
    changed: true,
    disappeared: [],
    appeared: [
      { label: "Screen Time", resourceId: "outer_button" },
      { label: "Screen Time", resourceId: "inner_text" }, // nested child, same visible text
    ],
  };
  const assertions = inferSemanticAssertions(diff);
  assert.strictEqual(assertions.length, 1);
  assert.strictEqual(assertions[0].resourceId, "outer_button");
});

test("attaches stepIndex to every assertion when given", () => {
  const diff = { changed: true, disappeared: [], appeared: [{ label: "Welcome" }] };
  const assertions = inferSemanticAssertions(diff, { stepIndex: 2 });
  assert.strictEqual(assertions[0].stepIndex, 2);
});

test("omits stepIndex when not given", () => {
  const diff = { changed: true, disappeared: [], appeared: [{ label: "Welcome" }] };
  const assertions = inferSemanticAssertions(diff);
  assert.ok(!("stepIndex" in assertions[0]));
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/semantic-assertions tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-assertions tests passed");
  }
});
