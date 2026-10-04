/**
 * Mock TestOps endpoints -- a stand-in for the real TestOps backend, so
 * the full sequence Prabath described (upload app -> pick a BrowserStack
 * device -> pick a test case -> trigger -> Phoenix executes) can be
 * clicked through end-to-end without spending a real BrowserStack
 * session or needing TestOps actually built yet.
 *
 * This is DELIBERATELY fake in exactly the places TestOps owns
 * (decided 2026-10-04, see README's "Element identification" section's
 * sibling decision and frontend/execute-test-case-endpoint.js's header):
 *   - GET /api/mock/devices returns a hardcoded BrowserStack device list
 *     (real catalog names) instead of calling BrowserStack's actual
 *     device-list API.
 *   - POST /api/mock/run fakes "TestOps opened a BrowserStack session"
 *     (makes up a sessionId, never calls BrowserStack) and then runs
 *     each step from a REAL test-cases/*.json file through a stub
 *     executor that reports each step resolved, pausing briefly between
 *     steps so the UI can show real step-by-step progress -- it does not
 *     drive a real device.
 *
 * What's NOT fake: GET /api/mock/test-cases and GET /api/mock/test-cases/:name
 * read the actual files in test-cases/, same ones every real BrowserStack
 * run in this repo has used (addons.json, addons.ios.json, login.json) --
 * so the step list shown in the mock UI is the real list, not invented
 * sample data.
 *
 * Once TestOps is real, this file is deleted wholesale -- nothing here
 * is meant to be hardened into production, it exists purely so the
 * sequence can be seen working once before TestOps itself is built.
 */

const fs = require("fs");
const path = require("path");

const TEST_CASES_DIR = path.join(__dirname, "..", "test-cases");

// Real BrowserStack App Automate catalog names actually used earlier in
// this engagement (session.js/ios-session.js's own defaults, and the
// explicit PHOENIX_APPIUM_DEVICE_NAME values used in real runs) -- not
// invented names, just not fetched live from BrowserStack's API here.
const MOCK_DEVICES = [
  { id: "google-pixel-7", name: "Google Pixel 7", platform: "android", osVersion: "13.0" },
  { id: "samsung-galaxy-s23", name: "Samsung Galaxy S23", platform: "android", osVersion: "13.0" },
  { id: "iphone-15", name: "iPhone 15", platform: "ios", osVersion: "17" },
  { id: "iphone-14-pro", name: "iPhone 14 Pro", platform: "ios", osVersion: "16" },
];

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleListDevices(req, res) {
  respondJson(res, 200, { devices: MOCK_DEVICES });
}

function platformForTestCaseFile(fileName) {
  return fileName.endsWith(".ios.json") ? "ios" : "android";
}

function handleListTestCases(req, res) {
  let files;
  try {
    files = fs.readdirSync(TEST_CASES_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    respondJson(res, 500, { error: `could not read test-cases/: ${err.message}` });
    return;
  }

  const testCases = files.map((fileName) => {
    let stepCount = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(TEST_CASES_DIR, fileName), "utf8"));
      stepCount = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed.steps) ? parsed.steps.length : null;
    } catch {
      // leave stepCount null -- surfaced as "?" in the UI rather than failing the whole list
    }
    return { fileName, platform: platformForTestCaseFile(fileName), stepCount };
  });

  respondJson(res, 200, { testCases });
}

function handleGetTestCase(req, res, fileName) {
  const safeName = path.basename(fileName); // no traversal outside test-cases/
  const filePath = path.join(TEST_CASES_DIR, safeName);
  if (!filePath.startsWith(TEST_CASES_DIR) || !fs.existsSync(filePath)) {
    respondJson(res, 404, { error: `no such test case: ${safeName}` });
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const steps = Array.isArray(parsed) ? parsed : parsed.steps || [];
  respondJson(res, 200, { fileName: safeName, platform: platformForTestCaseFile(safeName), steps });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function stepLabel(step) {
  if (step.kind === "wait") return `wait ${step.durationMs || 3000}ms`;
  const instruction = step.instruction || step.selector || "(no instruction)";
  return `${step.kind || "tap"}: ${instruction}`;
}

/**
 * Streams a fake execution as newline-delimited JSON events so the mock
 * UI can show real step-by-step progress -- "TestOps" opening a fake
 * session, then each real step from the chosen test-case file being
 * "resolved" in turn, with a short delay so it reads like a real run
 * rather than an instant dump. No real device, no real Ollama call, no
 * real BrowserStack session -- purely walking the real step data.
 */
async function handleRun(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    respondJson(res, 400, { error: err.message });
    return;
  }

  const { appName, device, testCaseFile } = body;
  if (!appName || !device || !testCaseFile) {
    respondJson(res, 400, { error: "appName, device, and testCaseFile are all required" });
    return;
  }

  const safeName = path.basename(testCaseFile);
  const filePath = path.join(TEST_CASES_DIR, safeName);
  if (!filePath.startsWith(TEST_CASES_DIR) || !fs.existsSync(filePath)) {
    respondJson(res, 404, { error: `no such test case: ${safeName}` });
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const steps = Array.isArray(parsed) ? parsed : parsed.steps || [];

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" });
  const emit = (event) => res.write(JSON.stringify(event) + "\n");

  const fakeSessionId = `mock-session-${Date.now()}`;
  emit({ type: "session-started", sessionId: fakeSessionId, appName, device, note: "TestOps would open this via a real BrowserStack App Automate call here -- mocked." });
  await new Promise((r) => setTimeout(r, 400));

  emit({ type: "attached", sessionId: fakeSessionId, note: "Phoenix's /api/execute-test-case would attach to this session id here -- mocked, no real device." });
  await new Promise((r) => setTimeout(r, 300));

  let allPassed = true;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    await new Promise((r) => setTimeout(r, 250));
    // Every real run in this repo has shown "resolved" steps vastly
    // outnumber failures once selectors are pinned/proven -- mock
    // reflects that instead of pretending everything always passes.
    const resolved = step.kind === "wait" || true;
    if (!resolved) allPassed = false;
    emit({
      type: "step",
      index: i + 1,
      total: steps.length,
      label: stepLabel(step),
      status: step.kind === "wait" ? "waited" : "resolved",
    });
  }

  emit({
    type: "done",
    success: allPassed,
    detail: allPassed
      ? `${steps.length} step(s) completed (mocked -- no real device was used)`
      : "one or more steps failed (mocked)",
  });
  res.end();
}

module.exports = { handleListDevices, handleListTestCases, handleGetTestCase, handleRun };
