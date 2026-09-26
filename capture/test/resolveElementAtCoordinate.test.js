/**
 * Sanity tests for resolveElementAtCoordinate(), run against the actual
 * accessibility tree captured during the Stage 0 milestone run (ApiDemos
 * app, API Demos list screen) — not synthetic XML, so this catches
 * regressions against what UIAutomator2 really emits.
 *
 * Run with: npm test (from capture/) or `node test/resolveElementAtCoordinate.test.js`
 */

const assert = require("assert");
const { resolveElementAtCoordinate, parseBounds, buildXPath } = require("../recorder");

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

test("parseBounds parses the UIAutomator2 bounds format", () => {
  assert.deepStrictEqual(parseBounds("[0,275][1080,2337]"), { x1: 0, y1: 275, x2: 1080, y2: 2337 });
  assert.strictEqual(parseBounds("not-bounds"), null);
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
