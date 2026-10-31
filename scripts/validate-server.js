#!/usr/bin/env node
/**
 * Validates every component of a running TestOps ai-automate server, one by one.
 *   node scripts/validate-server.js http://localhost:8091
 * Each line is one component: PASS, FAIL, NOT SET UP (a tool or key this server does not have),
 * or NEEDS YOU (a gate that is meant to ask). Exit code 1 only when something FAILs.
 * Writes test data only under project "validate-server" and one prompt "validate_server_check"; deletes nothing.
 * Needs Node 18+; no packages.
 */
const base = (process.argv[2] || "http://localhost:8091").replace(/\/+$/, "");
const rows = [];
const add = (group, name, status, detail = "") => { rows.push({ group, name, status, detail }); };
async function http(method, path, body) {
  const r = await fetch(base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { code: r.status, json, text };
}
async function check(group, name, fn) {
  try { const r = await fn(); add(group, name, r.status || "PASS", r.detail || ""); } catch (e) { add(group, name, "FAIL", String(e.message).slice(0, 200)); }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  try { await http("GET", "/"); } catch (e) { console.error(`Cannot reach ${base}: ${e.message}`); process.exit(2); }

  // ---- pages
  for (const p of ["/", "/english", "/pipeline", "/gateway"]) await check("Pages", p, async () => { const r = await http("GET", p); need(r.code === 200 && /<html/i.test(r.text), `status ${r.code}`); return {}; });

  // ---- tools on this server
  let tools = {};
  await check("Server", "tool status", async () => { const r = await http("GET", "/api/pipeline/tools"); need(r.code === 200 && r.json.tools, "no tool report"); tools = r.json.tools; return { detail: `${r.json.stages.length} stages` }; });
  const toolRows = [["locust", "Locust (performance)"], ["semgrep", "Semgrep (SAST)"], ["gitleaks", "Gitleaks (secrets)"], ["zap", "ZAP (DAST)"], ["jira", "Jira connection"], ["github", "GitHub token"], ["gitlab", "GitLab token"], ["browserstack", "BrowserStack login"], ["ollama", "Model (Ollama)"]];
  for (const [k, label] of toolRows) add("Tools", label, tools[k] ? "PASS" : "NOT SET UP", typeof tools[k] === "string" ? tools[k] : "");

  // ---- run targets, test data, API
  await check("Run targets", "GET /api/run-options", async () => { const r = await http("GET", "/api/run-options"); need(r.code === 200 && r.json.web && r.json.mobile, "bad shape"); return { detail: `web local=${r.json.web.local} browserstack=${r.json.web.browserstack}` }; });
  await check("Test data", "plan for a login test", async () => { const r = await http("POST", "/api/test-data/plan", { steps: "Type ${EMAIL} in the email field\nType ${PASSWORD} in the password field", mode: "generate" }); need(r.code === 200 && Array.isArray(r.json.fields), r.text.slice(0, 120)); return { detail: `${r.json.fields.length} fields, needs you: ${(r.json.needsYou || []).join(",") || "none"}` }; });
  await check("Test data", "save per project", async () => { const r = await http("POST", "/api/test-data/save", { project: "validate-server", steps: "Type ${EMAIL} in the email field", provided: {}, seed: "v1" }); need(r.code === 200 && r.json.file, r.text.slice(0, 120)); return {}; });
  await check("API testing", "api-plan with bad-body cases", async () => { const r = await http("POST", "/api/test-data/api-plan", { steps: [{ kind: "api", method: "POST", url: "/login", generateBody: true, negative: true, schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } }], negative: true }); need(r.code === 200 && r.json.negativeCases.length > 0, r.text.slice(0, 120)); return { detail: `${r.json.negativeCases.length} negative cases` }; });

  // ---- gateway
  const gp = "validate_server_check";
  await check("Gateway", "save prompt version", async () => { const r = await http("POST", "/api/gateway/prompt", { name: gp, text: "Say OK for {{x}}", by: "validate" }); need(r.code === 200 && r.json.prompt.published >= 1, r.text.slice(0, 120)); return { detail: `v${r.json.prompt.published}` }; });
  await check("Gateway", "list, read and roll back", async () => { const l = await http("GET", "/api/gateway/prompts"); need(l.json.prompts.some((p) => p.name === gp), "not listed"); const g = await http("GET", `/api/gateway/prompt?name=${gp}`); const p = await http("POST", "/api/gateway/publish", { name: gp, v: g.json.prompt.versions[0].v }); need(p.code === 200, p.text.slice(0, 100)); return {}; });
  await check("Gateway", "guardrails", async () => { const r = await http("GET", "/api/gateway/guardrails"); need(r.code === 200 && r.json.rules.length, "no rules"); return { detail: `${r.json.rules.length} rules` }; });
  await check("Gateway", "MCP registry", async () => { const r = await http("GET", "/api/gateway/mcp"); need(r.code === 200 && Array.isArray(r.json.servers), "bad shape"); return { detail: `${r.json.servers.length} servers` }; });
  await check("Gateway", "playground through guardrails and log", async () => { const r = await http("POST", "/api/gateway/test", { name: gp, vars: { x: "1" } }); need(r.code === 200, r.text.slice(0, 120)); const l = await http("GET", "/api/gateway/logs?n=5"); need(l.json.calls.length >= 1, "call not logged"); return r.json.ok ? { detail: `answered by ${r.json.model}` } : { status: tools.ollama ? "FAIL" : "NOT SET UP", detail: r.json.error }; });

  // ---- pipeline: each stage on its own, then one full run
  const stages = (await http("GET", "/api/pipeline/tools")).json.stages;
  let lastRun = null;
  for (const s of stages) await check("Pipeline stage", s.name, async () => {
    const r = await http("POST", "/api/pipeline/run", { goal: "validate " + s.id, stages: [s.id], autonomy: "run-everything", requirement: "Users sign in with an email and password.", steps: [{ kind: "api", method: "POST", url: "/login", body: { email: "${EMAIL}" } }], baseUrl: base });
    need(r.code === 200, r.text.slice(0, 160));
    lastRun = r.json.runId; const st = r.json.stages.find((x) => x.id === s.id);
    const map = { passed: "PASS", "needs-you": "NEEDS YOU", unavailable: "NOT SET UP", "not-built": "NOT SET UP", skipped: "NOT SET UP", failed: "FAIL" };
    return { status: map[st.status], detail: st.detail };
  });
  await check("Pipeline", "full run, AI-planned", async () => { const r = await http("POST", "/api/pipeline/run", { goal: "validate full run", requirement: "Users sign in with an email and password.", autonomy: "ask-when-matters" }); need(r.code === 200 && r.json.runId && r.json.stages.length === stages.length, r.text.slice(0, 160)); lastRun = r.json.runId; return { detail: `plan: ${r.json.plan.source}; needs you: ${r.json.needsYou.join(", ") || "none"}` }; });
  await check("Pipeline", "run record links the blocks", async () => { const r = await http("GET", `/api/gateway/run?id=${lastRun}`); need(r.code === 200 && r.json.run.stages.length === stages.length, "missing record"); return { detail: `${r.json.calls.length} model calls tagged with the run` }; });
  await check("Pipeline", "live scan always asks", async () => { const r = await http("POST", "/api/pipeline/run", { goal: "gate", stages: ["dast"], autonomy: "run-everything", appUrl: "https://example.invalid" }); const st = r.json.stages.find((x) => x.id === "dast"); need(st.status === "needs-you" || st.status === "unavailable", `dast was ${st.status}`); return { detail: st.status }; });

  // ---- report
  const w = Math.max(...rows.map((r) => r.name.length)) + 2;
  let group = "";
  for (const r of rows) { if (r.group !== group) { group = r.group; console.log(`\n${group}`); } console.log(`  ${r.status.padEnd(10)} ${r.name.padEnd(w)} ${r.detail}`); }
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("NOT SET UP")} not set up, ${count("NEEDS YOU")} waiting for you`);
  process.exit(count("FAIL") ? 1 : 0);
})();
