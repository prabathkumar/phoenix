/**
 * Tests for session-manager.js — the orchestration extracted from
 * run-session.js's original main() so both the boot-once CLI path and
 * the on-demand upload path (frontend/upload-session.js) share one
 * implementation. No real Appium/BrowserStack session, no real
 * WebSocket server: every dependency session-manager.js pulls in
 * (engine/session, capture/recorder, live-view/server,
 * generation/pipeline) is faked via require.cache injection, the same
 * approach engine/test/remote-provider.test.js uses for a fresh
 * module load. The point is proving the *orchestration* — one session
 * at a time, capabilityOverrides reach startSession(), a "stop"
 * message triggers generation and clears the active session — not
 * exercising any real driver/network code.
 *
 * Run with: npm test (from engine/) or `node test/session-manager.test.js`
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");

const SESSION_MANAGER_PATH = require.resolve("../session-manager");
const SESSION_PATH = require.resolve("../session");
const GENERATION_PIPELINE_PATH = require.resolve("../../generation/pipeline");
const CAPTURE_RECORDER_PATH = require.resolve("../../capture/recorder");
const LIVE_VIEW_SERVER_PATH = require.resolve("../../live-view/server");

function test(name, fn) {
  return fn(name);
}

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
 * Fakes every dependency session-manager.js requires, then returns a
 * fresh session-manager plus hooks the test can drive: capturing what
 * capabilityOverrides reached the fake startSession(), and a way to
 * simulate a tester's "stop" message arriving over the fake wss.
 */
function freshSessionManagerWithFakes({ generateScriptImpl, startSessionImpl } = {}) {
  for (const p of [SESSION_MANAGER_PATH, SESSION_PATH, GENERATION_PIPELINE_PATH, CAPTURE_RECORDER_PATH, LIVE_VIEW_SERVER_PATH]) {
    delete require.cache[p];
  }

  const startSessionCalls = [];
  const fakeDriver = { sessionId: "fake-session-1", deleteSession: async () => {} };

  require.cache[SESSION_PATH] = {
    id: SESSION_PATH,
    filename: SESSION_PATH,
    loaded: true,
    exports: {
      startSession: async (overrides) => {
        startSessionCalls.push(overrides);
        if (startSessionImpl) return startSessionImpl(overrides);
        return fakeDriver;
      },
    },
  };

  require.cache[CAPTURE_RECORDER_PATH] = {
    id: CAPTURE_RECORDER_PATH,
    filename: CAPTURE_RECORDER_PATH,
    loaded: true,
    exports: {
      SessionRecorder: class FakeSessionRecorder {
        constructor() {
          this.steps = [];
        }
      },
    },
  };

  const fakeWss = new EventEmitter();
  fakeWss.close = () => {};
  require.cache[LIVE_VIEW_SERVER_PATH] = {
    id: LIVE_VIEW_SERVER_PATH,
    filename: LIVE_VIEW_SERVER_PATH,
    loaded: true,
    exports: {
      startLiveView: () => fakeWss,
    },
  };

  require.cache[GENERATION_PIPELINE_PATH] = {
    id: GENERATION_PIPELINE_PATH,
    filename: GENERATION_PIPELINE_PATH,
    loaded: true,
    exports: {
      generateScript: generateScriptImpl || (async () => ({
        testName: "fake_test",
        assertions: [],
        parameters: [],
        scriptSource: "// fake generated script\n",
      })),
    },
  };

  const sessionManager = require("../session-manager");
  return { sessionManager, startSessionCalls, fakeDriver, fakeWss };
}

async function main() {
  console.log("engine/session-manager:");

  await run("starts a session and returns platform/port/sessionId", async () => {
    const { sessionManager } = freshSessionManagerWithFakes();
    const result = await sessionManager.startRecordingSession({ platform: "android", liveViewPort: 19001 });
    assert.strictEqual(result.platform, "android");
    assert.strictEqual(result.port, 19001);
    assert.strictEqual(result.sessionId, "fake-session-1");
    assert.strictEqual(sessionManager.isSessionActive(), true);
  });

  await run("passes capabilityOverrides straight through to startSession()", async () => {
    const { sessionManager, startSessionCalls } = freshSessionManagerWithFakes();
    await sessionManager.startRecordingSession({
      platform: "android",
      liveViewPort: 19002,
      capabilityOverrides: { "appium:app": "bs://uploaded-app-id" },
    });
    assert.deepStrictEqual(startSessionCalls, [{ "appium:app": "bs://uploaded-app-id" }]);
  });

  await run("refuses a second concurrent session when the pool (default capacity 1) is full", async () => {
    const { sessionManager } = freshSessionManagerWithFakes();
    await sessionManager.startRecordingSession({ platform: "android", liveViewPort: 19003 });
    await assert.rejects(
      () => sessionManager.startRecordingSession({ platform: "android", liveViewPort: 19004 }),
      /full|capacity/i
    );
  });

  await run("TESTOPS_MOBILE_SESSION_POOL_SIZE=2 allows two concurrent sessions with distinct auto-allocated ports", async () => {
    const previous = process.env.TESTOPS_MOBILE_SESSION_POOL_SIZE;
    process.env.TESTOPS_MOBILE_SESSION_POOL_SIZE = "2";
    try {
      let sessionCounter = 0;
      const { sessionManager } = freshSessionManagerWithFakes({
        startSessionImpl: async () => ({ sessionId: `fake-session-${++sessionCounter}`, deleteSession: async () => {} }),
      });

      const first = await sessionManager.startRecordingSession({ platform: "android" });
      const second = await sessionManager.startRecordingSession({ platform: "android" });

      assert.notStrictEqual(first.sessionId, second.sessionId);
      assert.notStrictEqual(first.port, second.port, "expected the pool to allocate two distinct live-view ports");
      assert.strictEqual(sessionManager.getPoolStatus().active, 2);
      assert.strictEqual(sessionManager.getPoolStatus().capacity, 2);

      // The pool is now genuinely full (2/2) -- a third request must still be refused.
      await assert.rejects(
        () => sessionManager.startRecordingSession({ platform: "android" }),
        /full|capacity/i
      );
    } finally {
      if (previous === undefined) delete process.env.TESTOPS_MOBILE_SESSION_POOL_SIZE;
      else process.env.TESTOPS_MOBILE_SESSION_POOL_SIZE = previous;
    }
  });

  await run("releases its slot if startSession() itself fails, instead of leaking a pool slot", async () => {
    const { sessionManager } = freshSessionManagerWithFakes({
      startSessionImpl: async () => {
        throw new Error("boom: device unavailable");
      },
    });

    await assert.rejects(
      () => sessionManager.startRecordingSession({ platform: "android", liveViewPort: 19006 }),
      /boom: device unavailable/
    );
    assert.strictEqual(sessionManager.isSessionActive(), false, "a failed start should not hold onto a pool slot");
  });

  await run("a \"stop\" message generates a script, writes it, and clears the active session", async () => {
    const generatedTestName = `session_manager_test_${Date.now()}`;
    const { sessionManager, fakeWss } = freshSessionManagerWithFakes({
      generateScriptImpl: async () => ({
        testName: generatedTestName,
        assertions: [],
        parameters: [],
        scriptSource: "// generated by the stop-message test\n",
      }),
    });

    await sessionManager.startRecordingSession({ platform: "android", liveViewPort: 19005 });
    assert.strictEqual(sessionManager.isSessionActive(), true);

    const sentMessages = [];
    const fakeSocket = new EventEmitter();
    fakeSocket.send = (raw) => sentMessages.push(JSON.parse(raw));
    fakeWss.emit("connection", fakeSocket);
    fakeSocket.emit("message", JSON.stringify({ type: "stop" }));

    // finishSession's generation work runs inside a setImmediate
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const generatedPath = path.join(__dirname, "..", "..", "generated", `${generatedTestName}.test.js`);
    assert.ok(fs.existsSync(generatedPath), "expected the generated script to be written to generated/");
    fs.unlinkSync(generatedPath);

    const scriptMessage = sentMessages.find((m) => m.type === "script-generated");
    assert.ok(scriptMessage, "expected a script-generated message to be sent back over the socket");
    assert.strictEqual(scriptMessage.testName, generatedTestName);

    assert.strictEqual(sessionManager.isSessionActive(), false, "session should be cleared after finishing");
  });
}

main().then(() => {
  if (process.exitCode) {
    console.error("\nengine/session-manager tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/session-manager tests passed");
  }
});
