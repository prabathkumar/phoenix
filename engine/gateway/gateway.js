/**
 * The gateway: every model call goes through here.
 *   callPrompt({name, platform, vars, input})  published prompt -> input guardrails -> models in order (fallback)
 *                                              -> output guardrails -> log
 *   wrap(callJson, {name})                     same checks and log around any existing callJson(prompt)
 * Model call: providers[modelName](prompt) -> any value (the Ollama callJson is the default provider).
 * The log (logs/gateway-calls.jsonl) holds prompt id and version, model, latency, sizes, guardrail results,
 * status. It never holds the prompt text, the input or the answer.
 */
const fs = require("fs");
const path = require("path");
const store = require("./prompt-store");
const guard = require("./guardrails");

const logFile = (env = process.env) => env.TESTOPS_GATEWAY_LOG || path.join(__dirname, "..", "..", "logs", "gateway-calls.jsonl");
function log(rec, env) { try { const f = logFile(env); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(rec) + "\n"); } catch { /* logging never fails a call */ } }
function readLog({ n = 100, env = process.env, run } = {}) { try { const all = fs.readFileSync(logFile(env), "utf8").trim().split("\n").map((l) => JSON.parse(l)); return (run ? all.filter((c) => c.run === run) : all).slice(-n).reverse(); } catch { return []; } }
function rulesFor(names, env) {
  let all = guard.DEFAULT_RULES;
  try { const custom = JSON.parse(fs.readFileSync(path.join(store.dirOf(env), "_guardrails.json"), "utf8")); if (Array.isArray(custom.rules)) all = custom.rules; } catch { /* defaults */ }
  // A prompt that names rules gets exactly those; otherwise the rules marked for everyone (default !== false).
  return names && names.length ? all.filter((r) => names.includes(r.id)) : all.filter((r) => r.default !== false);
}
function saveRules(rules, { env = process.env } = {}) {
  for (const r of rules) guard.check({ ...r, action: "warn" }, "", {}); // rejects unknown types
  const f = path.join(store.dirOf(env), "_guardrails.json"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ rules }, null, 2));
}

async function viaModels(models, providers, prompt) {
  const tried = [];
  for (const m of models) {
    const p = providers[m]; if (!p) { tried.push(`${m}: not configured`); continue; }
    try { return { model: m, value: await p(prompt), tried }; } catch (e) { tried.push(`${m}: ${e.message}`); }
  }
  throw new Error(`No model answered (${tried.join("; ")})`);
}

/** @returns {{ok, value?, error?, blocked?, guardrails}} */
async function execute({ promptId, version, input, models, providers, rules, secrets, env, name, run }) {
  const t0 = Date.now();
  const gin = guard.run(rules, "input", input, { secrets });
  const base = { at: new Date().toISOString(), ...(run ? { run } : {}), name, prompt: promptId, version, inChars: String(input).length };
  if (gin.blocked) { log({ ...base, status: "blocked-input", guardrails: gin.results.filter((r) => r.hit), ms: Date.now() - t0 }, env); return { ok: false, blocked: "input", error: "Blocked by a guardrail on the input.", guardrails: gin.results }; }
  let r;
  try { r = await viaModels(models, providers, gin.text); } catch (e) { log({ ...base, status: "model-error", error: e.message.slice(0, 300), ms: Date.now() - t0 }, env); return { ok: false, error: e.message, guardrails: gin.results }; }
  const raw = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
  const gout = guard.run(rules, "output", raw, { secrets });
  const results = gin.results.concat(gout.results);
  if (gout.blocked) { log({ ...base, model: r.model, fellBack: r.tried.length, status: "blocked-output", guardrails: results.filter((x) => x.hit), outChars: raw.length, ms: Date.now() - t0 }, env); return { ok: false, blocked: "output", error: "Blocked by a guardrail on the answer.", guardrails: results }; }
  let value = r.value;
  if (gout.text !== raw) { try { value = typeof r.value === "string" ? gout.text : JSON.parse(gout.text); } catch { value = gout.text; } }
  log({ ...base, model: r.model, fellBack: r.tried.length, status: "ok", guardrails: results.filter((x) => x.hit), outChars: raw.length, ms: Date.now() - t0 }, env);
  return { ok: true, value, model: r.model, guardrails: results };
}

const MAX_TOOL_CALLS = 3;
/**
 * With MCP tools allowed on the prompt, the model may answer {"tool":"server/tool","args":{...}} to call one.
 * Only tools in the prompt's allow-list run; the result goes back to the model (through the guardrails again),
 * at most MAX_TOOL_CALLS times. The log records which tool ran, never its arguments or result.
 */
async function callPrompt({ name, platform = "shared", vars = {}, input = "", providers, defaultModels = [], secrets = [], env = process.env, run, fetchFn }) {
  const p = store.getPrompt(name, platform, vars, { env });
  const rec = p.record;
  const allowed = rec.mcp || [];
  let text = input ? `${p.text}\n\n${input}` : p.text;
  if (allowed.length) {
    const known = require("./mcp-registry").list({ env }).flatMap((s) => (s.enabled ? s.tools.map((t) => ({ ref: `${s.id}/${t.name}`, d: t.description })) : []));
    const usable = known.filter((t) => allowed.includes(t.ref));
    if (usable.length) text += `\n\nYou may use a tool before answering. To call one, reply only {"tool":"server/tool","args":{...}}. Tools:\n${usable.map((t) => `- ${t.ref}: ${t.d}`).join("\n")}`;
  }
  const models = rec.models && rec.models.length ? rec.models : defaultModels;
  const used = [];
  for (let i = 0; ; i++) {
    const r = await execute({ promptId: p.id, version: p.version, input: text, models, providers, rules: rulesFor(rec.guardrails, env), secrets, env, name, run });
    const v = r.value;
    const wants = r.ok && allowed.length && v && typeof v === "object" && typeof v.tool === "string";
    if (!wants) return used.length ? { ...r, toolCalls: used } : r;
    if (i >= MAX_TOOL_CALLS) return { ...r, ok: false, error: `The model kept asking for tools (more than ${MAX_TOOL_CALLS}).`, toolCalls: used };
    let result;
    try { result = await require("./mcp-registry").callTool(v.tool, v.args, { allowed, env, fetchFn }); used.push(v.tool); log({ at: new Date().toISOString(), ...(run ? { run } : {}), name, prompt: p.id, version: p.version, status: "tool", tool: v.tool }, env); }
    catch (e) { result = { error: e.message }; }
    text += `\n\nTOOL RESULT (${v.tool}): ${JSON.stringify(result).slice(0, 4000)}\nNow give your answer, or call another tool.`;
  }
}

/** A drop-in callJson: same checks, log and fallback around a plain model function. Throws on a block, so callers see a failed stage. */
function wrap(callJson, { name = "adhoc", models = ["default"], extra = {}, secrets = [], env = process.env, run } = {}) {
  const providers = { default: callJson, ...extra };
  return async (prompt, ...rest) => {
    const r = await execute({ promptId: `${name}:adhoc`, version: 0, input: prompt, models, providers: { ...providers, default: (p) => callJson(p, ...rest) }, rules: rulesFor(null, env), secrets, env, name, run });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
}
module.exports = { callPrompt, wrap, readLog, rulesFor, saveRules, logFile };
