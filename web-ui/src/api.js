const user = () => { try { return localStorage.getItem("phoenix.user") || ""; } catch { return ""; } };
export const setUser = (u) => { try { localStorage.setItem("phoenix.user", u); } catch { /* private window */ } };
export const getUser = user;

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-User": user() }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && (data.detail || data.error)) || `Request failed (${res.status})`);
  return data;
}
export const get = (p) => call("GET", p);
export const post = (p, b = {}) => call("POST", p, b);
export const q = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")).toString(); return s ? `?${s}` : ""; };

export const api = {
  health: () => get("/api/health"),
  tools: () => get("/api/pipeline/tools"),
  run: (body) => post("/api/pipeline/run", body),
  runs: () => get("/api/runs"),
  runDetail: (id) => get(`/api/runs/${id}`),
  cases: (f = {}) => get(`/api/cases${q(f)}`),
  saveCase: (c) => post("/api/cases", c),
  signoffs: (f = {}) => get(`/api/signoff${q(f)}`),
  requestCase: (id, note) => post(`/api/signoff/case/${id}/request`, { note }),
  requestRun: (id, note) => post(`/api/signoff/run/${id}/request`, { note }),
  decide: (id, decision, note) => post(`/api/signoff/${id}/decide`, { decision, note }),
  execution: (b) => post("/api/executions", b),
  dashboard: (days = 14) => get(`/api/dashboard?days=${days}`),
  prompts: () => get("/api/gateway/prompts"),
  prompt: (name, platform) => get(`/api/gateway/prompt${q({ name, platform })}`),
  savePrompt: (b) => post("/api/gateway/prompt", b),
  publish: (b) => post("/api/gateway/publish", b),
  importPrompts: () => post("/api/gateway/import"),
  guardrails: () => get("/api/gateway/guardrails"),
  saveGuardrails: (rules) => post("/api/gateway/guardrails", { rules }),
  mcp: () => get("/api/gateway/mcp"),
  mcpAction: (a, b) => post(`/api/gateway/mcp/${a}`, b),
  logs: (n = 100) => get(`/api/gateway/logs?n=${n}`),
  testPrompt: (b) => post("/api/gateway/test", b),
};
