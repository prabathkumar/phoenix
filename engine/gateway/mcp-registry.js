/**
 * MCP registry: servers added from the UI, their tools, and which tools each prompt may use.
 * Stored in <gateway dir>/_mcp.json. Talks MCP over HTTP (JSON-RPC: tools/list, tools/call).
 * Auth headers are stored but never returned by list(). Not yet run against a real MCP server (tested with a fake).
 * Stdio servers are not supported here: only URLs.
 */
const fs = require("fs");
const path = require("path");
const { dirOf } = require("./prompt-store");

const fileOf = (env) => path.join(dirOf(env), "_mcp.json");
const load = (env) => { try { return JSON.parse(fs.readFileSync(fileOf(env), "utf8")); } catch { return { servers: [] }; } };
const save = (d, env) => { fs.mkdirSync(path.dirname(fileOf(env)), { recursive: true }); fs.writeFileSync(fileOf(env), JSON.stringify(d, null, 2), { mode: 0o600 }); };
const safeId = (s) => { const v = String(s || ""); if (!/^[a-z][a-z0-9-]{0,39}$/.test(v)) throw new Error("Server id: lowercase letters, numbers, dash."); return v; };

function add({ id, url, headers = {}, enabled = true }, { env = process.env } = {}) {
  safeId(id);
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("The MCP server address must start with http:// or https://.");
  const d = load(env);
  d.servers = d.servers.filter((s) => s.id !== id).concat({ id, url, headers, enabled, tools: [] });
  save(d, env); return list({ env }).find((s) => s.id === id);
}
function remove(id, { env = process.env } = {}) { const d = load(env); d.servers = d.servers.filter((s) => s.id !== id); save(d, env); }
function setEnabled(id, enabled, { env = process.env } = {}) { const d = load(env); const s = d.servers.find((x) => x.id === id); if (!s) throw new Error(`No MCP server "${id}".`); s.enabled = !!enabled; save(d, env); }
/** Names, addresses and tools; never header values. */
function list({ env = process.env } = {}) { return load(env).servers.map((s) => ({ id: s.id, url: s.url, enabled: s.enabled, headers: Object.keys(s.headers || {}), tools: s.tools || [] })); }

async function rpc(server, method, params, fetchFn) {
  const res = await fetchFn(server.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...(server.headers || {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`MCP ${server.id} ${method} failed (${res.status}).`);
  const j = JSON.parse(await res.text());
  if (j.error) throw new Error(`MCP ${server.id}: ${String(j.error.message || "error").slice(0, 200)}`);
  return j.result;
}
/** Ask the server for its tools and remember them (all off until allowed per prompt). */
async function refresh(id, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const d = load(env); const s = d.servers.find((x) => x.id === id);
  if (!s) throw new Error(`No MCP server "${id}".`);
  const r = await rpc(s, "tools/list", {}, fetchFn);
  s.tools = (r.tools || []).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 200) }));
  save(d, env); return list({ env }).find((x) => x.id === id);
}
/** allowed: ["server/tool", ...] from the prompt's settings. Anything not listed is refused. */
async function callTool(ref, args, { allowed = [], env = process.env, fetchFn = globalThis.fetch } = {}) {
  if (!allowed.includes(ref)) throw new Error(`The tool ${ref} is not allowed for this prompt.`);
  const [sid, tool] = String(ref).split("/");
  const s = load(env).servers.find((x) => x.id === sid);
  if (!s || !s.enabled) throw new Error(`MCP server "${sid}" is not available.`);
  return rpc(s, "tools/call", { name: tool, arguments: args || {} }, fetchFn);
}
module.exports = { add, remove, setEnabled, list, refresh, callTool };
