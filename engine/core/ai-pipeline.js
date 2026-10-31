/**
 * The AI decides, the code enforces.
 *   1. planRun: the model reads the goal/requirement and past runs, then decides which stages to run,
 *      which platforms (web | api | mobile) the requirement needs, and why. Output is checked against the
 *      real stage list; anything invented is dropped.
 *   2. runAiPipeline: runs the chosen stages, has the model review each one, and writes the outcome
 *      (statuses, notes, never data) to a run log that the next plan reads back.
 * The model can never lower a gate: a live security scan and production always ask, and the autonomy
 * level the tester chose is applied by pipeline.js, not by the model.
 * If the model is down or answers badly, every stage runs in order, and the plan says so.
 */
const fs = require("fs");
const path = require("path");
const { STAGES, runPipeline, llmReviewer } = require("./pipeline");

const PLATFORMS = ["web", "api", "mobile"];
const logPath = (env = process.env) => env.TESTOPS_PIPELINE_LOG || path.join(__dirname, "..", "..", "logs", "pipeline-runs.jsonl");

/** Last few runs, as short lines the model can learn from. Never contains test-data values. */
function history({ n = 5, env = process.env } = {}) {
  try {
    return fs.readFileSync(logPath(env), "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l))
      .map((r) => `${r.goal || "run"}: ` + r.stages.map((s) => `${s.id}=${s.status}${s.ai ? " (" + s.ai + ")" : ""}`).join(", "));
  } catch { return []; }
}
function record(result, { goal, env = process.env } = {}) {
  const p = logPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const stages = result.stages.map(({ id, status, detail, ai }) => ({ id, status, detail: String(detail || "").slice(0, 200), ...(ai ? { ai } : {}) }));
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), goal: String(goal || "").slice(0, 200), stages }) + "\n");
}

function fallbackPlan(why) {
  return { source: "fallback", reason: why, platforms: PLATFORMS.slice(), stages: STAGES.map((s) => ({ id: s.id, run: true, why: "default order" })) };
}
/** @returns {Promise<{source, platforms, stages:[{id,run,why}], reason?}>} */
async function planRun({ goal, requirement = "", callJson, past = [] }) {
  if (!callJson) return fallbackPlan("no model configured");
  const ids = STAGES.map((s) => s.id).join(", ");
  const prompt = `You are the test manager of an automated QA platform. Plan this run.\nGoal: ${goal}\nRequirement:\n${String(requirement).slice(0, 4000)}\n` +
    (past.length ? `Recent runs (learn from them):\n${past.join("\n")}\n` : "") +
    `Stages available: ${ids}.\nDecide which platforms the requirement needs (web, api, mobile; only those it mentions), and which stages to run.\n` +
    `Reply JSON {"platforms":["web"],"stages":[{"id":"scenarios","run":true,"why":"short reason"}]}.`;
  let r;
  try { r = await callJson(prompt); } catch (e) { return fallbackPlan(`model unavailable: ${e.message}`); }
  if (!r || !Array.isArray(r.stages)) return fallbackPlan("the model's plan could not be read");
  const known = new Set(STAGES.map((s) => s.id));
  const chosen = new Map(r.stages.filter((s) => s && known.has(s.id)).map((s) => [s.id, s]));
  const platforms = (Array.isArray(r.platforms) ? r.platforms : []).filter((p) => PLATFORMS.includes(p));
  return { source: "ai", platforms: platforms.length ? platforms : PLATFORMS.slice(),
    // A stage the model left out is not silently dropped: it runs, marked as the default.
    stages: STAGES.map((s) => chosen.has(s.id) ? { id: s.id, run: chosen.get(s.id).run !== false, why: String(chosen.get(s.id).why || "").slice(0, 200) } : { id: s.id, run: true, why: "not mentioned by the AI; default" }) };
}

async function runAiPipeline({ goal, requirement, ctx = {}, handlers, autonomy, approvals, production, callJson, exec, env = process.env, log = true } = {}) {
  const plan = await planRun({ goal, requirement, callJson, past: history({ env }) });
  const only = plan.stages.filter((s) => s.run).map((s) => s.id);
  const result = await runPipeline({ ctx: { ...ctx, platforms: plan.platforms }, handlers, only, autonomy, approvals, production, exec,
    ai: callJson ? llmReviewer({ callJson }) : undefined });
  const withWhy = result.stages.map((s) => ({ ...s, decided: (plan.stages.find((p) => p.id === s.id) || {}).why }));
  const out = { ...result, stages: withWhy, plan };
  if (log) { try { record(out, { goal, env }); } catch { /* a full disk never fails a run */ } }
  return out;
}

module.exports = { planRun, runAiPipeline, history, record, logPath };
