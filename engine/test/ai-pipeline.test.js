const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { planRun, runAiPipeline, history } = require("../core/ai-pipeline");
const env = { TESTOPS_PIPELINE_LOG: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pl-")), "runs.jsonl") };
const ok = async () => ({ ok: true, detail: "done" });
const by = (r, id) => r.stages.find((s) => s.id === id);

(async () => {
  // No model: everything runs in order and the plan says it is a fallback.
  let p = await planRun({ goal: "g" });
  assert.strictEqual(p.source, "fallback");
  // Bad model answer or invented stage: dropped, never trusted.
  p = await planRun({ goal: "g", callJson: async () => ({ platforms: ["web", "toaster"], stages: [{ id: "scenarios", run: true }, { id: "bitcoin", run: true }, { id: "performance", run: false, why: "no load needed" }] }) });
  assert.strictEqual(p.source, "ai");
  assert.deepStrictEqual(p.platforms, ["web"]);
  assert.strictEqual(p.stages.find((s) => s.id === "bitcoin"), undefined);
  assert.strictEqual(p.stages.find((s) => s.id === "performance").run, false);
  assert.strictEqual(p.stages.find((s) => s.id === "dast").why, "not mentioned by the AI; default");
  p = await planRun({ goal: "g", callJson: async () => { throw new Error("down"); } });
  assert.strictEqual(p.source, "fallback");

  // The model skips performance; it can also try to skip nothing about gates: the live scan still asks.
  const prompts = [];
  const callJson = async (prompt) => {
    prompts.push(prompt);
    return /Plan this run/.test(prompt) ? { platforms: ["web"], stages: [{ id: "performance", run: false, why: "requirement has no load goal" }, { id: "dast", run: true, why: "check the page" }] } : { note: "ok" };
  };
  const hs = { scenarios: ok, cases: ok, execution: ok, dast: ok, performance: ok };
  let r = await runAiPipeline({ goal: "test TOP-188", requirement: "login page", handlers: hs, callJson, autonomy: "run-everything", env, exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "performance").status, "skipped");
  assert.strictEqual(by(r, "performance").decided, "requirement has no load goal");
  assert.strictEqual(by(r, "dast").status, "needs-you");
  assert.strictEqual(by(r, "scenarios").ai, "ok");

  // The run is logged without data, and the next plan sees it.
  const log = fs.readFileSync(env.TESTOPS_PIPELINE_LOG, "utf8");
  assert.ok(log.includes("test TOP-188") && !log.includes("login page"));
  assert.ok(history({ env })[0].includes("dast=needs-you"));
  await runAiPipeline({ goal: "again", handlers: hs, callJson, env, exec: () => ({ status: 127 }) });
  assert.ok(prompts[prompts.length - 1] !== undefined && prompts.some((x) => x.includes("Recent runs") && x.includes("dast=needs-you")));
  console.log("ai-pipeline tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
