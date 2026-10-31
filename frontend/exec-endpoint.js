/**
 * POST /api/engine/exec: the execution service the Python backend calls. Node stays here because it drives
 * Playwright, Appium and BrowserStack. No planning, no Jira, no gateway: it runs steps and says what happened.
 *   {web?:{steps,url,runOn}, mobile?:{platform,steps,runOn,device,osVersion,appUrl}, api?:{steps,baseUrl}, testData?:{}, runId}
 * -> {ok, detail, parts:[...], failedCases:[{name,error,ranOn}], harPath?, ranOn:[...]}
 * Test-data values arrive in the request and are never returned or logged. HAR files go to PHOENIX_DATA_DIR/har (a volume shared with the API).
 */
const path = require("path");
const fs = require("fs");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 4e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
  });
}

async function runExecution(body, deps = {}) {
  const env = deps.env || process.env;
  const english = deps.englishRun || require("./english-endpoint").runAndWait;
  const values = body.testData && typeof body.testData === "object" ? body.testData : {};
  const parts = [], failedCases = [], ranOn = [];
  const dir = path.join(env.PHOENIX_DATA_DIR || require("os").tmpdir(), "har");
  let harPath;
  for (const [kind, spec] of [["web", body.web], ["mobile", body.mobile]]) {
    if (!spec || !String(spec.steps || "").trim()) continue;
    const har = kind === "web" ? path.join(dir, `${String(body.runId || "run").replace(/[^\w-]/g, "")}.har`) : undefined;
    if (har) fs.mkdirSync(dir, { recursive: true });
    try {
      const r = await english({ platform: kind === "web" ? "web" : spec.platform, steps: spec.steps, testData: values, url: spec.url, runOn: spec.runOn, device: spec.device, osVersion: spec.osVersion, appUrl: spec.appUrl, harPath: har });
      if (r.where) ranOn.push(`${kind}: ${r.where}`);
      if (har) harPath = har;
      const fails = (r.steps || []).filter((x) => x.status === "failed");
      fails.forEach((x) => failedCases.push({ name: `${kind}: ${x.text}`, error: String(x.reason || "").slice(0, 300), ranOn: { label: r.where || kind } }));
      if (r.status !== "passed" && !fails.length) failedCases.push({ name: `${kind} run`, error: String(r.reason || r.status).slice(0, 300), ranOn: { label: r.where || kind } });
      parts.push(`${kind} ${r.status} (${r.passed || 0} passed, ${r.failed || 0} failed)`);
    } catch (e) { failedCases.push({ name: `${kind} run`, error: e.message }); parts.push(`${kind} could not start`); }
  }
  // Case by case: each test case (with its own id) is run on its own, so every result can be signed off against that case.
  const results = [];
  for (const c of Array.isArray(body.cases) ? body.cases.slice(0, 50) : []) {
    const base = (c.platform === "mobile" ? body.mobile : body.web) || {};
    if (!c || !c.id || !String(c.steps || "").trim()) continue;
    const t0 = Date.now();
    try {
      const r = await english({ platform: c.platform === "mobile" ? base.platform : "web", steps: c.steps, testData: values, url: base.url, runOn: base.runOn, device: base.device, osVersion: base.osVersion, appUrl: base.appUrl });
      const failedStep = (r.steps || []).find((x) => x.status === "failed");
      const result = r.status === "passed" ? "passed" : "failed";
      results.push({ id: c.id, result, where: r.where || "", ms: Date.now() - t0, detail: result === "passed" ? "" : String((failedStep && failedStep.reason) || r.reason || r.status).slice(0, 300) });
      if (result === "failed") failedCases.push({ id: c.id, name: c.name || c.id, error: results[results.length - 1].detail, ranOn: { label: r.where || c.platform } });
    } catch (e) { results.push({ id: c.id, result: "blocked", ms: Date.now() - t0, detail: e.message.slice(0, 300) }); failedCases.push({ id: c.id, name: c.name || c.id, error: e.message }); }
  }
  if (results.length) parts.push(`${results.length} case(s): ${results.filter((x) => x.result === "passed").length} passed, ${results.filter((x) => x.result !== "passed").length} not passed`);
  const apiSteps = (Array.isArray(body.api && body.api.steps) ? body.api.steps : []).filter((s) => s && s.kind === "api");
  if (apiSteps.length) {
    const td = require("../engine/core/testdata");
    const runCases = deps.runApiCases || require("../engine/core/api-cases").runApiCases;
    const prepared = td.prepareApiSteps(apiSteps, { seed: "pipeline" });
    const r = await runCases({ steps: prepared.steps, testData: values, baseUrl: body.api.baseUrl, seed: "pipeline", negative: true });
    const all = [r.main, ...r.negatives].filter(Boolean);
    const bad = all.filter((x) => x.ok === false);
    bad.forEach((x) => failedCases.push({ name: x.name || "API case", error: String(x.detail || "").slice(0, 300) }));
    parts.push(`${all.length} API case(s), ${bad.length} failed`);
  }
  if (!parts.length) return { unavailable: true, detail: "give web or mobile English steps, or API steps, to run", parts, failedCases, ranOn };
  return { ok: failedCases.length === 0, detail: `${parts.join("; ")}${ranOn.length ? " · " + ranOn.join(" · ") : ""}`, parts, results, failedCases, ranOn, ...(harPath ? { harPath } : {}) };
}

async function handleExec(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body; try { body = await readJson(req); } catch (e) { return send(400, { error: `Bad request: ${e.message}` }); }
  try { send(200, await runExecution(body)); } catch (e) { send(500, { error: e.message }); }
}
module.exports = { handleExec, runExecution };
