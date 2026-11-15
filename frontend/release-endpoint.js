/**
 * One API call per release.
 *   POST /api/releases   {suite:"yes-my-release-web", changed?:["checkout"], heal?:true}  -> 202 {releaseId}
 *   GET  /api/releases/:id         -> {status:"running"|"done"|"error", progress:[...], result?}  (result = verdict, counts, gaps, per-case rows)
 *   GET  /api/releases/:id/audit   -> the agents' audit trail
 * Only suites that already exist in test-cases/ can be started (no inline suites: a release opens a browser on the suite's URL).
 * If PHOENIX_RELEASE_TOKEN is set, every call needs "Authorization: Bearer <token>". One release runs at a time (409 otherwise).
 * Results are also written to $PHOENIX_DATA_DIR/release-runs/ like the command line does.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SUITE_DIR = path.join(__dirname, "..", "test-cases");
const releases = new Map();
let active = null;

function createReleaseEndpoint(deps = {}) {
  const runRelease = deps.runRelease || require("../engine/agents/release").runRelease;
  const ask = deps.ask !== undefined ? deps.ask : require("../engine/agents/ollama-ask").ollamaAsk();
  const suiteDir = deps.suiteDir || SUITE_DIR;
  const dataDir = deps.dataDir !== undefined ? deps.dataDir : path.join(process.env.PHOENIX_DATA_DIR || ".", "release-runs");
  const token = deps.token !== undefined ? deps.token : process.env.PHOENIX_RELEASE_TOKEN;

  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const authorised = (req) => { if (!token) return true; const h = String(req.headers.authorization || ""); const a = Buffer.from(h), b = Buffer.from(`Bearer ${token}`); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const readBody = (req) => new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 64 * 1024) { no(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(s)); req.on("error", no); });

  async function start(req, res) {
    if (!authorised(req)) return json(res, 401, { error: "A valid Bearer token is required." });
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "Send JSON: {suite, changed?, heal?}" }); }
    const name = String(body.suite || "");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return json(res, 400, { error: "suite must be the name of a file in test-cases/ (letters, digits, - _ .)" });
    const file = path.join(suiteDir, name.endsWith(".json") ? name : `${name}.json`);
    let suite;
    try { suite = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return json(res, 404, { error: `No suite called ${name} in test-cases/` }); }
    if (active) return json(res, 409, { error: "A release is already running.", releaseId: active });
    const id = crypto.randomUUID();
    const rec = { id, suite: name, status: "running", startedAt: new Date().toISOString(), progress: [], result: null, error: null };
    releases.set(id, rec); active = id;
    const changed = Array.isArray(body.changed) ? body.changed.map(String).slice(0, 20) : [];
    Promise.resolve().then(() => runRelease(suite, {
      changed, ask: ask || undefined, heal: body.heal !== false,
      runOpts: { log: (line) => { rec.progress.push(String(line)); if (rec.progress.length > 500) rec.progress.shift(); } },
      auditSink: (e) => { rec.audit = rec.audit || []; rec.audit.push(e); },
    })).then((result) => {
      rec.result = result; rec.status = "done";
      if (dataDir) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, `release-${id}.json`), JSON.stringify(result, null, 2)); } catch { /* the response still has it */ } }
    }).catch((err) => { rec.status = "error"; rec.error = String(err && err.message || err); })
      .finally(() => { rec.finishedAt = new Date().toISOString(); if (active === id) active = null; });
    json(res, 202, { releaseId: id, status: "running" });
  }

  function get(req, res) {
    if (!authorised(req)) return json(res, 401, { error: "A valid Bearer token is required." });
    const m = /^\/api\/releases\/([0-9a-f-]{36})(\/audit)?$/i.exec(req.url.split("?")[0]);
    const rec = m && releases.get(m[1]);
    if (!rec) return json(res, 404, { error: "No such release (the server keeps releases only while it is running)." });
    if (m[2]) return json(res, 200, { releaseId: rec.id, audit: (rec.result && rec.result.audit) || rec.audit || [] });
    const { audit, ...pub } = rec; void audit;
    if (pub.result) { const { audit: a, ...r } = pub.result; void a; pub.result = r; }
    json(res, 200, pub);
  }

  return { start, get, _state: { releases } };
}

let shared;
const endpoint = () => (shared = shared || createReleaseEndpoint());
module.exports = { createReleaseEndpoint, handleStart: (q, s) => endpoint().start(q, s), handleGet: (q, s) => endpoint().get(q, s) };
