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
  inferVisualChangeFlags,
  extractParameters,
  buildSelector,
  buildResourceIdSelector,
  extractLabels,
  isBlank,
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

test("inferAssertions collapses repeated labels within one step to a single assertion", () => {
  // Regression test for noise observed on a real iOS recording: nested
  // accessibility nodes commonly expose the same text at multiple
  // bounds -- e.g. a button and its inner StaticText child both carry
  // "Screen Time" -- which the composite (resourceId, label, bounds)
  // key correctly treats as distinct elements, but which shouldn't
  // produce three near-identical toBeDisplayed() assertions for the
  // same visible words in one step's generated script.
  const BEFORE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy><android.widget.FrameLayout bounds="[0,0][1080,2400]" /></hierarchy>`;

  const AFTER = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.Button text="Screen Time" bounds="[0,100][1080,300]">
      <android.widget.TextView text="Screen Time" bounds="[24,120][400,180]" />
    </android.widget.Button>
    <android.widget.TextView text="App &amp; Website Activity" bounds="[0,320][1080,420]" />
  </android.widget.FrameLayout>
</hierarchy>`;

  const step = {
    tapCoordinate: { x: 540, y: 200 },
    resolvedElement: { strategy: "text", value: "Screen Time", text: "Screen Time" },
    pageSourceBefore: BEFORE,
    pageSourceAfter: AFTER,
  };

  const assertions = inferAssertions([step]);
  const labels = assertions.map((a) => a.label).sort();
  assert.deepStrictEqual(labels, ["App & Website Activity", "Screen Time"]);
});

test("inferAssertions does not re-flag a screen's elements when back navigation returns to it", () => {
  // Regression test for a real bug: screen A -> screen B -> back to A was
  // flooding assertions because the old diff only compared each step
  // against its own immediately-preceding screen, not everything seen so
  // far in the session. Revisiting A a second time made every one of A's
  // elements look "newly appeared" again, even though the user had simply
  // navigated back. The fix tracks a cumulative "seen" set across the
  // whole session so a revisit produces zero new assertions unless the
  // revisited screen genuinely shows something it didn't before.
  const SCREEN_A = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView resource-id="com.phoenix.demo:id/title_a" text="Screen A" bounds="[42,166][305,237]" />
    <android.widget.Button resource-id="com.phoenix.demo:id/go_to_b" text="Go to B" bounds="[100,300][980,400]" />
  </android.widget.FrameLayout>
</hierarchy>`;

  const SCREEN_B = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView resource-id="com.phoenix.demo:id/title_b" text="Screen B" bounds="[42,166][305,237]" />
    <android.widget.Button resource-id="com.phoenix.demo:id/back_button" text="Back" bounds="[100,300][980,400]" />
  </android.widget.FrameLayout>
</hierarchy>`;

  const backNavSteps = [
    // Step 0: on A, tap "Go to B" -> navigates to B.
    {
      tapCoordinate: { x: 540, y: 350 },
      resolvedElement: { strategy: "resource-id", value: "com.phoenix.demo:id/go_to_b", resourceId: "com.phoenix.demo:id/go_to_b" },
      pageSourceBefore: SCREEN_A,
      pageSourceAfter: SCREEN_B,
    },
    // Step 1: on B, tap "Back" -> returns to A (already seen once).
    {
      tapCoordinate: { x: 540, y: 350 },
      resolvedElement: { strategy: "resource-id", value: "com.phoenix.demo:id/back_button", resourceId: "com.phoenix.demo:id/back_button" },
      pageSourceBefore: SCREEN_B,
      pageSourceAfter: SCREEN_A,
    },
  ];

  const assertions = inferAssertions(backNavSteps);

  // Step 0 legitimately introduces Screen B's elements for the first time.
  const step0 = assertions.filter((a) => a.stepIndex === 0).map((a) => a.label).sort();
  assert.deepStrictEqual(step0, ["Back", "Screen B"]);

  // Step 1 returns to Screen A, whose elements were already seen as the
  // very first screen (seeded before any step ran) -- nothing should be
  // re-flagged as newly appeared.
  const step1 = assertions.filter((a) => a.stepIndex === 1);
  assert.strictEqual(step1.length, 0);
});

test("extractLabels/isBlank treat a zero-width space as blank, not a real label", () => {
  // Found for real in a BrowserStack recording (BitBar Sample App, iOS):
  // an accessibility container's rolled-up label was literally "​"
  // (a zero-width space) -- non-empty and truthy by a plain .trim() check,
  // so it survived as a "real" label and produced a generated assertion on
  // `label == ""`, which displays as empty everywhere (the terminal, the
  // script file, the test report) despite technically being non-empty.
  assert.strictEqual(isBlank("​"), true);
  assert.strictEqual(isBlank("  ​‌  "), true);
  assert.strictEqual(isBlank(""), true);
  assert.strictEqual(isBlank("   "), true);
  assert.strictEqual(isBlank("Real label"), false);

  const TREE_WITH_ZERO_WIDTH_LABEL = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther label="​" x="0" y="0" width="390" height="100" />
    <XCUIElementTypeButton label="Real Button" x="0" y="200" width="390" height="44" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

  const labels = extractLabels(TREE_WITH_ZERO_WIDTH_LABEL).map((l) => l.label);
  assert.deepStrictEqual(labels, ["MyApp", "Real Button"], "the zero-width-space label should be skipped entirely, not included as \"\"");
});

test("inferVisualChangeFlags flags a step whose screenshot changed but exposed no accessible labels at all", () => {
  // Simulates a tap into a custom-drawn Canvas/OpenGL screen: the
  // accessibility tree has nothing to offer (extractLabels returns
  // empty for both before and after), so inferAssertions() alone would
  // silently produce zero assertions -- indistinguishable from "the tap
  // did nothing". A changed screenshot is the only signal available that
  // something DID happen.
  const NO_LABELS_BEFORE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy><android.opengl.GLSurfaceView bounds="[0,0][1080,2400]" /></hierarchy>`;
  const NO_LABELS_AFTER = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy><android.opengl.GLSurfaceView bounds="[0,0][1080,2400]" /></hierarchy>`;

  const canvasStep = {
    tapCoordinate: { x: 540, y: 1200 },
    resolvedElement: { strategy: "xpath", value: "/hierarchy[1]/GLSurfaceView[1]" },
    pageSourceBefore: NO_LABELS_BEFORE,
    pageSourceAfter: NO_LABELS_AFTER,
    screenshotBeforeBase64: "aaaa",
    screenshotAfterBase64: "bbbb", // different -> screen visibly changed
  };

  const assertions = inferAssertions([canvasStep]);
  assert.strictEqual(assertions.length, 0, "no accessible labels means no label-based assertion is possible");

  const flags = inferVisualChangeFlags([canvasStep], assertions);
  assert.deepStrictEqual(flags, [{ stepIndex: 0 }]);
});

test("inferVisualChangeFlags does not flag a step that already has a real assertion, or one whose screenshot didn't change", () => {
  // STEPS' final step (the login tap) gets a real label-based assertion
  // ("Welcome"), so it must not also get a visual-change flag.
  const assertions = inferAssertions(STEPS);
  const flags = inferVisualChangeFlags(STEPS, assertions);
  assert.deepStrictEqual(flags, [], "steps with real assertions, or with identical before/after screenshots, should not be flagged");
});

test("generateScript emits a TODO and a screenshot save for a step with no accessible labels", async () => {
  const NO_LABELS = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy><android.opengl.GLSurfaceView bounds="[0,0][1080,2400]" /></hierarchy>`;
  const canvasSteps = [
    {
      tapCoordinate: { x: 540, y: 1200 },
      resolvedElement: { strategy: "xpath", value: "/hierarchy[1]/GLSurfaceView[1]" },
      pageSourceBefore: NO_LABELS,
      pageSourceAfter: NO_LABELS,
      screenshotBeforeBase64: "aaaa",
      screenshotAfterBase64: "bbbb",
    },
  ];

  const result = await generateScript(canvasSteps);
  assert.strictEqual(result.visualChangeFlags.length, 1);
  assert.ok(result.scriptSource.includes("TODO(no accessible labels on this screen)"));
  assert.ok(result.scriptSource.includes("saveScreenshot("));
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
