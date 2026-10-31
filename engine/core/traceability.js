/**
 * Is what the requirements say what is being built?
 * Reads the repo where the sessions, test cases and scripts are stored (GitHub or GitLab) and compares it with the
 * requirement text:
 *   covered   a test or session does what the requirement says
 *   partial   something touches it but misses part
 *   missing   nothing in the repo tests it
 *   unrequired  tests that no requirement asks for (built, but not required)
 * The model judges; the code keeps it honest: evidence must be real files from the repo (invented paths are dropped, and a
 * "covered" with no real evidence becomes "missing"). With no model, a plain word-overlap match gives "possible" matches,
 * labelled as a guess. Only names, titles and the first lines of each file are shown to the model, with secrets redacted.
 */
const path = require("path");
const guard = require("../gateway/guardrails");

const DEFAULT_PATHS = [/(^|\/)test-cases\/.+\.json$/i, /(^|\/)generated\/.+\.(js|ts|py|json)$/i, /(^|\/)(tests?|__tests__|e2e|sessions?|recordings?)\/.+\.(js|ts|py|java|go|cs|json|feature)$/i, /\.(test|spec)\.(js|ts|py)$/i, /(^|\/)test_.+\.py$/i, /Tests?\.(java|cs)$/, /_test\.go$/, /\.feature$/i];
const IGNORE = /(^|\/)(node_modules|vendor|dist|build|target|\.git)\//;
const STOP = new Set("the a an and or of to in on for with is are be must should shall can will it its this that as at by from not no all any when then user users system able".split(" "));
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const redact = (s) => guard.run(guard.DEFAULT_RULES.filter((r) => r.type === "secrets" || r.type === "pii").map((r) => ({ ...r, applies: "both", action: "redact" })), "input", s).text;

/** Split a requirement document into one statement per line/sentence (the fallback when no model is available). */
function splitStatements(text) {
  return String(text || "").split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.replace(/^[\s#>*\-\d.)]+/, "").trim()).filter((s) => s.length >= 12 && /[A-Za-z]{3}/.test(s)).slice(0, 60).map((t, i) => ({ id: `R${i + 1}`, text: t.slice(0, 300) }));
}

/** A short, safe description of one repo file: its path, a title, and the first lines. */
function describeFile(file, content) {
  let title = "", body = String(content || "");
  if (/\.json$/i.test(file)) { try { const j = JSON.parse(body); title = j.name || j.title || j.testName || ""; const steps = j.steps || j.instructions || j.cases; body = (title ? title + "\n" : "") + (Array.isArray(steps) ? steps.slice(0, 25).map((s) => (typeof s === "string" ? s : s.instruction || s.text || s.name || JSON.stringify(s).slice(0, 80))).join("\n") : body); } catch { /* raw text */ } }
  else title = (/(?:describe|test|it|def test_\w*|@Test[\s\S]{0,40}?void|func Test\w*|Scenario:|Feature:)\s*\(?['"]?([^'"\n(]{3,80})/.exec(body) || [])[1] || "";
  return { path: file, title: redact(title).slice(0, 100), text: redact(body).slice(0, 700) };
}

async function collectArtifacts(repo, ref, { paths = DEFAULT_PATHS, max = 60, maxFile = 20000 } = {}) {
  const all = (await repo.listFiles(ref)).filter((f) => !IGNORE.test(f) && paths.some((re) => re.test(f))).slice(0, max);
  const out = [];
  for (const f of all) { try { const c = await repo.readFile(f, ref); out.push(describeFile(f, String(c).slice(0, maxFile))); } catch { /* unreadable file: left out */ } }
  return out;
}

/** Word-overlap guess: used when no model answers, and to pre-rank evidence. */
function lexicalMatch(requirements, artifacts) {
  const aw = artifacts.map((a) => new Set(words(a.path + " " + a.title + " " + a.text)));
  const coverage = requirements.map((r) => {
    const rw = [...new Set(words(r.text))]; if (!rw.length) return { id: r.id, text: r.text, status: "missing", evidence: [], note: "nothing to match" };
    const hits = artifacts.map((a, i) => ({ path: a.path, score: rw.filter((w) => aw[i].has(w)).length / rw.length })).filter((h) => h.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 3);
    return { id: r.id, text: r.text, status: hits.length ? "possible" : "missing", evidence: hits.map((h) => h.path), note: hits.length ? "word match only: a guess, not a judgement" : "no test mentions these words" };
  });
  const used = new Set(coverage.flatMap((c) => c.evidence));
  return { coverage, unrequired: artifacts.filter((a) => !used.has(a.path)).map((a) => ({ path: a.path, note: "no requirement shares its words" })) };
}

/**
 * @param {{requirements:[{id,text}], artifacts:[{path,title,text}], callJson?:Function}} o
 * @returns {Promise<{source:"ai"|"words", coverage, unrequired, summary}>}
 */
async function compare({ requirements, artifacts, callJson }) {
  let source = "words", result = null, why;
  if (callJson && requirements.length && artifacts.length) {
    const prompt = `You check whether what is built matches the requirements. For each requirement say if a test covers it.\n` +
      `REQUIREMENTS:\n${requirements.map((r) => `${r.id}: ${r.text}`).join("\n")}\n\nTESTS AND SESSIONS IN THE REPO:\n${artifacts.map((a) => `[${a.path}] ${a.title}\n${a.text.slice(0, 450)}`).join("\n---\n")}\n\n` +
      `Reply JSON {"coverage":[{"id":"R1","status":"covered|partial|missing","evidence":["path"],"note":"short reason"}],"unrequired":[{"path":"path","note":"why no requirement asks for it"}]}. Use only the paths shown. Say "covered" only if a listed test really checks it.`;
    try { const r = await callJson(prompt); if (r && Array.isArray(r.coverage)) { result = r; source = "ai"; } else why = "the model's answer could not be read"; }
    catch (e) { why = e.message; }
  }
  let coverage, unrequired;
  if (result) {
    const known = new Set(artifacts.map((a) => a.path)); const byId = new Map(result.coverage.map((c) => [c.id, c]));
    coverage = requirements.map((r) => {
      const c = byId.get(r.id) || {}; const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter((p) => known.has(p));
      let status = ["covered", "partial", "missing"].includes(c.status) ? c.status : "missing";
      let note = String(c.note || "").slice(0, 240);
      if (status !== "missing" && !evidence.length) { status = "missing"; note = `the model named no real file as evidence${note ? " (" + note + ")" : ""}`; }
      return { id: r.id, text: r.text, status, evidence, note };
    });
    unrequired = (Array.isArray(result.unrequired) ? result.unrequired : []).filter((u) => known.has(u && u.path)).map((u) => ({ path: u.path, note: String(u.note || "").slice(0, 200) }));
  } else ({ coverage, unrequired } = lexicalMatch(requirements, artifacts));
  const count = (s) => coverage.filter((c) => c.status === s).length;
  return { source, ...(why ? { fellBackBecause: why } : {}), coverage, unrequired,
    summary: { requirements: requirements.length, covered: count("covered"), partial: count("partial"), missing: count("missing"), possible: count("possible"), unrequired: unrequired.length, tests: artifacts.length } };
}

/** Whole check: statements from the requirement text, the repo's artifacts, the comparison. */
async function check({ requirement, repo, ref, callJson, statements }) {
  let reqs = statements && statements.length ? statements : null;
  if (!reqs && callJson) {
    try { const r = await callJson(`List every separate thing this requirement says the product must do, one short statement each (max 40).\nREQUIREMENT:\n${String(requirement).slice(0, 8000)}\nReply JSON {"statements":["..."]}.`); if (r && Array.isArray(r.statements)) reqs = r.statements.slice(0, 40).map((t, i) => ({ id: `R${i + 1}`, text: String(t).slice(0, 300) })).filter((s) => s.text.trim()); } catch { /* split by sentence instead */ }
  }
  reqs = reqs && reqs.length ? reqs : splitStatements(requirement);
  const base = ref || (await repo.defaultBranch());
  const artifacts = await collectArtifacts(repo, base);
  return { ref: base, ...(await compare({ requirements: reqs, artifacts, callJson })) };
}
module.exports = { check, compare, collectArtifacts, describeFile, splitStatements, lexicalMatch, DEFAULT_PATHS };
