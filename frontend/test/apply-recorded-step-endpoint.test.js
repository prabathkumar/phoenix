/**
 * Tests for POST /api/apply-recorded-step and POST /api/record-step/:id/stop
 * (frontend/apply-recorded-step-endpoint.js). Uses a real temp file under
 * test-cases/ (cleaned up after each test, same spirit as other tests
 * that touch real test-case files) and a fake recording-registry entry
 * built directly, not through record-step-endpoint.js -- that module's
 * own tests already cover how an entry gets created.
 *
 * Run with: npm test (from frontend/) or `node test/apply-recorded-step-endpoint.test.js`
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const { handleApplyRecordedStep, handleStopRecording } = require("../apply-recorded-step-endpoint");
const { recordings } = require("../recording-registry");

const TEST_CASES_DIR = path.join(__dirname, "..", "..", "test-cases");
const TMP_FILE_NAME = "testops-mobile-apply-recorded-step-test-tmp.json";
const TMP_FILE_PATH = path.join(TEST_CASES_DIR, TMP_FILE_NAME);

function writeTmpTestCase(steps) {
  fs.writeFileSync(TMP_FILE_PATH, JSON.stringify({ name: "tmp", steps }, null, 2));
}

function cleanupTmpFile() {
  if (fs.existsSync(TMP_FILE_PATH)) fs.unlinkSync(TMP_FILE_PATH);
}

function fakeRecordingEntry({ steps = [], platform = "android", sessionId = "s1" } = {}) {
  return {
    wss: { closed: false, close() { this.closed = true; } },
    recorder: { steps },
    driver: {},
    platform,
    sessionId,
    createdAt: Date.now(),
  };
}

function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/apply-recorded-step") {
      handleApplyRecordedStep(req, res);
      return;
    }
    const stopMatch = /^\/api\/record-step\/([^/]+)\/stop$/.exec(req.url);
    if (req.method === "POST" && stopMatch) {
      handleStopRecording(req, res, decodeURIComponent(stopMatch[1]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function post(port, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
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
  } finally {
    recordings.clear();
    cleanupTmpFile();
  }
}

async function main() {
  console.log("frontend/apply-recorded-step-endpoint.js:");

  await test("rejects a request missing recordingId", async () => {
    const server = await startTestServer();
    try {
      const { status, json } = await post(server.address().port, "/api/apply-recorded-step", {
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
      });
      assert.strictEqual(status, 400);
      assert.match(json.error, /recordingId is required/);
    } finally {
      server.close();
    }
  });

  await test("errors cleanly for an unknown/expired recordingId, never a crash", async () => {
    const server = await startTestServer();
    try {
      const { status, json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "does-not-exist",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /no active recording/);
    } finally {
      server.close();
    }
  });

  await test("errors when no tap has been recorded yet on this recording", async () => {
    recordings.set("rec1", fakeRecordingEntry({ steps: [] }));
    const server = await startTestServer();
    try {
      const { json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec1",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
      });
      assert.strictEqual(json.success, false);
      assert.match(json.error, /no tap has been recorded yet/);
    } finally {
      server.close();
    }
  });

  await test("writes the tapped element's {strategy, value} into the failing step as resolvedSelector", async () => {
    writeTmpTestCase([
      { kind: "tap", instruction: "tap the Add-ons tab or menu item" },
      { kind: "tap", instruction: "tap something else" },
    ]);
    recordings.set("rec2", fakeRecordingEntry({
      steps: [{
        resolvedElement: { strategy: "resource-id", value: "my.yes.yes4g:id/buyAddonLayout", text: "Buy Add-On" },
      }],
    }));
    const server = await startTestServer();
    try {
      const { status, json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec2",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, true);
      assert.deepStrictEqual(json.resolvedSelector, { strategy: "resource-id", value: "my.yes.yes4g:id/buyAddonLayout" });

      const written = JSON.parse(fs.readFileSync(TMP_FILE_PATH, "utf8"));
      assert.deepStrictEqual(written.steps[0].resolvedSelector, { strategy: "resource-id", value: "my.yes.yes4g:id/buyAddonLayout" });
      assert.match(written.steps[0].note, /Record this step/);
      // the OTHER step must be untouched
      assert.strictEqual(written.steps[1].resolvedSelector, undefined);
    } finally {
      server.close();
    }
  });

  await test("appends to an existing note rather than overwriting it", async () => {
    writeTmpTestCase([{ kind: "tap", instruction: "tap X", note: "Original hand-authored note." }]);
    recordings.set("rec3", fakeRecordingEntry({
      steps: [{ resolvedElement: { strategy: "xpath", value: "/hierarchy[1]/foo" } }],
    }));
    const server = await startTestServer();
    try {
      await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec3",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
      });
      const written = JSON.parse(fs.readFileSync(TMP_FILE_PATH, "utf8"));
      assert.match(written.steps[0].note, /^Original hand-authored note\./);
      assert.match(written.steps[0].note, /Record this step/);
    } finally {
      server.close();
    }
  });

  await test("picks a specific recorderStepIndex rather than always the last tap", async () => {
    writeTmpTestCase([{ kind: "tap", instruction: "tap X" }]);
    recordings.set("rec4", fakeRecordingEntry({
      steps: [
        { resolvedElement: { strategy: "text", value: "first guess (wrong)" } },
        { resolvedElement: { strategy: "resource-id", value: "second guess (right)" } },
      ],
    }));
    const server = await startTestServer();
    try {
      const { json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec4",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 0,
        recorderStepIndex: 0,
      });
      assert.deepStrictEqual(json.resolvedSelector, { strategy: "text", value: "first guess (wrong)" });
    } finally {
      server.close();
    }
  });

  await test("rejects an out-of-range stepIndex", async () => {
    writeTmpTestCase([{ kind: "tap", instruction: "only step" }]);
    recordings.set("rec5", fakeRecordingEntry({
      steps: [{ resolvedElement: { strategy: "text", value: "x" } }],
    }));
    const server = await startTestServer();
    try {
      const { json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec5",
        testCaseFile: TMP_FILE_NAME,
        stepIndex: 5,
      });
      assert.strictEqual(json.success, false);
      assert.match(json.error, /out of range/);
    } finally {
      server.close();
    }
  });

  await test("refuses to write outside test-cases/ (path traversal)", async () => {
    recordings.set("rec6", fakeRecordingEntry({
      steps: [{ resolvedElement: { strategy: "text", value: "x" } }],
    }));
    const server = await startTestServer();
    try {
      const { json } = await post(server.address().port, "/api/apply-recorded-step", {
        recordingId: "rec6",
        testCaseFile: "../../etc/passwd",
        stepIndex: 0,
      });
      assert.strictEqual(json.success, false);
      assert.match(json.error, /no such test case/);
    } finally {
      server.close();
    }
  });

  await test("POST /api/record-step/:id/stop closes the live-view server and removes the registry entry", async () => {
    const entry = fakeRecordingEntry();
    recordings.set("rec7", entry);
    const server = await startTestServer();
    try {
      const { status, json } = await post(server.address().port, "/api/record-step/rec7/stop", {});
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(entry.wss.closed, true);
      assert.strictEqual(recordings.has("rec7"), false);
    } finally {
      server.close();
    }
  });

  await test("stop on an unknown recordingId errors cleanly, never a crash", async () => {
    const server = await startTestServer();
    try {
      const { status, json } = await post(server.address().port, "/api/record-step/nope/stop", {});
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /no active recording/);
    } finally {
      server.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
