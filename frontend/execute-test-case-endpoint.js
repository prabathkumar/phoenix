/**
 * POST /api/execute-test-case -- the HTTP contract for option 2 of the
 * TestOps integration (decided 2026-10-04): TestOps already owns
 * BrowserStack credentials, device selection, app upload, and test-case/
 * test-data selection, and already opens the BrowserStack/Appium
 * session itself. TestOps Mobile's only job here is: attach to that already-
 * live session and drive the given test case against it -- never start
 * a session, never hold a BrowserStack credential, never close the
 * session when done (see engine/attach-session.js's header comment on
 * why teardown must stay TestOps's job).
 *
 * Gated the same way the other real-execution surface is
 * (mcp/server.js's run_test_case): TESTOPS_MOBILE_ENABLE_EXECUTE_API=1, off by
 * default, since this is a brand-new, never-yet-exercised-against-a-
 * real-TestOps-call surface.
 *
 * Request body (JSON):
 *   {
 *     "sessionId": "abc123",             // required -- TestOps's own session id
 *     "platform": "android" | "ios",     // required
 *     "hubUrl": {                        // optional, defaults to BrowserStack's hub
 *       "hostname": "hub-cloud.browserstack.com",
 *       "port": 443,
 *       "path": "/wd/hub"
 *     },
 *     "testCase": { "steps": [ ... ] },  // required -- same shape as a
 *                                        // test-cases/*.json file (a bare
 *                                        // steps array, or {steps: [...]})
 *     "testData": { "LOGIN_PHONE": "...", "LOGIN_PASSWORD": "..." }
 *                                        // optional -- resolves this test
 *                                        // case's "${VAR}" placeholders;
 *                                        // see engine/test-case-runner.js's
 *                                        // resolveStepText
 *   }
 *
 * Response (JSON): { success: boolean, detail: string }
 * or on a step/attach/validation failure: { success: false, error: string }
 *
 * NOT YET DONE on purpose -- this is the first cut of the contract, not
 * a finished integration:
 *   - no auth on this endpoint itself (assumed to sit behind TestOps's
 *     own network boundary, same assumption upload-session.js makes)
 *   - no concurrency guard across multiple simultaneous TestOps calls
 *     (session-manager.js's isSessionActive() guard doesn't apply here,
 *     since TestOps Mobile isn't the one managing the device/session lifecycle)
 *   - testData is applied via process.env for the duration of the call
 *     (matching how resolveStepText already reads secrets) and restored
 *     after -- fine for one request at a time, NOT safe for two
 *     concurrent requests with different testData on this same process;
 *     flagged here rather than silently shipped as if it were safe.
 */

const { attachSession } = require("../engine/attach-session");
const { runScriptSteps } = require("../engine/test-case-runner");
const { executeSemanticAction } = require("../engine/semantic-act-executor");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
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

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleExecuteTestCase(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    respondJson(res, 400, { success: false, error: err.message });
    return;
  }

  const { sessionId, platform, hubUrl = {}, testCase, testData = {} } = body;

  if (!sessionId) {
    respondJson(res, 400, { success: false, error: "sessionId is required (TestOps's own already-started session id)" });
    return;
  }
  if (platform !== "android" && platform !== "ios") {
    respondJson(res, 400, { success: false, error: 'platform must be "android" or "ios"' });
    return;
  }
  if (!testCase || (!Array.isArray(testCase) && !Array.isArray(testCase.steps))) {
    respondJson(res, 400, { success: false, error: "testCase must be a steps array, or an object with a steps array" });
    return;
  }

  const steps = Array.isArray(testCase) ? testCase : testCase.steps;

  // Applied for the duration of this call only -- see this file's header
  // comment on why this is not concurrency-safe across simultaneous
  // requests with different testData.
  const previousEnv = {};
  for (const [key, value] of Object.entries(testData)) {
    previousEnv[key] = process.env[key];
    process.env[key] = String(value);
  }

  let driver;
  try {
    driver = await attachSession({
      sessionId,
      hostname: hubUrl.hostname,
      port: hubUrl.port,
      path: hubUrl.path,
    });

    const result = await runScriptSteps(driver, steps, { platform, executeSemanticAction });
    respondJson(res, 200, { success: result.success, detail: result.detail });
  } catch (err) {
    respondJson(res, 200, { success: false, error: err.message });
  } finally {
    // Deliberately NOT calling driver.deleteSession() -- this session
    // belongs to TestOps, which started it and is the only party that
    // should end it. See engine/attach-session.js's header comment.
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

module.exports = { handleExecuteTestCase };
