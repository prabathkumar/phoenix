const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { runPipelineRequest } = require("../pipeline-endpoint");
const env = { TESTOPS_PIPELINE_LOG: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pe-")), "r.jsonl"), TESTOPS_TESTDATA_DIR: os.tmpdir() };
const gp = (n) => ({ text: `P ${n}`, id: `${n}:shared:v:h` });
const callJson = async (p) => /Plan this run/.test(p) ? { platforms: ["api"], stages: [{ id: "performance", run: false, why: "no load goal" }] } : /REQUIREMENT/.test(p) ? { items: [{ t: 1 }] } : { note: "fine" };
const by = (j, id) => j.stages.find((s) => s.id === id);
const noExec = () => ({ status: 127 });

(async () => {
  let r = await runPipelineRequest({}, { env });
  assert.strictEqual(r.code, 400);

  // Whole flow with fakes: plan, scenarios, cases, API execution with one failing case, Jira defect gated.
  const fakeRun = async () => ({ main: { ok: true, name: "main" }, negatives: [{ ok: false, name: "empty email accepted", detail: "got 200" }] });
  const jira = { missing: [], config: { project: "TST", defectType: "Bug" }, call: async (m, p) => (p.includes("/search/jql") ? { issues: [] } : { key: "TST-9" }) };
  const body = { goal: "test login API", requirement: "POST /login", steps: [{ kind: "api", method: "POST", url: "/login", body: { email: "a@b.co" } }], baseUrl: "https://h", autonomy: "ask-when-matters" };
  r = await runPipelineRequest(body, { env, callJson, getPrompt: gp, runApiCases: fakeRun, jira, exec: noExec });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.plan.source, "ai");
  assert.strictEqual(by(r.json, "scenarios").status, "passed");
  assert.strictEqual(by(r.json, "execution").status, "failed");
  assert.strictEqual(by(r.json, "performance").status, "skipped");
  assert.strictEqual(by(r.json, "dast").status, "needs-you");   // live scan always asks
  assert.strictEqual(by(r.json, "defects").status, "needs-you"); // default level asks before Jira
  console.log(JSON.stringify(r.json.stages.map((s) => s.id + "=" + s.status)));
  assert.ok(!JSON.stringify(r.json).includes('"data"'));

  // run-everything: the Jira defect is logged for the failing case.
  r = await runPipelineRequest({ ...body, autonomy: "run-everything" }, { env, callJson, getPrompt: gp, runApiCases: fakeRun, jira, exec: noExec });
  assert.strictEqual(by(r.json, "defects").status, "passed");
  assert.ok(/1 logged/.test(by(r.json, "defects").detail));
  assert.deepStrictEqual(r.json.needsYou, ["dast"]);
  console.log("pipeline-endpoint tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
