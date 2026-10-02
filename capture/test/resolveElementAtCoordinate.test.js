/**
 * Sanity tests for resolveElementAtCoordinate(), run against the actual
 * accessibility tree captured during the Stage 0 milestone run (ApiDemos
 * app, API Demos list screen) — not synthetic XML, so this catches
 * regressions against what UIAutomator2 really emits.
 *
 * Run with: npm test (from capture/) or `node test/resolveElementAtCoordinate.test.js`
 */

const assert = require("assert");
const { resolveElementAtCoordinate, parseAndroidBounds, parseIOSBounds, buildXPath, SessionRecorder } = require("../recorder");
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

test("falls through to text (or xpath) instead of an unusable empty accessibility-id, " +
  "when name/content-desc is present but blank or whitespace-only", () => {
  // Found for real against a BrowserStack-recorded iOS app (BitBar Sample
  // App's biometrics screen): a couple of elements carried a `name`
  // attribute that was present but whitespace-only rather than simply
  // absent, producing `~` (nothing after the tilde) in the generated
  // script instead of a usable locator.
  const TREE_WITH_BLANK_NAME = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther name="   " label="Force pass callback" x="100" y="700" width="190" height="44" />
    <XCUIElementTypeOther name="" x="20" y="100" width="200" height="30" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

  const withLabelFallback = resolveElementAtCoordinate({ x: 150, y: 720 }, TREE_WITH_BLANK_NAME);
  assert.notStrictEqual(withLabelFallback.strategy, "accessibility-id");
  assert.strictEqual(withLabelFallback.strategy, "text");
  assert.strictEqual(withLabelFallback.value, "Force pass callback");

  const noLabelAtAll = resolveElementAtCoordinate({ x: 30, y: 110 }, TREE_WITH_BLANK_NAME);
  assert.notStrictEqual(noLabelAtAll.strategy, "accessibility-id");
  assert.strictEqual(noLabelAtAll.strategy, "xpath");
});

test("also falls through when name is a zero-width space, not just plain whitespace", () => {
  // Same real bug, narrower cause: a zero-width space (​) is non-empty
  // and truthy, and untouched by String.prototype.trim() (which only
  // strips real whitespace) -- so a plain trim-then-check misses it. Seen
  // for real on the same BrowserStack recording as the plain-whitespace
  // case above.
  const TREE_WITH_ZERO_WIDTH_NAME = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther name="​" label="Force fail callback" x="100" y="700" width="190" height="44" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

  const result = resolveElementAtCoordinate({ x: 150, y: 720 }, TREE_WITH_ZERO_WIDTH_NAME);
  assert.notStrictEqual(result.strategy, "accessibility-id");
  assert.strictEqual(result.strategy, "text");
  assert.strictEqual(result.value, "Force fail callback");
});

test("buildXPath returns a structural path usable as a last-resort locator", () => {
  const result = resolveElementAtCoordinate({ x: 150, y: 200 }, API_DEMOS_TREE);
  assert.ok(result.xpath.startsWith("/hierarchy[1]"));
});

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makeFakeDriverForRecorder(pageSourceXml) {
  return {
    async takeScreenshot() {
      return "ZmFrZQ=="; // content unused by these tests
    },
    async getPageSource() {
      return pageSourceXml;
    },
  };
}

(async () => {
  // SessionRecorder.beginStep/completeStep -- the tapRatio plumbing that
  // lets a coordinate-fallback locator (resolveElementAtCoordinate's
  // "strategy: coordinate" case, tested above) survive replay on a
  // different device/resolution than it was recorded on. See
  // CapturedStep's own doc comment in ../recorder.js.
  await asyncTest("SessionRecorder.beginStep attaches the optional tapRatio to the partial step", async () => {
    const recorder = new SessionRecorder(makeFakeDriverForRecorder(API_DEMOS_TREE));
    const partialStep = await recorder.beginStep({ x: 540, y: 1200 }, { xRatio: 0.5, yRatio: 0.5 });
    assert.deepStrictEqual(partialStep.tapCoordinate, { x: 540, y: 1200 });
    assert.deepStrictEqual(partialStep.tapRatio, { xRatio: 0.5, yRatio: 0.5 });
  });

  await asyncTest("SessionRecorder.beginStep leaves tapRatio undefined when the caller doesn't supply one", async () => {
    const recorder = new SessionRecorder(makeFakeDriverForRecorder(API_DEMOS_TREE));
    const partialStep = await recorder.beginStep({ x: 540, y: 1200 });
    assert.strictEqual(partialStep.tapRatio, undefined);
  });

  await asyncTest("SessionRecorder.completeStep carries tapRatio through to the final recorded step", async () => {
    const recorder = new SessionRecorder(makeFakeDriverForRecorder(API_DEMOS_TREE));
    const partialStep = await recorder.beginStep({ x: 5000, y: 5000 }, { xRatio: 0.9, yRatio: 0.9 });
    const step = await recorder.completeStep(partialStep);
    assert.deepStrictEqual(step.tapRatio, { xRatio: 0.9, yRatio: 0.9 });
    // Same tap lands outside every element's bounds in API_DEMOS_TREE --
    // the genuine "strategy: coordinate" case this ratio exists to help.
    assert.strictEqual(step.resolvedElement.strategy, "coordinate");
  });

  if (process.exitCode) {
    console.error("\nresolveElementAtCoordinate tests FAILED");
    process.exit(1);
  } else {
    console.log("\nresolveElementAtCoordinate tests passed");
  }
})();
