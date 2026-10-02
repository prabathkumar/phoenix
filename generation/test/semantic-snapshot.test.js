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
const { buildGroundedSnapshot, snapshotToText, findByRef, buildFusedSnapshot } = require("../semantic-snapshot");

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

// A Compose-style screen where the input field itself carries no
// resource-id/content-desc/text -- only a sibling label does. Modeled
// directly on the real MyYes app screen that surfaced this (a real
// device run, not a synthetic guess): the field would previously be
// invisible to the snapshot entirely.
const BLANK_INPUT_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Yes Number" bounds="[277,1400][803,1450]" />
    <android.widget.EditText bounds="[277,1460][803,1560]" />
    <android.widget.TextView text="Log In" bounds="[100,1600][300,1660]" />
    <android.widget.Button bounds="[100,1600][300,1660]" />
  </android.view.View>
</hierarchy>`;

// The exact real-bug screen: Yes Number and Password are both plain
// EditTexts sharing the SAME resource-id, distinguished only by their
// own preceding label TextView. Found on a real device run where a
// "type the password" instruction resolved (via the shared resource-id)
// to the Yes Number field and silently overwrote it.
const DUPLICATE_RESOURCE_ID_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Yes Number" bounds="[102,578][978,645]" />
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="" bounds="[102,645][978,782]" />
    <android.widget.TextView text="Password" bounds="[102,850][978,917]" />
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="" password="true" bounds="[102,917][978,1054]" />
    <android.widget.TextView text="Log In" bounds="[363,1234][718,1336]" />
    <android.widget.Button bounds="[363,1234][718,1336]" />
  </android.view.View>
</hierarchy>`;

// The exact real-bug screen, 2nd-order case: same shared resource-id as
// DUPLICATE_RESOURCE_ID_SCREEN above, but each EditText's OWN `text`
// attribute is populated with its Android hint/placeholder ("Yes
// Number", "Password") rather than being empty -- this is exactly what
// UiAutomator2 reports for a real empty EditText that has a hint set,
// and is indistinguishable, attribute-wise, from an element that carries
// a genuine label. Found for real, reproduced 3/3 batch-loop runs
// against my.yes.yes4g: the original ambiguity check required `!el.label`
// before flagging an element ambiguous, so both hint-bearing fields were
// wrongly treated as "labeled, therefore not ambiguous" and both
// resolved to the plain (ambiguous) resource-id -- the second `type`
// step ("type the password") then produced the exact same
// `resource-id:edtCommon` selector step 1 ("type the yes number") had
// already used, tripping engine/semantic-loop.js's anti-clobber veto and
// permanently failing the loop before it ever reached LOGIN.
const HINT_TEXT_DUPLICATE_RESOURCE_ID_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="Yes Number" bounds="[102,645][978,782]" />
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="Password" password="true" bounds="[102,917][978,1054]" />
    <android.widget.TextView text="Log In" bounds="[363,1234][718,1336]" />
    <android.widget.Button bounds="[363,1234][718,1336]" />
  </android.view.View>
</hierarchy>`;

// Real bug #8, reproduced on a live BrowserStack run: after the password
// field has been typed into, UiAutomator2 reports its `text` as the
// masked placeholder ("•••••••"), which looks exactly like a genuine
// label/value to buildGroundedSnapshot. toSelector() used to treat that
// as this element's `label` and build a live "text" selector from it --
// which goes stale the instant the field is cleared and retyped (the
// dot-mask content changes), permanently losing the element. This
// fixture is the shared-resource-id screen, but captured AFTER typing,
// i.e. with the password EditText's `text` already masked.
const FILLED_PASSWORD_DUPLICATE_RESOURCE_ID_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="0185824587" bounds="[102,645][978,782]" />
    <android.widget.EditText resource-id="my.yes.yes4g:id/edtCommon" text="•••••••" password="true" bounds="[102,917][978,1054]" />
    <android.widget.TextView text="Log In" bounds="[363,1234][718,1336]" />
    <android.widget.Button bounds="[363,1234][718,1336]" />
  </android.view.View>
</hierarchy>`;

// A password field with a resource-id that's unique on screen (no
// collision), still filled with masked text -- confirms `secure` is
// recorded independent of ambiguity, since toSelector() must skip the
// live-text strategy here too even though the resource-id alone would
// otherwise have been a perfectly fine (non-ambiguous) selector.
const FILLED_UNIQUE_PASSWORD_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.widget.EditText resource-id="com.phoenix.demo:id/password_input" text="••••" password="true" bounds="[102,917][978,1054]" />
  </android.view.View>
</hierarchy>`;

// The exact real-bug screen: a Compose tab control whose visible label
// ("PASSWORD") sits on a non-clickable TextView, with a non-clickable
// sibling Button, but a clickable wrapper View (no label/id of its own)
// one level up actually handles the tap. Found on a real device run
// where tapping the "PASSWORD" label resolved, "succeeded" (no WebDriver
// error), and silently did nothing.
const NONCLICKABLE_LABEL_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.view.View bounds="[0,0][1080,2400]">
    <android.view.View clickable="true" bounds="[102,1024][506,1126]">
      <android.widget.TextView text="PASSWORD" clickable="false" bounds="[191,1044][418,1107]" />
      <android.widget.Button clickable="false" bounds="[102,1024][506,1126]" />
    </android.view.View>
    <android.widget.TextView text="Log In" resource-id="my.yes.yes4g:id/tvLogin" clickable="true" bounds="[363,1234][718,1336]" />
  </android.view.View>
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

test("buildGroundedSnapshot parses Android's single-string bounds into {x,y,width,height}", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  const loginButton = elements.find((el) => el.resourceId === "com.phoenix.demo:id/login_button");
  assert.deepStrictEqual(loginButton.bounds, { x: 100, y: 560, width: 880, height: 100 });
});

test("buildGroundedSnapshot parses iOS's x/y/width/height attributes into the same {x,y,width,height} shape", () => {
  const iosScreen = '<XCUIElementTypeApplication name="App"><XCUIElementTypeButton name="loginButton" label="Log In" x="10" y="20" width="50" height="30" /></XCUIElementTypeApplication>';
  const elements = buildGroundedSnapshot(iosScreen);
  const button = elements.find((el) => el.accessibilityId === "loginButton");
  assert.deepStrictEqual(button.bounds, { x: 10, y: 20, width: 50, height: 30 });
});

test("buildGroundedSnapshot leaves bounds undefined when neither shape is present", () => {
  const elements = buildGroundedSnapshot('<hierarchy><Button text="No bounds here" /></hierarchy>');
  assert.strictEqual(elements[0].bounds, undefined);
});

test("snapshotToText only includes bounds when includeBounds is true", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  const plain = snapshotToText(elements);
  const withBounds = snapshotToText(elements, { includeBounds: true });

  assert.ok(!plain.includes("at 100,560"));
  assert.ok(withBounds.includes('[3] android.widget.Button "Log In" (id: com.phoenix.demo:id/login_button, at 100,560 880x100)'));
});

test("buildFusedSnapshot pairs a bounds-annotated text render with the given screenshot", () => {
  const fused = buildFusedSnapshot(ANDROID_LOGIN_SCREEN, "base64-screenshot-bytes");
  assert.strictEqual(fused.elements.length, 3);
  assert.ok(fused.text.includes("at 100,560 880x100"));
  assert.strictEqual(fused.screenshotBase64, "base64-screenshot-bytes");
});

test("buildFusedSnapshot leaves screenshotBase64 undefined when none is given", () => {
  const fused = buildFusedSnapshot(ANDROID_LOGIN_SCREEN);
  assert.strictEqual(fused.screenshotBase64, undefined);
});

test("findByRef resolves a known ref and returns undefined for an unknown one", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  assert.strictEqual(findByRef(elements, 3).resourceId, "com.phoenix.demo:id/login_button");
  assert.strictEqual(findByRef(elements, 99), undefined);
  assert.strictEqual(findByRef([], 1), undefined);
});

test("buildGroundedSnapshot includes a blank EditText even with no label/id of its own", () => {
  const elements = buildGroundedSnapshot(BLANK_INPUT_SCREEN);
  const input = elements.find((el) => el.role === "android.widget.EditText");
  assert.ok(input, "expected the blank EditText to be included as a candidate");
  assert.strictEqual(input.label, undefined);
  assert.strictEqual(input.resourceId, undefined);
  assert.strictEqual(input.accessibilityId, undefined);
});

test("buildGroundedSnapshot attaches the nearest preceding label as nearbyLabel for a blank input", () => {
  const elements = buildGroundedSnapshot(BLANK_INPUT_SCREEN);
  const input = elements.find((el) => el.role === "android.widget.EditText");
  assert.strictEqual(input.nearbyLabel, "Yes Number");
});

test("buildGroundedSnapshot gives a blank input an xpath since it has no other selector", () => {
  const elements = buildGroundedSnapshot(BLANK_INPUT_SCREEN);
  const input = elements.find((el) => el.role === "android.widget.EditText");
  assert.ok(input.xpath && input.xpath.includes("EditText"));
});

test("buildGroundedSnapshot does not attach nearbyLabel/xpath to a normal labeled element", () => {
  const elements = buildGroundedSnapshot(BLANK_INPUT_SCREEN);
  const loginLabel = elements.find((el) => el.label === "Log In");
  assert.strictEqual(loginLabel.nearbyLabel, undefined);
  assert.strictEqual(loginLabel.xpath, undefined);
});

test("snapshotToText renders a blank input's nearbyLabel as an 'empty input near' hint", () => {
  const elements = buildGroundedSnapshot(BLANK_INPUT_SCREEN);
  const text = snapshotToText(elements);
  assert.ok(text.includes('empty input near: "Yes Number"'));
});

test("buildGroundedSnapshot flags an input whose resourceId is shared by another element as ambiguousResourceId", () => {
  const elements = buildGroundedSnapshot(DUPLICATE_RESOURCE_ID_SCREEN);
  const inputs = elements.filter((el) => el.role === "android.widget.EditText");
  assert.strictEqual(inputs.length, 2);
  assert.ok(inputs.every((el) => el.ambiguousResourceId === true));
  assert.ok(inputs.every((el) => el.resourceId === "my.yes.yes4g:id/edtCommon"));
});

test("buildGroundedSnapshot gives each ambiguous-resourceId input its own distinguishing nearbyLabel and xpath", () => {
  const elements = buildGroundedSnapshot(DUPLICATE_RESOURCE_ID_SCREEN);
  const [yesNumberInput, passwordInput] = elements.filter((el) => el.role === "android.widget.EditText");
  assert.strictEqual(yesNumberInput.nearbyLabel, "Yes Number");
  assert.strictEqual(passwordInput.nearbyLabel, "Password");
  assert.ok(yesNumberInput.xpath && passwordInput.xpath);
  assert.notStrictEqual(yesNumberInput.xpath, passwordInput.xpath);
});

test("buildGroundedSnapshot flags a shared resourceId as ambiguous even when each element's own text is its Android hint (not a genuine label)", () => {
  const elements = buildGroundedSnapshot(HINT_TEXT_DUPLICATE_RESOURCE_ID_SCREEN);
  const inputs = elements.filter((el) => el.role === "android.widget.EditText");
  assert.strictEqual(inputs.length, 2);
  assert.ok(
    inputs.every((el) => el.ambiguousResourceId === true),
    "both hint-bearing EditTexts sharing a resource-id must still be flagged ambiguous"
  );
});

test("buildGroundedSnapshot does NOT flag a resourceId that's actually unique on screen", () => {
  const elements = buildGroundedSnapshot(ANDROID_LOGIN_SCREEN);
  const input = elements.find((el) => el.resourceId === "com.phoenix.demo:id/username_input");
  assert.strictEqual(input.ambiguousResourceId, undefined);
});

test("buildGroundedSnapshot records clickable:false for an explicitly non-clickable labeled element", () => {
  const elements = buildGroundedSnapshot(NONCLICKABLE_LABEL_SCREEN);
  const passwordLabel = elements.find((el) => el.label === "PASSWORD");
  assert.strictEqual(passwordLabel.clickable, false);
});

test("buildGroundedSnapshot gives a non-clickable label its clickable ancestor's xpath", () => {
  const elements = buildGroundedSnapshot(NONCLICKABLE_LABEL_SCREEN);
  const passwordLabel = elements.find((el) => el.label === "PASSWORD");
  assert.ok(passwordLabel.clickableAncestorXPath, "expected a clickableAncestorXPath");
  assert.ok(!passwordLabel.clickableAncestorXPath.includes("TextView"), "ancestor xpath should point at the clickable View, not the label itself");
});

test("buildGroundedSnapshot does not set clickableAncestorXPath on an element that's already clickable", () => {
  const elements = buildGroundedSnapshot(NONCLICKABLE_LABEL_SCREEN);
  const loginLabel = elements.find((el) => el.label === "Log In");
  assert.strictEqual(loginLabel.clickable, true);
  assert.strictEqual(loginLabel.clickableAncestorXPath, undefined);
});

test("buildGroundedSnapshot flags a filled password EditText as secure, even though its masked text looks like a real label", () => {
  const elements = buildGroundedSnapshot(FILLED_PASSWORD_DUPLICATE_RESOURCE_ID_SCREEN);
  const passwordField = elements.find((el) => el.label === "•••••••");
  assert.ok(passwordField, "expected to find the masked password EditText by its own displayed text");
  assert.strictEqual(passwordField.secure, true);
});

test("buildGroundedSnapshot does not mark the non-secure sibling field as secure", () => {
  const elements = buildGroundedSnapshot(FILLED_PASSWORD_DUPLICATE_RESOURCE_ID_SCREEN);
  const phoneField = elements.find((el) => el.label === "0185824587");
  assert.strictEqual(phoneField.secure, undefined);
});

test("buildGroundedSnapshot flags a secure field as secure even when its resourceId is unique (not ambiguous)", () => {
  const elements = buildGroundedSnapshot(FILLED_UNIQUE_PASSWORD_SCREEN);
  const passwordField = elements.find((el) => el.resourceId === "com.phoenix.demo:id/password_input");
  assert.strictEqual(passwordField.secure, true);
  assert.strictEqual(passwordField.ambiguousResourceId, undefined, "a unique resourceId must not be flagged ambiguous");
});

test("buildGroundedSnapshot leaves clickable undefined on a tree with no clickable attribute at all (e.g. iOS)", () => {
  const elements = buildGroundedSnapshot(IOS_SCREEN_WITH_BLANK_LABEL);
  const button = elements.find((el) => el.label === "Log In");
  assert.strictEqual(button.clickable, undefined);
  assert.strictEqual(button.clickableAncestorXPath, undefined);
});

// Real bug found on a live BrowserStack iOS run (ios2/ios3): a blank
// XCUITestTextField with no name/label of its own got a structural
// xpath built the same way Android's blank EditTexts do -- byte-for-
// byte reproducible across 20+ seconds of polling a visibly unchanged
// screen, yet XCUITestDriver's native xpath finder returned "no such
// element" for it every single time (not a staleness bug -- the native
// engine just doesn't reliably resolve that shape of path). See
// semantic-snapshot.js's buildIosClassChain()/isIosRole() and
// semantic-act.js's toSelector() for the fix: a "class chain" locator
// instead, which WebDriverAgent natively supports and which has no
// ancestor path to go stale in the first place.
const IOS_LOGIN_SCREEN_WITH_BLANK_TEXT_FIELD = `<AppiumAUT><XCUIElementTypeApplication name="MyYes">
  <XCUIElementTypeStaticText value="Yes Number" name="Yes Number" />
  <XCUIElementTypeTextField label="" />
  <XCUIElementTypeButton name="PASSWORD" />
  <XCUIElementTypeStaticText value="Another Field" name="Another Field" />
  <XCUIElementTypeTextField label="" />
</XCUIElementTypeApplication></AppiumAUT>`;

test("buildGroundedSnapshot gives a blank iOS TextField a classChain, not a structural xpath (real bug: XCUITestDriver's native xpath finder couldn't resolve a position-based path that resolved fine on Android)", () => {
  const elements = buildGroundedSnapshot(IOS_LOGIN_SCREEN_WITH_BLANK_TEXT_FIELD);
  const fields = elements.filter((el) => el.role === "XCUIElementTypeTextField");
  assert.strictEqual(fields.length, 2);
  assert.strictEqual(fields[0].classChain, "**/XCUIElementTypeTextField[1]");
  assert.strictEqual(fields[1].classChain, "**/XCUIElementTypeTextField[2]");
  assert.strictEqual(fields[0].xpath, undefined, "iOS elements should get classChain, never xpath");
  assert.strictEqual(fields[1].xpath, undefined);
});

// Real bug found on a live BrowserStack iOS run (ios5): once the model
// typed into the password field, its masked display text ("•••••••••")
// became its `label` the same way Android's does -- but the original
// `isSecure` check only ever looked for Android's `password="true"`
// attribute, so this iOS SecureTextField was never flagged `secure` at
// all, toSelector() built a live predicate-string selector from the
// masked dots, and the very next action against it failed the instant
// the dot count changed. iOS also has no resource-id to fall back on
// (unlike Android's equivalent bug 8, where the field still had a
// usable resource-id) -- without a classChain computed too, this field
// would have been unresolvable after being flagged secure.
const IOS_FILLED_SECURE_TEXT_FIELD_SCREEN = `<AppiumAUT><XCUIElementTypeApplication name="MyYes">
  <XCUIElementTypeStaticText value="Password" name="Password" />
  <XCUIElementTypeSecureTextField label="•••••••••" />
</XCUIElementTypeApplication></AppiumAUT>`;

test("buildGroundedSnapshot flags an iOS SecureTextField as secure purely from its tag name, even with no password attribute (real bug: only Android's password=\"true\" attribute was checked)", () => {
  const elements = buildGroundedSnapshot(IOS_FILLED_SECURE_TEXT_FIELD_SCREEN);
  const passwordField = elements.find((el) => el.role === "XCUIElementTypeSecureTextField");
  assert.strictEqual(passwordField.secure, true);
});

test("buildGroundedSnapshot still computes a classChain for an iOS SecureTextField even once its masked text makes it look like a normal labeled element (real bug: isBlankInput goes false the moment the mask has any text, which would otherwise skip computing one entirely)", () => {
  const elements = buildGroundedSnapshot(IOS_FILLED_SECURE_TEXT_FIELD_SCREEN);
  const passwordField = elements.find((el) => el.role === "XCUIElementTypeSecureTextField");
  assert.strictEqual(passwordField.label, "•••••••••");
  assert.strictEqual(passwordField.classChain, "**/XCUIElementTypeSecureTextField[1]");
  assert.strictEqual(passwordField.nearbyLabel, "Password");
});

test("buildGroundedSnapshot still uses a structural xpath (not classChain) for Android's equivalent blank-input case", () => {
  const androidBlankInput = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.TextView text="Yes Number" />
    <android.widget.EditText text="" />
  </android.widget.FrameLayout>
</hierarchy>`;
  const elements = buildGroundedSnapshot(androidBlankInput);
  const field = elements.find((el) => el.role === "android.widget.EditText");
  assert.ok(field.xpath, "Android's blank input should still get a structural xpath");
  assert.strictEqual(field.classChain, undefined);
});

// Real bug found on a live BrowserStack iOS run (ios14): the home
// screen's "LOGIN" button (opens the login form) and the login form's
// own submit "LOGIN" button report the exact same accessibilityId.
// `$("~LOGIN")`/`findElement("accessibility id", "LOGIN")` just
// returns whichever matches first -- confirmed in the real run's log
// that the SAME WebDriver element id was returned for both "open the
// form" (early in the run) and "submit the form" (at the very end),
// so the final submit tap silently re-clicked the original, by-then-
// hidden home-screen button instead of the real, visible submit
// button. Both fields stayed correctly filled in, the tap "succeeded"
// with no WebDriver error, and the screen simply never changed.
const IOS_DUPLICATE_LOGIN_BUTTON_SCREEN = `<AppiumAUT><XCUIElementTypeApplication name="MyYes">
  <XCUIElementTypeButton name="LOGIN" visible="false" />
  <XCUIElementTypeStaticText value="Phone Number" name="Phone Number" />
  <XCUIElementTypeTextField label="01166114421" />
  <XCUIElementTypeButton name="LOGIN" visible="true" />
</XCUIElementTypeApplication></AppiumAUT>`;

test("buildGroundedSnapshot flags a duplicate iOS accessibilityId as ambiguous and builds a visibility-predicate classChain (real bug: home screen's LOGIN button and the form's submit LOGIN button share one accessibility id)", () => {
  const elements = buildGroundedSnapshot(IOS_DUPLICATE_LOGIN_BUTTON_SCREEN);
  const loginButtons = elements.filter((el) => el.accessibilityId === "LOGIN");
  assert.strictEqual(loginButtons.length, 2);
  assert.ok(
    loginButtons.every((el) => el.ambiguousAccessibilityId === true),
    "both same-named LOGIN buttons must be flagged ambiguous"
  );
  assert.ok(
    loginButtons.every((el) => el.classChain === '**/XCUIElementTypeButton[`name == "LOGIN" AND visible == 1`]'),
    "every ambiguous LOGIN button should get the same visibility-predicate classChain, so WebDriverAgent picks whichever one is actually on screen"
  );
});

test("buildGroundedSnapshot does NOT flag an accessibilityId that's actually unique on an iOS screen", () => {
  const elements = buildGroundedSnapshot(IOS_LOGIN_SCREEN_WITH_BLANK_TEXT_FIELD);
  const passwordTab = elements.find((el) => el.accessibilityId === "PASSWORD");
  assert.strictEqual(passwordTab.ambiguousAccessibilityId, undefined);
  assert.strictEqual(passwordTab.classChain, undefined, "a uniquely-named button needs no classChain fallback at all");
});

// Real bug found on a live BrowserStack iOS run (addons-run-ios-docker-2.log,
// test-cases/addons.ios.json): the resolver declined to tap "the LOGIN
// button on the home screen", reasoning that the only "LOGIN"-named
// elements belonged to an unrelated "Login More Menu New" button. The
// real page-source XML captured in that exact run (trimmed here to the
// relevant portion, real attribute values kept byte-for-byte) shows a
// plain, visible, accessible "LOGIN" button is genuinely present and
// unrelated to "Login More Menu New" -- but it was wrongly flagged
// ambiguousAccessibilityId, same as the "EN" and "ACTIVATE SIM" buttons
// elsewhere on this exact screen: iOS's own page-source dump nests a
// StaticText carrying the identical name INSIDE the button it labels
// (one visual control, represented twice in the tree), and the old
// count-by-accessibilityId-value check treated that nested StaticText
// as a second, independently-tappable "LOGIN" element, flagging both
// it and the real button ambiguous even though there was no second,
// separate "Login" control anywhere in this screen's tree.
const IOS_REAL_HOME_SCREEN_WITH_NESTED_LABELS = `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="MyYes" label="MyYes" enabled="true" visible="true" accessible="false" x="0" y="0" width="393" height="852" index="0" traits="" processId="847" bundleId="my.yes.yes4g">
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="EN" label="EN" enabled="true" visible="true" accessible="true" x="300" y="60" width="73" height="32" index="1" traits="Button">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="EN" name="EN" label="EN" enabled="true" visible="true" accessible="false" x="316" y="68" width="21" height="16" index="0" traits="StaticText"/>
  </XCUIElementTypeButton>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="LOGIN" label="LOGIN" enabled="true" visible="true" accessible="true" x="92" y="576" width="209" height="50" index="2" traits="Button">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="LOGIN" name="LOGIN" label="LOGIN" enabled="true" visible="true" accessible="false" x="169" y="592" width="55" height="18" index="0" traits="StaticText"/>
  </XCUIElementTypeButton>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="ACTIVATE SIM" label="ACTIVATE SIM" enabled="true" visible="true" accessible="true" x="92" y="646" width="209" height="50" index="3" traits="Button">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="ACTIVATE SIM" name="ACTIVATE SIM" label="ACTIVATE SIM" enabled="true" visible="true" accessible="false" x="136" y="662" width="121" height="18" index="0" traits="StaticText"/>
  </XCUIElementTypeButton>
  <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="724" width="393" height="128" index="4" traits="">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="NEW TO YES?" name="NEW TO YES?" label="NEW TO YES?" enabled="true" visible="false" accessible="true" x="110" y="750" width="173" height="26" index="1" traits="StaticText"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Login More Menu New" label="Login More Menu New" enabled="true" visible="true" accessible="true" x="349" y="752" width="18" height="22" index="2" traits="Button">
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" enabled="true" visible="false" accessible="false" x="349" y="752" width="0" height="0" index="0" traits="StaticText"/>
    </XCUIElementTypeButton>
  </XCUIElementTypeOther>
</XCUIElementTypeApplication></AppiumAUT>`;

test("buildGroundedSnapshot does NOT flag a plain home-screen LOGIN button as ambiguous just because its own nested StaticText label mirrors its name (real bug, addons-run-ios-docker-2.log: this false positive made the resolver decline to tap a genuine, unambiguous LOGIN button)", () => {
  const elements = buildGroundedSnapshot(IOS_REAL_HOME_SCREEN_WITH_NESTED_LABELS);

  const loginButton = elements.find((el) => el.role === "XCUIElementTypeButton" && el.label === "LOGIN");
  assert.ok(loginButton, "the real LOGIN button must appear in the snapshot");
  assert.strictEqual(loginButton.ambiguousAccessibilityId, undefined);
  assert.strictEqual(loginButton.classChain, undefined, "an unambiguous button needs no classChain fallback");

  // Its own nested StaticText label must not be flagged either -- same
  // reasoning, same (single) real control.
  const loginStaticText = elements.find((el) => el.role === "XCUIElementTypeStaticText" && el.label === "LOGIN");
  assert.ok(loginStaticText);
  assert.strictEqual(loginStaticText.ambiguousAccessibilityId, undefined);

  // The differently-named, differently-positioned "Login More Menu New"
  // button must remain clearly distinguishable: its own accessibility
  // id/label, unaffected by the LOGIN button's.
  const menuButton = elements.find((el) => el.label === "Login More Menu New");
  assert.ok(menuButton);
  assert.strictEqual(menuButton.accessibilityId, "Login More Menu New");
  assert.strictEqual(menuButton.ambiguousAccessibilityId, undefined);
  assert.notStrictEqual(menuButton.ref, loginButton.ref);

  // Every other labeled button on this real screen (EN, ACTIVATE SIM)
  // must likewise be unaffected -- the old bug flagged ALL of them, not
  // just LOGIN, since every one has its own mirroring StaticText child.
  for (const name of ["EN", "ACTIVATE SIM"]) {
    const button = elements.find((el) => el.role === "XCUIElementTypeButton" && el.label === name);
    assert.strictEqual(button.ambiguousAccessibilityId, undefined, `${name} must not be falsely flagged ambiguous`);
  }
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/semantic-snapshot tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-snapshot tests passed");
  }
});
