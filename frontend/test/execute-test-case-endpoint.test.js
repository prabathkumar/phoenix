/**
 * Tests for POST /api/execute-test-case (frontend/execute-test-case-
 * endpoint.js) -- the TestOps integration contract decided 2026-10-04.
 * engine/attach-session.js, engine/test-case-runner.js, and
 * engine/semantic-act-executor.js are faked via require.cache injection,
 * same approach as semantic-action-endpoint.test.js and
 * upload-session.test.js. A real HTTP server + native fetch exercises
 * the actual JSON body parsing and response shape.
 *
 * Run with: npm test (from frontend/) or `node test/execute-test-case-endpoint.test.js`
 */

const assert = require("assert");
const http = require("http");

const ATTACH_PATH = require.resolve("../../engine/attach-session");
const RUNNER_PATH = require.resolve("../../engine/test-case-runner");
const EXECUTOR_PATH = require.resolve("../../engine/semantic-act-executor");
const ENDPOINT_PATH = require.resolve("../execute-test-case-endpoint");

function fakeModule(exports) {
  return { loaded: true, exports };
}

function freshEndpointWithFakes({ attachImpl, runScriptStepsImpl, deleteSessionCalls } = {}) {
  for (const p of [ATTACH_PATH, RUNNER_PATH, EXECUTOR_PATH, ENDPOINT_PATH]) {
    delete require.cache[p];
  }

  const attachCalls = [];
  require.cache[ATTACH_PATH] = fakeModule({
    attachSession: async (opts) => {
      attachCalls.push(opts);
      if (attachImpl) return attachImpl(opts);
      return {
        deleteSession: async () => {
          if (deleteSessionCalls) deleteSessionCalls.push(opts.sessionId);
        },
      };
    },
  });

  const runCalls = [];
  require.cache[RUNNER_PATH] = fakeModule({
    runScriptSteps: async (driver, steps, options) => {
      runCalls.push({ driver, steps, options });
      if (runScriptStepsImpl) return runScriptStepsImpl(driver, steps, options);
      return { success: true, detail: "ok", updatedSteps: steps };
    },
  });

  require.cache[EXECUTOR_PATH] = fakeModule({
    executeSemanticAction: async () => ({ success: true }),
  });

  const { handleExecuteTestCase } = require(ENDPOINT_PATH);
  return { handleExecuteTestCase, attachCalls, runCalls };
}

function startTestServer(handleExecuteTestCase) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/execute-test-case") {
      handleExecuteTestCase(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/execute-test-case`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    failed += 1;
  }
}

async function main() {
  console.log("frontend/execute-test-case-endpoint.js:");

  await test("rejects a request missing sessionId", async () => {
    const { handleExecuteTestCase } = freshEndpointWithFakes();
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const { status, json } = await post(server.address().port, {
        platform: "android",
        testCase: { steps: [] },
      });
      assert.strictEqual(status, 400);
      assert.match(json.error, /sessionId is required/);
    } finally {
      server.close();
    }
  });

  await test("rejects an invalid platform", async () => {
    const { handleExecuteTestCase } = freshEndpointWithFakes();
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const { status, json } = await post(server.address().port, {
        sessionId: "abc",
        platform: "windows-phone",
        testCase: { steps: [] },
      });
      assert.strictEqual(status, 400);
      assert.match(json.error, /platform must be/);
    } finally {
      server.close();
    }
  });

  await test("rejects a testCase with no steps array", async () => {
    const { handleExecuteTestCase } = freshEndpointWithFakes();
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const { status, json } = await post(server.address().port, {
        sessionId: "abc",
        platform: "android",
        testCase: { notSteps: [] },
      });
      assert.strictEqual(status, 400);
      assert.match(json.error, /testCase must be/);
    } finally {
      server.close();
    }
  });

  await test("attaches to TestOps's sessionId (not a new session) and runs the given steps", async () => {
    const { handleExecuteTestCase, attachCalls, runCalls } = freshEndpointWithFakes();
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const steps = [{ kind: "tap", instruction: "tap LOGIN" }];
      const { status, json } = await post(server.address().port, {
        sessionId: "testops-session-42",
        platform: "android",
        hubUrl: { hostname: "hub-cloud.browserstack.com", port: 443, path: "/wd/hub" },
        testCase: { steps },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(attachCalls.length, 1);
      assert.strictEqual(attachCalls[0].sessionId, "testops-session-42");
      assert.strictEqual(runCalls.length, 1);
      assert.deepStrictEqual(runCalls[0].steps, steps);
      assert.strictEqual(runCalls[0].options.platform, "android");
    } finally {
      server.close();
    }
  });

  await test("accepts a bare steps array as testCase (not just {steps: [...]})", async () => {
    const { handleExecuteTestCase, runCalls } = freshEndpointWithFakes();
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const steps = [{ kind: "wait", durationMs: 100 }];
      const { status } = await post(server.address().port, {
        sessionId: "s1",
        platform: "ios",
        testCase: steps,
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(runCalls[0].steps, steps);
    } finally {
      server.close();
    }
  });

  await test("never calls deleteSession on the attached driver -- that's TestOps's session to close", async () => {
    const deleteSessionCalls = [];
    const { handleExecuteTestCase } = freshEndpointWithFakes({ deleteSessionCalls });
    const server = await startTestServer(handleExecuteTestCase);
    try {
      await post(server.address().port, {
        sessionId: "s2",
        platform: "android",
        testCase: { steps: [] },
      });
      assert.deepStrictEqual(deleteSessionCalls, []);
    } finally {
      server.close();
    }
  });

  await test("sets testData into process.env for the call and restores it afterward", async () => {
    const seen = [];
    const { handleExecuteTestCase } = freshEndpointWithFakes({
      runScriptStepsImpl: async () => {
        seen.push(process.env.TESTOPS_MOBILE_TEST_LOGIN_PHONE);
        return { success: true, detail: "ok" };
      },
    });
    const server = await startTestServer(handleExecuteTestCase);
    const before = process.env.TESTOPS_MOBILE_TEST_LOGIN_PHONE;
    try {
      await post(server.address().port, {
        sessionId: "s3",
        platform: "android",
        testCase: { steps: [] },
        testData: { TESTOPS_MOBILE_TEST_LOGIN_PHONE: "0123456789" },
      });
      assert.strictEqual(seen[0], "0123456789");
      assert.strictEqual(process.env.TESTOPS_MOBILE_TEST_LOGIN_PHONE, before);
    } finally {
      server.close();
    }
  });

  await test("a step/attach failure still responds 200 with success:false and a real error, never a crash", async () => {
    const { handleExecuteTestCase } = freshEndpointWithFakes({
      attachImpl: async () => {
        throw new Error("BROWSERSTACK_INVALID_SESSION: no such session");
      },
    });
    const server = await startTestServer(handleExecuteTestCase);
    try {
      const { status, json } = await post(server.address().port, {
        sessionId: "does-not-exist",
        platform: "android",
        testCase: { steps: [] },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /BROWSERSTACK_INVALID_SESSION/);
    } finally {
      server.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
