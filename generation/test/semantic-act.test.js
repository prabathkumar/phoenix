/**
 * Tests for the Phase 2 semantic-action resolver
 * (generation/semantic-act.js). Fakes generation/llm.js's
 * callOllamaJson() via require.cache injection (the same technique used
 * in engine/test/session-manager.test.js and
 * frontend/test/upload-session.test.js) so these tests run without a
 * real Ollama instance and can drive every branch (confident match,
 * declined match, hallucinated ref, Ollama failure) deterministically.
 *
 * Run with: npm test (from generation/) or `node test/semantic-act.test.js`
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Isolated per-run log path so these tests never touch a real
// training-data/ directory and never see another test file's records --
// set before any module reads it (execution-log.js reads the env var
// fresh on every call, not just at require time, but set this early
// regardless for clarity).
process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "testops-mobile-semantic-act-log-")),
  "executions.jsonl"
);
const { logExecution } = require("../execution-log");

const ANDROID_LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Login" bounds="[42,166][305,237]" />
    <android.widget.EditText resource-id="com.testopsmobile.demo:id/username_input" text="" bounds="[100,300][980,400]" />
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;

const llmPath = require.resolve("../llm");
const semanticActPath = require.resolve("../semantic-act");

/**
 * Loads semantic-act.js with generation/llm.js's callOllamaJson faked
 * out, then restores the real module afterward -- same require.cache
 * swap-and-restore pattern used elsewhere in this repo's tests.
 */
function loadWithFakeOllama(fakeCallOllamaJson) {
  delete require.cache[llmPath];
  delete require.cache[semanticActPath];

  const realLlm = require(llmPath);
  require.cache[llmPath].exports = { ...realLlm, callOllamaJson: fakeCallOllamaJson };

  const semanticAct = require(semanticActPath);

  return {
    semanticAct,
    restore: () => {
      delete require.cache[llmPath];
      delete require.cache[semanticActPath];
    },
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("generation/semantic-act:");

  await test("resolveSemanticAction resolves a confident ref match to a resource-id selector", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 3 }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.strictEqual(result.resolved, true);
      assert.deepStrictEqual(result.selector, { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" });
      assert.strictEqual(result.element.ref, 3);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction stays unresolved when the model declines to match (ref: null)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: null, reason: "no element matches 'the checkout button'" }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the checkout button");
      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.reason, "no element matches 'the checkout button'");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's prompt tells the model a wrong guess is worse than declining, and warns against category/word-overlap matches (real bug chain: addons-run-android-6/8/9.log -- \"Allow\" matched to ACTIVATE SIM, then to a \"More Icon\", then a \"CLOSE\" recovery step matched an unrelated screen's own Back Arrow)", async () => {
    let capturedPrompt;
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      capturedPrompt = prompt;
      return { ref: 3 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.ok(capturedPrompt.includes("far more costly than correctly declining"));
      assert.ok(capturedPrompt.includes("not, by"));
      assert.ok(capturedPrompt.includes("you MUST decline"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction falls back to a real message instead of echoing the prompt's own \"...\" placeholder (real bug: addons-run-android-6.log)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: null, reason: "..." }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the checkout button");
      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.reason, "model did not find a confident match");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction falls back to a real message instead of echoing a <placeholder>-shaped reason", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: null, reason: "<your own brief, specific explanation of why nothing matches>" }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the checkout button");
      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.reason, "model did not find a confident match");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction stays unresolved rather than trusting a hallucinated ref outside the snapshot", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 999 }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("999"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction stays unresolved (never throws) when Ollama fails", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("ECONNREFUSED"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction stays unresolved on a malformed Ollama response (missing ref field)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ somethingElse: true }));
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.strictEqual(result.resolved, false);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction short-circuits to unresolved when the snapshot has nothing to act on, without calling Ollama", async () => {
    let called = false;
    const { semanticAct, restore } = loadWithFakeOllama(async () => {
      called = true;
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction("<hierarchy><View /></hierarchy>", "tap anything");
      assert.strictEqual(result.resolved, false);
      assert.strictEqual(called, false);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction passes the screenshot through to callOllamaJson's images option in fused mode", async () => {
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt, options) => {
      calls.push({ prompt, options });
      return { ref: 3 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button", { screenshotBase64: "fake-base64-bytes" });
      assert.strictEqual(result.resolved, true);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].options, { images: ["fake-base64-bytes"] });
      // Fused mode's prompt includes bounds so the model can cross-check
      // the text against the attached image.
      assert.ok(calls[0].prompt.includes("at 100,560 880x100"));
      assert.ok(calls[0].prompt.includes("screenshot"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction calls callOllamaJson without an images option in plain text mode", async () => {
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt, options) => {
      calls.push({ prompt, options });
      return { ref: 3 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.strictEqual(calls[0].options, undefined);
      assert.ok(!calls[0].prompt.includes("at 100,560"));
    } finally {
      restore();
    }
  });

  await test("toSelector prefers resource-id, then accessibility-id, then label, in that order", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({ resourceId: "id1", accessibilityId: "a11y1", label: "Label1" }),
        { strategy: "resource-id", value: "id1" }
      );
      assert.deepStrictEqual(
        semanticAct.toSelector({ accessibilityId: "a11y1", label: "Label1" }),
        { strategy: "accessibility-id", value: "a11y1" }
      );
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "Label1" }),
        { strategy: "text", value: "Label1" }
      );
      assert.strictEqual(semanticAct.toSelector({}), undefined);
    } finally {
      restore();
    }
  });

  await test("toSelector falls back to xpath for a blank input with no other identifier", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({ xpath: "/hierarchy/EditText[1]" }),
        { strategy: "xpath", value: "/hierarchy/EditText[1]" }
      );
      // resourceId/accessibilityId/label still win over xpath when present.
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "Label1", xpath: "/hierarchy/EditText[1]" }),
        { strategy: "text", value: "Label1" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector skips the live-text strategy for an iOS secure field with a masked label and falls back to classChain, not xpath (real bug: ios5 -- a SecureTextField has no resource-id to fall back on the way Android's equivalent bug 8 did)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({
          secure: true,
          label: "•••••••••",
          classChain: "**/XCUIElementTypeSecureTextField[1]",
        }),
        { strategy: "class-chain", value: "**/XCUIElementTypeSecureTextField[1]" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector prefers classChain over accessibility-id for an iOS secure field that has both (real bug, ios11, login-script mode's first real-hardware run): this app's password field reports accessibility id \"PASSWORD\" while empty, derived from its placeholder, but that name vanishes from the tree once real text is typed -- a setValue() against \"~PASSWORD\" can succeed once and then fail on an internal re-resolve with \"element wasn't found\", the same live-selector failure bug 13 already fixed for `label`", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({
          secure: true,
          accessibilityId: "PASSWORD",
          label: "•••••••••",
          classChain: "**/XCUIElementTypeSecureTextField[1]",
        }),
        { strategy: "class-chain", value: "**/XCUIElementTypeSecureTextField[1]" }
      );
      // Android's secure fields never get a classChain at all (that's
      // only ever computed for iOS, see needsIosPositionalLocator in
      // semantic-snapshot.js) -- without one to fall back to, a secure
      // field's accessibility id is still trusted exactly as before
      // (bug 8 was only ever about the live masked *text*, not the
      // accessibility id), so this fix must not touch that path.
      assert.deepStrictEqual(
        semanticAct.toSelector({ secure: true, label: "•••••••", accessibilityId: "a11y1" }),
        { strategy: "accessibility-id", value: "a11y1" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector prefers a visibility-predicate classChain over accessibility-id for a duplicate iOS accessibility id (real bug, ios14: the home screen's LOGIN button and the login form's own submit LOGIN button share the same accessibility id, so `~LOGIN` always resolved to whichever matched first -- the same, by-then-hidden home-screen button -- instead of the real, visible submit button)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({
          accessibilityId: "LOGIN",
          ambiguousAccessibilityId: true,
          classChain: '**/XCUIElementTypeButton[`name == "LOGIN" AND visible == 1`]',
        }),
        { strategy: "class-chain", value: '**/XCUIElementTypeButton[`name == "LOGIN" AND visible == 1`]' }
      );
      // A non-ambiguous accessibility id must still win over xpath exactly
      // as before -- this fix only skips accessibility-id when the id is
      // actually flagged ambiguous.
      assert.deepStrictEqual(
        semanticAct.toSelector({ accessibilityId: "a11y1", ambiguousAccessibilityId: undefined }),
        { strategy: "accessibility-id", value: "a11y1" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector prefers classChain over the label/text strategy for a duplicate iOS accessibility id, not just over accessibility-id itself (real bug, ios15: the ambiguous-accessibility-id guard skipped accessibility-id as intended, but then fell through to a just-as-ambiguous label predicate instead of classChain, since the label block had no ambiguity check of its own)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({
          accessibilityId: "LOGIN",
          ambiguousAccessibilityId: true,
          label: "LOGIN",
          classChain: '**/XCUIElementTypeButton[`name == "LOGIN" AND visible == 1`]',
        }),
        { strategy: "class-chain", value: '**/XCUIElementTypeButton[`name == "LOGIN" AND visible == 1`]' }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector prefers classChain over xpath for an iOS element that has both (real bug: XCUITestDriver's native xpath finder couldn't resolve a position-based path that resolved fine on Android)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({ classChain: "**/XCUIElementTypeTextField[1]", xpath: "/AppiumAUT/.../TextField[1]" }),
        { strategy: "class-chain", value: "**/XCUIElementTypeTextField[1]" }
      );
      // No classChain computed (the Android case) -- still falls back to xpath.
      assert.deepStrictEqual(
        semanticAct.toSelector({ xpath: "/hierarchy/EditText[1]" }),
        { strategy: "xpath", value: "/hierarchy/EditText[1]" }
      );
      // resourceId/accessibilityId/label still win over classChain when present.
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "Label1", classChain: "**/XCUIElementTypeTextField[1]" }),
        { strategy: "text", value: "Label1" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector prefers xpath over an ambiguousResourceId (real bug: two fields shared one resource-id)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      assert.deepStrictEqual(
        semanticAct.toSelector({ resourceId: "edtCommon", ambiguousResourceId: true, xpath: "/hierarchy/EditText[2]" }),
        { strategy: "xpath", value: "/hierarchy/EditText[2]" }
      );
      // accessibility-id/label still win over an ambiguous resource-id when present.
      assert.deepStrictEqual(
        semanticAct.toSelector({ resourceId: "edtCommon", ambiguousResourceId: true, accessibilityId: "a11y1" }),
        { strategy: "accessibility-id", value: "a11y1" }
      );
      // No xpath computed somehow -- still falls back to the resource-id
      // rather than returning undefined and failing to resolve at all.
      assert.deepStrictEqual(
        semanticAct.toSelector({ resourceId: "edtCommon", ambiguousResourceId: true }),
        { strategy: "resource-id", value: "edtCommon" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector skips the live-text strategy for a secure field and falls back to xpath (real bug #8: masked password text goes stale)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      // The exact real-bug shape: an ambiguous-resource-id password field
      // whose `label` is its own masked display text ("•••••••"). Using
      // that as a "text" selector breaks the instant the field is cleared
      // and retyped (the mask content changes) -- must use xpath instead.
      assert.deepStrictEqual(
        semanticAct.toSelector({
          resourceId: "edtCommon",
          ambiguousResourceId: true,
          secure: true,
          label: "•••••••",
          xpath: "/hierarchy/EditText[2]",
        }),
        { strategy: "xpath", value: "/hierarchy/EditText[2]" }
      );
      // accessibility-id still wins over a secure field's own text, same
      // as the ordinary ambiguous case.
      assert.deepStrictEqual(
        semanticAct.toSelector({ secure: true, label: "•••••••", accessibilityId: "a11y1" }),
        { strategy: "accessibility-id", value: "a11y1" }
      );
      // No xpath computed and no other identifier at all -- still falls
      // back to the (non-ambiguous) resource-id rather than ever using
      // the live masked text.
      assert.deepStrictEqual(
        semanticAct.toSelector({ resourceId: "password_input", secure: true, label: "••••" }),
        { strategy: "resource-id", value: "password_input" }
      );
      // A non-secure field with the exact same shape is unaffected --
      // this is purely about the secure flag, not a general xpath
      // preference change.
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "Yes Number" }),
        { strategy: "text", value: "Yes Number" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector redirects a tap on a non-clickable element to its clickable ancestor (real bug: Compose tab label)", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      const element = { label: "PASSWORD", clickable: false, clickableAncestorXPath: "/hierarchy/android.view.View[1]" };
      assert.deepStrictEqual(
        semanticAct.toSelector(element, { kind: "tap" }),
        { strategy: "xpath", value: "/hierarchy/android.view.View[1]" }
      );
      // Only for "tap" -- a "type" action (or no kind at all) still uses
      // the element's own selector, since redirecting a type action to a
      // container View would make no sense.
      assert.deepStrictEqual(
        semanticAct.toSelector(element, { kind: "type" }),
        { strategy: "text", value: "PASSWORD" }
      );
      assert.deepStrictEqual(
        semanticAct.toSelector(element),
        { strategy: "text", value: "PASSWORD" }
      );
    } finally {
      restore();
    }
  });

  await test("toSelector does not redirect a tap when the element is already clickable or has no clickable ancestor recorded", async () => {
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      // clickable: true -- own selector wins.
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "Log In", clickable: true, clickableAncestorXPath: "/should/not/be/used" }, { kind: "tap" }),
        { strategy: "text", value: "Log In" }
      );
      // clickable: false but no ancestor xpath was found -- own selector wins.
      assert.deepStrictEqual(
        semanticAct.toSelector({ label: "PASSWORD", clickable: false }, { kind: "tap" }),
        { strategy: "text", value: "PASSWORD" }
      );
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction tells the model to prefer an editable input when kind is \"type\"", async () => {
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt, options) => {
      calls.push({ prompt, options });
      return { ref: 2 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "type the username", { kind: "type" });
      assert.ok(calls[0].prompt.includes("TEXT-ENTRY action"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction does not add the text-entry hint when kind is \"tap\" or omitted", async () => {
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt, options) => {
      calls.push({ prompt, options });
      return { ref: 3 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.ok(!calls[0].prompt.includes("TEXT-ENTRY action"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction excludes a guaranteed-no-op tap candidate (real bug: Compose tab container with no clickable ancestor)", async () => {
    // Shape of the real failing screen: a non-clickable ComposeView
    // container with its own resource-id (no clickable ancestor -- its
    // clickable tab View is a DESCENDANT, not an ancestor), sitting
    // alongside a non-clickable "PASSWORD" label that DOES have a valid
    // clickableAncestorXPath redirect from a clickable View further down
    // still. Only the composeView candidate is offered to the model
    // (ref 1 in this fixture); a correct model would never see it as an
    // option at all for a tap.
    const COMPOSE_TAB_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]" clickable="false">
    <androidx.compose.ui.platform.ComposeView resource-id="my.yes.yes4g:id/composeView" clickable="false" bounds="[102,1024][978,1126]">
      <android.view.View clickable="false" bounds="[102,1024][978,1126]">
        <android.view.View clickable="true" bounds="[102,1024][506,1126]">
          <android.widget.TextView text="PASSWORD" clickable="false" bounds="[191,1044][418,1107]" />
        </android.view.View>
      </android.view.View>
    </androidx.compose.ui.platform.ComposeView>
  </android.widget.FrameLayout>
</hierarchy>`;

    let capturedPrompt;
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      capturedPrompt = prompt;
      // Simulate the real failure: if the model were offered the
      // container, it'd pick it (ref 1). We assert below that it was
      // never offered that choice at all.
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(COMPOSE_TAB_SCREEN, "tap the PASSWORD tab", { kind: "tap" });
      // ref 1 (the composeView container) must not appear as a candidate
      // in the prompt at all -- it's filtered out before the model sees it.
      assert.ok(!capturedPrompt.includes("my.yes.yes4g:id/composeView"));
      assert.ok(capturedPrompt.includes(`"PASSWORD"`));
      // The model's ref:1 no longer refers to the container (it's been
      // filtered out and refs aren't renumbered) -- with only the
      // PASSWORD label left, findByRef(1) actually does resolve to it in
      // this fixture (composeView was ref 1, filtered out; PASSWORD's
      // own ref is whatever buildGroundedSnapshot assigned it -- the
      // important assertion here is the container was never offered).
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("not in this snapshot") || result.resolved === false);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction still resolves a valid tap when only some candidates are no-op dead ends", async () => {
    const COMPOSE_TAB_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]" clickable="false">
    <androidx.compose.ui.platform.ComposeView resource-id="my.yes.yes4g:id/composeView" clickable="false" bounds="[102,1024][978,1126]">
      <android.view.View clickable="false" bounds="[102,1024][978,1126]">
        <android.view.View clickable="true" bounds="[102,1024][506,1126]">
          <android.widget.TextView text="PASSWORD" clickable="false" bounds="[191,1044][418,1107]" />
        </android.view.View>
      </android.view.View>
    </androidx.compose.ui.platform.ComposeView>
  </android.widget.FrameLayout>
</hierarchy>`;

    const elements = require("../semantic-snapshot").buildGroundedSnapshot(COMPOSE_TAB_SCREEN);
    const passwordEl = elements.find((el) => el.label === "PASSWORD");

    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: passwordEl.ref }));
    try {
      const result = await semanticAct.resolveSemanticAction(COMPOSE_TAB_SCREEN, "tap the PASSWORD tab", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      // Redirected to the real clickable ancestor, not the label itself.
      assert.strictEqual(result.selector.strategy, "xpath");
      assert.strictEqual(result.selector.value, passwordEl.clickableAncestorXPath);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction does not filter tap candidates by clickability when kind is \"type\" or omitted", async () => {
    // clickable: undefined (no attribute at all, e.g. iOS) must never be
    // filtered -- only an explicit clickable=false with no ancestor is a
    // known dead end. This also confirms the filter is tap-only: with no
    // kind at all, nothing here should be excluded.
    const IOS_STYLE_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <XCUIElementTypeApplication>
    <XCUIElementTypeButton name="Log In" x="100" y="560" width="880" height="100" />
  </XCUIElementTypeApplication>
</hierarchy>`;
    const { semanticAct, restore } = loadWithFakeOllama(async () => ({ ref: 1 }));
    try {
      const result = await semanticAct.resolveSemanticAction(IOS_STYLE_SCREEN, "tap Log In");
      assert.strictEqual(result.resolved, true);
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's excludedRefs removes a candidate from the snapshot before the model ever sees it", async () => {
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      // The only other candidate confident enough to match.
      return { ref: 1 };
    });
    try {
      // Ref 3 is the login_button in ANDROID_LOGIN_SCREEN's natural ref
      // order (see the first test in this file).
      const result = await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap something", { excludedRefs: [3] });
      assert.strictEqual(result.resolved, true);
      // Excluded from the prompt text entirely -- not just skipped by the model.
      assert.ok(!calls[0].includes("Log In"));
      assert.ok(!calls[0].includes("[3]"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction reports unresolved (never throws) when excludedRefs removes every candidate", async () => {
    const ONE_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/only_button" text="Only" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const { semanticAct, restore } = loadWithFakeOllama(async () => {
      throw new Error("callOllamaJson should never be called with zero candidates");
    });
    try {
      const result = await semanticAct.resolveSemanticAction(ONE_BUTTON_SCREEN, "tap Only", { excludedRefs: [1] });
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("no labeled/identified elements"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction surfaces past logged failures for this exact instruction as a soft hint in the prompt", async () => {
    logExecution({ instruction: "tap the Login button", success: false, reason: "no confident match -- two similar buttons" });
    logExecution({ instruction: "tap the Login button", success: false, reason: "resolved but the click did nothing" });
    // A different instruction's failure must never leak into this one's hint.
    logExecution({ instruction: "tap the Logout button", success: false, reason: "unrelated failure" });
    // A past SUCCESS for the same instruction must never be treated as a failure.
    logExecution({ instruction: "tap the Login button", success: true });

    let capturedPrompt;
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      capturedPrompt = prompt;
      return { ref: 3 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap the Login button");
      assert.ok(capturedPrompt.includes("on 2 past run(s)"), "should report exactly 2 past failures for this instruction, not the unrelated or successful ones");
      assert.ok(capturedPrompt.includes("no confident match -- two similar buttons"));
      assert.ok(capturedPrompt.includes("resolved but the click did nothing"));
      assert.ok(!capturedPrompt.includes("unrelated failure"), "a different instruction's failure must not leak into this prompt");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's prompt has no past-failure note when the log has no history for this instruction", async () => {
    let capturedPrompt;
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      capturedPrompt = prompt;
      return { ref: 3 };
    });
    try {
      await semanticAct.resolveSemanticAction(ANDROID_LOGIN_SCREEN, "tap a never-before-seen instruction with no log history");
      assert.ok(!capturedPrompt.includes("past run(s)"), "no history should mean no note, not an empty/awkward one");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction excludes a resource-id already proven dead for this exact instruction on a PRIOR run (cross-run negative caching)", async () => {
    // Simulates a final, never-healed "No visible change." record from
    // a past run -- see getDeadSelectors()'s doc comment: this is the
    // "no better candidate was ever found" case, so the run's own
    // selector IS the dead end.
    logExecution({
      instruction: "tap the Add-ons card",
      kind: "tap",
      success: true,
      diffSummary: "No visible change.",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
    });

    const DEAD_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
    <android.widget.Button resource-id="com.testopsmobile.demo:id/other_button" text="Other" bounds="[100,700][980,800]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 2 }; // the only remaining candidate, "Other"
    });
    try {
      const result = await semanticAct.resolveSemanticAction(DEAD_BUTTON_SCREEN, "tap the Add-ons card", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      // Excluded from the prompt text entirely -- the model never even sees it as an option.
      assert.ok(!calls[0].includes("Log In"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction excludes a HEALED self-heal's original dead selector (deadSelector), not its working replacement (selector)", async () => {
    logExecution({
      instruction: "tap the Add-ons card",
      kind: "tap",
      success: true,
      selfHealedNoOp: true,
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/other_button" }, // the HEALED, working selector -- must stay offered
      deadSelector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" }, // the ORIGINAL dead end -- must be excluded
    });

    const DEAD_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
    <android.widget.Button resource-id="com.testopsmobile.demo:id/other_button" text="Other" bounds="[100,700][980,800]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 2 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(DEAD_BUTTON_SCREEN, "tap the Add-ons card", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      assert.ok(!calls[0].includes("Log In"), "the dead selector's own element should be excluded from the prompt");
      assert.ok(calls[0].includes("Other"), "the healed selector's replacement must still be offered, never confused with the dead one");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's cross-run dead-selector exclusion is scoped to kind \"tap\" only -- a \"type\" resolution still offers the same element", async () => {
    logExecution({
      instruction: "focus the comment field",
      kind: "tap",
      success: true,
      diffSummary: "No visible change.",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
    });

    const ONE_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.EditText resource-id="com.testopsmobile.demo:id/login_button" text="" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(ONE_BUTTON_SCREEN, "focus the comment field", { kind: "type" });
      assert.strictEqual(result.resolved, true, "a dead TAP result must not exclude the same element from a different kind of action");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's cross-run dead-selector exclusion never crosses instructions", async () => {
    logExecution({
      instruction: "tap the Add-ons card",
      kind: "tap",
      success: true,
      diffSummary: "No visible change.",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
    });

    const DEAD_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(DEAD_BUTTON_SCREEN, "tap an unrelated different instruction", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      assert.ok(calls[0].includes("Log In"), "a dead selector recorded for a DIFFERENT instruction must never exclude anything here");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction excludes a selector already proven to be a \"wrong but functional click\" (expectFailed) for this exact instruction on a PRIOR run", async () => {
    // Simulates engine/test-case-runner.js's own expectFailed record: a
    // tap that produced a REAL diff (not "No visible change.") but
    // whose step's declared `expect` never held, even after the
    // outcome-settle retry -- the parallel case to the dead-selector
    // tests above, see getExpectFailedSelectors()'s doc comment.
    logExecution({
      instruction: "tap the Profile tab",
      kind: "tap",
      success: true,
      diffSummary: "Appeared: \"Add-On Details\".",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
      expectFailed: true,
    });

    const WRONG_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
    <android.widget.Button resource-id="com.testopsmobile.demo:id/other_button" text="Other" bounds="[100,700][980,800]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 2 }; // the only remaining candidate, "Other"
    });
    try {
      const result = await semanticAct.resolveSemanticAction(WRONG_BUTTON_SCREEN, "tap the Profile tab", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      // Excluded from the prompt text entirely -- the model never even sees it as an option.
      assert.ok(!calls[0].includes("Log In"));
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's cross-run expect-failed exclusion is scoped to kind \"tap\" only -- a \"type\" resolution still offers the same element", async () => {
    logExecution({
      instruction: "focus the comment field 2",
      kind: "tap",
      success: true,
      diffSummary: "Appeared: \"X\".",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
      expectFailed: true,
    });

    const ONE_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.EditText resource-id="com.testopsmobile.demo:id/login_button" text="" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(ONE_BUTTON_SCREEN, "focus the comment field 2", { kind: "type" });
      assert.strictEqual(result.resolved, true, "an expect-failed TAP result must not exclude the same element from a different kind of action");
    } finally {
      restore();
    }
  });

  await test("resolveSemanticAction's cross-run expect-failed exclusion never crosses instructions", async () => {
    logExecution({
      instruction: "tap the Add-ons card 2",
      kind: "tap",
      success: true,
      diffSummary: "Appeared: \"X\".",
      selector: { strategy: "resource-id", value: "com.testopsmobile.demo:id/login_button" },
      expectFailed: true,
    });

    const WRONG_BUTTON_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout>
    <android.widget.Button resource-id="com.testopsmobile.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
  </android.widget.FrameLayout>
</hierarchy>`;
    const calls = [];
    const { semanticAct, restore } = loadWithFakeOllama(async (prompt) => {
      calls.push(prompt);
      return { ref: 1 };
    });
    try {
      const result = await semanticAct.resolveSemanticAction(WRONG_BUTTON_SCREEN, "tap a second unrelated different instruction", { kind: "tap" });
      assert.strictEqual(result.resolved, true);
      assert.ok(calls[0].includes("Log In"), "an expect-failed selector recorded for a DIFFERENT instruction must never exclude anything here");
    } finally {
      restore();
    }
  });

  if (process.exitCode) {
    console.error("\ngeneration/semantic-act tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-act tests passed");
  }
})();
