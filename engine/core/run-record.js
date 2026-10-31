/**
 * One record per pipeline run, linking the blocks that used to stand alone:
 *   requirement (Jira key) -> scenarios -> cases -> test-data field names -> execution (where it ran)
 *   -> HAR -> performance -> scans -> defects (Jira keys) -> model calls (gateway log, by run id).
 * Stored at logs/runs/<id>.json (TESTOPS_RUNS_DIR to move). Holds statuses, counts, names and keys only:
 * no test-data values, no requirement text, no model prompts or answers.
 * The next run for the same requirement reads this one: what failed, which defects are open.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dirOf = (env = process.env) => env.TESTOPS_RUNS_DIR || path.join(__dirname, "..", "..", "logs", "runs");
const newId = () => `run-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
const okId = (id) => /^run-\d{14}-[0-9a-f]{6}$/.test(String(id));

/** Pull the cross-block links out of the stage results. */
function link(stages, { jiraKey, goal, plan, runId, retest = [] }) {
  const by = (id) => stages.find((s) => s.id === id) || {};
  const d = (id) => (by(id).data) || {};
  const defects = (d("defects").defects || []).map((x) => x.key).filter(Boolean);
  return {
    id: runId, at: new Date().toISOString(), goal: String(goal || "").slice(0, 200),
    requirement: jiraKey || null,
    plan: plan ? { source: plan.source, platforms: plan.platforms } : null,
    counts: { scenarios: (d("scenarios").items || []).length, cases: (d("cases").items || []).length, dataFields: d("testdata").names ? d("testdata").names.length : undefined },
    dataFields: d("testdata").names || [],
    execution: { status: by("execution").status, detail: by("execution").detail, failedCases: d("execution").failedCases || [] },
    har: { status: by("har").status, detail: by("har").detail },
    performance: { status: by("performance").status, detail: by("performance").detail },
    security: { secrets: by("secrets").status, sast: by("sast").status, dast: by("dast").status },
    defects: { keys: defects, fixed: ((d("defects").fixed) || []).map((x) => x.key), retested: retest },
    stages: stages.map(({ id, status, detail, decided, ai }) => ({ id, status, detail: String(detail || "").slice(0, 200), ...(decided ? { decided } : {}), ...(ai ? { ai } : {}) })),
  };
}
function save(rec, { env = process.env } = {}) {
  const d = dirOf(env); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${rec.id}.json`), JSON.stringify(rec, null, 2)); return rec;
}
function get(id, { env = process.env } = {}) { if (!okId(id)) throw new Error("Not a run id."); try { return JSON.parse(fs.readFileSync(path.join(dirOf(env), `${id}.json`), "utf8")); } catch { return null; } }
function list({ n = 50, env = process.env } = {}) {
  try { return fs.readdirSync(dirOf(env)).filter((f) => f.endsWith(".json")).sort().slice(-n).reverse().map((f) => JSON.parse(fs.readFileSync(path.join(dirOf(env), f), "utf8")))
    .map((r) => ({ id: r.id, at: r.at, goal: r.goal, requirement: r.requirement, execution: r.execution.status, defects: r.defects.keys.length })); } catch { return []; }
}
/** Earlier runs for the same requirement, newest first. */
function priorFor(jiraKey, { n = 5, env = process.env } = {}) {
  if (!jiraKey) return [];
  try { return fs.readdirSync(dirOf(env)).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => JSON.parse(fs.readFileSync(path.join(dirOf(env), f), "utf8"))).filter((r) => r.requirement === jiraKey).slice(0, n); } catch { return []; }
}
/** Short lines for the planner: what the last runs of this requirement found. */
function briefFor(jiraKey, opts) {
  return priorFor(jiraKey, opts).map((r) => `${r.at.slice(0, 10)}: execution ${r.execution.status}${r.execution.failedCases.length ? " (failed: " + r.execution.failedCases.map((c) => c.name).join(", ") + ")" : ""}; defects ${r.defects.keys.join(",") || "none"}${r.defects.fixed.length ? "; fixed in Jira: " + r.defects.fixed.join(",") : ""}`);
}
module.exports = { dirOf, newId, link, save, get, list, priorFor, briefFor, okId };
