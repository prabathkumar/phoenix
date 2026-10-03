/**
 * Tests for generation/webview-act.js -- the WebView counterpart to
 * semantic-act.js's resolveSemanticAction(). Fakes generation/llm.js's
 * callOllamaJson() via require.cache injection, same technique
 * generation/test/semantic-act.test.js already uses, so these run
 * without a real Ollama instance or a real WebView.
 *
 * Run with: npm test (from generation/) or `node test/webview-act.test.js`
 */

const assert = require("assert");

const llmPath = require.resolve("../llm");
const webviewActPath = require.resolve("../webview-act");

function loadWithFakeOllama(fakeCallOllamaJson) {
  delete require.cache[llmPath];
  delete require.cache[webviewActPath];
  const realLlm = require(llmPath);
  require.cache[llmPath].exports = { ...realLlm, callOllamaJson: fakeCallOllamaJson };
  const webviewAct = require(webviewActPath);
  return {
    webviewAct,
    restore: () => {
      delete require.cache[llmPath];
      delete require.cache[webviewActPath];
    },
  };
}

const DOM_ELEMENTS = [
  { tag: "button", text: "Log In", id: "login-btn" },
  { tag: "input", type: "text", name: "phone", placeholder: "Phone number" },
];

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
  console.log("generation/webview-act:");

  await test("resolveWebviewAction resolves a confident ref match to a css selector", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => ({ ref: 0 }));
    try {
      const result = await webviewAct.resolveWebviewAction(DOM_ELEMENTS, "tap the Log In button");
      assert.strictEqual(result.resolved, true);
      assert.deepStrictEqual(result.selector, { strategy: "css", value: "#login-btn" });
    } finally {
      restore();
    }
  });

  await test("resolveWebviewAction stays unresolved when the model declines (ref: null)", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => ({ ref: null, reason: "no element matches" }));
    try {
      const result = await webviewAct.resolveWebviewAction(DOM_ELEMENTS, "tap the Sign Up button");
      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.reason, "no element matches");
    } finally {
      restore();
    }
  });

  await test("resolveWebviewAction declines rather than guesses a selector when the matched element has no id/name/aria-label/placeholder", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => ({ ref: 0 }));
    try {
      const result = await webviewAct.resolveWebviewAction([{ tag: "div", text: "just a label" }], "tap the label");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("no stable id/name/aria-label/placeholder"));
    } finally {
      restore();
    }
  });

  await test("resolveWebviewAction returns unresolved (never throws) when there are no interactive elements at all", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => {
      throw new Error("should never be called with an empty snapshot");
    });
    try {
      const result = await webviewAct.resolveWebviewAction([], "tap anything");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("no interactive elements"));
    } finally {
      restore();
    }
  });

  await test("resolveWebviewAction stays unresolved (never throws) when Ollama itself fails", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    try {
      const result = await webviewAct.resolveWebviewAction(DOM_ELEMENTS, "tap the Log In button");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("ECONNREFUSED"));
    } finally {
      restore();
    }
  });

  await test("resolveWebviewAction treats a hallucinated ref (not in the snapshot) as unresolved", async () => {
    const { webviewAct, restore } = loadWithFakeOllama(async () => ({ ref: 99 }));
    try {
      const result = await webviewAct.resolveWebviewAction(DOM_ELEMENTS, "tap the Log In button");
      assert.strictEqual(result.resolved, false);
      assert.ok(result.reason.includes("ref 99"));
    } finally {
      restore();
    }
  });
})();
