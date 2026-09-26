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
  buildResourceIdSelector,
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

test("inferAssertions still flags a newly-appeared element whose text coincidentally repeats from the previous screen", () => {
  // Regression test for a real bug found on a live device: ApiDemos'
  // home screen has an "Animation" category, and its Views submenu
  // separately has an unrelated "Animation" row at a different screen
  // position. Diffing by text alone missed this — "Animation" existed
  // in both before and after, so nothing looked new even though a real,
  // different element had appeared. Diffing by (resourceId, text,
  // bounds) fixes it.
  const HOME_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Animation" content-desc="Animation" resource-id="android:id/text1" bounds="[0,533][1080,659]" />
    <android.widget.TextView text="Views" content-desc="Views" resource-id="android:id/text1" bounds="[0,1694][1080,1820]" />
  </android.widget.FrameLayout>
</hierarchy>`;

  const VIEWS_SUBMENU = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Animation" content-desc="Animation" resource-id="android:id/text1" bounds="[0,275][1080,401]" />
    <android.widget.TextView text="Buttons" content-desc="Buttons" resource-id="android:id/text1" bounds="[0,404][1080,530]" />
  </android.widget.FrameLayout>
</hierarchy>`;

  const step = {
    tapCoordinate: { x: 540, y: 1757 },
    resolvedElement: { strategy: "resource-id", value: "android:id/text1", resourceId: "android:id/text1", text: "Views" },
    pageSourceBefore: HOME_SCREEN,
    pageSourceAfter: VIEWS_SUBMENU,
  };

  const assertions = inferAssertions([step]);
  const labels = assertions.map((a) => a.label).sort();
  assert.deepStrictEqual(labels, ["Animation", "Buttons"]);
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
  assert.strictEqual(buildSelector({ strategy: "accessibility-id", value: "Login" }), "~Login");
  assert.strictEqual(buildSelector({ strategy: "xpath", value: "/hierarchy[1]/a[1]" }), "/hierarchy[1]/a[1]");
  assert.strictEqual(buildSelector({ strategy: "coordinate", value: "1,2" }), null);
});

test("buildSelector combines resource-id with text for a resource-id match that also has text", () => {
  // Regression test: a real device run against ApiDemos hit this exact
  // case — every row in a ListView shares "android:id/text1" as its
  // resource-id, so resource-id alone can't tell "Custom View" from any
  // other row. Combining it with the row's own text is what disambiguates.
  const selector = buildSelector({
    strategy: "resource-id",
    value: "android:id/text1",
    text: "Custom View",
  });
  assert.strictEqual(selector, 'android=new UiSelector().resourceId("android:id/text1").text("Custom View")');
});

test("buildSelector falls back to resource-id alone when no text is available", () => {
  const selector = buildSelector({ strategy: "resource-id", value: "com.phoenix.demo:id/login_button" });
  assert.strictEqual(selector, 'android=new UiSelector().resourceId("com.phoenix.demo:id/login_button")');
});

test("buildResourceIdSelector combines resource-id and label, and falls back gracefully", () => {
  assert.strictEqual(
    buildResourceIdSelector("android:id/text1", "Graphics"),
    'android=new UiSelector().resourceId("android:id/text1").text("Graphics")'
  );
  assert.strictEqual(buildResourceIdSelector("android:id/text1", undefined), 'android=new UiSelector().resourceId("android:id/text1")');
  assert.strictEqual(buildResourceIdSelector(undefined, "Graphics"), 'android=new UiSelector().text("Graphics")');
  assert.strictEqual(buildResourceIdSelector(undefined, undefined), null);
});

test("buildSelector and buildResourceIdSelector emit iOS predicate strings, not Android UiSelectors, when platform is ios", () => {
  const textSelector = buildSelector({ strategy: "text", value: "Log In" }, "ios");
  assert.strictEqual(textSelector, '-ios predicate string:label == "Log In" OR value == "Log In"');

  // iOS never sets resourceId (see capture/recorder.js) — resource-id
  // strategy elements from an iOS session carry only a label/value, so
  // this exercises the same iOS branch buildSelector's "text" case does.
  const assertSelector = buildResourceIdSelector(undefined, "Welcome", "ios");
  assert.strictEqual(assertSelector, '-ios predicate string:label == "Welcome" OR value == "Welcome"');

  // accessibility-id (`~value`) is cross-platform and doesn't change.
  assert.strictEqual(buildSelector({ strategy: "accessibility-id", value: "loginButton" }, "ios"), "~loginButton");
});

testAsync("generateScript emits mobile: tap (not mobile: clickGesture) and iOS-style selectors when platform is ios", async () => {
  const iosSteps = [
    {
      pageSourceBefore: '<XCUIElementTypeApplication name="App"><XCUIElementTypeButton name="loginButton" label="Log In" x="10" y="10" width="50" height="20" /></XCUIElementTypeApplication>',
      pageSourceAfter: '<XCUIElementTypeApplication name="App"><XCUIElementTypeStaticText label="Welcome" value="Welcome" x="10" y="10" width="50" height="20" /></XCUIElementTypeApplication>',
      resolvedElement: { strategy: "accessibility-id", value: "loginButton" },
      tapCoordinate: { x: 20, y: 15 },
    },
  ];
  const result = await generateScript(iosSteps, { platform: "ios" });
  assert.ok(result.scriptSource.includes("~loginButton"));
  assert.ok(!result.scriptSource.includes("mobile: clickGesture"));
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
