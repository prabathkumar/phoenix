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

const ANDROID_LOGIN_SCREEN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,2400]">
    <android.widget.TextView text="Login" bounds="[42,166][305,237]" />
    <android.widget.EditText resource-id="com.phoenix.demo:id/username_input" text="" bounds="[100,300][980,400]" />
    <android.widget.Button resource-id="com.phoenix.demo:id/login_button" text="Log In" bounds="[100,560][980,660]" />
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
      assert.deepStrictEqual(result.selector, { strategy: "resource-id", value: "com.phoenix.demo:id/login_button" });
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

  if (process.exitCode) {
    console.error("\ngeneration/semantic-act tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/semantic-act tests passed");
  }
})();
