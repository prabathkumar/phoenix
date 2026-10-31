const assert = require("assert");
const { STAGES, runPipeline } = require("../core/pipeline");

(async () => {
  // Nothing wired: every stage says so, none claims to have passed.
  let r = await runPipeline({ exec: () => ({ status: 127 }) });
  const by = (x, id) => x.stages.find((s) => s.id === id);
  assert.strictEqual(r.stages.length, STAGES.length);
  assert.strictEqual(by(r, "performance").status, "not-built");
  assert.strictEqual(by(r, "secrets").status, "unavailable");
  assert.strictEqual(by(r, "testdata").status, "passed"); // no steps: nothing needed
  assert.strictEqual(r.summary.failed, 0);

  // A must-exist value missing stops execution and HAR, but defects/feedback still run.
  r = await runPipeline({ ctx: { steps: ["type ${LOGIN_TOKEN}"] }, handlers: { execution: async () => ({ ok: true }), defects: async () => ({ ok: true, detail: "none" }) }, autonomy: "run-everything", exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "testdata").status, "failed");
  assert.strictEqual(by(r, "execution").status, "skipped");
  assert.strictEqual(by(r, "har").status, "skipped");
  assert.strictEqual(by(r, "defects").status, "passed");
  assert.strictEqual(r.ok, false);

  // Scanner present: findings fail the stage; clean passes.
  r = await runPipeline({ only: ["secrets", "sast"], exec: (cmd, args) => (args[0] === "--version" ? { status: 0 } : { status: cmd === "gitleaks" ? 1 : 0, stdout: "x" }) });
  assert.strictEqual(by(r, "secrets").status, "failed");
  assert.strictEqual(by(r, "sast").status, "passed");

  // A throwing handler is a failed stage, not a crash.
  r = await runPipeline({ only: ["performance"], handlers: { performance: async () => { throw new Error("locust down"); } } });
  assert.strictEqual(by(r, "performance").detail, "locust down");
  // AI pass: sees status and detail only, never data; a throwing model does not fail the run.
  const seen = [];
  r = await runPipeline({ ctx: { steps: [] }, handlers: { execution: async () => ({ ok: false, detail: "timeout", data: { secret: "S3CR3T" } }) }, only: ["execution"], ai: async (x) => { seen.push(JSON.stringify(x)); return { note: "retry on a fresh session" }; } });
  assert.strictEqual(by(r, "execution").ai, "retry on a fresh session");
  assert.ok(!seen.join("").includes("S3CR3T"));
  r = await runPipeline({ only: ["performance"], handlers: { performance: async () => ({ ok: true }) }, ai: async () => { throw new Error("model down"); } });
  assert.strictEqual(by(r, "performance").status, "passed");
  assert.ok(/AI review unavailable/.test(by(r, "performance").ai));
  // Autonomy and always-ask gates.
  const ok = async () => ({ ok: true, detail: "done" });
  const hs = { execution: ok, dast: ok, defects: ok, performance: ok };
  r = await runPipeline({ handlers: hs, exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "dast").status, "needs-you");            // live scan always asks
  assert.strictEqual(by(r, "defects").status, "needs-you");         // default level asks before Jira
  assert.strictEqual(by(r, "performance").status, "passed");
  assert.deepStrictEqual(r.needsYou.sort(), ["dast", "defects"]);
  r = await runPipeline({ handlers: hs, autonomy: "run-everything", exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "dast").status, "needs-you");            // still asks
  assert.strictEqual(by(r, "defects").status, "passed");
  r = await runPipeline({ handlers: hs, autonomy: "run-everything", approvals: { dast: true }, exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "dast").status, "passed");
  r = await runPipeline({ handlers: hs, autonomy: "run-everything", approvals: { execution: true, dast: true }, production: true, exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "execution").status, "needs-you");       // production asks even when approved
  r = await runPipeline({ handlers: hs, autonomy: "ask-everything", exec: () => ({ status: 127 }) });
  assert.strictEqual(by(r, "performance").status, "needs-you");
  console.log("pipeline tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
