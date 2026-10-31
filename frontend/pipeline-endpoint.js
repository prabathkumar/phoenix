/**
 * POST /api/pipeline/run: one request runs the whole AI-driven pipeline.
 *   {goal, requirement? | jiraKey?, steps?, baseUrl?, appUrl?, project?, testData?,
 *    autonomy?: "ask-everything"|"ask-when-matters"|"run-everything", approvals?:{stageId:true}, production?}
 * -> {ok, plan, stages:[{id,status,detail,decided,ai}], summary, needsYou:[stageId]}
 * Needs-you stages (live scan, Jira, production, or your autonomy level) come back with their
 * id; send the same request again with approvals:{id:true} to let them run.
 * API execution runs here with no device; web and mobile runs start from the English page.
 */
const td = require("../engine/core/testdata");
const J = require("../engine/core/jira");
const { runAiPipeline } = require("../engine/core/ai-pipeline");
const { allHandlers } = require("../engine/core/handlers");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
  });
}

/** Testable core. deps: {callJson, getPrompt, jira, runApiCases, exec, env} */
async function runPipelineRequest(body, deps = {}) {
  const env = deps.env || process.env;
  if (!String(body.goal || "").trim()) return { code: 400, json: { error: "Say what to test (goal)." } };
  const autonomy = ["ask-everything", "ask-when-matters", "run-everything"].includes(body.autonomy) ? body.autonomy : "ask-when-matters";
  let requirement = typeof body.requirement === "string" ? body.requirement : "";
  const jira = deps.jira || J.client({ env });
  if (!requirement && body.jiraKey) {
    try { requirement = (await J.readRequirement(jira, String(body.jiraKey))).text; } catch (e) { return { code: 400, json: { error: e.message } }; }
  }
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const baseUrl = typeof body.baseUrl === "string" && /^https?:\/\//i.test(body.baseUrl) ? body.baseUrl : undefined;
  const runCases = deps.runApiCases || require("../engine/core/api-cases").runApiCases;
  let values = {};
  const failedCases = [];
  const handlers = allHandlers({
    callJson: deps.callJson, getPrompt: deps.getPrompt, exec: deps.exec,
    extra: {
      testdata: async () => {
        const { plan, error } = require("./testdata-endpoint").buildPlan({ steps, provided: body.testData, project: body.project });
        if (error) return { ok: false, detail: error };
        values = plan.values;
        return plan.needsYou.length ? { ok: false, detail: `needs you: ${plan.needsYou.join(", ")}` } : { ok: true, detail: `${plan.fields.length} field(s) ready` };
      },
      execution: async () => {
        if (!steps.some((s) => s && s.kind === "api")) return { unavailable: true, detail: "no API steps here; run web and mobile cases from the English page" };
        const prepared = td.prepareApiSteps(steps, { seed: "pipeline" });
        const r = await runCases({ steps: prepared.steps, testData: values, baseUrl, seed: "pipeline", negative: true });
        const bad = [r.main, ...r.negatives].filter((x) => x && x.ok === false);
        bad.forEach((x) => failedCases.push({ name: x.name || "API case", error: String(x.detail || "").slice(0, 300) }));
        return { ok: bad.length === 0, detail: `${1 + r.negatives.length} case(s), ${bad.length} failed` };
      },
      defects: async (ctx) => J.defectsHandler(jira, { requirement: body.jiraKey, secrets: Object.values(values) })({ ...ctx, failedCases }),
    },
  });
  const out = await runAiPipeline({
    goal: body.goal, requirement, ctx: { steps, baseUrl, appUrl: body.appUrl, requirement, goal: body.goal }, handlers,
    autonomy, approvals: body.approvals && typeof body.approvals === "object" ? body.approvals : {}, production: body.production === true,
    callJson: deps.callJson, exec: deps.exec, env,
  });
  const clean = out.stages.map(({ data, ...s }) => s); // data can hold values; never returned
  return { code: 200, json: { ok: out.ok, plan: { source: out.plan.source, platforms: out.plan.platforms, reason: out.plan.reason }, stages: clean, summary: out.summary, needsYou: out.needsYou } };
}

async function handlePipelineRun(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body; try { body = await readJson(req); } catch (e) { return send(400, { error: `Bad request: ${e.message}` }); }
  let callJson; try { callJson = require("../generation/llm").callOllamaJson; } catch { /* no model: stages say so */ }
  try { const r = await runPipelineRequest(body, { callJson }); send(r.code, r.json); } catch (e) { send(500, { error: e.message }); }
}

module.exports = { handlePipelineRun, runPipelineRequest };
