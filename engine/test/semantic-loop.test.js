/**
 * Tests for the Phase 3 autonomous-loop skeleton (engine/semantic-loop.js)
 * -- R&D track per docs/TESTOPS_MOBILE_SPEC.md §6, not customer-facing. Fakes
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

  const realLoop = require(LOOP_PATH);
  // Tests don't care about the real post-tap settle delay (added for
  // the real ios2 stale-element bug -- see semantic-loop.js's
  // DEFAULT_TAP_SETTLE_DELAY_MS) and shouldn't have to actually wait
  // 800ms per tap decision; default it to 0 here unless a test
  // explicitly asks to exercise the delay itself.
  const loop = {
    ...realLoop,
    runAutonomousLoop: (driver, goal, options = {}) =>
      realLoop.runAutonomousLoop(driver, goal, { tapSettleDelayMs: 0, ...options }),
  };
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

  await run("runAutonomousLoop stops with max-steps-reached rather than looping forever (real progress every step, never a no-op)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [{ instruction: "tap something", kind: "tap" }], // same decision every call
      // Unlike the android17 real bug (same action, "No visible change."
      // every time -- now caught by the no-op stuck-loop guard above and
      // tested separately), this fake keeps reporting real, distinct
      // progress on every step, so max-steps-reached is the only way
      // this loop can end.
      executionResults: [
        { success: true, selector: { strategy: "text", value: "something" }, diffSummary: 'Appeared: "step 1".' },
        { success: true, selector: { strategy: "text", value: "something" }, diffSummary: 'Appeared: "step 2".' },
        { success: true, selector: { strategy: "text", value: "something" }, diffSummary: 'Appeared: "step 3".' },
      ],
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

  await run("runAutonomousLoop retries after a veto instead of failing immediately, and recovers if the model corrects itself (real bug: a plain prompt reminder alone did NOT stop the model repeating the same refused action 3/3 on a live run)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "0185824587" },
        // Wrongly repeats the same clobbering attempt once (as the real
        // model did) -- this should now be RETRIED, not fail the loop.
        { instruction: "type the password into the edit text", kind: "type", text: "8whEu0N" },
        // Having been told exactly why that was refused, the model
        // course-corrects: taps the PASSWORD tab first.
        { instruction: "tap the PASSWORD tab", kind: "tap" },
        // Now typing the password resolves to a different element and succeeds.
        { instruction: "type the password into the password field", kind: "type", text: "8whEu0N" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
        { success: true, selector: { strategy: "xpath", value: "/hierarchy/View[2]" }, diffSummary: 'Appeared: "PASSWORD selected".' },
        { success: true, selector: { strategy: "resource-id", value: "edtPassword" }, diffSummary: 'Appeared: "[REDACTED]".' },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in with phone 0185824587 and password 8whEu0N");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      // The clobbering attempt never became a recorded step; only the
      // three genuinely successful actions did.
      assert.strictEqual(result.steps.length, 3);
      assert.strictEqual(result.steps[1].instruction, "tap the PASSWORD tab");
      assert.strictEqual(result.steps[2].selector.value, "edtPassword");
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop gives up (action-failed) after exhausting veto retries on a model that never corrects itself", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "0185824587" },
        { instruction: "type the password into the edit text", kind: "type", text: "8whEu0N" },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "action-failed");
      assert.ok(result.reason.includes("previous step already typed a different value"));
      assert.strictEqual(result.steps.length, 1);
    } finally {
      restore();
    }
  });

  await run("decideNextAction includes the previous refused attempt and its reason when given one, telling the model not to repeat it", async () => {
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
      await loop.decideNextAction("log in", '[1] EditText "0185824587"\n[2] View "PASSWORD"', [], {
        instruction: "type the password into the edit text",
        kind: "type",
        reason: "refusing to type into the same element a previous step already typed a different value into (resource-id:edtCommon)",
      });
      assert.ok(capturedPrompt.includes("your last proposed action was rejected"));
      assert.ok(capturedPrompt.includes("type the password into the edit text"));
      assert.ok(capturedPrompt.includes("resource-id:edtCommon"));
      assert.ok(capturedPrompt.includes("Do not propose that same action again"));
    } finally {
      delete require.cache[LOOP_PATH];
      delete require.cache[LLM_PATH];
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

  await run("decideNextAction's prompt uses concrete examples, never literal \"...\" placeholders (real bug: model echoed the example's own \"...\" and a snapshot ref \"[18]\" as its answer)", async () => {
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
      await loop.decideNextAction("log in", "[18] android.widget.EditText", []);
      // The example format itself must no longer contain a literal "..."
      // action/text value -- the real failure was the model copying
      // exactly this from an earlier version of this prompt.
      assert.ok(!capturedPrompt.includes('"instruction": "tap the ... button"'));
      assert.ok(!capturedPrompt.includes('"instruction": "type ... into ..."'));
      assert.ok(!capturedPrompt.includes('"text": "..."'));
      // The explicit reminder against copying template/ref syntax must be present.
      assert.ok(capturedPrompt.includes("illustrations, not templates"));
      assert.ok(capturedPrompt.toLowerCase().includes('never output literal "..."'));
      assert.ok(capturedPrompt.includes("copy a"));
    } finally {
      delete require.cache[LOOP_PATH];
      delete require.cache[LLM_PATH];
    }
  });

  await run("decideNextAction's prompt tells the model to handle an error dialog instead of guessing another type/tap (real bug: model tried to \"type\" against an Invalid-username/password OK dialog with no input field, failing with \"No editable input field found\")", async () => {
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
      await loop.decideNextAction("log in", '[1] TextView "Invalid username/password entered"\n[2] Button "OK"', []);
      assert.ok(capturedPrompt.includes("dialog/alert reporting an error"));
      assert.ok(capturedPrompt.includes("dismiss/OK button"));
      assert.ok(capturedPrompt.includes("stop and report that exact message as the reason"));
    } finally {
      delete require.cache[LOOP_PATH];
      delete require.cache[LLM_PATH];
    }
  });

  await run("decideNextAction's prompt tells the model to tap a login-method tab (e.g. \"PASSWORD\") before typing into a field that already holds a different value (real bug: model tried to type the password straight into the already-filled Yes Number field, with no password field or tab-tap step in between)", async () => {
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
      await loop.decideNextAction(
        "log in with phone 0185824587 and password 8whEu0N",
        '[1] EditText "0185824587" (id: edtCommon)\n[2] View "PASSWORD"\n[3] View "USE TAC"',
        [{ instruction: "type the phone number into the Yes Number field", diffSummary: 'Appeared: "0185824587".' }]
      );
      assert.ok(capturedPrompt.includes("make sure a field for it is actually visible"));
      assert.ok(capturedPrompt.includes("that is a sign"));
      assert.ok(capturedPrompt.includes("the field you need isn't showing yet"));
      assert.ok(capturedPrompt.includes('"PASSWORD" tab before typing a password'));
    } finally {
      delete require.cache[LOOP_PATH];
      delete require.cache[LLM_PATH];
    }
  });

  await run("runAutonomousLoop stops with action-failed after 3 consecutive successful actions that each produce \"No visible change.\" (real bug: android17 clicked the same already-filled field 15 times in a row and burned the entire step budget)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "01166114421" },
        // The model keeps re-tapping the same field; each tap is
        // accepted by the device (success: true) but changes nothing.
        { instruction: "tap the Yes Number field", kind: "tap" },
        { instruction: "tap the Yes Number field", kind: "tap" },
        { instruction: "tap the Yes Number field", kind: "tap" },
        // Should never be reached -- the loop stops after the 3rd no-op.
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in", { maxSteps: 20 });
      assert.strictEqual(result.stoppedBecause, "action-failed");
      assert.ok(result.reason.includes("No visible change"));
      assert.ok(result.reason.includes("stuck repeating"));
      // The typing step plus the 3 no-op taps -- not all 20 maxSteps.
      assert.strictEqual(result.steps.length, 4);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop does NOT stop early when a no-op tap is followed by real progress (the no-op counter resets)", async () => {
    const { loop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "01166114421" },
        { instruction: "tap the Yes Number field", kind: "tap" },
        { instruction: "tap the Yes Number field", kind: "tap" },
        // Recovers before hitting the 3-in-a-row threshold.
        { instruction: "tap the PASSWORD tab", kind: "tap" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: 'Appeared: "[REDACTED]".' },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
        { success: true, selector: { strategy: "resource-id", value: "edtCommon" }, diffSummary: "No visible change." },
        { success: true, selector: { strategy: "xpath", value: "/hierarchy/View[2]" }, diffSummary: 'Appeared: "PASSWORD selected".' },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.strictEqual(result.steps.length, 4);
    } finally {
      restore();
    }
  });

  await run("runAutonomousLoop pauses (tapSettleDelayMs) after a successful tap but not after a successful type (real bug: ios2 captured a mid-transition-animation snapshot right after tapping LOGIN, built a selector from it, and the element was gone by the time the next step tried to act on it)", async () => {
    const { loop: wrappedLoop, restore } = freshLoopWithFakes({
      decisions: [
        { instruction: "tap the Login button", kind: "tap" },
        { instruction: "type the Yes Number into the edit text", kind: "type", text: "01166114421" },
        { done: true },
      ],
      executionResults: [
        { success: true, selector: { strategy: "accessibility-id", value: "LOGIN" }, diffSummary: 'Appeared: "Yes Number".' },
        { success: true, selector: { strategy: "xpath", value: "/hierarchy/TextField[1]" }, diffSummary: 'Appeared: "[REDACTED]".' },
      ],
    });
    // freshLoopWithFakes' wrapper defaults tapSettleDelayMs to 0 for
    // every other test -- bypass it here to exercise the real delay
    // logic, with a fake `sleep` so the test doesn't actually wait.
    const realLoop = require(LOOP_PATH);
    const sleepCalls = [];
    const fakeSleep = (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
    try {
      const result = await realLoop.runAutonomousLoop(fakeDriver(), "log in", {
        tapSettleDelayMs: 800,
        sleep: fakeSleep,
      });
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      // One tap, one type, then "done" -- the pause should fire exactly
      // once (after the tap), not after the type and not after "done".
      assert.deepStrictEqual(sleepCalls, [800]);
    } finally {
      restore();
    }
  });

  if (process.exitCode) {
    console.error("\nengine/semantic-loop tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/semantic-loop tests passed");
  }
})();
