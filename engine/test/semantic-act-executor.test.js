/**
 * Tests for semantic-act-executor.js — the piece that wires
 * generation/semantic-act.js's resolution up to a live Appium session
 * (see the module's own header for why this is the first Phase 2 piece
 * that touches a real `driver`). No real Appium/BrowserStack session:
 * generation/semantic-act, generation/semantic-diff, and
 * generation/pipeline are faked via require.cache injection (the same
 * technique engine/test/session-manager.test.js uses), and the
 * "driver" is a small in-memory fake exposing just the WebdriverIO
 * surface this module calls (getPageSource, $, click, setValue,
 * isExisting).
 *
 * Run with: npm test (from engine/) or `node test/semantic-act-executor.test.js`
 */

// actAndDiff's real-timer settle delay (DEFAULT_ACT_SETTLE_DELAY_MS,
// added after a real timing-race bug on a live BrowserStack run -- see
// its comment in ../semantic-act-executor.js) defaults to a real
// setTimeout, which would otherwise add ~800ms to every "tap" test in
// this file for no reason: the fake driver below has no real screen
// transition to wait for. Disabled here the same way the real engine
// can disable it (PHOENIX_ACT_SETTLE_MS=0), not by special-casing
// tests in the production code path.
process.env.PHOENIX_ACT_SETTLE_MS = "0";

const assert = require("assert");

const EXECUTOR_PATH = require.resolve("../semantic-act-executor");
const SEMANTIC_ACT_PATH = require.resolve("../../generation/semantic-act");
const SEMANTIC_DIFF_PATH = require.resolve("../../generation/semantic-diff");
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

/**
 * Loads a fresh semantic-act-executor with its three generation/
 * dependencies faked out, returning it plus a restore() to undo the
 * require.cache swap.
 */
function freshExecutorWithFakes({ resolveSemanticActionImpl, diffSnapshotsImpl, buildSelectorImpl } = {}) {
  for (const p of [EXECUTOR_PATH, SEMANTIC_ACT_PATH, SEMANTIC_DIFF_PATH, PIPELINE_PATH]) {
    delete require.cache[p];
  }

  const realPipeline = require(PIPELINE_PATH);

  require.cache[SEMANTIC_ACT_PATH] = {
    id: SEMANTIC_ACT_PATH,
    filename: SEMANTIC_ACT_PATH,
    loaded: true,
    exports: {
      resolveSemanticAction: resolveSemanticActionImpl || (async () => ({ resolved: false, reason: "not configured" })),
    },
  };

  require.cache[SEMANTIC_DIFF_PATH] = {
    id: SEMANTIC_DIFF_PATH,
    filename: SEMANTIC_DIFF_PATH,
    loaded: true,
    exports: {
      diffSnapshots: diffSnapshotsImpl || (() => ({ appeared: [], disappeared: [], changed: false })),
      diffToText: (diff) => (diff.changed ? "changed" : "No visible change."),
    },
  };

  require.cache[PIPELINE_PATH] = {
    id: PIPELINE_PATH,
    filename: PIPELINE_PATH,
    loaded: true,
    exports: { ...realPipeline, buildSelector: buildSelectorImpl || realPipeline.buildSelector },
  };

  const executor = require(EXECUTOR_PATH);
  return {
    executor,
    restore: () => {
      for (const p of [EXECUTOR_PATH, SEMANTIC_ACT_PATH, SEMANTIC_DIFF_PATH, PIPELINE_PATH]) {
        delete require.cache[p];
      }
    },
  };
}

/** A minimal fake WebdriverIO-shaped driver + element. */
function makeFakeDriver({ pageSources, elementBehavior = {}, takeScreenshotImpl, executeImpl, getWindowSizeImpl, elementBehaviorForSelector } = {}) {
  let pageSourceCallCount = 0;
  const calls = { click: 0, setValue: [], takeScreenshot: 0, execute: [], selectorsQueried: [] };

  function makeElement(behavior) {
    return {
      isExisting: behavior.isExisting || (async () => true),
      click: async () => {
        calls.click += 1;
        if (behavior.clickThrows) throw new Error(behavior.clickThrows);
      },
      setValue: async (text) => {
        calls.setValue.push(text);
      },
    };
  }

  const element = makeElement(elementBehavior);

  return {
    calls,
    driver: {
      getPageSource: async () => {
        const value = pageSources[Math.min(pageSourceCallCount, pageSources.length - 1)];
        pageSourceCallCount += 1;
        if (value instanceof Error) throw value;
        return value;
      },
      $: async (selectorString) => {
        calls.selectorsQueried.push(selectorString);
        if (elementBehaviorForSelector) {
          return makeElement(elementBehaviorForSelector(selectorString) || {});
        }
        return element;
      },
      takeScreenshot: async () => {
        calls.takeScreenshot += 1;
        if (takeScreenshotImpl) return takeScreenshotImpl();
        return "fake-base64-screenshot";
      },
      execute: async (command, params) => {
        calls.execute.push({ command, params });
        if (executeImpl) return executeImpl(command, params);
        return null;
      },
      getWindowSize: async () => {
        if (getWindowSizeImpl) return getWindowSizeImpl();
        return { width: 1080, height: 2200 };
      },
    },
  };
}

(async () => {
  console.log("engine/semantic-act-executor:");

  await run("executeSemanticAction taps the resolved element and reports the diff on success", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 3, role: "Button", label: "Log In", resourceId: "com.phoenix.demo:id/login_button" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/login_button" },
      }),
      diffSnapshotsImpl: () => ({ appeared: [{ label: "Welcome" }], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the Login button");

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.click, 1);
      assert.deepStrictEqual(result.selector, { strategy: "resource-id", value: "com.phoenix.demo:id/login_button" });
      assert.strictEqual(result.diffSummary, "changed");
      assert.deepStrictEqual(result.assertions, [{ label: "Welcome", resourceId: undefined }]);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction types text instead of tapping when kind is \"type\"", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText", resourceId: "com.phoenix.demo:id/username_input" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/username_input" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "type into the username field", { kind: "type", text: "prabath@example.com" });

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.click, 0);
      assert.deepStrictEqual(calls.setValue, ["prabath@example.com"]);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction fails cleanly (never throws) when kind is \"type\" but no text is given", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "type something", { kind: "type" });
      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("text"));
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction rejects an unsupported action kind without calling anything downstream", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "swipe up", { kind: "swipe" });
      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("swipe"));
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction scrolls (android) via mobile: scrollGesture, with no element resolution involved, and reports the diff", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => {
        throw new Error("resolveSemanticAction should never be called for a scroll step");
      },
      diffSnapshotsImpl: () => ({ appeared: [{ label: "Logout" }], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "scroll down to find the Logout button", { kind: "scroll" });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.diffSummary, "changed");
      assert.strictEqual(calls.click, 0);
      assert.strictEqual(calls.execute.length, 1);
      assert.strictEqual(calls.execute[0].command, "mobile: scrollGesture");
      assert.strictEqual(calls.execute[0].params.direction, "down");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction scrolls (ios) via mobile: scroll", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "scroll up", { kind: "scroll", direction: "up", platform: "ios" });

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.execute.length, 1);
      assert.strictEqual(calls.execute[0].command, "mobile: scroll");
      assert.strictEqual(calls.execute[0].params.direction, "up");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction reports a scroll gesture failure cleanly instead of throwing", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy />"],
        executeImpl: () => {
          throw new Error("driver disconnected");
        },
      });
      const result = await executor.executeSemanticAction(driver, "scroll down", { kind: "scroll" });

      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("scroll"));
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction falls back to default viewport dimensions when getWindowSize() fails", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver, calls } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"],
        getWindowSizeImpl: () => {
          throw new Error("not supported by this driver");
        },
      });
      const result = await executor.executeSemanticAction(driver, "scroll down", { kind: "scroll" });

      assert.strictEqual(result.success, true);
      assert.ok(calls.execute[0].params.width > 0);
      assert.ok(calls.execute[0].params.height > 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction tries a cachedSelector first and never calls resolveSemanticAction when it hits (the self-healing replay path)", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => {
        throw new Error("resolveSemanticAction should never be called when the cached selector resolves");
      },
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the Login button", {
        cachedSelector: { strategy: "accessibility-id", value: "Login" },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.usedCache, true);
      assert.deepStrictEqual(result.selector, { strategy: "accessibility-id", value: "Login" });
      assert.strictEqual(calls.click, 1);
      assert.deepStrictEqual(calls.selectorsQueried, ["~Login"]);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction falls back to full semantic resolution when the cachedSelector is stale (self-healing), and flags the result as healed", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        selector: { strategy: "accessibility-id", value: "Login-v2" },
      }),
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"],
        elementBehaviorForSelector: (selectorString) =>
          selectorString === "~Login-stale" ? { isExisting: async () => false } : { isExisting: async () => true },
      });
      const result = await executor.executeSemanticAction(driver, "tap the Login button", {
        cachedSelector: { strategy: "accessibility-id", value: "Login-stale" },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.usedCache, undefined);
      assert.strictEqual(result.healedFromCache, true);
      assert.deepStrictEqual(result.selector, { strategy: "accessibility-id", value: "Login-v2" });
      assert.deepStrictEqual(calls.selectorsQueried, ["~Login-stale", "~Login-v2"]);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction does not set healedFromCache when there was no cachedSelector to begin with", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, selector: { strategy: "accessibility-id", value: "Login" } }),
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: true }),
    });
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the Login button");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.healedFromCache, false);
      assert.strictEqual(result.usedCache, undefined);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's beforeAct veto also applies to a cachedSelector attempt, before anything is clicked", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "tap the Login button", {
        cachedSelector: { strategy: "accessibility-id", value: "Login" },
        beforeAct: () => "vetoed by caller",
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "vetoed by caller");
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run('executeSemanticAction kind "tapIfExists" taps and diffs when the exact selector exists, never calling resolveSemanticAction', async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => {
        throw new Error('resolveSemanticAction should never be called for kind "tapIfExists"');
      },
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap More Close if the More menu overlay is open", {
        kind: "tapIfExists",
        exactSelector: { strategy: "accessibility-id", value: "More Close" },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.skipped, undefined);
      assert.deepStrictEqual(result.selector, { strategy: "accessibility-id", value: "More Close" });
      assert.strictEqual(calls.click, 1);
      // Queried twice: once for the existence check, once inside
      // actAndDiff's own (separate) element lookup before acting.
      assert.deepStrictEqual(calls.selectorsQueried, ["~More Close", "~More Close"]);
    } finally {
      restore();
    }
  });

  await run('executeSemanticAction kind "tapIfExists" skips cleanly (still success: true) when the exact selector is not present -- never falls back to guessing', async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => {
        throw new Error('resolveSemanticAction should never be called for kind "tapIfExists", not even on a miss');
      },
    });
    try {
      const { driver, calls } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>"],
        elementBehavior: { isExisting: async () => false },
      });
      const result = await executor.executeSemanticAction(driver, "tap More Close if the More menu overlay is open", {
        kind: "tapIfExists",
        exactSelector: { strategy: "accessibility-id", value: "More Close" },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run('executeSemanticAction kind "tapIfExists" fails clearly (an authoring error) when exactSelector is missing', async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "tap something conditionally", { kind: "tapIfExists" });

      assert.strictEqual(result.success, false);
      assert.ok(/requires options.exactSelector/.test(result.reason));
    } finally {
      restore();
    }
  });

  await run('executeSemanticAction kind "tapIfExists" honors beforeAct veto before clicking', async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "tap More Close", {
        kind: "tapIfExists",
        exactSelector: { strategy: "accessibility-id", value: "More Close" },
        beforeAct: () => "vetoed by caller",
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "vetoed by caller");
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction passes through resolveSemanticAction's unresolved reason unchanged", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: false, reason: "no element matches 'the checkout button'" }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "tap the checkout button");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "no element matches 'the checkout button'");
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction reports failure, not a thrown error, when getPageSource fails up front", async () => {
    const { executor, restore } = freshExecutorWithFakes();
    try {
      const { driver } = makeFakeDriver({ pageSources: [new Error("session terminated")] });
      const result = await executor.executeSemanticAction(driver, "tap anything");
      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("session terminated"));
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction refuses to act on a resolved element that vanished before the click", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 2, role: "Button", label: "OK" },
        selector: { strategy: "text", value: "OK" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>"],
        elementBehavior: { isExisting: async () => false },
      });
      const result = await executor.executeSemanticAction(driver, "tap OK");
      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("no longer on screen"));
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction reports failure when the click itself throws", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 2, role: "Button", label: "OK" },
        selector: { strategy: "text", value: "OK" },
      }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>"],
        elementBehavior: { clickThrows: "stale element reference" },
      });
      const result = await executor.executeSemanticAction(driver, "tap OK");
      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("stale element reference"));
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction captures a screenshot and passes it to resolveSemanticAction when useVisualGrounding is set", async () => {
    const resolveCalls = [];
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSource, instruction, options) => {
        resolveCalls.push({ pageSource, instruction, options });
        return {
          resolved: true,
          element: { ref: 1, role: "Button", label: "Log In" },
          selector: { strategy: "text", value: "Log In" },
        };
      },
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the Login button", { useVisualGrounding: true });

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.takeScreenshot, 1);
      assert.deepStrictEqual(resolveCalls[0].options, { screenshotBase64: "fake-base64-screenshot", kind: "tap" });
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction does not capture a screenshot when useVisualGrounding is left off", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "Button", label: "Log In" },
        selector: { strategy: "text", value: "Log In" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      await executor.executeSemanticAction(driver, "tap the Login button");
      assert.strictEqual(calls.takeScreenshot, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction falls back to text-only resolution when the screenshot capture itself fails", async () => {
    const resolveCalls = [];
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSource, instruction, options) => {
        resolveCalls.push({ options });
        return {
          resolved: true,
          element: { ref: 1, role: "Button", label: "Log In" },
          selector: { strategy: "text", value: "Log In" },
        };
      },
      // Not testing the diff here, just the screenshot-failure fallback
      // -- forced to "changed" so this doesn't also trip the no-op
      // self-heal retry (the real diffSnapshots would call these plain
      // placeholder page sources "No visible change.", which is a
      // separate, dedicated test below).
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"],
        takeScreenshotImpl: () => {
          throw new Error("screenshot not supported on this device");
        },
      });
      const result = await executor.executeSemanticAction(driver, "tap the Login button", { useVisualGrounding: true });

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.click, 1);
      // Resolution still happened, just without a screenshot.
      assert.deepStrictEqual(resolveCalls[0].options, { screenshotBase64: undefined, kind: "tap" });
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction still reports success when the post-action getPageSource read fails", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 2, role: "Button", label: "OK" },
        selector: { strategy: "text", value: "OK" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", new Error("app crashed")] });
      const result = await executor.executeSemanticAction(driver, "tap OK");
      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.click, 1);
      assert.strictEqual(result.diff, undefined);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction calls options.beforeAct with the resolved selector/kind/text before acting", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText", resourceId: "com.phoenix.demo:id/edtCommon" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/edtCommon" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"] });
      let seen;
      const result = await executor.executeSemanticAction(driver, "type the password", {
        kind: "type",
        text: "hunter2",
        beforeAct: (info) => {
          seen = info;
          return undefined;
        },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.setValue.length, 1);
      assert.deepStrictEqual(seen.selector, { strategy: "resource-id", value: "com.phoenix.demo:id/edtCommon" });
      assert.strictEqual(seen.kind, "type");
      assert.strictEqual(seen.text, "hunter2");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction fails without acting when options.beforeAct vetoes the resolution", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText", resourceId: "com.phoenix.demo:id/edtCommon" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/edtCommon" },
      }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "type the password", {
        kind: "type",
        text: "hunter2",
        beforeAct: () => "refusing to overwrite a field a previous step already set",
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "refusing to overwrite a field a previous step already set");
      assert.strictEqual(calls.setValue.length, 0);
      assert.strictEqual(calls.click, 0);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction self-heals a \"No visible change\" tap by retrying once with the dead element excluded", async () => {
    const resolveCalls = [];
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSource, instruction, options) => {
        resolveCalls.push(options.excludedRefs);
        if (!options.excludedRefs) {
          // First attempt: a confident but dead-end pick.
          return { resolved: true, element: { ref: 1, role: "View", label: "Dead End" }, selector: { strategy: "text", value: "Dead End" } };
        }
        // Retry: a different, real candidate.
        return { resolved: true, element: { ref: 2, role: "Button", label: "Real Button" }, selector: { strategy: "text", value: "Real Button" } };
      },
      diffSnapshotsImpl: (() => {
        let call = 0;
        return () => {
          call += 1;
          return call === 1 ? { appeared: [], disappeared: [], changed: false } : { appeared: [{ label: "Success" }], disappeared: [], changed: true };
        };
      })(),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the button");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.selfHealedNoOp, true);
      assert.deepStrictEqual(result.selector, { strategy: "text", value: "Real Button" });
      // The ORIGINAL dead-end selector, kept separately so
      // generation/execution-log.js can log it for cross-run negative
      // caching (getDeadSelectors()) -- must never be confused with
      // `selector` above, which is now the healed, working one.
      assert.deepStrictEqual(result.deadSelector, { strategy: "text", value: "Dead End" });
      assert.strictEqual(result.diffSummary, "changed");
      assert.strictEqual(calls.click, 2);
      // First call excludes nothing; the retry excludes the dead element's ref.
      assert.deepStrictEqual(resolveCalls, [undefined, [1]]);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction reports the original \"No visible change\" outcome when self-heal finds no better alternative", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSource, instruction, options) => {
        if (!options.excludedRefs) {
          return { resolved: true, element: { ref: 1, role: "View", label: "Dead End" }, selector: { strategy: "text", value: "Dead End" } };
        }
        // Retry: nothing else on screen is a confident match either.
        return { resolved: false, reason: "no other confident match" };
      },
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: false }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the button");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.selfHealedNoOp, undefined);
      assert.deepStrictEqual(result.selector, { strategy: "text", value: "Dead End" });
      // No separate deadSelector here -- this IS the dead end (nothing
      // healthier was ever found), so getDeadSelectors() reads it from
      // `selector` itself (its "final, never-healed" case), not a
      // distinct field.
      assert.strictEqual(result.deadSelector, undefined);
      assert.strictEqual(result.diffSummary, "No visible change.");
      // Only the original attempt clicked -- the failed retry resolution never got to act.
      assert.strictEqual(calls.click, 1);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's self-heal retry also honors beforeAct, without double-reporting the original outcome as healed", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSource, instruction, options) => {
        if (!options.excludedRefs) {
          return { resolved: true, element: { ref: 1, role: "View", label: "Dead End" }, selector: { strategy: "text", value: "Dead End" } };
        }
        return { resolved: true, element: { ref: 2, role: "Button", label: "Real Button" }, selector: { strategy: "text", value: "Real Button" } };
      },
      diffSnapshotsImpl: () => ({ appeared: [], disappeared: [], changed: false }),
    });
    try {
      const { driver, calls } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "tap the button", {
        beforeAct: (attempt) => (attempt.selector.value === "Real Button" ? "refusing the retry candidate" : undefined),
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.selfHealedNoOp, undefined);
      assert.deepStrictEqual(result.selector, { strategy: "text", value: "Dead End" });
      // The original tap clicked; the vetoed retry never did.
      assert.strictEqual(calls.click, 1);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction pauses (actSettleMs) before reading the post-tap page source, but not after a type (real bug: Add-ons-tap's outcome-verification read the screen while a popup was still loading)", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, element: { ref: 1, role: "Button", label: "Buy Add-On" }, selector: { strategy: "text", value: "Buy Add-On" } }),
      diffSnapshotsImpl: () => ({ appeared: [{ label: "Add-On" }], disappeared: [], changed: true }),
    });
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const sleepCalls = [];
      const fakeSleep = async (ms) => {
        sleepCalls.push(ms);
      };

      await executor.executeSemanticAction(driver, "tap the Add-ons card", { actSettleMs: 500, sleep: fakeSleep });
      assert.deepStrictEqual(sleepCalls, [500], "a tap should pause once, for the configured duration, before diffing");

      sleepCalls.length = 0;
      await executor.executeSemanticAction(driver, "type the phone number", { kind: "type", text: "0123456789", actSettleMs: 500, sleep: fakeSleep });
      assert.deepStrictEqual(sleepCalls, [], "a type should never pause -- it doesn't trigger a full-screen transition the way a tap can");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's settle delay defaults to PHOENIX_ACT_SETTLE_MS when actSettleMs isn't passed, and skips the pause entirely when it resolves to 0", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, element: { ref: 1, role: "Button", label: "X" }, selector: { strategy: "text", value: "X" } }),
      // changed: true -- NOT the "No visible change." self-heal case
      // (semantic-act-executor.test.js's default diffToText fake maps
      // changed: false to "No visible change.", which would trigger a
      // second actAndDiff/sleep call and make this test about self-heal
      // instead of about the settle-delay default/override it's testing).
      diffSnapshotsImpl: () => ({ appeared: [{ label: "X" }], disappeared: [], changed: true }),
    });
    const previousEnv = process.env.PHOENIX_ACT_SETTLE_MS;
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const sleepCalls = [];
      process.env.PHOENIX_ACT_SETTLE_MS = "250";
      await executor.executeSemanticAction(driver, "tap X", { sleep: async (ms) => sleepCalls.push(ms) });
      assert.deepStrictEqual(sleepCalls, [250], "with no explicit actSettleMs, the env var should be used");

      sleepCalls.length = 0;
      process.env.PHOENIX_ACT_SETTLE_MS = "0";
      await executor.executeSemanticAction(driver, "tap X", { sleep: async (ms) => sleepCalls.push(ms) });
      assert.deepStrictEqual(sleepCalls, [], "PHOENIX_ACT_SETTLE_MS=0 should disable the pause entirely, no sleep call at all");
    } finally {
      if (previousEnv === undefined) delete process.env.PHOENIX_ACT_SETTLE_MS;
      else process.env.PHOENIX_ACT_SETTLE_MS = previousEnv;
      restore();
    }
  });

  if (process.exitCode) {
    console.error("\nengine/semantic-act-executor tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/semantic-act-executor tests passed");
  }
})();
