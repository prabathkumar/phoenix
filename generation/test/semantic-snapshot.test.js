/**
 * Tests for the Phase 2 grounded-snapshot module (see
 * generation/semantic-snapshot.js's header comment and
 * docs/PHOENIX_SPEC.md §6 for what this is building toward). Covers
 * both an Android UiAutomator2-style tree and an iOS XCUITest-style
 * tree, since buildGroundedSnapshot() reads the same attribute set
 * pipeline.js's extractLabels() does for both platforms.
 *
 * Run with: npm test (from generation/) or `node test/semantic-snapshot.test.js`
 */

const assert = require("assert");
const { buildGroundedSnapshot, snapshotToText, findByRef } = require("../semantic-snapshot");

const ANDROID_LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Login" bounds="[42,166][305,237]" />
    <android.widget.EditText resource-id="com.phoenix.demo:id/username_input" text="" bounds="[100,300][980,400]" />
    <android.widget.Button resource-id="com.phoenix.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;

// A zero-width space (​) standing in for a "rolled-up-empty" iOS
// accessibility label -- same real-world bug capture/recorder.js and
// pipeline.js's isBlank()/cleanLabel() were fixed for.
const IOS_SCREEN_WITH_BLANK_LABEL = `<XCUIElementTypeApplication name="MyApp">
  <XCUIElementTypeButton name="loginButton" label="Log In" />
  <XCUIElementTypeStaticText label="​" />
  <XCUIElementTypeOther />
</XCUIElementTypeApplication>`;

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

console.log("generation/semantic-snapshot:");

test("buildGroundedSnapshot returns [] for empty/missing input", () => {
  assert.deepStrictEqual(buildGroundedSnapshot(""), []);
  assert.deepStrictEqual(buildGroundedSnapshot(undefined), []);
});

test("buildGroundedSnapshot assigns sequential refs and skips the unlabeled structural container", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);

  // FrameLayout has no text/content-desc/resource-id of its own, so it
  // must not get its own entry -- only its three labeled/identified
  // children should appear.
  assert.strictEqual(elements.length, 3);
  assert.deepStrictEqual(elements.map((el) => el.ref), [1, 2, 3]);

  const [title, username, loginButton] = elements;
  assert.strictEqual(title.role, "android.widget.TextView");
  assert.strictEqual(title.label, "Login");
  assert.strictEqual(title.resourceId, undefined);

  assert.strictEqual(username.role, "android.widget.EditText");
  assert.strictEqual(username.resourceId, "com.phoenix.demo:id/username_input");
  // text="" is blank, so no label -- but resource-id alone is enough to
  // include the element.
  assert.strictEqual(username.label, undefined);

  assert.strictEqual(loginButton.role, "android.widget.Button");
  assert.strictEqual(loginButton.label, "Log In");
  assert.strictEqual(loginButton.resourceId, "com.phoenix.demo:id/login_button");
});

test("buildGroundedSnapshot treats a zero-width-space label as blank, same as pipeline.js's isBlank()", () => {
  const elements = buildGroundedSnapshot(IOS_SCREEN_WITH_BLANK_LABEL);

  // The root <XCUIElementTypeApplication name="MyApp"> carries a real
  // accessibility id via name=, the button has both a name and a label,
  // the StaticText's label is a zero-width space (must be excluded),
  // and the last <XCUIElementTypeOther /> has nothing at all.
  assert.strictEqual(elements.length, 2);

  const [app, button] = elements;
  assert.strictEqual(app.role, "XCUIElementTypeApplication");
  assert.strictEqual(app.accessibilityId, "MyApp");
  assert.strictEqual(app.label, undefined);

  assert.strictEqual(button.role, "XCUIElementTypeButton");
  assert.strictEqual(button.accessibilityId, "loginButton");
  assert.strictEqual(button.label, "Log In");
});

test("buildGroundedSnapshot records nesting depth for indentation", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  // hierarchy(0) > FrameLayout(1) > TextView/EditText/Button(2)
  elements.forEach((el) => assert.strictEqual(el.depth, 2));
});

test("snapshotToText renders a compact, indented, ref-prefixed line per element", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  const text = snapshotToText(elements);

  assert.strictEqual(
    text,
    [
      '    [1] android.widget.TextView "Login"',
      '    [2] android.widget.EditText (id: com.phoenix.demo:id/username_input)',
      '    [3] android.widget.Button "Log In" (id: com.phoenix.demo:id/login_button)',
    ].join("\n")
  );
});

test("snapshotToText omits the a11y suffix when it duplicates the label", () => {
  const elements = buildGroundedSnapshot(IOS_SCREEN_WITH_BLANK_LABEL);
  const text = snapshotToText(elements);

  // app: accessibilityId "MyApp", no label -> shown via id suffix only.
  assert.ok(text.includes('[1] XCUIElementTypeApplication (a11y: MyApp)'));
  // button: label "Log In" differs from accessibilityId "loginButton" -> both shown.
  assert.ok(text.includes('[2] XCUIElementTypeButton "Log In" (a11y: loginButton)'));
});

test("findByRef resolves a known ref and returns undefined for an unknown one", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  assert.strictEqual(findByRef(elements, 3).resourceId, "com.phoenix.demo:id/login_button");
  assert.strictEqual(findByRef(elements, 99), undefined);
  assert.strictEqual(findByRef([], 1), undefined);
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/semantic-snapshot tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-snapshot tests passed");
  }
});
