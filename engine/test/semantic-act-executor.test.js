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
function makeFakeDriver({ pageSources, elementBehavior = {}, takeScreenshotImpl, executeImpl, getWindowSizeImpl } = {}) {
  let pageSourceCallCount = 0;
  const calls = { click: 0, setValue: [], takeScreenshot: 0, execute: [] };

  const element = {
    isExisting: elementBehavior.isExisting || (async () => true),
    click: async () => {
      calls.click += 1;
      if (elementBehavior.clickThrows) throw new Error(elementBehavior.clickThrows);
    },
    setValue: async (text) => {
      calls.setValue.push(text);
    },
  };

  return {
    calls,
    driver: {
      getPageSource: async () => {
        const value = pageSources[Math.min(pageSourceCallCount, pageSources.length - 1)];
        pageSourceCallCount += 1;
        if (value instanceof Error) throw value;
        return value;
      },
      $: async (_selectorString) => element,
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

  if (process.exitCode) {
    console.error("\nengine/semantic-act-executor tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/semantic-act-executor tests passed");
  }
})();
