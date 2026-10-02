/**
 * Tests for generation/outcome-verification.js -- the deterministic,
 * non-LLM check that closes docs/STATUS.md bugs #16/#18's class of
 * false success: a step whose action reports "success" (no WebDriver
 * error) while having actually hit the wrong element.
 *
 * Run with: npm test (from generation/) or `node test/outcome-verification.test.js`
 */

const assert = require("assert");
const { verifyExpectedOutcome, validateExpectShape } = require("../outcome-verification");

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

test("verifyExpectedOutcome always passes when no expect is declared (unaffected, backward-compatible)", () => {
  assert.deepStrictEqual(verifyExpectedOutcome({ appeared: [], disappeared: [] }, undefined), { ok: true });
  assert.deepStrictEqual(verifyExpectedOutcome(undefined, undefined), { ok: true });
});

test("verifyExpectedOutcome passes when every declared appeared/disappeared substring matches a real element", () => {
  const diff = { appeared: [{ label: "Profile" }], disappeared: [{ label: "Login" }] };
  const result = verifyExpectedOutcome(diff, { appeared: ["Profile"], disappeared: ["Login"] });
  assert.deepStrictEqual(result, { ok: true });
});

test("verifyExpectedOutcome matches case-insensitively and as a substring", () => {
  const diff = { appeared: [{ label: "Welcome, Prabath!" }], disappeared: [] };
  assert.strictEqual(verifyExpectedOutcome(diff, { appeared: ["welcome"] }).ok, true);
});

test("verifyExpectedOutcome falls back to accessibilityId when an element has no label", () => {
  const diff = { appeared: [{ accessibilityId: "Right Icon" }], disappeared: [] };
  assert.strictEqual(verifyExpectedOutcome(diff, { appeared: ["right icon"] }).ok, true);
});

test("verifyExpectedOutcome FAILS when a declared appeared element never shows up (the core false-success fix)", () => {
  const diff = { appeared: [{ label: "Add-On Details" }], disappeared: [] };
  const result = verifyExpectedOutcome(diff, { appeared: ["Profile"] });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("Profile"));
  assert.ok(result.reason.includes("Add-On Details"), "the failure reason should say what actually happened, not just what was missing");
});

test("verifyExpectedOutcome FAILS when a declared disappeared element is still present", () => {
  const diff = { appeared: [], disappeared: [] }; // Login never disappeared
  const result = verifyExpectedOutcome(diff, { disappeared: ["Login"] });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("expected to disappear but didn't"));
});

test("verifyExpectedOutcome reports every missing item, not just the first", () => {
  const diff = { appeared: [], disappeared: [] };
  const result = verifyExpectedOutcome(diff, { appeared: ["A", "B"], disappeared: ["C"] });
  assert.ok(result.reason.includes("A"));
  assert.ok(result.reason.includes("B"));
  assert.ok(result.reason.includes("C"));
});

test("verifyExpectedOutcome FAILS with a clear reason when expect is declared but no diff was captured", () => {
  const result = verifyExpectedOutcome(undefined, { appeared: ["Profile"] });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("no screen diff was captured"));
});

test("validateExpectShape accepts undefined (no expect declared)", () => {
  assert.strictEqual(validateExpectShape(undefined), undefined);
});

test("validateExpectShape accepts a well-formed expect with appeared and/or disappeared", () => {
  assert.strictEqual(validateExpectShape({ appeared: ["A"] }), undefined);
  assert.strictEqual(validateExpectShape({ disappeared: ["B"] }), undefined);
  assert.strictEqual(validateExpectShape({ appeared: ["A"], disappeared: ["B"] }), undefined);
});

test("validateExpectShape rejects a non-object expect", () => {
  assert.ok(validateExpectShape("Profile"));
  assert.ok(validateExpectShape(123));
  assert.ok(validateExpectShape(["Profile"]));
});

test("validateExpectShape rejects an empty {} (would always pass trivially -- almost certainly a forgotten value)", () => {
  assert.ok(validateExpectShape({}));
});

test("validateExpectShape rejects an empty or non-string array for appeared/disappeared", () => {
  assert.ok(validateExpectShape({ appeared: [] }));
  assert.ok(validateExpectShape({ appeared: [123] }));
  assert.ok(validateExpectShape({ appeared: [""] }));
  assert.ok(validateExpectShape({ disappeared: [null] }));
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/outcome-verification tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/outcome-verification tests passed");
  }
});
