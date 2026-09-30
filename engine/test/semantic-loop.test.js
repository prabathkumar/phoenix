/**
 * Tests for the Phase 3 autonomous-loop skeleton (engine/semantic-loop.js)
 * -- R&D track per docs/PHOENIX_SPEC.md §6, not customer-facing. Fakes
 * generation/llm's callOllamaJson and semantic-act-executor's
 * executeSemanticAction via require.cache injection (same technique as
 * engine/test/session-manager.test.js and
 * engine/test/semantic-act-executor.test.js) so the whole decide->act->
 * feed-back-in cycle runs deterministically without Ollama or a real
 * session.
 *
 * Run with: npm test (from engine/) or `node test/semantic-loop.test.js`
 */

const assert = require("assert");

const LOOP_PATH = require.resolve("../semantic-loop");
const EXECUTOR_PATH = require.resolve("../semantic-act-executor");
const LLM_PATH = require.resolve("../../generation/llm");

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
 * Loads a fresh semantic-loop.js with its two dependencies faked:
 * callOllamaJson (one decision per call, in order) and
 * executeSemanticAction (one result per call, in order).
 */
function freshLoopWithFakes({ decisions = [], executionResults = [] } = {}) {
  for (const p of [LOOP_PATH, EXECUTOR_PATH, LLM_PATH]) {
    delete require.cache[p];
  }

  let decisionIndex = 0;
  let executionIndex = 0;

  require.cache[LLM_PATH] = {
    id: LLM_PATH,
    filename: LLM_PATH,
    loaded: true,
    exports: {
      callOllamaJson: async () => {
        const decision = decisions[Math.min(decisionIndex, decisions.length - 1)];
        decisionIndex += 1;
        if (decision instanceof Error) throw decision;
        return decision;
      },
    },
  };

  require.cache[EXECUTOR_PATH] = {
    id: EXECUTOR_PATH,
    filename: EXECUTOR_PATH,
    loaded: true,
    exports: {
      // Mirrors the real executor's contract: honors options.beforeAct
      // as a veto hook before "acting", so tests can exercise the
      // loop's own beforeAct wiring (the same-element-different-text
      // guard) without a live session.
      executeSemanticAction: async (driver, instruction, options = {}) => {
        const result = executionResults[Math.min(executionIndex, executionResults.length - 1)];
        executionIndex += 1;
        if (result && result.selector && typeof options.beforeAct === "function") {
          const vetoReason = options.beforeAct({ selector: result.selector, kind: options.kind, text: options.text });
          if (vetoReason) return { success: false, reason: vetoReason };
        }
        return result;
      },
    },
  };

  const loop = require(LOOP_PATH);
  return {
    loop,
    restore: () => {
      for (const p of [LOOP_PATH, EXECUTOR_PATH, LLM_PATH]) delete require.cache[p];
    },
  };
}

const SIMPLE_SCREEN = '<hierarchy><Button text="Log In" resource-id="login_button" /></hierarchy>';

function fakeDriver(pageSource = SIMPLE_SCREEN) {
  return { getPageSource: async () => pageSource };
}

(async () => {
  console.log("engine/semantic-loop:");

  await run("runAutonomousLoop stops immediately with goal-achieved when the model says done on step one", async () => {
    const { loop, restore } = freshLoopWithFakes({ decisions: [{ done: true }] });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "already on the right screen");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.deepStrictEqual(result.steps, []);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop stops with model-requested-stop and carries the reason through", async () => {
    const { loop, restore } = freshLoopWithFakes({ decisions: [{ stop: true, reason: "this needs an OTP, a human should take over" }] });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "model-requested-stop");
      assert.strictEqual(result.reason, "this needs an OTP, a human should take over");
      assert.deepStrictEqual(result.steps, []);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop executes an action, records the step, then stops when told done", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "tap the Login button", kind: "tap" },
        { done: true },
      ],
      executionResults: [
        {
          success: true,
          selector: { strategy: "resource-id", value: "login_button" },
          diffSummary: 'Appeared: "Welcome".',
          assertions: [{ label: "Welcome", resourceId: "welcome_text" }],
        },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(result.steps[0].instruction, "tap the Login button");
      assert.strictEqual(result.steps[0].diffSummary, 'Appeared: "Welcome".');
      // stepIndex is stamped on by the loop itself, not the executor.
      assert.deepStrictEqual(result.steps[0].assertions, [{ label: "Welcome", resourceId: "welcome_text", stepIndex: 0 }]);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop defaults a step's assertions to [] when the executor doesn't return any", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "tap something inert", kind: "tap" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "text", value: "something inert" } }, // no `assertions` field at all
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "goal");
      assert.deepStrictEqual(result.steps[0].assertions, []);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop passes kind/text through for a type action", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type into the username field", kind: "type", text: "prabath@example.com" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "username_input" }, diffSummary: "No visible change." },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.steps[0].kind, "type");
      assert.strictEqual(result.steps[0].text, "prabath@example.com");
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop stops with action-failed and does not retry when an action can't be resolved", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [{ instruction: "tap the checkout button", kind: "tap" }],
      executionResults: [{ success: false, reason: "no element matches 'the checkout button'" }],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "buy the item");
      assert.strictEqual(result.stoppedBecause, "action-failed");
      assert.strictEqual(result.reason, "no element matches 'the checkout button'");
      assert.deepStrictEqual(result.steps, []);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop stops with max-steps-reached rather than looping forever", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [{ instruction: "tap something", kind: "tap" }], // same decision every call
      executionResults: [{ success: true, selector: { strategy: "text", value: "something" }, diffSummary: "No visible change." }],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "an unreachable goal", { maxSteps: 3 });
      assert.strictEqual(result.stoppedBecause, "max-steps-reached");
      assert.strictEqual(result.steps.length, 3);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop reports {stoppedBecause: 'error'} rather than throwing on a malformed model response", async () => {
    const { loop, restore } = freshLoopWithFakes({ decisions: [{ somethingElse: true }] });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "error");
      assert.ok(result.reason.includes("decision shape"));
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop reports {stoppedBecause: 'error'} when Ollama itself fails", async () => {
    const { loop, restore } = freshLoopWithFakes({ decisions: [new Error("connect ECONNREFUSED 127.0.0.1:11434")] });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "error");
      assert.ok(result.reason.includes("ECONNREFUSED"));
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop stops cleanly (action-failed) rather than throwing when getPageSource fails mid-loop", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "tap the Login button", kind: "tap" },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "login_button" }, diffSummary: 'Appeared: "Welcome".' },
      ],
    });
    try {
      let calls = 0;
      const driver = {
        getPageSource: async () => {
          calls += 1;
          if (calls > 1) throw new Error("session terminated");
          return SIMPLE_SCREEN;
        },
      };
      const result = await loop.runAutonomousLoop(driver, "log in", { maxSteps: 5 });
      assert.strictEqual(result.stoppedBecause, "action-failed");
      assert.ok(result.reason.includes("session terminated"));
      assert.strictEqual(result.steps.length, 1); // the one successful step is preserved
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop refuses a second 'type' into the same element with different text (real bug: password overwrote Yes Number)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "0183400351" },
        { instruction: "type the password into the edit text", kind: "type", text: "p@P1B@6vbu" },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "action-failed");
      assert.ok(result.reason.includes("edtCommon"));
      assert.ok(result.reason.includes("previous step already typed a different value"));
      // The first (good) step is preserved; the clobbering second step never happened.
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(result.steps[0].text, "0183400351");
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop allows re-typing the SAME text into the same element (not a clobber)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the code into the edit text", kind: "type", text: "1234" },
        { instruction: "type the code into the edit text", kind: "type", text: "1234" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "enter the code twice");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.strictEqual(result.steps.length, 2);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop retries once and recovers when the model first omits 'text' on a type decision (real, reproduced flakiness)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type" }, // malformed: no "text"
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "0183400351" }, // retry succeeds
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(result.steps[0].text, "0183400351");
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop still reports {stoppedBecause: 'error'} when the model omits 'text' on BOTH the original and the retry", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the password into the edit text", kind: "type" },
        { instruction: "type the password into the edit text", kind: "type" }, // retry, still malformed
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "error");
      assert.ok(result.reason.includes('without "text"'));
    } finally {
      restore();
    }
  });

  await run("decideNextAction's prompt warns against typing a field's own nearby-label hint as the value (real bug: model typed \"Yes Number\" instead of the actual phone number)", async () => {
    let capturedPrompt;
    for (const p of [LOOP_PATH, LLM_PATH]) delete require.cache[p];
    require.cache[LLM_PATH] = {
      id: LLM_PATH,
      filename: LLM_PATH,
      loaded: true,
      exports: {
        callOllamaJson: async (prompt) => {
          capturedPrompt = prompt;
          return { done: true };
        },
      },
    };
    const loop = require(LOOP_PATH);
    try {
      const snapshotText = '[1] EditText (empty input near: "Yes Number")';
      await loop.decideNextAction(
        'type the Yes Number, then tap Login. When the app asks you to log in, use these exact credentials: phone/account number "0183400351"',
        snapshotText,
        []
      );
      assert.ok(capturedPrompt.includes("empty input near"));
      // The real failure: given this exact snapshot shape and a goal that
      // states the real phone number, the model typed the literal string
      // "Yes Number" (the hint text) instead of "0183400351" (the actual
      // credential). The prompt must explicitly warn against that.
      assert.ok(capturedPrompt.includes('an actual value to enter'));
      assert.ok(capturedPrompt.includes('Never use a'));
      assert.ok(capturedPrompt.includes('is not something to type INTO it'));
    } finally {
      delete require.cache[LOOP_PATH];
      delete require.cache[LLM_PATH];
    }
  });

  if (process.exitCode) {
    console.error("\nengine/semantic-loop tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/semantic-loop tests passed");
  }
})();
