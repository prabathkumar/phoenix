/**
 * Tests for generation/webview-snapshot.js -- the WebView-side
 * counterpart to semantic-snapshot.js. No real browser/WebView: these
 * tests feed already-"collected" element arrays (exactly the shape
 * SERIALIZE_DOM_SCRIPT would return from a real page) straight into
 * buildWebviewSnapshot()/webviewSnapshotToText()/buildCssSelector().
 *
 * Run with: npm test (from generation/) or `node test/webview-snapshot.test.js`
 */

const assert = require("assert");
const { buildWebviewSnapshot, webviewSnapshotToText, findByRef, buildCssSelector } = require("../webview-snapshot");

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
  console.log("generation/webview-snapshot:");

  await test("buildWebviewSnapshot assigns sequential refs and keeps known fields", async () => {
    const snapshot = buildWebviewSnapshot([
      { tag: "button", text: "Log In", id: "login-btn" },
      { tag: "input", type: "text", name: "phone", placeholder: "Phone number" },
    ]);
    assert.strictEqual(snapshot.length, 2);
    assert.strictEqual(snapshot[0].ref, 0);
    assert.strictEqual(snapshot[0].id, "login-btn");
    assert.strictEqual(snapshot[1].ref, 1);
    assert.strictEqual(snapshot[1].placeholder, "Phone number");
  });

  await test("buildWebviewSnapshot returns [] for non-array/missing input rather than throwing", async () => {
    assert.deepStrictEqual(buildWebviewSnapshot(undefined), []);
    assert.deepStrictEqual(buildWebviewSnapshot(null), []);
    assert.deepStrictEqual(buildWebviewSnapshot("not an array"), []);
  });

  await test("buildWebviewSnapshot defaults a missing tag to 'div' rather than crashing on it later", async () => {
    const snapshot = buildWebviewSnapshot([{ text: "mystery element" }]);
    assert.strictEqual(snapshot[0].tag, "div");
  });

  await test("webviewSnapshotToText renders ref, role/tag, label, and identifiers for each element", async () => {
    const snapshot = buildWebviewSnapshot([
      { tag: "button", role: "button", text: "Log In", id: "login-btn" },
    ]);
    const text = webviewSnapshotToText(snapshot);
    assert.ok(text.includes("[0]"));
    assert.ok(text.includes("Log In"));
    assert.ok(text.includes("id: login-btn"));
  });

  await test("findByRef returns the matching element, or null when the ref doesn't exist", async () => {
    const snapshot = buildWebviewSnapshot([{ tag: "a", text: "Home" }]);
    assert.strictEqual(findByRef(snapshot, 0).text, "Home");
    assert.strictEqual(findByRef(snapshot, 99), null);
  });

  await test("buildCssSelector prefers id, then name, then aria-label, then placeholder, in that order", async () => {
    assert.strictEqual(buildCssSelector({ tag: "button", id: "a", name: "b", ariaLabel: "c", placeholder: "d" }), "#a");
    assert.strictEqual(buildCssSelector({ tag: "input", name: "b", ariaLabel: "c", placeholder: "d" }), 'input[name="b"]');
    assert.strictEqual(buildCssSelector({ tag: "button", ariaLabel: "c", placeholder: "d" }), 'button[aria-label="c"]');
    assert.strictEqual(buildCssSelector({ tag: "input", placeholder: "d" }), 'input[placeholder="d"]');
  });

  await test("buildCssSelector returns null (not a guessed path) when an element has none of id/name/aria-label/placeholder", async () => {
    assert.strictEqual(buildCssSelector({ tag: "div", text: "just some text" }), null);
  });

  await test("buildCssSelector returns null for a null/undefined element rather than throwing", async () => {
    assert.strictEqual(buildCssSelector(null), null);
    assert.strictEqual(buildCssSelector(undefined), null);
  });

  await test("buildCssSelector escapes a double quote in an attribute value so the selector string stays valid", async () => {
    const selector = buildCssSelector({ tag: "button", ariaLabel: 'Say "hi"' });
    assert.strictEqual(selector, 'button[aria-label="Say \\"hi\\""]');
  });
})();
