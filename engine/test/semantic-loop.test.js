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
      executeSemanticAction: async () => {
        const result = executionResults[Math.min(executionIndex, executionResults.length - 1)];
        executionIndex += 1;
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
        { success: true, selector: { strategy: "resource-id", value: "login_button" }, diffSummary: 'Appeared: "Welcome".' },
      ],
    });
    try {
      const result = await loop.runAutonomousLoop(fakeDriver(), "log in");
      assert.strictEqual(result.stoppedBecause, "goal-achieved");
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(result.steps[0].instruction, "tap the Login button");
      assert.strictEqual(result.steps[0].diffSummary, 'Appeared: "Welcome".');
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

  if (process.exitCode) {
    console.error("\nengine/semantic-loop tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/semantic-loop tests passed");
  }
})();
