/**
 * Tester-facing recording UI — serves frontend/index.html and, since
 * the upload flow was added, POST /api/sessions (upload-session.js),
 * which lets a tester upload a .ipa/.apk directly and starts a
 * recording session against it on demand.
 *
 * No build step, no framework: index.html is a single self-contained
 * page (vanilla JS) that connects directly to the live-view WebSocket
 * a started session returns. This file exists so the page is served
 * over http:// instead of opened as file://, sidestepping any browser
 * origin quirks around WebSocket connections from local files.
 *
 * Run: cd frontend && npm install && node server.js
 * Then open: http://localhost:8091/
 *
 * (The older env-var-configured flow — set TESTOPS_MOBILE_STAGE0_APP_PATH etc.
 * and run `node run-session.js` before opening this page — still works
 * unchanged; see README's "Uploading an app directly" section for how
 * the two relate.)
 *
 * POST /api/semantic-action (frontend/semantic-action-endpoint.js) is
 * an EXPERIMENTAL, opt-in endpoint for Phase 2's semantic action layer
 * (docs/TESTOPS_MOBILE_SPEC.md §6) — only registered when
 * TESTOPS_MOBILE_ENABLE_SEMANTIC_API=1 is set, off by default. See that
 * module's header for why it's gated: it's never been run against a
 * real device, and dev-team adoption of the semantic layer is
 * deliberately being held until that's proven.
 *
 * POST /api/execute-test-case (frontend/execute-test-case-endpoint.js)
 * is the TestOps integration contract decided 2026-10-04: TestOps opens
 * its own BrowserStack session (it already owns the credentials, device
 * selection, and app upload) and calls this endpoint with that session's
 * id plus a test case + test data for TestOps Mobile to drive against it.
 * Gated behind TESTOPS_MOBILE_ENABLE_EXECUTE_API=1, off by default -- brand
 * new, never yet exercised against a real TestOps call.
 *
 * /mock-testops.html + /api/mock/* (frontend/mock-testops-endpoints.js)
 * is a walkthrough of the above sequence while TestOps itself doesn't
 * exist yet: upload an app, pick a BrowserStack device, pick a real
 * test-cases/*.json file, trigger, watch it "run" step by step. The
 * app upload/device list/session creation are mocked (no real
 * BrowserStack call); the test cases and their steps are real. Always
 * on (no gate) since nothing here touches a real device or credential.
 *
 * POST /api/record-step, POST /api/apply-recorded-step, and
 * POST /api/record-step/:id/stop (frontend/record-step-endpoint.js,
 * frontend/apply-recorded-step-endpoint.js) are the "Record this step"
 * manual fallback: when a test-case step fails to resolve, TestOps's
 * still-open session (never torn down on failure) is handed to a
 * live-view instance so a tester can tap the real element themselves;
 * the resulting selector is written into the test case's step. Gated
 * behind TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1, off by default --
 * brand new, never yet exercised against a real TestOps call.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { handleUploadAndStart } = require("./upload-session");
const mockTestOps = require("./mock-testops-endpoints");

const PORT = Number(process.env.TESTOPS_MOBILE_FRONTEND_PORT) || 8091;
const INDEX_PATH = path.join(__dirname, "index.html");
const MOCK_TESTOPS_PATH = path.join(__dirname, "mock-testops.html");
const SEMANTIC_API_ENABLED = process.env.TESTOPS_MOBILE_ENABLE_SEMANTIC_API === "1";
const EXECUTE_API_ENABLED = process.env.TESTOPS_MOBILE_ENABLE_EXECUTE_API === "1";
const RECORD_STEP_API_ENABLED = process.env.TESTOPS_MOBILE_ENABLE_RECORD_STEP_API === "1";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/sessions") {
    handleUploadAndStart(req, res);
    return;
  }

  if (SEMANTIC_API_ENABLED && req.method === "POST" && req.url === "/api/semantic-action") {
    // Lazily required so the executor/session-manager/generation chain
    // it pulls in is only loaded when this experimental path is
    // actually turned on.
    require("./semantic-action-endpoint").handleSemanticAction(req, res);
    return;
  }

  if (EXECUTE_API_ENABLED && req.method === "POST" && req.url === "/api/execute-test-case") {
    require("./execute-test-case-endpoint").handleExecuteTestCase(req, res);
    return;
  }

  if (RECORD_STEP_API_ENABLED && req.method === "POST" && req.url === "/api/record-step") {
    require("./record-step-endpoint").handleRecordStep(req, res);
    return;
  }

  if (RECORD_STEP_API_ENABLED && req.method === "POST" && req.url === "/api/apply-recorded-step") {
    require("./apply-recorded-step-endpoint").handleApplyRecordedStep(req, res);
    return;
  }

  if (RECORD_STEP_API_ENABLED && req.method === "POST" && /^\/api\/record-step\/[^/]+\/stop$/.test(req.url)) {
    const recordingId = decodeURIComponent(req.url.split("/")[3]);
    require("./apply-recorded-step-endpoint").handleStopRecording(req, res, recordingId);
    return;
  }

  if (req.method === "GET" && req.url === "/mock-testops.html") {
    fs.readFile(MOCK_TESTOPS_PATH, "utf8", (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("Failed to read mock-testops.html: " + err.message);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/mock/devices") {
    mockTestOps.handleListDevices(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/mock/test-cases") {
    mockTestOps.handleListTestCases(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/mock/test-cases/")) {
    const fileName = decodeURIComponent(req.url.slice("/api/mock/test-cases/".length));
    mockTestOps.handleGetTestCase(req, res, fileName);
    return;
  }

  if (req.method === "POST" && req.url === "/api/mock/run") {
    mockTestOps.handleRun(req, res);
    return;
  }

  fs.readFile(INDEX_PATH, "utf8", (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Failed to read index.html: " + err.message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`[frontend] serving http://localhost:${PORT}/`);
  console.log("[frontend] upload a .ipa/.apk from the page to start a session, or set");
  console.log("[frontend] TESTOPS_MOBILE_STAGE0_APP_PATH/TESTOPS_MOBILE_IOS_APP_PATH/TESTOPS_MOBILE_BROWSERSTACK_APP_URL");
  console.log("[frontend] and run `node run-session.js` separately, as before.");
  if (SEMANTIC_API_ENABLED) {
    console.log("[frontend] TESTOPS_MOBILE_ENABLE_SEMANTIC_API=1 set — POST /api/semantic-action is live (experimental, unproven on real hardware).");
  }
  if (RECORD_STEP_API_ENABLED) {
    console.log("[frontend] TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1 set — POST /api/record-step + /api/apply-recorded-step are live (experimental, unproven on real hardware).");
  }
  console.log(`[frontend] mock TestOps walkthrough: http://localhost:${PORT}/mock-testops.html (mocked device/session, real test cases)`);
});
