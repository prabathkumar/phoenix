/**
 * Sanity tests for resolveElementAtCoordinate(), run against the actual
 * accessibility tree captured during the Stage 0 milestone run (ApiDemos
 * app, API Demos list screen) — not synthetic XML, so this catches
 * regressions against what UIAutomator2 really emits.
 *
 * Run with: npm test (from capture/) or `node test/resolveElementAtCoordinate.test.js`
 */

const assert = require("assert");
const { resolveElementAtCoordinate, parseAndroidBounds, parseIOSBounds, buildXPath } = require("../recorder");
const { DOMParser } = require("@xmldom/xmldom");

// Trimmed version of the tree captured in the Stage 0 run against
// io.appium.android.apis (ApiDemos-debug.apk).
const API_DEMOS_TREE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2209">
  <android.widget.FrameLayout index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <android.view.ViewGroup index="0" class="android.view.ViewGroup" resource-id="android:id/decor_content_parent" bounds="[0,0][1080,2337]">
      <android.widget.FrameLayout index="0" class="android.widget.FrameLayout" resource-id="android:id/action_bar_container" bounds="[0,128][1080,275]">
        <android.view.ViewGroup index="0" class="android.view.ViewGroup" resource-id="android:id/action_bar" bounds="[0,128][1080,275]">
          <android.widget.TextView index="0" class="android.widget.TextView" text="API Demos" bounds="[42,166][305,237]" />
        </android.view.ViewGroup>
      </android.widget.FrameLayout>
      <android.widget.FrameLayout index="1" class="android.widget.FrameLayout" resource-id="android:id/content" bounds="[0,275][1080,2337]">
        <android.widget.ListView index="0" class="android.widget.ListView" resource-id="android:id/list" bounds="[0,275][1080,2337]">
          <android.widget.TextView index="0" class="android.widget.TextView" text="Accessibility" content-desc="Accessibility" resource-id="android:id/text1" clickable="true" bounds="[0,404][1080,530]" />
          <android.widget.TextView index="1" class="android.widget.TextView" text="Animation" content-desc="Animation" resource-id="android:id/text1" clickable="true" bounds="[0,533][1080,659]" />
          <android.widget.TextView index="2" class="android.widget.TextView" text="Graphics" content-desc="Graphics" clickable="true" bounds="[0,920][1080,1046]" />
        </android.widget.ListView>
      </android.widget.FrameLayout>
    </android.view.ViewGroup>
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

console.log("resolveElementAtCoordinate:");

test("resolves resource-id when present, preferring the deepest/smallest match", () => {
  const result = resolveElementAtCoordinate({ x: 500, y: 460 }, API_DEMOS_TREE);
  assert.strictEqual(result.strategy, "resource-id");
  assert.strictEqual(result.value, "android:id/text1");
  assert.strictEqual(result.text, "Accessibility");
});

test("falls back to accessibility-id (content-desc) when no resource-id on the smallest match", () => {
  const result = resolveElementAtCoordinate({ x: 500, y: 980 }, API_DEMOS_TREE);
  assert.strictEqual(result.strategy, "accessibility-id");
  assert.strictEqual(result.value, "Graphics");
});

test("falls back to raw coordinate when the tap lands outside every element's bounds", () => {
  const result = resolveElementAtCoordinate({ x: 5000, y: 5000 }, API_DEMOS_TREE);
  assert.strictEqual(result.strategy, "coordinate");
  assert.strictEqual(result.value, "5000,5000");
});

test("parseAndroidBounds parses the UIAutomator2 bounds format", () => {
  assert.deepStrictEqual(parseAndroidBounds("[0,275][1080,2337]"), { x1: 0, y1: 275, x2: 1080, y2: 2337 });
  assert.strictEqual(parseAndroidBounds("not-bounds"), null);
});

test("parseIOSBounds reads XCUITest's x/y/width/height attributes", () => {
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString('<XCUIElementTypeButton x="10" y="20" width="100" height="40" />', "text/xml");
  assert.deepStrictEqual(parseIOSBounds(doc.documentElement), { x1: 10, y1: 20, x2: 110, y2: 60 });

  const noBounds = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString('<XCUIElementTypeApplication name="MyApp" />', "text/xml");
  assert.strictEqual(parseIOSBounds(noBounds.documentElement), null);
});

test("resolveElementAtCoordinate resolves an iOS/XCUITest-style tree via name/label and x/y/width/height", () => {
  const IOS_TREE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton name="loginButton" label="Log In" x="100" y="700" width="190" height="44" />
    <XCUIElementTypeStaticText label="Welcome" value="Welcome" x="20" y="100" width="200" height="30" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

  const button = resolveElementAtCoordinate({ x: 150, y: 720 }, IOS_TREE);
  assert.strictEqual(button.strategy, "accessibility-id");
  assert.strictEqual(button.value, "loginButton");
  assert.strictEqual(button.text, "Log In");

  const label = resolveElementAtCoordinate({ x: 30, y: 110 }, IOS_TREE);
  assert.strictEqual(label.strategy, "text");
  assert.strictEqual(label.value, "Welcome");
});

test("buildXPath returns a structural path usable as a last-resort locator", () => {
  const result = resolveElementAtCoordinate({ x: 150, y: 200 }, API_DEMOS_TREE);
  assert.ok(result.xpath.startsWith("/hierarchy[1]"));
});

if (process.exitCode) {
  console.error("\nresolveElementAtCoordinate tests FAILED");
  process.exit(1);
} else {
  console.log("\nresolveElementAtCoordinate tests passed");
}
