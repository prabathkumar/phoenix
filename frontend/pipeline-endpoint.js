/**
 * POST /api/pipeline/run: one request runs the whole AI-driven pipeline.
 *   {goal, requirement? | jiraKey?, steps?, baseUrl?, appUrl?, project?, testData?,
 *    autonomy?: "ask-everything"|"ask-when-matters"|"run-everything", approvals?:{stageId:true}, production?}
 * -> {ok, runId, retest, plan, stages:[{id,status,detail,decided,ai}], summary, needsYou:[stageId]}
 * Needs-you stages (live scan, Jira, production, or your autonomy level) come back with their
 * id; send the same request again with approvals:{id:true} to let them run.
 * API execution runs here with no device; web and mobile runs start from the English page.
 */
const td = require("../engine/core/testdata");
const J = require("../engine/core/jira");
const { runAiPipeline } = require("../engine/core/ai-pipeline");
const { allHandlers } = require("../engine/core/handlers");
const runs = require("../engine/core/run-record");
const gw = require("../engine/gateway/gateway");

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
  const runId = runs.newId();
  // What earlier runs of this requirement found, and which of their Jira defects are now fixed: the plan starts from that.
  const prior = runs.priorFor(body.jiraKey, { env });
  let retest = [];
  if (prior.length && !jira.missing.length) {
    try { retest = (await J.defectsToRetest(jira, [...new Set(prior.flatMap((r) => r.defects.keys))])).map((x) => x.key); } catch { /* Jira down: plan without it */ }
  }
  const brief = runs.briefFor(body.jiraKey, { env });
  if (brief.length || retest.length) requirement += `\n\nEarlier runs of this requirement:\n${brief.join("\n")}${retest.length ? `\nFixed in Jira, re-test their cases: ${retest.join(", ")}` : ""}`;
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const baseUrl = typeof body.baseUrl === "string" && /^https?:\/\//i.test(body.baseUrl) ? body.baseUrl : undefined;
  const runCases = deps.runApiCases || require("../engine/core/api-cases").runApiCases;
  let values = {};
  const failedCases = [];
  // One gateway-wrapped model function for the handlers, the planner and the reviewer: guardrails, fallback, log tagged with the run id.
  const callJson = deps.callJson && deps.gateway !== false ? gw.wrap(deps.callJson, { name: "pipeline", run: runId, env }) : deps.callJson;
  const handlers = allHandlers({
    callJson, getPrompt: deps.getPrompt, exec: deps.exec, connectRepo: deps.connectRepo,
    extra: {
      testdata: async () => {
        const { plan, error } = require("./testdata-endpoint").buildPlan({ steps, provided: body.testData, project: body.project });
        if (error) return { ok: false, detail: error };
        values = plan.values;
        const names = plan.fields.map((f) => f.name); // names only, never values
        return plan.needsYou.length ? { ok: false, detail: `needs you: ${plan.needsYou.join(", ")}`, data: { names } } : { ok: true, detail: `${plan.fields.length} field(s) ready`, data: { names } };
      },
      execution: async () => {
        if (!steps.some((s) => s && s.kind === "api")) return { unavailable: true, detail: "no API steps here; run web and mobile cases from the English page" };
        const prepared = td.prepareApiSteps(steps, { seed: "pipeline" });
        const r = await runCases({ steps: prepared.steps, testData: values, baseUrl, seed: "pipeline", negative: true });
        const bad = [r.main, ...r.negatives].filter((x) => x && x.ok === false);
        bad.forEach((x) => failedCases.push({ name: x.name || "API case", error: String(x.detail || "").slice(0, 300) }));
        return { ok: bad.length === 0, detail: `${1 + r.negatives.length} case(s), ${bad.length} failed`, data: { failedCases: failedCases.map((c) => ({ name: c.name })) } };
      },
      defects: async (ctx) => J.defectsHandler(jira, { requirement: body.jiraKey, secrets: Object.values(values) })({ ...ctx, failedCases }),
    },
  });
  const out = await runAiPipeline({
    goal: body.goal, requirement, ctx: { steps, baseUrl, appUrl: body.appUrl, requirement, goal: body.goal, ruleset: body.ruleset, repoRequest: body.repo && typeof body.repo === "object" ? body.repo : undefined }, handlers,
    autonomy, approvals: body.approvals && typeof body.approvals === "object" ? body.approvals : {}, production: body.production === true,
    callJson, exec: deps.exec, env,
  });
  const record = runs.link(out.stages, { jiraKey: body.jiraKey, goal: body.goal, plan: out.plan, runId, retest });
  try { runs.save(record, { env }); } catch { /* a full disk never fails a run */ }
  const clean = out.stages.map(({ data, ...s }) => s); // data can hold values; never returned
  return { code: 200, json: { ok: out.ok, runId, retest, plan: { source: out.plan.source, platforms: out.plan.platforms, reason: out.plan.reason }, stages: clean, summary: out.summary, needsYou: out.needsYou } };
}

async function handlePipelineRun(req, res) {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body; try { body = await readJson(req); } catch (e) { return send(400, { error: `Bad request: ${e.message}` }); }
  let callJson;
  // runPipelineRequest wraps it in the gateway (guardrails, fallback, call log tagged with the run id).
  try { callJson = require("../generation/llm").callOllamaJson; } catch { /* no model: stages say so */ }
  try { const r = await runPipelineRequest(body, { callJson }); send(r.code, r.json); } catch (e) { send(500, { error: e.message }); }
}

module.exports = { handlePipelineRun, runPipelineRequest };
