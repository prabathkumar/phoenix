/**
 * POST /api/sync-test-cases  (opt-in: TESTOPS_MOBILE_ENABLE_GIT_SYNC=1)
 * Body: { files?: ["login.json"], message?: "...", push?: true }
 * Commits + pushes test-cases/*.json via engine/git-sync.js (secret-checked,
 * never force-pushes). GET /api/test-case-history?file=login.json lists versions.
 */
const path = require("path");
const { syncTestCases, testCaseHistory } = require("../engine/git-sync");

const REPO_DIR = path.join(__dirname, "..");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1024 * 1024) { reject(new Error("request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); } });
    req.on("error", reject);
  });
}
function respondJson(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

async function handleSyncTestCases(req, res, deps = {}) {
  const sync = deps.syncTestCases || syncTestCases;
  let body;
  try { body = await readJsonBody(req); } catch (e) { return respondJson(res, 400, { success: false, error: e.message }); }
  if (body.files !== undefined && !(Array.isArray(body.files) && body.files.every((f) => typeof f === "string"))) {
    return respondJson(res, 400, { success: false, error: "files must be an array of test-case file names" });
  }
  const result = await sync({ repoDir: deps.repoDir || REPO_DIR, files: body.files, message: body.message, push: body.push !== false });
  respondJson(res, result.success ? 200 : 422, result);
}

async function handleTestCaseHistory(req, res, deps = {}) {
  const history = deps.testCaseHistory || testCaseHistory;
  const file = new URL(req.url, "http://x").searchParams.get("file");
  if (!file) return respondJson(res, 400, { success: false, error: "file query parameter is required" });
  try { respondJson(res, 200, { success: true, history: await history({ repoDir: deps.repoDir || REPO_DIR, file }) }); }
  catch (e) { respondJson(res, 500, { success: false, error: e.message }); }
}

module.exports = { handleSyncTestCases, handleTestCaseHistory };
