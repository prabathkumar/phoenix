/**
 * AI evaluation with DeepEval: is a chatbot's / assistant's / LLM's answer good?
 * Same job as TestOps's "Conversation Eval": paste or send a conversation, pick what to check, get a report.
 *   Metrics: answer_relevancy, faithfulness (needs retrieval_context), hallucination (needs context),
 *            toxicity, bias, contextual_relevancy (needs retrieval_context), geval (your own criteria,
 *            e.g. "the answer follows our refund policy").
 * The judge is a self-hosted Ollama model (DEEPEVAL_OLLAMA_MODEL, DEEPEVAL_OLLAMA_URL) or, if OPENAI_API_KEY is set,
 * DeepEval's default. Secrets and personal data are redacted before anything is sent to a judge.
 * Runs `python3 scripts/deepeval_run.py`; `unavailable` when python, deepeval or a judge is missing.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const guard = require("../gateway/guardrails");

const METRICS = {
  answer_relevancy: { needs: [], label: "Answer relevancy" }, faithfulness: { needs: ["retrieval_context"], label: "Faithfulness" },
  hallucination: { needs: ["context"], label: "Hallucination" }, toxicity: { needs: [], label: "Toxicity" }, bias: { needs: [], label: "Bias" },
  contextual_relevancy: { needs: ["retrieval_context"], label: "Contextual relevancy" }, geval: { needs: [], label: "Your criteria (G-Eval)" },
};
const DEFAULT_METRICS = ["answer_relevancy", "toxicity", "bias"];
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 900000, ...o });

/** "User: hi\nBot: hello" -> [{input, actual_output}]. Accepts User/Customer/Human/Q and Bot/AI/Assistant/Agent/A, multi-line answers. */
function parseConversation(text) {
  const turns = []; let cur = null, side = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(user|customer|human|client|q|question)\s*[:\-]\s*(.*)$/i.exec(line) || null;
    const b = /^\s*(bot|ai|assistant|agent|a|answer|chatbot)\s*[:\-]\s*(.*)$/i.exec(line) || null;
    if (m) { if (cur && cur.actual_output !== undefined) turns.push(cur); cur = { input: m[2], actual_output: undefined }; side = "input"; }
    else if (b && cur) { cur.actual_output = b[2]; side = "actual_output"; }
    else if (cur && side && line.trim()) cur[side] = (cur[side] || "") + "\n" + line.trim();
  }
  if (cur && cur.actual_output !== undefined) turns.push(cur);
  return turns.map((t) => ({ input: t.input.trim(), actual_output: String(t.actual_output).trim() })).filter((t) => t.input && t.actual_output);
}

function clean(turns) {
  const rules = guard.DEFAULT_RULES.filter((r) => r.type === "secrets" || r.type === "pii").map((r) => ({ ...r, applies: "both", action: "redact" }));
  const r = (s) => guard.run(rules, "input", s).text;
  const list = (v) => (Array.isArray(v) ? v.map((x) => r(String(x))) : undefined);
  return turns.map((t) => ({ input: r(t.input), actual_output: r(t.actual_output), ...(t.expected_output ? { expected_output: r(t.expected_output) } : {}), ...(t.context ? { context: list(t.context) } : {}), ...(t.retrieval_context ? { retrieval_context: list(t.retrieval_context) } : {}) }));
}

function available({ exec = run, env = process.env } = {}) {
  const py = exec("python3", ["-c", "import deepeval"], { env });
  if (py.status !== 0) return { ok: false, why: "DeepEval is not installed (pip install deepeval)" };
  if (!env.DEEPEVAL_OLLAMA_MODEL && !env.OPENAI_API_KEY) return { ok: false, why: "no judge model: set DEEPEVAL_OLLAMA_MODEL (and DEEPEVAL_OLLAMA_URL), or OPENAI_API_KEY" };
  return { ok: true };
}

/**
 * @returns {{status:"ok"|"unavailable"|"error", why?, results?:[], summary?:{turns, passed, failed, byMetric:{}}}}
 */
function evaluate({ turns, conversation, metrics = DEFAULT_METRICS, threshold = 0.5, criteria, exec = run, env = process.env, script = path.join(__dirname, "..", "..", "scripts", "deepeval_run.py") } = {}) {
  const all = Array.isArray(turns) && turns.length ? turns : parseConversation(conversation);
  if (!all.length) return { status: "error", why: "No conversation to evaluate: give turns, or text with User: and Bot: lines." };
  const chosen = (metrics || []).filter((m) => METRICS[m]);
  if (!chosen.length) return { status: "error", why: `Pick at least one metric: ${Object.keys(METRICS).join(", ")}.` };
  if (chosen.includes("geval") && !String(criteria || "").trim()) return { status: "error", why: "G-Eval needs your criteria in words." };
  const t = Number(threshold); if (!(t >= 0 && t <= 1)) return { status: "error", why: "Threshold is between 0 and 1." };
  const av = available({ exec, env }); if (!av.ok) return { status: "unavailable", why: av.why };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepeval-")); const inF = path.join(dir, "in.json"), outF = path.join(dir, "out.json");
  try {
    fs.writeFileSync(inF, JSON.stringify({ turns: clean(all), metrics: chosen, threshold: t, criteria: criteria ? clean([{ input: criteria, actual_output: "x" }])[0].input : undefined }));
    const r = exec("python3", [script, inF, outF], { env: { ...process.env, ...env } });
    if (r.status === 3) return { status: "unavailable", why: String(r.stderr || "no judge model").trim().split("\n").pop() };
    if (r.status !== 0) return { status: "error", why: `DeepEval failed (exit ${r.status}): ${String(r.stderr || "").trim().split("\n").pop().slice(0, 200)}` };
    const results = JSON.parse(fs.readFileSync(outF, "utf8")).results;
    return { status: "ok", results, summary: summarize(results, all.length) };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}

function summarize(results, turns) {
  const scored = results.filter((x) => typeof x.score === "number");
  const byMetric = {};
  for (const x of scored) { const m = (byMetric[x.metric] = byMetric[x.metric] || { n: 0, passed: 0, sum: 0 }); m.n++; m.sum += x.score; if (x.passed) m.passed++; }
  for (const m of Object.values(byMetric)) { m.avg = Math.round((m.sum / m.n) * 100) / 100; delete m.sum; }
  const failed = scored.filter((x) => !x.passed).length;
  return { turns, scored: scored.length, passed: scored.length - failed, failed, skipped: results.length - scored.length, byMetric };
}

module.exports = { METRICS, DEFAULT_METRICS, parseConversation, available, evaluate, summarize };
