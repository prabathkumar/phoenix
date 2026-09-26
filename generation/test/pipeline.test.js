/**
 * Tests for the Stage 2 generation pipeline, run against a small
 * synthetic-but-realistic recorded session (a login flow: tap username
 * field + type, tap password field + type, tap login button, "Welcome"
 * appears) rather than a live device.
 *
 * Run with: npm test (from generation/) or `node test/pipeline.test.js`
 */

const assert = require("assert");
const {
  generateScript,
  inferTestName,
  inferAssertions,
  extractParameters,
  buildSelector,
} = require("../pipeline");

const LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Login" bounds="[42,166][305,237]" />
    <android.widget.EditText resource-id="com.phoenix.demo:id/username_input" text="" bounds="[100,300][980,400]" />
    <android.widget.EditText resource-id="com.phoenix.demo:id/password_input" text="" bounds="[100,420][980,520]" />
    <android.widget.Button resource-id="com.phoenix.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;

const AFTER_LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView resource-id="com.phoenix.demo:id/welcome_text" text="Welcome" bounds="[42,166][305,237]" />
  </android.widget.FrameLayout>
</hierarchy>`;

// A recorded 3-step session: type username, type password, tap login.
const STEPS = [
  {
    tapCoordinate: { x: 540, y: 350 },
    resolvedElement: { strategy: "resource-id", value: "com.phoenix.demo:id/username_input", resourceId: "com.phoenix.demo:id/username_input" },
    pageSourceBefore: LOGIN_SCREEN,
    pageSourceAfter: LOGIN_SCREEN,
    typedValue: "prabath@example.com",
  },
  {
    tapCoordinate: { x: 540, y: 470 },
    resolvedElement: { strategy: "resource-id", value: "com.phoenix.demo:id/password_input", resourceId: "com.phoenix.demo:id/password_input" },
    pageSourceBefore: LOGIN_SCREEN,
    pageSourceAfter: LOGIN_SCREEN,
    typedValue: "hunter2",
  },
  {
    tapCoordinate: { x: 540, y: 610 },
    resolvedElement: { strategy: "resource-id", value: "com.phoenix.demo:id/login_button", resourceId: "com.phoenix.demo:id/login_button" },
    pageSourceBefore: LOGIN_SCREEN,
    pageSourceAfter: AFTER_LOGIN_SCREEN,
  },
];

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("generation/pipeline:");

test("inferTestName derives a snake_case name from the first screen's title", () => {
  assert.strictEqual(inferTestName(STEPS), "login");
});

test("inferTestName falls back when there are no steps or no labels", () => {
  assert.strictEqual(inferTestName([]), "untitled_recorded_flow");
});

test("inferAssertions proposes an assertion for the label that appears after the login tap", () => {
  const assertions = inferAssertions(STEPS);
  assert.strictEqual(assertions.length, 1);
  assert.strictEqual(assertions[0].stepIndex, 2);
  assert.strictEqual(assertions[0].label, "Welcome");
  assert.strictEqual(assertions[0].resourceId, "com.phoenix.demo:id/welcome_text");
});

test("extractParameters names parameters from the field's resource-id, stripped of _input", () => {
  const parameters = extractParameters(STEPS);
  assert.strictEqual(parameters.length, 2);
  assert.strictEqual(parameters[0].name, "username");
  assert.strictEqual(parameters[0].value, "prabath@example.com");
  assert.strictEqual(parameters[1].name, "password");
  assert.strictEqual(parameters[1].value, "hunter2");
});

test("buildSelector maps each locator strategy to a WebdriverIO selector", () => {
  assert.strictEqual(
    buildSelector({ strategy: "resource-id", value: "android:id/text1" }),
    'android=new UiSelector().resourceId("android:id/text1")'
  );
  assert.strictEqual(buildSelector({ strategy: "accessibility-id", value: "Login" }), "~Login");
  assert.strictEqual(buildSelector({ strategy: "xpath", value: "/hierarchy[1]/a[1]" }), "/hierarchy[1]/a[1]");
  assert.strictEqual(buildSelector({ strategy: "coordinate", value: "1,2" }), null);
});

testAsync("generateScript produces a runnable script with parameters, selectors, and the inferred assertion", async () => {
  const result = await generateScript(STEPS);
  assert.strictEqual(result.testName, "login");
  assert.strictEqual(result.assertions.length, 1);
  assert.strictEqual(result.parameters.length, 2);

  const src = result.scriptSource;
  assert.ok(src.includes('const username = "prabath@example.com";'));
  assert.ok(src.includes('const password = "hunter2";'));
  assert.ok(src.includes('describe("login"'));
  assert.ok(src.includes("UiSelector().resourceId(\\\"com.phoenix.demo:id/login_button\\\")"));
  assert.ok(src.includes('await expect($('));
  assert.ok(src.includes('"Welcome" appeared'));
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/pipeline tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/pipeline tests passed");
  }
});
