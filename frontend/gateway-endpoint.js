/**
 * /api/gateway/*  prompt library, guardrails, MCP servers, call log, playground.
 *   GET  prompts | prompt?name=&platform= | guardrails | mcp | logs
 *   POST prompt {name,platform,text,note,by} | publish {name,platform,v} | settings {name,platform,guardrails,mcp,models}
 *        import | guardrails {rules} | mcp/add {id,url,headers} | mcp/remove {id} | mcp/enable {id,enabled} | mcp/refresh {id}
 *        test {name,platform,vars,input}   (runs the published prompt through the gateway)
 * Never returns MCP header values. Prompt text is returned only for the prompt asked for.
 */
const store = require("../engine/gateway/prompt-store");
const gw = require("../engine/gateway/gateway");
const guard = require("../engine/gateway/guardrails");
const mcp = require("../engine/gateway/mcp-registry");

async function route(method, pathname, query, body, deps = {}) {
  const env = deps.env || process.env;
  const ok = (json) => ({ code: 200, json });
  try {
    if (method === "GET") {
      if (pathname === "prompts") return ok({ prompts: store.list({ env }) });
      if (pathname === "prompt") { const r = store.get(query.name, query.platform || "shared", { env }); return r ? ok({ prompt: r }) : { code: 404, json: { error: "No such prompt." } }; }
      if (pathname === "guardrails") { let rules = guard.DEFAULT_RULES; try { rules = JSON.parse(require("fs").readFileSync(require("path").join(store.dirOf(env), "_guardrails.json"), "utf8")).rules; } catch { /* defaults */ } return ok({ rules }); }
      if (pathname === "mcp") return ok({ servers: mcp.list({ env }) });
      if (pathname === "logs") return ok({ calls: gw.readLog({ n: Math.min(Number(query.n) || 100, 500), env, run: query.run }) });
      if (pathname === "runs") return ok({ runs: require("../engine/core/run-record").list({ env }) });
      if (pathname === "run") { const rr = require("../engine/core/run-record"); const rec = rr.get(query.id, { env }); return rec ? ok({ run: rec, calls: gw.readLog({ n: 200, env, run: query.id }) }) : { code: 404, json: { error: "No such run." } }; }
    } else if (method === "POST") {
      const b = body || {};
      if (pathname === "prompt") return ok({ prompt: store.saveVersion({ name: b.name, platform: b.platform, text: b.text, note: b.note, by: b.by, publish: b.publish !== false }, { env }) });
      if (pathname === "publish") return ok({ prompt: store.publish(b.name, b.platform || "shared", Number(b.v), { env }) });
      if (pathname === "settings") return ok({ prompt: store.setSettings(b.name, b.platform || "shared", b, { env }) });
      if (pathname === "import") return ok({ imported: store.importRegistry({ env }) });
      if (pathname === "guardrails") { if (!Array.isArray(b.rules)) return { code: 400, json: { error: "Send rules as a list." } }; gw.saveRules(b.rules, { env }); return ok({ rules: b.rules.length }); }
      if (pathname === "mcp/add") return ok({ server: mcp.add(b, { env }) });
      if (pathname === "mcp/remove") { mcp.remove(b.id, { env }); return ok({ removed: b.id }); }
      if (pathname === "mcp/enable") { mcp.setEnabled(b.id, b.enabled !== false, { env }); return ok({ id: b.id, enabled: b.enabled !== false }); }
      if (pathname === "mcp/refresh") return ok({ server: await mcp.refresh(b.id, { env, fetchFn: deps.fetchFn }) });
      if (pathname === "test") {
        const providers = deps.providers || { ollama: require("../generation/llm").callOllamaJson };
        const r = await gw.callPrompt({ name: b.name, platform: b.platform || "shared", vars: b.vars || {}, input: b.input || "", providers, defaultModels: Object.keys(providers), env });
        return ok(r);
      }
    }
    return { code: 404, json: { error: "Unknown gateway route." } };
  } catch (e) { return { code: 400, json: { error: e.message } }; }
}

function readJson(req) { return new Promise((resolve, reject) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }
async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body = {}; if (req.method === "POST") { try { body = await readJson(req); } catch (e) { return send(400, { error: `Bad request: ${e.message}` }); } }
  const r = await route(req.method, u.pathname.replace(/^\/api\/gateway\//, ""), Object.fromEntries(u.searchParams), body);
  send(r.code, r.json);
}
module.exports = { handle, route };
