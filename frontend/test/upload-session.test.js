/**
 * Tests for upload-session.js's POST /api/sessions handler — the
 * platform-detection, validation, and error-response logic around the
 * multipart upload, not a real BrowserStack upload or Appium session.
 * engine/session-manager.js, engine/browserstack-upload.js, and
 * engine/remote-provider.js are faked via require.cache injection
 * (same approach as engine/test/session-manager.test.js) so this runs
 * with no network access and no real file ever reaching BrowserStack.
 *
 * Uses a real HTTP server + native fetch/FormData so the multipart
 * parsing (busboy) is exercised for real — only what's *behind* the
 * parse is faked.
 *
 * Run with: npm test (from frontend/) or `node test/upload-session.test.js`
 */

const assert = require("assert");
const http = require("http");

const SESSION_MANAGER_PATH = require.resolve("../../engine/session-manager");
const BROWSERSTACK_UPLOAD_PATH = require.resolve("../../engine/browserstack-upload");
const REMOTE_PROVIDER_PATH = require.resolve("../../engine/remote-provider");
const UPLOAD_SESSION_PATH = require.resolve("../upload-session");

function fakeModule(exports) {
  return { loaded: true, exports };
}

function freshUploadSessionWithFakes({ provider = "local", isSessionActive = false, startRecordingSessionImpl, uploadAppImpl } = {}) {
  for (const p of [SESSION_MANAGER_PATH, BROWSERSTACK_UPLOAD_PATH, REMOTE_PROVIDER_PATH, UPLOAD_SESSION_PATH]) {
    delete require.cache[p];
  }

  const startRecordingSessionCalls = [];
  require.cache[SESSION_MANAGER_PATH] = fakeModule({
    isSessionActive: () => isSessionActive,
    startRecordingSession: async (opts) => {
      startRecordingSessionCalls.push(opts);
      if (startRecordingSessionImpl) return startRecordingSessionImpl(opts);
      return { platform: opts.platform, port: 19100, sessionId: "fake-session-1" };
    },
  });

  const uploadAppCalls = [];
  require.cache[BROWSERSTACK_UPLOAD_PATH] = fakeModule({
    uploadApp: async (filePath) => {
      uploadAppCalls.push(filePath);
      if (uploadAppImpl) return uploadAppImpl(filePath);
      return "bs://fake-uploaded-id";
    },
  });

  require.cache[REMOTE_PROVIDER_PATH] = fakeModule({
    LOCAL: "local",
    BROWSERSTACK: "browserstack",
    provider: () => provider,
  });

  const { handleUploadAndStart } = require("../upload-session");
  return { handleUploadAndStart, startRecordingSessionCalls, uploadAppCalls };
}

function startTestServer(handleUploadAndStart) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/sessions") {
      handleUploadAndStart(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

async function postFile(port, { filename, content = "fake app bytes", platformField } = {}) {
  const formData = new FormData();
  if (filename) {
    formData.append("app", new Blob([content]), filename);
  }
  if (platformField) {
    formData.append("platform", platformField);
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", body: formData });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function test(name, fn) {
  return { name, fn };
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

async function main() {
  console.log("frontend/upload-session:");

  await run("detects Android from a .apk extension and starts a local-provider session with the file path as appium:app", async () => {
    const { handleUploadAndStart, startRecordingSessionCalls } = freshUploadSessionWithFakes({ provider: "local" });
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "MyApp.apk" });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.platform, "android");
      assert.strictEqual(startRecordingSessionCalls.length, 1);
      assert.strictEqual(startRecordingSessionCalls[0].platform, "android");
      assert.ok(
        startRecordingSessionCalls[0].capabilityOverrides["appium:app"].endsWith(".apk"),
        "expected the local provider to pass the saved file's path through as appium:app"
      );
    } finally {
      server.close();
    }
  });

  await run("detects iOS from a .ipa extension and uploads to BrowserStack for a bs:// URL when that provider is active", async () => {
    const { handleUploadAndStart, uploadAppCalls, startRecordingSessionCalls } = freshUploadSessionWithFakes({ provider: "browserstack" });
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "BitBarSampleApp.ipa" });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.platform, "ios");
      assert.strictEqual(uploadAppCalls.length, 1, "expected uploadApp() to be called for the browserstack provider");
      assert.strictEqual(startRecordingSessionCalls[0].capabilityOverrides["appium:app"], "bs://fake-uploaded-id");
    } finally {
      server.close();
    }
  });

  await run("rejects an unrecognized file extension with no platform field", async () => {
    const { handleUploadAndStart } = freshUploadSessionWithFakes();
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "notes.txt" });
      assert.strictEqual(status, 400);
      assert.ok(/Android or iOS/.test(body.error));
    } finally {
      server.close();
    }
  });

  await run("an explicit platform field overrides an ambiguous/missing extension", async () => {
    const { handleUploadAndStart, startRecordingSessionCalls } = freshUploadSessionWithFakes({ provider: "local" });
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "build-42", platformField: "android" });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.platform, "android");
      assert.strictEqual(startRecordingSessionCalls[0].platform, "android");
    } finally {
      server.close();
    }
  });

  await run("returns 409 without touching the filesystem/provider when a session is already active", async () => {
    const { handleUploadAndStart, startRecordingSessionCalls, uploadAppCalls } = freshUploadSessionWithFakes({
      provider: "browserstack",
      isSessionActive: true,
    });
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "MyApp.ipa" });
      assert.strictEqual(status, 409);
      assert.ok(/full/.test(body.error));
      assert.strictEqual(startRecordingSessionCalls.length, 0);
      assert.strictEqual(uploadAppCalls.length, 0);
    } finally {
      server.close();
    }
  });

  await run("returns 400 when no file field is present", async () => {
    const { handleUploadAndStart } = freshUploadSessionWithFakes();
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, {}); // no filename => no file appended
      assert.strictEqual(status, 400);
      assert.ok(/No file was uploaded/.test(body.error));
    } finally {
      server.close();
    }
  });

  await run("returns 502 with the underlying error message when starting the session fails", async () => {
    const { handleUploadAndStart } = freshUploadSessionWithFakes({
      provider: "local",
      startRecordingSessionImpl: async () => {
        throw new Error("Appium host unreachable");
      },
    });
    const server = await startTestServer(handleUploadAndStart);
    try {
      const { status, body } = await postFile(server.address().port, { filename: "MyApp.apk" });
      assert.strictEqual(status, 502);
      assert.strictEqual(body.error, "Appium host unreachable");
    } finally {
      server.close();
    }
  });
}

main().then(() => {
  if (process.exitCode) {
    console.error("\nfrontend/upload-session tests FAILED");
    process.exit(1);
  } else {
    console.log("\nfrontend/upload-session tests passed");
  }
});
