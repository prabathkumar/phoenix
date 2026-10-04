/**
 * Tests for the Phase 2 state-diff reporter (generation/semantic-diff.js)
 * -- the third and last building block named in docs/TESTOPS_MOBILE_SPEC.md §6's
 * Phase 2 bullets, after semantic-snapshot.js and semantic-act.js.
 *
 * Run with: npm test (from generation/) or `node test/semantic-diff.test.js`
 */

const assert = require("assert");
const { diffSnapshots, diffToText, elementKey } = require("../semantic-diff");

const LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Login" bounds="[42,166][305,237]" />
    <android.widget.EditText resource-id="com.testopsmobile.demo:id/username_input" text="" bounds="[100,300][980,400]" />
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;

const AFTER_LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView resource-id="com.testopsmobile.demo:id/welcome_text" text="Welcome" bounds="[42,166][305,237]" />
  </android.widget.FrameLayout>
</hierarchy>`;

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

console.log("generation/semantic-diff:");

test("diffSnapshots reports the login screen's elements as disappeared and Welcome as appeared", () => {
  const diff = diffSnapshots(LOGIN_SCREEN, AFTER_LOGIN_SCREEN);

  assert.strictEqual(diff.changed, true);
  assert.strictEqual(diff.appeared.length, 1);
  assert.strictEqual(diff.appeared[0].label, "Welcome");
  assert.strictEqual(diff.appeared[0].resourceId, "com.testopsmobile.demo:id/welcome_text");

  assert.strictEqual(diff.disappeared.length, 3);
  const disappearedLabels = diff.disappeared.map((el) => el.label || el.resourceId).sort();
  assert.deepStrictEqual(disappearedLabels, ["Log In", "Login", "com.testopsmobile.demo:id/username_input"].sort());
});

test("diffSnapshots reports no changes when before and after are identical", () => {
  const diff = diffSnapshots(LOGIN_SCREEN, LOGIN_SCREEN);
  assert.strictEqual(diff.changed, false);
  assert.deepStrictEqual(diff.appeared, []);
  assert.deepStrictEqual(diff.disappeared, []);
});

test("diffSnapshots handles empty/missing input on either side without throwing", () => {
  const diffBothEmpty = diffSnapshots("", "");
  assert.strictEqual(diffBothEmpty.changed, false);

  const diffAppearedOnly = diffSnapshots("", LOGIN_SCREEN);
  assert.strictEqual(diffAppearedOnly.changed, true);
  assert.strictEqual(diffAppearedOnly.disappeared.length, 0);
  assert.strictEqual(diffAppearedOnly.appeared.length, 3);

  const diffDisappearedOnly = diffSnapshots(LOGIN_SCREEN, "");
  assert.strictEqual(diffDisappearedOnly.changed, true);
  assert.strictEqual(diffDisappearedOnly.appeared.length, 0);
  assert.strictEqual(diffDisappearedOnly.disappeared.length, 3);
});

test("elementKey disambiguates same-label elements at different depths/roles", () => {
  const a = { resourceId: undefined, accessibilityId: undefined, label: "Animation", role: "TextView", depth: 2 };
  const b = { resourceId: undefined, accessibilityId: undefined, label: "Animation", role: "TextView", depth: 4 };
  assert.notStrictEqual(elementKey(a), elementKey(b));
});

test("diffToText renders 'No visible change.' when nothing changed", () => {
  const diff = diffSnapshots(LOGIN_SCREEN, LOGIN_SCREEN);
  assert.strictEqual(diffToText(diff), "No visible change.");
});

test("diffToText renders appeared/disappeared labels in a short LLM-readable summary", () => {
  const diff = diffSnapshots(LOGIN_SCREEN, AFTER_LOGIN_SCREEN);
  const text = diffToText(diff);

  assert.ok(text.startsWith("Appeared: \"Welcome\"."));
  assert.ok(text.includes("Disappeared:"));
  assert.ok(text.includes("\"Login\""));
  assert.ok(text.includes("\"Log In\""));
  // The username field has no label, only a resource-id -- diffToText
  // must fall back to describing it by role rather than crashing on an
  // undefined label.
  assert.ok(text.includes("android.widget.EditText"));
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/semantic-diff tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-diff tests passed");
  }
});
