/**
 * One AI-driven pipeline: prompts -> scenarios -> cases -> test data -> execution -> HAR ->
 * performance -> secrets -> SAST -> DAST -> defects -> AI feedback.
 *
 * Each stage reports one of: passed | failed | needs-you | skipped | not-built | unavailable.
 * Autonomy (as on the AI Test Manager page): "ask-everything" | "ask-when-matters" (default) | "run-everything".
 * Whatever the level, a live security scan (dast) and anything aimed at production always wait for an approval.
 * "not-built" is stated plainly (no handler yet); nothing is faked as passed.
 * A stage handler is `async (ctx) => ({ok:boolean, detail:string, data?:any})`.
 * Handlers come from `handlers` (injected by the caller) or from the built-ins below.
 */
const { spawnSync } = require("child_process");

// needs: stages that must have passed (or been skipped by choice) first.
const STAGES = [
  { id: "scenarios", name: "Test scenarios (prompts)", needs: [] },
  { id: "cases", name: "Test cases (prompts)", needs: ["scenarios"] },
  { id: "testdata", name: "Test data", needs: ["cases"] },
  { id: "execution", name: "Test execution (local or BrowserStack)", needs: ["testdata"] },
  { id: "har", name: "HAR capture", needs: ["execution"] },
  { id: "performance", name: "Performance (Locust)", needs: ["cases"] },
  { id: "secrets", name: "Secrets scan (Gitleaks)", needs: [] },
  { id: "sast", name: "SAST (Semgrep, source code)", needs: [] },
  { id: "dast", name: "DAST (ZAP, running app)", needs: [] },
  { id: "defects", name: "Defects to Jira", needs: ["execution"], always: true },
  { id: "feedback", name: "Logs, data and reports back to the AI", needs: [], always: true },
];

// Stages that act outside the project; they ask first unless the tester chose "run everything".
const RISKY = new Set(["defects"]);
// Stages that ask whatever the autonomy level.
const ALWAYS_ASK = new Set(["dast"]);
// Stages that touch the app under test; aimed at production, they always ask.
const TOUCHES_APP = new Set(["execution", "har", "performance", "dast"]);
function mustAsk(id, { autonomy = "ask-when-matters", approvals = {}, production = false }) {
  const prod = production && TOUCHES_APP.has(id);
  if (prod) return "production"; // production asks every time, even when approved
  if (approvals[id]) return null;
  if (ALWAYS_ASK.has(id)) return "always";
  if (autonomy === "ask-everything") return "level";
  if (autonomy === "ask-when-matters" && RISKY.has(id)) return "level";
  return null;
}
const REASON = {
  production: "it is aimed at production, which always needs your approval",
  always: "it sends attack traffic to a live app, which always needs your approval",
  level: "waiting for your approval at the autonomy level you chose",
};

const hasTool = (cmd, exec) => { try { const r = exec(cmd, ["--version"]); return r && r.status === 0; } catch { return false; } };
const defaultExec = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 600000, ...opts });

/** Built-in handlers: only what Phoenix really does today. */
function builtins({ exec = defaultExec } = {}) {
  const scan = (cmd, args, label) => async (ctx) => {
    if (!hasTool(cmd, exec)) return { unavailable: true, detail: `${cmd} is not installed on this machine` };
    const r = exec(cmd, args(ctx.dir || ".", ctx));
    // gitleaks exits 1 when it finds leaks; semgrep --error exits 1 on findings.
    return { ok: r.status === 0, detail: r.status === 0 ? `${label}: no findings` : `${label}: findings or error (exit ${r.status})`, data: { stdout: String(r.stdout || "").slice(0, 4000) } };
  };
  return {
    testdata: async (ctx) => {
      const td = require("./testdata");
      const names = td.requiredNames(ctx.steps || [], { env: ctx.env || process.env });
      const plan = td.planTestData({ names, hints: {}, provided: ctx.testData || {}, mode: "generate", fill: true, choices: {}, canCreate: false, seed: ctx.seed || "pipeline" });
      return plan.needsYou.length
        ? { ok: false, detail: `needs you: ${plan.needsYou.join(", ")}`, data: { needsYou: plan.needsYou } }
        : { ok: true, detail: `${plan.fields.length} field(s) ready`, data: { values: plan.values } };
    },
    secrets: scan("gitleaks", (d) => ["detect", "--no-git", "-s", d, "--redact"], "gitleaks"),
    sast: scan("semgrep", (d, ctx) => ["--config", ctx.ruleset === "security-audit" ? "p/security-audit" : "auto", "--error", "--quiet", d], "semgrep"),
  };
}

/**
 * @param {{ctx?:Object, handlers?:Object, only?:string[], exec?:Function}} opts
 * @returns {Promise<{ok:boolean, stages:Object[], summary:Object}>}
 */
async function runPipeline({ ctx = {}, handlers = {}, only, exec, ai, autonomy, approvals, production } = {}) {
  const gate = { autonomy, approvals: approvals || {}, production: production === true || ctx.production === true };
  const all = { ...builtins({ exec }), ...handlers };
  const done = {};
  const stages = [];
  for (const st of STAGES) {
    if (only && !only.includes(st.id)) { done[st.id] = "skipped"; stages.push({ id: st.id, name: st.name, status: "skipped", detail: "not selected" }); continue; }
    const blocked = st.needs.find((n) => done[n] === "failed" || done[n] === "blocked");
    if (blocked && !st.always) { done[st.id] = "blocked"; stages.push({ id: st.id, name: st.name, status: "skipped", detail: `waiting on ${blocked}` }); continue; }
    const ask = mustAsk(st.id, gate);
    if (ask && all[st.id]) { done[st.id] = "blocked"; stages.push({ id: st.id, name: st.name, status: "needs-you", detail: REASON[ask], approve: st.id }); continue; }
    const h = all[st.id];
    if (!h) { done[st.id] = "not-built"; stages.push({ id: st.id, name: st.name, status: "not-built", detail: "no handler yet" }); continue; }
    try {
      const r = (await h({ ...ctx, results: stages })) || {};
      const status = r.unavailable ? "unavailable" : r.ok ? "passed" : "failed";
      done[st.id] = status === "failed" ? "failed" : "ok";
      stages.push({ id: st.id, name: st.name, status, detail: r.detail || "", ...(r.data ? { data: r.data } : {}) });
    } catch (e) {
      done[st.id] = "failed";
      stages.push({ id: st.id, name: st.name, status: "failed", detail: e.message });
    }
  }
  // AI pass: the model reads each stage's outcome (never its data, which can hold secrets)
  // and writes a note: why it failed, what to do next, a draft defect. A failing model never fails the run.
  if (ai) {
    const brief = stages.map(({ id, status, detail }) => ({ id, status, detail }));
    for (const st of stages) {
      if (st.status === "skipped") continue;
      try { const r = await ai({ stage: { id: st.id, status: st.status, detail: st.detail }, pipeline: brief }); if (r && r.note) st.ai = String(r.note); }
      catch (e) { st.ai = `AI review unavailable: ${e.message}`; }
    }
  }
  const count = (s) => stages.filter((x) => x.status === s).length;
  const summary = { needsYou: count("needs-you"), passed: count("passed"), failed: count("failed"), skipped: count("skipped"), notBuilt: count("not-built"), unavailable: count("unavailable") };
  return { ok: summary.failed === 0 && summary.needsYou === 0, stages, summary, needsYou: stages.filter((x) => x.status === "needs-you").map((x) => x.approve) };
}

/** Model-backed reviewer (self-hosted Ollama via generation/llm.js). Sends ids, statuses and short details only. */
function llmReviewer({ callJson = require("../../generation/llm").callOllamaJson } = {}) {
  return async ({ stage, pipeline }) => {
    const prompt = `You are the QA pipeline's reviewer. Stage "${stage.id}" ended "${stage.status}": ${stage.detail}\n` +
      `Whole run: ${JSON.stringify(pipeline)}\nReply JSON {"note":"one or two sentences: the likely cause and the next action"}.`;
    return callJson(prompt);
  };
}

module.exports = { STAGES, runPipeline, builtins, llmReviewer };
