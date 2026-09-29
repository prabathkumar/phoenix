/**
 * Tests for the EXPERIMENTAL POST /api/semantic-action handler
 * (frontend/semantic-action-endpoint.js) -- gated behind
 * PHOENIX_ENABLE_SEMANTIC_API=1 in server.js, see that module's header
 * for why. engine/session-manager.js and engine/semantic-act-executor.js
 * are faked via require.cache injection (same approach as
 * frontend/test/upload-session.test.js), and a real HTTP server + native
 * fetch exercises the actual JSON body parsing.
 *
 * Run with: npm test (from frontend/) or `node test/semantic-action-endpoint.test.js`
 */

const assert = require("assert");
const http = require("http");

const SESSION_MANAGER_PATH = require.resolve("../../engine/session-manager");
const EXECUTOR_PATH = require.resolve("../../engine/semantic-act-executor");
const ENDPOINT_PATH = require.resolve("../semantic-action-endpoint");

function fakeModule(exports) {
  return { loaded: true, exports };
}

function freshEndpointWithFakes({ activeSession = null, executeSemanticActionImpl } = {}) {
  for (const p of [SESSION_MANAGER_PATH, EXECUTOR_PATH, ENDPOINT_PATH]) {
    delete require.cache[p];
  }

  require.cache[SESSION_MANAGER_PATH] = fakeModule({
    getActiveSession: () => activeSession,
  });

  const executeCalls = [];
  require.cache[EXECUTOR_PATH] = fakeModule({
    executeSemanticAction: async (driver, instruction, options) => {
      executeCalls.push({ driver, instruction, options });
      if (executeSemanticActionImpl) return executeSemanticActionImpl(driver, instruction, options);
      return { success: true, selector: { strategy: "text", value: instruction } };
    },
  });

  const { handleSemanticAction } = require(ENDPOINT_PATH);
  return { handleSemanticAction, executeCalls };
}

function startTestServer(handleSemanticAction) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/semantic-action") {
      handleSemanticAction(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/semantic-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsedBody = await response.json().catch(() => ({}));
  return { status: response.status, body: parsedBody };
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

(async () => {
  console.log("frontend/semantic-action-endpoint:");

  await run("returns 409 when no session is active, without calling executeSemanticAction", async () => {
    const { handleSemanticAction, executeCalls } = freshEndpointWithFakes({ activeSession: null });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, { instruction: "tap the Login button" });
      assert.strictEqual(status, 409);
      assert.ok(body.error.includes("No recording session is active"));
      assert.strictEqual(executeCalls.length, 0);
    } finally {
      server.close();
    }
  });

  await run("returns 400 when instruction is missing", async () => {
    const { handleSemanticAction } = freshEndpointWithFakes({ activeSession: { platform: "android", driver: {} } });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, {});
      assert.strictEqual(status, 400);
      assert.ok(body.error.includes("instruction"));
    } finally {
      server.close();
    }
  });

  await run("returns 400 on invalid JSON body", async () => {
    const { handleSemanticAction } = freshEndpointWithFakes({ activeSession: { platform: "android", driver: {} } });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, "{not json");
      assert.strictEqual(status, 400);
      assert.ok(body.error.includes("Invalid JSON"));
    } finally {
      server.close();
    }
  });

  await run("returns 400 when kind is neither tap nor type", async () => {
    const { handleSemanticAction } = freshEndpointWithFakes({ activeSession: { platform: "android", driver: {} } });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, { instruction: "swipe up", kind: "swipe" });
      assert.strictEqual(status, 400);
      assert.ok(body.error.includes('"tap" or "type"'));
    } finally {
      server.close();
    }
  });

  await run("runs the action against the active session's driver/platform and returns 200 on success", async () => {
    const fakeDriver = { marker: "the-active-driver" };
    const { handleSemanticAction, executeCalls } = freshEndpointWithFakes({
      activeSession: { platform: "ios", driver: fakeDriver },
      executeSemanticActionImpl: async () => ({
        success: true,
        selector: { strategy: "accessibility-id", value: "loginButton" },
        diffSummary: 'Appeared: "Welcome".',
      }),
    });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, { instruction: "tap the Login button" });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.success, true);
      assert.deepStrictEqual(body.selector, { strategy: "accessibility-id", value: "loginButton" });

      assert.strictEqual(executeCalls.length, 1);
      assert.strictEqual(executeCalls[0].driver, fakeDriver);
      assert.strictEqual(executeCalls[0].instruction, "tap the Login button");
      assert.strictEqual(executeCalls[0].options.platform, "ios");
    } finally {
      server.close();
    }
  });

  await run("passes kind/text through for a type action", async () => {
    const { handleSemanticAction, executeCalls } = freshEndpointWithFakes({
      activeSession: { platform: "android", driver: {} },
    });
    const server = await startTestServer(handleSemanticAction);
    try {
      await post(server.address().port, { instruction: "type into username", kind: "type", text: "prabath@example.com" });
      assert.strictEqual(executeCalls[0].options.kind, "type");
      assert.strictEqual(executeCalls[0].options.text, "prabath@example.com");
    } finally {
      server.close();
    }
  });

  await run("returns 422 (not 200) when the executor reports an unresolved/failed action", async () => {
    const { handleSemanticAction } = freshEndpointWithFakes({
      activeSession: { platform: "android", driver: {} },
      executeSemanticActionImpl: async () => ({ success: false, reason: "no element matches 'the checkout button'" }),
    });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, { instruction: "tap the checkout button" });
      assert.strictEqual(status, 422);
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.reason, "no element matches 'the checkout button'");
    } finally {
      server.close();
    }
  });

  await run("returns 500 rather than hanging if executeSemanticAction unexpectedly throws", async () => {
    const { handleSemanticAction } = freshEndpointWithFakes({
      activeSession: { platform: "android", driver: {} },
      executeSemanticActionImpl: async () => {
        throw new Error("something broke in a way the contract says shouldn't happen");
      },
    });
    const server = await startTestServer(handleSemanticAction);
    try {
      const { status, body } = await post(server.address().port, { instruction: "tap anything" });
      assert.strictEqual(status, 500);
      assert.ok(body.error.includes("Unexpected error"));
    } finally {
      server.close();
    }
  });

  if (process.exitCode) {
    console.error("\nfrontend/semantic-action-endpoint tests FAILED");
    process.exit(1);
  } else {
    console.log("\nfrontend/semantic-action-endpoint tests passed");
  }
})();
