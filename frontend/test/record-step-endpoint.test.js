/**
 * Tests for POST /api/record-step (frontend/record-step-endpoint.js) --
 * the first half of the "Record this step" manual fallback. Fakes
 * engine/attach-session.js and live-view/server.js via require.cache
 * injection (same approach as execute-test-case-endpoint.test.js), so
 * no real BrowserStack session or WebSocket server is needed. Uses the
 * real capture/recorder.js (SessionRecorder's constructor does no I/O)
 * and the real recording-registry.js (a plain in-memory Map).
 *
 * Run with: npm test (from frontend/) or `node test/record-step-endpoint.test.js`
 */

const assert = require("assert");
const http = require("http");
const EventEmitter = require("events");

const ATTACH_PATH = require.resolve("../../engine/attach-session");
const LIVE_VIEW_PATH = require.resolve("../../live-view/server");
const ENDPOINT_PATH = require.resolve("../record-step-endpoint");
const REGISTRY_PATH = require.resolve("../recording-registry");

function fakeModule(exports) {
  return { loaded: true, exports };
}

function makeFakeWss(port) {
  const wss = new EventEmitter();
  wss.address = () => ({ port });
  wss.close = () => {};
  // startLiveView's real caller does wss.once("listening", ...) -- fire
  // it on the next tick, same as a real net.Server would once bound.
  process.nextTick(() => wss.emit("listening"));
  return wss;
}

function freshEndpointWithFakes({ attachImpl, startLiveViewImpl } = {}) {
  for (const p of [ATTACH_PATH, LIVE_VIEW_PATH, ENDPOINT_PATH, REGISTRY_PATH]) {
    delete require.cache[p];
  }

  const attachCalls = [];
  require.cache[ATTACH_PATH] = fakeModule({
    attachSession: async (opts) => {
      attachCalls.push(opts);
      if (attachImpl) return attachImpl(opts);
      return { fakeDriver: true, sessionId: opts.sessionId };
    },
  });

  const startLiveViewCalls = [];
  require.cache[LIVE_VIEW_PATH] = fakeModule({
    startLiveView: (driver, recorder, port, platform) => {
      startLiveViewCalls.push({ driver, recorder, port, platform });
      if (startLiveViewImpl) return startLiveViewImpl(driver, recorder, port, platform);
      return makeFakeWss(54321);
    },
  });

  const { handleRecordStep } = require(ENDPOINT_PATH);
  const { recordings } = require(REGISTRY_PATH);
  return { handleRecordStep, attachCalls, startLiveViewCalls, recordings };
}

function startTestServer(handleRecordStep) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/record-step") {
      handleRecordStep(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/record-step`, {
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
  console.log("frontend/record-step-endpoint.js:");

  await test("rejects a request missing sessionId", async () => {
    const { handleRecordStep } = freshEndpointWithFakes();
    const server = await startTestServer(handleRecordStep);
    try {
      const { status, json } = await post(server.address().port, { platform: "android" });
      assert.strictEqual(status, 400);
      assert.match(json.error, /sessionId is required/);
    } finally {
      server.close();
    }
  });

  await test("rejects an invalid platform", async () => {
    const { handleRecordStep } = freshEndpointWithFakes();
    const server = await startTestServer(handleRecordStep);
    try {
      const { status, json } = await post(server.address().port, { sessionId: "s1", platform: "symbian" });
      assert.strictEqual(status, 400);
      assert.match(json.error, /platform must be/);
    } finally {
      server.close();
    }
  });

  await test("attaches to the SAME failed sessionId (never starts a new session) and starts live-view against it", async () => {
    const { handleRecordStep, attachCalls, startLiveViewCalls } = freshEndpointWithFakes();
    const server = await startTestServer(handleRecordStep);
    try {
      const { status, json } = await post(server.address().port, {
        sessionId: "testops-session-99",
        platform: "android",
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(attachCalls.length, 1);
      assert.strictEqual(attachCalls[0].sessionId, "testops-session-99");
      assert.strictEqual(startLiveViewCalls.length, 1);
      assert.strictEqual(startLiveViewCalls[0].platform, "android");
      // port 0 requested from startLiveView -- the OS picks a free one,
      // confirmed back via wss.address().port in the response.
      assert.strictEqual(startLiveViewCalls[0].port, 0);
      assert.strictEqual(json.port, 54321);
      assert.ok(json.recordingId);
    } finally {
      server.close();
    }
  });

  await test("registers the recording so apply-recorded-step-endpoint.js can find it", async () => {
    const { handleRecordStep, recordings } = freshEndpointWithFakes();
    const server = await startTestServer(handleRecordStep);
    try {
      const { json } = await post(server.address().port, { sessionId: "s2", platform: "ios" });
      assert.ok(recordings.has(json.recordingId));
      const entry = recordings.get(json.recordingId);
      assert.strictEqual(entry.sessionId, "s2");
      assert.strictEqual(entry.platform, "ios");
    } finally {
      server.close();
    }
  });

  await test("an attach failure responds 200 with success:false and a real error, never a crash", async () => {
    const { handleRecordStep } = freshEndpointWithFakes({
      attachImpl: async () => {
        throw new Error("Session not started or terminated");
      },
    });
    const server = await startTestServer(handleRecordStep);
    try {
      const { status, json } = await post(server.address().port, { sessionId: "gone", platform: "android" });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /Session not started/);
    } finally {
      server.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
