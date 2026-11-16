const assert = require("assert");
const { createLogger } = require("../agents/logger");
let n = 0; const t = async (name, fn) => { await fn(); console.log("  ok - " + name); n += 1; };
(async () => {
  await t("no API url: nothing is queued or sent", async () => { const l = createLogger({}); l.log("agent_event", { agent: "x" }); assert.strictEqual(l.size(), 0); });
  await t("events are batched into one POST with the token, and the project id is added", async () => {
    const calls = []; const l = createLogger({ PHOENIX_API_URL: "http://api", PHOENIX_INGEST_TOKEN: "tok", PHOENIX_PROJECT_ID: "p1" }, { fetchImpl: async (u, o) => { calls.push({ u, o }); return { ok: true }; }, every: 5000 });
    for (let i = 0; i < 3; i += 1) l.log("agent_event", { agent: "runner", event: "e" });
    assert.strictEqual(calls.length, 0); await l.flush();
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].u, "http://api/api/ingest"); assert.strictEqual(calls[0].o.headers["x-ingest-token"], "tok");
    const body = JSON.parse(calls[0].o.body); assert.strictEqual(body.events.length, 3); assert.strictEqual(body.events[0].row.project, "p1"); assert.strictEqual(l.stats.sent, 3);
  });
  await t("a down API keeps the events and retries; the queue is capped", async () => {
    let up = false; const calls = []; const l = createLogger({ PHOENIX_API_URL: "http://api" }, { fetchImpl: async () => { calls.push(1); if (!up) throw new Error("down"); return { ok: true }; }, every: 5000, max: 5, batch: 1000 });
    for (let i = 0; i < 8; i += 1) l.log("agent_event", { agent: "a" });
    await l.flush(); assert.strictEqual(l.size(), 5); assert.strictEqual(l.stats.dropped, 3);
    up = true; await l.flush(); assert.strictEqual(l.size(), 0); assert.strictEqual(l.stats.sent, 5);
  });
  await t("wrapAsk logs timing, and the prompt/answer only when capture is on; failures are logged and rethrown", async () => {
    const calls = []; const mk = (cap) => createLogger({ PHOENIX_API_URL: "http://api" }, { fetchImpl: async (u, o) => { calls.push(...JSON.parse(o.body).events); return { ok: true }; }, every: 5000 });
    const l1 = mk(); await l1.wrapAsk(async () => "ans", { agent: "triage", capture: false })("q"); await l1.flush();
    assert.deepStrictEqual(calls.map((c) => c.kind), ["agent_event"]); calls.length = 0;
    const l2 = mk(); await l2.wrapAsk(async () => "ans", { agent: "triage", capture: true })("q"); await l2.flush();
    assert.deepStrictEqual(calls.map((c) => c.kind), ["agent_event", "training_example"]); calls.length = 0;
    const l3 = mk(); await assert.rejects(l3.wrapAsk(async () => { throw new Error("boom"); }, { agent: "triage" })("q"), /boom/); await l3.flush();
    assert.strictEqual(calls[0].row.status, "failed");
  });
  console.log(`logger tests passed (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
