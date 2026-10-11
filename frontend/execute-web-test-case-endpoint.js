/**
 * POST /api/execute-web-test-case  (opt-in: TESTOPS_MOBILE_ENABLE_WEB_API=1)
 *
 * Web counterpart of /api/execute-test-case: runs a test case's steps in
 * a Playwright browser and returns the shared pass/fail contract
 * (engine/test-result.js) -- the same shape TestOps already reads for
 * android/ios.
 *
 * Body: { testCase: <steps array | {steps, testopsRef?}>, baseUrl?, testData?: {ENV: "value"}, headless?, testopsRef?, cycleRef? }
 * With a testopsRef (e.g. "APP-TC-1") the result is also pushed via engine/testops-adapter.js
 * (response gains `testopsPush`); the pass/fail outcome is never affected by the push.
 */
const { runWebTestCase } = require("../web/web-test-case-runner");
const { pushResult } = require("../engine/testops-adapter");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 5 * 1024 * 1024) { reject(new Error("request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); } });
    req.on("error", reject);
  });
}
function respondJson(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

async function handleExecuteWebTestCase(req, res, deps = {}) {
  const run = deps.runWebTestCase || runWebTestCase;
  const push = deps.pushResult || pushResult;
  let body;
  try { body = await readJsonBody(req); } catch (e) { return respondJson(res, 400, { success: false, error: e.message }); }
  const { testCase, baseUrl, testData = {}, headless, cycleRef } = body;
  const testopsRef = body.testopsRef || (testCase && testCase.testopsRef);
  if (!testCase || (!Array.isArray(testCase) && !Array.isArray(testCase.steps))) {
    return respondJson(res, 400, { success: false, error: "testCase must be a steps array, or an object with a steps array" });
  }
  const steps = Array.isArray(testCase) ? testCase : testCase.steps;
  const previousEnv = {};
  for (const [k, v] of Object.entries(testData)) { previousEnv[k] = process.env[k]; process.env[k] = String(v); }
  try {
    const result = await run(steps, { baseUrl, headless, testCase: testCase.name });
    // Optional push to TestOps when the case is linked (testopsRef). Never
    // changes the outcome; failures are reported in `testopsPush`.
    if (testopsRef) result.testopsPush = await push(result, { testopsRef, cycleRef });
    respondJson(res, 200, result);
  } catch (e) {
    respondJson(res, 200, { success: false, status: "fail", platform: "web", detail: `run error: ${e.message}`, error: e.message });
  } finally {
    for (const [k, v] of Object.entries(previousEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

module.exports = { handleExecuteWebTestCase };
