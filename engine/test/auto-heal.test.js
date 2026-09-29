/**
 * Tests for engine/auto-heal.js -- falling back to the semantic layer
 * when a recorded/original locator stops resolving, the fusion of Act 1
 * (guided scripts) and Act 2 (semantic resolution) requested explicitly
 * ("include auto heal as well"). Fakes generation/semantic-act's
 * resolveSemanticAction and generation/pipeline's buildSelector via
 * require.cache injection (same technique used throughout this layer's
 * tests), with a minimal in-memory fake driver/element.
 *
 * Run with: npm test (from engine/) or `node test/auto-heal.test.js`
 */

const assert = require("assert");

const AUTO_HEAL_PATH = require.resolve("../auto-heal");
const SEMANTIC_ACT_PATH = require.resolve("../../generation/semantic-act");
const PIPELINE_PATH = require.resolve("../../generation/pipeline");

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function freshAutoHealWithFakes({ resolveSemanticActionImpl, buildSelectorImpl } = {}) {
  for (const p of [AUTO_HEAL_PATH, SEMANTIC_ACT_PATH, PIPELINE_PATH]) delete require.cache[p];

  const realPipeline = require(PIPELINE_PATH);

  require.cache[SEMANTIC_ACT_PATH] = {
    id: SEMANTIC_ACT_PATH,
    filename: SEMANTIC_ACT_PATH,
    loaded: true,
    exports: { resolveSemanticAction: resolveSemanticActionImpl || (async () => ({ resolved: false, reason: "not configured" })) },
  };

  require.cache[PIPELINE_PATH] = {
    id: PIPELINE_PATH,
    filename: PIPELINE_PATH,
    loaded: true,
    exports: { ...realPipeline, buildSelector: buildSelectorImpl || realPipeline.buildSelector },
  };

  const autoHeal = require(AUTO_HEAL_PATH);
  return {
    autoHeal,
    restore: () => {
      for (const p of [AUTO_HEAL_PATH, SEMANTIC_ACT_PATH, PIPELINE_PATH]) delete require.cache[p];
    },
  };
}

/** A fake driver whose `$()` returns elements keyed by the exact selector string requested. */
function makeFakeDriver(elementsBySelector, { throwOnSelector, getPageSourceImpl } = {}) {
  return {
    getPageSource: getPageSourceImpl || (async () => "<hierarchy><Button text=\"Log In\" resource-id=\"login_button_v2\" /></hierarchy>"),
    $: async (selectorString) => {
      if (throwOnSelector && selectorString === throwOnSelector) {
        throw new Error(`invalid selector: ${selectorString}`);
      }
      const exists = Boolean(elementsBySelector[selectorString]);
      return {
        isExisting: async () => exists,
        marker: selectorString,
      };
    },
  };
}

(async () => {
  console.log("engine/auto-heal:");

  await run("returns the original element unhealed when the original selector resolves", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes();
    try {
      const driver = makeFakeDriver({ '~loginButton': true });
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton", description: "the Login button" });
      assert.strictEqual(result.healed, false);
      assert.strictEqual(result.element.marker, "~loginButton");
    } finally {
      restore();
    }
  });

  await run("heals via the semantic layer when the original selector doesn't resolve", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "Button", label: "Log In", resourceId: "login_button_v2" },
        selector: { strategy: "resource-id", value: "login_button_v2" },
      }),
    });
    try {
      const driver = makeFakeDriver({
        '~loginButton': false, // stale, recorded before a resource-id was added
        'android=new UiSelector().resourceId("login_button_v2")': true,
      });
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton", description: "the Login button" });
      assert.strictEqual(result.healed, true);
      assert.deepStrictEqual(result.healedSelector, { strategy: "resource-id", value: "login_button_v2" });
      assert.ok(result.element);
    } finally {
      restore();
    }
  });

  await run("reports unhealed with the original reason when no description is given to heal from", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes();
    try {
      const driver = makeFakeDriver({ "~loginButton": false });
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton" });
      assert.strictEqual(result.element, null);
      assert.strictEqual(result.healed, false);
      assert.ok(result.reason.includes("no description was given"));
    } finally {
      restore();
    }
  });

  await run("reports unhealed, preserving context, when semantic resolution also fails to find a match", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: false, reason: "no element matches 'the Login button'" }),
    });
    try {
      const driver = makeFakeDriver({ "~loginButton": false });
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton", description: "the Login button" });
      assert.strictEqual(result.element, null);
      assert.strictEqual(result.healed, false);
      assert.ok(result.reason.includes("~loginButton"));
      assert.ok(result.reason.includes("no element matches"));
    } finally {
      restore();
    }
  });

  await run("reports unhealed when the healed selector itself isn't actually on screen", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "Button", label: "Log In" },
        selector: { strategy: "text", value: "Log In" },
      }),
    });
    try {
      // Neither the original nor the "healed" selector actually exists
      // in this fake driver -- simulates the resolved match vanishing
      // between resolution and lookup.
      const driver = makeFakeDriver({ "~loginButton": false });
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton", description: "the Login button" });
      assert.strictEqual(result.element, null);
      assert.strictEqual(result.healed, false);
      assert.ok(result.reason.includes("also isn't on screen"));
    } finally {
      restore();
    }
  });

  await run("attempts healing (rather than propagating) when the original selector throws instead of just missing", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "Button", label: "Log In" },
        selector: { strategy: "text", value: "Log In" },
      }),
    });
    try {
      const driver = makeFakeDriver(
        { 'android=new UiSelector().text("Log In")': true },
        { throwOnSelector: "((broken xpath" }
      );
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "((broken xpath", description: "the Login button" });
      assert.strictEqual(result.healed, true);
    } finally {
      restore();
    }
  });

  await run("returns unhealed immediately when no selector is given at all", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes();
    try {
      const result = await autoHeal.resolveElementWithHealing(makeFakeDriver({}), { description: "the Login button" });
      assert.strictEqual(result.element, null);
      assert.ok(result.reason.includes("no selector given"));
    } finally {
      restore();
    }
  });

  await run("reports unhealed (never throws) when the screen can't be read to attempt healing", async () => {
    const { autoHeal, restore } = freshAutoHealWithFakes();
    try {
      const driver = makeFakeDriver(
        { "~loginButton": false },
        { getPageSourceImpl: async () => { throw new Error("session terminated"); } }
      );
      const result = await autoHeal.resolveElementWithHealing(driver, { selector: "~loginButton", description: "the Login button" });
      assert.strictEqual(result.element, null);
      assert.ok(result.reason.includes("session terminated"));
    } finally {
      restore();
    }
  });

  if (process.exitCode) {
    console.error("\nengine/auto-heal tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/auto-heal tests passed");
  }
})();
