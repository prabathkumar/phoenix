/**
 * agents/release.js -- the release-run agents. One call runs a whole release:
 *   Planner  -> picks the cases for this release (all, or only those matching changed areas / tags)
 *   Runner   -> executes them (suite-run's runSuite, one fresh browser context per case)
 *   Triage   -> says WHY each non-pass happened: site-blocked, network, or a real failure (rules first, model last)
 *   Healer   -> re-runs real failures once on a fresh page; a pass on retry is recorded as "flaky", not hidden
 *   Reporter -> one verdict for the release, plus the full audit trail
 * Every agent writes to the audit trail (who did what, to which case, why), so nothing is silent.
 * Model use is optional and last: `ask(prompt)` is only used by Triage for failures the rules cannot explain.
 */
const { runSuite } = require("../suite-run");

function createAudit(sink = () => {}) {
  const trail = [];
  const note = (agent, action, detail = {}) => { const e = { at: new Date().toISOString(), agent, action, ...detail }; trail.push(e); try { sink(e); } catch { /* sink is a bonus */ } };
  return { trail, note };
}

/** Planner: choose cases. `changed` = words from the release notes (e.g. ["checkout", "postpaid"]); matches case id, title or tags. */
function plan(suite, { changed = [], only } = {}, audit) {
  let cases = suite.cases || [];
  if (only && only.length) cases = cases.filter((c) => only.includes(c.id));
  else if (changed.length) {
    const hit = cases.filter((c) => changed.some((w) => `${c.id} ${c.title || ""} ${(c.tags || []).join(" ")}`.toLowerCase().includes(String(w).toLowerCase())));
    if (hit.length) cases = hit;
    else audit.note("planner", "no-match-run-all", { changed });
  }
  audit.note("planner", "planned", { cases: cases.map((c) => c.id), skipped: (suite.skipped || []).length });
  return { ...suite, cases };
}

/** Triage: a reason for every case that did not pass. Rules decide; the model is asked only when they cannot. */
async function triage(results, { ask } = {}, audit) {
  for (const r of results) {
    if (r.verdict === "passed") continue;
    let why = "";
    if (r.verdict === "blocked-by-site") why = "the live site refused the journey (stock/maintenance message), not a test fault";
    else if (r.verdict === "not-run-network") why = "the machine lost its connection; says nothing about the site or the test";
    else if (/the site stopped the journey/i.test(r.reason)) why = "the live site itself said this product cannot be bought right now (sold out, reserved or waitlist)";
    else if (/disabled: something it needs/i.test(r.reason)) why = "an earlier choice was not made, so the next button stayed off (test steps incomplete or the site changed its order)";
    else if (/not found|no match|could not find/i.test(r.reason)) why = "the control named in the step is not on the page (site changed or the step is wrong)";
    else if (/timed out/i.test(r.reason)) why = "the case ran out of time";
    else if (ask) {
      try { why = String(await ask(`A website test step failed.\nStep: ${r.failedStep}\nReason: ${r.reason}\nIn one sentence, say the most likely cause and whether the test or the site is at fault.`)).trim().slice(0, 300); } catch { /* model is optional */ }
    }
    r.triage = why || "unexplained: needs a person to look";
    audit.note("triage", r.verdict, { case: r.id, why: r.triage });
  }
}

/** Healer: re-run real failures once. Passing on retry = flaky (kept visible); failing again = confirmed. */
async function heal(summary, suite, runOpts, audit) {
  const failedIds = summary.results.filter((r) => r.verdict === "failed").map((r) => r.id);
  if (!failedIds.length) return;
  audit.note("healer", "retrying", { cases: failedIds });
  const again = await runSuite(suite, { ...runOpts, only: failedIds });
  for (const a of again.results) {
    const i = summary.results.findIndex((r) => r.id === a.id);
    const first = summary.results[i];
    if (a.verdict === "passed") { summary.results[i] = { ...a, flaky: true, firstAttempt: { reason: first.reason, failedStep: first.failedStep } }; audit.note("healer", "flaky-passed-on-retry", { case: a.id, firstReason: first.reason }); }
    else { summary.results[i] = { ...a, firstAttempt: { reason: first.reason, failedStep: first.failedStep }, retried: true }; audit.note("healer", "still-failed", { case: a.id, reason: a.reason }); }
  }
}

/** Reporter: the one-line release verdict. */
function report(summary, audit) {
  const c = (v) => summary.results.filter((r) => r.verdict === v).length;
  const flaky = summary.results.filter((r) => r.flaky).length;
  const out = { ...summary, passed: c("passed"), blockedBySite: c("blocked-by-site"), notRunNetwork: c("not-run-network"), failed: c("failed"), flaky };
  out.verdict = out.failed ? "FAIL" : (out.blockedBySite || out.notRunNetwork || flaky) ? "PASS-WITH-GAPS" : "PASS";
  out.gaps = summary.results.filter((r) => r.verdict !== "passed" || r.flaky).map((r) => ({ id: r.id, verdict: r.flaky ? "flaky" : r.verdict, why: r.triage || (r.flaky ? "failed once, passed on retry" : "") }));
  audit.note("reporter", "verdict", { verdict: out.verdict, passed: out.passed, total: out.total });
  return out;
}

async function runRelease(suite, { changed, only, ask, heal: doHeal = true, runOpts = {}, auditSink } = {}) {
  const audit = createAudit(auditSink);
  const planned = plan(suite, { changed, only }, audit);
  audit.note("runner", "start", { total: planned.cases.length });
  const summary = await runSuite(planned, runOpts);
  await triage(summary.results, { ask }, audit);
  if (doHeal) await heal(summary, planned, runOpts, audit);
  await triage(summary.results.filter((r) => r.verdict !== "passed" && !r.triage), { ask }, audit);
  const final = report(summary, audit);
  return { ...final, audit: audit.trail };
}

module.exports = { runRelease, plan, triage, heal, report, createAudit };
