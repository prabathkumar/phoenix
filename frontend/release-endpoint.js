/**
 * Releases, keyed by project. The project id is the key; suites, runs, agent status and results all hang off it.
 *   GET  /api/projects/:projectId/suites          -> suites of the project  [{name, url, cases, skipped}]
 *   POST /api/releases   {projectId, suite, changed?, heal?, perf?, security?}  -> 202 {releaseId}
 *   GET  /api/releases?projectId=ID               -> that project's releases, newest first (includes ones from before a restart)
 *   GET  /api/releases/:id                        -> {projectId, status, agents:{planner..reporter:{status,message}}, progress, result?}
 *   GET  /api/releases/:id/audit                  -> the agents' audit trail
 * Suites live in test-cases/projects/<projectId>/<suite>.json. Only those can be started (a release opens a browser on the
 * suite's URL, so no inline suites). One release runs at a time PER PROJECT (409 otherwise).
 * If PHOENIX_RELEASE_TOKEN is set every call needs "Authorization: Bearer <token>".
 * Results are saved to $PHOENIX_DATA_DIR/release-runs/<projectId>/release-<id>.json.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Which named agent (avatar) does each release job: from prompts/agents-roster.json. */
function rosterByJob() {
  const out = {};
  try { for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, "..", "prompts", "agents-roster.json"), "utf8")).agents) for (const j of r.releaseAgents || []) out[j] = { name: r.name, title: r.title, colour: r.colour, avatar: `/agent-avatars/${r.name}.svg` }; } catch { /* names are a bonus */ }
  return out;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const UUID = /^[0-9a-f-]{36}$/i;

function createReleaseEndpoint(deps = {}) {
  const runRelease = deps.runRelease || require("../engine/agents/release").runRelease;
  const AGENTS = deps.agents || require("../engine/agents/release").AGENTS;
  const ask = deps.ask !== undefined ? deps.ask : require("../engine/agents/ollama-ask").ollamaAsk();
  const projectsDir = deps.projectsDir || path.join(__dirname, "..", "test-cases", "projects");
  const dataDir = deps.dataDir !== undefined ? deps.dataDir : path.join(process.env.PHOENIX_DATA_DIR || ".", "release-runs");
  const token = deps.token !== undefined ? deps.token : process.env.PHOENIX_RELEASE_TOKEN;
  const jobs = deps.roster || rosterByJob();
  const decorate = (agents) => Object.fromEntries(Object.entries(agents || {}).map(([id, a]) => [id, jobs[id] ? { ...a, roster: jobs[id] } : a]));
  const releases = new Map();
  const active = new Map(); // projectId -> releaseId

  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const authorised = (req) => { if (!token) return true; const a = Buffer.from(String(req.headers.authorization || "")), b = Buffer.from(`Bearer ${token}`); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const readBody = (req) => new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 64 * 1024) { no(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(s)); req.on("error", no); });
  const initialAgents = () => Object.fromEntries(AGENTS.map(([id, name, job]) => [id, { name, job, status: "waiting", message: "", updatedAt: null }]));
  const readSuite = (projectId, name) => { try { return JSON.parse(fs.readFileSync(path.join(projectsDir, projectId, `${name.replace(/\.json$/, "")}.json`), "utf8")); } catch { return null; } };

  function listSuites(projectId) {
    let files = []; try { files = fs.readdirSync(path.join(projectsDir, projectId)).filter((f) => f.endsWith(".json")); } catch { return null; }
    return files.map((f) => { const s = readSuite(projectId, f) || {}; return { name: f.replace(/\.json$/, ""), title: s.name || f, url: s.url || "", cases: (s.cases || []).length, skipped: (s.skipped || []).length }; });
  }

  const summary = (r) => ({ releaseId: r.id, projectId: r.projectId, suite: r.suite, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt || null, verdict: r.result ? r.result.verdict : null, passed: r.result ? r.result.passed : null, total: r.result ? r.result.total : null });

  function fromDisk(projectId, id) { try { const r = JSON.parse(fs.readFileSync(path.join(dataDir, projectId, `release-${id}.json`), "utf8")); return r.record || null; } catch { return null; } }
  function historyOf(projectId) {
    const out = new Map([...releases.values()].filter((r) => r.projectId === projectId).map((r) => [r.id, summary(r)]));
    try { for (const f of fs.readdirSync(path.join(dataDir, projectId))) { const m = /^release-([0-9a-f-]{36})\.json$/i.exec(f); if (m && !out.has(m[1])) { const r = fromDisk(projectId, m[1]); if (r) out.set(m[1], summary(r)); } } } catch { /* no history yet */ }
    return [...out.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async function start(req, res) {
    if (!authorised(req)) return json(res, 401, { error: "A valid Bearer token is required." });
    let body; try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "Send JSON: {projectId, suite, changed?, heal?}" }); }
    const projectId = String(body.projectId || ""), name = String(body.suite || "");
    if (!ID.test(projectId)) return json(res, 400, { error: "projectId is required (letters, digits, - _)." });
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return json(res, 400, { error: "suite must be the name of a suite in this project (letters, digits, - _ .)" });
    const suite = readSuite(projectId, name);
    if (!suite) return json(res, 404, { error: `Project ${projectId} has no suite called ${name}.` });
    if (active.has(projectId)) return json(res, 409, { error: "A release is already running for this project.", releaseId: active.get(projectId) });
    const id = crypto.randomUUID();
    const rec = { id, projectId, suite: name, status: "running", startedAt: new Date().toISOString(), agents: initialAgents(), progress: [], result: null, error: null, audit: [] };
    releases.set(id, rec); active.set(projectId, id);
    const changed = Array.isArray(body.changed) ? body.changed.map(String).slice(0, 20) : [];
    Promise.resolve().then(() => runRelease(suite, {
      changed, ask: ask || undefined, heal: body.heal !== false, perf: body.perf !== false, security: body.security !== false,
      onStatus: (agent, a) => { rec.agents[agent] = { ...rec.agents[agent], ...a }; },
      runOpts: { log: (line) => { rec.progress.push(String(line)); if (rec.progress.length > 500) rec.progress.shift(); } },
      auditSink: (e) => { rec.audit.push(e); },
    })).then((result) => { rec.result = result; rec.status = "done"; rec.agents = { ...rec.agents, ...(result.agents || {}) }; })
      .catch((err) => { rec.status = "error"; rec.error = String((err && err.message) || err); })
      .finally(() => {
        rec.finishedAt = new Date().toISOString(); if (active.get(projectId) === id) active.delete(projectId);
        if (dataDir) { try { fs.mkdirSync(path.join(dataDir, projectId), { recursive: true }); fs.writeFileSync(path.join(dataDir, projectId, `release-${id}.json`), JSON.stringify({ record: rec }, null, 2)); } catch { /* the API still has it */ } }
      });
    json(res, 202, { releaseId: id, projectId, status: "running" });
  }

  function get(req, res) {
    if (!authorised(req)) return json(res, 401, { error: "A valid Bearer token is required." });
    const url = req.url.split("?")[0], q = new URLSearchParams(req.url.split("?")[1] || "");
    let m = /^\/api\/projects\/([^/]+)\/suites$/.exec(url);
    if (m) { if (!ID.test(m[1])) return json(res, 400, { error: "bad project id" }); const l = listSuites(m[1]); return l ? json(res, 200, { projectId: m[1], suites: l, agents: decorate(initialAgents()) }) : json(res, 404, { error: `No suites for project ${m[1]}.` }); }
    if (url === "/api/releases") { const p = q.get("projectId") || ""; if (!ID.test(p)) return json(res, 400, { error: "projectId is required" }); return json(res, 200, { projectId: p, releases: historyOf(p) }); }
    m = /^\/api\/releases\/([0-9a-f-]{36})(\/audit)?$/i.exec(url);
    if (!m || !UUID.test(m[1])) return json(res, 404, { error: "Not found." });
    let rec = releases.get(m[1]); const p = q.get("projectId");
    if (!rec && p && ID.test(p)) rec = fromDisk(p, m[1]);
    if (!rec) return json(res, 404, { error: "No such release. After a restart, add ?projectId=<id> to read an older one." });
    if (m[2]) return json(res, 200, { releaseId: rec.id, projectId: rec.projectId, audit: (rec.result && rec.result.audit) || rec.audit || [] });
    const { audit, ...pub } = rec; void audit;
    pub.agents = decorate(pub.agents);
    if (pub.result) { const { audit: a, agents: ag, ...r } = pub.result; void a; void ag; pub.result = r; }
    json(res, 200, pub);
  }

  return { start, get };
}

let shared;
const endpoint = () => (shared = shared || createReleaseEndpoint());
module.exports = { createReleaseEndpoint, handleStart: (q, s) => endpoint().start(q, s), handleGet: (q, s) => endpoint().get(q, s) };
