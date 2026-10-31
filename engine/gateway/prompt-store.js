/**
 * Prompt library: every prompt stored, versioned, with variables, published and rolled back from the UI.
 * One JSON file per prompt under TESTOPS_GATEWAY_DIR (default ./prompt-library), so it can be committed and reviewed.
 *   key = "<name>:<platform>"   platform: shared | web | mobile
 * A new edit is a new version; nothing is overwritten. "Published" is the version calls use.
 * Same shape as the old registry: getPrompt(name, platform) -> { text, id } where id = name:platform:vN:hash.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dirOf = (env = process.env) => env.TESTOPS_GATEWAY_DIR || path.join(__dirname, "..", "..", "prompt-library");
const safe = (s) => { const v = String(s || ""); if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v)) throw new Error("Names use letters, numbers, dot, dash and underscore."); return v; };
const PLATFORMS = ["shared", "web", "mobile"];
const file = (name, platform, env) => path.join(dirOf(env), `${safe(name)}.${PLATFORMS.includes(platform) ? platform : "shared"}.json`);
const hash = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12);
const varsOf = (text) => [...new Set([...String(text).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];

function read(name, platform, env) { try { return JSON.parse(fs.readFileSync(file(name, platform, env), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function write(rec, env) {
  const f = file(rec.name, rec.platform, env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(rec, null, 2)); fs.renameSync(f + ".tmp", f);
}

/** Add a version (becomes the published one unless publish:false). Returns the record. */
function saveVersion({ name, platform = "shared", text, note = "", by = "", publish = true, guardrails, mcp, models }, { env = process.env, now = () => new Date().toISOString() } = {}) {
  if (!String(text || "").trim()) throw new Error("The prompt text is empty.");
  const rec = read(name, platform, env) || { name: safe(name), platform: PLATFORMS.includes(platform) ? platform : "shared", versions: [], published: 0, guardrails: [], mcp: [], models: [] };
  const v = rec.versions.length + 1;
  rec.versions.push({ v, text: String(text), vars: varsOf(text), hash: hash(String(text)), note: String(note).slice(0, 200), by: String(by).slice(0, 80), at: now() });
  if (publish) rec.published = v;
  if (Array.isArray(guardrails)) rec.guardrails = guardrails;
  if (Array.isArray(mcp)) rec.mcp = mcp;
  if (Array.isArray(models)) rec.models = models;
  write(rec, env);
  return rec;
}
function publish(name, platform, v, { env = process.env } = {}) {
  const rec = read(name, platform, env);
  if (!rec) throw new Error(`No prompt "${name}".`);
  if (!rec.versions.some((x) => x.v === v)) throw new Error(`Prompt "${name}" has no version ${v}.`);
  rec.published = v; write(rec, env); return rec;
}
/** Settings only (guardrails, allowed MCP tools, models); text untouched. */
function setSettings(name, platform, { guardrails, mcp, models }, { env = process.env } = {}) {
  const rec = read(name, platform, env);
  if (!rec) throw new Error(`No prompt "${name}".`);
  if (Array.isArray(guardrails)) rec.guardrails = guardrails;
  if (Array.isArray(mcp)) rec.mcp = mcp;
  if (Array.isArray(models)) rec.models = models;
  write(rec, env); return rec;
}
function list({ env = process.env } = {}) {
  let names = []; try { names = fs.readdirSync(dirOf(env)).filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch { return []; }
  return names.map((f) => JSON.parse(fs.readFileSync(path.join(dirOf(env), f), "utf8"))).filter((r) => r.versions).sort((a, b) => (a.name + a.platform).localeCompare(b.name + b.platform))
    .map((r) => { const cur = r.versions.find((x) => x.v === r.published) || {}; return { name: r.name, platform: r.platform, published: r.published, versions: r.versions.length, vars: cur.vars || [], guardrails: r.guardrails, mcp: r.mcp, models: r.models, at: cur.at }; });
}
const get = (name, platform = "shared", { env = process.env } = {}) => read(name, platform, env);

/** Published text with {{vars}} filled; unknown vars are an error, not silently empty. */
function getPrompt(name, platform = "shared", vars = {}, { env = process.env } = {}) {
  ensureDefault(name, { env });
  const rec = read(name, platform, env) || read(name, "shared", env);
  if (!rec) throw new Error(`unknown prompt '${name}'`);
  const ver = rec.versions.find((x) => x.v === rec.published);
  if (!ver) throw new Error(`prompt '${name}' has no published version`);
  const missing = ver.vars.filter((k) => !(k in vars) && vars !== null && Object.keys(vars).length);
  if (missing.length) throw new Error(`prompt '${name}' needs: ${missing.join(", ")}`);
  const text = ver.text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { text, id: `${rec.name}:${rec.platform}:v${ver.v}:${ver.hash}`, version: ver.v, record: rec };
}

/** Prompts Phoenix ships with that are not in the YAML registry. Created in the library on first use, then editable on the Gateway page. */
const DEFAULTS = {
  unit_test_gen: `You write unit tests. Given one source file, write one complete test file for it in the named language and framework.
Rules:
- Test the real behaviour of the public functions or methods: normal cases, edge cases (empty, null, boundaries) and error cases.
- Use only the framework named, and import the source file by the path given. Do not invent modules or helpers that are not in the source.
- No network, no real files, no secrets, no sleeping. Use plain inputs and fakes.
- If SEMGREP FINDINGS are listed, include a test that fails while that flagged code is still unsafe (for example, a hostile input that must be rejected).
- Each test has a name that says what it checks, and at least one assertion.
Reply with JSON {"code":"<the whole test file>"} and nothing else.`,
};
function ensureDefault(name, { env = process.env } = {}) {
  if (!DEFAULTS[name] || read(name, "shared", env)) return false;
  saveVersion({ name, platform: "shared", text: DEFAULTS[name], note: "shipped default", by: "phoenix" }, { env }); return true;
}

/** One-time import of the YAML registry (prompts/prompts.yaml) as version 1 of each prompt. Skips ones that exist. */
function importRegistry({ env = process.env, registry = () => require("../../prompts/registry") } = {}) {
  const r = registry(); const made = [];
  for (const [name, plats] of Object.entries(r.listPrompts())) for (const platform of plats) {
    if (read(name, platform, env)) continue;
    saveVersion({ name, platform, text: r.getPrompt(name, platform).text, note: "imported from prompts.yaml", by: "import" }, { env }); made.push(`${name}:${platform}`);
  }
  return made;
}
module.exports = { DEFAULTS, ensureDefault, saveVersion, publish, setSettings, list, get, getPrompt, importRegistry, varsOf, dirOf };
