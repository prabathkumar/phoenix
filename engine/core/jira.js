/**
 * Jira, both ways (Jira Cloud REST v3).
 *   In:  read a requirement and its linked change requests -> text for scenario writing;
 *        read defect status back -> which defects were fixed and are ready to re-test.
 *   Out: draft a defect from a failed result, skip duplicates (comment instead), create it,
 *        comment run results, and move an issue when asked.
 * Settings: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (+ JIRA_PROJECT_KEY, JIRA_DEFECT_TYPE=Bug).
 * The token is used only in the Authorization header: never logged, never in a message or draft.
 * Real Jira has not been called from here (no network); tested against a fake fetch.
 */
const configFrom = (env = process.env) => ({
  baseUrl: String(env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
  email: env.JIRA_EMAIL || "", token: env.JIRA_API_TOKEN || "",
  project: env.JIRA_PROJECT_KEY || "", defectType: env.JIRA_DEFECT_TYPE || "Bug",
});
const missing = (c) => ["baseUrl", "email", "token"].filter((k) => !c[k]).map((k) => ({ baseUrl: "JIRA_BASE_URL", email: "JIRA_EMAIL", token: "JIRA_API_TOKEN" }[k]));

function client({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  const c = configFrom(env);
  const gone = missing(c);
  const auth = "Basic " + Buffer.from(`${c.email}:${c.token}`).toString("base64");
  async function call(method, path, body) {
    if (gone.length) throw new Error(`Jira is not connected: set ${gone.join(", ")}.`);
    const res = await fetchFn(c.baseUrl + path, { method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`Jira ${method} ${path.split("?")[0]} failed (${res.status}).`); // no body: it may echo input
    return text ? JSON.parse(text) : {};
  }
  return { config: { ...c, token: undefined }, missing: gone, call };
}

// ---- Atlassian document format <-> plain text
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  const inner = (node.content || []).map(adfToText);
  return ["paragraph", "heading", "listItem", "codeBlock"].includes(node.type) ? inner.join("") + "\n" : inner.join("");
}
const adf = (text) => ({ type: "doc", version: 1, content: String(text).split(/\n{1,}/).filter(Boolean).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });

// ---- In: requirements and defect status
async function readIssue(j, key) {
  const i = await j.call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,issuelinks,labels`);
  const f = i.fields || {};
  return { key: i.key, summary: f.summary || "", description: adfToText(f.description).trim(), status: (f.status || {}).name || "", type: (f.issuetype || {}).name || "", labels: f.labels || [],
    linked: (f.issuelinks || []).map((l) => (l.outwardIssue || l.inwardIssue || {}).key).filter(Boolean) };
}
/** The requirement and its linked change requests as one text block for scenario writing. */
async function readRequirement(j, key) {
  const main = await readIssue(j, key);
  const links = [];
  for (const k of main.linked.slice(0, 10)) { try { links.push(await readIssue(j, k)); } catch { /* an unreadable link is left out, not fatal */ } }
  const text = [`${main.key}: ${main.summary}`, main.description, ...links.map((l) => `Change request ${l.key} (${l.type}): ${l.summary}\n${l.description}`)].filter(Boolean).join("\n\n");
  return { key: main.key, text, linked: links.map((l) => l.key) };
}
const DONE = /^(done|resolved|closed|fixed|verified)$/i;
/** Defects we logged that Jira now shows as fixed: ready to re-test. */
async function defectsToRetest(j, keys) {
  const out = [];
  for (const k of keys) { try { const i = await readIssue(j, k); if (DONE.test(i.status)) out.push({ key: k, status: i.status }); } catch { /* skip */ } }
  return out;
}

// ---- Out: defects
const redact = (s, secrets = []) => secrets.filter((v) => v && String(v).length >= 4).reduce((t, v) => t.split(String(v)).join("***"), String(s || ""));
/** @param {{name,id?,step?,error?,ranOn?,steps?}} failed  one failed case/step result */
function draftDefect(failed, { requirement, secrets = [], project } = {}) {
  const where = failed.ranOn && failed.ranOn.label ? failed.ranOn.label : "";
  const lines = [failed.step ? `Failed at: ${failed.step}` : "", failed.error ? `Error: ${failed.error}` : "", where ? `Ran on: ${where}` : "", requirement ? `Requirement: ${requirement}` : "",
    ...(failed.steps || []).map((s, n) => `${n + 1}. ${s}`)].filter(Boolean);
  const marker = `testops-case-${String(failed.id || failed.name || "case").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return { summary: redact(`${failed.id ? failed.id + ": " : ""}${failed.name || "Test case failed"}`, secrets).slice(0, 240),
    description: redact(lines.join("\n"), secrets), labels: ["testops", marker], marker, project };
}
async function findDuplicate(j, draft, project) {
  const jql = `labels = "${draft.marker}" AND statusCategory != Done${project ? ` AND project = "${project}"` : ""} ORDER BY created DESC`;
  const r = await j.call("GET", `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=1`);
  return (r.issues || [])[0] || null;
}
async function comment(j, key, text) { return j.call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: adf(text) }); }
/** Creates the defect, or comments on the open one for the same case. Returns {created|commented, key}. */
async function logDefect(j, draft, { project } = {}) {
  const p = project || draft.project || j.config.project;
  if (!p) throw new Error("Set JIRA_PROJECT_KEY (or pass project) to log defects.");
  const dup = await findDuplicate(j, draft, p);
  if (dup) { await comment(j, dup.key, `Failed again.\n${draft.description}`); return { commented: true, key: dup.key }; }
  const r = await j.call("POST", "/rest/api/3/issue", { fields: { project: { key: p }, summary: draft.summary, description: adf(draft.description), issuetype: { name: j.config.defectType }, labels: draft.labels } });
  return { created: true, key: r.key };
}
async function transition(j, key, name) {
  const t = await j.call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const hit = (t.transitions || []).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`Jira has no "${name}" move for ${key}.`);
  await j.call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: hit.id } });
}

/** Pipeline handler: drafts a defect for every failed case; logs them only when approved (the pipeline gates this). */
function defectsHandler(j, { requirement, secrets } = {}) {
  return async (ctx) => {
    const failed = (ctx.failedCases || []);
    if (!failed.length) return { ok: true, detail: "no failed cases" };
    if (j.missing.length) return { unavailable: true, detail: `Jira not connected: set ${j.missing.join(", ")}` };
    const made = [];
    for (const f of failed) made.push(await logDefect(j, draftDefect(f, { requirement, secrets })));
    return { ok: true, detail: `${made.filter((m) => m.created).length} logged, ${made.filter((m) => m.commented).length} already open`, data: { defects: made } };
  };
}

module.exports = { client, configFrom, adfToText, adf, readIssue, readRequirement, defectsToRetest, draftDefect, findDuplicate, logDefect, comment, transition, defectsHandler, redact };
