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
      // Only attached when a test explicitly supplies it -- most
      // fixtures in this file have no getText() at all, and
      // verifyTypedValue() (engine/semantic-act-executor.js) must treat
      // that as "can't verify, pass through" rather than throwing.
      ...(behavior.getText ? { getText: behavior.getText } : {}),
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

  // Real bug: addons-run-ios-docker-8.log, bug #6 -- "type the phone
  // number" resolved to a genuinely dead element (an invisible,
  // inaccessible keyboard accessory, not a real field). setValue()
  // against it returned successfully, no WebDriver error at all, so
  // the step was reported as a success while the real field never got
  // the right value -- only surfacing much later as an unrelated
  // downstream login failure. The upstream resolution bug is fixed
  // (generation/semantic-snapshot.js), but this read-back check closes
  // the same failure class generically, for any future not-yet-seen
  // variant: confirm the field's own displayed value afterward instead
  // of trusting setValue()'s lack of a thrown error.
  await run("executeSemanticAction FAILS a \"type\" step when the field's read-back value doesn't match what was sent (real bug: addons-run-ios-docker-8.log, bug #6 -- setValue() against a dead element silently 'succeeded')", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "XCUIElementTypeOther" },
        selector: { strategy: "accessibility-id", value: "inputView" },
      }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"],
        // The dead element's own displayed text never changes, no
        // matter what was sent to setValue() -- the real symptom.
        elementBehavior: { getText: async () => "" },
      });
      const result = await executor.executeSemanticAction(driver, "type the phone number", { kind: "type", text: "01166114421" });

      assert.strictEqual(result.success, false);
      assert.ok(result.reason.includes("was not found in the field afterward"));
      // Credential safety: the real typed value must never appear in
      // the failure reason, only its length.
      assert.ok(!result.reason.includes("01166114421"));
      assert.ok(result.reason.includes("11 character"));
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction PASSES a \"type\" step whose read-back value exactly matches what was sent", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/username_input" },
      }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"],
        elementBehavior: { getText: async () => "01166114421" },
      });
      const result = await executor.executeSemanticAction(driver, "type the phone number", { kind: "type", text: "01166114421" });
      assert.strictEqual(result.success, true);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction PASSES a \"type\" step into a masked secure field (read-back is mask characters, not the real text)", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "XCUIElementTypeSecureTextField" },
        selector: { strategy: "accessibility-id", value: "PASSWORD" },
      }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"],
        // "@Ytlc1234" is 9 characters -- a masked field echoes back 9
        // mask characters, never the real text.
        elementBehavior: { getText: async () => "•••••••••" },
      });
      const result = await executor.executeSemanticAction(driver, "type the password", { kind: "type", text: "@Ytlc1234" });
      assert.strictEqual(result.success, true, "a same-length run of mask characters must be treated as the expected masked echo, not a mismatch");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction skips read-back verification entirely when the resolved element has no getText() at all (older/minimal driver shim)", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/username_input" },
      }),
    });
    try {
      // No elementBehavior.getText supplied -- makeFakeDriver's default
      // element has no getText property at all, same as every other
      // test in this file predating this check.
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"] });
      const result = await executor.executeSemanticAction(driver, "type the phone number", { kind: "type", text: "01166114421" });
      assert.strictEqual(result.success, true, "no getText() means no way to verify -- must pass through, not fail");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction skips read-back verification (passes through) when getText() itself throws", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({
        resolved: true,
        element: { ref: 1, role: "EditText" },
        selector: { strategy: "resource-id", value: "com.phoenix.demo:id/username_input" },
      }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"],
        elementBehavior: { getText: async () => { throw new Error("stale element reference"); } },
      });
      const result = await executor.executeSemanticAction(driver, "type the phone number", { kind: "type", text: "01166114421" });
      assert.strictEqual(result.success, true, "a read-back failure doesn't mean the type itself failed -- best-effort, not a new failure mode");
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

  // "try twice and then fail" -- explicit requirement: a decline isn't
  // necessarily final. Real bug this mirrors: addons.ios.json run 11
  // (bug #7), where a step declined for a reason that wouldn't have
  // held a moment later against a fresh read of the same screen.
  await run("executeSemanticAction retries ONCE on a decline, re-reading the live screen, and succeeds if the retry resolves", async () => {
    let calls = 0;
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSourceXml, instruction, options) => {
        calls += 1;
        if (calls === 1) {
          assert.strictEqual(options.priorDeclineReason, undefined, "the FIRST attempt must not carry a priorDeclineReason -- nothing has failed yet");
          return { resolved: false, reason: "screen still loading, nothing matches yet" };
        }
        assert.strictEqual(calls, 2);
        assert.strictEqual(options.priorDeclineReason, "screen still loading, nothing matches yet", "the retry must be told why the first attempt declined");
        return {
          resolved: true,
          element: { ref: 1, role: "Button", label: "PASSWORD" },
          selector: { strategy: "accessibility-id", value: "PASSWORD" },
        };
      },
      // A real diff (changed: true) so this test exercises ONLY the
      // decline-retry path, not the separate, pre-existing "No visible
      // change." self-heal retry (which would otherwise also call
      // resolveSemanticAction a third time and isn't what this test is for).
      diffSnapshotsImpl: () => ({ appeared: [{ label: "Password field" }], disappeared: [], changed: true }),
    });
    try {
      const { driver, calls: driverCalls } = makeFakeDriver({
        pageSources: ["<hierarchy>loading</hierarchy>", "<hierarchy>loaded</hierarchy>", "<hierarchy>loaded</hierarchy>"],
      });
      const result = await executor.executeSemanticAction(driver, "tap the PASSWORD button");
      assert.strictEqual(calls, 2, "must call resolveSemanticAction exactly twice -- once, then one retry");
      assert.strictEqual(result.success, true);
      assert.strictEqual(driverCalls.click, 1);
      assert.deepStrictEqual(result.selector, { strategy: "accessibility-id", value: "PASSWORD" });
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction fails (exactly once retried, never looping) when the retry ALSO declines, preserving both reasons", async () => {
    let calls = 0;
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => {
        calls += 1;
        return calls === 1
          ? { resolved: false, reason: "first decline reason" }
          : { resolved: false, reason: "second decline reason, still nothing" };
      },
    });
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy />", "<hierarchy />"] });
      const result = await executor.executeSemanticAction(driver, "tap something unresolvable");
      assert.strictEqual(calls, 2, "must not retry more than once");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "second decline reason, still nothing", "the FINAL reported reason must be the retry's own reason, not the stale first one");
      assert.strictEqual(result.firstAttemptReason, "first decline reason", "the first attempt's reason must still be preserved, not lost");
      assert.strictEqual(result.retried, true);
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's retry falls back to the already-captured screen if the fresh getPageSource() read itself fails", async () => {
    let resolveCalls = 0;
    const seenPageSources = [];
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async (pageSourceXml) => {
        resolveCalls += 1;
        seenPageSources.push(pageSourceXml);
        return { resolved: false, reason: `declined (attempt ${resolveCalls})` };
      },
    });
    try {
      let getPageSourceCalls = 0;
      const driver = {
        getPageSource: async () => {
          getPageSourceCalls += 1;
          if (getPageSourceCalls === 1) return "<hierarchy>before</hierarchy>";
          throw new Error("transient read error");
        },
        $: async () => ({ isExisting: async () => true, click: async () => {} }),
      };
      // The retry's own getPageSource() throws -- executeSemanticAction
      // must not blow up over it, just fall back to reusing
      // pageSourceBefore for the retry attempt.
      const result = await executor.executeSemanticAction(driver, "tap OK");
      assert.strictEqual(resolveCalls, 2, "must still attempt the retry (against the fallback source) rather than giving up when the fresh read fails");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.retried, true);
      assert.deepStrictEqual(seenPageSources, ["<hierarchy>before</hierarchy>", "<hierarchy>before</hierarchy>"], "both attempts must have seen a real page source -- the retry fell back to pageSourceBefore, it wasn't handed undefined/empty");
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

  await run("executeSemanticAction's outcome-settle retry polls past a still-loading screen until the declared `expect` holds", async () => {
    let diffCalls = 0;
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, element: { ref: 1, role: "Button", label: "Add-ons" }, selector: { strategy: "text", value: "Add-ons" } }),
      diffSnapshotsImpl: () => {
        diffCalls += 1;
        // First two reads: still a bare loading spinner -- the real
        // BrowserStack shape that prompted this (see
        // DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS's comment). Third read: the
        // declared outcome has finally rendered.
        if (diffCalls < 3) return { appeared: [{ label: "ProgressBar" }], disappeared: [], changed: true };
        return { appeared: [{ label: "Add-On" }], disappeared: [], changed: true };
      },
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>loading</hierarchy>", "<hierarchy>loading</hierarchy>", "<hierarchy>loaded</hierarchy>"],
      });
      const sleepCalls = [];
      const result = await executor.executeSemanticAction(driver, "tap the Add-ons tab", {
        expect: { appeared: ["Add-On"] },
        sleep: async (ms) => sleepCalls.push(ms),
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.diff.appeared, [{ label: "Add-On" }], "must hand back the SETTLED diff, not the first, still-loading one");
      assert.strictEqual(diffCalls, 3, "must keep polling/re-diffing until the declared outcome actually holds");
      assert.ok(sleepCalls.length >= 1, "must actually wait between polls rather than busy-looping");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's outcome-settle retry gives up and reports the real (still-failing) diff once the timeout elapses", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, element: { ref: 1, role: "Button", label: "Add-ons" }, selector: { strategy: "text", value: "Add-ons" } }),
      // Never matches "Add-On" -- a genuinely wrong click, not a loading race.
      diffSnapshotsImpl: () => ({ appeared: [{ label: "ProgressBar" }], disappeared: [], changed: true }),
    });
    try {
      const { driver } = makeFakeDriver({
        pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>loading</hierarchy>", "<hierarchy>loading</hierarchy>", "<hierarchy>loading</hierarchy>"],
      });
      const result = await executor.executeSemanticAction(driver, "tap the Add-ons tab", {
        expect: { appeared: ["Add-On"] },
        sleep: async () => {},
        // 0 means "the deadline has already passed" -- no polling at
        // all, so this stays fast and deterministic regardless of real
        // wall-clock timing.
        outcomeSettleTimeoutMs: 0,
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.diff.appeared, [{ label: "ProgressBar" }], "must report the real, still-wrong diff rather than fabricate a pass");
    } finally {
      restore();
    }
  });

  await run("executeSemanticAction's outcome-settle retry never engages when the step declares no `expect`", async () => {
    const { executor, restore } = freshExecutorWithFakes({
      resolveSemanticActionImpl: async () => ({ resolved: true, element: { ref: 1, role: "Button", label: "Add-ons" }, selector: { strategy: "text", value: "Add-ons" } }),
      diffSnapshotsImpl: () => ({ appeared: [{ label: "ProgressBar" }], disappeared: [], changed: true }),
    });
    try {
      const { driver } = makeFakeDriver({ pageSources: ["<hierarchy>before</hierarchy>", "<hierarchy>after</hierarchy>"] });
      const sleepCalls = [];
      const result = await executor.executeSemanticAction(driver, "tap the Add-ons tab", { sleep: async (ms) => sleepCalls.push(ms) });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(sleepCalls, [], "no expect declared -- must behave exactly as before, no extra wait at all");
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
